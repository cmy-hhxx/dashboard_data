#!/usr/bin/env python3
"""用户 KYC 库的离线单测：输入扫描增量、画像入库、全文/结构化查询。

不访问网络，也不读真实数据；跑法：

    cd scripts/user_kyc && python3 -m unittest discover -s tests -q
"""
import csv
import gzip
import json
import os
import sys
import tempfile
import types
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import kyc  # noqa: E402
import kyc_store  # noqa: E402
import kyc_sync  # noqa: E402

REAL_A = "1800000001"
REAL_B = "1800000002"
NON_REAL = "xutianhao"


def make_line(uid: str, question: str = "q") -> str:
    return json.dumps({
        "request_time": "2026-11-01 00:00:00",
        "meta": {"user_id": uid, "session_id": "s-" + uid,
                 "question": question},
        "traces": [{"messages": [{"content": "x" * 2000}]}],
    }, ensure_ascii=False)


class KycStoreTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = os.path.join(self.tmp.name, "input")
        os.makedirs(os.path.join(self.root, "aime_expert"))
        self.db = os.path.join(self.tmp.name, "kyc.sqlite3")
        self.conn = kyc_store.connect(self.db)
        kyc_store.ensure_schema(self.conn)

    def tearDown(self):
        self.conn.close()
        self.tmp.cleanup()

    def write_day(self, day, lines, model="aime_expert"):
        path = os.path.join(self.root, model, day + ".jsonl")
        with open(path, "w", encoding="utf-8") as fh:
            for line in lines:
                fh.write(line + "\n")
        return path

    def row(self, uid):
        return self.conn.execute("SELECT * FROM users WHERE user_id = ?",
                                 (uid,)).fetchone()

    # ── 输入扫描 ────────────────────────────────────────────────
    def test_scan_and_incremental_append(self):
        self.write_day("2026-11-01",
                       [make_line(REAL_A), make_line(REAL_A), make_line(REAL_B)])
        kyc_sync.scan_inputs(self.conn, self.root, quiet=True)

        a, b = self.row(REAL_A), self.row(REAL_B)
        self.assertEqual(a["n_traces"], 2)
        self.assertEqual(a["models"], ",aime_expert,")
        self.assertEqual((a["first_day"], a["last_day"]),
                         ("2026-11-01", "2026-11-01"))
        self.assertEqual(a["status"], "pending")
        self.assertEqual(a["is_real"], 1)
        self.assertEqual(len(a["user_id_fp"]), 16)
        self.assertEqual(b["n_traces"], 1)

        # 只追加：只读新增尾巴，计数累加
        path = os.path.join(self.root, "aime_expert", "2026-11-01.jsonl")
        with open(path, "a", encoding="utf-8") as fh:
            fh.write(make_line(REAL_A) + "\n")
        stats = kyc_sync.scan_inputs(self.conn, self.root, quiet=True)
        self.assertEqual(stats["changed"], 1)
        self.assertEqual(self.row(REAL_A)["n_traces"], 3)

        # 没变：一个文件都不重读
        stats = kyc_sync.scan_inputs(self.conn, self.root, quiet=True)
        self.assertEqual(stats["changed"], 0)

    def test_rewrite_rescans_and_zeroes_removed_users(self):
        path = self.write_day("2026-11-01",
                              [make_line(REAL_A), make_line(REAL_B)])
        kyc_sync.scan_inputs(self.conn, self.root, quiet=True)

        # 重写成不同长度，且只剩 A
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(make_line(REAL_A) + "\n")
        kyc_sync.scan_inputs(self.conn, self.root, quiet=True)

        self.assertEqual(self.row(REAL_A)["n_traces"], 1)
        self.assertEqual(self.row(REAL_B)["n_traces"], 0)
        self.assertIsNone(self.row(REAL_B)["last_day"])

    def test_non_real_id_is_skipped(self):
        self.write_day("2026-11-01", [make_line(NON_REAL)])
        kyc_sync.scan_inputs(self.conn, self.root, quiet=True)
        row = self.row(NON_REAL)
        self.assertEqual(row["status"], "skipped")
        self.assertEqual(row["is_real"], 0)
        self.assertEqual(row["error"], "non_real_user_id")

    def test_extract_user_id_ignores_traces(self):
        line = make_line(REAL_A).encode()
        self.assertEqual(kyc_sync.extract_user_id(line), REAL_A)
        self.assertEqual(kyc_sync.extract_user_id(b"not json"), "")

    # ── 画像与查询 ──────────────────────────────────────────────
    def _store_profile(self, uid, profile):
        body = json.dumps(profile, ensure_ascii=False)
        self.conn.execute(
            "UPDATE users SET status='ok', profile=?, profile_bytes=?, "
            "n_sections=?, fetched_at='2026-11-23T00:00:00Z' WHERE user_id=?",
            (body, len(body.encode()), len([k for k in profile
                                            if not k.startswith("_")]), uid))
        self.conn.execute("DELETE FROM user_sections WHERE user_id=?", (uid,))
        self.conn.executemany(
            "INSERT INTO user_sections(user_id, section, n_bytes) VALUES(?,?,?)",
            [(uid, k, 1) for k in profile if not k.startswith("_")])
        self.conn.commit()

    def test_search_fts_sections_and_path(self):
        self.write_day("2026-11-01", [make_line(REAL_A), make_line(REAL_B)])
        kyc_sync.scan_inputs(self.conn, self.root, quiet=True)
        profile = {
            "_createTime": "2026-10",
            "goals": {"asset_protection": ["黄金", "gold"]},
            "risk_preference": {"level": "medium"},
        }
        self._store_profile(REAL_A, profile)

        self.assertEqual([r["user_id"] for r in kyc_store.search(
            self.conn, q="gold", status=["ok"])], [REAL_A])
        # 2 个字：trigram 不出 token，自动退回 LIKE
        self.assertEqual([r["user_id"] for r in kyc_store.search(
            self.conn, q="黄金", status=["ok"])], [REAL_A])
        self.assertEqual([r["user_id"] for r in kyc_store.search(
            self.conn, section="risk_preference", status=["ok"])], [REAL_A])
        self.assertEqual(kyc_store.search(self.conn, section="goals",
                                          status=["empty"]), [])

        rows = kyc_store.path_values(
            self.conn, kyc_store.to_json_path("goals.asset_protection"),
            status=["ok"])
        self.assertEqual(rows, [{"user_id": REAL_A,
                                 "value": ["黄金", "gold"]}])

        # 改画像后 FTS 必须同步（外部内容表的触发器）
        self._store_profile(REAL_A, {"goals": {"asset_protection": ["bond"]}})
        self.assertEqual(kyc_store.search(self.conn, q="gold", status=["ok"]), [])
        self.assertEqual(len(kyc_store.search(self.conn, q="bond",
                                              status=["ok"])), 1)

        rec = kyc_store.get_users(self.conn, [REAL_A, "missing"])[REAL_A]
        self.assertEqual(rec["profile"]["goals"]["asset_protection"], ["bond"])

        # 画像被清空（empty/leak）时 FTS 也要清掉
        self.conn.execute("UPDATE users SET profile=NULL WHERE user_id=?", (REAL_A,))
        self.conn.commit()
        self.assertEqual(kyc_store.search(self.conn, q="bond", status=["ok"]), [])

    def test_json_path_validation(self):
        self.assertEqual(kyc_store.to_json_path("a.b[0]"), '$."a"."b"[0]')
        with self.assertRaises(ValueError):
            kyc_store.to_json_path('a"; DROP TABLE users; --')
        with self.assertRaises(ValueError):
            kyc_store.to_json_path("a..b")

    # ── 导出 ────────────────────────────────────────────────────
    def test_export(self):
        self.write_day("2026-11-01", [make_line(REAL_A), make_line(REAL_B)])
        kyc_sync.scan_inputs(self.conn, self.root, quiet=True)
        self._store_profile(REAL_A, {"goals": {"asset_protection": ["gold"]}})
        self.conn.execute(
            "UPDATE users SET status='leak', error=? WHERE user_id=?",
            ('leak:["state=NY"]', REAL_B))
        self.conn.commit()

        out = os.path.join(self.tmp.name, "export")
        kyc.cmd_export(self.conn, types.SimpleNamespace(out_dir=out,
                                                        date="2026-11-23"))

        with gzip.open(os.path.join(out, "kyc_profiles-2026-11-23.jsonl.gz"),
                       "rt", encoding="utf-8") as fh:
            rec = json.loads(fh.readline())
        self.assertEqual(rec["user_id"], REAL_A)
        self.assertEqual(rec["models"], ["aime_expert"])
        self.assertEqual(rec["profile"]["goals"]["asset_protection"], ["gold"])

        with gzip.open(os.path.join(out, "kyc_users-2026-11-23.csv.gz"),
                       "rt", encoding="utf-8") as fh:
            rows = {r["user_id"]: r for r in csv.DictReader(fh)}
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[REAL_B]["status"], "leak")
        self.assertEqual(rows[REAL_B]["error"], "leak")  # 明细不外泄

        manifest = json.load(open(os.path.join(out, "MANIFEST.json"),
                                  encoding="utf-8"))
        self.assertEqual(manifest["counts"]["users"], 2)
        self.assertEqual(manifest["files"]["profiles"]["rows"], 1)
        self.assertEqual(len(manifest["files"]["users"]["sha256"]), 64)

    # ── 复用既有画像 ────────────────────────────────────────────
    def test_import_legacy(self):
        self.write_day("2026-11-01", [make_line(REAL_A), make_line(REAL_B)])
        kyc_sync.scan_inputs(self.conn, self.root, quiet=True)

        legacy = os.path.join(self.tmp.name, "legacy", "01")
        os.makedirs(legacy)
        profile = {"_createTime": "2026-10", "goals": {"asset_protection": ["gold"]}}
        with open(os.path.join(legacy, REAL_A + ".json"), "w", encoding="utf-8") as fh:
            json.dump({"user_id_fp": kyc_sync._fingerprint(REAL_A),
                       "fetched_at": "2026-11-17 11:09:00",
                       "profile": profile}, fh)
        # 指纹对不上：不导入
        with open(os.path.join(legacy, REAL_B + ".json"), "w", encoding="utf-8") as fh:
            json.dump({"user_id_fp": "0" * 16, "profile": profile}, fh)

        out = kyc_sync.import_legacy(self.conn, os.path.join(self.tmp.name, "legacy"))
        self.assertEqual(out["imported"], 1)
        self.assertEqual(out["fp_mismatch"], 1)

        row = self.row(REAL_A)
        self.assertEqual(row["status"], "ok")
        self.assertEqual(row["fetched_at"], "2026-11-17T11:09:00Z")
        self.assertEqual([r["user_id"] for r in kyc_store.search(
            self.conn, section="goals", status=["ok"])], [REAL_A])

        # 已 ok 的默认不覆盖
        out = kyc_sync.import_legacy(self.conn, os.path.join(self.tmp.name, "legacy"))
        self.assertEqual(out["imported"], 0)
        self.assertEqual(out["kept"], 1)


if __name__ == "__main__":
    unittest.main()
