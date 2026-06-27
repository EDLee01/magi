from __future__ import annotations

import json
import threading
import time
from dataclasses import dataclass
from pathlib import Path


@dataclass
class ChatSessionRecord:
    session_id: str
    updated_at: float


class ChatSessionStore:
    """Persist Magi sessionId per Feishu chat/user for multi-turn follow-ups."""

    def __init__(self, path: Path, *, ttl_seconds: float = 86_400.0) -> None:
        self._path = path
        self._ttl_seconds = ttl_seconds
        self._lock = threading.Lock()
        self._records: dict[str, ChatSessionRecord] = {}
        self._load()

    def get(self, receive_id: str) -> str | None:
        with self._lock:
            record = self._records.get(receive_id)
            if record is None:
                return None
            if time.time() - record.updated_at > self._ttl_seconds:
                self._records.pop(receive_id, None)
                self._save()
                return None
            return record.session_id

    def set(self, receive_id: str, session_id: str) -> None:
        if not receive_id or not session_id:
            return
        with self._lock:
            self._records[receive_id] = ChatSessionRecord(
                session_id=session_id,
                updated_at=time.time(),
            )
            self._save()

    def clear(self, receive_id: str) -> None:
        with self._lock:
            if receive_id in self._records:
                self._records.pop(receive_id, None)
                self._save()

    def _load(self) -> None:
        if not self._path.exists():
            return
        try:
            raw = json.loads(self._path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return
        if not isinstance(raw, dict):
            return
        now = time.time()
        for key, value in raw.items():
            if not isinstance(key, str) or not isinstance(value, dict):
                continue
            session_id = str(value.get("session_id") or "")
            updated_at = float(value.get("updated_at") or 0)
            if not session_id:
                continue
            if now - updated_at > self._ttl_seconds:
                continue
            self._records[key] = ChatSessionRecord(session_id=session_id, updated_at=updated_at)

    def _save(self) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            key: {"session_id": record.session_id, "updated_at": record.updated_at}
            for key, record in self._records.items()
        }
        self._path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
