#!/usr/bin/env bash
# Deploy the dashboard to the eval_data server and (re)start it on :5001.
# Exposed as dashboard.example.com:2768 -> container :5001
set -euo pipefail

HOST="deploy@dashboard.example.com"
PORT="22"
KEY="$HOME/.ssh/id_ed25519"
REMOTE="/opt/eval_dashboard"
HERE="$(cd "$(dirname "$0")" && pwd)"

SSH=(ssh -i "$KEY" -p "$PORT" -o StrictHostKeyChecking=no -o ConnectTimeout=20)
RSYNC=(rsync -az --delete --exclude 'data.json' --exclude 'data.json.gz' --exclude 'samples.json' --exclude 'samples.json.gz' --exclude 'server.pid' --exclude 'cache' --exclude 'logs' --exclude '*.log' --exclude '__pycache__' --exclude 'build'
  -e "ssh -i $KEY -p $PORT -o StrictHostKeyChecking=no")

"${SSH[@]}" "$HOST" "mkdir -p $REMOTE/static $REMOTE/cache $REMOTE/logs"
"${RSYNC[@]}" "$HERE/" "$HOST:$REMOTE/"
"${SSH[@]}" "$HOST" "cd $REMOTE && mkdir -p logs && (timeout 300 python3 prepare.py --counts cache/datasets.json >> logs/prepare.log 2>&1 || echo '[deploy] prepare skipped') && (timeout 900 python3 prepare_samples.py >> logs/samples.log 2>&1 || echo '[deploy] samples generation skipped') && chmod +x start.sh stop.sh precompress.sh && ./precompress.sh && ./stop.sh && ./start.sh"
echo "deployed -> $REMOTE"
