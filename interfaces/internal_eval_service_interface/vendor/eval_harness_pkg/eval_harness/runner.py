"""Portable execution wrapper for the bundled TypeScript evaluation engine."""

from __future__ import annotations

import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

from .config import EvalConfig, load_config

MIN_NODE_VERSION = (22, 19)
_NODE_VERSION_RE = re.compile(r"^v?(\d+)\.(\d+)(?:\.(\d+))?")


class EvalRunError(RuntimeError):
    """Raised when preparation or evaluation exits with an error."""

    def __init__(self, message: str, returncode: int = 1, summary: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.returncode = returncode
        self.summary = summary


def bundle_dir() -> Path:
    return Path(__file__).resolve().parent / "bundle"


def check_node_runtime() -> str:
    """Verify Node.js >= 22.19 is available and return the binary path."""
    node_bin = os.environ.get("EVAL_NODE_BIN") or shutil.which("node")
    if not node_bin:
        raise RuntimeError(
            "Node.js >= 22.19 is required to run the bundled evaluator, but `node` was not found on PATH. "
            "Install Node.js 22.19+/24 or set EVAL_NODE_BIN."
        )
    proc = subprocess.run([node_bin, "--version"], capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(f"Failed to query Node.js version via {node_bin}: {proc.stderr.strip()}")
    match = _NODE_VERSION_RE.match(proc.stdout.strip())
    if not match:
        raise RuntimeError(f"Unrecognized Node.js version string: {proc.stdout.strip()!r}")
    major, minor = int(match.group(1)), int(match.group(2))
    if (major, minor) < MIN_NODE_VERSION:
        raise RuntimeError(
            f"Node.js >= {MIN_NODE_VERSION[0]}.{MIN_NODE_VERSION[1]} is required, found {proc.stdout.strip()}"
        )
    return node_bin


def run_eval(
    config: str | Path | dict[str, Any] | EvalConfig,
    *,
    limit: int | None = None,
    concurrency: int | None = None,
    resume: bool | None = None,
    fail_on_reject: bool | None = None,
    quiet: bool = False,
) -> dict[str, Any]:
    """Run attribution evaluation from config.yaml (or dict / EvalConfig)."""
    cfg = config if isinstance(config, EvalConfig) else load_config(config, require_api=True)
    if cfg.api is None:
        raise ValueError("Missing required api configuration")
    if not cfg.input_path.exists():
        raise FileNotFoundError(f"Evaluation input not found: {cfg.input_path}")

    api_key = cfg.api.resolve_api_key()
    node_bin = check_node_runtime()
    engine = bundle_dir() / "engine.mjs"
    if not engine.is_file():
        raise FileNotFoundError(f"Bundled evaluation engine missing: {engine}")

    exec_cfg = cfg.execution
    effective_limit = exec_cfg.limit if limit is None else limit
    effective_concurrency = exec_cfg.concurrency if concurrency is None else concurrency
    effective_resume = exec_cfg.resume if resume is None else resume
    effective_fail_on_reject = exec_cfg.fail_on_reject if fail_on_reject is None else fail_on_reject

    api_key_env = "EVAL_PKG_API_KEY"
    spec: dict[str, Any] = {
        "api": {
            "base_url": cfg.api.base_url,
            "api_key_env": api_key_env,
            "model": cfg.api.model,
            "thinking": cfg.api.thinking,
            "compact_thinking": cfg.api.compact_thinking,
            "trace_thinking": cfg.api.trace_thinking,
            "context_window": cfg.api.context_window,
            "max_output_tokens": cfg.api.max_output_tokens,
            **({"supports_developer_role": cfg.api.supports_developer_role} if cfg.api.supports_developer_role is not None else {}),
            **({"supports_explicit_prompt_caching": cfg.api.supports_explicit_prompt_caching} if cfg.api.supports_explicit_prompt_caching is not None else {}),
        },
        "input": str(cfg.input_path),
        "output": str(cfg.output_path),
        **({"compact_output": str(exec_cfg.compact_output)} if exec_cfg.compact_output else {}),
        **({"audit_output": str(exec_cfg.audit_output)} if exec_cfg.audit_output else {}),
        "execution": {
            "concurrency": effective_concurrency,
            "task_concurrency": exec_cfg.task_concurrency,
            "model_requests": exec_cfg.model_requests,
            "worker_slots": exec_cfg.worker_slots,
            "max_worker_slots": exec_cfg.max_worker_slots,
            "max_tool_calls": exec_cfg.max_tool_calls,
            "timeout_seconds": exec_cfg.timeout_seconds,
            "idle_timeout_seconds": exec_cfg.idle_timeout_seconds,
            "retries": exec_cfg.retries,
            "retry_delay_seconds": exec_cfg.retry_delay_seconds,
            "repair_attempts": exec_cfg.repair_attempts,
            "max_message_bytes": exec_cfg.max_message_bytes,
            "max_line_bytes": exec_cfg.max_line_bytes,
            "default_batch_id": exec_cfg.default_batch_id,
            "version": exec_cfg.version,
            **({"limit": effective_limit} if effective_limit is not None else {}),
            "resume": effective_resume,
            "fail_on_reject": effective_fail_on_reject,
            "quiet": quiet,
        },
    }

    child_env = {
        **os.environ,
        api_key_env: api_key,
        "EVAL_PYTHON": sys.executable,
        "PI_OFFLINE": "1",
        "PI_TELEMETRY": "0",
        "DO_NOT_TRACK": "1",
    }

    with tempfile.TemporaryDirectory(prefix="eval-run-") as tmp_dir:
        spec_file = Path(tmp_dir) / "eval-spec.json"
        spec_file.write_text(json.dumps(spec, ensure_ascii=False), encoding="utf-8")

        proc = subprocess.Popen(
            [node_bin, str(engine), "evaluate", "--spec", str(spec_file)],
            stdout=subprocess.PIPE,
            stderr=None if not quiet else subprocess.PIPE,
            text=True,
            env=child_env,
        )
        try:
            stdout, stderr = proc.communicate()
        except KeyboardInterrupt:
            proc.send_signal(signal.SIGINT)
            try:
                stdout, stderr = proc.communicate(timeout=15)
            except subprocess.TimeoutExpired:
                proc.kill()
                stdout, stderr = proc.communicate()
            raise EvalRunError("Evaluation interrupted by user", returncode=130)

        summary: dict[str, Any] | None = None
        if stdout.strip():
            try:
                summary = json.loads(stdout)
            except json.JSONDecodeError:
                summary = None

        if proc.returncode != 0:
            detail = (stderr or "").strip() or (stdout or "").strip() or f"exit code {proc.returncode}"
            if summary is not None and proc.returncode == 2:
                raise EvalRunError(
                    f"Evaluation finished with failures (failed={summary.get('failed', 0)}, rejected={summary.get('rejected', 0)})",
                    returncode=2,
                    summary=summary,
                )
            raise EvalRunError(detail, returncode=proc.returncode, summary=summary)

        if summary is None:
            raise EvalRunError("Evaluation engine produced no JSON summary", returncode=1)
        return summary
