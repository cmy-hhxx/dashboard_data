"""数据目录布局：AIME 与问财 RSI 的差异只集中在这里。

一次部署只服务一份数据（5003 弗吉尼亚 = AIME，5003 乌兰 = 问财），所以 layout
是按 ``ANALYSIS_DATASET`` 选中的单例，而不是每个请求切换。

AIME::

    1_aime/eval_output/{0_daily_eval,1_lost_user_eval}/<model>/<model>_attribution-<date>.jsonl
    1_aime/eval_output/cluster/<model>/{cluster_tree.json,item_index.jsonl}
    1_aime/eval_input/0_daily_eval_input/<model>/*.jsonl
    1_aime/.archive/1_lost_user_input/<model>/*.jsonl

问财 RSI::

    0_wencai/eval_output/2_rsi_eval/<model>/<cohort>/<model>_attribution-<date>.jsonl
    0_wencai/eval_output/2_rsi_eval/cluster/<model>/total/{cluster_tree.json,item_index.jsonl}
    0_wencai/eval_input/2_rsi_input/<model>/<cohort>/data_<YYYYMMDD>.jsonl

问财没有 compact；聚类树的 cohort 子集之外还有一份累计 ``total``，接口只用 total。
"""

from __future__ import annotations

from pathlib import Path

AIME_SPLIT_TO_SOURCE = {"0_daily_eval": "prelaunch", "1_lost_user_eval": "feedback"}
# 模型目录 → app_version 后缀（问题树按后缀落位）
MODEL_SUFFIX = {
    "aime_expert": "expert", "aime_fast": "fast",
    "a_expert": "expert", "a_fast": "fast", "b_expert": "expert", "b_fast": "fast",
}


def _dirs(path: Path):
    return sorted(p for p in path.iterdir() if p.is_dir()) if path.is_dir() else []


class AimeLayout:
    dataset = "aime_eval"
    product_dir = "1_aime"
    day_tz = "America/New_York"

    # -- 归因输出 ------------------------------------------------------
    def attribution_files(self, root: Path):
        """[(path, source, model_dir)]"""
        out = []
        for split_dir in _dirs(root / "eval_output"):
            source = AIME_SPLIT_TO_SOURCE.get(split_dir.name)
            if not source:
                continue
            for model_dir in _dirs(split_dir):
                for path in sorted(model_dir.glob("*_attribution-*.jsonl")):
                    out.append((path, source, model_dir.name))
        return out

    # -- 原始输入 ------------------------------------------------------
    def input_files(self, root: Path):
        """[(path, model_dir)]"""
        out = []
        for model_dir in _dirs(root / "eval_input" / "0_daily_eval_input"):
            for path in sorted(model_dir.glob("*.jsonl")):
                out.append((path, model_dir.name))
        for model_dir in _dirs(root / ".archive" / "1_lost_user_input"):
            for path in sorted(model_dir.glob("*_input.jsonl")):
                out.append((path, model_dir.name))
        return out

    # -- 聚类 ----------------------------------------------------------
    def cluster_files(self, root: Path):
        return _cluster_dirs(root / "eval_output" / "cluster", nested_scope=False)

    # -- 字段口径 ------------------------------------------------------
    def app_version(self, model_dir: str, meta: dict) -> str:
        suffix = MODEL_SUFFIX.get(model_dir, model_dir)
        return f"{meta.get('model') or model_dir}_{suffix}"

    def tree_key(self, model_dir: str) -> str:
        return "__" + MODEL_SUFFIX.get(model_dir, model_dir)


class WencaiLayout:
    dataset = "wencai_eval"
    product_dir = "0_wencai"
    day_tz = "Asia/Shanghai"
    split = "2_rsi_eval"
    input_split = "2_rsi_input"
    source_fallback = "rsi"

    def attribution_files(self, root: Path):
        out = []
        split_dir = root / "eval_output" / self.split
        for model_dir in _dirs(split_dir):
            if model_dir.name == "cluster" or model_dir.name.startswith("."):
                continue
            for path in sorted(model_dir.glob("*_attribution-*.jsonl")):
                out.append((path, self.source_fallback, model_dir.name))
            for cohort_dir in _dirs(model_dir):
                if cohort_dir.name.startswith("."):
                    continue
                for path in sorted(cohort_dir.glob("*_attribution-*.jsonl")):
                    out.append((path, cohort_dir.name, model_dir.name))
        return out

    def input_files(self, root: Path):
        out = []
        for model_dir in _dirs(root / "eval_input" / self.input_split):
            for cohort_dir in _dirs(model_dir):
                for path in sorted(cohort_dir.glob("data_*.jsonl")):
                    out.append((path, model_dir.name))
        return out

    def cluster_files(self, root: Path):
        return _cluster_dirs(root / "eval_output" / self.split / "cluster", nested_scope=True)

    def app_version(self, model_dir: str, meta: dict) -> str:
        return model_dir

    def tree_key(self, model_dir: str) -> str:
        return "__" + MODEL_SUFFIX.get(model_dir, model_dir)


def _cluster_dirs(root: Path, nested_scope: bool):
    """{model_dir: (tree, item_index|None)}，问财优先只用累计 total。"""
    out = {}
    for model_dir in _dirs(root):
        if model_dir.name.startswith("."):
            continue
        base = model_dir
        if nested_scope:
            total = model_dir / "total"
            if (total / "cluster_tree.json").is_file():
                base = total
        tree = base / "cluster_tree.json"
        if tree.is_file():
            index = base / "item_index.jsonl"
            out[model_dir.name] = (tree, index if index.exists() else None)
    return out


LAYOUTS = {"aime_eval": AimeLayout(), "wencai_eval": WencaiLayout()}
