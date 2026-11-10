#!/usr/bin/env bash
# Stop the standalone matrix page process only (never the shared 5002 server).
set -euo pipefail
cd "$(dirname "$0")"

if [ -f server.pid ]; then
  pid="$(cat server.pid)"
  kill "$pid" 2>/dev/null && echo "stopped $pid" || true
  rm -f server.pid
fi
pkill -f "$PWD/server.py" 2>/dev/null || true
