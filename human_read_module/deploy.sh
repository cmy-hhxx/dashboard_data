#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
SSH_HOST="${HUMAN_READ_SSH_HOST:-aime_rsi_data}"
REMOTE_ROOT="${HUMAN_READ_REMOTE_ROOT:-/opt/human_read_service}"

echo "Syncing human_read_module -> ${SSH_HOST}:${REMOTE_ROOT}/human_read_module ..."
ssh "$SSH_HOST" "mkdir -p '$REMOTE_ROOT/human_read_module'"
rsync -az --delete \
  --exclude '__pycache__' \
  --exclude 'logs' \
  --exclude '*.pyc' \
  "$DIR/" "${SSH_HOST}:${REMOTE_ROOT}/human_read_module/"

ssh "$SSH_HOST" "chmod +x '$REMOTE_ROOT/human_read_module/start.sh' '$REMOTE_ROOT/human_read_module/stop.sh'"
echo "Synced cleanly to ${SSH_HOST}:${REMOTE_ROOT}/human_read_module"
