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
from analysis_api import config, store  # noqa: E402


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
        self.input = self.aime / "eval_input" / "0_daily_eval_input" / "aime_expert" / f"{fixtures.DAY}.jsonl"

    def tearDown(self):
        config.STATE_DIR = self._state
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
