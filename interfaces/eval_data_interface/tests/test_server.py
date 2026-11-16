"""server 层小用例：响应编码不能被数据里的坏字符打挂（不起 HTTP 服务）。

    python3 tests/test_server.py
"""

import io
import json
import sys
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO))

from analysis_api import server  # noqa: E402


class _Handler:
    """够 _json_response 用的最小 handler。"""

    headers = {}

    def __init__(self):
        self.wfile = io.BytesIO()
        self.status = None
        self.sent = {}

    def send_response(self, status):
        self.status = status

    def send_header(self, name, value):
        self.sent[name.lower()] = value

    def end_headers(self):
        pass


class JsonResponseTest(unittest.TestCase):
    def test_lone_surrogate_does_not_break_response(self):
        """eval_input 里有落单代理字符时，详情接口必须是 200 而不是 503。"""
        handler = _Handler()
        server._json_response(handler, 200, {"question": "emoji \ud83d broken"})
        self.assertEqual(handler.status, 200)
        body = handler.wfile.getvalue()
        self.assertEqual(int(handler.sent["content-length"]), len(body))
        payload = json.loads(body.decode("utf-8"))
        self.assertIn("emoji", payload["question"])


if __name__ == "__main__":
    unittest.main()
