"""Unit and integration tests for Multi-Frame Zstd, Domain Models, DataCore, and reconcile_tails."""

from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path

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


if __name__ == "__main__":
    unittest.main()
