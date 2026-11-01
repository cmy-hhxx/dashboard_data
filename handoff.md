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
datasets/
  └─ build.py ──> static/data.json(.gz)
                  static/samples.json(.gz)
                  static/samples/<slug>.json(.gz)
                        │
server.py（标准库 HTTP，:5001，定时 build）──> app.js
                                                ├─ data.js    数据页
                                                ├─ system.js  评测体系页
                                                └─ samples.js 样本页
                                                   core.js / sunburst.js / app.css
```

- `build.py` 一次扫描输入、归因、compact，按 `对应关系.csv` 配对；输出版本、KPI、
  会话场、聚类矩阵、预测、体系说明和样本索引。生成物不要手改，重新构建。
- `server.py` 启动时缺数据会构建，之后默认每 30 分钟刷新；`/healthz`
  返回最近一次构建摘要。
- 前端无框架、无打包器、无外部运行时依赖；原生 ES modules + SVG + 手写 CSS。
- 生产由 `deploy.sh` 同步代码到远端，在远端构建数据、预压缩并重启；不要手改远端目录。

## 3. 页面与入口

| 路由 | 模块 | 内容 |
|---|---|---|
| `?view=data&product=wencai\|aime` | `data.js` | 会话场、数据量、评测量、归因、聚类、预测、聚类矩阵；所有下钻都在页内 |
| `?view=system&product=…` | `system.js` | 评测体系机制图（输入 → 压缩 → 归因 → 聚类）、证据闭环 |
| `?view=samples&product=…&case=…` | `samples.js` | 具体数据三栏：问句列表 / 对话原文 / 归因或轨迹；筛选、轮次、tab 同步到 URL |

顶部右侧是全局产品切换（问财 / AIME），也是数据源指示；不要在每个卡片里重复放切换。
数据页不跳样本；样本页负责深链进入。

## 4. 文件地图

| 文件 | 用途 | 通常什么时候改 |
|---|---|---|
| `dashboard/build.py` | 数据解析、配对、聚合、生成三类 payload | 口径、字段、聚合、预测接入 |
| `dashboard/server.py` | 静态服务、gzip、定时构建、`/healthz` | 服务行为、缓存、刷新 |
| `dashboard/static/js/app.js` | 路由、主题、产品切换、模块懒加载、错误兜底 | 页面级状态 |
| `dashboard/static/js/core.js` | 共享格式化、数字动画、`segmented`、提示等 | 通用交互 |
| `dashboard/static/js/data.js` | 数据页各卡片与聚类矩阵 | 数据页排版、下钻 |
| `dashboard/static/js/system.js` | 评测体系机制图、聚类（阶段 → 环节 → 机制 → 模式）、证据闭环 | 体系页 |
| `dashboard/static/js/samples.js` | 具体数据三栏工作台（对话气泡、证据高亮、归因卡片） | 筛选、样本详情 |
| `dashboard/static/js/render.js` | 公共内容渲染：Markdown-lite、JSON 高亮、按偏移保留证据高亮 | 文本 / JSON 呈现 |
| `dashboard/static/js/sunburst.js` | 原生 SVG 可下钻旭日图 | 数据量 / 聚类环 |
| `dashboard/static/app.css` | 所有样式与 token | 样式微调、响应式 |
| `dashboard/tests/test_empty_data.py` | 合成数据端到端构建测试 | 改 build.py 后 |
| `dashboard/deploy.sh` | 同步、远端构建、预压缩、重启 | 发布 |

先读 `README.md`、`docs/design-principles.md`、`docs/dashboard-deployment.md`、
`docs/prediction-data.md`。`docs/dashboard-optimization.md` 是早期优化记录；涉及
ECharts / board.js 的实现段落已不适用，当前是原生 SVG + ES modules。

## 5. 数据契约

`static/data.json`：

```text
{ schema, generated_at, source, taxonomy, system, products }
products[product] = { kpi, dates, field, cross, patterns, ... }
```

`static/samples.json` 的 `products[product].rows[]` 是召回索引，不含完整 trace：

```text
q 问题 · m 模型 · sp daily/lost · d 日期 · w 最严重等级 · n 问题数
sv 严重度构成 · r 环节 · st 阶段 · pt 模式 · tg 标签 · lb 问题标签
tr 轮数 · mc 消息数 · lang · case · s 短 slug
```

选中样本后再懒加载 `static/samples/<slug>.json`，主要字段：
`input.traces[]`、`attribution.problems[]`、`compact`、`evidence[]`；证据的
`t/m/b/o` 分别是 trace、message、block 与偏移。不要把完整 trace 塞回索引。

预测卡在 `datasets/<product>/prediction.json` 缺失时使用带「示例数据」标记的 mock；
真实接口格式见 `docs/prediction-data.md`。

## 6. 常见改动怎么下手

1. **改数据口径 / 加指标**：改 `build.py` 的 `build_sample`、`aggregate`、
   `system_facts` 或 `taxonomy_out`；跑 `refresh.sh`；再在对应 JS 中读取新字段。
   加字段后补端到端测试。
2. **改数据页卡片**：在 `data.js` 找到对应 `*Card()` 函数和 `wire()`；保持
   `card(span, …)` 的 12 列 Bento 布局，一卡一主视觉，下钻留在页内。
3. **改证据闭环**：`build.py` 的 `system_facts` 产出 `system.anatomy`，
   `system.js` 的 `anatomyCard` / `anatomyBody` / `wireEvidence` 负责渲染；
   详情继续按 slug 懒加载。
4. **改聚类体系**：`build.py` 的 `taxonomy_out` 提供阶段/环节/机制/模式；
   `system.js` 的 `taxoCard` 用六列网格并按阶段分组，`wireTaxo` 负责展开。
   不要把环节卡改回 flex-wrap，也不要在卡片里加数量/长条分布。
5. **改样本筛选**：`samples.js` 的 `F()`、`skeleton()`、`syncFilters()` 和列表
   过滤逻辑；筛选字段来自 `samples.json` 行，保持 URL 可分享。
6. **改样式**：只改 `app.css`，优先复用现有 token 和类。不用硬边框，用 1%~3% 的
   微差灰阶分层、同心圆角、16pt 横向 / 16–24pt 纵向间距、数字 `tabular-nums`。

## 7. 容易踩的坑

- **证据闭环高度**：`.echo` 固定桌面高度，`.echo-side` / `.echo-main` /
  内部滚动区需要 `min-height: 0`；不要在 `.echo-list` / `#anatomyBody` 上加
  `overscroll-behavior: contain`，否则页面滚轮会被锁住。证据行不要恢复
  `content-visibility: auto`，会造成行高和滚动条跳动。
- **AIME 是整体**：`unified=true`，日常/流失不拆组；流失只在会话场组头做标记。
  问财没有 task 时，场景取 skill 投票（`build.py` 的 `scene`）。
- **数据页只做页内下钻**：聚类矩阵、旭日图、预测页签都不跳样本；只有样本页
  承接 `case` 深链。
- **生成物不是源码**：`static/data.json`、`static/samples.json`、`static/samples/`
  由构建产生，不入库；本地刷新/远端部署会自动重建。
- **部署**：`./dashboard/deploy.sh`；完成后看 `logs/build.log` 和 `/healthz` 的
  `ok`、`build.pairs`。构建失败不会自动回滚，服务可能继续使用旧数据。
- **服务没有守护进程**：容器/环境重启后需要手动 `start.sh`；端口和刷新间隔可用
  `PORT` / `REFRESH_SECONDS` 覆盖（`start.sh` 里写死了默认 `PORT=5001`）。

## 8. 发布命令

```bash
./dashboard/deploy.sh
curl -s "http://<dashboard-host>:<port>/healthz" | jq
```

远端目录 `/opt/eval_dashboard` 不是 git 仓库，`rsync --delete` 会删除远端多余文件；
回滚应切回旧 commit 后重新部署。生成数据只在远端构建，不要从本地覆盖。
