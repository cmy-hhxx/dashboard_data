#!/usr/bin/env bash
# Deploy pg_data_core to /opt/pg_data_core on aime_rsi_data_server
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
HOST="${EVAL_DEPLOY_HOST:-${AIME_SSH_HOST:-aime_rsi_data}}"
PORT="${EVAL_DEPLOY_PORT:-${AIME_SSH_PORT:-}}"
KEY="${EVAL_DEPLOY_KEY:-${AIME_SSH_KEY:-}}"
REMOTE_DIR="/opt/pg_data_core"

SSH_OPTS=(-o ConnectTimeout=10 -o StrictHostKeyChecking=no)
[ -n "${PORT}" ] && SSH_OPTS+=(-p "${PORT}")
[ -n "${KEY}" ] && SSH_OPTS+=(-i "${KEY}")

# Ensure self-contained intent taxonomy asset is synced
mkdir -p "${SCRIPT_DIR}/assets"
cp -f "${REPO_ROOT}/interfaces/eval_data_interface/taxonomy/intent_2026-11.json" \
      "${SCRIPT_DIR}/assets/intent_2026-11.json"

ssh "${SSH_OPTS[@]}" "${HOST}" "mkdir -p '${REMOTE_DIR}/pg_data_core' '${REMOTE_DIR}/scripts'"

rsync -az --delete \
    --exclude '__pycache__/' \
    --exclude '*.pyc' \
    --exclude '.pg_secrets.env' \
    -e "ssh ${SSH_OPTS[*]}" \
    "${SCRIPT_DIR}/" "${HOST}:${REMOTE_DIR}/pg_data_core/"

ssh "${SSH_OPTS[@]}" "${HOST}" "
ln -sfn '${REMOTE_DIR}/pg_data_core/scripts' '${REMOTE_DIR}/scripts_link'
cp -f '${REMOTE_DIR}/pg_data_core/scripts/'*.sh '${REMOTE_DIR}/scripts/'
chmod +x '${REMOTE_DIR}/scripts/'*.sh '${REMOTE_DIR}/pg_data_core/scripts/'*.sh
echo '[deploy] synced pg_data_core to ${REMOTE_DIR}'
"
