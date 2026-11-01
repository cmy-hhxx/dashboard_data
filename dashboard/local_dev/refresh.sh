#!/usr/bin/env bash
# Rebuild data.json + samples.json from the current local data source while the
# dev server keeps running. The server sends these with Cache-Control: no-cache,
# so a browser reload picks the new payload up without a restart.
#
# Usage: ./local_dev/refresh.sh
set -euo pipefail
cd "$(dirname "$0")/.."

DASHBOARD="$PWD"
REPO_ROOT="$(dirname "$PWD")"
# shellcheck source=local_dev/env.sh
source "$DASHBOARD/local_dev/env.sh"

DATASETS_DIR="$(resolve_datasets || true)"
if [ -z "$DATASETS_DIR" ]; then
  # No data/ yet: keep the offline fixture usable.
  if [ -d "$DASHBOARD/local_dev/datasets/0_wencai" ] || [ -d "$DASHBOARD/local_dev/datasets/1_aime" ]; then
    DATASETS_DIR="$DASHBOARD/local_dev/datasets"
  else
    echo "no datasets found: put 0_wencai / 1_aime under ../data or set EVAL_DATASETS" >&2
    exit 1
  fi
fi
export EVAL_DATASETS="$DATASETS_DIR"
echo "[refresh] datasets: $EVAL_DATASETS"

python3 scan_datasets.py --data "$EVAL_DATASETS" --out cache/datasets.json
python3 prepare.py --counts cache/datasets.json
python3 prepare_samples.py --datasets "$EVAL_DATASETS"
echo "[refresh] done, reload the browser"
