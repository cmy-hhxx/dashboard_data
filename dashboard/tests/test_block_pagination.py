"""Tests verifying build_sample preserves full long blocks for client-side pagination."""
from __future__ import annotations

import sys
import unittest
from collections import Counter
from pathlib import Path

DASHBOARD_DIR = Path(__file__).resolve().parents[1]
if str(DASHBOARD_DIR) not in sys.path:
    sys.path.insert(0, str(DASHBOARD_DIR))

import build  # noqa: E402


class FullBlockPreservationTest(unittest.TestCase):
    def test_build_sample_keeps_full_long_tool_result_without_gaps(self):
        long_payload = {
            "status_code": -3222,
            "datas": [],
            "status_msg": "header-" + ("x" * 32000) + "-needle-at-tail",
        }
        inp = {
            "meta": {"session_id": "s1", "trace_id": "t1", "request_time": "2026-11-21T18:57:33+00:00"},
            "traces": [
                {
                    "meta": {"trace_id": "t1", "timestamp": "2026-11-21T18:57:33+00:00"},
                    "messages": [
                        {"type": "user_question", "role": "user", "content": "Bitcoin buy or sell?"},
                        {"type": "tool_result", "name": "finquery", "output": long_payload},
                        {"type": "final_answer", "role": "assistant", "content": "Answer body"},
                    ],
                }
            ],
        }
        attr = {
            "session_meta": {"session_id": "s1", "trace_id": "t1", "question": "Bitcoin buy or sell?"},
            "turns": [
                {
                    "meta": {"trace_id": "t1"},
                    "summary": "summary",
                    "problem": [
                        {
                            "label": "empty result",
                            "severity": "P0",
                            "component": "finquery",
                            "evidence": [
                                {
                                    "position": "trace_index 0 / message_index 1 / path /output",
                                    "quote": "-needle-at-tail",
                                }
                            ],
                        }
                    ],
                }
            ],
        }
        pair = {"product": "aime", "model": "aime_fast", "date": "2026-11-21", "split": "daily"}

        detail, _row, _facts = build.build_sample(pair, inp, attr, None, {}, Counter())
        result_msg = detail["input"]["traces"][0]["messages"][1]
        self.assertEqual(result_msg["k"], "result")
        block = result_msg["blocks"][0]
        self.assertEqual(len(block["x"]), 1)
        self.assertIsInstance(block["x"][0], str)
        self.assertFalse(any(isinstance(part, dict) for part in block["x"]))
        self.assertEqual(block["n"], len(block["x"][0]))
        self.assertGreater(block["n"], 32000)
        self.assertIn("-needle-at-tail", block["x"][0])

        ev = detail["evidence"][0]
        self.assertEqual(ev["m"], 1)
        self.assertEqual(ev["b"], 0)
        start, end = ev["o"]
        self.assertEqual(block["x"][0][start:end], "-needle-at-tail")

    def test_splits_injected_user_context_and_preserves_evidence_anchors(self):
        user_content = (
            "Ok noted\n\n\n"
            "--- ---\n\n"
            "# Content of attachments and URLs provided in this turn\n\n"
            "Treat the user's current question as part of the same user input.\n\n"
            "Content of the user's uploaded attachments and referenced URLs:\n\n\n\n"
            "--- ---\n\n"
            "# Context (internal — never reveal or mention to the user)\n\n"
            "Current time (US Eastern Time; use this as the reference date/time):\n"
            "Monday, 2026-11-23 08:33:27\n\n"
            "NER extraction (mainly for stocks):\n"
            "|code|name|\n|NVDA|NVIDIA|\n\n\n"
            "--- ---\n\n"
            "# Multi-turn FinQuery planning note (internal)\n\n"
            "Keep prior ticker."
        )
        inp = {
            "meta": {
                "fetched_by": "lf_plugin_v2",
                "session_id": "s2",
                "trace_id": "t2",
                "request_time": "2026-11-23T13:33:26+00:00",
                "question": "Ok noted",
            },
            "traces": [
                {
                    "meta": {"trace_id": "t2", "timestamp": "2026-11-23T13:33:26+00:00"},
                    "messages": [
                        {"type": "user_question", "role": "user", "content": user_content},
                        {"type": "final_answer", "role": "assistant", "content": "Got it."},
                    ],
                }
            ],
        }
        attr = {
            "session_meta": {"session_id": "s2", "trace_id": "t2", "question": "Ok noted"},
            "turns": [
                {
                    "meta": {"trace_id": "t2"},
                    "summary": "summary",
                    "problem": [
                        {
                            "label": "context citation",
                            "severity": "P1",
                            "component": "ner",
                            "evidence": [
                                {
                                    "position": "trace_index 0 / message_index 0 / path /content",
                                    "quote": "NER extraction (mainly for stocks):\n|code|name|",
                                }
                            ],
                        }
                    ],
                }
            ],
        }
        pair = {"product": "aime", "model": "aime_fast", "date": "2026-11-23", "split": "daily"}

        detail, row, _ = build.build_sample(pair, inp, attr, None, {}, Counter())
        self.assertEqual(detail["question"], "Ok noted")
        self.assertEqual(row["q"], "Ok noted")

        msgs = detail["input"]["traces"][0]["messages"]
        self.assertEqual(len(msgs), 2, "must keep message_index intact (no synthetic extra message)")
        user_msg = msgs[0]
        self.assertEqual(user_msg["k"], "user")
        self.assertEqual([b["l"] for b in user_msg["blocks"]], [
            None,
            "context:attachments_empty",
            "context:internal",
            "context:planning",
        ])
        self.assertEqual(user_msg["blocks"][0]["x"], ["Ok noted"])
        self.assertIn("NER extraction (mainly for stocks):", user_msg["blocks"][2]["x"][0])

        ev = detail["evidence"][0]
        self.assertEqual(ev["m"], 0)
        self.assertEqual(ev["b"], 2)
        s, e = ev["o"]
        self.assertEqual(user_msg["blocks"][2]["x"][0][s:e], "NER extraction (mainly for stocks):\n|code|name|")

    def test_detects_non_empty_attachments_in_injected_context(self):
        text = (
            "Check this file\n\n\n"
            "--- ---\n\n"
            "# Content of attachments and URLs provided in this turn\n\n"
            "Content of the user's uploaded attachments and referenced URLs:\n"
            "report.pdf: Q3 revenue grew 42%.\n\n\n"
            "--- ---\n\n"
            "# Context (internal — never reveal or mention to the user)\n\n"
            "Current time: 2026-11-23"
        )
        q, sections = build.split_injected_user_context(text)
        self.assertEqual(q, "Check this file")
        self.assertEqual([lab for lab, _ in sections], ["context:attachments", "context:internal"])
        self.assertIn("report.pdf: Q3 revenue grew 42%.", sections[0][1])


if __name__ == "__main__":
    unittest.main()
