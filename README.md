# eval_data_server

问财 / AIME 评测数据的**看板、页面接口、供数接口与运维脚本**仓库。仓库只存代码与文档；真实数据与密钥（`datasets/`、`servers.conf`、`*.env`）均不入库。

## 部署分工

| 产品 | 服务器 | 数据根 | 端口（看板 / 页面 / 供数） |
|---|---|---|---|
| **问财** | 乌兰察布 (`eval_data`) | `/mnt/fin_bench/code_and_clean_data/datasets` | 5001(`2768`) / 5002(`2833`) / 5003 |
| **AIME** | 弗吉尼亚 (`aime_rsi_data`) | `/mnt/aime_eval_ssd`（`1_aime`） | 5001(`2475`) / 5002(`2476`) / 5003(`2477`) |

- 两套部署各自只构建本产品（`EVAL_PRODUCTS`），顶部切换自动跳转对方站点（`dashboard/config/sites.json`）。
- 弗吉尼亚旧 HDD（`/mnt/fin_bench/aime_rsi_data`）与跨机同步已停用，AIME 数据统一读写 SSD。

## 目录结构

| 路径 | 职责 | 文档 |
|---|---|---|
| `dashboard/` | 评测看板（原生 ES Modules + SVG + Python HTTP，增量构建 + 详情懒加载） | [handoff.md](handoff.md)、[dashboard/local_dev/README.md](dashboard/local_dev/README.md) |
| `page_service/` | 5002 只读页面服务（样本详情 `/`、聚类矩阵 `/matrix/`、版本对比 `/compare/`） | [page_service/sample_details/README.md](page_service/sample_details/README.md) |
| `interfaces/eval_data_interface/` | 5003 对话分析供数接口 v2（`/api/v1/analysis/*`，零第三方依赖） | [interfaces/eval_data_interface/README.md](interfaces/eval_data_interface/README.md) |
| `interfaces/internal_eval_service_interface/` | 挂载于弗吉尼亚 5003 的内部评测与聚类接口（`/api/v1/internal-eval/*`） | [interfaces/internal_eval_service_interface/README.md](interfaces/internal_eval_service_interface/README.md) |
| `human_read_module/` | AIME 评测输出的人话同义翻译镜像层（零侵入原文件） | [human_read_module/README.md](human_read_module/README.md) |
| `scripts/` | 打包、守护、容器恢复、KYC 库同步、全仓测试 | [docs/dashboard-deployment.md](docs/dashboard-deployment.md) |

## 看板视图与核心口径

| 视图 | 路由 | 说明 |
|---|---|---|
| 数据看板 | `?view=data` | 数据量、评测量（含每日详情）、聚类矩阵（含就地趋势与 A/B Test）、归因、聚类、预测、会话场 |
| 评测速度 | `?view=speed` | AIME 实时评测队列、吞吐与网关状态（仅弗吉尼亚可用） |
| 评测体系 | `?view=system` | 输入 → 压缩 → 归因 → 聚类链路与 10 条 golden Trace 证据闭环 |
| 具体样本 | `?view=samples` | 两栏工作台：召回列表 \| 轨迹 + 对话 + 归因（含证据连线，详情按需懒加载） |
| 版本对比 | `?view=compare` | A/B 固定题集的改版前 / 改版后 / GPT 三列同题对比与事实核验 |

- **数据口径**：输入统计 records/traces/tools/tokens/task-subtask 及流失（按 `user_rules.json` 的 `lost.ids`）；已评测按归因文件计；样本按 `(session_id, request_time)` 配对，缺失时回退 `trace_id`。
- **用户类型**：纯 ASCII 数字且 ≤ 10 位为真实用户，其余归为测试账号（看板标 `ut=test`，5002/5003 不供数）。
- **视觉原则**：见 [docs/design-principles.md](docs/design-principles.md)（微差灰阶分层、同心圆角、暗色降字重、等宽数字、分性格动效）。

## 常用命令

```bash
# 本地启动与刷新看板（读仓库根 datasets/，EVAL_DATASETS 可覆盖）
./dashboard/local_dev/start.sh
./dashboard/local_dev/refresh.sh

# 发布看板（问财默认 eval_data；AIME 加 EVAL_DEPLOY_HOST=aime_rsi_data）
./dashboard/deploy.sh

# 常规打包 AIME 输入+输出（在弗吉尼亚执行，详见 docs/aime-input-packaging.md）
scp scripts/pack_aime_io.sh aime_rsi_data:/tmp/ && \
  ssh aime_rsi_data 'chmod +x /tmp/pack_aime_io.sh && SRC_BASE=/mnt/aime_eval_ssd/1_aime /tmp/pack_aime_io.sh'

# 全仓测试（在服务器运行，含构建类重用例）
scripts/run_tests.sh
```

## 文档索引

- [docs/接口使用指南.md](docs/接口使用指南.md) — 5003 供数与 5002 页面接口总览
- [docs/dashboard-deployment.md](docs/dashboard-deployment.md) — 双机部署、端口、SSH 长连接与守护
- [docs/data-server.md](docs/data-server.md) — 弗吉尼亚数据目录、字段与构建缓存约定
- [docs/virginia-restart.md](docs/virginia-restart.md) — 弗吉尼亚容器重建后的快照恢复流程
- [docs/prediction-data.md](docs/prediction-data.md) — 预测体系卡片的数据协议
- [docs/用户KYC库.md](docs/用户KYC库.md) — 用户 KYC SQLite 库与即用即查
- [docs/数据推理.md](docs/数据推理.md) — TaskManager 推理接口说明
