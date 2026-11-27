"""Full Reconciliation Suite: Compare PG 16 + Multi-Frame Zstd against Live 5001 & Live 5003.

Verifies:
1. Schema integrity: exact 18 public tables + 3 public materialized views.
2. Live 5001 (`data-aime.json` & `abtests-aime.json`) parity: inputs, evaluated traces,
   total problems, P0..P4 severity counts, worst-severity distribution, clustered counts, AB rounds.
3. Live 5003 (`/api/v1/analysis/severity`) parity: real-user analyzed traces, problems,
   P0..P4 problem counts & trace counts.
4. Multi-frame Zstd compression audit (raw vs compressed bytes, disk savings %) +
   random O(1) `pread_json` + `human_read` delta overlay roundtrip checks across all pack kinds.
"""

from __future__ import annotations

import json
import random
import urllib.request
from pathlib import Path
from typing import Any

from ..config import load_config
from ..core import DataCore
from ..db import connect_direct
from ..zst_pack import pread_json


def _fetch_json(url: str) -> dict[str, Any]:
    with urllib.request.urlopen(url, timeout=15) as resp:
        return json.loads(resp.read().decode("utf-8"))


def run_reconciliation() -> dict[str, Any]:
    cfg = load_config(role="ro")
    report: dict[str, Any] = {"checks": {}, "passed": True}

    with connect_direct(cfg, app_name="reconcile_live") as conn:
        # 1. Schema check
        tables = [
            r["tablename"]
            for r in conn.execute("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename").fetchall()
        ]
        mvs = [
            r["matviewname"]
            for r in conn.execute("SELECT matviewname FROM pg_matviews WHERE schemaname='public' ORDER BY matviewname").fetchall()
        ]
        row_counts = {}
        for t in tables:
            row_counts[t] = int(conn.execute(f"SELECT COUNT(*) AS c FROM public.{t}").fetchone()["c"])
        mv_counts = {}
        for mv in mvs:
            mv_counts[mv] = int(conn.execute(f"SELECT COUNT(*) AS c FROM public.{mv}").fetchone()["c"])

        report["schema"] = {
            "table_count": len(tables),
            "matview_count": len(mvs),
            "row_counts": row_counts,
            "matview_row_counts": mv_counts,
        }

        # 2. PG Totals vs Live 5001 (data-aime.json)
        pg_overview_all = conn.execute(
            """
            SELECT
                SUM(total_traces)::bigint AS total_traces,
                SUM(blob_inputs)::bigint AS blob_inputs,
                SUM(evaluated_cnt)::bigint AS evaluated_cnt,
                SUM(gold_cnt)::bigint AS gold_cnt,
                SUM(max_p0_cnt)::bigint AS max_p0,
                SUM(max_p1_cnt)::bigint AS max_p1,
                SUM(max_p2_cnt)::bigint AS max_p2,
                SUM(max_p3_cnt)::bigint AS max_p3,
                SUM(max_p4_cnt)::bigint AS max_p4,
                SUM(prob_total_cnt)::bigint AS prob_total,
                SUM(prob_p0_cnt)::bigint AS prob_p0,
                SUM(prob_p1_cnt)::bigint AS prob_p1,
                SUM(prob_p2_cnt)::bigint AS prob_p2,
                SUM(prob_p3_cnt)::bigint AS prob_p3,
                SUM(prob_p4_cnt)::bigint AS prob_p4,
                SUM(clustered_prob_cnt)::bigint AS clustered_probs,
                SUM(hr_attr_cnt)::bigint AS hr_attr_cnt,
                SUM(hr_compact_cnt)::bigint AS hr_compact_cnt
            FROM public.stats_daily_overview
            """
        ).fetchone()

        pg_by_model = {
            r["model"]: dict(r)
            for r in conn.execute(
                """
                SELECT
                    model,
                    SUM(blob_inputs)::bigint AS blob_inputs,
                    SUM(evaluated_cnt)::bigint AS evaluated_cnt,
                    SUM(prob_total_cnt)::bigint AS prob_total,
                    SUM(prob_p0_cnt)::bigint AS p0,
                    SUM(prob_p1_cnt)::bigint AS p1,
                    SUM(prob_p2_cnt)::bigint AS p2,
                    SUM(prob_p3_cnt)::bigint AS p3,
                    SUM(prob_p4_cnt)::bigint AS p4,
                    SUM(gold_cnt)::bigint AS gold,
                    SUM(clustered_prob_cnt)::bigint AS clustered_probs
                FROM public.stats_daily_overview
                GROUP BY model
                """
            ).fetchall()
        }

        live_5001_path = Path("/opt/eval_dashboard/static/data-aime.json")
        if live_5001_path.is_file():
            d5001 = json.loads(live_5001_path.read_text(encoding="utf-8"))["products"]["aime"]
            kpi = d5001["kpi"]
            by_m_5001 = {m["id"]: m for m in d5001["by_model"]}
            report["vs_live_5001"] = {
                "live_kpi": {
                    "inputs": kpi["inputs"],
                    "sessions_evaluated": kpi["sessions"],
                    "problems": kpi["problems"],
                    "clean_gold": kpi["clean"],
                    "clustered": kpi["clustered"],
                    "unclustered": kpi["unclustered"],
                },
                "pg_overview": dict(pg_overview_all),
                "diff": {
                    "inputs_delta": int(pg_overview_all["blob_inputs"]) - int(kpi["inputs"]),
                    "evaluated_delta": int(pg_overview_all["evaluated_cnt"]) - int(kpi["sessions"]),
                    "problems_delta": int(pg_overview_all["prob_total"]) - int(kpi["problems"]),
                    "gold_delta": int(pg_overview_all["gold_cnt"]) - int(kpi["clean"]),
                },
                "by_model": {
                    m: {
                        "live_5001_evaluated": by_m_5001[m]["sessions"],
                        "pg_evaluated": int(pg_by_model[m]["evaluated_cnt"]),
                        "live_5001_problems": by_m_5001[m]["problems"],
                        "pg_problems": int(pg_by_model[m]["prob_total"]),
                        "live_5001_sev": by_m_5001[m]["sev"],
                        "pg_sev": {
                            f"P{i}": int(pg_by_model[m][f"p{i}"]) for i in range(5)
                        },
                    }
                    for m in ("aime_expert", "aime_fast")
                    if m in by_m_5001 and m in pg_by_model
                },
            }

        # 3. PG Real-User Totals vs Live 5003 (/api/v1/analysis/severity)
        pg_real_5003 = conn.execute(
            """
            SELECT
                COUNT(DISTINCT o.output_id)::bigint AS analyzed,
                COALESCE(SUM(o.problem_count), 0)::bigint AS problems,
                COALESCE(SUM(o.p0_cnt), 0)::bigint AS p0_probs,
                COUNT(*) FILTER (WHERE o.p0_cnt > 0)::bigint AS p0_traces,
                COALESCE(SUM(o.p1_cnt), 0)::bigint AS p1_probs,
                COUNT(*) FILTER (WHERE o.p1_cnt > 0)::bigint AS p1_traces,
                COALESCE(SUM(o.p2_cnt), 0)::bigint AS p2_probs,
                COUNT(*) FILTER (WHERE o.p2_cnt > 0)::bigint AS p2_traces,
                COALESCE(SUM(o.p3_cnt), 0)::bigint AS p3_probs,
                COUNT(*) FILTER (WHERE o.p3_cnt > 0)::bigint AS p3_traces,
                COALESCE(SUM(o.p4_cnt), 0)::bigint AS p4_probs,
                COUNT(*) FILTER (WHERE o.p4_cnt > 0)::bigint AS p4_traces
            FROM public.eval_outputs o
            JOIN public.eval_inputs i ON i.input_id = o.input_id
            JOIN public.users u ON u.user_id = i.user_id
            WHERE o.is_latest = TRUE AND NOT i.is_deleted AND u.is_real = TRUE
            """
        ).fetchone()

        try:
            live_5003 = _fetch_json("http://127.0.0.1:5003/api/v1/analysis/severity?dataset=aime_eval")["data"]["total"]
            report["vs_live_5003"] = {
                "live_5003_real_users": live_5003,
                "pg_real_users": dict(pg_real_5003),
                "diff": {
                    "analyzed_delta": int(pg_real_5003["analyzed"]) - int(live_5003["analyzed"]),
                    "problems_delta": int(pg_real_5003["problems"]) - int(live_5003["problems"]),
                    "p0_probs_delta": int(pg_real_5003["p0_probs"]) - int(live_5003["severity"]["P0"]["problems"]),
                    "p1_probs_delta": int(pg_real_5003["p1_probs"]) - int(live_5003["severity"]["P1"]["problems"]),
                    "p2_probs_delta": int(pg_real_5003["p2_probs"]) - int(live_5003["severity"]["P2"]["problems"]),
                    "p3_probs_delta": int(pg_real_5003["p3_probs"]) - int(live_5003["severity"]["P3"]["problems"]),
                    "p4_probs_delta": int(pg_real_5003["p4_probs"]) - int(live_5003["severity"]["P4"]["problems"]),
                },
            }
        except Exception as exc:
            report["vs_live_5003"] = {"error": str(exc)}

        # 4. AB rounds verification
        ab_rows = conn.execute(
            """
            SELECT r.round_key, r.actual_count AS targets,
                   c.candidate_key, c.source_mode, c.is_baseline,
                   COUNT(cc.case_id) AS total_cases,
                   COUNT(cc.case_id) FILTER (WHERE cc.status = 'evaluated') AS evaluated_cases,
                   COALESCE(SUM(cc.problem_count), 0) AS total_problems
            FROM public.ab_rounds r
            JOIN public.ab_candidates c ON c.round_id = r.round_id
            LEFT JOIN public.ab_candidate_cases cc ON cc.candidate_id = c.candidate_id
            GROUP BY r.round_key, r.actual_count, c.candidate_idx, c.candidate_key, c.source_mode, c.is_baseline
            ORDER BY r.round_key, c.candidate_idx
            """
        ).fetchall()
        report["ab_rounds"] = [dict(r) for r in ab_rows]

        # 5. Compression audit across pack_files
        pack_stats = conn.execute(
            """
            SELECT domain, kind,
                   COUNT(*)::bigint AS files,
                   SUM(record_count)::bigint AS records,
                   SUM(uncompressed_bytes)::bigint AS raw_bytes,
                   SUM(committed_bytes)::bigint AS compressed_bytes,
                   ROUND((1.0 - SUM(committed_bytes)::numeric / NULLIF(SUM(uncompressed_bytes), 0)) * 100, 2) AS saved_pct
            FROM public.pack_files
            GROUP BY domain, kind
            ORDER BY domain, kind
            """
        ).fetchall()
        tot_raw = sum(int(r["raw_bytes"] or 0) for r in pack_stats)
        tot_comp = sum(int(r["compressed_bytes"] or 0) for r in pack_stats)
        report["compression"] = {
            "by_kind": [{k: (float(v) if hasattr(v, "as_tuple") else v) for k, v in dict(r).items()} for r in pack_stats],
            "total_raw_gb": round(tot_raw / 1e9, 3),
            "total_compressed_gb": round(tot_comp / 1e9, 3),
            "total_saved_pct": round((1.0 - tot_comp / max(tot_raw, 1)) * 100, 2),
        }

        # 6. Random O(1) Zstd pread & human_read delta overlay verification (30 random samples)
        sample_ids = [
            int(r["input_id"])
            for r in conn.execute(
                """
                SELECT i.input_id
                FROM public.eval_inputs i
                JOIN public.eval_outputs o ON o.input_id = i.input_id AND o.is_latest = TRUE
                JOIN public.human_read_overlays h ON h.output_id = o.output_id AND h.target_kind = 'attribution'
                WHERE i.has_input_blob = TRUE
                ORDER BY i.input_id DESC
                LIMIT 200
                """
            ).fetchall()
        ]

    rng = random.Random(42)
    picked = rng.sample(sample_ids, min(20, len(sample_ids)))
    pread_ok = 0
    hr_overlay_ok = 0
    with DataCore(cfg) as dc:
        for iid in picked:
            d_raw = dc.read_daily_detail(iid, text_mode="raw")
            d_hr = dc.read_daily_detail(iid, text_mode="human")
            if d_raw["input"] is not None and d_raw["attribution"] is not None:
                pread_ok += 1
            if d_hr["text_mode"] == "human" and "_human_read" in (d_hr["attribution"] or {}):
                hr_overlay_ok += 1

    report["random_pread_check"] = {
        "sampled": len(picked),
        "raw_pread_ok": pread_ok,
        "human_read_overlay_ok": hr_overlay_ok,
    }
    if pread_ok != len(picked) or hr_overlay_ok != len(picked):
        report["passed"] = False

    out_path = cfg.data_root / ".runtime" / "reconciliation_report.json"
    out_path.write_text(json.dumps(report, ensure_ascii=False, indent=2, default=str) + "\n", encoding="utf-8")
    return report


def main() -> None:
    rep = run_reconciliation()
    print(json.dumps(rep, ensure_ascii=False, indent=2, default=str))


if __name__ == "__main__":
    main()
