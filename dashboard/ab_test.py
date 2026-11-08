"""AB 测试记录: the fixed question set re-evaluated before and after a release.

A round lives in ``<datasets>/<n>_<product>/ab_test/<round>/``.  Two layouts are read:

**Current "three scopes" layout** (AIME 2026-11, every scope = attribution + cluster)::

    00_manifest/summary.json                      totals, A/B/C, eval sources
    00_manifest/scope_summary.json                per-scope totals (optional)
    00_manifest/coverage_before_release_cluster.csv   one row per target: leaf paths + eval state
    00_manifest/coverage_after_release_retest.csv     retest states + leaf paths
    00_manifest/coverage_after_release_online_real.csv  online real users (empty until landed)
    00_manifest/trace_scenes.csv                  optional trace -> (task, subtask) for the matrix
    01_targets/questions.jsonl                    the fixed set itself
    02_before_release/cluster_tree/<model>/       before: item_index.slice.jsonl, leaves.tsv, tree
    03_after_release_retest/cluster_tree/<model>/ after: same schema
    04_after_release_online_real/cluster_tree/    online: empty until landed
    round.json                                    optional {"released_at","label","title"}

**Legacy layout** (used by the older extraction scripts and the tests)::

    00_manifest/coverage.csv      one row per target: status, eval source, cluster leaf paths
    03_cluster_<ver>/<model>/     snapshot of the tree before the release (leaf names)
    04_retest_after/<model>/      **after** the release: item_index.slice.jsonl of the same traces

Both layouts count the same thing — targets that hit a leaf — so the sides union on the leaf
path itself.  A round with no after / online data is still shown: it is the baseline the next
release is measured against, and pretending otherwise hides why the comparison is empty.

The online batch is a different population from the fixed set.  When the round exposes an
explicit online scope it is read from there; otherwise it is derived from the build's samples
(real users, after the release, before the next release, fixed traces excluded), which is what
the legacy layout always did.
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

# ---- current three-scope layout -----------------------------------------------------------
SCOPE_BEFORE = "02_before_release"
SCOPE_AFTER = "03_after_release_retest"
SCOPE_ONLINE = "04_after_release_online_real"
SCOPE_TREES = {
    "before": (f"{SCOPE_BEFORE}/cluster_tree", "03_cluster_1106_all", "03_cluster_1106"),
    "after": (f"{SCOPE_AFTER}/cluster_tree", "03_after_retest/cluster_tree", "04_retest_after"),
    "online": (f"{SCOPE_ONLINE}/cluster_tree", "04_online_after", "06_online_after"),
}
# Coverage file names, newest layout first.  ``coverage.csv`` is the legacy eval-level file.
COVERAGE_FILES = {
    "before": ("coverage_before_release_cluster.csv", "coverage_cluster_all.csv",
               "coverage_before_release.csv", "coverage.csv"),
    "after": ("coverage_after_release_retest.csv", "coverage_after_retest.csv",
              "coverage_after_release.csv"),
    "online": ("coverage_after_release_online_real.csv", "coverage_online_after.csv"),
}
STATUS_CODE = {"已评测_有落点": "A", "已评测_无落点": "B", "无评测记录": "C"}
B_REASON_CODE = {"B1_评测无问题": "B1", "B2_有问题未进树": "B2",
                 "判无问题": "B1", "有问题未进树": "B2"}


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
            if not path.is_dir() or path.name.startswith("."):
                continue
            # A round always carries a manifest; anything else under ab_test/ (a backup,
            # a scratch dir, a half-copied export) is not a round and must not render.
            if not (path / "00_manifest").is_dir() and not is_scope_layout(path):
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


def _round_signature_files(round_dir: Path):
    """The files whose (size, mtime) can change the payload.

    A three-scope round also carries attribution output and provenance (GBs); scanning all of
    it every hour only makes the build slower on ceph.  Only manifests, targets, trees and the
    optional scene/round metadata are fingerprinted.
    """
    seen = {}

    def add(path: Path):
        if path.is_file():
            seen[path] = None

    add(round_dir / "round.json")
    add(round_dir / "01_targets" / "questions.jsonl")
    manifest = round_dir / "00_manifest"
    if manifest.is_dir():
        for path in sorted(manifest.glob("coverage*.csv")):
            add(path)
        for name in ("summary.json", "scope_summary.json", "trace_scenes.csv"):
            add(manifest / name)
    for rel in ("02_before_release/cluster_tree", "03_after_release_retest/cluster_tree",
                "03_after_retest/cluster_tree", "04_after_release_online_real/cluster_tree",
                "04_online_after", "04_retest_after"):
        base = round_dir / rel
        if base.is_dir():
            for name in ("item_index.slice.jsonl", "leaves.tsv", "cluster_tree.json"):
                for path in base.rglob(name):
                    add(path)
    for base in sorted(round_dir.glob("03_cluster_*")):
        if base.is_dir():
            for name in ("item_index.slice.jsonl", "leaves.tsv", "cluster_tree.json"):
                for path in base.rglob(name):
                    add(path)
    return sorted(seen)


def rounds_signature(datasets: Path) -> str:
    """Cheap fingerprint of every round's relevant files, so a new export rebuilds once."""
    h = hashlib.sha1()
    for top in sorted(datasets.glob("*")):
        root = top / AB_DIR
        if not root.is_dir():
            continue
        for round_dir in sorted(path for path in root.iterdir()
                                if path.is_dir() and not path.name.startswith(".")):
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


def eval_model(store: str) -> str:
    """``daily_expert`` / ``raw_lost_fast`` -> ``expert`` / ``fast``."""
    tail = (store or "").rsplit("_", 1)[-1]
    return tail if tail in ("fast", "expert") else ""


def _tree_roots(round_dir: Path):
    """Directories that hold cluster tree snapshots for any layout."""
    roots = []
    for rels in SCOPE_TREES.values():
        for rel in rels:
            base = round_dir / rel
            if base.is_dir():
                roots.append(base)
    roots.extend(sorted(base for base in round_dir.glob("03_cluster_*") if base.is_dir()))
    return roots


def read_leaf_names(round_dir: Path):
    """Leaf/prefix names from the round's own tree snapshots, then its leaves.tsv.

    Level-4 leaves are absent from leaves.tsv (it lists the L3 roll-up), so the tree comes
    first; a round that only shipped item_index still gets L3 names from the tsv.
    """
    names = {}
    for base in _tree_roots(round_dir):
        for tsv in sorted(base.rglob("leaves.tsv")):
            for row in read_rows(tsv):
                path = (row.get("path") or "").strip()
                if path:
                    names.setdefault(path, row.get("name") or path)
        for tree_path in sorted(base.rglob("cluster_tree.json")):
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


def _legacy_round_meta(round_dir: Path, order: int, version: str):
    """Header figures for one legacy round, from summary.json and coverage.csv."""
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


def _release_from_declared(declared):
    release = None
    if isinstance(declared.get("released_at"), str):
        release = {"date": declared["released_at"]}
        if isinstance(declared.get("label"), str):
            release["label"] = declared["label"]
    return release


def _scope_round_meta(round_dir: Path, order: int, version: str):
    """Header figures for a three-scope round: coverage before, then summary/scope totals."""
    summary = read_json(round_dir / "00_manifest" / "summary.json") or {}
    before_path = scope_coverage_path(round_dir, "before")
    rows = read_rows(before_path) if before_path else []
    counts = Counter()
    reasons = Counter()
    for row in rows:
        raw = (row.get("status") or "").strip()
        code = STATUS_CODE.get(raw) or (raw[:1] if raw[:1] in ("A", "B", "C") and "_" in raw else "")
        if code:
            counts[code] += 1
        reason = (row.get("b_reason") or "").strip()
        if reason:
            reasons[B_REASON_CODE.get(reason, reason.split("_")[0])] += 1
    if not counts:
        for key, value in (summary.get("status") or {}).items():
            code = key[:1] if key[:1] in ("A", "B", "C") else STATUS_CODE.get(key, "")
            if code:
                counts[code] += int(value or 0)
    if not reasons:
        for key, value in (summary.get("b_reason") or {}).items():
            reasons[key.split("_")[0]] += int(value or 0)
    dates = sorted({(row.get("question_time") or "")[:10] for row in rows if row.get("question_time")})
    sources = summary.get("eval_category") or {}
    if not sources:
        sources = Counter(row.get("eval_category") for row in rows if row.get("eval_category"))
    declared = read_json(round_dir / "round.json") or {}
    release = _release_from_declared(declared)
    targets = summary.get("target_traces")
    if not targets:
        targets = len(rows)
    return {
        "id": round_dir.name,
        "order": order,
        "version": version,
        "label": f"v{version}",
        "title": (declared.get("title") if isinstance(declared.get("title"), str) else "") or "",
        "released_at": release["date"] if release else None,
        "release_label": release.get("label") if release else None,
        "generated_at": summary.get("generated_at"),
        "targets": int(targets or 0),
        "status": dict(sorted(counts.items())),
        "b_reason": dict(sorted(reasons.items())),
        "sources": [[k, v] for k, v in sorted(sources.items(), key=lambda kv: -kv[1])],
        "dates": [dates[0], dates[-1]] if dates else [],
    }


def round_meta(round_dir: Path, order: int, version: str):
    """Header figures for one round, whichever layout it uses."""
    if is_scope_layout(round_dir):
        return _scope_round_meta(round_dir, order, version)
    return _legacy_round_meta(round_dir, order, version)


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


# ---- current "three scopes" layout helpers ------------------------------------------------

def is_scope_layout(round_dir: Path) -> bool:
    """True when the round uses the ``02_before_release / 03_after_release_retest`` layout."""
    return ((round_dir / "00_manifest" / "coverage_before_release_cluster.csv").is_file()
            or (round_dir / SCOPE_BEFORE).is_dir()
            or (round_dir / SCOPE_AFTER).is_dir()
            or (round_dir / SCOPE_ONLINE).is_dir())


def scope_coverage_path(round_dir: Path, side: str):
    for name in COVERAGE_FILES[side]:
        path = round_dir / "00_manifest" / name
        if path.is_file():
            return path
    return None


def _split_paths(value):
    return [part for part in (value or "").split(";") if part]


def _model_from_store(value):
    tail = (value or "").rsplit("_", 1)[-1]
    return tail if tail in ("fast", "expert") else ""


def _model_from_dir(name: str) -> str:
    tail = (name or "").rsplit("_", 1)[-1]
    return tail if tail in ("fast", "expert") else (name or "")


def _tree_models(round_dir: Path, side: str):
    models = set()
    for rel in SCOPE_TREES[side]:
        base = round_dir / rel
        if not base.is_dir():
            continue
        for path in base.glob("*/item_index.slice.jsonl"):
            models.add(_model_from_dir(path.parent.name))
    return sorted(models)


def read_trace_scenes(round_dir: Path):
    """Optional ``00_manifest/trace_scenes.csv``: trace_id, task, subtask.

    The three-scope coverage files carry no scene columns, so the matrix groups by scene only
    when this file (or the build's samples) can supply it.  Everything else falls back to
    ``未接入分类体系``, exactly like a trace whose source has no task.
    """
    path = round_dir / "00_manifest" / "trace_scenes.csv"
    if not path.is_file():
        return {}
    scenes = {}
    for row in read_rows(path):
        trace = (row.get("trace_id") or "").strip()
        if trace:
            scenes[trace] = ((row.get("task") or "").strip(), (row.get("subtask") or "").strip())
    return scenes


def _scope_rows(round_dir: Path):
    """Normalize the three scopes' coverage CSVs into one row shape."""
    tree_models = {side: _tree_models(round_dir, side) for side in SCOPE_TREES}
    normalized = {}
    for side in ("before", "after", "online"):
        path = scope_coverage_path(round_dir, side)
        rows = read_rows(path) if path else []
        default_model = tree_models[side][0] if len(tree_models[side]) == 1 else ""
        out = []
        for row in rows:
            trace = str(row.get("trace_id") or "")
            if not trace:
                continue
            out.append({
                "trace": trace,
                "session": str(row.get("session_id") or row.get("retest_session_id") or ""),
                "model": _model_from_store(row.get("eval_store")) or (row.get("model") or "").strip()
                         or (row.get("mode") or "").strip() or default_model,
                "source": (row.get("eval_category") or "").strip(),
                "date": (row.get("question_time") or "")[:10],
                "paths": _split_paths(row.get("cls_paths")),
                "task": (row.get("task") or row.get("scene") or "").strip(),
                "sub": (row.get("subtask") or row.get("sub") or "").strip(),
                "state": (row.get("status") or row.get("retest_state") or "").strip(),
            })
        normalized[side] = out
    return normalized


def _sample_index(samples):
    """trace/session -> scene and unique sample slug, for the build's samples."""
    by_trace = {}
    scenes_by_session = defaultdict(list)
    slugs_by_trace = defaultdict(set)
    slugs_by_session = defaultdict(set)
    for slug, detail, row, _facts in samples or []:
        detail = detail or {}
        meta = detail.get("meta") or {}
        task = (meta.get("task") or meta.get("skill") or "").strip()
        sub = (meta.get("subtask") or "").strip()
        model = str(row.get("m") or "")
        sid = str(row.get("sid") or (detail.get("ids") or {}).get("session") or "")
        day = str(row.get("d") or "")
        traces = set()
        for turn in (detail.get("attribution") or {}).get("turns") or []:
            key = turn.get("trace_id")
            if key:
                traces.add(str(key))
        for key in (detail.get("ids") or {}).values():
            if key:
                traces.add(str(key))
        if row.get("tid"):
            traces.add(str(row["tid"]))
        for trace in traces:
            slugs_by_trace[trace].add(slug)
            if task:
                by_trace.setdefault(trace, (task, sub))
        if sid:
            slugs_by_session[(sid, model)].add(slug)
            scenes_by_session[sid].append({"model": model, "date": day, "task": task, "sub": sub})
    return {"by_trace": by_trace, "by_session": scenes_by_session,
            "slugs_by_trace": slugs_by_trace, "slugs_by_session": slugs_by_session}


def _scene_for(row, index, trace_scenes):
    if row["task"]:
        return row["task"], row["sub"]
    scene = trace_scenes.get(row["trace"])
    if scene and scene[0]:
        return scene
    hit = index["by_trace"].get(row["trace"]) if index else None
    if hit:
        return hit
    if index:
        candidates = index["by_session"].get(row["session"]) or []
        same = [c for c in candidates if c["task"] and c["model"] == row["model"] and c["date"] == row["date"]]
        if not same:
            same = [c for c in candidates if c["task"] and c["model"] == row["model"]]
        if not same:
            same = [c for c in candidates if c["task"]]
        if same:
            return same[0]["task"], same[0]["sub"]
    return NO_SCENE, ""


def _slug_for(row, index):
    if not index:
        return None
    slugs = index["slugs_by_trace"].get(row["trace"]) or set()
    if len(slugs) == 1:
        return next(iter(slugs))
    slugs = index["slugs_by_session"].get((row["session"], row["model"])) or set()
    if len(slugs) == 1:
        return next(iter(slugs))
    return None


def _collect_side(rows, index, trace_scenes, with_slug=True):
    """Count one side from normalized rows.  Only traces that hit a leaf enter leaves/matrix."""
    counter = Counter()
    by_model = defaultdict(Counter)
    by_source = defaultdict(Counter)
    matrix = Counter()
    refs = []
    by_trace = {}
    for row in rows:
        paths = row["paths"]
        if not paths:
            continue
        task, sub = _scene_for(row, index, trace_scenes)
        by_trace[row["trace"]] = paths
        ref = {"trace": row["trace"], "model": row["model"], "task": task, "sub": sub, "paths": paths}
        slug = _slug_for(row, index) if with_slug else None
        if slug:
            ref["slug"] = slug
        refs.append(ref)
        for path in paths:
            counter[path] += 1
            matrix[(task, sub, path)] += 1
            if row["model"]:
                by_model[path][row["model"]] += 1
            if row["source"]:
                by_source[path][row["source"]] += 1
    return {"counter": counter, "model": by_model, "source": by_source, "matrix": matrix,
            "refs": refs, "by_trace": by_trace, "rows": len(rows), "available": bool(rows)}


def _online_from_samples(round_dir, meta, samples, before_rows, next_release):
    """Legacy online side: real users after the release, before the next one."""
    online_start = meta.get("released_at")
    if samples is None or not online_start:
        return None
    counter = Counter()
    by_model = defaultdict(Counter)
    by_source = defaultdict(Counter)
    matrix = Counter()
    refs = []
    dates = set()
    traces = 0
    fixed = {row["trace"] for row in before_rows if row["trace"]}
    for slug, detail, row, _facts in samples:
        day = str(row.get("d") or "")
        if row.get("ut") != "real" or not day or day < online_start:
            continue
        if next_release and day >= next_release:
            continue
        trace = str(row.get("tid") or "")
        if trace and trace in fixed:
            continue
        detail = detail or {}
        paths = sorted({p["cl"]["path"] for p in (detail.get("attribution") or {}).get("problems", [])
                        if p.get("cl") and p["cl"].get("path")})
        traces += 1
        dates.add(day)
        task, sub = scene_pair(detail, row)
        model = _model_from_dir(row.get("m") or "")
        if paths:
            refs.append({"slug": slug, "trace": trace, "model": model, "task": task, "sub": sub,
                         "paths": paths})
        for path in paths:
            counter[path] += 1
            matrix[(task, sub, path)] += 1
            if model:
                by_model[path][model] += 1
            by_source[path]["online_real"] += 1
    return {"counter": counter, "model": by_model, "source": by_source, "matrix": matrix,
            "refs": refs, "traces": traces, "dates": dates, "available": True}


def _build_round_scoped(round_dir: Path, order: int, version: str, samples=None,
                        next_release: str | None = None, meta=None):
    meta = meta or round_meta(round_dir, order, version)
    data = _scope_rows(round_dir)
    index = _sample_index(samples)
    trace_scenes = read_trace_scenes(round_dir)
    before = _collect_side(data["before"], index, trace_scenes)
    after = _collect_side(data["after"], index, trace_scenes, with_slug=False)
    online = _collect_side(data["online"], index, trace_scenes) if data["online"] else None
    if online is None:
        online = _online_from_samples(round_dir, meta, samples, data["before"], next_release)
    after_available = bool(after["available"])
    online_available = bool(online and online.get("available"))
    online = online or {"counter": Counter(), "model": {}, "source": {}, "matrix": Counter(),
                        "refs": [], "traces": 0, "dates": set(), "available": False}

    names = read_leaf_names(round_dir)
    leaves = []
    for path in sorted(set(before["counter"]) | set(after["counter"]) | set(online["counter"]),
                       key=node_order):
        leaves.append({
            "id": path,
            "name": names.get(path) or path,
            "before": before["counter"].get(path, 0),
            "after": after["counter"].get(path, 0) if after_available else None,
            "online": online["counter"].get(path, 0) if online_available else None,
            "model_before": dict(before["model"].get(path) or {}),
            "model_after": dict(after["model"].get(path) or {}) if after_available else None,
            "model_online": dict(online["model"].get(path) or {}) if online_available else None,
            "source_before": dict(before["source"].get(path) or {}),
            "source_after": dict(after["source"].get(path) or {}) if after_available else None,
            "source_online": dict(online["source"].get(path) or {}) if online_available else None,
        })

    if online_available and data["online"]:
        online_from = meta.get("released_at") or (min(online["dates"]) if online["dates"] else None)
        online_traces = online["rows"]
    else:
        online_from = meta.get("released_at")
        online_traces = online.get("traces", 0)
    meta["sides"] = {
        "before": {"traces": len(before["refs"]), "hits": sum(before["counter"].values())},
        "after": ({"traces": len(after["refs"]), "hits": sum(after["counter"].values())}
                  if after_available else None),
        "online": ({
            "traces": online_traces,
            "hits": sum(online["counter"].values()),
            "from": online_from,
            "to": max(online["dates"]) if online["dates"] else None,
            "user_type": "real",
        } if online_available else None),
    }
    meta["leaves"] = leaves
    meta["sample_refs"] = {"before": before["refs"], "after": after["refs"], "online": online["refs"]}
    meta["matrix"] = {
        "before": matrix_rows(before["matrix"]) if before["available"] else [],
        "after": matrix_rows(after["matrix"]) if after_available else None,
        "online": matrix_rows(online["matrix"]) if online_available else None,
    }
    meta["nodes"] = tree_nodes(before["counter"], after["counter"], online["counter"], names,
                               after_available, online_available)
    return meta


def _build_round_legacy(round_dir: Path, order: int, version: str, samples=None,
                        next_release: str | None = None, meta=None):
    """One legacy round: fixed-set before/after plus post-release real-user online validation."""
    meta = meta or round_meta(round_dir, order, version)
    rows = read_rows(round_dir / "00_manifest" / "coverage.csv")
    scenes = sample_scene_map(samples)
    sample_by_trace = defaultdict(set)
    for slug, detail, sample_row, _facts in samples or []:
        model = str(sample_row.get("m") or "").rsplit("_", 1)[-1]
        traces = {turn.get("trace_id") for turn in (detail.get("attribution") or {}).get("turns", [])}
        traces.add(sample_row.get("tid"))
        for trace in traces - {None, ""}:
            sample_by_trace[(str(trace), model)].add(slug)
    before, before_model, before_source = Counter(), defaultdict(Counter), defaultdict(Counter)
    before_matrix = Counter()
    sample_refs = {side: [] for side in ("before", "after", "online")}
    for row in rows:
        paths = [p for p in (row.get("cls_paths") or "").split(";") if p]
        if not paths:
            continue
        model = eval_model(str(row.get("eval_store") or ""))
        source = row.get("eval_category") or ""
        scene = coverage_scene(row, scenes)
        sample_refs["before"].append({"trace": str(row.get("trace_id") or ""), "model": model,
                                      "task": scene[0], "sub": scene[1], "paths": paths})
        slugs = sample_by_trace[(str(row.get("trace_id") or ""), model)]
        if len(slugs) == 1:
            sample_refs["before"][-1]["slug"] = next(iter(slugs))
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
            sample_refs["after"].append({"trace": trace, "model": model, "task": scene[0], "sub": scene[1], "paths": paths})
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
            if paths:
                sample_refs["online"].append({"slug": _slug, "trace": trace, "model": row.get("m") or "",
                                               "task": scene[0], "sub": scene[1], "paths": paths})
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
    meta["sample_refs"] = sample_refs
    meta["matrix"] = {
        "before": matrix_rows(before_matrix),
        "after": matrix_rows(after_matrix) if after_paths else None,
        "online": matrix_rows(online_matrix) if online_available else None,
    }
    meta["nodes"] = tree_nodes(before, after, online, names, bool(after_paths), online_available)
    return meta


def build_round(round_dir: Path, order: int, version: str, samples=None,
                next_release: str | None = None, meta=None):
    """One round, in either layout, always with the same payload shape."""
    if is_scope_layout(round_dir):
        return _build_round_scoped(round_dir, order, version, samples=samples,
                                   next_release=next_release, meta=meta)
    return _build_round_legacy(round_dir, order, version, samples=samples,
                               next_release=next_release, meta=meta)


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
