# AIME 评测输入打包流程

脚本把远端仍在增长的 AIME 输入目录流式压成一个 `tar.zst`，产物落在
`/mnt/fin_bench/aime_data/`。流程只负责读取目录、压缩和写入最终文件，不生成额外的摘要文件。

## 用法

```bash
scp scripts/pack_aime_input.sh eval_data:/tmp/
ssh eval_data 'chmod +x /tmp/pack_aime_input.sh && /tmp/pack_aime_input.sh <目录…>'
```

常用参数：

- `LEVEL=12`：默认压缩级别。
- `LEVEL=19`：更小的产物，耗时更长。
- `THREADS=<n>`：指定压缩线程数。
- `--tag <name>`：给产物文件名增加标签。
- `OUT_FILE=<path>`：指定产物路径。

脚本会把压缩流先写入 `.part` 文件，完成后再改名为正式产物；中途失败不会留下半成品。实时目录可能在读取期间继续变化，因此每次打包都是当时读取到的快照。

## 恢复

```bash
zstd -dc aime_input_<日期>.tar.zst | tar -xf - -C /mnt/fin_bench/aime_data/
```

包内保留源目录的相对路径，不在搬运阶段重命名或合并数据口径。
