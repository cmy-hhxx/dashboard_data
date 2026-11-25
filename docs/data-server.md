# 弗吉尼亚数据服务器（AIME）

AIME 的评测数据、看板（5001）、页面接口（5002）与供数/内部评测接口（5003）均部署在弗吉尼亚容器内。密钥不入库，本机 `~/.ssh/config` 用权限 `600` 私钥 + `ControlMaster` 复用长连接（详见 [dashboard-deployment.md](dashboard-deployment.md)）。

## 1. 主机与端口

- **主机 / SSH**：`10.217.219.2:2473`（`root`，别名 `aime_rsi_data`）；容器名 `interactive-s3ynzadcvm9c`（重建后会变）。
- **服务端口（容器 → 对外 → 目录）**：`5001→2475` 看板 `/opt/eval_dashboard`、`5002→2476` 页面 `/opt/page_service`、`5003→2477` 供数 `/opt/eval_analysis`（挂载 `/opt/internal_eval_service`）、`5004→2478` 预发 `/opt/eval_dashboard_2`、`5005→2479` 备用。
- **守护**：`/opt/eval_supervisor.sh` 按 `/opt/eval_services.conf` 每 30s 探活 `/healthz`，维护时 `touch /opt/eval_supervisor.pause`。

## 2. 数据根 `/mnt/aime_eval_ssd`

所有 AIME 服务统一以 `EVAL_DATASETS=/mnt/aime_eval_ssd`、`EVAL_PRODUCTS=aime` 运行（旧 HDD `/mnt/fin_bench/aime_rsi_data` 已弃用）。

```text
/mnt/aime_eval_ssd/
├── 1_aime/
│   ├── eval_input/0_daily_eval_input/<model>/<date>.jsonl    # 每日评测输入（<model>: aime_expert | aime_fast）
│   ├── eval_output/
│   │   ├── 0_daily_eval/<model>/<model>_attribution-<date>.jsonl       # 归因输出
│   │   ├── 0_daily_eval/<model>/compact/<model>_compact-<date>.jsonl   # 压缩轨迹
│   │   ├── cluster/<model>/{cluster_tree.json,item_index.jsonl,...}    # 聚类树（4.4+）
│   │   └── human_read/                      # 人话译文镜像；外部服务维护，看板只读叠层（勿删）
│   ├── ab_test/<n>_version<MMDD>_test/   # A/B 轮次（round.json / 00_manifest / 01_targets / 02~07 / 99_provenance）
│   ├── user_kyc/                         # 用户 KYC SQLite 库（见 用户KYC库.md）
│   └── stats/<UTC>/                      # backup_stats.py 每小时快照（保留 12 份）
├── 3_dynamic_bench/<model>/tier_<N>.jsonl # 动态抽题库（500/1000/5000/10000）
├── stats.json                            # stats_worker.py 输入统计旁路（加速器，非正确性依赖）
├── user_rules.json                       # 用户类型与流失名单规则
└── 0_litefusion_data/、code/             # 上游原始数据与评测代码（看板不直接读）
```

> 扫描必须跳过非业务目录：`eval_output/0_daily_eval-pre-split-*`、`.archive`、`.runs`、`.delivery`、`.parts`、`.merge`。

> **人话译文**：翻译服务已迁出弗吉尼亚，不再部署 `/opt/human_read_service`；`eval_output/human_read/` 由外部同事的服务持续写入维护。看板 5001 只读该目录（`human_read_overlay.py`），按 sqlite/文件 mtime 自动叠加新译文，无需重启或重新部署。**禁止删除或清理该目录**。

## 3. 核心字段与分类回填

- **评测输入**：顶层含 `request_time`、`batch_id`、`case_id`、`trace_id`、`traces[]`、`meta`；`meta` 含 `session_id`、`user_id`、`question_text`、`task_category`/`subtask_category`、`runtime_mode`、`total_tokens`、`tool_count` 等。
- **归因输出**：`session_meta` + `turns[]`（含 `meta`、`summary`、`problem[]`）；`problem[]` 含 `label`、`definition`、`problem_phenomena`、`reason`、`severity`(P0–P4)、`severity_reason`、`evidence`、`component*`。
- **压缩与聚类**：`compact` 的 `evidence_id` 为整场扁平全局消息下标；`cluster_tree.json` 为阶段 → 环节 → 机制 → 模式四层树，`item_index.jsonl` 用 `turn_index/problem_index` 关联。
- **配对口径**：输入与归因按 `(session_id, request_time)` 配对，缺失时按 `trace_id` 回退；不补造缺失内容。

### 补 `task_category` / `subtask_category`（手动按需执行）

上游埋点位于 `0_litefusion_data/online_data/<Y>/<M>/<D>/category_meta.json`，需要回填时手动执行（幂等，按内容哈希跳过未变文件）：

```bash
ssh aime_rsi_data 'python3 /mnt/aime_eval_ssd/code/3_scripts/backfill_category.py --local'
# 本机触发：python3 scripts/aime_backfill_category.py [--dry-run | --force]
```

关键口径：索引取全日期并集；输入侧取顶层 `trace_id`（旧行 `meta.trace_id` 为 `thread_xxx`）；归因侧只按本行 `turns` 覆盖的 trace 判定，查不到保持 `null`；写完须同步更新 `1_slim_publish/state/state.sqlite3` 中对应文件的 `(size, mtime, offset)`，避免重复扫描。

## 4. 构建缓存与运维约定

- **进程与锁**：`/opt/eval_dashboard` 由 `start.sh` 拉起 `server.py`、`stats_worker.py`、`backup_stats.py`；定时刷新默认 600s，通过 `cache/build.lock` 互斥排队；超时 1800s 自动中止 worker 进程组。
- **增量与详情**：`cache/build.sqlite3` 按 `(size, mtime_ns)` + `files.tail`（旧 committed 前 64 KB 哈希）区分追加与原地重写；`static/samples/` 与 `static/ab_samples/` 按需生成并缓存，可安全删除再生；删除 `cache/` 会触发全量重建。
- **版本升级**：改 detail 结构 bump `build_store.BUILD_VERSION`，改聚合 payload bump `build.py.PAYLOAD_VERSION`。

## 5. 常见坑

- **容器重置缺 `tzdata`**：新容器无 `/usr/share/zoneinfo`，`America/New_York` 会抛 `ZoneInfoNotFoundError`；执行 `pip install tzdata` 后重启（`deploy.sh` 已自动探测）。
- **Ceph 元数据慢与 mtime 精度**：不要在请求线程 `rglob`；判断文件新鲜度须留 10 ms 余量避开粗粒度时钟 tick。
- **问句字段漂移**：归因 `session_meta` 存在 `question` 与 `question_text` 混写，解析必须用 `question or question_text`。
- **5003 重扫单文件**：修改入库解析逻辑后只删 `DELETE FROM files WHERE kind='attribution' AND path IN (...)` 并重启，禁止清空 `traces`（会破坏 `/changes` 变更流位点）。
- **版本核对**：远端无 git 元数据，判断线上代码版本请直接比对文件哈希。
