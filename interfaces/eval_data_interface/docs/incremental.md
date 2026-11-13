# 增量同步接口（/changes）

目标：业务方本地已经有一份数据时，**只拉新增和变化的 trace**，不用每次全量重拉。

```text
首次：GET /changes?dataset=aime_eval                     → 当前全量 + next_since
之后：GET /changes?dataset=aime_eval&since=<next_since>  → 只有新增/变更/删除
```

## 为什么不是“给我某时间之后的数据”

归因产物按评测日命名，文件会被补数、重跑、整份重写，文件 mtime 也可能比已有批次更旧。
用时间过滤会漏数据或重复拉全量。所以本接口用服务端**单调递增的变更序号 `seq`** 做水位，
客户端只需保存上次拿到的位点，服务端保证不重不漏（同一位点重放是幂等的）。

## 核心概念

| 概念 | 说明 |
|---|---|
| 变更记录 | 每次索引重建后，内容真正发生变化的 trace 写一条变更记录；内容没变不写 |
| 判重字段 | 问句、用户、来源、意图、问题条目、编码、严重度等业务字段。`file`、`line`、`analyzed_at`、`analysis_id` 不参与判重，所以批次文件整份重写或尾部追加不会造成全量重发 |
| `seq` | 服务端自增序号，越大越新；不连续是正常的（内部按 key 去重后就是连续发放的位点） |
| `since` | 客户端保存的位点，服务端只发 `seq > since` 的变化。**首次不传**，等价于从 0 开始 |
| `next_since` | 本次全部拿完后要保存的新位点；不透明字符串，原样保存即可 |
| 主键 | `(trace_id, day, app_version)`。`trace_id` 不唯一（跨模型/重跑），本地落库必须用三元组 |
| `op` | `upsert`（新增或内容变化）/ `delete`（数据里已消失） |
| `change.changed_at` | 该条变更进入索引的时间（UTC RFC3339），不是数据业务时间 |

`items[]` 与 `/traces` 的条目字段完全一致，只多一个 `change`：

```json
{
  "trace_id": "tr_9f2c…",
  "day": "2026-11-10",
  "app_version": "AIME-Atlas_expert",
  "analyzed_at": "2026-11-12T08:31:02Z",
  "problems": [...],
  "problem_codes": ["S9.M5.1"],
  "change": {"seq": 25117, "op": "upsert", "changed_at": "2026-11-13T01:20:11Z"}
}
```

`deleted[]` 只有定位信息：

```json
{"trace_id": "tr_old…", "day": "2026-10-02", "app_version": "aime-fast-new_fast",
 "seq": 25118, "op": "delete", "changed_at": "2026-11-13T01:20:11Z"}
```

测试用户（`user_rules.json` 命中的账号）不会出现在 `items` / `deleted` 里，与其在
`/traces` 等接口的口径一致。

## 用法

### 1. 首次全量

不传 `since`，按 `page_size`（默认 100，上限 1000）翻页：

```bash
curl -s "$API/changes?dataset=aime_eval&page_size=500"
```

```json
{
  "request_id": "req_…",
  "schema_version": "2.0",
  "data": {
    "items": [ ... ],
    "deleted": [],
    "page_size": 500,
    "has_more": true,
    "next_cursor": "…",
    "next_since": null,
    "since_seq": 0,
    "head_seq": 25874,
    "latest_seq": 25874
  },
  "meta": {"data_updated_at": "2026-11-12T08:31:02Z", "latest_seq": 25874, "...": "..."}
}
```

`has_more=true` 时带 `next_cursor` 继续：

```bash
curl -s "$API/changes?dataset=aime_eval&page_size=500&cursor=<next_cursor>"
```

最后一页 `has_more=false`、`next_since` 非空，把它**落盘保存**。`since` 与 `cursor` 不能混用：
`cursor` 只在同一个 `since` 窗口内翻页（30 分钟过期，过期返回 410，重新从该 `since` 开始即可）。

### 2. 之后的增量

```bash
curl -s "$API/changes?dataset=aime_eval&since=<保存的 next_since>"
```

- 没有新数据：`items=[]`、`deleted=[]`、`has_more=false`，`next_since` 与传入的 `since` 等价。
- 有新数据：只返回这部分，通常是几十到几百条。业务侧按 `op` 合并本地库。
- `deleted[]` 与 `items[]` 共用 `page_size` 配额，顺序都按 `seq` 升序。

`since` 也接受纯数字 `seq`（如 `since=25874`），方便手工排查；生产环境请保存
`next_since`，不要自己拼。

### 3. 怎么判断“数据最近更新过”

| 字段 | 位置 | 含义 |
|---|---|---|
| `meta.data_updated_at` | 所有接口 | 索引里最新一条 trace 的分析产物时间（UTC） |
| `meta.built_at` | 所有接口 | 服务端快照构建时间；数据延迟 ≈ 落盘 + 最多 1 小时 |
| `meta.latest_seq` | 所有接口 | 服务端当前最新变更序号；与本地 `since_seq` 不同就是落后了 |
| `data.next_since` | `/changes` | 本次同步完成后的位点 |
| `latest_seq` / `build.changes` | `/healthz` | 服务端变更流规模，用于监控 |

不传 `since` 就能拿到当前全量 + 位点，所以“首次同步”和“重建本地库”是同一套调用。

## 客户端伪代码

```python
def sync(base, dataset, since, store):
    cursor = None
    while True:
        params = {"dataset": dataset, "page_size": 500}
        if since:
            params["since"] = since
        if cursor:
            params["cursor"] = cursor
        data = get_json(f"{base}/changes?" + urlencode(params))["data"]

        for item in data["items"]:
            store.upsert((item["trace_id"], item["day"], item["app_version"]), item)
        for gone in data["deleted"]:
            store.delete((gone["trace_id"], gone["day"], gone["app_version"]))

        if not data["has_more"]:
            since = data["next_since"]          # 落盘
            return since
        cursor = data["next_cursor"]
```

要点：

1. 先落库、最后再更新本地位点；中途失败重跑同一个 `since` 是安全的（幂等 upsert）。
2. 所有写操作以三元组为键；`trace_id` 单独做主键会互相覆盖。
3. 收到 HTTP 409 `SYNC_RESET`：服务端索引重建过，丢到本地 `since` 不清本地数据、
   从 `since` 留空重新全量同步一次（upsert 会覆盖已有记录）。

## 错误

| 状态 | code | 场景 |
|---|---|---|
| 400 | `INVALID_ARGUMENT` | `since` / `cursor` 非法、`page_size` 越界、缺 `dataset` |
| 409 | `SYNC_RESET` | 位点比服务端最新还大（索引重建），从空 `since` 重新同步 |
| 410 | `CURSOR_EXPIRED` | 翻页 `cursor` 超过 30 分钟，重新从同一个 `since` 开始 |
| 422 | `UNKNOWN_CODE` | `dataset` 不是 `aime_eval` |
| 503 | `UNAVAILABLE` | 服务正在首次构建索引，稍后重试 |

## 与全量接口的关系

- `/changes` 是全量数据的变更流视图：首次不传 `since` 等价于全量导出，**推荐用它替代
  `/traces` 翻页导出**，之后只拉增量。
- `/summary`、`/severity`、`/traces` 仍是实时查询接口，服务端聚合/筛选，不参与同步水位。
- `/traces/{id}` 详情仍按 `(trace_id, day)` 取；`/changes` 的 `day` 可直接用于详情请求。

## 接口文档

```bash
curl -s "$API/docs"            # 文档索引（name / title / url）
curl -s "$API/docs/incremental"  # 本篇 Markdown 原文
```
