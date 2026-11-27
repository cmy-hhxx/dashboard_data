"""Runtime configuration for the internal evaluation & clustering service.

Gateway URL, model IDs, and API keys are converged server-side via environment
variables or an untracked env file (never committed to Git and never chosen by
external callers).
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Mapping

PACKAGE_ROOT = Path(__file__).resolve().parent.parent
VENDOR_DIR = PACKAGE_ROOT / "vendor"
EVAL_HARNESS_VENDOR_DIR = VENDOR_DIR / "eval_harness_pkg"
CLUSTER_PKG_VENDOR_DIR = VENDOR_DIR / "cluster_pkg"
DOCS_DIR = PACKAGE_ROOT / "docs"

ALLOWED_TIERS = (500, 1000, 5000, 10000)
ALLOWED_MODELS = ("aime_expert", "aime_fast")
ALLOWED_SIDES = ("before", "after")
SEVERITY_ORDER = ("P0", "P1", "P2", "P3", "P4", "GOLD")
SEVERITY_RANK = {"P0": 0, "P1": 1, "P2": 2, "P3": 3, "P4": 4, "GOLD": 5}


def _normalize_gateway_url(raw: str) -> str:
    url = (raw or "").strip().rstrip("/")
    if not url:
        return "http://10.217.220.51/ai-gateway/v1"
    if url.endswith("/responses"):
        url = url[: -len("/responses")].rstrip("/")
    if not url.endswith("/v1"):
        url = url + "/v1"
    return url


def _normalize_task_manager_url(raw: str) -> str:
    url = (raw or "").strip().rstrip("/")
    if not url:
        return ""
    if not url.endswith("/api/v1/task"):
        if url.endswith("/api/v1"):
            url = url + "/task"
        elif "/api/v1/task" not in url:
            url = url + "/api/v1/task"
    return url.rstrip("/")


def _load_env_file(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.is_file():
        return values
    for raw_line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[len("export "):].strip()
        if "=" not in line:
            continue
        key, _, val = line.partition("=")
        key = key.strip()
        val = val.strip()
        if len(val) >= 2 and val[0] == val[-1] and val[0] in ("'", '"'):
            val = val[1:-1]
        if key:
            values[key] = val
    return values


def _as_bool(value: str | None, default: bool) -> bool:
    if value is None or value == "":
        return default
    return value.strip().lower() in ("1", "true", "yes", "on")


def _as_int(value: str | None, default: int, minimum: int = 0) -> int:
    if value is None or value == "":
        return default
    try:
        parsed = int(value.strip())
    except ValueError:
        return default
    return max(minimum, parsed)


def _as_float(value: str | None, default: float, minimum: float = 0.0) -> float:
    if value is None or value == "":
        return default
    try:
        parsed = float(value.strip())
    except ValueError:
        return default
    return max(minimum, parsed)


def _parse_api_tokens(single_token: str = "", multi_tokens: str = "") -> tuple[tuple[str, str], ...]:
    """Parse named/unnamed access tokens from `INTERNAL_EVAL_API_TOKENS` & `INTERNAL_EVAL_API_TOKEN`.

    Format for `INTERNAL_EVAL_API_TOKENS`: comma/semicolon/newline-separated items,
    each either `caller_name:token` or `token`.
    """
    entries: list[tuple[str, str]] = []
    seen_tokens: set[str] = set()
    unnamed_idx = 0

    for chunk in (multi_tokens or "").replace("\n", ",").replace(";", ",").split(","):
        raw = chunk.strip()
        if not raw:
            continue
        if ":" in raw:
            name_part, _, tok_part = raw.partition(":")
            name = name_part.strip()
            token = tok_part.strip()
            if not name:
                unnamed_idx += 1
                name = f"token_{unnamed_idx}"
        else:
            unnamed_idx += 1
            name = f"token_{unnamed_idx}"
            token = raw
        if not token or token in seen_tokens:
            continue
        seen_tokens.add(token)
        entries.append((name, token))

    single = (single_token or "").strip()
    if single and single not in seen_tokens:
        seen_tokens.add(single)
        entries.append(("default", single))

    return tuple(entries)


@dataclass(frozen=True)
class ServiceConfig:
    datasets_root: Path
    ab_test_root: Path
    bench_root: Path
    state_db_path: Path
    base_taxonomy_dir: Path
    docs_dir: Path = DOCS_DIR

    # Converged LLM gateway settings (never exposed to callers)
    gateway_base_url: str = "http://10.217.220.51/ai-gateway/v1"
    gateway_api_key: str = ""

    # Eval harness defaults
    eval_model: str = "deepseek-v4.1-flash"
    eval_thinking: str = "low"
    eval_compact_thinking: str = "off"
    eval_trace_thinking: str = "off"
    eval_concurrency: int = 8
    eval_task_concurrency: int = 12
    eval_model_requests: int = 32
    eval_worker_slots: int = 4
    eval_timeout_seconds: int = 900
    eval_idle_timeout_seconds: int = 120
    eval_retries: int = 3

    # Cluster engine defaults
    cluster_model: str = "deepseek-v4.1-flash"
    cluster_reasoning_effort: str = "none"
    cluster_concurrency: int = 8
    cluster_microbatch_size: int = 15
    cluster_microbatch_interval_sec: float = 25.0
    cluster_final_auto_leaf: bool = True
    cluster_l4_enabled: bool = True

    # Human-read translation defaults
    human_read_enabled: bool = True
    human_read_model: str = ""
    human_read_api: str = "openai-completions"
    human_read_workers: int = 8

    # Colleague trace collector settings
    collector_mode: str = "file_drop"  # file_drop | http | task_manager | mock
    collector_base_url: str = ""
    collector_token: str = ""
    collector_dispatch_split: str = "by_side"  # by_side | by_turn | both
    collector_silence_timeout_sec: float = 1800.0
    collector_poll_interval_sec: float = 2.0

    # TaskManager inference API settings (`collector_mode = "task_manager"`)
    task_manager_base_url: str = ""
    task_manager_user_id: str = ""
    task_manager_template_task_id: str = "2740e85cb7b34909"
    task_manager_concurrency: int = 10
    task_manager_batch_size: int = 100
    task_manager_poll_interval_sec: float = 10.0
    task_manager_recovery_interval_sec: float = 900.0
    task_manager_max_recovery_rounds: int = 10
    task_manager_retry_recall_wait_sec: int = 60
    task_manager_max_history_turns: int = 0
    task_manager_judge_source: str = "drop_dir"  # drop_dir | auto | api
    task_manager_drop_wait_timeout_sec: float = 3600.0
    task_manager_drop_root: Path | None = None

    # Orchestrator & HTTP API settings
    max_concurrent_runs: int = 1
    max_queued_runs: int = 0
    auto_resume_on_startup: bool = True
    api_prefix: str = "/api/v1/internal-eval"
    schema_version: str = "1.0"
    api_write_token: str = ""
    api_tokens: tuple[tuple[str, str], ...] = ()
    auth_mode: str = "all"  # all | write_only
    page_base_url: str = ""
    host: str = "0.0.0.0"
    port: int = 5003
    max_inflight: int = 32
    max_inflight_per_caller: int = 4
    rate_limit_per_minute: int = 60
    rate_limit_window_sec: float = 60.0
    gzip_min_bytes: int = 1024
    allow_custom_tier: bool = False
    webhook_timeout_sec: float = 10.0
    webhook_retries: int = 3
    eval_poll_interval_sec: float = 1.5
    allowed_tiers: tuple[int, ...] = field(default_factory=lambda: ALLOWED_TIERS)
    allowed_models: tuple[str, ...] = field(default_factory=lambda: ALLOWED_MODELS)

    def resolved_api_tokens(self) -> tuple[tuple[str, str], ...]:
        """Return deduplicated `(caller_name, token)` pairs without mutating config."""
        entries: list[tuple[str, str]] = []
        seen: set[str] = set()
        for name, tok in self.api_tokens:
            clean_tok = (tok or "").strip()
            clean_name = (name or "caller").strip() or "caller"
            if clean_tok and clean_tok not in seen:
                seen.add(clean_tok)
                entries.append((clean_name, clean_tok))
        single = (self.api_write_token or "").strip()
        if single and single not in seen:
            entries.append(("default", single))
        return tuple(entries)

    def public_summary(self) -> dict[str, object]:
        """Safe runtime summary with zero secret leakage."""
        tokens = self.resolved_api_tokens()
        return {
            "api_prefix": self.api_prefix,
            "schema_version": self.schema_version,
            "ab_test_root": str(self.ab_test_root),
            "bench_root": str(self.bench_root),
            "state_db_path": str(self.state_db_path),
            "collector_mode": self.collector_mode,
            "collector_dispatch_split": self.collector_dispatch_split,
            "human_read_enabled": self.human_read_enabled,
            "task_manager_base_url": self.task_manager_base_url or None,
            "task_manager_auth_configured": bool(self.task_manager_user_id),
            "task_manager_template_task_id": self.task_manager_template_task_id or None,
            "task_manager_recovery_interval_sec": self.task_manager_recovery_interval_sec,
            "task_manager_max_recovery_rounds": self.task_manager_max_recovery_rounds,
            "task_manager_judge_source": self.task_manager_judge_source,
            "task_manager_drop_wait_timeout_sec": self.task_manager_drop_wait_timeout_sec,
            "task_manager_drop_root": str(self.task_manager_drop_root) if self.task_manager_drop_root else None,
            "max_concurrent_runs": self.max_concurrent_runs,
            "max_queued_runs": self.max_queued_runs,
            "auth_enabled": bool(tokens),
            "auth_mode": self.auth_mode,
            "auth_token_count": len(tokens),
            "write_auth_enabled": bool(tokens),
            "max_inflight": self.max_inflight,
            "max_inflight_per_caller": self.max_inflight_per_caller,
            "rate_limit_per_minute": self.rate_limit_per_minute,
            "gateway_configured": bool(self.gateway_api_key),
            "allowed_tiers": list(self.allowed_tiers),
            "allowed_models": list(self.allowed_models),
        }


def load_config(
    env: Mapping[str, str] | None = None,
    env_file: str | Path | None = None,
) -> ServiceConfig:
    merged: dict[str, str] = {}

    candidate_env_files: list[Path] = []
    if env_file is not None:
        candidate_env_files.append(Path(env_file).expanduser())
    else:
        env_file_from_os = (env or os.environ).get("INTERNAL_EVAL_ENV_FILE")
        if env_file_from_os:
            candidate_env_files.append(Path(env_file_from_os).expanduser())
        for default_file in (
            PACKAGE_ROOT / "internal_eval.env",
            Path("/opt/eval_analysis/internal_eval.env"),
            Path("/opt/internal_eval_service/internal_eval.env"),
        ):
            if default_file.is_file():
                candidate_env_files.append(default_file)

    for path in candidate_env_files:
        merged.update(_load_env_file(path))

    source = dict(os.environ) if env is None else dict(env)
    merged.update(source)

    def get(key: str, default: str = "") -> str:
        val = merged.get(key)
        return default if val is None or val == "" else val

    datasets_raw = get("EVAL_DATASETS")
    if datasets_raw:
        datasets_root = Path(datasets_raw).expanduser()
    elif Path("/mnt/aime_eval_ssd").is_dir():
        datasets_root = Path("/mnt/aime_eval_ssd")
    else:
        datasets_root = PACKAGE_ROOT.parent.parent / "datasets"

    pg_mode = get("INTERNAL_EVAL_BACKEND").lower() in ("pg", "postgres", "postgresql")
    default_ab_root = (
        "/opt/internal_eval_service/work_ab"
        if pg_mode
        else str(datasets_root / "1_aime" / "ab_test")
    )
    ab_test_root = Path(
        get("INTERNAL_EVAL_AB_TEST_ROOT", default_ab_root)
    ).expanduser()
    bench_root = Path(
        get("INTERNAL_EVAL_BENCH_ROOT", str(datasets_root / "3_dynamic_bench"))
    ).expanduser()
    default_state_db = (
        "/opt/internal_eval_service/state/internal_eval.sqlite3"
        if pg_mode
        else str(ab_test_root / ".service_state" / "internal_eval.sqlite3")
    )
    state_db_path = Path(
        get("INTERNAL_EVAL_STATE_DB", default_state_db)
    ).expanduser()

    tax_raw = get("INTERNAL_EVAL_TAXONOMY_DIR")
    if tax_raw:
        base_taxonomy_dir = Path(tax_raw).expanduser()
    else:
        prod_tax = datasets_root / "code" / "2_cluster_algorithm" / "taxonomy"
        base_taxonomy_dir = (
            prod_tax if prod_tax.is_dir() else CLUSTER_PKG_VENDOR_DIR / "builtin_taxonomy"
        )

    gateway_base_url = _normalize_gateway_url(
        get("INTERNAL_EVAL_GATEWAY_BASE_URL", "http://10.217.220.51/ai-gateway/v1")
    )
    gateway_api_key = (
        get("INTERNAL_EVAL_GATEWAY_API_KEY")
        or get("EVAL_GATEWAY_API_KEY")
        or get("OPENAI_API_KEY")
    )

    judge_source_raw = get("INTERNAL_EVAL_TASK_MANAGER_JUDGE_SOURCE", "drop_dir").strip().lower()
    judge_source = judge_source_raw if judge_source_raw in ("auto", "api", "drop_dir") else "drop_dir"
    tpl_task_raw = merged.get("INTERNAL_EVAL_TASK_MANAGER_TEMPLATE_TASK_ID")
    template_task_id = "2740e85cb7b34909" if tpl_task_raw is None else str(tpl_task_raw).strip()
    api_write_token = get("INTERNAL_EVAL_API_TOKEN")
    api_tokens = _parse_api_tokens(api_write_token, get("INTERNAL_EVAL_API_TOKENS"))
    auth_mode_raw = get("INTERNAL_EVAL_AUTH_MODE", "all").strip().lower()
    auth_mode = auth_mode_raw if auth_mode_raw in ("all", "write_only") else "all"

    return ServiceConfig(
        datasets_root=datasets_root,
        ab_test_root=ab_test_root,
        bench_root=bench_root,
        state_db_path=state_db_path,
        base_taxonomy_dir=base_taxonomy_dir,
        docs_dir=DOCS_DIR,
        gateway_base_url=gateway_base_url,
        gateway_api_key=gateway_api_key,
        eval_model=get("INTERNAL_EVAL_MODEL", "deepseek-v4.1-flash"),
        eval_thinking=get("INTERNAL_EVAL_THINKING", "low"),
        eval_compact_thinking=get("INTERNAL_EVAL_COMPACT_THINKING", "off"),
        eval_trace_thinking=get("INTERNAL_EVAL_TRACE_THINKING", "off"),
        eval_concurrency=_as_int(merged.get("INTERNAL_EVAL_CONCURRENCY"), 8, minimum=1),
        eval_task_concurrency=_as_int(merged.get("INTERNAL_EVAL_TASK_CONCURRENCY"), 12, minimum=1),
        eval_model_requests=_as_int(merged.get("INTERNAL_EVAL_MODEL_REQUESTS"), 32, minimum=1),
        eval_worker_slots=_as_int(merged.get("INTERNAL_EVAL_WORKER_SLOTS"), 4, minimum=1),
        eval_timeout_seconds=_as_int(merged.get("INTERNAL_EVAL_TIMEOUT_SECONDS"), 900, minimum=30),
        eval_idle_timeout_seconds=_as_int(merged.get("INTERNAL_EVAL_IDLE_TIMEOUT_SECONDS"), 120, minimum=10),
        eval_retries=_as_int(merged.get("INTERNAL_EVAL_RETRIES"), 3, minimum=0),
        cluster_model=get("INTERNAL_EVAL_CLUSTER_MODEL", "deepseek-v4.1-flash"),
        cluster_reasoning_effort=get("INTERNAL_EVAL_CLUSTER_REASONING", "none"),
        cluster_concurrency=_as_int(merged.get("INTERNAL_EVAL_CLUSTER_CONCURRENCY"), 8, minimum=1),
        cluster_microbatch_size=_as_int(merged.get("INTERNAL_EVAL_CLUSTER_BATCH_SIZE"), 15, minimum=1),
        cluster_microbatch_interval_sec=_as_float(merged.get("INTERNAL_EVAL_CLUSTER_INTERVAL_SEC"), 25.0, minimum=0.1),
        cluster_final_auto_leaf=_as_bool(merged.get("INTERNAL_EVAL_CLUSTER_FINAL_AUTO_LEAF"), True),
        cluster_l4_enabled=_as_bool(merged.get("INTERNAL_EVAL_CLUSTER_L4_ENABLED"), True),
        human_read_enabled=_as_bool(merged.get("INTERNAL_EVAL_HUMAN_READ_ENABLED"), True),
        human_read_model=get("INTERNAL_EVAL_HUMAN_READ_MODEL"),
        human_read_api=get("INTERNAL_EVAL_HUMAN_READ_API", "openai-completions"),
        human_read_workers=_as_int(merged.get("INTERNAL_EVAL_HUMAN_READ_WORKERS"), 8, minimum=1),
        collector_mode=get("INTERNAL_EVAL_COLLECTOR_MODE", "file_drop").lower(),
        collector_base_url=get("INTERNAL_EVAL_COLLECTOR_BASE_URL").rstrip("/"),
        collector_token=get("INTERNAL_EVAL_COLLECTOR_TOKEN"),
        collector_dispatch_split=get("INTERNAL_EVAL_DISPATCH_SPLIT", "by_side").lower(),
        collector_silence_timeout_sec=_as_float(merged.get("INTERNAL_EVAL_COLLECTOR_SILENCE_TIMEOUT_SEC"), 1800.0, minimum=1.0),
        collector_poll_interval_sec=_as_float(merged.get("INTERNAL_EVAL_COLLECTOR_POLL_INTERVAL_SEC"), 2.0, minimum=0.05),
        task_manager_base_url=_normalize_task_manager_url(
            get("INTERNAL_EVAL_TASK_MANAGER_BASE_URL")
            or (get("INTERNAL_EVAL_COLLECTOR_BASE_URL") if get("INTERNAL_EVAL_COLLECTOR_MODE", "").lower() in ("task_manager", "taskmanager") else "")
        ),
        task_manager_user_id=get("INTERNAL_EVAL_TASK_MANAGER_USER_ID"),
        task_manager_template_task_id=template_task_id,
        task_manager_concurrency=_as_int(merged.get("INTERNAL_EVAL_TASK_MANAGER_CONCURRENCY"), 10, minimum=1),
        task_manager_batch_size=_as_int(merged.get("INTERNAL_EVAL_TASK_MANAGER_BATCH_SIZE"), 100, minimum=1),
        task_manager_poll_interval_sec=_as_float(merged.get("INTERNAL_EVAL_TASK_MANAGER_POLL_INTERVAL_SEC"), 10.0, minimum=0.05),
        task_manager_recovery_interval_sec=_as_float(merged.get("INTERNAL_EVAL_TASK_MANAGER_RECOVERY_INTERVAL_SEC"), 900.0, minimum=0.5),
        task_manager_max_recovery_rounds=_as_int(merged.get("INTERNAL_EVAL_TASK_MANAGER_MAX_RECOVERY_ROUNDS"), 10, minimum=0),
        task_manager_retry_recall_wait_sec=_as_int(merged.get("INTERNAL_EVAL_TASK_MANAGER_RETRY_RECALL_WAIT_SEC"), 60, minimum=1),
        task_manager_max_history_turns=_as_int(merged.get("INTERNAL_EVAL_TASK_MANAGER_MAX_HISTORY_TURNS"), 0, minimum=0),
        task_manager_judge_source=judge_source,
        task_manager_drop_wait_timeout_sec=_as_float(
            merged.get("INTERNAL_EVAL_TASK_MANAGER_DROP_WAIT_TIMEOUT_SEC"), 3600.0, minimum=1.0
        ),
        task_manager_drop_root=(
            Path(get("INTERNAL_EVAL_TASK_MANAGER_DROP_ROOT")).expanduser()
            if get("INTERNAL_EVAL_TASK_MANAGER_DROP_ROOT")
            else None
        ),
        max_concurrent_runs=_as_int(merged.get("INTERNAL_EVAL_MAX_CONCURRENT_RUNS"), 1, minimum=1),
        max_queued_runs=_as_int(merged.get("INTERNAL_EVAL_MAX_QUEUED_RUNS"), 0, minimum=0),
        auto_resume_on_startup=_as_bool(merged.get("INTERNAL_EVAL_AUTO_RESUME"), True),
        api_prefix=get("INTERNAL_EVAL_API_PREFIX", "/api/v1/internal-eval").rstrip("/"),
        api_write_token=api_write_token,
        api_tokens=api_tokens,
        auth_mode=auth_mode,
        page_base_url=get("INTERNAL_EVAL_PAGE_BASE_URL").rstrip("/"),
        host=get("HOST", "0.0.0.0"),
        port=_as_int(merged.get("PORT"), 5003, minimum=1),
        max_inflight=_as_int(merged.get("INTERNAL_EVAL_MAX_INFLIGHT"), 32, minimum=1),
        max_inflight_per_caller=_as_int(merged.get("INTERNAL_EVAL_MAX_INFLIGHT_PER_CALLER"), 4, minimum=1),
        rate_limit_per_minute=_as_int(merged.get("INTERNAL_EVAL_RATE_LIMIT_PER_MINUTE"), 60, minimum=0),
        rate_limit_window_sec=_as_float(merged.get("INTERNAL_EVAL_RATE_LIMIT_WINDOW_SEC"), 60.0, minimum=1.0),
        allow_custom_tier=_as_bool(merged.get("INTERNAL_EVAL_ALLOW_CUSTOM_TIER"), False),
        webhook_timeout_sec=_as_float(merged.get("INTERNAL_EVAL_WEBHOOK_TIMEOUT_SEC"), 10.0, minimum=1.0),
        webhook_retries=_as_int(merged.get("INTERNAL_EVAL_WEBHOOK_RETRIES"), 3, minimum=0),
        eval_poll_interval_sec=_as_float(merged.get("INTERNAL_EVAL_POLL_INTERVAL_SEC"), 1.5, minimum=0.05),
    )
