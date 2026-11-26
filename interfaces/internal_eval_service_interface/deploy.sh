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
ssh "$HOST_ALIAS" "REMOTE_DIR='${REMOTE}' PORT='${PORT}' python3 - <<'PY'
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

base = 'http://127.0.0.1:' + os.environ['PORT']
remote_dir = Path(os.environ['REMOTE_DIR'])
sys.path.insert(0, str(remote_dir))
from internal_eval.config import load_config

def fetch(path, token=''):
    headers = {'Authorization': 'Bearer ' + token} if token else {}
    req = urllib.request.Request(base + path, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return resp.status, json.loads(resp.read().decode('utf-8'))
    except urllib.error.HTTPError as exc:
        try:
            body = json.loads(exc.read().decode('utf-8'))
        except Exception:
            body = {}
        finally:
            exc.close()
        return exc.code, body

st, h = fetch('/healthz')
assert st == 200 and h.get('ok'), (st, h)
print('analysis healthz ok:', h['ok'], 'traces:', h['traces'])

st, ad = fetch('/api/v1/analysis/docs')
assert st == 200 and 'docs' in ad.get('data', {}), st
print('analysis docs ok (no token required)')

st, ih = fetch('/api/v1/internal-eval/healthz')
assert st == 200 and ih['data']['ok'], (st, ih)
icfg = ih['data']['config']
print('internal-eval healthz ok:', ih['data']['ok'], 'auth_enabled:', icfg.get('auth_enabled'), 'auth_mode:', icfg.get('auth_mode'))

env_file = remote_dir / 'internal_eval.env'
cfg = load_config(env={}, env_file=env_file if env_file.is_file() else None)
tokens = cfg.resolved_api_tokens()
tok = tokens[0][1] if tokens else ''

if tokens and icfg.get('auth_mode') == 'all':
    st_u, _ = fetch('/api/v1/internal-eval/versions')
    assert st_u == 401, f'expected 401 without token, got {st_u}'
    print('internal-eval unauth blocked: 401')

st_d, docs = fetch('/api/v1/internal-eval/docs', token=tok)
assert st_d == 200, (st_d, docs)
print('internal-eval docs:', [x['name'] for x in docs['data']['docs']])

st_v, vers = fetch('/api/v1/internal-eval/versions', token=tok)
assert st_v == 200, (st_v, vers)
print('internal-eval versions:', vers['data']['total'])
PY"

echo "==> done: http://${HOST_ALIAS}:${PORT}/api/v1/internal-eval"
