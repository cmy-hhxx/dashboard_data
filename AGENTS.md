# eval_data_server 工作区说明

## 部署拓扑

- **乌兰察布（问财）**：5001 看板（对外 `2768`）、5002 页面接口（`2833`）、5003 供数（`dataset=wencai_eval`），数据根 `/mnt/fin_bench/code_and_clean_data/datasets`。
- **弗吉尼亚（AIME）**：5001 看板（对外 `2475`）、5002 页面接口（`2476`）、5003 供数与内部评测（`2477`，`dataset=aime_eval` + `/api/v1/internal-eval/*`），数据根 `/mnt/aime_eval_ssd`。

## 文档规范（硬约束）

- **单篇文档严格 ≤ 100 行**（新增或修改任何 `.md` 文档前必须核对行数，超限即精简或拆分）。
- **言简意赅、逻辑严谨**：只写当前生效的架构、接口、口径与操作；**禁止**保留巡检流水账、一次性故障实录或过期数据快照。

## 文档入口

- 接口与端口速查：`docs/接口使用指南.md`
- 看板交接与开发：`handoff.md`
- 部署、守护与排错：`docs/dashboard-deployment.md`
- 弗吉尼亚数据根、字段与构建：`docs/data-server.md`
- 弗吉尼亚容器重建恢复：`docs/virginia-restart.md`（脚本 `scripts/virginia/bringup.sh`）
- 内部评测服务：`interfaces/internal_eval_service_interface/README.md`、`docs/数据推理.md`
- 用户 KYC 库：`docs/用户KYC库.md`
- 测试与发布：`scripts/run_tests.sh`（服务器上跑）；各服务发布用对应目录 `deploy.sh`。
