#!/usr/bin/env bash
# AIME 乌兰 -> 弗吉尼亚 增量同步常驻循环。
#
#   nohup caffeinate -i bash scripts/aime_sync_loop.sh >/dev/null 2>&1 &
#
# 每 INTERVAL 秒（默认 600）跑一轮；单轮互斥由 python 侧的 lock 保证。
# 每 VERIFY_EVERY 轮（默认 6 轮 = 1 小时）做一次全量 md5 对账（约 3 分钟）。
# 日志：tmp/aime_sync/loop.out（全量 stdout+stderr）、tmp/aime_sync/sync.log（摘要）
# 状态：tmp/aime_sync/last_round.json、tmp/aime_sync/history.jsonl
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

INTERVAL=${INTERVAL:-600}
VERIFY_EVERY=${VERIFY_EVERY:-6}
STATE=tmp/aime_sync
mkdir -p "$STATE"

echo $$ > "$STATE/loop.pid"
echo "[$(date '+%F %T')] loop start pid=$$ interval=${INTERVAL}s verify_every=${VERIFY_EVERY}" >> "$STATE/loop.out"

round=0
while true; do
  round=$((round + 1))
  echo "[$(date '+%F %T')] ---- round #${round} begin ----" >> "$STATE/loop.out"
  if [ "$VERIFY_EVERY" -gt 0 ] && [ $((round % VERIFY_EVERY)) -eq 0 ]; then
    python3 scripts/sync_aime_ulan_to_va.py --verify all >> "$STATE/loop.out" 2>&1
  else
    python3 scripts/sync_aime_ulan_to_va.py >> "$STATE/loop.out" 2>&1
  fi
  rc=$?
  echo "[$(date '+%F %T')] ---- round #${round} end rc=$rc ----" >> "$STATE/loop.out"
  sleep "$INTERVAL"
done
