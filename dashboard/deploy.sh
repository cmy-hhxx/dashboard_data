#!/usr/bin/env bash
# Deploy the dashboard to the configured host and (re)start it on :5001.
# Host/port/key default to the local SSH alias "eval_data" (~/.ssh/config);
# override with EVAL_DEPLOY_HOST / EVAL_DEPLOY_PORT / EVAL_DEPLOY_KEY.
# Staging: EVAL_DEPLOY_REMOTE=/opt/eval_dashboard_2 PORT=5002 STATS_WORKER=0 ./dashboard/deploy.sh
set -euo pipefail

HOST="${EVAL_DEPLOY_HOST:-eval_data}"
REMOTE="${EVAL_DEPLOY_REMOTE:-/opt/eval_dashboard}"
HERE="$(cd "$(dirname "$0")" && pwd)"

# Browser scripts are ES modules; explicitly select that mode to catch parse errors.
for file in "$HERE"/static/js/*.js; do
  node --input-type=module --check < "$file"
done

SSH_OPTS=(-o StrictHostKeyChecking=no -o ConnectTimeout=20 -o ServerAliveInterval=15 -o ServerAliveCountMax=4)
if [ -n "${EVAL_DEPLOY_PORT:-}" ]; then SSH_OPTS+=(-p "$EVAL_DEPLOY_PORT"); fi
if [ -n "${EVAL_DEPLOY_KEY:-}" ]; then SSH_OPTS+=(-i "$EVAL_DEPLOY_KEY"); fi

SSH=(ssh "${SSH_OPTS[@]}")

# The cluster's SSH edge intermittently refuses connections for several seconds
# (roughly one attempt in five from outside).  Every step here is idempotent, so
# retry instead of failing a deploy at the first refusal.
RETRIES="${EVAL_DEPLOY_RETRIES:-6}"
retry() {
  local attempt=1
  until "$@"; do
    if [ "$attempt" -ge "$RETRIES" ]; then
      echo "[deploy] giving up after $attempt attempts: $1" >&2
      return 1
    fi
    echo "[deploy] attempt $attempt failed, retrying in 5s: $1" >&2
    sleep 5
    attempt=$((attempt + 1))
  done
}
# This copy's settings, saved remotely as deploy.env: the deploy build, start.sh and later manual
# restarts all load it. Only variables set locally are written; with none set, deploy.env is kept.
#   AIME  @ 弗吉尼亚:  EVAL_DEPLOY_HOST=aime_rsi_data EVAL_DATASETS=/mnt/fin_bench/aime_rsi_data EVAL_PRODUCTS=aime ./dashboard/deploy.sh
#   问财  @ 乌兰 5004: EVAL_DEPLOY_REMOTE=/opt/eval_dashboard_2 PORT=5004 STATS_WORKER=0 EVAL_DATASETS=/mnt/fin_bench/code_and_clean_data/datasets EVAL_PRODUCTS=wencai ./dashboard/deploy.sh
RUN_ENV=""
for var in PORT STATS_WORKER REFRESH_SECONDS STATS_REFRESH_SECONDS EVAL_DATASETS EVAL_PRODUCTS; do
  if [ -n "${!var:-}" ]; then RUN_ENV+="export $var=$(printf '%q' "${!var}")"$'\n'; fi
done
RSYNC=(rsync -az --delete --exclude 'data.json' --exclude 'data.json.gz' --exclude 'data-*.json' --exclude 'data-*.json.gz' --exclude 'samples.json' --exclude 'samples.json.gz' --exclude 'samples-*.json' --exclude 'samples-*.json.gz' --exclude 'labels-*.json' --exclude 'labels-*.json.gz' --exclude 'trends-*.json' --exclude 'trends-*.json.gz' --exclude 'abtests-*.json' --exclude 'abtests-*.json.gz' --exclude 'static/samples' --exclude 'static/.samples-*' --exclude 'server.pid' --exclude 'stats.pid' --exclude 'deploy.env' --exclude 'logs' --exclude 'cache' --exclude 'cache_backup' --exclude 'static_backup' --exclude '*.log' --exclude '__pycache__' --exclude 'local_dev' --exclude 'tests'
  -e "ssh ${SSH_OPTS[*]}")

"${SSH[@]}" "$HOST" "mkdir -p $REMOTE/static $REMOTE/logs"
if [ -n "$RUN_ENV" ]; then printf '%s' "$RUN_ENV" | retry "${SSH[@]}" "$HOST" "cat > $REMOTE/deploy.env"; fi
retry "${RSYNC[@]}" "$HERE/" "$HOST:$REMOTE/"
# 部署只管「代码上线」：rsync + 预压缩 + 重启，十几秒结束。
# 数据构建交给 server 自己的刷新循环（重启后 data.json 超过 120s 就会立刻在后台重建），
# 不再让每次发布都在 ceph 上干等两三分钟；EVAL_DEPLOY_BUILD=1 可恢复「发布前先构建」。
retry "${SSH[@]}" "$HOST" "cd $REMOTE && { [ ! -f deploy.env ] || . ./deploy.env; } && mkdir -p logs && chmod +x start.sh stop.sh precompress.sh && ./precompress.sh && ./stop.sh && ./start.sh && if [ \"\${EVAL_DEPLOY_BUILD:-0}\" = \"1\" ]; then (timeout 1800 python3 build.py --keep-on-empty >> logs/build.log 2>&1 || echo '[deploy] build skipped, serving the previous payloads'); fi && (python3 -c 'import orjson' 2>/dev/null || python3 -m pip install --user --quiet orjson >> logs/build.log 2>&1 || true)"
echo "deployed -> $REMOTE"

# A deploy that restarts into a dead service is the failure worth catching here;
# the payload itself is built by the server's own refresh loop afterwards.
PORT_REMOTE="${PORT:-5001}"
retry "${SSH[@]}" "$HOST" "for i in \$(seq 1 20); do curl -sf -m 5 http://127.0.0.1:$PORT_REMOTE/healthz && exit 0; sleep 2; done; echo '[deploy] service did not become healthy' >&2; tail -20 $REMOTE/logs/server.log >&2; exit 1"
echo "healthy -> $HOST:$PORT_REMOTE"
