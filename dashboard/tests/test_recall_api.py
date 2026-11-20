"""Tests for bounded (<= 2000) server-side recall index and HTTP pagination endpoints."""
import http.client
import json
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path

try:
    from dashboard.tests.test_empty_data import DASHBOARD  # noqa: F401
except ImportError:
    import sys
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import recall_index  # noqa: E402
import server  # noqa: E402


def _write_fixture(static_dir: Path, product: str, rows: list[dict], labels: list[str] | None = None):
    payload = {
        "generated_at": "2026-11-20T12:00:00+08:00",
        "available": [product],
        "products": {
            product: {
                "models": [{"id": "aime_fast", "label": "Fast"}, {"id": "aime_expert", "label": "Expert"}],
                "splits": [{"id": "daily", "label": "日常"}, {"id": "lost", "label": "流失"}],
                "rows": rows,
            }
        },
    }
    (static_dir / f"samples-{product}.json").write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    if labels is not None:
        (static_dir / f"labels-{product}.json").write_text(json.dumps({"labels": labels}, ensure_ascii=False), encoding="utf-8")


class RecallIndexUnitTests(unittest.TestCase):
    def test_sessions_grouping_filtering_facets_and_2000_cap(self):
        with tempfile.TemporaryDirectory() as tmp:
            static = Path(tmp)
            rows = [
                # Multi-round session sharing sid across two models -> peer models `pm`
                {"s": "s0001", "sid": "sess-shared", "tid": "t-1", "sp": "daily", "m": "aime_fast", "d": "2026-11-18",
                 "q": "茅台财报", "w": "P1", "n": 2, "tr": 1, "sv": [0, 2, 0, 0, 0], "st": ["S1"], "pt": ["S1.M1.1"],
                 "task": "财报分析", "sub": "个股财报", "ut": "real", "r": ["planner"]},
                {"s": "s0002", "sid": "sess-shared", "tid": "t-2", "sp": "daily", "m": "aime_fast", "d": "2026-11-19",
                 "q": "茅台财报追问", "w": "P0", "n": 1, "tr": 1, "sv": [1, 0, 0, 0, 0], "st": ["S2"], "pt": ["S2.M2.1"],
                 "task": "财报分析", "sub": "个股财报", "ut": "real", "r": ["planner"]},
                {"s": "s0003", "sid": "sess-shared", "tid": "t-3", "sp": "daily", "m": "aime_expert", "d": "2026-11-19",
                 "q": "茅台财报", "w": "P2", "n": 1, "tr": 1, "sv": [0, 0, 1, 0, 0], "st": ["S1"], "pt": ["S1.M1.1"],
                 "task": "财报分析", "sub": "个股财报", "ut": "real", "r": ["executor"]},
                # Lost user row
                {"s": "s0004", "sid": "sess-lost", "tid": "t-4", "sp": "lost", "m": "aime_fast", "d": "2026-11-17",
                 "q": "板块轮动", "w": "none", "n": 0, "tr": 1, "sv": [0, 0, 0, 0, 0], "st": [], "pt": [],
                 "task": "行情走势", "sub": "", "ut": "test", "ul": 1, "r": []},
            ]
            # Add 2,300 more sessions to verify RECALL_CAP = 2000 enforcement
            for i in range(2300):
                rows.append({
                    "s": f"bulk-{i:04d}", "sid": f"sid-{i:04d}", "tid": f"tid-{i:04d}",
                    "sp": "daily", "m": "aime_fast", "d": "2026-11-19",
                    "q": f"批量问题 {i}", "w": "P3", "n": 1, "tr": 1, "sv": [0, 0, 0, 1, 0],
                    "st": ["S1"], "pt": ["S1.M1.1"], "task": "行情走势", "sub": "大盘", "ut": "real", "r": ["planner"],
                })
            labels = ["特殊标签命中"] + [""] * (len(rows) - 1)
            _write_fixture(static, "aime", rows, labels)

            store = recall_index.RecallStore()
            entry = store.get(str(static), "aime")
            self.assertIsNotNone(entry)

            # Default page 1 is capped at 2000 (40 pages x 50)
            p1 = entry.query_sessions({"page": "1", "size": "50"})
            self.assertEqual(p1["total_sessions"], 2303)
            self.assertEqual(p1["matched"], 2303)
            self.assertEqual(p1["recalled"], 2000)
            self.assertTrue(p1["capped"])
            self.assertEqual(p1["pages"], 40)
            self.assertEqual(len(p1["rows"]), 50)
            # Multi-round session aggregated sv=[1,2,0,0,0], worst=P0, peer models=[aime_expert, aime_fast]
            first = p1["rows"][0]
            self.assertEqual(first["w"], "P0")
            self.assertEqual(first["sv"], [1, 2, 0, 0, 0])
            self.assertEqual(first["pm"], ["aime_expert", "aime_fast"])
            # Facets populated
            self.assertIn("财报分析", p1["facets"]["scenes"])
            self.assertIn("S1", p1["facets"]["stages"])

            # Page beyond cap clamps cleanly to page 40
            p99 = entry.query_sessions({"page": "99", "size": "50", "facets": "0"})
            self.assertEqual(p99["page"], 40)
            self.assertEqual(len(p99["rows"]), 50)
            self.assertNotIn("facets", p99)

            # Label search matches merged labels-aime.json
            ql = entry.query_sessions({"q": "特殊标签命中"})
            self.assertEqual(ql["matched"], 1)
            self.assertEqual(ql["rows"][0]["sid"], "sess-shared")

            # Locate deep-linked slug even when outside page 1
            loc = entry.query_sessions({"case": "bulk-0120", "locate": "1", "size": "50"})
            self.assertEqual(loc["page"], loc["target_page"])
            self.assertEqual(loc["target"]["rows"][0]["s"], "bulk-0120")

            # Lost split filter
            lost = entry.query_sessions({"split": "lost"})
            self.assertEqual(lost["matched"], 1)
            self.assertEqual(lost["rows"][0]["sid"], "sess-lost")

            # Galaxy slice stratifies and caps at 2000 while reporting exact total & severity parts
            gx = entry.query_galaxy({"card": "vol", "model": "aime_fast"})
            self.assertEqual(gx["total"], 2303)
            self.assertEqual(gx["recalled"], 2000)
            self.assertTrue(gx["capped"])
            self.assertEqual(sum(gx["parts"]), 2303)
            self.assertEqual(sum(len(g["items"]) for g in gx["groups"]), 2000)
            # Highest severity row (P0) must survive capping
            all_slugs = {it["s"] for g in gx["groups"] for it in g["items"]}
            self.assertIn("s0002", all_slugs)

            # Trend slice paginates lazily within day index
            tr1 = entry.query_trend({"date": "2026-11-19", "node": "S1.M1", "offset": "0", "limit": "30"})
            self.assertEqual(len(tr1["rows"]), 30)
            self.assertTrue(tr1["has_more"])
            self.assertTrue(tr1["capped"])
            self.assertEqual(tr1["recalled"], 2000)

            # Session sibling lookup
            sib = entry.query_session({"sid": "sess-shared", "m": "aime_fast"})
            self.assertEqual([r["s"] for r in sib["rows"]], ["s0001", "s0002"])

            # Direct slug + tid lookup
            lk = entry.lookup(["s0003", "missing"], ["t-4"])
            self.assertEqual({r["s"] for r in lk["rows"]}, {"s0003", "s0004"})


class RecallHttpEndpointTests(unittest.TestCase):
    def test_http_endpoints_etag_and_lookup_post(self):
        with tempfile.TemporaryDirectory() as tmp:
            static = Path(tmp)
            rows = [
                {"s": "a1", "sid": "sid1", "tid": "tid1", "sp": "daily", "m": "aime_fast", "d": "2026-11-19",
                 "q": "测试问题一", "w": "P0", "n": 1, "tr": 1, "sv": [1, 0, 0, 0, 0], "st": ["S1"], "pt": ["S1.M1.1"],
                 "task": "行情走势", "sub": "", "ut": "real", "r": ["planner"]},
                {"s": "a2", "sid": "sid1", "tid": "tid2", "sp": "daily", "m": "aime_fast", "d": "2026-11-19",
                 "q": "测试问题二", "w": "P1", "n": 2, "tr": 1, "sv": [0, 2, 0, 0, 0], "st": ["S1"], "pt": ["S1.M1.1"],
                 "task": "行情走势", "sub": "", "ut": "real", "r": ["planner"]},
            ]
            _write_fixture(static, "aime", rows)

            old_static = server.STATIC
            old_store = server._RECALL_STORE
            server.STATIC = str(static)
            server._RECALL_STORE = recall_index.RecallStore()
            httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
            thread = threading.Thread(target=httpd.serve_forever, daemon=True)
            thread.start()
            try:
                port = httpd.server_address[1]
                conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)

                conn.request("GET", "/api/recall/aime.json?page=1&size=50")
                res = conn.getresponse()
                self.assertEqual(res.status, 200)
                etag = res.getheader("ETag")
                self.assertTrue(etag)
                body = json.loads(res.read().decode("utf-8"))
                self.assertEqual(body["matched"], 1)
                self.assertEqual(body["rows"][0]["tr"], 2)

                # Conditional GET returns 304
                conn.request("GET", "/api/recall/aime.json?page=1&size=50", headers={"If-None-Match": etag})
                res304 = conn.getresponse()
                res304.read()
                self.assertEqual(res304.status, 304)

                # Galaxy slice GET
                conn.request("GET", "/api/recall_slice/aime.json?mode=galaxy&card=clu&prefix=S1")
                resg = conn.getresponse()
                self.assertEqual(resg.status, 200)
                gbody = json.loads(resg.read().decode("utf-8"))
                self.assertEqual(gbody["total"], 2)

                # Lookup POST
                post_data = json.dumps({"slugs": ["a1"], "tids": ["tid2"]}).encode("utf-8")
                conn.request("POST", "/api/recall_lookup/aime.json", body=post_data,
                             headers={"Content-Type": "application/json", "Content-Length": str(len(post_data))})
                resp = conn.getresponse()
                self.assertEqual(resp.status, 200)
                lbody = json.loads(resp.read().decode("utf-8"))
                self.assertEqual({r["s"] for r in lbody["rows"]}, {"a1", "a2"})

                # Unknown product returns 404
                conn.request("GET", "/api/recall/unknown.json")
                res404 = conn.getresponse()
                res404.read()
                self.assertEqual(res404.status, 404)
                conn.close()
            finally:
                httpd.shutdown()
                httpd.server_close()
                server.STATIC = old_static
                server._RECALL_STORE = old_store


if __name__ == "__main__":
    unittest.main()
