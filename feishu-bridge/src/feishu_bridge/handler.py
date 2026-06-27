from __future__ import annotations

import json
import logging
import re
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path

import lark_oapi as lark

from .config import BridgeConfig
from .dedupe import DebounceGate, DedupeCache
from .feishu_api import FeishuMessenger
from .interactions import FeishuTarget, InteractionHub
from .magi_client import MagiEndpoint, dispatch_prompt, format_cluster_status
from .output import OutboundMessage, build_question_card, format_result_message, split_for_feishu
from .prompts import is_new_chat_command, wrap_prompt_for_feishu
from .security import find_dangerous_reason, is_sender_allowed, is_status_query
from .sessions import ChatSessionStore

logger = logging.getLogger(__name__)

_AT_MENTION_RE = re.compile(r"@_user_\d+\s*")


@dataclass
class IncomingMessage:
    message_id: str
    chat_id: str
    sender_open_id: str
    text: str
    receive_id: str
    receive_id_type: str


def normalize_user_text(text: str) -> str:
    cleaned = _AT_MENTION_RE.sub("", text).strip()
    return cleaned


def parse_incoming(event: lark.im.v1.P2ImMessageReceiveV1) -> IncomingMessage | None:
    msg = event.event.message if event.event else None
    sender = event.event.sender if event.event else None
    if not msg or not sender:
        return None

    sender_type = str(sender.sender_type or "")
    if sender_type and sender_type != "user":
        return None

    msg_type = str(msg.message_type or "")
    if msg_type != "text":
        return None

    try:
        payload = json.loads(msg.content or "{}")
    except json.JSONDecodeError:
        return None
    text = normalize_user_text(str(payload.get("text", "")))
    if not text:
        return None

    chat_id = str(msg.chat_id or "")
    sender_open_id = str(sender.sender_id.open_id if sender.sender_id else "")
    receive_id_type = "chat_id" if chat_id else "open_id"
    receive_id = chat_id or sender_open_id
    if not receive_id:
        return None

    return IncomingMessage(
        message_id=str(msg.message_id or ""),
        chat_id=chat_id,
        sender_open_id=sender_open_id,
        text=text,
        receive_id=receive_id,
        receive_id_type=receive_id_type,
    )


class MessageHandler:
    """Handle Feishu IM events. Work is offloaded — WS callback must finish within ~3s."""

    def __init__(self, config: BridgeConfig) -> None:
        self.config = config
        self.messenger = FeishuMessenger(config.app_id, config.app_secret)
        self.router = MagiEndpoint(
            base_url=config.router_base_url,
            device_id=config.router_device_id,
            token=config.router_token,
        )
        self._executor = ThreadPoolExecutor(max_workers=4, thread_name_prefix="feishu-bridge")
        self._dedupe = DedupeCache()
        self._status_debounce = DebounceGate(cooldown_seconds=10.0)
        self._interaction_hub = InteractionHub(
            default_timeout_seconds=float(config.interaction_timeout_seconds)
        )
        self._active_targets: set[str] = set()
        session_path = Path(__file__).resolve().parents[2] / ".chat-sessions.json"
        self._sessions = ChatSessionStore(
            session_path,
            ttl_seconds=float(config.session_ttl_seconds),
        )

    def _send_question_prompt(
        self,
        target: FeishuTarget,
        questions: list[dict],
        job_id: str,
        tool_use_id: str,
    ) -> None:
        card = build_question_card(questions, title="Magi 需要你选择")
        self.messenger.reply(
            message_id=target.message_id,
            receive_id=target.receive_id,
            receive_id_type=target.receive_id_type,
            message=OutboundMessage("interactive", card),
        )
        logger.info(
            "Sent AskUserQuestion to Feishu receive_id=%s job=%s tool=%s",
            target.receive_id,
            job_id,
            tool_use_id,
        )

    def handle(self, event: lark.im.v1.P2ImMessageReceiveV1) -> None:
        incoming = parse_incoming(event)
        if not incoming:
            return

        if not self._dedupe.consume(incoming.message_id):
            logger.info("Skip duplicate message_id=%s", incoming.message_id)
            return

        if not is_sender_allowed(
            sender_open_id=incoming.sender_open_id or None,
            chat_id=incoming.chat_id or None,
            allowed_user_ids=self.config.allowed_user_ids,
            allowed_chat_ids=self.config.allowed_chat_ids,
            dev_allow_all=self.config.dev_allow_all,
        ):
            logger.warning(
                "Rejected sender open_id=%s chat_id=%s (not in whitelist)",
                incoming.sender_open_id,
                incoming.chat_id,
            )
            self._executor.submit(
                self._reply_text,
                incoming,
                "未授权：请把你的飞书 open_id 加入 config.local.toml 的 security.allowed_user_ids。",
            )
            return

        self._executor.submit(self._process, incoming)

    def _reply_text(self, incoming: IncomingMessage, text: str) -> None:
        try:
            self.messenger.send_text(
                message_id=incoming.message_id,
                receive_id=incoming.receive_id,
                receive_id_type=incoming.receive_id_type,
                text=text,
            )
        except Exception:
            logger.exception("Failed to send Feishu text reply")

    def _process(self, incoming: IncomingMessage) -> None:
        try:
            if self._interaction_hub.has_pending(incoming.receive_id):
                handled, err = self._interaction_hub.handle_reply(incoming.receive_id, incoming.text)
                if handled:
                    if err:
                        self._reply_text(incoming, err)
                    else:
                        self._reply_text(incoming, "已收到选择，继续执行…")
                return

            if incoming.receive_id in self._active_targets:
                self._reply_text(incoming, "当前还有任务在处理中，请稍候。")
                return

            status_query = is_status_query(incoming.text)
            title = "Magi 集群状态" if status_query else "Magi"
            if status_query:
                debounce_key = incoming.chat_id or incoming.sender_open_id or incoming.receive_id
                if not self._status_debounce.allow(debounce_key):
                    logger.info("Skip debounced status query chat=%s", debounce_key)
                    return
            elif not status_query:
                self._reply_text(incoming, "收到，正在处理…")

            self._active_targets.add(incoming.receive_id)
            try:
                result_text = self._execute(incoming)
            finally:
                self._active_targets.discard(incoming.receive_id)
                self._interaction_hub.cancel(incoming.receive_id)

            if result_text is None:
                return

            parts = split_for_feishu(result_text)
            for index, part in enumerate(parts):
                part_title = title if index == 0 else f"{title} ({index + 1}/{len(parts)})"
                outbound = format_result_message(part, title=part_title)
                self.messenger.reply(
                    message_id=incoming.message_id if index == 0 else "",
                    receive_id=incoming.receive_id,
                    receive_id_type=incoming.receive_id_type,
                    message=outbound,
                )
        except Exception as err:
            logger.exception("Task failed")
            self._reply_text(incoming, f"执行失败: {err}")

    def _execute(self, incoming: IncomingMessage) -> str | None:
        text = incoming.text
        if is_new_chat_command(text):
            if self.config.persist_sessions:
                self._sessions.clear(incoming.receive_id)
            return "已开始新对话。之前的上下文已清空，请继续提问。"

        if is_status_query(text):
            peers = [(p.name, p.url) for p in self.config.manual_peers]
            return format_cluster_status(self.router, peers)

        danger = find_dangerous_reason(text)
        if danger:
            return (
                f"已拦截高风险指令（{danger}）。\n\n"
                "自动路由下「派给谁」可自动，但危险操作需要二次确认。"
                "请在 Mac mini 本地确认后再执行，或去掉危险关键词后重试。"
            )

        if not self.config.router_token or not self.config.router_device_id:
            return (
                "Router Magi 尚未配对。\n\n"
                "在 Mac mini 上运行:\n"
                "  magi serve\n"
                "  magi pair feishu-bridge\n\n"
                "然后把 device_id / token 写入 feishu-bridge/config.local.toml 的 [router] 段。"
            )

        target = FeishuTarget(
            receive_id=incoming.receive_id,
            receive_id_type=incoming.receive_id_type,
            message_id=incoming.message_id,
        )
        session_id = self._sessions.get(incoming.receive_id) if self.config.persist_sessions else ""
        prompt = wrap_prompt_for_feishu(text, response_language=self.config.response_language)
        result = dispatch_prompt(
            self.router,
            prompt,
            model=self.config.default_model,
            timeout_seconds=self.config.job_timeout_seconds,
            permission_mode=self.config.permission_mode,
            interaction_mode=self.config.interaction_mode,
            feishu_target=target,
            interaction_hub=self._interaction_hub,
            interaction_timeout_seconds=float(self.config.interaction_timeout_seconds),
            send_question=self._send_question_prompt,
            session_id=session_id or "",
            cwd=self.config.magi_cwd,
        )
        if result.session_id and self.config.persist_sessions:
            self._sessions.set(incoming.receive_id, result.session_id)
        if result.error and not result.text:
            return f"任务失败: {result.error}"
        if result.error:
            return f"{result.text}\n\n_(warning: {result.error})_"
        return result.text or "(empty result)"

    def shutdown(self) -> None:
        self._executor.shutdown(wait=False, cancel_futures=True)


def build_event_handler(handler: MessageHandler) -> lark.EventDispatcherHandler:
    def on_message(data: lark.im.v1.P2ImMessageReceiveV1) -> None:
        handler.handle(data)

    return (
        lark.EventDispatcherHandler.builder("", "")
        .register_p2_im_message_receive_v1(on_message)
        .build()
    )
