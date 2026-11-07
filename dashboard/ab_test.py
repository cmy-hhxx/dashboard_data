"""AB 测试记录: the fixed question set re-evaluated before and after a release.

A round lives in ``<datasets>/<n>_<product>/ab_test/<round>/`` and is data only — this module
just reads what the extraction scripts wrote (see ``ab_test/*/README.md``)::

    00_manifest/summary.json      targets, A/B/C status counts, eval sources
    00_manifest/coverage.csv      one row per target: status, eval source, cluster leaf paths
    01_targets/questions.jsonl    the fixed set itself (not read here: coverage carries the ids)
    03_cluster_<ver>/<model>/     snapshot of the tree before the release (leaf names)
    04_retest_after/<model>/      **after** the release: item_index.slice.jsonl of the same traces
    05_compare/                   baseline tables; optional round.json in the round dir pins the date

Both sides count the same thing — targets that hit a leaf — so the two trees union on the leaf
path itself.  A round with no ``04_retest_after`` is still shown: it is the baseline the next
release is measured against, and pretending otherwise hides why the comparison is empty.
"""
from __future__ import annotations

import csv
import hashlib
import json_compat as json
import re
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

AB_DIR = "ab_test"
ROUND_RE = re.compile(r"^(\d+)_version(?P<version>[0-9A-Za-z.]+?)(?:_test)?$")
DECLARED_VERSION = re.compile(r"\d{4}-\d{2}-\d{2}")

# A/B/C with the names the extraction README uses; the payload ships labels so the browser
# never invents its own vocabulary for a data-quality state.
STATUS_LABEL = {
    "A": ("已评测 · 有落点", "有评测记录，且聚类树里定位到叶子：前后对比的主体"),
    "B": ("已评测 · 无落点", "有评测记录但树里没有落点（评测无问题 / 条目未入树）"),
    "C": ("无评测记录", "全库找不到评测产出，两侧都不计入"),
}
B_REASON_LABEL = {
    "B1": ("评测无问题", "评测跑完没报问题：本身就是通过样本"),
    "B2": ("有问题未进树", "报了问题但没进树快照（评测晚于聚类或条目未入树）"),
}
# eval_store -> the eval batch it came from.  Lost-user batches are a different population from
# daily online traffic, so the panel can split them instead of averaging them together.
SOURCE_LABEL = {
    "daily": "日常评测",
    "lost_user": "流失用户",
    "rsi_1000_before": "千句专家集",
    "lost_user_archive": "流失归档",
    "raw_eval_fallback": "原始兜底",
}
SIDE_LABEL = {
    "before": "改版前 · 固定题集",
    "after": "改版后 · 固定题集",
    "online": "改版后 · 线上真实用户",
}
NO_SCENE = "未接入分类体系"


def ab_round_dirs(datasets: Path, product: str):
    """``<datasets>/<n>_<product>/ab_test/<round>/``, oldest first.

    The leading number in a round folder is its order; ``version1106`` is the release it tests.
    Folders without a manifest are ignored rather than shown as empty records.
    """
    for top in sorted(datasets.glob("*")):
        if not top.is_dir():
            continue
        root = top / AB_DIR
        if not root.is_dir():
            continue
        # product_of() lives in build.py; importing it here would be a cycle, so match by name.
        if top.name.split("_", 1)[-1] != product:
            continue
        found = []
        for path in sorted(root.iterdir()):
            if not path.is_dir():
                continue
            m = ROUND_RE.match(path.name)
            order = int(m.group(1)) if m else 10**6
            version = m.group("version") if m else clip_version(path.name)
            found.append((order, version, path))
        return found
    return []


def clip_version(name: str) -> str:
    digits = re.sub(r"\D", "", name.split("version")[-1] if "version" in name else name)
    return digits[-4:] if digits else name


def rounds_signature(datasets: Path) -> str:
    """Cheap fingerprint of every round's files, so a new export rebuilds the payload once."""
    h = hashlib.sha1()
    for top in sorted(datasets.glob("*")):
        root = top / AB_DIR
        if not root.is_dir():
            continue
        for path in sorted(root.rglob("*")):
            if path.is_dir():
                continue
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


def eval_model(store: str) -> str:
    """``daily_expert`` / ``raw_lost_fast`` -> ``expert`` / ``fast``."""
    tail = (store or "").rsplit("_", 1)[-1]
    return tail if tail in ("fast", "expert") else ""


def read_leaf_names(round_dir: Path):
    """Leaf/prefix names from the round's own tree snapshot, then its leaves.tsv.

    Level-4 leaves are absent from leaves.tsv (it lists the L3 roll-up), so the tree comes
    first; a round that only shipped item_index still gets L3 names from the tsv.
    """
    names = {}
    for tsv in sorted(round_dir.glob("03_cluster_*/**/leaves.tsv")) + sorted(round_dir.glob("04_retest_after/**/leaves.tsv")):
        for row in read_rows(tsv):
            path = (row.get("path") or "").strip()
            if path:
                names.setdefault(path, row.get("name") or path)
    trees = sorted(round_dir.glob("03_cluster_*/**/cluster_tree.json")) + sorted(round_dir.glob("04_retest_after/**/cluster_tree.json"))
    for tree_path in trees:
        tree = read_json(tree_path) or {}
        stack = [tree.get("tree") or {}]
        while stack:
            node = stack.pop()
            nid = node.get("id") or ""
            if re.fullmatch(r"S\d+(?:\.M\d+)?(?:\.\d+){0,2}", nid):
                names[nid] = node.get("name") or nid
            stack.extend(node.get("children") or [])
    return names


def read_after(round_dir: Path):
    """After-release leaf paths per trace id.

    ``04_retest_after/<model>/item_index.slice.jsonl`` uses the same item schema as the
    pre-release snapshot, so a trace's new leaves are just its ``path`` values.
    """
    after = {}
    for path in sorted(round_dir.glob(f"04_retest_after/*/item_index.slice.jsonl")):
        try:
            with open(path, encoding="utf-8") as fh:
                for line in fh:
                    try:
                        item = json.loads(line)
                    except ValueError:
                        continue
                    trace = str(item.get("trace_id") or "")
                    leaf = item.get("path")
                    if trace and leaf:
                        after.setdefault(trace, set()).add(leaf)
        except OSError:
            continue
    return {trace: sorted(paths) for trace, paths in after.items()}


def round_meta(round_dir: Path, order: int, version: str):
    """Header figures for one round, from summary.json and coverage.csv."""
    summary = read_json(round_dir / "00_manifest" / "summary.json") or {}
    rows = read_rows(round_dir / "00_manifest" / "coverage.csv")
    counts = Counter()
    for row in rows:
        status = (row.get("status") or "").split("_")[0]
        if status:
            counts[status] += 1
    dates = sorted({(row.get("question_time") or "")[:10] for row in rows if row.get("question_time")})
    declared = read_json(round_dir / "round.json") or {}
    release = None
    if isinstance(declared.get("released_at"), str) and DECLARED_VERSION.match(declared["released_at"]):
        release = {"date": declared["released_at"]}
        if isinstance(declared.get("label"), str):
            release["label"] = declared["label"]
    elif isinstance(declared.get("released_at"), str):
        release = {"date": declared["released_at"]}
    sources = summary.get("eval_category") or {}
    return {
        "id": round_dir.name,
        "order": order,
        "version": version,
        "label": f"v{version}",
        "title": (declared.get("title") if isinstance(declared.get("title"), str) else "") or "",
        "released_at": release["date"] if release else None,
        "release_label": release.get("label") if release else None,
        "generated_at": summary.get("generated_at"),
        "targets": int(summary.get("target_traces") or len(rows)),
        "status": dict(sorted(counts.items())),
        "b_reason": {k.split("_")[0]: v for k, v in (summary.get("b_reason") or {}).items()},
        "sources": [[k, v] for k, v in sorted(sources.items(), key=lambda kv: -kv[1])],
        "dates": [dates[0], dates[-1]] if dates else [],
    }


def tree_nodes(before, after, online, names, after_available, online_available):
    """Union of all three trees, one node per path prefix, counting hits per side.

    ``before`` / ``after`` map path -> hit count; a prefix sums every leaf under it, because a
    trace that hits a deeper leaf also shows the problem at each level above it.
    """
    counts = {"before": before, "after": after, "online": online}
    nodes = {}
    for side, source in counts.items():
        for path, count in source.items():
            parts = path.split(".")
            for depth in range(1, len(parts) + 1):
                nid = ".".join(parts[:depth])
                node = nodes.setdefault(nid, {
                    "id": nid, "level": depth, "before": 0, "after": 0, "online": 0,
                })
                node[side] += count
    out = []
    for nid in sorted(nodes, key=node_order):
        node = nodes[nid]
        parent = nid.rsplit(".", 1)[0] if "." in nid else ""
        out.append({
            "id": nid, "level": node["level"], "parent": parent,
            "name": names.get(nid) or nid,
            "before": node["before"],
            "after": node["after"] if after_available else None,
            "online": node["online"] if online_available else None,
        })
    return out


def node_order(nid: str):
    parts = nid.split(".")
    head = int(re.sub(r"\D", "", parts[0]) or 0)
    rest = [int(re.sub(r"\D", "", p) or 0) for p in parts[1:]]
    return [head, *rest]


def scene_pair(detail, row):
    """The same scene the main matrix uses once build.py has voted on it."""
    task = row.get("sc") or (detail.get("meta") or {}).get("task")
    task = task or (detail.get("meta") or {}).get("skill") or NO_SCENE
    sub = (detail.get("meta") or {}).get("subtask") or ""
    return task, sub


def sample_scene_map(samples):
    found = {}
    for _slug, detail, row, _facts in samples or []:
        trace = str(row.get("tid") or "")
        if trace:
            found[trace] = scene_pair(detail, row)
    return found


def coverage_scene(row, scenes):
    trace = str(row.get("trace_id") or "")
    task = (row.get("task") or row.get("scene") or "").strip()
    sub = (row.get("subtask") or row.get("sub") or "").strip()
    if not task and trace in scenes:
        task, sub = scenes[trace]
    return task or NO_SCENE, sub


def matrix_rows(counter):
    """``[(task, sub)] → [[path, n], …]`` in the shape the browser matrix already consumes."""
    grouped = defaultdict(Counter)
    for (task, sub, path), count in counter.items():
        grouped[(task, sub)][path] += count
    return [
        [task, sub, [[path, n] for path, n in sorted(paths.items(), key=lambda item: node_order(item[0]))]]
        for (task, sub), paths in sorted(grouped.items(), key=lambda item: (-sum(item[1].values()), item[0]))
    ]


def build_round(round_dir: Path, order: int, version: str, samples=None,
                next_release: str | None = None, meta=None):
    """One round: fixed-set before/after plus post-release real-user online validation."""
    meta = meta or round_meta(round_dir, order, version)
    rows = read_rows(round_dir / "00_manifest" / "coverage.csv")
    scenes = sample_scene_map(samples)
    before, before_model, before_source = Counter(), defaultdict(Counter), defaultdict(Counter)
    before_matrix = Counter()
    for row in rows:
        paths = [p for p in (row.get("cls_paths") or "").split(";") if p]
        if not paths:
            continue
        model = eval_model(str(row.get("eval_store") or ""))
        source = row.get("eval_category") or ""
        scene = coverage_scene(row, scenes)
        for path in paths:
            before[path] += 1
            before_matrix[(*scene, path)] += 1
            if model:
                before_model[path][model] += 1
            if source:
                before_source[path][source] += 1

    after_paths = read_after(round_dir)
    after = Counter()
    after_model = defaultdict(Counter)
    after_source = defaultdict(Counter)
    after_matrix = Counter()
    by_trace = {}
    if after_paths:
        for row in rows:
            trace = str(row.get("trace_id") or "")
            paths = after_paths.get(trace)
            if not paths:
                continue
            model = eval_model(str(row.get("eval_store") or ""))
            source = row.get("eval_category") or ""
            scene = coverage_scene(row, scenes)
            by_trace[trace] = paths
            for path in paths:
                after[path] += 1
                after_matrix[(*scene, path)] += 1
                if model:
                    after_model[path][model] += 1
                if source:
                    after_source[path][source] += 1

    # The third batch is not the same population as the fixed set: only real users, only
    # after this release (and before the next one when another round exists), and never one
    # of the fixed traces. Counts are therefore shown as online validation, not subtracted.
    online = Counter()
    online_model = defaultdict(Counter)
    online_source = defaultdict(Counter)
    online_matrix = Counter()
    online_dates = set()
    online_traces = 0
    online_start = meta.get("released_at")
    online_available = bool(samples is not None and online_start)
    if samples is not None and online_start:
        fixed_traces = {str(row.get("trace_id") or "") for row in rows if row.get("trace_id")}
        for _slug, detail, row, _facts in samples:
            day = str(row.get("d") or "")
            if row.get("ut") != "real" or not day or day < online_start:
                continue
            if next_release and day >= next_release:
                continue
            trace = str(row.get("tid") or "")
            if trace and trace in fixed_traces:
                continue
            paths = sorted({p["cl"]["path"] for p in (detail.get("attribution") or {}).get("problems", [])
                            if p.get("cl") and p["cl"].get("path")})
            online_traces += 1
            online_dates.add(day)
            scene = scene_pair(detail, row)
            for path in paths:
                online[path] += 1
                online_matrix[(*scene, path)] += 1
                model = row.get("m") or ""
                if model:
                    online_model[path][model] += 1
                online_source[path]["online_real"] += 1

    names = read_leaf_names(round_dir)
    leaves = []
    for path in sorted(set(before) | set(after) | set(online), key=node_order):
        leaves.append({
            "id": path,
            "name": names.get(path) or path,
            "before": before.get(path, 0),
            "after": after.get(path, 0) if after_paths else None,
            "online": online.get(path, 0) if online_available else None,
            "model_before": dict(before_model.get(path) or {}),
            "model_after": dict(after_model.get(path) or {}) if after_paths else None,
            "model_online": dict(online_model.get(path) or {}) if online_available else None,
            "source_before": dict(before_source.get(path) or {}),
            "source_after": dict(after_source.get(path) or {}) if after_paths else None,
            "source_online": dict(online_source.get(path) or {}) if online_available else None,
        })

    meta["sides"] = {
        "before": {"traces": sum(1 for row in rows if (row.get("cls_paths") or "").strip()),
                   "hits": sum(before.values())},
        "after": ({"traces": len(by_trace), "hits": sum(after.values())} if after_paths else None),
        "online": ({
            "traces": online_traces, "hits": sum(online.values()),
            "from": online_start,
            "to": max(online_dates) if online_dates else None,
            "user_type": "real",
        } if online_available else None),
    }
    meta["leaves"] = leaves
    meta["matrix"] = {
        "before": matrix_rows(before_matrix),
        "after": matrix_rows(after_matrix) if after_paths else None,
        "online": matrix_rows(online_matrix) if online_available else None,
    }
    meta["nodes"] = tree_nodes(before, after, online, names, bool(after_paths), online_available)
    return meta


def ab_payload(datasets: Path, product: str, generated: str | None = None, samples=None):
    """Every round for one product, oldest first; ``None`` when the product has no AB data."""
    found = ab_round_dirs(datasets, product)
    if not found:
        return None
    prepared = [(order, version, path, round_meta(path, order, version)) for order, version, path in found]
    rounds = []
    for index, (order, version, path, meta) in enumerate(prepared):
        next_meta = prepared[index + 1][3] if index + 1 < len(prepared) else None
        rounds.append(build_round(
            path, order, version, samples=samples, meta=meta,
            next_release=next_meta.get("released_at") if next_meta else None,
        ))
    models = set()
    for rnd in rounds:
        for leaf in rnd["leaves"]:
            models.update((leaf["model_before"] or {}).keys())
            models.update((leaf["model_after"] or {}).keys())
            models.update((leaf["model_online"] or {}).keys())
    return {
        "schema": 2,
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
