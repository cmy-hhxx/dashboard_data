import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

globalThis.location = { search: "" };
globalThis.window = {};
const { timelineCardHTML } = await import("../static/js/system_timeline.js");
const { flowCard, cellModalHTML, treeModel, computeOptimalBudget, selectOptimalTree, buildReplaySchedule } = await import("../static/js/system.js");
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
    "S1.M1.2": { name: "漏选基准时间", plain: "未规划对应时间段取数", def: "时间窗未纳入取数规划", include: "漏掉基准期", exclude: "无需对比历史", tags: ["漏查"] },
    "S9.M5.3": { name: "数值推算算错", plain: "百分比、倍数、估值推算本身算错", def: "终稿二次运算与原始回执矛盾", include: "公式或数量级算错", exclude: "上游数据源本身错误", tags: ["口径", "计算"] },
    "S9.M5.3.1": { name: "同比环比混算", plain: "把环比差值写成同比涨幅", def: "跨期间比较基数选错", include: "拿上期当去年同期", exclude: "源表仅提供单期数据", tags: ["口径"] },
    "S9.M1.1": { name: "结论漏答关键问项", plain: "交付未回答子问题", def: "交付遗漏问项", include: "漏掉主问句关键项", exclude: "追问超出范围", tags: [] },
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

const SAMPLE_CLUSTERS_PD = {
  clusters: {
    "S1.M1.1": 9,
    "S1.M1.2": 5,
    "S9.M5.3": 7,
    "S9.M5.3.1": 5,
    "S9.M1.1": 8,
  },
};

test("timeline uses crisp noun titles and plain Chinese: no AI titles, meta spans or jargon", () => {
  const html = timelineCardHTML();
  assert.ok(html.includes("单条时间线"));
  assert.ok(html.includes("整批调度"));
  for (const bad of [
    "一条对话怎样被评完", "一批对话怎样排队", "怎样排队", "怎样被评完",
    "点图里任意一条实心条", "点图里任意一行",
    'class="meta"', "tl-case-meta", "tl-global-meta", "引文核对", "tl-ev",
    "attribution-", "--model-requests", "--concurrency", "verifiedCompact", ".jsonl",
  ]) {
    assert.ok(!html.includes(bad), `timeline html must not contain ${bad}`);
    assert.ok(!timelineSrc.includes(bad), `timeline source must not contain ${bad}`);
  }
  assert.ok(html.includes('id="tl-pipe"'));
  assert.ok(html.includes('id="tl-focus"'));
});

test("system CSS styles the compact 5-tier SVG tree and tree-structured modal, removes old clutter selectors", () => {
  assert.ok(systemCss.includes('.view[data-view="system"] .card-head'));
  assert.ok(systemCss.includes(".fx-tree"));
  assert.ok(systemCss.includes(".fx-tax-head"));
  assert.ok(systemCss.includes(".fx-link.is-sprout"));
  assert.ok(systemCss.includes(".fx-tn.is-leaf"));
  assert.ok(systemCss.includes(".fx-tn.is-cell circle"));
  assert.ok(systemCss.includes(".fx-tree.is-hovering"));
  assert.ok(systemCss.includes(".fx-g-ph.is-hl"));
  assert.ok(systemCss.includes(".fx-g-col code"));
  assert.ok(systemCss.includes(".fx-toast"));
  assert.ok(systemCss.includes(".fx-root-shift"));
  assert.ok(systemCss.includes(".fx-wave-back"));
  assert.ok(systemCss.includes(".fx-wave-front"));
  assert.ok(!systemCss.includes(".fx-clu-gear"));
  assert.ok(!systemCss.includes(".fx-prog"));
  assert.ok(!systemCss.includes(".sm-pat-bar"));
  assert.ok(!systemCss.includes(".sm-tree"));
  assert.ok(systemCss.includes(".fx-g-sum"));
  assert.ok(systemCss.includes(".sm-panel"));
  assert.ok(systemCss.includes(".sm-sb"));
  assert.ok(systemCss.includes(".sm-spec"));
  assert.ok(systemCss.includes(".sm-coord"));
  for (const old of [
    ".fx-board", ".fx-bin", ".fx-cl-how", ".tl-ev", ".tl-readout", ".sys-spec",
    ".fx-tree-bar", ".fx-feed", ".fx-tier-lbl", ".fx-leaf-box", ".fx-leaf-cap",
    ".fx-leaf-lbl", ".sm-lead", ".sm-axes", ".sm-axis",
  ]) {
    assert.ok(!systemCss.includes(old), `system.css must remove old selector ${old}`);
  }
});

test("flowCard builds a compact 5-tier cluster tree with M{n} cells, dot leaves, toasts and matrix S/M codes", () => {
  const html = flowCard(SAMPLE_TAX, SAMPLE_CLUSTERS_PD);
  assert.ok(html.includes('id="fxDiagram"'));
  assert.ok(html.includes('class="fx-sparks"'));
  assert.ok(html.includes('id="fxTree"'));
  assert.ok(html.includes('class="fx-tax-head"'));
  assert.ok(html.includes('class="fx-toasts"'));
  assert.ok(html.includes('id="fxPause"'));
  assert.ok(html.includes('id="fxSpeed"'));
  assert.ok(!html.includes('id="fxReplay"'));
  assert.ok(html.includes("fx-tn is-root"));
  assert.ok(html.includes("fx-tn is-phase"));
  assert.ok(html.includes("fx-tn is-stage"));
  assert.ok(html.includes("fx-tn is-cell"));
  assert.ok(html.includes("fx-tn is-leaf"));
  assert.ok(html.includes('class="fx-tn-hit"'));
  assert.ok(html.includes('data-tip="t"'));
  assert.ok(html.includes('data-phase="deliver"'));
  assert.ok(html.includes(">M5<") || html.includes(">M5</text>"));
  assert.ok(html.includes("<code>S9</code>"));
  assert.ok(html.includes("<code>M5</code>"));
  assert.ok(html.includes('data-tip="c"'));
  assert.ok(html.includes("加工计算错误"));
  for (const gone of [
    "fx-cl-how", "fx-board", "fx-bin", "Compact",
    "fx-tree-bar", "fxFeed", "fxStatProb", "fx-tier-lbl",
    "fx-leaf-box", "fxRootLeaf", "展示", "NaN",
  ]) {
    assert.ok(!html.includes(gone), `flowCard must not contain ${gone}`);
  }
  assert.ok(html.includes('<button type="button" class="fx-g-c'));
  assert.ok(html.includes('data-s="S9" data-m="M5"'));
  assert.ok(html.includes('class="fx-root-shift"'));
  assert.ok(html.includes('class="fx-wave-front"'));
  assert.ok(!html.includes('id="fxProg"'));
  assert.ok(!html.includes('fx-clu-gear'));
  assert.ok(html.includes('is-row-sum'));
  assert.ok(html.includes('is-col-sum'));
  assert.ok(html.includes('id="fxGrandSum"'));
});

test("treeModel rolls up clusters, supports matrix/patterns fallbacks, and preserves planar phase order", () => {
  const mClusters = treeModel(SAMPLE_TAX, SAMPLE_CLUSTERS_PD);
  assert.equal(mClusters.unit, "问题");
  assert.equal(mClusters.root.n, 34);
  assert.equal(mClusters.leaves.length, 4);
  assert.equal(mClusters.byId.get("S9.M5.3").n, 12);
  assert.equal(mClusters.byId.get("ph:deliver").n, 20);
  assert.deepEqual(
    mClusters.stages.map((s) => s.id),
    mClusters.phases.flatMap((p) => p.children.map((s) => s.id)),
  );

  const mMatrix = treeModel(SAMPLE_TAX, SAMPLE_PD);
  assert.equal(mMatrix.unit, "问题");
  assert.equal(mMatrix.root.n, 16);

  const mPayload = treeModel(SAMPLE_TAX, { patterns: [{ id: "S1.M1.1", n: 3 }, { id: "S9.M5.3", n: 6 }] });
  assert.equal(mPayload.root.n, 9);

  const mSchema = treeModel(SAMPLE_TAX, null);
  assert.equal(mSchema.unit, "模式");
  assert.equal(mSchema.root.n, mSchema.leaves.length);
});

test("buildReplaySchedule sums exactly to each leaf count and always sprouts unborn leaves first", () => {
  const model = treeModel(SAMPLE_TAX, SAMPLE_CLUSTERS_PD);
  const { seedMap, events } = buildReplaySchedule(model);
  const totals = new Map();
  const seenUnborn = new Set();

  model.leaves.forEach((lf) => totals.set(lf.id, seedMap.get(lf.id) || 0));
  const unbornIds = new Set(model.leaves.filter((lf) => (seedMap.get(lf.id) || 0) === 0).map((lf) => lf.id));
  assert.ok(unbornIds.size >= 1, "at least one leaf should sprout dynamically");

  events.forEach((ev) => {
    totals.set(ev.leaf.id, (totals.get(ev.leaf.id) || 0) + ev.delta);
    if (ev.isNew) {
      assert.ok(unbornIds.has(ev.leaf.id), "only unborn leaves emit isNew sprout events");
      assert.ok(!seenUnborn.has(ev.leaf.id), "each unborn leaf sprouts only once");
      seenUnborn.add(ev.leaf.id);
    } else if (unbornIds.has(ev.leaf.id)) {
      assert.ok(seenUnborn.has(ev.leaf.id), `follow-up match for ${ev.leaf.id} must come after its sprout`);
    }
  });

  assert.equal(seenUnborn.size, unbornIds.size, "all unborn leaves must sprout");
  model.leaves.forEach((lf) => assert.equal(totals.get(lf.id), lf.n, `sum for ${lf.id} must equal exact count`));
});

test("cellModalHTML renders a clean sunburst container with P0/P1 keys and drilldown spec without AI copy or 排除", () => {
  const cell = cellModalHTML(SAMPLE_TAX, SAMPLE_CLUSTERS_PD, "S9", "M5", { pos: { i: 1, n: 2 }, pattern: "S9.M5.3" });
  assert.ok(cell.includes("答案合成 × 加工计算错误"));
  assert.ok(cell.includes("data-close"));
  assert.ok(cell.includes('data-samples="S9|M5|S9.M5.3"'));
  assert.ok(cell.includes('data-step="-1"'));
  assert.ok(cell.includes("sm-coord"));
  assert.ok(cell.includes('id="smSunburst"'));
  assert.ok(cell.includes('id="smSpec"'));
  assert.ok(cell.includes("sb-keys"));
  assert.ok(!cell.includes("sm-pat-bar"));
  assert.ok(!cell.includes("sm-tree"));
  assert.ok(cell.includes("<code>S9</code>"));
  assert.ok(cell.includes("<code>M5</code>"));
  assert.ok(cell.includes("<code>S9.M5.3</code>"));
  assert.ok(cell.includes("公式或数量级算错"));
  assert.ok(cell.includes("进入标准"));
  assert.ok(!cell.includes("纳入"));
  assert.ok(!cell.includes("排除"));
  assert.ok(!cell.includes("上游数据源本身错误"));
  const aiPhrases = [
    "在哪一步出错", "错在哪种方式", "这一格收哪些问题", "这一步的几种错法",
    "出现在这些环节", "问题出在", "选一格看", "算进来", "不算进来",
    "sm-lead", "sm-axes",
  ];
  for (const gone of aiPhrases) {
    assert.ok(!cell.includes(gone), `cellModalHTML must not contain ${gone}`);
  }

  const stage = cellModalHTML(SAMPLE_TAX, SAMPLE_PD, "S9", null);
  assert.ok(stage.includes('id="smSunburst"'));
  assert.ok(stage.includes('id="smSpec"'));
  assert.ok(stage.includes("<code>S9</code>"));
  assert.ok(stage.includes("<code>S9.M5</code>"));
  for (const gone of aiPhrases) {
    assert.ok(!stage.includes(gone), `stage modal must not contain ${gone}`);
  }
  const mech = cellModalHTML(SAMPLE_TAX, SAMPLE_PD, null, "M5");
  assert.ok(mech.includes('id="smSunburst"'));
  assert.ok(mech.includes('id="smSpec"'));
  assert.ok(mech.includes("<code>M5</code>"));
  assert.ok(mech.includes("<code>S9.M5</code>"));
  assert.ok(mech.includes("data-close"));
  for (const gone of aiPhrases) {
    assert.ok(!mech.includes(gone), `mechanism modal must not contain ${gone}`);
  }
  const missing = cellModalHTML(SAMPLE_TAX, SAMPLE_PD, "S_NONE", null);
  assert.ok(missing.includes("data-close"));
  assert.ok(missing.includes("未找到对应条目"));
});

test("computeOptimalBudget, selectOptimalTree and buildReplaySchedule keep exact real totals on 131,632-problem trees", () => {
  const budget = computeOptimalBudget(1280);
  assert.deepEqual(budget, { maxCells: 50, maxLeaves: 100 });

  const phases = [
    { id: "plan", name: "规划" },
    { id: "request", name: "请求" },
    { id: "execute", name: "执行" },
    { id: "deliver", name: "交付" },
  ];
  const mechanisms = Array.from({ length: 7 }, (_, i) => ({
    id: `M${i + 1}`,
    name: ["空转未执行", "目标错配", "执行失败", "结果不可用", "加工计算错误", "无依据断言", "交付不符"][i],
    def: `错法定义${i + 1}`,
  }));
  const stageSpecs = [
    ["S12", "plan", [6, 1, 1, 3]],
    ["S1", "plan", [11, 3, 2, 1]],
    ["S2", "plan", [9, 3, 1, 1, 1]],
    ["S10", "request", [9, 3, 1, 1, 2, 1]],
    ["S3", "execute", [7, 7, 8, 4, 1, 1]],
    ["S4", "execute", [9, 3, 7, 2, 1, 1, 1]],
    ["S5", "execute", [6, 1]],
    ["S6", "execute", [4, 2, 2, 2]],
    ["S7", "execute", [1, 2, 1]],
    ["S8", "execute", [1, 1, 1, 1]],
    ["S11", "deliver", [2, 2, 2, 2, 1, 1, 1]],
    ["S9", "deliver", [6, 7, 4, 2, 2, 1]],
  ];
  const stages = stageSpecs.map(([id, phase], idx) => ({ id, phase, name: `环节${idx + 1}`, def: `定义${idx + 1}` }));
  const patterns = {};
  const clusters = {};
  let patIdx = 0;
  let runningTotal = 0;
  const targetTotal = 131632;
  const patIds = [];
  stageSpecs.forEach(([sid, , counts]) => {
    counts.forEach((cnt, mIdx) => {
      const mid = `M${(mIdx % 7) + 1}`;
      for (let k = 1; k <= cnt; k++) {
        patIdx++;
        const pid = `${sid}.${mid}.${k}`;
        patterns[pid] = { name: `标准模式${patIdx}`, plain: `说明${patIdx}` };
        const n = Math.max(10, 1200 - patIdx * 6);
        clusters[pid] = n;
        runningTotal += n;
        patIds.push(pid);
      }
    });
  });
  clusters[patIds[0]] += targetTotal - runningTotal;
  assert.equal(patIds.length, 170);

  const bigTax = { phases, stages, mechanisms, patterns };
  const bigPd = { clusters };
  const raw = treeModel(bigTax, bigPd);
  const opt = selectOptimalTree(raw, budget);
  assert.equal(opt.root.n, targetTotal);
  assert.equal(opt.totalPatterns, 170);
  assert.equal(opt.shownPatterns, opt.leaves.length);
  assert.equal(opt.isSampled, true);
  assert.equal(opt.stages.length, 12);
  assert.ok(opt.cells.length <= budget.maxCells, `cells=${opt.cells.length}`);
  assert.ok(opt.leaves.length <= budget.maxLeaves, `leaves=${opt.leaves.length}`);
  assert.equal(opt.root.shownLeafTotal, opt.leaves.reduce((t, x) => t + x.n, 0));

  const { seedMap, events } = buildReplaySchedule(opt);
  const totals = new Map();
  opt.leaves.forEach((lf) => totals.set(lf.id, seedMap.get(lf.id) || 0));
  const unbornIds = new Set(opt.leaves.filter((lf) => (seedMap.get(lf.id) || 0) === 0).map((lf) => lf.id));
  const seenUnborn = new Set();
  events.forEach((ev) => {
    totals.set(ev.leaf.id, (totals.get(ev.leaf.id) || 0) + ev.delta);
    if (ev.isNew) {
      assert.ok(unbornIds.has(ev.leaf.id));
      seenUnborn.add(ev.leaf.id);
    } else if (unbornIds.has(ev.leaf.id)) {
      assert.ok(seenUnborn.has(ev.leaf.id));
    }
  });
  assert.equal(seenUnborn.size, unbornIds.size);
  opt.leaves.forEach((lf) => assert.equal(totals.get(lf.id), lf.n));

  const html = flowCard(bigTax, bigPd);
  assert.ok(html.includes("131,632"));
  assert.ok(html.includes('class="fx-toasts"'));
  assert.ok(html.includes("is-cell is-circle"));
  assert.ok(html.includes(">M1</text>"));
  assert.ok(html.includes('data-phase="execute"'));
  assert.ok(html.includes("<code>S3</code>"));
  assert.ok(html.includes("<code>M1</code>"));
  assert.ok(html.includes('data-tip="t"'));
  assert.ok(html.includes('id="fxLiquidSheen"'));
  assert.ok(html.includes('class="fx-wave-mid"'));
  assert.ok(html.includes('class="fx-wave-sheen"'));
  assert.ok(html.includes('class="fx-wave-glow"'));
  assert.ok(html.includes('class="fx-bubble"'));
  assert.ok(html.includes('class="fx-root-gloss"'));
  assert.ok(html.includes('class="fx-root-sweep"'));
  for (const gone of ["NaN", "展示", "fxRootLeaf", "fx-leaf-box", "其余"]) {
    assert.ok(!html.includes(gone), `large flowCard must not contain ${gone}`);
  }
});
