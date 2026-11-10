#!/usr/bin/env bash
# Deploy this standalone module and (re)start it on :5002.
# The public port mapping (container 5002 -> external 2833) is configured by the
# deployment platform; it is independent of the dashboard's :5001.
set -euo pipefail

HOST="${EVAL_DEPLOY_HOST:-eval_data}"
REMOTE="${EVAL_DEPLOY_REMOTE:-/opt/page_service/sample_details}"
REMOTE_BASE="$(dirname "$REMOTE")"
MATRIX_REMOTE="${MATRIX_REMOTE:-$REMOTE_BASE/problem_matrix}"
COMPARE_REMOTE="${COMPARE_REMOTE:-$REMOTE_BASE/compare_details}"
PORT="${PORT:-5002}"
UPSTREAM="${UPSTREAM:-http://127.0.0.1:5001}"
HERE="$(cd "$(dirname "$0")" && pwd)"
MATRIX_HERE="$(cd "$HERE/../problem_matrix" && pwd)"
COMPARE_HERE="$(cd "$HERE/../compare_details" && pwd)"

SSH_OPTS=(-o StrictHostKeyChecking=no -o ConnectTimeout=20 -o ServerAliveInterval=15 -o ServerAliveCountMax=4
  -o ControlMaster=auto -o ControlPath=/tmp/omp-page-%r@%h:%p -o ControlPersist=10m)
if [ -n "${EVAL_DEPLOY_PORT:-}" ]; then SSH_OPTS+=(-p "$EVAL_DEPLOY_PORT"); fi
if [ -n "${EVAL_DEPLOY_KEY:-}" ]; then SSH_OPTS+=(-i "$EVAL_DEPLOY_KEY"); fi

SSH=(ssh "${SSH_OPTS[@]}")
RSYNC=(rsync -az --delete
  --exclude 'logs' --exclude 'server.pid' --exclude '__pycache__' --exclude '*.pyc' --exclude 'tests'
  --exclude '.pytest_cache'
  -e "ssh ${SSH_OPTS[*]}")

"${SSH[@]}" "$HOST" "mkdir -p $REMOTE $MATRIX_REMOTE $COMPARE_REMOTE"
"${RSYNC[@]}" "$HERE/" "$HOST:$REMOTE/"
"${RSYNC[@]}" "$MATRIX_HERE/" "$HOST:$MATRIX_REMOTE/"
"${RSYNC[@]}" "$COMPARE_HERE/" "$HOST:$COMPARE_REMOTE/"
"${RSYNC[@]}" "$HERE/../page_proxy.py" "$HOST:$REMOTE_BASE/"
"${SSH[@]}" "$HOST" "cd $REMOTE && chmod +x start.sh stop.sh && ./stop.sh; PORT=$PORT UPSTREAM=$UPSTREAM ./start.sh"
echo "deployed -> $HOST:$REMOTE (+ $MATRIX_REMOTE, $COMPARE_REMOTE)"
