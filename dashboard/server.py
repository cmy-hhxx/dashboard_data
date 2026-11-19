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
import urllib.parse
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

# Where each product's board lives; the page sends a product that is not built here to its site.
SITES_FILE = os.environ.get("EVAL_SITES_FILE") or os.path.join(HERE, "config", "sites.json")
# Browser assets are served under /v/<content hash>/ with a year-long immutable cache; a deploy
# changes the hash, so clients pick up new code without revalidating every module on every load.
ASSET_DIRS = ("js", "css", "vendor")
ASSET_RE = re.compile(r"^/v/([0-9a-f]{10})/((?:js|css|vendor)/[^?]+)$")
ASSET_REF_RE = re.compile(r'(href|src)="((?:js|css|vendor)/)')

_state = {"last_run": 0, "running": False, "error": "", "seconds": 0, "build": None}
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
# /ab_samples/<roundId>/<eq>.json: the round name is validated before it can reach the builder.
AB_ROUND_RE = re.compile(r"^[0-9A-Za-z][0-9A-Za-z._-]*$")
AB_DETAIL_RE = re.compile(r"^/ab_samples/([^/]+)/(before-[0-9A-Za-z_-]+|\d+)\.json$")
GPT_DETAIL_RE = re.compile(r"^/gpt_samples/([^/]+)/([0-9A-Za-z_-]+)\.json$")
# /bench/<product>.json: serves schema:1 golden/bad slices or schema:2 dynamic bench views/fields.
BENCH_RE = re.compile(r"^/bench/([a-z][a-z0-9_]*)\.json$")
BENCH_CASE_RE = re.compile(r"^/bench_case/([a-z][a-z0-9_]*)/([a-z0-9_]+)/([^/]+)\.json$")
_BENCH_CACHE = {}
_BENCH_LOCK = threading.Lock()
_BENCH_INDEX_CACHE = {}
_BENCH_INDEX_LOCK = threading.Lock()


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


def refresh_once():
    """Rebuild data.json, samples.json and samples/ from the datasets in one pass."""
    with _lock:
        if _state["running"]:
            return
        _state["running"] = True
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

    def _send_body(self, status, body, ctype, etag=None):
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
                payload = _lister.listing(product, day, model, split)
            except Exception as exc:  # noqa: BLE001 - 读不到就告诉前端，别挂页面
                print(f"[serve] inputs {product} {day} {model}: {exc}", flush=True)
                self._send_body(500, b'{"error":"input listing failed"}', "application/json")
                return True
            body = json.dumps(payload, ensure_ascii=False).encode()
            sig = hashlib.sha1(json.dumps(payload.get("sig"), separators=(",", ":")).encode()).hexdigest()[:20]
            self._send_body(200, body, "application/json", etag=f'"inputs-{sig}"')
            return True
        ref = urllib.parse.unquote(path_only[len("/inputs/"):-len(".json")])
        try:
            detail = _lister.detail(product, day, model, split, ref)
        except Exception as exc:  # noqa: BLE001
            print(f"[serve] input detail {product} {day} {model} {ref}: {exc}", flush=True)
            detail = None
        if detail is None:
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

    def _serve_bench(self, path_only):
        """Serve Bench payloads: schema:2 dynamic bench views/fields or schema:1 golden/bad slices."""
        match = BENCH_RE.match(path_only)
        if not match:
            return False
        product = match.group(1)
        payload = bench_payload(product)
        if not payload:
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
            self._send_body(404, b'{"error":"bench case not found"}', "application/json")
            return True
        import bench_dynamic
        from build import default_datasets
        detail = bench_dynamic.load_bench_case(default_datasets(), row)
        if detail is None:
            self._send_body(404, b'{"error":"bench case unreadable"}', "application/json")
            return True
        self._cache_policy = "public, max-age=120"
        body = json.dumps(detail, ensure_ascii=False, separators=(",", ":")).encode()
        self._send_body(200, body, "application/json; charset=utf-8")
        return True

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
        if _warming.is_set() and (self.path.startswith("/healthz") or path_only.endswith(".json")):
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
            body = json.dumps({
                "ok": _state["error"] == "",
                "running": _state["running"],
                "last_refresh": _state["last_run"],
                "refresh_seconds": _state["seconds"],
                "error": _state["error"],
                "build": _state["build"],
            }).encode()
            self._send_body(200, body, "application/json")
            return
        if path_only in ("/speed.json", "/api/metrics"):
            import speed_monitor
            self._cache_policy = "no-store"
            self._cors_any = True
            body = json.dumps(speed_monitor.payload(), ensure_ascii=False, separators=(",", ":")).encode()
            self._send_body(200, body, "application/json; charset=utf-8")
            return
        if _lister and (path_only == "/inputs.json" or (path_only.startswith("/inputs/") and path_only.endswith(".json"))):
            if self._serve_inputs(path_only):
                return
        if self._serve_bench(path_only) or self._serve_bench_case(path_only):
            return
        if _builder and path_only.startswith("/samples/") and path_only.endswith(".json"):
            slug = path_only[len("/samples/"):-len(".json")]
            try:
                generated = _builder.ensure(slug)
            except Exception as exc:  # noqa: BLE001 - a detail failure is a 404, not a crash
                print(f"[serve] detail {slug} failed: {exc}", flush=True)
                generated = None
            if generated is None and not os.path.isfile(self.translate_path(path_only)):
                self._send_body(404, b"sample detail unavailable", "text/plain; charset=utf-8")
                return
        if _ab_builder and path_only.startswith("/ab_samples/"):
            match = AB_DETAIL_RE.match(path_only)
            ref = None
            if match and AB_ROUND_RE.match(match.group(1)):
                key = match.group(2)
                if key.startswith("before-"):
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
                self._send_body(404, b"ab sample detail unavailable", "text/plain; charset=utf-8")
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
                self._send_body(404, b'{"error":"gpt answer unavailable"}', "application/json")
                return
            self._send_body(200, json.dumps(answer, ensure_ascii=False).encode(), "application/json")
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
    html = html.replace("</head>", f'<script type="application/json" id="sites">{script}</script>\n</head>', 1)
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
    try:
        from detail_builder import DetailBuilder
        _builder = DetailBuilder(
            default_datasets(), os.path.join(CACHE, "build.sqlite3"),
            os.path.join(STATIC, "samples"), CACHE,
        )
    except Exception as exc:  # noqa: BLE001 - keep serving pre-generated details
        print(f"[serve] lazy detail builder disabled: {exc}", flush=True)
    try:
        from ab_detail import ABDetailBuilder
        _ab_builder = ABDetailBuilder(
            default_datasets(), CACHE, os.path.join(STATIC, "ab_samples"),
        )
        threading.Thread(target=_ab_builder.warm, daemon=True).start()
    except Exception as exc:  # noqa: BLE001 - retest details are optional; static files still serve
        print(f"[serve] ab detail builder disabled: {exc}", flush=True)
    try:
        from input_list import InputLister
        _lister = InputLister(default_datasets(), os.path.join(CACHE, "build.sqlite3"),
                              CACHE, STATIC)
        # 文件清单在弗吉尼亚要 23 秒（rglob 在 ceph 上），启动就后台读一遍，别让第一次点击等它。
        threading.Thread(target=warm_input_lister, daemon=True).start()
    except Exception as exc:  # noqa: BLE001 - 输入清单不可用时第三级退回旧行为
        print(f"[serve] input lister disabled: {exc}", flush=True)
    try:
        import speed_monitor
        from build import default_datasets
        if speed_monitor.start(CACHE, persist_path=os.path.join(str(default_datasets()), "speed_stats.json")):
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
    _warming.clear()
    print(f"[serve] http://0.0.0.0:{PORT} static={STATIC} refresh={REFRESH}s", flush=True)
    serving.join()


if __name__ == "__main__":
    main()
