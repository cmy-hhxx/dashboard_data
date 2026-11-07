#!/usr/bin/env bash
# AIME 数据双向同步常驻循环（2026-11-06 起方向切换）
#
#   方向约定：
#     * daily 输入 / 输出：弗吉尼亚 -> 乌兰（reverse，弗吉尼亚在产出新评测数据）
#     * 聚类树 cluster：乌兰 -> 弗吉尼亚（forward，聚类在乌兰生成）
#     * lost 专项 / lost_archive：乌兰 -> 弗吉尼亚（forward，已固化，只做巡检）
#
#   nohup caffeinate -i bash scripts/aime_sync_loop.sh >/dev/null 2>&1 &
#
# 每 INTERVAL 秒（默认 600）跑两段：先 forward（不含 daily in/out），再 reverse（仅 daily in/out）。
# 单轮互斥由 python 侧 lock 保证。每 VERIFY_EVERY 轮（默认 6 轮 = 1 小时）做全量 md5 对账。
# 日志：tmp/aime_sync/loop.out、tmp/aime_sync/sync.log
# 状态：tmp/aime_sync/last_round.json、tmp/aime_sync/history.jsonl
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

INTERVAL=${INTERVAL:-600}
VERIFY_EVERY=${VERIFY_EVERY:-6}
STATE=tmp/aime_sync
mkdir -p "$STATE"

echo $$ > "$STATE/loop.pid"
echo "[$(date '+%F %T')] loop start pid=$$ interval=${INTERVAL}s verify_every=${VERIFY_EVERY} mode=mutual(cluster newer-wins, daily/lost U<->V)" >> "$STATE/loop.out"

round=0
while true; do
  round=$((round + 1))
  echo "[$(date '+%F %T')] ---- round #${round} begin ----" >> "$STATE/loop.out"

  # 1) 乌兰 -> 弗吉尼亚：全部任务（daily 输入/输出、cluster、lost、lost_archive）
  #    双向节奏：forward 负责"乌兰更新"的部分；append 类目标更大就跳过，cluster 谁 mtime 新用谁。
  if [ "$VERIFY_EVERY" -gt 0 ] && [ $((round % VERIFY_EVERY)) -eq 0 ]; then
    python3 scripts/sync_aime_ulan_to_va.py --direction forward --only all \
      --skip daily/input,daily/output,lost_archive/input --verify all >> "$STATE/loop.out" 2>&1
  else
    python3 scripts/sync_aime_ulan_to_va.py --direction forward --only all \
      >> "$STATE/loop.out" 2>&1
  fi
  rc1=$?

  # 2) 弗吉尼亚 -> 乌兰：全部任务（双向互补；append 类目标更大就跳过）
  if [ "$VERIFY_EVERY" -gt 0 ] && [ $((round % VERIFY_EVERY)) -eq 0 ]; then
    python3 scripts/sync_aime_ulan_to_va.py --direction reverse --only all \
      --skip daily/input,daily/cluster,lost_archive/input --verify all >> "$STATE/loop.out" 2>&1
  else
    python3 scripts/sync_aime_ulan_to_va.py --direction reverse --only all \
      >> "$STATE/loop.out" 2>&1
  fi
  rc2=$?

  echo "[$(date '+%F %T')] ---- round #${round} end rc=${rc1}/${rc2} ----" >> "$STATE/loop.out"
  sleep "$INTERVAL"
done
