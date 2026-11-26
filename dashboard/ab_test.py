"""AB 测试记录: fixed benchmark questions evaluated on before-opt vs after-opt agents.

Canonical round layout under ``<datasets>/<n>_<product>/ab_test/<round>/``::

    version_<YYYYMMDD>_<model>[_<suffix>]/
      bench/bench.jsonl
      agent_before_opt/
        res_before_opt.jsonl
        eval_output/{attribution.jsonl, attribution_human_read.jsonl, compact.jsonl}
        cluster/{cluster_tree.json, item_index.jsonl, leaves.tsv, ...}
      agent_after_opt/
        res_after_opt.jsonl
        eval_output/{attribution.jsonl, attribution_human_read.jsonl, compact.jsonl}
        cluster/{cluster_tree.json, item_index.jsonl, leaves.tsv, ...}
      index_stats/{meta.json, pairs_index.csv, stats.json}
      [verify/verify.jsonl, gpt_answer/{questions.jsonl, raw/*.json}]
"""
from __future__ import annotations

import csv
import daytime
import hashlib
import json_compat as json
import re
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

# Pairs CSVs carry full question text plus leaf paths; avoid 128 KiB default field limit.
csv.field_size_limit(min(sys.maxsize, 2**31 - 1))

AB_DIR = "ab_test"
BENCH_REL = "bench/bench.jsonl"
BEFORE_DIR = "agent_before_opt"
AFTER_DIR = "agent_after_opt"
SIDE_DIR = {"before": BEFORE_DIR, "after": AFTER_DIR}
INPUT_FILE = {"before": "res_before_opt.jsonl", "after": "res_after_opt.jsonl"}
ATTR_REL = "eval_output/attribution.jsonl"
HR_ATTR_REL = "eval_output/attribution_human_read.jsonl"
COMPACT_REL = "eval_output/compact.jsonl"
CLUSTER_DIR = "cluster"

INDEX_STATS_DIR = "index_stats"
META_REL = f"{INDEX_STATS_DIR}/meta.json"
PAIRS_INDEX_REL = f"{INDEX_STATS_DIR}/pairs_index.csv"
STATS_REL = f"{INDEX_STATS_DIR}/stats.json"

VERIFY_REL = "verify/verify.jsonl"
GPT_DIR = "gpt_answer"
GPT_QUESTIONS_REL = f"{GPT_DIR}/questions.jsonl"
GPT_RAW_REL = f"{GPT_DIR}/raw"

AB_PAYLOAD_VERSION = 11
ROUND_RE = re.compile(r"^version_(\d{8})_(.+)$")
CASE_EQ_RE = re.compile(r"(?:^|_)eq_(\d+)$")

STATUS_LABEL = {
    "A": ("已评测 · 有落点", "有评测记录，且聚类树里定位到叶子：前后对比的主体"),
    "B": ("已评测 · 无落点", "有评测记录但树里没有落点（评测无问题 / 条目未入树）"),
    "C": ("无评测记录", "全库找不到评测产出，两侧都不计入"),
}
B_REASON_LABEL = {
    "B1": ("评测无问题", "评测跑完没报问题：本身就是通过样本"),
    "B2": ("有问题未进树", "报了问题但没进树快照（评测晚于聚类或条目未入树）"),
}
SOURCE_LABEL = {
    "daily": "日常评测",
    "lost_user": "流失用户",
    "rsi_1000_before": "千句专家集",
    "lost_user_archive": "流失归档",
    "internal_eval": "内部自动化",
}
SIDE_LABEL = {
    "before": "优化前",
    "after": "优化后",
}
NO_SCENE = "未接入分类体系"


def _short_model(value: str) -> str:
    raw = (value or "").strip().lower()
    if "expert" in raw:
        return "expert"
    if "fast" in raw:
        return "fast"
    return raw


def _parse_round_identity(round_dir: Path, declared: dict | None = None):
    declared = declared or {}
    m = ROUND_RE.match(round_dir.name)
    dir_date = m.group(1) if m else ""
    dir_rest = m.group(2) if m else round_dir.name

    raw_ver = str(declared.get("version") or dir_date or round_dir.name)
    digits = re.sub(r"\D", "", raw_ver)
    short_ver = digits[-4:] if len(digits) >= 4 else raw_ver
    released_at = declared.get("released_at")
    if not isinstance(released_at, str) or not released_at:
        released_at = f"{dir_date[:4]}-{dir_date[4:6]}-{dir_date[6:8]}" if len(dir_date) == 8 else None

    model = _short_model(str(declared.get("model") or dir_rest))
    return raw_ver, short_ver, released_at, model


def is_ab_round(round_dir: Path) -> bool:
    """True when ``round_dir`` follows the canonical ab_test layout."""
    return (
        (round_dir / META_REL).is_file()
        or (round_dir / PAIRS_INDEX_REL).is_file()
        or (round_dir / BEFORE_DIR).is_dir()
        or (round_dir / AFTER_DIR).is_dir()
    )


def ab_round_dirs(datasets: Path, product: str):
    """``<datasets>/<n>_<product>/ab_test/<round>/``, oldest first."""
    for top in sorted(datasets.glob("*")):
        if not top.is_dir():
            continue
        if top.name.split("_", 1)[-1] != product:
            continue
        root = top / AB_DIR
        if not root.is_dir():
            continue
        candidates = []
        for path in sorted(root.iterdir()):
            if not path.is_dir() or path.name.startswith("."):
                continue
            if not is_ab_round(path):
                continue
            declared = read_json(path / META_REL) or {}
            raw_ver, short_ver, released_at, _model = _parse_round_identity(path, declared)
            sort_key = (released_at or raw_ver or "", path.name)
            candidates.append((sort_key, short_ver, path))
        candidates.sort(key=lambda item: item[0])
        return [(idx, short_ver, path) for idx, (_sk, short_ver, path) in enumerate(candidates)]
    return []


def _round_signature_files(round_dir: Path):
    """Files whose (size, mtime_ns) invalidate the AB payload."""
    seen = {}

    def add(path: Path):
        if path.is_file():
            seen[path] = None

    add(round_dir / META_REL)
    add(round_dir / PAIRS_INDEX_REL)
    add(round_dir / STATS_REL)
    add(round_dir / BENCH_REL)
    add(round_dir / VERIFY_REL)
    add(round_dir / GPT_QUESTIONS_REL)
    gpt_raw = round_dir / GPT_RAW_REL
    if gpt_raw.is_dir():
        for path in sorted(gpt_raw.glob("*.json")):
            add(path)
    for side_dir in (BEFORE_DIR, AFTER_DIR):
        base = round_dir / side_dir
        add(base / ATTR_REL)
        add(base / HR_ATTR_REL)
        cluster = base / CLUSTER_DIR
        if cluster.is_dir():
            for name in ("item_index.jsonl", "leaves.tsv", "cluster_tree.json"):
                add(cluster / name)
    return sorted(seen)


def rounds_signature(datasets: Path, products=None) -> str:
    """Cheap stat-only fingerprint of every round's relevant files."""
    h = hashlib.sha1(f"ab-payload-v{AB_PAYLOAD_VERSION}\x1e".encode())
    for top in sorted(datasets.glob("*")):
        if not top.is_dir():
            continue
        if products is not None and top.name.split("_", 1)[-1] not in products:
            continue
        root = top / AB_DIR
        if not root.is_dir():
            continue
        for round_dir in sorted(
            path for path in root.iterdir()
            if path.is_dir() and not path.name.startswith(".") and is_ab_round(path)
        ):
            for path in _round_signature_files(round_dir):
                try:
                    st = path.stat()
                except OSError:
                    continue
                h.update(f"{path.relative_to(root)}\x1f{st.st_size}\x1f{st.st_mtime_ns}\x1e".encode())
    return h.hexdigest()


def read_json(path: Path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def read_rows(path: Path):
    try:
        with open(path, encoding="utf-8", newline="") as fh:
            return list(csv.DictReader(fh))
    except OSError:
        return []


def read_leaf_names(round_dir: Path):
    """Leaf/prefix names from both sides' cluster outputs (tree first, then leaves.tsv)."""
    names = {}
    for side_dir in (BEFORE_DIR, AFTER_DIR):
        cluster = round_dir / side_dir / CLUSTER_DIR
        if not cluster.is_dir():
            continue
        tsv = cluster / "leaves.tsv"
        if tsv.is_file():
            for row in read_rows(tsv):
                path = (row.get("path") or "").strip()
                if path:
                    names.setdefault(path, row.get("name") or path)
        tree_path = cluster / "cluster_tree.json"
        if tree_path.is_file():
            tree = read_json(tree_path) or {}
            stack = [tree.get("tree") or {}]
            while stack:
                node = stack.pop()
                nid = node.get("id") or ""
                if re.fullmatch(r"S\d+(?:\.M\d+)?(?:\.\d+){0,2}", nid):
                    names[nid] = node.get("name") or nid
                stack.extend(node.get("children") or [])
    return names


def node_order(nid: str):
    parts = nid.split(".")
    head = int(re.sub(r"\D", "", parts[0]) or 0)
    rest = [int(re.sub(r"\D", "", p) or 0) for p in parts[1:]]
    return [head, *rest]


def tree_nodes(before, after, names, after_available):
    """Union of both trees, one node per path prefix, counting hits per side."""
    counts = {"before": before, "after": after}
    nodes = {}
    for side, source in counts.items():
        for path, count in source.items():
            parts = path.split(".")
            for depth in range(1, len(parts) + 1):
                nid = ".".join(parts[:depth])
                node = nodes.setdefault(nid, {"id": nid, "level": depth, "before": 0, "after": 0})
                node[side] += count
    out = []
    for nid in sorted(nodes, key=node_order):
        node = nodes[nid]
        parent = nid.rsplit(".", 1)[0] if "." in nid else ""
        out.append({
            "id": nid,
            "level": node["level"],
            "parent": parent,
            "name": names.get(nid) or nid,
            "before": node["before"],
            "after": node["after"] if after_available else None,
        })
    return out


def matrix_rows(counter, scene_traces=None):
    """``[(task, sub)] -> [[path, n], ...]`` plus that scene's trace total."""
    scene_traces = scene_traces or {}
    grouped = defaultdict(Counter)
    for (task, sub, path), count in counter.items():
        grouped[(task, sub)][path] += count
    return [
        [
            task,
            sub,
            [[path, n] for path, n in sorted(paths.items(), key=lambda item: node_order(item[0]))],
            scene_traces.get((task, sub), 0),
        ]
        for (task, sub), paths in sorted(grouped.items(), key=lambda item: (-sum(item[1].values()), item[0]))
    ]


def _split_paths(value):
    return [part for part in (value or "").split(";") if part]


def _clip(text, limit):
    text = text if isinstance(text, str) else ("" if text is None else str(text))
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def _as_int(value):
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _is_before_evaluated(status: str) -> bool:
    s = (status or "").strip()
    return s == "evaluated" or s.startswith("已评测")


def _is_after_evaluated(status: str) -> bool:
    s = (status or "").strip()
    return s == "evaluated" or s.startswith("已重测")


def _scan_side_attribution(round_dir: Path, side: str):
    """Return `(eqs_set, trace_to_retest_trace)` present in ``agent_<side>_opt/eval_output/attribution.jsonl``."""
    attr_path = round_dir / SIDE_DIR[side] / ATTR_REL
    eqs = set()
    traces = {}
    if not attr_path.is_file():
        return eqs, traces
    try:
        with open(attr_path, encoding="utf-8", errors="replace") as fh:
            for line in fh:
                if not line.strip():
                    continue
                try:
                    row = json.loads(line)
                except ValueError:
                    continue
                smeta = row.get("session_meta") or {}
                turns = row.get("turns") or []
                first_trace = str(((turns[0].get("meta") or {}).get("trace_id")) if turns and isinstance(turns[0], dict) else "")
                if not first_trace:
                    first_trace = str(smeta.get("trace_id") or "")
                for cand in (smeta.get("case_key"), smeta.get("case_id")):
                    m = CASE_EQ_RE.search(str(cand or ""))
                    if m:
                        eq_num = int(m.group(1))
                        eqs.add(eq_num)
                        if first_trace:
                            traces[eq_num] = first_trace
                        break
                for turn in turns:
                    if not isinstance(turn, dict):
                        continue
                    tid = str((turn.get("meta") or {}).get("trace_id") or "")
                    if tid:
                        traces.setdefault(tid, tid)
                if smeta.get("trace_id"):
                    traces.setdefault(str(smeta["trace_id"]), first_trace or str(smeta["trace_id"]))
    except OSError:
        pass
    return eqs, traces


def _read_bench_rows(round_dir: Path):
    path = round_dir / BENCH_REL
    if not path.is_file():
        return []
    out = []
    try:
        with open(path, encoding="utf-8", errors="replace") as fh:
            for idx, line in enumerate(fh, 1):
                if not line.strip():
                    continue
                try:
                    row = json.loads(line)
                except ValueError:
                    continue
                if not isinstance(row, dict):
                    continue
                eq = _as_int(row.get("eq_index")) or idx
                out.append({
                    "eq": eq,
                    "case_key": str(row.get("case_key") or f"eq_{eq:05d}"),
                    "trace": str(row.get("trace_id") or row.get("source_trace_id") or ""),
                    "session": str(row.get("session_id") or row.get("source_session_id") or ""),
                    "question_time": str(row.get("question_time") or row.get("request_time") or ""),
                    "question": str(row.get("question") or ""),
                    "task": str(row.get("task") or "").strip(),
                    "sub": str(row.get("subtask") or "").strip(),
                    "eval_category": str(row.get("eval_category") or "").strip(),
                    "before_status": "missing",
                    "before_b_reason": "",
                    "before_trace_id": "",
                    "before_paths": [],
                    "after_status": "missing",
                    "after_trace_id": "",
                    "after_paths": [],
                })
    except OSError:
        return []
    return out


def _read_pairs_index(round_dir: Path):
    path = round_dir / PAIRS_INDEX_REL
    if not path.is_file():
        return _read_bench_rows(round_dir)
    rows = []
    for idx, row in enumerate(read_rows(path), 1):
        eq = _as_int(row.get("eq_index")) or idx
        trace = str(row.get("trace_id") or "").strip()
        if not trace and not row.get("case_key"):
            continue
        rows.append({
            "eq": eq,
            "case_key": str(row.get("case_key") or f"eq_{eq:05d}"),
            "trace": trace or str(row.get("case_key") or f"eq_{eq:05d}"),
            "session": str(row.get("session_id") or ""),
            "question_time": str(row.get("question_time") or ""),
            "question": str(row.get("question") or ""),
            "task": str(row.get("task") or "").strip(),
            "sub": str(row.get("subtask") or "").strip(),
            "eval_category": str(row.get("eval_category") or "").strip(),
            "before_status": str(row.get("before_status") or "").strip(),
            "before_b_reason": str(row.get("before_b_reason") or "").strip(),
            "before_trace_id": str(row.get("before_trace_id") or "").strip(),
            "before_paths": _split_paths(row.get("before_cls_paths")),
            "after_status": str(row.get("after_status") or "").strip(),
            "after_trace_id": str(row.get("after_trace_id") or "").strip(),
            "after_paths": _split_paths(row.get("after_cls_paths")),
        })
    return rows


def _sample_scene_index(samples):
    """Fallback trace/session -> (task, subtask) index from build samples when CSV has no scene."""
    by_trace = {}
    by_session = {}
    for _slug, detail, row, _facts in samples or []:
        detail = detail or {}
        meta = detail.get("meta") or {}
        task = (meta.get("task") or "").strip()
        if not task:
            continue
        sub = (meta.get("subtask") or "").strip()
        sid = str(row.get("sid") or (detail.get("ids") or {}).get("session") or "")
        if sid:
            by_session.setdefault(sid, (task, sub))
        for turn in (detail.get("attribution") or {}).get("turns") or []:
            tid = turn.get("trace_id")
            if tid:
                by_trace.setdefault(str(tid), (task, sub))
        for val in (detail.get("ids") or {}).values():
            if val:
                by_trace.setdefault(str(val), (task, sub))
        if row.get("tid"):
            by_trace.setdefault(str(row["tid"]), (task, sub))
    return by_trace, by_session


def round_meta(round_dir: Path, order: int, version: str):
    declared = read_json(round_dir / META_REL) or {}
    stats = read_json(round_dir / STATS_REL) or {}
    raw_ver, short_ver, released_at, model = _parse_round_identity(round_dir, declared)
    rows = _read_pairs_index(round_dir)
    counts = Counter()
    reasons = Counter()
    dates = set()
    sources = Counter()
    for row in rows:
        day = daytime.local_day(row["question_time"])
        if day:
            dates.add(day)
        if row["eval_category"]:
            sources[row["eval_category"]] += 1
        if _is_before_evaluated(row["before_status"]):
            if row["before_paths"]:
                counts["A"] += 1
            else:
                counts["B"] += 1
                if row["before_b_reason"]:
                    reasons[row["before_b_reason"]] += 1
        else:
            counts["C"] += 1
    sorted_dates = sorted(dates)
    ver = version or short_ver
    label = str(declared.get("label") or f"v{ver}")
    return {
        "id": round_dir.name,
        "order": order,
        "version": ver,
        "label": label,
        "title": str(declared.get("title") or ""),
        "released_at": released_at,
        "release_label": declared.get("label") if isinstance(declared.get("label"), str) else None,
        "before_label": str(declared.get("before_label") or SIDE_LABEL["before"]),
        "after_label": str(declared.get("after_label") or SIDE_LABEL["after"]),
        "generated_at": declared.get("generated_at") or stats.get("generated_at"),
        "targets": int(declared.get("tier") or stats.get("total_targets") or len(rows) or 0),
        "models": [model] if model else [],
        "status": dict(sorted(counts.items())),
        "b_reason": dict(sorted(reasons.items())),
        "sources": [[k, v] for k, v in sorted(sources.items(), key=lambda kv: -kv[1])],
        "dates": [sorted_dates[0], sorted_dates[-1]] if sorted_dates else [],
    }


def _paired_only(pairs, sample_refs):
    """Keep only questions that have openable details on both sides."""
    ready = {
        str(pair.get("id"))
        for pair in pairs
        if pair.get("before") and pair["before"].get("detail") is not None
        and pair.get("after") and pair["after"].get("detail") is not None
    }
    pairs[:] = [pair for pair in pairs if str(pair.get("id")) in ready]
    for side in ("before", "after"):
        refs = sample_refs.get(side)
        if refs is not None:
            refs[:] = [ref for ref in refs if str(ref.get("pair") or ref.get("trace")) in ready]


def _fact_groups(item):
    if isinstance(item.get("common"), list) or isinstance(item.get("special"), list):
        return [("common", item.get("common") or []), ("special", item.get("special") or [])]
    for key in ("checks", "results"):
        if isinstance(item.get(key), list):
            return [("", item.get(key) or [])]
    return []


def _verify_facts(checks, evals):
    order, facts = [], {}

    def add(fact_id, kind, payload):
        fid = str(fact_id or "")
        if not fid:
            return
        fact = facts.get(fid)
        if fact is None:
            fact = {"fact_id": fid}
            facts[fid] = fact
            order.append(fid)
        if kind and not fact.get("kind"):
            fact["kind"] = kind
        for key, value in payload.items():
            if value not in (None, ""):
                fact[key] = value

    for kind, items in checks:
        for item in items or []:
            if isinstance(item, dict):
                add(item.get("fact_id"), kind, {"what_to_check": item.get("what_to_check")})
    for kind, items in evals:
        for item in items or []:
            if isinstance(item, dict):
                add(item.get("fact_id"), kind, {
                    key: item.get(key)
                    for key in (
                        "what_to_check", "model_answer", "is_correct", "correct_answer",
                        "correct_answer_source", "responsible_component", "attribution",
                    )
                })
    return [facts[fid] for fid in order]


def _verify_models(row):
    paired = row.get("paired_model") if isinstance(row.get("paired_model"), list) else []
    lists = row.get("verifiable_fact_check_list")
    evals = row.get("eval_per_model")
    lists = lists if isinstance(lists, list) else []
    evals = evals if isinstance(evals, list) else []
    order, labels = [], {}

    def note(item):
        if not isinstance(item, dict):
            return ""
        mid = str(item.get("model_id") or "")
        if not mid:
            return ""
        if mid not in labels:
            order.append(mid)
            labels[mid] = str(item.get("model_label") or "") or mid
        elif item.get("model_label") and labels.get(mid) == mid:
            labels[mid] = str(item["model_label"])
        return mid

    for item in paired:
        note(item)
    checks, grades = defaultdict(list), defaultdict(list)
    for item in lists:
        mid = note(item)
        if mid:
            checks[mid].extend(_fact_groups(item))
    for item in evals:
        mid = note(item)
        if mid:
            grades[mid].extend(_fact_groups(item))

    models = []
    for mid in order:
        facts = _verify_facts(checks.get(mid) or [], grades.get(mid) or [])
        if facts:
            models.append({"id": mid, "label": labels.get(mid) or mid, "facts": facts})
    return models


def read_verify(round_dir: Path):
    path = round_dir / VERIFY_REL
    if not path.is_file():
        return {}
    found = {}
    try:
        with open(path, encoding="utf-8") as fh:
            for line in fh:
                try:
                    row = json.loads(line)
                except ValueError:
                    continue
                qid = str(row.get("question_id") or "")
                if not qid:
                    continue
                models = _verify_models(row)
                if models:
                    found[qid] = {"models": models}
    except OSError:
        return {}
    return found


def read_gpt_index(round_dir: Path):
    base = round_dir / GPT_DIR
    if not base.is_dir():
        return None
    questions = {}
    try:
        with open(round_dir / GPT_QUESTIONS_REL, encoding="utf-8") as fh:
            for line in fh:
                try:
                    row = json.loads(line)
                except ValueError:
                    continue
                key = str(row.get("key") or "")
                if key:
                    questions[key] = str(row.get("question") or "")
    except OSError:
        pass
    raw = {}
    raw_dir = round_dir / GPT_RAW_REL
    if raw_dir.is_dir():
        try:
            for path in sorted(raw_dir.glob("*.json")):
                if path.is_file() and path.stat().st_size > 0:
                    raw[path.stem] = path
        except OSError:
            pass
    keys = sorted(set(questions) | set(raw))
    model = effort = ""
    for key in keys:
        path = raw.get(key)
        if not path:
            continue
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if isinstance(payload, dict):
            model = str(payload.get("model") or "")
            effort = str(payload.get("effort") or "")
            if model:
                break
    return {
        "total": len(keys),
        "answered": sum(1 for key in keys if key in raw),
        "model": model or "GPT",
        "effort": effort,
        "questions": {key: {"question": questions.get(key) or "", "has": key in raw} for key in keys},
    }


def read_gpt_answer(round_dir: Path, key: str):
    key = str(key or "")
    if not re.fullmatch(r"[0-9A-Za-z_-]+", key):
        return None
    path = round_dir / GPT_RAW_REL / f"{key}.json"
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(payload, dict):
        return None
    response = payload.get("response") if isinstance(payload.get("response"), dict) else {}
    texts, sources, searches = [], [], []
    seen_urls, seen_queries = set(), set()
    for item in response.get("output") or []:
        if not isinstance(item, dict):
            continue
        if item.get("type") == "message":
            for part in item.get("content") or []:
                if not isinstance(part, dict) or part.get("type") not in ("output_text", "text"):
                    continue
                text = str(part.get("text") or "")
                if text.strip():
                    texts.append(text.strip())
                for annotation in part.get("annotations") or []:
                    if not isinstance(annotation, dict):
                        continue
                    url = str(annotation.get("url") or "")
                    if url and url not in seen_urls:
                        seen_urls.add(url)
                        sources.append({"title": str(annotation.get("title") or url), "url": url})
        elif item.get("type") == "web_search_call":
            action = item.get("action") if isinstance(item.get("action"), dict) else {}
            queries = action.get("queries") or ([action.get("query")] if action.get("query") else [])
            for query in queries:
                text = str(query or "")
                if text and text not in seen_queries:
                    seen_queries.add(text)
                    searches.append(text)
    answer = "\n\n".join(texts).strip()
    if not answer:
        return None
    usage = response.get("usage") if isinstance(response.get("usage"), dict) else {}
    return {
        "key": key,
        "question": str(payload.get("question") or ""),
        "model": str(payload.get("model") or ""),
        "effort": str(payload.get("effort") or ""),
        "question_time": str(payload.get("question_time") or ""),
        "latency_s": payload.get("latency_s"),
        "status": str(response.get("status") or ""),
        "answer": answer,
        "sources": sources,
        "searches": searches,
        "usage": {"input": usage.get("input_tokens"), "output": usage.get("output_tokens")},
    }


def _attach_gpt(meta, round_dir: Path):
    index = read_gpt_index(round_dir)
    if index is None:
        return
    meta["gpt"] = {key: index[key] for key in ("total", "answered", "model", "effort")}
    for pair in meta.get("pairs") or []:
        key = str(pair.get("id") or "")
        entry = index["questions"].get(key)
        pair["gpt"] = {
            "key": key,
            "has": bool(entry and entry.get("has")),
            "model": index.get("model") or "GPT",
        }


def build_round(round_dir: Path, order: int, version: str, samples=None,
                next_release: str | None = None, meta=None, input_traces=None):
    del next_release, input_traces
    meta = meta or round_meta(round_dir, order, version)
    meta["verify"] = read_verify(round_dir)

    rows = _read_pairs_index(round_dir)
    by_trace_scene, by_session_scene = _sample_scene_index(samples)
    model = (meta.get("models") or [""])[0]

    before_eqs, before_attr_traces = _scan_side_attribution(round_dir, "before")
    after_eqs, after_attr_traces = _scan_side_attribution(round_dir, "after")

    def has_detail(side: str, row: dict) -> bool:
        eq = row["eq"]
        if side == "before":
            return (
                eq in before_eqs
                or row["trace"] in before_attr_traces
                or (row["before_trace_id"] and row["before_trace_id"] in before_attr_traces)
            )
        return (
            eq in after_eqs
            or row["trace"] in after_attr_traces
            or (row["after_trace_id"] and row["after_trace_id"] in after_attr_traces)
        )

    after_available = any(_is_after_evaluated(r["after_status"]) for r in rows) or bool(after_eqs or after_attr_traces)
    before_evaluated_count = sum(1 for r in rows if _is_before_evaluated(r["before_status"]))
    after_evaluated_count = sum(1 for r in rows if _is_after_evaluated(r["after_status"]))

    common_rows = []
    common_before, common_after = Counter(), Counter()
    common_before_matrix, common_after_matrix = Counter(), Counter()
    common_before_scene, common_after_scene = Counter(), Counter()
    common_before_problem = common_after_problem = 0
    fixed_scenes = Counter()
    before_refs, after_refs = [], []
    pairs = []

    for row in rows:
        task = row["task"]
        sub = row["sub"]
        if not task:
            hit = by_trace_scene.get(row["trace"]) or by_session_scene.get(row["session"])
            if hit:
                task, sub = hit
            else:
                task, sub = NO_SCENE, ""
        fixed_scenes[(task, sub)] += 1

        eq = row["eq"]
        trace = row["trace"]
        b_eval = _is_before_evaluated(row["before_status"])
        a_eval = _is_after_evaluated(row["after_status"])
        b_detail = f"before-{eq}" if (b_eval and has_detail("before", row)) else None
        a_detail = f"after-{eq}" if (a_eval and has_detail("after", row)) else None

        before_obj = {
            "trace": trace,
            "model": model,
            "detail": b_detail,
            "n": len(row["before_paths"]),
            "paths": row["before_paths"],
            "status": row["before_status"],
        } if b_eval else None
        after_obj = {
            "trace": after_attr_traces.get(eq) or row["after_trace_id"] or trace,
            "model": model,
            "detail": a_detail,
            "n": len(row["after_paths"]),
            "paths": row["after_paths"],
            "status": row["after_status"],
        } if (a_eval or row["after_status"] in ("failed", "pending")) else None

        pairs.append({
            "id": trace,
            "eq": eq,
            "q": _clip(row["question"], 160),
            "scene": task,
            "sub": sub,
            "before": before_obj,
            "after": after_obj,
        })

        if b_eval and row["before_paths"]:
            before_refs.append({
                "trace": trace,
                "pair": trace,
                "eq": eq,
                "q": _clip(row["question"], 160),
                "detail": b_detail,
                "model": model,
                "task": task,
                "sub": sub,
                "paths": row["before_paths"],
            })
        if a_eval and row["after_paths"]:
            after_refs.append({
                "trace": after_attr_traces.get(eq) or row["after_trace_id"] or trace,
                "pair": trace,
                "eq": eq,
                "q": _clip(row["question"], 160),
                "detail": a_detail,
                "model": model,
                "task": task,
                "sub": sub,
                "paths": row["after_paths"],
            })

        if b_eval and a_eval:
            common_rows.append([task, sub, list(row["before_paths"]), list(row["after_paths"])])
            common_before_scene[(task, sub)] += 1
            common_after_scene[(task, sub)] += 1
            if row["before_paths"]:
                common_before_problem += 1
            if row["after_paths"]:
                common_after_problem += 1
            for path in row["before_paths"]:
                common_before[path] += 1
                common_before_matrix[(task, sub, path)] += 1
            for path in row["after_paths"]:
                common_after[path] += 1
                common_after_matrix[(task, sub, path)] += 1

    # When after isn't evaluated yet, populate before_refs/leaves/matrix from before alone
    if not after_available:
        before_only_matrix = Counter()
        before_only_scene = Counter()
        before_only_counter = Counter()
        before_only_problem = 0
        for row in rows:
            if not _is_before_evaluated(row["before_status"]):
                continue
            task = row["task"] or NO_SCENE
            sub = row["sub"] if row["task"] else ""
            if not row["task"]:
                hit = by_trace_scene.get(row["trace"]) or by_session_scene.get(row["session"])
                if hit:
                    task, sub = hit
            before_only_scene[(task, sub)] += 1
            if row["before_paths"]:
                before_only_problem += 1
            for path in row["before_paths"]:
                before_only_counter[path] += 1
                before_only_matrix[(task, sub, path)] += 1
        active_before = before_only_counter
        active_before_matrix = before_only_matrix
        active_before_scene = before_only_scene
        active_before_traces = before_evaluated_count
        active_before_problem = before_only_problem
    else:
        active_before = common_before
        active_before_matrix = common_before_matrix
        active_before_scene = common_before_scene
        active_before_traces = len(common_rows)
        active_before_problem = common_before_problem

    _paired_only(pairs, {"before": before_refs, "after": after_refs})

    names = read_leaf_names(round_dir)
    leaves = [
        {
            "id": path,
            "name": names.get(path) or path,
            "before": active_before.get(path, 0),
            "after": common_after.get(path, 0) if after_available else None,
            "model_before": {},
            "model_after": {},
            "source_before": {},
            "source_after": {},
        }
        for path in sorted(set(active_before) | set(common_after), key=node_order)
    ]

    common_scenes = Counter((task, sub) for task, sub, _b, _a in common_rows)
    meta["sides"] = {
        "before": {
            "traces": active_before_traces,
            "hits": sum(active_before.values()),
            "problem_traces": active_before_problem,
        },
        "after": ({
            "traces": len(common_rows),
            "hits": sum(common_after.values()),
            "problem_traces": common_after_problem,
        } if after_available else None),
    }
    meta["leaves"] = leaves
    meta["sample_refs"] = {"before": before_refs, "after": after_refs}
    meta["fixed"] = {
        "total": int(meta.get("targets") or len(rows)),
        "before": before_evaluated_count,
        "after": after_evaluated_count,
        "scenes": [[task, sub, count] for (task, sub), count in fixed_scenes.items()],
    }
    meta["common"] = {
        "total": len(common_rows),
        "scenes": [[task, sub, count] for (task, sub), count in common_scenes.items()],
        "rows": common_rows,
    }
    meta["pairs"] = pairs
    meta["matrix"] = {
        "before": matrix_rows(active_before_matrix, active_before_scene) if before_evaluated_count else [],
        "after": matrix_rows(common_after_matrix, common_after_scene) if after_available else None,
    }
    meta["nodes"] = tree_nodes(active_before, common_after, names, after_available)
    _attach_gpt(meta, round_dir)
    return meta


def ab_payload(datasets: Path, product: str, generated: str | None = None, samples=None,
               input_traces=None):
    """Every round for one product, oldest first; ``None`` when the product has no AB data."""
    del input_traces
    found = ab_round_dirs(datasets, product)
    if not found:
        return None
    prepared = [(order, version, path, round_meta(path, order, version)) for order, version, path in found]
    rounds = [
        build_round(path, order, version, samples=samples, meta=meta)
        for order, version, path, meta in prepared
    ]
    models = set()
    for rnd in rounds:
        models.update(rnd.get("models") or [])
    return {
        "schema": 4,
        "generated_at": generated or datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "product": product,
        "labels": {
            "status": {k: list(v) for k, v in STATUS_LABEL.items()},
            "b_reason": {k: list(v) for k, v in B_REASON_LABEL.items()},
            "sources": SOURCE_LABEL,
            "sides": SIDE_LABEL,
        },
        "models": sorted(models),
        "rounds": rounds,
    }
