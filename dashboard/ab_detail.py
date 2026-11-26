"""Self-contained symmetric AB sample detail builder (GET /ab_samples/<roundId>/<side>-<eq>.json).

Both ``before`` and ``after`` sides read strictly from inside the round directory::

    bench/bench.jsonl
    agent_before_opt/
      res_before_opt.jsonl
      eval_output/{attribution.jsonl, attribution_human_read.jsonl, compact.jsonl}
      cluster/item_index.jsonl
    agent_after_opt/
      res_after_opt.jsonl
      eval_output/{attribution.jsonl, attribution_human_read.jsonl, compact.jsonl}
      cluster/item_index.jsonl
    index_stats/pairs_index.csv

Attribution, input, compact, and optional human_read records are joined via ``eq_index``,
``case_key``/``case_id``, ``item_id``, and ``trace_id``. File byte offsets are cached in
``cache/ab-details/<roundId>-<side>.json`` and verified against ``(size, mtime_ns)``.
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
import human_read_overlay as hro
from keylocks import KeyedLocks

INDEX_VERSION = 6

ROUND_ID_RE = re.compile(r"^[0-9A-Za-z][0-9A-Za-z._-]*$")
REF_RE = re.compile(r"^(?:(before|after)-)?(\d+)$")
CASE_EQ_RE = re.compile(r"(?:^|_)eq_(\d+)$")
ITEM_RE = re.compile(rb'"item_id"\s*:\s*"([^"]+)"')
CASE_RE = re.compile(rb'"case_id"\s*:\s*"([^"]+)"')
CASE_KEY_RE = re.compile(rb'"case_key"\s*:\s*"([^"]+)"')
TRACE_RE = re.compile(rb'"trace_id"\s*:\s*"([^"]+)"')

FS_CLOCK_SLACK_NS = 20_000_000


def _slim_meta_ids(raw: bytes):
    """Extract ``(item_id, case_id, case_key, trace_ids)`` without decoding full transcripts."""
    item_id = ""
    case_id = ""
    case_key = ""
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
                    item_id = str(meta.get("item_id") or "")
                    case_id = str(meta.get("case_id") or "")
                    case_key = str(meta.get("case_key") or "")
                    break
            pos = anchor + 1
    if not item_id:
        m = ITEM_RE.search(raw)
        if m:
            item_id = m.group(1).decode("utf-8", "ignore")
    if not case_id:
        m = CASE_RE.search(raw)
        if m:
            case_id = m.group(1).decode("utf-8", "ignore")
    if not case_key:
        m = CASE_KEY_RE.search(raw)
        if m:
            case_key = m.group(1).decode("utf-8", "ignore")
    tids = []
    seen = set()
    for m in TRACE_RE.finditer(raw):
        tid = m.group(1).decode("utf-8", "ignore")
        if tid and tid not in seen:
            seen.add(tid)
            tids.append(tid)
    return item_id, case_id, case_key, tids


def _retest_date(inp, smeta) -> str:
    meta = (inp or {}).get("meta") or {}
    for value in (meta.get("request_time"), smeta.get("request_time")):
        day = build.local_day(value)
        if day:
            return day
    return ""


def _retest_date_from(value) -> str:
    return build.local_day(value) or ""


def _apply_human_read(detail: dict, hr_attr: dict | None) -> bool:
    """Apply ``attribution_human_read.jsonl`` display fields over ``detail`` when present."""
    if not isinstance(hr_attr, dict) or not isinstance(detail.get("attribution"), dict):
        return False
    da = detail["attribution"]
    applied = False
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
                    if 0 <= pid < len(d_probs) and hro._apply_problem_overlay(d_probs[pid], hp):
                        applied = True

    hr_sprobs = hr_attr.get("session_problem") or []
    d_sprob_ids = da.get("session_problems") or []
    if len(hr_sprobs) == len(d_sprob_ids):
        for pid, hp in zip(d_sprob_ids, hr_sprobs):
            if 0 <= pid < len(d_probs) and hro._apply_problem_overlay(d_probs[pid], hp):
                applied = True
    return applied


def _fill_clusters(detail, index, *idents: str):
    """Backfill attribution problems from ``cluster/item_index.jsonl``.

    Matches both ``json_path`` (``turns[0].problem[0]`` / ``session_problem[0]``) and
    ``(turn_index, problem_index)`` keys.
    """
    attr = detail.get("attribution") or {}
    problems = attr.get("problems") or []
    lookup = index.get("problems") or {}
    matched = 0
    first_hit = None
    clean_idents = [str(x) for x in idents if x]

    def apply(problem_id: int, keys: tuple[str, ...]):
        nonlocal matched, first_hit
        for ident in clean_idents:
            for key in keys:
                hit = lookup.get(f"{ident}\x1f{key}")
                if hit and hit.get("path"):
                    problems[problem_id]["cl"] = {
                        "path": hit["path"],
                        "edge": bool(hit.get("edge")),
                        "tags": [],
                    }
                    matched += 1
                    if first_hit is None:
                        first_hit = hit
                    return

    for ti, turn in enumerate(attr.get("turns") or []):
        for pi, problem_id in enumerate(turn.get("problems") or []):
            apply(problem_id, (f"turns[{ti}].problem[{pi}]", f"tp:{ti}:{pi}"))
    for pi, problem_id in enumerate(attr.get("session_problems") or []):
        apply(problem_id, (f"session_problem[{pi}]",))
    return matched, len(problems), first_hit


class ABDetailBuilder:
    def __init__(self, datasets: Path | str, cache_dir: Path | str, sample_dir: Path | str):
        self.datasets = Path(datasets)
        self.cache_dir = Path(cache_dir)
        self.sample_dir = Path(sample_dir)
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self.sample_dir.mkdir(parents=True, exist_ok=True)
        self._index_lock = threading.RLock()
        self._eq_locks = KeyedLocks()
        self._indexes = {}
        self._gpt_cache = {}
        self._rounds = {}

    def _eq_lock(self, round_id: str, cache_stem: str):
        return self._eq_locks((round_id, cache_stem))

    def _round(self, round_id: str):
        if not ROUND_ID_RE.match(round_id or ""):
            return None
        cached = self._rounds.get(round_id)
        if cached:
            return cached
        for product in sorted(build.ENABLED):
            for _order, _version, round_dir in ab_test.ab_round_dirs(self.datasets, product):
                if round_dir.name == round_id and ab_test.is_ab_round(round_dir):
                    found = (product, round_dir)
                    with self._index_lock:
                        self._rounds[round_id] = found
                    return found
        return None

    @staticmethod
    def _side_files(round_dir: Path, side: str):
        side_dir = round_dir / ab_test.SIDE_DIR[side]
        attr = side_dir / ab_test.ATTR_REL
        hr_attr = side_dir / ab_test.HR_ATTR_REL
        comp = side_dir / ab_test.COMPACT_REL
        inp = side_dir / ab_test.INPUT_FILE[side]
        items = side_dir / ab_test.CLUSTER_DIR / "item_index.jsonl"
        pairs = round_dir / ab_test.PAIRS_INDEX_REL
        meta = round_dir / ab_test.META_REL
        return {
            "attr": attr if attr.is_file() else None,
            "hr_attr": hr_attr if hr_attr.is_file() else None,
            "comp": comp if comp.is_file() else None,
            "inp": inp if inp.is_file() else None,
            "items": items if items.is_file() else None,
            "pairs": pairs if pairs.is_file() else None,
            "meta": meta if meta.is_file() else None,
        }

    @staticmethod
    def _stat(path: Path, round_dir: Path):
        st = path.stat()
        return [path.relative_to(round_dir).as_posix(), st.st_size, st.st_mtime_ns]

    @staticmethod
    def _signature(side: str, stats) -> str:
        return hashlib.sha1(json.dumps(
            {"version": INDEX_VERSION, "side": side, "stats": stats},
            separators=(",", ":"),
        ).encode()).hexdigest()

    def _index(self, round_id: str, round_dir: Path, side: str):
        files = self._side_files(round_dir, side)
        stats = [self._stat(p, round_dir) for p in files.values() if p is not None]
        sig = self._signature(side, stats)
        key = (round_id, side)
        cached = self._indexes.get(key)
        if cached and cached.get("sig") == sig:
            return cached
        cache_path = self.cache_dir / "ab-details" / f"{round_id}-{side}.json"
        try:
            index = json.loads(cache_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            index = None
        if not index or index.get("version") != INDEX_VERSION or index.get("sig") != sig:
            index = self._build_index(round_dir, side, files, sig)
            self._save_index(cache_path, index)
        self._indexes[key] = index
        return index

    def _build_index(self, round_dir: Path, side: str, files: dict, sig: str):
        sources = []
        attribution = {}
        problems = {}
        problem_dupes = 0
        compact_by_item, compact_by_case, compact_by_trace = {}, {}, {}
        input_by_item, input_by_case, input_by_trace = {}, {}, {}
        hr_by_key, hr_by_hash, hr_by_eq = {}, {}, {}

        meta_doc = ab_test.read_json(files["meta"]) if files["meta"] else {}
        model_name = ab_test._short_model(str((meta_doc or {}).get("model") or ""))

        pair_by_eq = {}
        trace_to_eqs = {}
        case_to_eq = {}
        if files["pairs"]:
            for idx, row in enumerate(ab_test.read_rows(files["pairs"]), 1):
                eq = ab_test._as_int(row.get("eq_index")) or idx
                t_tid = str(row.get("trace_id") or "").strip()
                b_tid = str(row.get("before_trace_id") or "").strip()
                a_tid = str(row.get("after_trace_id") or "").strip()
                ck = str(row.get("case_key") or f"eq_{eq:05d}").strip()
                pair_by_eq[str(eq)] = {
                    "trace": t_tid,
                    "side_trace": b_tid if side == "before" else a_tid,
                    "case_key": ck,
                    "session_id": str(row.get("session_id") or "").strip(),
                }
                if ck:
                    case_to_eq[ck] = eq
                for cand in (t_tid, b_tid if side == "before" else a_tid):
                    if cand:
                        trace_to_eqs.setdefault(cand, []).append(eq)

        def add_source(kind: str, path: Path):
            st = path.stat()
            sources.append({
                "kind": kind,
                "rel": path.relative_to(round_dir).as_posix(),
                "size": st.st_size,
                "mtime_ns": st.st_mtime_ns,
                "offsets": [],
            })
            return len(sources) - 1, sources[-1]

        if files["attr"]:
            file_idx, entry = add_source("attribution", files["attr"])
            pos = 0
            with open(files["attr"], "rb") as fh:
                for line_no, raw in enumerate(fh):
                    if not raw.endswith(b"\n"):
                        break
                    entry["offsets"].append(pos)
                    pos += len(raw)
                    try:
                        row = json.loads(raw)
                    except ValueError:
                        continue
                    smeta = row.get("session_meta") or {}
                    item_id = str(smeta.get("item_id") or "")
                    case_id = str(smeta.get("case_id") or "")
                    case_key = str(smeta.get("case_key") or "")
                    turns = row.get("turns") or []
                    row_tids = []
                    for turn in turns:
                        if isinstance(turn, dict):
                            tid = str((turn.get("meta") or {}).get("trace_id") or "")
                            if tid and tid not in row_tids:
                                row_tids.append(tid)
                    if smeta.get("trace_id") and str(smeta["trace_id"]) not in row_tids:
                        row_tids.append(str(smeta["trace_id"]))

                    matched_eqs = []
                    for cand in (case_key, case_id):
                        if not cand:
                            continue
                        if cand in case_to_eq:
                            matched_eqs.append(case_to_eq[cand])
                            break
                        m = CASE_EQ_RE.search(cand)
                        if m:
                            matched_eqs.append(int(m.group(1)))
                            break
                    if not matched_eqs:
                        for tid in row_tids:
                            matched_eqs.extend(trace_to_eqs.get(tid) or [])

                    for eq_num in matched_eqs:
                        attribution.setdefault(str(eq_num), {
                            "file": file_idx,
                            "line": line_no,
                            "model": model_name,
                            "item_id": item_id,
                            "case_id": case_id,
                            "case_key": case_key,
                            "trace_id": row_tids[0] if row_tids else "",
                        })
            entry["committed"] = pos

        if files["items"]:
            _fidx, entry = add_source("item_index", files["items"])
            pos = 0
            with open(files["items"], "rb") as fh:
                for raw in fh:
                    if not raw.endswith(b"\n"):
                        break
                    entry["offsets"].append(pos)
                    pos += len(raw)
                    try:
                        item = json.loads(raw)
                    except ValueError:
                        continue
                    path_value = item.get("path")
                    if not path_value:
                        continue
                    keys = []
                    jp = str(item.get("json_path") or "").strip()
                    if jp:
                        keys.append(jp)
                    ti = item.get("turn_index")
                    pi = item.get("problem_index")
                    if ti is not None and pi is not None:
                        keys.append(f"tp:{ti}:{pi}")
                    if not keys:
                        keys.append("")
                    record = {
                        "path": path_value,
                        "edge": bool(item.get("edge")),
                        "retest_trace_id": str(item.get("retest_trace_id") or ""),
                        "request_time": str(item.get("request_time") or ""),
                    }
                    idents = [
                        item.get("trace_id"),
                        item.get("retest_trace_id"),
                        item.get("session_id"),
                    ]
                    for ident in idents:
                        if not ident:
                            continue
                        for k in keys:
                            lookup = f"{ident}\x1f{k}"
                            if lookup in problems:
                                problem_dupes += 1
                                continue
                            problems[lookup] = record
            entry["committed"] = pos

        if files["comp"]:
            file_idx, entry = add_source("compact", files["comp"])
            pos = 0
            with open(files["comp"], "rb") as fh:
                for line_no, raw in enumerate(fh):
                    if not raw.endswith(b"\n"):
                        break
                    entry["offsets"].append(pos)
                    pos += len(raw)
                    try:
                        row = json.loads(raw)
                    except ValueError:
                        continue
                    smeta = row.get("session_meta") or {}
                    item = str(smeta.get("item_id") or "")
                    case = str(smeta.get("case_id") or "")
                    ckey = str(smeta.get("case_key") or "")
                    if item:
                        compact_by_item.setdefault(item, [file_idx, line_no])
                    if case:
                        compact_by_case.setdefault(case, [file_idx, line_no])
                    if ckey:
                        compact_by_case.setdefault(ckey, [file_idx, line_no])
                    for cand in (smeta.get("trace_id"), row.get("trace_id")):
                        if cand:
                            compact_by_trace.setdefault(str(cand), [file_idx, line_no])
            entry["committed"] = pos

        if files["inp"]:
            file_idx, entry = add_source("input", files["inp"])
            pos = 0
            with open(files["inp"], "rb") as fh:
                for line_no, raw in enumerate(fh):
                    if not raw.endswith(b"\n"):
                        break
                    entry["offsets"].append(pos)
                    pos += len(raw)
                    item, case, ckey, tids = _slim_meta_ids(raw)
                    if item:
                        input_by_item.setdefault(item, [file_idx, line_no])
                    if case:
                        input_by_case.setdefault(case, [file_idx, line_no])
                    if ckey:
                        input_by_case.setdefault(ckey, [file_idx, line_no])
                    for tid in tids:
                        input_by_trace.setdefault(tid, [file_idx, line_no])
            entry["committed"] = pos

        if files["hr_attr"]:
            file_idx, entry = add_source("human_read", files["hr_attr"])
            pos = 0
            with open(files["hr_attr"], "rb") as fh:
                for line_no, raw in enumerate(fh):
                    if not raw.endswith(b"\n"):
                        break
                    entry["offsets"].append(pos)
                    pos += len(raw)
                    try:
                        row = json.loads(raw)
                    except ValueError:
                        continue
                    ref = [file_idx, line_no]
                    rkey = hro.record_key_for_record(row, "attribution")
                    shash = hro._attr_fingerprint(row)
                    hr_by_key.setdefault(rkey, ref)
                    hr_by_hash.setdefault(shash, ref)
                    smeta = row.get("session_meta") or {}
                    for cand in (smeta.get("case_key"), smeta.get("case_id")):
                        m = CASE_EQ_RE.search(str(cand or ""))
                        if m:
                            hr_by_eq.setdefault(str(int(m.group(1))), ref)
                            break
            entry["committed"] = pos

        return {
            "version": INDEX_VERSION,
            "side": side,
            "sig": sig,
            "built_at_ns": time.time_ns(),
            "sources": sources,
            "attribution": attribution,
            "problems": problems,
            "problem_duplicates": problem_dupes,
            "compact_by_item": compact_by_item,
            "compact_by_case": compact_by_case,
            "compact_by_trace": compact_by_trace,
            "input_by_item": input_by_item,
            "input_by_case": input_by_case,
            "input_by_trace": input_by_trace,
            "hr_by_key": hr_by_key,
            "hr_by_hash": hr_by_hash,
            "hr_by_eq": hr_by_eq,
            "pairs": pair_by_eq,
        }

    @staticmethod
    def _save_index(path: Path, index):
        path.parent.mkdir(parents=True, exist_ok=True)
        build.replace_bytes(
            path,
            json.dumps(index, ensure_ascii=False, separators=(",", ":")).encode("utf-8"),
        )

    @staticmethod
    def _read_line(round_dir: Path, entry, line_no: int) -> bytes:
        offsets = entry["offsets"]
        start = offsets[line_no]
        end = offsets[line_no + 1] if line_no + 1 < len(offsets) else entry.get("committed", entry["size"])
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

    @staticmethod
    def _fresh(path: Path, stamp: int):
        try:
            if path.stat().st_mtime_ns >= stamp - FS_CLOCK_SLACK_NS:
                build.ensure_detail_gz(path)
                return True
        except OSError:
            pass
        return False

    @staticmethod
    def _drop(path: Path):
        for target in (path, Path(str(path) + ".gz"), Path(str(path) + ".br")):
            try:
                target.unlink()
            except OSError:
                pass

    def warm(self):
        """Warm both before & after AB indexes at startup."""
        for product in sorted(build.ENABLED):
            try:
                rounds = ab_test.ab_round_dirs(self.datasets, product)
            except OSError:
                continue
            for _order, _version, round_dir in rounds:
                if not ab_test.is_ab_round(round_dir):
                    continue
                for side in ("before", "after"):
                    try:
                        with self._index_lock:
                            index = self._index(round_dir.name, round_dir, side)
                        build.debug(
                            f"ab index ready: {round_dir.name}/{side} ({len(index.get('attribution') or {})} rows)"
                        )
                    except Exception as exc:  # noqa: BLE001
                        build.debug(f"ab index warm failed {round_dir.name}/{side}: {exc}")

    def gpt(self, round_id, key):
        found = self._round(round_id)
        if not found:
            return None
        _product, round_dir = found
        path = round_dir / ab_test.GPT_RAW_REL / f"{key}.json"
        try:
            stat = path.stat()
        except OSError:
            return None
        cache_key = (round_id, key)
        cached = self._gpt_cache.get(cache_key)
        if cached and cached[0] == (stat.st_size, stat.st_mtime_ns):
            return cached[1]
        answer = ab_test.read_gpt_answer(round_dir, key)
        with self._index_lock:
            self._gpt_cache[cache_key] = ((stat.st_size, stat.st_mtime_ns), answer)
        return answer

    @staticmethod
    def _parse_ref(ref) -> tuple[str, int] | None:
        if isinstance(ref, int):
            return ("after", ref) if ref > 0 else None
        text = str(ref or "").strip()
        m = REF_RE.match(text)
        if not m:
            return None
        side = m.group(1) or "after"
        eq = int(m.group(2))
        if eq <= 0:
            return None
        return side, eq

    def ensure(self, round_id, ref):
        parsed = self._parse_ref(ref)
        if not parsed:
            return None
        side, eq = parsed
        found = self._round(round_id)
        if not found:
            return None
        product, round_dir = found
        file_stem = str(ref).strip()
        cache_stem = f"{side}-{eq}"
        path = self.sample_dir / round_id / f"{file_stem}.json"
        with self._index_lock:
            index = self._index(round_id, round_dir, side)
        with self._eq_lock(round_id, cache_stem):
            if str(eq) not in index["attribution"]:
                self._drop(path)
                return None
            if self._fresh(path, index.get("built_at_ns") or 0):
                return path
            detail = self._build_side_detail(product, round_dir, round_id, side, eq, index)
            if detail is None:
                self._drop(path)
                return None
            build.write_json(path, detail)
            build.ensure_detail_gz(path)
            return path

    @staticmethod
    def _lookup_ref(mapping: dict, *keys: str):
        for k in keys:
            if k and k in mapping:
                return mapping[k]
        return None

    def _build_side_detail(self, product: str, round_dir: Path, round_id: str, side: str, eq: int, index):
        found = index["attribution"].get(str(eq))
        if not found:
            return None
        attr = self._load(index, round_dir, (found["file"], found["line"]))
        if not isinstance(attr, dict):
            return None
        smeta = attr.get("session_meta") or {}
        pair_info = index["pairs"].get(str(eq)) or {}
        target_trace = pair_info.get("trace") or ""
        side_trace = found.get("trace_id") or pair_info.get("side_trace") or str(smeta.get("trace_id") or "")
        item = str(smeta.get("item_id") or found.get("item_id") or "")
        case = str(smeta.get("case_id") or found.get("case_id") or "")
        ckey = str(smeta.get("case_key") or found.get("case_key") or pair_info.get("case_key") or "")

        turn_tids = [
            str((t.get("meta") or {}).get("trace_id") or "")
            for t in (attr.get("turns") or [])
            if isinstance(t, dict) and (t.get("meta") or {}).get("trace_id")
        ]

        inp_ref = (
            self._lookup_ref(index["input_by_item"], item)
            or self._lookup_ref(index["input_by_case"], case, ckey)
            or self._lookup_ref(index["input_by_trace"], side_trace, target_trace, *turn_tids)
        )
        inp = self._load(index, round_dir, inp_ref) if inp_ref else None
        if not isinstance(inp, dict):
            inp = None

        comp_ref = (
            self._lookup_ref(index["compact_by_item"], item)
            or self._lookup_ref(index["compact_by_case"], case, ckey)
            or self._lookup_ref(index["compact_by_trace"], side_trace, target_trace, *turn_tids)
        )
        comp = self._load(index, round_dir, comp_ref) if comp_ref else None

        pair = {
            "product": product,
            "model": found.get("model") or "",
            "date": _retest_date(inp, smeta),
            "split": side,
            "input": None,
            "compact": None,
            "output": None,
        }
        detail, _row, _facts = build.build_sample(
            pair, inp, attr, comp if isinstance(comp, dict) else None, {}, Counter()
        )
        matched, total, first_hit = _fill_clusters(
            detail,
            index,
            target_trace,
            side_trace,
            *turn_tids,
            pair_info.get("session_id") or "",
            str(smeta.get("session_id") or ""),
        )

        hr_ref = None
        if index.get("hr_by_key") or index.get("hr_by_hash") or index.get("hr_by_eq"):
            rkey = hro.record_key_for_record(attr, "attribution")
            shash = hro._attr_fingerprint(attr)
            hr_ref = (
                index["hr_by_key"].get(rkey)
                or index["hr_by_hash"].get(shash)
                or index["hr_by_eq"].get(str(eq))
            )
        if hr_ref:
            hr_attr = self._load(index, round_dir, hr_ref)
            _apply_human_read(detail, hr_attr)

        if total:
            build.debug(f"ab detail {round_id}/{side}-{eq}: cluster backfill {matched}/{total}")
        if first_hit and not pair["date"]:
            detail["date"] = pair["date"] = _retest_date_from(first_hit.get("request_time"))
        detail["ab"] = {"round": round_id, "side": side, "eq": eq, "trace": target_trace}
        if side_trace and side_trace != target_trace:
            detail["ab"]["side_trace"] = side_trace
        return detail
