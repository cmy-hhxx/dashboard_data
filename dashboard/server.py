#!/usr/bin/env python3
"""Eval dashboard server: static files + build.py payloads on :5001, rebuilt on a timer."""
import gzip
import json
import mimetypes
import os
import re
import shutil
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
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
MODEL_RE = re.compile(r"^[a-z][a-z0-9_]*$")
# /ab_samples/<roundId>/<eq>.json: the round name is validated before it can reach the builder.
AB_ROUND_RE = re.compile(r"^[0-9A-Za-z][0-9A-Za-z._-]*$")
AB_DETAIL_RE = re.compile(r"^/ab_samples/([^/]+)/(\d+)\.json$")


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
        for product in ("wencai", "aime"):
            path = os.path.join(STATIC, f"samples-{product}.json")
            try:
                with open(path, encoding="utf-8") as fh:
                    rows = json.load(fh)["products"][product]["rows"]
            except (OSError, ValueError, KeyError):
                continue
            # Index rows are already severity-sorted; add the newest dates too.
            picks = rows[:PREWARM]
            picks += sorted(rows, key=lambda r: r.get("d") or "", reverse=True)[:10]
            seen, slugs = set(), []
            for row in picks:
                slug = row.get("s")
                if slug and slug not in seen:
                    seen.add(slug)
                    slugs.append(slug)
            if slugs:
                made = _builder.prewarm(slugs)
                print(f"[serve] prewarmed {made}/{len(slugs)} {product} details", flush=True)
    finally:
        with _prewarm_lock:
            _prewarm_running = False


def refresh_once():
    """Rebuild data.json, samples.json and samples/ from the datasets in one pass."""
    with _lock:
        if _state["running"]:
            return
        _state["running"] = True
    started = time.time()
    try:
        proc = subprocess.run(
            [sys.executable, BUILD, "--keep-on-empty"],
            capture_output=True, text=True, timeout=1800, cwd=HERE,
        )
        line = (proc.stdout.strip().splitlines() or [""])[-1]
        if proc.returncode == 0:
            _state["error"] = ""
            try:
                _state["build"] = json.loads(line)
            except ValueError:
                _state["build"] = line[-500:]
            print("[refresh]", line, flush=True)
            threading.Thread(target=prewarm_details, daemon=True).start()
        else:
            _state["error"] = (proc.stderr or line or "")[-500:]
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
    # opened when a multi-trace session is selected.
    protocol_version = "HTTP/1.1"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=STATIC, **kwargs)

    def end_headers(self):
        # Everything revalidates (a 304 still saves the body); healthz is never cached.
        policy = "no-store" if self.path.startswith("/healthz") else "no-cache"
        self.send_header("Cache-Control", policy)
        super().end_headers()

    def _send_body(self, status, body, ctype):
        # HTTP/1.1 keep-alive: without Content-Length the client waits for a body
        # that never ends, which is how a failed detail used to hang the page.
        # Generated JSON has no precompressed twin, so compress it here; the
        # sample details are the largest payloads the page pulls.
        encoding = None
        if len(body) >= 1024 and "gzip" in self.headers.get("Accept-Encoding", ""):
            body = gzip.compress(body, 6)
            encoding = "gzip"
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Vary", "Accept-Encoding")
        if encoding:
            self.send_header("Content-Encoding", encoding)
        self.end_headers()
        self.wfile.write(body)

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
            self._send_body(200, body, "application/json")
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

    def _gzip_matches_source(self, path, gz):
        """Reject a .gz that was not built from the current source file.

        mtime alone misses equal-timestamp copies (e.g. a copied static tree);
        gzip's trailing ISIZE field records the uncompressed size, so a size
        mismatch catches the dangerous case before stale JSON reaches clients.
        """
        try:
            # gzip preserves the source timestamp, often with coarser precision;
            # allow a small skew but still require a matching payload size below.
            if os.path.getmtime(gz) + 1 < os.path.getmtime(path):
                return False
            with open(gz, "rb") as fh:
                fh.seek(-4, os.SEEK_END)
                size = int.from_bytes(fh.read(4), "little")
            return size == os.path.getsize(path) % (1 << 32)
        except OSError:
            return False

    def _serve_gzip(self, path):
        gz = path + ".gz"
        try:
            stat = os.stat(gz)
            source = os.stat(path)
        except OSError:
            return False
        # The compressed copy must not be older than its source, otherwise a
        # regenerated data.json would be served from a stale .gz.
        last_modified = max(stat.st_mtime, source.st_mtime)
        since = self.headers.get("If-Modified-Since")
        if since:
            try:
                parsed = parsedate_to_datetime(since)
                if parsed.tzinfo is None:
                    parsed = parsed.replace(tzinfo=timezone.utc)
                if int(last_modified) <= int(parsed.timestamp()):
                    self.send_response(304)
                    self.send_header("Vary", "Accept-Encoding")
                    self.send_header("Last-Modified", self.date_time_string(last_modified))
                    self.end_headers()
                    return True
            except (TypeError, ValueError, OverflowError):
                pass
        ctype = mimetypes.guess_type(path)[0] or "application/octet-stream"
        self.send_response(200)
        self.send_header("Vary", "Accept-Encoding")
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Encoding", "gzip")
        self.send_header("Content-Length", str(stat.st_size))
        self.send_header("Last-Modified", self.date_time_string(last_modified))
        self.end_headers()
        with open(gz, "rb") as fh:
            shutil.copyfileobj(fh, self.wfile)
        return True

    def do_GET(self):
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
        path_only = self.path.split("?", 1)[0]
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
            if match and AB_ROUND_RE.match(match.group(1)) and int(match.group(2)) > 0:
                ref = (match.group(1), int(match.group(2)))
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
        if "gzip" in self.headers.get("Accept-Encoding", ""):
            path = self.translate_path(self.path)
            if os.path.isdir(path):
                index = os.path.join(path, "index.html")
                if os.path.isfile(index):
                    path = index
            if os.path.isfile(path) and os.path.isfile(path + ".gz"):
                if self._gzip_matches_source(path, path + ".gz") and self._serve_gzip(path):
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
    if not all(os.path.exists(p) for p in OUTPUTS):
        return False
    try:
        with open(OUTPUTS[0], encoding="utf-8") as fh:
            data = json.load(fh)
        with open(OUTPUTS[1], encoding="utf-8") as fh:
            samples = json.load(fh)
    except (OSError, ValueError):
        return False
    return (all(os.path.exists(os.path.join(STATIC, f"data-{p}.json")) for p in (data.get("products") or {}))
            and all(os.path.exists(os.path.join(STATIC, f"samples-{p}.json")) for p in (samples.get("products") or {}))
            and all(os.path.exists(os.path.join(STATIC, f"labels-{p}.json")) for p in (samples.get("products") or {}))
            and all(os.path.exists(os.path.join(STATIC, f"trends-{p}.json")) for p in (data.get("products") or {})))


def main():
    global _builder, _lister, _ab_builder
    try:
        from build import default_datasets
        from detail_builder import DetailBuilder
        _builder = DetailBuilder(
            default_datasets(), os.path.join(HERE, "cache", "build.sqlite3"),
            os.path.join(STATIC, "samples"), os.path.join(HERE, "cache"),
        )
    except Exception as exc:  # noqa: BLE001 - keep serving pre-generated details
        print(f"[serve] lazy detail builder disabled: {exc}", flush=True)
    try:
        from build import default_datasets
        from ab_detail import ABDetailBuilder
        _ab_builder = ABDetailBuilder(
            default_datasets(), os.path.join(HERE, "cache"), os.path.join(STATIC, "ab_samples"),
        )
    except Exception as exc:  # noqa: BLE001 - retest details are optional; static files still serve
        print(f"[serve] ab detail builder disabled: {exc}", flush=True)
    try:
        from build import default_datasets
        from input_list import InputLister
        _lister = InputLister(default_datasets(), os.path.join(HERE, "cache", "build.sqlite3"),
                              os.path.join(HERE, "cache"), STATIC)
        # 文件清单在弗吉尼亚要 23 秒（rglob 在 ceph 上），启动就后台读一遍，别让第一次点击等它。
        import build as _build
        threading.Thread(target=_lister.warm, args=(sorted(_build.ENABLED),), daemon=True).start()
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
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"[serve] http://0.0.0.0:{PORT} static={STATIC} refresh={REFRESH}s", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
