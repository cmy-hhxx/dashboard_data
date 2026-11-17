#!/usr/bin/env bash
# 弗吉尼亚容器重启后，把看板（5001）、页面接口（5002）、供数接口（5003）拉起来。
#
#   scripts/virginia/bringup.sh           # 检查 → 按需回填 → 启动 → 冒烟
#   scripts/virginia/bringup.sh --status  # 只看现状，不改任何东西
#
# 设计前提：容器重启后 /opt 可能回滚（守护脚本、部署配置、前端产物、5003 索引都在那），
# 持久盘 /mnt/aime_eval_ssd 不受影响，回填源是 /mnt/aime_eval_ssd/.service_backup/snapshot-*。
# 代码（.py/.js/.css）不备份：/opt 里的代码与本地仓库一致，丢了直接用各自的 deploy.sh 重发。
set -uo pipefail

HOST="${HOST:-aime_rsi_data}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT" || exit 1
SNAP_ROOT=/mnt/aime_eval_ssd/.service_backup
STATUS_ONLY=0
[ "${1:-}" = "--status" ] && STATUS_ONLY=1

SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=10)

# 弗吉尼亚 SSH 边缘会间歇拒绝新连接：所有远端操作共用一条 ControlMaster 长连接。
sshx() { command ssh "${SSH_OPTS[@]}" "$HOST" "$@"; }

log() { printf '[%s] %s\n' "$(date '+%H:%M:%S')" "$*"; }
die() { log "FAILED: $*"; exit 1; }

wait_ssh() {
  local deadline=$((SECONDS + ${1:-300}))
  log "等 SSH（${HOST}）..."
  while [ $SECONDS -lt $deadline ]; do
    if sshx true 2>/dev/null; then
      log "SSH 通了：$(sshx 'hostname' 2>/dev/null)"
      return 0
    fi
    sleep 5
  done
  die "SSH 超过 $((deadline - SECONDS))s 仍不通 —— 可能要等平台把容器拉起来，或 SSH 端口映射变了"
}

check_mount() {
  sshx 'test -d /mnt/aime_eval_ssd/1_aime' || die "持久盘 /mnt/aime_eval_ssd/1_aime 不在（平台挂载没回来）"
  log "持久盘正常：$(sshx 'df -h /mnt/aime_eval_ssd | tail -1' | awk '{print $4" 可用"}')"
}

# 输出一行一个缺失项，空表示啥都没丢
assess() {
  sshx '
    missing=""
    for f in /opt/eval_supervisor.sh /opt/eval_boot.sh /opt/eval_services.conf \
             /opt/eval_dashboard/deploy.env /opt/eval_analysis/deploy.env; do
      [ -f "$f" ] || missing="$missing config:$f"
    done
    [ -f /opt/eval_dashboard/server.py ] || missing="$missing code:/opt/eval_dashboard"
    [ -f /opt/eval_analysis/run.py ]     || missing="$missing code:/opt/eval_analysis"
    [ -f /opt/page_service/sample_details/server.py ] || missing="$missing code:/opt/page_service"
    [ -s /opt/eval_dashboard/static/data-aime.json ]  || missing="$missing payload:dashboard-static"
    [ -s /opt/eval_analysis/state/index.sqlite ]      || missing="$missing payload:analysis-state"
    printf "%s\n" "$missing"
  '
}

latest_snapshot() {
  sshx "ls -1dt $SNAP_ROOT/snapshot-* 2>/dev/null | head -1"
}

restore() {
  local snap="$1" items="$2"
  log "从 $snap 回填："
  case "$items" in *config:*)  log "  - 守护脚本与 deploy.env" ;; esac
  case "$items" in *payload:dashboard-static*) log "  - 看板前端产物（static/，省一次冷构建）" ;; esac
  case "$items" in *payload:analysis-state*)   log "  - 5003 索引与变更流位点（保住 latest_seq）" ;; esac
  sshx "SNAP='$snap' bash -s" <<'REMOTE'
set -uo pipefail
S="$SNAP/config"
mkdir -p /opt/eval_dashboard/static /opt/eval_analysis/state
# --update：只在快照比现有的新时才写，避免覆盖服务已经重新生成的新数据
[ -f "$S/eval_supervisor.sh" ]        && { rsync -a "$S/eval_supervisor.sh" /opt/eval_supervisor.sh; chmod +x /opt/eval_supervisor.sh; }
[ -f "$S/eval_boot.sh" ]              && { rsync -a "$S/eval_boot.sh" /opt/eval_boot.sh; chmod +x /opt/eval_boot.sh; }
[ -f "$S/eval_services.conf" ]        && rsync -a "$S/eval_services.conf" /opt/eval_services.conf
[ -f "$S/eval_dashboard_deploy.env" ] && rsync -a "$S/eval_dashboard_deploy.env" /opt/eval_dashboard/deploy.env
[ -f "$S/eval_analysis_deploy.env" ]  && rsync -a "$S/eval_analysis_deploy.env" /opt/eval_analysis/deploy.env
rsync -a --update "$SNAP/dashboard-static/" /opt/eval_dashboard/static/
rsync -a --update "$SNAP/analysis-state/"   /opt/eval_analysis/state/
echo "[restore] ok"
REMOTE
}

deploy_code() {
  log "远端代码缺失，用本地仓库重发（会 rsync 代码 + 重启该服务）"
  EVAL_DEPLOY_HOST="$HOST" EVAL_DATASETS=/mnt/aime_eval_ssd EVAL_PRODUCTS=aime "$ROOT"/dashboard/deploy.sh \
    || die "dashboard 代码重发失败"
  EVAL_DEPLOY_HOST="$HOST" PORT=5002 "$ROOT"/page_service/sample_details/deploy.sh \
    || die "5002 代码重发失败"
  EVAL_DEPLOY_HOST="$HOST" PORT=5003 REFRESH_SECONDS=3600 EVAL_DATASETS=/mnt/aime_eval_ssd \
    "$ROOT"/interfaces/eval_data_interface/deploy.sh || die "5003 代码重发失败"
}

start_services() {
  log "启动服务（先 5001，再 5002 / 5003）"
  # 5003 的 start.sh 会阻塞等待索引就绪，最多 1800s；这里只要它先监听即可，健康检查单独轮询
  sshx 'set -uo pipefail
    ( cd /opt/eval_dashboard && ./start.sh ) 2>&1 | tail -3
    ( cd /opt/page_service/sample_details && ./start.sh ) 2>&1 | tail -3
    ( cd /opt/eval_analysis && WAIT_SECONDS=15 ./start.sh ) 2>&1 | tail -3
  '
}

wait_health() {
  log "等健康检查（5001 冷构建可能要几分钟）"
  sshx "bash -s" <<'REMOTE'
set -uo pipefail
wait_one() {
  local port=$1 limit=$2 i=0
  while [ "$i" -lt "$limit" ]; do
    code=$(curl -s -m 5 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/healthz" 2>/dev/null || echo 000)
    [ "$code" = "200" ] && { echo "  :$port ready (${i}s)"; return 0; }
    [ "$code" = "503" ] && [ $((i % 30)) -eq 0 ] && echo "  :$port 预热中 (${i}s)"
    sleep 3; i=$((i + 3))
  done
  echo "  :$port 超时未就绪（最后状态 ${code}）"; return 1
}
rc=0
wait_one 5001 300 || rc=1
wait_one 5002 120 || rc=1
wait_one 5003 300 || rc=1
exit $rc
REMOTE
}

supervisor() {
  # 不能 pgrep -f：远端命令行里本身就含 "eval_supervisor.sh"，会自匹配误判成"已在跑"。
  # 直接拉起即可 —— 脚本用 flock 保证单实例，重复调用会自己退出。
  sshx 'nohup /opt/eval_supervisor.sh >> /opt/eval_supervisor.log 2>&1 & sleep 1
    ps -eo pid,args | grep -F "/opt/eval_supervisor.sh" | grep -v grep | head -2' \
    || log "supervisor 没起来（不影响服务，只是少了自愈）"
}

smoke() {
  log "冒烟"
  sshx '
    printf "5001 看板     "; curl -s -m 8 http://127.0.0.1:5001/healthz | head -c 120; echo
    printf "5002 页面接口 "; curl -s -m 8 -o /dev/null -w "%{http_code}\n" http://127.0.0.1:5002/healthz
    printf "5003 供数     "; curl -s -m 8 http://127.0.0.1:5003/healthz | head -c 200; echo
    printf "5003 severity "; curl -s -m 15 "http://127.0.0.1:5003/api/v1/analysis/severity?dataset=aime_eval" \
      | python3 -c "import json,sys; d=json.load(sys.stdin)[\"data\"][\"total\"]; print(d)" 2>/dev/null || echo "未就绪"
  '
  log "对外端口"
  for p in 2475 2476 2477; do
    printf "  10.217.219.2:%s -> %s\n" "$p" "$(curl -s -m 8 -o /dev/null -w '%{http_code}' "http://10.217.219.2:$p/healthz")"
  done
}

main() {
  wait_ssh 300
  check_mount
  local missing snap
  missing=$(assess)
  snap=$(latest_snapshot)
  if [ -z "$missing" ]; then
    log "/opt 完好，无需回填"
  else
    log "缺失：$missing"
    [ -n "$snap" ] || die "没有可用快照（$SNAP_ROOT 为空），只能靠重新 deploy + 冷构建"
    [ "$STATUS_ONLY" = "1" ] && { log "快照可用：${snap}（--status 模式，不动手）"; exit 0; }
    restore "$snap" "$missing"
  fi
  [ "$STATUS_ONLY" = "1" ] && { sshx 'for p in 5001 5002 5003; do printf "  :%s " $p; curl -s -m 5 -o /dev/null -w "%{http_code}\n" http://127.0.0.1:$p/healthz; done'; exit 0; }

  case "$missing" in
    *code:*) deploy_code ;;
  esac
  start_services
  local rc=0
  wait_health || rc=1
  supervisor
  smoke
  log "===== 完成（wait_health rc=${rc}）====="
}

main
