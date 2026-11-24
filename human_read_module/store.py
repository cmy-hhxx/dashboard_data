"""SQLite WAL state + append-only mirror JSONL storage for human_read outputs.

Directory layout under ``<human_read_root>`` (e.g. ``/mnt/aime_eval_ssd/1_aime/eval_output/human_read``):
    .state/state.sqlite3                 # WAL index: (rel_path, record_key) -> byte offset in mirror file
    .state/runner.lock                   # flock preventing concurrent backfill daemons
    0_daily_eval/<model>/<model>_attribution-<date>.jsonl
    0_daily_eval/<model>/compact/<model>_compact-<date>.jsonl
    ab_test/<round>/03_after_release_retest/attribution/...
    ab_test/<round>/99_provenance/retest_eval_run/compact/...
    ab_test/<round>/02_before_release/attribution/...
"""
from __future__ import annotations

import datetime as dt
import hashlib
import json
import os
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any

from .translator import attribution_text_fingerprint, compact_text_fingerprint


def record_key_for_record(rec: dict[str, Any], kind: str) -> str:
    """Stable, deterministic key for an attribution or compact record."""
    sm = rec.get("session_meta") if isinstance(rec.get("session_meta"), dict) else {}
    tm_raw = rec.get("trace_meta")
    tm_list = tm_raw if isinstance(tm_raw, list) else ([tm_raw] if isinstance(tm_raw, dict) else [])
    tids = []
    for t in rec.get("turns") or []:
        if not isinstance(t, dict):
            continue
        meta = t.get("meta") if isinstance(t.get("meta"), dict) else {}
        tid = meta.get("trace_id")
        if tid and str(tid) not in tids:
            tids.append(str(tid))
    for tm in tm_list:
        if isinstance(tm, dict):
            cand = tm.get("trace_id")
            if cand and not str(cand).startswith("thread_") and str(cand) not in tids:
                tids.append(str(cand))
    for cand in (sm.get("trace_id"), rec.get("trace_id")):
        if cand and not str(cand).startswith("thread_") and str(cand) not in tids:
            tids.append(str(cand))

    item_id = str(sm.get("item_id") or "")
    case_id = str(sm.get("case_id") or "")
    sid = str(sm.get("session_id") or "")
    rt = str(sm.get("request_time") or "")

    if tids:
        base = "tid:" + ",".join(tids[:6])
        return f"{base}|{rt}" if rt else base
    if item_id:
        return f"item:{item_id}"
    if sid and rt:
        return f"sid:{sid}|{rt}"
    if case_id:
        return f"case:{case_id}|{rt}"
    # Deterministic fallback hash of text fingerprint
    fp = attribution_text_fingerprint(rec) if kind == "attribution" else compact_text_fingerprint(rec)
    return f"fp:{fp}"


def text_fingerprint_for_record(rec: dict[str, Any], kind: str) -> str:
    if kind == "attribution":
        return attribution_text_fingerprint(rec)
    return compact_text_fingerprint(rec)


class HumanReadStore:
    """Thread-safe SQLite WAL state + append-only mirror JSONL writer."""

    def __init__(self, human_read_root: Path | str, readonly: bool = False):
        self.root = Path(human_read_root)
        self.state_dir = self.root / ".state"
        self.db_path = self.state_dir / "state.sqlite3"
        self.readonly = readonly
        self._write_lock = threading.Lock()
        self._file_locks: dict[str, threading.Lock] = {}
        self._file_locks_guard = threading.Lock()

        if not readonly:
            self.state_dir.mkdir(parents=True, exist_ok=True)
            self._conn = sqlite3.connect(str(self.db_path), timeout=60.0, check_same_thread=False)
            self._conn.execute("PRAGMA journal_mode=WAL;")
            self._conn.execute("PRAGMA synchronous=NORMAL;")
            self._init_schema()
        else:
            if not self.db_path.is_file():
                self._conn = None
            else:
                uri = f"file:{self.db_path}?mode=ro"
                self._conn = sqlite3.connect(uri, uri=True, timeout=10.0, check_same_thread=False)

    def _init_schema(self):
        self._conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS records (
                rel_path      TEXT NOT NULL,
                record_key    TEXT NOT NULL,
                kind          TEXT NOT NULL,
                source_hash   TEXT NOT NULL,
                prompt_ver    TEXT NOT NULL,
                model         TEXT NOT NULL,
                out_offset    INTEGER NOT NULL,
                out_bytes     INTEGER NOT NULL,
                status        TEXT NOT NULL,
                error         TEXT,
                updated_at    TEXT NOT NULL,
                updated_at_ns INTEGER NOT NULL,
                PRIMARY KEY (rel_path, record_key)
            );
            CREATE INDEX IF NOT EXISTS idx_records_hash ON records(rel_path, source_hash);
            CREATE INDEX IF NOT EXISTS idx_records_status ON records(status, rel_path);
            """
        )
        self._conn.commit()

    def close(self):
        if self._conn is not None:
            try:
                self._conn.close()
            except Exception:
                pass
            self._conn = None

    def _lock_for(self, rel_path: str) -> threading.Lock:
        with self._file_locks_guard:
            lk = self._file_locks.get(rel_path)
            if lk is None:
                lk = threading.Lock()
                self._file_locks[rel_path] = lk
            return lk

    def existing_status(self, rel_path: str, prompt_ver: str) -> dict[str, tuple[str, str, str]]:
        """Load {record_key: (source_hash, prompt_ver, status)} and {source_hash: status} for one file."""
        if self._conn is None:
            return {}
        with self._write_lock:
            rows = self._conn.execute(
                "SELECT record_key, source_hash, prompt_ver, status FROM records WHERE rel_path=?",
                (rel_path,),
            ).fetchall()
        return {rk: (sh, pv, st) for rk, sh, pv, st in rows}

    def existing_ok_hashes(self, rel_path: str, prompt_ver: str) -> dict[str, tuple[int, int, str]]:
        """Load {source_hash: (out_offset, out_bytes, model)} for already-ok records in rel_path."""
        if self._conn is None:
            return {}
        with self._write_lock:
            rows = self._conn.execute(
                "SELECT source_hash, out_offset, out_bytes, model FROM records "
                "WHERE rel_path=? AND prompt_ver=? AND status='ok'",
                (rel_path, prompt_ver),
            ).fetchall()
        return {sh: (off, sz, m) for sh, off, sz, m in rows}

    def save_ok(
        self,
        rel_path: str,
        record_key: str,
        kind: str,
        source_hash: str,
        prompt_ver: str,
        model: str,
        translated_record: dict[str, Any],
    ) -> tuple[int, int]:
        """Append one complete translated JSON line to the mirror file and index its byte span."""
        target = self.root / rel_path
        target.parent.mkdir(parents=True, exist_ok=True)
        raw_line = (json.dumps(translated_record, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")

        flk = self._lock_for(rel_path)
        with flk:
            with open(target, "ab") as fh:
                offset = fh.tell()
                fh.write(raw_line)
                fh.flush()
            out_bytes = len(raw_line)

        now_iso = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        now_ns = time.time_ns()
        with self._write_lock:
            self._conn.execute(
                """
                INSERT INTO records (
                    rel_path, record_key, kind, source_hash, prompt_ver, model,
                    out_offset, out_bytes, status, error, updated_at, updated_at_ns
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ok', NULL, ?, ?)
                ON CONFLICT(rel_path, record_key) DO UPDATE SET
                    source_hash=excluded.source_hash,
                    prompt_ver=excluded.prompt_ver,
                    model=excluded.model,
                    out_offset=excluded.out_offset,
                    out_bytes=excluded.out_bytes,
                    status='ok',
                    error=NULL,
                    updated_at=excluded.updated_at,
                    updated_at_ns=excluded.updated_at_ns
                """,
                (rel_path, record_key, kind, source_hash, prompt_ver, model, offset, out_bytes, now_iso, now_ns),
            )
            self._conn.commit()
        return offset, out_bytes

    def alias_ok(
        self,
        rel_path: str,
        record_key: str,
        kind: str,
        source_hash: str,
        prompt_ver: str,
        model: str,
        out_offset: int,
        out_bytes: int,
    ):
        """Point a new record_key at an existing translated line with identical source_hash (zero LLM cost)."""
        now_iso = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        now_ns = time.time_ns()
        with self._write_lock:
            self._conn.execute(
                """
                INSERT INTO records (
                    rel_path, record_key, kind, source_hash, prompt_ver, model,
                    out_offset, out_bytes, status, error, updated_at, updated_at_ns
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ok', NULL, ?, ?)
                ON CONFLICT(rel_path, record_key) DO UPDATE SET
                    source_hash=excluded.source_hash,
                    prompt_ver=excluded.prompt_ver,
                    model=excluded.model,
                    out_offset=excluded.out_offset,
                    out_bytes=excluded.out_bytes,
                    status='ok',
                    error=NULL,
                    updated_at=excluded.updated_at,
                    updated_at_ns=excluded.updated_at_ns
                """,
                (rel_path, record_key, kind, source_hash, prompt_ver, model, out_offset, out_bytes, now_iso, now_ns),
            )
            self._conn.commit()

    def save_failed(
        self,
        rel_path: str,
        record_key: str,
        kind: str,
        source_hash: str,
        prompt_ver: str,
        model: str,
        error: str,
        transient: bool = False,
    ):
        now_iso = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        now_ns = time.time_ns()
        st = "transient_error" if transient else "failed"
        with self._write_lock:
            self._conn.execute(
                """
                INSERT INTO records (
                    rel_path, record_key, kind, source_hash, prompt_ver, model,
                    out_offset, out_bytes, status, error, updated_at, updated_at_ns
                ) VALUES (?, ?, ?, ?, ?, ?, -1, 0, ?, ?, ?, ?)
                ON CONFLICT(rel_path, record_key) DO UPDATE SET
                    source_hash=excluded.source_hash,
                    prompt_ver=excluded.prompt_ver,
                    model=excluded.model,
                    status=CASE WHEN records.status='ok' THEN 'ok' ELSE excluded.status END,
                    error=excluded.error,
                    updated_at=excluded.updated_at,
                    updated_at_ns=excluded.updated_at_ns
                """,
                (rel_path, record_key, kind, source_hash, prompt_ver, model, st, error[:1000], now_iso, now_ns),
            )
            self._conn.commit()

    def lookup(
        self,
        rel_path: str,
        record_key: str,
        source_hash: str,
    ) -> tuple[dict[str, Any], int] | None:
        """O(1) read of a translated record + updated_at_ns for dashboard detail overlay."""
        if self._conn is None:
            return None
        row = self._conn.execute(
            """
            SELECT out_offset, out_bytes, updated_at_ns
            FROM records
            WHERE rel_path=? AND status='ok' AND (record_key=? OR source_hash=?)
            ORDER BY (record_key=?) DESC, updated_at_ns DESC
            LIMIT 1
            """,
            (rel_path, record_key, source_hash, record_key),
        ).fetchone()
        if not row:
            return None
        out_offset, out_bytes, updated_at_ns = row
        if out_offset < 0 or out_bytes <= 0:
            return None
        target = self.root / rel_path
        try:
            fd = os.open(target, os.O_RDONLY)
            try:
                raw = os.pread(fd, out_bytes, out_offset)
            finally:
                os.close(fd)
            return json.loads(raw), int(updated_at_ns or 0)
        except (OSError, ValueError):
            return None

    def stats_summary(self) -> dict[str, Any]:
        if self._conn is None:
            return {"ok": 0, "failed": 0, "files": 0}
        rows = self._conn.execute(
            "SELECT kind, status, COUNT(*) FROM records GROUP BY kind, status"
        ).fetchall()
        files = self._conn.execute("SELECT COUNT(DISTINCT rel_path) FROM records WHERE status='ok'").fetchone()[0]
        out: dict[str, Any] = {"files_with_ok": files, "counts": {}}
        for kind, status, cnt in rows:
            out["counts"][f"{kind}:{status}"] = cnt
        return out
