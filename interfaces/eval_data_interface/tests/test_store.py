"""store 层用例：脏字段入库、eval_input 追加续扫（不起 HTTP 服务）。

    python3 tests/test_store.py
"""

import json
import os
import sqlite3
import sys
import tempfile
import unittest
from contextlib import closing
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO))
sys.path.insert(0, str(REPO / "tests"))

import fixtures  # noqa: E402
from analysis_api import config, snapshot, store  # noqa: E402


def _append(path: Path, row, newline=True):
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(row, ensure_ascii=False) + ("\n" if newline else ""))


class StoreTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="analysis-store-")
        base = Path(self.tmp.name)
        self.root = base / "datasets"
        self.aime = fixtures.build(self.root)
        # config 在 import 时读环境变量；用例直接改模块级路径
        self._state = config.STATE_DIR
        config.STATE_DIR = base / "state"
        self._datasets = os.environ.get("EVAL_DATASETS")
        os.environ["EVAL_DATASETS"] = str(self.root)
        self.input = self.aime / "eval_input" / "0_daily_eval_input" / "aime_expert" / f"{fixtures.DAY}.jsonl"

    def tearDown(self):
        config.STATE_DIR = self._state
        if self._datasets is None:
            os.environ.pop("EVAL_DATASETS", None)
        else:
            os.environ["EVAL_DATASETS"] = self._datasets
        self.tmp.cleanup()

    def _db(self):
        return closing(sqlite3.connect(str(config.db_path())))

    def test_survey_question_is_text(self):
        attr = self.aime / "eval_output" / "0_daily_eval" / "aime_expert" / f"aime_expert_attribution-{fixtures.DAY}.jsonl"
        survey = [
            {"header": "투자 대상 시장", "selected": ["아직 모르겠음"]},
            {"header": "보유 기간", "selected": ["1주 이내", "1개월"]},
        ]
        row = fixtures._session("thread_s", "trace_survey", "2026-10-20T06:00:00.000Z", "投教问答",
                                "金融术语与指标释义", 12345, "AIME-Atlas", [], question=survey)
        _append(attr, row)
        summary = store.build(self.root)
        self.assertTrue(summary["ok"])
        with self._db() as db:
            question, user = db.execute(
                "SELECT question, user_id FROM traces WHERE trace_id = 'trace_survey'").fetchone()
        self.assertEqual(question, "투자 대상 시장：아직 모르겠음；보유 기간：1주 이내、1개월")
        self.assertEqual(user, "12345")

    def test_question_text_fallback_and_preview_truncated(self):
        """上游改用 question_text：问句要能入库，query_preview 按 160 字截断。"""
        attr = self.aime / "eval_output" / "0_daily_eval" / "aime_expert" / f"aime_expert_attribution-{fixtures.DAY}.jsonl"
        question = "英伟达" * (config.QUERY_PREVIEW_CHARS // 3 + 10)
        row = fixtures._session("thread_q", "trace_textq", "2026-10-20T06:00:00.000Z", "投教问答",
                                "金融术语与指标释义", 12345, "AIME-Atlas", [], question=question)
        row["session_meta"].pop("question")
        row["session_meta"]["question_text"] = question
        _append(attr, row)
        store.build(self.root)
        with self._db() as db:
            stored = db.execute(
                "SELECT question FROM traces WHERE trace_id = 'trace_textq'").fetchone()[0]
        self.assertEqual(stored, question)

        snap = self._snapshot()
        item = snapshot._item(snap, snap.by_id["trace_textq"][0])
        self.assertEqual(item["query_preview"], question[: config.QUERY_PREVIEW_CHARS])
        self.assertEqual(len(item["query_preview"]), config.QUERY_PREVIEW_CHARS)

    def test_input_append_resumes(self):
        first = store.build(self.root)
        self.assertEqual(first["resumed_input"], 0)
        with self._db() as db:
            before = db.execute("SELECT trace_id, offset, line FROM input_index WHERE path = ?",
                                (str(self.input),)).fetchall()

        record = fixtures._input_record("thread_e", "trace_epsilon", "2026-10-20T06:00:00.000Z", "u4", "AIME-Atlas")
        _append(self.input, record, newline=False)  # 写到一半：末行还没有换行
        partial = store.build(self.root)
        self.assertEqual(partial["resumed_input"], 1)
        with self.input.open("a", encoding="utf-8") as handle:
            handle.write("\n")
        _append(self.input, fixtures._input_record("thread_f", "trace_zeta", "2026-10-20T07:00:00.000Z",
                                                   "u5", "AIME-Atlas"))
        resumed = store.build(self.root)
        self.assertEqual(resumed["resumed_input"], 1)

        with self._db() as db:
            rows = db.execute("SELECT trace_id, offset, line FROM input_index WHERE path = ?",
                              (str(self.input),)).fetchall()
        self.assertEqual(sorted(rows), sorted(before + [("trace_epsilon",) + self._locate("trace_epsilon"),
                                                        ("trace_zeta",) + self._locate("trace_zeta")]))

    def test_cluster_append_only_rescans_affected_files(self):
        first = store.build(self.root)
        self.assertGreater(first["attribution_files"], 0)
        index = self.aime / "eval_output" / "cluster" / "aime_expert" / "item_index.jsonl"
        # A new cluster for a file this index never mentioned: nothing already indexed moves.
        _append(index, {"file": "/remote/src/aime_expert_attribution-2026-10-21.jsonl", "line": 1, "turn_index": 0,
                        "problem_index": 0, "json_path": "turns[0].problem[0]", "path": "S1.M1.1", "label": "x"})
        self.assertEqual(store.build(self.root)["attribution_files"], 0)
        # A new cluster for the indexed daily file: that one file is re-read.
        _append(index, {"file": f"/remote/src/aime_expert_attribution-{fixtures.DAY}.jsonl", "line": 5, "turn_index": 0,
                        "problem_index": 0, "json_path": "turns[0].problem[0]", "path": "S9.M5.1", "label": "自由文本问题"})
        third = store.build(self.root)
        self.assertEqual(third["attribution_files"], 1)
        with self._db() as db:
            codes = db.execute("SELECT problem_codes FROM traces WHERE trace_id = 'trace_delta'").fetchone()[0]
        self.assertEqual(json.loads(codes), ["S9.M5.1"])

    def test_trace_keyed_item_index(self):
        """4.4+ item_index 没有 file/line，也必须能按 trace 关联出编码。"""
        index = self.aime / "eval_output" / "cluster" / "aime_expert" / "item_index.jsonl"
        src = f"daily/aime_expert_attribution-{fixtures.DAY}.jsonl"
        rows = [
            {"trace_id": "trace_gamma", "turn_index": 0, "problem_index": 0, "path": "S9.M5.1",
             "label": "旧数据当当前值", "src_rel": src, "date": fixtures.DAY},
            {"trace_id": "trace_gamma", "turn_index": 0, "problem_index": 1, "path": "S1.M1.1",
             "label": "空查询参数重试", "src_rel": src, "date": fixtures.DAY},
        ]
        index.write_text("".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows), encoding="utf-8")
        summary = store.build(self.root)
        self.assertEqual(summary["cluster_through"], fixtures.DAY)
        with self._db() as db:
            codes, problems = db.execute(
                "SELECT problem_codes, problems FROM traces WHERE trace_id = 'trace_gamma'").fetchone()
        self.assertEqual(json.loads(codes), ["S1.M1.1", "S9.M5.1"])
        self.assertEqual([p["code"] for p in json.loads(problems)], ["S9.M5.1", "S1.M1.1", None])

        # 追加一行新格式：只重扫这个归因文件，trace_alpha 的编码立即生效
        _append(index, {"trace_id": "trace_alpha", "turn_index": 0, "problem_index": 0,
                        "path": "S1.M1.1", "label": "空查询参数重试", "src_rel": src})
        summary = store.build(self.root)
        self.assertEqual(summary["attribution_files"], 1)
        with self._db() as db:
            codes = db.execute("SELECT problem_codes FROM traces WHERE trace_id = 'trace_alpha'").fetchone()[0]
        self.assertEqual(json.loads(codes), ["S1.M1.1"])

    def test_rewritten_input_rescans(self):
        store.build(self.root)
        lines = self.input.read_text(encoding="utf-8").splitlines(keepends=True)
        mtime = self.input.stat().st_mtime
        self.input.write_text("".join(reversed(lines)), encoding="utf-8")
        os.utime(self.input, (mtime + 5, mtime + 5))  # 签名按秒级 mtime，同一秒内的重写要错开
        summary = store.build(self.root)
        self.assertEqual(summary["resumed_input"], 0)
        with self._db() as db:
            rows = db.execute("SELECT trace_id, offset, line FROM input_index WHERE path = ?",
                              (str(self.input),)).fetchall()
        for trace_id, offset, line in rows:
            self.assertEqual((offset, line), self._locate(trace_id))

    def test_problem_columns_indexed(self):
        store.build(self.root)
        with self._db() as db:
            row = db.execute(
                "SELECT problem_codes, problem_count, problems, severity, is_correct "
                "FROM traces WHERE trace_id = 'trace_gamma'"
            ).fetchone()
        codes, count, problems, severity, is_correct = row
        self.assertEqual(json.loads(codes), ["S1.M1.1", "S9.M5.1"])
        self.assertEqual(count, 3)
        problems = json.loads(problems)
        self.assertEqual({p["severity"] for p in problems}, {"P0", "P1", "P3"})
        self.assertEqual([p["code"] for p in problems].count(None), 1)  # 未聚类问题保留
        self.assertEqual(json.loads(severity), {"P0": 1, "P1": 1, "P3": 1})
        self.assertEqual(is_correct, 0)

        with self._db() as db:
            session_row = db.execute(
                "SELECT problem_count, severity FROM traces WHERE trace_id = 'trace_lost'"
            ).fetchone()
            survey_row = db.execute(
                "SELECT problem_count, severity FROM traces WHERE trace_id = 'trace_beta'"
            ).fetchone()
        self.assertEqual(session_row[0], 2)  # turn 问题 + session_problem
        self.assertEqual(json.loads(session_row[1]), {"P2": 2})
        self.assertEqual(survey_row[0], 0)
        self.assertEqual(json.loads(survey_row[1]), {})

    def test_change_feed(self):
        """变更流：首次全量、内容未变不出变更、新增/重跑/删除各一条。"""
        os.environ["EVAL_DATASETS"] = str(self.root)
        attr = self.aime / "eval_output" / "0_daily_eval" / "aime_expert" / f"aime_expert_attribution-{fixtures.DAY}.jsonl"

        store.build(self.root)
        snap = self._snapshot()
        self.assertEqual(snap.latest_seq, 8)
        first = snapshot.changes(snap, config.db_path(), "aime_eval", None, page_size=100)
        ids = [item["trace_id"] for item in first["items"]]
        self.assertEqual(len(ids), 7)  # 8 条 trace 里测试账号的不供数
        self.assertNotIn("trace_test", ids)
        self.assertEqual(first["deleted"], [])
        self.assertFalse(first["has_more"])
        since = first["next_since"]
        self.assertTrue(since)
        for item in first["items"]:
            self.assertEqual(item["change"]["op"], "upsert")

        # 没有新内容：不产生变更
        summary = store.build(self.root)
        self.assertEqual(summary["changes_emitted"], 0)
        again = snapshot.changes(self._snapshot(), config.db_path(), "aime_eval", since)
        self.assertEqual((again["items"], again["deleted"]), ([], []))
        self.assertEqual(again["latest_seq"], snap.latest_seq)

        # 新增一条 trace：只发这一条
        _append(attr, fixtures._session(
            "thread_new", "trace_new", "2026-10-21T02:00:00.000Z", "投教问答",
            "金融术语与指标释义", "u7", "AIME-Atlas", [], question="新增问句",
        ))
        summary = store.build(self.root)
        self.assertEqual(summary["changes_emitted"], 1)
        snap = self._snapshot()
        delta = snapshot.changes(snap, config.db_path(), "aime_eval", since)
        self.assertEqual([item["trace_id"] for item in delta["items"]], ["trace_new"])
        self.assertEqual(delta["items"][0]["change"]["op"], "upsert")
        self.assertGreater(delta["items"][0]["change"]["seq"], first["head_seq"])
        since = delta["next_since"]

        # 重跑改内容：同一个 key 再来一条 upsert
        _append(attr, fixtures._session(
            "thread_a", "trace_alpha", "2026-10-20T12:00:00.000Z", "事件解读", "行情事件解读", "u1",
            "AIME-Atlas", [fixtures._problem("空查询参数重试", "P0")], question="英伟达今天为什么跌",
        ))
        self.assertEqual(store.build(self.root)["changes_emitted"], 1)
        delta = snapshot.changes(self._snapshot(), config.db_path(), "aime_eval", since)
        self.assertEqual([item["trace_id"] for item in delta["items"]], ["trace_alpha"])
        self.assertEqual([p["severity"] for p in delta["items"][0]["problems"]], ["P0"])
        since = delta["next_since"]

        # 归因文件消失：发 delete 墓碑
        lost = (self.aime / "eval_output" / "1_lost_user_eval" / "aime_fast"
                / f"aime_fast_attribution-{fixtures.LOST_DAY}.jsonl")
        lost.unlink()
        summary = store.build(self.root)
        self.assertEqual(summary["changes_emitted"], 1)
        delta = snapshot.changes(self._snapshot(), config.db_path(), "aime_eval", since)
        self.assertEqual(delta["items"], [])
        self.assertEqual([(row["trace_id"], row["op"]) for row in delta["deleted"]], [("trace_lost", "delete")])

    def test_change_feed_ignores_mtime(self):
        """整份重写但业务内容没变（只有 mtime 变）：不产生变更。"""
        store.build(self.root)
        attr = self.aime / "eval_output" / "0_daily_eval" / "aime_expert" / f"aime_expert_attribution-{fixtures.DAY}.jsonl"
        text = attr.read_text(encoding="utf-8")
        mtime = attr.stat().st_mtime
        attr.write_text(text, encoding="utf-8")
        os.utime(attr, (mtime + 5, mtime + 5))
        summary = store.build(self.root)
        self.assertEqual(summary["attribution_files"], 1)
        self.assertEqual(summary["changes_emitted"], 0)

    def test_change_feed_seeds_existing_index(self):
        """老索引升级：没有变更记录时，下一轮构建补齐全量位点。"""
        store.build(self.root)
        with self._db() as db:
            db.execute("DELETE FROM changes")
            db.execute("DELETE FROM meta WHERE key = 'changes_seeded'")
            db.commit()
        summary = store.build(self.root)
        self.assertEqual(summary["changes_emitted"], 0)
        self.assertEqual(summary["changes_seeded"], 8)
        data = snapshot.changes(self._snapshot(), config.db_path(), "aime_eval", None, page_size=100)
        self.assertEqual(len(data["items"]), 7)
        self.assertFalse(data["has_more"])

    def test_change_feed_paginates(self):
        os.environ["EVAL_DATASETS"] = str(self.root)
        store.build(self.root)
        snap = self._snapshot()
        seen, cursor, pages = [], None, 0
        while True:
            data = snapshot.changes(snap, config.db_path(), "aime_eval", None, page_size=3, cursor=cursor)
            seen.extend(item["trace_id"] for item in data["items"])
            seen.extend(row["trace_id"] for row in data["deleted"])
            pages += 1
            if not data["has_more"]:
                since = data["next_since"]
                break
            cursor = data["next_cursor"]
        self.assertEqual(len(seen), 7)
        self.assertEqual(len(set(seen)), 7)
        self.assertEqual(pages, 3)
        # 位点可重放：同一 since 再同步一次什么也没有
        replay = snapshot.changes(snap, config.db_path(), "aime_eval", since, page_size=3)
        self.assertEqual((replay["items"], replay["deleted"]), ([], []))

    def _snapshot(self):
        conn = store.connect(config.db_path())
        try:
            return snapshot.load(conn, None, {})
        finally:
            conn.close()

    def test_schema_upgrade_rescans_attribution(self):
        store.build(self.root)
        with self._db() as db:
            db.execute("UPDATE meta SET value = '1' WHERE key = 'schema_version'")
            db.commit()
        summary = store.build(self.root)
        self.assertTrue(summary["ok"])
        self.assertGreater(summary["attribution_files"], 0)
        with self._db() as db:
            version = db.execute("SELECT value FROM meta WHERE key = 'schema_version'").fetchone()[0]
            count = db.execute("SELECT COUNT(*) FROM traces").fetchone()[0]
        self.assertEqual(version, "3")
        self.assertEqual(count, 8)

    def _locate(self, trace_id):
        offset = 0
        with self.input.open("rb") as handle:
            for number, raw in enumerate(handle, 1):
                if f'"trace_id": "{trace_id}"'.encode() in raw:
                    return offset, number
                offset += len(raw)
        raise AssertionError(trace_id)


if __name__ == "__main__":
    unittest.main()
