"""按需列出某天某模型的评测输入，不进构建索引。

评测数据详情的第三级要回答「这一天的输入对不对」，输出只是一个状态位。以前这一层是输出驱动的
（只列出配对到评测输出的样本），没有输出的日期整组空白——问财 10.4 万条输入里只有 3,299 条有输出，
大部分天根本点不进去。这里改成现读输入文件：一次只读某天某模型的那几个 jsonl（几 MB 到几十 MB），
结果按 (product, day, model, split) 缓存到 cache/inputs/，文件 (size, mtime) 变了才重读。

配对状态不靠重新配对：构建把每条输入行的 64 位内容哈希存进了 files.hashes，samples 表里又存了
每条样本的 ih（同一个哈希的十六进制），所以「这条输入有没有输出」= 查 samples.ih。
"""
from __future__ import annotations

import hashlib
import math
import os
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import json_compat as json
import build
from keylocks import KeyedLocks
import build_store as bs

LIST_VERSION = 5
SLICE_CAP = 500
SLICE_SCAN_BUDGET = 2500
SLICE_MAX_FILES = 12
Q_LIMIT = 200
# 每行只读开头这几 KB：question / session_id / n_traces 都在 meta 里靠前。
# AIME 单日输入文件 1.6 GB，整文件读一遍要两分钟；按行读前缀是十几 MB、一秒级。
FILES_TTL = 600
PREAD_SECONDS = 0.014
STREAM_BYTES_PER_SECOND = 27 * 1024 * 1024
PREFIX = 1024
THREADS = 8
Q_RE = re.compile(rb'"question"\s*:\s*"((?:[^"\\]|\\.)*)"')
SID_RE = re.compile(rb'"session_id"\s*:\s*"([^"]*)"')
THREAD_RE = re.compile(rb'"thread_id"\s*:\s*"([^"]*)"')
RQT_RE = re.compile(rb'"request_time"\s*:\s*"([^"]*)"')
NTR_RE = re.compile(rb'"n_traces"\s*:\s*(\d+)')
TID_RE = re.compile(rb'"trace_id"\s*:\s*"([^"]*)"')
SKILL_RE = re.compile(rb'"skill_name"\s*:\s*"((?:[^"\\]|\\.)*)"')
TASK_RE = re.compile(rb'"task(?:_category)?"\s*:\s*"((?:[^"\\]|\\.)*)"')
SUBTASK_RE = re.compile(rb'"subtask(?:_category)?"\s*:\s*"((?:[^"\\]|\\.)*)"')
DAY_NAME_RE = re.compile(r"(\d{4}-\d{2}-\d{2})")
DAY_COMPACT_RE = re.compile(r"(?<!\d)(\d{4})(\d{2})(\d{2})(?!\d)")
CACHE_NAME_RE = re.compile(r"^(?P<prod>[a-z][a-z0-9_]*)-(?P<sp>daily|lost)-(?P<m>.+)-(?P<day>\d{4}-\d{2}-\d{2})\.json$")
CHUNK = 400


def _match_model_family(actual: str | None, query: str | None) -> bool:
    qm = str(query or "").strip().lower()
    if not qm or qm == "all":
        return True
    am = str(actual or "").strip().lower()
    return am == qm or am.startswith(qm)


def _day_from_filename(name: str) -> str:
    m = DAY_NAME_RE.search(name)
    if m:
        return m.group(1)
    m2 = DAY_COMPACT_RE.search(name)
    if m2:
        return f"{m2.group(1)}-{m2.group(2)}-{m2.group(3)}"
    return ""


class InputLister:
    def __init__(self, datasets: Path, store_path: Path, cache_dir: Path, static_dir: Path | None = None):
        self.datasets = Path(datasets)
        self.store_path = Path(store_path)
        self.static = Path(static_dir) if static_dir else None
        self.cache = Path(cache_dir) / "inputs"
        self.cache.mkdir(parents=True, exist_ok=True)
        self._local = threading.local()
        self._listing_lock = KeyedLocks()
        self._files = {}
        self._paired = {}
        self._index = {}

    # ---------------------------------------------------------------- discovery
    def _open(self):
        store = getattr(self._local, "store", None)
        if store is None:
            store = self._local.store = bs.BuildStore(self.store_path, readonly=True)
        return store

    def _top(self, product: str):
        for path in sorted(self.datasets.glob(f"*_{product}")):
            if path.is_dir():
                return path
        return None

    def _all_files(self, product: str):
        """输入文件清单按 product 缓存。

        build.input_files 是 rglob，在弗吉尼亚的 ceph 上要 23 秒（43 个文件，目录元数据贵）。
        所以：有缓存就一直用它，过期了先返回旧的、后台再刷；进程启动时 warm() 先把两边都读好。
        """
        cached = self._files.get(product)
        now = time.time()
        if cached:
            if now - cached[0] >= FILES_TTL and not cached[2].is_set():
                cached[2].set()
                threading.Thread(target=self._refresh_files, args=(product,), daemon=True).start()
            return cached[1]
        # 磁盘上留了一份清单：发布重启时不用再花 20 秒 rglob，先用旧的、后台再刷。
        hit = self._load_files(product)
        if hit is not None:
            return hit
        return self._scan_files(product)

    def _files_path(self, product: str):
        return self.cache / f"files-{product}.json"

    def _load_files(self, product: str):
        try:
            payload = json.loads(self._files_path(product).read_text(encoding="utf-8"))
            rels = [r for r in payload.get("files") or [] if isinstance(r, str)]
        except (OSError, ValueError):
            return None
        if not rels:
            return None
        files = [self.datasets / rel for rel in rels]
        self._files[product] = (float(payload.get("ts") or 0), files, threading.Event())
        if time.time() - float(payload.get("ts") or 0) >= FILES_TTL:
            self._files[product][2].set()
            threading.Thread(target=self._refresh_files, args=(product,), daemon=True).start()
        return files

    def _scan_files(self, product: str):
        top = self._top(product)
        t0 = time.time()
        files = build.input_files(self.datasets, top, product) if top else []
        self._files[product] = (t0, files, threading.Event())
        try:
            payload = {"ts": t0, "files": [p.relative_to(self.datasets).as_posix() for p in files]}
            build.replace_bytes(self._files_path(product), json.dumps(payload, ensure_ascii=False).encode("utf-8"))
        except (OSError, ValueError) as exc:
            print(f"[inputs] file list for {product} not cached: {exc}", flush=True)
        return files

    def _refresh_files(self, product: str):
        try:
            self._scan_files(product)
        except Exception as exc:  # noqa: BLE001 - 刷新失败就继续用旧清单
            print(f"[inputs] file list refresh for {product} failed, keeping the old one: {exc}", flush=True)
        finally:
            hit = self._files.get(product)
            if hit:
                hit[2].clear()

    def prewarm_listings(self, products, days: int = 1):
        """Pre-read the latest day's listing per model/split.

        The first click on 评测量详情 otherwise pays the per-day input scan
        (100–600 ms) while the page waits; the payload is cached to disk, so
        warming one day per series in the background makes that click instant.
        """
        try:
            store = self._open()
        except Exception:  # noqa: BLE001 - prewarm is best effort
            return
        for product in products:
            try:
                rows = store.db.execute(
                    "SELECT DISTINCT date, model, split FROM samples "
                    "WHERE product=? AND date<>'' ORDER BY date DESC LIMIT 40",
                    (product,),
                ).fetchall()
            except Exception:  # noqa: BLE001
                continue
            latest = {}
            for date, model, split in rows:
                if not date or not model:
                    continue
                bucket = latest.setdefault((model, split), [])
                if date not in bucket and len(bucket) < days:
                    bucket.append(date)
            for (model, split), dates in latest.items():
                for day in dates:
                    try:
                        self.listing(product, day, model, split)
                    except Exception:  # noqa: BLE001
                        continue

    def warm(self, products):
        """启动时后台预热文件清单：优先用磁盘上那份（秒级），没有才重扫。

        之前这里无条件 _scan_files：每次发布重启都在弗吉尼亚重 rglob 2.6 万个输入文件，
        数据没变也要跑十几分钟，白占 I/O。
        """
        for product in products:
            try:
                self._all_files(product)
            except Exception:  # noqa: BLE001
                continue
        self._prune_cache()

    def _prune_cache(self, days: int = 90):
        """Drop listing/detail caches for days nobody will open again."""
        cutoff = time.time() - days * 86400
        for path in self.cache.glob("*.json"):
            try:
                if path.stat().st_mtime < cutoff:
                    path.unlink()
            except OSError:
                continue

    def _model_of(self, rel: str) -> str:
        """输入文件归属的模型：目录名报不出时用行级 trace 模型（和看板同一套 key）。

        问财的 b_*_search 变体目录名不在模型白名单里，但文件里的 trace meta 有模型；
        构建索引把归一化后的模型存在 files.stats.by_model，这里直接取。
        """
        model = bs.model_from_rel(rel)
        if model:
            return model
        try:
            meta = self._open().file_meta(rel)
        except Exception:  # noqa: BLE001 - 索引读不到就按目录名兜底
            return model
        return bs.stats_model((meta or {}).get("stats"))

    def _files_for(self, product: str, day: str, model: str, split: str):
        out = []
        compact_day = day.replace("-", "")
        for path in self._all_files(product):
            if day not in path.name and (not compact_day or compact_day not in path.name):
                continue
            rel = path.relative_to(self.datasets).as_posix()
            if bs.split_from_rel(rel) != split:
                continue
            if self._model_of(rel) != model:
                continue
            out.append((rel, path))
        return out

    def _paired_map(self, product: str):
        """ih → slug，用来判断一条输入有没有对应的评测输出。"""
        stamp = 0.0
        try:
            stamp = self.store_path.stat().st_mtime
        except OSError:
            pass
        hit = self._paired.get(product)
        if hit and hit[0] == stamp:
            return hit[1]
        store = self._open()
        rows = store.db.execute("SELECT ih,slug FROM samples WHERE product=? AND ih IS NOT NULL", (product,)).fetchall()
        mapping = {row[0]: row[1] for row in rows}
        self._paired[product] = (stamp, mapping)
        return mapping

    def _index_rows(self, product: str):
        """samples-<product>.json 里已配对样本的 (q, sid, tr)：这些行不用读输入文件。"""
        if not self.static:
            return {}
        path = self.static / f"samples-{product}.json"
        try:
            stamp = path.stat().st_mtime
        except OSError:
            return {}
        hit = self._index.get(product)
        if hit and hit[0] == stamp:
            return hit[1]
        out = {}
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
            for row in (payload.get("products", {}).get(product) or {}).get("rows") or []:
                slug = row.get("s")
                if slug:
                    out[slug] = {
                        "q": row.get("q") or "", "sid": row.get("sid") or "", "tr": row.get("tr") or 1,
                        "tid": row.get("tid") or "", "cat": row.get("skill") or row.get("task") or "",
                        "task": row.get("task") or "未接入分类体系", "sub": row.get("sub") or "",
                    }
        except (OSError, ValueError, KeyError):
            out = {}
        self._index[product] = (stamp, out)
        return out

    # ---------------------------------------------------------------- listing
    def _sig(self, files):
        sig = []
        for rel, path in files:
            try:
                stat = path.stat()
            except OSError:
                return None
            sig.append([rel, stat.st_size, stat.st_mtime_ns])
        return sig


    def listing(self, product: str, day: str, model: str, split: str):
        files = self._files_for(product, day, model, split)
        if not files:
            return {"version": LIST_VERSION, "rows": [], "files": 0}
        sig = self._sig(files)
        if sig is None:
            return {"version": LIST_VERSION, "rows": [], "files": 0}
        path = self.cache / f"{product}-{split}-{model}-{day}.json"
        try:
            cached = json.loads(path.read_text(encoding="utf-8"))
            if cached.get("version") == LIST_VERSION and cached.get("sig") == sig:
                return cached
        except (OSError, ValueError):
            pass
        with self._listing_lock(path.name):
            try:
                cached = json.loads(path.read_text(encoding="utf-8"))
                if cached.get("version") == LIST_VERSION and cached.get("sig") == sig:
                    return cached
            except (OSError, ValueError):
                pass
            rows = self._scan(product, files)
            payload = {"version": LIST_VERSION, "sig": sig, "files": len(files), "rows": rows}
            build.replace_bytes(path, json.dumps(payload, ensure_ascii=False).encode("utf-8"))
            return payload

    def _scan(self, product: str, files):
        """行级信息只花在「没有配对输出」的输入上。

        每行的内容哈希（files.hashes）和样本的 ih 都在 sqlite 里，所以哪些行有输出不用读文件；
        有输出的行直接从 samples-<product>.json 取 q/sid/轮数。

        没输出的行要读文件，两种读法按代价挑：ceph 上单次 pread 约 14ms、顺序读约 27MB/s，
        所以行少就逐行 pread，行多就整文件顺序扫一遍（问财 304MB 的日文件 11 秒扫完，
        逐行 pread 2053 行要 57 秒；AIME 1.6GB 那天只有几十行没输出，逐行反而更划算）。
        """
        paired = self._paired_map(product)
        index_rows = self._index_rows(product)
        rows = []
        paired_slugs = []
        store = self._open()
        for fi, (rel, path) in enumerate(files):
            index = store.get_file(rel) or {}
            offsets = index.get("offsets") or []
            hashes = index.get("hashes") or []
            tids = index.get("tids") or []
            lines = len(offsets) - 1
            if lines < 1:
                # 构建的 files 表里没有这个文件（例如文件在构建之后才落地）：按磁盘自己读一遍。
                extra = self._scan_unknown(fi, path, paired, index_rows)
                rows.extend(extra)
                for row in extra:
                    if row.get("s"):
                        paired_slugs.append(row["s"])
                continue
            pending = {}
            for number in range(1, lines + 1):
                ih = f"{hashes[number - 1]:016x}" if number - 1 < len(hashes) else None
                slug = paired.get(ih) if ih else None
                if slug and slug in index_rows:
                    hit = index_rows[slug]
                    rows.append({
                        "r": f"{fi}:{number}", "q": hit["q"][:Q_LIMIT], "sid": hit["sid"],
                        "tid": hit["tid"], "cat": hit["cat"],
                        "tr": hit["tr"] or 1, "rq": "", "ev": 1, "s": slug,
                    })
                    paired_slugs.append(slug)
                else:
                    pending[number] = slug
            if not pending:
                continue
            try:
                size = path.stat().st_size
            except OSError:
                continue
            # 逐行 pread 的估算代价（最坏 2 次读/行）对上整文件顺序读。
            pread_cost = len(pending) * 2 * PREAD_SECONDS
            stream_cost = size / STREAM_BYTES_PER_SECOND
            if pread_cost > stream_cost:
                rows.extend(self._scan_stream(fi, path, pending, tids, lines))
            else:
                rows.extend(self._scan_sparse(fi, path, pending, offsets, tids))
        if paired_slugs:
            sev = self._sev_counts(paired_slugs)
            for row in rows:
                slug = row.get("s")
                if slug and slug in sev:
                    row["sv"] = sev[slug]
        rows.sort(key=lambda r: (int(r["r"].split(":", 1)[0]), int(r["r"].split(":", 1)[1])))
        return rows

    def _scan_unknown(self, fi, path, paired, index_rows):
        """构建缓存里没有这个输入文件时，直接读磁盘：算行哈希判断有没有输出，再解析这一行。"""
        out = []
        try:
            with open(path, "rb", buffering=8 << 20) as fh:
                for number, raw in enumerate(fh, 1):
                    body = raw.rstrip(b"\n")
                    if body.endswith(b"\r"):
                        body = body[:-1]
                    if not body.strip():
                        continue
                    ih = f"{bs.line_hash(body):016x}"
                    slug = paired.get(ih)
                    if slug and slug in index_rows:
                        hit = index_rows[slug]
                        out.append({
                            "r": f"{fi}:{number}", "q": hit["q"][:Q_LIMIT], "sid": hit["sid"],
                            "tid": hit["tid"], "cat": hit["cat"],
                            "tr": hit["tr"] or 1, "rq": "", "ev": 1, "s": slug,
                        })
                        continue
                    payload = None
                    try:
                        payload = json.loads(body)
                    except ValueError:
                        payload = None
                    if isinstance(payload, dict):
                        meta = payload.get("meta") or {}
                        q = build.decode_question(meta.get("question"))
                        sid = meta.get("session_id") or meta.get("thread_id") or ""
                        tr = len(payload.get("traces") or []) or 1
                        tid = meta.get("trace_id") or ""
                        cat = meta.get("skill_name") or meta.get("task") or ""
                        rq = payload.get("request_time") or meta.get("request_time") or ""
                    else:
                        q, sid, rq, ntr, tid, cat = self._fields(body)
                        tr = ntr or 1
                    out.append({
                        "r": f"{fi}:{number}", "q": q[:Q_LIMIT], "sid": sid, "tid": tid, "cat": cat,
                        "tr": tr, "rq": rq, "ev": 0,
                    })
        except OSError:
            return out
        return out

    def _sev_counts(self, slugs):
        """已配对样本的 P0–P4 问题数：samples.row 里存了 sv，按 slug 批量取。"""
        out = {}
        store = self._open()
        for start in range(0, len(slugs), CHUNK):
            chunk = slugs[start:start + CHUNK]
            marks = ",".join("?" * len(chunk))
            try:
                rows = store.db.execute(
                    f"SELECT slug,row FROM samples WHERE slug IN ({marks})", chunk).fetchall()
            except Exception:  # noqa: BLE001
                return out
            for slug, row_json in rows:
                try:
                    row = json.loads(row_json)
                except (TypeError, ValueError):
                    continue
                sv = row.get("sv") if isinstance(row, dict) else None
                if isinstance(sv, list) and len(sv) >= 5:
                    out[slug] = [int(v or 0) for v in sv[:5]]
        return out

    @staticmethod
    def _fields(raw: bytes):
        q = ""
        match = Q_RE.search(raw)
        if match:
            q = _json_str(match.group(1))
        match = SID_RE.search(raw) or THREAD_RE.search(raw)
        sid = match.group(1).decode("utf-8", "replace") if match else ""
        match = RQT_RE.search(raw)
        rq = match.group(1).decode("utf-8", "replace") if match else ""
        match = NTR_RE.search(raw)
        ntr = int(match.group(1)) if match else 0
        match = TID_RE.search(raw)
        # 新版输入外层 meta 也可能带 trace_id（实际是 session/thread id）；
        # 真正的轮次 id 在 traces[].meta 里，跳过 traces 之前的那个。
        traces_at = raw.find(b'"traces"')
        if match and 0 <= traces_at <= match.start():
            match = TID_RE.search(raw, traces_at)
        tid = match.group(1).decode("utf-8", "replace") if match else ""
        match = SKILL_RE.search(raw) or TASK_RE.search(raw)
        cat = _json_str(match.group(1)) if match else ""
        return q, sid, rq, ntr, tid, cat

    def _row(self, fi, number, slug, fields, tids):
        q, sid, rq, ntr, tid, cat = fields
        if not ntr:
            ntr = len(tids[number - 1]) if number - 1 < len(tids) else 0
        item = {"r": f"{fi}:{number}", "q": q[:Q_LIMIT], "sid": sid, "tid": tid, "cat": cat,
                "tr": ntr or 1, "rq": rq, "ev": 1 if slug else 0}
        if slug:
            item["s"] = slug
        return item

    def _scan_sparse(self, fi, path, pending, offsets, tids):
        """行少：逐行 pread 前缀，取不到 question 再读整行（问财的 meta 有时在行尾）。"""
        out = []
        try:
            fd = os.open(path, os.O_RDONLY)
        except OSError:
            return out
        try:
            def one(number, slug=None):
                start, end = offsets[number - 1], offsets[number]
                raw = os.pread(fd, min(end - start, PREFIX), start)
                fields = self._fields(raw)
                if not fields[0]:
                    fields = self._fields(os.pread(fd, end - start, start))
                return self._row(fi, number, slug, fields, tids)

            items = list(pending.items())
            workers = max(1, min(THREADS, len(items)))
            if workers == 1:
                out.extend(one(n, slug) for n, slug in items)
            else:
                with ThreadPoolExecutor(max_workers=workers) as pool:
                    out.extend(pool.map(lambda item: one(item[0], item[1]), items))
        finally:
            os.close(fd)
        return out

    def _scan_stream(self, fi, path, pending, tids, lines):
        """行多：整文件顺序扫一遍，只对需要的行做正则提取。"""
        out = []
        try:
            with open(path, "rb", buffering=8 << 20) as fh:
                for number, raw in enumerate(fh, 1):
                    if number >= lines + 1:
                        break
                    slug = pending.get(number)
                    if slug is None and number not in pending:
                        continue
                    body = raw.rstrip(b"\n")
                    if body.endswith(b"\r"):
                        body = body[:-1]
                    out.append(self._row(fi, number, slug, self._fields(body), tids))
        except OSError:
            return out
        return out

    @staticmethod
    def _extract_task(raw: bytes) -> tuple[str, str]:
        tm = TASK_RE.search(raw)
        task = _json_str(tm.group(1)) if tm else ""
        sm = SUBTASK_RE.search(raw)
        sub = _json_str(sm.group(1)) if sm else ""
        return task or "未接入分类体系", sub

    def slice_inputs(
        self,
        product: str,
        model: str = "",
        task: str = "",
        others: set[str] | None = None,
        cap: int = SLICE_CAP,
    ) -> dict:
        """Bounded (<= 500) recent input sample slice for 数据量 drilldown without full scan."""
        cap = max(1, min(SLICE_CAP, int(cap or SLICE_CAP)))
        others_set = set(others or ())
        files = self._all_files(product)
        paired = self._paired_map(product)
        index_rows = self._index_rows(product)
        store = self._open()

        # Group files by (day, split, model) ordered newest-day first, matching `_files_for` ordering within each group.
        grouped_files: dict[tuple[str, str, str], list[tuple[str, Path]]] = {}
        for path in files:
            rel = path.relative_to(self.datasets).as_posix()
            rm = self._model_of(rel)
            if not _match_model_family(rm, model):
                continue
            sp = bs.split_from_rel(rel)
            day = _day_from_filename(path.name)
            grouped_files.setdefault((day, sp, rm), []).append((rel, path))

        ordered_groups = sorted(grouped_files.items(), key=lambda kv: (kv[0][0], kv[0][1], kv[0][2]), reverse=True)

        total_known = 0
        for (_, _, _), flist in ordered_groups:
            for rel, _ in flist:
                idx = store.get_file(rel) or {}
                offsets = idx.get("offsets") or []
                if len(offsets) > 1:
                    total_known += len(offsets) - 1

        collected: list[dict] = []
        scanned_budget = 0
        hit_cap_or_budget = False

        def match_task(rtask: str) -> bool:
            tname = rtask or "未接入分类体系"
            if task:
                return tname == task
            if others_set:
                return tname not in others_set
            return True

        def build_group_name(rtask: str, rsub: str) -> str:
            if task or others_set:
                return rsub or rtask or "未接入分类体系"
            return rtask or "未接入分类体系"

        if ordered_groups:
            # Spread initial samples across up to 6 recent day/model groups, then top up from remaining groups.
            active_groups = ordered_groups[:SLICE_MAX_FILES]
            target_per_group = max(20, math.ceil(cap / max(1, min(len(active_groups), 6))))

            for gi, ((day, sp, rm), flist) in enumerate(active_groups):
                if len(collected) >= cap or scanned_budget >= SLICE_SCAN_BUDGET:
                    hit_cap_or_budget = True
                    break
                want = cap - len(collected)
                if gi < len(active_groups) - 1 and not task and not others_set:
                    want = min(want, target_per_group)

                # Prefer already-cached daily listing on disk if valid.
                cache_path = self.cache / f"{product}-{sp}-{rm}-{day}.json"
                sig = self._sig(flist)
                used_cache = False
                if sig is not None and cache_path.is_file():
                    try:
                        cached = json.loads(cache_path.read_text(encoding="utf-8"))
                        if cached.get("version") == LIST_VERSION and cached.get("sig") == sig:
                            c_rows = cached.get("rows") or []
                            step = max(1, len(c_rows) // max(1, want))
                            for row in c_rows[::step]:
                                slug = row.get("s") or ""
                                idx_hit = index_rows.get(slug) if slug else None
                                rtask = (idx_hit or {}).get("task") or row.get("cat") or "未接入分类体系"
                                rsub = (idx_hit or {}).get("sub") or ""
                                scanned_budget += 1
                                if not match_task(rtask):
                                    if scanned_budget >= SLICE_SCAN_BUDGET:
                                        break
                                    continue
                                collected.append({
                                    "q": (row.get("q") or "")[:Q_LIMIT],
                                    "m": rm,
                                    "sp": sp,
                                    "d": day or str(row.get("rq") or "")[:10],
                                    "r": row.get("r") or "",
                                    "tr": int(row.get("tr") or 1),
                                    "ev": 1 if row.get("ev") else 0,
                                    "s": slug,
                                    "cat": rtask,
                                    "_grp": build_group_name(rtask, rsub),
                                })
                                if len(collected) >= cap or len([x for x in collected if x.get("d") == day and x.get("m") == rm and x.get("sp") == sp]) >= want:
                                    break
                            used_cache = True
                    except (OSError, ValueError):
                        used_cache = False
                if used_cache:
                    continue

                taken_in_group = 0
                for fi, (rel, path) in enumerate(flist):
                    if len(collected) >= cap or taken_in_group >= want or scanned_budget >= SLICE_SCAN_BUDGET:
                        break
                    idx = store.get_file(rel) or {}
                    offsets = idx.get("offsets") or []
                    hashes = idx.get("hashes") or []
                    tids = idx.get("tids") or []
                    lines = len(offsets) - 1
                    if lines >= 1:
                        need_here = min(lines, want - taken_in_group)
                        sample_budget = need_here if (not task and not others_set) else min(lines, max(need_here * 4, 200))
                        step = max(1, lines // max(1, sample_budget))
                        sample_nums = list(range(1, lines + 1, step))
                        fd = None
                        try:
                            for number in sample_nums:
                                if len(collected) >= cap or taken_in_group >= want or scanned_budget >= SLICE_SCAN_BUDGET:
                                    hit_cap_or_budget = True
                                    break
                                scanned_budget += 1
                                ih = f"{hashes[number - 1]:016x}" if number - 1 < len(hashes) else None
                                slug = paired.get(ih) if ih else None
                                if slug and slug in index_rows:
                                    hit = index_rows[slug]
                                    rtask = hit.get("task") or hit.get("cat") or "未接入分类体系"
                                    rsub = hit.get("sub") or ""
                                    if not match_task(rtask):
                                        continue
                                    collected.append({
                                        "q": (hit["q"] or "")[:Q_LIMIT],
                                        "m": rm,
                                        "sp": sp,
                                        "d": day,
                                        "r": f"{fi}:{number}",
                                        "tr": int(hit["tr"] or 1),
                                        "ev": 1,
                                        "s": slug,
                                        "cat": rtask,
                                        "_grp": build_group_name(rtask, rsub),
                                    })
                                    taken_in_group += 1
                                    continue
                                if fd is None:
                                    try:
                                        fd = os.open(path, os.O_RDONLY)
                                    except OSError:
                                        break
                                start, end = offsets[number - 1], offsets[number]
                                raw = os.pread(fd, min(end - start, PREFIX), start)
                                fields = self._fields(raw)
                                if not fields[0] and end - start > PREFIX:
                                    raw = os.pread(fd, end - start, start)
                                    fields = self._fields(raw)
                                rtask, rsub = self._extract_task(raw)
                                if not match_task(rtask):
                                    continue
                                row_obj = self._row(fi, number, slug, fields, tids)
                                collected.append({
                                    "q": row_obj["q"],
                                    "m": rm,
                                    "sp": sp,
                                    "d": day or str(row_obj.get("rq") or "")[:10],
                                    "r": row_obj["r"],
                                    "tr": int(row_obj["tr"] or 1),
                                    "ev": 1 if slug else 0,
                                    "s": slug or "",
                                    "cat": rtask,
                                    "_grp": build_group_name(rtask, rsub),
                                })
                                taken_in_group += 1
                        finally:
                            if fd is not None:
                                os.close(fd)
                    else:
                        # Unindexed file fallback: bounded sequential prefix read.
                        try:
                            with open(path, "rb", buffering=1 << 20) as fh:
                                for number, raw in enumerate(fh, 1):
                                    if len(collected) >= cap or taken_in_group >= want or scanned_budget >= SLICE_SCAN_BUDGET:
                                        hit_cap_or_budget = True
                                        break
                                    body = raw.rstrip(b"\r\n")
                                    if not body.strip():
                                        continue
                                    scanned_budget += 1
                                    ih = f"{bs.line_hash(body):016x}"
                                    slug = paired.get(ih)
                                    if slug and slug in index_rows:
                                        hit = index_rows[slug]
                                        rtask = hit.get("task") or hit.get("cat") or "未接入分类体系"
                                        rsub = hit.get("sub") or ""
                                        if not match_task(rtask):
                                            continue
                                        collected.append({
                                            "q": (hit["q"] or "")[:Q_LIMIT],
                                            "m": rm,
                                            "sp": sp,
                                            "d": day,
                                            "r": f"{fi}:{number}",
                                            "tr": int(hit["tr"] or 1),
                                            "ev": 1,
                                            "s": slug,
                                            "cat": rtask,
                                            "_grp": build_group_name(rtask, rsub),
                                        })
                                        taken_in_group += 1
                                        continue
                                    fields = self._fields(body)
                                    rtask, rsub = self._extract_task(body)
                                    if not match_task(rtask):
                                        continue
                                    row_obj = self._row(fi, number, slug, fields, [[]])
                                    collected.append({
                                        "q": row_obj["q"],
                                        "m": rm,
                                        "sp": sp,
                                        "d": day or str(row_obj.get("rq") or "")[:10],
                                        "r": row_obj["r"],
                                        "tr": int(row_obj["tr"] or 1),
                                        "ev": 1 if slug else 0,
                                        "s": slug or "",
                                        "cat": rtask,
                                        "_grp": build_group_name(rtask, rsub),
                                    })
                                    taken_in_group += 1
                        except OSError:
                            continue

        elif self.cache.is_dir():
            # Fallback when dataset raw files are absent locally, using cached daily input listings.
            cache_candidates = []
            for p in self.cache.glob(f"{product}-*.json"):
                m = CACHE_NAME_RE.match(p.name)
                if not m:
                    continue
                if not _match_model_family(m.group("m"), model):
                    continue
                cache_candidates.append((m.group("day"), m.group("sp"), m.group("m"), p))
            cache_candidates.sort(reverse=True)
            for day, sp, rm, p in cache_candidates[:SLICE_MAX_FILES]:
                if len(collected) >= cap:
                    hit_cap_or_budget = True
                    break
                try:
                    cached = json.loads(p.read_text(encoding="utf-8"))
                except (OSError, ValueError):
                    continue
                for row in cached.get("rows") or []:
                    if len(collected) >= cap:
                        hit_cap_or_budget = True
                        break
                    slug = row.get("s") or ""
                    idx_hit = index_rows.get(slug) if slug else None
                    rtask = (idx_hit or {}).get("task") or row.get("cat") or "未接入分类体系"
                    rsub = (idx_hit or {}).get("sub") or ""
                    if not match_task(rtask):
                        continue
                    collected.append({
                        "q": (row.get("q") or "")[:Q_LIMIT],
                        "m": rm,
                        "sp": sp,
                        "d": day or str(row.get("rq") or "")[:10],
                        "r": row.get("r") or "",
                        "tr": int(row.get("tr") or 1),
                        "ev": 1 if row.get("ev") else 0,
                        "s": slug,
                        "cat": rtask,
                        "_grp": build_group_name(rtask, rsub),
                    })

        # Group by task/subtask; if everything sits in one bucket (e.g. 未接入分类体系),
        # group by date or model so the star map separates naturally into clusters.
        grp_keys = {it["_grp"] for it in collected}
        if len(grp_keys) <= 1 and len(collected) > 1:
            dates_seen = {it["d"] for it in collected if it.get("d")}
            if len(dates_seen) > 1:
                for it in collected:
                    it["_grp"] = it["d"] or "未知日期"
            else:
                models_seen = {it["m"] for it in collected if it.get("m")}
                if len(models_seen) > 1:
                    for it in collected:
                        it["_grp"] = it["m"] or "未知模型"

        grouped_out: dict[str, list[dict]] = {}
        ev_done = 0
        ev_pending = 0
        for it in collected:
            gkey = it.pop("_grp", None) or "未接入分类体系"
            if it.get("ev"):
                ev_done += 1
            else:
                ev_pending += 1
            grouped_out.setdefault(gkey, []).append(it)

        groups = [
            {"key": k, "name": k, "total": len(items), "items": items}
            for k, items in sorted(grouped_out.items(), key=lambda kv: (-len(kv[1]), kv[0]))
        ]
        reported_total = max(len(collected), total_known) if total_known > 0 else len(collected)
        return {
            "product": product,
            "source": "inputs",
            "total": reported_total,
            "recalled": len(collected),
            "cap": cap,
            "capped": reported_total > len(collected) or hit_cap_or_budget,
            "eval_counts": [ev_done, ev_pending],
            "groups": groups,
        }

    # ---------------------------------------------------------------- one record
    def detail(self, product: str, day: str, model: str, split: str, ref: str):
        """没有评测输出的输入也能展开：只渲染输入链路，归因部分为空。"""
        try:
            fi, number = (int(x) for x in ref.split(":", 1))
        except (TypeError, ValueError):
            return None
        files = self._files_for(product, day, model, split)
        if not (0 <= fi < len(files)) or number < 1:
            return None
        rel, path = files[fi]
        key = hashlib.sha256(f"{rel}#{number}".encode()).hexdigest()[:12]
        out = self.cache / f"detail-{key}.json"
        stamp = ""
        try:
            stamp = f"full-v1:{path.stat().st_mtime}"
        except OSError:
            return None
        try:
            cached = json.loads(out.read_text(encoding="utf-8"))
            if cached.get("_stamp") == stamp:
                cached.pop("_stamp", None)
                return cached
        except (OSError, ValueError):
            pass
        store = self._open()
        span = store.line_span(rel, number)
        if not span:
            return None
        reader = build.LineReader(self.datasets, store)
        try:
            raw = reader.read_span(rel, *span)
        finally:
            reader.close()
        try:
            inp = json.loads(raw)
        except ValueError:
            return None
        if not isinstance(inp, dict):
            return None
        try:
            detail, _, _ = build.build_sample(
                {"product": product, "model": model, "date": day, "split": split,
                 "input": None, "compact": None, "output": None},
                inp, {}, None, {}, _counters(),
            )
        except Exception:  # noqa: BLE001 - 单条输入解析失败不该让列表崩
            return None
        meta = inp.get("meta") or {}
        detail["slug"] = key
        detail["inputs_only"] = True
        # build_sample 已从 traces[].meta（每个 trace 的 trace_meta）解析好 ids；
        # 外层 meta.trace_id 可能是 session/thread id，不能覆盖。
        detail.setdefault("ids", {})
        detail.setdefault("meta", {})
        detail["meta"]["request_time"] = detail["meta"].get("request_time") or inp.get("request_time") or meta.get("request_time")
        detail["_stamp"] = stamp
        try:
            build.replace_bytes(out, json.dumps(detail, ensure_ascii=False).encode("utf-8"))
        except OSError:
            pass
        detail.pop("_stamp", None)
        return detail


def _json_str(raw: bytes) -> str:
    try:
        value = json.loads(b'"' + raw + b'"')
    except ValueError:
        return raw.decode("utf-8", "replace")
    return value if isinstance(value, str) else ""


def _counters():
    from collections import Counter
    return Counter()
