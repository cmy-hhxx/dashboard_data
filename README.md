# eval_data_server

AIME 评测数据在远端服务器上的**搬运、打包与看板**工程。

仓库只提交流程、脚本和看板代码；真实数据由本地 `datasets/` 或部署主机的挂载目录与
`ceph-fuse` 接入，不提交到 Git。

## 目录

```
servers.conf                    # 本地部署配置（已 gitignore，不入库）
scripts/pack_aime_io.sh         # 常规打包：AIME 输入 + 输出 → 单个 tar.zst（约 2.5-3 分钟）
scripts/pack_aime_input.sh      # 旧版单流口径（ceph 单流限速后已不推荐）
docs/aime-input-packaging.md    # 打包流程与参数说明
docs/design-principles.md       # 界面设计原则：层级、字重、数字与动效
docs/dashboard-deployment.md    # 看板部署、端口、启动与运维手册
docs/build-performance.md       # 构建基线、增量索引、实测耗时与后续加速点
docs/接口使用指南.md             # 5003 供数接口 + 5002 页面接口的用法（推荐先读）
```

## 快速开始

```bash
scp scripts/pack_aime_io.sh aime_rsi_data:/tmp/
ssh aime_rsi_data 'chmod +x /tmp/pack_aime_io.sh && SRC_BASE=/mnt/fin_bench/aime_rsi_data/1_aime /tmp/pack_aime_io.sh'
```

产物落在 `/mnt/fin_bench/aime_data/aime_input_output_<日期>.tar.zst`。

端到端实测 **151 秒**：12.1 GiB（459 文件）→ **826 MB（6.34% / 15.8×）**，其中 8 路并行
搬运 88 秒、`tar | zstd -12 --long=27` 压缩 39 秒、校验 24 秒。慢在 `ceph-fuse` 单流读只有
~20 MB/s，所以先把文件并行搬到本地暂存再压；产物仍是标准单流 tar.zst，解压不需要特殊参数。
参数与口径见 [docs/aime-input-packaging.md](docs/aime-input-packaging.md)。

## 数据现状

2026-11-04 起 AIME 数据只在弗吉尼亚更新（乌兰的 `1_aime` 是迁移前副本，不再用于打包）。
弗吉尼亚数据根：`/mnt/fin_bench/aime_rsi_data`。

| 数据 | 位置（远端） | 规模 |
|---|---|---|
| AIME 评测输入 | `…/1_aime/eval_input/` | 346 文件 / 11.39 GiB / 12,233,839,658 B |
| AIME 评测输出 | `…/1_aime/eval_output/` | 113 文件 / 0.74 GiB（排除 `.runs`/`.delivery`） |
| 打包产物 | `/mnt/fin_bench/aime_data/` | `aime_input_output_20261103.tar.zst` 826 MB（6.34% / 15.8×） |

包内结构与源目录一致（顶层 `eval_input/`、`eval_output/`）。规模数字是 2026-11-03 打包时的快照。

实时目录（`0_daily_eval_input` 及输出的 `.runs`/`.delivery`）流水线仍在写入；打包按快照语义
处理，并默认排除 `.archive` 与运行现场，详见流程文档「打包口径」。

## 数据看板

`dashboard/` 是问财 / AIME 评测看板：原生 ES modules + SVG + Python 起服务；除可选的 `orjson` 外不依赖第三方运行时。
本地读取仓库根目录的 `datasets/`；生产按产品分两套数据根：问财读乌兰的
`/mnt/fin_bench/code_and_clean_data/datasets`，AIME 读弗吉尼亚的 `/mnt/fin_bench/aime_rsi_data`；
可通过 `EVAL_DATASETS` 显式指定数据根目录（评测输入、输出、cluster_tree、item_index）。
没有数据时显示待接入空态。将数据放入 `datasets/` 后运行 `./dashboard/local_dev/refresh.sh` 重建；
本地启动方式见 [本地调试说明](dashboard/local_dev/README.md)。
入口分三块，顶部导航切换，query 路由可直接分享：

| 页面 | 路由 | 内容 |
|---|---|---|
| 数据 | `?view=data` | 问财 / AIME 的 2+3 Bento：数据量、评测量、归因、聚类、预测 |
| 评测体系 | `?view=system` | 评测体系 / 证据闭环：评测链路与口径、每个产品 10 个 golden case 的单条轮播、阶段 → 环节 → 机制 → 模式 |
| 样本 | `?view=samples` | 两栏样本工作台：召回 | 评测输入与输出（同一张卡内三栏） |

数据板块的「评测量」卡片右上角有「详情」入口（`?view=data&detail=eval`）：按日期倒序展示每天的评测输入、评测输出与完成率，
日期 → 模型 → session 逐层下钻；session 的「查看」复用具体数据页的完整输入与输出。日期 / 模型行标记 ✅ 或「未评测」，
汇总里给出未评测数量；评测输出按现有 `daily` 口径（归因文件日期）统计。

```bash
./dashboard/deploy.sh                                    # 同步、增量构建、预压缩、重启
ssh eval_data 'cd /opt/eval_dashboard && ./start.sh'       # 乌兰（问财）手动起服务
ssh aime_rsi_data 'cd /opt/eval_dashboard && ./start.sh'   # 弗吉尼亚（AIME）手动起服务
```

服务监听容器 `:5001`（展示端口，乌兰察布对外 `2768`）；其余端口角色（`5002` 页面接口、`5003` 供数、
`5004` 开发调试、`5005` 备用）与两台服务器的映射见
[docs/dashboard-deployment.md](docs/dashboard-deployment.md)。服务每 10 分钟运行一次
`build.py --keep-on-empty`；构建是增量的：输入文件按 `(size, mtime_ns)` 只扫描变化部分，
配对和样本摘要写入 `cache/build.sqlite3`。逐样本详情不再在构建时全量生成，而是在样本页
第一次打开时由 `detail_builder.py` 从 SQLite 行号 + 输入/输出/compact 原始行生成并缓存。
无数据变化时构建复用上一份 payload；有新数据时只扫新文件、只配对变化文件、只生成新摘要，
耗时基线见 [docs/build-performance.md](docs/build-performance.md)。首屏样本在服务启动 / 每轮构建后
后台预热，其余样本首次打开约 0.6–4 秒，之后走静态缓存。删除 `cache/` 会强制全量重建。

`stats_worker.py` 作为独立进程常驻，每 10 分钟把输入侧的 records / traces / tools /
tokens / task-subtask / lost 统计写到 `<datasets>/stats.json`；`build.py` 只接受
`(size, mtime_ns)` 仍匹配的条目，因此旁路统计只是加速器，不会成为正确性依赖。

部署时预压缩 JS/CSS/HTML/SVG；数据侧按产品拆成 `data-<product>.json`、
`samples-<product>.json` 和逐样本 `samples/<slug>.json`，均带 `.gz`。这些 JSON 使用
`no-cache`，重复访问以 304 重验证，仅 `/healthz` 为 `no-store`。
端口映射、部署流程、验证方式和部署最佳实践见
[docs/dashboard-deployment.md](docs/dashboard-deployment.md)。

### 三个板块

**1. 数据板块**：顶部是会话场，中间是 2+3 Bento（数据量 / 评测量，归因 / 聚类 / 预测），底部是聚类矩阵。
问财与 AIME 共用同一套卡片。

- 数据量与聚类：共用 `sunburst.js` 下钻旭日图。数据量的层级是模型 → task → subtask（问财的 task 来自输入侧 meta，缺失时记「未标注」），圆心是评测输入轨迹数；聚类固定在左图右列表，层级是阶段 → 环节 → 机制 → 模式。默认展开最大的分支：内圈是一整圈，外圈是其中一段。点击内圈展开或下钻，点击外圈下钻，点击圆心返回上一级。数据量底部统计与聚类右侧列表都限制在固定卡片高度内，内容过高时内部滚动。流失用户与 task/subtask 合在同一张图：每个扇区外侧的细环表示该分支的流失轨迹占比，列表里的红色数字是流失轨迹数；AIME 从 `.archive/1_lost_user_input` 识别流失，问财从输入 `meta.lost_user` 识别。会话场卡片里的「流失会话」是已产出的流失 split 样本数，和数据量的「流失轨迹」不是同一口径，标签已区分。
- 评测量：按天展示「评测输入 / 已完成」双色柱，支持近 7 天 / 近 30 天 / 全部与全部 / 单模型筛选；全部区间最多聚合 12 段，柱顶数字用 `k` 缩写，精确值在 tooltip。底部固定展示完成 Session、完成 Trace 与评测 Tokens（`K / M / B`）。严重度已在会话场表达，这里不再重复。卡片右上角「详情」进入按日期倒序的每日输入 / 输出 / 完成率明细。
- 归因体系：两列桑基图 `版本 → 归因环节`，悬停版本或环节会高亮对应连线，不显示严重度。
- 预测体系：一个卡片内三张页签——题量（已揭晓 / 待揭晓 / 不可核验 / 其他题）、能力（各版本准确率与正确 / 错误构成）、归因（模型 → 错因的小型桑基图）。数据来自 `datasets/4_forecast/<产品>/prediction.json`，题库按预测侧自己扫过的题计；没有文件的产品显示「暂无预测数据」，数据协议见 [预测卡片数据接口](docs/prediction-data.md)。
- 会话场与聚类矩阵：会话场每格是一条评测记录，按最严重的问题着色，不再合并相邻记录；按可用宽高计算每页容量，超过后分页，并把各严重度均匀分摊到每一页，每个模型/分组下方各自显示页码，悬停显示该条记录的问题数，点击跳到该条样本。聚类矩阵纵轴是场景（Task → Subtask，长列表折叠为「其他场景」），横轴是问题聚类（环节 → 机制 → 模式），最右侧「问题合计」是该场景在各问题聚类上的问题数合计；点行或列标题在原表就地换一层的表，两条面包屑分别返回；点格子跳到按该场景 × 问题聚类预填筛选的具体数据页（「其他场景」先展开）。
- AIME 按一个整体看，不拆日常 / 流失；流失用户只在会话场的版本标题旁标数。

**2. 评测体系说明页**：评测体系（含聚类口径）与证据闭环两张卡片。

- 评测体系：输入 → 压缩 → 归因 → 聚类四段链路的真实总量。
- 证据闭环：跟随顶部问财 / AIME 切换；每次展示 1 个 golden case 的消息、问题与证据连线，
  打开页面即可看到，不依赖点击展开；上一条 / 下一条切换 case，卡片高度固定、内容内部滚动。
  不在卡片里筛选或承载全部样本，完整对话、归因与紧凑轨迹仍在具体样本页。
- 聚类体系：左侧按阶段分组、统一网格排布环节卡片并给出环节定义；右侧聚类方法列出全部机制及说明，左右两端对齐。
- 归因流水线本身仍是事件驱动：字段员、组件调查员、逐轮摘要员、跨轮复核员由程序路由器调度；
  草稿闸门逐条校验原文坐标（逐字连续、≤400 字）与剩余影响（终稿是否采用）：
  有确认剩余影响的进入 P0–P3，已恢复的记 P4，说不清的不生成问题；压缩接受后写
  `compact.jsonl`，会话接受后追加 `attribution.jsonl`。

**3. 具体样本页**：两栏工作台，左栏召回，右栏在同一张卡里读轨迹、评测输入与评测输出；样本页铺满视口，
左栏固定 300px，右栏用剩余宽度。

- 左栏（召回）：按 `session_id + 模型` 聚合，一个会话只占一行；同一会话的多条 trace 评测显示为轮次。
  Trace / Session / 问题关键词搜索；严重度、模型、日常 / 流失与「阶段 → 机制 → 模式」多级筛选，支持排序；
  当前条件逐项清除；列表显示问题、模型/日期、轮次数、最严重等级、问题数与环节；↑↓ / Enter 选择。
  全量会话索引按每页 50 条分页，页码固定在左栏底部，筛选或换产品回到第 1 页。
- 右栏顶部：问题、chip、ID、头部轮次、归因总结；下面是轨迹概览：`cmap` 全宽一行，`sp-box` 另起一行。
  泳道图铺满；只有头部一组紧凑「第 N 轮」按钮，归因 / 轨迹内部不再重复轮次。
- 右栏下方三列：最左「轨迹」（会话概览 + 紧凑步骤列表）、中间「对话」、右侧「归因」。
  归因 / 轨迹同时可见，不再用输出 tab 切换；三列不再有 tgroup 小标题，归因总结统一放顶部；证据连线从对话消息画到归因卡片。
- 对话：用户消息和最终回答默认展开，其余消息默认只显示消息头（类型、名称、耗时、证据点、展开/收起）；
  工具调用、返回、思考等点开后可看参数、结构化内容与时间线。最终回答优先 Markdown，并与消息正文左边界对齐、撑满对话列。
- 评测输出：归因总结放在样本顶部；归因列只展示逐轮问题与证据（证据默认折叠）；问题卡片更紧凑，
  meta 两行展示角色/组件与完整聚类 path（不省略，按需换行），证据按钮在 details 里按需展开。紧凑轨迹列展示会话概览、规划、执行、工具错误、反思与关键数据。
- 右栏三列共用一次滚动；归因视图在问题卡片与命中消息之间画证据连线，悬停问题聚焦相关消息与连线。
- User / Session / Trace ID 不在页面展示，只提供复制按钮；样本 URL 使用短 slug。
- 归因/体系页通过 `?view=samples&product=…&case=…` 深链进入，加 `&trace=<trace_id>`
  可定位到会话里的某一轮（`trace` = 5003 `/traces` 的 trace_id）；
  搜索、严重度、模型、阶段 / 机制 / 模式与头部轮次同步到 URL。问财暂无样本时保持问财选中并给出 AIME 入口，
  不再自动改写 `product` 路由。
- 详情按样本懒加载：当前产品的 `samples-<product>.json` 只含召回索引与筛选面，
  选中后由 `/samples/<slug>.json` 按需生成/读取；首屏不再携带全部 trace，构建也不再预写全部详情。

| 文件 | 作用 |
|---|---|
| `build.py` | 增量扫描 `datasets/`：输入、归因、compact 按 `对应关系.csv` 或 session key 配对 → `static/data.json` + `data-<product>.json`、`static/samples.json` + `samples-<product>.json`（均带 `.gz`）；`cache/build.sqlite3` 保存文件索引、配对与样本摘要；`--jobs` 控制样本构建/输入扫描并发；`--keep-on-empty` 在数据源为空时保留上一份 |
| `stats_worker.py` | 独立进程，每 10 分钟刷新 `<datasets>/stats.json` 输入统计旁路 |
| `detail_builder.py` | 样本页首次请求时按 SQLite 行号生成 `samples/<slug>.json(.gz)` |
| `server.py` | `ThreadingHTTPServer` + 定时执行 `build.py --keep-on-empty`；`/samples/<slug>.json` 按需生成详情；`/healthz` 返回最近一次构建摘要 |
| `static/` | 三页入口、ES modules、`app.css`；无第三方运行时依赖 |
| `static/js/` | `app.js` 路由/主题/数据加载，`data.js` 数据页，`sunburst.js` 可下钻旭日图，`system.js` 评测体系页，`samples.js` 样本页（含 compact 流程图），`core.js` 共享格式化/提示/数字动效 |
| `precompress.sh` | 部署时预压缩 JS/CSS/HTML |

AIME 相关路径相对弗吉尼亚数据根 `/mnt/fin_bench/aime_rsi_data`，问财相关路径相对乌兰数据根
`/mnt/fin_bench/code_and_clean_data/datasets`。

AIME 日常输出以 `1_aime/eval_output/0_daily_eval/<model>/<model>_attribution-<date>.jsonl` 与
`compact/<model>_compact-<date>.jsonl` 为准；流失用户输出在
`1_aime/eval_output/1_lost_user_eval/`，其评测输入暂时读取归档
`1_aime/.archive/1_lost_user_input/<model>/<model>-<date>_input.jsonl`（该目录正在持续补评测，
看板每轮构建会重新配对）。问财输出与输入都在 `0_wencai/eval_output/0_daily_eval/` 与
`0_wencai/eval_input/<model>/<date>.jsonl`。
`cluster_tree` 仍按现有 `eval_output/**/cluster/` 快照读取，没有聚类的样本在聚类卡片中计为未聚类。

口径：输入 = 数据集中的 `*_input.jsonl`，以及 AIME / 问财新布局的 `<date>.jsonl`；输入侧同时统计 records / traces / tool_calls / tokens、按 `meta.task` / `meta.subtask` 的分布，以及流失轨迹（AIME `1_lost_user_input` 目录、问财 `meta.lost_user`）。已评测 = 输出侧回答记录数（问财四个版本 answer 合计，
不含 comparison / compact 汇总记录；AIME 统计 `*_attribution-YYYY-MM-DD.jsonl`）；待评测 = 输入 − 已评测。
问财 / AIME 都按 `meta.task` 展示任务分布：问财不展示「其他/其它」，AIME 把「其它」并进「其他」。
样本 = demo_data 的 attribution + compact 按 session_id 配对；输入按 trace_id/session_id 回接，不补造缺失内容。
同一 `session_id + request_time` 有多个输入快照时，选覆盖归因各轮 `trace_id` 的那份（不再按文件顺序取第一条），否则后续轮次的 evidence 会没有 transcript、只能显示「未定位」。
当前真实快照：输入覆盖至 2026-10-31；AIME 日常归因（demo_data）覆盖至 2026-10-31，
问财归因回退归档（至 2026-10-23），AIME lost 回退归档（至 2026-10-14）；聚类产物生成于
2026-10-30（v2.5.0），聚类覆盖至 2026-10-23，顶栏因此标「待刷新」。
AIME demo 归因带 P0–P4（P4 为提示级）；问财暂无 demo 样本。

### 设计规则（可复现的 token）

通用原则见 [docs/design-principles.md](docs/design-principles.md)；以下是落到本项目的具体 token。

- **一卡一主视觉**：数据量和聚类用下钻旭日图；评测量用按天输入 / 完成柱状图；归因用版本 → 归因环节的桑基图；预测体系用三张页签讲清题量、能力和错因。图表下钻都在页内完成；会话场格子和聚类矩阵格子直达具体数据。
- **分类色板可校验**：圆环使用固定顺序的分类色（亮/暗各一套），已通过亮度带、色度、相邻 CVD
  分离度与暗色对比度检查；小扇区用图例、直接标注与扇区间隙做二级编码，不依赖颜色单独辨识。
- **证据闭环统一**：体系页与具体数据共用同一套消息、问题与连线；悬停问题聚焦相关消息与连线，不做静态截图。
- **层级不靠边框**：背景 / 卡片 / 内层三档微差灰阶（亮色 `#f1f3f6 → #fafbfc → #f2f4f7`，
  暗色 `#0e1217 → #151b22 → #1b232c`），卡片不再使用 1px 实线，只保留约 2%~3.5% 的明度差和极轻投影。
- **同心圆角**：卡片 18px，内层 12 / 9 / 6px 逐级递减；按钮与 chip 共用更小一级，避免“外大内大”的断层。
- **间距分组**：桌面卡片间距 12px，卡内水平 16px、纵向 10~14px，列表行距 2~4px；外部留白由页面统一控制，
  窄屏改为卡片流式堆叠（宽卡占满、分析卡两列、手机单列）。
- **暗色降字重**：亮色标题 600 / 正文 400；暗色标题与数字降到 500，正文保持 400，并开启抗锯齿，
  避免浅色字在深底上晕开。数字统一 `tabular-nums` + `ch` 锁宽，计数动画结束强制写终值，刷新时不抖动。
- **动效分性格**：hover/press 用 120ms 吸附曲线；页面与产品切换 220ms 直接到位；
  图表 620~680ms 缓出；集群下钻的数字带 360ms 回弹；卡片推拉 680ms 弹簧（FLIP + WAAPI，`linear()` 曲线）；
  星图入场螺旋展开、证据连线上低密度粒子流动，离屏/隐藏时暂停；`prefers-reduced-motion` 下全部关闭。
- **推拉与星图**：上两张、下三张各自互相推拉（宽屏 8 | 4、8 | 2 | 2），展开卡右侧是 case 星图，点星直达样本；
  收起的卡只留关键数字，点它收回。卡片内不加二级标题和说明文字。
