# 看板部署与运行

`dashboard/deploy.sh` 发布，`start.sh` / `stop.sh` 起停，`server.py` 提供 HTTP 与定时构建。

## 两台服务器

| 项 | 乌兰察布 | 弗吉尼亚 |
|---|---|---|
| 外部 IP | `117.50.195.94` | `10.217.219.2` |
| 容器名（集群内部） | `interactive-i6piqwvlnsr5` | `interactive-s3ynzadcvm9c` |
| SSH 别名 / 对外端口 | `eval_data` / `2834` | `aime_rsi_data` / `2473` |
| 数据 | 问财（wencai，只构建 `0_wencai`） | AIME（只构建 `1_aime`） |
| 看板数据根 | `/mnt/fin_bench/code_and_clean_data/datasets` | `/mnt/aime_eval_ssd`（产品目录 `1_aime`；旧 HDD `/mnt/fin_bench/aime_rsi_data` 仅作冷数据） |

访问约定：集群内部跨容器用「容器名:容器端口」，同容器内用 `127.0.0.1`，本地 / 外部用「IP:对外端口」。
当前状态（2026-11-19）：乌兰 5001/5002/5003 都按问财部署（`EVAL_PRODUCTS=wencai`）；
问财看板的数据源是 `0_wencai/eval_output/2_rsi_eval` + `eval_input/2_rsi_input`，5003 服务
`dataset=wencai_eval`。弗吉尼亚 5001/5002/5003 服务 AIME（数据只在弗吉尼亚更新）。
端口映射与密钥在本地 `servers.conf`（已 gitignore，不入库）。

## 端口分配（固定）

| 容器端口 | 角色 | 乌兰察布对外 | 弗吉尼亚对外 |
|---|---|---|---|
| `5001` | 展示（看板生产） | `2768` | `2475` |
| `5002` | 页面接口（样本详情页 / JSON API） | `2833` | `2476` |
| `5003` | 供数（数据接口，对话分析查询接口 v2） | 已恢复（`wencai_eval`） | `2477` |
| `5004` | 开发调试 | `3336` | `2478` |
| `5005` | 备用 | `3337` | `2479` |
| `22` | SSH | `2834` | `2473` |

- 页面接口（`5002`）对外有两种入口：DSW 代理和直连 IP。代理基址按产品分开
  （平台会剥掉路径前缀，转发到对应容器的 5002）：
  问财 `https://rtahz.10jqka.com.cn/bmtp/proxy/dsw/trace-detail/`、
  AIME `https://rtahz.10jqka.com.cn/bmtp/proxy/dsw/trace-detail-oversea/`。
  代理下前端 URL 必须用相对路径，否则会 404。
- 生产入口固定，不在其上调试；开发调试 / 预发副本用 `5004`：
  `EVAL_DEPLOY_REMOTE=/opt/eval_dashboard_2 PORT=5004 STATS_WORKER=0 ./dashboard/deploy.sh`
- 改端口三处同步：服务 `PORT`、平台映射、`servers.conf`。

## 发布与验证

问财、AIME 分开部署（数据也分开放）：每份只构建自己的产品（`EVAL_PRODUCTS`），点另一个产品时前端跳到
它的服务器（地址写在 `static/js/app.js` 的 `SITES`）。

```bash
# 问财 → 乌兰察布 5001（对外 2768），数据 datasets/0_wencai，只构建问财
EVAL_DATASETS=/mnt/fin_bench/code_and_clean_data/datasets EVAL_PRODUCTS=wencai ./dashboard/deploy.sh
# AIME → 弗吉尼亚 5001（对外 2475），数据根 /mnt/aime_eval_ssd（产品目录 1_aime）
EVAL_DEPLOY_HOST=aime_rsi_data EVAL_DATASETS=/mnt/aime_eval_ssd EVAL_PRODUCTS=aime ./dashboard/deploy.sh
# 预发调试副本（乌兰 5004 对外 3336）
EVAL_DEPLOY_REMOTE=/opt/eval_dashboard_2 PORT=5004 STATS_WORKER=0 \
  EVAL_DATASETS=/mnt/fin_bench/code_and_clean_data/datasets EVAL_PRODUCTS=wencai ./dashboard/deploy.sh
# 问财 5003 供数（容器内 5003；对外端口由平台映射）
EVAL_DATASETS=/mnt/fin_bench/code_and_clean_data/datasets ANALYSIS_DATASET=wencai_eval \
  REFRESH_SECONDS=3600 ./interfaces/eval_data_interface/deploy.sh
curl -s http://117.50.195.94:2768/healthz | jq
curl -s http://10.217.219.2:2475/healthz | jq
```

命令里设置的变量会写进远端 `deploy.env`，之后的定时构建、`start.sh`、手动重启都读它；不带变量重新部署
会保留已有的 `deploy.env`。乌兰 5001 的 `deploy.env` 现在带 `EVAL_PRODUCTS=wencai`，
弗吉尼亚的带 `EVAL_PRODUCTS=aime`；两边的产品切换按钮分别跳到对方服务器（`static/js/app.js` 的 `SITES`）。

`deploy.sh` 顺序：rsync 代码（不含生成物 / 缓存 / 日志 / tests）→ `precompress.sh` → `stop.sh` → `start.sh`，
**不再同步等构建**：`server.py` 重启后只要 `data.json` 超过 120s 就会在后台自己重建（进度看 `/healthz` 的
`running` / `seconds` / `error`）。发布本身因此只要几秒到十几秒，ceph 再慢也不拖慢上线。
需要「发布前先构建」的老行为时加 `EVAL_DEPLOY_BUILD=1`。

- SSH 边缘会间歇性拒绝连接，`deploy.sh` 的每步（含首次 mkdir / rsync / 启停 / 健康检查）都带重试，
  并默认启用 `ControlMaster` 长连接（`ControlPath=/tmp/omp-deploy-%r@%h:%p`，`ControlPersist=10m`）；
  重试次数用 `EVAL_DEPLOY_RETRIES`（默认 6），健康检查等待秒数用 `EVAL_DEPLOY_HEALTH_TRIES`（默认 150×2s）。
- **冷启动副本（首次部署 / 没有 payload）**：`server.py` 会先构建完再开始监听，`/healthz` 在这段时间不可达，
  所以健康检查要留足时间（本次预发冷构建约 3–5 分钟）。
- `start.sh` 先看 `server.pid` 是否存活再决定是否启动（构建期间 healthz 还没起，不能只看 healthz，
  否则会拉起第二个 server 再跑一份 build）；`stop.sh` 会连带清理本目录的 `build.py` 孤儿进程，
  避免两个 build 抢 `cache/build.sqlite3`（报 `database is locked`）。

远端不是 git 仓库，回滚 = 切旧 commit 重新部署；构建失败不阻断发布，服务继续用旧数据。

### 弗吉尼亚 SSH 必须用长连接

弗吉尼亚（`10.217.219.2:2473`）的 SSH 边缘会间歇性拒绝新连接：短命令成功，但连续 `ssh` / `rsync`
很容易在几次后被拒。**对弗吉尼亚的所有远程操作都复用同一条长连接**，不要在循环里反复新建连接。

本机 `~/.ssh/config` 加：

```sshconfig
Host aime_rsi_data
  HostName 10.217.219.2
  User root
  Port 2473
  IdentityFile <本机私钥路径>
  IdentitiesOnly yes
  ServerAliveInterval 30
  ServerAliveCountMax 6
  TCPKeepAlive yes
  ControlMaster auto
  ControlPath ~/.ssh/cm-%r@%h:%p
  ControlPersist 30m
```

首次显式建 master，之后 `ssh aime_rsi_data` / `rsync -e ssh … aime_rsi_data:…` 自动复用：

```bash
ssh -MNf aime_rsi_data                 # 后台建立长连接
ssh -O check aime_rsi_data             # 确认 master 存活
ssh aime_rsi_data '...'                # 复用，不再重新握手
ssh -O exit aime_rsi_data              # 用完关闭
```

`deploy.sh` 自带 `ServerAliveInterval=15` / `ServerAliveCountMax=4` 和重试（`EVAL_DEPLOY_RETRIES`，
默认 6），但仍建议先建 master；大文件迁移 / 打包更要用 `rsync` + 同一 master，避免长时间连接被边缘掐断。

**为什么以前那么慢**：`input_files()` 每次都用 `rglob` 走一遍 `eval_input`（弗吉尼亚 52 个目录、ceph 上
50–250s），数据没变也照走。现在走 `dashboard/filelist.py` 的目录清单缓存（`cache/tree-*.json`，默认
15 分钟有效），没变化就完全不碰元数据；`build.py` 的增量缓存（`cache/build.sqlite3`）配合，数据没变时
整次构建是亚秒级（问财实测 0.6s），真有增量时也只重扫新增/改动的文件。

`healthz` 恒返回 200，看 JSON：`ok=true`、`error` 为空、`build.pairs > 0`；`kept_previous` 表示
数据源为空、保留了旧数据。

手动起停：

```bash
ssh eval_data 'cd /opt/eval_dashboard && ./stop.sh && ./start.sh'
```

## 运行要点

- 启动时缺数据先构建；之后按 `REFRESH_SECONDS` 增量构建，`stats_worker` 按 `STATS_REFRESH_SECONDS`，
  两者代码默认都是 600s，部署目录的 `deploy.env` 可覆盖（弗吉尼亚 5001 当前未覆盖，即 10 分钟）。
  构建在 `cache/build.lock` 上加锁：定时刷新、`EVAL_DEPLOY_BUILD=1` 与手动 `python3 build.py` 互相排队，不会并发写同一份产物；
  页面每 2 分钟条件请求 `data.json`，只有 `generated_at` 变了才换 payload。
- 无变化时的检查只扫有限层级目录/文件（不再用 `**` 递归遍历 `eval_output` 的 `.runs`/`.delivery`）：
  弗吉尼亚实测 27s（优化前同一份数据 75–743s），乌兰约 0.3s；数据源为空时 `--keep-on-empty` 不写文件，保留上一份 payload。
- 生成物只留远端；改 `static/` 后需重新执行 `precompress.sh`（`deploy.sh` 自动）。
- 详情 `/samples/<slug>.json` 首次访问按需生成（约 0.5–4s），之后走磁盘缓存。
- `/healthz` 为 `no-store`，其余 `no-cache`；构建缓存 `cache/build.sqlite3` 按 `(size, mtime_ns)` 增量，删除后全量重建。
- 进程守护见下节；日志不轮转，长期运行注意清理 `logs/`。
- 预测数据放 `datasets/4_forecast/<产品>/prediction.json`，下一轮构建生效。

## 多机部署

同一份代码可以在多台机器上跑看板（每台一个 5001），约定如下：

| 项 | 做法 |
|---|---|
| 数据根 | 各机挂同一个 `EVAL_DATASETS`（只读）；`EVAL_PRODUCTS` 决定本机构建哪些产品 |
| 构建缓存 | `EVAL_CACHE_DIR` 指到本机磁盘（默认 `dashboard/cache`）。SQLite（WAL）不能放在 ceph / NFS 上共享 |
| 构建互斥 | `build.py` 在 `<cache>/build.lock` 上 flock：同一台机器上的定时构建、部署构建、手动构建排队；各机缓存独立，互不影响 |
| 产物 | 每台机器写自己的 `static/`；所有临时文件名带进程号，原子替换 |
| 共享目录写入 | 只有 `STATS_WORKER=1` 的那一台写 `<datasets>/stats.json`；其他机器设 `STATS_WORKER=0`（读同一份旁路统计） |
| 静态资源 | 页面引用 `v/<内容哈希>/js/…`，同一份代码在任何机器上哈希相同；该路径一年 `immutable` 缓存，发版即换哈希。哈希在服务启动时计算，改了 `static/` 要重启 |
| 站点表 | 问财 / AIME 各自的看板地址在 `dashboard/config/sites.json`（`EVAL_SITES_FILE` 可换），服务端内联进 `index.html`，不写死在前端 |
| 5003 供数 | 同一入口后有多台时，全部设同一个 `ANALYSIS_CURSOR_KEY`，否则翻页 cursor 跨机失效；各机 `ANALYSIS_STATE` 各自本地 |

## 统计 / 索引备份

`dashboard/backup_stats.py` 每小时把「重建/检索所需的派生数据」快照到
`/mnt/aime_eval_ssd/1_aime/stats/<UTC 时间>/`，滚动保留最新 12 份。目标、周期、份数可用
`BACKUP_STATS_DEST` / `BACKUP_STATS_INTERVAL` / `BACKUP_STATS_KEEP` 覆盖（写进 `deploy.env` 即可）。
看板源切到 SSD 后，备份默认源也是 `/mnt/aime_eval_ssd`；备份目录位于产品目录 `1_aime/stats`，
构建只扫 `eval_input` / `eval_output`，不会把备份目录当数据。内容是：
- 数据集侧车与聚类索引：`<datasets>/stats.json`、`user_rules.json`、`releases.json`、
  `*/eval_output/cluster/`、`*/eval_output/*/cluster/`（`cluster_tree.json`、`item_index.jsonl` 等）；
- 看板缓存：`cache/build.sqlite3`（SQLite backup API，兼容 WAL 写入）、`samples.pkl`、
  `clusters-*.pkl`、`tree-*.json`、`cache/inputs/`、`cache/ab-details/`、`config/releases.json`；
- 检索用 payload：`static/data*.json`、`samples-*.json`、`labels-*.json`、`trends-*.json`、
  `abtests-*.json`（不含 `static/samples/` 详情和 `.gz`，它们可再生）。

未变化的文件用硬链接指向上一个快照，只有本轮真正重建过的文件才复制。快照先写到
`.tmp-*`，完成后原子改名；失败时保留旧快照。`backup_stats.sh` 负责 nohup 起停和 pid
文件，`start.sh` 会在 `EVAL_PRODUCTS=aime` 且 `PORT=5001` 时自动启动它（`/opt/eval_dashboard_2`
的 5004 副本、乌兰问财部署会跳过；`BACKUP_STATS=0` 可关闭）：

```bash
ssh aime_rsi_data 'cd /opt/eval_dashboard && ./backup_stats.sh status'
ssh aime_rsi_data 'cd /opt/eval_dashboard && ./backup_stats.sh run'   # 手动立即备份一份
```

## 改数据源

看板的数据根由 `EVAL_DATASETS` 决定（`build.py` 启动时读取，`deploy.env` 由
`deploy.sh` 写入）。改源 = 改 `deploy.env` 后重启，不能只改环境变量而不重启：

```bash
ssh aime_rsi_data 'cd /opt/eval_dashboard && vi deploy.env   # export EVAL_DATASETS=/new/root
  ./stop.sh && ./start.sh'
# 或重新发布：EVAL_DEPLOY_HOST=aime_rsi_data EVAL_DATASETS=/new/root EVAL_PRODUCTS=aime ./dashboard/deploy.sh
```

新根必须包含同样的布局（`<n>_<product>/eval_input`、`eval_output`、`stats.json`、
`user_rules.json`），否则看板会构建为空并保留旧 payload。备份目录只含统计/索引缓存，
**不能**直接当作 `EVAL_DATASETS` 使用。

当前弗吉尼亚看板的 `deploy.env` 是 `EVAL_DATASETS=/mnt/aime_eval_ssd`（产品目录 `1_aime`）。
5002 页面接口、5003 供数接口有各自的 `deploy.env`，本仓库的看板部署不会改它们；若也要切 SSD，
需分别按各自的 `deploy.sh` 重新发布。

> **数据更新链路**：乌兰 ↔ 弗吉尼亚的双向同步已停止，`scripts/aime_sync_loop.sh` /
> `scripts/sync_aime_ulan_to_va.py` 已删除。AIME 只在弗吉尼亚 SSD `/mnt/aime_eval_ssd` 维护；
> 不要再从乌兰或旧 HDD 同步数据回来。`scripts/daily_eval_progress.py` 已改为读 SSD。

## 进程守护（eval_supervisor）

两台服务器各跑一个 `scripts/eval_supervisor.sh`：每 30s 探一次 `/healthz`，挂了就在对应目录执行
`start.sh`，日志写 `/opt/eval_supervisor.log`；只拉起、不杀活着的进程（发布窗口的 stop/start 互不打架）。

```bash
# 安装/更新（脚本随仓库发布；配置按机器不同）
scp scripts/eval_supervisor.sh <host>:/opt/eval_supervisor.sh
ssh <host> 'chmod +x /opt/eval_supervisor.sh; cat > /opt/eval_services.conf <<EOF
dashboard|http://127.0.0.1:5001/healthz|/opt/eval_dashboard|./start.sh
page|http://127.0.0.1:5002/healthz|/opt/page_service/sample_details|./start.sh
analysis|http://127.0.0.1:5003/healthz|/opt/eval_analysis|./start.sh
EOF'
nohup /opt/eval_supervisor.sh >> /opt/eval_supervisor.log 2>&1 &   # 幂等，flock 单实例
```

- 配置格式：`name|health_url|workdir|start_cmd`；乌兰可列 5001/5002/5003（5003 用 `/opt/eval_analysis`）。
- 聚类矩阵 `/matrix/`、版本对比 `/compare/` 由 5002 同一进程提供（`page_service/problem_matrix`、
  `page_service/compare_details` 被 `sample_details/server.py` 导入），**不需要新增守护条目**。
- 维护 / 发布窗口先 `touch /opt/eval_supervisor.pause`，结束后 `rm`，避免守护进程在 stop 后把旧服务拉起来。
- **容器重启不会自动拉起**（镜像没有 cron / systemd）：重启后手动跑一次上面的 nohup，或把
  `nohup bash /opt/eval_boot.sh >/dev/null 2>&1 &` 追加到平台实例的启动命令（`scripts/eval_boot.sh` 可直接 scp 到 `/opt/`）。


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
| `ZoneInfoNotFoundError: America/New_York` | 容器重建后 `/usr/share/zoneinfo` 可能为空。从另一台容器复制 TZif 即可：`ssh aime_rsi_data 'cat /usr/share/zoneinfo/America/New_York' \| ssh eval_data 'mkdir -p /usr/share/zoneinfo/America && cat > /usr/share/zoneinfo/America/New_York'`，然后重启服务 |
| 部署卡在 `pip install brotli/orjson` | 容器无外网时 pip 会反复超时（两者都是可选项）。中断后手动执行 `./precompress.sh && ./stop.sh && ./start.sh` 即可 |
