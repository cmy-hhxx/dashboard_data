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
BUILD = os.path.join(HERE, "build.py")
OUTPUTS = [os.path.join(STATIC, n) for n in ("data.json", "samples.json", "samples")]
PORT = int(os.environ.get("PORT", "5001"))
# 10 minutes plus the ~1 minute incremental build keeps the board well inside 30 minutes of the data.
REFRESH = int(os.environ.get("REFRESH_SECONDS", "600"))

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
            with open(os.path.join(HERE, "cache", "prewarm.json"), encoding="utf-8") as fh:
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
            stdout, stderr = proc.communicate(timeout=1800)
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
        if product not in ("wencai", "aime") or not DATE_RE.match(day) or not MODEL_RE.match(model) or split not in ("daily", "lost"):
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
        try:
            super().handle_one_request()
        finally:
            elapsed = time.time() - started
            if elapsed >= 2.0:
                sys.stderr.write(f"[slow] {elapsed:.1f}s {getattr(self, 'command', '?')} {self.path}\n")

    def do_GET(self):
        path_only = self.path.split("?", 1)[0]
        if path_only.startswith("/samples/") or path_only.startswith("/ab_samples/"):
            # Content comes from a generated file whose mtime changes when it is
            # rebuilt; a short reuse window avoids one RTT per trace.
            self._cache_policy = "public, max-age=120"
        elif path_only.startswith("/js/") or path_only.startswith("/css/") or path_only in ("/", "/index.html"):
            # Deploys replace these files under the same name.  A max-age reuse window is how an
            # old abtest.js survived a deploy while its JSON was already fresh; revalidate every
            # load instead (ETag/Last-Modified still make the hit a cheap 304).
            self._cache_policy = "no-cache"
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
        if _lister and (path_only == "/inputs.json" or (path_only.startswith("/inputs/") and path_only.endswith(".json"))):
            if self._serve_inputs(path_only):
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


class DashboardServer(ThreadingHTTPServer):
    """Long-lived HTTP/1.1 server sized for a burst of sample details."""

    daemon_threads = True
    allow_reuse_address = True
    # One sample page opens every trace of a session at once (tens of requests).
    # The stdlib default backlog of 5 can refuse the later connections.
    request_queue_size = 128


def main():
    global _builder, _lister, _ab_builder
    from build import default_datasets
    try:
        from detail_builder import DetailBuilder
        _builder = DetailBuilder(
            default_datasets(), os.path.join(HERE, "cache", "build.sqlite3"),
            os.path.join(STATIC, "samples"), os.path.join(HERE, "cache"),
        )
    except Exception as exc:  # noqa: BLE001 - keep serving pre-generated details
        print(f"[serve] lazy detail builder disabled: {exc}", flush=True)
    try:
        from ab_detail import ABDetailBuilder
        _ab_builder = ABDetailBuilder(
            default_datasets(), os.path.join(HERE, "cache"), os.path.join(STATIC, "ab_samples"),
        )
        threading.Thread(target=_ab_builder.warm, daemon=True).start()
    except Exception as exc:  # noqa: BLE001 - retest details are optional; static files still serve
        print(f"[serve] ab detail builder disabled: {exc}", flush=True)
    try:
        from input_list import InputLister
        _lister = InputLister(default_datasets(), os.path.join(HERE, "cache", "build.sqlite3"),
                              os.path.join(HERE, "cache"), STATIC)
        # 文件清单在弗吉尼亚要 23 秒（rglob 在 ceph 上），启动就后台读一遍，别让第一次点击等它。
        threading.Thread(target=warm_input_lister, daemon=True).start()
    except Exception as exc:  # noqa: BLE001 - 输入清单不可用时第三级退回旧行为
        print(f"[serve] input lister disabled: {exc}", flush=True)
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
    server = DashboardServer(("0.0.0.0", PORT), Handler)
    print(f"[serve] http://0.0.0.0:{PORT} static={STATIC} refresh={REFRESH}s", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
