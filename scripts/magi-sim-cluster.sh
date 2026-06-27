#!/usr/bin/env bash
# Start a 4-node Magi sim cluster on one machine (router + research + agent + skill).
# Usage: magi-sim-cluster.sh [start|stop|status]
set -euo pipefail

ROOT="${MAGI_SIM_ROOT:-$HOME/.magi-sim}"
ROUTER_PROVIDER_ENV="${MAGI_ROUTER_PROVIDER_ENV:-$HOME/.magi-router/provider.env}"
MAGI_BIN="${MAGI_BIN:-magi}"
BIND="${MAGI_SIM_BIND:-127.0.0.1}"
PID_DIR="$ROOT/pids"
LOG_DIR="$ROOT/logs"

PORTS="8765 8766 8767 8768"

role_for_port() {
  case "$1" in
    8765) echo router ;;
    8766) echo research ;;
    8767) echo agent ;;
    8768) echo skill ;;
    *) echo unknown ;;
  esac
}

write_manifest() {
  local role="$1"
  local dir="$2"
  cat >"$dir/capability-manifest.json" <<EOF
{
  "schemaVersion": 1,
  "product": "Magi Next",
  "role": "$role",
  "version": "0.1.11-sim",
  "capabilities": [
    { "id": "control-api", "status": "beta" }
  ]
}
EOF
}

ensure_instance() {
  local role="$1"
  local dir="$ROOT/$role"
  mkdir -p "$dir" "$PID_DIR" "$LOG_DIR"
  if [[ ! -f "$dir/config.yaml" ]]; then
    MAGI_CONFIG_DIR="$dir" "$MAGI_BIN" init --non-interactive 2>/dev/null || true
  fi
  write_manifest "$role" "$dir"
}

start_one() {
  local port="$1"
  local role
  role="$(role_for_port "$port")"
  local dir="$ROOT/$role"
  local pid_file="$PID_DIR/$role.pid"
  local log_file="$LOG_DIR/$role.log"
  local provider_env="$dir/provider.env"

  if [[ -f "$pid_file" ]] && kill -0 "$(cat "$pid_file")" 2>/dev/null; then
    echo "[$role] already running pid=$(cat "$pid_file") port=$port"
    return 0
  fi

  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "[$role] port $port already in use — skip (external instance OK)"
    return 0
  fi

  ensure_instance "$role"
  echo "[$role] starting on $BIND:$port (MAGI_CONFIG_DIR=$dir)"
  if [[ -f "$provider_env" ]]; then
    set -a
    # shellcheck disable=SC1090
    source "$provider_env"
    set +a
  fi
  if [[ "$role" != "router" ]] && [[ -f "$ROUTER_PROVIDER_ENV" ]]; then
    cp "$ROUTER_PROVIDER_ENV" "$provider_env" 2>/dev/null || true
    chmod 600 "$provider_env" 2>/dev/null || true
    set -a
    # shellcheck disable=SC1090
    source "$provider_env"
    set +a
  fi
  local daemon_status
  daemon_status="$(MAGI_CONFIG_DIR="$dir" "$MAGI_BIN" daemon status 2>/dev/null || true)"
  if echo "$daemon_status" | grep -q "is running"; then
    echo "[$role] daemon already running"
    return 0
  fi
  MAGI_CONFIG_DIR="$dir" MAGI_CONTROL_PORT="$port" "$MAGI_BIN" daemon start >"$log_file" 2>&1 || {
    nohup env MAGI_CONFIG_DIR="$dir" MAGI_CONTROL_PORT="$port" \
      "$MAGI_BIN" serve >>"$log_file" 2>&1 &
  }
  sleep 1.5
  local listen_pid
  listen_pid="$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null | head -1 || true)"
  if [[ -n "$listen_pid" ]]; then
    echo "$listen_pid" >"$pid_file"
  fi
  if curl -sf "http://127.0.0.1:$port/health" >/dev/null; then
    echo "[$role] online http://127.0.0.1:$port pid=${listen_pid:-unknown}"
  else
    echo "[$role] failed — see $log_file"
    tail -3 "$log_file" 2>/dev/null || true
    return 1
  fi
}

stop_one() {
  local role="$1"
  local pid_file="$PID_DIR/$role.pid"
  if [[ -f "$pid_file" ]]; then
    local pid
    pid="$(cat "$pid_file")"
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      echo "[$role] stopped pid=$pid"
    fi
    rm -f "$pid_file"
  fi
}

cmd_status() {
  for port in $PORTS; do
    role="$(role_for_port "$port")"
    if curl -sf "http://127.0.0.1:$port/health" >/dev/null 2>&1; then
      echo "✓ $role :$port online"
    else
      echo "✗ $role :$port offline"
    fi
  done
}

cmd_start() {
  mkdir -p "$ROOT" "$PID_DIR" "$LOG_DIR"
  for port in $PORTS; do
    start_one "$port"
  done
  echo ""
  cmd_status
  if [[ -x "$(dirname "$0")/magi-sim-peers-setup.sh" ]]; then
    echo ""
    echo "Registering peers on router (if online)..."
    "$(dirname "$0")/magi-sim-peers-setup.sh" || true
  fi
}

cmd_stop() {
  for role in skill agent research router; do
    stop_one "$role"
  done
  echo "sim cluster stopped (external magi serve on occupied ports is untouched)"
}

case "${1:-start}" in
  start) cmd_start ;;
  stop) cmd_stop ;;
  status) cmd_status ;;
  *) echo "Usage: $0 [start|stop|status]" >&2; exit 1 ;;
esac
