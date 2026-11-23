# eval_data_dashboard 工作区说明

当前部署：**问财 → 乌兰察布**（5001 看板、5002 页面接口）；**AIME → 弗吉尼亚**（5001 看板、5002 页面接口、5003 供数）；
乌兰 5003 已停用（问财供数接口尚未实现）。地址与用法见 `docs/接口使用指南.md`。

入口：

- 两个接口怎么用、两套部署的 IP / 端口 / 容器名：`docs/接口使用指南.md`
- 看板交接、数据流与常见坑：`handoff.md`
- 页面打不开 / ERR_CONNECTION_REFUSED 的根因与排查：`docs/connection-refused.md`
- 弗吉尼亚数据服务器的目录、字段、构建刷新与常见坑：`docs/data-server.md`
- AIME 数据存量盘点（待瘦身 / 待评测 / 已评测）的口径与一条命令：`docs/aime-data-inventory-sop.md`
- 用户 KYC 库（daily eval input → SQLite，同步与查询）：`docs/用户KYC库.md`
- 弗吉尼亚容器重建后拉齐三个服务：`scripts/virginia/bringup.sh`，说明见 `docs/virginia-restart.md`
- 跑全部测试：`scripts/run_tests.sh`（在服务器上跑）
- 各服务的发布脚本：`interfaces/eval_data_interface/deploy.sh`、`page_service/sample_details/deploy.sh`、
  `dashboard/deploy.sh`
