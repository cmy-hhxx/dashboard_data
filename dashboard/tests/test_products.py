"""Split deployments: EVAL_PRODUCTS limits a copy to its product; AIME daily layout."""
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

try:
    from dashboard.tests.test_empty_data import DASHBOARD, REQ, seed, write_jsonl
except ImportError:  # `cd dashboard && python3 -m unittest discover -s tests`
    from test_empty_data import DASHBOARD, REQ, seed, write_jsonl


def as_aime(datasets):
    """Copy the seeded wencai a_fast session into 1_aime as aime_fast."""
    src_out = datasets / "0_wencai/eval_output/0_daily_eval/a_fast"
    out = datasets / "1_aime/eval_output/0_daily_eval/aime_fast"
    inp = datasets / "1_aime/eval_input/0_daily_eval_input/aime_fast/2026-11-01.jsonl"
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


class MatrixTraceTests(unittest.TestCase):
    def test_matrix_cross_counts_every_evaluated_trace(self):
        """聚类矩阵按 trace 口径：场景合计 == 完成 trace；干净 trace 只进分母。"""
        with tempfile.TemporaryDirectory() as folder:
            datasets, static = Path(folder) / "datasets", Path(folder) / "static"
            seed(datasets)
            inp = datasets / "0_wencai/eval_input/a_fast/2026-11-01.jsonl"
            second = json.loads(inp.read_text())
            second.update(trace_id="t2", request_time="2026-11-01 11:00:00")
            second["meta"] = {**second["meta"], "request_time": "2026-11-01 11:00:00",
                              "question": "茅台今日成交量"}
            with inp.open("a", encoding="utf-8") as fh:
                fh.write(json.dumps(second, ensure_ascii=False) + "\n")
            out = datasets / "0_wencai/eval_output/0_daily_eval/a_fast/a_fast_attribution-2026-11-01.jsonl"
            clean = json.loads(out.read_text())
            clean["session_meta"] = {**clean["session_meta"], "request_time": "2026-11-01 11:00:00"}
            clean["session_summary"] = ""
            clean["turns"] = [{**clean["turns"][0], "summary": "", "is_correct": True, "problem": []}]
            with out.open("a", encoding="utf-8") as fh:
                fh.write(json.dumps(clean, ensure_ascii=False) + "\n")
            # 只有归因、没有输入 trace 的记录（tr=0）：进样本，但不进矩阵的 trace 合计。
            orphan = json.loads(out.read_text().splitlines()[0])
            orphan["session_meta"] = {**orphan["session_meta"], "request_time": "2026-11-01 12:00:00"}
            with out.open("a", encoding="utf-8") as fh:
                fh.write(json.dumps(orphan, ensure_ascii=False) + "\n")

            build(datasets, static)
            product = json.loads((static / "data-wencai.json").read_text())["products"]["wencai"]
            cross = product["cross"]
            self.assertEqual((product["kpi"]["sessions"], product["kpi"]["traces"]), (3, 2))
            self.assertEqual(len(cross), 2)
            self.assertEqual(sum(int(row[3]) for row in cross), product["kpi"]["traces"])
            self.assertTrue(all(not row[2] for row in cross))  # 没有聚类树：只验证分母口径


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

    def test_attribution_pairs_input_from_another_day(self):
        """Attribution date and input date can differ after trace-level publishing."""
        with tempfile.TemporaryDirectory() as folder:
            datasets, static = Path(folder) / "datasets", Path(folder) / "static"
            seed(datasets)
            src = datasets / "0_wencai/eval_input/a_fast/2026-11-01.jsonl"
            row = json.loads(src.read_text(encoding="utf-8"))
            row["meta"]["request_time"] = "2026-11-02 12:00:00"
            src.write_text(json.dumps(row, ensure_ascii=False) + "\n", encoding="utf-8")
            src.rename(src.with_name("2026-11-02.jsonl"))
            out = datasets / "0_wencai/eval_output/0_daily_eval/a_fast/a_fast_attribution-2026-11-01.jsonl"
            attr = json.loads(out.read_text(encoding="utf-8"))
            attr["turns"][0]["meta"]["trace_id"] = "t1"
            out.write_text(json.dumps(attr, ensure_ascii=False) + "\n", encoding="utf-8")
            build(datasets, static)
            index = json.loads((static / "samples-wencai.json").read_text())["products"]["wencai"]
            self.assertEqual(index["rows"][0]["tr"], 1)
            data = json.loads((static / "data-wencai.json").read_text())["products"]["wencai"]
            self.assertEqual(data["kpi"]["traces"], 1)
            self.assertEqual(data["input"]["traces"], 1)
            daily = {(r["d"], r["m"]): r for r in data["daily"]}
            moved = daily[("2026-11-02", "a_fast")]
            self.assertEqual((moved["inputs"], moved["evaluated"]), (1, 1))
            self.assertNotIn(("2026-11-01", "a_fast"), daily)

    def test_duplicate_outputs_do_not_double_complete_same_input(self):
        """One input trace can back at most one completed record in the daily card."""
        with tempfile.TemporaryDirectory() as folder:
            datasets, static = Path(folder) / "datasets", Path(folder) / "static"
            seed(datasets)
            out = datasets / "0_wencai/eval_output/0_daily_eval/a_fast/a_fast_attribution-2026-11-01.jsonl"
            first = json.loads(out.read_text(encoding="utf-8"))
            first["turns"][0]["meta"]["trace_id"] = "t1"
            first["session_summary"] = "duplicate"
            with open(out, "a", encoding="utf-8") as fh:
                fh.write(json.dumps(first, ensure_ascii=False) + "\n")
            build(datasets, static)
            data = json.loads((static / "data-wencai.json").read_text())["products"]["wencai"]
            daily = {(r["d"], r["m"]): r for r in data["daily"]}
            self.assertEqual((daily[("2026-11-01", "a_fast")]["inputs"],
                              daily[("2026-11-01", "a_fast")]["evaluated"]), (1, 1))
            self.assertEqual(len(json.loads((static / "samples-wencai.json").read_text())
                                 ["products"]["wencai"]["rows"]), 2)
            # One completion owns the pair ref, but both details can still read the
            # same trace's transcript from the input file.
            from detail_builder import DetailBuilder
            builder = DetailBuilder(datasets, static.parent / "cache" / "build.sqlite3",
                                    static / "samples", static.parent / "cache")
            for row in json.loads((static / "samples-wencai.json").read_text())["products"]["wencai"]["rows"]:
                path = builder.ensure(row["s"])
                self.assertIsNotNone(path)
                detail = json.loads(Path(path).read_text(encoding="utf-8"))
                self.assertFalse(detail["input"]["missing"])
            builder.close()

    def test_exact_key_input_wins_over_trace_fallback(self):
        """A drifted duplicate must not take the input that exactly matches another row."""
        with tempfile.TemporaryDirectory() as folder:
            datasets, static = Path(folder) / "datasets", Path(folder) / "static"
            seed(datasets)
            out = datasets / "0_wencai/eval_output/0_daily_eval/a_fast"
            # The earlier file's session key drifted, but its trace still names t1.
            drifted = json.loads((out / "a_fast_attribution-2026-11-01.jsonl").read_text(encoding="utf-8"))
            drifted["session_meta"]["request_time"] = "2026-11-01 09:00:00"
            drifted["turns"][0]["meta"]["trace_id"] = "t1"
            drifted["session_summary"] = "drifted"
            write_jsonl(out / "a_fast_attribution-2026-11-01.jsonl", drifted)
            # The later file's key is the input's key; it must own the one input line.
            exact = json.loads(json.dumps(drifted))
            exact["session_meta"]["request_time"] = REQ
            exact["session_summary"] = "exact"
            write_jsonl(out / "a_fast_attribution-2026-11-02.jsonl", exact)
            build(datasets, static)
            from detail_builder import DetailBuilder
            builder = DetailBuilder(datasets, static.parent / "cache" / "build.sqlite3",
                                    static / "samples", static.parent / "cache")
            rows = json.loads((static / "samples-wencai.json").read_text())["products"]["wencai"]["rows"]
            details = {}
            for row in rows:
                path = builder.ensure(row["s"])
                self.assertIsNotNone(path)
                details[row["s"]] = json.loads(Path(path).read_text(encoding="utf-8"))
            builder.close()
            exact_detail = next(d for d in details.values()
                                if d["attribution"]["summary"] == "exact")
            drifted_detail = next(d for d in details.values()
                                  if d["attribution"]["summary"] == "drifted")
            # The pair ref goes to the exact-key row; the drifted duplicate gets none,
            # even though both details can still read the transcript by trace id.
            db = sqlite3.connect(static.parent / "cache" / "build.sqlite3")
            refs = {slug: json.loads(value) if value else {}
                    for slug, value in db.execute("SELECT slug,refs FROM samples")}
            db.close()
            self.assertIsNotNone(refs[exact_detail["slug"]].get("input"))
            self.assertIsNone(refs[drifted_detail["slug"]].get("input"))
            self.assertFalse(exact_detail["input"]["missing"])
            self.assertFalse(drifted_detail["input"]["missing"])

    def test_attribution_pairs_input_from_other_model_dir(self):
        """A trace may be routed to the other model input dir; pairing is product-wide."""
        with tempfile.TemporaryDirectory() as folder:
            datasets, static = Path(folder) / "datasets", Path(folder) / "static"
            seed(datasets)
            inp = as_aime(datasets)
            dst = inp.parent.parent / "aime_expert" / inp.name
            dst.parent.mkdir(parents=True, exist_ok=True)
            inp.rename(dst)
            build(datasets, static, EVAL_PRODUCTS="aime")
            index = json.loads((static / "samples-aime.json").read_text())["products"]["aime"]
            self.assertEqual(index["rows"][0]["tr"], 1)
            data = json.loads((static / "data-aime.json").read_text())["products"]["aime"]
            daily = {(r["m"], r["sp"]): r for r in data["daily"]}
            self.assertEqual((daily[("aime_expert", "daily")]["inputs"],
                              daily[("aime_expert", "daily")]["evaluated"]), (1, 1))

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

    def test_aime_daily_uid_lost_marks_without_lost_dir(self):
        """All input lives under daily now; lost users are matched by user_rules.lost.ids."""
        with tempfile.TemporaryDirectory() as folder:
            datasets, static = Path(folder) / "datasets", Path(folder) / "static"
            seed(datasets)
            as_aime(datasets)
            result = lambda: json.loads((static / "data-aime.json").read_text())["products"]["aime"]
            # Without the uid in the lost list, the daily row is not lost.
            build(datasets, static, EVAL_PRODUCTS="aime")
            self.assertEqual(result()["input"]["lost"], 0)
            # Adding the uid must invalidate cached stats even though the input bytes are unchanged.
            (datasets / "user_rules.json").write_text(json.dumps({
                "lost": {"ids": ["598960105"]},
            }), encoding="utf-8")
            build(datasets, static, EVAL_PRODUCTS="aime")
            product = result()
            self.assertEqual(product["input"]["lost"], 1)
            self.assertEqual(product["kpi"]["lost"], 1)
            self.assertEqual(product["field"][0]["lost"], 1)
            self.assertEqual(product["field"][0]["cells"][0][4], 1)
            self.assertIn("lost", [s["id"] for s in product["splits"]])
            rows = json.loads((static / "samples-aime.json").read_text())["products"]["aime"]["rows"]
            self.assertEqual(rows[0]["ul"], 1)

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
