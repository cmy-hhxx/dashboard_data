"""Configuration loading and validation for eval_harness_pkg.

Uses PyYAML when installed, and falls back to a built-in pure-Python YAML parser
so external projects can run without installing extra Python packages.
"""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

THINKING_LEVELS = ("off", "minimal", "low", "medium", "high", "xhigh", "max")
_ENV_PATTERN = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}")


@dataclass(frozen=True)
class ApiConfig:
    base_url: str
    model: str
    api_key: str | None = None
    api_key_env: str | None = None
    thinking: str = "low"
    compact_thinking: str = "off"
    trace_thinking: str = "off"
    context_window: int = 524288
    max_output_tokens: int = 32768
    supports_developer_role: bool | None = None
    supports_explicit_prompt_caching: bool | None = None

    def resolve_api_key(self) -> str:
        if self.api_key:
            return self.api_key
        if self.api_key_env:
            value = os.environ.get(self.api_key_env, "").strip()
            if value:
                return value
            raise ValueError(f"Environment variable {self.api_key_env!r} is not set or empty")
        raise ValueError("api.api_key or api.api_key_env is required")


@dataclass(frozen=True)
class PrepareConfig:
    raw_input: Path | None = None
    output: Path | None = None
    audit_output: Path | None = None
    split_traces: bool = True
    repair_question: bool = True
    slim: bool = True
    verify_slim: bool = False
    default_batch_id: str = "eval"
    version: str = "evaluated_model"
    max_message_bytes: int = 2 * 1024 * 1024
    max_line_bytes: int = 128 * 1024 * 1024
    fail_on_reject: bool = False


@dataclass(frozen=True)
class ExecutionConfig:
    concurrency: int = 8
    task_concurrency: int = 12
    model_requests: int = 32
    worker_slots: int = 4
    max_worker_slots: int = 32
    max_tool_calls: int = 8
    timeout_seconds: int = 900
    idle_timeout_seconds: int = 120
    retries: int = 3
    retry_delay_seconds: int = 10
    repair_attempts: int = 3
    max_message_bytes: int = 2 * 1024 * 1024
    max_line_bytes: int = 128 * 1024 * 1024
    default_batch_id: str = "eval"
    version: str = "evaluated_model"
    limit: int | None = None
    resume: bool = True
    fail_on_reject: bool = False
    compact_output: Path | None = None
    audit_output: Path | None = None


@dataclass(frozen=True)
class EvalConfig:
    input_path: Path
    output_path: Path
    api: ApiConfig | None = None
    prepare: PrepareConfig = field(default_factory=PrepareConfig)
    execution: ExecutionConfig = field(default_factory=ExecutionConfig)
    config_path: Path | None = None


def _strip_comment(line: str) -> str:
    in_single = False
    in_double = False
    escaped = False
    for idx, ch in enumerate(line):
        if escaped:
            escaped = False
            continue
        if ch == "\\" and in_double:
            escaped = True
            continue
        if ch == "'" and not in_double:
            in_single = not in_single
        elif ch == '"' and not in_single:
            in_double = not in_double
        elif ch == "#" and not in_single and not in_double:
            if idx == 0 or line[idx - 1].isspace():
                return line[:idx].rstrip()
    return line.rstrip()


def _parse_scalar(raw: str) -> Any:
    text = raw.strip()
    if text in ("", "null", "Null", "NULL", "~"):
        return None
    if text in ("true", "True", "TRUE"):
        return True
    if text in ("false", "False", "FALSE"):
        return False
    if (text.startswith('"') and text.endswith('"')) or (text.startswith("[") and text.endswith("]")) or (text.startswith("{") and text.endswith("}")):
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            pass
    if text.startswith("'") and text.endswith("'") and len(text) >= 2:
        return text[1:-1].replace("''", "'")
    if re.fullmatch(r"[+-]?\d+", text):
        return int(text)
    if re.fullmatch(r"[+-]?(?:\d+\.\d*|\.\d+)(?:[eE][+-]?\d+)?", text):
        return float(text)
    return text


def _fallback_yaml_load(text: str) -> Any:
    """Minimal indentation-based YAML parser for maps, lists, and scalars."""
    lines: list[tuple[int, str]] = []
    for raw_line in text.lstrip("\ufeff").splitlines():
        cleaned = _strip_comment(raw_line)
        if not cleaned.strip():
            continue
        indent = len(cleaned) - len(cleaned.lstrip(" "))
        lines.append((indent, cleaned.strip()))
    if not lines:
        return {}

    def parse_block(start: int, base_indent: int) -> tuple[Any, int]:
        if lines[start][1].startswith("- ") or lines[start][1] == "-":
            items: list[Any] = []
            idx = start
            while idx < len(lines) and lines[idx][0] == base_indent and (lines[idx][1].startswith("- ") or lines[idx][1] == "-"):
                rest = lines[idx][1][1:].strip()
                idx += 1
                if rest:
                    items.append(_parse_scalar(rest))
                elif idx < len(lines) and lines[idx][0] > base_indent:
                    child, idx = parse_block(idx, lines[idx][0])
                    items.append(child)
                else:
                    items.append(None)
            return items, idx

        mapping: dict[str, Any] = {}
        idx = start
        while idx < len(lines) and lines[idx][0] == base_indent:
            content = lines[idx][1]
            if ":" not in content:
                raise ValueError(f"Invalid YAML line: {content!r}")
            key_raw, _, value_raw = content.partition(":")
            key = str(_parse_scalar(key_raw.strip()))
            value_str = value_raw.strip()
            idx += 1
            if value_str:
                mapping[key] = _parse_scalar(value_str)
            elif idx < len(lines) and lines[idx][0] > base_indent:
                child, idx = parse_block(idx, lines[idx][0])
                mapping[key] = child
            else:
                mapping[key] = None
        return mapping, idx

    parsed, _ = parse_block(0, lines[0][0])
    return parsed


def load_yaml_file(path: Path) -> dict[str, Any]:
    text = path.read_text(encoding="utf-8")
    if path.suffix.lower() == ".json":
        data = json.loads(text)
    else:
        try:
            import yaml  # type: ignore

            data = yaml.safe_load(text)
        except ImportError:
            data = _fallback_yaml_load(text)
    if not isinstance(data, dict):
        raise ValueError(f"Config file must define a top-level mapping: {path}")
    return data


def _expand_env(value: Any) -> Any:
    if isinstance(value, str):
        def replace(match: re.Match[str]) -> str:
            var = match.group(1)
            env_val = os.environ.get(var)
            if env_val is None:
                raise ValueError(f"Referenced environment variable ${{{var}}} is not set")
            return env_val

        return _ENV_PATTERN.sub(replace, value)
    if isinstance(value, dict):
        return {k: _expand_env(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_expand_env(v) for v in value]
    return value


def _resolve_path(value: Any, base_dir: Path) -> Path | None:
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    candidate = Path(text).expanduser()
    return candidate.resolve() if candidate.is_absolute() else (base_dir / candidate).resolve()


def _positive_int(value: Any, name: str, default: int, minimum: int = 1) -> int:
    if value is None:
        return default
    if isinstance(value, bool) or not isinstance(value, int) or value < minimum:
        raise ValueError(f"{name} must be an integer >= {minimum}")
    return value


def _thinking(value: Any, name: str, default: str) -> str:
    if value is None:
        return default
    text = str(value).strip()
    if text not in THINKING_LEVELS:
        raise ValueError(f"{name} must be one of {', '.join(THINKING_LEVELS)}")
    return text


def _validate_url(url: str) -> str:
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise ValueError(f"api.base_url must be a valid http(s) URL, got: {url!r}")
    return url.rstrip("/")


def load_config(
    source: str | Path | dict[str, Any],
    *,
    require_api: bool = True,
    base_dir: Path | None = None,
) -> EvalConfig:
    """Load and validate config.yaml (or an in-memory dict)."""
    config_path: Path | None = None
    if isinstance(source, (str, Path)):
        config_path = Path(source).expanduser().resolve()
        if not config_path.is_file():
            raise FileNotFoundError(f"Config file not found: {config_path}")
        raw = load_yaml_file(config_path)
        anchor = config_path.parent
    elif isinstance(source, dict):
        raw = source
        anchor = (base_dir or Path.cwd()).resolve()
    else:
        raise TypeError("source must be a file path or dict")

    data = _expand_env(raw)

    # Support both concise (`input: path`, `output: path`) and nested forms.
    raw_input_node = data.get("input")
    raw_output_node = data.get("output")
    prepare_raw = data.get("prepare") if isinstance(data.get("prepare"), dict) else {}
    exec_raw = data.get("execution") if isinstance(data.get("execution"), dict) else {}

    input_str = raw_input_node.get("path") if isinstance(raw_input_node, dict) else raw_input_node
    output_str = raw_output_node.get("path") if isinstance(raw_output_node, dict) else raw_output_node

    input_path = _resolve_path(input_str, anchor)
    output_path = _resolve_path(output_str, anchor)

    if require_api:
        if input_path is None:
            raise ValueError("Missing required config field: input")
        if output_path is None:
            raise ValueError("Missing required config field: output")
        if input_path == output_path:
            raise ValueError("input and output must point to different paths")
    else:
        # Prepare mode can run with only prepare.raw_input + (prepare.output or input).
        input_path = input_path or _resolve_path(prepare_raw.get("output"), anchor) or (anchor / "prepared.jsonl")
        output_path = output_path or (anchor / "eval_output.jsonl")

    api_cfg: ApiConfig | None = None
    api_raw = data.get("api")
    if isinstance(api_raw, dict) and (api_raw.get("base_url") or api_raw.get("model") or require_api):
        base_url_raw = str(api_raw.get("base_url") or "").strip()
        model_raw = str(api_raw.get("model") or "").strip()
        if require_api and not base_url_raw:
            raise ValueError("Missing required config field: api.base_url")
        if require_api and not model_raw:
            raise ValueError("Missing required config field: api.model")
        if base_url_raw:
            base_url_raw = _validate_url(base_url_raw)
        api_key = str(api_raw["api_key"]).strip() if api_raw.get("api_key") is not None else None
        api_key_env = str(api_raw["api_key_env"]).strip() if api_raw.get("api_key_env") is not None else None
        api_cfg = ApiConfig(
            base_url=base_url_raw,
            model=model_raw,
            api_key=api_key or None,
            api_key_env=api_key_env or None,
            thinking=_thinking(api_raw.get("thinking"), "api.thinking", "low"),
            compact_thinking=_thinking(api_raw.get("compact_thinking"), "api.compact_thinking", "off"),
            trace_thinking=_thinking(api_raw.get("trace_thinking"), "api.trace_thinking", "off"),
            context_window=_positive_int(api_raw.get("context_window"), "api.context_window", 524288),
            max_output_tokens=_positive_int(api_raw.get("max_output_tokens"), "api.max_output_tokens", 32768),
            supports_developer_role=api_raw.get("supports_developer_role") if isinstance(api_raw.get("supports_developer_role"), bool) else None,
            supports_explicit_prompt_caching=api_raw.get("supports_explicit_prompt_caching") if isinstance(api_raw.get("supports_explicit_prompt_caching"), bool) else None,
        )
        if require_api:
            api_cfg.resolve_api_key()
    elif require_api:
        raise ValueError("Missing required config section: api")

    default_batch = str(
        prepare_raw.get("default_batch_id")
        or exec_raw.get("default_batch_id")
        or data.get("default_batch_id")
        or "eval"
    ).strip()
    version = str(
        prepare_raw.get("version")
        or exec_raw.get("version")
        or data.get("version")
        or "evaluated_model"
    ).strip()

    prep_raw_input = _resolve_path(
        prepare_raw.get("raw_input") or prepare_raw.get("input") or data.get("raw_input"),
        anchor,
    )
    prep_output = _resolve_path(prepare_raw.get("output"), anchor) or input_path
    prep_audit = _resolve_path(prepare_raw.get("audit_output") or prepare_raw.get("audit"), anchor)
    prepare_cfg = PrepareConfig(
        raw_input=prep_raw_input,
        output=prep_output,
        audit_output=prep_audit,
        split_traces=bool(prepare_raw.get("split_traces", True)),
        repair_question=bool(prepare_raw.get("repair_question", True)),
        slim=bool(prepare_raw.get("slim", True)),
        verify_slim=bool(prepare_raw.get("verify_slim", False)),
        default_batch_id=default_batch,
        version=version,
        max_message_bytes=_positive_int(prepare_raw.get("max_message_bytes"), "prepare.max_message_bytes", 2 * 1024 * 1024),
        max_line_bytes=_positive_int(prepare_raw.get("max_line_bytes"), "prepare.max_line_bytes", 128 * 1024 * 1024),
        fail_on_reject=bool(prepare_raw.get("fail_on_reject", False)),
    )

    compact_out = _resolve_path(
        exec_raw.get("compact_output") or (raw_output_node.get("compact_path") if isinstance(raw_output_node, dict) else None),
        anchor,
    )
    eval_audit = _resolve_path(
        exec_raw.get("audit_output") or (raw_output_node.get("audit_path") if isinstance(raw_output_node, dict) else None),
        anchor,
    )
    limit_val = exec_raw.get("limit")
    if limit_val is not None:
        limit_val = _positive_int(limit_val, "execution.limit", 1)

    execution_cfg = ExecutionConfig(
        concurrency=_positive_int(exec_raw.get("concurrency"), "execution.concurrency", 8),
        task_concurrency=_positive_int(exec_raw.get("task_concurrency"), "execution.task_concurrency", 12),
        model_requests=_positive_int(exec_raw.get("model_requests"), "execution.model_requests", 32),
        worker_slots=_positive_int(exec_raw.get("worker_slots"), "execution.worker_slots", 4),
        max_worker_slots=_positive_int(exec_raw.get("max_worker_slots"), "execution.max_worker_slots", 32),
        max_tool_calls=_positive_int(exec_raw.get("max_tool_calls"), "execution.max_tool_calls", 8),
        timeout_seconds=_positive_int(exec_raw.get("timeout_seconds"), "execution.timeout_seconds", 900),
        idle_timeout_seconds=_positive_int(exec_raw.get("idle_timeout_seconds"), "execution.idle_timeout_seconds", 120),
        retries=_positive_int(exec_raw.get("retries"), "execution.retries", 3, minimum=0),
        retry_delay_seconds=_positive_int(exec_raw.get("retry_delay_seconds"), "execution.retry_delay_seconds", 10, minimum=0),
        repair_attempts=_positive_int(exec_raw.get("repair_attempts"), "execution.repair_attempts", 3, minimum=0),
        max_message_bytes=_positive_int(exec_raw.get("max_message_bytes"), "execution.max_message_bytes", 2 * 1024 * 1024),
        max_line_bytes=_positive_int(exec_raw.get("max_line_bytes"), "execution.max_line_bytes", 128 * 1024 * 1024),
        default_batch_id=default_batch,
        version=version,
        limit=limit_val,
        resume=bool(exec_raw.get("resume", True)),
        fail_on_reject=bool(exec_raw.get("fail_on_reject", False)),
        compact_output=compact_out,
        audit_output=eval_audit,
    )

    return EvalConfig(
        input_path=input_path,
        output_path=output_path,
        api=api_cfg,
        prepare=prepare_cfg,
        execution=execution_cfg,
        config_path=config_path,
    )
