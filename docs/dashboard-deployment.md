# 看板部署与运行

`dashboard/` 的远程部署、端口和运维说明。相关脚本：`deploy.sh`（一键发布）、
`start.sh` / `stop.sh`（起停）、`precompress.sh`（静态资源预压缩）、`server.py`（HTTP 服务与定时刷新）。

## 部署拓扑

| 项 | 值 |
|---|---|
| SSH | 本地 SSH 配置中的部署主机（默认别名 `eval_data`） |
| 本地 SSH 别名 | `eval_data`（见 `~/.ssh/config`；主机、端口与密钥都在本地配置，不入库） |
| 远端目录 | `/opt/eval_dashboard` |
| 服务监听 | 容器内 `0.0.0.0:5001` |
| 对外地址 | 由部署环境决定（示例：`http://<dashboard-host>:<port>/`） |
| 端口映射 | 容器 `5001` → 对外端口（见本地 `servers.conf`） |
| 运行环境 | 容器内 Python 3.12；只用标准库，无需 `pip install` / venv |

仓库不包含 `servers.conf`，它是本地未跟踪配置（已加入 `.gitignore`）。`deploy.sh` 默认使用
SSH 别名 `eval_data`；也可以用 `EVAL_DEPLOY_HOST` / `EVAL_DEPLOY_PORT` / `EVAL_DEPLOY_KEY` /
`EVAL_DEPLOY_REMOTE` 覆盖，端口与密钥未设置时由 `~/.ssh/config` 管理。外部 `:5001`
不可直连，排查时一律在容器内访问 `127.0.0.1:5001`。

## 快速部署

前置条件：本地有 `ssh`、`rsync`，并已配置部署主机的 SSH 别名（默认 `eval_data`）；
在仓库根目录执行。

```bash
./dashboard/deploy.sh
```

脚本按固定顺序完成：

1. 建远端目录 `static/`、`logs/`。
2. `rsync -az --delete` 同步代码，排除生成物与运行态：`data.json`、`data-*.json`、
   `samples.json`、`samples-*.json`（含 `.gz`）、`static/samples/`、`logs/`、`server.pid`、
   `stats.pid`、`local_dev/`、`tests/`、`__pycache__`、`*.log`、`cache/`。
3. 远端按需安装可选加速器 `orjson`（失败不影响发布）。
4. 远端执行 `build.py --keep-on-empty`（上限 1800 秒），增量生成
   `static/data.json`（共享壳）、`static/data-<product>.json`、`static/samples.json`（产品清单）、
   `static/samples-<product>.json`，均带 `.gz`；逐样本详情不再由 build 全量写。
5. `precompress.sh` 为 JS/CSS/HTML/SVG 生成 `.gz`。
6. `stop.sh` 停旧进程，`start.sh` 拉起新进程（server + stats worker）。
7. 输出 `deployed -> /opt/eval_dashboard`。

耗时主要在第 4 步的数据构建，文件同步本身很小。首次接入或删除 `cache/` 后需要全量扫描输入
（当前约 44 GB），之后只扫新增/变化的文件；`stats_worker.py` 维护的 `<datasets>/stats.json`
会把已扫描文件的输入统计变成旁路，只信任仍匹配 `(size, mtime_ns)` 的条目。
构建失败**不会中断部署**，只会在 `logs/build.log` 留记录，服务继续用上一次生成的数据；
因此每次部署后都要看这个日志。

验证：

```bash
curl -s "http://<dashboard-host>:<port>/healthz" | jq
```

`healthz` 始终返回 HTTP 200，必须看 JSON 内容：

| 字段 | 含义 |
|---|---|
| `ok` / `error` | 最近一次 `build.py` 是否成功 |
| `running` | 是否正在构建 |
| `last_refresh` / `refresh_seconds` | 最近一次构建完成的 epoch 秒与耗时 |
| `build` | `build.py` 输出的构建摘要（如 `pairs`；保留旧数据时含 `kept_previous`） |

正常应看到 `ok=true`、`error` 为空、`build.pairs` 大于 0。随后打开
`http://<dashboard-host>:<port>/` 确认页面。

单独起停：

```bash
ssh eval_data 'cd /opt/eval_dashboard && ./start.sh'
ssh eval_data 'cd /opt/eval_dashboard && ./stop.sh'
```

`start.sh` 会先探测 `127.0.0.1:5001/healthz`；只要有响应就打印 `already serving on :5001` 并退出，
不会重启；但它会先确保 `stats_worker.py` 已启动。需要重载时用 `stop.sh && ./start.sh`
（`deploy.sh` 已包含）。`stop.sh` 先按 `server.pid` 终止 server，再停 `stats.pid`，2 秒内未退出则
`kill -9`，并清理 cwd 指向部署目录的孤儿 `server.py` / `stats_worker.py`。

## 运行时行为

- 启动时若 `data.json`、`data-<product>.json`、`samples.json`、`samples-<product>.json`
  或 `samples/` 缺失，先同步构建一次。
- 调度线程每 `REFRESH_SECONDS`（默认 1800 秒 / 30 分钟）执行一次 `build.py --keep-on-empty`。
  启动时如果 `data.json` 已超过 2 分钟没有更新，会先立即构建一轮；`deploy.sh` 或 `start.sh` 刚构建过时跳过。
- 可用环境变量覆盖 `PORT`（默认 5001）和 `REFRESH_SECONDS`。
  注意 `start.sh` 启动时写死 `PORT=5001`，要改监听端口需同时改 `start.sh` 或手动启动。
- 数据源为空（例如挂载失效）而上一份数据非空时，`--keep-on-empty` 不写任何文件，healthz 的
  `build.kept_previous` 会给出保留的组数。只有手动执行不带参数的 `build.py`，才会写出空数据。
- `precompress.sh` 为 JS/CSS/HTML/SVG 生成 `.gz`；`build.py` 为共享 data、产品 data、
  产品 samples 写出 `.gz`。客户端支持 gzip 时 `server.py` 直接发送；发送前用 gzip ISIZE
  校验压缩包与源文件大小一致，不一致则回退原始文件，避免旧 `.gz` 冒充新数据。
  改过 `static/` 下的 JS/CSS/HTML/SVG 后必须重新执行 `precompress.sh`（`deploy.sh` 会自动做）。
- 样本详情 `/samples/<slug>.json` 由 `server.py` 在首次请求时调用 `detail_builder.py` 生成，
  同时写 `.json` + `.gz`；之后就是普通静态文件。详情缓存目录可安全清空，下一次访问会重建。
  首次请求约 0.6–4 秒（取决于 ceph 随机读），已打开过的样本走静态缓存；服务启动/每轮
  build 后会在后台预热每个产品首屏约 30 条 + 最近 10 条（`DETAIL_PREWARM` 可调，0 关闭）。
- 缓存头：`/healthz` 为 `no-store`，其余全部为 `no-cache`（可以用 304 重新验证）。
- 日志：`logs/server.log` 记录服务输出，`logs/build.log` 记录部署时的构建；仓库没有日志轮转。
- 构建缓存是 `cache/build.sqlite3`（文件索引、配对、样本摘要与复用标记）；`deploy.sh` 的 rsync 会保留
  这个目录。按文件 `(size, mtime_ns)` 失效，追加写只从最后一个完整换行继续扫描；输入行数、
  task/subtask、tools/tokens 与流失标记都在同一遍扫描里完成。cluster 内容签名缓存在
  `cache/cluster-signature.json`，cluster 映射 pickle 在 `cache/clusters-<sig>.pkl`；
  样本摘要另存 `cache/samples.pkl`（约 320 MB，按 DB 的 fp/oh 校验，删除后回退 SQLite 全量加载）。
- 当前全量约 16,000 个样本；构建不再写逐样本详情。2026-11-03 实测：连续增量 27–40 秒，
  首次全量摘要 225–267 秒（含一次性输出行号索引），冷全量预计 4–5 分钟；详情首次打开
  0.6–4 秒，之后静态缓存。删除 `cache/` 会强制全量重建；部署时可以预先把已验证的
  `cache/` 同步过去，跳过首轮扫描。
- `stats_worker.py` 每 30 分钟刷新 `<datasets>/stats.json`；日志在 `logs/stats.log`。
  该文件只用于加速 build，删除后 build 会局部重扫。`start.sh` / `stop.sh` 管进程。

## 部署最佳实践

1. **只通过 `deploy.sh` 发布**：远端部署目录不是 git 仓库，`rsync --delete` 会删掉远端多出来的文件。
   在远端手改的内容下次部署就会消失；回滚应从本地切回旧 commit 后重新部署。
2. **生成物留在远端**：`data.json`、`data-*.json`、`samples.json`、`samples-*.json`、
   `samples/`、`cache/`、`logs/` 已排除同步。
   数据在服务器侧生成，避免本地旧数据覆盖远端，也避免传输大文件。
3. **先构建、后重启**：不要打乱 `deploy.sh` 的顺序，也不要在 `build.py` 未完成时手动 `start.sh`。
   构建失败时服务会带着旧数据启动，必须看日志，不能只看「启动成功」。
4. **看 healthz 内容，不只看状态码**：`healthz` 永远 200；`ok=false` 时看 healthz 的 `error`
   与 `logs/build.log`。
5. **样式直接改 `static/`**：没有前端构建步骤，改完 `static/` 下的 JS/CSS 直接部署（`deploy.sh` 会重新预压缩）。
6. **强制刷新数据**：重启服务，或在远端执行 `python3 build.py --keep-on-empty`。
7. **改端口要三处同步**：`server.py` / `start.sh` 的监听端口、容器平台端口映射、
   本地 `servers.conf` 的 `dashboard_port_1`。对外端口按部署环境配置，不要把 `5001` 直接暴露。
8. **预测数据放在产品目录**：`datasets/<产品>/prediction.json` 在下一轮构建时生效，格式见
   `docs/prediction-data.md`。
9. **没有进程守护**：服务由 `nohup` 启动（父进程已是容器 init），目前没有 cron / systemd
   自启动配置；容器或环境重启后需要手动执行 `start.sh`。若要自动恢复，需在容器平台的启动命令里
   补这一步（仓库内没有该配置）。
10. **日志无轮转**：`logs/` 不参与同步，也不会被部署清空；长期运行需定期清理，避免占满磁盘。
11. **不要并发部署**：两个 `deploy.sh` 同时执行会在 rsync / 重启阶段互相覆盖，发布前确认没有
    其他部署正在进行。

## 故障排查

| 现象 | 处理 |
|---|---|
| 外网打不开 / 502 | `ssh eval_data` 后 `curl -s http://127.0.0.1:5001/healthz`；看 `logs/server.log`；`./start.sh` |
| `ok=false` | 看 healthz 的 `error` 与 `logs/build.log` 最后一段；修复后重启触发重算 |
| `build.kept_previous` 出现 | 数据源为空，确认 `datasets` 挂载；恢复后下一轮自动重建 |
| `start.sh` 说 already serving 但页面没更新 | `./stop.sh && ./start.sh` |
| 静态资源没更新 | 确认远端 `.gz` 已由 `precompress.sh` 重新生成 |
| 数据停留在旧日期 | 看 healthz 的 `last_refresh`；重启触发立即扫描；确认 `datasets` 挂载可读 |
