"""Standalone sample-detail page.

One read-only page that renders the dashboard's sample pane (评测输入与输出)
for a single sample, plus a thin JSON gateway over the same data.

Everything is read through the internal dashboard over HTTP; this module never
imports dashboard code and never touches its files.  The frontend under
``static/`` is a frozen snapshot of ``dashboard/static`` (see README.md).

Routes
    GET /                              page (usage text when no sample given)
    GET /detail?product=…&case=…       page for a session (rounds merged like the pane)
    GET /detail?product=…&slug=…       page for one evaluation output
    GET /api/context?…                 mini sample index + taxonomy for the page
    GET /samples/<slug>.json           raw detail, dashboard-compatible path
    GET /samples-<product>.json        raw recall index, dashboard-compatible path
    GET /labels-<product>.json         raw problem labels (index-aligned with the recall index)
    GET /healthz                       liveness + upstream probe
"""
from __future__ import annotations

import gzip
import json
import os
import re
import sys
import threading
import time
import urllib.error
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

HERE = Path(__file__).resolve().parent
STATIC = HERE / "static"

PORT = int(os.environ.get("PORT", "5002"))
UPSTREAM = os.environ.get("UPSTREAM", "http://127.0.0.1:5001").rstrip("/")
PRODUCTS = ("wencai", "aime")
SLUG_RE = re.compile(r"^[0-9a-f]{10}$")
DETAIL_RE = re.compile(r"^/samples/([0-9a-f]{10})\.json$")
INDEX_RE = re.compile(r"^/samples-(wencai|aime)\.json$")
LABELS_RE = re.compile(r"^/labels-(wencai|aime)\.json$")
DOC_TTL = float(os.environ.get("DOC_TTL", "120"))  # payloads rebuild every ~10 min
UPSTREAM_TIMEOUT = 60.0

# Localhost upstream only; an ambient http_proxy must not swallow these.
_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def _upstream(path, timeout=UPSTREAM_TIMEOUT, gzip_ok=False):
    headers = {"Accept-Encoding": "gzip" if gzip_ok else "identity"}
    request = urllib.request.Request(UPSTREAM + path, headers=headers)
    with _OPENER.open(request, timeout=timeout) as response:
        return response.status, response.headers, response.read()


class DocCache:
    """Small in-process cache for build payloads; upstream has no cheap revalidation."""

    def __init__(self, ttl=DOC_TTL):
        self.ttl = ttl
        self._lock = threading.Lock()
        self._items = {}

    def get(self, key, path):
        item = self._items.get(key)
        if item and time.time() - item[0] < self.ttl:
            return item[1]
        with self._lock:
            item = self._items.get(key)
            if item and time.time() - item[0] < self.ttl:
                return item[1]
            _, headers, body = _upstream(path, gzip_ok=True)
            if headers.get("Content-Encoding") == "gzip":
                body = gzip.decompress(body)
            data = json.loads(body)
            self._items[key] = (time.time(), data)
            return data


DOCS = DocCache()
RAW_INDEX = {}
RAW_LABELS = {}
RAW_LOCK = threading.Lock()


def _raw_bytes(cache, path):
    """Raw payload body (and its gzip) cached briefly; these files are several MB."""
    item = cache.get(path)
    if item and time.time() - item[0] < DOC_TTL:
        return item[1], item[2]
    with RAW_LOCK:
        item = cache.get(path)
        if item and time.time() - item[0] < DOC_TTL:
            return item[1], item[2]
        _, _, body = _upstream(path)
        packed = (time.time(), body, gzip.compress(body, 5))
        cache[path] = packed
        return packed[1], packed[2]


def _index_bytes(product):
    """Recall index body; it is several MB."""
    return _raw_bytes(RAW_INDEX, "/samples-%s.json" % product)


def _labels_bytes(product):
    """Problem labels, index-aligned with the recall index rows; AIME is ~5 MB."""
    return _raw_bytes(RAW_LABELS, "/labels-%s.json" % product)


def session_key(row):
    """Must match samples.js groupSessions(): split | model | session id."""
    return "%s|%s|%s" % (
        row.get("sp") or "",
        row.get("m") or "",
        row.get("sid") or row.get("s") or "",
    )


def resolve(product, case, slug):
    """Find the session rows a page request points at, as (product, mini index, taxonomy)."""
    candidates = [product] if product in PRODUCTS else list(PRODUCTS)
    loaded = failed = 0
    for prod in candidates:
        try:
            doc = DOCS.get("index:" + prod, "/samples-%s.json" % prod)
        except Exception as exc:  # noqa: BLE001 - a missing product must not stop the other
            failed += 1
            sys.stderr.write("[context] index %s: %s\n" % (prod, exc))
            continue
        loaded += 1
        payload = (doc.get("products") or {}).get(prod) or {}
        rows = payload.get("rows") or []
        if case:
            picked = [row for row in rows if session_key(row) == case]
        elif slug:
            hit = next((row for row in rows if row.get("s") == slug), None)
            picked = [row for row in rows if hit and session_key(row) == session_key(hit)]
        else:
            picked = []
        if not picked:
            continue
        shell = DOCS.get("shell", "/data.json")
        index = {
            "schema": doc.get("schema"),
            "generated_at": doc.get("generated_at"),
            "product": prod,
            "available": doc.get("available") or [],
            "products": {
                prod: {
                    "label": payload.get("label"),
                    "models": payload.get("models") or [],
                    "splits": payload.get("splits") or [],
                    "rows": picked,
                }
            },
        }
        return {"product": prod, "index": index, "taxonomy": shell.get("taxonomy") or {}}
    if not loaded and failed:
        raise RuntimeError("upstream payloads unavailable")
    return None


class Handler(SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "sample-details/1.0"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(STATIC), **kwargs)

    # ---------------------------------------------------------------- replies
    def _accepts_gzip(self):
        return "gzip" in self.headers.get("Accept-Encoding", "")

    def _write(self, status, body, ctype, cache="no-cache", encoding=None):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Cache-Control", cache)
        if encoding:
            self.send_header("Content-Encoding", encoding)
            self.send_header("Vary", "Accept-Encoding")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send(self, status, body, ctype, cache="no-cache"):
        if isinstance(body, str):
            body = body.encode("utf-8")
        if self._accepts_gzip() and len(body) >= 1024:
            return self._write(status, gzip.compress(body, 5), ctype, cache, "gzip")
        return self._write(status, body, ctype, cache)

    def _json(self, status, payload, cache="no-cache"):
        self._send(status, json.dumps(payload, ensure_ascii=False), "application/json; charset=utf-8", cache)

    def _error(self, status, message, **extra):
        self._json(status, {"ok": False, "error": message, **extra}, cache="no-store")

    # ---------------------------------------------------------------- routes
    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        try:
            if path == "/healthz":
                return self._health()
            if path == "/api/context":
                return self._context(parse_qs(parsed.query))
            if path in ("/", "/index.html", "/detail", "/detail.html"):
                return self._page()
            match = DETAIL_RE.match(path)
            if match:
                return self._detail(match.group(1))
            match = INDEX_RE.match(path)
            if match:
                return self._index(match.group(1))
            match = LABELS_RE.match(path)
            if match:
                return self._labels(match.group(1))
            if path.startswith("/api/") or path.startswith("/samples"):
                return self._error(404, "not found")
            return super().do_GET()
        except (BrokenPipeError, ConnectionResetError):
            pass
        except urllib.error.HTTPError as exc:
            self._error(exc.code, "upstream returned %d" % exc.code)
        except Exception as exc:  # noqa: BLE001 - one bad request must not kill the server
            sys.stderr.write("[serve] %s %s failed: %s\n" % (time.strftime("%H:%M:%S"), self.path, exc))
            try:
                self._error(502, "upstream error: %s" % exc)
            except Exception:  # noqa: BLE001 - headers may already be on the wire
                pass

    def _health(self):
        info = {"ok": True, "port": PORT, "upstream": UPSTREAM, "upstream_ok": False}
        try:
            _, _, body = _upstream("/healthz", timeout=3.0)
            upstream = json.loads(body)
            info["upstream_ok"] = bool(upstream.get("ok", True))
            info["upstream_last_refresh"] = upstream.get("last_refresh")
        except Exception:  # noqa: BLE001 - health must answer even when upstream is down
            pass
        self._json(200, info, cache="no-store")

    def _page(self):
        try:
            body = (STATIC / "index.html").read_bytes()
        except OSError:
            return self._error(500, "page missing")
        return self._send(200, body, "text/html; charset=utf-8")

    def _context(self, query):
        product = (query.get("product") or [""])[0].strip()
        case = (query.get("case") or [""])[0].strip()
        slug = (query.get("slug") or [""])[0].strip()
        trace = (query.get("trace") or [""])[0].strip()
        if product and product not in PRODUCTS:
            return self._error(400, "bad product")
        if slug and not SLUG_RE.match(slug):
            return self._error(400, "bad slug")
        if not case and not slug:
            return self._error(400, "case or slug required")
        if len(case) > 400:
            return self._error(400, "bad case")
        if len(trace) > 120:
            return self._error(400, "bad trace")
        context = resolve(product, case, slug)
        if context is None:
            return self._error(404, "sample not found", product=product or None, case=case or None, slug=slug or None)
        # trace 只回显；轮次定位在前端做（详情里才有每轮 trace_id），见 README
        context["trace"] = trace or None
        return self._json(200, context)

    def _detail(self, slug):
        try:
            _, headers, body = _upstream("/samples/%s.json" % slug)
        except urllib.error.HTTPError as exc:
            return self._error(exc.code, "detail unavailable", slug=slug)
        ctype = headers.get("Content-Type") or "application/json"
        return self._send(200, body, ctype)

    def _index(self, product):
        try:
            body, packed = _index_bytes(product)
        except urllib.error.HTTPError as exc:
            return self._error(exc.code, "index unavailable", product=product)
        if self._accepts_gzip():
            return self._write(200, packed, "application/json; charset=utf-8", encoding="gzip")
        return self._write(200, body, "application/json; charset=utf-8")

    def _labels(self, product):
        # Forwarded verbatim: callers pair labels[i] with the same row of
        # /samples-<product>.json, so both must stay index-aligned.
        try:
            body, packed = _labels_bytes(product)
        except urllib.error.HTTPError as exc:
            return self._error(exc.code, "labels unavailable", product=product)
        if self._accepts_gzip():
            return self._write(200, packed, "application/json; charset=utf-8", encoding="gzip")
        return self._write(200, body, "application/json; charset=utf-8")

    def log_message(self, fmt, *args):
        sys.stderr.write("%s %s\n" % (time.strftime("%H:%M:%S"), fmt % args))


def main():
    ThreadingHTTPServer.allow_reuse_address = True
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    server.daemon_threads = True
    print("[serve] http://0.0.0.0:%d upstream=%s static=%s" % (PORT, UPSTREAM, STATIC), flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
