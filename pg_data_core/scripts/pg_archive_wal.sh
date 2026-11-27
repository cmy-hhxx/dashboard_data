#!/usr/bin/env bash
# Atomic compressed WAL archive command for PostgreSQL 16:
#   archive_command = '/opt/pg_data_core/scripts/pg_archive_wal.sh %p %f'
set -euo pipefail

WAL_PATH="${1:?missing %p}"
WAL_NAME="${2:?missing %f}"

AIME_DATA_ROOT="${AIME_DATA_ROOT:-/mnt/aime_eval_ssd/1_aime}"
WAL_DIR="${AIME_DATA_ROOT}/.pg_backup/wal"
mkdir -p "${WAL_DIR}"

DEST="${WAL_DIR}/${WAL_NAME}.zst"
if [[ -f "${DEST}" ]]; then
    # Idempotent: already archived cleanly
    exit 0
fi

TMP="${WAL_DIR}/.${WAL_NAME}.$$.tmp"
trap 'rm -f "${TMP}"' EXIT
zstd -q -3 --no-progress "${WAL_PATH}" -o "${TMP}"
mv -f "${TMP}" "${DEST}"
trap - EXIT
