"""Lazy sample details for the after-release retest (GET /ab_samples/<roundId>/<eq>.json).

The retest samples are not in the main samples index: they are the fixed question set re-run
after the release and their sources live inside the round::

    03_after_release_retest/attribution/<model>/<batch>/<model>_attribution-<batch>.jsonl
    99_provenance/retest_eval_run/compact/<model>_compact-<batch>.jsonl
    99_provenance/retest_input/<batch>.slim.jsonl

The three are joined by ``meta.item_id`` (``case_id`` fallback).  Only a question that has an
attribution row and an input row can be rendered; compact is optional.  The input file is
GB-sized, so the first request builds a (size, mtime) checked line-offset index cached at
``cache/ab-details/<roundId>.json`` and later reads use ``pread`` instead of loading the file.

The attribution problems get their cluster leaf backfilled from the retest cluster
``item_index.slice.jsonl``: its rows are keyed by ``(target trace, json_path)``, which maps one
problem exactly even when several labels share a leaf.  The coverage CSV's
``cls_paths``/``cls_labels`` are path-deduplicated, so they only feed the pairs' after-side
counts.  A problem with no item_index row keeps ``cl = None`` rather than guessing.
"""
from __future__ import annotations

import hashlib
import json_compat as json
import os
import re
import threading
import time
from collections import Counter
from pathlib import Path

import ab_test
import build

INDEX_VERSION = 2

ATTRIBUTION_DIR = ab_test.SCOPE_AFTER + "/attribution"
ITEM_INDEX_DIR = ab_test.SCOPE_AFTER + "/cluster_tree"
COMPACT_DIR = "99_provenance/retest_eval_run/compact"
INPUT_DIR = "99_provenance/retest_input"

ROUND_ID_RE = re.compile(r"^[0-9A-Za-z][0-9A-Za-z._-]*$")
EQ_RE = re.compile(r"_eq_(\d+)$")
ITEM_RE = re.compile(rb'"item_id"\s*:\s*"([^"]+)"')
CASE_RE = re.compile(rb'"case_id"\s*:\s*"([^"]+)"')
DATE_RE = re.compile(r"(\d{4}-\d{2}-\d{2})")


def _slim_meta_ids(raw):
    """``(item_id, case_id)`` from a slim input line, without decoding its transcript.

    The line is ``{"meta": {...}, "traces": [...]}`` and can be hundreds of KB; the meta
    object is small but not guaranteed to be in a fixed prefix (real rows put item_id past
    32 KB when the question/context fields are long).  The transcript is never touched:
    only the leading meta object is parsed, so no prefix limit is needed.
    """
    # Parse the value of the top-level "meta" key (the first value on the line); the outer
    # object is not closed yet at that point, so start at the meta object's own ``{``.
    key = raw.find(b'"meta"')
    start = raw.find(b"{", key + 1) if key >= 0 else -1
    if start >= 0:
        pos = start
        while True:
            anchor = raw.find(b'"traces"', pos)
            if anchor < 0:
                break
            end = raw.rfind(b"}", start, anchor)
            if end > start:
                try:
                    meta = json.loads(raw[start:end + 1])
                except ValueError:
                    meta = None
                if isinstance(meta, dict):
                    return str(meta.get("item_id") or ""), str(meta.get("case_id") or "")
            pos = anchor + 1
    # Unknown key order: fall back to the first occurrence anywhere on the line.
    item = ITEM_RE.search(raw)
    case = CASE_RE.search(raw)
    return (item.group(1).decode() if item else "",
            case.group(1).decode() if case else "")


def _model_from_path(path: Path, base: Path) -> str:
    try:
        parts = path.relative_to(base).parts
    except ValueError:
        return ""
    if not parts:
        return ""
    tail = parts[0].rsplit("_", 1)[-1]
    return tail if tail in ("fast", "expert") else parts[0]


def _retest_date(inp, smeta) -> str:
    meta = (inp or {}).get("meta") or {}
    for value in (meta.get("request_time"), smeta.get("request_time")):
        match = DATE_RE.match(str(value or ""))
        if match:
            return match.group(1)
    return ""


def _retest_date_from(value) -> str:
    match = DATE_RE.match(str(value or ""))
    return match.group(1) if match else ""


def _fill_clusters(detail, trace, index, fallback_trace=""):
    """Backfill attribution problems from the retest cluster item index.

    The authoritative key is ``(target trace, json_path)``: each item_index row is one
    attribution problem (``turns[ti].problem[pi]`` or ``session_problem[pi]``) and carries its
    leaf.  The coverage CSV's ``cls_paths``/``cls_labels`` are path-deduplicated and not
    parallel, so they are only used for the pairs' after-side counts, never for this mapping.
    A problem with no matching item stays ``cl = None`` (unclustered on the page).

    Returns ``(matched, total, first_hit)`` for logging/optional detail fields.
    """
    problems = (detail.get("attribution") or {}).get("problems") or []
    lookup = index.get("problems") or {}
    attr = detail.get("attribution") or {}
    matched = 0
    first_hit = None

    def apply(problem_id, key):
        nonlocal matched, first_hit
        for ident in (trace, fallback_trace):
            if not ident:
                continue
            hit = lookup.get(f"{ident}\x1f{key}")
            if hit and hit.get("path"):
                problem = problems[problem_id]
                problem["cl"] = {"path": hit["path"], "edge": bool(hit.get("edge")),
                                 "tags": []}
                matched += 1
                if first_hit is None:
                    first_hit = hit
                return

    for ti, turn in enumerate(attr.get("turns") or []):
        for pi, problem_id in enumerate(turn.get("problems") or []):
            apply(problem_id, f"turns[{ti}].problem[{pi}]")
    for pi, problem_id in enumerate(attr.get("session_problems") or []):
        apply(problem_id, f"session_problem[{pi}]")
    return matched, len(problems), first_hit


class ABDetailBuilder:
    def __init__(self, datasets: Path | str, cache_dir: Path | str, sample_dir: Path | str):
        self.datasets = Path(datasets)
        self.cache_dir = Path(cache_dir)
        self.sample_dir = Path(sample_dir)
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self.sample_dir.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._indexes = {}
        self._rounds = {}

    # ---- discovery -------------------------------------------------------------------------

    def _round(self, round_id: str):
        """``(product, round_dir)`` for a scope-layout round, or ``None``.

        The URL only carries the round directory name, so both products are searched; the name
        is regex-checked first and only an actual directory is ever returned (no traversal).
        """
        if not ROUND_ID_RE.match(round_id or ""):
            return None
        cached = self._rounds.get(round_id)
        if cached:
            return cached
        for product in sorted(build.ENABLED):
            for _order, _version, round_dir in ab_test.ab_round_dirs(self.datasets, product):
                if round_dir.name == round_id and ab_test.is_scope_layout(round_dir):
                    found = (product, round_dir)
                    self._rounds[round_id] = found
                    return found
        return None

    @staticmethod
    def _source_files(round_dir: Path):
        attr_base = round_dir / ATTRIBUTION_DIR
        attr = sorted(p for p in attr_base.rglob("*.jsonl") if p.is_file()) if attr_base.is_dir() else []
        tree_base = round_dir / ITEM_INDEX_DIR
        items = (sorted(p for p in tree_base.glob("*/item_index.slice.jsonl") if p.is_file())
                 if tree_base.is_dir() else [])
        comp_base = round_dir / COMPACT_DIR
        comp = sorted(p for p in comp_base.glob("*.jsonl") if p.is_file()) if comp_base.is_dir() else []
        input_base = round_dir / INPUT_DIR
        inp = sorted(p for p in input_base.glob("*.slim.jsonl") if p.is_file()) if input_base.is_dir() else []
        return attr, items, comp, inp

    # ---- index -----------------------------------------------------------------------------

    @staticmethod
    def _stat(path: Path, round_dir: Path):
        st = path.stat()
        return [path.relative_to(round_dir).as_posix(), st.st_size, st.st_mtime_ns]

    @staticmethod
    def _signature(stats) -> str:
        return hashlib.sha1(json.dumps({"version": INDEX_VERSION, "stats": stats},
                                       separators=(",", ":")).encode()).hexdigest()

    def _index(self, round_id: str, round_dir: Path):
        attr, items, comp, inp = self._source_files(round_dir)
        coverage = ab_test.scope_coverage_path(round_dir, "after")
        stats = [self._stat(path, round_dir) for path in (*attr, *items, *comp, *inp)]
        if coverage and coverage.is_file():
            stats.append(self._stat(coverage, round_dir))
        sig = self._signature(stats)
        cached = self._indexes.get(round_id)
        if cached and cached.get("sig") == sig:
            return cached
        path = self.cache_dir / "ab-details" / f"{round_id}.json"
        try:
            index = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            index = None
        if not index or index.get("version") != INDEX_VERSION or index.get("sig") != sig:
            index = self._build_index(round_dir, attr, items, comp, inp, coverage, sig)
            self._save_index(path, index)
        self._indexes[round_id] = index
        return index

    def _build_index(self, round_dir: Path, attr, items, comp, inp, coverage, sig):
        sources = []
        attribution = {}
        problems = {}
        problem_dupes = 0
        compact_by_item, compact_by_case = {}, {}
        input_by_item, input_by_case = {}, {}

        def add_source(kind: str, path: Path):
            st = path.stat()
            sources.append({
                "kind": kind, "rel": path.relative_to(round_dir).as_posix(),
                "size": st.st_size, "mtime_ns": st.st_mtime_ns, "offsets": [],
            })
            return len(sources) - 1, sources[-1]

        for path in attr:
            file_idx, entry = add_source("attribution", path)
            model = _model_from_path(path, round_dir / ATTRIBUTION_DIR)
            pos = 0
            with open(path, "rb") as fh:
                for line_no, raw in enumerate(fh):
                    entry["offsets"].append(pos)
                    pos += len(raw)
                    try:
                        row = json.loads(raw)
                    except ValueError:
                        continue
                    smeta = row.get("session_meta") or {}
                    case = str(smeta.get("case_id") or "")
                    match = EQ_RE.search(case)
                    if not match:
                        continue
                    attribution[str(int(match.group(1)))] = {
                        "file": file_idx, "line": line_no, "model": model,
                        "item_id": str(smeta.get("item_id") or ""),
                    }

        for path in items:
            file_idx, entry = add_source("item_index", path)
            pos = 0
            with open(path, "rb") as fh:
                for raw in fh:
                    entry["offsets"].append(pos)
                    pos += len(raw)
                    try:
                        item = json.loads(raw)
                    except ValueError:
                        continue
                    path_value = item.get("path")
                    if not path_value:
                        continue
                    key = f"{item.get('json_path') or ''}"
                    record = {
                        "path": path_value, "edge": bool(item.get("edge")),
                        "retest_trace_id": str(item.get("retest_trace_id") or ""),
                        "request_time": str(item.get("request_time") or ""),
                    }
                    for ident in (item.get("trace_id"), item.get("retest_trace_id"),
                                  item.get("session_id")):
                        if not ident:
                            continue
                        lookup = f"{ident}\x1f{key}"
                        if lookup in problems:
                            problem_dupes += 1
                            continue
                        problems[lookup] = record

        for path in comp:
            file_idx, entry = add_source("compact", path)
            pos = 0
            with open(path, "rb") as fh:
                for line_no, raw in enumerate(fh):
                    entry["offsets"].append(pos)
                    pos += len(raw)
                    try:
                        row = json.loads(raw)
                    except ValueError:
                        continue
                    smeta = row.get("session_meta") or {}
                    item = str(smeta.get("item_id") or "")
                    case = str(smeta.get("case_id") or "")
                    if item:
                        compact_by_item.setdefault(item, [file_idx, line_no])
                    if case:
                        compact_by_case.setdefault(case, [file_idx, line_no])

        for path in inp:
            file_idx, entry = add_source("input", path)
            pos = 0
            with open(path, "rb") as fh:
                for line_no, raw in enumerate(fh):
                    entry["offsets"].append(pos)
                    pos += len(raw)
                    item, case = _slim_meta_ids(raw)
                    if item:
                        input_by_item.setdefault(item, [file_idx, line_no])
                    if case:
                        input_by_case.setdefault(case, [file_idx, line_no])

        rows = {}
        if coverage and coverage.is_file():
            for row in ab_test.read_rows(coverage):
                eq = ab_test._as_int(row.get("eq_index"))
                if eq is None:
                    continue
                rows[str(eq)] = {
                    "trace": str(row.get("trace_id") or ""),
                    "state": (row.get("retest_state") or "").strip(),
                    "paths": ab_test._split_paths(row.get("cls_paths")),
                    "labels": ab_test._split_paths(row.get("cls_labels")),
                }

        if problem_dupes:
            build.debug(f"ab detail index {round_dir.name}: {problem_dupes} duplicate problem keys")
        return {
            "version": INDEX_VERSION,
            "sig": sig,
            "built_at_ns": time.time_ns(),
            "sources": sources,
            "attribution": attribution,
            "problems": problems,
            "problem_duplicates": problem_dupes,
            "compact_by_item": compact_by_item,
            "compact_by_case": compact_by_case,
            "input_by_item": input_by_item,
            "input_by_case": input_by_case,
            "coverage": rows,
        }

    @staticmethod
    def _save_index(path: Path, index):
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(path.suffix + ".tmp")
        tmp.write_text(json.dumps(index, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        os.replace(tmp, path)

    @staticmethod
    def _read_line(round_dir: Path, entry, line_no: int) -> bytes:
        offsets = entry["offsets"]
        start = offsets[line_no]
        end = offsets[line_no + 1] if line_no + 1 < len(offsets) else entry["size"]
        fd = os.open(round_dir / entry["rel"], os.O_RDONLY)
        try:
            raw = os.pread(fd, end - start, start)
        finally:
            os.close(fd)
        return raw[:-1] if raw.endswith(b"\n") else raw

    def _load(self, index, round_dir: Path, ref):
        try:
            return json.loads(self._read_line(round_dir, index["sources"][ref[0]], ref[1]))
        except (OSError, IndexError, ValueError) as exc:
            build.debug(f"ab detail: source row read failed: {exc}")
            return None

    # ---- details ---------------------------------------------------------------------------

    @staticmethod
    def _fresh(path: Path, stamp: int):
        try:
            if path.stat().st_mtime_ns >= stamp:
                build.ensure_detail_gz(path)
                return True
        except OSError:
            pass
        return False

    def ensure(self, round_id, eq):
        """Generate (or reuse) one after-release detail; ``None`` when it cannot be built."""
        try:
            eq = int(eq)
        except (TypeError, ValueError):
            return None
        if eq <= 0:
            return None
        found = self._round(round_id)
        if not found:
            return None
        product, round_dir = found
        path = self.sample_dir / round_id / f"{eq}.json"
        with self._lock:
            index = self._index(round_id, round_dir)
            if self._fresh(path, index.get("built_at_ns") or 0):
                return path
            detail = self._build_detail(product, round_dir, round_id, eq, index)
            if detail is None:
                return None
            build.write_json(path, detail)
            build.ensure_detail_gz(path)
            return path

    def _build_detail(self, product: str, round_dir: Path, round_id: str, eq: int, index):
        found = index["attribution"].get(str(eq))
        if not found:
            return None
        attr = self._load(index, round_dir, (found["file"], found["line"]))
        if not isinstance(attr, dict):
            return None
        smeta = attr.get("session_meta") or {}
        item = str(smeta.get("item_id") or found.get("item_id") or "")
        case = str(smeta.get("case_id") or "")

        input_ref = index["input_by_item"].get(item) if item else None
        if input_ref is None and case:
            input_ref = index["input_by_case"].get(case)
        if input_ref is None:
            return None
        inp = self._load(index, round_dir, input_ref)
        if not isinstance(inp, dict):
            return None

        compact_ref = index["compact_by_item"].get(item) if item else None
        if compact_ref is None and case:
            compact_ref = index["compact_by_case"].get(case)
        comp = self._load(index, round_dir, compact_ref) if compact_ref else None

        coverage = index["coverage"].get(str(eq)) or {}
        target_trace = coverage.get("trace") or ""
        retest_trace = str(smeta.get("trace_id") or "")
        pair = {
            "product": product, "model": found.get("model") or "",
            "date": _retest_date(inp, smeta), "split": "retest",
            "input": None, "compact": None, "output": None,
        }
        detail, _row, _facts = build.build_sample(
            pair, inp, attr, comp if isinstance(comp, dict) else None, {}, Counter())
        matched, total, first_hit = _fill_clusters(detail, target_trace, index, retest_trace)
        if total:
            build.debug(f"ab detail {round_id}/{eq}: cluster backfill {matched}/{total}")
        if first_hit and not pair["date"]:
            detail["date"] = pair["date"] = _retest_date_from(first_hit.get("request_time"))
        detail["ab"] = {"round": round_id, "eq": eq, "trace": target_trace}
        if first_hit:
            detail["ab"]["retest_trace"] = first_hit.get("retest_trace_id") or retest_trace
        return detail
