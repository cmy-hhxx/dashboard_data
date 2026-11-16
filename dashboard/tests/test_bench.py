"""Bench's two lists: the pipeline split when present, this build's cases otherwise."""
import json
import sys
import tempfile
import unittest
from pathlib import Path

DASHBOARD = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(DASHBOARD))
import build  # noqa: E402


def write_jsonl(path, rows):
    path.write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows), encoding="utf-8")


def case(cid, trace, sev, n, when, counts=None):
    return {
        "bad_case_id": cid, "trace_id": trace, "question": f"问：{cid}", "model": "a_fast",
        "request_time": when, "severity": sev, "severity_counts": counts or {},
        "problem_count": n, "session_id": f"s-{cid}",
    }


class BenchPayloadTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp())

    def test_split_files_are_filtered_and_ordered(self):
        write_jsonl(self.root / "goldencase_aime.jsonl", [
            case("g1", "t1", "", 0, "2026-11-02T01:00:00Z"),
            case("g2", "t2", "", 0, "2026-11-03T01:00:00Z"),
            case("gX", "tx", "P2", 2, "2026-11-04T01:00:00Z"),      # not clean → dropped
        ])
        write_jsonl(self.root / "badcase_aime.jsonl", [
            case("b1", "t3", "P1", 2, "2026-11-02T01:00:00Z", {"P1": 1, "P3": 1}),
            case("b2", "t4", "P0", 1, "2026-11-01T01:00:00Z", {"P0": 1}),
            case("b3", "t5", "P2", 1, "2026-11-05T01:00:00Z"),      # P2 → not a Bench badcase
        ])
        payload = build.bench_payload(self.root, "aime", [], {"t1": "slug-g1", "t3": "slug-b1"})
        golden = payload["rows"]["golden"]
        bad = payload["rows"]["bad"]
        self.assertEqual([r["i"] for r in golden], ["g2", "g1"])
        self.assertEqual([r["i"] for r in bad], ["b2", "b1"])
        self.assertEqual(golden[1]["s"], "slug-g1")
        self.assertEqual(bad[1]["s"], "slug-b1")
        self.assertIsNone(golden[0]["s"])
        self.assertEqual(payload["kinds"]["golden"]["count"], 2)
        self.assertEqual(payload["kinds"]["bad"]["count"], 2)
        self.assertEqual(payload["kinds"]["bad"]["sev"], {"P0": 1, "P1": 1})
        self.assertNotIn("t", golden[0])

    def test_falls_back_to_the_builds_own_cases(self):
        samples = [
            ("clean", {}, {"w": "none", "n": 0, "q": "干净的题", "m": "a_fast", "d": "2026-11-01",
                           "sv": [0, 0, 0, 0, 0], "sid": "s1"}, {}),
            ("p1", {}, {"w": "P1", "n": 2, "q": "有 P1", "m": "a_fast", "d": "2026-11-02",
                        "sv": [0, 1, 1, 0, 0], "sid": "s2"}, {}),
            ("p2", {}, {"w": "P2", "n": 1, "q": "只有 P2", "m": "a_fast", "d": "2026-11-03",
                        "sv": [0, 0, 1, 0, 0], "sid": "s3"}, {}),
        ]
        payload = build.bench_payload(self.root, "wencai", samples, {})
        self.assertEqual([r["i"] for r in payload["rows"]["golden"]], ["clean"])
        self.assertEqual([r["i"] for r in payload["rows"]["bad"]], ["p1"])
        self.assertEqual(payload["rows"]["bad"][0]["c"], {"P1": 1, "P2": 1})
        self.assertEqual(payload["rows"]["bad"][0]["s"], "p1")

    def test_one_missing_file_falls_back_for_both_lists(self):
        write_jsonl(self.root / "goldencase_aime.jsonl", [case("g1", "t1", "", 0, "2026-11-02T01:00:00Z")])
        samples = [("p1", {}, {"w": "P1", "n": 1, "q": "bad", "m": "m", "d": "2026-11-02",
                               "sv": [0, 1, 0, 0, 0], "sid": "s"}, {})]
        payload = build.bench_payload(self.root, "aime", samples, {})
        self.assertEqual(payload["kinds"]["golden"]["count"], 0)
        self.assertEqual(payload["kinds"]["bad"]["count"], 1)


if __name__ == "__main__":
    unittest.main()
