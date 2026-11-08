# 看板交接

> **部署分工（2026-11-04 起）：** 乌兰 5001=问财看板、5002=问财页面接口、5003 已停用；
> 弗吉尼亚 5001=看板、5002=页面接口、5003=供数，AIME 新数据只在弗吉尼亚更新。
>
> 三视图、亮暗色、1440/1024/390 已验证。部署与端口见 `docs/dashboard-deployment.md`。

## 1. 先跑起来

```bash
cd /Users/cmy/Desktop/eval_data_server

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
node tests/test_eval_counts.cjs
for f in static/js/*.js; do node --input-type=module --check < "$f" || break; done
```

验收固定做：三个视图 × 问财 / AIME × 亮暗色 × 1440/1024/390，控制台无报错、
无横向溢出。改完 `static/` 下的 JS/CSS 直接刷新页面，无构建步骤。

浏览器控制台若出现 `zotero.js` / `messaging_inject.js` 的连接错误，那是 Zotero
连接器扩展的问题，不是看板；重载扩展或禁用后验证即可。

## 2. 数据流

```text
datasets/ ──> stats_worker.py ──> datasets/stats.json（每 1 小时，独立进程）
   │
   └─ build.py（cache/build.sqlite3 增量索引）
        ├─ static/data.json(.gz)              共享 taxonomy/system + 产品元数据
        ├─ static/data-<product>.json(.gz)    单产品 KPI/会话场/聚类/预测
        ├─ static/samples.json(.gz)           产品清单
        ├─ static/samples-<product>.json(.gz) 单产品召回索引（不含 lb）
        ├─ static/labels-<product>.json(.gz)  单产品问题标签，与索引 rows[] 同序
        ├─ static/trends-<product>.json(.gz)  聚类矩阵格子的趋势数据（日 × 场景 × 模型 × 来源 × 等级）
        └─ static/abtests-<product>.json(.gz) A/B Test：固定题集发版前 / 后 + 线上真实用户验证（有 ab_test 目录才生成）
                        │
server.py（标准库 HTTP，:5001，定时 build）──> app.js
        └─ /samples/<slug>.json 按需生成 ──> detail_builder.py
                                                ├─ data.js    数据页
                                                ├─ system.js  评测体系页
                                                └─ samples.js 样本页
                                                   core.js / sunburst.js / css/*.css
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
- `server.py` 启动时缺数据会构建，之后每小时刷新（`REFRESH_SECONDS=3600`），页面每 2 分钟条件请求检查并就地刷新；`/healthz`
  返回最近一次构建摘要。
- 前端无框架、无打包器、无外部运行时依赖；原生 ES modules + SVG + 手写 CSS。
- 生产由 `deploy.sh` 同步代码到远端，在远端构建数据、预压缩并重启；不要手改远端目录。

## 3. 页面与入口

| 路由 | 模块 | 内容 |
|---|---|---|
| `?view=data&product=wencai\|aime` | `data.js` | 会话场、聚类矩阵、数据量、评测量、归因、聚类、预测；所有下钻都在页内 |
| `?view=system&product=…` | `system.js` | 评测体系机制图（输入 → 压缩 → 归因 → 聚类）、证据闭环 |
| `?view=samples&product=…&case=…&trace=…` | `samples.js` | 具体数据两栏：问句列表 | 同卡上方轨迹概览 + 三列（轨迹 / 对话 / 归因）；证据连线在对话与归因之间；`trace` 定位到会话里的某一轮 |
| `?view=data&detail=eval&ed=…&em=…` | `data.js` | 评测量详情：日期 → 模型 → session 三层表格；最后一层进入具体数据的完整输入/输出 |

顶部右侧是全局产品切换（问财 / AIME），也是数据源指示；不要在每个卡片里重复放切换。
图表都在页内下钻；会话场格子跳到该条样本，聚类矩阵紧跟在会话场下面，格子在本卡里就地展开「场景 × 问题聚类」的
P0-P4 多折线趋势（默认全部来源 × 全部模型 × 全部问题；来源 / 模型 / 等级可多选合并成一条线，最多 4 条，可删到 0 条显示空状态，同等级模型之间标差距；「其他场景」折叠行的格子先展开），卡片头「← 返回矩阵」回到原表。
「聚类矩阵」标题旁的「A/B Test」（仅当该产品有 `ab_test/` 轮次时出现）会让聚类矩阵卡原位 3D 翻转，
背面先列出对比记录，再用「改版前 / 改版后 / 线上」三环图展示问题落点；点「下一步」进入与外部矩阵同逻辑的
场景 × 问题聚类矩阵，可切换「变化 / 发版前 / 发版后」三种口径：变化 = 发版后（同题复测 + 线上真实）− 发版前，
三个口径的格子数字、悬浮提示、趋势图都按同一算式显示；点格子看跨期趋势，趋势头可按「改版前 / 改版后 / 线上真实」召回样本。

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
| `dashboard/static/js/data.js` | 数据页各卡片、评测量详情、聚类矩阵与格子里的趋势图 | 数据页排版、下钻、趋势 |
| `dashboard/static/js/system.js` | 评测体系机制图、聚类（阶段 → 环节 → 机制 → 模式）、证据闭环 | 体系页 |
| `dashboard/static/js/samples.js` | 具体数据两栏工作台（顶部轨迹概览、三列轨迹 / 对话 / 归因、证据连线） | 筛选、样本详情 |
| `dashboard/static/js/render.js` | 公共内容渲染：Markdown-lite、JSON 高亮、按偏移保留证据高亮 | 文本 / JSON 呈现 |
| `dashboard/ab_test.py` | A/B Test 轮次读取：清单 / 逐条叶子落点 / 前后并集树 / 线上真实用户 → `abtests-<product>.json` | A/B Test 数据接入 |
| `dashboard/static/js/abtest.js` + `css/abtest.css` | A/B Test 面板（记录列表、三批汇总、聚类矩阵、跨期趋势） | A/B Test 对比交互 |
| `dashboard/static/js/sunburst.js` | 原生 SVG 可下钻旭日图 | 数据量 / 聚类环 / AB 并集树 |
| `dashboard/static/js/galaxy.js` | 星图：一颗星一个 case、按分组成团的 canvas 视图（推拉展开的卡片里） | 星图布局、配色、交互 |
| `dashboard/static/js/particles.js` | 证据流：沿证据连线流动的低密度粒子（体系页证据闭环、样本页） | 粒子密度、速度 |
| `dashboard/static/css/*.css` | 样式按页拆分，按 index.html 中的顺序加载：`base`（token / 重置）→ `layout`（外壳 + Bento）→ `content`（消息内容、证据 mark、anatomy 底座）→ `data` → `system` → `samples`（具体数据工作台） | 样式微调、响应式 |
| `dashboard/tests/*.py` | 合成数据端到端构建、增量、sidecar、懒详情测试 | 改 build.py 后 |
| `dashboard/deploy.sh` | 同步、远端构建、预压缩、重启 | 发布 |

先读 `README.md`、`docs/design-principles.md`、`docs/dashboard-deployment.md`、`docs/build-performance.md`、
`docs/prediction-data.md`。前端是原生 SVG + ES modules，ECharts / board.js 的实现已不再适用。

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
sv 严重度构成 · r 环节 · st 阶段 · pt 模式 · tg 标签
tr 轮数 · mc 消息数 · lang · case · s 短 slug
uid 用户 ID（输入 meta.user_id）· ut 用户类型 real/test/internal/unknown · ul 流失标记（1 才有）
```

`static/trends-<product>.json`（懒加载，聚类矩阵格子第一次点开时才拉）：

```text
{ schema, generated_at, product, models[], releases[{date,label}],
  dates[], uts[], scenes[[task,sub]…], nodes["S1","S1.M2",…],
  base[[day,scene,model,ut,sessions]…],
  cells[[day,scene,node,model,ut,p0…p4,h0…h4,hAny, mask,count, …]…] }
```

- `nodes` 是聚类路径的全部前缀（环节 / 机制 / 模式 / 子模式），格子的列节点按精确匹配取一层，
  四层都能点；`base` 是该日该场景该模型该来源的已评测记录数，是比例的分母；
  `cells` 里的 `pK` 是 P K 问题条数、`hK` 是出现该等级问题的去重会话数，比例 = hK / sessions；
  `hAny` 是这些会话的并集（`ΣhK` 会把同一会话在多个等级上重复计数，合计口径必须用 `hAny`）。
  `hAny` 后面是 `(等级 mask, 会话数)` 稀疏直方图：mask 第 k 位表示会话命中 Pk；多选等级（如
  P0+P1+P2）时，把 mask 与选中位有交集的会话数相加，就是精确的命中会话并集（schema 2 起提供；
  schema 1 的老文件没有这段，前端对多等级比例会退化成按等级相加后再截断）。
- 合计算 P0-P4 全部问题，与矩阵格子「问题合计」同口径；矩阵本身仍只画 P0-P1 的着色。
- 发版日期读 `<datasets>/releases.json`（问财 / AIME 分开写，支持 `"YYYY-MM-DD"` 或
  `{"date","label"}`），文件变了构建会自动重写 trends payload。

`static/abtests-<product>.json`（懒加载，点「聚类矩阵」标题旁的 A/B Test 才拉；只有
`<datasets>/<n>_<product>/ab_test/` 存在时才生成）：同一批**固定问句**在发版前后各评测 + 聚类一次，
再叠一批发版后的线上真实用户评测做验证；三批在 UI 内先汇总、再进入聚类矩阵。

```text
{ schema, generated_at, product, models[], labels{status,b_reason,sources},
  rounds[{ id, order, version, label, released_at, generated_at, targets,
           status{A,B,C}, b_reason{B1,B2}, sources[[name,n]…], dates[first,last],
           sides{before{traces,hits}, after{traces,hits}|null,
                 online{traces,hits,from,to,user_type}|null},
           leaves[{id,name,before,after|null,online|null,model_*,source_*}],
           nodes[{id,level,parent,name,before,after|null,online|null}],
           matrix{before[[task,sub,[[path,n]…]]…], after|null, online|null},
           sample_refs{before[{trace,model,task,sub,paths,slug?}…],
                       after[…], online[…]}}] }
```

- 轮次目录（2026-11 v1106 起的数据侧新布局，`dashboard/ab_test.py` 两种布局都读）：
  `00_manifest/coverage_before_release_cluster.csv`（**before 的权威落点**，A/B/C = 970/138/29）、
  `coverage_after_release_retest.csv`（after 重测状态 + 落点，940 评测 / 818 落点）、
  `coverage_after_release_online_real.csv`（线上批次，未落盘时只有表头）；
  `02_before_release/cluster_tree/<model>/`、`03_after_release_retest/cluster_tree/<model>/`、
  `04_after_release_online_real/cluster_tree/<model>/` 各放 `item_index.slice.jsonl` + `leaves.tsv` +
  `cluster_tree.json`。叶子名取自 `leaves.tsv`（L3）和 `cluster_tree.json`（L4）。
- 旧布局（`00_manifest/coverage.csv` + `03_cluster_<ver>/` + `04_retest_after/`）仍然兼容；轮次目录名
  `0_version1106_test` → 期次 0、版本 v1106。发版日用 `round.json` 的
  `{"released_at","label","title"}` 钉住（v1106 = `2026-11-06`）。
- 口径：`before` / `after` 都数**命中该叶子的 trace 数**（同一批题），前缀节点包含其下所有叶子；
  分母写清楚是 `targets`（固定题集）还是 `sides.*.traces`（有落点的），不要和「线上大盘」的批次占比混。
  `A/B/C` 数据质量总账仍保留在 payload，当前汇总不再单独渲染。
- 场景（task/subtask）按 trace 从 build 的 samples 里取（`sample_scene_map` 同时认归因各轮的
  `trace_id` 与 sample 行），取不到才落 `未接入分类体系`。若数据侧写了可选的
  `00_manifest/trace_scenes.csv`（`trace_id,task,subtask`），它优先于 samples。
- `online`：轮次若已落 `coverage_after_release_online_real.csv` 就直接读；否则从 build 的 samples
  反推 = `round.json.released_at` 起、下一期 `released_at` 前（最后一期到当前）的 `用户类型=real`
  评测，排除固定题集 trace。它是另一批总体，只用于验证问题是否继续出现，不能和 `before` / `after` 直接相减。
- `sides` / `leaves` / `nodes` / `matrix` 四处的 after/online **必须同源同 null**：不可用统一 `null`，
  不能拿 `{}` 或 `[]` 占位，否则前端会把空批次当成「改版后全为 0 / 全面改善」。前端对空批次只在
  `sides` 缺失或 `matrix` 未重建时禁用对应口径，不拿 leaves 冒充。
- 改 `ab_test/` 下的清单 / 树 / `round.json` 会让 reuse marker 失效并重写 payload（只指纹这些文件，
  不扫 attribution 与 provenance）；删掉整个 `ab_test/` 会连带删掉 `abtests-*.json` 并隐藏卡片入口。

问题标签 `lb` 已从索引行拆出（2026-11-07）：`static/labels-<product>.json` = `{schema, product,
labels:["…",…]}`，与 `rows[]` 同长度、同顺序；前端首屏后再拉，搜索时回填。`samples-<product>.json`
与 5002 的透传接口都不再含 `lb`，业务方按行号配对（见 `docs/接口使用指南.md` 四、变更记录）。

用户类型由 `dashboard/user_rules.py` 判定，规则/名单放在 `<datasets>/user_rules.json`
（`EVAL_USER_RULES` 可覆盖）：名单优先，然后「超过十位（11 位及以上）的数字 ID = 测试用户、十位及以内 = 真实用户」、
非数字 = 内部用户，重复问句占比高再改判测试；流失 = 流失目录或流失 uid 名单。规则 hash 进构建完成标记，
改名单后下一次构建自动重建，不需要改代码。

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
   卡片状态只有三态：默认 / 展开（`is-deep`，卡头 `[data-collapse]` 收起）/ 折叠（`is-compact`，
   点卡片或确认键恢复本行）；`miniView` 是折叠态的唯一内容入口，每种卡给它自己的小图
   （环 / 竖条 / 严重度条 / 折线），不要退回纯数字。无数据可下钻的卡由 `pushPull` 的 `openable`
   拦下，不进入展开/折叠；完全没数据的卡用 `is-mini` 直接以折叠态渲染（预测体系即此）。
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
   用户类型筛选走 `ut`（`?ut=test`），流失筛选走 `split=lost`（会同时认 uid 流失名单）。
   只改分类规则时改 `<datasets>/user_rules.json`，不要改前端。
7. **改样式**：改 `css/` 下对应页面的文件（样本页只在 `samples.css`），优先复用现有 token 和类。不用硬边框，用 1%~3% 的
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
- **数据页跳样本只有一处**：会话场格子带 `case`；聚类矩阵格子不再跳页，而是在卡片里换成趋势图
  （`data.js` 的 `openTrend` / `paintTrendPlot`），旭日图、桑基图、预测页签仍只在页内下钻。
  问财的场景在 `build.py` 里来自 skill 投票，索引行用 `sc` 携带与 task/skill 不一致的场景，`samples.js` 的 `sceneOf` 优先读它。
- **生成物不是源码**：`static/data.json`、`static/data-<product>.json`、`static/samples.json`、
  `static/samples-<product>.json`、`static/labels-<product>.json`、`static/trends-<product>.json` 由构建产生，`static/samples/` 是详情懒加载缓存，都不入库；
  本地刷新/远端部署会自动重建。详情缓存可以安全删除，下一次访问按需补。
- **部署**：`./dashboard/deploy.sh`；完成后看 `logs/build.log` 和 `/healthz` 的
  `ok`、`build.pairs`。构建失败不会自动回滚，服务可能继续使用旧数据。
- **构建缓存**：`cache/build.sqlite3` 是运行时状态，不入库；删除后全量重建。追加写只从
  最后一个完整换行继续；没有换行结尾的文件最后一行不会提交，等下一条完整行。
  cluster 快速签名在 `cache/cluster-signature.json`，映射 pickle 在 `cache/clusters-<sig>.pkl`；
  `datasets/stats.json` 是 stats worker 的旁路统计，删除后 build 会局部重扫。
- **流失口径**：AIME 用 `.archive/1_lost_user_input` 目录；问财用输入 `meta.lost_user`。
  AIME 回测暂存目录 `eval_input/2_task_eval` 不计入输入量（`build.input_files` 已跳过），
  回测数据以追加行的方式发布到 `eval_input/0_daily_eval_input` 后才算日常输入。
  改口径时同时改 `build_store.split_from_rel` / `_aggregate_line` 和前端 `volTree`。
- **服务没有守护进程**：容器/环境重启后需要手动 `start.sh`；端口、刷新间隔和是否起统计旁路可用
  `PORT` / `REFRESH_SECONDS` / `STATS_WORKER` 覆盖（`deploy.sh` 会把本地设置的这三个变量带到远端）。
  预发：`EVAL_DEPLOY_REMOTE=/opt/eval_dashboard_2 PORT=5004 STATS_WORKER=0 ./dashboard/deploy.sh`。
  **端口角色固定**：`5001` 展示（看板生产）、`5002` 页面接口、`5003` 供数（数据接口，当前是对话分析
  查询接口 v2）、`5004` 开发调试、`5005` 备用；开发调试用 `5004`，不要占用 `5001` / `5002` / `5003`。
  两台服务器映射见 `servers.conf` 与 `docs/dashboard-deployment.md`。
- **推拉布局**：`data.js` 的 `pushPull` 管两行（`bento[data-top]` / `bento[data-bottom]`）。旭日图到最里层（焦点的子节点都是叶子，
  或在非根焦点下选中叶子）时自动展开，评测量 / 归因 / 预测由点击触发；同一行其它卡加 `.is-compact` 只留 `.compact` 关键数字。
  宽度动画是 FLIP + WAAPI（量旧盒子 → 切布局 → 从旧盒子播到新盒子），只在 ≥ 1181px；861–1180px 展开卡占整行，手机星图在图表下方。
  星图数据来自 `samples-<product>.json`（按需加载），索引行的 `r`（归因环节）和预测 payload 的 `items` 都是为它加的。
- **就地刷新**：`app.js` 每 2 分钟条件请求 `data.json`，`generated_at` 变了才换 payload 并带 `refresh: true` 重画；
  数据页的筛选/翻页/下钻/页签/推拉状态在 `data.js` 的 `UI[product]` 里，样本页靠 URL，重画时都会保留。
- **样本页消息对齐**：用户消息不再做右侧气泡，和模型/调用/返回/回答共用同一条左边线与 12px 文字内边距，只用底色区分。

## 8. 发布命令

```bash
./dashboard/deploy.sh
curl -s "http://<dashboard-host>:<port>/healthz" | jq
```

远端目录 `/opt/eval_dashboard` 不是 git 仓库，`rsync --delete` 会删除远端多余文件；
回滚应切回旧 commit 后重新部署。生成数据只在远端构建，不要从本地覆盖。
