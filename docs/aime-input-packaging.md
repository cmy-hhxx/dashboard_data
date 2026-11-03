# AIME 评测输入 + 输出打包流程

常规动作：一条命令把 `1_aime/eval_input` 与 `1_aime/eval_output` 打成**单个** tar.zst，
放到 `/mnt/fin_bench/aime_data/`。端到端约 **2.5–3 分钟**，产物带完整性校验。

## 用法

```bash
scp scripts/pack_aime_io.sh eval_data:/tmp/
ssh eval_data 'chmod +x /tmp/pack_aime_io.sh && /tmp/pack_aime_io.sh'
```

产物：`/mnt/fin_bench/aime_data/aime_input_output_<日期>.tar.zst`（同日重复打包用 `--tag` 区分）。

常用变体：

```bash
./pack_aime_io.sh eval_output                 # 只打输出
LEVEL=15 ./pack_aime_io.sh --tag small        # 更小的产物
VERIFY=0 ./pack_aime_io.sh                    # 跳过解压对账，省 ~20 秒
EXCLUDE=.archive ./pack_aime_io.sh            # 把 .runs/.delivery 运行现场也带上
OUT_FILE=/tmp/x.tar.zst ./pack_aime_io.sh     # 演练，不落正式目录
```

## 为什么先把文件搬到本地再压

源在 `ceph-fuse` 上，**单流顺序读实测只有 ~20 MB/s**（小文件更慢）：老的
`tar | zstd` 一条管道 13 GB 会卡在读取上约 11 分钟，压缩参数再快也没用。

`pack_aime_io.sh` 把读取并行化，产物仍是标准单流 `tar.zst`：

| 阶段 | 做法 | 实测（2026-11-03 复跑） |
|---|---|---|
| 1. 搬运 | 本地磁盘暂存，`PAR`(默认 8) 路并行读 ceph | 88 秒 / ~140 MB/s 聚合 |
| 2. 压缩 | 单流 `tar` + `zstd -12 --long=27 -T$(nproc)` | 39 秒 / ~330 MB/s |
| 3. 校验 | `zstd -t` + 包内条目数/解压后字节数对账 | 24 秒 |

`--long=27`（128 MB 窗口）让跨文件重复内容共享字典；产物解压**不需要**特殊参数
（128 MB 窗口正好是 zstd 解码器默认上限）。

## 实测（2026-11-03）

| 指标 | 值 |
|---|---:|
| 打包范围 | 459 文件 / 12.13–12.14 GiB（实时目录仍在写，随时刻浮动） |
| 产物 | 826–827 MB（788 MiB） |
| 压缩率 | **6.3–6.4% / 15.8×** |
| 端到端 | **151 秒**（搬运 88s + 压缩 39s + 校验 24s） |

同口径对比：老脚本的单流 `tar | zstd` 预计 ~11 分钟（读 20 MB/s 是瓶颈），产物
675 MB@15.8×；`LEVEL=15` 产物再小约 4%，压缩阶段会慢到 ~2 分钟。

注：`ceph-fuse` 带宽与同机其他任务（看板/分析构建）共享，实测在 70–140 MB/s 之间波动；
搬运阶段是唯一受影响的环节。

## 打包口径（重要）

- **包含**：`eval_input/`、`eval_output/` 两棵树的全部业务文件（jsonl、附件、`cluster` 等）。
- **排除**（任意层级）：`.archive`（历史运行现场，5.1 GiB）、`.runs` 与 `.delivery`
  （流水线**实时写入**的运行现场，约 1.1 GiB）。依据见
  [aime-data-inventory.md](aime-data-inventory.md) §7.3：业务结果都已落到 jsonl 里，
  运行现场只对复现有用，且实时写入会把读取拖死、也无法得到一致快照。
  要连运行现场一起带上用 `EXCLUDE=.archive`。
- **快照语义**：实时目录可能在搬运期间变化。脚本搬完先对账，个别文件被改写就重搬，
  最终包内是当时读到的**一致快照**；打包后校验包内条目数与解压后字节数。
- 包内保留源目录的相对路径（顶层 `eval_input/`、`eval_output/`），不重命名、不合并。

## 解压 / 恢复

```bash
zstd -dc aime_input_output_<日期>.tar.zst | tar -xf - -C /mnt/fin_bench/aime_data/
```

## 其他参数

| 变量/参数 | 默认 | 说明 |
|---|---|---|
| 位置参数 | `eval_input eval_output` | 要打包的目录（相对 `$SRC_BASE`） |
| `LEVEL` / `--level` | `12` | 压缩级别（固定 `--long=27`） |
| `THREADS` / `--threads` | `nproc` | zstd 压缩线程 |
| `PAR` / `--par` | `8` | ceph 并行读流数；不是越大越好，8~10 实测最快 |
| `VERIFY` / `--no-verify` | `1` | 是否做解压对账 |
| `EXCLUDE` | `.archive,.runs,.delivery` | 逐级排除的目录名 |
| `TAG` / `--tag` | 日期 | 产物文件名标签 |
| `OUT_FILE` | `$DST_DIR/aime_input_output_<日期>.tar.zst` | 产物路径 |
| `SRC_BASE` / `DST_DIR` | 见脚本头 | 源根目录 / 产物目录 |

## 旧的 pack_aime_input.sh

`scripts/pack_aime_input.sh` 是早期的**单流** `tar | zstd` 版本（口径为 `2_eval_input` 的窄包，
其默认路径 `…/1_aime/2_eval_input` 也已随目录改名失效）。在 ceph-fuse 单流限速下它要慢
一个数量级，仅作历史参考；常规打包一律用 `pack_aime_io.sh`。
