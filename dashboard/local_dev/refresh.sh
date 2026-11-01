#!/usr/bin/env bash
# Rebuild data.json, samples.json and samples/ from the current local data source while the
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

DATASETS_DIR="$(resolve_datasets)"
export EVAL_DATASETS="$DATASETS_DIR"
echo "[refresh] datasets: $EVAL_DATASETS"

python3 build.py --datasets "$EVAL_DATASETS"
echo "[refresh] done, reload the browser"
