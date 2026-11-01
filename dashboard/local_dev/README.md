# 本地调试

本地只读取仓库根目录的 `datasets/`；数据未放入时，数据看板与样本页保持待接入空态。
`EVAL_DATASETS` 可显式指定其他数据根目录。三个生成脚本在本地与生产使用同一套解析逻辑。

## 启动

在仓库根目录执行：

```bash
./dashboard/local_dev/start.sh
# 打开 http://127.0.0.1:5001/
```

`start.sh` 重建 `data.json`、`samples.json` 后在前台启动服务；`Ctrl-C` 结束。
也可以运行 `./dashboard/local_dev/stop.sh`。重跑启动脚本会自动停止此前的本地服务。
改了 `static/` 下的 JS/CSS 后，直接刷新页面。

## 接入数据

将真实数据放到 `datasets/`，保持原始目录结构：

```text
datasets/
  0_wencai/
    eval_input/<model>/<date>.jsonl
    eval_output/0_daily_eval_output/<model>/...
  1_aime/
    eval_input/0_daily_eval_input/<model>/<date>.jsonl
    eval_output/demo_data/<model>/...
```

`demo_data` 是已有评测产物的目录名称，由数据解析器兼容读取。
数据目录不提交到 Git。目录尚不存在或没有文件时，生成空数据索引。

放好或更新数据后执行：

```bash
./dashboard/local_dev/refresh.sh
```

刷新浏览器即可看到重建后的结果。数据源为空时也会覆盖旧索引、清理旧样本详情。
本地定时重扫默认间隔 24 小时；及时接入新数据请运行上述刷新命令。

## 指定目录或端口

```bash
EVAL_DATASETS=/path/to/datasets ./dashboard/local_dev/start.sh
EVAL_DATASETS=/path/to/datasets ./dashboard/local_dev/refresh.sh
PORT=5055 ./dashboard/local_dev/start.sh
```

指定目录后刷新时需传入同一个 `EVAL_DATASETS`。`server.py` 的刷新子进程继承启动时的数据根目录。

## 检查

```bash
node --test dashboard/tests/*.test.mjs
python3 -m unittest discover -s dashboard/tests -p 'test_*.py'
```
