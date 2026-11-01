# 本地调试

生产看板只读挂载 `/mnt/fin_bench/code_and_clean_data/datasets`，本机没有这份数据。
`local_dev/` 让 `scan_datasets.py → prepare.py → prepare_samples.py → server.py` 在本地
原样跑通，页面三块（数据 / 评测体系 / 样本）都有内容。

## 启动

```bash
./local_dev/start.sh                 # 自动找数据 + 构建 data.json/samples.json + 起服务
# 打开 http://127.0.0.1:5001/
```

数据源按以下顺序选择：

1. `EVAL_DATASETS=/path/to/datasets`
2. `dashboard_data/data` 或 `dashboard_data/data/datasets`（只要里面有 `0_wencai/` 或 `1_aime/`）
3. 都没有时，生成离线夹具 `local_dev/datasets/`

因此把数据放到仓库根的 `data/` 下，再跑一次 `./local_dev/start.sh` 就会用真实数据。
数据根目录的布局必须和线上一致：

```
data/                      # 或 data/datasets/
  0_wencai/
    eval_input/<model>/<date>.jsonl
    eval_output/0_daily_eval_output/<model>/...
  1_aime/
    eval_input/0_daily_eval_input/<model>/<date>.jsonl
    eval_output/demo_data/<model>/...
```

`start.sh` 会在前台跑 `server.py`，`Ctrl-C` 结束；也可以在另一个终端
`./local_dev/stop.sh`。重跑 `start.sh` 会自动停掉上一个 dev server，换数据源（例如从夹具
切到 `data/`）就是重跑一次。改了 `static/` 下的 JS/CSS 直接刷新页面即可（服务是 `no-cache`）。

## 换端口

```bash
PORT=5055 ./local_dev/start.sh
```

## 数据更新后刷新（不用重启）

```bash
./local_dev/refresh.sh               # 只重扫 + 重建 data.json/samples.json
```

服务发送这两个文件用 `no-cache`，刷新浏览器就能看到新数据。本地 dev 默认把服务自身
的定时重扫设为 24 小时（`REFRESH_SECONDS`，避免大目录反复扫描），所以改了源数据后
用 `refresh.sh` 显式重建；要恢复 30 分钟调度传 `REFRESH_SECONDS=1800`。
强制重建样本可以删掉 `static/samples.json` 与 `static/samples/` 后重启。

## 用真实数据

三个脚本都支持 `EVAL_DATASETS` 环境变量覆盖数据根目录（生产默认值不变），
`server.py` 的子进程会继承它：

```bash
EVAL_DATASETS=/path/to/datasets ./local_dev/start.sh
```

## 离线夹具

找不到 `data/` 时使用夹具，内容：

- `0_wencai`：4 个版本 × 14 天 × 约 24 个会话，默认约 1.3k 会话；输入 / 归因 / compact 三份对齐。
- `1_aime`：`aime_fast` / `aime_expert` × 14 天 × 约 16 个会话，默认约 450 个会话；布局为
  `eval_output/demo_data/<model>/...`。
- 任务、子任务、意图、答案形态四层 `cluster_tree.json`，每个分支节点保留会话数和条目数；
  每个维度最多展示 8 个主要分支，长尾自动合并为“其他”。
- 样本包含 `intent`、`answer_type`、`cluster_path`，从第 4 级聚类查看样本时会按完整路径过滤。
- 日期取「今天 − 14 … 今天 − 1 天」，让 freshness 判定为新鲜，预测卡片也有历史可算。

可用 `--wencai-per-day` / `--aime-per-day` 调整每个模型每天的会话量，例如：

```bash
python3 local_dev/make_demo_dataset.py --out local_dev/datasets \
  --wencai-per-day 48 --aime-per-day 32
./local_dev/refresh.sh
```

夹具由 `make_demo_dataset.py` 生成，每次运行会清空目标目录重建；它不是真实评测数据，
不要提交。产物路径 `local_dev/datasets/` 已加入 `.gitignore`。
