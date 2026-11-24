"""Configuration, field whitelists, and runtime defaults for human_read_module."""
from __future__ import annotations

import os
from dataclasses import dataclass

PROMPT_VERSION = "v1.3"

DEFAULT_BASE_URL = os.environ.get("HUMAN_READ_BASE_URL", "http://10.217.220.51/ai-gateway")
# 网关 key 只走环境变量：本仓库会公开镜像到 GitHub，key 不落代码。
DEFAULT_API_KEY = os.environ.get("HUMAN_READ_API_KEY", "")
DEFAULT_MODEL = os.environ.get("HUMAN_READ_MODEL", "deepseek-v4.1-flash")

# Whitelisted attribution problem fields to translate.
# Frozen fields (NEVER touched): severity, evidence, component, component_family,
# component_role, calculations, definition, etc.
ATTR_PROBLEM_FIELDS = (
    "label",
    "problem_phenomena",
    "reason",
    "severity_reason",
)

# Whitelisted compact turn list fields: (list_key, text_field_key, chinese_stage_name)
COMPACT_LIST_SPECS = (
    ("plans", "content", "规划"),
    ("reasoning_chain", "content", "推理"),
    ("execution_chain", "content", "执行"),
    ("reflections", "reflection_content", "反思"),
    ("tool_errors", "tool_error_content", "报错"),
    ("artifacts", "artifacts_content", "产物"),
    ("components", "components_content", "组件概览"),
)


@dataclass
class GatewayConfig:
    base_url: str = DEFAULT_BASE_URL
    api_key: str = DEFAULT_API_KEY
    model: str = DEFAULT_MODEL
    timeout_s: float = 180.0
    max_retries: int = 8
    temperature: float = 0.15
    max_tokens: int = 16384
    problem_batch_size: int = 3
    compact_batch_size: int = 12
    target_rpm: int = 40

    def __post_init__(self):
        if not self.api_key:
            raise RuntimeError(
                "HUMAN_READ_API_KEY 未设置：请在 /opt/human_read_service/human_read.env "
                "或环境变量里提供网关 key"
            )
