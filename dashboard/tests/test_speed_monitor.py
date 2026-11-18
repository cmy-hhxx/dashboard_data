"""Speed monitor & live gateway telemetry tests."""
import http.client
import json
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

DASHBOARD = Path(__file__).resolve().parents[1]
if str(DASHBOARD) not in sys.path:
    sys.path.insert(0, str(DASHBOARD))

import speed_monitor  # noqa: E402
import server  # noqa: E402


class InputCountTests(unittest.TestCase):
    """Counting must stop at the last complete line and keep sessions distinct."""

    def test_counts_only_complete_lines(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "2026-11-18.jsonl"
            rows = [
                {"meta": {"session_id": "s1"}, "traces": [{"a": 1}, {"b": 2}]},
                {"meta": {"session_id": "s1"}, "traces": [{"c": 3}]},
                {"meta": {"session_id": "s2"}, "traces": [{"d": 4}]},
            ]
            complete = "".join(json.dumps(r) + "\n" for r in rows).encode()
            path.write_bytes(complete + b'{"meta": {"session_id": "s3"')
            counts = speed_monitor._count_local_input_files([(str(path), 0)])[str(path)]
            self.assertEqual(counts["lines"], 3)
            self.assertEqual(counts["traces"], 4)
            self.assertEqual(counts["sessions"], ["s1", "s2"])
            self.assertEqual(counts["used"], len(complete))
            # Appending the rest counts only the new part.
            path.write_bytes(complete + b'{"meta": {"session_id": "s3"}, "traces": []}\n')
            more = speed_monitor._count_local_input_files([(str(path), counts["used"])])[str(path)]
            self.assertEqual(more["lines"], 1)
            self.assertEqual(more["sessions"], ["s3"])
            self.assertEqual(more["used"], len(b'{"meta": {"session_id": "s3"}, "traces": []}\n'))


class _MockGateway(BaseHTTPRequestHandler):
    def do_GET(self):
        auth = self.headers.get("Authorization")
        if auth != "Bearer secret-test-key":
            self.send_response(401)
            self.end_headers()
            return
        if self.path == "/ai-gateway/v1/models":
            body = json.dumps({"data": [{"id": "deepseek-v4.1-flash"}]}).encode()
        elif self.path == "/ai-gateway/key/info":
            body = json.dumps({
                "info": {
                    "last_active": "2026-11-18T04:20:00+00:00",
                    "soft_budget_cooldown": False,
                    "blocked": False,
                    "models": ["deepseek-v4.1-flash"],
                    "metadata": {
                        "maas_qos": {
                            "workload": "online",
                            "models": {
                                "deepseek-v4.1-flash": {
                                    "rules": [{
                                        "windows": [{"start": "00:00", "end": "24:00", "rpm": 500}],
                                    }],
                                },
                            },
                        },
                    },
                },
            }).encode()
        else:
            self.send_response(404)
            self.end_headers()
            return
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        pass


class SpeedMonitorTests(unittest.TestCase):
    def tearDown(self):
        speed_monitor.reset_for_test()

    def test_local_collection_live_gateway_rpm_parts_and_locks(self):
        gw = ThreadingHTTPServer(("127.0.0.1", 0), _MockGateway)
        gw_thread = threading.Thread(target=gw.serve_forever, daemon=True)
        gw_thread.start()
        try:
            port = gw.server_address[1]
            gw_base = f"http://127.0.0.1:{port}/ai-gateway/v1"
            with tempfile.TemporaryDirectory() as folder:
                root = Path(folder)
                in_root = root / "eval_input/0_daily_eval_input/aime_fast"
                out_root = root / "eval_output/0_daily_eval"
                chunk_root = root / "eval_input/0_daily_eval_chunks/aime_fast/2026-11-18"
                runtime_root = root / "runtime"
                cache_dir = root / "cache"
                in_root.mkdir(parents=True)
                (out_root / "aime_fast/compact").mkdir(parents=True)
                (out_root / ".keys/aime_fast").mkdir(parents=True)
                (out_root / ".orchestrator/queue").mkdir(parents=True)
                (out_root / ".orchestrator/locks/aime_fast__2026-11-18.c000001").mkdir(parents=True)
                (out_root / ".parts/aime_fast/aime_fast_attribution-2026-11-18.jsonl").mkdir(parents=True)
                (out_root / ".parts/aime_fast/compact/aime_fast_compact-2026-11-18.jsonl").mkdir(parents=True)
                chunk_root.mkdir(parents=True)
                (runtime_root / "orchestrator-state").mkdir(parents=True)
                (runtime_root / "config").mkdir(parents=True)

                # Input + output + keys
                (in_root / "2026-11-18.jsonl").write_text(
                    json.dumps({"meta": {"session_id": "s1"}, "traces": [{"id": "t1"}, {"id": "t2"}]}) + "\n",
                    encoding="utf-8",
                )
                (out_root / "aime_fast/aime_fast_attribution-2026-11-18.jsonl").write_text(
                    json.dumps({
                        "session_meta": {"session_id": "s1"},
                        "turns": [{"meta": {"trace_id": "t1"}, "problem": [{"p": 1}]}],
                    }) + "\n",
                    encoding="utf-8",
                )
                (out_root / "aime_fast/compact/aime_fast_compact-2026-11-18.jsonl").write_text(
                    json.dumps({"session_meta": {"session_id": "s1"}, "turns": [{"components": ["a"]}]}) + "\n",
                    encoding="utf-8",
                )
                (out_root / ".keys/aime_fast/attr.keys").write_text(
                    json.dumps(["s1", ["t1"]]) + "\n", encoding="utf-8",
                )
                (chunk_root / "000001.jsonl").write_text("{}\n", encoding="utf-8")
                (chunk_root / "000002.jsonl").write_text("{}\n", encoding="utf-8")
                (out_root / ".orchestrator/queue/aime_fast__2026-11-18.c000001.state").write_text(
                    "1:1\nrunning\n0\n", encoding="utf-8",
                )
                (out_root / ".orchestrator/queue/aime_fast__2026-11-18.c000002.state").write_text(
                    "1:1\n0\n0\n", encoding="utf-8",
                )
                lock_dir = out_root / ".orchestrator/locks/aime_fast__2026-11-18.c000001"
                (lock_dir / "owner").write_text("2", encoding="utf-8")
                (lock_dir / "created").write_text(str(int(time.time() - 90)), encoding="utf-8")
                (lock_dir / "heartbeat").write_text("", encoding="utf-8")

                # Gateway & control files
                (runtime_root / "orchestrator-state/gateway-health.json").write_text(json.dumps({
                    "healthy": [gw_base],
                    "assignments": {"channel.evaluation-gateway": gw_base},
                }), encoding="utf-8")
                (runtime_root / "control.json").write_text(json.dumps({
                    "concurrency": 34, "modelRequests": 17, "heavyModelRequests": 4,
                    "compactBacklog": 3, "paused": False, "channels": {"evaluation-gateway": 17},
                }), encoding="utf-8")
                (runtime_root / "rpm-limit.json").write_text(json.dumps({
                    "rpm": 500, "permits": 17, "updated_at": "2026-11-18T04:22:28Z",
                }), encoding="utf-8")
                (runtime_root / "config/config.ini").write_text(
                    f"[channel.evaluation-gateway]\nbase_url = {gw_base}\napi_key = secret-test-key\nmodels = deepseek-v4.1-flash\n",
                    encoding="utf-8",
                )

                # Seed v5 stats cache to verify __total normalization
                cache_dir.mkdir(parents=True)
                (cache_dir / "speed_stats.json").write_text(json.dumps({
                    "version": 5,
                    "history": [
                        {"t": time.time() - 320, "a": 100, "c": 100, "k": 200},
                        {"t": time.time() - 20, "a": 110, "c": 110, "k": 220},
                    ],
                }), encoding="utf-8")

                speed_monitor.reset_for_test(cache_dir, {
                    "output_root": str(out_root),
                    "input_root": str(root / "eval_input/0_daily_eval_input"),
                    "chunk_root": str(root / "eval_input/0_daily_eval_chunks"),
                    "lost_input_root": str(root / "eval_input/1_lost_user_eval"),
                    "lost_output_root": str(root / "eval_output/1_lost_user_eval"),
                    "cluster_root": str(root / "eval_output/cluster"),
                    "runtime_root": str(runtime_root),
                    "gateway_state": str(runtime_root / "orchestrator-state/gateway-health.json"),
                    "conf_ini": str(runtime_root / "config/config.ini"),
                })
                speed_monitor._load_stats()
                speed_monitor.refresh_inputs()
                speed_monitor.collect_outputs()

                # Append live .parts rows and simulate 30s elapsed since seed
                with speed_monitor._LOCK:
                    speed_monitor._STATE["parts_seeded_at"] = time.time() - 30.0
                attr_part = out_root / ".parts/aime_fast/aime_fast_attribution-2026-11-18.jsonl/w0.jsonl"
                comp_part = out_root / ".parts/aime_fast/compact/aime_fast_compact-2026-11-18.jsonl/w0.jsonl"
                attr_part.write_text(json.dumps({"turns": [{"problem": [1, 2]}]}) + "\n", encoding="utf-8")
                comp_part.write_text(json.dumps({"turns": [{"components": ["a", "b", "c"]}]}) + "\n", encoding="utf-8")

                speed_monitor.collect_outputs()
                data = speed_monitor.payload()

                self.assertTrue(data["available"])
                self.assertTrue(data["ok"])
                self.assertEqual((data["input_sessions"], data["input_traces"]), (1, 2))
                self.assertEqual((data["attr_sessions"], data["attr_traces"]), (1, 1))
                self.assertEqual((data["queue"]["done"], data["queue"]["running"]), (1, 1))
                self.assertEqual(len(data["queue"]["locks"]), 1)
                self.assertEqual(data["queue"]["locks"][0]["owner"], "2")

                gw_block = data["gateways"]
                self.assertEqual((gw_block["count"], gw_block["healthy"], gw_block["rpm_limit"]), (1, 1, 500))
                # 限额必须标成来自 key 的实时值，而不是 harness 的 rpm-limit.json 缓存。
                self.assertEqual(gw_block["rpm_source"], "key")
                self.assertEqual(gw_block["items"][0]["rpm_source"], "key")
                self.assertGreater(gw_block["realtime_rpm"], 0)
                self.assertGreater(gw_block["parts_attr_rate"], 0)
                self.assertGreater(gw_block["parts_compact_rate"], 0)
                self.assertEqual(gw_block["active_writers"], 2)
                self.assertEqual(gw_block["control"]["model_requests"], 17)
                item = gw_block["items"][0]
                self.assertEqual(item["code"], 200)
                self.assertTrue(item["healthy"])
                self.assertEqual(item["models"], ["deepseek-v4.1-flash"])
                self.assertIsNotNone(item["latency_ms"])
                self.assertIsNotNone(item["active_ago_s"])
                self.assertTrue(len(data["rpm_history"]) >= 1)
        finally:
            gw.shutdown()
            gw.server_close()

    def test_server_serves_speed_json_no_store_with_cors(self):
        speed_monitor.reset_for_test()
        httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        try:
            conn = http.client.HTTPConnection("127.0.0.1", httpd.server_address[1], timeout=5)
            conn.request("GET", "/speed.json")
            res = conn.getresponse()
            body = json.loads(res.read())
            self.assertEqual(res.status, 200)
            self.assertEqual(res.getheader("Cache-Control"), "no-store")
            self.assertEqual(res.getheader("Access-Control-Allow-Origin"), "*")
            self.assertIn("available", body)
            conn.close()
        finally:
            httpd.shutdown()
            httpd.server_close()


if __name__ == "__main__":
    unittest.main()
