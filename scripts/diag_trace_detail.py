"""诊断 5003 详情接口 404 / 错配：把 traces(归因侧) 与 input_index(输入侧) 对齐看。

用法（在数据服务器上）：python3 diag.py <trace_id> [...]
"""
import json
import sqlite3
import sys
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

DB = "/opt/eval_analysis/state/index.sqlite"
EASTERN = ZoneInfo("America/New_York")
IDS = sys.argv[1:]

conn = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)


def read_line(path, offset):
    try:
        with open(path, "rb") as f:
            f.seek(offset)
            return json.loads(f.readline())
    except Exception as exc:  # noqa: BLE001
        return {"__error__": str(exc)}


def eastern(value):
    if not isinstance(value, str) or not value.strip():
        return None
    text = value.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(text)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(EASTERN).strftime("%Y-%m-%d")


for tid in IDS:
    print("=" * 100)
    print("trace:", tid)

    traces = conn.execute(
        "SELECT day, app_version, session_id, asked_at, file, line, offset, "
        "length(question), source, user_id FROM traces WHERE trace_id = ?", (tid,)
    ).fetchall()
    if not traces:
        print("  [traces]　索引里没有这条（未分析 / 测试账号被隐藏 / 文件被 prune）")
    for day, app, sid, asked_at, path, line, off, qlen, source, uid in traces:
        print(f"  [traces] day={day} app={app} session={sid} asked_at={asked_at}")
        print(f"           user={uid} source={source} question_len={qlen}")
        print(f"           file={path.rsplit('/', 1)[-1]} line={line} offset={off}")
        rec = read_line(path, off)
        hit = [t for t in (rec.get("turns") or []) if (t.get("meta") or {}).get("trace_id") == tid]
        print(f"           归因行命中 turn: {len(hit)} 个; 行内 session={((rec.get('session_meta') or {}).get('session_id'))}")

    inputs = conn.execute(
        "SELECT day, app_version, path, offset, line FROM input_index WHERE trace_id = ?", (tid,)
    ).fetchall()
    if not inputs:
        print("  [input_index] 没有这条（详情 session/trace 只能为 null）")
    for day, app, path, off, line in inputs:
        rec = read_line(path, off)
        obj = None
        for item in rec.get("traces") or []:
            if (item.get("meta") or {}).get("trace_id") == tid:
                obj = item
                break
        meta = rec.get("meta") or {}
        print(f"  [input_index] day={day} app={app} line={line} offset={off}")
        print(f"                file={path.rsplit('/', 1)[-1]}")
        print(f"                行内含该 trace: {obj is not None}; meta.session={meta.get('session_id')}"
              f" request_time={meta.get('request_time')!r} 美东day={eastern(meta.get('request_time'))}")
        if obj is not None:
            tmeta = obj.get("meta") or {}
            print(f"                trace.meta: session={tmeta.get('session_id')} ts={tmeta.get('timestamp')!r}"
                  f" 美东day={eastern(tmeta.get('timestamp'))}")

    # 复刻 _input_ref 的取法
    want = traces[0][0] if traces else None
    exact = conn.execute(
        "SELECT path, offset, day FROM input_index WHERE trace_id = ? AND day = ?", (tid, want)
    ).fetchone()
    fallback = conn.execute(
        "SELECT path, offset, day FROM input_index WHERE trace_id = ? LIMIT 1", (tid,)
    ).fetchone()
    print(f"  -> 详情请求 day={want}: 精确命中={bool(exact)}; 兜底取到 day={fallback[2] if fallback else None}"
          f" ({'同一行' if exact and fallback and exact[0] == fallback[0] and exact[1] == fallback[1] else '可能错配'})")
    all_days = sorted({r[0] for r in traces})
    if len(all_days) > 1:
        print(f"  !! 同一 trace_id 有多个归因 day: {all_days}")
