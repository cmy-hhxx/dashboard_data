#!/usr/bin/env bash
# Stop the local dev server started by local_dev/start.sh.
set -euo pipefail
cd "$(dirname "$0")/.."

PIDFILE="$PWD/local_dev/server.pid"
if [ ! -f "$PIDFILE" ]; then
  echo "[dev] not running (no local_dev/server.pid)"
  exit 0
fi

pid="$(cat "$PIDFILE" 2>/dev/null || true)"
if [ -n "${pid:-}" ] && ps -p "$pid" -o command= 2>/dev/null | grep -q "server.py"; then
  kill "$pid" 2>/dev/null || true
  for _ in 1 2 3 4 5; do
    ps -p "$pid" >/dev/null 2>&1 || break
    sleep 0.4
  done
  if ps -p "$pid" >/dev/null 2>&1; then
    kill -9 "$pid" 2>/dev/null || true
  fi
  echo "[dev] stopped (pid $pid)"
else
  echo "[dev] stale pid file, cleaned up"
fi
rm -f "$PIDFILE"
