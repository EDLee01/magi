from __future__ import annotations

import threading
import time


class DedupeCache:
    """Drop duplicate message/event ids within a TTL window."""

    def __init__(self, ttl_seconds: float = 300.0, max_size: int = 500) -> None:
        self._ttl = ttl_seconds
        self._max_size = max_size
        self._seen: dict[str, float] = {}
        self._lock = threading.Lock()

    def consume(self, key: str) -> bool:
        """Return True for first sighting, False for duplicates."""
        if not key:
            return True
        now = time.monotonic()
        with self._lock:
            self._prune(now)
            if key in self._seen:
                return False
            self._seen[key] = now
            return True

    def _prune(self, now: float) -> None:
        expired = [k for k, ts in self._seen.items() if now - ts > self._ttl]
        for key in expired:
            del self._seen[key]
        if len(self._seen) <= self._max_size:
            return
        oldest = sorted(self._seen.items(), key=lambda item: item[1])
        for key, _ in oldest[: len(self._seen) - self._max_size]:
            del self._seen[key]


class DebounceGate:
    """Allow at most one action per key within a cooldown window."""

    def __init__(self, cooldown_seconds: float = 10.0) -> None:
        self._cooldown = cooldown_seconds
        self._last: dict[str, float] = {}
        self._lock = threading.Lock()

    def allow(self, key: str) -> bool:
        if not key:
            return True
        now = time.monotonic()
        with self._lock:
            last = self._last.get(key)
            if last is not None and now - last < self._cooldown:
                return False
            self._last[key] = now
            return True
