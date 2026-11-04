# 看板构建性能：基线、增量索引与两阶段加速实测

> 2026-11-03。对象是 `dashboard/build.py` 在远程挂载 `/mnt/fin_bench/code_and_clean_data/datasets`
> （当前约 44 GB 输入）上的构建。目标是让“每次新增数据 / 每次 build”不再全量重扫、重写。
>
> 2026-11-04 部署按产品切分后，乌兰只构建问财、弗吉尼亚只构建 AIME；本文的绝对耗时是切分前
> （两份数据同一构建）的基线，增量索引的设计与结论仍然适用。

## 1. 基线

| 项 | 数值 |
|---|---|
| 构建产物 | 13,482–14,000 个样本、约 847–886 MB 逐样本详情、`data.json` ~3 MB、`samples.json` ~7 MB |
| 全量构建 | 日志实测 **2,241 s / 37 min**，另两次 2,527 s、2,686 s |
| 输入扫描 | 输入侧约 44 GB（问财 32 GB + AIME 12 GB），另有 0.5 GB compact、0.26 GB attribution |
| 输出行为 | 每次 build 都重新配对、重新解析每个样本的输入行、重写并重新 gzip 全部详情 |

## 2. 排查到的主要耗时

在远程用 `cProfile` + 分阶段计时跑了 AIME 单日 1,187 个样本（2.5 GB 输入）：

| 阶段 | 旧实现耗时 | 原因 |
|---|---:|---|
| `pairs_from_keys` | 219 s | `choose_input` 对重复输入快照逐条 `json.loads` 整行；1,981 次随机 `read` 占 192 s（ceph 随机读约 100 ms/次） |
| 样本构建循环 | ~105 s | 每个样本再随机 seek 读输入、`json.loads`、写详情 |
| `input_total` | 57 s | 首轮重新扫 2.5 GB 数行；扫描后 offsets 被 drop，无法复用 |
| 全量放大 | ~19–37 min | 13.5k 样本 × 随机读 + 全量重写 850 MB + gzip；cluster `item_index` 按 mtime 失效会再次触发全量样本重建 |

关键结论不是“JSON 解析慢”，而是 **同一批大文件被反复读**：配对读一遍、样本随机读一遍、
输入统计再读一遍；再加上每次 build 都把全部详情重写并重新压缩。

## 3. 已实现的加速

### 3.1 持久化增量索引（`dashboard/build_store.py`）

`cache/build.sqlite3` 保存：

- 每个文件一行：`(size, mtime_ns, prefix_hash, lines, committed, offsets, keys, trace_ids, line_hashes, stats)`；
- 每个 attribution 文件一行配对缓存；
- 每个样本一行摘要缓存：`fp / oh / ih / ch / row / facts / brief / golden`。

输入文件只按 `(size, mtime_ns)` 失效；追加写从最后一个完整换行继续，不重扫全文。
输入行数、task/subtask、tool_calls、tokens、流失标记在同一次扫描里完成。

### 3.2 配对加速

- `choose_input` 直接使用索引里的 `trace_ids` 计覆盖度，不再读输入行；
- attribution 文件签名 = 输出 + 候选输入 + compact 的 `(size, mtime_ns)`，未变化直接复用配对；
- 变化文件才重新配对，compact 索引也来自缓存。
- 输出文件的索引行同时记下每行的 turn `trace_id` 和 SHA-256（`files.digests`，样本 slug 的来源），
  重新配对直接读索引，不再整份重读 attribution 文件。2026-11-03 生产实测：5 个增长中的输出文件重配对
  29.7 s，其中 22.2 s 是整份重读（ceph 约 4.4 s/文件）；改后只剩追加部分的扫描。旧库没有 `digests`
  的输出行第一次增长时整份重扫一次补齐，之后按追加续扫。

### 3.3 样本摘要缓存与 cluster 重映射

- 每个样本一行摘要缓存：`fp / oh / ih / ch / refs / row / facts / brief / golden`；
- fingerprint 只包含输入/输出/compact 行哈希与 `BUILD_VERSION`，**不再包含 cluster 内容签名**；
- cluster 变化时不再重读 44 GB 输入，只对缓存 brief 里的问题重新查 `cluster_index`，同步更新
  `row.st / pt / tg` 和 golden 的 `path`；详情文件由下面的懒加载器按 pkl 时间戳判断是否过期；
- 未变化样本不重写详情；只有来源行变化的样本才删除旧详情，避免样本页读到旧 transcript。

### 3.4 并行样本构建

- `build_samples` 先按 fingerprint 分流，命中样本只做重映射和聚合；
- 未命中样本按输入文件分组，交给 `ProcessPoolExecutor`（fork）并行；worker 只读 SQLite 和原始行，
  回传 compact summary，主进程统一写 SQLite；`--jobs 1` 或小批量自动退回串行；
- 每个 worker 用 `raw_line` + SQLite 行号读单行，不再整文件加载；输出文件也建立行号索引，
  既服务样本构建，也服务详情懒加载。

### 3.5 详情按需生成

- 构建只写摘要，不再生成约 1 GB 的逐样本详情；
- `server.py` 拦截 `/samples/<slug>.json`，`detail_builder.py` 从 SQLite 取
  `product/model/date/split/output/output_line/refs`，按行号读 input/output/compact，
  调同一个 `build_sample` 生成详情，写 `.json` + `.gz` 后交给静态服务；
- `refs` 是详情生成所需的 `[相对路径, 行号]`，旧缓存行第一次命中时自动回填；
- cluster pickle 比详情新时自动重建该条详情；详情缺失时按需补，不阻塞 build；
- 服务启动 / 每轮 build 后后台预热每个产品首屏约 30 条 + 最近 10 条详情（`DETAIL_PREWARM`，
  默认 30）。首屏样本详情命中静态缓存，实测 **1.7 ms**；未预热的任意样本仍受 ceph 随机读影响
  （0.6–4 s），这是没有恢复全量预生成的取舍。

### 3.6 按产品拆分 payload

- `data.json` 只留共享的 `source / taxonomy / system` 和产品元数据（约 180 KB）；
- `data-<product>.json` 各产品独立（问财约 0.8 MB，AIME 约 2.5 MB）；
- `samples.json` 只留产品清单，`samples-<product>.json` 是单产品召回索引；
- 前端启动只加载当前产品的 data + index，切换产品再懒加载；首屏体积从约 3.4 MB 降到约 1 MB
  （AIME 产品数据）或约 0.9 MB（问财）。

### 3.7 输入统计旁路

- `stats_worker.py` 独立常驻，每 30 分钟（`STATS_REFRESH_SECONDS`）把每个输入文件的
  `size / mtime_ns / lines / model / split / stats(records,traces,tool_calls,tokens,cache_read,
  by_model.tasks/subtask/lost)` 写到 `<datasets>/stats.json`，并给产品级 `summary / models /
  by_split / files_count / bytes` 和全局 `summary`；
- `build.py` 只接受 `(size, mtime_ns)` 仍匹配的 sidecar 条目，不匹配就局部扫描；旁路统计
  永远是加速器，不是正确性依赖；
- 共享 `cache/build.sqlite3`，已扫描过的文件不会重复读；写 `stats.json` 用临时文件 +
  `os.replace` 原子替换；`start.sh` 启动、`stop.sh` 停止。

### 3.8 cluster 签名与缓存

- `cluster_signature` 先按 `(path,size,mtime_ns)` 查 `cache/cluster-signature.json`，
  未变化直接复用；
- 变化时只读每个文件的头/尾 64 KB 做指纹，不再每次重读 30 MB `item_index.jsonl`；
- `load_clusters_cached` 仍把 18 MB item_index 的解析结果 pickle 到 `cache/clusters-<sig>.pkl`。

### 3.9 可选 orjson

- `json_compat.py` 优先 `orjson.loads/dumps`，遇到 Counter/set/indent 等不支持的对象自动回退标准库；
- 远程已安装 `orjson 3.13`；`requirements-optional.txt` 记录依赖，`deploy.sh` 缺失时尝试
  `pip install --user`，失败不影响发布。

### 3.10 摘要 pickle 缓存

- build 结束把 1.6 万条摘要写成 `cache/samples.pkl`；下一轮先用轻量 SQLite 列
  （`slug/fp/oh/ih/ch/refs`）逐条校验，命中才信任 pickle，过期/缺失的 slug 回退 DB 全量加载；
- 它不是正确性来源：删掉、损坏或版本不匹配都会自动全量加载；
- 16k brief 的 JSON 解码从 16–36 s 降到 9–12 s，文件约 320 MB，位于本地 `cache/`。

### 3.11 无变化快速路径

配对命中、输入零扫描、cluster/feed 签名不变、`data.json` / `data-<product>.json` /
`samples.json` / `samples-<product>.json` / `samples/` 存在时，直接返回
`{"reused": 1, "seconds": 0.x}`，不加载 1.6 万条 brief、不重算聚合、不重写 payload。
数据持续追加时不会命中，但这是本地回放和短暂无变化时的兜底。

## 4. 实测结果

### 4.1 单日 1,187 样本（2.5 GB 输入）

| 场景 | 旧 | 第一阶段增量 | 第二阶段（无详情） |
|---|---:|---:|---:|
| 首次（冷缓存） | 396 s | 76–91 s | 见下方全量 |
| 无变化 | 41 s（仍重写 55 MB） | 0.09 s（复用 payload） | **0.1 s** |

### 4.2 生产全量（2026-11-03，约 44 GB 输入，16,000+ 样本）

| 场景 | 结果 |
|---|---|
| 全量冷缓存（旧代码） | 19 min 12 s：scan 331 / pair 296 / cluster 69 / samples 456 |
| 第一阶段冷全量（仍写 1 GB 详情） | 500 s / 8.3 min：scan 302 / pair 43 / cluster 2.1 / samples 150 |
| 第二阶段部署首轮（首次无详情 + 首次输出索引） | 267 s：scan 2.7 / pair 32.3 / cluster 32.7 / samples 196.8 / write 0.4 |
| 输出索引补齐后 | 225.7 s：pair 188.1（一次性）/ cluster 6.0 / samples 28.6 |
| 连续增量（pickle 摘要缓存 + 输出索引已热） | **40.1 s / 26.9 s**：scan 0.6–0.8 / pair 11.4–21.9 / cluster 3.8 / samples 9.0–11.7 / aggregate 1.1 |
| 连续增量（未加 pickle 缓存时） | 52.4 s、66.6 s；更早 85.7–98.7 s（随新增文件和 ceph 抖动） |
| 样本详情首次打开 | 0.59 s（输出索引已就绪）；输入行较大时 2–4 s；之后静态缓存 |
| 首次打开前未建输出索引 | 90 s（已通过 build 预热输出行号索引消除） |

第二阶段把 samples 从 150 s 降到 16–36 s（只处理新增摘要），加 `cache/samples.pkl`
摘要缓存后进一步降到 9–12 s；scan 从 302 s 降到 0.6–1.5 s（`stats.json` 旁路），
详情写入从 1 GB 降到 0。剩余大头是增量配对（20–40 s）与加载
1.6 万条摘要做聚合（16–36 s），都随数据量线性增长。

### 4.3 目标对照

| 目标 | 结果 |
|---|---|
| 无变化 build ≤ 60 s | **26.9–40.1 s**；无变化快速路径 0.1 s |
| 新增一天/一个模型 ≤ 5 min | 首轮全量摘要 225–267 s；之后增量 27–40 s |
| 冷全量 ≤ 15 min | 4–5 min（含首轮输出行号索引一次性成本） |

### 5.1 查询接口评估结论

本阶段把“可接口化”的部分拆成了三层，而不是把全部聚合搬进接口：

1. `data.json` 共享壳 + `data-<product>.json` 单产品聚合：构建时生成，首屏只取当前产品；
2. `samples-<product>.json` 单产品召回索引：前端按产品懒加载；
3. `/samples/<slug>.json` 详情接口：真正按需生成，已不从 build 全量输出。

**没有**把 `aggregate / input_payload / system_facts` 整体移进查询接口，原因是：

- 这些聚合需要遍历全部 1.6 万条样本摘要；接口首请求要么 15–30 秒，要么需要额外的物化聚合缓存；
- 现有 `cache/samples.pkl` 已把摘要加载降到 9–12 秒，但每次 build 仍要聚合一次；
- 若改成接口按请求聚合，必须引入“聚合结果 + 失效标记”的物化层，否则首屏体验会明显变差；
- 前端现有 URL/字段契约稳定，产品拆分已经拿到大部分首屏收益。

**结论**：本阶段落地“产品拆分 + 详情接口 + 摘要缓存”，全量聚合仍由 build 物化；
下一阶段若要继续减 payload，应先做增量物化聚合（按产品维护聚合结果，样本增删时增量更新），
再把查询接口暴露给前端。这样避免把 15–30 秒的聚合成本从 build 转移到用户首请求。

## 5.2 后续可继续加速的点（按收益排序）

1. **服务端聚合替代全量静态重建**：把 `aggregate / input_payload / system_facts` 移进
   `interfaces/eval_data_interface` 的查询层，前端按产品/时间请求，build 只维护样本摘要。
   这是剩余最大的架构收益，但需要先定义好接口缓存与失效语义。
2. **增量聚合**：当前每轮仍加载 1.6 万条 brief 做聚合（16–36 s）；可按产品维护物化聚合，
   新增/删除样本时增量更新，避免全量扫 SQLite。
3. **详情首读预热**：已对每个产品首屏约 30 条 + 最近 10 条后台预热（`DETAIL_PREWARM`）；详情读取只取
   offsets 里的 16 字节（`BuildStore.line_span`），不再解码整份文件索引。不要恢复全量预生成。
4. **输出行号索引后台化**：首次为 48 个 attribution 文件建索引约 188 s；可放到
   `stats_worker` 或独立任务，避免首次 build 阻塞。
5. **详情去重 / 硬链接**：同一 trace 在多轮/多版本重复时按内容哈希复用 detail 文件。
6. **配对并行化**：pair 仍按输出文件串行；可像 samples 一样按文件分片，先做 SQLite 只读索引，
   再合并配对结果。

## 6. 运维约定

- `cache/` 是运行时状态，不入库；删除后下一次 build 全量重建。
- `static/samples/` 是详情缓存，可以安全删除；下一次访问按需重建，不需要全量 build。
- 修改 detail 结构时 bump `build_store.BUILD_VERSION`；只改聚合 payload 时 bump
  `build.py.PAYLOAD_VERSION`；改 SQLite 表结构要兼容旧库或显式迁移。
- 首次部署或 cluster 内容真正变化时，允许一次摘要重建；详情按需生成，不会再次写 1 GB。
- 追加写文件若最后一行没有换行，不会提交该行；等下一行完整后一起计入。
- 旁路统计文件在 `<datasets>/stats.json`，数据集只读时回退到 `dashboard/cache/stats.json`；
  `STATS_REFRESH_SECONDS` 控制刷新间隔，`start.sh` / `stop.sh` 管理进程。
