# Portable Eval Harness (`eval_harness_pkg`)

自包含的归因评测与数据清洗模块：内部已打包完整的评测引擎、提示词与 Schema，无第三方 Python 依赖，可直接复制目录或作为 Python 包被其他项目引用。

## 运行环境

- **Python** `>= 3.10`（不依赖 PyYAML 等外部库）
- **Node.js** `>= 22.19`（可用环境变量 `EVAL_NODE_BIN` 指定可执行路径）

## 快速开始

```bash
cp config.example.yaml config.yaml   # 填入 API 端点、输入路径、输出路径
python prepare_eval.py -c config.yaml
python run_eval.py -c config.yaml
python human_read_eval.py -c config.yaml
```

## 最小配置（`config.yaml`）

只需提供 3 项核心配置（数据清洗时额外指定 `prepare.raw_input`）；相对路径均基于 `config.yaml` 所在目录解析，支持 `${ENV_VAR}` 展开。完整选项见 [config.example.yaml](config.example.yaml)。

```yaml
api:
  base_url: "https://your-gateway.example.com/v1"  # OpenAI Responses 协议端点
  model: "gpt-5.4"
  api_key_env: "OPENAI_API_KEY"                    # 或直接填写 api_key

input: "./data/eval_input.jsonl"                   # 待评测输入 JSONL（文件或目录）
output: "./data/eval_output.jsonl"                 # 评测结果输出 JSONL

prepare:
  raw_input: "./data/raw.jsonl"                    # 原始数据（.jsonl / .gz / .zst / 目录）
```

## 数据清洗（`prepare_eval.py`）

将原始轨迹清洗为可直接评测的标准 JSONL：

1. 自动读取 `.jsonl` / `.jsonl.gz` / `.jsonl.zst`（单文件或目录），去除 BOM、空行与非法行。
2. 拆分多 trace session（可配置）、修复缺失的 `user_question`、对齐主仓库规则规范化单 trace 多轮过期/占位符/转录 dump 问句与内部 `--- ---` 包装块，并从日期文件名或配置补齐 `batch_id`。
3. 复用内置评测引擎的准入校验规则过滤不合格样本，可选输出 `audit_output` 审计明细，并执行无损瘦身（`slim`）。

常用参数：`--raw-input`、`--output`、`--audit`、`--no-slim`、`--verify`、`--fail-on-reject`。

## 执行评测（`run_eval.py`）

- 支持单轮扁平 `messages`（A / B 两种轨迹格式）及多轮 `traces` 会话 JSONL。
- 通过 OpenAI Responses API 执行归因评测，逐条追加写入 `output` 指定的 JSONL 文件（每条样本一行归因结论）。
- **断点续跑**：默认开启 `resume: true`，重跑相同命令会自动修补尾部截断行并跳过 `output` 中已完成的样本；传入 `--no-resume` 可清空重评。

常用参数：`--limit N`（冒烟测试）、`--concurrency N`、`--no-resume`、`--fail-on-reject`、`-q`。

## 后置人话翻译（`human_read_eval.py`）

- 完全后置、零侵入原评测输出文件；默认读取 `output`（及可选 `execution.compact_output`）并结合 `input` 生成镜像翻译结果与 `.state/state.sqlite3`（WAL 索引）到 `<output_dir>/human_read`（可通过 `human_read.output_root` 指定）。
- 可单独在 `config.yaml` 的 `human_read:` 段配置便宜高速模型（默认使用 `openai-completions` 协议，也可通过 `human_read.api` 切换为 `openai-responses`），也可直接继承顶层 `api:`；支持目录模式（`human_read.source_dir` + `human_read.input_dir`）。
- 常用参数：`--limit N`、`--workers N`、`--rpm N`、`--retry-failed`、`--status`、`-q`。

## 移植与其他项目集成

**方式一：直接复制整个目录**

将 `eval_harness_pkg/` 复制到任意项目即可直接运行 `python eval_harness_pkg/run_eval.py -c config.yaml`，无需 `npm install` 或额外构建。

**方式二：作为 Python 包安装或导入**

```bash
pip install ./eval_harness_pkg          # 安装后亦可使用 eval-prepare / eval-run / eval-human-read 命令
```

```python
from eval_harness import prepare_eval, run_eval, human_read_eval, human_read_status

prep_report = prepare_eval("config.yaml")
eval_summary = run_eval("config.yaml", limit=20)
hr_summary = human_read_eval("config.yaml")
hr_counts = human_read_status("config.yaml")
```

也可直接传 `dict` 作为配置，无需落盘 YAML 文件。

## 退出码

| 退出码 | 含义 |
| --- | --- |
| `0` | 全部成功（输出 JSON 汇总至 stdout） |
| `2` | 存在失败样本，或开启 `--fail-on-reject` 且存在被拒样本 |
| `1` | 配置错误、运行环境不满足或引擎异常 |
| `130` | 收到 `SIGINT` 中断（已完成结果已安全落盘，可直接续跑） |
