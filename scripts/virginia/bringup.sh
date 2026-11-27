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
  # 容器重建后 /opt 整目录回滚：PGDATA、代码、deploy.env、看板产物全没了。
  sshx '
    missing=""
    for f in /opt/eval_supervisor.sh /opt/eval_boot.sh /opt/eval_services.conf \
             /opt/eval_dashboard/deploy.env /opt/eval_analysis/deploy.env; do
      [ -f "$f" ] || missing="$missing config:$f"
    done
    [ -f /opt/pg_data_core/pg_data_core/core.py ]             || missing="$missing code:/opt/pg_data_core"
    [ -f /opt/eval_dashboard/server.py ]                      || missing="$missing code:/opt/eval_dashboard"
    [ -f /opt/eval_analysis/run.py ]                          || missing="$missing code:/opt/eval_analysis"
    [ -f /opt/internal_eval_service/internal_eval/config.py ] || missing="$missing code:/opt/internal_eval_service"
    [ -f /opt/page_service/sample_details/server.py ]         || missing="$missing code:/opt/page_service"
    [ -s /opt/eval_dashboard/static/data-aime.json ]          || missing="$missing payload:dashboard-static"
    [ -f /opt/pgdata/PG_VERSION ]                             || missing="$missing pgdata:/opt/pgdata"
    printf "%s\n" "$missing"
  '
}

ensure_postgres() {
  log "检查 PostgreSQL 16（/opt/pgdata）"
  sshx 'set -euo pipefail
    if [ -x /usr/lib/postgresql/16/bin/pg_ctl ] && [ -f /opt/pgdata/PG_VERSION ]; then
      if su - postgres -c "/usr/lib/postgresql/16/bin/pg_ctl -D /opt/pgdata status" >/dev/null 2>&1; then
        echo "[pg] already running"
      else
        echo "[pg] starting existing /opt/pgdata"
        AIME_DATA_ROOT=/mnt/aime_eval_ssd/1_aime bash /opt/pg_data_core/scripts/pg_init_cluster.sh
      fi
      if ! pgrep -f "[p]g_maintenance_loop\.sh" >/dev/null 2>&1; then
        nohup bash /opt/pg_data_core/scripts/pg_maintenance_loop.sh >> /opt/pg_data_core/maintenance.log 2>&1 &
      fi
    else
      echo "[pg] /opt/pgdata 或 PG 16 缺失，执行 PITR + reconcile_tails 一键恢复..."
      AIME_DATA_ROOT=/mnt/aime_eval_ssd/1_aime bash /mnt/aime_eval_ssd/.service_backup/pg_data_core/scripts/pg_rebuild_restore.sh
    fi
  ' || die "PostgreSQL 16 恢复/启动失败"
}

latest_snapshot() {
  sshx "ls -1dt $SNAP_ROOT/snapshot-* 2>/dev/null | head -1"
}

restore() {
  local snap="$1" items="$2"
  if sshx "test -d '$snap/opt'"; then
    # 整棵 /opt（代码 + deploy.env + 产物 + cache + 5003 索引），--update 只补缺的/旧的
    log "从 ${snap}/opt 回填 /opt（缺失：${items}）"
    sshx "rsync -a --update '$snap/opt/' /opt/ && echo '[restore] opt tree ok'"
    return 0
  fi
  log "从 $snap 回填（旧版快照布局）："
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

install_scripts() {
  # 快照/守护脚本放在持久盘（容器重建只回滚 /opt），再拷一份到 /opt 供 supervisor 启动。
  log "同步快照与守护脚本"
  rsync -a -e "ssh ${SSH_OPTS[*]}" \
    "$ROOT/scripts/virginia/snapshot_remote.sh" "$ROOT/scripts/virginia/snapshot_loop.sh" \
    "$ROOT/scripts/eval_supervisor.sh" "$ROOT/scripts/eval_boot.sh" \
    "$HOST:$SNAP_ROOT/" || log "脚本同步失败（继续）"
  sshx 'cp /mnt/aime_eval_ssd/.service_backup/snapshot_remote.sh /opt/ 2>/dev/null
    cp /mnt/aime_eval_ssd/.service_backup/eval_supervisor.sh /opt/ 2>/dev/null
    cp /mnt/aime_eval_ssd/.service_backup/eval_boot.sh /opt/ 2>/dev/null
    chmod +x /opt/snapshot_remote.sh /opt/eval_supervisor.sh /opt/eval_boot.sh 2>/dev/null; true'
}

start_snapshot_loop() {
  log "拉起定时快照（每 2 小时一份，保留 12 份）"
  sshx 'nohup bash /mnt/aime_eval_ssd/.service_backup/snapshot_loop.sh >> /opt/eval_snapshot.log 2>&1 & sleep 1
    pgrep -f "[s]napshot_loop\.sh" | head -1' || log "定时快照没起来（supervisor 会再拉）"
}

deploy_code() {
  log "远端代码缺失，用本地仓库重发（会 rsync 代码 + 重启该服务）"
  "$ROOT"/pg_data_core/deploy.sh || die "pg_data_core 代码重发失败"
  EVAL_DEPLOY_HOST="$HOST" EVAL_DATASETS=/mnt/aime_eval_ssd EVAL_PRODUCTS=aime \
    EVAL_STORAGE_BACKEND=pg AIME_DATA_ROOT=/mnt/aime_eval_ssd/1_aime \
    AIME_PG_SECRETS_FILE=/opt/pg_data_core/.pg_secrets.env PG_DATA_CORE_PATH=/opt/pg_data_core \
    STATS_WORKER=0 BACKUP_STATS=0 "$ROOT"/dashboard/deploy.sh \
    || die "dashboard 代码重发失败"
  EVAL_DEPLOY_HOST="$HOST" PORT=5002 "$ROOT"/page_service/sample_details/deploy.sh \
    || die "5002 代码重发失败"
  EVAL_DEPLOY_HOST="$HOST" PORT=5003 REFRESH_SECONDS=3600 EVAL_DATASETS=/mnt/aime_eval_ssd \
    ANALYSIS_DATASET=aime_eval ANALYSIS_BACKEND=pg INTERNAL_EVAL_BACKEND=pg \
    AIME_DATA_ROOT=/mnt/aime_eval_ssd/1_aime AIME_PG_SECRETS_FILE=/opt/pg_data_core/.pg_secrets.env \
    PG_DATA_CORE_PATH=/opt/pg_data_core "$ROOT"/interfaces/eval_data_interface/deploy.sh \
    || die "5003 代码重发失败"
  EVAL_DEPLOY_HOST="$HOST" PORT=5003 "$ROOT"/interfaces/internal_eval_service_interface/deploy.sh \
    || die "internal_eval 代码重发失败"
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
    printf "PG 16         "; su - postgres -c "/usr/lib/postgresql/16/bin/pg_isready -h 127.0.0.1 -p 5432" || echo "未就绪"
    printf "5001 看板     "; curl -s -m 8 http://127.0.0.1:5001/healthz | head -c 160; echo
    printf "5002 页面接口 "; curl -s -m 8 -o /dev/null -w "%{http_code}\n" http://127.0.0.1:5002/healthz
    printf "5003 供数     "; curl -s -m 8 http://127.0.0.1:5003/healthz | head -c 200; echo
    printf "5003 DataCore "; curl -s -m 8 http://127.0.0.1:5003/api/v1/data-core/health | head -c 160; echo
    printf "5003 IntEval  "; curl -s -m 8 http://127.0.0.1:5003/api/v1/internal-eval/healthz | head -c 160; echo
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
    log "/opt 与 PG 完好，无需回填"
  else
    log "缺失：$missing"
    if [ "$STATUS_ONLY" = "1" ]; then
      log "快照可用：${snap:-无}（--status 模式，不动手）"
      exit 0
    fi
    [ -n "$snap" ] && restore "$snap" "$missing"
  fi
  [ "$STATUS_ONLY" = "1" ] && { sshx 'for p in 5001 5002 5003; do printf "  :%s " $p; curl -s -m 5 -o /dev/null -w "%{http_code}\n" http://127.0.0.1:$p/healthz; done'; exit 0; }

  install_scripts
  ensure_postgres
  # 快照里已有代码就不再 deploy（省时间）；回填后仍缺才走远端重发。
  missing=$(assess)
  [ -n "$missing" ] && log "回填后仍缺：$missing"
  case "$missing" in
    *code:*) deploy_code ;;
  esac
  start_services
  local rc=0
  wait_health || rc=1
  supervisor
  start_snapshot_loop
  smoke
  log "===== 完成（wait_health rc=${rc}）====="
}

main
