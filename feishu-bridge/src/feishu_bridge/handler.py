from __future__ import annotations

import json
import logging
import threading
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass

import lark_oapi as lark

from .config import BridgeConfig
from .feishu_api import FeishuMessenger
from .magi_client import MagiEndpoint, dispatch_prompt, format_cluster_status
from .output import format_result_message
from .security import find_dangerous_reason, is_sender_allowed, is_status_query

logger = logging.getLogger(__name__)


@dataclass
class IncomingMessage:
    message_id: str
    chat_id: str
    sender_open_id: str
    text: str
    receive_id: str
    receive_id_type: str


def parse_incoming(event: lark.im.v1.P2ImMessageReceiveV1) -> IncomingMessage | None:
    msg = event.event.message if event.event else None
    sender = event.event.sender if event.event else None
    if not msg or not sender:
        return None

    msg_type = str(msg.message_type or "")
    if msg_type != "text":
        return None

    try:
        payload = json.loads(msg.content or "{}")
    except json.JSONDecodeError:
        return None
    text = str(payload.get("text", "")).strip()
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

    def handle(self, event: lark.im.v1.P2ImMessageReceiveV1) -> None:
        incoming = parse_incoming(event)
        if not incoming:
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
                receive_id=incoming.receive_id,
                receive_id_type=incoming.receive_id_type,
                text=text,
            )
        except Exception:
            logger.exception("Failed to send Feishu text reply")

    def _process(self, incoming: IncomingMessage) -> None:
        try:
            self._reply_text(incoming, "收到，正在处理…")
            result_text = self._execute(incoming.text)
            outbound = format_result_message(result_text, title="Magi")
            self.messenger.reply(
                receive_id=incoming.receive_id,
                receive_id_type=incoming.receive_id_type,
                message=outbound,
            )
        except Exception as err:
            logger.exception("Task failed")
            self._reply_text(incoming, f"执行失败: {err}")

    def _execute(self, text: str) -> str:
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

        result = dispatch_prompt(
            self.router,
            text,
            model=self.config.default_model,
            timeout_seconds=self.config.job_timeout_seconds,
        )
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
