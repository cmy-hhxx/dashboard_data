"""Tests for seamless human_read_overlay + HumanReadStore compatibility."""
from __future__ import annotations

import copy
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "dashboard"))
sys.path.insert(0, str(ROOT))

import human_read_overlay as hro
from human_read_module.store import HumanReadStore, record_key_for_record, text_fingerprint_for_record


class TestHumanReadOverlay(unittest.TestCase):
    def test_seamless_overlay_and_fallback(self):
        with tempfile.TemporaryDirectory() as tmp:
            datasets = Path(tmp)
            hr_root = datasets / "1_aime" / "eval_output" / "human_read"

            orig_attr = {
                "session_meta": {
                    "session_id": "thread_abc",
                    "request_time": "2026-11-23T10:00:00Z",
                    "question": "Test question",
                },
                "turns": [
                    {
                        "meta": {"trace_id": "trace-111"},
                        "summary": "原版点评",
                        "problem": [
                            {
                                "label": "原版标题",
                                "problem_phenomena": "原版现象",
                                "reason": "原版原因",
                                "severity": "P0",
                                "severity_reason": "原版定级",
                                "component": "答案合成·取值",
                                "evidence": [{"position": "trace_index 0 / message_index 1 / path /content", "quote": "foo"}],
                            }
                        ],
                    }
                ],
            }
            orig_comp = {
                "session_meta": {"session_id": "thread_abc", "request_time": "2026-11-23T10:00:00Z"},
                "trace_meta": [{"trace_id": "trace-111"}],
                "turns": [
                    {
                        "turn_idx": 0,
                        "plans": [{"step_idx": 1, "content": "原版规划", "evidence": []}],
                        "execution_chain": [{"step_idx": 1, "content": "原版执行", "evidence": []}],
                        "components": [{"components_name": "答案合成", "components_kind": "model", "components_content": "原版概览", "evidence": []}],
                    }
                ],
            }

            base_detail = {
                "attribution": {
                    "summary": None,
                    "turns": [{"summary": "原版点评", "problems": [0], "trace_id": "trace-111"}],
                    "session_problems": [],
                    "problems": [
                        {
                            "id": 0, "sev": "P0", "label": "原版标题", "ph": "原版现象",
                            "why": "原版原因", "sevr": "原版定级", "comp": "答案合成·取值",
                            "ev": [0], "cl": {"path": "S9.M2.2.1", "edge": False, "tags": []},
                        }
                    ],
                },
                "compact": {
                    "overview": [],
                    "turns": [
                        {
                            "turn": 0,
                            "plans": [{"c": "原版规划", "ev": []}],
                            "reasoning": [],
                            "execution": [{"c": "原版执行", "ev": []}],
                            "reflections": [],
                            "tool_errors": [],
                            "artifacts": [],
                            "components": [{"name": "答案合成", "kind": "model", "c": "原版概览", "ev": []}],
                        }
                    ],
                },
            }

            overlay = hro.HumanReadOverlay(datasets)
            attr_rel = hro.daily_rel_path("1_aime/eval_output/0_daily_eval/aime_expert/aime_expert_attribution-2026-11-23.jsonl")
            comp_rel = hro.daily_rel_path("1_aime/eval_output/0_daily_eval/aime_expert/compact/aime_expert_compact-2026-11-23.jsonl")
            self.assertEqual(attr_rel, "0_daily_eval/aime_expert/aime_expert_attribution-2026-11-23.jsonl")

            # 1. Before translation exists -> fallback untouched
            d_before = copy.deepcopy(base_detail)
            self.assertFalse(overlay.overlay_detail(d_before, attr_rel, orig_attr, comp_rel, orig_comp))
            self.assertEqual(d_before, base_detail)

            # 2. Write translated records via HumanReadStore
            hr_attr = copy.deepcopy(orig_attr)
            hr_attr["turns"][0]["summary"] = "人话点评"
            hr_attr["turns"][0]["problem"][0].update({
                "label": "人话标题",
                "problem_phenomena": "人话现象",
                "reason": "人话原因",
                "severity_reason": "人话定级",
            })
            hr_comp = copy.deepcopy(orig_comp)
            hr_comp["turns"][0]["plans"][0]["content"] = "人话规划"
            hr_comp["turns"][0]["execution_chain"][0]["content"] = "人话执行"
            hr_comp["turns"][0]["components"][0]["components_content"] = "人话概览"

            store = HumanReadStore(hr_root, readonly=False)
            try:
                rk_a = record_key_for_record(orig_attr, "attribution")
                sh_a = text_fingerprint_for_record(orig_attr, "attribution")
                self.assertEqual(rk_a, hro.record_key_for_record(orig_attr, "attribution"))
                store.save_ok(attr_rel, rk_a, "attribution", sh_a, "v1.3", "deepseek-v4.1-flash", hr_attr)

                rk_c = record_key_for_record(orig_comp, "compact")
                sh_c = text_fingerprint_for_record(orig_comp, "compact")
                self.assertEqual(rk_c, hro.record_key_for_record(orig_comp, "compact"))
                store.save_ok(comp_rel, rk_c, "compact", sh_c, "v1.3", "deepseek-v4.1-flash", hr_comp)
            finally:
                store.close()

            # 3. After translation exists -> silent replacement, frozen fields untouched
            d_after = copy.deepcopy(base_detail)
            self.assertTrue(overlay.overlay_detail(d_after, attr_rel, orig_attr, comp_rel, orig_comp))
            self.assertEqual(d_after["attribution"]["turns"][0]["summary"], "人话点评")
            p0 = d_after["attribution"]["problems"][0]
            self.assertEqual(p0["label"], "人话标题")
            self.assertEqual(p0["ph"], "人话现象")
            self.assertEqual(p0["why"], "人话原因")
            self.assertEqual(p0["sevr"], "人话定级")
            # Frozen fields untouched
            self.assertEqual(p0["sev"], "P0")
            self.assertEqual(p0["ev"], [0])
            self.assertEqual(p0["cl"], {"path": "S9.M2.2.1", "edge": False, "tags": []})
            # Compact silently replaced, component name/kind untouched
            ct0 = d_after["compact"]["turns"][0]
            self.assertEqual(ct0["plans"][0]["c"], "人话规划")
            self.assertEqual(ct0["execution"][0]["c"], "人话执行")
            self.assertEqual(ct0["components"][0]["c"], "人话概览")
            self.assertEqual(ct0["components"][0]["name"], "答案合成")
            self.assertEqual(ct0["components"][0]["kind"], "model")
            # No extra UI flags injected
            self.assertNotIn("human_read", d_after)
            self.assertNotIn("orig", p0)
            self.assertGreater(overlay.file_latest_ns(attr_rel), 0)


if __name__ == "__main__":
    unittest.main()
