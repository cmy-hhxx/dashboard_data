"""End-to-end tests for the standalone sample-detail service.

Runs a fake upstream (dashboard stand-in) and the real server as subprocesses,
then exercises every public route.  No network, no dashboard code.
"""
from __future__ import annotations

import gzip
import json
import os
import socket
import subprocess
import sys
import threading
import time
import unittest
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
SERVER = HERE / "server.py"


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def row(slug, sid, model="b_fast", split="daily", question="问题"):
    return {
        "s": slug, "sid": sid, "m": model, "sp": split, "q": question, "d": "2026-10-01",
        "n": 1, "w": "P1", "tr": 1, "pt": [], "st": [], "tg": [], "lang": "zh",
        "tid": "", "case": "", "task": "", "sub": "", "skill": "", "sc": "",
    }


INDEX = {
    "/samples-wencai.json": {
        "schema": 1, "generated_at": "2026-11-03T00:00:00", "product": "wencai",
        "available": ["aime"],
        "products": {"wencai": {"label": "问财", "models": [{"id": "b_fast", "label": "B Fast"}],
                                "splits": ["daily"],
                                "rows": [row("aaaaaaaaaa", "thread_1"), row("bbbbbbbbbb", "thread_1"),
                                         row("cccccccccc", "thread_2")], "pad": "x" * 4096}},
    },
    "/samples-aime.json": {
        "schema": 1, "generated_at": "2026-11-03T00:00:00", "product": "aime",
        "available": ["wencai"],
        "products": {"aime": {"label": "AIME", "models": [], "splits": ["lost"], "rows": []}},
    },
    "/data.json": {"schema": 1, "taxonomy": {"patterns": {"S1.M1": {"name": "模式"}}, "stages": []}},
    "/labels-wencai.json": {"schema": 2, "product": "wencai", "labels": ["标签一", "标签二", ""]},
    "/labels-aime.json": {"schema": 2, "product": "aime", "labels": ["标签一", "标签二", ""]},
    "/samples/aaaaaaaaaa.json": {"slug": "aaaaaaaaaa", "product": "wencai", "model": "b_fast",
                                 "input": {"traces": [], "missing": True},
                                 "attribution": {"problems": [], "turns": []},
                                 "compact": None, "evidence": [], "pad": "x" * 4096},
}
HEALTH = {"ok": True, "running": False, "last_refresh": 1.0}


class Upstream(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/healthz":
            return self._json(200, HEALTH)
        if path in INDEX:
            return self._json(200, INDEX[path])
        self.send_error(404, "nope")

    def _json(self, status, payload):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


def fetch(url, gzip_ok=False):
    headers = {"Accept-Encoding": "gzip"} if gzip_ok else {}
    request = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(request, timeout=20) as response:
        body = response.read()
        if response.headers.get("Content-Encoding") == "gzip":
            body = gzip.decompress(body)
        return response.status, response.headers, body


class SampleDetailsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.upstream = ThreadingHTTPServer(("127.0.0.1", 0), Upstream)
        cls.upstream.daemon_threads = True
        threading.Thread(target=cls.upstream.serve_forever, daemon=True).start()
        cls.port = free_port()
        env = dict(os.environ, PORT=str(cls.port), UPSTREAM="http://127.0.0.1:%d" % cls.upstream.server_port,
                   DOC_TTL="1")
        cls.proc = subprocess.Popen([sys.executable, str(SERVER)], env=env,
                                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        cls.base = "http://127.0.0.1:%d" % cls.port
        deadline = time.time() + 15
        while time.time() < deadline:
            try:
                fetch(cls.base + "/healthz")
                break
            except OSError:
                time.sleep(0.1)
        else:
            raise RuntimeError("server did not start")

    @classmethod
    def tearDownClass(cls):
        cls.proc.terminate()
        cls.proc.wait(timeout=10)
        cls.upstream.shutdown()
        cls.upstream.server_close()

    def test_health(self):
        status, _, body = fetch(self.base + "/healthz")
        payload = json.loads(body)
        self.assertEqual(status, 200)
        self.assertTrue(payload["ok"])
        self.assertTrue(payload["upstream_ok"])

    def test_page_routes(self):
        for path in ("/", "/detail", "/index.html"):
            status, headers, body = fetch(self.base + path)
            self.assertEqual(status, 200)
            self.assertIn(b"entry.js", body)
            self.assertTrue(headers.get("Content-Type", "").startswith("text/html"))

    def test_context_by_case(self):
        status, _, body = fetch(self.base + "/api/context?product=wencai&case=daily%7Cb_fast%7Cthread_1")
        payload = json.loads(body)
        self.assertEqual(status, 200)
        self.assertEqual(payload["product"], "wencai")
        self.assertEqual(len(payload["index"]["products"]["wencai"]["rows"]), 2)
        self.assertEqual(payload["taxonomy"]["patterns"]["S1.M1"]["name"], "模式")

    def test_context_by_case_finds_product(self):
        _, _, body = fetch(self.base + "/api/context?case=daily%7Cb_fast%7Cthread_2")
        payload = json.loads(body)
        self.assertEqual(payload["product"], "wencai")
        self.assertEqual([r["s"] for r in payload["index"]["products"]["wencai"]["rows"]], ["cccccccccc"])

    def test_context_by_slug_keeps_whole_session(self):
        _, _, body = fetch(self.base + "/api/context?product=wencai&slug=bbbbbbbbbb")
        payload = json.loads(body)
        self.assertEqual([r["s"] for r in payload["index"]["products"]["wencai"]["rows"]],
                         ["aaaaaaaaaa", "bbbbbbbbbb"])

    def test_context_echoes_trace(self):
        status, _, body = fetch(self.base + "/api/context?product=wencai&case=daily%7Cb_fast%7Cthread_1"
                                "&trace=20003020179337992707500000000286")
        payload = json.loads(body)
        self.assertEqual(status, 200)
        self.assertEqual(payload["trace"], "20003020179337992707500000000286")
        _, _, body = fetch(self.base + "/api/context?product=wencai&case=daily%7Cb_fast%7Cthread_1")
        self.assertIsNone(json.loads(body)["trace"])

    def test_context_misses(self):
        for query, expected in (("?product=wencai&case=daily%7Cb_fast%7Cthread_404", 404),
                                ("?product=wencai", 400),
                                ("?product=nope&slug=aaaaaaaaaa", 400),
                                ("?product=wencai&slug=zzz", 400)):
            with self.assertRaises(urllib.error.HTTPError) as caught:
                fetch(self.base + "/api/context" + query)
            self.assertEqual(caught.exception.code, expected, query)
            self.assertFalse(json.loads(caught.exception.read())["ok"])

    def test_detail_proxy(self):
        status, headers, body = fetch(self.base + "/samples/aaaaaaaaaa.json")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["slug"], "aaaaaaaaaa")
        status, headers, body = fetch(self.base + "/samples/aaaaaaaaaa.json", gzip_ok=True)
        self.assertEqual(headers.get("Content-Encoding"), "gzip")

    def test_detail_missing(self):
        with self.assertRaises(urllib.error.HTTPError) as caught:
            fetch(self.base + "/samples/9999999999.json")
        self.assertEqual(caught.exception.code, 404)

    def test_index_proxy(self):
        status, _, body = fetch(self.base + "/samples-wencai.json")
        self.assertEqual(status, 200)
        self.assertEqual(len(json.loads(body)["products"]["wencai"]["rows"]), 3)
        status, headers, body = fetch(self.base + "/samples-wencai.json", gzip_ok=True)
        self.assertEqual(headers.get("Content-Encoding"), "gzip")

    def test_labels_proxy(self):
        status, _, body = fetch(self.base + "/labels-wencai.json")
        self.assertEqual(status, 200)
        payload = json.loads(body)
        self.assertEqual(payload["product"], "wencai")
        self.assertEqual(payload["labels"], ["标签一", "标签二", ""])
        # 与 /samples-<product>.json 的 rows 同序同长度：调用方按下标配对
        _, _, index_body = fetch(self.base + "/samples-wencai.json")
        rows = json.loads(index_body)["products"]["wencai"]["rows"]
        self.assertEqual(len(payload["labels"]), len(rows))
        status, headers, _ = fetch(self.base + "/labels-wencai.json", gzip_ok=True)
        self.assertEqual(headers.get("Content-Encoding"), "gzip")
        # aime 同样可透传（各自部署只服务自己的产品，标签文件不随产品变）
        status, _, body = fetch(self.base + "/labels-aime.json")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["product"], "aime")

    def test_static_assets(self):
        for path in ("/js/samples.js", "/js/core.js", "/css/samples.css", "/detail.css", "/entry.js"):
            status, _, body = fetch(self.base + path)
            self.assertEqual(status, 200, path)
            self.assertTrue(body)
        # 单样本页要显式告诉快照「索引是子集」，否则它会去拉全量 labels 并错位
        _, _, entry = fetch(self.base + "/entry.js")
        self.assertIn(b"oneSession", entry)

    def test_unknown_api_paths(self):
        with self.assertRaises(urllib.error.HTTPError) as caught:
            fetch(self.base + "/api/nope")
        self.assertEqual(caught.exception.code, 404)
        with self.assertRaises(urllib.error.HTTPError) as caught:
            fetch(self.base + "/labels-nope.json")
        self.assertEqual(caught.exception.code, 404)


if __name__ == "__main__":
    unittest.main()
