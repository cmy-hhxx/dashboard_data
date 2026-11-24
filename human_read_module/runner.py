"""Incremental human-readable translation backfill runner & daemon.

Walks AIME ``0_daily_eval`` newest-date-first (and optionally ``ab_test/`` rounds),
translates ``attribution`` and ``compact`` records with paired ``eval_input`` context,
and writes append-only mirrored JSONL + SQLite WAL index under:
    /mnt/aime_eval_ssd/1_aime/eval_output/human_read/

Original files under ``eval_output/0_daily_eval`` and ``ab_test/`` are NEVER modified.
"""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import fcntl
import json
import os
import re
import signal
import sys
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .config import GatewayConfig, PROMPT_VERSION
from .gateway import GatewayClient
from .input_index import InputOffsetIndex, daily_input_window
from .runtime_config import init_runtime_config, reload_if_changed
from .store import HumanReadStore, record_key_for_record, text_fingerprint_for_record
from .translator import translate_attribution, translate_compact

DATE_RE = re.compile(r"-(\d{4}-\d{2}-\d{2})\.jsonl$")
DEFAULT_DATA_ROOT = Path(os.environ.get("HUMAN_READ_DATA_ROOT", "/mnt/aime_eval_ssd/1_aime"))

_STOP_EVENT = threading.Event()


def _install_signals():
    def _handle(signum, _frame):
        print(f"[human_read] Received signal {signum}, finishing in-flight tasks...", flush=True)
        _STOP_EVENT.set()

    signal.signal(signal.SIGINT, _handle)
    signal.signal(signal.SIGTERM, _handle)


@dataclass
class SourceTask:
    src_path: Path
    rel_path: str          # path under human_read/
    kind: str              # "attribution" | "compact"
    scope: str             # "daily" | "ab_test"
    model: str
    date_or_round: str     # YYYY-MM-DD or round_id
    input_files: list[Path]


def discover_daily_tasks(
    data_root: Path,
    models: list[str] | None = None,
    dates: set[str] | None = None,
    kinds: set[str] | None = None,
) -> list[SourceTask]:
    """Discover daily attribution & compact files sorted by date DESC (newest first)."""
    daily_root = data_root / "eval_output" / "0_daily_eval"
    input_root = data_root / "eval_input"
    if not daily_root.is_dir():
        return []

    target_models = models or ["aime_expert", "aime_fast"]
    target_kinds = kinds or {"attribution", "compact"}

    by_date: dict[str, list[SourceTask]] = {}
    for model in target_models:
        mdir = daily_root / model
        if not mdir.is_dir():
            continue
        if "attribution" in target_kinds:
            for p in mdir.glob(f"{model}_attribution-*.jsonl"):
                m = DATE_RE.search(p.name)
                if not m:
                    continue
                dstr = m.group(1)
                if dates and dstr not in dates:
                    continue
                rel = f"0_daily_eval/{model}/{p.name}"
                by_date.setdefault(dstr, []).append(
                    SourceTask(
                        src_path=p, rel_path=rel, kind="attribution", scope="daily",
                        model=model, date_or_round=dstr,
                        input_files=daily_input_window(input_root, model, dstr),
                    )
                )
        if "compact" in target_kinds:
            cdir = mdir / "compact"
            if cdir.is_dir():
                for p in cdir.glob(f"{model}_compact-*.jsonl"):
                    m = DATE_RE.search(p.name)
                    if not m:
                        continue
                    dstr = m.group(1)
                    if dates and dstr not in dates:
                        continue
                    rel = f"0_daily_eval/{model}/compact/{p.name}"
                    by_date.setdefault(dstr, []).append(
                        SourceTask(
                            src_path=p, rel_path=rel, kind="compact", scope="daily",
                            model=model, date_or_round=dstr,
                            input_files=daily_input_window(input_root, model, dstr),
                        )
                    )

    # Order: newest date first; within each date: attribution before compact, expert before fast
    tasks: list[SourceTask] = []
    for dstr in sorted(by_date.keys(), reverse=True):
        day_tasks = by_date[dstr]
        day_tasks.sort(key=lambda t: (0 if t.kind == "attribution" else 1, 0 if "expert" in t.model else 1, t.rel_path))
        tasks.extend(day_tasks)
    return tasks


def discover_ab_tasks(
    data_root: Path,
    kinds: set[str] | None = None,
) -> list[SourceTask]:
    """Discover ab_test attribution & compact files (newest round first)."""
    ab_root = data_root / "ab_test"
    if not ab_root.is_dir():
        return []
    target_kinds = kinds or {"attribution", "compact"}
    rounds = sorted(
        (d for d in ab_root.iterdir() if d.is_dir() and not d.name.startswith(".")),
        key=lambda d: d.name,
        reverse=True,
    )
    tasks: list[SourceTask] = []
    for rdir in rounds:
        after_inputs: list[Path] = []
        for sub in ("99_provenance/retest_input", "03_after_release_retest/inputs"):
            idir = rdir / sub
            if idir.is_dir():
                after_inputs.extend(sorted(p for p in idir.glob("*.jsonl") if p.is_file()))

        if "attribution" in target_kinds:
            attr_dir = rdir / "03_after_release_retest" / "attribution"
            if attr_dir.is_dir():
                for p in sorted(attr_dir.rglob("*.jsonl")):
                    if p.is_file():
                        rel = f"ab_test/{rdir.name}/{p.relative_to(rdir).as_posix()}"
                        tasks.append(
                            SourceTask(
                                src_path=p, rel_path=rel, kind="attribution", scope="ab_test",
                                model="ab", date_or_round=rdir.name, input_files=after_inputs,
                            )
                        )
        if "compact" in target_kinds:
            comp_dir = rdir / "99_provenance" / "retest_eval_run" / "compact"
            if comp_dir.is_dir():
                for p in sorted(comp_dir.glob("*.jsonl")):
                    if p.is_file():
                        rel = f"ab_test/{rdir.name}/{p.relative_to(rdir).as_posix()}"
                        tasks.append(
                            SourceTask(
                                src_path=p, rel_path=rel, kind="compact", scope="ab_test",
                                model="ab", date_or_round=rdir.name, input_files=after_inputs,
                            )
                        )
    return tasks


def process_file(
    task: SourceTask,
    store: HumanReadStore,
    cfg: GatewayConfig,
    *,
    workers: int = 8,
    retry_failed: bool = False,
    limit_remaining: list[int] | None = None,
) -> dict[str, int]:
    """Incrementally translate all untranslated lines in one source JSONL file."""
    counts = {"total": 0, "skipped_done": 0, "aliased": 0, "ok": 0, "failed": 0}
    if not task.src_path.is_file() or _STOP_EVENT.is_set():
        return counts

    existing = store.existing_status(task.rel_path, PROMPT_VERSION)
    ok_hashes = store.existing_ok_hashes(task.rel_path, PROMPT_VERSION)

    pending: list[tuple[int, str, str, dict[str, Any]]] = []
    with open(task.src_path, "rb") as fh:
        for line_no, raw in enumerate(fh, 1):
            if not raw.endswith(b"\n"):
                break  # Skip incomplete trailing line currently being written upstream
            raw_s = raw.strip()
            if not raw_s:
                continue
            try:
                rec = json.loads(raw_s)
            except ValueError:
                continue
            if not isinstance(rec, dict):
                continue
            counts["total"] += 1
            rkey = record_key_for_record(rec, task.kind)
            shash = text_fingerprint_for_record(rec, task.kind)

            prev = existing.get(rkey)
            if prev:
                prev_hash, prev_ver, prev_st = prev
                if prev_st == "ok" and prev_hash == shash and prev_ver == PROMPT_VERSION:
                    counts["skipped_done"] += 1
                    continue
                if prev_st == "failed" and prev_hash == shash and prev_ver == PROMPT_VERSION and not retry_failed:
                    counts["skipped_done"] += 1
                    continue

            # If exact same text fingerprint was already translated under another key (e.g. meta backfill), alias at 0 cost
            if shash in ok_hashes:
                off, sz, m = ok_hashes[shash]
                store.alias_ok(task.rel_path, rkey, task.kind, shash, PROMPT_VERSION, m, off, sz)
                counts["aliased"] += 1
                continue

            if limit_remaining is not None:
                if limit_remaining[0] <= 0:
                    break
                limit_remaining[0] -= 1
            pending.append((line_no, rkey, shash, rec))

    if not pending or _STOP_EVENT.is_set():
        return counts

    print(
        f"[human_read] {task.rel_path}: total={counts['total']} done={counts['skipped_done']} "
        f"aliased={counts['aliased']} todo={len(pending)} (inputs={len(task.input_files)})",
        flush=True,
    )
    input_idx = InputOffsetIndex(task.input_files) if task.input_files else None
    t0 = time.monotonic()

    def _work(item: tuple[int, str, str, dict[str, Any]]) -> tuple[str, str]:
        if _STOP_EVENT.is_set():
            return "stopped", ""
        _line_no, rkey, shash, rec = item
        client = GatewayClient(cfg)
        inp = input_idx.find_for_record(rec) if input_idx else None
        try:
            if task.kind == "attribution":
                tr, _st = translate_attribution(rec, inp, client, cfg)
            else:
                tr, _st = translate_compact(rec, inp, client, cfg)
            store.save_ok(task.rel_path, rkey, task.kind, shash, PROMPT_VERSION, cfg.model, tr)
            return "ok", ""
        except Exception as exc:
            err = str(exc)
            is_transient = any(
                k in err for k in ("HTTP 429", "HTTP 500", "HTTP 502", "HTTP 503", "HTTP 504", "timed out", "Timeout")
            )
            store.save_failed(
                task.rel_path, rkey, task.kind, shash, PROMPT_VERSION, cfg.model, err, transient=is_transient
            )
            return "failed", err

    with ThreadPoolExecutor(max_workers=max(1, workers)) as pool:
        futs = [pool.submit(_work, item) for item in pending]
        done_n = 0
        for fut in as_completed(futs):
            st, err = fut.result()
            if st == "ok":
                counts["ok"] += 1
            elif st == "failed":
                counts["failed"] += 1
                if counts["failed"] <= 5:
                    print(f"  [WARN] {task.rel_path} failed: {err[:180]}", file=sys.stderr, flush=True)
            done_n += 1
            if done_n % 25 == 0 or done_n == len(pending):
                elapsed = max(0.1, time.monotonic() - t0)
                rate = done_n / elapsed * 60.0
                print(
                    f"  [progress] {task.rel_path}: {done_n}/{len(pending)} "
                    f"ok={counts['ok']} fail={counts['failed']} ({rate:.1f}/min)",
                    flush=True,
                )
    return counts


def run_cycle(
    data_root: Path,
    human_read_root: Path,
    cfg: GatewayConfig,
    *,
    models: list[str] | None = None,
    dates: set[str] | None = None,
    kinds: set[str] | None = None,
    include_ab: bool = True,
    ab_only: bool = False,
    workers: int = 8,
    retry_failed: bool = False,
    limit: int | None = None,
) -> dict[str, int]:
    store = HumanReadStore(human_read_root, readonly=False)
    totals = {"files": 0, "ok": 0, "failed": 0, "skipped_done": 0, "aliased": 0}
    limit_rem = [limit] if limit is not None else None
    try:
        tasks: list[SourceTask] = []
        if not ab_only:
            tasks.extend(discover_daily_tasks(data_root, models=models, dates=dates, kinds=kinds))
        if include_ab or ab_only:
            tasks.extend(discover_ab_tasks(data_root, kinds=kinds))

        print(
            f"[human_read] Cycle start: {len(tasks)} files discovered (prompt={PROMPT_VERSION}, "
            f"model={cfg.model}, workers={workers}, limit={limit})",
            flush=True,
        )
        for task in tasks:
            if _STOP_EVENT.is_set():
                break
            if limit_rem is not None and limit_rem[0] <= 0:
                break
            rt_cfg = reload_if_changed(force=True)
            eff_workers = int(rt_cfg.get("workers") or workers)
            cfg.target_rpm = int(rt_cfg.get("target_rpm") or cfg.target_rpm)
            c = process_file(
                task, store, cfg,
                workers=eff_workers, retry_failed=retry_failed, limit_remaining=limit_rem,
            )
            totals["files"] += 1
            totals["ok"] += c["ok"]
            totals["failed"] += c["failed"]
            totals["skipped_done"] += c["skipped_done"]
            totals["aliased"] += c["aliased"]
        print(
            f"[human_read] Cycle end: files={totals['files']} ok={totals['ok']} "
            f"failed={totals['failed']} skipped={totals['skipped_done']} aliased={totals['aliased']}",
            flush=True,
        )
    finally:
        store.close()
    return totals


def main():
    ap = argparse.ArgumentParser(description="Incremental human_read translator for AIME eval outputs")
    ap.add_argument("--data-root", default=str(DEFAULT_DATA_ROOT), help="Path to /mnt/aime_eval_ssd/1_aime")
    ap.add_argument("--out-root", default=None, help="Defaults to <data-root>/eval_output/human_read")
    ap.add_argument("--models", default="aime_expert,aime_fast", help="Comma-separated models")
    ap.add_argument("--dates", default=None, help="Optional comma-separated YYYY-MM-DD filter")
    ap.add_argument("--kinds", default="attribution,compact", help="attribution,compact")
    ap.add_argument("--include-ab", action="store_true", help="Also translate ab_test rounds after daily")
    ap.add_argument("--ab-only", action="store_true", help="Only translate ab_test rounds")
    ap.add_argument("--workers", type=int, default=None, help="Initial workers (overrides runtime_config only when creating it)")
    ap.add_argument("--rpm", type=int, default=None, help="Initial RPM cap (overrides runtime_config only when creating it)")
    ap.add_argument("--config", default=None, help="Path to hot-reloadable runtime_config.json")
    ap.add_argument("--limit", type=int, default=None, help="Max records to translate in one cycle")
    ap.add_argument("--retry-failed", action="store_true", help="Retry previously failed records")
    ap.add_argument("--daemon", action="store_true", help="Run continuously on an interval")
    ap.add_argument("--interval", type=int, default=600, help="Seconds between daemon cycles (default 600)")
    ap.add_argument("--status", action="store_true", help="Print current translation counts and exit")
    args = ap.parse_args()

    data_root = Path(args.data_root)
    out_root = Path(args.out_root) if args.out_root else (data_root / "eval_output" / "human_read")

    if args.status:
        store = HumanReadStore(out_root, readonly=True)
        try:
            print(json.dumps(store.stats_summary(), ensure_ascii=False, indent=2))
        finally:
            store.close()
        return

    _install_signals()
    lock_dir = out_root / ".state"
    lock_dir.mkdir(parents=True, exist_ok=True)
    lock_fh = open(lock_dir / "runner.lock", "w")
    try:
        fcntl.flock(lock_fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        print("[human_read] Another runner instance holds runner.lock; exiting.", flush=True)
        sys.exit(0)

    cfg_path = Path(args.config) if args.config else (lock_dir / "runtime_config.json")
    init_runtime_config(cfg_path, {"target_rpm": args.rpm, "workers": args.workers})
    rt_cfg = reload_if_changed(force=True)
    eff_rpm = int(args.rpm if args.rpm is not None else rt_cfg.get("target_rpm", 40))
    eff_workers = int(args.workers if args.workers is not None else rt_cfg.get("workers", 8))

    cfg = GatewayConfig(target_rpm=eff_rpm)
    models = [m.strip() for m in args.models.split(",") if m.strip()]
    dates = {d.strip() for d in args.dates.split(",") if d.strip()} if args.dates else None
    kinds = {k.strip() for k in args.kinds.split(",") if k.strip()}

    try:
        while not _STOP_EVENT.is_set():
            run_cycle(
                data_root, out_root, cfg,
                models=models, dates=dates, kinds=kinds,
                include_ab=args.include_ab, ab_only=args.ab_only,
                workers=eff_workers, retry_failed=args.retry_failed,
                limit=args.limit,
            )
            if not args.daemon:
                break
            # Sleep in 1s chunks so SIGTERM wakes immediately
            for _ in range(max(1, args.interval)):
                if _STOP_EVENT.is_set():
                    break
                time.sleep(1)
    finally:
        try:
            fcntl.flock(lock_fh.fileno(), fcntl.LOCK_UN)
            lock_fh.close()
        except Exception:
            pass


if __name__ == "__main__":
    main()
