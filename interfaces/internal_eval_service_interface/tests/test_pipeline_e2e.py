"""End-to-end streaming pipeline & HTTP API tests."""

from __future__ import annotations

import json
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from internal_eval.api import InternalEvalApp
from internal_eval.collectors import FileDropCollectorAdapter
from internal_eval.config import ServiceConfig
from internal_eval.engines import EngineBackend, VendoredEngineBackend, ensure_vendor_on_path, extract_case_key
from internal_eval.pipeline import PipelineManager
from internal_eval.state_store import StateStore
from tests.test_unit import _write_fake_bench


class FakeStreamingEngine(EngineBackend):
    """Deterministic fast engine that mimics eval_harness_pkg + cluster_pkg streaming."""

    def __init__(self) -> None:
        self.fail_eval_keys: set[str] = set()
        self.reject_prepare_keys: set[str] = set()
        self.gold_keys: set[str] = {"eq_00001"}
        self.cluster_calls: list[dict[str, Any]] = []
        self.human_read_calls: list[dict[str, Any]] = []
        self.eval_delay_sec: float = 0.01

    def prepare(
        self,
        *,
        raw_input_path: Path,
        output_path: Path,
        audit_path: Path,
        batch_id: str,
        version: str,
    ) -> dict[str, Any]:
        output_path.parent.mkdir(parents=True, exist_ok=True)
        audit_path.parent.mkdir(parents=True, exist_ok=True)
        issues = []
        accepted = 0
        with raw_input_path.open("r", encoding="utf-8") as src, output_path.open("w", encoding="utf-8") as dst:
            for idx, line in enumerate(src, 1):
                line = line.strip()
                if not line:
                    continue
                obj = json.loads(line)
                ck = extract_case_key(obj)
                if ck in self.reject_prepare_keys:
                    issues.append(
                        {
                            "line": idx,
                            "case_key": ck,
                            "severity": "reject",
                            "reason": "empty_question",
                            "message": "模拟准入校验拒绝",
                        }
                    )
                    continue
                dst.write(json.dumps(obj, ensure_ascii=False) + "\n")
                accepted += 1
        audit_path.write_text("\n".join(json.dumps(x) for x in issues) + ("\n" if issues else ""), encoding="utf-8")
        return {"accepted": accepted, "rejected": len(issues), "audit_issues": issues}

    def evaluate_streaming(
        self,
        *,
        input_path: Path,
        output_path: Path,
        audit_path: Path,
        batch_id: str,
        version: str,
        on_row: Callable[[dict[str, Any]], None],
        on_case_error: Callable[[str, str], None],
        cancel_check: Callable[[], bool],
        compact_output: Path | None = None,
    ) -> dict[str, Any]:
        output_path.parent.mkdir(parents=True, exist_ok=True)
        if compact_output is not None:
            compact_output.parent.mkdir(parents=True, exist_ok=True)
        rows = [json.loads(l) for l in input_path.read_text(encoding="utf-8").splitlines() if l.strip()]
        completed = 0
        failed = 0
        with output_path.open("a", encoding="utf-8") as out_fh:
            for item in rows:
                if cancel_check():
                    break
                if self.eval_delay_sec > 0:
                    time.sleep(self.eval_delay_sec)
                ck = extract_case_key(item) or ""
                cid = item.get("case_id") or ck
                if ck in self.fail_eval_keys:
                    failed += 1
                    on_case_error(cid, "Simulated LLM judge timeout")
                    continue
                is_gold = ck in self.gold_keys
                probs = []
                if not is_gold:
                    sev = "P1" if "before" in cid else "P3"
                    probs = [
                        {
                            "label": f"Mock issue for {ck}",
                            "definition": "Mock definition",
                            "reason": "Mock reason",
                            "severity": sev,
                            "component": "finquery",
                            "component_role": "tool",
                        }
                    ]
                attr_row = {
                    "session_meta": {
                        "trace_id": item["trace_id"],
                        "session_id": item["session_id"],
                        "case_id": cid,
                        "question": item["meta"]["question"],
                        "request_time": item["request_time"],
                    },
                    "turns": [
                        {
                            "meta": {
                                "trace_id": item["trace_id"],
                                "session_id": item["session_id"],
                                "case_id": cid,
                            },
                            "summary": "Mock summary",
                            "is_correct": is_gold,
                            "problem": probs,
                        }
                    ],
                }
                out_fh.write(json.dumps(attr_row, ensure_ascii=False) + "\n")
                out_fh.flush()
                completed += 1
                on_row(attr_row)
        return {"completed": completed, "failed": failed}

    def cluster_incremental(
        self,
        *,
        attribution_input: Path,
        tree_dir: Path,
        shared_taxonomy_dir: Path,
        allow_auto_leaf: bool,
        log_fn: Callable[[str], None] | None = None,
    ) -> dict[str, Any]:
        tree_dir.mkdir(parents=True, exist_ok=True)
        assignments: dict[str, dict[int, dict[str, Any]]] = {}
        leaf_names = {"S9.M6.4": "凭空补出数值", "S5.M3.1": "抓取失败返回全空字段"}
        index_lines = []
        files = [attribution_input] if attribution_input.is_file() else sorted(attribution_input.glob("*.jsonl"))
        for f in files:
            for line in f.read_text(encoding="utf-8").splitlines():
                if not line.strip():
                    continue
                row = json.loads(line)
                for turn in row.get("turns") or []:
                    tid = turn["meta"]["trace_id"]
                    for pidx, prob in enumerate(turn.get("problem") or []):
                        path = "S9.M6.4" if prob.get("severity") == "P1" else "S5.M3.1"
                        assignments.setdefault(tid, {})[pidx] = {
                            "path": path,
                            "name": leaf_names[path],
                            "edge": False,
                        }
                        index_lines.append(
                            json.dumps(
                                {"trace_id": tid, "problem_index": pidx, "path": path, "leaf_name": leaf_names[path]},
                                ensure_ascii=False,
                            )
                        )
        (tree_dir / "item_index.jsonl").write_text("\n".join(index_lines) + ("\n" if index_lines else ""), encoding="utf-8")
        (tree_dir / "leaves.tsv").write_text(
            "path\tname\tcount\nS9.M6.4\t凭空补出数值\t1\nS5.M3.1\t抓取失败返回全空字段\t1\n",
            encoding="utf-8",
        )
        self.cluster_calls.append({"tree_dir": str(tree_dir), "allow_auto_leaf": allow_auto_leaf, "items": len(index_lines)})
        return {
            "status": "ok",
            "total_items": len(index_lines),
            "new_items": len(index_lines),
            "created_components": [],
            "created_leaves": [],
            "assignments": assignments,
            "leaf_names": leaf_names,
        }

    def human_read(
        self,
        *,
        input_path: Path,
        attribution_path: Path,
        output_path: Path,
        work_dir: Path,
        compact_path: Path | None = None,
    ) -> dict[str, Any]:
        work_dir.mkdir(parents=True, exist_ok=True)
        if not attribution_path.is_file() or attribution_path.stat().st_size == 0:
            return {"skipped": True}
        rows = [json.loads(l) for l in attribution_path.read_text(encoding="utf-8").splitlines() if l.strip()]
        output_path.parent.mkdir(parents=True, exist_ok=True)
        with output_path.open("w", encoding="utf-8") as fh:
            for row in rows:
                translated = json.loads(json.dumps(row))
                for turn in translated.get("turns") or []:
                    turn["summary"] = f"[人话] {turn.get('summary') or ''}"
                fh.write(json.dumps(translated, ensure_ascii=False) + "\n")
        self.human_read_calls.append({"output_path": str(output_path), "rows": len(rows)})
        return {"copied": True, "translated": len(rows), "output_path": str(output_path)}


def _http_json(url: str, method: str = "GET", body: dict[str, Any] | None = None, headers: dict[str, str] | None = None) -> tuple[int, dict[str, Any]]:
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req_headers = {"Content-Type": "application/json", **(headers or {})}
    req = urllib.request.Request(url, data=data, headers=req_headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        try:
            return exc.code, json.loads(exc.read().decode("utf-8"))
        finally:
            exc.close()


def _make_trace(run_id: str, side: str, case_key: str, question: str) -> dict[str, Any]:
    tid = f"trace_{side}_{case_key}"
    sid = f"sess_{side}_{case_key}"
    return {
        "case_key": case_key,
        "trace_id": tid,
        "session_id": sid,
        "request_time": "2026-11-24T12:00:00Z",
        "meta": {"trace_id": tid, "session_id": sid, "question": question},
        "messages": [
            {"role": "user", "type": "user_question", "content": question},
            {"role": "assistant", "type": "final_answer", "content": f"Answer for {case_key}"},
        ],
    }


def _wait_until(predicate: Callable[[], bool], timeout: float = 10.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.05)
    return False


class PipelineE2ETests(unittest.TestCase):
    def _start_test_server(
        self,
        tmp: Path,
        *,
        engine: EngineBackend | None = None,
        api_write_token: str = "",
        silence_timeout: float = 30.0,
    ) -> tuple[str, InternalEvalApp, ThreadingHTTPServer]:
        _write_fake_bench(tmp / "3_dynamic_bench", count=5)
        cfg = ServiceConfig(
            datasets_root=tmp,
            ab_test_root=tmp / "1_aime" / "ab_test",
            bench_root=tmp / "3_dynamic_bench",
            state_db_path=tmp / "1_aime" / "ab_test" / ".service_state" / "internal_eval.sqlite3",
            base_taxonomy_dir=ROOT / "vendor" / "cluster_pkg" / "builtin_taxonomy",
            collector_mode="file_drop",
            collector_poll_interval_sec=0.05,
            collector_silence_timeout_sec=silence_timeout,
            eval_poll_interval_sec=0.05,
            cluster_microbatch_size=2,
            cluster_microbatch_interval_sec=0.2,
            allow_custom_tier=True,
            api_write_token=api_write_token,
            page_base_url="http://10.217.219.2:2476",
        )
        store = StateStore(cfg.state_db_path)
        eng = engine or FakeStreamingEngine()
        pipeline = PipelineManager(cfg, store, engine=eng, collector=FileDropCollectorAdapter(cfg), start_worker=True)
        app = InternalEvalApp(cfg, store, pipeline)

        class TestHandler(BaseHTTPRequestHandler):
            def log_message(self, fmt: str, *args: Any) -> None:
                pass

            def do_GET(self) -> None:
                app.handle_http(self)

            def do_POST(self) -> None:
                app.handle_http(self)

        srv = ThreadingHTTPServer(("127.0.0.1", 0), TestHandler)
        t = threading.Thread(target=srv.serve_forever, daemon=True)
        t.start()
        base_url = f"http://127.0.0.1:{srv.server_address[1]}{cfg.api_prefix}"
        return base_url, app, srv

    def test_streaming_first_trace_ready_partial_failure_retry_and_versions(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            eng = FakeStreamingEngine()
            eng.reject_prepare_keys = {"eq_00004"}
            eng.fail_eval_keys = {"eq_00005"}
            base_url, app, srv = self._start_test_server(Path(td), engine=eng)
            try:
                # 1. Docs & healthz
                st, health = _http_json(f"{base_url}/healthz")
                self.assertEqual(st, 200)
                self.assertTrue(health["data"]["ok"])
                st, docs = _http_json(f"{base_url}/docs")
                self.assertEqual(st, 200)
                doc_names = [d["name"] for d in docs["data"]["docs"]]
                self.assertIn("接入说明", doc_names)
                self.assertIn("拉数同事接口契约", doc_names)
                st, doc_body = _http_json(f"{base_url}/docs/{urllib.request.quote('接入说明')}")
                self.assertEqual(st, 200)
                self.assertIn("内部评测与聚类服务接入说明", doc_body["data"]["content"])

                # 2. Create run with idempotency_key
                st, created = _http_json(
                    f"{base_url}/runs",
                    method="POST",
                    body={
                        "version": "1124",
                        "tier": 5,
                        "model": "aime_expert",
                        "before_agent": {"name": "aime-old"},
                        "after_agent": {"name": "aime-new"},
                        "idempotency_key": "idem-001",
                    },
                )
                self.assertEqual(st, 201)
                run_id = created["data"]["run_id"]
                self.assertIn("/compare/?product=aime&round=", created["data"]["compare_page_url"])

                # Idempotency replay returns 200 and same run_id
                st2, replay = _http_json(
                    f"{base_url}/runs",
                    method="POST",
                    body={
                        "version": "1124",
                        "tier": 5,
                        "before_agent": "aime-old",
                        "after_agent": "aime-new",
                        "idempotency_key": "idem-001",
                    },
                )
                self.assertEqual(st2, 200)
                self.assertEqual(replay["data"]["run_id"], run_id)

                # Wait until run reaches `running` & dispatch JSONLs exist
                self.assertTrue(
                    _wait_until(lambda: _http_json(f"{base_url}/runs/{run_id}")[1]["data"]["status"] == "running")
                )
                run_info = _http_json(f"{base_url}/runs/{run_id}")[1]["data"]
                self.assertTrue(Path(run_info["dispatch_files"]["before"]).is_file())
                self.assertTrue(Path(run_info["dispatch_files"]["after"]).is_file())

                # 3. Stream JUST 1 problem trace (`eq_00002`) before anything else arrives!
                st, ing = _http_json(
                    f"{base_url}/runs/{run_id}/ingest",
                    method="POST",
                    body={"side": "before", "traces": [_make_trace(run_id, "before", "eq_00002", "Target question 1")]},
                )
                self.assertEqual(st, 200)
                self.assertEqual(ing["data"]["accepted"], 1)

                # MUST become ready & clustered IMMEDIATELY while run is STILL running!
                self.assertTrue(
                    _wait_until(
                        lambda: _http_json(f"{base_url}/runs/{run_id}/results/changes?since=0")[1]["data"]["count"] >= 1
                    )
                )
                changes1 = _http_json(f"{base_url}/runs/{run_id}/results/changes?since=0")[1]["data"]
                self.assertEqual(changes1["run_status"], "running")
                self.assertEqual(changes1["items"][0]["case_key"], "eq_00002")
                self.assertEqual(changes1["items"][0]["cluster_paths"], ["S9.M6.4"])
                seq_cursor = changes1["next_since"]

                # 4. Ingest remaining traces for both sides (eq_00003 on after fails at fetch!)
                for side in ("before", "after"):
                    batch = []
                    for i in range(1, 6):
                        ck = f"eq_{i:05d}"
                        if side == "before" and ck == "eq_00002":
                            continue
                        if side == "after" and ck == "eq_00003":
                            continue
                        batch.append(_make_trace(run_id, side, ck, f"Target question {i - 1}"))
                    _http_json(f"{base_url}/runs/{run_id}/ingest", method="POST", body={"side": side, "traces": batch})
                    if side == "after":
                        _http_json(
                            f"{base_url}/runs/{run_id}/collector-events",
                            method="POST",
                            body={
                                "side": "after",
                                "event_type": "case_failed",
                                "case_key": "eq_00003",
                                "error_code": "AGENT_ERR",
                                "error_message": "Agent 500",
                            },
                        )
                    _http_json(
                        f"{base_url}/runs/{run_id}/collector-events",
                        method="POST",
                        body={"side": side, "event_type": "completed"},
                    )

                # Wait for partial-success terminal status `completed_with_errors`
                self.assertTrue(
                    _wait_until(
                        lambda: _http_json(f"{base_url}/runs/{run_id}")[1]["data"]["status"] == "completed_with_errors"
                    )
                )

                # Verify incremental changes picked up new items after seq_cursor
                changes2 = _http_json(f"{base_url}/runs/{run_id}/results/changes?since={seq_cursor}")[1]["data"]
                self.assertGreaterEqual(changes2["count"], 4)

                # Verify failures endpoint shows all 3 stages: fetch, prepare, eval
                st, fails = _http_json(f"{base_url}/runs/{run_id}/failures")
                self.assertEqual(st, 200)
                self.assertIn("fetch", fails["data"]["by_stage"])
                self.assertIn("prepare", fails["data"]["by_stage"])
                self.assertIn("eval", fails["data"]["by_stage"])

                # Verify real-time compare & version endpoints
                st, cmp = _http_json(f"{base_url}/runs/{run_id}/compare")
                self.assertEqual(st, 200)
                self.assertEqual(cmp["data"]["paired_summary"]["paired_ready_count"], 2)  # eq_00001 + eq_00002
                self.assertEqual(cmp["data"]["paired_summary"]["improved"], 1)  # eq_00002: P1 -> P3

                st, ver = _http_json(f"{base_url}/versions/1124")
                self.assertEqual(st, 200)
                self.assertEqual(ver["data"]["selected_run_id"], run_id)
                self.assertEqual(ver["data"]["total_runs"], 1)

                # 5. Retry failed eval cases after clearing simulated failure
                eng.fail_eval_keys.clear()
                st, retry_resp = _http_json(
                    f"{base_url}/runs/{run_id}/retry-failed",
                    method="POST",
                    body={"stages": ["eval"]},
                )
                self.assertEqual(st, 200)
                self.assertEqual(retry_resp["data"]["reset_total"], 2)  # eq_00005 on before & after
                self.assertTrue(
                    _wait_until(
                        lambda: _http_json(f"{base_url}/runs/{run_id}")[1]["data"]["status"] == "completed_with_errors"
                    )
                )
                # Paired ready count should now be 3 (eq_00001, eq_00002, eq_00005)
                cmp_after_retry = _http_json(f"{base_url}/runs/{run_id}/compare")[1]["data"]
                self.assertEqual(cmp_after_retry["paired_summary"]["paired_ready_count"], 3)

                # Verify canonical layout on disk is directly consumable by dashboard/ab_test.py & ab_detail.py
                run_info_final = _http_json(f"{base_url}/runs/{run_id}")[1]["data"]
                rdir = Path(run_info_final["round_dir_path"])
                self.assertTrue((rdir / "bench" / "bench.jsonl").is_file())
                self.assertTrue((rdir / "agent_before_opt" / "res_before_opt.jsonl").is_file())
                self.assertTrue((rdir / "agent_after_opt" / "res_after_opt.jsonl").is_file())
                self.assertTrue((rdir / "agent_before_opt" / "eval_output" / "attribution.jsonl").is_file())
                self.assertTrue((rdir / "agent_after_opt" / "eval_output" / "attribution.jsonl").is_file())
                self.assertTrue((rdir / "index_stats" / "meta.json").is_file())
                self.assertTrue((rdir / "index_stats" / "pairs_index.csv").is_file())
                self.assertTrue((rdir / "index_stats" / "stats.json").is_file())
                dash_dir = ROOT.parent.parent / "dashboard"
                if dash_dir.is_dir():
                    if str(dash_dir) not in sys.path:
                        sys.path.insert(0, str(dash_dir))
                    import ab_test as dash_ab  # type: ignore
                    import ab_detail as dash_ab_detail  # type: ignore

                    ds_root = rdir.parent.parent.parent
                    payload = dash_ab.ab_payload(ds_root, "aime")
                    self.assertIsNotNone(payload)
                    self.assertEqual(len(payload["rounds"]), 1)
                    rnd = payload["rounds"][0]
                    self.assertEqual(rnd["before_label"], "aime-old")
                    self.assertEqual(rnd["after_label"], "aime-new")
                    self.assertEqual(len(rnd["pairs"]), 3)
                    builder = dash_ab_detail.ABDetailBuilder(
                        ds_root, ds_root / ".cache", ds_root / ".ab_samples"
                    )
                    b1 = builder.ensure(rdir.name, "before-1")
                    a1 = builder.ensure(rdir.name, "after-1")
                    self.assertTrue(b1 is not None and b1.is_file())
                    self.assertTrue(a1 is not None and a1.is_file())
            finally:
                app.pipeline.stop()
                srv.shutdown()
                srv.server_close()

    def test_file_drop_and_cancel_and_write_auth(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            base_url, app, srv = self._start_test_server(Path(td), api_write_token="secret-tok-123")
            try:
                # Write without token rejected with 401; GET allowed without token
                st, _ = _http_json(f"{base_url}/runs")
                self.assertEqual(st, 200)
                st, _ = _http_json(
                    f"{base_url}/runs",
                    method="POST",
                    body={"tier": 3, "before_agent": "a", "after_agent": "b"},
                )
                self.assertEqual(st, 401)

                auth_hdr = {"Authorization": "Bearer secret-tok-123"}
                st, created = _http_json(
                    f"{base_url}/runs",
                    method="POST",
                    body={
                        "version": "1125",
                        "tier": 3,
                        "before_mode": "historical",
                        "after_agent": "aime-after-v2",
                    },
                    headers=auth_hdr,
                )
                self.assertEqual(st, 201)
                run_id = created["data"]["run_id"]

                self.assertTrue(
                    _wait_until(lambda: _http_json(f"{base_url}/runs/{run_id}")[1]["data"]["status"] == "running")
                )
                run_data = _http_json(f"{base_url}/runs/{run_id}")[1]["data"]
                # Historical before should already have 3 ready traces!
                self.assertEqual(run_data["sides_detail"]["before"]["ready"], 3)

                # Drop 1 trace file directly into .work/raw_traces/after/ (FileDrop mode)
                after_raw_dir = Path(run_data["round_dir_path"]) / ".work" / "raw_traces" / "after"
                (after_raw_dir / "part_01.jsonl").write_text(
                    json.dumps(_make_trace(run_id, "after", "eq_00001", "Target question 0")) + "\n",
                    encoding="utf-8",
                )
                self.assertTrue(
                    _wait_until(
                        lambda: _http_json(f"{base_url}/runs/{run_id}")[1]["data"]["sides_detail"]["after"]["ready"] == 1
                    )
                )

                # Cancel run mid-flight -> ready results must remain queryable!
                st, _ = _http_json(f"{base_url}/runs/{run_id}/cancel", method="POST", headers=auth_hdr)
                self.assertEqual(st, 200)
                self.assertTrue(
                    _wait_until(lambda: _http_json(f"{base_url}/runs/{run_id}")[1]["data"]["status"] == "cancelled")
                )
                res_after = _http_json(f"{base_url}/runs/{run_id}/results?side=after")[1]["data"]
                self.assertEqual(res_after["total"], 1)
                self.assertEqual(res_after["items"][0]["case_key"], "eq_00001")
            finally:
                app.pipeline.stop()
                srv.shutdown()
                srv.server_close()

    def test_real_vendored_eval_harness_prepare_smoke(self) -> None:
        """Smoke test the real vendored `eval_harness_pkg` prepare engine (Node.js) if Node >= 22.19."""
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
            ensure_vendor_on_path()
            from eval_harness.runner import check_node_runtime  # type: ignore

            try:
                check_node_runtime()
            except RuntimeError as exc:
                self.skipTest(f"Local Node runtime < 22.19: {exc}")

            raw_file = tmp / "raw.jsonl"
            raw_file.write_text(
                json.dumps(_make_trace("run_smoke", "after", "eq_00001", "What is AAPL PE ratio?")) + "\n",
                encoding="utf-8",
            )
            report = backend.prepare(
                raw_input_path=raw_file,
                output_path=tmp / "prepared.jsonl",
                audit_path=tmp / "audit.jsonl",
                batch_id="2026-11-24",
                version="smoke-v1",
            )
            self.assertEqual(report.get("passed", 0), 1)
            self.assertEqual(report.get("rejected", 0), 0)
            self.assertTrue((tmp / "prepared.jsonl").is_file())
            prepared_row = json.loads((tmp / "prepared.jsonl").read_text(encoding="utf-8").splitlines()[0])
            self.assertEqual(extract_case_key(prepared_row), "eq_00001")


if __name__ == "__main__":
    unittest.main()
