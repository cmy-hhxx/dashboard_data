#!/usr/bin/env python3
"""把上线埋点里的 task_category / subtask_category 灌进评测输入与归因输出。

来源（上游采集器 ``lf_collector.py`` 的按天回填产物，一天一个文件）::

    /mnt/aime_eval_ssd/0_litefusion_data/online_data/<Y>/<M>/<D>/category_meta.json
    {"<trace_id>": {"trace_id": ..., "task_category": "...", "subtask_category": ...}, ...}

目标::

    eval_input/0_daily_eval_input/<model>/<date>.jsonl        -> meta.task_category / meta.subtask_category
    eval_output/0_daily_eval/<model>/<model>_attribution-<date>.jsonl -> session_meta.task_category / session_meta.subtask_category

口径：

* 索引取**所有日期** category_meta.json 的并集（同一天的文件不足以覆盖：11-13 曾被合并重写、
  归因按评测日归档而不是按 trace 日归档）。实测并集比同日高 13~40 个百分点，跨日期无冲突。
* 只写查得到的 trace；查不到的保持 ``null``，不造数、不按 session 推断。
* 就是「补字段」：在 ``meta`` / ``session_meta`` 对象里替换同名字段的值，没有该字段就插到对象开头，
  其余字节一律不动；写临时文件 + fsync + ``os.replace``，写完把该行重新 json 解析校验。
* ``slim_publish`` 的 ``state.sqlite3.target_files`` 用 offset==size 记账；重写后必须把
  ``(size, mtime, offset=新size)`` 同步回去，否则它会把文件中部当成新增尾巴重扫。

用法::

    python3 scripts/aime_backfill_category.py              # 笔记本上跑，自动 ssh 到弗吉尼亚
    python3 scripts/aime_backfill_category.py --local      # 直接在服务器上跑
    python3 scripts/aime_backfill_category.py --dry-run    # 只统计，不落盘
    python3 scripts/aime_backfill_category.py --json       # 机器可读输出
    python3 scripts/aime_backfill_category.py --force      # 忽略「文件没变就跳过」
"""

from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import os
import re
import sqlite3
import subprocess
import sys
import time
from pathlib import Path

SSH = os.environ.get("AIME_SSH", "aime_rsi_data")
DEFAULT_ROOT = "/mnt/aime_eval_ssd"
MODELS = ["aime_expert", "aime_fast"]

RAW_DIR = "0_litefusion_data/online_data"
IN_DIR = "1_aime/eval_input/0_daily_eval_input"
OUT_DIR = "1_aime/eval_output/0_daily_eval"
SLIM_DB = "code/3_scripts/1_slim_publish/state/state.sqlite3"
CACHE_DIR = "code/3_scripts/cache/aime_backfill_category"

TID = re.compile(rb'"trace_id"\s*:\s*"([^"]+)"')
RAW_DATE = re.compile(r"/(\d{4})/(\d{2})/(\d{2})/category_meta\.json$")

SSH_OPTS = [
    "ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=20",
    "-o", "ControlMaster=auto", "-o", "ControlPath=/tmp/ssh-aime-%r@%h:%p",
    "-o", "ControlPersist=10m", SSH,
]


# --------------------------------------------------------------------------- #
# 远程转发：本机看不到数据根目录时，把脚本本身通过 ssh 投到远端 python3 执行
# --------------------------------------------------------------------------- #
def maybe_reexec(argv, root: str) -> None:
    if "--local" in argv or os.path.isdir(root):
        return
    src = Path(__file__).read_bytes()
    args = [a for a in argv if a not in ("--remote",)]
    print(f"[info] 本机没有 {root}，转发到 {SSH} 执行", file=sys.stderr)
    for attempt in range(1, 4):
        proc = subprocess.run(SSH_OPTS + ["python3", "-"] + args, input=src)
        if proc.returncode == 0:
            sys.exit(0)
        if attempt < 3:
            print(f"[warn] ssh 第 {attempt} 次失败（exit {proc.returncode}），3 秒后重试",
                  file=sys.stderr)
            time.sleep(3)
    print("[error] ssh 连续失败，检查网络或 ControlMaster 状态", file=sys.stderr)
    sys.exit(proc.returncode or 1)


# --------------------------------------------------------------------------- #
# 索引
# --------------------------------------------------------------------------- #
def load_index(base: Path) -> dict:
    """并集所有 category_meta.json：trace_id -> (task_category, subtask_category)。"""
    index: dict[str, tuple[str, str]] = {}
    per_date: dict[str, int] = {}
    conflicts = 0
    fingerprint = hashlib.sha1()
    roots = sorted((base / RAW_DIR).glob("*/[0-9][0-9]/[0-9][0-9]/category_meta.json"))
    for path in roots:
        m = RAW_DATE.search(str(path))
        if not m:
            continue
        date = f"{m.group(1)}-{m.group(2)}-{m.group(3)}"
        try:
            raw = path.read_bytes()
        except OSError as exc:
            print(f"[warn] 读不到 {path}：{exc}", file=sys.stderr)
            continue
        # 指纹按内容算，不按 mtime：上游回填会整文件重写（内容可能一模一样），
        # 按 mtime 记指纹会把没变的文件也判成失效，白扫 16 GB。
        fingerprint.update(f"{date}:{len(raw)}:{hashlib.md5(raw).hexdigest()}\n".encode())
        try:
            data = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, ValueError) as exc:
            print(f"[warn] 跳过损坏的 {path}：{exc}", file=sys.stderr)
            continue
        if not isinstance(data, dict):
            print(f"[warn] 跳过非 dict 形态的 {path}", file=sys.stderr)
            continue
        n = 0
        for tid, item in data.items():
            if not isinstance(item, dict):
                continue
            pair = (item.get("task_category"), item.get("subtask_category"))
            if not pair[0] and not pair[1]:
                continue
            old = index.get(str(tid))
            if old is not None and old != pair:
                conflicts += 1
            index[str(tid)] = pair
            n += 1
        per_date[date] = n
    return {
        "index": index,
        "per_date": per_date,
        "conflicts": conflicts,
        "fingerprint": fingerprint.hexdigest()[:16],
    }


# --------------------------------------------------------------------------- #
# 单行改写：只在 meta / session_meta 对象内部动字节
# --------------------------------------------------------------------------- #
def _meta_region(line: bytes, key: bytes) -> tuple[int, int] | None:
    """定位顶层 meta 对象的 [start, end)（含花括号），字符串感知的括号配对。"""
    i = line.find(b'"' + key + b'"')
    if i < 0 or i > 65536:
        return None
    j = line.find(b"{", i)
    if j < 0:
        return None
    depth = 0
    in_str = esc = False
    k = j
    while k < len(line):
        c = line[k]
        if in_str:
            if esc:
                esc = False
            elif c == 0x5C:
                esc = True
            elif c == 0x22:
                in_str = False
        elif c == 0x22:
            in_str = True
        elif c == 0x7B:
            depth += 1
        elif c == 0x7D:
            depth -= 1
            if depth == 0:
                return j, k + 1
        k += 1
    return None


WS = b" \t\r\n"


def _skip_string(buf: bytes, i: int) -> int:
    """buf[i] 是开引号；返回闭引号之后的偏移。"""
    i += 1
    while i < len(buf):
        c = buf[i]
        if c == 0x5C:
            i += 2
            continue
        if c == 0x22:
            return i + 1
        i += 1
    return i


def _skip_value(buf: bytes, i: int) -> int:
    """跳过 JSON 值；buf[i] 是值的第一个字节。"""
    c = buf[i]
    if c == 0x22:
        return _skip_string(buf, i)
    if c in (0x7B, 0x5B):                       # { [
        depth = 0
        while i < len(buf):
            c = buf[i]
            if c == 0x22:
                i = _skip_string(buf, i)
                continue
            if c in (0x7B, 0x5B):
                depth += 1
            elif c in (0x7D, 0x5D):
                depth -= 1
                if depth == 0:
                    return i + 1
            i += 1
        return i
    while i < len(buf) and buf[i] not in b",}]" + WS:
        i += 1
    return i


def _top_fields(region: bytes) -> dict[bytes, tuple[int, int]]:
    """返回对象**第一层**的 {key: (值起, 值止)}；嵌套同名键不会被误认。"""
    out: dict[bytes, tuple[int, int]] = {}
    i, n = 1, len(region)
    while i < n:
        while i < n and region[i] in b"," + WS:
            i += 1
        if i >= n or region[i] != 0x22:          # 只认键（字符串）
            break
        kstart = i
        ke = _skip_string(region, i)
        key = region[kstart + 1:ke - 1]
        i = ke
        while i < n and region[i] in WS:
            i += 1
        if i >= n or region[i] != 0x3A:          # :
            break
        i += 1
        while i < n and region[i] in WS:
            i += 1
        vstart = i
        i = _skip_value(region, i)
        out[key] = (vstart, i)
    return out


def _set_field(region: bytes, key: bytes, value: bytes) -> bytes:
    """把 region 里顶层的 `"key": <值>` 换成 value；没有该字段就插到对象开头。"""
    span = _top_fields(region).get(key)
    if span is None:
        return region[:1] + b'"' + key + b'":' + value + b"," + region[1:]
    start, end = span
    if region[start:end] == value:               # 已经是目标值，算命中不改
        return region
    return region[:start] + value + region[end:]


def patch_line(line: bytes, key: bytes, task: str, subtask: str):
    """返回 (新行, 是否改动, 失败原因或 None)。"""
    reg = _meta_region(line, key)
    if reg is None:
        return line, False, "no_meta"
    start, end = reg
    region = line[start:end]
    new_region = _set_field(region, b"task_category", json.dumps(task, ensure_ascii=False).encode())
    new_region = _set_field(new_region, b"subtask_category",
                            json.dumps(subtask, ensure_ascii=False).encode())
    if new_region == region:
        return line, False, None
    new_line = line[:start] + new_region + line[end:]
    try:                                    # 改完必须还能解析，且值确实写进去了
        rec = json.loads(new_line)
        meta = rec.get(key.decode()) or {}
        if meta.get("task_category") != task or meta.get("subtask_category") != subtask:
            return line, False, "verify"
    except ValueError:
        return line, False, "verify"
    return new_line, True, None


# --------------------------------------------------------------------------- #
# 单文件处理
# --------------------------------------------------------------------------- #
def process_file(path: Path, index: dict, key: bytes, dry_run: bool) -> dict:
    st0 = os.stat(path)
    tmp = path.with_suffix(path.suffix + ".catfill.tmp")
    stat = {"path": str(path), "lines": 0, "changed": 0, "already": 0,
            "no_trace": 0, "no_index": 0, "no_meta": 0, "bad": 0, "conflict": 0,
            "bytes0": st0.st_size, "bytes1": st0.st_size}
    t0 = time.time()
    src = open(path, "rb")
    out = None if dry_run else open(tmp, "wb")
    try:
        for line in src:
            if not line.endswith(b"\n"):        # 末尾半行：原样保留，不碰
                if out:
                    out.write(line)
                continue
            stat["lines"] += 1
            # 认哪个 trace_id：
            #   输入侧取**最后一个**——2026-11-09 之前的旧行 meta.trace_id 存的是 thread_xxx（session id），
            #   真正的 trace_id 是行尾顶层那个字段；新行两者相同。
            #   归因侧取**第一个**——它在 session_meta.trace_id，后面 turns 里的可能属于别的 trace。
            m = TID.findall(line[:65536]) or TID.findall(line[-4096:]) or TID.findall(line)
            if not m:
                stat["no_trace"] += 1
                if out:
                    out.write(line)
                continue
            tid = m[0] if key == b"session_meta" else m[-1]
            if key == b"session_meta":
                # 会话级归因：旧行的 session_meta.trace_id 是 thread_xxx，真正的 trace 在 turns 里。
                # 取这一行所有 trace_id 的分类，一致才填；不一致就留空（不猜）。
                pairs = {index[t.decode("ascii", "ignore")] for t in set(m)
                         if t.decode("ascii", "ignore") in index}
                if len(pairs) > 1:
                    stat["conflict"] += 1
                    if out:
                        out.write(line)
                    continue
                pair = pairs.pop() if pairs else None
            else:
                pair = index.get(tid.decode("ascii", "ignore"))
            if pair is None or not (pair[0] or pair[1]):
                stat["no_index"] += 1
                if out:
                    out.write(line)
                continue
            new_line, changed, why = patch_line(line, key, pair[0] or "", pair[1] or "")
            if why == "no_meta":
                stat["no_meta"] += 1
            elif why == "verify":
                stat["bad"] += 1
            if changed:
                stat["changed"] += 1
            elif why is None:
                stat["already"] += 1
            if out:
                out.write(new_line)
        if out:
            out.flush()
            os.fsync(out.fileno())
    finally:
        src.close()
        if out:
            out.close()

    if dry_run or not stat["changed"]:
        if not dry_run:
            os.unlink(tmp)
        stat["seconds"] = round(time.time() - t0, 1)
        stat["written"] = False
        return stat

    # 读的过程中被别人追加过就别覆盖（原子替换会吃掉那些行）
    st1 = os.stat(path)
    if (st1.st_size, st1.st_mtime_ns) != (st0.st_size, st0.st_mtime_ns):
        os.unlink(tmp)
        stat["seconds"] = round(time.time() - t0, 1)
        stat["written"] = False
        stat["aborted"] = "concurrent_write"
        return stat

    stat["bytes1"] = os.path.getsize(tmp)
    os.replace(tmp, path)
    stat["written"] = True
    stat["seconds"] = round(time.time() - t0, 1)
    return stat


def sync_slim_state(db: Path, path: Path) -> str:
    """重写目标文件后把 target_files 的 (size, mtime, offset) 拉成新值。"""
    if not db.exists():
        return "no_db"
    st = os.stat(path)
    stamp = time.strftime("%Y-%m-%d %H:%M:%S")
    for attempt in range(5):
        try:
            con = sqlite3.connect(str(db), timeout=30)
            try:
                con.execute(
                    "INSERT OR REPLACE INTO target_files(path, size, mtime, offset, updated_at)"
                    " VALUES(?,?,?,?,?)",
                    (str(path), st.st_size, st.st_mtime, st.st_size, stamp),
                )
                con.commit()
            finally:
                con.close()
            return "ok"
        except sqlite3.OperationalError as exc:
            if attempt == 4:
                return f"fail:{exc}"
            time.sleep(2)
    return "fail"


# --------------------------------------------------------------------------- #
# 主流程
# --------------------------------------------------------------------------- #
def targets(base: Path) -> list[tuple[str, Path]]:
    out: list[tuple[str, Path]] = []
    for model in MODELS:
        for path in sorted((base / IN_DIR / model).glob("*.jsonl")):
            out.append(("input", path))
    for model in MODELS:
        for path in sorted((base / OUT_DIR / model).glob(f"{model}_attribution-*.jsonl")):
            out.append(("attribution", path))
    return out


def load_state(cache: Path) -> dict:
    try:
        return json.loads((cache / "state.json").read_text())
    except (OSError, ValueError):
        return {}


def main() -> int:
    ap = argparse.ArgumentParser(description="把 category_meta.json 的分类字段灌进 eval_input / eval_output")
    ap.add_argument("--root", default=DEFAULT_ROOT)
    ap.add_argument("--local", action="store_true", help="强制本地执行（不 ssh）")
    ap.add_argument("--remote", action="store_true", help="强制走 ssh（内部使用）")
    ap.add_argument("--dry-run", action="store_true", help="只统计，不落盘")
    ap.add_argument("--force", action="store_true", help="忽略「文件没变就跳过」")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args(sys.argv[1:])

    maybe_reexec(sys.argv[1:], args.root)
    base = Path(args.root)
    if not base.is_dir():
        print(f"[error] 本机看不到 {args.root}，且无法 ssh 到 {SSH}", file=sys.stderr)
        return 2

    cache = base / CACHE_DIR
    cache.mkdir(parents=True, exist_ok=True)
    lock_fh = open(cache / "lock", "w")
    try:
        fcntl.flock(lock_fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        print("[error] 已有实例在跑", file=sys.stderr)
        return 1

    t0 = time.time()
    idx = load_index(base)
    index = idx["index"]
    if not index:
        print("[error] 一个 category_meta.json 都没找到，无事可做", file=sys.stderr)
        return 2

    state = load_state(cache)
    files = targets(base)
    results = []
    skipped = 0
    for kind, path in files:
        key = b"meta" if kind == "input" else b"session_meta"
        prev = state.get(str(path)) or {}
        if not args.force and prev.get("fingerprint") == idx["fingerprint"]:
            try:
                st = os.stat(path)
            except OSError:
                st = None
            if st and prev.get("size") == st.st_size and prev.get("mtime_ns") == st.st_mtime_ns:
                skipped += 1
                continue
        st = process_file(path, index, key, args.dry_run)
        st["kind"] = kind
        if not args.dry_run:
            if st.get("written"):
                st["slim_state"] = sync_slim_state(base / SLIM_DB, path)
            try:        # 没改也记账：下次只要文件和分类源都没变就直接跳过
                st2 = os.stat(path)
                state[str(path)] = {"size": st2.st_size, "mtime_ns": st2.st_mtime_ns,
                                    "fingerprint": idx["fingerprint"], "at": time.strftime("%F %T")}
            except OSError:
                pass
        results.append(st)
        print("%-12s %-64s 行 %5d | 填 %5d | 已是 %5d | 查无 %5d | 无meta %3d | 冲突 %3d | 坏 %2d | %5.1fs%s"
              % (kind, path.name, st["lines"], st["changed"], st["already"],
                 st["no_index"] + st["no_trace"], st["no_meta"], st["conflict"], st["bad"],
                 st["seconds"],
                 "" if st.get("written") else "（未落盘）"), flush=True)

    if not args.dry_run:
        (cache / "state.json").write_text(json.dumps(state, indent=1, sort_keys=True))

    totals = {
        "files": len(results),
        "skipped": skipped,
        "lines": sum(r["lines"] for r in results),
        "filled": sum(r["changed"] for r in results),
        "already": sum(r["already"] for r in results),
        "no_trace": sum(r["no_trace"] for r in results),
        "no_index": sum(r["no_index"] for r in results),
        "no_meta": sum(r["no_meta"] for r in results),
        "conflict": sum(r["conflict"] for r in results),
        "bad": sum(r["bad"] for r in results),
        "written": sum(1 for r in results if r.get("written")),
        "seconds": round(time.time() - t0, 1),
    }
    summary = {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "root": str(base),
        "meta_dates": idx["per_date"],
        "meta_traces": len(index),
        "conflicts": idx["conflicts"],
        "totals": totals,
        "no_meta_dates": [k for k, v in idx["per_date"].items() if v <= 10],
        "files": results,
    }

    if args.json:
        print(json.dumps(summary, ensure_ascii=False, indent=2))
        return 0

    print()
    print("分类源    %d 天 / %d 条 trace（跨日期冲突 %d）"
          % (len(idx["per_date"]), len(index), idx["conflicts"]))
    print("本次      文件 %d（跳过未变 %d）| 行 %d | 新填 %d | 已是 %d | 查无分类 %d | 无 meta %d | 分类冲突 %d | 校验失败 %d"
          % (totals["files"], skipped, totals["lines"], totals["filled"], totals["already"],
             totals["no_index"] + totals["no_trace"], totals["no_meta"], totals["conflict"],
             totals["bad"]))
    print("落盘      %d 个文件（%s）" % (totals["written"], "dry-run" if args.dry_run else "原子替换"))
    thin = [d for d, n in idx["per_date"].items() if n <= 10]
    if thin:
        print("[warn] 这些日期的 category_meta.json 几乎是空的，视为未补全：%s" % ", ".join(sorted(thin)))
    print("耗时      %.1fs" % totals["seconds"])
    return 0


if __name__ == "__main__":
    sys.exit(main())
