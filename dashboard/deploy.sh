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
RSYNC=(rsync -az --delete --exclude 'data.json' --exclude 'server.pid' --exclude 'cache' --exclude 'logs' --exclude '*.log' --exclude '__pycache__' --exclude 'build'
  -e "ssh -i $KEY -p $PORT -o StrictHostKeyChecking=no")

"${SSH[@]}" "$HOST" "mkdir -p $REMOTE/static $REMOTE/cache $REMOTE/logs"
"${RSYNC[@]}" "$HERE/" "$HOST:$REMOTE/"
"${SSH[@]}" "$HOST" "chmod +x $REMOTE/start.sh $REMOTE/stop.sh && $REMOTE/start.sh"
echo "deployed -> $REMOTE"
