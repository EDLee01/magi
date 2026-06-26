#!/usr/bin/env bash
# Keep Feishu bridge running in the background (survives terminal close).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
PID_FILE="${FEISHU_BRIDGE_PID_FILE:-$ROOT/.feishu-bridge.pid}"
LOG_FILE="${FEISHU_BRIDGE_LOG:-/tmp/feishu-bridge.log}"

if [[ ! -d .venv ]]; then
  python3 -m venv .venv
  # shellcheck disable=SC1091
  source .venv/bin/activate
  pip install -q -r requirements.txt
fi

if [[ -f "$PID_FILE" ]]; then
  old_pid="$(cat "$PID_FILE")"
  if kill -0 "$old_pid" 2>/dev/null; then
    echo "Feishu bridge already running (pid $old_pid)"
    exit 0
  fi
  rm -f "$PID_FILE"
fi

export PYTHONPATH="$ROOT/src:${PYTHONPATH:-}"
nohup .venv/bin/python -m feishu_bridge.main >>"$LOG_FILE" 2>&1 &
echo $! >"$PID_FILE"
sleep 2
if kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "Feishu bridge started pid=$(cat "$PID_FILE") log=$LOG_FILE"
else
  echo "Feishu bridge failed to start — see $LOG_FILE" >&2
  tail -10 "$LOG_FILE" >&2 || true
  exit 1
fi
