from __future__ import annotations

import json
import re
from dataclasses import dataclass


@dataclass
class OutboundMessage:
    msg_type: str
    content: str


def markdown_to_lark_md(text: str) -> str:
    """Best-effort markdown → lark_md (headings/tables stripped or simplified)."""
    lines: list[str] = []
    in_code = False
    for raw in text.splitlines():
        line = raw.rstrip()
        if line.strip().startswith("```"):
            in_code = not in_code
            if in_code:
                lines.append("**[code]**")
            continue
        if in_code:
            lines.append(f"`{line}`" if line else "")
            continue
        if line.startswith("### "):
            lines.append(f"**{line[4:].strip()}**")
            continue
        if line.startswith("## "):
            lines.append(f"**{line[3:].strip()}**")
            continue
        if line.startswith("# "):
            lines.append(f"**{line[2:].strip()}**")
            continue
        if re.match(r"^\|.+\|$", line.strip()) and "|" in line.strip()[1:-1]:
            # Table row → plain text cells
            cells = [c.strip() for c in line.strip().strip("|").split("|")]
            if all(set(c) <= {"-", ":", " "} for c in cells):
                continue
            lines.append(" · ".join(c for c in cells if c))
            continue
        lines.append(line)
    return "\n".join(lines).strip()


def build_question_card(questions: list[dict[str, Any]], *, title: str = "Magi 需要你选择") -> str:
    """Interactive card listing AskUserQuestion options."""
    elements: list[dict] = [
        {
            "tag": "div",
            "text": {
                "tag": "lark_md",
                "content": "Agent 需要你确认方向，**回复数字**即可（例如 `1`）。",
            },
        }
    ]
    for q_index, question in enumerate(questions):
        header = str(question.get("header") or "").strip()
        prompt = str(question.get("question") or "").strip()
        lines = [f"**问题 {q_index + 1}**"]
        if header:
            lines.append(header)
        if prompt:
            lines.append(prompt)
        elements.append(
            {"tag": "div", "text": {"tag": "lark_md", "content": "\n".join(lines)}}
        )
        options = question.get("options") if isinstance(question.get("options"), list) else []
        option_lines: list[str] = []
        for opt_index, option in enumerate(options):
            label = str(option.get("label") or "").strip()
            desc = str(option.get("description") or "").strip()
            suffix = f" — {desc}" if desc else ""
            option_lines.append(f"{opt_index + 1}. **{label}**{suffix}")
        if option_lines:
            elements.append(
                {"tag": "div", "text": {"tag": "lark_md", "content": "\n".join(option_lines)}}
            )
    if len(questions) > 1:
        hint = "多个问题请用空格或逗号分隔，如：`1 2`"
    else:
        hint = "直接回复选项编号，如：`1`"
    elements.append({"tag": "note", "elements": [{"tag": "plain_text", "content": hint}]})
    card = {
        "config": {"wide_screen_mode": True},
        "header": {"title": {"tag": "plain_text", "content": title[:80]}},
        "elements": elements,
    }
    return json.dumps(card, ensure_ascii=False)


def build_interactive_card(title: str, body_md: str, note: str | None = None) -> str:
    elements: list[dict] = [
        {"tag": "div", "text": {"tag": "lark_md", "content": markdown_to_lark_md(body_md) or "(empty)"}}
    ]
    if note:
        elements.append({"tag": "note", "elements": [{"tag": "plain_text", "content": note}]})
    card = {
        "config": {"wide_screen_mode": True},
        "header": {"title": {"tag": "plain_text", "content": title[:80]}},
        "elements": elements,
    }
    return json.dumps(card, ensure_ascii=False)


def split_for_feishu(text: str, *, max_chars: int = 3500) -> list[str]:
    """Split long replies into Feishu-safe chunks."""
    trimmed = text.strip()
    if len(trimmed) <= max_chars:
        return [trimmed]
    parts: list[str] = []
    start = 0
    while start < len(trimmed):
        parts.append(trimmed[start : start + max_chars])
        start += max_chars
    return parts


def format_result_message(text: str, *, title: str = "Magi") -> OutboundMessage:
    """降级链: interactive card → post-style text → plain text."""
    trimmed = text.strip()
    if not trimmed:
        return OutboundMessage("text", json.dumps({"text": "(no output)"}, ensure_ascii=False))

    if len(trimmed) <= 2800:
        try:
            card = build_interactive_card(title, trimmed)
            return OutboundMessage("interactive", card)
        except Exception:
            pass

    lark_md = markdown_to_lark_md(trimmed)
    if len(lark_md) <= 4000:
        post = {
            "zh_cn": {
                "title": title[:80],
                "content": [[{"tag": "text", "text": lark_md}]],
            }
        }
        return OutboundMessage("post", json.dumps(post, ensure_ascii=False))

    return OutboundMessage("text", json.dumps({"text": trimmed[:18000]}, ensure_ascii=False))
