#!/usr/bin/env python3
"""Scan /mnt/fin_bench/code_and_clean_data/datasets (the curated eval dataset).

Emits cache/datasets.json with per-file volume, per model/date input-output
pairs and the meta categories used for the distribution panel. AIME accepts
both the legacy *_input.jsonl / *_output.jsonl names and the current
<date>.jsonl inputs plus *_attribution-YYYY-MM-DD.jsonl outputs; compact files
are summaries and are intentionally excluded from coverage counts.
"""
import argparse
import collections
import concurrent.futures
import glob
import json
import os
import re
import time
from datetime import datetime, timedelta, timezone

DATASETS = "/mnt/fin_bench/code_and_clean_data/datasets"
NAME_RE = re.compile(r"(?P<model>.+?)-(?P<date>\d{4}-\d{2}-\d{2})_(?P<kind>input|output)\.jsonl$")
ATTRIBUTION_RE = re.compile(r"(?P<model>.+?)_attribution-(?P<date>\d{4}-\d{2}-\d{2})\.jsonl$")
DATE_INPUT_RE = re.compile(r"(?P<date>\d{4}-\d{2}-\d{2})\.jsonl$")


def locate(data_dir):
    """product, split, model, date, kind, path"""
    rows = []
    for path in glob.glob(f"{data_dir}/**/*.jsonl", recursive=True):
        if "/cluster/" in path or path.endswith("item_index.jsonl"):
            continue
        name = os.path.basename(path)
        m = NAME_RE.search(name)
        if m:
            model = m.group("model")
            date = m.group("date")
            kind = m.group("kind")
        else:
            m = ATTRIBUTION_RE.search(name)
            if m:
                model = m.group("model")
                date = m.group("date")
                kind = "output"
            else:
                m = DATE_INPUT_RE.search(name)
                if not m or "/eval_input/" not in path:
                    continue
                parts = path[len(data_dir):].strip("/").split("/")
                model = parts[3] if len(parts) > 3 else "unknown"
                date = m.group("date")
                kind = "input"
        parts = path[len(data_dir):].strip("/").split("/")
        product = parts[0]  # 0_wencai / 1_aime
        raw = parts[2]
        if raw == "comparison":
            split = "comparison"
        elif raw.startswith("0_"):
            split = "daily"
        else:
            split = "lost"
        rows.append({
            "product": product,
            "split": split,
            "model": model,
            "date": date,
            "kind": kind,
            "path": path,
        })
    return rows


def scan_input(row):
    counters = collections.Counter()
    lines = 0
    size = 0
    with open(row["path"]) as fh:
        for line in fh:
            lines += 1
            size += len(line)
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            meta = rec.get("meta") or {}
            if row["product"].startswith("0_wencai"):
                task = meta.get("task") or "未标注"
                subtask = meta.get("subtask") or "未标注"
                counters[("task", task)] += 1
                counters[("subtask", subtask)] += 1
                counters[("task_subtask", f"{task}\x1f{subtask}")] += 1
                counters[("difficulty", meta.get("difficulty") or "未标注")] += 1
            else:
                counters[("comefrom", meta.get("comefrom") or "未标注")] += 1
                counters[("agent_mode", meta.get("agent_mode") or "未标注")] += 1
    return {**row, "lines": lines, "bytes": size, "cats": counters}


def count_output(row):
    lines = 0
    size = 0
    with open(row["path"], "rb") as fh:
        while True:
            chunk = fh.read(1 << 22)
            if not chunk:
                break
            lines += chunk.count(b"\n")
            size += len(chunk)
    return {**row, "lines": lines, "bytes": size, "cats": collections.Counter()}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", default=DATASETS)
    parser.add_argument("--out", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "cache", "datasets.json"))
    parser.add_argument("--workers", type=int, default=8)
    args = parser.parse_args()

    rows = locate(args.data)
    started = time.time()
    result = {
        "generated_at": datetime.now(timezone(timedelta(hours=8))).strftime("%Y-%m-%d %H:%M"),
        "wencai": {"input": {}, "output": {}},
        "aime": {"input": {}, "output": {}},
    }

    def bucket(row):
        product = "wencai" if row["product"].startswith("0_wencai") else "aime"
        return result[product][row["kind"]]

    inputs = [r for r in rows if r["kind"] == "input"]
    outputs = [r for r in rows if r["kind"] == "output"]

    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
        for row in pool.map(scan_input, inputs):
            b = bucket(row)
            entry = b.setdefault(row["split"], {"total": 0, "bytes": 0, "files": 0, "models": {}, "per_day": {}, "task": {}, "subtask": {}, "task_subtask": {}, "difficulty": {}, "comefrom": {}, "agent_mode": {}})
            entry["total"] += row["lines"]
            entry["bytes"] += row["bytes"]
            entry["files"] += 1
            model = entry["models"].setdefault(row["model"], {"total": 0, "per_day": {}})
            model["total"] += row["lines"]
            model["per_day"][row["date"]] = model["per_day"].get(row["date"], 0) + row["lines"]
            entry["per_day"][row["date"]] = entry["per_day"].get(row["date"], 0) + row["lines"]
            for (cat, value), n in row["cats"].items():
                if cat not in entry:
                    continue
                if cat == "task_subtask":
                    task, subtask = value.split("\x1f", 1)
                    task_map = entry[cat].setdefault(task, {})
                    task_map[subtask] = task_map.get(subtask, 0) + n
                else:
                    entry[cat][value] = entry[cat].get(value, 0) + n

    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
        for row in pool.map(count_output, outputs):
            b = bucket(row)
            entry = b.setdefault(row["split"], {"total": 0, "bytes": 0, "files": 0, "models": {}, "per_day": {}})
            entry["total"] += row["lines"]
            entry["bytes"] += row["bytes"]
            entry["files"] += 1
            model = entry["models"].setdefault(row["model"], {"total": 0, "per_day": {}})
            model["total"] += row["lines"]
            model["per_day"][row["date"]] = model["per_day"].get(row["date"], 0) + row["lines"]
            entry["per_day"][row["date"]] = entry["per_day"].get(row["date"], 0) + row["lines"]

    # roll-up + pending per model/date
    for product in ("wencai", "aime"):
        p = result[product]
        p["total"] = {"input": sum(v["total"] for v in p["input"].values()), "output": sum(v["total"] for v in p["output"].values())}
        p["bytes"] = {"input": sum(v["bytes"] for v in p["input"].values()), "output": sum(v["bytes"] for v in p["output"].values())}
        p["files"] = {"input": sum(v["files"] for v in p["input"].values()), "output": sum(v["files"] for v in p["output"].values())}
        cats = collections.defaultdict(collections.Counter)
        task_subtasks = collections.defaultdict(collections.Counter)
        for split, meta in p["input"].items():
            for cat in ("task", "subtask", "difficulty", "comefrom", "agent_mode"):
                for k, n in meta.get(cat, {}).items():
                    cats[cat][k] += n
            for task, subs in (meta.get("task_subtask") or {}).items():
                for subtask, n in subs.items():
                    task_subtasks[task][subtask] += n
        p["categories"] = {cat: dict(sorted(c.items(), key=lambda kv: -kv[1])) for cat, c in cats.items()}
        p["categories"]["task_subtask"] = {
            task: dict(sorted(subs.items(), key=lambda kv: -kv[1]))
            for task, subs in task_subtasks.items()
        }

        pending = 0
        pairs = []
        for split in p["input"]:
            if split == "comparison":
                continue
            for model, meta in p["input"][split].get("models", {}).items():
                out_meta = p["output"].get(split, {}).get("models", {}).get(model, {})
                for date, n_in in meta.get("per_day", {}).items():
                    n_out = out_meta.get("per_day", {}).get(date, 0)
                    gap = max(0, n_in - n_out)
                    pending += gap
                    pairs.append({"split": split, "model": model, "date": date, "input": n_in, "output": n_out, "pending": gap})
        p["pending"] = pending
        p["pairs"] = sorted(pairs, key=lambda r: (r["split"], r["date"], r["model"]))

    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    tmp = args.out + ".tmp"
    with open(tmp, "w") as fh:
        json.dump(result, fh, ensure_ascii=False, indent=1)
    os.replace(tmp, args.out)
    print(f"DONE {len(rows)} files in {time.time() - started:.0f}s -> {args.out}", flush=True)
    for product in ("wencai", "aime"):
        p = result[product]
        print(product, "input", p["total"]["input"], "output", p["total"]["output"], "pending", p["pending"])
        for cat, c in p["categories"].items():
            print("  ", cat, list(c.items())[:6])


if __name__ == "__main__":
    main()
