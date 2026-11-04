#!/usr/bin/env bash
# Serve the dashboard on $PORT (default 5001). Public mapping is configured by the deployment
# environment. A second copy (staging) sets PORT and STATS_WORKER=0 so only one stats sidecar runs.
set -euo pipefail
cd "$(dirname "$0")"
# Settings this copy was deployed with (deploy.sh writes deploy.env): port, data root, products.
if [ -f deploy.env ]; then . ./deploy.env; fi
mkdir -p logs
PORT="${PORT:-5001}"

# The stats sidecar is independent of the HTTP server and keeps
# <datasets>/stats.json fresh for the next build.  Start it even when the
# dashboard is already serving.
if [ "${STATS_WORKER:-1}" = "0" ]; then
  :
elif [ -f stats.pid ] && kill -0 "$(cat stats.pid 2>/dev/null)" 2>/dev/null; then
  :
else
  rm -f stats.pid
  nohup python3 stats_worker.py >> logs/stats.log 2>&1 &
  echo $! > stats.pid
fi

if curl -s -m 2 -o /dev/null "http://127.0.0.1:${PORT}/healthz"; then
  echo "already serving on :${PORT}"
  exit 0
fi

rm -f server.pid
PORT="$PORT" nohup python3 server.py >> logs/server.log 2>&1 &
echo $! > server.pid
sleep 1
curl -s -m 3 -o /dev/null -w ":${PORT} health %{http_code}\n" "http://127.0.0.1:${PORT}/healthz" || true
cat server.pid
