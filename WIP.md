# WIP 交接（2026-11-05）

当前分支 `wip/sample-evidence`，tag `wip-2026-11-05`。这里是 Claude 干到一半的状态，
main 停在 `4e0b2d2`（上一次验证过的发布状态）。

## 还原 / 回退

```bash
git log --oneline wip-2026-11-05 -3   # 看这个检查点
git diff 4e0b2d2..wip-2026-11-05      # 看全部改动
git reset --hard wip-2026-11-05       # 回到这个确切状态
git switch main                       # 或者先回 main 的旧状态
```

**不要 push**：分支上的第二个提交是 WIP。

## 已提交的两件事

1. `cf9ca0c` refactor(static): 样式按页面拆成 `css/` 目录 —— 已完成。
   `dashboard/static/app.css` 拆成 `base / layout / content / data / system / samples`；
   样本页四栏网格改由 `--col-*` token 驱动，`page_service/sample_details/static/detail.css`
   只调 token。`sample_details` 的 12 个测试通过（`python3 -m pytest tests/test_server.py -q`）。

2. `b2a9d35` wip(samples): 样本页交互改造 —— 已在浏览器验证，见下。

## 已验证（2026-11-05，本地 1440 / 1024 / 390 / 3840×2160 / 7680×2160，亮暗色）

- `markProse()`：Markdown 回答里的证据按渲染文本定位，表格内命中正常；同一句话被多条证据
  命中时合并成一个 mark（`data-e` 多值）。44/44 证据按钮点击后都能高亮。
- 连线：`#sbody` / 侧栏滚动逐帧重画；两端夹进可视区，被夹住的画虚线 `.off`；
  跳转后的证据由 `S.active` 固定高亮，不再被滚动触发的 `focus(null)` 清掉。
- 粒子：画布只覆盖宿主可视切片，滚动时 `translateY` 跟随。
- 折叠：步骤默认全部折叠，只有点证据按钮跳转时才展开那条消息（`S.open`）。
- 滚动：详情面板只有一个滚动面（`#sbody`），侧栏不再 sticky、不再自己滚；链路不再限高。
- mark：默认不显示，悬停问题卡时显示该卡证据，点击后固定高亮。
- dashboard 与 page_service 两处 `static/` 快照已一致（`cmp` 校验 8 个文件）。

## 仍需注意

- 回答里 `<trace ref="…" />` 一类标签仍按原文显示（数据侧问题，未在渲染器里过滤）。
- 样本页 session 总评在部分 case 没有跨轮问题，会显示「未发现 跨trace 问题」。

## 前后端快照关系

`page_service/sample_details/static/` 是 `dashboard/static/` 的拷贝快照，两份 `samples.js` /
`particles.js` 必须保持一致：

```bash
cp dashboard/static/js/{core,render,particles,samples}.js page_service/sample_details/static/js/
cp dashboard/static/css/{base,layout,content,samples}.css page_service/sample_details/static/css/
```

## 本地验证方式

```bash
cd page_service/sample_details && python3 -m pytest tests/test_server.py -q
```
