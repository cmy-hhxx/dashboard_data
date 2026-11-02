#!/usr/bin/env python3
"""Build every dashboard payload from the evaluation datasets.

Layout read under the datasets root (repo ``datasets/`` locally, ``EVAL_DATASETS`` otherwise)::

    对应关系.csv                                   one row per input / attribution / compact triple
    <n>_<product>/eval_input/[<split dir>/]<model>/<date>.jsonl
    <n>_<product>/eval_output/<split>/<model>/<model>_attribution-<date>.jsonl
    <n>_<product>/eval_output/<split>/<model>/compact/<model>_compact-<date>.jsonl
    <n>_<product>/eval_output/**/cluster/<model>/{cluster_tree.json,item_index.jsonl}

The CSV pins each attribution line to its input and compact line (verified by SHA-256).
Without it, triples are paired inside one model/date file by session id + request time,
falling back to file order for duplicates.

Outputs, each with a ``.gz`` twin::

    static/data.json              aggregates for the 数据 and 评测体系 views
    static/samples.json           the recall index for the 样本 view
    static/samples/<slug>.json    one sample: trimmed input, attribution and compact
"""
from __future__ import annotations

import argparse
import csv
import gzip
import hashlib
import json
import os
import re
import shutil
import sys
import tempfile
import time
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import unquote

DASHBOARD = Path(__file__).resolve().parent
REPO = DASHBOARD.parent
STATIC = DASHBOARD / "static"
PRODUCTION_DATASETS = Path("/mnt/fin_bench/code_and_clean_data/datasets")


def default_datasets():
    """EVAL_DATASETS, else the mounted production tree, else <repo>/datasets."""
    if os.environ.get("EVAL_DATASETS"):
        return Path(os.environ["EVAL_DATASETS"]).expanduser()
    return PRODUCTION_DATASETS if PRODUCTION_DATASETS.is_dir() else REPO / "datasets"

SEVERITIES = ["P0", "P1", "P2", "P3", "P4"]
WORST_KEYS = SEVERITIES + ["none"]

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

class LineCache:
    """Random access to JSONL lines without holding whole files in memory.

    Evaluation inputs are 0.5–2.4 GB each. Indexing offsets costs one sequential
    read; fetching a line seeks to its byte range, so the builder only keeps the
    records it is actively turning into a sample.
    """

    def __init__(self, root: Path):
        self.root = root
        self._offsets: dict[str, list[int]] = {}
        self._size: dict[str, int] = {}

    def _load_offsets(self, rel: str) -> list[int]:
        offsets, pos = [0], 0
        with open(self.root / rel, "rb", buffering=8 << 20) as fh:
            for raw in fh:
                pos += len(raw)
                offsets.append(pos)
        if len(offsets) > 1 and offsets[-1] == pos:
            offsets.pop()
        self._offsets[rel] = offsets
        self._size[rel] = pos
        return offsets

    def iter_lines(self, rel: str):
        """Stream lines while recording offsets, so ``line()`` stays cheap later."""
        if rel in self._offsets:
            for number in range(1, len(self._offsets[rel]) + 1):
                yield self.line(rel, number)
            return
        offsets, pos = [0], 0
        with open(self.root / rel, "rb", buffering=8 << 20) as fh:
            for raw in fh:
                pos += len(raw)
                offsets.append(pos)
                yield raw[:-1] if raw.endswith(b"\n") else raw
        if len(offsets) > 1 and offsets[-1] == pos:
            offsets.pop()
        self._offsets[rel] = offsets
        self._size[rel] = pos

    def count(self, rel: str) -> int:
        return len(self._offsets.get(rel) or self._load_offsets(rel))

    def line(self, rel: str, number: int) -> bytes:
        offsets = self._offsets.get(rel) or self._load_offsets(rel)
        start = offsets[number - 1]
        end = offsets[number] if number < len(offsets) else self._size[rel]
        # Unbuffered: buffered readers prefetch far past a single sought line,
        # which multiplies I/O by the sample count on multi-GB inputs.
        with open(self.root / rel, "rb", buffering=0) as fh:
            fh.seek(start)
            raw = fh.read(end - start)
        return raw[:-1] if raw.endswith(b"\n") else raw

    def drop(self, rel: str):
        self._offsets.pop(rel, None)
        self._size.pop(rel, None)


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


def count_records(path: Path) -> int:
    """Count non-empty JSONL records without decoding them."""
    lines, last = 0, b""
    with open(path, "rb", buffering=0) as fh:
        while chunk := fh.read(8 << 20):
            lines += chunk.count(b"\n")
            last = chunk[-1:]
    if last and last != b"\n":
        lines += 1
    return lines


def load_counts(path: Path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def save_counts(path: Path, counts: dict):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(counts, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    os.replace(tmp, path)


def input_total(datasets: Path, top: Path, product: str, cache: LineCache, counts: dict):
    """Every input record, including queued days without an attribution output.

    AIME lost-user inputs currently come from ``.archive/1_lost_user_input``; the
    smaller ``eval_input/1_lost_user_eval`` copy is excluded so days are not
    counted twice while that evaluation is in flight.
    """
    files = [f for f in (top / "eval_input").rglob("*.jsonl") if "1_lost_user_eval" not in f.parts]
    if product == "aime":
        files += list((top / ".archive" / "1_lost_user_input").rglob("*.jsonl"))
    todo = []
    total = 0
    for path in files:
        rel = path.relative_to(datasets).as_posix()
        if rel in cache._offsets:  # already streamed while pairing
            total += cache.count(rel)
            continue
        try:
            stat = path.stat()
        except OSError:
            continue
        entry = counts.get(rel)
        if entry and entry.get("size") == stat.st_size and entry.get("mtime_ns") == stat.st_mtime_ns:
            total += entry["lines"]
        else:
            todo.append((rel, path, stat))
    if todo:
        with ThreadPoolExecutor(max_workers=min(8, len(todo))) as pool:
            results = list(pool.map(lambda item: count_records(item[1]), todo))
        for (rel, path, stat), lines in zip(todo, results):
            counts[rel] = {"size": stat.st_size, "mtime_ns": stat.st_mtime_ns, "lines": lines}
            total += lines
    live = {path.relative_to(datasets).as_posix() for path in files}
    for rel in list(counts):
        if rel not in live:
            counts.pop(rel)
    return total


def pairs_from_csv(root: Path, cache: LineCache):
    path = root / "对应关系.csv"
    with open(path, encoding="utf-8-sig", newline="") as fh:
        rows = list(csv.DictReader(fh))
    pairs, mismatched = [], 0
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
                raw = cache.line(*ref)
            except (OSError, IndexError):
                pair[key] = None
                mismatched += 1
                continue
            if hashlib.sha256(raw + b"\n").hexdigest() != row[sha_col]:
                mismatched += 1
        pairs.append(pair)
    return pairs, {"mode": "csv", "rows": len(rows), "sha_mismatch": mismatched}


def pair_key(meta: dict) -> tuple:
    rt = str(meta.get("request_time") or "").replace("T", " ")[:19]
    return (meta.get("session_id") or meta.get("thread_id") or meta.get("trace_id"), rt)


RAW_SID = re.compile(rb'"session_id"\s*:\s*"([^"]*)"')
RAW_THREAD = re.compile(rb'"thread_id"\s*:\s*"([^"]*)"')
RAW_TRACE = re.compile(rb'"trace_id"\s*:\s*"([^"]*)"')
RAW_RT = re.compile(rb'"request_time"\s*:\s*"([^"]*)"')


def raw_key(raw: bytes):
    """Read the join key from the head of a large JSONL record without parsing it."""
    head = raw[:65536]
    match = RAW_SID.search(head) or RAW_THREAD.search(head) or RAW_TRACE.search(head)
    if not match:
        return None
    clock = RAW_RT.search(head)
    rt = clock.group(1).decode("utf-8", "replace").replace("T", " ")[:19] if clock else ""
    return match.group(1).decode("utf-8", "replace"), rt


def debug(message):
    if os.environ.get("EVAL_BUILD_DEBUG"):
        print(f"[build] {message}", file=sys.stderr, flush=True)


def pairs_from_keys(root: Path, cache: LineCache):
    """Pair by session id + request time inside each model/date file; duplicates in file order."""
    pairs, unmatched = [], Counter()
    for out in sorted(root.glob("*/eval_output/*/*/*_attribution-*.jsonl")):
        rel = out.relative_to(root).as_posix()
        m = OUTPUT_FILE.match(rel)
        if not m:
            continue
        product, split = product_of(m["product"]), SPLITS.get(m["split"])
        if not product or not split:
            continue
        model, date = m["model"], m["date"]
        inp_rels = input_candidates(root, m["product"], split, model, date)
        debug(f"pair {rel} inputs={len(inp_rels)}")
        cmp_path = out.parent / "compact" / f"{model}_compact-{date}.jsonl"
        cmp_rel = cmp_path.relative_to(root).as_posix() if cmp_path.exists() else None

        def index(rels, meta_of):
            slots = defaultdict(list)
            for rel_path in rels:
                for n, raw in enumerate(cache.iter_lines(rel_path), 1):
                    key = raw_key(raw)
                    if key is None:
                        try:
                            key = pair_key(meta_of(json.loads(raw)))
                        except (ValueError, TypeError):
                            continue
                    slots[key].append((rel_path, n))
            return slots

        def input_meta(d):
            meta = dict(d.get("meta") or {})
            if not meta.get("session_id") and d.get("traces"):
                meta["session_id"] = (d["traces"][0].get("meta") or {}).get("session_id")
            meta.setdefault("request_time", d.get("request_time"))
            return meta

        inputs = index(inp_rels, input_meta)
        compacts = index([cmp_rel] if cmp_rel else [], lambda d: d.get("session_meta") or {})
        for n, raw in enumerate(cache.iter_lines(rel), 1):
            try:
                key = pair_key(json.loads(raw).get("session_meta") or {})
            except ValueError:
                continue
            inp = inputs[key].pop(0) if inputs.get(key) else None
            comp = compacts[key].pop(0) if compacts.get(key) else None
            if inp is None:
                unmatched["input"] += 1
            if comp is None:
                unmatched["compact"] += 1
            pairs.append({
                "product": product, "split": split, "model": model, "date": date, "run": "",
                "input": inp,
                "output": (rel, n),
                "compact": comp,
            })
    return pairs, {"mode": "key", "rows": len(pairs), "unmatched": dict(unmatched)}


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
            elif level == 3:
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
                loc = place(turn, int(m[1]), ev.get("evidence_id", "").split("_", 6)[-1] if m else "", ev.get("quote")) if m else None
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
    for key, value in (("task", first_meta.get("task")), ("diff", first_meta.get("difficulty")),
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

    out = {
        "label": PRODUCTS[product]["label"],
        "kpi": {
            "sessions": total, "problems": len(problems_all), "flagged": total - worst["none"], "clean": worst["none"],
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


def anatomy_candidate(detail):
    """One mid-sized single-trace example per product, selected while the input is in memory."""
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
        "question": detail["question"],
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
        "compact": {
            k: len(detail["compact"]["turns"][0][k]) if detail["compact"] and detail["compact"]["turns"] else 0
            for k in ("plans", "reasoning", "execution", "reflections", "tool_errors", "components", "key_data")
        },
        "overview": (detail["compact"] or {}).get("overview", [])[:3],
        "summary": clip(detail["attribution"]["summary"], 260),
    }


def system_facts(all_samples, anatomy):
    """Real material for the 评测体系 page: severity examples and one anatomy sample."""
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
        "anatomy": {product: value[1] for product, value in anatomy.items()},
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


def build(datasets: Path, out_dir: Path, pairing: str = "auto", log=print):
    started = time.time()
    cache = LineCache(datasets)
    if not datasets.is_dir():
        return empty_payloads("missing"), {}
    if pairing in ("auto", "csv") and (datasets / "对应关系.csv").exists():
        pairs, pairing_info = pairs_from_csv(datasets, cache)
    else:
        pairs, pairing_info = pairs_from_keys(datasets, cache)
    if not pairs:
        return empty_payloads("no-pairs"), {}
    debug(f"paired {len(pairs)} rows")

    taxonomy, cluster_index = load_clusters(datasets)
    stats = Counter()
    samples = defaultdict(list)
    seen_slugs = set()
    anatomy = {}
    out_dir.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=".samples-", dir=out_dir))
    detail_bytes = 0

    # Group by input file so each large input file is read once and released.
    pairs.sort(key=lambda p: ((p["input"] or ("", 0))[0], (p["input"] or ("", 0))[1]))
    current = None
    for pair in pairs:
        inp_ref = pair["input"]
        if current and (not inp_ref or inp_ref[0] != current):
            cache.drop(current)
        current = inp_ref[0] if inp_ref else current
        raw_out = cache.line(*pair["output"])
        attr = json.loads(raw_out)
        inp = json.loads(cache.line(*inp_ref)) if inp_ref else None
        comp = json.loads(cache.line(*pair["compact"])) if pair["compact"] else None
        if inp is None:
            stats["missing_input"] += 1
        if comp is None:
            stats["missing_compact"] += 1
        slug = hashlib.sha256(raw_out).hexdigest()[:10]
        while slug in seen_slugs:
            slug = hashlib.sha256(slug.encode()).hexdigest()[:10]
        seen_slugs.add(slug)
        detail, row, facts = build_sample(pair, inp, attr, comp, cluster_index, stats)
        detail["slug"] = row["s"] = slug
        candidate = anatomy_candidate(detail)
        if candidate and (pair["product"] not in anatomy or candidate[0] > anatomy[pair["product"]][0]):
            anatomy[pair["product"]] = candidate
        detail_bytes += write_json(staging / f"{slug}.json", detail)
        samples[pair["product"]].append((slug, slim_detail(detail), row, facts))
        stats["details"] += 1
        if len(samples[pair["product"]]) % 500 == 0:
            debug(f"{pair['product']} samples {len(samples[pair['product']])}")
    if current:
        cache.drop(current)
    stats["details_mb"] = round(detail_bytes / 1e6, 1)

    debug(f"built samples {sum(len(v) for v in samples.values())}")
    sample_dir = out_dir / "samples"
    old = None
    if sample_dir.exists():
        old = out_dir / f".samples-old-{os.getpid()}"
        os.replace(sample_dir, old)
    staging.chmod(0o755)
    os.replace(staging, sample_dir)
    if old:
        shutil.rmtree(old, ignore_errors=True)
    all_samples = [s for rows in samples.values() for s in rows]
    used_patterns = {p["cl"]["path"] for _, d, _, _ in all_samples for p in d["attribution"]["problems"] if p["cl"]}
    products = {}
    for product in PRODUCTS:
        if samples.get(product):
            products[product] = aggregate(product, samples[product], taxonomy)
    # Input volume (every eval_input line, evaluated or not) and an optional prediction feed.
    counts = load_counts(out_dir.parent / "cache" / "input_counts.json")
    for top in sorted(p for p in datasets.glob("*") if p.is_dir()) if datasets.is_dir() else []:
        product = product_of(top.name)
        if product not in products:
            continue
        products[product]["kpi"]["inputs"] = input_total(datasets, top, product, cache, counts)
        feed = top / "prediction.json"
        if feed.is_file():
            try:
                products[product]["prediction"] = json.loads(feed.read_text(encoding="utf-8"))
            except ValueError as exc:
                log(f"[build] skip {feed}: {exc}")

    generated = iso_now()
    data = {
        "schema": 2, "generated_at": generated,
        "source": {**pairing_info, "pairs": len(pairs), "root": datasets.name},
        "taxonomy": taxonomy_out(taxonomy, used_patterns) if taxonomy["stages"] else None,
        "system": system_facts(all_samples, anatomy),
        "products": products,
    }
    index = {"schema": 2, "generated_at": generated, "products": {}}
    for product, rows in samples.items():
        rows_sorted = sorted(rows, key=lambda s: (WORST_KEYS.index(s[2]["w"]), -s[2]["n"], s[2]["d"]))
        index["products"][product] = {
            "label": PRODUCTS[product]["label"],
            "models": [{"id": m["id"], "label": m["label"]} for m in products[product]["models"]],
            "splits": products[product]["splits"],
            "rows": [s[2] for s in rows_sorted],
        }
    save_counts(out_dir.parent / "cache" / "input_counts.json", counts)
    stats["seconds"] = round(time.time() - started, 1)
    return (data, index), stats


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--datasets", type=Path,
                    default=None, help="datasets root (default: EVAL_DATASETS, the production mount, or <repo>/datasets)")
    ap.add_argument("--out", type=Path, default=STATIC, help="static directory receiving the payloads")
    ap.add_argument("--pairing", choices=("auto", "csv", "key"), default="auto")
    ap.add_argument("--keep-on-empty", action="store_true",
                    help="leave the previous payloads in place when the source yields no pairs "
                         "(used by the server's scheduled refresh so a briefly empty mount cannot wipe the board)")
    args = ap.parse_args(argv)
    args.datasets = args.datasets or default_datasets()

    (data, index), stats = build(args.datasets.resolve(), args.out, args.pairing)
    out = args.out
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
    data_bytes = write_json(out / "data.json", data)
    index_bytes = write_json(out / "samples.json", index)
    summary = {
        "pairs": data["source"].get("pairs", 0), "pairing": data["source"].get("mode"),
        "data_kb": round(data_bytes / 1024), "index_kb": round(index_bytes / 1024),
        **stats,
    }
    print(json.dumps(summary, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
