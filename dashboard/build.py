#!/usr/bin/env python3
"""Build every dashboard payload from the evaluation datasets.

Layout read under the datasets root (repo ``datasets/`` locally, ``EVAL_DATASETS`` otherwise)::

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
    static/trends-<product>.json    lazy per-cell trend data (day × scene × user type × P0-P4 node)
    static/samples/<slug>.json      one sample, generated on first request (detail_builder.py)
"""
from __future__ import annotations

import argparse
import contextlib
import fcntl
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
from datetime import datetime
from pathlib import Path
from urllib.parse import unquote

import ab_test
import build_store as bs
import user_rules
from daytime import iso_now, local_day, local_day_minute
from filelist import TreeCache

try:  # optional: ~25% smaller JSON payloads than gzip at low quality
    import brotli as _brotli
except ImportError:  # pragma: no cover - deployment image may not have it
    _brotli = None
BROTLI_QUALITY = int(os.environ.get("BROTLI_QUALITY", "6"))

DASHBOARD = Path(__file__).resolve().parent
REPO = DASHBOARD.parent
STATIC = DASHBOARD / "static"


def cache_root(out_dir: Path) -> Path:
    """Build cache for an output tree: ``EVAL_CACHE_DIR`` when set, else ``<out>/../cache``.

    The cache (SQLite index, pickles, prewarm list) is per host; point it at local disk
    when the code directory itself is shared or read-only.
    """
    configured = os.environ.get("EVAL_CACHE_DIR")
    return Path(configured) if configured else out_dir.parent / "cache"
# 发版日期：数据目录里的 releases.json 优先（数据侧可覆盖），仓库内 config/releases.json 是随代码走的默认值。
RELEASES_CONFIG = DASHBOARD / "config" / "releases.json"
PRODUCTION_DATASETS = Path("/mnt/fin_bench/code_and_clean_data/datasets")
# Bump when input index semantics change; also invalidates cached input stats.
INPUT_INDEX_VERSION = "2026-11-12.1"
# Bump when pairing semantics change (cache keys are not otherwise versioned).
PAIRING_VERSION = "2026-11-13.1"
# Bump when the aggregate payload shape changes (details can stay cached).
PAYLOAD_VERSION = "2026-11-16.1"
# Bump when load_clusters() starts emitting fields the cached pickle lacks.
CLUSTER_INDEX_VERSION = 3


def default_datasets():
    """EVAL_DATASETS, else the mounted production tree, else <repo>/datasets."""
    if os.environ.get("EVAL_DATASETS"):
        return Path(os.environ["EVAL_DATASETS"]).expanduser()
    return PRODUCTION_DATASETS if PRODUCTION_DATASETS.is_dir() else REPO / "datasets"

SEVERITIES = ["P0", "P1", "P2", "P3", "P4"]
# 场景没有接入分类体系（输入 meta 缺 task / skill）：矩阵行、趋势场景和数据量列表都用这一句，
# 和「未聚类」（归因问题没有匹配到模式）不是一回事，别混。
NO_SCENE = "未接入分类体系"
WORST_KEYS = SEVERITIES + ["none"]
# 趋势图统计全部严重度；界面的「合计」就是 P0-P4，与矩阵格子「问题合计」同一口径。
TREND_SEVERITIES = SEVERITIES
UT_ORDER = ("real", "test", "internal", "unknown")

# Only fields the recall list and its filters/search actually read. Keeping the
# index lean matters more than the full aggregate row: it is fetched by every
# 具体数据 view and can be several MB.
INDEX_FIELDS = ("s", "q", "m", "sp", "d", "sid", "tid", "w", "n", "tr", "r", "pt", "st", "case", "task", "sub", "skill", "sc",
                "uid", "ut", "ul")
# lb (the joined problem labels) is 4.8MB of the AIME index and only ever feeds
# search, so it ships as its own file the browser fetches on the first keystroke.
# Split apart the two compress better (2.71 + 1.53) than they do together (4.73).
LABEL_FIELD = "lb"

PRODUCTS = {
    "wencai": {"label": "问财", "models": ["a_fast", "a_expert", "b_fast", "b_expert"]},
    "aime": {"label": "AIME", "models": ["aime_fast", "aime_expert"]},
}
# A deployment can serve a subset (EVAL_PRODUCTS=wencai). Every discovery path goes through
# product_of(), so the other product's folders simply do not exist for it. Default: all products.
ENABLED = {p.strip() for p in os.environ.get("EVAL_PRODUCTS", "").split(",") if p.strip()} or set(PRODUCTS)
if ENABLED - set(PRODUCTS):
    raise SystemExit(f"EVAL_PRODUCTS: unknown {sorted(ENABLED - set(PRODUCTS))}, known {sorted(PRODUCTS)}")
MODEL_LABEL = {
    "a_fast": "A Fast", "a_expert": "A Expert", "b_fast": "B Fast", "b_expert": "B Expert",
    "aime_fast": "Fast", "aime_expert": "Expert",
}
SPLITS = {"0_daily_eval": "daily", "1_lost_user_eval": "lost"}
SPLIT_LABEL = {"daily": "日常评测", "lost": "流失用户"}

# Legacy eval_input/ folders that must not be counted as extra input:
# back-test staging is published into 0_daily_eval_input first, and old lost-user
# dirs are archived. See input_files() and snapshot_input_dirs().
EXCLUSIVE_INPUT_DIRS = ("1_lost_user_eval", "2_task_eval")

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
    return name if name in ENABLED else None



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
    """Same-day input files for one output (pairing itself indexes all dates)."""
    if split != "daily":
        return []
    top_dir = root / top
    paths = [
        top_dir / "eval_input" / "0_daily_eval_input" / model / f"{date}.jsonl",
        top_dir / "eval_input" / model / f"{date}.jsonl",
    ]
    return [p.relative_to(root).as_posix() for p in paths if p.is_file()]


def input_roots(top: Path, product: str):
    """The directories that hold published eval input, newest layout first.

    Only these are scanned.  Anything else a person drops under the data root
    (a staged snapshot, an export, a backup) is not published input and must not
    reach the board: a copy of the daily input would silently double every
    volume number.  Discovery is by *layout*, not by name, so a snapshot folder
    needs no new exclusion when it appears -- see ``snapshot_input_dirs``.
    """
    base = top / "eval_input"
    if product == "aime":
        return [base / "0_daily_eval_input", base / "aime_expert", base / "aime_fast"]
    return [base]  # wencai keeps the flat per-model layout directly under eval_input


def snapshot_input_dirs(top: Path, product: str):
    """Published-looking input trees that sit outside ``input_roots``.

    Reported by the build so an accidental copy is visible instead of silent;
    they are never scanned.
    """
    roots = input_roots(top, product)
    base = top / "eval_input"
    if product != "aime":
        # wencai's published layout *is* one folder per model right under
        # eval_input, so there is no fixed set of roots to compare against and
        # nothing can be told apart as a stray; the board has no such case yet.
        return []
    # Legacy input dirs are excluded from both scanning and stray reporting.
    accounted = set(EXCLUSIVE_INPUT_DIRS)
    found = []
    for candidate in sorted(base.glob("*")):
        if not candidate.is_dir() or candidate in roots or candidate.name in accounted:
            continue
        # ``<model>/<date>.jsonl`` anywhere below the folder marks a copy of the
        # eval input; an archive without that shape is not one.
        if next(candidate.rglob("*.jsonl"), None) is not None:
            found.append(candidate)
    return found


def input_files(datasets: Path, top: Path, product: str):
    """Every published input file the volume card reads.

    The scan is limited to ``input_roots``.  AIME back-test staging
    (``eval_input/2_task_eval``) is excluded: its rows are published into
    ``eval_input/0_daily_eval_input`` first, so counting both would double the
    volume.  Wencai marks lost users inside the task-eval input with
    ``meta.lost_user`` rather than a separate directory.
    """
    # rglob 在弗吉尼亚的 ceph 上要 50 秒（目录太多），改成走目录清单缓存：
    # 只有 mtime 变过的目录才重新 readdir，数据没变时就是几十次 stat。
    tree = TreeCache(cache_root(STATIC))
    # Directories inside a root that hold published days more than once.
    skip = EXCLUSIVE_INPUT_DIRS if product == "aime" else ("1_lost_user_eval",)
    files = []
    for root in input_roots(top, product):
        if not root.is_dir():
            continue
        key = f"in-{product}-" + root.relative_to(top).as_posix().replace("/", "_") + \
              ("-" + "-".join(skip) if skip else "")
        files += [root / rel for rel in tree.walk(root, key, skip_parts=skip)]
    return sorted(files)


SIDECAR_SCHEMA = 1


def load_stats_sidecar(datasets: Path):
    """Read the worker-maintained stats.json, if present and valid.

    The sidecar is only an accelerator: every file is still checked against its
    current ``(size, mtime_ns)`` and falls back to a local scan when stale.
    """
    for path in (datasets / "stats.json", cache_root(STATIC) / "stats.json"):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if isinstance(data, dict) and data.get("schema") == SIDECAR_SCHEMA:
            return data
    return None


def lost_signature(rules) -> str:
    """Fingerprint of the lost uid list; changing it invalidates cached input stats."""
    raw = INPUT_INDEX_VERSION + "\x1f" + "\x1f".join(sorted(rules.lost_ids))
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:16]


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
    rules = user_rules.load(datasets)
    lost_ids = tuple(sorted(rules.lost_ids))
    lost_sig = lost_signature(rules)

    def lost_fresh(meta):
        return ((meta.get("stats") or {}).get("_lost_sig") == lost_sig)

    def prefix_ok(meta, path):
        prefix = meta.get("prefix")
        return bool(prefix) and prefix == bs.prefix_hash(path)

    # A sidecar entry only carries aggregates; join keys still come from the file index.
    # A cache row written before keys existed (or by a different store) also lacks them.
    # Both would make input_session_counts() return None and silently drop the session
    # denominators, so treat "no keys for a non-empty file" as a cache miss.
    indexed = store.file_keys([path.relative_to(datasets).as_posix() for path in files])
    metas, todo = [], []
    from_sidecar = 0
    for path in files:
        rel = path.relative_to(datasets).as_posix()
        try:
            stat = path.stat()
        except OSError:
            continue
        indexed_keys = indexed.get(rel)
        side = sidecar_files.get(rel)
        if (side and side.get("size") == stat.st_size and side.get("mtime_ns") == stat.st_mtime_ns
                and (indexed_keys or not side.get("lines")) and lost_fresh(side)
                and prefix_ok(side, path)):
            metas.append(side)
            from_sidecar += 1
            continue
        cached = store.file_meta(rel)
        if (cached and cached["size"] == stat.st_size and cached["mtime_ns"] == stat.st_mtime_ns
                and (indexed_keys or not cached.get("lines")) and lost_fresh(cached)
                and prefix_ok(cached, path)):
            metas.append(cached)
            continue
        prev = store.get_file(rel) if cached else None
        if prev and prev.get("lines") and not prev.get("keys"):
            prev = None  # full rescan backfills join keys instead of tailing only new lines
        todo.append((str(datasets), rel, "input", prev, True, product,
                     bs.split_from_rel(rel), bs.model_from_rel(rel), lost_ids, lost_sig))
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


def input_session_counts(metas, store, product: str = "") -> dict[str, int] | None:
    """去重评测输入的会话数，按 (split, 归一化模型, session_id) 计数。

    口径和 ``kpi.unique_sessions``（完成 Session）一致，所以 数据量卡 的
    「评测输入 Session」可以直接当评测量卡的分母。``files`` 表里每行都存了
    join key（``session_id\\x1frequest_time``），这里直接复用，不重读输入文件。

    索引里只要缺一个文件就返回 ``None``（例如 sidecar 由另一份 store 生成）：
    payload 不带该字段，前端退回旧的记录数，不拿错误数字冒充。
    """
    if store is None:
        return None
    paths = [m.get("path") for m in metas if m.get("path")]
    if not paths:
        return {"all": 0}
    keys = store.file_keys(paths)
    if len(keys) < len(set(paths)):
        return None
    seen = set()
    for meta in metas:
        rel = meta.get("path")
        if not rel:
            continue
        split = meta.get("split") or bs.split_from_rel(rel)
        raw_model = meta.get("model") or bs.stats_model(meta.get("stats"))
        model = bs.normalize_model(raw_model, product) or raw_model or "未标注"
        for key in keys.get(rel) or ():
            sid = key.split("\x1f", 1)[0]
            if sid:
                seen.add((split, model, sid))
    counts = dict(Counter(model for _, model, _ in seen))
    counts["all"] = len(seen)
    return counts


def input_payload(metas, store=None, product: str = ""):
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

    payload = {
        "records": records, "traces": agg["traces"], "tool_calls": agg["tool_calls"],
        "tokens_in": agg["tokens_in"], "tokens_out": agg["tokens_out"],
        "cache_read": agg["cache_read"],
        "lost": sum(t.get("lost", 0) for t in top.values()),
        "tasks": _task_nodes(top), "models": models,
    }
    sessions = input_session_counts(metas, store, product)
    if sessions is not None:
        payload["sessions"] = sessions["all"]
        for model, value in models.items():
            value["sessions"] = sessions.get(model, 0)
    return payload


def mark_evaluated(payload, rows):
    """Evaluated cases behind every 数据量 node, filed the way the dashboard's star map files them
    (model → task → scene), so the ring can tell which branches have nothing to open."""
    seen = Counter()
    for r in rows:
        task = r.get("task") or NO_SCENE
        scene = r.get("sub") or r.get("sc") or r.get("skill") or NO_SCENE
        for model in (r["m"], None):
            seen[(model,)] += 1
            seen[(model, task)] += 1
            seen[(model, task, scene)] += 1

    def tasks(nodes, model):
        for t in nodes:
            t["ev"] = seen[(model, t["task"])]
            for s in t.get("sub", []):
                s["ev"] = seen[(model, t["task"], s["sub"])]

    for model, m in payload["models"].items():
        m["ev"] = seen[(model,)]
        tasks(m["tasks"], model)
    tasks(payload["tasks"], None)


def input_model(meta):
    """Model key for an input file, matching the data-volume card's grouping."""
    return (meta.get("model") or bs.stats_model(meta.get("stats"))
            or Path(meta["path"]).parent.name)


def daily_input_stats(metas, store):
    """输入量/Session/Trace 按每条输入记录的 request_time 落到美东日期。

    文件按批次命名，但一个批次可能包含很多天的记录（重跑/滚动追加），
    所以不能再用文件名里的日期分组。
    """
    records = Counter()
    traces = Counter()
    sessions = defaultdict(set)
    number = {}
    for meta in metas:
        rel = meta.get("path")
        if not rel:
            continue
        model = input_model(meta)
        split = meta.get("split") or "daily"
        match = DATE_RE.search(Path(rel).name)
        fallback = match.group(1) if match else None
        index = store.get_file(rel) if store is not None else None
        keys = (index or {}).get("keys") or []
        tids = (index or {}).get("tids") or []
        if not keys:
            if fallback:
                records[(fallback, model, split)] += int(meta.get("lines") or 0)
                stats = meta.get("stats") or {}
                traces[(fallback, model, split)] += int(stats.get("traces") or meta.get("lines") or 0)
            continue
        for i, key in enumerate(keys):
            sid, sep, raw_time = key.partition("\x1f") if key else ("", "", "")
            day = local_day(raw_time) or fallback
            if not day:
                continue
            records[(day, model, split)] += 1
            line_tids = tids[i] if i < len(tids) else []
            if line_tids:
                traces[(day, model, split)] += len(line_tids)
            elif sep:
                traces[(day, model, split)] += 1
            if sid:
                sessions[(day, model, split)].add(number.setdefault(sid, len(number)))
    return records, {k: sorted(v) for k, v in sessions.items()}, traces


def daily_payload(samples, inputs, input_session_ids=None, input_traces=None):
    """Per-day input volume plus the evaluated session/trace/token totals.

    ``sids`` is carried alongside the count so the eval card can union sessions
    across a selected window instead of adding per-day distinct counts.  Only
    identity matters there, so sessions are small per-product integers rather
    than 40-character ids (about 400 KB of the AIME payload). ``in_sids`` does
    the same for inputs; ``input_traces`` is distinct from input JSONL records.
    """
    evaluated = Counter()
    traces = Counter()
    tokens = Counter()
    token_records = Counter()
    sids = defaultdict(set)
    number = {}
    for slug, detail, row, facts in samples:
        if not row.get("inp"):
            continue
        key = (row.get("idate") or row["d"], row.get("im") or row["m"], row.get("isp") or row["sp"])
        evaluated[key] += 1
        traces[key] += row["tr"]
        tokens[key] += facts["tokens"]
        token_records[key] += int(any(detail["meta"].get(k) is not None for k in ("tokens_in", "tokens_out")))
        sids[key].add(number.setdefault(row["sid"] or slug, len(number)))
    keys = set(inputs) | set(evaluated) | set(input_traces or {})
    out = []
    for d, m, sp in sorted(keys):
        item = {
            "d": d, "m": m, "sp": sp,
            "inputs": inputs.get((d, m, sp), 0),
            "evaluated": evaluated.get((d, m, sp), 0),
            "sessions": len(sids.get((d, m, sp), ())),
            "traces": traces.get((d, m, sp), 0),
            "tokens": tokens.get((d, m, sp), 0),
            "token_records": token_records.get((d, m, sp), 0),
            "sids": sorted(sids.get((d, m, sp), ())),
        }
        if input_session_ids is not None:
            item["in_sids"] = input_session_ids.get((d, m, sp), [])
            item["in_sessions"] = len(item["in_sids"])
        if input_traces is not None:
            item["input_traces"] = input_traces.get((d, m, sp), 0)
        out.append(item)
    return out


def debug(message):
    if os.environ.get("EVAL_BUILD_DEBUG"):
        print(f"[build] {message}", file=sys.stderr, flush=True)


def ensure_file(store: bs.BuildStore, root: Path, rel: str, kind: str = "input",
                product: str = "", need_stats: bool = False, load: bool = True,
                lost_ids=(), lost_sig: str = ""):
    """Return a cached file index, scanning only when ``(size, mtime)`` changed.

    ``load=False`` only brings the index up to date; an unchanged file is then
    not decoded at all.
    """
    path = root / rel
    stat = path.stat()
    if store.has_file_stat(rel, stat):
        cached = store.get_file(rel) if load else None
        # 旧索引可能缺 per-line trace 占位；长度对不上时重扫一次，自动升级。
        if not load or (cached and len(cached.get("tids") or []) >= int(cached.get("lines") or 0)):
            return cached
    prev = store.get_file(rel)
    data = bs.scan_file(root, rel, kind, prev, need_stats, product or product_of(rel.split("/")[0]) or "",
                        bs.split_from_rel(rel), bs.model_from_rel(rel), lost_ids, lost_sig)
    data["product"] = product
    store.put_file(data)
    return data


def ensure_input(store, root, rel, product, lost_ids=(), lost_sig=""):
    return ensure_file(store, root, rel, "input", product, True, True, lost_ids, lost_sig)


def ensure_raw(store, root, rel, load=True):
    kind = "output" if ("attribution" in rel or "compact" in rel) else "input"
    return ensure_file(store, root, rel, kind, "", False, load)


def choose_input(cands, turn_tids):
    """Pick the duplicate input snapshot that actually covers the attribution turns.

    Candidate trace ids are indexed once while the input file is scanned, so this
    no longer re-reads a multi-MB input line per attribution row.
    """
    need = {t for t in turn_tids if t}
    if not cands:
        return None
    if not need or not any(cand[2] for cand in cands):
        return cands[0]
    best = None
    for cand in cands:
        ids = set(cand[2])
        cover = len(need & ids)
        # Prefer full coverage, then the snapshot with the fewest extra traces.
        score = (cover == len(need), cover, -len(ids) if cover == len(need) else len(ids))
        if best is None or score > best[0]:
            best = (score, cand)
    return best[1] if best and best[0][1] > 0 else None


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


def input_slots(root: Path, store: bs.BuildStore, metas, product: str,
                lost_ids=(), lost_sig: str = ""):
    """All input lines for one product, keyed by (model, session+request_time).

    Attribution dates can differ from the input file date after trace-level
    splitting/delivery, so pairing must not be limited to the output's own day.
    """
    slots = defaultdict(list)
    traces = defaultdict(list)
    slots_any = defaultdict(list)
    traces_any = defaultdict(list)
    for meta in metas or []:
        rel = meta.get("path")
        if not rel:
            continue
        index = ensure_input(store, root, rel, product, lost_ids, lost_sig)
        model = meta.get("model") or bs.model_from_rel(rel)
        for n, (key, tids, hashes) in enumerate(zip(index["keys"], index["tids"], index["hashes"]), 1):
            if key:
                slots[(model, key)].append((rel, n, tids, hashes))
                slots_any[key].append((rel, n, tids, hashes))
            for tid in tids or ():
                traces[(model, tid)].append((rel, n, tids, hashes))
                traces_any[tid].append((rel, n, tids, hashes))
    return slots, traces, slots_any, traces_any


def pair_output(root: Path, item: dict, store: bs.BuildStore, lost_ids=(), lost_sig: str = "",
                slots=None, trace_slots=None, slots_any=None, trace_slots_any=None,
                compact_slots=None, compact_any=None, compact_sid=None, compact_sid_any=None,
                used=None, used_compact=None, reserved=None):
    global_slots = slots is not None
    slots_local, traces_local, compacts = defaultdict(list), defaultdict(list), defaultdict(list)
    if slots is None:
        for rel in item["inputs"]:
            index = ensure_input(store, root, rel, item["product"], lost_ids, lost_sig)
            for n, (key, tids, hashes) in enumerate(zip(index["keys"], index["tids"], index["hashes"]), 1):
                if key:
                    slots_local[key].append((rel, n, tids, hashes))
                for tid in tids or ():
                    traces_local[tid].append((rel, n, tids, hashes))
        slots = slots_local
        trace_slots = traces_local
    if compact_slots is None and item["compact"]:
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
        if global_slots:
            pool = (slots.get((item["model"], key))
                    or (slots_any or {}).get(key)
                    or slots.get(("", key)) or [])
            trace_pools = [
                (trace_slots.get((item["model"], tid))
                 or (trace_slots_any or {}).get(tid)
                 or trace_slots.get(("", tid)))
                for tid in turn_tids] if trace_slots else []
        else:
            pool = slots.get(key) or []
            trace_pools = [trace_slots.get(tid) for tid in turn_tids] if trace_slots else []
        if used is not None:
            pool = [c for c in pool if (c[0], c[1]) not in used]
        inp = choose_input(pool, turn_tids)
        if inp is None and trace_pools:
            # The exact key had no usable row (wrong trace, or already taken), so fall
            # back to the same trace.  Never take a row that exactly matches another
            # output line: a duplicate attribution with a drifted request_time used to
            # consume the only input of the row whose key really matched it.
            merged, seen_refs = [], set()
            for part in trace_pools:
                for cand in part or ():
                    ref = (cand[0], cand[1])
                    if ref in seen_refs:
                        continue
                    if used is not None and ref in used:
                        continue
                    if reserved and ref in reserved:
                        continue
                    seen_refs.add(ref)
                    merged.append(cand)
            inp = choose_input(merged, turn_tids)
        if inp:
            if used is not None:
                used.add((inp[0], inp[1]))
            if not global_slots:
                try:
                    pool.remove(inp)
                except ValueError:
                    pass
        if compact_slots is not None:
            sid = key.split("\x1f", 1)[0] if key else ""
            pool = (compact_slots.get((item["model"], key))
                    or (compact_any or {}).get(key) or [])
            if not pool and sid:
                pool = ((compact_sid or {}).get((item["model"], sid))
                        or (compact_sid_any or {}).get(sid) or [])
            if used_compact is not None:
                avail = [c for c in pool if (c[0], c[1]) not in used_compact]
                pool = avail or pool
            comp = pool[0] if pool else None
            if comp is not None and used_compact is not None:
                used_compact.add((comp[0], comp[1]))
        else:
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


def pairs_from_keys(root: Path, store: bs.BuildStore, product_metas=None):
    """Pair each attribution file by session id + request time.

    Unchanged attribution files are served from the pairing cache; only a new or
    changed output (including a changed input snapshot) is re-paired.  Input is
    indexed once per product across all dates: trace-level publishing can put an
    attribution row in a different date file than its input row.
    """
    pairs = []
    info = Counter()
    misses = {}
    rules = user_rules.load(root)
    lost_ids = tuple(sorted(rules.lost_ids))
    lost_sig = lost_signature(rules)
    metas_by_product = product_metas or {}
    slots_cache = {}
    used_by_product = defaultdict(set)
    model_sigs = {}
    for product, metas in metas_by_product.items():
        by_model = defaultdict(list)
        for meta in metas:
            rel = meta.get("path")
            if not rel:
                continue
            model = meta.get("model") or bs.model_from_rel(rel)
            by_model[model].append([rel, meta.get("size"), meta.get("mtime_ns")])
        model_sigs[product] = {
            model: hashlib.sha1(json.dumps(parts, separators=(",", ":")).encode()).hexdigest()
            for model, parts in by_model.items()
        }

    def slots_for(product):
        if product not in slots_cache:
            slots_cache[product] = input_slots(
                root, store, metas_by_product.get(product) or [], product, lost_ids, lost_sig)
        return slots_cache[product]

    items = discover_outputs(root)
    # Which input rows are an exact (session + request_time) match for some output
    # line.  Pairing is per file and a file is paired in path order, so without this
    # reservation a duplicate attribution in an earlier file, whose key drifted but
    # whose trace is identical, could take the row that exactly matches a later file.
    reserved = defaultdict(set)
    if product_metas is not None:
        for item in items:
            slots, _trace_slots, slots_any, _trace_slots_any = slots_for(item["product"])
            if not slots and not slots_any:
                continue
            index = ensure_raw(store, root, item["rel"])
            for key in index.get("keys") or ():
                if not key:
                    continue
                pool = (slots.get((item["model"], key))
                        or (slots_any or {}).get(key)
                        or slots.get(("", key)) or [])
                for cand in pool:
                    reserved[item["product"]].add((cand[0], cand[1]))
    compact_rels = {item["compact"] for item in items if item.get("compact")}
    # A compact file can exist under a different date than its attribution row;
    # include every published split's compact files, not only the paths predicted
    # from output dates.  Filtered by ENABLED like every other discovery path: a
    # wencai-only build used to index the other product's compacts (3.7 GB read
    # for nothing on 乌兰).
    for path in root.glob("*/eval_output/*/*/compact/*.jsonl"):
        rel = path.relative_to(root).as_posix()
        if rel.split("/")[2] in SPLITS and product_of(rel.split("/")[0]):
            compact_rels.add(rel)
    compact_parts = []
    for rel in sorted(compact_rels):
        try:
            st = (root / rel).stat()
            compact_parts.append([rel, st.st_size, st.st_mtime_ns])
        except OSError:
            compact_parts.append([rel, -1, -1])
    compact_sig = hashlib.sha1(
        json.dumps(compact_parts, separators=(",", ":")).encode()).hexdigest()
    compact_slots = defaultdict(list)
    compact_any = defaultdict(list)
    compact_sid = defaultdict(list)
    compact_sid_any = defaultdict(list)
    for rel in sorted(compact_rels):
        index = ensure_raw(store, root, rel)
        model = bs.model_from_rel(rel)
        for n, (key, hashes) in enumerate(zip(index["keys"], index["hashes"]), 1):
            if not key:
                continue
            entry = (rel, n, hashes)
            compact_slots[(model, key)].append(entry)
            compact_any[key].append(entry)
            sid = key.split("\x1f", 1)[0]
            if sid:
                compact_sid[(model, sid)].append(entry)
                compact_sid_any[sid].append(entry)
    used_compact = defaultdict(set)

    for item in items:
        # Detail building reads one output line by offset; make sure that index
        # exists even when the pairing itself is served from cache.
        ensure_raw(store, root, item["rel"], load=False)
        model_sig = model_sigs.get(item["product"], {}).get(item["model"], "")
        sig = "|".join((PAIRING_VERSION, item["sig"], model_sig, compact_sig))
        cached = store.get_pairs(item["rel"])
        if cached and cached[0] == sig:
            file_pairs = cached[1]
            file_misses = cached[2] or {}
            info["pair_hits"] += 1
            for pair in file_pairs:
                ref = pair.get("input")
                if ref:
                    used_by_product[item["product"]].add((ref[0], ref[1]))
                cref = pair.get("compact")
                if cref:
                    used_compact[item["product"]].add((cref[0], cref[1]))
        else:
            if product_metas is not None:
                slots, trace_slots, slots_any, trace_slots_any = slots_for(item["product"])
            else:
                slots = trace_slots = slots_any = trace_slots_any = None
            file_pairs, unmatched = pair_output(
                root, item, store, lost_ids, lost_sig,
                slots=slots, trace_slots=trace_slots,
                slots_any=slots_any, trace_slots_any=trace_slots_any,
                compact_slots=compact_slots, compact_any=compact_any,
                compact_sid=compact_sid, compact_sid_any=compact_sid_any,
                used=used_by_product[item["product"]] if slots is not None else None,
                used_compact=used_compact[item["product"]],
                reserved=reserved.get(item["product"]))
            file_misses = {key: value for key, value in unmatched.items() if value}
            store.put_pairs(item["rel"], sig, file_pairs, file_misses)
            info["pair_misses"] += 1
        for key, value in file_misses.items():
            info[f"unmatched_{key}"] += value
        if file_misses:
            misses[item["rel"]] = file_misses
        pairs.extend(file_pairs)
        store.commit()
    info["mode"] = "key"
    info["rows"] = len(pairs)
    info["unmatched_files"] = len(misses)
    info["unmatched_sig"] = hashlib.sha1(
        json.dumps(sorted(misses.items()), ensure_ascii=False, separators=(",", ":")).encode()
    ).hexdigest()
    return pairs, dict(info)


# --------------------------------------------------------------------------- clusters

def cluster_tree_files(root: Path):
    """Every cluster_tree.json, without the old recursive ** glob.

    Two layouts are in use:
      <product>/eval_output/cluster/<model>/cluster_tree.json       (AIME)
      <product>/eval_output/<split>/cluster/<model>/cluster_tree.json (wencai)
    The recursive glob also walked .runs/.delivery subtrees on ceph, which was
    the expensive part of the "did anything change?" check.
    """
    found = []
    for top in root.iterdir():
        if not top.is_dir() or not product_of(top.name):
            continue
        out = top / "eval_output"
        if not out.is_dir():
            continue
        direct = out / "cluster"
        if direct.is_dir():
            found.extend(direct.glob("*/cluster_tree.json"))
        for split in out.iterdir():
            if not split.is_dir() or split.name == "cluster":
                continue
            nested = split / "cluster"
            if nested.is_dir():
                found.extend(nested.glob("*/cluster_tree.json"))
    return sorted(found)


def load_clusters(root: Path):
    taxonomy = {"stages": {}, "l2": {}, "patterns": {}, "mechanisms": {}, "tags": {}, "meta": {}, "runs": []}
    index = {}
    for tree_path in cluster_tree_files(root):
        product = product_of(tree_path.relative_to(root).parts[0])
        if not product:
            continue
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
                    label = it.get("label")
                    json_path = it.get("json_path")
                    problem_index = it.get("problem_index")
                    turn_index = it.get("turn_index", 0)
                    for ident in (it.get("session_id"), it.get("trace_id"), it.get("case_id")):
                        if not ident:
                            continue
                        if json_path:
                            index.setdefault((product, model, ident, json_path, label), entry)
                        if problem_index is not None:
                            index.setdefault(
                                (product, model, ident, "pi", f"{turn_index}:{problem_index}", label), entry)
                            index.setdefault(
                                (product, model, ident, "pi", str(problem_index), label), entry)
                            index.setdefault(
                                (product, model, ident, "pix", f"{turn_index}:{problem_index}"), entry)
                            index.setdefault(
                                (product, model, ident, "pix", str(problem_index)), entry)
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
    imeta = (inp or {}).get("meta") or {}
    case = (inp or {}).get("case_id") or smeta.get("case_id") or ""

    # ---- input traces → messages with blocks
    if inp and inp.get("traces"):
        raw_traces = [(t.get("meta") or {}, t.get("messages") or []) for t in inp["traces"]]
    elif inp:
        meta = dict(inp.get("meta") or {})
        # 老布局没有 traces[]：顶层 trace_id 才是这条 trace 的 id，别用外层 meta 里的会话 id。
        if inp.get("trace_id"):
            meta["trace_id"] = inp["trace_id"]
        raw_traces = [(meta, inp.get("messages") or [])]
    else:
        raw_traces = []

    # 最外层 meta 是 session 级；每条 trace 的 trace_id 在自己的 trace_meta（meta）里。
    # attribution 的 session_meta.trace_id 常被写成 thread/session id，不能当 trace id。
    sid = imeta.get("session_id") or imeta.get("thread_id") or smeta.get("session_id") or smeta.get("thread_id") or ""
    if not sid:
        for tmeta, _ in raw_traces:
            sid = tmeta.get("session_id") or tmeta.get("thread_id") or ""
            if sid:
                break
    input_tids = [tmeta.get("trace_id") for tmeta, _ in raw_traces
                  if isinstance(tmeta, dict) and tmeta.get("trace_id")]
    turn_tids = []
    for turn in attr.get("turns") or []:
        meta = turn.get("meta") if isinstance(turn, dict) else None
        if isinstance(meta, dict) and meta.get("trace_id"):
            turn_tids.append(meta["trace_id"])
    tid = (input_tids[0] if input_tids else "") or (turn_tids[0] if turn_tids else "") \
        or (inp or {}).get("trace_id") or smeta.get("trace_id") or ""
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

    def take_problem(p, json_path, turn, problem_index):
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
        label = p.get("label")
        for ident in (sid, tid, case):
            if not ident:
                continue
            if json_path:
                cl = clusters.get((product, model, ident, json_path, label))
            if not cl:
                cl = clusters.get((product, model, ident, "pi", f"{turn}:{problem_index}", label))
            if not cl:
                cl = clusters.get((product, model, ident, "pi", str(problem_index), label))
            if not cl:
                cl = clusters.get((product, model, ident, "pix", f"{turn}:{problem_index}"))
            if not cl:
                cl = clusters.get((product, model, ident, "pix", str(problem_index)))
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
            take_problem(p, f"turns[{ti}].problem[{pi}]", ti, pi)
        tm = t.get("meta") or {}
        turns.append({
            "summary": t.get("summary"), "correct": t.get("is_correct"), "correct_reason": t.get("correct_reason"),
            "problems": list(range(before, len(problems))),
            "trace_id": tm.get("trace_id"), "agent": tm.get("name") or tm.get("agent_id"), "model": tm.get("model"),
        })
    session_problems = []
    for pi, p in enumerate(attr.get("session_problem") or []):
        take_problem(p, f"session_problem[{pi}]", None, pi)
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
            "trace_id": tmeta.get("trace_id") or ((inp or {}).get("trace_id") if len(raw_traces) == 1 else None),
            "agent": tmeta.get("name") or tmeta.get("agent_id"), "model": tmeta.get("model"),
            "mode": tmeta.get("mode") or tmeta.get("runtime_mode"),
            "question_zh": tmeta.get("question_zh"), "task": tmeta.get("task"),
            "subtask": tmeta.get("subtask"), "difficulty": tmeta.get("difficulty"),
            # 原始 trace_meta 全量保留：页面可以不展示，但不能在后端丢掉。
            "meta": tmeta,
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
    # 样本页的「用户 ID / 用户类型」：输入顶层 meta 优先，其次各轮 trace meta，最后归因 session_meta。
    uid = imeta.get("user_id")
    if uid in (None, ""):
        for tmeta, _ in raw_traces:
            if tmeta.get("user_id") not in (None, ""):
                uid = tmeta.get("user_id")
                break
    if uid in (None, ""):
        uid = smeta.get("user_id")
    uid = str(uid) if uid not in (None, "") else None
    # 统一按美东时间给样本定日；request_time 缺失时才退回批次文件日期。
    sample_day = (
        local_day(imeta.get("request_time"))
        or local_day(smeta.get("request_time"))
        or local_day(first_meta.get("timestamp"))
        or pair["date"]
    )
    detail = {
        "product": product, "split": pair["split"], "model": model, "date": sample_day,
        "question": question, "question_zh": first_meta.get("question_zh"),
        "lang": lang_of(question),
        "ids": {"session": sid, "trace": tid, "case": case},
        # 外层 meta 是 session 级埋点；全量保留，页面按需展示。
        "session_meta": imeta,
        "meta": {
            "version": (inp or {}).get("version"), "mode": smeta.get("agent_mode") or imeta.get("agent_mode"),
            "source": smeta.get("source") or imeta.get("source"), "skill": imeta.get("skill_name") or None,
            "app": imeta.get("app") or first_meta.get("app") or smeta.get("app"),
            "comefrom": imeta.get("comefrom") or first_meta.get("comefrom") or smeta.get("comefrom"),
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
        "q": clip(question, 160), "m": model, "sp": pair["split"], "d": sample_day,
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
    if uid:
        row["uid"] = uid

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


def scene_votes(product, samples):
    """问财 has no task/subtask in the source; its scene is the skill the A versions
    routed to, and B versions take the skill recorded for the same question."""
    if product != "wencai":
        return {}
    votes = defaultdict(Counter)
    for s in samples:
        if s[1]["meta"].get("skill"):
            votes[s[1]["question"]][s[1]["meta"]["skill"]] += 1
    return {q: c.most_common(1)[0][0] for q, c in votes.items()}


def scene_of(brief, scene):
    m = brief["meta"]
    return m.get("task") or m.get("skill") or scene.get(brief["question"]) or NO_SCENE


def aggregate(product, samples, taxonomy):
    """``samples`` = list of (slug, detail, row, facts) for one product."""
    total = len(samples)
    models = [m for m in PRODUCTS[product]["models"] if any(s[2]["m"] == m for s in samples)]
    models += sorted({s[2]["m"] for s in samples} - set(models))
    splits = [sp for sp in ("daily", "lost")
              if any((s[2].get("ul") if sp == "lost" else s[2]["sp"] == sp) for s in samples)]
    scene = scene_votes(product, samples)

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
        entry["splits"] = {sp: group_stats([s for s in rows
                                           if (s[2].get("ul") if sp == "lost" else s[2]["sp"] == sp)])
                           for sp in splits}
        by_model.append(entry)
    by_split = [{"id": sp, "label": SPLIT_LABEL[sp],
                 **group_stats([s for s in samples
                                if (s[2].get("ul") if sp == "lost" else s[2]["sp"] == sp)])}
                for sp in splits]

    # Component roles in pipeline order.
    roles = {}
    for slug, row, p in problems_all:
        r = p["role"] or "other"
        # setdefault would build its two Counters on every problem, even when the
        # role already exists (hundreds of thousands of throwaway objects).
        e = roles.get(r)
        if e is None:
            e = roles[r] = {"id": r, "label": ROLE_LABEL.get(r, r), "problems": 0, "sev": sev_counter(),
                            "sessions": set(), "families": Counter(), "components": Counter()}
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
        pat = patterns.get(cl["path"])
        if pat is None:
            pat = patterns[cl["path"]] = {"id": cl["path"], "n": 0, "sessions": set(), "sev": sev_counter(),
                                          "models": Counter(), "examples": []}
        pat["n"] += 1
        pat["sessions"].add(slug)
        pat["models"][row["m"]] += 1
        if p["sev"]:
            pat["sev"][p["sev"]] += 1
        pat["examples"].append((SEVERITIES.index(p["sev"]) if p["sev"] else 9, slug, p["id"], p["label"],
                                row["m"], row["w"], clip(row["q"], 64)))
        for tag in cl["tags"]:
            t = tags.get(tag)
            if t is None:
                t = tags[tag] = {"id": tag, "n": 0, "sessions": set(), "stages": Counter()}
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
        cross.append([scene_of(detail, scene), detail["meta"].get("subtask") or "",
                      [[pid, n] for pid, n in pats.most_common()], row["tr"]])

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
        profile["task"] = top(Counter(s[2].get("task") or NO_SCENE for s in samples), 9)
        profile["difficulty"] = dict(Counter(s[2].get("diff") or "未标注" for s in samples))
        profile["entry"] = top(Counter(s[3]["comefrom"] or "未知" for s in samples), 7)
    else:
        profile["skill"] = top(Counter(s[2].get("skill") or NO_SCENE for s in samples if s[2]["m"].startswith("a_")), 8)

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
            tree[scene_of(s[1], scene)][s[1]["meta"].get("subtask") or ""] += 1
        return [
            {"id": t, "n": sum(c.values()), "sub": [{"id": k or NO_SCENE, "n": v} for k, v in c.most_common()] if any(c) else []}
            for t, c in sorted(tree.items(), key=lambda kv: -sum(kv[1].values()))
        ]

    # The session field: one cell per evaluated record (session × request_time), grouped by
    # model. AIME is read as one product (daily + lost together); its lost users are counted
    # as a marker, not split out. `sessions` repeats the same (split, sid) key as
    # `unique_sessions`, so group headers sum to the card summary and to 评测量's 完成 Session.
    field = []
    order = {k: i for i, k in enumerate(WORST_KEYS)}
    unified = product == "aime"
    keys = [(None, m) for m in models] if unified else [(sp, m) for sp in splits for m in models]
    for sp, m in keys:
        group = [s for s in samples
                 if s[2]["m"] == m
                 and (sp is None or (s[2].get("ul") if sp == "lost" else s[2]["sp"] == sp))]
        group.sort(key=lambda s: (order[s[2]["w"]], -s[2]["n"], s[2]["d"]))
        if group:
            field.append({
                "split": sp or "", "model": m,
                "lost": sum(1 for s in group if s[2].get("ul")),
                "sessions": len({(s[2]["sp"], s[2]["sid"] or s[0]) for s in group}),
                "cells": [[s[0], order[s[2]["w"]], s[2]["n"], clip(s[2]["q"], 56),
                           int(bool(s[2].get("ul")))] for s in group],
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
            "token_records": sum(any(s[1]["meta"].get(k) is not None for k in ("tokens_in", "tokens_out")) for s in samples),
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


def release_source(datasets: Path) -> Path:
    """The dataset file wins when present; otherwise the repo config is the shipped default."""
    own = datasets / "releases.json"
    return own if own.is_file() else RELEASES_CONFIG


def release_entries(datasets: Path, product: str):
    """Dated releases for one product, from ``<datasets>/releases.json`` or ``config/releases.json``.

    Accepts ``{"<product>": [entry, ...]}`` or a bare list applying to every product;
    each entry is ``"YYYY-MM-DD"`` or ``{"date": "YYYY-MM-DD", "label": "..."}``.
    Malformed entries are skipped and the result is sorted by date.
    """
    try:
        data = json.loads(release_source(datasets).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    if isinstance(data, dict):
        data = data.get(product)
    if not isinstance(data, list):
        return []
    entries = []
    for item in data:
        if isinstance(item, str):
            item = {"date": item}
        if not isinstance(item, dict):
            continue
        date = item.get("date")
        if not isinstance(date, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", date):
            continue
        try:
            datetime.strptime(date, "%Y-%m-%d")
        except ValueError:
            continue
        entry = {"date": date}
        if isinstance(item.get("label"), str) and item["label"]:
            entry["label"] = item["label"]
        entries.append(entry)
    return sorted(entries, key=lambda entry: entry["date"])


def trace_severity(detail, include_refs=False):
    """One mutually exclusive worst level per evaluated Trace, including clean ones.

    Attribution turns define the evaluated population, not input/session counts.
    Session-wide problems require a Trace evidence anchor; ambiguous assignments
    cannot turn an affected Trace into a supposedly clean one.
    """
    attr = detail.get("attribution") or {}
    turns = attr.get("turns") or []
    keys = [turn.get("trace_id") or f"turn:{i}" for i, turn in enumerate(turns)]
    worst = dict.fromkeys(keys, len(SEVERITIES))
    ambiguous = dict.fromkeys(keys, len(SEVERITIES))
    inputs = (detail.get("input") or {}).get("traces") or []
    evidence = detail.get("evidence") or []
    for problem in attr.get("problems") or []:
        level = SEVERITIES.index(problem["sev"]) if problem.get("sev") in SEVERITIES else None
        turn = problem.get("turn")
        targets = set()
        if isinstance(turn, int) and 0 <= turn < len(keys):
            targets.add(keys[turn])
        else:
            for ei in problem.get("ev") or []:
                ev = evidence[ei] if isinstance(ei, int) and 0 <= ei < len(evidence) else {}
                ti = ev.get("t")
                if isinstance(ti, int) and 0 <= ti < len(inputs):
                    trace_id = inputs[ti].get("trace_id")
                    if trace_id and trace_id in worst:
                        targets.add(trace_id)
            if not targets and len(worst) == 1 and len(inputs) <= 1:
                targets.update(worst)
        if level is not None and targets:
            for key in targets:
                worst[key] = min(worst[key], level)
        else:
            for key in targets or worst:
                ambiguous[key] = min(ambiguous[key], level if level is not None else 0)
    counts = [0] * 6
    refs = []
    unresolved = 0
    for key, level in worst.items():
        if ambiguous[key] < level:
            unresolved += 1
        else:
            counts[level] += 1
            if include_refs:
                turn = keys.index(key)
                refs.append([turn, level, turns[turn].get("trace_id")])
    result = {"counts": counts, "unresolved": unresolved}
    if include_refs:
        result["refs"] = refs
    return result


def trend_payload(product, samples, releases=(), generated=None):
    """Lazy payload behind a cluster-matrix cell's in-card trend chart.

    ``base`` counts every evaluated record per day × scene × model × user type,
    clean and unclustered included, so a cell always has a denominator.  ``cells``
    repeats each clustered problem at every prefix of its cluster path, one column
    per severity including P4; the ``h*`` sets dedupe slugs per severity, so they
    count hit sessions, not problems; the trailing ``any`` column is that session set's
    union, because summing per-severity hit sessions double counts a session that
    shows the same problem at several levels.  After ``any`` comes a sparse
    ``levelMask, sessionCount, ...`` histogram: a mask has bit ``k`` set when the
    session hit Pk, so the hit-session union of any level combination can be summed
    exactly (多选 P0+P1+P2 只算同时命中其中任一等级的会话一次). Models keep the same
    order as the aggregate.
    """
    scene = scene_votes(product, samples)

    # One scene lookup per sample: the same pair is used by the denominator pass,
    # the clustered-problem pass and the trace pass.
    prepared = []
    for slug, detail, row, facts in samples:
        pair = (scene_of(detail, scene), detail["meta"].get("subtask") or "")
        prepared.append((slug, detail, row, facts, pair))

    dates, uts, models, scenes, base = set(), set(), set(), set(), Counter()
    for slug, detail, row, facts, pair in prepared:
        ut = row.get("ut") or "unknown"
        dates.add(row["d"])
        uts.add(ut)
        models.add(row["m"])
        scenes.add(pair)
        base[(row["d"], pair, row["m"], ut)] += 1
    dates = sorted(dates)
    uts = [ut for ut in UT_ORDER if ut in uts] + sorted(uts - set(UT_ORDER))
    preferred = PRODUCTS[product]["models"] if product in PRODUCTS else []
    models = [model for model in preferred if model in models] + sorted(models - set(preferred))
    scenes = sorted(scenes)
    day_idx = {day: i for i, day in enumerate(dates)}
    ut_idx = {ut: i for i, ut in enumerate(uts)}
    model_idx = {model: i for i, model in enumerate(models)}
    scene_idx = {pair: i for i, pair in enumerate(scenes)}

    nodes = set()
    for slug, detail, row, facts, pair in prepared:
        for p in detail["attribution"]["problems"]:
            if p["cl"]:
                parts = p["cl"]["path"].split(".")
                nodes.update(".".join(parts[:n]) for n in range(1, len(parts) + 1))
    nodes = sorted(nodes)
    node_idx = {node: i for i, node in enumerate(nodes)}

    # A cell needs per-severity problem counts plus, per session, the mask of levels
    # it hit.  The masks alone give the hit-session union for each severity and for
    # any level combination, so the old five sets per cell (and their inserts) are
    # redundant.
    cells = {}
    for slug, detail, row, facts, pair in prepared:
        day, scene_i = day_idx[row["d"]], scene_idx[pair]
        model, ut = model_idx[row["m"]], ut_idx[row.get("ut") or "unknown"]
        for p in detail["attribution"]["problems"]:
            if not p["cl"] or p["sev"] not in TREND_SEVERITIES:
                continue
            sev = TREND_SEVERITIES.index(p["sev"])
            parts = p["cl"]["path"].split(".")
            for n in range(1, len(parts) + 1):
                key = (day, scene_i, node_idx[".".join(parts[:n])], model, ut)
                cell = cells.get(key)
                if cell is None:
                    cell = cells[key] = [[0, 0, 0, 0, 0], {}]
                cell[0][sev] += 1
                cell[1][slug] = cell[1].get(slug, 0) | (1 << sev)

    base_out = sorted([day_idx[day], scene_idx[pair], model_idx[model], ut_idx[ut], n]
                      for (day, pair, model, ut), n in base.items())
    cells_out = []
    for key in sorted(cells):
        counts, mask_of = cells[key]
        if not any(counts):
            continue
        hit_counts = [sum(1 for mask in mask_of.values() if mask & (1 << k)) for k in range(len(TREND_SEVERITIES))]
        hist_by_mask = {}
        for mask in mask_of.values():
            hist_by_mask[mask] = hist_by_mask.get(mask, 0) + 1
        hist = sorted(hist_by_mask.items())
        cells_out.append([*key, *counts, *hit_counts, len(mask_of),
                          *(v for pair in hist for v in pair)])

    trace_days = [[0] * 6 for _ in dates]
    trace_refs = []
    unresolved = 0
    intraday_buckets = defaultdict(lambda: defaultdict(lambda: [0] * 6))
    intraday_totals = defaultdict(lambda: [0] * 6)
    for slug, detail, row, _, _pair in prepared:
        trace = detail.get("trace_severity") or trace_severity(detail, include_refs=True)
        for level, count in enumerate(trace["counts"]):
            trace_days[day_idx[row["d"]]][level] += count
        unresolved += trace["unresolved"]
        trace_refs.extend([day_idx[row["d"]], slug, *ref] for ref in trace.get("refs", []))
        day_of_request, minute = local_day_minute((detail.get("meta") or {}).get("request_time"))
        if day_of_request and minute is not None:
            bucket = (minute // 5) * 5
            counts = intraday_buckets[day_of_request][bucket]
            for level, count in enumerate(trace["counts"]):
                counts[level] += count
                intraday_totals[day_of_request][level] += count

    # 每一天都落一份 00:00–23:55 的 24 小时序列，前端可以按日期倒回去看。
    intraday_days = {}
    previous_total = [0] * 6
    for day in sorted(set(dates) | set(intraday_buckets)):
        buckets = intraday_buckets.get(day) or {}
        intraday_days[day] = {
            "prev": list(previous_total),
            # 只落地有数据的 5 分钟槽；前端统一补成 00:00–23:55 的 288 根。
            "buckets": [[minute, *counts] for minute, counts in sorted(buckets.items()) if any(counts)],
        }
        previous_total = list(intraday_totals.get(day) or [0] * 6)
    # 默认落在最近一天“真的有请求”的日期；空评测日仍留在 days 里供回看。
    latest_day = max((day for day, pack in intraday_days.items()
                      if any(sum(row[1:]) for row in pack["buckets"])), default=None)
    if latest_day is None and intraday_days:
        latest_day = max(intraday_days)
    intraday = None
    if latest_day:
        intraday = {
            "date": latest_day,
            "bucket_minutes": 5,
            "prev": list(intraday_days[latest_day]["prev"]),
            "buckets": intraday_days[latest_day]["buckets"],
            "days": intraday_days,
        }

    return {
        "schema": 2, "generated_at": generated or iso_now(), "product": product,
        "releases": [dict(entry) for entry in releases],
        "dates": dates, "uts": uts, "models": models,
        "scenes": [[task, sub] for task, sub in scenes],
        "nodes": nodes,
        "base": base_out, "cells": cells_out,
        "trace_severity": {"levels": WORST_KEYS, "daily": trace_days, "unresolved": unresolved, "refs": trace_refs, "intraday": intraday},
    }


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
GOLDEN_FULL = 600  # characters a golden-case message expands to on 评测体系


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

    def first_text(m):
        return next((x for b in m["blocks"] for x in b["x"] if isinstance(x, str) and x.strip()), "")

    return score, {
        "slug": detail["slug"], "product": detail["product"], "model": detail["model"],
        "date": detail["date"], "question": detail["question"],
        # "text" is the one-line rail; "full" (only when longer) is what a reader expands to.
        "messages": [
            {"k": m["k"], "name": m.get("name"), "dur": m.get("dur"), "text": clip(first_text(m), 90),
             **({"full": clip(first_text(m), GOLDEN_FULL)} if len(first_text(m)) > 90 else {})}
            for m in msgs
        ],
        "problems": [
            {"id": p["id"], "sev": p["sev"], "label": p["label"], "role": p["role"], "comp": p["comp"],
             "path": p["cl"]["path"] if p["cl"] else None,
             "msgs": sorted({detail["evidence"][e]["m"] for e in p["ev"] if "m" in detail["evidence"][e]}),
             "ev": [{"m": detail["evidence"][e].get("m"), "q": clip(detail["evidence"][e].get("q"), 240)}
                    for e in p["ev"] if detail["evidence"][e].get("q")][:6]}
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


# --------------------------------------------------------------------------- bench

BENCH_SCHEMA = 1


def _bench_row(rec, kind, slug_by_trace):
    """One case as Bench lists it: the question, who ran it, when, and how bad it was."""
    sev = rec.get("severity") or ""
    n = int(rec.get("problem_count") or 0)
    if kind == "golden" and (n or sev not in ("", "none")):
        return None
    if kind == "bad" and sev not in ("P0", "P1"):
        return None
    return {
        "i": rec.get("bad_case_id") or "",
        "q": rec.get("question") or "",
        "m": rec.get("model") or "",
        "d": (rec.get("request_time") or "")[:10] or (rec.get("batch_id") or "")[:10],
        "t": rec.get("request_time") or "",
        # Golden means the evaluator filed nothing; an explicit "none" keeps the chip honest.
        "w": "none" if kind == "golden" else sev,
        "n": n,
        "c": rec.get("severity_counts") or {},
        "sid": rec.get("session_id") or "",
        "s": slug_by_trace.get(str(rec.get("trace_id") or "")),
    }


def _bench_file_rows(kind, path, slug_by_trace):
    rows = []
    try:
        with path.open(encoding="utf-8") as fh:
            for line in fh:
                try:
                    rec = json.loads(line)
                except ValueError:
                    continue
                row = _bench_row(rec, kind, slug_by_trace)
                if row:
                    rows.append(row)
    except OSError:
        return None
    return rows


def _bench_sample_rows(kind, samples):
    """Fallback for a product with no pipeline split: this build's own cases."""
    out = []
    for slug, _brief, row, _facts in samples:
        sev = row.get("w") or "none"
        n = int(row.get("n") or 0)
        if kind == "golden" and (n or sev != "none"):
            continue
        if kind == "bad" and sev not in ("P0", "P1"):
            continue
        sv = row.get("sv") or []
        out.append({
            "i": slug, "q": row.get("q") or "", "m": row.get("m") or "",
            "d": row.get("d") or "", "t": row.get("d") or "",
            "w": "none" if kind == "golden" else sev, "n": n,
            "c": {s: sv[k] for k, s in enumerate(SEVERITIES) if k < len(sv) and sv[k]},
            "sid": row.get("sid") or "", "s": slug,
        })
    return out


def _bench_meta(rows, sev_counts=None):
    dates = [r["d"] for r in rows if r.get("d")]
    models = Counter(r["m"] for r in rows if r.get("m"))
    meta = {"count": len(rows), "dates": [min(dates), max(dates)] if dates else [],
            "models": [{"id": k, "n": v} for k, v in models.most_common()]}
    if sev_counts is not None:
        meta["sev"] = sev_counts
    return meta


def bench_payload(root: Path, product, samples, slug_by_trace):
    """Bench's two lists, from the pipeline's own split when it published one.

    ``goldencase_<product>.jsonl`` holds cases the evaluator left alone (no problems at all);
    ``badcase_<product>.jsonl`` holds cases with a P0 or P1. Every row keeps the sample slug, so a
    row opens the same trajectory 具体数据 shows.
    """
    golden = _bench_file_rows("golden", root / f"goldencase_{product}.jsonl", slug_by_trace)
    bad = _bench_file_rows("bad", root / f"badcase_{product}.jsonl", slug_by_trace)
    if golden is None or bad is None:
        golden = _bench_sample_rows("golden", samples)
        bad = _bench_sample_rows("bad", samples)
    golden.sort(key=lambda r: r["t"], reverse=True)
    bad.sort(key=lambda r: r["t"], reverse=True)
    bad.sort(key=lambda r: SEVERITIES.index(r["w"]) if r["w"] in SEVERITIES else 9)
    for row in golden:
        row.pop("t", None)
    for row in bad:
        row.pop("t", None)
    sev = Counter(r["w"] for r in bad)
    return {
        "schema": BENCH_SCHEMA, "product": product,
        "kinds": {
            "golden": _bench_meta(golden),
            "bad": _bench_meta(bad, {s: sev.get(s, 0) for s in ("P0", "P1")}),
        },
        "rows": {"golden": golden, "bad": bad},
    }


# --------------------------------------------------------------------------- write

def tmp_path(path: Path) -> Path:
    """A per-process temp name next to ``path``: two writers never share one."""
    return path.with_name(f"{path.name}.{os.getpid()}.tmp")


def replace_bytes(path: Path, data: bytes) -> None:
    tmp = tmp_path(path)
    tmp.write_bytes(data)
    os.replace(tmp, path)


def write_json(path: Path, payload, gz=True):
    data = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    path.parent.mkdir(parents=True, exist_ok=True)
    replace_bytes(path, data)
    if gz:
        replace_bytes(Path(str(path) + ".gz"), gzip.compress(data, compresslevel=6, mtime=0))
        if _brotli is not None:
            replace_bytes(Path(str(path) + ".br"), _brotli.compress(data, quality=BROTLI_QUALITY))
    return len(data)


PREWARM_FIRST = 40
PREWARM_RECENT = 10


def prewarm_picks(rows) -> list:
    """First-page detail slugs: the first rows as listed plus the most recent days."""
    picks = [row.get("s") for row in rows[:PREWARM_FIRST]]
    picks += [row.get("s") for row in sorted(rows, key=lambda row: row.get("d") or "", reverse=True)[:PREWARM_RECENT]]
    seen = set()
    return [slug for slug in picks if slug and not (slug in seen or seen.add(slug))]


def write_prewarm(out_dir: Path, prewarm: dict) -> None:
    if not prewarm:
        return
    target = cache_root(out_dir) / "prewarm.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    replace_bytes(target, json.dumps(prewarm, ensure_ascii=False).encode("utf-8"))


RECALL_HEAD_ROWS = 400


def recall_session_key(row) -> str:
    """The sample page groups rows into sessions by this key (samples.js groupSessions)."""
    return f"{row.get('sp')}|{row.get('m')}|{row.get('sid') or row.get('s')}"


def recall_head(payload: dict, product: str) -> dict:
    """The first page of the sample list, small enough to paint before the full index lands.

    Rows are already in the list's default order (most severe first).  The head keeps every
    row of each session that appears in the first RECALL_HEAD_ROWS rows, so grouping it
    gives exactly the sessions — and their totals — the full index puts on its first page.
    """
    prod = payload["products"][product]
    rows = prod.get("rows") or []
    keys = {recall_session_key(row) for row in rows[:RECALL_HEAD_ROWS]}
    head = [row for row in rows if recall_session_key(row) in keys]
    sessions = len({recall_session_key(row) for row in rows})
    return {
        **{k: v for k, v in payload.items() if k != "products"},
        "products": {product: {**{k: v for k, v in prod.items() if k != "rows"}, "rows": head,
                               "head": {"rows": len(rows), "sessions": sessions}}},
    }


def write_prewarm_slugs(out_dir: Path) -> None:
    """Persist the first-page detail slugs from the published sample payloads.

    Used when a build is reused (nothing was rewritten): the server's prewarm
    thread then reads a 660-byte file instead of parsing the 20 MB index.
    """
    prewarm = {}
    for path in sorted(out_dir.glob("samples-*.json")):
        product = path.stem[len("samples-"):]
        try:
            rows = json.loads(path.read_text(encoding="utf-8"))["products"][product]["rows"]
        except (OSError, ValueError, KeyError):
            continue
        prewarm[product] = prewarm_picks(rows)
    write_prewarm(out_dir, prewarm)


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
    detail["trace_severity"] = trace_severity(detail, include_refs=True)
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
    files = cluster_tree_files(root)
    files += [p.with_name("item_index.jsonl") for p in files if p.with_name("item_index.jsonl").is_file()]
    files = [p for p in files if product_of(p.relative_to(root).parts[0])]
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
    # A deploy can leave the previous build alive for a moment; both then write the same
    # cache file.  A per-process tmp keeps the loser from renaming a file the winner moved.
    tmp = path.with_suffix(f"{path.suffix}.{os.getpid()}.tmp")
    try:
        with open(tmp, "wb") as fh:
            pickle.dump((taxonomy, index), fh, protocol=pickle.HIGHEST_PROTOCOL)
        os.replace(tmp, path)
    finally:
        tmp.unlink(missing_ok=True)
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
        bs.BUILD_VERSION, INPUT_INDEX_VERSION,
        pair.get("oh") or "", pair.get("ih") or "",
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


def _problem_index_from_path(path: str):
    match = re.search(r"(?:session_problem|problem)\[(\d+)\]", path or "")
    return int(match.group(1)) if match else None


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
                if not ident:
                    continue
                found = cluster_index.get((product, model, ident, path, problem.get("label")))
                if found:
                    break
                pi = _problem_index_from_path(path)
                if pi is not None:
                    turn = problem.get("turn")
                    label = problem.get("label")
                    found = (cluster_index.get((product, model, ident, "pi", f"{turn}:{pi}", label))
                             or cluster_index.get((product, model, ident, "pi", str(pi), label))
                             or cluster_index.get((product, model, ident, "pix", f"{turn}:{pi}"))
                             or cluster_index.get((product, model, ident, "pix", str(pi))))
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
    replace_bytes(gz, gzip.compress(path.read_bytes(), compresslevel=6, mtime=0))


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
            "product": pair["product"], "model": pair["model"], "date": detail["date"],
            "split": pair["split"], "output": pair["output"][0], "output_line": pair["output"][1],
            "row": row, "facts": facts, "brief": brief, "golden": golden,
            "im": pair.get("im"), "isp": pair.get("isp"),
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
        store.checkpoint()
        store.close()
    return results


SAMPLE_CACHE_VERSION = 1
# The per-sample cache is ~800 MB on AIME.  Rewriting it every ten minutes is
# 10 s of CPU and a large write even when only a handful of samples arrived.
# Keep a stable baseline plus a small delta of entries changed since it; compact
# only when the delta grows large or the baseline is missing/stale.
SAMPLE_DELTA = "samples-delta.pkl"
SAMPLE_COMPACT_ROWS = 8000


def load_sample_pickle(path: Path):
    try:
        with open(path, "rb") as fh:
            data = pickle.load(fh)
    except (OSError, EOFError, pickle.PickleError, ValueError):
        return {}
    if data.get("version") != SAMPLE_CACHE_VERSION or data.get("build") != bs.BUILD_VERSION:
        return {}
    return data.get("rows") or {}


def load_sample_cache(cache_dir: Path):
    """Merge the stable baseline with the delta written by recent builds."""
    base = load_sample_pickle(cache_dir / "samples.pkl")
    delta = load_sample_pickle(cache_dir / SAMPLE_DELTA)
    rows = dict(base)
    rows.update(delta)
    return rows, delta


def write_sample_pickle(path: Path, rows):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = tmp_path(path)
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
    cache_dir = cache_root(out_dir)
    pickled, sample_delta = load_sample_cache(cache_dir)
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
    changed_samples = {}

    def add_sample(pair, brief, row, facts, golden):
        nonlocal detail_bytes
        slug = pair.get("_slug") or pair.get("slug")
        row["idate"] = row.get("d")
        row["inp"] = 1 if (pair.get("input") or (pair.get("refs") or {}).get("input")) else 0
        row["im"] = pair.get("im") or row.get("m")
        row["isp"] = pair.get("isp") or row.get("sp")
        if golden:
            golden_pool[pair["product"]].append((golden["score"], golden["case"]))
        samples[pair["product"]].append((slug, brief, row, facts))
        stats["details"] += 1

    for pair, hit in hits:
        if not hit.get("refs"):
            # Older cache rows predate on-demand details; backfill the refs once.
            hit["refs"] = {"input": pair.get("input"), "compact": pair.get("compact")}
            changed_samples[pair["_slug"]] = hit
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
            for suffix in ("", ".gz", ".br"):
                Path(str(stale) + suffix).unlink(missing_ok=True)
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
                    "im": item.get("im"), "isp": item.get("isp"),
                }
                store.put_sample(entry)
                cached[item["slug"]] = entry
                changed_samples[item["slug"]] = entry
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
        baseline_path = cache_dir / "samples.pkl"
        merged_delta = dict(sample_delta)
        merged_delta.update(changed_samples)
        if not baseline_path.exists() or len(merged_delta) > SAMPLE_COMPACT_ROWS:
            compacted = {slug: cached[slug] for slug in slugs if slug in cached}
            write_sample_pickle(baseline_path, compacted)
            (cache_dir / SAMPLE_DELTA).unlink(missing_ok=True)
            stats["sample_cache"] = "compact"
        elif changed_samples:
            write_sample_pickle(cache_dir / SAMPLE_DELTA, merged_delta)
            stats["sample_cache"] = "delta"
        else:
            stats["sample_cache"] = "reuse"
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


def detail_slug(name: str) -> str:
    """``<slug>.json[.gz|.br][.<pid>.tmp]`` -> ``<slug>``."""
    name = re.sub(r"(\.\d+)?\.tmp$", "", name)
    name = re.sub(r"\.(gz|br)$", "", name)
    return name[:-len(".json")] if name.endswith(".json") else ""


def cleanup_samples(sample_dir: Path, slugs):
    """Drop details of samples no longer listed.

    Dotfiles (``.build-version``) belong to the detail builder, and every encoding
    or in-flight temp file of a listed slug is kept: the server may be writing it.
    """
    keep = set(slugs)
    if not sample_dir.exists():
        return
    for path in sample_dir.iterdir():
        if path.name.startswith(".") or detail_slug(path.name) in keep:
            continue
        if path.is_file():
            path.unlink(missing_ok=True)
        elif path.is_dir():
            shutil.rmtree(path, ignore_errors=True)


def payload_files_exist(out_dir: Path, ab_products=()) -> bool:
    try:
        data = json.loads((out_dir / "data.json").read_text(encoding="utf-8"))
        samples = json.loads((out_dir / "samples.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return False
    return (all((out_dir / f"data-{p}.json").exists() for p in (data.get("products") or {}))
            and all((out_dir / f"samples-{p}.json").exists() for p in (samples.get("products") or {}))
            and all((out_dir / f"labels-{p}.json").exists() for p in (samples.get("products") or {}))
            and all((out_dir / f"recall-{p}.json").exists() for p in (samples.get("products") or {}))
            and all((out_dir / f"trends-{p}.json").exists() for p in (data.get("products") or {}))
            and all((out_dir / f"bench-{p}.json").exists() for p in (samples.get("products") or {}))
            and all((out_dir / f"abtests-{p}.json").exists() for p in ab_products))


FORECAST_DIR = "4_forecast"


def prediction_feed_path(datasets: Path, product: str):
    """``4_forecast/<product>/prediction.json`` when the forecast pipeline published one."""
    path = datasets / FORECAST_DIR / product / "prediction.json"
    return path if path.is_file() else None


def prediction_payload(feed: dict, items=None) -> dict:
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
    if items:
        out["items"] = items
    return out


ASSET_CLASSES = {"a_share": "A股", "hk": "港股", "us": "美股", "index": "指数", "etf": "ETF",
                 "option": "期权", "bond": "债券", "commodity": "大宗商品", "crypto": "加密货币", "other": "其他"}
_MARKET_CLASS = {"A_share": "a_share", "HK": "hk", "US": "us"}
_TYPE_CLASS = {"index": "index", "etf": "etf", "option": "option", "bond": "bond",
               "commodity": "commodity", "future": "commodity", "crypto": "crypto"}


def asset_class(item: dict) -> str:
    """标的类别 of one forecast question: the export's own ``asset_class`` when it has one,
    else the commonest class among its targets (instrument type first, then market)."""
    given = item.get("asset_class")
    if given in ASSET_CLASSES:
        return ASSET_CLASSES[given]
    if isinstance(given, str) and given in ASSET_CLASSES.values():
        return given
    counts = Counter()
    for target in item.get("targets") or []:
        inst = target.get("instrument") if isinstance(target, dict) else None
        if not isinstance(inst, dict):
            continue
        key = _TYPE_CLASS.get(inst.get("type")) or _MARKET_CLASS.get(inst.get("market")) or "other"
        counts[key] += 1
    if not counts:
        return ASSET_CLASSES["other"]
    order = list(ASSET_CLASSES)
    return ASSET_CLASSES[max(counts, key=lambda k: (counts[k], -order.index(k)))]


def forecast_slug(product: str, version: str, trace_id: str) -> str:
    """Stable 10-hex id of a forecast answer that has no attribution sample (its detail is
    generated from the trajectory the export points at, see DetailBuilder.ensure_forecast)."""
    return hashlib.sha1(f"fc|{product}|{version}|{trace_id}".encode()).hexdigest()[:10]


def prediction_slugs(samples) -> dict:
    """Sample slug of an evaluated answer, so a forecast can open its trajectory:
    by (batch date, case id, version), else by (trace id, version)."""
    out = {}
    for slug, _, row, _ in samples:
        out[(row.get("d"), row.get("case"), row.get("m"))] = slug
        if row.get("tid"):
            out.setdefault(("t", row["tid"], row.get("m")), slug)
    return out


def prediction_items(path: Path, slugs=None, product=None):
    """Judged answers for the card's star map: one per (forecast question, version).

    Only revealed / pending questions are kept (the unverifiable ones are a count in 题量),
    with the question clipped, so a month of forecasts stays a small payload.
    """
    out = []
    numbers = {}  # question id -> position, so the page can group a question's versions
    try:
        with open(path, encoding="utf-8") as fh:
            for line in fh:
                try:
                    item = json.loads(line)
                except ValueError:
                    continue
                if not isinstance(item, dict) or item.get("status") not in ("revealed", "pending"):
                    continue
                row = {"q": clip(decode_question(item.get("question")), 60), "v": item.get("version"),
                       "r": item.get("result") or item.get("status"),
                       "t": item.get("forecast_type_label") or item.get("forecast_type") or "其他",
                       "c": asset_class(item), "d": item.get("batch_id"),
                       "i": numbers.setdefault(item.get("question_id") or id(item), len(numbers))}
                known = slugs or {}
                slug = (known.get((item.get("batch_id"), item.get("case_id"), item.get("version")))
                        or known.get(("t", item.get("trace_id"), item.get("version"))))
                if not slug and product and item.get("trajectory") and item.get("trace_id"):
                    slug = forecast_slug(product, item.get("version") or "", item["trace_id"])
                if slug:
                    row["s"] = slug
                    if product and item.get("trajectory") and item.get("trace_id"):
                        fslug = forecast_slug(product, item.get("version") or "", item["trace_id"])
                        if fslug != slug:
                            row["f"] = fslug
                if item.get("error_cause_label"):
                    row["e"] = item["error_cause_label"]
                out.append(row)
    except OSError:
        return []
    return out


def feed_signature(datasets: Path):
    """Cheap fingerprint of optional prediction feeds, part of the reuse marker."""
    parts = []
    feeds = list(datasets.glob(f"{FORECAST_DIR}/*/prediction*.json*"))
    for path in sorted(feeds):
        try:
            stat = path.stat()
        except OSError:
            continue
        parts.append([path.relative_to(datasets).as_posix(), stat.st_size, stat.st_mtime_ns])
    return hashlib.sha1(json.dumps(parts, separators=(",", ":")).encode()).hexdigest()


def release_signature(datasets: Path):
    """Cheap fingerprint of both release configs, part of the reuse marker."""
    parts = []
    for path in (datasets / "releases.json", RELEASES_CONFIG):
        try:
            stat = path.stat()
        except OSError:
            continue
        parts.append([path.name, stat.st_size, stat.st_mtime_ns])
    return hashlib.sha1(json.dumps(parts, separators=(",", ":")).encode()).hexdigest()


def input_signature(product_metas):
    """Fingerprint of the input files the payload's input aggregates were built from.

    The stats worker's sidecar pre-scans new input files, so a build can pick them up
    without scanning anything itself (``scanned == 0``).  That must not be read as
    "the input side did not change": a file delivered after its attribution (or an
    appended day) still has to invalidate the payload.  Hash ``(path, lines)`` per
    product so a new/renamed file or new rows always breaks the reuse marker.
    """
    parts = []
    for product, metas in sorted(product_metas.items()):
        parts.append([product, sorted([m.get("path"), int(m.get("lines") or 0)] for m in metas)])
    return hashlib.sha1(json.dumps(parts, separators=(",", ":")).encode()).hexdigest()


def build(datasets: Path, out_dir: Path, log=print, jobs: int = 0):
    started = time.time()
    rules = user_rules.load(datasets)
    rules_sig = rules.signature()
    if not datasets.is_dir():
        return empty_payloads("missing"), {}
    store = bs.BuildStore(cache_root(out_dir) / "build.sqlite3")
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
            # A copy of the published input outside input_roots is not scanned;
            # say so, so an accidental one is noticed instead of silently ignored.
            for ignored in snapshot_input_dirs(top, product):
                log(f"[build] ignoring non-published input tree: "
                    f"{ignored.relative_to(datasets).as_posix()}")
        timers["scan"] = round(time.time() - t0, 1)
        input_sig = input_signature(product_metas)

        t0 = time.time()
        pairs, pairing_info = pairs_from_keys(datasets, store, product_metas)
        timers["pair"] = round(time.time() - t0, 1)
        if not pairs:
            return empty_payloads("no-pairs"), {}
        input_keys = {}
        for metas in product_metas.values():
            for meta in metas:
                if meta.get("path"):
                    input_keys[meta["path"]] = (input_model(meta), meta.get("split") or "daily")
        for pair in pairs:
            ref = pair.get("input")
            if ref:
                pair["im"], pair["isp"] = input_keys.get(
                    ref[0], (pair["model"], pair["split"]))
        debug(f"paired {len(pairs)} rows")

        t0 = time.time()
        cluster_sig = cluster_signature(datasets, cache_root(out_dir))
        pairs_sig = hashlib.sha1(
            "\x1f".join([PAIRING_VERSION] + [
                "%s|%s|%s" % (
                    f"{p['input'][0]}:{p['input'][1]}" if p.get("input") else "",
                    f"{p['compact'][0]}:{p['compact'][1]}" if p.get("compact") else "",
                    p.get("oh") or "")
                for p in pairs
            ]).encode()).hexdigest()
        feed_sig = feed_signature(datasets)
        release_sig = release_signature(datasets)
        ab_sig = ab_test.rounds_signature(datasets)
        # Only this deployment's products have payloads written; a shared datasets root
        # can contain another product's ab_test (e.g. 问财 reads a root that also has
        # 1_aime/ab_test), and requiring that product's abtests-*.json here would
        # silently disable payload reuse forever.
        ab_expected = {product for product in ENABLED if ab_test.ab_round_dirs(datasets, product)}
        scanned = sum(v["scanned"] for v in scan_info.values())
        marker = store.get_meta("complete")
        # A small, stable set of outputs may never pair (missing input / compact on
        # the data side).  A permanently-rebuilding board costs a full scan and
        # rewrites the 20 MB index every 10 minutes, so reuse is keyed on the
        # unmatched set itself: any new or fixed output changes the signature.
        unmatched_sig = pairing_info.get("unmatched_sig") or ""
        if (pairing_info.get("mode") == "key" and scanned == 0
                and marker and marker.get("unmatched") == unmatched_sig
                and marker.get("build") == bs.BUILD_VERSION
                and marker.get("payload") == PAYLOAD_VERSION
                and marker.get("rules") == rules_sig
                and marker.get("datasets") == str(datasets)
                and marker.get("pairs_sig") == pairs_sig
                and marker.get("cluster") == cluster_sig
                and marker.get("feed") == feed_sig
                and marker.get("releases") == release_sig
                and marker.get("ab") == ab_sig
                and marker.get("input") == input_sig
                and (out_dir / "data.json").exists() and (out_dir / "samples.json").exists()
                and (out_dir / "samples").is_dir() and payload_files_exist(out_dir, ab_expected)):
            timers["cluster"] = round(time.time() - t0, 1)
            timers["samples"] = 0.0
            timers["aggregate"] = 0.0
            timers["write"] = 0.0
            try:
                if not (cache_root(out_dir) / "prewarm.json").exists():
                    write_prewarm_slugs(out_dir)
            except (OSError, ValueError):
                pass
            summary = Counter({
                "pairs": len(pairs), "pairing": pairing_info.get("mode"), "reused": 1,
                "unmatched": pairing_info.get("unmatched_files", 0),
                "scan_files": sum(v["files"] for v in scan_info.values()),
                "scan_scanned": 0, "scan_cached": sum(v["cached"] for v in scan_info.values()),
                **{f"t_{k}": v for k, v in timers.items()},
                "seconds": round(time.time() - started, 1),
            })
            return (None, None), summary

        taxonomy, cluster_index = load_clusters_cached(datasets, cluster_sig, cache_root(out_dir))
        timers["cluster"] = round(time.time() - t0, 1)

        t0 = time.time()
        samples, golden_pool, stats = build_samples(
            pairs, datasets, out_dir, store, reader, cluster_index, cluster_sig, log, jobs)
        timers["samples"] = round(time.time() - t0, 1)

        # 用户类型在样本缓存之后统一打标：规则/名单变了不用重读输入，也能让每个样本拿到新类型。
        all_rows = [row for rows in samples.values() for _, _, row, _ in rows]
        user_stats = rules.question_stats((row.get("uid"), row.get("q")) for row in all_rows)
        for rows in samples.values():
            for _, _, row, _ in rows:
                row["ut"] = rules.classify(row.get("uid"), user_stats)
                if row["sp"] == "lost" or rules.is_lost(row.get("uid")):
                    row["ul"] = 1
                else:
                    row.pop("ul", None)

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
            payload = input_payload(metas, store, product)
            products[product]["input"] = payload
            products[product]["kpi"]["inputs"] = payload["records"]
            products[product]["kpi"]["lost"] = payload["lost"]
            input_records, input_sessions, input_traces = daily_input_stats(metas, store)
            products[product]["daily"] = daily_payload(
                samples[product], input_records, input_sessions, input_traces)
            feed = prediction_feed_path(datasets, product)
            if feed:
                try:
                    data = json.loads(feed.read_text(encoding="utf-8"))
                except (OSError, ValueError) as exc:
                    log(f"[build] skip {feed}: {exc}")
                else:
                    if isinstance(data, dict):
                        items = prediction_items(feed.parent / "prediction_items.jsonl", prediction_slugs(samples[product]), product)
                        products[product]["prediction"] = prediction_payload(data, items)
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
        labels = {}
        for product, rows in samples.items():
            rows_sorted = sorted(rows, key=lambda s: (WORST_KEYS.index(s[2]["w"]), -s[2]["n"], s[2]["d"]))
            # The matrix files a sample under its voted scene; carry it where the plain
            # task/skill fallback would disagree, so a matrix cell and its 具体数据 filter agree.
            scene = scene_votes(product, rows)
            for s in rows_sorted:
                sc = scene_of(s[1], scene)
                if sc != (s[2].get("task") or s[2].get("skill") or NO_SCENE):
                    s[2]["sc"] = sc
                else:
                    s[2].pop("sc", None)
            if "input" in products.get(product, {}):
                mark_evaluated(products[product]["input"], [s[2] for s in rows_sorted])
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
            labels[product] = {"schema": 2, "product": product,
                               "labels": [s[2].get(LABEL_FIELD) or "" for s in rows_sorted]}
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
        ab_bytes = 0
        input_traces = set(store.input_locations())
        for product in products:
            payload = ab_test.ab_payload(datasets, product, generated, samples[product],
                                         input_traces=input_traces)
            if not payload:
                continue
            latest = payload["rounds"][-1]
            # The shell carries only the entry point; the rounds themselves stay lazy.
            products[product]["ab"] = {
                "url": f"abtests-{product}.json", "rounds": len(payload["rounds"]),
                "label": latest["label"], "targets": latest["targets"],
                "paired": latest["sides"]["after"] is not None,
                "online": latest["sides"]["online"] is not None,
            }
            ab_bytes += write_json(out_dir / f"abtests-{product}.json", payload)
        for stale in out_dir.glob("abtests-*.json*"):
            product = stale.name[len("abtests-"):].split(".", 1)[0]
            if product not in products or product not in ab_expected:
                stale.unlink(missing_ok=True)
        data_bytes = 0
        trend_bytes = 0
        for product, payload in products.items():
            data_bytes += write_json(out_dir / f"data-{product}.json", {
                "schema": 2, "generated_at": generated, "product": product,
                "products": {product: payload},
            })
            trend_bytes += write_json(out_dir / f"trends-{product}.json", trend_payload(
                product, samples[product], release_entries(datasets, product), generated))
        data_bytes += write_json(out_dir / "data.json", shared)
        for stale in out_dir.glob("data-*.json*"):
            product = stale.name[len("data-"):].split(".", 1)[0]
            if product not in products:
                stale.unlink(missing_ok=True)
        index_bytes = write_json(out_dir / "samples.json", index)
        for product, payload in indexes.items():
            index_bytes += write_json(out_dir / f"samples-{product}.json", payload)
            index_bytes += write_json(out_dir / f"recall-{product}.json", recall_head(payload, product))
        for product, payload in labels.items():
            index_bytes += write_json(out_dir / f"labels-{product}.json", payload)
        for stale in out_dir.glob("samples-*.json*"):
            product = stale.name[len("samples-"):].split(".", 1)[0]
            if product not in indexes:
                stale.unlink(missing_ok=True)
        for stale in out_dir.glob("labels-*.json*"):
            product = stale.name[len("labels-"):].split(".", 1)[0]
            if product not in labels:
                stale.unlink(missing_ok=True)
        for stale in out_dir.glob("recall-*.json*"):
            product = stale.name[len("recall-"):].split(".", 1)[0]
            if product not in indexes:
                stale.unlink(missing_ok=True)
        # Bench reads the pipeline's golden/badcase split when the datasets root has one, and
        # falls back to this build's own cases otherwise; either way the rows carry a slug.
        slug_by_trace = {
            str((brief.get("ids") or {}).get("trace")): slug
            for slug, brief, _row, _facts in all_samples
            if (brief.get("ids") or {}).get("trace")
        }
        for product in samples:
            payload = bench_payload(datasets, product, samples[product], slug_by_trace)
            payload["generated_at"] = generated
            write_json(out_dir / f"bench-{product}.json", payload)
        for stale in out_dir.glob("bench-*.json*"):
            product = stale.name[len("bench-"):].split(".", 1)[0]
            if product not in samples:
                stale.unlink(missing_ok=True)
        for stale in out_dir.glob("trends-*.json*"):
            product = stale.name[len("trends-"):].split(".", 1)[0]
            if product not in products:
                stale.unlink(missing_ok=True)
        timers["write"] = round(time.time() - t0, 1)

        # The server needs 40 first-page slugs after every build.  Recounting them
        # from the 28 MB samples index stalls the request threads while json parses;
        # write the tiny list here instead.
        try:
            write_prewarm(out_dir, {
                product: prewarm_picks(((payload.get("products") or {}).get(product) or {}).get("rows") or [])
                for product, payload in indexes.items()
            })
        except OSError as exc:
            debug(f"prewarm list not written: {exc}")

        slugs = [s[0] for rows in samples.values() for s in rows]
        cleanup_samples(out_dir / "samples", slugs)
        for stale in out_dir.glob(".samples-*"):
            shutil.rmtree(stale, ignore_errors=True)
        store.delete_samples_not(slugs)
        store.set_meta("complete", {
            "build": bs.BUILD_VERSION, "payload": PAYLOAD_VERSION, "pairs": len(pairs),
            "rules": rules_sig, "datasets": str(datasets),
            "pairs_sig": pairs_sig, "unmatched": pairing_info.get("unmatched_sig") or "",
            "cluster": cluster_sig, "feed": feed_sig,
            "releases": release_sig, "ab": ab_sig, "input": input_sig,
            "at": generated,
        })
        store.commit()

        summary = Counter(stats)
        summary.update({
            "pairs": len(pairs), "unmatched": pairing_info.get("unmatched_files", 0),
            "data_kb": round(data_bytes / 1024),
            "trend_kb": round(trend_bytes / 1024),
            "ab_kb": round(ab_bytes / 1024),
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
        store.checkpoint()
        store.close()


# ----------------------------------------------------------------- data absence

ABSENCE_DIR = "dashboard_data_absence"
ABSENCE_SKIP = {"compact", "cluster", "comparison", ".runs", ".delivery"}


def product_top(datasets: Path, product: str):
    """``<datasets>/<n>_<product>`` for one product, else None."""
    for top in sorted(datasets.glob("*")):
        if top.is_dir() and product_of(top.name) == product:
            return top
    return None


def _days_named(folder: Path, pattern: str):
    days = set()
    for path in folder.glob(pattern):
        match = DATE_RE.search(path.name)
        if match and path.is_file():
            days.add(match.group(1))
    return sorted(days)


def _day_spans(days):
    """Compress consecutive dates to ``a～b`` so 26 missing days read as one range."""
    spans, start, prev = [], None, None
    for day in days:
        if start is None:
            start = prev = day
            continue
        if (datetime.strptime(day, "%Y-%m-%d") - datetime.strptime(prev, "%Y-%m-%d")).days == 1:
            prev = day
            continue
        spans.append(start if start == prev else f"{start}～{prev}")
        start = prev = day
    if start is not None:
        spans.append(start if start == prev else f"{start}～{prev}")
    return spans


def _rel(path: Path, root: Path):
    try:
        return path.relative_to(root).as_posix()
    except ValueError:
        return str(path)


def absence_markdown(report):
    payload = report.get("payload") or {}
    eval_out = report.get("eval_output") or {}
    modules = report.get("modules") or {}
    days = eval_out.get("evaluated_days") or []
    input_days = eval_out.get("input_days") or []
    lines = [
        f"# {report['label']} · 看板数据缺口",
        "",
        f"- 生成时间：{report['generated_at']}",
        f"- 数据根：{report['datasets']}",
        f"- 评测输入：{len(input_days)} 天（{', '.join(_day_spans(input_days)) or '—'}）",
        f"- 评测输出：{len(days)} 天（{', '.join(days) or '—'}）",
        f"- 评测 Trace：输入 {payload.get('input_traces', '—')} · 已评测 {payload.get('evaluated_traces', '—')}",
    ]
    if payload.get("problems") is not None:
        lines.append(f"- 问题：{payload.get('problems')}（已聚类 {payload.get('clustered', '—')} / 未聚类 {payload.get('unclustered', '—')}）")
    lines += ["", "## 评测输出覆盖", "", "| 模型 | 输入天数 | attribution | compact | 缺失日期 |", "|---|---|---|---|---|"]
    for model in eval_out.get("models") or []:
        lines.append(
            f"| {model['id']} | {len(model['input_days'])} | {len(model['attribution_days'])} | "
            f"{len(model['compact_days'])} | {'、'.join(_day_spans(model['missing_days'])) or '—'} |"
        )
    cluster = report.get("cluster") or {}
    lines += ["", "## 聚类落点", "", "| 日期 | 已评测 | 有问题 | 已聚类 |", "|---|---|---|---|"]
    for day in cluster.get("days") or []:
        lines.append(f"| {day['date']} | {day['evaluated']} | {day['problem_rows']} | {day['clustered']} |")
    if not (cluster.get("days") or []):
        lines.append("| — | — | — | — |")
    lines += ["", "## 模块", "", "| 模块 | 状态 | 位置 / 说明 |", "|---|---|---|"]
    for key, label in (("ab_test", "A/B Test"), ("releases", "发版配置"), ("prediction", "预测 feed"), ("cluster", "聚类映射")):
        item = modules.get(key) or {}
        state = "可用" if item.get("available") else "**缺失**"
        lines.append(f"| {label} | {state} | {item.get('note') or item.get('path') or '—'} |")
    if report.get("missing"):
        lines += ["", "## 缺失明细"]
        for item in report["missing"]:
            if item["kind"] == "eval_output":
                lines.append(
                    f"- `{item['model']}`：缺 attribution {len(item['missing_attribution'])} 天、"
                    f"compact {len(item['missing_compact'])} 天；{', '.join(_day_spans(item['dates'])) or '—'}"
                )
            elif item["kind"] == "cluster_day":
                lines.append(f"- {item['date']}：{item['problem_rows']} 条有问题样本没有聚类落点（{item['note']}）")
            else:
                lines.append(f"- {item.get('note') or item['kind']}（{item.get('path') or '—'}）")
    return "\n".join(lines) + "\n"


def write_data_absence(datasets: Path, product: str, out_dir: Path):
    """Write the board's data gaps for one product next to its datasets.

    The destination is ``<datasets>/<n>_<product>/dashboard_data_absence/`` (``EVAL_ABSENCE_DIR``
    overrides it).  A product without that directory is left alone: a shared datasets root can
    hold several products, and the report must never create data under another product.
    """
    top = product_top(datasets, product)
    if top is None:
        return None
    override = os.environ.get("EVAL_ABSENCE_DIR")
    target = Path(override) if override else top / ABSENCE_DIR
    if override:
        target.mkdir(parents=True, exist_ok=True)
    if not target.is_dir():
        return None

    inputs, outputs = {}, {}
    input_root = top / "eval_input" / "0_daily_eval_input"
    for model_dir in sorted(p for p in input_root.glob("*") if p.is_dir() and not p.name.startswith(".")):
        model_days = _days_named(model_dir, "*.jsonl")
        if model_days:
            inputs[model_dir.name] = model_days
    for split_dir in sorted(p for p in (top / "eval_output").glob("*") if p.is_dir() and not p.name.startswith(".")):
        for model_dir in sorted(p for p in split_dir.glob("*") if p.is_dir() and not p.name.startswith(".")):
            if model_dir.name in ABSENCE_SKIP:
                continue
            attribution = _days_named(model_dir, f"{model_dir.name}_attribution-*.jsonl")
            compact = _days_named(model_dir / "compact", f"{model_dir.name}_compact-*.jsonl")
            if not attribution and not compact:
                continue
            bucket = outputs.setdefault(model_dir.name, {"attribution": set(), "compact": set()})
            bucket["attribution"].update(attribution)
            bucket["compact"].update(compact)

    known = PRODUCTS[product]["models"]
    models = [m for m in known if m in inputs or m in outputs]
    models += sorted((set(inputs) | set(outputs)) - set(known))
    eval_models, missing = [], []
    for model in models:
        in_days = inputs.get(model, [])
        attribution_days = sorted(outputs.get(model, {}).get("attribution") or [])
        compact_days = sorted(outputs.get(model, {}).get("compact") or [])
        missing_attribution = [day for day in in_days if day not in set(attribution_days)]
        missing_compact = [day for day in in_days if day not in set(compact_days)]
        missing_days = sorted(set(missing_attribution) | set(missing_compact))
        eval_models.append({
            "id": model, "input_days": in_days,
            "attribution_days": attribution_days, "compact_days": compact_days,
            "missing_days": missing_days,
            "missing_attribution": missing_attribution, "missing_compact": missing_compact,
        })
        if missing_days:
            missing.append({"kind": "eval_output", "model": model, "dates": missing_days,
                            "missing_attribution": missing_attribution,
                            "missing_compact": missing_compact})

    frames = defaultdict(lambda: [0, 0, 0])
    index_path = out_dir / f"samples-{product}.json"
    try:
        rows = json.loads(index_path.read_text(encoding="utf-8"))["products"][product]["rows"]
    except (OSError, ValueError, KeyError):
        rows = []
    for row in rows:
        day = row.get("d")
        if not day:
            continue
        frames[day][2] += 1
        if row.get("n"):
            frames[day][0] += 1
            if row.get("pt") or row.get("st"):
                frames[day][1] += 1
    cluster_days = [{"date": day, "evaluated": counts[2], "problem_rows": counts[0], "clustered": counts[1]}
                    for day, counts in sorted(frames.items())]
    for day in cluster_days:
        if day["problem_rows"] and not day["clustered"]:
            missing.append({"kind": "cluster_day", "date": day["date"], "problem_rows": day["problem_rows"],
                            "note": "已评测出问题但没有聚类落点：矩阵趋势与问题趋势缺这一天"})

    cluster_models = set()
    for split_dir in (top / "eval_output").glob("*"):
        for model_dir in (split_dir / "cluster").glob("*"):
            if (model_dir / "item_index.jsonl").is_file():
                cluster_models.add(model_dir.name)

    rounds = ab_test.ab_round_dirs(datasets, product)
    releases = release_entries(datasets, product)
    feed = prediction_feed_path(datasets, product)
    modules = {
        "ab_test": {
            "available": bool(rounds), "path": _rel(top / ab_test.AB_DIR, datasets),
            "rounds": len(rounds),
            "note": "" if rounds else "没有 ab_test 轮次：版本对比为空、聚类矩阵无 A/B Test 入口",
        },
        "releases": {
            "available": bool(releases), "path": _rel(release_source(datasets), datasets),
            "entries": releases,
            "note": "" if releases else "没有发版日期：趋势图不画发版红线",
        },
        "prediction": {
            "available": bool(feed), "path": _rel(feed, datasets) if feed else _rel(datasets / FORECAST_DIR / product, datasets),
            "note": "" if feed else "没有预测 feed：预测体系只显示暂无预测数据",
        },
        "cluster": {
            "available": bool(cluster_models), "path": _rel(top / "eval_output", datasets),
            "models": sorted(cluster_models),
            "note": "" if cluster_models else "没有聚类映射：矩阵与聚类体系无落点",
        },
    }
    for kind in ("ab_test", "releases", "prediction", "cluster"):
        if not modules[kind]["available"]:
            missing.append({"kind": kind, "path": modules[kind]["path"], "note": modules[kind]["note"]})

    payload = {}
    try:
        payload = json.loads((out_dir / f"data-{product}.json").read_text(encoding="utf-8"))["products"][product]
    except (OSError, ValueError, KeyError):
        payload = {}
    kpi = payload.get("kpi") or {}
    report = {
        "schema": 1,
        "generated_at": iso_now(),
        "product": product,
        "label": PRODUCTS[product]["label"],
        "datasets": str(datasets),
        "product_dir": top.name,
        "payload": {
            "input_traces": (payload.get("input") or {}).get("traces"),
            "evaluated_traces": kpi.get("traces"),
            "sessions": kpi.get("sessions"),
            "problems": kpi.get("problems"),
            "clustered": kpi.get("clustered"),
            "unclustered": kpi.get("unclustered"),
            "dates": [day.get("d") for day in payload.get("dates") or []],
            "range": payload.get("range"),
        },
        "eval_output": {
            "input_root": _rel(input_root, datasets),
            "output_root": _rel(top / "eval_output", datasets),
            "input_days": sorted({day for days in inputs.values() for day in days}),
            "evaluated_days": sorted({day for bucket in outputs.values()
                                      for day in bucket["attribution"] | bucket["compact"]}),
            "models": eval_models,
        },
        "cluster": {"models": sorted(cluster_models), "days": cluster_days},
        "modules": modules,
        "missing": missing,
    }
    write_json(target / f"{product}-data-absence.json", report, gz=False)
    (target / f"{product}-data-absence.md").write_text(absence_markdown(report), encoding="utf-8")
    return target


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--datasets", type=Path,
                    default=None, help="datasets root (default: EVAL_DATASETS, the production mount, or <repo>/datasets)")
    ap.add_argument("--out", type=Path, default=STATIC, help="static directory receiving the payloads")
    ap.add_argument("--keep-on-empty", action="store_true",
                    help="leave the previous payloads in place when the source yields no pairs "
                         "(used by the server's scheduled refresh so a briefly empty mount cannot wipe the board)")
    ap.add_argument("--jobs", type=int, default=0,
                    help="parallel input-file scans (default: auto, up to 4; 1 disables)")
    args = ap.parse_args(argv)
    args.datasets = args.datasets or default_datasets()
    with build_lock(cache_root(args.out)):
        return run(args)


@contextlib.contextmanager
def build_lock(cache_dir: Path):
    """One build at a time per output tree, across processes.

    The server's scheduled refresh, a deploy-time build and a manual run all write
    the same payloads and ``cache/build.sqlite3``; the second waits for the first
    (and then usually reuses its result) instead of racing it.
    """
    cache_dir.mkdir(parents=True, exist_ok=True)
    with open(cache_dir / "build.lock", "a+") as fh:
        fcntl.flock(fh, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(fh, fcntl.LOCK_UN)


def run(args):
    (data, index), stats = build(args.datasets.resolve(), args.out, jobs=args.jobs)
    # A reused build changed nothing, so last round's absence report still holds; rewriting it
    # meant re-parsing the 40+ MB payloads every 10 minutes for the same answer.
    if not stats.get("reused"):
        try:
            for product in sorted(ENABLED):
                write_data_absence(args.datasets.resolve(), product, args.out)
        except Exception as exc:  # noqa: BLE001 - the report must never fail the build
            print(f"[absence] {exc}", file=sys.stderr)
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
        for stale in list(out.glob("data-*.json*")) + list(out.glob("samples-*.json*")) + list(out.glob("labels-*.json*")) + list(out.glob("trends-*.json*")) + list(out.glob("abtests-*.json*")):
            stale.unlink(missing_ok=True)
        # build() writes every payload itself; only the empty shell is left to write.
        stats = {**stats, "data_kb": round(write_json(out / "data.json", data) / 1024),
                 "trend_kb": 0, "ab_kb": 0,
                 "index_kb": round(write_json(out / "samples.json", index) / 1024)}
    summary = {"pairs": data["source"].get("pairs", 0), "pairing": data["source"].get("mode"), **stats}
    print(json.dumps(summary, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
