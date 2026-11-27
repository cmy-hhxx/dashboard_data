#!/usr/bin/env bash
# Background maintenance loop for AIME PostgreSQL 16:
# - Every 5 minutes: REFRESH MATERIALIZED VIEW CONCURRENTLY for all 3 stats views + endpoint heartbeat
# - Every 24 hours: compressed pg_basebackup to ${AIME_DATA_ROOT}/.pg_backup/base/
set -euo pipefail

LOCK_FILE="/tmp/aime_pg_maintenance.lock"
exec 9>"${LOCK_FILE}"
if ! flock -n 9; then
    echo "[pg_maintenance_loop] already running, exiting."
    exit 0
fi

SECRETS_FILE="${AIME_PG_SECRETS_FILE:-/opt/pg_data_core/.pg_secrets.env}"
MV_INTERVAL="${PG_MV_REFRESH_INTERVAL_SEC:-300}"
BACKUP_INTERVAL="${PG_BASEBACKUP_INTERVAL_SEC:-86400}"
LAST_BACKUP_TS=0

while true; do
    if [[ -f "${SECRETS_FILE}" ]]; then
        # shellcheck disable=SC1090
        source "${SECRETS_FILE}"
    fi
    NOW="$(date +%s)"

    # Refresh materialized views concurrently (non-blocking)
    PYTHONPATH=/opt/pg_data_core python3 -c "
from pg_data_core.config import load_config, write_endpoint_json
from pg_data_core.core import DataCore
import socket
cfg = load_config(role='admin')
with DataCore(cfg) as dc:
    dc.refresh_stats_views(concurrently=True)
pod_ip = socket.gethostbyname(socket.gethostname())
write_endpoint_json(cfg.data_root, host=pod_ip, port=cfg.pg_port, database=cfg.pg_database, db_epoch=cfg.db_epoch)
" 2>&1 | sed 's/^/[mv_refresh] /' || true

    # Daily compressed pg_basebackup
    if (( NOW - LAST_BACKUP_TS >= BACKUP_INTERVAL )); then
        if bash /opt/pg_data_core/scripts/pg_basebackup.sh 2>&1 | sed 's/^/[basebackup] /'; then
            LAST_BACKUP_TS="${NOW}"
        fi
    fi

    sleep "${MV_INTERVAL}"
done
