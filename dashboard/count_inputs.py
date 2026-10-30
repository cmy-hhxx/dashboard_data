#!/usr/bin/env python3
"""Count records in every eval-input jsonl (parallel), emit TSV cache.

Writes: group<TAB>date<TAB>bytes<TAB>lines<TAB>path
Run manually or from cron; prepare.py only reads the result.
"""
import argparse
import concurrent.futures
import glob
import os
import time

DATA = "/mnt/fin_bench/eval_data"


def targets(data_dir):
    base = os.path.join(data_dir)
    items = []

    def add(group, path):
        for f in sorted(glob.glob(os.path.join(path, "*.jsonl"))):
            items.append((group, f))

    for v in ["a_expert", "a_fast", "b_expert", "b_fast"]:
        add(f"wencai_daily/{v}", f"{base}/0_wencai/2_eval_input/0_daily_eval_input/{v}")
    add("wencai_task", f"{base}/0_wencai/2_eval_input/1_task_eval_input/0_search_eval")
    for v in ["aime_expert", "aime_fast"]:
        add(f"aime_daily/{v}", f"{base}/1_aime/2_eval_input/0_daily_eval_input/{v}")
        add(f"aime_lost/{v}", f"{base}/1_aime/2_eval_input/1_lost_user_eval/{v}")
        add(f"aime_lost_archive/{v}", f"{base}/1_aime/2_eval_input/1_lost_user_eval/.archive/{v}")
    return items


def count(item):
    group, path = item
    lines = 0
    last = b"\n"
    with open(path, "rb") as fh:
        while True:
            chunk = fh.read(1 << 23)
            if not chunk:
                break
            lines += chunk.count(b"\n")
            last = chunk[-1:]
    if last != b"\n":
        lines += 1
    return group, os.path.basename(path)[:-6], os.path.getsize(path), lines, path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", default=DATA)
    parser.add_argument("--out", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "cache", "input_counts.tsv"))
    parser.add_argument("--workers", type=int, default=8)
    args = parser.parse_args()

    items = targets(args.data)
    started = time.time()
    rows = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
        for i, row in enumerate(pool.map(count, items)):
            rows.append(row)
            if i % 20 == 0:
                print(f"{i}/{len(items)} {row[0]}/{row[1]} lines={row[3]}", flush=True)
    rows.sort()

    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    tmp = args.out + ".tmp"
    with open(tmp, "w") as fh:
        for row in rows:
            fh.write("\t".join(str(x) for x in row) + "\n")
    os.replace(tmp, args.out)
    print(f"DONE {len(rows)} files in {time.time() - started:.0f}s -> {args.out}", flush=True)


if __name__ == "__main__":
    main()
