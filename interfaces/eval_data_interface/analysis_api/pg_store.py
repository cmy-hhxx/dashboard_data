"""PostgreSQL 16 + Multi-Frame Zstd backend for 5003 `/api/v1/analysis/*`.

Activated when `ANALYSIS_BACKEND=pg` (Virginia AIME). Leaves Wencai's flat-file
SQLite backend 100% untouched. Eliminates `state/index.sqlite` and flat JSONL
scanning completely:
- `load_snapshot()` loads 208k+ real-user traces & 614k+ problems directly from
  PG 16 in ~3 seconds.
- `fetch_changes_rows()` reads `public.changes` directly from PG 16.
- `load_detail()` performs O(1) Zstd `pread_json` for raw input, attribution,
  and delta-only `human_read` overlay in < 2 ms.
"""

from __future__ import annotations

import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from . import config, errors, timeutil
from .taxonomy import Node, Tree


def _ensure_pg_core():
    for _cand in (Path("/opt/pg_data_core"), Path(__file__).resolve().parents[3]):
        if (_cand / "pg_data_core").is_dir() and str(_cand) not in sys.path:
            sys.path.insert(0, str(_cand))
    from pg_data_core.config import load_config
    from pg_data_core.db import connect_direct
    from pg_data_core.models import apply_human_read_delta
    from pg_data_core.zst_pack import pread_json

    return load_config, connect_direct, apply_human_read_delta, pread_json


def is_pg_enabled() -> bool:
    return os.environ.get("ANALYSIS_BACKEND", "").strip().lower() == "pg"


def pg_config():
    load_config, _, _, _ = _ensure_pg_core()
    return load_config(role="ro", data_root=os.environ.get("AIME_DATA_ROOT") or None)


def _fmt_iso(dt) -> str | None:
    if dt is None:
        return None
    if isinstance(dt, datetime):
        return timeutil.utc_rfc3339(dt.astimezone(timezone.utc) if dt.tzinfo else dt.replace(tzinfo=timezone.utc))
    return str(dt)


def load_problem_trees(cfg, log=print) -> dict[str, Tree]:
    """Load current per-model problem trees directly from PG `cluster_trees` + `cluster_nodes`."""
    _, connect_direct, _, _ = _ensure_pg_core()
    trees: dict[str, Tree] = {}
    with connect_direct(cfg, app_name="5003_trees") as conn:
        trows = conn.execute(
            """
            SELECT tree_id, model, version, generated_at
            FROM public.cluster_trees
            WHERE product = 'aime' AND is_current = TRUE
            ORDER BY model
            """
        ).fetchall()
        for tr in trows:
            nrows = conn.execute(
                """
                SELECT code, name_zh, parent_code, level, sort_order, definition, plain_desc
                FROM public.cluster_nodes
                WHERE tree_id = %s AND level >= 1
                ORDER BY level, sort_order, code
                """,
                (tr["tree_id"],),
            ).fetchall()
            nodes = [
                Node(
                    code=r["code"],
                    label=r["name_zh"] or r["code"],
                    parent=r["parent_code"],
                    level=int(r["level"]),
                    order=int(r["sort_order"]),
                    definition=r["definition"] or r["plain_desc"],
                )
                for r in nrows
            ]
            rel_at = _fmt_iso(tr["generated_at"])
            ver = str(tr["version"])
            tree = Tree(
                kind="problem",
                version=ver,
                status="current",
                released_at=rel_at,
                nodes=nodes,
                versions=[{"version": ver, "status": "current", "released_at": rel_at}],
                model=tr["model"],
            )
            trees[config.LAYOUT.tree_key(tr["model"])] = tree
    return trees


def load_snapshot(intent_tree, log=print):
    """Build a complete `snapshot.Snapshot` directly from PostgreSQL 16 (zero SQLite)."""
    from .snapshot import Snapshot, Trace

    _, connect_direct, _, _ = _ensure_pg_core()
    t0 = time.monotonic()
    cfg = pg_config()
    problem_trees = load_problem_trees(cfg, log=log)

    with connect_direct(cfg, app_name="5003_snapshot") as conn:
        # 1. Change stream head & db_epoch
        seq_row = conn.execute(
            """
            SELECT
                COALESCE(MAX(seq), 0) AS latest_seq,
                COALESCE(MAX(seq) FILTER (WHERE NOT human_only), 0) AS latest_seq_raw
            FROM public.changes
            """
        ).fetchone()
        latest_seq = int(seq_row["latest_seq"])
        latest_seq_raw = int(seq_row["latest_seq_raw"])

        ep_row = conn.execute("SELECT value FROM meta.runtime_kv WHERE key = 'db_epoch'").fetchone()
        db_epoch = str(ep_row["value"]) if ep_row else cfg.db_epoch

        ct_row = conn.execute(
            "SELECT MAX(data_cutoff) AS cutoff FROM public.cluster_trees WHERE product = 'aime' AND is_current = TRUE"
        ).fetchone()
        cluster_through = ct_row["cutoff"] if ct_row else None

        # 2. Load all problems for latest outputs in one streaming query
        probs_by_output: dict[int, list[dict[str, Any]]] = {}
        codes_by_output: dict[int, set[str]] = {}
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT p.output_id, p.scope, p.turn_index, p.problem_index,
                       p.cluster_code, p.label, p.severity,
                       COALESCE(p.component_family, p.component) AS comp
                FROM public.eval_problems p
                JOIN public.eval_outputs o ON o.output_id = p.output_id AND o.is_latest = TRUE
                ORDER BY p.output_id, (p.scope = 'session'), p.turn_index, p.problem_index
                """
            )
            for r in cur:
                oid = int(r["output_id"])
                code = r["cluster_code"]
                probs_by_output.setdefault(oid, []).append(
                    {
                        "code": code,
                        "label": r["label"],
                        "severity": r["severity"],
                        "component": r["comp"],
                        "session_level": r["scope"] == "session",
                    }
                )
                if code:
                    codes_by_output.setdefault(oid, set()).add(code)

        # 3. Load all latest outputs joined with inputs, users, human_read_overlays, pack_files
        traces: list[Trace] = []
        hidden: set[tuple[str, str, str]] = set()
        detail_map: dict[tuple[str, str, str], dict[str, Any]] = {}
        excluded = 0
        newest_at: str | None = None

        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT
                    o.output_id, o.input_id, o.model, o.trace_id, o.biz_day,
                    o.problem_count, o.p0_cnt, o.p1_cnt, o.p2_cnt, o.p3_cnt, o.p4_cnt,
                    o.is_correct, o.evaluated_at, o.updated_at,
                    o.attr_offset, o.attr_len, pf_a.rel_path AS attr_rel,
                    i.session_id, i.user_id, i.source, i.app_version, i.request_time,
                    i.question_text, i.intent_code, i.task_category, i.subtask_category,
                    i.input_offset, i.input_len, pf_i.rel_path AS in_rel,
                    COALESCE(u.is_real, FALSE) AS is_real,
                    hr.hr_labels, hr.hr_hash, hr.hr_offset, hr.hr_len, pf_h.rel_path AS hr_rel
                FROM public.eval_outputs o
                JOIN public.eval_inputs i ON i.input_id = o.input_id AND NOT i.is_deleted
                LEFT JOIN public.users u ON u.user_id = i.user_id
                LEFT JOIN public.pack_files pf_a ON pf_a.file_id = o.attr_file_id
                LEFT JOIN public.pack_files pf_i ON pf_i.file_id = i.input_file_id
                LEFT JOIN public.human_read_overlays hr
                    ON hr.output_id = o.output_id AND hr.target_kind = 'attribution' AND hr.status = 'done'
                LEFT JOIN public.pack_files pf_h ON pf_h.file_id = hr.hr_file_id
                WHERE o.is_latest = TRUE
                """
            )
            for r in cur:
                tid = r["trace_id"]
                day_str = r["biz_day"].isoformat()
                app_ver = r["app_version"] or f"{r['model']}_{r['model'].rsplit('_', 1)[-1]}"
                if not r["is_real"]:
                    excluded += 1
                    hidden.add((tid, day_str, app_ver))
                    continue

                oid = int(r["output_id"])
                sev: dict[str, int] = {}
                for k, col in (("P0", "p0_cnt"), ("P1", "p1_cnt"), ("P2", "p2_cnt"), ("P3", "p3_cnt"), ("P4", "p4_cnt")):
                    cnt = int(r[col] or 0)
                    if cnt > 0:
                        sev[k] = cnt

                probs = tuple(probs_by_output.get(oid, ()))
                pcodes = tuple(sorted(codes_by_output.get(oid, ())))
                asked_at = _fmt_iso(r["request_time"])
                analyzed_at = _fmt_iso(r["evaluated_at"] or r["updated_at"])
                if analyzed_at and (newest_at is None or analyzed_at > newest_at):
                    newest_at = analyzed_at

                hr_labels = tuple(r["hr_labels"]) if r["hr_labels"] is not None else None
                hr_ready = bool(r["hr_hash"] or r["hr_rel"])

                traces.append(
                    Trace(
                        trace_id=tid,
                        day=day_str,
                        app_version=app_ver,
                        asked_at=asked_at,
                        source=r["source"] or "prelaunch",
                        user_id=r["user_id"] or None,
                        question=r["question_text"],
                        session_id=r["session_id"] or None,
                        intent_code=r["intent_code"],
                        task=r["task_category"] if r["intent_code"] else None,
                        subtask=r["subtask_category"] if r["intent_code"] else None,
                        problem_codes=pcodes,
                        problem_count=int(r["problem_count"] or len(probs)),
                        problems=probs,
                        severity=sev,
                        is_correct=r["is_correct"],
                        analysis_id=f"pg_out_{oid}",
                        analyzed_at=analyzed_at,
                        file=r["attr_rel"] or "",
                        line=oid,
                        offset=int(r["attr_offset"] or 0),
                        hr_labels=hr_labels,
                        hr_ready=hr_ready,
                    )
                )
                detail_map[(tid, day_str, app_ver)] = {
                    "input_id": int(r["input_id"]),
                    "output_id": oid,
                    "attr_rel": r["attr_rel"],
                    "attr_off": r["attr_offset"],
                    "attr_len": r["attr_len"],
                    "in_rel": r["in_rel"],
                    "in_off": r["input_offset"],
                    "in_len": r["input_len"],
                    "hr_rel": r["hr_rel"],
                    "hr_off": r["hr_offset"],
                    "hr_len": r["hr_len"],
                }

    summary = {
        "backend": "postgresql_16",
        "traces": len(traces),
        "history": 0,
        "input_traces": len(traces),
        "test_excluded": excluded,
        "cluster_through": cluster_through,
        "db_epoch": db_epoch,
        "seconds": round(time.monotonic() - t0, 2),
    }
    snap = Snapshot(
        traces,
        intent_tree,
        problem_trees,
        newest_at,
        build_summary=summary,
        latest_seq=latest_seq,
        latest_seq_raw=latest_seq_raw,
    )
    snap.hidden = hidden
    snap._pg_detail_map = detail_map  # type: ignore[attr-defined]
    snap._pg_data_root = cfg.data_root  # type: ignore[attr-defined]
    snap._pg_db_epoch = db_epoch  # type: ignore[attr-defined]
    log(
        f"[pg_store] loaded Snapshot from PG 16 in {summary['seconds']}s: "
        f"real_traces={len(traces)}, test_excluded={excluded}, latest_seq={latest_seq}"
    )
    return snap


def fetch_changes_rows(since_seq: int, head_seq: int, after_seq: int, include_human: bool = False):
    """Query latest change per `(trace_id, biz_day, app_version)` in `(since_seq, head_seq]` from PG."""
    _, connect_direct, _, _ = _ensure_pg_core()
    cfg = pg_config()
    human_clause = "" if include_human else "AND NOT human_only"
    sql = f"""
        SELECT trace_id, biz_day, app_version, seq, op, changed_at
        FROM (
            SELECT DISTINCT ON (trace_id, biz_day, app_version)
                trace_id, biz_day, app_version, seq, op, changed_at
            FROM public.changes
            WHERE seq > %s AND seq <= %s {human_clause}
            ORDER BY trace_id, biz_day, app_version, seq DESC
        ) latest
        WHERE seq > %s
        ORDER BY seq ASC
    """
    with connect_direct(cfg, app_name="5003_changes") as conn:
        rows = conn.execute(sql, (since_seq, head_seq, after_seq)).fetchall()
    return [
        (
            r["trace_id"],
            r["biz_day"].isoformat() if r["biz_day"] else "",
            r["app_version"] or "",
            int(r["seq"]),
            r["op"],
            _fmt_iso(r["changed_at"]),
        )
        for r in rows
    ]


def load_detail(
    snap,
    dataset: str,
    trace_id: str,
    day: str | None,
    taxonomy_version=None,
    text_mode: str = "raw",
):
    """Serve `/api/v1/analysis/traces/{id}` via O(1) Zstd `pread_json` + PG metadata."""
    from . import human_read as hr_mod
    _, connect_direct, apply_human_read_delta, pread_json = _ensure_pg_core()
    from .snapshot import (
        _current_codes,
        _current_problems,
        _find_trace_object,
        _pick_turn_with_index,
        _problem_payload,
        _summary_problems,
        parse_text_mode,
    )

    text_mode = parse_text_mode(text_mode)
    if dataset not in config.DATASET_ALIASES:
        raise errors.unknown_value("dataset", dataset, sorted(config.DATASET_ALIASES))
    if not day:
        raise errors.invalid("day 必填：trace_id 只在单日内唯一", "day")
    try:
        datetime.strptime(day, "%Y-%m-%d")
    except ValueError as exc:
        raise errors.invalid("day 必须是 YYYY-MM-DD", "day") from exc

    candidates = [t for t in snap.by_id.get(trace_id, []) if t.day == day]
    if not candidates:
        reason = "test_user_excluded" if any(k[0] == trace_id and k[1] == day for k in snap.hidden) else "not_analyzed"
        cfg = pg_config()
        days = []
        try:
            with connect_direct(cfg, app_name="5003_404") as conn:
                days = [
                    r["biz_day"].isoformat()
                    for r in conn.execute(
                        "SELECT DISTINCT biz_day FROM public.eval_outputs WHERE trace_id = %s AND is_latest = TRUE ORDER BY biz_day",
                        (trace_id,),
                    ).fetchall()
                ]
        except Exception:
            pass
        extra = {"available_days": days} if days else {}
        if days and reason == "not_analyzed":
            reason = "day_mismatch"
        msg = {
            "test_user_excluded": "trace 属于测试账号，按供数口径不返回",
            "day_mismatch": "day 与索引不一致，用 available_days 里的日期重试",
            "not_analyzed": "trace 不存在或未分析",
        }[reason]
        raise errors.not_found(msg, trace_id=trace_id, day=day, reason=reason, **extra)

    trace = max(candidates, key=lambda t: (t.analyzed_at or "", t.line))
    dmap = getattr(snap, "_pg_detail_map", {})
    meta = dmap.get((trace.trace_id, trace.day, trace.app_version)) or {}
    data_root: Path = getattr(snap, "_pg_data_root", pg_config().data_root)

    # O(1) Zstd pread for raw attribution, raw input, and optional human_read delta
    attribution = None
    if meta.get("attr_rel") and meta.get("attr_len"):
        try:
            attribution = pread_json(data_root / meta["attr_rel"], int(meta["attr_off"]), int(meta["attr_len"]))
        except Exception:
            attribution = None

    input_row = None
    if meta.get("in_rel") and meta.get("in_len"):
        try:
            input_row = pread_json(data_root / meta["in_rel"], int(meta["in_off"]), int(meta["in_len"]))
        except Exception:
            input_row = None

    hr_applied = False
    if text_mode == "human" and attribution is not None and meta.get("hr_rel") and meta.get("hr_len"):
        try:
            delta = pread_json(data_root / meta["hr_rel"], int(meta["hr_off"]), int(meta["hr_len"]))
            attribution = apply_human_read_delta(attribution, delta, "attribution")
            hr_applied = True
        except Exception:
            hr_applied = False

    # Load exact problem codes + re-eval history from PG
    codes: dict[tuple[str, int], str] = {}
    history: list[dict[str, Any]] = []
    if meta.get("output_id"):
        cfg = pg_config()
        try:
            with connect_direct(cfg, app_name="5003_detail") as conn:
                for r in conn.execute(
                    "SELECT scope, problem_index, cluster_code FROM public.eval_problems WHERE output_id = %s",
                    (meta["output_id"],),
                ).fetchall():
                    if r["cluster_code"]:
                        codes[(r["scope"], int(r["problem_index"]))] = r["cluster_code"]

                for r in conn.execute(
                    """
                    SELECT o.output_id, o.evaluated_at, pf.rel_path
                    FROM public.eval_outputs o
                    LEFT JOIN public.pack_files pf ON pf.file_id = o.attr_file_id
                    WHERE o.input_id = %s AND NOT o.is_latest
                    ORDER BY o.evaluated_at DESC NULLS LAST, o.output_id DESC
                    """,
                    (meta["input_id"],),
                ).fetchall():
                    history.append(
                        {
                            "analysis_id": f"pg_out_{r['output_id']}",
                            "analyzed_at": _fmt_iso(r["evaluated_at"]),
                            "intent_code": trace.intent_code,
                            "problem_codes": [],
                            "file": (r["rel_path"] or "").rsplit("/", 1)[-1],
                            "line": int(r["output_id"]),
                        }
                    )
        except Exception:
            pass

    turn_index, turn = _pick_turn_with_index(attribution, trace_id) if attribution else (None, None)
    summary_text = (turn or {}).get("summary")
    session_summary = hr_mod.session_summary_text(attribution)

    problems = []
    if turn:
        for idx, prob in enumerate(turn.get("problem") or []):
            problems.append(_problem_payload(prob, codes.get(("turn", idx)), session_level=False))
        turns = (attribution or {}).get("turns") or []
        if turns and turn is turns[-1]:
            for idx, prob in enumerate((attribution or {}).get("session_problem") or []):
                problems.append(_problem_payload(prob, codes.get(("session", idx)), session_level=True))
    else:
        problems = [
            {"code": c, "label": c, "severity": None, "evidence": [], "session_level": False}
            for c in trace.problem_codes
        ]
    problems = _current_problems(snap, trace, problems)

    if text_mode == "raw":
        summary_problems, item_text_mode = _summary_problems(snap, trace, text_mode="raw")
    elif hr_applied:
        live_labels = [p.get("label") for p in problems]
        summary_problems, item_text_mode = _summary_problems(
            snap, trace, text_mode="human", override_labels=live_labels
        )
    elif turn is not None:
        summary_problems, item_text_mode = _current_problems(snap, trace), "fallback_raw"
    else:
        summary_problems, item_text_mode = _summary_problems(snap, trace, text_mode="human")

    return {
        "trace_id": trace.trace_id,
        "day": trace.day,
        "asked_at": trace.asked_at,
        "source": trace.source,
        "user_id": trace.user_id,
        "session_id": trace.session_id,
        "app_version": trace.app_version,
        "intent_code": trace.intent_code,
        "task": trace.task,
        "subtask": trace.subtask,
        "is_correct": trace.is_correct,
        "problem_count": trace.problem_count,
        "problem_codes": list(trace.problem_codes),
        "problem_current_codes": _current_codes(snap, trace),
        "problems": summary_problems,
        "text_mode": item_text_mode,
        "analysis_id": trace.analysis_id,
        "analyzed_at": trace.analyzed_at,
        "file": trace.file.rsplit("/", 1)[-1],
        "taxonomy_version": snap.taxonomy_version(),
        "session": input_row,
        "trace": _find_trace_object(input_row, trace_id) if input_row else None,
        "analysis": {
            "intent": {"task": trace.task, "subtask": trace.subtask, "code": trace.intent_code},
            "summary": summary_text,
            "session_summary": session_summary,
            "is_correct": trace.is_correct,
            "problems": problems,
            "history": history,
        },
    }
