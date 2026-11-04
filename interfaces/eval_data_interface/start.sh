#!/usr/bin/env bash
# 启动对话分析查询接口（nohup + pidfile）。
#
# 进程会立刻监听端口，索引在后台构建；/healthz 在构建完成前返回 ok=false。
# 本脚本最多等待 WAIT_SECONDS（默认 1800 秒）直到索引就绪。
set -euo pipefail

cd "$(dirname "$0")"

# 部署时写入的设置（数据根、端口、刷新间隔等）
if [ -f deploy.env ]; then . ./deploy.env; fi

PORT="${PORT:-5003}"
HOST="${HOST:-0.0.0.0}"
PYTHON="${PYTHON:-python3}"
PIDFILE="${PIDFILE:-server.pid}"
LOGDIR="${LOGDIR:-logs}"
WAIT_SECONDS="${WAIT_SECONDS:-1800}"
HEALTH_URL="http://127.0.0.1:${PORT}/healthz"

mkdir -p "$LOGDIR"

if curl -fsS -m 2 "$HEALTH_URL" 2>/dev/null | grep -q '"ok":true'; then
  echo "already serving on :${PORT}"
  exit 0
fi

if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  echo "pid $(cat "$PIDFILE") 仍在运行但尚未就绪，继续等待"
else
  nohup "$PYTHON" run.py serve --host "$HOST" --port "$PORT" >>"$LOGDIR/server.log" 2>&1 &
  echo $! >"$PIDFILE"
  echo "started pid $(cat "$PIDFILE") on :${PORT}"
fi

waited=0
while [ "$waited" -lt "$WAIT_SECONDS" ]; do
  if curl -fsS -m 2 "$HEALTH_URL" 2>/dev/null | grep -q '"ok":true'; then
    echo "ready on :${PORT} after ${waited}s"
    exit 0
  fi
  if [ $((waited % 60)) -eq 0 ] && [ "$waited" -gt 0 ]; then
    echo "  still building (${waited}s) ..."
  fi
  sleep 5
  waited=$((waited + 5))
  if [ -f "$PIDFILE" ] && ! kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
    echo "进程已退出，最近日志："
    tail -n 30 "$LOGDIR/server.log" || true
    exit 1
  fi
done

echo "等待超时（${WAIT_SECONDS}s），最近日志："
tail -n 30 "$LOGDIR/server.log" || true
exit 1
