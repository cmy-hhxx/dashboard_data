"""Tests for bounded (<= 500) server-side recall index, attr flows, input slicing and HTTP endpoints."""
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

import build  # noqa: E402
import build_store  # noqa: E402
import input_list  # noqa: E402
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
    def test_sessions_grouping_filtering_facets_and_500_cap(self):
        with tempfile.TemporaryDirectory() as tmp:
            static = Path(tmp)
            rows = [
                # Multi-round session sharing sid across two models -> peer models `pm`
                {"s": "s0001", "sid": "sess-shared", "tid": "t-1", "sp": "daily", "m": "aime_fast", "d": "2026-11-18",
                 "q": "茅台财报", "w": "P1", "n": 2, "tr": 1, "sv": [0, 2, 0, 0, 0], "st": ["S1"], "pt": ["S1.M1.1"],
                 "task": "财报分析", "sub": "个股财报", "ut": "real", "r": ["planner"], "hr": 1},
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
            # Add 700 more sessions to verify RECALL_CAP = 500 enforcement
            for i in range(700):
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

            # Default page 1 is uncapped: all 703 sessions across 15 pages (14x50 + 3)
            p1 = entry.query_sessions({"page": "1", "size": "50"})
            self.assertEqual(p1["total_sessions"], 703)
            self.assertEqual(p1["matched"], 703)
            self.assertEqual(p1["recalled"], 703)
            self.assertIsNone(p1["cap"])
            self.assertFalse(p1["capped"])
            self.assertEqual(p1["pages"], 15)
            self.assertEqual(len(p1["rows"]), 50)
            # Legacy cap query param is ignored for session list recall
            p_legacy = entry.query_sessions({"page": "1", "size": "50", "cap": "500", "facets": "0"})
            self.assertEqual(p_legacy["recalled"], 703)
            self.assertFalse(p_legacy["capped"])
            self.assertEqual(p_legacy["pages"], 15)
            # Multi-round session aggregated sv=[1,2,0,0,0], worst=P0, peer models=[aime_expert, aime_fast]
            first = p1["rows"][0]
            self.assertEqual(first["w"], "P0")
            self.assertEqual(first["sv"], [1, 2, 0, 0, 0])
            self.assertEqual(first["pm"], ["aime_expert", "aime_fast"])
            # Facets populated
            self.assertIn("财报分析", p1["facets"]["scenes"])
            self.assertIn("S1", p1["facets"]["stages"])

            # Page beyond total clamps cleanly to last page (15) with remaining 3 sessions
            p99 = entry.query_sessions({"page": "99", "size": "50", "facets": "0"})
            self.assertEqual(p99["page"], 15)
            self.assertEqual(len(p99["rows"]), 3)
            self.assertNotIn("facets", p99)

            # Label search matches merged labels-aime.json
            ql = entry.query_sessions({"q": "特殊标签命中"})
            self.assertEqual(ql["matched"], 1)
            self.assertEqual(ql["rows"][0]["sid"], "sess-shared")

            # Locate deep-linked slug even when past 500
            loc = entry.query_sessions({"case": "bulk-0650", "locate": "1", "size": "50"})
            self.assertEqual(loc["page"], loc["target_page"])
            self.assertGreater(loc["target_page"], 10)
            self.assertEqual(loc["target"]["rows"][0]["s"], "bulk-0650")
            self.assertTrue(any(r["s"] == "bulk-0650" for sess in loc["rows"] for r in sess["rows"]))

            # Date sort + pagination cache + facet cache consistency
            d1 = entry.query_sessions({"sort": "date", "page": "1", "size": "50", "model": "aime_fast"})
            d2 = entry.query_sessions({"sort": "date", "page": "2", "size": "50", "model": "aime_fast"})
            d_loc = entry.query_sessions({"sort": "date", "case": "bulk-0120", "locate": "1", "size": "50", "model": "aime_fast"})
            self.assertEqual(d1["matched"], 702)
            self.assertEqual(d2["page"], 2)
            self.assertEqual(d_loc["page"], d_loc["target_page"])
            self.assertGreaterEqual(len(entry._order_cache), 1)
            self.assertGreaterEqual(len(entry._facet_cache), 1)

            # Lost split filter
            lost = entry.query_sessions({"split": "lost"})
            self.assertEqual(lost["matched"], 1)
            self.assertEqual(lost["rows"][0]["sid"], "sess-lost")

            # Trace-level human_read / raw stats (704 traces across 703 sessions: s0001 has hr=1, s0002 raw)
            self.assertEqual(p1["hr_stats"], {"hr": 1, "raw": 703, "total": 704, "hr_total": 1})
            self.assertEqual(p1["rows"][0].get("hr"), 1)
            self.assertEqual([r.get("hr") for r in p1["rows"][0]["rows"]], [1, None])
            hr_only = entry.query_sessions({"hr": "human_read"})
            self.assertEqual(hr_only["matched"], 1)
            self.assertEqual(hr_only["rows"][0]["sid"], "sess-shared")
            self.assertEqual(hr_only["hr_stats"], {"hr": 1, "raw": 703, "total": 704, "hr_total": 1})
            raw_only = entry.query_sessions({"hr": "raw"})
            self.assertEqual(raw_only["matched"], 702)
            self.assertEqual(raw_only["hr_stats"], {"hr": 1, "raw": 703, "total": 704, "hr_total": 1})

            # Galaxy slice stratifies and caps at 500 while reporting exact total & severity parts
            gx = entry.query_galaxy({"card": "vol", "model": "aime_fast"})
            self.assertEqual(gx["total"], 703)
            self.assertEqual(gx["recalled"], 500)
            self.assertTrue(gx["capped"])
            self.assertEqual(sum(gx["parts"]), 703)
            self.assertEqual(sum(len(g["items"]) for g in gx["groups"]), 500)
            # Highest severity row (P0) must survive capping
            all_slugs = {it["s"] for g in gx["groups"] for it in g["items"]}
            self.assertIn("s0002", all_slugs)

            # Eval single-day fast O(1) lookup caps cleanly at 500
            ev_day = entry.query_galaxy({"card": "eval", "d0": "2026-11-19", "d1": "2026-11-19", "model": "all"})
            self.assertEqual(ev_day["recalled"], 500)
            self.assertTrue(ev_day["capped"])

            # Attr model / severity / mechanism queries (Model -> P0-P4 -> M1-M7)
            att_mod = entry.query_galaxy({"card": "attr", "model": "aime_fast"})
            self.assertEqual(att_mod["recalled"], 500)
            self.assertEqual({g["key"] for g in att_mod["groups"]}, {"P0", "P1", "P3"})
            self.assertTrue(all(it["m"] == "aime_fast" and it["n"] > 0 for g in att_mod["groups"] for it in g["items"]))

            att_ms = entry.query_galaxy({"card": "attr", "model": "aime_fast", "sev": "P1"})
            self.assertGreater(att_ms["recalled"], 0)
            self.assertEqual(att_ms["groups"][0]["key"], "M1")
            self.assertEqual(att_ms["groups"][0]["items"][0]["s"], "s0001")

            att_s = entry.query_galaxy({"card": "attr", "sev": "P1"})
            self.assertEqual(att_s["groups"][0]["key"], "M1")
            self.assertEqual(att_s["groups"][0]["items"][0]["s"], "s0001")

            att_m = entry.query_galaxy({"card": "attr", "mech": "M1"})
            att_m_keys = {g["key"] for g in att_m["groups"]}
            self.assertTrue({"P1", "P2", "P3"}.issubset(att_m_keys))
            self.assertEqual(att_m["recalled"], 500)

            att_both = entry.query_galaxy({"card": "attr", "sev": "P1", "mech": "M1"})
            self.assertEqual(att_both["groups"][0]["key"], "S1")
            self.assertEqual(att_both["total"], 1)

            # Trend slice paginates lazily within day index, capped at 500
            tr1 = entry.query_trend({"date": "2026-11-19", "node": "S1.M1", "offset": "0", "limit": "30"})
            self.assertEqual(len(tr1["rows"]), 30)
            self.assertTrue(tr1["has_more"])
            self.assertTrue(tr1["capped"])
            self.assertEqual(tr1["recalled"], 500)

            # Session sibling lookup
            sib = entry.query_session({"sid": "sess-shared", "m": "aime_fast"})
            self.assertEqual([r["s"] for r in sib["rows"]], ["s0001", "s0002"])

            # Direct slug + tid lookup
            lk = entry.lookup(["s0003", "missing"], ["t-4"])
            self.assertEqual({r["s"] for r in lk["rows"]}, {"s0003", "s0004"})

    def test_input_lister_slice_inputs_bounds_at_500(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            datasets = root / "datasets"
            cache = root / "cache"
            static = root / "static"
            static.mkdir(parents=True)
            in_dir = datasets / "2_aime" / "eval_input" / "0_daily_eval_input" / "aime_fast"
            in_dir.mkdir(parents=True)
            jsonl_path = in_dir / "2026-11-19.jsonl"

            lines = []
            for i in range(600):
                rec = {
                    "meta": {
                        "question": f"输入问题 {i}",
                        "session_id": f"in-sid-{i}",
                        "request_time": "2026-11-19T10:00:00",
                        "task_category": "深度研究" if i % 2 == 0 else "实时行情",
                        "subtask_category": "研报解读" if i % 2 == 0 else "个股价格",
                    },
                    "traces": [{"meta": {"trace_id": f"in-tid-{i}"}}],
                }
                lines.append(json.dumps(rec, ensure_ascii=False))
            jsonl_path.write_text("\n".join(lines) + "\n", encoding="utf-8")

            # Mark line 1 (i=0) as paired/evaluated in sqlite store
            store = build_store.BuildStore(cache / "build.sqlite3")
            first_bytes = lines[0].encode("utf-8")
            ih0 = build_store.line_hash(first_bytes)
            store.db.execute(
                "INSERT INTO samples(slug,fp,oh,ih,ch,product,model,date,split,output,output_line,refs,row,facts,brief,golden,built_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                ("s-eval-0", "fp0", "oh0", f"{ih0:016x}", None, "aime", "aime_fast", "2026-11-19", "daily",
                 "out.jsonl", 1, "[]",
                 json.dumps({"s": "s-eval-0", "q": "输入问题 0", "w": "P4", "tr": 1, "task": "深度研究", "sub": "研报解读"}),
                 "{}", "{}", None, 0.0),
            )
            store.db.commit()
            store.close()

            _write_fixture(static, "aime", [])
            old_bstatic = build.STATIC
            build.STATIC = static
            lister = input_list.InputLister(datasets, cache / "build.sqlite3", cache, static)
            try:
                res = lister.slice_inputs("aime", model="aime_fast", cap=500)
                self.assertEqual(res["source"], "inputs")
                self.assertEqual(res["recalled"], 500)
                self.assertEqual(res["cap"], 500)
                self.assertTrue(res["capped"])
                done, pending = res["eval_counts"]
                self.assertEqual(done + pending, 500)
                self.assertGreaterEqual(done, 1)
                self.assertGreaterEqual(pending, 1)

                task_slice = lister.slice_inputs("aime", model="aime_fast", task="深度研究", cap=500)
                self.assertGreater(task_slice["recalled"], 0)
                self.assertTrue(all(it["cat"] == "深度研究" for g in task_slice["groups"] for it in g["items"]))
            finally:
                build.STATIC = old_bstatic
                st = getattr(lister._local, "store", None)
                if st is not None:
                    st.close()

    def test_query_field_proportional_paging(self):
        with tempfile.TemporaryDirectory() as tmp:
            static = Path(tmp)
            rows = [
                {"s": f"p0-{i}", "sid": f"s0-{i}", "tid": f"t0-{i}", "sp": "daily", "m": "aime_fast",
                 "d": "2026-11-19", "q": f"P0 问题 {i}", "w": "P0", "n": 3, "tr": 1, "ul": 1 if i == 0 else 0}
                for i in range(6)
            ] + [
                {"s": f"p2-{i}", "sid": f"s2-{i}", "tid": f"t2-{i}", "sp": "daily", "m": "aime_fast",
                 "d": "2026-11-19", "q": f"P2 问题 {i}", "w": "P2", "n": 1, "tr": 1}
                for i in range(12)
            ] + [
                {"s": "exp-0", "sid": "se-0", "tid": "te-0", "sp": "daily", "m": "aime_expert",
                 "d": "2026-11-19", "q": "Expert 问题", "w": "P1", "n": 2, "tr": 1}
            ]
            _write_fixture(static, "aime", rows)
            entry = recall_index.RecallStore().get(str(static), "aime")
            p1 = entry.query_field({"model": "aime_fast", "split": "", "page": "1", "cap": "6"})
            p2 = entry.query_field({"model": "aime_fast", "split": "", "page": "2", "cap": "6"})
            p3 = entry.query_field({"model": "aime_fast", "split": "", "page": "3", "cap": "6"})
            self.assertEqual((p1["total"], p1["pages"], len(p1["cells"])), (18, 3, 6))
            # Each page keeps the 1:2 mix of P0:P2 (2 P0 + 4 P2).
            for pg in (p1, p2, p3):
                self.assertEqual(sum(1 for c in pg["cells"] if c[1] == 0), 2)
                self.assertEqual(sum(1 for c in pg["cells"] if c[1] == 2), 4)
            all_slugs = {c[0] for pg in (p1, p2, p3) for c in pg["cells"]}
            self.assertEqual(len(all_slugs), 18)
            self.assertEqual(p1["cells"][0][4], 1)

    def test_trend_node_and_trace_sev_indexes(self):
        with tempfile.TemporaryDirectory() as tmp:
            static = Path(tmp)
            rows = [
                {"s": "a1", "sid": "sid1", "tid": "tid1", "sp": "daily", "m": "aime_fast", "d": "2026-11-19",
                 "q": "问题一", "w": "P0", "n": 1, "tr": 1},
            ]
            _write_fixture(static, "aime", rows)
            (static / "trends-aime.json").write_text(json.dumps({
                "schema": 2, "generated_at": "2026-11-19T12:00:00Z", "product": "aime",
                "releases": [], "dates": ["2026-11-19"], "uts": ["real"], "models": ["aime_fast"],
                "scenes": [["行情", ""]], "nodes": ["S1", "S2"],
                "base": [[0, 0, 0, 0, 1]],
                "cells": [
                    [0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 1],
                    [0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 1, 2, 1],
                ],
            }), encoding="utf-8")
            (static / "trace_refs-aime.json").write_text(json.dumps({
                "schema": 2, "generated_at": "2026-11-19T12:00:00Z", "product": "aime",
                "dates": ["2026-11-19"], "levels": ["P0", "P1", "P2", "P3", "P4", "none"],
                "refs": [[0, "a1", 0, 0, "tid1"]],
            }), encoding="utf-8")
            old_static = server.STATIC
            server.STATIC = str(static)
            server._TREND_NODE_CACHE.clear()
            server._TRACE_REFS_CACHE.clear()
            try:
                tidx = server.trend_node_index("aime")
                self.assertEqual(len(tidx["by_node"]["S2"]), 1)
                self.assertEqual(tidx["by_node"]["S2"][0][2], 0)
                entry = recall_index.RecallStore().get(str(static), "aime")
                res = server.Handler._query_trace_sev("aime", entry, {"date": "2026-11-19", "level": "P0", "cap": "50"})
                self.assertEqual(res["total"], 1)
                self.assertEqual((res["items"][0]["s"], res["items"][0]["trace"], res["items"][0]["w"]), ("a1", "tid1", 0))
            finally:
                server.STATIC = old_static
                server._TREND_NODE_CACHE.clear()
                server._TRACE_REFS_CACHE.clear()


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

                # Invalid slice mode returns 400 even with an If-None-Match header
                conn.request("GET", "/api/recall_slice/aime.json?mode=bogus", headers={"If-None-Match": etag})
                res400 = conn.getresponse()
                res400.read()
                self.assertEqual(res400.status, 400)

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
