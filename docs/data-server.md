# 弗吉尼亚数据服务器（AIME）

AIME 的评测数据、看板、页面接口和供数接口都在弗吉尼亚这一台容器里。本文记录它的目录、数据集、
字段、端口、构建与刷新流程和常见坑；数字是 2026-11-13 的实测快照，以服务器上的实际文件为准。
问财（乌兰察布）的部署见 [dashboard-deployment.md](dashboard-deployment.md)，接口用法见 [接口使用指南.md](接口使用指南.md)。

**本文不记录任何密钥。** SSH 私钥只放在本机，`~/.ssh/config` 里用 `IdentityFile <本机私钥路径>` +
`IdentitiesOnly yes` 引用，私钥文件权限必须是 `600`（否则 ssh 拒绝使用）。

## 1. 主机与端口

| 项 | 值 |
|---|---|
| 主机 | `10.217.219.2`，SSH 对外端口 `2225`（容器 22），用户 `root` |
| 容器 | `interactive-npasm9ch66eb`；6 核、约 2 TB 内存、根盘 1.7 TB |
| 连接方式 | 必须复用 SSH 长连接（`ControlMaster auto` + `ControlPersist`），频繁新建连接会被拒，见 dashboard-deployment.md |

| 容器端口 | 对外端口 | 角色 | 部署目录 |
|---|---|---|---|
| 5001 | 2221 | 看板（生产） | `/opt/eval_dashboard` |
| 5002 | 2222 | 页面接口（样本详情 / 版本对比 / 问题矩阵，反代 5001） | `/opt/page_service` |
| 5003 | 2224 | 供数接口（`/api/v1/analysis/*`） | `/opt/eval_analysis` |
| 5004 | 2228 | 开发调试（看板预发，`STATS_WORKER=0`） | `/opt/eval_dashboard_2` |
| 5005 | 2243 | 备用（临时静态服务） | — |

守护：`/opt/eval_supervisor.sh` 按 `/opt/eval_services.conf`（每行 `name|health_url|workdir|start_cmd`）
每 30 s 探活，`/healthz` 不应答才重启；`/opt/eval_supervisor.pause` 存在时跳过检查（维护窗口用，用完要删）。

## 2. 数据根 `/mnt/aime_eval_ssd`

看板、页面、供数都以 `EVAL_DATASETS=/mnt/aime_eval_ssd`、`EVAL_PRODUCTS=aime` 运行（写在各部署目录的 `deploy.env`）。
旧 HDD `/mnt/fin_bench/aime_rsi_data` 已不再提供 `1_aime`，不要再指向它。

```text
/mnt/aime_eval_ssd/
  1_aime/
    eval_input/                     评测输入（约 270 GB，含 .archive）
      0_daily_eval_input/<model>/<date>.jsonl     每日输入；同目录 status.json 记录每个文件的处理进度
      0_daily_eval_chunks/<model>/<date>/…        输入分块（评测流水线的工作区）
      2_task_eval/                                专项任务输入
      .archive/                                   归档（流失用户输入在 .archive/1_lost_user_input）
    eval_output/                    评测输出（0_daily_eval 约 15 GB）
      0_daily_eval/<model>/<model>_attribution-<date>.jsonl         归因（一行一个会话）
      0_daily_eval/<model>/compact/<model>_compact-<date>.jsonl     压缩轨迹
      0_daily_eval/{expert,fast}_stats.json, stats.json             输出侧统计
      0_daily_eval-pre-split-<时间戳>/                              拆分前的备份，看板不读
      cluster/<model>/              聚类：cluster_tree.json、item_index.jsonl、leaves.tsv、MANIFEST.json、syndrome.*
      2_task_eval/                  专项任务输出（如 0_lost_user_back_test）
    ab_test/<n>_version<MMDD>_test/ A/B 轮次（约 5 GB），见第 4 节
    stats/<UTC 时间戳>/             backup_stats.py 的每小时快照，保留 12 份
  stats.json                        stats_worker.py 写的输入侧统计旁路（加速器，非正确性依赖）
  user_rules.json                   用户类型与流失名单规则（dashboard/user_rules.py 读取）
  0_litefusion_data/、2_test_evals/、code/   其他项目与评测代码，看板不读
```

`<model>` 目前是 `aime_expert`、`aime_fast`；`<date>` 是 `YYYY-MM-DD`。预测数据目录 `4_forecast/` 在弗吉尼亚不存在，
所以 AIME 的预测卡显示「暂无预测数据」。

## 3. 字段

只列看板与接口用到的字段；完整定义以评测流水线为准。

**评测输入**（`0_daily_eval_input/<model>/<date>.jsonl`，一行一个会话快照）

- 顶层：`request_time`、`batch_id`、`case_id`、`version(s)`、`has_standard_answer`、`trace_id`、`traces[]`、`_source`、`meta`
- `meta`：`session_id`、`trace_id`、`user_id`、`request_time`、`question_text`、`input_type`、`source`、`comefrom`、
  `runtime_mode`、`status`、`outcome`、`task_category` / `subtask_category`、`skill_names_text`、`tool_names_text`、
  `tool_count`、`turn_index`、`total_tokens`、`total_duration_ms`、`first_token_ms`、`device_type`、`n_messages` 等

**归因**（`<model>_attribution-<date>.jsonl`）

- `session_meta`（同输入 `meta`，另有 `fill_source`、`parent_trace`、`agent_name`）+ `turns[]`
- `turns[]`：`meta`、`summary`、`problem[]`、`is_correct`、`correct_reason`
- `problem[]`：`label`、`definition`、`problem_phenomena`、`reason`、`severity`（P0 最重 → P4 提示级）、
  `severity_reason`、`evidence`、`component`、`component_family`、`component_role`

**压缩轨迹**（`compact/<model>_compact-<date>.jsonl`）：`session_meta`、`trace_meta`、`turns`；`evidence_id` 里的消息下标是整场扁平
trace 的全局下标（换算见 handoff.md「容易踩的坑」）。

**聚类**（`cluster/<model>/`）：`cluster_tree.json` 是阶段 → 环节 → 机制 → 模式树（4.4+）；`item_index.jsonl` 用
`turn_index` / `problem_index` 把问题条目挂到叶子上。

配对规则：输入与归因按 `(session_id, request_time)` 配对，key 不匹配时按 `trace_id` 回退；不补造缺失内容。

## 4. A/B 轮次 `ab_test/<n>_version<MMDD>_test/`

```text
round.json                         {"released_at", "label", "title"}
00_manifest/coverage_*.csv         每个目标题在各口径的覆盖；summary.json、scope_summary.json
01_targets/questions.jsonl         固定题集
02_before_release/                 改版前：attribution/、cluster_tree/、inputs/
03_after_release_retest/           改版后同题重测：同上
04_after_release_online_real/      改版后线上真实用户：attribution/、cluster_tree/
05_compare/                        基线对比表
99_provenance/                     重测输入与运行记录
```

看板的 `abtests-aime.json` 与版本对比页都从这里构建；旧布局（`coverage.csv`、`03_cluster_*`、`04_retest_after`）仍兼容读取。

## 5. 看板构建与刷新

| 环节 | 说明 |
|---|---|
| 进程 | `/opt/eval_dashboard` 下 `server.py`（5001）、`stats_worker.py`、`backup_stats.py`，由 `start.sh` 拉起 |
| 定时构建 | `server.py` 每 `REFRESH_SECONDS`（默认 600 s）跑 `nice build.py --keep-on-empty`；超时 1800 s 连同 worker 进程组一起结束 |
| 互斥 | 构建持有 `cache/build.lock`（flock）：定时构建、部署构建、手动构建排队执行，不并发写产物与 `cache/build.sqlite3` |
| 增量 | 输入文件按 `(size, mtime_ns)` 只扫变化部分，配对与样本摘要存 `cache/build.sqlite3`；数据没变时复用上一份 payload |
| 产物 | `static/` 下 `data.json`、`data-aime.json`、`samples-aime.json`、`labels-aime.json`、`trends-aime.json`、`abtests-aime.json`，各带 `.gz` / `.br` |
| 详情 | `/samples/<slug>.json`、`/ab_samples/<round>/<eq>.json` 首次打开时按需生成并缓存在 `static/samples/`、`static/ab_samples/` |
| 缓存 | `cache/`（约 4.6 GB）：`build.sqlite3`、`samples.pkl`、`clusters-v3-*.pkl`、`prewarm.json`、`inputs/`、`ab-details/`；删掉会触发全量重建 |
| 页面刷新 | 前端每 2 分钟条件请求 `data.json`，`generated_at` 变了才换数据 |

2026-11-13 的 payload 体积（原始 / br / gz）：

| 文件 | 原始 | br | gz | 首屏 |
|---|---|---|---|---|
| `data-aime.json` | 17.6 MB | 3.3 MB | 4.7 MB | 是（其中 `field` 8.4 MB、`cross` 7.8 MB） |
| `trends-aime.json` | 9.8 MB | 2.6 MB | 2.7 MB | 空闲时预取（其中 `trace_severity.refs` 6.6 MB） |
| `samples-aime.json` | 44.9 MB | 8.6 MB | 11.6 MB | 样本页 |
| `labels-aime.json` | 16.2 MB | 4.2 MB | 5.1 MB | 样本页搜索时 |
| `abtests-aime.json` | 3.0 MB | 0.5 MB | 0.8 MB | A/B 面板 |
| `data.json` | 0.1 MB | — | — | 是 |

浏览器经 http 访问只拿 gzip（br 只在 https 下协商）。

## 6. 发布与验证

- 发布：本机执行 `dashboard/deploy.sh`（rsync 代码 → 预压缩静态资源 → 重启），参数见 dashboard-deployment.md；
  rsync 排除所有构建产物（`static/*.json*`、`static/samples` 等）与 `cache/`、`logs/`、`deploy.env`。
- 预发：`EVAL_DEPLOY_REMOTE=/opt/eval_dashboard_2 PORT=5004 STATS_WORKER=0 ./dashboard/deploy.sh`，对外 `:2228`。
- 测试：把仓库同步到服务器后执行 `scripts/run_tests.sh`（构建类用例较重，不在笔记本上跑）。
- 健康：`curl -s 127.0.0.1:5001/healthz`，看 JSON 里的 `ok`、`running`、`error`、`build`（状态码恒为 200）。

## 7. 常见坑

- **SSH 被拒**：没有复用长连接、或私钥权限不是 600。
- **ceph / SSD 上的 rglob 很慢**：全量列输入文件要 20 s 以上；服务启动时后台预热文件清单，别在请求线程里扫。
- **mtime 与时钟**：文件 mtime 取内核粗粒度时钟，可能比 `time.time_ns()` 落后一个 tick（4–10 ms）。
  用「文件 mtime ≥ 某时间戳」判新鲜度时要留余量，否则刚写的文件会被当成过期反复重建。
- **并发构建**：历史上部署构建与定时构建同时写 `cache/build.sqlite3` 出现过 `database is locked`；现在由 `cache/build.lock` 排队。
- **只读备份目录**：`0_daily_eval-pre-split-*` 是拆分前备份，任何扫描都不要把它算进来。
- **测试用户**：5002 / 5003 对外数据会去掉测试用户行（规则见 `user_rules.json`）；看板内部仍保留并可筛选。
- **部署记录**：生产上的 `logs/deployed-revision.json` 是一次手工发布留下的（仓库脚本不写它），2026-11-13 时仍停在 a3a559c，
  而实际代码已与 main 一致；判断线上版本请比对文件哈希。
