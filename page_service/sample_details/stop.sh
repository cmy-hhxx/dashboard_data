#!/usr/bin/env bash
# Stop the standalone sample-detail page (only this module's process).
set -euo pipefail
cd "$(dirname "$0")"

if [ -f server.pid ]; then
  pid="$(cat server.pid)"
  kill "$pid" 2>/dev/null && echo "stopped $pid" || true
  rm -f server.pid
fi
# The pid file can be stale after a container restart; match the absolute script
# path so the dashboard's own "python3 server.py" is never touched.
pkill -f "$PWD/server.py" 2>/dev/null || true
