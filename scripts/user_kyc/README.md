# 用户 KYC 库（使用与运维手册）

位于弗吉尼亚 `/mnt/aime_eval_ssd/1_aime/user_kyc/`：从 `0_daily_eval_input` 抽取 `user_id` 拉取脱敏 KYC 画像并落 SQLite（WAL），每 6 小时增量更新。设计说明见 `eval_data_server/docs/用户KYC库.md`。

## 1. 数据位置与交付物

| 路径 | 说明 |
|---|---|
| `kyc.sqlite3`（含 `-wal`/`-shm`） | **只读主库**（约 200 MB，权限 `644`，**不要写入、不要手删 `-wal/-shm`**） |
| `export/kyc_profiles-<日期>.jsonl.gz` | `status=ok` 画像快照（一行一用户，脱敏 JSON） |
| `export/kyc_users-<日期>.csv.gz` | 全量用户状态与活动度快照（不含 profile） |
| `export/MANIFEST.json` | 导出行数、大小、sha256 与口径清单 |
| `kyc_store.py` / `kyc.py` / `kyc_sync.py` | Python 查询库 / CLI 查询 / 增量同步 |

> 仅覆盖出现于 `0_daily_eval_input` 的用户，实时规模执行 `python3 kyc.py stats`。需要实时查未入库用户，调用冻结单文件：`python3 /mnt/aime_eval_ssd/0_litefusion_data/kyc_query/kyc_query.py <uid>`（限速 ≤ 5 QPS）。

## 2. 查询用法（Python / CLI / SQL）

```python
import json, sqlite3
conn = sqlite3.connect("file:/mnt/aime_eval_ssd/1_aime/user_kyc/kyc.sqlite3?mode=ro", uri=True)
conn.row_factory = sqlite3.Row
row = conn.execute("SELECT user_id, status, fetched_at, profile FROM users WHERE user_id=?", ("1808221539",)).fetchone()
profile = json.loads(row["profile"]) if row and row["status"] == "ok" else None
# 也可用：sys.path.insert(0, "/mnt/aime_eval_ssd/1_aime/user_kyc"); import kyc_store; conn = kyc_store.connect(readonly=True)
```

```bash
cd /mnt/aime_eval_ssd/1_aime/user_kyc
python3 kyc.py get 1808221539                                     # 单用户（cat ids.txt | python3 kyc.py get - 批量）
python3 kyc.py search --section risk_preference --day-from 2026-11-01 --limit 20
python3 kyc.py search --q "黄金" --format jsonl                   # ≥3 字符走 trigram FTS；1–2 字退回 LIKE
python3 kyc.py path goals.asset_protection --limit 20             # 点路径取字段（支持 [n]）
python3 kyc.py export                                             # 生成带日期的 export/ 快照
```

`search` 支持：`--status`（默认 `ok`，可 `any`）、`--q`、`--section`、`--model`、`--day-from`/`--day-to`、`--min-traces`、`--fields`、`--limit`/`--offset`、`--format table|json|jsonl|csv`。批量 SQL `IN (...)` 每次建议 ≤ 900 个 id。

## 3. 表结构与口径

- **主表 `users`**：`user_id`（主键）、`user_id_fp`（16 位对外指纹）、`is_real`（纯 ASCII 数字 ≤ 10 位）、`status`、`error`、`attempts`、`fetched_at`（UTC）、`first_day`/`last_day`、`n_traces`、`models`（`,aime_fast,aime_expert,`）、`profile`（脱敏 JSON）、`profile_bytes`、`n_sections`、`kyc_create_time`/`kyc_update_time`。
- **辅助表**：`user_days(user_id, day, model → n_traces)`、`user_sections(user_id, section, n_bytes)`、`profile_fts`（FTS5 trigram）、`meta`（`last_scan_at`/`last_fetch_at`）、`files`/`file_contrib`。
- **`status` 语义**：`ok` 有画像；`empty` 接口无画像（非错误）；`leak` 脱敏检测拦截（按无数据处理）；`skipped` 非真实 id；`pending` 待拉；`error` 网络失败（自动重试 ≤ 5 次）。
- **脱敏与树结构**：金额/数量/比例打星号，身份凭证丢弃，时间精确到 `YYYY-MM`；顶层树因用户而异，用 `user_sections` 筛、用 `json_extract` 取值。时间均为 **UTC**（汇报 +8）。

## 4. 同步与运维

```bash
bash start_sync.sh                     # 拉起每 6h 循环（--retry-errors --refresh-days 30，≤4 QPS，flock 单实例）
pgrep -af "[k]yc_sync.py loop"         # 查看进程；日志 tail -f logs/sync.log
pkill -f "[k]yc_sync.py loop"          # 停止循环
python3 kyc_sync.py run                # 手动执行一次增量扫描 + 拉取（另有 scan / import-legacy / fetch / status）
```

- **增量扫描**：`size+mtime+ctime` 不变跳过；追加只读尾巴；重写整文件重扫并重算活动度。
- **发布 / 重启 / 备份**：本机跑 `scripts/user_kyc/deploy.sh` 后重启 loop；容器重置后手动补跑 `bash start_sync.sh`；**禁止直接 `cp kyc.sqlite3`**，备份用 SQLite backup API 或 `python3 kyc.py export`。
- **排错**：`已有另一个 sync 在跑` 表示 loop 正持有 flock；`last_scan_at` 过期时重启 `start_sync.sh`；需要对外脱敏交付时只给 `export/` 下文件并按 `MANIFEST.json` 校验 sha256（必要时以 `user_id_fp` 替代 `user_id`）。
