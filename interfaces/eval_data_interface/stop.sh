#!/usr/bin/env bash
# 停止对话分析查询接口：先按 pidfile，再按端口兜底。
set -uo pipefail

cd "$(dirname "$0")"

PORT="${PORT:-5003}"
PIDFILE="${PIDFILE:-server.pid}"

stop_pid() {
  local pid="$1"
  [ -z "$pid" ] && return 0
  kill "$pid" 2>/dev/null || return 0
  for _ in $(seq 1 10); do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 0.5
  done
  kill -9 "$pid" 2>/dev/null || true
}

if [ -f "$PIDFILE" ]; then
  stop_pid "$(cat "$PIDFILE")"
  rm -f "$PIDFILE"
fi

# 兜底：端口上还挂着本目录的 run.py 时一并清掉
if command -v lsof >/dev/null 2>&1; then
  for pid in $(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true); do
    cmd=$(ps -p "$pid" -o command= 2>/dev/null || true)
    case "$cmd" in
      *run.py*) stop_pid "$pid" ;;
    esac
  done
fi

echo "stopped on :${PORT}"
