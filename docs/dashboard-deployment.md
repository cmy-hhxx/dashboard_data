# 看板部署与运维

## 1. 服务器与端口

| 项 | 乌兰察布（问财） | 弗吉尼亚（AIME） |
|---|---|---|
| 外部 IP / SSH 别名 | `117.50.195.94` / `eval_data`（`:2834`） | `10.217.219.2` / `aime_rsi_data`（`:2473`） |
| 容器名（集群内） | `interactive-i6piqwvlnsr5` | `interactive-s3ynzadcvm9c` |
| 数据根 / 产品 | `/mnt/fin_bench/code_and_clean_data/datasets` / `wencai` | `/mnt/aime_eval_ssd` / `aime` |
| 对外端口（5001/5002/5003/5004/5005） | `2768` / `2833` / 平台映射 / `3336` / `3337` | `2475` / `2476` / `2477` / `2478` / `2479` |

- 端口角色固定：`5001` 看板生产、`5002` 页面接口、`5003` 供数、`5004` 开发预发、`5005` 备用。
- 5002 DSW 代理前缀（前端必须用相对路径）：问财 `.../proxy/dsw/trace-detail/`、AIME `.../trace-detail-oversea/`。
- 密钥与端口映射放本地 `servers.conf`（已 gitignore）；改端口需同步服务 `PORT`、平台映射与 `servers.conf`。

## 2. 发布命令

```bash
# 问财看板 → 乌兰 5001
EVAL_DATASETS=/mnt/fin_bench/code_and_clean_data/datasets EVAL_PRODUCTS=wencai ./dashboard/deploy.sh
# AIME 看板 → 弗吉尼亚 5001
EVAL_DEPLOY_HOST=aime_rsi_data EVAL_DATASETS=/mnt/aime_eval_ssd EVAL_PRODUCTS=aime ./dashboard/deploy.sh
# 预发副本（5004，不跑 stats_worker）
EVAL_DEPLOY_REMOTE=/opt/eval_dashboard_2 PORT=5004 STATS_WORKER=0 ./dashboard/deploy.sh
# 问财 5003 供数
EVAL_DATASETS=/mnt/fin_bench/code_and_clean_data/datasets ANALYSIS_DATASET=wencai_eval REFRESH_SECONDS=3600 \
  ./interfaces/eval_data_interface/deploy.sh
```

- `deploy.sh` 顺序：rsync 代码（排除产物/缓存/日志）→ `precompress.sh` → `stop.sh` → `start.sh`。默认不等构建，重启后后台刷新（加 `EVAL_DEPLOY_BUILD=1` 可同步等构建）。
- 传入变量会持久化到远端 `deploy.env`（未传则沿用原值）；切换数据源需更新 `deploy.env` 并重启。
- 远端非 git 仓库，**禁止手改远端文件**；回滚 = 本地切旧 commit 重跑 `deploy.sh`。
- 验证：`curl -s http://<host>:<port>/healthz | jq`（状态码恒 200，检查 `ok=true`、`error=""`、`build.pairs > 0`；冷启动预热期返回 `503`）。

## 3. 弗吉尼亚 SSH 长连接（必配）

弗吉尼亚边缘会间歇拒绝高频新连接，所有远程操作必须复用 `ControlMaster`（私钥权限 `600`）：

```sshconfig
Host aime_rsi_data
  HostName 10.217.219.2
  User root
  Port 2473
  IdentityFile <本机私钥路径>
  IdentitiesOnly yes
  ServerAliveInterval 30
  ServerAliveCountMax 6
  ControlMaster auto
  ControlPath ~/.ssh/cm-%r@%h:%p
  ControlPersist 30m
```

先建主连接 `ssh -MNf aime_rsi_data`，再用 `ssh`/`rsync` 复用，完毕可 `ssh -O exit aime_rsi_data`。

## 4. 运行、多机与备份

- **定时刷新**：`server.py` 与 `stats_worker.py` 默认每 600s 刷新（`REFRESH_SECONDS`/`STATS_REFRESH_SECONDS` 可覆盖）；构建持有 `cache/build.lock` 互斥；`filelist.py` 缓存目录树 15 分钟避免 ceph 频繁 `rglob`。
- **多机部署**：共享只读 `EVAL_DATASETS`，各机使用本地磁盘 `EVAL_CACHE_DIR`（SQLite WAL 不可放共享存储），仅一台开 `STATS_WORKER=1`；静态资源走 `v/<hash>/` 长缓存；站点表在 `dashboard/config/sites.json`；多台 5003 须共用同一 `ANALYSIS_CURSOR_KEY`。
- **AIME 派生快照**：`EVAL_PRODUCTS=aime` 且 `PORT=5001` 时自动启动 `backup_stats.sh`，每小时硬链接快照 `stats.json`、聚类索引、`cache/` 与检索 payload 到 `/mnt/aime_eval_ssd/1_aime/stats/`（保留 12 份，`BACKUP_STATS=0` 关闭）。

## 5. 进程守护（`eval_supervisor.sh`）

每 30s 探活 `/opt/eval_services.conf`（格式 `name|health_url|workdir|start_cmd`），`/healthz` 失败时执行 `start.sh`：

```bash
scp scripts/eval_supervisor.sh <host>:/opt/eval_supervisor.sh
# 写入 /opt/eval_services.conf（5001/5002/5003；/matrix 和 /compare 由 5002 同进程提供）
nohup /opt/eval_supervisor.sh >> /opt/eval_supervisor.log 2>&1 &
```

维护窗口先 `touch /opt/eval_supervisor.pause`，完毕删除。容器镜像无 cron/systemd，重启后需拉起守护或将 `eval_boot.sh` 写入平台启动命令。

## 6. 故障排查

| 现象 | 排查与处理 |
|---|---|
| `ERR_CONNECTION_REFUSED` / 502 | 先在容器内测 `curl -s http://127.0.0.1:5001/healthz`：503=预热中、200=查外部端口映射/链路、不通=看 `logs/server.log` 后 `./start.sh` |
| `ok=false` / `kept_previous` | 看 `/healthz` 的 `error` 与 `logs/build.log`；确认数据挂载可读后重跑或等下一轮刷新 |
| 构建卡住不更新 | 检查 `ps aux \| grep build.py`，必要时 `pkill -f eval_dashboard/build.py` 释放 `build.lock` 后重启 |
| `ZoneInfoNotFoundError` | 新容器缺时区库：`python3 -m pip install tzdata` 或从另一台复制 `/usr/share/zoneinfo/America/New_York` 后重启 |
| 部署卡在 `pip install` | 无外网时跳过可选 `orjson/brotli`，手动跑 `./precompress.sh && ./stop.sh && ./start.sh` |
