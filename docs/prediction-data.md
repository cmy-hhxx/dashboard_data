# 预测卡片数据接口

数据页的「预测体系」卡片回答三个问题：有多少题是预测题，预测能力如何（准确率），错在哪里（预测归因）。三块内容放进同一张卡片的三张页签（题量 / 能力 / 归因），点页签切换。

## 接入

`build.py` 按产品读取 `datasets/4_forecast/<产品>/prediction.json`（例如 `4_forecast/wencai/prediction.json`，
由预测核验流水线每天导出，说明见 `4_forecast/README.md`）；没有该文件时预测卡显示「暂无预测数据」。
文件按下文字段裁剪后写入 `data-<产品>.json` 的 `products.<产品>.prediction`，文件变化会让下一轮构建重新聚合。

没有文件的产品（目前是 AIME），三张页签都显示「暂无预测数据」，不再生成示例数据。

## 格式

```json
{
  "as_of": "2026-11-01T12:00:00+08:00",
  "questions": [
    {"id": "q-001", "answer_at": "2026-11-01T10:00:00+08:00"},
    {"id": "q-002", "answer_at": "2026-11-05"}
  ],
  "accuracy": [
    {"model": "a_expert", "at": "2026-11-01T12:00:00+08:00", "correct": 1, "total": 1}
  ],
  "attribution": {
    "models": ["a_expert"],
    "errors": ["信息滞后", "趋势外推"],
    "flows": {"a_expert": [3, 1]}
  }
}
```

- `as_of`：时间截面。缺失时使用 `data.json` 的 `generated_at`。
- `questions`：可核验的预测题，每题一条记录，`id` 唯一。
  - `answer_at` 是答案公布时间，可以写成 ISO 时间或毫秒时间戳。不带时区时按北京时间解释；只有日期时按当日结束解释。
  - `answer_at` 不晚于截面的题计为「已揭晓」，其余计为「待揭晓」，包括缺少公布时间的题。
- 题库（可选，三项都可以直接给，也可以由 `summary` 推出）：
  - `bank`：预测侧扫过的题数，即「题库」；缺省取 `summary.extracted_questions`，再缺省用本产品去重后的题目数。
    预测侧的批次日期不一定和看板已评测的日期重合，所以按预测侧自己的题库计占比。
  - `unverifiable`：判为预测、但暂时不能核验的题数，计入「预测题」、在题量条里单列「不可核验」；
    缺省取 `summary.by_status` 的 `unverifiable + unresolved`。
  - `dates`：覆盖的批次日期，标题旁显示「覆盖 10-01～10-27」；缺省取 `summary.by_batch` 的键。
  - 预测题 = `questions` 条数 + `unverifiable`；「其他题」= 题库 − 预测题。
- `accuracy`：各模型的准确率观测。
  - 优先按 `correct / total` 计算；也可以直接提供 `accuracy`，单位是 0–100 的百分数。
  - 每个模型取不晚于截面的最近一次观测；同一时刻的计数记录合并计算。
  - 顶部的总体准确率由各模型的计数合并得出。只提供百分数时，总体准确率显示「—」。
- `attribution`：预测错误的归因。
  - `errors` 是错误类别。
  - `flows[模型ID]` 是按 `errors` 顺序排列的数量数组。
  - 卡片用「模型 → 错因」的小型桑基图呈现各模型的数量。

缺少某个字段时，卡片会隐藏对应部分，不会根据其他字段推算。

## 预测数据页与导出的附加字段（2026-11-05 起）

`prediction_items.jsonl` 每行是一道题的一个版本的回答。除上面的字段外，看板还读：

- `asset_class`（`a_share/hk/us/index/etf/option/bond/commodity/crypto/other`）：题的标的类别，缺失时按
  `targets[].instrument` 的 type / market 推（指数优先于市场）。
- `trajectory`：`{file, line, offset, bytes, trace_index}`，`file` 相对数据根；看板按偏移读出这一行原始轨迹，
  为没有归因样本的回答现生成详情（`/samples/<slug>.json`，`slug = forecast_slug(产品, 版本, trace_id)`）。
- 条目进 `products.<p>.prediction.items` 时带：`c` 类别、`d` 批次日、`i` 题号（同一题各版本相同）、
  `s` 点开用的样本 slug、`f` 有归因样本时对应的无归因详情 slug（取「预测核验」框用）。

改了条目字段要升 `build.py` 的 `PAYLOAD_VERSION`，否则数据没变时构建会复用旧载荷。
「预测数据」页（`?view=forecast`）一题一行、版本作该题的回答芯片；旭日图、星图、列表都按题计，
能力矩阵按回答计。
