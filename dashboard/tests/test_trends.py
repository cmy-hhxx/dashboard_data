"""Cluster-matrix trend payload: per-day P0-P2 hits per scene / user type / cluster node."""
import gzip
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

try:
    from dashboard.tests.test_empty_data import DASHBOARD, seed, write_jsonl
except ImportError:  # `cd dashboard && python3 -m unittest discover -s tests`
    from test_empty_data import DASHBOARD, seed, write_jsonl


REQ2 = "2026-11-02 10:00:00"
REQ3 = "2026-11-02 12:00:00"
TREND_SEV = ("P0", "P1", "P2", "P3", "P4")
SECOND = {
    "session_id": "s2", "request_time": REQ2, "question": "茅台明天走势",
    "user_id": "12345678901", "task": "行情解读", "subtask": "股价走势",
    "usage": {"input_tokens": 20, "output_tokens": 10},
}
THIRD = {
    "session_id": "s3", "request_time": REQ3, "question": "茅台今日成交量",
    "user_id": "598960106", "task": "行情解读", "subtask": "股价走势",
    "usage": {"input_tokens": 30, "output_tokens": 15},
}


def node(nid, level):
    return {"id": nid, "level": level, "name": nid, "definition": f"{nid} 定义", "children": []}


def write_clusters(out, paths, items):
    """cluster_tree.json (one node per path prefix) + item_index.jsonl for one model dir."""
    root = {"id": "root", "level": 0, "name": "全部", "children": []}
    for path in sorted(set(paths)):
        parent, parts = root, path.split(".")
        for depth in range(1, len(parts) + 1):
            nid = ".".join(parts[:depth])
            child = next((c for c in parent["children"] if c["id"] == nid), None)
            if child is None:
                child = node(nid, depth)
                parent["children"].append(child)
            parent = child
    out.mkdir(parents=True, exist_ok=True)
    tree = {"meta": {"generated_at": "2026-11-01T00:00:00+08:00"}, "tree": root}
    (out / "cluster_tree.json").write_text(json.dumps(tree, ensure_ascii=False), encoding="utf-8")
    write_jsonl(out / "item_index.jsonl", *items)


def add_second_session(datasets):
    """2026-11-02, a test user with a task/subtask scene: P0+P1 on the same cluster node."""
    write_jsonl(datasets / "0_wencai/eval_input/a_fast/2026-11-02.jsonl", {
        "request_time": REQ2, "case_id": "c2", "trace_id": "t2", "version": "a", "meta": SECOND,
        "messages": [
            {"role": "user", "type": "message", "content": [{"type": "input_text", "text": "茅台明天走势"}]},
            {"role": "assistant", "type": "message", "content": [{"type": "output_text", "text": "预计震荡。"}]},
        ],
    })
    out = datasets / "0_wencai/eval_output/0_daily_eval/a_fast"
    write_jsonl(out / "a_fast_attribution-2026-11-02.jsonl", {
        "session_meta": SECOND, "session_summary": "结论与行情不符", "session_problem": [],
        "turns": [{"meta": {}, "summary": "两处错误", "is_correct": False, "problem": [
            {"label": "P0结论错误", "severity": "P0", "component": "answer", "component_family": "结论",
             "component_role": "delivery", "reason": "与行情不符",
             "evidence": [{"position": "trace_index 0 / message_index 1 / path content[0].text",
                           "quote": "预计震荡", "reason": "预测错误"}]},
            {"label": "P1取值错误", "severity": "P1", "component": "answer", "component_family": "取值",
             "component_role": "delivery", "reason": "取值错误",
             "evidence": [{"position": "trace_index 0 / message_index 1 / path content[0].text",
                           "quote": "预计震荡", "reason": "取值错误"}]},
        ]}],
    })
    write_jsonl(out / "compact/a_fast_compact-2026-11-02.jsonl", {
        "session_meta": SECOND, "session_overview": ["预测走势"],
        "turns": [{"turn_idx": 0, "plans": [{"content": "预测", "evidence": []}]}],
    })
    return [
        {"session_id": "s2", "path": "S1.M2.1.3", "json_path": "turns[0].problem[0]", "label": "P0结论错误"},
        {"session_id": "s2", "path": "S1.M2.1", "json_path": "turns[0].problem[1]", "label": "P1取值错误"},
    ]


def add_b_fast_session(datasets):
    """Same day/scene as s2 but another model; P2+P3+P4 exercise the full severity set."""
    write_jsonl(datasets / "0_wencai/eval_input/b_fast/2026-11-02.jsonl", {
        "request_time": REQ3, "case_id": "c3", "trace_id": "t3", "version": "b", "meta": THIRD,
        "messages": [
            {"role": "user", "type": "message", "content": [{"type": "input_text", "text": "茅台今日成交量"}]},
            {"role": "assistant", "type": "message", "content": [{"type": "output_text", "text": "成交量 1000 手。"}]},
        ],
    })
    out = datasets / "0_wencai/eval_output/0_daily_eval/b_fast"
    problems = [(f"{sev}问题", sev) for sev in ("P2", "P3", "P4")]
    write_jsonl(out / "b_fast_attribution-2026-11-02.jsonl", {
        "session_meta": THIRD, "session_summary": "证据与格式都有问题", "session_problem": [],
        "turns": [{"meta": {}, "summary": "三类问题", "is_correct": False, "problem": [
            {"label": label, "severity": sev, "component": "answer", "component_family": "证据",
             "component_role": "delivery", "reason": "证据不足",
             "evidence": [{"position": "trace_index 0 / message_index 1 / path content[0].text",
                           "quote": "成交量 1000 手", "reason": "证据不足"}]}
            for label, sev in problems
        ]}],
    })
    write_jsonl(out / "compact/b_fast_compact-2026-11-02.jsonl", {
        "session_meta": THIRD, "session_overview": ["查成交量"],
        "turns": [{"turn_idx": 0, "plans": [{"content": "查成交量", "evidence": []}]}],
    })
    return [{"session_id": "s3", "path": "S2.M1.2", "json_path": f"turns[0].problem[{i}]",
             "label": label} for i, (label, _) in enumerate(problems)]


def add_aime(datasets):
    """AIME keeps its cluster tree at eval_output/cluster/<model> (no split level)."""
    src, dst = datasets / "0_wencai", datasets / "1_aime"
    inp = dst / "eval_input/0_daily_eval_input/aime_fast/2026-11-01.jsonl"
    out = dst / "eval_output/0_daily_eval/aime_fast"
    (out / "compact").mkdir(parents=True, exist_ok=True)
    inp.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy(src / "eval_input/a_fast/2026-11-01.jsonl", inp)
    shutil.copy(src / "eval_output/0_daily_eval/a_fast/a_fast_attribution-2026-11-01.jsonl",
                out / "aime_fast_attribution-2026-11-01.jsonl")
    shutil.copy(src / "eval_output/0_daily_eval/a_fast/compact/a_fast_compact-2026-11-01.jsonl",
                out / "compact/aime_fast_compact-2026-11-01.jsonl")
    return [{"session_id": "s1", "path": "S9.M1.2", "json_path": "turns[0].problem[0]",
             "label": "收盘价取值错误"}]


class TrendBuildTests(unittest.TestCase):
    def run_build(self, datasets, static, *extra, env=None):
        proc = subprocess.run(
            [sys.executable, str(DASHBOARD / "build.py"), "--datasets", str(datasets), "--out", str(static), *extra],
            check=True, capture_output=True, text=True, env={**os.environ, **(env or {})},
        )
        return json.loads(proc.stdout.strip().splitlines()[-1])

    def trends(self, static, product):
        path = static / f"trends-{product}.json"
        payload = json.loads(path.read_text(encoding="utf-8"))
        self.assertEqual(json.loads(gzip.decompress((static / f"trends-{product}.json.gz").read_bytes())), payload)
        return payload

    def test_trend_payload_counts_cells_and_releases(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            datasets, static = root / "datasets", root / "static"
            seed(datasets)
            second = add_second_session(datasets)
            third = add_b_fast_session(datasets)
            # item_index.jsonl 按模型目录归属：a_fast 与 b_fast 各写一份。
            write_clusters(datasets / "0_wencai/eval_output/0_daily_eval/cluster/a_fast",
                           {"S1.M2.1", "S1.M2.1.3"}, [
                               {"session_id": "s1", "path": "S1.M2.1", "json_path": "turns[0].problem[0]",
                                "label": "收盘价取值错误"},
                               *second,
                           ])
            write_clusters(datasets / "0_wencai/eval_output/0_daily_eval/cluster/b_fast",
                           {"S2.M1.2"}, third)
            write_clusters(datasets / "1_aime/eval_output/cluster/aime_fast", {"S9.M1.2"}, add_aime(datasets))
            (datasets / "releases.json").write_text(json.dumps({
                "wencai": [{"date": "2026-11-02", "label": "策略复盘"}, "2026-11-01",
                           {"date": "2026-13-01"}, "not-a-date", 7],
                "aime": [],
            }, ensure_ascii=False), encoding="utf-8")

            summary = self.run_build(datasets, static)
            self.assertGreater(summary["trend_kb"], 0)
            wencai = self.trends(static, "wencai")
            self.assertEqual((wencai["schema"], wencai["product"]), (2, "wencai"))
            self.assertEqual(wencai["dates"], ["2026-11-01", "2026-11-02"])
            self.assertEqual(wencai["uts"], ["real", "test"])
            self.assertEqual(wencai["models"], ["a_fast", "b_fast"])
            data_models = [m["id"] for m in
                           json.loads((static / "data-wencai.json").read_text())["products"]["wencai"]["models"]]
            self.assertEqual(wencai["models"], data_models)
            self.assertEqual(wencai["scenes"], [["未接入分类体系", ""], ["行情解读", "股价走势"]])
            self.assertEqual(wencai["nodes"],
                             ["S1", "S1.M2", "S1.M2.1", "S1.M2.1.3", "S2", "S2.M1", "S2.M1.2"])
            # 干净样本也进 base；每个评测记录算一条，模型是独立维度。
            self.assertEqual(wencai["base"], [[0, 0, 0, 0, 1], [1, 1, 0, 1, 1], [1, 1, 1, 0, 1]])
            self.assertEqual(wencai["trace_severity"]["daily"],
                             [[0, 1, 0, 0, 0, 0], [1, 0, 1, 0, 0, 0]])
            self.assertEqual(wencai["releases"],
                             [{"date": "2026-11-01"}, {"date": "2026-11-02", "label": "策略复盘"}])
            self.assertEqual(wencai["generated_at"],
                             json.loads((static / "data-wencai.json").read_text())["generated_at"])

            node_idx = {name: i for i, name in enumerate(wencai["nodes"])}
            cells = {(c[0], c[1], c[2], c[3], c[4]): c[5:16] for c in wencai["cells"]}
            self.assertTrue(all(len(c) >= 16 and (len(c) - 16) % 2 == 0 for c in wencai["cells"]))
            self.assertTrue(all(len(b) == 5 for b in wencai["base"]))
            self.assertEqual(cells[(0, 0, 0, 0, 0)], [0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 1])
            # 3 段 S1.M2.1 与 4 段 S1.M2.1.3：同一问题的每个前缀只计一次。
            self.assertEqual(cells[(1, 1, node_idx["S1.M2.1"], 0, 1)],
                             [1, 1, 0, 0, 0, 1, 1, 0, 0, 0, 1])
            self.assertEqual(cells[(1, 1, node_idx["S1.M2.1.3"], 0, 1)],
                             [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])
            # 同一会话命中 P0+P1 → mask 3；P0-only / P2+P3+P4 的 mask 也要正确。
            hist = {(c[0], c[1], c[2], c[3], c[4]): c[16:] for c in wencai["cells"]}
            self.assertEqual(hist[(1, 1, node_idx["S1.M2.1"], 0, 1)], [3, 1])
            self.assertEqual(hist[(1, 1, node_idx["S1.M2.1.3"], 0, 1)], [1, 1])
            self.assertEqual(hist[(1, 1, node_idx["S2.M1.2"], 1, 0)], [28, 1])
            # P3/P4 的计数与命中会话数也进 payload，且不改变 P0-P2 的值。
            self.assertEqual(cells[(1, 1, node_idx["S2.M1.2"], 1, 0)],
                             [0, 0, 1, 1, 1, 0, 0, 1, 1, 1, 1])
            self.assertEqual(len(wencai["cells"]), 10)
            for c in wencai["cells"]:
                masks, counts = c[16::2], c[17::2]
                self.assertEqual(len(c[16:]) % 2, 0)
                self.assertEqual(sum(counts), c[15])
                self.assertTrue(all(0 < m < 32 for m in masks))

            # 前缀自洽：节点 N 的 P0-P4 计数 == path 以 N 开头（含自身）的问题数。
            expected = {"S1": (1, 2, 0, 0, 0), "S1.M2": (1, 2, 0, 0, 0), "S1.M2.1": (1, 2, 0, 0, 0),
                        "S1.M2.1.3": (1, 0, 0, 0, 0), "S2": (0, 0, 1, 1, 1),
                        "S2.M1": (0, 0, 1, 1, 1), "S2.M1.2": (0, 0, 1, 1, 1)}
            for name, want in expected.items():
                got = tuple(sum(c[5 + k] for c in wencai["cells"] if c[2] == node_idx[name]) for k in range(5))
                self.assertEqual(got, want, name)

            # hK <= 该格子 base 的会话数；base 总数 == 该产品样本条数。
            base = {(c[0], c[1], c[2], c[3]): c[4] for c in wencai["base"]}
            self.assertEqual(sum(base.values()), 3)
            for c in wencai["cells"]:
                sessions = base[(c[0], c[1], c[3], c[4])]
                self.assertTrue(all(h <= sessions for h in c[10:15]), c)
                self.assertLessEqual(c[15], sessions, c)

            # 模型维度：两条样本分属 a_fast / b_fast，cells 的 modelIdx 互不串。
            self.assertEqual({c[3] for c in wencai["cells"]}, {0, 1})
            self.assertTrue(all(c[3] == 0 for c in wencai["cells"] if c[2] <= node_idx["S1.M2.1.3"]))
            self.assertTrue(all(c[3] == 1 for c in wencai["cells"] if c[2] > node_idx["S1.M2.1.3"]))
            self.assertEqual(cells[(1, 1, node_idx["S2.M1.2"], 1, 0)],
                             [0, 0, 1, 1, 1, 0, 0, 1, 1, 1, 1])

            # AIME 用另一套 cluster 目录与节点；releases 按产品过滤，互不影响。
            aime = self.trends(static, "aime")
            self.assertEqual((aime["product"], aime["nodes"]), ("aime", ["S9", "S9.M1", "S9.M1.2"]))
            self.assertEqual(aime["models"], ["aime_fast"])
            aime_models = [m["id"] for m in
                           json.loads((static / "data-aime.json").read_text())["products"]["aime"]["models"]]
            self.assertEqual(aime["models"], aime_models)
            self.assertEqual(aime["releases"], [])
            self.assertEqual(aime["dates"], ["2026-11-01"])
            self.assertEqual(aime["scenes"], [["未接入分类体系", ""]])
            self.assertEqual(aime["base"], [[0, 0, 0, 0, 1]])
            aime_cells = {(c[0], c[1], c[2], c[3], c[4]): c[5:16] for c in aime["cells"]}
            self.assertEqual(aime_cells[(0, 0, 2, 0, 0)], [0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 1])

            # 顶层 list 对所有产品生效；改 releases.json 必须让 reuse marker 失效。
            (datasets / "releases.json").write_text(json.dumps(
                ["2026-10-01", {"date": "2026-10-05", "label": "上线"}], ensure_ascii=False), encoding="utf-8")
            self.assertNotIn("reused", self.run_build(datasets, static))
            for product in ("wencai", "aime"):
                self.assertEqual(self.trends(static, product)["releases"],
                                 [{"date": "2026-10-01"}, {"date": "2026-10-05", "label": "上线"}])
            self.assertEqual(self.run_build(datasets, static).get("reused"), 1)
            # trends 文件是 payload 完整性的一部分：缺了就不算可复用。
            (static / "trends-wencai.json").unlink()
            self.assertNotIn("reused", self.run_build(datasets, static))
            self.assertTrue((static / "trends-wencai.json").exists())

            # 产品消失：正常分支清掉它的 trends 文件（.json + .gz）。
            self.run_build(datasets, static, env={"EVAL_PRODUCTS": "wencai"})
            self.assertTrue((static / "trends-wencai.json").exists())
            self.assertEqual(list(static.glob("trends-aime.json*")), [])

            # 空数据分支同样清理 trends。
            shutil.rmtree(datasets)
            self.assertEqual(self.run_build(datasets, static)["pairs"], 0)
            self.assertEqual(list(static.glob("trends-*.json*")), [])


class TrendPayloadUnitTests(unittest.TestCase):
    def test_prefix_model_and_severity_dimensions(self):
        import build

        def one(slug, day, model, ut, task=None, sub=None, problems=()):
            detail = {"meta": {"task": task, "subtask": sub}, "question": slug,
                      "attribution": {"problems": [
                          {"sev": sev, "cl": {"path": path} if path else None} for sev, path in problems]}}
            row = {"d": day, "m": model} if ut is None else {"d": day, "m": model, "ut": ut}
            return (slug, detail, row, {})

        samples = [
            one("a", "2026-11-03", "b_fast", "beta", "任务B", "子2", [("P1", "S1.M2.1.3")]),
            one("b", "2026-11-01", "a_fast", None, "任务A", None,
                [("P0", "S1"), ("P1", "S1"), ("P1", "S1")]),
            one("e", "2026-11-01", "b_fast", "real", "任务A", "", [("P2", "S1.M2.1")]),
            one("c", "2026-11-01", "a_fast", "internal", "任务A", "", [("P3", "S2.M1")]),
            one("d", "2026-11-01", "a_fast", "real", "任务A", "", []),
        ]
        payload = build.trend_payload("wencai", samples)
        self.assertEqual((payload["schema"], payload["releases"]), (2, []))
        self.assertEqual(payload["dates"], ["2026-11-01", "2026-11-03"])
        self.assertEqual(payload["uts"], ["real", "internal", "unknown", "beta"])
        self.assertEqual(payload["models"], ["a_fast", "b_fast"])
        self.assertEqual(payload["scenes"], [["任务A", ""], ["任务B", "子2"]])
        self.assertEqual(payload["base"], [[0, 0, 0, 0, 1], [0, 0, 0, 1, 1], [0, 0, 0, 2, 1],
                                           [0, 0, 1, 0, 1], [1, 1, 1, 3, 1]])
        self.assertEqual(payload["nodes"], ["S1", "S1.M2", "S1.M2.1", "S1.M2.1.3", "S2", "S2.M1"])
        cells = {(c[0], c[1], c[2], c[3], c[4]): c[5:16] for c in payload["cells"]}
        # 四段 path 的每个前缀都计数；模型/用户类型是独立维度。
        self.assertEqual(cells[(1, 1, 3, 1, 3)], [0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 1])
        # 同一 slug 的两个 P1 问题：p1=2 但 h1=1（按 session 去重），P0 单独累计。
        # 同一 slug 的 P0 和 P1：h0=h1=1，但并集仍是 1 个会话（合计不能相加）。
        self.assertEqual(cells[(0, 0, 0, 0, 2)], [1, 2, 0, 0, 0, 1, 1, 0, 0, 0, 1])
        hist = {(c[0], c[1], c[2], c[3], c[4]): c[16:] for c in payload["cells"]}
        self.assertEqual(hist[(0, 0, 0, 0, 2)], [3, 1])
        for c in payload["cells"]:
            masks, counts = c[16::2], c[17::2]
            self.assertEqual(len(c[16:]) % 2, 0)
            self.assertEqual(sum(counts), c[15])
            self.assertTrue(all(0 < m < 32 for m in masks))
        self.assertEqual(cells[(0, 0, 2, 1, 0)], [0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 1])
        # P0-P4 全部进 cells；四条节点路径各自成格（4 + 1 + 3 + 2）。
        self.assertEqual(len(payload["cells"]), 10)

        # 前缀自洽：节点 N 的 P0-P4 计数 == path 以 N 开头（含自身）的问题数。
        counted = [(p["sev"], p["cl"]["path"]) for _, detail, _, _ in samples
                   for p in detail["attribution"]["problems"] if p["cl"] and p["sev"] in TREND_SEV]
        for index, node in enumerate(payload["nodes"]):
            got = [sum(c[5 + k] for c in payload["cells"] if c[2] == index) for k in range(5)]
            want = [sum(1 for sev, path in counted
                        if sev == sev_name and (path == node or path.startswith(node + ".")))
                    for sev_name in TREND_SEV]
            self.assertEqual(got, want, node)

        # 每个格子的 hK 不超过该 (day, scene, model, ut) 的 base 会话数；base 总数 == 样本条数。
        base = {(c[0], c[1], c[2], c[3]): c[4] for c in payload["base"]}
        self.assertEqual(sum(base.values()), len(samples))
        for c in payload["cells"]:
            self.assertTrue(all(h <= base[(c[0], c[1], c[3], c[4])] for h in c[10:16]), c)


class OutputsReadyTests(unittest.TestCase):
    def test_server_waits_for_each_products_trends_file(self):
        import server
        with tempfile.TemporaryDirectory() as folder:
            static = Path(folder)
            (static / "samples").mkdir()
            (static / "data.json").write_text(json.dumps({"products": {"wencai": {}}}), encoding="utf-8")
            (static / "samples.json").write_text(json.dumps({"products": {"wencai": {}}}), encoding="utf-8")
            for name in ("data-wencai.json", "samples-wencai.json", "labels-wencai.json"):
                (static / name).write_text("{}", encoding="utf-8")
            outputs = [str(static / "data.json"), str(static / "samples.json"), str(static / "samples")]
            with mock.patch.object(server, "STATIC", str(static)), \
                    mock.patch.object(server, "OUTPUTS", outputs):
                self.assertFalse(server.outputs_ready())
                (static / "trends-wencai.json").write_text("{}", encoding="utf-8")
                self.assertTrue(server.outputs_ready())


if __name__ == "__main__":
    unittest.main()
