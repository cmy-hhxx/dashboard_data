# eval_data_server

AIME 评测数据在远端服务器上的**搬运、打包与看板**工程。

数据不在这个仓库里——仓库只放流程、脚本和看板代码；数据始终留在远端 `eval_data`
(`dashboard.example.com:22`) 与 `ceph-fuse` 挂载上。

## 目录

```
servers.conf                    # 服务器清单（ssh 别名、端口、密钥路径）
scripts/pack_aime_input.sh      # 把 AIME 评测输入流式打成单个 tar.zst
docs/aime-input-packaging.md    # 打包流程、压缩基准、参数取舍、踩坑记录
docs/aime-data-inventory.md     # 2026-10-30 那份数据的解压体量与目录拆解
docs/manifests/                 # 历史包的逐文件清单（数据删了，清单留着）
```

## 快速开始

```bash
scp scripts/pack_aime_input.sh eval_data:/tmp/
# 打包范围由调用方显式给出（不传则默认两棵目录树，仅作省事用）
ssh eval_data 'chmod +x /tmp/pack_aime_input.sh && /tmp/pack_aime_input.sh <目录…>'
```

产物落在 `/mnt/fin_bench/aime_data/aime_input_<日期>.tar.zst`，旁边附 `.manifest.txt`
（sha256、参数、耗时、还原命令、逐文件清单）。

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

`dashboard/` 是问财 / AIME 评测看板：Tailwind + DaisyUI 页面、ECharts 图表、Python 标准库起服务。
**唯一数据源**是 `/mnt/fin_bench/code_and_clean_data/datasets`（含评测输入与输出的成对文件）。

![dashboard](docs/dashboard.png)

```bash
./dashboard/deploy.sh                                    # 构建产物同步到 /opt/eval_dashboard 并重启
ssh eval_data 'cd /opt/eval_dashboard && ./start.sh'     # 手动起服务
```

服务监听容器 `:5001`，对外是 `http://dashboard.example.com:2768/`。服务每 30 分钟自动重扫数据集并重算。
静态资源部署时预压缩（JS/CSS/HTML/data.json），ECharts/vendor 长缓存，`app.js`/`app.css` 校验缓存，`data.json` 不缓存。

| 文件 | 作用 |
|---|---|
| `scan_datasets.py` | 扫 `datasets` 的输入/输出：逐文件条数、按模型×日期配对、meta 分类分布 → `cache/datasets.json` |
| `prepare.py` | 解析输出侧的归因/覆盖/Token，合并扫描结果 → `static/data.json` |
| `server.py` | `ThreadingHTTPServer` + 定时重算；`/healthz` 返回最近一次刷新状态 |
| `static/` | 页面、ECharts 离线包、构建好的 `app.css`（数字补间与动效均为原生实现，无额外前端依赖） |
| `precompress.sh` | 部署时预压缩 JS/CSS/HTML；`prepare.py` 额外产出 `data.json.gz`，`server.py` 按 `Accept-Encoding` 直接发 `.gz` |
| `build/` | Tailwind/DaisyUI 配置与构建入口（`npx tailwindcss -c tailwind.config.js -i input.css -o ../static/app.css --minify`） |

口径：输入 = 数据集中的 `*_input.jsonl`；已评测 = 输出侧回答记录数（问财四个版本 answer 合计，
不含 comparison 记录；AIME 输出记录数）；待评测 = 输入 − 已评测。
问财 / AIME 都按 `meta.task` 展示任务分布：问财不展示「其他/其它」，AIME 把「其它」并进「其他」；
AIME 的 task/subtask 取自输出 `turns[].meta` 最后一轮，与问财使用同一套标签。
每个产品一页，页面采用 2+3 Bento：上排「数据量 / 评测量」，下排「归因体系 / 聚类体系 / 预测体系」。
顶部是分段式产品切换（滑块吸附，不再用 3D 翻页），桌面固定 2×6 网格，≤1320px 变两列滚动，≤760px 单列。
右上角可切浅色 / 深色，默认跟随系统。
数据量卡片改为 treemap（面积 = 条数，点击方块下钻），底部补体量、文件数、活跃天数与已评测；
归因卡片改为「环节 × A/B 或 P0–P3」热力矩阵（行内总量热力 + 列内热力），不再每行一条进度条，
问财显示 A/B 拆量，AIME 显示 P0–P3 与未分级；评测量用版本指标矩阵（回答/P50/核心/Tokens）+
难度四格卡 + 四格指标条，高分屏再补版本极值；AIME 评测量用 fast/expert 双卡 + 产出 spark +
子任务 Top 4 气泡表；聚类体系改为环形图 + 可点击图例（图例即下钻入口），预测体系补上置信区间、
切分线与 7 日汇总。问财仍只展示 A/B 拆分，不再展示对战结论。

### 设计规则（可复现的 token）

- **一卡一主视觉**：数据量用面积图（treemap），评测量用指标矩阵/环形图，归因用热力矩阵，
  聚类用旭日图，预测用折线图；主视图不再统一画进度条，避免同质化和视觉疲劳。
- **层级不靠边框**：背景 / 卡片 / 内层三档微差灰阶（亮色 `#f1f3f6 → #fafbfc → #f2f4f7`，
  暗色 `#0e1217 → #151b22 → #1b232c`），卡片不再使用 1px 实线，只保留约 2%~3.5% 的明度差和极轻投影。
- **同心圆角**：卡片 18px，内层 12 / 9 / 6px 逐级递减；按钮与 chip 共用更小一级，避免“外大内大”的断层。
- **间距分组**：桌面卡片间距 12px，卡内水平 16px、纵向 10~14px，列表行距 2~4px；外部留白由页面统一控制，
  窄屏改为卡片流式堆叠（宽卡占满、分析卡两列、手机单列）。
- **暗色降字重**：亮色标题 600 / 正文 400；暗色标题与数字降到 500，正文保持 400，并开启抗锯齿，
  避免浅色字在深底上晕开。数字统一 `tabular-nums` + `ch` 锁宽，计数动画结束强制写终值，刷新时不抖动。
- **动效分性格**：hover/press 用 120ms 吸附曲线；页面与产品切换 220ms 直接到位；
  图表 620~680ms 缓出；集群下钻的数字带 360ms 回弹；`prefers-reduced-motion` 下全部关闭。
