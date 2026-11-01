#!/usr/bin/env bash
# Local dev server for the eval dashboard.
#
# Data source (first match wins):
#   1. EVAL_DATASETS=/path/to/datasets
#   2. ../data (repo root) or ../data/datasets with 0_wencai / 1_aime
#   3. the offline fixture under local_dev/datasets/ (generated on demand)
#
# It rebuilds data.json + samples.json from the chosen source, then serves
# on :5001 (override with PORT). Rerun this script after dropping new data in:
# it stops the previous dev server automatically.
set -euo pipefail
cd "$(dirname "$0")/.."

DASHBOARD="$PWD"
REPO_ROOT="$(dirname "$PWD")"
# shellcheck source=local_dev/env.sh
source "$DASHBOARD/local_dev/env.sh"

PORT="${PORT:-5001}"
PIDFILE="$DASHBOARD/local_dev/server.pid"

# Stop only our own dev server: the pid file must point at a server.py process.
if [ -f "$PIDFILE" ]; then
  pid="$(cat "$PIDFILE" 2>/dev/null || true)"
  if [ -n "${pid:-}" ] && ps -p "$pid" -o command= 2>/dev/null | grep -q "server.py"; then
    echo "[dev] stopping previous server (pid $pid)"
    kill "$pid" 2>/dev/null || true
    for _ in 1 2 3 4 5; do
      ps -p "$pid" >/dev/null 2>&1 || break
      sleep 0.4
    done
    ps -p "$pid" >/dev/null 2>&1 && kill -9 "$pid" 2>/dev/null || true
  fi
  rm -f "$PIDFILE"
fi

DATASETS_DIR="$(resolve_datasets || true)"
USE_FIXTURE=0
if [ -z "$DATASETS_DIR" ]; then
  DATASETS_DIR="$DASHBOARD/local_dev/datasets"
  USE_FIXTURE=1
fi
export EVAL_DATASETS="$DATASETS_DIR"
# Local dev refreshes on explicit ./local_dev/refresh.sh instead of rescanning
# every 30 minutes; override with REFRESH_SECONDS if you want the scheduler.
export REFRESH_SECONDS="${REFRESH_SECONDS:-86400}"

mkdir -p cache logs

echo "[dev] datasets: $EVAL_DATASETS"
if [ "$USE_FIXTURE" = "1" ]; then
  echo "[dev] no data/ found, generating offline fixture"
  python3 local_dev/make_demo_dataset.py --out "$EVAL_DATASETS"
fi

echo "[dev] scan"
python3 scan_datasets.py --data "$EVAL_DATASETS" --out cache/datasets.json

echo "[dev] prepare"
python3 prepare.py --counts cache/datasets.json

echo "[dev] samples"
python3 prepare_samples.py --datasets "$EVAL_DATASETS"

echo "[dev] serving http://127.0.0.1:$PORT/"
echo $$ > "$PIDFILE"
exec env PORT="$PORT" python3 server.py
