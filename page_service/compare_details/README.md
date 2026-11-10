# 版本对比展示页（page_service/compare_details）

给业务方看**某一期 A/B 的同一道题前后对比**的只读页面；和聚类矩阵的 A/B 召回打通：

```
聚类矩阵 A/B 抽屉 / 样本 chip
        │  ?view=compare&product=&round=&pair=  （或 online=）
        ▼
5002  /compare/?compare=1&product=&round=&pair=  ──> 看板 /?view=compare&…
        （不要测试集返回、模型筛选、同步滚动、同题列表；直接展示这一对）
```

页面本身仍是看板的 compare 视图（`dashboard/static/js/compare.js`），本模块只做挂载和
**展示态裁剪**，样式与看板完全一致。

## 路由

| 路径 | 说明 |
|---|---|
| `/compare`、`/compare/` | 302 到 `/compare/?compare=1`；`product` / `round` / `pair` / `online` 原样保留 |
| `/compare/…` | 反代看板同路径（`/compare/js/compare.js` → 看板 `/js/compare.js`，`/compare/data.json` → 看板 `/data.json`） |
| `/compare_details`、`/compare_details/…` | `/compare` 的别名，方便业务方按目录名访问 |
| `/healthz` | 5002 页面服务原有存活检查 |

直接 URL 示例：

```
http://<看板主机>:<5002 对外>/compare/?product=wencai&round=<roundId>&pair=<口径① trace>
http://<看板主机>:<5002 对外>/compare/?product=wencai&round=<roundId>&online=<slug>
```

`round` 缺省时展示页提示补齐 `round + pair`（或 `online`），不进入测试集选择态；
业务链接请始终带上 `round`（矩阵的 A/B 召回会带）。

## 展示态裁剪

`?compare=1` 时只保留：期次标题、预测能力、左右/上下两块样本详情。隐藏：

- 「← 测试集」返回
- 模型筛选 chips
- 同步滚动开关
- 左侧同题列表（含搜索框、分页、折叠轨）

页面宽度：16:9 铺满；32:9 收在 `max-width: 2200px` 居中。

## 部署

与 5002 页面服务同一进程：

```bash
./page_service/compare_details/deploy.sh     # 同步本模块 + 重启 5002
# 或者一次发布三个页面模块：
./page_service/sample_details/deploy.sh
```

部署脚本把本模块同步到 `/opt/page_service/compare_details`，`sample_details/server.py`
启动时导入；模块缺失时样本详情页照常工作。`page_proxy.py` 是三个页面共用的挂载实现，
部署时一起同步到 `/opt/page_service/`。

## 本地跑 & 测试

```bash
cd page_service/sample_details
PORT=5002 UPSTREAM=http://<看板主机>:2768 python3 server.py
# http://127.0.0.1:5002/compare/?compare=1&product=wencai&round=…&pair=…

cd page_service/compare_details
python3 -m unittest discover -s tests -p 'test_*.py' -v
```

## 已知边界

- 只展示已存在的 `round` + `pair`/`online`；没有同题数据时看板显示空态，不静默换题。
- 只支持 GET/HEAD；无鉴权，按约定部署在内网。
- `compare=1` 的隐藏样式在看板源码 `dashboard/static/css/compare.css`，随看板一起发布。
- 预测能力行来自看板的 `data.json`；缺失时该行不显示。
