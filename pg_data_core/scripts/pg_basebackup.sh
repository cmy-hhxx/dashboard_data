#!/usr/bin/env bash
# Daily compressed pg_basebackup to ${AIME_DATA_ROOT}/.pg_backup/base/
# Retains last 3 days of base backups and prunes obsolete WAL segments.
set -euo pipefail

SECRETS_FILE="${AIME_PG_SECRETS_FILE:-/opt/pg_data_core/.pg_secrets.env}"
if [[ -f "${SECRETS_FILE}" ]]; then
    # shellcheck disable=SC1090
    source "${SECRETS_FILE}"
fi

AIME_DATA_ROOT="${AIME_DATA_ROOT:-/mnt/aime_eval_ssd/1_aime}"
KEEP_DAYS="${PG_BACKUP_KEEP_DAYS:-3}"
PG_HOST="${AIME_PG_HOST:-127.0.0.1}"
PG_PORT="${AIME_PG_PORT:-5432}"
BACKUP_USER="${AIME_PG_BACKUP_USER:-aime_backup}"
export PGPASSWORD="${AIME_PG_BACKUP_PASSWORD:?AIME_PG_BACKUP_PASSWORD missing}"

BASE_DIR="${AIME_DATA_ROOT}/.pg_backup/base"
WAL_DIR="${AIME_DATA_ROOT}/.pg_backup/wal"
mkdir -p "${BASE_DIR}" "${WAL_DIR}"

TS="$(date -u +%Y%m%dT%H%M%SZ)"
TARGET_TMP="${BASE_DIR}/.base_${TS}_$$"
TARGET_FINAL="${BASE_DIR}/base_${TS}"
trap 'rm -rf "${TARGET_TMP}"' EXIT

/usr/lib/postgresql/16/bin/pg_basebackup \
    -h "${PG_HOST}" \
    -p "${PG_PORT}" \
    -U "${BACKUP_USER}" \
    -D "${TARGET_TMP}" \
    -F tar \
    --compress=client-zstd:6 \
    --checkpoint=fast \
    --wal-method=fetch \
    --manifest-checksums=SHA256

# Verify tarball integrity before publishing
zstd -t -q "${TARGET_TMP}/base.tar.zst"
mv "${TARGET_TMP}" "${TARGET_FINAL}"
trap - EXIT
ln -sfn "base_${TS}" "${BASE_DIR}/latest"

echo "[pg_basebackup] OK: ${TARGET_FINAL} ($(du -sh "${TARGET_FINAL}" | awk '{print $1}'))"

# Retain newest KEEP_DAYS base backups (always keep at least 1)
mapfile -t ALL_BASES < <(find "${BASE_DIR}" -maxdepth 1 -mindepth 1 -type d -name 'base_*' | sort)
TOTAL="${#ALL_BASES[@]}"
if (( TOTAL > KEEP_DAYS )); then
    DEL_COUNT=$(( TOTAL - KEEP_DAYS ))
    for (( i=0; i<DEL_COUNT; i++ )); do
        echo "[pg_basebackup] pruning old basebackup: ${ALL_BASES[$i]}"
        rm -rf "${ALL_BASES[$i]}"
    done
fi

# Prune WAL segments older than (KEEP_DAYS + 1) days, never deleting last 24h
find "${WAL_DIR}" -maxdepth 1 -type f -name '*.zst' -mtime +"$((KEEP_DAYS))" -delete || true
