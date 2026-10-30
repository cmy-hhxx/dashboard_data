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

`dashboard/` 是问财 / AIME 评测看板：静态页面 + ECharts，Python 标准库起服务，
数据由 `prepare.py` 直接扫 `3_eval_output` 的评测产物生成。

![dashboard](docs/dashboard.png)

```bash
./dashboard/deploy.sh                                   # 同步到 /opt/eval_dashboard 并重启
ssh eval_data 'python3 /opt/eval_dashboard/prepare.py'  # 手动重算 data.json
```

服务监听容器 `:5001`，对外是 `http://dashboard.example.com:2768/`。刷新周期 30 分钟。

| 文件 | 作用 |
|---|---|
| `prepare.py` | 扫评测输出 / 对比判定 / 归因，产出 `static/data.json` |
| `count_inputs.py` | 并行数 `2_eval_input` 的 jsonl 行数，落 `cache/input_counts.tsv`（50 GB，约 5 分钟，按需手动跑） |
| `server.py` | `ThreadingHTTPServer` + 定时重算；`/healthz` 返回最近一次刷新状态 |
| `static/` | 页面与 ECharts（离线包，服务器无外网） |

口径：输入 = `2_eval_input` 的逐日输入条数；输出 = `3_eval_output` 各评测任务产物。
问财取 2026-10-23 批次的 A/B 对比与归因，AIME 取日常 / 流失两套输出。
