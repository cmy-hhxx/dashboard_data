#!/usr/bin/env bash
# Serve the dashboard on 5001. Exposed as dashboard.example.com:2768 -> 5001.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p logs

if curl -s -m 2 -o /dev/null http://127.0.0.1:5001/healthz; then
  echo "already serving on :5001"
  exit 0
fi

rm -f server.pid
PORT=5001 nohup python3 server.py >> logs/server.log 2>&1 &
echo $! > server.pid
sleep 1
curl -s -m 3 -o /dev/null -w ":5001 health %{http_code}\n" http://127.0.0.1:5001/healthz || true
cat server.pid
