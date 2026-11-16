#!/usr/bin/env python3
"""AIME 数据存量盘点：待瘦身 / 待评测 / 已评测，按日期 × 模型出数。

三处数据都在弗吉尼亚（ssh 别名默认 aime_rsi_data）：

  待瘦身  /mnt/aime_eval_ssd/0_litefusion_data/online_data/2026/MM/DD/data_*.jsonl
          进度看 /mnt/aime_eval_ssd/code/3_scripts/1_slim_publish/state/state.sqlite3
          的 files.offset（已读字节），offset 之后就是还没瘦身的尾巴
  待评测  /mnt/aime_eval_ssd/1_aime/eval_input/0_daily_eval_input/<model>/<date>.jsonl
  已评测  /mnt/aime_eval_ssd/1_aime/eval_output/0_daily_eval/.keys/<model>/*.keys

口径（先对齐再统计，详见 docs/aime-data-inventory-sop.md）：

  * 待瘦身 = 原始文件 offset 之后的行数，1 行 = 1 个 session
  * 待评测 / 已评测 = 按 trace_id 去重的记录数；评测流水线本身就是按 trace 去重
  * 输入行数 ≠ 唯一 trace 数：同一 trace 的多次快照会重复落盘，--json 里两个都给了
  * 「待评测」不能用「输入行数 − 输出行数」算：输入会被回填重写，输出也含历史记录

性能：第一次读全部输入（47 GB，实测 17 s）建 trace_id 索引；之后按
(size, mtime, 头部 md5) 只扫新增字节，通常 0.4 s。待瘦身只读未处理的尾巴（1-2 GB）。
索引默认落在 <root>/code/3_scripts/cache/aime_data_inventory，删掉即重建。

用法::

    python3 scripts/aime_data_inventory.py              # 笔记本上跑，自动 ssh 到弗吉尼亚
    python3 scripts/aime_data_inventory.py --local      # 直接在服务器上跑
    python3 scripts/aime_data_inventory.py --rebuild    # 强制重建 trace_id 索引
    python3 scripts/aime_data_inventory.py --json       # 机器可读输出
"""

from __future__ import annotations

import argparse
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

# 提取器版本：正则/窗口一改就必须改这个值，旧索引会自动失效重扫。
#   v1 -> v2  兼容 '"trace_id":"x"' 与 '"trace_id": "x"' 两种序列化，窗口 700B -> 4KB
#   v2 -> v3  头部哈希改成只哈希固定前缀（小文件整段被哈希，追加后永远命中不了增量）
#   v3 -> v4  尾部找不到时不再回退到头部 meta.trace_id（会把同会话多条 trace 折叠），
#             改为全行取最后一次；全库只剩 2026-09 的 26 行旧记录用 session key
EXTRACTOR_VERSION = 4
TAIL_WIN = 4096          # trace_id 在行尾 _source 之前，取尾部窗口
HEAD_WIN = 1024          # session_id 在行首 meta 里
SLIM_HEAD_WIN = 8192     # raw 的 meta 在最前面，runtime_mode 在头部
HEAD_HASH_BYTES = 4096   # 判断「前缀没被改写」只哈希这么多字节

TID = re.compile(rb'"trace_id"\s*:\s*"([^"]+)"')
SID = re.compile(rb'"session_id"\s*:\s*"([^"]+)"')
RMODE = re.compile(rb'"runtime_mode"\s*:\s*"([^"]+)"')
RAW_DATE = re.compile(r"/(\d{4})/(\d{2})/(\d{2})/data_\d{8}\.jsonl$")

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
    # 弗吉尼亚 SSH 会间歇拒绝新连接，重试几次再放弃
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
# 待瘦身：sqlite 里的已读偏移 + 只读未处理的尾巴
# --------------------------------------------------------------------------- #
def slim_pending(root: str, cache_dir: Path) -> tuple[dict, int]:
    """返回 ({(model,date): rows}, 文件数)。

    只读每个文件 offset 之后的字节；已算过的 (offset, size) 走缓存。
    """
    db = Path(root) / "code/3_scripts/1_slim_publish/state/state.sqlite3"
    raw_dir = Path(root) / "0_litefusion_data/online_data/2026"
    if not db.exists():
        print(f"[warn] 找不到瘦身状态库 {db}，待瘦身按 0 计", file=sys.stderr)
        return {}, 0

    conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    tracked = {r[0]: (int(r[1]), int(r[2])) for r in conn.execute("select path,size,offset from files")}
    conn.close()

    # 状态库里没有的新文件按 offset=0 处理
    for path in sorted(raw_dir.glob("*/*/data_*.jsonl")):
        tracked.setdefault(str(path), (0, 0))

    cache_path = cache_dir / "slim_tails.json"
    cache = {}
    if cache_path.exists():
        try:
            cache = json.loads(cache_path.read_text())
        except (OSError, ValueError):
            cache = {}

    counts: dict[tuple[str, str], int] = {}
    files = 0
    new_cache = {}
    for path, (_dbsize, offset) in sorted(tracked.items()):
        try:
            actual = os.path.getsize(path)
        except OSError:
            continue
        if actual <= offset:
            continue
        m = RAW_DATE.search(path)
        if not m:
            continue
        date = f"{m.group(1)}-{m.group(2)}-{m.group(3)}"
        key = f"{path}@{offset}@{actual}"
        files += 1
        if key in cache:
            per_model = cache[key]
        else:
            per_model = _count_raw_tail(path, offset)
        new_cache[key] = per_model
        for model, n in per_model.items():
            if model in MODELS:
                counts[(model, date)] = counts.get((model, date), 0) + n

    cache_dir.mkdir(parents=True, exist_ok=True)
    cache_path.write_text(json.dumps(new_cache))
    return counts, files


def _count_raw_tail(path: str, offset: int) -> dict:
    """从 offset 开始读，按行统计 runtime_mode（行尾没写完整的那行不算）。"""
    per_model = {"aime_expert": 0, "aime_fast": 0, "other": 0}
    with open(path, "rb") as fh:
        fh.seek(offset)
        while True:
            line = fh.readline()
            if not line or not line.endswith(b"\n"):
                break
            m = RMODE.search(line[:SLIM_HEAD_WIN])
            if not m:                      # 极少数 runtime_mode 不在头部，再全行找一次
                m = RMODE.search(line)
            mode = m.group(1).decode("ascii", "ignore") if m else ""
            if mode == "expert":
                per_model["aime_expert"] += 1
            elif mode == "fast":
                per_model["aime_fast"] += 1
            else:
                per_model["other"] += 1
    return per_model


# --------------------------------------------------------------------------- #
# 已评测：.keys 索引（一行 = 一条评测记录，形如 ["<session key>", ["<trace_id>", ...]]）
# --------------------------------------------------------------------------- #
def eval_keys(keys_dir: Path, models: list[str]) -> dict[tuple[str, str], set[str]]:
    out: dict[tuple[str, str], set[str]] = {}
    for model in models:
        for path in sorted((keys_dir / model).glob(f"{model}_attribution-*.keys")):
            prefix = f"{model}_attribution-"
            suffix = ".jsonl.keys"
            date = path.name[len(prefix):-len(suffix)] if path.name.endswith(suffix) else ""
            ids: set[str] = set()
            try:
                with open(path, "rb") as fh:
                    for line in fh:
                        line = line.strip()
                        if not line:
                            continue
                        try:
                            obj = json.loads(line)
                        except ValueError:
                            continue
                        if not isinstance(obj, list) or len(obj) < 2:
                            continue
                        if isinstance(obj[0], str):
                            # 旧的是 session 粒度，key 就是 session 标识，也登记上
                            ids.add("S:" + obj[0])
                        val = obj[1]
                        for tid in (val if isinstance(val, list) else [val]):
                            if isinstance(tid, str):
                                ids.add("T:" + tid)
            except OSError:
                continue
            out[(model, date)] = ids
    return out


# --------------------------------------------------------------------------- #
# 输入侧 trace_id 增量索引
# --------------------------------------------------------------------------- #
def _head_md5(path: str, limit: int) -> str:
    """只哈希文件前缀 limit 字节。limit 必须 <= 上次记录的长度，
    否则追加写会让「头部」也变，增量永远命中不了（小文件尤其明显）。"""
    h = hashlib.md5()
    if limit <= 0:
        return ""
    with open(path, "rb") as fh:
        h.update(fh.read(limit))
    return h.hexdigest()


def _read_ids(ids_path: Path) -> set[str]:
    if not ids_path.exists():
        return set()
    with open(ids_path, "r", encoding="utf-8") as fh:
        return {line.rstrip("\n") for line in fh if line.strip()}


def _write_ids(ids_path: Path, ids: set[str]) -> None:
    ids_path.parent.mkdir(parents=True, exist_ok=True)
    tmp = ids_path.with_suffix(".tmp")
    with open(tmp, "w", encoding="utf-8") as fh:
        for key in sorted(ids):
            fh.write(key + "\n")
    os.replace(tmp, ids_path)


def _scan_ids(path: str, start: int) -> tuple[set[str], int, int, int]:
    """从 start 扫描完整行，返回 (ids, 行数, 结束偏移, 缺 trace_id 的行数)。"""
    ids: set[str] = set()
    lines = 0
    miss = 0
    pos = start
    with open(path, "rb") as fh:
        fh.seek(start)
        while True:
            line = fh.readline()
            if not line or not line.endswith(b"\n"):   # 末尾半行：下一轮再来
                break
            pos += len(line)
            if not line.strip():                       # 空行不算记录
                continue
            lines += 1
            m = TID.findall(line[-TAIL_WIN:])
            if not m:                                  # 少数行 trace_id 不在尾部窗口
                m = TID.findall(line)                  # 全行取最后一次，别回退到 meta.trace_id
            if m:
                ids.add("T:" + m[-1].decode("ascii", "ignore"))
                continue
            miss += 1
            s = SID.search(line[:HEAD_WIN])
            if s:
                ids.add("S:" + s.group(1).decode("ascii", "ignore"))
            else:
                ids.add("NONE")
    return ids, lines, pos, miss


def input_index(path: str, cache_dir: Path, model: str, date: str,
                rebuild: bool = False) -> dict:
    """返回 {ids, lines, miss, rebuilt, appended}。按 size/mtime/头部 md5 增量。"""
    ids_path = cache_dir / model / f"{date}.ids"
    meta_path = cache_dir / model / f"{date}.json"
    st = os.stat(path)
    meta = None
    if meta_path.exists():
        try:
            meta = json.loads(meta_path.read_text())
        except (OSError, ValueError):
            meta = None

    def _full() -> dict:
        ids, lines, pos, miss = _scan_ids(path, 0)
        _write_ids(ids_path, ids)
        limit = min(HEAD_HASH_BYTES, pos)
        new_meta = {
            "v": EXTRACTOR_VERSION, "size": pos, "mtime_ns": st.st_mtime_ns,
            "head": _head_md5(path, limit), "head_limit": limit,
            "lines": lines, "miss": miss,
        }
        meta_path.parent.mkdir(parents=True, exist_ok=True)
        meta_path.write_text(json.dumps(new_meta))
        return {"ids": ids, "lines": lines, "miss": miss, "rebuilt": True, "appended": 0}

    if rebuild or not meta or meta.get("v") != EXTRACTOR_VERSION or not ids_path.exists():
        return _full()

    if st.st_size == meta["size"] and st.st_mtime_ns == meta["mtime_ns"]:
        ids = _read_ids(ids_path)
        return {"ids": ids, "lines": meta["lines"], "miss": meta.get("miss", 0),
                "rebuilt": False, "appended": 0}

    # 只变大且前缀没被改写 → 只读新增字节
    if st.st_size > meta["size"] and _head_md5(path, meta.get("head_limit", 0)) == meta["head"]:
        new_ids, new_lines, end, new_miss = _scan_ids(path, meta["size"])
        ids = _read_ids(ids_path) | new_ids
        _write_ids(ids_path, ids)
        meta.update({
            "size": end, "mtime_ns": st.st_mtime_ns,
            "lines": meta["lines"] + new_lines, "miss": meta.get("miss", 0) + new_miss,
        })
        meta_path.write_text(json.dumps(meta))
        return {"ids": ids, "lines": meta["lines"], "miss": meta["miss"],
                "rebuilt": False, "appended": new_lines}

    return _full()


# --------------------------------------------------------------------------- #
# 汇总与渲染
# --------------------------------------------------------------------------- #
def collect(root: str, cache_dir: Path, rebuild: bool) -> dict:
    base = Path(root)
    input_dir = base / "1_aime/eval_input/0_daily_eval_input"
    keys_dir = base / "1_aime/eval_output/0_daily_eval/.keys"

    slim, slim_files = slim_pending(root, cache_dir)
    evals = eval_keys(keys_dir, MODELS)

    rows: dict[tuple[str, str], dict] = {}
    for model in MODELS:
        for path in sorted(input_dir.glob(f"{model}/*.jsonl")):
            date = path.stem
            idx = input_index(str(path), cache_dir, model, date, rebuild=rebuild)
            evaluated = idx["ids"] & evals.get((model, date), set())
            rows[(model, date)] = {
                "slim": slim.get((model, date), 0),
                "evaluated": len(evaluated),
                "pending": len(idx["ids"] - evals.get((model, date), set())),
                "ids": len(idx["ids"]),
                "lines": idx["lines"],
                "miss": idx["miss"],
                "rebuilt": idx["rebuilt"],
                "appended": idx["appended"],
            }

    # 只在原始侧出现的日期也要进表（待瘦身还没产出输入）
    for (model, date), n in slim.items():
        rows.setdefault((model, date), {"slim": 0, "evaluated": 0, "pending": 0,
                                        "ids": 0, "lines": 0, "miss": 0,
                                        "rebuilt": False, "appended": 0})
        rows[(model, date)]["slim"] = n

    return {"rows": rows, "slim_files": slim_files}


def render(rows: dict, models: list[str]) -> str:
    dates = sorted({d for _, d in rows})
    lines = [
        "| 日期 | EXP 待处理 | EXP 已评测 | EXP 待评测 | FAST 待处理 | FAST 已评测 | FAST 待评测 | 待评测小计 |",
        "|---|---:|---:|---:|---:|---:|---:|---:|",
    ]

    def cell(v: int) -> str:
        return f"{v:,}" if v else "–"

    for date in dates:
        vals = []
        for model in models:
            r = rows.get((model, date), {})
            vals += [r.get("slim", 0), r.get("evaluated", 0), r.get("pending", 0)]
        subtotal = sum(rows.get((m, date), {}).get("pending", 0) for m in models)
        lines.append("| " + " | ".join([date] + [cell(v) for v in vals] + [cell(subtotal)]) + " |")

    # 合计行：每列各自求和
    totals = []
    for model in models:
        totals += [
            sum(rows.get((model, d), {}).get("slim", 0) for d in dates),
            sum(rows.get((model, d), {}).get("evaluated", 0) for d in dates),
            sum(rows.get((model, d), {}).get("pending", 0) for d in dates),
        ]
    totals.append(sum(rows.get((m, d), {}).get("pending", 0) for m in models for d in dates))
    lines.append("| **合计** | " + " | ".join(f"**{cell(v)}**" for v in totals) + " |")
    return "\n".join(lines)


def main() -> int:
    ap = argparse.ArgumentParser(description="AIME 数据存量盘点（待瘦身 / 待评测 / 已评测）")
    ap.add_argument("--root", default=DEFAULT_ROOT, help=f"数据根目录，默认 {DEFAULT_ROOT}")
    ap.add_argument("--cache-dir", default=None, help="trace_id 索引缓存目录")
    ap.add_argument("--local", action="store_true", help="强制本地执行（不 ssh）")
    ap.add_argument("--remote", action="store_true", help="强制走 ssh（内部使用）")
    ap.add_argument("--rebuild", action="store_true", help="重建 trace_id 索引")
    ap.add_argument("--json", action="store_true", help="输出 JSON")
    args = ap.parse_args(sys.argv[1:])

    maybe_reexec(sys.argv[1:], args.root)
    if not os.path.isdir(args.root):
        print(f"[error] 本机看不到 {args.root}，且无法 ssh 到 {SSH}", file=sys.stderr)
        return 2

    cache_dir = Path(args.cache_dir) if args.cache_dir else \
        Path(args.root) / "code/3_scripts/cache/aime_data_inventory"

    t0 = time.time()
    data = collect(args.root, cache_dir, args.rebuild)
    rows = data["rows"]
    elapsed = time.time() - t0

    if args.json:
        payload = {
            "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            "root": args.root,
            "extractor_version": EXTRACTOR_VERSION,
            "slim_pending_rows": sum(r["slim"] for r in rows.values()),
            "slim_pending_files": data["slim_files"],
            "input_unique": sum(r["ids"] for r in rows.values()),
            "input_lines": sum(r["lines"] for r in rows.values()),
            "evaluated": sum(r["evaluated"] for r in rows.values()),
            "pending_eval": sum(r["pending"] for r in rows.values()),
            "per_day": [
                {"date": d, "model": m, **{k: rows[(m, d)][k] for k in
                 ("slim", "evaluated", "pending", "ids", "lines", "miss")}}
                for (m, d) in sorted(rows)
            ],
        }
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        return 0

    print(render(rows, MODELS))
    slim_total = sum(r["slim"] for r in rows.values())
    slim_e = sum(r["slim"] for (m, _), r in rows.items() if m == "aime_expert")
    slim_f = sum(r["slim"] for (m, _), r in rows.items() if m == "aime_fast")
    ev = sum(r["evaluated"] for r in rows.values())
    pend = sum(r["pending"] for r in rows.values())
    uniq = sum(r["ids"] for r in rows.values())
    nlines = sum(r["lines"] for r in rows.values())
    ev_e = sum(r["evaluated"] for (m, _), r in rows.items() if m == "aime_expert")
    ev_f = sum(r["evaluated"] for (m, _), r in rows.items() if m == "aime_fast")
    pd_e = sum(r["pending"] for (m, _), r in rows.items() if m == "aime_expert")
    pd_f = sum(r["pending"] for (m, _), r in rows.items() if m == "aime_fast")
    rebuilt = sum(1 for r in rows.values() if r["rebuilt"])
    appended = sum(r["appended"] for r in rows.values())
    miss = sum(r["miss"] for r in rows.values())

    print()
    print(f"待瘦身   {slim_total:,} 行（EXP {slim_e:,} / FAST {slim_f:,}），{data['slim_files']} 个文件")
    print(f"待评测   {pend:,} 个 trace（EXP {pd_e:,} / FAST {pd_f:,}）")
    print(f"已评测   {ev:,} 个 trace（EXP {ev_e:,} / FAST {ev_f:,}），"
          f"覆盖 {ev / uniq * 100 if uniq else 0:.1f}%")
    print(f"输入     {nlines:,} 行 / {uniq:,} 个唯一 trace"
          f"（重复 {nlines - uniq:,} 行）")
    if rebuilt:
        print(f"索引     本次重建 {rebuilt} 个文件（首次或格式变更），其余增量")
    elif appended:
        print(f"索引     增量扫描 {appended:,} 行")
    else:
        print("索引     命中缓存，未读输入文件")
    if miss:
        print(f"[warn] {miss:,} 行没有 trace_id，回退用 session_id 做 key，请检查格式是否变化")
    print(f"耗时     {elapsed:.1f}s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
