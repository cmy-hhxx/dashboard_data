# 弗吉尼亚容器重建：备份与恢复

主机 `10.217.219.2:2473`（`ssh aime_rsi_data`），容器 `interactive-s3ynzadcvm9c`（**每次重建后主机名会变**），持久盘 `/mnt/aime_eval_ssd`（Ceph）。

## 1. 机制结论

- **仅 `/mnt/aime_eval_ssd` 持久化**：容器重建会清空 `/opt`、`/run`、`/tmp`（守护脚本、`deploy.env`、三套服务代码、看板产物与 `cache/`、5003 索引），且不会自动拉起服务。
- **每 2 小时自动快照**：`snapshot_loop.sh` 将整棵 `/opt` 硬链接快照至 `/mnt/aime_eval_ssd/.service_backup/snapshot-<ts>/opt/`（保留最近 12 份，`build.sqlite3` 走 SQLite backup API 导出，排除 `logs/`、`*.pid`、`__pycache__`、`build.lock`）；`eval_supervisor.sh` 会自动保活该循环。
- **一条命令恢复**：重建后在本地执行 `./scripts/virginia/bringup.sh`，直接从最新快照回填 `/opt` 并拉起 5001/5002/5003，免重新 deploy 与冷构建。

## 2. 恢复与备份命令

```bash
# 容器重建后拉齐三服务（本地执行）
./scripts/virginia/bringup.sh            # 等 SSH → 查盘/缺口 → 快照回填 → 启动 → 冒烟
./scripts/virginia/bringup.sh --status   # 只查现状，不改动

# 手动立即快照 / 拉起快照循环（远端执行）
ssh aime_rsi_data /mnt/aime_eval_ssd/.service_backup/snapshot_remote.sh
ssh aime_rsi_data 'nohup bash /mnt/aime_eval_ssd/.service_backup/snapshot_loop.sh >> /opt/eval_snapshot.log 2>&1 &'
```

`bringup.sh` 执行顺序：
1. 轮询 SSH（最多 5 分钟）并确认 `/mnt/aime_eval_ssd/1_aime` 已挂载。
2. 检查 `/opt` 缺失项；有缺则 `rsync -a --update snapshot-<ts>/opt/ /opt/` 回填（不覆盖更新的文件）。
3. 回填后仍缺代码时才自动调用三套 `deploy.sh`。
4. 按 **5001 → 5002 → 5003** 顺序启动并轮询 `/healthz` 至 200（5001 冷构建预热期返回 503）。
5. 拉起 `/opt/eval_supervisor.sh`（30s 探活、掉线自动重启，flock 单实例幂等）。
6. 冒烟验证容器内 `127.0.0.1` 的 5001/5002/5003 `/healthz` 与 5003 `/severity`，再验对外 2475/2476/2477。

## 3. 耗时预期

| 场景 | 预计耗时 |
|---|---|
| `/opt` 完好，仅进程退出 | 10–20 秒 |
| `/opt` 回滚，快照回填 | 1–3 分钟 |
| 无快照，全量 deploy + 冷构建 | 3–7 分钟 |

## 4. 常见坑

- **启动顺序**：5002 强依赖 `127.0.0.1:5001`，必须先起 5001 再起 5002，否则 502。
- **5003 变更位点**：必须恢复 `state/cursor.key` 与索引，否则 `latest_seq` 归零导致消费方收到 `409 SYNC_RESET`。
- **SSH 不通或外网端口间歇失败**：先检查平台是否变更了端口映射；弗吉尼亚外网 TCP 新连接存在边缘抖动，判断服务死活一律以容器内 `127.0.0.1` 为准。
- **免手工开机自启**：需在平台实例启动命令末尾追加 `nohup bash /opt/eval_boot.sh >/dev/null 2>&1 &`。
- **附带恢复**：用户 KYC 同步循环需手动补跑 `ssh aime_rsi_data 'bash /mnt/aime_eval_ssd/1_aime/user_kyc/start_sync.sh'`。
- **人话服务与数据**：人话翻译服务已迁出弗吉尼亚（不再部署 `/opt/human_read_service`，也不随容器恢复）；译文数据仍在 `/mnt/aime_eval_ssd/1_aime/eval_output/human_read/`，由外部服务持续更新。看板 5001 只读叠层，**禁止删除该目录**。
