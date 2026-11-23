#!/usr/bin/env bash
# 启动用户 KYC 同步循环（scan + fetch）。已在跑则直接返回。
# 容器重启后需要手动执行一次；日志在 logs/sync.log。
#   INTERVAL_MIN=360 QPS_INTERVAL=0.25 bash start_sync.sh
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
INTERVAL_MIN="${INTERVAL_MIN:-360}"
QPS_INTERVAL="${QPS_INTERVAL:-0.25}"
REFRESH_DAYS="${REFRESH_DAYS:-30}"

if pgrep -f "[k]yc_sync.py loop" >/dev/null 2>&1; then
  echo "already running:"
  pgrep -af "[k]yc_sync.py loop"
  exit 0
fi

mkdir -p "$DIR/logs"
cd "$DIR"
setsid nohup python3 kyc_sync.py loop \
  --interval-min "$INTERVAL_MIN" --interval "$QPS_INTERVAL" \
  --retry-errors --refresh-days "$REFRESH_DAYS" \
  >> logs/sync.log 2>&1 < /dev/null &
echo "started pid $!  (log: $DIR/logs/sync.log)"
