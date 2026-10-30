# eval_data_server

AIME 评测数据在远端服务器上的**搬运、打包与看板**工程。

数据不在这个仓库里——仓库只放流程、脚本和看板代码；数据始终留在远端 `eval_data`
(`dashboard.example.com:22`) 与 `ceph-fuse` 挂载上。

## 目录

```
servers.conf                    # 服务器清单（ssh 别名、端口、密钥路径）
scripts/pack_aime_input.sh      # 把 1_aime 评测输入流式打成单个 tar.zst
docs/aime-input-packaging.md    # 打包流程、压缩基准、参数取舍、踩坑记录
```

## 快速开始

```bash
scp scripts/pack_aime_input.sh eval_data:/tmp/
ssh eval_data 'chmod +x /tmp/pack_aime_input.sh && /tmp/pack_aime_input.sh'
```

产物落在 `/mnt/fin_bench/aime_data/aime_input_<日期>.tar.zst`，旁边附 `.manifest.txt`
（sha256、参数、耗时、还原命令、逐文件清单）。

默认 `LEVEL=12`：10.3 GB 输入约 **47 秒 / 620 MB（16.6×）**。要更小用 `LEVEL=15`
（129 秒 / 597 MB），极致压缩用 `LEVEL=19`（392 秒 / 539 MB / 19.06×）。
依据见 [docs/aime-input-packaging.md](docs/aime-input-packaging.md)。

## 数据现状

| 数据 | 位置（远端） | 规模 |
|---|---|---|
| AIME 流失用户输入 | `…/2_eval_input/1_lost_user_eval/.archive/` | 34 文件 / ~8.9 GB |
| AIME 日常输入 | `…/2_eval_input/0_daily_eval_input/` | 83 文件 / ~11.6 GB |
| 归档产物 | `/mnt/fin_bench/aime_data/` | `aime_input_20261030.tar.zst` 等 |

`0_daily_eval_input` 是**实时目录**，流水线在持续写入；打包按快照语义处理，详见流程文档 §5。

## 后续：数据看板

仓库以 ops 脚本起步，看板在其上推进。计划中的分层：

1. **取数层**：复用 `pack_aime_input.sh` 的 manifest / sha256，产出可追溯的数据快照；
2. **指标层**：从 jsonl 抽 `request_time / agent_mode / usage / ok / status_code` 等字段，
   落成按天的聚合表；
3. **展示层**：Web 看板（技术栈待定，尚未选型，不在本仓库预置脚手架）。

决定落地前先看 `docs/`，不要在没有指标定义的情况下先写 UI。
