"""AB 样本详情：ABDetailBuilder 的双侧对称自包含索引、item_index 回填、人话译文叠层与 server 路由。"""
import csv
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

ROUND = "version_20261106_aime_expert"

PAIRS_COLUMNS = [
    "eq_index", "case_key", "trace_id", "session_id", "question_time", "question",
    "task", "subtask", "before_status", "before_b_reason", "before_trace_id",
    "before_n_problem", "before_severity", "before_cls_paths", "before_cls_labels",
    "after_status", "after_trace_id", "after_session_id", "after_n_problem",
    "after_severity", "after_cls_paths", "after_cls_labels",
]


def attribution(eq, item, question, labels, session_labels=(), trace=None, case_id=None, human=False):
    prefix = "人话：" if human else ""
    return json.dumps({
        "session_meta": {
            "item_id": item,
            "case_id": case_id or f"expert_questions_eq_{eq:05d}",
            "trace_id": trace or f"tr{eq}",
            "session_id": f"thread_r{eq}",
            "question": question,
            "request_time": "2026-11-07 03:00:00",
        },
        "session_summary": f"{prefix}session_sum" if human else "",
        "session_problem": [
            {"label": f"{prefix}{label}", "severity": "P2", "definition": "d",
             "problem_phenomena": f"{prefix}ph", "reason": f"{prefix}r",
             "severity_reason": f"{prefix}sr", "component": "planner", "evidence": []}
            for label in session_labels
        ],
        "turns": [{
            "meta": {"trace_id": trace or f"tr{eq}", "name": "expert-analyst"},
            "summary": f"{prefix}ok",
            "is_correct": False,
            "correct_reason": "",
            "problem": [
                {"label": f"{prefix}{label}", "severity": "P1", "definition": "d",
                 "problem_phenomena": f"{prefix}ph", "reason": f"{prefix}r",
                 "severity_reason": f"{prefix}sr", "component": "planner", "evidence": []}
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


def slim(item, eq, question, pad=0, trace_id=None, case_id=None):
    meta = {"request_time": "2026-11-07 03:06:15"}
    if pad:
        meta["context"] = "x" * pad
    meta.update({
        "item_id": item,
        "case_id": case_id or f"expert_questions_eq_{eq:05d}",
        "question": question,
    })
    return json.dumps({
        "meta": meta,
        "traces": [{
            "meta": {"trace_id": trace_id or f"tr{eq}"},
            "messages": [{"type": "user_question", "content": question}],
        }],
    }, ensure_ascii=False)


def item_row(trace, retest_trace, json_path, path, label, edge=False, turn_index=None, problem_index=None):
    row = {
        "trace_id": trace,
        "retest_trace_id": retest_trace,
        "session_id": f"thread_r{retest_trace[2:]}" if retest_trace.startswith("tr") else "thread_b",
        "path": path,
        "edge": edge,
        "label": label,
        "request_time": "2026-11-07 03:08:16",
    }
    if json_path is not None:
        row["json_path"] = json_path
    if turn_index is not None:
        row["turn_index"] = turn_index
    if problem_index is not None:
        row["problem_index"] = problem_index
    return json.dumps(row, ensure_ascii=False)


def seed_round(datasets: Path):
    base = datasets / "1_aime" / "ab_test" / ROUND
    (base / "index_stats").mkdir(parents=True, exist_ok=True)
    (base / "index_stats" / "meta.json").write_text(
        json.dumps({"version": "20261106", "model": "aime_expert", "released_at": "2026-11-06"}),
        encoding="utf-8",
    )
    pair_rows = [
        ("1", "eq_00001", "T1", "真实问题一", "S1.M2.1;S2.M1.2"),
        ("2", "eq_00002", "T2", "真实问题二", "S3.M1.1"),
        ("3", "eq_00003", "T3", "真实问题三", "S3.M1.1"),
        ("4", "eq_00004", "T4", "真实问题四", "S4.M1.1"),
        ("5", "eq_00005", "T5", "真实问题五", "S5.M1.1;S5.M1.2"),
        ("6", "eq_00006", "T6", "真实问题六", "S6.M1.1;S6.S1.1"),
    ]
    with (base / "index_stats" / "pairs_index.csv").open("w", encoding="utf-8", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=PAIRS_COLUMNS)
        w.writeheader()
        for eq, ck, tid, q, paths in pair_rows:
            w.writerow({
                "eq_index": eq, "case_key": ck, "trace_id": tid, "session_id": f"thread_{eq}",
                "question_time": "2026-11-01T00:00:00Z", "question": q, "task": "", "subtask": "",
                "before_status": "evaluated", "before_b_reason": "", "before_trace_id": tid,
                "before_n_problem": "1", "before_severity": "P1", "before_cls_paths": "S1.M2.1",
                "before_cls_labels": "前置标签",
                "after_status": "evaluated", "after_trace_id": f"tr{eq}", "after_session_id": f"thread_r{eq}",
                "after_n_problem": "1", "after_severity": "P1", "after_cls_paths": paths, "after_cls_labels": "",
            })

    # Before side (self-contained: matched by trace_id + turn_index/problem_index)
    b_eval = base / "agent_before_opt" / "eval_output"
    b_clus = base / "agent_before_opt" / "cluster"
    b_eval.mkdir(parents=True, exist_ok=True)
    b_clus.mkdir(parents=True, exist_ok=True)
    (b_eval / "attribution.jsonl").write_text(
        attribution(1, "", "真实问题一", ["前置标签"], trace="T1", case_id="T1") + "\n",
        encoding="utf-8",
    )
    (base / "agent_before_opt" / "res_before_opt.jsonl").write_text(
        slim("", 1, "真实问题一", trace_id="T1", case_id="T1") + "\n",
        encoding="utf-8",
    )
    (b_clus / "item_index.jsonl").write_text(
        item_row("T1", "", None, "S1.M2.1", "前置标签", turn_index=0, problem_index=0) + "\n",
        encoding="utf-8",
    )

    # After side
    a_eval = base / "agent_after_opt" / "eval_output"
    a_clus = base / "agent_after_opt" / "cluster"
    a_eval.mkdir(parents=True, exist_ok=True)
    a_clus.mkdir(parents=True, exist_ok=True)
    (a_eval / "attribution.jsonl").write_text(
        "\n".join([
            attribution(1, "i1", "真实问题一", ["标签甲", "标签乙"]),
            attribution(2, "i2", "真实问题二", ["标签丙"]),
            attribution(3, "i3", "真实问题三", ["标签丙"]),
            attribution(4, "i4", "真实问题四", ["标签丁"]),
            attribution(5, "i5", "真实问题五", ["标签X", "标签X"]),
            attribution(6, "i6", "真实问题六", ["标签M", "标签N"], session_labels=["会话标签"]),
        ]) + "\n",
        encoding="utf-8",
    )
    rows = [
        item_row("T1", "tr1", "turns[0].problem[0]", "S1.M2.1", "标签甲"),
        item_row("T1", "tr1", "turns[0].problem[1]", "S2.M1.2", "标签乙", edge=True),
        item_row("T3", "tr3", "turns[0].problem[0]", "S3.M1.1", "标签丙"),
        # T4 uses turn_index + problem_index without json_path (1112 style)
        item_row("T4", "tr4", None, "S4.M1.1", "标签丁", turn_index=0, problem_index=0),
        item_row("T5", "tr5", "turns[0].problem[0]", "S5.M1.1", "标签X"),
        item_row("T5", "tr5", "turns[0].problem[1]", "S5.M1.2", "标签X"),
        item_row("T6", "tr6", "turns[0].problem[0]", "S6.M1.1", "标签M"),
        item_row("T6", "tr6", "session_problem[0]", "S6.S1.1", "会话标签"),
    ]
    (a_clus / "item_index.jsonl").write_text("\n".join(rows) + "\n", encoding="utf-8")
    (a_eval / "compact.jsonl").write_text(
        "\n".join([compact("i1", 1), compact("i2", 2), compact("i4", 4)]) + "\n",
        encoding="utf-8",
    )
    (base / "agent_after_opt" / "res_after_opt.jsonl").write_text(
        "\n".join([
            slim("i1", 1, "真实问题一", pad=12000),
            slim("i3", 3, "真实问题三"),
            slim("i4", 4, "真实问题四"),
            slim("i5", 5, "真实问题五"),
            slim("i6", 6, "真实问题六"),
        ]) + "\n",
        encoding="utf-8",
    )
    return base


class ABDetailTests(unittest.TestCase):
    def build(self, folder):
        root = Path(folder)
        datasets = root / "datasets"
        seed_round(datasets)
        builder = ab_detail.ABDetailBuilder(datasets, root / "cache", root / "static" / "ab_samples")
        return builder, root

    def test_builds_both_sides_symmetrically(self):
        with tempfile.TemporaryDirectory() as folder:
            builder, root = self.build(folder)
            # Before side: before-1.json
            b_path = builder.ensure(ROUND, "before-1")
            self.assertIsNotNone(b_path)
            self.assertEqual(b_path, root / "static" / "ab_samples" / ROUND / "before-1.json")
            b_detail = json.loads(b_path.read_text(encoding="utf-8"))
            self.assertEqual(b_detail["ab"]["side"], "before")
            self.assertEqual(b_detail["question"], "真实问题一")
            self.assertEqual(b_detail["attribution"]["problems"][0]["cl"]["path"], "S1.M2.1")

            # After side: after-1.json and bare 1.json
            a_path = builder.ensure(ROUND, "after-1")
            self.assertEqual(a_path, root / "static" / "ab_samples" / ROUND / "after-1.json")
            detail = json.loads(a_path.read_text(encoding="utf-8"))
            self.assertEqual(detail["question"], "真实问题一")
            self.assertEqual((detail["ab"]["eq"], detail["ab"]["trace"], detail["ab"]["side"]), (1, "T1", "after"))
            self.assertEqual(detail["model"], "expert")
            self.assertIsNotNone(detail["compact"])
            problems = detail["attribution"]["problems"]
            self.assertEqual([p["label"] for p in problems], ["标签甲", "标签乙"])
            self.assertEqual(problems[0]["cl"], {"path": "S1.M2.1", "edge": False, "tags": []})
            self.assertEqual(problems[1]["cl"], {"path": "S2.M1.2", "edge": True, "tags": []})
            gz = Path(str(a_path) + ".gz")
            self.assertTrue(gz.is_file())
            self.assertEqual(json.loads(gzip.decompress(gz.read_bytes())), detail)

            # Cached index hit
            index_path = root / "cache" / "ab-details" / f"{ROUND}-after.json"
            self.assertTrue(index_path.is_file())
            before_mtime = a_path.stat().st_mtime_ns
            self.assertEqual(builder.ensure(ROUND, "after-1"), a_path)
            self.assertEqual(a_path.stat().st_mtime_ns, before_mtime)

    def test_human_read_overlay_and_fallback(self):
        with tempfile.TemporaryDirectory() as folder:
            builder, root = self.build(folder)
            hr_path = (
                root / "datasets" / "1_aime" / "ab_test" / ROUND
                / "agent_after_opt" / "eval_output" / "attribution_human_read.jsonl"
            )
            hr_path.write_text(
                attribution(1, "i1", "真实问题一", ["标签甲", "标签乙"], human=True) + "\n",
                encoding="utf-8",
            )
            d1 = json.loads(builder.ensure(ROUND, "after-1").read_text(encoding="utf-8"))
            self.assertEqual(d1["attribution"]["turns"][0]["summary"], "人话：ok")
            self.assertEqual(d1["attribution"]["problems"][0]["label"], "人话：标签甲")
            self.assertEqual(d1["attribution"]["problems"][0]["why"], "人话：r")
            # eq3 has no human_read row -> silent fallback to original text
            d3 = json.loads(builder.ensure(ROUND, "after-3").read_text(encoding="utf-8"))
            self.assertEqual(d3["attribution"]["problems"][0]["label"], "标签丙")

    def test_turn_and_problem_index_backfill_and_missing_input(self):
        with tempfile.TemporaryDirectory() as folder:
            builder, _ = self.build(folder)
            d2 = json.loads(builder.ensure(ROUND, "after-2").read_text(encoding="utf-8"))
            self.assertTrue(d2["input"]["missing"])
            d4 = json.loads(builder.ensure(ROUND, "after-4").read_text(encoding="utf-8"))
            self.assertEqual(d4["attribution"]["problems"][0]["cl"],
                             {"path": "S4.M1.1", "edge": False, "tags": []})
            d5 = json.loads(builder.ensure(ROUND, "after-5").read_text(encoding="utf-8"))
            self.assertEqual([p["cl"]["path"] for p in d5["attribution"]["problems"]], ["S5.M1.1", "S5.M1.2"])
            self.assertEqual(d5["question"], "真实问题五")
            d6 = json.loads(builder.ensure(ROUND, "after-6").read_text(encoding="utf-8"))
            self.assertEqual(d6["attribution"]["problems"][0]["cl"]["path"], "S6.M1.1")
            self.assertIsNone(d6["attribution"]["problems"][1]["cl"])
            self.assertEqual(d6["attribution"]["problems"][2]["cl"]["path"], "S6.S1.1")

    def test_removed_eq_and_unknown_refs(self):
        with tempfile.TemporaryDirectory() as folder:
            builder, root = self.build(folder)
            stale = root / "static" / "ab_samples" / ROUND / "after-99.json"
            stale.parent.mkdir(parents=True, exist_ok=True)
            stale.write_text("{}", encoding="utf-8")
            self.assertIsNone(builder.ensure(ROUND, "after-99"))
            self.assertFalse(stale.exists())
            self.assertIsNone(builder.ensure("version_99999999_aime_expert", "after-1"))
            self.assertIsNone(builder.ensure(ROUND, 0))
            self.assertIsNone(builder.ensure("../" + ROUND, "after-1"))
            self.assertIsNone(builder.ensure(ROUND, "not-a-number"))

    def test_source_change_invalidates_index(self):
        with tempfile.TemporaryDirectory() as folder:
            builder, root = self.build(folder)
            path = builder.ensure(ROUND, "after-1")
            self.assertIsNotNone(path)
            index_path = root / "cache" / "ab-details" / f"{ROUND}-after.json"
            old_index = json.loads(index_path.read_text(encoding="utf-8"))
            time.sleep(0.02)
            item_index = (
                root / "datasets" / "1_aime" / "ab_test" / ROUND
                / "agent_after_opt" / "cluster" / "item_index.jsonl"
            )
            item_index.write_text(item_index.read_text(encoding="utf-8"), encoding="utf-8")
            self.assertIsNotNone(builder.ensure(ROUND, "after-1"))
            new_index = json.loads(index_path.read_text(encoding="utf-8"))
            self.assertNotEqual(new_index["sig"], old_index["sig"])


class ABRouteTests(unittest.TestCase):
    def test_route_serves_before_and_after_and_404s_malformed(self):
        import server
        with tempfile.TemporaryDirectory() as folder:
            static = Path(folder)
            static.mkdir(parents=True, exist_ok=True)
            old_static, old_ab = server.STATIC, server._ab_builder
            calls = []

            class FakeBuilder:
                def ensure(self, round_id, ref):
                    calls.append((round_id, ref))
                    path = static / "ab_samples" / round_id / f"{ref}.json"
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

                self.assertEqual(get(f"/ab_samples/{ROUND}/before-1.json")[0], 200)
                self.assertEqual(get(f"/ab_samples/{ROUND}/after-1.json")[0], 200)
                self.assertEqual(get(f"/ab_samples/{ROUND}/1.json")[0], 200)
                self.assertEqual(get(f"/ab_samples/{ROUND}/0.json"),
                                 (404, b"ab sample detail unavailable"))
                self.assertEqual(get("/ab_samples/bad!round/1.json"),
                                 (404, b"ab sample detail unavailable"))
                self.assertEqual(get("/ab_samples/../secret.json"),
                                 (404, b"ab sample detail unavailable"))
                self.assertEqual(calls, [(ROUND, "before-1"), (ROUND, "after-1"), (ROUND, 1)])
                conn.close()
            finally:
                httpd.shutdown()
                httpd.server_close()
                server.STATIC, server._ab_builder = old_static, old_ab


if __name__ == "__main__":
    unittest.main()
