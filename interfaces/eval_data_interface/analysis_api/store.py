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
import os
import re
import sqlite3
import time
from concurrent.futures import ProcessPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import unquote

from . import config, human_read, timeutil

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
    problem_codes TEXT,
    problem_count INTEGER,
    problems TEXT,
    severity TEXT,
    is_correct INTEGER,
    analysis_id TEXT,
    analyzed_at TEXT,
    file TEXT,
    line INTEGER,
    offset INTEGER,
    hr_labels TEXT,
    hr_hash TEXT,
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
    problem_codes TEXT
);
CREATE INDEX IF NOT EXISTS history_file ON history(file);
CREATE TABLE IF NOT EXISTS input_index(
    trace_id TEXT NOT NULL,
    day TEXT NOT NULL,
    app_version TEXT,
    path TEXT NOT NULL,
    offset INTEGER NOT NULL,
    line INTEGER,
    PRIMARY KEY (trace_id, day, path, offset)
);
CREATE INDEX IF NOT EXISTS input_index_path ON input_index(path);
CREATE TABLE IF NOT EXISTS input_questions(
    trace_id TEXT PRIMARY KEY,
    question TEXT NOT NULL,
    file TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS input_questions_file ON input_questions(file);
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
CREATE TABLE IF NOT EXISTS meta(
    key TEXT PRIMARY KEY,
    value TEXT
);
CREATE TABLE IF NOT EXISTS changes(
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    trace_id TEXT NOT NULL,
    day TEXT NOT NULL,
    app_version TEXT NOT NULL,
    op TEXT NOT NULL,
    changed_at TEXT NOT NULL,
    human_only INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS changes_key ON changes(trace_id, day, app_version, seq);
"""

# 结构版本：落库字段的语义变了就 +1；旧库直接清掉归因派生行重扫，input_index 保留
SCHEMA_VERSION = 3

# 旧库没有的列：input 续扫需要上次提交到的字节、行数和文件头指纹
FILE_COLUMNS = {"committed": "INTEGER", "lines": "INTEGER", "prefix": "TEXT"}
# v1 只索引了 error_codes / has_error；v2 改为 problem_codes + 问题数组 + 严重度；
# 人话层增量加 hr_labels / hr_hash，就地 ALTER TABLE 不触发删表重建。
TRACE_COLUMNS = {
    "problem_codes": "TEXT",
    "problem_count": "INTEGER",
    "problems": "TEXT",
    "severity": "TEXT",
    "is_correct": "INTEGER",
    "hr_labels": "TEXT",
    "hr_hash": "TEXT",
}
HISTORY_COLUMNS = {"problem_codes": "TEXT"}
CHANGES_COLUMNS = {"human_only": "INTEGER NOT NULL DEFAULT 0"}
PREFIX_BYTES = 65536

TRACE_ID_RE = re.compile(rb'"trace_id"\s*:\s*"([^"\s]{4,80})"')
ATTR_RE = re.compile(r"^(?P<model>.+)_attribution-(?P<day>\d{4}-\d{2}-\d{2})\.jsonl$")
INPUT_DAY_RE = re.compile(r"(?P<day>\d{4}-\d{2}-\d{2})")
COMPACT_DAY_RE = re.compile(r"(?<!\d)(\d{4})(\d{2})(\d{2})(?!\d)")
QUESTION_RE = re.compile(rb'"question_text"\s*:\s*"((?:[^"\\]|\\.)*)"')


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
    for table, columns in (("traces", TRACE_COLUMNS), ("history", HISTORY_COLUMNS), ("changes", CHANGES_COLUMNS)):
        have = {row[1] for row in conn.execute(f"PRAGMA table_info({table})")}
        for name, kind in columns.items():
            if name not in have:
                conn.execute(f"ALTER TABLE {table} ADD COLUMN {name} {kind}")
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    return conn


def schema_version(conn) -> int:
    row = conn.execute("SELECT value FROM meta WHERE key = 'schema_version'").fetchone()
    try:
        return int(row[0]) if row else 0
    except (TypeError, ValueError):
        return 0


def ensure_schema(conn, log=None) -> bool:
    """旧结构就地升级：只清归因派生行，input_index 保留，避免重扫 GB 级输入。"""
    if schema_version(conn) == SCHEMA_VERSION:
        return False
    (log or (lambda message: None))(
        f"[index] 索引结构升级 {schema_version(conn)} -> {SCHEMA_VERSION}，归因数据重建"
    )
    conn.execute("DELETE FROM traces")
    conn.execute("DELETE FROM history")
    conn.execute("DELETE FROM problem_codes")
    conn.execute("DELETE FROM files WHERE kind = 'attribution'")
    conn.execute(
        "INSERT INTO meta(key, value) VALUES ('schema_version', ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (str(SCHEMA_VERSION),),
    )
    conn.commit()
    return True


# ceph-fuse 上小块读的往返代价很高；与看板 build_store 一样用 8 MB 缓冲
READ_BUFFER = 8 << 20

# input_index 结构版本：v1 的主键 (trace_id, day) 只留一行候选，先入为主；
# 同一个 trace_id 可能先出现在别的轮次记录的正文里，detail 就被绑到不含它的那一行。
INPUT_INDEX_VERSION = 2


def ensure_input_index(conn, log=None) -> bool:
    """v1 → v2：主键加上 (path, offset)，保留全部候选行，由详情侧校验行内是否真有这个 trace。"""
    row = conn.execute("SELECT value FROM meta WHERE key = 'input_index_version'").fetchone()
    if row and str(row[0]) == str(INPUT_INDEX_VERSION):
        return False
    (log or (lambda message: None))(
        f"[index] 输入索引升级 v{INPUT_INDEX_VERSION}，重建 input_index 并重扫输入文件"
    )
    conn.execute("DROP TABLE IF EXISTS input_index")
    conn.execute(
        "CREATE TABLE input_index("
        "trace_id TEXT NOT NULL, day TEXT NOT NULL, app_version TEXT, "
        "path TEXT NOT NULL, offset INTEGER NOT NULL, line INTEGER, "
        "PRIMARY KEY (trace_id, day, path, offset))"
    )
    conn.execute("CREATE INDEX IF NOT EXISTS input_index_path ON input_index(path)")
    # 签名一起清掉，下一轮构建才会真的重扫输入文件（否则 sig 命中直接跳过）
    conn.execute("DELETE FROM files WHERE kind = 'input'")
    conn.execute(
        "INSERT INTO meta(key, value) VALUES ('input_index_version', ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (str(INPUT_INDEX_VERSION),),
    )
    conn.commit()
    return True



def _lines(path: Path):
    """逐行读，读完即关文件（直接迭代 path.open() 要等 GC 才释放句柄）。"""
    with path.open("rb", buffering=READ_BUFFER) as handle:
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


def _question_from(raw: bytes):
    """从输入行头部取 question_text，避免为补问句再解析整行 JSON。"""
    match = QUESTION_RE.search(raw[:65536])
    if not match:
        return None
    try:
        text = json.loads(b'"' + match.group(1) + b'"')
    except ValueError:
        return None
    return _decoded(text)


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


def _severity(value):
    """问题条目上的严重度，只认 P0–P4；缺失或表外值返回 None。"""
    text = (value or "").strip().upper() if isinstance(value, str) else ""
    return text if text in config.SEVERITIES else None


def _tri_state(value):
    """is_correct 三态：True/False 存 1/0，数据里没填时存 NULL。"""
    if isinstance(value, bool):
        return 1 if value else 0
    if isinstance(value, str):
        text = value.strip().lower()
        if text in ("true", "1", "yes"):
            return 1
        if text in ("false", "0", "no"):
            return 0
    return None


# 索引里用于判重/回放的内容字段；file/line/offset 不进状态，
# 否则归因文件重排、行号漂移都会被误判成更新。
STATE_FIELDS = (
    "asked_at",
    "source",
    "user_id",
    "question",
    "session_id",
    "intent_code",
    "task",
    "subtask",
    "problem_codes",
    "problem_count",
    "problems",
    "severity",
    "is_correct",
    "analysis_id",
    "analyzed_at",
)
JSON_STATE_FIELDS = {"problem_codes", "problems", "severity"}
# 只用于诊断的字段不参与判重：文件被重写/尾部追加导致 mtime、行号偏移时，
# 内容没变就不该让业务方重拉。
FINGERPRINT_FIELDS = tuple(f for f in STATE_FIELDS if f not in ("analyzed_at", "analysis_id"))


def _entry_state(entry) -> tuple:
    return tuple(entry[field] for field in STATE_FIELDS)


def _row_state(row) -> tuple:
    state = dict(zip(STATE_FIELDS, row))
    for field in JSON_STATE_FIELDS:
        try:
            state[field] = json.loads(state[field]) if state[field] else (
                {} if field == "severity" else []
            )
        except (TypeError, ValueError):
            state[field] = {} if field == "severity" else []
    return tuple(state[field] for field in STATE_FIELDS)


def _fingerprint(state: tuple) -> str:
    values = dict(zip(STATE_FIELDS, state))
    payload = [values.get(field) for field in FINGERPRINT_FIELDS]
    return hashlib.sha1(
        json.dumps(payload, ensure_ascii=False, sort_keys=True, default=str).encode("utf-8")
    ).hexdigest()


def _content_changed(previous, state) -> bool:
    return previous is None or _fingerprint(previous) != _fingerprint(state)


def _trace_states(conn, where="", params=()):
    """按 (trace_id, day, app_version) 取库里现有内容的状态元组。"""
    sql = "SELECT trace_id, day, app_version, " + ", ".join(STATE_FIELDS) + " FROM traces " + where
    return {
        (row[0], row[1], row[2]): _row_state(row[3:])
        for row in conn.execute(sql, params)
    }


def _trace_state(conn, key):
    row = conn.execute(
        "SELECT " + ", ".join(STATE_FIELDS) + " FROM traces "
        "WHERE trace_id = ? AND day = ? AND app_version = ?",
        key,
    ).fetchone()
    return _row_state(row) if row else None


def _trace_hr_hashes(conn, where="", params=()):
    """按 (trace_id, day, app_version) 取库里现有的人话译文指纹。"""
    sql = "SELECT trace_id, day, app_version, hr_hash FROM traces " + where
    return {(row[0], row[1], row[2]): row[3] for row in conn.execute(sql, params)}


def _trace_hr_hash(conn, key):
    row = conn.execute(
        "SELECT hr_hash FROM traces WHERE trace_id = ? AND day = ? AND app_version = ?",
        key,
    ).fetchone()
    return row[0] if row else None


def _emit_changes(conn, upserts, deletes, changed_at, human_upserts=()) -> int:
    """写入变更流：upserts/deletes 为通用变更（human_only=0），human_upserts 仅对 text_mode=human 可见。"""
    rows = [(trace_id, day, app, "upsert", changed_at, 0) for trace_id, day, app in upserts]
    rows += [(trace_id, day, app, "delete", changed_at, 0) for trace_id, day, app in deletes]
    rows += [(trace_id, day, app, "upsert", changed_at, 1) for trace_id, day, app in human_upserts]
    if rows:
        conn.executemany(
            "INSERT INTO changes(trace_id, day, app_version, op, changed_at, human_only) VALUES (?, ?, ?, ?, ?, ?)",
            rows,
        )
    return len(rows)


def _seed_changes(conn, log) -> int:
    """老索引升级：给还没有变更记录的 trace 补一条 upsert，让 since 留空的首次同步能拿全量。"""
    seeded = conn.execute("SELECT value FROM meta WHERE key = 'changes_seeded'").fetchone()
    if seeded:
        return 0
    changed_at = timeutil.utc_rfc3339(datetime.now(timezone.utc))
    cursor = conn.execute(
        "INSERT INTO changes(trace_id, day, app_version, op, changed_at) "
        "SELECT t.trace_id, t.day, t.app_version, 'upsert', ? FROM traces t WHERE NOT EXISTS ("
        "  SELECT 1 FROM changes c WHERE c.trace_id = t.trace_id AND c.day = t.day "
        "  AND c.app_version = t.app_version)",
        (changed_at,),
    )
    count = cursor.rowcount or 0
    conn.execute(
        "INSERT INTO meta(key, value) VALUES ('changes_seeded', '1') "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    )
    conn.commit()
    if count:
        log(f"[index] 变更流初始化：{count} 条 trace")
    return count


class ItemCodes:
    """cluster item_index 的 join：主键 (文件, 行, 轮次, 问题序号)，带标签校验兜底。"""

    def __init__(self):
        self.by_turn: dict[tuple, str] = {}
        self.by_label: dict[tuple, str] = {}
        self.by_session: dict[tuple, str] = {}
        # 4.4+ 的 item_index 不再带 file/line，改为 (trace_id, turn, problem) 定位
        self.by_trace: dict[tuple, str] = {}
        self.by_trace_label: dict[tuple, str] = {}
        # item_index 里出现过的最大批次日期，作为"聚类覆盖到哪天"的对外信号
        self.max_date: str | None = None
        # 每个归因文件各自的映射指纹：聚类流水线每次追加 item_index，只让涉及的文件重扫
        self.digests: dict[str, "hashlib._Hash"] = {}

    def sig_for(self, basename) -> str:
        digest = self.digests.get(basename)
        return digest.hexdigest() if digest else ""

    def code_for(self, trace_id, basename, line, turn_index, problem_index, label, session_level=False):
        if trace_id:
            code = self.by_trace.get((trace_id, int(turn_index or 0), int(problem_index)))
            if code:
                return code
            if label:
                code = self.by_trace_label.get((trace_id, label))
                if code:
                    return code
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
        label = item.get("label")
        problem_index = item.get("problem_index") or 0
        turn_index = item.get("turn_index")
        json_path = item.get("json_path") or ""
        trace_id = _text(item.get("trace_id"))
        line = item.get("line")
        item_date = _text(item.get("date"))
        if item_date and (codes.max_date is None or item_date > codes.max_date):
            codes.max_date = item_date
        # 4.4+ 用 src_rel（相对路径），旧格式用 file（绝对路径）
        basename = str(item.get("file") or item.get("src_rel") or "").replace("\\", "/").rsplit("/", 1)[-1]
        if not basename and line is None:
            continue
        # 按文件顺序累计（by_label 取第一条，顺序变了也算映射变了）
        digest = codes.digests.get(basename)
        if digest is None:
            digest = codes.digests[basename] = hashlib.blake2b(digest_size=12)
        digest.update(json.dumps([trace_id, line, turn_index, problem_index, json_path, code, label],
                                 ensure_ascii=False).encode("utf-8"))
        if line is None:
            # 新格式没有行号：按 trace + 轮次 + 问题序号直接定位
            if trace_id:
                codes.by_trace[(trace_id, int(turn_index or 0), int(problem_index))] = code
                if label:
                    codes.by_trace_label.setdefault((trace_id, label), code)
            continue
        if config.DATASET == "wencai_eval" and trace_id and json_path.startswith("turns"):
            # 问财 RSI 同时给了行号和 turns[...] 定位；按 trace 定位不受 cohort 文件行号漂移影响。
            codes.by_trace.setdefault((trace_id, int(turn_index or 0), int(problem_index)), code)
            if label:
                codes.by_trace_label.setdefault((trace_id, label), code)
        if json_path.startswith("session_problem"):
            codes.by_session[(basename, int(line), int(problem_index))] = code
        elif turn_index is not None:
            codes.by_turn[(basename, int(line), int(turn_index), int(problem_index))] = code
        if label:
            codes.by_label.setdefault((basename, int(line), label), code)
    return codes, sig


def _attribution_files(product: Path):
    """返回 [(path, source, model_dir)]。"""
    return config.LAYOUT.attribution_files(product)


def _input_files(product: Path):
    """返回 [(path, model_dir)]。"""
    return config.LAYOUT.input_files(product)


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


def load_category_meta(root: Path, log=None) -> tuple[dict[str, tuple[str | None, str | None]], str]:
    """加载 AIME 上游按天产出的 category_meta.json 并集：trace_id -> (task_category, subtask_category)。

    按文件内容计算指纹（不按 mtime），避免上游重写同内容文件触发无效重扫；
    问财等没有该目录的数据集直接返回空映射。
    """
    if config.DATASET != "aime_eval":
        return {}, ""
    base = root / "0_litefusion_data" / "online_data"
    if not base.is_dir():
        return {}, ""
    files = sorted(base.glob("*/[0-9][0-9]/[0-9][0-9]/category_meta.json"))
    if not files:
        return {}, ""
    log = _log_factory(log)
    index: dict[str, tuple[str | None, str | None]] = {}
    fingerprint = hashlib.sha1()
    for path in files:
        try:
            raw = path.read_bytes()
        except OSError as exc:
            log(f"[warn] 读取 {path} 失败：{exc}")
            continue
        rel = path.relative_to(base).as_posix()
        fingerprint.update(f"{rel}:{len(raw)}:{hashlib.md5(raw).hexdigest()}\n".encode("utf-8"))
        try:
            data = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, ValueError) as exc:
            log(f"[warn] 跳过损坏的 {path}：{exc}")
            continue
        if not isinstance(data, dict):
            continue
        for tid, item in data.items():
            if not isinstance(item, dict):
                continue
            task = _clean(item.get("task_category"))
            subtask = _clean(item.get("subtask_category"))
            if task or subtask:
                index[str(tid)] = (task, subtask)
    return index, fingerprint.hexdigest()[:16]


def _intent_lookup(intent_tree):
    by_pair = {}
    by_label = {}
    if intent_tree is None:
        return by_pair, by_label
    for node in intent_tree.nodes.values():
        by_label.setdefault((node.level, node.label), node.code)
        if node.level == 2 and node.parent and node.parent in intent_tree.nodes:
            parent_label = intent_tree.nodes[node.parent].label
            by_pair.setdefault((parent_label, node.label), node.code)
    return by_pair, by_label


def _resolve_intent(raw_task, raw_subtask, intent_tree, by_pair, by_label):
    """只保留能映射到当前意图树（v1.9）的意图；老体系或表外标签清空，不丢 trace。"""
    if intent_tree is None:
        return None, raw_task, raw_subtask
    code = by_pair.get((raw_task, raw_subtask)) if (raw_task and raw_subtask) else None
    if code is None and raw_subtask:
        code = by_label.get((2, raw_subtask))
    if code is None and raw_task:
        code = by_label.get((1, raw_task))
    if code is None:
        return None, None, None
    node = intent_tree.node(code)
    if node is None:
        return None, None, None
    if node.level == 2 and node.parent and node.parent in intent_tree.nodes:
        return code, intent_tree.nodes[node.parent].label, node.label
    return code, node.label, None


def ingest_attribution(
    conn,
    product: Path,
    item_codes_by_model,
    intent_tree,
    log,
    category_meta=None,
    category_sig="",
):
    """把一个 attribution 文件读进 traces / history；同一 trace 保留行号最大的一行。"""
    by_pair, by_label = _intent_lookup(intent_tree)
    category_meta = category_meta or {}
    stats = {
        "files": 0,
        "skipped": 0,
        "traces": 0,
        "history": 0,
        "problems": 0,
        "unclustered": 0,
        "changes": 0,
        "human_changes": 0,
    }
    codes_by_model = {k: c for k, (c, _) in item_codes_by_model.items()}
    hr_reader = human_read.reader_for(product)

    for path, source, model_dir in _attribution_files(product):
        codes = codes_by_model.get(model_dir) or ItemCodes()
        rel_path = human_read.rel_path_for(path)
        hr_sig = hr_reader.file_sig(rel_path)
        # 依赖签名包含 item_index 属于本文件的指纹 + category_meta 全局内容指纹 + 本文件 human_read 聚合指纹
        sig = f"{_file_sig(path)}|{codes.sig_for(path.name)}"
        if category_sig:
            sig += f"|{category_sig}"
        if hr_sig:
            sig += f"|{hr_sig}"
        if _cached_sig(conn, path) == sig:
            stats["skipped"] += 1
            continue

        basename = path.name
        analyzed_at = timeutil.utc_rfc3339(datetime.fromtimestamp(path.stat().st_mtime, timezone.utc))
        default_day = ATTR_RE.match(basename)
        default_day = default_day.group("day") if default_day else None

        # history 在扫描过程中逐条写入，旧记录必须在扫描前清掉
        conn.execute("DELETE FROM history WHERE file = ?", (str(path),))

        kept: dict[str, dict] = {}
        order: list[str] = []
        line_offset = 0
        with hr_reader.open_file(rel_path) as hr_index:
            for line_no, raw in enumerate(_lines(path), 1):
                current_offset = line_offset
                line_offset += len(raw)
                try:
                    record = json.loads(raw)
                except ValueError:
                    log(f"[warn] {basename}:{line_no} 不是合法 JSON，已跳过")
                    continue
                hr_record = hr_index.lookup(record) if hr_index else None
                smeta = record.get("session_meta") or {}
                session_id = _text(smeta.get("session_id") or smeta.get("thread_id"))
                # 上游字段漂移：老记录写 question，新记录（2026-11-11 起）只写同义的 question_text
                question = _decoded(smeta.get("question") or smeta.get("question_text"))
                session_problems = record.get("session_problem") or []
                turns = record.get("turns") or []
                for turn_index, turn in enumerate(turns):
                    meta = turn.get("meta") or {}
                    trace_id = _text(meta.get("trace_id"))
                    if not trace_id:
                        continue
                    # session 是外层 meta；session_meta 缺失时用每轮 trace meta 的 session_id 兜底。
                    turn_session_id = session_id or _text(meta.get("session_id"))
                    stamp = timeutil.parse_iso(meta.get("timestamp")) or timeutil.parse_iso(smeta.get("request_time"))
                    day = timeutil.local_day(stamp, config.DAY_TZ) or default_day
                    # 意图优先按 trace_id 查上游 category_meta.json（避免多轮 session 冲突，且自动追新），
                    # 查不到再兜底归因行里的轮次/会话级字段；最终只保留当前新版树里的意图，旧体系标签清空。
                    cat_pair = category_meta.get(trace_id)
                    if cat_pair is not None:
                        raw_task, raw_subtask = cat_pair
                    else:
                        raw_task = _clean(
                            meta.get("task")
                            or meta.get("task_category")
                            or smeta.get("task")
                            or smeta.get("task_category")
                        )
                        raw_subtask = _clean(
                            meta.get("subtask")
                            or meta.get("subtask_category")
                            or smeta.get("subtask")
                            or smeta.get("subtask_category")
                        )
                    intent_code, task, subtask = _resolve_intent(
                        raw_task, raw_subtask, intent_tree, by_pair, by_label
                    )

                    turn_problems = list(turn.get("problem") or [])
                    problems = list(turn_problems)
                    session_level = False
                    if turn_index == len(turns) - 1 and session_problems:
                        problems = problems + list(session_problems)
                        session_level = True

                    matched_hr = human_read.match_turn(record, hr_record, turn_index) if hr_record else None
                    if matched_hr is not None:
                        hr_turn, hr_turn_probs, hr_sprobs = matched_hr
                        hr_combined = hr_turn_probs + (hr_sprobs if session_level else [])
                        hr_labels = [
                            ((hp.get("label") or "").strip() or op.get("label"))
                            for op, hp in zip(problems, hr_combined)
                        ]
                        hr_hash = human_read.turn_hr_fingerprint(
                            hr_record, hr_turn, include_session=(turn_index == len(turns) - 1)
                        )
                    else:
                        hr_labels = None
                        hr_hash = None

                    found = []
                    code_rows = []
                    compact = []
                    severity = {}
                    for problem_index, problem in enumerate(problems):
                        is_session = session_level and problem_index >= len(turn_problems)
                        local_index = problem_index - len(turn_problems) if is_session else problem_index
                        code = codes.code_for(
                            trace_id,
                            basename,
                            line_no,
                            turn_index,
                            local_index,
                            problem.get("label"),
                            session_level=is_session,
                        )
                        level = _severity(problem.get("severity"))
                        compact.append(
                            {
                                "code": code,
                                "label": problem.get("label"),
                                "severity": level,
                                "component": problem.get("component_family") or problem.get("component"),
                                "session_level": is_session,
                            }
                        )
                        stats["problems"] += 1
                        if level:
                            severity[level] = severity.get(level, 0) + 1
                        if code:
                            found.append(code)
                            code_rows.append(("session" if is_session else "turn", local_index, code))
                        else:
                            stats["unclustered"] += 1
                    problem_codes = sorted(set(found))

                    entry = {
                        "trace_id": trace_id,
                        "day": day,
                        "app_version": config.LAYOUT.app_version(model_dir, meta),
                        "asked_at": timeutil.utc_rfc3339(stamp),
                        "source": source,
                        "user_id": _text(meta.get("user_id")),
                        "question": question,
                        "session_id": turn_session_id,
                        "intent_code": intent_code,
                        "task": task,
                        "subtask": subtask,
                        "problem_codes": problem_codes,
                        "problem_count": len(compact),
                        "problems": compact,
                        "severity": severity,
                        "is_correct": _tri_state(turn.get("is_correct")),
                        "analysis_id": _analysis_id(basename, line_no),
                        "analyzed_at": analyzed_at,
                        "file": str(path),
                        "line": line_no,
                        "offset": current_offset,
                        "hr_labels": hr_labels,
                        "hr_hash": hr_hash,
                        "code_rows": code_rows,
                    }
                    if trace_id in kept:
                        old = kept[trace_id]
                        conn.execute(
                            "INSERT INTO history(trace_id, day, app_version, analysis_id, analyzed_at, file, line, offset, intent_code, problem_codes) "
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
                                json.dumps(old["problem_codes"], ensure_ascii=False),
                            ),
                        )
                        stats["history"] += 1
                    else:
                        order.append(trace_id)
                    kept[trace_id] = entry

        # 新旧内容对比要在删除前取：PK 是 (trace_id, day, app_version)，
        # 同一个 key 可能被别的归因文件写过，只看本文件会漏判。
        old_states = _trace_states(conn, "WHERE file = ?", (str(path),))
        old_hr = _trace_hr_hashes(conn, "WHERE file = ?", (str(path),))
        new_states = {
            (tid, kept[tid]["day"], kept[tid]["app_version"]): _entry_state(kept[tid])
            for tid in order
        }
        new_hr = {
            (tid, kept[tid]["day"], kept[tid]["app_version"]): kept[tid]["hr_hash"]
            for tid in order
        }
        carry = {
            key: _trace_state(conn, key)
            for key in new_states
            if key not in old_states
        }
        carry_hr = {
            key: _trace_hr_hash(conn, key)
            for key in new_hr
            if key not in old_hr
        }

        conn.execute("DELETE FROM traces WHERE file = ?", (str(path),))
        conn.execute("DELETE FROM problem_codes WHERE file = ?", (str(path),))

        conn.executemany(
            "INSERT OR REPLACE INTO traces(trace_id, day, app_version, asked_at, source, user_id, question, session_id, "
            "intent_code, task, subtask, problem_codes, problem_count, problems, severity, is_correct, "
            "analysis_id, analyzed_at, file, line, offset, hr_labels, hr_hash) "
            "VALUES (:trace_id, :day, :app_version, :asked_at, :source, :user_id, :question, :session_id, "
            ":intent_code, :task, :subtask, :problem_codes, :problem_count, :problems, :severity, :is_correct, "
            ":analysis_id, :analyzed_at, :file, :line, :offset, :hr_labels, :hr_hash)",
            [
                {
                    **kept[tid],
                    "problem_codes": json.dumps(kept[tid]["problem_codes"], ensure_ascii=False),
                    "problems": json.dumps(kept[tid]["problems"], ensure_ascii=False),
                    "severity": json.dumps(kept[tid]["severity"], ensure_ascii=False, sort_keys=True),
                    "hr_labels": (
                        json.dumps(kept[tid]["hr_labels"], ensure_ascii=False)
                        if kept[tid]["hr_labels"] is not None
                        else None
                    ),
                }
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
        base_upserts = [
            key for key, state in new_states.items()
            if _content_changed(old_states.get(key) or carry.get(key), state)
        ]
        base_upsert_set = set(base_upserts)
        human_upserts = [
            key for key, hhash in new_hr.items()
            if key not in base_upsert_set
            and hhash != (old_hr[key] if key in old_hr else carry_hr.get(key))
        ]
        deletes = [key for key in old_states if key not in new_states]
        changed = _emit_changes(
            conn,
            base_upserts,
            deletes,
            timeutil.utc_rfc3339(datetime.now(timezone.utc)),
            human_upserts=human_upserts,
        )
        _store_sig(conn, path, sig, "attribution")
        conn.commit()
        stats["files"] += 1
        stats["traces"] += len(order)
        stats["changes"] += changed
        stats["human_changes"] += len(human_upserts)
    return stats


def _scan_input_file(task):
    """Scan one input file from a committed offset; returns rows for the parent to write."""
    path_str, file_day, suffix, start, line_no = task
    path = Path(path_str)
    rows, qrows = [], []
    offset = committed = start
    lines = line_no
    want_question = config.DATASET == "wencai_eval"
    with path.open("rb", buffering=READ_BUFFER) as handle:
        handle.seek(start)
        for raw in handle:
            line_no += 1
            ids = TRACE_ID_RE.findall(raw)
            question = _question_from(raw) if want_question and ids else None
            for trace_id in ids:
                tid = trace_id.decode("utf-8", "replace")
                rows.append((tid, file_day, suffix, path_str, offset, line_no))
                if question:
                    qrows.append((tid, question, path_str))
            offset += len(raw)
            if raw.endswith(b"\n"):
                committed, lines = offset, line_no
    return {"path": path_str, "rows": rows, "qrows": qrows,
            "committed": committed, "lines": lines, "start": start}


def ingest_inputs(conn, product: Path, log):
    """扫描 eval_input 的行号，建立 trace_id → (文件, 偏移) 索引。

    文件头 64 KB 没变、只是变长时，从上次最后一个完整换行处续扫，已有的行不动；
    其余情况（新文件、被截短或重写）整份重扫。未写完的末行照常建索引，
    但不计入续扫起点，下次连同写完的部分重新读一遍。
    每个文件独立扫描，最多 4 个进程并行；问财 74 GB 输入串行要两个多小时。
    """
    stats = {"files": 0, "skipped": 0, "traces": 0, "resumed": 0}
    tasks, pending = [], []
    for path, model_dir in _input_files(product):
        sig = _file_sig(path)
        prev = conn.execute(
            "SELECT sig, committed, lines, prefix FROM files WHERE path = ?", (str(path),)
        ).fetchone()
        if prev and prev[0] == sig:
            stats["skipped"] += 1
            continue
        suffix = model_dir
        match = INPUT_DAY_RE.search(path.name)
        if match:
            file_day = match.group("day")
        else:
            compact = COMPACT_DAY_RE.search(path.name)
            file_day = f"{compact.group(1)}-{compact.group(2)}-{compact.group(3)}" if compact else None
        start, line_no = 0, 0
        if (prev and prev[1] is not None and path.stat().st_size >= prev[1]
                and prev[3] == _prefix(path, prev[1])):
            start, line_no = prev[1], prev[2] or 0
            stats["resumed"] += 1
        else:
            conn.execute("DELETE FROM input_index WHERE path = ?", (str(path),))
            conn.execute("DELETE FROM input_questions WHERE file = ?", (str(path),))
        tasks.append((str(path), file_day, suffix, start, line_no))
        pending.append((path, sig, start))

    if not tasks:
        return stats
    workers = min(4, os.cpu_count() or 1)
    if workers > 1 and len(tasks) >= 2:
        with ProcessPoolExecutor(max_workers=workers) as pool:
            results = list(pool.map(_scan_input_file, tasks))
    else:
        results = [_scan_input_file(task) for task in tasks]

    for (path, sig, start), result in zip(pending, results):
        conn.executemany(
            "INSERT OR IGNORE INTO input_index(trace_id, day, app_version, path, offset, line) VALUES (?, ?, ?, ?, ?, ?)",
            result["rows"],
        )
        if result["qrows"]:
            conn.executemany(
                "INSERT OR REPLACE INTO input_questions(trace_id, question, file) VALUES (?, ?, ?)",
                result["qrows"],
            )
        _store_sig(conn, path, sig, "input", result["committed"], result["lines"],
                   _prefix(path, result["committed"]))
        conn.commit()
        stats["files"] += 1
        stats["traces"] += len(result["rows"])
        log(f"[index] input {path.name}: {'+' if start else ''}{len(result['rows'])} traces")
    return stats


def backfill_questions(conn, log) -> int:
    """旧索引升级：用 input_index 的行偏移补 input_questions，只读每行头部。

    74 GB 的输入不必重扫：每个 offset 读 64 KB 就能拿到 question_text。
    只跑一次（meta 位点），之后 ingest_inputs 边扫边写。
    """
    if conn.execute("SELECT value FROM meta WHERE key = 'input_questions_v1'").fetchone():
        return 0
    grouped = {}
    for path, offset, trace_id in conn.execute("SELECT path, offset, trace_id FROM input_index"):
        grouped.setdefault(path, {}).setdefault(offset, set()).add(trace_id)
    rows = []
    for path, offsets in grouped.items():
        try:
            handle = open(path, "rb", buffering=0)
        except OSError:
            continue
        with handle:
            for offset, tids in offsets.items():
                try:
                    handle.seek(offset)
                    raw = handle.read(65536)
                except OSError:
                    continue
                question = _question_from(raw)
                if question:
                    rows.extend((tid, question, path) for tid in tids)
    if rows:
        conn.executemany(
            "INSERT OR REPLACE INTO input_questions(trace_id, question, file) VALUES (?, ?, ?)",
            rows,
        )
    conn.execute(
        "INSERT INTO meta(key, value) VALUES ('input_questions_v1', '1') "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    )
    conn.commit()
    log(f"[index] 输入问句回填：{len(rows)} 条 trace")
    return len(rows)


def fill_questions(conn) -> int:
    """归因 session_meta 缺 question 时，用同一 trace 的输入行问句补齐并记一条变更。"""
    rows = conn.execute(
        "UPDATE traces SET question = ("
        "  SELECT q.question FROM input_questions q WHERE q.trace_id = traces.trace_id"
        ") WHERE (question IS NULL OR question = '') AND EXISTS ("
        "  SELECT 1 FROM input_questions q WHERE q.trace_id = traces.trace_id AND q.question <> ''"
        ") RETURNING trace_id, day, app_version"
    ).fetchall()
    if rows:
        _emit_changes(conn, rows, [], timeutil.utc_rfc3339(datetime.now(timezone.utc)))
        conn.commit()
    return len(rows)


def _prune(conn, product: Path):
    """清理已经消失的文件对应的行；删掉的 trace 写一条 delete 变更。"""
    alive = {str(p) for p, _, _ in _attribution_files(product)} | {str(p) for p, _ in _input_files(product)}
    rows = conn.execute("SELECT path, kind FROM files").fetchall()
    removed = 0
    changed = 0
    for path, kind in rows:
        if path in alive:
            continue
        if kind == "attribution":
            vanished = list(_trace_states(conn, "WHERE file = ?", (path,)))
            conn.execute("DELETE FROM traces WHERE file = ?", (path,))
            conn.execute("DELETE FROM history WHERE file = ?", (path,))
            conn.execute("DELETE FROM problem_codes WHERE file = ?", (path,))
            changed += _emit_changes(
                conn, [], vanished, timeutil.utc_rfc3339(datetime.now(timezone.utc))
            )
        elif kind == "input":
            conn.execute("DELETE FROM input_index WHERE path = ?", (path,))
            conn.execute("DELETE FROM input_questions WHERE file = ?", (path,))
        conn.execute("DELETE FROM files WHERE path = ?", (path,))
        removed += 1
    if removed or changed:
        conn.commit()
    return removed, changed


def cluster_files(product: Path):
    return config.LAYOUT.cluster_files(product)


def build(root: Path | None = None, log=None) -> dict:
    """增量构建索引，返回构建摘要。"""
    log = _log_factory(log)
    started = time.time()
    root = root or config.datasets_root()
    product_dir = root / config.PRODUCT_DIR
    if not (product_dir / "eval_output").is_dir():
        raise FileNotFoundError(f"找不到数据目录：{product_dir}")

    config.STATE_DIR.mkdir(parents=True, exist_ok=True)
    conn = connect(config.db_path())
    try:
        ensure_schema(conn, log)
        ensure_input_index(conn, log)
        intent_tree = None
        try:
            from .taxonomy import load_intent

            intent_tree = load_intent(config.INTENT_TAXONOMY_FILE)
        except Exception as exc:  # noqa: BLE001 - 树缺失不阻塞其余索引
            log(f"[warn] 意图树加载失败：{exc}")

        item_codes = {}
        for model_dir, (_, index_path) in cluster_files(product_dir).items():
            if index_path is None:
                item_codes[model_dir] = (ItemCodes(), "")
                continue
            codes, sig = load_item_codes(index_path, log)
            item_codes[model_dir] = (codes, sig)

        category_meta, category_sig = load_category_meta(root, log)
        attribution = ingest_attribution(
            conn,
            product_dir,
            item_codes,
            intent_tree,
            log,
            category_meta=category_meta,
            category_sig=category_sig,
        )
        # 问财归因常缺 question，用输入行补齐；AIME 的问句本来就在归因里，不做额外处理。
        questions = filled = 0
        if config.DATASET == "wencai_eval":
            # 先用已有 input_index 的偏移补问句（不必等 74 GB 重扫），再扫剩余输入。
            questions = backfill_questions(conn, log)
            filled = fill_questions(conn)
        inputs = ingest_inputs(conn, product_dir, log)
        if config.DATASET == "wencai_eval":
            filled += fill_questions(conn)
        seeded = _seed_changes(conn, log)
        removed, pruned_changes = _prune(conn, product_dir)
        counts = conn.execute("SELECT COUNT(*) FROM traces").fetchone()[0]
        history = conn.execute("SELECT COUNT(*) FROM history").fetchone()[0]
        inputs_total = conn.execute("SELECT COUNT(*) FROM input_index").fetchone()[0]
        changes_total = conn.execute("SELECT COUNT(*) FROM changes").fetchone()[0]
        latest_seq = conn.execute("SELECT COALESCE(MAX(seq), 0) FROM changes").fetchone()[0]
        latest_seq_raw = conn.execute(
            "SELECT COALESCE(MAX(seq), 0) FROM changes WHERE COALESCE(human_only, 0) = 0"
        ).fetchone()[0]
        hr_traces = conn.execute("SELECT COUNT(*) FROM traces WHERE hr_hash IS NOT NULL").fetchone()[0]
        newest = conn.execute("SELECT MAX(analyzed_at) FROM traces").fetchone()[0]
        # 汇总以库里全量为准（增量构建时 stats 只覆盖本轮重扫的文件）
        severity = {level: 0 for level in config.SEVERITIES}
        problems_total = 0
        for row in conn.execute("SELECT problem_count, severity FROM traces"):
            problems_total += row[0] or 0
            try:
                parsed = json.loads(row[1] or "{}")
            except ValueError:
                parsed = {}
            for level, count in parsed.items():
                if level in severity:
                    severity[level] += int(count or 0)
        clustered = conn.execute("SELECT COUNT(*) FROM problem_codes").fetchone()[0]
        cluster_dates = [codes.max_date for codes, _ in item_codes.values() if codes.max_date]
        return {
            "ok": True,
            "dataset": config.DATASET,
            "product_dir": config.PRODUCT_DIR,
            "seconds": round(time.time() - started, 1),
            "root": str(root),
            "traces": counts,
            "history": history,
            "input_traces": inputs_total,
            "input_files": inputs["files"],
            "resumed_input": inputs["resumed"],
            "attribution_files": attribution["files"],
            "skipped_attribution": attribution["skipped"],
            "category_meta": len(category_meta),
            "skipped_input": inputs["skipped"],
            "questions_backfilled": questions,
            "questions_filled": filled,
            "problems": problems_total,
            "unclustered": max(0, problems_total - clustered),
            "cluster_through": max(cluster_dates) if cluster_dates else None,
            "severity": severity,
            "pruned": removed,
            "changes": changes_total,
            "changes_emitted": attribution["changes"] + pruned_changes + filled,
            "human_changes_emitted": attribution["human_changes"],
            "changes_seeded": seeded,
            "latest_seq": latest_seq,
            "latest_seq_raw": latest_seq_raw,
            "human_read_traces": hr_traces,
            "data_updated_at": newest,
            "state_dir": str(config.STATE_DIR),
        }
    finally:
        conn.close()
