#!/usr/bin/env python3
"""统计 AIME 日常评测（0_daily_eval）某日期区间的输入 / 已评测 / 缺口。

数据在弗吉尼亚服务器（ssh 别名默认 aime_rsi_data）：
  eval_input/0_daily_eval_input/<model>/<date>.jsonl
  eval_output/0_daily_eval/<model>/<model>_attribution-<date>.jsonl

输入 / 已评测都以「jsonl 行数」= 评测记录数口径（与看板「评测数据详情」的
评测输入 / 评测输出列一致）；同时给出按 session_id 去重的 Session 数。

第一次跑要读全部输入文件（几十 GB，几分钟）；之后只 stat 文件大小/mtime，
没变化就直接用本地缓存 tmp/daily_eval_progress_cache.json，秒回。

用法:
  python3 scripts/daily_eval_progress.py                 # 默认 2026-10-30..2026-11-06
  python3 scripts/daily_eval_progress.py --from 2026-10-30 --to 2026-11-06
  python3 scripts/daily_eval_progress.py --refresh       # 强制重数
  python3 scripts/daily_eval_progress.py --json          # 机器可读输出
"""
import argparse
import concurrent.futures
import json
import os
import subprocess
import sys
from datetime import date, datetime, timedelta
from pathlib import Path

SSH = os.environ.get("AIME_SSH", "aime_rsi_data")
ROOT = "/mnt/fin_bench/aime_rsi_data/1_aime"
MODELS = ["aime_expert", "aime_fast"]
CACHE = Path(__file__).resolve().parent.parent / "tmp" / "daily_eval_progress_cache.json"
SSH_OPTS = [
    "ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=20",
    "-o", "ControlMaster=auto", "-o", "ControlPath=/tmp/ssh-aime-%r@%h:%p",
    "-o", "ControlPersist=10m", SSH,
]


def paths_for(d):
    out = []
    for m in MODELS:
        out.append(("input", m, d, f"{ROOT}/eval_input/0_daily_eval_input/{m}/{d}.jsonl"))
        out.append(("output", m, d, f"{ROOT}/eval_output/0_daily_eval/{m}/{m}_attribution-{d}.jsonl"))
    return out


STAT_SCRIPT = r"""
import json
import os
paths = json.loads(__AIME_PATHS__)
out = []
for kind, model, date, path in paths:
    try:
        st = os.stat(path)
        out.append({"kind": kind, "model": model, "date": date, "path": path,
                    "exists": True, "size": st.st_size, "mtime_ns": st.st_mtime_ns})
    except OSError:
        out.append({"kind": kind, "model": model, "date": date, "path": path, "exists": False})
print(json.dumps(out))
"""

COUNT_SCRIPT = r"""
import concurrent.futures
import json
import os
import re

FILES = json.loads(__AIME_FILES__)
SID = re.compile(rb'"session_id"\s*:\s*"([^"]+)"')
PREFIX = 65536
CHUNK = 4 * 1024 * 1024


def scan(path):
    lines = 0
    sids = set()
    rem = b""
    with open(path, "rb") as fh:
        while True:
            chunk = fh.read(CHUNK)
            if not chunk:
                break
            data = rem + chunk
            parts = data.split(b"\n")
            rem = parts.pop()
            for ln in parts:
                lines += 1
                m = SID.search(ln[:PREFIX])
                if m:
                    sids.add(m.group(1).decode("utf-8", "replace"))
    if rem:
        lines += 1
        m = SID.search(rem[:PREFIX])
        if m:
            sids.add(m.group(1).decode("utf-8", "replace"))
    st = os.stat(path)
    return {"path": path, "lines": lines, "sids": sorted(sids),
            "size": st.st_size, "mtime_ns": st.st_mtime_ns}


with concurrent.futures.ThreadPoolExecutor(max_workers=8) as ex:
    result = list(ex.map(scan, FILES))
print(json.dumps(result))
"""


def remote_run(script, **values):
    for key, value in values.items():
        script = script.replace(f"__{key}__", repr(value))
    proc = subprocess.run(SSH_OPTS + ["python3", "-"], input=script.encode(),
                          capture_output=True, timeout=1800)
    if proc.returncode != 0:
        raise SystemExit(f"remote failed: {proc.stderr.decode()[-2000:]}")
    return json.loads(proc.stdout.decode())


def daterange(a, b):
    cur, end = date.fromisoformat(a), date.fromisoformat(b)
    while cur <= end:
        yield cur.isoformat()
        cur += timedelta(days=1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--from", dest="start", default="2026-10-30")
    ap.add_argument("--to", dest="end", default="2026-11-06")
    ap.add_argument("--refresh", action="store_true")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    files = [p for d in daterange(args.start, args.end) for p in paths_for(d)]
    stats = remote_run(STAT_SCRIPT, AIME_PATHS=json.dumps(files))
    stats = [s for s in stats if s["exists"]]

    cache = {}
    if CACHE.exists() and not args.refresh:
        try:
            cache = json.loads(CACHE.read_text())
        except ValueError:
            cache = {}

    todo = [s for s in stats
            if "lines" not in cache.get(s["path"], {})
            or cache[s["path"]].get("size") != s["size"]
            or cache[s["path"]].get("mtime_ns") != s["mtime_ns"]]
    todo = [s["path"] for s in todo]
    if todo:
        print(f"[daily] 需要新数 {len(todo)} 个文件（共 {len(stats)} 个）...", file=sys.stderr)
        for r in remote_run(COUNT_SCRIPT, AIME_FILES=json.dumps(todo)):
            cache[r["path"]] = r
        CACHE.parent.mkdir(parents=True, exist_ok=True)
        CACHE.write_text(json.dumps(cache))
    else:
        print("[daily] 文件都未变化，读本地缓存", file=sys.stderr)

    rows = {}
    for s in stats:
        c = cache[s["path"]]
        key = (s["date"], s["model"])
        r = rows.setdefault(key, {"date": s["date"], "model": s["model"],
                                  "inputs": 0, "evaluated": 0,
                                  "input_sids": set(), "evaluated_sids": set()})
        if s["kind"] == "input":
            r["inputs"] += c["lines"]
            r["input_sids"].update(c.get("sids", []))
        else:
            r["evaluated"] += c["lines"]
            r["evaluated_sids"].update(c.get("sids", []))

    out = []
    for key in sorted(rows):
        r = rows[key]
        out.append({
            "date": r["date"], "model": r["model"],
            "inputs": r["inputs"], "evaluated": r["evaluated"],
            "missing": max(0, r["inputs"] - r["evaluated"]),
            "pct": round(100 * r["evaluated"] / r["inputs"], 1) if r["inputs"] else None,
            "input_sessions": len(r["input_sids"]),
            "evaluated_sessions": len(r["evaluated_sids"]),
        })

    totals = {
        "inputs": sum(r["inputs"] for r in out),
        "evaluated": sum(r["evaluated"] for r in out),
        "input_sessions": len({s for r in rows.values() for s in r["input_sids"]}),
        "evaluated_sessions": len({s for r in rows.values() for s in r["evaluated_sids"]}),
    }
    totals["missing"] = totals["inputs"] - totals["evaluated"]
    totals["pct"] = round(100 * totals["evaluated"] / totals["inputs"], 1) if totals["inputs"] else None

    if args.json:
        print(json.dumps({"range": [args.start, args.end], "generated_at": datetime.now().isoformat(timespec="seconds"),
                          "rows": out, "totals": totals}, ensure_ascii=False, indent=2))
        return

    print(f"AIME 日常评测 {args.start} ~ {args.end}")
    print(f"{'日期':<12}{'模型':<13}{'评测输入':>8}{'已评测':>8}{'缺口':>7}{'完成率':>8}"
          f"{'输入Session':>12}{'已评测Session':>14}")
    for r in out:
        print(f"{r['date']:<12}{r['model']:<13}{r['inputs']:>8}{r['evaluated']:>8}"
              f"{r['missing']:>7}{(str(r['pct']) + '%'):>8}{r['input_sessions']:>12}"
              f"{r['evaluated_sessions']:>14}")
    print("-" * 82)
    print(f"{'合计':<12}{'':<13}{totals['inputs']:>8}{totals['evaluated']:>8}"
          f"{totals['missing']:>7}{(str(totals['pct']) + '%'):>8}"
          f"{totals['input_sessions']:>12}{totals['evaluated_sessions']:>14}")


if __name__ == "__main__":
    main()
