import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

globalThis.location = { search: "" };
globalThis.window = {};
const { timelineCardHTML } = await import("../static/js/system_timeline.js");
const { flowCard, cellModalHTML } = await import("../static/js/system.js");
const systemCss = fs.readFileSync(new URL("../static/css/system.css", import.meta.url), "utf8");
const timelineSrc = fs.readFileSync(new URL("../static/js/system_timeline.js", import.meta.url), "utf8");

const SAMPLE_TAX = {
  phases: [
    { id: "plan", name: "规划" },
    { id: "deliver", name: "交付" },
  ],
  stages: [
    { id: "S1", name: "取数规划", phase: "plan", def: "拆解问句并规划查询指标", components: ["planner"] },
    { id: "S9", name: "答案合成", phase: "deliver", def: "汇总全部依据并生成最终答复", components: ["answer", "synthesis"] },
  ],
  mechanisms: [
    { id: "M1", name: "空转未执行", def: "应该发起的查询或步骤未触发" },
    { id: "M5", name: "加工计算错误", def: "数值、比例、口径或逻辑加工算错" },
  ],
  l2: {
    "S9.M5": { name: "加工计算错误", mech: "M5", def: "终稿整合或推算过程中的计算错误" },
  },
  patterns: {
    "S1.M1.1": { name: "遗漏关键标的", plain: "未为点名标的规划取数", def: "用户点名标的后规划漏掉", include: "明确点名某标的却未查询", exclude: "标的无公开数据", tags: ["漏查"] },
    "S9.M5.3": { name: "数值推算算错", plain: "百分比、倍数、估值推算本身算错", def: "终稿二次运算与原始回执矛盾", include: "公式或数量级算错", exclude: "上游数据源本身错误", tags: ["口径", "计算"] },
    "S9.M5.3.1": { name: "同比环比混算", plain: "把环比差值写成同比涨幅", def: "跨期间比较基数选错", include: "拿上期当去年同期", exclude: "源表仅提供单期数据", tags: ["口径"] },
  },
  tags: [
    { id: "口径", name: "口径", def: "指标定义或比较基准偏差" },
  ],
};

const SAMPLE_PD = {
  matrix: {
    S1: { M1: { n: 4 } },
    S9: { M5: { n: 12 } },
  },
};

test("timeline speaks plain Chinese: no meta spans, stage ids, flags or 引文核对", () => {
  const html = timelineCardHTML();
  for (const bad of ['class="meta"', "tl-case-meta", "tl-global-meta", "引文核对", "tl-ev", "attribution-", "--model-requests", "--concurrency", "verifiedCompact", ".jsonl"]) {
    assert.ok(!html.includes(bad), `timeline html must not contain ${bad}`);
    assert.ok(!timelineSrc.includes(bad), `timeline source must not contain ${bad}`);
  }
  assert.ok(html.includes('id="tl-pipe"'));
  assert.ok(html.includes('id="tl-focus"'));
});

test("system CSS centers card-head, styles the board and the dialog, drops old tl rules", () => {
  assert.ok(systemCss.includes('.view[data-view="system"] .card-head'));
  assert.ok(systemCss.includes(".fx-board"));
  assert.ok(systemCss.includes(".sm-panel"));
  assert.ok(!systemCss.includes(".tl-ev"));
  assert.ok(!systemCss.includes(".tl-readout"));
  assert.ok(!systemCss.includes(".sys-spec"));
});

test("flowCard stacks 01→04 vertically with a Galton board whose bins align with matrix columns", () => {
  const html = flowCard(SAMPLE_TAX, SAMPLE_PD);
  assert.ok(html.includes('id="fxDiagram"'));
  assert.ok(html.includes('class="fx-sparks"'));
  assert.ok(html.includes('id="fxBoard"'));
  assert.equal((html.match(/class="fx-bin"/g) || []).length, SAMPLE_TAX.mechanisms.length);
  assert.ok(html.includes("fx-cl-how"));
  assert.ok(!html.includes("Compact"));
  assert.ok(html.includes('<button type="button" class="fx-g-c'));
  assert.ok(html.includes('data-s="S9" data-m="M5"'));
});

test("cellModalHTML explains a cell, a stage and a mechanism without leaving the page", () => {
  const cell = cellModalHTML(SAMPLE_TAX, SAMPLE_PD, "S9", "M5", { pos: { i: 1, n: 2 } });
  assert.ok(cell.includes("答案合成 × 加工计算错误"));
  assert.ok(cell.includes("data-close"));
  assert.ok(cell.includes('data-samples="S9|M5"'));
  assert.ok(cell.includes('data-step="-1"'));
  assert.ok(cell.includes("终稿整合或推算过程中的计算错误"));
  assert.ok(cell.includes("公式或数量级算错"));
  assert.ok(cell.includes("上游数据源本身错误"));
  assert.ok(cell.includes("同比环比混算"));
  assert.ok(cell.includes(">12<"));

  const stage = cellModalHTML(SAMPLE_TAX, SAMPLE_PD, "S9", null);
  assert.ok(stage.includes('data-cell="S9.M5"'));
  const mech = cellModalHTML(SAMPLE_TAX, SAMPLE_PD, null, "M5");
  assert.ok(mech.includes('data-cell="S9.M5"'));
});
