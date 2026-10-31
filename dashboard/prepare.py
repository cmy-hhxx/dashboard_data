#!/usr/bin/env python3
"""Build data.json for the eval dashboard from the curated datasets tree.

Source: /mnt/fin_bench/code_and_clean_data/datasets
  <product>/eval_input/<split>/<model>/<model>-<date>_input.jsonl
  <product>/eval_output/<split>/<model>/<model>-<date>_output.jsonl
  <product>/eval_output/<split>/comparison/<pair>/<pair>-<date>_output.jsonl

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

DATASETS = "/mnt/fin_bench/code_and_clean_data/datasets"
TZ = timezone(timedelta(hours=8), "CST")

WENCAI_MODELS = ["a_expert", "a_fast", "b_expert", "b_fast"]
AIME_GROUPS = [("daily", "1_aime/eval_output/0_daily_eval_output"), ("lost", "1_aime/eval_output/1_lost_user_eval_output")]
AIME_SEVERITIES = ["P0", "P1", "P2", "P3", "未分级"]

CLUSTER_FILES = {
    "wencai": f"{DATASETS}/0_wencai/eval_output/0_daily_eval_output/a_fast/cluster/cluster_tree.json",
    "aime": f"{DATASETS}/1_aime/eval_output/0_daily_eval_output/aime_fast/cluster/cluster_tree.json",
}


def now_iso():
    return datetime.now(TZ).isoformat(timespec="seconds")


def pct(a, b):
    return round(100.0 * a / b, 1) if b else 0.0


def median(vals):
    return statistics.median(vals) if vals else None


# ----------------------------------------------------------------- wencai out

def wencai_outputs():
    versions = {}
    components = collections.Counter()  # (version, component)
    for model in WENCAI_MODELS:
        answers = 0
        ok = 0
        tokens = 0
        problems = 0
        latency = []
        difficulty = collections.Counter()
        for path in sorted(glob.glob(f"{DATASETS}/0_wencai/eval_output/0_daily_eval_output/{model}/*_output.jsonl")):
            with open(path) as fh:
                for line in fh:
                    try:
                        rec = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    meta = rec.get("session_meta") or {}
                    answers += 1
                    ok += 1 if meta.get("ok") else 0
                    tokens += (meta.get("usage") or {}).get("total_tokens") or 0
                    cost = meta.get("finish_answer_time_cost")
                    if cost:
                        latency.append(cost / 1000.0)
                    difficulty[meta.get("difficulty") or "未标注"] += 1
                    for p in rec.get("session_problem") or []:
                        problems += 1
                        components[(model, p.get("component") or "未标注")] += 1
                    for turn in rec.get("turns") or []:
                        for p in turn.get("problem") or []:
                            problems += 1
                            components[(model, p.get("component") or "未标注")] += 1
        versions[model] = {
            "answers": answers,
            "ok": ok,
            "tokens": tokens,
            "problems": problems,
            "density": round(problems / answers, 2) if answers else 0,
            "p50": round(median(latency) or 0, 1),
            "difficulty": dict(difficulty),
        }
    return versions, components


def wencai_comparison():
    pairs = {}
    meets = collections.defaultdict(lambda: {"decided": 0, "meets": 0})
    for pair in ["a_fast_vs_b_fast", "a_expert_vs_b_expert"]:
        a, b = pair.split("_vs_")
        agg = {"n": 0, "a_win": 0, "b_win": 0, "both_good": 0, "both_bad": 0}
        for path in sorted(glob.glob(f"{DATASETS}/0_wencai/eval_output/0_daily_eval_output/comparison/{pair}/*_output.jsonl")):
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
    per_day = collections.defaultdict(lambda: collections.Counter())
    answers = 0
    tokens = 0
    durations = []
    tasks = collections.Counter()
    subtasks = collections.Counter()
    task_subtasks = collections.defaultdict(collections.Counter)

    for group, rel in AIME_GROUPS:
        for path in sorted(glob.glob(f"{DATASETS}/{rel}/*/*_output.jsonl")):
            base = os.path.basename(path)
            model = base.split("-")[0].replace("aime_", "")
            date = re.search(r"(\d{4}-\d{2}-\d{2})", base).group(1)
            with open(path) as fh:
                for line in fh:
                    try:
                        rec = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    answers += 1
                    per_day[date][model] += 1
                    last_turn_meta = None
                    for turn in rec.get("turns") or []:
                        meta = turn.get("meta") or {}
                        last_turn_meta = meta
                        tokens += meta.get("total_tokens") or 0
                        if meta.get("total_duration_ms"):
                            durations.append(meta["total_duration_ms"] / 1000.0)
                        for p in turn.get("problem") or []:
                            sev = p.get("severity") or "未分级"
                            comp = p.get("component") or "未标注"
                            severity[sev] += 1
                            components[(model, comp)] += 1
                            sev_by_comp[(comp, sev)] += 1
                    for p in rec.get("session_problem") or []:
                        sev = p.get("severity") or "未分级"
                        comp = p.get("component") or "未标注"
                        severity[sev] += 1
                        components[(model, comp)] += 1
                        sev_by_comp[(comp, sev)] += 1

                    last_meta = last_turn_meta or rec.get("session_meta") or {}
                    task = last_meta.get("task") or "未标注"
                    subtask = last_meta.get("subtask") or "未标注"
                    tasks[task] += 1
                    subtasks[subtask] += 1
                    task_subtasks[task][subtask] += 1

    totals = collections.Counter()
    for d in per_day.values():
        totals.update(d)
    return {
        "answers": answers,
        "tokens": tokens,
        "per_day": [{"date": d, **dict(v)} for d, v in sorted(per_day.items())],
        "by_model": dict(totals),
        "severity": {s: severity.get(s, 0) for s in AIME_SEVERITIES},
        "problems": sum(severity.values()),
        "components": build_aime_components(components, sev_by_comp),
        "tasks": dict(tasks),
        "subtasks": dict(subtasks),
        "task_subtask": {task: dict(subs) for task, subs in task_subtasks.items()},
        "task_total": sum(tasks.values()),
        "p50": round(median(durations) or 0, 1),
        "density": round(sum(severity.values()) / answers, 2) if answers else 0,
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



def compact_cluster(path, top_n=6):
    """Trim a real cluster_tree.json to a 3-level demo for the dashboard."""
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
        out = {"name": node.get("name") or "未命名", "value": int(sessions), "items": int(items)}
        if depth >= 3 or not kids:
            return out
        kids = sorted(
            kids,
            key=lambda x: (x.get("sessions") if x.get("sessions") is not None else x.get("count") or 0),
            reverse=True,
        )[:top_n]
        children = [trim(k, depth + 1) for k in kids]
        used = sum(c["value"] for c in children)
        rest = max(0, int(sessions) - used)
        if rest:
            children.append({"name": "其他", "value": rest, "items": 0})
        out["children"] = children
        return out

    tree = trim(root, 0)
    return {
        "meta": {
            "total_sessions": meta.get("total_sessions") or tree["value"],
            "total_items": meta.get("total_items") or tree["items"],
            "depth": meta.get("depth") or 3,
            "source": "a_fast",
        },
        "tree": tree,
    }

def build(counts_path, out_path):
    with open(counts_path) as fh:
        scan = json.load(fh)

    wc_versions, wc_components = wencai_outputs()
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
                    "comefrom": top_categories(collections.Counter(_surface_counts(ai_scan["categories"].get("comefrom", {})))),
                    "agent_mode": top_categories(collections.Counter(ai_scan["categories"].get("agent_mode", {}))),
                },
            },
            "output": aime_out,
            "cluster": compact_cluster(CLUSTER_FILES["aime"]),
        },
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
