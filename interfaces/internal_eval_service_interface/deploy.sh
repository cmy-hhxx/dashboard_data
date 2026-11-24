#!/usr/bin/env bash
# 部署 internal_eval_service_interface 到弗吉尼亚 /opt/internal_eval_service，
# 同步更新 5003 的轻量挂载钩子并重启 5003，最后完成健康检查与文档冒烟验证。
set -euo pipefail

cd "$(dirname "$0")"

HOST_ALIAS="${EVAL_DEPLOY_HOST:-aime_rsi_data}"
REMOTE="${INTERNAL_EVAL_REMOTE:-/opt/internal_eval_service}"
ANALYSIS_REMOTE="${EVAL_DEPLOY_REMOTE:-/opt/eval_analysis}"
PORT="${PORT:-5003}"

SSH_OPTS=(-o ConnectTimeout=20)
if [ -n "${EVAL_DEPLOY_PORT:-}" ]; then SSH_OPTS+=(-p "$EVAL_DEPLOY_PORT"); fi
if [ -n "${EVAL_DEPLOY_KEY:-}" ]; then SSH_OPTS+=(-i "$EVAL_DEPLOY_KEY"); fi
ssh() { command ssh "${SSH_OPTS[@]}" "$@"; }

echo "==> 1) rsync internal_eval_service_interface -> ${HOST_ALIAS}:${REMOTE}"
ssh "$HOST_ALIAS" "mkdir -p '${REMOTE}'"
rsync -az --delete -e "ssh ${SSH_OPTS[*]}" \
  --exclude '.git' \
  --exclude 'internal_eval.env' \
  --exclude '*.env' \
  --exclude 'logs' \
  --exclude 'state' \
  --exclude '__pycache__' \
  --exclude '*.pyc' \
  --exclude '.DS_Store' \
  ./ "${HOST_ALIAS}:${REMOTE}/"

echo "==> 2) 同步 5003 eval_data_interface 挂载代码 -> ${HOST_ALIAS}:${ANALYSIS_REMOTE}"
rsync -az -e "ssh ${SSH_OPTS[*]}" \
  --exclude '.git' \
  --exclude 'state' \
  --exclude 'logs' \
  --exclude 'server.pid' \
  --exclude 'deploy.env' \
  --exclude '__pycache__' \
  --exclude '*.pyc' \
  --exclude '.DS_Store' \
  ../eval_data_interface/ "${HOST_ALIAS}:${ANALYSIS_REMOTE}/"

echo "==> 3) 重启 5003 服务并等待就绪"
ssh "$HOST_ALIAS" "cd '${ANALYSIS_REMOTE}' && { [ ! -f deploy.env ] || . ./deploy.env; } && export INTERNAL_EVAL_SERVICE_DIR='${REMOTE}' && chmod +x start.sh stop.sh && ./stop.sh && PORT=${PORT} WAIT_SECONDS=${WAIT_SECONDS:-1800} ./start.sh"

echo "==> 4) 冒烟验收：既有 /api/v1/analysis + 新建 /api/v1/internal-eval"
ssh "$HOST_ALIAS" "set -e
  curl -fsS 'http://127.0.0.1:${PORT}/healthz' | python3 -c 'import json,sys; d=json.load(sys.stdin); print(\"analysis healthz ok:\", d[\"ok\"], \"traces:\", d[\"traces\"])'
  curl -fsS 'http://127.0.0.1:${PORT}/api/v1/internal-eval/healthz' | python3 -c 'import json,sys; d=json.load(sys.stdin)[\"data\"]; print(\"internal-eval healthz ok:\", d[\"ok\"], \"gateway_configured:\", d[\"config\"][\"gateway_configured\"])'
  curl -fsS 'http://127.0.0.1:${PORT}/api/v1/internal-eval/docs' | python3 -c 'import json,sys; d=json.load(sys.stdin)[\"data\"]; print(\"internal-eval docs:\", [x[\"name\"] for x in d[\"docs\"]])'
  curl -fsS 'http://127.0.0.1:${PORT}/api/v1/internal-eval/versions' | python3 -c 'import json,sys; d=json.load(sys.stdin)[\"data\"]; print(\"internal-eval versions:\", d[\"total\"])'
"

echo "==> done: http://${HOST_ALIAS}:${PORT}/api/v1/internal-eval"
