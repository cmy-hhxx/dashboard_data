# human_read_module

AIME 评测输出（`attribution.jsonl` 与 `compact.jsonl`）的**人话同义翻译层**与定时增量回刷服务。

## 设计原则

- **零侵入原文件**：绝不修改 `/mnt/aime_eval_ssd/1_aime/eval_output/0_daily_eval` 或 `ab_test/` 下的任何原始文件。
- **同结构镜像存储**：翻译结果统一落盘到 `/mnt/aime_eval_ssd/1_aime/eval_output/human_read/`，目录结构与原文件一致，仅替换白名单展示文本字段，并在 `.state/state.sqlite3`（WAL 模式）维护 O(1) 字节偏移索引。
- **严格同义保真**：
  - 冻结字段（`evidence`、`severity`、`component*`、`session_meta`、`trace_meta`、`components_name/kind`）代码层深拷贝隔离，不交给模型改写；
  - 结合配对的 `eval_input` 精准抽取「用户问题 + 最终回答 + 证据命中片段」补齐裸数字指标名；
  - 三层硬护栏（结构隔离 + 数值/日期/单位等价校验 + 失败安全跳过回退原版）。
- **增量顺序**：按 `0_daily_eval` **日期从新到旧**回刷（可选 `--include-ab` 同步覆盖 `ab_test/`），按白名单原文本指纹去重，免疫上游追加与元数据回填重写。

## 常用命令（弗吉尼亚 `/opt/human_read_service`）

```bash
# 查看当前翻译进度
cd /opt/human_read_service && python3 -m human_read_module.runner --status

# 单次小批量试跑（例如最新日期前 20 条）
cd /opt/human_read_service && python3 -m human_read_module.runner --workers 8 --limit 20

# 启动后台守护回刷（默认 8 并发，每 600s 复扫增量，含 ab_test）
/opt/human_read_service/human_read_module/start.sh

# 停止后台守护
/opt/human_read_service/human_read_module/stop.sh
```

网关 key 不进仓库：放在服务器 `/opt/human_read_service/human_read.env`（`chmod 600`），
`start.sh` 启动前自动 source；本地手动跑 `runner.py` 时设置 `HUMAN_READ_API_KEY` 环境变量。
