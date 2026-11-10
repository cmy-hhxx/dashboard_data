#!/usr/bin/env bash
# 每 2 小时巡检远端 AIME slim 发布流水线（只读，秒级返回）。
#   bash scripts/patrol_slim_publish.sh          # 人类可读，OK/WARN 返回 0，FAIL 返回 2
#   bash scripts/patrol_slim_publish.sh --json   # 机器可读
# 远端脚本：/mnt/aime_eval_ssd/code/3_scripts/1_slim_publish/check.py
# 弗吉尼亚 SSH 边缘会间歇拒连：复用 ControlMaster 长连接，并对连接失败重试。
set -uo pipefail
HOST=${AIME_SSH:-aime_rsi_data}
REMOTE=/mnt/aime_eval_ssd/code/3_scripts/1_slim_publish
OPTS=(-o BatchMode=yes -o ConnectTimeout=20 -o ServerAliveInterval=30 -o ServerAliveCountMax=4
      -o ControlMaster=auto -o ControlPath=/tmp/ssh-aime-%r@%h:%p -o ControlPersist=10m)

for attempt in 1 2 3 4; do
  out=$(ssh "${OPTS[@]}" "$HOST" "python3 $REMOTE/check.py $*" 2>&1)
  rc=$?
  if [ "$rc" -eq 0 ] || [ "$rc" -eq 2 ]; then    # 巡检成功（FAIL 也照样返回）
    printf '%s\n' "$out"
    exit "$rc"
  fi
  printf '%s\n' "$out" | tail -3 >&2
  echo "（巡检连接失败，重试 $attempt/4）" >&2
  sleep 5
done
echo "巡检失败：无法连接 $HOST" >&2
exit 1
