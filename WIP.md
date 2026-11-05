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

2. `b2a9d35` wip(samples): 样本页交互改造 —— **未在浏览器验证**。

## 待验证 / 可能未完成

- `samples.js` 的 `markProse()`：在 Markdown 渲染后的回答里按「去掉空白与 MD 语法符号」
  的文本匹配证据区间并包 `<mark class="ev">`；长 quote 只匹配前 24 字；匹配失败退回
  消息右缘 `.has-ev` + 连线。需要看：表格 / 列表 / 链接里的证据能否正确命中，
  是否会把一个词拆成多个 mark。
- 连线：滚动时逐帧重画，两端夹进 `#sbody` / `#sattr` 可视区，被夹住的画虚线 `.off`。
  需要看：超长链路、session 总评、分享页整页 zoom 下的对齐。
- 粒子：画布只覆盖宿主可视切片（`particles.js` 的 `top/H` 计算 + `translateY`）。
  需要看：滚动时粒子与连线是否错位、快速滚动是否抖。
- 折叠：证据引用消息默认展开，`S.shut` 记录手动收起。需要看：点击折叠、`jump()` 跳转、
  切换 trace 后的状态是否符合预期。

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
