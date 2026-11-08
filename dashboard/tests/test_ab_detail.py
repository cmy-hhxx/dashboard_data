"""AB 改版后详情：ABDetailBuilder 的三源索引、item_index 落点回填、缓存与 server 路由。"""
import gzip
import json
import sys
import tempfile
import threading
import time
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path

DASHBOARD = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(DASHBOARD))

import ab_detail  # noqa: E402

ROUND = "0_version1106_test"

COVERAGE = """trace_id,eq_index,retest_state,n_problem,retest_session_id,cls_n_items,cls_paths,cls_labels
T1,1,已重测_有归因,2,thread_r1,2,S1.M2.1;S2.M1.2,标签乙;标签甲
T2,2,重测_无完整最终回答,0,,0,,
T3,3,已重测_有归因,1,thread_r3,1,S3.M1.1,标签丙
T4,4,已重测_有归因,1,thread_r4,1,S4.M1.1,标签丁;标签戊
T5,5,已重测_有归因,2,thread_r5,2,S5.M1.1;S5.M1.2,标签X;标签X
T6,6,已重测_有归因,3,thread_r6,3,S6.M1.1;S6.M1.1;S6.S1.1,标签M;标签N;会话标签
"""


def attribution(eq, item, question, labels, session_labels=(), trace=None):
    return json.dumps({
        "session_meta": {
            "item_id": item, "case_id": f"expert_questions_eq_{eq:05d}",
            "trace_id": f"thread_r{eq}", "session_id": f"thread_r{eq}",
            "question": question, "request_time": "2026-11-07 03:00:00",
        },
        "session_summary": "",
        "session_problem": [
            {"label": label, "severity": "P2", "definition": "d", "reason": "r",
             "component": "planner", "evidence": []}
            for label in session_labels
        ],
        "turns": [{
            "meta": {"trace_id": trace or f"tr{eq}", "name": "expert-analyst"},
            "summary": "ok", "is_correct": False, "correct_reason": "",
            "problem": [
                {"label": label, "severity": "P1", "definition": "d", "reason": "r",
                 "component": "planner", "evidence": []}
                for label in labels
            ],
        }],
    }, ensure_ascii=False)


def compact(item, eq):
    return json.dumps({
        "session_meta": {"item_id": item, "case_id": f"expert_questions_eq_{eq:05d}"},
        "session_overview": ["概览"],
        "trace_meta": [],
        "turns": [{}],
    }, ensure_ascii=False)


def slim(item, eq, question, pad=0):
    # item_id deliberately after a long field: real rows put it past 8 KB (max ~32 KB).
    meta = {"request_time": "2026-11-07 03:06:15"}
    if pad:
        meta["context"] = "x" * pad
    meta.update({"item_id": item, "case_id": f"expert_questions_eq_{eq:05d}",
                 "question": question})
    return json.dumps({
        "meta": meta,
        "traces": [{
            "meta": {"trace_id": f"tr{eq}"},
            "messages": [{"type": "user_question", "content": question}],
        }],
    }, ensure_ascii=False)


def item_row(trace, retest_trace, json_path, path, label, edge=False):
    return json.dumps({
        "trace_id": trace, "retest_trace_id": retest_trace,
        "session_id": f"thread_r{retest_trace[2:]}", "json_path": json_path,
        "path": path, "edge": edge, "label": label,
        "request_time": "2026-11-07 03:08:16",
    }, ensure_ascii=False)


def seed_round(datasets: Path):
    base = datasets / "1_aime" / "ab_test" / ROUND
    manifest = base / "00_manifest"
    manifest.mkdir(parents=True, exist_ok=True)
    (manifest / "coverage_after_release_retest.csv").write_text(COVERAGE, encoding="utf-8")
    attr = base / "03_after_release_retest" / "attribution" / "aime_expert" / "batch1"
    attr.mkdir(parents=True, exist_ok=True)
    (attr / "aime_expert_attribution-batch1.jsonl").write_text(
        "\n".join([
            attribution(1, "i1", "真实问题一", ["标签甲", "标签乙"]),
            # eq2 有归因但没有输入行：不能生成详情。
            attribution(2, "i2", "真实问题二", ["标签丙"]),
            attribution(3, "i3", "真实问题三", ["标签丙"]),
            attribution(4, "i4", "真实问题四", ["标签丁"]),
            attribution(5, "i5", "真实问题五", ["标签X", "标签X"]),
            attribution(6, "i6", "真实问题六", ["标签M", "标签N"], session_labels=["会话标签"]),
        ]) + "\n", encoding="utf-8")
    tree = base / "03_after_release_retest" / "cluster_tree" / "aime_expert"
    tree.mkdir(parents=True, exist_ok=True)
    rows = [
        item_row("T1", "tr1", "turns[0].problem[0]", "S1.M2.1", "标签甲"),
        item_row("T1", "tr1", "turns[0].problem[1]", "S2.M1.2", "标签乙", edge=True),
        item_row("T3", "tr3", "turns[0].problem[0]", "S3.M1.1", "标签丙"),
        # T4 的 coverage paths/labels 不平行；item_index 才是权威落点。
        item_row("T4", "tr4", "turns[0].problem[0]", "S4.M1.1", "标签丁"),
        item_row("T5", "tr5", "turns[0].problem[0]", "S5.M1.1", "标签X"),
        item_row("T5", "tr5", "turns[0].problem[1]", "S5.M1.2", "标签X"),
        item_row("T6", "tr6", "turns[0].problem[0]", "S6.M1.1", "标签M"),
        # turns[0].problem[1] 故意缺失 → 该 problem 留 None，不猜。
        item_row("T6", "tr6", "session_problem[0]", "S6.S1.1", "会话标签"),
    ]
    (tree / "item_index.slice.jsonl").write_text("\n".join(rows) + "\n", encoding="utf-8")
    comp = base / "99_provenance" / "retest_eval_run" / "compact"
    comp.mkdir(parents=True, exist_ok=True)
    (comp / "aime_expert_compact-batch1.jsonl").write_text(
        "\n".join([compact("i1", 1), compact("i2", 2), compact("i4", 4)]) + "\n",
        encoding="utf-8")
    inp = base / "99_provenance" / "retest_input"
    inp.mkdir(parents=True, exist_ok=True)
    # 文件名的批次可以和数据不一致（线上是 1800_lost_uesr_backtest），join 只认 item_id。
    (inp / "batch1.slim.jsonl").write_text(
        "\n".join([slim("i1", 1, "真实问题一", pad=12000), slim("i3", 3, "真实问题三"),
                   slim("i4", 4, "真实问题四"), slim("i5", 5, "真实问题五"),
                   slim("i6", 6, "真实问题六")]) + "\n", encoding="utf-8")
    return base


class ABDetailTests(unittest.TestCase):
    def build(self, folder):
        root = Path(folder)
        datasets = root / "datasets"
        seed_round(datasets)
        builder = ab_detail.ABDetailBuilder(datasets, root / "cache", root / "static" / "ab_samples")
        return builder, root

    def test_builds_real_shape_detail_and_backfills_item_index(self):
        with tempfile.TemporaryDirectory() as folder:
            builder, root = self.build(folder)
            path = builder.ensure(ROUND, 1)
            self.assertIsNotNone(path)
            self.assertTrue(path.is_file())
            self.assertEqual(path, root / "static" / "ab_samples" / ROUND / "1.json")
            detail = json.loads(path.read_text(encoding="utf-8"))
            self.assertEqual(detail["question"], "真实问题一")
            self.assertEqual(detail["ab"]["round"], ROUND)
            self.assertEqual((detail["ab"]["eq"], detail["ab"]["trace"]), (1, "T1"))
            self.assertEqual(detail["ab"]["retest_trace"], "tr1")
            self.assertEqual(detail["model"], "expert")
            self.assertEqual(detail["date"], "2026-11-07")
            self.assertIsNotNone(detail["compact"])
            # 落点按 (目标 trace, json_path) 从 item_index 回填，不按 coverage 的 labels 顺序。
            problems = detail["attribution"]["problems"]
            self.assertEqual([problem["label"] for problem in problems], ["标签甲", "标签乙"])
            self.assertEqual(problems[0]["cl"], {"path": "S1.M2.1", "edge": False, "tags": []})
            self.assertEqual(problems[1]["cl"], {"path": "S2.M1.2", "edge": True, "tags": []})
            # 生成 gz（页面按 gz 取，源文件改动后要能重建）。
            gz = Path(str(path) + ".gz")
            self.assertTrue(gz.is_file())
            self.assertEqual(json.loads(gzip.decompress(gz.read_bytes())), detail)
            # 索引缓存落地，第二次调用直接命中，不重写详情。
            index_path = root / "cache" / "ab-details" / f"{ROUND}.json"
            self.assertTrue(index_path.is_file())
            index = json.loads(index_path.read_text(encoding="utf-8"))
            self.assertEqual(index["problem_duplicates"], 0)
            self.assertGreater(len(index["problems"]), 0)
            before = path.stat().st_mtime_ns
            self.assertEqual(builder.ensure(ROUND, 1), path)
            self.assertEqual(path.stat().st_mtime_ns, before)

    def test_unknown_round_and_eq_are_none(self):
        with tempfile.TemporaryDirectory() as folder:
            builder, _ = self.build(folder)
            self.assertIsNone(builder.ensure("9_version9999_test", 1))
            self.assertIsNone(builder.ensure(ROUND, 99))
            self.assertIsNone(builder.ensure(ROUND, 0))
            self.assertIsNone(builder.ensure("../" + ROUND, 1))
            self.assertIsNone(builder.ensure(ROUND, "not-a-number"))

    def test_only_attribution_plus_input_can_generate(self):
        with tempfile.TemporaryDirectory() as folder:
            builder, _ = self.build(folder)
            # eq2 有归因 + coverage，但没有 slim 输入行。
            self.assertIsNone(builder.ensure(ROUND, 2))
            # eq3 有归因和输入、没有 compact：仍可出详情。
            path = builder.ensure(ROUND, 3)
            self.assertIsNotNone(path)
            detail = json.loads(path.read_text(encoding="utf-8"))
            self.assertIsNone(detail["compact"])
            self.assertEqual(detail["attribution"]["problems"][0]["cl"],
                             {"path": "S3.M1.1", "edge": False, "tags": []})

    def test_coverage_label_mismatch_does_not_block_backfill(self):
        with tempfile.TemporaryDirectory() as folder:
            builder, _ = self.build(folder)
            detail = json.loads(builder.ensure(ROUND, 4).read_text(encoding="utf-8"))
            # T4 的 coverage cls_paths/cls_labels 不等长、无法按 label 对齐；
            # item_index 仍然给出权威落点（线上 102 行同类题）。
            self.assertEqual(detail["attribution"]["problems"][0]["cl"],
                             {"path": "S4.M1.1", "edge": False, "tags": []})

    def test_duplicate_labels_use_json_path(self):
        with tempfile.TemporaryDirectory() as folder:
            builder, _ = self.build(folder)
            detail = json.loads(builder.ensure(ROUND, 5).read_text(encoding="utf-8"))
            self.assertEqual([problem["cl"]["path"]
                              for problem in detail["attribution"]["problems"]],
                             ["S5.M1.1", "S5.M1.2"])
            # 12 KB 的 meta 前缀（item_id 在 8192 字节之后）也必须能 join 到输入行。
            self.assertEqual(detail["question"], "真实问题五")

    def test_session_problem_and_missing_item_keys(self):
        with tempfile.TemporaryDirectory() as folder:
            builder, _ = self.build(folder)
            detail = json.loads(builder.ensure(ROUND, 6).read_text(encoding="utf-8"))
            problems = detail["attribution"]["problems"]
            self.assertEqual([problem["label"] for problem in problems],
                             ["标签M", "标签N", "会话标签"])
            self.assertEqual(problems[0]["cl"]["path"], "S6.M1.1")
            self.assertIsNone(problems[1]["cl"])          # item_index 缺这个 json_path → 不猜
            self.assertEqual(problems[2]["cl"]["path"], "S6.S1.1")

    def test_source_change_invalidates_index_and_detail(self):
        with tempfile.TemporaryDirectory() as folder:
            builder, root = self.build(folder)
            path = builder.ensure(ROUND, 1)
            self.assertIsNotNone(path)
            index_path = root / "cache" / "ab-details" / f"{ROUND}.json"
            old_index = json.loads(index_path.read_text(encoding="utf-8"))
            before = path.stat().st_mtime_ns
            time.sleep(0.02)
            base = root / "datasets" / "1_aime" / "ab_test" / ROUND
            # coverage 同内容但 mtime 变 → 索引与详情重建。
            (base / "00_manifest" / "coverage_after_release_retest.csv").write_text(
                COVERAGE, encoding="utf-8")
            self.assertIsNotNone(builder.ensure(ROUND, 1))
            new_index = json.loads(index_path.read_text(encoding="utf-8"))
            self.assertNotEqual(new_index["sig"], old_index["sig"])
            self.assertGreater(new_index["built_at_ns"], old_index["built_at_ns"])
            self.assertGreaterEqual(path.stat().st_mtime_ns, before)
            # item_index 变化同样要让缓存失效（它的 path 是落点权威源）。
            time.sleep(0.02)
            item_index = base / "03_after_release_retest" / "cluster_tree" / "aime_expert" / "item_index.slice.jsonl"
            item_index.write_text(item_index.read_text(encoding="utf-8"), encoding="utf-8")
            self.assertIsNotNone(builder.ensure(ROUND, 1))
            last_index = json.loads(index_path.read_text(encoding="utf-8"))
            self.assertNotEqual(last_index["sig"], new_index["sig"])


class ABRouteTests(unittest.TestCase):
    def test_route_serves_valid_and_404s_malformed(self):
        import server
        with tempfile.TemporaryDirectory() as folder:
            static = Path(folder)
            static.mkdir(parents=True, exist_ok=True)
            old_static, old_ab = server.STATIC, server._ab_builder
            calls = []

            class FakeBuilder:
                def ensure(self, round_id, eq):
                    calls.append((round_id, eq))
                    path = static / "ab_samples" / round_id / f"{eq}.json"
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_text("{}", encoding="utf-8")
                    return path

            server.STATIC, server._ab_builder = str(static), FakeBuilder()
            httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
            thread = threading.Thread(target=httpd.serve_forever, daemon=True)
            thread.start()
            try:
                import http.client
                conn = http.client.HTTPConnection("127.0.0.1", httpd.server_address[1], timeout=5)

                def get(path):
                    conn.request("GET", path)
                    response = conn.getresponse()
                    return response.status, response.read()

                self.assertEqual(get(f"/ab_samples/{ROUND}/1.json")[0], 200)
                self.assertEqual(get(f"/ab_samples/{ROUND}/0.json"),
                                 (404, b"ab sample detail unavailable"))
                self.assertEqual(get("/ab_samples/bad!round/1.json"),
                                 (404, b"ab sample detail unavailable"))
                self.assertEqual(get("/ab_samples/../secret.json"),
                                 (404, b"ab sample detail unavailable"))
                # 只有合法的 round/eq 才进 builder。
                self.assertEqual(calls, [(ROUND, 1)])
                conn.close()
            finally:
                httpd.shutdown()
                httpd.server_close()
                server.STATIC, server._ab_builder = old_static, old_ab


if __name__ == "__main__":
    unittest.main()
