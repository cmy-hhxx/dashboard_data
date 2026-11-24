"""Unit and end-to-end tests for TaskManager API integration (`collector_mode=task_manager`)."""

from __future__ import annotations

import gzip
import json
import sys
import tempfile
import threading
import time
import unittest
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from internal_eval.api import InternalEvalApp
from internal_eval.collectors import TaskManagerCollectorAdapter, create_collector_adapter
from internal_eval.config import ServiceConfig, load_config
from internal_eval.engines import VendoredEngineBackend, ensure_vendor_on_path, extract_case_key
from internal_eval.pipeline import PipelineManager
from internal_eval.state_store import StateStore
from internal_eval.task_manager import (
    TaskManagerClient,
    build_pipeline_and_step_map,
    build_testset_cases,
    judge_record_to_eval_trace,
    normalize_task_manager_base_url,
)
from tests.test_pipeline_e2e import FakeStreamingEngine, _http_json, _wait_until
from tests.test_unit import _write_fake_bench


class _MockTaskManagerServer:
    """In-process fake TaskManager implementing the documented `/api/v1/task/*` contract."""

    def __init__(self, *, allowed_user: str = "tester", gzip_paginated: bool = False):
        self.allowed_user = allowed_user
        self.gzip_paginated = gzip_paginated
        self.lock = threading.Lock()
        self.testsets: dict[str, dict[str, Any]] = {}
        self.tasks: dict[str, dict[str, Any]] = {}
        self.items: dict[str, list[dict[str, Any]]] = {}
        self.calls: list[tuple[str, str]] = []
        self.template_task_id = "tpl_task_001"
        self.tasks[self.template_task_id] = {
            "task_id": self.template_task_id,
            "task_name": "template-ab",
            "status": "completed",
            "pipeline": {
                "is_cn": False,
                "is_deep": False,
                "with_pic": False,
                "add_history": False,
                "parallel": True,
                "steps": [
                    {
                        "key": "AA-expert",
                        "fetcher": "new",
                        "is_pre": False,
                        "is_deep": True,
                        "mode": "expert",
                        "runtime": "agent-runtime",
                        "user_id": "",
                        "history": False,
                        "agent_id": None,
                    }
                ],
            },
        }
        # Programmable test hooks
        self.behavior: str = "recovery_demo"  # "recovery_demo" | "hang_running"
        self._server: ThreadingHTTPServer | None = None
        self._thread: threading.Thread | None = None

    def start(self) -> str:
        parent = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, fmt: str, *args: Any) -> None:
                pass

            def _send_json(self, status: int, payload: dict[str, Any]) -> None:
                body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
                self.send_response(status)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def _check_auth(self) -> bool:
                uid = (self.headers.get("X-User-Id") or "").strip()
                if uid != parent.allowed_user:
                    self._send_json(403, {"status_code": 1, "status_msg": "无权限操作", "error_code": "FORBIDDEN"})
                    return False
                return True

            def _read_body(self) -> dict[str, Any]:
                n = int(self.headers.get("Content-Length") or 0)
                if n <= 0:
                    return {}
                return json.loads(self.rfile.read(n).decode("utf-8"))

            def do_GET(self) -> None:
                parsed = urllib.parse.urlparse(self.path)
                path = parsed.path.rstrip("/")
                qs = urllib.parse.parse_qs(parsed.query)
                with parent.lock:
                    parent.calls.append(("GET", path))

                prefix = "/api/v1/task"
                if not path.startswith(prefix):
                    self._send_json(404, {"status_code": 1, "error_code": "NOT_FOUND"})
                    return
                tail = [urllib.parse.unquote(p) for p in path[len(prefix) :].strip("/").split("/") if p]

                # GET /tasks/{id}
                if len(tail) == 2 and tail[0] == "tasks":
                    tid = tail[1]
                    with parent.lock:
                        t = parent.tasks.get(tid)
                        if not t:
                            self._send_json(404, {"status_code": 1, "error_code": "NOT_FOUND"})
                            return
                        parent._recompute_counts(tid)
                        self._send_json(200, {"status_code": 0, "status_msg": "ok", "data": dict(t)})
                    return

                # GET /tasks/{id}/items
                if len(tail) == 3 and tail[0] == "tasks" and tail[2] == "items":
                    tid = tail[1]
                    st_filter = qs.get("status", [None])[0]
                    page = int(qs.get("page", ["1"])[0])
                    size = int(qs.get("size", ["50"])[0])
                    with parent.lock:
                        all_items = list(parent.items.get(tid) or [])
                    if st_filter:
                        all_items = [it for it in all_items if it["status"] == st_filter]
                    start = (page - 1) * size
                    page_items = [
                        {k: v for k, v in it.items() if k != "judge_data"}
                        for it in all_items[start : start + size]
                    ]
                    self._send_json(
                        200,
                        {
                            "status_code": 0,
                            "status_msg": "ok",
                            "data": {"items": page_items, "total": len(all_items), "page": page, "size": size},
                        },
                    )
                    return

                # GET /tasks/{id}/judge/{key}/download
                if len(tail) == 5 and tail[0] == "tasks" and tail[2] == "judge" and tail[4] == "download":
                    tid = tail[1]
                    step_key = tail[3]
                    page = int(qs.get("page", ["0"])[0])
                    size = int(qs.get("size", ["100"])[0])
                    q_filter = (qs.get("query", [""])[0] or "").strip().lower()
                    with parent.lock:
                        all_judges = []
                        for it in parent.items.get(tid) or []:
                            jd = (it.get("judge_data") or {}).get(step_key)
                            if not jd:
                                continue
                            if q_filter:
                                hay = (str(jd.get("case_id") or "") + " " + str((jd.get("input") or {}).get("text") or "")).lower()
                                if q_filter not in hay:
                                    continue
                            all_judges.append(jd)
                    total = len(all_judges)
                    if page >= 1:
                        start = (page - 1) * size
                        selected = all_judges[start : start + size]
                    else:
                        selected = all_judges
                    payload_bytes = ("\n".join(json.dumps(x, ensure_ascii=False) for x in selected) + ("\n" if selected else "")).encode("utf-8")
                    use_gz = (page == 0) or parent.gzip_paginated
                    if use_gz and payload_bytes:
                        payload_bytes = gzip.compress(payload_bytes)
                    self.send_response(200)
                    self.send_header("Content-Type", "application/octet-stream")
                    self.send_header("X-Total-Count", str(total))
                    if use_gz and payload_bytes:
                        self.send_header("Content-Encoding", "gzip")
                    self.send_header("Content-Length", str(len(payload_bytes)))
                    self.end_headers()
                    self.wfile.write(payload_bytes)
                    return

                self._send_json(404, {"status_code": 1, "error_code": "NOT_FOUND"})

            def do_POST(self) -> None:
                parsed = urllib.parse.urlparse(self.path)
                path = parsed.path.rstrip("/")
                with parent.lock:
                    parent.calls.append(("POST", path))
                prefix = "/api/v1/task"
                if not path.startswith(prefix):
                    self._send_json(404, {"status_code": 1, "error_code": "NOT_FOUND"})
                    return
                tail = [urllib.parse.unquote(p) for p in path[len(prefix) :].strip("/").split("/") if p]

                # POST /testsets
                if len(tail) == 1 and tail[0] == "testsets":
                    body = self._read_body()
                    with parent.lock:
                        ts_id = f"ts_{len(parent.testsets) + 1:04d}"
                        parent.testsets[ts_id] = {
                            "testset_id": ts_id,
                            "name": body.get("name", ""),
                            "description": body.get("description", ""),
                            "cases": list(body.get("cases") or []),
                        }
                        cnt = len(parent.testsets[ts_id]["cases"])
                    self._send_json(200, {"status_code": 0, "status_msg": "ok", "data": {"testset_id": ts_id, "total_count": cnt}})
                    return

                # POST /testsets/{id}/append
                if len(tail) == 3 and tail[0] == "testsets" and tail[2] == "append":
                    ts_id = tail[1]
                    body = self._read_body()
                    with parent.lock:
                        ts = parent.testsets.get(ts_id)
                        if not ts:
                            self._send_json(404, {"status_code": 1, "error_code": "NOT_FOUND"})
                            return
                        ts["cases"].extend(body.get("cases") or [])
                        cnt = len(ts["cases"])
                    self._send_json(200, {"status_code": 0, "status_msg": "ok", "data": {"testset_id": ts_id, "total_count": cnt}})
                    return

                # POST /tasks
                if len(tail) == 1 and tail[0] == "tasks":
                    body = self._read_body()
                    with parent.lock:
                        tid = f"tm_{len(parent.tasks) + 1:04d}"
                        ts_id = (body.get("testset_selections") or [{}])[0].get("testset_id")
                        cases = list((parent.testsets.get(ts_id) or {}).get("cases") or [])
                        steps = list((body.get("pipeline") or {}).get("steps") or [])
                        step_keys = [s["key"] for s in steps]
                        task_doc = {
                            "task_id": tid,
                            "task_name": body.get("task_name", ""),
                            "testset_ids": [ts_id],
                            "pipeline": body.get("pipeline") or {},
                            "concurrency_limit": body.get("concurrency_limit", 10),
                            "status": "created",
                            "total_count": len(cases),
                            "completed_count": 0,
                            "partial_count": 0,
                            "failed_count": 0,
                            "active_count": 0,
                            "_step_keys": step_keys,
                            "_start_count": 0,
                        }
                        parent.tasks[tid] = task_doc
                        parent.items[tid] = [
                            {
                                "item_id": f"{tid}_{idx:06d}",
                                "task_id": tid,
                                "case_id": c["case_id"],
                                "input_list": c["input_list"],
                                "status": "pending",
                                "success_keys": [],
                                "missing_keys": list(step_keys),
                                "error": "",
                                "retry_count": 0,
                                "session_index": [],
                                "judge_data": {},
                            }
                            for idx, c in enumerate(cases)
                        ]
                    self._send_json(200, {"status_code": 0, "status_msg": "ok", "data": {"task_id": tid, "total_count": len(cases)}})
                    return

                # POST /tasks/{id}/start
                if len(tail) == 3 and tail[0] == "tasks" and tail[2] == "start":
                    if not self._check_auth():
                        return
                    tid = tail[1]
                    with parent.lock:
                        t = parent.tasks.get(tid)
                        if not t:
                            self._send_json(404, {"status_code": 1, "error_code": "NOT_FOUND"})
                            return
                        t["status"] = "running"
                        t["_start_count"] += 1
                        start_no = t["_start_count"]
                    threading.Thread(target=parent._simulate_task, args=(tid, start_no), daemon=True).start()
                    self._send_json(200, {"status_code": 0, "status_msg": "ok", "data": {"task_id": tid, "status": "running"}})
                    return

                # POST /tasks/{id}/cancel
                if len(tail) == 3 and tail[0] == "tasks" and tail[2] == "cancel":
                    if not self._check_auth():
                        return
                    tid = tail[1]
                    with parent.lock:
                        if tid in parent.tasks:
                            parent.tasks[tid]["status"] = "cancelled"
                    self._send_json(200, {"status_code": 0, "status_msg": "ok", "data": {"task_id": tid, "status": "cancelled"}})
                    return

                # POST /tasks/{id}/retry-recall
                if len(tail) == 3 and tail[0] == "tasks" and tail[2] == "retry-recall":
                    tid = tail[1]
                    fixed = 0
                    with parent.lock:
                        step_keys = parent.tasks[tid]["_step_keys"]
                        for it in parent.items.get(tid) or []:
                            if "not_ready" in (it.get("error") or ""):
                                for sk in step_keys:
                                    parent._mark_step_ok(it, sk)
                                it["status"] = "completed"
                                it["missing_keys"] = []
                                it["error"] = ""
                                fixed += 1
                        parent._recompute_counts(tid)
                    self._send_json(200, {"status_code": 0, "status_msg": "ok", "data": {"scanned": fixed, "items_fixed": fixed}})
                    return

                # POST /tasks/{id}/fill_missing
                if len(tail) == 3 and tail[0] == "tasks" and tail[2] == "fill_missing":
                    if not self._check_auth():
                        return
                    tid = tail[1]
                    fill_cnt = 0
                    with parent.lock:
                        for it in parent.items.get(tid) or []:
                            if it["status"] == "partial":
                                it["status"] = "pending"
                                it["retry_count"] += 1
                                fill_cnt += 1
                        if fill_cnt > 0:
                            parent.tasks[tid]["status"] = "created"
                        parent._recompute_counts(tid)
                    self._send_json(200, {"status_code": 0, "status_msg": "ok", "data": {"task_id": tid, "fill_count": fill_cnt}})
                    return

                # POST /tasks/{id}/reset_failed
                if len(tail) == 3 and tail[0] == "tasks" and tail[2] == "reset_failed":
                    if not self._check_auth():
                        return
                    tid = tail[1]
                    reset_cnt = 0
                    with parent.lock:
                        for it in parent.items.get(tid) or []:
                            if it["status"] == "failed":
                                it["status"] = "pending"
                                it["retry_count"] += 1
                                reset_cnt += 1
                        if reset_cnt > 0:
                            parent.tasks[tid]["status"] = "created"
                        parent._recompute_counts(tid)
                    self._send_json(200, {"status_code": 0, "status_msg": "ok", "data": {"task_id": tid, "reset_count": reset_cnt}})
                    return

                # POST /tasks/{id}/generate_judge
                if len(tail) == 3 and tail[0] == "tasks" and tail[2] == "generate_judge":
                    self._send_json(200, {"status_code": 0, "status_msg": "ok", "data": {"generated_items": 0}})
                    return

                self._send_json(404, {"status_code": 1, "error_code": "NOT_FOUND"})

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()
        return f"http://127.0.0.1:{self._server.server_address[1]}/api/v1/task"

    def stop(self) -> None:
        if self._server:
            self._server.shutdown()
            self._server.server_close()

    @staticmethod
    def _mark_step_ok(item: dict[str, Any], step_key: str) -> None:
        q = item["input_list"][-1]["query"]
        tid = f"trace_{item['item_id']}_{step_key}"
        sid = f"thread_{item['item_id']}_{step_key}"
        if step_key not in item["success_keys"]:
            item["success_keys"].append(step_key)
        item["missing_keys"] = [k for k in item["missing_keys"] if k != step_key]
        item["session_index"].append(
            {"step": step_key, "session_id": sid, "trace_id": tid, "ts": 1794492521802, "turns": 1}
        )
        item["judge_data"][step_key] = {
            "case_id": item["case_id"],
            "trace_id": tid,
            "input": {"text": q, "image": "", "file": ""},
            "context": [],
            "tools": [],
            "chain": [
                {
                    "plan": f"Checking live data for {step_key}",
                    "tools": [
                        {
                            "name": "web_search",
                            "input": {"query": q},
                            "output": f"Search results for {q}",
                        }
                    ],
                }
            ],
            "raw_answer": "",
            "visual_answer": "",
            "text_answer": f"[{step_key}] Final grounded answer for {q}",
            "multimodal": {},
            "meta": {
                "session_id": sid,
                "timestamp_time": 1794492521802,
                "request_time": "2026-11-12 09:08:41",
                "first_token_time_cost": 950,
                "finish_answer_time_cost": 4200,
                "input_tokens": 1200,
                "output_tokens": 350,
            },
        }

    def _recompute_counts(self, tid: str) -> None:
        t = self.tasks[tid]
        items = self.items.get(tid) or []
        t["completed_count"] = sum(1 for it in items if it["status"] == "completed")
        t["partial_count"] = sum(1 for it in items if it["status"] == "partial")
        t["failed_count"] = sum(1 for it in items if it["status"] == "failed")
        t["active_count"] = sum(1 for it in items if it["status"] in ("pending", "running"))

    def _simulate_task(self, tid: str, start_no: int) -> None:
        if self.behavior == "hang_running":
            return

        with self.lock:
            step_keys = list(self.tasks[tid]["_step_keys"])
            items = self.items[tid]

        if start_no == 1:
            # First item completes immediately so streaming triggers while task is STILL running!
            with self.lock:
                for sk in step_keys:
                    self._mark_step_ok(items[0], sk)
                items[0]["status"] = "completed"
                self._recompute_counts(tid)
            time.sleep(0.25)

            # Remaining items complete with realistic mixed outcomes:
            #   item[1]: log recall lag (`reason=not_ready`) -> recovered by retry-recall
            #   item[2]: partial (only first step ok) -> recovered by fill_missing + start
            #   item[3]: permanently fails second step (`QUESTION_FAILED`) -> stays partial
            with self.lock:
                if len(items) > 1:
                    items[1]["status"] = "failed"
                    items[1]["error"] = "recall failed: reason=not_ready"
                if len(items) > 2:
                    self._mark_step_ok(items[2], step_keys[0])
                    items[2]["status"] = "partial" if len(step_keys) > 1 else "completed"
                    items[2]["error"] = f"missing keys: {step_keys[1:]}" if len(step_keys) > 1 else ""
                if len(items) > 3:
                    self._mark_step_ok(items[3], step_keys[0])
                    items[3]["status"] = "partial" if len(step_keys) > 1 else "completed"
                    items[3]["error"] = "QUESTION_FAILED: upstream timeout"
                self.tasks[tid]["status"] = "completed"
                self._recompute_counts(tid)
        else:
            # Recovery start: fix item[2], leave item[3] permanently failing second step
            time.sleep(0.05)
            with self.lock:
                if len(items) > 2 and items[2]["status"] == "pending":
                    for sk in step_keys:
                        self._mark_step_ok(items[2], sk)
                    items[2]["status"] = "completed"
                    items[2]["error"] = ""
                if len(items) > 3 and items[3]["status"] == "pending":
                    items[3]["status"] = "partial" if len(step_keys) > 1 else "completed"
                    items[3]["error"] = "QUESTION_FAILED: upstream timeout"
                self.tasks[tid]["status"] = "completed"
                self._recompute_counts(tid)


class TaskManagerIntegrationTests(unittest.TestCase):
    def test_url_normalization_and_config_secret_safety(self) -> None:
        self.assertEqual(
            normalize_task_manager_base_url("http://10.217.216.85:8888"),
            "http://10.217.216.85:8888/api/v1/task",
        )
        self.assertEqual(
            normalize_task_manager_base_url("http://10.217.216.85:8888/api/v1/task/"),
            "http://10.217.216.85:8888/api/v1/task",
        )
        with tempfile.TemporaryDirectory() as td:
            env_file = Path(td) / "tm.env"
            env_file.write_text(
                "export INTERNAL_EVAL_COLLECTOR_MODE=task_manager\n"
                "export INTERNAL_EVAL_TASK_MANAGER_BASE_URL=http://10.217.216.85:8888\n"
                "export INTERNAL_EVAL_TASK_MANAGER_USER_ID=secret_tm_user\n",
                encoding="utf-8",
            )
            cfg = load_config(env={}, env_file=env_file)
            self.assertEqual(cfg.collector_mode, "task_manager")
            self.assertEqual(cfg.task_manager_base_url, "http://10.217.216.85:8888/api/v1/task")
            self.assertEqual(cfg.task_manager_user_id, "secret_tm_user")
            self.assertIsInstance(create_collector_adapter(cfg), TaskManagerCollectorAdapter)
            summary = cfg.public_summary()
            self.assertTrue(summary["task_manager_auth_configured"])
            self.assertNotIn("secret_tm_user", json.dumps(summary))

    def test_judge_record_conversion_passes_real_eval_harness_prepare(self) -> None:
        judge_rec = {
            "case_id": "run_demo_eq_00007",
            "trace_id": "7f09ff27-8e3b-4efb-a430-f7746a0eb947",
            "input": {"text": "Classify the current market regime.", "image": "", "file": ""},
            "context": [{"role": "user", "content": "Hi"}, {"role": "assistant", "content": "Hello"}],
            "tools": [],
            "chain": [
                {
                    "plan": "Let me inspect macro indicators first.",
                    "tools": [
                        {"name": "view_skill", "input": {"name": "macro-background"}, "output": "loaded skill"},
                        {"name": "shell", "input": {"command": "python3 macro.py"}, "output": "{\"cpi\": 3.1}"},
                    ],
                },
                {
                    "plan": "Interesting — CPI is sticky.",
                    "tools": [],
                },
            ],
            "raw_answer": "",
            "visual_answer": "",
            "text_answer": "**Overheating**: October core CPI stayed firm at 3.1%.",
            "multimodal": {},
            "meta": {
                "session_id": "thread_8b0db231e5f643bfb5aa8cbb431dc2ca",
                "timestamp_time": 1794492521814,
                "request_time": "2026-11-12 09:08:41",
                "first_token_time_cost": 1104,
                "first_answer_time_cost": 5537,
                "finish_answer_time_cost": 243056,
                "input_tokens": 39957,
                "output_tokens": 18997,
                "citations": {"ID: cite_1": "{\"kind\":\"web\"}"},
            },
        }
        trace = judge_record_to_eval_trace(
            judge_rec,
            run_id="run_demo",
            side="after",
            version="1124",
            agent_label="aime-pre",
            step_key="after-pre",
            task_id="tm_001",
        )
        self.assertEqual(trace["case_key"], "eq_00007")
        self.assertEqual(trace["case_id"], "run_demo_after_eq_00007")
        self.assertEqual(trace["trace_id"], "7f09ff27-8e3b-4efb-a430-f7746a0eb947")
        self.assertEqual(trace["session_id"], "thread_8b0db231e5f643bfb5aa8cbb431dc2ca")
        self.assertTrue(trace["request_time"].endswith("Z"))
        msg_types = [m["type"] for m in trace["messages"]]
        self.assertEqual(
            msg_types,
            ["user_question", "llm_turn", "tool_call", "tool_result", "tool_call", "tool_result", "llm_turn", "llm_turn", "final_answer"],
        )

        # Verify against real vendored Node.js eval_harness_pkg `prepare`
        ensure_vendor_on_path()
        from eval_harness.runner import check_node_runtime  # type: ignore

        try:
            check_node_runtime()
        except RuntimeError as exc:
            self.skipTest(f"Node runtime unavailable: {exc}")

        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            cfg = ServiceConfig(
                datasets_root=tmp,
                ab_test_root=tmp / "ab",
                bench_root=tmp / "bench",
                state_db_path=tmp / "state.sqlite3",
                base_taxonomy_dir=ROOT / "vendor" / "cluster_pkg" / "builtin_taxonomy",
            )
            backend = VendoredEngineBackend(cfg)
            raw_path = tmp / "raw.jsonl"
            raw_path.write_text(json.dumps(trace, ensure_ascii=False) + "\n", encoding="utf-8")
            report = backend.prepare(
                raw_input_path=raw_path,
                output_path=tmp / "prepared.jsonl",
                audit_path=tmp / "audit.jsonl",
                batch_id="2026-11-24",
                version="aime-pre",
            )
            self.assertEqual(report.get("passed", 0), 1, f"prepare issues: {report}")
            self.assertEqual(report.get("rejected", 0), 0)
            prepared = json.loads((tmp / "prepared.jsonl").read_text(encoding="utf-8").splitlines()[0])
            self.assertEqual(extract_case_key(prepared), "eq_00007")

    def test_build_testset_cases_and_pipeline_template_copy(self) -> None:
        mock_tm = _MockTaskManagerServer(allowed_user="tester")
        tm_url = mock_tm.start()
        try:
            client = TaskManagerClient(tm_url, user_id="tester")
            run = {
                "run_id": "run_pipe_1",
                "model": "aime_expert",
                "before_agent": {"name": "online", "is_pre": False},
                "after_agent": {"name": "pre", "is_pre": True, "agent_id": "analyst-pre"},
                "before_agent_label": "online",
                "after_agent_label": "pre",
                "meta": {"task_manager": {"template_task_id": mock_tm.template_task_id}},
            }
            pipeline, step_map = build_pipeline_and_step_map(run=run, sides=["before", "after"], client=client)
            self.assertTrue(pipeline["parallel"])
            self.assertEqual(len(pipeline["steps"]), 2)
            self.assertEqual(pipeline["steps"][0]["runtime"], "agent-runtime")
            self.assertFalse(pipeline["steps"][0]["is_pre"])
            self.assertTrue(pipeline["steps"][1]["is_pre"])
            self.assertEqual(pipeline["steps"][1]["agent_id"], "analyst-pre")
            self.assertNotEqual(step_map["before"], step_map["after"])

            cases = build_testset_cases(
                "run_pipe_1",
                [
                    {
                        "case_key": "eq_00001",
                        "eq_index": 1,
                        "question": "Follow up?",
                        "turn": "multi",
                        "history_messages": [
                            {"role": "user", "content": "First q"},
                            {"role": "assistant", "content": "First a"},
                        ],
                    }
                ],
                max_history_turns=2,
            )
            self.assertEqual(cases[0]["case_id"], "run_pipe_1_eq_00001")
            self.assertEqual(cases[0]["input_list"], [{"query": "First q"}, {"query": "Follow up?"}])
        finally:
            mock_tm.stop()

    def test_full_e2e_task_manager_streaming_recovery_and_cancel(self) -> None:
        mock_tm = _MockTaskManagerServer(allowed_user="huangdaqiang")
        tm_url = mock_tm.start()
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            _write_fake_bench(tmp / "3_dynamic_bench", count=4)
            cfg = ServiceConfig(
                datasets_root=tmp,
                ab_test_root=tmp / "1_aime" / "ab_test",
                bench_root=tmp / "3_dynamic_bench",
                state_db_path=tmp / "1_aime" / "ab_test" / ".service_state" / "internal_eval.sqlite3",
                base_taxonomy_dir=ROOT / "vendor" / "cluster_pkg" / "builtin_taxonomy",
                collector_mode="task_manager",
                collector_poll_interval_sec=0.05,
                eval_poll_interval_sec=0.05,
                cluster_microbatch_size=2,
                cluster_microbatch_interval_sec=0.1,
                allow_custom_tier=True,
                task_manager_base_url=tm_url,
                task_manager_user_id="huangdaqiang",
                task_manager_batch_size=2,  # Forces /testsets + /append chunking for 4 cases!
                task_manager_poll_interval_sec=0.08,
                task_manager_max_recovery_rounds=1,
            )
            store = StateStore(cfg.state_db_path)
            eng = FakeStreamingEngine()
            collector = TaskManagerCollectorAdapter(cfg)
            pipeline = PipelineManager(cfg, store, engine=eng, collector=collector, start_worker=True)
            app = InternalEvalApp(cfg, store, pipeline)

            class Handler(BaseHTTPRequestHandler):
                def log_message(self, fmt: str, *args: Any) -> None:
                    pass

                def do_GET(self) -> None:
                    app.handle_http(self)

                def do_POST(self) -> None:
                    app.handle_http(self)

            srv = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
            threading.Thread(target=srv.serve_forever, daemon=True).start()
            base_url = f"http://127.0.0.1:{srv.server_address[1]}{cfg.api_prefix}"
            try:
                # 1. Submit A/B run with template copy + per-side step config
                st, created = _http_json(
                    f"{base_url}/runs",
                    method="POST",
                    body={
                        "version": "1124",
                        "tier": 4,
                        "model": "aime_expert",
                        "before_agent": {"name": "online", "is_pre": False},
                        "after_agent": {"name": "pre", "is_pre": True, "agent_id": "analyst-pre"},
                        "task_manager": {
                            "template_task_id": mock_tm.template_task_id,
                            "concurrency_limit": 2,
                        },
                    },
                )
                self.assertEqual(st, 201)
                run_id = created["data"]["run_id"]

                # Wait for terminal status (`completed_with_errors` because eq_00004 fails `after` permanently)
                self.assertTrue(
                    _wait_until(
                        lambda: _http_json(f"{base_url}/runs/{run_id}")[1]["data"]["status"] == "completed_with_errors",
                        timeout=15.0,
                    ),
                    f"Run did not converge: {_http_json(f'{base_url}/runs/{run_id}')[1]['data']}",
                )

                # Verify chunked /append, /retry-recall, and /fill_missing were all invoked!
                post_paths = [p for m, p in mock_tm.calls if m == "POST"]
                self.assertTrue(any(p.endswith("/append") for p in post_paths), f"expected /append in {post_paths}")
                self.assertTrue(any(p.endswith("/retry-recall") for p in post_paths), f"expected /retry-recall in {post_paths}")
                self.assertTrue(any(p.endswith("/fill_missing") for p in post_paths), f"expected /fill_missing in {post_paths}")

                # Verify before has 4 ready, after has 3 ready + 1 fetch failure (eq_00004)
                run_info = _http_json(f"{base_url}/runs/{run_id}")[1]["data"]
                self.assertEqual(run_info["sides_detail"]["before"]["ready"], 4)
                self.assertEqual(run_info["sides_detail"]["after"]["ready"], 3)
                self.assertEqual(run_info["sides_detail"]["after"]["failed"], 1)

                # Verify compare & failures endpoints
                st, cmp_resp = _http_json(f"{base_url}/runs/{run_id}/compare")
                self.assertEqual(st, 200)
                self.assertEqual(cmp_resp["data"]["paired_summary"]["paired_ready_count"], 3)

                st, fails = _http_json(f"{base_url}/runs/{run_id}/failures?stage=fetch&side=after")
                self.assertEqual(st, 200)
                self.assertEqual(fails["data"]["total"], 1)
                self.assertEqual(fails["data"]["items"][0]["case_key"], "eq_00004")
                self.assertEqual(fails["data"]["items"][0]["error_code"], "TASK_MANAGER_STEP_FAILED")

                # 2. Verify cancel propagates to TaskManager POST /tasks/{id}/cancel
                mock_tm.behavior = "hang_running"
                st, c2 = _http_json(
                    f"{base_url}/runs",
                    method="POST",
                    body={
                        "version": "1125",
                        "tier": 2,
                        "sides": ["after"],
                        "after_agent": {"name": "pre-cancel-test", "is_pre": True},
                    },
                )
                self.assertEqual(st, 201)
                run_id2 = c2["data"]["run_id"]
                self.assertTrue(
                    _wait_until(lambda: _http_json(f"{base_url}/runs/{run_id2}")[1]["data"]["status"] == "running")
                )
                st, _ = _http_json(f"{base_url}/runs/{run_id2}/cancel", method="POST")
                self.assertEqual(st, 200)
                self.assertTrue(
                    _wait_until(lambda: _http_json(f"{base_url}/runs/{run_id2}")[1]["data"]["status"] == "cancelled")
                )
                self.assertTrue(
                    _wait_until(lambda: any(m == "POST" and p.endswith("/cancel") for m, p in mock_tm.calls))
                )
            finally:
                pipeline.stop()
                srv.shutdown()
                srv.server_close()
                mock_tm.stop()


if __name__ == "__main__":
    unittest.main()
