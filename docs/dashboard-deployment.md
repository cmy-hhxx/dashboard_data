# 看板部署与运行

`dashboard/deploy.sh` 发布，`start.sh` / `stop.sh` 起停，`server.py` 提供 HTTP 与定时构建。

## 两台服务器

| 项 | 乌兰察布 | 弗吉尼亚 |
|---|---|---|
| 外部 IP | `117.50.195.94` | `10.217.219.2` |
| 容器名（集群内部） | `interactive-i6piqwvlnsr5` | `interactive-npasm9ch66eb` |
| SSH 别名 / 对外端口 | `eval_data` / `2834` | `aime_rsi_data` / `2225` |
| 数据 | 问财（wencai） | AIME |
| 数据根 | `/mnt/fin_bench/code_and_clean_data/datasets` | `/mnt/fin_bench/aime_rsi_data`（AIME 第二套，规划） |

访问约定：集群内部跨容器用「容器名:容器端口」，同容器内用 `127.0.0.1`，本地 / 外部用「IP:对外端口」。
迁移期约定（5001 暂时同时承载问财 + AIME、新版本只发 5004、生产代码冻结）见 [`Critic.md`](../Critic.md)。
端口映射与密钥在本地 `servers.conf`（已 gitignore，不入库）。

## 端口分配（固定）

| 容器端口 | 角色 | 乌兰察布对外 | 弗吉尼亚对外 |
|---|---|---|---|
| `5001` | 展示（看板生产） | `2768` | `2221` |
| `5002` | 页面接口（样本详情页 / JSON API） | `2833` | `2222` |
| `5003` | 供数（数据接口，对话分析查询接口 v2） | `3335` | `2224` |
| `5004` | 开发调试 | `3336` | `2228` |
| `5005` | 备用 | `3337` | `2243` |
| `22` | SSH | `2834` | `2225` |

- 页面接口（`5002`）对外有两种入口：DSW 代理
  `https://rtahz.10jqka.com.cn/bmtp/proxy/dsw/trace-detail/`（平台会剥掉路径前缀）和直连
  `http://117.50.195.94:2833`。代理下前端 URL 必须用相对路径，否则会 404。
- 生产入口固定，不在其上调试；开发调试 / 预发副本用 `5004`：
  `EVAL_DEPLOY_REMOTE=/opt/eval_dashboard_2 PORT=5004 STATS_WORKER=0 ./dashboard/deploy.sh`
- 改端口三处同步：服务 `PORT`、平台映射、`servers.conf`。

## 发布与验证

问财、AIME 分开部署（数据也分开放）：每份只构建自己的产品（`EVAL_PRODUCTS`），点另一个产品时前端跳到
它的服务器（地址写在 `static/js/app.js` 的 `SITES`）。

```bash
# 问财 → 乌兰察布 5004（对外 3336），数据 datasets/0_wencai；5001 已有 stats 进程，这里不再起
EVAL_DEPLOY_REMOTE=/opt/eval_dashboard_2 PORT=5004 STATS_WORKER=0 \
  EVAL_DATASETS=/mnt/fin_bench/code_and_clean_data/datasets EVAL_PRODUCTS=wencai ./dashboard/deploy.sh
# AIME → 弗吉尼亚 5001（对外 2221），数据 /mnt/fin_bench/aime_rsi_data/1_aime
EVAL_DEPLOY_HOST=aime_rsi_data EVAL_DATASETS=/mnt/fin_bench/aime_rsi_data EVAL_PRODUCTS=aime ./dashboard/deploy.sh
curl -s http://117.50.195.94:3336/healthz | jq
curl -s http://10.217.219.2:2221/healthz | jq
```

命令里设置的变量会写进远端 `deploy.env`，之后的定时构建、`start.sh`、手动重启都读它；不带变量重新部署
会保留已有的 `deploy.env`。乌兰 `5001`（`/opt/eval_dashboard`，问财 + AIME 旧版）迁移期冻结，见
`Critic.md`。问财迁回 `5001` 时：改 `SITES.wencai.url`，两边都重新部署。

`deploy.sh` 顺序：rsync 代码（不含生成物 / 缓存 / 日志 / tests）→ 远端 `build.py --keep-on-empty`
（≤1800s）→ `precompress.sh` → `stop.sh` → `start.sh`。远端不是 git 仓库，回滚 = 切旧 commit 重新部署；
构建失败不阻断发布，服务继续用旧数据，部署后**必须看 `logs/build.log`**。

`healthz` 恒返回 200，看 JSON：`ok=true`、`error` 为空、`build.pairs > 0`；`kept_previous` 表示
数据源为空、保留了旧数据。

手动起停：

```bash
ssh eval_data 'cd /opt/eval_dashboard && ./stop.sh && ./start.sh'
```

## 运行要点

- 启动时缺数据先构建；之后每 `REFRESH_SECONDS`（默认 600s）增量构建，页面每 2 分钟条件请求刷新。
- 数据源为空时 `--keep-on-empty` 不写文件，保留上一份 payload。
- 生成物只留远端；改 `static/` 后需重新执行 `precompress.sh`（`deploy.sh` 自动）。
- 详情 `/samples/<slug>.json` 首次访问按需生成（约 0.5–4s），之后走磁盘缓存。
- `/healthz` 为 `no-store`，其余 `no-cache`；构建缓存 `cache/build.sqlite3` 按 `(size, mtime_ns)` 增量，删除后全量重建。
- 没有进程守护、日志不轮转：容器重启后需手动 `start.sh`，长期运行注意清理 `logs/`。
- 预测数据放 `datasets/4_forecast/<产品>/prediction.json`，下一轮构建生效。

## 注意事项

- 只通过 `deploy.sh` 发布，不要在远端手改（下次部署会被 `rsync --delete` 覆盖）。
- 不要并发部署；不要只看「启动成功」，构建失败时服务会带旧数据启动。

## 故障排查

| 现象 | 处理 |
|---|---|
| 外网打不开 / 502 | `ssh eval_data` 后 `curl -s http://127.0.0.1:5001/healthz`；看 `logs/server.log`；`./start.sh` |
| `ok=false` | 看 healthz 的 `error` 与 `logs/build.log` 末尾；修复后重启 |
| `kept_previous` | 数据源为空，确认挂载；恢复后下一轮自动重建 |
| 页面没更新 | `./stop.sh && ./start.sh`；确认远端 `.gz` 已重新生成 |
| 数据停在旧日期 | 看 `healthz.last_refresh`；确认 `datasets` 挂载可读 |
