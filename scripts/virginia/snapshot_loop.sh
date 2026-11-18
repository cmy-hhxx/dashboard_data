#!/usr/bin/env bash
# 每隔 SNAPSHOT_INTERVAL 秒把 /opt 快照到 /mnt/aime_eval_ssd/.service_backup/snapshot-*。
#
# 容器重建时 /opt 会回滚（守护脚本、deploy.env、看板产物、5003 索引都在那），持久盘不动，
# 所以定时留一份就能bringup.sh 直接回填，不必重新 deploy + 冷构建。
# 默认：每 2 小时一份，最多保留 12 份（滚动删最旧的）。
#
#   bash /mnt/aime_eval_ssd/.service_backup/snapshot_loop.sh &   # 单实例，flock 挡重复
#   SNAPSHOT_INTERVAL=7200 SNAPSHOT_KEEP=12 ...
set -uo pipefail

SCRIPT=${SNAPSHOT_SCRIPT:-/mnt/aime_eval_ssd/.service_backup/snapshot_remote.sh}
INTERVAL=${SNAPSHOT_INTERVAL:-7200}
LOG=${SNAPSHOT_LOG:-/opt/eval_snapshot.log}

exec 9>/run/eval_snapshot.lock
flock -n 9 || exit 0

log() { printf '%s %s\n' "$(date '+%F %T')" "$*" >> "$LOG"; }
[ -f "$SCRIPT" ] || { log "snapshot script missing: $SCRIPT"; exit 1; }

log "snapshot loop started (pid $$, every ${INTERVAL}s, script $SCRIPT)"
while true; do
  started=$(date +%s)
  if SNAPSHOT_KEEP="${SNAPSHOT_KEEP:-12}" bash "$SCRIPT" >> "$LOG" 2>&1; then
    log "snapshot ok (kept $(ls -1d /mnt/aime_eval_ssd/.service_backup/snapshot-* 2>/dev/null | wc -l))"
  else
    log "snapshot FAILED (see lines above)"
  fi
  # Sleep the remainder of the interval so a slow snapshot does not push the cadence.
  spent=$(( $(date +%s) - started ))
  [ "$spent" -lt "$INTERVAL" ] && sleep $(( INTERVAL - spent ))
done
