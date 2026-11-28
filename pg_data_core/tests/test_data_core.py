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

    @unittest.skipUnless(os.environ.get("AIME_RUN_PG_TESTS") == "1", "Set AIME_RUN_PG_TESTS=1 to run PG integration tests")
    def test_requeue_and_soft_delete_live(self) -> None:
        from pg_data_core.config import load_config
        from pg_data_core.core import DataCore

        m_ut = "__ut_rq_del__"
        day = date(2026, 11, 26)
        with tempfile.TemporaryDirectory() as tmp:
            cfg = load_config(role="rw", data_root=tmp)
            with DataCore(cfg) as dc:
                try:
                    def _mk(tid: str) -> dict:
                        return {
                            "trace_id": tid,
                            "request_time": f"{day.isoformat()}T15:00:00Z",
                            "meta": {"trace_id": tid, "session_id": f"s_{tid}", "user_id": "10002", "question_text": tid},
                            "traces": [{"meta": {"trace_id": tid, "timestamp": f"{day.isoformat()}T15:00:00Z"}}],
                        }

                    r_eval = dc.ingest_daily_input(_mk("__ut_rq_eval__"), m_ut)
                    r_skip = dc.ingest_daily_input(_mk("__ut_rq_skip__"), m_ut)
                    id_eval = r_eval["input_id"]
                    id_skip = r_skip["input_id"]

                    # Commit an initial output for id_eval so eval_status='evaluated' & is_latest=TRUE
                    attr = {
                        "session_meta": {"trace_id": "__ut_rq_eval__", "session_id": "s___ut_rq_eval__", "user_id": "10002"},
                        "turns": [{"meta": {"trace_id": "__ut_rq_eval__"}, "summary": "v1", "problem": []}],
                    }
                    oids1 = dc.commit_daily_output(attr, m_ut, evaluator_version="v1", input_id=id_eval, fallback_day=day.isoformat())
                    self.assertEqual(len(oids1), 1)

                    # Mark id_skip as skipped with oversized error
                    claimed = dc.claim_pending_inputs(model=m_ut, worker_id="w_ut", limit=5)
                    self.assertEqual([c["input_id"] for c in claimed], [id_skip])
                    dc.fail_inputs("w_ut", [{"input_id": id_skip, "status": "skipped", "error": "message_too_large: 3MiB"}])

                    # 1. Requeue id_eval -> eval_status becomes pending, old eval_outputs(is_latest=TRUE) untouched!
                    dry_rq = dc.requeue_inputs(items=[{"model": m_ut, "trace_id": "__ut_rq_eval__"}], reason="reeval_r533", dry_run=True)
                    self.assertEqual(dry_rq["requeued"], 1)
                    rq = dc.requeue_inputs(items=[{"model": m_ut, "trace_id": "__ut_rq_eval__"}], reason="reeval_r533")
                    self.assertEqual(rq["requeued"], 1)
                    self.assertEqual(rq["requeued_ids"], [id_eval])

                    with dc.db.connection() as conn:
                        inp_row = conn.execute(
                            "SELECT eval_status, eval_attempts, extra FROM public.eval_inputs WHERE input_id = %s",
                            (id_eval,),
                        ).fetchone()
                        out_row = conn.execute(
                            "SELECT output_id, is_latest, evaluator_version FROM public.eval_outputs WHERE output_id = %s",
                            (oids1[0],),
                        ).fetchone()
                    self.assertEqual(inp_row["eval_status"], "pending")
                    self.assertEqual(inp_row["eval_attempts"], 0)
                    self.assertEqual(inp_row["extra"].get("requeue_reason"), "reeval_r533")
                    self.assertTrue(out_row["is_latest"])

                    # 2. Re-claim & commit r533 output -> atomically flips old output is_latest=FALSE
                    reclaimed = dc.claim_pending_inputs(model=m_ut, worker_id="w_ut", limit=5)
                    self.assertEqual([c["input_id"] for c in reclaimed], [id_eval])
                    oids2 = dc.commit_daily_output(attr, m_ut, evaluator_version="r533", input_id=id_eval, fallback_day=day.isoformat())
                    with dc.db.connection() as conn:
                        outs = conn.execute(
                            "SELECT output_id, evaluator_version, is_latest FROM public.eval_outputs WHERE input_id = %s ORDER BY output_id ASC",
                            (id_eval,),
                        ).fetchall()
                    self.assertEqual([(o["output_id"], o["evaluator_version"], o["is_latest"]) for o in outs], [
                        (oids1[0], "v1", False),
                        (oids2[0], "r533", True),
                    ])

                    # 3. Soft-delete id_skip via filter mode -> sets is_deleted, deleted_at, emits changes(op='delete')
                    del_dry = dc.delete_inputs(status="skipped", models=[m_ut], error_prefix="message_too_large", dry_run=True)
                    self.assertEqual(del_dry["deleted"], 1)
                    del_res = dc.delete_inputs(
                        status="skipped",
                        models=[m_ut],
                        error_prefix="message_too_large",
                        reason="drop_oversized_skipped",
                        refresh_views=False,
                    )
                    self.assertEqual(del_res["deleted"], 1)
                    self.assertEqual(del_res["deleted_ids"], [id_skip])

                    with dc.db.connection() as conn:
                        s_row = conn.execute(
                            "SELECT is_deleted, deleted_at, extra FROM public.eval_inputs WHERE input_id = %s",
                            (id_skip,),
                        ).fetchone()
                        chg = conn.execute(
                            "SELECT op, entity_type, output_id FROM public.changes WHERE input_id = %s AND op = 'delete'",
                            (id_skip,),
                        ).fetchone()
                    self.assertTrue(s_row["is_deleted"])
                    self.assertIsNotNone(s_row["deleted_at"])
                    self.assertEqual(s_row["extra"].get("delete_reason"), "drop_oversized_skipped")
                    self.assertIsNotNone(chg)
                    self.assertIsNone(chg["output_id"])

                    # 4. Re-ingesting the soft-deleted poison pill stays deduplicated & deleted
                    reing = dc.ingest_daily_input(_mk("__ut_rq_skip__"), m_ut)
                    self.assertTrue(reing["deduplicated"])
                    with dc.db.connection() as conn:
                        still_del = conn.execute("SELECT is_deleted FROM public.eval_inputs WHERE input_id = %s", (id_skip,)).fetchone()
                    self.assertTrue(still_del["is_deleted"])

                    # 5. Guardrail: deleting id_eval with allow_with_outputs=False skips it
                    guard = dc.delete_inputs(input_ids=[id_eval], allow_with_outputs=False)
                    self.assertEqual(guard["deleted"], 0)
                    self.assertEqual(guard["skipped_with_outputs"], 1)
                finally:
                    with dc.db.transaction() as conn:
                        conn.execute("DELETE FROM public.changes WHERE model = %s", (m_ut,))
                        conn.execute("DELETE FROM public.eval_inputs WHERE model = %s", (m_ut,))
                        conn.execute("DELETE FROM public.pack_files WHERE model = %s", (m_ut,))
                        conn.execute("DELETE FROM public.users WHERE user_id = %s", ("10002",))


class _FakeHTTPHandler:
    def __init__(
        self,
        method: str,
        path: str,
        body: dict | None = None,
        *,
        raw_body: bytes | None = None,
        headers: dict[str, str] | None = None,
        client_ip: str = "127.0.0.1",
    ):
        self.command = method
        self.path = path
        self.client_address = (client_ip, 12345)
        if raw_body is not None:
            raw = raw_body
        else:
            raw = json.dumps(body).encode("utf-8") if body is not None else b""
        self.headers = dict(headers or {})
        if raw and "Content-Length" not in self.headers:
            self.headers["Content-Length"] = str(len(raw))
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

    def text(self) -> str:
        return self.wfile.getvalue().decode("utf-8")

    def json(self) -> dict:
        return json.loads(self.text())


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
        self.assertIn("/docs/inputs-claim", h.json()["error"]["hint"])

    def test_post_requeue_and_delete_routing(self) -> None:
        app = self._make_app()
        app.dc.requeue_inputs.return_value = {
            "requested": 2,
            "requeued": 1,
            "requeued_ids": [101],
            "skipped_missing": 0,
            "skipped_deleted": 0,
            "skipped_no_blob": 0,
            "skipped_status": 1,
            "dry_run": True,
        }
        h_rq = _FakeHTTPHandler(
            "POST",
            "/api/v1/data-core/inputs/requeue",
            {
                "items": [
                    {"model": "aime_expert", "trace_id": "t1"},
                    {"model": "aime_fast", "trace_id": "t2"},
                ],
                "only_statuses": ["evaluated", "retrying"],
                "require_blob": True,
                "reset_attempts": False,
                "reason": "reeval_r533",
                "dry_run": True,
            },
        )
        app.handle_http(h_rq)
        self.assertEqual(h_rq.status, 200)
        self.assertEqual(h_rq.json()["data"]["requeued"], 1)
        app.dc.requeue_inputs.assert_called_once_with(
            items=[
                {"model": "aime_expert", "trace_id": "t1"},
                {"model": "aime_fast", "trace_id": "t2"},
            ],
            input_ids=None,
            only_statuses=["evaluated", "retrying"],
            require_blob=True,
            reset_attempts=False,
            reason="reeval_r533",
            dry_run=True,
        )

        # Delete with refresh_views=True triggers admin refresh when deleted > 0
        app.dc.delete_inputs.return_value = {
            "deleted": 58,
            "deleted_ids": [101, 102],
            "skipped_with_outputs": 0,
            "skipped_missing": 0,
            "skipped_deleted": 0,
            "views_refreshed": False,
            "dry_run": False,
        }
        with mock.patch.object(app, "_refresh_stats_views_admin", return_value={"stats_daily_overview": 0.1}) as m_ref:
            h_del = _FakeHTTPHandler(
                "POST",
                "/api/v1/data-core/inputs/delete",
                {
                    "status": "skipped",
                    "models": ["aime_fast", "aime_expert"],
                    "error_prefix": "message_too_large",
                    "allow_with_outputs": False,
                    "reason": "drop_oversized_skipped",
                    "refresh_views": True,
                },
            )
            app.handle_http(h_del)
            self.assertEqual(h_del.status, 200)
            self.assertTrue(h_del.json()["data"]["views_refreshed"])
            m_ref.assert_called_once_with(concurrently=True)

        # Delete view refresh failure degrades gracefully (still 200 because delete committed)
        app.dc.delete_inputs.return_value = {
            "deleted": 2,
            "deleted_ids": [10, 11],
            "skipped_with_outputs": 0,
            "skipped_missing": 0,
            "skipped_deleted": 0,
            "views_refreshed": False,
            "dry_run": False,
        }
        with mock.patch.object(app, "_refresh_stats_views_admin", side_effect=RuntimeError("view busy")):
            h_del2 = _FakeHTTPHandler("POST", "/api/v1/data-core/inputs/delete", {"input_ids": [10, 11]})
            app.handle_http(h_del2)
            self.assertEqual(h_del2.status, 200)
            self.assertFalse(h_del2.json()["data"]["views_refreshed"])
            self.assertIn("view busy", h_del2.json()["data"]["views_refresh_error"])

        # dry_run=True never refreshes views
        app.dc.delete_inputs.return_value = {
            "deleted": 5,
            "deleted_ids": [1, 2, 3, 4, 5],
            "skipped_with_outputs": 0,
            "skipped_missing": 0,
            "skipped_deleted": 0,
            "views_refreshed": False,
            "dry_run": True,
        }
        with mock.patch.object(app, "_refresh_stats_views_admin") as m_ref_dry:
            h_dry = _FakeHTTPHandler("POST", "/api/v1/data-core/inputs/delete", {"status": "skipped", "dry_run": True})
            app.handle_http(h_dry)
            self.assertEqual(h_dry.status, 200)
            self.assertTrue(h_dry.json()["data"]["dry_run"])
            m_ref_dry.assert_not_called()

    def test_embedded_docs_public_and_ergonomics(self) -> None:
        app = self._make_app()
        app.tokens = {"secret-tok"}
        app.allow_localhost = False

        # Public docs accessible WITHOUT token from remote IP
        h_root = _FakeHTTPHandler("GET", "/api/v1/data-core", client_ip="10.0.0.5")
        app.handle_http(h_root)
        self.assertEqual(h_root.status, 200)
        doc_data = h_root.json()["data"]
        slugs = {ep["slug"] for ep in doc_data["endpoints"]}
        self.assertIn("inputs-requeue", slugs)
        self.assertIn("inputs-delete", slugs)
        self.assertIn("docs", slugs)

        # Markdown view via query param & Accept header
        h_md = _FakeHTTPHandler("GET", "/api/v1/data-core/docs?format=markdown", client_ip="10.0.0.5")
        app.handle_http(h_md)
        self.assertEqual(h_md.status, 200)
        self.assertIn("text/markdown", h_md.resp_headers["Content-Type"])
        self.assertIn("/inputs/requeue", h_md.text())
        self.assertIn("/inputs/delete", h_md.text())

        # Single endpoint lookup by slug and by ?path=
        h_ep = _FakeHTTPHandler("GET", "/api/v1/data-core/docs/inputs-requeue", client_ip="10.0.0.5")
        app.handle_http(h_ep)
        self.assertEqual(h_ep.status, 200)
        self.assertEqual(h_ep.json()["data"]["path"], "/api/v1/data-core/inputs/requeue")

        h_ep_md = _FakeHTTPHandler("GET", "/api/v1/data-core/docs?path=/inputs/delete&format=md", client_ip="10.0.0.5")
        app.handle_http(h_ep_md)
        self.assertEqual(h_ep_md.status, 200)
        self.assertIn("POST /api/v1/data-core/inputs/delete", h_ep_md.text())

        # Unknown doc slug returns 404 with hint
        h_bad_doc = _FakeHTTPHandler("GET", "/api/v1/data-core/docs/nope", client_ip="10.0.0.5")
        app.handle_http(h_bad_doc)
        self.assertEqual(h_bad_doc.status, 404)
        self.assertIn("/docs", h_bad_doc.json()["error"]["hint"])

        # Auth header compatibility: X-API-Key accepted; missing token returns 401 with hint
        h_unauth = _FakeHTTPHandler("GET", "/api/v1/data-core/monitor/summary", client_ip="10.0.0.5")
        app.handle_http(h_unauth)
        self.assertEqual(h_unauth.status, 401)
        self.assertIn("X-API-Key", h_unauth.json()["error"]["hint"])

        app.dc.get_monitor_summary.return_value = {"db_epoch": "e1"}
        h_xkey = _FakeHTTPHandler(
            "GET",
            "/api/v1/data-core/monitor/summary",
            headers={"X-API-Key": "secret-tok"},
            client_ip="10.0.0.5",
        )
        app.handle_http(h_xkey)
        self.assertEqual(h_xkey.status, 200)

        # 405 on wrong method returns Allow header and hint
        h_405 = _FakeHTTPHandler(
            "GET",
            "/api/v1/data-core/inputs/requeue",
            headers={"X-API-Key": "secret-tok"},
            client_ip="10.0.0.5",
        )
        app.handle_http(h_405)
        self.assertEqual(h_405.status, 405)
        self.assertEqual(h_405.resp_headers.get("Allow"), "POST")
        self.assertIn("POST /api/v1/data-core/inputs/requeue", h_405.json()["error"]["hint"])

        # 404 on mistyped path suggests close match
        h_404 = _FakeHTTPHandler(
            "POST",
            "/api/v1/data-core/inputs/requeu",
            {},
            headers={"X-API-Key": "secret-tok"},
            client_ip="10.0.0.5",
        )
        app.handle_http(h_404)
        self.assertEqual(h_404.status, 404)
        self.assertIn("/inputs/requeue", h_404.json()["error"]["hint"])

        # Malformed JSON & non-integer detail id return 422 (not 500)
        h_bad_json = _FakeHTTPHandler(
            "POST",
            "/api/v1/data-core/inputs/requeue",
            raw_body=b"{not-json",
            headers={"X-API-Key": "secret-tok"},
            client_ip="10.0.0.5",
        )
        app.handle_http(h_bad_json)
        self.assertEqual(h_bad_json.status, 422)
        self.assertEqual(h_bad_json.json()["error"]["code"], "INVALID_PARAM")

        h_bad_id = _FakeHTTPHandler(
            "GET",
            "/api/v1/data-core/detail/not_an_int",
            headers={"X-API-Key": "secret-tok"},
            client_ip="10.0.0.5",
        )
        app.handle_http(h_bad_id)
        self.assertEqual(h_bad_id.status, 422)


class TestDataCoreRequeueAndDeleteLogic(unittest.TestCase):
    """Offline SQL & validation unit tests for `DataCore.requeue_inputs` and `DataCore.delete_inputs`."""

    def _make_dc(self, fetch_side_effects: list[list[dict]]):
        from contextlib import contextmanager
        from types import SimpleNamespace
        from pg_data_core.core import DataCore

        dc = object.__new__(DataCore)
        dc.cfg = SimpleNamespace(product="aime")
        dc.db_epoch = "epoch_ut"
        executed: list[tuple[str, Any]] = []
        queue = list(fetch_side_effects)

        class _FakeConn:
            def execute(self, sql, params=None):
                executed.append((sql, params))
                rows = queue.pop(0) if queue else []
                res = mock.MagicMock()
                res.fetchall.return_value = rows
                return res

        fake_conn = _FakeConn()

        @contextmanager
        def _ctx():
            yield fake_conn

        dc.db = SimpleNamespace(transaction=_ctx, connection=_ctx)
        return dc, executed

    def test_requeue_validation_and_buckets(self) -> None:
        dc, _ = self._make_dc([])
        with self.assertRaises(ValueError):
            dc.requeue_inputs()
        with self.assertRaises(ValueError):
            dc.requeue_inputs(input_ids=[1], items=[{"model": "m", "trace_id": "t"}])
        with self.assertRaises(ValueError):
            dc.requeue_inputs(input_ids=[1], only_statuses=["claimed"])
        with self.assertRaises(ValueError):
            dc.requeue_inputs(input_ids=[1], only_statuses=["bogus"])

        # Bucket classification + dedup + retrying support
        rows = [
            {"input_id": 1, "model": "m", "trace_id": "t1", "eval_status": "evaluated", "claimed_by": None, "has_input_blob": True, "is_deleted": False},
            {"input_id": 2, "model": "m", "trace_id": "t2", "eval_status": "claimed", "claimed_by": None, "has_input_blob": True, "is_deleted": False},
            {"input_id": 3, "model": "m", "trace_id": "t3", "eval_status": "claimed", "claimed_by": "va-1", "has_input_blob": True, "is_deleted": False},
            {"input_id": 4, "model": "m", "trace_id": "t4", "eval_status": "evaluated", "claimed_by": None, "has_input_blob": False, "is_deleted": False},
            {"input_id": 5, "model": "m", "trace_id": "t5", "eval_status": "evaluated", "claimed_by": None, "has_input_blob": True, "is_deleted": True},
        ]
        dc2, execs = self._make_dc([rows, [{"input_id": 1}, {"input_id": 2}]])
        res = dc2.requeue_inputs(
            input_ids=[1, 1, 2, 3, 4, 5, 999],
            only_statuses=["evaluated", "retrying"],
            reason="reeval_r533",
        )
        self.assertEqual(res["requested"], 6)
        self.assertEqual(res["requeued"], 2)
        self.assertEqual(res["requeued_ids"], [1, 2])
        self.assertEqual(res["skipped_missing"], 1)
        self.assertEqual(res["skipped_deleted"], 1)
        self.assertEqual(res["skipped_no_blob"], 1)
        self.assertEqual(res["skipped_status"], 1)  # input_id=3 active claimed skipped!
        self.assertFalse(res["dry_run"])
        self.assertEqual(len(execs), 2)
        self.assertNotIn("next_retry_at", execs[1][0])
        self.assertNotIn("eval_outputs", execs[1][0])

        # dry_run executes only SELECT, never UPDATE
        dc3, execs_dry = self._make_dc([rows])
        res_dry = dc3.requeue_inputs(input_ids=[1, 2, 3], only_statuses=["evaluated"], dry_run=True)
        self.assertTrue(res_dry["dry_run"])
        self.assertEqual(res_dry["requeued_ids"], [1])
        self.assertEqual(len(execs_dry), 1)
        self.assertNotIn("FOR UPDATE", execs_dry[0][0])

    def test_delete_validation_guardrails_and_changes_cte(self) -> None:
        dc, _ = self._make_dc([])
        with self.assertRaises(ValueError):
            dc.delete_inputs()
        with self.assertRaises(ValueError):
            dc.delete_inputs(status="evaluated")
        with self.assertRaises(ValueError):
            dc.delete_inputs(status="pending")
        with self.assertRaises(ValueError):
            dc.delete_inputs(status="claimed")
        with self.assertRaises(ValueError):
            dc.delete_inputs(status="skipped", input_ids=[1])

        # Filter mode skips rows with latest outputs when allow_with_outputs=False
        cand_rows = [
            {"input_id": 10, "is_deleted": False, "has_latest_output": False},
            {"input_id": 11, "is_deleted": False, "has_latest_output": True},
        ]
        dc2, execs = self._make_dc([cand_rows, [{"input_id": 10}]])
        res = dc2.delete_inputs(
            status="skipped",
            models=["aime_fast"],
            error_prefix="message_too_large",
            allow_with_outputs=False,
            reason="drop_oversized_skipped",
        )
        self.assertEqual(res["deleted"], 1)
        self.assertEqual(res["deleted_ids"], [10])
        self.assertEqual(res["skipped_with_outputs"], 1)
        self.assertFalse(res["views_refreshed"])
        self.assertIn("starts_with(", execs[0][0])
        self.assertIn("deleted_at = now()", execs[1][0])
        self.assertIn("INSERT INTO public.changes", execs[1][0])
        self.assertIn("'delete'", execs[1][0])

        # dry_run does not mutate or emit changes
        dc3, execs_dry = self._make_dc([cand_rows])
        res_dry = dc3.delete_inputs(status="failed", dry_run=True)
        self.assertTrue(res_dry["dry_run"])
        self.assertEqual(res_dry["deleted_ids"], [10])
        self.assertEqual(res_dry["skipped_with_outputs"], 1)
        self.assertEqual(len(execs_dry), 1)


if __name__ == "__main__":
    unittest.main()
