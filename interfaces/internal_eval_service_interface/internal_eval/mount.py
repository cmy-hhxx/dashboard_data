"""Mount helper used by `eval_data_interface` (port 5003) to attach `/api/v1/internal-eval/*`."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from .api import InternalEvalApp, create_app
from .config import load_config


def build_mounted_app(*, log=print) -> InternalEvalApp | None:
    """Create and start the mounted InternalEvalApp when enabled on port 5003.

    Enabled automatically when `ANALYSIS_DATASET` is `aime_eval` (default) unless
    explicitly disabled via `INTERNAL_EVAL_ENABLED=0`.
    """
    explicit = os.environ.get("INTERNAL_EVAL_ENABLED", "").strip().lower()
    if explicit in ("0", "false", "no", "off"):
        return None
    dataset = os.environ.get("ANALYSIS_DATASET", "aime_eval").strip()
    if explicit not in ("1", "true", "yes", "on") and dataset != "aime_eval":
        return None

    env_file = os.environ.get("INTERNAL_EVAL_ENV_FILE")
    cfg = load_config(env_file=Path(env_file) if env_file else None)
    app = create_app(cfg, start_worker=True)
    log(
        f"[internal-eval] mounted on {cfg.api_prefix} "
        f"(ab_test={cfg.ab_test_root}, collector={cfg.collector_mode}, "
        f"gateway_configured={bool(cfg.gateway_api_key)})"
    )
    return app
