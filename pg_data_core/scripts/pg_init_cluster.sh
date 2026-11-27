#!/usr/bin/env bash
# Idempotent PostgreSQL 16 initialization at /opt/pgdata (local fast disk ONLY).
# Generates strong random scram-sha-256 credentials into 0600 secrets file,
# configures 60s compressed WAL archiving, starts PG 16, and writes .runtime/pg_endpoint.json.
set -euo pipefail

PG_BIN="/usr/lib/postgresql/16/bin"
PGDATA="${AIME_PGDATA:-/opt/pgdata}"
AIME_DATA_ROOT="${AIME_DATA_ROOT:-/mnt/aime_eval_ssd/1_aime}"
SECRETS_FILE="${AIME_PG_SECRETS_FILE:-/opt/pg_data_core/.pg_secrets.env}"
SECRETS_BACKUP="/mnt/aime_eval_ssd/.service_backup/pg_secrets.env"
PG_PORT="${AIME_PG_PORT:-5432}"
PG_DB="${AIME_PG_DATABASE:-aime_eval}"

# Guardrail: NEVER run PGDATA on CephFS
if [[ "${PGDATA}" == /mnt/aime_eval_ssd* ]]; then
    echo "ERROR: PGDATA (${PGDATA}) must NEVER be placed on CephFS!" >&2
    exit 1
fi

mkdir -p "$(dirname "${SECRETS_FILE}")" "$(dirname "${SECRETS_BACKUP}")" \
    "${AIME_DATA_ROOT}/.pg_backup/base" "${AIME_DATA_ROOT}/.pg_backup/wal" \
    "${AIME_DATA_ROOT}/.runtime"

# Restore secrets from backup on container rebuild if local file missing
if [[ ! -f "${SECRETS_FILE}" && -f "${SECRETS_BACKUP}" ]]; then
    cp "${SECRETS_BACKUP}" "${SECRETS_FILE}"
    chmod 600 "${SECRETS_FILE}"
fi

# Generate strong secrets once
if [[ ! -f "${SECRETS_FILE}" ]]; then
    gen_pw() { python3 -c "import secrets; print(secrets.token_urlsafe(24))"; }
    DB_EPOCH="$(python3 -c "import uuid; print(uuid.uuid4().hex[:16])")"
    cat > "${SECRETS_FILE}" <<EOF
# Auto-generated PostgreSQL 16 credentials (chmod 600, NEVER commit)
export AIME_DATA_ROOT="${AIME_DATA_ROOT}"
export AIME_PGDATA="${PGDATA}"
export AIME_PG_HOST="127.0.0.1"
export AIME_PG_PORT="${PG_PORT}"
export AIME_PG_DATABASE="${PG_DB}"
export AIME_DB_EPOCH="${DB_EPOCH}"
export AIME_PG_ADMIN_USER="aime_admin"
export AIME_PG_ADMIN_PASSWORD="$(gen_pw)"
export AIME_PG_RW_USER="aime_rw"
export AIME_PG_RW_PASSWORD="$(gen_pw)"
export AIME_PG_RO_USER="aime_ro"
export AIME_PG_RO_PASSWORD="$(gen_pw)"
export AIME_PG_BACKUP_USER="aime_backup"
export AIME_PG_BACKUP_PASSWORD="$(gen_pw)"
EOF
    chmod 600 "${SECRETS_FILE}"
    cp "${SECRETS_FILE}" "${SECRETS_BACKUP}"
    chmod 600 "${SECRETS_BACKUP}"
fi

# shellcheck disable=SC1090
source "${SECRETS_FILE}"

# Initialize /opt/pgdata if empty
if [[ ! -f "${PGDATA}/PG_VERSION" ]]; then
    mkdir -p "${PGDATA}"
    chown -R postgres:postgres "${PGDATA}"
    chmod 700 "${PGDATA}"
    su - postgres -c "${PG_BIN}/initdb -D '${PGDATA}' --encoding=UTF8 --locale=C.UTF-8 --data-checksums --auth-local=peer --auth-host=scram-sha-256"
fi

# Ensure conf.d include and write tuned aime.conf
mkdir -p "${PGDATA}/conf.d"
if ! grep -q "include_dir = 'conf.d'" "${PGDATA}/postgresql.conf"; then
    echo "include_dir = 'conf.d'" >> "${PGDATA}/postgresql.conf"
fi

cat > "${PGDATA}/conf.d/aime.conf" <<EOF
# AIME Evaluation PostgreSQL 16 Configuration (40 GiB cgroup container)
listen_addresses = '*'
port = ${PG_PORT}
max_connections = 100
password_encryption = 'scram-sha-256'

# Memory tuning (conservative to coexist safely with 5001/5002/5003)
shared_buffers = '4GB'
effective_cache_size = '12GB'
work_mem = '64MB'
maintenance_work_mem = '1GB'
wal_buffers = '64MB'

# WAL, checkpoints & 60s compressed archiving
wal_level = 'replica'
wal_compression = 'zstd'
max_wal_size = '4GB'
min_wal_size = '512MB'
checkpoint_completion_target = 0.9
archive_mode = on
archive_timeout = 60
archive_command = 'AIME_DATA_ROOT=${AIME_DATA_ROOT} /opt/pg_data_core/scripts/pg_archive_wal.sh %p %f'

# Query planner & SSD IO
random_page_cost = 1.1
effective_io_concurrency = 200
max_worker_processes = 8
max_parallel_workers_per_gather = 4
max_parallel_workers = 6

# Timezone & observability
timezone = 'UTC'
log_timezone = 'UTC'
logging_collector = on
log_directory = 'log'
log_filename = 'postgresql-%Y-%m-%d.log'
log_min_duration_statement = 1000
log_checkpoints = on
log_autovacuum_min_duration = 5000
EOF

cat > "${PGDATA}/pg_hba.conf" <<'EOF'
# TYPE  DATABASE        USER            ADDRESS                 METHOD
local   all             postgres                                peer
local   all             all                                     scram-sha-256
host    all             all             127.0.0.1/32            scram-sha-256
host    all             all             ::1/128                 scram-sha-256
host    all             all             10.0.0.0/8              scram-sha-256
host    all             all             172.16.0.0/12           scram-sha-256
host    replication     aime_backup     127.0.0.1/32            scram-sha-256
host    replication     aime_backup     ::1/128                 scram-sha-256
EOF

chown -R postgres:postgres "${PGDATA}"
chmod 600 "${PGDATA}/pg_hba.conf" "${PGDATA}/conf.d/aime.conf"

# Ensure postgres user can write to .pg_backup/wal (root-owned CephFS dir)
chmod 777 "${AIME_DATA_ROOT}/.pg_backup/wal" || true
chmod +x /opt/pg_data_core/scripts/pg_archive_wal.sh

# Start or reload PostgreSQL 16
if su - postgres -c "${PG_BIN}/pg_ctl -D '${PGDATA}' status" >/dev/null 2>&1; then
    su - postgres -c "${PG_BIN}/pg_ctl -D '${PGDATA}' reload"
else
    su - postgres -c "${PG_BIN}/pg_ctl -D '${PGDATA}' -l '${PGDATA}/pg_ctl.log' -w start"
fi

# Create/update roles and database idempotently
su - postgres -c "${PG_BIN}/psql -p ${PG_PORT} -v ON_ERROR_STOP=1" <<SQL
DO \$\$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${AIME_PG_ADMIN_USER}') THEN
        CREATE ROLE ${AIME_PG_ADMIN_USER} LOGIN CREATEDB;
    END IF;
    ALTER ROLE ${AIME_PG_ADMIN_USER} WITH PASSWORD '${AIME_PG_ADMIN_PASSWORD}';

    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${AIME_PG_RW_USER}') THEN
        CREATE ROLE ${AIME_PG_RW_USER} LOGIN;
    END IF;
    ALTER ROLE ${AIME_PG_RW_USER} WITH PASSWORD '${AIME_PG_RW_PASSWORD}';

    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${AIME_PG_RO_USER}') THEN
        CREATE ROLE ${AIME_PG_RO_USER} LOGIN;
    END IF;
    ALTER ROLE ${AIME_PG_RO_USER} WITH PASSWORD '${AIME_PG_RO_PASSWORD}';

    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${AIME_PG_BACKUP_USER}') THEN
        CREATE ROLE ${AIME_PG_BACKUP_USER} LOGIN REPLICATION;
    END IF;
    ALTER ROLE ${AIME_PG_BACKUP_USER} WITH PASSWORD '${AIME_PG_BACKUP_PASSWORD}';
END
\$\$;
SQL

if ! su - postgres -c "${PG_BIN}/psql -p ${PG_PORT} -tAc \"SELECT 1 FROM pg_database WHERE datname='${PG_DB}'\"" | grep -q 1; then
    su - postgres -c "${PG_BIN}/createdb -p ${PG_PORT} -O ${AIME_PG_ADMIN_USER} -E UTF8 ${PG_DB}"
fi

su - postgres -c "${PG_BIN}/psql -p ${PG_PORT} -d '${PG_DB}' -v ON_ERROR_STOP=1 -c 'CREATE EXTENSION IF NOT EXISTS pg_trgm;'"

# Publish .runtime/pg_endpoint.json (no secrets!)
POD_IP="$(hostname -i | awk '{print $1}')"
python3 - <<PY
from pathlib import Path
import sys
sys.path.insert(0, "/opt/pg_data_core")
from pg_data_core.config import write_endpoint_json
ep = write_endpoint_json(
    Path("${AIME_DATA_ROOT}"),
    host="${POD_IP}",
    port=int("${PG_PORT}"),
    database="${PG_DB}",
    db_epoch="${AIME_DB_EPOCH}",
)
print(f"[pg_init_cluster] endpoint published: {ep}")
PY

echo "[pg_init_cluster] PostgreSQL 16 ready on ${POD_IP}:${PG_PORT}/${PG_DB} (PGDATA=${PGDATA})"
