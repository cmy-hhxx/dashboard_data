"""测试用户判定：供数接口不对外提供测试账号的问句数据。

规则与看板 `dashboard/user_rules.py` 保持同一口径，规则文件放在
``<datasets>/user_rules.json``（``EVAL_USER_RULES`` 可覆盖）：

- 名单 / 正则命中 test → 测试用户；
- 纯数字 ID 长度达到 ``numeric_test_min_digits``（默认 11）→ 测试用户；
- 同一 uid 的重复问句占比达到阈值 → 测试用户。

供数侧只关心「是否测试用户」；internal / real / unknown 都保留。
"""
from __future__ import annotations

import json
import os
import re
from pathlib import Path

NUMERIC = re.compile(r"^\d+$")
SPACES = re.compile(r"[\s\u3000]+")
SENTENCE_PUNCT = re.compile(r"[，。！？；：、·…—\-－（）()\[\]【】《》\"'“”‘’,.!?;:]+")

DEFAULT_HEURISTICS = {
    "numeric_test_min_digits": 11,
    "dup_min": 3,
    "dup_ratio": 0.5,
    "min_samples": 10,
}


def rules_path(datasets_root) -> Path:
    env = os.environ.get("EVAL_USER_RULES")
    if env:
        return Path(env).expanduser()
    return Path(datasets_root) / "user_rules.json"


def normalize_question(question) -> str:
    if not question:
        return ""
    text = SPACES.sub("", str(question).lower())
    return SENTENCE_PUNCT.sub("", text)[:300]


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
        heuristics = data.get("heuristics") if isinstance(data.get("heuristics"), dict) else {}
        self.heuristics = {**DEFAULT_HEURISTICS, **heuristics}
        self.min_digits = _int(self.heuristics.get("numeric_test_min_digits"), 11)
        self.dup_min = _int(self.heuristics.get("dup_min"), 3)
        self.min_samples = _int(self.heuristics.get("min_samples"), 10)
        try:
            self.dup_ratio = float(self.heuristics.get("dup_ratio", 0.5))
        except (TypeError, ValueError):
            self.dup_ratio = 0.5

    def is_test(self, uid, stats=None) -> bool:
        if uid in (None, ""):
            return False
        uid = str(uid)
        if uid in self.test_ids or any(pattern.search(uid) for pattern in self.test_patterns):
            return True
        if NUMERIC.match(uid) and len(uid) >= self.min_digits:
            return True
        return self._dup_test(uid, stats.get(uid) if stats else None)

    def _dup_test(self, uid, stat) -> bool:
        if not stat:
            return False
        samples, duplicated = stat
        return samples >= self.min_samples and samples > 0 and duplicated / samples >= self.dup_ratio

    def question_stats(self, pairs) -> dict:
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


def load(datasets_root) -> Rules:
    path = rules_path(datasets_root)
    try:
        return Rules(json.loads(path.read_text(encoding="utf-8")))
    except (OSError, ValueError):
        return Rules()
