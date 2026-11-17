"""测试账号判定：供数接口不对外提供测试账号的问句数据。

口径（业务方 2026-11-17）：**真实 userid 是纯数字且不超过 10 位**。
其余（英文名 / 内部号 / 11 位及以上的数字）一律按测试账号处理，整条 trace 不供数。

规则放在 ``<datasets>/user_rules.json``（``EVAL_USER_RULES`` 可覆盖路径），改口径只改这个文件::

    {
      "updated_at": "2026-11-17",
      "test": {"ids": [], "patterns": []},   # 显式测试名单 / 正则，优先级最高
      "real": {"ids": [], "patterns": []},   # 显式真实名单，可把某个号从测试里捞回来
      "heuristics": {"real_user_id_max_digits": 10}
    }

判定顺序：test 名单 > real 名单 > 「纯数字且位数 ≤ 上限」判真实 > 其余都算测试。
旧文件里的 ``numeric_test_min_digits``（默认 11）仍认：等价于 ``max = min_digits - 1``。
"""
from __future__ import annotations

import json
import os
import re
from pathlib import Path

NUMERIC = re.compile(r"^\d+$")

DEFAULT_HEURISTICS = {
    # 真实用户 id 的位数上限：10 位及以内的纯数字才是真实用户（业务方 2026-11-17 口径）。
    "real_user_id_max_digits": 10,
}


def rules_path(datasets_root) -> Path:
    env = os.environ.get("EVAL_USER_RULES")
    if env:
        return Path(env).expanduser()
    return Path(datasets_root) / "user_rules.json"


def _int(value, fallback):
    try:
        return int(value)
    except (TypeError, ValueError):
        return fallback


def _section(data, name):
    section = data.get(name) if isinstance(data, dict) else None
    if not isinstance(section, dict):
        section = {}
    ids = {str(x).strip() for x in section.get("ids") or [] if x not in (None, "")}
    patterns = []
    for pattern in section.get("patterns") or []:
        try:
            patterns.append(re.compile(str(pattern)))
        except re.error:
            continue
    return ids, patterns


class Rules:
    def __init__(self, data=None):
        data = data if isinstance(data, dict) else {}
        self.test_ids, self.test_patterns = _section(data, "test")
        self.real_ids, self.real_patterns = _section(data, "real")
        heuristics = data.get("heuristics") if isinstance(data.get("heuristics"), dict) else {}
        self.heuristics = {**DEFAULT_HEURISTICS, **heuristics}
        max_digits = self.heuristics.get("real_user_id_max_digits")
        if max_digits is None and "numeric_test_min_digits" in self.heuristics:
            # 旧口径：>= N 位算测试用户，等价于真实用户最多 N-1 位
            max_digits = _int(self.heuristics.get("numeric_test_min_digits"), 11) - 1
        self.max_digits = _int(max_digits, DEFAULT_HEURISTICS["real_user_id_max_digits"])

    def is_real(self, uid) -> bool:
        """显式 real 名单优先，其次「纯数字且位数不超过上限」。"""
        if uid is None:
            return False
        uid = str(uid).strip()
        if not uid:
            return False
        if uid in self.real_ids or any(pattern.search(uid) for pattern in self.real_patterns):
            return True
        return bool(NUMERIC.match(uid)) and len(uid) <= self.max_digits

    def is_test(self, uid) -> bool:
        """test 名单命中即测试；否则「不是真实用户」就是测试账号。空 uid 不判测试。"""
        if uid is None:
            return False
        uid = str(uid).strip()
        if not uid:
            return False
        if uid in self.test_ids or any(pattern.search(uid) for pattern in self.test_patterns):
            return True
        return not self.is_real(uid)


def load(datasets_root) -> Rules:
    path = rules_path(datasets_root)
    try:
        return Rules(json.loads(path.read_text(encoding="utf-8")))
    except (OSError, ValueError):
        return Rules()
