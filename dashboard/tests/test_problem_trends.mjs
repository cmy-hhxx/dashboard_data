import assert from "node:assert/strict";
import test from "node:test";

// These modules share the dashboard's formatting helpers; no DOM is needed by the data seam.
globalThis.location = { search: "" };
globalThis.window = {};
const { buildProblemTrendModel, problemRateValues, problemKlineRows, problemKlineSpec, mountProblemTrends } = await import("../static/js/problem_trends.js");
const { buildDailyTopModel, buildHeatPages, dailyTopHTML, dayModalHTML, mountDailyTop, resolveDailyTip } = await import("../static/js/daily_top.js");
const { traceSeverityModel, traceShares } = await import("../static/js/trace_analysis.js");
const { abComparisonHTML, abRoundsHTML, mountAB, metricValue, metricTip } = await import("../static/js/abtest.js");
const { trendSampleCandidates, trendSampleProblems, traceSampleRefs, abTrendSampleRefs, abLeafRefs, resolveABSamples } = await import("../static/js/trend_samples.js");

const cell = (date, node, count, hits) => [date, 0, node, 0, 0, 0, 0, count, 0, 0, 0, 0, hits, 0, 0, hits];
const trend = {
  dates: ["2026-10-01", "2026-10-02", "2026-10-10"],
  nodes: ["S9", "S9.M5", "S9.M5.1"],
  base: [[0, 0, 0, 0, 100], [1, 0, 0, 0, 100], [2, 0, 0, 0, 100]],
  cells: [cell(0, 0, 165, 80), cell(0, 1, 100, 60), cell(0, 2, 90, 50), cell(2, 0, 1, 1)],
};

test("occurrence probability uses deduplicated sessions, even with several problems per session", () => {
  const model = buildProblemTrendModel(trend);
  assert.deepEqual(problemRateValues(model.byId.get("S9"), model.base, [0, 1, 2]), [80, null, 1]);
  assert.equal(model.byId.get("S9").counts[0], 165);
});

test("parent aggregates never count their descendants a second time", () => {
  const model = buildProblemTrendModel(trend);
  assert.equal(model.root.counts[0], 165);
  assert.equal(model.byId.get("S9.M5").hits[0], 60);
  assert.equal(model.byId.get("S9.M5.1").hits[0], 50);
});

test("missing union counts do not invent a parent probability from overlapping children", () => {
  const model = buildProblemTrendModel({ ...trend, cells: trend.cells.filter((raw) => raw[2] !== 0) });
  assert.equal(model.byId.get("S9").counts[0], 100);
  assert.deepEqual(problemRateValues(model.byId.get("S9"), model.base, [0, 1, 2]), [null, null, null]);
});

test("each category uses only its dated observations, without empty leading or trailing days", () => {
  const source = {
    dates: ["2026-10-01", "2026-10-02", "", "2026-10-10", "2026-10-11"], nodes: ["S9"],
    base: Array.from({ length: 5 }, (_, i) => [i, 0, 0, 0, 100]),
    cells: [cell(1, 0, 10, 8), cell(2, 0, 50, 40), cell(3, 0, 20, 15)],
  };
  const model = buildProblemTrendModel(source);
  const rows = problemKlineRows(model, model.byId.get("S9"), [0, 1, 2, 3, 4]);
  assert.deepEqual(rows.map((row) => row.date), ["2026-10-02", "2026-10-10"]);
  assert.deepEqual(rows.map((row) => row.value), [8, 15]);
  // Volume is the evaluated sessions of that day; the problem count rides along for the tooltip.
  assert.deepEqual(rows.map((row) => row.volume), [100, 100]);
  assert.deepEqual(rows.map((row) => row.problems), [10, 20]);
  const single = problemKlineRows(model, model.byId.get("S9"), [3, 4]);
  assert.deepEqual(single.map((row) => [row.date, row.value]), [["2026-10-10", 15]]);
});

test("card charts are compact day K-lines (release lines only drawn full size); the expanded chart opens samples", () => {
  const model = buildProblemTrendModel({ ...trend, releases: [{ date: "2026-10-02", label: "v1002" }] });
  const node = model.byId.get("S9");
  const card = problemKlineSpec(model, node, [0, 1, 2]);
  assert.equal(card.compact, true);
  assert.equal(card.period, "day");
  assert.deepEqual(card.releases, [{ date: "2026-10-02", label: "v1002" }]);
  assert.equal(card.valueFormat(80), "80.0%");
  assert.equal(card.onPick, null);
  const picks = [];
  const detail = problemKlineSpec(model, node, [0, 1, 2], true, (pick) => picks.push(pick));
  assert.equal(detail.compact, false);
  assert.ok(detail.height > card.height);
  detail.onPick({ time: "2026-10-10" });
  assert.deepEqual(picks.map((pick) => [pick.date, pick.index, pick.series.levelIdxs]), [["2026-10-10", 1, [0, 1, 2, 3, 4]]]);
});

test("expanded category charts mount the shared sample drawer instead of a drill button", () => {
  const events = new Map(), knob = { style: {} }, plot = { clientWidth: 700, querySelector: () => null };
  const buttons = ["7", "30", "all"].map((value) => ({ dataset: { value }, setAttribute() {} }));
  const range = { querySelector: () => knob, querySelectorAll: () => buttons, addEventListener() {} };
  const grid = { innerHTML: "", style: {}, setAttribute() {},
    getBoundingClientRect: () => ({ width: 720, top: 200 }),
    children: [{ dataset: { trendCard: "S9" }, querySelector: () => plot }],
  };
  const parts = { "#mptRange": range, "#mptGrid": grid, "#mptPath": {}, "#mptMeta": {} };
  const host = { clientWidth: 744, querySelector: (key) => parts[key],
    addEventListener: (key, value) => events.set(key, value), removeEventListener: (key) => events.delete(key),
  };
  const previousDocument = globalThis.document, previousRAF = globalThis.requestAnimationFrame, previousObserver = globalThis.ResizeObserver;
  globalThis.document = { getElementById: () => ({ classList: { remove() {} } }) };
  globalThis.requestAnimationFrame = () => 0;
  globalThis.ResizeObserver = class { observe() {} };
  let mounted = null, destroyed = 0;
  const actions = { mountDetailChart: (...args) => { mounted = args; return { destroy: () => destroyed++ }; } };
  try {
    mountProblemTrends(host, trend, { range: "all", issueZoom: "S9" }, new Map(), (update) => update(), actions);
    assert.match(grid.innerHTML, /gx mxt-samples/);
    assert.doesNotMatch(grid.innerHTML, /data-trend-node=/, "sample clicks cannot also drill the expanded chart");
    assert.ok(mounted, "expanded trends must mount the shared recall component");
    const [element, node, makeChart] = mounted;
    assert.equal(element, plot);
    assert.equal(node, "S9");
    assert.equal(typeof makeChart, "function", "the drawer builds the K-line itself, with its pick handler");
    mountProblemTrends(host, { ...trend, cells: trend.cells.map((raw) => raw.slice(0, 15)) }, { range: "all" });
    assert.equal(destroyed, 1, "replacing the view disposes the old sample drawer");
    assert.doesNotMatch(grid.innerHTML, /data-trend-card=/, "unobservable categories must not create empty cards");
  } finally {
    host._mptCancel?.();
    globalThis.document = previousDocument;
    globalThis.requestAnimationFrame = previousRAF;
    globalThis.ResizeObserver = previousObserver;
  }
});

test("Trace distribution includes clean traces and does not reuse Session totals", () => {
  const model = traceSeverityModel({ ...trend, trace_severity: {
    levels: ["P0", "P1", "P2", "P3", "P4", "none"],
    daily: [[1, 0, 0, 0, 1, 1], [0, 0, 0, 0, 0, 2], [0, 1, 0, 0, 0, 0]], unresolved: 2,
  } });
  assert.deepEqual(model.counts, [1, 1, 0, 0, 1, 3]);
  assert.equal(model.total, 6);
  assert.equal(model.unresolved, 2);
  assert.equal(traceSeverityModel(trend), null);
});

test("rounded Trace shares sum to exactly 100.0% without inventing a denominator", () => {
  assert.equal(traceShares([1, 1, 1, 1, 1, 1]).reduce((a, n) => a + Math.round(n * 10), 0), 1000);
  assert.deepEqual(traceShares([0, 0, 0, 0, 0, 1]), [0, 0, 0, 0, 0, 100]);
  assert.deepEqual(traceShares([0, 0, 0, 0, 0, 0]), [null, null, null, null, null, null]);
});

test("AB batches render before and after sides without online", () => {
  const html = abComparisonHTML({ sides: { before: { hits: 200, traces: 80, problem_traces: 70 }, after: { hits: 60, traces: 30, problem_traces: 25 } } });
  assert.equal((html.match(/class="ab-batch is-/g) || []).length, 2);
  assert.match(html, /优化前/);
  assert.match(html, /优化后/);
  assert.doesNotMatch(html, /线上真实/);
  assert.doesNotMatch(html, /<small/);
  assert.match(html, /80 条 Trace，其中 70 条有问题/);
  assert.match(html, /30 条 Trace，其中 25 条有问题/);
});

test("AB comparison distinguishes missing results from measured zero problems", () => {
  const missing = abComparisonHTML({ sides: { before: { hits: 200 }, after: null } });
  assert.equal((missing.match(/is-missing/g) || []).length, 1);
  assert.doesNotMatch(missing, /减少/);
  const zero = abComparisonHTML({ sides: { before: { hits: 200 }, after: { hits: 0 } } });
  assert.equal((zero.match(/is-missing/g) || []).length, 0);
  assert.match(zero, /<b class="num">0<\/b>/);
});

test("AB overview is three cards whose four flows add up to the net paired change", () => {
  const rnd = {
    label: "v1106",
    sides: { before: { hits: 125, traces: 40 }, after: { hits: 65, traces: 30 } },
    leaves: [
      { id: "S1.M1.1", name: "消除的", before: 50, after: 0 },
      { id: "S1.M1.2", name: "回落的", before: 60, after: 20 },
      { id: "S1.M1.3", name: "上升的", before: 10, after: 30 },
      { id: "S1.M1.4", name: "新出现的", before: 0, after: 10 },
      { id: "S1.M1.5", name: "没动的", before: 5, after: 5 },
    ],
    matrix: {
      before: [["未接入分类体系", "", [["S1.M1.1", 50], ["S1.M1.2", 60], ["S1.M1.3", 10], ["S1.M1.5", 5]]]],
      after: [["未接入分类体系", "", [["S1.M1.2", 20], ["S1.M1.3", 30], ["S1.M1.4", 10], ["S1.M1.5", 5]]]],
    },
    nodes: [],
  };
  const host = { innerHTML: "", getBoundingClientRect: () => ({ width: 720 }),
    querySelector: () => null, querySelectorAll: () => [], addEventListener() {} };
  const previousWindow = globalThis.window, previousRAF = globalThis.requestAnimationFrame;
  globalThis.window = { addEventListener() {} };
  globalThis.requestAnimationFrame = () => 0;
  try {
    mountAB(host, { rounds: [rnd] }, { round: 0, step: "summary" }, {}, null, {});
    assert.match(host.innerHTML, /class="ab-overview" id="abOverview" data-open="" data-cards="3"/);
    assert.equal((host.innerHTML.match(/data-abcard="/g) || []).length, 3, "three cards share the row");
    assert.equal((host.innerHTML.match(/data-act="abcard"/g) || []).length, 1, "only the orbit card keeps its expand control");
    assert.match(host.innerHTML, /class="ab-bridge-main"><b class="num is-better">−60<\/b><small>个问题<\/small>/);
    assert.match(host.innerHTML, /class="ab-wf-anchor is-start"[^>]*>.*?<b class="num">125<\/b>/);
    assert.match(host.innerHTML, /class="ab-wf-anchor is-end is-better"[^>]*>.*?<b class="num">65<\/b>/);
    assert.equal((host.innerHTML.match(/class="ab-batch is-/g) || []).length, 0, "overview omits duplicate batch cards");
    const flows = [...host.innerHTML.matchAll(/class="ab-wf-label"><span>([^<]+)<\/span><b class="num" data-flow="([^"]+)">([^<]+)<\/b>/g)].map((m) => [m[1], m[2], m[3]]);
    assert.deepEqual(flows, [["消除", "clear", "−50"], ["减少", "down", "−40"], ["增加", "up", "+20"], ["新增", "add", "+10"]]);
    assert.equal((host.innerHTML.match(/class="ab-wf-col /g) || []).length, 4, "one floating step per flow");
    // The matrix step below the summary legitimately uses h3; only the overview must stay heading-free.
    const summaryHtml = host.innerHTML.split('class="ab-matrixstep"')[0];
    assert.doesNotMatch(summaryHtml, /ab-flow-bar|ab-scope|ab-mxnote|<h3|<h4/);
  } finally {
    globalThis.window = previousWindow;
    globalThis.requestAnimationFrame = previousRAF;
  }
});

test("AB overview keeps three cards but no waterfall while the release side has not been measured", () => {
  const rnd = { label: "v1106", sides: { before: { hits: 12 } }, leaves: [{ id: "S1.M1.1", name: "x", before: 12, after: null }], matrix: { before: [] }, nodes: [] };
  const host = { innerHTML: "", getBoundingClientRect: () => ({ width: 720 }),
    querySelector: () => null, querySelectorAll: () => [], addEventListener() {} };
  const previousWindow = globalThis.window, previousRAF = globalThis.requestAnimationFrame;
  globalThis.window = { addEventListener() {} };
  globalThis.requestAnimationFrame = () => 0;
  try {
    mountAB(host, { rounds: [rnd] }, { round: 0, step: "summary" }, {}, null, {});
    assert.match(host.innerHTML, /data-cards="3"/);
    assert.equal((host.innerHTML.match(/data-abcard="/g) || []).length, 3);
    assert.doesNotMatch(host.innerHTML, /class="ab-wf"/);
    assert.match(host.innerHTML, /待复测/);
    assert.match(host.innerHTML, /暂无结果/);
  } finally {
    globalThis.window = previousWindow;
    globalThis.requestAnimationFrame = previousRAF;
  }
});

test("AB cell trends read the paired change across the release", () => {
  const row = { name: "未接入分类体系", task: "未接入分类体系", sub: "" };
  const col = { name: "本地计算", prefix: "S4" };
  const mBefore = [[row.task, "", [["S4.M1.1", 95]], 95]];
  const mAfter = [[row.task, "", [["S4.M1.1", 60]], 60]];
  const released = {
    label: "v1106", released_at: "2026-11-06", targets: 120,
    sides: { before: { hits: 95, traces: 95 }, after: { hits: 60, traces: 60 } },
    matrix: { before: mBefore, after: mAfter },
    common: { rows: [[row.task, "", ["S4.M1.1"], ["S4.M1.1"]]] },
    nodes: [],
    sample_refs: {
      before: [{ trace: "a", model: "expert", task: row.task, sub: "", paths: ["S4.M1.1"] }],
      after: [],
    },
  };
  const chartHost = { clientWidth: 720, querySelector: () => null };
  const host = { innerHTML: "", getBoundingClientRect: () => ({ width: 720 }),
    querySelector: (selector) => selector === "#abCellTrend" ? chartHost : null,
    querySelectorAll: () => [], addEventListener() {} };
  const previousWindow = globalThis.window;
  const previousRAF = globalThis.requestAnimationFrame;
  globalThis.window = { addEventListener() {} };
  globalThis.requestAnimationFrame = () => 0;
  let mounted = null;
  const mount = (metric) => mountAB(host, { rounds: [released] },
    { round: 0, step: "matrix", metric, cell: { row, col } }, {}, null,
    { mountCellTrend: (...args) => { mounted = args; } });
  try {
    mount("paired");
    assert.doesNotMatch(host.innerHTML, /ab-trendpath|ab-trendlegend|ab-trendvals/);
    assert.ok(mounted, "the AB chart must use the shared sample drawer mount");
    assert.equal(mounted[0], chartHost);
    const { kline, picks } = mounted[1];
    assert.deepEqual(kline.candles.map((c) => [c.time, c.open, c.close, c.volume]), [["2026-11-06", 95, 60, 120]]);
    assert.deepEqual(kline.releases, [{ date: "2026-11-06", label: "v1106" }]);
    assert.deepEqual(picks.get("2026-11-06").sides, ["before", "after"]);
    assert.match(host.innerHTML, /优化前<\/span><b class="num">95<\/b><span>个问题<\/span><span class="ab-trendstat-sep">·<\/span><b class="num">1<\/b><span>条 Trace<\/span>/);
    assert.match(host.innerHTML, /优化后<\/span><b class="num">60<\/b><span>个问题<\/span><span class="ab-trendstat-sep">·<\/span><b class="num">0<\/b><span>条 Trace<\/span>/);
    assert.match(host.innerHTML, /data-trend-samples data-sides="before"/);
    assert.doesNotMatch(host.innerHTML, /ab-trendacts|ab-samplechip|data-sides="after"/);
  } finally {
    globalThis.window = previousWindow;
    globalThis.requestAnimationFrame = previousRAF;
  }
});

test("AB matrix paints four numbers in every change cell without online metric switcher", () => {
  const row = { name: "未接入分类体系", task: "未接入分类体系", sub: "" };
  const rowBefore = [row.task, "", [["S4.M1.1", 95]], 95];
  const rowAfter = [row.task, "", [["S4.M1.1", 60]], 60];
  const pairs = Array.from({ length: 120 }, (_, i) => ({
    scene: row.task, sub: "",
    before: { paths: i < 95 ? ["S4.M1.1"] : [], n: i < 95 ? 1 : 0 },
    after: { paths: i < 60 ? ["S4.M1.1"] : [], n: i < 60 ? 1 : 0 },
  }));
  const post = {
    label: "v1106",
    sides: { before: { hits: 95, traces: 95 }, after: { hits: 60, traces: 60 } },
    matrix: { before: [rowBefore], after: [rowAfter] },
    pairs,
    common: {
      total: 120,
      scenes: [[row.task, "", 120]],
      rows: pairs.map((pair) => [row.task, "", pair.before.paths, pair.after.paths]),
    },
    fixed: { total: 120, before: 120, after: 120 },
    nodes: [],
  };
  const host = { innerHTML: "", getBoundingClientRect: () => ({ width: 720 }),
    querySelector: () => null, querySelectorAll: () => [], addEventListener() {} };
  const previousWindow = globalThis.window, previousRAF = globalThis.requestAnimationFrame;
  globalThis.window = { addEventListener() {} };
  globalThis.requestAnimationFrame = () => 0;
  try {
    post.models = ["expert"];
    mountAB(host, { rounds: [post] }, { round: 0, step: "matrix", cell: null }, {}, null, {});
    assert.doesNotMatch(host.innerHTML, /data-act="metric"/);
    assert.doesNotMatch(host.innerHTML, /线上真实/);
    assert.doesNotMatch(host.innerHTML, /class="ab-round"/);
    assert.match(host.innerHTML, /未接入分类体系<em class="mx-vol num">120<\/em>/);
    assert.match(host.innerHTML, /<span class="cell-pair"><b class="is-from">95<\/b><i class="cell-arrow"[^>]*>→<\/i><b class="is-to">60<\/b><\/span><span class="cell-delta"><b class="cell-delta-num"><span class="cell-sign">−<\/span>35<\/b><i class="cell-dot"[^>]*>·<\/i><span class="cell-ratio">37%<\/span><\/span>/);
    assert.match(host.innerHTML, /变化合计/);
    assert.doesNotMatch(host.innerHTML, /data-mx="/);
    assert.match(host.innerHTML, /data-tip="[^"]*同题变化 −35 · 36.8%/);
    assert.match(host.innerHTML, /优化前 95 → 优化后 60/);
  } finally {
    globalThis.window = previousWindow;
    globalThis.requestAnimationFrame = previousRAF;
  }
  const cell = { before: 95, after: 60 };
  assert.equal(metricValue(cell, "paired", post), -35);
  assert.equal(metricValue(cell, "before", post), 95);
  assert.equal(metricValue(cell, "after", post), 60);
  assert.equal(metricValue(cell, "paired", { sides: { before: {} } }), null);
  assert.equal(metricValue(cell, "after", { sides: { after: null } }), null);
});

test("AB round records are head chips tagged with one of expert / fast / fast+expert", () => {
  const round = (label, models) => ({ label, models, sides: { before: { hits: 1 } } });
  const expert = abRoundsHTML([round("v1106", ["expert"])], 0);
  assert.match(expert, /class="ab-round" data-act="round" data-i="0" aria-pressed="true"/);
  assert.match(expert, /class="ab-model">expert</);
  assert.match(abRoundsHTML([round("v1106", ["fast"])], 0), /class="ab-model">fast</);
  assert.match(abRoundsHTML([round("v1106", ["fast", "expert"])], 0), /class="ab-model">fast\+expert</);
  assert.doesNotMatch(abRoundsHTML([round("v1106", [])], 0), /class="ab-model"/);
  const two = abRoundsHTML([round("v1030", ["fast"]), round("v1106", ["expert"])], 1);
  assert.equal((two.match(/class="ab-round"/g) || []).length, 2, "a new AB round is one more head chip");
  assert.match(two, /data-i="1" aria-pressed="true"/);
});

test("AB cell tooltips carry the same four numbers as the change cell", () => {
  const released = { sides: { before: {}, after: {} } };
  const s1 = { before: 95, after: 60 };
  const paired = metricTip(s1, "paired", released);
  assert.equal(paired.value, "同题变化 −35");
  assert.equal(paired.note, "优化前 95 → 优化后 60");
  assert.equal(metricTip(s1, "before", released).value, "优化前 95");
  assert.equal(metricTip(s1, "after", released).value, "优化后 60");
  assert.equal(metricTip({ before: 5, after: 0 }, "paired", { sides: { before: {} } }).value, "同题变化 —");
});

test("AB cloud sample refs keep phase, scene and taxonomy prefix aligned with the selected point", () => {
  const before = { trace: "a", task: "查询", sub: "行情", paths: ["S1.M2.1"] };
  const after = { trace: "b", task: "查询", sub: "行情", paths: ["S1.M2.2"], detail: "after-1" };
  const otherScene = { ...after, sub: "公告" };
  const otherPrefix = { ...after, paths: ["S10.M2.1"] };
  const round = { sample_refs: { before: [before], after: [after, otherScene, otherPrefix] } };
  const row = { task: "查询", sub: "行情" };
  assert.deepEqual(abTrendSampleRefs(round, ["before"], row, "S1"), [{ ...before, side: "before" }]);
  assert.deepEqual(abTrendSampleRefs(round, ["after"], row, "S1"), [{ ...after, side: "after" }]);
  assert.deepEqual(abTrendSampleRefs(round, ["after"], { group: true, tasks: ["查询"] }, "S1").length, 2);
  assert.deepEqual(abTrendSampleRefs({}, ["before"], row, "S1"), []);
});

test("AB layout leaf refs keep the side and match the taxonomy prefix", () => {
  const before = { trace: "a", pair: "a", q: "Q", detail: "before-1", paths: ["S1.M2.1"] };
  const after = { trace: "b", pair: "b", q: "Q", detail: "after-3", paths: ["S1.M2.2"] };
  const round = { sample_refs: { before: [before], after: [after] } };
  assert.deepEqual(abLeafRefs(round, ["before"], "S1"), [{ ...before, side: "before" }]);
  assert.deepEqual(abLeafRefs(round, ["after"], "S1.M2"), [{ ...after, side: "after" }]);
  assert.deepEqual(abLeafRefs(round, ["after"], "S10"), []);
  assert.deepEqual(abLeafRefs({}, ["before"], "S1"), []);
});

test("AB sample navigation opens both before and after self-contained details", () => {
  const beforeRef = { side: "before", trace: "a", pair: "a", detail: "before-7", q: "Q", model: "expert", paths: ["S1.M2.1"] };
  const resolved = resolveABSamples([beforeRef], [], "S1");
  assert.equal(resolved.items[0].row.s, "before-7");
  assert.equal(resolved.items[0].ref, beforeRef);
  assert.equal(resolved.items[0].n, 1);
  // A side without a generated detail cannot open.
  assert.deepEqual(resolveABSamples([{ side: "after", trace: "a", paths: ["S1.M2.1"] }], [], "S1"), { items: [], unavailable: 1 });
  const afterRef = { ...beforeRef, side: "after", detail: "after-7" };
  const after = resolveABSamples([afterRef], [], "S1");
  assert.equal(after.items[0].row.s, "after-7");
  assert.equal(after.items[0].ref, afterRef);
});

test("sample recall filters the selected day, series, scene and taxonomy boundary", () => {
  const base = { s: "hit", d: "2026-11-01", m: "a", ut: "real", task: "查询", sub: "行情", pt: ["S1.M2.1"] };
  const rows = [base, { ...base, s: "other-day", d: "2026-11-02" }, { ...base, s: "other-model", m: "b" },
    { ...base, s: "other-source", ut: "internal" }, { ...base, s: "other-scene", sub: "公告" },
    { ...base, s: "other-prefix", pt: ["S10.M2.1"] }];
  const spec = { date: base.d, node: "S1", models: ["a"], uts: ["real"], scenes: [["查询", "行情"]] };
  assert.deepEqual(trendSampleCandidates(rows, spec).map((row) => row.s), ["hit"]);
  assert.deepEqual(trendSampleCandidates([{ ...base, ut: undefined }], { ...spec, uts: ["unknown"] }).map((row) => row.s), ["hit"]);
  assert.equal(trendSampleCandidates([{ ...base, d: "" }], spec).length, 0);
});

test("sample severity filters actual matching problems even when the Session has a worse label", () => {
  const problem = { sev: "P2", cl: { path: "S1.M2.1" } };
  const detail = { attribution: { problems: [problem, { sev: "P0", cl: { path: "S1.M2.2" } }, { sev: "P2", cl: { path: "S10.M2.1" } }] } };
  assert.deepEqual(trendSampleProblems(detail, "S1", ["P2"]), [problem]);
  assert.deepEqual(trendSampleProblems(detail, "S1.M2.1", ["P0"]), []);
});

test("Trace sample references preserve date and exclusive severity including clean traces", () => {
  const refs = [[0, "s1", 0, 0, "a"], [0, "s1", 1, 5, "b"], [1, "s2", 0, 0, "c"]];
  const source = { ...trend, trace_severity: { levels: ["P0", "P1", "P2", "P3", "P4", "none"], refs } };
  assert.deepEqual(traceSampleRefs(source, trend.dates[0], "P0"), [refs[0]]);
  assert.deepEqual(traceSampleRefs(source, trend.dates[0], "none"), [refs[1]]);
  assert.deepEqual(traceSampleRefs(source, "2026-01-01", "P0"), []);
  assert.deepEqual(traceSampleRefs(trend, trend.dates[0], "P0"), []);
});

test("daily top model computes top 10 most frequent and top 10 most dropped problems for every day without secondary headings or small print", () => {
  const leafCodes = Array.from({ length: 12 }, (_, i) => `S1.M1.${i + 1}`);
  const nodes = ["S1", "S1.M1", ...leafCodes];
  const tax = {
    stages: [{ id: "S1", name: "取数规划" }],
    mechanisms: [{ id: "M1", name: "漏掉" }],
    patterns: Object.fromEntries(leafCodes.map((code, i) => [code, { name: `问题模式${i + 1}`, plain: `现象${i + 1}` }])),
  };
  const cells = [];
  // Day 0 vs Day 1: 12 problems where 10 have higher volume-adjusted baseline on Day 0 and drop on Day 1
  leafCodes.forEach((_, i) => {
    const ni = i + 2;
    const c0 = 40 + i * 5;
    const c1 = Math.max(2, c0 - (i + 1) * 2);
    cells.push([0, 0, ni, 0, 0, 2, 3, c0 - 5, 0, 0, 1, 1, 5, 0, 0, 7]);
    cells.push([1, 0, ni, 0, 0, 1, 1, Math.max(0, c1 - 2), 0, 0, 1, 1, 2, 0, 0, 4]);
  });
  const fixture = {
    dates: ["2026-11-16", "2026-11-17"],
    nodes,
    base: [[0, 0, 0, 0, 300], [1, 0, 0, 0, 100]],
    cells,
  };
  const model = buildDailyTopModel(fixture, tax);
  assert.ok(model);
  assert.equal(model.days.length, 2);
  model.days.forEach((day) => {
    assert.equal(day.topAppear.length, 10);
    assert.equal(day.topDrop.length, 10);
    assert.ok(day.topAppear[0].count >= day.topAppear[9].count);
    assert.ok(day.topDrop[0].delta <= day.topDrop[9].delta);
    assert.ok(day.topDrop.every((item) => item.delta < 0));
  });

  const html = dailyTopHTML(model, "2026-11-17");
  assert.match(html, /class="mxd-heat"/);
  assert.equal((html.match(/data-daily-day="/g) || []).length, 2, "two evaluated days in 2026-11 are interactive buttons");
  assert.equal((html.match(/class="mxd-day is-empty"/g) || []).length, 28, "remaining 28 days of November render as complete calendar month slots");
  assert.doesNotMatch(html, /mxd-day-val/, "date heatmap cells only show the date without numbers");
  assert.equal((html.match(/class="mxd-row is-top"/g) || []).length, 10);
  assert.equal((html.match(/class="mxd-row is-drop"/g) || []).length, 10);
  assert.match(html, /问题模式12/);
  assert.match(html, /data-daily-flip="line"/);
  assert.match(html, /data-daily-metric="problems"/);
  assert.match(html, /data-daily-metric="traces"/);
  assert.match(html, /data-daily-metric="ratio"/);
  assert.match(html, /data-daily-dir="up"/);
  assert.match(html, /data-daily-dir="down"/);
  assert.match(html, /data-daily-zoom aria-pressed="false"/);
  assert.doesNotMatch(html, /<h3|<h4|<small|<p\b/, "no secondary headings or small-print notes allowed");

  // Full calendar month pagination: dates in Oct (31 days) and Nov (30 days) split into 2 full calendar months
  const pagesOctNov = buildHeatPages([
    { date: "2026-10-15" },
    { date: "2026-10-31" },
    { date: "2026-11-01" },
    { date: "2026-11-17" },
  ]);
  assert.equal(pagesOctNov.length, 2);
  assert.equal(pagesOctNov[0].length, 31, "October has 31 calendar days");
  assert.equal(pagesOctNov[0][0].date, "2026-10-01");
  assert.equal(pagesOctNov[0][30].date, "2026-10-31");
  assert.equal(pagesOctNov[1].length, 30, "November has 30 calendar days");
  assert.equal(pagesOctNov[1][0].date, "2026-11-01");
  assert.equal(pagesOctNov[1][29].date, "2026-11-30");

  // Centered floating detail card when clicking a date cell, with clickable P0-P4 severity highlight
  const modalHtml = dayModalHTML(model.byDate.get("2026-11-17"));
  assert.match(modalHtml, /class="mxd-modal-backdrop mxd-pop-anchor"/);
  assert.match(modalHtml, /2026-11-17/);
  assert.match(modalHtml, /当日最多/);
  assert.match(modalHtml, /下降最多/);
  assert.match(modalHtml, /data-daily-sev="P0"/);
  assert.match(modalHtml, /data-daily-sev="P4"/);
  for (const label of ["P0", "P1", "P2", "P3", "P4", "无问题"]) {
    assert.ok(modalHtml.includes(label), `day modal includes ${label}`);
  }
  const modalHtmlP0 = dayModalHTML(model.byDate.get("2026-11-17"), "P0");
  assert.match(modalHtmlP0, /mxd-tip-arc is-active" data-daily-sev="P0"/);
  assert.match(modalHtmlP0, /mxd-tip-center is-sev-focus/);
  assert.match(html, /data-daily-month="2026-10"/, "month pager always allows navigating to previous calendar months");

  // Beginner-friendly structured tooltips with explicit + / - signs
  const dayTip = resolveDailyTip({
    dataset: {
      mxdTipKind: "day",
      date: "2026-11-17",
      problems: "18,099",
      traces: "5,702",
      ratio: "3.17",
      sevs: "95,1646,5662,1967,8729",
      traceSevs: "93,1272,2538,456,712,631",
    },
  });
  assert.match(dayTip, /class="mxd-tip-ring"/);
  assert.match(dayTip, /<div class="t-head">2026-11-17<\/div>/);
  assert.match(dayTip, /问题数 <b class="num">18,099<\/b>/);
  assert.match(dayTip, /Trace 数 <b class="num">5,702<\/b>/);
  assert.match(dayTip, /问题\/Trace <b class="num">3\.17<\/b>/);
  for (const label of ["P0", "P1", "P2", "P3", "P4", "无问题"]) {
    assert.ok(dayTip.includes(label), `day tooltip includes ${label}`);
  }
  assert.match(dayTip, /631 Trace/);
  const topTip = resolveDailyTip({ dataset: { mxdTipKind: "top", name: "问题模式12", stage: "取数规划", prev: "80", count: "95", delta: "15", sevs: "1,4,30,20,40", prevSevs: "1,4,20,20,35", plain: "现象12" } });
  assert.match(topTip, /<span>较前日变化<\/span><b class="num is-up">\+15<\/b>/);
  assert.match(topTip, /\(\+10\)/);
  assert.match(topTip, /<div class="t-note">现象12<\/div>/);
  const dropTip = resolveDailyTip({ dataset: { mxdTipKind: "drop", name: "问题模式12", stage: "取数规划", prev: "95", count: "71", drop: "24", dropPct: "25%", sevs: "1,4,20,16,30", prevSevs: "1,4,30,20,40", plain: "现象12" } });
  assert.match(dropTip, /<span>较前日下降<\/span><b class="num is-down">-24 \(-25%\)<\/b>/);
  assert.match(dropTip, /\(-10\)/);

  let clickedHandler = null;
  const dayBtns = [{ dataset: { dailyDay: "2026-11-16" }, classList: { toggle() {} }, setAttribute() {} },
    { dataset: { dailyDay: "2026-11-17" }, classList: { toggle() {} }, setAttribute() {} }];
  const boardsEl = { innerHTML: "" };
  const modalSlotEl = { innerHTML: "" };
  const host = {
    innerHTML: "",
    addEventListener: (_ev, fn) => { clickedHandler = fn; },
    removeEventListener() {},
    querySelectorAll: () => dayBtns,
    querySelector: (sel) => (sel === "#mxdBoards" ? boardsEl : sel === "#mxdModalSlot" ? modalSlotEl : null),
  };
  const state = {};
  let pickedProblem = null;
  mountDailyTop(host, fixture, tax, state, { onPickProblem: (p) => { pickedProblem = p; } });
  assert.equal(state.dailyDay, "2026-11-17");
  clickedHandler({ target: { closest: (sel) => (sel === "[data-daily-day]" ? dayBtns[0] : null) } });
  assert.equal(state.dailyDay, "2026-11-16");
  assert.equal(state.dailyModalDate, undefined);
  assert.equal(modalSlotEl.innerHTML, "");
  assert.match(boardsEl.innerHTML, /2026-11-16 出现最多 TOP 10/);
  clickedHandler({ target: { closest: (sel) => (sel === "[data-daily-day]" ? dayBtns[0] : null) } });
  assert.equal(state.dailyModalDate, "2026-11-16");
  assert.match(modalSlotEl.innerHTML, /mxd-modal-backdrop/);
  const rowTarget = { dataset: { dailyCode: "S1.M1.12", dailyName: "问题模式12" } };
  clickedHandler({ target: { closest: (sel) => (sel === "[data-daily-code]" ? rowTarget : null) } });
  assert.equal(pickedProblem.code, "S1.M1.12");

  // Zoom lock defaults to false and toggles on [data-daily-zoom] click
  assert.equal(state.dailyZoom, false);
  const zoomTarget = { attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, title: "" };
  clickedHandler({ target: { closest: (sel) => (sel === "[data-daily-zoom]" ? zoomTarget : null) } });
  assert.equal(state.dailyZoom, true);
  assert.equal(zoomTarget.attrs["aria-pressed"], "true");
});
