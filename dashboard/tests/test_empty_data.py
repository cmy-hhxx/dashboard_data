"""Exercise build.py end to end on tiny synthetic datasets (no real data needed)."""
import gzip
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


DASHBOARD = Path(__file__).resolve().parents[1]
REPO = DASHBOARD.parent
REQ = "2026-11-01 10:00:00"
ANSWER = "茅台今天收盘价为1500元。"


def write_jsonl(path, *rows):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows), encoding="utf-8")


def seed(root):
    """One wencai a_fast session: input + attribution (one P1 problem) + compact."""
    meta = {"session_id": "s1", "request_time": REQ, "question": "茅台今天收盘价"}
    write_jsonl(root / "0_wencai/eval_input/a_fast/2026-11-01.jsonl", {
        "request_time": REQ, "case_id": "c1", "trace_id": "t1", "version": "a", "meta": meta,
        "messages": [
            {"role": "user", "type": "message", "content": [{"type": "input_text", "text": "茅台今天收盘价"}]},
            {"role": "assistant", "type": "message", "content": [{"type": "output_text", "text": ANSWER}]},
        ],
    })
    out = root / "0_wencai/eval_output/0_daily_eval/a_fast"
    write_jsonl(out / "a_fast_attribution-2026-11-01.jsonl", {
        "session_meta": meta, "session_summary": "收盘价取错", "session_problem": [],
        "turns": [{"meta": {}, "summary": "取值错误", "is_correct": False, "problem": [{
            "label": "收盘价取值错误", "severity": "P1", "component": "answer", "component_family": "取值",
            "component_role": "delivery", "reason": "与行情不符",
            "evidence": [{"position": "trace_index 0 / message_index 1 / path content[0].text",
                          "quote": "1500元", "reason": "收盘价不对"}],
        }]}],
    })
    write_jsonl(out / "compact/a_fast_compact-2026-11-01.jsonl", {
        "session_meta": meta, "session_overview": ["查询收盘价"],
        "turns": [{"turn_idx": 0, "plans": [{"content": "查收盘价", "evidence": []}]}],
    })


class BuildTests(unittest.TestCase):
    def build(self, datasets, static, *extra):
        proc = subprocess.run(
            [sys.executable, str(DASHBOARD / "build.py"), "--datasets", str(datasets), "--out", str(static), *extra],
            check=True, capture_output=True, text=True,
        )
        summary = json.loads(proc.stdout.strip().splitlines()[-1])
        data = json.loads((static / "data.json").read_text())
        index = json.loads((static / "samples.json").read_text())
        for name, payload in (("data.json", data), ("samples.json", index)):
            self.assertEqual(json.loads(gzip.decompress((static / f"{name}.gz").read_bytes())), payload)
        return summary, data, index

    def test_local_root_waits_for_repository_datasets(self):
        env = {**os.environ, "REPO_ROOT": str(REPO), "DASHBOARD": str(DASHBOARD)}
        env.pop("EVAL_DATASETS", None)
        actual = subprocess.check_output(
            ["bash", "-c", 'source "$DASHBOARD/local_dev/env.sh"; resolve_datasets'], env=env, text=True,
        ).strip()
        self.assertEqual(actual, str(REPO / "datasets"))

    def test_build_moves_between_supplied_and_empty_sources(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            datasets, static = root / "datasets", root / "static"
            seed(datasets)

            _, data, index = self.build(datasets, static)
            self.assertEqual(data["source"]["pairs"], 1)
            self.assertEqual(data["products"]["wencai"]["kpi"]["problems"], 1)
            row = index["products"]["wencai"]["rows"][0]
            self.assertEqual((row["w"], row["n"], row["m"]), ("P1", 1, "a_fast"))
            detail = json.loads((static / "samples" / f"{row['s']}.json").read_text())
            ev = detail["evidence"][detail["attribution"]["problems"][0]["ev"][0]]
            self.assertEqual((ev["t"], ev["m"]), (0, 1))
            self.assertIn("o", ev)
            self.assertEqual(detail["compact"]["overview"], ["查询收盘价"])

            # A briefly empty source must not wipe the board on scheduled refreshes...
            shutil.rmtree(datasets)
            summary, data, _ = self.build(datasets, static, "--keep-on-empty")
            self.assertEqual(summary.get("kept_previous"), 1)
            self.assertEqual(data["source"]["pairs"], 1)
            self.assertTrue((static / "samples" / f"{row['s']}.json").exists())

            # ...but an explicit build replaces the payloads and clears stale details.
            _, data, index = self.build(datasets, static)
            self.assertEqual(data["source"]["pairs"], 0)
            self.assertEqual(data["products"], {})
            self.assertEqual(index["products"], {})
            self.assertEqual(list((static / "samples").iterdir()), [])
            self.assertEqual([p.name for p in static.iterdir() if p.name.startswith(".samples")], [])


if __name__ == "__main__":
    unittest.main()
