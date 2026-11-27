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
from .bench_sampler import (
    ORIGIN_BENCH,
    ORIGIN_BOTH,
    ORIGIN_EXTRA,
    _extract_history_messages,
    normalize_extra_traces,
)

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


def validate_extra_traces_pg(
    extra_traces: list[dict[str, str]],
    *,
    model: str = "aime_expert",
) -> list[str]:
    """Return list of `trace_id`s from `extra_traces` that do NOT exist in PG `eval_inputs`."""
    norm = normalize_extra_traces(extra_traces)
    tids = [item["trace_id"] for item in norm if item.get("trace_id")]
    if not tids:
        return []
    (
        _Jsonb,
        load_config,
        connect_direct,
        *_rest,
    ) = _ensure_pg()
    cfg = load_config(role="ro", data_root=os.environ.get("AIME_DATA_ROOT") or None)
    with connect_direct(cfg, app_name="internal_eval_validate_extra") as conn:
        rows = conn.execute(
            """
            SELECT DISTINCT trace_id
            FROM public.eval_inputs
            WHERE product = 'aime' AND NOT is_deleted AND trace_id = ANY(%s)
            """,
            (tids,),
        ).fetchall()
    found = {str(r["trace_id"]) for r in rows}
    return [tid for tid in tids if tid not in found]


def sample_bench_targets_pg(
    model: str,
    tier: int,
    *,
    limit_override: int | None = None,
    extra_traces: list[dict[str, str]] | None = None,
    dedupe: bool = True,
    ignore_missing: bool = False,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Sample stratified bench targets from PG `bench_sets`/`bench_items` and optionally merge `extra_traces`."""
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
    norm_extra = normalize_extra_traces(extra_traces) if extra_traces else []

    def _read_history(in_path: str | None, in_offset: int | None, in_len: int | None, qtext: str) -> list[dict[str, Any]]:
        if not in_path or not in_len:
            return []
        try:
            inp_doc = pread_json(cfg.data_root / in_path, int(in_offset or 0), int(in_len))
            if isinstance(inp_doc, dict):
                traces = inp_doc.get("traces") if isinstance(inp_doc.get("traces"), list) else []
                t0 = traces[0] if traces and isinstance(traces[0], dict) else inp_doc
                probe = {
                    "question": qtext or "",
                    "messages": t0.get("messages") if isinstance(t0.get("messages"), list) else [],
                    "message_pool": t0.get("message_pool") or inp_doc.get("message_pool") or [],
                }
                return _extract_history_messages(probe)
        except Exception:  # noqa: BLE001
            return []
        return []

    targets: list[dict[str, Any]] = []
    by_trace_id: dict[str, dict[str, Any]] = {}
    bset: dict[str, Any] | None = None
    missing_tids: list[str] = []
    overlap_count = 0
    extra_added = 0

    with connect_direct(cfg, app_name="internal_eval_sampler") as conn:
        if target_limit > 0:
            bset = conn.execute(
                """
                SELECT bench_id, bench_key, tier_size, actual_count
                FROM public.bench_sets
                WHERE product = 'aime' AND model = %s AND bench_type = 'tier' AND tier_size >= %s
                ORDER BY tier_size ASC
                LIMIT 1
                """,
                (model, max(1, tier)),
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

            # Fallback to (product, model, trace_id) when bench_items.input_id is stale
            rows = conn.execute(
                """
                SELECT COALESCE(i.input_id, bi.input_id) AS input_id,
                       bi.trace_id,
                       COALESCE(i.session_id, bi.session_id) AS session_id,
                       bi.rank, bi.turn_type,
                       COALESCE(i.session_round, bi.session_round, 1) AS session_round,
                       COALESCE(o.max_severity, bi.severity) AS severity,
                       COALESCE(NULLIF(i.question_text, ''), bi.question_text) AS question_text,
                       bi.primary_cluster, bi.extra,
                       i.model AS input_model,
                       i.user_id, i.request_time, i.turn_index, i.task_category, i.subtask_category,
                       pf.rel_path AS in_path, i.input_offset, i.input_len
                FROM public.bench_items bi
                LEFT JOIN LATERAL (
                    SELECT ei.*
                    FROM public.eval_inputs ei
                    WHERE ei.product = 'aime' AND NOT ei.is_deleted
                      AND ((bi.input_id IS NOT NULL AND ei.input_id = bi.input_id)
                           OR (ei.model = %s AND ei.trace_id = bi.trace_id))
                    ORDER BY (ei.input_id = bi.input_id) DESC NULLS LAST, ei.input_id DESC
                    LIMIT 1
                ) i ON TRUE
                LEFT JOIN public.eval_outputs o ON o.input_id = i.input_id AND o.is_latest = TRUE
                LEFT JOIN public.pack_files pf ON pf.file_id = i.input_file_id
                WHERE bi.bench_id = %s
                ORDER BY bi.rank ASC
                LIMIT %s
                """,
                (model, bset["bench_id"], target_limit),
            ).fetchall()

            for r in rows:
                idx = len(targets) + 1
                case_key = f"eq_{idx:05d}"
                bex = r["extra"] if isinstance(r["extra"], dict) else {}
                bench_info = bex.get("bench") if isinstance(bex.get("bench"), dict) else {}
                turn = str(r["turn_type"] or ("multi" if int(r["session_round"] or 1) > 1 else "single")).lower()
                if turn not in ("single", "multi"):
                    turn = "single"
                sev = str(r["severity"] or "").strip().upper()
                qtext = str(r["question_text"] or "").strip()
                history_messages = (
                    _read_history(r["in_path"], r["input_offset"], r["input_len"], qtext)
                    if turn == "multi"
                    else []
                )
                req_str = (
                    r["request_time"].isoformat().replace("+00:00", "Z")
                    if r["request_time"] is not None
                    else str(bex.get("request_time") or "")
                )
                tid = str(r["trace_id"] or "")
                t_obj = {
                    "case_key": case_key,
                    "eq_index": idx,
                    "source_input_id": int(r["input_id"]) if r["input_id"] is not None else None,
                    "source_trace_id": tid,
                    "source_session_id": str(r["session_id"] or ""),
                    "source_model": str(r["input_model"] or model),
                    "source_origin": ORIGIN_BENCH,
                    "user_id": str(r["user_id"] or ""),
                    "model": model,
                    "question": qtext,
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
                }
                targets.append(t_obj)
                if tid:
                    by_trace_id.setdefault(tid, t_obj)

        bench_count = len(targets)

        # Merge extra_traces from PG eval_inputs (prefer target model, fallback to any model e.g. aime_fast)
        if norm_extra:
            lookup_tids = [
                item["trace_id"]
                for item in norm_extra
                if item.get("trace_id") and not (dedupe and item["trace_id"] in by_trace_id)
            ]
            pg_by_tid: dict[str, dict[str, Any]] = {}
            if lookup_tids:
                erows = conn.execute(
                    """
                    SELECT i.input_id, i.model, i.trace_id, i.session_id, i.user_id,
                           i.request_time, i.turn_index, i.session_round,
                           i.question_text, i.task_category, i.subtask_category,
                           pf.rel_path AS in_path, i.input_offset, i.input_len,
                           o.max_severity
                    FROM public.eval_inputs i
                    LEFT JOIN public.eval_outputs o ON o.input_id = i.input_id AND o.is_latest = TRUE
                    LEFT JOIN public.pack_files pf ON pf.file_id = i.input_file_id
                    WHERE i.product = 'aime' AND NOT i.is_deleted AND i.trace_id = ANY(%s)
                    ORDER BY (i.model = %s) DESC, i.input_id DESC
                    """,
                    (lookup_tids, model),
                ).fetchall()
                for er in erows:
                    etid = str(er["trace_id"] or "")
                    if etid and etid not in pg_by_tid:
                        pg_by_tid[etid] = dict(er)

            for item in norm_extra:
                tid = item.get("trace_id") or ""
                if tid:
                    if dedupe and tid in by_trace_id:
                        by_trace_id[tid]["source_origin"] = ORIGIN_BOTH
                        overlap_count += 1
                        continue
                    er = pg_by_tid.get(tid)
                    if er is None:
                        missing_tids.append(tid)
                        continue
                    idx = len(targets) + 1
                    case_key = f"eq_{idx:05d}"
                    sround = int(er.get("session_round") or 1)
                    tidx = int(er.get("turn_index") or 1)
                    turn = "multi" if (sround > 1 or tidx > 1) else "single"
                    qtext = str(er.get("question_text") or item.get("question") or "").strip()
                    history_messages = (
                        _read_history(er.get("in_path"), er.get("input_offset"), er.get("input_len"), qtext)
                        if turn == "multi"
                        else []
                    )
                    req_dt = er.get("request_time")
                    req_str = req_dt.isoformat().replace("+00:00", "Z") if req_dt is not None else ""
                    t_obj = {
                        "case_key": case_key,
                        "eq_index": idx,
                        "source_input_id": int(er["input_id"]),
                        "source_trace_id": tid,
                        "source_session_id": str(er.get("session_id") or ""),
                        "source_model": str(er.get("model") or model),
                        "source_origin": ORIGIN_EXTRA,
                        "user_id": str(er.get("user_id") or ""),
                        "model": model,
                        "question": qtext,
                        "turn": turn,
                        "session_round": sround,
                        "turn_index": tidx,
                        "request_time": req_str,
                        "batch_id": "",
                        "group": "",
                        "bench_rank": idx - 1,
                        "bench_seed": "",
                        "bench_severity": str(er.get("max_severity") or "").strip().upper(),
                        "bench_primary": {},
                        "task": str(er.get("task_category") or "").strip(),
                        "subtask": str(er.get("subtask_category") or "").strip(),
                        "history_messages": history_messages,
                    }
                    targets.append(t_obj)
                    by_trace_id.setdefault(tid, t_obj)
                    extra_added += 1
                else:
                    idx = len(targets) + 1
                    case_key = f"eq_{idx:05d}"
                    t_obj = {
                        "case_key": case_key,
                        "eq_index": idx,
                        "source_input_id": None,
                        "source_trace_id": "",
                        "source_session_id": "",
                        "source_model": model,
                        "source_origin": ORIGIN_EXTRA,
                        "user_id": "",
                        "model": model,
                        "question": str(item.get("question") or "").strip(),
                        "turn": "single",
                        "session_round": 1,
                        "turn_index": 1,
                        "request_time": "",
                        "batch_id": "",
                        "group": "",
                        "bench_rank": idx - 1,
                        "bench_seed": "",
                        "bench_severity": "",
                        "bench_primary": {},
                        "task": "",
                        "subtask": "",
                        "history_messages": [],
                    }
                    targets.append(t_obj)
                    extra_added += 1

    if missing_tids and not ignore_missing:
        raise ValueError(f"以下 {len(missing_tids)} 条 extra_traces 在 PG 中不存在：{missing_tids[:20]}")

    if not targets:
        raise ValueError("PG 抽题结果为空")

    single_count = sum(1 for t in targets if t["turn"] != "multi")
    multi_count = len(targets) - single_count
    severity_counts: dict[str, int] = {}
    origin_counts: dict[str, int] = {}
    source_model_counts: dict[str, int] = {}
    for t in targets:
        sev = t.get("bench_severity") or ""
        if sev:
            severity_counts[sev] = severity_counts.get(sev, 0) + 1
        orig = t.get("source_origin") or ORIGIN_BENCH
        origin_counts[orig] = origin_counts.get(orig, 0) + 1
        sm = t.get("source_model") or model
        source_model_counts[sm] = source_model_counts.get(sm, 0) + 1

    meta_summary = {
        "source_file": f"pg:bench_sets/{bset['bench_key']}" if bset else "pg:extra_traces_only",
        "bench_id": int(bset["bench_id"]) if bset else None,
        "model": model,
        "requested_count": target_limit,
        "bench_count": bench_count,
        "extra_requested_count": len(norm_extra),
        "extra_added_count": extra_added,
        "overlap_count": overlap_count,
        "missing_extra_trace_ids": missing_tids,
        "actual_count": len(targets),
        "shortfall": max(0, target_limit - bench_count),
        "single_turn": single_count,
        "multi_turn": multi_count,
        "origin_counts": origin_counts,
        "source_model_counts": source_model_counts,
        "bench_severity_distribution": severity_counts,
    }
    return targets, meta_summary


def load_historical_cases_pg(
    targets: list[dict[str, Any]],
    model: str,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], dict[str, Any]]:
    """Clone full existing PG eval_inputs / eval_outputs / eval_problems for Candidate 1 (`before_mode=historical`).

    Returns `(ready_cases, missing_targets, summary)`.
    """
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
        _pread_json,
    ) = _ensure_pg()

    cfg = load_config(role="ro", data_root=os.environ.get("AIME_DATA_ROOT") or None)
    input_ids = [int(t["source_input_id"]) for t in targets if t.get("source_input_id") is not None]
    tids = [str(t["source_trace_id"]) for t in targets if t.get("source_trace_id")]

    by_input_id: dict[int, dict[str, Any]] = {}
    by_trace_id: dict[str, dict[str, Any]] = {}
    probs_by_output: dict[int, list[dict[str, Any]]] = {}
    hr_done_outputs: set[int] = set()
    node_names: dict[str, str] = {}

    with connect_direct(cfg, app_name="internal_eval_hist_clone") as conn:
        for cn in conn.execute(
            """
            SELECT cn.code, cn.name_zh
            FROM public.cluster_nodes cn
            JOIN public.cluster_trees ct ON ct.tree_id = cn.tree_id
            WHERE ct.product = 'aime' AND ct.is_current = TRUE
            """
        ).fetchall():
            if cn["code"] and cn["name_zh"]:
                node_names.setdefault(str(cn["code"]), str(cn["name_zh"]))

        if input_ids or tids:
            rows = conn.execute(
                """
                SELECT i.input_id, i.model, i.trace_id, i.session_id, i.request_time,
                       o.output_id, o.is_gold, o.problem_count, o.max_severity,
                       o.is_correct, o.summary
                FROM public.eval_inputs i
                JOIN public.eval_outputs o ON o.input_id = i.input_id AND o.is_latest = TRUE
                WHERE i.product = 'aime' AND NOT i.is_deleted
                  AND (i.input_id = ANY(%s) OR i.trace_id = ANY(%s))
                ORDER BY (i.model = %s) DESC, i.input_id DESC
                """,
                (input_ids or [-1], tids or [""], model),
            ).fetchall()
            output_ids: list[int] = []
            for r in rows:
                rd = dict(r)
                iid = int(rd["input_id"])
                by_input_id[iid] = rd
                etid = str(rd["trace_id"] or "")
                if etid and etid not in by_trace_id:
                    by_trace_id[etid] = rd
                output_ids.append(int(rd["output_id"]))

            if output_ids:
                prows = conn.execute(
                    """
                    SELECT output_id, scope, turn_index, problem_index, severity,
                           component, label, cluster_code, is_edge
                    FROM public.eval_problems
                    WHERE output_id = ANY(%s)
                    ORDER BY output_id, CASE WHEN scope='turn' THEN 0 ELSE 1 END, turn_index, problem_index
                    """,
                    (output_ids,),
                ).fetchall()
                for pr in prows:
                    oid = int(pr["output_id"])
                    code = str(pr["cluster_code"] or "").strip() or None
                    probs_by_output.setdefault(oid, []).append(
                        {
                            "scope": str(pr["scope"] or "turn"),
                            "turn_index": int(pr["turn_index"] or 0),
                            "problem_index": int(pr["problem_index"] or 0),
                            "severity": str(pr["severity"] or ""),
                            "component": str(pr["component"] or ""),
                            "label": str(pr["label"] or ""),
                            "cluster_path": code,
                            "cluster_name": node_names.get(code, code) if code else None,
                            "is_edge": bool(pr["is_edge"]),
                        }
                    )
                for hr in conn.execute(
                    """
                    SELECT output_id
                    FROM public.human_read_overlays
                    WHERE output_id = ANY(%s) AND target_kind = 'attribution' AND status = 'done'
                    """,
                    (output_ids,),
                ).fetchall():
                    hr_done_outputs.add(int(hr["output_id"]))

    ready_cases: list[dict[str, Any]] = []
    missing_targets: list[dict[str, Any]] = []
    hr_done_count = 0

    for t in targets:
        hit = None
        if t.get("source_input_id") is not None:
            hit = by_input_id.get(int(t["source_input_id"]))
        if hit is None and t.get("source_trace_id"):
            hit = by_trace_id.get(str(t["source_trace_id"]))
        if hit is None:
            missing_targets.append(t)
            continue
        oid = int(hit["output_id"])
        if oid in hr_done_outputs:
            hr_done_count += 1
        req_dt = hit.get("request_time")
        req_str = req_dt.isoformat().replace("+00:00", "Z") if req_dt is not None else str(t.get("request_time") or "")
        ready_cases.append(
            {
                "case_key": t["case_key"],
                "linked_input_id": int(hit["input_id"]),
                "linked_output_id": oid,
                "trace_id": str(hit["trace_id"] or t.get("source_trace_id") or ""),
                "session_id": str(hit["session_id"] or t.get("source_session_id") or ""),
                "request_time": req_str,
                "max_severity": hit.get("max_severity"),
                "is_correct": hit.get("is_correct"),
                "attribution_summary": str(hit.get("summary") or ""),
                "problems": probs_by_output.get(oid, []),
                "source_tag": f"pg_slice:{hit['model']}",
            }
        )

    summary = {
        "total_targets": len(targets),
        "cloned_count": len(ready_cases),
        "missing_count": len(missing_targets),
        "hr_already_done": hr_done_count,
        "hr_missing": len(ready_cases) - hr_done_count,
    }
    return ready_cases, missing_targets, summary


def export_missing_historical_hr_inputs_pg(
    output_ids: list[int],
    export_dir: Path,
) -> dict[str, Any]:
    """Export input/attribution/compact JSONLs from PG Zstd packs for Candidate 1 outputs lacking `human_read`."""
    if not output_ids:
        return {"missing_count": 0}
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
    uniq_oids = sorted({int(x) for x in output_ids if x is not None})
    with connect_direct(cfg, app_name="internal_eval_hr_export") as conn:
        rows = conn.execute(
            """
            SELECT o.output_id, o.input_id, o.model, o.trace_id,
                   ipf.rel_path AS in_path, i.input_offset, i.input_len,
                   apf.rel_path AS attr_path, o.attr_offset, o.attr_len,
                   cpf.rel_path AS comp_path, o.compact_offset, o.compact_len
            FROM public.eval_outputs o
            JOIN public.eval_inputs i ON i.input_id = o.input_id
            LEFT JOIN public.pack_files ipf ON ipf.file_id = i.input_file_id
            LEFT JOIN public.pack_files apf ON apf.file_id = o.attr_file_id
            LEFT JOIN public.pack_files cpf ON cpf.file_id = o.compact_file_id
            LEFT JOIN public.human_read_overlays h
                   ON h.output_id = o.output_id AND h.target_kind = 'attribution' AND h.status = 'done'
            WHERE o.output_id = ANY(%s)
              AND h.overlay_id IS NULL
              AND apf.rel_path IS NOT NULL
              AND o.attr_len IS NOT NULL
            ORDER BY o.output_id ASC
            """,
            (uniq_oids,),
        ).fetchall()

    if not rows:
        return {"missing_count": 0}

    export_dir.mkdir(parents=True, exist_ok=True)
    input_path = export_dir / "pg_input.jsonl"
    attr_path = export_dir / "pg_attribution.jsonl"
    compact_path = export_dir / "pg_compact.jsonl"

    output_id_by_trace: dict[str, int] = {}
    exported = 0
    has_compact = False
    with (
        input_path.open("w", encoding="utf-8") as ifh,
        attr_path.open("w", encoding="utf-8") as afh,
        compact_path.open("w", encoding="utf-8") as cfh,
    ):
        for r in rows:
            attr_doc = pread_json(cfg.data_root / r["attr_path"], int(r["attr_offset"]), int(r["attr_len"]))
            if not isinstance(attr_doc, dict):
                continue
            tid = str(r["trace_id"] or "")
            oid = int(r["output_id"])
            if tid:
                output_id_by_trace[tid] = oid
            # Stamp trace_id in session_meta if missing so human_read output maps back reliably
            smeta = attr_doc.get("session_meta")
            if isinstance(smeta, dict) and tid and not smeta.get("trace_id"):
                smeta = dict(smeta)
                smeta["trace_id"] = tid
                attr_doc = dict(attr_doc)
                attr_doc["session_meta"] = smeta
            afh.write(json.dumps(attr_doc, ensure_ascii=False, separators=(",", ":")) + "\n")
            if r["in_path"] and r["input_len"]:
                inp_doc = pread_json(cfg.data_root / r["in_path"], int(r["input_offset"]), int(r["input_len"]))
                if isinstance(inp_doc, dict):
                    ifh.write(json.dumps(inp_doc, ensure_ascii=False, separators=(",", ":")) + "\n")
            if r["comp_path"] and r["compact_len"]:
                comp_doc = pread_json(cfg.data_root / r["comp_path"], int(r["compact_offset"]), int(r["compact_len"]))
                if isinstance(comp_doc, dict):
                    cfh.write(json.dumps(comp_doc, ensure_ascii=False, separators=(",", ":")) + "\n")
                    has_compact = True
            exported += 1

    if not has_compact and compact_path.is_file():
        compact_path.unlink(missing_ok=True)
        compact_out = None
    else:
        compact_out = compact_path

    return {
        "missing_count": exported,
        "input_path": input_path,
        "attribution_path": attr_path,
        "compact_path": compact_out,
        "output_id_by_trace": output_id_by_trace,
    }


def commit_historical_human_read_pg(
    hr_jsonl_path: Path,
    output_id_by_trace: dict[str, int],
) -> dict[str, Any]:
    """Persist translated Candidate 1 attribution records back into PG `human_read_overlays` + daily Zstd packs."""
    if not hr_jsonl_path.is_file() or not output_id_by_trace:
        return {"committed": 0, "skipped": 0}
    _ensure_pg()
    from pg_data_core.config import load_config
    from pg_data_core.core import DataCore

    cfg = load_config(role="rw", data_root=os.environ.get("AIME_DATA_ROOT") or None)
    committed = 0
    skipped = 0
    with DataCore(cfg) as core:
        with hr_jsonl_path.open("r", encoding="utf-8", errors="replace") as fh:
            for raw_line in fh:
                line = raw_line.strip()
                if not line:
                    continue
                try:
                    rec = json.loads(line)
                except ValueError:
                    skipped += 1
                    continue
                if not isinstance(rec, dict):
                    skipped += 1
                    continue
                smeta = rec.get("session_meta") if isinstance(rec.get("session_meta"), dict) else {}
                turns = rec.get("turns") if isinstance(rec.get("turns"), list) else []
                tmeta = (
                    turns[0].get("meta")
                    if turns and isinstance(turns[0], dict) and isinstance(turns[0].get("meta"), dict)
                    else {}
                )
                cand_tids = [
                    str(x).strip()
                    for x in (
                        tmeta.get("trace_id"),
                        smeta.get("trace_id"),
                        rec.get("trace_id"),
                    )
                    if x
                ]
                oid = next((output_id_by_trace[t] for t in cand_tids if t in output_id_by_trace), None)
                if oid is None:
                    skipped += 1
                    continue
                core.commit_human_read_overlay(output_id=oid, hr_record=rec, target_kind="attribution")
                committed += 1
    return {"committed": committed, "skipped": skipped}


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
    prefix = f"version_{ver_str}_{model}"
    if round_key != prefix:
        raw_suffix = round_key[len(prefix) + 1 :] if round_key.startswith(prefix + "_") else round_key
        suffix = re.sub(r"[^0-9A-Za-z._-]+", "_", raw_suffix).strip("_")
        if suffix:
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
                            for tk in (t["meta"].get("trace_id"), t["meta"].get("case_key")):
                                ks = clean_str(tk)
                                if ks:
                                    by_key[ks] = (ptr.offset, ptr.length, rec)
                    for tr in rec.get("traces") or []:
                        if isinstance(tr, dict):
                            trm = tr.get("meta") if isinstance(tr.get("meta"), dict) else {}
                            for tk in (tr.get("trace_id"), trm.get("trace_id"), trm.get("case_key")):
                                ks = clean_str(tk)
                                if ks:
                                    by_key[ks] = (ptr.offset, ptr.length, rec)
                    tmeta_list = rec.get("trace_meta")
                    if isinstance(tmeta_list, dict):
                        tmeta_list = [tmeta_list]
                    if isinstance(tmeta_list, list):
                        for tm in tmeta_list:
                            if isinstance(tm, dict):
                                ks = clean_str(tm.get("trace_id"))
                                if ks:
                                    by_key[ks] = (ptr.offset, ptr.length, rec)
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
        run_meta = run.get("meta") if isinstance(run.get("meta"), dict) else {}
        bench_id = (run_meta.get("bench_sampling") or {}).get("bench_id")
        custom_label = str(run_meta.get("label") or "").strip() or f"{run['version']} 内部评测"
        custom_title = (
            str(run_meta.get("title") or "").strip()
            or f"AIME v{run['version']} 内部评测（{run['before_agent_label']} vs {run['after_agent_label']}）"
        )
        rrow = conn.execute(
            """
            INSERT INTO public.ab_rounds(
                round_key, idempotency_key, product, model, version_tag, released_at, title,
                bench_id, tier_size, requested_count, actual_count, status, stage,
                finished_at, extra
            )
            VALUES (%s,%s,'aime',%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
            ON CONFLICT (round_key) DO UPDATE SET
                title = EXCLUDED.title,
                tier_size = EXCLUDED.tier_size,
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
                custom_title,
                bench_id,
                len(targets) or int(run["tier"]),
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
                        "label": custom_label,
                        "title": custom_title,
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
            origin = str(t.get("source_origin") or ORIGIN_BENCH)
            trow = conn.execute(
                """
                INSERT INTO public.ab_targets(
                    round_id, eq_index, case_key, source_input_id, source_trace_id,
                    question_text, turn_type, session_round, task_category, subtask_category,
                    bench_rank, bench_severity, extra
                )
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                ON CONFLICT (round_id, eq_index) DO UPDATE SET
                    question_text = EXCLUDED.question_text,
                    extra = EXCLUDED.extra
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
                    Jsonb(
                        {
                            "source_session_id": t.get("source_session_id") or "",
                            "question_time": t.get("request_time") or "",
                            "eval_category": origin,
                            "source_origin": origin,
                            "source_model": t.get("source_model") or model,
                        }
                    ),
                ),
            ).fetchone()
            target_id_by_ck[t["case_key"]] = int(trow["target_id"])

        # Resolve current PG cluster_tree dir for slice candidates
        ct_row = conn.execute(
            """
            SELECT artifact_rel_dir FROM public.cluster_trees
            WHERE product = 'aime' AND model = %s AND is_current = TRUE
            LIMIT 1
            """,
            (model,),
        ).fetchone()
        current_cluster_rel = str(ct_row["artifact_rel_dir"]) if ct_row and ct_row["artifact_rel_dir"] else None

        # Upsert candidates (1=before, 2=after)
        side_specs = [
            (1, "candidate_model_1", "before", True, run["before_agent_label"], run["before_agent"], before_cases),
            (2, "candidate_model_2", "after", False, run["after_agent_label"], run["after_agent"], after_cases),
        ]
        for idx, ckey, side, is_base, desc, acfg, cmap in side_specs:
            if side not in (run.get("sides") or []):
                continue
            src_mode = "slice" if (side == "before" and run.get("before_mode") == "historical") else "live"
            sdir = round_dir / SIDE_DIR[side]
            cl_src = sdir / "cluster"
            cl_rel = None
            if src_mode == "slice":
                cl_rel = current_cluster_rel
            elif cl_src.is_dir():
                cl_rel = f"ab_test/{model}/{yyyy}/{round_folder}/{ckey}/cluster"
                dst_cl = cfg.data_root / cl_rel
                dst_cl.mkdir(parents=True, exist_ok=True)
                for fn in CLUSTER_DELIVERABLES:
                    if (cl_src / fn).is_file():
                        shutil.copy2(cl_src / fn, dst_cl / fn)

            crow = conn.execute(
                """
                INSERT INTO public.ab_candidates(
                    round_id, candidate_idx, candidate_key, description,
                    is_baseline, source_mode, agent_config, cluster_rel_dir, extra
                )
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)
                ON CONFLICT (round_id, candidate_key) DO UPDATE SET
                    description = EXCLUDED.description,
                    source_mode = EXCLUDED.source_mode,
                    cluster_rel_dir = COALESCE(EXCLUDED.cluster_rel_dir, public.ab_candidates.cluster_rel_dir)
                RETURNING candidate_id
                """,
                (round_id, idx, ckey, desc, is_base, src_mode, Jsonb(acfg or {}), cl_rel, Jsonb({"legacy_side": side})),
            ).fetchone()
            cand_id = int(crow["candidate_id"])

            in_fid, in_map = (None, {})
            attr_fid, attr_map = (None, {})
            comp_fid, comp_map = (None, {})
            hr_fid, hr_map = (None, {})
            slice_hr_by_oid: dict[int, tuple[int, int, int]] = {}

            if src_mode == "slice":
                linked_oids = [
                    int(sc["linked_output_id"])
                    for sc in cmap.values()
                    if sc.get("linked_output_id") is not None
                ]
                if linked_oids:
                    for hr_row in conn.execute(
                        """
                        SELECT output_id, hr_file_id, hr_offset, hr_len
                        FROM public.human_read_overlays
                        WHERE output_id = ANY(%s)
                          AND target_kind = 'attribution'
                          AND status = 'done'
                          AND hr_file_id IS NOT NULL
                          AND hr_len IS NOT NULL
                        """,
                        (linked_oids,),
                    ).fetchall():
                        slice_hr_by_oid[int(hr_row["output_id"])] = (
                            int(hr_row["hr_file_id"]),
                            int(hr_row["hr_offset"]),
                            int(hr_row["hr_len"]),
                        )
            else:
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
                linked_iid = int(sc["linked_input_id"]) if sc.get("linked_input_id") is not None else None
                linked_oid = int(sc["linked_output_id"]) if sc.get("linked_output_id") is not None else None
                keys = [k for k in (ck, c_tid, clean_str(t.get("source_trace_id"))) if k]
                in_hit = next((in_map[k] for k in keys if k in in_map), None)
                attr_hit = next((attr_map[k] for k in keys if k in attr_map), None)
                comp_hit = next((comp_map[k] for k in keys if k in comp_map), None)
                hr_hit = next((hr_map[k] for k in keys if k in hr_map), None)
                if src_mode == "slice" and linked_oid in slice_hr_by_oid:
                    c_hr_fid, c_hr_off, c_hr_len = slice_hr_by_oid[linked_oid]
                elif hr_hit:
                    c_hr_fid, c_hr_off, c_hr_len = hr_fid, hr_hit[0], hr_hit[1]
                else:
                    c_hr_fid, c_hr_off, c_hr_len = None, None, None
                sev_cnts = sc.get("severity_counts") if isinstance(sc.get("severity_counts"), dict) else {}
                c_row = conn.execute(
                    """
                    INSERT INTO public.ab_candidate_cases(
                        round_id, candidate_id, target_id, eq_index, status, failed_stage, error_code,
                        retry_count, linked_input_id, linked_output_id,
                        trace_id, session_id, request_time,
                        input_file_id, input_offset, input_len,
                        attr_file_id, attr_offset, attr_len,
                        compact_file_id, compact_offset, compact_len,
                        hr_file_id, hr_offset, hr_len,
                        is_gold, problem_count, max_severity,
                        p0_cnt, p1_cnt, p2_cnt, p3_cnt, p4_cnt,
                        is_correct, change_seq
                    )
                    VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                    ON CONFLICT (round_id, candidate_id, target_id) DO UPDATE SET
                        status = EXCLUDED.status,
                        linked_input_id = COALESCE(EXCLUDED.linked_input_id, public.ab_candidate_cases.linked_input_id),
                        linked_output_id = COALESCE(EXCLUDED.linked_output_id, public.ab_candidate_cases.linked_output_id),
                        trace_id = COALESCE(EXCLUDED.trace_id, public.ab_candidate_cases.trace_id),
                        session_id = COALESCE(EXCLUDED.session_id, public.ab_candidate_cases.session_id),
                        request_time = COALESCE(EXCLUDED.request_time, public.ab_candidate_cases.request_time),
                        input_file_id = COALESCE(EXCLUDED.input_file_id, public.ab_candidate_cases.input_file_id),
                        input_offset = COALESCE(EXCLUDED.input_offset, public.ab_candidate_cases.input_offset),
                        input_len = COALESCE(EXCLUDED.input_len, public.ab_candidate_cases.input_len),
                        attr_file_id = COALESCE(EXCLUDED.attr_file_id, public.ab_candidate_cases.attr_file_id),
                        attr_offset = COALESCE(EXCLUDED.attr_offset, public.ab_candidate_cases.attr_offset),
                        attr_len = COALESCE(EXCLUDED.attr_len, public.ab_candidate_cases.attr_len),
                        compact_file_id = COALESCE(EXCLUDED.compact_file_id, public.ab_candidate_cases.compact_file_id),
                        compact_offset = COALESCE(EXCLUDED.compact_offset, public.ab_candidate_cases.compact_offset),
                        compact_len = COALESCE(EXCLUDED.compact_len, public.ab_candidate_cases.compact_len),
                        hr_file_id = COALESCE(EXCLUDED.hr_file_id, public.ab_candidate_cases.hr_file_id),
                        hr_offset = COALESCE(EXCLUDED.hr_offset, public.ab_candidate_cases.hr_offset),
                        hr_len = COALESCE(EXCLUDED.hr_len, public.ab_candidate_cases.hr_len),
                        is_gold = EXCLUDED.is_gold,
                        problem_count = EXCLUDED.problem_count,
                        max_severity = EXCLUDED.max_severity,
                        p0_cnt = EXCLUDED.p0_cnt,
                        p1_cnt = EXCLUDED.p1_cnt,
                        p2_cnt = EXCLUDED.p2_cnt,
                        p3_cnt = EXCLUDED.p3_cnt,
                        p4_cnt = EXCLUDED.p4_cnt,
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
                        linked_iid,
                        linked_oid,
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
                        c_hr_fid,
                        c_hr_off,
                        c_hr_len,
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
                    pscope = prob.get("scope") if prob.get("scope") in ("turn", "session") else "turn"
                    pturn = int(prob.get("turn_index") or 0)
                    p_ord = int(prob.get("problem_index") if prob.get("problem_index") is not None else pidx)
                    conn.execute(
                        """
                        INSERT INTO public.ab_candidate_problems(
                            round_id, case_id, candidate_id, eq_index, scope,
                            turn_index, problem_index, severity, component, label,
                            cluster_code, l1_stage, l2_mechanism, l3_leaf, l4_subleaf, is_edge
                        )
                        VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                        """,
                        (
                            round_id,
                            case_id,
                            cand_id,
                            eq,
                            pscope,
                            pturn,
                            p_ord,
                            sev,
                            clean_str(prob.get("component")),
                            clean_str(prob.get("label")),
                            cl_code,
                            l1,
                            l2,
                            l3,
                            l4,
                            bool(prob.get("is_edge", False)),
                        ),
                    )
        conn.commit()
    return {"round_id": round_id, "round_key": round_key}
