"""Unified AIME Data Core (5003 Data Core Engine).

Single-writer gateway enforcing:
1. Blob-First write invariant: append multi-frame Zstd frame to CephFS pack file
   with fsync BEFORE committing the PostgreSQL transaction.
2. Pack file rotation: daily input packs rotate at <= 500 distinct sessions per
   part (grouping traces of the same session when possible).
3. Transactional `changes` emission with `db_epoch` for 5003 `/changes`.
4. Lease-based Step 2 task claiming via `FOR UPDATE SKIP LOCKED`.
5. O(1) random reads via `os.pread` + transparent `human_read` delta overlay.
"""

from __future__ import annotations

import hashlib
import json
import threading
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import psycopg
from psycopg.types.json import Jsonb

from .config import DataCoreConfig
from .db import Database, get_or_init_db_epoch
from .models import (
    IntentTaxonomy,
    UserRules,
    apply_human_read_delta,
    extract_attribution_fields,
    extract_human_read_delta,
    extract_input_fields,
    split_cluster_code,
)
from .zst_pack import (
    FramePointer,
    append_frame_file,
    compress_record_line,
    daily_input_rel_path,
    daily_output_rel_path,
    pread_json,
)

ASSETS_DIR = Path(__file__).resolve().parent / "assets"


def _advisory_lock_key(name: str) -> int:
    digest = hashlib.blake2b(name.encode("utf-8"), digest_size=8).digest()
    return int.from_bytes(digest, "big", signed=True)


class DataCore:
    """Single-writer Data Core engine backed by PG 16 + Multi-Frame Zstd."""

    def __init__(
        self,
        cfg: DataCoreConfig,
        *,
        user_rules: UserRules | None = None,
        intent_tax: IntentTaxonomy | None = None,
        min_pool: int = 1,
        max_pool: int = 16,
    ):
        self.cfg = cfg
        self.db = Database(cfg, min_size=min_pool, max_size=max_pool)
        self._local_lock = threading.RLock()
        self.user_rules = user_rules or UserRules.from_file(cfg.data_root / "config" / "user_rules.json")
        intent_file = ASSETS_DIR / "intent_2026-11.json"
        self.intent_tax = intent_tax or (IntentTaxonomy.from_file(intent_file) if intent_file.is_file() else None)
        with self.db.transaction() as conn:
            self.db_epoch = get_or_init_db_epoch(conn, cfg.db_epoch)

    def close(self) -> None:
        self.db.close()

    def __enter__(self) -> "DataCore":
        return self

    def __exit__(self, *_exc) -> None:
        self.close()

    # ------------------------------------------------------------------ Pack allocation

    def _select_active_pack(
        self,
        conn: psycopg.Connection,
        *,
        domain: str,
        kind: str,
        model: str,
        biz_day: date,
        session_id: str | None = None,
    ) -> dict[str, Any]:
        """Acquire a per-(domain,kind,model,biz_day) PG advisory lock and return active pack row."""
        lock_key = _advisory_lock_key(f"{domain}:{kind}:{model}:{biz_day.isoformat()}")
        conn.execute("SELECT pg_advisory_xact_lock(%s)", (lock_key,))

        row = conn.execute(
            """
            SELECT file_id, rel_path, part_no, committed_bytes, uncompressed_bytes,
                   record_count, session_count, status
            FROM public.pack_files
            WHERE domain = %s AND kind = %s AND model = %s AND biz_day = %s AND status = 'active'
            ORDER BY part_no DESC
            LIMIT 1
            FOR UPDATE
            """,
            (domain, kind, model, biz_day),
        ).fetchone()

        need_rotate = False
        if row is not None and self.cfg.max_sessions_per_part > 0:
            if row["session_count"] >= self.cfg.max_sessions_per_part:
                # Rotate unless this session is already inside the current part
                same_sess = False
                if session_id and kind == "input":
                    same_sess = (
                        conn.execute(
                            "SELECT 1 FROM public.eval_inputs WHERE input_file_id = %s AND session_id = %s LIMIT 1",
                            (row["file_id"], session_id),
                        ).fetchone()
                        is not None
                    )
                if not same_sess:
                    need_rotate = True

        if need_rotate and row is not None:
            conn.execute(
                "UPDATE public.pack_files SET status = 'sealed', updated_at = now() WHERE file_id = %s",
                (row["file_id"],),
            )
            next_part = int(row["part_no"]) + 1
            row = None
        elif row is None:
            max_row = conn.execute(
                """
                SELECT COALESCE(MAX(part_no), -1) AS max_part
                FROM public.pack_files
                WHERE domain = %s AND kind = %s AND model = %s AND biz_day = %s
                """,
                (domain, kind, model, biz_day),
            ).fetchone()
            next_part = int(max_row["max_part"]) + 1
        else:
            return row

        day_str = biz_day.isoformat()
        if kind == "input":
            rel_path = daily_input_rel_path(model, day_str, next_part)
        else:
            rel_path = daily_output_rel_path(model, day_str, kind, next_part)

        return conn.execute(
            """
            INSERT INTO public.pack_files(domain, kind, model, biz_day, part_no, rel_path, status)
            VALUES (%s, %s, %s, %s, %s, %s, 'active')
            ON CONFLICT (rel_path) DO UPDATE SET updated_at = now()
            RETURNING file_id, rel_path, part_no, committed_bytes, uncompressed_bytes,
                      record_count, session_count, status
            """,
            (domain, kind, model, biz_day, next_part, rel_path),
        ).fetchone()

    def _ensure_user(self, conn: psycopg.Connection, user_id: str, biz_day: date, model: str) -> None:
        if not user_id:
            return
        utype, is_real, is_lost = self.user_rules.classify(user_id)
        conn.execute(
            """
            INSERT INTO public.users(user_id, user_type, is_real, is_lost, first_day, last_day, n_traces, models, rules_signature)
            VALUES (%s, %s, %s, %s, %s, %s, 1, ARRAY[%s], %s)
            ON CONFLICT (user_id) DO UPDATE SET
                user_type = EXCLUDED.user_type,
                is_real = EXCLUDED.is_real,
                is_lost = EXCLUDED.is_lost,
                first_day = LEAST(COALESCE(public.users.first_day, EXCLUDED.first_day), EXCLUDED.first_day),
                last_day = GREATEST(COALESCE(public.users.last_day, EXCLUDED.last_day), EXCLUDED.last_day),
                n_traces = public.users.n_traces + 1,
                models = (SELECT ARRAY(SELECT DISTINCT x FROM unnest(public.users.models || ARRAY[%s]) x ORDER BY x)),
                updated_at = now()
            """,
            (user_id, utype, is_real, is_lost, biz_day, biz_day, model, self.user_rules.signature(), model),
        )

    # ------------------------------------------------------------------ Step 1: Daily Input (Blob-First)

    def ingest_daily_input(
        self,
        record: dict[str, Any],
        model: str,
        *,
        source: str = "prelaunch",
        fallback_day: str | None = None,
    ) -> dict[str, Any]:
        """Blob-First write of one daily input record into `.jsonl.zst` + PG `eval_inputs`."""
        parsed = extract_input_fields(
            record,
            model,
            fallback_day=fallback_day,
            intent_tax=self.intent_tax,
            source=source,
        )
        if not parsed["trace_id"]:
            raise ValueError("Daily input record missing trace_id")

        frame, raw_len = compress_record_line(record, level=self.cfg.zstd_level)

        with self._local_lock, self.db.transaction() as conn:
            existing = conn.execute(
                """
                SELECT input_id, input_file_id, input_offset, input_len
                FROM public.eval_inputs
                WHERE product = %s AND model = %s AND trace_id = %s
                FOR UPDATE
                """,
                (parsed["product"], parsed["model"], parsed["trace_id"]),
            ).fetchone()
            if existing and existing["input_file_id"] is not None:
                # Idempotent dedup: increment dup_count without rewriting blob
                conn.execute(
                    """
                    UPDATE public.eval_inputs
                    SET extra = jsonb_set(
                            extra,
                            '{dup_count}',
                            to_jsonb(COALESCE((extra->>'dup_count')::int, 0) + 1),
                            true
                        ),
                        updated_at = now()
                    WHERE input_id = %s
                    """,
                    (existing["input_id"],),
                )
                return {"input_id": existing["input_id"], "deduplicated": True}

            pack = self._select_active_pack(
                conn,
                domain="daily",
                kind="input",
                model=model,
                biz_day=parsed["biz_day"],
                session_id=parsed["session_id"],
            )
            pack_path = self.cfg.data_root / pack["rel_path"]

            # BLOB-FIRST: append Zstd frame + fsync BEFORE DB commit
            offset, length = append_frame_file(pack_path, frame, fsync=True)

            is_new_sess = True
            if parsed["session_id"]:
                is_new_sess = (
                    conn.execute(
                        "SELECT 1 FROM public.eval_inputs WHERE input_file_id = %s AND session_id = %s LIMIT 1",
                        (pack["file_id"], parsed["session_id"]),
                    ).fetchone()
                    is None
                )

            conn.execute(
                """
                UPDATE public.pack_files
                SET committed_bytes = GREATEST(committed_bytes, %s),
                    uncompressed_bytes = uncompressed_bytes + %s,
                    record_count = record_count + 1,
                    session_count = session_count + %s,
                    updated_at = now()
                WHERE file_id = %s
                """,
                (offset + length, raw_len, 1 if is_new_sess else 0, pack["file_id"]),
            )

            self._ensure_user(conn, parsed["user_id"], parsed["biz_day"], model)

            row = conn.execute(
                """
                INSERT INTO public.eval_inputs (
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
                    input_file_id = EXCLUDED.input_file_id,
                    input_offset = EXCLUDED.input_offset,
                    input_len = EXCLUDED.input_len,
                    question_text = COALESCE(EXCLUDED.question_text, public.eval_inputs.question_text),
                    total_tokens = COALESCE(EXCLUDED.total_tokens, public.eval_inputs.total_tokens),
                    tool_count = GREATEST(EXCLUDED.tool_count, public.eval_inputs.tool_count),
                    updated_at = now()
                RETURNING input_id
                """,
                {**parsed, "file_id": pack["file_id"], "offset": offset, "length": length},
            ).fetchone()

            return {
                "input_id": row["input_id"],
                "deduplicated": False,
                "pointer": FramePointer(pack["rel_path"], offset, length, raw_len),
            }

    # ------------------------------------------------------------------ Step 2: Claim & Commit Output

    def claim_pending_inputs(
        self,
        model: str,
        worker_id: str,
        *,
        limit: int = 10,
        lease_seconds: int = 600,
    ) -> list[dict[str, Any]]:
        """Atomically claim pending or lease-expired inputs via FOR UPDATE SKIP LOCKED."""
        now = datetime.now(timezone.utc)
        expires = now + timedelta(seconds=lease_seconds)
        with self.db.transaction() as conn:
            rows = conn.execute(
                """
                WITH picked AS (
                    SELECT input_id
                    FROM public.eval_inputs
                    WHERE model = %s
                      AND NOT is_deleted
                      AND has_input_blob
                      AND (
                          eval_status = 'pending'
                          OR (eval_status = 'claimed' AND lease_expires_at < %s)
                      )
                    ORDER BY biz_day DESC, input_id ASC
                    LIMIT %s
                    FOR UPDATE SKIP LOCKED
                )
                UPDATE public.eval_inputs i
                SET eval_status = 'claimed',
                    claimed_by = %s,
                    lease_expires_at = %s,
                    eval_attempts = i.eval_attempts + 1,
                    updated_at = now()
                FROM picked
                WHERE i.input_id = picked.input_id
                RETURNING i.input_id, i.model, i.trace_id, i.session_id, i.biz_day,
                          i.input_file_id, i.input_offset, i.input_len
                """,
                (model, now, limit, worker_id, expires),
            ).fetchall()
            return list(rows)

    def commit_daily_output(
        self,
        attr_record: dict[str, Any],
        model: str,
        *,
        compact_record: dict[str, Any] | None = None,
        evaluator_version: str = "v1",
        judge_model: str | None = None,
        eval_duration_ms: float | None = None,
        eval_cost_usd: float | None = None,
    ) -> list[int]:
        """Blob-First write of attribution (+ optional compact) and transactional PG commit."""
        parsed_list = extract_attribution_fields(attr_record, model, intent_tax=self.intent_tax)
        if not parsed_list:
            raise ValueError("Attribution record contains no valid turns with trace_id")

        attr_frame, attr_raw_len = compress_record_line(attr_record, level=self.cfg.zstd_level)
        comp_frame, comp_raw_len = (
            compress_record_line(compact_record, level=self.cfg.zstd_level) if compact_record is not None else (None, 0)
        )
        biz_day = parsed_list[0]["biz_day"]
        output_ids: list[int] = []

        with self._local_lock, self.db.transaction() as conn:
            attr_pack = self._select_active_pack(conn, domain="daily", kind="attribution", model=model, biz_day=biz_day)
            attr_off, attr_len = append_frame_file(self.cfg.data_root / attr_pack["rel_path"], attr_frame, fsync=True)
            conn.execute(
                """
                UPDATE public.pack_files
                SET committed_bytes = GREATEST(committed_bytes, %s),
                    uncompressed_bytes = uncompressed_bytes + %s,
                    record_count = record_count + 1,
                    updated_at = now()
                WHERE file_id = %s
                """,
                (attr_off + attr_len, attr_raw_len, attr_pack["file_id"]),
            )

            comp_file_id = comp_off = comp_len = None
            if comp_frame is not None:
                comp_pack = self._select_active_pack(conn, domain="daily", kind="compact", model=model, biz_day=biz_day)
                comp_off, comp_len = append_frame_file(self.cfg.data_root / comp_pack["rel_path"], comp_frame, fsync=True)
                comp_file_id = comp_pack["file_id"]
                conn.execute(
                    """
                    UPDATE public.pack_files
                    SET committed_bytes = GREATEST(committed_bytes, %s),
                        uncompressed_bytes = uncompressed_bytes + %s,
                        record_count = record_count + 1,
                        updated_at = now()
                    WHERE file_id = %s
                    """,
                    (comp_off + comp_len, comp_raw_len, comp_file_id),
                )

            for item in parsed_list:
                inp = conn.execute(
                    """
                    SELECT input_id, biz_day, app_version
                    FROM public.eval_inputs
                    WHERE product = %s AND model = %s AND trace_id = %s
                    FOR UPDATE
                    """,
                    (self.cfg.product, model, item["trace_id"]),
                ).fetchone()
                if inp is None:
                    self._ensure_user(conn, item["user_id"], item["biz_day"], model)
                    inp = conn.execute(
                        """
                        INSERT INTO public.eval_inputs(
                            product, model, trace_id, session_id, user_id, source, app_version,
                            request_time, biz_day, question_text, n_messages,
                            task_category, subtask_category, intent_code, taxonomy_version,
                            category_status, eval_status, has_input_blob, extra
                        )
                        VALUES (%s, %s, %s, %s, %s, 'prelaunch', %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, 'evaluated', FALSE, %s)
                        RETURNING input_id, biz_day, app_version
                        """,
                        (
                            self.cfg.product,
                            model,
                            item["trace_id"],
                            item["session_id"],
                            item["user_id"],
                            item["app_version"],
                            item["request_time"],
                            item["biz_day"],
                            item["question_text"],
                            item["n_messages"],
                            item["task_category"],
                            item["subtask_category"],
                            item["intent_code"],
                            item["taxonomy_version"],
                            "done" if (item["task_category"] or item["subtask_category"]) else "pending",
                            Jsonb({"synthetic_from_attribution": True}),
                        ),
                    ).fetchone()
                else:
                    conn.execute(
                        """
                        UPDATE public.eval_inputs
                        SET eval_status = 'evaluated',
                            claimed_by = NULL,
                            lease_expires_at = NULL,
                            eval_error = NULL,
                            updated_at = now()
                        WHERE input_id = %s
                        """,
                        (inp["input_id"],),
                    )

                # Mark previous latest outputs non-latest (preserves re-eval history!)
                conn.execute(
                    "UPDATE public.eval_outputs SET is_latest = FALSE, updated_at = now() WHERE input_id = %s AND is_latest",
                    (inp["input_id"],),
                )

                out_row = conn.execute(
                    """
                    INSERT INTO public.eval_outputs(
                        input_id, product, model, trace_id, biz_day,
                        evaluator_version, judge_model, evaluated_at, eval_duration_ms, eval_cost_usd,
                        is_latest, max_severity, p0_cnt, p1_cnt, p2_cnt, p3_cnt, p4_cnt,
                        problem_count, is_gold, is_correct, summary, session_summary,
                        attr_file_id, attr_offset, attr_len,
                        compact_file_id, compact_offset, compact_len
                    )
                    VALUES (
                        %s, %s, %s, %s, %s,
                        %s, %s, COALESCE(%s, now()), %s, %s,
                        TRUE, %s, %s, %s, %s, %s, %s,
                        %s, %s, %s, %s, %s,
                        %s, %s, %s,
                        %s, %s, %s
                    )
                    RETURNING output_id
                    """,
                    (
                        inp["input_id"],
                        self.cfg.product,
                        model,
                        item["trace_id"],
                        inp["biz_day"],
                        evaluator_version or item["evaluator_version"],
                        judge_model or item["judge_model"],
                        item["evaluated_at"],
                        eval_duration_ms,
                        eval_cost_usd,
                        item["max_severity"],
                        item["p0_cnt"],
                        item["p1_cnt"],
                        item["p2_cnt"],
                        item["p3_cnt"],
                        item["p4_cnt"],
                        item["problem_count"],
                        item["is_gold"],
                        item["is_correct"],
                        item["summary"],
                        item["session_summary"],
                        attr_pack["file_id"],
                        attr_off,
                        attr_len,
                        comp_file_id,
                        comp_off,
                        comp_len,
                    ),
                ).fetchone()
                oid = int(out_row["output_id"])
                output_ids.append(oid)

                for prob in item["problems"]:
                    prob_extra = {"role": prob["component_role"]} if prob.get("component_role") else {}
                    conn.execute(
                        """
                        INSERT INTO public.eval_problems(
                            output_id, input_id, model, biz_day, trace_id,
                            scope, turn_index, problem_index, severity,
                            component, component_family, label, evidence_count, located_count, extra
                        )
                        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                        """,
                        (
                            oid,
                            inp["input_id"],
                            model,
                            inp["biz_day"],
                            item["trace_id"],
                            prob["scope"],
                            prob["turn_index"],
                            prob["problem_index"],
                            prob["severity"],
                            prob["component"],
                            prob["component_family"],
                            prob["label"],
                            prob["evidence_count"],
                            prob["located_count"],
                            Jsonb(prob_extra),
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
                        self.db_epoch,
                        inp["input_id"],
                        oid,
                        self.cfg.product,
                        model,
                        inp["app_version"] or item["app_version"],
                        inp["biz_day"],
                        item["trace_id"],
                    ),
                )
        return output_ids

    # ------------------------------------------------------------------ Step 2.5: Human Read Overlay (Delta Only)

    def commit_human_read_overlay(
        self,
        *,
        output_id: int,
        hr_record: dict[str, Any],
        target_kind: str,
    ) -> dict[str, Any]:
        """Blob-First append of delta-only translation into `human_read_part_*.jsonl.zst` + PG."""
        if target_kind not in ("attribution", "compact"):
            raise ValueError(f"Unsupported target_kind={target_kind!r}")

        with self._local_lock, self.db.transaction() as conn:
            out = conn.execute(
                """
                SELECT o.output_id, o.input_id, o.model, o.trace_id, o.biz_day, i.app_version
                FROM public.eval_outputs o
                JOIN public.eval_inputs i ON i.input_id = o.input_id
                WHERE o.output_id = %s
                """,
                (output_id,),
            ).fetchone()
            if out is None:
                raise KeyError(f"eval_outputs.output_id={output_id} not found")

            delta, hr_labels, hr_hash = extract_human_read_delta(
                hr_record,
                target_kind,
                trace_id=out["trace_id"],
                model=out["model"],
                biz_day=out["biz_day"].isoformat(),
            )
            hr_meta = delta.get("_human_read") or {}
            frame, raw_len = compress_record_line(delta, level=self.cfg.zstd_level)

            pack = self._select_active_pack(
                conn, domain="daily", kind="human_read", model=out["model"], biz_day=out["biz_day"]
            )
            offset, length = append_frame_file(self.cfg.data_root / pack["rel_path"], frame, fsync=True)

            conn.execute(
                """
                UPDATE public.pack_files
                SET committed_bytes = GREATEST(committed_bytes, %s),
                    uncompressed_bytes = uncompressed_bytes + %s,
                    record_count = record_count + 1,
                    updated_at = now()
                WHERE file_id = %s
                """,
                (offset + length, raw_len, pack["file_id"]),
            )

            row = conn.execute(
                """
                INSERT INTO public.human_read_overlays(
                    output_id, input_id, target_kind, status, prompt_version, translator_model,
                    source_hash, hr_hash, hr_labels, hr_file_id, hr_offset, hr_len, translated_at
                )
                VALUES (%s, %s, %s, 'done', %s, %s, %s, %s, %s, %s, %s, %s, COALESCE(%s::timestamptz, now()))
                ON CONFLICT (output_id, target_kind) DO UPDATE SET
                    status = 'done',
                    prompt_version = EXCLUDED.prompt_version,
                    translator_model = EXCLUDED.translator_model,
                    source_hash = EXCLUDED.source_hash,
                    hr_hash = EXCLUDED.hr_hash,
                    hr_labels = EXCLUDED.hr_labels,
                    hr_file_id = EXCLUDED.hr_file_id,
                    hr_offset = EXCLUDED.hr_offset,
                    hr_len = EXCLUDED.hr_len,
                    translated_at = EXCLUDED.translated_at,
                    updated_at = now()
                RETURNING overlay_id
                """,
                (
                    out["output_id"],
                    out["input_id"],
                    target_kind,
                    hr_meta.get("prompt_version"),
                    hr_meta.get("model"),
                    hr_meta.get("source_hash"),
                    hr_hash,
                    hr_labels,
                    pack["file_id"],
                    offset,
                    length,
                    hr_meta.get("translated_at"),
                ),
            ).fetchone()

            conn.execute(
                """
                INSERT INTO public.changes(
                    db_epoch, entity_type, op, human_only,
                    input_id, output_id, product, model, app_version, biz_day, trace_id
                )
                VALUES (%s, 'human_read', 'upsert', TRUE, %s, %s, %s, %s, %s, %s, %s)
                """,
                (
                    self.db_epoch,
                    out["input_id"],
                    out["output_id"],
                    self.cfg.product,
                    out["model"],
                    out["app_version"],
                    out["biz_day"],
                    out["trace_id"],
                ),
            )
            return {"overlay_id": row["overlay_id"], "hr_hash": hr_hash}

    # ------------------------------------------------------------------ Step 4 & Step 3 Updates

    def update_category(
        self,
        *,
        model: str,
        trace_id: str,
        task_category: str | None,
        subtask_category: str | None,
        overwrite: bool = False,
    ) -> bool:
        """Step 4 authoritative classification backfill (by default fills empty only)."""
        if self.intent_tax is not None:
            intent_code, task_cat, sub_cat, tax_ver = self.intent_tax.resolve(task_category, subtask_category)
        else:
            intent_code, task_cat, sub_cat, tax_ver = None, task_category, subtask_category, None
        status = "done" if (task_cat or sub_cat) else "empty"

        with self.db.transaction() as conn:
            row = conn.execute(
                """
                UPDATE public.eval_inputs
                SET task_category = CASE WHEN %s OR task_category IS NULL THEN %s ELSE task_category END,
                    subtask_category = CASE WHEN %s OR subtask_category IS NULL THEN %s ELSE subtask_category END,
                    intent_code = CASE WHEN %s OR intent_code IS NULL THEN %s ELSE intent_code END,
                    taxonomy_version = CASE WHEN %s OR taxonomy_version IS NULL THEN %s ELSE taxonomy_version END,
                    category_status = %s,
                    category_updated_at = now(),
                    updated_at = now()
                WHERE product = %s AND model = %s AND trace_id = %s
                RETURNING input_id, biz_day, app_version
                """,
                (
                    overwrite, task_cat,
                    overwrite, sub_cat,
                    overwrite, intent_code,
                    overwrite, tax_ver,
                    status,
                    self.cfg.product, model, trace_id,
                ),
            ).fetchone()
            if not row:
                return False
            conn.execute(
                """
                INSERT INTO public.changes(
                    db_epoch, entity_type, op, human_only,
                    input_id, product, model, app_version, biz_day, trace_id
                )
                VALUES (%s, 'trace', 'upsert', FALSE, %s, %s, %s, %s, %s, %s)
                """,
                (self.db_epoch, row["input_id"], self.cfg.product, model, row["app_version"], row["biz_day"], trace_id),
            )
            return True

    def bind_problem_clusters(
        self,
        bindings: list[dict[str, Any]],
        *,
        tree_id: int | None = None,
        cluster_version: str | None = None,
    ) -> int:
        """Step 3 incremental cluster binding on `eval_problems`."""
        updated = 0
        with self.db.transaction() as conn:
            for item in bindings:
                code = item.get("cluster_code")
                l1, l2, l3, l4 = split_cluster_code(code)
                res = conn.execute(
                    """
                    UPDATE public.eval_problems
                    SET cluster_tree_id = COALESCE(%s, cluster_tree_id),
                        cluster_version = COALESCE(%s, cluster_version),
                        cluster_code = %s,
                        l1_stage = %s,
                        l2_mechanism = %s,
                        l3_leaf = %s,
                        l4_subleaf = %s,
                        is_edge = %s,
                        tags = COALESCE(%s, tags),
                        clustered_at = now()
                    WHERE problem_id = %s
                    """,
                    (
                        tree_id,
                        cluster_version,
                        code,
                        l1,
                        l2,
                        l3,
                        l4,
                        bool(item.get("is_edge", False)),
                        item.get("tags"),
                        item["problem_id"],
                    ),
                )
                updated += res.rowcount or 0
        return updated

    # ------------------------------------------------------------------ O(1) Random Read

    def read_blob(self, file_id: int, offset: int, length: int) -> Any:
        with self.db.connection() as conn:
            row = conn.execute("SELECT rel_path FROM public.pack_files WHERE file_id = %s", (file_id,)).fetchone()
        if not row:
            raise KeyError(f"pack_files.file_id={file_id} not found")
        return pread_json(self.cfg.data_root / row["rel_path"], offset, length)

    def read_daily_detail(self, input_id: int, *, text_mode: str = "raw") -> dict[str, Any]:
        """Fetch raw input + latest attribution + compact with optional human_read overlay."""
        with self.db.connection() as conn:
            row = conn.execute(
                """
                SELECT
                    i.input_id, i.model, i.trace_id, i.biz_day,
                    pf_in.rel_path AS in_path, i.input_offset, i.input_len,
                    o.output_id, o.max_severity, o.problem_count,
                    pf_at.rel_path AS attr_path, o.attr_offset, o.attr_len,
                    pf_cp.rel_path AS comp_path, o.compact_offset, o.compact_len,
                    pf_hra.rel_path AS hr_attr_path, hra.hr_offset AS hr_attr_offset, hra.hr_len AS hr_attr_len,
                    pf_hrc.rel_path AS hr_comp_path, hrc.hr_offset AS hr_comp_offset, hrc.hr_len AS hr_comp_len
                FROM public.eval_inputs i
                LEFT JOIN public.pack_files pf_in ON pf_in.file_id = i.input_file_id
                LEFT JOIN public.eval_outputs o ON o.input_id = i.input_id AND o.is_latest = TRUE
                LEFT JOIN public.pack_files pf_at ON pf_at.file_id = o.attr_file_id
                LEFT JOIN public.pack_files pf_cp ON pf_cp.file_id = o.compact_file_id
                LEFT JOIN public.human_read_overlays hra
                    ON hra.output_id = o.output_id AND hra.target_kind = 'attribution' AND hra.status = 'done'
                LEFT JOIN public.pack_files pf_hra ON pf_hra.file_id = hra.hr_file_id
                LEFT JOIN public.human_read_overlays hrc
                    ON hrc.output_id = o.output_id AND hrc.target_kind = 'compact' AND hrc.status = 'done'
                LEFT JOIN public.pack_files pf_hrc ON pf_hrc.file_id = hrc.hr_file_id
                WHERE i.input_id = %s
                """,
                (input_id,),
            ).fetchone()
        if not row:
            raise KeyError(f"eval_inputs.input_id={input_id} not found")

        raw_in = (
            pread_json(self.cfg.data_root / row["in_path"], row["input_offset"], row["input_len"])
            if row["in_path"] and row["input_len"]
            else None
        )
        raw_attr = (
            pread_json(self.cfg.data_root / row["attr_path"], row["attr_offset"], row["attr_len"])
            if row["attr_path"] and row["attr_len"]
            else None
        )
        raw_comp = (
            pread_json(self.cfg.data_root / row["comp_path"], row["compact_offset"], row["compact_len"])
            if row["comp_path"] and row["compact_len"]
            else None
        )

        resolved_mode = "raw"
        if text_mode == "human":
            applied_any = False
            if raw_attr is not None and row["hr_attr_path"] and row["hr_attr_len"]:
                delta = pread_json(self.cfg.data_root / row["hr_attr_path"], row["hr_attr_offset"], row["hr_attr_len"])
                raw_attr = apply_human_read_delta(raw_attr, delta, "attribution")
                applied_any = True
            if raw_comp is not None and row["hr_comp_path"] and row["hr_comp_len"]:
                delta = pread_json(self.cfg.data_root / row["hr_comp_path"], row["hr_comp_offset"], row["hr_comp_len"])
                raw_comp = apply_human_read_delta(raw_comp, delta, "compact")
                applied_any = True
            resolved_mode = "human" if applied_any else "fallback_raw"

        return {
            "input_id": row["input_id"],
            "output_id": row["output_id"],
            "model": row["model"],
            "trace_id": row["trace_id"],
            "biz_day": row["biz_day"].isoformat() if row["biz_day"] else None,
            "text_mode": resolved_mode,
            "input": raw_in,
            "attribution": raw_attr,
            "compact": raw_comp,
        }

    # ------------------------------------------------------------------ Materialized Views

    def refresh_stats_views(self, *, concurrently: bool = True) -> dict[str, float]:
        import time

        views = ("stats_daily_overview", "stats_daily_intent", "stats_daily_cluster")
        timings: dict[str, float] = {}
        with self.db.connection() as conn:
            conn.autocommit = True
            try:
                for view in views:
                    t0 = time.monotonic()
                    if concurrently:
                        try:
                            conn.execute(f"REFRESH MATERIALIZED VIEW CONCURRENTLY public.{view}")
                        except psycopg.Error:
                            # First population (WITH NO DATA) requires non-concurrent refresh
                            conn.execute(f"REFRESH MATERIALIZED VIEW public.{view}")
                    else:
                        conn.execute(f"REFRESH MATERIALIZED VIEW public.{view}")
                    timings[view] = round(time.monotonic() - t0, 3)
            finally:
                conn.autocommit = False
        return timings
