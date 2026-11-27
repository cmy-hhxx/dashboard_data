"""PostgreSQL 16 + Multi-Frame Zstd integration for internal_eval_service_interface.

Activated ONLY when ``INTERNAL_EVAL_BACKEND=pg``. All ``pg_data_core`` imports are
strictly lazy so standalone unit tests and legacy file-mode deployments work with
zero extra dependencies.

Provides:
  1. ``sample_bench_targets_pg(model, tier, limit_override)`` — samples stratified
     bench targets directly from PG ``bench_sets`` / ``bench_items`` and extracts
     multi-turn history via O(1) Zstd ``pread_json`` from ``eval_inputs`` packs.
  2. ``publish_run_to_pg(run, targets, before_cases, after_cases, round_dir)`` —
     persists the completed AB round into the 6 PG AB tables (``ab_rounds``,
     ``ab_candidates``, ``ab_targets``, ``ab_candidate_cases``,
     ``ab_candidate_problems``, ``ab_run_events``) and packs candidate blobs into
     ``<AIME_DATA_ROOT>/ab_test/<model>/<YYYY>/version_<YYYYMMDD>[_<tag>]/candidate_model_N/*.jsonl.zst``.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import sys
from datetime import date
from pathlib import Path
from typing import Any

from .ab_layout import INPUT_FILENAME, SIDE_DIR
from .bench_sampler import _extract_history_messages

CLUSTER_DELIVERABLES = (
    "cluster_tree.json",
    "cluster_tree.txt",
    "cluster_brief.md",
    "cluster_summary.md",
    "cluster_matrix.png",
    "leaves.tsv",
    "syndrome.md",
    "syndrome.json",
    "verify.json",
    "MANIFEST.json",
)
_VER_DIGITS_RE = re.compile(r"(\d{8})")


def is_pg_enabled() -> bool:
    return os.environ.get("INTERNAL_EVAL_BACKEND", "").strip().lower() in ("pg", "postgres", "postgresql")


def _ensure_pg():
    for cand in (
        os.environ.get("PG_DATA_CORE_PATH") or "",
        "/opt/pg_data_core",
        str(Path(__file__).resolve().parents[3]),
    ):
        if cand and os.path.isdir(cand) and cand not in sys.path:
            sys.path.insert(0, cand)
    from psycopg.types.json import Jsonb
    from pg_data_core.config import load_config
    from pg_data_core.db import connect_direct
    from pg_data_core.models import (
        clean_str,
        extract_attribution_fields,
        extract_human_read_delta,
        parse_timestamp,
        split_cluster_code,
    )
    from pg_data_core.zst_pack import BulkPackWriter, ab_candidate_rel_path, json_loads_bytes, pread_json

    return (
        Jsonb,
        load_config,
        connect_direct,
        clean_str,
        extract_attribution_fields,
        extract_human_read_delta,
        parse_timestamp,
        split_cluster_code,
        BulkPackWriter,
        ab_candidate_rel_path,
        json_loads_bytes,
        pread_json,
    )


def sample_bench_targets_pg(
    model: str,
    tier: int,
    *,
    limit_override: int | None = None,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Sample stratified bench targets directly from PG `bench_sets` / `bench_items`."""
    (
        _Jsonb,
        load_config,
        connect_direct,
        _clean_str,
        _ext_attr,
        _ext_hr,
        _parse_ts,
        _split_cl,
        _BulkPackWriter,
        _ab_rel,
        _jloads,
        pread_json,
    ) = _ensure_pg()

    cfg = load_config(role="ro", data_root=os.environ.get("AIME_DATA_ROOT") or None)
    target_limit = int(limit_override if limit_override is not None else tier)

    with connect_direct(cfg, app_name="internal_eval_sampler") as conn:
        bset = conn.execute(
            """
            SELECT bench_id, bench_key, tier_size, actual_count
            FROM public.bench_sets
            WHERE product = 'aime' AND model = %s AND bench_type = 'tier' AND tier_size >= %s
            ORDER BY tier_size ASC
            LIMIT 1
            """,
            (model, tier),
        ).fetchone()
        if not bset:
            bset = conn.execute(
                """
                SELECT bench_id, bench_key, tier_size, actual_count
                FROM public.bench_sets
                WHERE product = 'aime' AND model = %s AND bench_type = 'tier'
                ORDER BY tier_size DESC
                LIMIT 1
                """,
                (model,),
            ).fetchone()
        if not bset:
            raise FileNotFoundError(f"PG bench_sets 中未找到模型 {model} 的 tier 题集")

        rows = conn.execute(
            """
            SELECT bi.input_id, bi.trace_id, bi.session_id, bi.rank, bi.turn_type,
                   bi.session_round, bi.severity, bi.question_text, bi.primary_cluster, bi.extra,
                   i.user_id, i.request_time, i.turn_index, i.task_category, i.subtask_category,
                   pf.rel_path AS in_path, i.input_offset, i.input_len
            FROM public.bench_items bi
            LEFT JOIN public.eval_inputs i ON i.input_id = bi.input_id
            LEFT JOIN public.pack_files pf ON pf.file_id = i.input_file_id
            WHERE bi.bench_id = %s
            ORDER BY bi.rank ASC
            LIMIT %s
            """,
            (bset["bench_id"], target_limit),
        ).fetchall()

    if not rows:
        raise ValueError(f"PG bench_sets={bset['bench_key']} 题集为空")

    targets: list[dict[str, Any]] = []
    single_count = 0
    multi_count = 0
    severity_counts: dict[str, int] = {}

    for idx, r in enumerate(rows, 1):
        case_key = f"eq_{idx:05d}"
        bex = r["extra"] if isinstance(r["extra"], dict) else {}
        bench_info = bex.get("bench") if isinstance(bex.get("bench"), dict) else {}
        turn = str(r["turn_type"] or ("multi" if int(r["session_round"] or 1) > 1 else "single")).lower()
        if turn not in ("single", "multi"):
            turn = "single"
        if turn == "multi":
            multi_count += 1
        else:
            single_count += 1

        sev = str(r["severity"] or "").strip().upper()
        if sev:
            severity_counts[sev] = severity_counts.get(sev, 0) + 1

        history_messages: list[dict[str, Any]] = []
        if turn == "multi" and r["in_path"] and r["input_len"]:
            try:
                inp_doc = pread_json(cfg.data_root / r["in_path"], int(r["input_offset"]), int(r["input_len"]))
                if isinstance(inp_doc, dict):
                    traces = inp_doc.get("traces") if isinstance(inp_doc.get("traces"), list) else []
                    t0 = traces[0] if traces and isinstance(traces[0], dict) else inp_doc
                    probe = {
                        "question": r["question_text"] or "",
                        "messages": t0.get("messages") if isinstance(t0.get("messages"), list) else [],
                        "message_pool": t0.get("message_pool") or inp_doc.get("message_pool") or [],
                    }
                    history_messages = _extract_history_messages(probe)
            except Exception:  # noqa: BLE001
                history_messages = []

        req_str = (
            r["request_time"].isoformat().replace("+00:00", "Z")
            if r["request_time"] is not None
            else str(bex.get("request_time") or "")
        )
        targets.append({
            "case_key": case_key,
            "eq_index": idx,
            "source_input_id": int(r["input_id"]) if r["input_id"] is not None else None,
            "source_trace_id": str(r["trace_id"] or ""),
            "source_session_id": str(r["session_id"] or ""),
            "user_id": str(r["user_id"] or ""),
            "model": model,
            "question": str(r["question_text"] or "").strip(),
            "turn": turn,
            "session_round": int(r["session_round"] or 1),
            "turn_index": int(r["turn_index"] or 1),
            "request_time": req_str,
            "batch_id": str(bex.get("batch_id") or ""),
            "group": str(bex.get("group") or ""),
            "bench_rank": int(bench_info.get("rank", r["rank"] or (idx - 1))),
            "bench_seed": str(bench_info.get("seed") or ""),
            "bench_severity": sev,
            "bench_primary": bex.get("primary") if isinstance(bex.get("primary"), dict) else {},
            "task": str(r["task_category"] or "").strip(),
            "subtask": str(r["subtask_category"] or "").strip(),
            "history_messages": history_messages,
        })

    meta_summary = {
        "source_file": f"pg:bench_sets/{bset['bench_key']}",
        "bench_id": int(bset["bench_id"]),
        "model": model,
        "requested_count": target_limit,
        "actual_count": len(targets),
        "shortfall": max(0, target_limit - len(targets)),
        "single_turn": single_count,
        "multi_turn": multi_count,
        "bench_severity_distribution": severity_counts,
    }
    return targets, meta_summary


def publish_run_to_pg(
    *,
    run: dict[str, Any],
    targets: list[dict[str, Any]],
    before_cases: dict[str, dict[str, Any]],
    after_cases: dict[str, dict[str, Any]],
    round_dir: Path,
) -> dict[str, Any]:
    """Pack completed AB round artifacts into multi-frame Zstd and upsert into PG 6 AB tables."""
    (
        Jsonb,
        load_config,
        connect_direct,
        clean_str,
        extract_attribution_fields,
        extract_human_read_delta,
        parse_timestamp,
        split_cluster_code,
        BulkPackWriter,
        ab_candidate_rel_path,
        json_loads_bytes,
        _pread_json,
    ) = _ensure_pg()

    cfg = load_config(role="rw", data_root=os.environ.get("AIME_DATA_ROOT") or None)
    model = run["model"]
    round_key = run["round_dir_name"]
    m_ver = _VER_DIGITS_RE.search(round_key) or _VER_DIGITS_RE.search(str(run.get("version") or ""))
    ver_str = m_ver.group(1) if m_ver else date.today().strftime("%Y%m%d")
    yyyy = ver_str[:4]
    released_at = date(int(ver_str[:4]), int(ver_str[4:6]), int(ver_str[6:8]))
    round_folder = f"version_{ver_str}"
    if round_key != f"version_{ver_str}_{model}":
        suffix = re.sub(r"[^0-9A-Za-z._-]+", "_", round_key)
        round_folder = f"version_{ver_str}_{suffix}"

    def _pack_file(conn, src: Path, rel_path: str, kind: str, transform=None):
        if not src.is_file() or src.stat().st_size == 0:
            return None, {}
        by_key: dict[str, tuple[int, int, dict[str, Any]]] = {}
        with BulkPackWriter(cfg.data_root / rel_path, rel_path, level=cfg.zstd_level) as w:
            with src.open("rb", buffering=4 << 20) as fh:
                for raw in fh:
                    if not raw.strip():
                        continue
                    try:
                        rec = json_loads_bytes(raw)
                    except ValueError:
                        continue
                    out_rec = transform(rec) if transform else rec
                    if out_rec is None:
                        continue
                    ptr = w.write_record(out_rec)
                    smeta = rec.get("session_meta") if isinstance(rec.get("session_meta"), dict) else {}
                    meta = rec.get("meta") if isinstance(rec.get("meta"), dict) else {}
                    for k in (
                        rec.get("case_key"),
                        meta.get("case_key"),
                        smeta.get("case_key"),
                        rec.get("trace_id"),
                        meta.get("trace_id"),
                        smeta.get("trace_id"),
                    ):
                        ks = clean_str(k)
                        if ks:
                            by_key[ks] = (ptr.offset, ptr.length, rec)
                    for t in rec.get("turns") or []:
                        if isinstance(t, dict) and isinstance(t.get("meta"), dict):
                            tid = clean_str(t["meta"].get("trace_id"))
                            if tid:
                                by_key[tid] = (ptr.offset, ptr.length, rec)
            sha = w.close()
        pf = conn.execute(
            """
            INSERT INTO public.pack_files(
                rel_path, domain, kind, model, part_no, status,
                committed_bytes, uncompressed_bytes, record_count, sha256
            )
            VALUES (%s, 'ab', %s, %s, 0, 'sealed', %s, %s, %s, %s)
            ON CONFLICT (rel_path) DO UPDATE SET
                committed_bytes = EXCLUDED.committed_bytes,
                uncompressed_bytes = EXCLUDED.uncompressed_bytes,
                record_count = EXCLUDED.record_count,
                sha256 = EXCLUDED.sha256,
                updated_at = now()
            RETURNING file_id
            """,
            (rel_path, kind, model, w.committed_bytes, w.uncompressed_bytes, w.record_count, sha),
        ).fetchone()
        return int(pf["file_id"]), by_key

    with connect_direct(cfg, autocommit=False, app_name="internal_eval_publish") as conn:
        bench_id = (run.get("meta") or {}).get("bench_sampling", {}).get("bench_id")
        rrow = conn.execute(
            """
            INSERT INTO public.ab_rounds(
                round_key, idempotency_key, product, model, version_tag, released_at, title,
                bench_id, tier_size, requested_count, actual_count, status, stage,
                finished_at, extra
            )
            VALUES (%s,%s,'aime',%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
            ON CONFLICT (round_key) DO UPDATE SET
                actual_count = EXCLUDED.actual_count,
                status = EXCLUDED.status,
                stage = EXCLUDED.stage,
                finished_at = EXCLUDED.finished_at,
                extra = EXCLUDED.extra,
                updated_at = now()
            RETURNING round_id
            """,
            (
                round_key,
                run.get("idempotency_key") or f"run:{run['run_id']}",
                model,
                str(run.get("version") or ver_str),
                released_at,
                f"AIME v{run['version']} 内部评测（{run['before_agent_label']} vs {run['after_agent_label']}）",
                bench_id,
                int(run["tier"]),
                int(run["requested_count"]),
                len(targets),
                run["status"],
                run["stage"],
                parse_timestamp(run.get("finished_at")),
                Jsonb({
                    "run_id": run["run_id"],
                    "legacy_meta": {
                        "version": run["version"],
                        "model": model,
                        "released_at": released_at.isoformat(),
                        "label": f"{run['version']} 内部评测",
                        "before_label": run["before_agent_label"],
                        "after_label": run["after_agent_label"],
                        "tier": len(targets) or int(run["tier"]),
                    },
                }),
            ),
        ).fetchone()
        round_id = int(rrow["round_id"])

        # Upsert targets
        target_id_by_ck: dict[str, int] = {}
        for t in targets:
            trow = conn.execute(
                """
                INSERT INTO public.ab_targets(
                    round_id, eq_index, case_key, source_input_id, source_trace_id,
                    question_text, turn_type, session_round, task_category, subtask_category,
                    bench_rank, bench_severity, extra
                )
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                ON CONFLICT (round_id, eq_index) DO UPDATE SET
                    question_text = EXCLUDED.question_text
                RETURNING target_id
                """,
                (
                    round_id,
                    int(t["eq_index"]),
                    t["case_key"],
                    t.get("source_input_id"),
                    clean_str(t.get("source_trace_id")),
                    clean_str(t.get("question")),
                    clean_str(t.get("turn")),
                    int(t.get("session_round") or 1),
                    clean_str(t.get("task")),
                    clean_str(t.get("subtask")),
                    int(t.get("bench_rank") or t["eq_index"]),
                    clean_str(t.get("bench_severity")),
                    Jsonb({"source_session_id": t.get("source_session_id") or "", "question_time": t.get("request_time") or ""}),
                ),
            ).fetchone()
            target_id_by_ck[t["case_key"]] = int(trow["target_id"])

        # Upsert candidates (1=before, 2=after)
        side_specs = [
            (1, "candidate_model_1", "before", True, run["before_agent_label"], run["before_agent"], before_cases),
            (2, "candidate_model_2", "after", False, run["after_agent_label"], run["after_agent"], after_cases),
        ]
        for idx, ckey, side, is_base, desc, acfg, cmap in side_specs:
            if side not in (run.get("sides") or []):
                continue
            sdir = round_dir / SIDE_DIR[side]
            cl_src = sdir / "cluster"
            cl_rel = None
            if cl_src.is_dir():
                cl_rel = f"ab_test/{model}/{yyyy}/{round_folder}/{ckey}/cluster"
                dst_cl = cfg.data_root / cl_rel
                dst_cl.mkdir(parents=True, exist_ok=True)
                for fn in CLUSTER_DELIVERABLES:
                    if (cl_src / fn).is_file():
                        shutil.copy2(cl_src / fn, dst_cl / fn)

            src_mode = "slice" if (side == "before" and run.get("before_mode") == "historical") else "live"
            crow = conn.execute(
                """
                INSERT INTO public.ab_candidates(
                    round_id, candidate_idx, candidate_key, description,
                    is_baseline, source_mode, agent_config, cluster_rel_dir, extra
                )
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)
                ON CONFLICT (round_id, candidate_key) DO UPDATE SET
                    description = EXCLUDED.description,
                    cluster_rel_dir = COALESCE(EXCLUDED.cluster_rel_dir, public.ab_candidates.cluster_rel_dir)
                RETURNING candidate_id
                """,
                (round_id, idx, ckey, desc, is_base, src_mode, Jsonb(acfg or {}), cl_rel, Jsonb({"legacy_side": side})),
            ).fetchone()
            cand_id = int(crow["candidate_id"])

            in_fid, in_map = _pack_file(
                conn, sdir / INPUT_FILENAME[side], ab_candidate_rel_path(model, yyyy, round_folder, ckey, "input"), "input"
            )
            attr_fid, attr_map = _pack_file(
                conn, sdir / "eval_output" / "attribution.jsonl", ab_candidate_rel_path(model, yyyy, round_folder, ckey, "attribution"), "attribution"
            )
            comp_fid, comp_map = _pack_file(
                conn, sdir / "eval_output" / "compact.jsonl", ab_candidate_rel_path(model, yyyy, round_folder, ckey, "compact"), "compact"
            )
            hr_fid, hr_map = _pack_file(
                conn,
                sdir / "eval_output" / "attribution_human_read.jsonl",
                ab_candidate_rel_path(model, yyyy, round_folder, ckey, "human_read"),
                "human_read",
                transform=lambda r: extract_human_read_delta(
                    r, "attribution", trace_id=clean_str((r.get("session_meta") or {}).get("trace_id")) or "", model=model, biz_day=released_at.isoformat()
                )[0],
            )

            for t in targets:
                ck = t["case_key"]
                eq = int(t["eq_index"])
                sc = cmap.get(ck) or {}
                c_tid = clean_str(sc.get("trace_id"))
                keys = [k for k in (ck, c_tid, clean_str(t.get("source_trace_id"))) if k]
                in_hit = next((in_map[k] for k in keys if k in in_map), None)
                attr_hit = next((attr_map[k] for k in keys if k in attr_map), None)
                comp_hit = next((comp_map[k] for k in keys if k in comp_map), None)
                hr_hit = next((hr_map[k] for k in keys if k in hr_map), None)
                sev_cnts = sc.get("severity_counts") if isinstance(sc.get("severity_counts"), dict) else {}
                c_row = conn.execute(
                    """
                    INSERT INTO public.ab_candidate_cases(
                        round_id, candidate_id, target_id, eq_index, status, failed_stage, error_code,
                        retry_count, trace_id, session_id, request_time,
                        input_file_id, input_offset, input_len,
                        attr_file_id, attr_offset, attr_len,
                        compact_file_id, compact_offset, compact_len,
                        hr_file_id, hr_offset, hr_len,
                        is_gold, problem_count, max_severity,
                        p0_cnt, p1_cnt, p2_cnt, p3_cnt, p4_cnt,
                        is_correct, change_seq
                    )
                    VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                    ON CONFLICT (round_id, candidate_id, target_id) DO UPDATE SET
                        status = EXCLUDED.status,
                        attr_file_id = COALESCE(EXCLUDED.attr_file_id, public.ab_candidate_cases.attr_file_id),
                        attr_offset = COALESCE(EXCLUDED.attr_offset, public.ab_candidate_cases.attr_offset),
                        attr_len = COALESCE(EXCLUDED.attr_len, public.ab_candidate_cases.attr_len),
                        problem_count = EXCLUDED.problem_count,
                        max_severity = EXCLUDED.max_severity,
                        updated_at = now()
                    RETURNING case_id
                    """,
                    (
                        round_id,
                        cand_id,
                        target_id_by_ck[ck],
                        eq,
                        "evaluated" if sc.get("status") == "ready" else (sc.get("status") or "missing"),
                        sc.get("failed_stage"),
                        sc.get("error_code"),
                        int(sc.get("retry_count") or 0),
                        c_tid,
                        clean_str(sc.get("session_id")),
                        parse_timestamp(sc.get("request_time")),
                        in_fid if in_hit else None,
                        in_hit[0] if in_hit else None,
                        in_hit[1] if in_hit else None,
                        attr_fid if attr_hit else None,
                        attr_hit[0] if attr_hit else None,
                        attr_hit[1] if attr_hit else None,
                        comp_fid if comp_hit else None,
                        comp_hit[0] if comp_hit else None,
                        comp_hit[1] if comp_hit else None,
                        hr_fid if hr_hit else None,
                        hr_hit[0] if hr_hit else None,
                        hr_hit[1] if hr_hit else None,
                        bool(sc.get("is_gold")),
                        int(sc.get("problem_count") or 0),
                        sc.get("max_severity") if sc.get("max_severity") in ("GOLD", "P0", "P1", "P2", "P3", "P4") else None,
                        int(sev_cnts.get("P0") or 0),
                        int(sev_cnts.get("P1") or 0),
                        int(sev_cnts.get("P2") or 0),
                        int(sev_cnts.get("P3") or 0),
                        int(sev_cnts.get("P4") or 0),
                        sc.get("is_correct"),
                        int(sc.get("change_seq") or eq),
                    ),
                ).fetchone()
                case_id = int(c_row["case_id"])
                conn.execute("DELETE FROM public.ab_candidate_problems WHERE case_id = %s", (case_id,))
                for pidx, prob in enumerate(sc.get("problems") or []):
                    cl_code = clean_str(prob.get("cluster_path"))
                    l1, l2, l3, l4 = split_cluster_code(cl_code)
                    sev = prob.get("severity") if prob.get("severity") in ("P0", "P1", "P2", "P3", "P4") else None
                    conn.execute(
                        """
                        INSERT INTO public.ab_candidate_problems(
                            round_id, case_id, candidate_id, eq_index, scope,
                            turn_index, problem_index, severity, component, label,
                            cluster_code, l1_stage, l2_mechanism, l3_leaf, l4_subleaf, is_edge
                        )
                        VALUES (%s,%s,%s,%s,'turn',0,%s,%s,%s,%s,%s,%s,%s,%s,%s,FALSE)
                        """,
                        (round_id, case_id, cand_id, eq, pidx, sev, clean_str(prob.get("component")), clean_str(prob.get("label")), cl_code, l1, l2, l3, l4),
                    )
        conn.commit()
    return {"round_id": round_id, "round_key": round_key}
