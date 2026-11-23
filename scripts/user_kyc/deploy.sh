#!/usr/bin/env bash
# 把 user_kyc 的代码发布到弗吉尼亚（不覆盖库、日志、锁）。
# 发布后若要生效到正在跑的 loop，需要重启：bash start_sync.sh 前先 pkill。
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
HOST="${KYC_HOST:-aime_rsi_data}"
REMOTE="${KYC_REMOTE:-/mnt/aime_eval_ssd/1_aime/user_kyc}"

rsync -az --delete \
  --exclude '__pycache__' \
  --exclude 'kyc.sqlite3*' \
  --exclude 'logs/' \
  --exclude 'export/' \
  --exclude 'backup-*.sqlite3' \
  --exclude '.pytest_cache/' \
  "$DIR/" "$HOST:$REMOTE/"

ssh "$HOST" "chown -R root:root '$REMOTE' && chmod -R a+rX '$REMOTE'"
echo "deployed to $HOST:$REMOTE"
echo "如正在跑 loop，重启后新代码才生效："
echo "  ssh $HOST 'pkill -f \"[k]yc_sync.py loop\" || true' && ssh $HOST 'bash $REMOTE/start_sync.sh'"
