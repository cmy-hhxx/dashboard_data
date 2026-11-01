"""Exercise the real generation scripts without persistent sample datasets."""
import gzip
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


DASHBOARD = Path(__file__).resolve().parents[1]
REPO = DASHBOARD.parent


class EmptyDataTests(unittest.TestCase):
    def run_script(self, script, *args, datasets):
        subprocess.run(
            [sys.executable, str(DASHBOARD / script), *map(str, args)],
            env={**os.environ, "EVAL_DATASETS": str(datasets)},
            check=True, capture_output=True, text=True,
        )

    def test_local_root_waits_for_repository_datasets(self):
        env = {**os.environ, "REPO_ROOT": str(REPO), "DASHBOARD": str(DASHBOARD)}
        env.pop("EVAL_DATASETS", None)
        actual = subprocess.check_output(
            ["bash", "-c", 'source "$DASHBOARD/local_dev/env.sh"; resolve_datasets'],
            env=env, text=True,
        ).strip()
        self.assertEqual(actual, str(REPO / "datasets"))

    def test_pipeline_moves_between_empty_and_supplied_inputs(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            datasets = root / "datasets"
            counts = root / "cache" / "datasets.json"
            output = root / "static" / "data.json"

            def generate():
                self.run_script("scan_datasets.py", "--data", datasets, "--out", counts, datasets=datasets)
                self.run_script("prepare.py", "--counts", counts, "--out", output, datasets=datasets)
                payload = json.loads(output.read_text())
                self.assertEqual(json.loads(gzip.decompress(Path(str(output) + ".gz").read_bytes())), payload)
                return payload

            empty = generate()
            for product in ("wencai", "aime"):
                self.assertEqual(empty[product]["input"]["total"], 0)
                self.assertEqual(empty[product]["output"]["answers"], 0)
                self.assertFalse((empty[product].get("cluster") or {}).get("tree"))
            self.assertFalse(datasets.exists())

            supplied = datasets / "0_wencai" / "eval_input" / "a_fast" / "2026-11-01.jsonl"
            supplied.parent.mkdir(parents=True)
            supplied.write_text(json.dumps({"meta": {"task": "行情", "subtask": "价格"}}, ensure_ascii=False) + "\n")
            self.assertEqual(generate()["wencai"]["input"]["total"], 1)
            supplied.unlink()
            self.assertEqual(generate()["wencai"]["input"]["total"], 0)

    def test_empty_source_replaces_stale_sample_index_and_details(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            output = root / "static" / "samples.json"
            details = output.parent / "samples"
            details.mkdir(parents=True)
            output.write_text(json.dumps({"totals": {"samples": 1}}))
            stale = details / "stale.json"
            stale.write_text("{}")
            Path(str(stale) + ".gz").write_bytes(gzip.compress(b"{}"))
            self.run_script("prepare_samples.py", "--datasets", root / "datasets", "--out", output, datasets=root / "datasets")
            payload = json.loads(output.read_text())
            self.assertEqual(payload["totals"]["samples"], 0)
            for product in ("wencai", "aime"):
                self.assertEqual(payload["products"][product]["samples"], [])
            self.assertEqual(list(details.iterdir()), [])
            self.assertEqual(json.loads(gzip.decompress(Path(str(output) + ".gz").read_bytes())), payload)


if __name__ == "__main__":
    unittest.main()
