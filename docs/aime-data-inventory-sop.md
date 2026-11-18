# AIME 数据存量盘点 SOP（待瘦身 / 待评测 / 已评测）

回答三个问题，按 **日期 × 模型** 出数：还有多少没瘦身、还有多少没评测、已经评测多少。

对应脚本：`scripts/aime_data_inventory.py`。一条命令出表；**默认 0.4 秒**（命中缓存），
只有首次或检测到输入被改写时才读输入文件（47 GB，实测 17 秒）。

数字口径见第 1 节——**这一节必须先对齐再统计**，历史上出过的错都在这里。

## 0. 前置

| 项 | 值 |
|---|---|
| 数据服务器 | 弗吉尼亚 `aime_rsi_data`（`10.217.219.2:2473`，容器 `interactive-s3ynzadcvm9c`） |
| 数据根 | `/mnt/aime_eval_ssd` |
| 时区 | **容器是 UTC**，汇报一律换算北京时间（+8）；日志里 `12:08` 实际是 20:08 |
| 连接 | 复用 SSH 长连接；脚本内部已带 `ControlMaster`，失败时先 `nc -z 10.217.219.2 2473` |

脚本在笔记本和服务器上都能直接跑：本机看不到 `/mnt/aime_eval_ssd` 时会自动把自身投到远端执行。

## 1. 三个口径（先对齐）

| 指标 | 定义 | 单位 | 权威数据源 |
|---|---|---|---|
| **待瘦身** | 原始采集文件里 `offset` 之后**还没被瘦身流水线读取**的行数 | 行（2026-11-13 起 1 行 = 1 个 trace；更早的行可能含多条 trace） | `code/3_scripts/1_slim_publish/state/state.sqlite3` 的 `files.offset` |
| **待评测** | 输入文件里的 trace 集合 **减去** 已有归因输出的 trace 集合 | 个 trace（已去重） | 输入 jsonl + `.keys` 索引 |
| **已评测** | 输入 trace 中**已产出归因**的那部分 | 个 trace（已去重） | `.keys` 索引 |

**不要这样算（都会错）：**

- ❌ 用输出文件行数当「已评测」：输出是追加历史，含重复与已从输入移除的 trace（2026-11-16 快照：输出 125,024 行，落在输入里的只有 119,535）。
- ❌ 用「输入行数 − 输出行数」当「待评测」：输入会被回填重写，同一日期会出现输出行数 > 输入行数（如 2026-10-23 FAST：输入 4,045 / 输出 4,321）。
- ❌ 用 `status.json` 当进度：只保留最近 16 个文件，且是旧快照。例：`aime_expert/2026-10-20` 记 `total_lines: 122`，实际文件 2,567 行。
- ❌ 用原始文件行数当「待评测」：2026-11-13 起原始一行是一条 trace；更早的一行是 session，可能含多条 trace。模型判定也变了：新数据看顶层 `meta.runtime_mode`，旧数据才看 `trace.meta.mode`。

**行数 ≠ 唯一 trace**：输入 157,703 行，去重后 155,335 个 trace（同一 trace 的多次快照会重复落盘）。
评测本身就是按 `trace_id` 去重，所以「待评测 / 已评测」用唯一 trace 口径。

## 2. 一条命令

```bash
python3 scripts/aime_data_inventory.py
```

输出（2026-11-17 21:05 快照，刚补完 11-12~11-16 的积压）：

```text
| 日期 | EXP 待处理 | EXP 已评测 | EXP 待评测 | FAST 待处理 | FAST 已评测 | FAST 待评测 | 待评测小计 |
|---|---:|---:|---:|---:|---:|---:|---:|
| 2026-11-10 | – | 629 | 529 | – | 1,082 | 2,453 | 2,982 |
| 2026-11-12 | – | 296 | 1,574 | – | 318 | 4,536 | 6,110 |
| 2026-11-13 | – | 16 | 1,833 | – | 1 | 4,848 | 6,681 |
| 2026-11-14 | – | – | 970 | – | – | 2,936 | 3,906 |
| 2026-11-15 | – | – | 921 | – | – | 2,853 | 3,774 |
| 2026-11-16 | – | – | 309 | – | – | 597 | 906 |
| **合计** | **–** | **29,748** | **7,773** | **–** | **93,103** | **24,711** | **32,484** |

待瘦身   0 行（EXP 0 / FAST 0），0 个文件
待评测   32,484 个 trace（EXP 7,773 / FAST 24,711）
已评测   122,851 个 trace（EXP 29,748 / FAST 93,103），覆盖 79.1%
输入     157,703 行 / 155,335 个唯一 trace（重复 2,368 行）
索引     本次重建 58 个文件（首次或格式变更），其余增量
耗时     23.9s
```

参数：

| 参数 | 说明 |
|---|---|
| `--json` | 机器可读：三个总量 + `per_day[]`（含 `ids` / `lines` / `miss`） |
| `--rebuild` | 强制重建 trace_id 索引（怀疑数据被改写或改了提取正则时用） |
| `--local` | 强制本地执行，不走 ssh |
| `--root` | 数据根，默认 `/mnt/aime_eval_ssd`；测试可用假目录 |
| `--cache-dir` | 索引缓存位置，默认 `<root>/code/3_scripts/cache/aime_data_inventory` |

耗时：

| 场景 | 实测 |
|---|---|
| 首次 / `--rebuild`（读 47 GB 输入建索引） | **17 s** |
| 日常（命中缓存，只读待瘦身尾巴 + `.keys`） | **0.4 s** |
| 输入有追加（只读新增字节） | 秒级，取决于追加量 |

## 3. 它怎么算的（出问题时的排查依据）

### 3.1 待瘦身

读 `state.sqlite3` 的 `files(path, size, offset)`，和文件实际大小比对：
`actual > offset` 的部分才是没处理的尾巴。只读这段字节，按行统计 `runtime_mode`
（`expert` / `fast`，其余记 `other`），行尾没写完整的那行不计。

- `runtime_mode` 在每行**开头**的 `meta` 里，所以只在头部 8 KB 找，找不到再全行找。
- 2026-11-13 起一行就是一条 trace；更早的行可能含多条 trace，`runtime_mode` 也可能为空（历史补发流），这部分报 `other` 是正常的。
- 结果按 `<cache>/slim_tails.json` 按 `(path, offset, size)` 缓存。

### 3.2 已评测

`.keys/<model>/<model>_attribution-<date>.jsonl.keys`，一行一条评测记录：

```json
["<session key>", ["<trace_id>", "..."]]
```

两边都登记：`T:<trace_id>` 与 `S:<session key>`。后者是为了兼容 2026-11-09 之前的
session 粒度旧记录（没有 trace_id，只能用 session 做 key）。

### 3.3 待评测

```
输入 trace 集合（来自 jsonl） − 已评测集合（来自 .keys）
```

trace_id 提取规则：**行尾 4 KB 内最后一个 `"trace_id": "..."`**（兼容带空格与不带空格两种序列化）；
尾部没有就全行取最后一次；再没有才回退 `S:<session_id>`。

> ⚠️ 别把「头部窗口的 trace_id」当兜底：头部那个是 `meta.trace_id`（会话级 `thread_xxx`），
> 用它会把同一会话的多条 trace 折叠成一条。v3 就踩过这个坑，v4 改成「尾部 → 全行」，全库只有 26 行真没有 trace_id。

### 3.4 增量索引

每个输入文件一份索引，存在 `<cache-dir>/<model>/<date>.ids` + `<date>.json`：

```json
{"v": 4, "size": 23456789, "mtime_ns": 1763..., "head": "<md5>", "head_limit": 4096,
 "lines": 1590, "miss": 0}
```

刷新时按三路分支：

| 条件 | 动作 |
|---|---|
| `size` 与 `mtime_ns` 都没变 | 直接复用，不读文件 |
| 只变大，且前 `head_limit` 字节 md5 没变 | 只读 `[size, 新 size)` 这段，增量合并 |
| 变小 / mtime 变了前缀也变了（回填重写） | 该文件全量重扫 |

`head_limit` 存的是「上次写入时的 `min(4096, size)`」。**不能**直接用文件前 1 MB 做
md5：小文件会被整段覆盖，追加一个字节哈希就变，增量永远命中不了（v2 的 bug，v3 修）。

`v` 是提取器版本，正则/窗口一改就加一，旧索引自动失效重扫——这是唯一安全的升级方式。

## 4. 每次盘点按这个顺序做

1. **跑命令**：`python3 scripts/aime_data_inventory.py`，看底部四行摘要。
2. **看索引行**：显示「命中缓存」才说明没白扫；显示「重建 N 个文件」时留意是不是回填导致的。
3. **对账**（下面 5 条，全过再往上报）。
4. **看异常**：`[warn] N 行没有 trace_id` 应为 26（全在 2026-09 的 lost_user 旧文件）。数量变大说明输入格式变了，先查格式再报数。
5. **汇报**：直接贴脚本输出的表，附「待瘦身 / 待评测 / 已评测」三个数。

### 对账清单

| 检查 | 期望 |
|---|---|
| 表内每行 `已评测 + 待评测 = ids` | 恒等（脚本内部保证） |
| `待评测小计 = EXP 待评测 + FAST 待评测` | 恒等 |
| 合计行 = 各列之和 | 恒等 |
| `已评测 ≤ .keys 总行数` | 成立（当前 119,535 ≤ 124,991） |
| 抽查：抓 3 个待评测 trace_id，在归因文件里 grep | 搜不到（确实是没评测） |

抽查命令（示例）：

```bash
ssh aime_rsi_data 'python3 - <<EOF
import json
m,d="aime_expert","2026-10-20"
keys=set()
for line in open(f"/mnt/aime_eval_ssd/1_aime/eval_output/0_daily_eval/.keys/{m}/{m}_attribution-{d}.jsonl.keys"):
    for t in json.loads(line)[1]: keys.add(t)
seen=set(); pend=[]
for line in open(f"/mnt/aime_eval_ssd/1_aime/eval_input/0_daily_eval_input/{m}/{d}.jsonl"):
    t=json.loads(line).get("trace_id")
    if t and t not in keys and t not in seen: seen.add(t); pend.append(t)
print(len(pend), pend[:3])
EOF'
```

## 5. 常见坑（每条都踩过）

| # | 坑 | 现象 | 处理 |
|---|---|---|---|
| 1 | `status.json` 过期 | 记录的 `total_lines` 远小于实际行数 | 只当参考，进度一律用本 SOP |
| 2 | 输出行数 > 输入行数 | 怀疑算错 | 输入被回填重写，用集合差，不要相减 |
| 3 | 输入有重复行 | 行数 > 唯一 trace | 报数用唯一 trace；重复量看 `--json` 的 `lines - ids` |
| 4 | 两种 JSON 序列化混用 | 同一文件里既有 `"trace_id":"x"` 又有 `"trace_id": "x"` | 正则用 `\s*`，窗口 4 KB；改动必须升 `EXTRACTOR_VERSION` |
| 5 | 容器时区是 UTC | 停摆时长算错 8 小时 | `TZ=Asia/Shanghai date` 再算 |
| 6 | 历史回填 | 某天输入突然多几千条，待评测暴涨 | 看 `state/rescan_backfill.log`、`rescan_q.log` |
| 7 | 新格式模型字段搬家 | 2026-11-13 起 `trace.meta.mode` 消失，只读它会全部落到 `no_model` | 判定顺序：`trace.meta.mode` -> `meta.runtime_mode` -> `agent_name`/`name` 前缀 -> `meta.lf_metadata.mode`；新数据主要看 `runtime_mode` |
| 8 | 看板 `data-aime.json` 滞后 | 与脚本数字差几个 | 看 `generated_at`；对账以本脚本为准 |
| 9 | 目录别算进去 | 数字虚高 | `eval_output/0_daily_eval-pre-split-*`、`.archive`、`.runs`、`.parts`、`.merge` 都不是业务结果 |
| 10 | 磁盘接近满 | 写入失败、loop 悄悄死掉 | `df -h /mnt/aime_eval_ssd`；2026-11-16 是 96% |
| 11 | 原始文件被合并重写 | 旧 offset 之后看起来没变，前缀里的新增会被漏掉 | 流水线按 size/mtime/offset + 头部 md5；头部变了就从头重扫，靠全局索引去重。2026-11-17 的 11-12/11-13 已用 `--full` 重扫 |
| 12 | 只按 trace_id 去重会误删 | 287 个 trace_id 出现在不同 session 下 | 去重键必须是 `session_id + trace_id`，已落到 `seen_keys` |

## 6. 流水线停摆的判断

三个信号一起看，缺一个都可能误判：

```bash
ssh aime_rsi_data 'ps aux | grep -E "slim_publish|loop.sh|eval" | grep -v grep'   # 进程
ssh aime_rsi_data 'ls -l --time-style=full-iso /mnt/aime_eval_ssd/1_aime/eval_output/0_daily_eval/aime_fast/*.jsonl | tail -1'  # 最后产出
ssh aime_rsi_data 'tail -5 /mnt/aime_eval_ssd/code/3_scripts/1_slim_publish/state/loop.log'  # 日志
```

瘦身侧还有现成巡检（含 loop 存活、输入积压、最近一轮、磁盘；`OK/WARN` 退出码 0，`FAIL` 退出码 2）：

```bash
ssh aime_rsi_data 'cd /mnt/aime_eval_ssd/code/3_scripts/1_slim_publish && python3 check.py --json'
```

**loop 死掉的典型样子**：`loop.pid` 还在，`ps` 查不到进程，`loop.log` 最后一行是「休眠 3600s」。
处理：`bash /mnt/aime_eval_ssd/code/3_scripts/1_slim_publish/start.sh`。

`start.sh` 现在会同时拉起 `loop.sh` 和 `watchdog.sh`；watchdog 每 10 分钟确认 loop 存活，不在就自动拉起。
容器重启后按 `scripts/virginia/bringup.sh` 的流程也会顺带拉起瘦身流水线。

## 7. 快照（2026-11-17 21:05）

| 指标 | EXP | FAST | 合计 |
|---|---:|---:|---:|
| 待瘦身（行） | 0 | 0 | **0** |
| 已评测（trace） | 29,748 | 93,103 | **122,851** |
| 待评测（trace） | 7,773 | 24,711 | **32,484** |
| 输入唯一 trace | 37,521 | 117,814 | 155,335 |
| 覆盖率 | 79.3% | 79.0% | **79.1%** |

按天的待评测会随评测流水线推进实时变化，直接看脚本输出的表；当前积压主要集中在 2026-11-10~11-16，其中刚补进来的 11-12 / 11-13 最多。

## 8. 与历史数字的关系

2026-11-16 上午第一版手算是「待评测 13,858 / 已评测 116,780 / 唯一 130,638」，比现在少约 2,900 条唯一 trace。
原因是当时用 awk 只搜行尾 700 字节，漏了 trace_id 不在尾部窗口的行，这些行回退成 session key 后被折叠。
现在脚本 v4 的口径经过 JSON 全量解析对账（10-28、11-06、11-11 三天逐条比对一致），**以脚本为准**。

## 9. 变更记录

| 日期 | 变更 |
|---|---|
| 2026-11-16 | 首版：脚本 `scripts/aime_data_inventory.py` + 本文；口径定为 trace 去重、增量索引 v4 |
| 2026-11-17 | 瘦身流水线适配新格式（`meta.runtime_mode`）与全局 `session_id + trace_id` 去重；补完 11-12~11-16 积压，待瘦身归零 |
