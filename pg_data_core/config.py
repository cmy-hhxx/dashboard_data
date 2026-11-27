"""Configuration and runtime endpoint discovery for AIME Data Core.

Secrets (PG passwords) are loaded exclusively from environment variables or a
0600-permission env file (`/opt/pg_data_core/.pg_secrets.env`) and are NEVER
written to `.runtime/pg_endpoint.json` or committed to git.
"""

from __future__ import annotations

import json
import os
import socket
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

DEFAULT_DATA_ROOT = "/mnt/aime_eval_ssd/1_aime"
DEFAULT_SECRETS_FILE = "/opt/pg_data_core/.pg_secrets.env"
DEFAULT_PGDATA = "/opt/pgdata"


def _parse_env_file(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.is_file():
        return values
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[len("export ") :].strip()
        if "=" not in line:
            continue
        key, val = line.split("=", 1)
        key = key.strip()
        val = val.strip()
        if len(val) >= 2 and val[0] == val[-1] and val[0] in ("'", '"'):
            val = val[1:-1]
        values[key] = val
    return values


@dataclass(frozen=True)
class DataCoreConfig:
    data_root: Path
    pg_host: str
    pg_port: int
    pg_database: str
    pg_user: str
    pg_password: str
    pgdata: Path
    db_epoch: str
    zstd_level: int = 6
    max_sessions_per_part: int = 500
    product: str = "aime"

    @property
    def runtime_dir(self) -> Path:
        return self.data_root / ".runtime"

    @property
    def endpoint_path(self) -> Path:
        return self.runtime_dir / "pg_endpoint.json"

    @property
    def backup_dir(self) -> Path:
        return self.data_root / ".pg_backup"

    def dsn(self, *, user: str | None = None, password: str | None = None, app_name: str = "aime_data_core") -> str:
        u = user or self.pg_user
        p = password if password is not None else self.pg_password
        return (
            f"host={self.pg_host} port={self.pg_port} dbname={self.pg_database} "
            f"user={u} password={p} application_name={app_name}"
        )


def read_endpoint_json(data_root: Path) -> dict[str, Any]:
    ep = data_root / ".runtime" / "pg_endpoint.json"
    if not ep.is_file():
        return {}
    try:
        data = json.loads(ep.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def write_endpoint_json(
    data_root: Path,
    *,
    host: str,
    port: int,
    database: str,
    db_epoch: str,
    pg_version: str = "16",
) -> Path:
    """Atomically refresh `.runtime/pg_endpoint.json` (zero credentials)."""
    runtime_dir = data_root / ".runtime"
    runtime_dir.mkdir(parents=True, exist_ok=True)
    ep = runtime_dir / "pg_endpoint.json"
    tmp = runtime_dir / f".pg_endpoint.{os.getpid()}.tmp"
    payload = {
        "host": host,
        "hostname": socket.gethostname(),
        "port": int(port),
        "database": database,
        "db_epoch": db_epoch,
        "pg_version": pg_version,
        "data_root": str(data_root),
        "updated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(tmp, ep)
    return ep


def load_config(
    *,
    role: str = "rw",
    data_root: str | Path | None = None,
    secrets_file: str | Path | None = None,
) -> DataCoreConfig:
    """Resolve config from explicit args > env vars > secrets file > endpoint json."""
    sec_path = Path(secrets_file or os.environ.get("AIME_PG_SECRETS_FILE") or DEFAULT_SECRETS_FILE)
    sec = _parse_env_file(sec_path)

    def get(key: str, default: str = "") -> str:
        return os.environ.get(key) or sec.get(key) or default

    root = Path(data_root or get("AIME_DATA_ROOT", DEFAULT_DATA_ROOT))
    ep = read_endpoint_json(root)

    host = get("AIME_PG_HOST") or str(ep.get("host") or "127.0.0.1")
    port = int(get("AIME_PG_PORT") or ep.get("port") or 5432)
    database = get("AIME_PG_DATABASE") or str(ep.get("database") or "aime_eval")
    pgdata = Path(get("AIME_PGDATA", DEFAULT_PGDATA))
    db_epoch = get("AIME_DB_EPOCH") or str(ep.get("db_epoch") or "") or uuid.uuid4().hex[:16]

    role_norm = role.lower()
    if role_norm == "admin":
        user = get("AIME_PG_ADMIN_USER", "aime_admin")
        password = get("AIME_PG_ADMIN_PASSWORD")
    elif role_norm == "ro":
        user = get("AIME_PG_RO_USER", "aime_ro")
        password = get("AIME_PG_RO_PASSWORD")
    else:
        user = get("AIME_PG_RW_USER", "aime_rw")
        password = get("AIME_PG_RW_PASSWORD")

    if not password:
        user = get("AIME_PG_USER", user)
        password = get("AIME_PG_PASSWORD", "")

    zstd_level = int(get("AIME_ZSTD_LEVEL", "6"))
    max_sessions = int(get("AIME_MAX_SESSIONS_PER_PART", "500"))

    return DataCoreConfig(
        data_root=root,
        pg_host=host,
        pg_port=port,
        pg_database=database,
        pg_user=user,
        pg_password=password,
        pgdata=pgdata,
        db_epoch=db_epoch,
        zstd_level=zstd_level,
        max_sessions_per_part=max_sessions,
    )
