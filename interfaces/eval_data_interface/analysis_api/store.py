"""把数据目录增量索引到 SQLite。

只读数据源，写入的只有本地状态目录里的 index.sqlite。三层内容：

1. attribution：一条 trace 的分析结果与问题编码（join cluster 的 item_index）。
2. input：eval_input 的行号索引，供详情接口按 trace_id 定位原始结构体。
3. history：同一 trace 更早的分析记录（同一文件里被后一行覆盖的那些）。

每个文件按 (size, mtime, 依赖文件签名) 判断是否需要重扫，未变直接跳过。
eval_input 是 GB 级、持续追加的文件：头部未变且只是变长时，从上次最后一个完整换行续扫。
"""

import hashlib
import json
import re
import sqlite3
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import unquote

from . import config, timeutil

SCHEMA = """
CREATE TABLE IF NOT EXISTS files(
    path TEXT PRIMARY KEY,
    sig TEXT NOT NULL,
    kind TEXT NOT NULL,
    scanned_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS traces(
    trace_id TEXT NOT NULL,
    day TEXT NOT NULL,
    app_version TEXT NOT NULL,
    asked_at TEXT,
    source TEXT,
    user_id TEXT,
    question TEXT,
    session_id TEXT,
    intent_code TEXT,
    task TEXT,
    subtask TEXT,
    error_codes TEXT,
    has_error INTEGER,
    analysis_id TEXT,
    analyzed_at TEXT,
    file TEXT,
    line INTEGER,
    offset INTEGER,
    PRIMARY KEY (trace_id, day, app_version)
);
CREATE INDEX IF NOT EXISTS traces_file ON traces(file);
CREATE INDEX IF NOT EXISTS traces_day ON traces(day);
CREATE TABLE IF NOT EXISTS history(
    trace_id TEXT NOT NULL,
    day TEXT NOT NULL,
    app_version TEXT NOT NULL,
    analysis_id TEXT,
    analyzed_at TEXT,
    file TEXT,
    line INTEGER,
    offset INTEGER,
    intent_code TEXT,
    error_codes TEXT
);
CREATE INDEX IF NOT EXISTS history_file ON history(file);
CREATE TABLE IF NOT EXISTS input_index(
    trace_id TEXT NOT NULL,
    day TEXT NOT NULL,
    app_version TEXT,
    path TEXT NOT NULL,
    offset INTEGER NOT NULL,
    line INTEGER,
    PRIMARY KEY (trace_id, day)
);
CREATE INDEX IF NOT EXISTS input_index_path ON input_index(path);
CREATE TABLE IF NOT EXISTS problem_codes(
    trace_id TEXT NOT NULL,
    day TEXT NOT NULL,
    app_version TEXT NOT NULL,
    scope TEXT NOT NULL,
    idx INTEGER NOT NULL,
    code TEXT NOT NULL,
    file TEXT
);
CREATE INDEX IF NOT EXISTS problem_codes_file ON problem_codes(file);
CREATE INDEX IF NOT EXISTS problem_codes_trace ON problem_codes(trace_id, day, app_version);
CREATE INDEX IF NOT EXISTS history_trace ON history(trace_id, day, app_version);
"""

# 旧库没有的列：input 续扫需要上次提交到的字节、行数和文件头指纹
FILE_COLUMNS = {"committed": "INTEGER", "lines": "INTEGER", "prefix": "TEXT"}
PREFIX_BYTES = 65536

TRACE_ID_RE = re.compile(rb'"trace_id"\s*:\s*"([^"\s]{4,80})"')
ATTR_RE = re.compile(r"^(?P<model>.+)_attribution-(?P<day>\d{4}-\d{2}-\d{2})\.jsonl$")
INPUT_DAY_RE = re.compile(r"(?P<day>\d{4}-\d{2}-\d{2})")


def _log_factory(log):
    return log or (lambda message: None)


def connect(path):
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path))
    conn.executescript(SCHEMA)
    have = {row[1] for row in conn.execute("PRAGMA table_info(files)")}
    for name, kind in FILE_COLUMNS.items():
        if name not in have:
            conn.execute(f"ALTER TABLE files ADD COLUMN {name} {kind}")
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    return conn


def _lines(path: Path):
    """逐行读，读完即关文件（直接迭代 path.open() 要等 GC 才释放句柄）。"""
    with path.open("rb") as handle:
        yield from handle


def _file_sig(path: Path):
    stat = path.stat()
    return f"{stat.st_size}:{int(stat.st_mtime)}"


def _analysis_id(rel_path: str, line: int) -> str:
    digest = hashlib.sha1(f"{rel_path}:{line}".encode("utf-8")).hexdigest()
    return "an_" + digest[:16]


def _decoded(value):
    """问句转成可入库、可搜索的文本；URL 编码的解码。"""
    value = _text(value)
    if value and "%" in value:
        try:
            return unquote(value)
        except Exception:  # noqa: BLE001 - 解不开就保留原文
            return value
    return value


def _text(value):
    """数据里偶尔不是字符串：问卷式问句是 [{header, selected}]，ID 可能是数字。"""
    if value is None or isinstance(value, str):
        return value
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return str(value)
    if isinstance(value, list):
        parts = []
        for item in value:
            if isinstance(item, dict) and ("header" in item or "selected" in item):
                picked = item.get("selected")
                picked = "、".join(map(str, picked)) if isinstance(picked, list) else _text(picked) or ""
                parts.append(f"{item.get('header') or ''}：{picked}".strip("："))
            else:
                parts.append(_text(item) or "")
        return "；".join(part for part in parts if part) or None
    return json.dumps(value, ensure_ascii=False)


def _clean(value):
    text = _text(value)
    return (text or "").strip() or None


class ItemCodes:
    """cluster item_index 的 join：主键 (文件, 行, 轮次, 问题序号)，带标签校验兜底。"""

    def __init__(self):
        self.by_turn: dict[tuple, str] = {}
        self.by_label: dict[tuple, str] = {}
        self.by_session: dict[tuple, str] = {}
        # 每个归因文件各自的映射指纹：聚类流水线每次追加 item_index，只让涉及的文件重扫
        self.digests: dict[str, "hashlib._Hash"] = {}

    def sig_for(self, basename) -> str:
        digest = self.digests.get(basename)
        return digest.hexdigest() if digest else ""

    def code_for(self, basename, line, turn_index, problem_index, label, session_level=False):
        if session_level:
            code = self.by_session.get((basename, line, problem_index))
            if code:
                return code
        else:
            code = self.by_turn.get((basename, line, turn_index, problem_index))
            if code:
                return code
        return self.by_label.get((basename, line, label))


def load_item_codes(path: Path, log=None) -> tuple[ItemCodes, str]:
    codes = ItemCodes()
    if not path.exists():
        return codes, ""
    sig = _file_sig(path)
    for raw in _lines(path):
        try:
            item = json.loads(raw)
        except ValueError:
            continue
        code = item.get("path")
        if not code:
            continue
        line = item.get("line")
        if line is None:
            continue
        basename = str(item.get("file") or "").replace("\\", "/").rsplit("/", 1)[-1]
        label = item.get("label")
        problem_index = item.get("problem_index") or 0
        turn_index = item.get("turn_index")
        json_path = item.get("json_path") or ""
        # 按文件顺序累计（by_label 取第一条，顺序变了也算映射变了）
        digest = codes.digests.get(basename)
        if digest is None:
            digest = codes.digests[basename] = hashlib.blake2b(digest_size=12)
        digest.update(json.dumps([line, turn_index, problem_index, json_path, code, label], ensure_ascii=False).encode("utf-8"))
        if json_path.startswith("session_problem"):
            codes.by_session[(basename, int(line), int(problem_index))] = code
        elif turn_index is not None:
            codes.by_turn[(basename, int(line), int(turn_index), int(problem_index))] = code
        if label:
            codes.by_label.setdefault((basename, int(line), label), code)
    return codes, sig


def _attribution_files(aime: Path):
    """返回 [(path, split, model_dir)]。"""
    out = []
    for split_dir in (aime / "eval_output").iterdir() if (aime / "eval_output").is_dir() else []:
        if not split_dir.is_dir() or split_dir.name.startswith("."):
            continue
        if split_dir.name not in config.SPLIT_TO_SOURCE:
            continue
        for model_dir in sorted(split_dir.iterdir()):
            if not model_dir.is_dir():
                continue
            for path in sorted(model_dir.glob("*_attribution-*.jsonl")):
                out.append((path, split_dir.name, model_dir.name))
    return out


def _input_files(aime: Path):
    """返回 [(path, model_dir, source)]，覆盖日常输入与流失用户归档输入。"""
    out = []
    daily = aime / "eval_input" / "0_daily_eval_input"
    if daily.is_dir():
        for model_dir in sorted(daily.iterdir()):
            if model_dir.is_dir():
                for path in sorted(model_dir.glob("*.jsonl")):
                    out.append((path, model_dir.name, "0_daily_eval"))
    archive = aime / ".archive" / "1_lost_user_input"
    if archive.is_dir():
        for model_dir in sorted(archive.iterdir()):
            if model_dir.is_dir():
                for path in sorted(model_dir.glob("*_input.jsonl")):
                    out.append((path, model_dir.name, "1_lost_user_eval"))
    return out


def _cached_sig(conn, path: Path):
    row = conn.execute("SELECT sig FROM files WHERE path = ?", (str(path),)).fetchone()
    return row[0] if row else None


def _store_sig(conn, path: Path, sig: str, kind: str, committed=None, lines=None, prefix=None):
    conn.execute(
        "INSERT INTO files(path, sig, kind, scanned_at, committed, lines, prefix) VALUES (?, ?, ?, ?, ?, ?, ?) "
        "ON CONFLICT(path) DO UPDATE SET sig=excluded.sig, kind=excluded.kind, scanned_at=excluded.scanned_at, "
        "committed=excluded.committed, lines=excluded.lines, prefix=excluded.prefix",
        (str(path), sig, kind, timeutil.utc_rfc3339(datetime.now(timezone.utc)), committed, lines, prefix),
    )


def _prefix(path: Path, size: int) -> str:
    """文件头指纹：只取已提交的前 size 字节（至多 64 KB），小文件追加也能续扫。"""
    with path.open("rb") as handle:
        return hashlib.sha1(handle.read(min(size, PREFIX_BYTES))).hexdigest()


def _intent_lookup(intent_tree):
    by_label = {}
    if intent_tree is None:
        return by_label
    for node in intent_tree.nodes.values():
        by_label.setdefault((node.level, node.label), node.code)
    return by_label


def ingest_attribution(conn, aime: Path, item_codes_by_model, intent_tree, log):
    """把一个 attribution 文件读进 traces / history；同一 trace 保留行号最大的一行。"""
    lookup = _intent_lookup(intent_tree)
    stats = {"files": 0, "skipped": 0, "traces": 0, "history": 0, "problems": 0, "unclustered": 0}
    codes_by_model = {k: c for k, (c, _) in item_codes_by_model.items()}

    for path, split, model_dir in _attribution_files(aime):
        source = config.SPLIT_TO_SOURCE[split]
        suffix = config.MODEL_SUFFIX.get(model_dir, model_dir)
        codes = codes_by_model.get(model_dir) or ItemCodes()
        # 依赖签名只取 item_index 里属于本文件的行，别的文件新增聚类不会让它重扫
        sig = f"{_file_sig(path)}|{codes.sig_for(path.name)}"
        if _cached_sig(conn, path) == sig:
            stats["skipped"] += 1
            continue

        basename = path.name
        analyzed_at = timeutil.utc_rfc3339(datetime.fromtimestamp(path.stat().st_mtime, timezone.utc))
        default_day = ATTR_RE.match(basename)
        default_day = default_day.group("day") if default_day else None

        conn.execute("DELETE FROM traces WHERE file = ?", (str(path),))
        conn.execute("DELETE FROM history WHERE file = ?", (str(path),))
        conn.execute("DELETE FROM problem_codes WHERE file = ?", (str(path),))

        kept: dict[str, dict] = {}
        order: list[str] = []
        line_offset = 0
        for line_no, raw in enumerate(_lines(path), 1):
            current_offset = line_offset
            line_offset += len(raw)
            try:
                record = json.loads(raw)
            except ValueError:
                log(f"[warn] {basename}:{line_no} 不是合法 JSON，已跳过")
                continue
            smeta = record.get("session_meta") or {}
            session_id = _text(smeta.get("session_id") or smeta.get("thread_id"))
            question = _decoded(smeta.get("question"))
            session_problems = record.get("session_problem") or []
            turns = record.get("turns") or []
            for turn_index, turn in enumerate(turns):
                meta = turn.get("meta") or {}
                trace_id = _text(meta.get("trace_id"))
                if not trace_id:
                    continue
                stamp = timeutil.parse_iso(meta.get("timestamp")) or timeutil.parse_iso(smeta.get("request_time"))
                day = timeutil.cn_day(stamp) or default_day
                task = _clean(meta.get("task"))
                subtask = _clean(meta.get("subtask"))
                intent_code = lookup.get((2, subtask)) if subtask else None
                if intent_code is None and task:
                    intent_code = lookup.get((1, task))

                turn_problems = list(turn.get("problem") or [])
                problems = list(turn_problems)
                session_level = False
                if turn_index == len(turns) - 1 and session_problems:
                    problems = problems + list(session_problems)
                    session_level = True

                found = []
                code_rows = []
                for problem_index, problem in enumerate(problems):
                    is_session = session_level and problem_index >= len(turn_problems)
                    local_index = problem_index - len(turn_problems) if is_session else problem_index
                    code = codes.code_for(
                        basename,
                        line_no,
                        turn_index,
                        local_index,
                        problem.get("label"),
                        session_level=is_session,
                    )
                    stats["problems"] += 1
                    if code:
                        found.append(code)
                        code_rows.append(("session" if is_session else "turn", local_index, code))
                    else:
                        stats["unclustered"] += 1
                error_codes = sorted(set(found))

                entry = {
                    "trace_id": trace_id,
                    "day": day,
                    "app_version": f"{meta.get('model') or model_dir}_{suffix}",
                    "asked_at": timeutil.utc_rfc3339(stamp),
                    "source": source,
                    "user_id": _text(meta.get("user_id")),
                    "question": question,
                    "session_id": session_id,
                    "intent_code": intent_code,
                    "task": task,
                    "subtask": subtask,
                    "error_codes": error_codes,
                    "has_error": 1 if error_codes else 0,
                    "analysis_id": _analysis_id(basename, line_no),
                    "analyzed_at": analyzed_at,
                    "file": str(path),
                    "line": line_no,
                    "offset": current_offset,
                    "code_rows": code_rows,
                }
                if trace_id in kept:
                    old = kept[trace_id]
                    conn.execute(
                        "INSERT INTO history(trace_id, day, app_version, analysis_id, analyzed_at, file, line, offset, intent_code, error_codes) "
                        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                        (
                            old["trace_id"],
                            old["day"],
                            old["app_version"],
                            old["analysis_id"],
                            old["analyzed_at"],
                            old["file"],
                            old["line"],
                            old["offset"],
                            old["intent_code"],
                            json.dumps(old["error_codes"], ensure_ascii=False),
                        ),
                    )
                    stats["history"] += 1
                else:
                    order.append(trace_id)
                kept[trace_id] = entry
        conn.executemany(
            "INSERT OR REPLACE INTO traces(trace_id, day, app_version, asked_at, source, user_id, question, session_id, "
            "intent_code, task, subtask, error_codes, has_error, analysis_id, analyzed_at, file, line, offset) "
            "VALUES (:trace_id, :day, :app_version, :asked_at, :source, :user_id, :question, :session_id, "
            ":intent_code, :task, :subtask, :error_codes, :has_error, :analysis_id, :analyzed_at, :file, :line, :offset)",
            [
                {**kept[tid], "error_codes": json.dumps(kept[tid]["error_codes"], ensure_ascii=False)}
                for tid in order
            ],
        )
        code_rows = []
        for tid in order:
            entry = kept[tid]
            for scope, idx, code in entry["code_rows"]:
                code_rows.append((tid, entry["day"], entry["app_version"], scope, idx, code, str(path)))
        conn.executemany(
            "INSERT INTO problem_codes(trace_id, day, app_version, scope, idx, code, file) VALUES (?, ?, ?, ?, ?, ?, ?)",
            code_rows,
        )
        _store_sig(conn, path, sig, "attribution")
        conn.commit()
        stats["files"] += 1
        stats["traces"] += len(order)
    return stats


def ingest_inputs(conn, aime: Path, log):
    """扫描 eval_input 的行号，建立 trace_id → (文件, 偏移) 索引。

    文件头 64 KB 没变、只是变长时，从上次最后一个完整换行处续扫，已有的行不动；
    其余情况（新文件、被截短或重写）整份重扫。未写完的末行照常建索引，
    但不计入续扫起点，下次连同写完的部分重新读一遍。
    """
    stats = {"files": 0, "skipped": 0, "traces": 0, "resumed": 0}
    for path, model_dir, split in _input_files(aime):
        sig = _file_sig(path)
        prev = conn.execute(
            "SELECT sig, committed, lines, prefix FROM files WHERE path = ?", (str(path),)
        ).fetchone()
        if prev and prev[0] == sig:
            stats["skipped"] += 1
            continue
        suffix = config.MODEL_SUFFIX.get(model_dir, model_dir)
        match = INPUT_DAY_RE.search(path.name)
        file_day = match.group("day") if match else None
        start, line_no = 0, 0
        if (prev and prev[1] is not None and path.stat().st_size >= prev[1]
                and prev[3] == _prefix(path, prev[1])):
            start, line_no = prev[1], prev[2] or 0
            stats["resumed"] += 1
        else:
            conn.execute("DELETE FROM input_index WHERE path = ?", (str(path),))
        rows = []
        offset = committed = start
        lines = line_no
        with path.open("rb") as handle:
            handle.seek(start)
            for raw in handle:
                line_no += 1
                for trace_id in TRACE_ID_RE.findall(raw):
                    tid = trace_id.decode("utf-8", "replace")
                    rows.append((tid, file_day, suffix, str(path), offset, line_no))
                offset += len(raw)
                if raw.endswith(b"\n"):
                    committed, lines = offset, line_no
        conn.executemany(
            "INSERT OR IGNORE INTO input_index(trace_id, day, app_version, path, offset, line) VALUES (?, ?, ?, ?, ?, ?)",
            rows,
        )
        _store_sig(conn, path, sig, "input", committed, lines, _prefix(path, committed))
        conn.commit()
        stats["files"] += 1
        stats["traces"] += len(rows)
        log(f"[index] input {path.name}: {'+' if start else ''}{len(rows)} traces")
    return stats


def _prune(conn, aime: Path):
    """清理已经消失的文件对应的行。"""
    alive = {str(p) for p, _, _ in _attribution_files(aime)} | {str(p) for p, _, _ in _input_files(aime)}
    rows = conn.execute("SELECT path, kind FROM files").fetchall()
    removed = 0
    for path, kind in rows:
        if path in alive:
            continue
        if kind == "attribution":
            conn.execute("DELETE FROM traces WHERE file = ?", (path,))
            conn.execute("DELETE FROM history WHERE file = ?", (path,))
            conn.execute("DELETE FROM problem_codes WHERE file = ?", (path,))
        elif kind == "input":
            conn.execute("DELETE FROM input_index WHERE path = ?", (path,))
        conn.execute("DELETE FROM files WHERE path = ?", (path,))
        removed += 1
    if removed:
        conn.commit()
    return removed


def cluster_files(aime: Path):
    out = {}
    root = aime / "eval_output" / "cluster"
    if not root.is_dir():
        return out
    for model_dir in sorted(root.iterdir()):
        if not model_dir.is_dir():
            continue
        tree = model_dir / "cluster_tree.json"
        index = model_dir / "item_index.jsonl"
        if tree.exists():
            out[model_dir.name] = (tree, index if index.exists() else None)
    return out


def build(root: Path | None = None, log=None) -> dict:
    """增量构建索引，返回构建摘要。"""
    log = _log_factory(log)
    started = time.time()
    root = root or config.datasets_root()
    aime = root / config.AIME_DIR
    if not (aime / "eval_output").is_dir():
        raise FileNotFoundError(f"找不到数据目录：{aime}")

    config.STATE_DIR.mkdir(parents=True, exist_ok=True)
    conn = connect(config.db_path())
    try:
        intent_tree = None
        try:
            from .taxonomy import load_intent

            intent_tree = load_intent(config.INTENT_TAXONOMY_FILE)
        except Exception as exc:  # noqa: BLE001 - 树缺失不阻塞其余索引
            log(f"[warn] 意图树加载失败：{exc}")

        item_codes = {}
        for model_dir, (_, index_path) in cluster_files(aime).items():
            if index_path is None:
                item_codes[model_dir] = (ItemCodes(), "")
                continue
            codes, sig = load_item_codes(index_path, log)
            item_codes[model_dir] = (codes, sig)

        attribution = ingest_attribution(conn, aime, item_codes, intent_tree, log)
        inputs = ingest_inputs(conn, aime, log)
        removed = _prune(conn, aime)
        counts = conn.execute("SELECT COUNT(*) FROM traces").fetchone()[0]
        history = conn.execute("SELECT COUNT(*) FROM history").fetchone()[0]
        inputs_total = conn.execute("SELECT COUNT(*) FROM input_index").fetchone()[0]
        newest = conn.execute("SELECT MAX(analyzed_at) FROM traces").fetchone()[0]
        return {
            "ok": True,
            "seconds": round(time.time() - started, 1),
            "root": str(root),
            "traces": counts,
            "history": history,
            "input_traces": inputs_total,
            "input_files": inputs["files"],
            "resumed_input": inputs["resumed"],
            "attribution_files": attribution["files"],
            "skipped_attribution": attribution["skipped"],
            "skipped_input": inputs["skipped"],
            "problems": attribution["problems"],
            "unclustered": attribution["unclustered"],
            "pruned": removed,
            "data_updated_at": newest,
            "state_dir": str(config.STATE_DIR),
        }
    finally:
        conn.close()
