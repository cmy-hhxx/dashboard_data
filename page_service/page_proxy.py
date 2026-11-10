"""Small reverse-proxy mount shared by the 5002 page services.

Each page under ``page_service/`` is one mount over the internal dashboard:

    /matrix/...          -> dashboard /...  with matrix=1
    /compare/...         -> dashboard /...  with compare=1
    /compare_details/... -> same as /compare/ (alias)
    /dashboard/...       -> dashboard /...  (full board, fallback links)

The dashboard is reverse-proxied instead of copied so the standalone pages keep
its exact CSS, JS and data contract.  Only GET/HEAD cross the mount.
"""
from __future__ import annotations

import os
import urllib.error
import urllib.parse
import urllib.request

UPSTREAM = os.environ.get("UPSTREAM", "http://127.0.0.1:5001").rstrip("/")
UPSTREAM_TIMEOUT = 60.0
HTML_PAGES = ("/", "/index.html")

# Hop-by-hop headers must not be forwarded in either direction.
_HOP = {
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailer", "transfer-encoding", "upgrade",
}


# Localhost upstream only; an ambient http_proxy must not swallow these, and
# upstream redirects stay visible to the browser instead of being followed here.
class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect())


def redirect(handler, location):
    handler.send_response(302)
    handler.send_header("Location", location)
    handler.send_header("Content-Length", "0")
    handler.end_headers()


def _ensure_query(query, extra):
    """Append only the required keys that are missing; return (query, changed)."""
    if not extra:
        return query, False
    params = urllib.parse.parse_qs(query, keep_blank_values=True)
    needed = urllib.parse.parse_qs(extra, keep_blank_values=True)
    missing = []
    for key, values in needed.items():
        if key not in params:
            missing.extend("%s=%s" % (key, value) for value in values)
    if not missing:
        return query, False
    return "&".join([segment for segment in [query, *missing] if segment]), True


def _request_headers(handler):
    headers = {}
    for key, value in handler.headers.items():
        low = key.lower()
        if low in _HOP or low in ("host", "content-length"):
            continue
        headers[key] = value
    return headers


def _location(value, prefix):
    """Keep upstream redirects inside the mounted prefix."""
    if value.startswith(UPSTREAM):
        return prefix + value[len(UPSTREAM):]
    if value.startswith("/") and not value.startswith(prefix + "/") and value != prefix:
        return prefix + value
    return value


def _forward(handler, prefix, rest, query):
    target = UPSTREAM + rest
    if query:
        target += "?" + query
    method = handler.command if handler.command in ("GET", "HEAD") else "GET"
    request = urllib.request.Request(target, method=method, headers=_request_headers(handler))
    try:
        response = _OPENER.open(request, timeout=UPSTREAM_TIMEOUT)
    except urllib.error.HTTPError as exc:
        response = exc
    except Exception:  # noqa: BLE001 - upstream down / DNS / timeout
        try:
            handler.send_error(502, "upstream unavailable")
        except Exception:  # noqa: BLE001 - headers may already be on the wire
            pass
        return True

    try:
        status = response.status
        length = response.headers.get("Content-Length")
        handler.send_response(status)
        for key, value in response.headers.items():
            low = key.lower()
            if low in _HOP or low in ("content-length", "connection", "date", "server"):
                continue
            if low == "location":
                value = _location(value, prefix)
            handler.send_header(key, value)
        body = b"" if method == "HEAD" or status in (204, 304) else response.read()
        if status not in (204, 304):
            handler.send_header("Content-Length", length if method == "HEAD" and length else str(len(body)))
        handler.end_headers()
        if method != "HEAD" and status not in (204, 304):
            handler.wfile.write(body)
    finally:
        response.close()
    return True


def mount(handler, prefix, extra_query=None):
    """Proxy one prefix. ``extra_query`` is appended to the HTML entry (e.g. matrix=1)."""
    parsed = urllib.parse.urlsplit(handler.path)
    path, query = parsed.path, parsed.query

    if path == prefix:
        q, _ = _ensure_query(query, extra_query)
        # Relative Location keeps an external proxy prefix (DSW) intact; the browser resolves it
        # against the current URL, e.g. /prefix/matrix -> /prefix/matrix/.
        location = prefix.lstrip("/") + "/"
        if q:
            location += "?" + q
        redirect(handler, location)
        return True
    if not path.startswith(prefix + "/"):
        return False

    rest = path[len(prefix):]
    if extra_query and rest in HTML_PAGES:
        q, missing = _ensure_query(query, extra_query)
        if missing:
            # Same path, new query: relative so /prefix/matrix/ stays under the proxy prefix.
            redirect(handler, "?" + q)
            return True
    return _forward(handler, prefix, rest or "/", query)
