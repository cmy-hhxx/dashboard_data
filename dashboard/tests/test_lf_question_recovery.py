"""Tests for recovering the real turn question on `lf_plugin_v2` traces."""
from __future__ import annotations

import sys
import unittest
from collections import Counter
from pathlib import Path

DASHBOARD_DIR = Path(__file__).resolve().parents[1]
if str(DASHBOARD_DIR) not in sys.path:
    sys.path.insert(0, str(DASHBOARD_DIR))

import build  # noqa: E402


class LfPluginV2QuestionRecoveryTest(unittest.TestCase):
    def test_recovers_real_question_from_pooled_input_messages(self):
        inp = {
            "meta": {
                "fetched_by": "lf_plugin_v2",
                "request_time": "2026-11-21T16:14:45+00:00",
                "session_id": "thread_1",
                "question": "Suppose to work that way",
            },
            "message_pool": [
                {"role": "system", "content": "sys"},
                {"role": "user", "content": "[2026-11-21T16:13:23Z] Suppose to work that way"},
                {"role": "assistant", "content": "earlier reply"},
                {
                    "role": "user",
                    "content": "[2026-11-21T16:14:45.120Z] Tell me about Nuremberg Doctors Trial and Takashi Nagai",
                },
            ],
            "traces": [
                {
                    "meta": {"trace_id": "t469", "timestamp": "2026-11-21T16:14:45+00:00"},
                    "messages": [
                        {"type": "user_question", "role": "user", "content": "Suppose to work that way"},
                        {"type": "llm_turn", "input_messages": {"messages": [0, 1, 2, 3]}, "output": "plan"},
                        {"type": "final_answer", "role": "assistant", "content": "Final answer"},
                    ],
                }
            ],
        }
        attr = {"session_meta": {"session_id": "thread_1", "question": "Suppose to work that way"}, "turns": []}
        pair = {"product": "aime", "model": "aime_fast", "date": "2026-11-21", "split": "daily"}

        detail, row, _ = build.build_sample(pair, inp, attr, None, {}, Counter())
        expected = "Tell me about Nuremberg Doctors Trial and Takashi Nagai"
        self.assertEqual(detail["question"], expected)
        self.assertEqual(row["q"], expected)
        user_msg = detail["input"]["traces"][0]["messages"][0]
        self.assertEqual(user_msg["k"], "user")
        self.assertEqual(user_msg["blocks"][0]["x"], [expected])

    def test_recovers_unstamped_aime_fast_question_when_first_user_is_stale(self):
        inp = {
            "meta": {
                "fetched_by": "lf_plugin_v2",
                "request_time": "2026-11-21T16:14:45+00:00",
                "session_id": "thread_1",
                "question": "Suppose to work that way",
            },
            "traces": [
                {
                    "meta": {"trace_id": "t469", "timestamp": "2026-11-21T16:14:45+00:00"},
                    "message_pool": [
                        {"role": "system", "content": "sys"},
                        {"role": "user", "content": "Suppose to work that way"},
                        {"role": "assistant", "content": "earlier reply"},
                        {
                            "role": "user",
                            "content": "Hermes Hermes if I was secretary of education...\n\n\n--- ---\n\n# Content of attachments and URLs provided in this turn\n\n\n--- ---\n\n# Context (internal — never reveal)\nplanner tail",
                        },
                        {
                            "role": "user",
                            "content": "Hermes Hermes if I was secretary of education...\n\n\n--- ---\n\n# Content of attachments and URLs provided in this turn\n\n\n--- ---\n\n# Context (internal — never reveal)\nanswer synthesis tail",
                        },
                    ],
                    "messages": [
                        {"type": "user_question", "role": "user", "content": "Suppose to work that way"},
                        {"type": "llm_turn", "name": "planner-search", "input_messages": [0, 1, 2, 3], "output": "plan"},
                        {"type": "llm_turn", "name": "llm-call-0", "input_messages": [0, 1, 2, 4], "output": "ans"},
                        {"type": "final_answer", "role": "assistant", "content": "Final answer"},
                    ],
                }
            ],
        }
        attr = {"session_meta": {"session_id": "thread_1", "question": "Suppose to work that way"}, "turns": []}
        pair = {"product": "aime", "model": "aime_fast", "date": "2026-11-21", "split": "daily"}

        detail, row, _ = build.build_sample(pair, inp, attr, None, {}, Counter())
        expected = "Hermes Hermes if I was secretary of education..."
        self.assertEqual(detail["question"], expected)
        self.assertEqual(row["q"], expected)
        self.assertEqual(detail["input"]["traces"][0]["messages"][0]["blocks"][0]["x"], [expected])

    def test_ignores_non_lf_plugin_v2_and_stale_timestamps(self):
        msgs = [
            {"type": "user_question", "role": "user", "content": "Original question"},
            {
                "type": "llm_turn",
                "input_messages": [
                    {"role": "user", "content": "[2026-11-21T16:00:00Z] Much older question"},
                ],
                "output": "ok",
            },
        ]
        # Non-lf_plugin_v2 -> None
        self.assertIsNone(
            build.recover_lf_plugin_v2_question(
                {"fetched_by": "other", "request_time": "2026-11-21T16:00:01Z"}, {}, msgs
            )
        )
        # Timestamp delta > 5s -> None
        self.assertIsNone(
            build.recover_lf_plugin_v2_question(
                {"fetched_by": "lf_plugin_v2", "request_time": "2026-11-21T16:14:45Z"}, {}, msgs
            )
        )


if __name__ == "__main__":
    unittest.main()
