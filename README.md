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
| `static/` | 页面、ECharts 离线包、animate.css / CountUp.js、构建好的 `app.css` |
| `precompress.sh` | 部署时预压缩 JS/CSS/HTML；`prepare.py` 额外产出 `data.json.gz`，`server.py` 按 `Accept-Encoding` 直接发 `.gz` |
| `build/` | Tailwind/DaisyUI 配置与构建入口（`npx tailwindcss -c tailwind.config.js -i input.css -o ../static/app.css --minify`） |

口径：输入 = 数据集中的 `*_input.jsonl`；已评测 = 输出侧回答记录数（问财四个版本 answer 合计，
不含 comparison 记录；AIME 输出记录数）；待评测 = 输入 − 已评测。
问财 / AIME 都按 `meta.task` 展示任务分布：问财不展示「其他/其它」，AIME 把「其它」并进「其他」；
AIME 的 task/subtask 取自输出 `turns[].meta` 最后一轮，与问财使用同一套标签。
每个产品一页，页面采用 2+3：上排「数据量 / 评测量」，下排「归因体系 / 聚类体系 / 预测体系」。
右上角按钮带翻页动画，在问财、AIME 两个完整页面之间切换；窄屏改为单列滚动。
数据量与归因使用全名条形列表（task → subtask 下钻、A/B 或 P0-P3 堆叠），避免树图小标签只显示两个字。
评测量看覆盖、模型/版本、Tokens 与 P50；聚类体系展示真实 cluster_tree 的三层结构，
点击环节/机制逐层下钻，返回按钮恢复到上一级（演示原型）；预测体系展示未来 7 天趋势与置信区间（演示数据）。
问财不再展示对战结论。
