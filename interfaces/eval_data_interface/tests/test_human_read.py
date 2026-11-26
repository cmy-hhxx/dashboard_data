"""人话版本（text_mode=raw|human）完整单测与 HTTP 端到端测试。

    python3 tests/test_human_read.py
"""

import copy
import json
import os
import sqlite3
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.parse
import urllib.request
from contextlib import closing
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO))
sys.path.insert(0, str(REPO / "tests"))

import fixtures  # noqa: E402
from analysis_api import config, cursors, errors, human_read, server, snapshot, store  # noqa: E402


def _write_human_read_record(
    product_dir: Path,
    orig_file: Path,
    orig_record: dict,
    translated_record: dict,
    updated_at: str = "2026-10-21T01:00:00Z",
    updated_at_ns: int | None = None,
):
    """按 human_read_module 的精确落盘协议写入一条人话镜像记录与 SQLite 偏移索引。"""
    hr_root = product_dir / "eval_output" / "human_read"
    state_dir = hr_root / ".state"
    state_dir.mkdir(parents=True, exist_ok=True)
    db_path = state_dir / "state.sqlite3"
    rel_path = human_read.rel_path_for(orig_file)
    assert rel_path is not None

    mirror = hr_root / rel_path
    mirror.parent.mkdir(parents=True, exist_ok=True)
    line_bytes = (json.dumps(translated_record, ensure_ascii=False) + "\n").encode("utf-8")
    with mirror.open("ab") as handle:
        offset = handle.tell()
        handle.write(line_bytes)

    rkey = human_read.record_key(orig_record)
    shash = human_read.attr_fingerprint(orig_record)
    now_ns = updated_at_ns if updated_at_ns is not None else time.time_ns()
    with closing(sqlite3.connect(str(db_path))) as conn:
        conn.execute("PRAGMA journal_mode=WAL;")
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS records (
                rel_path      TEXT NOT NULL,
                record_key    TEXT NOT NULL,
                kind          TEXT NOT NULL,
                source_hash   TEXT NOT NULL,
                prompt_ver    TEXT NOT NULL,
                model         TEXT NOT NULL,
                out_offset    INTEGER NOT NULL,
                out_bytes     INTEGER NOT NULL,
                status        TEXT NOT NULL,
                error         TEXT,
                updated_at    TEXT NOT NULL,
                updated_at_ns INTEGER NOT NULL,
                PRIMARY KEY (rel_path, record_key)
            );
            """
        )
        conn.execute(
            """
            INSERT OR REPLACE INTO records(
                rel_path, record_key, kind, source_hash, prompt_ver, model,
                out_offset, out_bytes, status, error, updated_at, updated_at_ns
            ) VALUES (?, ?, 'attribution', ?, 'v1.3', 'test-model', ?, ?, 'ok', NULL, ?, ?)
            """,
            (rel_path, rkey, shash, offset, len(line_bytes), updated_at, now_ns),
        )
        conn.commit()


def _translate_copy(orig: dict, prefix: str = "[人话] ") -> dict:
    """深拷贝一条归因记录并替换白名单展示文本字段，保持冻结字段不变。"""
    out = copy.deepcopy(orig)
    out["session_summary"] = f"{prefix}整场对话总结"
    for turn in out.get("turns") or []:
        if turn.get("summary"):
            turn["summary"] = f"{prefix}{turn['summary']}"
        for p in turn.get("problem") or []:
            for field in human_read.ATTR_PROBLEM_FIELDS:
                if p.get(field):
                    p[field] = f"{prefix}{p[field]}"
    for p in out.get("session_problem") or []:
        for field in human_read.ATTR_PROBLEM_FIELDS:
            if p.get(field):
                p[field] = f"{prefix}{p[field]}"
    return out


class _HttpClient:
    def __init__(self, base: str):
        self.base = base.rstrip("/")
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def _call(self, method: str, path: str, params=None, body=None):
        url = self.base + path
        if params:
            clean = {k: v for k, v in params.items() if v is not None}
            if clean:
                url += "?" + urllib.parse.urlencode(clean, doseq=True)
        data = None
        headers = {"Accept": "application/json"}
        if body is not None:
            data = json.dumps(body, ensure_ascii=False).encode("utf-8")
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with self.opener.open(req, timeout=15) as resp:
                return resp.status, json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            try:
                return exc.code, json.loads(exc.read().decode("utf-8", "replace"))
            finally:
                exc.close()

    def get(self, path: str, **params):
        return self._call("GET", path, params)

    def post(self, path: str, body: dict, **params):
        return self._call("POST", path, params, body)


class HumanReadTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="analysis-hr-")
        self.base = Path(self.tmp.name)
        self.root = self.base / "datasets"
        self.aime = fixtures.build(self.root)
        self.daily_file = (
            self.aime / "eval_output" / "0_daily_eval" / "aime_expert"
            / f"aime_expert_attribution-{fixtures.DAY}.jsonl"
        )
        self._state = config.STATE_DIR
        config.STATE_DIR = self.base / "state"
        self._datasets = os.environ.get("EVAL_DATASETS")
        os.environ["EVAL_DATASETS"] = str(self.root)
        self.daily_rows = [
            json.loads(line)
            for line in self.daily_file.read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]

    def tearDown(self):
        human_read.reader_for(self.aime).close()
        config.STATE_DIR = self._state
        if self._datasets is None:
            os.environ.pop("EVAL_DATASETS", None)
        else:
            os.environ["EVAL_DATASETS"] = self._datasets
        self.tmp.cleanup()

    def _row_by_trace(self, trace_id: str) -> dict:
        matched = None
        for rec in self.daily_rows:
            for t in rec.get("turns") or []:
                if (t.get("meta") or {}).get("trace_id") == trace_id:
                    matched = rec
        assert matched is not None
        return matched

    def _snapshot(self):
        intent_tree = server.load_intent(config.INTENT_TAXONOMY_FILE)
        problem_trees = {}
        for model_dir, (tree_path, _) in store.cluster_files(self.aime).items():
            problem_trees[config.LAYOUT.tree_key(model_dir)] = server.load_cluster(tree_path, model_dir)
        conn = store.connect(config.db_path())
        try:
            snap = snapshot.load(conn, intent_tree, problem_trees)
        finally:
            conn.close()
        server.APP._fix_app_versions(snap)
        return snap

    def test_fallback_when_no_human_read_exists(self):
        """无 human_read 目录时，text_mode=human 优雅降级为 fallback_raw，原文保持不变。"""
        store.build(self.root)
        snap = self._snapshot()
        self.assertEqual(snap.human_read_traces, 0)

        listed = snapshot.traces(snap, snapshot.Filters(dataset="aime_eval"), text_mode="human")
        self.assertTrue(listed["items"])
        for item in listed["items"]:
            self.assertEqual(item["text_mode"], "fallback_raw")

        det = snapshot.detail(snap, config.db_path(), "aime_eval", "trace_gamma", fixtures.DAY, text_mode="human")
        self.assertEqual(det["text_mode"], "fallback_raw")
        self.assertEqual(det["analysis"]["summary"], "轮次摘要")
        self.assertEqual(det["analysis"]["session_summary"], "会话摘要")
        self.assertEqual(det["analysis"]["problems"][0]["severity_reason"], "依据")

    def test_dual_track_changes_and_since_mode_binding(self):
        """异步人话补译只发 human_only 事件：raw 零噪音、latest_seq 不动，human 收到补译升级。"""
        # 1. 初始仅有原文
        store.build(self.root)
        snap0 = self._snapshot()
        raw_seq0 = snap0.latest_seq_raw
        self.assertEqual(snap0.latest_seq, raw_seq0)

        raw_sync0 = snapshot.changes(snap0, config.db_path(), "aime_eval", None, text_mode="raw")
        hr_sync0 = snapshot.changes(snap0, config.db_path(), "aime_eval", None, text_mode="human")
        self.assertEqual({x["text_mode"] for x in raw_sync0["items"]}, {"raw"})
        self.assertEqual({x["text_mode"] for x in hr_sync0["items"]}, {"fallback_raw"})
        raw_since = raw_sync0["next_since"]
        hr_since = hr_sync0["next_since"]

        # 2. 跨模式传 since 必须 409 SYNC_RESET，防止本地库混脏
        with self.assertRaises(errors.ApiError) as err_r2h:
            snapshot.changes(snap0, config.db_path(), "aime_eval", raw_since, text_mode="human")
        self.assertEqual(err_r2h.exception.status, 409)
        self.assertEqual(err_r2h.exception.code, "SYNC_RESET")

        with self.assertRaises(errors.ApiError) as err_h2r:
            snapshot.changes(snap0, config.db_path(), "aime_eval", hr_since, text_mode="raw")
        self.assertEqual(err_h2r.exception.status, 409)
        self.assertEqual(err_h2r.exception.code, "SYNC_RESET")

        # 3. 外部服务异步译完 trace_gamma（3 个问题）和 trace_beta（0 问题，仅摘要翻译）
        rec_gamma = self._row_by_trace("trace_gamma")
        rec_beta = self._row_by_trace("trace_beta")
        _write_human_read_record(self.aime, self.daily_file, rec_gamma, _translate_copy(rec_gamma), updated_at_ns=1001)
        _write_human_read_record(self.aime, self.daily_file, rec_beta, _translate_copy(rec_beta), updated_at_ns=1002)

        build1 = store.build(self.root)
        self.assertEqual(build1["human_changes_emitted"], 2)
        self.assertEqual(build1["changes_emitted"], 2)
        self.assertEqual(build1["human_read_traces"], 2)
        snap1 = self._snapshot()

        # raw 视角：latest_seq_raw 完全静止，增量拉取为空
        self.assertEqual(snap1.latest_seq_raw, raw_seq0)
        self.assertGreater(snap1.latest_seq, raw_seq0)
        raw_sync1 = snapshot.changes(snap1, config.db_path(), "aime_eval", raw_since, text_mode="raw")
        self.assertEqual((raw_sync1["items"], raw_sync1["deleted"]), ([], []))
        self.assertEqual(raw_sync1["latest_seq"], raw_seq0)

        # human 视角：收到 2 条补译 upsert，包含 0 问题的 trace_beta
        hr_sync1 = snapshot.changes(snap1, config.db_path(), "aime_eval", hr_since, text_mode="human")
        by_id = {item["trace_id"]: item for item in hr_sync1["items"]}
        self.assertEqual(set(by_id), {"trace_gamma", "trace_beta"})
        self.assertEqual(by_id["trace_gamma"]["text_mode"], "human")
        self.assertEqual(
            [p["label"] for p in by_id["trace_gamma"]["problems"]],
            ["[人话] 旧数据当当前值", "[人话] 空查询参数重试", "[人话] 结论方向相反"],
        )
        # 冻结字段不变
        self.assertEqual([p["severity"] for p in by_id["trace_gamma"]["problems"]], ["P1", "P3", "P0"])
        self.assertEqual(by_id["trace_beta"]["text_mode"], "human")
        hr_since = hr_sync1["next_since"]

        # 4. 译文重译更新（prompt 升级）：仅 human 再次收到 upsert，raw 仍零噪音
        _write_human_read_record(
            self.aime, self.daily_file, rec_gamma, _translate_copy(rec_gamma, prefix="[人话v2] "), updated_at_ns=2001
        )
        build2 = store.build(self.root)
        self.assertEqual(build2["human_changes_emitted"], 1)
        snap2 = self._snapshot()
        self.assertEqual(snap2.latest_seq_raw, raw_seq0)
        hr_sync2 = snapshot.changes(snap2, config.db_path(), "aime_eval", hr_since, text_mode="human")
        self.assertEqual([x["trace_id"] for x in hr_sync2["items"]], ["trace_gamma"])
        self.assertEqual(hr_sync2["items"][0]["problems"][0]["label"], "[人话v2] 旧数据当当前值")
        hr_since = hr_sync2["next_since"]

        # 5. 无变化再构建：双方均无变更
        build3 = store.build(self.root)
        self.assertEqual(build3["attribution_files"], 0)
        self.assertEqual(build3["changes_emitted"], 0)

        # 6. 原文重分析修改 trace_gamma（旧译文 source_hash 不再匹配）：双方都收到 base upsert，且 human 自动回退
        updated_gamma = copy.deepcopy(rec_gamma)
        updated_gamma["turns"][0]["problem"][0]["label"] = "全新归因问题"
        with self.daily_file.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(updated_gamma, ensure_ascii=False) + "\n")
        build4 = store.build(self.root)
        self.assertEqual(build4["human_changes_emitted"], 0)
        snap4 = self._snapshot()
        self.assertGreater(snap4.latest_seq_raw, raw_seq0)

        raw_sync4 = snapshot.changes(snap4, config.db_path(), "aime_eval", raw_since, text_mode="raw")
        hr_sync4 = snapshot.changes(snap4, config.db_path(), "aime_eval", hr_since, text_mode="human")
        self.assertEqual([x["trace_id"] for x in raw_sync4["items"]], ["trace_gamma"])
        self.assertEqual([x["trace_id"] for x in hr_sync4["items"]], ["trace_gamma"])
        self.assertEqual(hr_sync4["items"][0]["text_mode"], "fallback_raw")
        self.assertEqual(hr_sync4["items"][0]["problems"][0]["label"], "全新归因问题")

    def test_live_detail_and_multiturn_session_problem(self):
        """/traces/{id} 实时 O(1) 读取刚落盘的人话译文（无需等下次 build），且跨轮问题对齐。"""
        store.build(self.root)
        snap = self._snapshot()

        # 尚未建索引前直接落盘多轮会话（含 session_problem）的人话译文
        rec_multi = self._row_by_trace("trace_multi_1")
        _write_human_read_record(self.aime, self.daily_file, rec_multi, _translate_copy(rec_multi), updated_at_ns=3001)

        # 列表仍是旧快照（fallback_raw），但详情实时读镜像立刻命中 human
        det1 = snapshot.detail(snap, config.db_path(), "aime_eval", "trace_multi_1", fixtures.DAY, text_mode="human")
        self.assertEqual(det1["text_mode"], "human")
        self.assertEqual(det1["problems"][0]["label"], "[人话] 空查询参数重试")
        self.assertEqual(det1["analysis"]["problems"][0]["label"], "[人话] 空查询参数重试")
        self.assertEqual(det1["analysis"]["problems"][0]["phenomena"], "[人话] 现象")
        self.assertEqual(det1["analysis"]["problems"][0]["reason"], "[人话] 原因")
        self.assertEqual(det1["analysis"]["problems"][0]["severity_reason"], "[人话] 依据")
        # 冻结字段原样保留
        self.assertEqual(det1["analysis"]["problems"][0]["definition"], "空查询参数重试 的定义")
        self.assertEqual(det1["analysis"]["problems"][0]["severity"], "P2")
        self.assertEqual(det1["analysis"]["summary"], "[人话] 轮次摘要")
        self.assertEqual(det1["analysis"]["session_summary"], "[人话] 整场对话总结")

        # 最后一轮带 session_problem
        det2 = snapshot.detail(snap, config.db_path(), "aime_eval", "trace_multi_2", fixtures.DAY, text_mode="human")
        self.assertEqual(det2["text_mode"], "human")
        self.assertEqual(det2["problems"][0]["label"], "[人话] 跨轮遗漏标的")
        self.assertEqual(det2["analysis"]["problems"][0]["label"], "[人话] 跨轮遗漏标的")
        self.assertTrue(det2["analysis"]["problems"][0]["session_level"])

        # raw 模式不受影响，且同样返回新增的 severity_reason / session_summary
        det_raw = snapshot.detail(snap, config.db_path(), "aime_eval", "trace_multi_2", fixtures.DAY, text_mode="raw")
        self.assertEqual(det_raw["text_mode"], "raw")
        self.assertEqual(det_raw["analysis"]["problems"][0]["label"], "跨轮遗漏标的")
        self.assertEqual(det_raw["analysis"]["problems"][0]["severity_reason"], "依据")
        self.assertEqual(det_raw["analysis"]["session_summary"], "会话摘要")

    def test_in_place_migration_preserves_seq_and_backfills_human_read(self):
        """模拟老库（无 hr_labels / hr_hash / human_only 列）就地升级，不删表不破坏旧 seq。"""
        store.build(self.root)
        with closing(sqlite3.connect(str(config.db_path()))) as conn:
            # 构造老表结构（去掉新增列）
            conn.executescript(
                """
                ALTER TABLE traces RENAME TO traces_new;
                CREATE TABLE traces AS SELECT
                    trace_id, day, app_version, asked_at, source, user_id, question, session_id,
                    intent_code, task, subtask, problem_codes, problem_count, problems, severity,
                    is_correct, analysis_id, analyzed_at, file, line, offset
                FROM traces_new;
                DROP TABLE traces_new;

                ALTER TABLE changes RENAME TO changes_new;
                CREATE TABLE changes(
                    seq INTEGER PRIMARY KEY AUTOINCREMENT,
                    trace_id TEXT NOT NULL, day TEXT NOT NULL, app_version TEXT NOT NULL,
                    op TEXT NOT NULL, changed_at TEXT NOT NULL
                );
                INSERT INTO changes(seq, trace_id, day, app_version, op, changed_at)
                SELECT seq, trace_id, day, app_version, op, changed_at FROM changes_new;
                DROP TABLE changes_new;
                """
            )
            conn.commit()
            old_max_seq = conn.execute("SELECT MAX(seq) FROM changes").fetchone()[0]

        rec_alpha = self._row_by_trace("trace_alpha")
        _write_human_read_record(self.aime, self.daily_file, rec_alpha, _translate_copy(rec_alpha), updated_at_ns=4001)

        summary = store.build(self.root)
        self.assertTrue(summary["ok"])
        self.assertEqual(summary["latest_seq_raw"], old_max_seq)
        self.assertEqual(summary["human_changes_emitted"], 1)
        self.assertEqual(summary["human_read_traces"], 1)

        # 老位点（无 m 字段）视为 raw，继续拉取 raw 零报错且无多余变更
        legacy_since = cursors._pack({"k": "since", "f": "aime_eval", "s": old_max_seq})
        snap = self._snapshot()
        raw_delta = snapshot.changes(snap, config.db_path(), "aime_eval", legacy_since, text_mode="raw")
        self.assertEqual((raw_delta["items"], raw_delta["deleted"]), ([], []))
        # 老位点错传给 human 返回 409 SYNC_RESET
        with self.assertRaises(errors.ApiError) as err:
            snapshot.changes(snap, config.db_path(), "aime_eval", legacy_since, text_mode="human")
        self.assertEqual(err.exception.status, 409)
        self.assertEqual(err.exception.code, "SYNC_RESET")

    def test_http_endpoints_end_to_end(self):
        """通过真实 HTTP Server 验收 4 个端点 + /healthz + 422 校验 + cursor 隔离。"""
        rec_gamma = self._row_by_trace("trace_gamma")
        _write_human_read_record(self.aime, self.daily_file, rec_gamma, _translate_copy(rec_gamma), updated_at_ns=5001)

        app = server.App()
        app.db_path = config.db_path()
        app.rebuild(log=lambda _m: None)
        old_app = server.APP
        server.APP = app
        httpd = server.Server(("127.0.0.1", 0), server.Handler)
        port = httpd.server_address[1]
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        try:
            client = _HttpClient(f"http://127.0.0.1:{port}")
            api = config.API_PREFIX

            # 1. /healthz
            code, health = client.get("/healthz")
            self.assertEqual(code, 200)
            self.assertEqual(health["human_read"]["available"], True)
            self.assertEqual(health["human_read"]["traces"], 1)
            self.assertEqual(health["human_read"]["records"], 1)
            self.assertIn("latest_seq_raw", health)

            # 2. 非法 text_mode -> 422
            for path, kwargs in (
                (f"{api}/traces", {"dataset": "aime_eval", "text_mode": "invalid"}),
                (f"{api}/changes", {"dataset": "aime_eval", "text_mode": "both"}),
                (f"{api}/traces/trace_gamma", {"dataset": "aime_eval", "day": fixtures.DAY, "text_mode": "bad"}),
            ):
                code, err = client.get(path, **kwargs)
                self.assertEqual(code, 422)
                self.assertEqual(err["error"]["code"], "UNKNOWN_CODE")
            code, err = client.post(
                f"{api}/traces/batch",
                {"dataset": "aime_eval", "trace_ids": ["trace_gamma"], "text_mode": "nope"},
            )
            self.assertEqual(code, 422)

            # 3. GET /traces + cursor 模式隔离
            code, p_human = client.get(f"{api}/traces", dataset="aime_eval", text_mode="human", page_size=2)
            self.assertEqual(code, 200)
            self.assertEqual(p_human["meta"]["filters"]["text_mode"], "human")
            # 把 human 的翻页 cursor 传给 raw 必须被拒绝
            code, bad_cur = client.get(
                f"{api}/traces", dataset="aime_eval", text_mode="raw", page_size=2, cursor=p_human["data"]["next_cursor"]
            )
            self.assertEqual(code, 400)
            self.assertEqual(bad_cur["error"]["code"], "INVALID_ARGUMENT")

            # 4. POST /traces/batch
            code, batch_res = client.post(
                f"{api}/traces/batch",
                {"dataset": "aime_eval", "trace_ids": ["trace_gamma", "trace_delta", "trace_missing"], "text_mode": "human"},
            )
            self.assertEqual(code, 200)
            self.assertEqual(batch_res["meta"]["filters"]["text_mode"], "human")
            items = batch_res["data"]["items"]
            self.assertEqual(items[0]["text_mode"], "human")
            self.assertEqual(items[0]["problems"][0]["label"], "[人话] 旧数据当当前值")
            self.assertEqual(items[1]["text_mode"], "fallback_raw")
            self.assertEqual(items[1]["problems"][0]["label"], "自由文本问题")
            self.assertIsNone(items[2]["text_mode"])

            # 5. GET /traces/{id}
            code, det = client.get(
                f"{api}/traces/trace_gamma", dataset="aime_eval", day=fixtures.DAY, text_mode="human"
            )
            self.assertEqual(code, 200)
            self.assertEqual(det["meta"]["filters"]["text_mode"], "human")
            self.assertEqual(det["data"]["text_mode"], "human")
            self.assertEqual(det["data"]["analysis"]["summary"], "[人话] 轮次摘要")
            self.assertEqual(det["data"]["analysis"]["session_summary"], "[人话] 整场对话总结")
            self.assertEqual(det["data"]["analysis"]["problems"][0]["severity_reason"], "[人话] 依据")

            # 6. GET /changes
            code, ch = client.get(f"{api}/changes", dataset="aime_eval", text_mode="human", page_size=100)
            self.assertEqual(code, 200)
            self.assertEqual(ch["meta"]["filters"]["text_mode"], "human")
            by_id = {x["trace_id"]: x for x in ch["data"]["items"]}
            self.assertEqual(by_id["trace_gamma"]["text_mode"], "human")
            self.assertEqual(by_id["trace_delta"]["text_mode"], "fallback_raw")
        finally:
            httpd.shutdown()
            httpd.server_close()
            server.APP = old_app


if __name__ == "__main__":
    unittest.main()
