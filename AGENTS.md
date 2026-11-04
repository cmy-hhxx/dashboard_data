# eval_data_server 工作区说明

**每次开始任务前，先读 [Critic.md](Critic.md)** —— 迁移期的临时约束（5001 暂时同时有问财和 AIME、
新版本只发 5004、生产代码冻结）。迁移完成并经用户确认后，该文件会被删除，本节引用也会一并移除。

其他入口：

- 两个接口怎么用、两套部署的 IP / 端口 / 容器名：`docs/接口使用指南.md`
- 看板交接、数据流与常见坑：`handoff.md`
- 各服务的发布脚本：`interfaces/eval_data_interface/deploy.sh`、`page_service/sample_details/deploy.sh`、
  `dashboard/deploy.sh`
