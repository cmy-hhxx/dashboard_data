#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
LOG_DIR="${HUMAN_READ_LOG_DIR:-$DIR/logs}"
PID_FILE="$LOG_DIR/human_read.pid"

if [ ! -f "$PID_FILE" ]; then
  echo "human_read daemon not running (no pid file)"
  exit 0
fi

PID="$(cat "$PID_FILE" 2>/dev/null || true)"
if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
  kill -TERM "$PID"
  for _ in $(seq 1 20); do
    if ! kill -0 "$PID" 2>/dev/null; then
      break
    fi
    sleep 1
  done
  if kill -0 "$PID" 2>/dev/null; then
    kill -KILL "$PID" 2>/dev/null || true
  fi
  echo "Stopped human_read daemon (pid=$PID)"
else
  echo "human_read daemon already exited (stale pid=$PID)"
fi
rm -f "$PID_FILE"
