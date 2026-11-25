# 看板开发交接

## 1. 启动与验证

```bash
./dashboard/local_dev/start.sh      # 重建并监听 http://127.0.0.1:5001/
./dashboard/local_dev/refresh.sh    # 数据更新后重建（EVAL_DATASETS 可覆盖数据源）
./dashboard/local_dev/stop.sh
curl -s http://127.0.0.1:5001/healthz
scripts/run_tests.sh dashboard      # 建议在服务器上跑
for f in dashboard/static/js/*.js; do node --input-type=module --check < "$f" || break; done
```

前端无打包器（原生 ES Modules + 手写 CSS + 内置 `vendor/lightweight-charts`），改完 `static/` 直接刷新；验收覆盖 问财/AIME × 亮暗色 × 1440/1024/390。

## 2. 数据流与构建机制

```text
datasets/ ─┬─> stats_worker.py ──> datasets/stats.json（输入统计旁路，按 size+mtime 校验）
           └─> build.py（cache/build.sqlite3 增量索引 + cache/build.lock 互斥）
                 ├─ static/data.json + data-<product>.json         共享壳 / 单产品聚合
                 ├─ static/samples.json + samples-<product>.json   产品清单 / 召回索引（不含 lb）
                 ├─ static/labels-<product>.json                   问题标签（与 rows[] 同序）
                 ├─ static/trends-<product>.json                   聚类矩阵趋势（懒加载）
                 └─ static/abtests-<product>.json                  A/B 对比（存在 ab_test/ 时生成）
server.py (:5001，定时刷新) ──> 静态服务 + /samples/<slug>.json & /ab_samples/ & /gpt_samples/ 按需懒生成
```

- **数据源分工**：问财（乌兰）只读 `0_wencai/eval_input/2_rsi_input` 与 `eval_output/2_rsi_eval`（聚类取 `cluster/<model>/total/`，日期按 `Asia/Shanghai`）；AIME（弗吉尼亚）只读 `/mnt/aime_eval_ssd/1_aime`（日期按 `America/New_York`）。
- **人话译文**：翻译服务已迁出弗吉尼亚，`1_aime/eval_output/human_read/` 由外部服务持续维护；看板只读叠层（`human_read_overlay.py`），按 sqlite/文件 mtime 自动刷新，**不要删除该数据目录**。
- **增量与缓存**：输入/输出/compact 按 `(size, mtime_ns)` + `files.tail`（旧 committed 前 64 KB 哈希）区分追加与原地重写；样本摘要按行哈希缓存于 `cache/build.sqlite3` + `cache/samples.pkl`（分块写出），cluster 变化只重映射 `cl` 不重读输入；全量无变化走亚秒复用路径。
- **内存保护**：`build.py` 的 `capped_workers` 按容器 cgroup 剩余内存自动降级并发（16 GiB 容器中自动退回串行，避免 fork OOM 卡死 `build.lock`）；摘要仅保留 payload 消费字段（`slim_parts`）。
- **版本升级**：改 detail 结构必须 bump `build_store.BUILD_VERSION`；改聚合结构必须 bump `build.py` 的 `PAYLOAD_VERSION`；改配对/聚类缓存口径同步 bump 对应 `*_VERSION`。

## 3. 核心文件地图

| 模块 | 路径 | 职责 |
|---|---|---|
| 构建与索引 | `build.py`, `build_store.py`, `filelist.py`, `json_compat.py` | 扫描、配对、聚合、增量 SQLite 索引、payload 生成 |
| 懒详情与监控 | `detail_builder.py`, `ab_detail.py`, `human_read_overlay.py`, `speed_monitor.py` | 样本/AB 详情按需生成、外部人话译文只读叠层、AIME 评测速度采集 |
| 服务与旁路 | `server.py`, `stats_worker.py`, `backup_stats.py`, `user_rules.py` | HTTP 服务、定时刷新、输入统计旁路、备份、用户规则 |
| 前端入口与通用 | `static/js/app.js`, `core.js`, `render.js`, `pixel_toggle.js` | 路由、站点切换、条件刷新、Markdown/JSON 渲染、主题切换 |
| 数据与趋势 | `static/js/data.js`, `sunburst.js`, `galaxy.js`, `kline_data.js`, `kline_chart.js`, `trend_chart.js` | 2+3 Bento、推拉布局、聚类矩阵、K 线/多线趋势、星图 |
| A/B 与对比 | `ab_test.py`, `static/js/abtest.js`, `compare.js` | A/B 轮次聚合、3D 翻转面板、改版前/后/GPT 三栏对比与核验 |
| 体系与样本 | `static/js/system.js`, `evidence_theater.js`, `samples.js`, `sample_detail.js` | 体系页与证据剧场、样本召回工作台与详情工厂（samples/compare 共用） |
| 独立页面服务 | `page_service/{sample_details,problem_matrix,compare_details,page_proxy.py}` | 5002 只读反代与展示态裁剪（`matrix=1` / `compare=1`） |

## 4. 关键数据契约

- **召回与标签拆分**：`samples-<product>.json` 的 `rows[]` 不含 `lb`，前端/业务方按行号与 `labels-<product>.json` 配对；详情仅在选中后请求 `/samples/<slug>.json`。
- **聚类矩阵与趋势**：矩阵与 `trends-<product>.json` 均按 **trace 口径**计数；`cells` 含 `p0..p4`、`h0..h4`、`hAny` 及 `(mask, count)` 稀疏直方图，多选等级按位交集精确求并集。发版日配置优先读 `<datasets>/releases.json`，兜底 `dashboard/config/releases.json`。
- **A/B Test 轮次**：仅识别 `ab_test/<n>_version<MMDD>_test/`（含 `round.json`、`00_manifest/coverage_*.csv`、`01_targets/`、`02_before_release/`、`03_after_release_retest/`、`04_after_release_online_real/`、可选 `06_verify/verify.jsonl` 与 `07_gpt_answer/`）。`sides/leaves/nodes/matrix` 四处不可用时必须同源为 `null`，禁止用 `{}`/`[]` 占位；线上批次独立展示，不与固定题集相减。
- **用户规则**：`<datasets>/user_rules.json` 定义真实用户（纯数字 ≤ 10 位）、`test/real` 覆盖名单与 `lost.ids` 流失名单；规则哈希进入构建签名，变更后自动重建。
- **数据缺口报告**：若 `<datasets>/<n>_<product>/dashboard_data_absence/` 存在，每次构建自动输出 `<product>-data-absence.{json,md}`。

## 5. 常见坑

1. **输入快照选择与全量索引**：同一 `(session_id, request_time)` 多快照时必须按归因各轮 `trace_id` 覆盖度选最完整那份；输入索引按产品全日期构建，避免跨天归因丢 transcript。
2. **Compact 证据下标换算**：compact `evidence_id` 的 message index 为整场扁平全局下标，必须按各 trace 消息数累加换算为 `(trace, local_index)`。
3. **单 Trace 聚合与 Session 点评**：后端按 trace 评测时，前端 `groupSessions` + `loadSession` 自动去重合并为会话；仅当 `attribution.summary` 存在时才渲染 Session 总评。
4. **样本页 DOM 与连线**：`.anatomy` 必须保持 `#sout` / `#stl` / `.threads` / `#sattr` 顺序，`drawThreads` 只查 `#sattr .pcard`；轮次只保留头部 `#ttabs` 一套；`copyText` 在 HTTP 下须保留 `execCommand` 兜底。
5. **生成物与发布**：`static/*.json*`、`static/samples/`、`cache/` 均不入库；远端非 git 仓库，统一用 `./dashboard/deploy.sh` 发布，回滚需切旧 commit 重发。
