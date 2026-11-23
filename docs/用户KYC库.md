# 用户 KYC 库（弗吉尼亚）

把 `daily eval input` 里出现过的 user_id 抽出来，按 user_id 拉一次 KYC 画像、脱敏后落成
**可查询的 SQLite 库**。位置：

```text
/mnt/aime_eval_ssd/1_aime/user_kyc/
  kyc_store.py     库结构 + 查询 API（judge 服务可直接 import）
  kyc_sync.py      同步：扫输入 → 拉 KYC → 写库
  kyc.py           命令行查询：get / search / path / stats
  start_sync.sh    拉起后台同步循环（容器重启后跑一次）
  deploy.sh        从本仓库发布代码（不含库文件）
  USAGE.md         给使用方的说明（数据在哪、怎么查、导出、FAQ）
  export/          日期快照（profiles JSONL.gz / users CSV.gz / MANIFEST.json）
  kyc.sqlite3      库（WAL 模式，查询与同步可同时进行）
  logs/sync.log    同步日志
```

> 服务器同目录 `README.md` 是面向运维的完整命令手册（查询/同步/排错）；本文侧重设计与口径。

实时查询仍用冻结版的 `0_litefusion_data/kyc_query/kyc_query.py`（即用即查、不落盘）。
本库是它的**离线缓存 + 用户索引**：省掉重复拉取，并且能按画像维度反查用户。

## 数据口径（2026-11-23 首次扫描）

| 项 | 值 |
|---|---|
| 输入 | `/mnt/aime_eval_ssd/1_aime/eval_input/0_daily_eval_input/<model>/<date>.jsonl` |
| 模型 | `aime_expert`、`aime_fast` |
| 日期 | 2026-09-01 ~ 2026-11-22，共 55 天 / 109 个文件 |
| 行数 | 205,332 行（一行一个会话快照，同一用户/会话会重复出现）|
| 唯一 user_id | **28,391** |
| 真实 user_id | **21,048**（纯 ASCII 数字且 ≤10 位，与看板/5003 同口径）|
| 非真实 id | 7,343（英文名账号、16~18 位内部 id），标记 `skipped`，默认不拉 |
| 画像 | 最终 **16,240** 个有画像（真实用户的 77%）；4,796 个接口返回无画像（`empty`）；12 个 `leak` |
| 复用 | 其中 9,905 个直接导入既有 `0_litefusion_data/user_kyc`，省掉近一半请求 |
| 拉取速度 | 串行约 3.9 条/秒（0.25s 间隔，≤4 QPS）；剩余 9,886 个用了 42 分钟 |

输入文件会跨天合并/回填重写，所以「行数」不等于「用户数」；库里的 `n_traces` 是按
`user_id` 去重后的出现次数，日期维度存在 `user_days`。

## 表结构

| 表 | 内容 |
|---|---|
| `users` | 一个 user_id 一行。`status`、`attempts`、`fetched_at`、`first_day`/`last_day`、`n_traces`、`models`、`profile`（脱敏 JSON）、`profile_bytes`、`n_sections`、`kyc_create_time`/`kyc_update_time` |
| `user_days` | `(user_id, day, model) → n_traces`，查「某天/某模型有哪些人」|
| `user_sections` | profile 顶层树 `(user_id, section)`，查「谁有 risk_preference / goals …」|
| `files` | 每个输入文件的增量游标：`size`/`mtime_ns`/`ctime_ns`/`offset`/头部 md5 |
| `file_contrib` | 每个输入文件对每个用户的 trace 数贡献（重写文件时可整文件重算）|
| `profile_fts` | profile 全文索引，`trigram` 分词，中/英/波斯文都能子串匹配 |

`status` 取值：

| status | 含义 |
|---|---|
| `pending` | 还没拉 |
| `ok` | 有画像（`profile` 非空）|
| `empty` | 接口返回 `data:{}`，该用户没有画像 |
| `leak` | 脱敏检测拦下（原始值可能外泄），不落库 |
| `error` | 网络/接口失败，可 `--retry-errors` 重试 |
| `skipped` | 非真实 id，默认不拉（`--include-nonreal` 可拉）|

画像顶层树因用户而异（`goals`、`background`、`risk_preference`、`investment_status` …
还有 `user_life_cycle`、`wealth_structure`、`risk_profile` 等新树），所以**不拆列**：
按维度筛用 `user_sections`，取字段用 `user_id` + `json_extract`（`kyc.py path` 已封装），
找内容用全文索引。

## 查询

```bash
cd /mnt/aime_eval_ssd/1_aime/user_kyc

# 单个 / 批量（输出格式与冻结版 kyc_query.py 接近，多一个 status/source）
python3 kyc.py get 1808221539
python3 kyc.py get --pretty 1808221539
cat ids.txt | python3 kyc.py get -
```

```bash
# 按画像维度筛人：有 risk_preference、最近活跃、出现在 fast 模型
python3 kyc.py search --section risk_preference --day-from 2026-11-01 --limit 20

# 全文找内容（≥3 字符走 trigram；1~2 字中文自动退回 LIKE）
python3 kyc.py search --q "gold" --limit 20
python3 kyc.py search --q "黄金" --section goals --format jsonl

# 取某个子树/字段（点路径，支持 [n] 下标）
python3 kyc.py path goals.asset_protection --section goals --limit 50
python3 kyc.py path investment_status.watchlists.crypto_usdt.assets --limit 20

# 导出给别的脚本
python3 kyc.py search --status any --fields user_id,status,first_day,last_day,n_traces \
  --format csv --limit 100000 > users.csv

python3 kyc.py stats
python3 kyc.py export                # 导出 JSONL/CSV 快照给外部（leak 明细会脱敏）
```

`search` 的过滤参数：`--status`（默认 `ok`，可 `ok,empty` 或 `any`）、`--q`、`--section`、
`--model`、`--day-from`/`--day-to`（按活跃区间有交集）、`--min-traces`、`--limit`/`--offset`、
`--fields`、`--format table|json|jsonl|csv`。

各字段：`user_id`、`fp`、`status`、`first_day`、`last_day`、`n_traces`、`models`、
`sections`、`n_sections`、`profile_bytes`、`kyc_create`、`kyc_update`、`fetched_at`、
`attempts`、`error`、`profile`。

### 查询性能（16k 画像 / 28k 用户时实测）

| 查询 | 耗时 |
|---|---:|
| `--q gold`（trigram） | 0.06 s |
| `--q 黄金`（退回 LIKE，扫 44 MB 画像） | 0.20 s |
| `--section risk_preference` | 0.08 s |
| `path goals.asset_protection` | 0.11 s |
| 日期区间筛选 | 0.07 s |
| 全量导出 28k 用户 CSV | 0.18 s |

索引：`users(status)`、`users(last_day)`、`users(n_traces)`、`user_sections(section)`、
FTS5 trigram；连接开 WAL + 1 GB mmap + 128 MB cache，读不受同步写影响。

### 给 judge 服务直接用

```python
import sys
sys.path.insert(0, "/mnt/aime_eval_ssd/1_aime/user_kyc")
import kyc_store

conn = kyc_store.connect()                      # 常驻连接即可，WAL 支持并发读
rec = kyc_store.get_users(conn, [uid]).get(uid)  # 没有就是 None
if rec and rec["status"] == "ok":
    profile = rec["profile"]                     # dict，已脱敏
```

库里没有的用户（没进过 daily eval input、`skipped`、`empty`），回退到冻结版实时查：
`python3 0_litefusion_data/kyc_query/kyc_query.py <uid>`。

## 同步

```bash
cd /mnt/aime_eval_ssd/1_aime/user_kyc

python3 kyc_sync.py scan                  # 只扫输入，秒级到分钟级
python3 kyc_sync.py import-legacy         # 复用 0_litefusion_data/user_kyc 已有画像（只填 pending/error）
python3 kyc_sync.py fetch --limit 100     # 只拉 KYC
python3 kyc_sync.py run                   # 先扫后拉
python3 kyc_sync.py status                # JSON 统计

# 日常：每 6 小时扫一次 + 补新用户（可 nohup / setsid）
bash start_sync.sh
```

`start_sync.sh` 默认带 `--retry-errors --refresh-days 30`：每轮会重试失败用户（最多 5 次），
并刷新 30 天前拉过的画像；`REFRESH_DAYS=0` 可关掉刷新。已在跑时脚本直接返回，不会起第二个。

可选参数：

| 参数 | 说明 |
|---|---|
| `--interval 0.25` | 请求间隔秒，默认 0.25（≤4 QPS；服务方建议 ≤5）|
| `--limit N` | 本轮最多拉 N 个 |
| `--retry-errors` | 重试 `status=error`（最多 5 次）|
| `--refresh-days 30` | 刷新 30 天前拉过的 `ok`/`empty`（画像按月更新时用）|
| `--include-nonreal` | 也拉非真实 id（默认跳过）|
| `--overwrite` | 仅 `import-legacy`：连已 `ok`/`empty` 的也覆盖 |
| `--interval-min 360` | `loop` 的轮询间隔 |

首次全量（实测）：扫描 145 秒 + 导入既有 9.9k 条约 2 分钟 + 剩余 9.9k 拉取 **42 分钟**。
之后每天新增用户通常几十到几百，秒级~分钟级完成；`--refresh-days 30` 到期后会再拉一批。

### 增量扫描

文件按三路判断（与 `scripts/aime_data_inventory.py` 同一套）：

| 条件 | 动作 |
|---|---|
| `size` + `mtime_ns` + `ctime_ns` 都没变 | 跳过，不读文件 |
| 只变大，且头部 md5 没变 | 从 `offset` 读新增尾巴 |
| 变小 / ctime 变了 / 前缀变了（回填重写）| 整文件重扫，替换该文件的贡献 |

每次有文件变化，从 `file_contrib` 全量重算 `user_days` 和 `users` 的活动度（约 30 万行，
1~2 秒）。这比做增量减账简单，也不会漏掉「文件被重写后用户消失」的情况。
首次扫 109 个文件 / 71 GB 实测 **145 秒**。

## 运维

| 项 | 做法 |
|---|---|
| 启动 | `bash start_sync.sh`（已在跑则直接返回）|
| 停止 | `pkill -f "[k]yc_sync.py loop"` |
| 看进度 | `tail -f logs/sync.log`、`python3 kyc_sync.py status` |
| 改代码后 | `bash deploy.sh`，再重启 loop（运行中的进程不会热加载）|
| 容器重置后 | 代码和库都在 `/mnt/aime_eval_ssd` 持久盘上，重新 `bash start_sync.sh` 即可 |
| 单实例 | `kyc.sqlite3.lock` 上 `flock`，第二个 sync 会直接退出；查询不受影响 |
| 磁盘 | 约 200 MB（画像 44 MB + trigram FTS 索引），`/mnt/aime_eval_ssd` 余量足够 |

**没有 cron/systemd**：容器里只有平台注入的 `dsw-supervisor.sh` 和 eval 的
`eval_supervisor.sh`（按 HTTP `/healthz` 探活，不适合这个循环），所以同步是
`setsid nohup` 常驻；容器重启后要手动跑一次 `start_sync.sh`。

## 常见坑

- **容器是 UTC**：日志、`fetched_at`、`meta` 时间都是 UTC，汇报时 +8。
- **输入文件在变**：`0_daily_eval_input` 会被回填重写、跨天合并；不要用「行数」当用户数，
  也不要用 `status.json` 当进度。以本库 `files`/`user_days` 为准。
- **非真实 id**：英文名（`xutianhao` 等）和 16~18 位数字不是真实用户，默认 `skipped`。
  需要时 `--include-nonreal`，但基本只会拿到 `empty`。
- **`empty` 不是错**：接口对没有画像的用户返回 `data:{}`，记为 `empty`，不重试。
- **`leak` 是正常的**：脱敏检测发现原始姓名/地区/券商等没被清洗干净时整条丢弃，
  约 1~2%；不会落任何原始值。
- **2 字关键词**：trigram 索引不以 1~2 字建 token（中文常见），`--q` 会自动改走
  `LIKE '%xx%'`，能查但比 FTS 慢；更长关键词走索引。
- **画像树会变**：不要假设固定 15 个树，`user_sections` 里是按实际出现的树记的。
- **刷新**：默认不刷新已拉的画像；需要跟踪月度更新就加 `--refresh-days 30`。
  刷新失败会保留旧画像（只记 `error`），不会把好数据冲掉。
- **同步进程是单实例**：不要手工再起一个 `loop`/`fetch`，会因 flock 退出（这是预期）。

## 验证

```bash
cd scripts/user_kyc && python3 -m unittest discover -s tests -q
```

覆盖：首次扫描、追加、重写后活动度归零、非真实 id、FTS/`section`/`path` 查询、
画像清空后 FTS 同步、JSON path 校验。不访问网络，可在笔记本上跑。
