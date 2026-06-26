from __future__ import annotations

import logging
import sys
from pathlib import Path

import lark_oapi as lark

# Allow `python src/feishu_bridge/main.py` without install.
ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from feishu_bridge.config import load_config  # noqa: E402
from feishu_bridge.handler import MessageHandler, build_event_handler  # noqa: E402


def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
    )
    config_path = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "config.local.toml"
    config = load_config(config_path)
    handler = MessageHandler(config)
    event_handler = build_event_handler(handler)

    if not config.allowed_user_ids and not config.dev_allow_all:
        logging.warning(
            "security.allowed_user_ids is empty — all senders will be rejected until you add your open_id."
        )
    elif config.dev_allow_all:
        logging.warning("security.dev_allow_all=true — local testing only, disable before production.")

    logging.info(
        "Starting Feishu bridge (router=%s, peers=%d)",
        config.router_base_url,
        len(config.manual_peers),
    )
    client = lark.ws.Client(
        config.app_id,
        config.app_secret,
        event_handler=event_handler,
        log_level=lark.LogLevel.INFO,
    )
    try:
        client.start()
    finally:
        handler.shutdown()


if __name__ == "__main__":
    main()
