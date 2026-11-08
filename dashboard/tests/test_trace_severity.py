"""Trace severity is exclusive and cannot be reconstructed from Session hits."""
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import build


class TraceSeverityTests(unittest.TestCase):
    def detail(self, ids, problems=(), evidence=()):
        return {
            "meta": {}, "question": "test",
            "input": {"traces": [{"trace_id": tid} for tid in ids]},
            "attribution": {
                "turns": [{"trace_id": tid} for tid in ids],
                "problems": [{"turn": turn, "sev": sev, "ev": ev, "cl": None}
                             for turn, sev, ev in problems],
            },
            "evidence": list(evidence),
        }

    def test_multilabel_trace_counts_once_at_worst_level_and_includes_clean(self):
        detail = self.detail(["a", "b", "c"], [(0, "P2", []), (0, "P0", []),
                                                (0, "P1", []), (1, "P4", [])])
        self.assertEqual(build.trace_severity(detail), {"counts": [1, 0, 0, 0, 1, 1], "unresolved": 0})

    def test_repeated_attribution_turns_of_same_trace_share_one_bin(self):
        detail = self.detail(["a", "a", "b"], [(0, "P3", []), (1, "P1", [])])
        self.assertEqual(build.trace_severity(detail)["counts"], [0, 1, 0, 0, 0, 1])
        trace = build.trace_severity(detail, include_refs=True)
        self.assertEqual(trace["refs"], [[0, 1, "a"], [2, 5, "b"]])
        self.assertEqual(len(trace["refs"]), sum(trace["counts"]))

    def test_session_problem_uses_evidence_trace_id_not_turn_order(self):
        detail = self.detail(["a", "b"], [(None, "P2", [0])], [{"t": 0}])
        detail["input"]["traces"].reverse()
        detail["attribution"]["problems"].append({"turn": 0, "sev": "P0", "ev": [], "cl": None})
        self.assertEqual(build.trace_severity(detail)["counts"], [1, 0, 1, 0, 0, 0])

    def test_unlocated_session_problem_does_not_create_false_clean_traces(self):
        detail = self.detail(["a", "b"], [(None, "P2", []), (0, "P0", [])])
        self.assertEqual(build.trace_severity(detail), {"counts": [1, 0, 0, 0, 0, 0], "unresolved": 1})
        self.assertEqual(build.trace_severity(detail, include_refs=True)["refs"], [[0, 0, "a"]])

    def test_unassessed_input_is_not_a_clean_trace(self):
        detail = self.detail(["a"])
        detail["attribution"]["turns"] = []
        self.assertEqual(sum(build.trace_severity(detail)["counts"]), 0)

    def test_payload_preserves_trace_counts_across_slimming_and_dates(self):
        first = self.detail(["a", "b"], [(0, "P0", []), (0, "P1", [])])
        second = self.detail(["c"], [(0, "P4", [])])
        samples = [("s1", build.slim_detail(first), {"d": "2026-11-01", "m": "a_fast"}, {}),
                   ("s2", build.slim_detail(second), {"d": "2026-11-02", "m": "a_fast"}, {})]
        trace = build.trend_payload("wencai", samples)["trace_severity"]
        self.assertEqual(trace["levels"], ["P0", "P1", "P2", "P3", "P4", "none"])
        self.assertEqual(trace["daily"], [[1, 0, 0, 0, 0, 1], [0, 0, 0, 0, 1, 0]])
        self.assertEqual(trace["unresolved"], 0)
        self.assertEqual(trace["refs"], [[0, "s1", 0, 0, "a"], [0, "s1", 1, 5, "b"], [1, "s2", 0, 4, "c"]])


if __name__ == "__main__":
    unittest.main()
