"""Current-tree mapping for retired problem codes.

The cluster tree can drop a level-4 leaf while keeping its level-3 parent.  The API must keep
the stored code for diagnosis but expose the current code/label, and old codes must still be
usable as filters.
"""

import sys
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO))

from analysis_api import snapshot  # noqa: E402
from analysis_api.taxonomy import Node, Tree  # noqa: E402


def tree():
    return Tree(
        kind="problem",
        version="4.3.2",
        status="current",
        released_at=None,
        nodes=[
            Node("S9", "答案合成", None, 1, 0, ""),
            Node("S9.M5", "加工计算错误", "S9", 2, 0, ""),
            Node("S9.M5.3", "数值推算算错", "S9.M5", 3, 0, ""),
        ],
    )


def trace():
    return snapshot.Trace(
        trace_id="t1",
        day="2026-11-10",
        app_version="AIME-Atlas_expert",
        asked_at="2026-11-10T00:00:00Z",
        source="prelaunch",
        user_id="u1",
        question="q",
        session_id="s1",
        intent_code=None,
        task=None,
        subtask=None,
        problem_codes=("S9.M5.3.4",),
        problem_count=1,
        problems=({"code": "S9.M5.3.4", "label": "旧条目", "severity": "P2"},),
        severity={"P2": 1},
        is_correct=None,
        analysis_id="a1",
        analyzed_at="2026-11-10T00:01:00Z",
        file="f.jsonl",
        line=1,
        offset=0,
    )


class CanonicalCodeTests(unittest.TestCase):
    def setUp(self):
        self.tree = tree()
        self.trace = trace()
        self.snap = snapshot.Snapshot([self.trace], None, {"AIME-Atlas_expert": self.tree}, None)

    def test_canonical_walks_to_the_nearest_surviving_ancestor(self):
        self.assertEqual(self.tree.canonical("S9.M5.3.4"), "S9.M5.3")
        self.assertEqual(self.tree.canonical("S9.M5.3"), "S9.M5.3")
        self.assertEqual(self.tree.canonical("S9.M5.9.9"), "S9.M5")
        self.assertIsNone(self.tree.canonical("S8"))

    def test_trace_payload_keeps_raw_and_exposes_current_code(self):
        item = snapshot._item(self.snap, self.trace)
        self.assertEqual(item["problem_codes"], ["S9.M5.3.4"])
        self.assertEqual(item["problem_current_codes"], ["S9.M5.3"])
        problem = item["problems"][0]
        self.assertEqual(problem["code"], "S9.M5.3.4")
        self.assertEqual(problem["current_code"], "S9.M5.3")
        self.assertEqual(problem["legacy_code"], "S9.M5.3.4")

    def test_summary_labels_use_the_current_tree(self):
        filters = snapshot.Filters(dataset="aime_eval")
        leaf = snapshot.summary(self.snap, filters, ["problem"], level="leaf")
        self.assertEqual(leaf["groups"][0]["keys"]["problem"], "S9.M5.3.4")
        self.assertEqual(leaf["groups"][0]["problem_label"], "数值推算算错")

        top = snapshot.summary(self.snap, filters, ["problem"], level="top")
        self.assertEqual(top["groups"][0]["keys"]["problem"], "S9")
        self.assertEqual(top["groups"][0]["problem_label"], "答案合成")

    def test_retired_code_still_filters(self):
        filters = snapshot.parse_filters(
            {"dataset": "aime_eval", "problem": ["S9.M5.3.4"]}, self.snap
        )
        self.assertTrue(snapshot.Matcher(self.snap, filters).match(self.trace))

        children = snapshot.summary(self.snap, filters, ["problem"], level="children")
        self.assertEqual(children["groups"][0]["keys"]["problem"], "S9.M5.3")

    def test_severity_rows_carry_the_current_label(self):
        filters = snapshot.Filters(dataset="aime_eval")
        row = snapshot.severity(self.snap, filters, ["problem"], level="leaf")["groups"][0]
        self.assertEqual(row["problem_label"], "数值推算算错")


if __name__ == "__main__":
    unittest.main()
