"""File index reuse: an in-place rewrite must never be mistaken for an append.

A backfill that patches fields inside every line keeps the first 64 KB of the file
and makes it longer, exactly like an append does.  The index used to keep its old
offsets then, so every detail read after the rewrite started mid-line and the board
answered 404 for those samples.
"""
import json
import tempfile
import unittest
from pathlib import Path

try:
    from dashboard.tests.test_empty_data import DASHBOARD
except ImportError:  # `cd dashboard && python3 -m unittest discover -s tests`
    from test_empty_data import DASHBOARD

import sys

sys.path.insert(0, str(DASHBOARD))

import build_store as bs  # noqa: E402


def row(n: int, payload: str = "") -> str:
    return json.dumps({"n": n, "text": payload}, ensure_ascii=False)


class InPlaceRewriteTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.rel = "out/attribution.jsonl"
        self.store = bs.BuildStore(self.root / "build.sqlite3")
        # Line 1 is longer than the 64 KB prefix so rewriting later lines leaves it intact.
        self.head = row(1, "x" * 70000)
        self.lines = [self.head] + [row(n, "y" * 40) for n in range(2, 21)]
        (self.root / "out").mkdir()
        self.write(self.lines)

    def tearDown(self):
        self.store.close()
        self.tmp.cleanup()

    def write(self, lines):
        (self.root / self.rel).write_text("".join(line + "\n" for line in lines), encoding="utf-8")

    def scan(self):
        prev = self.store.get_file(self.rel)
        data = bs.scan_file(str(self.root), self.rel, "output", prev, False, "")
        self.store.put_file(data)
        return self.store.get_file(self.rel)

    def assertAligned(self, index):
        raw = (self.root / self.rel).read_bytes()
        starts = [0] + [i + 1 for i, byte in enumerate(raw) if byte == 10]
        self.assertEqual(index["committed"], len(raw))
        self.assertEqual(index["lines"], len(starts) - 1)
        for n, start in enumerate(index["offsets"][: len(starts)], 1):
            self.assertEqual(start, starts[n - 1], f"line {n} offset drifted")
        self.assertEqual(bs.boundary_hash(self.root / self.rel, index["committed"]), index["tail"])

    def test_in_place_rewrite_rescans_instead_of_tailing(self):
        first = self.scan()
        self.assertAligned(first)
        self.assertTrue(first["tail"])

        # Same head, longer lines: the prefix hash is unchanged, the file grew.
        rewritten = [self.head] + [row(n, "y" * 400) for n in range(2, 21)]
        self.write(rewritten)
        self.assertEqual(bs.prefix_hash(self.root / self.rel), first["prefix"])
        self.assertGreater((self.root / self.rel).stat().st_size, first["committed"])

        second = self.scan()
        self.assertAligned(second)
        self.assertFalse(second["committed"] == first["committed"])

    def test_append_still_extends_the_index(self):
        first = self.scan()
        self.assertAligned(first)

        with open(self.root / self.rel, "a", encoding="utf-8") as fh:
            fh.write(row(21, "z" * 20) + "\n")
        second = self.scan()
        self.assertAligned(second)
        self.assertEqual(second["lines"], first["lines"] + 1)
        self.assertEqual(second["keys"], first["keys"] + second["keys"][-1:])

    def test_index_without_tail_is_not_trusted(self):
        self.scan()
        self.store.db.execute("UPDATE files SET tail=NULL WHERE path=?", (self.rel,))
        self.store.db.commit()
        stat = (self.root / self.rel).stat()
        self.assertFalse(self.store.has_file_stat(self.rel, stat))
        # An unchanged file is still read again, and gains its boundary hash.
        again = self.scan()
        self.assertTrue(again["tail"])
        self.assertTrue(self.store.has_file_stat(self.rel, stat))


if __name__ == "__main__":
    unittest.main()
