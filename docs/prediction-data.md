# 预测卡片数据接口

问财与 AIME 共用同一个预测卡片。数据分别放在 `data.json` 的 `wencai.prediction` 与 `aime.prediction` 中；适配逻辑位于 `dashboard/static/js/prediction-data.js`。

没有 `prediction.questions` 字段时，卡片使用确定性的 1000 题示例题库，并显示“示例数据”。已有 `questions: []` 表示真实空题库，不会回退成示例。示例的公布时间各不相同，分布在数据快照前 14 天至后 28 天。

```json
{
  "prediction": {
    "as_of": "2026-11-01T12:00:00+08:00",
    "questions": [
      {"id": "q-001", "category": "行情与个股", "answer_at": "2026-11-01T10:00:00+08:00"},
      {"id": "q-002", "category": "资讯解读", "answer_at": "2026-11-05T15:00:00+08:00"}
    ],
    "accuracy": [
      {"model": "a_expert", "at": "2026-11-01T12:00:00+08:00", "correct": 1, "total": 1}
    ]
  }
}
```

`questions` 是完整题库，每题一条记录，`id` 应唯一。`answer_at` 表示该题答案的公布时间，支持带时区的 ISO 时间或毫秒时间戳。未带时区的日期时间按北京时间解释；只有日期时，按当日末尾解释。缺少公布时间的题仍计入题库总量和待公布数量，不进入时间曲线。缺少类别时归入“未分类”。

卡片以数据快照的 `as_of` 作为时间截面，不展示日历或日期选择控件：`answer_at <= 截面时间` 的题计为可解，其余计为待公布。分类计数与累计阶梯曲线来自同一批可解题，保留精确公布时刻与真实时间间隔；超过五个类别时，保留四个主要类别，其余合并为“其他”。图例显示截面内各类别的题量，悬浮数据同时给出数量和占比。

`accuracy` 是各模型的准确率观测记录。优先用 `correct / total × 100` 计算；也支持直接提供 `accuracy`，其单位固定为 0–100 的百分数。同一模型、同一时刻的计数记录合并计算，不平均百分比。缺失指标与零分母不会被画成 0%。准确率仅展示不晚于截面、且不晚于 `as_of` 的观测，未来截面不会生成未来准确率。`as_of` 缺失时使用 `data.json.generated_at`。

真实预测归因可通过 `prediction.attribution` 提供 `{models, errors, flows}`：`models` 为模型 ID 数组，`errors` 为错误类别数组，`flows[模型ID]` 为按错误类别顺序排列的数量数组。未提供时显示数据待接入；示例模式按已知准确率计数生成示例归因。

预测卡片不再渲染图外底部题注，曲线末端、图例和数据浮层承载图表信息。

代码级数据测试：

```sh
node --test dashboard/tests/prediction-data.test.mjs
```
