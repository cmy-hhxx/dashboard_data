# 弗吉尼亚容器重建：备份与恢复

主机 `10.217.219.2:2473`（`ssh aime_rsi_data`），容器重建后主机名会变；仅 `/mnt/aime_eval_ssd`（CephFS）持久化，`/opt`（含 `/opt/pgdata`）、`/run`、`/tmp` 会随容器清空且不自启服务。

## 1. 容灾架构

- **PG 16 本地盘 + 持久盘备份**：PostgreSQL 16 运行在本地 `/opt/pgdata`；`pg_maintenance_loop.sh` 每日做压缩 `pg_basebackup`（保留 3 天），PG 每 60s 归档压缩 WAL 到 `/mnt/aime_eval_ssd/1_aime/.pg_backup/{base,wal}/`（总计 < 2 GB）；凭据备份于 `.service_backup/pg_secrets.env`（`600` 权限）。
- **尾部零丢自愈**：Data Core 遵循 Blob-First 写铁律；重建 PITR 恢复后自动执行 `reconcile_tails()`，扫描活跃 `.jsonl.zst` 超过 `committed_bytes` 的完整帧幂等回灌 PG，并释放过期 Step 2 租约。
- **每 2 小时 `/opt` 快照**：`snapshot_loop.sh` 将服务代码、`deploy.env`、看板静态 JSON（不含 `/opt/pgdata` 与 `.pg_secrets.env`）硬链接快照至 `/mnt/aime_eval_ssd/.service_backup/snapshot-<ts>/opt/`（保留 12 份）；`eval_supervisor.sh` 自动保活快照与 PG 维护循环。

## 2. 一键恢复与手动备份命令

```bash
# 容器重建后一键拉齐 PG 16 + 三服务（本地执行）
./scripts/virginia/bringup.sh            # 等 SSH → 查盘 → 回填 /opt → 恢复 PG 16 → 启动 → 冒烟
./scripts/virginia/bringup.sh --status   # 只查现状，不改动

# 远端手动快照 / 立即做一次 PG 压缩基备 / 隔离灾备演练
ssh aime_rsi_data /mnt/aime_eval_ssd/.service_backup/snapshot_remote.sh
ssh aime_rsi_data 'bash /opt/pg_data_core/scripts/pg_basebackup.sh'
ssh aime_rsi_data 'bash /opt/pg_data_core/scripts/dr_drill.sh'
```

`bringup.sh` 执行顺序：
1. 轮询 SSH（最多 5 分钟）并确认 `/mnt/aime_eval_ssd/1_aime` 已挂载。
2. 回填 `/opt` 缺失项（`rsync -a --update snapshot-<ts>/opt/ /opt/`），同步守护脚本。
3. **恢复 PostgreSQL 16**：若 `/opt/pgdata` 缺失则调用 `pg_rebuild_restore.sh`（自动安装 PG 16 + 驱动 → PITR 回放 `base/latest` + `wal/*.zst` → 重写 `aime.conf` 与 `.runtime/pg_endpoint.json` → `reconcile_tails()` → 拉起 `pg_maintenance_loop.sh`）。
4. 若代码仍缺则自动重发 `pg_data_core` / 5001 / 5002 / 5003 / `internal_eval`。
5. 按 **5001 → 5002 → 5003** 顺序启动并等待 `/healthz` 200，拉起 `eval_supervisor.sh` 与 `snapshot_loop.sh`。
6. 冒烟验证 PG 16、内网 `127.0.0.1:{5001,5002,5003}`（含 Data Core / Internal Eval / severity）及外网 `2475/2476/2477`。

## 3. 耗时预期

| 场景 | 预计耗时 |
|---|---|
| `/opt` 与 `/opt/pgdata` 完好，仅进程退出 | 15–30 秒 |
| 容器重建，PG PITR 恢复 + `/opt` 快照回填 | 2–4 分钟 |
| 无快照，PG 恢复 + 全量 deploy + 冷构建 | 4–7 分钟 |

## 4. 常见坑

- **启动顺序**：必须先恢复 PG 16，再依次起 **5001 → 5002 → 5003**（5002 强依赖 5001）。
- **5003 变更位点**：由 PG `changes` 表与 `db_epoch` 持久化，PITR 恢复后 `latest_seq` 自动延续，不会误触发 `409 SYNC_RESET`。
- **SSH / 外网抖动**：弗吉尼亚外网 TCP 新连接存在边缘抖动，判断服务状态一律以容器内 `127.0.0.1` 为准。
- **开机自启**：在平台实例启动命令末尾追加 `nohup bash /opt/eval_boot.sh >/dev/null 2>&1 &`。
- **KYC 同步**：容器重建后按需拉起 `ssh aime_rsi_data 'bash /mnt/aime_eval_ssd/1_aime/user_kyc/start_sync.sh'`。
