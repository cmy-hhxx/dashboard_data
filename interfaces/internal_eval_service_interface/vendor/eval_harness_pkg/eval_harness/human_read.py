"""Portable post-processing human-read wrapper for the bundled Node engine."""

from __future__ import annotations

import json
import os
import signal
import subprocess
import tempfile
from pathlib import Path
from typing import Any

from .config import EvalConfig, HumanReadConfig, load_config
from .runner import EvalRunError, bundle_dir, check_node_runtime


def _resolve_hr_api_key(hr: HumanReadConfig, cfg: EvalConfig) -> str:
    if hr.api_key:
        return hr.api_key
    if hr.api_key_env:
        val = os.environ.get(hr.api_key_env, "").strip()
        if val:
            return val
        raise ValueError(f"Environment variable {hr.api_key_env!r} is not set or empty")
    if cfg.api is not None:
        return cfg.api.resolve_api_key()
    raise ValueError("human_read.api_key / human_read.api_key_env (or top-level api) is required")


def _collect_input_files(eval_input: Path | None) -> list[str]:
    if eval_input is None or not eval_input.exists():
        return []
    if eval_input.is_file():
        return [str(eval_input)]
    if eval_input.is_dir():
        return [str(p) for p in sorted(eval_input.rglob("*.jsonl")) if p.is_file()]
    return []


def _build_sources(hr: HumanReadConfig, cfg: EvalConfig) -> list[dict[str, Any]]:
    sources: list[dict[str, Any]] = []
    if hr.source_dir is not None or hr.ab_root is not None:
        if hr.source_dir is not None:
            entry: dict[str, Any] = {
                "kind": "business",
                "outputDir": str(hr.source_dir),
                "kinds": list(hr.kinds),
            }
            if hr.input_dir is not None:
                entry["inputDir"] = str(hr.input_dir)
            if hr.rel_prefix is not None:
                entry["relPrefix"] = hr.rel_prefix
            if hr.models:
                entry["models"] = list(hr.models)
            if hr.dates:
                entry["dates"] = list(hr.dates)
            sources.append(entry)
        if hr.ab_root is not None:
            sources.append({
                "kind": "ab_test",
                "abRoot": str(hr.ab_root),
                "kinds": list(hr.kinds),
            })
        return sources

    eval_input = hr.eval_input or cfg.input_path
    input_files = _collect_input_files(eval_input)
    attr_file = hr.attribution_input or cfg.output_path
    comp_file = hr.compact_input or cfg.execution.compact_output

    if "attribution" in hr.kinds and attr_file is not None and attr_file.is_file():
        sources.append({
            "kind": "file",
            "file": str(attr_file),
            "recordKind": "attribution",
            "relPath": attr_file.name,
            "inputFiles": input_files,
        })
    if "compact" in hr.kinds and comp_file is not None and comp_file.is_file():
        sources.append({
            "kind": "file",
            "file": str(comp_file),
            "recordKind": "compact",
            "relPath": f"compact/{comp_file.name}",
            "inputFiles": input_files,
        })
    if not sources:
        raise FileNotFoundError(
            f"No attribution or compact source files found (checked attribution={attr_file}, compact={comp_file})"
        )
    return sources


def human_read_eval(
    config: str | Path | dict[str, Any] | EvalConfig,
    *,
    limit: int | None = None,
    workers: int | None = None,
    rpm: int | None = None,
    retry_failed: bool | None = None,
    quiet: bool = False,
) -> dict[str, Any]:
    """Run post-processing human-read translation using config.yaml (or dict / EvalConfig)."""
    cfg = config if isinstance(config, EvalConfig) else load_config(config, require_api=False)
    hr = cfg.human_read

    output_root = hr.output_root or (cfg.output_path.parent / "human_read")
    base_url = hr.base_url or (cfg.api.base_url if cfg.api else None)
    model = hr.model or (cfg.api.model if cfg.api else None)
    if not base_url:
        raise ValueError("Missing required human_read.base_url (or top-level api.base_url)")
    if not model:
        raise ValueError("Missing required human_read.model (or top-level api.model)")

    api_kind = hr.api if hr.api is not None else "openai-completions"

    api_key = _resolve_hr_api_key(hr, cfg)
    sources = _build_sources(hr, cfg)

    node_bin = check_node_runtime()
    bundle = bundle_dir() / "human-read.mjs"
    if not bundle.is_file():
        raise FileNotFoundError(f"Bundled human-read engine missing: {bundle}")

    api_key_env = "EVAL_PKG_HUMAN_READ_API_KEY"
    effective_limit = hr.limit if limit is None else limit
    effective_workers = hr.workers if workers is None else workers
    effective_rpm = hr.target_rpm if rpm is None else rpm
    effective_retry_failed = hr.retry_failed if retry_failed is None else retry_failed

    spec: dict[str, Any] = {
        "outputRoot": str(output_root),
        "sources": sources,
        "gateway": {
            "baseUrl": base_url,
            "apiKeyEnv": api_key_env,
            "model": model,
            "api": api_kind,
            "targetRpm": effective_rpm,
            "temperature": hr.temperature,
            "maxTokens": hr.max_tokens,
            "timeoutMs": hr.timeout_seconds * 1000,
            "maxRetries": hr.max_retries,
            "problemBatchSize": hr.problem_batch_size,
            "compactBatchSize": hr.compact_batch_size,
        },
        "workers": effective_workers,
        "retryFailed": effective_retry_failed,
        "quiet": quiet,
        **({"limit": effective_limit} if effective_limit is not None else {}),
        **({"runtimeConfigPath": str(hr.runtime_config)} if hr.runtime_config is not None else {}),
    }

    child_env = {**os.environ, api_key_env: api_key}

    with tempfile.TemporaryDirectory(prefix="eval-human-read-") as tmp_dir:
        spec_file = Path(tmp_dir) / "human-read-spec.json"
        spec_file.write_text(json.dumps(spec, ensure_ascii=False), encoding="utf-8")

        proc = subprocess.Popen(
            [node_bin, str(bundle), "run", "--spec", str(spec_file)],
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
            raise EvalRunError("Human-read translation interrupted by user", returncode=130)

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
                    f"Human-read translation finished with failures (failed={summary.get('failed', 0)})",
                    returncode=2,
                    summary=summary,
                )
            raise EvalRunError(detail, returncode=proc.returncode, summary=summary)

        if summary is None:
            raise EvalRunError("Human-read engine produced no JSON summary", returncode=1)
        return summary


def human_read_status(config_or_output_root: str | Path | dict[str, Any] | EvalConfig) -> dict[str, Any]:
    """Read current human-read translation status counts for an output_root or config."""
    if isinstance(config_or_output_root, EvalConfig):
        output_root = config_or_output_root.human_read.output_root or (
            config_or_output_root.output_path.parent / "human_read"
        )
    elif isinstance(config_or_output_root, dict):
        cfg = load_config(config_or_output_root, require_api=False)
        output_root = cfg.human_read.output_root or (cfg.output_path.parent / "human_read")
    else:
        p = Path(config_or_output_root).expanduser().resolve()
        if p.is_file() and p.suffix.lower() in (".yaml", ".yml", ".json"):
            cfg = load_config(p, require_api=False)
            output_root = cfg.human_read.output_root or (cfg.output_path.parent / "human_read")
        else:
            output_root = p

    node_bin = check_node_runtime()
    bundle = bundle_dir() / "human-read.mjs"
    if not bundle.is_file():
        raise FileNotFoundError(f"Bundled human-read engine missing: {bundle}")

    proc = subprocess.run(
        [node_bin, str(bundle), "status", "--output", str(output_root)],
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        raise EvalRunError(proc.stderr.strip() or proc.stdout.strip() or "status failed", returncode=proc.returncode)
    return json.loads(proc.stdout)
