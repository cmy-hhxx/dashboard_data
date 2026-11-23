#!/usr/bin/env python3
"""用户 KYC 库：SQLite 存储、索引与查询。

库文件默认放在脚本同目录的 `kyc.sqlite3`（可用 `KYC_DB` 或 `--db` 覆盖）。

表结构（详见 docs/用户KYC库.md）：

| 表 | 作用 |
|---|---|
| `users` | 一个 user_id 一行：输入侧活动度 + 脱敏后的 profile JSON + 拉取状态 |
| `user_days` | 用户 × 日期 × 模型 的 trace 数（按 daily eval input 汇总）|
| `user_sections` | profile 顶层树（goals / risk_preference …），用于按维度筛选 |
| `files` / `file_contrib` | 输入文件增量游标与每个文件对用户的贡献 |
| `profile_fts` | profile 全文索引（trigram，中/英/波斯文都能做子串匹配）|

profile 是各用户不同的树，不做列拆分；需要取字段时用 `json_extract`
（`kyc.py path` 已封装），需要全文找内容时用 `kyc.py search --q`。
"""
from __future__ import annotations

import json
import os
import re
import sqlite3
import urllib.parse
from datetime import datetime, timezone

DB_NAME = "kyc.sqlite3"
SCHEMA_VERSION = 1

STATUSES = ("pending", "ok", "empty", "leak", "error", "skipped")

#: 查询输出里允许出现的列名 -> SQL 表达式
FIELD_SQL = {
    "user_id": "u.user_id",
    "fp": "u.user_id_fp",
    "status": "u.status",
    "first_day": "u.first_day",
    "last_day": "u.last_day",
    "n_traces": "u.n_traces",
    "models": "u.models",
    "sections": ("(SELECT group_concat(s.section, ',') FROM user_sections s"
                 " WHERE s.user_id = u.user_id)"),
    "n_sections": "u.n_sections",
    "profile_bytes": "u.profile_bytes",
    "kyc_create": "u.kyc_create_time",
    "kyc_update": "u.kyc_update_time",
    "fetched_at": "u.fetched_at",
    "attempts": "u.attempts",
    "error": "u.error",
    "profile": "u.profile",
}

_SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS files (
  path       TEXT PRIMARY KEY,
  day        TEXT NOT NULL,
  model      TEXT NOT NULL,
  size       INTEGER NOT NULL,
  mtime_ns   INTEGER NOT NULL,
  ctime_ns   INTEGER NOT NULL,
  head_md5   TEXT,
  head_len   INTEGER NOT NULL DEFAULT 0,
  offset     INTEGER NOT NULL DEFAULT 0,
  lines      INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS file_contrib (
  path     TEXT NOT NULL,
  user_id  TEXT NOT NULL,
  n_traces INTEGER NOT NULL,
  PRIMARY KEY (path, user_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_file_contrib_user ON file_contrib(user_id);

CREATE TABLE IF NOT EXISTS users (
  user_id         TEXT PRIMARY KEY,
  user_id_fp      TEXT,
  is_real         INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'pending',
  error           TEXT,
  attempts        INTEGER NOT NULL DEFAULT 0,
  fetched_at      TEXT,
  first_day       TEXT,
  last_day        TEXT,
  n_traces        INTEGER NOT NULL DEFAULT 0,
  models          TEXT NOT NULL DEFAULT '',
  profile         TEXT,
  profile_bytes   INTEGER,
  n_sections      INTEGER,
  kyc_create_time TEXT,
  kyc_update_time TEXT,
  created_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_users_status   ON users(status);
CREATE INDEX IF NOT EXISTS idx_users_last_day ON users(last_day);
CREATE INDEX IF NOT EXISTS idx_users_n_traces ON users(n_traces);
CREATE INDEX IF NOT EXISTS idx_users_fp       ON users(user_id_fp);

CREATE TABLE IF NOT EXISTS user_days (
  user_id  TEXT NOT NULL,
  day      TEXT NOT NULL,
  model    TEXT NOT NULL,
  n_traces INTEGER NOT NULL,
  PRIMARY KEY (user_id, day, model)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_user_days_day ON user_days(day, model);

CREATE TABLE IF NOT EXISTS user_sections (
  user_id TEXT NOT NULL,
  section TEXT NOT NULL,
  n_bytes INTEGER,
  PRIMARY KEY (user_id, section)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_user_sections_section ON user_sections(section);

CREATE VIRTUAL TABLE IF NOT EXISTS profile_fts USING fts5(
  profile,
  content='users',
  content_rowid='rowid',
  tokenize='trigram'
);

CREATE TRIGGER IF NOT EXISTS users_fts_ai AFTER INSERT ON users
WHEN new.profile IS NOT NULL BEGIN
  INSERT INTO profile_fts(rowid, profile) VALUES (new.rowid, new.profile);
END;

CREATE TRIGGER IF NOT EXISTS users_fts_au AFTER UPDATE OF profile ON users
WHEN old.profile IS NOT NULL AND new.profile IS NOT NULL BEGIN
  INSERT INTO profile_fts(profile_fts, rowid, profile)
    VALUES ('delete', old.rowid, old.profile);
  INSERT INTO profile_fts(rowid, profile) VALUES (new.rowid, new.profile);
END;

CREATE TRIGGER IF NOT EXISTS users_fts_au_add AFTER UPDATE OF profile ON users
WHEN old.profile IS NULL AND new.profile IS NOT NULL BEGIN
  INSERT INTO profile_fts(rowid, profile) VALUES (new.rowid, new.profile);
END;

CREATE TRIGGER IF NOT EXISTS users_fts_au_del AFTER UPDATE OF profile ON users
WHEN old.profile IS NOT NULL AND new.profile IS NULL BEGIN
  INSERT INTO profile_fts(profile_fts, rowid, profile)
    VALUES ('delete', old.rowid, old.profile);
END;

CREATE TRIGGER IF NOT EXISTS users_fts_ad AFTER DELETE ON users
WHEN old.profile IS NOT NULL BEGIN
  INSERT INTO profile_fts(profile_fts, rowid, profile)
    VALUES ('delete', old.rowid, old.profile);
END;
"""


def default_db_path() -> str:
    return (os.environ.get("KYC_DB")
            or os.path.join(os.path.dirname(os.path.abspath(__file__)), DB_NAME))


def utcnow() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def is_real_user_id(user_id: str) -> bool:
    """真实 user_id：纯 ASCII 数字且 ≤10 位（与看板/5003 同一口径）。"""
    uid = str(user_id or "").strip()
    return uid.isascii() and uid.isdigit() and len(uid) <= 10


def connect(path: str | None = None, *, readonly: bool = False) -> sqlite3.Connection:
    path = path or default_db_path()
    if readonly:
        uri = "file:%s?mode=ro" % urllib.parse.quote(os.path.abspath(path))
        conn = sqlite3.connect(uri, uri=True, timeout=30)
    else:
        conn = sqlite3.connect(path, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout = 10000")
    conn.execute("PRAGMA mmap_size = 1073741824")
    conn.execute("PRAGMA cache_size = -131072")
    if not readonly:
        conn.execute("PRAGMA journal_mode = WAL")
        conn.execute("PRAGMA synchronous = NORMAL")
    return conn


def ensure_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(_SCHEMA)
    conn.execute("INSERT OR IGNORE INTO meta(key, value) VALUES('schema_version', ?)",
                 (str(SCHEMA_VERSION),))
    conn.execute("INSERT OR IGNORE INTO meta(key, value) VALUES('created_at', ?)",
                 (utcnow(),))
    conn.commit()


def set_meta(conn: sqlite3.Connection, key: str, value: str) -> None:
    conn.execute("INSERT INTO meta(key, value) VALUES(?, ?) "
                 "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                 (key, value))


def get_meta(conn: sqlite3.Connection) -> dict:
    return {r["key"]: r["value"] for r in conn.execute("SELECT key, value FROM meta")}


# ── 查询 ──────────────────────────────────────────────────────────────

def _like_escape(value: str) -> str:
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def _fts_query(terms: list[str]) -> str:
    return " AND ".join('"' + t.replace('"', '""') + '"' for t in terms)


def _where(*, q=None, status=None, section=None, model=None,
           day_from=None, day_to=None, min_traces=None,
           has_profile: bool = False) -> tuple[str, list]:
    """拼 WHERE 子句。day_from/day_to 按「区间有交集」判定活动时间。"""
    where: list[str] = []
    args: list = []

    if status:
        statuses = [status] if isinstance(status, str) else list(status)
        statuses = [s for s in statuses if s in STATUSES]
        if statuses:
            where.append("u.status IN (%s)" % ",".join("?" * len(statuses)))
            args.extend(statuses)

    if q and q.strip():
        long_terms = [t for t in q.split() if len(t) >= 3]
        short_terms = [t for t in q.split() if 0 < len(t) < 3]
        if long_terms:
            where.append("u.rowid IN (SELECT rowid FROM profile_fts "
                         "WHERE profile_fts MATCH ?)")
            args.append(_fts_query(long_terms))
        for term in short_terms:
            # trigram 索引对 1~2 字（尤其中文）不出 token，退回 LIKE
            where.append("u.profile LIKE ? ESCAPE '\\'")
            args.append("%" + _like_escape(term) + "%")

    if section:
        where.append("EXISTS (SELECT 1 FROM user_sections s "
                     "WHERE s.user_id = u.user_id AND s.section = ?)")
        args.append(section)

    if model:
        where.append("u.models LIKE ?")
        args.append("%,%s,%%" % model)

    if day_from:
        where.append("u.last_day >= ?")
        args.append(day_from)
    if day_to:
        where.append("u.first_day <= ?")
        args.append(day_to)
    if min_traces is not None:
        where.append("u.n_traces >= ?")
        args.append(int(min_traces))
    if has_profile:
        where.append("u.profile IS NOT NULL")

    return (" WHERE " + " AND ".join(where)) if where else "", args


def search(conn: sqlite3.Connection, *, fields=None, limit: int = 50,
           offset: int = 0, **filters) -> list[dict]:
    fields = list(fields or ["user_id", "status", "last_day", "n_traces",
                             "models", "sections"])
    bad = [f for f in fields if f not in FIELD_SQL]
    if bad:
        raise ValueError("unknown field(s): %s (可选 %s)"
                         % (", ".join(bad), ", ".join(FIELD_SQL)))
    cols = ", ".join("%s AS %s" % (FIELD_SQL[f], f) for f in fields)
    where, args = _where(**filters)
    limit = max(1, min(int(limit), 100000))
    offset = max(0, int(offset))
    sql = ("SELECT %s FROM users u%s "
           "ORDER BY u.last_day DESC, u.n_traces DESC, u.user_id "
           "LIMIT ? OFFSET ?" % (cols, where))
    rows = [dict(r) for r in conn.execute(sql, [*args, limit, offset])]
    return [_tidy(row) for row in rows]


def _tidy(row: dict) -> dict:
    if "sections" in row and isinstance(row["sections"], str):
        row["sections"] = [s for s in row["sections"].split(",") if s]
    return row


def path_values(conn: sqlite3.Connection, json_path: str, *, limit: int = 50,
                **filters) -> list[dict]:
    where, args = _where(has_profile=True, **filters)
    limit = max(1, min(int(limit), 100000))
    sql = ("SELECT u.user_id, json_extract(u.profile, ?) AS value "
           "FROM users u%s ORDER BY u.last_day DESC, u.n_traces DESC, u.user_id "
           "LIMIT ?" % where)
    out = []
    for row in conn.execute(sql, [json_path, *args, limit]):
        value = row["value"]
        if value is not None:
            try:
                value = json.loads(value)
            except (TypeError, ValueError):
                pass
        out.append({"user_id": row["user_id"], "value": value})
    return out


_SEGMENT = re.compile(r"^([A-Za-z0-9_\-]+)(?:\[(\d+)\])?$")


def to_json_path(dotted: str) -> str:
    """`goals.asset_protection` -> `$."goals"."asset_protection"`。

    只允许字母/数字/下划线/连字符的 key 和 `[n]` 下标，避免把用户输入
    直接拼进 SQL 的 JSON path。
    """
    out = "$"
    for seg in (dotted or "").split("."):
        m = _SEGMENT.match(seg)
        if not m:
            raise ValueError("非法路径段 %r（只支持 name / name[0] 形式）" % seg)
        out += '."%s"' % m.group(1)
        if m.group(2) is not None:
            out += "[%s]" % m.group(2)
    return out


def get_users(conn: sqlite3.Connection, user_ids: list[str]) -> dict[str, dict]:
    """按 user_id 取完整记录（profile 解析成对象），保持调用方顺序。"""
    out: dict[str, dict] = {}
    ids = list(dict.fromkeys(str(u) for u in user_ids if str(u).strip()))
    for i in range(0, len(ids), 500):
        chunk = ids[i:i + 500]
        sql = ("SELECT * FROM users WHERE user_id IN (%s)"
               % ",".join("?" * len(chunk)))
        for row in conn.execute(sql, chunk):
            d = dict(row)
            if d.get("profile"):
                d["profile"] = json.loads(d["profile"])
            out[d["user_id"]] = d
    return out


# ── 统计 ──────────────────────────────────────────────────────────────

def stats(conn: sqlite3.Connection) -> dict:
    db_path = conn.execute("PRAGMA database_list").fetchone()["file"]
    total = conn.execute("SELECT COUNT(*) FROM users").fetchone()[0]
    by_status = {r["status"]: r["n"] for r in conn.execute(
        "SELECT status, COUNT(*) n FROM users GROUP BY status ORDER BY n DESC")}
    real = conn.execute("SELECT COUNT(*) FROM users WHERE is_real = 1").fetchone()[0]
    with_profile = conn.execute(
        "SELECT COUNT(*) FROM users WHERE profile IS NOT NULL").fetchone()[0]
    profile_bytes = conn.execute(
        "SELECT COALESCE(SUM(profile_bytes), 0) FROM users").fetchone()[0]
    days = conn.execute(
        "SELECT MIN(day), MAX(day), COUNT(DISTINCT day) FROM user_days").fetchone()
    files = conn.execute(
        "SELECT COUNT(*), COALESCE(SUM(lines), 0) FROM files").fetchone()
    sections = [dict(r) for r in conn.execute(
        "SELECT section, COUNT(*) n, COALESCE(SUM(n_bytes), 0) bytes "
        "FROM user_sections GROUP BY section ORDER BY n DESC LIMIT 30")]
    return {
        "db": db_path,
        "db_bytes": os.path.getsize(db_path) if db_path and os.path.exists(db_path) else 0,
        "users": total,
        "real_users": real,
        "with_profile": with_profile,
        "profile_mb": round(profile_bytes / 1048576, 1),
        "by_status": by_status,
        "day_min": days[0],
        "day_max": days[1],
        "n_days": days[2],
        "files": files[0],
        "input_lines": files[1],
        "sections": sections,
        "meta": get_meta(conn),
    }
