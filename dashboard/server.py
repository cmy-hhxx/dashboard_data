#!/usr/bin/env python3
"""Eval dashboard server: static files + build.py payloads on :5001, rebuilt on a timer."""
import gzip
import hashlib
import json
import mimetypes
import os
import re
import shutil
import signal
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import timezone
from email.utils import parsedate_to_datetime
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.join(HERE, "static")
# Per-host build cache (SQLite index, pickles); EVAL_CACHE_DIR moves it off the code tree.
CACHE = os.environ.get("EVAL_CACHE_DIR") or os.path.join(HERE, "cache")
BUILD = os.path.join(HERE, "build.py")
OUTPUTS = [os.path.join(STATIC, n) for n in ("data.json", "samples.json", "samples")]
PORT = int(os.environ.get("PORT", "5001"))
# 10 minutes plus the ~1 minute incremental build keeps the board well inside 30 minutes of the data.
REFRESH = int(os.environ.get("REFRESH_SECONDS", "600"))
# Skip a scheduled build when container memory headroom (excluding reclaimable page cache)
# falls below this threshold so build.py never pushes the cgroup into OOM.  0 disables.
MIN_BUILD_HEADROOM_MB = int(os.environ.get("EVAL_MIN_BUILD_HEADROOM_MB", "4096"))

# Where each product's board lives; the page sends a product that is not built here to its site.
SITES_FILE = os.environ.get("EVAL_SITES_FILE") or os.path.join(HERE, "config", "sites.json")
# Browser assets are served under /v/<content hash>/ with a year-long immutable cache; a deploy
# changes the hash, so clients pick up new code without revalidating every module on every load.
ASSET_DIRS = ("js", "css", "vendor")
ASSET_RE = re.compile(r"^/v/([0-9a-f]{10})/((?:js|css|vendor)/[^?]+)$")
ASSET_REF_RE = re.compile(r'(href|src)="((?:js|css|vendor)/)')

_state = {"last_run": 0, "running": False, "error": "", "skipped": "", "seconds": 0, "build": None}
_lock = threading.Lock()
_builder = None
_ab_builder = None
_lister = None
_prewarm_lock = threading.Lock()
_prewarm_running = False
PREWARM = int(os.environ.get("DETAIL_PREWARM", "30"))
# The gzip validation reads the ISIZE trailer of every .gz once per mtime; cache it
# so a busy page (30+ detail requests) does not re-open the same file each time.
_GZIP_ISIZE = {}
_GZIP_ISIZE_LOCK = threading.Lock()
# Generated JSON responses (input listings) are revalidated by ETag; keep the
# last few gzipped bodies so repeated drills do not recompress 1.6 MB each time.
_RESP_GZIP = {}
_RESP_GZIP_LOCK = threading.Lock()
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
MODEL_RE = re.compile(r"^[a-z][a-z0-9_]*$")
# /ab_samples/<roundId>/<side>-<eq>.json: validated before reaching ABDetailBuilder.
AB_ROUND_RE = re.compile(r"^[0-9A-Za-z][0-9A-Za-z._-]*$")
AB_DETAIL_RE = re.compile(r"^/ab_samples/([^/]+)/((?:before|after|candidate_model_\d+)-\d+|\d+)\.json$")
GPT_DETAIL_RE = re.compile(r"^/gpt_samples/([^/]+)/([0-9A-Za-z_-]+)\.json$")
# /bench/<product>.json: serves schema:1 golden/bad slices or schema:2 dynamic bench views/fields.
BENCH_RE = re.compile(r"^/bench/([a-z][a-z0-9_]*)\.json$")
BENCH_CASE_RE = re.compile(r"^/bench_case/([a-z][a-z0-9_]*)/([a-z0-9_]+)/([^/]+)\.json$")
BENCH_EXPORT_RE = re.compile(r"^/bench_export/([a-z][a-z0-9_]*)\.jsonl$")
# /api/recall/: uncapped paginated session recall; /api/recall_slice*, /api/recall_lookup*, /api/input_slice*: bounded (<= 500).
RECALL_RE = re.compile(r"^/api/recall/([a-z][a-z0-9_]*)\.json$")
RECALL_SLICE_RE = re.compile(r"^/api/recall_slice/([a-z][a-z0-9_]*)\.json$")
RECALL_LOOKUP_RE = re.compile(r"^/api/recall_lookup/([a-z][a-z0-9_]*)\.json$")
INPUT_SLICE_RE = re.compile(r"^/api/input_slice/([a-z][a-z0-9_]*)\.json$")
FIELD_RE = re.compile(r"^/api/field/([a-z][a-z0-9_]*)\.json$")
TREND_NODE_RE = re.compile(r"^/api/trend/([a-z][a-z0-9_]*)\.json$")
_BENCH_CACHE = {}
_BENCH_LOCK = threading.Lock()
_BENCH_INDEX_CACHE = {}
_BENCH_INDEX_LOCK = threading.Lock()
_TREND_NODE_CACHE = {}
_TREND_NODE_LOCK = threading.Lock()
_TRACE_REFS_CACHE = {}
_TRACE_REFS_LOCK = threading.Lock()
_RECALL_STORE = None
_NO_PROXY_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def _bench_upstream():
    return (os.environ.get("EVAL_BENCH_UPSTREAM") or "").strip().rstrip("/")


def _data_upstream():
    return (os.environ.get("EVAL_DATA_UPSTREAM") or "").strip().rstrip("/")


def _upstream_request(base_url, path, method="GET", body=None, headers=None, timeout=12):
    """Fetch from an optional upstream preview host bypassing local proxy env vars with brief retries."""
    if not base_url:
        return None
    hdrs = {"Accept-Encoding": "identity"}
    if headers:
        hdrs.update(headers)
    url = f"{base_url}{path}"
    for attempt in range(3):
        req = urllib.request.Request(url, data=body, headers=hdrs, method=method)
        try:
            with _NO_PROXY_OPENER.open(req, timeout=timeout) as resp:
                ctype = resp.headers.get("Content-Type") or "application/json; charset=utf-8"
                return resp.status, ctype, resp.read()
        except urllib.error.HTTPError as exc:
            try:
                raw = exc.read()
            except Exception:  # noqa: BLE001
                raw = b""
            return exc.code, (exc.headers.get("Content-Type") if exc.headers else None) or "application/json", raw
        except Exception:  # noqa: BLE001
            if attempt < 2:
                time.sleep(0.15 * (attempt + 1))
    return None


def recall_entry(product):
    """Cached server-side recall index for ``samples-<product>.json`` (+ labels)."""
    global _RECALL_STORE
    if _RECALL_STORE is None:
        import recall_index
        _RECALL_STORE = recall_index.RecallStore()
    return _RECALL_STORE.get(STATIC, product)


def prewarm_details():
    """Make the first page of each product instant; arbitrary details stay lazy."""
    global _prewarm_running
    if not _builder or PREWARM <= 0:
        return
    with _prewarm_lock:
        if _prewarm_running:
            return
        _prewarm_running = True
    try:
        # build.py writes this tiny list; parsing the 20 MB samples index here
        # blocks the request threads on the GIL for a few hundred ms after every build.
        try:
            with open(os.path.join(CACHE, "prewarm.json"), encoding="utf-8") as fh:
                prewarm = json.load(fh)
        except (OSError, ValueError):
            prewarm = {}
        import build as _build
        for product in sorted(_build.ENABLED):
            slugs = [slug for slug in (prewarm.get(product) or []) if slug]
            if not slugs:
                path = os.path.join(STATIC, f"samples-{product}.json")
                try:
                    with open(path, encoding="utf-8") as fh:
                        slugs = _build.prewarm_picks(json.load(fh)["products"][product]["rows"])
                except (OSError, ValueError, KeyError):
                    continue
            slugs = slugs[:PREWARM + _build.PREWARM_RECENT]
            if slugs:
                made = _builder.prewarm(slugs)
                print(f"[serve] prewarmed {made}/{len(slugs)} {product} details", flush=True)
    finally:
        with _prewarm_lock:
            _prewarm_running = False


def prewarm_input_listings():
    """Warm the latest listing per model/split so the first 详情 click is instant."""
    if not _lister:
        return
    try:
        import build as _build
        _lister.prewarm_listings(sorted(_build.ENABLED))
    except Exception as exc:  # noqa: BLE001 - listing prewarm is best effort
        print(f"[serve] input listing prewarm failed: {exc}", flush=True)


def prewarm_recall():
    """Warm sorted/bucketed recall_index tables so date/attr/clu galaxy clicks are instant."""
    try:
        for product in sorted(_products()):
            recall_entry(product)
    except Exception as exc:  # noqa: BLE001 - recall prewarm is best effort
        print(f"[serve] recall prewarm failed: {exc}", flush=True)


def _products():
    import build as _build
    return _build.ENABLED


def warm_input_lister():
    if not _lister:
        return
    try:
        import build as _build
        _lister.warm(sorted(_build.ENABLED))
        prewarm_input_listings()
    except Exception as exc:  # noqa: BLE001
        print(f"[serve] input lister warm failed: {exc}", flush=True)


def _check_build_headroom(min_mb=None, headroom_bytes=None):
    """Return a skip reason when container memory headroom is too low for a build."""
    limit_mb = MIN_BUILD_HEADROOM_MB if min_mb is None else int(min_mb)
    if limit_mb <= 0:
        return None
    if headroom_bytes is None:
        import build as _build
        headroom_bytes = _build.cgroup_headroom()
    if headroom_bytes is None:
        return None
    headroom_mb = headroom_bytes >> 20
    if headroom_mb < limit_mb:
        return f"low memory headroom ({headroom_mb}MB < {limit_mb}MB)"
    return None


def refresh_once():
    """Rebuild data.json, samples.json and samples/ from the datasets in one pass."""
    skip_reason = _check_build_headroom()
    if skip_reason:
        _state["skipped"] = skip_reason
        print(f"[refresh] skipped: {skip_reason}", flush=True)
        return
    with _lock:
        if _state["running"]:
            return
        _state["running"] = True
        _state["skipped"] = ""
    started = time.time()
    try:
        # A data-changing rebuild takes 30-60s.  Keep it below the HTTP request
        # threads so pages stay responsive while it runs.
        nice = shutil.which("nice")
        cmd = ([nice, "-n", "10"] if nice else []) + [sys.executable, BUILD, "--keep-on-empty"]
        # Own process group: a timeout must also stop the build's worker pool,
        # which would otherwise keep running and holding cache/build.sqlite3.
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                                cwd=HERE, start_new_session=True)
        try:
            # 冷构建要按样本顺序读输入行（问财 RSI 约 25 GB），ceph-fuse 上限 ~15 MB/s；
            # 30 分钟会被误杀。可用 EVAL_BUILD_TIMEOUT 覆盖。
            stdout, stderr = proc.communicate(timeout=int(os.environ.get("EVAL_BUILD_TIMEOUT", "5400")))
        except subprocess.TimeoutExpired:
            os.killpg(proc.pid, signal.SIGKILL)
            proc.communicate()
            raise
        line = (stdout.strip().splitlines() or [""])[-1]
        if proc.returncode == 0:
            _state["error"] = ""
            try:
                _state["build"] = json.loads(line)
            except ValueError:
                _state["build"] = line[-500:]
            print("[refresh]", line, flush=True)
            # A reused build did not rewrite the payloads, so the first-page details
            # are still the ones warmed last time; skip loading the 28 MB index again.
            if not isinstance(_state["build"], dict) or not _state["build"].get("reused"):
                threading.Thread(target=prewarm_details, daemon=True).start()
                threading.Thread(target=prewarm_input_listings, daemon=True).start()
                threading.Thread(target=prewarm_recall, daemon=True).start()
                if _ab_builder is not None:
                    threading.Thread(target=_ab_builder.warm, daemon=True).start()
        else:
            _state["error"] = (stderr or line or "")[-500:]
            print("[refresh] failed:", _state["error"], flush=True)
    except Exception as exc:  # noqa: BLE001 - keep serving the last good build
        _state["error"] = str(exc)
        print("[refresh] error:", exc, flush=True)
    finally:
        _state["seconds"] = round(time.time() - started, 1)
        _state["last_run"] = time.time()
        _state["running"] = False


def scheduler(delay):
    time.sleep(delay)
    while True:
        try:
            refresh_once()
        except Exception as exc:  # noqa: BLE001
            print("[refresh] loop error:", exc, flush=True)
        time.sleep(REFRESH)


def bench_payload(product):
    """The Bench list written by build.py, re-read only when the file changes."""
    path = os.path.join(STATIC, f"bench-{product}.json")
    try:
        st = os.stat(path)
    except OSError:
        return None
    key = (st.st_mtime_ns, st.st_size)
    with _BENCH_LOCK:
        hit = _BENCH_CACHE.get(product)
        if hit and hit[0] == key:
            return hit[1]
    try:
        with open(path, encoding="utf-8") as fh:
            payload = json.load(fh)
    except (OSError, ValueError):
        return None
    with _BENCH_LOCK:
        if len(_BENCH_CACHE) > 4:
            _BENCH_CACHE.clear()
        _BENCH_CACHE[product] = (key, payload)
    return payload


def bench_index(product):
    """Cached server-side compact Bench case index with O(1) trace locator lookup."""
    path = os.path.join(STATIC, f"bench_index-{product}.json")
    try:
        st = os.stat(path)
    except OSError:
        return None
    key = (st.st_mtime_ns, st.st_size)
    with _BENCH_INDEX_LOCK:
        hit = _BENCH_INDEX_CACHE.get(product)
        if hit and hit[0] == key:
            return hit[1]
    try:
        with open(path, encoding="utf-8") as fh:
            idx = json.load(fh)
    except (OSError, ValueError):
        return None
    by_key = {}
    for model, rows in (idx.get("models") or {}).items():
        for r in rows or []:
            tid = r.get("trace_id")
            if tid:
                by_key[(model, tid)] = r
    entry = {
        "key": key,
        "etag": f'"{st.st_mtime_ns:x}-{st.st_size:x}"',
        "models": idx.get("models") or {},
        "by_key": by_key,
    }
    with _BENCH_INDEX_LOCK:
        if len(_BENCH_INDEX_CACHE) > 4:
            _BENCH_INDEX_CACHE.clear()
        _BENCH_INDEX_CACHE[product] = (key, entry)
    return entry


def trend_node_index(product):
    """Mtime-cached per-node index of ``trends-<product>.json`` for on-demand cell trend queries."""
    path = os.path.join(STATIC, f"trends-{product}.json")
    try:
        st = os.stat(path)
    except OSError:
        return None
    key = (st.st_mtime_ns, st.st_size)
    with _TREND_NODE_LOCK:
        hit = _TREND_NODE_CACHE.get(product)
        if hit and hit[0] == key:
            return hit[1]
    try:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        return None
    nodes = data.get("nodes") or []
    by_node = {}
    for row in data.get("cells") or ():
        ni = row[2]
        if 0 <= ni < len(nodes):
            code = nodes[ni]
            # Remap node index to 0 in the single-node slice so frontend trendSeries works unchanged.
            by_node.setdefault(code, []).append([row[0], row[1], 0, *row[3:]])
    entry = {
        "key": key,
        "etag": f'"tn-{st.st_mtime_ns:x}-{st.st_size:x}"',
        "meta": {
            "schema": data.get("schema", 2),
            "generated_at": data.get("generated_at"),
            "product": data.get("product") or product,
            "releases": data.get("releases") or [],
            "dates": data.get("dates") or [],
            "uts": data.get("uts") or [],
            "models": data.get("models") or [],
            "scenes": data.get("scenes") or [],
            "base": data.get("base") or [],
        },
        "by_node": by_node,
    }
    with _TREND_NODE_LOCK:
        if len(_TREND_NODE_CACHE) > 2:
            _TREND_NODE_CACHE.clear()
        _TREND_NODE_CACHE[product] = (key, entry)
    return entry


def trace_refs_index(product):
    """Mtime-cached ``(date, level) -> refs`` index from server-only ``trace_refs-<product>.json``."""
    path = os.path.join(STATIC, f"trace_refs-{product}.json")
    try:
        st = os.stat(path)
    except OSError:
        return None
    key = (st.st_mtime_ns, st.st_size)
    with _TRACE_REFS_LOCK:
        hit = _TRACE_REFS_CACHE.get(product)
        if hit and hit[0] == key:
            return hit[1]
    try:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        return None
    dates = data.get("dates") or []
    levels = data.get("levels") or ["P0", "P1", "P2", "P3", "P4", "none"]
    by_key = {}
    for ref in data.get("refs") or ():
        if not isinstance(ref, list) or len(ref) < 4:
            continue
        di, slug, turn, li = ref[0], ref[1], ref[2], ref[3]
        tid = ref[4] if len(ref) > 4 else None
        if 0 <= di < len(dates) and 0 <= li < len(levels):
            by_key.setdefault((dates[di], levels[li]), []).append((slug, turn, li, tid))
    entry = {
        "key": key,
        "etag": f'"tr-{st.st_mtime_ns:x}-{st.st_size:x}"',
        "generated_at": data.get("generated_at"),
        "by_key": by_key,
    }
    with _TRACE_REFS_LOCK:
        if len(_TRACE_REFS_CACHE) > 2:
            _TRACE_REFS_CACHE.clear()
        _TRACE_REFS_CACHE[product] = (key, entry)
    return entry

class Handler(SimpleHTTPRequestHandler):
    # HTTP/1.1 keeps the connection alive for the many sample-detail requests
    # opened when a multi-trace session is selected.  Idle keep-alive sockets
    # close after 30s so a stalled client cannot pin a request thread forever.
    protocol_version = "HTTP/1.1"
    timeout = 30

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=STATIC, **kwargs)

    def end_headers(self):
        # Data payloads revalidate (a 304 still saves the body); generated details and
        # versioned browser assets may be reused briefly.  healthz is never cached.
        policy = getattr(self, "_cache_policy", None)
        if not policy:
            policy = "no-store" if self.path.startswith("/healthz") else "no-cache"
        self.send_header("Cache-Control", policy)
        if getattr(self, "_cors_any", False):
            self.send_header("Access-Control-Allow-Origin", "*")
        super().end_headers()

    def _send_body(self, status, body, ctype, etag=None, headers=None):
        # HTTP/1.1 keep-alive: without Content-Length the client waits for a body
        # that never ends, which is how a failed detail used to hang the page.
        # Generated JSON has no precompressed twin, so compress it here; the
        # sample details are the largest payloads the page pulls.
        if status >= 400:
            self._cache_policy = "no-store"
        if etag:
            inm = self.headers.get("If-None-Match")
            if inm and etag in {part.strip() for part in inm.split(",")}:
                self.send_response(304)
                self.send_header("ETag", etag)
                self.send_header("Vary", "Accept-Encoding")
                self.end_headers()
                return
        encoding = None
        if len(body) >= 1024 and "gzip" in self.headers.get("Accept-Encoding", ""):
            key = (etag, len(body)) if etag else None
            cached = None
            if key:
                with _RESP_GZIP_LOCK:
                    cached = _RESP_GZIP.get(key)
            if cached is not None:
                body = cached
            else:
                body = gzip.compress(body, 6)
                if key:
                    with _RESP_GZIP_LOCK:
                        if len(_RESP_GZIP) > 48:
                            _RESP_GZIP.clear()
                        _RESP_GZIP[key] = body
            encoding = "gzip"
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Vary", "Accept-Encoding")
        if encoding:
            self.send_header("Content-Encoding", encoding)
        if etag:
            self.send_header("ETag", etag)
        if headers:
            for k, v in headers:
                self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def list_directory(self, path):
        # There is no user-facing directory index; a crawler or typo should not
        # build a 10k-entry HTML listing of the sample-detail tree.
        self.send_error(404, "File not found")
        return None

    def _serve_inputs(self, path_only):
        """评测输入清单（按天/模型现读）与单条输入的详情。"""
        query = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        product = (query.get("product") or [""])[0]
        day = (query.get("d") or [""])[0]
        model = (query.get("m") or [""])[0]
        split = (query.get("sp") or ["daily"])[0]
        if product not in _products() or not DATE_RE.match(day) or not MODEL_RE.match(model) or split not in ("daily", "lost"):
            self._send_body(400, b'{"error":"bad params"}', "application/json")
            return True
        if path_only == "/inputs.json":
            try:
                payload = _lister.listing(product, day, model, split) if _lister else None
            except Exception as exc:  # noqa: BLE001 - 读不到就告诉前端，别挂页面
                print(f"[serve] inputs {product} {day} {model}: {exc}", flush=True)
                self._send_body(500, b'{"error":"input listing failed"}', "application/json")
                return True
            if (not payload or not (payload.get("rows") or [])) and _data_upstream():
                if self._proxy_data_upstream():
                    return True
            if payload is None:
                self._send_body(404, b'{"error":"input listing unavailable"}', "application/json")
                return True
            body = json.dumps(payload, ensure_ascii=False).encode()
            sig = hashlib.sha1(json.dumps(payload.get("sig"), separators=(",", ":")).encode()).hexdigest()[:20]
            self._send_body(200, body, "application/json", etag=f'"inputs-{sig}"')
            return True
        ref = urllib.parse.unquote(path_only[len("/inputs/"):-len(".json")])
        try:
            detail = _lister.detail(product, day, model, split, ref) if _lister else None
        except Exception as exc:  # noqa: BLE001
            print(f"[serve] input detail {product} {day} {model} {ref}: {exc}", flush=True)
            detail = None
        if detail is None:
            if _data_upstream() and self._proxy_data_upstream():
                return True
            self._send_body(404, b'{"error":"input detail unavailable"}', "application/json")
            return True
        self._send_body(200, json.dumps(detail, ensure_ascii=False).encode(), "application/json")
        return True

    def _encoded_matches_source(self, path, encoded, encoding):
        """Reject a compressed twin that was not built from the current source.

        mtime alone misses equal-timestamp copies (e.g. a copied static tree);
        for gzip the ISIZE trailer also pins the uncompressed size.
        """
        try:
            enc_stat = os.stat(encoded)
            src_stat = os.stat(path)
            if enc_stat.st_mtime + 1 < src_stat.st_mtime:
                return False
            if encoding != "gzip":
                return True
            key = (encoded, enc_stat.st_mtime_ns, enc_stat.st_size)
            with _GZIP_ISIZE_LOCK:
                size = _GZIP_ISIZE.get(key)
            if size is None:
                with open(encoded, "rb") as fh:
                    fh.seek(-4, os.SEEK_END)
                    size = int.from_bytes(fh.read(4), "little")
                with _GZIP_ISIZE_LOCK:
                    if len(_GZIP_ISIZE) > 512:
                        _GZIP_ISIZE.clear()
                    _GZIP_ISIZE[key] = size
            return size == src_stat.st_size % (1 << 32)
        except OSError:
            return False

    def _serve_encoded(self, path, encoding):
        """Serve ``path.br`` / ``path.gz`` with ETag/304; False when unavailable."""
        suffix = ".br" if encoding == "br" else ".gz"
        encoded = path + suffix
        try:
            stat = os.stat(encoded)
            source = os.stat(path)
        except OSError:
            return False
        if not self._encoded_matches_source(path, encoded, encoding):
            return False
        last_modified = max(stat.st_mtime, source.st_mtime)
        etag = f'"{int(last_modified * 1000)}-{stat.st_size}-{encoding}"'
        headers = [
            ("Vary", "Accept-Encoding"),
            ("ETag", etag),
            ("Last-Modified", self.date_time_string(last_modified)),
        ]
        cache = "304" if self._not_modified(etag, last_modified) else "200"
        self.send_response(304 if cache == "304" else 200)
        for key, value in headers:
            self.send_header(key, value)
        if cache == "304":
            self.end_headers()
            return True
        ctype = mimetypes.guess_type(path)[0] or "application/octet-stream"
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Encoding", encoding)
        self.send_header("Content-Length", str(stat.st_size))
        self.end_headers()
        with open(encoded, "rb") as fh:
            shutil.copyfileobj(fh, self.wfile)
        return True

    def _not_modified(self, etag, last_modified):
        inm = self.headers.get("If-None-Match")
        if inm and etag in {part.strip() for part in inm.split(",")}:
            return True
        since = self.headers.get("If-Modified-Since")
        if since:
            try:
                parsed = parsedate_to_datetime(since)
                if parsed.tzinfo is None:
                    parsed = parsed.replace(tzinfo=timezone.utc)
                return int(last_modified) <= int(parsed.timestamp())
            except (TypeError, ValueError, OverflowError):
                return False
        return False

    def handle_one_request(self):
        started = time.time()
        # Per request, for every method: a HEAD on a keep-alive connection must not
        # inherit the policy the previous GET chose.
        self._cache_policy = None
        self._cors_any = False
        try:
            super().handle_one_request()
        finally:
            elapsed = time.time() - started
            if elapsed >= 2.0:
                sys.stderr.write(f"[slow] {elapsed:.1f}s {getattr(self, 'command', '?')} {self.path}\n")

    def _proxy_bench_upstream(self, path_override=None):
        res = _upstream_request(_bench_upstream(), path_override or self.path, timeout=12)
        if not res or res[0] >= 400:
            return False
        status, ctype, raw = res
        self._cache_policy = "no-cache"
        self._send_body(status, raw, ctype)
        return True

    def _proxy_data_upstream(self, path_override=None):
        res = _upstream_request(_data_upstream(), path_override or self.path, timeout=12)
        if not res or res[0] >= 400:
            return False
        status, ctype, raw = res
        self._cache_policy = "no-cache"
        self._send_body(status, raw, ctype)
        return True

    def _serve_bench_export(self, path_only):
        """Export filtered dynamic Bench cases as a flat 1-case-per-line JSONL file."""
        match = BENCH_EXPORT_RE.match(path_only)
        if not match:
            return False
        product = match.group(1)
        parsed = urllib.parse.urlparse(self.path)
        query = urllib.parse.parse_qs(parsed.query)
        q_flat = {k: vals[0] for k, vals in query.items() if vals}
        model = q_flat.get("model") or ""
        tier = q_flat.get("tier") or ""

        import bench_dynamic
        payload = bench_payload(product)
        idx = bench_index(product)
        jsonl_bytes = None

        if payload and payload.get("schema") == 2 and idx:
            rows = (idx["models"].get(model) or []) if model else [r for lst in idx["models"].values() for r in lst]
            long_tok = int(((payload.get("manifest") or {}).get("params") or {}).get("long_tokens") or 65536)
            matched = [r for r in rows if bench_dynamic.case_matches_query(r, q_flat, long_tok)]
            sorted_rows = bench_dynamic.sort_case_rows(matched, q_flat.get("sort") or "rank")
            import pg_backend
            if pg_backend.is_pg_enabled() or any(
                isinstance(r.get("loc"), (list, tuple)) and r["loc"] and r["loc"][0] == "pg"
                for r in sorted_rows[:1]
            ):
                jsonl_bytes = pg_backend.pg_export_bench_jsonl(sorted_rows, summary=payload)
            else:
                from build import default_datasets
                jsonl_bytes = bench_dynamic.export_bench_jsonl(default_datasets(), sorted_rows, summary=payload)
        else:
            up = _bench_upstream()
            if up:
                res = _upstream_request(up, self.path, timeout=15)
                if res and res[0] == 200 and res[2]:
                    jsonl_bytes = res[2]
                else:
                    sum_res = _upstream_request(up, f"/bench/{product}.json?view=summary", timeout=15)
                    fld_qs = urllib.parse.urlencode([(k, v) for k, vals in query.items() if k != "view" and k != "sort" for v in vals] + [("view", "fields")])
                    fld_res = _upstream_request(up, f"/bench/{product}.json?{fld_qs}", timeout=20)
                    if fld_res and fld_res[0] == 200:
                        try:
                            summary = json.loads(sum_res[2].decode("utf-8")) if (sum_res and sum_res[0] == 200) else {}
                            fld_data = json.loads(fld_res[2].decode("utf-8"))
                            cases = fld_data.get("cases") or []
                            try:
                                sorted_rows = bench_dynamic.sort_case_rows(cases, q_flat.get("sort") or "rank")
                            except Exception:  # noqa: BLE001
                                sorted_rows = cases
                            jsonl_bytes = bench_dynamic.export_bench_jsonl(None, sorted_rows, summary=summary)
                        except (ValueError, UnicodeDecodeError, TypeError) as exc:
                            print(f"[serve] bench export upstream fallback failed: {exc}", flush=True)
                            jsonl_bytes = None

        if jsonl_bytes is None:
            self._send_body(404, b'{"error":"bench export unavailable"}', "application/json")
            return True

        parts = ["bench", product]
        if model:
            parts.append(re.sub(r"[^a-zA-Z0-9_-]", "", model))
        if tier:
            parts.append(("long" if q_flat.get("long") == "1" else "std") + re.sub(r"[^a-zA-Z0-9_-]", "", tier))
        fname = "-".join(parts) + ".jsonl"
        self._cache_policy = "no-cache"
        self._send_body(
            200,
            jsonl_bytes,
            "application/x-ndjson; charset=utf-8",
            headers=[("Content-Disposition", f'attachment; filename="{fname}"')],
        )
        return True

    def _serve_bench(self, path_only):
        """Serve Bench payloads: schema:2 dynamic bench views/fields or schema:1 golden/bad slices."""
        match = BENCH_RE.match(path_only)
        if not match:
            return False
        product = match.group(1)
        payload = bench_payload(product)
        if not payload:
            if self._proxy_bench_upstream():
                return True
            self._send_body(404, b'{"error":"bench unavailable"}', "application/json")
            return True
        query = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        if payload.get("schema") == 2:
            view = (query.get("view") or ["summary"])[0]
            self._cache_policy = "no-cache"
            if view == "summary":
                body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode()
                self._send_body(200, body, "application/json; charset=utf-8")
                return True
            if view not in ("fields", "cases"):
                self._send_body(400, b'{"error":"unknown bench view"}', "application/json")
                return True
            idx = bench_index(product)
            if not idx:
                self._send_body(404, b'{"error":"bench index unavailable"}', "application/json")
                return True
            import bench_dynamic
            q_flat = {k: vals[0] for k, vals in query.items() if vals}
            model = q_flat.get("model") or ""
            rows = (idx["models"].get(model) or []) if model else [r for lst in idx["models"].values() for r in lst]
            long_tok = int(((payload.get("manifest") or {}).get("params") or {}).get("long_tokens") or 65536)
            matched = [r for r in rows if bench_dynamic.case_matches_query(r, q_flat, long_tok)]
            if view == "fields":
                public_rows = [bench_dynamic.public_case_row(r) for r in matched]
                body = json.dumps({"schema": 2, "product": product, "total": len(public_rows), "cases": public_rows},
                                  ensure_ascii=False, separators=(",", ":")).encode()
                self._send_body(200, body, "application/json; charset=utf-8", etag=f"{idx['etag']}-{hashlib.sha1(self.path.encode()).hexdigest()[:8]}")
                return True
            sorted_rows = bench_dynamic.sort_case_rows(matched, q_flat.get("sort") or "rank")
            try:
                size = max(1, min(100, int(q_flat.get("size") or "25")))
                page = max(1, int(q_flat.get("page") or "1"))
            except ValueError:
                size, page = 25, 1
            total = len(sorted_rows)
            pages = max(1, (total + size - 1) // size)
            page = min(page, pages)
            start = (page - 1) * size
            body = json.dumps({
                "schema": 2, "product": product, "page": page, "size": size, "total": total, "pages": pages,
                "cases": [bench_dynamic.public_case_row(r) for r in sorted_rows[start:start + size]],
            }, ensure_ascii=False, separators=(",", ":")).encode()
            self._send_body(200, body, "application/json; charset=utf-8")
            return True

        kind = (query.get("kind") or ["golden"])[0]
        rows = (payload.get("rows") or {}).get(kind)
        if rows is None:
            self._send_body(400, b'{"error":"unknown kind"}', "application/json")
            return True
        sev = (query.get("sev") or [""])[0]
        if sev:
            rows = [row for row in rows if row.get("w") == sev]
        try:
            size = max(1, min(100, int((query.get("size") or ["25"])[0])))
            page = max(1, int((query.get("page") or ["1"])[0]))
        except ValueError:
            size, page = 25, 1
        total = len(rows)
        pages = max(1, (total + size - 1) // size)
        page = min(page, pages)
        start = (page - 1) * size
        body = json.dumps({
            "product": product, "kind": kind, "page": page, "size": size,
            "total": total, "pages": pages, "generated_at": payload.get("generated_at"),
            "kinds": payload.get("kinds") or {}, "rows": rows[start:start + size],
        }, ensure_ascii=False, separators=(",", ":")).encode()
        self._cache_policy = "no-cache"
        self._send_body(200, body, "application/json")
        return True

    def _serve_bench_case(self, path_only):
        """Lazy single-line JSONL seek for one dynamic Bench case scene."""
        match = BENCH_CASE_RE.match(path_only)
        if not match:
            return False
        product, model = match.group(1), match.group(2)
        trace_id = urllib.parse.unquote(match.group(3))
        idx = bench_index(product)
        row = idx["by_key"].get((model, trace_id)) if idx else None
        if row is None:
            if self._proxy_bench_upstream():
                return True
            self._send_body(404, b'{"error":"bench case not found"}', "application/json")
            return True
        import bench_dynamic
        import pg_backend
        loc = row.get("loc")
        if pg_backend.is_pg_enabled() or (isinstance(loc, (list, tuple)) and loc and loc[0] == "pg"):
            detail = pg_backend.pg_load_bench_case(row)
        else:
            from build import default_datasets
            detail = bench_dynamic.load_bench_case(default_datasets(), row)
        if detail is None:
            self._send_body(404, b'{"error":"bench case unreadable"}', "application/json")
            return True
        self._cache_policy = "public, max-age=120"
        body = json.dumps(detail, ensure_ascii=False, separators=(",", ":")).encode()
        self._send_body(200, body, "application/json; charset=utf-8")
        return True

    @staticmethod
    def _cap_recall_payload(data, cap=500):
        if not isinstance(data, dict):
            return data
        if "rows" in data and isinstance(data["rows"], list):
            if int(data.get("cap") or cap) > cap or len(data["rows"]) > cap:
                data["rows"] = data["rows"][:cap]
                data["cap"] = cap
                data["recalled"] = min(int(data.get("recalled") or len(data["rows"])), cap)
                data["capped"] = int(data.get("matched") or data["recalled"]) > cap
        elif "groups" in data and isinstance(data["groups"], list):
            total_items = sum(len(g.get("items") or []) for g in data["groups"])
            if int(data.get("cap") or cap) > cap or total_items > cap:
                remaining = cap
                for g in data["groups"]:
                    items = g.get("items") or []
                    take = min(len(items), remaining)
                    g["items"] = items[:take]
                    remaining -= take
                data["recalled"] = sum(len(g.get("items") or []) for g in data["groups"])
                data["cap"] = cap
                data["capped"] = int(data.get("total") or data["recalled"]) > data["recalled"]
        return data

    def _upstream_attr_fallback(self, up, product, query, cap=500):
        """Build bounded (<=500) model/sev/mech galaxy groups from upstream paginated /api/recall/."""
        model = query.get("model") or ""
        sev = query.get("sev") or ""
        mech = query.get("mech") or ""
        sessions = []
        matched_total = 0
        for pg in range(1, 6):
            params = [("size", "100"), ("cap", str(cap)), ("facets", "0"), ("page", str(pg))]
            if model:
                params.append(("model", model))
            if sev:
                params.append(("w", sev))
            if mech:
                params.append(("mech", mech))
            res = _upstream_request(up, f"/api/recall/{product}.json?{urllib.parse.urlencode(params)}", timeout=10)
            if not res or res[0] != 200:
                break
            try:
                page_data = json.loads(res[2].decode("utf-8"))
            except (ValueError, UnicodeDecodeError):
                break
            matched_total = int(page_data.get("matched") or matched_total)
            rows = page_data.get("rows") or []
            if not rows:
                break
            sessions.extend(rows)
            if len(sessions) >= cap or pg >= int(page_data.get("pages") or 1):
                break

        sev_map = {"P0": 0, "P1": 1, "P2": 2, "P3": 3, "P4": 4}
        parts = [0, 0, 0, 0, 0, 0]
        grouped = {}
        for sess in sessions[:cap]:
            slug = ((sess.get("rows") or [{}])[0].get("s")) or sess.get("s") or sess.get("key") or ""
            w = sess.get("w") or "none"
            parts[sev_map.get(w, 5)] += 1
            item = {
                "s": slug,
                "k": sess.get("key") or slug,
                "m": sess.get("m") or "",
                "sp": sess.get("sp") or "daily",
                "q": sess.get("q") or "",
                "w": w,
                "n": int(sess.get("n") or 0),
                "d": sess.get("d") or "",
                "sc": sess.get("sc") or sess.get("task") or "",
            }
            if sev and mech:
                gkey = sess.get("sc") or sess.get("task") or "~un"
            elif sev:
                gkey = sess.get("sc") or sess.get("task") or mech or "~un"
            else:
                gkey = w if w in sev_map else "none"
            grouped.setdefault(gkey, []).append(item)

        groups = [
            {"key": k, "total": len(items), "items": items}
            for k, items in sorted(grouped.items(), key=lambda kv: -len(kv[1]))
        ]
        recalled = len(sessions[:cap])
        total = max(matched_total, recalled)
        return {
            "product": product,
            "total": total,
            "recalled": recalled,
            "cap": cap,
            "capped": total > recalled,
            "parts": parts,
            "groups": groups,
        }

    def _serve_recall(self, path_only):
        """Serve uncapped paginated session recall and bounded (<= 500) sliced galaxy/trend/session queries."""
        m_list = RECALL_RE.match(path_only)
        m_slice = None if m_list else RECALL_SLICE_RE.match(path_only)
        if not m_list and not m_slice:
            return False
        product = (m_list or m_slice).group(1)
        parsed = urllib.parse.urlparse(self.path)
        query = {k: vals[0] for k, vals in urllib.parse.parse_qs(parsed.query).items() if vals}
        entry = recall_entry(product)
        up = _data_upstream()
        if up and (entry is None or len(entry.rows) <= 5):
            res = _upstream_request(up, self.path, timeout=25)
            if res and res[0] == 200:
                try:
                    up_data = json.loads(res[2].decode("utf-8"))
                except (ValueError, UnicodeDecodeError):
                    up_data = None
                if isinstance(up_data, dict):
                    if m_slice:
                        if query.get("mode") == "galaxy" and query.get("card") == "attr" and (query.get("model") or query.get("sev") or query.get("mech")) and not (up_data.get("groups") or []):
                            up_data = self._upstream_attr_fallback(up, product, query, cap=500)
                        up_data = self._cap_recall_payload(up_data, cap=500)
                    self._cache_policy = "no-cache"
                    body = json.dumps(up_data, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
                    self._send_body(200, body, "application/json; charset=utf-8")
                    return True
        if entry is None:
            self._send_body(404, b'{"error":"recall index unavailable"}', "application/json")
            return True
        mode = "" if m_list else (query.get("mode") or "")
        if not m_list and mode not in ("galaxy", "trend", "session", "trace_sev"):
            self._send_body(400, b'{"error":"unknown recall slice mode"}', "application/json")
            return True
        self._cache_policy = "no-cache"
        qhash = hashlib.sha1(self.path.encode("utf-8")).hexdigest()[:12]
        etag = f'{entry.etag[:-1]}-{qhash}"'
        inm = self.headers.get("If-None-Match")
        if inm and etag in {part.strip() for part in inm.split(",")}:
            self.send_response(304)
            self.send_header("ETag", etag)
            self.send_header("Vary", "Accept-Encoding")
            self.end_headers()
            return True
        if m_list:
            result = entry.query_sessions(query)
        elif mode == "galaxy":
            result = entry.query_galaxy(query)
        elif mode == "trend":
            result = entry.query_trend(query)
        elif mode == "trace_sev":
            result = self._query_trace_sev(product, entry, query)
        else:
            result = entry.query_session(query)
        body = json.dumps(result, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self._send_body(200, body, "application/json; charset=utf-8", etag=etag)
        return True

    @staticmethod
    def _query_trace_sev(product, entry, query):
        """Resolve per-trace severity sample drawer items without shipping refs[] in trends-<p>.json."""
        date = query.get("date") or ""
        level = query.get("level") or ""
        try:
            cap = max(1, min(500, int(query.get("cap") or "500")))
        except ValueError:
            cap = 500
        levels = ("P0", "P1", "P2", "P3", "P4", "none")
        li = levels.index(level) if level in levels else -1
        items = []
        total = 0
        refs_idx = trace_refs_index(product)
        if refs_idx is not None and date and li >= 0:
            refs = refs_idx["by_key"].get((date, level), ())
            total = len(refs)
            for slug, turn, sev_i, tid in refs[:cap]:
                row = entry.by_slug.get(slug)
                if not row:
                    continue
                items.append({
                    "s": slug,
                    "w": sev_i,
                    "n": 0,
                    "q": f"{row.get('q') or '（无提问）'} · 第 {int(turn) + 1} 轮",
                    "m": row.get("m") or "",
                    "sp": row.get("sp") or "",
                    "d": row.get("d") or date,
                    "trace": tid,
                    "turn": int(turn),
                })
        elif date and li >= 0:
            matched = [r for r in entry.by_date.get(date, ()) if (r.get("w") or "none") == level]
            total = len(matched)
            for row in matched[:cap]:
                items.append({
                    "s": row.get("s") or "",
                    "w": li,
                    "n": 0,
                    "q": f"{row.get('q') or '（无提问）'} · 第 1 轮",
                    "m": row.get("m") or "",
                    "sp": row.get("sp") or "",
                    "d": row.get("d") or date,
                    "trace": row.get("tid"),
                    "turn": 0,
                })
        return {
            "product": product,
            "generated_at": entry.generated_at,
            "date": date,
            "level": level,
            "total": total,
            "recalled": len(items),
            "cap": cap,
            "capped": total > len(items),
            "items": items,
        }

    def _serve_field(self, path_only):
        """Serve paginated 会话场 tiles on demand so data-<p>.json stays small."""
        match = FIELD_RE.match(path_only)
        if not match:
            return False
        product = match.group(1)
        parsed = urllib.parse.urlparse(self.path)
        query = {k: vals[0] for k, vals in urllib.parse.parse_qs(parsed.query).items() if vals}
        entry = recall_entry(product)
        up = _data_upstream()
        if up and (entry is None or len(entry.rows) <= 5):
            if self._proxy_data_upstream():
                return True
        if entry is None:
            self._send_body(404, b'{"error":"field index unavailable"}', "application/json")
            return True
        self._cache_policy = "no-cache"
        qhash = hashlib.sha1(self.path.encode("utf-8")).hexdigest()[:12]
        etag = f'{entry.etag[:-1]}-fld-{qhash}"'
        result = entry.query_field(query)
        body = json.dumps(result, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self._send_body(200, body, "application/json; charset=utf-8", etag=etag)
        return True

    def _serve_trend_node(self, path_only):
        """Serve one cluster node's 5D trend slice so matrix cell clicks avoid pulling full trends."""
        match = TREND_NODE_RE.match(path_only)
        if not match:
            return False
        product = match.group(1)
        parsed = urllib.parse.urlparse(self.path)
        query = {k: vals[0] for k, vals in urllib.parse.parse_qs(parsed.query).items() if vals}
        node = (query.get("node") or "").strip()
        if not node:
            self._send_body(400, b'{"error":"missing node"}', "application/json")
            return True
        idx = trend_node_index(product)
        if idx is None:
            if _data_upstream() and self._proxy_data_upstream():
                return True
            self._send_body(404, b'{"error":"trend index unavailable"}', "application/json")
            return True
        self._cache_policy = "no-cache"
        qhash = hashlib.sha1(node.encode("utf-8")).hexdigest()[:12]
        etag = f'{idx["etag"][:-1]}-{qhash}"'
        payload = {
            **idx["meta"],
            "nodes": [node],
            "cells": idx["by_node"].get(node, []),
        }
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self._send_body(200, body, "application/json; charset=utf-8", etag=etag)
        return True

    def _serve_input_slice(self, path_only):
        """Serve bounded (<= 500) sampled inputs (evaluated + pending) for 数据量 drilldown."""
        match = INPUT_SLICE_RE.match(path_only)
        if not match:
            return False
        product = match.group(1)
        parsed = urllib.parse.urlparse(self.path)
        query = {k: vals[0] for k, vals in urllib.parse.parse_qs(parsed.query).items() if vals}
        model = query.get("model") or ""
        task = query.get("task") or ""
        others = set()
        if query.get("others"):
            try:
                others = {str(x) for x in json.loads(query["others"])}
            except ValueError:
                others = set()
        try:
            cap = max(1, min(500, int(query.get("cap") or "500")))
        except ValueError:
            cap = 500

        up = _data_upstream()
        entry = recall_entry(product)
        preview_upstream = bool(up and (entry is None or len(entry.rows) <= 5))

        result = None
        if _lister and not preview_upstream:
            result = _lister.slice_inputs(product, model=model, task=task, others=others, cap=cap)

        if (result is None or int(result.get("recalled") or 0) == 0) and up:
            up_res = _upstream_request(up, self.path, timeout=12)
            if up_res and up_res[0] == 200:
                try:
                    up_json = json.loads(up_res[2].decode("utf-8"))
                    if isinstance(up_json, dict) and "groups" in up_json:
                        result = self._cap_recall_payload(up_json, cap=cap)
                except (ValueError, UnicodeDecodeError):
                    pass
            if result is None or int(result.get("recalled") or 0) == 0:
                result = self._upstream_input_slice_fallback(up, product, model=model, task=task, others=others, cap=cap)
        if result is None and _lister:
            result = _lister.slice_inputs(product, model=model, task=task, others=others, cap=cap)

        if result is None:
            result = {
                "product": product, "source": "inputs", "total": 0, "recalled": 0,
                "cap": cap, "capped": False, "eval_counts": [0, 0], "groups": [],
            }
        self._cache_policy = "no-cache"
        body = json.dumps(result, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self._send_body(200, body, "application/json; charset=utf-8")
        return True

    @staticmethod
    def _upstream_input_slice_fallback(up, product, model="", task="", others=None, cap=500):
        """Synthesize bounded <=500 input slice from local data-<p>.json daily metadata + upstream /inputs.json."""
        import recall_index
        others_set = set(others or ())
        dpath = os.path.join(STATIC, f"data-{product}.json")
        daily = []
        try:
            with open(dpath, encoding="utf-8") as fh:
                payload = json.load(fh)
            daily = (payload.get("products") or {}).get(product, {}).get("daily") or []
        except (OSError, ValueError):
            daily = []

        batches = []
        total_inputs = 0
        seen = set()
        for r in daily:
            rm = r.get("m") or ""
            if not recall_index._match_model_family(rm, model):
                continue
            sp = r.get("sp") or "daily"
            day = r.get("d") or ""
            total_inputs += int(r.get("inputs") or 0)
            if day and (day, sp, rm) not in seen and int(r.get("inputs") or 0) > 0:
                seen.add((day, sp, rm))
                batches.append((day, sp, rm))
        batches.sort(reverse=True)

        collected = []
        for day, sp, rm in batches[:4]:
            if len(collected) >= cap:
                break
            qs = urllib.parse.urlencode({"product": product, "d": day, "m": rm, "sp": sp})
            res = _upstream_request(up, f"/inputs.json?{qs}", timeout=10)
            if not res or res[0] != 200:
                continue
            try:
                lst = json.loads(res[2].decode("utf-8"))
            except (ValueError, UnicodeDecodeError):
                continue
            rows = lst.get("rows") or []
            want = cap - len(collected)
            step = max(1, len(rows) // max(1, want)) if not task and not others_set else 1
            for row in rows[::step]:
                cat = row.get("cat") or "未接入分类体系"
                if task and cat != task:
                    continue
                if not task and others_set and cat in others_set:
                    continue
                collected.append({
                    "q": row.get("q") or "",
                    "m": rm,
                    "sp": sp,
                    "d": day,
                    "r": row.get("r") or "",
                    "tr": int(row.get("tr") or 1),
                    "ev": 1 if row.get("ev") else 0,
                    "s": row.get("s") or "",
                    "cat": cat,
                })
                if len(collected) >= cap:
                    break

        grouped = {}
        ev_done = 0
        ev_pending = 0
        for it in collected:
            gkey = it.get("cat") or it.get("d") or it.get("m") or "未接入分类体系"
            if it.get("ev"):
                ev_done += 1
            else:
                ev_pending += 1
            grouped.setdefault(gkey, []).append(it)

        groups = [
            {"key": k, "name": k, "total": len(items), "items": items}
            for k, items in sorted(grouped.items(), key=lambda kv: (-len(kv[1]), kv[0]))
        ]
        reported_total = max(len(collected), total_inputs) if total_inputs > 0 else len(collected)
        return {
            "product": product,
            "source": "inputs",
            "total": reported_total,
            "recalled": len(collected),
            "cap": cap,
            "capped": reported_total > len(collected),
            "eval_counts": [ev_done, ev_pending],
            "groups": groups,
        }

    def do_POST(self):
        path_only = self.path.split("?", 1)[0]
        match = RECALL_LOOKUP_RE.match(path_only)
        if not match:
            self._send_body(404, b'{"error":"not found"}', "application/json")
            return
        if _warming.is_set():
            self._cache_policy = "no-store"
            self._send_body(503, b'{"ok":false,"warming":true}', "application/json")
            return
        product = match.group(1)
        entry = recall_entry(product)
        if entry is None:
            self._send_body(404, b'{"error":"recall index unavailable"}', "application/json")
            return
        try:
            length = int(self.headers.get("Content-Length") or "0")
        except ValueError:
            length = -1
        if length < 0 or length > 524288:
            self._send_body(400, b'{"error":"invalid content length"}', "application/json")
            return
        raw = self.rfile.read(length) if length else b"{}"
        try:
            payload = json.loads(raw.decode("utf-8"))
            if not isinstance(payload, dict):
                raise ValueError("not an object")
        except ValueError:
            self._send_body(400, b'{"error":"invalid json"}', "application/json")
            return
        up = _data_upstream()
        if up and (entry is None or len(entry.rows) <= 5):
            payload["cap"] = min(500, int(payload.get("cap") or 500))
            res = _upstream_request(
                up,
                self.path,
                method="POST",
                body=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
                headers={"Content-Type": "application/json"},
                timeout=10,
            )
            if res and res[0] == 200:
                self._cache_policy = "no-store"
                self._send_body(200, res[2], res[1])
                return
        slugs = payload.get("slugs") if isinstance(payload.get("slugs"), list) else []
        tids = payload.get("tids") if isinstance(payload.get("tids"), list) else []
        cap = payload.get("cap")
        result = entry.lookup(slugs, tids, cap=cap)
        self._cache_policy = "no-store"
        body = json.dumps(result, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self._send_body(200, body, "application/json; charset=utf-8")

    def do_GET(self):
        path_only = self.path.split("?", 1)[0]
        asset = ASSET_RE.match(path_only)
        if asset:
            # The current hash is immutable; an old hash (a page opened before a deploy)
            # still gets today's file, but must not pin it under the old URL.
            self._cache_policy = ("public, max-age=31536000, immutable"
                                  if asset.group(1) == ASSET_VERSION else "no-cache")
            self.path = path_only = "/" + asset.group(2)
        elif path_only in ("/", "/index.html"):
            self._cache_policy = "no-cache"
            self._send_body(200, INDEX[0], "text/html; charset=utf-8", etag=INDEX[1])
            return
        if path_only.startswith("/samples/") or path_only.startswith("/ab_samples/"):
            # Content comes from a generated file whose mtime changes when it is
            # rebuilt; a short reuse window avoids one RTT per trace.
            self._cache_policy = "public, max-age=120"
        elif not asset and path_only.startswith(("/js/", "/css/", "/vendor/")):
            # Unversioned asset URLs (old bookmarks, the 5002 proxies) revalidate every load.
            self._cache_policy = "no-cache"
        # Warming up after a restart: the port already answers (so browsers wait instead of seeing
        # ERR_CONNECTION_REFUSED), pages and assets load, data asks to be retried shortly.
        if _warming.is_set() and (self.path.startswith("/healthz") or path_only.endswith((".json", ".jsonl"))):
            self._cache_policy = "no-store"
            body = b'{"ok": false, "warming": true}'
            self.send_response(503)
            self.send_header("Retry-After", "3")
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if self.path.startswith("/healthz"):
            import pg_backend
            health = {
                "ok": _state["error"] == "",
                "backend": "postgresql_16" if pg_backend.is_pg_enabled() else "sqlite",
                "running": _state["running"],
                "last_refresh": _state["last_run"],
                "refresh_seconds": _state["seconds"],
                "error": _state["error"],
                "build": _state["build"],
            }
            if _state.get("skipped"):
                health["skipped"] = _state["skipped"]
            body = json.dumps(health).encode()
            self._send_body(200, body, "application/json")
            return
        if path_only in ("/speed.json", "/api/metrics"):
            import speed_monitor
            self._cache_policy = "no-store"
            self._cors_any = True
            payload = speed_monitor.payload()
            upstream = os.environ.get("EVAL_SPEED_UPSTREAM")
            if payload.get("available") is False and upstream:
                try:
                    with urllib.request.urlopen(upstream, timeout=3.5) as resp:
                        if resp.status == 200:
                            payload = json.loads(resp.read().decode("utf-8"))
                except Exception:  # noqa: BLE001
                    pass
            body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode()
            self._send_body(200, body, "application/json; charset=utf-8")
            return
        if (_lister or _data_upstream()) and (path_only == "/inputs.json" or (path_only.startswith("/inputs/") and path_only.endswith(".json"))):
            if self._serve_inputs(path_only):
                return
        if self._serve_input_slice(path_only):
            return
        if self._serve_field(path_only):
            return
        if self._serve_trend_node(path_only):
            return
        if self._serve_recall(path_only):
            return
        if self._serve_bench_export(path_only) or self._serve_bench(path_only) or self._serve_bench_case(path_only):
            return
        if _builder and path_only.startswith("/samples/") and path_only.endswith(".json"):
            slug = path_only[len("/samples/"):-len(".json")]
            try:
                generated = _builder.ensure(slug)
            except Exception as exc:  # noqa: BLE001 - a detail failure is a 404, not a crash
                print(f"[serve] detail {slug} failed: {exc}", flush=True)
                generated = None
            if generated is None and not os.path.isfile(self.translate_path(path_only)):
                if _data_upstream() and self._proxy_data_upstream():
                    return
                self._send_body(404, b"sample detail unavailable", "text/plain; charset=utf-8")
                return
        elif _data_upstream() and path_only.startswith("/samples/") and path_only.endswith(".json") and not os.path.isfile(self.translate_path(path_only)):
            if self._proxy_data_upstream():
                return
        if _ab_builder and path_only.startswith("/ab_samples/"):
            match = AB_DETAIL_RE.match(path_only)
            ref = None
            if match and AB_ROUND_RE.match(match.group(1)):
                key = match.group(2)
                if key.startswith(("before-", "after-", "candidate_model_")):
                    ref = (match.group(1), key)
                elif int(key) > 0:
                    ref = (match.group(1), int(key))
            generated = None
            if ref:
                try:
                    generated = _ab_builder.ensure(*ref)
                except Exception as exc:  # noqa: BLE001 - a detail failure is a 404, not a crash
                    print(f"[serve] ab detail {ref[0]}/{ref[1]} failed: {exc}", flush=True)
            # A malformed / traversal-looking path is a 404 without touching the static tree.
            if generated is None and (ref is None or not os.path.isfile(self.translate_path(path_only))):
                if _data_upstream() and self._proxy_data_upstream():
                    return
                self._send_body(404, b"ab sample detail unavailable", "text/plain; charset=utf-8")
                return
        elif _data_upstream() and path_only.startswith("/ab_samples/") and not os.path.isfile(self.translate_path(path_only)):
            if self._proxy_data_upstream():
                return
        if _ab_builder and path_only.startswith("/gpt_samples/"):
            match = GPT_DETAIL_RE.match(path_only)
            answer = None
            if match and AB_ROUND_RE.match(match.group(1)):
                try:
                    answer = _ab_builder.gpt(match.group(1), match.group(2))
                except Exception as exc:  # noqa: BLE001 - an unreadable answer is a 404
                    print(f"[serve] gpt answer {match.group(1)}/{match.group(2)} failed: {exc}",
                          flush=True)
            if answer is None:
                if _data_upstream() and self._proxy_data_upstream():
                    return
                self._send_body(404, b'{"error":"gpt answer unavailable"}', "application/json")
                return
            self._send_body(200, json.dumps(answer, ensure_ascii=False).encode(), "application/json")
            return
        elif _data_upstream() and path_only.startswith("/gpt_samples/") and not os.path.isfile(self.translate_path(path_only)):
            if self._proxy_data_upstream():
                return
        accept = {part.strip().split(";")[0] for part in self.headers.get("Accept-Encoding", "").split(",")}
        path = self.translate_path(self.path)
        if os.path.isdir(path):
            index = os.path.join(path, "index.html")
            if os.path.isfile(index):
                path = index
        if os.path.isfile(path):
            for encoding in ("br", "gzip"):
                if encoding in accept and self._serve_encoded(path, encoding):
                    return
        super().do_GET()

    def log_message(self, fmt, *args):
        sys.stderr.write("%s %s\n" % (time.strftime("%H:%M:%S"), fmt % args))


def asset_version():
    """Content hash of every browser asset: equal code on two hosts gives equal URLs."""
    digest = hashlib.sha1()
    for folder in ASSET_DIRS:
        for root, dirs, files in os.walk(os.path.join(STATIC, folder)):
            dirs.sort()
            for name in sorted(files):
                if name.endswith((".gz", ".br")):
                    continue
                path = os.path.join(root, name)
                digest.update(os.path.relpath(path, STATIC).encode())
                with open(path, "rb") as fh:
                    digest.update(fh.read())
    return digest.hexdigest()[:10]


def render_index():
    """index.html with versioned asset URLs and the site map inlined (no extra request)."""
    with open(os.path.join(STATIC, "index.html"), encoding="utf-8") as fh:
        html = fh.read()
    html = ASSET_REF_RE.sub(lambda m: f'{m.group(1)}="v/{ASSET_VERSION}/{m.group(2)}', html)
    try:
        with open(SITES_FILE, encoding="utf-8") as fh:
            sites = json.load(fh)
    except (OSError, ValueError) as exc:
        print(f"[serve] sites config {SITES_FILE} unreadable: {exc}", flush=True)
        sites = {}
    script = json.dumps(sites, ensure_ascii=False).replace("</", "<\\/")
    try:
        enabled = sorted(_products())
    except Exception:  # noqa: BLE001
        enabled = []
    boot = json.dumps({"products": enabled}, ensure_ascii=False).replace("</", "<\\/")
    html = html.replace(
        "</head>",
        f'<script type="application/json" id="sites">{script}</script>\n'
        f'<script type="application/json" id="boot">{boot}</script>\n</head>',
        1,
    )
    body = html.encode("utf-8")
    return body, f'"index-{hashlib.sha1(body).hexdigest()[:16]}"'


ASSET_VERSION = asset_version()
INDEX = render_index()


def seed_state():
    """Expose the payload produced by deploy.sh before this process started."""
    try:
        stat = os.stat(OUTPUTS[0])
        with open(OUTPUTS[0], encoding="utf-8") as fh:
            source = json.load(fh).get("source") or {}
        _state["build"] = {"pairs": source.get("pairs"), "pairing": source.get("mode")}
        _state["last_run"] = stat.st_mtime
    except (OSError, ValueError):
        pass


def outputs_ready():
    from pathlib import Path
    import build as _build
    return os.path.isdir(OUTPUTS[2]) and _build.payload_files_exist(Path(STATIC))


# Set while main() is still loading builders (or building the very first payloads) with the port
# already open; the handler answers data requests 503 + Retry-After until it clears.
_warming = threading.Event()


class DashboardServer(ThreadingHTTPServer):
    """Long-lived HTTP/1.1 server sized for a burst of sample details."""

    daemon_threads = True
    allow_reuse_address = True
    # One sample page opens every trace of a session at once (tens of requests).
    # The stdlib default backlog of 5 can refuse the later connections.
    request_queue_size = 128


def main():
    global _builder, _lister, _ab_builder
    # Listen before anything slow. The builders below, and on a fresh host a whole first build,
    # used to run before the bind, so every restart or deploy left the port closed and browsers
    # got ERR_CONNECTION_REFUSED; now they get a page whose data requests are retried.
    server = DashboardServer(("0.0.0.0", PORT), Handler)
    _warming.set()
    serving = threading.Thread(target=server.serve_forever, name="serve", daemon=True)
    serving.start()
    print(f"[serve] listening on :{PORT}, warming up", flush=True)
    from build import default_datasets
    import pg_backend
    pg_mode = pg_backend.is_pg_enabled()
    try:
        if pg_mode:
            _builder = pg_backend.PGDetailBuilder(os.path.join(STATIC, "samples"), CACHE)
        else:
            from detail_builder import DetailBuilder
            _builder = DetailBuilder(
                default_datasets(), os.path.join(CACHE, "build.sqlite3"),
                os.path.join(STATIC, "samples"), CACHE,
            )
    except Exception as exc:  # noqa: BLE001 - keep serving pre-generated details
        print(f"[serve] lazy detail builder disabled: {exc}", flush=True)
    try:
        if pg_mode:
            _ab_builder = pg_backend.PGABDetailBuilder(os.path.join(STATIC, "ab_samples"))
        else:
            from ab_detail import ABDetailBuilder
            _ab_builder = ABDetailBuilder(
                default_datasets(), CACHE, os.path.join(STATIC, "ab_samples"),
            )
            threading.Thread(target=_ab_builder.warm, daemon=True).start()
    except Exception as exc:  # noqa: BLE001 - retest details are optional; static files still serve
        print(f"[serve] ab detail builder disabled: {exc}", flush=True)
    try:
        if pg_mode:
            _lister = pg_backend.PGInputLister(CACHE)
        else:
            from input_list import InputLister
            _lister = InputLister(default_datasets(), os.path.join(CACHE, "build.sqlite3"),
                                  CACHE, STATIC)
            # 文件清单在弗吉尼亚要 23 秒（rglob 在 ceph 上），启动就后台读一遍，别让第一次点击等它。
            threading.Thread(target=warm_input_lister, daemon=True).start()
    except Exception as exc:  # noqa: BLE001 - 输入清单不可用时第三级退回旧行为
        print(f"[serve] input lister disabled: {exc}", flush=True)
    try:
        import speed_monitor
        persist = None if pg_mode else os.path.join(str(default_datasets()), "speed_stats.json")
        if speed_monitor.start(CACHE, persist_path=persist):
            print("[serve] speed monitor enabled", flush=True)
    except Exception as exc:  # noqa: BLE001 - speed monitor is optional
        print(f"[serve] speed monitor disabled: {exc}", flush=True)
    if not outputs_ready():
        print("[serve] payloads missing, building once before serving", flush=True)
        refresh_once()
    # Rebuild right away on restart, unless a build just ran (start.sh / deploy.sh build first).
    try:
        age = time.time() - os.path.getmtime(OUTPUTS[0])
    except OSError:
        age = 0
    seed_state()
    threading.Thread(target=scheduler, args=(REFRESH if age < 120 else 0,), daemon=True).start()
    threading.Thread(target=prewarm_details, daemon=True).start()
    threading.Thread(target=prewarm_recall, daemon=True).start()
    _warming.clear()
    print(f"[serve] http://0.0.0.0:{PORT} static={STATIC} refresh={REFRESH}s", flush=True)
    serving.join()


if __name__ == "__main__":
    main()
