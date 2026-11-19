import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

globalThis.location = { search: "" };
globalThis.window = {};
const { timelineCardHTML } = await import("../static/js/system_timeline.js");
const { flowCard, parseCellParam, cellSpecHTML } = await import("../static/js/system.js");
const systemCss = fs.readFileSync(new URL("../static/css/system.css", import.meta.url), "utf8");
const timelineSrc = fs.readFileSync(new URL("../static/js/system_timeline.js", import.meta.url), "utf8");
const appSrc = fs.readFileSync(new URL("../static/js/app.js", import.meta.url), "utf8");

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

test("timeline drops meta spans and removes 引文核对 section completely", () => {
  const html = timelineCardHTML();
  assert.ok(!html.includes('class="meta"'));
  assert.ok(!html.includes("tl-case-meta"));
  assert.ok(!html.includes("tl-global-meta"));
  assert.ok(!html.includes("引文核对"));
  assert.ok(!html.includes("tl-ev"));
  assert.ok(!timelineSrc.includes("tl-ev"));
  assert.ok(!timelineSrc.includes("tl-case-meta"));
  assert.ok(!timelineSrc.includes("tl-global-meta"));
});

test("system CSS centers card-head, unifies fx-diagram, and drops tl-ev rules", () => {
  assert.ok(systemCss.includes('.view[data-view="system"] .card-head'));
  assert.ok(systemCss.includes("justify-content: center"));
  assert.ok(!systemCss.includes(".tl-ev"));
  assert.ok(!/\.fx-tax\s*\{[^}]*border-top:\s*1px\s+dashed/.test(systemCss));
});

test("flowCard merges 01-03 flow and 04 clustering explainer + clickable matrix in one fx-diagram", () => {
  const html = flowCard(SAMPLE_TAX, SAMPLE_PD);
  assert.ok(html.includes('id="fxDiagram"'));
  assert.ok(html.includes('id="fxJunction"'));
  assert.ok(html.includes("fx-cl-how"));
  assert.ok(html.includes("纵轴 · 定位发生环节"));
  assert.ok(html.includes("横轴 · 判定失效机制"));
  assert.ok(html.includes("格内 · 沉淀标准模式"));
  assert.ok(html.includes('<button type="button" class="fx-g-c'));
  assert.ok(html.includes('data-s="S9" data-m="M5"'));
  assert.ok(html.includes('<button type="button" class="fx-g-row" data-s="S9"'));
  assert.ok(html.includes('<button type="button" class="fx-g-col" data-m="M5"'));
});

test("cellSpecHTML renders complete L1/L2/L3/L4口径 for cell, stage, and mechanism", () => {
  assert.equal(parseCellParam(SAMPLE_TAX, "S9.M5").code, "S9.M5");

  const cellHtml = cellSpecHTML(SAMPLE_TAX, SAMPLE_PD, "S9.M5", "aime");
  assert.ok(cellHtml.includes("data-sys-back"));
  assert.ok(cellHtml.includes('data-open-samples="S9|M5"'));
  assert.ok(cellHtml.includes("S9 答案合成 × M5 加工计算错误"));
  assert.ok(cellHtml.includes("汇总全部依据并生成最终答复"));
  assert.ok(cellHtml.includes("终稿整合或推算过程中的计算错误"));
  assert.ok(cellHtml.includes("数值推算算错"));
  assert.ok(cellHtml.includes("公式或数量级算错"));
  assert.ok(cellHtml.includes("上游数据源本身错误"));
  assert.ok(cellHtml.includes("S9.M5.3.1"));
  assert.ok(cellHtml.includes("同比环比混算"));

  const stageHtml = cellSpecHTML(SAMPLE_TAX, SAMPLE_PD, "S9", "aime");
  assert.ok(stageHtml.includes("S9 答案合成"));
  assert.ok(stageHtml.includes("S9.M5"));

  const mechHtml = cellSpecHTML(SAMPLE_TAX, SAMPLE_PD, "M5", "aime");
  assert.ok(mechHtml.includes("M5 加工计算错误"));
  assert.ok(mechHtml.includes("S9.M5"));
});

test("app.js clears system cell param when switching tabs or re-clicking system tab", () => {
  assert.ok(appSrc.includes("cell: null"));
  assert.ok(appSrc.includes('button[data-value="system"]'));
});
