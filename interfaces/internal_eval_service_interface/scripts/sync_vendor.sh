#!/usr/bin/env bash
# Sync vendored eval_harness_pkg and cluster_pkg from local sibling repos
# and record source revisions in vendor/VENDOR_MANIFEST.json.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VENDOR_DIR="$ROOT/vendor"

EVAL_SRC="${EVAL_HARNESS_SRC:-/Users/cmy/Desktop/eval_agent_harness/eval_harness_pkg}"
CLUSTER_SRC="${CLUSTER_PKG_SRC:-/Users/cmy/Desktop/cluster_algorithm/cluster_pkg}"

for src in "$EVAL_SRC" "$CLUSTER_SRC"; do
  if [ ! -d "$src" ]; then
    echo "ERROR: source package directory not found: $src" >&2
    exit 1
  fi
done

mkdir -p "$VENDOR_DIR/eval_harness_pkg" "$VENDOR_DIR/cluster_pkg"

rsync -a --delete \
  --exclude '__pycache__' \
  --exclude '*.pyc' \
  --exclude '.DS_Store' \
  --exclude '.pytest_cache' \
  --exclude 'config.yaml' \
  "$EVAL_SRC/" "$VENDOR_DIR/eval_harness_pkg/"

rsync -a --delete \
  --exclude '__pycache__' \
  --exclude '*.pyc' \
  --exclude '.DS_Store' \
  --exclude '.pytest_cache' \
  --exclude 'config.yaml' \
  "$CLUSTER_SRC/" "$VENDOR_DIR/cluster_pkg/"

python3 - "$EVAL_SRC" "$CLUSTER_SRC" "$VENDOR_DIR/VENDOR_MANIFEST.json" <<'PY'
import datetime
import json
import pathlib
import subprocess
import sys

eval_src, cluster_src, manifest_path = sys.argv[1:4]


def git_rev(path: str) -> str:
    parent = pathlib.Path(path).resolve().parent
    try:
        out = subprocess.check_output(
            ["git", "-C", str(parent), "rev-parse", "HEAD"],
            stderr=subprocess.DEVNULL,
            text=True,
        ).strip()
        return out
    except Exception:
        return "unknown"


manifest = {
    "synced_at": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "packages": {
        "eval_harness_pkg": {
            "source": str(pathlib.Path(eval_src).resolve()),
            "git_commit": git_rev(eval_src),
        },
        "cluster_pkg": {
            "source": str(pathlib.Path(cluster_src).resolve()),
            "git_commit": git_rev(cluster_src),
        },
    },
}
pathlib.Path(manifest_path).write_text(
    json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
    encoding="utf-8",
)
print(json.dumps(manifest, ensure_ascii=False, indent=2))
PY
