# 用户 KYC 数据 · 使用说明（给使用方）

> **数据内容**：daily eval input 里出现过的用户，按 `user_id` 查到的 KYC 画像（已脱敏）。
> **数据位置**：弗吉尼亚数据服务器 `10.217.219.2:2473` 容器内，
> `/mnt/aime_eval_ssd/1_aime/user_kyc/`。
> **快照**：2026-11-23 05:50 UTC（北京时间 13:50）；之后每 6 小时增量更新。
> **维护方**：用户 KYC 库同步循环（见同目录 `README.md`）。

本文只讲**怎么用**；表结构细节、同步/排错见 `README.md`。

---

## 1. 数据在哪

### 1.1 主数据（推荐）

| 内容 | 路径 | 说明 |
|---|---|---|
| **SQLite 主库** | `/mnt/aime_eval_ssd/1_aime/user_kyc/kyc.sqlite3` | 推荐直接用；只读打开 |
| WAL 文件 | 同目录 `kyc.sqlite3-wal`、`-shm` | 不要删；只读连接需要能读同目录的 `-wal`/`-shm` |
| 用户索引（CSV 快照） | `.../user_kyc/export/kyc_users-<日期>.csv.gz` | 不含 profile，只有用户/状态/活动度 |
| 画像（JSONL 快照） | `.../user_kyc/export/kyc_profiles-<日期>.jsonl.gz` | 一行一个用户，含脱敏 profile |
| 导出清单 | `.../user_kyc/export/MANIFEST.json` | 行数、文件大小、sha256、字段、口径 |
| 使用/运维文档 | `.../user_kyc/USAGE.md`、`README.md` | 本文与完整手册 |
| 同步日志 | `.../user_kyc/logs/sync.log` | 看最近一次扫描/拉取时间 |

- 主库约 **200 MB**；导出文件约 **10~20 MB**（gzip）。
- 文件权限 `644`、目录 `755`，**只读使用**；不要往库里写、不要改文件。
- 如果不在这个容器里：找维护方要 `export/` 下的快照，或申请只读访问；
  自己复制库时不要直接 `cp`（WAL 可能不一致），用 `sqlite3` backup API 或导出文件。

### 1.2 当前规模（2026-11-23 快照）

| 项 | 数 |
|---|---:|
| daily eval input 文件 | 109 个（`aime_expert` / `aime_fast`，2026-09-01 ~ 11-22）|
| 输入行数 | 205,332 |
| 唯一 `user_id` | 28,391 |
| 真实 `user_id` | 21,048 |
| **有 KYC 画像** | **16,240** |
| 无画像（`empty`） | 4,796 |
| 脱敏拦截（`leak`） | 12 |
| 非真实 id（`skipped`） | 7,343 |

> 只有 daily eval input 里出现过的用户；不是全量用户库。数字会随每日输入增长，
> 以 `python3 kyc.py stats` 或 `MANIFEST.json` 为准。

---

## 2. 最小可用示例

### 2.1 Python 直接读（不需要任何项目代码）

```python
import json
import sqlite3

DB = "/mnt/aime_eval_ssd/1_aime/user_kyc/kyc.sqlite3"
conn = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
conn.row_factory = sqlite3.Row

row = conn.execute(
    "SELECT user_id, status, fetched_at, profile FROM users WHERE user_id = ?",
    ("1808221539",),
).fetchone()

if row is None:
    print("没进过 daily eval input")
elif row["status"] == "ok":
    profile = json.loads(row["profile"])     # 已脱敏的 dict
    print(row["user_id"], row["fetched_at"], list(profile)[:5])
else:
    print(row["user_id"], row["status"])     # empty / skipped / leak / error
```

批量：

```python
ids = ["1808221539", "1888919995", "missing"]
marks = ",".join("?" * len(ids))
rows = conn.execute(
    f"SELECT user_id, status, profile FROM users WHERE user_id IN ({marks})", ids
).fetchall()
```

### 2.2 用仓库里的查询封装（可选）

```python
import sys
sys.path.insert(0, "/mnt/aime_eval_ssd/1_aime/user_kyc")
import kyc_store

conn = kyc_store.connect(readonly=True)          # 只读连接
rec = kyc_store.get_users(conn, ["1808221539"]).get("1808221539")
# rec["profile"] 已解析成 dict；rec 为 None 表示没进过输入
```

### 2.3 命令行（有 shell 权限时）

```bash
cd /mnt/aime_eval_ssd/1_aime/user_kyc

python3 kyc.py get 1808221539                    # 单用户
python3 kyc.py get --pretty 1808221539
cat ids.txt | python3 kyc.py get -               # 批量
python3 kyc.py search --section risk_preference --limit 20
python3 kyc.py search --q gold --limit 20
python3 kyc.py path goals.asset_protection --limit 20
python3 kyc.py stats
```

`search` 的参数：

| 参数 | 说明 |
|---|---|
| `--status` | 默认 `ok`；可 `ok,empty` 或 `any` |
| `--q` | profile 全文；≥3 字符 trigram，1~2 字退回 LIKE |
| `--section` | 只要含某棵画像树 |
| `--model` | `aime_expert` / `aime_fast` |
| `--day-from` / `--day-to` | 活跃区间有交集 |
| `--min-traces` | 输入里至少出现多少次 |
| `--fields` | 输出字段，见 §4.1 |
| `--limit` / `--offset` | 默认 50 / 0 |
| `--format` | `table` / `json` / `jsonl` / `csv` |

### 2.4 直接拿导出文件（不装 SQLite 也能用）

```bash
cd /mnt/aime_eval_ssd/1_aime/user_kyc/export
cat MANIFEST.json                                # 先看快照日期/行数/sha256
zcat kyc_profiles-2026-11-23.jsonl.gz | head -1 | python3 -m json.tool
zcat kyc_users-2026-11-23.csv.gz | head -3
```

- `kyc_profiles-*.jsonl.gz`：一行一个 `status=ok` 用户，字段见 §4.3；
- `kyc_users-*.csv.gz`：全部用户（含 empty/skipped），不含 profile；
- 快照是**带日期的**；需要最新数据用主库，或让维护方重新导出：

```bash
python3 kyc.py export --out-dir /mnt/aime_eval_ssd/1_aime/user_kyc/export
```

---

## 3. 数据怎么理解

### 3.1 一行代表什么

`users` 一个 `user_id` 一行，包含三部分：

1. **输入侧活动度**：`first_day` / `last_day` / `n_traces` / `models`
   （来自 daily eval input，不是 KYC 接口）；
2. **KYC 状态**：`status`、`error`、`fetched_at`、`attempts`；
3. **画像**：`profile`（脱敏 JSON，只有 `status=ok` 时非空）。

### 3.2 `status` 怎么用

| status | 含义 | 使用建议 |
|---|---|---|
| `ok` | 有画像 | 正常使用 `profile` |
| `empty` | 接口返回无画像 | 当“无数据”处理，不是错误 |
| `leak` | 脱敏检测拦下 | 当“无数据”处理，不要尝试绕过 |
| `error` | 网络/接口失败 | 可稍后重试/找维护方 |
| `pending` | 还没拉 | 等下一轮同步 |
| `skipped` | 非真实 id（英文名/超 10 位数字）| 不属于业务用户，忽略 |

### 3.3 口径（会直接影响你怎么算数）

- **user_id**：真实 id 为纯 ASCII 数字且 ≤10 位；其余标 `skipped`。
- **行数 ≠ 用户数**：输入一行是一个会话快照，同一用户会重复出现；
  用户数看 `users`，日期维度看 `user_days`。
- **日期**：`first_day`/`last_day` 是该用户在输入里最早/最晚出现的日期，
  不是 KYC 画像的日期；画像日期看 `kyc_create_time`/`kyc_update_time`。
- **时间**：`fetched_at`、`meta`、日志都是 **UTC**，汇报时 +8。
- **输入会重写**：回填/跨天合并会改写文件；库里的活动度按当前文件重算。

### 3.4 画像（profile）说明

- 已脱敏：金额/数量/百分比 → 星号；个人身份/联系方式/凭证 → 丢弃；
  时间只留 `YYYY-MM`；标的代码、公司名、描述文本保留。
- 顶层树因用户而异（`goals`、`background`、`risk_preference`、
  `investment_status`、`user_life_cycle`、`wealth_structure`…），
  不要假设固定字段；用 `json_extract` / `kyc.py path` 取。
- 顶层 `_createTime` / `_updateTime` 是画像创建/更新月份；
  `_sanitized` 是脱敏策略元信息。
- 画像会随上游更新；是否最新看 `fetched_at`。

---

## 4. 字段与表

### 4.1 `users`（主表）

| 字段 | 类型 | 说明 |
|---|---|---|
| `user_id` | TEXT | 主键，原始 user_id |
| `user_id_fp` | TEXT | 16 位指纹，跨表关联用，不暴露原 id |
| `is_real` | INT | 1=真实 id，0=非真实 |
| `status` | TEXT | 见 §3.2 |
| `error` | TEXT | 最近一次错误 |
| `attempts` | INT | 请求次数 |
| `fetched_at` | TEXT | 最近一次拉取时间（UTC ISO） |
| `first_day` / `last_day` | TEXT | 输入里最早/最晚日期 |
| `n_traces` | INT | 输入里出现次数 |
| `models` | TEXT | `,aime_fast,aime_expert,`（前后带逗号） |
| `profile` | TEXT | 脱敏画像 JSON（`ok` 时非空） |
| `profile_bytes` | INT | profile UTF-8 字节数 |
| `n_sections` | INT | 顶层树数量 |
| `kyc_create_time` | TEXT | 画像 `_createTime` |
| `kyc_update_time` | TEXT | 画像 `_updateTime` |
| `created_at` | TEXT | 首次进库时间 |

### 4.2 辅助表

| 表 | 主键 / 列 | 用途 |
|---|---|---|
| `user_days` | `(user_id, day, model) → n_traces` | 某天/某模型有哪些用户 |
| `user_sections` | `(user_id, section, n_bytes)` | 谁有某棵画像树 |
| `profile_fts` | FTS5（trigram） | 画像全文搜索 |
| `meta` | `key, value` | `last_scan_at` / `last_fetch_at` / `last_import_at` |
| `files` / `file_contrib` | 输入文件游标 | 维护用，使用方一般不需要 |

### 4.3 导出文件字段

`kyc_profiles-*.jsonl.gz` 每行：

```json
{
  "user_id": "1808221539",
  "user_id_fp": "41cd5740e3e915cf",
  "first_day": "2026-10-01",
  "last_day": "2026-11-22",
  "n_traces": 123,
  "models": ["aime_expert", "aime_fast"],
  "kyc_create_time": "2026-10",
  "kyc_update_time": "2026-11",
  "fetched_at": "2026-11-18T20:05:19Z",
  "n_sections": 12,
  "profile": { "...": "..." }
}
```

`kyc_users-*.csv.gz` 列：`user_id,user_id_fp,is_real,status,first_day,last_day,
n_traces,models,profile_bytes,n_sections,kyc_create_time,kyc_update_time,
fetched_at,error`；`models` 在 CSV 里用分号分隔。

---

## 5. 常用查询配方

以下都可以直接在 Python 里执行（`conn` 用 §2.1 的只读连接）。

### 5.1 按画像维度筛人

```sql
SELECT u.user_id, u.last_day, u.n_traces
FROM users u
WHERE u.status = 'ok'
  AND EXISTS (SELECT 1 FROM user_sections s
              WHERE s.user_id = u.user_id AND s.section = 'risk_preference')
ORDER BY u.n_traces DESC
LIMIT 100;
```

### 5.2 按日期/模型筛

```sql
SELECT user_id, first_day, last_day, n_traces
FROM users
WHERE last_day >= '2026-11-15'
  AND first_day <= '2026-11-22'
  AND models LIKE '%,aime_fast,%'
ORDER BY n_traces DESC;
```

### 5.3 全文搜画像

```sql
SELECT user_id
FROM users
WHERE rowid IN (
  SELECT rowid FROM profile_fts WHERE profile_fts MATCH '"gold"'
);
```

> trigram 索引对 ≥3 字符有效；1~2 个字（尤其中文）用
> `profile LIKE '%黄金%'`（会慢一些，16k 画像约 0.2 秒）。

### 5.4 取画像里的某个字段

```sql
SELECT user_id,
       json_extract(profile, '$."risk_preference"."level"') AS risk_level,
       json_extract(profile, '$."goals"."asset_protection"') AS asset_protection
FROM users
WHERE status = 'ok'
LIMIT 20;
```

命令行等价：

```bash
python3 kyc.py path risk_preference.level --limit 20
python3 kyc.py path goals.asset_protection --limit 20
```

### 5.5 和自己数据 join

用 `user_id`（原始）或 `user_id_fp`（不暴露原 id 时）：

```python
my_ids = [...]
marks = ",".join("?" * len(my_ids))
rows = conn.execute(
    f"SELECT user_id, status, profile FROM users WHERE user_id IN ({marks})",
    my_ids,
).fetchall()
```

> `IN (...)` 的变量数默认上限 999；一次超过 ~900 个 id 时分批，或先把 id 写进
> 临时表再 JOIN。

### 5.6 导出自己的子集

```bash
# 有画像的清单（CSV）
python3 kyc.py search --status ok --fields user_id,first_day,last_day,n_traces \
  --limit 100000 --format csv > /tmp/my_users.csv

# 某个画像树（JSONL）
python3 kyc.py path goals.asset_protection --limit 100000 --format jsonl \
  > /tmp/goals.jsonl
```

---

## 6. 数据新鲜度与更新

| 项 | 说明 |
|---|---|
| 主库更新 | 后台循环每 6 小时 `scan` 输入 + `fetch` 新用户 |
| 画像刷新 | 默认每 30 天重拉一次 `ok`/`empty` |
| 判断新鲜度 | `SELECT * FROM meta;` 看 `last_scan_at` / `last_fetch_at` |
| 导出快照 | 文件名带日期；`MANIFEST.json` 里 `snapshot_date` 是快照日 |
| 强制更新 | 有 shell 权限可 `python3 kyc_sync.py run`，或找维护方 |

---

## 7. 注意事项 / FAQ

**Q：为什么某个 user_id 查不到？**
A：只有进过 daily eval input 的用户才在库里；从没出现过的返回空（CLI 显示
`status=missing`）。非真实 id 是 `skipped`，没有画像的是 `empty`。

**Q：`empty` 和 `leak` 是失败吗？**
A：不是。`empty` 是接口没有该用户画像；`leak` 是脱敏检测发现原始数据没洗干净，
整条丢弃。两者都当“无数据”处理。

**Q：能写库吗？**
A：不能。库由同步进程维护；只读使用。需要新增字段/索引找维护方。

**Q：和实时接口不一致？**
A：库是缓存，停在最近一次拉取（`fetched_at`）。实时值用冻结版
`/mnt/aime_eval_ssd/0_litefusion_data/kyc_query/kyc_query.py <uid>`。

**Q：`user_id` 是明文，能对外吗？**
A：库是内部使用；对外分享用 `user_id_fp`（16 位指纹）关联，profile 本身已脱敏。
需要脱敏导出时找维护方。

**Q：导出文件多久更新一次？**
A：导出是带日期的快照，不自动刷新；主库才是最新的。需要新快照执行
`python3 kyc.py export` 或联系维护方。

**Q：能直接 `cp kyc.sqlite3` 吗？**
A：同步在写时不要直接复制（WAL 可能不一致）。用
`python3 kyc.py export`、SQLite backup API，或先停同步再复制
`kyc.sqlite3` + `-wal` + `-shm`。

**Q：为什么有的用户 `profile` 很大/很小？**
A：画像树因用户而异，从几百字节到几十 KB 都正常；`profile_bytes` 可先筛。

**Q：要按天/模型的活动度？**
A：主库 `user_days` 表（`user_id, day, model, n_traces`）；`users` 只有
`first_day`/`last_day`/`n_traces`。导出 CSV 不含逐日明细，需要就查主库。

---

## 8. 维护与联系

- 完整表结构、同步参数、排错：同目录 `README.md`。
- 仓库设计/口径文档：`eval_data_server/docs/用户KYC库.md`。
- 需要新字段、定期导出、访问权限、批量刷新：联系用户 KYC 库维护方。

---

## 9. 交接清单（把数据给别人的最小集合）

主库可以不给，复制这 4 个文件即可：

| 文件 | 用途 |
|---|---|
| `export/kyc_profiles-<日期>.jsonl.gz` | 画像（一行一个 `ok` 用户）|
| `export/kyc_users-<日期>.csv.gz` | 用户状态/活动度（含 empty/skipped，不含画像）|
| `export/MANIFEST.json` | 行数、文件大小、sha256、字段、口径 |
| `USAGE.md` | 本文 |

校验：

```bash
cd /mnt/aime_eval_ssd/1_aime/user_kyc
sha256sum export/kyc_profiles-<日期>.jsonl.gz export/kyc_users-<日期>.csv.gz
# 与 export/MANIFEST.json 里 files.*.sha256 对比
```

- 团队内部：可以直接给 `kyc.sqlite3`（只读），查询效率最高。
- 出了团队：建议只给 `export/` 快照；`user_id` 是明文，必要时用 `user_id_fp`
  替换后再给。
- 拿到文件的人按 §2.1 / §2.4 读即可；需要字段解释看 §4。
