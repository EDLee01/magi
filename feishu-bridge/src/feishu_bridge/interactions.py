from __future__ import annotations

import re
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Callable


@dataclass(frozen=True)
class FeishuTarget:
    receive_id: str
    receive_id_type: str
    message_id: str = ""


@dataclass
class PendingQuestion:
    job_id: str
    tool_use_id: str
    endpoint_key: str
    questions: list[dict[str, Any]]
    target: FeishuTarget
    created_at: float = field(default_factory=time.time)
    event: threading.Event = field(default_factory=threading.Event)
    answer: dict[str, Any] | None = None
    error: str | None = None


def parse_question_selection(text: str, questions: list[dict[str, Any]]) -> dict[str, Any] | None:
    """Parse user reply into Magi AskUserQuestion answer payload."""
    cleaned = text.strip()
    if not cleaned or not questions:
        return None

    tokens = [part.strip() for part in re.split(r"[,/|\s]+", cleaned) if part.strip()]
    if not tokens:
        return None

    answers: list[dict[str, Any]] = []
    for index, question in enumerate(questions):
        options = question.get("options") if isinstance(question.get("options"), list) else []
        if not options:
            return None

        token = tokens[index] if index < len(tokens) else tokens[0] if len(questions) == 1 else ""
        if not token:
            return None

        selected = _match_option(token, options)
        if not selected:
            return None

        answers.append(
            {
                "question": str(question.get("question") or ""),
                "selectedLabels": [selected["label"]],
            }
        )

    if len(answers) != len(questions):
        return None
    return {"answers": answers}


def _match_option(token: str, options: list[dict[str, Any]]) -> dict[str, Any] | None:
    if token.isdigit():
        idx = int(token) - 1
        if 0 <= idx < len(options):
            return options[idx]

    lowered = token.lower()
    for option in options:
        label = str(option.get("label") or "")
        if label.lower() == lowered or lowered in label.lower():
            return option
    return None


class InteractionHub:
    """Bridge Magi pending AskUserQuestion interactions to Feishu replies."""

    def __init__(self, *, default_timeout_seconds: float = 300.0) -> None:
        self._default_timeout_seconds = default_timeout_seconds
        self._lock = threading.Lock()
        self._by_target: dict[str, PendingQuestion] = {}

    def has_pending(self, receive_id: str) -> bool:
        with self._lock:
            pending = self._by_target.get(receive_id)
            return pending is not None and not pending.event.is_set()

    def wait_for_answer(
        self,
        *,
        target: FeishuTarget,
        job_id: str,
        tool_use_id: str,
        endpoint_key: str,
        questions: list[dict[str, Any]],
        send_prompt: Callable[[FeishuTarget, list[dict[str, Any]], str, str], None],
        timeout_seconds: float | None = None,
    ) -> dict[str, Any] | None:
        timeout = timeout_seconds if timeout_seconds is not None else self._default_timeout_seconds
        pending = PendingQuestion(
            job_id=job_id,
            tool_use_id=tool_use_id,
            endpoint_key=endpoint_key,
            questions=questions,
            target=target,
        )
        with self._lock:
            self._by_target[target.receive_id] = pending

        send_prompt(target, questions, job_id, tool_use_id)

        finished = pending.event.wait(timeout=timeout)
        with self._lock:
            self._by_target.pop(target.receive_id, None)

        if not finished:
            pending.error = "timed out waiting for Feishu reply"
            return None
        if pending.error:
            return None
        return pending.answer

    def handle_reply(self, receive_id: str, text: str) -> tuple[bool, str | None]:
        """Returns (handled, error_message). handled=True means reply consumed."""
        with self._lock:
            pending = self._by_target.get(receive_id)
            if pending is None or pending.event.is_set():
                return False, None

        answer = parse_question_selection(text, pending.questions)
        if answer is None:
            return True, "无法识别选项，请回复数字（如 1）或选项名称。"

        pending.answer = answer
        pending.event.set()
        return True, None

    def cancel(self, receive_id: str) -> None:
        with self._lock:
            pending = self._by_target.pop(receive_id, None)
        if pending and not pending.event.is_set():
            pending.error = "cancelled"
            pending.event.set()
