#!/usr/bin/env bash
# Serve the dashboard on 5001. Public mapping is configured by the deployment environment.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p logs

# The stats sidecar is independent of the HTTP server and keeps
# <datasets>/stats.json fresh for the next build.  Start it even when the
# dashboard is already serving.
if [ -f stats.pid ] && kill -0 "$(cat stats.pid 2>/dev/null)" 2>/dev/null; then
  :
else
  rm -f stats.pid
  nohup python3 stats_worker.py >> logs/stats.log 2>&1 &
  echo $! > stats.pid
fi

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
