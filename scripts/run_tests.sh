#!/usr/bin/env bash
# Run every test suite in the repo: Python unittest per component, the dashboard's
# node tests and the 5003 fixture acceptance run.  Some suites build real payloads,
# so run this on a server, not on a laptop that must stay light.
#   scripts/run_tests.sh            all suites
#   scripts/run_tests.sh dashboard  one component: dashboard | interfaces | page_service
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ONLY="${1:-}"
FAILED=()

run() {  # run <label> <dir> <command...>
  local label="$1" dir="$2"
  shift 2
  echo "== $label"
  if ! (cd "$dir" && "$@"); then FAILED+=("$label"); fi
}

if [ -z "$ONLY" ] || [ "$ONLY" = dashboard ]; then
  run "dashboard python" "$ROOT/dashboard" python3 -m unittest discover -s tests -q
  run "dashboard node" "$ROOT/dashboard" node --test tests/test_*.mjs
  for f in "$ROOT"/dashboard/tests/test_*.cjs; do
    run "dashboard $(basename "$f")" "$ROOT/dashboard" node "$f"
  done
fi
if [ -z "$ONLY" ] || [ "$ONLY" = interfaces ]; then
  run "interfaces unittest" "$ROOT/interfaces/eval_data_interface" python3 -m unittest discover -s tests -q
  run "interfaces acceptance" "$ROOT/interfaces/eval_data_interface" python3 tests/test_acceptance.py
fi
if [ -z "$ONLY" ] || [ "$ONLY" = page_service ]; then
  for d in "$ROOT"/page_service/*/tests; do
    run "page_service $(basename "$(dirname "$d")")" "$(dirname "$d")" python3 -m unittest discover -s tests -q
  done
fi

if [ "${#FAILED[@]}" -gt 0 ]; then
  echo "FAILED: ${FAILED[*]}"
  exit 1
fi
echo "all suites passed"
