#!/usr/bin/env bash
# Shared dataset-root resolution for the local dev scripts.
# Expects to be sourced from dashboard/ or a script whose cwd is dashboard/.
#
# Priority:
#   1. EVAL_DATASETS (explicit override)
#   2. <repo>/data or <repo>/data/datasets containing 0_wencai / 1_aime
#   3. <dashboard>/data or <dashboard>/data/datasets (same check)
#
# `resolve_datasets` prints the resolved absolute path and returns 0, or
# returns 1 when nothing usable was found (caller falls back to the fixture).

resolve_datasets() {
  if [ -n "${EVAL_DATASETS:-}" ]; then
    if [ -d "$EVAL_DATASETS" ]; then
      (cd "$EVAL_DATASETS" && pwd)
    else
      printf '%s\n' "$EVAL_DATASETS"
    fi
    return 0
  fi
  for candidate in "$REPO_ROOT/data/datasets" "$REPO_ROOT/data" "$DASHBOARD/data/datasets" "$DASHBOARD/data"; do
    if [ -d "$candidate/0_wencai" ] || [ -d "$candidate/1_aime" ]; then
      (cd "$candidate" && pwd)
      return 0
    fi
  done
  return 1
}
