# eval_data_interface — 对话分析供数接口 v2.0

只读、零第三方依赖（Python 3.12 标准库）的独立进程，提供 `/api/v1/analysis/*` 查询与增量同步，直接输出 trace 的 `problems` 与 P0–P4 严重度（不做对错判定，`is_correct` 恒 `null`）。

- 消费方接入：[docs/接入说明.md](docs/接入说明.md)（AIME）、[docs_wencai/接入说明.md](docs_wencai/接入说明.md)（问财）
- 增量同步：[docs/incremental.md](docs/incremental.md)、[docs_wencai/incremental.md](docs_wencai/incremental.md)
- 与 5002 联动指南：[../../docs/接口使用指南.md](../../docs/接口使用指南.md)

## 1. 部署与数据源

| 部署 | 对外 / 集群内 | `ANALYSIS_DATASET` | 数据根与归因路径 |
|---|---|---|---|
| **弗吉尼亚（AIME）** | `10.217.219.2:2477` / `interactive-s3ynzadcvm9c:5003` | `aime_eval` | `/mnt/aime_eval_ssd/1_aime/eval_output/{0_daily_eval,1_lost_user_eval}/{aime_expert,aime_fast}/*_attribution-*.jsonl`；聚类 `cluster/<model>/`；输入 `eval_input/0_daily_eval_input/` |
| **乌兰察布（问财）** | 平台映射 / `interactive-i6piqwvlnsr5:5003` | `wencai_eval` | `.../datasets/0_wencai/eval_output/2_rsi_eval/{b_expert,b_fast}/<cohort>/*_attribution-*.jsonl`；聚类 `cluster/<model>/total/`；输入 `eval_input/2_rsi_input/` |

- 每次部署只服务单一 `dataset`，在线文档 `/api/v1/analysis/docs` 自动下发对应目录（`docs/` 或 `docs_wencai/`）。
- **维度差异**：AIME `source`=`prelaunch|feedback`、`day`=`America/New_York`、意图走 v1.9（`taxonomy/intent_2026-11.json`，优先按 `trace_id` 关联 `category_meta.json`）；问财 `source`=用户分层 cohort、`day`=`Asia/Shanghai`、无 compact、意图通常为 `null`。

## 2. 核心口径

1. **仅统计已分析 trace**：同文件同 `trace_id` 取行号最大者，旧版进 `analysis.history`。
2. **`problems` 是唯一真相**：聚类只决定 `code`（未聚类 `code=null`，进 `"未聚类"` 组），不影响问题数与 P0–P4。
3. **分母 `analyzed`**：去掉 `problem` / `severity` 筛选并忽略 `problem` 分组维度后的 trace 数；`problems` 跨组不重、`traces` 可跨组。
4. **测试账号不供数**：仅纯 ASCII 数字且 ≤ 10 位为真实用户（规则见 `<EVAL_DATASETS>/user_rules.json`），其余整条排除；`/healthz` 的 `build.test_excluded` 显示排除量。
5. **编码升版**：旧编码保留在 `code`/`legacy_code`，当前树最近祖先给 `current_code`/`problem_label`。

## 3. 接口与运行特性

| 端点 | 作用 |
|---|---|
| `GET /healthz` | 存活、构建状态、`traces`/`problems`/`latest_seq`/`data_updated_at` |
| `GET /taxonomy` | `kind=intent\|problem\|severity`（`problem` 按 `app_version` 选树） |
| `GET\|POST /summary` · `/severity` | 多维聚合与 P0–P4 统计 |
| `GET\|POST /traces` · `/users` | trace 列表（cursor 翻页）与按用户聚合 |
| `POST /traces/batch` · `GET /traces/{id}` | 批量摘要（≤1000）与单条完整详情（`day` 必填） |
| `GET\|POST /changes` | 基于单调 `seq` 的全量与增量变更流（含 `deleted` 墓碑） |
| `GET /docs[/{name}]` | 在线 Markdown 文档索引与正文 |

- 无状态 HMAC cursor（30 分钟过期返回 410）；**多机部署必须共享 `ANALYSIS_CURSOR_KEY`**。
- 支持 `Accept-Encoding: gzip`（≥1 KB）、快照级聚合缓存（`ANALYSIS_RESULT_CACHE*`）与并发保护（`ANALYSIS_MAX_INFLIGHT=32`，超限 429）。

## 4. 本地运行、部署与验证

```bash
# 本地 / 远端 CLI
EVAL_DATASETS=/mnt/aime_eval_ssd ANALYSIS_DATASET=aime_eval python3 run.py serve  # build / status
# 部署（AIME 弗吉尼亚 / 问财 乌兰）
EVAL_DEPLOY_HOST=aime_rsi_data EVAL_DATASETS=/mnt/aime_eval_ssd ANALYSIS_DATASET=aime_eval ./deploy.sh
EVAL_DATASETS=/mnt/fin_bench/code_and_clean_data/datasets ANALYSIS_DATASET=wencai_eval ./deploy.sh
# 验收与只读接口自检
python3 tests/test_acceptance.py && python3 tests/test_store.py && python3 tests/test_taxonomy.py
python3 ../../scripts/audit_analysis_api.py http://127.0.0.1:5003
```

关键环境变量：`EVAL_DATASETS`、`ANALYSIS_DATASET`、`ANALYSIS_STATE`（默认 `./state`）、`PORT`（5003）、`REFRESH_SECONDS`（线上 3600）、`CURSOR_TTL`（1800）、`ANALYSIS_CURSOR_KEY`。

## 5. 目录

`analysis_api/{config,taxonomy,store,users,snapshot,cursors,server}.py` · `run.py` · `taxonomy/` · `docs/` · `docs_wencai/` · `tests/`。
