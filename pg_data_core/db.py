"""PostgreSQL 16 connection management and versioned SQL migration runner."""

from __future__ import annotations

import hashlib
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

import psycopg
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

from .config import DataCoreConfig

MIGRATIONS_DIR = Path(__file__).resolve().parent / "migrations"


class Database:
    """Thin psycopg v3 connection pool wrapper with migration support."""

    def __init__(self, cfg: DataCoreConfig, *, min_size: int = 1, max_size: int = 16, app_name: str = "aime_data_core"):
        self.cfg = cfg
        self.app_name = app_name
        self._pool = ConnectionPool(
            conninfo=cfg.dsn(app_name=app_name),
            min_size=min_size,
            max_size=max_size,
            open=True,
            kwargs={"row_factory": dict_row, "autocommit": False},
        )

    def close(self) -> None:
        self._pool.close()

    def __enter__(self) -> "Database":
        return self

    def __exit__(self, *_exc) -> None:
        self.close()

    @contextmanager
    def connection(self) -> Iterator[psycopg.Connection]:
        with self._pool.connection() as conn:
            yield conn

    @contextmanager
    def transaction(self) -> Iterator[psycopg.Connection]:
        with self._pool.connection() as conn:
            try:
                yield conn
                conn.commit()
            except Exception:
                conn.rollback()
                raise


def connect_direct(cfg: DataCoreConfig, *, autocommit: bool = False, app_name: str = "aime_cli") -> psycopg.Connection:
    return psycopg.connect(
        cfg.dsn(app_name=app_name),
        autocommit=autocommit,
        row_factory=dict_row,
    )


def apply_migrations(cfg: DataCoreConfig, migrations_dir: Path | None = None) -> list[str]:
    """Apply all unapplied `*.sql` migrations in lexical order (idempotent)."""
    mdir = migrations_dir or MIGRATIONS_DIR
    sql_files = sorted(mdir.glob("*.sql"))
    applied: list[str] = []

    with connect_direct(cfg, autocommit=False, app_name="aime_migrate") as conn:
        # Ensure tracking table exists even before 0001 runs
        conn.execute("CREATE SCHEMA IF NOT EXISTS meta")
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS meta.schema_migrations (
                version TEXT PRIMARY KEY,
                description TEXT NOT NULL,
                checksum TEXT NOT NULL,
                applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
            )
            """
        )
        conn.commit()

        existing = {
            row["version"]: row["checksum"]
            for row in conn.execute("SELECT version, checksum FROM meta.schema_migrations").fetchall()
        }

        for path in sql_files:
            version = path.stem.split("_", 1)[0]
            sql_text = path.read_text(encoding="utf-8")
            checksum = hashlib.sha256(sql_text.encode("utf-8")).hexdigest()[:32]
            if version in existing:
                if existing[version] != checksum:
                    raise RuntimeError(
                        f"Migration {path.name} checksum mismatch: DB={existing[version]} != file={checksum}"
                    )
                continue
            conn.execute(sql_text)
            conn.execute(
                "INSERT INTO meta.schema_migrations(version, description, checksum) VALUES (%s, %s, %s)",
                (version, path.stem, checksum),
            )
            conn.commit()
            applied.append(path.name)

        # Grant privileges cleanly to rw / ro roles if they exist
        for stmt in (
            "GRANT USAGE ON SCHEMA public, meta TO aime_rw, aime_ro",
            "GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO aime_rw",
            "GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO aime_rw",
            "GRANT SELECT ON ALL TABLES IN SCHEMA public TO aime_ro",
            "GRANT SELECT ON ALL TABLES IN SCHEMA meta TO aime_rw, aime_ro",
            "GRANT INSERT, UPDATE ON meta.runtime_kv TO aime_rw",
            "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO aime_rw",
            "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO aime_rw",
            "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO aime_ro",
        ):
            try:
                conn.execute(stmt)
                conn.commit()
            except psycopg.Error:
                conn.rollback()

    return applied


def get_or_init_db_epoch(conn: psycopg.Connection, fallback_epoch: str) -> str:
    row = conn.execute("SELECT value FROM meta.runtime_kv WHERE key = 'db_epoch'").fetchone()
    if row and row["value"]:
        return str(row["value"])
    conn.execute(
        "INSERT INTO meta.runtime_kv(key, value) VALUES ('db_epoch', %s) ON CONFLICT (key) DO NOTHING",
        (fallback_epoch,),
    )
    row2 = conn.execute("SELECT value FROM meta.runtime_kv WHERE key = 'db_epoch'").fetchone()
    return str(row2["value"]) if row2 else fallback_epoch
