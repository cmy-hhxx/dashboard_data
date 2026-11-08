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
            self.assertEqual((payload["schema"], payload["product"]), (3, "aime"))
            self.assertEqual(len(payload["rounds"]), 1)
            rnd = payload["rounds"][0]
            self.assertEqual((rnd["id"], rnd["version"], rnd["label"]), ("0_version1106_test", "1106", "v1106"))
            self.assertEqual(rnd["targets"], 3)
            self.assertEqual(rnd["status"], {"A": 2, "C": 1})
            self.assertEqual(rnd["sources"], [["daily", 1], ["lost_user", 1]])
            self.assertEqual(rnd["dates"], ["2026-10-20", "2026-10-22"])
            self.assertIsNone(rnd["sides"]["after"])
            self.assertIsNone(rnd["sides"]["online"])
            self.assertEqual(rnd["sides"]["before"], {"traces": 2, "hits": 3})
            self.assertEqual(rnd["sample_refs"]["before"][0], {
                "trace": "t1", "model": "expert", "task": "未接入分类体系", "sub": "", "paths": ["S1.M2.1"],
            })
            self.assertEqual(rnd["sample_refs"]["after"], [])

            nodes = {node["id"]: node for node in rnd["nodes"]}
            self.assertEqual(sorted(nodes), ["S1", "S1.M2", "S1.M2.1", "S1.M2.1.3", "S2", "S2.M1", "S2.M1.2"])
            # 前缀包含其下所有叶子：S1.M2.1 计 t1 与 t2 的更深落点。
            self.assertEqual((nodes["S1.M2.1"]["before"], nodes["S1.M2.1"]["after"]), (2, None))
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
            self.assertIsNone(leaves["S1.M2.1"]["online"])
            self.assertEqual(payload["models"], ["expert"])
            self.assertEqual(payload["labels"]["status"]["C"][0], "无评测记录")
            self.assertEqual(payload["labels"]["sides"]["online"], "改版后 · 线上真实用户")
            self.assertEqual(rnd["matrix"]["before"], [["未接入分类体系", "", [["S1.M2.1", 1], ["S1.M2.1.3", 1], ["S2.M1.2", 1]]]])

    def test_after_side_unions_and_pairs(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            # 发版后：t1 的问题换成了检索空转，t2 只剩原来的叶子。
            round_dir(root, after=[("t1", "S2.M1.2"), ("t2", "S1.M2.1")])
            rnd = self.payload(root)["rounds"][0]
            self.assertEqual(rnd["sides"]["after"], {"traces": 2, "hits": 2})
            self.assertEqual(rnd["sample_refs"]["after"][0]["paths"], ["S2.M1.2"])
            self.assertEqual(rnd["sample_refs"]["after"][0]["trace"], "t1")
            nodes = {node["id"]: node for node in rnd["nodes"]}
            self.assertEqual((nodes["S2.M1.2"]["before"], nodes["S2.M1.2"]["after"]), (1, 1))
            self.assertEqual((nodes["S1.M2.1"]["before"], nodes["S1.M2.1"]["after"]), (2, 1))
            self.assertEqual((nodes["S1.M2.1.3"]["before"], nodes["S1.M2.1.3"]["after"]), (1, 0))
            leaves = {leaf["id"]: leaf for leaf in rnd["leaves"]}
            self.assertEqual((leaves["S1.M2.1.3"]["before"], leaves["S1.M2.1.3"]["after"]), (1, 0))
            self.assertEqual(leaves["S1.M2.1.3"]["model_after"], {})

    def test_baseline_sample_refs_locate_a_trace_inside_its_session(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            round_dir(root)
            samples = [("session-detail", {"meta": {}, "attribution": {"turns": [{"trace_id": "t1"}]}},
                        {"tid": "session-id", "m": "aime_expert"}, {})]
            rnd = ab_test.ab_payload(root, "aime", samples=samples)["rounds"][0]
            self.assertEqual(rnd["sample_refs"]["before"][0]["slug"], "session-detail")
            self.assertNotIn("slug", rnd["sample_refs"]["before"][1])

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

    def test_online_real_users_after_release_are_a_third_side(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            base = round_dir(root)
            (base / "round.json").write_text(json.dumps({"released_at": "2026-11-06", "label": "1106 发版"}),
                                             encoding="utf-8")

            def sample(slug, day, ut, trace, path=None, task="取数规划", sub="目标错配"):
                problems = [{"cl": {"path": path}}] if path else []
                detail = {"meta": {"task": task, "subtask": sub}, "attribution": {"problems": problems}}
                return (slug, detail, {"d": day, "ut": ut, "tid": trace, "m": "expert"}, {})

            samples = [
                sample("fixed", "2026-11-07", "real", "t1", "S2.M1.2"),      # 固定题集 trace 不复用
                sample("before", "2026-11-05", "real", "t6", "S2.M1.2"),     # 发版前
                sample("test", "2026-11-07", "test", "t5", "S2.M1.2"),       # 非真实用户
                sample("online-1", "2026-11-07", "real", "t4", "S1.M2.1"),
                sample("online-2", "2026-11-08", "real", "t7", None),
                sample("online-3", "2026-11-09", "real", "t8", "S2.M1.2", task="检索规划", sub="空转未执行"),
            ]
            rnd = ab_test.ab_payload(root, "aime", samples=samples)["rounds"][0]
            self.assertEqual(rnd["sides"]["online"],
                             {"traces": 3, "hits": 2, "from": "2026-11-06", "to": "2026-11-09", "user_type": "real"})
            self.assertEqual([ref["slug"] for ref in rnd["sample_refs"]["online"]], ["online-1", "online-3"])
            leaves = {leaf["id"]: leaf for leaf in rnd["leaves"]}
            self.assertEqual((leaves["S1.M2.1"]["online"], leaves["S2.M1.2"]["online"]), (1, 1))
            nodes = {node["id"]: node for node in rnd["nodes"]}
            self.assertEqual((nodes["S1.M2.1"]["online"], nodes["S2"]["online"]), (1, 1))
            self.assertEqual(rnd["matrix"]["online"], [
                ["取数规划", "目标错配", [["S1.M2.1", 1]]],
                ["检索规划", "空转未执行", [["S2.M1.2", 1]]],
            ])

    def test_online_window_stops_at_the_next_release(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            first = round_dir(root, name="0_version1106_test")
            second = round_dir(root, name="1_version1113_test")
            (first / "round.json").write_text(json.dumps({"released_at": "2026-11-06"}), encoding="utf-8")
            (second / "round.json").write_text(json.dumps({"released_at": "2026-11-13"}), encoding="utf-8")

            def sample(slug, day, trace):
                detail = {"meta": {"task": "行情解读", "subtask": "股价走势"},
                          "attribution": {"problems": [{"cl": {"path": "S1.M2.1"}}]}}
                return (slug, detail, {"d": day, "ut": "real", "tid": trace, "m": "expert"}, {})

            samples = [sample("r1", "2026-11-07", "r1"), sample("r2", "2026-11-13", "r2")]
            payload = ab_test.ab_payload(root, "aime", samples=samples)
            self.assertEqual([rnd["sides"]["online"]["traces"] for rnd in payload["rounds"]], [1, 1])
            self.assertEqual(payload["rounds"][0]["sides"]["online"]["to"], "2026-11-07")
            self.assertEqual(payload["rounds"][1]["sides"]["online"]["from"], "2026-11-13")

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
            base = round_dir(datasets)
            (base / "round.json").write_text(json.dumps({"released_at": "2026-10-31"}), encoding="utf-8")

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
            self.assertTrue(entry["online"])
            self.assertEqual(abtests["rounds"][0]["sides"]["online"]["traces"], 1)
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


# ---- current three-scope layout (02_before_release / 03_after_release_retest) --------------

BEFORE_COVERAGE = """trace_id,session_id,user_id,question_time,mode,question,qtype,status,b_reason,eval_category,eval_store,eval_file,eval_line,eval_n_problem,eval_is_correct,cls_n_items,cls_paths,cls_labels,cls_dates,eval_stores_alt,recycle
t1,thread_1,,2026-10-20T10:00:00Z,expert,q1,string,已评测_有落点,,daily,daily_expert,e.jsonl,1,2,,2,S1.M2.1;S1.M2.1.3,l1;l2,,"daily_expert,demo_expert",
t2,thread_2,,2026-10-21T10:00:00Z,expert,q2,string,已评测_有落点,,lost_user,lost_expert,e.jsonl,2,1,,1,S2.M1.2,l3,,
t3,thread_3,,2026-10-22T10:00:00Z,expert,q3,string,无评测记录,,,e.jsonl,3,0,,0,,,,
"""

AFTER_COVERAGE = """trace_id,eq_index,retest_state,n_problem,retest_session_id,cls_n_items,cls_paths,cls_labels
t1,1,已重测_有归因,1,thread_r1,1,S2.M1.2,l3
t2,2,已重测_有归因,0,thread_r2,0,,
t3,3,未重测_批次无该题,0,,0,,
"""

ONLINE_HEADER = "trace_id,session_id,user_id,question_time,model,question,retest_state,n_problem,cls_n_items,cls_paths\n"


def scope_round_dir(root: Path, name="0_version1106_test", after=True):
    """A round in the current three-scope layout."""
    base = root / "1_aime" / "ab_test" / name
    manifest = base / "00_manifest"
    manifest.mkdir(parents=True, exist_ok=True)
    (manifest / "coverage_before_release_cluster.csv").write_text(BEFORE_COVERAGE, encoding="utf-8")
    (manifest / "coverage_before_release.csv").write_text(BEFORE_COVERAGE, encoding="utf-8")
    (manifest / "coverage_after_release_online_real.csv").write_text(ONLINE_HEADER, encoding="utf-8")
    (manifest / "summary.json").write_text(json.dumps({
        "generated_at": "2026-11-07T00:00:00+00:00", "target_traces": 3,
        "status": {"A_已评测_有落点": 2, "C_无评测记录": 1},
        "eval_category": {"daily": 1, "lost_user": 1},
    }), encoding="utf-8")
    (base / "round.json").write_text(json.dumps({"released_at": "2026-11-06", "label": "1106 发版"}),
                                     encoding="utf-8")
    (base / "01_targets").mkdir(exist_ok=True)
    (base / "01_targets" / "questions.jsonl").write_text(
        "".join(json.dumps({"trace_id": trace, "session_id": f"thread_{i}"}) + "\n"
                for i, trace in enumerate(("t1", "t2", "t3"), 1)), encoding="utf-8")
    for rel in ("02_before_release", "03_after_release_retest", "04_after_release_online_real"):
        (base / rel).mkdir(exist_ok=True)
    for rel, items in (("02_before_release/cluster_tree/aime_expert", [("t1", "S1.M2.1"), ("t1", "S1.M2.1.3"), ("t2", "S2.M1.2")]),
                       ("03_after_release_retest/cluster_tree/aime_expert", [("t1", "S2.M1.2")])):
        tree = base / rel
        tree.mkdir(parents=True, exist_ok=True)
        (tree / "cluster_tree.json").write_text(json.dumps(TREE, ensure_ascii=False), encoding="utf-8")
        (tree / "leaves.tsv").write_text(
            "path\tl1\tl2\tname\nS1.M2.1\t取数规划\t目标错配\t请求照抄原句\n"
            "S2.M1.2\t检索规划\t空转未执行\t未发起检索\n", encoding="utf-8")
        (tree / "item_index.slice.jsonl").write_text(
            "".join(json.dumps({"trace_id": trace, "path": path}) + "\n" for trace, path in items),
            encoding="utf-8")
    # 重测归因：case_id 结尾的 eq 决定哪些题能开「改版后」详情（这里 1、2 有、3 没有）。
    attr = base / "03_after_release_retest" / "attribution" / "aime_expert" / "1800_lost_user_backtest"
    attr.mkdir(parents=True, exist_ok=True)
    (attr / "aime_expert_attribution-1800_lost_user_backtest.jsonl").write_text(
        "".join(json.dumps({"session_meta": {"item_id": f"item_{eq}", "case_id": f"set_eq_{eq:05d}"}}) + "\n"
                for eq in (1, 2)), encoding="utf-8")
    if after:
        (manifest / "coverage_after_release_retest.csv").write_text(AFTER_COVERAGE, encoding="utf-8")
    else:
        import shutil
        shutil.rmtree(base / "03_after_release_retest")
    return base


class ScopeLayoutTests(unittest.TestCase):
    def samples(self):
        def sample(slug, trace, task, sub, day, ut="real", model="aime_expert", paths=None,
                   session=None):
            problems = [{"cl": {"path": path}} for path in (paths or [])]
            detail = {"meta": {"task": task, "subtask": sub},
                      "ids": {"session": session or f"s_{slug}", "trace": f"s_{slug}", "case": trace},
                      "attribution": {"turns": [{"trace_id": trace}], "problems": problems}}
            row = {"d": day, "ut": ut, "tid": f"s_{slug}", "m": model, "sid": session or f"s_{slug}"}
            return (slug, detail, row, {})
        return [
            sample("sess-t1", "t1", "取数规划", "目标错配", "2026-10-20", session="thread_1"),
            sample("sess-t2", "t2", "检索规划", "空转未执行", "2026-10-21", model="aime_fast",
                   session="thread_2"),
            sample("online-1", "t9", "行情解读", "股价走势", "2026-11-07", paths=["S9.M1.1"]),
        ]

    def test_scope_round_reads_three_sides_from_scope_files(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            scope_round_dir(root)
            rnd = ab_test.ab_payload(root, "aime", samples=self.samples())["rounds"][0]
            self.assertEqual((rnd["version"], rnd["label"], rnd["released_at"]),
                             ("1106", "v1106", "2026-11-06"))
            self.assertEqual(rnd["targets"], 3)
            self.assertEqual(rnd["status"], {"A": 2, "C": 1})
            self.assertEqual(rnd["sources"], [["daily", 1], ["lost_user", 1]])
            self.assertEqual(rnd["dates"], ["2026-10-20", "2026-10-22"])
            self.assertEqual(rnd["sides"]["before"], {"traces": 2, "hits": 3})
            self.assertEqual(rnd["sides"]["after"], {"traces": 1, "hits": 1})
            self.assertEqual((rnd["sides"]["online"]["traces"], rnd["sides"]["online"]["hits"]),
                             (1, 1))
            self.assertEqual(rnd["sides"]["online"]["from"], "2026-11-06")
            self.assertEqual(rnd["sides"]["online"]["to"], "2026-11-07")

            leaves = {leaf["id"]: leaf for leaf in rnd["leaves"]}
            self.assertEqual((leaves["S1.M2.1"]["before"], leaves["S1.M2.1"]["after"]),
                             (1, 0))                     # after available: real 0, not null
            self.assertEqual(leaves["S1.M2.1.3"]["after"], 0)
            self.assertEqual(leaves["S2.M1.2"]["after"], 1)
            self.assertEqual(leaves["S1.M2.1"]["online"], 0)  # online available: real 0

            # Scenes come from the build samples: the coverage files carry no task/subtask.
            before_matrix = {tuple(row[:2]): row[2] for row in rnd["matrix"]["before"]}
            self.assertEqual(before_matrix[("取数规划", "目标错配")],
                             [["S1.M2.1", 1], ["S1.M2.1.3", 1]])
            self.assertEqual(before_matrix[("检索规划", "空转未执行")], [["S2.M1.2", 1]])
            # 场景按 trace 归属，不随新落点变化：t1 仍是「取数规划 · 目标错配」。
            self.assertEqual(rnd["matrix"]["after"],
                             [["取数规划", "目标错配", [["S2.M1.2", 1]]]])
            self.assertEqual(rnd["matrix"]["online"],
                             [["行情解读", "股价走势", [["S9.M1.1", 1]]]])

            refs = {ref["trace"]: ref for ref in rnd["sample_refs"]["before"]}
            self.assertEqual((refs["t1"]["task"], refs["t1"]["sub"]), ("取数规划", "目标错配"))
            self.assertEqual(refs["t1"]["slug"], "sess-t1")
            self.assertEqual(refs["t2"]["slug"], "sess-t2")
            self.assertEqual(rnd["sample_refs"]["online"][0]["slug"], "online-1")

            # 同题 pairs：全部 eq 行，before/after 各自带详情入口。
            pairs = rnd["pairs"]
            self.assertEqual([pair["eq"] for pair in pairs], [1, 2, 3])
            self.assertEqual([pair["q"] for pair in pairs], ["q1", "q2", "q3"])
            first = pairs[0]
            self.assertEqual((first["id"], first["scene"], first["sub"]),
                             ("t1", "取数规划", "目标错配"))
            self.assertEqual(first["before"], {
                "trace": "t1", "model": "expert", "detail": "sess-t1", "n": 2,
                "paths": ["S1.M2.1", "S1.M2.1.3"], "status": "已评测_有落点",
            })
            self.assertEqual(first["after"], {
                "trace": "t1", "model": "expert", "detail": 1, "n": 1,
                "paths": ["S2.M1.2"], "status": "已重测_有归因",
            })
            third = pairs[2]
            self.assertEqual((third["before"]["n"], third["before"]["paths"],
                              third["before"]["detail"]), (0, [], None))
            self.assertIsNone(third["after"]["detail"])   # 没有 attribution → 不能开详情

            # sample_refs 的对比字段：before 用 slug，after detail 是能开详情的 eq。
            refs = {ref["trace"]: ref for ref in rnd["sample_refs"]["before"]}
            self.assertEqual((refs["t1"]["pair"], refs["t1"]["eq"], refs["t1"]["q"],
                              refs["t1"]["detail"]), ("t1", 1, "q1", "sess-t1"))
            self.assertEqual((refs["t2"]["pair"], refs["t2"]["eq"], refs["t2"]["q"],
                              refs["t2"]["detail"]), ("t2", 2, "q2", "sess-t2"))
            after_refs = {ref["trace"]: ref for ref in rnd["sample_refs"]["after"]}
            self.assertEqual((after_refs["t1"]["pair"], after_refs["t1"]["eq"],
                              after_refs["t1"]["q"], after_refs["t1"]["detail"]),
                             ("t1", 1, "q1", 1))

    def test_round_scopes_every_side_to_its_release_models(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            base = scope_round_dir(root)
            coverage = base / "00_manifest" / "coverage_before_release_cluster.csv"
            coverage.write_text(
                BEFORE_COVERAGE
                + "t4,thread_4,,2026-10-23T10:00:00Z,fast,q4,string,已评测_有落点,,daily,daily_fast,e2.jsonl,4,1,,1,S1.M2.1,,,,\n",
                encoding="utf-8")
            tree = base / "02_before_release/cluster_tree/aime_expert/item_index.slice.jsonl"
            tree.write_text(tree.read_text(encoding="utf-8")
                            + json.dumps({"trace_id": "t4", "path": "S1.M2.1"}) + "\n", encoding="utf-8")
            # 同一道题的重测行也存在（eq4），但 before 是 fast：不能拿来和 expert 的 after 对比。
            (base / "00_manifest" / "coverage_after_release_retest.csv").write_text(
                AFTER_COVERAGE + "t4,4,已重测_有归因,0,thread_r4,0,,\n", encoding="utf-8")

            def deep_sample(slug, model, trace):
                detail = {"meta": {"task": "行情解读", "subtask": "股价走势"},
                          "attribution": {"problems": [{"cl": {"path": "S9.M1.1"}}]}}
                return (slug, detail, {"d": "2026-11-07", "ut": "real", "tid": trace, "m": model}, {})

            samples = self.samples() + [deep_sample("online-fast", "aime_fast", "t11")]
            rnd = ab_test.ab_payload(root, "aime", samples=samples)["rounds"][0]
            # 1106 retests expert only: the older fast trace and the fast online sample are out.
            self.assertEqual(rnd["models"], ["expert"])
            self.assertNotIn("t4", {ref["trace"] for ref in rnd["sample_refs"]["before"]})
            self.assertEqual(rnd["sides"]["before"], {"traces": 2, "hits": 3})
            self.assertEqual(rnd["sides"]["online"]["traces"], 1)
            self.assertEqual([ref["slug"] for ref in rnd["sample_refs"]["online"]], ["online-1"])
            # pairs 仍保留全部题（AB 面板任意 ref 都能解析），但跨模型口径的 before 置 null；
            # q 仍在，after 正常。专家口径的 before 不受影响。
            pairs = {pair["eq"]: pair for pair in rnd["pairs"]}
            self.assertEqual(sorted(pairs), [1, 2, 3, 4])
            self.assertIsNotNone(pairs[1]["before"])
            fast_pair = pairs[4]
            self.assertIsNone(fast_pair["before"])
            self.assertEqual((fast_pair["id"], fast_pair["q"], fast_pair["after"]["trace"]),
                             ("t4", "q4", "t4"))
            self.assertIsNone(fast_pair["after"]["detail"])

    def test_missing_after_scope_is_null_everywhere(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            scope_round_dir(root, after=False)
            rnd = ab_test.ab_payload(root, "aime", samples=self.samples())["rounds"][0]
            self.assertIsNone(rnd["sides"]["after"])
            self.assertIsNone(rnd["matrix"]["after"])
            self.assertTrue(all(leaf["after"] is None for leaf in rnd["leaves"]))
            self.assertTrue(all(node["after"] is None for node in rnd["nodes"]))
            self.assertIsNotNone(rnd["matrix"]["before"])
            # 重测未落盘时 pairs 退化为按 targets 顺序的 before-only 列表，而不是空列表。
            pairs = rnd["pairs"]
            self.assertEqual([pair["eq"] for pair in pairs], [1, 2, 3])
            self.assertTrue(all(pair["after"] is None for pair in pairs))
            self.assertEqual((pairs[0]["id"], pairs[0]["q"], pairs[0]["before"]["detail"]),
                             ("t1", "q1", "sess-t1"))

    def test_trace_scenes_csv_wins_over_samples(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            base = scope_round_dir(root)
            (base / "00_manifest" / "trace_scenes.csv").write_text(
                "trace_id,session_id,task,subtask\nt2,thread_2,事件解读,行情事件解读\n",
                encoding="utf-8")
            rnd = ab_test.ab_payload(root, "aime", samples=self.samples())["rounds"][0]
            pairs = {tuple(row[:2]) for row in rnd["matrix"]["before"]}
            self.assertIn(("事件解读", "行情事件解读"), pairs)
            self.assertNotIn(("检索规划", "空转未执行"), pairs)

    def test_build_writes_scope_payload_and_entry(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            datasets, static = root / "datasets", root / "static"
            seed(datasets)
            add_aime(datasets)
            base = scope_round_dir(datasets)
            (base / "round.json").write_text(json.dumps({"released_at": "2026-10-31"}), encoding="utf-8")
            proc = subprocess.run(
                [sys.executable, str(DASHBOARD / "build.py"), "--datasets", str(datasets),
                 "--out", str(static)],
                check=True, capture_output=True, text=True, env={**os.environ},
            )
            self.assertGreater(json.loads(proc.stdout.strip().splitlines()[-1])["ab_kb"], 0)
            payload = json.loads((static / "abtests-aime.json").read_text(encoding="utf-8"))
            rnd = payload["rounds"][0]
            self.assertEqual((rnd["sides"]["before"]["traces"], rnd["sides"]["after"]["traces"]), (2, 1))
            self.assertEqual(len(rnd["pairs"]), 3)
            self.assertIsInstance(rnd["matrix"]["after"], list)
            self.assertIsInstance(rnd["matrix"]["online"], list)
            entry = json.loads((static / "data-aime.json").read_text())["products"]["aime"]["ab"]
            self.assertEqual((entry["rounds"], entry["paired"], entry["online"]), (1, True, True))

    def test_scope_signature_tracks_after_backfill(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            scope_round_dir(root, after=False)
            baseline = ab_test.rounds_signature(root)
            base = scope_round_dir(root, after=True)
            self.assertNotEqual(ab_test.rounds_signature(root), baseline)
            (base / "00_manifest" / "trace_scenes.csv").write_text(
                "trace_id,session_id,task,subtask\nt1,thread_1,取数规划,目标错配\n", encoding="utf-8")
            self.assertNotEqual(ab_test.rounds_signature(root),
                                baseline)
            # 重测归因变化（只多一行）也要让 after.detail 的 payload 重建。
            signature = ab_test.rounds_signature(root)
            attr = base / "03_after_release_retest" / "attribution" / "aime_expert" / "batch"
            attr.mkdir(parents=True, exist_ok=True)
            (attr / "aime_expert_attribution-batch.jsonl").write_text(
                json.dumps({"session_meta": {"case_id": "set_eq_00009"}}) + "\n", encoding="utf-8")
            self.assertNotEqual(ab_test.rounds_signature(root), signature)
