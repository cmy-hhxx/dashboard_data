#!/usr/bin/env bash
# 部署到远端：同步代码 → 重启服务 → 等索引就绪 → 冒烟验收。
set -euo pipefail

cd "$(dirname "$0")"

HOST_ALIAS="${EVAL_DEPLOY_HOST:-eval_data}"
REMOTE="${EVAL_DEPLOY_REMOTE:-/opt/eval_analysis}"
PORT="${PORT:-5003}"

# 与 dashboard/deploy.sh 一致：端口与密钥可用环境变量覆盖，否则交给 ~/.ssh/config
SSH_OPTS=(-o ConnectTimeout=20)
if [ -n "${EVAL_DEPLOY_PORT:-}" ]; then SSH_OPTS+=(-p "$EVAL_DEPLOY_PORT"); fi
if [ -n "${EVAL_DEPLOY_KEY:-}" ]; then SSH_OPTS+=(-i "$EVAL_DEPLOY_KEY"); fi
ssh() { command ssh "${SSH_OPTS[@]}" "$@"; }

echo "==> rsync -> ${HOST_ALIAS}:${REMOTE}"
ssh "$HOST_ALIAS" "mkdir -p '${REMOTE}'"
rsync -az --delete -e "ssh ${SSH_OPTS[*]}" \
  --exclude '.git' \
  --exclude 'state' \
  --exclude 'logs' \
  --exclude 'server.pid' \
  --exclude '__pycache__' \
  --exclude '*.pyc' \
  --exclude 'tests/__pycache__' \
  ./ "${HOST_ALIAS}:${REMOTE}/"

echo "==> 重启服务"
ssh "$HOST_ALIAS" "cd '${REMOTE}' && chmod +x start.sh stop.sh && ./stop.sh && PORT=${PORT} ./start.sh"

echo "==> 冒烟：健康检查 + 三个接口"
ssh "$HOST_ALIAS" "set -e
  curl -fsS 'http://127.0.0.1:${PORT}/healthz'
  echo
  curl -fsS 'http://127.0.0.1:${PORT}/api/v1/analysis/taxonomy?kind=intent' | python3 -c 'import json,sys; d=json.load(sys.stdin); print(\"intent nodes\", len(d[\"data\"][\"nodes\"]))'
  curl -fsS 'http://127.0.0.1:${PORT}/api/v1/analysis/summary?dataset=aime_eval&group_by=intent' | python3 -c 'import json,sys; d=json.load(sys.stdin); print(\"summary total\", d[\"data\"][\"total\"])'
  curl -fsS 'http://127.0.0.1:${PORT}/api/v1/analysis/traces?dataset=aime_eval&page_size=1' | python3 -c 'import json,sys; d=json.load(sys.stdin); print(\"traces total\", d[\"data\"][\"total\"])'
"

echo "==> done: http://${HOST_ALIAS}:${PORT}/api/v1/analysis"
