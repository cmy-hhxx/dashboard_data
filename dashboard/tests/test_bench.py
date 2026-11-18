"""Bench's two lists: the pipeline split when present, this build's cases otherwise."""
import json
import sys
import tempfile
import unittest
from pathlib import Path

DASHBOARD = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(DASHBOARD))
import bench_dynamic  # noqa: E402
import build  # noqa: E402


def write_jsonl(path, rows):
    path.write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows), encoding="utf-8")


def case(cid, trace, sev, n, when, counts=None):
    return {
        "bad_case_id": cid, "trace_id": trace, "question": f"问：{cid}", "model": "a_fast",
        "request_time": when, "severity": sev, "severity_counts": counts or {},
        "problem_count": n, "session_id": f"s-{cid}",
    }


class BenchPayloadTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp())

    def test_split_files_are_filtered_and_ordered(self):
        write_jsonl(self.root / "goldencase_aime.jsonl", [
            case("g1", "t1", "", 0, "2026-11-02T01:00:00Z"),
            case("g2", "t2", "", 0, "2026-11-03T01:00:00Z"),
            case("gX", "tx", "P2", 2, "2026-11-04T01:00:00Z"),      # not clean → dropped
        ])
        write_jsonl(self.root / "badcase_aime.jsonl", [
            case("b1", "t3", "P1", 2, "2026-11-02T01:00:00Z", {"P1": 1, "P3": 1}),
            case("b2", "t4", "P0", 1, "2026-11-01T01:00:00Z", {"P0": 1}),
            case("b3", "t5", "P2", 1, "2026-11-05T01:00:00Z"),      # P2 → not a Bench badcase
        ])
        payload = build.bench_payload(self.root, "aime", [], {"t1": "slug-g1", "t3": "slug-b1"})
        golden = payload["rows"]["golden"]
        bad = payload["rows"]["bad"]
        self.assertEqual([r["i"] for r in golden], ["g2", "g1"])
        self.assertEqual([r["i"] for r in bad], ["b2", "b1"])
        self.assertEqual(golden[1]["s"], "slug-g1")
        self.assertEqual(bad[1]["s"], "slug-b1")
        self.assertIsNone(golden[0]["s"])
        self.assertEqual(payload["kinds"]["golden"]["count"], 2)
        self.assertEqual(payload["kinds"]["bad"]["count"], 2)
        self.assertEqual(payload["kinds"]["bad"]["sev"], {"P0": 1, "P1": 1})
        self.assertNotIn("t", golden[0])

    def test_falls_back_to_the_builds_own_cases(self):
        samples = [
            ("clean", {}, {"w": "none", "n": 0, "q": "干净的题", "m": "a_fast", "d": "2026-11-01",
                           "sv": [0, 0, 0, 0, 0], "sid": "s1"}, {}),
            ("p1", {}, {"w": "P1", "n": 2, "q": "有 P1", "m": "a_fast", "d": "2026-11-02",
                        "sv": [0, 1, 1, 0, 0], "sid": "s2"}, {}),
            ("p2", {}, {"w": "P2", "n": 1, "q": "只有 P2", "m": "a_fast", "d": "2026-11-03",
                        "sv": [0, 0, 1, 0, 0], "sid": "s3"}, {}),
        ]
        payload = build.bench_payload(self.root, "wencai", samples, {})
        self.assertEqual([r["i"] for r in payload["rows"]["golden"]], ["clean"])
        self.assertEqual([r["i"] for r in payload["rows"]["bad"]], ["p1"])
        self.assertEqual(payload["rows"]["bad"][0]["c"], {"P1": 1, "P2": 1})
        self.assertEqual(payload["rows"]["bad"][0]["s"], "p1")

    def test_one_missing_file_falls_back_for_both_lists(self):
        write_jsonl(self.root / "goldencase_aime.jsonl", [case("g1", "t1", "", 0, "2026-11-02T01:00:00Z")])
        samples = [("p1", {}, {"w": "P1", "n": 1, "q": "bad", "m": "m", "d": "2026-11-02",
                               "sv": [0, 1, 0, 0, 0], "sid": "s"}, {})]
        payload = build.bench_payload(self.root, "aime", samples, {})
        self.assertEqual(payload["kinds"]["golden"]["count"], 0)
        self.assertEqual(payload["kinds"]["bad"]["count"], 1)


class DynamicBenchTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.bench = self.root / "3_dynamic_bench"
        self.exp = self.bench / "aime_expert"
        (self.exp / "stats").mkdir(parents=True)
        (self.exp / "long").mkdir(parents=True)
        self.cache = self.root / "cache"

        (self.bench / "manifest.json").write_text(json.dumps({
            "module": "bench_module",
            "version": "1.0.0",
            "channel": "aime",
            "params": {
                "seed": "20261118", "golden_share": 0.2, "p0_cap": 0.25,
                "long_tokens": 65536, "tiers": [1, 2], "models": ["aime_expert"],
            },
            "pool": {"cases_raw": 100, "cases_dedup": 60, "dup_collapsed": 30, "empty_question": 2},
            "quality": {"join_rate": 0.995},
            "models": {
                "aime_expert": {
                    "pool_size": 32, "base_pool": 30, "long_pool": 2,
                    "pool_by_severity": {"GOLD": 10, "P0": 4, "P1": 6, "P2": 5, "P3": 3, "P4": 2},
                    "pool_by_turn": {"single": 20, "multi": 10},
                },
            },
        }), encoding="utf-8")

        (self.exp / "pool_stats.json").write_text(json.dumps({
            "pool_size": 30,
            "by_severity": {"GOLD": 10, "P0": 4, "P1": 6, "P2": 5, "P3": 3, "P4": 2},
            "by_turn": {"single": 20, "multi": 10},
            "tokens": {"p50": 0, "p90": 32000, "p99": 62000},
            "dims": {
                "stage": [{"key": "S9", "bucket": "答案合成", "count": 20, "share": 0.6667}],
                "difficulty": [{"key": "L1", "bucket": "L1", "count": 30, "share": 1.0}],
            },
        }), encoding="utf-8")

        def raw_rec(tid, rank, sev, tok, rnd, group, problems, l1, l2, l3):
            return {
                "trace_id": tid, "session_id": f"sid_{tid}", "model": "aime_expert",
                "question": f"问句 {tid}", "request_time": "2026-11-18 10:00:00",
                "batch_id": "2026-11-18", "group": group,
                "turn": "multi" if rnd > 1 else "single", "session_round": rnd, "turn_index": rnd,
                "severity": sev,
                "primary": {"l1": l1, "l2": l2, "l3": l3},
                "problems": problems,
                "stats": {"total_tokens": tok, "input_tokens": int(tok * 0.8), "tool_count": 2, "latency": 8.5, "dup_question": 2 if sev == "P0" else 1},
                "meta": {"comefrom": "app", "recalled_from": "lost_user" if sev == "P0" else "", "tool_names_text": "stock_quote,fin_report"},
                "messages": [{"type": "user_question", "content": f"问句 {tid}"}, {"type": "final_answer", "content": "回答结论"}],
                "message_pool": [{"role": "user", "content": "上一轮"}] if rnd > 1 else [],
                "bench": {"tier": 2, "rank": rank, "seed": "20261118", "pool_size": 30},
            }

        row1 = raw_rec(
            "tid-1", 0, "P0", 12000, 4, "0_daily_eval",
            [{"severity": "P0", "label": "缺关键数字", "path": "S9.M6.1", "path_source": "join", "l1": "S9", "l2": "M6", "component": "synthesizer"}],
            "S9", "M6", "S9.M6.1",
        )
        row2 = raw_rec("tid-2", 1, "GOLD", 0, 1, "2_task_eval/0_lost_user_back_test", [], "", "", "")
        long1 = raw_rec("tid-long-1", 0, "GOLD", 72000, 3, "0_daily_eval", [], "", "", "")

        write_jsonl(self.exp / "tier_500.jsonl", [{**row1, "bench": {"tier": 500, "rank": 0}}])
        write_jsonl(self.exp / "tier_1000.jsonl", [{**row1, "bench": {"tier": 1000, "rank": 0}}, {**row2, "bench": {"tier": 1000, "rank": 1}}])
        write_jsonl(self.exp / "long" / "tier_10_long.jsonl", [{**long1, "bench": {"tier": 10, "rank": 0}}])
        write_jsonl(self.exp / "long" / "tier_20_long.jsonl", [{**long1, "bench": {"tier": 20, "rank": 0}}])

        for t, act in ((500, 1), (1000, 2)):
            (self.exp / "stats" / f"tier_{t}.json").write_text(json.dumps({
                "tier": t, "requested": t, "actual": act, "shortfall": 0,
                "severity_target": {"GOLD": 1, "P0": 1}, "severity_actual": {"P0": 1, "GOLD": act - 1},
                "stage_actual": {"S9": 1}, "mechanism_actual": {"M6": 1}, "turn_actual": {"multi": 1, "single": act - 1},
                "tokens": {"p50": 0, "p90": 12000, "p99": 12000},
            }), encoding="utf-8")
            (self.exp / "stats" / f"tier_{t}.coverage.csv").write_text(
                "dim,max_abs_delta_pp,n_keys,n_keys_missing,tolerance_pp,by_design,ok\n"
                "day,2.5,1,0,10.0,no,yes\n"
                "difficulty,1.0,1,0,10.0,no,yes\n", encoding="utf-8",
            )
            (self.exp / "stats" / f"tier_{t}.crosstab_stage_mechanism.csv").write_text(
                "stage,stage_name,M1,M2,M3,M4,M5,M6,M7,NA,bench_total,pool_total\n"
                "S9,答案合成,0,0,0,0,0,1,0,0,1,20\n"
                "NA,NA,0,0,0,0,0,0,0,1,1,10\n"
                "TOTAL,,0,0,0,0,0,1,0,1,2,30\n", encoding="utf-8",
            )
            (self.exp / "stats" / f"tier_{t}.dim_mechanism.csv").write_text(
                "dim,key,bucket,count,share_in_bench,share_in_pool,delta_pp\n"
                "mechanism,M6,无依据断言,1,0.5,0.2,30.0\n", encoding="utf-8",
            )
            (self.exp / "stats" / f"tier_{t}.dim_pattern.csv").write_text(
                "dim,key,bucket,count,share_in_bench,share_in_pool,delta_pp\n"
                "pattern,S9.M6.1,无依据断言数字,1,0.5,0.2,30.0\n", encoding="utf-8",
            )
            (self.exp / "stats" / f"tier_{t}.dim_difficulty.csv").write_text(
                "dim,key,bucket,count,share_in_bench,share_in_pool,delta_pp\n", encoding="utf-8",
            )

    def tearDown(self):
        self._tmp.cleanup()

    def test_build_dynamic_bench_filters_difficulty_and_indexes_offsets(self):
        self.assertIsNotNone(bench_dynamic.dynamic_bench_root(self.root, "aime"))
        self.assertIsNone(bench_dynamic.dynamic_bench_root(self.root, "wencai"))

        refs = {"tid-1": ("slug-1", "daily|aime_expert|sid_tid-1")}
        summary, index = bench_dynamic.build_dynamic_bench(self.root, "aime", refs, self.cache)
        self.assertEqual(summary["schema"], 2)
        self.assertEqual(summary["stage_names"]["S9"], "答案合成")
        self.assertEqual(summary["mech_names"]["M6"], "无依据断言")
        self.assertEqual(summary["pat_names"]["S9.M6.1"], "无依据断言数字")

        exp = summary["models"]["aime_expert"]
        self.assertNotIn("difficulty", exp["pool_stats"].get("dims") or {})
        self.assertFalse(any(c["dim"] == "difficulty" for c in exp["tiers"]["500"]["coverage"]))
        self.assertEqual(exp["long_tiers"]["10"]["actual"], 1)

        cases = index["models"]["aime_expert"]
        by_tid = {c["trace_id"]: c for c in cases}
        self.assertEqual(by_tid["tid-1"]["bench"]["min_tier"], 500)
        self.assertEqual(by_tid["tid-2"]["bench"]["min_tier"], 1000)
        self.assertEqual(by_tid["tid-long-1"]["bench"]["long_tier"], 10)
        self.assertEqual(by_tid["tid-1"]["slug"], "slug-1")
        self.assertNotIn("loc", bench_dynamic.public_case_row(by_tid["tid-1"]))

        # Filtering and lazy byte-offset reading
        t500_only = [c for c in cases if bench_dynamic.case_matches_query(c, {"model": "aime_expert", "tier": "500", "long": "0"})]
        self.assertEqual([c["trace_id"] for c in t500_only], ["tid-1"])
        full = bench_dynamic.load_bench_case(self.root, by_tid["tid-1"])
        self.assertEqual(full["messages"][1]["content"], "回答结论")
        self.assertEqual(full["meta"]["tool_names"], ["stock_quote", "fin_report"])
        self.assertEqual(full["slug"], "slug-1")

        # Traversal protection on locator
        evil = {**by_tid["tid-1"], "loc": ["../../etc/passwd", 0, 10]}
        self.assertIsNone(bench_dynamic.load_bench_case(self.root, evil))

        # Cache reuse preserves updated trace_refs
        summary2, index2 = bench_dynamic.build_dynamic_bench(self.root, "aime", {"tid-2": ("slug-2", "daily|aime_expert|sid_tid-2")}, self.cache)
        by_tid2 = {c["trace_id"]: c for c in index2["models"]["aime_expert"]}
        self.assertEqual(by_tid2["tid-2"]["slug"], "slug-2")
        self.assertIsNone(by_tid2["tid-1"]["slug"])


class BenchRouteTests(unittest.TestCase):
    def setUp(self):
        import http.client
        import threading
        from http.server import ThreadingHTTPServer
        import server as srv_mod

        self._bench_case = DynamicBenchTests()
        self._bench_case.setUp()
        self.static = Path(self._bench_case.root) / "static"
        self.static.mkdir(parents=True)
        refs = {"tid-1": ("slug-1", "daily|aime_expert|sid_tid-1")}
        summary, index = bench_dynamic.build_dynamic_bench(self._bench_case.root, "aime", refs, self._bench_case.cache)
        (self.static / "bench-aime.json").write_text(json.dumps(summary), encoding="utf-8")
        (self.static / "bench_index-aime.json").write_text(json.dumps(index), encoding="utf-8")

        import build as bmod
        self._orig = (srv_mod.STATIC, bmod.default_datasets)
        srv_mod.STATIC = str(self.static)
        srv_mod._BENCH_CACHE.clear()
        srv_mod._BENCH_INDEX_CACHE.clear()
        bmod.default_datasets = lambda: self._bench_case.root
        self._srv = ThreadingHTTPServer(("127.0.0.1", 0), srv_mod.Handler)
        self._srv_mod = srv_mod
        self._bmod = bmod
        self._t = threading.Thread(target=self._srv.serve_forever, daemon=True)
        self._t.start()
        self.port = self._srv.server_address[1]
        self._http_client = http.client

    def tearDown(self):
        self._srv.shutdown()
        self._srv.server_close()
        self._srv_mod.STATIC, self._bmod.default_datasets = self._orig
        self._srv_mod._BENCH_CACHE.clear()
        self._srv_mod._BENCH_INDEX_CACHE.clear()
        self._bench_case.tearDown()

    def _get(self, path):
        conn = self._http_client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        try:
            conn.request("GET", path)
            resp = conn.getresponse()
            return resp.status, json.loads(resp.read().decode("utf-8"))
        finally:
            conn.close()

    def test_serves_summary_fields_cases_and_lazy_bench_case(self):
        st, d = self._get("/bench/aime.json?view=summary")
        self.assertEqual((st, d["schema"]), (200, 2))

        st, d = self._get("/bench/aime.json?view=fields&model=aime_expert&tier=500&long=0")
        self.assertEqual((st, d["total"]), (200, 1))
        self.assertEqual(d["cases"][0]["trace_id"], "tid-1")
        self.assertNotIn("loc", d["cases"][0])

        st, d = self._get("/bench/aime.json?view=cases&model=aime_expert&tier=1000&long=0&sev=P0")
        self.assertEqual((st, d["total"]), (200, 1))

        st, d = self._get("/bench_case/aime/aime_expert/tid-1.json")
        self.assertEqual(st, 200)
        self.assertEqual(d["messages"][1]["content"], "回答结论")
        self.assertEqual(d["slug"], "slug-1")

        st, _ = self._get("/bench_case/aime/aime_expert/missing-tid.json")
        self.assertEqual(st, 404)


if __name__ == "__main__":
    unittest.main()
