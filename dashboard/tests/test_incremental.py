"""Incremental build coverage: reuse, append-only updates and the lost dimension."""
import json
import shutil
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
            self.assertEqual(wencai["input"]["sessions"], 2)
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
            rebuilt = json.loads((static / "data-wencai.json").read_text())["products"]["wencai"]
            self.assertEqual(rebuilt["input"]["sessions"], 3)

    def test_stable_unpaired_output_still_reuses_payloads(self):
        """An output whose input never arrives must not force a full rebuild every cycle.

        The reuse marker used to require zero pairing misses, so one permanently
        missing input rewrote the whole 20 MB index every ten minutes.  The marker
        now keys on the unmatched set itself: it may be non-empty, but must be stable.
        """
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            datasets, static = root / "datasets", root / "static"
            seed(datasets)
            first = self.run_build(datasets, static)
            self.assertNotIn("reused", first)
            # The attribution output survives, its input snapshot never lands.
            (datasets / "0_wencai/eval_input/a_fast/2026-11-01.jsonl").unlink()
            second = self.run_build(datasets, static)
            self.assertNotIn("reused", second)
            self.assertGreaterEqual(second.get("unmatched", 0), 1, second)
            third = self.run_build(datasets, static)
            self.assertEqual(third.get("reused"), 1, third)
            self.assertEqual(third.get("unmatched"), second.get("unmatched"), third)

    def test_changed_dataset_root_does_not_reuse_payloads(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            datasets, static = root / "datasets", root / "static"
            seed(datasets)
            seed_lost(datasets)
            self.assertNotIn("reused", self.run_build(datasets, static))

            moved = root / "datasets2"
            shutil.copytree(datasets, moved, copy_function=shutil.copy2)
            second = self.run_build(moved, static)
            self.assertNotIn("reused", second)
            data = json.loads((static / "data.json").read_text())
            self.assertEqual(data["source"]["root"], "datasets2")


class SampleCacheShapeTests(unittest.TestCase):
    """The slimmed cache must still feed the same compact-profile numbers."""

    COMPACT = {"turns": [
        {"plans": [1, 2], "reasoning": [1], "execution": [1, 2, 3], "reflections": [],
         "tool_errors": [1], "key_data": [], "artifacts": [],
         "components": [{"kind": "model", "name": "planner"},
                        {"kind": None, "name": "答案合成"}]},
        {"plans": [], "reasoning": [1, 2], "execution": [], "reflections": [1],
         "tool_errors": [], "key_data": [1], "artifacts": [1],
         "components": [{"kind": "tool", "name": None}]},
    ]}

    def test_compact_summary_matches_raw_counts(self):
        import build
        summary = build.compact_summary(json.loads(json.dumps(self.COMPACT)))
        raw = self.COMPACT["turns"]
        for key in build.COMPACT_STEPS:
            self.assertEqual(summary["counts"][key], sum(len(t[key]) for t in raw), key)
        kinds, names = {}, {}
        for turn in raw:
            for comp in turn["components"]:
                kinds[comp["kind"] or "—"] = kinds.get(comp["kind"] or "—", 0) + 1
                names[comp["name"] or "—"] = names.get(comp["name"] or "—", 0) + 1
        self.assertEqual(summary["kinds"], kinds)
        self.assertEqual(summary["names"], names)
        self.assertEqual(build.compact_summary(summary), summary)

    def test_slim_parts_drops_only_unread_fields(self):
        import build
        brief = {
            "product": "aime", "model": "aime_expert", "question": "long q", "question_zh": "中文",
            "lang": "en", "date": "2026-11-25", "split": "daily",
            "ids": {"trace": "t1", "session": "s1"},
            "meta": {"task": "行情分析", "subtask": "个股", "request_time": "2026-11-25 10:00:00",
                     "tokens_in": 100, "tokens_out": None, "app": "unused", "skill": "unused"},
            "compact": {"turns": []},
            "session_meta": {"app": "x"},
            "input": {"traces": [], "missing": False},
            "attribution": {
                "summary": "long session summary",
                "turns": [{"summary": "turn prose", "correct": False, "correct_reason": "why",
                           "problems": [0, 1], "trace_id": "t1", "agent": "a", "model": "m"}],
                "session_problems": [],
                "problems": [
                    {"id": 0, "turn": 0, "sev": "P1", "label": "短标签", "def": "prose",
                     "ph": "prose", "why": "prose", "sevr": "简短原因", "calc": ["1+1"],
                     "comp": "tool:search", "fam": "search", "role": "tool",
                     "ev": [0, 1], "cl": {"path": "S1.M1.1", "edge": True, "tags": ["时效"]}},
                    {"id": 1, "turn": 0, "sev": "P2", "label": "另一个标签", "def": "prose",
                     "sevr": "x" * 200, "comp": "llm", "fam": "llm", "role": "llm",
                     "ev": [], "cl": None},
                ],
            },
            # Includes unreferenced compact evidence (index 2, 3) that must be dropped.
            "evidence": [
                {"c": "tool:search", "m": 2, "o": True},
                {"c": "llm:plan", "m": 5},
                {"m": 1, "o": True},
                {},
            ],
        }
        facts = {"tokens": 7, "compact": json.loads(json.dumps(self.COMPACT))}
        self.assertTrue(build.slim_parts(brief, facts))
        self.assertFalse(build.slim_parts(brief, facts))  # idempotent
        self.assertEqual(set(brief), {"product", "model", "ids", "meta", "attribution", "ev_stats"})
        self.assertEqual(brief["ev_stats"], [4, 2])
        self.assertEqual(brief["meta"], {"task": "行情分析", "subtask": "个股",
                                         "request_time": "2026-11-25 10:00:00", "tokens_in": 100})
        self.assertNotIn("summary", brief["attribution"])
        self.assertEqual(brief["attribution"]["turns"], [{"problems": [0, 1], "trace_id": "t1"}])
        p0, p1 = brief["attribution"]["problems"]
        for dropped in ("def", "ph", "why", "calc", "ev"):
            self.assertNotIn(dropped, p0)
        self.assertEqual(p0["sevr"], "简短原因")
        self.assertEqual(p0["ev_s"], [2, 1, ["tool", "llm"]])
        self.assertEqual(p0["cl"], {"path": "S1.M1.1", "tags": ["时效"]})
        self.assertNotIn("sevr", p1)
        self.assertNotIn("ev_s", p1)
        self.assertEqual(facts["tokens"], 7)
        self.assertTrue(facts["compact"]["summary"])
        self.assertEqual(facts["compact"]["counts"]["components"], 3)

    def test_slimmed_brief_matches_raw_aggregate_and_system_facts(self):
        import build
        raw_detail = {
            "product": "aime", "model": "aime_expert", "question": "q",
            "ids": {"trace": "t1", "session": "s1", "case": None},
            "meta": {"task": "行情分析", "subtask": "个股", "tokens_in": 10, "tokens_out": 20},
            "attribution": {
                "summary": "s",
                "turns": [{"problems": [0], "trace_id": "t1"}],
                "session_problems": [],
                "problems": [{
                    "id": 0, "turn": 0, "sev": "P1", "label": "短标签",
                    "def": "d", "ph": "p", "why": "w", "sevr": "原因简短",
                    "comp": "tool:search", "fam": "search", "role": "tool",
                    "calc": [], "ev": [0, 1],
                    "cl": {"path": "S1.M1.1", "edge": False, "tags": ["时效"]},
                }],
            },
            "evidence": [
                {"c": "tool:search", "o": True},
                {"c": "llm:answer"},
                {"c": "compact:orphan", "o": True},
            ],
        }
        row = {"s": "abc1234567", "q": "q", "m": "aime_expert", "sp": "daily", "d": "2026-11-25",
               "sid": "s1", "tid": "t1", "w": "P1", "n": 1, "sv": [0, 1, 0, 0, 0],
               "r": ["tool"], "st": ["S1"], "pt": ["S1.M1.1"], "tg": ["时效"],
               "lb": "短标签", "tr": 1, "mc": 10, "tc": 2, "lang": "zh"}
        facts = {"messages": 10, "tool_calls": 2, "traces": 1, "kinds": {"llm": 5},
                 "tokens": 30, "finish_ms": 1000, "question_len": 1, "mode": "expert",
                 "comefrom": "app", "source": "web", "has_visual": False,
                 "compact": build.compact_summary(json.loads(json.dumps(self.COMPACT))),
                 "correct": False}
        taxonomy = {"stages": {}, "mechanisms": {}, "l2": {}, "patterns": {}, "tags": {}, "meta": {}}
        slimmed = json.loads(json.dumps(raw_detail))
        build.slim_parts(slimmed, facts)

        agg_raw = build.aggregate("aime", [("abc1234567", raw_detail, row, facts)], taxonomy)
        agg_slim = build.aggregate("aime", [("abc1234567", slimmed, row, facts)], taxonomy)
        self.assertEqual(agg_raw["kpi"], agg_slim["kpi"])
        self.assertEqual(agg_raw["patterns"], agg_slim["patterns"])

        sys_raw = build.system_facts([("abc1234567", raw_detail, row, facts)], {})
        sys_slim = build.system_facts([("abc1234567", slimmed, row, facts)], {})
        self.assertEqual(sys_raw, sys_slim)

    def test_load_sample_pickle_slims_legacy_chunks_on_read(self):
        import build
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "samples.pkl"
            legacy_rows = {
                "slug1": {
                    "slug": "slug1",
                    "brief": {"product": "aime", "question": "big", "evidence": [{}, {"o": True}],
                              "attribution": {"summary": "drop", "problems": []}},
                    "facts": {"tokens": 1},
                }
            }
            build.write_sample_pickle(path, legacy_rows)
            loaded, slimmed = build._load_sample_pickle(path, slim=True)
            self.assertTrue(slimmed)
            self.assertNotIn("evidence", loaded["slug1"]["brief"])
            self.assertNotIn("question", loaded["slug1"]["brief"])
            self.assertEqual(loaded["slug1"]["brief"]["ev_stats"], [2, 1])


if __name__ == "__main__":
    unittest.main()
