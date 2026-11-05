"""The standalone stats worker can replace the build's input scan."""
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

try:
    from dashboard.tests.test_empty_data import DASHBOARD, seed, write_jsonl
    from dashboard.tests.test_incremental import seed_lost
except ImportError:
    from test_empty_data import DASHBOARD, seed, write_jsonl
    from test_incremental import seed_lost


def run_build(datasets, static):
    proc = subprocess.run(
        [sys.executable, str(DASHBOARD / "build.py"), "--datasets", str(datasets),
         "--out", str(static), "--pairing", "key"],
        check=True, capture_output=True, text=True,
    )
    return json.loads(proc.stdout.strip().splitlines()[-1])


class SidecarTests(unittest.TestCase):
    def test_late_input_file_does_not_keep_stale_payload(self):
        """A day of input delivered after the payload was built must invalidate reuse.

        The stats worker can pre-scan the new file, so the build sees ``scanned == 0``;
        that must not be read as "input unchanged" (it used to freeze 评测输入 at 0).
        """
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            datasets, static = root / "datasets", root / "static"
            seed(datasets)
            first = run_build(datasets, static)
            self.assertEqual(first["scan_files"], 1, first)
            data = json.loads((static / "data-wencai.json").read_text())
            self.assertEqual(data["products"]["wencai"]["input"]["records"], 1)

            # Next day's input lands with no attribution for it; the tree cache is
            # stale (as in production until its TTL expires), so clear it to re-list.
            write_jsonl(datasets / "0_wencai/eval_input/a_fast/2026-11-02.jsonl", {
                "request_time": "2026-11-02 10:00:00", "case_id": "c2", "trace_id": "t2", "version": "a",
                "meta": {"session_id": "s2", "request_time": "2026-11-02 10:00:00",
                         "question": "茅台明天走势", "usage": {"input_tokens": 20, "output_tokens": 10}},
                "messages": [{"role": "user", "type": "message",
                              "content": [{"type": "input_text", "text": "茅台明天走势"}]}],
            })
            for stale in (DASHBOARD / "cache").glob("tree-in-wencai-*.json"):
                stale.unlink()
            subprocess.run(
                [sys.executable, str(DASHBOARD / "stats_worker.py"), "--datasets", str(datasets),
                 "--store", str(root / "stats-cache.sqlite3"), "--out", str(datasets / "stats.json"), "--once"],
                check=True, capture_output=True, text=True,
            )

            second = run_build(datasets, static)
            self.assertNotIn("reused", second, second)
            data = json.loads((static / "data-wencai.json").read_text())
            self.assertEqual(data["products"]["wencai"]["input"]["records"], 2)
            daily = {(r["d"], r["m"]): r for r in data["products"]["wencai"]["daily"]}
            self.assertEqual(daily[("2026-11-02", "a_fast")]["inputs"], 1)

    def test_build_uses_fresh_sidecar(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            datasets, static = root / "datasets", root / "static"
            seed(datasets)
            seed_lost(datasets)
            subprocess.run(
                [sys.executable, str(DASHBOARD / "stats_worker.py"), "--datasets", str(datasets),
                 "--store", str(root / "stats-cache.sqlite3"), "--out", str(datasets / "stats.json"),
                 "--once"],
                check=True, capture_output=True, text=True,
            )
            proc = subprocess.run(
                [sys.executable, str(DASHBOARD / "build.py"), "--datasets", str(datasets),
                 "--out", str(static), "--pairing", "key"],
                check=True, capture_output=True, text=True,
            )
            summary = json.loads(proc.stdout.strip().splitlines()[-1])
            self.assertEqual(summary["scan_scanned"], 0, summary)
            data = json.loads((static / "data-wencai.json").read_text())
            self.assertEqual(data["products"]["wencai"]["input"]["lost"], 1)


if __name__ == "__main__":
    unittest.main()
