#!/usr/bin/env python3
"""把 daily eval input 里的用户同步进 KYC 库。

两步，可以分开跑，也可以 `run` 一起跑：

1. `scan`：扫 `0_daily_eval_input/<model>/<date>.jsonl`，抽出 `meta.user_id`，
   增量维护 `files` / `file_contrib` / `user_days` / `users` 的活动度字段。
   文件按 `(size, mtime_ns, ctime_ns)` + 头部 md5 判断：没变跳过、只追加就只读尾巴、
   被重写就整文件重扫（与 `aime_data_inventory.py` 同一套思路）。
2. `fetch`：对还没有画像的真实 user_id 调 KYC 接口（复用冻结版
   `/mnt/aime_eval_ssd/0_litefusion_data/kyc_query/kyc_query.py` 的
   `fetch_label` / `sanitize` / `_check_leak`），脱敏后写进 `users.profile`，
   同时写 `user_sections` 与全文索引。串行 + 限速，默认 0.25s 一次（≤4 QPS）。

`import-legacy` 可以先把手头 `0_litefusion_data/user_kyc` 里已有的脱敏画像
（同一冻结版、同一 policy、同一指纹算法）搬进来，省掉一半重复请求。

不做任何网络操作也能先 `scan`，库里的用户清单立刻可查；`fetch` 可以断点续跑。
"""
from __future__ import annotations

import argparse
import fcntl
import glob
import hashlib
import importlib.util
import json
import os
import re
import sys
import time
from collections import Counter
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone

import kyc_store

INPUT_ROOT = "/mnt/aime_eval_ssd/1_aime/eval_input/0_daily_eval_input"
KYC_TOOL = "/mnt/aime_eval_ssd/0_litefusion_data/kyc_query/kyc_query.py"
#: 既有 lost-user 流水线拉的脱敏画像（同一冻结版、同一 policy），可直接复用
LEGACY_KYC_DIR = "/mnt/aime_eval_ssd/0_litefusion_data/user_kyc"
HEAD_LIMIT = 4096
FETCH_MAX_ATTEMPTS = 5
DECODER = json.JSONDecoder()
_FILE_RE = re.compile(r"/([^/]+)/(\d{4}-\d{2}-\d{2})\.jsonl$")


def log(msg: str) -> None:
    print("[%s] [kyc] %s" % (datetime.now().strftime("%H:%M:%S"), msg), flush=True)


# ── 输入扫描 ──────────────────────────────────────────────────────────

def extract_user_id(raw: bytes) -> str:
    """从一行输入里取 meta.user_id。

    只对 `"meta": {...}` 这段做 `raw_decode`，不解析后面几十 KB 的 traces，
    所以 2.5 GB 的文件也能跑得很快。meta 里没有 user_id 时退回整行 json。
    """
    start = 0
    for _ in range(4):
        i = raw.find(b'"meta"', start)
        if i < 0:
            break
        j = raw.find(b":", i + 6)
        if j < 0:
            break
        chunk = raw[j + 1:j + 1 + 262144].decode("utf-8", "replace")
        try:
            meta, _ = DECODER.raw_decode(chunk)
        except ValueError:
            start = i + 6
            continue
        if isinstance(meta, dict):
            uid = str(meta.get("user_id") or "").strip()
            if uid:
                return uid
        start = i + 6
    try:
        meta = json.loads(raw).get("meta") or {}
        return str(meta.get("user_id") or "").strip()
    except (ValueError, AttributeError):
        return ""


def parse_path(path: str) -> tuple[str, str]:
    """返回 (day, model)。"""
    m = _FILE_RE.search(path)
    if not m:
        raise ValueError("无法从路径解析 model/date：%s" % path)
    return m.group(2), m.group(1)


def _md5_prefix(path: str, n: int) -> str:
    with open(path, "rb") as f:
        return hashlib.md5(f.read(n)).hexdigest()


def scan_range(path: str, offset: int) -> tuple[Counter, int, int]:
    """从 offset 读到最后一个完整换行；返回 (用户计数, 新 offset, 行数)。"""
    counts: Counter = Counter()
    lines = 0
    pos = offset
    with open(path, "rb") as f:
        f.seek(offset)
        for raw in f:
            if not raw.endswith(b"\n"):
                break
            pos += len(raw)
            lines += 1
            uid = extract_user_id(raw)
            if uid:
                counts[uid] += 1
    return counts, pos, lines


@contextmanager
def sync_lock(db_path: str):
    """同一时刻只允许一个写进程；查询不受影响（WAL）。"""
    path = db_path + ".lock"
    with open(path, "w") as fh:
        try:
            fcntl.flock(fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            raise SystemExit("已有另一个 sync 在跑（%s 被占用）" % path)
        try:
            yield
        finally:
            fcntl.flock(fh, fcntl.LOCK_UN)


def scan_inputs(conn, root: str = INPUT_ROOT, *, quiet: bool = False) -> dict:
    paths = sorted(glob.glob(os.path.join(root, "*", "*.jsonl")))
    if not paths:
        raise SystemExit("输入目录没有 jsonl：%s" % root)

    known = {r["path"]: r for r in conn.execute("SELECT * FROM files")}
    removed = set(known) - set(paths)
    changed = 0
    new_lines = 0
    t0 = time.time()

    for path in paths:
        day, model = parse_path(path)
        st = os.stat(path)
        row = known.get(path)
        mode = "full"
        offset = 0
        if row and row["size"] == st.st_size \
                and row["mtime_ns"] == st.st_mtime_ns \
                and row["ctime_ns"] == st.st_ctime_ns:
            continue
        if row and st.st_size > row["size"] and row["head_len"] is not None:
            if _md5_prefix(path, row["head_len"]) == row["head_md5"]:
                mode, offset = "append", row["offset"]

        counts, new_offset, n_lines = scan_range(path, offset)
        new_lines += n_lines
        changed += 1

        if mode == "full":
            conn.execute("DELETE FROM file_contrib WHERE path = ?", (path,))
        conn.executemany(
            "INSERT INTO file_contrib(path, user_id, n_traces) VALUES(?,?,?) "
            "ON CONFLICT(path, user_id) DO UPDATE SET "
            "n_traces = n_traces + excluded.n_traces",
            [(path, uid, n) for uid, n in counts.items()])
        total_lines = n_lines if mode == "full" else (row["lines"] + n_lines)
        head_len = min(HEAD_LIMIT, st.st_size)
        conn.execute(
            "INSERT INTO files(path, day, model, size, mtime_ns, ctime_ns, "
            "head_md5, head_len, offset, lines, updated_at) "
            "VALUES(?,?,?,?,?,?,?,?,?,?,?) "
            "ON CONFLICT(path) DO UPDATE SET day=excluded.day, model=excluded.model, "
            "size=excluded.size, mtime_ns=excluded.mtime_ns, "
            "ctime_ns=excluded.ctime_ns, head_md5=excluded.head_md5, "
            "head_len=excluded.head_len, offset=excluded.offset, "
            "lines=excluded.lines, updated_at=excluded.updated_at",
            (path, day, model, st.st_size, st.st_mtime_ns, st.st_ctime_ns,
             _md5_prefix(path, head_len), head_len, new_offset,
             total_lines, kyc_store.utcnow()))
        if not quiet:
            log("扫描 %-55s %s 行 %s 用户 %s"
                % (os.path.relpath(path, root), n_lines, len(counts), mode))

    for path in removed:
        conn.execute("DELETE FROM file_contrib WHERE path = ?", (path,))
        conn.execute("DELETE FROM files WHERE path = ?", (path,))
        changed += 1
        if not quiet:
            log("移除已不存在的输入文件 %s" % path)

    if changed:
        rebuild_derived(conn)
        kyc_store.set_meta(conn, "last_scan_at", kyc_store.utcnow())
        conn.commit()

    total_users = conn.execute("SELECT COUNT(*) FROM users").fetchone()[0]
    log("扫描完成：%d 个文件（变化 %d，新读 %d 行），用户 %d，耗时 %.1fs"
        % (len(paths), changed, new_lines, total_users, time.time() - t0))
    return {"files": len(paths), "changed": changed, "lines": new_lines,
            "users": total_users}


def rebuild_derived(conn) -> None:
    """从 file_contrib 重算 user_days 和 users 的活动度字段。

    全量重算（约 30 万行）比做增量减账更不容易错；一次一两秒。
    """
    conn.execute("DELETE FROM user_days")
    conn.execute(
        "INSERT INTO user_days(user_id, day, model, n_traces) "
        "SELECT c.user_id, f.day, f.model, SUM(c.n_traces) "
        "FROM file_contrib c JOIN files f ON f.path = c.path "
        "GROUP BY c.user_id, f.day, f.model")

    # 不再出现在输入里的用户，活动度归零（profile 仍保留）
    conn.execute("UPDATE users SET n_traces = 0, first_day = NULL, "
                 "last_day = NULL, models = ''")

    rows = conn.execute(
        "SELECT user_id, SUM(n_traces) n, MIN(day) fd, MAX(day) ld, "
        "GROUP_CONCAT(DISTINCT model) models "
        "FROM user_days GROUP BY user_id").fetchall()
    now = kyc_store.utcnow()
    payload = []
    for r in rows:
        uid = r["user_id"]
        real = kyc_store.is_real_user_id(uid)
        models = "," + ",".join(sorted(set((r["models"] or "").split(",")))) + ","
        payload.append((uid, _fingerprint(uid), 1 if real else 0,
                        "pending" if real else "skipped",
                        None if real else "non_real_user_id",
                        r["fd"], r["ld"], r["n"], models, now))
    conn.executemany(
        "INSERT INTO users(user_id, user_id_fp, is_real, status, error, "
        "first_day, last_day, n_traces, models, created_at) "
        "VALUES(?,?,?,?,?,?,?,?,?,?) "
        "ON CONFLICT(user_id) DO UPDATE SET is_real=excluded.is_real, "
        "first_day=excluded.first_day, last_day=excluded.last_day, "
        "n_traces=excluded.n_traces, models=excluded.models, "
        "user_id_fp=COALESCE(users.user_id_fp, excluded.user_id_fp)",
        payload)


def _fingerprint(uid: str) -> str:
    return hashlib.sha256(("aime-lost-user:%s" % uid).encode("utf-8")).hexdigest()[:16]


def _iso_from_legacy(value) -> str | None:
    """把老台账的 `2026-11-17 11:09:00`（UTC）转成 ISO Z；解析不了返回 None。"""
    text = str(value or "").strip()
    if not text:
        return None
    try:
        dt = datetime.strptime(text, "%Y-%m-%d %H:%M:%S")
    except ValueError:
        try:
            dt = datetime.strptime(text, "%Y-%m-%dT%H:%M:%SZ")
        except ValueError:
            return None
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def import_legacy(conn, src: str = LEGACY_KYC_DIR, *, overwrite: bool = False) -> dict:
    """导入既有 `0_litefusion_data/user_kyc/<shard>/<uid>.json` 里的脱敏画像。

    这些是同一冻结版、同一 `keep-assets-mask-money-v2` 策略拉的，指纹算法一致。
    只导入 daily eval input 里的真实 user；默认只填 `pending`/`error`，不动已拉到的。
    """
    paths = sorted(glob.glob(os.path.join(src, "[0-9][0-9]", "*.json")))
    if not paths:
        raise SystemExit("没有可导入的既有画像：%s" % src)
    status = {r["user_id"]: r["status"] for r in conn.execute(
        "SELECT user_id, status FROM users WHERE is_real = 1")}
    counts: Counter = Counter()
    t0 = time.time()

    for i, path in enumerate(paths, 1):
        uid = os.path.basename(path)[:-5]
        if uid not in status:
            counts["not_ours"] += 1
            continue
        if not overwrite and status[uid] not in ("pending", "error"):
            counts["kept"] += 1
            continue
        try:
            with open(path, encoding="utf-8") as fh:
                data = json.load(fh)
        except (OSError, ValueError):
            counts["bad"] += 1
            continue
        profile = data.get("profile")
        if not isinstance(profile, dict) or not profile:
            counts["bad"] += 1
            continue
        if data.get("user_id_fp") and data["user_id_fp"] != _fingerprint(uid):
            counts["fp_mismatch"] += 1
            continue

        body = json.dumps(profile, ensure_ascii=False)
        sections = [(uid, key, len(json.dumps(value, ensure_ascii=False)))
                    for key, value in profile.items() if not key.startswith("_")]
        conn.execute(
            "UPDATE users SET status = 'ok', error = NULL, profile = ?, "
            "profile_bytes = ?, n_sections = ?, kyc_create_time = ?, "
            "kyc_update_time = ?, fetched_at = COALESCE(?, fetched_at), "
            "user_id_fp = COALESCE(user_id_fp, ?) WHERE user_id = ?",
            (body, len(body.encode("utf-8")), len(sections),
             profile.get("_createTime"), profile.get("_updateTime"),
             _iso_from_legacy(data.get("fetched_at")), _fingerprint(uid), uid))
        conn.execute("DELETE FROM user_sections WHERE user_id = ?", (uid,))
        conn.executemany(
            "INSERT INTO user_sections(user_id, section, n_bytes) VALUES(?,?,?)",
            sections)
        counts["imported"] += 1
        if i % 500 == 0:
            conn.commit()
            log("导入进度 %d/%d（已导入 %d）" % (i, len(paths), counts["imported"]))

    conn.commit()
    kyc_store.set_meta(conn, "last_import_at", kyc_store.utcnow())
    conn.commit()
    for key in ("imported", "kept", "bad", "fp_mismatch", "not_ours"):
        counts.setdefault(key, 0)
    log("导入完成：%s，耗时 %.1fs" % (dict(counts), time.time() - t0))
    return {"total": len(paths), **counts}


# ── KYC 拉取 ──────────────────────────────────────────────────────────

def load_kyc_tool(path: str | None = None):
    path = path or os.environ.get("KYC_QUERY_PY") or KYC_TOOL
    spec = importlib.util.spec_from_file_location("kyc_query_frozen", path)
    if spec is None or spec.loader is None:
        raise SystemExit("加载不了冻结版 KYC 工具：%s" % path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def fetch_candidates(conn, *, include_nonreal=False, retry_errors=False,
                     refresh_days=0) -> list:
    conds = ["status = 'pending'"]
    args: list = []
    if include_nonreal:
        conds.append("status = 'skipped'")
    if retry_errors:
        conds.append("(status = 'error' AND attempts < ?)")
        args.append(FETCH_MAX_ATTEMPTS)
    if refresh_days:
        cutoff = (datetime.now(timezone.utc)
                  - timedelta(days=refresh_days)).strftime("%Y-%m-%dT%H:%M:%SZ")
        conds.append("(status IN ('ok', 'empty') AND "
                     "(fetched_at IS NULL OR fetched_at < ?))")
        args.append(cutoff)
    sql = ("SELECT user_id, status FROM users WHERE (%s) "
           "ORDER BY CASE status WHEN 'pending' THEN 0 WHEN 'skipped' THEN 1 "
           "WHEN 'error' THEN 2 ELSE 3 END, n_traces DESC, user_id"
           % " OR ".join(conds))
    return conn.execute(sql, args).fetchall()


def fetch_one(conn, tool, user_id: str, old_status: str) -> str:
    data, info = tool.fetch_label(user_id)
    now = kyc_store.utcnow()
    fingerprint = tool.user_fingerprint(user_id)

    if data is None:
        error = str((info or {}).get("error") or "fetch_failed")[:300]
        if old_status in ("ok", "empty"):
            # 刷新失败：保留旧画像，只记错误，下个刷新周期再试
            conn.execute("UPDATE users SET attempts = attempts + 1, "
                         "fetched_at = ?, error = ? WHERE user_id = ?",
                         (now, error, user_id))
        else:
            conn.execute("UPDATE users SET status = 'error', attempts = attempts + 1, "
                         "fetched_at = ?, error = ? WHERE user_id = ?",
                         (now, error, user_id))
        return "error"

    if not data:  # 接口返回 data:{} —— 该 user 没有画像
        conn.execute("UPDATE users SET status = 'empty', attempts = attempts + 1, "
                     "fetched_at = ?, error = NULL, profile = NULL, "
                     "profile_bytes = NULL, n_sections = NULL, "
                     "kyc_create_time = NULL, kyc_update_time = NULL "
                     "WHERE user_id = ?", (now, user_id))
        conn.execute("DELETE FROM user_sections WHERE user_id = ?", (user_id,))
        return "empty"

    safe = tool.sanitize(data)
    ok, hits = tool._check_leak(safe, data)
    if not ok:
        error = "leak:" + json.dumps(hits[:3], ensure_ascii=False)[:300]
        conn.execute("UPDATE users SET status = 'leak', attempts = attempts + 1, "
                     "fetched_at = ?, error = ? WHERE user_id = ?",
                     (now, error, user_id))
        return "leak"

    profile = json.dumps(safe, ensure_ascii=False)
    sections = [(user_id, key, len(json.dumps(value, ensure_ascii=False)))
                for key, value in safe.items() if not key.startswith("_")]
    conn.execute(
        "UPDATE users SET status = 'ok', error = NULL, attempts = attempts + 1, "
        "fetched_at = ?, profile = ?, profile_bytes = ?, n_sections = ?, "
        "kyc_create_time = ?, kyc_update_time = ?, "
        "user_id_fp = COALESCE(user_id_fp, ?) WHERE user_id = ?",
        (now, profile, len(profile.encode("utf-8")), len(sections),
         safe.get("_createTime"), safe.get("_updateTime"), fingerprint, user_id))
    conn.execute("DELETE FROM user_sections WHERE user_id = ?", (user_id,))
    conn.executemany(
        "INSERT INTO user_sections(user_id, section, n_bytes) VALUES(?,?,?)",
        sections)
    return "ok"


def fetch_users(conn, *, limit=0, interval=0.25, include_nonreal=False,
                retry_errors=False, refresh_days=0, tool=None) -> dict:
    todo = fetch_candidates(conn, include_nonreal=include_nonreal,
                            retry_errors=retry_errors,
                            refresh_days=refresh_days)
    total = len(todo)
    if limit:
        todo = todo[:limit]
    log("待拉取 %d（本轮 %d，间隔 %.2fs）" % (total, len(todo), interval))
    if not todo:
        return {"total": 0, "ok": 0, "empty": 0, "leak": 0, "error": 0}

    tool = tool or load_kyc_tool()
    counts = Counter()
    t0 = time.time()
    for i, row in enumerate(todo, 1):
        uid = row["user_id"]
        t_start = time.time()
        try:
            status = fetch_one(conn, tool, uid, row["status"])
        except Exception as exc:  # noqa: BLE001  单条异常不拖垮整轮
            status = "error"
            conn.execute(
                "UPDATE users SET status = 'error', attempts = attempts + 1, "
                "fetched_at = ?, error = ? WHERE user_id = ?",
                (kyc_store.utcnow(),
                 ("%s: %s" % (type(exc).__name__, exc))[:300], uid))
        counts[status] += 1
        if i % 25 == 0:
            conn.commit()
        if i % 100 == 0 or i == len(todo):
            elapsed = time.time() - t0
            rate = i / elapsed if elapsed else 0
            eta = (len(todo) - i) / rate / 60 if rate else 0
            log("进度 %d/%d  成功 %d 空 %d leak %d 失败 %d  "
                "%.2f 条/秒  ETA %.0f 分钟"
                % (i, len(todo), counts["ok"], counts["empty"],
                   counts["leak"], counts["error"], rate, eta))
        # 限速按请求起点间隔算
        wait = interval - (time.time() - t_start)
        if wait > 0:
            time.sleep(wait)
    conn.commit()
    kyc_store.set_meta(conn, "last_fetch_at", kyc_store.utcnow())
    conn.commit()
    log("本轮完成：%s，耗时 %.1f 分钟"
        % (dict(counts), (time.time() - t0) / 60))
    return {"total": len(todo), **counts}


def run(conn, root: str, **fetch_kwargs) -> None:
    scan_inputs(conn, root)
    fetch_users(conn, **fetch_kwargs)


def loop(conn, root: str, interval_min: float, db_path: str,
         **fetch_kwargs) -> None:
    """每轮单独持锁：休眠期间不占锁，手动 `run`/`fetch` 可以直接插进来。"""
    while True:
        try:
            with sync_lock(db_path):
                run(conn, root, **fetch_kwargs)
        except KeyboardInterrupt:
            raise
        except SystemExit as exc:  # 锁被手动同步占着：本轮跳过
            log("跳过本轮：%s" % exc)
        except Exception as exc:  # noqa: BLE001  守护进程不因一次失败退出
            log("本轮失败：%s: %s" % (type(exc).__name__, exc))
            try:
                conn.rollback()
            except Exception:  # noqa: BLE001
                pass
        log("休眠 %.0f 分钟后进入下一轮" % interval_min)
        time.sleep(interval_min * 60)


def cmd_status(conn) -> None:
    s = kyc_store.stats(conn)
    print(json.dumps(s, ensure_ascii=False, indent=2))


# ── CLI ───────────────────────────────────────────────────────────────

def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(description="同步 daily eval input 用户到 KYC 库")
    ap.add_argument("--db", default=None, help="库路径（默认脚本同目录 kyc.sqlite3）")
    ap.add_argument("--root", default=INPUT_ROOT, help="daily eval input 根目录")
    sub = ap.add_subparsers(dest="cmd", required=True)

    sub.add_parser("scan", help="只扫输入，维护用户清单与活动度")
    sub.add_parser("status", help="看库统计")

    p = sub.add_parser("import-legacy",
                       help="导入 0_litefusion_data/user_kyc 里已有的脱敏画像")
    p.add_argument("--src", default=LEGACY_KYC_DIR)
    p.add_argument("--overwrite", action="store_true",
                   help="连已拉到的 ok/empty/leak 也覆盖（默认只填 pending/error）")

    def fetch_args(p):
        p.add_argument("--limit", type=int, default=0, help="本轮最多拉多少个")
        p.add_argument("--interval", type=float, default=0.25,
                       help="请求间隔秒，默认 0.25（≤4 QPS）")
        p.add_argument("--include-nonreal", action="store_true",
                       help="也拉非真实 id（默认 skipped）")
        p.add_argument("--retry-errors", action="store_true",
                       help="重试 status=error 的（最多 %d 次）" % FETCH_MAX_ATTEMPTS)
        p.add_argument("--refresh-days", type=float, default=0,
                       help="刷新 N 天前拉过的 ok/empty 用户（默认不刷新）")

    p = sub.add_parser("fetch", help="拉 KYC（scan 之后跑）")
    fetch_args(p)
    p = sub.add_parser("run", help="scan + fetch")
    fetch_args(p)
    p = sub.add_parser("loop", help="scan + fetch 循环")
    fetch_args(p)
    p.add_argument("--interval-min", type=float, default=360,
                   help="循环间隔分钟，默认 360")
    return ap


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    conn = kyc_store.connect(args.db)
    kyc_store.ensure_schema(conn)

    if args.cmd == "status":
        cmd_status(conn)
        return 0
    if args.cmd == "import-legacy":
        with sync_lock(args.db or kyc_store.default_db_path()):
            import_legacy(conn, args.src, overwrite=args.overwrite)
        return 0
    if args.cmd == "scan":
        with sync_lock(kyc_store.default_db_path() if not args.db else args.db):
            scan_inputs(conn, args.root)
        return 0

    fetch_kwargs = dict(limit=args.limit, interval=args.interval,
                        include_nonreal=args.include_nonreal,
                        retry_errors=args.retry_errors,
                        refresh_days=args.refresh_days)
    db_path = args.db or kyc_store.default_db_path()
    if args.cmd == "loop":
        loop(conn, args.root, args.interval_min, db_path, **fetch_kwargs)
        return 0
    with sync_lock(db_path):
        if args.cmd == "fetch":
            fetch_users(conn, **fetch_kwargs)
        elif args.cmd == "run":
            run(conn, args.root, **fetch_kwargs)
    return 0


if __name__ == "__main__":
    sys.exit(main())
