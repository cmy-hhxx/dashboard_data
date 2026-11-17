#!/usr/bin/env bash
# 在弗吉尼亚容器内执行：把「丢了要几分钟才能重建」的东西快照到 Ceph 持久盘
#   /mnt/aime_eval_ssd/.service_backup/snapshot-<ts>/
# 只读 /opt，不碰运行中的服务。可重复执行（每份快照一个时间戳目录）。
set -euo pipefail

DST_ROOT=/mnt/aime_eval_ssd/.service_backup
TS=$(date '+%Y%m%d-%H%M%S')
DST="$DST_ROOT/snapshot-$TS"
mkdir -p "$DST"/{config,dashboard-static,analysis-state}

echo "[snapshot] -> $DST"

# 1) 部署配置与守护脚本（/opt 是容器重建就会回滚的地方）
for f in /opt/eval_supervisor.sh /opt/eval_boot.sh /opt/eval_services.conf \
         /opt/eval_dashboard/deploy.env /opt/eval_analysis/deploy.env \
         /opt/page_service/sample_details/deploy.env; do
  [ -f "$f" ] || { echo "[snapshot] skip missing $f"; continue; }
  rsync -a "$f" "$DST/config/$(echo "${f#/opt/}" | tr '/' '_')"
done

# 2) 看板前端产物（直接可服务，省掉一次冷构建）
rsync -a /opt/eval_dashboard/static/ "$DST/dashboard-static/"

# 3) 5003 供数索引 + 变更流位点（cursor.key 丢了 latest_seq 归零，业务方会收到 409 SYNC_RESET）
rsync -a /opt/eval_analysis/state/ "$DST/analysis-state/"

# 4) 清单：重启后用它对比「丢了什么」
( cd "$DST" && find . -type f -printf '%s\t%TY-%Tm-%Td %TH:%TM\t%p\n' | sort -k3 > MANIFEST.tsv )
echo "[snapshot] files=$(wc -l < "$DST/MANIFEST.tsv") size=$(du -sh "$DST" | cut -f1)"

# 只保留最近 3 份
ls -1dt "$DST_ROOT"/snapshot-* 2>/dev/null | tail -n +4 | xargs -r rm -rf
echo "[snapshot] done $DST"
