#!/usr/bin/env bash
# Shared dataset-root resolution for the local dev scripts.
# Use EVAL_DATASETS when set, otherwise <repo>/datasets, including an empty root.

resolve_datasets() {
  if [ -n "${EVAL_DATASETS:-}" ]; then
    if [ -d "$EVAL_DATASETS" ]; then
      (cd "$EVAL_DATASETS" && pwd)
    else
      printf '%s\n' "$EVAL_DATASETS"
    fi
    return 0
  fi
  printf '%s\n' "$REPO_ROOT/datasets"
}
