#!/usr/bin/env python3
"""Scan eval_data and emit data.json for the dashboard.

Only reads the small, current evaluation artifacts (daily eval outputs,
comparison verdicts, production stats). Whole-directory line counts come
from a cached TSV produced by count_inputs.sh.
"""
import argparse
import collections
import glob
import json
import os
import statistics
from datetime import datetime, timedelta, timezone

DATA = "/mnt/fin_bench/eval_data"

WENCAI_OUT = f"{DATA}/0_wencai/3_eval_output/0_daily_eval"
WENCAI_STATS = f"{WENCAI_OUT}/.archive/wencai-production-20261029/stats.json"

AIME_LOST = f"{DATA}/1_aime/3_eval_output/3_lost_user_eval"
AIME_DAILY = f"{DATA}/1_aime/3_eval_output/0_daily_eval"

WENCAI_VERSIONS = ["a_expert", "a_fast", "b_expert", "b_fast"]
AIME_SEVERITIES = ["P0", "P1", "P2", "P3", "未分级"]


TZ = timezone(timedelta(hours=8), "CST")


def now_iso():
    return datetime.now(TZ).isoformat(timespec="seconds")


def read_counts(path):
    """group<TAB>date<TAB>bytes<TAB>lines<TAB>path"""
    rows = []
    if not os.path.exists(path):
        return rows
    with open(path) as fh:
        for line in fh:
            parts = line.rstrip("\n").split("\t")
            if len(parts) < 4:
                continue
            group, date, size, lines = parts[:4]
            try:
                rows.append({"group": group, "date": date, "bytes": int(size), "lines": int(lines)})
            except ValueError:
                continue
    return rows


def pct(a, b):
    return round(100.0 * a / b, 1) if b else 0.0


def median_or_none(vals):
    return statistics.median(vals) if vals else None


# ---------------------------------------------------------------- wencai input

def wencai_input(counts):
    by_version = collections.defaultdict(lambda: collections.Counter())
    days = set()
    files = 0
    total_bytes = 0
    for r in counts:
        if not r["group"].startswith("wencai_daily/"):
            continue
        version = r["group"].split("/", 1)[1]
        by_version[version][r["date"]] += r["lines"]
        days.add(r["date"])
        files += 1
        total_bytes += r["bytes"]

    days = sorted(days)
    series = {v: [by_version[v].get(d, 0) for d in days] for v in WENCAI_VERSIONS}
    daily_totals = [sum(series[v][i] for v in WENCAI_VERSIONS) for i in range(len(days))]
    total = sum(daily_totals)
    return {
        "days": days,
        "series": series,
        "total": total,
        "files": files,
        "bytes": total_bytes,
        "avg_per_day": round(total / len(days)) if days else 0,
        "peak": max(daily_totals) if daily_totals else 0,
        "peak_day": days[daily_totals.index(max(daily_totals))] if daily_totals else "",
        "span": f"{days[0]} → {days[-1]}" if days else "",
    }


# --------------------------------------------------------------- wencai output

def wencai_output():
    versions = {}
    components = collections.Counter()
    for v in WENCAI_VERSIONS:
        answers = 0
        ok = 0
        tokens = 0
        problems = 0
        latency = []
        diff = collections.Counter()
        for f in sorted(glob.glob(f"{WENCAI_OUT}/{v}/*.jsonl")):
            with open(f) as fh:
                for line in fh:
                    try:
                        rec = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    meta = rec.get("session_meta", {})
                    answers += 1
                    ok += 1 if meta.get("ok") else 0
                    tokens += (meta.get("usage") or {}).get("total_tokens") or 0
                    cost = meta.get("finish_answer_time_cost")
                    if cost:
                        latency.append(cost / 1000.0)
                    diff[meta.get("difficulty") or "未知"] += 1
                    for p in rec.get("session_problem") or []:
                        problems += 1
                        components[(v, p.get("component") or "未标注")] += 1
                    for turn in rec.get("turns") or []:
                        for p in turn.get("problem") or []:
                            problems += 1
                            components[(v, p.get("component") or "未标注")] += 1
        versions[v] = {
            "answers": answers,
            "ok": ok,
            "tokens": tokens,
            "problems": problems,
            "density": round(problems / answers, 2) if answers else 0,
            "p50": round(median_or_none(latency) or 0, 1),
            "difficulty": dict(diff),
        }

    comparisons = {}
    for pair in ["a_fast_vs_b_fast", "a_expert_vs_b_expert"]:
        a, b = pair.split("_vs_")
        agg = {"n": 0, "a_win": 0, "b_win": 0, "both_good": 0, "both_bad": 0}
        for f in sorted(glob.glob(f"{WENCAI_OUT}/comparison/{pair}/*.jsonl")):
            with open(f) as fh:
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
        comparisons[pair] = agg

    stats = {}
    if os.path.exists(WENCAI_STATS):
        with open(WENCAI_STATS) as fh:
            stats = json.load(fh)

    coverage = stats.get("coverage", {})
    quality = stats.get("quality", {})
    meets = {v: (stats.get("standings", {}).get(v, {}) or {}).get("meets_core_rate") for v in WENCAI_VERSIONS}

    return {
        "versions": versions,
        "answers": sum(v["answers"] for v in versions.values()),
        "problems": sum(v["problems"] for v in versions.values()),
        "tokens": sum(v["tokens"] for v in versions.values()),
        "comparisons": comparisons,
        "comparison_total": sum(c["n"] for c in comparisons.values()),
        "coverage": {
            "planned": coverage.get("planned", 0),
            "decided": coverage.get("decided", 0),
            "pending": coverage.get("pending", 0),
            "incomplete": coverage.get("incomplete", 0),
        },
        "quality": {
            "p50": quality.get("p50_seconds"),
            "p95": quality.get("p95_seconds"),
            "first_pass": round(100 * quality.get("first_submission_pass_rate", 0), 1),
        },
        "meets_core": {v: round(100 * meets[v], 1) if meets[v] is not None else None for v in WENCAI_VERSIONS},
        "components": components,
        "status": stats.get("status", ""),
        "run_versions": stats.get("evaluator_versions", []),
    }


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


# ----------------------------------------------------------------- aime input

def aime_input(counts):
    groups = collections.defaultdict(lambda: collections.defaultdict(int))
    dates = collections.defaultdict(set)
    files = 0
    for r in counts:
        g = r["group"]
        if not g.startswith("aime_"):
            continue
        key = g.split("/", 1)[0].replace("aime_", "")  # daily / lost / lost_archive
        model = g.split("/", 1)[1].replace("aime_", "")  # expert / fast
        groups[key][model] += r["lines"]
        dates[key].add(r["date"])
        files += 1
    return {
        "groups": {k: dict(v) for k, v in groups.items()},
        "dates": {k: sorted(v) for k, v in dates.items()},
        "total": sum(sum(v.values()) for v in groups.values()),
        "files": files,
    }


# ---------------------------------------------------------------- aime output

def build_aime_components(raw, severity_raw, top_n=7):
    totals = collections.Counter()
    for (model, comp), n in raw.items():
        totals[comp] += n
    names = [c for c, _ in totals.most_common(top_n)]
    out = {"names": names, "fast": [], "expert": [], "severity": {}}
    for name in names:
        out["fast"].append(raw.get(("fast", name), 0))
        out["expert"].append(raw.get(("expert", name), 0))
        out["severity"][name] = {s: severity_raw.get((name, s), 0) for s in AIME_SEVERITIES}
    return out


def scan_aime_output():
    per_day = []  # {date, expert, fast}
    severity = collections.Counter()
    components = collections.Counter()  # (model, component) -> count
    severity_by_component = collections.Counter()  # (component, severity) -> count
    answers = 0
    tokens = 0
    durations = []

    def scan(path, label):
        nonlocal answers, tokens
        local_answers = 0
        local_sev = collections.Counter()
        local_comp = collections.Counter()
        with open(path) as fh:
            for line in fh:
                try:
                    rec = json.loads(line)
                except json.JSONDecodeError:
                    continue
                answers += 1
                local_answers += 1
                for turn in rec.get("turns") or []:
                    meta = turn.get("meta") or {}
                    tokens += meta.get("total_tokens") or 0
                    if meta.get("total_duration_ms"):
                        durations.append(meta["total_duration_ms"] / 1000.0)
                    for p in turn.get("problem") or []:
                        sev = p.get("severity") or "未分级"
                        comp = p.get("component") or "未标注"
                        local_sev[sev] += 1
                        local_comp[(model, comp)] += 1
                        severity_by_component[(comp, sev)] += 1
                for p in rec.get("session_problem") or []:
                    sev = p.get("severity") or "未分级"
                    comp = p.get("component") or "未标注"
                    local_sev[sev] += 1
                    local_comp[(model, comp)] += 1
                    severity_by_component[(comp, sev)] += 1
        severity.update(local_sev)
        components.update(local_comp)
        return local_answers

    groups = [
        (f"{AIME_LOST}/aime_expert/*.jsonl", "expert"),
        (f"{AIME_LOST}/aime_fast/*.jsonl", "fast"),
        (f"{AIME_DAILY}/aime_fast/*.jsonl", "fast"),
    ]
    daily = collections.defaultdict(lambda: collections.Counter())
    for pattern, model in groups:
        for f in sorted(glob.glob(pattern)):
            base = os.path.basename(f)
            date = base.replace("aime_", "").replace(".jsonl", "")
            if date.startswith("expert-"):
                date = date[len("expert-"):]
            elif date.startswith("fast-"):
                date = date[len("fast-"):]
            n = scan(f, model)
            daily[date][model] += n
    per_day = [{"date": d, **dict(v)} for d, v in sorted(daily.items())]

    totals = collections.Counter()
    for d in per_day:
        for k, v in d.items():
            if k != "date":
                totals[k] += v

    return {
        "answers": answers,
        "tokens": tokens,
        "per_day": per_day,
        "by_model": dict(totals),
        "severity": {s: severity.get(s, 0) for s in AIME_SEVERITIES},
        "problems": sum(severity.values()),
        "components": build_aime_components(components, severity_by_component),
        "p50": round(median_or_none(durations) or 0, 1),
        "density": round(sum(severity.values()) / answers, 2) if answers else 0,
    }


# ------------------------------------------------------------------- assembly

def build(counts_path, out_path):
    counts = read_counts(counts_path)
    wc_in = wencai_input(counts)
    wc_out = wencai_output()
    aime_in = aime_input(counts)
    aime_out = scan_aime_output()

    wc_components = build_wencai_components(wc_out.pop("components"))

    wc_compare = wc_out["comparisons"]
    a_win = sum(c["a_win"] for c in wc_compare.values())
    b_win = sum(c["b_win"] for c in wc_compare.values())
    both_good = sum(c["both_good"] for c in wc_compare.values())
    both_bad = sum(c["both_bad"] for c in wc_compare.values())

    aime_sev = aime_out["severity"]
    p1 = aime_sev.get("P1", 0)
    aime_in_total = aime_in["total"]
    aime_out_total = aime_out["answers"]

    data = {
        "generated_at": now_iso(),
        "counts_at": datetime.fromtimestamp(os.path.getmtime(counts_path), TZ).strftime("%m-%d %H:%M") if os.path.exists(counts_path) else "—",
        "wencai": {
            "input": wc_in,
            "output": wc_out,
            "components": wc_components,
            "run": {
                "name": "wencai-production-20261029",
                "status": wc_out.pop("status"),
                "evaluators": wc_out.pop("run_versions"),
            },
        },
        "aime": {
            "input": aime_in,
            "output": aime_out,
        },
        "conclusion": {
            "wencai": {
                "coverage": pct(wc_out["coverage"]["decided"], wc_out["coverage"]["planned"]),
                "a_win": a_win,
                "b_win": b_win,
                "both_good": both_good,
                "both_bad": both_bad,
                "a_win_rate": pct(a_win, a_win + b_win),
                "b_win_rate": pct(b_win, a_win + b_win),
                "density": round(wc_out["problems"] / wc_out["answers"], 2) if wc_out["answers"] else 0,
            },
            "aime": {
                "coverage": pct(aime_out_total, aime_in_total),
                "gap": aime_in_total - aime_out_total,
                "p1": p1,
                "p1_share": pct(p1, aime_out["problems"]),
                "density": aime_out["density"],
                "p95": wc_out["quality"].get("p95"),
            },
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
    parser.add_argument("--counts", default=os.path.join(here, "cache", "input_counts.tsv"))
    parser.add_argument("--out", default=os.path.join(here, "static", "data.json"))
    args = parser.parse_args()
    data = build(args.counts, args.out)
    print(json.dumps({
        "generated_at": data["generated_at"],
        "wencai_input": data["wencai"]["input"]["total"],
        "wencai_answers": data["wencai"]["output"]["answers"],
        "wencai_comparisons": data["wencai"]["output"]["comparison_total"],
        "aime_input": data["aime"]["input"]["total"],
        "aime_answers": data["aime"]["output"]["answers"],
        "aime_problems": data["aime"]["output"]["problems"],
        "out": args.out,
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
