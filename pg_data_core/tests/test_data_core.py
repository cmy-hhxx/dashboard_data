"""Unit and integration tests for Multi-Frame Zstd, Domain Models, DataCore, and reconcile_tails."""

from __future__ import annotations

import io
import json
import os
import tempfile
import unittest
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

from pg_data_core.models import (
    UserRules,
    apply_human_read_delta,
    compute_severity_summary,
    extract_human_read_delta,
    split_cluster_code,
)
from pg_data_core.zst_pack import (
    BulkPackWriter,
    append_frame_file,
    compress_record_line,
    iter_frames,
    pread_json,
)


class TestZstPack(unittest.TestCase):
    def test_multiframe_random_read_and_tail_scan(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / "part_0000.jsonl.zst"
            recs = [
                {"trace_id": f"t_{i}", "question": f"测试问句 {i}", "payload": "x" * (200 + i * 50)}
                for i in range(12)
            ]
            ptrs = []
            with BulkPackWriter(p, "part_0000.jsonl.zst") as w:
                for r in recs:
                    ptrs.append(w.write_record(r))
                committed_bulk = w.committed_bytes

            # Random O(1) pread verification
            for r, ptr in zip(recs, ptrs):
                got = pread_json(p, ptr.offset, ptr.length)
                self.assertEqual(got, r)

            # Append 3 more frames Blob-First
            extra_recs = [{"trace_id": f"tail_{i}", "v": i} for i in range(3)]
            for r in extra_recs:
                frame, _ = compress_record_line(r)
                off, ln = append_frame_file(p, frame, fsync=False)
                self.assertEqual(pread_json(p, off, ln), r)

            # Tail scan from committed_bulk must yield exact 3 tail records
            tail_frames = list(iter_frames(p, start_offset=committed_bulk))
            self.assertEqual(len(tail_frames), 3)
            self.assertEqual([pread_json(p, f.offset, f.length)["trace_id"] for f in tail_frames], ["tail_0", "tail_1", "tail_2"])

            # Simulate crash leaving garbage bytes at EOF: iter_frames must ignore cleanly
            with p.open("ab") as fh:
                fh.write(b"\x28\xb5\x2f\xfd\x00\x01\x02")
            tail_frames_after_crash = list(iter_frames(p, start_offset=committed_bulk, ignore_truncated_tail=True))
            self.assertEqual(len(tail_frames_after_crash), 3)


class TestModelsAndDelta(unittest.TestCase):
    def test_user_rules_and_cluster_split(self) -> None:
        rules = UserRules({"heuristics": {"real_user_id_max_digits": 10}, "lost": {"ids": ["12345"]}})
        self.assertEqual(rules.classify("12345"), ("real", True, True))
        self.assertEqual(rules.classify("12345678901"), ("test", False, False))
        self.assertEqual(rules.classify("alice"), ("test", False, False))
        self.assertEqual(split_cluster_code("S9.M5.1.3"), ("S9", "S9.M5", "S9.M5.1", "S9.M5.1.3"))
        self.assertEqual(compute_severity_summary([]), ("GOLD", True, 0, 0, 0, 0, 0))
        self.assertEqual(
            compute_severity_summary([{"severity": "P3"}, {"severity": "P1"}, {"severity": "P3"}]),
            ("P1", False, 0, 1, 0, 2, 0),
        )

    def test_human_read_delta_roundtrip(self) -> None:
        raw_attr = {
            "session_meta": {"trace_id": "t1", "huge_field": "A" * 5000},
            "session_summary": "raw sess",
            "turns": [
                {
                    "meta": {"trace_id": "t1"},
                    "summary": "raw sum",
                    "problem": [
                        {"label": "raw lbl", "severity": "P2", "reason": "raw rsn", "evidence": [{"id": 1}]}
                    ],
                }
            ],
        }
        hr_attr = {
            "_human_read": {"prompt_version": "v1.3", "model": "deepseek-v4.1-flash", "source_hash": "abc123"},
            "session_meta": raw_attr["session_meta"],
            "session_summary": "人话总评",
            "turns": [
                {
                    "meta": {"trace_id": "t1"},
                    "summary": "人话轮次总结",
                    "problem": [{"label": "人话标签", "severity": "P2", "reason": "人话原因"}],
                }
            ],
        }
        delta, labels, hr_hash = extract_human_read_delta(
            hr_attr, "attribution", trace_id="t1", model="aime_expert", biz_day="2026-11-25"
        )
        self.assertEqual(labels, ["人话标签"])
        self.assertTrue(len(hr_hash) == 16)
        self.assertNotIn("session_meta", delta)  # delta-only, zero full-line mirror!

        rebuilt = apply_human_read_delta(raw_attr, delta, "attribution")
        self.assertEqual(rebuilt["session_summary"], "人话总评")
        self.assertEqual(rebuilt["turns"][0]["summary"], "人话轮次总结")
        self.assertEqual(rebuilt["turns"][0]["problem"][0]["label"], "人话标签")
        self.assertEqual(rebuilt["turns"][0]["problem"][0]["evidence"], [{"id": 1}])  # original evidence preserved!


class TestLivePostgresDataCore(unittest.TestCase):
    """Runs against live PG 16 when AIME_RUN_PG_TESTS=1 (uses an isolated temp data_root)."""

    @unittest.skipUnless(os.environ.get("AIME_RUN_PG_TESTS") == "1", "Set AIME_RUN_PG_TESTS=1 to run PG integration tests")
    def test_blob_first_and_reconcile_tails(self) -> None:
        from pg_data_core.config import load_config
        from pg_data_core.core import DataCore
        from pg_data_core.reconcile import reconcile_tails

        with tempfile.TemporaryDirectory() as tmp:
            cfg = load_config(role="rw", data_root=tmp)
            with DataCore(cfg) as dc:
                rec = {
                    "trace_id": "__ut_reconcile_trace_001__",
                    "request_time": "2026-11-26T15:00:00Z",
                    "meta": {
                        "trace_id": "__ut_reconcile_trace_001__",
                        "session_id": "__ut_sess_1__",
                        "user_id": "999000111",
                        "question_text": "NVDA latest earnings?",
                        "total_tokens": 1234,
                        "tool_count": 2,
                    },
                    "traces": [{"meta": {"trace_id": "__ut_reconcile_trace_001__", "timestamp": "2026-11-26T15:00:00Z"}}],
                }
                res = dc.ingest_daily_input(rec, "aime_expert")
                inp_id = res["input_id"]
                ptr = res["pointer"]

                # Verify O(1) detail read
                detail = dc.read_daily_detail(inp_id)
                self.assertEqual(detail["input"]["trace_id"], "__ut_reconcile_trace_001__")

                # Simulate PG rollback (delete DB row & reset pack committed_bytes to 0 while blob stays on disk!)
                with dc.db.transaction() as conn:
                    conn.execute("DELETE FROM public.eval_inputs WHERE input_id = %s", (inp_id,))
                    conn.execute(
                        "UPDATE public.pack_files SET committed_bytes = 0, record_count = 0 WHERE rel_path = %s",
                        (ptr.rel_path,),
                    )

                # reconcile_tails must recover the record from disk blob!
                rep = reconcile_tails(dc, lookback_minutes=60)
                self.assertGreaterEqual(rep["records_recovered"], 1)

                with dc.db.connection() as conn:
                    recovered = conn.execute(
                        "SELECT input_id, question_text FROM public.eval_inputs WHERE trace_id = %s",
                        ("__ut_reconcile_trace_001__",),
                    ).fetchone()
                    self.assertIsNotNone(recovered)
                    self.assertEqual(recovered["question_text"], "NVDA latest earnings?")

                # Clean up test row & pack_file from PG
                with dc.db.transaction() as conn:
                    conn.execute("DELETE FROM public.eval_inputs WHERE trace_id = %s", ("__ut_reconcile_trace_001__",))
                    conn.execute("DELETE FROM public.pack_files WHERE rel_path = %s", (ptr.rel_path,))
                    conn.execute("DELETE FROM public.users WHERE user_id = %s", ("999000111",))

    @unittest.skipUnless(os.environ.get("AIME_RUN_PG_TESTS") == "1", "Set AIME_RUN_PG_TESTS=1 to run PG integration tests")
    def test_claim_lease_fail_outputs_human_read_and_monitor_summary(self) -> None:
        from pg_data_core.config import load_config
        from pg_data_core.core import DataCore

        m_fast = "__ut_fast__"
        m_exp = "__ut_expert__"
        uid_lost = "__ut_lost_user__"
        today = date(2026, 11, 26)
        day_prev = today - timedelta(days=1)
        day_old = today - timedelta(days=8)
        pack_paths: list[str] = []

        def _make_in(tid: str, sid: str, day: date, uid: str = "10001") -> dict:
            return {
                "trace_id": tid,
                "batch_id": day.isoformat(),
                "request_time": f"{day.isoformat()}T15:00:00Z",
                "meta": {
                    "trace_id": tid,
                    "session_id": sid,
                    "user_id": uid,
                    "question_text": f"q {tid}",
                },
                "traces": [{"meta": {"trace_id": tid, "timestamp": f"{day.isoformat()}T15:00:00Z"}}],
            }

        with tempfile.TemporaryDirectory() as tmp:
            cfg = load_config(role="rw", data_root=tmp)
            with DataCore(cfg) as dc:
                try:
                    # Seed: today(20% done on fast, 0% on expert), day_prev(80% done), day_old(pending backlog)
                    ids: dict[str, int] = {}
                    for i in range(5):
                        r = dc.ingest_daily_input(_make_in(f"__ut_t_f_{i}", f"__ut_s_f_{i}", today, uid_lost if i == 0 else "10001"), m_fast)
                        ids[f"t_f_{i}"] = r["input_id"]
                        pack_paths.append(r["pointer"].rel_path)
                    for i in range(2):
                        r = dc.ingest_daily_input(_make_in(f"__ut_t_e_{i}", f"__ut_s_e_{i}", today), m_exp)
                        ids[f"t_e_{i}"] = r["input_id"]
                        pack_paths.append(r["pointer"].rel_path)
                    for i in range(5):
                        r = dc.ingest_daily_input(_make_in(f"__ut_p_f_{i}", f"__ut_s_p_{i}", day_prev), m_fast)
                        ids[f"p_f_{i}"] = r["input_id"]
                        pack_paths.append(r["pointer"].rel_path)
                    r_old = dc.ingest_daily_input(_make_in("__ut_old_0", "__ut_s_old_0", day_old), m_fast)
                    ids["old_0"] = r_old["input_id"]
                    pack_paths.append(r_old["pointer"].rel_path)

                    with dc.db.transaction() as conn:
                        conn.execute("UPDATE public.users SET is_lost = TRUE WHERE user_id = %s", (uid_lost,))
                        conn.execute(
                            "UPDATE public.eval_inputs SET eval_status = 'evaluated' WHERE input_id = ANY(%s)",
                            ([ids["t_f_0"], ids["p_f_0"], ids["p_f_1"], ids["p_f_2"], ids["p_f_3"]],),
                        )

                    # 1 & 2. date_even prefers lowest completion day/model (today, m_exp at 0%), then balances
                    c1 = dc.claim_pending_inputs(models=[m_fast, m_exp], worker_id="w1", limit=1, strategy="date_even", priority_days=7)
                    self.assertEqual(len(c1), 1)
                    self.assertEqual(c1[0]["model"], m_exp)
                    self.assertEqual(c1[0]["biz_day"], today.isoformat())
                    self.assertTrue(c1[0]["rel_path"].endswith(".jsonl.zst"))
                    self.assertEqual(c1[0]["batch_id"], today.isoformat())
                    self.assertEqual(c1[0]["eval_attempts"], 1)
                    self.assertIn("T", c1[0]["lease_expires_at"])

                    # 2nd claim sees m_exp at 50% vs m_fast at 20% on today -> picks m_fast!
                    c2 = dc.claim_pending_inputs(models=[m_fast, m_exp], worker_id="w1", limit=1, strategy="date_even", priority_days=7)
                    self.assertEqual(c2[0]["model"], m_fast)
                    self.assertEqual(c2[0]["biz_day"], today.isoformat())

                    # 3. heartbeat: owner succeeds, non-owner returns 0
                    hb_ok = dc.heartbeat_inputs("w1", [c1[0]["input_id"]], lease_seconds=900)
                    self.assertEqual(hb_ok["renewed"], 1)
                    hb_bad = dc.heartbeat_inputs("w2", [c1[0]["input_id"]], lease_seconds=900)
                    self.assertEqual(hb_bad["renewed"], 0)

                    # 4. release: non-owner cannot release, owner releases and decrements eval_attempts
                    rel_bad = dc.release_inputs("w2", [c1[0]["input_id"]])
                    self.assertEqual(rel_bad["released"], 0)
                    rel_ok = dc.release_inputs("w1", [c1[0]["input_id"]], decrement_attempts=True)
                    self.assertEqual(rel_ok["released"], 1)
                    with dc.db.connection() as conn:
                        st = conn.execute(
                            "SELECT eval_status, eval_attempts FROM public.eval_inputs WHERE input_id = %s",
                            (c1[0]["input_id"],),
                        ).fetchone()
                        self.assertEqual((st["eval_status"], st["eval_attempts"]), ("pending", 0))

                    # 5. fail: skipped is terminal; transient failed enters retrying, then terminal after max_attempts
                    skipped_id = c2[0]["input_id"]
                    f_skip = dc.fail_inputs("w1", [{"input_id": skipped_id, "status": "skipped", "error": "too_large"}])
                    self.assertEqual(f_skip[0]["eval_status"], "skipped")
                    self.assertTrue(f_skip[0]["applied"])

                    c_retry = dc.claim_pending_inputs(model=m_exp, worker_id="w1", limit=1, biz_day=today)
                    rid = c_retry[0]["input_id"]
                    f_ret = dc.fail_inputs(
                        "w1",
                        [{"input_id": rid, "status": "failed", "error": "timeout", "retry_after_seconds": 300}],
                        max_attempts=2,
                    )
                    self.assertEqual(f_ret[0]["eval_status"], "retrying")
                    self.assertIn("next_retry_at", f_ret[0])

                    # Expire backoff and claim again (attempt 2 -> reaches max_attempts=2 -> terminal failed)
                    with dc.db.transaction() as conn:
                        conn.execute(
                            "UPDATE public.eval_inputs SET lease_expires_at = %s WHERE input_id = %s",
                            (datetime.now(timezone.utc) - timedelta(seconds=5), rid),
                        )
                    c_retry2 = dc.claim_pending_inputs(model=m_exp, worker_id="w1", limit=1, biz_day=today)
                    self.assertEqual(c_retry2[0]["input_id"], rid)
                    self.assertEqual(c_retry2[0]["eval_attempts"], 2)
                    f_term = dc.fail_inputs(
                        "w1",
                        [{"input_id": rid, "status": "failed", "error": "timeout again", "retry_after_seconds": 300}],
                        max_attempts=2,
                    )
                    self.assertEqual(f_term[0]["eval_status"], "failed")

                    # Drain remaining tier-0 and verify tier-1 (8 days old) is claimed last
                    rest = dc.claim_pending_inputs(models=[m_fast, m_exp], worker_id="w1", limit=20, strategy="date_even", priority_days=7)
                    self.assertEqual(rest[-1]["input_id"], ids["old_0"])
                    self.assertEqual(rest[-1]["biz_day"], day_old.isoformat())

                    # 6. commit_daily_output without timestamp uses eval_inputs.biz_day (not 1970/0101)
                    attr_no_ts = {
                        "session_meta": {"session_id": "__ut_s_f_0"},
                        "session_summary": "ok",
                        "turns": [
                            {
                                "meta": {"trace_id": "__ut_t_f_0"},
                                "summary": "turn ok",
                                "problem": [{"label": "p1", "severity": "P2", "component": "planner"}],
                            }
                        ],
                    }
                    comp_rec = {"turns": [{"plans": [{"content": "step 1"}]}]}
                    oids = dc.commit_daily_output(attr_no_ts, m_fast, compact_record=comp_rec, input_id=ids["t_f_0"])
                    self.assertEqual(len(oids), 1)
                    oid = oids[0]
                    with dc.db.connection() as conn:
                        pf_row = conn.execute(
                            """
                            SELECT pf.rel_path FROM public.eval_outputs o
                            JOIN public.pack_files pf ON pf.file_id = o.attr_file_id
                            WHERE o.output_id = %s
                            """,
                            (oid,),
                        ).fetchone()
                        self.assertIn("/2026/1126/", pf_row["rel_path"])
                        self.assertNotIn("1970/0101", pf_row["rel_path"])

                    # 7. human-read/pending & fail & done transition
                    pend = dc.list_pending_human_read(models=[m_fast], prompt_version="v1.3", limit=10)
                    self.assertEqual([(p["output_id"], p["target_kind"]) for p in pend], [(oid, "attribution"), (oid, "compact")])

                    dc.fail_human_read_overlay(output_id=oid, target_kind="attribution", prompt_version="v1.3", error="bad num")
                    pend_after_fail = dc.list_pending_human_read(models=[m_fast], prompt_version="v1.3", include_failed=False)
                    self.assertEqual([p["target_kind"] for p in pend_after_fail], ["compact"])
                    pend_retry = dc.list_pending_human_read(models=[m_fast], prompt_version="v1.3", include_failed=True)
                    self.assertEqual([p["target_kind"] for p in pend_retry], ["attribution", "compact"])

                    dc.commit_human_read_overlay(
                        output_id=oid,
                        target_kind="attribution",
                        hr_record={
                            "_human_read": {"prompt_version": "v1.3", "model": "deepseek"},
                            "session_summary": "人话总评",
                            "turns": [{"summary": "人话", "problem": [{"label": "人话标签"}]}],
                        },
                    )
                    pend_after_done = dc.list_pending_human_read(models=[m_fast], prompt_version="v1.3", include_failed=True)
                    self.assertEqual([p["target_kind"] for p in pend_after_done], ["compact"])

                    # 8. monitor/summary structure & 6-bucket consistency
                    summary = dc.get_monitor_summary(models=[m_fast, m_exp])
                    q = summary["queue"]
                    self.assertEqual(
                        q["total"],
                        q["evaluated"] + q["pending"] + q["claimed"] + q["retrying"] + q["failed"] + q["skipped"],
                    )
                    self.assertEqual(summary["totals"]["hr_attr_done"], 1)
                    self.assertEqual(summary["lost_user"]["input_traces"], 1)
                    cl_fast = next(c for c in summary["cluster"]["models"] if c["name"] == m_fast)
                    self.assertEqual(cl_fast["output_traces"], 1)
                    self.assertEqual(cl_fast["pending_traces"], 1)
                    self.assertEqual(cl_fast["clustered_traces"], 0)

                    # 9. bind_problem_clusters: batch diff-update, public.changes emission, monotonic data_cutoff
                    with dc.db.transaction() as conn:
                        trow = conn.execute(
                            """
                            INSERT INTO public.cluster_trees(
                                product, model, version, release_tag, is_current, data_cutoff, artifact_rel_dir
                            )
                            VALUES (%s, %s, '1.0', '__ut_v1_20261126', TRUE, '2026-11-26T10:00:00Z', 'cluster_tree/__ut_fast__/__ut_v1_20261126')
                            RETURNING tree_id
                            """,
                            (cfg.product, m_fast),
                        ).fetchone()
                        tid_tree = int(trow["tree_id"])
                        prow = conn.execute(
                            "SELECT problem_id FROM public.eval_problems WHERE output_id = %s LIMIT 1",
                            (oid,),
                        ).fetchone()
                        pid = int(prow["problem_id"])

                    st1 = dc.bind_problem_clusters(
                        [{"problem_id": pid, "cluster_code": "S1.M1.1", "is_edge": False, "tags": ["t1"]}],
                        tree_id=tid_tree,
                        cluster_version="1.0",
                        data_cutoff="2026-11-26T12:00:00Z",
                        return_stats=True,
                    )
                    self.assertEqual(st1, {"updated": 1, "changes_emitted": 1})

                    # Re-binding identical values must be a no-op (updated=0, changes=0) and earlier cutoff must not regress
                    st2 = dc.bind_problem_clusters(
                        [{"problem_id": pid, "cluster_code": "S1.M1.1", "is_edge": False, "tags": ["t1"]}],
                        tree_id=tid_tree,
                        cluster_version="1.0",
                        data_cutoff="2026-11-25T00:00:00Z",
                        return_stats=True,
                    )
                    self.assertEqual(st2, {"updated": 0, "changes_emitted": 0})
                    with dc.db.connection() as conn:
                        cutoff_now = conn.execute(
                            "SELECT data_cutoff FROM public.cluster_trees WHERE tree_id = %s",
                            (tid_tree,),
                        ).fetchone()["data_cutoff"]
                        self.assertEqual(cutoff_now, "2026-11-26T12:00:00Z")
                finally:
                    with dc.db.transaction() as conn:
                        conn.execute("DELETE FROM public.cluster_trees WHERE model = ANY(%s)", ([m_fast, m_exp],))
                        conn.execute("DELETE FROM public.changes WHERE model = ANY(%s)", ([m_fast, m_exp],))
                        conn.execute("DELETE FROM public.eval_inputs WHERE model = ANY(%s)", ([m_fast, m_exp],))
                        conn.execute("DELETE FROM public.pack_files WHERE model = ANY(%s)", ([m_fast, m_exp],))
                        conn.execute("DELETE FROM public.users WHERE user_id = ANY(%s)", ([uid_lost, "10001"],))


class _FakeHTTPHandler:
    def __init__(self, method: str, path: str, body: dict | None = None):
        self.command = method
        self.path = path
        self.client_address = ("127.0.0.1", 12345)
        raw = json.dumps(body).encode("utf-8") if body is not None else b""
        self.headers = {"Content-Length": str(len(raw))} if raw else {}
        self.rfile = io.BytesIO(raw)
        self.wfile = io.BytesIO()
        self.status: int | None = None
        self.resp_headers: dict[str, str] = {}

    def send_response(self, status: int) -> None:
        self.status = status

    def send_header(self, k: str, v: str) -> None:
        self.resp_headers[k] = v

    def end_headers(self) -> None:
        pass

    def json(self) -> dict:
        return json.loads(self.wfile.getvalue().decode("utf-8"))


class TestDataCoreHTTPRouting(unittest.TestCase):
    """Offline HTTP routing & parameter validation tests (no PG required)."""

    def _make_app(self):
        from pg_data_core.http_api import DataCoreHTTPApp

        app = object.__new__(DataCoreHTTPApp)
        app.log = lambda *_a, **_kw: None
        app.tokens = set()
        app.allow_localhost = True
        app.dc = mock.MagicMock()
        return app

    def test_get_human_read_pending_and_monitor_summary(self) -> None:
        app = self._make_app()
        app.dc.list_pending_human_read.return_value = [{"output_id": 1, "target_kind": "attribution"}]
        h = _FakeHTTPHandler("GET", "/api/v1/data-core/human-read/pending?models=aime_expert,aime_fast&dates=2026-11-26&kinds=attribution&prompt_version=v1.3&include_failed=1&limit=50")
        app.handle_http(h)
        self.assertEqual(h.status, 200)
        self.assertEqual(h.json()["data"]["items"], [{"output_id": 1, "target_kind": "attribution"}])
        app.dc.list_pending_human_read.assert_called_once_with(
            models=["aime_expert", "aime_fast"],
            dates=["2026-11-26"],
            kinds=["attribution"],
            prompt_version="v1.3",
            include_failed=True,
            limit=50,
        )

        app.dc.get_monitor_summary.return_value = {"db_epoch": "abc", "totals": {}}
        h2 = _FakeHTTPHandler("GET", "/api/v1/data-core/monitor/summary?models=aime_fast")
        app.handle_http(h2)
        self.assertEqual(h2.status, 200)
        self.assertEqual(h2.json()["data"]["db_epoch"], "abc")
        app.dc.get_monitor_summary.assert_called_once_with(models=["aime_fast"])

    def test_post_claim_heartbeat_release_fail_outputs_hr_fail(self) -> None:
        app = self._make_app()
        app.dc.claim_pending_inputs.return_value = [{"input_id": 1}]
        h = _FakeHTTPHandler(
            "POST",
            "/api/v1/data-core/inputs/claim",
            {"models": ["aime_fast", "aime_expert"], "worker_id": "va-0", "strategy": "date_even", "priority_days": 7, "include_payload": True},
        )
        app.handle_http(h)
        self.assertEqual(h.status, 200)
        app.dc.claim_pending_inputs.assert_called_once_with(
            model=None,
            models=["aime_fast", "aime_expert"],
            worker_id="va-0",
            limit=10,
            lease_seconds=600,
            strategy="date_even",
            priority_days=7,
            biz_day=None,
            include_payload=True,
        )

        app.dc.heartbeat_inputs.return_value = {"requested": 1, "renewed": 1, "renewed_ids": [1], "lease_expires_at": "2026-11-27T06:45:00+00:00"}
        h_hb = _FakeHTTPHandler("POST", "/api/v1/data-core/inputs/heartbeat", {"worker_id": "va-0", "input_ids": [1]})
        app.handle_http(h_hb)
        self.assertEqual(h_hb.status, 200)
        self.assertEqual(h_hb.json()["data"]["renewed"], 1)

        app.dc.release_inputs.return_value = {"requested": 1, "released": 1, "released_ids": [1]}
        h_rel = _FakeHTTPHandler("POST", "/api/v1/data-core/inputs/release", {"worker_id": "va-0", "input_ids": [1], "decrement_attempts": False})
        app.handle_http(h_rel)
        self.assertEqual(h_rel.status, 200)
        app.dc.release_inputs.assert_called_once_with(worker_id="va-0", input_ids=[1], decrement_attempts=False)

        app.dc.fail_inputs.return_value = [{"input_id": 1, "applied": True, "eval_status": "skipped", "eval_attempts": 1}]
        h_fail = _FakeHTTPHandler("POST", "/api/v1/data-core/inputs/fail", {"worker_id": "va-0", "items": [{"input_id": 1, "status": "skipped"}]})
        app.handle_http(h_fail)
        self.assertEqual(h_fail.status, 200)
        self.assertEqual(h_fail.json()["data"]["results"][0]["eval_status"], "skipped")

        app.dc.commit_daily_output.return_value = [99]
        h_out = _FakeHTTPHandler("POST", "/api/v1/data-core/outputs", {"model": "aime_fast", "attribution": {}, "input_id": 7, "fallback_day": "2026-11-26"})
        app.handle_http(h_out)
        self.assertEqual(h_out.status, 200)
        app.dc.commit_daily_output.assert_called_once_with(
            {},
            "aime_fast",
            compact_record=None,
            evaluator_version="v1",
            judge_model=None,
            eval_duration_ms=None,
            eval_cost_usd=None,
            input_id=7,
            fallback_day="2026-11-26",
        )

        app.dc.fail_human_read_overlay.return_value = {"output_id": 99, "target_kind": "attribution", "status": "failed"}
        h_hrf = _FakeHTTPHandler(
            "POST",
            "/api/v1/data-core/human-read/fail",
            {"output_id": 99, "target_kind": "attribution", "prompt_version": "v1.3", "error": "mismatch"},
        )
        app.handle_http(h_hrf)
        self.assertEqual(h_hrf.status, 200)
        self.assertEqual(h_hrf.json()["data"]["status"], "failed")

        app.dc.bind_problem_clusters.return_value = {"updated": 1, "changes_emitted": 1}
        h_cl = _FakeHTTPHandler(
            "POST",
            "/api/v1/data-core/clusters/bind",
            {
                "tree_id": 5,
                "cluster_version": "2.0",
                "data_cutoff": "2026-11-26T12:00:00Z",
                "bindings": [{"problem_id": 10, "cluster_code": "S1.M1.1"}],
            },
        )
        app.handle_http(h_cl)
        self.assertEqual(h_cl.status, 200)
        self.assertEqual(h_cl.json()["data"], {"updated": 1, "changes_emitted": 1})
        app.dc.bind_problem_clusters.assert_called_once_with(
            [{"problem_id": 10, "cluster_code": "S1.M1.1"}],
            tree_id=5,
            cluster_version="2.0",
            data_cutoff="2026-11-26T12:00:00Z",
            return_stats=True,
        )

    def test_validation_error_returns_422(self) -> None:
        app = self._make_app()
        app.dc.claim_pending_inputs.side_effect = ValueError("model or models is required")
        h = _FakeHTTPHandler("POST", "/api/v1/data-core/inputs/claim", {})
        app.handle_http(h)
        self.assertEqual(h.status, 422)
        self.assertEqual(h.json()["error"]["code"], "INVALID_PARAM")


if __name__ == "__main__":
    unittest.main()
