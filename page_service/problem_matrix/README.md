# 聚类矩阵独立页（page_service/problem_matrix）

把看板「数据看板」里的**聚类矩阵卡片**单独做成页面接口，给业务方直接打开；样式、交互、
全屏和数据口径都直接复用看板本身，不在本目录复制一份前端。

生产上它挂在现有 5002 页面服务（`sample_details`）下，因此**和样本详情页同端口**：

```
外部 URL                                  5002 页面服务                         内部看板 :5001
http://<看板主机>:<5002 对外> /matrix/?matrix=1 ──> 看板 /?matrix=1（只显示矩阵卡）──> 看板静态与 JSON
                                    /dashboard/…   ──> 看板 /…（完整看板，筛过的样本列表兜底）
                                    /compare/…      ──> 版本对比展示页（A/B 召回）
                                    /              ──> 样本详情页（具体样本召回）
```

矩阵里的召回直接打通另外两个页面接口：

- 格子趋势抽屉里的样本 → `/?product=…&slug=…&trace=…`（5002 样本详情页）
- A/B 抽屉 / 样本 chip → `/compare/?compare=1&product=…&round=…&pair=…`（版本对比展示页）
- 右侧热力图按日期/场景/聚类筛选的列表 → `/dashboard/?view=samples&…`（完整看板兜底）

## 路由

| 路径 | 说明 |
|---|---|
| `/matrix`、`/matrix/` | 302 到 `/matrix/?matrix=1`；页面就是看板数据页，只保留聚类矩阵卡 |
| `/matrix/…` | 反代看板同路径：`/matrix/js/app.js` → 看板 `/js/app.js`，`/matrix/data.json` → 看板 `/data.json` |
| `/dashboard/…` | 反代完整看板；矩阵里按筛选条件打开的样本列表走这里 |
| `/compare/…` | 版本对比展示页（由 `page_service/compare_details` 挂载） |
| `/healthz` | 5002 页面服务原有存活检查（含上游探活） |

URL 参数沿用看板：`product=wencai|aime` 可指定产品（不写时用该部署实际有数据的产品）。
`matrix=1` 是页面模式开关，由本服务自动补上；页面内部导航会保留它。

## 比例优化（32:9 / 16:9）

矩阵页本身不再拉伸列宽：`fitMatrix` 按内容列宽把整张表**等比 zoom**（最大 1.5 倍），
行高、字号、格子一起放大，16:9 基本铺满；32:9 超宽屏把内容收在 `max-width: 2000px` 居中，
两侧留白，避免把 38px 的行拉成扁条。全屏键在独立页里隐藏，因为页面本身已是整宽。

左右分析面板在全屏/独立页共用同一高度，左栏最后一行卡片贴着右栏热力矩阵的底边。

## 部署

代码与样本详情页一起部署，仍只占 5002（同一进程）：

```bash
./page_service/sample_details/deploy.sh     # 一次同步 sample_details / problem_matrix / compare_details / page_proxy.py
./page_service/problem_matrix/deploy.sh     # 只改矩阵时用：同步本目录 + page_proxy.py，并重启 5002
```

部署脚本把本目录同步到 `/opt/page_service/problem_matrix`；共用反代 `page_proxy.py`
同步到 `/opt/page_service/`。`sample_details/server.py` 启动时导入本模块；模块缺失时
样本详情页照常工作。

对外地址与样本详情页一致（见 [接口使用指南](../../docs/接口使用指南.md) 第二节）：

- 乌兰察布（问财）：`http://117.50.195.94:2833/matrix/?matrix=1`
- 弗吉尼亚（AIME）：`http://10.217.219.2:2222/matrix/?matrix=1`
- DSW 代理：`…/proxy/dsw/trace-detail/matrix/`、`…/proxy/dsw/trace-detail-oversea/matrix/`

## 本地跑

单跑本模块（不占 5002 时改端口）：

```bash
cd page_service/problem_matrix
PORT=5006 UPSTREAM=http://<看板主机>:2768 python3 server.py
# http://127.0.0.1:5006/matrix/?matrix=1
```

或者本地起 5002 页面服务，顺带验证挂载：

```bash
cd page_service/sample_details
PORT=5002 UPSTREAM=http://<看板主机>:2768 python3 server.py
# http://127.0.0.1:5002/matrix/?matrix=1
```

测试：

```bash
cd page_service/problem_matrix
python3 -m unittest discover -s tests -p 'test_*.py' -v
cd ../sample_details
python3 -m unittest discover -s tests -p 'test_*.py' -v
```

## 已知边界

- 页面是看板的只读反代；看板 5001 不可用时 5002 的矩阵页会返回 502。
- `matrix=1` 的隐藏样式与等比缩放实现在看板源码（`dashboard/static/js/data.js`、
  `dashboard/static/css/data.css`）里，随看板一起发布；5002 只负责路径映射。
- 只支持 GET/HEAD；不做鉴权，按约定部署在内网。
