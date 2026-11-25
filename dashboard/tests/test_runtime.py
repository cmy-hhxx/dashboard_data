"""Runtime paths: the forecast feed, lazy details across threads and the HTTP server."""
import http.client
import json
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path

try:
    from dashboard.tests.test_empty_data import DASHBOARD, seed
except ImportError:  # `cd dashboard && python3 -m unittest discover -s tests`
    from test_empty_data import DASHBOARD, seed

import build  # noqa: E402  (test_empty_data puts dashboard/ on sys.path)

FEED = {
    "schema": 1, "product": "wencai", "as_of": "2026-11-02T00:00:00+08:00",
    "questions": [
        {"id": "2026-10-23/c1", "answer_at": "2026-10-26", "batch_id": "2026-10-23", "status": "revealed", "targets": 8},
        {"id": "2026-10-23/c2", "answer_at": "2026-11-20", "batch_id": "2026-10-23", "status": "pending", "targets": 2},
    ],
    "accuracy": [{"model": "a_fast", "at": "2026-11-02T00:00:00+08:00", "correct": 1, "total": 2}],
    "attribution": {"models": ["a_fast"], "errors": ["趋势外推"], "codes": ["trend_extrapolation"],
                    "flows": {"a_fast": [1]}},
    "labels": {"status": {"revealed": "已揭晓"}},
    "summary": {"extracted_questions": 40, "forecast_questions": 5,
                "by_status": {"revealed": 1, "pending": 1, "unresolved": 1, "unverifiable": 2},
                "by_batch": {"2026-10-24": {}, "2026-10-23": {}}},
    "sources": {"judge_run": "x"},
}


def run_build(datasets, static):
    proc = subprocess.run(
        [sys.executable, str(DASHBOARD / "build.py"), "--datasets", str(datasets), "--out", str(static)],
        check=True, capture_output=True, text=True,
    )
    return json.loads(proc.stdout.strip().splitlines()[-1])


class PredictionFeedTests(unittest.TestCase):
    def test_forecast_feed_is_slimmed_and_invalidates_reuse(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            datasets, static = root / "datasets", root / "static"
            seed(datasets)
            run_build(datasets, static)
            wencai = json.loads((static / "data-wencai.json").read_text())["products"]["wencai"]
            self.assertNotIn("prediction", wencai)

            feed = datasets / "4_forecast" / "wencai" / "prediction.json"
            feed.parent.mkdir(parents=True)
            feed.write_text(json.dumps(FEED, ensure_ascii=False), encoding="utf-8")
            items = [
                {"question": "茅台明天涨吗", "version": "a_fast", "status": "revealed", "result": "wrong",
                 "forecast_type_label": "个股走势", "error_cause_label": "趋势外推"},
                {"question": "大盘下周", "version": "a_fast", "status": "unverifiable", "result": None},
            ]
            (feed.parent / "prediction_items.jsonl").write_text(
                "".join(json.dumps(x, ensure_ascii=False) + "\n" for x in items), encoding="utf-8")
            summary = run_build(datasets, static)
            self.assertNotIn("reused", summary)
            pred = json.loads((static / "data-wencai.json").read_text())["products"]["wencai"]["prediction"]
            self.assertEqual(pred["questions"], [{"id": "2026-10-23/c1", "answer_at": "2026-10-26"},
                                                 {"id": "2026-10-23/c2", "answer_at": "2026-11-20"}])
            self.assertEqual((pred["bank"], pred["unverifiable"], pred["dates"]),
                             (40, 3, ["2026-10-23", "2026-10-24"]))
            self.assertEqual(pred["attribution"], {"models": ["a_fast"], "errors": ["趋势外推"],
                                                   "flows": {"a_fast": [1]}})
            self.assertEqual(pred["accuracy"], FEED["accuracy"])
            # Only judged answers reach the star map; unverifiable ones stay a count.
            item = pred["items"][0]
            self.assertEqual({k: item[k] for k in ("q", "v", "r", "t", "e")},
                             {"q": "茅台明天涨吗", "v": "a_fast", "r": "wrong", "t": "个股走势", "e": "趋势外推"})
            # 星图分组用类别 / 批次 / 题号；原始轨迹和预测正文都不进 items。
            self.assertEqual((item["c"], item["d"], item["i"]), ("其他", None, 0))
            self.assertNotIn("trajectory", item)
            for dropped in ("labels", "summary", "sources", "schema"):
                self.assertNotIn(dropped, pred)
            self.assertEqual(run_build(datasets, static).get("reused"), 1)

    def test_feed_lives_only_under_forecast_and_explicit_bank(self):
        with tempfile.TemporaryDirectory() as folder:
            datasets = Path(folder)
            # The pre-4_forecast location is no longer read.
            (datasets / "0_wencai").mkdir()
            (datasets / "0_wencai" / "prediction.json").write_text("{}", encoding="utf-8")
            self.assertIsNone(build.prediction_feed_path(datasets, "wencai"))
            self.assertIsNone(build.prediction_feed_path(datasets, "aime"))
            explicit = build.prediction_payload({**FEED, "bank": 7, "unverifiable": 0, "dates": ["2026-10-01"]})
            self.assertEqual((explicit["bank"], explicit["unverifiable"], explicit["dates"]), (7, 0, ["2026-10-01"]))
            self.assertEqual(build.prediction_payload({"questions": []}), {"questions": []})


class RuntimeTests(unittest.TestCase):
    def test_detail_builder_survives_thread_handoff(self):
        """The prewarm thread opens the SQLite store; request threads must reuse it."""
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            datasets, static = root / "datasets", root / "static"
            seed(datasets)
            run_build(datasets, static)
            slug = json.loads((static / "samples-wencai.json").read_text())["products"]["wencai"]["rows"][0]["s"]
            from detail_builder import DetailBuilder
            builder = DetailBuilder(datasets, root / "cache" / "build.sqlite3", static / "samples", root / "cache")
            opened = threading.Thread(target=builder._open)
            opened.start()
            opened.join()
            results = []
            worker = threading.Thread(target=lambda: results.append(builder.ensure(slug)))
            worker.start()
            worker.join()
            builder.close()
            self.assertEqual(results, [static / "samples" / f"{slug}.json"])
            detail = json.loads(results[0].read_text())
            self.assertEqual(detail["question"], "茅台今天收盘价")

    def test_missing_detail_answers_404_without_hanging(self):
        import server
        with tempfile.TemporaryDirectory() as folder:
            static = Path(folder)
            (static / "samples").mkdir()
            old_static, old_builder = server.STATIC, server._builder

            class NoDetails:
                def ensure(self, slug):
                    return None

            server.STATIC, server._builder = str(static), NoDetails()
            httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
            thread = threading.Thread(target=httpd.serve_forever, daemon=True)
            thread.start()
            try:
                conn = http.client.HTTPConnection("127.0.0.1", httpd.server_address[1], timeout=5)
                conn.request("GET", "/samples/0123456789.json")
                res = conn.getresponse()
                self.assertEqual((res.status, res.read()), (404, b"sample detail unavailable"))
                # Same keep-alive connection: the next request must still get through.
                conn.request("GET", "/healthz")
                res = conn.getresponse()
                self.assertEqual(res.status, 200)
                self.assertIn("ok", json.loads(res.read()))
                self.assertEqual(res.getheader("Cache-Control"), "no-store")
                conn.close()
            finally:
                httpd.shutdown()
                httpd.server_close()
                server.STATIC, server._builder = old_static, old_builder

    def test_warming_server_answers_data_with_retry_instead_of_refusing(self):
        import server
        httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        server._warming.set()
        try:
            conn = http.client.HTTPConnection("127.0.0.1", httpd.server_address[1], timeout=5)
            for path in ("/data.json", "/healthz"):
                conn.request("GET", path)
                res = conn.getresponse()
                self.assertEqual(res.status, 503)
                self.assertEqual(res.getheader("Retry-After"), "3")
                self.assertTrue(json.loads(res.read())["warming"])
            server._warming.clear()
            conn.request("GET", "/healthz")
            res = conn.getresponse()
            self.assertEqual(res.status, 200)
            res.read()
            conn.close()
        finally:
            server._warming.clear()
            httpd.shutdown()
            httpd.server_close()

    def test_survey_question_reads_as_text(self):
        survey = [{"header": "투자 대상 시장", "selected": ["아직 모르겠음"]},
                  {"header": "보유 기간", "selected": ["1주 이내", "1개월"]}]
        self.assertEqual(build.decode_question(survey), "투자 대상 시장：아직 모르겠음；보유 기간：1주 이내、1개월")
        self.assertEqual(build.decode_question("%E8%8C%85%E5%8F%B0"), "茅台")
        self.assertEqual(build.decode_question(None), "")



class AssetVersionTests(unittest.TestCase):
    def test_index_points_every_asset_at_the_content_hash(self):
        import server
        html = server.INDEX[0].decode("utf-8")
        version = server.ASSET_VERSION
        self.assertRegex(version, r"^[0-9a-f]{10}$")
        self.assertIn(f'src="v/{version}/js/app.js"', html)
        self.assertIn(f'href="v/{version}/css/base.css"', html)
        self.assertNotRegex(html, r'(href|src)="(js|css|vendor)/')
        # The site map is inlined so app.js needs no extra request to find the other server.
        self.assertIn('<script type="application/json" id="sites">', html)
        match = server.ASSET_RE.match(f"/v/{version}/js/kline_chart.js")
        self.assertEqual(match.group(2), "js/kline_chart.js")
        self.assertIsNone(server.ASSET_RE.match(f"/v/{version}/../server.py"))
        # Same content, same hash: two hosts serving one revision agree on every URL.
        self.assertEqual(server.asset_version(), version)


class SampleWorkerMemoryTests(unittest.TestCase):
    """A forked pool must stay inside the container's memory limit."""

    MB = 1 << 20

    def test_unbounded_container_keeps_the_requested_workers(self):
        self.assertEqual(build.capped_workers(4, headroom=None, rss=9_600 * self.MB), 4)
        self.assertEqual(build.capped_workers(1, headroom=0, rss=9_600 * self.MB), 1)

    def test_no_headroom_for_a_second_heap_goes_serial(self):
        # AIME: 9.6 GB parent, 2.4 GB left -> forking duplicating pages OOMs the cgroup.
        self.assertEqual(build.capped_workers(4, headroom=2_400 * self.MB, rss=9_600 * self.MB), 1)

    def test_middle_ground_keeps_the_largest_pool_that_fits(self):
        self.assertEqual(build.capped_workers(4, headroom=5_000 * self.MB, rss=2_000 * self.MB), 3)
        self.assertEqual(build.capped_workers(4, headroom=4_100 * self.MB, rss=2_000 * self.MB), 2)

    def test_server_headroom_guard_skips_when_low(self):
        import server
        self.assertIsNone(server._check_build_headroom(min_mb=4096, headroom_bytes=None))
        self.assertIsNone(server._check_build_headroom(min_mb=0, headroom_bytes=100 * self.MB))
        self.assertIsNone(server._check_build_headroom(min_mb=4096, headroom_bytes=5000 * self.MB))
        reason = server._check_build_headroom(min_mb=4096, headroom_bytes=2048 * self.MB)
        self.assertIn("2048MB", reason)
        self.assertIn("4096MB", reason)

    def test_build_store_uses_file_temp_store_and_lightweight_trace_ids(self):
        import build_store as bs
        with tempfile.TemporaryDirectory() as tmp:
            store = bs.BuildStore(Path(tmp) / "build.sqlite3")
            try:
                self.assertEqual(store.db.execute("PRAGMA temp_store").fetchone()[0], 1)
                store.put_file({
                    "path": "1_aime/eval_input/0_daily_eval_input/aime_expert/2026-11-25.jsonl",
                    "size": 10, "mtime_ns": 1, "prefix": "p", "lines": 2, "committed": 10,
                    "ends_nl": True, "offsets": [0, 5, 10], "keys": ["k1", "k2"],
                    "tids": [["tr1", "tr2"], ["tr3"]], "hashes": [1, 2],
                    "stats": bs.empty_stats(), "product": "aime", "model": "aime_expert",
                    "split": "daily", "tail": "t",
                })
                store.commit()
                self.assertEqual(store.input_trace_ids(), {"tr1", "tr2", "tr3"})
                self.assertEqual(store.input_trace_ids(), set(store.input_locations()))
            finally:
                store.close()


if __name__ == "__main__":
    unittest.main()
