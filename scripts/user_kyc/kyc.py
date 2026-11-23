#!/usr/bin/env python3
"""用户 KYC 库查询命令行（离线读 SQLite，不走网络）。

```bash
python3 kyc.py get 1808221539                 # 一条完整记录（含 profile）
python3 kyc.py get --pretty 1808221539 -      # 从 stdin 批量
python3 kyc.py search --section risk_preference --limit 20
python3 kyc.py search --q "gold" --status ok --format jsonl
python3 kyc.py path goals.asset_protection --section goals --limit 50
python3 kyc.py stats
```

数据由 `kyc_sync.py` 维护；本命令只读，和同步进程可以同时跑（WAL）。
"""
from __future__ import annotations

import argparse
import csv
import gzip
import hashlib
import json
import os
import sys
from datetime import datetime, timezone

import kyc_store

SEARCH_FIELDS = ["user_id", "status", "last_day", "n_traces", "models",
                 "sections", "n_sections", "kyc_update", "fetched_at"]


def _status_arg(value: str | None):
    if not value or value == "any":
        return None
    out = [s.strip() for s in value.split(",") if s.strip()]
    bad = [s for s in out if s not in kyc_store.STATUSES]
    if bad:
        raise SystemExit("未知 status：%s（可选 %s 或 any）"
                         % (", ".join(bad), "/".join(kyc_store.STATUSES)))
    return out or None


def _cell(value) -> str:
    if isinstance(value, (list, tuple)):
        return ",".join(str(v) for v in value)
    if isinstance(value, dict):
        return json.dumps(value, ensure_ascii=False)
    return "" if value is None else str(value)


def _print_table(rows: list[dict], fields: list[str]) -> None:
    cols = [f for f in fields if f != "profile"]
    widths = {c: len(c) for c in cols}
    for row in rows:
        for c in cols:
            widths[c] = min(60, max(widths[c], len(_cell(row.get(c)))))
    print("  ".join(c.ljust(widths[c]) for c in cols))
    print("  ".join("-" * widths[c] for c in cols))
    for row in rows:
        cells = []
        for c in cols:
            text = _cell(row.get(c))
            if len(text) > widths[c]:
                text = text[:widths[c] - 1] + "…"
            cells.append(text.ljust(widths[c]))
        print("  ".join(cells))


def _emit(rows: list[dict], fields: list[str], fmt: str) -> None:
    rows = [{f: row.get(f) for f in fields} for row in rows]
    if fmt == "json":
        print(json.dumps(rows, ensure_ascii=False, indent=2))
    elif fmt == "jsonl":
        for row in rows:
            print(json.dumps(row, ensure_ascii=False))
    elif fmt == "csv":
        writer = csv.DictWriter(sys.stdout, fieldnames=fields)
        writer.writeheader()
        for row in rows:
            writer.writerow({f: _cell(row.get(f)) for f in fields})
    else:
        _print_table(rows, fields)


# ── 导出（给外部使用方） ──────────────────────────────────────────────

PROFILE_FIELDS = ["user_id", "user_id_fp", "first_day", "last_day", "n_traces",
                  "models", "kyc_create_time", "kyc_update_time", "fetched_at",
                  "n_sections", "profile"]
USER_FIELDS = ["user_id", "user_id_fp", "is_real", "status", "first_day",
               "last_day", "n_traces", "models", "profile_bytes", "n_sections",
               "kyc_create_time", "kyc_update_time", "fetched_at", "error"]


def _sha256(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _models_list(value: str) -> list[str]:
    return [m for m in (value or "").strip(",").split(",") if m]


def cmd_export(conn, args) -> int:
    """把库导成外部可直接读取的 gzip JSONL / CSV + MANIFEST。

    主库仍是 SQLite；这两个文件给没有 SQLite 使用经验、或只想拿走一份快照的人。
    """
    db_path = conn.execute("PRAGMA database_list").fetchone()["file"]
    out_dir = args.out_dir or os.path.join(os.path.dirname(os.path.abspath(db_path)),
                                           "export")
    os.makedirs(out_dir, exist_ok=True)
    date = args.date or datetime.now(timezone.utc).strftime("%Y-%m-%d")

    profiles_name = "kyc_profiles-%s.jsonl.gz" % date
    profiles_path = os.path.join(out_dir, profiles_name)
    profiles_rows = 0
    with gzip.open(profiles_path, "wt", encoding="utf-8", compresslevel=6) as fh:
        for row in conn.execute(
                "SELECT %s FROM users WHERE status = 'ok' AND profile IS NOT NULL "
                "ORDER BY n_traces DESC, user_id" % ",".join(PROFILE_FIELDS)):
            rec = dict(row)
            rec["models"] = _models_list(rec.get("models"))
            rec["profile"] = json.loads(rec["profile"])
            fh.write(json.dumps(rec, ensure_ascii=False) + "\n")
            profiles_rows += 1

    users_name = "kyc_users-%s.csv.gz" % date
    users_path = os.path.join(out_dir, users_name)
    users_rows = 0
    with gzip.open(users_path, "wt", encoding="utf-8", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=USER_FIELDS)
        writer.writeheader()
        for row in conn.execute(
                "SELECT %s FROM users ORDER BY last_day DESC, n_traces DESC, user_id"
                % ",".join(USER_FIELDS)):
            rec = dict(row)
            rec["models"] = ";".join(_models_list(rec.get("models")))
            # leak 的 error 明细里可能带原始姓名/地区片段，对外导出只保留状态
            if str(rec.get("error") or "").startswith("leak:"):
                rec["error"] = "leak"
            writer.writerow({k: rec.get(k) for k in USER_FIELDS})
            users_rows += 1

    counts = {r["status"]: r["n"] for r in conn.execute(
        "SELECT status, COUNT(*) n FROM users GROUP BY status")}
    manifest = {
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "snapshot_date": date,
        "source_db": db_path,
        "db_bytes": os.path.getsize(db_path) if os.path.exists(db_path) else 0,
        "counts": {"users": sum(counts.values()), **counts},
        "files": {
            "profiles": {"name": profiles_name, "rows": profiles_rows,
                         "bytes": os.path.getsize(profiles_path),
                         "sha256": _sha256(profiles_path)},
            "users": {"name": users_name, "rows": users_rows,
                      "bytes": os.path.getsize(users_path),
                      "sha256": _sha256(users_path)},
        },
        "columns": {"profiles": PROFILE_FIELDS, "users": USER_FIELDS},
        "notes": [
            "profile 已脱敏（keep-assets-mask-money-v2）：金额/数量/百分比打星号，"
            "身份/联系方式/凭证已丢弃。",
            "只有 status=ok 的用户有 profile；其余在 users CSV 里，看 status/error。",
            "models 在 JSONL 里是数组，在 CSV 里用分号分隔。",
            "leak 用户的 error 明细不导出（可能含原始片段），只保留 'leak'。",
            "这是带日期的快照；实时/最新数据以同目录 kyc.sqlite3 为准。",
        ],
    }
    manifest_path = os.path.join(out_dir, "MANIFEST.json")
    with open(manifest_path, "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, ensure_ascii=False, indent=2)

    print(json.dumps({
        "out_dir": out_dir,
        "profiles": {"file": profiles_name, "rows": profiles_rows},
        "users": {"file": users_name, "rows": users_rows},
        "manifest": manifest_path,
    }, ensure_ascii=False, indent=2))
    return 0


# ── 子命令 ────────────────────────────────────────────────────────────

def cmd_get(conn, args) -> int:
    ids = []
    for item in args.ids:
        if item == "-":
            ids.extend(x.strip() for x in sys.stdin if x.strip())
        else:
            ids.append(item.strip())
    ids = list(dict.fromkeys(u for u in ids if u))
    if not ids:
        raise SystemExit("用法：kyc.py get <user_id> [更多] 或 get - < ids.txt")

    records = kyc_store.get_users(conn, ids)
    out = []
    for uid in ids:
        d = records.get(uid)
        if not d:
            out.append({"user_id": uid, "ok": False, "status": "missing",
                        "error": "not_found", "source": "db"})
            continue
        item = {"user_id": uid, "ok": d["status"] == "ok",
                "user_id_fp": d["user_id_fp"], "status": d["status"],
                "fetched_at": d["fetched_at"], "source": "db"}
        if d["status"] == "ok" and d.get("profile") is not None:
            item["profile"] = d["profile"]
        elif d["status"] == "skipped":
            item["error"] = "non_real_user_id"
        elif d["status"] == "empty":
            item["error"] = "not_found"
        elif d["status"] == "pending":
            item["error"] = "pending"
        else:
            item["error"] = d.get("error") or d["status"]
        out.append(item)

    payload = out[0] if len(out) == 1 else out
    print(json.dumps(payload, ensure_ascii=False,
                     indent=2 if args.pretty else None))
    return 0 if all(x["ok"] for x in out) else 1


def cmd_search(conn, args) -> int:
    fields = [f.strip() for f in args.fields.split(",") if f.strip()]
    rows = kyc_store.search(
        conn, fields=fields, limit=args.limit, offset=args.offset,
        q=args.q, status=_status_arg(args.status), section=args.section,
        model=args.model, day_from=args.day_from, day_to=args.day_to,
        min_traces=args.min_traces)
    _emit(rows, fields, args.format)
    return 0


def cmd_path(conn, args) -> int:
    try:
        json_path = kyc_store.to_json_path(args.path)
    except ValueError as exc:
        raise SystemExit(str(exc))
    rows = kyc_store.path_values(
        conn, json_path, limit=args.limit, q=args.q,
        status=_status_arg(args.status), section=args.section,
        model=args.model, day_from=args.day_from, day_to=args.day_to,
        min_traces=args.min_traces)
    _emit(rows, ["user_id", "value"], args.format)
    return 0


def cmd_stats(conn, args) -> int:
    print(json.dumps(kyc_store.stats(conn), ensure_ascii=False, indent=2))
    return 0


# ── CLI ───────────────────────────────────────────────────────────────

def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(description="用户 KYC 库查询（离线 SQLite）")
    ap.add_argument("--db", default=None, help="库路径")
    sub = ap.add_subparsers(dest="cmd", required=True)

    common = argparse.ArgumentParser(add_help=False)
    # SUPPRESS：子命令没写 --db 时保留顶层解析到的值
    common.add_argument("--db", default=argparse.SUPPRESS, help="库路径")

    filter_parent = argparse.ArgumentParser(add_help=False)
    filter_parent.add_argument("--status", default="ok",
                               help="ok/empty/leak/error/pending/skipped 或 any，"
                                    "可逗号分隔（默认 ok）")
    filter_parent.add_argument("--q", default=None,
                               help="profile 全文搜索（trigram 子串；1~2 字退回 LIKE）")
    filter_parent.add_argument("--section", default=None,
                               help="只要含某个 profile 顶层树，如 risk_preference")
    filter_parent.add_argument("--model", default=None, help="aime_expert / aime_fast")
    filter_parent.add_argument("--day-from", default=None,
                               help="输入日期下限（含），如 2026-11-01")
    filter_parent.add_argument("--day-to", default=None,
                               help="输入日期上限（含）")
    filter_parent.add_argument("--min-traces", type=int, default=None,
                               help="输入里至少出现过多少条 trace")

    p = sub.add_parser("get", parents=[common], help="按 user_id 取画像")
    p.add_argument("ids", nargs="+", help="user_id；- 表示从 stdin 读")
    p.add_argument("--pretty", action="store_true")
    p.set_defaults(func=cmd_get)

    p = sub.add_parser("search", parents=[common, filter_parent],
                       help="按条件查用户")
    p.add_argument("--fields", default=",".join(SEARCH_FIELDS[:6]),
                   help="输出字段，逗号分隔；可选 %s"
                        % ",".join(kyc_store.FIELD_SQL))
    p.add_argument("--limit", type=int, default=50)
    p.add_argument("--offset", type=int, default=0)
    p.add_argument("--format", choices=("table", "json", "jsonl", "csv"),
                   default="table")
    p.set_defaults(func=cmd_search)

    p = sub.add_parser("path", parents=[common, filter_parent],
                       help="按条件取 profile 里的某个子树/字段")
    p.add_argument("path", help="点路径，如 goals.asset_protection 或 "
                                "investment_status.watchlists.crypto_usdt.assets[0]")
    p.add_argument("--limit", type=int, default=50)
    p.add_argument("--format", choices=("table", "json", "jsonl", "csv"),
                   default="jsonl")
    p.set_defaults(func=cmd_path)

    p = sub.add_parser("export", parents=[common],
                       help="导出 JSONL/CSV 快照给外部使用方")
    p.add_argument("--out-dir", default=None,
                   help="输出目录（默认 <库目录>/export）")
    p.add_argument("--date", default=None, help="快照日期，默认今天（UTC）")
    p.set_defaults(func=cmd_export)

    p = sub.add_parser("stats", parents=[common], help="库统计")
    p.set_defaults(func=cmd_stats)
    return ap


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    db = args.db or kyc_store.default_db_path()
    if not os.path.exists(db):
        raise SystemExit("库不存在：%s（先跑 python3 kyc_sync.py run）" % db)
    conn = kyc_store.connect(db)
    try:
        return args.func(conn, args)
    except BrokenPipeError:
        # `kyc.py get ... | head` 时正常退出，不打 traceback
        sys.stdout = open(os.devnull, "w")
        return 0


if __name__ == "__main__":
    sys.exit(main())
