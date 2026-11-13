#!/usr/bin/env python3
"""Hourly snapshot of dashboard statistics, indexes and rebuild caches.

The dashboard is a read-only view over the ceph dataset.  Its expensive state is
not the dataset itself but the derived indexes and caches it keeps under
``dashboard/cache`` plus the small sidecar files at the dataset root.  This
worker copies exactly those into ``--dest`` every ``--interval`` seconds and
keeps the newest ``--keep`` snapshots.

Snapshot layout (one directory per UTC hour)::

    <dest>/20261109T120000Z/
        manifest.json
        dataset/stats.json
        dataset/user_rules.json
        dataset/<product>/eval_output/cluster/...   # cluster_tree/item_index
        dashboard/cache/build.sqlite3              # sqlite backup, WAL safe
        dashboard/cache/samples.pkl
        dashboard/cache/samples-delta.pkl
        dashboard/cache/clusters-*.pkl
        dashboard/cache/tree-*.json
        dashboard/cache/inputs/
        dashboard/cache/ab-details/
        dashboard/config/releases.json
        dashboard/static/data*.json
        dashboard/static/samples-*.json
        dashboard/static/labels-*.json
        dashboard/static/trends-*.json
        dashboard/static/abtests-*.json

Files that did not change since the previous snapshot are hard-linked, so an
hourly run normally writes only the files the dashboard actually rebuilt.
``build.sqlite3`` is always snapshotted through SQLite's backup API because the
live database is in WAL mode and a raw file copy can be torn.

Usage::

    python3 backup_stats.py --once
    python3 backup_stats.py --interval 3600 --keep 12

The ``backup_stats.sh`` launcher starts it detached and writes a pid file.
"""
from __future__ import annotations

import argparse
import fcntl
import json
import logging
import os
import re
import shutil
import sqlite3
import sys
import time
from pathlib import Path

DEFAULT_DEST = Path("/mnt/aime_eval_ssd/1_aime/stats")
DEFAULT_DATASETS = Path("/mnt/aime_eval_ssd")
DEFAULT_INTERVAL = 3600
DEFAULT_KEEP = 12
SNAPSHOT_RE = re.compile(r"^\d{8}T\d{6}Z(?:-\d+)?$")
TMP_PREFIX = ".tmp-"

DATASET_FILES = ("stats.json", "user_rules.json", "releases.json")
CACHE_FILES = (
    "build.sqlite3",
    "samples.pkl",
    "samples-delta.pkl",
    "clusters-*.pkl",
    "tree-*.json",
    "cluster-signature.json",
    "stats.json",
)
CACHE_DIRS = ("inputs", "ab-details")
STATIC_FILES = (
    "data.json",
    "data-*.json",
    "samples.json",
    "samples-*.json",
    "labels-*.json",
    "trends-*.json",
    "abtests-*.json",
)
CONFIG_FILES = ("releases.json",)

log = logging.getLogger("backup_stats")


def acquire_lock(dest: Path):
    """Non-blocking whole-run lock; returns the open handle or None."""
    dest.mkdir(parents=True, exist_ok=True)
    handle = open(dest / ".lock", "w", encoding="utf-8")
    try:
        fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        handle.close()
        return None
    return handle


def latest_snapshot(dest: Path):
    snapshots = [p for p in dest.iterdir() if p.is_dir() and SNAPSHOT_RE.match(p.name)]
    return max(snapshots, key=lambda p: p.name) if snapshots else None


def cleanup_tmp(dest: Path, max_age: float = 0) -> None:
    now = time.time()
    for path in dest.iterdir():
        if not path.is_dir() or not path.name.startswith(TMP_PREFIX):
            continue
        try:
            age = now - path.stat().st_mtime
        except OSError:
            continue
        if age >= max_age:
            shutil.rmtree(path, ignore_errors=True)
            log.info("removed stale temporary snapshot %s", path)


def collect_sources(datasets: Path, dashboard: Path) -> list[tuple[Path, Path]]:
    """Return (path relative to snapshot, source path) for everything we keep."""
    found: dict[Path, Path] = {}

    def add(rel: Path, src: Path) -> None:
        if src.is_file() and not src.is_symlink():
            found[Path(rel)] = src

    for name in DATASET_FILES:
        add(Path("dataset") / name, datasets / name)

    # Cluster indexes: AIME keeps them directly under eval_output/cluster,
    # wencai nests them under eval_output/<split>/cluster.
    seen: set[Path] = set()
    for pattern in ("*/eval_output/cluster", "*/eval_output/*/cluster"):
        for root in sorted(datasets.glob(pattern)):
            if not root.is_dir() or root in seen:
                continue
            seen.add(root)
            for path in sorted(root.rglob("*")):
                add(Path("dataset") / path.relative_to(datasets), path)

    cache = Path(os.environ.get("EVAL_CACHE_DIR") or dashboard / "cache")
    for name in CACHE_FILES:
        for path in sorted(cache.glob(name)):
            add(Path("dashboard/cache") / path.name, path)
    for name in CACHE_DIRS:
        root = cache / name
        if not root.is_dir():
            continue
        for path in sorted(root.rglob("*")):
            add(Path("dashboard/cache") / path.relative_to(cache), path)

    for name in CONFIG_FILES:
        add(Path("dashboard/config") / name, dashboard / "config" / name)

    static = dashboard / "static"
    for name in STATIC_FILES:
        for path in sorted(static.glob(name)):
            add(Path("dashboard/static") / path.name, path)

    return sorted(found.items())


def backup_sqlite(src: Path, dst: Path) -> None:
    """Consistent copy of a live WAL database (dashboard may be writing)."""
    dst.parent.mkdir(parents=True, exist_ok=True)
    tmp = dst.with_name(dst.name + ".tmp")
    tmp.unlink(missing_ok=True)
    source = sqlite3.connect(str(src), timeout=30)
    try:
        source.execute("PRAGMA busy_timeout=30000")
        target = sqlite3.connect(str(tmp))
        try:
            source.backup(target)
            target.commit()
        finally:
            target.close()
    finally:
        source.close()
    os.replace(tmp, dst)


def copy_one(src: Path, dst: Path, rel: Path, previous) -> str:
    """Hard-link an unchanged file from the previous snapshot, else copy it."""
    dst.parent.mkdir(parents=True, exist_ok=True)
    if src.name == "build.sqlite3":
        backup_sqlite(src, dst)
        return "sqlite"

    stat = src.stat()
    if previous is not None:
        prior = previous / rel
        try:
            prior_stat = prior.stat()
            if prior_stat.st_size == stat.st_size and prior_stat.st_mtime_ns == stat.st_mtime_ns:
                try:
                    os.link(prior, dst)
                    return "link"
                except OSError:
                    pass
        except OSError:
            pass

    tmp = dst.with_name(dst.name + ".tmp")
    for attempt in range(3):
        try:
            shutil.copy2(src, tmp)
            os.replace(tmp, dst)
            return "copy"
        except OSError:
            tmp.unlink(missing_ok=True)
            if attempt == 2:
                raise
            time.sleep(2)
    return "copy"


def prune(dest: Path, keep: int) -> None:
    snapshots = sorted(
        (p for p in dest.iterdir() if p.is_dir() and SNAPSHOT_RE.match(p.name)),
        key=lambda p: p.name,
    )
    for path in snapshots[:-keep]:
        shutil.rmtree(path)
        log.info("pruned old snapshot %s", path.name)


def make_snapshot(datasets: Path, dashboard: Path, dest: Path, keep: int) -> bool:
    started = time.time()
    if not datasets.is_dir():
        log.error("dataset root is missing: %s", datasets)
        return False
    if not dest.parent.parent.is_dir():
        log.error("backup mount is missing: %s", dest.parent.parent)
        return False
    if not dashboard.is_dir():
        log.error("dashboard directory is missing: %s", dashboard)
        return False

    lock = acquire_lock(dest)
    if lock is None:
        log.warning("another backup is still running; skipping this hour")
        return False
    try:
        cleanup_tmp(dest)
        stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
        final = dest / stamp
        if final.exists():
            final = dest / f"{stamp}-{os.getpid()}"
        tmp = dest / f"{TMP_PREFIX}{stamp}-{os.getpid()}"
        if tmp.exists():
            shutil.rmtree(tmp)
        tmp.mkdir(parents=True)

        previous = latest_snapshot(dest)
        sources = collect_sources(datasets, dashboard)
        rows = []
        for rel, src in sources:
            dst = tmp / rel
            action = copy_one(src, dst, rel, previous)
            stat = dst.stat()
            rows.append({
                "path": rel.as_posix(),
                "size": stat.st_size,
                "mtime_ns": stat.st_mtime_ns,
                "action": action,
            })

        manifest = {
            "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "datasets": str(datasets),
            "dashboard": str(dashboard),
            "snapshot": final.name,
            "elapsed_seconds": round(time.time() - started, 1),
            "total_bytes": sum(row["size"] for row in rows),
            "files": rows,
        }
        tmp.joinpath("manifest.json").write_text(
            json.dumps(manifest, ensure_ascii=False, indent=1), encoding="utf-8"
        )
        os.replace(tmp, final)
        try:
            prune(dest, keep)
        except OSError:
            log.exception("snapshot %s kept, but pruning old snapshots failed", final.name)
        log.info(
            "snapshot %s: %d files, %.2f GiB, %.1fs",
            final.name, len(rows), manifest["total_bytes"] / 1024 ** 3,
            manifest["elapsed_seconds"],
        )
        return True
    except Exception:
        log.exception("snapshot failed")
        try:
            shutil.rmtree(tmp)
        except (OSError, UnboundLocalError):
            pass
        return False
    finally:
        lock.close()


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description="Back up dashboard stats/index caches.")
    parser.add_argument("--datasets", type=Path,
                        default=Path(os.environ.get("EVAL_DATASETS") or DEFAULT_DATASETS))
    parser.add_argument("--dashboard", type=Path, default=Path(__file__).resolve().parent)
    parser.add_argument("--dest", type=Path,
                        default=Path(os.environ.get("BACKUP_STATS_DEST") or DEFAULT_DEST))
    parser.add_argument("--interval", type=int,
                        default=int(os.environ.get("BACKUP_STATS_INTERVAL") or DEFAULT_INTERVAL))
    parser.add_argument("--keep", type=int,
                        default=int(os.environ.get("BACKUP_STATS_KEEP") or DEFAULT_KEEP))
    parser.add_argument("--once", action="store_true", help="take one snapshot and exit")
    args = parser.parse_args(argv)
    if args.keep < 1:
        parser.error("--keep must be at least 1")
    if args.interval < 60:
        parser.error("--interval must be at least 60 seconds")
    return args


def main(argv=None) -> int:
    args = parse_args(argv)
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        stream=sys.stdout,
    )
    log.info("backup %s -> %s every %ss, keep %s",
             args.datasets, args.dest, args.interval, args.keep)
    # A deploy restarts this worker.  Taking a 2.3 GiB snapshot on every restart
    # produced a burst of ceph writes after each release; reuse the latest
    # snapshot and wait out the remainder of the hour instead.
    if not args.once:
        dest = args.dest.expanduser()
        latest = latest_snapshot(dest) if dest.is_dir() else None
        if latest is not None:
            try:
                age = max(0.0, time.time() - latest.stat().st_mtime)
            except OSError:
                age = 0.0
            wait = args.interval - age
            if wait > 60:
                log.info("latest snapshot %s is %.0fs old; waiting %.0fs",
                         latest.name, age, wait)
                time.sleep(wait)
    while True:
        started = time.time()
        ok = make_snapshot(args.datasets.expanduser(), args.dashboard, args.dest, args.keep)
        if args.once:
            return 0 if ok else 1
        delay = args.interval - (time.time() - started)
        if delay < 60:
            delay = 60
        time.sleep(delay)


if __name__ == "__main__":
    raise SystemExit(main())
