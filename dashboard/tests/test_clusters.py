"""Cluster taxonomy loading: L4 drill-down nodes keep their titles."""
import json
import sys
import tempfile
import unittest
from pathlib import Path


DASHBOARD = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(DASHBOARD))

import build  # noqa: E402


def node(nid, level, name, children=None):
    return {"id": nid, "level": level, "name": name, "definition": f"{name} 定义",
            "include": "", "exclude": "", "children": children or []}


class ClusterTaxonomyTests(unittest.TestCase):
    def test_level_four_pattern_is_emitted_with_its_name(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            out = root / "1_aime/eval_output/cluster/aime_fast"
            out.mkdir(parents=True)
            tree = {
                "meta": {"generated_at": "2026-11-01T00:00:00+08:00"},
                "tree": node("root", 0, "全部", [
                    node("S1", 1, "取数", [
                        node("S1.M1", 2, "机制", [
                            node("S1.M1.1", 3, "模式", [
                                node("S1.M1.1.1", 4, "子模式"),
                            ]),
                        ]),
                    ]),
                ]),
                "mechanism_rollup": [{"mechanism": "M1", "name": "机制"}],
            }
            (out / "cluster_tree.json").write_text(json.dumps(tree, ensure_ascii=False), encoding="utf-8")
            (out / "item_index.jsonl").write_text(json.dumps({
                "session_id": "s1", "path": "S1.M1.1.1", "json_path": "sample.json", "label": "原因",
            }, ensure_ascii=False) + "\n", encoding="utf-8")

            taxonomy, index = build.load_clusters(root)
            self.assertEqual(taxonomy["patterns"]["S1.M1.1.1"]["name"], "子模式")
            self.assertEqual(index[("aime", "aime_fast", "s1", "sample.json", "原因")]["path"], "S1.M1.1.1")

            payload = build.taxonomy_out(taxonomy, {"S1.M1.1.1"})
            entry = payload["patterns"]["S1.M1.1.1"]
            self.assertEqual((entry["name"], entry["def"]), ("子模式", "子模式 定义"))


if __name__ == "__main__":
    unittest.main()
