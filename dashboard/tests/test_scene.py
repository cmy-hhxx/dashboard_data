"""Scenario is the input task field only: skill instrumentation is never a scene."""
import sys
import unittest
from pathlib import Path

DASHBOARD = Path(__file__).resolve().parents[1]
if str(DASHBOARD) not in sys.path:
    sys.path.insert(0, str(DASHBOARD))

import build  # noqa: E402


class SceneFallbackTests(unittest.TestCase):
    def test_task_is_the_only_scene_source(self):
        brief = {"meta": {"task": "行情分析", "skill": "aime-finquery"}, "question": "q1"}
        self.assertEqual(build.scene_of(brief), "行情分析")

    def test_skill_never_becomes_scene(self):
        for product_skill in ("stock-analysis", "aime-finquery,data-visualizer"):
            brief = {"meta": {"skill": product_skill}, "question": "q1"}
            self.assertEqual(build.scene_of(brief), build.NO_SCENE)

    def test_missing_task_falls_to_no_scene(self):
        self.assertEqual(build.scene_of({"meta": {}, "question": "q2"}), build.NO_SCENE)


if __name__ == "__main__":
    unittest.main()


class ABSceneTests(unittest.TestCase):
    def test_ab_sample_scene_index_ignores_skill(self):
        import ab_test
        samples = [("s1", {"meta": {"skill": "stock-analysis"}, "ids": {}},
                    {"m": "a_fast", "sid": "thread_1", "d": "2026-11-18", "tid": "t1"}, {})]
        by_trace, by_session = ab_test._sample_scene_index(samples)
        self.assertEqual(by_trace, {})
        self.assertEqual(by_session, {})
