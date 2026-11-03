#!/usr/bin/env python3
"""Build every dashboard payload from the evaluation datasets.

Layout read under the datasets root (repo ``datasets/`` locally, ``EVAL_DATASETS`` otherwise)::

    对应关系.csv                                   one row per input / attribution / compact triple
    <n>_<product>/eval_input/[<split dir>/]<model>/<date>.jsonl
    <n>_<product>/eval_output/<split>/<model>/<model>_attribution-<date>.jsonl
    <n>_<product>/eval_output/<split>/<model>/compact/<model>_compact-<date>.jsonl
    <n>_<product>/eval_output/**/cluster/<model>/{cluster_tree.json,item_index.jsonl}

    4_forecast/<product>/prediction.json            optional 预测体系 feed (docs/prediction-data.md)

The CSV pins each attribution line to its input and compact line (verified by SHA-256).
Without it, triples are paired inside one model/date file by session id + request time;
duplicate input snapshots are resolved by which one covers the attribution's trace ids.

Outputs, each with a ``.gz`` twin::

    static/data.json                shared shell: taxonomy, 评测体系 facts, product list
    static/data-<product>.json      one product's aggregates for the 数据 view
    static/samples.json             product list for the 样本 view
    static/samples-<product>.json   one product's recall index
    static/samples/<slug>.json      one sample, generated on first request (detail_builder.py)
"""
from __future__ import annotations

import argparse
import csv
import gzip
import hashlib
import json_compat as json
import multiprocessing
import os
import pickle
import re
import shutil
import sys
import time
from collections import Counter, OrderedDict, defaultdict
from concurrent.futures import ProcessPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import unquote

import build_store as bs

DASHBOARD = Path(__file__).resolve().parent
REPO = DASHBOARD.parent
STATIC = DASHBOARD / "static"
PRODUCTION_DATASETS = Path("/mnt/fin_bench/code_and_clean_data/datasets")
# Bump when the aggregate payload shape changes (details can stay cached).
PAYLOAD_VERSION = "2026-11-03.4"
# Bump when load_clusters() starts emitting fields the cached pickle lacks.
CLUSTER_INDEX_VERSION = 2


def default_datasets():
    """EVAL_DATASETS, else the mounted production tree, else <repo>/datasets."""
    if os.environ.get("EVAL_DATASETS"):
        return Path(os.environ["EVAL_DATASETS"]).expanduser()
    return PRODUCTION_DATASETS if PRODUCTION_DATASETS.is_dir() else REPO / "datasets"

SEVERITIES = ["P0", "P1", "P2", "P3", "P4"]
WORST_KEYS = SEVERITIES + ["none"]

# Only fields the recall list and its filters/search actually read. Keeping the
# index lean matters more than the full aggregate row: it is fetched by every
# 具体数据 view and can be several MB.
INDEX_FIELDS = ("s", "q", "m", "sp", "d", "sid", "tid", "w", "n", "tr", "pt", "st", "lb", "case", "task", "sub", "skill")

PRODUCTS = {
    "wencai": {"label": "问财", "models": ["a_fast", "a_expert", "b_fast", "b_expert"]},
    "aime": {"label": "AIME", "models": ["aime_fast", "aime_expert"]},
}
MODEL_LABEL = {
    "a_fast": "A Fast", "a_expert": "A Expert", "b_fast": "B Fast", "b_expert": "B Expert",
    "aime_fast": "Fast", "aime_expert": "Expert",
}
SPLITS = {"0_daily_eval": "daily", "1_lost_user_eval": "lost"}
SPLIT_LABEL = {"daily": "日常评测", "lost": "流失用户"}

# The agent's own order: decide → build the request → run it → deliver.
ROLE_ORDER = ["planning", "request_generation", "tool", "script", "skill", "delivery"]
ROLE_LABEL = {
    "planning": "规划", "request_generation": "请求生成", "tool": "工具执行",
    "script": "脚本执行", "skill": "技能装载", "delivery": "交付",
}
STAGE_ORDER = ["S12", "S1", "S2", "S10", "S3", "S4", "S5", "S6", "S7", "S8", "S11", "S9"]
STAGE_PHASE = {
    "S12": "plan", "S1": "plan", "S2": "plan", "S10": "request",
    "S3": "execute", "S4": "execute", "S5": "execute", "S6": "execute", "S7": "execute", "S8": "execute",
    "S11": "deliver", "S9": "deliver",
}
PHASES = [
    {"id": "plan", "name": "规划"}, {"id": "request", "name": "请求"},
    {"id": "execute", "name": "执行"}, {"id": "deliver", "name": "交付"},
]

POSITION = re.compile(r"trace_index\s+(\d+)\s*/\s*message_index\s+(\d+)\s*/\s*path\s+(\S+)")
EVIDENCE_ID = re.compile(r"^ev_[0-9a-f-]{36}_(\d+)_")
DATA_URI = re.compile(r"data:(image/[\w.+-]+);base64,[A-Za-z0-9+/=\s]{64,}")
OUTPUT_FILE = re.compile(
    r"^(?P<product>[^/]+)/eval_output/(?P<split>[^/]+)/(?P<model>[^/]+)/"
    r"(?P=model)_attribution-(?P<date>\d{4}-\d{2}-\d{2})\.jsonl$"
)
CJK = re.compile(r"[㐀-鿿]")
DATE_RE = re.compile(r"(\d{4}-\d{2}-\d{2})")

# Characters kept per text block before trimming to the head plus evidence windows.
BLOCK_LIMIT = {
    "user": 4000, "answer": 14000, "system": 700, "llm": 3200, "think": 2400,
    "call": 2400, "result": 1600, "other": 1600,
}
WINDOW_PAD = 280


# --------------------------------------------------------------------------- helpers

def product_of(top: str) -> str | None:
    name = re.sub(r"^\d+_", "", top)
    return name if name in PRODUCTS else None


TZ = timezone(timedelta(hours=8), "CST")


def iso_now() -> str:
    return datetime.now(TZ).isoformat(timespec="seconds")


def decode_question(text) -> str:
    if isinstance(text, list):
        # Survey-style questions arrive as [{"header": ..., "selected": [...]}, ...].
        parts = []
        for item in text:
            if isinstance(item, dict):
                picked = item.get("selected")
                picked = "、".join(map(str, picked)) if isinstance(picked, list) else str(picked or "")
                parts.append(f"{item.get('header') or ''}：{picked}".strip("："))
            elif isinstance(item, str):
                parts.append(item)
        text = "；".join(p for p in parts if p)
    q = (text or "").strip() if isinstance(text, str) else ""
    if re.search(r"%[0-9A-Fa-f]{2}", q) and q.count(" ") <= 1:
        try:
            q = unquote(q)
        except Exception:
            pass
    return q


def lang_of(text: str) -> str:
    if not text:
        return "other"
    cjk = len(CJK.findall(text))
    if cjk >= max(2, len(text) * 0.15):
        return "zh"
    if re.search(r"[A-Za-z]{2,}", text):
        return "en"
    return "other"


def scrub_images(text: str) -> str:
    def repl(m):
        kind = m.group(1).split("/")[-1]
        kb = max(1, len(m.group(0)) * 3 // 4 // 1024)
        return f"[图片 {kind} · {kb} KB]"
    return DATA_URI.sub(repl, text)


def as_text(value):
    if isinstance(value, str):
        return value, "text"
    if value is None:
        return "", "text"
    return json.dumps(value, ensure_ascii=False, indent=2), "json"


def clip(text, n):
    text = text if isinstance(text, str) else ("" if text is None else str(text))
    return text if len(text) <= n else text[: n - 1].rstrip() + "…"


def ts_ms(value):
    if not isinstance(value, str) or len(value) < 19:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp() * 1000
    except ValueError:
        return None


def histogram(values, edges):
    """Counts per bin; ``edges`` are inclusive lower bounds, the last bin is open."""
    counts = [0] * len(edges)
    for v in values:
        i = 0
        while i + 1 < len(edges) and v >= edges[i + 1]:
            i += 1
        counts[i] += 1
    return {"edges": edges, "counts": counts}


def quantile(values, q):
    if not values:
        return None
    s = sorted(values)
    return s[min(len(s) - 1, int(q * (len(s) - 1) + 0.5))]


# --------------------------------------------------------------------------- pairing

class LineReader:
    """Line access backed by the persistent file index.

    Output and compact files are small (tens of MB), so they are loaded once and
    kept in a small LRU.  Input files can be multi-GB: samples are read in one
    forward pass (``iter_input``) instead of one ceph seek per sample, which is
    the difference between seconds and tens of minutes on the production mount.
    """

    def __init__(self, root: Path, store: bs.BuildStore, max_files: int = 12,
                 max_bytes: int = 512 << 20):
        self.root = root
        self.store = store
        self.max_files = max_files
        self.max_bytes = max_bytes
        self._lines: OrderedDict[str, list[bytes]] = OrderedDict()
        self._bytes = 0
        self._fds: dict[str, int] = {}

    def _evict(self):
        while len(self._lines) > self.max_files or self._bytes > self.max_bytes:
            _, old = self._lines.popitem(last=False)
            self._bytes -= sum(len(x) for x in old)

    def lines(self, rel: str) -> list[bytes]:
        if rel in self._lines:
            self._lines.move_to_end(rel)
            return self._lines[rel]
        data = (self.root / rel).read_bytes()
        lines = data.split(b"\n")
        if lines and lines[-1] == b"":
            lines.pop()
        lines = [x[:-1] if x.endswith(b"\r") else x for x in lines]
        self._lines[rel] = lines
        self._bytes += len(data)
        self._evict()
        return lines

    def line(self, rel: str, number: int) -> bytes:
        return self.lines(rel)[number - 1]

    def raw_line(self, rel: str, number: int, index: dict | None = None) -> bytes:
        if index is None:
            span = self.store.line_span(rel, number)
            return self.read_span(rel, *span) if span else self.line(rel, number)
        offsets = index["offsets"]
        start = offsets[number - 1]
        end = offsets[number] if number < len(offsets) else index["committed"]
        return self.read_span(rel, start, end)

    def read_span(self, rel: str, start: int, end: int) -> bytes:
        fd = self._fds.get(rel)
        if fd is None:
            fd = os.open(self.root / rel, os.O_RDONLY)
            self._fds[rel] = fd
        raw = os.pread(fd, end - start, start)
        return raw[:-1] if raw.endswith(b"\n") else raw

    def iter_input(self, rel: str, numbers, index: dict):
        """Yield selected input lines in file order (random for very sparse sets)."""
        numbers = sorted(numbers)
        if not numbers:
            return
        density = len(numbers) / max(1, index["lines"])
        if density < 0.08:
            for number in numbers:
                yield number, self.raw_line(rel, number, index)
            return
        wanted = set(numbers)
        first, last = numbers[0], numbers[-1]
        offsets = index["offsets"]
        with open(self.root / rel, "rb", buffering=8 << 20) as fh:
            fh.seek(offsets[first - 1])
            number = first
            for raw in fh:
                if number > last:
                    break
                if number in wanted:
                    yield number, raw[:-1] if raw.endswith(b"\n") else raw
                number += 1

    def close(self):
        for fd in self._fds.values():
            try:
                os.close(fd)
            except OSError:
                pass
        self._fds.clear()


def input_candidates(root: Path, top: str, split: str, model: str, date: str) -> list[str]:
    """Input files for one output, newest layout first.

    AIME lost-user evaluation is temporarily reading the archived full input
    (``.archive/1_lost_user_input``) while the published output keeps updating
    under ``eval_output/1_lost_user_eval``.
    """
    top_dir = root / top
    if split == "daily":
        paths = [
            top_dir / "eval_input" / "0_daily_eval_input" / model / f"{date}.jsonl",
            top_dir / "eval_input" / model / f"{date}.jsonl",
        ]
    else:
        paths = [
            top_dir / ".archive" / "1_lost_user_input" / model / f"{model}-{date}_input.jsonl",
            top_dir / ".archive" / "1_lost_user_input" / model / f"{date}.jsonl",
            top_dir / "eval_input" / "1_lost_user_eval" / model / f"{date}.jsonl",
            top_dir / "eval_input" / "1_lost_user_input" / model / f"{date}.jsonl",
        ]
    return [p.relative_to(root).as_posix() for p in paths if p.is_file()]


def input_files(datasets: Path, top: Path, product: str):
    """Every input file the volume card reads.

    AIME lost-user inputs come from the archive; the smaller
    ``eval_input/1_lost_user_eval`` copy is excluded so days are not counted
    twice while that evaluation is in flight.  Wencai marks lost users inside
    the task-eval input with ``meta.lost_user`` instead of a separate directory.
    """
    files = [p for p in (top / "eval_input").rglob("*.jsonl") if "1_lost_user_eval" not in p.parts]
    if product == "aime":
        files += list((top / ".archive" / "1_lost_user_input").rglob("*.jsonl"))
    return sorted(files)


SIDECAR_SCHEMA = 1


def load_stats_sidecar(datasets: Path):
    """Read the worker-maintained stats.json, if present and valid.

    The sidecar is only an accelerator: every file is still checked against its
    current ``(size, mtime_ns)`` and falls back to a local scan when stale.
    """
    for path in (datasets / "stats.json", DASHBOARD / "cache" / "stats.json"):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if isinstance(data, dict) and data.get("schema") == SIDECAR_SCHEMA:
            return data
    return None


def scan_inputs(datasets: Path, top: Path, product: str, store: bs.BuildStore, jobs: int = 0,
                sidecar_files=None):
    """Scan changed input files once; unchanged files are served from cache.

    New lines are aggregated for volume/task/lost and their byte offsets, join
    keys, trace ids and content hashes are stored for pairing and samples.
    ``sidecar_files`` (path -> meta) lets build skip the scan entirely when the
    standalone stats worker already aggregated the current bytes.
    """
    files = input_files(datasets, top, product)
    if sidecar_files and not isinstance(sidecar_files, dict):
        sidecar_files = {item["path"]: item for item in sidecar_files}
    sidecar_files = sidecar_files or {}
    metas, todo = [], []
    from_sidecar = 0
    for path in files:
        rel = path.relative_to(datasets).as_posix()
        try:
            stat = path.stat()
        except OSError:
            continue
        side = sidecar_files.get(rel)
        if side and side.get("size") == stat.st_size and side.get("mtime_ns") == stat.st_mtime_ns:
            metas.append(side)
            from_sidecar += 1
            continue
        cached = store.file_meta(rel)
        if cached and cached["size"] == stat.st_size and cached["mtime_ns"] == stat.st_mtime_ns:
            metas.append(cached)
            continue
        prev = store.get_file(rel) if cached else None
        todo.append((str(datasets), rel, "input", prev, True, product,
                     bs.split_from_rel(rel), bs.model_from_rel(rel)))
    if todo:
        workers = jobs or (min(4, os.cpu_count() or 1) if len(todo) >= 4 else 1)
        debug(f"scan {product}: {len(todo)}/{len(files)} files, workers={workers}")
        if workers > 1:
            with ProcessPoolExecutor(max_workers=workers) as pool:
                results = list(pool.map(bs.scan_task, todo))
        else:
            results = [bs.scan_task(task) for task in todo]
        for data in results:
            data["product"] = product
            store.put_file(data)
            metas.append({key: data[key] for key in
                          ("path", "size", "mtime_ns", "lines", "committed", "ends_nl",
                           "stats", "model", "split")})
        store.commit()
    return metas, {"files": len(files), "scanned": len(todo),
                   "cached": len(files) - len(todo), "sidecar": from_sidecar}


def _task_nodes(tasks: dict):
    out = []
    for task, node in tasks.items():
        subs = [{"sub": sub, "n": value["n"], **({"lost": value["lost"]} if value.get("lost") else {})}
                for sub, value in node.get("sub", {}).items()]
        subs.sort(key=lambda x: (-x["n"], x["sub"]))
        item = {"task": task, "n": node["n"]}
        if node.get("lost"):
            item["lost"] = node["lost"]
        if subs:
            item["sub"] = subs
        out.append(item)
    out.sort(key=lambda x: (-x["n"], x["task"]))
    return out


def input_payload(metas):
    """Volume + task/subtask + lost counts for one product, from cached file stats."""
    agg = bs.empty_stats()
    records = 0
    for meta in metas:
        records += int(meta.get("lines") or 0)
        bs.merge_stats(agg, meta.get("stats"))

    models = {}
    for model, ms in agg["by_model"].items():
        models[model] = {
            "label": MODEL_LABEL.get(model, model),
            "traces": ms["traces"], "tool_calls": ms["tool_calls"],
            "tokens_in": ms["tokens_in"], "tokens_out": ms["tokens_out"],
            "cache_read": ms["cache_read"], "lost": sum(t.get("lost", 0) for t in ms["tasks"].values()),
            "tasks": _task_nodes(ms["tasks"]),
        }

    top = {}
    for ms in agg["by_model"].values():
        for task, node in ms["tasks"].items():
            dst = top.setdefault(task, {"n": 0, "lost": 0, "sub": {}})
            dst["n"] += node["n"]
            dst["lost"] += node.get("lost", 0)
            for sub, value in node.get("sub", {}).items():
                sub_dst = dst["sub"].setdefault(sub, {"n": 0, "lost": 0})
                sub_dst["n"] += value["n"]
                sub_dst["lost"] += value.get("lost", 0)

    return {
        "records": records, "traces": agg["traces"], "tool_calls": agg["tool_calls"],
        "tokens_in": agg["tokens_in"], "tokens_out": agg["tokens_out"],
        "cache_read": agg["cache_read"],
        "lost": sum(t.get("lost", 0) for t in top.values()),
        "tasks": _task_nodes(top), "models": models,
    }


def daily_inputs(metas):
    """Input record counts by (date, model, split), from the same per-file index."""
    out = Counter()
    for meta in metas:
        match = DATE_RE.search(Path(meta["path"]).name)
        if not match:
            continue
        model = meta.get("model") or Path(meta["path"]).parent.name
        out[(match.group(1), model, meta.get("split") or "daily")] += int(meta.get("lines") or 0)
    return out


def daily_payload(samples, inputs):
    """Per-day input volume plus the evaluated session/trace/token totals.

    ``sids`` is carried alongside the count so the eval card can union sessions
    across a selected window instead of adding per-day distinct counts.  Only
    identity matters there, so sessions are small per-product integers rather
    than 40-character ids (about 400 KB of the AIME payload).
    """
    evaluated = Counter()
    traces = Counter()
    tokens = Counter()
    sids = defaultdict(set)
    number = {}
    for slug, _, row, facts in samples:
        key = (row["d"], row["m"], row["sp"])
        evaluated[key] += 1
        traces[key] += row["tr"]
        tokens[key] += facts["tokens"]
        sids[key].add(number.setdefault(row["sid"] or slug, len(number)))
    keys = set(inputs) | set(evaluated)
    return [
        {
            "d": d, "m": m, "sp": sp,
            "inputs": inputs.get((d, m, sp), 0),
            "evaluated": evaluated.get((d, m, sp), 0),
            "sessions": len(sids.get((d, m, sp), ())),
            "traces": traces.get((d, m, sp), 0),
            "tokens": tokens.get((d, m, sp), 0),
            "sids": sorted(sids.get((d, m, sp), ())),
        }
        for d, m, sp in sorted(keys)
    ]


def debug(message):
    if os.environ.get("EVAL_BUILD_DEBUG"):
        print(f"[build] {message}", file=sys.stderr, flush=True)


def ensure_file(store: bs.BuildStore, root: Path, rel: str, kind: str = "input",
                product: str = "", need_stats: bool = False, load: bool = True):
    """Return a cached file index, scanning only when ``(size, mtime)`` changed.

    ``load=False`` only brings the index up to date; an unchanged file is then
    not decoded at all.
    """
    path = root / rel
    stat = path.stat()
    if store.has_file_stat(rel, stat):
        return store.get_file(rel) if load else None
    prev = store.get_file(rel)
    data = bs.scan_file(root, rel, kind, prev, need_stats, product or product_of(rel.split("/")[0]) or "",
                        bs.split_from_rel(rel), bs.model_from_rel(rel))
    data["product"] = product
    store.put_file(data)
    return data


def ensure_input(store, root, rel, product):
    return ensure_file(store, root, rel, "input", product, True)


def ensure_raw(store, root, rel, load=True):
    kind = "output" if ("attribution" in rel or "compact" in rel) else "input"
    return ensure_file(store, root, rel, kind, "", False, load)


def choose_input(cands, turn_tids):
    """Pick the duplicate input snapshot that actually covers the attribution turns.

    Candidate trace ids are indexed once while the input file is scanned, so this
    no longer re-reads a multi-MB input line per attribution row.
    """
    need = {t for t in turn_tids if t}
    if len(cands) < 2 or not need:
        return cands[0] if cands else None
    best = None
    for cand in cands:
        ids = set(cand[2])
        cover = len(need & ids)
        # Prefer full coverage, then the snapshot with the fewest extra traces.
        score = (cover == len(need), cover, -len(ids) if cover == len(need) else len(ids))
        if best is None or score > best[0]:
            best = (score, cand)
    return best[1] if best else cands[0]


def pairs_from_csv(root: Path, store: bs.BuildStore, reader: LineReader):
    path = root / "对应关系.csv"
    with open(path, encoding="utf-8-sig", newline="") as fh:
        rows = list(csv.DictReader(fh))
    pairs, mismatched = [], 0
    indexed = set()
    for row in rows:
        m = OUTPUT_FILE.match(row["output_file"])
        if not m:
            continue
        product = product_of(m["product"])
        split = SPLITS.get(m["split"])
        if not product or not split:
            continue
        pair = {
            "product": product, "split": split, "model": m["model"], "date": m["date"],
            "run": row.get("run_id") or "",
            "input": (row["input_file"], int(row["export_input_line"])),
            "output": (row["output_file"], int(row["export_output_line"])),
            "compact": (row["compact_file"], int(row["export_compact_line"]))
            if row.get("compact_file") else None,
        }
        checks = [("input", "input_sha256"), ("output", "output_sha256"), ("compact", "compact_sha256")]
        for key, sha_col in checks:
            ref = pair[key]
            if not ref or not row.get(sha_col):
                continue
            try:
                # Stat each file once per build; the line itself comes from its offsets.
                if ref[0] not in indexed:
                    ensure_raw(store, root, ref[0], load=False)
                    indexed.add(ref[0])
                raw = reader.raw_line(ref[0], ref[1])
            except (OSError, IndexError):
                pair[key] = None
                mismatched += 1
                continue
            if hashlib.sha256(raw + b"\n").hexdigest() != row[sha_col]:
                mismatched += 1
        pairs.append(pair)
    return pairs, {"mode": "csv", "rows": len(rows), "sha_mismatch": mismatched}


def discover_outputs(root: Path):
    """Attribution files plus a cheap signature of every file pairing depends on."""
    found = []
    for out in sorted(root.glob("*/eval_output/*/*/*_attribution-*.jsonl")):
        rel = out.relative_to(root).as_posix()
        m = OUTPUT_FILE.match(rel)
        if not m:
            continue
        product, split = product_of(m["product"]), SPLITS.get(m["split"])
        if not product or not split:
            continue
        try:
            stat = out.stat()
        except OSError:
            continue
        inputs = input_candidates(root, m["product"], split, m["model"], m["date"])
        compact = out.parent / "compact" / f"{m['model']}_compact-{m['date']}.jsonl"
        compact_rel = compact.relative_to(root).as_posix() if compact.exists() else None
        parts = [[rel, stat.st_size, stat.st_mtime_ns]]
        for inp in inputs:
            try:
                st = (root / inp).stat()
                parts.append([inp, st.st_size, st.st_mtime_ns])
            except OSError:
                parts.append([inp, -1, -1])
        if compact_rel:
            st = compact.stat()
            parts.append([compact_rel, st.st_size, st.st_mtime_ns])
        sig = hashlib.sha1(json.dumps(parts, separators=(",", ":")).encode()).hexdigest()
        found.append({
            "rel": rel, "product": product, "split": split, "model": m["model"],
            "date": m["date"], "inputs": inputs, "compact": compact_rel, "sig": sig,
        })
    return found


def pair_output(root: Path, item: dict, store: bs.BuildStore):
    slots, compacts = defaultdict(list), defaultdict(list)
    for rel in item["inputs"]:
        index = ensure_input(store, root, rel, item["product"])
        for n, (key, tids, hashes) in enumerate(zip(index["keys"], index["tids"], index["hashes"]), 1):
            if key:
                slots[key].append((rel, n, tids, hashes))
    if item["compact"]:
        index = ensure_raw(store, root, item["compact"])
        for n, (key, hashes) in enumerate(zip(index["keys"], index["hashes"]), 1):
            if key:
                compacts[key].append((item["compact"], n, hashes))

    # The output index already holds each line's key, turn trace ids and SHA-256,
    # so a grown attribution file is never re-read in full here.
    out = ensure_raw(store, root, item["rel"])
    digests = out.get("digests") or b""
    if len(digests) != 32 * out["lines"]:
        out = bs.scan_file(root, item["rel"], "output", None, False, "",
                           bs.split_from_rel(item["rel"]), bs.model_from_rel(item["rel"]))
        out["product"] = ""
        store.put_file(out)
        digests = out["digests"]

    pairs, unmatched = [], Counter()
    for n, (key, turn_tids) in enumerate(zip(out["keys"], out["tids"]), 1):
        digest = digests[32 * (n - 1):32 * n]
        if digest == bs.NO_DIGEST:
            continue
        cands = slots.get(key) or []
        inp = choose_input(cands, turn_tids)
        if inp:
            try:
                cands.remove(inp)
            except ValueError:
                pass
        comp = compacts[key].pop(0) if compacts.get(key) else None
        if inp is None:
            unmatched["input"] += 1
        if comp is None:
            unmatched["compact"] += 1
        pairs.append({
            "product": item["product"], "split": item["split"], "model": item["model"],
            "date": item["date"], "run": "",
            "input": (inp[0], inp[1]) if inp else None,
            "output": (item["rel"], n),
            "compact": (comp[0], comp[1]) if comp else None,
            "ih": f"{inp[3]:016x}" if inp else None,
            "ch": f"{comp[2]:016x}" if comp else None,
            "oh": digest.hex(),
        })
    return pairs, unmatched


def pairs_from_keys(root: Path, store: bs.BuildStore):
    """Pair each attribution file by session id + request time.

    Unchanged attribution files are served from the pairing cache; only a new or
    changed output (including a changed input snapshot) is re-paired.
    """
    pairs = []
    info = Counter()
    for item in discover_outputs(root):
        # Detail building reads one output line by offset; make sure that index
        # exists even when the pairing itself is served from cache.
        ensure_raw(store, root, item["rel"], load=False)
        cached = store.get_pairs(item["rel"])
        if cached and cached[0] == item["sig"]:
            file_pairs = cached[1]
            info["pair_hits"] += 1
        else:
            file_pairs, unmatched = pair_output(root, item, store)
            store.put_pairs(item["rel"], item["sig"], file_pairs)
            info["pair_misses"] += 1
            for key, value in unmatched.items():
                info[f"unmatched_{key}"] += value
        pairs.extend(file_pairs)
        store.commit()
    info["mode"] = "key"
    info["rows"] = len(pairs)
    return pairs, dict(info)


# --------------------------------------------------------------------------- clusters

def load_clusters(root: Path):
    taxonomy = {"stages": {}, "l2": {}, "patterns": {}, "mechanisms": {}, "tags": {}, "meta": {}, "runs": []}
    index = {}
    for tree_path in sorted(root.glob("*/eval_output/**/cluster/*/cluster_tree.json")):
        product = product_of(tree_path.relative_to(root).parts[0])
        model = tree_path.parent.name
        try:
            tree = json.loads(tree_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        meta = tree.get("meta") or {}
        if meta.get("generated_at", "") >= taxonomy["meta"].get("generated_at", ""):
            taxonomy["meta"] = {
                "version": meta.get("pipeline_version"), "generated_at": meta.get("generated_at"),
                "title": meta.get("title"), "unit": meta.get("unit"), "axes": meta.get("axes"),
                "counting": meta.get("counting"), "low_sample_threshold": meta.get("low_sample_threshold"),
            }
        taxonomy["runs"].append({
            "product": product, "model": model, "items": meta.get("total_items"),
            "sessions": meta.get("total_sessions"), "edge_rate": meta.get("edge_rate"),
        })

        def walk(node):
            level = node.get("level")
            if level == 1:
                taxonomy["stages"].setdefault(node["id"], {
                    "id": node["id"], "name": node.get("name"), "def": node.get("definition"),
                    "components": set(),
                })["components"].update(node.get("components") or [])
            elif level == 2:
                taxonomy["l2"].setdefault(node["id"], {
                    "id": node["id"], "name": node.get("name"), "mech": node.get("mechanism"),
                    "def": node.get("definition"),
                })
            elif level in (3, 4):
                taxonomy["patterns"].setdefault(node["id"], {
                    "id": node["id"], "name": node.get("name"), "plain": node.get("plain"),
                    "def": node.get("definition"), "include": node.get("include"),
                    "exclude": node.get("exclude"), "tags": node.get("tags") or [],
                })
            for child in node.get("children") or []:
                walk(child)

        walk(tree.get("tree") or {})
        for m in tree.get("mechanism_rollup") or []:
            taxonomy["mechanisms"].setdefault(m["mechanism"], {
                "id": m["mechanism"], "name": m.get("name"), "def": m.get("definition"),
            })
        for t in tree.get("tag_rollup") or []:
            taxonomy["tags"].setdefault(t["tag"], {"id": t["tag"], "name": t.get("name"), "def": t.get("definition")})

        items = tree_path.parent / "item_index.jsonl"
        if items.exists():
            with open(items, encoding="utf-8") as fh:
                for line in fh:
                    try:
                        it = json.loads(line)
                    except ValueError:
                        continue
                    entry = {"path": it.get("path"), "edge": bool(it.get("edge")), "tags": it.get("tags") or []}
                    for ident in (it.get("session_id"), it.get("trace_id"), it.get("case_id")):
                        if ident:
                            index.setdefault((product, model, ident, it.get("json_path"), it.get("label")), entry)
    for stage in taxonomy["stages"].values():
        stage["components"] = sorted(stage["components"])
    return taxonomy, index


# --------------------------------------------------------------------------- input normalisation

def kind_of(m: dict) -> str:
    t, role = m.get("type"), m.get("role")
    if t == "user_question":
        return "user"
    if t == "final_answer":
        return "answer"
    if t == "llm_turn":
        return "llm"
    if t in ("tool_call", "function_call"):
        return "call"
    if t in ("tool_result", "function_call_output"):
        return "result"
    if t == "reasoning":
        return "think"
    if role == "system":
        return "system"
    if role == "user":
        return "user"
    if role == "assistant":
        return "answer"
    return "other"


def content_blocks(content, base):
    if isinstance(content, str):
        return [(base, content, "text", None)]
    blocks = []
    for i, part in enumerate(content or []):
        if isinstance(part, dict) and isinstance(part.get("text"), str):
            blocks.append((f"{base}/{i}/text", part["text"], "text", None))
        elif isinstance(part, dict) and "image" in str(part.get("type", "")):
            blocks.append((f"{base}/{i}", "[图片]", "image", None))
        else:
            text, fmt = as_text(part)
            blocks.append((f"{base}/{i}", text, fmt, None))
    return blocks


def message_blocks(m: dict, kind: str):
    t = m.get("type")
    if t == "llm_turn":
        out = m.get("output")
        if isinstance(out, str):
            return [("/output", out, "text", None)]
        blocks = []
        for i, o in enumerate(out or []):
            if not isinstance(o, dict):
                text, fmt = as_text(o)
                blocks.append((f"/output/{i}", text, fmt, None))
                continue
            if o.get("reasoning_content"):
                blocks.append((f"/output/{i}/reasoning_content", str(o["reasoning_content"]), "text", "think"))
            c = o.get("content")
            if c:
                blocks += content_blocks(c, f"/output/{i}/content")
            for j, tc in enumerate(o.get("tool_calls") or []):
                fn = (tc or {}).get("function") or {}
                args = fn.get("arguments")
                text = args if isinstance(args, str) else as_text(args)[0]
                blocks.append((f"/output/{i}/tool_calls/{j}/function/arguments", text, "json", f"call:{fn.get('name') or '?'}"))
        return blocks
    if t == "tool_call":
        text, fmt = as_text(m.get("input"))
        return [("/input", text, fmt, None)]
    if t == "tool_result":
        out = m.get("output")
        if isinstance(out, list) and out and all(isinstance(x, dict) and isinstance(x.get("text"), str) for x in out):
            return content_blocks(out, "/output")
        text, fmt = as_text(out)
        return [("/output", text, fmt, None)]
    if t == "function_call":
        args = m.get("arguments")
        text = args if isinstance(args, str) else as_text(args)[0]
        return [("/arguments", text, "json", None)]
    if t == "function_call_output":
        out = m.get("output")
        if isinstance(out, list):
            return content_blocks(out, "/output")
        text, fmt = as_text(out)
        return [("/output", text, fmt, None)]
    if t == "reasoning":
        return content_blocks(m.get("summary") or [], "/summary")
    if "content" in m:
        return content_blocks(m.get("content"), "/content")
    text, fmt = as_text({k: v for k, v in m.items() if k not in ("input_messages",)})
    return [("", text, fmt, None)]


class Block:
    __slots__ = ("path", "text", "fmt", "label", "hits", "_loose")

    def __init__(self, path, text, fmt, label):
        self.path, self.fmt, self.label = path, fmt, label
        self.text = scrub_images(text or "")
        self.hits = []
        self._loose = None

    def loose(self):
        if self._loose is None:
            out, idx, space = [], [], False
            for i, ch in enumerate(self.text):
                if ch.isspace():
                    if not space:
                        out.append(" ")
                        idx.append(i)
                    space = True
                else:
                    out.append(ch)
                    idx.append(i)
                    space = False
            self._loose = ("".join(out), idx)
        return self._loose


def _find_exact(block, q):
    k = block.text.find(q)
    return (k, k + len(q)) if k >= 0 else None


def _find_variants(block, q):
    variants = []
    if "\\n" in q or '\\"' in q:
        variants.append(q.replace("\\n", "\n").replace('\\"', '"').replace("\\\\", "\\"))
    esc = json.dumps(q, ensure_ascii=False)[1:-1]
    if esc != q:
        variants.append(esc)
    for v in variants:
        r = _find_exact(block, v)
        if r:
            return r
    return None


def _find_loose(block, q):
    nq = " ".join(q.split())
    if len(nq) < 8:
        return None
    text, idx = block.loose()
    k = text.find(nq)
    if k < 0:
        return None
    return idx[k], idx[k + len(nq) - 1] + 1


def _find_line(block, q):
    lines = sorted({ln.strip() for ln in q.splitlines() if len(ln.strip()) >= 10}, key=len, reverse=True)
    for ln in lines[:6]:
        r = _find_exact(block, ln) or _find_variants(block, ln)
        if r:
            return r
    return None


def locate(blocks, path, quote):
    """Find ``quote`` inside one of a message's blocks → (block index, start, end, exact)."""
    q = (quote or "").strip()
    if not q or not blocks:
        return None
    path = path or ""
    related = [i for i, b in enumerate(blocks) if b.path and (path.startswith(b.path) or b.path.startswith(path))]
    order = related + [i for i in range(len(blocks)) if i not in related]
    for strategy, exact in ((_find_exact, True), (_find_variants, True), (_find_loose, True), (_find_line, False)):
        for i in order:
            r = strategy(blocks[i], q)
            if r:
                return i, r[0], r[1], exact
    return None


def trim_pieces(block: Block, limit: int):
    """Head plus windows around evidence hits; gaps carry the elided length."""
    text = block.text
    n = len(text)
    if n <= limit:
        return [text] if text else []
    keep = [(0, int(limit * 0.6))]
    for s, e in block.hits:
        keep.append((max(0, s - WINDOW_PAD), min(n, e + WINDOW_PAD)))
    keep.sort()
    merged = []
    for s, e in keep:
        if merged and s <= merged[-1][1] + 40:
            merged[-1][1] = max(merged[-1][1], e)
        else:
            merged.append([s, e])
    pieces, cursor = [], 0
    for s, e in merged:
        # Snap window edges to nearby line breaks so cuts land between lines.
        if s > 0:
            nl = text.rfind("\n", max(0, s - 60), s)
            s = nl + 1 if nl >= 0 else s
        if e < n:
            nl = text.find("\n", e, min(n, e + 60))
            e = nl if nl >= 0 else e
        s = max(s, cursor)
        if s > cursor:
            pieces.append({"g": s - cursor})
        if e > s:
            pieces.append(text[s:e])
        cursor = max(cursor, e)
    if cursor < n:
        pieces.append({"g": n - cursor})
    return pieces


# --------------------------------------------------------------------------- one sample

def worst_of(problems):
    for sev in SEVERITIES:
        if any(p.get("severity") == sev for p in problems):
            return sev
    return "none"


def session_question(inp, attr):
    meta = (attr.get("session_meta") or {})
    q = meta.get("question")
    if not q and inp:
        q = (inp.get("meta") or {}).get("question")
        if not q and inp.get("traces"):
            for m in inp["traces"][0].get("messages") or []:
                if m.get("type") == "user_question":
                    q = m.get("content")
                    break
    return decode_question(q)


def build_sample(pair, inp, attr, comp, clusters, stats):
    product, model = pair["product"], pair["model"]
    smeta = attr.get("session_meta") or {}
    sid = smeta.get("session_id") or smeta.get("thread_id") or ""
    tid = smeta.get("trace_id") or ""
    case = (inp or {}).get("case_id") or smeta.get("case_id") or ""

    # ---- input traces → messages with blocks
    if inp and inp.get("traces"):
        raw_traces = [(t.get("meta") or {}, t.get("messages") or []) for t in inp["traces"]]
    elif inp:
        raw_traces = [(inp.get("meta") or {}, inp.get("messages") or [])]
    else:
        raw_traces = []
    traces = []
    for tmeta, msgs in raw_traces:
        call_names = {}
        rows = []
        for m in msgs:
            if not isinstance(m, dict):
                m = {"type": "other", "content": m}
            kind = kind_of(m)
            name = m.get("name")
            if m.get("type") == "function_call":
                call_names[m.get("call_id")] = name
            if m.get("type") == "function_call_output":
                name = call_names.get(m.get("call_id"))
            blocks = [Block(*b) for b in message_blocks(m, kind)]
            rows.append({"raw": m, "kind": kind, "name": name, "blocks": blocks, "ev": []})
        traces.append((tmeta, rows))

    def place(t, mi, path, quote):
        if t is None or t >= len(traces) or mi is None or mi >= len(traces[t][1]):
            stats["ev_missing_msg"] += 1
            return None
        row = traces[t][1][mi]
        hit = locate(row["blocks"], path, quote)
        if not hit:
            stats["ev_unlocated"] += 1
            return {"t": t, "m": mi}
        bi, s, e, exact = hit
        row["blocks"][bi].hits.append((s, e))
        stats["ev_located" if exact else "ev_anchored"] += 1
        return {"t": t, "m": mi, "b": bi, "o": [s, e]}

    def place_global(idx, path, quote):
        """Compact evidence IDs index the flattened session transcript, not one trace."""
        for t, (_, rows) in enumerate(traces):
            if idx < len(rows):
                return place(t, idx, path, quote)
            idx -= len(rows)
        stats["ev_missing_msg"] += 1
        return None

    # ---- attribution
    evidence = []

    def add_evidence(item, loc, extra):
        eid = len(evidence)
        rec = {"q": clip(item.get("quote"), 900 if extra.get("src") == "attr" else 200)}
        rec.update(extra)
        if loc:
            rec.update(loc)
        evidence.append(rec)
        return eid

    problems = []

    def take_problem(p, json_path, turn):
        evs = []
        for ev in p.get("evidence") or []:
            pos = POSITION.search(ev.get("position") or "")
            loc = place(int(pos[1]), int(pos[2]), pos[3], ev.get("quote")) if pos else None
            if not pos:
                stats["ev_no_position"] += 1
            eid = add_evidence(ev, loc, {"r": ev.get("reason"), "c": ev.get("component"), "src": "attr"})
            evs.append(eid)
            if loc and "m" in loc:
                traces[loc["t"]][1][loc["m"]]["ev"].append(eid)
        cl = None
        for ident in (sid, tid, case):
            if ident:
                cl = clusters.get((product, model, ident, json_path, p.get("label")))
                if cl:
                    break
        sev = p.get("severity") if p.get("severity") in SEVERITIES else None
        problems.append({
            "id": len(problems), "turn": turn, "sev": sev, "label": p.get("label"),
            "def": p.get("definition"), "ph": p.get("problem_phenomena"), "why": p.get("reason"),
            "sevr": p.get("severity_reason"), "comp": p.get("component"), "fam": p.get("component_family"),
            "role": p.get("component_role"),
            "calc": [c.get("text") if isinstance(c, dict) else c for c in (p.get("calculations") or [])],
            "ev": evs,
            "cl": {"path": cl["path"], "edge": cl["edge"], "tags": cl["tags"]} if cl and cl.get("path") else None,
        })

    turns = []
    for ti, t in enumerate(attr.get("turns") or []):
        before = len(problems)
        for pi, p in enumerate(t.get("problem") or []):
            take_problem(p, f"turns[{ti}].problem[{pi}]", ti)
        tm = t.get("meta") or {}
        turns.append({
            "summary": t.get("summary"), "correct": t.get("is_correct"), "correct_reason": t.get("correct_reason"),
            "problems": list(range(before, len(problems))),
            "trace_id": tm.get("trace_id"), "agent": tm.get("name") or tm.get("agent_id"), "model": tm.get("model"),
        })
    session_problems = []
    for pi, p in enumerate(attr.get("session_problem") or []):
        take_problem(p, f"session_problem[{pi}]", None)
        session_problems.append(len(problems) - 1)

    # ---- compact
    compact = None
    if comp:
        def evrefs(items, turn):
            refs = []
            for ev in items or []:
                m = EVIDENCE_ID.match(ev.get("evidence_id") or "")
                loc = place_global(int(m[1]), ev.get("evidence_id", "").split("_", 6)[-1] if m else "", ev.get("quote")) if m else None
                eid = add_evidence(ev, loc, {"src": "compact"})
                refs.append(eid)
            return refs

        def steps(items, turn, content_key, extra=()):
            out = []
            for it in items or []:
                row = {"c": it.get(content_key), "ev": evrefs(it.get("evidence"), turn)}
                for k in extra:
                    if it.get(k) is not None:
                        row[k] = it.get(k)
                out.append(row)
            return out

        cturns = []
        for pos, ct in enumerate(comp.get("turns") or []):
            cturns.append({
                "turn": pos,
                "plans": steps(ct.get("plans"), pos, "content"),
                "reasoning": steps(ct.get("reasoning_chain"), pos, "content"),
                "execution": steps(ct.get("execution_chain"), pos, "content"),
                "reflections": steps(ct.get("reflections"), pos, "reflection_content"),
                "tool_errors": steps(ct.get("tool_errors"), pos, "tool_error_content"),
                "components": [
                    {"name": c.get("components_name"), "kind": c.get("components_kind"),
                     "c": c.get("components_content"), "ev": evrefs(c.get("evidence"), pos)}
                    for c in ct.get("components") or []
                ],
                "key_data": steps(ct.get("key_data"), pos, "key_data_content"),
                "artifacts": steps(ct.get("artifacts"), pos, "artifacts_content"),
            })
        compact = {"overview": comp.get("session_overview") or [], "turns": cturns}

    # ---- serialise messages (after every evidence hit is known)
    out_traces = []
    t0 = None
    for tmeta, rows in traces:
        for row in rows:
            for key in ("start", "timestamp"):
                v = ts_ms(row["raw"].get(key))
                if v is not None:
                    t0 = v if t0 is None else min(t0, v)
    for ti, (tmeta, rows) in enumerate(traces):
        msgs = []
        for mi, row in enumerate(rows):
            raw, kind = row["raw"], row["kind"]
            blocks = []
            for b in row["blocks"]:
                limit = BLOCK_LIMIT.get("think" if b.label == "think" else kind, 1600)
                blocks.append({
                    "p": b.path, "f": b.fmt, "l": b.label, "n": len(b.text),
                    "x": trim_pieces(b, limit),
                })
            msg = {"k": kind, "blocks": blocks}
            if row["name"]:
                msg["name"] = row["name"]
            if raw.get("model") and kind == "llm":
                msg["model"] = raw.get("model")
            start = ts_ms(raw.get("start")) or ts_ms(raw.get("timestamp"))
            end = ts_ms(raw.get("end"))
            if start is not None and t0 is not None:
                msg["at"] = round(start - t0)
            if raw.get("latency") is not None:
                msg["dur"] = round(float(raw["latency"]) * 1000)
            elif start is not None and end is not None:
                msg["dur"] = round(end - start)
            if row["ev"]:
                msg["ev"] = sorted(set(row["ev"]))
            msgs.append(msg)
        out_traces.append({
            "agent": tmeta.get("name") or tmeta.get("agent_id"), "model": tmeta.get("model"),
            "mode": tmeta.get("mode") or tmeta.get("runtime_mode"),
            "question_zh": tmeta.get("question_zh"), "task": tmeta.get("task"),
            "subtask": tmeta.get("subtask"), "difficulty": tmeta.get("difficulty"),
            "messages": msgs,
        })

    question = session_question(inp, attr)
    usage = smeta.get("usage") or {}
    kinds = Counter(row["kind"] for _, rows in traces for row in rows)
    tool_calls = kinds["call"]
    if not tool_calls:
        tool_calls = sum(
            len(o.get("tool_calls") or []) for _, rows in traces for row in rows if row["kind"] == "llm"
            for o in (row["raw"].get("output") or []) if isinstance(o, dict)
        )
    first_meta = raw_traces[0][0] if raw_traces else {}
    imeta = (inp or {}).get("meta") or {}
    detail = {
        "product": product, "split": pair["split"], "model": model, "date": pair["date"],
        "question": question, "question_zh": first_meta.get("question_zh"),
        "lang": lang_of(question),
        "ids": {"session": sid, "trace": tid, "case": case},
        "meta": {
            "version": (inp or {}).get("version"), "mode": smeta.get("agent_mode") or imeta.get("agent_mode"),
            "source": smeta.get("source") or imeta.get("source"), "skill": imeta.get("skill_name") or None,
            "comefrom": first_meta.get("comefrom") or imeta.get("comefrom"),
            "device": first_meta.get("device_type") or imeta.get("device_type"),
            "task": first_meta.get("task"), "subtask": first_meta.get("subtask"),
            "difficulty": first_meta.get("difficulty"),
            "request_time": smeta.get("request_time"),
            "tokens_in": usage.get("input_tokens"), "tokens_out": usage.get("output_tokens"),
            "first_token_ms": smeta.get("first_token_time_cost"),
            "finish_ms": smeta.get("finish_answer_time_cost"),
            "answer_len": smeta.get("answer_len"),
        },
        "input": {"traces": out_traces, "missing": inp is None},
        "attribution": {
            "summary": attr.get("session_summary"), "turns": turns,
            "session_problems": session_problems, "problems": problems,
        },
        "compact": compact,
        "evidence": evidence,
    }

    counts = Counter(p["sev"] for p in problems if p["sev"])
    row = {
        "q": clip(question, 160), "m": model, "sp": pair["split"], "d": pair["date"],
        "sid": sid or None, "tid": tid or None,
        "w": worst_of([{"severity": p["sev"]} for p in problems]),
        "n": len(problems), "sv": [counts.get(s, 0) for s in SEVERITIES],
        "r": sorted({p["role"] for p in problems if p["role"]}, key=lambda r: ROLE_ORDER.index(r) if r in ROLE_ORDER else 99),
        "st": sorted({p["cl"]["path"].split(".")[0] for p in problems if p["cl"]}, key=lambda s: STAGE_ORDER.index(s) if s in STAGE_ORDER else 99),
        "pt": sorted({p["cl"]["path"] for p in problems if p["cl"]}),
        "tg": sorted({tag for p in problems if p["cl"] for tag in p["cl"]["tags"]}),
        "lb": "｜".join(p["label"] or "" for p in problems)[:600],
        "tr": len(out_traces), "mc": sum(len(t["messages"]) for t in out_traces), "tc": tool_calls,
        "lang": detail["lang"],
    }
    for key, value in (("task", first_meta.get("task")), ("sub", first_meta.get("subtask")),
                       ("diff", first_meta.get("difficulty")),
                       ("skill", imeta.get("skill_name") or None), ("case", case if product == "wencai" else None)):
        if value:
            row[key] = value

    facts = {
        "messages": row["mc"], "tool_calls": tool_calls, "traces": row["tr"],
        "kinds": kinds, "tokens": (usage.get("input_tokens") or 0) + (usage.get("output_tokens") or 0),
        "finish_ms": smeta.get("finish_answer_time_cost"), "question_len": len(question),
        "mode": smeta.get("agent_mode") or imeta.get("agent_mode") or (inp or {}).get("version"),
        "comefrom": first_meta.get("comefrom") or imeta.get("comefrom"),
        "source": smeta.get("source") or imeta.get("source"),
        "has_visual": bool(smeta.get("has_visual") or imeta.get("has_visual")),
        "compact": compact,
        # A session is judged correct only when every attributed turn says so; None = not judged.
        "correct": (all(t["correct"] is True for t in turns)
                    if turns and all(t["correct"] is not None for t in turns) else None),
    }
    return detail, row, facts


# --------------------------------------------------------------------------- aggregation

def sev_counter():
    return {s: 0 for s in SEVERITIES}


def aggregate(product, samples, taxonomy):
    """``samples`` = list of (slug, detail, row, facts) for one product."""
    total = len(samples)
    models = [m for m in PRODUCTS[product]["models"] if any(s[2]["m"] == m for s in samples)]
    models += sorted({s[2]["m"] for s in samples} - set(models))
    splits = [sp for sp in ("daily", "lost") if any(s[2]["sp"] == sp for s in samples)]

    # 问财 has no task/subtask in the source; its scene is the skill the A versions
    # routed to; B versions take the skill recorded for the same question.
    scene = {}
    if product == "wencai":
        votes = defaultdict(Counter)
        for s in samples:
            if s[1]["meta"].get("skill"):
                votes[s[1]["question"]][s[1]["meta"]["skill"]] += 1
        scene = {q: c.most_common(1)[0][0] for q, c in votes.items()}

    severity, worst = sev_counter(), {k: 0 for k in WORST_KEYS}
    evidence_n = located = 0
    problems_all = []
    for slug, detail, row, facts in samples:
        worst[row["w"]] += 1
        for p in detail["attribution"]["problems"]:
            problems_all.append((slug, row, p))
            if p["sev"]:
                severity[p["sev"]] += 1
            evidence_n += len(p["ev"])
            located += sum(1 for e in p["ev"] if "o" in detail["evidence"][e])

    def group_stats(rows):
        sev, wst = sev_counter(), {k: 0 for k in WORST_KEYS}
        n_problems = 0
        for slug, detail, row, facts in rows:
            wst[row["w"]] += 1
            for s, c in zip(SEVERITIES, row["sv"]):
                sev[s] += c
            n_problems += row["n"]
        return {
            "sessions": len(rows), "problems": n_problems, "sev": sev, "worst": wst,
            "flagged": len(rows) - wst["none"],
            "tool_calls": round(sum(r[3]["tool_calls"] for r in rows) / len(rows), 1) if rows else 0,
            "messages": round(sum(r[3]["messages"] for r in rows) / len(rows), 1) if rows else 0,
            "correct": sum(1 for r in rows if r[3]["correct"] is True),
            "judged": sum(1 for r in rows if r[3]["correct"] is not None),
        }

    by_model = []
    for m in models:
        rows = [s for s in samples if s[2]["m"] == m]
        entry = {"id": m, "label": MODEL_LABEL.get(m, m), **group_stats(rows)}
        entry["splits"] = {sp: group_stats([s for s in rows if s[2]["sp"] == sp]) for sp in splits}
        by_model.append(entry)
    by_split = [{"id": sp, "label": SPLIT_LABEL[sp], **group_stats([s for s in samples if s[2]["sp"] == sp])} for sp in splits]

    # Component roles in pipeline order.
    roles = {}
    for slug, row, p in problems_all:
        r = p["role"] or "other"
        e = roles.setdefault(r, {"id": r, "label": ROLE_LABEL.get(r, r), "problems": 0, "sev": sev_counter(),
                                 "sessions": set(), "families": Counter(), "components": Counter()})
        e["problems"] += 1
        if p["sev"]:
            e["sev"][p["sev"]] += 1
        e["sessions"].add(slug)
        e["families"][p["fam"] or "—"] += 1
        e["components"][p["comp"] or "—"] += 1
    role_list = []
    for r in sorted(roles, key=lambda r: ROLE_ORDER.index(r) if r in ROLE_ORDER else 99):
        e = roles[r]
        role_list.append({
            "id": e["id"], "label": e["label"], "problems": e["problems"], "sev": e["sev"],
            "sessions": len(e["sessions"]),
            "families": [{"id": k, "n": v} for k, v in e["families"].most_common(6)],
            "components": [{"id": k, "n": v} for k, v in e["components"].most_common(4)],
        })

    # Cluster matrix (stage × mechanism), patterns and tags from this product's matched problems.
    matrix = defaultdict(lambda: defaultdict(lambda: {"n": 0, "sessions": set(), "sev": sev_counter()}))
    patterns = {}
    tags = {}
    clustered = 0
    for slug, row, p in problems_all:
        cl = p["cl"]
        if not cl:
            continue
        clustered += 1
        parts = cl["path"].split(".")
        stage = parts[0]
        mech = parts[1] if len(parts) > 1 else "?"
        cell = matrix[stage][mech]
        cell["n"] += 1
        cell["sessions"].add(slug)
        if p["sev"]:
            cell["sev"][p["sev"]] += 1
        pat = patterns.setdefault(cl["path"], {"id": cl["path"], "n": 0, "sessions": set(), "sev": sev_counter(),
                                               "models": Counter(), "examples": []})
        pat["n"] += 1
        pat["sessions"].add(slug)
        pat["models"][row["m"]] += 1
        if p["sev"]:
            pat["sev"][p["sev"]] += 1
        pat["examples"].append((SEVERITIES.index(p["sev"]) if p["sev"] else 9, slug, p["id"], p["label"],
                                row["m"], row["w"], clip(row["q"], 64)))
        for tag in cl["tags"]:
            t = tags.setdefault(tag, {"id": tag, "n": 0, "sessions": set(), "stages": Counter()})
            t["n"] += 1
            t["sessions"].add(slug)
            t["stages"][stage] += 1

    matrix_out = {
        stage: {mech: {"n": c["n"], "sessions": len(c["sessions"]), "sev": c["sev"]} for mech, c in mechs.items()}
        for stage, mechs in matrix.items()
    }
    pattern_list = []
    for pat in sorted(patterns.values(), key=lambda x: (-len(x["sessions"]), -x["n"], x["id"])):
        ex = sorted(pat["examples"])[:3]
        pattern_list.append({
            "id": pat["id"], "n": pat["n"], "sessions": len(pat["sessions"]), "sev": pat["sev"],
            "models": dict(pat["models"]),
            "examples": [{"slug": s, "p": pid, "label": lab, "model": m, "worst": w, "q": q} for _, s, pid, lab, m, w, q in ex],
        })
    tag_list = [
        {"id": t["id"], "n": t["n"], "sessions": len(t["sessions"]), "stages": dict(t["stages"].most_common(4))}
        for t in sorted(tags.values(), key=lambda x: -len(x["sessions"]))
    ]

    # 聚类矩阵: one entry per session that has clustered problems. The frontend pivots
    # these against the scenario tree (task → subtask) and the cluster tree
    # (stage → mechanism → pattern), so every drill state uses the same raw rows.
    cross = []
    for slug, detail, row, facts in samples:
        pats = Counter(p["cl"]["path"] for p in detail["attribution"]["problems"] if p["cl"])
        if not pats:
            continue
        m = detail["meta"]
        task = m.get("task") or m.get("skill") or scene.get(detail["question"]) or "未标注"
        cross.append([task, m.get("subtask") or "", [[pid, n] for pid, n in pats.most_common()]])

    # Input profile.
    msgs = [s[3]["messages"] for s in samples]
    calls = [s[3]["tool_calls"] for s in samples]
    qlen = [s[3]["question_len"] for s in samples]
    finish = [s[3]["finish_ms"] / 1000 for s in samples if isinstance(s[3]["finish_ms"], (int, float)) and s[3]["finish_ms"] > 0]
    tokens = [s[3]["tokens"] for s in samples if s[3]["tokens"]]
    kinds = Counter()
    for s in samples:
        kinds.update(s[3]["kinds"])
    lang = Counter(s[2]["lang"] for s in samples)
    trace_n = Counter(min(s[3]["traces"], 4) for s in samples)

    def top(counter, n=8, other="其他"):
        items = counter.most_common()
        head = [{"id": k, "n": v} for k, v in items[:n]]
        rest = sum(v for _, v in items[n:])
        if rest:
            head.append({"id": other, "n": rest, "rest": True})
        return head

    profile = {
        "messages": histogram(msgs, [0, 10, 20, 30, 40, 60, 80, 120]),
        "tool_calls": histogram(calls, [0, 1, 3, 5, 8, 12, 20, 30]),
        "question_len": histogram(qlen, [0, 10, 20, 40, 80, 160, 320]),
        "finish_s": histogram(finish, [0, 15, 30, 60, 120, 240, 480]) if finish else None,
        "tokens": histogram(tokens, [0, 10000, 30000, 60000, 120000, 250000, 500000]) if tokens else None,
        "median": {
            "messages": quantile(msgs, 0.5), "tool_calls": quantile(calls, 0.5), "question_len": quantile(qlen, 0.5),
            "finish_s": quantile(finish, 0.5), "tokens": quantile(tokens, 0.5),
        },
        "p90": {"messages": quantile(msgs, 0.9), "tool_calls": quantile(calls, 0.9), "finish_s": quantile(finish, 0.9)},
        "kinds": dict(kinds),
        "lang": dict(lang),
        "traces": {str(k): v for k, v in sorted(trace_n.items())},
        "visual": sum(1 for s in samples if s[3]["has_visual"]),
    }
    if product == "aime":
        profile["task"] = top(Counter(s[2].get("task") or "未标注" for s in samples), 9)
        profile["difficulty"] = dict(Counter(s[2].get("diff") or "未标注" for s in samples))
        profile["entry"] = top(Counter(s[3]["comefrom"] or "未知" for s in samples), 7)
    else:
        profile["skill"] = top(Counter(s[2].get("skill") or "未标注" for s in samples if s[2]["m"].startswith("a_")), 8)

    # Compact trajectory shape.
    comp_rows = [s[3]["compact"] for s in samples if s[3]["compact"]]

    def per_session(key):
        return [sum(len(t[key]) for t in c["turns"]) for c in comp_rows]

    comp_kinds, comp_names = Counter(), Counter()
    for c in comp_rows:
        for t in c["turns"]:
            for x in t["components"]:
                comp_kinds[x["kind"] or "—"] += 1
                comp_names[x["name"] or "—"] += 1
    compact_profile = {
        "sessions": len(comp_rows),
        "steps": {
            key: {"total": sum(v), "mean": round(sum(v) / len(v), 2) if v else 0, "with": sum(1 for x in v if x),
                  "hist": histogram(v, [0, 1, 2, 3, 4, 6, 8, 12])}
            for key in ("plans", "reasoning", "execution", "reflections", "tool_errors", "key_data", "artifacts", "components")
            for v in [per_session(key)]
        },
        "component_kinds": dict(comp_kinds.most_common()),
        "components": [{"id": k, "n": v} for k, v in comp_names.most_common(10)],
    }

    # Sessions per date, by split.
    daily = defaultdict(lambda: Counter())
    for s in samples:
        daily[s[2]["d"]][s[2]["sp"]] += 1
    dates = [{"d": d, **{sp: c.get(sp, 0) for sp in splits}} for d, c in sorted(daily.items())]

    # 数据量 drill-down: version → task → subtask.
    def task_tree(rows):
        tree = defaultdict(Counter)
        for s in rows:
            m = s[1]["meta"]
            tree[m.get("task") or m.get("skill") or scene.get(s[1]["question"]) or "未标注"][m.get("subtask") or ""] += 1
        return [
            {"id": t, "n": sum(c.values()), "sub": [{"id": k or "未标注", "n": v} for k, v in c.most_common()] if any(c) else []}
            for t, c in sorted(tree.items(), key=lambda kv: -sum(kv[1].values()))
        ]

    # The session field: one cell per session, grouped by model. AIME is read as one
    # product (daily + lost together); its lost users are counted as a marker, not split out.
    field = []
    order = {k: i for i, k in enumerate(WORST_KEYS)}
    unified = product == "aime"
    keys = [(None, m) for m in models] if unified else [(sp, m) for sp in splits for m in models]
    for sp, m in keys:
        group = [s for s in samples if s[2]["m"] == m and (sp is None or s[2]["sp"] == sp)]
        group.sort(key=lambda s: (order[s[2]["w"]], -s[2]["n"], s[2]["d"]))
        if group:
            field.append({
                "split": sp or "", "model": m,
                "lost": sum(1 for s in group if s[2]["sp"] == "lost"),
                "cells": [[s[0], order[s[2]["w"]], s[2]["n"], clip(s[2]["q"], 56), int(s[2]["sp"] == "lost")] for s in group],
                "roles": dict(Counter(p["role"] or "other" for s in group for p in s[1]["attribution"]["problems"])),
                "tree": task_tree(group),
            })

    unique_sessions = len({(s[2]["sp"], s[2]["m"], s[2]["sid"] or s[0]) for s in samples})
    out = {
        "label": PRODUCTS[product]["label"],
        "kpi": {
            "sessions": total, "unique_sessions": unique_sessions,
            "problems": len(problems_all), "flagged": total - worst["none"], "clean": worst["none"],
            "substantive": sum(severity[s] for s in SEVERITIES[:4]), "hints": severity["P4"],
            "evidence": evidence_n, "located": located,
            "clustered": clustered, "unclustered": len(problems_all) - clustered,
            "traces": sum(s[3]["traces"] for s in samples), "messages": sum(msgs), "tool_calls": sum(calls),
            "tokens": sum(tokens),
            "compacted": sum(1 for s in samples if s[3]["compact"]),
            "correct": sum(1 for s in samples if s[3]["correct"] is True),
            "judged": sum(1 for s in samples if s[3]["correct"] is not None),
        },
        "range": {"start": dates[0]["d"], "end": dates[-1]["d"]} if dates else None,
        "splits": [{"id": sp, "label": SPLIT_LABEL[sp]} for sp in splits],
        "unified": unified,
        "models": [{"id": m, "label": MODEL_LABEL.get(m, m)} for m in models],
        "severity": severity, "worst": worst,
        "by_model": by_model, "by_split": by_split,
        "roles": role_list,
        "matrix": matrix_out, "patterns": pattern_list, "tags": tag_list, "cross": cross,
        "profile": profile, "compact": compact_profile,
        "dates": dates, "field": field,
    }
    if product == "wencai":
        out["versions"] = version_compare(samples, models)
    return out


def version_compare(samples, models):
    """Questions answered by every version, so versions can be read against the same input."""
    by_case = defaultdict(dict)
    for slug, detail, row, facts in samples:
        if row.get("case"):
            by_case[row["case"]][row["m"]] = (slug, row)
    order = {k: i for i, k in enumerate(WORST_KEYS)}
    rows = []
    for case, versions in by_case.items():
        if not all(m in versions for m in models):
            continue
        any_row = next(iter(versions.values()))[1]
        cells = [[versions[m][0], order[versions[m][1]["w"]], versions[m][1]["n"]] for m in models]
        rows.append({"q": clip(any_row["q"], 80), "cells": cells})
    rows.sort(key=lambda r: (sum(c[1] for c in r["cells"]), -sum(c[2] for c in r["cells"])))
    summary = []
    for i, m in enumerate(models):
        worst = Counter(r["cells"][i][1] for r in rows)
        summary.append({"model": m, "worst": {WORST_KEYS[k]: worst.get(k, 0) for k in range(len(WORST_KEYS))},
                        "problems": sum(r["cells"][i][2] for r in rows)})
    return {"models": models, "rows": rows, "summary": summary}


def taxonomy_out(taxonomy, used_patterns):
    stages = []
    for sid in STAGE_ORDER + sorted(set(taxonomy["stages"]) - set(STAGE_ORDER)):
        st = taxonomy["stages"].get(sid)
        if st:
            stages.append({**st, "phase": STAGE_PHASE.get(sid, "execute")})
    mechs = [taxonomy["mechanisms"][k] for k in sorted(taxonomy["mechanisms"], key=lambda m: int(m[1:]) if m[1:].isdigit() else 99)]
    patterns = {}
    for pid, p in taxonomy["patterns"].items():
        entry = {"name": p["name"], "plain": p["plain"], "tags": p["tags"]}
        if pid in used_patterns:
            entry.update({"def": p["def"], "include": p["include"], "exclude": p["exclude"]})
        patterns[pid] = entry
    l2 = {k: {"name": v["name"], "mech": v["mech"]} for k, v in taxonomy["l2"].items()}
    return {
        "meta": taxonomy["meta"], "runs": taxonomy.get("runs", []), "phases": PHASES,
        "stages": stages, "mechanisms": mechs, "l2": l2, "patterns": patterns,
        "tags": list(taxonomy["tags"].values()),
        "roles": [{"id": r, "label": ROLE_LABEL[r]} for r in ROLE_ORDER],
    }


GOLDEN_LIMIT = 10


def golden_candidate(detail):
    """A mid-sized single-trace example, selected while the input is in memory."""
    traces = detail["input"]["traces"]
    if len(traces) != 1:
        return None
    n_msgs = len(traces[0]["messages"])
    probs = detail["attribution"]["problems"]
    if not (14 <= n_msgs <= 34) or not (3 <= len(probs) <= 5):
        return None
    located = sum(1 for p in probs for e in p["ev"] if "m" in detail["evidence"][e])
    score = len({p["sev"] for p in probs}) * 3 + len({p["role"] for p in probs}) * 2 + min(located, 14) / 2
    if detail["lang"] == "zh":
        score += 1.5
    msgs = traces[0]["messages"]
    return score, {
        "slug": detail["slug"], "product": detail["product"], "model": detail["model"],
        "date": detail["date"], "question": detail["question"],
        "messages": [
            {"k": m["k"], "name": m.get("name"), "dur": m.get("dur"),
             "text": clip(next((x for b in m["blocks"] for x in b["x"] if isinstance(x, str) and x.strip()), ""), 90)}
            for m in msgs
        ],
        "problems": [
            {"id": p["id"], "sev": p["sev"], "label": p["label"], "role": p["role"], "comp": p["comp"],
             "path": p["cl"]["path"] if p["cl"] else None,
             "msgs": sorted({detail["evidence"][e]["m"] for e in p["ev"] if "m" in detail["evidence"][e]})}
            for p in probs
        ],
    }


def golden_candidates(items, limit=GOLDEN_LIMIT):
    """Top-scoring cases, taking a new severity/role mix before repeats."""
    ordered = sorted(items, key=lambda x: x[0], reverse=True)
    seen, out = set(), []
    for _, case in ordered:
        key = (
            tuple(sorted({p["sev"] for p in case["problems"] if p["sev"]})),
            tuple(sorted({p["role"] for p in case["problems"] if p["role"]})),
        )
        if key in seen:
            continue
        seen.add(key)
        out.append(case)
        if len(out) >= limit:
            return out
    for _, case in ordered:
        if case not in out:
            out.append(case)
            if len(out) >= limit:
                break
    return out


def system_facts(all_samples, pool):
    """Real material for the 评测体系 page: severity examples and golden cases."""
    examples = {s: [] for s in SEVERITIES}
    ev_per_problem = Counter()
    ev_component = Counter()
    for slug, detail, row, facts in all_samples:
        for p in detail["attribution"]["problems"]:
            ev_per_problem[min(len(p["ev"]), 10)] += 1
            for e in p["ev"]:
                c = (detail["evidence"][e].get("c") or "").split(":")[0].strip() or "—"
                ev_component[c] += 1
            if p["sev"] and p["sevr"] and len(p["sevr"]) < 150 and len(p["label"] or "") < 26:
                examples[p["sev"]].append((len(p["sevr"]), slug, detail["product"], p["id"], p["label"], p["sevr"], p["comp"]))
    picked = {}
    for s, xs in examples.items():
        xs.sort()
        seen, out = set(), []
        for _, slug, product, pid, label, reason, comp in xs[len(xs) // 3:]:
            if label in seen or len(out) >= 3:
                continue
            seen.add(label)
            out.append({"slug": slug, "product": product, "p": pid, "label": label, "reason": reason, "comp": comp})
        picked[s] = out
    return {
        "severity_examples": picked,
        "evidence_per_problem": {str(k): v for k, v in sorted(ev_per_problem.items())},
        "evidence_component": [{"id": k, "n": v} for k, v in ev_component.most_common(6)],
        "goldens": {product: golden_candidates(items) for product, items in pool.items()},
    }


# --------------------------------------------------------------------------- write

def write_json(path: Path, payload, gz=True):
    data = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_bytes(data)
    os.replace(tmp, path)
    if gz:
        gz_path = Path(str(path) + ".gz")
        tmp = Path(str(gz_path) + ".tmp")
        tmp.write_bytes(gzip.compress(data, compresslevel=6, mtime=0))
        os.replace(tmp, gz_path)
    return len(data)


def empty_payloads(reason):
    now = iso_now()
    data = {"schema": 2, "generated_at": now, "source": {"mode": "empty", "reason": reason, "pairs": 0},
            "taxonomy": None, "system": None, "products": {}}
    index = {"schema": 2, "generated_at": now, "products": {}}
    return data, index


def slim_detail(detail):
    """Drop the parts of a sample that only the on-disk copy needs.

    The dashboard detail file is written before this runs; aggregates only need
    problem structure, evidence anchors and compact counts, not the transcript
    itself or the evidence quote strings.
    """
    detail["input"] = {"traces": [], "missing": detail["input"].get("missing", True)}
    evidence = []
    for e in detail["evidence"]:
        item = {}
        if e.get("c") is not None:
            item["c"] = e["c"]
        if "m" in e:
            item["m"] = e["m"]
        if "o" in e:
            item["o"] = True
        evidence.append(item)
    detail["evidence"] = evidence
    return detail


def cluster_signature(root: Path, cache_dir: Path | None = None):
    """Content fingerprint of the cluster inputs.

    mtime changes on a regenerated-but-identical item_index would otherwise
    invalidate every detail file; the content hash keeps the cache stable.
    A stat-based side cache avoids re-reading the 30 MB of cluster files when
    their sizes and mtimes did not change at all.
    """
    files = sorted(root.glob("*/eval_output/**/cluster/*/cluster_tree.json"))
    files += sorted(root.glob("*/eval_output/**/cluster/*/item_index.jsonl"))
    stat_parts = []
    for path in files:
        try:
            st = path.stat()
        except OSError:
            continue
        stat_parts.append([path.relative_to(root).as_posix(), st.st_size, st.st_mtime_ns])
    cache_path = (cache_dir / "cluster-signature.json") if cache_dir else None
    if cache_path:
        try:
            cached = json.loads(cache_path.read_text(encoding="utf-8"))
            if cached.get("stats") == stat_parts and cached.get("sig"):
                return cached["sig"]
        except (OSError, ValueError):
            pass
    parts = []
    for entry in stat_parts:
        path = root / entry[0]
        try:
            with open(path, "rb", buffering=0) as fh:
                head = fh.read(65536)
                fh.seek(max(0, entry[1] - 65536))
                tail = fh.read(65536)
            digest = hashlib.sha1(head + b"\0" + tail).hexdigest()
        except OSError:
            continue
        parts.append([entry[0], digest])
    sig = hashlib.sha1(json.dumps(parts, separators=(",", ":")).encode()).hexdigest()
    if cache_path:
        try:
            cache_path.write_text(json.dumps({"stats": stat_parts, "sig": sig},
                                             separators=(",", ":")), encoding="utf-8")
        except OSError:
            pass
    return sig


def load_clusters_cached(root: Path, sig: str, cache_dir: Path):
    path = cache_dir / f"clusters-v{CLUSTER_INDEX_VERSION}-{sig[:16]}.pkl"
    try:
        with open(path, "rb") as fh:
            return pickle.load(fh)
    except (OSError, EOFError, pickle.PickleError):
        pass
    taxonomy, index = load_clusters(root)
    cache_dir.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with open(tmp, "wb") as fh:
        pickle.dump((taxonomy, index), fh, protocol=pickle.HIGHEST_PROTOCOL)
    os.replace(tmp, path)
    for old in cache_dir.glob("clusters-*.pkl"):
        if old != path:
            old.unlink(missing_ok=True)
    return taxonomy, index


def assign_slugs(pairs):
    """Assign the short detail filename; the raw output hash keeps it stable."""
    seen = {}
    for pair in pairs:
        oh = pair.get("oh")
        if not oh:
            continue
        slug = oh[:10]
        while slug in seen and seen[slug] != oh:
            slug = hashlib.sha256(slug.encode()).hexdigest()[:10]
        seen[slug] = oh
        pair["_slug"] = slug


def sample_fingerprint(pair, cluster_sig=None):
    """Fingerprint the source rows, not the cluster mapping.

    Cluster content changes are handled by remapping cached summaries (and by
    the lazy detail builder), so they must not invalidate every sample.
    """
    def ref(value):
        # Cached pairs round-trip through JSON as lists; format both forms alike.
        return f"{value[0]}:{value[1]}" if value else ""
    values = [
        bs.BUILD_VERSION, pair.get("oh") or "", pair.get("ih") or "",
        pair.get("ch") or "", ref(pair.get("input")), ref(pair.get("compact")),
    ]
    return hashlib.sha1("\x1f".join(values).encode()).hexdigest()


def _problem_path(brief, problem):
    turn = problem.get("turn")
    if turn is None:
        ids = brief["attribution"].get("session_problems") or []
        try:
            return f"session_problem[{ids.index(problem['id'])}]"
        except ValueError:
            return ""
    try:
        pos = brief["attribution"]["turns"][turn]["problems"].index(problem["id"])
    except (IndexError, KeyError, ValueError):
        return ""
    return f"turns[{turn}].problem[{pos}]"


def remap_clusters(brief, row, cluster_index):
    """Reapply the current cluster mapping to a cached compact summary."""
    product, model = brief.get("product"), brief.get("model")
    ids = brief.get("ids") or {}
    paths, stages, tags = set(), set(), set()
    for problem in brief["attribution"]["problems"]:
        path = _problem_path(brief, problem)
        found = None
        if path:
            for ident in (ids.get("session"), ids.get("trace"), ids.get("case")):
                if ident:
                    found = cluster_index.get((product, model, ident, path, problem.get("label")))
                    if found:
                        break
        problem["cl"] = ({"path": found["path"], "edge": found["edge"], "tags": found["tags"]}
                         if found and found.get("path") else None)
        if problem["cl"]:
            paths.add(problem["cl"]["path"])
            stages.add(problem["cl"]["path"].split(".")[0])
            tags.update(problem["cl"]["tags"] or [])
    row["st"] = sorted(stages, key=lambda s: STAGE_ORDER.index(s) if s in STAGE_ORDER else 99)
    row["pt"] = sorted(paths)
    row["tg"] = sorted(tags)
    return brief, row


def remap_golden(golden, brief):
    if not golden or not golden.get("case"):
        return golden
    by_id = {p["id"]: p for p in brief["attribution"]["problems"]}
    for problem in golden["case"].get("problems") or []:
        current = by_id.get(problem.get("id"))
        problem["path"] = (current["cl"]["path"] if current and current.get("cl") else None)
    return golden


def ensure_detail_gz(path: Path):
    gz = Path(str(path) + ".gz")
    try:
        if gz.stat().st_mtime >= path.stat().st_mtime:
            return
    except OSError:
        pass
    tmp = Path(str(gz) + ".tmp")
    tmp.write_bytes(gzip.compress(path.read_bytes(), compresslevel=6, mtime=0))
    os.replace(tmp, gz)


_WORKER = {}


def _init_sample_worker(ctx):
    _WORKER.clear()
    _WORKER.update(ctx)


def _sample_batch(task):
    """Build one input-file group (or the no-input groups) in a worker process."""
    rel, pairs = task
    ctx = _WORKER
    root = Path(ctx["root"])
    out_dir = Path(ctx["out_dir"])
    sample_dir = out_dir / "samples"
    cluster_index = ctx["cluster_index"]
    cluster_sig = ctx["cluster_sig"]
    store = bs.BuildStore(ctx["store"], readonly=True)
    reader = LineReader(root, store)
    indexes = {}
    results = []

    def file_index(name):
        index = indexes.get(name)
        if index is None:
            index = store.get_file(name)
            indexes[name] = index
        return index

    def one(pair, inp):
        slug = pair["_slug"]
        fp = pair.get("_fp") or sample_fingerprint(pair, cluster_sig)
        try:
            out_name, out_line = pair["output"]
            out_index = file_index(out_name)
            raw_out = reader.raw_line(out_name, out_line, out_index) if out_index else reader.line(out_name, out_line)
            attr = json.loads(raw_out)
        except (OSError, IndexError, ValueError) as exc:
            return {"error": f"bad output: {exc}", "pair": pair["output"]}
        comp, bad_compact = None, 0
        if pair.get("compact"):
            name, number = pair["compact"]
            index = file_index(name)
            if index is None:
                bad_compact = 1
            else:
                try:
                    comp = json.loads(reader.raw_line(name, number, index))
                except (OSError, IndexError, ValueError):
                    bad_compact = 1
        try:
            detail, row, facts = build_sample(pair, inp, attr, comp, cluster_index, Counter())
            detail["slug"] = row["s"] = slug
            candidate = golden_candidate(detail)
            golden = {"score": candidate[0], "case": candidate[1]} if candidate else None
            brief = slim_detail(detail)
        except Exception as exc:  # noqa: BLE001 - one bad row must not kill the batch
            return {"error": f"build: {exc}", "pair": pair["output"]}
        return {
            "slug": slug, "fp": fp, "oh": pair.get("oh"), "ih": pair.get("ih"), "ch": pair.get("ch"),
            "product": pair["product"], "model": pair["model"], "date": pair["date"],
            "split": pair["split"], "output": pair["output"][0], "output_line": pair["output"][1],
            "row": row, "facts": facts, "brief": brief, "golden": golden,
            "refs": {"input": pair.get("input"), "compact": pair.get("compact")},
            "detail_bytes": 0,
            "missing_input": int(pair.get("input") is not None and inp is None),
            "missing_compact": int(comp is None and pair.get("compact") is not None),
            "bad_compact": bad_compact,
        }

    try:
        if rel is None:
            for pair in pairs:
                results.append(one(pair, None))
        else:
            index = store.get_file(rel)
            if index is None:
                return [{"error": f"missing input index {rel}", "pair": p["output"]} for p in pairs]
            line_pairs = defaultdict(list)
            for pair in pairs:
                line_pairs[pair["input"][1]].append(pair)
            for number, raw in reader.iter_input(rel, line_pairs, index):
                try:
                    inp = json.loads(raw)
                except ValueError:
                    inp = None
                for pair in line_pairs[number]:
                    results.append(one(pair, inp))
    finally:
        reader.close()
        store.close()
    return results


SAMPLE_CACHE_VERSION = 1


def load_sample_pickle(path: Path):
    try:
        with open(path, "rb") as fh:
            data = pickle.load(fh)
    except (OSError, EOFError, pickle.PickleError, ValueError):
        return {}
    if data.get("version") != SAMPLE_CACHE_VERSION or data.get("build") != bs.BUILD_VERSION:
        return {}
    return data.get("rows") or {}


def write_sample_pickle(path: Path, rows):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with open(tmp, "wb") as fh:
        pickle.dump({"version": SAMPLE_CACHE_VERSION, "build": bs.BUILD_VERSION, "rows": rows},
                    fh, protocol=5)
    os.replace(tmp, path)


def build_samples(pairs, root, out_dir, store, reader, cluster_index, cluster_sig, log=print,
                  jobs: int = 0):
    """Reuse unchanged details; build misses in parallel across input files."""
    stats = Counter()
    stats["sample_hits"] = stats["sample_built"] = 0
    samples = defaultdict(list)
    golden_pool = defaultdict(list)
    sample_dir = out_dir / "samples"
    sample_dir.mkdir(parents=True, exist_ok=True)

    for pair in pairs:
        if not pair.get("oh"):
            raw_out = reader.line(*pair["output"])
            pair["oh"] = hashlib.sha256(raw_out).hexdigest()
    assign_slugs(pairs)
    slugs = [p["_slug"] for p in pairs if p.get("_slug")]
    # A 16k-brief JSON decode costs 15–35 s.  The pickle is validated against
    # the light SQLite columns (fp/oh/ih/ch), so a stale file can only cost a
    # fallback load, never a wrong hit.
    cache_path = out_dir.parent / "cache" / "samples.pkl"
    pickled = load_sample_pickle(cache_path)
    meta = store.sample_meta(slugs)
    cached, need = {}, []
    for slug, info in meta.items():
        entry = pickled.get(slug)
        if (entry and entry.get("fp") == info["fp"] and entry.get("oh") == info["oh"]
                and entry.get("ih") == info["ih"] and entry.get("ch") == info["ch"]
                and entry.get("product") == info["product"] and entry.get("model") == info["model"]
                and entry.get("date") == info["date"] and entry.get("split") == info["split"]):
            cached[slug] = entry
        else:
            need.append(slug)
    if need:
        cached.update(store.load_samples(need))
    hits, misses = [], []
    for pair in pairs:
        fp = sample_fingerprint(pair, cluster_sig)
        pair["_fp"] = fp
        hit = cached.get(pair["_slug"])
        if hit and hit["fp"] == fp and hit["oh"] == pair.get("oh"):
            hits.append((pair, hit))
        else:
            misses.append(pair)

    detail_bytes = 0

    def add_sample(pair, brief, row, facts, golden):
        nonlocal detail_bytes
        slug = pair.get("_slug") or pair.get("slug")
        if golden:
            golden_pool[pair["product"]].append((golden["score"], golden["case"]))
        samples[pair["product"]].append((slug, brief, row, facts))
        stats["details"] += 1

    for pair, hit in hits:
        if not hit.get("refs"):
            # Older cache rows predate on-demand details; backfill the refs once.
            hit["refs"] = {"input": pair.get("input"), "compact": pair.get("compact")}
            store.put_sample({
                "slug": pair["_slug"], "fp": hit["fp"], "oh": hit["oh"],
                "ih": hit["ih"], "ch": hit["ch"], "product": pair["product"],
                "model": pair["model"], "date": pair["date"], "split": pair["split"],
                "output": pair["output"][0], "output_line": pair["output"][1],
                "refs": hit["refs"],
                "row": hit["row"], "facts": hit["facts"], "brief": hit["brief"],
                "golden": hit["golden"],
            })
        brief, row = remap_clusters(hit["brief"], hit["row"], cluster_index)
        golden = remap_golden(hit["golden"], brief)
        add_sample(pair, brief, row, hit["facts"], golden)
        stats["sample_hits"] += 1

    if misses:
        # A changed sample must not keep serving the previous transcript.
        for pair in misses:
            stale = sample_dir / f"{pair['_slug']}.json"
            stale.unlink(missing_ok=True)
            Path(str(stale) + ".gz").unlink(missing_ok=True)
        by_input = defaultdict(list)
        no_input = []
        for pair in misses:
            if pair.get("input"):
                by_input[pair["input"][0]].append(pair)
            else:
                no_input.append(pair)
        tasks = list(by_input.items())
        if no_input:
            tasks.append((None, no_input))
        workers = jobs or min(4, os.cpu_count() or 1)
        batches = None
        if workers > 1 and len(misses) >= 128 and len(tasks) > 1:
            ctx = {
                "root": str(root), "out_dir": str(out_dir), "store": str(store.path),
                "cluster_sig": cluster_sig, "cluster_index": cluster_index,
            }
            _WORKER.clear()
            _WORKER.update(ctx)
            try:
                mp = multiprocessing.get_context("fork")
                with ProcessPoolExecutor(max_workers=workers, mp_context=mp,
                                         initializer=_init_sample_worker, initargs=(ctx,)) as pool:
                    batches = list(pool.map(_sample_batch, tasks))
            except Exception as exc:  # noqa: BLE001 - fall back to the serial path
                debug(f"sample pool failed, falling back: {exc}")
                batches = None
        if batches is None:
            ctx = {
                "root": str(root), "out_dir": str(out_dir), "store": str(store.path),
                "cluster_sig": cluster_sig, "cluster_index": cluster_index,
            }
            _WORKER.clear()
            _WORKER.update(ctx)
            batches = [_sample_batch(task) for task in tasks]

        merged = 0
        for batch in batches:
            for item in batch:
                if item.get("error"):
                    stats["sample_error"] += 1
                    debug(f"skip sample {item.get('pair')}: {item['error']}")
                    continue
                entry = {
                    "slug": item["slug"], "fp": item["fp"], "oh": item["oh"],
                    "ih": item["ih"], "ch": item["ch"], "product": item["product"],
                    "model": item["model"], "date": item["date"], "split": item["split"],
                    "output": item["output"], "output_line": item["output_line"],
                    "row": item["row"], "facts": item["facts"], "brief": item["brief"],
                    "golden": item["golden"], "refs": item["refs"],
                }
                store.put_sample(entry)
                cached[item["slug"]] = entry
                add_sample(item, item["brief"], item["row"], item["facts"], item["golden"])
                stats["sample_built"] += 1
                stats["missing_input"] += item["missing_input"]
                stats["missing_compact"] += item["missing_compact"]
                stats["bad_compact"] += item["bad_compact"]
                detail_bytes += item["detail_bytes"]
                merged += 1
                if merged % 200 == 0:
                    store.commit()
                    debug(f"merged {merged} samples")

    try:
        write_sample_pickle(cache_path, cached)
    except OSError as exc:
        debug(f"sample cache write failed: {exc}")

    evidence = Counter()
    for rows in samples.values():
        for _, brief, _, _ in rows:
            for item in brief["evidence"]:
                evidence["ev_total"] += 1
                if "o" in item:
                    evidence["ev_located_brief"] += 1
    stats.update(evidence)
    stats["details_mb"] = round(detail_bytes / 1e6, 1)
    debug(f"built samples {sum(len(v) for v in samples.values())}, "
          f"hits={stats['sample_hits']} built={stats['sample_built']}")
    return samples, golden_pool, stats


def cleanup_samples(sample_dir: Path, slugs):
    keep = {f"{slug}.json" for slug in slugs}
    keep |= {f"{name}.gz" for name in keep}
    if not sample_dir.exists():
        return
    for path in sample_dir.iterdir():
        if path.name in keep:
            continue
        if path.is_file():
            path.unlink(missing_ok=True)
        elif path.is_dir():
            shutil.rmtree(path, ignore_errors=True)


def payload_files_exist(out_dir: Path) -> bool:
    try:
        data = json.loads((out_dir / "data.json").read_text(encoding="utf-8"))
        samples = json.loads((out_dir / "samples.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return False
    return (all((out_dir / f"data-{p}.json").exists() for p in (data.get("products") or {}))
            and all((out_dir / f"samples-{p}.json").exists() for p in (samples.get("products") or {})))


FORECAST_DIR = "4_forecast"


def prediction_feed_path(datasets: Path, product: str):
    """``4_forecast/<product>/prediction.json``, else the older ``<n>_<product>/prediction.json``."""
    path = datasets / FORECAST_DIR / product / "prediction.json"
    if path.is_file():
        return path
    top = next((p for p in datasets.glob("*") if product_of(p.name) == product), None)
    legacy = top / "prediction.json" if top else None
    return legacy if legacy and legacy.is_file() else None


def prediction_payload(feed: dict) -> dict:
    """Only what the 预测体系 card reads.

    The forecast export carries its own question bank in ``summary``: the
    questions it scanned, the forecast questions it could not verify yet and
    the batch dates covered.  The card counts against that bank, because the
    forecast batches need not be the dates the attribution side has evaluated.
    Explicit ``bank`` / ``unverifiable`` / ``dates`` fields win over ``summary``.
    """
    out = {}
    if feed.get("as_of") is not None:
        out["as_of"] = feed["as_of"]
    if isinstance(feed.get("questions"), list):
        out["questions"] = [{"id": q.get("id"), "answer_at": q.get("answer_at")}
                            for q in feed["questions"] if isinstance(q, dict)]
    if isinstance(feed.get("accuracy"), list):
        out["accuracy"] = feed["accuracy"]
    attribution = feed.get("attribution")
    if isinstance(attribution, dict):
        out["attribution"] = {k: attribution[k] for k in ("models", "errors", "flows") if k in attribution}
    summary = feed.get("summary") if isinstance(feed.get("summary"), dict) else {}
    by_status = summary.get("by_status") or {}
    bank = feed.get("bank", summary.get("extracted_questions"))
    if isinstance(bank, int):
        out["bank"] = bank
    unverifiable = feed.get("unverifiable")
    if unverifiable is None and by_status:
        # 回填未完成 is neither revealed nor pending: it waits with the unverifiable ones.
        unverifiable = int(by_status.get("unverifiable") or 0) + int(by_status.get("unresolved") or 0)
    if isinstance(unverifiable, int):
        out["unverifiable"] = unverifiable
    dates = feed.get("dates") or sorted(summary.get("by_batch") or {})
    if dates:
        out["dates"] = [str(d) for d in dates]
    return out


def feed_signature(datasets: Path):
    """Cheap fingerprint of optional prediction feeds, part of the reuse marker."""
    parts = []
    feeds = list(datasets.glob("*/prediction.json")) + list(datasets.glob(f"{FORECAST_DIR}/*/prediction.json"))
    for path in sorted(feeds):
        try:
            stat = path.stat()
        except OSError:
            continue
        parts.append([path.relative_to(datasets).as_posix(), stat.st_size, stat.st_mtime_ns])
    return hashlib.sha1(json.dumps(parts, separators=(",", ":")).encode()).hexdigest()


def build(datasets: Path, out_dir: Path, pairing: str = "auto", log=print, jobs: int = 0):
    started = time.time()
    if not datasets.is_dir():
        return empty_payloads("missing"), {}
    store = bs.BuildStore(out_dir.parent / "cache" / "build.sqlite3")
    reader = LineReader(datasets, store)
    timers, scan_info = {}, {}
    try:
        out_dir.mkdir(parents=True, exist_ok=True)
        t0 = time.time()
        sidecar = load_stats_sidecar(datasets)
        product_metas = {}
        for top in sorted(p for p in datasets.glob("*") if p.is_dir()):
            product = product_of(top.name)
            if not product:
                continue
            side_files = None
            if sidecar:
                side_files = (sidecar.get("products") or {}).get(product, {}).get("files")
            metas, info = scan_inputs(datasets, top, product, store, jobs, side_files)
            product_metas[product] = metas
            scan_info[product] = info
        timers["scan"] = round(time.time() - t0, 1)

        t0 = time.time()
        if pairing in ("auto", "csv") and (datasets / "对应关系.csv").exists():
            pairs, pairing_info = pairs_from_csv(datasets, store, reader)
        else:
            pairs, pairing_info = pairs_from_keys(datasets, store)
        timers["pair"] = round(time.time() - t0, 1)
        if not pairs:
            return empty_payloads("no-pairs"), {}
        debug(f"paired {len(pairs)} rows")

        t0 = time.time()
        cluster_sig = cluster_signature(datasets, out_dir.parent / "cache")
        pairs_sig = hashlib.sha1("\x1f".join(p.get("oh") or "" for p in pairs).encode()).hexdigest()
        feed_sig = feed_signature(datasets)
        scanned = sum(v["scanned"] for v in scan_info.values())
        marker = store.get_meta("complete")
        if (pairing_info.get("mode") == "key" and scanned == 0
                and pairing_info.get("pair_misses", 0) == 0 and marker
                and marker.get("build") == bs.BUILD_VERSION
                and marker.get("payload") == PAYLOAD_VERSION
                and marker.get("pairs_sig") == pairs_sig
                and marker.get("cluster") == cluster_sig
                and marker.get("feed") == feed_sig
                and (out_dir / "data.json").exists() and (out_dir / "samples.json").exists()
                and (out_dir / "samples").is_dir() and payload_files_exist(out_dir)):
            timers["cluster"] = round(time.time() - t0, 1)
            timers["samples"] = 0.0
            timers["aggregate"] = 0.0
            timers["write"] = 0.0
            summary = Counter({
                "pairs": len(pairs), "pairing": pairing_info.get("mode"), "reused": 1,
                "scan_files": sum(v["files"] for v in scan_info.values()),
                "scan_scanned": 0, "scan_cached": sum(v["cached"] for v in scan_info.values()),
                **{f"t_{k}": v for k, v in timers.items()},
                "seconds": round(time.time() - started, 1),
            })
            return (None, None), summary

        taxonomy, cluster_index = load_clusters_cached(datasets, cluster_sig, out_dir.parent / "cache")
        timers["cluster"] = round(time.time() - t0, 1)

        t0 = time.time()
        samples, golden_pool, stats = build_samples(
            pairs, datasets, out_dir, store, reader, cluster_index, cluster_sig, log, jobs)
        timers["samples"] = round(time.time() - t0, 1)

        t0 = time.time()
        all_samples = [s for rows in samples.values() for s in rows]
        used_patterns = {p["cl"]["path"] for _, d, _, _ in all_samples
                         for p in d["attribution"]["problems"] if p["cl"]}
        products = {}
        for product in PRODUCTS:
            if samples.get(product):
                products[product] = aggregate(product, samples[product], taxonomy)
        for product, metas in product_metas.items():
            if product not in products:
                continue
            payload = input_payload(metas)
            products[product]["input"] = payload
            products[product]["kpi"]["inputs"] = payload["records"]
            products[product]["kpi"]["lost"] = payload["lost"]
            products[product]["daily"] = daily_payload(samples[product], daily_inputs(metas))
            feed = prediction_feed_path(datasets, product)
            if feed:
                try:
                    data = json.loads(feed.read_text(encoding="utf-8"))
                except (OSError, ValueError) as exc:
                    log(f"[build] skip {feed}: {exc}")
                else:
                    if isinstance(data, dict):
                        products[product]["prediction"] = prediction_payload(data)
        timers["aggregate"] = round(time.time() - t0, 1)

        generated = iso_now()
        shared = {
            "schema": 2, "generated_at": generated,
            "source": {
                **pairing_info, "pairs": len(pairs), "root": datasets.name,
                "cache": {
                    "pair_hits": pairing_info.get("pair_hits", 0),
                    "pair_misses": pairing_info.get("pair_misses", 0),
                    "sample_hits": stats["sample_hits"], "sample_built": stats["sample_built"],
                    **{f"input_{k}": v for k, v in scan_info.items()},
                },
                "timings": timers,
            },
            "taxonomy": taxonomy_out(taxonomy, used_patterns) if taxonomy["stages"] else None,
            "system": system_facts(all_samples, golden_pool),
            "products": {product: {"label": PRODUCTS[product]["label"]} for product in products},
        }
        available = [product for product in PRODUCTS if product in samples]
        indexes = {}
        for product, rows in samples.items():
            rows_sorted = sorted(rows, key=lambda s: (WORST_KEYS.index(s[2]["w"]), -s[2]["n"], s[2]["d"]))
            indexes[product] = {
                "schema": 2, "generated_at": generated, "product": product,
                "available": available,
                "products": {product: {
                    "label": PRODUCTS[product]["label"],
                    "models": [{"id": m["id"], "label": m["label"]} for m in products[product]["models"]],
                    "splits": products[product]["splits"],
                    "rows": [{k: s[2][k] for k in INDEX_FIELDS if k in s[2]} for s in rows_sorted],
                }},
            }
        index = {
            "schema": 2, "generated_at": generated,
            "products": {
                product: {
                    "label": PRODUCTS[product]["label"],
                    "rows": len(samples[product]),
                    "url": f"samples-{product}.json",
                }
                for product in available
            },
        }

        t0 = time.time()
        data_bytes = 0
        for product, payload in products.items():
            data_bytes += write_json(out_dir / f"data-{product}.json", {
                "schema": 2, "generated_at": generated, "product": product,
                "products": {product: payload},
            })
        data_bytes += write_json(out_dir / "data.json", shared)
        for stale in out_dir.glob("data-*.json*"):
            product = stale.name[len("data-"):].split(".", 1)[0]
            if product not in products:
                stale.unlink(missing_ok=True)
        index_bytes = write_json(out_dir / "samples.json", index)
        for product, payload in indexes.items():
            index_bytes += write_json(out_dir / f"samples-{product}.json", payload)
        for stale in out_dir.glob("samples-*.json*"):
            product = stale.name[len("samples-"):].split(".", 1)[0]
            if product not in indexes:
                stale.unlink(missing_ok=True)
        timers["write"] = round(time.time() - t0, 1)

        slugs = [s[0] for rows in samples.values() for s in rows]
        cleanup_samples(out_dir / "samples", slugs)
        for stale in out_dir.glob(".samples-*"):
            shutil.rmtree(stale, ignore_errors=True)
        store.delete_samples_not(slugs)
        store.set_meta("complete", {
            "build": bs.BUILD_VERSION, "payload": PAYLOAD_VERSION, "pairs": len(pairs),
            "pairs_sig": pairs_sig, "cluster": cluster_sig, "feed": feed_sig, "at": generated,
        })
        store.commit()

        summary = Counter(stats)
        summary.update({
            "pairs": len(pairs), "data_kb": round(data_bytes / 1024),
            "index_kb": round(index_bytes / 1024),
            "scan_files": sum(v["files"] for v in scan_info.values()),
            "scan_scanned": sum(v["scanned"] for v in scan_info.values()),
            "scan_cached": sum(v["cached"] for v in scan_info.values()),
            **{f"t_{k}": v for k, v in timers.items()},
            "seconds": round(time.time() - started, 1),
        })
        return (shared, index), summary
    finally:
        reader.close()
        store.close()


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--datasets", type=Path,
                    default=None, help="datasets root (default: EVAL_DATASETS, the production mount, or <repo>/datasets)")
    ap.add_argument("--out", type=Path, default=STATIC, help="static directory receiving the payloads")
    ap.add_argument("--pairing", choices=("auto", "csv", "key"), default="auto")
    ap.add_argument("--keep-on-empty", action="store_true",
                    help="leave the previous payloads in place when the source yields no pairs "
                         "(used by the server's scheduled refresh so a briefly empty mount cannot wipe the board)")
    ap.add_argument("--jobs", type=int, default=0,
                    help="parallel input-file scans (default: auto, up to 4; 1 disables)")
    args = ap.parse_args(argv)
    args.datasets = args.datasets or default_datasets()

    (data, index), stats = build(args.datasets.resolve(), args.out, args.pairing, jobs=args.jobs)
    out = args.out
    if data is None and index is None:
        print(json.dumps(stats, ensure_ascii=False))
        return 0
    if args.keep_on_empty and not stats.get("details"):
        try:
            previous = json.loads((out / "data.json").read_text(encoding="utf-8"))["source"].get("pairs", 0)
        except (OSError, ValueError, KeyError, TypeError):
            previous = 0
        if previous:
            print(json.dumps({"pairs": 0, "kept_previous": previous, "root": str(args.datasets)}, ensure_ascii=False))
            return 0
    if not stats.get("details"):
        # An explicit build with no samples must not leave previous detail files behind.
        sample_dir = out / "samples"
        if sample_dir.exists():
            shutil.rmtree(sample_dir)
        sample_dir.mkdir(parents=True, exist_ok=True)
        for stale in out.glob(".samples-*"):
            shutil.rmtree(stale, ignore_errors=True)
        for stale in list(out.glob("data-*.json*")) + list(out.glob("samples-*.json*")):
            stale.unlink(missing_ok=True)
        # build() writes every payload itself; only the empty shell is left to write.
        stats = {**stats, "data_kb": round(write_json(out / "data.json", data) / 1024),
                 "index_kb": round(write_json(out / "samples.json", index) / 1024)}
    summary = {"pairs": data["source"].get("pairs", 0), "pairing": data["source"].get("mode"), **stats}
    print(json.dumps(summary, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
