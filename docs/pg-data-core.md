# AIME PostgreSQL 16 + 多帧 Zstd 数据内核

弗吉尼亚实例（`10.217.219.2:2473`）的统一数据存储与索引底座：本地 `/opt/pgdata` 运行单实例 PostgreSQL 16，冷数据以 Append-Only 多帧 Zstd（`.jsonl.zst`，1 record = 1 frame）不可变分包落盘至 `/mnt/aime_eval_ssd/1_aime/`。

## 1. 架构与目录（权威根：`/mnt/aime_eval_ssd/1_aime`）

- **本地 PG 16**：`/opt/pgdata`（`--data-checksums`、`shared_buffers=4GB`、`wal_compression=zstd`、`archive_timeout=60s`），绝不放 CephFS、绝不双写。
- **代码与凭据**：源码 `pg_data_core/`，远端 `/opt/pg_data_core`（同步备份 `.service_backup/pg_data_core/`）；`scram-sha-256` 凭据仅存 `/opt/pg_data_core/.pg_secrets.env`（`600` 权限，备份至 `.service_backup/pg_secrets.env`），`.runtime/pg_endpoint.json` 不含密码。
- **统一消费**：5001 看板（`EVAL_STORAGE_BACKEND=pg`）、5002 详情页、5003 供数与内部评测（`ANALYSIS_BACKEND=pg`、`INTERNAL_EVAL_BACKEND=pg`）全部直连 PG + Zstd `pread`，淘汰 `build.sqlite3`、`samples.pkl`、`index.sqlite`、`stats.json` 等全部冗余索引。

```text
/mnt/aime_eval_ssd/1_aime/
├── README.md         # 目录规范、PG 入口、API 与恢复速查
├── config/           # user_rules.json、releases.json
├── eval_input/       # <model>/<YYYY>/<MMDD>/part_0000.jsonl.zst（≤500 session/包，NY 业务日）
├── eval_output/      # <model>/<YYYY>/<MMDD>/{attribution,compact,human_read}_part_0000.jsonl.zst
├── cluster_tree/     # <model>/{current -> v<ver>_<date>/, v<ver>_<date>/}
├── references/       # Bench 标准答案库预留（<YYYY>/part_0000.jsonl.zst）
├── ab_test/          # <model>/<YYYY>/version_<YYYYMMDD>[_<tag>]/candidate_model_<1..N>/
├── user_kyc/         # 用户 KYC SQLite 模块（摘要同步 PG users 表）
├── .pg_backup/       # 近 3 天压缩 pg_basebackup（base/）+ 60s 压缩 WAL（wal/）
└── .runtime/         # pg_endpoint.json（容器重建自动刷新）
```

## 2. 数据库对象（`public`：18 表 + 3 物化视图；迁移账本在 `meta`）

- **公共底座（3）**：`pack_files`、`users`、`changes`（单调 `seq` + `db_epoch`，驱动 5003 `/changes`）。
- **日常主干（4）**：`eval_inputs`（`(product, model, trace_id)` 唯一、`pg_trgm` GIN、Step 2 租约 + Step 4 分类列）、`eval_outputs`（`is_latest` 保留重评历史）、`eval_problems`（L1–L4 聚类绑定）、`human_read_overlays`（`attribution` + `compact` 增量译文）。
- **聚类 / Bench / 标答（5）**：`cluster_trees`、`cluster_nodes`、`bench_sets`、`bench_items`、`bench_references`。
- **多权重 AB（6）**：`ab_rounds`、`ab_candidates`、`ab_targets`、`ab_candidate_cases`、`ab_candidate_problems`、`ab_run_events`。
- **物化视图（3，5 分钟 `CONCURRENTLY` 刷新）**：`stats_daily_overview`、`stats_daily_intent`、`stats_daily_cluster`。

## 3. 统一写入入口（5003 HTTP + `pg_data_core.writers` CLI）

- **5003 HTTP Data Core**（`http://10.217.219.2:2477/api/v1/data-core/*`）：
  - `GET /health`、`POST /inputs/ingest`、`POST /inputs/claim`、`POST /inputs/category`
  - `POST /outputs/commit`、`POST /problems/cluster`、`POST /human-read`、`POST /reconcile`
  - `GET /detail/<input_id>`（按需 Zstd `pread` 拼接 input + attribution + compact + human_read 增量译文）
- **本地 CLI**（`PYTHONPATH=/opt/pg_data_core python3 -m pg_data_core.writers <cmd>`）：
  - `ingest-inputs`、`export-pending`、`commit-outputs`、`sync-human-read`、`publish-cluster`、`sync-kyc`、`reconcile`

## 4. 运维、对账与容灾命令

```bash
# 部署代码到 /opt/pg_data_core
./pg_data_core/deploy.sh

# 压缩基备 / 隔离演练（:5433 PITR 恢复 + 30 分钟回滚 reconcile_tails 自愈）
bash /opt/pg_data_core/scripts/pg_basebackup.sh
bash /opt/pg_data_core/scripts/dr_drill.sh

# 容器重建后一键恢复 PG 16 + PITR + reconcile_tails + 守护循环
bash /mnt/aime_eval_ssd/.service_backup/pg_data_core/scripts/pg_rebuild_restore.sh
```

## 5. 写铁律与容灾闭环

- **Blob-First**：Data Core 先写多帧 Zstd 并 `fsync` 落盘，再提交 PG 事务更新 `committed_bytes` 与业务行。
- **尾部自愈**：容器重建或回滚后自动执行 `reconcile_tails`，扫描近 1–2 小时活跃分包超过 `committed_bytes` 的完整帧幂等回灌 PG，并释放过期 Step 2 租约。
