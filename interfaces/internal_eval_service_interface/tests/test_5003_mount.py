"""Regression test verifying mounting onto eval_data_interface (port 5003)."""

from __future__ import annotations

import json
import sys
import tempfile
import threading
import unittest
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ANALYSIS_ROOT = ROOT.parent / "eval_data_interface"
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ANALYSIS_ROOT))

from analysis_api import server as analysis_server  # type: ignore
from internal_eval.api import InternalEvalApp
from internal_eval.collectors import FileDropCollectorAdapter
from internal_eval.config import ServiceConfig
from internal_eval.pipeline import PipelineManager
from internal_eval.state_store import StateStore
from tests.test_pipeline_e2e import FakeStreamingEngine
from tests.test_unit import _write_fake_bench


class MountOn5003Tests(unittest.TestCase):
    def test_coexistence_on_5003_server(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            _write_fake_bench(tmp / "3_dynamic_bench", count=3)
            cfg = ServiceConfig(
                datasets_root=tmp,
                ab_test_root=tmp / "1_aime" / "ab_test",
                bench_root=tmp / "3_dynamic_bench",
                state_db_path=tmp / "1_aime" / "ab_test" / ".service_state" / "internal_eval.sqlite3",
                base_taxonomy_dir=ROOT / "vendor" / "cluster_pkg" / "builtin_taxonomy",
                allow_custom_tier=True,
                collector_poll_interval_sec=0.05,
            )
            store = StateStore(cfg.state_db_path)
            pipeline = PipelineManager(
                cfg,
                store,
                engine=FakeStreamingEngine(),
                collector=FileDropCollectorAdapter(cfg),
                start_worker=False,
            )
            mounted = InternalEvalApp(cfg, store, pipeline)
            prev_mounted = analysis_server.INTERNAL_EVAL_APP
            analysis_server.mount_internal_eval(mounted)

            srv = analysis_server.Server(("127.0.0.1", 0), analysis_server.Handler)
            t = threading.Thread(target=srv.serve_forever, daemon=True)
            t.start()
            port = srv.server_address[1]
            try:
                # 1) Existing 5003 /healthz untouched
                with urllib.request.urlopen(f"http://127.0.0.1:{port}/healthz", timeout=5) as resp:
                    self.assertEqual(resp.status, 200)
                    data = json.loads(resp.read().decode("utf-8"))
                    self.assertIn("dataset", data)

                # 2) Existing 5003 /api/v1/analysis/docs untouched
                with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/v1/analysis/docs", timeout=5) as resp:
                    self.assertEqual(resp.status, 200)
                    data = json.loads(resp.read().decode("utf-8"))
                    self.assertIn("docs", data["data"])

                # 3) Mounted /api/v1/internal-eval/healthz & /docs & POST /runs work cleanly!
                with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/v1/internal-eval/healthz", timeout=5) as resp:
                    self.assertEqual(resp.status, 200)
                    data = json.loads(resp.read().decode("utf-8"))
                    self.assertTrue(data["data"]["ok"])

                req = urllib.request.Request(
                    f"http://127.0.0.1:{port}/api/v1/internal-eval/runs",
                    data=json.dumps({"version": "1124", "tier": 3, "before_agent": "old", "after_agent": "new"}).encode("utf-8"),
                    headers={"Content-Type": "application/json"},
                    method="POST",
                )
                with urllib.request.urlopen(req, timeout=5) as resp:
                    self.assertEqual(resp.status, 201)
                    created = json.loads(resp.read().decode("utf-8"))
                    self.assertEqual(created["data"]["status"], "queued")
            finally:
                analysis_server.INTERNAL_EVAL_APP = prev_mounted
                srv.shutdown()
                srv.server_close()


if __name__ == "__main__":
    unittest.main()
