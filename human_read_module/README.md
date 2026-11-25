# human_read_module

> **弗吉尼亚已不再运行本模块**：翻译服务由其他同事维护，本目录仅保留源码参考。
> 译文数据仍在 `/mnt/aime_eval_ssd/1_aime/eval_output/human_read/`，由外部服务持续更新；
> 看板 5001 只读叠层展示，**禁止删除或清理该目录**。以下命令仅适用于其他部署环境。

AIME 评测输出（`attribution.jsonl` 与 `compact.jsonl`）的**人话同义翻译层**与定时增量回刷服务。

## 设计原则

- **零侵入原文件**：绝不修改 `/mnt/aime_eval_ssd/1_aime/eval_output/0_daily_eval` 或 `ab_test/` 下的任何原始文件。
- **同结构镜像存储**：翻译结果统一落盘到 `/mnt/aime_eval_ssd/1_aime/eval_output/human_read/`，目录结构与原文件一致，仅替换白名单展示文本字段，并在 `.state/state.sqlite3`（WAL 模式）维护 O(1) 字节偏移索引。
- **严格同义保真**：
  - 冻结字段（`evidence`、`severity`、`component*`、`session_meta`、`trace_meta`、`components_name/kind`）代码层深拷贝隔离，不交给模型改写；
  - 结合配对的 `eval_input` 精准抽取「用户问题 + 最终回答 + 证据命中片段」补齐裸数字指标名；
  - 三层硬护栏（结构隔离 + 数值/日期/单位等价校验 + 失败安全跳过回退原版）。
- **增量顺序**：按 `0_daily_eval` **日期从新到旧**回刷（可选 `--include-ab` 同步覆盖 `ab_test/`），按白名单原文本指纹去重，免疫上游追加与元数据回填重写。

## 动态热配置（改完 5 秒内生效，无需重启）

配置文件位于：`/mnt/aime_eval_ssd/1_aime/eval_output/human_read/.state/runtime_config.json`

```json
{
  "target_rpm": 40,
  "workers": 16,
  "paused": false
}
```

- `target_rpm`：每分钟请求上限，修改后 **5 秒内热生效**；
- `paused`：设为 `true` 立即暂停发请求，改回 `false` 自动恢复；
- `workers`：线程上限，在切换到下一个文件时自动生效。

## 常用命令（仅其他部署环境；弗吉尼亚不适用）

```bash
# 以下 <部署根目录> 指实际的 human_read_module 上级目录
# 查看当前翻译进度
cd <部署根目录> && python3 -m human_read_module.runner --status

# 单次小批量试跑（例如最新日期前 20 条）
cd <部署根目录> && python3 -m human_read_module.runner --workers 8 --limit 20

# 启动/停止后台守护回刷（默认 8 并发，每 600s 复扫增量，含 ab_test）
<部署根目录>/human_read_module/start.sh
<部署根目录>/human_read_module/stop.sh
```

网关 key 不进仓库：放在部署根目录的 `human_read.env`（`chmod 600`），
`start.sh` 启动前自动 source；本地手动跑 `runner.py` 时设置 `HUMAN_READ_API_KEY` 环境变量。
