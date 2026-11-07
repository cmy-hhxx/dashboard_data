"""AB 测试记录: the before/after round payload and its place in the build."""
import gzip
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

try:
    from dashboard.tests.test_empty_data import DASHBOARD, seed
    from dashboard.tests.test_trends import add_aime
except ImportError:  # `cd dashboard && python3 -m unittest discover -s tests`
    from test_empty_data import DASHBOARD, seed
    from test_trends import add_aime

sys.path.insert(0, str(DASHBOARD))

import ab_test  # noqa: E402


COVERAGE = """trace_id,status,eval_store,eval_category,question_time,cls_paths
t1,A_已评测_有落点,daily_expert,daily,2026-10-20T10:00:00Z,S1.M2.1
t2,A_已评测_有落点,lost_expert,lost_user,2026-10-21T10:00:00Z,S1.M2.1.3;S2.M1.2
t3,C_无评测记录,,,2026-10-22T10:00:00Z,
"""

TREE = {
    "meta": {"generated_at": "2026-10-23T00:00:00+00:00"},
    "tree": {"id": "root", "name": "全部", "level": 0, "children": [
        {"id": "S1", "name": "取数规划", "level": 1, "children": [
            {"id": "S1.M2", "name": "目标错配", "level": 2, "children": [
                {"id": "S1.M2.1", "name": "请求照抄原句", "level": 3, "children": [
                    {"id": "S1.M2.1.3", "name": "照抄成陈述句", "level": 4, "children": []}]}]}]},
        {"id": "S2", "name": "检索规划", "level": 1, "children": [
            {"id": "S2.M1", "name": "空转未执行", "level": 2, "children": [
                {"id": "S2.M1.2", "name": "未发起检索", "level": 3, "children": []}]}]},
    ]},
}


def round_dir(root: Path, name="0_version1106_test", after=None):
    """A round exactly as the extraction scripts lay it out."""
    base = root / "1_aime" / "ab_test" / name
    (base / "00_manifest").mkdir(parents=True, exist_ok=True)
    (base / "00_manifest" / "coverage.csv").write_text(COVERAGE, encoding="utf-8")
    (base / "00_manifest" / "summary.json").write_text(json.dumps({
        "generated_at": "2026-10-23T00:00:00+00:00", "target_traces": 3,
        "status": {"A_已评测_有落点": 2, "C_无评测记录": 1},
        "b_reason": {"B1_评测无问题": 0},
        "eval_category": {"daily": 1, "lost_user": 1},
    }), encoding="utf-8")
    tree = base / "03_cluster_1106" / "aime_expert"
    tree.mkdir(parents=True, exist_ok=True)
    (tree / "cluster_tree.json").write_text(json.dumps(TREE, ensure_ascii=False), encoding="utf-8")
    (tree / "leaves.tsv").write_text("path\tl1\tl2\tname\nS1.M2.1\t取数规划\t目标错配\t请求照抄原句\n",
                                     encoding="utf-8")
    if after:
        out = base / "04_retest_after" / "aime_expert"
        out.mkdir(parents=True)
        (out / "item_index.slice.jsonl").write_text(
            "".join(json.dumps({"trace_id": trace, "path": path}) + "\n" for trace, path in after),
            encoding="utf-8")
    return base


class PayloadTests(unittest.TestCase):
    def payload(self, root: Path):
        return ab_test.ab_payload(root, "aime")

    def test_baseline_round_counts_union_tree_and_names(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            round_dir(root)
            payload = self.payload(root)
            self.assertEqual((payload["schema"], payload["product"]), (1, "aime"))
            self.assertEqual(len(payload["rounds"]), 1)
            rnd = payload["rounds"][0]
            self.assertEqual((rnd["id"], rnd["version"], rnd["label"]), ("0_version1106_test", "1106", "v1106"))
            self.assertEqual(rnd["targets"], 3)
            self.assertEqual(rnd["status"], {"A": 2, "C": 1})
            self.assertEqual(rnd["sources"], [["daily", 1], ["lost_user", 1]])
            self.assertEqual(rnd["dates"], ["2026-10-20", "2026-10-22"])
            self.assertIsNone(rnd["sides"]["after"])
            self.assertEqual(rnd["sides"]["before"], {"traces": 2, "hits": 3})

            nodes = {node["id"]: node for node in rnd["nodes"]}
            self.assertEqual(sorted(nodes), ["S1", "S1.M2", "S1.M2.1", "S1.M2.1.3", "S2", "S2.M1", "S2.M1.2"])
            # 前缀包含其下所有叶子：S1.M2.1 计 t1 与 t2 的更深落点。
            self.assertEqual((nodes["S1.M2.1"]["before"], nodes["S1.M2.1"]["after"]), (2, 0))
            self.assertEqual((nodes["S1"]["before"], nodes["S1"]["level"]), (2, 1))
            self.assertEqual((nodes["S1.M2.1"]["parent"], nodes["S1.M2.1"]["name"]), ("S1.M2", "请求照抄原句"))
            # L4 的名字只存在于树快照里，leaves.tsv 没有这一层。
            self.assertEqual(nodes["S1.M2.1.3"]["name"], "照抄成陈述句")

            leaves = {leaf["id"]: leaf for leaf in rnd["leaves"]}
            self.assertEqual(sorted(leaves), ["S1.M2.1", "S1.M2.1.3", "S2.M1.2"])
            # 叶子只计精确落点；S1.M2.1 的 2 是前缀和，不能拿来算叶子。
            self.assertEqual(leaves["S1.M2.1"]["model_before"], {"expert": 1})
            self.assertEqual(leaves["S1.M2.1"]["source_before"], {"daily": 1})
            self.assertEqual(leaves["S1.M2.1.3"]["source_before"], {"lost_user": 1})
            self.assertIsNone(leaves["S1.M2.1"]["after"])
            self.assertEqual(payload["models"], ["expert"])
            self.assertEqual(payload["labels"]["status"]["C"][0], "无评测记录")

    def test_after_side_unions_and_pairs(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            # 发版后：t1 的问题换成了检索空转，t2 只剩原来的叶子。
            round_dir(root, after=[("t1", "S2.M1.2"), ("t2", "S1.M2.1")])
            rnd = self.payload(root)["rounds"][0]
            self.assertEqual(rnd["sides"]["after"], {"traces": 2, "hits": 2})
            nodes = {node["id"]: node for node in rnd["nodes"]}
            self.assertEqual((nodes["S2.M1.2"]["before"], nodes["S2.M1.2"]["after"]), (1, 1))
            self.assertEqual((nodes["S1.M2.1"]["before"], nodes["S1.M2.1"]["after"]), (2, 1))
            self.assertEqual((nodes["S1.M2.1.3"]["before"], nodes["S1.M2.1.3"]["after"]), (1, 0))
            leaves = {leaf["id"]: leaf for leaf in rnd["leaves"]}
            self.assertEqual((leaves["S1.M2.1.3"]["before"], leaves["S1.M2.1.3"]["after"]), (1, 0))
            self.assertEqual(leaves["S1.M2.1.3"]["model_after"], {})

    def test_round_metadata_and_signature(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            base = round_dir(root)
            (base / "round.json").write_text(json.dumps({"released_at": "2026-11-06", "label": "1106 发版"},
                                                        ensure_ascii=False), encoding="utf-8")
            before = ab_test.rounds_signature(root)
            rnd = self.payload(root)["rounds"][0]
            self.assertEqual((rnd["released_at"], rnd["release_label"]), ("2026-11-06", "1106 发版"))
            # 新文件、以及「发版后」数据回填，都必须让 reuse marker 失效。
            round_dir(root, name="1_version1201_test")
            self.assertNotEqual(ab_test.rounds_signature(root), before)
            signature = ab_test.rounds_signature(root)
            round_dir(root, name="1_version1201_test", after=[("t1", "S2.M1.2")])
            self.assertNotEqual(ab_test.rounds_signature(root), signature)

    def test_no_ab_directory_means_no_payload(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "1_aime" / "eval_output").mkdir(parents=True)
            self.assertIsNone(self.payload(root))


class BuildIntegrationTests(unittest.TestCase):
    def run_build(self, datasets, static):
        proc = subprocess.run(
            [sys.executable, str(DASHBOARD / "build.py"), "--datasets", str(datasets), "--out", str(static)],
            check=True, capture_output=True, text=True, env={**os.environ},
        )
        return json.loads(proc.stdout.strip().splitlines()[-1])

    def abtests(self, static, product):
        payload = json.loads((static / f"abtests-{product}.json").read_text(encoding="utf-8"))
        self.assertEqual(json.loads(gzip.decompress((static / f"abtests-{product}.json.gz").read_bytes())), payload)
        return payload

    def test_build_writes_ab_payload_and_entry(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            datasets, static = root / "datasets", root / "static"
            seed(datasets)
            add_aime(datasets)
            round_dir(datasets)

            summary = self.run_build(datasets, static)
            self.assertGreater(summary["ab_kb"], 0)
            abtests = self.abtests(static, "aime")
            self.assertEqual([rnd["id"] for rnd in abtests["rounds"]], ["0_version1106_test"])
            self.assertFalse((static / "abtests-wencai.json").exists())

            # 卡片入口跟着数据走：没有 AB 轮次的产品不出现这个按钮。
            data = json.loads((static / "data-aime.json").read_text(encoding="utf-8"))
            entry = data["products"]["aime"]["ab"]
            self.assertEqual(entry["url"], "abtests-aime.json")
            self.assertEqual((entry["rounds"], entry["targets"], entry["paired"]), (1, 3, False))
            wencai = json.loads((static / "data-wencai.json").read_text(encoding="utf-8"))
            self.assertNotIn("ab", wencai["products"]["wencai"])

            # 复用标记覆盖 ab_test：新增一期、或删除全部轮次，都要重建。
            self.assertEqual(self.run_build(datasets, static).get("reused"), 1)
            round_dir(datasets, name="1_version1201_test")
            summary = self.run_build(datasets, static)
            self.assertNotIn("reused", summary)
            self.assertEqual(len(self.abtests(static, "aime")["rounds"]), 2)
            self.assertEqual(json.loads((static / "data-aime.json").read_text())["products"]["aime"]["ab"]["rounds"], 2)

            import shutil
            shutil.rmtree(datasets / "1_aime" / "ab_test")
            self.run_build(datasets, static)
            self.assertFalse((static / "abtests-aime.json").exists())
            self.assertFalse((static / "abtests-aime.json.gz").exists())


if __name__ == "__main__":
    unittest.main()
