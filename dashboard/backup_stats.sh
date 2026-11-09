#!/usr/bin/env bash
# Start/stop the hourly stats + index backup worker.
#
# It is AIME-production only by default: the destination is the AIME stats area
# and the staging copy (/opt/eval_dashboard_2, PORT=5004) must not run a second
# writer.  Override with BACKUP_STATS_FORCE=1 when testing.
#
# Usage:
#   ./backup_stats.sh start|stop|status|restart|run
#   BACKUP_STATS_DEST=/tmp/stats FORCE=1 ./backup_stats.sh start
set -euo pipefail
cd "$(dirname "$0")"
if [ -f deploy.env ]; then . ./deploy.env; fi

PIDFILE="backup_stats.pid"
LOGFILE="logs/backup-stats.log"
DEST="${BACKUP_STATS_DEST:-/mnt/aime_eval_ssd/1_aime/stats}"
INTERVAL="${BACKUP_STATS_INTERVAL:-3600}"
KEEP="${BACKUP_STATS_KEEP:-12}"
DATASETS="${EVAL_DATASETS:-/mnt/aime_eval_ssd}"
FORCE="${BACKUP_STATS_FORCE:-0}"

is_running() {
  [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE" 2>/dev/null)" 2>/dev/null
}

skip_reason() {
  if [ "$FORCE" != "1" ]; then
    case ",${EVAL_PRODUCTS:-}," in
      *,aime,*) ;;
      *) echo "EVAL_PRODUCTS=${EVAL_PRODUCTS:-unset}"; return 0 ;;
    esac
    if [ "${PORT:-5001}" != "5001" ]; then
      echo "PORT=${PORT:-5001} (not the production copy)"; return 0
    fi
  fi
  if [ ! -d "$DATASETS" ]; then
    echo "dataset root missing: $DATASETS"; return 0
  fi
  if [ ! -d "$(dirname "$DEST")/.." ]; then
    echo "backup mount missing: $(dirname "$DEST")/.."; return 0
  fi
  return 1
}

case "${1:-start}" in
  start)
    if is_running; then
      echo "backup_stats already running (pid $(cat "$PIDFILE"))"
      exit 0
    fi
    reason="$(skip_reason || true)"
    if [ -n "$reason" ]; then
      echo "backup_stats skipped: $reason"
      exit 0
    fi
    mkdir -p logs "$DEST"
    rm -f "$PIDFILE"
    nohup python3 backup_stats.py \
      --datasets "$DATASETS" --dest "$DEST" \
      --interval "$INTERVAL" --keep "$KEEP" >> "$LOGFILE" 2>&1 &
    echo $! > "$PIDFILE"
    sleep 1
    if ! is_running; then
      rm -f "$PIDFILE"
      echo "backup_stats failed to start; see $LOGFILE" >&2
      exit 1
    fi
    echo "backup_stats started (pid $(cat "$PIDFILE")) -> $DEST"
    ;;
  stop)
    if is_running; then
      pid="$(cat "$PIDFILE")"
      kill "$pid" 2>/dev/null || true
      for _ in $(seq 1 50); do
        kill -0 "$pid" 2>/dev/null || break
        sleep 0.1
      done
      kill -9 "$pid" 2>/dev/null || true
      echo "backup_stats stopped"
    else
      echo "backup_stats not running"
    fi
    rm -f "$PIDFILE"
    ;;
  restart)
    "$0" stop
    "$0" start
    ;;
  status)
    if is_running; then
      echo "backup_stats running (pid $(cat "$PIDFILE")) -> $DEST"
    else
      echo "backup_stats stopped"
      exit 1
    fi
    ;;
  run)
    mkdir -p "$DEST"
    exec python3 backup_stats.py --datasets "$DATASETS" --dest "$DEST" --keep "$KEEP" --once
    ;;
  *)
    echo "usage: $0 start|stop|status|restart|run" >&2
    exit 2
    ;;
esac
