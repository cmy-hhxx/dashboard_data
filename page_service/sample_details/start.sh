#!/usr/bin/env bash
# Start the standalone sample-detail page on :5002, reading data from the
# internal dashboard (default http://127.0.0.1:5001).
set -euo pipefail
cd "$(dirname "$0")"

PORT="${PORT:-5002}"
export UPSTREAM="${UPSTREAM:-http://127.0.0.1:5001}"
mkdir -p logs

if curl -s -m 2 -o /dev/null "http://127.0.0.1:${PORT}/healthz" 2>/dev/null; then
  echo "already serving on :${PORT}"
  exit 0
fi

nohup python3 "$PWD/server.py" >> logs/server.log 2>&1 &
echo $! > server.pid
sleep 0.6
curl -s -m 3 -o /dev/null -w ":${PORT} health %{http_code}\n" "http://127.0.0.1:${PORT}/healthz" || true
