#!/usr/bin/env python3
"""Maintain ``<datasets>/stats.json`` for the dashboard build.

The dashboard needs records / traces / tool calls / tokens / task-subtask / lost
counts for every input file.  Scanning 44 GB on every cold build is the largest
remaining cost, so this small worker keeps a sidecar aggregate up to date:

    python3 stats_worker.py --datasets /path/to/datasets --interval 1800

It shares ``cache/build.sqlite3`` with ``build.py``; a file already scanned by a
build is reused without reading it again.  ``build.py`` only trusts an entry
whose ``(size, mtime_ns)`` still matches, and falls back to a local scan for
anything stale, so the sidecar is an accelerator, never a correctness dependency.
"""
from __future__ import annotations

import argparse
import json_compat as json
import os
import sys
import time
import traceback
from pathlib import Path

import build
import build_store as bs


def snapshot(datasets: Path, store: bs.BuildStore, jobs: int = 0):
    started = time.time()
    products, scan, total = {}, {}, {}
    for top in sorted(p for p in datasets.glob("*") if p.is_dir()):
        product = build.product_of(top.name)
        if not product:
            continue
        metas, info = build.scan_inputs(datasets, top, product, store, jobs)
        files = [
            {key: meta.get(key) for key in
             ("path", "size", "mtime_ns", "lines", "model", "split", "stats")}
            for meta in metas
        ]
        payload = build.input_payload(metas)
        by_split = {}
        for meta in metas:
            split = meta.get("split") or "unknown"
            bucket = by_split.setdefault(split, {"files": 0, "bytes": 0, "records": 0,
                                                 "traces": 0, "lost": 0})
            stats = meta.get("stats") or {}
            bucket["files"] += 1
            bucket["bytes"] += int(meta.get("size") or 0)
            bucket["records"] += int(stats.get("records") or 0)
            bucket["traces"] += int(stats.get("traces") or 0)
            model = meta.get("model")
            bucket["lost"] += sum(
                t.get("lost", 0)
                for t in ((stats.get("by_model") or {}).get(model, {}).get("tasks") or {}).values()
            ) if model else 0
        products[product] = {
            "files": files,
            "summary": {key: payload.get(key, 0) for key in
                        ("records", "traces", "tool_calls", "tokens_in", "tokens_out",
                         "cache_read", "lost")},
            "models": {
                model: {key: value.get(key, 0) for key in
                        ("label", "traces", "tool_calls", "tokens_in", "tokens_out", "cache_read", "lost")}
                for model, value in payload["models"].items()
            },
            "by_split": by_split,
            "files_count": len(files),
            "bytes": sum(int(meta.get("size") or 0) for meta in metas),
        }
        scan[product] = info
        for key in ("records", "traces", "tool_calls", "tokens_in", "tokens_out", "cache_read", "lost"):
            total[key] = total.get(key, 0) + int(payload.get(key) or 0)
        total["files"] = total.get("files", 0) + len(files)
        total["bytes"] = total.get("bytes", 0) + products[product]["bytes"]
    return {
        "schema": build.SIDECAR_SCHEMA,
        "generated_at": build.iso_now(),
        "datasets": str(datasets),
        "duration": round(time.time() - started, 1),
        "summary": total,
        "products": products,
        "scan": scan,
    }


def write_atomic(target: Path, data: dict) -> Path:
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_name(target.name + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    os.replace(tmp, target)
    return target


def refresh(datasets: Path, store: bs.BuildStore, out: Path | None, jobs: int = 0) -> Path:
    data = snapshot(datasets, store, jobs)
    target = out or (datasets / "stats.json")
    try:
        return write_atomic(target, data)
    except OSError as exc:
        fallback = build.DASHBOARD / "cache" / "stats.json"
        print(f"[stats] {target} not writable ({exc}); writing {fallback}", file=sys.stderr, flush=True)
        return write_atomic(fallback, data)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--datasets", type=Path, default=None)
    ap.add_argument("--store", type=Path, default=None)
    ap.add_argument("--out", type=Path, default=None,
                    help="default: <datasets>/stats.json, falling back to dashboard/cache/stats.json")
    ap.add_argument("--interval", type=int,
                    default=int(os.environ.get("STATS_REFRESH_SECONDS", "1800")))
    ap.add_argument("--jobs", type=int, default=0)
    ap.add_argument("--once", action="store_true")
    args = ap.parse_args(argv)
    datasets = (args.datasets or build.default_datasets()).resolve()
    store_path = args.store or (build.DASHBOARD / "cache" / "build.sqlite3")
    store = bs.BuildStore(store_path)
    try:
        while True:
            started = time.time()
            try:
                target = refresh(datasets, store, args.out, args.jobs)
                print(json.dumps({
                    "event": "stats", "ok": True, "path": str(target),
                    "seconds": round(time.time() - started, 1),
                    "datasets": str(datasets),
                }, ensure_ascii=False), flush=True)
            except Exception as exc:  # noqa: BLE001 - keep the old sidecar on failure
                print(f"[stats] failed: {exc}", file=sys.stderr, flush=True)
                traceback.print_exc()
            if args.once:
                break
            time.sleep(max(60, args.interval))
    finally:
        store.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
