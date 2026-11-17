"""样本页的用户类型规则：真实用户 / 测试用户 / 内部用户 / 未知，外加流失标记。

口径（业务方 2026-11-17，与 5003 供数一致）：**真实 userid = 纯数字且不超过 10 位**；
其余（英文名、内部号、11 位及以上的数字）都算测试账号。规则放在 ``<datasets>/user_rules.json``
（``EVAL_USER_RULES`` 可覆盖路径），改口径只改这个文件，不用改代码；构建会把规则内容的 hash
写进完成标记，规则变了下一次构建会自动重建。::

    {
      "updated_at": "2026-11-17",
      "internal": {"ids": [], "patterns": []},   # 显式内部账号（可选，默认不再走英文名）
      "test":     {"ids": [], "patterns": []},   # 显式测试账号，优先级最高
      "real":     {"ids": [], "patterns": []},   # 显式真实账号，可把某个号捞回
      "lost":     {"ids": []},
      "heuristics": {"real_user_id_max_digits": 10}
    }

判定顺序：test 名单 > internal 名单 > real 名单 > 「纯数字且位数 ≤ 上限」判真实 > 其余都算测试。
旧文件里的 ``numeric_test_min_digits`` 仍认，等价于上限 = 它 − 1。
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import sys
from pathlib import Path

NUMERIC = re.compile(r"^\d+$")
SPACES = re.compile(r"[\s\u3000]+")
SENTENCE_PUNCT = re.compile(r"[，。！？；：、·…—\-－（）()\[\]【】《》\"'“”‘’,.!?;:]+")

DEFAULT_HEURISTICS = {
    # 真实用户 id 的位数上限：10 位及以内的纯数字才是真实用户（业务方 2026-11-17 口径）。
    "real_user_id_max_digits": 10,
}


def rules_path(datasets):
    """规则文件位置：EVAL_USER_RULES 优先，否则 datasets 根目录下的 user_rules.json。"""
    env = os.environ.get("EVAL_USER_RULES")
    if env:
        return Path(env).expanduser()
    return Path(datasets) / "user_rules.json"


def normalize_question(question):
    """重复问句的归一化：去空白、统一小写、去中英文标点。"""
    if not question:
        return ""
    text = SPACES.sub("", str(question).lower())
    return SENTENCE_PUNCT.sub("", text)[:300]


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
    def __init__(self, data=None, path=None):
        data = data if isinstance(data, dict) else {}
        self.path = path
        self.internal_ids, self.internal_patterns = _section(data, "internal")
        self.test_ids, self.test_patterns = _section(data, "test")
        self.real_ids, self.real_patterns = _section(data, "real")
        self.lost_ids, self.lost_patterns = _section(data, "lost")
        heuristics = data.get("heuristics") if isinstance(data.get("heuristics"), dict) else {}
        self.heuristics = {**DEFAULT_HEURISTICS, **heuristics}
        if "real_user_id_max_digits" in heuristics:
            max_digits = heuristics["real_user_id_max_digits"]
        elif "numeric_test_min_digits" in heuristics:
            # 旧口径：>= N 位算测试用户，等价于真实用户最多 N-1 位
            max_digits = _int(heuristics.get("numeric_test_min_digits"), 11) - 1
        else:
            max_digits = DEFAULT_HEURISTICS["real_user_id_max_digits"]
        self.max_digits = _int(max_digits, DEFAULT_HEURISTICS["real_user_id_max_digits"])

    # ---------------------------------------------------------------- rules
    def _hit(self, ids, patterns, uid):
        return uid in ids or any(pattern.search(uid) for pattern in patterns)

    def is_lost(self, uid):
        if uid in (None, ""):
            return False
        return self._hit(self.lost_ids, self.lost_patterns, str(uid))

    def is_real(self, uid):
        """显式 real 名单优先，其次「纯数字且位数不超过上限」。"""
        if uid is None:
            return False
        uid = str(uid).strip()
        if not uid:
            return False
        if self._hit(self.real_ids, self.real_patterns, uid):
            return True
        return bool(NUMERIC.match(uid)) and len(uid) <= self.max_digits

    def classify(self, uid):
        """返回 real / test / internal / unknown：不是真实用户就是测试账号。"""
        if uid in (None, ""):
            return "unknown"
        uid = str(uid).strip()
        if not uid:
            return "unknown"
        if self._hit(self.test_ids, self.test_patterns, uid):
            return "test"
        if self._hit(self.internal_ids, self.internal_patterns, uid):
            return "internal"
        return "real" if self.is_real(uid) else "test"

    # ---------------------------------------------------------------- cache
    def signature(self):
        canonical = {
            "internal": sorted(self.internal_ids),
            "internal_patterns": [p.pattern for p in self.internal_patterns],
            "test": sorted(self.test_ids),
            "test_patterns": [p.pattern for p in self.test_patterns],
            "lost": sorted(self.lost_ids),
            "lost_patterns": [p.pattern for p in self.lost_patterns],
            "real": sorted(self.real_ids),
            "real_patterns": [p.pattern for p in self.real_patterns],
            "heuristics": {"real_user_id_max_digits": self.max_digits},
        }
        raw = json.dumps(canonical, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:16]


def load(datasets):
    """读规则文件；缺失/损坏时退回内置默认规则（不让构建失败）。"""
    path = rules_path(datasets)
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except OSError:
        return Rules({}, None)
    except ValueError as exc:
        sys.stderr.write("[build] user_rules.json 解析失败，使用默认规则: %s\n" % exc)
        return Rules({}, path)
    return Rules(data, path)


def _int(value, fallback):
    try:
        return int(value)
    except (TypeError, ValueError):
        return fallback
