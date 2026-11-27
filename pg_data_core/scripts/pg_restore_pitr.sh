#!/usr/bin/env bash
# Restore PostgreSQL 16 from .pg_backup/base/latest + .pg_backup/wal/*.zst (PITR)
# Usage: pg_restore_pitr.sh [target_pgdata] [target_port] [recovery_target_time_utc]
set -euo pipefail

PG_BIN="/usr/lib/postgresql/16/bin"
TARGET_PGDATA="${1:-/opt/pgdata}"
TARGET_PORT="${2:-5432}"
TARGET_TIME="${3:-}"
AIME_DATA_ROOT="${AIME_DATA_ROOT:-/mnt/aime_eval_ssd/1_aime}"
BASE_DIR="${AIME_DATA_ROOT}/.pg_backup/base/latest"
WAL_DIR="${AIME_DATA_ROOT}/.pg_backup/wal"

if [[ "${TARGET_PGDATA}" == /mnt/aime_eval_ssd* ]]; then
    echo "ERROR: TARGET_PGDATA (${TARGET_PGDATA}) must be on local disk, NOT CephFS!" >&2
    exit 1
fi

if [[ ! -f "${BASE_DIR}/base.tar.zst" ]]; then
    echo "ERROR: base backup not found at ${BASE_DIR}/base.tar.zst" >&2
    exit 1
fi

# Stop any instance already running on TARGET_PGDATA
if [[ -f "${TARGET_PGDATA}/postmaster.pid" ]]; then
    su - postgres -c "${PG_BIN}/pg_ctl -D '${TARGET_PGDATA}' -m fast stop" || true
fi

rm -rf "${TARGET_PGDATA}"
mkdir -p "${TARGET_PGDATA}"
zstd -dc "${BASE_DIR}/base.tar.zst" | tar -xf - -C "${TARGET_PGDATA}"

# Write recovery configuration (disable archiving during restore to avoid polluting prod WAL)
mkdir -p "${TARGET_PGDATA}/conf.d"
cat > "${TARGET_PGDATA}/conf.d/recovery.conf" <<EOF
port = ${TARGET_PORT}
archive_mode = off
restore_command = 'zstd -dc ${WAL_DIR}/%f.zst > %p'
recovery_target_action = 'promote'
EOF

if [[ -n "${TARGET_TIME}" ]]; then
    echo "recovery_target_time = '${TARGET_TIME}'" >> "${TARGET_PGDATA}/conf.d/recovery.conf"
fi

touch "${TARGET_PGDATA}/recovery.signal"
chown -R postgres:postgres "${TARGET_PGDATA}"
chmod 700 "${TARGET_PGDATA}"

su - postgres -c "${PG_BIN}/pg_ctl -D '${TARGET_PGDATA}' -l '${TARGET_PGDATA}/pg_restore.log' -w start"

# Wait until recovery completes and PG promotes to read-write
for _ in $(seq 1 60); do
    IN_REC="$(su - postgres -c "${PG_BIN}/psql -p ${TARGET_PORT} -tAc 'SELECT pg_is_in_recovery()'" 2>/dev/null || echo t)"
    if [[ "${IN_REC}" == "f" ]]; then
        echo "[pg_restore_pitr] Recovery complete & promoted on port ${TARGET_PORT} (${TARGET_PGDATA})"
        exit 0
    fi
    sleep 1
done

echo "ERROR: PostgreSQL remained in recovery after 60s" >&2
exit 1
