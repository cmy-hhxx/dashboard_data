"""只读人话译文读取层（面向 5003 供数接口，零第三方依赖）。

读取 ``<datasets>/<product_dir>/eval_output/human_read/.state/state.sqlite3``（WAL 只读模式）
并按字节偏移 ``os.pread`` 对应镜像 JSONL 的翻译行。

当数据目录不含 ``human_read``（如问财或尚未初始化）或单条记录尚未译完时，
所有查询均平滑返回 ``None``，由调用方安全回退至原文。
"""

from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import threading
from pathlib import Path
from typing import Any

TEXT_MODES = ("raw", "human")

# 与 human_read_module.config.ATTR_PROBLEM_FIELDS 严格一致
ATTR_PROBLEM_FIELDS = (
    "label",
    "problem_phenomena",
    "reason",
    "severity_reason",
)


def attr_fingerprint(attr: dict[str, Any]) -> str:
    """与 human_read_module.translator.attribution_text_fingerprint 逐字节一致。"""
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


def turn_hr_fingerprint(
    hr_record: dict[str, Any],
    hr_turn: dict[str, Any],
    include_session: bool = False,
) -> str:
    """单轮 trace 对应的人话文本指纹：译文任一展示字段更新即变化，驱动 /changes 补发。"""
    payload = {
        "session_summary": session_summary_text(hr_record) or "",
        "summary": (hr_turn.get("summary") or "").strip(),
        "problem": [
            {k: (p.get(k) or "").strip() for k in ATTR_PROBLEM_FIELDS}
            for p in (hr_turn.get("problem") or [])
        ],
        "session_problem": [
            {k: (p.get(k) or "").strip() for k in ATTR_PROBLEM_FIELDS}
            for p in (hr_record.get("session_problem") or [])
        ]
        if include_session
        else [],
    }
    raw = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()[:16]


def record_key(rec: dict[str, Any]) -> str:
    """与 human_read_module.store.record_key_for_record(rec, 'attribution') 严格一致。"""
    sm = rec.get("session_meta") if isinstance(rec.get("session_meta"), dict) else {}
    tm_raw = rec.get("trace_meta")
    tm_list = tm_raw if isinstance(tm_raw, list) else ([tm_raw] if isinstance(tm_raw, dict) else [])
    tids: list[str] = []
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
    return f"fp:{attr_fingerprint(rec)}"


def rel_path_for(file_path: str | Path | None) -> str | None:
    """把归因文件绝对/相对路径转为 human_read/ 下的相对路径（去掉 .../eval_output/ 前缀）。"""
    if not file_path:
        return None
    s = str(file_path).replace("\\", "/")
    marker = "/eval_output/"
    idx = s.find(marker)
    if idx >= 0:
        rel = s[idx + len(marker) :]
        if rel.startswith("human_read/"):
            return None
        return rel or None
    return None


def product_dir_for(file_path: str | Path | None) -> Path | None:
    """从归因文件路径反推产品目录（.../eval_output/ 的父目录）。"""
    if not file_path:
        return None
    s = str(file_path).replace("\\", "/")
    marker = "/eval_output/"
    idx = s.find(marker)
    if idx > 0:
        return Path(s[:idx])
    return None


def session_summary_text(record: dict[str, Any] | None) -> str | None:
    """兼容字符串和历史 {"summary": "..."} 字典两种 session_summary 形态。"""
    if not isinstance(record, dict):
        return None
    raw = record.get("session_summary")
    if isinstance(raw, str):
        return raw.strip() or None
    if isinstance(raw, dict):
        inner = raw.get("summary")
        if isinstance(inner, str):
            return inner.strip() or None
    return None


def match_turn(
    orig_record: dict[str, Any],
    hr_record: dict[str, Any] | None,
    turn_index: int,
) -> tuple[dict[str, Any], list[dict[str, Any]], list[dict[str, Any]]] | None:
    """校验结构对齐并返回 (hr_turn, hr_turn_problems, hr_session_problems)；不对齐返回 None。"""
    if not isinstance(hr_record, dict):
        return None
    orig_turns = orig_record.get("turns") or []
    hr_turns = hr_record.get("turns") or []
    if len(orig_turns) != len(hr_turns) or not (0 <= turn_index < len(hr_turns)):
        return None
    orig_turn = orig_turns[turn_index]
    hr_turn = hr_turns[turn_index]
    if not isinstance(orig_turn, dict) or not isinstance(hr_turn, dict):
        return None
    orig_probs = orig_turn.get("problem") or []
    hr_probs = hr_turn.get("problem") or []
    if len(orig_probs) != len(hr_probs):
        return None
    orig_sprobs = orig_record.get("session_problem") or []
    hr_sprobs = hr_record.get("session_problem") or []
    is_last = turn_index == len(orig_turns) - 1
    if is_last and len(orig_sprobs) != len(hr_sprobs):
        return None
    return hr_turn, list(hr_probs), (list(hr_sprobs) if is_last else [])


def _pread_json(fd: int, offset: int, length: int) -> dict[str, Any] | None:
    if offset < 0 or length <= 0:
        return None
    try:
        raw = os.pread(fd, length, offset)
        parsed = json.loads(raw)
        return parsed if isinstance(parsed, dict) else None
    except (OSError, ValueError):
        return None


def _key_base(rkey: str) -> str:
    """去掉 |request_time 后缀的主键前缀（如 tid:...），允许时间戳回填漂移但绝不跨 trace 误匹配。"""
    return rkey.split("|", 1)[0] if "|" in rkey else rkey


class FileIndex:
    """单个归因文件在构建期的一次性只读索引（1 次 SQL + 1 个文件句柄，避免 N 次查询）。"""

    def __init__(
        self,
        target: Path,
        by_pair: dict[tuple[str, str], tuple[int, int]],
        by_base: dict[tuple[str, str], tuple[int, int]],
    ):
        self._target = target
        self._by_pair = by_pair
        self._by_base = by_base
        self._fd: int | None = None

    def __enter__(self) -> "FileIndex":
        if self._by_pair or self._by_base:
            try:
                self._fd = os.open(self._target, os.O_RDONLY)
            except OSError:
                self._fd = None
        return self

    def __exit__(self, *_exc) -> None:
        if self._fd is not None:
            try:
                os.close(self._fd)
            except OSError:
                pass
            self._fd = None

    def __bool__(self) -> bool:
        return self._fd is not None

    def lookup(self, orig_record: dict[str, Any]) -> dict[str, Any] | None:
        if self._fd is None:
            return None
        rkey = record_key(orig_record)
        shash = attr_fingerprint(orig_record)
        loc = self._by_pair.get((rkey, shash))
        if loc is None:
            loc = self._by_base.get((_key_base(rkey), shash))
        if loc is None:
            return None
        return _pread_json(self._fd, loc[0], loc[1])


class HumanReadReader:
    """线程安全的只读人话镜像访问器。"""

    def __init__(self, product_dir: Path | str):
        self.root = Path(product_dir) / "eval_output" / "human_read"
        self.db_path = self.root / ".state" / "state.sqlite3"
        self._local = threading.local()

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

    def _close_local(self) -> None:
        conn = getattr(self._local, "conn", None)
        if conn is not None:
            try:
                conn.close()
            except Exception:  # noqa: BLE001
                pass
        self._local.conn = None
        self._local.ino = None

    def close(self) -> None:
        """关闭当前线程缓存的只读连接。"""
        self._close_local()

    def file_sig(self, rel_path: str | None) -> str:
        """该归因文件在 human_read 中的聚合指纹；无译文时返回空串（不触发重扫）。"""
        if not rel_path:
            return ""
        conn = self._conn()
        if conn is None:
            return ""
        try:
            row = conn.execute(
                "SELECT COUNT(*), COALESCE(MAX(updated_at_ns), 0), COALESCE(SUM(out_offset + out_bytes), 0) "
                "FROM records WHERE rel_path = ? AND status = 'ok'",
                (rel_path,),
            ).fetchone()
        except sqlite3.Error:
            return ""
        if not row or not row[0]:
            return ""
        return f"hr:{row[0]}:{row[1]}:{row[2]}"

    def open_file(self, rel_path: str | None) -> FileIndex:
        """批量加载某个归因文件对应的全部已译偏移，供 store.build 逐行查表。"""
        if not rel_path:
            return FileIndex(self.root, {}, {})
        conn = self._conn()
        if conn is None:
            return FileIndex(self.root / rel_path, {}, {})
        by_pair: dict[tuple[str, str], tuple[int, int]] = {}
        by_base: dict[tuple[str, str], tuple[int, int]] = {}
        try:
            rows = conn.execute(
                "SELECT record_key, source_hash, out_offset, out_bytes FROM records "
                "WHERE rel_path = ? AND status = 'ok' ORDER BY updated_at_ns ASC",
                (rel_path,),
            ).fetchall()
        except sqlite3.Error:
            rows = []
        for rkey, shash, off, sz in rows:
            if off is not None and sz is not None and off >= 0 and sz > 0 and shash and rkey:
                loc = (int(off), int(sz))
                by_pair[(rkey, shash)] = loc
                by_base[(_key_base(rkey), shash)] = loc
        return FileIndex(self.root / rel_path, by_pair, by_base)

    def lookup(self, file_path: str | Path | None, orig_record: dict[str, Any] | None) -> dict[str, Any] | None:
        """单条 O(1) 实时查询（供 GET /traces/{id} 使用）；校验 source_hash 与主键前缀防误叠。"""
        rel_path = rel_path_for(file_path)
        if not rel_path or not isinstance(orig_record, dict):
            return None
        conn = self._conn()
        if conn is None:
            return None
        rkey = record_key(orig_record)
        kbase = _key_base(rkey)
        shash = attr_fingerprint(orig_record)
        try:
            row = conn.execute(
                "SELECT out_offset, out_bytes FROM records "
                "WHERE rel_path = ? AND status = 'ok' AND source_hash = ? "
                "AND (record_key = ? OR record_key = ? OR record_key LIKE ?) "
                "ORDER BY (record_key = ?) DESC, updated_at_ns DESC LIMIT 1",
                (rel_path, shash, rkey, kbase, kbase + "|%", rkey),
            ).fetchone()
        except sqlite3.Error:
            return None
        if not row:
            return None
        target = self.root / rel_path
        try:
            fd = os.open(target, os.O_RDONLY)
        except OSError:
            return None
        try:
            return _pread_json(fd, int(row[0]), int(row[1]))
        finally:
            try:
                os.close(fd)
            except OSError:
                pass

    def stats(self) -> dict[str, Any]:
        """返回人话镜像库概览，供 /healthz 展示。"""
        conn = self._conn()
        if conn is None:
            return {"available": False, "records": 0, "updated_at": None}
        try:
            row = conn.execute(
                "SELECT COUNT(*), MAX(updated_at) FROM records WHERE kind = 'attribution' AND status = 'ok'"
            ).fetchone()
            return {
                "available": True,
                "records": int(row[0] or 0) if row else 0,
                "updated_at": row[1] if row else None,
            }
        except sqlite3.Error:
            return {"available": False, "records": 0, "updated_at": None}


_READERS_LOCK = threading.Lock()
_READERS: dict[str, HumanReadReader] = {}


def reader_for(product_dir: Path | str) -> HumanReadReader:
    """按产品目录复用的只读访问器实例。"""
    key = str(Path(product_dir))
    with _READERS_LOCK:
        reader = _READERS.get(key)
        if reader is None:
            reader = HumanReadReader(key)
            _READERS[key] = reader
        return reader
