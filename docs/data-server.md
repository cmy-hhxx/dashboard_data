# 弗吉尼亚数据服务器（AIME）

AIME 的评测数据、看板、页面接口和供数接口都在弗吉尼亚这一台容器里。本文记录它的目录、数据集、
字段、端口、构建与刷新流程和常见坑；数字是 2026-11-13 的实测快照，以服务器上的实际文件为准。
问财（乌兰察布）的部署见 [dashboard-deployment.md](dashboard-deployment.md)，接口用法见 [接口使用指南.md](接口使用指南.md)。

**本文不记录任何密钥。** SSH 私钥只放在本机，`~/.ssh/config` 里用 `IdentityFile <本机私钥路径>` +
`IdentitiesOnly yes` 引用，私钥文件权限必须是 `600`（否则 ssh 拒绝使用）。

## 1. 主机与端口

| 项 | 值 |
|---|---|
| 主机 | `10.217.219.2`，SSH 对外端口 `2473`（容器 22），用户 `root` |
| 容器 | `interactive-s3ynzadcvm9c`（2026-11-16 容器重置后改名，旧名 `interactive-npasm9ch66eb` 作废）；6 核、约 2 TB 内存、根盘 1.7 TB |
| 连接方式 | 必须复用 SSH 长连接（`ControlMaster auto` + `ControlPersist`），频繁新建连接会被拒，见 dashboard-deployment.md |

| 容器端口 | 对外端口 | 角色 | 部署目录 |
|---|---|---|---|
| 5001 | 2475 | 看板（生产） | `/opt/eval_dashboard` |
| 5002 | 2476 | 页面接口（样本详情 / 版本对比 / 问题矩阵，反代 5001） | `/opt/page_service` |
| 5003 | 2477 | 供数接口（`/api/v1/analysis/*`） | `/opt/eval_analysis` |
| 5004 | 2478 | 开发调试（看板预发，`STATS_WORKER=0`） | `/opt/eval_dashboard_2` |
| 5005 | 2479 | 备用（临时静态服务） | — |

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

### 补 task_category / subtask_category（`scripts/aime_backfill_category.py`）

上游采集器按天把上线埋点回填到 `0_litefusion_data/online_data/<Y>/<M>/<D>/category_meta.json`
（`{trace_id: {task_category, subtask_category, user_id, run_started_at, ...}}`），**没有**日期就没有该文件
（说明那天还没回填）。评测流水线不会把这些字段带进输入/归因，所以由脚本补：

```bash
python3 scripts/aime_backfill_category.py              # 笔记本上跑，自动 ssh 到弗吉尼亚
python3 scripts/aime_backfill_category.py --local      # 服务器上跑
python3 scripts/aime_backfill_category.py --dry-run    # 只统计，不落盘
python3 scripts/aime_backfill_category.py --force      # 忽略「文件和分类源都没变」的跳过缓存
```

服务器副本 `/mnt/aime_eval_ssd/code/3_scripts/backfill_category.py`；跳过缓存落在
`code/3_scripts/cache/aime_backfill_category/`（`state.json` 记 size/mtime + 分类源**内容哈希**指纹，
删掉即全量重扫）。上游采集器会整文件重写这些 meta（内容可能一模一样，例如 2026-11-20 10:31~10:35
一次性重写了 02~16 号），所以指纹按内容算：没变就 0.5 s 跳过，真变了才重扫 16 GB（约 2~4 分钟）。

口径（都踩过坑，别改）：

- **索引取所有日期的并集**，不是只取同一天：输入文件会被跨天合并重写（11-12/11-13 合并过），
  归因按「评测日」归档而不是 trace 日归档。并集比同日高 13~40 个百分点，跨日期 0 冲突。
- **输入侧认顶层 `trace_id`（行尾那个）**：2026-11-09 之前的旧行里 `meta.trace_id` 写的是 `thread_xxx`（session id），
  拿它去查一定查不到。
- **归因按会话判定**：取该行所有 `turns[].meta.trace_id` 的分类，**一致才填**，不一致留空（不猜）。
  旧归因的 `session_meta.trace_id` 同样是 `thread_xxx`。
- 查不到埋点的记录保持 `null`；只写目标对象里的两个字段，其余字节不动（临时文件 + fsync + `os.replace`），
  每条改完的行走一遍 `json.loads` 校验。
- 写完要把 `1_slim_publish/state/state.sqlite3` 的 `target_files` 里该文件的 `(size, mtime, offset)`
  同步成新值（offset = 新 size）：它按 offset==size 记账，不同步的话下一轮会把文件中段当成「新增尾巴」重扫。
- 分类体系漂移：2026-11-04 及之前是旧短标签（`事件解读` / `诊断分析类` / `交易建议` …），
  2026-11-08 起是新长标签（`投资标的研究与分析` / `市场、宏观与行业研究` …），看板场景会同时出现两套。
- 重写会让 `build.py` 按 `(size, mtime_ns)` 重扫这些文件，一次全量重建约 10 分钟（16 GB）。
  原地重写不会被误判成「追加」：索引另存 `files.tail`（旧 committed 前 64 KB 的哈希）
  判断追加还是重写，见 `docs/build-performance.md` §3.1；错位索引导致的
  `samples/<slug>.json` 404 会在下一轮构建自动修好。

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

看板的 `abtests-aime.json` 与版本对比页都从这里构建；只认这一种布局（缺 `02_before_release` 等 scope 目录的文件夹不算轮次）。

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

- **容器重置后缺 `tzdata`**：新容器没有 `/usr/share/zoneinfo`，`daytime.py` 里 `ZoneInfo("America/New_York")` 会抛
  `ZoneInfoNotFoundError`，`server.py` 与 `stats_worker.py` 启动即崩、只有 `backup_stats.py` 活着（它不 import daytime）。
  `dashboard/deploy.sh` 现在会在重启前探测并 `pip install tzdata`；手工救急：`python3 -m pip install tzdata` 后 `./start.sh`。
- **SSH 被拒**：没有复用长连接、或私钥权限不是 600。
- **ceph / SSD 上的 rglob 很慢**：全量列输入文件要 20 s 以上；服务启动时后台预热文件清单，别在请求线程里扫。
- **mtime 与时钟**：文件 mtime 取内核粗粒度时钟，可能比 `time.time_ns()` 落后一个 tick（4–10 ms）。
  用「文件 mtime ≥ 某时间戳」判新鲜度时要留余量，否则刚写的文件会被当成过期反复重建。
- **并发构建**：历史上部署构建与定时构建同时写 `cache/build.sqlite3` 出现过 `database is locked`；现在由 `cache/build.lock` 排队。
- **只读备份目录**：`0_daily_eval-pre-split-*` 是拆分前备份，任何扫描都不要把它算进来。
- **测试账号**：真实 userid = 纯数字且 ≤10 位（业务方 2026-11-17）；其余（英文名 / 内部号 / ≥11 位数字）整条不供数，看板 `ut` 与 5003 同一口径。位数上限在 `user_rules.json` 的 `heuristics.real_user_id_max_digits`（默认 10），`test.ids` 可显式指定、`real.ids` 可捞回；改口径后重建一次，用 `/healthz` 的 `build.test_excluded` 核对条数。
- **问句字段漂移**：归因 `session_meta` 的问句在 2026-11-11 起从 `question` 改名 `question_text`，个别文件两种混写（输入侧两种都有）。
  5003 索引按 `question or question_text` 取值；只读 `question` 会让 `query_preview` 变空串。
- **改了 5003 的入库解析逻辑，要让已有归因文件重扫**：删掉对应 `files` 行再重启构建，只重扫这些文件：
  `DELETE FROM files WHERE kind='attribution' AND path IN (...)`。不要清 `traces`（`ensure_schema` 那套会丢掉旧状态，变更流会把全量当新增重放）。
- **部署记录**：生产上的 `logs/deployed-revision.json` 是一次手工发布留下的（仓库脚本不写它），2026-11-13 时仍停在 a3a559c，
  而实际代码已与 main 一致；判断线上版本请比对文件哈希。
