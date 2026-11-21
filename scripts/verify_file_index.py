#!/usr/bin/env python3
"""给 ``cache/build.sqlite3`` 的旧行补 ``tail``（或删掉对不上文件的行），避免整库重扫。

索引只有在 ``files.tail`` 存在时才算「可信」：追加续扫要求旧 committed 之前 64 KB 的
哈希不变。升级前写的行没有这一列，构建会当成不可信把整份文件重读一遍 —— 问财输入
207 GB，一轮就是 5 小时。这个脚本只读每个文件里几十个 offsets 边界，确认旧 offsets
仍然落在行首，就给该行盖上 ``tail``；确认不了的删掉该行，让构建只重扫那几个文件。

用法（在装有看板代码与数据的机器上跑，默认只报告不落库）::

    python3 scripts/verify_file_index.py --root /mnt/fin_bench/code_and_clean_data/datasets
    python3 scripts/verify_file_index.py --root ... --write      # 盖章 / 删坏行
    python3 scripts/verify_file_index.py --root ... --limit 600 --json
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from array import array
from pathlib import Path

DEFAULT_DASHBOARD = "/opt/eval_dashboard"


def sample_offsets(count: int, limit: int) -> list[int]:
    """1-based line numbers whose start offsets are probed; always includes the last."""
    if count <= limit:
        return list(range(1, count + 1))
    step = max(1, (count - 1) // (limit - 1))
    picked = list(range(1, count + 1, step))[: limit - 1]
    return sorted(set(picked + [count]))


def check_row(root: Path, row, limit: int) -> tuple[str, str | None]:
    """('ok'|'stale'|'bad', reason). ok means the offsets still describe the file."""
    path, size, mtime_ns, lines, committed, ends_nl, blob = row
    full = root / path
    try:
        st = os.stat(full)
    except OSError as exc:
        return "missing", str(exc)
    if st.st_size != size or st.st_mtime_ns != mtime_ns:
        return "stale", f"file is {st.st_size}/{st.st_mtime_ns}, row says {size}/{mtime_ns}"
    offs = array("q")
    offs.frombytes(blob)
    if len(offs) != lines + 1 or offs[0] != 0 or offs[-1] != committed:
        return "bad", f"offsets shape: {len(offs)} entries, lines={lines}, last={offs[-1]}, committed={committed}"
    if any(b <= a for a, b in zip(offs, offs[1:])):
        return "bad", "offsets are not strictly increasing"
    if ends_nl and committed != size:
        return "bad", f"ends with a newline but committed={committed} != size={size}"
    fd = os.open(full, os.O_RDONLY)
    try:
        for number in sample_offsets(len(offs) - 1, limit):
            start = offs[number - 1]
            if start == 0:
                continue
            if os.pread(fd, 1, start - 1) != b"\n":
                return "bad", f"line {number} starts mid-line at {start}"
    finally:
        os.close(fd)
    return "ok", None


def main() -> int:
    ap = argparse.ArgumentParser(description="补 build.sqlite3 的 tail 列 / 删掉对不上文件的行")
    ap.add_argument("--dashboard", default=DEFAULT_DASHBOARD, help="看板代码目录（含 build_store.py）")
    ap.add_argument("--root", required=True, help="数据集根目录（EVAL_DATASETS）")
    ap.add_argument("--store", default="", help="默认 <dashboard>/cache/build.sqlite3")
    ap.add_argument("--limit", type=int, default=300, help="每个文件抽查多少个 offsets")
    ap.add_argument("--write", action="store_true", help="落库：盖章已验证的行、删掉有问题的行")
    ap.add_argument("--json", action="store_true", help="机器可读输出")
    args = ap.parse_args()

    sys.path.insert(0, args.dashboard)
    try:
        import build_store as bs  # noqa: E402  (需要在 --dashboard 之后导入)
    except ImportError:
        print(f"找不到 {Path(args.dashboard) / 'build_store.py'}；用 --dashboard 指向看板代码目录", file=sys.stderr)
        return 2

    root = Path(args.root)
    store_path = Path(args.store or Path(args.dashboard) / "cache" / "build.sqlite3")
    store = bs.BuildStore(store_path)
    rows = store.db.execute(
        "SELECT path,size,mtime_ns,lines,committed,ends_nl,offsets FROM files WHERE tail IS NULL"
    ).fetchall()
    out = {"files": len(rows), "ok": [], "stale": [], "bad": [], "missing": [], "stamped": 0, "dropped": 0}
    for row in rows:
        path, committed = row[0], row[4]
        status, why = check_row(root, row, args.limit)
        if status == "ok":
            out["ok"].append(path)
            if args.write:
                store.db.execute(
                    "UPDATE files SET tail=? WHERE path=?",
                    (bs.boundary_hash(root / path, committed), path))
                out["stamped"] += 1
        else:
            out[status].append([path, why] if why else [path])
            if args.write and status in ("bad", "missing"):
                # 重扫这一个文件比信任一份错位的 offsets 便宜得多。
                store.db.execute("DELETE FROM files WHERE path=?", (path,))
                out["dropped"] += 1
    if args.write:
        store.db.commit()
    store.close()

    if args.json:
        print(json.dumps(out, ensure_ascii=False, indent=1))
    else:
        print(f"待处理 {out['files']} 个没有 tail 的文件（抽查 {args.limit} 个 offsets）")
        print(f"  通过 {len(out['ok'])} | 变了待重扫 {len(out['stale'])} | 错位 {len(out['bad'])} | 读不到 {len(out['missing'])}")
        for status in ("bad", "missing"):
            for item in out[status][:10]:
                print(f"  {status}: {item[0]} — {item[1]}")
        if args.write:
            print(f"已盖章 {out['stamped']} 个，删除 {out['dropped']} 个待重扫")
        else:
            print("（只报告；加 --write 落库）")
    return 0 if not out["bad"] and not out["missing"] else 1


if __name__ == "__main__":
    sys.exit(main())
