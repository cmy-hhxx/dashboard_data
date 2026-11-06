"""样本页的用户类型规则：真实用户 / 测试用户 / 内部用户 / 未知，外加流失标记。

规则放在 ``<datasets>/user_rules.json``（``EVAL_USER_RULES`` 可覆盖路径），名单更新只改这个文件，
不用改代码。构建会把规则内容的 hash 写进完成标记，规则变了下一次构建会自动重建。

规则文件格式（缺省字段按内置默认值）：:

    {
      "updated_at": "2026-11-06",
      "internal": {"ids": [], "patterns": ["^[A-Za-z]"]},
      "test":     {"ids": ["694137811"], "patterns": []},
      "lost":     {"ids": []},
      "heuristics": {
        "numeric_test_min_digits": 11,
        "dup_min": 3,
        "dup_ratio": 0.5,
        "min_samples": 10
      }
    }

判定优先级：test 名单 > internal 名单 > 数字位数规则 > 兜底 >
重复问句启发式（命中则改判测试用户）。流失是独立标记：流失目录的样本，或 uid 在流失名单里。
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
    # 超过十位（11 位及以上）的数字 ID 是测试用户，十位及以内才是真实用户（业务方 2026-11-06 口径）。
    "numeric_test_min_digits": 11,
    # 同一 uid 的样本里，同一问句至少出现 dup_min 次，且重复占比 >= dup_ratio、样本数 >= min_samples
    # 时判为测试用户；用于抓“回放题/模板题”的测试账号。
    "dup_min": 3,
    "dup_ratio": 0.5,
    "min_samples": 10,
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
        self.lost_ids, self.lost_patterns = _section(data, "lost")
        heuristics = data.get("heuristics") if isinstance(data.get("heuristics"), dict) else {}
        self.heuristics = {**DEFAULT_HEURISTICS, **heuristics}
        self.min_digits = _int(self.heuristics.get("numeric_test_min_digits"), 11)
        self.dup_min = _int(self.heuristics.get("dup_min"), 3)
        self.min_samples = _int(self.heuristics.get("min_samples"), 10)
        try:
            self.dup_ratio = float(self.heuristics.get("dup_ratio", 0.5))
        except (TypeError, ValueError):
            self.dup_ratio = 0.5

    # ---------------------------------------------------------------- rules
    def _hit(self, ids, patterns, uid):
        return uid in ids or any(pattern.search(uid) for pattern in patterns)

    def is_lost(self, uid):
        if uid in (None, ""):
            return False
        return self._hit(self.lost_ids, self.lost_patterns, str(uid))

    def classify(self, uid, stats=None):
        """返回 real / test / internal / unknown；stats 是 question_stats() 的结果。"""
        if uid in (None, ""):
            return "unknown"
        uid = str(uid)
        if self._hit(self.test_ids, self.test_patterns, uid):
            return "test"
        if self._hit(self.internal_ids, self.internal_patterns, uid):
            return "internal"
        if NUMERIC.match(uid):
            base = "test" if len(uid) >= self.min_digits else "real"
        else:
            base = "internal"
        if stats and self._dup_test(uid, stats.get(uid)):
            return "test"
        return base

    def _dup_test(self, uid, stat):
        """同一 uid 重复问句占比过高 -> 测试用户（回放/模板题账号）。"""
        if not stat:
            return False
        samples, duplicated = stat
        return samples >= self.min_samples and samples > 0 and duplicated / samples >= self.dup_ratio

    def question_stats(self, pairs):
        """``(uid, question)`` 流 -> {uid: (样本数, 重复问句样本数)}。"""
        counts = {}
        for uid, question in pairs:
            if uid in (None, ""):
                continue
            key = normalize_question(question)
            per_user = counts.setdefault(str(uid), {})
            per_user[key] = per_user.get(key, 0) + 1
        out = {}
        for uid, per_user in counts.items():
            total = sum(per_user.values())
            out[uid] = (total, sum(n for n in per_user.values() if n >= self.dup_min))
        return out

    # ---------------------------------------------------------------- cache
    def signature(self):
        canonical = {
            "internal": sorted(self.internal_ids),
            "internal_patterns": [p.pattern for p in self.internal_patterns],
            "test": sorted(self.test_ids),
            "test_patterns": [p.pattern for p in self.test_patterns],
            "lost": sorted(self.lost_ids),
            "lost_patterns": [p.pattern for p in self.lost_patterns],
            "heuristics": {
                "numeric_test_min_digits": self.min_digits,
                "dup_min": self.dup_min,
                "dup_ratio": self.dup_ratio,
                "min_samples": self.min_samples,
            },
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
