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
import os
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import json_compat as json
import build
import build_store as bs

LIST_VERSION = 4
Q_LIMIT = 200
# 每行只读开头这几 KB：question / session_id / n_traces 都在 meta 里靠前。
# AIME 单日输入文件 1.6 GB，整文件读一遍要两分钟；按行读前缀是十几 MB、一秒级。
FILES_TTL = 300
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
TASK_RE = re.compile(rb'"task"\s*:\s*"((?:[^"\\]|\\.)*)"')
CHUNK = 400


class InputLister:
    def __init__(self, datasets: Path, store_path: Path, cache_dir: Path, static_dir: Path | None = None):
        self.datasets = Path(datasets)
        self.store_path = Path(store_path)
        self.static = Path(static_dir) if static_dir else None
        self.cache = Path(cache_dir) / "inputs"
        self.cache.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._store = None
        self._files = {}
        self._paired = {}
        self._index = {}

    # ---------------------------------------------------------------- discovery
    def _open(self):
        if self._store is None:
            self._store = bs.BuildStore(self.store_path, readonly=True)
        return self._store

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
            tmp = self._files_path(product).with_suffix(".tmp")
            tmp.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
            tmp.replace(self._files_path(product))
        except (OSError, ValueError):
            pass
        return files

    def _refresh_files(self, product: str):
        try:
            self._scan_files(product)
        except Exception:  # noqa: BLE001 - 刷新失败就继续用旧清单
            pass
        finally:
            hit = self._files.get(product)
            if hit:
                hit[2].clear()

    def warm(self, products):
        """启动时后台预热文件清单：第一次点进来不要等 23 秒。"""
        for product in products:
            try:
                self._scan_files(product)
            except Exception:  # noqa: BLE001
                continue

    def _files_for(self, product: str, day: str, model: str, split: str):
        out = []
        for path in self._all_files(product):
            if day not in path.name:
                continue
            rel = path.relative_to(self.datasets).as_posix()
            if bs.split_from_rel(rel) != split:
                continue
            if bs.model_from_rel(rel) != model:
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
        with self._lock:
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
        with self._lock:
            try:
                cached = json.loads(path.read_text(encoding="utf-8"))
                if cached.get("version") == LIST_VERSION and cached.get("sig") == sig:
                    return cached
            except (OSError, ValueError):
                pass
            rows = self._scan(product, files)
            payload = {"version": LIST_VERSION, "sig": sig, "files": len(files), "rows": rows}
            tmp = path.with_suffix(".tmp")
            tmp.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
            tmp.replace(path)
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
        with self._lock:
            store = self._open()
            for fi, (rel, path) in enumerate(files):
                index = store.get_file(rel) or {}
                offsets = index.get("offsets") or []
                hashes = index.get("hashes") or []
                tids = index.get("tids") or []
                lines = len(offsets) - 1
                if lines < 1:
                    continue
                pending = {}
                paired_slugs = []
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

    def _sev_counts(self, slugs):
        """已配对样本的 P0–P4 问题数：samples.row 里存了 sv，按 slug 批量取。"""
        out = {}
        with self._lock:
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
        stamp = 0.0
        try:
            stamp = path.stat().st_mtime
        except OSError:
            return None
        try:
            cached = json.loads(out.read_text(encoding="utf-8"))
            if cached.get("_stamp") == stamp:
                cached.pop("_stamp", None)
                return cached
        except (OSError, ValueError):
            pass
        with self._lock:
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
        detail.setdefault("ids", {})
        detail["ids"]["session"] = meta.get("session_id") or meta.get("thread_id") or detail["ids"].get("session", "")
        detail["ids"]["trace"] = meta.get("trace_id") or ""
        detail.setdefault("meta", {})
        detail["meta"]["request_time"] = detail["meta"].get("request_time") or inp.get("request_time") or meta.get("request_time")
        detail["_stamp"] = stamp
        try:
            tmp = out.with_suffix(".tmp")
            tmp.write_text(json.dumps(detail, ensure_ascii=False), encoding="utf-8")
            tmp.replace(out)
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
