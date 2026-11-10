"""The compare page mounts: /compare and the /compare_details alias."""
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

import page_proxy  # noqa: E402
import proxy  # noqa: E402


class Upstream(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_GET(self):
        path = urlsplit(self.path).path
        if path == "/":
            return self._send(b"<html>compare</html>", "text/html")
        if path == "/data.json":
            return self._send(b'{"generated_at":"2026-11-10 19:00"}', "application/json")
        if path == "/js/app.js":
            return self._send(b"console.log('compare')", "text/javascript")
        self.send_error(404)

    def _send(self, body, ctype):
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


class Mounted(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_GET(self):
        if not proxy.handle(self):
            self.send_error(404)

    def log_message(self, *args):
        pass


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


class ComparePageTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.upstream = ThreadingHTTPServer(("127.0.0.1", 0), Upstream)
        cls.upstream.daemon_threads = True
        threading.Thread(target=cls.upstream.serve_forever, daemon=True).start()
        page_proxy.UPSTREAM = "http://127.0.0.1:%d" % cls.upstream.server_address[1]

        cls.page = ThreadingHTTPServer(("127.0.0.1", 0), Mounted)
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

    def test_bare_paths_redirect_with_compare_flag(self):
        for path, want in (
            ("/compare", "compare/?view=compare&compare=1"),
            ("/compare/", "?view=compare&compare=1"),
            ("/compare_details", "compare_details/?view=compare&compare=1"),
            ("/compare_details/", "?view=compare&compare=1"),
        ):
            status, headers, _ = self.get(path, self.no_redirect)
            self.assertEqual(status, 302, path)
            self.assertEqual(headers["Location"], want, path)

    def test_round_pair_deep_link_keeps_its_query(self):
        status, headers, _ = self.get("/compare/?product=wencai&round=3&pair=abc", self.no_redirect)
        self.assertEqual(status, 302)
        self.assertEqual(
            headers["Location"],
            "?product=wencai&round=3&pair=abc&view=compare&compare=1",
        )

    def test_existing_view_is_not_duplicated(self):
        status, headers, _ = self.get("/compare/?view=compare&product=wencai", self.no_redirect)
        self.assertEqual(status, 302)
        self.assertEqual(headers["Location"], "?view=compare&product=wencai&compare=1")

    def test_page_and_assets_are_proxied_on_both_mounts(self):
        for prefix in ("/compare", "/compare_details"):
            status, headers, body = self.get(prefix + "/?compare=1")
            self.assertEqual(status, 200, prefix)
            self.assertEqual(headers["Content-Type"], "text/html", prefix)
            self.assertEqual(body, b"<html>compare</html>")

            status, _, body = self.get(prefix + "/data.json")
            self.assertEqual(status, 200, prefix)
            self.assertEqual(json.loads(body)["generated_at"], "2026-11-10 19:00")

            status, _, body = self.get(prefix + "/js/app.js")
            self.assertEqual(status, 200, prefix)
            self.assertEqual(body, b"console.log('compare')")

    def test_unknown_path_is_not_consumed(self):
        status, _, _ = self.get("/compare/nope")
        self.assertEqual(status, 404)


if __name__ == "__main__":
    unittest.main()
