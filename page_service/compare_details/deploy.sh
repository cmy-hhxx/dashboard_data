#!/usr/bin/env bash
# Deploy the compare module and restart the shared 5002 page service (sample_details).
set -euo pipefail

HOST="${EVAL_DEPLOY_HOST:-eval_data}"
REMOTE="${EVAL_DEPLOY_REMOTE:-/opt/page_service/compare_details}"
REMOTE_BASE="$(dirname "$REMOTE")"
PAGE_REMOTE="${PAGE_REMOTE:-/opt/page_service/sample_details}"
PORT="${PORT:-5002}"
UPSTREAM="${UPSTREAM:-http://127.0.0.1:5001}"
HERE="$(cd "$(dirname "$0")" && pwd)"

SSH_OPTS=(-o StrictHostKeyChecking=no -o ConnectTimeout=20 -o ServerAliveInterval=15 -o ServerAliveCountMax=4
  -o ControlMaster=auto -o ControlPath=/tmp/omp-page-%r@%h:%p -o ControlPersist=10m)
if [ -n "${EVAL_DEPLOY_PORT:-}" ]; then SSH_OPTS+=(-p "$EVAL_DEPLOY_PORT"); fi
if [ -n "${EVAL_DEPLOY_KEY:-}" ]; then SSH_OPTS+=(-i "$EVAL_DEPLOY_KEY"); fi

SSH=(ssh "${SSH_OPTS[@]}")
RSYNC=(rsync -az --delete
  --exclude 'logs' --exclude 'server.pid' --exclude '__pycache__' --exclude '*.pyc' --exclude 'tests'
  --exclude '.pytest_cache'
  -e "ssh ${SSH_OPTS[*]}")

"${SSH[@]}" "$HOST" "mkdir -p $REMOTE"
"${RSYNC[@]}" "$HERE/" "$HOST:$REMOTE/"
"${RSYNC[@]}" "$HERE/../page_proxy.py" "$HOST:$REMOTE_BASE/"
"${SSH[@]}" "$HOST" "cd $PAGE_REMOTE && ./stop.sh; PORT=$PORT UPSTREAM=$UPSTREAM ./start.sh"
echo "deployed -> $HOST:$REMOTE (5002 restarted)"
