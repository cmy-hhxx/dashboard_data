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


if __name__ == "__main__":
    unittest.main()
