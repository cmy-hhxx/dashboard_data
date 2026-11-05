#!/usr/bin/env bash
# Deploy this standalone module and (re)start it on :5002.
# The public port mapping (container 5002 -> external 2833) is configured by the
# deployment platform; it is independent of the dashboard's :5001.
set -euo pipefail

HOST="${EVAL_DEPLOY_HOST:-eval_data}"
REMOTE="${EVAL_DEPLOY_REMOTE:-/opt/page_service/sample_details}"
PORT="${PORT:-5002}"
UPSTREAM="${UPSTREAM:-http://127.0.0.1:5001}"
HERE="$(cd "$(dirname "$0")" && pwd)"

SSH_OPTS=(-o StrictHostKeyChecking=no -o ConnectTimeout=20 -o ServerAliveInterval=15 -o ServerAliveCountMax=4)
if [ -n "${EVAL_DEPLOY_PORT:-}" ]; then SSH_OPTS+=(-p "$EVAL_DEPLOY_PORT"); fi
if [ -n "${EVAL_DEPLOY_KEY:-}" ]; then SSH_OPTS+=(-i "$EVAL_DEPLOY_KEY"); fi

SSH=(ssh "${SSH_OPTS[@]}")
RSYNC=(rsync -az --delete
  --exclude 'logs' --exclude 'server.pid' --exclude '__pycache__' --exclude '*.pyc' --exclude 'tests'
  -e "ssh ${SSH_OPTS[*]}")

"${SSH[@]}" "$HOST" "mkdir -p $REMOTE"
"${RSYNC[@]}" "$HERE/" "$HOST:$REMOTE/"
"${SSH[@]}" "$HOST" "cd $REMOTE && chmod +x start.sh stop.sh && ./stop.sh; PORT=$PORT UPSTREAM=$UPSTREAM ./start.sh"
echo "deployed -> $HOST:$REMOTE"
