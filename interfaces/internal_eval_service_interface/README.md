# internal_eval_service_interface

面向外部业务方的**内部评测与聚类自动化服务接口**，挂载于弗吉尼亚 `5003` 端口（`/api/v1/internal-eval/*`），串联：

1. **Bench 抽题**：从 `/mnt/aime_eval_ssd/3_dynamic_bench/<model>/tier_<N>.jsonl`（`500 / 1000 / 5000 / 10000`）取题，产出看板兼容的 `01_targets/questions.jsonl` 与发给拉数同事的两份下发 JSONL（`before_questions.jsonl`、`after_questions.jsonl`）；
2. **可插拔数据拉取适配**：`TraceCollectorAdapter` 支持 `file_drop`（目录投递）、`http`（异步派单 + 流式回推 `/ingest`）与 `mock`（联调测试）；
3. **清洗 + 流式归因评测**：内置 vendor 的 `eval_harness_pkg`（`prepare_eval` + 流式 tail `engine.mjs evaluate`）；
4. **微批增量聚类 + 实时供数**：内置 vendor 的 `cluster_pkg`；无问题 trace（`GOLD`）评完即 `ready`，有问题 trace 首条立即聚类、后续按微批窗口增量聚类并实时更新 `/results`、`/results/changes`、`/compare` 与 `ab_test` 目录。

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
export INTERNAL_EVAL_COLLECTOR_MODE=file_drop
export INTERNAL_EVAL_DISPATCH_SPLIT=by_side
export INTERNAL_EVAL_PAGE_BASE_URL=http://10.217.219.2:2476
```

## 本地测试

```bash
python3 -m unittest discover -s tests -v
```
