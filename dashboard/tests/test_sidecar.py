"""The standalone stats worker can replace the build's input scan."""
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

try:
    from dashboard.tests.test_empty_data import DASHBOARD, seed
    from dashboard.tests.test_incremental import seed_lost
except ImportError:
    from test_empty_data import DASHBOARD, seed
    from test_incremental import seed_lost


class SidecarTests(unittest.TestCase):
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
