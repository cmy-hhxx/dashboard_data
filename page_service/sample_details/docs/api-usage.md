# 评测样本详情服务 · 接口说明（5002）

只读、无鉴权（仅内网使用），提供单样本完整输入/输出详情页与 JSON 出口。每套部署仅服务自身产品（请求另一产品返回 404）。

| 部署 | 直连地址 | DSW 代理基址（`$BASE`） | 产品 |
|---|---|---|---|
| **乌兰察布** | `http://117.50.195.94:2833` | `https://rtahz.10jqka.com.cn/bmtp/proxy/dsw/trace-detail` | `wencai` |
| **弗吉尼亚** | `http://10.217.219.2:2476` | `https://rtahz.10jqka.com.cn/bmtp/proxy/dsw/trace-detail-oversea` | `aime` |

集群内跨容器用 `http://interactive-i6piqwvlnsr5:5002`（问财）、`http://interactive-s3ynzadcvm9c:5002`（AIME）。端口总表见 [docs/接口使用指南.md](../../../docs/接口使用指南.md)。

## 1. 详情页 URL

```text
$BASE/?product=aime&case=<split>%7C<model>%7C<session_id>&trace=<trace_id>
$BASE/?product=aime&slug=<10位小写hex>
```

- `case` 为 `split|model|session_id`（`|` 须编码为 `%7C`），多轮会话自动合并、默认停在最后一轮。
- 加 `&trace=<trace_id>`（同 5003 `/traces` 的 `trace_id`）直接定位并滚动到该轮；必须与 `case` 或 `slug` 同传，未找到时明确报错。
- 附加独立展示页：`/matrix/?matrix=1`（聚类矩阵）、`/compare/?compare=1&product=&round=&pair=`（版本对比）。

## 2. 只读 JSON 接口

| 路径 | 说明 |
|---|---|
| `GET /api/context?product=&case=`（或 `&slug=`，可选 `&trace=`） | **推荐入口**：返回该会话的索引行 + `taxonomy` + 回显 `trace`（`case` 优先） |
| `GET /samples/<slug>.json` | 单条完整详情（`input.traces[]`、`attribution.{problems,turns}`、`compact`、`evidence[]`） |
| `GET /samples-<product>.json` | 该产品全量召回索引（不含 `lb`，建议 `curl --compressed`） |
| `GET /labels-<product>.json` | 问题标签 `{schema, product, labels:[…]}`，按行号与全量 `rows[]` 一一对应 |
| `GET /healthz` | 服务存活与上游 5001 看板探活状态 |

```bash
curl -sG "$BASE/api/context" --data-urlencode 'product=aime' \
  --data-urlencode 'case=daily|aime_expert|thread_1f9a49fdcdf041b39e84f12e6a3b147e'
curl -s "$BASE/samples/ba6ba417f2.json" -o sample.json
```

### 关键字段速查

- **索引行（`rows[]`）**：`s` slug、`q` 问句、`m` 模型、`sp` 分组（`daily/lost`）、`d` 日期、`sid`/`tid` 会话/trace ID、`tr` 轮数、`n` 问题数、`w` 最严重等级、`r/st/pt` 环节/阶段/模式编码、`sc` 场景。
- **详情（`/samples/<slug>.json`）**：`ids`、`meta`、`input.traces[]`、`attribution.problems[]`、`attribution.turns[]`（含每轮 `trace_id`）、`compact`、`evidence[]`（`t` trace / `m` 消息 / `b` block / `o` 偏移）。

## 3. 约定与限制

- **编码与压缩**：UTF-8 JSON；≥ 1 KB 自动 gzip；`/healthz` 为 `no-store`，其余 `no-cache`。
- **状态码**：`200` 成功、`400` 参数错误、`404` 样本不存在或测试用户被剔除、`502` 上游看板异常；错误体 `{"ok": false, "error": "…"}`。
- **测试账号不供数**：索引 / context / 详情均剔除 `ut=test` 样本（看板本身仍展示全部用户）。
- **时效与性能**：`/api/context` 索引缓存 120s；未访问过的详情首次由 5001 按需生成（0.5–4s，多轮会话更久），之后走磁盘缓存。
- **代理注意**：DSW 代理会剥离路径前缀，页面内所有请求必须使用相对路径；本服务不支持搜索与批量导出。
