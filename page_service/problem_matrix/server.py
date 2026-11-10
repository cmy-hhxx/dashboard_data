"""Run the cluster-matrix page on its own (usually it is mounted on the 5002 server).

    PORT=5002 UPSTREAM=http://127.0.0.1:5001 python3 server.py
    open http://127.0.0.1:5002/matrix/?matrix=1
"""
from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from pathlib import Path

HERE = Path(__file__).resolve().parent
if str(HERE.parent) not in sys.path:
    sys.path.insert(0, str(HERE.parent))

from page_proxy import UPSTREAM  # noqa: E402
from proxy import handle, redirect_root  # noqa: E402

PORT = int(os.environ.get("PORT", "5002"))
_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "problem-matrix/1.0"

    def _json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _health(self):
        info = {"ok": True, "port": PORT, "upstream": UPSTREAM, "upstream_ok": False}
        try:
            request = urllib.request.Request(UPSTREAM + "/healthz")
            with _OPENER.open(request, timeout=3.0) as response:
                upstream = json.loads(response.read())
            info["upstream_ok"] = bool(upstream.get("ok", True))
            info["upstream_last_refresh"] = upstream.get("last_refresh")
        except Exception:  # noqa: BLE001 - health answers even when upstream is down
            pass
        self._json(200, info)

    def do_GET(self):
        path = urllib.parse.urlsplit(self.path).path
        if path == "/healthz":
            return self._health()
        if path == "/":
            return redirect_root(self)
        if not handle(self):
            self.send_error(404)

    def do_HEAD(self):
        if not handle(self):
            self.send_error(404)

    def log_message(self, fmt, *args):
        sys.stderr.write("%s %s\n" % (time.strftime("%H:%M:%S"), fmt % args))


def main():
    ThreadingHTTPServer.allow_reuse_address = True
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    server.daemon_threads = True
    print("[serve] http://0.0.0.0:%d matrix=%s/ upstream=%s" % (PORT, "/matrix", UPSTREAM), flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
