"""The matrix page proxy: path mounts, redirects and upstream pass-through."""
from __future__ import annotations

import json
import sys
import threading
import unittest
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

HERE = Path(__file__).resolve().parents[1]
if str(HERE.parent) not in sys.path:
    sys.path.insert(0, str(HERE.parent))
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

import proxy  # noqa: E402
import page_proxy  # noqa: E402
import server as matrix_server  # noqa: E402


class Upstream(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_GET(self):
        path = urlsplit(self.path).path
        if path == "/":
            return self._send(b"<html>dashboard</html>", "text/html")
        if path == "/data.json":
            return self._send(b'{"generated_at":"2026-11-10 19:00"}', "application/json")
        if path == "/js/app.js":
            return self._send(b"console.log('app')", "text/javascript")
        if path == "/healthz":
            return self._send(b'{"ok":true,"last_refresh":1}', "application/json")
        if path == "/go":
            self.send_response(302)
            self.send_header("Location", "/js/app.js")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if path == "/cached":
            self.send_response(304)
            self.send_header("ETag", '"abc"')
            self.end_headers()
            return
        self.send_error(404)

    def _send(self, body, ctype):
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


class MatrixPageTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.upstream = ThreadingHTTPServer(("127.0.0.1", 0), Upstream)
        cls.upstream.daemon_threads = True
        threading.Thread(target=cls.upstream.serve_forever, daemon=True).start()
        cls.upstream_url = "http://127.0.0.1:%d" % cls.upstream.server_address[1]
        page_proxy.UPSTREAM = cls.upstream_url
        matrix_server.UPSTREAM = cls.upstream_url
        matrix_server.PORT = 0

        cls.page = ThreadingHTTPServer(("127.0.0.1", 0), matrix_server.Handler)
        cls.page.daemon_threads = True
        threading.Thread(target=cls.page.serve_forever, daemon=True).start()
        cls.page_url = "http://127.0.0.1:%d" % cls.page.server_address[1]
        cls.plain = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        cls.no_redirect = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())

    @classmethod
    def tearDownClass(cls):
        cls.page.shutdown()
        cls.page.server_close()
        cls.upstream.shutdown()
        cls.upstream.server_close()

    def get(self, path, opener=None):
        request = urllib.request.Request(self.page_url + path)
        try:
            with (opener or self.plain).open(request, timeout=5) as response:
                return response.status, dict(response.headers), response.read()
        except urllib.error.HTTPError as exc:
            try:
                return exc.code, dict(exc.headers), exc.read()
            finally:
                exc.close()

    def test_bare_paths_redirect_into_the_mounts(self):
        for path, want in (
            ("/", "matrix/?matrix=1"),
            ("/matrix", "matrix/?matrix=1"),
            ("/matrix/", "?matrix=1"),
            ("/dashboard", "dashboard/"),
        ):
            status, headers, _ = self.get(path, self.no_redirect)
            self.assertEqual(status, 302, path)
            self.assertEqual(headers["Location"], want, path)

    def test_matrix_page_and_assets_are_proxied(self):
        status, headers, body = self.get("/matrix/?matrix=1")
        self.assertEqual(status, 200)
        self.assertEqual(headers["Content-Type"], "text/html")
        self.assertEqual(body, b"<html>dashboard</html>")

        status, _, body = self.get("/matrix/data.json")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["generated_at"], "2026-11-10 19:00")

        status, _, body = self.get("/matrix/js/app.js")
        self.assertEqual(status, 200)
        self.assertEqual(body, b"console.log('app')")

    def test_full_dashboard_mount_is_available_for_sample_jumps(self):
        status, _, body = self.get("/dashboard/")
        self.assertEqual(status, 200)
        self.assertEqual(body, b"<html>dashboard</html>")
        status, _, body = self.get("/dashboard/data.json")
        self.assertEqual(status, 200)
        self.assertIn(b"generated_at", body)

    def test_upstream_redirect_stays_under_the_mount(self):
        status, headers, _ = self.get("/matrix/go", self.no_redirect)
        self.assertEqual(status, 302)
        self.assertEqual(headers["Location"], "/matrix/js/app.js")

    def test_not_modified_and_unknown_paths(self):
        status, headers, _ = self.get("/matrix/cached")
        self.assertEqual(status, 304)
        self.assertEqual(headers["ETag"], '"abc"')
        status, _, _ = self.get("/matrix/nope")
        self.assertEqual(status, 404)

    def test_health_checks_the_upstream(self):
        status, _, body = self.get("/healthz")
        self.assertEqual(status, 200)
        payload = json.loads(body)
        self.assertTrue(payload["ok"])
        self.assertTrue(payload["upstream_ok"])


if __name__ == "__main__":
    unittest.main()
