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
import human_read_overlay as hro
from keylocks import KeyedLocks

SLUG = re.compile(r"^[0-9a-f]{10}$")
# 详情文件单独失效：配对修正 / 长文本全量保留 / 用户注入上下文拆分后要刷新旧缓存，但不能连带让样本索引全量重建。
DETAIL_VERSION = "2026-11-26.1"


class ForecastIndex:
    """slug -> (product, byte span of its line in ``4_forecast/<p>/prediction_items.jsonl``).

    Only forecast answers whose export carries a ``trajectory`` pointer are listed; the
    index is rebuilt when a feed file changes, and lines are re-read on demand."""

    def __init__(self, datasets: Path):
        self.root = Path(datasets) / build.FORECAST_DIR
        self._lock = threading.Lock()
        self._stamp = None
        self._index = {}

    def _scan(self):
        files = sorted(self.root.glob("*/prediction_items.jsonl"))
        stamp = tuple((str(p), p.stat().st_mtime_ns, p.stat().st_size) for p in files)
        if stamp == self._stamp:
            return
        index = {}
        for path in files:
            product = path.parent.name
            offset = 0
            with open(path, "rb") as fh:
                for line in fh:
                    size = len(line)
                    try:
                        item = json.loads(line)
                    except ValueError:
                        item = None
                    if isinstance(item, dict) and item.get("trajectory") and item.get("trace_id"):
                        slug = build.forecast_slug(product, item.get("version") or "", item["trace_id"])
                        index[slug] = (path, offset, size, product)
                    offset += size
        self._index, self._stamp = index, stamp

    def get(self, slug):
        with self._lock:
            try:
                self._scan()
            except OSError:
                return None
            hit = self._index.get(slug)
        if not hit:
            return None
        path, offset, size, product = hit
        with open(path, "rb") as fh:
            fh.seek(offset)
            return product, json.loads(fh.read(size))


def _forecast_panel(item):
    """What the sample pane shows above the trajectory: the question, per target the
    prediction, what happened and the verdict."""
    targets = []
    for t in item.get("targets") or []:
        inst = t.get("instrument") or {}
        targets.append({
            "desc": t.get("description"), "inst": " ".join(x for x in (inst.get("name"), inst.get("code")) if x),
            "metric": t.get("metric"), "from": t.get("start_date"), "to": t.get("end_date"),
            "pred": build.clip(t.get("prediction"), 400), "truth": build.clip(t.get("truth"), 700),
            "verdict": t.get("verdict"), "note": build.clip(t.get("error_note"), 400),
            "cls": t.get("asset_class"),
        })
    return {
        "status": item.get("status_label"), "result": item.get("result_label"), "score": item.get("score"),
        "answer_at": item.get("answer_at"), "type": item.get("forecast_type_label"),
        "cls": item.get("asset_class_label"), "cause": item.get("error_cause_label"),
        "note": build.clip(item.get("error_cause_note"), 500), "targets": targets,
    }


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
        self._slug_lock = KeyedLocks()
        self._forecast = ForecastIndex(self.datasets)
        self._human_read = hro.HumanReadOverlay(self.datasets)

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

    def ensure_forecast(self, slug: str, path: Path):
        """Detail of a forecast answer without an attribution sample: the trajectory is read
        from the dataset line the export points at, with no problems attached."""
        found = self._forecast.get(slug)
        if not found:
            return None
        product, item = found
        traj = item["trajectory"]
        root = self.datasets.resolve()
        src = (self.datasets / traj["file"]).resolve()
        try:
            src.relative_to(root)
        except ValueError:
            return None
        try:
            with open(src, "rb") as fh:
                fh.seek(int(traj["offset"]))
                inp = json.loads(fh.read(int(traj["bytes"])))
        except (OSError, ValueError, KeyError) as exc:
            build.debug(f"forecast {slug}: bad trajectory: {exc}")
            return None
        pair = {"product": product, "model": item.get("version"), "date": item.get("batch_id"), "split": "daily"}
        attr = {"session_meta": {"session_id": item.get("session_id"), "trace_id": item.get("trace_id"),
                                 "case_id": item.get("case_id"), "request_time": item.get("question_time")}}
        try:
            detail, _, _ = build.build_sample(pair, inp, attr, None, {}, Counter())
        except Exception as exc:  # noqa: BLE001 - one sample must not break the server
            build.debug(f"forecast {slug}: build failed: {exc}")
            return None
        detail["slug"] = slug
        detail["forecast"] = _forecast_panel(item)
        build.write_json(path, detail)
        return path

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

    def _fresh(self, path, stamp, extra_ns=0):
        try:
            st = path.stat()
            need_ns = max(int(max(stamp, self.version_stamp) * 1_000_000_000), extra_ns)
            if st.st_mtime_ns >= need_ns - 20_000_000:
                build.ensure_detail_gz(path)
                return True
        except OSError:
            pass
        return False

    def _human_read_fresh(self, path, stamp, store, slug):
        """Return (is_fresh, preloaded_row) factoring in human_read updates for this slug's files."""
        try:
            cached_mtime_ns = path.stat().st_mtime_ns
        except OSError:
            return False, None
        base_ns = int(max(stamp, self.version_stamp) * 1_000_000_000)
        if cached_mtime_ns < base_ns - 20_000_000:
            return False, None
        # Fast path: if human_read DB hasn't changed since this cached file was written, it's fresh!
        db_ns = self._human_read.db_mtime_ns()
        if db_ns == 0 or cached_mtime_ns >= db_ns - 20_000_000:
            build.ensure_detail_gz(path)
            return True, None
        # DB has newer writes: check whether THIS slug's specific attribution/compact file was updated
        row = store.sample_row(slug)
        if not row:
            build.ensure_detail_gz(path)
            return True, None
        output = row[9]
        refs = json.loads(row[11]) if row[11] else {}
        attr_rel = hro.daily_rel_path(output)
        comp_rel = hro.daily_rel_path(refs["compact"][0]) if refs.get("compact") else None
        file_ns = self._human_read.file_latest_ns(attr_rel, comp_rel)
        if cached_mtime_ns >= file_ns - 20_000_000:
            build.ensure_detail_gz(path)
            return True, row
        return False, row

    def ensure(self, slug: str):
        if not SLUG.match(slug):
            return None
        path = self.sample_dir / f"{slug}.json"
        stamp = self._cluster_stamp()
        store = self._open()
        fresh, row = self._human_read_fresh(path, stamp, store, slug)
        if fresh:
            return path
        with self._slug_lock(slug):
            fresh, row = self._human_read_fresh(path, stamp, store, slug)
            if fresh:
                return path
            if not row:
                row = store.sample_row(slug)
            if not row:
                # The build may have committed this row after the long-lived
                # read-only connection opened; retry with a fresh snapshot.
                store = self._reopen()
                row = store.sample_row(slug)
            if not row:
                return self.ensure_forecast(slug, path)
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
            if product == "aime":
                attr_rel = hro.daily_rel_path(output)
                comp_rel = hro.daily_rel_path(pair["compact"][0]) if pair["compact"] else None
                try:
                    self._human_read.overlay_detail(detail, attr_rel, attr, comp_rel, comp)
                except Exception as exc:  # noqa: BLE001 - human_read is best-effort overlay
                    build.debug(f"detail {slug}: human_read overlay failed: {exc}")
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
