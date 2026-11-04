# 评测样本详情服务 · 接口说明

把单个评测样本的完整输入 / 输出、轨迹、对话、归因和证据定位做成可单独打开的详情页，
并提供一组只读 JSON 接口，方便直接跳转查看或接入自己的系统。

两套部署，接口形态一致（完整 IP / 端口映射 / 容器名见 [接口使用指南](../../../docs/接口使用指南.md) 第零节）：

| 部署 | 主机 | 容器名 | 数据 | 5002 对外 |
|---|---|---|---|---|
| 乌兰察布 | `117.50.195.94` | `interactive-i6piqwvlnsr5` | 问财（看板 wencai-only，页面接口沿用） | `2833` |
| 弗吉尼亚 | `10.217.219.2` | `interactive-npasm9ch66eb` | AIME | `2222` |

- DSW 代理（平台剥掉路径前缀，转发到对应容器的 5002）：
  - 乌兰（问财）：`https://rtahz.10jqka.com.cn/bmtp/proxy/dsw/trace-detail/`
  - 弗吉尼亚（AIME）：`https://rtahz.10jqka.com.cn/bmtp/proxy/dsw/trace-detail-oversea/`
  - 未配代理时可用直连：乌兰 `117.50.195.94:2833`、弗吉尼亚 `10.217.219.2:2222`
- 每套部署只服务自己产品：乌兰只有 `wencai`，弗吉尼亚只有 `aime`；另一个产品会 404
- 只读、无鉴权；仅内部使用，请勿公开传播
- 数据每小时随看板重建更新（`REFRESH_SECONDS=3600`）

## 1. 页面

看板地址见 [接口使用指南](../../../docs/接口使用指南.md) 第零节（乌兰察布 `http://117.50.195.94:2768/`、
弗吉尼亚 `http://10.217.219.2:2221/`）。在「具体数据」选中样本后，把地址栏的看板端口换成详情页端口
（`view` 参数会被忽略）：

```
https://rtahz.10jqka.com.cn/bmtp/proxy/dsw/trace-detail/?product=wencai&case=daily%7Cb_fast%7Cthread_9d238e0db12e4d2d96efdebda331bef2
https://rtahz.10jqka.com.cn/bmtp/proxy/dsw/trace-detail-oversea/?product=aime&slug=ba6ba417f2
```

直连等价地址：`http://<外部IP>:<5002 对外端口>/?product=…`（乌兰 `117.50.195.94:2833`、
弗吉尼亚 `10.217.219.2:2222`）。

`case` 是 `split|model|session_id`，也可以直接传 10 位小写 slug。AIME 一个会话的多轮评测会合并成一页，
默认停在最后一轮。

**定位到会话里的某一轮**：加 `&trace=<trace_id>`（5003 `/traces` 的 `trace_id`，也就是详情里
`attribution.turns[].trace_id` 的那套 ID）：

```text
https://rtahz.10jqka.com.cn/bmtp/proxy/dsw/trace-detail-oversea/?product=aime&case=daily%7Caime_fast%7Cthread_19de…&trace=20003020179337992707500000000286
```

- 找到 → 选中并滚动到该轮，归因区显示该轮的问题；URL 保留 `trace`，刷新仍定位同一轮。
- 找不到 → 页面明确提示“trace 不在这个会话里”，不会静默停在别的轮。
- `trace` 必须和 `case`（或 `slug`）一起用；单独给 `trace` 无法定位会话。

## 2. 接口

> 下面示例里的 `$BASE` 按产品选代理基址：问财 `https://rtahz.10jqka.com.cn/bmtp/proxy/dsw/trace-detail`、
> AIME `https://rtahz.10jqka.com.cn/bmtp/proxy/dsw/trace-detail-oversea`；
> 直连时换成目标环境的 `http://<外部IP>:<5002 对外端口>`（见第零节）。

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/context?product=…&case=…`（或 `&slug=…`） | 推荐入口：会话的召回索引行 + taxonomy，不含轨迹 |
| GET | `/samples/<slug>.json` | 单条样本完整详情（轨迹、归因、证据） |
| GET | `/samples-<product>.json` | 该产品全量召回索引，支持 gzip |
| GET | `/healthz` | 存活检查 + 上游看板探活 |

### 2.1 `/api/context`

参数二选一（`case` 优先）：

| 参数 | 必填 | 说明 |
|---|---|---|
| `product` | 否 | `wencai` / `aime`；省略时两个产品都会尝试 |
| `case` | 二选一 | `split\|model\|session_id`（即索引行的 `sp\|m\|sid`），需 URL 编码 |
| `slug` | 二选一 | 10 位小写十六进制 |
| `trace` | 否 | trace_id；仅回显，用于页面定位。轮次匹配在前端按详情 `attribution.turns[].trace_id` 做 |

```bash
curl -sG "$BASE/api/context" \
  --data-urlencode 'product=aime' \
  --data-urlencode 'case=daily|aime_expert|thread_1f9a49fdcdf041b39e84f12e6a3b147e'
```

响应结构 `{product, index:{rows, models, splits, …}, taxonomy, trace}`；`rows[0].s` 就是详情接口的 slug，
`trace` 是请求里带的 trace_id（未带为 `null`）。

| 字段 | 含义 |
|---|---|
| `s` | slug（详情接口用） |
| `q` / `m` / `sp` / `d` | 问题 / 模型 / 分组（`daily`、`lost`）/ 日期 |
| `sid` / `tid` | 会话 ID / trace ID |
| `tr` / `n` | 轮数 / 问题数 |
| `w` / `lb` | 最严重等级（P0…）/ 问题标签 |
| `r` / `st` / `pt` | 归因环节 / 阶段 / 模式（编码，映射见 `taxonomy`） |
| `sc` | 场景（问财） |

### 2.2 `/samples/<slug>.json`

```bash
curl -s "$BASE/samples/ba6ba417f2.json" -o sample.json
```

| 字段 | 内容 |
|---|---|
| `product` / `split` / `model` / `date` / `question` / `lang` | 样本基本信息 |
| `ids` / `meta` | 会话、trace、case；模型、token、耗时等元信息 |
| `input.traces[]` | 完整输入轨迹（按轮） |
| `attribution.problems[]` / `turns[]` | 归因问题 / 逐轮归因 |
| `compact` / `evidence[]` | 压缩概览 / 证据定位（`t` trace、`m` 消息、`b` block、`o` 偏移） |

### 2.3 `/samples-<product>.json`

全量召回索引（问财约 2 MB、AIME 约 9 MB，随数据增长），建议开 gzip：

```bash
curl -s --compressed "$BASE/samples-wencai.json" -o index.json
```

### 2.4 `/healthz`

```json
{"ok": true, "port": 5002, "upstream": "http://127.0.0.1:5001", "upstream_ok": true, "upstream_last_refresh": 1793702589.56}
```

## 3. 约定与注意

- UTF-8 JSON；≥ 1 KB 且客户端支持时自动 gzip；`/healthz` 为 `no-store`，其余 `no-cache`
- 状态码：`200` 成功、`400` 参数错误、`404` 样本不存在、`502` 上游看板异常；错误统一 `{"ok": false, "error": "…"}`
- 首次打开慢：详情按需生成，未访问过的样本约 0.5–4 秒，之后走磁盘缓存；AIME 多轮会话首次更久
- `/api/context` 索引有 120 秒进程内缓存，看板刚重建完最多约 2 分钟后才跟上
- 无鉴权，仅内部使用；只读，避免高频批量拉取；建议先 `/api/context` 定位会话，再取详情
- 想看某一轮：`?case=…&trace=<trace_id>`；轮次位置在详情 `attribution.turns[].trace_id` 里自行匹配
- 不支持列表搜索、批量导出

## 4. 部署与端口（维护者）

| 容器端口 | 角色 | 乌兰察布对外 | 弗吉尼亚对外 |
|---|---|---|---|
| `5001` | 展示（看板生产） | `2768` | `2221` |
| `5002` | 页面接口（本服务） | `2833` | `2222` |
| `5003` | 供数（数据接口） | 已停用 | `2224` |
| `5004` | 开发调试 | `3336` | `2228` |
| `5005` | 备用 | `3337` | `2243` |

- 外部同事用 DSW 代理地址或「IP + 对外端口」；集群内跨容器用容器名 + 容器端口
  （乌兰 `interactive-i6piqwvlnsr5:5002`、弗吉尼亚 `interactive-npasm9ch66eb:5002`），同容器内用 `127.0.0.1`
- 生产入口固定，不在其上调试；页面 / 接口的迭代在 `5004` 验证后再发布到 `5002`
- 代理会剥掉路径前缀，前端 URL 必须用相对路径（不带前导 `/`），否则在代理下会 404
