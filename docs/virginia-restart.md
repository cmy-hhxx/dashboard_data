# 弗吉尼亚容器重启：准备与恢复

容器：`interactive-s3ynzadcvm9c`（`servers.conf` 里写的 `interactive-npasm9ch66eb` 是旧名，
容器重建过一次；**每次重建后主机名都会变**，跨容器调用只认平台当前给的容器名）。
SSH：`ssh aime_rsi_data`（10.217.219.2:2473），持久盘 `/mnt/aime_eval_ssd`（Ceph）。

## 结论先说

- **只有 `/mnt/aime_eval_ssd` 会活下来**：其它（`/opt`、`/run`、`/tmp`）容器一重建就回滚，
  守护脚本、`deploy.env`、看板前端产物、`cache/`（`build.sqlite3` + `samples.pkl`）、5003 索引全在其列。
  回滚后服务不会自动起（容器启动命令里只有 jupyter，没有 `eval_boot.sh`）。
- **每 2 小时自动快照**：`/mnt/aime_eval_ssd/.service_backup/snapshot-<ts>/opt/` 是整棵 `/opt`
  （代码 + `deploy.env` + 产物 + cache + 5003 索引），只保留最近 12 份，相邻快照用硬链接共享没变的文件
  （增量约 100–200 MB/次）。`build.sqlite3` 用 sqlite backup API 导出，避免拷到写一半的库。
  守护链：`eval_supervisor.sh` 每轮检查 `snapshot_loop.sh` 是否在跑，不跑就拉起来。
- **拉起只要一条命令**：`./scripts/virginia/bringup.sh` 从最新快照 rsync 回 `/opt/`，再起三个服务，
  **不用重新 deploy，也不用冷构建**（`cache/` 一起恢复）。

## 重启后一条命令

```bash
./scripts/virginia/bringup.sh            # 等 SSH → 查盘/查缺 → 按需回填 → 启动 → 冒烟
./scripts/virginia/bringup.sh --status   # 只看现状，不动手
```

脚本行为：
1. 轮询 SSH（最多 5 分钟）；不通就报「等平台拉起容器 / SSH 端口映射变了」。
2. 检查 `/mnt/aime_eval_ssd/1_aime` 是否挂上。
3. 逐项检查 `/opt`（守护脚本、deploy.env、三份代码、看板产物、cache、5003 索引），列出缺失。
4. 缺了就从最新快照回填整棵 `/opt`：`rsync -a --update snapshot-<ts>/opt/ /opt/`
   （`--update` 保证服务自己生成的新文件不会被旧快照覆盖）。老布局快照
   （`config/` + `dashboard-static/` + `analysis-state/`）仍兼容。
5. 回填后代码仍缺（快照里也没有）才跑三个 `deploy.sh`（dashboard / 5002 / 5003）。
6. 依次起 5001 → 5002 → 5003，轮询 `/healthz` 到 200（5001 冷构建要几分钟，预热期返回 503）。
7. 拉起 `/opt/eval_supervisor.sh`（30s 巡检、掉线自动重启）。
8. 冒烟：三个容器内 `/healthz` + 5003 `/severity`，再验对外 2475 / 2476 / 2477。

## 备份在哪、怎么更新

```bash
# 立即做一份快照（服务运行时也能跑，只读 /opt）
ssh aime_rsi_data /mnt/aime_eval_ssd/.service_backup/snapshot_remote.sh
# 定时循环：每 2 小时一份，保留 12 份（滚动删最旧）
ssh aime_rsi_data 'nohup bash /mnt/aime_eval_ssd/.service_backup/snapshot_loop.sh >> /opt/eval_snapshot.log 2>&1 &'
# 本地同一份脚本：scripts/virginia/snapshot_remote.sh + snapshot_loop.sh
```

一份快照约 1G / 2000 个文件（`cache/` 随构建涨到 6G），含 `MANIFEST.tsv`（大小 + mtime + 路径），
重启后可直接对比丢了什么。相邻快照 `--link-dest` 硬链接，实测第二份只多 140M / 22 秒。
`build.sqlite3` 走 sqlite backup API（直接 rsync 一个正在写的库会拷到坏文件）；
`logs/`、`*.pid`、`__pycache__`、`cache/*.tmp`、`build.lock` 不进快照。

## 常见坑

- **服务起来了但页面 502**：5002 依赖 5001 的 `127.0.0.1:5001`，必须先起 5001。
- **5003 `latest_seq` 归零 / 业务方收到 409 SYNC_RESET**：`state/cursor.key` 没恢复。
- **容器重建后 SSH 直接不通**：实例的端口映射可能变了，看平台控制台，不要盲试。
- **`/opt` 回滚后 supervisor 也不在**：`eval_boot.sh` 一起丢，只能手工跑一次；
  想彻底免手工，需要把 `nohup bash /opt/eval_boot.sh >/dev/null 2>&1 &` 追加到平台实例启动命令末尾
  （容器内改不了，得在平台上改）。

## 时间预期

| 场景 | 耗时 |
|---|---|
| `/opt` 完好，只是进程没了 | 10–20 秒 |
| `/opt` 回滚，从快照回填 | 约 1–3 分钟（含 630M 还原 + 起服务） |
| 连快照都没了 | 冷构建 3–5 分钟起（`/healthz` 在预热期是 503） |

## 实测记录

**2026-11-17 14:58（容器重建，不是 stop/start）**
- 现象：主机名从 `interactive-s3ynzadcvm9c-5b48b7b9bc-c6wtq` 变成 `...-6f4c8b7959-hq2sc`，
  `/opt` 整目录回滚：守护脚本、`deploy.env`、看板产物、`cache/`（6.1G）、5003 索引全没了。
- `bringup.sh` 走的是「代码缺失 → 重新 deploy」分支，快照回填在前、deploy 在后；
  由于 deploy 的 rsync 用 `--exclude '/static/*.json'`，回填的产物没被覆盖。
- 结果：三服务 11:35 内全部就绪；5003 `latest_seq=162306` 与重启前一致（位点没丢，业务方不用全量重同步）；
  看板冷重建 06:58→07:05 约 7 分钟（机器 load 30+），期间用回填的旧产物正常出图。
- 坑：`bringup.sh` 早期版本的 supervisor 探活用 `pgrep -f`，远端命令行里含同样的字符串，
  自匹配导致误判「已在跑」而跳过启动；已改为直接拉起（脚本本身用 flock 幂等）。
- 另一个坑：外部端口 2475/2476/2477 从本机测有 30–40% 连不上，一度误判成服务问题。
  实测**同 IP 的 SSH 2473、2554 也一样抖**，ICMP 0% 丢包，而乌兰 117.50.195.94 全通 ——
  是本机到 `10.217.219.2` 的 TCP 新连接链路问题（文档里记的「集群边缘间歇拒绝」），
  与容器内服务无关；容器内三个 `/healthz` 恒 200。排查时先用容器内 `127.0.0.1` 判定服务死活，
  不要用外部端口下结论。
