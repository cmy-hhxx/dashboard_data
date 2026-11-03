# eval_data_interface — 对话分析查询接口 v1.0

RSI 看板「对话分析」查询接口的服务端实现。只读、零第三方依赖（Python 3.12 标准库），
独立进程，不与仓库内任何其他代码耦合。

- 协议：`docs/对话分析查询接口协议 v1.0.md`
- 落地差异与协议第 11 节的答复：[docs/协议落地说明.md](docs/协议落地说明.md)
- 给看板侧的接入说明：[docs/接入说明.md](docs/接入说明.md)

## 地址

| 方向 | 地址 |
|---|---|
| 对内 | `http://interactive-i6piqwvlnsr5:5003` |
| 对外 | `http://117.50.195.94:3335` |
| 接口前缀 | `/api/v1/analysis` |
| 健康检查 | `GET /healthz` |

对外 3335 由平台侧映射到 pod 的 5003，进程只需监听 5003（已实测：
在 pod 内起一个 5003 的 HTTP 服务，从本地访问 `117.50.195.94:3335` 可直接命中）。
不做认证。

## 数据来源

远端只读挂载：`/mnt/fin_bench/code_and_clean_data/datasets/1_aime`

| 内容 | 路径 |
|---|---|
| 逐 trace 分析结果 | `eval_output/{0_daily_eval,1_lost_user_eval}/{aime_expert,aime_fast}/*_attribution-YYYY-MM-DD.jsonl` |
| 问题聚类树 | `eval_output/cluster/{aime_expert,aime_fast}/cluster_tree.json` |
| 问题条目 → 聚类编码 | `eval_output/cluster/{aime_expert,aime_fast}/item_index.jsonl` |
| 对话原始结构体 | `eval_input/0_daily_eval_input/{model}/<date>.jsonl`、`.archive/1_lost_user_input/{model}/*_input.jsonl` |

本服务只服务 AIME 一份数据（`dataset=aime_eval`）。

## 维度映射

| 协议字段 | 实际取值 | 来源 |
|---|---|---|
| `dataset` | `aime_eval`（唯一取值） | 配置 |
| `source` | `prelaunch` / `feedback` | 目录 `0_daily_eval` / `1_lost_user_eval` |
| `app_version` | `AIME-Atlas_expert`、`aime-fast-new_fast` | `turns[].meta.model` + 模型目录后缀 |
| `user_id` | 真实用户名或数字 ID | `turns[].meta.user_id` |
| `day` | `YYYY-MM-DD`（Asia/Shanghai） | `turns[].meta.timestamp` |
| trace | 一条**单轮**对话 | `turns[]` 的一项，id = `turns[].meta.trace_id` |
| `intent` | `T01` / `T01.S02` | `turns[].meta.task` / `subtask` |
| `error` | `S9` / `S9.M5` / `S9.M5.1` | cluster 树的节点 id |

## 分类体系

- **意图**：`taxonomy/intent_2026-10.json`，27 个顶层任务 + 169 个子任务，编码 `T01` → `T01.S02`，
  label 保留中文原值。版本 `2026-10`。
- **问题**：直接来自数据的 `cluster_tree.json`，按模型两份：
  `aime_expert` 196 节点 / `aime_fast` 142 节点（不含根），层级为 环节 `S*` → 机制 `S*.M*` → 模式 `S*.M*.x`
  （个别还有第 4 层变体）。版本 `4.1.3`。
  `/taxonomy?kind=error` 用 `app_version` 选树。
- `counts_as_error`：P0–P4 全部为 `true`（P4 也计入错误）。

## 口径与取舍

1. **只算分析过的 trace**；未分析的 trace 不出现在任何结果里。
2. **每条 trace 只取最新一版**：同一文件里同一 `trace_id` 出现多行时取行号最大的，更早的行进
   `analysis.history`。数据里没有 `analysis_id` / `analyzed_at` 字段，
   `analysis_id` 用 `文件 + 行号` 的 SHA-1 前 16 位，`analyzed_at` 取文件 mtime。
3. **只有被聚类的问题才计错误**：attribution 全量 10578 轮 / 28647 个问题条目，
   cluster 覆盖 8504 轮 / 25538 条（约 80%，聚类流水线只跑了部分日期/模型）。
   未聚类的问题不进 `error_codes`、也不让 `has_error` 变真——这部分 trace 会显示成“没有问题”。
4. **一条 trace 可命中多个问题**：按 `error` 分组时在各问题组各计一次；按大类分组时同一大类只计一次。
5. **意图互斥**：`subtask` 存在时用子类编码，否则回退到 `task` 编码；都没有则 `intent_code=null`。
6. **`analyzed` 分母**：去掉 `error` / `has_error` 两个筛选项、并忽略分组键里的 `error` 维度后，
   同一范围的 trace 数（协议 §4）。
7. **`intent` 编码不在数据里**：`task`/`subtask` 是中文自由文本，编码由本仓库的
   `taxonomy/intent_2026-10.json` 固定；出现表外的新 label 时该 trace 的 `intent_code` 为 `null`。

## 接口

| 接口 | 说明 |
|---|---|
| `GET /taxonomy?kind=intent\|error[&app_version=…]` | 分类树 |
| `GET\|POST /summary` | 聚合，`group_by` 支持 1–2 个维度 |
| `GET\|POST /traces` | trace 列表，固定 `(asked_at DESC, trace_id DESC)`，cursor 翻页 |
| `POST /traces/batch` | 按一批 trace_id 取摘要（≤1000） |
| `GET /traces/{trace_id}?dataset=…&day=…` | 单条 trace：`eval_input` 整行 + trace 对象 + 分析结果 + 历史版本 |

所有 200 响应统一为 `{request_id, schema_version, data, meta}`；错误为
`{request_id, error:{code, message, details}}`，错误码见协议 §10。

`cursor` 是无状态签名串（HMAC-SHA256），绑定筛选条件与页大小，30 分钟过期返回 410；
密钥落盘在 `state/cursor.key`，重启不失效。

## 本地跑

```bash
# 用 fixture 自建一个小数据集并跑完整验收
python3 tests/test_acceptance.py

# 直接指向真实挂载（远端机器上）
EVAL_DATASETS=/mnt/fin_bench/code_and_clean_data/datasets python3 run.py serve

# 只建索引 / 看索引摘要
python3 run.py build
python3 run.py status
```

环境变量：`EVAL_DATASETS`（数据集根）、`ANALYSIS_STATE`（索引与密钥目录，默认 `./state`）、
`PORT`（默认 5003）、`HOST`、`REFRESH_SECONDS`（默认 600）、`CURSOR_TTL`（默认 1800）。

## 部署与运维

```bash
./deploy.sh                     # rsync 到 /opt/eval_analysis + 重启 + 冒烟（EVAL_DEPLOY_HOST/PORT/KEY 可覆盖 ssh 别名）
ssh eval_data 'cd /opt/eval_analysis && ./start.sh'
ssh eval_data 'cd /opt/eval_analysis && ./stop.sh'
curl -s http://117.50.195.94:3335/healthz
```

`start.sh` 会等到 `/healthz` 返回 `ok:true`（首次构建实测 341 秒（扫 11.4 GB 输入）；
之后按 `(size, mtime)` 增量，未变文件直接跳过）。重启时先用 `state/index.sqlite` 里已有的索引对外服务，
几秒内即 `ok:true`，增量重建在后台跑完后替换快照；`eval_input` 只是追加时从上次最后一个完整换行续扫。
周期重建只有一个循环（`REFRESH_SECONDS`），上一轮未结束时下一轮跳过。

`/healthz` 字段：`ok`、`building`、`traces`、`data_updated_at`、`build`（最近一次构建摘要与耗时）。

验收：

```bash
python3 tests/test_acceptance.py                       # fixture，14 条
python3 tests/test_store.py                            # store 层：脏字段入库、输入追加续扫
python3 tests/test_acceptance.py --real --base-url http://127.0.0.1:5003   # 真实数据
```

## 验证结果（2026-11-02，部署在 `interactive-i6piqwvlnsr5`）

- 首次索引 341 秒，9854 条 trace / 724 条历史版本 / 28,647 个问题条目；重启增量重建 1.4 秒。
- `tests/test_acceptance.py`：fixture 14 条全过；真实数据 13 条全过（含分组/明细一致、分母规则、
  多问题计数、大类展开、导出、5000 个 user_ids、详情）。
- 外网实测：`/summary` 0.33s、`/traces` 0.31s、`/traces/{id}` 0.6s。

## 目录

```
analysis_api/
  config.py     环境变量、路径、常量
  taxonomy.py   分类树（意图 JSON / 聚类树）
  store.py      SQLite 增量索引（attribution、input 偏移、问题编码、历史版本）
  snapshot.py   内存快照、筛选、/summary 与 /traces 语义、详情拼装
  cursors.py    无状态签名 cursor
  server.py     HTTP 路由与后台重建
run.py          CLI：build / serve / status
taxonomy/       意图分类体系（版本化 JSON）
tests/          fixture + 验收用例
```
