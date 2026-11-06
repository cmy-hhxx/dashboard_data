"""Persistent, incremental index for build.py.

The dashboard rebuild used to re-read every input file for every build and then
seek randomly into multi-GB JSONL files once per sample.  On the production
ceph mount a random 0.5 MB read costs about as much as a network round trip, so
the same bytes were paid for several times per build.

This module keeps one row per file (byte offsets, join keys, trace ids, line
hashes and input-side aggregates) plus the pairing and sample caches in SQLite.
A build only scans files whose ``(size, mtime_ns)`` changed; appended files are
continued from the last committed newline.  The database lives under
``cache/build.sqlite3`` and is safe to delete to force a full rebuild.
"""
from __future__ import annotations

import copy
import hashlib
import json_compat as json
import os
import re
import sqlite3
import time
from array import array
from pathlib import Path

SCHEMA_VERSION = 1
# Bump when the detail / payload shape changes so cached samples are rebuilt.
BUILD_VERSION = "2026-11-06.1"

PRODUCT_MODELS = {
    "wencai": ("a_fast", "a_expert", "b_fast", "b_expert"),
    "aime": ("aime_fast", "aime_expert"),
}
ALL_MODELS = {m for models in PRODUCT_MODELS.values() for m in models}

DATE_RE = re.compile(r"(\d{4}-\d{2}-\d{2})")
RAW_SID = re.compile(rb'"session_id"\s*:\s*"([^"]*)"')
RAW_THREAD = re.compile(rb'"thread_id"\s*:\s*"([^"]*)"')
RAW_TRACE = re.compile(rb'"trace_id"\s*:\s*"([^"]*)"')
RAW_RT = re.compile(rb'"request_time"\s*:\s*"([^"]*)"')
# Output lines carry their SHA-256 (the sample slug) in the index; an invalid
# line gets this marker so pairing can skip it without re-reading the file.
NO_DIGEST = bytes(32)


# --------------------------------------------------------------------------- helpers

def line_hash(raw: bytes) -> int:
    """Stable 64-bit content hash for one JSONL line (no line terminator)."""
    return int.from_bytes(hashlib.blake2b(raw, digest_size=8).digest(), "little")


def prefix_hash(path: Path, size: int = 65536) -> str:
    with open(path, "rb", buffering=0) as fh:
        return hashlib.sha1(fh.read(size)).hexdigest()


def key_from_meta(meta: dict) -> str:
    sid = meta.get("session_id") or meta.get("thread_id") or meta.get("trace_id")
    rt = str(meta.get("request_time") or "").replace("T", " ")[:19]
    return f"{sid}\x1f{rt}" if sid else ""


def raw_key(raw: bytes) -> str:
    head = raw[:65536]
    match = RAW_SID.search(head) or RAW_THREAD.search(head) or RAW_TRACE.search(head)
    if not match:
        return ""
    clock = RAW_RT.search(head)
    rt = clock.group(1).decode("utf-8", "replace").replace("T", " ")[:19] if clock else ""
    return f"{match.group(1).decode('utf-8', 'replace')}\x1f{rt}"


def split_from_rel(rel: str) -> str:
    parts = rel.split("/")
    if "1_lost_user_input" in parts or "1_lost_user_eval" in parts:
        return "lost"
    return "daily"


def model_from_rel(rel: str) -> str:
    parts = rel.split("/")
    for part in parts:
        if part in ALL_MODELS:
            return part
    name = parts[-1].lower()
    if "expert" in name:
        return "aime_expert" if rel.startswith("1_aime/") else "a_expert"
    if "fast" in name:
        return "aime_fast" if rel.startswith("1_aime/") else "a_fast"
    return ""


def normalize_model(raw, product: str, default: str = "") -> str:
    if raw in ALL_MODELS:
        return raw
    text = str(raw or "").lower()
    prefix = "aime" if product == "aime" else "a"
    if "fast" in text:
        return f"{prefix}_fast"
    if "expert" in text or "thinking" in text or "atlas" in text:
        return f"{prefix}_expert"
    return default


def empty_stats() -> dict:
    return {"records": 0, "traces": 0, "tool_calls": 0, "tokens_in": 0,
            "tokens_out": 0, "cache_read": 0, "by_model": {}}


def empty_model() -> dict:
    return {"traces": 0, "tool_calls": 0, "tokens_in": 0, "tokens_out": 0,
            "cache_read": 0, "tasks": {}}


def merge_stats(dst: dict, src: dict | None) -> dict:
    if not src:
        return dst
    for key in ("records", "traces", "tool_calls", "tokens_in", "tokens_out", "cache_read"):
        dst[key] = int(dst.get(key, 0)) + int(src.get(key, 0))
    for model, ms in (src.get("by_model") or {}).items():
        dm = dst["by_model"].setdefault(model, empty_model())
        for key in ("traces", "tool_calls", "tokens_in", "tokens_out", "cache_read"):
            dm[key] = int(dm.get(key, 0)) + int(ms.get(key, 0))
        for task, ts in (ms.get("tasks") or {}).items():
            dt = dm["tasks"].setdefault(task, {"n": 0, "lost": 0, "sub": {}})
            dt["n"] += int(ts.get("n", 0))
            dt["lost"] += int(ts.get("lost", 0))
            for sub, ss in (ts.get("sub") or {}).items():
                ds = dt["sub"].setdefault(sub, {"n": 0, "lost": 0})
                ds["n"] += int(ss.get("n", 0))
                ds["lost"] += int(ss.get("lost", 0))
    return dst


def _aggregate_line(stats: dict, payload: dict, product: str, split: str, default_model: str) -> None:
    stats["records"] += 1
    meta = payload.get("meta") or {}
    traces = payload.get("traces") or [{"meta": meta, "messages": []}]
    stats["traces"] += len(traces)
    base_lost = split == "lost" or bool(meta.get("lost_user"))
    for trace in traces:
        if not isinstance(trace, dict):
            continue
        tm = trace.get("meta") or meta
        model = normalize_model(tm.get("model") or meta.get("model"), product, default_model)
        task = tm.get("task") or meta.get("task") or "未标注"
        sub = tm.get("subtask") or meta.get("subtask") or ""
        lost = int(base_lost or bool(tm.get("lost_user") or meta.get("lost_user")))
        usage = tm.get("usage") or meta.get("usage") or {}
        tools = int(tm.get("tool_count") or 0)
        tin = int(tm.get("input_tokens") or usage.get("input_tokens") or 0)
        tout = int(tm.get("output_tokens") or usage.get("output_tokens") or 0)
        cached = int(usage.get("cached_read_tokens") or tm.get("cached_read_tokens") or 0)
        stats["tool_calls"] += tools
        stats["tokens_in"] += tin
        stats["tokens_out"] += tout
        stats["cache_read"] += cached
        ms = stats["by_model"].setdefault(model or "未标注", empty_model())
        ms["traces"] += 1
        ms["tool_calls"] += tools
        ms["tokens_in"] += tin
        ms["tokens_out"] += tout
        ms["cache_read"] += cached
        ts = ms["tasks"].setdefault(task, {"n": 0, "lost": 0, "sub": {}})
        ts["n"] += 1
        ts["lost"] += lost
        if sub:
            ss = ts["sub"].setdefault(sub, {"n": 0, "lost": 0})
            ss["n"] += 1
            ss["lost"] += lost


def scan_file(root: Path | str, rel: str, kind: str = "input", prev: dict | None = None,
              need_stats: bool = True, product: str = "", split: str | None = None,
              default_model: str = "") -> dict:
    """Scan one JSONL file, extending ``prev`` when the file only grew.

    ``prev`` must be the dict returned by an earlier call.  Only complete lines
    are committed: a writer appending the last line does not make the next
    build miss it, and a truncated/re-written file falls back to a full scan.
    """
    root = Path(root)
    path = root / rel
    st = path.stat()
    split = split or split_from_rel(rel)
    if prev and st.st_size == prev.get("size") and st.st_mtime_ns == prev.get("mtime_ns"):
        return prev
    ph = prefix_hash(path)
    output = kind != "input"
    tail = bool(prev and prev.get("ends_nl") and st.st_size > int(prev.get("committed") or 0)
                and ph == prev.get("prefix")
                # Rows indexed before digests existed are rescanned once to backfill them.
                and (not output or len(prev.get("digests") or b"") == 32 * int(prev.get("lines") or 0)))
    if tail:
        offsets = array("q", prev.get("offsets") or [0])
        keys = list(prev.get("keys") or [])
        tids = list(prev.get("tids") or [])
        hashes = array("Q", prev.get("hashes") or [])
        digests = bytearray(prev.get("digests") or b"")
        stats = copy.deepcopy(prev.get("stats") or empty_stats())
        start = int(prev.get("committed") or 0)
    else:
        offsets, keys, tids, hashes, digests = array("q", [0]), [], [], array("Q"), bytearray()
        stats = empty_stats()
        start = 0

    pos = start
    ends_nl = True
    with open(path, "rb", buffering=8 << 20) as fh:
        if start:
            fh.seek(start)
        for raw in fh:
            end = pos + len(raw)
            if not raw.endswith(b"\n"):
                ends_nl = False
                break
            pos = end
            body = raw[:-1]
            if body.endswith(b"\r"):
                body = body[:-1]
            offsets.append(pos)

            payload = None
            if body.strip():
                try:
                    payload = json.loads(body)
                except ValueError:
                    payload = None
            if isinstance(payload, dict):
                if kind == "input":
                    meta = dict(payload.get("meta") or {})
                    if not meta.get("session_id") and payload.get("traces"):
                        meta["session_id"] = (payload["traces"][0].get("meta") or {}).get("session_id")
                    meta.setdefault("request_time", payload.get("request_time"))
                    key = key_from_meta(meta)
                else:
                    key = key_from_meta(payload.get("session_meta") or {})
                if kind == "input":
                    ids = [(t.get("meta") or {}).get("trace_id")
                           for t in payload.get("traces") or [] if isinstance(t, dict)]
                    if not any(ids):
                        ids = [payload.get("trace_id") or (payload.get("meta") or {}).get("trace_id")]
                else:
                    # Attribution turns: pairing picks the input snapshot covering them.
                    ids = [(t.get("meta") or {}).get("trace_id")
                           for t in payload.get("turns") or [] if isinstance(t, dict)]
                tids.append([str(x) for x in ids if x])
                keys.append(key or raw_key(body))
                if need_stats and kind == "input":
                    _aggregate_line(stats, payload, product, split, default_model)
                if output:
                    digests += hashlib.sha256(body).digest()
            else:
                # A truncated / invalid JSONL line must never enter the pairing
                # index: it would later crash the sample builder with a JSON error.
                keys.append("")
                tids.append([])
                if output:
                    digests += NO_DIGEST
            hashes.append(line_hash(body))

    return {
        "path": rel, "size": st.st_size, "mtime_ns": st.st_mtime_ns, "prefix": ph,
        "lines": len(offsets) - 1, "committed": pos, "ends_nl": ends_nl,
        "offsets": offsets, "keys": keys, "tids": tids, "hashes": hashes,
        "digests": bytes(digests) if output else None,
        "stats": stats, "scanned_at": time.time(), "model": default_model, "split": split,
    }


def scan_task(args: tuple) -> dict:
    return scan_file(*args)


# --------------------------------------------------------------------------- store

class BuildStore:
    """SQLite-backed cache; one connection, WAL, no external dependencies."""

    def __init__(self, path: Path | str, readonly: bool = False):
        path = Path(path)
        self.path = path
        self.readonly = readonly
        if readonly:
            # Sample workers only read file indexes, pair payloads and samples.  The
            # server's detail builder shares one connection across request threads
            # behind its own lock, so the per-thread check would only get in the way.
            self.db = sqlite3.connect(f"file:{path.resolve()}?mode=ro", uri=True, timeout=30,
                                      check_same_thread=False)
            self.db.execute("PRAGMA query_only=ON")
            self.db.execute("PRAGMA temp_store=MEMORY")
            return
        path.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(str(path), timeout=30)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA synchronous=NORMAL")
        self.db.execute("PRAGMA temp_store=MEMORY")
        self.db.execute("PRAGMA cache_size=-64000")
        self._init()

    def _init(self) -> None:
        self.db.executescript("""
        CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS files (
            path TEXT PRIMARY KEY, size INTEGER NOT NULL, mtime_ns INTEGER NOT NULL,
            prefix TEXT NOT NULL, lines INTEGER NOT NULL, committed INTEGER NOT NULL,
            ends_nl INTEGER NOT NULL, offsets BLOB NOT NULL, keys TEXT NOT NULL,
            tids TEXT NOT NULL, hashes BLOB NOT NULL, stats TEXT NOT NULL,
            product TEXT NOT NULL DEFAULT '', model TEXT NOT NULL DEFAULT '',
            split TEXT NOT NULL DEFAULT '', scanned_at REAL NOT NULL
        );
        CREATE TABLE IF NOT EXISTS pairs (
            output TEXT PRIMARY KEY, sig TEXT NOT NULL, payload TEXT NOT NULL, updated_at REAL NOT NULL
        );
        CREATE TABLE IF NOT EXISTS samples (
            slug TEXT PRIMARY KEY, fp TEXT NOT NULL, oh TEXT NOT NULL,
            ih TEXT, ch TEXT, product TEXT NOT NULL, model TEXT NOT NULL,
            date TEXT NOT NULL, split TEXT NOT NULL, output TEXT NOT NULL,
            output_line INTEGER NOT NULL, refs TEXT, row TEXT NOT NULL, facts TEXT NOT NULL,
            brief TEXT NOT NULL, golden TEXT, built_at REAL NOT NULL
        );
        CREATE INDEX IF NOT EXISTS samples_product ON samples(product);
        """)
        columns = {row[1] for row in self.db.execute("PRAGMA table_info(samples)")}
        if "refs" not in columns:
            self.db.execute("ALTER TABLE samples ADD COLUMN refs TEXT")
        columns = {row[1] for row in self.db.execute("PRAGMA table_info(files)")}
        if "digests" not in columns:
            self.db.execute("ALTER TABLE files ADD COLUMN digests BLOB")
        row = self.db.execute("SELECT value FROM meta WHERE key='schema'").fetchone()
        if row and int(row[0]) != SCHEMA_VERSION:
            # A format change invalidates byte offsets and cached payloads.
            self.db.executescript(
                "DELETE FROM files; DELETE FROM pairs; DELETE FROM samples; "
                "DELETE FROM meta WHERE key='complete';")
        self.db.execute("INSERT OR REPLACE INTO meta(key,value) VALUES('schema',?)", (str(SCHEMA_VERSION),))
        self.db.commit()

    # ---- meta

    def get_meta(self, key: str, default=None):
        row = self.db.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
        if not row:
            return default
        try:
            return json.loads(row[0])
        except ValueError:
            return row[0]

    def set_meta(self, key: str, value) -> None:
        self.db.execute("INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)", (key, json.dumps(value)))
        self.db.commit()

    # ---- files

    def file_meta(self, rel: str) -> dict | None:
        row = self.db.execute(
            "SELECT path,size,mtime_ns,prefix,lines,committed,ends_nl,stats,product,model,split "
            "FROM files WHERE path=?", (rel,)).fetchone()
        if not row:
            return None
        return {"path": row[0], "size": row[1], "mtime_ns": row[2], "prefix": row[3],
                "lines": row[4], "committed": row[5], "ends_nl": bool(row[6]),
                "stats": json.loads(row[7]), "product": row[8], "model": row[9], "split": row[10]}

    def get_file(self, rel: str) -> dict | None:
        row = self.db.execute(
            "SELECT path,size,mtime_ns,prefix,lines,committed,ends_nl,offsets,keys,tids,hashes,"
            "stats,product,model,split,digests FROM files WHERE path=?", (rel,)).fetchone()
        if not row:
            return None
        return {
            "path": row[0], "size": row[1], "mtime_ns": row[2], "prefix": row[3],
            "lines": row[4], "committed": row[5], "ends_nl": bool(row[6]),
            "offsets": list(array("q", row[7])), "keys": json.loads(row[8]),
            "tids": json.loads(row[9]), "hashes": list(array("Q", row[10])),
            "stats": json.loads(row[11]), "product": row[12], "model": row[13], "split": row[14],
            "digests": row[15],
        }

    def put_file(self, data: dict) -> None:
        self.db.execute(
            "INSERT OR REPLACE INTO files(path,size,mtime_ns,prefix,lines,committed,ends_nl,"
            "offsets,keys,tids,hashes,stats,product,model,split,scanned_at,digests) "
            "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                data["path"], data["size"], data["mtime_ns"], data["prefix"], data["lines"],
                data["committed"], int(bool(data["ends_nl"])),
                array("q", data["offsets"]).tobytes(),
                json.dumps(data["keys"], ensure_ascii=False),
                json.dumps(data["tids"], ensure_ascii=False),
                array("Q", data["hashes"]).tobytes(),
                json.dumps(data["stats"], ensure_ascii=False),
                data.get("product", ""), data.get("model", ""), data.get("split", ""),
                data.get("scanned_at", time.time()), data.get("digests"),
            ),
        )

    def line_span(self, rel: str, number: int) -> tuple[int, int] | None:
        """Byte range of one 1-based line, read from the offsets blob only.

        ``get_file`` decodes every offset, key and trace id of the file; a detail
        request needs two of those integers.  ``None`` = file not indexed.
        """
        row = self.db.execute(
            "SELECT substr(offsets, ?, 16), lines FROM files WHERE path=?",
            ((number - 1) * 8 + 1, rel)).fetchone()
        if not row:
            return None
        if not 1 <= number <= row[1] or len(row[0]) != 16:
            raise IndexError(f"{rel}: line {number} outside the {row[1]} indexed lines")
        start, end = array("q", row[0])
        return start, end

    def has_file_stat(self, rel: str, st: os.stat_result) -> bool:
        row = self.db.execute("SELECT size,mtime_ns FROM files WHERE path=?", (rel,)).fetchone()
        return bool(row and row[0] == st.st_size and row[1] == st.st_mtime_ns)

    # ---- pairs

    def get_pairs(self, output: str) -> tuple[str, list] | None:
        row = self.db.execute("SELECT sig,payload FROM pairs WHERE output=?", (output,)).fetchone()
        return (row[0], json.loads(row[1])) if row else None

    def put_pairs(self, output: str, sig: str, payload: list) -> None:
        self.db.execute(
            "INSERT OR REPLACE INTO pairs(output,sig,payload,updated_at) VALUES(?,?,?,?)",
            (output, sig, json.dumps(payload, ensure_ascii=False), time.time()),
        )

    # ---- samples

    def set_current_slugs(self, slugs):
        self.db.execute("CREATE TEMP TABLE IF NOT EXISTS current_slugs(slug TEXT PRIMARY KEY)")
        self.db.execute("DELETE FROM current_slugs")
        self.db.executemany("INSERT OR IGNORE INTO current_slugs(slug) VALUES(?)",
                            ((slug,) for slug in slugs if slug))

    def sample_meta(self, slugs):
        """Light columns for cache validation without parsing the 16k briefs."""
        if not slugs:
            return {}
        self.set_current_slugs(slugs)
        rows = self.db.execute(
            "SELECT s.slug,s.fp,s.oh,s.ih,s.ch,s.refs,s.product,s.model,s.date,s.split,"
            "s.output,s.output_line FROM samples s JOIN current_slugs c ON c.slug=s.slug"
        ).fetchall()
        return {
            row[0]: {
                "slug": row[0], "fp": row[1], "oh": row[2], "ih": row[3], "ch": row[4],
                "refs": json.loads(row[5]) if row[5] else None, "product": row[6],
                "model": row[7], "date": row[8], "split": row[9],
                "output": row[10], "output_line": row[11],
            }
            for row in rows
        }

    def load_samples(self, slugs) -> dict:
        """Load only rows still referenced by this build, keyed by slug."""
        self.set_current_slugs(slugs)
        rows = self.db.execute(
            "SELECT s.slug,s.fp,s.oh,s.ih,s.ch,s.product,s.model,s.date,s.split,s.refs,"
            "s.row,s.facts,s.brief,s.golden FROM samples s JOIN current_slugs c ON c.slug=s.slug").fetchall()
        out = {}
        for slug, fp, oh, ih, ch, product, model, date, split, refs, row, facts, brief, golden in rows:
            out[slug] = {
                "slug": slug, "fp": fp, "oh": oh, "ih": ih, "ch": ch, "product": product,
                "model": model, "date": date, "split": split,
                "refs": json.loads(refs) if refs else None,
                "row": json.loads(row), "facts": json.loads(facts), "brief": json.loads(brief),
                "golden": json.loads(golden) if golden else None,
            }
        return out

    def put_sample(self, data: dict) -> None:
        self.db.execute(
            "INSERT OR REPLACE INTO samples(slug,fp,oh,ih,ch,product,model,date,split,output,"
            "output_line,refs,row,facts,brief,golden,built_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                data["slug"], data["fp"], data["oh"], data.get("ih"), data.get("ch"),
                data["product"], data["model"], data["date"], data["split"], data["output"],
                data["output_line"], json.dumps(data.get("refs"), ensure_ascii=False) if data.get("refs") else None,
                json.dumps(data["row"], ensure_ascii=False),
                json.dumps(data["facts"], ensure_ascii=False),
                json.dumps(data["brief"], ensure_ascii=False),
                json.dumps(data["golden"], ensure_ascii=False) if data.get("golden") else None,
                time.time(),
            ),
        )

    def sample_row(self, slug: str):
        cur = self.db.execute(
            "SELECT slug,fp,oh,ih,ch,product,model,date,split,output,output_line,refs "
            "FROM samples WHERE slug=?", (slug,))
        try:
            return cur.fetchone()
        finally:
            cur.close()

    def delete_samples_not(self, slugs) -> int:
        self.db.execute("CREATE TEMP TABLE IF NOT EXISTS keep_slugs(slug TEXT PRIMARY KEY)")
        self.db.execute("DELETE FROM keep_slugs")
        self.db.executemany("INSERT OR IGNORE INTO keep_slugs(slug) VALUES(?)", ((s,) for s in slugs))
        cur = self.db.execute("DELETE FROM samples WHERE slug NOT IN (SELECT slug FROM keep_slugs)")
        return cur.rowcount

    def commit(self) -> None:
        if not self.readonly:
            self.db.commit()

    def close(self) -> None:
        self.commit()
        self.db.close()
