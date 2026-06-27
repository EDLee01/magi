#!/usr/bin/env bash
# Keep Feishu bridge running in the background (single instance).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
PID_FILE="${FEISHU_BRIDGE_PID_FILE:-$ROOT/.feishu-bridge.pid}"
LOG_FILE="${FEISHU_BRIDGE_LOG:-/tmp/feishu-bridge.log}"
LOCK_FILE="${FEISHU_BRIDGE_LOCK:-$ROOT/.feishu-bridge.lock}"

if [[ ! -d .venv ]]; then
  python3 -m venv .venv
  # shellcheck disable=SC1091
  source .venv/bin/activate
  pip install -q -r requirements.txt
fi

# Portable single-instance lock (macOS lacks flock).
if [[ -f "$LOCK_FILE" ]]; then
  lock_pid="$(cat "$LOCK_FILE" 2>/dev/null || true)"
  if [[ -n "$lock_pid" ]] && kill -0 "$lock_pid" 2>/dev/null; then
    echo "Another start-daemon.sh is running (pid $lock_pid); abort." >&2
    exit 1
  fi
fi
echo $$ >"$LOCK_FILE"
trap 'rm -f "$LOCK_FILE"' EXIT

# Kill stale bridge processes not tracked by pid file.
while read -r stale_pid; do
  if [[ -n "$stale_pid" ]] && kill -0 "$stale_pid" 2>/dev/null; then
    echo "Stopping stale Feishu bridge pid=$stale_pid"
    kill "$stale_pid" 2>/dev/null || true
  fi
done < <(pgrep -f "feishu_bridge.main" 2>/dev/null || true)

if [[ -f "$PID_FILE" ]]; then
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
