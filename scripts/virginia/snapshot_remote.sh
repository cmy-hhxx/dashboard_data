#!/usr/bin/env bash
# 在弗吉尼亚容器内执行：把「容器重建后 /opt 会回滚掉」的东西整份快照到 Ceph 持久盘
#   /mnt/aime_eval_ssd/.service_backup/snapshot-<ts>/opt/
#
# 前提：非 /mnt/aime_eval_ssd 下的东西（/opt、/run、/tmp）都会随容器重建丢失。
# 这里的快照带服务代码、deploy.env 与看板前端产物（不备份 /opt/pgdata，PG 16 由 1_aime/.pg_backup/ 独立容灾），
# 重建后 bringup.sh 恢复 PG 16 并 rsync /opt 回去即可开工，免重新 deploy 与冷构建。
#
# 相邻快照用硬链接（--link-dest）共享没变的文件：12 份大约只占「1 份 + 每次的增量」。
# 只读 /opt，不碰运行中的服务，可重复执行。
set -euo pipefail

DST_ROOT=/mnt/aime_eval_ssd/.service_backup
KEEP=${SNAPSHOT_KEEP:-12}
TS=$(date '+%Y%m%d-%H%M%S')
DST="$DST_ROOT/snapshot-$TS"

# 同一时刻只允许一份快照在跑（定时循环 + 人工执行撞车时，后来的直接退出）
exec 8>/run/eval_snapshot_remote.lock
flock -n 8 || { echo "[snapshot] another snapshot is running, exit"; exit 0; }

PREV=$(ls -1dt "$DST_ROOT"/snapshot-* 2>/dev/null | head -1)
LINK=()
[ -n "$PREV" ] && [ -d "$PREV/opt" ] && LINK=(--link-dest="$PREV/opt")

mkdir -p "$DST/opt"
echo "[snapshot] -> $DST (link-dest ${PREV:-none})"

EXCLUDES=(
  --exclude 'logs/' --exclude '*.log' --exclude '*.pid' --exclude '__pycache__/' --exclude '*.pyc'
  --exclude 'cache/*.tmp' --exclude 'cache/build.lock' --exclude 'cache/build.sqlite3*'
  --exclude 'static/.samples-*' --exclude '.git/' --exclude '*.sock'
  --exclude '.pg_secrets.env' --exclude 'work_ab/'
)

# 平台自带的 /opt/node-v* / python-* / uv-* / nvidia 及 /opt/pgdata 不备份。
ITEMS=(
  eval_dashboard eval_analysis page_service internal_eval_service pg_data_core
  eval_services.conf eval_supervisor.sh eval_boot.sh
  snapshot_remote.sh snapshot_loop.sh
)
for item in "${ITEMS[@]}"; do
  if [ ! -e "/opt/$item" ]; then
    echo "[snapshot] skip missing /opt/$item"
    continue
  fi
  rsync -a "${LINK[@]}" "${EXCLUDES[@]}" "/opt/$item" "$DST/opt/"
done

# build.sqlite3 正在被构建写，直接 rsync 会拿到坏库；用 backup API 导出一份一致的。
python3 - "$DST/opt/eval_dashboard/cache" <<'PY' || echo "[snapshot] sqlite copy failed (kept previous snapshot's? no)"
import os, sqlite3, sys
src = "/opt/eval_dashboard/cache/build.sqlite3"
dst_dir = sys.argv[1]
if not os.path.isfile(src):
    raise SystemExit(0)
os.makedirs(dst_dir, exist_ok=True)
dst = os.path.join(dst_dir, "build.sqlite3")
tmp = dst + ".tmp"
for path in (tmp,):
    if os.path.exists(path):
        os.remove(path)
src_db = sqlite3.connect("file:%s?mode=ro" % src, uri=True, timeout=30)
out = sqlite3.connect(tmp)
try:
    src_db.backup(out)
finally:
    out.close()
    src_db.close()
os.replace(tmp, dst)
print("[snapshot] build.sqlite3 copied (%d MB)" % (os.path.getsize(dst) // 1048576))
PY

# 清单：重启后用它对比「丢了什么」
( cd "$DST" && find . -type f -printf '%s\t%TY-%Tm-%Td %TH:%TM\t%p\n' | sort -k3 > MANIFEST.tsv )
echo "[snapshot] files=$(wc -l < "$DST/MANIFEST.tsv") size=$(du -sh "$DST" | cut -f1)"

# 只保留最近 $KEEP 份（滚动删最旧的）
ls -1dt "$DST_ROOT"/snapshot-* 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -rf
echo "[snapshot] done $DST"
