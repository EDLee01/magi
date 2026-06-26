from __future__ import annotations

import re

DANGEROUS_PATTERNS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"\brm\b\s+(-[^\s]*\s+)*-r", re.I), "recursive rm"),
    (re.compile(r"\brm\s+-rf\b", re.I), "rm -rf"),
    (re.compile(r"\bdrop\s+(database|table|schema)\b", re.I), "drop database/table"),
    (re.compile(r"\btruncate\s+table\b", re.I), "truncate table"),
    (re.compile(r"\bsudo\b", re.I), "sudo"),
    (re.compile(r"\bchmod\s+777\b", re.I), "chmod 777"),
    (re.compile(r"\bmkfs\b", re.I), "mkfs"),
    (re.compile(r"\bdd\s+if=", re.I), "dd"),
    (re.compile(r"\bshutdown\b|\breboot\b|\bpoweroff\b", re.I), "system power"),
    (re.compile(r"\bgit\s+push\s+.*--force", re.I), "git force push"),
    (re.compile(r"\bgit\s+reset\s+--hard\b", re.I), "git reset --hard"),
]


def is_sender_allowed(
    *,
    sender_open_id: str | None,
    chat_id: str | None,
    allowed_user_ids: list[str],
    allowed_chat_ids: list[str],
    dev_allow_all: bool = False,
) -> bool:
    if dev_allow_all:
        return True
    if not allowed_user_ids and not allowed_chat_ids:
        return False
    if sender_open_id and allowed_user_ids and sender_open_id in allowed_user_ids:
        return True
    if chat_id and allowed_chat_ids and chat_id in allowed_chat_ids:
        return True
    return False


def find_dangerous_reason(text: str) -> str | None:
    for pattern, label in DANGEROUS_PATTERNS:
        if pattern.search(text):
            return label
    return None


def is_status_query(text: str) -> bool:
    normalized = text.strip().lower()
    return normalized in {
        "节点状态",
        "集群状态",
        "status",
        "node status",
        "cluster status",
        "peers",
        "list peers",
    }
