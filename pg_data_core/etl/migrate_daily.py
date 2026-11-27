"""ETL Stage 2: High-speed parallel migration of daily eval_input, eval_output (attribution + compact),
and human_read overlays (delta-only for both attribution & compact) into multi-frame `.jsonl.zst`
and PostgreSQL 16 via COPY.

Key guarantees:
- Strictly read-only on legacy `/mnt/aime_eval_ssd/1_aime/`.
- Deduplicates `(product, model, trace_id)` deterministically (highest completeness / newest wins),
  recording `extra.dup_count` and full dedup audit stats.
- Partitions BOTH `eval_input` and `eval_output` by canonical `America/New_York` `biz_day`,
  grouping traces by `session_id` into parts of <= 500 distinct sessions.
- Preserves historical orphan attributions (attributions whose raw input is absent) by inserting
  synthetic `eval_inputs` rows (`has_input_blob = FALSE`) so zero evaluations are lost and counts
  reconcile 100% with live 5001 and 5003.
"""

from __future__ import annotations

import json
import os
import re
import time
from concurrent.futures import ProcessPoolExecutor, as_completed
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any

from psycopg.types.json import Jsonb

from ..config import DataCoreConfig
from ..core import ASSETS_DIR
from ..db import connect_direct, get_or_init_db_epoch
from ..models import (
    IntentTaxonomy,
    UserRules,
    clean_str,
    decode_question,
    extract_attribution_fields,
    extract_human_read_delta,
    extract_input_fields,
    normalize_question,
    ny_biz_day,
    parse_timestamp,
    question_hash,
)
from ..zst_pack import (
    BulkPackWriter,
    daily_input_rel_path,
    daily_output_rel_path,
    json_loads_bytes,
)

DATE_RE = re.compile(r"(\d{4}-\d{2}-\d{2})")
READ_BUF = 8 << 20


def _file_date(path: Path) -> str:
    m = DATE_RE.search(path.name)
    return m.group(1) if m else "1970-01-01"


def load_category_meta(legacy_root: Path) -> dict[str, tuple[str | None, str | None]]:
    """Load `0_litefusion_data/online_data/*/*/*/category_meta.json` (same as live 5003)."""
    base = legacy_root / "0_litefusion_data" / "online_data"
    if not base.is_dir():
        return {}
    index: dict[str, tuple[str | None, str | None]] = {}
    for p in sorted(base.glob("*/[0-9][0-9]/[0-9][0-9]/category_meta.json")):
        try:
            data = json_loads_bytes(p.read_bytes())
        except (OSError, ValueError):
            continue
        if not isinstance(data, dict):
            continue
        for tid, item in data.items():
            if not isinstance(item, dict):
                continue
            task = clean_str(item.get("task_category"))
            sub = clean_str(item.get("subtask_category"))
            if task or sub:
                index[str(tid)] = (task, sub)
    return index


def _pread_line(fds: dict[str, int], path: str, offset: int, length: int) -> bytes:
    fd = fds.get(path)
    if fd is None:
        fd = os.open(path, os.O_RDONLY)
        fds[path] = fd
    chunks = []
    rem = length
    pos = offset
    while rem > 0:
        c = os.pread(fd, rem, pos)
        if not c:
            break
        chunks.append(c)
        pos += len(c)
        rem -= len(c)
    return b"".join(chunks) if len(chunks) > 1 else (chunks[0] if chunks else b"")


def _close_fds(fds: dict[str, int]) -> None:
    for fd in fds.values():
        try:
            os.close(fd)
        except OSError:
            pass
    fds.clear()


# =============================================================================
# PASS 1 WORKERS (READ-ONLY PARALLEL INDEXING)
# =============================================================================


def _scan_input_file_worker(args: tuple[str, str]) -> list[tuple[Any, ...]]:
    path_str, model = args
    path = Path(path_str)
    fdate = _file_date(path)
    rows: list[tuple[Any, ...]] = []
    offset = 0
    with path.open("rb", buffering=READ_BUF) as fh:
        for line_no, raw in enumerate(fh, 1):
            ln = len(raw)
            cur_off = offset
            offset += ln
            if not raw.strip():
                continue
            try:
                rec = json_loads_bytes(raw)
            except ValueError:
                continue
            meta = rec.get("meta") if isinstance(rec.get("meta"), dict) else {}
            traces = rec.get("traces") if isinstance(rec.get("traces"), list) else []
            t0 = traces[0] if traces and isinstance(traces[0], dict) else {}
            t0_meta = t0.get("meta") if isinstance(t0.get("meta"), dict) else {}

            tid = (
                clean_str(rec.get("trace_id"))
                or clean_str(meta.get("trace_id"))
                or clean_str(t0_meta.get("trace_id"))
                or clean_str(t0.get("trace_id"))
                or clean_str(meta.get("lf_trace_id"))
            )
            if not tid:
                continue
            sid = clean_str(meta.get("session_id")) or clean_str(t0_meta.get("session_id")) or ""
            req_dt = (
                parse_timestamp(t0_meta.get("timestamp"))
                or parse_timestamp(rec.get("request_time"))
                or parse_timestamp(meta.get("request_time"))
                or parse_timestamp(meta.get("lf_start_time"))
            )
            bday = ny_biz_day(req_dt, fdate).isoformat()
            has_cat = 1 if (meta.get("task_category") or meta.get("task")) else 0
            n_msgs = int(meta.get("n_messages") or t0_meta.get("n_messages") or len(t0.get("messages") or []) or 0)
            rows.append((tid, bday, sid, has_cat, n_msgs, fdate, line_no, path_str, cur_off, ln))
    return rows


def _scan_output_file_worker(args: tuple[str, str]) -> list[tuple[Any, ...]]:
    """Scan attribution / compact / human_read JSONL file and extract lightweight index entries."""
    path_str, kind = args
    path = Path(path_str)
    fdate = _file_date(path)
    rows: list[tuple[Any, ...]] = []
    offset = 0
    with path.open("rb", buffering=READ_BUF) as fh:
        for line_no, raw in enumerate(fh, 1):
            ln = len(raw)
            cur_off = offset
            offset += ln
            if not raw.strip():
                continue
            try:
                rec = json_loads_bytes(raw)
            except ValueError:
                continue
            smeta = rec.get("session_meta") if isinstance(rec.get("session_meta"), dict) else {}
            sid = clean_str(smeta.get("session_id") or smeta.get("thread_id")) or ""
            rt = clean_str(smeta.get("request_time")) or ""

            tids: list[str] = []
            for t in rec.get("turns") or []:
                if isinstance(t, dict) and isinstance(t.get("meta"), dict):
                    tid = clean_str(t["meta"].get("trace_id"))
                    if tid and tid not in tids:
                        tids.append(tid)
            # For attribution records, turns[].meta.trace_id is the sole authoritative trace_id
            # (pre-Nov-9 records often erroneously copied session_id into session_meta.trace_id).
            if kind != "attr" or not tids:
                tm = rec.get("trace_meta")
                if isinstance(tm, list):
                    for item in tm:
                        if isinstance(item, dict):
                            tid = clean_str(item.get("trace_id"))
                            if tid and not tid.startswith("thread_") and tid != sid and tid not in tids:
                                tids.append(tid)
                elif isinstance(tm, dict):
                    tid = clean_str(tm.get("trace_id"))
                    if tid and not tid.startswith("thread_") and tid != sid and tid not in tids:
                        tids.append(tid)
                if not tids:
                    for cand in (smeta.get("lf_trace_id"), smeta.get("trace_id"), rec.get("trace_id")):
                        tid = clean_str(cand)
                        if tid and not tid.startswith("thread_") and tid != sid and tid not in tids:
                            tids.append(tid)

            if not tids and not (sid and rt):
                continue
            rows.append((tids, sid, rt, fdate, line_no, path_str, cur_off, ln))
    return rows


# =============================================================================
# PASS 2 WORKERS (PARALLEL ZSTD PACKING BY BIZ_DAY)
# =============================================================================


def _slice_by_sessions(items: list[dict[str, Any]], max_sessions: int) -> list[list[dict[str, Any]]]:
    """Group items by `session_id` and pack into parts of <= `max_sessions` distinct sessions."""
    by_sess: dict[str, list[dict[str, Any]]] = {}
    for it in items:
        skey = it.get("session_id") or f"__trace__{it['trace_id']}"
        by_sess.setdefault(skey, []).append(it)

    parts: list[list[dict[str, Any]]] = []
    cur_part: list[dict[str, Any]] = []
    cur_sess_cnt = 0
    for skey in sorted(by_sess.keys()):
        if cur_sess_cnt >= max_sessions and cur_part:
            parts.append(cur_part)
            cur_part = []
            cur_sess_cnt = 0
        cur_part.extend(by_sess[skey])
        cur_sess_cnt += 1
    if cur_part:
        parts.append(cur_part)
    return parts


def _pack_input_day_worker(args: tuple[Any, ...]) -> dict[str, Any]:
    """Pack all winning inputs for one `(model, biz_day)` into `part_XXXX.jsonl.zst`."""
    model, biz_day_str, items, data_root_str, zstd_level, max_sessions, cat_meta_subset = args
    data_root = Path(data_root_str)
    intent_file = ASSETS_DIR / "intent_2026-11.json"
    intent_tax = IntentTaxonomy.from_file(intent_file) if intent_file.is_file() else None

    parts = _slice_by_sessions(items, max_sessions)
    pack_metas: list[dict[str, Any]] = []
    input_rows: list[dict[str, Any]] = []
    fds: dict[str, int] = {}

    try:
        for part_no, part_items in enumerate(parts):
            rel_path = daily_input_rel_path(model, biz_day_str, part_no)
            dst_path = data_root / rel_path
            # Sort by (source_file, offset) before writing? Wait: keep session grouping for locality,
            # CephFS page cache handles sequential files nicely.
            sess_set: set[str] = set()
            # Sort reads within the part sequentially by source file & offset for CephFS throughput
            part_items_sorted = sorted(part_items, key=lambda x: (x["src_path"], x["src_off"]))
            with BulkPackWriter(dst_path, rel_path, level=zstd_level) as w:
                for it in part_items_sorted:
                    raw = _pread_line(fds, it["src_path"], it["src_off"], it["src_len"])
                    rec = json_loads_bytes(raw)
                    ptr = w.write_record(raw)
                    parsed = extract_input_fields(rec, model, fallback_day=biz_day_str, intent_tax=intent_tax)

                    # Fill empty category from upstream category_meta.json (same fallback as 5003)
                    if not parsed["task_category"] and parsed["trace_id"] in cat_meta_subset:
                        cm_t, cm_st = cat_meta_subset[parsed["trace_id"]]
                        if intent_tax is not None:
                            ic, tc, stc, tv = intent_tax.resolve(cm_t, cm_st)
                        else:
                            ic, tc, stc, tv = None, cm_t, cm_st, None
                        if tc or stc:
                            parsed["intent_code"] = ic
                            parsed["task_category"] = tc
                            parsed["subtask_category"] = stc
                            parsed["taxonomy_version"] = tv
                            parsed["category_status"] = "done"

                    parsed["biz_day"] = biz_day_str
                    parsed["rel_path"] = rel_path
                    parsed["input_offset"] = ptr.offset
                    parsed["input_len"] = ptr.length
                    parsed["dup_count"] = it["dup_count"]
                    if parsed["session_id"]:
                        sess_set.add(parsed["session_id"])
                    input_rows.append(parsed)
                sha = w.close()

            pack_metas.append(
                {
                    "rel_path": rel_path,
                    "domain": "daily",
                    "kind": "input",
                    "model": model,
                    "biz_day": biz_day_str,
                    "part_no": part_no,
                    "status": "sealed",
                    "committed_bytes": w.committed_bytes,
                    "uncompressed_bytes": w.uncompressed_bytes,
                    "record_count": w.record_count,
                    "session_count": len(sess_set) or w.record_count,
                    "sha256": sha,
                }
            )
    finally:
        _close_fds(fds)

    return {"biz_day": biz_day_str, "packs": pack_metas, "rows": input_rows}


def _pack_output_day_worker(args: tuple[Any, ...]) -> dict[str, Any]:
    """Pack attribution, compact, and human_read deltas for one `(model, biz_day)`."""
    model, biz_day_str, items, data_root_str, zstd_level, max_sessions = args
    data_root = Path(data_root_str)
    intent_file = ASSETS_DIR / "intent_2026-11.json"
    intent_tax = IntentTaxonomy.from_file(intent_file) if intent_file.is_file() else None

    parts = _slice_by_sessions(items, max_sessions)
    pack_metas: list[dict[str, Any]] = []
    out_rows: list[dict[str, Any]] = []
    fds: dict[str, int] = {}

    try:
        for part_no, part_items in enumerate(parts):
            attr_rel = daily_output_rel_path(model, biz_day_str, "attribution", part_no)
            comp_rel = daily_output_rel_path(model, biz_day_str, "compact", part_no)
            hr_rel = daily_output_rel_path(model, biz_day_str, "human_read", part_no)

            attr_w = BulkPackWriter(data_root / attr_rel, attr_rel, level=zstd_level)
            comp_w: BulkPackWriter | None = None
            hr_w: BulkPackWriter | None = None

            attr_sess: set[str] = set()
            comp_sess: set[str] = set()
            hr_sess: set[str] = set()

            try:
                part_items_sorted = sorted(part_items, key=lambda x: (x["attr_path"], x["attr_off"]))
                for it in part_items_sorted:
                    tid = it["trace_id"]
                    raw_attr = _pread_line(fds, it["attr_path"], it["attr_off"], it["attr_len"])
                    attr_rec = json_loads_bytes(raw_attr)
                    attr_ptr = attr_w.write_record(raw_attr)
                    if it.get("session_id"):
                        attr_sess.add(it["session_id"])

                    parsed_list = extract_attribution_fields(attr_rec, model, fallback_day=biz_day_str, intent_tax=intent_tax)
                    parsed = next((x for x in parsed_list if x["trace_id"] == tid), parsed_list[0] if parsed_list else None)
                    if parsed is None:
                        continue

                    comp_ptr = None
                    if it.get("comp_loc"):
                        cp_path, cp_off, cp_len = it["comp_loc"]
                        raw_comp = _pread_line(fds, cp_path, cp_off, cp_len)
                        if comp_w is None:
                            comp_w = BulkPackWriter(data_root / comp_rel, comp_rel, level=zstd_level)
                        comp_ptr = comp_w.write_record(raw_comp)
                        if it.get("session_id"):
                            comp_sess.add(it["session_id"])

                    hr_entries: list[dict[str, Any]] = []
                    for tkind, loc_key in (("attribution", "hr_attr_loc"), ("compact", "hr_comp_loc")):
                        loc = it.get(loc_key)
                        if not loc:
                            continue
                        hp_path, hp_off, hp_len = loc
                        raw_hr = _pread_line(fds, hp_path, hp_off, hp_len)
                        try:
                            hr_rec = json_loads_bytes(raw_hr)
                        except ValueError:
                            continue
                        delta, hr_labels, hr_hash = extract_human_read_delta(
                            hr_rec, tkind, trace_id=tid, model=model, biz_day=biz_day_str
                        )
                        if hr_w is None:
                            hr_w = BulkPackWriter(data_root / hr_rel, hr_rel, level=zstd_level)
                        hr_ptr = hr_w.write_record(delta)
                        if it.get("session_id"):
                            hr_sess.add(it["session_id"])
                        hr_meta = delta.get("_human_read") or {}
                        hr_entries.append(
                            {
                                "target_kind": tkind,
                                "prompt_version": clean_str(hr_meta.get("prompt_version")),
                                "translator_model": clean_str(hr_meta.get("model")),
                                "source_hash": clean_str(hr_meta.get("source_hash")),
                                "hr_hash": hr_hash,
                                "hr_labels": hr_labels,
                                "hr_rel": hr_rel,
                                "hr_offset": hr_ptr.offset,
                                "hr_len": hr_ptr.length,
                                "translated_at": parse_timestamp(hr_meta.get("translated_at")),
                            }
                        )

                    out_rows.append(
                        {
                            "input_id": it["input_id"],
                            "trace_id": tid,
                            "biz_day": biz_day_str,
                            "parsed": parsed,
                            "attr_rel": attr_rel,
                            "attr_offset": attr_ptr.offset,
                            "attr_len": attr_ptr.length,
                            "comp_rel": comp_rel if comp_ptr else None,
                            "comp_offset": comp_ptr.offset if comp_ptr else None,
                            "comp_len": comp_ptr.length if comp_ptr else None,
                            "hr_entries": hr_entries,
                        }
                    )
            finally:
                attr_sha = attr_w.close()
                pack_metas.append(
                    {
                        "rel_path": attr_rel,
                        "domain": "daily",
                        "kind": "attribution",
                        "model": model,
                        "biz_day": biz_day_str,
                        "part_no": part_no,
                        "status": "sealed",
                        "committed_bytes": attr_w.committed_bytes,
                        "uncompressed_bytes": attr_w.uncompressed_bytes,
                        "record_count": attr_w.record_count,
                        "session_count": len(attr_sess) or attr_w.record_count,
                        "sha256": attr_sha,
                    }
                )
                if comp_w is not None:
                    comp_sha = comp_w.close()
                    pack_metas.append(
                        {
                            "rel_path": comp_rel,
                            "domain": "daily",
                            "kind": "compact",
                            "model": model,
                            "biz_day": biz_day_str,
                            "part_no": part_no,
                            "status": "sealed",
                            "committed_bytes": comp_w.committed_bytes,
                            "uncompressed_bytes": comp_w.uncompressed_bytes,
                            "record_count": comp_w.record_count,
                            "session_count": len(comp_sess) or comp_w.record_count,
                            "sha256": comp_sha,
                        }
                    )
                if hr_w is not None:
                    hr_sha = hr_w.close()
                    pack_metas.append(
                        {
                            "rel_path": hr_rel,
                            "domain": "daily",
                            "kind": "human_read",
                            "model": model,
                            "biz_day": biz_day_str,
                            "part_no": part_no,
                            "status": "sealed",
                            "committed_bytes": hr_w.committed_bytes,
                            "uncompressed_bytes": hr_w.uncompressed_bytes,
                            "record_count": hr_w.record_count,
                            "session_count": len(hr_sess) or hr_w.record_count,
                            "sha256": hr_sha,
                        }
                    )
    finally:
        _close_fds(fds)

    return {"biz_day": biz_day_str, "packs": pack_metas, "rows": out_rows}


# =============================================================================
# ORCHESTRATION & PG BULK COPY
# =============================================================================


def _upsert_pack_files(conn, pack_metas: list[dict[str, Any]]) -> dict[str, int]:
    rel_to_id: dict[str, int] = {}
    for pm in pack_metas:
        row = conn.execute(
            """
            INSERT INTO public.pack_files(
                rel_path, domain, kind, model, biz_day, part_no, status,
                committed_bytes, uncompressed_bytes, record_count, session_count, sha256
            )
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
            ON CONFLICT (rel_path) DO UPDATE SET
                committed_bytes = EXCLUDED.committed_bytes,
                uncompressed_bytes = EXCLUDED.uncompressed_bytes,
                record_count = EXCLUDED.record_count,
                session_count = EXCLUDED.session_count,
                sha256 = EXCLUDED.sha256,
                status = EXCLUDED.status,
                updated_at = now()
            RETURNING file_id
            """,
            (
                pm["rel_path"],
                pm["domain"],
                pm["kind"],
                pm["model"],
                pm["biz_day"],
                pm["part_no"],
                pm["status"],
                pm["committed_bytes"],
                pm["uncompressed_bytes"],
                pm["record_count"],
                pm["session_count"],
                pm["sha256"],
            ),
        ).fetchone()
        rel_to_id[pm["rel_path"]] = int(row["file_id"])
    return rel_to_id


def _ensure_users_batch(conn, user_stats: dict[str, tuple[date, date, int, set[str]]], rules: UserRules) -> None:
    if not user_stats:
        return
    sig = rules.signature()
    rows = []
    for uid, (fday, lday, cnt, models) in user_stats.items():
        if not uid:
            continue
        utype, is_real, is_lost = rules.classify(uid)
        rows.append((uid, utype, is_real, is_lost, fday, lday, cnt, sorted(models), sig))
    with conn.cursor() as cur:
        cur.executemany(
            """
            INSERT INTO public.users(user_id, user_type, is_real, is_lost, first_day, last_day, n_traces, models, rules_signature)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)
            ON CONFLICT (user_id) DO UPDATE SET
                user_type = EXCLUDED.user_type,
                is_real = EXCLUDED.is_real,
                is_lost = EXCLUDED.is_lost,
                first_day = LEAST(COALESCE(public.users.first_day, EXCLUDED.first_day), EXCLUDED.first_day),
                last_day = GREATEST(COALESCE(public.users.last_day, EXCLUDED.last_day), EXCLUDED.last_day),
                n_traces = GREATEST(public.users.n_traces, EXCLUDED.n_traces),
                models = (SELECT ARRAY(SELECT DISTINCT x FROM unnest(public.users.models || EXCLUDED.models) x ORDER BY x)),
                rules_signature = EXCLUDED.rules_signature,
                updated_at = now()
            """,
            rows,
        )


def migrate_daily_model(
    cfg: DataCoreConfig,
    legacy_root: Path,
    model: str,
    *,
    workers: int = 6,
    cat_meta: dict[str, tuple[str | None, str | None]],
    rules: UserRules,
    intent_tax: IntentTaxonomy | None,
    outputs_only: bool = False,
) -> dict[str, Any]:
    t0 = time.monotonic()
    total_input_lines = 0
    total_in_rows = 0
    dup_input_lines = 0
    dup_samples: list[dict[str, Any]] = []
    total_in_packs = 0
    in_comp_bytes = 0
    in_raw_bytes = 0
    in_files: list[Path] = []

    if outputs_only:
        import shutil

        out_model_dir = cfg.data_root / "eval_output" / model
        if out_model_dir.is_dir():
            shutil.rmtree(out_model_dir)
            out_model_dir.mkdir(parents=True, exist_ok=True)
        with connect_direct(cfg, autocommit=False, app_name=f"etl_clean_out_{model}") as conn:
            conn.execute("DELETE FROM public.eval_outputs WHERE product = %s AND model = %s", (cfg.product, model))
            conn.execute("DELETE FROM public.eval_inputs WHERE product = %s AND model = %s AND NOT has_input_blob", (cfg.product, model))
            conn.execute("UPDATE public.eval_inputs SET eval_status = 'pending' WHERE product = %s AND model = %s", (cfg.product, model))
            conn.execute(
                "DELETE FROM public.pack_files WHERE domain = 'daily' AND model = %s AND kind IN ('attribution','compact','human_read')",
                (model,),
            )
            conn.execute("DELETE FROM public.changes WHERE product = %s AND model = %s", (cfg.product, model))
            conn.commit()
        print(f"[daily:{model}] outputs_only=True: preserved existing eval_input packs, cleaned output state", flush=True)
    else:
        print(f"[daily:{model}] === Stage 2A: Scanning daily inputs ===", flush=True)
        in_dir = legacy_root / "1_aime" / "eval_input" / "0_daily_eval_input" / model
        in_files = sorted(in_dir.glob("*.jsonl"))

        # Pass 1: Parallel scan of daily inputs
        winners: dict[str, tuple[tuple[int, int, str, int], dict[str, Any]]] = {}

        with ProcessPoolExecutor(max_workers=workers) as pool:
            futs = [pool.submit(_scan_input_file_worker, (str(p), model)) for p in in_files]
            for fut in as_completed(futs):
                for tid, bday, sid, has_cat, n_msgs, fdate, line_no, pstr, off, ln in fut.result():
                    total_input_lines += 1
                    score = (has_cat, n_msgs, fdate, line_no)
                    prev = winners.get(tid)
                    if prev is None:
                        winners[tid] = (
                            score,
                            {
                                "trace_id": tid,
                                "biz_day": bday,
                                "session_id": sid,
                                "src_path": pstr,
                                "src_off": off,
                                "src_len": ln,
                                "dup_count": 0,
                            },
                        )
                    else:
                        dup_input_lines += 1
                        prev_score, prev_item = prev
                        if score > prev_score:
                            if len(dup_samples) < 50:
                                dup_samples.append({"trace_id": tid, "kept": fdate, "dropped": prev_item["biz_day"]})
                            winners[tid] = (
                                score,
                                {
                                    "trace_id": tid,
                                    "biz_day": bday,
                                    "session_id": sid,
                                    "src_path": pstr,
                                    "src_off": off,
                                    "src_len": ln,
                                    "dup_count": prev_item["dup_count"] + 1,
                                },
                            )
                        else:
                            prev_item["dup_count"] += 1

        print(
            f"[daily:{model}] scanned {len(in_files)} input files: {total_input_lines} lines, "
            f"{len(winners)} unique traces, {dup_input_lines} dups ({time.monotonic()-t0:.1f}s)",
            flush=True,
        )

        # Group winning inputs by biz_day
        by_day: dict[str, list[dict[str, Any]]] = {}
        for _, it in winners.values():
            by_day.setdefault(it["biz_day"], []).append(it)

        # Pass 2: Parallel Zstd packing per biz_day + PG COPY
        t1 = time.monotonic()
        user_stats: dict[str, tuple[date, date, int, set[str]]] = {}

        with connect_direct(cfg, autocommit=False, app_name=f"etl_daily_in_{model}") as conn:
            conn.execute("DELETE FROM public.eval_inputs WHERE product = %s AND model = %s", (cfg.product, model))
            conn.execute("DELETE FROM public.pack_files WHERE domain = 'daily' AND model = %s", (model,))
            conn.execute("DELETE FROM public.changes WHERE product = %s AND model = %s", (cfg.product, model))
            conn.commit()

            with ProcessPoolExecutor(max_workers=workers) as pool:
                day_futs = []
                for day_str in sorted(by_day.keys()):
                    day_items = by_day[day_str]
                    cm_sub = {it["trace_id"]: cat_meta[it["trace_id"]] for it in day_items if it["trace_id"] in cat_meta}
                    day_futs.append(
                        pool.submit(
                            _pack_input_day_worker,
                            (model, day_str, day_items, str(cfg.data_root), cfg.zstd_level, cfg.max_sessions_per_part, cm_sub),
                        )
                    )

                for fut in as_completed(day_futs):
                    res = fut.result()
                    rel_to_fid = _upsert_pack_files(conn, res["packs"])
                    total_in_packs += len(res["packs"])
                    for pm in res["packs"]:
                        in_comp_bytes += pm["committed_bytes"]
                        in_raw_bytes += pm["uncompressed_bytes"]

                    with conn.cursor().copy(
                        """
                        COPY public.eval_inputs(
                            product, model, trace_id, session_id, user_id, source, app_version,
                            runtime_mode, agent_id, batch_id, case_id, request_time, biz_day,
                            turn_index, session_round, is_multi_turn, question_text, question_norm, question_hash,
                            n_messages, n_observations, total_tokens, input_tokens, output_tokens, cache_read_tokens,
                            tool_count, latency_ms, answer_len, has_visual, visual_count,
                            task_category, subtask_category, intent_code, taxonomy_version, category_status,
                            eval_status, has_input_blob, input_file_id, input_offset, input_len, extra
                        ) FROM STDIN
                        """
                    ) as copy:
                        for r in res["rows"]:
                            uid = r["user_id"]
                            bdate = date.fromisoformat(r["biz_day"])
                            if uid:
                                prev_u = user_stats.get(uid)
                                if prev_u is None:
                                    user_stats[uid] = (bdate, bdate, 1, {model})
                                else:
                                    user_stats[uid] = (min(prev_u[0], bdate), max(prev_u[1], bdate), prev_u[2] + 1, prev_u[3] | {model})
                            extra = {"dup_count": r["dup_count"]} if r["dup_count"] else {}
                            copy.write_row(
                                (
                                    r["product"], r["model"], r["trace_id"], r["session_id"], uid,
                                    r["source"], r["app_version"], r["runtime_mode"], r["agent_id"],
                                    r["batch_id"], r["case_id"], r["request_time"], bdate,
                                    r["turn_index"], r["session_round"], r["is_multi_turn"],
                                    r["question_text"], r["question_norm"], r["question_hash"],
                                    r["n_messages"], r["n_observations"], r["total_tokens"],
                                    r["input_tokens"], r["output_tokens"], r["cache_read_tokens"],
                                    r["tool_count"], r["latency_ms"], r["answer_len"],
                                    r["has_visual"], r["visual_count"],
                                    r["task_category"], r["subtask_category"], r["intent_code"],
                                    r["taxonomy_version"], r["category_status"],
                                    "pending", True, rel_to_fid[r["rel_path"]], r["input_offset"], r["input_len"],
                                    json.dumps(extra, ensure_ascii=False),
                                )
                            )
                            total_in_rows += 1
                    conn.commit()

            _ensure_users_batch(conn, user_stats, rules)
            conn.commit()

        print(
            f"[daily:{model}] packed & loaded {total_in_rows} inputs into {total_in_packs} packs: "
            f"{in_raw_bytes/1e9:.2f} GB -> {in_comp_bytes/1e9:.2f} GB "
            f"({(1 - in_comp_bytes/max(in_raw_bytes,1))*100:.1f}% saved, {time.monotonic()-t1:.1f}s)",
            flush=True,
        )

    # =========================================================================
    # Stage 2B: Daily Outputs (attribution + compact + human_read deltas)
    # =========================================================================
    t2 = time.monotonic()
    print(f"[daily:{model}] === Stage 2B: Scanning outputs, compact & human_read ===", flush=True)
    attr_dir = legacy_root / "1_aime" / "eval_output" / "0_daily_eval" / model
    comp_dir = attr_dir / "compact"
    hr_attr_dir = legacy_root / "1_aime" / "eval_output" / "human_read" / "0_daily_eval" / model
    hr_comp_dir = hr_attr_dir / "compact"

    attr_files = sorted(attr_dir.glob("*_attribution-*.jsonl"))
    comp_files = sorted(comp_dir.glob("*_compact-*.jsonl")) if comp_dir.is_dir() else []
    hr_attr_files = sorted(hr_attr_dir.glob("*_attribution-*.jsonl")) if hr_attr_dir.is_dir() else []
    hr_comp_files = sorted(hr_comp_dir.glob("*_compact-*.jsonl")) if hr_comp_dir.is_dir() else []

    # Parallel scan of all 4 output sets
    scan_tasks = (
        [(str(p), "attr") for p in attr_files]
        + [(str(p), "comp") for p in comp_files]
        + [(str(p), "hr_attr") for p in hr_attr_files]
        + [(str(p), "hr_comp") for p in hr_comp_files]
    )

    attr_by_tid: dict[str, tuple[tuple[str, int], tuple[str, int, int, str, str]]] = {}
    comp_by_tid: dict[str, tuple[str, int, int]] = {}
    comp_by_sid_rt: dict[tuple[str, str], tuple[str, int, int]] = {}
    hr_attr_by_tid: dict[str, tuple[str, int, int]] = {}
    hr_attr_by_sid_rt: dict[tuple[str, str], tuple[str, int, int]] = {}
    hr_comp_by_tid: dict[str, tuple[str, int, int]] = {}
    hr_comp_by_sid_rt: dict[tuple[str, str], tuple[str, int, int]] = {}
    total_attr_lines = 0
    dup_attr_lines = 0

    with ProcessPoolExecutor(max_workers=workers) as pool:
        fut_map = {pool.submit(_scan_output_file_worker, task): task[1] for task in scan_tasks}
        for fut in as_completed(fut_map):
            kind = fut_map[fut]
            for tids, sid, rt, fdate, line_no, pstr, off, ln in fut.result():
                loc = (pstr, off, ln)
                if kind == "attr":
                    total_attr_lines += 1
                    order_key = (fdate, line_no)
                    for tid in tids:
                        prev = attr_by_tid.get(tid)
                        if prev is None:
                            attr_by_tid[tid] = (order_key, (pstr, off, ln, sid, rt))
                        else:
                            dup_attr_lines += 1
                            if order_key >= prev[0]:
                                attr_by_tid[tid] = (order_key, (pstr, off, ln, sid, rt))
                elif kind == "comp":
                    for tid in tids:
                        comp_by_tid[tid] = loc
                    if sid and rt:
                        comp_by_sid_rt[(sid, rt)] = loc
                elif kind == "hr_attr":
                    for tid in tids:
                        hr_attr_by_tid[tid] = loc
                    if sid and rt:
                        hr_attr_by_sid_rt[(sid, rt)] = loc
                elif kind == "hr_comp":
                    for tid in tids:
                        hr_comp_by_tid[tid] = loc
                    if sid and rt:
                        hr_comp_by_sid_rt[(sid, rt)] = loc

    print(
        f"[daily:{model}] scanned outputs: attr_lines={total_attr_lines} unique={len(attr_by_tid)} "
        f"dup={dup_attr_lines} comp={len(comp_by_tid)} hr_attr={len(hr_attr_by_tid)} hr_comp={len(hr_comp_by_tid)} "
        f"({time.monotonic()-t2:.1f}s)",
        flush=True,
    )

    # Load input_id map & synthesize missing inputs for orphan attributions
    with connect_direct(cfg, autocommit=False, app_name=f"etl_daily_out_{model}") as conn:
        db_epoch = get_or_init_db_epoch(conn, cfg.db_epoch)
        input_map: dict[str, tuple[int, str, str, str | None]] = {}
        for r in conn.execute(
            "SELECT input_id, trace_id, biz_day, session_id, app_version FROM public.eval_inputs WHERE product=%s AND model=%s",
            (cfg.product, model),
        ).fetchall():
            input_map[r["trace_id"]] = (int(r["input_id"]), r["biz_day"].isoformat(), r["session_id"], r["app_version"])

        orphan_tids = [tid for tid in attr_by_tid if tid not in input_map]
        synth_users: dict[str, tuple[date, date, int, set[str]]] = {}
        if orphan_tids:
            fds_orphan: dict[str, int] = {}
            try:
                for tid in orphan_tids:
                    (fdate, _), (pstr, off, ln, sid, rt) = attr_by_tid[tid]
                    raw = _pread_line(fds_orphan, pstr, off, ln)
                    rec = json_loads_bytes(raw)
                    alist = extract_attribution_fields(rec, model, fallback_day=fdate, intent_tax=intent_tax)
                    a = next((x for x in alist if x["trace_id"] == tid), alist[0] if alist else None)
                    if a is None:
                        continue
                    tc, stc, ic, tv = a["task_category"], a["subtask_category"], a["intent_code"], a["taxonomy_version"]
                    if not tc and tid in cat_meta:
                        cm_t, cm_st = cat_meta[tid]
                        if intent_tax:
                            ic, tc, stc, tv = intent_tax.resolve(cm_t, cm_st)
                        else:
                            tc, stc = cm_t, cm_st
                    uid = a["user_id"]
                    bdate = a["biz_day"]
                    if uid:
                        prev_u = synth_users.get(uid)
                        if prev_u is None:
                            synth_users[uid] = (bdate, bdate, 1, {model})
                        else:
                            synth_users[uid] = (min(prev_u[0], bdate), max(prev_u[1], bdate), prev_u[2] + 1, prev_u[3] | {model})

                    q_txt = a["question_text"]
                    row = conn.execute(
                        """
                        INSERT INTO public.eval_inputs(
                            product, model, trace_id, session_id, user_id, source, app_version,
                            request_time, biz_day, question_text, question_norm, question_hash,
                            n_messages, task_category, subtask_category, intent_code, taxonomy_version,
                            category_status, eval_status, has_input_blob, extra
                        )
                        VALUES (%s,%s,%s,%s,%s,'prelaunch',%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,'pending',FALSE,%s)
                        ON CONFLICT (product, model, trace_id) DO UPDATE SET updated_at = now()
                        RETURNING input_id, biz_day, session_id, app_version
                        """,
                        (
                            cfg.product, model, tid, a["session_id"], uid, a["app_version"],
                            a["request_time"], bdate, q_txt, normalize_question(q_txt), question_hash(q_txt),
                            a["n_messages"], tc, stc, ic, tv,
                            "done" if (tc or stc) else "pending",
                            Jsonb({"synthetic_from_attribution": True}),
                        ),
                    ).fetchone()
                    input_map[tid] = (int(row["input_id"]), row["biz_day"].isoformat(), row["session_id"], row["app_version"])
            finally:
                _close_fds(fds_orphan)
            _ensure_users_batch(conn, synth_users, rules)
            conn.commit()
            print(f"[daily:{model}] synthesized {len(orphan_tids)} orphan-attribution input stubs", flush=True)

        # Group all outputs by canonical eval_inputs.biz_day
        out_by_day: dict[str, list[dict[str, Any]]] = {}
        for tid, (_, (pstr, off, ln, sid, rt)) in attr_by_tid.items():
            if tid not in input_map:
                continue
            input_id, bday_str, in_sid, _ = input_map[tid]
            comp_loc = comp_by_tid.get(tid) or (comp_by_sid_rt.get((sid, rt)) if (sid and rt) else None)
            hr_attr_loc = hr_attr_by_tid.get(tid) or (hr_attr_by_sid_rt.get((sid, rt)) if (sid and rt) else None)
            hr_comp_loc = hr_comp_by_tid.get(tid) or (hr_comp_by_sid_rt.get((sid, rt)) if (sid and rt) else None)
            out_by_day.setdefault(bday_str, []).append(
                {
                    "input_id": input_id,
                    "trace_id": tid,
                    "session_id": in_sid or sid,
                    "attr_path": pstr,
                    "attr_off": off,
                    "attr_len": ln,
                    "comp_loc": comp_loc,
                    "hr_attr_loc": hr_attr_loc,
                    "hr_comp_loc": hr_comp_loc,
                }
            )

        # Parallel packing of outputs by biz_day + PG bulk load
        t3 = time.monotonic()
        total_out_rows = 0
        total_prob_rows = 0
        total_hr_rows = 0
        out_comp_bytes = 0
        out_raw_bytes = 0
        out_packs_cnt = 0

        with ProcessPoolExecutor(max_workers=workers) as pool:
            futs = [
                pool.submit(
                    _pack_output_day_worker,
                    (model, day_str, out_by_day[day_str], str(cfg.data_root), cfg.zstd_level, cfg.max_sessions_per_part),
                )
                for day_str in sorted(out_by_day.keys())
            ]
            for fut in as_completed(futs):
                res = fut.result()
                rel_to_fid = _upsert_pack_files(conn, res["packs"])
                out_packs_cnt += len(res["packs"])
                for pm in res["packs"]:
                    out_comp_bytes += pm["committed_bytes"]
                    out_raw_bytes += pm["uncompressed_bytes"]

                rows = res["rows"]
                if not rows:
                    conn.commit()
                    continue

                # Insert eval_outputs via executemany RETURNING output_id (fast in psycopg3 pipeline!)
                out_params = []
                for r in rows:
                    p = r["parsed"]
                    out_params.append(
                        (
                            r["input_id"], cfg.product, model, r["trace_id"], date.fromisoformat(r["biz_day"]),
                            p["evaluator_version"], p["judge_model"], p["evaluated_at"],
                            True, p["max_severity"], p["p0_cnt"], p["p1_cnt"], p["p2_cnt"], p["p3_cnt"], p["p4_cnt"],
                            p["problem_count"], p["is_gold"], p["is_correct"], p["summary"], p["session_summary"],
                            rel_to_fid[r["attr_rel"]], r["attr_offset"], r["attr_len"],
                            rel_to_fid[r["comp_rel"]] if r["comp_rel"] else None,
                            r["comp_offset"], r["comp_len"],
                        )
                    )

                output_ids: list[int] = []
                with conn.cursor() as cur:
                    cur.executemany(
                        """
                        INSERT INTO public.eval_outputs(
                            input_id, product, model, trace_id, biz_day,
                            evaluator_version, judge_model, evaluated_at,
                            is_latest, max_severity, p0_cnt, p1_cnt, p2_cnt, p3_cnt, p4_cnt,
                            problem_count, is_gold, is_correct, summary, session_summary,
                            attr_file_id, attr_offset, attr_len,
                            compact_file_id, compact_offset, compact_len
                        )
                        VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                        RETURNING output_id
                        """,
                        out_params,
                        returning=True,
                    )
                    while True:
                        rec_oid = cur.fetchone()
                        if rec_oid is not None:
                            output_ids.append(int(rec_oid["output_id"]))
                        if not cur.nextset():
                            break

                total_out_rows += len(output_ids)

                # Bulk COPY eval_problems
                with conn.cursor().copy(
                    """
                    COPY public.eval_problems(
                        output_id, input_id, model, biz_day, trace_id,
                        scope, turn_index, problem_index, severity,
                        component, component_family, label, evidence_count, located_count
                    ) FROM STDIN
                    """
                ) as copy:
                    for oid, r in zip(output_ids, rows):
                        bdate = date.fromisoformat(r["biz_day"])
                        for prob in r["parsed"]["problems"]:
                            copy.write_row(
                                (
                                    oid, r["input_id"], model, bdate, r["trace_id"],
                                    prob["scope"], prob["turn_index"], prob["problem_index"], prob["severity"],
                                    prob["component"], prob["component_family"], prob["label"],
                                    prob["evidence_count"], prob["located_count"],
                                )
                            )
                            total_prob_rows += 1

                # Bulk COPY human_read_overlays (delta-only for attr & compact)
                hr_copy_rows = []
                for oid, r in zip(output_ids, rows):
                    for hr in r["hr_entries"]:
                        hr_copy_rows.append(
                            (
                                oid, r["input_id"], hr["target_kind"], "done",
                                hr["prompt_version"], hr["translator_model"], hr["source_hash"],
                                hr["hr_hash"], hr["hr_labels"],
                                rel_to_fid[hr["hr_rel"]], hr["hr_offset"], hr["hr_len"],
                                hr["translated_at"] or datetime.now(timezone.utc),
                            )
                        )
                if hr_copy_rows:
                    with conn.cursor().copy(
                        """
                        COPY public.human_read_overlays(
                            output_id, input_id, target_kind, status,
                            prompt_version, translator_model, source_hash,
                            hr_hash, hr_labels, hr_file_id, hr_offset, hr_len, translated_at
                        ) FROM STDIN
                        """
                    ) as copy:
                        for hrow in hr_copy_rows:
                            copy.write_row(hrow)
                    total_hr_rows += len(hr_copy_rows)

                # Bulk update eval_inputs.eval_status = 'evaluated' and backfill empty user_id/category if attr has them
                eval_input_ids = [r["input_id"] for r in rows]
                conn.execute(
                    "UPDATE public.eval_inputs SET eval_status = 'evaluated', updated_at = now() WHERE input_id = ANY(%s)",
                    (eval_input_ids,),
                )
                cat_backfills = [
                    (
                        r["parsed"]["task_category"],
                        r["parsed"]["subtask_category"],
                        r["parsed"]["intent_code"],
                        r["parsed"]["taxonomy_version"],
                        r["parsed"]["user_id"],
                        r["input_id"],
                    )
                    for r in rows
                    if r["parsed"]["task_category"] or r["parsed"]["user_id"]
                ]
                if cat_backfills:
                    with conn.cursor() as cur:
                        cur.executemany(
                            """
                            UPDATE public.eval_inputs
                            SET task_category = COALESCE(task_category, %s),
                                subtask_category = COALESCE(subtask_category, %s),
                                intent_code = COALESCE(intent_code, %s),
                                taxonomy_version = COALESCE(taxonomy_version, %s),
                                category_status = CASE WHEN COALESCE(task_category, %s) IS NOT NULL THEN 'done' ELSE category_status END,
                                user_id = CASE WHEN user_id = '' AND %s <> '' THEN %s ELSE user_id END
                            WHERE input_id = %s
                              AND (task_category IS NULL OR user_id = '')
                            """,
                            [
                                (tc, stc, ic, tv, tc, uid, uid, iid)
                                for tc, stc, ic, tv, uid, iid in cat_backfills
                            ],
                        )
                with conn.cursor().copy(
                    """
                    COPY public.changes(
                        db_epoch, entity_type, op, human_only,
                        input_id, output_id, product, model, app_version, biz_day, trace_id
                    ) FROM STDIN
                    """
                ) as copy:
                    for oid, r in zip(output_ids, rows):
                        bdate = date.fromisoformat(r["biz_day"])
                        app_v = input_map[r["trace_id"]][3] or r["parsed"]["app_version"]
                        copy.write_row(
                            (db_epoch, "trace", "upsert", False, r["input_id"], oid, cfg.product, model, app_v, bdate, r["trace_id"])
                        )
                conn.commit()

        # Sync any remaining attribution-level category into eval_inputs where eval_inputs lacked category
        print(
            f"[daily:{model}] packed & loaded {total_out_rows} outputs, {total_prob_rows} problems, "
            f"{total_hr_rows} hr_overlays into {out_packs_cnt} packs: "
            f"{out_raw_bytes/1e9:.2f} GB -> {out_comp_bytes/1e9:.2f} GB "
            f"({(1 - out_comp_bytes/max(out_raw_bytes,1))*100:.1f}% saved, {time.monotonic()-t3:.1f}s)",
            flush=True,
        )

    return {
        "model": model,
        "input_files": len(in_files),
        "input_lines_total": total_input_lines,
        "input_unique_traces": total_in_rows,
        "input_dups": dup_input_lines,
        "input_dup_samples": dup_samples[:20],
        "input_packs": total_in_packs,
        "input_raw_bytes": in_raw_bytes,
        "input_compressed_bytes": in_comp_bytes,
        "orphan_attribution_stubs": len(orphan_tids),
        "output_attr_lines_total": total_attr_lines,
        "output_attr_dups": dup_attr_lines,
        "output_rows": total_out_rows,
        "problem_rows": total_prob_rows,
        "human_read_overlays": total_hr_rows,
        "output_packs": out_packs_cnt,
        "output_raw_bytes": out_raw_bytes,
        "output_compressed_bytes": out_comp_bytes,
        "elapsed_sec": round(time.monotonic() - t0, 1),
    }


def migrate_daily_all(
    cfg: DataCoreConfig, legacy_root: Path, *, workers: int = 6, outputs_only: bool = False
) -> dict[str, Any]:
    rules = UserRules.from_file(cfg.data_root / "config" / "user_rules.json")
    intent_file = ASSETS_DIR / "intent_2026-11.json"
    intent_tax = IntentTaxonomy.from_file(intent_file) if intent_file.is_file() else None
    cat_meta = load_category_meta(legacy_root)
    print(f"[daily] loaded {len(cat_meta)} category_meta entries from 0_litefusion_data", flush=True)

    summary = {"category_meta_entries": len(cat_meta), "models": {}}
    for model in ("aime_expert", "aime_fast"):
        summary["models"][model] = migrate_daily_model(
            cfg,
            legacy_root,
            model,
            workers=workers,
            cat_meta=cat_meta,
            rules=rules,
            intent_tax=intent_tax,
            outputs_only=outputs_only,
        )
    return summary
