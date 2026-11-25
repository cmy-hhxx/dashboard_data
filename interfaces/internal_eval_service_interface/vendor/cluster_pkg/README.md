# `cluster_pkg` — 可移植归因聚类服务模块

将归因问题条目聚成可下钻、可回溯、可增量演进的三轴四层聚类树（12 环节 × 7 机制 × 叶子 + L4 子类）。

- **零依赖自包含**：纯 Python ≥ 3.9 标准库可运行（自动按需启用 `PyYAML` / `Pillow`），内置完整分类法与提示词。
- **自适应演进**：未知 `component` 自动路由责任段（`S1`–`S12`）；无法覆盖的新模式经 `path_repair` 重问仍为 `NONE` 时自动归纳新 L3 叶子，通过 `taxonomy_lint`（`errors=0`）门禁后落盘并记录于 `taxonomy_evolution.jsonl`。
- **原子增量**：传入既有 `tree_dir` 按 `(trace_id, problem_index)` 复用历史判定，仅对新增条目调模型；临时目录通过 `verify`（`errors=0, locator_mismatch=0`）后再原子替换。

## 1. 最小配置与命令行

创建 `config.yaml`（完整选项见 [config.example.yaml](config.example.yaml)）：

```yaml
api:
  base_url: "http://10.217.220.51/ai-gateway/v1"  # 支持 .../v1 或 .../v1/responses 或列表
  api_key: "${EVAL_GATEWAY_API_KEY}"
  model: "deepseek-v4.1-flash"
tree_dir: "./cluster_tree"                        # 首次为空自动初始化
input: "./data/attribution"                       # 单个 .jsonl 或目录
```

```bash
python /path/to/cluster_pkg/run_cluster.py -c config.yaml          # 或 python -m cluster_pkg -c config.yaml
python /path/to/cluster_pkg/run_cluster.py -c config.yaml --recall S9.M6.4 --limit 5
```

## 2. Python 集成与离线安装

直接复制目录 / 加入 `PYTHONPATH`，或离线安装：`pip install --no-index --no-build-isolation /path/to/cluster_pkg`（提供 `cluster-run` 命令）。

```python
from cluster_pkg import run_cluster
result = run_cluster("config.yaml")          # 也支持直接传 config dict 或内存 records 列表
print(result["total_items"], result["created_leaves"])
```

## 3. 输入格式兼容

自动识别两种 JSONL：
1. **标准多轮归因**：`{"session_meta": {...}, "turns": [{"meta": {"trace_id": "t1"}, "problem": [{"problem_id": "p1", "component": "...", "severity": "P1", "label": "...", "definition": "...", "reason": "..."}]}]}`
2. **扁平单行**：`{"trace_id": "t1", "session_id": "s1", "component": "...", "severity": "P1", "label": "...", "definition": "...", "reason": "...", "question": "..."}`

## 4. 输出产物（`tree_dir`）

| 文件 / 目录 | 说明 |
|---|---|
| `cluster_brief.md` / `cluster_summary.md` | 一页业务摘要 / 完整环节、机制、横切标签与 L4 报告 |
| `cluster_tree.json` / `.txt` | 结构化聚类树与文本树 |
| `item_index.jsonl` / `leaves.tsv` | 全量归属索引（增量基线）与叶子统计表 |
| `syndrome.json` / `.md` | 会话级失效机制共现分析 |
| `cluster_matrix.svg` / `.png` | 环节 × 机制热力图 |
| `verify.json` / `MANIFEST.json` | 完整性自检报告与哈希清单 |
| `taxonomy/` · `taxonomy_evolution.jsonl` | 绑定分类法副本与自适应扩充审计账本 |

## 5. 自检测试

```bash
python3 -m unittest discover -s cluster_pkg/tests -p "test_*.py" -v
```
