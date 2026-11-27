"""Idempotent Tail Reconciliation (`reconcile_tails`) for Blob-First Crash & PITR Self-Healing.

When PostgreSQL restarts after a crash or restores from a PITR backup up to
30+ minutes behind CephFS:
1. Scans active/recently modified `.jsonl.zst` pack files under `AIME_DATA_ROOT`
   (both registered in `pack_files` AND newly created pack files whose disk
   mtime is within `lookback_minutes`).
2. For any file where `disk_size > pack_files.committed_bytes`, streams every
   complete Zstd frame starting from `committed_bytes`.
3. Idempotently replays each frame into PG (`eval_inputs`, `eval_outputs` +
   `eval_problems`, `human_read_overlays`, `changes`) and advances
   `pack_files.committed_bytes` — guaranteeing ZERO lost blobs or outputs.
4. Reclaims any expired Step 2 leases (`eval_status = 'claimed'`).
"""

from __future__ import annotations

import re
import time
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any

from psycopg.types.json import Jsonb

from .core import DataCore
from .models import extract_attribution_fields, extract_input_fields
from .zst_pack import iter_frames, json_loads_bytes

DAILY_IN_RE = re.compile(r"^eval_input/(?P<model>[^/]+)/(?P<yyyy>\d{4})/(?P<mm>\d{2})(?P<dd>\d{2})/part_(?P<part>\d+)\.jsonl\.zst$")
DAILY_OUT_RE = re.compile(
    r"^eval_output/(?P<model>[^/]+)/(?P<yyyy>\d{4})/(?P<mm>\d{2})(?P<dd>\d{2})/(?P<kind>attribution|compact|human_read)_part_(?P<part>\d+)\.jsonl\.zst$"
)


def _discover_recent_daily_packs(data_root: Path, lookback_minutes: int) -> list[dict[str, Any]]:
    cutoff = time.time() - lookback_minutes * 60
    found: list[dict[str, Any]] = []
    for sub in ("eval_input", "eval_output"):
        base = data_root / sub
        if not base.is_dir():
            continue
        for p in base.rglob("*.jsonl.zst"):
            try:
                st = p.stat()
            except OSError:
                continue
            if st.st_mtime < cutoff:
                continue
            rel = p.relative_to(data_root).as_posix()
            m_in = DAILY_IN_RE.match(rel)
            if m_in:
                found.append(
                    {
                        "rel_path": rel,
                        "domain": "daily",
                        "kind": "input",
                        "model": m_in.group("model"),
                        "biz_day": date(int(m_in.group("yyyy")), int(m_in.group("mm")), int(m_in.group("dd"))),
                        "part_no": int(m_in.group("part")),
                        "disk_size": st.st_size,
                    }
                )
                continue
            m_out = DAILY_OUT_RE.match(rel)
            if m_out:
                found.append(
                    {
                        "rel_path": rel,
                        "domain": "daily",
                        "kind": m_out.group("kind"),
                        "model": m_out.group("model"),
                        "biz_day": date(int(m_out.group("yyyy")), int(m_out.group("mm")), int(m_out.group("dd"))),
                        "part_no": int(m_out.group("part")),
                        "disk_size": st.st_size,
                    }
                )
    return found


def reconcile_tails(dc: DataCore, *, lookback_minutes: int = 60, scan_all_active: bool = True) -> dict[str, Any]:
    """Idempotently replay any uncommitted Zstd tail frames into PostgreSQL."""
    data_root = dc.cfg.data_root
    report: dict[str, Any] = {
        "files_scanned": 0,
        "files_healed": 0,
        "records_recovered": 0,
        "bytes_recovered": 0,
        "leases_reclaimed": 0,
        "details": [],
    }

    # 1. Gather candidate pack files (DB active/recent + disk newly created)
    candidates: dict[str, dict[str, Any]] = {}
    with dc.db.connection() as conn:
        sql = """
            SELECT file_id, rel_path, domain, kind, model, biz_day, part_no, committed_bytes, status
            FROM public.pack_files
            WHERE domain = 'daily'
              AND (
                  (%s AND status = 'active')
                  OR updated_at >= now() - (%s || ' minutes')::interval
              )
        """
        for row in conn.execute(sql, (scan_all_active, int(lookback_minutes))).fetchall():
            candidates[row["rel_path"]] = dict(row)

    for disk_meta in _discover_recent_daily_packs(data_root, lookback_minutes):
        rel = disk_meta["rel_path"]
        if rel not in candidates:
            candidates[rel] = {
                "file_id": None,
                "rel_path": rel,
                "domain": disk_meta["domain"],
                "kind": disk_meta["kind"],
                "model": disk_meta["model"],
                "biz_day": disk_meta["biz_day"],
                "part_no": disk_meta["part_no"],
                "committed_bytes": 0,
                "status": "active",
            }

    # Order: input -> attribution -> compact -> human_read so parent rows exist first!
    kind_order = {"input": 0, "attribution": 1, "compact": 2, "human_read": 3}
    ordered = sorted(candidates.values(), key=lambda c: (kind_order.get(c["kind"], 9), c["rel_path"]))

    for item in ordered:
        rel = item["rel_path"]
        path = data_root / rel
        if not path.is_file():
            continue
        disk_size = path.stat().st_size
        committed = int(item["committed_bytes"] or 0)
        report["files_scanned"] += 1
        if disk_size <= committed:
            continue

        healed_records = 0
        new_committed = committed
        raw_added = 0

        with dc.db.transaction() as conn:
            # Ensure pack_files row exists
            pf = conn.execute(
                """
                INSERT INTO public.pack_files(domain, kind, model, biz_day, part_no, rel_path, status, committed_bytes)
                VALUES (%s, %s, %s, %s, %s, %s, 'active', %s)
                ON CONFLICT (rel_path) DO UPDATE SET updated_at = now()
                RETURNING file_id, committed_bytes
                """,
                (
                    item["domain"],
                    item["kind"],
                    item["model"],
                    item["biz_day"],
                    item["part_no"],
                    rel,
                    committed,
                ),
            ).fetchone()
            file_id = int(pf["file_id"])
            start_off = int(pf["committed_bytes"])
            new_committed = start_off

            for frame in iter_frames(path, start_offset=start_off, ignore_truncated_tail=True):
                try:
                    rec = json_loads_bytes(frame.payload)
                except ValueError:
                    new_committed = frame.offset + frame.length
                    continue

                kind = item["kind"]
                model = item["model"]
                day_str = item["biz_day"].isoformat() if item["biz_day"] else None

                if kind == "input":
                    parsed = extract_input_fields(rec, model, fallback_day=day_str, intent_tax=dc.intent_tax)
                    if parsed["trace_id"]:
                        dc._ensure_user(conn, parsed["user_id"], parsed["biz_day"], model)
                        conn.execute(
                            """
                            INSERT INTO public.eval_inputs(
                                product, model, trace_id, session_id, user_id, source, app_version,
                                runtime_mode, agent_id, batch_id, case_id, request_time, biz_day,
                                turn_index, session_round, is_multi_turn, question_text, question_norm, question_hash,
                                n_messages, n_observations, total_tokens, input_tokens, output_tokens, cache_read_tokens,
                                tool_count, latency_ms, answer_len, has_visual, visual_count,
                                task_category, subtask_category, intent_code, taxonomy_version, category_status,
                                has_input_blob, input_file_id, input_offset, input_len
                            )
                            VALUES (
                                %(product)s, %(model)s, %(trace_id)s, %(session_id)s, %(user_id)s, %(source)s, %(app_version)s,
                                %(runtime_mode)s, %(agent_id)s, %(batch_id)s, %(case_id)s, %(request_time)s, %(biz_day)s,
                                %(turn_index)s, %(session_round)s, %(is_multi_turn)s, %(question_text)s, %(question_norm)s, %(question_hash)s,
                                %(n_messages)s, %(n_observations)s, %(total_tokens)s, %(input_tokens)s, %(output_tokens)s, %(cache_read_tokens)s,
                                %(tool_count)s, %(latency_ms)s, %(answer_len)s, %(has_visual)s, %(visual_count)s,
                                %(task_category)s, %(subtask_category)s, %(intent_code)s, %(taxonomy_version)s, %(category_status)s,
                                TRUE, %(file_id)s, %(offset)s, %(length)s
                            )
                            ON CONFLICT (product, model, trace_id) DO UPDATE SET
                                has_input_blob = TRUE,
                                input_file_id = COALESCE(public.eval_inputs.input_file_id, EXCLUDED.input_file_id),
                                input_offset = COALESCE(public.eval_inputs.input_offset, EXCLUDED.input_offset),
                                input_len = COALESCE(public.eval_inputs.input_len, EXCLUDED.input_len),
                                updated_at = now()
                            """,
                            {**parsed, "file_id": file_id, "offset": frame.offset, "length": frame.length},
                        )
                        healed_records += 1

                elif kind == "attribution":
                    for attr in extract_attribution_fields(rec, model, fallback_day=day_str, intent_tax=dc.intent_tax):
                        # Skip if exact (attr_file_id, attr_offset) already committed
                        exists = conn.execute(
                            "SELECT 1 FROM public.eval_outputs WHERE attr_file_id = %s AND attr_offset = %s AND trace_id = %s LIMIT 1",
                            (file_id, frame.offset, attr["trace_id"]),
                        ).fetchone()
                        if exists:
                            continue
                        inp = conn.execute(
                            "SELECT input_id, biz_day, app_version FROM public.eval_inputs WHERE product=%s AND model=%s AND trace_id=%s",
                            (dc.cfg.product, model, attr["trace_id"]),
                        ).fetchone()
                        if inp is None:
                            dc._ensure_user(conn, attr["user_id"], attr["biz_day"], model)
                            inp = conn.execute(
                                """
                                INSERT INTO public.eval_inputs(
                                    product, model, trace_id, session_id, user_id, source, app_version,
                                    request_time, biz_day, question_text, n_messages, eval_status, has_input_blob, extra
                                )
                                VALUES (%s, %s, %s, %s, %s, 'prelaunch', %s, %s, %s, %s, %s, 'evaluated', FALSE, %s)
                                RETURNING input_id, biz_day, app_version
                                """,
                                (
                                    dc.cfg.product, model, attr["trace_id"], attr["session_id"], attr["user_id"],
                                    attr["app_version"], attr["request_time"], attr["biz_day"], attr["question_text"],
                                    attr["n_messages"], Jsonb({"synthetic_from_reconcile": True}),
                                ),
                            ).fetchone()
                        else:
                            conn.execute(
                                "UPDATE public.eval_inputs SET eval_status='evaluated', claimed_by=NULL, lease_expires_at=NULL, updated_at=now() WHERE input_id=%s",
                                (inp["input_id"],),
                            )

                        conn.execute(
                            "UPDATE public.eval_outputs SET is_latest=FALSE, updated_at=now() WHERE input_id=%s AND is_latest",
                            (inp["input_id"],),
                        )
                        out_row = conn.execute(
                            """
                            INSERT INTO public.eval_outputs(
                                input_id, product, model, trace_id, biz_day, evaluator_version, judge_model,
                                evaluated_at, is_latest, max_severity, p0_cnt, p1_cnt, p2_cnt, p3_cnt, p4_cnt,
                                problem_count, is_gold, is_correct, summary, session_summary,
                                attr_file_id, attr_offset, attr_len
                            )
                            VALUES (%s,%s,%s,%s,%s,%s,%s,COALESCE(%s, now()),TRUE,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                            RETURNING output_id
                            """,
                            (
                                inp["input_id"], dc.cfg.product, model, attr["trace_id"], inp["biz_day"],
                                attr["evaluator_version"], attr["judge_model"], attr["evaluated_at"],
                                attr["max_severity"], attr["p0_cnt"], attr["p1_cnt"], attr["p2_cnt"],
                                attr["p3_cnt"], attr["p4_cnt"], attr["problem_count"], attr["is_gold"],
                                attr["is_correct"], attr["summary"], attr["session_summary"],
                                file_id, frame.offset, frame.length,
                            ),
                        ).fetchone()
                        oid = int(out_row["output_id"])
                        for prob in attr["problems"]:
                            conn.execute(
                                """
                                INSERT INTO public.eval_problems(
                                    output_id, input_id, model, biz_day, trace_id,
                                    scope, turn_index, problem_index, severity,
                                    component, component_family, label, evidence_count, located_count
                                )
                                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                                ON CONFLICT (output_id, scope, turn_index, problem_index) DO NOTHING
                                """,
                                (
                                    oid, inp["input_id"], model, inp["biz_day"], attr["trace_id"],
                                    prob["scope"], prob["turn_index"], prob["problem_index"], prob["severity"],
                                    prob["component"], prob["component_family"], prob["label"],
                                    prob["evidence_count"], prob["located_count"],
                                ),
                            )
                        conn.execute(
                            """
                            INSERT INTO public.changes(
                                db_epoch, entity_type, op, human_only,
                                input_id, output_id, product, model, app_version, biz_day, trace_id
                            )
                            VALUES (%s, 'trace', 'upsert', FALSE, %s, %s, %s, %s, %s, %s, %s)
                            """,
                            (
                                dc.db_epoch, inp["input_id"], oid, dc.cfg.product, model,
                                inp["app_version"] or attr["app_version"], inp["biz_day"], attr["trace_id"],
                            ),
                        )
                        healed_records += 1

                elif kind == "compact":
                    smeta = rec.get("session_meta") if isinstance(rec.get("session_meta"), dict) else {}
                    tm = rec.get("trace_meta")
                    tid = smeta.get("trace_id") or (tm[0].get("trace_id") if isinstance(tm, list) and tm and isinstance(tm[0], dict) else None)
                    if tid:
                        res = conn.execute(
                            """
                            UPDATE public.eval_outputs
                            SET compact_file_id = %s, compact_offset = %s, compact_len = %s, updated_at = now()
                            WHERE model = %s AND trace_id = %s AND is_latest = TRUE AND compact_file_id IS NULL
                            """,
                            (file_id, frame.offset, frame.length, model, str(tid)),
                        )
                        if res.rowcount:
                            healed_records += res.rowcount

                elif kind == "human_read":
                    tid = rec.get("trace_id")
                    tkind = rec.get("target_kind")
                    hr_meta = rec.get("_human_read") if isinstance(rec.get("_human_read"), dict) else {}
                    if tid and tkind in ("attribution", "compact"):
                        out = conn.execute(
                            "SELECT output_id, input_id, biz_day FROM public.eval_outputs WHERE model=%s AND trace_id=%s AND is_latest=TRUE",
                            (model, str(tid)),
                        ).fetchone()
                        if out:
                            conn.execute(
                                """
                                INSERT INTO public.human_read_overlays(
                                    output_id, input_id, target_kind, status, prompt_version, translator_model,
                                    source_hash, hr_file_id, hr_offset, hr_len, translated_at
                                )
                                VALUES (%s, %s, %s, 'done', %s, %s, %s, %s, %s, %s, COALESCE(%s::timestamptz, now()))
                                ON CONFLICT (output_id, target_kind) DO UPDATE SET
                                    hr_file_id = EXCLUDED.hr_file_id,
                                    hr_offset = EXCLUDED.hr_offset,
                                    hr_len = EXCLUDED.hr_len,
                                    status = 'done',
                                    updated_at = now()
                                """,
                                (
                                    out["output_id"], out["input_id"], tkind,
                                    hr_meta.get("prompt_version"), hr_meta.get("model"),
                                    hr_meta.get("source_hash"), file_id, frame.offset, frame.length,
                                    hr_meta.get("translated_at"),
                                ),
                            )
                            healed_records += 1

                new_committed = frame.offset + frame.length
                raw_added += frame.raw_bytes

            if new_committed > start_off:
                conn.execute(
                    """
                    UPDATE public.pack_files
                    SET committed_bytes = %s,
                        uncompressed_bytes = uncompressed_bytes + %s,
                        record_count = record_count + %s,
                        updated_at = now()
                    WHERE file_id = %s
                    """,
                    (new_committed, raw_added, healed_records, file_id),
                )
                report["files_healed"] += 1
                report["records_recovered"] += healed_records
                report["bytes_recovered"] += new_committed - start_off
                report["details"].append(
                    {
                        "rel_path": rel,
                        "old_committed": start_off,
                        "new_committed": new_committed,
                        "records_recovered": healed_records,
                    }
                )

    # 2. Reclaim expired Step 2 leases
    with dc.db.transaction() as conn:
        res = conn.execute(
            """
            UPDATE public.eval_inputs
            SET eval_status = 'pending', claimed_by = NULL, lease_expires_at = NULL, updated_at = now()
            WHERE eval_status = 'claimed' AND lease_expires_at < %s
            """,
            (datetime.now(timezone.utc),),
        )
        report["leases_reclaimed"] = res.rowcount or 0

    return report
