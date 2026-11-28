"""Tests for trace lifecycle (reeval / eval_status) consistency across PG dashboard backend."""
from __future__ import annotations

import json
import sys
import tempfile
import unittest
from datetime import date, datetime, timezone
from pathlib import Path
from unittest import mock

DASHBOARD = Path(__file__).resolve().parents[1]
if str(DASHBOARD) not in sys.path:
    sys.path.insert(0, str(DASHBOARD))

import pg_backend  # noqa: E402


class _FakeResult:
    def __init__(self, rows):
        self._rows = list(rows)

    def fetchall(self):
        return list(self._rows)

    def fetchone(self):
        return self._rows[0] if self._rows else None


class _FakeCursor:
    def __init__(self, router, seen_sql):
        self._router = router
        self._seen_sql = seen_sql
        self._rows = []

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def execute(self, sql, params=None):
        s = " ".join(sql.split())
        self._seen_sql.append((s, params))
        self._rows = self._router(s, params)

    def __iter__(self):
        return iter(self._rows)

    def fetchall(self):
        return list(self._rows)

    def fetchone(self):
        return self._rows[0] if self._rows else None


class _FakeConn:
    def __init__(self, router, seen_sql):
        self._router = router
        self._seen_sql = seen_sql

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def cursor(self, name=None):
        return _FakeCursor(self._router, self._seen_sql)

    def execute(self, sql, params=None):
        s = " ".join(sql.split())
        self._seen_sql.append((s, params))
        return _FakeResult(self._router(s, params))


class LifecycleMappingTests(unittest.TestCase):
    def test_trace_lifecycle_state(self):
        fn = pg_backend._trace_lifecycle_state
        self.assertEqual(fn("evaluated", True), "evaluated")
        self.assertEqual(fn("evaluated", False), "pending")
        self.assertEqual(fn("pending", True), "reeval")
        self.assertEqual(fn("claimed", True), "reeval")
        self.assertEqual(fn("pending", False), "pending")
        self.assertEqual(fn("claimed", False), "pending")
        self.assertEqual(fn("failed", True), "failed")
        self.assertEqual(fn("failed", False), "failed")
        self.assertEqual(fn("skipped", True), "skipped")
        self.assertEqual(fn(None, True), "evaluated")
        self.assertEqual(fn("", False), "pending")


class DeriveBenchEvalFieldsTests(unittest.TestCase):
    def test_live_output_overrides_stale_bench_snapshot(self):
        # Case 1: Old bench_items snapshot was P0, new live output is GOLD with 0 problems.
        sev, prim, cnt, search = pg_backend._derive_bench_eval_fields(
            "P0",
            "S10.M2.8",
            {"primary": {"l1": "S10", "l2": "M2", "l3": "S10.M2.8"}},
            live_oid=999,
            live_max_sev="GOLD",
            live_prob_count=0,
            probs=[],
            pat_names={"S10.M2.8": "旧问题"},
        )
        self.assertEqual(sev, "GOLD")
        self.assertEqual(prim, {"l1": "NA", "l2": "NA", "l3": "NA", "label": "goldencase", "path": "", "path_source": "none"})
        self.assertEqual(cnt, 0)
        self.assertEqual(search, "")

        # Case 2: Old snapshot was GOLD, new live output is P1 with 2 problems (P2 and P1).
        sev2, prim2, cnt2, search2 = pg_backend._derive_bench_eval_fields(
            "GOLD",
            None,
            None,
            live_oid=1001,
            live_max_sev="P1",
            live_prob_count=2,
            probs=[
                {"severity": "P2", "label": "次要问题", "cluster_code": "S9.M1.1", "l1_stage": "S9", "l2_mechanism": "M1"},
                {"severity": "P1", "label": "核心问题", "cluster_code": "S10.M2.8", "l1_stage": "S10", "l2_mechanism": "S10.M2"},
            ],
            pat_names={"S10.M2.8": "目标错配"},
        )
        self.assertEqual(sev2, "P1")
        self.assertEqual(prim2["l1"], "S10")
        self.assertEqual(prim2["l2"], "M2")
        self.assertEqual(prim2["l3"], "S10.M2.8")
        self.assertEqual(prim2["label"], "核心问题")
        self.assertEqual(cnt2, 2)
        self.assertIn("核心问题", search2)

        # Case 3: No live output falls back cleanly to bench_items snapshot.
        sev3, prim3, cnt3, _ = pg_backend._derive_bench_eval_fields(
            "P2",
            "S1.M1.1",
            None,
            live_oid=None,
            live_max_sev=None,
            live_prob_count=None,
            probs=[],
            pat_names={"S1.M1.1": "工具未调用"},
        )
        self.assertEqual(sev3, "P2")
        self.assertEqual(prim3["l1"], "S1")
        self.assertEqual(prim3["l2"], "M1")
        self.assertEqual(prim3["label"], "工具未调用")
        self.assertEqual(cnt3, 0)


class PGInputListerLifecycleTests(unittest.TestCase):
    def test_listing_and_slice_inputs_status_and_slug_resolution(self):
        with tempfile.TemporaryDirectory() as tmp:
            cache = Path(tmp)
            # Slug map still pins old output_id 50 for input_id 1 (re-evaluated to new output_id 150)
            (cache / "pg-slug-map.json").write_text(
                json.dumps({"slug111111": [1, 50], "slug222222": [2, 51]}),
                encoding="utf-8",
            )
            seen_sql = []

            def router(sql, params):
                if "FROM public.eval_inputs i" in sql and "ORDER BY i.input_id ASC" in sql:
                    return [
                        {"input_id": 1, "trace_id": "t1", "session_id": "s1", "question_text": "q1", "task_category": "股", "request_time": None, "eval_status": "evaluated", "output_id": 150, "p0_cnt": 0, "p1_cnt": 1, "p2_cnt": 0, "p3_cnt": 0, "p4_cnt": 0},
                        {"input_id": 2, "trace_id": "t2", "session_id": "s2", "question_text": "q2", "task_category": "股", "request_time": None, "eval_status": "pending", "output_id": 51, "p0_cnt": 1, "p1_cnt": 0, "p2_cnt": 0, "p3_cnt": 0, "p4_cnt": 0},
                        {"input_id": 3, "trace_id": "t3", "session_id": "s3", "question_text": "q3", "task_category": "股", "request_time": None, "eval_status": "pending", "output_id": None, "p0_cnt": 0, "p1_cnt": 0, "p2_cnt": 0, "p3_cnt": 0, "p4_cnt": 0},
                        {"input_id": 4, "trace_id": "t4", "session_id": "s4", "question_text": "q4", "task_category": "股", "request_time": None, "eval_status": "failed", "output_id": None, "p0_cnt": 0, "p1_cnt": 0, "p2_cnt": 0, "p3_cnt": 0, "p4_cnt": 0},
                        {"input_id": 5, "trace_id": "t5", "session_id": "s5", "question_text": "q5", "task_category": "股", "request_time": None, "eval_status": "skipped", "output_id": 54, "p0_cnt": 0, "p1_cnt": 0, "p2_cnt": 0, "p3_cnt": 0, "p4_cnt": 0},
                    ]
                if "SELECT COUNT(*) AS c FROM public.eval_inputs" in sql:
                    return [{"c": 5}]
                if "LIMIT %s" in sql and "FROM public.eval_inputs i" in sql:
                    d0 = date(2026, 11, 27)
                    return [
                        {"input_id": 1, "model": "aime_fast", "biz_day": d0, "question_text": "q1", "task_category": "股", "subtask_category": "", "eval_status": "evaluated", "output_id": 150},
                        {"input_id": 2, "model": "aime_fast", "biz_day": d0, "question_text": "q2", "task_category": "股", "subtask_category": "", "eval_status": "claimed", "output_id": 51},
                        {"input_id": 3, "model": "aime_fast", "biz_day": d0, "question_text": "q3", "task_category": "股", "subtask_category": "", "eval_status": "pending", "output_id": None},
                        {"input_id": 4, "model": "aime_fast", "biz_day": d0, "question_text": "q4", "task_category": "股", "subtask_category": "", "eval_status": "failed", "output_id": None},
                    ]
                return []

            with mock.patch.object(pg_backend, "_load_pg_config", return_value=mock.MagicMock(data_root=cache)), \
                 mock.patch.object(pg_backend, "_ensure_pg", return_value=(None, lambda cfg, app_name="": _FakeConn(router, seen_sql), None, None)):
                lister = pg_backend.PGInputLister(cache)
                listing = lister.listing("aime", "2026-11-27", "aime_fast", "daily")
                by_r = {r["r"]: r for r in listing["rows"]}
                self.assertEqual(by_r["pg:1"]["es"], "evaluated")
                self.assertEqual(by_r["pg:1"]["ev"], 1)
                self.assertEqual(by_r["pg:1"]["s"], "slug111111")
                self.assertEqual(by_r["pg:1"]["sv"], [0, 1, 0, 0, 0])

                # Reeval row has ev=0, es="reeval", no stale slug or stale sv!
                self.assertEqual(by_r["pg:2"]["es"], "reeval")
                self.assertEqual(by_r["pg:2"]["ev"], 0)
                self.assertNotIn("s", by_r["pg:2"])
                self.assertNotIn("sv", by_r["pg:2"])

                self.assertEqual(by_r["pg:3"]["es"], "pending")
                self.assertEqual(by_r["pg:4"]["es"], "failed")
                self.assertEqual(by_r["pg:5"]["es"], "skipped")
                self.assertEqual(by_r["pg:5"]["ev"], 0)

                sl = lister.slice_inputs("aime", model="aime_fast", cap=100)
                self.assertEqual(sl["eval_counts"], [1, 3])
                self.assertEqual(sl["status_counts"], {"evaluated": 1, "reeval": 1, "pending": 1, "failed": 1})
                items = sl["groups"][0]["items"]
                by_id = {it["r"]: it for it in items}
                self.assertEqual(by_id["pg:1"]["s"], "slug111111")
                self.assertEqual(by_id["pg:2"]["s"], "")
                self.assertEqual(by_id["pg:2"]["es"], "reeval")


class PGDetailBuilderLifecycleTests(unittest.TestCase):
    def test_ensure_queries_live_is_latest_by_input_id(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            cache = root / "cache"
            samples_dir = root / "samples"
            cache.mkdir()
            (cache / "pg-slug-map.json").write_text(json.dumps({"a1b2c3d4e5": [42, 100]}), encoding="utf-8")
            seen_sql = []
            ts_new = datetime(2026, 11, 28, 7, 0, 0, tzinfo=timezone.utc)

            def router(sql, params):
                if "FROM public.eval_outputs o" in sql:
                    return [{
                        "input_id": 42, "product": "aime", "model": "aime_fast", "biz_day": date(2026, 11, 27),
                        "in_upd": ts_new, "eval_status": "evaluated",
                        "in_path": "in.zst", "input_offset": 0, "input_len": 10,
                        "output_id": 200, "out_upd": ts_new, "out_eval_at": ts_new,
                        "attr_path": "attr.zst", "attr_offset": 0, "attr_len": 10,
                        "comp_path": None, "compact_offset": None, "compact_len": None,
                        "hra_upd": None, "hra_path": None, "hra_off": None, "hra_len": None,
                        "hrc_upd": None, "hrc_path": None, "hrc_off": None, "hrc_len": None,
                    }]
                if "FROM public.eval_problems" in sql:
                    return [{"scope": "turn", "turn_index": 0, "problem_index": 0, "label": "新问题", "cluster_code": "S1.M1.1", "is_edge": False, "tags": [], "clustered_at": ts_new}]
                return []

            def fake_pread(path, offset, length):
                if str(path).endswith("attr.zst"):
                    return {"session_meta": {"trace_id": "t42", "session_id": "s42"}, "turns": []}
                return {"traces": [{"trace_id": "t42", "messages": []}]}

            cfg = mock.MagicMock(data_root=root)
            with mock.patch.object(pg_backend, "_load_pg_config", return_value=cfg), \
                 mock.patch.object(pg_backend, "_ensure_pg", return_value=(None, lambda cfg, app_name="": _FakeConn(router, seen_sql), None, fake_pread)):
                builder = pg_backend.PGDetailBuilder(samples_dir, cache)
                out_path = builder.ensure("a1b2c3d4e5")
                self.assertIsNotNone(out_path)
                payload = json.loads(out_path.read_text(encoding="utf-8"))
                self.assertEqual(payload["eval_status"], "evaluated")

            detail_sql, detail_params = next((s, p) for s, p in seen_sql if "FROM public.eval_outputs o" in s)
            self.assertIn("WHERE i.input_id = %s AND NOT i.is_deleted AND o.is_latest", detail_sql)
            self.assertEqual(detail_params, (42,))
            prob_sql, prob_params = next((s, p) for s, p in seen_sql if "FROM public.eval_problems" in s)
            self.assertEqual(prob_params, (200,))


class PGBuildAndBenchLifecycleTests(unittest.TestCase):
    def test_build_pg_bench_and_load_case_follow_latest_output(self):
        seen_sql = []
        d0 = date(2026, 11, 27)
        now = datetime(2026, 11, 28, 7, 0, 0, tzinfo=timezone.utc)

        def router(sql, params):
            if "FROM public.bench_sets" in sql:
                return [
                    {"bench_id": 1, "bench_key": "pool", "model": "aime_fast", "bench_type": "pool", "tier_size": None, "version": "1", "requested_count": 1, "actual_count": 2, "params": {"tiers": [500], "long_tiers": [10], "long_tokens": 65536}, "stats": {}, "built_at": now},
                    {"bench_id": 2, "bench_key": "t500", "model": "aime_fast", "bench_type": "tier", "tier_size": 500, "version": "1", "requested_count": 500, "actual_count": 1, "params": {}, "stats": {}, "built_at": now},
                ]
            if "FROM public.bench_items bi" in sql and "bi.extra->>'batch_id'" in sql:
                return [
                    {"severity": "P0", "turn_type": "single", "session_round": 1, "primary_cluster": "S10.M2.8", "batch_id": "2026-11-27", "grp": None, "biz_day": d0, "total_tokens": 1200, "output_id": 900, "max_severity": "GOLD", "problem_count": 0},
                ]
            if "SELECT DISTINCT ON (output_id)" in sql:
                return []
            if "FROM public.bench_items bi" in sql and "bi.input_id" in sql:
                return [{
                    "input_id": 77, "trace_id": "t77", "session_id": "s77", "rank": 0, "turn_type": "single",
                    "session_round": 1, "severity": "P0", "dup_question_cnt": 1, "question_text": "重评变成GOLD",
                    "primary_cluster": "S10.M2.8", "extra": {}, "biz_day": d0, "request_time": now,
                    "turn_index": 1, "total_tokens": 1200, "input_tokens": 800, "tool_count": 1,
                    "latency_ms": 2000, "source": "online", "eval_status": "pending",
                    "output_id": 900, "max_severity": "GOLD", "problem_count": 0,
                }]
            if "FROM public.eval_problems" in sql and "output_id = ANY" in sql:
                return []
            if "WHERE i.input_id = %s AND NOT i.is_deleted" in sql:
                return [{
                    "in_path": None, "input_offset": None, "input_len": None,
                    "question_text": "重评变成GOLD", "source": "online", "session_round": 1, "turn_index": 1,
                    "total_tokens": 1200, "input_tokens": 800, "tool_count": 1, "latency_ms": 2000,
                    "eval_status": "pending", "output_id": 900, "max_severity": "GOLD", "problem_count": 0,
                    "attr_path": None, "attr_offset": None, "attr_len": None,
                }]
            if "FROM public.eval_problems WHERE output_id = %s" in sql:
                return []
            return []

        conn = _FakeConn(router, seen_sql)
        taxonomy = {"stages": {}, "mechanisms": {}, "patterns": {}}
        summary, index = pg_backend._build_pg_bench(conn, taxonomy, trace_refs={}, generated="2026-11-28T07:00:00Z")
        self.assertEqual(summary["models"]["aime_fast"]["pool_stats"]["by_severity"], {"GOLD": 1})
        self.assertEqual(summary["models"]["aime_fast"]["pool_size"], 1)
        case = index["models"]["aime_fast"][0]
        self.assertEqual(case["severity"], "GOLD")
        self.assertEqual(case["primary"]["l1"], "NA")
        self.assertEqual(case["probs_count"], 0)
        self.assertEqual(case["eval_status"], "reeval")
        self.assertIsNone(case["slug"])

        with mock.patch.object(pg_backend, "_load_pg_config", return_value=mock.MagicMock(data_root=Path("/tmp"))), \
             mock.patch.object(pg_backend, "_ensure_pg", return_value=(None, lambda cfg, app_name="": conn, None, lambda *a: {})):
            # Simulate stale row loc pointing at old oid=100 while live output is oid=900 GOLD
            stale_row = {**case, "severity": "P0", "loc": ["pg", 77, 100]}
            loaded = pg_backend.pg_load_bench_case(stale_row)
            self.assertEqual(loaded["severity"], "GOLD")
            self.assertEqual(loaded["eval_status"], "reeval")
            self.assertEqual(loaded["problems"], [])

    def test_build_from_pg_excludes_reeval_from_evaluated_queries(self):
        seen_sql = []
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            out_dir = root / "out"
            out_dir.mkdir()

            def router(sql, params):
                if "SELECT COUNT(*)" in sql:
                    return [{"c": 0, "m": "1970-01-01"}]
                if "SELECT COALESCE(MAX(seq)" in sql:
                    return [{"s": 0, "c": 0}]
                if "SELECT user_id, user_type, is_lost FROM public.users" in sql:
                    return []
                if "FROM public.cluster_trees" in sql:
                    return []
                if "FROM public.eval_inputs" in sql:
                    return [
                        {"input_id": 1, "model": "aime_fast", "trace_id": "t1", "session_id": "s1", "user_id": "", "source": "", "runtime_mode": None, "biz_day": date(2026, 11, 27), "request_time": None, "question_text": "q1", "n_messages": 2, "total_tokens": 100, "input_tokens": 50, "output_tokens": 50, "cache_read_tokens": 0, "tool_count": 0, "latency_ms": 100, "has_visual": False, "task_category": "", "subtask_category": "", "has_input_blob": True, "eval_status": "evaluated"},
                        {"input_id": 2, "model": "aime_fast", "trace_id": "t2", "session_id": "s2", "user_id": "", "source": "", "runtime_mode": None, "biz_day": date(2026, 11, 27), "request_time": None, "question_text": "q2", "n_messages": 2, "total_tokens": 100, "input_tokens": 50, "output_tokens": 50, "cache_read_tokens": 0, "tool_count": 0, "latency_ms": 100, "has_visual": False, "task_category": "", "subtask_category": "", "has_input_blob": True, "eval_status": "pending"},
                    ]
                if "FROM public.eval_problems p" in sql:
                    return []
                if "FROM public.human_read_overlays" in sql:
                    return []
                if "o.max_severity = %s" in sql:
                    return []
                if "FROM public.eval_outputs o" in sql and "o.p0_cnt" in sql:
                    return [
                        {"output_id": 10, "input_id": 1, "model": "aime_fast", "trace_id": "t1", "biz_day": date(2026, 11, 27), "max_severity": "GOLD", "p0_cnt": 0, "p1_cnt": 0, "p2_cnt": 0, "p3_cnt": 0, "p4_cnt": 0, "problem_count": 0, "is_correct": True, "has_compact": False},
                    ]
                return []

            fake_rules = mock.MagicMock()
            fake_rules.from_file.return_value = mock.MagicMock(classify=lambda uid: ("unknown", False, False))
            cfg = mock.MagicMock(data_root=root)
            with mock.patch.object(pg_backend, "_load_pg_config", return_value=cfg), \
                 mock.patch.object(pg_backend, "_ensure_pg", return_value=(None, lambda cfg, app_name="": _FakeConn(router, seen_sql), fake_rules, lambda *a: {})):
                (shared, _shell), summary = pg_backend.build_from_pg(root, out_dir, log=lambda *a, **k: None)
                self.assertEqual(summary["pairs"], 1)
                aime_kpi = shared["products"]["aime"]
                # Check SQL filters strictly require i.eval_status = 'evaluated' and NOT i.is_deleted
                prob_sql = next(s for s, _ in seen_sql if "FROM public.eval_problems p" in s)
                out_sql = next(s for s, _ in seen_sql if "FROM public.eval_outputs o JOIN public.eval_inputs i" in s)
                self.assertIn("i.eval_status = 'evaluated'", prob_sql)
                self.assertIn("NOT i.is_deleted", prob_sql)
                self.assertIn("i.eval_status = 'evaluated'", out_sql)
                self.assertIn("NOT i.is_deleted", out_sql)
                self.assertTrue(aime_kpi["label"])

            aime_data = json.loads((out_dir / "data-aime.json").read_text(encoding="utf-8"))["products"]["aime"]
            self.assertEqual(aime_data["kpi"]["inputs"], 2)
            self.assertEqual(aime_data["kpi"]["traces"], 1)
            self.assertEqual(aime_data["kpi"]["sessions"], 1)
            self.assertEqual(aime_data["daily"][0]["inputs"], 2)
            self.assertEqual(aime_data["daily"][0]["evaluated"], 1)
            self.assertEqual(aime_data["daily"][0]["traces"], 1)
            aime_samples = json.loads((out_dir / "samples-aime.json").read_text(encoding="utf-8"))["products"]["aime"]["rows"]
            self.assertEqual([r["tid"] for r in aime_samples], ["t1"])


if __name__ == "__main__":
    unittest.main()
