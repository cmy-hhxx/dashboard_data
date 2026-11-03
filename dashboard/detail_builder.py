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
from collections import Counter
from pathlib import Path

import build
import build_store as bs

SLUG = re.compile(r"^[0-9a-f]{10}$")


class DetailBuilder:
    def __init__(self, datasets: Path, store_path: Path, sample_dir: Path, cache_dir: Path):
        self.datasets = Path(datasets)
        self.store_path = Path(store_path)
        self.sample_dir = Path(sample_dir)
        self.cache_dir = Path(cache_dir)
        self.sample_dir.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._store = None
        self._cluster_index = None

    def _open(self):
        if self._store is None:
            self._store = bs.BuildStore(self.store_path, readonly=True)
        return self._store

    def _reopen(self):
        if self._store:
            self._store.close()
        self._store = None
        return self._open()

    @staticmethod
    def _read(store, reader, ref):
        name, number = ref
        index = store.get_file(name)
        if index is not None:
            return reader.raw_line(name, number, index)
        return reader.line(name, number)

    def _cluster_stamp(self):
        files = list(self.cache_dir.glob("clusters-*.pkl"))
        return max((p.stat().st_mtime for p in files), default=0)

    def _clusters(self):
        if self._cluster_index is None:
            sig = build.cluster_signature(self.datasets, self.cache_dir)
            _, index = build.load_clusters_cached(self.datasets, sig, self.cache_dir)
            self._cluster_index = index
        return self._cluster_index

    def ensure(self, slug: str):
        if not SLUG.match(slug):
            return None
        path = self.sample_dir / f"{slug}.json"
        try:
            if path.exists() and path.stat().st_mtime >= self._cluster_stamp():
                build.ensure_detail_gz(path)
                return path
        except OSError:
            pass
        with self._lock:
            try:
                if path.exists() and path.stat().st_mtime >= self._cluster_stamp():
                    build.ensure_detail_gz(path)
                    return path
            except OSError:
                pass
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
                    attr = json.loads(self._read(store, reader, [output, output_line]))
                except (OSError, IndexError, ValueError) as exc:
                    build.debug(f"detail {slug}: bad output: {exc}")
                    return None
                inp = None
                if pair["input"]:
                    try:
                        inp = json.loads(self._read(store, reader, pair["input"]))
                    except (OSError, IndexError, ValueError) as exc:
                        build.debug(f"detail {slug}: bad input: {exc}")
                comp = None
                if pair["compact"]:
                    try:
                        comp = json.loads(self._read(store, reader, pair["compact"]))
                    except (OSError, IndexError, ValueError) as exc:
                        build.debug(f"detail {slug}: bad compact: {exc}")
                try:
                    detail, _, _ = build.build_sample(
                        pair, inp, attr, comp, self._clusters(), Counter())
                except Exception as exc:  # noqa: BLE001 - one sample must not break the server
                    build.debug(f"detail {slug}: build failed: {exc}")
                    return None
            finally:
                reader.close()
            detail["slug"] = slug
            build.write_json(path, detail)
            return path

    def prewarm(self, slugs):
        """Generate a small first-page set in the background; never fatal."""
        made = 0
        for slug in slugs:
            try:
                if self.ensure(slug):
                    made += 1
            except Exception as exc:  # noqa: BLE001 - prewarm is best effort
                build.debug(f"prewarm {slug}: {exc}")
        return made

    def close(self):
        if self._store:
            self._store.close()
