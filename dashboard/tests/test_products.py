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
            product = json.loads((static / "data-wencai.json").read_text())["products"]["wencai"]
            self.assertEqual(product["input"]["models"]["a_fast"]["sessions"], 1)
            self.assertEqual(product["daily"][0]["in_sids"], product["daily"][1]["in_sids"])

    def test_session_field_separates_records_from_sessions_and_problems(self):
        """会话场一格一条评测记录；场数按 (split, sid) 去重，问题数按记录内条目累加。"""
        with tempfile.TemporaryDirectory() as folder:
            datasets, static = Path(folder) / "datasets", Path(folder) / "static"
            seed(datasets)
            inp = datasets / "0_wencai/eval_input/a_fast/2026-11-01.jsonl"
            second = json.loads(inp.read_text())
            second["request_time"] = "2026-11-01 11:00:00"
            second["meta"]["request_time"] = second["request_time"]
            second["trace_id"] = "t2"
            with inp.open("a", encoding="utf-8") as fh:
                fh.write(json.dumps(second, ensure_ascii=False) + "\n")
            out = datasets / "0_wencai/eval_output/0_daily_eval/a_fast/a_fast_attribution-2026-11-01.jsonl"
            second_out = json.loads(out.read_text())
            second_out["session_meta"]["request_time"] = "2026-11-01 11:00:00"
            with out.open("a", encoding="utf-8") as fh:
                fh.write(json.dumps(second_out, ensure_ascii=False) + "\n")

            build(datasets, static)
            product = json.loads((static / "data-wencai.json").read_text())["products"]["wencai"]
            field = product["field"]
            self.assertEqual((product["kpi"]["sessions"], product["kpi"]["unique_sessions"]), (2, 1))
            self.assertEqual(product["kpi"]["problems"], 2)
            self.assertEqual(sum(len(g["cells"]) for g in field), 2)
            self.assertEqual(sum(g["sessions"] for g in field), product["kpi"]["unique_sessions"])

    def test_daily_trace_volume_counts_traces_inside_each_record(self):
        with tempfile.TemporaryDirectory() as folder:
            datasets, static = Path(folder) / "datasets", Path(folder) / "static"
            seed(datasets)
            write_jsonl(datasets / "0_wencai/eval_input/a_fast/2026-11-02.jsonl", {
                "meta": {"session_id": "s2", "request_time": "2026-11-02 10:00:00"},
                "traces": [{"meta": {"model": "a_fast"}, "messages": []},
                           {"meta": {"model": "a_fast"}, "messages": []}],
            })
            build(datasets, static)
            product = json.loads((static / "data-wencai.json").read_text())["products"]["wencai"]
            day = next(r for r in product["daily"] if r["d"] == "2026-11-02")
            self.assertEqual((day["inputs"], day["input_traces"], day["in_sessions"]), (1, 2, 1))
            self.assertEqual(sum(r["input_traces"] for r in product["daily"]), product["input"]["traces"])

    def test_missing_token_usage_is_distinguished_from_reported_zero(self):
        with tempfile.TemporaryDirectory() as folder:
            datasets, static = Path(folder) / "datasets", Path(folder) / "static"
            seed(datasets)
            out = datasets / "0_wencai/eval_output/0_daily_eval/a_fast/a_fast_attribution-2026-11-01.jsonl"
            row = json.loads(out.read_text())
            row["session_meta"].pop("usage")
            write_jsonl(out, row)
            build(datasets, static)
            product = json.loads((static / "data-wencai.json").read_text())["products"]["wencai"]
            self.assertEqual((product["kpi"]["tokens"], product["kpi"]["token_records"]), (0, 0))
            self.assertEqual(product["daily"][0]["token_records"], 0)
            row["session_meta"]["usage"] = {"input_tokens": 0, "output_tokens": 0}
            write_jsonl(out, row)
            build(datasets, static)
            product = json.loads((static / "data-wencai.json").read_text())["products"]["wencai"]
            self.assertEqual((product["kpi"]["tokens"], product["kpi"]["token_records"]), (0, 1))
            self.assertEqual(product["daily"][0]["token_records"], 1)

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
            # 评测量卡按窗口对账：输入侧也要有逐日 session 数，口径和每日输入行一致。
            self.assertEqual(daily[("2026-11-03", "a_expert")]["in_sessions"], 1)
            self.assertEqual(volume["input"]["models"]["a_expert"]["sessions"], 1)

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


    def test_stray_snapshot_under_eval_input_is_not_scanned(self):
        """误放在 eval_input/ 下的快照不能进看板：只扫已发布的输入目录。

        2026-11-07：一份快照被放进了 ``eval_input/snapshots/``，被当成正式输入
        扫进去（scan_files 90 vs 74），体积口径翻倍。
        """
        with tempfile.TemporaryDirectory() as folder:
            datasets, static = Path(folder) / "datasets", Path(folder) / "static"
            seed(datasets)
            inp = as_aime(datasets)
            volume = lambda: json.loads((static / "data-aime.json").read_text())["products"]["aime"]["input"]
            build(datasets, static, EVAL_PRODUCTS="aime")
            self.assertEqual(volume()["records"], 1)

            # A copy of the published input dropped under a new folder: same shape, new name.
            snap = datasets / "1_aime/eval_input/some_export_20261107" / "aime_fast"
            snap.mkdir(parents=True)
            shutil.copy(inp, snap / "2026-11-01.jsonl")
            for stale in (DASHBOARD / "cache").glob("tree-*.json"):
                stale.unlink()
            build(datasets, static, EVAL_PRODUCTS="aime")
            self.assertEqual(volume()["records"], 1, "误放的快照不能让体积翻倍")

    def test_input_roots_do_not_hardcode_product_names(self):
        """扫描目录由布局推导，新增目录不需要改代码；wencai 仍是平铺。"""
        import build as build_mod
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder) / "1_aime"
            roots = build_mod.input_roots(root, "aime")
            self.assertEqual([r.relative_to(root).as_posix() for r in roots],
                             ["eval_input/0_daily_eval_input", "eval_input/aime_expert",
                              "eval_input/aime_fast"])
            wencai = Path(folder) / "0_wencai"
            self.assertEqual([r.relative_to(wencai).as_posix() for r in build_mod.input_roots(wencai, "wencai")],
                             ["eval_input"])


if __name__ == "__main__":
    unittest.main()
