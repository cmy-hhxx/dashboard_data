#!/usr/bin/env bash
# End-to-End Disaster Recovery & 30-Min Rollback `reconcile_tails` Drill
# Runs against an isolated PG 16 test instance on port 5433 (/tmp/pgdata_dr_drill)
# without touching production /opt/pgdata (port 5432) or live 5001/5002/5003!
set -euo pipefail

SECRETS_FILE="${AIME_PG_SECRETS_FILE:-/opt/pg_data_core/.pg_secrets.env}"
# shellcheck disable=SC1090
source "${SECRETS_FILE}"

DR_PGDATA="/tmp/pgdata_dr_drill"
DR_PORT="5433"
DR_DATA_ROOT="/tmp/aime_dr_drill_blobs"
PG_BIN="/usr/lib/postgresql/16/bin"

cleanup() {
    if [[ -f "${DR_PGDATA}/postmaster.pid" ]]; then
        su - postgres -c "${PG_BIN}/pg_ctl -D '${DR_PGDATA}' -m immediate stop" >/dev/null 2>&1 || true
    fi
    rm -rf "${DR_PGDATA}" "${DR_DATA_ROOT}"
}
trap cleanup EXIT

echo "=== [DR Drill 1/5] Run compressed pg_basebackup from live PG 16 ==="
bash /opt/pg_data_core/scripts/pg_basebackup.sh

echo "=== [DR Drill 2/5] Restore PITR backup into isolated PG 16 instance on :${DR_PORT} ==="
bash /opt/pg_data_core/scripts/pg_restore_pitr.sh "${DR_PGDATA}" "${DR_PORT}"

echo "=== [DR Drill 3/5] Verify restored row counts match primary :5432 ==="
PYTHONPATH=/opt/pg_data_core python3 - <<PY
from pg_data_core.config import load_config
from pg_data_core.db import connect_direct
import os

c_prod = load_config(role="ro")
os.environ["AIME_PG_PORT"] = "${DR_PORT}"
c_dr = load_config(role="ro")

tables = ["pack_files", "users", "eval_inputs", "eval_outputs", "eval_problems", "human_read_overlays", "cluster_trees", "cluster_nodes", "bench_sets", "bench_items", "ab_rounds", "ab_candidates", "ab_targets", "ab_candidate_cases", "ab_candidate_problems"]
with connect_direct(c_prod) as cp, connect_direct(c_dr) as cd:
    for t in tables:
        n1 = cp.execute(f"SELECT COUNT(*) AS c FROM public.{t}").fetchone()["c"]
        n2 = cd.execute(f"SELECT COUNT(*) AS c FROM public.{t}").fetchone()["c"]
        assert n1 == n2, f"Mismatch on {t}: prod={n1} vs dr={n2}"
    print(f"[DR Drill] All {len(tables)} tables match 100% after PITR restore!")
PY

echo "=== [DR Drill 4/5] Simulate 30-min PG rollback after Blob-First writes & run reconcile_tails ==="
mkdir -p "${DR_DATA_ROOT}"
PYTHONPATH=/opt/pg_data_core python3 - <<PY
import os
from pathlib import Path
from pg_data_core.config import load_config
from pg_data_core.core import DataCore
from pg_data_core.reconcile import reconcile_tails

os.environ["AIME_PG_PORT"] = "${DR_PORT}"
cfg = load_config(role="rw", data_root="${DR_DATA_ROOT}")

with DataCore(cfg) as dc:
    # Write 5 Blob-First inputs + 2 outputs (simulating 30 min of live traffic after last WAL)
    created_tids = []
    for i in range(5):
        tid = f"__dr_drill_trace_{i:03d}__"
        created_tids.append(tid)
        dc.ingest_daily_input(
            {
                "trace_id": tid,
                "request_time": "2026-11-26T18:00:00Z",
                "meta": {
                    "trace_id": tid,
                    "session_id": f"__dr_sess_{i}__",
                    "user_id": f"880000{i}",
                    "question_text": f"DR drill financial question #{i}",
                    "total_tokens": 500 + i,
                    "tool_count": i,
                },
                "traces": [{"meta": {"trace_id": tid, "timestamp": "2026-11-26T18:00:00Z"}}],
            },
            "aime_expert",
        )
    for i in range(2):
        tid = created_tids[i]
        dc.commit_daily_output(
            {
                "session_meta": {"trace_id": tid, "session_id": f"__dr_sess_{i}__", "user_id": f"880000{i}", "question_text": f"DR drill financial question #{i}"},
                "turns": [
                    {
                        "meta": {"trace_id": tid, "timestamp": "2026-11-26T18:00:00Z", "user_id": f"880000{i}"},
                        "summary": f"DR drill summary {i}",
                        "problem": [{"label": "DR test issue", "severity": "P2", "component": "finquery"}],
                    }
                ],
            },
            "aime_expert",
        )

    # Simulate PG losing the last 30 min of DB transactions (delete rows & reset watermarks, blobs intact on disk!)
    with dc.db.transaction() as conn:
        conn.execute("DELETE FROM public.eval_inputs WHERE trace_id = ANY(%s)", (created_tids,))
        conn.execute("DELETE FROM public.pack_files WHERE biz_day = '2026-11-26' AND model = 'aime_expert' AND rel_path LIKE '%%2026/1126/%%'")

    # Execute reconcile_tails() self-healing
    rep = reconcile_tails(dc, lookback_minutes=60)
    print("[DR Drill] reconcile_tails report:", rep)

    with dc.db.connection() as conn:
        in_cnt = conn.execute("SELECT COUNT(*) AS c FROM public.eval_inputs WHERE trace_id = ANY(%s)", (created_tids,)).fetchone()["c"]
        out_cnt = conn.execute("SELECT COUNT(*) AS c FROM public.eval_outputs WHERE trace_id = ANY(%s)", (created_tids,)).fetchone()["c"]
        prob_cnt = conn.execute("SELECT COUNT(*) AS c FROM public.eval_problems WHERE trace_id = ANY(%s)", (created_tids,)).fetchone()["c"]
    assert in_cnt == 5, f"Expected 5 recovered inputs, got {in_cnt}"
    assert out_cnt == 2, f"Expected 2 recovered outputs, got {out_cnt}"
    assert prob_cnt == 2, f"Expected 2 recovered problems, got {prob_cnt}"
    print(f"[DR Drill] ZERO DATA LOSS VERIFIED: recovered {in_cnt}/5 inputs, {out_cnt}/2 outputs, {prob_cnt}/2 problems!")
PY

echo "=== [DR Drill 5/5] Backup footprint check ==="
du -sh "${AIME_DATA_ROOT}/.pg_backup" "${AIME_DATA_ROOT}/.pg_backup/base" "${AIME_DATA_ROOT}/.pg_backup/wal"
echo "=== DR DRILL PASSED 100% ==="
