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
RSYNC=(rsync -az --delete --exclude 'data.json' --exclude 'data.json.gz' --exclude 'data-*.json' --exclude 'data-*.json.gz' --exclude 'samples.json' --exclude 'samples.json.gz' --exclude 'samples-*.json' --exclude 'samples-*.json.gz' --exclude 'static/samples' --exclude 'static/.samples-*' --exclude 'server.pid' --exclude 'stats.pid' --exclude 'logs' --exclude 'cache' --exclude '*.log' --exclude '__pycache__' --exclude 'local_dev' --exclude 'tests'
  -e "ssh ${SSH_OPTS[*]}")

"${SSH[@]}" "$HOST" "mkdir -p $REMOTE/static $REMOTE/logs"
"${RSYNC[@]}" "$HERE/" "$HOST:$REMOTE/"
"${SSH[@]}" "$HOST" "cd $REMOTE && mkdir -p logs && (python3 -c 'import orjson' 2>/dev/null || python3 -m pip install --user --quiet orjson >> logs/build.log 2>&1 || true) && (timeout 1800 python3 build.py --keep-on-empty >> logs/build.log 2>&1 || echo '[deploy] build skipped, serving the previous payloads') && chmod +x start.sh stop.sh precompress.sh && ./precompress.sh && ./stop.sh && ./start.sh"
echo "deployed -> $REMOTE"
