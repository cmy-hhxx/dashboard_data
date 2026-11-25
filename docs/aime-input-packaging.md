# AIME 评测输入 + 输出打包流程

将弗吉尼亚 `/mnt/aime_eval_ssd/1_aime` 下的 `eval_input` 与 `eval_output` 打成单个标准 `tar.zst` 并做完整性对账（乌兰 `1_aime` 为历史副本，不再用于打包）。

## 1. 用法

```bash
scp scripts/pack_aime_io.sh aime_rsi_data:/tmp/
ssh aime_rsi_data 'chmod +x /tmp/pack_aime_io.sh && SRC_BASE=/mnt/aime_eval_ssd/1_aime /tmp/pack_aime_io.sh'
```

默认产物：`/mnt/fin_bench/aime_data/aime_input_output_<日期>.tar.zst`（同日复打用 `--tag` 区分）。

```bash
# 常用变体
./pack_aime_io.sh eval_output                 # 仅打输出
LEVEL=15 ./pack_aime_io.sh --tag small        # 更高压缩率
VERIFY=0 ./pack_aime_io.sh                    # 跳过解压对账
EXCLUDE=.archive ./pack_aime_io.sh            # 连同 .runs/.delivery 运行现场一起打包
OUT_FILE=/tmp/x.tar.zst ./pack_aime_io.sh     # 演练输出到临时路径
```

## 2. 原理与打包口径

- **先并行搬运再单流压缩**：`ceph-fuse` 单流顺序读仅 ~20 MB/s；脚本先按 `PAR`（默认 8 路）并行搬到本地暂存，再执行单流 `tar | zstd -12 --long=27 -T$(nproc)`，最后 `zstd -t` 并核对条目数与解压总字节数。`--long=27`（128 MB 窗口）处于 zstd 解码器默认上限内，解压无需额外参数。
- **包含**：`eval_input/`、`eval_output/` 全部业务文件，包内保留相对路径，不合并改名。
- **默认排除**：任意层级的 `.archive`、`.runs`、`.delivery`（历史归档与实时写入现场）。
- **快照语义**：搬运后对账，若实时写入导致个别文件变更则重搬，保证包内为一致快照。

## 3. 解压与参数

```bash
zstd -dc aime_input_output_<日期>.tar.zst | tar -xf - -C /mnt/fin_bench/aime_data/
```

| 参数 / 环境变量 | 默认值 | 说明 |
|---|---|---|
| 位置参数 | `eval_input eval_output` | 相对 `$SRC_BASE` 的打包目录 |
| `SRC_BASE` / `DST_DIR` | 见脚本头 | 源根目录 / 产物输出目录 |
| `LEVEL` / `--level` | `12` | zstd 压缩级别（固定 `--long=27`） |
| `THREADS` / `--threads` | `nproc` | zstd 压缩线程数 |
| `PAR` / `--par` | `8` | 并行搬运路数（8–10 最优） |
| `VERIFY` / `--no-verify` | `1` | 是否做解压完整性对账 |
| `EXCLUDE` | `.archive,.runs,.delivery` | 逐级排除的目录名（逗号分隔） |
| `TAG` / `--tag` / `OUT_FILE` | 当天日期 | 产物文件名标签或完整路径 |
