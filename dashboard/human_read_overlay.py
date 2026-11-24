"""Read-only human_read overlay for dashboard detail builders (detail_builder.py & ab_detail.py).

Self-contained inside ``dashboard/`` so ``dashboard/deploy.sh`` has zero external module deps.
Reads ``<datasets>/1_aime/eval_output/human_read/.state/state.sqlite3`` (WAL read-only) and
``os.pread``s translated JSON lines from the mirrored JSONL files.

When no human_read translation exists (or on products like wencai without human_read),
every method degrades cleanly to a fast no-op and the dashboard serves the original output.
"""
from __future__ import annotations

import hashlib
import os
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any

import json_compat as json

ATTR_PROBLEM_FIELDS = ("label", "problem_phenomena", "reason", "severity_reason")

# (detail_compact_key, raw_compact_list_key, raw_compact_text_key)
COMPACT_OVERLAY_MAP = (
    ("plans", "plans", "content"),
    ("reasoning", "reasoning_chain", "content"),
    ("execution", "execution_chain", "content"),
    ("reflections", "reflections", "reflection_content"),
    ("tool_errors", "tool_errors", "tool_error_content"),
    ("artifacts", "artifacts", "artifacts_content"),
    ("components", "components", "components_content"),
)

COMPACT_FP_SPECS = (
    ("plans", "content"),
    ("reasoning_chain", "content"),
    ("execution_chain", "content"),
    ("reflections", "reflection_content"),
    ("tool_errors", "tool_error_content"),
    ("artifacts", "artifacts_content"),
    ("components", "components_content"),
)


def _attr_fingerprint(attr: dict[str, Any]) -> str:
    payload = {
        "session_summary": attr.get("session_summary") or "",
        "turns": [
            {
                "summary": t.get("summary") or "",
                "problem": [
                    {k: p.get(k) or "" for k in ATTR_PROBLEM_FIELDS}
                    for p in (t.get("problem") or [])
                ],
            }
            for t in (attr.get("turns") or [])
        ],
        "session_problem": [
            {k: p.get(k) or "" for k in ATTR_PROBLEM_FIELDS}
            for p in (attr.get("session_problem") or [])
        ],
    }
    raw = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()[:16]


def _compact_fingerprint(comp: dict[str, Any]) -> str:
    turns_out = []
    for t in comp.get("turns") or []:
        t_obj = {}
        for list_key, text_key in COMPACT_FP_SPECS:
            t_obj[list_key] = [str(it.get(text_key) or "") for it in (t.get(list_key) or [])]
        turns_out.append(t_obj)
    raw = json.dumps(turns_out, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()[:16]


def record_key_for_record(rec: dict[str, Any], kind: str) -> str:
    """Exact mirror of human_read_module.store.record_key_for_record."""
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
    fp = _attr_fingerprint(rec) if kind == "attribution" else _compact_fingerprint(rec)
    return f"fp:{fp}"


def daily_rel_path(dataset_rel: str | None) -> str | None:
    """Convert ``1_aime/eval_output/0_daily_eval/...`` -> ``0_daily_eval/...``."""
    if not dataset_rel:
        return None
    s = str(dataset_rel).replace("\\", "/")
    marker = "/eval_output/"
    idx = s.find(marker)
    if idx >= 0:
        return s[idx + len(marker):]
    if s.startswith("0_daily_eval/"):
        return s
    return None


def ab_rel_path(round_id: str, rel_inside_round: str | None) -> str | None:
    if not round_id or not rel_inside_round:
        return None
    return f"ab_test/{round_id}/{str(rel_inside_round).lstrip('/')}"


class HumanReadOverlay:
    """Thread-safe read-only lookup against ``1_aime/eval_output/human_read``."""

    def __init__(self, datasets: Path | str):
        self.datasets = Path(datasets)
        self.root = self.datasets / "1_aime" / "eval_output" / "human_read"
        self.db_path = self.root / ".state" / "state.sqlite3"
        self._local = threading.local()
        self._stamp_lock = threading.Lock()
        self._file_stamps: dict[str, tuple[float, int]] = {}  # rel_path -> (checked_monotonic, max_updated_at_ns)

    def _conn(self) -> sqlite3.Connection | None:
        try:
            st = self.db_path.stat()
            ino = (st.st_dev, st.st_ino)
        except OSError:
            self._close_local()
            return None
        cur_ino = getattr(self._local, "ino", None)
        conn = getattr(self._local, "conn", None)
        if conn is not None and cur_ino == ino:
            return conn
        self._close_local()
        try:
            conn = sqlite3.connect(f"file:{self.db_path}?mode=ro", uri=True, timeout=5.0)
            self._local.conn = conn
            self._local.ino = ino
            return conn
        except sqlite3.Error:
            return None

    def _close_local(self):
        conn = getattr(self._local, "conn", None)
        if conn is not None:
            try:
                conn.close()
            except Exception:
                pass
        self._local.conn = None
        self._local.ino = None

    def db_mtime_ns(self) -> int:
        """Latest mtime_ns of state.sqlite3 or its WAL file (0 if human_read not initialized)."""
        best = 0
        for p in (self.db_path, Path(str(self.db_path) + "-wal")):
            try:
                best = max(best, p.stat().st_mtime_ns)
            except OSError:
                pass
        return best

    def file_latest_ns(self, *rel_paths: str | None) -> int:
        """Cached (10s TTL) latest ``updated_at_ns`` among the given mirror rel_paths."""
        conn = self._conn()
        if conn is None:
            return 0
        now = time.monotonic()
        best = 0
        for rp in rel_paths:
            if not rp:
                continue
            with self._stamp_lock:
                cached = self._file_stamps.get(rp)
            if cached and now - cached[0] < 10.0:
                best = max(best, cached[1])
                continue
            try:
                row = conn.execute(
                    "SELECT MAX(updated_at_ns) FROM records WHERE rel_path=? AND status='ok'",
                    (rp,),
                ).fetchone()
                val = int((row[0] if row else 0) or 0)
            except sqlite3.Error:
                val = 0
            with self._stamp_lock:
                self._file_stamps[rp] = (now, val)
            best = max(best, val)
        return best

    def lookup(self, rel_path: str | None, orig_record: dict[str, Any] | None, kind: str) -> dict[str, Any] | None:
        """O(1) read of the translated mirror record for ``orig_record``, or None if unavailable."""
        if not rel_path or not isinstance(orig_record, dict):
            return None
        conn = self._conn()
        if conn is None:
            return None
        rkey = record_key_for_record(orig_record, kind)
        shash = _attr_fingerprint(orig_record) if kind == "attribution" else _compact_fingerprint(orig_record)
        try:
            row = conn.execute(
                """
                SELECT out_offset, out_bytes
                FROM records
                WHERE rel_path=? AND status='ok' AND (record_key=? OR source_hash=?)
                ORDER BY (record_key=?) DESC, updated_at_ns DESC
                LIMIT 1
                """,
                (rel_path, rkey, shash, rkey),
            ).fetchone()
        except sqlite3.Error:
            return None
        if not row:
            return None
        out_offset, out_bytes = row
        if out_offset < 0 or out_bytes <= 0:
            return None
        target = self.root / rel_path
        try:
            fd = os.open(target, os.O_RDONLY)
            try:
                raw = os.pread(fd, out_bytes, out_offset)
            finally:
                os.close(fd)
            rec = json.loads(raw)
            return rec if isinstance(rec, dict) else None
        except (OSError, ValueError):
            return None

    def overlay_detail(
        self,
        detail: dict[str, Any],
        attr_rel: str | None,
        orig_attr: dict[str, Any] | None,
        comp_rel: str | None = None,
        orig_comp: dict[str, Any] | None = None,
    ) -> bool:
        """Silently replace display text fields in ``detail`` with human_read translations.

        When no translation exists for a record, ``detail`` is left completely untouched
        (transparent fallback to original). Frozen fields (evidence, severity, component,
        cluster paths, IDs) are never modified.
        """
        hr_attr = self.lookup(attr_rel, orig_attr, "attribution") if attr_rel and orig_attr else None
        hr_comp = self.lookup(comp_rel, orig_comp, "compact") if comp_rel and orig_comp else None
        if not hr_attr and not hr_comp:
            return False

        applied = False

        if hr_attr and isinstance(detail.get("attribution"), dict):
            da = detail["attribution"]

            if (hr_attr.get("session_summary") or "").strip() and da.get("summary"):
                da["summary"] = hr_attr["session_summary"]
                applied = True

            hr_turns = hr_attr.get("turns") or []
            d_turns = da.get("turns") or []
            d_probs = da.get("problems") or []

            if len(hr_turns) == len(d_turns):
                for dt_row, ht_row in zip(d_turns, hr_turns):
                    if (ht_row.get("summary") or "").strip() and dt_row.get("summary"):
                        dt_row["summary"] = ht_row["summary"]
                        applied = True

                    hp_list = ht_row.get("problem") or []
                    dp_ids = dt_row.get("problems") or []
                    if len(hp_list) == len(dp_ids):
                        for pid, hp in zip(dp_ids, hp_list):
                            if 0 <= pid < len(d_probs) and _apply_problem_overlay(d_probs[pid], hp):
                                applied = True

            hr_sprobs = hr_attr.get("session_problem") or []
            d_sprob_ids = da.get("session_problems") or []
            if len(hr_sprobs) == len(d_sprob_ids):
                for pid, hp in zip(d_sprob_ids, hr_sprobs):
                    if 0 <= pid < len(d_probs) and _apply_problem_overlay(d_probs[pid], hp):
                        applied = True

        if hr_comp and isinstance(detail.get("compact"), dict):
            d_cturns = detail["compact"].get("turns") or []
            hr_cturns = hr_comp.get("turns") or []
            if len(d_cturns) == len(hr_cturns):
                for d_ct, h_ct in zip(d_cturns, hr_cturns):
                    for d_key, h_list_key, h_text_key in COMPACT_OVERLAY_MAP:
                        d_items = d_ct.get(d_key) or []
                        h_items = h_ct.get(h_list_key) or []
                        if len(d_items) == len(h_items) and d_items:
                            for d_it, h_it in zip(d_items, h_items):
                                new_txt = (h_it.get(h_text_key) or "").strip()
                                if new_txt and d_it.get("c"):
                                    d_it["c"] = new_txt
                                    applied = True

        return applied


def _apply_problem_overlay(dp: dict[str, Any], hp: dict[str, Any]) -> bool:
    changed = False
    for d_key, h_key in (
        ("label", "label"),
        ("ph", "problem_phenomena"),
        ("why", "reason"),
        ("sevr", "severity_reason"),
    ):
        new_val = (hp.get(h_key) or "").strip()
        if new_val and dp.get(d_key):
            dp[d_key] = new_val
            changed = True
    return changed
