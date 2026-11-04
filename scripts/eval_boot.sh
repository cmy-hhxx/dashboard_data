#!/usr/bin/env bash
# 容器启动后拉起 eval 守护进程（eval_supervisor.sh）。
# 用法：在平台实例的启动命令末尾追加
#   nohup bash /opt/eval_boot.sh >/dev/null 2>&1 &
# 没有这段的话，容器重启后需要手动执行一次 eval_supervisor.sh。
set -uo pipefail
if pgrep -f '/opt/eval_supervisor\.sh' >/dev/null 2>&1; then
  exit 0
fi
nohup /opt/eval_supervisor.sh >> /opt/eval_supervisor.log 2>&1 &
