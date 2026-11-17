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
        # 十位及以内的数字 ID = 真实用户；超过十位（11 位及以上）= 测试用户。
        self.assertEqual(rules.classify("598960105"), "real")
        self.assertEqual(rules.classify("1843531608"), "real")
        self.assertEqual(rules.classify("10000000000"), "test")
        self.assertEqual(rules.classify("805517693996534533"), "test")
        # 非数字 ID 一律按测试账号（业务方 2026-11-17 口径）；空 ID 未知。
        self.assertEqual(rules.classify("duansiyuan"), "test")
        self.assertEqual(rules.classify("cache-platform"), "test")
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

    def test_repeated_questions_stay_real(self):
        """重复问句不再改判：真实账号复核/重试同一问句是正常行为。"""
        rules = user_rules.Rules({})
        self.assertEqual(rules.classify("589407152"), "real")

    def test_real_list_can_rescue_an_account(self):
        rules = user_rules.Rules({"real": {"ids": ["xutianhao"], "patterns": ["^svc_"]}})
        self.assertEqual(rules.classify("xutianhao"), "real")
        self.assertEqual(rules.classify("svc_agent"), "real")
        self.assertEqual(rules.classify("duansiyuan"), "test")

    def test_config_heuristics_are_configurable(self):
        rules = user_rules.Rules({"heuristics": {"real_user_id_max_digits": 12}})
        self.assertEqual(rules.classify("1843531608"), "real")
        self.assertEqual(rules.classify("10000000000"), "real")
        self.assertEqual(rules.classify("805517693996534533"), "test")
        legacy = user_rules.Rules({"heuristics": {"numeric_test_min_digits": 12}})
        self.assertEqual(legacy.max_digits, 11)

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
            self.assertEqual(rules.classify("1843531608"), "real")
            self.assertEqual(rules.classify("10000000000"), "test")
            self.assertEqual(rules.classify("598960105"), "real")


if __name__ == "__main__":
    unittest.main()
