#!/usr/bin/env bash
# Register sim-cluster workers as router peers and sync model provider config.
# Usage: magi-sim-peers-setup.sh
set -euo pipefail

ROUTER_DIR="${MAGI_ROUTER_DIR:-$HOME/.magi-router}"
SIM_ROOT="${MAGI_SIM_ROOT:-$HOME/.magi-sim}"
MAGI_BIN="${MAGI_BIN:-magi}"

require_router() {
  if ! curl -sf "http://127.0.0.1:8765/health" >/dev/null; then
    echo "Router is offline on :8765. Start it first:" >&2
    echo "  ~/.magi-router/start-router.sh" >&2
    exit 1
  fi
}

sync_provider_config() {
  local role="$1"
  local worker_dir="$SIM_ROOT/$role"
  local router_cfg="$ROUTER_DIR/config.yaml"
  local worker_cfg="$worker_dir/config.yaml"

  if [[ ! -f "$router_cfg" ]]; then
    echo "[provider] skip $role — missing $router_cfg" >&2
    return 1
  fi
  if [[ -f "$ROUTER_DIR/provider.env" ]]; then
    cp "$ROUTER_DIR/provider.env" "$worker_dir/provider.env"
    chmod 600 "$worker_dir/provider.env"
  fi

  python3 - "$router_cfg" "$worker_cfg" <<'PY'
import pathlib
import re
import sys

router_path, worker_path = map(pathlib.Path, sys.argv[1:3])
router_text = router_path.read_text()
worker_text = worker_path.read_text()

def extract_block(text: str, start: str, until: tuple[str, ...]) -> str:
    lines = text.splitlines()
    out: list[str] = []
    capturing = False
    for line in lines:
        if not capturing:
            if line.startswith(f"{start}:"):
                capturing = True
                out.append(line)
            continue
        if line and not line.startswith((" ", "\t")) and line.endswith(":"):
            if any(line.startswith(f"{key}:") for key in until):
                break
        out.append(line)
    return "\n".join(out).rstrip() + "\n"

providers = extract_block(router_text, "providers", ("models", "mcp", "context", "memory", "webSearch", "hooks"))
models = extract_block(router_text, "models", ("fallbacks", "mcp", "context", "memory", "webSearch", "hooks"))
web_search = extract_block(router_text, "webSearch", ("models", "mcp", "context", "memory", "hooks"))
if "providers:" not in providers:
    raise SystemExit("router config missing providers block")

blocks = [("providers", providers), ("models", models)]
if "webSearch:" in web_search:
    blocks.append(("webSearch", web_search))

for key, block in blocks:
    pattern = rf"^{key}:.*?(?=^(?:mcp|context|memory|webSearch|hooks):|\Z)"
    if re.search(pattern, worker_text, flags=re.M | re.S):
        worker_text = re.sub(pattern, block.rstrip() + "\n", worker_text, count=1, flags=re.M | re.S)
    else:
        worker_text = worker_text.rstrip() + "\n\n" + block

worker_path.write_text(worker_text)
print(f"[provider] synced providers/models -> {worker_path}")
PY
}

pair_and_register() {
  local role="$1"
  local port="$2"
  local url="http://127.0.0.1:${port}"
  local worker_dir="$SIM_ROOT/$role"

  if ! curl -sf "$url/health" >/dev/null; then
    echo "[peer] skip $role — offline at $url" >&2
    return 1
  fi

  sync_provider_config "$role" || true

  local pair_json device_id token
  pair_json="$(curl -sf -X POST "$url/pairing" \
    -H "Content-Type: application/json" \
    -d "{\"name\":\"router\"}")"
  device_id="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["deviceId"])' <<<"$pair_json")"
  token="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["token"])' <<<"$pair_json")"

  MAGI_CONFIG_DIR="$ROUTER_DIR" "$MAGI_BIN" peers add "$role" "$url" "$device_id" "$token" >/dev/null
  echo "[peer] registered $role at $url"
}

main() {
  require_router
  mkdir -p "$SIM_ROOT"
  pair_and_register research 8766
  pair_and_register agent 8767
  pair_and_register skill 8768
  echo ""
  echo "Saved peers on router:"
  MAGI_CONFIG_DIR="$ROUTER_DIR" "$MAGI_BIN" peers list 2>/dev/null | grep -E "saved peer|research|agent|skill|127.0.0.1" || true
}

main "$@"
