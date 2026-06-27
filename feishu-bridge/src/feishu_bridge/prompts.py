from __future__ import annotations

import re

_NEW_CHAT_RE = re.compile(
    r"^(?:/new|/reset|新对话|重置对话|重新开始|清空对话)\s*$",
    re.IGNORECASE,
)

# Default: mirror the user's language (问什么回什么).
_AUTO_HINT = (
    "[Feishu channel]\n"
    "- Reply in the same language as the user's latest message (问什么回什么).\n"
    "- Do not switch language mid-response (e.g. do not open in Korean and continue in Chinese).\n"
    "- Sub-agent and tool summaries must use the same language as the user.\n"
    "- This is a continuous Feishu conversation; use prior turns for follow-ups.\n\n"
)

_LOCALE_HINTS: dict[str, str] = {
    "auto": _AUTO_HINT,
    "zh-cn": (
        "[Feishu / 简体中文]\n"
        "- 始终用简体中文回复。\n"
        "- 不要在同一条回复中途切换语言。\n\n"
    ),
    "zh-tw": (
        "[Feishu / 繁體中文]\n"
        "- 始終用繁體中文回覆。\n"
        "- 不要在同一則回覆中途切換語言。\n\n"
    ),
    "en": (
        "[Feishu / English]\n"
        "- Reply in English.\n"
        "- Do not switch language mid-response.\n\n"
    ),
}


def is_new_chat_command(text: str) -> bool:
    return bool(_NEW_CHAT_RE.match(text.strip()))


def wrap_prompt_for_feishu(prompt: str, *, response_language: str = "auto") -> str:
    key = response_language.strip().lower().replace("_", "-") or "auto"
    hint = _LOCALE_HINTS.get(key, _AUTO_HINT)
    body = prompt.strip()
    if body.startswith("[Feishu"):
        return body
    return f"{hint}{body}"
