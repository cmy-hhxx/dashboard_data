"""测试账号判定口径（不建索引，纯规则）。

业务方 2026-11-17 口径：真实 userid = **纯数字且不超过 10 位**，其余都算测试账号。

    python3 tests/test_users.py
"""

import sys
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO))

from analysis_api import users  # noqa: E402


class RulesTest(unittest.TestCase):
    def test_numeric_up_to_ten_digits_is_real(self):
        rules = users.Rules()
        for uid in ("1", "12345", "1884615217", "1000000000"):
            self.assertTrue(rules.is_real(uid), uid)
            self.assertFalse(rules.is_test(uid), uid)

    def test_named_and_long_ids_are_test(self):
        """duansiyuan / xutianhao 这类英文名和 11 位以上数字都按测试账号处理。"""
        rules = users.Rules()
        for uid in ("duansiyuan", "xutianhao", "cache-platform", "12345678901", "10000000000"):
            self.assertFalse(rules.is_real(uid), uid)
            self.assertTrue(rules.is_test(uid), uid)

    def test_empty_uid_is_kept(self):
        rules = users.Rules()
        self.assertFalse(rules.is_test(None))
        self.assertFalse(rules.is_test(""))

    def test_digit_limit_is_configurable(self):
        rules = users.Rules({"heuristics": {"real_user_id_max_digits": 6}})
        self.assertTrue(rules.is_real("123456"))
        self.assertTrue(rules.is_test("1234567"))

    def test_legacy_numeric_test_min_digits_still_works(self):
        """旧规则文件写 numeric_test_min_digits 时，等价于真实用户最多少一位。"""
        rules = users.Rules({"heuristics": {"numeric_test_min_digits": 11}})
        self.assertEqual(rules.max_digits, 10)
        self.assertTrue(rules.is_real("1884615217"))
        self.assertTrue(rules.is_test("12345678901"))

    def test_explicit_lists_win(self):
        rules = users.Rules(
            {
                "test": {"ids": ["1000000001"], "patterns": ["^qa_"]},
                "real": {"ids": ["xutianhao"], "patterns": ["^svc_real_"]},
            }
        )
        self.assertTrue(rules.is_test("1000000001"))   # 数字但显式测
        self.assertTrue(rules.is_test("qa_agent"))     # 正则命中
        self.assertTrue(rules.is_real("xutianhao"))    # 显式捞回
        self.assertFalse(rules.is_test("xutianhao"))
        self.assertTrue(rules.is_real("svc_real_1"))

    def test_load_tolerates_missing_file(self):
        rules = users.load(Path("/nonexistent-dir-for-test"))
        self.assertTrue(rules.is_real("1884615217"))


if __name__ == "__main__":
    unittest.main()
