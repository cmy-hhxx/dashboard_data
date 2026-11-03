"""运行配置。所有路径与端口都可用环境变量覆盖，默认值面向远端部署。"""

import os
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent

# 数据集根：默认远端挂载，其次是仓库内 datasets/（本地调试）
PRODUCTION_DATASETS = Path("/mnt/fin_bench/code_and_clean_data/datasets")


def datasets_root() -> Path:
    env = os.environ.get("EVAL_DATASETS")
    if env:
        return Path(env).expanduser()
    if PRODUCTION_DATASETS.is_dir():
        return PRODUCTION_DATASETS
    return REPO / "datasets"


# 本服务只服务 AIME 一份数据
AIME_DIR = "1_aime"

# 状态目录：SQLite 索引、缓存、cursor 密钥
STATE_DIR = Path(os.environ.get("ANALYSIS_STATE", str(REPO / "state"))).expanduser()

PORT = int(os.environ.get("PORT", "5003"))
HOST = os.environ.get("HOST", "0.0.0.0")

# 后台重建间隔（秒）：10 分钟一轮，数据延迟控制在 30 分钟以内
REFRESH_SECONDS = int(os.environ.get("REFRESH_SECONDS", "600"))

# cursor 有效期（秒）
CURSOR_TTL = int(os.environ.get("CURSOR_TTL", "1800"))

MAX_USER_IDS = 5000
MAX_TRACE_IDS = 1000
MAX_Q_CHARS = 200
QUERY_PREVIEW_CHARS = 160

API_PREFIX = "/api/v1/analysis"
SCHEMA_VERSION = "1.0"

DATASET = "aime_eval"
DATASET_ALIASES = {"aime_eval"}

# 目录 → 协议 source
SPLIT_TO_SOURCE = {
    "0_daily_eval": "prelaunch",
    "1_lost_user_eval": "feedback",
}
SOURCE_TO_SPLIT = {v: k for k, v in SPLIT_TO_SOURCE.items()}

# 模型目录 → app_version 后缀
MODEL_SUFFIX = {"aime_expert": "expert", "aime_fast": "fast"}

INTENT_TAXONOMY_FILE = REPO / "taxonomy" / "intent_2026-10.json"


def db_path() -> Path:
    return STATE_DIR / "index.sqlite"


def secret_path() -> Path:
    return STATE_DIR / "cursor.key"
