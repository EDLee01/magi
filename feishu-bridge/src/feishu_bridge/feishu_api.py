from __future__ import annotations

import json
import logging

import lark_oapi as lark
from lark_oapi.api.im.v1 import (
    CreateMessageRequest,
    CreateMessageRequestBody,
    ReplyMessageRequest,
    ReplyMessageRequestBody,
)

from .output import OutboundMessage

logger = logging.getLogger(__name__)


class FeishuMessenger:
    def __init__(self, app_id: str, app_secret: str) -> None:
        self._client = (
            lark.Client.builder()
            .app_id(app_id)
            .app_secret(app_secret)
            .log_level(lark.LogLevel.INFO)
            .build()
        )

    def reply_to_message(self, *, message_id: str, message: OutboundMessage) -> bool:
        body = (
            ReplyMessageRequestBody.builder()
            .msg_type(message.msg_type)
            .content(message.content)
            .build()
        )
        req = (
            ReplyMessageRequest.builder()
            .message_id(message_id)
            .request_body(body)
            .build()
        )
        resp = self._client.im.v1.message.reply(req)
        if resp.success():
            return True
        logger.warning(
            "Feishu reply failed code=%s msg=%s log_id=%s",
            resp.code,
            resp.msg,
            resp.get_log_id(),
        )
        return False

    def send(self, *, receive_id: str, receive_id_type: str, message: OutboundMessage) -> None:
        body = (
            CreateMessageRequestBody.builder()
            .receive_id(receive_id)
            .msg_type(message.msg_type)
            .content(message.content)
            .build()
        )
        req = (
            CreateMessageRequest.builder()
            .receive_id_type(receive_id_type)
            .request_body(body)
            .build()
        )
        resp = self._client.im.v1.message.create(req)
        if not resp.success():
            logger.error(
                "Feishu send failed code=%s msg=%s log_id=%s",
                resp.code,
                resp.msg,
                resp.get_log_id(),
            )
            self._send_text_fallback(receive_id=receive_id, receive_id_type=receive_id_type, message=message)

    def reply(
        self,
        *,
        message_id: str = "",
        receive_id: str,
        receive_id_type: str,
        message: OutboundMessage,
    ) -> None:
        if message_id and self.reply_to_message(message_id=message_id, message=message):
            return
        self.send(receive_id=receive_id, receive_id_type=receive_id_type, message=message)

    def _send_text_fallback(
        self, *, receive_id: str, receive_id_type: str, message: OutboundMessage
    ) -> None:
        fallback = json.dumps({"text": message.content[:4000]}, ensure_ascii=False)
        retry_body = (
            CreateMessageRequestBody.builder()
            .receive_id(receive_id)
            .msg_type("text")
            .content(fallback)
            .build()
        )
        retry_req = (
            CreateMessageRequest.builder()
            .receive_id_type(receive_id_type)
            .request_body(retry_body)
            .build()
        )
        retry = self._client.im.v1.message.create(retry_req)
        if not retry.success():
            logger.error("Feishu text fallback failed: %s %s", retry.code, retry.msg)

    def send_text(
        self,
        *,
        message_id: str = "",
        receive_id: str,
        receive_id_type: str,
        text: str,
    ) -> None:
        content = json.dumps({"text": text}, ensure_ascii=False)
        self.reply(
            message_id=message_id,
            receive_id=receive_id,
            receive_id_type=receive_id_type,
            message=OutboundMessage("text", content),
        )
