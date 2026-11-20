"""Scenario fallback: AIME must never use skill instrumentation as its scene."""
import sys
import unittest
from pathlib import Path

DASHBOARD = Path(__file__).resolve().parents[1]
if str(DASHBOARD) not in sys.path:
    sys.path.insert(0, str(DASHBOARD))

import build  # noqa: E402


class SceneFallbackTests(unittest.TestCase):
    def test_aime_ignores_skill_names(self):
        brief = {"meta": {"skill": "aime-finquery,data-visualizer"}, "question": "q1"}
        self.assertEqual(build.scene_of(brief, {}, "aime"), build.NO_SCENE)

    def test_aime_keeps_task_when_present(self):
        brief = {"meta": {"task": "行情分析", "skill": "aime-finquery"}, "question": "q1"}
        self.assertEqual(build.scene_of(brief, {}, "aime"), "行情分析")

    def test_wencai_keeps_skill_and_vote_fallback(self):
        brief = {"meta": {"skill": "stock-analysis"}, "question": "q1"}
        self.assertEqual(build.scene_of(brief, {}, "wencai"), "stock-analysis")
        voted = {"meta": {}, "question": "q2"}
        self.assertEqual(build.scene_of(voted, {"q2": "交易建议"}, "wencai"), "交易建议")
        self.assertEqual(build.scene_of(voted, {}, "wencai"), build.NO_SCENE)


if __name__ == "__main__":
    unittest.main()
