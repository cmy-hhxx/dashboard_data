#!/usr/bin/env python3
"""Scan eval inputs (archive excluded) for volume + meta-category distribution.

Emits cache/input_meta.json:
  wencai: total / bytes / by_version / task / difficulty / agent_mode / per_day
  aime:   total / bytes / by_group / comefrom / agent_mode / source / per_day
"""
import argparse
import collections
import concurrent.futures
import glob
import json
import os
import time

DATA = "/mnt/fin_bench/eval_data"


def targets(data_dir):
    items = []
    base = f"{data_dir}/0_wencai/2_eval_input/0_daily_eval_input"
    for v in ["a_expert", "a_fast", "b_expert", "b_fast"]:
        for f in sorted(glob.glob(f"{base}/{v}/*.jsonl")):
            items.append(("wencai", v, f))
    for v in ["aime_expert", "aime_fast"]:
        for group, path in (
            ("daily", f"{data_dir}/1_aime/2_eval_input/0_daily_eval_input/{v}"),
            ("lost", f"{data_dir}/1_aime/2_eval_input/1_lost_user_eval/{v}"),
        ):
            for f in sorted(glob.glob(f"{path}/*.jsonl")):
                items.append(("aime", group, f))
    return items


def scan(item):
    product, group, path = item
    lines = 0
    size = 0
    cats = collections.Counter()
    with open(path) as fh:
        for line in fh:
            lines += 1
            size += len(line)
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            meta = rec.get("meta") or {}
            if product == "wencai":
                cats[("task", meta.get("task") or "未标注")] += 1
                cats[("difficulty", meta.get("difficulty") or "未标注")] += 1
                cats[("agent_mode", meta.get("agent_mode") or "未标注")] += 1
            else:
                cats[("comefrom", meta.get("comefrom") or "未标注")] += 1
                cats[("agent_mode", meta.get("agent_mode") or "未标注")] += 1
                cats[("source", meta.get("source") or "未标注")] += 1
    date = os.path.basename(path)[:-6]
    return {"product": product, "group": group, "date": date, "path": path, "lines": lines, "bytes": size, "cats": cats}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", default=DATA)
    parser.add_argument("--out", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "cache", "input_meta.json"))
    parser.add_argument("--workers", type=int, default=8)
    args = parser.parse_args()

    items = targets(args.data)
    started = time.time()
    result = {
        "generated_at": time.strftime("%Y-%m-%d %H:%M"),
        "wencai": {"total": 0, "bytes": 0, "files": 0, "by_version": {}, "task": {}, "difficulty": {}, "agent_mode": {}, "per_day": {}},
        "aime": {"total": 0, "bytes": 0, "files": 0, "by_group": {}, "comefrom": {}, "agent_mode": {}, "source": {}, "per_day": {}},
    }

    def bump(counter, key, n=1):
        counter[key] = counter.get(key, 0) + n

    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
        for i, row in enumerate(pool.map(scan, items)):
            bucket = result[row["product"]]
            bucket["total"] += row["lines"]
            bucket["bytes"] += row["bytes"]
            bucket["files"] += 1
            key = "by_version" if row["product"] == "wencai" else "by_group"
            bump(bucket[key], row["group"], row["lines"])
            bump(bucket["per_day"], row["date"], row["lines"])
            for (cat, value), n in row["cats"].items():
                bump(bucket[cat], value, n)
            if i % 10 == 0:
                print(f"{i}/{len(items)} {row['product']}/{row['group']}/{row['date']} {row['lines']}", flush=True)

    for product in ("wencai", "aime"):
        result[product]["per_day"] = dict(sorted(result[product]["per_day"].items()))
        for cat in ("task", "difficulty", "comefrom", "agent_mode", "source"):
            if cat in result[product]:
                result[product][cat] = dict(sorted(result[product][cat].items(), key=lambda kv: -kv[1]))

    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    tmp = args.out + ".tmp"
    with open(tmp, "w") as fh:
        json.dump(result, fh, ensure_ascii=False, indent=1)
    os.replace(tmp, args.out)
    print(f"DONE {len(items)} files in {time.time() - started:.0f}s -> {args.out}", flush=True)
    print(json.dumps({
        "wencai": result["wencai"]["total"],
        "aime": result["aime"]["total"],
        "wencai_tasks": list(result["wencai"]["task"].items())[:5],
        "aime_comefrom": list(result["aime"]["comefrom"].items())[:5],
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
