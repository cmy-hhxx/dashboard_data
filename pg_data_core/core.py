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


def _strict_int(value: Any, name: str) -> int:
    if isinstance(value, bool) or value is None:
        raise ValueError(f"{name} must be an integer")
    try:
        return int(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{name} must be an integer") from exc


def _normalize_models(model: str | None = None, models: list[str] | None = None) -> list[str]:
    if models is not None:
        if not isinstance(models, list):
            raise ValueError("models must be a list of strings")
        cleaned = list(dict.fromkeys(str(m).strip() for m in models if m is not None and str(m).strip()))
        if cleaned:
            return cleaned
    if model is not None and str(model).strip():
        return [str(model).strip()]
    raise ValueError("model or models is required")


def _parse_iso_day(value: date | str | None, name: str = "biz_day") -> date | None:
    if value is None or value == "":
        return None
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    try:
        return date.fromisoformat(str(value).strip())
    except ValueError as exc:
        raise ValueError(f"invalid {name}: {value!r}") from exc


def _normalize_id_list(input_ids: Any, *, max_len: int = 500) -> list[int]:
    if not isinstance(input_ids, list):
        raise ValueError("input_ids must be a list of integers")
    if len(input_ids) > max_len:
        raise ValueError(f"input_ids length exceeds max {max_len}")
    return [_strict_int(x, "input_id") for x in input_ids]


def emit_trace_changes(conn: psycopg.Connection, db_epoch: str, output_ids: list[int]) -> int:
    """Emit deduplicated `trace` upsert change events for latest, non-deleted outputs."""
    if not output_ids:
        return 0
    res = conn.execute(
        """
        INSERT INTO public.changes(
            db_epoch, entity_type, op, human_only,
            input_id, output_id, product, model, app_version, biz_day, trace_id
        )
        SELECT DISTINCT
            %s, 'trace', 'upsert', FALSE,
            i.input_id, o.output_id, i.product, i.model, i.app_version, i.biz_day, i.trace_id
        FROM public.eval_outputs o
        JOIN public.eval_inputs i ON i.input_id = o.input_id
        WHERE o.output_id = ANY(%s)
          AND o.is_latest = TRUE
          AND NOT i.is_deleted
        """,
        (db_epoch, output_ids),
    )
    return res.rowcount or 0


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

    # ------------------------------------------------------------------ Step 2: Claim, Lease & Commit Output

    def _claim_batch(
        self,
        conn: psycopg.Connection,
        *,
        models: list[str],
        now: datetime,
        expires: datetime,
        worker_id: str,
        limit: int,
        biz_day: date | None = None,
        max_biz_day_lt: date | None = None,
    ) -> list[dict[str, Any]]:
        if limit <= 0:
            return []
        clauses = [
            "model = ANY(%s)",
            "NOT is_deleted",
            "has_input_blob",
            "(eval_status = 'pending' OR (eval_status = 'claimed' AND lease_expires_at < %s))",
        ]
        params: list[Any] = [models, now]
        if biz_day is not None:
            clauses.append("biz_day = %s")
            params.append(biz_day)
        if max_biz_day_lt is not None:
            clauses.append("biz_day < %s")
            params.append(max_biz_day_lt)
        params.extend([limit, worker_id, expires])

        rows = conn.execute(
            f"""
            WITH picked AS (
                SELECT input_id
                FROM public.eval_inputs
                WHERE {' AND '.join(clauses)}
                ORDER BY biz_day DESC, input_id ASC
                LIMIT %s
                FOR UPDATE SKIP LOCKED
            ),
            claimed AS (
                UPDATE public.eval_inputs i
                SET eval_status = 'claimed',
                    claimed_by = %s,
                    lease_expires_at = %s,
                    eval_attempts = i.eval_attempts + 1,
                    updated_at = now()
                FROM picked
                WHERE i.input_id = picked.input_id
                RETURNING i.input_id, i.model, i.trace_id, i.session_id, i.biz_day,
                          i.batch_id, i.input_file_id, i.input_offset, i.input_len,
                          i.eval_attempts, i.lease_expires_at
            )
            SELECT c.input_id, c.model, c.trace_id, c.session_id, c.biz_day,
                   c.batch_id, c.input_file_id, pf.rel_path, c.input_offset, c.input_len,
                   c.eval_attempts, c.lease_expires_at
            FROM claimed c
            LEFT JOIN public.pack_files pf ON pf.file_id = c.input_file_id
            ORDER BY c.biz_day DESC, c.input_id ASC
            """,
            params,
        ).fetchall()

        out: list[dict[str, Any]] = []
        for r in rows:
            item = dict(r)
            if isinstance(item.get("biz_day"), date):
                item["biz_day"] = item["biz_day"].isoformat()
            if isinstance(item.get("lease_expires_at"), datetime):
                item["lease_expires_at"] = item["lease_expires_at"].isoformat()
            out.append(item)
        return out

    def claim_pending_inputs(
        self,
        model: str | None = None,
        worker_id: str = "worker",
        *,
        models: list[str] | None = None,
        limit: int = 10,
        lease_seconds: int = 600,
        strategy: str = "newest_first",
        priority_days: int = 7,
        biz_day: date | str | None = None,
        include_payload: bool = False,
    ) -> list[dict[str, Any]]:
        """Atomically claim pending or lease-expired inputs via FOR UPDATE SKIP LOCKED."""
        target_models = _normalize_models(model, models)
        worker = str(worker_id or "worker").strip() or "worker"
        limit = max(1, min(_strict_int(limit, "limit"), 200))
        lease_seconds = max(30, min(_strict_int(lease_seconds, "lease_seconds"), 86400))
        priority_days = max(1, min(_strict_int(priority_days, "priority_days"), 60))
        if strategy not in ("newest_first", "date_even"):
            raise ValueError(f"Unsupported strategy={strategy!r}")
        target_day = _parse_iso_day(biz_day, "biz_day")

        now = datetime.now(timezone.utc)
        expires = now + timedelta(seconds=lease_seconds)
        claimed: list[dict[str, Any]] = []

        with self.db.transaction() as conn:
            if target_day is not None or strategy == "newest_first":
                claimed = self._claim_batch(
                    conn,
                    models=target_models,
                    now=now,
                    expires=expires,
                    worker_id=worker,
                    limit=limit,
                    biz_day=target_day,
                )
            else:
                latest_row = conn.execute(
                    """
                    SELECT MAX(biz_day) AS latest_day
                    FROM public.eval_inputs
                    WHERE model = ANY(%s) AND NOT is_deleted AND has_input_blob
                    """,
                    (target_models,),
                ).fetchone()
                latest_day = latest_row["latest_day"] if latest_row else None
                if latest_day is None:
                    return []

                priority_from = latest_day - timedelta(days=priority_days - 1)
                stats = conn.execute(
                    """
                    SELECT
                        biz_day,
                        model,
                        COUNT(*) AS total,
                        COUNT(*) FILTER (
                            WHERE eval_status IN ('evaluated', 'skipped', 'failed')
                               OR (eval_status = 'claimed' AND lease_expires_at >= %s)
                        ) AS prog,
                        COUNT(*) FILTER (
                            WHERE eval_status = 'pending'
                               OR (eval_status = 'claimed' AND lease_expires_at < %s)
                        ) AS claimable
                    FROM public.eval_inputs
                    WHERE model = ANY(%s)
                      AND NOT is_deleted
                      AND has_input_blob
                      AND biz_day >= %s
                    GROUP BY biz_day, model
                    """,
                    (now, now, target_models, priority_from),
                ).fetchall()

                day_prog: dict[date, int] = {}
                day_total: dict[date, int] = {}
                for s in stats:
                    d = s["biz_day"]
                    day_prog[d] = day_prog.get(d, 0) + int(s["prog"])
                    day_total[d] = day_total.get(d, 0) + int(s["total"])

                candidates = [s for s in stats if int(s["claimable"]) > 0]
                candidates.sort(
                    key=lambda s: (
                        day_prog[s["biz_day"]] / max(1, day_total[s["biz_day"]]),
                        int(s["prog"]) / max(1, int(s["total"])),
                        -s["biz_day"].toordinal(),
                        s["model"],
                    )
                )

                for s in candidates:
                    remaining = limit - len(claimed)
                    if remaining <= 0:
                        break
                    claimed.extend(
                        self._claim_batch(
                            conn,
                            models=[s["model"]],
                            now=now,
                            expires=expires,
                            worker_id=worker,
                            limit=remaining,
                            biz_day=s["biz_day"],
                        )
                    )

                if len(claimed) < limit:
                    claimed.extend(
                        self._claim_batch(
                            conn,
                            models=target_models,
                            now=now,
                            expires=expires,
                            worker_id=worker,
                            limit=limit - len(claimed),
                            max_biz_day_lt=priority_from,
                        )
                    )

        if include_payload:
            for item in claimed:
                if item.get("rel_path") and item.get("input_len"):
                    item["input"] = pread_json(
                        self.cfg.data_root / item["rel_path"],
                        int(item["input_offset"]),
                        int(item["input_len"]),
                    )
                else:
                    item["input"] = None
        return claimed

    def heartbeat_inputs(
        self,
        worker_id: str,
        input_ids: list[int],
        *,
        lease_seconds: int = 900,
    ) -> dict[str, Any]:
        """Extend leases for in-flight claimed inputs owned by `worker_id`."""
        worker = str(worker_id or "").strip()
        if not worker:
            raise ValueError("worker_id is required")
        ids = _normalize_id_list(input_ids, max_len=500)
        lease_seconds = max(30, min(_strict_int(lease_seconds, "lease_seconds"), 86400))
        expires = datetime.now(timezone.utc) + timedelta(seconds=lease_seconds)

        if not ids:
            return {
                "requested": 0,
                "renewed": 0,
                "renewed_ids": [],
                "lease_expires_at": expires.isoformat(),
            }

        with self.db.transaction() as conn:
            rows = conn.execute(
                """
                UPDATE public.eval_inputs
                SET lease_expires_at = %s,
                    updated_at = now()
                WHERE input_id = ANY(%s)
                  AND eval_status = 'claimed'
                  AND claimed_by = %s
                RETURNING input_id
                """,
                (expires, ids, worker),
            ).fetchall()
        renewed_ids = [int(r["input_id"]) for r in rows]
        return {
            "requested": len(ids),
            "renewed": len(renewed_ids),
            "renewed_ids": renewed_ids,
            "lease_expires_at": expires.isoformat(),
        }

    def release_inputs(
        self,
        worker_id: str,
        input_ids: list[int],
        *,
        decrement_attempts: bool = True,
    ) -> dict[str, Any]:
        """Release claimed leases owned by `worker_id` immediately back to `pending`."""
        worker = str(worker_id or "").strip()
        if not worker:
            raise ValueError("worker_id is required")
        ids = _normalize_id_list(input_ids, max_len=500)
        if not ids:
            return {"requested": 0, "released": 0, "released_ids": []}

        with self.db.transaction() as conn:
            rows = conn.execute(
                """
                UPDATE public.eval_inputs
                SET eval_status = 'pending',
                    claimed_by = NULL,
                    lease_expires_at = NULL,
                    eval_attempts = CASE WHEN %s THEN GREATEST(0, eval_attempts - 1) ELSE eval_attempts END,
                    updated_at = now()
                WHERE input_id = ANY(%s)
                  AND eval_status = 'claimed'
                  AND claimed_by = %s
                RETURNING input_id
                """,
                (bool(decrement_attempts), ids, worker),
            ).fetchall()
        released_ids = [int(r["input_id"]) for r in rows]
        return {
            "requested": len(ids),
            "released": len(released_ids),
            "released_ids": released_ids,
        }

    def fail_inputs(
        self,
        worker_id: str,
        items: list[dict[str, Any]],
        *,
        max_attempts: int = 3,
    ) -> list[dict[str, Any]]:
        """Record permanent `skipped` or transient/terminal `failed` transitions for claimed inputs."""
        worker = str(worker_id or "").strip()
        if not worker:
            raise ValueError("worker_id is required")
        default_max = max(1, _strict_int(max_attempts, "max_attempts"))
        if not isinstance(items, list) or not items:
            raise ValueError("items must be a non-empty list")
        if len(items) > 200:
            raise ValueError("items length exceeds max 200")

        validated: list[dict[str, Any]] = []
        for raw in items:
            if not isinstance(raw, dict):
                raise ValueError("each item must be an object")
            iid = _strict_int(raw.get("input_id"), "items[].input_id")
            status = str(raw.get("status") or "").strip()
            if status not in ("skipped", "failed"):
                raise ValueError(f"Unsupported items[].status={status!r}")
            err = str(raw.get("error") or "")[:2000]
            raw_retry = raw.get("retry_after_seconds")
            retry_sec = 600 if raw_retry is None else max(0, _strict_int(raw_retry, "retry_after_seconds"))
            raw_max = raw.get("max_attempts")
            eff_max = default_max if raw_max is None else max(1, _strict_int(raw_max, "max_attempts"))
            validated.append(
                {
                    "input_id": iid,
                    "status": status,
                    "error": err,
                    "retry_after_seconds": retry_sec,
                    "max_attempts": eff_max,
                }
            )

        now = datetime.now(timezone.utc)
        results: list[dict[str, Any]] = []
        with self.db.transaction() as conn:
            for it in validated:
                row = conn.execute(
                    """
                    SELECT input_id, eval_status, claimed_by, eval_attempts
                    FROM public.eval_inputs
                    WHERE input_id = %s
                    FOR UPDATE
                    """,
                    (it["input_id"],),
                ).fetchone()
                if row is None or row["eval_status"] != "claimed" or row["claimed_by"] != worker:
                    results.append(
                        {
                            "input_id": it["input_id"],
                            "applied": False,
                            "eval_status": row["eval_status"] if row else None,
                            "eval_attempts": int(row["eval_attempts"]) if row else 0,
                        }
                    )
                    continue

                attempts = int(row["eval_attempts"])
                if it["status"] == "skipped":
                    db_status, resp_status, lease_exp = "skipped", "skipped", None
                elif it["retry_after_seconds"] > 0 and attempts < it["max_attempts"]:
                    db_status, resp_status = "claimed", "retrying"
                    lease_exp = now + timedelta(seconds=it["retry_after_seconds"])
                else:
                    db_status, resp_status, lease_exp = "failed", "failed", None

                conn.execute(
                    """
                    UPDATE public.eval_inputs
                    SET eval_status = %s,
                        claimed_by = NULL,
                        lease_expires_at = %s,
                        eval_error = %s,
                        updated_at = now()
                    WHERE input_id = %s
                    """,
                    (db_status, lease_exp, it["error"], it["input_id"]),
                )
                entry: dict[str, Any] = {
                    "input_id": it["input_id"],
                    "applied": True,
                    "eval_status": resp_status,
                    "eval_attempts": attempts,
                }
                if lease_exp is not None:
                    entry["next_retry_at"] = lease_exp.isoformat()
                results.append(entry)
        return results

    def _lookup_eval_input(
        self,
        conn: psycopg.Connection,
        *,
        model: str,
        trace_id: str,
        input_id: int | None = None,
        for_update: bool = False,
    ) -> dict[str, Any] | None:
        lock_sql = " FOR UPDATE" if for_update else ""
        if input_id is not None:
            cand = conn.execute(
                f"SELECT input_id, trace_id, biz_day, app_version FROM public.eval_inputs WHERE input_id = %s AND model = %s{lock_sql}",
                (input_id, model),
            ).fetchone()
            if cand is not None and cand["trace_id"] == trace_id:
                return cand
        return conn.execute(
            f"SELECT input_id, trace_id, biz_day, app_version FROM public.eval_inputs WHERE product = %s AND model = %s AND trace_id = %s{lock_sql}",
            (self.cfg.product, model, trace_id),
        ).fetchone()

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
        input_id: int | None = None,
        fallback_day: str | None = None,
    ) -> list[int]:
        """Blob-First write of attribution (+ optional compact) and transactional PG commit."""
        parsed_fallback = _parse_iso_day(fallback_day, "fallback_day")
        parsed_list = extract_attribution_fields(
            attr_record,
            model,
            fallback_day=parsed_fallback.isoformat() if parsed_fallback else None,
            intent_tax=self.intent_tax,
        )
        if not parsed_list:
            raise ValueError("Attribution record contains no valid turns with trace_id")

        preferred_input_id = _strict_int(input_id, "input_id") if input_id is not None else None
        attr_frame, attr_raw_len = compress_record_line(attr_record, level=self.cfg.zstd_level)
        comp_frame, comp_raw_len = (
            compress_record_line(compact_record, level=self.cfg.zstd_level) if compact_record is not None else (None, 0)
        )
        biz_day = parsed_list[0]["biz_day"]
        output_ids: list[int] = []

        with self._local_lock, self.db.transaction() as conn:
            if preferred_input_id is not None or biz_day == date(1970, 1, 1):
                day_row = self._lookup_eval_input(
                    conn,
                    model=model,
                    trace_id=parsed_list[0]["trace_id"],
                    input_id=preferred_input_id,
                )
                if day_row is not None and day_row["biz_day"] is not None:
                    biz_day = day_row["biz_day"]

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

            use_input_id = preferred_input_id if len(parsed_list) == 1 else None
            for item in parsed_list:
                inp = self._lookup_eval_input(
                    conn,
                    model=model,
                    trace_id=item["trace_id"],
                    input_id=use_input_id,
                    for_update=True,
                )
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

    def list_pending_human_read(
        self,
        *,
        models: list[str] | None = None,
        dates: list[date | str] | None = None,
        kinds: list[str] | None = None,
        prompt_version: str = "",
        include_failed: bool = False,
        limit: int = 100,
    ) -> list[dict[str, Any]]:
        """List latest daily outputs needing human_read translation (`attribution` / `compact`)."""
        req_kinds = list(dict.fromkeys(kinds or ["attribution", "compact"]))
        if not req_kinds or any(k not in ("attribution", "compact") for k in req_kinds):
            raise ValueError(f"Unsupported kinds={req_kinds!r}; expected subset of ('attribution', 'compact')")
        filter_models = list(dict.fromkeys(str(m).strip() for m in (models or []) if str(m).strip())) or None
        filter_dates = [_parse_iso_day(d, "dates") for d in (dates or []) if d not in (None, "")]
        filter_dates = [d for d in filter_dates if d is not None] or None
        limit = max(1, min(_strict_int(limit, "limit"), 500))
        pv = str(prompt_version or "").strip()
        excluded_statuses = ["done"] if include_failed else ["done", "failed"]

        kind_cols = {
            "attribution": ("o.attr_file_id", "o.attr_offset", "o.attr_len"),
            "compact": ("o.compact_file_id", "o.compact_offset", "o.compact_len"),
        }
        branches: list[str] = []
        params: list[Any] = []
        for kind in req_kinds:
            file_col, off_col, len_col = kind_cols[kind]
            where_parts = [
                "o.is_latest = TRUE",
                f"{file_col} IS NOT NULL",
                f"{len_col} > 0",
                "(h.overlay_id IS NULL OR NOT (h.status = ANY(%s) AND (%s = '' OR COALESCE(h.prompt_version, '') = %s)))",
            ]
            branch_params: list[Any] = [kind, kind, excluded_statuses, pv, pv]
            if filter_models:
                where_parts.append("o.model = ANY(%s)")
                branch_params.append(filter_models)
            if filter_dates:
                where_parts.append("o.biz_day = ANY(%s)")
                branch_params.append(filter_dates)
            branches.append(
                f"""
                SELECT
                    o.output_id,
                    o.input_id,
                    o.model,
                    o.trace_id,
                    o.biz_day,
                    %s::TEXT AS target_kind,
                    pf_in.rel_path AS input_rel_path,
                    i.input_offset,
                    i.input_len,
                    pf_t.rel_path AS target_rel_path,
                    {off_col} AS target_offset,
                    {len_col} AS target_len
                FROM public.eval_outputs o
                JOIN public.eval_inputs i ON i.input_id = o.input_id AND NOT i.is_deleted
                LEFT JOIN public.pack_files pf_in ON pf_in.file_id = i.input_file_id
                JOIN public.pack_files pf_t ON pf_t.file_id = {file_col}
                LEFT JOIN public.human_read_overlays h
                    ON h.output_id = o.output_id AND h.target_kind = %s
                WHERE {' AND '.join(where_parts)}
                """
            )
            params.extend(branch_params)

        sql = f"""
            SELECT
                output_id, input_id, model, trace_id, biz_day, target_kind,
                input_rel_path, input_offset, input_len,
                target_rel_path, target_offset, target_len
            FROM ({' UNION ALL '.join(branches)}) pending
            ORDER BY
                biz_day DESC,
                CASE WHEN target_kind = 'attribution' THEN 0 ELSE 1 END ASC,
                CASE WHEN model LIKE '%%expert%%' THEN 0 ELSE 1 END ASC,
                model ASC,
                output_id ASC
            LIMIT %s
        """
        params.append(limit)

        with self.db.connection() as conn:
            rows = conn.execute(sql, params).fetchall()
        out: list[dict[str, Any]] = []
        for r in rows:
            item = dict(r)
            if isinstance(item.get("biz_day"), date):
                item["biz_day"] = item["biz_day"].isoformat()
            out.append(item)
        return out

    def fail_human_read_overlay(
        self,
        *,
        output_id: int,
        target_kind: str,
        prompt_version: str | None = None,
        translator_model: str | None = None,
        source_hash: str | None = None,
        error: str = "",
    ) -> dict[str, Any]:
        """Record a failed human_read translation attempt without clobbering an up-to-date `done` overlay."""
        oid = _strict_int(output_id, "output_id")
        if target_kind not in ("attribution", "compact"):
            raise ValueError(f"Unsupported target_kind={target_kind!r}")
        err_msg = str(error or "")[:2000]

        with self.db.transaction() as conn:
            out = conn.execute(
                "SELECT output_id, input_id FROM public.eval_outputs WHERE output_id = %s",
                (oid,),
            ).fetchone()
            if out is None:
                raise KeyError(f"eval_outputs.output_id={oid} not found")

            row = conn.execute(
                """
                INSERT INTO public.human_read_overlays (
                    output_id, input_id, target_kind, status,
                    prompt_version, translator_model, source_hash, extra, updated_at
                )
                VALUES (%s, %s, %s, 'failed', %s, %s, %s, %s, now())
                ON CONFLICT (output_id, target_kind) DO UPDATE SET
                    status = 'failed',
                    prompt_version = EXCLUDED.prompt_version,
                    translator_model = EXCLUDED.translator_model,
                    source_hash = EXCLUDED.source_hash,
                    extra = public.human_read_overlays.extra || EXCLUDED.extra,
                    updated_at = now()
                WHERE public.human_read_overlays.status <> 'done'
                   OR COALESCE(public.human_read_overlays.prompt_version, '') <> COALESCE(EXCLUDED.prompt_version, '')
                RETURNING status
                """,
                (
                    out["output_id"],
                    out["input_id"],
                    target_kind,
                    (str(prompt_version).strip() or None) if prompt_version is not None else None,
                    (str(translator_model).strip() or None) if translator_model is not None else None,
                    (str(source_hash).strip() or None) if source_hash is not None else None,
                    Jsonb({"error": err_msg}),
                ),
            ).fetchone()
        return {
            "output_id": int(out["output_id"]),
            "target_kind": target_kind,
            "status": str(row["status"]) if row else "done",
        }

    # ------------------------------------------------------------------ Realtime Monitor Summary

    def get_monitor_summary(self, *, models: list[str] | None = None) -> dict[str, Any]:
        """Live base-table aggregation for `server_monitor` (never reads stale materialized views)."""
        filter_models = list(dict.fromkeys(str(m).strip() for m in (models or []) if str(m).strip())) or None
        now = datetime.now(timezone.utc)
        model_filter_i = " AND i.model = ANY(%s)" if filter_models else ""
        model_filter_o = " AND o.model = ANY(%s)" if filter_models else ""
        model_filter_p = " AND p.model = ANY(%s)" if filter_models else ""

        with self.db.connection() as conn:
            # 1. Inputs + latest outputs + 6-bucket queue stats via single GROUPING SETS scan
            main_params: list[Any] = [now, now, now]
            if filter_models:
                main_params.append(filter_models)
            main_rows = conn.execute(
                f"""
                SELECT
                    i.model,
                    i.biz_day,
                    GROUPING(i.model) AS g_model,
                    GROUPING(i.biz_day) AS g_day,
                    COUNT(*)::BIGINT AS input_traces,
                    COUNT(DISTINCT COALESCE(NULLIF(i.session_id, ''), i.trace_id))::BIGINT AS input_sessions,
                    COUNT(o.output_id)::BIGINT AS evaluated_traces,
                    COUNT(DISTINCT COALESCE(NULLIF(i.session_id, ''), i.trace_id))
                        FILTER (WHERE o.output_id IS NOT NULL)::BIGINT AS evaluated_sessions,
                    COUNT(o.output_id) FILTER (WHERE o.compact_file_id IS NOT NULL)::BIGINT AS compact_traces,
                    COALESCE(SUM(o.problem_count), 0)::BIGINT AS problem_count,
                    COUNT(*) FILTER (WHERE i.has_input_blob)::BIGINT AS q_total,
                    COUNT(*) FILTER (WHERE i.has_input_blob AND i.eval_status = 'evaluated')::BIGINT AS q_evaluated,
                    COUNT(*) FILTER (
                        WHERE i.has_input_blob
                          AND (
                              i.eval_status = 'pending'
                              OR (i.eval_status = 'claimed' AND (i.lease_expires_at IS NULL OR i.lease_expires_at < %s))
                          )
                    )::BIGINT AS q_pending,
                    COUNT(*) FILTER (
                        WHERE i.has_input_blob
                          AND i.eval_status = 'claimed'
                          AND i.claimed_by IS NOT NULL
                          AND i.lease_expires_at >= %s
                    )::BIGINT AS q_claimed,
                    COUNT(*) FILTER (
                        WHERE i.has_input_blob
                          AND i.eval_status = 'claimed'
                          AND i.claimed_by IS NULL
                          AND i.lease_expires_at >= %s
                    )::BIGINT AS q_retrying,
                    COUNT(*) FILTER (WHERE i.has_input_blob AND i.eval_status = 'failed')::BIGINT AS q_failed,
                    COUNT(*) FILTER (WHERE i.has_input_blob AND i.eval_status = 'skipped')::BIGINT AS q_skipped
                FROM public.eval_inputs i
                LEFT JOIN public.eval_outputs o
                    ON o.input_id = i.input_id AND o.is_latest = TRUE
                WHERE NOT i.is_deleted{model_filter_i}
                GROUP BY GROUPING SETS ((i.model, i.biz_day), (i.model), ())
                """,
                main_params,
            ).fetchall()

            # 2. Human-read overlay counts by model
            hr_params = [filter_models] if filter_models else []
            hr_rows = conn.execute(
                f"""
                SELECT
                    o.model,
                    COUNT(*) FILTER (WHERE h.target_kind = 'attribution' AND h.status = 'done')::BIGINT AS hr_attr_done,
                    COUNT(*) FILTER (WHERE h.target_kind = 'compact' AND h.status = 'done')::BIGINT AS hr_compact_done,
                    COUNT(*) FILTER (WHERE h.status = 'failed')::BIGINT AS hr_failed
                FROM public.human_read_overlays h
                JOIN public.eval_outputs o ON o.output_id = h.output_id AND o.is_latest = TRUE
                JOIN public.eval_inputs i ON i.input_id = o.input_id AND NOT i.is_deleted
                WHERE TRUE{model_filter_o}
                GROUP BY o.model
                """,
                hr_params,
            ).fetchall()

            # 3. Lost user metrics
            lost_params = [filter_models] if filter_models else []
            lost_row = conn.execute(
                f"""
                SELECT
                    COUNT(*)::BIGINT AS input_traces,
                    COUNT(DISTINCT COALESCE(NULLIF(i.session_id, ''), i.trace_id))::BIGINT AS input_sessions,
                    COUNT(o.output_id)::BIGINT AS evaluated_traces,
                    COUNT(DISTINCT COALESCE(NULLIF(i.session_id, ''), i.trace_id))
                        FILTER (WHERE o.output_id IS NOT NULL)::BIGINT AS evaluated_sessions,
                    COALESCE(SUM(o.problem_count), 0)::BIGINT AS problem_count
                FROM public.eval_inputs i
                JOIN public.users u ON u.user_id = i.user_id AND u.is_lost = TRUE
                LEFT JOIN public.eval_outputs o ON o.input_id = i.input_id AND o.is_latest = TRUE
                WHERE NOT i.is_deleted{model_filter_i}
                """,
                lost_params,
            ).fetchone()

            # 4. Pending (unclustered) problems & traces via partial index `idx_eval_problems_unclustered`
            cl_params = [filter_models] if filter_models else []
            cl_rows = conn.execute(
                f"""
                SELECT
                    p.model,
                    COUNT(*)::BIGINT AS pending_problems,
                    COUNT(DISTINCT p.input_id)::BIGINT AS pending_traces
                FROM public.eval_problems p
                JOIN public.eval_outputs o ON o.output_id = p.output_id AND o.is_latest = TRUE
                JOIN public.eval_inputs i ON i.input_id = p.input_id AND NOT i.is_deleted
                WHERE p.cluster_code IS NULL{model_filter_p}
                GROUP BY p.model
                """,
                cl_params,
            ).fetchall()

        def _queue_buckets(row: dict[str, Any]) -> dict[str, int]:
            return {
                "total": int(row.get("q_total", 0)),
                "evaluated": int(row.get("q_evaluated", 0)),
                "pending": int(row.get("q_pending", 0)),
                "claimed": int(row.get("q_claimed", 0)),
                "retrying": int(row.get("q_retrying", 0)),
                "failed": int(row.get("q_failed", 0)),
                "skipped": int(row.get("q_skipped", 0)),
            }

        def _trace_counts(row: dict[str, Any]) -> dict[str, int]:
            return {
                "input_traces": int(row.get("input_traces", 0)),
                "input_sessions": int(row.get("input_sessions", 0)),
                "evaluated_traces": int(row.get("evaluated_traces", 0)),
                "evaluated_sessions": int(row.get("evaluated_sessions", 0)),
                "compact_traces": int(row.get("compact_traces", 0)),
            }

        grand: dict[str, Any] = {}
        model_totals: dict[str, dict[str, Any]] = {}
        model_dates: dict[str, list[dict[str, Any]]] = {}
        for r in main_rows:
            gm, gd = int(r["g_model"]), int(r["g_day"])
            if gm == 1 and gd == 1:
                grand = r
            elif gm == 0 and gd == 1:
                model_totals[r["model"]] = r
            elif gm == 0 and gd == 0:
                model_dates.setdefault(r["model"], []).append(
                    {
                        "date": r["biz_day"].isoformat() if isinstance(r["biz_day"], date) else str(r["biz_day"]),
                        **_trace_counts(r),
                        "pending": int(r["q_pending"]),
                        "claimed": int(r["q_claimed"]),
                        "retrying": int(r["q_retrying"]),
                        "failed": int(r["q_failed"]),
                        "skipped": int(r["q_skipped"]),
                    }
                )

        hr_by_model = {r["model"]: r for r in hr_rows}
        cl_by_model = {r["model"]: r for r in cl_rows}
        queue_models: list[dict[str, Any]] = []
        models_out: list[dict[str, Any]] = []
        cluster_models: list[dict[str, Any]] = []

        for m in sorted(model_totals.keys()):
            mt = model_totals[m]
            hr = hr_by_model.get(m) or {}
            cl = cl_by_model.get(m) or {}
            out_traces = int(mt["evaluated_traces"])
            pending_traces = int(cl.get("pending_traces", 0))
            tot_probs = int(mt["problem_count"])
            pending_probs = int(cl.get("pending_problems", 0))

            queue_models.append({"name": m, **_queue_buckets(mt)})
            models_out.append(
                {
                    "name": m,
                    **_trace_counts(mt),
                    "problem_count": tot_probs,
                    "hr_attr_done": int(hr.get("hr_attr_done", 0)),
                    "hr_compact_done": int(hr.get("hr_compact_done", 0)),
                    "dates": sorted(model_dates.get(m, []), key=lambda d: d["date"], reverse=True),
                }
            )
            cluster_models.append(
                {
                    "name": m,
                    "output_traces": out_traces,
                    "clustered_traces": max(0, out_traces - pending_traces),
                    "pending_traces": pending_traces,
                    "total_problems": tot_probs,
                    "clustered_problems": max(0, tot_probs - pending_probs),
                    "pending_problems": pending_probs,
                }
            )

        lr = lost_row or {}
        return {
            "generated_at": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "db_epoch": self.db_epoch,
            "totals": {
                **_trace_counts(grand),
                "problem_count": int(grand.get("problem_count", 0)),
                "hr_attr_done": sum(int(r["hr_attr_done"]) for r in hr_rows),
                "hr_compact_done": sum(int(r["hr_compact_done"]) for r in hr_rows),
                "hr_failed": sum(int(r["hr_failed"]) for r in hr_rows),
            },
            "queue": {**_queue_buckets(grand), "models": queue_models},
            "models": models_out,
            "lost_user": {
                "input_traces": int(lr.get("input_traces", 0)),
                "input_sessions": int(lr.get("input_sessions", 0)),
                "evaluated_traces": int(lr.get("evaluated_traces", 0)),
                "evaluated_sessions": int(lr.get("evaluated_sessions", 0)),
                "problem_count": int(lr.get("problem_count", 0)),
            },
            "cluster": {"models": cluster_models},
        }

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
        data_cutoff: str | None = None,
        return_stats: bool = False,
    ) -> int | dict[str, int]:
        """Step 3 incremental cluster binding on `eval_problems` with diff guard, change events, and cutoff advance."""
        if not isinstance(bindings, list):
            raise ValueError("bindings must be a list")
        tid_val = _strict_int(tree_id, "tree_id") if tree_id is not None else None
        cutoff = str(data_cutoff).strip() if data_cutoff is not None else ""

        dedup: dict[int, dict[str, Any]] = {}
        for item in bindings:
            if not isinstance(item, dict):
                raise ValueError("each binding must be an object")
            pid = _strict_int(item.get("problem_id"), "bindings[].problem_id")
            code = item.get("cluster_code")
            l1, l2, l3, l4 = split_cluster_code(code)
            raw_tags = item.get("tags")
            tags = [str(t) for t in raw_tags if t] if isinstance(raw_tags, list) else None
            dedup[pid] = {
                "problem_id": pid,
                "cluster_code": code,
                "l1_stage": l1,
                "l2_mechanism": l2,
                "l3_leaf": l3,
                "l4_subleaf": l4,
                "is_edge": bool(item.get("is_edge", False)),
                "tags": tags,
            }

        updated = 0
        changes_emitted = 0
        if dedup or (tid_val is not None and cutoff):
            with self.db.transaction() as conn:
                if dedup:
                    rows = conn.execute(
                        """
                        WITH incoming AS (
                            SELECT
                                x.problem_id,
                                x.cluster_code,
                                x.l1_stage,
                                x.l2_mechanism,
                                x.l3_leaf,
                                x.l4_subleaf,
                                x.is_edge,
                                CASE
                                    WHEN x.tags IS NULL OR jsonb_typeof(x.tags) <> 'array' THEN NULL
                                    ELSE ARRAY(SELECT jsonb_array_elements_text(x.tags))
                                END AS tags
                            FROM jsonb_to_recordset(%s::jsonb) AS x(
                                problem_id BIGINT,
                                cluster_code TEXT,
                                l1_stage TEXT,
                                l2_mechanism TEXT,
                                l3_leaf TEXT,
                                l4_subleaf TEXT,
                                is_edge BOOLEAN,
                                tags JSONB
                            )
                        )
                        UPDATE public.eval_problems p
                        SET cluster_tree_id = COALESCE(%s, p.cluster_tree_id),
                            cluster_version = COALESCE(%s, p.cluster_version),
                            cluster_code = s.cluster_code,
                            l1_stage = s.l1_stage,
                            l2_mechanism = s.l2_mechanism,
                            l3_leaf = s.l3_leaf,
                            l4_subleaf = s.l4_subleaf,
                            is_edge = s.is_edge,
                            tags = COALESCE(s.tags, p.tags),
                            clustered_at = now()
                        FROM incoming s
                        WHERE p.problem_id = s.problem_id
                          AND (
                              p.cluster_code IS DISTINCT FROM s.cluster_code
                              OR p.is_edge IS DISTINCT FROM s.is_edge
                              OR p.tags IS DISTINCT FROM COALESCE(s.tags, p.tags)
                          )
                        RETURNING p.output_id
                        """,
                        (Jsonb(list(dedup.values())), tid_val, cluster_version),
                    ).fetchall()
                    updated = len(rows)
                    output_ids = sorted({int(r["output_id"]) for r in rows})
                    changes_emitted = emit_trace_changes(conn, self.db_epoch, output_ids)

                if tid_val is not None and cutoff:
                    conn.execute(
                        """
                        UPDATE public.cluster_trees
                        SET data_cutoff = GREATEST(COALESCE(data_cutoff, ''), %s)
                        WHERE tree_id = %s AND is_current = TRUE
                        """,
                        (cutoff, tid_val),
                    )

        if return_stats:
            return {"updated": updated, "changes_emitted": changes_emitted}
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
