# 看板 ERR_CONNECTION_REFUSED：根因与处理

`ERR_CONNECTION_REFUSED` 的意思是浏览器连到了主机，但那个端口上没有进程在监听，TCP 被直接拒绝。
它和超时（`ERR_CONNECTION_TIMED_OUT`，网络或防火墙不通）、和 5xx（进程在、但出错）都不是一回事。
所以要找的永远是：**那一刻 5001（或 5004）上为什么没人 listen**。

## 根因（按出现频率）

1. **重启窗口里端口是关着的（代码问题，已修）**
   - 以前 `server.py` 的 `main()` 是先做完所有准备工作，最后才 `bind` 端口。准备工作包括：
     - 初始化 DetailBuilder 和 ABDetailBuilder；
     - 初始化 InputLister；
     - 新机器上没有 payload 时，先同步跑完一整次 `build.py`。
   - 每次 `deploy.sh`（`stop.sh` → `start.sh`）或手工重启，从旧进程被杀到新进程 bind 之间，端口都是关的。这段时间：
     - 普通重启有几秒；
     - 首次构建时长达几分钟。
   - 这段时间里打开或刷新页面就是 connection refused。前端旧版只重试 3 次、共约 2 秒，于是页面直接显示「页面加载失败」。
2. **进程挂了没人拉起（运维问题，未修）**
   - `start.sh` 用 `nohup` 起服务，没有守护进程：
     - 被 OOM 杀掉、被人误杀、容器里 Python 崩溃之后，端口一直关着，直到有人手工 `start.sh`；
     - 容器整体重启后也不会自动起，弗吉尼亚这次「容器挂了」就是这一类。
3. **容器或端口映射不在**
   - 宿主机端口映射到容器 5001。容器停了、重建后映射变了、或换了宿主端口，浏览器同样看到 refused。
   - 进程本身没问题，`/healthz` 在容器内是通的。
4. **backlog 太小（已在早先修过）**
   - 标准库默认 `request_queue_size=5`。一个样本页同时发几十个请求时，超出的连接会被拒绝。
   - 现在是 128。

## 本次改动

- **服务端**（`dashboard/server.py`）：
  - `main()` 第一步就 bind 并开始 `serve_forever`（独立线程），之后再做初始化和首次构建。
  - 预热期间：
    - 首页、JS、CSS 正常返回；
    - `*.json` 和 `/healthz` 返回 `503` + `Retry-After: 3`。
  - 所以 `deploy.sh` 的健康检查（`curl -f /healthz`）仍然会等到真正就绪。
  - `start.sh` 的「已经在服务」判断（`curl -s`，不带 `-f`）在预热期也会成立，不会再起第二个进程去抢同一个构建缓存。
  - 测试：`tests/test_runtime.py::test_warming_server_answers_data_with_retry_instead_of_refusing`。
- **前端**（`static/js/core.js`、`app.js`）：
  - `getJSON` 遇到连接失败（fetch 直接 reject，包含 refused / reset / 断网）或 5xx 时：
    - 按 0.6s、1.2s、2.4s … 最长 15s 指数退避，并带随机抖动；
    - 默认重试 6 次，合计约半分钟；
    - 浏览器 `online` 事件会立即结束等待；
    - 4xx 不重试。
  - 视图模块的动态 `import()` 失败时也会重试。因为失败的 import 会按 URL 被浏览器记住，重试时带上 `?retry=` 参数。
  - 重试期间，顶栏下方出现一条「连不上服务器，n 秒后第 k 次重试」。一旦有请求成功，它显示「已重新连上」后消失，并立刻检查一次数据更新。

## 仍需运维处理（建议）

- 给服务加守护，二选一：
  - 用 supervisord 或 systemd 托管 `server.py`，配 `autorestart`；
  - 在 `start.sh` 外面套一个 `until python3 server.py; do sleep 2; done` 的循环。
- 容器设置 `restart: unless-stopped`（或同等策略）。容器入口里调用 `start.sh`，宿主机或容器重启后就能自动恢复。
- 换端口或重建容器后，以 `docs/接口使用指南.md` 的端口表为准，核对宿主到容器 5001 的映射。

## 现场排查顺序

1. **进程在不在：** 在容器里执行 `cat dashboard/server.pid && kill -0 $(cat dashboard/server.pid)`。
2. **端口在不在：** 执行 `ss -ltnp | grep 5001`，或 `curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:5001/healthz`：
   - 503 表示还在预热；
   - 200 表示就绪；
   - 连不上则说明进程没 listen，看 `logs/server.log` 的最后几行。
3. **容器内通、外面 refused：** 查容器状态和端口映射，不是看板代码的问题。
