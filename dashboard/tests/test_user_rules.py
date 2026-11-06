"""User-type rules for the sample page (real / test / internal / lost)."""
import json
import sys
import tempfile
import unittest
from pathlib import Path

DASHBOARD = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(DASHBOARD))

import user_rules  # noqa: E402


class RulesTests(unittest.TestCase):
    def test_default_digit_rule(self):
        rules = user_rules.Rules({})
        # 十位以下数字 ID = 真实用户；十位及以上 = 测试用户。
        self.assertEqual(rules.classify("598960105"), "real")
        self.assertEqual(rules.classify("1843531608"), "test")
        self.assertEqual(rules.classify("805517693996534533"), "test")
        # 非数字 ID 是内部员工账号；空 ID 未知。
        self.assertEqual(rules.classify("duansiyuan"), "internal")
        self.assertEqual(rules.classify(None), "unknown")
        self.assertEqual(rules.classify(""), "unknown")

    def test_lists_override_defaults(self):
        rules = user_rules.Rules({
            "internal": {"ids": ["1843531608"]},
            "test": {"ids": ["598960105"], "patterns": ["^999"]},
            "lost": {"ids": ["598960105"]},
        })
        self.assertEqual(rules.classify("1843531608"), "internal")
        self.assertEqual(rules.classify("598960105"), "test")
        self.assertEqual(rules.classify("999123"), "test")
        self.assertTrue(rules.is_lost("598960105"))
        self.assertFalse(rules.is_lost("1843531608"))

    def test_duplicate_question_heuristic(self):
        rules = user_rules.Rules({})
        pairs = [("589407152", "同样的问句")] * 8 + [
            ("589407152", "另一个问句"),
            ("589407152", "再一个问句"),
        ]
        stats = rules.question_stats(pairs)
        # 10 条样本里 8 条是同一问句 -> 重复占比 0.8，判测试。
        self.assertEqual(rules.classify("589407152", stats), "test")
        # 样本数不足 min_samples 时不触发。
        small = rules.question_stats([("589407152", "同一个问句")] * 5 + [("589407152", "别的")] * 2)
        self.assertEqual(rules.classify("589407152", small), "real")

    def test_config_heuristics_are_configurable(self):
        rules = user_rules.Rules({"heuristics": {"numeric_test_min_digits": 12}})
        self.assertEqual(rules.classify("1843531608"), "real")
        self.assertEqual(rules.classify("805517693996534533"), "test")

    def test_load_uses_file_and_signature_changes(self):
        with tempfile.TemporaryDirectory() as folder:
            datasets = Path(folder)
            missing = user_rules.load(datasets)
            self.assertIsNone(missing.path)
            default_sig = missing.signature()

            (datasets / "user_rules.json").write_text(json.dumps({
                "internal": {"ids": ["u1"]},
                "test": {"ids": ["1843531608"]},
                "lost": {"ids": ["589407152"]},
            }), encoding="utf-8")
            loaded = user_rules.load(datasets)
            self.assertEqual(loaded.path, datasets / "user_rules.json")
            self.assertEqual(loaded.classify("1843531608"), "test")
            self.assertTrue(loaded.is_lost("589407152"))
            self.assertNotEqual(loaded.signature(), default_sig)
            self.assertEqual(loaded.signature(), user_rules.load(datasets).signature())

    def test_broken_file_falls_back_to_defaults(self):
        with tempfile.TemporaryDirectory() as folder:
            datasets = Path(folder)
            (datasets / "user_rules.json").write_text("{not json", encoding="utf-8")
            rules = user_rules.load(datasets)
            self.assertEqual(rules.classify("1843531608"), "test")
            self.assertEqual(rules.classify("598960105"), "real")


if __name__ == "__main__":
    unittest.main()
