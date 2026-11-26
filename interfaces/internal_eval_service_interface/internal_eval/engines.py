"""Thin integration wrappers around vendored `eval_harness_pkg` and `cluster_pkg`.

Key capabilities:
  1. `prepare_traces(...)` calls vendored `eval_harness.prepare_eval()` and parses
     `audit_output` to return exact per-record rejection details.
  2. `evaluate_streaming(...)` invokes vendored `eval_harness_pkg` Node engine
     (`engine.mjs evaluate --spec ...`) while simultaneously tailing `output.jsonl`
     and `stderr` in real time so every completed trace is yielded the instant it
     finishes (and every per-trace failure is captured immediately).
  3. `cluster_incremental(...)` calls vendored `cluster_pkg.run_cluster()` with
     shared round taxonomy isolation, returns per-(trace_id, problem_index) leaf
     assignments, and syncs any evolved taxonomy back to the round taxonomy dir.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path
from typing import Any, Callable

from .config import (
    CLUSTER_PKG_VENDOR_DIR,
    EVAL_HARNESS_VENDOR_DIR,
    VENDOR_DIR,
    ServiceConfig,
)

_CASE_KEY_RE = re.compile(r"(eq_\d{4,6})")
_EVAL_FAIL_RE = re.compile(r"\[eval\]\s+case=(\S+)\s+(failed|error):\s*(.+)$")


def ensure_vendor_on_path() -> None:
    for p in (str(EVAL_HARNESS_VENDOR_DIR), str(VENDOR_DIR)):
        if p not in sys.path:
            sys.path.insert(0, p)


def extract_case_key(record: dict[str, Any]) -> str | None:
    """Resolve `eq_NNNNN` case_key from a raw trace, prepared trace, or attribution row."""
    candidates: list[Any] = [
        record.get("case_key"),
        record.get("case_id"),
    ]
    for container_key in ("meta", "session_meta"):
        container = record.get(container_key)
        if isinstance(container, dict):
            candidates.extend([container.get("case_key"), container.get("case_id")])
    for list_key in ("turns", "traces"):
        entries = record.get(list_key)
        if isinstance(entries, list):
            for entry in entries[:1]:
                if isinstance(entry, dict):
                    emeta = entry.get("meta")
                    if isinstance(emeta, dict):
                        candidates.extend([emeta.get("case_key"), emeta.get("case_id")])
    for val in candidates:
        if not val:
            continue
        m = _CASE_KEY_RE.search(str(val))
        if m:
            return m.group(1)
    return None


def extract_trace_identity(record: dict[str, Any]) -> tuple[str, str, str]:
    """Return `(trace_id, session_id, request_time)` from raw or attribution records."""
    meta = record.get("meta") if isinstance(record.get("meta"), dict) else {}
    smeta = record.get("session_meta") if isinstance(record.get("session_meta"), dict) else {}
    turns = record.get("turns") if isinstance(record.get("turns"), list) else []
    tmeta = turns[0].get("meta") if turns and isinstance(turns[0], dict) and isinstance(turns[0].get("meta"), dict) else {}
    traces = record.get("traces") if isinstance(record.get("traces"), list) else []
    trmeta = traces[0].get("meta") if traces and isinstance(traces[0], dict) and isinstance(traces[0].get("meta"), dict) else {}

    trace_id = str(
        tmeta.get("trace_id")
        or trmeta.get("trace_id")
        or record.get("trace_id")
        or meta.get("trace_id")
        or smeta.get("trace_id")
        or ""
    ).strip()
    session_id = str(
        smeta.get("session_id")
        or meta.get("session_id")
        or record.get("session_id")
        or trmeta.get("session_id")
        or tmeta.get("session_id")
        or ""
    ).strip()
    request_time = str(
        smeta.get("request_time")
        or meta.get("request_time")
        or record.get("request_time")
        or trmeta.get("request_time")
        or trmeta.get("timestamp")
        or meta.get("timestamp")
        or tmeta.get("request_time")
        or ""
    ).strip()
    return trace_id, session_id, request_time


def extract_attribution_result(row: dict[str, Any]) -> dict[str, Any]:
    """Extract normalized problems, summary, is_correct, trace_id, session_id from attribution row."""
    trace_id, session_id, request_time = extract_trace_identity(row)
    case_key = extract_case_key(row)
    turns = row.get("turns") if isinstance(row.get("turns"), list) else []
    problems: list[dict[str, Any]] = []
    summaries: list[str] = []
    is_correct: bool | None = None

    for turn in turns:
        if not isinstance(turn, dict):
            continue
        if turn.get("summary"):
            summaries.append(str(turn["summary"]))
        if turn.get("is_correct") is not None:
            is_correct = bool(turn["is_correct"])
        t_probs = turn.get("problem")
        if isinstance(t_probs, list):
            for p in t_probs:
                if isinstance(p, dict):
                    problems.append(p)

    # Support flat attribution rows too
    if not turns and isinstance(row.get("problem"), list):
        problems = [p for p in row["problem"] if isinstance(p, dict)]

    return {
        "case_key": case_key,
        "trace_id": trace_id,
        "session_id": session_id,
        "request_time": request_time,
        "problems": problems,
        "summary": "\n".join(summaries).strip(),
        "is_correct": is_correct,
    }


class EngineBackend:
    """Abstract interface for prepare / streaming eval / incremental cluster engines."""

    def prepare(
        self,
        *,
        raw_input_path: Path,
        output_path: Path,
        audit_path: Path,
        batch_id: str,
        version: str,
    ) -> dict[str, Any]:
        raise NotImplementedError

    def evaluate_streaming(
        self,
        *,
        input_path: Path,
        output_path: Path,
        audit_path: Path,
        batch_id: str,
        version: str,
        on_row: Callable[[dict[str, Any]], None],
        on_case_error: Callable[[str, str], None],
        cancel_check: Callable[[], bool],
        compact_output: Path | None = None,
    ) -> dict[str, Any]:
        raise NotImplementedError

    def cluster_incremental(
        self,
        *,
        attribution_input: Path,
        tree_dir: Path,
        shared_taxonomy_dir: Path,
        allow_auto_leaf: bool,
        log_fn: Callable[[str], None] | None = None,
    ) -> dict[str, Any]:
        raise NotImplementedError

    def human_read(
        self,
        *,
        input_path: Path,
        attribution_path: Path,
        output_path: Path,
        work_dir: Path,
        compact_path: Path | None = None,
    ) -> dict[str, Any]:
        return {"skipped": True}


class VendoredEngineBackend(EngineBackend):
    """Production engine backend backed directly by vendored `eval_harness_pkg` & `cluster_pkg`."""

    def __init__(self, cfg: ServiceConfig):
        self.cfg = cfg

    def prepare(
        self,
        *,
        raw_input_path: Path,
        output_path: Path,
        audit_path: Path,
        batch_id: str,
        version: str,
    ) -> dict[str, Any]:
        ensure_vendor_on_path()
        from eval_harness import prepare_eval  # type: ignore

        output_path.parent.mkdir(parents=True, exist_ok=True)
        audit_path.parent.mkdir(parents=True, exist_ok=True)
        cfg_dict = {
            "input": str(output_path),
            "output": str(output_path.with_suffix(".unused.jsonl")),
            "prepare": {
                "raw_input": str(raw_input_path),
                "output": str(output_path),
                "audit_output": str(audit_path),
                "split_traces": True,
                "repair_question": True,
                "slim": True,
                "default_batch_id": batch_id,
                "version": version,
                "fail_on_reject": False,
            },
        }
        report = prepare_eval(cfg_dict)
        issues = _read_jsonl_safe(audit_path)
        report["audit_issues"] = issues
        return report

    def evaluate_streaming(
        self,
        *,
        input_path: Path,
        output_path: Path,
        audit_path: Path,
        batch_id: str,
        version: str,
        on_row: Callable[[dict[str, Any]], None],
        on_case_error: Callable[[str, str], None],
        cancel_check: Callable[[], bool],
        compact_output: Path | None = None,
    ) -> dict[str, Any]:
        ensure_vendor_on_path()
        from eval_harness.runner import bundle_dir, check_node_runtime  # type: ignore

        if not self.cfg.gateway_api_key:
            raise RuntimeError("未配置评测网关密钥（INTERNAL_EVAL_GATEWAY_API_KEY）")

        node_bin = check_node_runtime()
        engine = bundle_dir() / "engine.mjs"
        if not engine.is_file():
            raise FileNotFoundError(f"Bundled evaluation engine missing: {engine}")

        output_path.parent.mkdir(parents=True, exist_ok=True)
        audit_path.parent.mkdir(parents=True, exist_ok=True)
        if compact_output is not None:
            compact_output.parent.mkdir(parents=True, exist_ok=True)

        # Record current offset in output_path so we only emit newly appended rows
        start_offset = output_path.stat().st_size if output_path.is_file() else 0

        api_key_env = "EVAL_PKG_API_KEY"
        spec: dict[str, Any] = {
            "api": {
                "base_url": self.cfg.gateway_base_url,
                "api_key_env": api_key_env,
                "model": self.cfg.eval_model,
                "thinking": self.cfg.eval_thinking,
                "compact_thinking": self.cfg.eval_compact_thinking,
                "trace_thinking": self.cfg.eval_trace_thinking,
                "context_window": 524288,
                "max_output_tokens": 32768,
            },
            "input": str(input_path),
            "output": str(output_path),
            **({"compact_output": str(compact_output)} if compact_output is not None else {}),
            "audit_output": str(audit_path),
            "execution": {
                "concurrency": self.cfg.eval_concurrency,
                "task_concurrency": self.cfg.eval_task_concurrency,
                "model_requests": self.cfg.eval_model_requests,
                "worker_slots": self.cfg.eval_worker_slots,
                "max_worker_slots": 32,
                "max_tool_calls": 8,
                "timeout_seconds": self.cfg.eval_timeout_seconds,
                "idle_timeout_seconds": self.cfg.eval_idle_timeout_seconds,
                "retries": self.cfg.eval_retries,
                "retry_delay_seconds": 10,
                "repair_attempts": 3,
                "max_message_bytes": 2 * 1024 * 1024,
                "max_line_bytes": 128 * 1024 * 1024,
                "default_batch_id": batch_id,
                "version": version,
                "resume": True,
                "fail_on_reject": False,
                "quiet": False,
            },
        }
        child_env = {
            **os.environ,
            api_key_env: self.cfg.gateway_api_key,
            "EVAL_PYTHON": sys.executable,
            "PI_OFFLINE": "1",
            "PI_TELEMETRY": "0",
            "DO_NOT_TRACK": "1",
        }

        stderr_lines: list[str] = []
        stop_tail = threading.Event()
        drain_lock = threading.Lock()
        tail_state = {"offset": start_offset}

        def _drain_output() -> None:
            new_rows: list[dict[str, Any]] = []
            with drain_lock:
                if not output_path.is_file():
                    return
                size = output_path.stat().st_size
                if size <= tail_state["offset"]:
                    return
                with output_path.open("rb") as fh:
                    fh.seek(tail_state["offset"])
                    chunk = fh.read()
                last_nl = chunk.rfind(b"\n")
                if last_nl < 0:
                    return
                complete = chunk[: last_nl + 1]
                tail_state["offset"] += len(complete)
                for raw_line in complete.splitlines():
                    text = raw_line.decode("utf-8", "replace").strip()
                    if not text:
                        continue
                    try:
                        row = json.loads(text)
                    except ValueError:
                        continue
                    if isinstance(row, dict):
                        new_rows.append(row)
            for row in new_rows:
                on_row(row)

        def _tail_loop() -> None:
            while not stop_tail.is_set():
                try:
                    _drain_output()
                except Exception:
                    pass
                stop_tail.wait(self.cfg.eval_poll_interval_sec)

        with tempfile.TemporaryDirectory(prefix="internal-eval-") as tmp_dir:
            spec_file = Path(tmp_dir) / "eval-spec.json"
            spec_file.write_text(json.dumps(spec, ensure_ascii=False), encoding="utf-8")

            proc = subprocess.Popen(
                [node_bin, str(engine), "evaluate", "--spec", str(spec_file)],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                env=child_env,
            )

            def _read_stderr() -> None:
                assert proc.stderr is not None
                for line in proc.stderr:
                    stripped = line.strip()
                    if not stripped:
                        continue
                    stderr_lines.append(stripped)
                    m = _EVAL_FAIL_RE.search(stripped)
                    if m:
                        on_case_error(m.group(1), m.group(3))

            stderr_thread = threading.Thread(target=_read_stderr, daemon=True)
            tail_thread = threading.Thread(target=_tail_loop, daemon=True)
            stderr_thread.start()
            tail_thread.start()

            stdout_chunks: list[str] = []

            def _read_stdout() -> None:
                assert proc.stdout is not None
                stdout_chunks.append(proc.stdout.read())

            stdout_thread = threading.Thread(target=_read_stdout, daemon=True)
            stdout_thread.start()

            cancelled = False
            while proc.poll() is None:
                if cancel_check() and not cancelled:
                    cancelled = True
                    try:
                        proc.send_signal(signal.SIGINT)
                    except OSError:
                        pass
                time.sleep(0.25)

            stdout_thread.join(timeout=10)
            stderr_thread.join(timeout=10)
            stop_tail.set()
            tail_thread.join()
            # Final drain after process exits so no last row is missed
            _drain_output()

        stdout_text = "".join(stdout_chunks).strip()
        summary: dict[str, Any] = {}
        if stdout_text:
            try:
                summary = json.loads(stdout_text)
            except ValueError:
                summary = {}
        summary["returncode"] = proc.returncode
        summary["cancelled"] = cancelled
        summary["stderr_tail"] = stderr_lines[-20:]
        if proc.returncode not in (0, 2, 130) and not cancelled:
            detail = "\n".join(stderr_lines[-5:]) or stdout_text or f"exit code {proc.returncode}"
            raise RuntimeError(f"eval_harness 执行异常 (rc={proc.returncode}): {detail}")
        return summary

    def cluster_incremental(
        self,
        *,
        attribution_input: Path,
        tree_dir: Path,
        shared_taxonomy_dir: Path,
        allow_auto_leaf: bool,
        log_fn: Callable[[str], None] | None = None,
    ) -> dict[str, Any]:
        ensure_vendor_on_path()
        from cluster_pkg import run_cluster  # type: ignore

        if not self.cfg.gateway_api_key:
            raise RuntimeError("未配置聚类网关密钥（INTERNAL_EVAL_GATEWAY_API_KEY）")

        tree_dir.mkdir(parents=True, exist_ok=True)
        shared_taxonomy_dir.mkdir(parents=True, exist_ok=True)

        # Ensure tree_dir/taxonomy receives any new leaves/components learned by the other side
        tree_tax_dir = tree_dir / "taxonomy"
        if shared_taxonomy_dir.is_dir() and any(shared_taxonomy_dir.iterdir()):
            tree_tax_dir.mkdir(parents=True, exist_ok=True)
            for src in shared_taxonomy_dir.iterdir():
                if src.is_file():
                    shutil.copy2(src, tree_tax_dir / src.name)

        cluster_cfg: dict[str, Any] = {
            "api": {
                "base_url": self.cfg.gateway_base_url,
                "protocol": "auto",
                "api_key": self.cfg.gateway_api_key,
                "model": self.cfg.cluster_model,
                "reasoning_effort": self.cfg.cluster_reasoning_effort,
                "timeout": 600,
                "max_output_tokens": 32768,
                "request_attempts": 8,
            },
            "tree_dir": str(tree_dir),
            "input": str(attribution_input),
            "taxonomy_dir": str(shared_taxonomy_dir),
            "mode": "auto",
            "channel": "aime",
            "cluster": {
                "concurrency": self.cfg.cluster_concurrency,
                "chunk_size": 0,
                "consensus": 1,
                "retries": 3,
                "path_repair": True,
            },
            "adaptive": {
                "enabled": True,
                "auto_component": True,
                "auto_leaf": bool(allow_auto_leaf),
                "min_leaf_items": 1,
            },
            "l4": {
                "enabled": bool(self.cfg.cluster_l4_enabled),
                "leaves": "auto" if self.cfg.cluster_l4_enabled else "",
                "min_items": 1,
            },
        }
        result = run_cluster(cluster_cfg, logger=log_fn)

        # Sync any newly evolved taxonomy back to shared_taxonomy_dir so both sides stay aligned
        if tree_tax_dir.is_dir():
            for src in tree_tax_dir.iterdir():
                if src.is_file():
                    shutil.copy2(src, shared_taxonomy_dir / src.name)

        assignments, leaf_names = load_cluster_assignments(tree_dir)
        result["assignments"] = assignments
        result["leaf_names"] = leaf_names
        return result

    def human_read(
        self,
        *,
        input_path: Path,
        attribution_path: Path,
        output_path: Path,
        work_dir: Path,
        compact_path: Path | None = None,
    ) -> dict[str, Any]:
        """Run post-processing human-read translation and copy to `attribution_human_read.jsonl`."""
        if (
            not self.cfg.human_read_enabled
            or not attribution_path.is_file()
            or attribution_path.stat().st_size == 0
        ):
            return {"skipped": True, "reason": "disabled_or_empty"}
        if not self.cfg.gateway_api_key:
            raise RuntimeError("未配置人话翻译网关密钥（INTERNAL_EVAL_GATEWAY_API_KEY）")

        ensure_vendor_on_path()
        from eval_harness import human_read_eval  # type: ignore

        work_dir.mkdir(parents=True, exist_ok=True)
        cfg_dict: dict[str, Any] = {
            "api": {
                "base_url": self.cfg.gateway_base_url,
                "api_key": self.cfg.gateway_api_key,
                "model": self.cfg.eval_model,
            },
            "input": str(input_path),
            "output": str(attribution_path),
            "human_read": {
                "output_root": str(work_dir),
                "base_url": self.cfg.gateway_base_url,
                "model": self.cfg.human_read_model or self.cfg.eval_model,
                "api_key": self.cfg.gateway_api_key,
                "api": self.cfg.human_read_api or "openai-completions",
                "kinds": ["attribution"],
                "workers": self.cfg.human_read_workers,
            },
        }
        if compact_path is not None and compact_path.is_file():
            cfg_dict["human_read"]["compact_input"] = str(compact_path)

        summary = dict(human_read_eval(cfg_dict, quiet=True) or {})
        translated = work_dir / attribution_path.name
        copied = False
        if translated.is_file() and translated.stat().st_size > 0:
            output_path.parent.mkdir(parents=True, exist_ok=True)
            tmp = output_path.parent / f".{output_path.name}.tmp"
            shutil.copy2(translated, tmp)
            os.replace(tmp, output_path)
            copied = True
        summary["output_path"] = str(output_path)
        summary["copied"] = copied
        return summary


def load_cluster_assignments(tree_dir: Path) -> tuple[dict[str, dict[int, dict[str, Any]]], dict[str, str]]:
    """Read `item_index.jsonl` and `leaves.tsv`/`cluster_tree.json` from a cluster_pkg output dir.

    Returns:
        assignments: `{trace_id: {problem_index: {"path": ..., "name": ..., "edge": ...}}}`
        leaf_names: `{path: display_name}`
    """
    leaf_names: dict[str, str] = {}
    tsv_path = tree_dir / "leaves.tsv"
    if tsv_path.is_file():
        lines = tsv_path.read_text(encoding="utf-8", errors="replace").splitlines()
        if len(lines) >= 2:
            headers = lines[0].split("\t")
            path_idx = headers.index("path") if "path" in headers else 0
            name_idx = headers.index("name") if "name" in headers else 1
            for line in lines[1:]:
                cols = line.split("\t")
                if len(cols) > max(path_idx, name_idx):
                    p = cols[path_idx].strip()
                    n = cols[name_idx].strip()
                    if p:
                        leaf_names[p] = n or p

    tree_json = tree_dir / "cluster_tree.json"
    if tree_json.is_file():
        try:
            doc = json.loads(tree_json.read_text(encoding="utf-8"))
            stack = [doc.get("tree") or {}]
            while stack:
                node = stack.pop()
                nid = node.get("id") or ""
                if nid and node.get("name"):
                    leaf_names[nid] = str(node["name"])
                for ch in node.get("children") or []:
                    if isinstance(ch, dict):
                        stack.append(ch)
        except ValueError:
            pass

    assignments: dict[str, dict[int, dict[str, Any]]] = {}
    index_path = tree_dir / "item_index.jsonl"
    if index_path.is_file():
        with index_path.open("r", encoding="utf-8", errors="replace") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    row = json.loads(line)
                except ValueError:
                    continue
                tid = str(row.get("trace_id") or "").strip()
                pidx = row.get("problem_index")
                path = str(row.get("path") or "").strip()
                if not tid or pidx is None or not path:
                    continue
                try:
                    pidx_int = int(pidx)
                except (TypeError, ValueError):
                    continue
                assignments.setdefault(tid, {})[pidx_int] = {
                    "path": path,
                    "name": leaf_names.get(path) or str(row.get("leaf_name") or path),
                    "edge": bool(row.get("edge", False)),
                }

    return assignments, leaf_names


def _read_jsonl_safe(path: Path) -> list[dict[str, Any]]:
    if not path.is_file():
        return []
    out: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8", errors="replace") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
                if isinstance(obj, dict):
                    out.append(obj)
            except ValueError:
                continue
    return out
