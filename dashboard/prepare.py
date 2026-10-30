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
    return {
        "names": top,
        "A": [groups["A"][c] for c in top],
        "B": [groups["B"][c] for c in top],
        "other": sum(n for (v, c), n in raw.items() if c not in top),
    }


# -------------------------------------------------------------------- aime

def build_aime_components(raw, sev_raw, top_n=7):
    totals = collections.Counter()
    for (model, comp), n in raw.items():
        totals[comp] += n
    names = [c for c, _ in totals.most_common(top_n)]
    out = {"names": names, "fast": [], "expert": [], "severity": {}}
    for name in names:
        out["fast"].append(raw.get(("fast", name), 0))
        out["expert"].append(raw.get(("expert", name), 0))
        out["severity"][name] = {s: sev_raw.get((name, s), 0) for s in AIME_SEVERITIES}
    return out


def aime_outputs():
    severity = collections.Counter()
    components = collections.Counter()  # (model, component)
    sev_by_comp = collections.Counter()  # (component, severity)
    per_day = collections.defaultdict(lambda: collections.Counter())
    answers = 0
    tokens = 0
    durations = []

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
                    for turn in rec.get("turns") or []:
                        meta = turn.get("meta") or {}
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


def build(counts_path, out_path):
    with open(counts_path) as fh:
        scan = json.load(fh)

    wc_versions, wc_components = wencai_outputs()
    wc_pairs, wc_meets = wencai_comparison()
    aime_out = aime_outputs()

    wc_scan = scan["wencai"]
    ai_scan = scan["aime"]

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
                "pending": max(0, wc_input_total - wc_evaluated),
                "evaluated": wc_evaluated,
                "categories": {
                    "task": top_categories(collections.Counter(wc_scan["categories"].get("task", {})), 14),
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
            "run": {"status": "snapshot", "name": "datasets · 2026-10-23"},
        },
        "aime": {
            "input": {
                "total": ai_input_total,
                "bytes": ai_scan["bytes"]["input"],
                "files": ai_scan["files"]["input"],
                "pending": max(0, ai_input_total - ai_evaluated),
                "evaluated": ai_evaluated,
                "groups": ai_scan.get("input", {}),
                "categories": {
                    "comefrom": top_categories(collections.Counter(_surface_counts(ai_scan["categories"].get("comefrom", {})))),
                    "agent_mode": top_categories(collections.Counter(ai_scan["categories"].get("agent_mode", {}))),
                },
            },
            "output": aime_out,
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
    tmp = out_path + ".tmp"
    with open(tmp, "w") as fh:
        json.dump(data, fh, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, out_path)
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
