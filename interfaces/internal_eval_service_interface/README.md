# internal_eval_service_interface

面向外部业务方的**内部评测与聚类自动化服务接口**，挂载于弗吉尼亚 `5003` 端口（`/api/v1/internal-eval/*`），串联：

1. **Bench 抽题**：从 `/mnt/aime_eval_ssd/3_dynamic_bench/<model>/tier_<N>.jsonl`（`500 / 1000 / 5000 / 10000`）取题，产出 `version_{YYYYMMDD}_aime_{expert|fast}/bench/bench.jsonl`（严格日期+模型命名，同日同模型已存在返回 `409`）与 `.work/dispatch/` 下发文件；
2. **可插拔数据拉取适配**：`TraceCollectorAdapter` 支持 `task_manager`（复制模板 `2740e85cb7b34909`，命名 `AIME_RSI_ABTEST_{YYYYMMDD-HHMMSS}`、不设 `limit`，在 `<round_dir>/<task_id>/` 创建落盘目录并消费顶层加工后 `{step}.jsonl`、忽略 `raw/` 与 `judge_data`，默认每 15 分钟巡检补缺重试）、`file_drop`、`http` 与 `mock`；
3. **清洗 + 流式评测 + 人话 + 聚类**：内置 `eval_harness_pkg`（`prepare_eval` → `engine.mjs evaluate` → 后置 `human_read_eval` 生成 `attribution_human_read.jsonl`）与 `cluster_pkg` v4.6.0；无问题 trace（`GOLD`）评完即 `ready`，有问题 trace 首条立即聚类并按微批窗口增量供数。

## 目录结构

```text
internal_eval_service_interface/
├── README.md
├── deploy.sh                 # 部署到弗吉尼亚 /opt/internal_eval_service 并重载 5003
├── run.py                    # 独立启动/状态查看 CLI
├── scripts/sync_vendor.sh    # 同步外部 eval_harness_pkg & cluster_pkg 到 vendor/
├── vendor/
│   ├── VENDOR_MANIFEST.json
│   ├── eval_harness_pkg/     # 评测引擎（零第三方 Python 依赖 + 内置 Node 引擎）
│   └── cluster_pkg/          # 聚类引擎（纯 Python 标准库）
├── docs/                     # 在线文档（GET /api/v1/internal-eval/docs 下发）
│   ├── 接入说明.md
│   ├── 拉数同事接口契约.md
│   └── 状态机与可视化字段.md
├── internal_eval/            # 核心服务实现
└── tests/                    # 单元测试 + 流式端到端测试 + 5003 挂载回归测试
```

## 服务端配置（不入库）

在服务器端 `/opt/internal_eval_service/internal_eval.env`（权限 `600`，已在 `.gitignore` 中忽略）维护：

```bash
export EVAL_DATASETS=/mnt/aime_eval_ssd
export INTERNAL_EVAL_GATEWAY_BASE_URL=http://10.217.220.51/ai-gateway/v1
export INTERNAL_EVAL_GATEWAY_API_KEY=<服务端密钥>
export INTERNAL_EVAL_MODEL=deepseek-v4.1-flash
export INTERNAL_EVAL_THINKING=low
export INTERNAL_EVAL_CLUSTER_MODEL=deepseek-v4.1-flash
export INTERNAL_EVAL_CLUSTER_REASONING=none
export INTERNAL_EVAL_COLLECTOR_MODE=task_manager
export INTERNAL_EVAL_TASK_MANAGER_BASE_URL=http://10.217.216.85:8888/api/v1/task
export INTERNAL_EVAL_TASK_MANAGER_USER_ID=<白名单用户>
export INTERNAL_EVAL_TASK_MANAGER_TEMPLATE_TASK_ID=2740e85cb7b34909
export INTERNAL_EVAL_TASK_MANAGER_RECOVERY_INTERVAL_SEC=900
export INTERNAL_EVAL_TASK_MANAGER_JUDGE_SOURCE=drop_dir
export INTERNAL_EVAL_TASK_MANAGER_DROP_WAIT_TIMEOUT_SEC=3600
export INTERNAL_EVAL_HUMAN_READ_ENABLED=true
export INTERNAL_EVAL_DISPATCH_SPLIT=by_side
export INTERNAL_EVAL_PAGE_BASE_URL=http://10.217.219.2:2476
export INTERNAL_EVAL_API_TOKENS='caller1:<token1>,caller2:<token2>'
export INTERNAL_EVAL_AUTH_MODE=all
export INTERNAL_EVAL_MAX_CONCURRENT_RUNS=1
export INTERNAL_EVAL_MAX_QUEUED_RUNS=0
export INTERNAL_EVAL_MAX_INFLIGHT_PER_CALLER=4
export INTERNAL_EVAL_RATE_LIMIT_PER_MINUTE=60
```

## 本地测试

```bash
python3 -m unittest discover -s tests -v
```
