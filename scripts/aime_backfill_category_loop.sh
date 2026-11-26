#!/usr/bin/env bash
# 分类字段补数循环（只用埋点接口；旧的 category_meta.json 不再参与）
#   每 24 小时（每 3 轮的第 1 轮）：全量扫一遍所有文件，把所有「没有标签」的 trace 都查一遍
#   每 8 小时（另两轮）：只重查待补队列（不扫文件，约 15 秒）
# 不往对话发消息，产出写 cache/aime_backfill_category/{api_loop.log,api_yield.jsonl}
set -uo pipefail
BASE=/mnt/aime_eval_ssd
DIR=$BASE/code/3_scripts
CACHE=$DIR/cache/aime_backfill_category
mkdir -p "$CACHE"
exec 9>"$CACHE/loop.lock"
flock -n 9 || { echo "$(date '+%F %T') 另一个 loop 在跑，退出" >&2; exit 0; }
ROUND=1
while true; do
  TS=$(date '+%F %T')
  if [ $((ROUND % 3)) -eq 1 ]; then
    echo "[$TS] ==== 第 $ROUND 轮：全量扫所有未标注 trace ===="
    python3 "$DIR/aime_backfill_category_api.py" --local --since 2026-09-01 2>&1 | tail -5
  else
    echo "[$TS] ==== 第 $ROUND 轮：重查待补队列 ===="
    python3 "$DIR/aime_backfill_category_api.py" --local --retry 2>&1 | tail -4
  fi
  ROUND=$((ROUND+1))
  sleep 28800 9>&-
done
