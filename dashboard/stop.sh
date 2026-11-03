#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
HERE="$(pwd -P)"

terminate() {
  local pid="$1"
  kill "$pid" 2>/dev/null || true
  for _ in $(seq 1 20); do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 0.1
  done
  kill -9 "$pid" 2>/dev/null || true
}

if [ -f server.pid ]; then
  terminate "$(cat server.pid)"
  rm -f server.pid
fi

# A previous stop could leave an orphan behind after its pid file was removed;
# clean up any dashboard server.py whose cwd is this deployment directory.
for pid in $(ps -eo pid=,args= | awk '$2=="python3" && $3=="server.py" {print $1}'); do
  [ "$(readlink -f "/proc/$pid/cwd" 2>/dev/null || true)" = "$HERE" ] && terminate "$pid"
done

if [ -f stats.pid ]; then
  terminate "$(cat stats.pid)"
  rm -f stats.pid
fi
for pid in $(ps -eo pid=,args= | awk '$2=="python3" && $3=="stats_worker.py" {print $1}'); do
  [ "$(readlink -f "/proc/$pid/cwd" 2>/dev/null || true)" = "$HERE" ] && terminate "$pid"
done

echo stopped
