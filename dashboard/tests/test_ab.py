"""AB 测试记录: canonical before/after round payload and its place in the build."""
import csv
import gzip
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
    from dashboard.tests.test_trends import add_aime
except ImportError:  # `cd dashboard && python3 -m unittest discover -s tests`
    from test_empty_data import DASHBOARD, seed, write_jsonl
    from test_trends import add_aime

sys.path.insert(0, str(DASHBOARD))

import ab_test  # noqa: E402


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

PAIRS_COLUMNS = [
    "eq_index", "case_key", "trace_id", "session_id", "question_time", "question",
    "task", "subtask", "before_status", "before_b_reason", "before_trace_id",
    "before_n_problem", "before_severity", "before_cls_paths", "before_cls_labels",
    "after_status", "after_trace_id", "after_session_id", "after_n_problem",
    "after_severity", "after_cls_paths", "after_cls_labels",
]


def canonical_round_dir(root: Path, name="version_20261106_aime_expert", after=True, with_scenes=False):
    """Seed a round in the canonical ab_test layout."""
    base = root / "1_aime" / "ab_test" / name
    (base / "bench").mkdir(parents=True, exist_ok=True)
    (base / "index_stats").mkdir(parents=True, exist_ok=True)
    (base / "agent_before_opt" / "eval_output").mkdir(parents=True, exist_ok=True)
    (base / "agent_before_opt" / "cluster").mkdir(parents=True, exist_ok=True)

    ver = name.split("_")[1] if name.startswith("version_") else "20261106"
    rel_date = f"{ver[:4]}-{ver[4:6]}-{ver[6:8]}" if len(ver) == 8 else "2026-11-06"
    (base / "index_stats" / "meta.json").write_text(
        json.dumps({
            "version": ver,
            "model": "aime_expert",
            "released_at": rel_date,
            "label": f"{ver[4:]} 发版",
            "title": f"AIME v{ver[4:]} 优化前后对比",
            "before_label": "优化前",
            "after_label": "优化后",
            "tier": 3,
        }, ensure_ascii=False),
        encoding="utf-8",
    )

    rows = [
        {
            "eq_index": 1, "case_key": "eq_00001", "trace_id": "t1", "session_id": "thread_1",
            "question_time": "2026-10-20T10:00:00Z", "question": "q1",
            "task": "取数规划" if with_scenes else "", "subtask": "目标错配" if with_scenes else "",
            "before_status": "evaluated", "before_b_reason": "", "before_trace_id": "t1",
            "before_n_problem": 2, "before_severity": "P1",
            "before_cls_paths": "S1.M2.1;S1.M2.1.3", "before_cls_labels": "l1;l2",
            "after_status": "evaluated" if after else "pending",
            "after_trace_id": "tr1" if after else "", "after_session_id": "thread_r1" if after else "",
            "after_n_problem": 1 if after else 0, "after_severity": "P2" if after else "",
            "after_cls_paths": "S2.M1.2" if after else "", "after_cls_labels": "l3" if after else "",
        },
        {
            "eq_index": 2, "case_key": "eq_00002", "trace_id": "t2", "session_id": "thread_2",
            "question_time": "2026-10-21T10:00:00Z", "question": "q2",
            "task": "检索规划" if with_scenes else "", "subtask": "空转未执行" if with_scenes else "",
            "before_status": "evaluated", "before_b_reason": "", "before_trace_id": "t2",
            "before_n_problem": 1, "before_severity": "P2",
            "before_cls_paths": "S2.M1.2", "before_cls_labels": "l3",
            "after_status": "evaluated" if after else "pending",
            "after_trace_id": "tr2" if after else "", "after_session_id": "thread_r2" if after else "",
            "after_n_problem": 0, "after_severity": "GOLD" if after else "",
            "after_cls_paths": "", "after_cls_labels": "",
        },
        {
            "eq_index": 3, "case_key": "eq_00003", "trace_id": "t3", "session_id": "thread_3",
            "question_time": "2026-10-22T10:00:00Z", "question": "q3",
            "task": "", "subtask": "",
            "before_status": "missing", "before_b_reason": "", "before_trace_id": "",
            "before_n_problem": 0, "before_severity": "",
            "before_cls_paths": "", "before_cls_labels": "",
            "after_status": "missing",
            "after_trace_id": "", "after_session_id": "",
            "after_n_problem": 0, "after_severity": "",
            "after_cls_paths": "", "after_cls_labels": "",
        },
    ]
    with (base / "index_stats" / "pairs_index.csv").open("w", encoding="utf-8", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=PAIRS_COLUMNS)
        w.writeheader()
        for r in rows:
            w.writerow(r)

    (base / "bench" / "bench.jsonl").write_text(
        "".join(json.dumps({"eq_index": r["eq_index"], "case_key": r["case_key"],
                            "trace_id": r["trace_id"], "question": r["question"]}) + "\n" for r in rows),
        encoding="utf-8",
    )
    (base / "agent_before_opt" / "eval_output" / "attribution.jsonl").write_text(
        "".join(json.dumps({
            "session_meta": {"case_id": f"eq_{eq:05d}", "trace_id": f"t{eq}", "session_id": f"thread_{eq}"},
            "turns": [{"meta": {"trace_id": f"t{eq}"}, "summary": "ok", "problem": []}],
        }) + "\n" for eq in (1, 2)),
        encoding="utf-8",
    )
    before_cluster = base / "agent_before_opt" / "cluster"
    (before_cluster / "cluster_tree.json").write_text(json.dumps(TREE, ensure_ascii=False), encoding="utf-8")
    (before_cluster / "leaves.tsv").write_text(
        "path\tl1\tl2\tname\nS1.M2.1\t取数规划\t目标错配\t请求照抄原句\nS2.M1.2\t检索规划\t空转未执行\t未发起检索\n",
        encoding="utf-8",
    )
    (before_cluster / "item_index.jsonl").write_text(
        "".join(json.dumps({"trace_id": t, "path": p}) + "\n" for t, p in [("t1", "S1.M2.1"), ("t1", "S1.M2.1.3"), ("t2", "S2.M1.2")]),
        encoding="utf-8",
    )

    if after:
        (base / "agent_after_opt" / "eval_output").mkdir(parents=True, exist_ok=True)
        (base / "agent_after_opt" / "cluster").mkdir(parents=True, exist_ok=True)
        (base / "agent_after_opt" / "eval_output" / "attribution.jsonl").write_text(
            "".join(json.dumps({
                "session_meta": {"item_id": f"item_{eq}", "case_id": f"set_eq_{eq:05d}"},
                "turns": [{"meta": {"trace_id": f"tr{eq}"}, "summary": "ok", "problem": []}],
            }) + "\n" for eq in (1, 2)),
            encoding="utf-8",
        )
        after_cluster = base / "agent_after_opt" / "cluster"
        (after_cluster / "cluster_tree.json").write_text(json.dumps(TREE, ensure_ascii=False), encoding="utf-8")
        (after_cluster / "leaves.tsv").write_text(
            "path\tl1\tl2\tname\nS2.M1.2\t检索规划\t空转未执行\t未发起检索\n", encoding="utf-8"
        )
        (after_cluster / "item_index.jsonl").write_text(
            json.dumps({"trace_id": "t1", "path": "S2.M1.2"}) + "\n", encoding="utf-8"
        )
    return base


class PayloadTests(unittest.TestCase):
    def payload(self, root: Path):
        return ab_test.ab_payload(root, "aime")

    def test_round_metadata_and_signature(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            canonical_round_dir(root)
            before = ab_test.rounds_signature(root)
            rnd = self.payload(root)["rounds"][0]
            self.assertEqual((rnd["released_at"], rnd["release_label"]), ("2026-11-06", "1106 发版"))
            self.assertEqual((rnd["before_label"], rnd["after_label"]), ("优化前", "优化后"))
            self.assertNotIn("online", rnd["sides"])
            self.assertNotIn("online", rnd["matrix"])
            self.assertNotIn("online", rnd["sample_refs"])
            # Adding another round or completing after invalidates signature
            canonical_round_dir(root, name="version_20261201_aime_expert", after=False)
            self.assertNotEqual(ab_test.rounds_signature(root), before)
            signature = ab_test.rounds_signature(root)
            canonical_round_dir(root, name="version_20261201_aime_expert", after=True)
            self.assertNotEqual(ab_test.rounds_signature(root), signature)

    def test_sample_recall_keeps_only_questions_with_both_details(self):
        pairs = [
            {"id": "both", "before": {"detail": "before-1"}, "after": {"detail": "after-1"}},
            {"id": "before-only", "before": {"detail": "before-2"}, "after": {"detail": None}},
            {"id": "after-only", "before": {"detail": None}, "after": {"detail": "after-3"}},
        ]
        refs = {
            "before": [{"pair": "both"}, {"pair": "before-only"}, {"pair": "after-only"}],
            "after": [{"pair": "both"}, {"pair": "before-only"}, {"pair": "after-only"}],
        }
        ab_test._paired_only(pairs, refs)
        self.assertEqual([pair["id"] for pair in pairs], ["both"])
        self.assertEqual([ref["pair"] for ref in refs["before"]], ["both"])
        self.assertEqual([ref["pair"] for ref in refs["after"]], ["both"])

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
            canonical_round_dir(datasets, with_scenes=True)

            summary = self.run_build(datasets, static)
            self.assertGreater(summary["ab_kb"], 0)
            abtests = self.abtests(static, "aime")
            self.assertEqual([rnd["id"] for rnd in abtests["rounds"]], ["version_20261106_aime_expert"])
            self.assertFalse((static / "abtests-wencai.json").exists())

            data = json.loads((static / "data-aime.json").read_text(encoding="utf-8"))
            entry = data["products"]["aime"]["ab"]
            self.assertEqual(entry["url"], "abtests-aime.json")
            self.assertEqual((entry["rounds"], entry["targets"], entry["paired"]), (1, 3, True))
            self.assertNotIn("online", entry)
            wencai = json.loads((static / "data-wencai.json").read_text(encoding="utf-8"))
            self.assertNotIn("ab", wencai["products"]["wencai"])

            # Reuse check + round add + removal
            self.assertEqual(self.run_build(datasets, static).get("reused"), 1)
            canonical_round_dir(datasets, name="version_20261201_aime_expert", with_scenes=True)
            summary = self.run_build(datasets, static)
            self.assertNotIn("reused", summary)
            self.assertEqual(len(self.abtests(static, "aime")["rounds"]), 2)

            shutil.rmtree(datasets / "1_aime" / "ab_test")
            self.run_build(datasets, static)
            self.assertFalse((static / "abtests-aime.json").exists())
            self.assertFalse((static / "abtests-aime.json.gz").exists())


class CanonicalLayoutTests(unittest.TestCase):
    def samples(self):
        def sample(slug, trace, task, sub, day, model="aime_expert", session=None):
            detail = {"meta": {"task": task, "subtask": sub},
                      "ids": {"session": session or f"s_{slug}", "trace": f"s_{slug}", "case": trace},
                      "attribution": {"turns": [{"trace_id": trace}], "problems": []}}
            row = {"d": day, "ut": "real", "tid": f"s_{slug}", "m": model, "sid": session or f"s_{slug}"}
            return (slug, detail, row, {})
        return [
            sample("sess-t1", "t1", "取数规划", "目标错配", "2026-10-20", session="thread_1"),
            sample("sess-t2", "t2", "检索规划", "空转未执行", "2026-10-21", session="thread_2"),
        ]

    def test_reads_both_sides_symmetrically(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            canonical_round_dir(root)
            rnd = ab_test.ab_payload(root, "aime", samples=self.samples())["rounds"][0]
            self.assertEqual((rnd["version"], rnd["label"], rnd["released_at"]),
                             ("1106", "1106 发版", "2026-11-06"))
            self.assertEqual(rnd["targets"], 3)
            self.assertEqual(rnd["status"], {"A": 2, "C": 1})
            self.assertEqual(rnd["dates"], ["2026-10-20", "2026-10-22"])
            before, after = rnd["sides"]["before"], rnd["sides"]["after"]
            self.assertEqual((before["traces"], before["hits"], before["problem_traces"]), (2, 3, 2))
            self.assertEqual((after["traces"], after["hits"], after["problem_traces"]), (2, 1, 1))

            leaves = {leaf["id"]: leaf for leaf in rnd["leaves"]}
            self.assertEqual((leaves["S1.M2.1"]["before"], leaves["S1.M2.1"]["after"]), (1, 0))
            self.assertEqual(leaves["S1.M2.1.3"]["after"], 0)
            self.assertEqual(leaves["S2.M1.2"]["after"], 1)
            self.assertNotIn("online", leaves["S1.M2.1"])

            before_matrix = {tuple(row[:2]): row[2] for row in rnd["matrix"]["before"]}
            self.assertEqual(before_matrix[("取数规划", "目标错配")], [["S1.M2.1", 1], ["S1.M2.1.3", 1]])
            self.assertEqual(before_matrix[("检索规划", "空转未执行")], [["S2.M1.2", 1]])
            self.assertEqual(rnd["matrix"]["after"], [["取数规划", "目标错配", [["S2.M1.2", 1]], 1]])

            pairs = rnd["pairs"]
            self.assertEqual([pair["eq"] for pair in pairs], [1, 2])
            self.assertEqual(pairs[0]["before"]["detail"], "before-1")
            self.assertEqual(pairs[0]["after"]["detail"], "after-1")
            before_refs = {ref["trace"]: ref for ref in rnd["sample_refs"]["before"]}
            self.assertEqual(before_refs["t1"]["detail"], "before-1")
            after_refs = {ref["pair"]: ref for ref in rnd["sample_refs"]["after"]}
            self.assertEqual(after_refs["t1"]["detail"], "after-1")

    def test_missing_after_scope_is_null_everywhere(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            canonical_round_dir(root, after=False)
            rnd = ab_test.ab_payload(root, "aime", samples=self.samples())["rounds"][0]
            self.assertIsNone(rnd["sides"]["after"])
            self.assertIsNone(rnd["matrix"]["after"])
            self.assertTrue(all(leaf["after"] is None for leaf in rnd["leaves"]))
            self.assertTrue(all(node["after"] is None for node in rnd["nodes"]))
            self.assertIsNotNone(rnd["matrix"]["before"])
            self.assertEqual(rnd["pairs"], [])
            self.assertEqual(rnd["sample_refs"]["before"], [])
            self.assertEqual(rnd["sample_refs"]["after"], [])

    def test_signature_tracks_human_read_and_after_attr(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            base = canonical_round_dir(root, after=False)
            baseline = ab_test.rounds_signature(root)
            canonical_round_dir(root, after=True)
            sig2 = ab_test.rounds_signature(root)
            self.assertNotEqual(sig2, baseline)
            (base / "agent_after_opt" / "eval_output" / "attribution_human_read.jsonl").write_text(
                "{}\n", encoding="utf-8"
            )
            self.assertNotEqual(ab_test.rounds_signature(root), sig2)


class VerifyAndGptTests(unittest.TestCase):
    VERIFY_ROW = {
        "question_id": "t1",
        "question": "q1",
        "paired_model": [
            {"model_id": "before_release", "model_label": "优化前", "has_answer": True},
            {"model_id": "after_retest", "model_label": "优化后", "has_answer": True},
        ],
        "verifiable_fact_check_list": [
            {"model_id": "before_release",
             "common": [{"fact_id": "c1", "what_to_check": "通用事实"}],
             "special": [{"fact_id": "s1", "what_to_check": "专属事实"}]},
            {"model_id": "after_retest",
             "common": [{"fact_id": "c1", "what_to_check": "通用事实"}],
             "special": []},
        ],
        "eval_per_model": [
            {"model_id": "before_release",
             "common": [{"fact_id": "c1", "what_to_check": "通用事实", "model_answer": "答 1",
                         "is_correct": "对", "correct_answer": "实际 1",
                         "correct_answer_source": "Yahoo；https://example.com/a",
                         "responsible_component": "", "attribution": "对在区间"}],
             "special": [{"fact_id": "s1", "what_to_check": "专属事实", "model_answer": "答 2",
                          "is_correct": "错", "correct_answer": "实际 2",
                          "correct_answer_source": "", "responsible_component": "答案合成·推断",
                          "attribution": "错在幅度"}]},
            {"model_id": "after_retest",
             "common": [{"fact_id": "c1", "what_to_check": "通用事实", "model_answer": "答 3",
                         "is_correct": "部分对", "correct_answer": "实际 3",
                         "correct_answer_source": "", "responsible_component": "",
                         "attribution": "部分命中"}],
             "special": []},
        ],
    }

    GPT_RAW = {
        "key": "t1", "question": "q1", "question_time": "2026-11-11T07:50:44+00:00",
        "latency_s": 58.4, "model": "gpt-6.1-sol", "effort": "medium",
        "response": {
            "status": "completed",
            "usage": {"input_tokens": 10, "output_tokens": 20},
            "output": [
                {"type": "web_search_call", "status": "completed",
                 "action": {"queries": ["AAPL forecast"]}},
                {"type": "message", "role": "assistant", "content": [{
                    "type": "output_text", "text": "GPT 回答正文",
                    "annotations": [{"type": "url_citation", "title": "Yahoo",
                                     "url": "https://example.com/a"}],
                }]},
            ],
        },
    }

    def add_verify(self, base: Path, rows):
        (base / "verify").mkdir(parents=True, exist_ok=True)
        (base / "verify" / "verify.jsonl").write_text(
            "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows), encoding="utf-8"
        )

    def add_gpt(self, base: Path, keys, raws):
        gpt = base / "gpt_answer"
        (gpt / "raw").mkdir(parents=True, exist_ok=True)
        (gpt / "questions.jsonl").write_text(
            "".join(json.dumps({"key": key, "question": f"q {key}"}) + "\n" for key in keys),
            encoding="utf-8",
        )
        for key, payload in raws.items():
            (gpt / "raw" / f"{key}.json").write_text(json.dumps(payload), encoding="utf-8")

    def test_verify_and_gpt(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            base = canonical_round_dir(root, with_scenes=True)
            sig0 = ab_test.rounds_signature(root)
            self.add_verify(base, [self.VERIFY_ROW])
            self.assertNotEqual(ab_test.rounds_signature(root), sig0)
            sig1 = ab_test.rounds_signature(root)
            self.add_gpt(base, ["t1", "t3"], {"t1": self.GPT_RAW})
            self.assertNotEqual(ab_test.rounds_signature(root), sig1)

            rnd = ab_test.ab_payload(root, "aime")["rounds"][0]
            self.assertIn("t1", rnd["verify"])
            self.assertEqual(rnd["gpt"], {"total": 2, "answered": 1, "model": "gpt-6.1-sol", "effort": "medium"})
            ans = ab_test.read_gpt_answer(base, "t1")
            self.assertEqual(ans["answer"], "GPT 回答正文")
            self.assertIsNone(ab_test.read_gpt_answer(base, "../t1"))


class ABReadRowsTests(unittest.TestCase):
    def test_large_csv_cell_is_read(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "pairs_index.csv"
            path.write_text("a,b\n" + "x" * 200000 + ",1\n", encoding="utf-8")
            rows = ab_test.read_rows(path)
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0]["b"], "1")


if __name__ == "__main__":
    unittest.main()
