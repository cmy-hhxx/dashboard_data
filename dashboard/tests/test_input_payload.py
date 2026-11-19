"""输入量聚合：缓存里按运行时模型名分组的旧 stats 要并回目录模型。"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import build


class InputPayloadTests(unittest.TestCase):
    def test_cached_runtime_models_fold_into_the_file_model(self):
        rel = "0_wencai/eval_input/2_rsi_input/b_expert/新用户W1-3/data_20261104.jsonl"
        metas = [{
            "path": rel, "lines": 3, "model": "b_expert", "split": "daily",
            "stats": {
                "records": 3, "traces": 3, "tool_calls": 4,
                "tokens_in": 10, "tokens_out": 20, "cache_read": 0,
                "by_model": {
                    "a_expert": {"traces": 2, "tool_calls": 3, "tokens_in": 10, "tokens_out": 20,
                                 "cache_read": 0,
                                 "tasks": {"投资标的研究与分析": {"n": 2, "lost": 0, "sub": {}}}},
                    "b_expert": {"traces": 1, "tool_calls": 1, "tokens_in": 0, "tokens_out": 0,
                                 "cache_read": 0,
                                 "tasks": {"投资标的研究与分析": {"n": 1, "lost": 0, "sub": {}}}},
                },
            },
        }]
        payload = build.input_payload(metas, product="wencai")
        self.assertEqual(set(payload["models"]), {"b_expert"})
        model = payload["models"]["b_expert"]
        self.assertEqual(model["traces"], 3)
        self.assertEqual(model["tool_calls"], 4)
        self.assertEqual(model["tasks"], [{"task": "投资标的研究与分析", "n": 3}])


if __name__ == "__main__":
    unittest.main()
