#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$DIR")"
LOG_DIR="${HUMAN_READ_LOG_DIR:-$DIR/logs}"
PID_FILE="$LOG_DIR/human_read.pid"
mkdir -p "$LOG_DIR"

# 网关 key 放在仓库外的 $ROOT/human_read.env（chmod 600），仓库里不留密钥。
if [ -f "$ROOT/human_read.env" ]; then
  set -a
  . "$ROOT/human_read.env"
  set +a
fi

if [ -f "$PID_FILE" ]; then
  OLD_PID="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    echo "human_read daemon already running (pid=$OLD_PID)"
    exit 0
  fi
  rm -f "$PID_FILE"
fi

INTERVAL="${HUMAN_READ_INTERVAL:-300}"
DATA_ROOT="${HUMAN_READ_DATA_ROOT:-/mnt/aime_eval_ssd/1_aime}"
CONFIG_PATH="${HUMAN_READ_CONFIG:-$DATA_ROOT/eval_output/human_read/.state/runtime_config.json}"
EXTRA_ARGS="${HUMAN_READ_EXTRA_ARGS:---include-ab}"

cd "$ROOT"
nohup python3 -u -m human_read_module.runner \
  --data-root "$DATA_ROOT" \
  --config "$CONFIG_PATH" \
  --daemon \
  --interval "$INTERVAL" \
  $EXTRA_ARGS \
  >> "$LOG_DIR/daemon.log" 2>&1 < /dev/null &

NEW_PID=$!
echo "$NEW_PID" > "$PID_FILE"
echo "Started human_read daemon (pid=$NEW_PID, config=$CONFIG_PATH, interval=${INTERVAL}s, log=$LOG_DIR/daemon.log)"
