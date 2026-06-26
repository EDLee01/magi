from __future__ import annotations

import json
import logging

import lark_oapi as lark
from lark_oapi.api.im.v1 import CreateMessageRequest, CreateMessageRequestBody

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

    def reply(self, *, receive_id: str, receive_id_type: str, message: OutboundMessage) -> None:
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
            # Plain-text fallback
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

    def send_text(self, *, receive_id: str, receive_id_type: str, text: str) -> None:
        content = json.dumps({"text": text}, ensure_ascii=False)
        self.reply(
            receive_id=receive_id,
            receive_id_type=receive_id_type,
            message=OutboundMessage("text", content),
        )
