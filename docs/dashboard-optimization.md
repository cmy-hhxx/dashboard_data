# 数据看板优化 Goal / 迭代计划

> 建立于 2026-11-01。验收面：`http://dashboard.example.com:2768/` 的三个视图。
> 本轮优化前端呈现与加载路径；数据口径不变，生成脚本仅增加样本空源快照保护。

## 一句话目标

**打开快、读得懂、体系清**：三个视图各自只加载需要的东西；数据页与样本页把字号、对比度和层级
拉回可读区间；评测体系页从「持续运动的装饰图」重做为一份可浏览、可跳读、可核对的归因说明。

## 成功标准

### 性能

| # | 标准 | 验收方式 |
|---|---|---|
| P1 | 评测体系页首访不再加载 ECharts / board.js / samples.js / data.json | 网络面板 / Resource Timing |
| P2 | 样本页首访不再加载 ECharts / board.js | 同上 |
| P3 | 体系页首访传输量相对基线下降 ≥ 80%（gzip） | 基线 431 KB → 目标 < 90 KB |
| P4 | 数据页图表只初始化当前产品；切换产品时再初始化另一个 | 运行时 chart 实例计数 |
| P5 | `data.json` / `samples.json` 重复访问走 304，不重复下载 | `curl -I` + 浏览器二次加载 |
| P6 | 非数据页首屏内容 < 1 s（冷缓存）；`readyAt` 含 700 ms 仪器稳定延迟，仅作同口径趋势参考 | Puppeteer FCP / `readyAt` |

### 可读性

| # | 标准 | 验收方式 |
|---|---|---|
| R1 | 正文 ≥ 13px，辅助文字 ≥ 11px；不再出现 9.5/10px 说明文字 | 计算样式审计 |
| R2 | 亮/暗主题正文对比度 ≥ 4.5:1，辅助文字 ≥ 3:1 | 抽样对比度脚本 |
| R3 | 1440 / 1280 / 390 三档无横向溢出、无异常留白 | 三档截图 |
| R4 | 图例、轴标签、卡片元信息不截断关键信息 | 截图人工复核 |

### 评测体系页

| # | 标准 |
|---|---|
| S1 | 首屏能回答：有哪些阶段、谁在做（模型/程序）、问题如何被闸门放行 |
| S2 | 含 P0–P4 严重度定义、5 种异常处置去向、两份产物与续跑规则 |
| S3 | 内容与 `eval_agent_harness/docs/attribution.md`、`problem-output.md` 一致 |
| S4 | 动效由用户触发、播完即停；`prefers-reduced-motion` / `?still=1` 直接静态终态 |
| S5 | 键盘可完成全部阶段切换，焦点可见，aria 完整 |

### 工程

- 无 console error；`node --check` 全部 JS；`python3 -m py_compile` 全部 Python。
- 部署后三视图与 `/healthz` 正常，预压缩 `.gz` 仍生效。
- 只改与本目标相关的文件；删除因本轮改动而失效的 CSS/导入。

## 非目标

- 不改 `scan_datasets.py` / `prepare.py` / `prepare_samples.py` 的数据口径。
- 不重做样本页的信息架构（三栏工作台保留），只做可读性与按需加载。
- 不引入前端框架、打包器或新的运行时依赖。
- 不为了「看起来忙」保留持续粒子/呼吸动画。

## 技术选型决策

现有工程是 **原生 ES modules + ECharts + 手写 CSS + Python 标准库静态服务**，没有 React、
没有 bundler，也没有运行时 npm 依赖。shadcn/ui、Radix、Zustand、TanStack Query、Recharts
等推荐栈会把一个三视图静态看板改造成 React 应用，重复引入图表库、增加构建链与首屏体积，
与本轮「最少必要代码和依赖」的目标相反。

因此本轮：

- **复用**现有 `core.js` token / 图表生命周期 / 数字动效与 ECharts，不引入第二个图表库。
- **借鉴** Radix/shadcn 的可访问性模式（tablist、tabpanel、focus-visible、reduced-motion），
  用原生 DOM + CSS 实现，不引入运行时。
- **沿用** Tailwind 生成的 `app.css` 作为基础层；页面级 CSS 继续手写，避免为几个视图
  重建组件库。
- 图标使用内联 SVG（Lucide 风格线性图标），不为少量图标引入 icon 包。
- 动效用 CSS transition/keyframes，时长与 `taste.css` 既有 token 一致；只有用户触发时运行。

## 基线（2026-11-01 02:30，live，gzip，1440×1000）

| 视图 | 传输 | JS | CSS | JSON | 请求数 | FCP | ready |
|---|---:|---:|---:|---:|---:|---:|---:|
| 数据 | 431 KB | 379 KB | 34 KB | 18 KB | 14 | 388 ms | 1.89 s |
| 评测体系 | 431 KB | 379 KB | 34 KB | 18 KB | 14 | 384 ms | 1.84 s |
| 样本 | 552 KB | 379 KB | 34 KB | 138 KB | 16 | 420 ms | 1.88 s |

> 三个视图加载同一套 ECharts（333 KB gzip）、board.js、samples.js、system.js 与 data.json，
> 体系页/样本页不用图表却付了全价。体系页当前首屏是一张持续动画的调度台，10px 辅助文字
> 与大面积空白并存，是「太乱」的主要来源。

## 最终指标（2026-11-01 03:08，本地冷缓存，gzip + 304，1440×1000）

每次视图测量使用全新浏览器实例（空 HTTP 缓存），样本页包含首条样本详情的 gzip 传输。

| 视图 | 传输 | 相对基线 | FCP | 视图就绪 | ready（仪器口径） | 请求数 |
|---|---:|---:|---:|---:|---:|---:|
| 数据 | 401 KB | -7% | 52 ms | 121 ms | 1.54 s | 11 |
| 评测体系 | 41 KB | -90% | 56 ms | 35 ms | 1.45 s | 8 |
| 样本 | 166 KB | -70% | 40 ms | 90 ms | 1.54 s | 10 |

- 体系页 P3 目标为 < 90 KB，实际 41 KB（较 431 KB 下降 90%）。
- 数据页 401 KB 中 ECharts 占 334 KB；其余 JS/CSS/JSON 合计约 67 KB。
- 样本页 166 KB 中索引 112 KB、首条详情 7.5 KB、脚本与样式约 46 KB。
- 「视图就绪」为 `__viewReady`：遮罩隐藏、内容已渲染的时刻；三视图均 < 150 ms，满足 P6。
- `ready` 与基线使用同一 `__boardReady` 口径，包含应用内 700 ms 稳定等待与测试脚本 700 ms 等待，
  只用于同口径趋势对比，不代表用户等待时间。

## Live 验收（2026-11-01 07:50，Round 13 部署后，`http://dashboard.example.com:2768/`）

| 视图 | 传输 | 请求数 | FCP | 视图就绪 | 错误 / 404 |
|---|---:|---:|---:|---:|---:|
| 数据 | 402 KB | 11 | 324 ms | 1.19 s | 0 |
| 评测体系 | 43 KB | 8 | 316 ms | 0.53 s | 0 |
| 样本 | 169 KB | 10 | 316 ms | 0.87 s | 0 |

- 体系页 7 个阶段、数据页当前产品图表、样本页 291 条 AIME 样本均正常渲染；无 console error、无 4xx。
- `data.json` 二次加载传输 300 B（304 重验证）；`samples.json` 为 112 KB gzip。
- Live 的「视图就绪」包含公网 RTT；非数据页均 < 1 s。
- Round 13 的异步视图切换、错误重试、文档标题、aria 播报、跳过导航与 sticky 目录均在 live 验证通过。
- 部署窗口内远端 `demo_data` 被外部评测运行清空，已恢复 02:18 的 291 条样本快照，并为生成器
  增加「源为空不覆盖旧快照」保护，详见执行记录；本次部署日志再次出现
  `skipped: source produced no samples; keeping previous snapshot`，291 条样本保持不变。

## 验收结果（2026-11-01 07:50）

| 项 | 结果 |
|---|---|
| P1–P2 按视图加载 | ✅ 体系 8 请求、样本 10 请求，均不含 ECharts / board.js / data.json |
| P3 体系页传输 | ✅ 41 KB（目标 < 90 KB，较基线 -90%） |
| P4 数据页按产品渲染 | ✅ 只初始化当前产品，切到另一产品时补渲染 |
| P5 缓存重验证 | ✅ `data.json` 二次 300 B、`samples.json` 条件请求 304 |
| P6 非数据页首屏 | ✅ live 视图就绪 0.63 s / 0.87 s，FCP 336 / 276 ms |
| R1–R4 可读性 | ✅ 亮暗主题 0 处 < 11 px 正文、0 处低对比、0 处横向溢出；环图图例不截断 |
| S1–S5 体系页 | ✅ 7 阶段、四代理、闸门、5 种处置、P0–P4、产物与契约；键盘与 reduced-motion 通过 |
| U1 加载状态 | ✅ 懒加载视图切换显示 pending 与 `aria-busy`，不再出现空白页 |
| U2 错误状态 | ✅ 模块或 JSON 失败显示错误卡 / 横幅，重试可恢复；不再静默失败 |
| U3 无障碍 | ✅ 每视图文档标题、`aria-live` 播报、跳转主内容链接；体系目录滚动高亮 |
| 工程与部署 | ✅ JS/Python/CSS 检查通过；18 组回归 0 异常；live 三视图 0 error / 0 4xx |

## 迭代记录（13 轮 + 加时）

| 轮次 | 主题 | 主要改动 | 验证 | 状态 |
|---|---|---|---|---|
| 0 | 基线 | live 数据回放、三视图截图、性能采样、体系资料研读 | 本文基线表 | ✅ |
| 1 | 体系页内容架构 | 重写 `system.js`：流程、四代理分工、闸门、严重度、产物、边界、契约；静态可读优先 | 内容对照 source docs | ✅ |
| 2 | 体系页视觉系统 | 重写 `system.css`：字号阶梯、间距、微对比层级、暗色、三档响应式；删除旧装饰 CSS | 三档亮/暗截图 | ✅ |
| 3 | 体系页交互与无障碍 | 阶段选择 + 单次播放、键盘、aria、`still`/reduced-motion 静态终态 | 键盘走查 + 截图 | ✅ |
| 4 | 按视图拆分加载 | `app.js` 动态 import；ECharts 仅数据页加载；路由感知 CSS；data.json 延迟 | P1–P3, P6 | ✅ |
| 5 | 数据页渲染性能 | 只渲染当前产品；切换时补渲染；合并重复 resize；隐藏页面停止动画 | chart 计数 + readyAt | ✅ |
| 6 | 缓存与网络 | `data.json`/`samples.json` 改为可重验证缓存；去掉 `?t=`；304 验证 | P5 | ✅ |
| 7 | 数据页可读性 | 11px 说明文字下限、对比度、图例、列对齐、预测图边距、空卡留白 | R1–R4 + 截图 | ✅ |
| 8 | 样本页可读性 | 列表/正文/元信息字号与行高；筛选与 tab 层级；暗色对比 | R1–R4 + 截图 | ✅ |
| 9 | Shell 与全局一致性 | 顶栏、切换器、焦点、移动端；圆角/间距/字重 token 审计；死 CSS 清理 | 三档截图 + grep | ✅ |
| 10 | 回归、部署、文档 | 全视图回归、部署到远端、`/healthz`、README 与设计规则同步、最终报告 | 验收清单 | ✅ |
| 11 | 加时：自动审计 | 对比度/横向溢出/字号/焦点顺序脚本化，修复发现项 | 审计脚本 | ✅ |
| 12 | 加时：图表剖析 | ECharts 初始化耗时、图例截断、按需渲染再压榨 | Performance 面板 | ✅ |
| 13 | 加时：状态与无障碍 | 视图切换 pending；懒加载错误卡 / 横幅与重试；文档标题、aria-live/aria-busy、跳到主内容；体系目录 sticky + 滚动高亮；处置标签对比修复 | live UX 脚本 + 审计 | ✅ |

## 设计约束（来自 `docs/design-principles.md`）

1. **不用生硬边框**：背景 / 卡片 / 内层用 1%~3% 微差灰阶；必要时才用 hairline。
2. **暗色降字重**：暗色标题/数字降一档，正文保持 400，避免光晕。
3. **等宽数字 + 自适应网格**：计数不抖动；卡片尺寸变化但圆角/间距/色彩规则不变。
4. **动效分性格**：hover 120ms 吸附；页面切换 220ms；图表 620~680ms 缓出；持续运动只用于
   「正在发生」的状态，且播完即停。
5. **同心圆角 / 间距分组**：卡片 18px，内层 12/9/6px；外部间距 ≥ 内部间距。

## 执行记录

- 2026-11-01 02:30 完成基线：live 三视图截图与性能采样；确认 ECharts/board/samples/system
  被三个视图共同加载；确认体系页在 1440×1000 下 10px 文字、暗色低对比、大面积空白。
- 2026-11-01 02:35 阅读 `eval_agent_harness/docs/attribution.md`、
  `docs/schema-fields.md`、`packages/prompts/resources/attribution/problem-output.md`、
  `evaluation-report/attribution-reliability.md`，确定体系页事实口径。
- 2026-11-01 02:40–02:55 重写体系页内容与视觉：7 阶段 tablist、四代理、闸门检查、5 种处置、
  P0–P4、两份产物与续跑规则；删除旧的持续动画调度台和失效的 `.sys-*` 覆盖。
- 2026-11-01 02:55 按视图拆分加载：`system` 仅 8 个请求，`samples` 不加载 ECharts/board，
  `data` 仅当前产品初始化图表；样本深链在首次渲染前选定目标，只发一次详情请求。
- 2026-11-01 03:00 可读性审计：数据/样本/体系三页在亮暗主题下 0 处小于 11px 的 HTML 文字、
  0 处低对比正文、0 处横向溢出；环图图例不再截断；样本页移动端详情无横向滚动。
- 2026-11-01 03:00 18 组回归（1440/1280/390 × 三视图 × 亮/暗）通过：无 console error，
  请求断言符合按视图加载预期，ready 0.74–0.85 s（本地，含 700 ms 稳定等待）。
- 2026-11-01 03:05 缓存验证：`data.json`/`samples.json` 首次 200 gzip，二次 304；
  新增 gzip ISIZE 校验，源 JSON 与 `.gz` 大小不一致时回退原始文件，避免旧样本索引造成 404。
- 2026-11-01 03:08 冷缓存性能复测：体系 41 KB / FCP 56 ms / 视图就绪 35 ms；
  数据 401 KB / 52 ms / 121 ms；样本 166 KB / 40 ms / 90 ms。三次测量均 0 console error。
- 2026-11-01 03:08 静态检查：6 个 JS 模块语法通过，5 个 Python 文件编译通过，6 个 CSS 文件括号平衡。
- 2026-11-01 03:10 首次部署：远端备份 `/opt/eval_dashboard_backup_20261101_0310.tar.gz`
  （1.1 MB，sha256 `4b388884…4603`）；`data.json` 200 gzip + `no-cache`，`/healthz` 200，
  三视图静态入口可访问；样本数据问题见下一条。
- 2026-11-01 03:11 发现远端 `1_aime/eval_output/demo_data` 被外部评测运行（`.runs/…-r513-20261101`）
  清空，`prepare_samples.py` 生成 0 条并 prune 掉详情。用部署前备份与本地 02:18 快照恢复
  291 条样本、582 个详情文件（`.json` + `.json.gz`）。
- 2026-11-01 03:13 为 `prepare_samples.py` 增加保护：源文件为 0 时保留上一份快照并跳过 prune；
  第二次部署验证日志输出 `skipped: source produced no samples; keeping previous snapshot`，
  样本页仍为 291 条。
- 2026-11-01 03:14 live 冷缓存验收：体系 41 KB / 8 请求 / 7 阶段；数据 400 KB / 11 请求；
  样本 167 KB / 10 请求 / 291 条；三页 0 console error、0 4xx；`data.json` 二次加载 300 B。
- 2026-11-01 03:14 远端 `/healthz` 在重启后的首轮 scan 完成前会短暂返回 0 时间戳（`ok: true`），
  首轮扫描完成后恢复（部署后扫描仍在运行）；不影响页面与数据接口。
- 2026-11-01 07:40–07:46 Round 13：视图切换时显示 pending 与 `aria-busy`；懒加载失败时
  体系/样本显示错误卡、数据页显示底部横幅，均可重试；每个视图写入文档标题，增加
  `aria-live` 播报与「跳到主要内容」链接；体系页目录改为 sticky 并随滚动高亮；修复暗色
  处置标签对比度。
- 2026-11-01 07:47 本地 UX 脚本通过：三视图标题与播报正确，pending / error / retry 全链路
  可达；skip link 将焦点移到 `#mainContent`；success path 0 console error。三视图审计为
  体系 0 项；数据页 8 个 SVG 弧标（2.9 用户单位、视觉 12px）与样本页 1 个 tool 摘要省略号
  均为已知且不截断关键信息。
- 2026-11-01 07:49 部署 Round 13：部署前备份 `/opt/eval_dashboard_backup_20261031_2349.tar.gz`
  （7.9 MB，sha256 `35a46aa5…4913`）；`deploy.sh` 成功，`samples.log` 输出
  `skipped: source produced no samples; keeping previous snapshot`，291 条样本与 582 个详情保留。
- 2026-11-01 07:50 live 复测：体系 43 KB / 8 请求 / view-ready 0.53 s；数据 402 KB / 11 请求 /
  view-ready 1.19 s；样本 169 KB / 10 请求 / view-ready 0.87 s；三页 0 console error、0 4xx；
  `data.json` 二次 300 B（304）；`samples.json` 200 gzip 112 KB；样本页 291 条。
- 2026-11-01 07:51 live UX 脚本通过：pending 状态、标题与播报、skip link、体系目录
  sticky/滚动高亮、模块拦截错误卡与重试、数据 JSON 失败横幅与重试全部通过。
- 2026-11-01 07:52 静态检查：`node --check` 4 个改动 JS、`python3 -m py_compile` 2 个改动
  Python、`git diff --check` 均通过。
- 2026-11-01 07:52 `/healthz` 首轮 scan 完成并恢复：`ok=true`，`last_refresh` 对应
  07:52:07，`refresh_seconds=147.7`；`samples_ok=true`，样本仍使用 02:18 快照。
- 2026-11-01 07:54 首轮数据刷新后复测：三页仍 0 console error、0 4xx、无横向溢出；
  `data.json` 二次加载仍为 300 B；样本页 291 条。
