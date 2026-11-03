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
sys.path.insert(0, str(DASHBOARD))
REQ = "2026-11-01 10:00:00"
ANSWER = "茅台今天收盘价为1500元。"


def write_jsonl(path, *rows):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows), encoding="utf-8")


def seed(root):
    """One wencai a_fast session: input + attribution (one P1 problem) + compact."""
    meta = {"session_id": "s1", "request_time": REQ, "question": "茅台今天收盘价",
            "usage": {"input_tokens": 100, "output_tokens": 50}}
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
        shared = json.loads((static / "data.json").read_text())
        data = {**shared, "products": {}}
        for product, _ in shared["products"].items():
            payload = json.loads((static / f"data-{product}.json").read_text())
            self.assertEqual(json.loads(gzip.decompress((static / f"data-{product}.json.gz").read_bytes())), payload)
            data["products"][product] = payload["products"][product]
        manifest = json.loads((static / "samples.json").read_text())
        index = {"products": {}}
        for product, meta in manifest["products"].items():
            payload = json.loads((static / f"samples-{product}.json").read_text())
            self.assertEqual(json.loads(gzip.decompress((static / f"samples-{product}.json.gz").read_bytes())), payload)
            index["products"][product] = payload["products"][product]
        self.assertEqual(json.loads(gzip.decompress((static / "samples.json.gz").read_bytes())), manifest)
        self.assertEqual(json.loads(gzip.decompress((static / "data.json.gz").read_bytes())), shared)
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
            kpi = data["products"]["wencai"]["kpi"]
            self.assertEqual(kpi["problems"], 1)
            self.assertEqual((kpi["unique_sessions"], kpi["traces"], kpi["tokens"]), (1, 1, 150))
            daily = data["products"]["wencai"]["daily"][0]
            self.assertEqual((daily["sessions"], daily["traces"], daily["tokens"], daily["sids"]), (1, 1, 150, ["s1"]))
            row = index["products"]["wencai"]["rows"][0]
            self.assertEqual((row["w"], row["n"], row["m"]), ("P1", 1, "a_fast"))
            from detail_builder import DetailBuilder
            builder = DetailBuilder(datasets, static.parent / "cache" / "build.sqlite3",
                                    static / "samples", static.parent / "cache")
            detail_path = builder.ensure(row["s"])
            self.assertIsNotNone(detail_path)
            detail = json.loads(Path(detail_path).read_text())
            builder.close()
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
