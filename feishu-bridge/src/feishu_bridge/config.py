from __future__ import annotations

import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

if sys.version_info >= (3, 11):
    import tomllib
else:
    import tomli as tomllib


@dataclass
class PeerNode:
    name: str
    url: str
    role: str = ""


@dataclass
class BridgeConfig:
    app_id: str
    app_secret: str
    router_base_url: str
    router_device_id: str
    router_token: str
    allowed_user_ids: list[str]
    allowed_chat_ids: list[str]
    dev_allow_all: bool
    default_model: str
    job_timeout_seconds: int
    permission_mode: str
    interaction_mode: str
    interaction_timeout_seconds: int
    response_language: str
    magi_cwd: str
    persist_sessions: bool
    session_ttl_seconds: int
    manual_peers: list[PeerNode] = field(default_factory=list)


PERMISSION_MODE_ALIASES: dict[str, str] = {
    "default": "default",
    "acceptedits": "acceptEdits",
    "accept": "acceptEdits",
    "dontask": "dontAsk",
    "bypass": "bypassPermissions",
    "bypasspermissions": "bypassPermissions",
    "fullaccess": "bypassPermissions",
    "full": "bypassPermissions",
    "yolo": "bypassPermissions",
    "plan": "plan",
}


def normalize_permission_mode(value: str) -> str:
    key = value.strip().lower().replace("_", "").replace("-", "")
    return PERMISSION_MODE_ALIASES.get(key, value.strip())


def _load_toml(path: Path) -> dict[str, Any]:
    with path.open("rb") as handle:
        return tomllib.load(handle)


def load_config(config_path: Path | None = None) -> BridgeConfig:
    root = Path(__file__).resolve().parents[2]
    path = config_path or root / "config.local.toml"
    if not path.exists():
        example = root / "config.example.toml"
        raise FileNotFoundError(
            f"Missing {path}. Copy {example} to config.local.toml and fill in credentials."
        )

    raw = _load_toml(path)
    feishu = raw.get("feishu", {})
    router = raw.get("router", {})
    security = raw.get("security", {})
    magi = raw.get("magi", {})
    peers_raw = raw.get("peers", {}).get("manual", [])

    app_id = str(feishu.get("app_id", "")).strip()
    app_secret = str(feishu.get("app_secret", "")).strip()
    if not app_id or not app_secret:
        raise ValueError("feishu.app_id and feishu.app_secret are required in config.local.toml")

    manual_peers: list[PeerNode] = []
    for item in peers_raw:
        if not isinstance(item, dict):
            continue
        name = str(item.get("name", "")).strip()
        url = str(item.get("url", "")).strip()
        if not name or not url:
            continue
        manual_peers.append(
            PeerNode(name=name, url=url.rstrip("/"), role=str(item.get("role", "")).strip())
        )

    return BridgeConfig(
        app_id=app_id,
        app_secret=app_secret,
        router_base_url=str(router.get("base_url", "http://127.0.0.1:8765")).strip().rstrip("/"),
        router_device_id=str(router.get("device_id", "")).strip(),
        router_token=str(router.get("token", "")).strip(),
        allowed_user_ids=[str(v).strip() for v in security.get("allowed_user_ids", []) if str(v).strip()],
        allowed_chat_ids=[str(v).strip() for v in security.get("allowed_chat_ids", []) if str(v).strip()],
        dev_allow_all=bool(security.get("dev_allow_all", False)),
        default_model=str(magi.get("default_model", "main")).strip() or "main",
        job_timeout_seconds=int(magi.get("job_timeout_seconds", 600)),
        permission_mode=normalize_permission_mode(
            str(magi.get("permission_mode", "yolo")).strip() or "yolo"
        ),
        interaction_mode=str(magi.get("interaction_mode", "client")).strip().lower() or "client",
        interaction_timeout_seconds=int(magi.get("interaction_timeout_seconds", 300)),
        response_language=str(magi.get("response_language", "auto")).strip().lower() or "auto",
        magi_cwd=str(magi.get("cwd", "")).strip(),
        persist_sessions=bool(magi.get("persist_sessions", True)),
        session_ttl_seconds=int(magi.get("session_ttl_seconds", 86_400)),
        manual_peers=manual_peers,
    )
