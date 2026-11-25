# 用户 KYC 库与即用即查（弗吉尼亚）

将 `daily eval input` 中出现的 `user_id` 批量拉取 KYC 画像、脱敏后落入可查询 SQLite 库，同时保留独立实时即查脚本。部署于弗吉尼亚 `/mnt/aime_eval_ssd/1_aime/user_kyc/`（服务器同目录 [scripts/user_kyc/README.md](../scripts/user_kyc/README.md) 供使用方与运维直接查用）。

## 1. 两种查询方式

| 方式 | 位置 | 适用场景 |
|---|---|---|
| **离线 SQLite 库（推荐）** | `/mnt/aime_eval_ssd/1_aime/user_kyc/kyc.sqlite3` | 仅含 `0_daily_eval_input` 出现过的用户；免重复请求，支持按树/日期/全文反查 |
| **实时即用即查（冻结单文件）** | `/mnt/aime_eval_ssd/0_litefusion_data/kyc_query/kyc_query.py` | 未进库用户或需实时值；零外部依赖，不落盘，建议 QPS ≤ 5 |

```bash
# 离线库 CLI
cd /mnt/aime_eval_ssd/1_aime/user_kyc
python3 kyc.py get 1808221539
python3 kyc.py search --section risk_preference --day-from 2026-11-01 --limit 20
python3 kyc.py search --q "黄金" --format jsonl
python3 kyc.py path goals.asset_protection --limit 20
python3 kyc.py stats && python3 kyc.py export

# 实时即查（独立冻结版，仅海外远端可访问内部 KYC 接口）
python3 /mnt/aime_eval_ssd/0_litefusion_data/kyc_query/kyc_query.py 1808221539
cat ids.txt | python3 /mnt/aime_eval_ssd/0_litefusion_data/kyc_query/kyc_query.py -
```

Python 只读接入（judge 服务直接 import，WAL 支持并发读）：

```python
import sys; sys.path.insert(0, "/mnt/aime_eval_ssd/1_aime/user_kyc")
import kyc_store
conn = kyc_store.connect(readonly=True)
rec = kyc_store.get_users(conn, [uid]).get(uid)  # rec["status"]=="ok" 时 rec["profile"] 为脱敏 dict
```

## 2. 口径与脱敏规则

- **输入源**：`/mnt/aime_eval_ssd/1_aime/eval_input/0_daily_eval_input/<model>/<date>.jsonl`（`aime_expert` / `aime_fast`）。输入会被回填重写，行数 ≠ 用户数，统计以 `users` / `user_days` 为准。
- **真实用户判定**：纯 ASCII 数字且 ≤ 10 位（与看板 / 5003 同口径）；其余标 `skipped`，默认不拉。
- **脱敏**：金额/数量/百分比打星号，身份/联系方式/凭证丢弃，时间保留到 `YYYY-MM`；脱敏检测发现残留敏感值时记 `leak` 整条丢弃，对外关联用 16 位指纹 `user_id_fp`。
- **画像树动态变化**：顶层树（`goals`、`background`、`risk_preference`、`investment_status` 等）因用户而异，不拆固定列；按树筛查 `user_sections`，取字段用 `json_extract` / `kyc.py path`。

## 3. 表结构与状态

| 表 | 作用 |
|---|---|
| `users` | 一人一行：`user_id`、`user_id_fp`、`is_real`、`status`、`error`、`attempts`、`fetched_at`、`first_day`/`last_day`、`n_traces`、`models`、`profile`（JSON）、`profile_bytes`、`n_sections`、`kyc_create_time`/`kyc_update_time` |
| `user_days` / `user_sections` | `(user_id, day, model) → n_traces` 与 `(user_id, section, n_bytes)` 索引表 |
| `profile_fts` | FTS5 `trigram` 全文索引（≥ 3 字符走索引；1–2 字中文自动退回 `LIKE`） |
| `files` / `file_contrib` / `meta` | 输入文件增量游标（`size/mtime/ctime/offset/head_md5`）、逐文件贡献与同步元数据 |

`status` 取值：`pending`（待拉）、`ok`（有画像）、`empty`（接口无画像，非错误）、`leak`（脱敏拦截，当无数据）、`error`（网络失败，最多重试 5 次）、`skipped`（非真实 id）。

## 4. 同步、导出与运维

```bash
cd /mnt/aime_eval_ssd/1_aime/user_kyc
python3 kyc_sync.py run             # 增量扫描 + 拉取新用户（支持 scan / import-legacy / fetch / status）
bash start_sync.sh                  # 拉起每 6 小时后台循环（默认 --retry-errors --refresh-days 30，≤4 QPS）
pkill -f "[k]yc_sync.py loop"       # 停止循环
```

- **增量扫描**：`size+mtime+ctime` 不变直接跳过；变大且头部 md5 不变只读尾巴；变小/重写则整文件重扫并由 `file_contrib` 重算活动度。
- **单实例与重启**：同步持 `kyc.sqlite3.lock`（`flock`），休眠不占锁；代码与库位于持久盘，容器重建后手动执行 `bash start_sync.sh` 即可恢复。
- **发布与备份**：本机 `scripts/user_kyc/deploy.sh` 同步代码后重启 loop；备份须用 SQLite backup API 或 `python3 kyc.py export`（输出到 `export/` 含 `MANIFEST.json`），禁止直接 `cp` WAL 库。
- **时区与测试**：日志与 `fetched_at` 均为 UTC（汇报 +8）；单测 `cd scripts/user_kyc && python3 -m unittest discover -s tests -q`。
