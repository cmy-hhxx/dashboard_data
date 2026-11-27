"""SQLite WAL state store for internal evaluation runs, per-case lifecycle,
failure logs, event timeline, and incremental result change streams.
"""

from __future__ import annotations

import json
import sqlite3
import threading
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

from .config import ALLOWED_SIDES, SEVERITY_ORDER, SEVERITY_RANK
from .timeutil import parse_rfc3339, utc_now, utc_rfc3339

TERMINAL_RUN_STATUSES = frozenset({"succeeded", "completed_with_errors", "failed", "cancelled"})
ACTIVE_RUN_STATUSES = frozenset({"queued", "preparing_questions", "dispatching", "running", "finalizing", "cancelling"})
TERMINAL_CASE_STATUSES = frozenset({"ready", "failed", "rejected"})

SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS runs (
    run_id TEXT PRIMARY KEY,
    idempotency_key TEXT UNIQUE,
    version TEXT NOT NULL,
    round_order INTEGER NOT NULL,
    round_dir_name TEXT NOT NULL,
    round_dir_path TEXT NOT NULL,
    model TEXT NOT NULL,
    tier INTEGER NOT NULL,
    requested_count INTEGER NOT NULL,
    actual_count INTEGER NOT NULL DEFAULT 0,
    sides_json TEXT NOT NULL,
    before_mode TEXT NOT NULL DEFAULT 'live',
    before_agent_json TEXT NOT NULL,
    after_agent_json TEXT NOT NULL,
    before_agent_label TEXT NOT NULL,
    after_agent_label TEXT NOT NULL,
    status TEXT NOT NULL,
    stage TEXT NOT NULL,
    error_code TEXT,
    error_message TEXT,
    callback_url TEXT,
    dispatch_files_json TEXT NOT NULL DEFAULT '{}',
    upstream_jobs_json TEXT NOT NULL DEFAULT '{}',
    side_collector_status_json TEXT NOT NULL DEFAULT '{}',
    last_ingest_at TEXT,
    last_cluster_at TEXT,
    first_ready_at TEXT,
    cluster_batches_completed INTEGER NOT NULL DEFAULT 0,
    taxonomy_created_components INTEGER NOT NULL DEFAULT 0,
    taxonomy_created_leaves INTEGER NOT NULL DEFAULT 0,
    cancel_requested INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    updated_at TEXT NOT NULL,
    meta_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_runs_version ON runs(version, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status, created_at ASC);

CREATE TABLE IF NOT EXISTS targets (
    run_id TEXT NOT NULL,
    case_key TEXT NOT NULL,
    eq_index INTEGER NOT NULL,
    source_input_id INTEGER,
    source_trace_id TEXT NOT NULL,
    source_session_id TEXT NOT NULL DEFAULT '',
    source_model TEXT NOT NULL DEFAULT '',
    source_origin TEXT NOT NULL DEFAULT 'bench',
    question TEXT NOT NULL,
    task TEXT NOT NULL DEFAULT '',
    subtask TEXT NOT NULL DEFAULT '',
    request_time TEXT NOT NULL DEFAULT '',
    turn TEXT NOT NULL DEFAULT 'single',
    session_round INTEGER NOT NULL DEFAULT 1,
    bench_rank INTEGER NOT NULL DEFAULT 0,
    bench_severity TEXT NOT NULL DEFAULT '',
    bench_primary_json TEXT NOT NULL DEFAULT '{}',
    PRIMARY KEY (run_id, case_key)
);

CREATE INDEX IF NOT EXISTS idx_targets_eq ON targets(run_id, eq_index);

CREATE TABLE IF NOT EXISTS side_cases (
    run_id TEXT NOT NULL,
    side TEXT NOT NULL,
    case_key TEXT NOT NULL,
    eq_index INTEGER NOT NULL,
    status TEXT NOT NULL,
    failed_stage TEXT,
    error_code TEXT,
    error_message TEXT,
    retry_count INTEGER NOT NULL DEFAULT 0,
    linked_input_id INTEGER,
    linked_output_id INTEGER,
    trace_id TEXT,
    session_id TEXT,
    request_time TEXT,
    raw_file TEXT,
    prepared_file TEXT,
    attribution_file TEXT,
    is_gold INTEGER NOT NULL DEFAULT 0,
    problem_count INTEGER NOT NULL DEFAULT 0,
    max_severity TEXT,
    severity_counts_json TEXT NOT NULL DEFAULT '{}',
    problems_json TEXT NOT NULL DEFAULT '[]',
    cluster_paths_json TEXT NOT NULL DEFAULT '[]',
    cluster_labels_json TEXT NOT NULL DEFAULT '[]',
    attribution_summary TEXT,
    is_correct INTEGER,
    fetched_at TEXT,
    prepared_at TEXT,
    evaluated_at TEXT,
    clustered_at TEXT,
    ready_at TEXT,
    change_seq INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (run_id, side, case_key)
);

CREATE INDEX IF NOT EXISTS idx_side_cases_status ON side_cases(run_id, side, status);
CREATE INDEX IF NOT EXISTS idx_side_cases_trace ON side_cases(run_id, side, trace_id);
CREATE INDEX IF NOT EXISTS idx_side_cases_seq ON side_cases(run_id, change_seq);
CREATE INDEX IF NOT EXISTS idx_side_cases_ready ON side_cases(run_id, status, eq_index);

CREATE TABLE IF NOT EXISTS failures (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    side TEXT NOT NULL,
    case_key TEXT,
    trace_id TEXT,
    stage TEXT NOT NULL,
    error_code TEXT NOT NULL,
    error_message TEXT NOT NULL,
    retry_count INTEGER NOT NULL DEFAULT 0,
    resolved INTEGER NOT NULL DEFAULT 0,
    details_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_failures_run ON failures(run_id, stage, side, id DESC);

CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    level TEXT NOT NULL,
    stage TEXT NOT NULL,
    side TEXT,
    event_type TEXT NOT NULL,
    message TEXT NOT NULL,
    details_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_run ON events(run_id, id DESC);

CREATE TABLE IF NOT EXISTS run_seq (
    run_id TEXT PRIMARY KEY,
    latest_seq INTEGER NOT NULL DEFAULT 0
);
"""


def _jloads(text: str | None, default: Any) -> Any:
    if not text:
        return default
    try:
        return json.loads(text)
    except ValueError:
        return default


def _jdumps(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def compute_severity_stats(problems: list[dict[str, Any]]) -> tuple[bool, str, dict[str, int]]:
    counts = {sev: 0 for sev in ("P0", "P1", "P2", "P3", "P4")}
    best_rank = SEVERITY_RANK["GOLD"]
    best_sev = "GOLD"
    for prob in problems:
        sev = str(prob.get("severity") or "").strip().upper()
        if sev in counts:
            counts[sev] += 1
            if SEVERITY_RANK[sev] < best_rank:
                best_rank = SEVERITY_RANK[sev]
                best_sev = sev
    is_gold = len(problems) == 0
    if not is_gold and best_sev == "GOLD":
        # Problems exist without recognized P0-P4 severity: default to P4 for ranking
        best_sev = "P4"
    return is_gold, best_sev, counts


class StateStore:
    """Thread-safe SQLite state manager (safe on local disk, overlayfs, and CephFS)."""

    def __init__(self, db_path: Path):
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._write_lock = threading.RLock()
        self._init_schema()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(str(self.db_path), timeout=30.0, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA synchronous=NORMAL")
        conn.execute("PRAGMA busy_timeout=30000")
        return conn

    @contextmanager
    def _tx(self) -> Iterator[sqlite3.Connection]:
        with self._write_lock:
            conn = self._connect()
            try:
                yield conn
                conn.commit()
            except Exception:
                conn.rollback()
                raise
            finally:
                conn.close()

    @contextmanager
    def _read(self) -> Iterator[sqlite3.Connection]:
        with self._write_lock:
            conn = self._connect()
            try:
                yield conn
            finally:
                conn.close()

    def _init_schema(self) -> None:
        with self._tx() as conn:
            # Use DELETE journal mode once at init (avoids WAL -shm mmap `disk I/O error` on overlayfs/CephFS)
            conn.execute("PRAGMA journal_mode=DELETE")
            conn.executescript(SCHEMA_SQL)
            self._ensure_columns(
                conn,
                "targets",
                {
                    "source_input_id": "INTEGER",
                    "source_model": "TEXT NOT NULL DEFAULT ''",
                    "source_origin": "TEXT NOT NULL DEFAULT 'bench'",
                    "task": "TEXT NOT NULL DEFAULT ''",
                    "subtask": "TEXT NOT NULL DEFAULT ''",
                    "request_time": "TEXT NOT NULL DEFAULT ''",
                },
            )
            self._ensure_columns(
                conn,
                "side_cases",
                {
                    "linked_input_id": "INTEGER",
                    "linked_output_id": "INTEGER",
                },
            )

    @staticmethod
    def _ensure_columns(conn: sqlite3.Connection, table: str, columns: dict[str, str]) -> None:
        existing = {
            str(r["name"])
            for r in conn.execute(f"PRAGMA table_info({table})").fetchall()
        }
        for col, ddl in columns.items():
            if col not in existing:
                conn.execute(f"ALTER TABLE {table} ADD COLUMN {col} {ddl}")

    def _next_seq(self, conn: sqlite3.Connection, run_id: str) -> int:
        conn.execute(
            "INSERT INTO run_seq(run_id, latest_seq) VALUES (?, 1) "
            "ON CONFLICT(run_id) DO UPDATE SET latest_seq = latest_seq + 1",
            (run_id,),
        )
        row = conn.execute("SELECT latest_seq FROM run_seq WHERE run_id = ?", (run_id,)).fetchone()
        return int(row["latest_seq"])

    # ---- Run CRUD -----------------------------------------------------------

    def create_run(self, spec: dict[str, Any]) -> dict[str, Any]:
        now = utc_rfc3339()
        sides = list(spec["sides"])
        collector_status = {side: "pending" for side in sides}
        with self._tx() as conn:
            conn.execute(
                """
                INSERT INTO runs (
                    run_id, idempotency_key, version, round_order, round_dir_name, round_dir_path,
                    model, tier, requested_count, actual_count, sides_json, before_mode,
                    before_agent_json, after_agent_json, before_agent_label, after_agent_label,
                    status, stage, callback_url, side_collector_status_json,
                    created_at, updated_at, meta_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    spec["run_id"],
                    spec.get("idempotency_key") or None,
                    spec["version"],
                    int(spec["round_order"]),
                    spec["round_dir_name"],
                    str(spec["round_dir_path"]),
                    spec["model"],
                    int(spec["tier"]),
                    int(spec["requested_count"]),
                    int(spec.get("actual_count", 0)),
                    _jdumps(sides),
                    spec.get("before_mode", "live"),
                    _jdumps(spec["before_agent"]),
                    _jdumps(spec["after_agent"]),
                    spec["before_agent_label"],
                    spec["after_agent_label"],
                    "queued",
                    "queued",
                    spec.get("callback_url") or None,
                    _jdumps(collector_status),
                    now,
                    now,
                    _jdumps(spec.get("meta") or {}),
                ),
            )
            conn.execute("INSERT OR IGNORE INTO run_seq(run_id, latest_seq) VALUES (?, 0)", (spec["run_id"],))
            conn.execute(
                """
                INSERT INTO events(run_id, level, stage, side, event_type, message, details_json, created_at)
                VALUES (?, 'info', 'queued', NULL, 'run_created', ?, ?, ?)
                """,
                (
                    spec["run_id"],
                    f"创建内部评测任务 {spec['run_id']}（version={spec['version']}, model={spec['model']}, tier={spec['tier']}）",
                    _jdumps({"sides": sides, "before_mode": spec.get("before_mode", "live")}),
                    now,
                ),
            )
        return self.get_run(spec["run_id"])  # type: ignore[return-value]

    def get_run_by_idempotency_key(self, key: str) -> dict[str, Any] | None:
        if not key:
            return None
        with self._read() as conn:
            row = conn.execute("SELECT * FROM runs WHERE idempotency_key = ?", (key,)).fetchone()
        return self._row_to_run(row) if row else None

    def get_run(self, run_id: str) -> dict[str, Any] | None:
        with self._read() as conn:
            row = conn.execute("SELECT * FROM runs WHERE run_id = ?", (run_id,)).fetchone()
        return self._row_to_run(row) if row else None

    def list_runs(
        self,
        *,
        version: str | None = None,
        model: str | None = None,
        status: str | None = None,
        agent: str | None = None,
        limit: int = 50,
        offset: int = 0,
    ) -> tuple[list[dict[str, Any]], int]:
        where: list[str] = []
        args: list[Any] = []
        if version:
            where.append("version = ?")
            args.append(version)
        if model:
            where.append("model = ?")
            args.append(model)
        if status:
            where.append("status = ?")
            args.append(status)
        if agent:
            where.append("(before_agent_label LIKE ? OR after_agent_label LIKE ?)")
            pattern = f"%{agent}%"
            args.extend([pattern, pattern])

        clause = ("WHERE " + " AND ".join(where)) if where else ""
        with self._read() as conn:
            total = int(conn.execute(f"SELECT COUNT(*) FROM runs {clause}", args).fetchone()[0])
            rows = conn.execute(
                f"SELECT * FROM runs {clause} ORDER BY created_at DESC LIMIT ? OFFSET ?",
                [*args, limit, offset],
            ).fetchall()
        return [self._row_to_run(r) for r in rows], total

    def list_runs_by_statuses(self, statuses: tuple[str, ...]) -> list[dict[str, Any]]:
        if not statuses:
            return []
        marks = ",".join("?" for _ in statuses)
        with self._read() as conn:
            rows = conn.execute(
                f"SELECT * FROM runs WHERE status IN ({marks}) ORDER BY created_at ASC",
                list(statuses),
            ).fetchall()
        return [self._row_to_run(r) for r in rows]

    def next_queued_run(self) -> dict[str, Any] | None:
        with self._read() as conn:
            row = conn.execute(
                "SELECT * FROM runs WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1"
            ).fetchone()
        return self._row_to_run(row) if row else None

    def update_run(self, run_id: str, **fields: Any) -> None:
        if not fields:
            return
        json_map = {
            "dispatch_files": "dispatch_files_json",
            "upstream_jobs": "upstream_jobs_json",
            "side_collector_status": "side_collector_status_json",
            "meta": "meta_json",
        }
        cols: list[str] = []
        vals: list[Any] = []
        for k, v in fields.items():
            if k in json_map:
                cols.append(f"{json_map[k]} = ?")
                vals.append(_jdumps(v))
            else:
                cols.append(f"{k} = ?")
                vals.append(v)
        cols.append("updated_at = ?")
        vals.append(utc_rfc3339())
        vals.append(run_id)
        with self._tx() as conn:
            conn.execute(f"UPDATE runs SET {', '.join(cols)} WHERE run_id = ?", vals)

    def increment_run_cluster_stats(
        self,
        run_id: str,
        *,
        batches: int = 1,
        created_components: int = 0,
        created_leaves: int = 0,
    ) -> None:
        now = utc_rfc3339()
        with self._tx() as conn:
            conn.execute(
                """
                UPDATE runs
                SET cluster_batches_completed = cluster_batches_completed + ?,
                    taxonomy_created_components = taxonomy_created_components + ?,
                    taxonomy_created_leaves = taxonomy_created_leaves + ?,
                    last_cluster_at = ?,
                    updated_at = ?
                WHERE run_id = ?
                """,
                (batches, created_components, created_leaves, now, now, run_id),
            )

    def set_side_collector_status(
        self,
        run_id: str,
        side: str,
        status: str,
        *,
        upstream_job_id: str | None = None,
    ) -> None:
        with self._tx() as conn:
            row = conn.execute(
                "SELECT side_collector_status_json, upstream_jobs_json FROM runs WHERE run_id = ?",
                (run_id,),
            ).fetchone()
            if not row:
                return
            cs = _jloads(row["side_collector_status_json"], {})
            cs[side] = status
            uj = _jloads(row["upstream_jobs_json"], {})
            if upstream_job_id is not None:
                uj[side] = upstream_job_id
            now = utc_rfc3339()
            conn.execute(
                "UPDATE runs SET side_collector_status_json = ?, upstream_jobs_json = ?, updated_at = ? WHERE run_id = ?",
                (_jdumps(cs), _jdumps(uj), now, run_id),
            )

    def request_cancel(self, run_id: str) -> dict[str, Any] | None:
        now = utc_rfc3339()
        with self._tx() as conn:
            row = conn.execute("SELECT status FROM runs WHERE run_id = ?", (run_id,)).fetchone()
            if not row:
                return None
            cur = row["status"]
            if cur == "queued":
                conn.execute(
                    "UPDATE runs SET cancel_requested = 1, status = 'cancelled', stage = 'cancelled', finished_at = ?, updated_at = ? WHERE run_id = ?",
                    (now, now, run_id),
                )
            elif cur not in TERMINAL_RUN_STATUSES:
                conn.execute(
                    "UPDATE runs SET cancel_requested = 1, status = 'cancelling', updated_at = ? WHERE run_id = ?",
                    (now, run_id),
                )
            conn.execute(
                "INSERT INTO events(run_id, level, stage, side, event_type, message, details_json, created_at) VALUES (?, 'warn', 'cancel', NULL, 'cancel_requested', '收到取消任务信号，将保留已完成结果并安全中止', '{}', ?)",
                (run_id, now),
            )
        return self.get_run(run_id)

    def is_cancel_requested(self, run_id: str) -> bool:
        with self._read() as conn:
            row = conn.execute("SELECT cancel_requested FROM runs WHERE run_id = ?", (run_id,)).fetchone()
        return bool(row and row["cancel_requested"])

    # ---- Targets & Side Cases ----------------------------------------------

    def save_targets(self, run_id: str, targets: list[dict[str, Any]], sides: list[str]) -> None:
        now = utc_rfc3339()
        with self._tx() as conn:
            conn.executemany(
                """
                INSERT OR REPLACE INTO targets (
                    run_id, case_key, eq_index, source_input_id, source_trace_id, source_session_id,
                    source_model, source_origin, question, task, subtask, request_time,
                    turn, session_round, bench_rank, bench_severity, bench_primary_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                [
                    (
                        run_id,
                        t["case_key"],
                        int(t["eq_index"]),
                        int(t["source_input_id"]) if t.get("source_input_id") is not None else None,
                        str(t.get("source_trace_id") or ""),
                        str(t.get("source_session_id") or ""),
                        str(t.get("source_model") or t.get("model") or ""),
                        str(t.get("source_origin") or "bench"),
                        str(t.get("question") or ""),
                        str(t.get("task") or ""),
                        str(t.get("subtask") or ""),
                        str(t.get("request_time") or ""),
                        str(t.get("turn") or "single"),
                        int(t.get("session_round") or 1),
                        int(t.get("bench_rank") or 0),
                        str(t.get("bench_severity") or ""),
                        _jdumps(t.get("bench_primary") or {}),
                    )
                    for t in targets
                ],
            )
            side_rows = []
            for side in sides:
                for t in targets:
                    side_rows.append((run_id, side, t["case_key"], int(t["eq_index"]), "pending_fetch", now))
            conn.executemany(
                """
                INSERT OR IGNORE INTO side_cases (
                    run_id, side, case_key, eq_index, status, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?)
                """,
                side_rows,
            )
            conn.execute(
                "UPDATE runs SET actual_count = ?, updated_at = ? WHERE run_id = ?",
                (len(targets), now, run_id),
            )

    def get_targets(self, run_id: str) -> list[dict[str, Any]]:
        with self._read() as conn:
            rows = conn.execute(
                "SELECT * FROM targets WHERE run_id = ? ORDER BY eq_index ASC", (run_id,)
            ).fetchall()
        return [
            {
                "case_key": r["case_key"],
                "eq_index": r["eq_index"],
                "source_input_id": r["source_input_id"],
                "source_trace_id": r["source_trace_id"],
                "source_session_id": r["source_session_id"],
                "source_model": r["source_model"] or "",
                "source_origin": r["source_origin"] or "bench",
                "question": r["question"],
                "task": r["task"] or "",
                "subtask": r["subtask"] or "",
                "request_time": r["request_time"] or "",
                "turn": r["turn"],
                "session_round": r["session_round"],
                "bench_rank": r["bench_rank"],
                "bench_severity": r["bench_severity"],
                "bench_primary": _jloads(r["bench_primary_json"], {}),
            }
            for r in rows
        ]

    def get_target_map(self, run_id: str) -> dict[str, dict[str, Any]]:
        return {t["case_key"]: t for t in self.get_targets(run_id)}

    def get_side_case(self, run_id: str, side: str, case_key: str) -> dict[str, Any] | None:
        with self._read() as conn:
            row = conn.execute(
                "SELECT * FROM side_cases WHERE run_id = ? AND side = ? AND case_key = ?",
                (run_id, side, case_key),
            ).fetchone()
        return self._row_to_side_case(row) if row else None

    def get_side_cases(
        self,
        run_id: str,
        side: str | None = None,
        statuses: tuple[str, ...] | None = None,
    ) -> list[dict[str, Any]]:
        where = ["run_id = ?"]
        args: list[Any] = [run_id]
        if side:
            where.append("side = ?")
            args.append(side)
        if statuses:
            marks = ",".join("?" for _ in statuses)
            where.append(f"status IN ({marks})")
            args.extend(statuses)
        with self._read() as conn:
            rows = conn.execute(
                f"SELECT * FROM side_cases WHERE {' AND '.join(where)} ORDER BY eq_index ASC, side ASC",
                args,
            ).fetchall()
        return [self._row_to_side_case(r) for r in rows]

    def mark_fetched(
        self,
        run_id: str,
        side: str,
        case_key: str,
        *,
        trace_id: str,
        session_id: str = "",
        request_time: str = "",
        raw_file: str = "",
    ) -> bool:
        """Record an ingested raw trace. Returns True if newly accepted (idempotent on duplicates)."""
        now = utc_rfc3339()
        with self._tx() as conn:
            row = conn.execute(
                "SELECT status FROM side_cases WHERE run_id = ? AND side = ? AND case_key = ?",
                (run_id, side, case_key),
            ).fetchone()
            if not row:
                return False
            if row["status"] not in ("pending_fetch", "failed"):
                return False
            conn.execute(
                """
                UPDATE side_cases
                SET status = 'fetched',
                    failed_stage = NULL,
                    error_code = NULL,
                    error_message = NULL,
                    trace_id = ?,
                    session_id = ?,
                    request_time = ?,
                    raw_file = ?,
                    fetched_at = ?,
                    updated_at = ?
                WHERE run_id = ? AND side = ? AND case_key = ?
                """,
                (trace_id, session_id, request_time, raw_file, now, now, run_id, side, case_key),
            )
            conn.execute(
                "UPDATE runs SET last_ingest_at = ?, updated_at = ? WHERE run_id = ?",
                (now, now, run_id),
            )
            return True

    def mark_prepared(self, run_id: str, side: str, case_key: str, *, prepared_file: str) -> None:
        now = utc_rfc3339()
        with self._tx() as conn:
            conn.execute(
                """
                UPDATE side_cases
                SET status = 'prepared',
                    prepared_file = ?,
                    prepared_at = ?,
                    updated_at = ?
                WHERE run_id = ? AND side = ? AND case_key = ?
                  AND status IN ('fetched', 'preparing', 'failed')
                """,
                (prepared_file, now, now, run_id, side, case_key),
            )

    def mark_evaluating(self, run_id: str, side: str, case_keys: list[str]) -> None:
        if not case_keys:
            return
        now = utc_rfc3339()
        with self._tx() as conn:
            conn.executemany(
                """
                UPDATE side_cases
                SET status = 'evaluating', updated_at = ?
                WHERE run_id = ? AND side = ? AND case_key = ?
                  AND status IN ('prepared', 'fetched')
                """,
                [(now, run_id, side, ck) for ck in case_keys],
            )

    def mark_evaluated(
        self,
        run_id: str,
        side: str,
        case_key: str,
        *,
        trace_id: str,
        session_id: str,
        attribution_file: str,
        problems: list[dict[str, Any]],
        attribution_summary: str = "",
        is_correct: bool | None = None,
    ) -> bool:
        """Record evaluation output for one trace.
        If 0 problems (GOLD), marks immediately as `ready` with a fresh change_seq!
        Returns True if the trace became `ready` immediately (GOLD).
        """
        now = utc_rfc3339()
        is_gold, max_sev, sev_counts = compute_severity_stats(problems)
        normalized_problems = []
        for idx, prob in enumerate(problems):
            normalized_problems.append(
                {
                    "problem_index": idx,
                    "label": str(prob.get("label") or ""),
                    "definition": str(prob.get("definition") or ""),
                    "reason": str(prob.get("reason") or ""),
                    "evidence": prob.get("evidence") or "",
                    "severity": str(prob.get("severity") or ""),
                    "component": str(prob.get("component") or ""),
                    "component_role": str(prob.get("component_role") or ""),
                    "cluster_path": None,
                    "cluster_name": None,
                    "l1": None,
                    "l2": None,
                    "l3": None,
                    "l4": None,
                    "pending_leaf": False,
                }
            )
        is_correct_val = None if is_correct is None else (1 if is_correct else 0)
        with self._tx() as conn:
            if is_gold:
                seq = self._next_seq(conn, run_id)
                conn.execute(
                    """
                    UPDATE side_cases
                    SET status = 'ready',
                        failed_stage = NULL,
                        error_code = NULL,
                        error_message = NULL,
                        trace_id = COALESCE(NULLIF(?, ''), trace_id),
                        session_id = COALESCE(NULLIF(?, ''), session_id),
                        attribution_file = ?,
                        is_gold = 1,
                        problem_count = 0,
                        max_severity = 'GOLD',
                        severity_counts_json = ?,
                        problems_json = '[]',
                        cluster_paths_json = '[]',
                        cluster_labels_json = '[]',
                        attribution_summary = ?,
                        is_correct = ?,
                        evaluated_at = COALESCE(evaluated_at, ?),
                        ready_at = COALESCE(ready_at, ?),
                        change_seq = ?,
                        updated_at = ?
                    WHERE run_id = ? AND side = ? AND case_key = ?
                    """,
                    (
                        trace_id,
                        session_id,
                        attribution_file,
                        _jdumps(sev_counts),
                        attribution_summary,
                        is_correct_val,
                        now,
                        now,
                        seq,
                        now,
                        run_id,
                        side,
                        case_key,
                    ),
                )
                conn.execute(
                    "UPDATE runs SET first_ready_at = COALESCE(first_ready_at, ?), updated_at = ? WHERE run_id = ?",
                    (now, now, run_id),
                )
                return True

            conn.execute(
                """
                UPDATE side_cases
                SET status = 'evaluated',
                    failed_stage = NULL,
                    error_code = NULL,
                    error_message = NULL,
                    trace_id = COALESCE(NULLIF(?, ''), trace_id),
                    session_id = COALESCE(NULLIF(?, ''), session_id),
                    attribution_file = ?,
                    is_gold = 0,
                    problem_count = ?,
                    max_severity = ?,
                    severity_counts_json = ?,
                    problems_json = ?,
                    attribution_summary = ?,
                    is_correct = ?,
                    evaluated_at = COALESCE(evaluated_at, ?),
                    updated_at = ?
                WHERE run_id = ? AND side = ? AND case_key = ?
                """,
                (
                    trace_id,
                    session_id,
                    attribution_file,
                    len(normalized_problems),
                    max_sev,
                    _jdumps(sev_counts),
                    _jdumps(normalized_problems),
                    attribution_summary,
                    is_correct_val,
                    now,
                    now,
                    run_id,
                    side,
                    case_key,
                ),
            )
            return False

    def mark_clustered_ready(
        self,
        run_id: str,
        side: str,
        case_key: str,
        assignments_by_pidx: dict[int, dict[str, Any]],
        leaf_names: dict[str, str],
    ) -> bool:
        """Attach cluster leaf paths to an evaluated trace and mark it `ready` with a fresh change_seq.
        Returns True if the record was newly marked ready or its cluster paths changed.
        """
        now = utc_rfc3339()
        with self._tx() as conn:
            row = conn.execute(
                "SELECT status, problems_json, cluster_paths_json FROM side_cases WHERE run_id = ? AND side = ? AND case_key = ?",
                (run_id, side, case_key),
            ).fetchone()
            if not row:
                return False
            problems = _jloads(row["problems_json"], [])
            old_paths = _jloads(row["cluster_paths_json"], [])
            new_paths: list[str] = []
            new_labels: list[str] = []
            for idx, prob in enumerate(problems):
                hit = assignments_by_pidx.get(idx)
                if hit and hit.get("path"):
                    path = str(hit["path"])
                    parts = path.split(".")
                    prob["cluster_path"] = path
                    prob["cluster_name"] = hit.get("name") or leaf_names.get(path) or path
                    prob["l1"] = parts[0] if len(parts) >= 1 else None
                    prob["l2"] = ".".join(parts[:2]) if len(parts) >= 2 else None
                    prob["l3"] = ".".join(parts[:3]) if len(parts) >= 3 else None
                    prob["l4"] = path if len(parts) >= 4 else None
                    prob["pending_leaf"] = False
                    if path not in new_paths:
                        new_paths.append(path)
                else:
                    prob["pending_leaf"] = True
                lbl = prob.get("label") or ""
                if lbl:
                    new_labels.append(lbl)

            changed = row["status"] != "ready" or new_paths != old_paths
            if not changed:
                return False

            seq = self._next_seq(conn, run_id)
            conn.execute(
                """
                UPDATE side_cases
                SET status = 'ready',
                    problems_json = ?,
                    cluster_paths_json = ?,
                    cluster_labels_json = ?,
                    clustered_at = ?,
                    ready_at = COALESCE(ready_at, ?),
                    change_seq = ?,
                    updated_at = ?
                WHERE run_id = ? AND side = ? AND case_key = ?
                """,
                (
                    _jdumps(problems),
                    _jdumps(new_paths),
                    _jdumps(new_labels),
                    now,
                    now,
                    seq,
                    now,
                    run_id,
                    side,
                    case_key,
                ),
            )
            conn.execute(
                "UPDATE runs SET first_ready_at = COALESCE(first_ready_at, ?), updated_at = ? WHERE run_id = ?",
                (now, now, run_id),
            )
            return True

    def save_historical_cases_bulk(
        self,
        run_id: str,
        side: str,
        cases: list[dict[str, Any]],
    ) -> int:
        """Atomically populate cloned historical baseline cases (already evaluated & clustered) as `ready`."""
        if not cases:
            return 0
        now = utc_rfc3339()
        updated = 0
        with self._tx() as conn:
            for item in cases:
                ck = str(item["case_key"])
                raw_problems = list(item.get("problems") or [])
                is_gold, max_sev, sev_counts = compute_severity_stats(raw_problems)
                if item.get("max_severity") in ("GOLD", "P0", "P1", "P2", "P3", "P4") and not raw_problems:
                    max_sev = str(item["max_severity"])
                    is_gold = max_sev == "GOLD"
                norm_probs: list[dict[str, Any]] = []
                paths: list[str] = []
                labels: list[str] = []
                for idx, prob in enumerate(raw_problems):
                    cpath = str(prob.get("cluster_path") or "").strip() or None
                    cname = str(prob.get("cluster_name") or cpath or "").strip() or None
                    parts = cpath.split(".") if cpath else []
                    norm_probs.append(
                        {
                            "scope": str(prob.get("scope") or "turn"),
                            "turn_index": int(prob.get("turn_index") or 0),
                            "problem_index": int(prob.get("problem_index") if prob.get("problem_index") is not None else idx),
                            "label": str(prob.get("label") or ""),
                            "definition": str(prob.get("definition") or ""),
                            "reason": str(prob.get("reason") or ""),
                            "evidence": prob.get("evidence") or "",
                            "severity": str(prob.get("severity") or ""),
                            "component": str(prob.get("component") or ""),
                            "component_role": str(prob.get("component_role") or ""),
                            "cluster_path": cpath,
                            "cluster_name": cname,
                            "l1": parts[0] if len(parts) >= 1 else None,
                            "l2": ".".join(parts[:2]) if len(parts) >= 2 else None,
                            "l3": ".".join(parts[:3]) if len(parts) >= 3 else None,
                            "l4": cpath if len(parts) >= 4 else None,
                            "is_edge": bool(prob.get("is_edge", False)),
                            "pending_leaf": cpath is None,
                        }
                    )
                    if cpath and cpath not in paths:
                        paths.append(cpath)
                    if prob.get("label"):
                        labels.append(str(prob["label"]))

                seq = self._next_seq(conn, run_id)
                is_correct_raw = item.get("is_correct")
                is_correct_val = None if is_correct_raw is None else (1 if is_correct_raw else 0)
                conn.execute(
                    """
                    UPDATE side_cases
                    SET status = 'ready',
                        failed_stage = NULL,
                        error_code = NULL,
                        error_message = NULL,
                        linked_input_id = ?,
                        linked_output_id = ?,
                        trace_id = ?,
                        session_id = ?,
                        request_time = ?,
                        raw_file = ?,
                        prepared_file = ?,
                        attribution_file = ?,
                        is_gold = ?,
                        problem_count = ?,
                        max_severity = ?,
                        severity_counts_json = ?,
                        problems_json = ?,
                        cluster_paths_json = ?,
                        cluster_labels_json = ?,
                        attribution_summary = ?,
                        is_correct = ?,
                        fetched_at = COALESCE(fetched_at, ?),
                        prepared_at = COALESCE(prepared_at, ?),
                        evaluated_at = COALESCE(evaluated_at, ?),
                        clustered_at = COALESCE(clustered_at, ?),
                        ready_at = COALESCE(ready_at, ?),
                        change_seq = ?,
                        updated_at = ?
                    WHERE run_id = ? AND side = ? AND case_key = ?
                    """,
                    (
                        int(item["linked_input_id"]) if item.get("linked_input_id") is not None else None,
                        int(item["linked_output_id"]) if item.get("linked_output_id") is not None else None,
                        str(item.get("trace_id") or ""),
                        str(item.get("session_id") or ""),
                        str(item.get("request_time") or ""),
                        str(item.get("source_tag") or "historical_pg"),
                        str(item.get("source_tag") or "historical_pg"),
                        str(item.get("source_tag") or "historical_pg"),
                        1 if is_gold else 0,
                        len(norm_probs),
                        max_sev,
                        _jdumps(sev_counts),
                        _jdumps(norm_probs),
                        _jdumps(paths),
                        _jdumps(labels),
                        str(item.get("attribution_summary") or ""),
                        is_correct_val,
                        now,
                        now,
                        now,
                        now,
                        now,
                        seq,
                        now,
                        run_id,
                        side,
                        ck,
                    ),
                )
                updated += 1
            if updated > 0:
                conn.execute(
                    "UPDATE runs SET first_ready_at = COALESCE(first_ready_at, ?), updated_at = ? WHERE run_id = ?",
                    (now, now, run_id),
                )
        return updated

    def mark_case_failed(
        self,
        run_id: str,
        side: str,
        case_key: str | None,
        *,
        stage: str,
        error_code: str,
        error_message: str,
        trace_id: str | None = None,
        rejected: bool = False,
        details: dict[str, Any] | None = None,
    ) -> None:
        now = utc_rfc3339()
        target_status = "rejected" if rejected else "failed"
        with self._tx() as conn:
            retry_count = 0
            if case_key:
                row = conn.execute(
                    "SELECT retry_count FROM side_cases WHERE run_id = ? AND side = ? AND case_key = ?",
                    (run_id, side, case_key),
                ).fetchone()
                if row:
                    retry_count = int(row["retry_count"])
                conn.execute(
                    """
                    UPDATE side_cases
                    SET status = ?,
                        failed_stage = ?,
                        error_code = ?,
                        error_message = ?,
                        trace_id = COALESCE(NULLIF(?, ''), trace_id),
                        updated_at = ?
                    WHERE run_id = ? AND side = ? AND case_key = ?
                    """,
                    (
                        target_status,
                        stage,
                        error_code,
                        error_message[:2000],
                        trace_id or "",
                        now,
                        run_id,
                        side,
                        case_key,
                    ),
                )
            conn.execute(
                """
                INSERT INTO failures (
                    run_id, side, case_key, trace_id, stage, error_code,
                    error_message, retry_count, resolved, details_json, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
                """,
                (
                    run_id,
                    side,
                    case_key,
                    trace_id,
                    stage,
                    error_code,
                    error_message[:2000],
                    retry_count,
                    _jdumps(details or {}),
                    now,
                ),
            )

    def reset_failed_cases_for_retry(
        self,
        run_id: str,
        *,
        stages: list[str] | None = None,
        sides: list[str] | None = None,
    ) -> dict[str, Any]:
        """Reset failed/rejected side_cases back to the appropriate retry status and re-queue the run."""
        now = utc_rfc3339()
        reset_counts = {"fetch": 0, "prepare": 0, "eval": 0, "cluster": 0}
        with self._tx() as conn:
            where = ["run_id = ?", "status IN ('failed', 'rejected')"]
            args: list[Any] = [run_id]
            if stages:
                marks = ",".join("?" for _ in stages)
                where.append(f"failed_stage IN ({marks})")
                args.extend(stages)
            if sides:
                marks = ",".join("?" for _ in sides)
                where.append(f"side IN ({marks})")
                args.extend(sides)
            rows = conn.execute(
                f"SELECT side, case_key, failed_stage, raw_file, prepared_file, attribution_file FROM side_cases WHERE {' AND '.join(where)}",
                args,
            ).fetchall()
            for r in rows:
                fstage = r["failed_stage"] or "fetch"
                if fstage == "cluster" and r["attribution_file"]:
                    new_status = "evaluated"
                elif fstage == "eval" and r["prepared_file"]:
                    new_status = "prepared"
                elif fstage == "prepare" and r["raw_file"]:
                    new_status = "fetched"
                else:
                    new_status = "pending_fetch"
                reset_counts[fstage if fstage in reset_counts else "fetch"] += 1
                conn.execute(
                    """
                    UPDATE side_cases
                    SET status = ?,
                        failed_stage = NULL,
                        error_code = NULL,
                        error_message = NULL,
                        retry_count = retry_count + 1,
                        updated_at = ?
                    WHERE run_id = ? AND side = ? AND case_key = ?
                    """,
                    (new_status, now, run_id, r["side"], r["case_key"]),
                )
            total_reset = sum(reset_counts.values())
            if total_reset > 0:
                conn.execute("UPDATE failures SET resolved = 1 WHERE run_id = ? AND resolved = 0", (run_id,))
                # Reset collector statuses for sides needing fetch retry
                run_row = conn.execute("SELECT side_collector_status_json FROM runs WHERE run_id = ?", (run_id,)).fetchone()
                cs = _jloads(run_row["side_collector_status_json"], {}) if run_row else {}
                for side_name in list(cs):
                    need_fetch = conn.execute(
                        "SELECT 1 FROM side_cases WHERE run_id = ? AND side = ? AND status = 'pending_fetch' LIMIT 1",
                        (run_id, side_name),
                    ).fetchone()
                    if need_fetch:
                        cs[side_name] = "pending"
                conn.execute(
                    """
                    UPDATE runs
                    SET status = 'queued',
                        stage = 'retry_queued',
                        cancel_requested = 0,
                        error_code = NULL,
                        error_message = NULL,
                        finished_at = NULL,
                        side_collector_status_json = ?,
                        updated_at = ?
                    WHERE run_id = ?
                    """,
                    (_jdumps(cs), now, run_id),
                )
                conn.execute(
                    "INSERT INTO events(run_id, level, stage, side, event_type, message, details_json, created_at) VALUES (?, 'info', 'retry', NULL, 'retry_failed_requested', ?, ?, ?)",
                    (run_id, f"已重置 {total_reset} 条失败样本并重新入队", _jdumps(reset_counts), now),
                )
        return {"reset_total": sum(reset_counts.values()), "by_stage": reset_counts}

    def enable_after_side(
        self,
        run_id: str,
        *,
        after_agent: dict[str, Any] | None = None,
        after_agent_label: str | None = None,
        task_manager: dict[str, Any] | None = None,
        label: str | None = None,
        title: str | None = None,
    ) -> dict[str, Any]:
        """Add/activate the `after` side on an existing baseline-prepared run and re-queue it."""
        now = utc_rfc3339()
        with self._tx() as conn:
            row = conn.execute("SELECT * FROM runs WHERE run_id = ?", (run_id,)).fetchone()
            if not row:
                raise KeyError(run_id)
            sides = _jloads(row["sides_json"], [])
            if "after" not in sides:
                sides.append("after")
            cs = _jloads(row["side_collector_status_json"], {})
            cs["after"] = "pending"
            meta = _jloads(row["meta_json"], {})
            if isinstance(task_manager, dict) and task_manager:
                old_tm = dict(meta.get("task_manager") or {}) if isinstance(meta.get("task_manager"), dict) else {}
                old_tm.update(task_manager)
                meta["task_manager"] = old_tm
            if label:
                meta["label"] = label
            if title:
                meta["title"] = title

            new_after_agent = _jdumps(after_agent) if after_agent is not None else row["after_agent_json"]
            new_after_label = after_agent_label if after_agent_label else row["after_agent_label"]

            targets = conn.execute(
                "SELECT case_key, eq_index FROM targets WHERE run_id = ? ORDER BY eq_index ASC",
                (run_id,),
            ).fetchall()
            if not targets:
                raise RuntimeError(f"任务 {run_id} 尚未生成目标题单，无法触发 after")

            existing_after = conn.execute(
                "SELECT COUNT(*) FROM side_cases WHERE run_id = ? AND side = 'after' AND status = 'ready'",
                (run_id,),
            ).fetchone()[0]
            if int(existing_after or 0) > 0:
                raise RuntimeError(f"任务 {run_id} 的 after 侧已有 {existing_after} 条 ready 结果，请改用 /retry-failed 补跑")

            conn.execute("DELETE FROM side_cases WHERE run_id = ? AND side = 'after'", (run_id,))
            conn.executemany(
                """
                INSERT INTO side_cases (run_id, side, case_key, eq_index, status, updated_at)
                VALUES (?, 'after', ?, ?, 'pending_fetch', ?)
                """,
                [(run_id, r["case_key"], int(r["eq_index"]), now) for r in targets],
            )
            conn.execute(
                """
                UPDATE runs
                SET sides_json = ?,
                    after_agent_json = ?,
                    after_agent_label = ?,
                    side_collector_status_json = ?,
                    meta_json = ?,
                    status = 'queued',
                    stage = 'after_queued',
                    cancel_requested = 0,
                    error_code = NULL,
                    error_message = NULL,
                    finished_at = NULL,
                    updated_at = ?
                WHERE run_id = ?
                """,
                (
                    _jdumps(sides),
                    new_after_agent,
                    new_after_label,
                    _jdumps(cs),
                    _jdumps(meta),
                    now,
                    run_id,
                ),
            )
            conn.execute(
                """
                INSERT INTO events(run_id, level, stage, side, event_type, message, details_json, created_at)
                VALUES (?, 'info', 'queued', 'after', 'after_side_triggered', ?, ?, ?)
                """,
                (
                    run_id,
                    f"已触发 Candidate 2（{new_after_label}）推理与评测，共 {len(targets)} 题重新入队",
                    _jdumps({"after_agent_label": new_after_label, "target_count": len(targets)}),
                    now,
                ),
            )
        return self.get_run(run_id)  # type: ignore[return-value]

    # ---- Events & Failures Queries -----------------------------------------

    def add_event(
        self,
        run_id: str,
        stage: str,
        event_type: str,
        message: str,
        *,
        level: str = "info",
        side: str | None = None,
        details: dict[str, Any] | None = None,
    ) -> None:
        with self._tx() as conn:
            conn.execute(
                """
                INSERT INTO events(run_id, level, stage, side, event_type, message, details_json, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (run_id, level, stage, side, event_type, message, _jdumps(details or {}), utc_rfc3339()),
            )

    def list_events(self, run_id: str, *, limit: int = 100, offset: int = 0) -> tuple[list[dict[str, Any]], int]:
        with self._read() as conn:
            total = int(conn.execute("SELECT COUNT(*) FROM events WHERE run_id = ?", (run_id,)).fetchone()[0])
            rows = conn.execute(
                "SELECT * FROM events WHERE run_id = ? ORDER BY id DESC LIMIT ? OFFSET ?",
                (run_id, limit, offset),
            ).fetchall()
        items = [
            {
                "id": r["id"],
                "level": r["level"],
                "stage": r["stage"],
                "side": r["side"],
                "event_type": r["event_type"],
                "message": r["message"],
                "details": _jloads(r["details_json"], {}),
                "created_at": r["created_at"],
            }
            for r in rows
        ]
        return items, total

    def list_failures(
        self,
        run_id: str,
        *,
        stage: str | None = None,
        side: str | None = None,
        unresolved_only: bool = True,
        limit: int = 100,
        offset: int = 0,
    ) -> dict[str, Any]:
        where = ["f.run_id = ?"]
        args: list[Any] = [run_id]
        if stage:
            where.append("f.stage = ?")
            args.append(stage)
        if side:
            where.append("f.side = ?")
            args.append(side)
        if unresolved_only:
            where.append("f.resolved = 0")
        clause = " AND ".join(where)
        with self._read() as conn:
            total = int(conn.execute(f"SELECT COUNT(*) FROM failures f WHERE {clause}", args).fetchone()[0])
            by_stage_rows = conn.execute(
                f"SELECT f.stage, f.side, COUNT(*) AS cnt FROM failures f WHERE {clause} GROUP BY f.stage, f.side",
                args,
            ).fetchall()
            rows = conn.execute(
                f"""
                SELECT f.*, t.question AS target_question
                FROM failures f
                LEFT JOIN targets t ON t.run_id = f.run_id AND t.case_key = f.case_key
                WHERE {clause}
                ORDER BY f.id DESC
                LIMIT ? OFFSET ?
                """,
                [*args, limit, offset],
            ).fetchall()

        summary_by_stage: dict[str, int] = {}
        summary_by_side: dict[str, int] = {}
        for br in by_stage_rows:
            summary_by_stage[br["stage"]] = summary_by_stage.get(br["stage"], 0) + int(br["cnt"])
            summary_by_side[br["side"]] = summary_by_side.get(br["side"], 0) + int(br["cnt"])

        items = [
            {
                "id": r["id"],
                "side": r["side"],
                "case_key": r["case_key"],
                "trace_id": r["trace_id"],
                "question": r["target_question"] or "",
                "stage": r["stage"],
                "error_code": r["error_code"],
                "error_message": r["error_message"],
                "retry_count": r["retry_count"],
                "resolved": bool(r["resolved"]),
                "details": _jloads(r["details_json"], {}),
                "created_at": r["created_at"],
            }
            for r in rows
        ]
        return {
            "total": total,
            "by_stage": summary_by_stage,
            "by_side": summary_by_side,
            "items": items,
        }

    # ---- Progress Funnel & Visualization Summary ---------------------------

    def get_run_progress(self, run_id: str) -> dict[str, Any] | None:
        run = self.get_run(run_id)
        if not run:
            return None

        sides = run["sides"]
        with self._read() as conn:
            seq_row = conn.execute("SELECT latest_seq FROM run_seq WHERE run_id = ?", (run_id,)).fetchone()
            latest_seq = int(seq_row["latest_seq"]) if seq_row else 0
            case_rows = conn.execute(
                """
                SELECT side, status, failed_stage, is_gold, max_severity, problem_count
                FROM side_cases WHERE run_id = ?
                """,
                (run_id,),
            ).fetchall()

        per_side: dict[str, dict[str, Any]] = {}
        for side in sides:
            per_side[side] = {
                "agent": run["before_agent"] if side == "before" else run["after_agent"],
                "agent_label": run["before_agent_label"] if side == "before" else run["after_agent_label"],
                "collector_status": run["side_collector_status"].get(side, "pending"),
                "upstream_job_id": run["upstream_jobs"].get(side),
                "total_targets": run["actual_count"],
                "pending_fetch": 0,
                "fetched": 0,
                "cleaned": 0,
                "rejected": 0,
                "evaluating": 0,
                "evaluated": 0,
                "gold_pass": 0,
                "clustered": 0,
                "ready": 0,
                "failed": 0,
                "failed_by_stage": {"fetch": 0, "prepare": 0, "eval": 0, "cluster": 0},
                "severity_distribution": {s: 0 for s in SEVERITY_ORDER},
                "total_problems": 0,
                "completion_rate": 0.0,
                "ready_rate": 0.0,
            }

        for r in case_rows:
            s = r["side"]
            if s not in per_side:
                continue
            bucket = per_side[s]
            st = r["status"]
            fstage = r["failed_stage"]
            if st == "pending_fetch":
                bucket["pending_fetch"] += 1
            elif st == "fetched":
                bucket["fetched"] += 1
            elif st == "preparing":
                bucket["fetched"] += 1
            elif st == "prepared":
                bucket["fetched"] += 1
                bucket["cleaned"] += 1
            elif st == "evaluating":
                bucket["fetched"] += 1
                bucket["cleaned"] += 1
                bucket["evaluating"] += 1
            elif st == "evaluated":
                bucket["fetched"] += 1
                bucket["cleaned"] += 1
                bucket["evaluated"] += 1
            elif st == "clustering":
                bucket["fetched"] += 1
                bucket["cleaned"] += 1
                bucket["evaluated"] += 1
            elif st == "ready":
                bucket["fetched"] += 1
                bucket["cleaned"] += 1
                bucket["evaluated"] += 1
                bucket["ready"] += 1
                if r["is_gold"]:
                    bucket["gold_pass"] += 1
                else:
                    bucket["clustered"] += 1
                sev = r["max_severity"] or ("GOLD" if r["is_gold"] else "P4")
                if sev in bucket["severity_distribution"]:
                    bucket["severity_distribution"][sev] += 1
                bucket["total_problems"] += int(r["problem_count"] or 0)
            elif st == "rejected":
                bucket["fetched"] += 1
                bucket["rejected"] += 1
                bucket["failed_by_stage"]["prepare"] += 1
            elif st == "failed":
                bucket["failed"] += 1
                if fstage in bucket["failed_by_stage"]:
                    bucket["failed_by_stage"][fstage] += 1
                # Accumulate completed earlier stages for accurate funnel
                if fstage in ("prepare", "eval", "cluster"):
                    bucket["fetched"] += 1
                if fstage in ("eval", "cluster"):
                    bucket["cleaned"] += 1
                if fstage == "cluster":
                    bucket["evaluated"] += 1

        total_units = 0
        done_units = 0
        ready_units = 0
        failed_units = 0
        rejected_units = 0
        for bucket in per_side.values():
            denom = max(1, bucket["total_targets"])
            side_done = bucket["ready"] + bucket["failed"] + bucket["rejected"]
            bucket["completion_rate"] = round(side_done / denom, 4) if bucket["total_targets"] else 0.0
            bucket["ready_rate"] = round(bucket["ready"] / denom, 4) if bucket["total_targets"] else 0.0
            total_units += bucket["total_targets"]
            done_units += side_done
            ready_units += bucket["ready"]
            failed_units += bucket["failed"]
            rejected_units += bucket["rejected"]

        # Paired readiness (both before and after ready for the same case_key)
        paired_ready = 0
        if "before" in per_side and "after" in per_side:
            with self._read() as conn:
                paired_row = conn.execute(
                    """
                    SELECT COUNT(*) FROM side_cases a
                    JOIN side_cases b
                      ON a.run_id = b.run_id AND a.case_key = b.case_key
                    WHERE a.run_id = ? AND a.side = 'before' AND b.side = 'after'
                      AND a.status = 'ready' AND b.status = 'ready'
                    """,
                    (run_id,),
                ).fetchone()
                paired_ready = int(paired_row[0]) if paired_row else 0

        # Elapsed time, throughput, ETA
        started_dt = parse_rfc3339(run["started_at"])
        finished_dt = parse_rfc3339(run["finished_at"])
        elapsed_sec = 0.0
        if started_dt:
            end_dt = finished_dt or utc_now()
            elapsed_sec = max(0.0, round((end_dt - started_dt).total_seconds(), 1))
        throughput_per_min = round((done_units / elapsed_sec) * 60.0, 2) if elapsed_sec > 1.0 and done_units > 0 else 0.0
        remaining = max(0, total_units - done_units)
        eta_seconds = (
            round((remaining / (done_units / elapsed_sec)), 1)
            if (remaining > 0 and done_units > 0 and elapsed_sec > 1.0 and run["status"] not in TERMINAL_RUN_STATUSES)
            else (0.0 if remaining == 0 else None)
        )

        overall_rate = round(done_units / total_units, 4) if total_units else 0.0
        return {
            **run,
            "latest_seq": latest_seq,
            "progress": {
                "total_units": total_units,
                "completed_units": done_units,
                "ready_units": ready_units,
                "failed_units": failed_units,
                "rejected_units": rejected_units,
                "pending_units": remaining,
                "paired_ready_cases": paired_ready,
                "completion_rate": overall_rate,
                "percent": round(overall_rate * 100.0, 2),
                "elapsed_seconds": elapsed_sec,
                "throughput_per_min": throughput_per_min,
                "eta_seconds": eta_seconds,
            },
            "sides_detail": per_side,
        }

    # ---- Streaming Ready Results & Incremental Changes ----------------------

    def query_results(
        self,
        run_id: str,
        *,
        side: str | None = None,
        severity: str | None = None,
        problem_code: str | None = None,
        case_key: str | None = None,
        source_origin: str | None = None,
        only_ready: bool = True,
        paired_only: bool = False,
        limit: int = 50,
        offset: int = 0,
    ) -> dict[str, Any]:
        where = ["sc.run_id = ?"]
        args: list[Any] = [run_id]
        if only_ready:
            where.append("sc.status = 'ready'")
        if side:
            where.append("sc.side = ?")
            args.append(side)
        if severity:
            where.append("sc.max_severity = ?")
            args.append(severity.upper())
        if case_key:
            where.append("sc.case_key = ?")
            args.append(case_key)
        if source_origin:
            so = source_origin.strip()
            if so == "bench":
                where.append("t.source_origin IN ('bench', 'bench+算法提供')")
            elif so == "算法提供":
                where.append("t.source_origin IN ('算法提供', 'bench+算法提供')")
            else:
                where.append("t.source_origin = ?")
                args.append(so)
        if paired_only:
            where.append(
                "EXISTS (SELECT 1 FROM side_cases o WHERE o.run_id = sc.run_id AND o.case_key = sc.case_key AND o.side != sc.side AND o.status = 'ready')"
            )

        clause = " AND ".join(where)
        with self._read() as conn:
            rows = conn.execute(
                f"""
                SELECT sc.*, t.question, t.source_trace_id, t.source_model, t.source_origin,
                       t.turn, t.session_round, t.bench_severity
                FROM side_cases sc
                JOIN targets t ON t.run_id = sc.run_id AND t.case_key = sc.case_key
                WHERE {clause}
                ORDER BY sc.eq_index ASC, sc.side ASC
                """,
                args,
            ).fetchall()

        filtered = []
        prefix = problem_code.strip() if problem_code else ""
        for r in rows:
            item = self._row_to_result_item(r)
            if prefix:
                if not any(p == prefix or p.startswith(prefix + ".") for p in item["cluster_paths"]):
                    continue
            filtered.append(item)

        total = len(filtered)
        page = filtered[offset : offset + limit]
        return {
            "total": total,
            "limit": limit,
            "offset": offset,
            "has_more": offset + len(page) < total,
            "items": page,
        }

    def query_result_changes(self, run_id: str, *, since_seq: int = 0, limit: int = 200) -> dict[str, Any]:
        with self._read() as conn:
            seq_row = conn.execute("SELECT latest_seq FROM run_seq WHERE run_id = ?", (run_id,)).fetchone()
            head_seq = int(seq_row["latest_seq"]) if seq_row else 0
            rows = conn.execute(
                """
                SELECT sc.*, t.question, t.source_trace_id, t.source_model, t.source_origin,
                       t.turn, t.session_round, t.bench_severity
                FROM side_cases sc
                JOIN targets t ON t.run_id = sc.run_id AND t.case_key = sc.case_key
                WHERE sc.run_id = ? AND sc.status = 'ready' AND sc.change_seq > ?
                ORDER BY sc.change_seq ASC
                LIMIT ?
                """,
                (run_id, since_seq, limit),
            ).fetchall()

        items = [self._row_to_result_item(r) for r in rows]
        next_since = items[-1]["change_seq"] if items else since_seq
        return {
            "since_seq": since_seq,
            "head_seq": head_seq,
            "next_since": next_since,
            "has_more": next_since < head_seq and len(items) == limit,
            "count": len(items),
            "items": items,
        }

    def get_latest_seq(self, run_id: str) -> int:
        with self._read() as conn:
            row = conn.execute("SELECT latest_seq FROM run_seq WHERE run_id = ?", (run_id,)).fetchone()
        return int(row["latest_seq"]) if row else 0

    # ---- Row Mappers --------------------------------------------------------

    @staticmethod
    def _row_to_run(r: sqlite3.Row) -> dict[str, Any]:
        return {
            "run_id": r["run_id"],
            "idempotency_key": r["idempotency_key"],
            "version": r["version"],
            "round_order": r["round_order"],
            "round_dir_name": r["round_dir_name"],
            "round_dir_path": r["round_dir_path"],
            "model": r["model"],
            "tier": r["tier"],
            "requested_count": r["requested_count"],
            "actual_count": r["actual_count"],
            "sides": _jloads(r["sides_json"], list(ALLOWED_SIDES)),
            "before_mode": r["before_mode"],
            "before_agent": _jloads(r["before_agent_json"], {}),
            "after_agent": _jloads(r["after_agent_json"], {}),
            "before_agent_label": r["before_agent_label"],
            "after_agent_label": r["after_agent_label"],
            "status": r["status"],
            "stage": r["stage"],
            "error_code": r["error_code"],
            "error_message": r["error_message"],
            "callback_url": r["callback_url"],
            "dispatch_files": _jloads(r["dispatch_files_json"], {}),
            "upstream_jobs": _jloads(r["upstream_jobs_json"], {}),
            "side_collector_status": _jloads(r["side_collector_status_json"], {}),
            "last_ingest_at": r["last_ingest_at"],
            "last_cluster_at": r["last_cluster_at"],
            "first_ready_at": r["first_ready_at"],
            "cluster_batches_completed": r["cluster_batches_completed"],
            "taxonomy_created_components": r["taxonomy_created_components"],
            "taxonomy_created_leaves": r["taxonomy_created_leaves"],
            "cancel_requested": bool(r["cancel_requested"]),
            "created_at": r["created_at"],
            "started_at": r["started_at"],
            "finished_at": r["finished_at"],
            "updated_at": r["updated_at"],
            "meta": _jloads(r["meta_json"], {}),
        }

    @staticmethod
    def _row_to_side_case(r: sqlite3.Row) -> dict[str, Any]:
        return {
            "run_id": r["run_id"],
            "side": r["side"],
            "case_key": r["case_key"],
            "eq_index": r["eq_index"],
            "status": r["status"],
            "failed_stage": r["failed_stage"],
            "error_code": r["error_code"],
            "error_message": r["error_message"],
            "retry_count": r["retry_count"],
            "linked_input_id": r["linked_input_id"],
            "linked_output_id": r["linked_output_id"],
            "trace_id": r["trace_id"],
            "session_id": r["session_id"],
            "request_time": r["request_time"],
            "raw_file": r["raw_file"],
            "prepared_file": r["prepared_file"],
            "attribution_file": r["attribution_file"],
            "is_gold": bool(r["is_gold"]),
            "problem_count": r["problem_count"],
            "max_severity": r["max_severity"],
            "severity_counts": _jloads(r["severity_counts_json"], {}),
            "problems": _jloads(r["problems_json"], []),
            "cluster_paths": _jloads(r["cluster_paths_json"], []),
            "cluster_labels": _jloads(r["cluster_labels_json"], []),
            "attribution_summary": r["attribution_summary"] or "",
            "is_correct": None if r["is_correct"] is None else bool(r["is_correct"]),
            "fetched_at": r["fetched_at"],
            "prepared_at": r["prepared_at"],
            "evaluated_at": r["evaluated_at"],
            "clustered_at": r["clustered_at"],
            "ready_at": r["ready_at"],
            "change_seq": r["change_seq"],
            "updated_at": r["updated_at"],
        }

    @classmethod
    def _row_to_result_item(cls, r: sqlite3.Row) -> dict[str, Any]:
        base = cls._row_to_side_case(r)
        base.update(
            {
                "question": r["question"],
                "source_trace_id": r["source_trace_id"],
                "source_model": r["source_model"] or "",
                "source_origin": r["source_origin"] or "bench",
                "turn": r["turn"],
                "session_round": r["session_round"],
                "bench_severity": r["bench_severity"],
            }
        )
        return base
