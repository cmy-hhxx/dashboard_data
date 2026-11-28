#!/usr/bin/env bash
# Keep the eval services alive.
#
#   /opt/eval_services.conf   one service per line:
#       name|health_url|workdir|start_cmd
#   /opt/eval_supervisor.log  this script's log
#   /opt/eval_supervisor.pause  when present, checks are skipped (maintenance / deploy window)
#
# Start (idempotent - flock keeps a single instance):
#   nohup /opt/eval_supervisor.sh >> /opt/eval_supervisor.log 2>&1 &
#
# It only restarts a service whose /healthz stops answering; it never kills a live one,
# so a deploy's stop/start is not fought over. Services that are meant to stay down
# (e.g. 乌兰 :5003) are simply not listed in the config.
set -uo pipefail

CONF=${1:-/opt/eval_services.conf}
LOG=${LOG:-/opt/eval_supervisor.log}
INTERVAL=${INTERVAL:-30}
PAUSE=${PAUSE:-/opt/eval_supervisor.pause}
# 定时快照（每 2 小时一份到持久盘，只留 12 份）：丢了就拉起来，脚本自己 flock 单实例。
SNAPSHOT_LOOP=${SNAPSHOT_LOOP:-/mnt/aime_eval_ssd/.service_backup/snapshot_loop.sh}
SNAPSHOT_LOG=${SNAPSHOT_LOG:-/opt/eval_snapshot.log}

log() { printf '%s %s\n' "$(date '+%F %T')" "$*" >> "$LOG"; }

[ -f "$CONF" ] || { log "config missing: $CONF"; exit 1; }
exec 9>/run/eval_supervisor.lock
flock -n 9 || { log "another instance is running, exit"; exit 0; }

log "supervisor started (pid $$, interval ${INTERVAL}s, conf $CONF)"
declare -A FAILS=()

while true; do
  if [ -f "$PAUSE" ]; then
    sleep "$INTERVAL"
    continue
  fi
  while IFS='|' read -r name url dir cmd; do
    case "$name" in ''|'#'*) continue ;; esac
    if curl -fsS -m 8 -o /dev/null "$url" 2>/dev/null; then
      if [ "${FAILS[$name]:-0}" -gt 0 ]; then log "$name healthy again"; fi
      FAILS[$name]=0
      continue
    fi
    n=$(( ${FAILS[$name]:-0} + 1 ))
    FAILS[$name]=$n
    if [ "$n" -gt 5 ]; then
      log "$name still down ($url, consecutive $n); backoff"
      sleep 60
      continue
    fi
    log "$name down ($url), start: (cd $dir && $cmd)"
    # 9>&-: the lock fd must not leak into the service, or the flock stays held after
    # this supervisor dies and the next one refuses to start ("another instance is running").
    ( cd "$dir" && timeout 300 bash -c "$cmd" ) 9>&- >> "$LOG" 2>&1
    sleep 5
    if curl -fsS -m 8 -o /dev/null "$url" 2>/dev/null; then
      log "$name recovered"
      FAILS[$name]=0
    else
      log "$name start failed (consecutive $n)"
    fi
  done < "$CONF"
  if [ -f "$SNAPSHOT_LOOP" ] && ! pgrep -f '[s]napshot_loop\.sh' >/dev/null 2>&1; then
    log "snapshot loop missing, starting $SNAPSHOT_LOOP"
    nohup bash "$SNAPSHOT_LOOP" >> "$SNAPSHOT_LOG" 2>&1 9>&- &
  fi
  if [ -f /opt/pg_data_core/scripts/pg_maintenance_loop.sh ] && ! pgrep -f '[p]g_maintenance_loop\.sh' >/dev/null 2>&1; then
    log "pg_maintenance_loop missing, starting"
    nohup bash /opt/pg_data_core/scripts/pg_maintenance_loop.sh >> /opt/pg_data_core/maintenance.log 2>&1 9>&- &
  fi
  if [ -f /opt/检验任务.py ] && ! pgrep -f '[/]opt/检验任务\.py' >/dev/null 2>&1; then
    log "检验任务 missing, starting"
    nohup python3 /opt/检验任务.py --max-cores 1.5 >> /opt/检验任务.log 2>&1 9>&- &
  fi
  sleep "$INTERVAL"
done
