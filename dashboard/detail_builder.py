"""Lazy sample-detail generation for the dashboard server.

The build keeps only compact sample summaries; a 60 KB transcript is generated
the first time a sample is opened and then cached on disk.  This removes the
~900 MB of eager detail writes (and their gzip cost) from every cold build while
keeping the sample page instant after the first view.
"""
from __future__ import annotations

import json_compat as json
import re
import threading
import time
from collections import Counter
from pathlib import Path

import build
import build_store as bs

SLUG = re.compile(r"^[0-9a-f]{10}$")
# 详情文件单独失效：配对修正后要给旧样本补输入，但不能连带让 116k 样本缓存全量重建。
DETAIL_VERSION = "2026-11-13.1"


class DetailBuilder:
    def __init__(self, datasets: Path, store_path: Path, sample_dir: Path, cache_dir: Path):
        self.datasets = Path(datasets)
        self.store_path = Path(store_path)
        self.sample_dir = Path(sample_dir)
        self.cache_dir = Path(cache_dir)
        self.sample_dir.mkdir(parents=True, exist_ok=True)
        # 详情文件也按构建版本失效：BUILD_VERSION 变了就懒重建，不依赖聚类戳。
        self.version_file = self.sample_dir / ".build-version"
        self.version_stamp = self._sync_version()
        # A multi-trace session opens one detail per trace at the same time.  A single
        # shared SQLite connection + lock would serialise them all, so each request
        # thread keeps its own read-only connection and only the cluster index is
        # shared behind a lock.
        self._local = threading.local()
        self._cluster_lock = threading.Lock()
        self._cluster_index = None
        self._cluster_loaded = None
        # A duplicate attribution row can lose the pairing race (one input backs one
        # completion), but its transcript is still in an input file.  Fall back to the
        # trace index so opening that sample does not show "no eval input".
        self._trace_inputs = None
        self._trace_inputs_at = 0.0
        self._trace_inputs_lock = threading.Lock()
        self._slug_guard = threading.Lock()
        self._slug_locks = {}

    def _sync_version(self):
        try:
            current = self.version_file.read_text(encoding="utf-8").strip()
        except OSError:
            current = ""
        if current != DETAIL_VERSION:
            try:
                self.version_file.write_text(DETAIL_VERSION, encoding="utf-8")
            except OSError:
                pass
            return time.time()
        try:
            return self.version_file.stat().st_mtime
        except OSError:
            return 0.0

    def _open(self):
        store = getattr(self._local, "store", None)
        if store is None:
            store = bs.BuildStore(self.store_path, readonly=True)
            self._local.store = store
        return store

    def _reopen(self):
        store = getattr(self._local, "store", None)
        if store is not None:
            try:
                store.close()
            except Exception:  # noqa: BLE001 - a dead read connection is replaced below
                pass
        self._local.store = None
        return self._open()

    def _slug_lock(self, slug: str):
        with self._slug_guard:
            lock = self._slug_locks.get(slug)
            if lock is None:
                lock = threading.Lock()
                self._slug_locks[slug] = lock
            return lock

    def _input_locations(self):
        """trace_id -> (input file, byte offset); refreshed so new files are reachable."""
        with self._trace_inputs_lock:
            if self._trace_inputs is not None and time.time() - self._trace_inputs_at < 600:
                return self._trace_inputs
            try:
                self._trace_inputs = self._open().input_locations()
            except Exception as exc:  # noqa: BLE001 - fallback only; the pair ref still wins
                build.debug(f"detail trace input index: {exc}")
                self._trace_inputs = {}
            self._trace_inputs_at = time.time()
            return self._trace_inputs

    def _input_by_trace(self, attr):
        """Read the input line by attribution trace id when the pair has no ref.

        A duplicate output row can legitimately own no input (one input backs one
        completion), but the same trace's transcript is still published.  The detail
        is read-only, so reuse it instead of showing the missing-input empty state.
        """
        traces = []
        for turn in attr.get("turns") or []:
            tid = str((turn.get("meta") or {}).get("trace_id") or "")
            if tid and tid not in traces:
                traces.append(tid)
        smeta = attr.get("session_meta") or {}
        tid = str(smeta.get("trace_id") or "")
        if tid and tid not in traces:
            traces.append(tid)
        locations = self._input_locations()
        for tid in traces:
            ref = locations.get(tid)
            if not ref:
                continue
            rel, offset = ref
            try:
                with open(self.datasets / rel, "rb") as fh:
                    fh.seek(offset)
                    return json.loads(fh.readline())
            except (OSError, ValueError) as exc:
                build.debug(f"detail trace input {tid}: {exc}")
        return None

    @staticmethod
    def _read(reader, ref):
        name, number = ref
        return reader.raw_line(name, number)

    def _cluster_stamp(self):
        files = list(self.cache_dir.glob("clusters-*.pkl"))
        return max((p.stat().st_mtime for p in files), default=0)

    def _clusters(self, stamp):
        # A rebuilt mapping (new pickle) must reach the details regenerated for it;
        # caching the first index forever would bake the old cluster paths back in.
        if self._cluster_index is not None and stamp == self._cluster_loaded:
            return self._cluster_index
        with self._cluster_lock:
            if self._cluster_index is None or stamp != self._cluster_loaded:
                sig = build.cluster_signature(self.datasets, self.cache_dir)
                _, index = build.load_clusters_cached(self.datasets, sig, self.cache_dir)
                self._cluster_index = index
                self._cluster_loaded = stamp
            return self._cluster_index

    def _fresh(self, path, stamp):
        try:
            if path.stat().st_mtime >= max(stamp, self.version_stamp):
                build.ensure_detail_gz(path)
                return True
        except OSError:
            pass
        return False

    def ensure(self, slug: str):
        if not SLUG.match(slug):
            return None
        path = self.sample_dir / f"{slug}.json"
        stamp = self._cluster_stamp()
        if self._fresh(path, stamp):
            return path
        with self._slug_lock(slug):
            if self._fresh(path, stamp):
                return path
            store = self._open()
            row = store.sample_row(slug)
            if not row:
                # The build may have committed this row after the long-lived
                # read-only connection opened; retry with a fresh snapshot.
                store = self._reopen()
                row = store.sample_row(slug)
            if not row:
                return None
            (_, _, _, _, _, product, model, date, split,
             output, output_line, refs) = row
            refs = json.loads(refs) if refs else {}
            pair = {
                "product": product, "model": model, "date": date, "split": split,
                "input": refs.get("input"), "compact": refs.get("compact"),
                "output": [output, output_line],
            }
            reader = build.LineReader(self.datasets, store)
            try:
                try:
                    attr = json.loads(self._read(reader, [output, output_line]))
                except (OSError, IndexError, ValueError) as exc:
                    build.debug(f"detail {slug}: bad output: {exc}")
                    return None
                inp = None
                if pair["input"]:
                    try:
                        inp = json.loads(self._read(reader, pair["input"]))
                    except (OSError, IndexError, ValueError) as exc:
                        build.debug(f"detail {slug}: bad input: {exc}")
                if inp is None:
                    inp = self._input_by_trace(attr)
                comp = None
                if pair["compact"]:
                    try:
                        comp = json.loads(self._read(reader, pair["compact"]))
                    except (OSError, IndexError, ValueError) as exc:
                        build.debug(f"detail {slug}: bad compact: {exc}")
                try:
                    detail, _, _ = build.build_sample(
                        pair, inp, attr, comp, self._clusters(stamp), Counter())
                except Exception as exc:  # noqa: BLE001 - one sample must not break the server
                    build.debug(f"detail {slug}: build failed: {exc}")
                    return None
            finally:
                reader.close()
            detail["slug"] = slug
            build.write_json(path, detail)
            return path

    def prewarm(self, slugs):
        """Generate a small first-page set in the background; never fatal.

        Each slug owns a per-slug lock and the builder is thread-safe now, so a
        small pool turns the first-page warm from ~40 sequential builds into one
        short burst (and stops it competing with user requests for as long).
        """
        from concurrent.futures import ThreadPoolExecutor
        workers = min(8, max(1, len(slugs)))
        made = 0

        def one(slug):
            try:
                return bool(self.ensure(slug))
            except Exception as exc:  # noqa: BLE001 - prewarm is best effort
                build.debug(f"prewarm {slug}: {exc}")
                return False

        with ThreadPoolExecutor(max_workers=workers) as pool:
            made = sum(1 for ok in pool.map(one, slugs) if ok)
        return made

    def close(self):
        store = getattr(self._local, "store", None)
        if store is not None:
            store.close()
            self._local.store = None
