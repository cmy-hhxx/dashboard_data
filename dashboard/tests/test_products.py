"""Split deployments: EVAL_PRODUCTS limits a copy to its product; AIME lost-user input without the archive."""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

try:
    from dashboard.tests.test_empty_data import DASHBOARD, seed
except ImportError:  # `cd dashboard && python3 -m unittest discover -s tests`
    from test_empty_data import DASHBOARD, seed


def as_aime(datasets, split="0_daily_eval", input_dir="0_daily_eval_input"):
    """Copy the seeded wencai a_fast session into 1_aime as aime_fast."""
    src_out = datasets / "0_wencai/eval_output/0_daily_eval/a_fast"
    out = datasets / "1_aime/eval_output" / split / "aime_fast"
    inp = datasets / "1_aime/eval_input" / input_dir / "aime_fast/2026-11-01.jsonl"
    (out / "compact").mkdir(parents=True, exist_ok=True)
    inp.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy(datasets / "0_wencai/eval_input/a_fast/2026-11-01.jsonl", inp)
    shutil.copy(src_out / "a_fast_attribution-2026-11-01.jsonl", out / "aime_fast_attribution-2026-11-01.jsonl")
    shutil.copy(src_out / "compact/a_fast_compact-2026-11-01.jsonl", out / "compact/aime_fast_compact-2026-11-01.jsonl")
    return inp


def build(datasets, static, **env):
    subprocess.run([sys.executable, str(DASHBOARD / "build.py"), "--datasets", str(datasets), "--out", str(static)],
                   check=True, capture_output=True, text=True, env={**os.environ, **env})
    return json.loads((static / "data.json").read_text())


class ProductSplitTests(unittest.TestCase):
    def test_eval_products_limits_a_copy_to_its_product(self):
        with tempfile.TemporaryDirectory() as folder:
            datasets, static = Path(folder) / "datasets", Path(folder) / "static"
            seed(datasets)
            as_aime(datasets)
            self.assertEqual(sorted(build(datasets, static)["products"]), ["aime", "wencai"])
            data = build(datasets, static, EVAL_PRODUCTS="wencai")
            self.assertEqual(list(data["products"]), ["wencai"])
            self.assertEqual(list(json.loads((static / "samples.json").read_text())["products"]), ["wencai"])
            self.assertFalse((static / "data-aime.json").exists())
            self.assertFalse((static / "samples-aime.json").exists())

    def test_unknown_product_fails_loudly(self):
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaises(subprocess.CalledProcessError):
                build(Path(folder), Path(folder) / "static", EVAL_PRODUCTS="wencia")

    def test_aime_lost_user_input_counts_without_archive(self):
        with tempfile.TemporaryDirectory() as folder:
            datasets, static = Path(folder) / "datasets", Path(folder) / "static"
            seed(datasets)
            inp = as_aime(datasets, "1_lost_user_eval", "1_lost_user_eval")
            volume = lambda: json.loads((static / "data-aime.json").read_text())["products"]["aime"]["input"]
            build(datasets, static, EVAL_PRODUCTS="aime")
            self.assertEqual((volume()["records"], volume()["lost"]), (1, 1))
            # With the archive present the eval folder is the partial copy again: counted once, not twice.
            archive = datasets / "1_aime/.archive/1_lost_user_input/aime_fast/2026-11-01.jsonl"
            archive.parent.mkdir(parents=True)
            shutil.copy(inp, archive)
            build(datasets, static, EVAL_PRODUCTS="aime")
            self.assertEqual((volume()["records"], volume()["lost"]), (1, 1))


if __name__ == "__main__":
    unittest.main()
