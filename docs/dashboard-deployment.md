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

1. 建远端目录 `static/`、`cache/`、`logs/`。
2. `rsync -az --delete` 同步代码，排除生成物与运行态：`data.json`、`samples.json`、
   `static/samples/`、`cache/`、`logs/`、`server.pid`、`build/`、`__pycache__`、`*.log`。
3. 远端执行 `prepare.py --counts cache/datasets.json`，生成 `static/data.json`。
4. 远端执行 `prepare_samples.py`，生成 `static/samples.json` 与逐样本详情 `static/samples/`。
5. `precompress.sh` 为 JS/CSS/HTML/SVG 生成 `.gz`。
6. `stop.sh` 停旧进程，`start.sh` 拉起新进程。
7. 输出 `deployed -> /opt/eval_dashboard`。

耗时主要在 3、4 两步的数据构建（脚本上限分别为 300 秒和 900 秒），文件同步本身很小。
这两步失败**不会中断部署**，只会在 `logs/prepare.log` / `logs/samples.log` 留记录，服务继续用上一次
生成的数据（首次部署则等启动后的首轮刷新）；因此每次部署后都要看这两个日志。

验证：

```bash
curl -s "http://<dashboard-host>:<port>/healthz" | jq
```

`healthz` 始终返回 HTTP 200，必须看 JSON 内容：

| 字段 | 含义 |
|---|---|
| `ok` / `error` | 最近一次 `scan + prepare` 是否成功 |
| `last_refresh` / `refresh_seconds` | 最近刷新完成的 epoch 秒与耗时 |
| `samples_ok` / `samples_error` | 样本生成状态 |
| `samples_last` / `samples_seconds` | 样本最近生成时间（epoch 秒）与生成耗时 |

正常应看到 `ok=true`、`samples_ok=true`、两个 `error` 为空。随后打开
`http://<dashboard-host>:<port>/` 确认页面。

单独起停：

```bash
ssh eval_data 'cd /opt/eval_dashboard && ./start.sh'
ssh eval_data 'cd /opt/eval_dashboard && ./stop.sh'
```

`start.sh` 会先探测 `127.0.0.1:5001/healthz`；只要有响应就打印 `already serving on :5001` 并退出，
不会重启。需要重载时用 `stop.sh && ./start.sh`（`deploy.sh` 已包含）。`stop.sh` 先按 `server.pid`
终止，2 秒内未退出则 `kill -9`，并清理 cwd 指向部署目录的孤儿 `server.py`。

## 运行时行为

- 启动时若 `data.json` 或 `samples.json` 缺失，先同步构建一次。
- 调度线程在启动后**立即**执行一轮 `scan_datasets.py + prepare.py`，之后每 `REFRESH_SECONDS`
  （默认 1800 秒 / 30 分钟）执行一次。
- 样本最多每 `SAMPLES_REFRESH_SECONDS`（默认 21600 秒 / 6 小时）重建一次；文件缺失时立即重建。
- 可用环境变量覆盖 `PORT`（默认 5001）、`REFRESH_SECONDS`、`SAMPLES_REFRESH_SECONDS`。
  注意 `start.sh` 启动时写死 `PORT=5001`，要改监听端口需同时改 `start.sh` 或手动启动。
- 样本源目录为空时，`prepare_samples.py` 写出空的 `samples.json`，并清理旧样本详情，
  页面显示待接入空态。数据刷新严格反映当前数据源。
- `precompress.sh` 为 JS/CSS/HTML/SVG 生成 `.gz`；`prepare.py` / `prepare_samples.py` 为
  `data.json`、`samples.json` 与逐样本详情同时写出 `.gz`。客户端支持 gzip 时 `server.py`
  直接发送；发送前用 gzip ISIZE 校验压缩包与源文件大小一致，不一致则回退原始文件，避免旧
  `.gz` 冒充新数据。改过 `static/` 下的 JS/CSS/HTML/SVG 后必须重新执行 `precompress.sh`
  （`deploy.sh` 会自动做）。
- 缓存头：`/healthz` 为 `no-store`；`/data.json`、`/samples.json`、`/`、`/index.html`、
  `/samples/` 详情与其余静态文件为 `no-cache`（可 304 重验证）；`/vendor/` 与
  `/echarts.min.js` 为一年 `immutable`。
- 日志：`logs/server.log`（服务输出）、`logs/prepare.log`、`logs/samples.log`；仓库没有日志轮转。

## 部署最佳实践

1. **只通过 `deploy.sh` 发布**：远端部署目录不是 git 仓库，`rsync --delete` 会删掉远端多出来的文件。
   在远端手改的内容下次部署就会消失；回滚应从本地切回旧 commit 后重新部署。
2. **生成物留在远端**：`data.json`、`samples.json`、`samples/`、`cache/`、`logs/` 已排除同步。
   数据在服务器侧生成，避免本地旧数据覆盖远端，也避免传输大文件。
3. **先构建、后重启**：不要打乱 `deploy.sh` 的顺序，也不要在 `prepare` 未完成时手动 `start.sh`。
   构建失败时服务会带着旧数据启动，必须看日志，不能只看「启动成功」。
4. **看 healthz 内容，不只看状态码**：`healthz` 永远 200；`ok=false` 查 `logs/prepare.log`，
   `samples_ok=false` 查 `logs/samples.log`。
5. **改样式先处理构建产物**：直接改 `static/` 下的 JS/CSS 可以直接部署；改 Tailwind 输入
   （`dashboard/build/`）要先在本地生成 `static/app.css`，因为 `build/` 不参与同步：

   ```bash
   cd dashboard/build
   npx tailwindcss -c tailwind.config.js -i input.css -o ../static/app.css --minify
   ```

6. **强制刷新数据用重启**：`deploy.sh` 里的 `prepare.py` 用的是 `cache/datasets.json` 的缓存计数；
   服务启动后调度线程会立即重新 `scan` 再 `prepare`。需要强制重建样本时，先删
   `static/samples.json` 与 `static/samples/` 再重启。
7. **改端口要三处同步**：`server.py` / `start.sh` 的监听端口、容器平台端口映射、
   本地 `servers.conf` 的 `dashboard_port_1`。对外端口按部署环境配置，不要把 `5001` 直接暴露。
8. **升级 ECharts 要换文件名或加版本**：`/echarts.min.js` 和 `/vendor/` 带一年 `immutable`
   缓存，同路径覆盖后老客户端一年内可能不更新。
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
| `ok=false` | 看 `logs/prepare.log` 最后一段；修复后重启触发重算 |
| `samples_ok=false` | 看 `logs/samples.log`；删 `static/samples.json` 与 `static/samples/` 后重启可强制重建 |
| `start.sh` 说 already serving 但页面没更新 | `./stop.sh && ./start.sh` |
| 静态资源没更新 | 确认远端 `.gz` 已重新生成；ECharts 按最佳实践第 8 条处理缓存 |
| 数据停留在旧日期 | 看 healthz 的 `last_refresh`；重启触发立即扫描；确认 `datasets` 挂载可读 |
