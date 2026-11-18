# 看板交接

> **部署分工（2026-11-04 起）：** 乌兰 5001=问财看板、5002=问财页面接口、5003 已停用；
> 弗吉尼亚 5001=看板、5002=页面接口、5003=供数，AIME 新数据只在弗吉尼亚更新。
>
> **2026-11-09：** 弗吉尼亚看板数据源切到 SSD `/mnt/aime_eval_ssd`（产品目录 `1_aime`）；
> 对弗吉尼亚的远程操作要走 SSH 长连接（ControlMaster / ControlPersist），见
> `docs/dashboard-deployment.md` 的「弗吉尼亚 SSH 必须用长连接」。
>
> 三视图、亮暗色、1440/1024/390 已验证。部署与端口见 `docs/dashboard-deployment.md`。

## 1. 先跑起来

```bash
cd <仓库根目录>

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

scripts/run_tests.sh             # 全部套件；只跑看板：scripts/run_tests.sh dashboard（在服务器上跑）
for f in dashboard/static/js/*.js; do node --input-type=module --check < "$f" || break; done
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

- `build.py` 增量扫描输入、归因、compact，按 session key 配对；只生成变化的
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
  显示「未定位」。**输入索引按产品一次建全量**：归因日期和输入文件日期可以不同（trace 级
  发布/补数），key 对不上时再按 `trace_id` 回退匹配。
- 聚类 4.4 的 `item_index.jsonl` 不再带 `json_path`/行号，用
  `(trace/session/case, turn_index, problem_index, label)` 关联；旧 `json_path` 仍兼容。
  `item_index`/`cluster_tree` 的 schema 或缓存口径变化时，要 bump
  `CLUSTER_INDEX_VERSION`/`PAIRING_VERSION`/`INPUT_INDEX_VERSION`，否则旧 pickle 会继续生效。
- compact 的 `evidence_id` 里 message index 是**整场扁平 trace 的全局下标**；build 需按
  各 trace 消息数累加换算成 `(trace, local_index)`，不能把 compact turn 当 trace 直接
  `place()`，否则第 2 条 trace 起的 compact 证据会越界或错位。
- `server.py` 启动时缺数据会构建，之后默认每 10 分钟刷新（`REFRESH_SECONDS`，默认 600，可在 `deploy.env` 覆盖；同一时间只跑一个构建，见 `cache/build.lock`），页面每 2 分钟条件请求检查并就地刷新；`/healthz`
  返回最近一次构建摘要。
- **构建内存（2026-11-18）**：弗吉尼亚容器 cgroup 上限 16 GiB，AIME 全量构建的父进程峰值约
  10–12 GB（14 万条样本摘要常驻）。样本阶段的 fork 池会复制页，4 个 worker 足以把容器顶到 OOM；
  OOM 杀掉一个 worker 后，父进程会永远卡在向死管道写任务（兄弟 worker 仍持有读端），构建不退出、
  一直占着 `cache/build.lock`，之后每次定时构建都超时，看板的 `generated_at` 就此停住（2026-11-17
  16:15–11-18 02:29 的停更就是它）。`build.py` 现在按 cgroup 余量把池降到放得下的数量，放不下就
  串行（`capped_workers`）；串行峰值约 15.2 GB / 16 GiB，余量很小，扩容到 24–32 GiB 之前不要再用
  `--jobs >1` 并跑其它重型进程。卡住的构建可以 `pkill -f eval_dashboard/build.py` 后立即重建。
- 前端无框架、无打包器；原生 ES modules + SVG + 手写 CSS，唯一第三方库是内置的 `static/vendor/lightweight-charts`（K 线 / 趋势图）。
- 生产由 `deploy.sh` 同步代码到远端，在远端构建数据、预压缩并重启；不要手改远端目录。

## 3. 页面与入口

| 路由 | 模块 | 内容 |
|---|---|---|
| `?view=data&product=wencai\|aime` | `data.js` | 会话场、聚类矩阵、数据量、评测量、归因、聚类、预测；所有下钻都在页内 |
| `?view=speed&product=…` | `speed.js` | AIME 评测速度与实时调度：输入/输出进度、Chunk 队列与在跑锁、实时 RPM / 网关探活 / `.parts` 吞吐、聚类进度与日期分布 |
| `?view=system&product=…` | `system.js` | 评测体系机制图（输入 → 压缩 → 归因 → 聚类热力矩阵）、证据闭环；点问题进入全屏逐步推导（`evidence_theater.js`）；每个标签页会话首次进入时多光标搭建一遍（`builder.js`，sessionStorage `eval-build:sys`） |
| `?view=docs[&doc=severity\|capacity]` | `docs.js` | 文档：液体注入卡片（`shader_flood.js`，WebGL，2D canvas 兜底）；文档页暂为占位 |
| `?view=samples&product=…&case=…&trace=…` | `samples.js` | 具体数据两栏：问句列表 | 同卡上方轨迹概览 + 三列（轨迹 / 对话 / 归因）；证据连线在对话与归因之间；`trace` 定位到会话里的某一轮 |
| `?view=data&detail=eval&ed=…&em=…` | `data.js` | 评测量详情：日期 → 模型 → session 三层表格；最后一层进入具体数据的完整输入/输出 |

顶部右侧是全局产品切换（问财 / AIME），也是数据源指示；不要在每个卡片里重复放切换。
图表都在页内下钻；数据页从上到下是数据量 + 评测量、聚类矩阵、归因 / 聚类 / 预测、会话场；会话场格子跳到该条样本，聚类矩阵格子在本卡里就地展开「场景 × 问题聚类」的
P0-P4 多折线趋势（默认全部来源 × 全部模型 × 全部问题，时间范围固定全部；来源 / 模型 / 等级可多选合并成一条线，最多 4 条，可删到 0 条显示空状态；多条线用面积叠层显示，底部是 Trace 量能柱，发版日画一根红线；「其他场景」折叠行的格子先展开），卡片头「← 返回矩阵」回到原表。
趋势卡底部有滚轮缩放锁：锁定（默认）时滚轮正常滚动页面，解锁后滚轮缩放图表；问题分析的 K 线使用同一套锁。
矩阵下方并排两张分析面板（「总体趋势」与「问题分析」），默认展开、没有开关；点进某个格子看就地趋势时它们收起，回到矩阵再出现。左侧问题趋势固定全部时间，不再有 7/30 天工具条；点分支卡片即可下钻，右侧热力矩阵按同一条分类路径重画，热力矩阵的下钻/返回也会反向刷新左侧。放大镜只展开单张卡片，不参与下钻。
两栏并排时左右两栏从同一条顶线开始，第一张卡的上沿对齐；右栏工具条里是等级 chips，
卡内左侧是问题等级环形图（各段合计 100%，环心是 Trace 总数，右侧图例行可开关趋势），右侧是 Trace 趋势 K 线；
K 线口径为全量日期：每个周期内「所选等级 Trace 数」聚合成蜡烛（开盘取上一周期收盘，最高/最低取周期内极值），
叠加「全部等级总 Trace」量能（不画均线）；`mxp-trend-head` 内是 日内行情 / 日K / 周K / 月K / 年K 周期切换；
「日内行情」只画最新交易日的 5 分钟蜡烛（按美东时间当天过滤，跨午夜的请求不并入）：图从当日 0 累计，没有新数据的槽画平；
悬浮显示本根 5 分钟蜡烛的「开盘（5分钟前）/ 收盘（5分钟后）」。解锁后滚轮 / 捏合 / 拖时间轴缩放，双击复位；
点蜡烛打开对应日期的样本抽屉：抬头只显示时间 / 数据量 / 返回，周期切换在抽屉打开时收起；抽屉不显示汇总条和底部说明。
「问题分析」卡片右上角有全屏键，进入后铺满视口，Esc 或同一键退出。
图例行与 chip 共用一份选择，点哪边都会同步重画（切换只做 120ms 淡入，高度不变）；下面是 30 天热力图，
格子的悬浮放大 + 2px 留白和按行错峰的入场复刻会话场。
「聚类矩阵」标题旁的「A/B Test」（仅当该产品有 `ab_test/` 轮次时出现）会让聚类矩阵卡原位 3D 翻转。
卡片头是期次 chip（一轮一个，后续新增 AB 只加 chip）+ 全屏 icon（卡片离开 bento 铺满视口，Esc 或同一 icon 退出）。
汇总区三张等宽卡：三批聚类树（发版前 / 发版后同题 / 发版后线上）、变化构成（三批问题数量 + 四条流向 消除 / 减少 / 增加 / 新增，合计即净变化）、
问题变化排行（变好 / 变差共用 0–max 哑铃刻度，样本抽屉托管在变化构成卡里）；每张卡右上角的推拉 icon 让该卡占行、
另两张收成关键数字（沿用 bento 卡片的 FLIP 逻辑）。
汇总区下方是场景 × 问题聚类的 AB 矩阵：场景/聚类表头可层层下钻（「← 返回」逐级回退，只重绘矩阵这一段，上方汇总不闪），每个有数据的格子点开就是该格跨期趋势；
可切换「同题变化 / 线上真实」两个矩阵；场景的 Trace 总数只写在场景名后（如「交易建议（160条）」）；同题变化矩阵写的是固定题集在该场景的 trace 数（同一批题前后相同），
线上真实矩阵的格子只写「问题数 + 比例」，同题变化矩阵的格子写四个数字：发版前问题数 → 发版后问题数、净增减、增减比例，颜色即方向（降为绿、升为红）；点开变化矩阵的格子后，趋势头同时给出该格的 Trace 数；
右侧变化合计列、底部场景合计行和右下角总计用同一套四数逻辑。
同题变化 = 同题复测 − 同题基线；线上真实是另一批用户，只单独成一个矩阵，不与固定题集相减。
矩阵右侧是问题合计、底部是可点的场景合计；最后一行/最后一列用浅背景强调；底部列合计点开看该问题聚类在全部场景上的趋势。
趋势图的样本抽屉不再给每个问句标问题数（口径难解释），也去掉了摘要下方的分布横条。
**模型口径**：轮次的模型集由复测的 cluster_tree 目录决定（1106 = expert），四个口径、聚类树样本和线上真实样本都按该模型过滤，
payload 的 `rounds[].models` 暴露该集合，页面上只用一个标签表示：`v1106` 旁的 expert / fast / fast+expert。
点格子看跨期趋势，趋势头可按「改版前 / 改版后 / 线上真实」召回样本。

顶部导航「版本对比」的初始页是一条全宽版本时间轴（无标题 / 无说明小字，按 released_at 排布、单版本居中、上下交替、轴线画出、节点 spring 入场、hover 光晕，窄屏退化纵向轴），点节点进入同题对比页；左栏列出当前轮次固定题集（`pairs`，可比的两侧优先、再按「改版后 −
改版前」的落点变化降序，可搜索、分页），右侧把 **改版前 / 改版后 / GPT** 三块并排（窄屏仍是同一条
三列栅格，不折行）；详情仍是原工作台（`pane pane-out pane-sticky`：轨迹 / 中间链路 / 证据连线 / 归因
三列 + 折叠），由 `sample_detail.js` 的同一个工厂渲染（samples 页与 compare 页共用）；
改版前用主 samples 的会话 slug，改版后用 `/ab_samples/<round>/<eq>.json`；GPT 列读
`/gpt_samples/<round>/<key>.json`（`07_gpt_answer/raw/<key>.json` 的懒解析，只有回答正文、URL 引用和
web-search query）。缺一侧详情时该侧只留标题条与一句空态；GPT 尚未跑到的题保留该列并显示「待补」，
不编造。
- 三列同排、各自内部滚动；左栏列表收起后（窄轨「同题列表」）列宽不变，窄于 1180px 只取消固定
  高度，不改成上下堆叠。
- 期次信息（v1106 / 题量 / 模型）收在左栏筛选头：模型模式与「改版前 / 改版后 / GPT」三列开关同排，
  「有核验」筛选与题量、同步滚动 / 折叠按钮同排；有核验的题在列表里用对勾
  标记，「有核验」筛选只看这些题。详情头不再重复标题 / chip / 轮次标签，换成 `06_verify/verify.jsonl`
  的事实核验区：新格式按 `paired_model` 的模型分块，`verifiable_fact_check_list` 的 `common` / `special`
  与 `eval_per_model` 同组同 `fact_id` 合并且按模型 id 落到对应列（`before_release` → 改版前、
  `after_retest` → 改版后、以后含 `gpt` 的块 → GPT），没有核验不渲染。verify.jsonl 的 mtime 进
  `rounds_signature`，最新的文件在下一次构建后自动替换。
  每侧头部的放大键把该侧铺满视口，Esc / 同一键退出。
- 对比的是「整段会话里的某一轮」：标题按当前选中轮次的用户提问显示（`createSampleDetail` 的
  `roundQuestion` 选项），不显示会话第一句；轮次 / session 总评切换时标题一起换，各列才是同一个问题。
A/B 面板里的样本入口（旭日图叶子样本、矩阵格趋势的样本抽屉、线上真实样本）都跳到这页；线上样本没有
同题对照，单块展示。
**只有 A/B 面板跳这里**：数据看板 / 聚类矩阵 / 会话场等其它入口仍然跳「具体数据」。

## 4. 文件地图

| 文件 | 用途 | 通常什么时候改 |
|---|---|---|
| `dashboard/build.py` | 数据解析、配对、聚合、生成三类 payload | 口径、字段、聚合、预测接入 |
| `dashboard/build_store.py` | SQLite 增量索引：逐文件偏移/键/哈希/输入统计、配对与样本缓存 | 缓存结构、扫描口径、增量失效 |
| `dashboard/stats_worker.py` | 独立输入统计旁路，写 `datasets/stats.json` | 统计字段、刷新间隔 |
| `dashboard/detail_builder.py` | 样本详情按需生成、cluster 映射重载与磁盘缓存 | 详情格式、懒加载 |
| `dashboard/json_compat.py` | 可选 `orjson` 快路径，标准库兜底 | JSON 兼容性 |
| `dashboard/server.py` | 静态服务、gzip、定时构建、`/healthz`、`/speed.json` | 服务行为、缓存、刷新 |
| `dashboard/speed_monitor.py` | AIME 评测速度、Chunk 队列、`.parts` 实时吞吐与网关 RPM/探活采集 | 实时监控口径、网关探测 |
| `dashboard/static/js/app.js` | 路由、主题、产品切换、模块懒加载、错误兜底 | 页面级状态 |
| `dashboard/static/js/core.js` | 共享格式化、数字动画、`segmented`、提示等 | 通用交互 |
| `dashboard/static/js/data.js` | 数据页各卡片、评测量详情、聚类矩阵与格子里的趋势图 | 数据页排版、下钻、趋势 |
| `dashboard/static/js/speed.js` + `css/speed.css` | 评测速度页：15s 轮询 `/speed.json`，展示进度、队列、RPM 趋势与网关实时调度 | 评测速度与网关展示 |
| `dashboard/static/js/trend_chart.js` | 共享趋势图：折线/面积、问题聚类点、发版红线、格子趋势几何 | 趋势图形状、坐标轴、发版标注 |
| `dashboard/static/js/kline_data.js` | K 线聚合：日内行情 5 分钟 / 日/周/月/年 OHLCV，纯函数 | 周期口径、聚合规则 |
| `dashboard/static/js/kline_chart.js` | 基于 vendor 的 lightweight-charts 画蜡烛、量能与悬浮读数；`createTrendChart` 为聚类矩阵的多线趋势（面积叠加、Trace 量能、发版红线、解锁按钮控制滚轮缩放） | 图表交互、配色、图例 |
| `dashboard/static/vendor/lightweight-charts.production.js` | TradingView lightweight-charts v5.2.1（Apache-2.0，许可证同目录） | 升级图表库 |
| `dashboard/tests/test_kline_chart.mjs` | K 线周期聚合与周期按钮回归 | 改 K 线口径 |
| `dashboard/config/releases.json` | 发版日期默认配置（`<datasets>/releases.json` 可覆盖） | 新增发版、改版本名 |
| `dashboard/static/js/system.js` | 评测体系机制图、聚类（阶段 → 环节 → 机制 → 模式）、证据闭环 | 体系页 |
| `dashboard/static/js/evidence_theater.js` | 证据闭环全屏视图：左轨迹、右「问题 → 证据引用 → 原始消息 → 推导出的现象」四步，引用到原句的连线；懒读 `samples/<slug>.json` 补现象 / 推理 / 定级理由 | 体系页证据呈现 |
| `dashboard/static/js/builder.js` | 多光标页面搭建动画 + 底部播放条（暂停 / 重播 / 跳过）；只用 clip-path 隐藏，跳过或完成后清掉 | 体系页入场 |
| `dashboard/static/js/shader_flood.js` + `docs.js` + `css/docs.css` | 文档页与液体注入卡片 | 文档页 |
| `dashboard/static/js/pixel_toggle.js` | 顶栏像素日夜开关（点击 / 拖动 / 键盘），切主题仍走 app.js 的 view transition | 主题开关 |
| `dashboard/static/js/samples.js` | 具体数据两栏工作台（样本列表 + 详情） | 列表、筛选、分页 |
| `dashboard/static/js/sample_detail.js` | 样本详情工厂（head + 轨迹 / 中间链路 / 归因、证据连线、轮次切换）；samples 与版本对比共用，`prefix` 控制 id | 详情呈现、证据交互 |
| `dashboard/static/js/compare.js` + `css/compare.css` | 版本对比页：同题列表 + 改版前 / 改版后 / GPT 三栏详情（GPT 懒读 `/gpt_samples/`），A/B 面板样本的落点 | 同题对比排版、路由、事实核验 |
| `page_service/problem_matrix/` | 5002 聚类矩阵独立页 `/matrix/`（反代看板 `?matrix=1`）；样本抽屉 → 样本详情，A/B 抽屉 → `/compare/` | 页面挂载、矩阵展示 |
| `page_service/compare_details/` | 5002 版本对比展示页 `/compare/`、`/compare_details/`（反代看板 `?view=compare&compare=1`） | A/B 召回落点、展示态裁剪 |
| `page_service/page_proxy.py` | 5002 页面服务共用的只读反代挂载（`/matrix`、`/compare`、`/dashboard`） | 挂载实现、前缀/查询透传 |
| `dashboard/ab_detail.py` | 改版后重测详情的懒生成（attribution + compact + retest_input，item_index 回填聚类落点） | 改版后详情、缓存 |
| `dashboard/tests/test_compare.mjs` / `test_sample_detail.mjs` | 版本对比纯逻辑、详情工厂焊点、样本列表回归 | 改 compare / 详情 |
| `dashboard/static/js/render.js` | 公共内容渲染：Markdown-lite、JSON 高亮、按偏移保留证据高亮 | 文本 / JSON 呈现 |
| `dashboard/ab_test.py` | A/B Test 轮次读取：清单 / 逐条叶子落点 / 前后并集树 / 线上真实用户 → `abtests-<product>.json` | A/B Test 数据接入 |
| `dashboard/static/js/abtest.js` + `css/abtest.css` | A/B Test 面板（记录列表、三批汇总、聚类矩阵、跨期趋势） | A/B Test 对比交互 |
| `dashboard/static/js/sunburst.js` | 原生 SVG 可下钻旭日图 | 数据量 / 聚类环 / AB 并集树 |
| `dashboard/static/js/galaxy.js` | 星图：一颗星一条 Trace、按分组成团的 canvas 视图（推拉展开的卡片里） | 星图布局、配色、交互 |
| `dashboard/static/js/particles.js` | 证据流：沿证据连线流动的低密度粒子（体系页证据闭环、样本页） | 粒子密度、速度 |
| `dashboard/static/css/*.css` | 样式按页拆分，按 index.html 中的顺序加载：`base`（token / 重置）→ `layout`（外壳 + Bento）→ `content`（消息内容、证据 mark、anatomy 底座）→ `data` → `system` → `samples`（具体数据工作台） | 样式微调、响应式 |
| `dashboard/tests/*.py` | 合成数据端到端构建、增量、sidecar、懒详情测试 | 改 build.py 后 |
| `dashboard/deploy.sh` | 同步、远端构建、预压缩、重启 | 发布 |

先读 `README.md`、`docs/design-principles.md`、`docs/dashboard-deployment.md`、`docs/build-performance.md`、
`docs/prediction-data.md`、`docs/data-server.md`。

## 5. 数据契约

`static/data.json`（共享壳）：

```text
{ schema, generated_at, products{<product>:{…简要}}, taxonomy, system, source }
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
tr 输入 Trace 数 · mc 消息数 · lang · case 会话键 · s 短 slug
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
  四层都能点；`base` 是该日该场景该模型该来源的已评测 Trace 数（Σ`tr`，含无问题 Trace），是比例的分母；
  `cells` 里的 `pK` 是 P K 问题条数、`hK` 是出现该等级问题的去重 Trace 数，比例 = hK / base；
  `hAny` 是这些 Trace 的并集（`ΣhK` 会把同一条 Trace 在多个等级上重复计数，合计口径必须用 `hAny`）。
  `hAny` 后面是 `(等级 mask, Trace 数)` 稀疏直方图：mask 第 k 位表示该 Trace 命中 Pk；多选等级（如
  P0+P1+P2）时，把 mask 与选中位有交集的 Trace 数相加，就是精确的命中 Trace 并集（schema 2 起提供；
  schema 1 的老文件没有这段，前端对多等级比例会退化成按等级相加后再截断）。
- 合计算 P0-P4 全部问题，与矩阵格子「问题合计」同口径；矩阵本身仍只画 P0-P1 的着色。
- 发版日期：`<datasets>/releases.json` 优先（问财 / AIME 分开写，支持 `"YYYY-MM-DD"` 或
  `{"date","label"}`）；数据目录没有该文件时读仓库内 `dashboard/config/releases.json`（随代码走）。
  当前 AIME 配置：v1030 = `2026-10-30`、v1106 = `2026-11-06`。两份文件任一变化都会让构建重写 trends payload。
- UI：发版日在趋势图上是一条红色竖线（从顶轴贯到底轴 + 淡红带 + 顶端版本名）——「总体趋势」的小图与
  展开大图、聚类矩阵格子的趋势图、A/B Test 矩阵趋势（单期时落在改版前/改版后的分界）都会显示；
  问题聚类点改成了规则点环（点数/半径随问题量、浓度随命中率），不会越过坐标轴被裁。

`static/abtests-<product>.json`（懒加载：数据页点「聚类矩阵」标题旁的 A/B Test、或进入「版本对比」页；
只有 `<datasets>/<n>_<product>/ab_test/` 存在时才生成）：同一批**固定问句**在发版前后各评测 + 聚类一次，
再叠一批发版后的线上真实用户评测做验证；三批在 UI 内先汇总，矩阵直接跟在汇总区下方。

```text
{ schema: 3, generated_at, product, models[], labels{status,b_reason,sources},
  rounds[{ id, order, version, label, released_at, generated_at, targets,
           status{A,B,C}, b_reason{B1,B2}, sources[[name,n]…], dates[first,last],
           sides{before{traces,hits}, after{traces,hits}|null,
                 online{traces,hits,from,to,user_type}|null},
           leaves[{id,name,before,after|null,online|null,model_*,source_*}],
           nodes[{id,level,parent,name,before,after|null,online|null}],
           matrix{before[[task,sub,[[path,n]…]]…], after|null, online|null},
           pairs[{id,eq,q,scene,sub,
                  before{trace,model,detail,n,paths,status},
                  after{trace,model,detail,n,paths,status}|null,
                  gpt{key,has,model}}…],
           gpt{total,answered,model,effort}?,
           verify{question_id:{models[{id,label,facts[{fact_id,kind,what_to_check,
                  model_answer,is_correct,correct_answer,correct_answer_source,
                  responsible_component,attribution}]}…]}}?,
           sample_refs{before[{trace,model,task,sub,paths,slug?,pair,eq,q,detail}…],
                       after[{trace,model,task,sub,paths,pair,eq,q,detail}…],
                       online[{slug,trace,model,task,sub,paths}…]}}] }

- `pairs` = 固定题集全部 1137 行（`01_targets/questions.jsonl` 顺序 = `coverage_after_release_retest.eq_index`），
  供「版本对比」左栏；`before.detail` 是主 samples 的会话 slug（多 slug 无唯一解时 null），
  `after.detail` 是能生成改版后详情的 eq（attribution 里存在该 `case_id` 才算）。
  `gpt` 是 `07_gpt_answer/questions.jsonl` + `raw/<key>.json` 的存在性：`has=false` 就是页面上的「待补」；
  回答正文不进 payload，打开该列时才请求 `/gpt_samples/<round>/<key>.json`。
- `gpt` 汇总（总题数 / 已完成 / 模型与 effort）只在轮次有 `07_gpt_answer/` 时出现；没有该目录就没有
  第三列，不会伪造空列。
- `verify` 是新版 `06_verify/verify.jsonl` 归一化后的结果：按 `paired_model` 的模型顺序输出，`common` /
  `special` 与 `eval_per_model` 按 `fact_id` 合并；旧版只有 `checks` / `results` 的批次也照常读。
  verify.jsonl 的 (size, mtime) 与 GPT raw 文件一起进 `rounds_signature`，数据一更新就重建 payload。
- `sample_refs` 的三批保留聚合口径：`before/after` 是命中叶子的 trace 级引用（after 不带主 samples slug），
  `online` 是线上真实用户样本；`pair/eq/q/detail` 只用于从 A/B 面板跳到版本对比。
- `schema` 2 → 3 只因新增 `pairs` 与 refs 字段；旧 payload 会自动重建。
- 改版后详情：主 samples 索引里没有重测样本，`ab_detail.py` 在第一次打开
  `/ab_samples/<round>/<eq>.json` 时从轮次里的 attribution + compact + 重测输入懒生成
  （`99_provenance/retest_input/*.jsonl` 和 `03_after_release_retest/inputs/*.jsonl` 都读；
  输入暂时没发布时仍出详情，页面显示「没有评测输入」空态，不是 404）；
  问题落点用 `03_after_release_retest/cluster_tree/<model>/item_index.slice.jsonl` 的
  `(trace_id, json_path)` → `path/edge` 精确回填（不依赖 `cls_paths/cls_labels` 的平行关系）。

- 轮次目录（2026-11 v1106 起的数据侧新布局，`dashboard/ab_test.py` 两种布局都读）：
  `00_manifest/coverage_before_release_cluster.csv`（**before 的权威落点**，A/B/C = 970/138/29）、
  `coverage_after_release_retest.csv`（after 重测状态 + 落点，940 评测 / 818 落点）、
  `coverage_after_release_online_real.csv`（线上批次，未落盘时只有表头）；
  `02_before_release/cluster_tree/<model>/`、`03_after_release_retest/cluster_tree/<model>/`、
  `04_after_release_online_real/cluster_tree/<model>/` 各放 `item_index.slice.jsonl` + `leaves.tsv` +
  `cluster_tree.json`。叶子名取自 `leaves.tsv`（L3）和 `cluster_tree.json`（L4）。
- 只支持上面这一种布局（旧的 `coverage.csv` + `03_cluster_<ver>/` + `04_retest_after/` 已不再读取）；轮次目录名
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
与 5002 的透传接口都不再含 `lb`，业务方按行号配对（见 `docs/接口使用指南.md` 第 6 节「变更记录」）。

用户类型由 `dashboard/user_rules.py` 判定，规则/名单放在 `<datasets>/user_rules.json`
（`EVAL_USER_RULES` 可覆盖）：**真实 userid = 纯数字且 ≤10 位**（业务方 2026-11-17），
其余（英文名 / 内部号 / ≥11 位数字）都算测试账号，看板标 `ut=test`、5003 整条不供数；
`test.ids` 可显式指定，`real.ids` 可把某个号捞回，位数上限是 `heuristics.real_user_id_max_digits`（默认 10）。
流失 = uid 命中 `lost.ids` 名单（旧目录仅兼容）。规则 hash 进构建完成标记，
改名单后下一次构建自动重建，不需要改代码。

选中样本后再请求 `/samples/<slug>.json`（由 `detail_builder.py` 按需生成并缓存），主要字段：
`input.traces[]`、`attribution.problems[]`、`compact`、`evidence[]`；证据的
`t/m/b/o` 分别是 trace、message、block 与偏移。不要把完整 trace 塞回索引。

预测卡读 `datasets/4_forecast/<product>/prediction.json`（旧位置 `datasets/<n>_<product>/prediction.json` 兜底），
缺失时显示「暂无预测数据」；接口格式见 `docs/prediction-data.md`。

`<datasets>/<n>_<product>/dashboard_data_absence/` 是数据缺口落地目录：只要该目录存在，`build.py`
每次构建（含复用构建）都会写 `<product>-data-absence.json` / `.md`，逐模型列出「有输入、没有
attribution / compact」的日期，并给出聚类落点缺口与 A/B 轮次、发版配置、预测 feed、聚类映射的可用性。
没有这个目录的产品（AIME）不会被写；`EVAL_ABSENCE_DIR` 可改目标位置。

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
   做单条轮播：上一条 / 下一条只换当前 Trace 的 anatomy，默认直接展示，不在体系页承载全部样本。
4. **改聚类体系**：`build.py` 的 `taxonomy_out` 提供阶段/环节/机制/模式；
   `system.js` 的 `flowCard` / `patternMatrix` / `wireFx` 负责渲染与阶段联动。
5. **改构建性能 / 缓存**：`build_store.py` 的 `scan_file`、`BuildStore`；`build.py` 的
   `scan_inputs`、`pairs_from_keys`、`build_samples`。改 detail 结构时同步 bump
   `build_store.BUILD_VERSION`，否则旧样本缓存会被误用；改完删 `cache/` 跑一次全量验证。
6. **改样本筛选**：`samples.js`（列表）的 `F()`、`skeleton()`、`syncFilters()` 和列表
   过滤逻辑；筛选字段来自 `samples-<product>.json` 行，保持 URL 可分享。
   用户类型筛选走 `ut`（`?ut=test`），流失筛选走 `split=lost`（由行上的 `ul` 标记合成）。
   只改分类规则时改 `<datasets>/user_rules.json`，不要改前端。
7. **改样式**：改 `css/` 下对应页面的文件（样本页只在 `samples.css`），优先复用现有 token 和类。不用硬边框，用 1%~3% 的
   微差灰阶分层、同心圆角、README「设计规则」里的间距 token、数字 `tabular-nums`。

## 7. 容易踩的坑

- **证据闭环高度**：体系页的 `.echo` 固定桌面高度，`#anatomyBody` 需要
  `min-height: 0` 才能内部滚动；不要把 `.echo` 改成内容撑高。
- **证据连线**：`sample_detail.js` 的 `drawThreads` 依赖 `.anatomy` 内
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
- **单 trace 输出 → 会话聚合**：后端现在会按 trace 评测，一行只有一条 trace，但详情格式仍是 session 形态。
  具体数据里 `groupSessions` 按 `(split, model, session_id)` 把行并成一个会话，`sample_detail` 的
  `loadSession` 拉齐该会话全部详情：`dropSubsetParts` 去掉被多 trace 全量详情包含的单 trace 子集，
  其余用 `mergeSessionDetails` 拼接输入、turn、问题、证据和紧凑输出并重排 id；对比页（compare）在
  单 trace 详情上按 `ids.session` 从 samples 索引补齐同会话的其它行后再交给同一个详情工厂。
  数据侧全部规整成聚合形态后，这些前端兼容逻辑仍然兼容。
- **Session 点评**：只有详情的 `attribution.summary` 字段存在时才渲染「session 总评」入口和 Session 点评；
  单 trace 输出没有这个字段，就不显示（不要再补「暂无点评」占位）。Trace 点评仍取 `turns[i].summary`。
- **复制**：`navigator.clipboard` 在 HTTP 下不可用，`copyText` 必须有 textarea + `execCommand`
  回退；按钮反馈「已复制 / 复制失败」。
- **数据页跳样本只有一处**：会话场格子带会话键（payload 字段 `case`）；聚类矩阵格子不再跳页，而是在卡片里换成趋势图
  （`data.js` 的 `openTrend` / `paintTrendPlot`），旭日图、桑基图、预测页签仍只在页内下钻。
  问财的场景在 `build.py` 里来自 skill 投票，索引行用 `sc` 携带与 task/skill 不一致的场景，`samples.js` 的 `sceneOf` 优先读它。
- **聚类矩阵卡的样本抽屉**：抽屉展开会让 `.mxt-sample-layout` 分栏、地图变窄；趋势图已统一到
  `kline_chart.js` 的 `createTrendChart`（lightweight-charts 外壳，拖拽平移内置；滚轮缩放由锁按钮控制），
  宽度变化由图表自己的 ResizeObserver 跟随，不再重绘；`paintTrendPlot` 里的
  `plot._drawer?.destroy()` 仍会关掉刚打开的抽屉，不要在抽屉打开时无条件重画。
  抽屉抬头只保留日期 / 样本量 / 返回，列表上方不再渲染 `gl-sum`，底部也不再显示扫描与口径说明。
  空态文案按真实原因区分（无候选 / 候选未命中簇 / AB 批次这一格无命中 / 有命中但没有可打开详情），
  不要统一写「当前索引中没有匹配样本」。
- **聚类矩阵全屏**：卡头 `#mxFull` 切 `.mx-card.is-mx-full`，`body.is-mx-full` 锁滚动，
  Esc 或同一枚键退出；整张矩阵卡（含分析面板）铺满视口，不再另挂一份矩阵。
- **生成物不是源码**：`static/data.json`、`static/data-<product>.json`、`static/samples.json`、
  `static/samples-<product>.json`、`static/labels-<product>.json`、`static/trends-<product>.json` 由构建产生，`static/samples/` 是详情懒加载缓存，都不入库；
  本地刷新/远端部署会自动重建。详情缓存可以安全删除，下一次访问按需补。
- **部署**：`./dashboard/deploy.sh`；完成后看 `logs/build.log` 和 `/healthz` 的
  `ok`、`build.pairs`。构建失败不会自动回滚，服务可能继续使用旧数据。
- **构建缓存**：`cache/build.sqlite3` 是运行时状态，不入库；删除后全量重建。追加写只从
  最后一个完整换行继续；没有换行结尾的文件最后一行不会提交，等下一条完整行。
  cluster 快速签名在 `cache/cluster-signature.json`，映射 pickle 在 `cache/clusters-<sig>.pkl`；
  `datasets/stats.json` 是 stats worker 的旁路统计，删除后 build 会局部重扫。
- **流失口径**：数据统一在 `eval_input/0_daily_eval_input`，按 `<datasets>/user_rules.json`
  的 `lost.ids`（user_id 名单）匹配；目录名不再决定流失。名单变化会让输入统计按
  `stats._lost_sig` 重扫一次。问财仍兼容输入 `meta.lost_user`。
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
- **聚类矩阵是 trace 口径（2026-11-18）**：`products[<p>].cross` 一行一条已评测 trace（含无问题
  trace；没有输入 trace 的记录不进），所以各场景行合计 = `kpi.traces`（Σ`tr`）。格子主数字 = 命中该
  聚类的 trace 数（同一条 trace 命中同一列的多个叶子只算一次），占比 = 命中 trace ÷ 该场景全部
  trace（≤100%）；问题条数只留在「问题合计」列和悬浮说明里。`trends-<product>.json` 的 `base` 同样
  按 trace 计数，`h*` 是按 trace 去重；改这类 payload 形状必须 bump `PAYLOAD_VERSION`，否则
  `reused` 构建不会重写旧数据。
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
