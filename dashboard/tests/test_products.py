"""Split deployments: EVAL_PRODUCTS limits a copy to its product; AIME lost-user input without the archive."""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

try:
    from dashboard.tests.test_empty_data import DASHBOARD, seed, write_jsonl
except ImportError:  # `cd dashboard && python3 -m unittest discover -s tests`
    from test_empty_data import DASHBOARD, seed, write_jsonl


def as_aime(datasets, split="0_daily_eval", input_dir="0_daily_eval_input"):
    """Copy the seeded wencai a_fast session into 1_aime as aime_fast."""
    src_out = datasets / "0_wencai/eval_output/0_daily_eval/a_fast"
    out = datasets / "1_aime/eval_output" / split / "aime_fast"
    inp = datasets / "1_aime/eval_input" / input_dir / "aime_fast/2026-11-01.jsonl"
    (out / "compact").mkdir(parents=True, exist_ok=True)
    inp.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy(datasets / "0_wencai/eval_input/a_fast/2026-11-01.jsonl", inp)
    shutil.copy(src_out / "a_fast_attribution-2026-11-01.jsonl", out / "aime_fast_attribution-2026-11-01.jsonl")
    shutil.copy(src_out / "compact/a_fast_compact-2026-11-01.jsonl", out / "compact/aime_fast_compact-2026-11-01.jsonl")
    return inp


def build(datasets, static, **env):
    subprocess.run([sys.executable, str(DASHBOARD / "build.py"), "--datasets", str(datasets), "--out", str(static)],
                   check=True, capture_output=True, text=True, env={**os.environ, **env})
    return json.loads((static / "data.json").read_text())


class ProductSplitTests(unittest.TestCase):
    def test_eval_products_limits_a_copy_to_its_product(self):
        with tempfile.TemporaryDirectory() as folder:
            datasets, static = Path(folder) / "datasets", Path(folder) / "static"
            seed(datasets)
            as_aime(datasets)
            self.assertEqual(sorted(build(datasets, static)["products"]), ["aime", "wencai"])
            data = build(datasets, static, EVAL_PRODUCTS="wencai")
            self.assertEqual(list(data["products"]), ["wencai"])
            self.assertEqual(list(json.loads((static / "samples.json").read_text())["products"]), ["wencai"])
            self.assertFalse((static / "data-aime.json").exists())
            self.assertFalse((static / "samples-aime.json").exists())

    def test_volume_nodes_carry_their_evaluated_cases(self):
        with tempfile.TemporaryDirectory() as folder:
            datasets, static = Path(folder) / "datasets", Path(folder) / "static"
            seed(datasets)
            build(datasets, static)
            volume = json.loads((static / "data-wencai.json").read_text())["products"]["wencai"]["input"]
            models = volume["models"]
            self.assertEqual(models["a_fast"]["ev"], 1)
            self.assertEqual(sum(t["ev"] for t in models["a_fast"]["tasks"]), 1)
            self.assertEqual(sum(t["ev"] for t in volume["tasks"]), 1)
            # Inputs with nothing evaluated behind them stay at zero, so the ring keeps them shut.
            self.assertTrue(all(m["ev"] == 0 for k, m in models.items() if k != "a_fast"))

    def test_unknown_product_fails_loudly(self):
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaises(subprocess.CalledProcessError):
                build(Path(folder), Path(folder) / "static", EVAL_PRODUCTS="wencia")

    def test_input_session_counts_dedupe_snapshots(self):
        """同一 session 的多次输入快照记 1 个 Session，但每一行仍计入记录/轨迹体积。"""
        with tempfile.TemporaryDirectory() as folder:
            datasets, static = Path(folder) / "datasets", Path(folder) / "static"
            seed(datasets)
            volume = lambda: json.loads((static / "data-wencai.json").read_text())["products"]["wencai"]["input"]
            build(datasets, static)
            self.assertEqual((volume()["records"], volume()["sessions"]), (1, 1))
            # 同 session 的次日快照：记录 +1，去重 session 不变。
            write_jsonl(datasets / "0_wencai/eval_input/a_fast/2026-11-02.jsonl", {
                "request_time": "2026-11-02 10:00:00", "case_id": "c1", "trace_id": "t1", "version": "a",
                "meta": {"session_id": "s1", "request_time": "2026-11-02 10:00:00", "question": "茅台今天收盘价",
                         "usage": {"input_tokens": 100, "output_tokens": 50}},
                "messages": [{"role": "user", "type": "message", "content": [{"type": "input_text", "text": "茅台今天收盘价"}]}],
            })
            # 目录清单有 TTL 缓存，测试里写完文件直接清掉（和 test_sidecar 一样）。
            for stale in (DASHBOARD / "cache").glob("tree-in-wencai-*.json"):
                stale.unlink()
            build(datasets, static)
            self.assertEqual((volume()["records"], volume()["sessions"]), (2, 1))

    def test_search_variant_inputs_follow_trace_model(self):
        """目录名报不出模型的输入（b_*_search 变体）按 trace 模型归组，和旭日图/输出模型同一套 key。"""
        with tempfile.TemporaryDirectory() as folder:
            datasets, static = Path(folder) / "datasets", Path(folder) / "static"
            seed(datasets)
            write_jsonl(
                datasets / "0_wencai/eval_input/1_task_eval_input/0_search_eval/b_expert_only_doubao_search/2026-11-03.jsonl",
                {"meta": {"session_id": "variant1", "request_time": "2026-11-03 10:00:00",
                          "model": "AIME-Atlas-thinking", "question": "测试变体"},
                 "traces": [{"meta": {"model": "AIME-Atlas-thinking", "trace_id": "vt1"}, "messages": []}]},
            )
            data = build(datasets, static)
            volume = json.loads((static / "data-wencai.json").read_text())["products"]["wencai"]
            daily = {(r["d"], r["m"]): r for r in volume["daily"]}
            self.assertIn(("2026-11-03", "a_expert"), daily)
            self.assertNotIn(("2026-11-03", "b_expert_only_doubao_search"), daily)
            self.assertEqual(daily[("2026-11-03", "a_expert")]["inputs"], 1)

    def test_aime_lost_user_input_counts_without_archive(self):
        with tempfile.TemporaryDirectory() as folder:
            datasets, static = Path(folder) / "datasets", Path(folder) / "static"
            seed(datasets)
            inp = as_aime(datasets, "1_lost_user_eval", "1_lost_user_eval")
            volume = lambda: json.loads((static / "data-aime.json").read_text())["products"]["aime"]["input"]
            build(datasets, static, EVAL_PRODUCTS="aime")
            self.assertEqual((volume()["records"], volume()["lost"], volume()["sessions"]), (1, 1, 1))
            # With the archive present the eval folder is the partial copy again: counted once, not twice.
            archive = datasets / "1_aime/.archive/1_lost_user_input/aime_fast/2026-11-01.jsonl"
            archive.parent.mkdir(parents=True)
            shutil.copy(inp, archive)
            build(datasets, static, EVAL_PRODUCTS="aime")
            self.assertEqual((volume()["records"], volume()["lost"], volume()["sessions"]), (1, 1, 1))


if __name__ == "__main__":
    unittest.main()
