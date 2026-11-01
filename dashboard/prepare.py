#!/usr/bin/env python3
"""Build data.json for the eval dashboard from the curated datasets tree.

Source: /mnt/fin_bench/code_and_clean_data/datasets
  <product>/eval_input/<split>/<model>/<model>-<date>_input.jsonl (legacy)
  1_aime/eval_input/<split>/<model>/<date>.jsonl (current)
  <product>/eval_output/<split>/<model>/<model>-<date>_output.jsonl (legacy)
  1_aime/eval_output/demo_data/<model>/<model>_attribution-<date>.jsonl (current)
  <product>/eval_output/<split>/comparison/<pair>/<pair>-<date>_output.jsonl

The current demo_data root is preferred for AIME daily outputs; legacy and
.archive trees are fallbacks while the datasets tree migrates.

Volumes / per-day counts / meta categories come from cache/datasets.json
(scan_datasets.py); attribution, verdicts and token stats are parsed here.
"""
import argparse
import collections
import glob
import gzip
import json
import os
import re
import statistics
from datetime import datetime, timedelta, timezone

import dataset_layout as layout

# Production data root; override with EVAL_DATASETS to point at a local tree
# (see dashboard/local_dev/README.md for the offline dev fixture).
DATASETS = os.path.abspath(os.path.expanduser(
    os.environ.get("EVAL_DATASETS", "/mnt/fin_bench/code_and_clean_data/datasets")
))
TZ = timezone(timedelta(hours=8), "CST")

WENCAI_MODELS = ["a_expert", "a_fast", "b_expert", "b_fast"]
AIME_SEVERITIES = ["P0", "P1", "P2", "P3", "未分级"]

WENCAI_OUTPUT_DIR = layout.wencai_output_dir(DATASETS)
AIME_GROUPS = layout.aime_group_dirs(DATASETS)
AIME_CLUSTERS = layout.aime_clusters(DATASETS)
CLUSTER_FILES = {
    "wencai": layout.wencai_cluster(DATASETS),
    "aime": AIME_CLUSTERS["daily"],
}
LOST_CLUSTER = AIME_CLUSTERS["lost"]

WENCAI_INPUT_GLOB = f"{DATASETS}/0_wencai/eval_input/*/*/*.jsonl"
AIME_INPUT_GLOB = f"{DATASETS}/1_aime/eval_input/*/*/*.jsonl"


def wencai_output_paths(model=None):
    if not WENCAI_OUTPUT_DIR:
        return []
    base = f"{WENCAI_OUTPUT_DIR}/{model}" if model else f"{WENCAI_OUTPUT_DIR}/*"
    return sorted(
        set(
            glob.glob(f"{base}/*_output.jsonl")
            + glob.glob(f"{base}/*_attribution-*.jsonl")
        )
    )


def wencai_comparison_paths(pair=None):
    if not WENCAI_OUTPUT_DIR:
        return []
    base = f"{WENCAI_OUTPUT_DIR}/comparison/{pair}" if pair else f"{WENCAI_OUTPUT_DIR}/comparison/*"
    return sorted(glob.glob(f"{base}/*_output.jsonl"))


def aime_output_paths(directory):
    """Read legacy *_output files and the current *_attribution files.

    Compact artifacts are deliberately excluded: they are summaries, not an
    additional evaluation result, and counting them would double the coverage.
    """
    if not directory:
        return []
    return sorted(
        set(
            glob.glob(f"{directory}/*/*_output.jsonl")
            + glob.glob(f"{directory}/*/*_attribution-*.jsonl")
        )
    )


def now_iso():
    return datetime.now(TZ).isoformat(timespec="seconds")


def pct(a, b):
    return round(100.0 * a / b, 1) if b else 0.0


def median(vals):
    return statistics.median(vals) if vals else None


def file_date(path):
    """YYYY-MM-DD carried by an eval file name, or None."""
    match = re.search(r"(\d{4}-\d{2}-\d{2})", os.path.basename(path or ""))
    return match.group(1) if match else None


def iso_cst(ts):
    return datetime.fromtimestamp(ts, TZ).isoformat(timespec="seconds") if ts else None


def artifact_summary(paths):
    """(newest mtime ISO, newest data date, file count) for a batch of files."""
    newest, dates = None, []
    for path in paths:
        try:
            mtime = os.path.getmtime(path)
        except OSError:
            continue
        newest = mtime if newest is None else max(newest, mtime)
        date = file_date(path)
        if date:
            dates.append(date)
    return iso_cst(newest), max(dates) if dates else None, len(paths)


def read_cluster_meta(path):
    if not path:
        return None
    try:
        with open(path) as fh:
            raw = json.load(fh)
    except (OSError, json.JSONDecodeError):
        return None
    meta = raw.get("meta") or {}
    return {
        "generated_at": meta.get("generated_at"),
        "pipeline_version": meta.get("pipeline_version"),
        "total_sessions": meta.get("total_sessions"),
        "total_items": meta.get("total_items"),
        "depth": meta.get("depth"),
        "level_names": meta.get("level_names") or [],
    }


def newest_date(paths):
    dates = [file_date(path) for path in paths]
    dates = [date for date in dates if date]
    return max(dates) if dates else None


def sibling_output_paths(cluster_path):
    """Output files sitting next to a cluster tree (same model directory)."""
    if not cluster_path:
        return []
    model_dir = os.path.dirname(os.path.dirname(cluster_path))
    return sorted(
        set(
            glob.glob(f"{model_dir}/*_output.jsonl")
            + glob.glob(f"{model_dir}/*_attribution-*.jsonl")
        )
    )


def build_freshness():
    """Conservative freshness of input / attribution / cluster artefacts.

    A section is stale when the newest data it covers is older than the
    expected daily batch (yesterday, CST), when attribution lags its input, or
    when a cluster was generated before the attribution it should describe.
    """
    now = datetime.now(TZ)
    expected = (now - timedelta(days=1)).date().isoformat()

    input_at, input_date, _ = artifact_summary(
        glob.glob(WENCAI_INPUT_GLOB) + glob.glob(AIME_INPUT_GLOB)
    )
    wencai_out = wencai_output_paths()
    compare_out = wencai_comparison_paths()
    aime_by_group = {
        name: aime_output_paths(directory) for name, directory in AIME_GROUPS
    }
    attribution_at, attribution_date, _ = artifact_summary(
        wencai_out
        + compare_out
        + [path for paths in aime_by_group.values() for path in paths]
    )

    coverage = {
        "wencai": newest_date(wencai_out),
        "aime_daily": newest_date(aime_by_group.get("daily", [])),
        "aime_lost": newest_date(aime_by_group.get("lost", [])),
    }
    cluster_sources = []
    cluster_coverage = {}
    for name, path in (
        ("wencai", CLUSTER_FILES["wencai"]),
        ("aime_daily", CLUSTER_FILES["aime"]),
        ("aime_lost", LOST_CLUSTER),
    ):
        meta = read_cluster_meta(path)
        if meta:
            cluster_sources.append({"name": name, **meta})
        cluster_coverage[name] = newest_date(sibling_output_paths(path))
    cluster_at = max((s["generated_at"] for s in cluster_sources if s.get("generated_at")), default=None)
    versions = sorted({s["pipeline_version"] for s in cluster_sources if s.get("pipeline_version")})
    cluster_version = versions[0] if len(versions) == 1 else (" / ".join(versions) or None)
    cluster_date = max((d for d in cluster_coverage.values() if d), default=None)

    input_reasons = []
    if not input_date:
        input_reasons.append("未发现输入文件")
    elif input_date < expected:
        input_reasons.append(f"最新输入 {input_date} 早于预期日更批次 {expected}")
    attribution_reasons = []
    if not attribution_date:
        attribution_reasons.append("未发现归因输出文件")
    elif attribution_date < expected:
        attribution_reasons.append(f"归因覆盖至 {attribution_date}，{expected} 批次缺失")
    if input_date and attribution_date and attribution_date < input_date:
        attribution_reasons.append(f"归因覆盖 {attribution_date} 落后于输入 {input_date}")
    cluster_reasons = []
    if not cluster_at:
        cluster_reasons.append("未发现聚类树")
    if cluster_date and cluster_date < expected:
        cluster_reasons.append(f"聚类数据覆盖至 {cluster_date}，{expected} 批次缺失")
    if cluster_at and attribution_at and cluster_at < attribution_at:
        cluster_reasons.append("聚类生成早于最新归因产物")

    def at_label(at):
        return at[:16].replace("T", " ") if at else "—"

    return {
        "as_of": now.isoformat(timespec="seconds"),
        "expected_date": expected,
        "input": {
            "at": input_at,
            "date": input_date,
            "label": f"输入覆盖至 {input_date or '—'} · 文件 {at_label(input_at)} 入库",
            "stale": bool(input_reasons),
            "reason": "；".join(input_reasons),
        },
        "attribution": {
            "at": attribution_at,
            "date": attribution_date,
            "label": f"归因覆盖至 {attribution_date or '—'} · {at_label(attribution_at)} 生成",
            "stale": bool(attribution_reasons),
            "version": None,
            "version_source": "unmarked",
            "reason": "；".join(attribution_reasons),
        },
        "cluster": {
            "at": cluster_at,
            "date": cluster_date,
            "label": (
                f"聚类 {at_label(cluster_at)} 生成 · v{cluster_version or '—'} · "
                f"覆盖至 {cluster_date or '—'}"
            ),
            "stale": bool(cluster_reasons),
            "version": cluster_version,
            "coverage": coverage,
            "cluster_coverage": cluster_coverage,
            "sources": cluster_sources,
            "reason": "；".join(cluster_reasons),
        },
        "note": "保守判定：数据未跟上预期日更批次即标 stale，不以产物生成时间代替数据覆盖时间。",
    }


# ----------------------------------------------------------------- wencai out

def wencai_outputs():
    versions = {}
    components = collections.Counter()  # (version, component)
    labels = collections.defaultdict(collections.Counter)  # version -> label
    per_day = {}  # date -> counters + latencies
    severity_available = False
    for model in WENCAI_MODELS:
        answers = 0
        ok = 0
        tokens = 0
        problems = 0
        latency = []
        difficulty = collections.Counter()
        for path in wencai_output_paths(model):
            day = per_day.setdefault(
                file_date(path) or "未知",
                {"answers": 0, "problems": 0, "tokens": 0, "latency": []},
            )
            with open(path) as fh:
                for line in fh:
                    try:
                        rec = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    meta = rec.get("session_meta") or {}
                    answers += 1
                    day["answers"] += 1
                    ok += 1 if meta.get("ok") else 0
                    used = (meta.get("usage") or {}).get("total_tokens") or 0
                    tokens += used
                    day["tokens"] += used
                    cost = meta.get("finish_answer_time_cost")
                    if cost:
                        latency.append(cost / 1000.0)
                        day["latency"].append(cost / 1000.0)
                    difficulty[meta.get("difficulty") or "未标注"] += 1
                    for p in rec.get("session_problem") or []:
                        problems += 1
                        day["problems"] += 1
                        components[(model, p.get("component") or "未标注")] += 1
                        labels[model][p.get("label") or "未标注"] += 1
                        if p.get("severity"):
                            severity_available = True
                    for turn in rec.get("turns") or []:
                        for p in turn.get("problem") or []:
                            problems += 1
                            day["problems"] += 1
                            components[(model, p.get("component") or "未标注")] += 1
                            labels[model][p.get("label") or "未标注"] += 1
                            if p.get("severity"):
                                severity_available = True
        versions[model] = {
            "answers": answers,
            "ok": ok,
            "tokens": tokens,
            "problems": problems,
            "density": round(problems / answers, 2) if answers else 0,
            "p50": round(median(latency) or 0, 1),
            "difficulty": dict(difficulty),
        }
    per_day_out = [
        {
            "date": date,
            "answers": day["answers"],
            "problems": day["problems"],
            "p50": round(median(day["latency"]) or 0, 1),
            "tokens": day["tokens"],
        }
        for date, day in sorted(per_day.items())
    ]
    top_labels = {
        model: [{"name": name, "value": n} for name, n in labels[model].most_common(10)]
        for model in WENCAI_MODELS
    }
    return {
        "versions": versions,
        "components": components,
        "labels": top_labels,
        "per_day": per_day_out,
        "severity_available": severity_available,
    }


def wencai_comparison():
    pairs = {}
    meets = collections.defaultdict(lambda: {"decided": 0, "meets": 0})
    for pair in ["a_fast_vs_b_fast", "a_expert_vs_b_expert"]:
        a, b = pair.split("_vs_")
        agg = {"n": 0, "a_win": 0, "b_win": 0, "both_good": 0, "both_bad": 0}
        for path in wencai_comparison_paths(pair):
            with open(path) as fh:
                for line in fh:
                    try:
                        rec = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if rec.get("status") != "decided":
                        continue
                    agg["n"] += 1
                    for verdict in (rec.get("verdicts") or {}).values():
                        result = verdict.get("result")
                        if result == "win":
                            if verdict.get("winner_version") == a:
                                agg["a_win"] += 1
                            elif verdict.get("winner_version") == b:
                                agg["b_win"] += 1
                        elif result == "both_good":
                            agg["both_good"] += 1
                        elif result == "both_bad":
                            agg["both_bad"] += 1
                    for version, assessment in (rec.get("assessments") or {}).items():
                        if version not in (a, b):
                            continue
                        meets[version]["decided"] += 1
                        if assessment.get("meets_core"):
                            meets[version]["meets"] += 1
        pairs[pair] = agg
    meets_core = {
        v: round(100 * meets[v]["meets"] / meets[v]["decided"], 1) if meets[v]["decided"] else None
        for v in WENCAI_MODELS
    }
    return pairs, meets_core


def build_wencai_components(raw, top_n=6):
    totals = collections.Counter()
    for (version, comp), n in raw.items():
        totals[comp] += n
    top = [c for c, _ in totals.most_common(top_n)]
    groups = {"A": collections.Counter(), "B": collections.Counter()}
    for (version, comp), n in raw.items():
        if comp not in top:
            continue
        groups["A" if version.startswith("a_") else "B"][comp] += n

    names = top[:]
    a_vals = [groups["A"][c] for c in top]
    b_vals = [groups["B"][c] for c in top]

    # Fold the long tail into one tile so A + B always equals the problem total.
    rest_a = sum(n for (v, c), n in raw.items() if c not in top and v.startswith("a_"))
    rest_b = sum(n for (v, c), n in raw.items() if c not in top and not v.startswith("a_"))
    if rest_a or rest_b:
        label = "其他" if "其他" not in names else "其余"
        names.append(label)
        a_vals.append(rest_a)
        b_vals.append(rest_b)

    return {
        "names": names,
        "A": a_vals,
        "B": b_vals,
        "other": rest_a + rest_b,
    }


def build_wencai_by_version(raw):
    """Model -> component counter, keeping every component (no 其他 folding)."""
    out = {}
    for version in WENCAI_MODELS:
        comps = {comp: n for (v, comp), n in raw.items() if v == version}
        out[version] = dict(sorted(comps.items(), key=lambda kv: -kv[1]))
    return out


def percentile(values, q):
    if not values:
        return None
    ordered = sorted(values)
    pos = (len(ordered) - 1) * q
    low = int(pos)
    high = min(low + 1, len(ordered) - 1)
    return round(ordered[low] + (ordered[high] - ordered[low]) * (pos - low), 1)


# -------------------------------------------------------------------- aime

def build_aime_components(raw, sev_raw, top_n=7):
    totals = collections.Counter()
    for (model, comp), n in raw.items():
        totals[comp] += n
    top = [c for c, _ in totals.most_common(top_n)]
    names = top[:]
    out = {"names": names, "fast": [], "expert": [], "severity": {}}
    for name in names:
        out["fast"].append(raw.get(("fast", name), 0))
        out["expert"].append(raw.get(("expert", name), 0))
        out["severity"][name] = {s: sev_raw.get((name, s), 0) for s in AIME_SEVERITIES}

    # Keep the tail visible as one tile so the treemap total equals out.problems.
    rest = [c for c in totals if c not in top]
    if rest:
        label = "其他" if "其他" not in names else "其余"
        names.append(label)
        out["fast"].append(sum(raw.get(("fast", c), 0) for c in rest))
        out["expert"].append(sum(raw.get(("expert", c), 0) for c in rest))
        out["severity"][label] = {
            s: sum(sev_raw.get((c, s), 0) for c in rest) for s in AIME_SEVERITIES
        }
    return out


def aime_outputs():
    severity = collections.Counter()
    components = collections.Counter()  # (model, component)
    sev_by_comp = collections.Counter()  # (component, severity)
    components_by_model = collections.defaultdict(collections.Counter)
    sev_by_model_comp = collections.defaultdict(lambda: collections.defaultdict(collections.Counter))
    composite_skipped = 0
    per_day = {}
    answers = 0
    tokens = 0
    durations = []
    difficulty = collections.Counter()
    tasks = collections.Counter()
    subtasks = collections.Counter()
    task_subtasks = collections.defaultdict(collections.Counter)

    for _, directory in AIME_GROUPS:
        for path in aime_output_paths(directory):
            base = os.path.basename(path)
            if "_attribution-" in base:
                model = base.split("_attribution-", 1)[0]
            else:
                model = base.split("-", 1)[0]
            model = model.replace("aime_", "")
            date_match = re.search(r"(\d{4}-\d{2}-\d{2})", base)
            if not date_match:
                continue
            date = date_match.group(1)
            day = per_day.setdefault(
                date,
                {
                    "answers": 0,
                    "problems": 0,
                    "tokens": 0,
                    "latency": [],
                    "severity": collections.Counter(),
                    "fast": 0,
                    "expert": 0,
                },
            )
            with open(path) as fh:
                for line in fh:
                    try:
                        rec = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    answers += 1
                    day[model] += 1
                    day["answers"] += 1
                    record_tokens = 0
                    last_turn_meta = None
                    for turn in rec.get("turns") or []:
                        meta = turn.get("meta") or {}
                        last_turn_meta = meta
                        used = meta.get("total_tokens") or 0
                        tokens += used
                        record_tokens += used
                        if meta.get("total_duration_ms"):
                            durations.append(meta["total_duration_ms"] / 1000.0)
                            day["latency"].append(meta["total_duration_ms"] / 1000.0)
                        for p in turn.get("problem") or []:
                            sev = p.get("severity") or "未分级"
                            comp = p.get("component") or "未标注"
                            severity[sev] += 1
                            components[(model, comp)] += 1
                            sev_by_comp[(comp, sev)] += 1
                            components_by_model[model][comp] += 1
                            sev_by_model_comp[model][comp][sev] += 1
                            day["problems"] += 1
                            day["severity"][sev] += 1
                    for p in rec.get("session_problem") or []:
                        sev = p.get("severity") or "未分级"
                        comp = p.get("component") or "未标注"
                        severity[sev] += 1
                        components[(model, comp)] += 1
                        sev_by_comp[(comp, sev)] += 1
                        # session_problem may carry a cross-stage chain
                        # ("A / B"); keep it out of the single-stage Sankey.
                        if " / " in comp:
                            composite_skipped += 1
                        else:
                            components_by_model[model][comp] += 1
                            sev_by_model_comp[model][comp][sev] += 1
                        day["problems"] += 1
                        day["severity"][sev] += 1
                    day["tokens"] += record_tokens

                    last_meta = last_turn_meta or rec.get("session_meta") or {}
                    difficulty[last_meta.get("difficulty") or "未标注"] += 1
                    task = last_meta.get("task") or "未标注"
                    subtask = last_meta.get("subtask") or "未标注"
                    tasks[task] += 1
                    subtasks[subtask] += 1
                    task_subtasks[task][subtask] += 1

    totals = collections.Counter()
    for d in per_day.values():
        totals.update({k: v for k, v in d.items() if k in ("fast", "expert")})
    per_day_out = []
    for date, day in sorted(per_day.items()):
        per_day_out.append({
            "date": date,
            "fast": day["fast"],
            "expert": day["expert"],
            "answers": day["answers"],
            "problems": day["problems"],
            "p50": round(median(day["latency"]) or 0, 1),
            "tokens": day["tokens"],
            "severity": {s: day["severity"].get(s, 0) for s in AIME_SEVERITIES},
        })

    by_model_components = {
        model: dict(sorted(components_by_model[model].items(), key=lambda kv: -kv[1]))
        for model in ("fast", "expert")
    }
    by_model_severity = {
        model: {
            comp: {s: sev_by_model_comp[model][comp].get(s, 0) for s in AIME_SEVERITIES}
            for comp in by_model_components[model]
        }
        for model in ("fast", "expert")
    }
    comp = build_aime_components(components, sev_by_comp)
    comp["by_model"] = by_model_components
    comp["severity_by_model"] = by_model_severity
    comp["composite_skipped"] = composite_skipped
    comp["by_model_note"] = (
        "by_model / severity_by_model 只统计单一环节 component；"
        "session_problem 的跨环节组合（A / B）不进入 model→component→severity Sankey"
    )

    problems = sum(severity.values())
    return {
        "answers": answers,
        "tokens": tokens,
        "per_day": per_day_out,
        "by_model": dict(totals),
        "severity": {s: severity.get(s, 0) for s in AIME_SEVERITIES},
        "problems": problems,
        "difficulty": dict(difficulty),
        "components": comp,
        "tasks": dict(tasks),
        "subtasks": dict(subtasks),
        "task_subtask": {task: dict(subs) for task, subs in task_subtasks.items()},
        "task_total": sum(tasks.values()),
        "p50": round(median(durations) or 0, 1),
        "p90": percentile(durations, 0.9),
        "density": round(problems / answers, 2) if answers else 0,
        "performance": {
            "answers": answers,
            "problems": problems,
            "tokens": tokens,
            "p50": round(median(durations) or 0, 1),
            "p90": percentile(durations, 0.9),
            "tokens_per_answer": round(tokens / answers) if answers else 0,
            "problems_per_answer": round(problems / answers, 2) if answers else 0,
            "severity_mix": {s: severity.get(s, 0) for s in AIME_SEVERITIES},
        },
        "forecast_inputs": [
            {
                "date": day["date"],
                "answers": day["answers"],
                "problems": day["problems"],
                "p50": day["p50"],
                "tokens": day["tokens"],
            }
            for day in per_day_out
        ],
    }


# ------------------------------------------------------------------ assembly

def top_categories(counts, top_n=None):
    items = sorted(counts.items(), key=lambda kv: -kv[1])
    head = items if top_n is None else items[:top_n]
    rest = 0 if top_n is None else sum(v for _, v in items[top_n:])
    out = [{"name": k, "value": v} for k, v in head if v]
    if rest:
        out.append({"name": "其他", "value": rest})
    return out


def input_days(product_scan):
    counter = collections.Counter()
    for meta in (product_scan.get("input") or {}).values():
        for date, n in (meta.get("per_day") or {}).items():
            counter[date] += n
    days = [{"date": d, "value": n} for d, n in sorted(counter.items())]
    date_range = {"start": days[0]["date"], "end": days[-1]["date"]} if days else None
    return days, date_range


def _surface_counts(raw):
    out = collections.Counter()
    for name, n in raw.items():
        out[surface_of(name)] += n
    return dict(out)


def surface_of(name):
    low = (name or "").lower()
    if not name or name == "未标注":
        return "其他"
    if "paper" in low:
        return "模拟交易"
    if "screener" in low:
        return "选股"
    if "ainvest" in low:
        return "Ainvest"
    if "search" in low:
        return "搜索"
    return "其他"



def compact_cluster(path, top_n=8, max_levels=4):
    """Trim a cluster tree to a bounded four-level dashboard payload.

    Real clusters can contain thousands of sibling nodes. Keep the largest
    branches at each level and aggregate the rest so every drilldown remains
    responsive while preserving the full session/item totals.
    """
    if not path or not os.path.exists(path):
        return None
    try:
        with open(path) as fh:
            raw = json.load(fh)
    except (OSError, json.JSONDecodeError):
        return None
    meta = raw.get("meta") or {}
    root = raw.get("tree") or {}

    def trim(node, depth):
        sessions = node.get("sessions")
        if sessions is None:
            sessions = node.get("count") or 0
        items = node.get("count") or 0
        kids = node.get("children") or []
        out = {
            "name": node.get("name") or "未命名",
            "value": int(sessions),
            "items": int(items),
            "level": depth,
            "level_name": (meta.get("level_names") or [])[depth - 1] if depth else "根节点",
        }
        if node.get("id"):
            out["id"] = node["id"]
        if node.get("path"):
            out["path"] = node["path"]
        if depth >= max_levels or not kids:
            return out
        kids = sorted(
            kids,
            key=lambda x: (x.get("sessions") if x.get("sessions") is not None else x.get("count") or 0),
            reverse=True,
        )
        kept = kids[:top_n]
        children = [trim(k, depth + 1) for k in kept]
        used = sum(
            int(k.get("sessions") if k.get("sessions") is not None else k.get("count") or 0)
            for k in kept
        )
        used_items = sum(int(k.get("count") or 0) for k in kept)
        rest = max(0, int(sessions) - used)
        if rest:
            children.append({
                "name": "其他",
                "value": rest,
                "items": max(0, int(items) - used_items),
                "level": depth + 1,
                "level_name": (meta.get("level_names") or [])[depth] if depth < len(meta.get("level_names") or []) else "",
            })
        out["children"] = children
        return out

    tree = trim(root, 0)
    return {
        "meta": {
            "total_sessions": meta.get("total_sessions") or tree["value"],
            "total_items": meta.get("total_items") or tree["items"],
            "depth": min(int(meta.get("depth") or max_levels), max_levels),
            "level_names": (meta.get("level_names") or [])[:max_levels],
            "source": meta.get("source") or "a_fast",
        },
        "tree": tree,
    }

def build(counts_path, out_path):
    with open(counts_path) as fh:
        scan = json.load(fh)

    wc_out = wencai_outputs()
    wc_versions = wc_out["versions"]
    wc_components = wc_out["components"]
    wc_pairs, wc_meets = wencai_comparison()
    aime_out = aime_outputs()

    wc_scan = scan["wencai"]
    ai_scan = scan["aime"]
    wc_days, wc_range = input_days(wc_scan)
    ai_days, ai_range = input_days(ai_scan)

    wc_input_total = wc_scan["total"]["input"]
    wc_evaluated = sum(v["answers"] for v in wc_versions.values())
    ai_input_total = ai_scan["total"]["input"]
    ai_evaluated = aime_out["answers"]

    data = {
        "schema_version": 2,
        "generated_at": now_iso(),
        "counts_at": scan.get("generated_at", "—"),
        "wencai": {
            "input": {
                "total": wc_input_total,
                "bytes": wc_scan["bytes"]["input"],
                "files": wc_scan["files"]["input"],
                "per_day": wc_days,
                "date_range": wc_range,
                "pending": max(0, wc_input_total - wc_evaluated),
                "evaluated": wc_evaluated,
                "categories": {
                    "task": top_categories(collections.Counter(wc_scan["categories"].get("task", {})), 14),
                    "task_subtask": {
                        task: top_categories(collections.Counter(subs), 8)
                        for task, subs in (wc_scan["categories"].get("task_subtask") or {}).items()
                    },
                    "difficulty": top_categories(collections.Counter(wc_scan["categories"].get("difficulty", {}))),
                },
            },
            "output": {
                "answers": wc_evaluated,
                "problems": sum(v["problems"] for v in wc_versions.values()),
                "tokens": sum(v["tokens"] for v in wc_versions.values()),
                "versions": wc_versions,
                "comparisons": wc_pairs,
                "comparison_total": sum(p["n"] for p in wc_pairs.values()),
                "meets_core": wc_meets,
                "components": {
                    "by_version": build_wencai_by_version(wc_components),
                    "labels": wc_out["labels"],
                },
                "per_day": wc_out["per_day"],
                "severity_available": wc_out["severity_available"],
            },
            "components": build_wencai_components(wc_components),
            "cluster": compact_cluster(CLUSTER_FILES["wencai"]),
            "run": {"status": "snapshot", "name": "datasets · 2026-10-23"},
        },
        "aime": {
            "input": {
                "total": ai_input_total,
                "bytes": ai_scan["bytes"]["input"],
                "files": ai_scan["files"]["input"],
                "per_day": ai_days,
                "date_range": ai_range,
                "pending": max(0, ai_input_total - ai_evaluated),
                "evaluated": ai_evaluated,
                "groups": ai_scan.get("input", {}),
                "categories": {
                    "task": top_categories(collections.Counter(aime_out["tasks"]), 14),
                    "task_subtask": {
                        task: top_categories(collections.Counter(subs), 8)
                        for task, subs in aime_out["task_subtask"].items()
                    },
                    "task_total": aime_out["task_total"],
                    "difficulty": top_categories(collections.Counter(aime_out["difficulty"])),
                    "comefrom": top_categories(collections.Counter(_surface_counts(ai_scan["categories"].get("comefrom", {})))),
                    "agent_mode": top_categories(collections.Counter(ai_scan["categories"].get("agent_mode", {}))),
                },
            },
            "output": aime_out,
            "cluster": compact_cluster(CLUSTER_FILES["aime"]),
        },
        "freshness": build_freshness(),
    }

    a_win = sum(p["a_win"] for p in wc_pairs.values())
    b_win = sum(p["b_win"] for p in wc_pairs.values())
    both_good = sum(p["both_good"] for p in wc_pairs.values())
    both_bad = sum(p["both_bad"] for p in wc_pairs.values())

    data["conclusion"] = {
        "wencai": {
            "coverage": pct(wc_evaluated, wc_input_total),
            "a_win": a_win,
            "b_win": b_win,
            "both_good": both_good,
            "both_bad": both_bad,
            "a_win_rate": pct(a_win, a_win + b_win),
            "b_win_rate": pct(b_win, a_win + b_win),
            "density": round(data["wencai"]["output"]["problems"] / wc_evaluated, 2) if wc_evaluated else 0,
        },
        "aime": {
            "coverage": pct(ai_evaluated, ai_input_total),
            "pending": data["aime"]["input"]["pending"],
            "p1": aime_out["severity"].get("P1", 0),
            "p1_share": pct(aime_out["severity"].get("P1", 0), aime_out["problems"]),
            "density": aime_out["density"],
        },
    }

    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    payload = json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    tmp = out_path + ".tmp"
    with open(tmp, "wb") as fh:
        fh.write(payload)
    os.replace(tmp, out_path)
    # Precompressed twin for the static server; browsers get ~8 KB instead of ~40 KB.
    gz_tmp = out_path + ".gz.tmp"
    with gzip.open(gz_tmp, "wb", compresslevel=6) as fh:
        fh.write(payload)
    os.replace(gz_tmp, out_path + ".gz")
    return data


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    parser = argparse.ArgumentParser()
    parser.add_argument("--counts", default=os.path.join(here, "cache", "datasets.json"))
    parser.add_argument("--out", default=os.path.join(here, "static", "data.json"))
    args = parser.parse_args()
    data = build(args.counts, args.out)
    print(json.dumps({
        "generated_at": data["generated_at"],
        "wencai_input": data["wencai"]["input"]["total"],
        "wencai_evaluated": data["wencai"]["input"]["evaluated"],
        "wencai_pending": data["wencai"]["input"]["pending"],
        "wencai_problems": data["wencai"]["output"]["problems"],
        "aime_input": data["aime"]["input"]["total"],
        "aime_evaluated": data["aime"]["input"]["evaluated"],
        "aime_pending": data["aime"]["input"]["pending"],
        "aime_problems": data["aime"]["output"]["problems"],
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
