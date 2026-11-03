# 看板交接

> 2026-11-01 · `main` @ `20138ca` · 三视图、亮暗色、1440/1024/390 已验证。

## 1. 先跑起来

```bash
cd /Users/cmy/Desktop/dashboard_data

# 数据更新后重建（服务运行时也可以执行）
./dashboard/local_dev/refresh.sh

# 启动本地服务（会先构建，再监听 :5001）
./dashboard/local_dev/start.sh
# 打开 http://127.0.0.1:5001/
# 停止：./dashboard/local_dev/stop.sh
```

数据从仓库根目录 `datasets/` 读取，未放入数据时显示待接入空态；也可用
`EVAL_DATASETS=/path/to/datasets` 指定。`datasets/` 和 `servers.conf` 都已 gitignore，
不要提交数据或部署密钥。

检查：

```bash
curl -s http://127.0.0.1:5001/healthz   # 必须看 JSON 内容；状态码恒为 200

cd dashboard
python3 -I -m unittest discover -s tests -p 'test_*.py'
for f in static/js/*.js; do node --check "$f"; done
```

验收固定做：三个视图 × 问财 / AIME × 亮暗色 × 1440/1024/390，控制台无报错、
无横向溢出。改完 `static/` 下的 JS/CSS 直接刷新页面，无构建步骤。

浏览器控制台若出现 `zotero.js` / `messaging_inject.js` 的连接错误，那是 Zotero
连接器扩展的问题，不是看板；重载扩展或禁用后验证即可。

## 2. 数据流

```text
datasets/ ──> stats_worker.py ──> datasets/stats.json（每 30 分钟，独立进程）
   │
   └─ build.py（cache/build.sqlite3 增量索引）
        ├─ static/data.json(.gz)              共享 taxonomy/system + 产品元数据
        ├─ static/data-<product>.json(.gz)    单产品 KPI/会话场/聚类/预测
        ├─ static/samples.json(.gz)           产品清单
        └─ static/samples-<product>.json(.gz) 单产品召回索引
                        │
server.py（标准库 HTTP，:5001，定时 build）──> app.js
        └─ /samples/<slug>.json 按需生成 ──> detail_builder.py
                                                ├─ data.js    数据页
                                                ├─ system.js  评测体系页
                                                └─ samples.js 样本页
                                                   core.js / sunburst.js / app.css
```

- `build.py` 增量扫描输入、归因、compact，按 `对应关系.csv` 或 session key 配对；只生成变化的
  样本摘要，**不再全量写逐样本详情**。`cache/build.sqlite3` 保存文件索引、配对、样本摘要和
  详情生成所需的行号/引用。输出版本、KPI、会话场、聚类矩阵、预测、体系说明和样本索引；
  生成物不要手改，重新构建。
- `stats_worker.py` 旁路统计输入侧 records / traces / tools / tokens / task-subtask / lost，
  写 `<datasets>/stats.json`；`build.py` 只信任 `(size, mtime_ns)` 仍匹配的条目。
- `detail_builder.py` 在样本页第一次打开 `/samples/<slug>.json` 时，用 SQLite 行号从原始
  input/output/compact 读取并生成详情，写完 `.json` + `.gz`；之后由 `server.py` 静态服务。
- 样本摘要按输入/输出/compact 行哈希缓存，**不含 cluster 内容签名**；cluster 变化时只重映射
  摘要里的 `cl`，不重读全部输入。cluster 的 stat 侧缓存和 head/tail 指纹避免每次重读 30 MB
  的 `item_index.jsonl`。
- 同一 `session_id + request_time` 有多个输入快照时，按归因各轮 `trace_id` 覆盖度选
  最完整的那份；不要退回文件顺序，否则后续轮次的 evidence 没有 transcript，页面只能
  显示「未定位」。
- compact 的 `evidence_id` 里 message index 是**整场扁平 trace 的全局下标**；build 需按
  各 trace 消息数累加换算成 `(trace, local_index)`，不能把 compact turn 当 trace 直接
  `place()`，否则第 2 条 trace 起的 compact 证据会越界或错位。
- `server.py` 启动时缺数据会构建，之后默认每 30 分钟刷新；`/healthz`
  返回最近一次构建摘要。
- 前端无框架、无打包器、无外部运行时依赖；原生 ES modules + SVG + 手写 CSS。
- 生产由 `deploy.sh` 同步代码到远端，在远端构建数据、预压缩并重启；不要手改远端目录。

## 3. 页面与入口

| 路由 | 模块 | 内容 |
|---|---|---|
| `?view=data&product=wencai\|aime` | `data.js` | 会话场、数据量、评测量、归因、聚类、预测、聚类矩阵；所有下钻都在页内 |
| `?view=system&product=…` | `system.js` | 评测体系机制图（输入 → 压缩 → 归因 → 聚类）、证据闭环 |
| `?view=samples&product=…&case=…` | `samples.js` | 具体数据两栏：问句列表 | 同卡上方轨迹概览 + 三列（轨迹 / 对话 / 归因）；证据连线在对话与归因之间 |
| `?view=data&detail=eval&ed=…&em=…` | `data.js` | 评测量详情：日期 → 模型 → session 三层表格；最后一层进入具体数据的完整输入/输出 |

顶部右侧是全局产品切换（问财 / AIME），也是数据源指示；不要在每个卡片里重复放切换。
数据页不跳样本；样本页负责深链进入。

## 4. 文件地图

| 文件 | 用途 | 通常什么时候改 |
|---|---|---|
| `dashboard/build.py` | 数据解析、配对、聚合、生成三类 payload | 口径、字段、聚合、预测接入 |
| `dashboard/build_store.py` | SQLite 增量索引：逐文件偏移/键/哈希/输入统计、配对与样本缓存 | 缓存结构、扫描口径、增量失效 |
| `dashboard/stats_worker.py` | 独立输入统计旁路，写 `datasets/stats.json` | 统计字段、刷新间隔 |
| `dashboard/detail_builder.py` | 样本详情按需生成、cluster 映射重载与磁盘缓存 | 详情格式、懒加载 |
| `dashboard/json_compat.py` | 可选 `orjson` 快路径，标准库兜底 | JSON 兼容性 |
| `dashboard/server.py` | 静态服务、gzip、定时构建、`/healthz` | 服务行为、缓存、刷新 |
| `dashboard/static/js/app.js` | 路由、主题、产品切换、模块懒加载、错误兜底 | 页面级状态 |
| `dashboard/static/js/core.js` | 共享格式化、数字动画、`segmented`、提示等 | 通用交互 |
| `dashboard/static/js/data.js` | 数据页各卡片、评测量详情与聚类矩阵 | 数据页排版、下钻 |
| `dashboard/static/js/system.js` | 评测体系机制图、聚类（阶段 → 环节 → 机制 → 模式）、证据闭环 | 体系页 |
| `dashboard/static/js/samples.js` | 具体数据两栏工作台（顶部轨迹概览、三列轨迹 / 对话 / 归因、证据连线） | 筛选、样本详情 |
| `dashboard/static/js/render.js` | 公共内容渲染：Markdown-lite、JSON 高亮、按偏移保留证据高亮 | 文本 / JSON 呈现 |
| `dashboard/static/js/sunburst.js` | 原生 SVG 可下钻旭日图 | 数据量 / 聚类环 |
| `dashboard/static/app.css` | 所有样式与 token | 样式微调、响应式 |
| `dashboard/tests/*.py` | 合成数据端到端构建、增量、sidecar、懒详情测试 | 改 build.py 后 |
| `dashboard/deploy.sh` | 同步、远端构建、预压缩、重启 | 发布 |

先读 `README.md`、`docs/design-principles.md`、`docs/dashboard-deployment.md`、`docs/build-performance.md`、
`docs/prediction-data.md`。`docs/dashboard-optimization.md` 是早期优化记录；涉及
ECharts / board.js 的实现段落已不适用，当前是原生 SVG + ES modules。

## 5. 数据契约

`static/data.json`（共享壳）：

```text
{ schema, generated_at, source, taxonomy, system,
  products{<product>:{label}} }
```

`static/data-<product>.json`：

```text
{ schema, generated_at, product, products{<product>:{ kpi, dates, field, cross, patterns, ... }} }
products[product] = { kpi, dates, field, cross, patterns, ... }
products[product].input = { records, traces, tool_calls, tokens_in/out, lost,
                            tasks[{task,n,lost,sub[{sub,n,lost}]}],
                            models{<model>:{label,traces,lost,tasks[...]}} }
system.goldens[product][] = { slug, date, question, model, problems[], messages[], compact, overview, summary }
```

`static/samples.json` 是产品清单；`static/samples-<product>.json` 的
`products[product].rows[]` 是召回索引，不含完整 trace：

```text
q 问题 · m 模型 · sp daily/lost · d 日期 · w 最严重等级 · n 问题数
sv 严重度构成 · r 环节 · st 阶段 · pt 模式 · tg 标签 · lb 问题标签
tr 轮数 · mc 消息数 · lang · case · s 短 slug
```

选中样本后再请求 `/samples/<slug>.json`（由 `detail_builder.py` 按需生成并缓存），主要字段：
`input.traces[]`、`attribution.problems[]`、`compact`、`evidence[]`；证据的
`t/m/b/o` 分别是 trace、message、block 与偏移。不要把完整 trace 塞回索引。

预测卡读 `datasets/4_forecast/<product>/prediction.json`（旧位置 `datasets/<n>_<product>/prediction.json` 兜底），
缺失时显示「暂无预测数据」；接口格式见 `docs/prediction-data.md`。

## 6. 常见改动怎么下手

1. **改数据口径 / 加指标**：改 `build.py` 的 `build_sample`、`aggregate`、
   `system_facts` 或 `taxonomy_out`；跑 `refresh.sh`；再在对应 JS 中读取新字段。
   加字段后补端到端测试。
2. **改数据页卡片**：在 `data.js` 找到对应 `*Card()` 函数和 `wire()`；保持
   `card(span, …)` 的 12 列 Bento 布局，一卡一主视觉，下钻留在页内。
   评测量详情走 `evalDetailState` / `evalDetailPage` / `wireEvalDetail`，日期 → 模型 → session 用
   `ed` / `em` / `edp` / `ep` 同步 URL；最后一层跳具体数据，不重复实现输入/输出详情。
3. **改证据闭环**：`build.py` 的 `system_facts` 产出 `system.goldens[product][]`
   （每个产品 10 个候选）；`system.js` 的 `goldenCard` / `wireGoldens`
   做单条轮播：上一条 / 下一条只换当前 case 的 anatomy，默认直接展示，不在体系页承载全部样本。
4. **改聚类体系**：`build.py` 的 `taxonomy_out` 提供阶段/环节/机制/模式；
   `system.js` 的 `flowCard` / `patternMatrix` / `wireFx` 负责渲染与阶段联动。
5. **改构建性能 / 缓存**：`build_store.py` 的 `scan_file`、`BuildStore`；`build.py` 的
   `scan_inputs`、`pairs_from_keys`、`build_samples`。改 detail 结构时同步 bump
   `build_store.BUILD_VERSION`，否则旧样本缓存会被误用；改完删 `cache/` 跑一次全量验证。
6. **改样本筛选**：`samples.js` 的 `F()`、`skeleton()`、`syncFilters()` 和列表
   过滤逻辑；筛选字段来自 `samples-<product>.json` 行，保持 URL 可分享。
7. **改样式**：只改 `app.css`，优先复用现有 token 和类。不用硬边框，用 1%~3% 的
   微差灰阶分层、同心圆角、16pt 横向 / 16–24pt 纵向间距、数字 `tabular-nums`。

## 7. 容易踩的坑

- **证据闭环高度**：体系页的 `.echo` 固定桌面高度，`#anatomyBody` 需要
  `min-height: 0` 才能内部滚动；不要把 `.echo` 改成内容撑高。
- **证据连线**：`samples.js` 的 `drawThreads` 依赖 `.anatomy` 内
  `#sout` / `.timeline` / `.threads` / `#sattr` 的 DOM 顺序；`.threads` 必须仍在对话与归因之间，
  且 `drawThreads` 只查 `#sattr .pcard`。改动右栏结构后要重新量一遍连线。
  连线坐标按实际元素边界计算，两侧留白变化时会自动跟随。
- **AIME 是整体**：`unified=true`，日常/流失不拆组；流失只在会话场组头做标记。
- **场景**：问财没有 task 时，场景取 skill 投票（`build.py` 的 `scene`）。
- **评测量详情表格**：日期/模型表用 `.md-table.ed-table`，窄屏保持 720px 横向滚动；session 表用
  `.is-session` 取消 min-width，让评测输入/输出在手机上同屏可见。状态列用 ✅ / `.pending` 未评测，
  汇总同时给未评测数；不要在 session 表里再塞一套逐条未评测记录，索引里只有已评测样本。
- **具体数据只有一套轮次**：轮次只在样本头部 `#ttabs`；归因 / 轨迹内部的 `ctabs` / `atabs` 已删，
  不要再加第二套。消息折叠由 `FOLD_OPEN`（`user` / `answer` 展开）和 `msg.is-folded .blk { display:none }` 控制。
- **答案 Markdown 与证据高亮**：`pieceHTML(..., plain)` 对最终回答优先走 Markdown，避免大表格被
  逐字证据 mark 打散；证据点仍在消息头，证据按钮仍能跳到该消息。其它消息仍保留逐字 mark。
- **问题卡片**：证据放在 `.pcard-evidence` details 里默认折叠，`pcard-meta` 是两行网格
  （第一行角色 / 组件，第二行聚类 path）；`sevrow` 已删，不要恢复。
- **具体数据布局**：`.bench` 铺满视口，左栏 300px；右栏 `#shead` 顶部放问题/chip/ID/轮次/归因总结和
  `#ov`（cmap 全宽 + sp-box 下一行），下方 `.anatomy` 是 `#sout`（轨迹）/ `#stl`（对话）/
  `.threads`（证据连线）/ `#sattr`（归因）。`#sout` 只放 compact 概览与步骤列表，`#sattr` 放 attrHTML；
  `drawThreads` 查 `#sattr .pcard`。旧的 `#otab` / `outSeg` / `tab` 已删，不要再加输出切换。
  `tgroup-head` 已删；归因总结用 `#shead .attr-head`，三列直接开始。`wf` / waterfall 已删。
- **多轮映射**：头部 `#ttabs` 按 `D.rounds` 渲染；`S.trace / S.turn / S.cturn` 分别取
  `D.rounds[i].trace / .turn / .compact`。`withRounds` 的 trace 要 clamp 到可用输入 trace，
  否则“单输入、多归因轮”的会话会拿不到 `input.traces[S.trace]`，中间对话与顶部 cmap 会空白。
- **复制**：`navigator.clipboard` 在 HTTP 下不可用，`copyText` 必须有 textarea + `execCommand`
  回退；按钮反馈「已复制 / 复制失败」。
- **数据页只做页内下钻**：聚类矩阵、旭日图、预测页签都不跳样本；只有样本页
  承接 `case` 深链。
- **生成物不是源码**：`static/data.json`、`static/data-<product>.json`、`static/samples.json`、
  `static/samples-<product>.json` 由构建产生，`static/samples/` 是详情懒加载缓存，都不入库；
  本地刷新/远端部署会自动重建。详情缓存可以安全删除，下一次访问按需补。
- **部署**：`./dashboard/deploy.sh`；完成后看 `logs/build.log` 和 `/healthz` 的
  `ok`、`build.pairs`。构建失败不会自动回滚，服务可能继续使用旧数据。
- **构建缓存**：`cache/build.sqlite3` 是运行时状态，不入库；删除后全量重建。追加写只从
  最后一个完整换行继续；没有换行结尾的文件最后一行不会提交，等下一条完整行。
  cluster 快速签名在 `cache/cluster-signature.json`，映射 pickle 在 `cache/clusters-<sig>.pkl`；
  `datasets/stats.json` 是 stats worker 的旁路统计，删除后 build 会局部重扫。
- **流失口径**：AIME 用 `.archive/1_lost_user_input` 目录；问财用输入 `meta.lost_user`。
  改口径时同时改 `build_store.split_from_rel` / `_aggregate_line` 和前端 `volTree`。
- **服务没有守护进程**：容器/环境重启后需要手动 `start.sh`；端口和刷新间隔可用
  `PORT` / `REFRESH_SECONDS` 覆盖（`start.sh` 里写死了默认 `PORT=5001`）。

## 8. 发布命令

```bash
./dashboard/deploy.sh
curl -s "http://<dashboard-host>:<port>/healthz" | jq
```

远端目录 `/opt/eval_dashboard` 不是 git 仓库，`rsync --delete` 会删除远端多余文件；
回滚应切回旧 commit 后重新部署。生成数据只在远端构建，不要从本地覆盖。
