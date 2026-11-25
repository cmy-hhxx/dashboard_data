# 样本详情独立页（`page_service/sample_details`）

将看板右侧样本详情 pane（轨迹 / 对话 / 归因）封装为独立 `5002` 页面服务，并挂接聚类矩阵与版本对比展示页。与看板零代码耦合，所有数据经 HTTP 只读代理自本地 `5001` 看板。完整接口说明见 [docs/api-usage.md](docs/api-usage.md)，与 5003 联动见 [../../docs/接口使用指南.md](../../docs/接口使用指南.md)。

## 1. 路由（同一 5002 进程）

| 路径 | 作用 |
|---|---|
| `/`、`/detail` | 单样本详情页：`?product=aime\|wencai&case=<split>%7C<model>%7C<sid>[&trace=<tid>]` 或 `&slug=<10位hex>` |
| `/api/context` | 迷你上下文（仅该会话召回行 + taxonomy，回显 `trace`） |
| `/samples/<slug>.json` | 单条详情（首次访问触发看板按需生成 0.5–4s，测试用户返回 404） |
| `/samples-<product>.json` | 剔除测试用户的全量召回索引（不含 `lb`） |
| `/labels-<product>.json` | 同测试用户掩码过滤的问题标签，**仅与全量 `rows[]` 按行号一一配对** |
| `/matrix/…` | 聚类矩阵独立页（见 `page_service/problem_matrix/README.md`） |
| `/compare/…`、`/compare_details/…` | 版本对比展示页（见 `page_service/compare_details/README.md`） |
| `/dashboard/…` | 完整看板只读反代兜底 |
| `/healthz` | 存活与上游 5001 探活 |

前端仅含 `static/{index.html,entry.js,detail.css}`；`/js/`、`/css/`、`/vendor/` 全部实时透传上游看板，确保展示与看板完全一致。

## 2. 本地运行与测试

```bash
cd page_service/sample_details
PORT=5002 UPSTREAM=http://<看板主机>:<看板端口> python3 server.py
python3 -m unittest discover -s tests -p 'test_*.py' -v
```

## 3. 部署与验收

| 部署 | 主机 / 容器 | 产品 | 5002 对外 / DSW 代理 |
|---|---|---|---|
| **乌兰察布** | `117.50.195.94` / `interactive-i6piqwvlnsr5` | `wencai` | `2833` / `.../proxy/dsw/trace-detail/` |
| **弗吉尼亚** | `10.217.219.2` / `interactive-s3ynzadcvm9c` | `aime` | `2476` / `.../proxy/dsw/trace-detail-oversea/` |

```bash
cd page_service/sample_details && ./deploy.sh   # 同步 sample_details / problem_matrix / compare_details / page_proxy.py 并重启 5002
curl -s http://<host>:<5002对外>/healthz
```

支持环境变量覆盖 `EVAL_DEPLOY_HOST` / `EVAL_DEPLOY_REMOTE`（默认 `/opt/page_service/sample_details`）/ `PORT` / `UPSTREAM`。

## 4. 边界约定

- 只读无鉴权，仅内网使用；DSW 代理会剥离路径前缀，前端 URL **必须保持相对路径**。
- 测试用户（`ut=test`）在索引、context 与详情中一律剔除；单样本页不拉全量 `labels`。
- 进程内缓存索引 120s（`DOC_TTL` 可调）；定位不存在的 `trace` 时页面明确报错，不静默切轮。
