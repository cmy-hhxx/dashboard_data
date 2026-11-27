"""Master ETL Orchestrator: migrates all authoritative legacy AIME data into
AIME_DATA_ROOT (`/mnt/aime_eval_ssd/aime_pg_database`) + PostgreSQL 16.

Usage:
    PYTHONPATH=/opt/pg_data_core python3 -m pg_data_core.etl.migrate_all \
        --legacy-root /mnt/aime_eval_ssd --workers 6
"""

from __future__ import annotations

import argparse
import json
import time
from datetime import datetime, timezone
from pathlib import Path

from ..config import load_config
from ..core import DataCore
from ..db import apply_migrations
from .migrate_ab import migrate_ab_rounds
from .migrate_bench import migrate_benches
from .migrate_cluster import migrate_cluster_trees
from .migrate_daily import migrate_daily_all
from .migrate_users import migrate_users

DATA_ROOT_README = """# AIME 评测数据根（`1_aime` / staging `aime_pg_database`）

AIME 唯一权威冷数据目录：只存 Append-Only 多帧 Zstd（`.jsonl.zst`，1 record = 1 frame）不可变分包、版本化聚类树、轻量配置与 PG 16 容灾备份；全部状态、去重、统计与索引由本机 `/opt/pgdata` 单实例 PostgreSQL 16 承载。

## 目录规范

```text
<AIME_DATA_ROOT>/
├── config/           # user_rules.json、releases.json
├── eval_input/       # <model>/<YYYY>/<MMDD>/part_0000.jsonl.zst（≤500 session/包，NY 业务日）
├── eval_output/      # <model>/<YYYY>/<MMDD>/{attribution,compact,human_read}_part_0000.jsonl.zst
├── cluster_tree/     # <model>/{current -> v<ver>_<date>/, v<ver>_<date>/}
├── references/       # Bench 标准答案库预留目录（<YYYY>/part_0000.jsonl.zst）
├── ab_test/          # <model>/<YYYY>/version_<YYYYMMDD>[_<tag>]/candidate_model_<1..N>/
├── .pg_backup/       # 近 3 天压缩 pg_basebackup（base/）+ 60s 压缩 WAL（wal/）
└── .runtime/         # pg_endpoint.json（无凭据，容器重建自动刷新）与迁移对账报告
```

> `human_read_part_*.jsonl.zst` 仅存 `attribution` / `compact` 的增量译文字段，不镜像整行。

## PostgreSQL 16 入口与权限

- **本地数据目录**：`/opt/pgdata`（严禁放 CephFS）；库名 `aime_eval`，扩展 `pg_trgm`。
- **服务发现**：读 `.runtime/pg_endpoint.json` 获取 `host / port / database / db_epoch`。
- **认证与凭据**：`scram-sha-256`，角色 `aime_admin` / `aime_rw` / `aime_ro` / `aime_backup`，密码仅存 `/opt/pg_data_core/.pg_secrets.env`（`600` 权限，备份在 `.service_backup/pg_secrets.env`）。
- **核心对象**：`public` 下共 18 张基础表 + 3 张物化视图（`stats_daily_overview`、`stats_daily_intent`、`stats_daily_cluster`，分钟级 `CONCURRENTLY` 刷新）。

## 常用运维与灾备命令

```bash
# 1. 初始化/启动 PG 16 并刷新 .runtime/pg_endpoint.json
bash /opt/pg_data_core/scripts/pg_init_cluster.sh

# 2. 手动执行全量压缩基备（默认留 3 天）
bash /opt/pg_data_core/scripts/pg_basebackup.sh

# 3. 容器重建后 PITR 恢复 + 尾部幂等对账（reconcile_tails）
bash /opt/pg_data_core/scripts/pg_restore_pitr.sh /opt/pgdata 5432
source /opt/pg_data_core/.pg_secrets.env
PYTHONPATH=/opt/pg_data_core python3 -c "
from pg_data_core.config import load_config; from pg_data_core.core import DataCore; from pg_data_core.reconcile import reconcile_tails
with DataCore(load_config(role='rw')) as dc: print(reconcile_tails(dc, lookback_minutes=60))
"

# 4. 刷新 3 张分层统计物化视图（不阻塞查询）
PYTHONPATH=/opt/pg_data_core python3 -c "
from pg_data_core.config import load_config; from pg_data_core.core import DataCore
with DataCore(load_config(role='admin')) as dc: print(dc.refresh_stats_views(concurrently=True))
"
```

## 切换为正式 `1_aime/`

库内 `pack_files.rel_path` 等全部为相对路径；验收稳定后归档旧目录、将 `aime_pg_database` 改名为 `1_aime` 并更新 `AIME_DATA_ROOT=/mnt/aime_eval_ssd/1_aime` 即可无缝生效，无需改库。
"""


def main() -> None:
    parser = argparse.ArgumentParser(description="Migrate legacy AIME data into PG 16 + multi-frame Zstd")
    parser.add_argument("--legacy-root", default="/mnt/aime_eval_ssd")
    parser.add_argument("--data-root", default=None)
    parser.add_argument("--workers", type=int, default=6)
    parser.add_argument("--only", default="", help="Comma-separated stages: users,daily,daily_outputs,cluster,bench,ab,views")
    args = parser.parse_args()

    stages = set(s.strip() for s in args.only.split(",") if s.strip()) or {
        "users",
        "daily",
        "cluster",
        "bench",
        "ab",
        "views",
    }

    t_start = time.monotonic()
    admin_cfg = load_config(role="admin", data_root=args.data_root)
    rw_cfg = load_config(role="rw", data_root=args.data_root)
    legacy_root = Path(args.legacy_root)

    # Ensure migrations applied & references placeholder dir exists
    apply_migrations(admin_cfg)
    (admin_cfg.data_root / "references" / "2026").mkdir(parents=True, exist_ok=True)
    (admin_cfg.data_root / "README.md").write_text(DATA_ROOT_README.lstrip(), encoding="utf-8")

    report: dict[str, object] = {
        "started_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "legacy_root": str(legacy_root),
        "data_root": str(admin_cfg.data_root),
        "stages": {},
    }

    if "users" in stages:
        print("[migrate_all] >>> Stage 1: Users & Config", flush=True)
        report["stages"]["users"] = migrate_users(rw_cfg, legacy_root)

    if "daily" in stages:
        print("[migrate_all] >>> Stage 2: Daily Inputs, Outputs & Human-Read Deltas", flush=True)
        report["stages"]["daily"] = migrate_daily_all(rw_cfg, legacy_root, workers=args.workers, outputs_only=False)
    elif "daily_outputs" in stages:
        print("[migrate_all] >>> Stage 2B: Daily Outputs & Human-Read Deltas (keeping existing input packs)", flush=True)
        report["stages"]["daily_outputs"] = migrate_daily_all(rw_cfg, legacy_root, workers=args.workers, outputs_only=True)

    if "cluster" in stages:
        print("[migrate_all] >>> Stage 3: Cluster Trees & Problem Binding", flush=True)
        report["stages"]["cluster"] = migrate_cluster_trees(rw_cfg, legacy_root)

    if "bench" in stages:
        print("[migrate_all] >>> Stage 4: Dynamic Bench Sets & Items", flush=True)
        report["stages"]["bench"] = migrate_benches(rw_cfg, legacy_root)

    if "ab" in stages:
        print("[migrate_all] >>> Stage 5: Multi-Candidate AB Rounds", flush=True)
        report["stages"]["ab"] = migrate_ab_rounds(rw_cfg, legacy_root)

    if "views" in stages:
        print("[migrate_all] >>> Stage 6: Populating 3 Materialized Views & ANALYZE", flush=True)
        with DataCore(admin_cfg) as dc:
            with dc.db.connection() as conn:
                conn.autocommit = True
                conn.execute("ANALYZE")
            report["stages"]["views"] = dc.refresh_stats_views(concurrently=False)

    report["finished_at"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    report["total_elapsed_sec"] = round(time.monotonic() - t_start, 1)

    report_path = admin_cfg.data_root / ".runtime" / "migration_report.json"
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"[migrate_all] DONE in {report['total_elapsed_sec']}s -> {report_path}", flush=True)


if __name__ == "__main__":
    main()
