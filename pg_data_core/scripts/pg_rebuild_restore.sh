#!/usr/bin/env bash
# One-command PostgreSQL 16 container-rebuild recovery:
# 1. Installs PG 16 + zstd + Python psycopg/zstandard if container was rebuilt.
# 2. Restores /opt/pgdata from ${AIME_DATA_ROOT}/.pg_backup/base/latest + wal/*.zst (PITR).
# 3. Re-applies conf.d/aime.conf (re-enabling 60s WAL archiving) and refreshes .runtime/pg_endpoint.json.
# 4. Runs reconcile_tails() to self-heal any Blob-First tail frames written after last WAL.
# 5. Launches pg_maintenance_loop.sh (5-min MV refresh + daily basebackup).
set -euo pipefail

AIME_DATA_ROOT="${AIME_DATA_ROOT:-/mnt/aime_eval_ssd/1_aime}"
PGDATA="${AIME_PGDATA:-/opt/pgdata}"
PG_PORT="${AIME_PG_PORT:-5432}"
BACKUP_CODE="/mnt/aime_eval_ssd/.service_backup/pg_data_core"
SECRETS_BACKUP="/mnt/aime_eval_ssd/.service_backup/pg_secrets.env"

export DEBIAN_FRONTEND=noninteractive

# 1. Restore /opt/pg_data_core code & secrets if wiped by container rebuild
if [[ ! -d /opt/pg_data_core/pg_data_core && -d "${BACKUP_CODE}" ]]; then
    mkdir -p /opt/pg_data_core
    rsync -a "${BACKUP_CODE}/" /opt/pg_data_core/
    chmod +x /opt/pg_data_core/scripts/*.sh
fi
if [[ ! -f /opt/pg_data_core/.pg_secrets.env && -f "${SECRETS_BACKUP}" ]]; then
    cp "${SECRETS_BACKUP}" /opt/pg_data_core/.pg_secrets.env
    chmod 600 /opt/pg_data_core/.pg_secrets.env
fi

# 2. Install PostgreSQL 16 & Python drivers if missing
if [[ ! -x /usr/lib/postgresql/16/bin/postgres ]]; then
    mkdir -p /etc/apt/keyrings
    curl -fsSL https://mirrors.aliyun.com/postgresql/repos/apt/ACCC4CF8.asc | gpg --dearmor -o /etc/apt/keyrings/pgdg.gpg
    echo "deb [signed-by=/etc/apt/keyrings/pgdg.gpg] https://mirrors.aliyun.com/postgresql/repos/apt jammy-pgdg main" > /etc/apt/sources.list.d/pgdg.list
    apt-get update -qq
    apt-get install -y -qq postgresql-16 postgresql-contrib-16 zstd lz4
    [[ -d /var/lib/postgresql/16/main ]] && pg_dropcluster --stop 16 main || true
fi
python3 -c "import psycopg, psycopg_pool, zstandard" 2>/dev/null || \
    pip3 install --quiet --upgrade "psycopg[binary,pool]>=3.2" "zstandard>=0.23" tzdata

# 3. PITR restore into /opt/pgdata (or start existing /opt/pgdata)
if [[ ! -f "${PGDATA}/PG_VERSION" ]]; then
    bash /opt/pg_data_core/scripts/pg_restore_pitr.sh "${PGDATA}" "${PG_PORT}"
    rm -f "${PGDATA}/conf.d/recovery.conf"
fi

# 4. Re-apply production conf, re-enable WAL archiving & publish .runtime/pg_endpoint.json
bash /opt/pg_data_core/scripts/pg_init_cluster.sh

# 5. Idempotent tail reconciliation (self-heals any blobs written after last archived WAL)
source /opt/pg_data_core/.pg_secrets.env
PYTHONPATH=/opt/pg_data_core python3 -c "
from pg_data_core.config import load_config
from pg_data_core.core import DataCore
from pg_data_core.reconcile import reconcile_tails
with DataCore(load_config(role='rw')) as dc:
    print('[pg_rebuild_restore] reconcile_tails:', reconcile_tails(dc, lookback_minutes=120))
"

# 6. Start maintenance loop (flock single-instance)
nohup bash /opt/pg_data_core/scripts/pg_maintenance_loop.sh >> /opt/pg_data_core/maintenance.log 2>&1 &
echo "[pg_rebuild_restore] PostgreSQL 16 fully recovered and maintenance loop running."
