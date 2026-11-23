# 用户 KYC 库（维护手册）

> **位置**：`/mnt/aime_eval_ssd/1_aime/user_kyc`
> **作用**：把 daily eval input 里的 user_id 拉成脱敏 KYC 画像，存 SQLite；
> 支持按用户 / 画像树 / 日期 / 全文查询，每 6 小时增量维护。
> **快照**：2026-11-23 05:50 UTC（北京时间 13:50）。
> **只使用数据**：看 [`USAGE.md`](USAGE.md)（数据在哪、Python/CLI/导出、字段、FAQ）。
> **维护这个库**：继续看本文。

## 1. 现状

| 项 | 数 |
|---|---:|
| 输入 | 109 个文件 / 205,332 行 / 55 天（2026-09-01 ~ 11-22，`aime_expert` + `aime_fast`）|
| 唯一 user_id | 28,391（真实 21,048，非真实 7,343）|
| 画像 | `ok` 16,240；`empty` 4,796；`leak` 12；`pending` 0 |
| 体积 | 主库约 200 MB；导出快照 12 MB + 656 KB |

只有 daily eval input 出现过的用户；数字以 `python3 kyc.py stats` 为准。

## 2. 目录

| 文件 | 说明 |
|---|---|
| `kyc.sqlite3` | 主库（WAL，同目录有 `-wal`/`-shm`，不要手删）|
| `kyc.sqlite3.lock` | 同步单实例锁（`flock`）|
| `kyc_store.py` | 建表 / 连接 / 查询 API（judge 可 import）|
| `kyc_sync.py` | `scan` / `import-legacy` / `fetch` / `run` / `loop` / `status` |
| `kyc.py` | 查询 CLI：`get` / `search` / `path` / `stats` / `export` |
| `start_sync.sh` | 拉起后台同步循环（已在跑则直接返回）|
| `deploy.sh` | 从仓库发布代码（不动库/日志/导出）|
| `USAGE.md` | 使用方手册 |
| `export/` | 日期快照 + `MANIFEST.json` |
| `logs/sync.log` | 同步日志（UTC）|

## 3. 查询速查

```bash
cd /mnt/aime_eval_ssd/1_aime/user_kyc

python3 kyc.py get 1808221539                 # 单用户完整画像
cat ids.txt | python3 kyc.py get -            # 批量
python3 kyc.py search --section risk_preference --limit 20
python3 kyc.py search --q gold --limit 20     # 全文（中文 1~2 字退回 LIKE）
python3 kyc.py path goals.asset_protection --limit 20
python3 kyc.py stats
```

`search` 常用参数：

| 参数 | 说明 |
|---|---|
| `--status` | 默认 `ok`；可 `ok,empty` 或 `any` |
| `--q` | profile 全文；≥3 字符 trigram，1~2 字退回 LIKE |
| `--section` | 只要含某棵画像树，如 `risk_preference` |
| `--model` | `aime_expert` / `aime_fast` |
| `--day-from` / `--day-to` | 活跃区间有交集 |
| `--min-traces` | 输入里至少出现多少次 |
| `--fields` | 输出字段（见 `USAGE.md` §4.1）|
| `--limit` / `--offset` | 默认 50 / 0 |
| `--format` | `table` / `json` / `jsonl` / `csv` |

字段逐条解释、导出格式见 `USAGE.md` §4；`--db` 可指定别的库。

## 4. 表结构

| 表 | 内容 |
|---|---|
| `users` | 一人一行：活动度 + status + `profile`（脱敏 JSON）+ 拉取元信息 |
| `user_days` | `(user_id, day, model) → n_traces` |
| `user_sections` | `(user_id, section, n_bytes)`，按画像顶层树筛人 |
| `profile_fts` | `profile` 的 FTS5 trigram 全文索引 |
| `files` / `file_contrib` | 输入文件增量游标与用户贡献 |
| `meta` | `last_scan_at` / `last_fetch_at` / `last_import_at` |

`users` 关键字段：`user_id`、`user_id_fp`（16 位指纹）、`is_real`、`status`、
`error`、`attempts`、`fetched_at`、`first_day`/`last_day`、`n_traces`、`models`
（`,aime_fast,aime_expert,`）、`profile`、`profile_bytes`、`n_sections`、
`kyc_create_time`/`kyc_update_time`。字段逐条解释见 `USAGE.md` §4.1。

| status | 含义 | 后续 |
|---|---|---|
| `pending` | 还没拉 | 下一轮 fetch |
| `ok` | 有画像 | 30 天后刷新 |
| `empty` | 接口无画像 | 30 天后重试 |
| `leak` | 脱敏拦截 | 默认不重试 |
| `error` | 网络/接口失败 | `--retry-errors` 重试（≤5 次）|
| `skipped` | 非真实 id | 默认不请求 |

## 5. 同步

```bash
python3 kyc_sync.py scan                  # 只扫输入，更新用户/活动度
python3 kyc_sync.py import-legacy         # 复用 0_litefusion_data/user_kyc 已有画像
python3 kyc_sync.py fetch --limit 100     # 只拉 KYC
python3 kyc_sync.py run                   # scan + fetch
python3 kyc_sync.py loop --interval-min 360
python3 kyc_sync.py status
```

| 参数 | 说明 |
|---|---|
| `--interval 0.25` | 请求间隔秒（≤4 QPS；服务方建议 ≤5）|
| `--limit N` | 本轮最多拉 N 个 |
| `--retry-errors` | 重试 `error`（最多 5 次）|
| `--refresh-days 30` | 刷新 30 天前拉过的 `ok`/`empty` |
| `--include-nonreal` | 也拉非真实 id |
| `--overwrite` | 仅 `import-legacy`：覆盖已 `ok`/`empty` |

### 5.1 增量逻辑

| 条件 | 动作 |
|---|---|
| `size` + `mtime_ns` + `ctime_ns` 不变 | 跳过，不读文件 |
| 只变大且头部 md5 不变 | 从 `offset` 读新增尾巴 |
| 变小 / ctime 变 / 前缀变（重写）| 整文件重扫，替换贡献 |

有文件变化时从 `file_contrib` 全量重算 `user_days` 和活动度（约 30 万行，1~2 秒）；
不再出现在输入里的用户活动度归零，画像保留。首次扫 71 GB 约 145 秒。

### 5.2 拉取

- 先 `pending`，按 `n_traces` 从高到低；再按参数处理 skipped/error/刷新；
- 串行限速，每 25 个提交一次，中断可续跑；实测约 3.9 条/秒。

### 5.3 复用既有画像

`0_litefusion_data/user_kyc` 下已有同冻结版、同脱敏策略的画像。
`import-legacy` 校验指纹后，默认只填 `pending`/`error`（`--overwrite` 可覆盖）；
首次回填导入了 9,905 条，省掉近一半请求。

### 5.4 单实例与定时

- 每轮单独持 `flock`，休眠期间不占锁，可随时手动 `run`/`fetch`/`scan`；
- 两个同步撞上时，后启动的打印「已有另一个 sync 在跑」并退出；
- 没有 cron/systemd，循环由 `start_sync.sh` 用 `setsid nohup` 拉起。

## 6. 运维

```bash
bash start_sync.sh                    # 启动（已在跑则返回）
pgrep -af "[k]yc_sync.py loop"        # 看进程
tail -f logs/sync.log                 # 看进度（UTC）
pkill -f "[k]yc_sync.py loop"         # 停止
```

- **容器重启后**：代码和库在持久盘不会丢，但进程会没；手动跑一次
  `bash /mnt/aime_eval_ssd/1_aime/user_kyc/start_sync.sh`。
- **发布代码**：笔记本上 `scripts/user_kyc/deploy.sh`，然后 `pkill` + `start_sync.sh`
  让新代码生效。
- **备份**：不要直接 `cp`（WAL 可能不一致）。用 SQLite backup API：

```bash
python3 - <<'EOF'
import datetime, os, sqlite3
base = "/mnt/aime_eval_ssd/1_aime/user_kyc"
dst = os.path.join(base, "backup-%s.sqlite3" % datetime.date.today())
src = sqlite3.connect(os.path.join(base, "kyc.sqlite3"))
with sqlite3.connect(dst) as out:
    src.backup(out)
print(dst)
EOF
```

- **导出给外部**：`python3 kyc.py export`（默认 `./export/`，生成
  `kyc_profiles-<日期>.jsonl.gz`、`kyc_users-<日期>.csv.gz`、`MANIFEST.json`）。
- **磁盘/时区**：全量约 200 MB；容器是 UTC，汇报时间 +8。

## 7. 排错

| 现象 | 处理 |
|---|---|
| `库不存在` | 先 `python3 kyc_sync.py run` |
| `已有另一个 sync 在跑` | 等 loop 跑完，或先 `pkill` loop 再手动跑 |
| `get` 返回 `empty` | 真实账号但无画像，正常；30 天后重试 |
| `get` 返回 `missing` | 该 uid 没进过 daily eval input |
| `get` 返回 `skipped` | 非真实 id，忽略 |
| `get` 返回 `leak` | 脱敏拦截，按无数据处理 |
| `stats` 的 `last_scan_at` 很旧 | 同步停了，`bash start_sync.sh` |
| 画像树名对不上 | 上游会新增/改大小写，按 `user_sections` 实际值查 |
| 和实时接口不一致 | 库是缓存，以 `fetched_at` 为准；实时用冻结版查询 |

## 8. 相关路径

| 用途 | 路径 |
|---|---|
| 实时即用即查（冻结版）| `/mnt/aime_eval_ssd/0_litefusion_data/kyc_query/kyc_query.py` |
| 既有脱敏画像（可导入）| `/mnt/aime_eval_ssd/0_litefusion_data/user_kyc/` |
| daily eval input | `/mnt/aime_eval_ssd/1_aime/eval_input/0_daily_eval_input/` |
| 仓库设计/口径文档 | `eval_data_server/docs/用户KYC库.md` |
