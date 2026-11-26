# AIME 增量同步接口（/changes）

本地已有数据时，按服务端单调递增变更序号 `seq` 只拉新增、变更与删除，替代按天全量重拉。

```text
首次：GET /changes?dataset=aime_eval&page_size=500                     → 当前全量 + next_since（默认 text_mode=raw）
增量：GET /changes?dataset=aime_eval&since=<next_since>&page_size=500  → 新增/变更/删除
人话：GET /changes?dataset=aime_eval&text_mode=human&page_size=500     → 人话版本全量 + 绑定 human 的 next_since
```

## 1. 设计与核心概念

归因文件会补数、重跑或整份重写，mtime 不可靠；`/changes` 仅在业务字段（问句、用户、来源、意图、问题条目、编码、严重度）真正变化时写入新 `seq`（`file`/`line`/`analyzed_at`/`analysis_id` 变动不触发重发）。

- **文本版本与异步补译（`text_mode=raw|human`，默认 `raw`）**：人话译文晚于归因产出；当某条 trace 的人话译文首次补齐或重译更新时，服务端写入人话专属事件——`text_mode=raw` 消费方完全跳过且 `meta.latest_seq` 静止（零噪音），`text_mode=human` 消费方收到 `upsert` 自动将本地 `fallback_raw` 刷新为 `human`。
- **位点隔离**：`since` 绑定 `text_mode`（旧版无模式标记的位点视为 `raw`）；从 `raw` 切换至 `human`（或反之）时若传入另一模式的位点，接口返回 `409 SYNC_RESET`，清空 `since` 重新全量同步即可，防止本地库原文与人话混脏。

| 字段 | 说明 |
|---|---|
| 主键 | `(trace_id, day, app_version)` —— **`trace_id` 不唯一，本地必须用三元组落库** |
| `since` / `next_since` | 客户端位点（绑定 `dataset` + `text_mode`，首次不传等价于 0；亦兼容纯数字 `seq` 排查） |
| `items[]` | 与 `/traces` 同构，含 `text_mode`（`raw`/`human`/`fallback_raw`）与 `change: {seq, op: "upsert", changed_at}` |
| `deleted[]` | 删除墓碑：`{trace_id, day, app_version, seq, op: "delete", changed_at}` |
| 测试用户 | 与 `/traces` 一致，测试账号不出现在 `items` 或 `deleted` 中 |

## 2. 同步流程与翻页规则

1. **翻页**：单页 `page_size` 默认 100、上限 1000（`items` 与 `deleted` 共用配额，按 `seq` 升序）。`has_more=true` 时带 `next_cursor` 继续（**不要在翻页期间修改 `since`**）；`cursor` 30 分钟过期返回 `410`，从同一 `since` 重来即可。
2. **保存位点**：直到 `has_more=false` 时 `next_since` 才非空；**必须先落库、再保存 `next_since`**，同一 `since` 重放幂等。
3. **无变化**：`items=[]`、`deleted=[]`、`has_more=false`，`next_since` 与传入值等价。

### 判断数据新鲜度

- `meta.data_updated_at`：最新一条 trace 产物时间（UTC）。
- `meta.built_at`：服务端快照构建时间（延迟 ≤ 1 小时）。
- `meta.latest_seq`：服务端当前最大变更序号（与本地 `since_seq` 不同即有更新）。

## 3. 客户端伪代码

```python
def sync(base, dataset, since, store):
    cursor = None
    while True:
        params = {"dataset": dataset, "page_size": 500}
        if since: params["since"] = since
        if cursor: params["cursor"] = cursor
        data = get_json(f"{base}/changes?" + urlencode(params))["data"]

        for item in data["items"]:
            store.upsert((item["trace_id"], item["day"], item["app_version"]), item)
        for gone in data["deleted"]:
            store.delete((gone["trace_id"], gone["day"], gone["app_version"]))

        if not data["has_more"]:
            return data["next_since"]  # 先落库，最后持久化位点
        cursor = data["next_cursor"]
```

## 4. 错误处理与接口关系

| HTTP | code | 处理方式 |
|---|---|---|
| `400` | `INVALID_ARGUMENT` | 检查 `since`/`cursor`/`page_size`/必填 `dataset` |
| `409` | `SYNC_RESET` | 服务端索引重建导致位点失效；丢弃本地 `since`（不删数据）从空重拉一次 |
| `410` | `CURSOR_EXPIRED` | 翻页超过 30 分钟；保留原 `since`、清空 `cursor` 重试 |
| `422` | `UNKNOWN_CODE` | `dataset` 不是 `aime_eval` |
| `503` | `UNAVAILABLE` | 服务首轮建索引中，退避重试 |

- 首次同步与本地库重建完全等价（均不传 `since`）；单条完整对话仍按 `GET /traces/{trace_id}?dataset=aime_eval&day=<day>` 拉取。
- 在线文档：`GET /api/v1/analysis/docs`、`GET /api/v1/analysis/docs/incremental`。
