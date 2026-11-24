"""Lightweight byte-offset index for pairing eval_input records with attribution/compact rows.

Reads only the leading metadata of each JSONL line (or quick regex scan) to keep memory
under ~50 MB per date window and uses ``os.pread`` on demand to fetch the full eval_input JSON.
"""
from __future__ import annotations

import datetime as dt
import json
import os
import re
from pathlib import Path
from typing import Any

SID_RE = re.compile(rb'"session_id"\s*:\s*"([^"]+)"')
TID_RE = re.compile(rb'"trace_id"\s*:\s*"([^"]+)"')
RT_RE = re.compile(rb'"request_time"\s*:\s*"([^"]+)"')
ITEM_RE = re.compile(rb'"item_id"\s*:\s*"([^"]+)"')
CASE_RE = re.compile(rb'"case_id"\s*:\s*"([^"]+)"')


def _read_span(path: Path, offset: int, length: int) -> dict[str, Any] | None:
    try:
        fd = os.open(path, os.O_RDONLY)
        try:
            raw = os.pread(fd, length, offset)
        finally:
            os.close(fd)
        return json.loads(raw)
    except (OSError, ValueError):
        return None


class InputOffsetIndex:
    """In-memory byte-offset index for a small set of eval_input JSONL files."""

    def __init__(self, files: list[Path]):
        self.files = [Path(f) for f in files if Path(f).is_file()]
        self.by_sid_rt: dict[tuple[str, str], tuple[Path, int, int]] = {}
        self.by_sid: dict[str, tuple[Path, int, int]] = {}
        self.by_tid: dict[str, tuple[Path, int, int]] = {}
        self.by_item: dict[str, tuple[Path, int, int]] = {}
        self.by_case: dict[str, tuple[Path, int, int]] = {}
        self._build()

    def _build(self):
        for path in self.files:
            pos = 0
            try:
                with open(path, "rb") as fh:
                    for raw in fh:
                        length = len(raw)
                        if not raw.endswith(b"\n"):
                            pos += length
                            break
                        span = (path, pos, length)
                        pos += length
                        # Fast byte scan on head + tail of line (top-level trace_id sits near the tail)
                        head = raw[:8192]
                        tail = raw[-4096:] if length > 8192 else b""
                        sample = head + b"\n" + tail

                        m_sid = SID_RE.search(sample)
                        m_rt = RT_RE.search(sample)
                        sid = m_sid.group(1).decode("utf-8", errors="ignore") if m_sid else ""
                        rt = m_rt.group(1).decode("utf-8", errors="ignore") if m_rt else ""
                        if sid and rt:
                            self.by_sid_rt[(sid, rt)] = span
                        if sid and sid not in self.by_sid:
                            self.by_sid[sid] = span

                        for m_tid in TID_RE.finditer(sample):
                            tid = m_tid.group(1).decode("utf-8", errors="ignore")
                            if tid and not tid.startswith("thread_"):
                                self.by_tid[tid] = span

                        m_item = ITEM_RE.search(head)
                        if m_item:
                            item = m_item.group(1).decode("utf-8", errors="ignore")
                            if item:
                                self.by_item[item] = span

                        m_case = CASE_RE.search(sample)
                        if m_case:
                            case = m_case.group(1).decode("utf-8", errors="ignore")
                            if case:
                                self.by_case[case] = span
            except OSError:
                continue

    def find_for_record(self, rec: dict[str, Any]) -> dict[str, Any] | None:
        sm = rec.get("session_meta") if isinstance(rec.get("session_meta"), dict) else {}
        tm_raw = rec.get("trace_meta")
        tm_list = tm_raw if isinstance(tm_raw, list) else ([tm_raw] if isinstance(tm_raw, dict) else [])

        # 1. Exact item_id (used in ab_test retest)
        item_id = str(sm.get("item_id") or "")
        if item_id and item_id in self.by_item:
            return _read_span(*self.by_item[item_id])

        # 2. Exact (session_id, request_time)
        sid = str(sm.get("session_id") or "")
        rt = str(sm.get("request_time") or "")
        if sid and rt and (sid, rt) in self.by_sid_rt:
            return _read_span(*self.by_sid_rt[(sid, rt)])

        # 3. Any real trace_id in turns / trace_meta / session_meta
        for t in rec.get("turns") or []:
            if not isinstance(t, dict):
                continue
            meta = t.get("meta") if isinstance(t.get("meta"), dict) else {}
            tid = str(meta.get("trace_id") or "")
            if tid and tid in self.by_tid:
                return _read_span(*self.by_tid[tid])
        for tm in tm_list:
            if isinstance(tm, dict):
                tid = str(tm.get("trace_id") or "")
                if tid and tid in self.by_tid:
                    return _read_span(*self.by_tid[tid])
        for cand in (sm.get("trace_id"), rec.get("trace_id")):
            tid = str(cand or "")
            if tid and tid in self.by_tid:
                return _read_span(*self.by_tid[tid])

        # 4. Fallback: case_id or session_id
        case_id = str(sm.get("case_id") or "")
        if case_id and case_id in self.by_case:
            return _read_span(*self.by_case[case_id])
        if sid and sid in self.by_sid:
            return _read_span(*self.by_sid[sid])
        return None


def daily_input_window(input_root: Path, model: str, date_str: str, pad_days: int = 2) -> list[Path]:
    """Return existing daily input files around ``date_str`` (handles cross-day attribution归档)."""
    model_dir = input_root / "0_daily_eval_input" / model
    if not model_dir.is_dir():
        return []
    files: list[Path] = []
    try:
        center = dt.date.fromisoformat(date_str)
    except ValueError:
        return []
    offsets = [0]
    for d in range(1, pad_days + 1):
        offsets.extend([-d, d])
    for off in offsets:
        cand = model_dir / f"{(center + dt.timedelta(days=off)).isoformat()}.jsonl"
        if cand.is_file():
            files.append(cand)
    return files
