# eval_data_server 工作区说明

当前部署：**问财 → 乌兰察布**（5001 看板、5002 页面接口）；**AIME → 弗吉尼亚**（5001 看板、5002 页面接口、5003 供数）；
乌兰 5003 已停用（问财供数接口尚未实现）。地址与用法见 `docs/接口使用指南.md`。

入口：

- 两个接口怎么用、两套部署的 IP / 端口 / 容器名：`docs/接口使用指南.md`
- 看板交接、数据流与常见坑：`handoff.md`
- 各服务的发布脚本：`interfaces/eval_data_interface/deploy.sh`、`page_service/sample_details/deploy.sh`、
  `dashboard/deploy.sh`
