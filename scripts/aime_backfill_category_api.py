#!/usr/bin/env python3
"""用埋点接口（page_list）补 task_category / subtask_category / taxonomy_version。

接口（只有弗吉尼亚容器能直连，本机不通，所以默认 ssh 转发过去执行）::

    POST http://10.217.216.85:8888/api/v1/proxy/investment-plan/harness/v1/dialog/agent/run/page_list/
    {"run_started_at": [<ET 墙钟起>, <ET 墙钟止>], "page_num": 0, "page_size": 1000, "trace_id": [...]}

接口要点（都实测过，改之前先看 docs/data-server.md）：

* 时间是 **America/New_York 墙钟**（9/10 月 -4，11 月 -5），日期窗必须按记录自身日期换算；
* 时间窗**必填**、跨度 **≤31 天**；`page_size` **≤1000**；`page_num` 从 0 开始；
* `count` 是整窗命中数，**`page_size` 会静默截断返回行** → 必须按 `count` 翻页；
* 整窗翻页会因**排序不稳定**丢/重约 0.03% 的行 → 本脚本按 **trace_id 分批（≤1000/次）** 拉，
  窗口只用来兜住这些 trace 的时间范围；
* HTTP 恒 200，真正结果看 body 的 `status_code`（0 成功 / -2 参数错 / -6 上游异常）；
* 分类字段名就是 `task_category` / `subtask_category`，**没有** `difficulty_level_name`。

口径（用户 2026-11-25 确认）：

* 接口是**唯一源**，`category_meta.json` 只作离线校验（它是接口的不完整快照，实测 43%~76%）
* **只补空值**：已有值的行不覆盖、也不重查（抽检用 `--verify-sample`），避免接口约 10% 的空值把有值冲掉
* 只写 `eval_input.meta` 与归因 `session_meta` 的两/三个字段，其余字节不动
* 9 月是旧标签体系（和 11 月 18 个标签完全不重合），用 `taxonomy_version` 区分：v1=旧，v1.9=新
* 同一 trace 多行时：`turn_index` 相同优先，否则取最大 `turn_index`

用法::

    python3 scripts/aime_backfill_category_api.py --dry-run              # 只统计
    python3 scripts/aime_backfill_category_api.py --since 2026-11-01     # 只补这些日期之后
    python3 scripts/aime_backfill_category_api.py --dates 2026-11-13
    python3 scripts/aime_backfill_category_api.py --verify-sample 200     # 抽检已有值
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time
import urllib.request
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).resolve().parent))
try:
    from aime_backfill_category import _meta_region, _set_field   # 同目录复用字节级改写
except ImportError:                                              # pragma: no cover
    raise SystemExit("缺少同目录的 aime_backfill_category.py：请把两个脚本一起拷到服务器")

SSH = os.environ.get("AIME_SSH", "aime_rsi_data")
DEFAULT_ROOT = "/mnt/aime_eval_ssd"
MODELS = ["aime_expert", "aime_fast"]
IN_DIR = "1_aime/eval_input/0_daily_eval_input"
OUT_DIR = "1_aime/eval_output/0_daily_eval"
CACHE_DIR = "code/3_scripts/cache/aime_backfill_category"
API_URL = ("http://10.217.216.85:8888/api/v1/proxy/investment-plan/"
           "harness/v1/dialog/agent/run/page_list/")
TZ = ZoneInfo("America/New_York")

TID = re.compile(rb'"trace_id"\s*:\s*"([^"]+)"')
RT = re.compile(rb'"request_time"\s*:\s*"(\d{4}-\d\d-\d\d)[T ]')
TURN = re.compile(rb'"turn_index"\s*:\s*(\d+)')
HAS_TASK = re.compile(rb'"task_category"\s*:\s*"')
HEX32 = re.compile(r"^[0-9a-f]{32}$")


def is_hex32(value: str) -> bool:
    """真正的旧家族 hex id：32 位十六进制且含字母。
    新家族的 trace_id 也常是 32 位、但纯数字，不能当 hex 跳过。"""
    return bool(HEX32.match(value)) and not value.isdigit()


def trace_ids(values: list[bytes]) -> list[str]:
    """从一行里的候选 id 中挑真正的 trace_id：数字优先，其次 hex32。"""
    cand = [v.decode("ascii", "ignore") for v in values]
    num = [c for c in cand if c.isdigit()]
    hexa = [c for c in cand if is_hex32(c)]
    return num or hexa

SSH_OPTS = ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=20",
            "-o", "ControlMaster=auto", "-o", "ControlPath=/tmp/ssh-aime-%r@%h:%p",
            "-o", "ControlPersist=10m", SSH]


def maybe_reexec(argv, root: str) -> None:
    """接口只有容器能直连，脚本必须在容器内跑；本机跑就直接报错，不做隐式转发。"""
    if "--local" in argv or os.path.isdir(root):
        return
    raise SystemExit(
        f"[error] 本机没有 {root}：请先 scp 到容器再执行\n"
        f"  scp scripts/aime_backfill_category{{,_api}}.py {SSH}:/mnt/aime_eval_ssd/code/3_scripts/\n"
        f"  ssh {SSH} 'python3 /mnt/aime_eval_ssd/code/3_scripts/aime_backfill_category_api.py --local ...'")


# --------------------------------------------------------------------------- #
# 接口
# --------------------------------------------------------------------------- #
def api_page(window: tuple[str, str], ids: list[str], page_num: int, page_size: int = 1000) -> dict:
    payload = {"run_started_at": [window[0], window[1]], "page_num": page_num,
               "page_size": page_size, "trace_id": ids}
    req = urllib.request.Request(API_URL, data=json.dumps(payload).encode(),
                                 headers={"Content-Type": "application/json"})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                body = json.loads(resp.read())
            break
        except Exception as exc:                      # noqa: BLE001 网络抖动就重试
            if attempt == 2:
                raise RuntimeError(f"接口调用失败：{exc}") from exc
            time.sleep(2)
    code = body.get("status_code")
    if code != 0:
        raise RuntimeError(f"接口返回 status_code={code}：{body.get('status_msg')}")
    return body.get("result") or {}


def fetch_rows(window: tuple[str, str], ids: list[str]) -> list[dict]:
    """按 trace_id 精确拉，按 count 翻页（page_size 会静默截断）。"""
    out: list[dict] = []
    page = 0
    while True:
        res = api_page(window, ids, page)
        rows = res.get("list") or []
        total = int(res.get("count") or 0)
        out.extend(rows)
        page += 1
        if not rows or len(out) >= total or page > 200:
            return out


def et_window(days: list[date]) -> tuple[str, str]:
    """把一批 trace 的日期裹进一个 ET 墙钟窗口（接口按 ET 解释），并留 1 天余量。"""
    lo = min(days) - timedelta(days=1)
    hi = max(days) + timedelta(days=2)
    if (hi - lo).days > 30:                      # 接口上限 31 天
        hi = lo + timedelta(days=30)
    return lo.strftime("%Y-%m-%d 00:00:00"), hi.strftime("%Y-%m-%d 00:00:00")


def pick_row(rows: list[dict], turn_hint: int | None) -> dict | None:
    """一 trace 多行：turn_index 相同优先，否则最大 turn_index。"""
    if not rows:
        return None
    if len(rows) == 1:
        return rows[0]
    if turn_hint is not None:
        same = [r for r in rows if str(r.get("turn_index") or "") == str(turn_hint)]
        if same:
            return same[0]
    return max(rows, key=lambda r: int(r.get("turn_index") or -1))


# --------------------------------------------------------------------------- #
# 扫描目标
# --------------------------------------------------------------------------- #
def scan(base: Path, since: date | None, dates: set[str] | None,
         args, skipped: dict) -> list[dict]:
    """收集「还没填分类」的行：文件、行号、trace_id、turn_index、日期。"""
    todo: list[dict] = []
    for kind, root, pattern in (
        ("input", base / IN_DIR, None),
        ("attribution", base / OUT_DIR, "attribution"),
    ):
        for model in MODELS:
            d = root / model
            if not d.is_dir():
                continue
            for path in sorted(d.glob("*.jsonl")):
                m = re.search(r"(\d{4}-\d\d-\d\d)\.jsonl$", path.name)
                if not m:
                    continue
                day = m.group(1)
                if dates and day not in dates:
                    continue
                if since and date.fromisoformat(day) < since:
                    continue
                if args.days and (date.today() - date.fromisoformat(day)).days > args.days:
                    continue
                with open(path, "rb") as fh:
                    for lineno, line in enumerate(fh):
                        head = line[:65536]
                        if HAS_TASK.search(head):     # 已有值：跳过不查
                            skipped["has_value"] += 1
                            continue
                        raw = TID.findall(line[-4096:]) if kind == "input" else TID.findall(line)
                        tid = trace_ids(raw if kind == "attribution" else raw[-1:])
                        if not tid:
                            skipped["no_trace_id"] += 1
                            continue
                        if args.skip_hex and is_hex32(tid[0]):
                            skipped["hex32"] += 1
                            continue
                        turn = TURN.search(head)
                        rt = RT.search(head)
                        # 用记录自己的日期做 ET 分组：文件里混着跨天迟到的 trace，
                        # 按文件日期开窗会漏掉它们（实测 10-20 漏 1491 条）。
                        et_day = rt.group(1).decode() if rt else day
                        todo.append({"kind": kind, "path": str(path), "day": et_day,
                                     "file_day": day, "lineno": lineno,
                                     "trace_id": tid[0],
                                     "turn": int(turn.group(1)) if turn else None})
    return todo


# --------------------------------------------------------------------------- #
# 写回
# --------------------------------------------------------------------------- #
def patch_fields(line: bytes, key: bytes, fields: dict[str, str]):
    reg = _meta_region(line, key)
    if reg is None:
        return line, False
    start, end = reg
    region = line[start:end]
    new = region
    for k, v in fields.items():
        if v is None:
            continue
        new = _set_field(new, k.encode(), json.dumps(v, ensure_ascii=False).encode())
    if new == region:
        return line, False
    return line[:start] + new + line[end:], True


def write_file(path: Path, by_line: dict[int, dict], dry_run: bool) -> dict:
    st0 = os.stat(path)
    key = b"meta" if "/eval_input/" in str(path) else b"session_meta"
    tmp = path.with_suffix(path.suffix + ".api.tmp")
    changed = 0
    t0 = time.time()
    with open(path, "rb") as src, open(tmp, "wb") as out:
        for lineno, line in enumerate(src):
            fields = by_line.get(lineno)
            if fields:
                new, ok = patch_fields(line, key, fields)
                if ok:
                    changed += 1
                out.write(new)
            else:
                out.write(line)
        out.flush()
        os.fsync(out.fileno())
    stat = {"path": str(path), "changed": changed, "seconds": round(time.time() - t0, 1)}
    if dry_run or not changed:
        os.unlink(tmp)
        stat["written"] = False
        return stat
    st1 = os.stat(path)                              # 读的时候被追加过就不覆盖
    if (st1.st_size, st1.st_mtime_ns) != (st0.st_size, st0.st_mtime_ns):
        os.unlink(tmp)
        stat["written"] = False
        stat["aborted"] = "concurrent_write"
        return stat
    os.replace(tmp, path)
    stat["written"] = True
    return stat


def sync_slim(base: Path, path: Path) -> None:
    """eval_input 重写后把 slim 的 target_files 拉齐（只对输入侧）。"""
    import sqlite3
    st = os.stat(path)
    try:
        con = sqlite3.connect(str(base / "code/3_scripts/1_slim_publish/state/state.sqlite3"), timeout=30)
        con.execute("INSERT OR REPLACE INTO target_files(path,size,mtime,offset,updated_at)"
                    " VALUES(?,?,?,?,?)",
                    (str(path), st.st_size, st.st_mtime, st.st_size,
                     time.strftime("%Y-%m-%d %H:%M:%S")))
        con.commit()
        con.close()
    except Exception as exc:                         # noqa: BLE001 记账失败只告警
        print(f"[warn] 同步 slim 记账失败：{exc}", file=sys.stderr)


# --------------------------------------------------------------------------- #
# 待补队列：全库扫一遍后，把「还没补上」的行记下来；之后轮询只查这些 trace_id
# --------------------------------------------------------------------------- #
def queue_path(cache: Path) -> Path:
    return cache / "pending.jsonl"


def save_queue(cache: Path, items: list[dict]) -> None:
    tmp = queue_path(cache).with_suffix(".tmp")
    with open(tmp, "w", encoding="utf-8") as fh:
        for it in items:
            fh.write(json.dumps({"t": it["trace_id"], "p": it["path"], "l": it["lineno"],
                                 "d": it["day"], "u": it["turn"]}, ensure_ascii=False) + "\n")
    os.replace(tmp, queue_path(cache))


def load_queue(cache: Path) -> list[dict]:
    path = queue_path(cache)
    if not path.exists():
        return []
    out = []
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            try:
                it = json.loads(line)
            except ValueError:
                continue
            out.append({"trace_id": it["t"], "path": it["p"], "lineno": it["l"],
                        "day": it["d"], "turn": it.get("u")})
    return out


def fill_from_api(items: list[dict], batch: int) -> tuple[dict, dict]:
    """查接口，返回 (可填的 {(path,lineno): fields}, 统计)。"""
    by_day: dict[str, list[dict]] = {}
    for item in items:
        by_day.setdefault(item["day"], []).append(item)
    fills: dict[tuple[str, int], dict] = {}
    stats = {"batches": 0, "api_rows": 0, "hit": 0, "miss": 0, "null_value": 0}
    for day in sorted(by_day):
        batch_items = by_day[day]
        ids = sorted({i["trace_id"] for i in batch_items})
        rows: list[dict] = []
        for i in range(0, len(ids), batch):
            rows.extend(fetch_rows(et_window([date.fromisoformat(day)]), ids[i:i + batch]))
            stats["batches"] += 1
        stats["api_rows"] += len(rows)
        by_tid: dict[str, list[dict]] = {}
        for r in rows:
            by_tid.setdefault(str(r.get("trace_id")), []).append(r)
        for item in batch_items:
            row = pick_row(by_tid.get(item["trace_id"]) or [], item["turn"])
            if not row:
                stats["miss"] += 1
                continue
            task, sub = row.get("task_category"), row.get("subtask_category")
            if not task and not sub:
                stats["null_value"] += 1
                continue
            stats["hit"] += 1
            fills[(item["path"], item["lineno"])] = {
                "task_category": task or None,
                "subtask_category": sub or None,
                "taxonomy_version": "v1.9" if date.fromisoformat(day) >= date(2026, 11, 5) else "v1",
            }
        print(f"[api] {day}: ids={len(ids)} rows={len(rows)} 本轮可填={stats['hit']:,}", flush=True)
    return fills, stats


# --------------------------------------------------------------------------- #
# 主流程
# --------------------------------------------------------------------------- #
def main() -> int:
    ap = argparse.ArgumentParser(description="用埋点接口补 task_category / subtask_category")
    ap.add_argument("--root", default=DEFAULT_ROOT)
    ap.add_argument("--local", action="store_true")
    ap.add_argument("--since", help="只处理这个日期之后（YYYY-MM-DD）")
    ap.add_argument("--dates", help="只处理这些日期，逗号分隔")
    ap.add_argument("--batch", type=int, default=1000, help="每次请求的 trace_id 数（≤1000）")
    ap.add_argument("--limit", type=int, default=0, help="只处理前 N 个文件（调试用）")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--verify-sample", type=int, default=0, help="抽检这么多条已有值与接口比对")
    ap.add_argument("--skip-hex", action="store_true", default=True,
                    help="跳过 32 位 hex 老 trace_id（接口查不到，默认开）")
    ap.add_argument("--no-skip-hex", dest="skip_hex", action="store_false")
    ap.add_argument("--days", type=int, default=0, help="只处理最近 N 天（按文件日期）")
    ap.add_argument("--retry", action="store_true", help="只重查 pending 队列（不扫文件）")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args(sys.argv[1:])
    maybe_reexec(sys.argv[1:], args.root)
    base = Path(args.root)

    import fcntl
    cache = base / CACHE_DIR
    cache.mkdir(parents=True, exist_ok=True)
    lock = open(cache / "api.lock", "w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        raise SystemExit("[error] 已有一个实例在跑，跳过本轮")

    t0 = time.time()
    if args.retry:                                   # 只重查队列，不扫文件
        pending = load_queue(cache)
        print(f"[retry] 队列 {len(pending):,} 条待补", flush=True)
        if not pending:
            print("队列为空，无事可做")
            return 0
        fills, st = fill_from_api(pending, args.batch)
        per_file: dict[str, dict[int, dict]] = {}
        for (path, lineno), fields in fills.items():
            per_file.setdefault(path, {})[lineno] = fields
        written = 0
        for path, by_line in per_file.items():
            st2 = write_file(Path(path), by_line, args.dry_run)
            if st2.get("written"):
                written += 1
                if "/eval_input/" in path:
                    sync_slim(base, Path(path))
        left = [it for it in pending if (it["path"], it["lineno"]) not in fills]
        if not args.dry_run:
            save_queue(cache, left)
        print(f"[retry] 新填 {st['hit']:,} 行，落盘 {written} 文件，仍待补 {len(left):,}", flush=True)
        if not args.dry_run:
            with open(cache / "api_yield.jsonl", "a") as fh:
                fh.write(json.dumps({"at": time.strftime("%F %T"), "mode": "retry",
                                     "hit": st["hit"], "written": written,
                                     "left": len(left), "seconds": round(time.time() - t0, 1)},
                                    ensure_ascii=False) + "\n")
        return 0

    since = date.fromisoformat(args.since) if args.since else None
    dates = set(args.dates.split(",")) if args.dates else None
    skipped = {"hex32": 0, "no_trace_id": 0, "has_value": 0}
    todo = scan(base, since, dates, args, skipped)
    print("[info] 待补行 %s（已有值 %s / hex 跳过 %s / 无 trace_id %s）"
          % (f"{len(todo):,}", f"{skipped['has_value']:,}", f"{skipped['hex32']:,}",
             f"{skipped['no_trace_id']:,}"), flush=True)
    if not todo:
        print("无事可做")
        return 0
    if args.limit:
        keep = {t["path"] for t in todo[:args.limit]}
        todo = [t for t in todo if t["path"] in keep]

    # 按日期分批查接口
    by_day: dict[str, list[dict]] = {}
    for item in todo:
        by_day.setdefault(item["day"], []).append(item)
    fills: dict[tuple[str, int], dict] = {}
    stats = {"batches": 0, "api_rows": 0, "hit": 0, "miss": 0, "null_value": 0}
    for day in sorted(by_day):
        items = by_day[day]
        ids = sorted({i["trace_id"] for i in items})
        window = et_window([date.fromisoformat(day)])
        rows: list[dict] = []
        for i in range(0, len(ids), args.batch):
            chunk = ids[i:i + args.batch]
            rows.extend(fetch_rows(window, chunk))
            stats["batches"] += 1
        stats["api_rows"] += len(rows)
        by_tid: dict[str, list[dict]] = {}
        for r in rows:
            by_tid.setdefault(str(r.get("trace_id")), []).append(r)
        for item in items:
            row = pick_row(by_tid.get(item["trace_id"]) or [], item["turn"])
            if not row:
                stats["miss"] += 1
                continue
            task, sub = row.get("task_category"), row.get("subtask_category")
            if not task and not sub:
                stats["null_value"] += 1
                continue
            stats["hit"] += 1
            fills[(item["path"], item["lineno"])] = {
                "task_category": task or None,
                "subtask_category": sub or None,
                "taxonomy_version": "v1.9" if (date.fromisoformat(day) >= date(2026, 11, 5)) else "v1",
            }
        print(f"[api] {day}: ids={len(ids)} rows={len(rows)} 累计可填={stats['hit']:,}", flush=True)

    # 按文件写回
    per_file: dict[str, dict[int, dict]] = {}
    for (path, lineno), fields in fills.items():
        per_file.setdefault(path, {})[lineno] = fields
    results = []
    for path, by_line in sorted(per_file.items()):
        st = write_file(Path(path), by_line, args.dry_run)
        if st.get("written") and "/eval_input/" in path:
            sync_slim(base, Path(path))
        results.append(st)
        print(f"[write] {Path(path).name:34s} {st['changed']:6d} 行 {st['seconds']:5.1f}s"
              f"{'' if st.get('written') else '（未落盘）'}", flush=True)

    left = [it for it in todo if (it["path"], it["lineno"]) not in fills]
    if not args.dry_run:
        if args.days:                                 # 局部扫描：把新出现的待补并进队列
            old = {(it["path"], it["lineno"]): it for it in load_queue(cache)}
            for it in left:
                old[(it["path"], it["lineno"])] = it
            left_all = list(old.values())
        else:                                         # 全量扫描：队列整体重建
            left_all = left
        save_queue(cache, left_all)

    summary = {
        "todo": len(todo), "left": len(left), **stats,
        "files": len(results),
        "written": sum(1 for r in results if r.get("written")),
        "rows": sum(r["changed"] for r in results),
        "seconds": round(time.time() - t0, 1),
    }
    if args.json:
        print(json.dumps(summary, ensure_ascii=False, indent=2))
    else:
        print()
        print("待补 {todo:,} | 命中 {hit:,} | 接口无值 {null_value:,} | 查无 {miss:,}".format(**summary))
        print("文件 {files}（落盘 {written}）| 写入 {rows:,} 行 | 耗时 {seconds}s".format(**summary))
        with open(cache / "api_yield.jsonl", "a") as fh:      # 每轮产出，用来判断上游有没有在补
            fh.write(json.dumps({"at": time.strftime("%F %T"), "since": args.since,
                                 "days": args.days, **summary}, ensure_ascii=False) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
