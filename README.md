# eval_data_server

AIME 评测数据在远端服务器上的**搬运、打包与看板**工程。

数据不在这个仓库里——仓库只放流程、脚本和看板代码；数据始终留在远端 `eval_data`
(`dashboard.example.com:22`) 与 `ceph-fuse` 挂载上。

## 目录

```
servers.conf                    # 服务器清单（ssh 别名、端口、密钥路径）
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
**唯一数据源**是 `/mnt/fin_bench/code_and_clean_data/datasets`（评测输入、输出、cluster_tree、item_index）。
入口分三块，顶部导航切换，query 路由可直接分享：

| 页面 | 路由 | 内容 |
|---|---|---|
| 数据 | `?view=data` | 问财 / AIME 的 2+3 Bento：数据量、评测量、归因、聚类、预测 |
| 评测体系 | `?view=system` | 基于 `eval_agent_harness` 与 `cluster_algorithm` 的动画化结构说明 |
| 样本 | `?view=samples` | 按归因 / 聚类召回真实样本；输入卡 + 输出信息卡 + 归因卡 |

```bash
./dashboard/deploy.sh                                    # 同步、生成 data.json/samples.json、重启
ssh eval_data 'cd /opt/eval_dashboard && ./start.sh'     # 手动起服务
```

服务监听容器 `:5001`，对外是 `http://dashboard.example.com:2768/`。服务每 30 分钟重扫数据集；
`samples.json` 默认每 6 小时重算（`SAMPLES_REFRESH_SECONDS`），缺失时启动即生成。
部署时预压缩 JS/CSS/HTML，`data.json`/`samples.json` 不缓存。
端口映射、部署流程、验证方式和部署最佳实践见
[docs/dashboard-deployment.md](docs/dashboard-deployment.md)。

### 三个板块

**1. 数据板块**：每产品 2+3 Bento，上排数据量 / 评测量，下排归因 / 聚类 / 预测。

- 数据量：可下钻同心圆。内环任务、外环当前任务子类；点击任务切换，`← 全部` 回到总览；
  右侧图例与圆环同色。
- 评测量：版本「积木」方框图，面积/占比 = 回答数，点阵 = 核心达标率；配覆盖率环、难度四格、
  AIME fast/expert 双块 + 产出 spark + 子任务 Top 4。
- 归因体系：桑基图。问财 `版本 → 环节`，AIME `模型 → 环节 → 严重度`；节点/流可点击直接召回样本。
- 聚类体系：旭日图 + 图例下钻；簇内节点可「该簇样本 →」召回，叶子点击也可召回。
- 预测体系：同一卡片内三个维度，`数据量 / 性能 / 归因` 标签切换：
  数据量给 7 日预测 + 置信区间；性能预测覆盖率（累计口径），附 P50 / 问题密度；
  归因预测严重度或环节构成。历史不足时明确标「原型」；AIME 批量尖峰用 7 日平滑并标注。

**2. 评测体系说明页**：三幕动画，实际在动。

- 总览：输入 → Criteria / Compact → Trace 归因 → Session 归因 → JSONL；五个下游消费者；
  节点逐段点亮、流上有运动粒子，支持播放 / 暂停 / 单步。
- 归因链：原始消息 → Compact 字段 → Trace 审查 → Session 审查 → 引文回跳原始坐标；
  展示 `trace/message/path/evidence_id` 与 400 字引文约束。
- 聚类与质量：9 环节 × 7 机制矩阵、133 模式 / 124 叶子、α=0.918、91.3% 双盲一致率；
  「召回样本」直接跳到样本页。版本事实标 r486 / taxonomy v3.0.0，不冒充实时测量。

**3. 具体样本页**：三栏召回工作台。

- 左栏：全文搜索、按归因（组件 / 严重度）、按聚类（树形路径）筛选；当前条件可逐项清除。
- 中栏：样本列表；问题、模型、日期、簇、严重度、问题数；键盘 ↑↓ / Enter 选择。
- 右栏：左侧一张「评测输入」大卡（原问、meta、工具、system/reasoning/tool call/工具返回、
  最终回答，长文折叠）；右侧两张上下卡：上「评测输出 · 信息卡」（判词、指标、逐轮/会话总结），
  下「评测输出 · 归因卡」（聚类路径、全部 Problem、严重度、定义/理由/证据引文）。
- 归因桑基点击、聚类召回、体系页 CTA 都通过 `?view=samples&product=…&component=…&severity=…&cluster=…`
  深链进入；筛选和选中 case 同步到 URL，可直接分享。

| 文件 | 作用 |
|---|---|
| `scan_datasets.py` | 扫 `datasets` 的输入/输出：逐文件条数、按模型×日期配对、meta 分类分布 → `cache/datasets.json` |
| `prepare.py` | 解析归因/覆盖/Token/逐日指标/桑基分量，合并扫描结果 → `static/data.json` |
| `prepare_samples.py` | 从 cluster_tree 叶子样本 + 输出 JSONL + 输入 trace 组装真实样本 → `static/samples.json(.gz)` |
| `dataset_layout.py` | 解析 datasets 布局：demo_data → legacy → `.archive` 逐级回退，供三个生成脚本共用 |
| `server.py` | `ThreadingHTTPServer` + 定时重算；`/healthz` 返回 data/samples 双刷新状态 |
| `static/` | 三页入口、ES modules、ECharts 离线包、构建好的 `app.css` 与页面 CSS |
| `static/js/` | `app.js` 路由/主题/数据加载，`board.js` 数据板块，`system.js` 体系页，`samples.js` 样本页，`core.js` 共享 token/图表/数字动效 |
| `precompress.sh` | 部署时预压缩 JS/CSS/HTML；`prepare.py`/`prepare_samples.py` 另产 `.gz` |
| `build/` | Tailwind/DaisyUI 配置与构建入口（`npx tailwindcss -c tailwind.config.js -i input.css -o ../static/app.css --minify`） |

AIME 输出以 `1_aime/eval_output/demo_data/<model>/<model>_attribution-<date>.jsonl` 为准（demo 格式，后续沿用）；
旧 `eval_output/<split>/...` 与 `.archive/` 只作回退。问财暂无 demo_data，回退到
`0_wencai/.archive/eval_output/0_daily_eval_output`；AIME lost 与聚类树也按 demo → legacy → archive 解析。
`demo_data` 目前没有 `cluster_tree`，聚类/样本页沿用最近的归档聚类快照，freshness 会标 stale。

口径：输入 = 数据集中的 `*_input.jsonl`，以及 AIME 新布局的 `<date>.jsonl`；已评测 = 输出侧回答记录数（问财四个版本 answer 合计，
不含 comparison / compact 汇总记录；AIME 统计 `*_attribution-YYYY-MM-DD.jsonl`）；待评测 = 输入 − 已评测。
问财 / AIME 都按 `meta.task` 展示任务分布：问财不展示「其他/其它」，AIME 把「其它」并进「其他」。
样本页从 cluster 叶子/条目索引反查 `src_file:src_line`，再按 trace_id 回接输入；不补造缺失内容。
当前真实快照：输入覆盖至 2026-10-31；AIME 日常归因（demo_data）覆盖至 2026-10-31，
问财归因回退归档（至 2026-10-23），AIME lost 回退归档（至 2026-10-14）；聚类产物生成于
2026-10-30（v2.5.0），聚类覆盖至 2026-10-23，顶栏因此标「待刷新」。问财原始输出没有 severity 字段，
样本页对问财显式显示「无分级」；AIME 日更批次也无 severity，只有 lost-user 批次有 P0–P3。

### 设计规则（可复现的 token）

通用原则见 [docs/design-principles.md](docs/design-principles.md)；以下是落到本项目的具体 token。

- **一卡一主视觉**：数据量用同心圆，评测量用积木方框 + 点阵，归因用桑基图，
  聚类用旭日图，预测用折线/堆叠面积；不再统一画横向进度条。
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
