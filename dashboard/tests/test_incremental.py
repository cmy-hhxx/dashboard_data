"""Incremental build coverage: reuse, append-only updates and the lost dimension."""
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

try:
    from dashboard.tests.test_empty_data import DASHBOARD, REQ, seed, write_jsonl
except ImportError:  # `cd dashboard && python3 -m unittest discover -s tests`
    from test_empty_data import DASHBOARD, REQ, seed, write_jsonl


REQ2 = "2026-11-01 11:00:00"
LOST = {
    "meta": {
        "session_id": "lost1", "request_time": REQ, "lost_user": True,
        "task": "事件解读", "subtask": "产业与突发公共事件解读",
    },
    "traces": [{
        "meta": {
            "model": "AIME-Atlas-thinking", "task": "事件解读",
            "subtask": "产业与突发公共事件解读", "trace_id": "lt1",
            "input_tokens": 10, "output_tokens": 5, "tool_count": 2,
        },
        "messages": [{"role": "user", "type": "message", "content": [{"type": "input_text", "text": "事件"}]}],
    }],
}


def seed_lost(root):
    write_jsonl(
        root / "0_wencai/eval_input/1_task_eval_input/0_search_eval/AA-expert-search-test.jsonl",
        LOST,
    )


def append_jsonl(path, row):
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "a", encoding="utf-8") as fh:
        fh.write(json.dumps(row, ensure_ascii=False) + "\n")


def append_session(root):
    append_jsonl(
        root / "0_wencai/eval_input/a_fast/2026-11-01.jsonl",
        {
            "request_time": REQ2, "case_id": "c2", "trace_id": "t2", "version": "a",
            "meta": {"session_id": "s2", "request_time": REQ2, "question": "茅台明天走势",
                     "usage": {"input_tokens": 20, "output_tokens": 10}},
            "messages": [
                {"role": "user", "type": "message", "content": [{"type": "input_text", "text": "茅台明天走势"}]},
                {"role": "assistant", "type": "message", "content": [{"type": "output_text", "text": "预计震荡。"}]},
            ],
        },
    )
    out = root / "0_wencai/eval_output/0_daily_eval/a_fast"
    append_jsonl(out / "a_fast_attribution-2026-11-01.jsonl", {
        "session_meta": {"session_id": "s2", "request_time": REQ2, "question": "茅台明天走势",
                         "usage": {"input_tokens": 20, "output_tokens": 10}},
        "session_summary": "预测过于绝对", "session_problem": [],
        "turns": [{"meta": {}, "summary": "预测错误", "is_correct": False, "problem": [{
            "label": "预测结论错误", "severity": "P2", "component": "answer", "component_family": "预测",
            "component_role": "delivery", "reason": "与事实不符",
            "evidence": [{"position": "trace_index 0 / message_index 1 / path content[0].text",
                          "quote": "预计震荡", "reason": "预测错误"}],
        }]}],
    })
    append_jsonl(out / "compact/a_fast_compact-2026-11-01.jsonl", {
        "session_meta": {"session_id": "s2", "request_time": REQ2},
        "session_overview": ["预测走势"], "turns": [{"turn_idx": 0, "plans": [{"content": "预测", "evidence": []}]}],
    })


class IncrementalTests(unittest.TestCase):
    def run_build(self, datasets, static, *extra):
        proc = subprocess.run(
            [sys.executable, str(DASHBOARD / "build.py"), "--datasets", str(datasets),
             "--out", str(static), *extra],
            check=True, capture_output=True, text=True,
        )
        return json.loads(proc.stdout.strip().splitlines()[-1])

    def test_no_change_reuses_payloads_and_append_builds_only_new(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            datasets, static = root / "datasets", root / "static"
            seed(datasets)
            seed_lost(datasets)

            first = self.run_build(datasets, static)
            self.assertEqual((first["pairs"], first["sample_built"], first["sample_hits"]), (1, 1, 0))
            data = json.loads((static / "data-wencai.json").read_text())
            wencai = data["products"]["wencai"]
            self.assertEqual(wencai["input"]["lost"], 1)
            self.assertEqual(wencai["input"]["records"], 2)
            tasks = {t["task"]: t for t in wencai["input"]["models"]["a_expert"]["tasks"]}
            self.assertEqual(tasks["事件解读"]["lost"], 1)
            rows = json.loads((static / "samples-wencai.json").read_text())["products"]["wencai"]["rows"]
            old_slug = rows[0]["s"]
            from detail_builder import DetailBuilder
            builder = DetailBuilder(datasets, static.parent / "cache" / "build.sqlite3",
                                    static / "samples", static.parent / "cache")
            old_detail = Path(builder.ensure(old_slug))
            old_mtime = old_detail.stat().st_mtime_ns
            data_mtime = (static / "data.json").stat().st_mtime_ns

            # No new bytes: do not even touch the payloads.
            second = self.run_build(datasets, static)
            self.assertEqual(second.get("reused"), 1, second)
            self.assertEqual((static / "data.json").stat().st_mtime_ns, data_mtime)

            # A byte changed but no new session: rebuild aggregates, reuse the detail.
            with open(datasets / "0_wencai/eval_input/a_fast/2026-11-01.jsonl", "ab") as fh:
                fh.write(b"\n")
            third = self.run_build(datasets, static)
            self.assertEqual((third["sample_built"], third["sample_hits"]), (0, 1), third)
            self.assertEqual(old_detail.stat().st_mtime_ns, old_mtime)

            # New attribution row: exactly one new detail, the old one stays byte-identical.
            append_session(datasets)
            fourth = self.run_build(datasets, static)
            self.assertEqual((fourth["pairs"], fourth["sample_built"], fourth["sample_hits"]), (2, 1, 1), fourth)
            self.assertEqual(old_detail.stat().st_mtime_ns, old_mtime)
            rows = json.loads((static / "samples-wencai.json").read_text())["products"]["wencai"]["rows"]
            self.assertEqual(len(rows), 2)
            new_slug = next(r["s"] for r in rows if r["s"] != old_slug)
            self.assertIsNotNone(builder.ensure(new_slug))
            self.assertTrue((static / "samples" / f"{new_slug}.json").exists())
            builder.close()
            self.assertEqual(json.loads((static / "data-wencai.json").read_text())["products"]["wencai"]["kpi"]["sessions"], 2)


if __name__ == "__main__":
    unittest.main()
