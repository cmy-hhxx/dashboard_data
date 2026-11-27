# 弗吉尼亚数据服务器（AIME）

AIME 的评测数据、PostgreSQL 16 主库、看板（5001）、页面接口（5002）与供数/内部评测/Data Core 接口（5003）均部署在弗吉尼亚容器内。本机 `~/.ssh/config` 用 `600` 权限私钥 + `ControlMaster` 复用长连接（详见 [dashboard-deployment.md](dashboard-deployment.md)）。

## 1. 主机与端口

- **主机 / SSH**：`10.217.219.2:2473`（`root`，别名 `aime_rsi_data`）；容器名重建后会变。
- **服务端口（容器 → 对外 → 目录）**：`5001→2475` 看板 `/opt/eval_dashboard`、`5002→2476` 页面 `/opt/page_service/sample_details`、`5003→2477` 供数与 Data Core `/opt/eval_analysis`（挂载 `/opt/internal_eval_service`）、`5005→2479` MongoDB 看板、PG 16 本地 `5432`（`/opt/pgdata`）。
- **守护**：`/opt/eval_supervisor.sh` 按 `/opt/eval_services.conf` 每 30s 探活 `/healthz`，并自动保活 `snapshot_loop.sh` 与 `pg_maintenance_loop.sh`；维护时 `touch /opt/eval_supervisor.pause`。

## 2. 数据根 `/mnt/aime_eval_ssd`

所有 AIME 服务以 `EVAL_STORAGE_BACKEND=pg`、`ANALYSIS_BACKEND=pg`、`INTERNAL_EVAL_BACKEND=pg`、`AIME_DATA_ROOT=/mnt/aime_eval_ssd/1_aime`、`EVAL_DATASETS=/mnt/aime_eval_ssd`、`EVAL_PRODUCTS=aime` 运行（数据库内核细节见 [pg-data-core.md](pg-data-core.md)）。

```text
/mnt/aime_eval_ssd/
├── 0_litefusion_data/             # 上游原始日志（只读输入源）
├── 1_aime/                        # AIME 唯一权威冷数据根（多帧 .jsonl.zst，零中间副本）
│   ├── README.md                  # 目录规范与恢复速查
│   ├── config/                    # user_rules.json、releases.json
│   ├── eval_input/<model>/<YYYY>/<MMDD>/part_0000.jsonl.zst
│   ├── eval_output/<model>/<YYYY>/<MMDD>/{attribution,compact,human_read}_part_0000.jsonl.zst
│   ├── cluster_tree/<model>/{current -> v<ver>_<date>/, v<ver>_<date>/}
│   ├── references/<YYYY>/         # Bench 标准答案库预留
│   ├── ab_test/<model>/<YYYY>/version_<YYYYMMDD>[_<tag>]/candidate_model_<1..N>/
│   ├── user_kyc/                  # 用户 KYC SQLite 库（摘要同步 PG users 表，见 用户KYC库.md）
│   ├── .pg_backup/{base,wal}/     # 近 3 天压缩 pg_basebackup + 60s 压缩 WAL
│   └── .runtime/pg_endpoint.json  # PG 16 连接元信息（无密码，重建自动刷新）
├── code/                          # 评测 / 聚类 / 治理脚本
└── .service_backup/               # /opt 服务快照与 pg_data_core / 凭据备份
```

> **人话译文**：外部人话翻译服务通过 `POST http://10.217.219.2:2477/api/v1/data-core/human-read` 增量提交（仅存译文增量字段，不镜像整行）；离线补录可用 `python3 -m pg_data_core.writers sync-human-read`。

## 3. 核心字段与 Step 4 分类回填

- **评测输入**：入库 `eval_inputs` 按 `(product, model, trace_id)` 唯一去重；含 `session_id`、`user_id`、`question_text`、`task_category`/`subtask_category`、`total_tokens`、`tool_count`、`latency_ms`、多帧 Zstd 偏移指针。
- **归因与聚类**：`eval_outputs`（`is_latest` 保留重评历史）+ `eval_problems`（1 条问题 1 行，带 `severity`、`component`、L1–L4 `cluster_code`）；`human_read_overlays` 按 `(output_id, target_kind)` 存增量译文指针。
- **分类回填（上游埋点接口，原位更新 PG）**：

```text
POST http://10.217.216.85:8888/api/v1/proxy/investment-plan/harness/v1/dialog/agent/run/page_list/
{"run_started_at":["<ET 起>","<ET 止>"],"page_num":0,"page_size":1000,"trace_id":[...]}
```

- 时间窗按 **America/New_York 墙钟**（必填、跨度 ≤31 天），一律按 `trace_id` 分批（≤1000/次）查询；只补空值不覆盖已有值，跳过 32 位 hex 老 `trace_id`；写入 `taxonomy_version`（v1 / v1.9）并直接更新 PG `eval_inputs`（零 JSONL 重写）。

```bash
nohup bash /mnt/aime_eval_ssd/code/3_scripts/aime_backfill_category_loop.sh >> /mnt/aime_eval_ssd/code/3_scripts/cache/aime_backfill_category/api_loop.log 2>&1 &
python3 /mnt/aime_eval_ssd/code/3_scripts/aime_backfill_category_api.py --pg --dry-run --limit 20
```

## 4. 构建缓存与运维约定

- **5001 看板**：PG 模式不启用 `stats_worker.py` / `backup_stats.py`，不生成 `build.sqlite3` / `samples.pkl`；由 `pg_backend.py` 按 PG 水位签名复用或重建聚合 JSON（冷构建约 65s，无变化 0.3s 复用），详情页通过多帧 Zstd `pread` 毫秒级按需拼装。
- **5003 供数与内部评测**：`pg_store.py` 直查 PG 16（热启约 8s，零 `index.sqlite`）；`internal_eval` 本地临时工作区在 `/opt/internal_eval_service/work_ab`，完成后打包多帧 Zstd 发布到 `1_aime/ab_test/` 并落库 PG 6 张 AB 表。
- **版本升级**：改 detail 结构 bump `pg_backend.PG_BACKEND_VERSION`，改聚合 payload bump `build.py.PAYLOAD_VERSION`。

## 5. 常见坑

- **PGDATA 铁律**：`/opt/pgdata` 必须在容器本地盘，严禁迁至 CephFS。
- **容器重置缺 `tzdata`**：`America/New_York` 需要 `tzdata`，`deploy.sh` 与 `pg_rebuild_restore.sh` 已自动检测安装。
- **问句字段漂移**：归因 `session_meta` 存在 `question` 与 `question_text` 混写，解析必须用 `question or question_text`。
- **版本核对**：远端无 git 元数据，核对线上代码版本请直接比对文件哈希。
