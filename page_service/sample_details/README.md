# 样本详情独立页（page_service/sample_details）

与 5003 供数接口一起使用的完整指南：[../../docs/接口使用指南.md](../../docs/接口使用指南.md)。

把看板「具体数据」页右侧的 pane（评测输入与输出：轨迹 / 对话 / 归因）**单独**做成一个页面，
通过外网端口给其他部门的同事直接跳转查看；同时保留一份原样的 JSON 出口。

**与看板零代码耦合、零改动**：本模块不 import 看板任何文件，也不改看板任何一行代码；
数据全部通过 HTTP 从内部看板（默认 `http://127.0.0.1:5001`）只读获取。

```
外部 URL                      本模块 :5002                     内部看板 :5001
http://<看板主机>:2833/?product=&case=  ──> /api/context（迷你索引）
                                    /samples/<slug>.json  ──代理──> 按需生成并缓存
                                    /samples-<product>.json ─代理─> 召回索引
                                    /labels-<product>.json ─代理─> 问题标签（与索引同序）
```

## 路由

| 路径 | 说明 |
|---|---|
| `/`、`/detail` | 页面。带 `?product=wencai&case=daily%7Cb_fast%7Cthread_…`（一个会话，多轮自动合并）或 `?product=wencai&slug=<10位hex>`（一条评测输出）；再加 `&trace=<trace_id>` 可直接定位到会话里的某一轮；不带参数时是使用说明页 |
| `/api/context?…` | 页面用：只返回这个会话的那几行召回索引 + taxonomy（AIME 全量索引 8.1 MB，不下发浏览器）；带 `trace` 时原样回显（定位在前端做，详情里才有每轮 trace_id） |
| `/samples/<slug>.json` | 单条详情（与看板同路径，首次请求会触发看板懒生成，0.5–4 s）；测试用户样本返回 404 |
| `/samples-<product>.json` | 召回索引（给同事的系统对接用），已剔除测试用户行。**2026-11-07 起行内不再含 `lb`**，标签改由 `/labels-<product>.json` 按行号提供 |
| `/labels-<product>.json` | 问题标签（`{schema, product, labels:[…]}`），按同一测试用户掩码过滤，与 `/samples-<product>.json` 的 `rows[]` 同序同长度 |
| `/matrix/…` | 聚类矩阵独立页（`/matrix/?matrix=1`，反代看板数据页只留矩阵卡）；见 `page_service/problem_matrix/README.md` |
| `/compare/…`、`/compare_details/…` | 版本对比展示页（`/compare/?compare=1&product=&round=&pair=`）；见 `page_service/compare_details/README.md` |
| `/dashboard/…` | 完整看板兜底（矩阵里按筛选条件打开的样本列表走这里） |
| `/healthz` | 存活 + 上游探活 |

页面链接的用法：在看板里选中一个样本，复制地址栏的
`?view=samples&product=…&case=…`，把 `<看板主机>:2768` 换成 `<看板主机>:2833` 即可
（`view` 参数会被忽略）；也可以直接用 `slug`。要定位到某一轮，再带上 `&trace=<trace_id>`
（5003 `/traces` 的 trace_id）；找不到时页面会明确报错，不会静默换轮。

## 前端

页面只有三个自己的文件：`static/index.html`、`static/entry.js`（取迷你索引后调用看板的 `render()`）、
`static/detail.css`（把左侧样本列表和顶部导航去掉）。`/js/…`、`/css/…`、`/vendor/…` 全部由 `server.py`
原样转发到看板（`UPSTREAM`，默认 5001）：样本 pane 永远就是看板当前发布的那一份，不再维护拷贝。

## 本地跑

本地没有 `datasets/`，直接把上游指到现网看板即可（只读）：

```bash
cd page_service/sample_details
PORT=5002 UPSTREAM=http://<看板主机>:2768 python3 server.py
# 打开 http://127.0.0.1:5002/?product=wencai&case=daily%7Cb_fast%7Cthread_…
```

测试（起假上游 + 真服务，不依赖网络/看板）：

```bash
cd page_service/sample_details
python3 -m unittest discover -s tests -p 'test_*.py' -v
```

## 部署

两套部署（端口角色固定，详细地址见 [接口使用指南](../../docs/接口使用指南.md) 第零节）：

| 部署 | 主机 | 容器名 | 数据 | 5002 对外 |
|---|---|---|---|---|
| 乌兰察布 | `117.50.195.94` | `interactive-i6piqwvlnsr5` | 问财（页面接口沿用，暂不迭代） | `2833` |
| 弗吉尼亚 | `10.217.219.2` | `interactive-npasm9ch66eb` | AIME | `2222` |

看板用 `5001`（展示），对外分别 `2768` / `2221`；`5003` 供数、`5004` 开发调试、`5005` 备用。
对外也可通过 DSW 代理访问（平台剥掉路径前缀，转发到对应容器的 5002）：
- 乌兰（问财）：`https://rtahz.10jqka.com.cn/bmtp/proxy/dsw/trace-detail/`
- 弗吉尼亚（AIME）：`https://rtahz.10jqka.com.cn/bmtp/proxy/dsw/trace-detail-oversea/`

代理下前端 URL **必须保持相对路径**，不要写成 `/api/...`。未配代理时也可直连
`117.50.195.94:2833`（问财）/ `10.217.219.2:2222`（AIME）。
所以本服务直接监听 `:5002` 即可：

```bash
cd page_service/sample_details
./deploy.sh                       # 同步 sample_details/problem_matrix/compare_details/page_proxy.py 并重启 5002
```

`deploy.sh` 现在一起同步兄弟模块（矩阵页、版本对比展示页和共用的 `page_proxy.py`），
所以发布其中任何一个页面都用这一条命令。远端目录、日志：`/opt/page_service/sample_details/logs/server.log`；
进程号在 `server.pid`。单独起停：`./start.sh` / `./stop.sh`。`deploy.sh` 支持
`EVAL_DEPLOY_HOST` / `EVAL_DEPLOY_REMOTE` / `PORT` / `UPSTREAM` 覆盖。它**不会**调用、
也不会影响看板的 `dashboard/deploy.sh`。

验收：

```bash
curl -s http://<看板主机>:2833/healthz
curl -s "http://<看板主机>:2833/api/context?product=wencai&case=daily%7Cb_fast%7Cthread_…" | head -c 200
curl -sI "http://<看板主机>:2833/samples/<slug>.json"
curl -sI "http://<看板主机>:2833/matrix/?matrix=1"
curl -sI "http://<看板主机>:2833/compare/?compare=1&product=wencai&round=…&pair=…"
```

## 已知边界

- **无鉴权**：按约定部署在内部网络，不要把这个端口暴露到公网。
- **测试用户不供数**：索引 / context / 详情都按看板样本行的 `ut=test` 排除；看板自己仍展示全部用户。
- **labels 与索引必须按行号配对**：2026-11-07 起召回索引行里的 `lb`（问题标签）拆成了
  `labels-<product>.json`，本服务按同一测试用户掩码过滤后下发；两者的行号一一对应，**只对 `/samples-<product>.json`
  的全量 `rows[]` 成立**。`/api/context` 返回的是子集（只该会话那几行），不要拿 labels 按位置贴它。
- **页面本身不拉 labels**：单样本页只需要一个会话，前端用 `oneSession` 跳过这次请求，所以不会白拉几 MB。
- **首次打开慢**：详情是看板按需生成的。没被访问过的样本首次 0.5–4 s，之后走磁盘缓存；
  AIME 多轮会话（最多 41 条评测输出）第一次打开需要逐条生成，会更久一些。
- **数据新鲜度**：索引/taxonomy 在进程内缓存 120 s（`DOC_TTL` 可调）；详情每次都走看板，
  所以看板重建后下一次刷新页面即可看到新数据。
- 页面只做单样本查看，不做列表/搜索/批量导出。

