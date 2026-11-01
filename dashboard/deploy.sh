#!/usr/bin/env bash
# Deploy the dashboard to the configured host and (re)start it on :5001.
# Host/port/key default to the local SSH alias "eval_data" (~/.ssh/config);
# override with EVAL_DEPLOY_HOST / EVAL_DEPLOY_PORT / EVAL_DEPLOY_KEY.
set -euo pipefail

HOST="${EVAL_DEPLOY_HOST:-eval_data}"
REMOTE="${EVAL_DEPLOY_REMOTE:-/opt/eval_dashboard}"
HERE="$(cd "$(dirname "$0")" && pwd)"

SSH_OPTS=(-o StrictHostKeyChecking=no -o ConnectTimeout=20)
if [ -n "${EVAL_DEPLOY_PORT:-}" ]; then SSH_OPTS+=(-p "$EVAL_DEPLOY_PORT"); fi
if [ -n "${EVAL_DEPLOY_KEY:-}" ]; then SSH_OPTS+=(-i "$EVAL_DEPLOY_KEY"); fi

SSH=(ssh "${SSH_OPTS[@]}")
RSYNC=(rsync -az --delete --exclude 'data.json' --exclude 'data.json.gz' --exclude 'samples.json' --exclude 'samples.json.gz' --exclude 'static/samples' --exclude 'server.pid' --exclude 'cache' --exclude 'logs' --exclude '*.log' --exclude '__pycache__' --exclude 'build' --exclude 'local_dev'
  -e "ssh ${SSH_OPTS[*]}")

"${SSH[@]}" "$HOST" "mkdir -p $REMOTE/static $REMOTE/cache $REMOTE/logs"
"${RSYNC[@]}" "$HERE/" "$HOST:$REMOTE/"
"${SSH[@]}" "$HOST" "cd $REMOTE && mkdir -p logs && (timeout 300 python3 prepare.py --counts cache/datasets.json >> logs/prepare.log 2>&1 || echo '[deploy] prepare skipped') && (timeout 900 python3 prepare_samples.py >> logs/samples.log 2>&1 || echo '[deploy] samples generation skipped') && chmod +x start.sh stop.sh precompress.sh && ./precompress.sh && ./stop.sh && ./start.sh"
echo "deployed -> $REMOTE"
