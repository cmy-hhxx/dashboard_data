# eval_data_server

AIME 评测数据在远端服务器上的**搬运、打包与看板**工程。

仓库只提交流程、脚本和看板代码；真实数据由本地 `datasets/` 或部署主机的挂载目录与
`ceph-fuse` 接入，不提交到 Git。

## 目录

```
servers.conf                    # 本地部署配置（已 gitignore，不入库）
scripts/pack_aime_input.sh      # 把 AIME 评测输入流式打成单个 tar.zst
docs/aime-input-packaging.md    # 打包流程与参数说明
docs/aime-data-inventory.md     # 2026-10-30 那份数据的解压体量与目录拆解
docs/design-principles.md       # 界面设计原则：层级、字重、数字与动效
docs/dashboard-deployment.md    # 看板部署、端口、启动与运维手册
```

## 快速开始

```bash
scp scripts/pack_aime_input.sh eval_data:/tmp/
# 打包范围由调用方显式给出（不传则默认两棵目录树，仅作省事用）
ssh eval_data 'chmod +x /tmp/pack_aime_input.sh && /tmp/pack_aime_input.sh <目录…>'
```

产物落在 `/mnt/fin_bench/aime_data/aime_input_<日期>.tar.zst`。

默认 `LEVEL=12`：10.3 GB 输入约 **47 秒 / 620 MB（16.6×）**。要更小用 `LEVEL=15`
（129 秒 / 597 MB），极致压缩用 `LEVEL=19`（392 秒 / 539 MB / 19.06×）。
依据见 [docs/aime-input-packaging.md](docs/aime-input-packaging.md)。

## 数据现状

| 数据 | 位置（远端） | 规模 |
|---|---|---|
| AIME 评测输入 | `…/1_aime/2_eval_input/` | 287 文件 / 9.92 GiB / 10,648,360,770 B |
| 归档产物 | `/mnt/fin_bench/aime_data/` | `2_eval_input_20261030.tar.zst` 675 MB（6.34% / 15.8×） |

包内结构与源目录一致（顶层 `2_eval_input/`，下面是 `0_daily_eval_input/`、
`1_lost_user_eval/{.archive,aime_expert,aime_fast}`）。解压后体量、目录结构、逐日期记录数见
[docs/aime-data-inventory.md](docs/aime-data-inventory.md)。

`0_daily_eval_input` 是**实时目录**，流水线在持续写入；打包按快照语义处理，详见流程文档 §5。

## 数据看板

`dashboard/` 是问财 / AIME 评测看板：原生 ES modules + ECharts + Python 标准库起服务。
本地读取仓库根目录的 `datasets/`，生产读取 `/mnt/fin_bench/code_and_clean_data/datasets`；
可通过 `EVAL_DATASETS` 显式指定数据根目录（评测输入、输出、cluster_tree、item_index）。
没有数据时显示待接入空态。将数据放入 `datasets/` 后运行 `./dashboard/local_dev/refresh.sh` 重建；
本地启动方式见 [本地调试说明](dashboard/local_dev/README.md)。
入口分三块，顶部导航切换，query 路由可直接分享：

| 页面 | 路由 | 内容 |
|---|---|---|
| 数据 | `?view=data` | 问财 / AIME 的 2+3 Bento：数据量、评测量、归因、聚类、预测 |
| 评测体系 | `?view=system` | 归因调度台：一个程序路由器 + 四个专业代理，事件驱动、草稿闸门与两份 JSONL 产物 |
| 样本 | `?view=samples` | 归因 / 紧凑轨迹双视图的三栏样本工作台：召回 → 评测输入 → 评测输出 |

```bash
./dashboard/deploy.sh                                    # 同步、生成 data.json/samples.json、重启
ssh eval_data 'cd /opt/eval_dashboard && ./start.sh'     # 手动起服务
```

服务监听容器 `:5001`，对外地址由部署环境决定。服务每 30 分钟重扫数据集；
样本默认每 6 小时重算（`SAMPLES_REFRESH_SECONDS`），`samples.json` 或 `samples/` 缺失时启动即生成。
部署时预压缩 JS/CSS/HTML/SVG，`data.json`、`samples.json` 与逐样本详情由生成脚本同时产出 `.gz`；
这些 JSON 使用 `no-cache`，重复访问以 304 重验证，仅 `/healthz` 为 `no-store`。
端口映射、部署流程、验证方式和部署最佳实践见
[docs/dashboard-deployment.md](docs/dashboard-deployment.md)。

### 三个板块

**1. 数据板块**：每产品 2+3 Bento，上排数据量 / 评测量，下排归因 / 聚类 / 预测。
问财与 AIME 共用 `dataCardsTemplate` 五卡模板和渲染组件，仅在适配层转换各自的数据。

- 数据量与聚类：完整复用 `hierarchy-card.js`，由 `ring.js` 的 ECharts 内置旭日图绘制；圆环比例、配色、中心、图例、响应式尺寸与默认收起状态一致。
  数据量保留真实分类的全部层级（通常 2～3 级）；聚类按真实树深继续下钻。两者点击内圈展开子类，点击有下级的外圈节点进入下一层，到叶子停止。
  返回图标先收起展开，再返回上一层；图例与圆环同色并联动高亮。两者都不跳转样本页，顶部“样本”导航正常保留。
- 评测量：共用整体进度、版本回答量与核心达成率、难度构成和底部统计；未提供的核心达成率显示“—”，两产品保持同一布局。
- 归因体系：共用两列桑基图 `版本/模型 → 环节`，统一节点、连线、标签与长尾合并规则，不显示严重度标签或第三列；数据区交互不跳转到样本页。
- 预测体系：三个维度为 `预测数据分布 / 准确率 / 预测归因`。按数据快照时间和每题答案公布时间计算可解题量与类别构成，不展示日历或日期选择控件；准确率使用真实时间轴，模型和数值显示在图中，不再添加底部题注。题库、准确率或归因未接入时显示对应空态，缺失指标显示“—”。数据协议见 [预测卡片数据接口](docs/prediction-data.md)。

**2. 评测体系说明页**：归因调度台，一个程序路由器 + 四个专业代理，事件驱动。

- 事件源 → 程序路由器 → 四个代理：字段员、组件调查员、逐轮摘要员、跨轮复核员；
  路由器只在输入就绪或结果被接受时转发，不轮询。
- 草稿闸门逐条校验原文坐标（逐字连续、≤400 字）、异常处置（5 选 1）与剩余影响（终稿是否采用）：
  有确认剩余影响的进入 P0–P3，已恢复的记 P4，说不清的不生成问题。
- 压缩接受后立即写 `compact.jsonl`，会话接受后追加 `attribution.jsonl`；只追加、可续跑。
- 动画按输入 → 压缩 → 组件 → 逐轮 → 跨轮 → 闸门 → 落盘推进，支持播放 / 暂停与点击代理查看阶段；
  系统减少动态时直接给出完整静态终态。

**3. 具体样本页**：三栏工作台，重点是评测输入与评测输出。

- 左栏（召回）：Trace / Session / 问题关键词搜索；模型、严重度、环节、日期筛选与排序；
  当前条件逐项清除；列表显示问题、模型/日期、最严重等级、问题数与环节；↑↓ / Enter 选择。
- 中栏（评测输入）：原问与中文翻译、任务/难度/用量；多轮可切换；按 System / User / Reason /
  Tool / Return / Answer 图标展开时间线；系统提示、思考、调用参数、结构化返回默认折叠，
  最终回答超长折叠；缺失输入显式提示。
- 右栏（评测输出）：归因 / 紧凑轨迹两个视图。归因展示会话结论、严重度构成、逐轮问题与证据；
  紧凑轨迹展示会话概览、规划、执行、工具错误、反思与组件。两者共同组成一个样本的评测输出。
- User / Session / Trace ID 不在页面展示，只提供复制按钮；样本 URL 使用短 slug。
- 归因/体系页通过 `?view=samples&product=…&component=…&severity=…&case=…` 深链进入；
  搜索、筛选、轮次与输出 tab 同步到 URL。问财暂无样本时保持问财选中并给出 AIME 入口，
  不再自动改写 `product` 路由。
- 详情按样本懒加载：`samples.json` 只含召回索引与筛选面，选中后取
  `samples/<slug>.json(.gz)`；首屏不再携带全部 trace。

| 文件 | 作用 |
|---|---|
| `scan_datasets.py` | 扫 `datasets` 的输入/输出：逐文件条数、按模型×日期配对、meta 分类分布 → `cache/datasets.json` |
| `prepare.py` | 解析归因/覆盖/Token/逐日指标/桑基分量，合并扫描结果 → `static/data.json` |
| `prepare_samples.py` | demo_data 的 attribution + compact 按 session_id 配对 → `static/samples.json(.gz)`；逐样本详情 → `static/samples/<slug>.json(.gz)` |
| `dataset_layout.py` | 解析 datasets 布局：demo_data → legacy → `.archive` 逐级回退，供三个生成脚本共用 |
| `server.py` | `ThreadingHTTPServer` + 定时重算；`/healthz` 返回 data/samples 双刷新状态 |
| `static/` | 三页入口、ES modules、ECharts 离线包、构建好的 `app.css` 与页面 CSS |
| `static/js/` | `app.js` 路由/主题/数据加载，`board.js` 数据板块，`hierarchy-card.js` 数据量与聚类共用的完整圆环组件，`hierarchy-data.js` 分类适配/层级状态，`ring.js` ECharts 旭日图，`system.js` 归因调度页，`samples.js` 样本页，`core.js` 共享 token/图表/数字动效 |
| `precompress.sh` | 部署时预压缩 JS/CSS/HTML；`prepare.py`/`prepare_samples.py` 另产 `.gz` |
| `build/` | Tailwind/DaisyUI 配置与构建入口（`npx tailwindcss -c tailwind.config.js -i input.css -o ../static/app.css --minify`） |

AIME 输出以 `1_aime/eval_output/demo_data/<model>/<model>_attribution-<date>.jsonl` 与
`compact/<model>_compact-<date>.jsonl` 为准（demo 格式，后续沿用）；
旧 `eval_output/<split>/...` 与 `.archive/` 只作回退。问财暂无 demo_data 样本。
问财输出当前回退到 `0_wencai/.archive/0_daily_eval_output`（旧
`.archive/eval_output/0_daily_eval_output` 仍兼容），输入为
`0_wencai/eval_input/<model>/<date>.jsonl`。
`demo_data` 目前没有 `cluster_tree`；数据板块聚类沿用最近的归档聚类快照，样本页不再依赖聚类树。

口径：输入 = 数据集中的 `*_input.jsonl`，以及 AIME / 问财新布局的 `<date>.jsonl`；已评测 = 输出侧回答记录数（问财四个版本 answer 合计，
不含 comparison / compact 汇总记录；AIME 统计 `*_attribution-YYYY-MM-DD.jsonl`）；待评测 = 输入 − 已评测。
问财 / AIME 都按 `meta.task` 展示任务分布：问财不展示「其他/其它」，AIME 把「其它」并进「其他」。
样本 = demo_data 的 attribution + compact 按 session_id 配对；输入按 trace_id/session_id 回接，不补造缺失内容。
当前真实快照：输入覆盖至 2026-10-31；AIME 日常归因（demo_data）覆盖至 2026-10-31，
问财归因回退归档（至 2026-10-23），AIME lost 回退归档（至 2026-10-14）；聚类产物生成于
2026-10-30（v2.5.0），聚类覆盖至 2026-10-23，顶栏因此标「待刷新」。
AIME demo 归因带 P0–P4（P4 为提示级）；问财暂无 demo 样本。

### 设计规则（可复现的 token）

通用原则见 [docs/design-principles.md](docs/design-principles.md)；以下是落到本项目的具体 token。

- **一卡一主视觉**：数据量与聚类统一复用 ECharts 旭日图组件，主分类在内圈、选中分支的子类在外圈；评测量用覆盖率环、版本核心达成率和难度构成环；归因用桑基图；预测展示时间截面、分类累计分布与准确率曲线。
- **分类色板可校验**：圆环使用固定顺序的分类色（亮/暗各一套），已通过亮度带、色度、相邻 CVD
  分离度与暗色对比度检查；小扇区用图例、直接标注与扇区间隙做二级编码，不依赖颜色单独辨识。
- **体系页用「活图」**：节点逐段点亮、流上粒子运动、播放/暂停/单步；不是静态截图。
- **层级不靠边框**：背景 / 卡片 / 内层三档微差灰阶（亮色 `#f1f3f6 → #fafbfc → #f2f4f7`，
  暗色 `#0e1217 → #151b22 → #1b232c`），卡片不再使用 1px 实线，只保留约 2%~3.5% 的明度差和极轻投影。
- **同心圆角**：卡片 18px，内层 12 / 9 / 6px 逐级递减；按钮与 chip 共用更小一级，避免“外大内大”的断层。
- **间距分组**：桌面卡片间距 12px，卡内水平 16px、纵向 10~14px，列表行距 2~4px；外部留白由页面统一控制，
  窄屏改为卡片流式堆叠（宽卡占满、分析卡两列、手机单列）。
- **暗色降字重**：亮色标题 600 / 正文 400；暗色标题与数字降到 500，正文保持 400，并开启抗锯齿，
  避免浅色字在深底上晕开。数字统一 `tabular-nums` + `ch` 锁宽，计数动画结束强制写终值，刷新时不抖动。
- **动效分性格**：hover/press 用 120ms 吸附曲线；页面与产品切换 220ms 直接到位；
  图表 620~680ms 缓出；集群下钻的数字带 360ms 回弹；`prefers-reduced-motion` 下全部关闭。
