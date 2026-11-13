"""Standalone sample-detail page.

One read-only page that renders the dashboard's sample pane (评测输入与输出)
for a single sample, plus a thin JSON gateway over the same data.

Everything is read through the internal dashboard over HTTP; this module never
imports dashboard code and never touches its files.  The page's own files are
``static/index.html``, ``entry.js`` and ``detail.css``; every ``/js/``, ``/css/``
and ``/vendor/`` asset is the dashboard's, forwarded as-is, so the pane here is
always the one the dashboard ships.

Routes
    GET /                              page (usage text when no sample given)
    GET /detail?product=…&case=…       page for a session (rounds merged like the pane)
    GET /detail?product=…&slug=…       page for one evaluation output
    GET /api/context?…                 mini sample index + taxonomy for the page
    GET /samples/<slug>.json           raw detail, dashboard-compatible path
    GET /samples-<product>.json        raw recall index, dashboard-compatible path
    GET /labels-<product>.json         raw problem labels (index-aligned with the recall index)
    GET /js/… /css/… /vendor/…         the dashboard's frontend, forwarded
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

# The cluster-matrix page lives beside this module and shares the 5002 port.
if str(HERE.parent) not in sys.path:
    sys.path.insert(0, str(HERE.parent))
try:
    from problem_matrix.proxy import handle as handle_matrix_page
except ImportError:  # the module is optional: sample details keep working without it
    handle_matrix_page = None
try:
    from compare_details.proxy import handle as handle_compare_page
except ImportError:  # same for the standalone version-compare page
    handle_compare_page = None
import page_proxy  # noqa: E402  (shared forwarder; page_service/ is on sys.path above)

# The pane's code and styles live only in dashboard/static; this page borrows them.
ASSET_PREFIXES = ("/js/", "/css/", "/vendor/")

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
FILTERED = {}
FILTER_LOCK = threading.Lock()
TEST_USER = "test"


def filtered_docs(product):
    """Index + labels with test-user rows removed (same mask keeps labels aligned)."""
    now = time.time()
    item = FILTERED.get(product)
    if item and now - item[0] < DOC_TTL:
        return item[1], item[2]
    with FILTER_LOCK:
        item = FILTERED.get(product)
        if item and time.time() - item[0] < DOC_TTL:
            return item[1], item[2]
        doc = DOCS.get("index:" + product, "/samples-%s.json" % product)
        labels = DOCS.get("labels:" + product, "/labels-%s.json" % product)
        payload = (doc.get("products") or {}).get(product) or {}
        rows = payload.get("rows") or []
        keep = [i for i, row in enumerate(rows) if row.get("ut") != TEST_USER]
        if len(keep) == len(rows):
            filtered, filtered_labels = doc, labels
        else:
            filtered = {
                **doc,
                "products": {**(doc.get("products") or {}),
                             product: {**payload, "rows": [rows[i] for i in keep]}},
            }
            raw_labels = labels.get("labels") if isinstance(labels, dict) else None
            if isinstance(raw_labels, list) and len(raw_labels) == len(rows):
                filtered_labels = {**labels, "labels": [raw_labels[i] for i in keep]}
            else:
                filtered_labels = labels
        FILTERED[product] = (time.time(), filtered, filtered_labels)
        return filtered, filtered_labels


def filtered_bytes(product):
    """Serialized + gzipped filtered index/labels; recompressing 20 MB per request is wasteful."""
    key = "bytes:" + product
    now = time.time()
    item = FILTERED.get(key)
    if item and now - item[0] < DOC_TTL:
        return item[1:]
    doc, labels = filtered_docs(product)
    body = json.dumps(doc, ensure_ascii=False).encode("utf-8")
    lbody = json.dumps(labels, ensure_ascii=False).encode("utf-8")
    packed = gzip.compress(body, 5)
    lpacked = gzip.compress(lbody, 5)
    FILTERED[key] = (time.time(), body, packed, lbody, lpacked)
    return body, packed, lbody, lpacked


def allowed_slugs():
    """Slugs visible through the page interface: test-user samples are not served."""
    now = time.time()
    item = FILTERED.get("__slugs")
    if item and now - item[0] < DOC_TTL:
        return item[1]
    slugs = set()
    for product in PRODUCTS:
        try:
            doc, _ = filtered_docs(product)
        except Exception as exc:  # noqa: BLE001 - one product must not block the other
            sys.stderr.write("[filter] index %s: %s\n" % (product, exc))
            continue
        rows = (((doc.get("products") or {}).get(product) or {}).get("rows") or [])
        slugs.update(row.get("s") for row in rows if row.get("s"))
    FILTERED["__slugs"] = (time.time(), slugs)
    return slugs


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
            doc, _labels = filtered_docs(prod)
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
            # /matrix/…, /compare/… and /dashboard/… share this port with the sample page.
            if handle_matrix_page and handle_matrix_page(self):
                return
            if handle_compare_page and handle_compare_page(self):
                return
            if path.startswith(ASSET_PREFIXES):
                return page_proxy._forward(self, "", path, parsed.query)
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

    def do_HEAD(self):
        if handle_matrix_page and handle_matrix_page(self):
            return
        if handle_compare_page and handle_compare_page(self):
            return
        if urlparse(self.path).path.startswith(ASSET_PREFIXES):
            page_proxy._forward(self, "", urlparse(self.path).path, urlparse(self.path).query)
            return
        super().do_HEAD()

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
        if slug not in allowed_slugs():
            return self._error(404, "detail unavailable", slug=slug)
        try:
            _, headers, body = _upstream("/samples/%s.json" % slug)
        except urllib.error.HTTPError as exc:
            return self._error(exc.code, "detail unavailable", slug=slug)
        ctype = headers.get("Content-Type") or "application/json"
        return self._send(200, body, ctype)

    def _index(self, product):
        try:
            body, packed, _lbody, _lpacked = filtered_bytes(product)
        except urllib.error.HTTPError as exc:
            return self._error(exc.code, "index unavailable", product=product)
        if self._accepts_gzip():
            return self._write(200, packed, "application/json; charset=utf-8", encoding="gzip")
        return self._write(200, body, "application/json; charset=utf-8")

    def _labels(self, product):
        # Same mask as /samples-<product>.json: callers pair labels[i] with rows[i].
        try:
            _body, _packed, lbody, lpacked = filtered_bytes(product)
        except urllib.error.HTTPError as exc:
            return self._error(exc.code, "labels unavailable", product=product)
        if self._accepts_gzip():
            return self._write(200, lpacked, "application/json; charset=utf-8", encoding="gzip")
        return self._write(200, lbody, "application/json; charset=utf-8")

    def log_message(self, fmt, *args):
        sys.stderr.write("%s %s\n" % (time.strftime("%H:%M:%S"), fmt % args))


class Server(ThreadingHTTPServer):
    daemon_threads = True
    # A page opens ~10 css/js requests at once; the stdlib backlog of 5 refused some of them.
    request_queue_size = 128


def main():
    ThreadingHTTPServer.allow_reuse_address = True
    server = Server(("0.0.0.0", PORT), Handler)
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
