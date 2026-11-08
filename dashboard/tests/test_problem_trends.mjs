import assert from "node:assert/strict";
import test from "node:test";

// These modules share the dashboard's formatting helpers; no DOM is needed by the data seam.
globalThis.location = { search: "" };
globalThis.window = {};
const { buildProblemTrendModel, problemRateValues, problemTrendChart, mountProblemTrends } = await import("../static/js/problem_trends.js");
const { traceSeverityModel, traceShares } = await import("../static/js/trace_analysis.js");
const { lineTrendSVG, nearestTrendPoint, wireTrendPointPick, wireLineTrendChart, nebulaCluster } = await import("../static/js/trend_chart.js");
const { abComparisonHTML, abRoundsHTML, mountAB, metricValue, metricTip } = await import("../static/js/abtest.js");
const { matrixHeatSummary } = await import("../static/js/matrix_heat.js");
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

test("calendar spacing preserves missing days and date labels face inward", () => {
  const chart = lineTrendSVG({
    width: 240, height: 76, compact: true,
    xLabels: ["10-01", "10-02", "10-10"], xDates: trend.dates,
    series: [{ label: "答案合成", color: "blue", values: [80, 60, 40] }],
  });
  assert.equal((chart.geo.xOf(1) - chart.geo.xOf(0)) / (chart.geo.xOf(2) - chart.geo.xOf(0)), 1 / 9);
  assert.match(chart.html, /text-anchor:start[^>]*>10-01/);
  assert.match(chart.html, /text-anchor:end[^>]*>10-10/);
  assert.doesNotMatch(chart.html, /<title>/); // Custom chart hover owns the tooltip; no second native popup.
});

test("drillable chart hover waits briefly and clears on press, touch and navigation", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const events = new Map();
  const tipClasses = new Set(), cursorClasses = new Set();
  const classList = (set) => ({ add: (key) => set.add(key), remove: (key) => set.delete(key) });
  const mark = () => ({ setAttribute() {}, style: {} });
  const line = mark(), dot = mark();
  const cursor = { classList: classList(cursorClasses), querySelectorAll: (selector) => selector === "line" ? [line] : [dot] };
  const svg = {
    querySelector: () => cursor, getBoundingClientRect: () => ({ left: 0, top: 0, width: 320, height: 170 }),
    addEventListener: (type, handler) => events.set(type, handler),
    removeEventListener: (type) => events.delete(type),
  };
  const tip = { classList: classList(tipClasses), style: {}, offsetWidth: 200, offsetHeight: 60 };
  const previousDocument = globalThis.document, previousWindow = globalThis.window;
  globalThis.document = { getElementById: () => tip };
  globalThis.window = { innerWidth: 845, innerHeight: 880 };
  let enabled = true;
  try {
    const chart = lineTrendSVG({ width: 320, xLabels: ["10-01"], series: [{ label: "计算错误", values: [10] }] });
    const dispose = wireLineTrendChart({ querySelector: () => svg }, chart, "", null, { hoverDelay: 160, canHover: () => enabled });
    const move = { clientX: 100, clientY: 200, pointerType: "mouse", buttons: 0 };
    events.get("pointermove")(move);
    assert.equal(cursorClasses.has("is-on"), true);
    assert.equal(tipClasses.has("is-on"), false, "fast travel over a drill target should not flash a tooltip");
    t.mock.timers.tick(160);
    assert.equal(tipClasses.has("is-on"), true);
    events.get("pointerdown")({ pointerType: "mouse" });
    assert.equal(tipClasses.has("is-on"), false, "pressing the drill target must clear its hover");
    events.get("pointermove")(move);
    t.mock.timers.tick(80);
    events.get("pointerdown")({ pointerType: "mouse" });
    t.mock.timers.tick(160);
    assert.equal(tipClasses.has("is-on"), false, "pressing before the dwell finishes must cancel the pending tooltip");
    events.get("pointermove")(move);
    enabled = false;
    t.mock.timers.tick(160);
    assert.equal(tipClasses.has("is-on"), false, "a pending hover must not reopen over incoming charts");
    enabled = true;
    events.get("pointermove")({ ...move, pointerType: "touch" });
    t.mock.timers.tick(160);
    assert.equal(tipClasses.has("is-on"), false);
    events.get("pointermove")(move);
    dispose();
    t.mock.timers.tick(160);
    assert.equal(tipClasses.has("is-on"), false, "replaced charts must release pending hover work");
    assert.equal(events.size, 0);
  } finally {
    globalThis.document = previousDocument;
    globalThis.window = previousWindow;
  }
});

test("expanded charts preserve the curve and encode problem volume independently of probability", () => {
  const model = buildProblemTrendModel(trend, new Map([["S9", "答案合成"]]));
  const node = model.byId.get("S9");
  const small = problemTrendChart(model, node, [0, 1, 2], 240);
  const large = problemTrendChart(model, node, [0, 1, 2], 760, true);
  assert.deepEqual(large.geo.series[0].values, small.geo.series[0].values);
  assert.deepEqual(large.geo.series[0].volumes, [165, 1]);
  assert.equal(large.geo.H, 320);
  assert.match(large.html, /class="mxt-ylab"/);
  assert.match(large.geo.series[0].details[0], /165 个问题 · 80 \/ 100 会话/);
  assert.ok((large.html.match(/class="mxt-nebula-dot"/g) || []).length <= 32);
});

test("each category uses only its dated observations, without empty leading or trailing days", () => {
  const source = {
    dates: ["2026-10-01", "2026-10-02", "", "2026-10-10", "2026-10-11"], nodes: ["S9"],
    base: Array.from({ length: 5 }, (_, i) => [i, 0, 0, 0, 100]),
    cells: [cell(1, 0, 10, 8), cell(2, 0, 50, 40), cell(3, 0, 20, 15)],
  };
  const model = buildProblemTrendModel(source);
  const chart = problemTrendChart(model, model.byId.get("S9"), [0, 1, 2, 3, 4], 720, true);
  assert.deepEqual(chart.geo.xDates, ["2026-10-02", "2026-10-10"]);
  assert.deepEqual(chart.geo.series[0].values, [8, 15]);
  assert.deepEqual(chart.geo.series[0].volumes, [10, 20]);
  assert.deepEqual(chart.geo.xLabels, ["10-02", "10-10"]);
  const single = problemTrendChart(model, model.byId.get("S9"), [3, 4], 240);
  assert.deepEqual(single.geo.xDates, ["2026-10-10"]);
  assert.deepEqual(single.geo.series[0].values, [15]);
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
    const [element, node, renderChart, interaction] = mounted;
    assert.equal(element, plot);
    assert.equal(node, "S9");
    assert.deepEqual(renderChart(480).geo.xDates, ["2026-10-01", "2026-10-10"]);
    assert.deepEqual(renderChart(480).geo.series[0].levelIdxs, [0, 1, 2, 3, 4]);
    assert.equal(interaction.canHover(), true);
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

test("AB groups both released populations but keeps their volumes separate", () => {
  const html = abComparisonHTML({ sides: { before: { hits: 200, traces: 80 }, after: { hits: 60, traces: 30 }, online: { hits: 40, traces: 400 } } });
  assert.match(html, /height:112px/);
  assert.match(html, /height:34px/);
  assert.match(html, /height:22px/);
  assert.match(html, /同题复测/);
  assert.match(html, /线上真实/);
  assert.match(html, /30 有问题 Trace/);
  assert.match(html, /400 评测样本/);
  assert.doesNotMatch(html, /暂无结果|落点|待回填/);
});

test("AB comparison distinguishes missing results from measured zero problems", () => {
  const missing = abComparisonHTML({ sides: { before: { hits: 200 }, after: null } });
  assert.match(missing, /暂无结果/);
  assert.equal((missing.match(/class="evbar"/g) || []).length, 1);
  assert.doesNotMatch(missing, /减少/);
  const zero = abComparisonHTML({ sides: { before: { hits: 200 }, after: { hits: 0 } } });
  assert.equal((zero.match(/暂无结果/g) || []).length, 1); // Online remains independently missing.
  assert.equal((zero.match(/class="evbar"/g) || []).length, 2);
  const onlineOnly = abComparisonHTML({ sides: { before: { hits: 200 }, online: { hits: 40 } } });
  assert.doesNotMatch(onlineOnly, /同题减少|同题增加/);
  assert.equal((onlineOnly.match(/class="evbar"/g) || []).length, 2);
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
    assert.equal((host.innerHTML.match(/data-act="abcard"/g) || []).length, 3, "each card can take the row");
    assert.match(host.innerHTML, /class="ab-bridge-main"><b class="num is-better">−60<\/b><small>个问题<\/small>/);
    assert.match(host.innerHTML, /<span class="ab-bridge-pair num">125<i>→<\/i>65<\/span>/);
    const flows = [...host.innerHTML.matchAll(/class="ab-wf-label"><span>([^<]+)<\/span><b class="num" data-flow="([^"]+)">([^<]+)<\/b>/g)].map((m) => [m[1], m[2], m[3]]);
    assert.deepEqual(flows, [["消除", "clear", "−50"], ["减少", "down", "−40"], ["增加", "up", "+20"], ["新增", "add", "+10"]]);
    assert.equal((host.innerHTML.match(/class="ab-wf-col /g) || []).length, 4, "one floating step per flow");
    assert.doesNotMatch(host.innerHTML, /ab-flow-bar|ab-scope|ab-mxnote|<h3|<h4/);
  } finally {
    globalThis.window = previousWindow;
    globalThis.requestAnimationFrame = previousRAF;
  }
});

test("AB overview drops the change card while the release side has not been measured", () => {
  const rnd = { label: "v1106", sides: { before: { hits: 12 } }, leaves: [{ id: "S1.M1.1", name: "x", before: 12, after: null }], matrix: { before: [] }, nodes: [] };
  const host = { innerHTML: "", getBoundingClientRect: () => ({ width: 720 }),
    querySelector: () => null, querySelectorAll: () => [], addEventListener() {} };
  const previousWindow = globalThis.window, previousRAF = globalThis.requestAnimationFrame;
  globalThis.window = { addEventListener() {} };
  globalThis.requestAnimationFrame = () => 0;
  try {
    mountAB(host, { rounds: [rnd] }, { round: 0, step: "summary" }, {}, null, {});
    assert.match(host.innerHTML, /data-cards="2"/);
    assert.equal((host.innerHTML.match(/data-abcard="/g) || []).length, 2);
    assert.doesNotMatch(host.innerHTML, /ab-bridge-card/);
    assert.match(host.innerHTML, /暂无结果/);
  } finally {
    globalThis.window = previousWindow;
    globalThis.requestAnimationFrame = previousRAF;
  }
});

test("trend release marks land on the date axis and span the whole plot from top to bottom", () => {
  const chart = lineTrendSVG({
    width: 720, height: 260,
    xLabels: ["10-28", "10-30", "11-02", "11-06", "11-08"],
    xDates: ["2026-10-28", "2026-10-30", "2026-11-02", "2026-11-06", "2026-11-08"],
    series: [{ label: "问题", color: "var(--accent)", values: [1, 2, 3, 4, 5] }],
    releases: [{ date: "2026-10-30", label: "v1030" }, { date: "2026-11-06", label: "v1106" }, { date: "2026-12-01", label: "窗外" }],
  });
  assert.equal((chart.html.match(/class="mxt-release-line"/g) || []).length, 2, "only releases inside the window are drawn");
  assert.match(chart.html, />v1030</);
  assert.match(chart.html, />v1106</);
  assert.doesNotMatch(chart.html, /窗外/);
  assert.equal(chart.geo.releases.length, 2);
  assert.ok(Math.abs(chart.geo.releases[0].x - chart.geo.xOf(1)) < 0.01, "a release on a sample date uses that date's x");
  const line = chart.html.match(/class="mxt-release-line" x1="([\d.]+)" x2="([\d.]+)" y1="([\d.]+)" y2="([\d.]+)"/);
  assert.equal(Number(line[3]), chart.geo.PAD.t, "the release line starts on the top axis");
  assert.equal(Number(line[4]), chart.geo.PAD.t + chart.geo.innerH, "and ends on the bottom axis");
  assert.match(chart.html, /class="mxt-release-band"/);
  assert.match(chart.html, /class="mxt-release-dot"/);
});

test("compact trend cards keep release marks to a quiet hairline without labels", () => {
  const chart = lineTrendSVG({
    compact: true, width: 220, height: 76,
    xLabels: ["10-28", "11-06"], xDates: ["2026-10-28", "2026-11-06"],
    series: [{ label: "问题", color: "var(--accent)", values: [1, 2] }],
    releases: [{ date: "2026-11-06", label: "v1106" }],
  });
  assert.match(chart.html, /class="mxt-release-line is-compact"/);
  assert.doesNotMatch(chart.html, /mxt-release-band|mxt-release-dot|mxt-release-label/);
});

test("index-based release marks cover a categorical before/after axis", () => {
  const chart = lineTrendSVG({
    width: 720, height: 260, xLabels: ["改版前", "改版后"], xDates: ["改版前", "改版后"],
    series: [{ label: "问题", color: "var(--accent)", values: [3, 5] }],
    marks: [{ at: 0.5, label: "v1106" }],
  });
  assert.equal(chart.geo.releases.length, 1);
  assert.ok(Math.abs(chart.geo.releases[0].x - (chart.geo.PAD.l + chart.geo.innerW / 2)) < 0.01);
  assert.match(chart.html, />v1106</);
});

test("problem cluster dots are a deterministic, regular rosette instead of random scatter", () => {
  const args = { x: 100, y: 60, value: 1, max: 10, ratio: 0.4, color: "var(--accent)", maxDots: 10, spread: 9 };
  const one = nebulaCluster(args);
  const two = nebulaCluster(args);
  assert.equal(one, two, "the same point always draws the same mark");
  const dots = [...one.matchAll(/<circle class="mxt-nebula-dot" cx="([\d.-]+)" cy="([\d.-]+)" r="([\d.]+)"/g)];
  assert.ok(dots.length >= 3);
  const radii = dots.map(([, x, y]) => Math.hypot(Number(x) - 100, Number(y) - 60));
  assert.ok(Math.max(...radii) - Math.min(...radii) < 0.25, "a light point is one evenly spaced ring");
  dots.forEach(([, x, y, r]) => {
    assert.ok(Math.abs(Number(x) - 100) + Number(r) < 14, "never wider than the plot padding");
    assert.ok(Math.abs(Number(y) - 60) + Number(r) < 14);
  });
  const heavy = [...nebulaCluster({ ...args, value: 10 }).matchAll(/cx="([\d.-]+)" cy="([\d.-]+)"/g)];
  const heavyRadii = heavy.map(([, x, y]) => Math.hypot(Number(x) - 100, Number(y) - 60));
  assert.ok(Math.max(...heavyRadii) - Math.min(...heavyRadii) > 3, "a heavy point fills an outer ring around the inner one");
});

test("AB cell trends remove duplicate captions and use a labelled, full-height chart with sample interaction", () => {
  const row = { name: "未接入分类体系", task: "未接入分类体系", sub: "" };
  const col = { name: "本地计算", prefix: "S4" };
  const rnd = { label: "v1106", sides: { before: { hits: 95 }, after: null, online: null },
    matrix: { before: [[row.task, "", [["S4.M1.1", 95]]]] }, nodes: [] };
  const chartHost = { clientWidth: 720, querySelector: () => null };
  const host = { innerHTML: "", getBoundingClientRect: () => ({ width: 720 }),
    querySelector: (selector) => selector === "#abCellTrend" ? chartHost : null,
    querySelectorAll: () => [], addEventListener() {} };
  const previousWindow = globalThis.window;
  const previousRAF = globalThis.requestAnimationFrame;
  globalThis.window = { addEventListener() {} };
  globalThis.requestAnimationFrame = () => 0;
  let mounted = null;
  try {
    mountAB(host, { rounds: [rnd] }, { round: 0, step: "matrix", cell: { row, col } }, {}, null, {
      mountCellTrend: (...args) => { mounted = args; },
    });
    assert.doesNotMatch(host.innerHTML, /ab-trendpath|ab-trendlegend|ab-trendvals/);
    assert.match(host.innerHTML, /class="mxt-ylab"/);
    assert.match(host.innerHTML, /viewBox="0 0 720 260"/);
    assert.doesNotMatch(host.innerHTML, /class="mxt-end-line"/); // No line into the missing after result.
    assert.deepEqual(mounted[1].chart.marks, [{ at: 0.5, label: "v1106" }], "the release sits between 改版前 and 改版后");
    assert.match(host.innerHTML, /class="mxt-release-line"/);
    assert.match(host.innerHTML, /class="mxt-release-label"[^>]*>v1106</);
    assert.ok(mounted, "the AB chart must use the shared sample drawer mount");
    assert.equal(mounted[0], chartHost);
    const picks = mounted[1].chart.series[0].samples;
    assert.deepEqual(picks.map((pick) => pick.sides), [["before"], ["after"]]);
    assert.equal(mounted[1].chart.series[0].values[1], null, "without a released side the comparison has no second point");

    const released = { ...rnd, sides: { ...rnd.sides, after: { hits: 60 }, online: { hits: 40 } },
      matrix: { ...rnd.matrix, after: [[row.task, "", [["S4.M1.1", 60]]]], online: [[row.task, "", [["S4.M1.1", 40]]]] },
      sample_refs: {
        before: [{ trace: "a", model: "expert", task: row.task, sub: "", paths: ["S4.M1.1"] }],
        after: [],
        online: [{ trace: "b", model: "expert", task: row.task, sub: "", paths: ["S4.M1.1"], slug: "online-sample" }],
      } };
    mountAB(host, { rounds: [released] }, { round: 0, step: "matrix", cell: { row, col } }, {}, null, {
      mountCellTrend: (...args) => { mounted = args; },
    });
    assert.deepEqual(mounted[1].chart.series[0].values, [95, 60], "同题变化 reads the fixed set alone");
    assert.deepEqual(mounted[1].chart.series[0].samples.map((pick) => pick.sides), [["before"], ["after"]]);
    assert.match(host.innerHTML, /同题变化 <b class="num">−35<\/b>/);

    mountAB(host, { rounds: [released] }, { round: 0, step: "matrix", metric: "delta", cell: { row, col } }, {}, null, {
      mountCellTrend: (...args) => { mounted = args; },
    });
    assert.equal(mounted[1].chart.series.length, 1);
    assert.deepEqual(mounted[1].chart.series[0].values, [95, 100], "同题+线上变化 compares 发版前 with 复测 + 线上真实");
    assert.deepEqual(mounted[1].chart.series[0].samples.map((pick) => pick.sides), [["before"], ["after", "online"]]);
    assert.deepEqual(mounted[1].chart.xLabels, ["改版前", "发版后"]);
    assert.match(host.innerHTML, /改版前样本/);
    assert.match(host.innerHTML, /线上真实样本/);
    assert.match(host.innerHTML, /data-sides="online"/);

    mountAB(host, { rounds: [released] }, { round: 0, step: "matrix", metric: "post", cell: { row, col } }, {}, null, {
      mountCellTrend: (...args) => { mounted = args; },
    });
    assert.deepEqual(mounted[1].chart.series[0].values, [95, 100], "the post-release reading is retest + online");
    assert.deepEqual(mounted[1].chart.series[0].samples.map((pick) => pick.sides), [["before"], ["after", "online"]]);
    assert.deepEqual(mounted[1].chart.xLabels, ["改版前", "发版后"]);
    assert.match(host.innerHTML, /发版后 <b class="num">100<\/b>/);
  } finally {
    globalThis.window = previousWindow;
    globalThis.requestAnimationFrame = previousRAF;
  }
});

test("AB matrix offers change / pre-release / post-release metrics and sums retest with online", () => {
  const row = { name: "未接入分类体系", task: "未接入分类体系", sub: "" };
  const side = (n) => ({ traces: n, hits: n, matrix: [[row.task, "", [["S4.M1.1", n]]]] });
  const post = {
    label: "v1106",
    sides: { before: side(95), after: side(60), online: side(40) },
    matrix: { before: side(95).matrix, after: side(60).matrix, online: side(40).matrix },
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
    assert.equal((host.innerHTML.match(/data-act="metric"/g) || []).length, 4, "two change readings + before + post");
    assert.match(host.innerHTML, /data-metric="paired" aria-pressed="true"/);
    assert.match(host.innerHTML, /同题变化/);
    assert.match(host.innerHTML, /同题\+线上变化/);
    assert.match(host.innerHTML, /data-metric="before"/);
    assert.match(host.innerHTML, /data-metric="post"/);
    assert.doesNotMatch(host.innerHTML, /data-metric="(all|after|online)"/);
    assert.match(host.innerHTML, /发版后（同题回测\+线上真实）/);
    assert.doesNotMatch(host.innerHTML, /class="ab-round"/); // the records live in the card head
    assert.doesNotMatch(host.innerHTML, /ab-mxnote|ab-scope/);
    // The shared session-matrix tooltip resolver owns [data-mx]; AB cells must opt out of it and
    // carry their own metric-aware data-tip instead.
    assert.doesNotMatch(host.innerHTML, /data-mx="/);
    assert.match(host.innerHTML, /data-tip="[^"]*同题变化 −35/);
    assert.match(host.innerHTML, /同题基线 95 → 同题复测 60/);
  } finally {
    globalThis.window = previousWindow;
    globalThis.requestAnimationFrame = previousRAF;
  }
  const cell = { before: 95, after: 60, online: 40 };
  assert.equal(metricValue(cell, "paired", post), -35);
  assert.equal(metricValue(cell, "delta", post), 5);
  assert.equal(metricValue(cell, "before", post), 95);
  assert.equal(metricValue(cell, "post", post), 100);
  assert.equal(metricValue(cell, "post", { sides: { after: {} } }), 60);
  assert.equal(metricValue(cell, "post", { sides: { online: {} } }), 40);
  assert.equal(metricValue(cell, "post", { sides: {} }), null);
  assert.equal(metricValue(cell, "delta", { sides: {} }), null);
  assert.equal(metricValue(cell, "paired", { sides: { online: {} } }), null);
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

test("AB cell tooltips explain the printed number with the same sides and arithmetic", () => {
  const released = { sides: { before: {}, after: {}, online: {} } };
  const s1 = { before: 0, after: 0, online: 547 };
  const paired = metricTip(s1, "paired", released);
  assert.equal(paired.value, "同题变化 0");
  assert.equal(paired.note, "同题基线 0 → 同题复测 0");
  const delta = metricTip(s1, "delta", released);
  assert.equal(delta.value, "同题+线上变化 +547");
  assert.match(delta.note, /同题基线 0 → 发版后 547（同题复测 0 \+ 线上真实 547）/, "同题+线上变化 must compare 发版前 with 复测 + 线上真实");
  const post = metricTip(s1, "post", released);
  assert.equal(post.value, "发版后 547");
  assert.equal(post.note, "同题复测 0 + 线上真实 547");
  assert.equal(metricTip(s1, "before", released).value, "发版前 0");
  assert.equal(metricTip({ before: 5, after: 0, online: 0 }, "delta", { sides: { before: {} } }).value, "同题+线上变化 —");
  assert.equal(metricTip({ before: 5, after: 0, online: 0 }, "paired", { sides: { before: {} } }).value, "同题变化 —");
});

test("AB cloud sample refs keep phase, scene and taxonomy prefix aligned with the selected point", () => {
  const before = { trace: "a", task: "查询", sub: "行情", paths: ["S1.M2.1"] };
  const online = { slug: "online", trace: "b", task: "查询", sub: "行情", paths: ["S1.M2.2"] };
  const otherScene = { ...online, slug: "other", sub: "公告" };
  const otherPrefix = { ...online, slug: "prefix", paths: ["S10.M2.1"] };
  const round = { sample_refs: { before: [before], after: [], online: [online, otherScene, otherPrefix] } };
  const row = { task: "查询", sub: "行情" };
  assert.deepEqual(abTrendSampleRefs(round, ["before"], row, "S1"), [{ ...before, side: "before" }]);
  assert.deepEqual(abTrendSampleRefs(round, ["after", "online"], row, "S1"), [{ ...online, side: "online" }]);
  assert.deepEqual(abTrendSampleRefs(round, ["online"], { group: true, tasks: ["查询"] }, "S1").map((ref) => ref.slug), ["online", "other"]);
  assert.deepEqual(abTrendSampleRefs({}, ["before"], row, "S1"), []);
});

test("AB layout leaf refs keep the side and match the taxonomy prefix", () => {
  const before = { trace: "a", pair: "a", q: "Q", paths: ["S1.M2.1"] };
  const after = { trace: "b", pair: "b", q: "Q", detail: 3, paths: ["S1.M2.2"] };
  const online = { slug: "online", trace: "c", q: "Q", paths: ["S1.M2.2"] };
  const round = { sample_refs: { before: [before], after: [after], online: [online] } };
  assert.deepEqual(abLeafRefs(round, ["before"], "S1"), [{ ...before, side: "before" }]);
  assert.deepEqual(abLeafRefs(round, ["after", "online"], "S1.M2"), [{ ...after, side: "after" }, { ...online, side: "online" }]);
  assert.deepEqual(abLeafRefs(round, ["after"], "S10"), []);
  assert.deepEqual(abLeafRefs({}, ["before"], "S1"), []);
});

test("AB sample navigation opens the exact retest detail without borrowing the baseline", () => {
  const row = { s: "baseline", tid: "a", m: "aime_expert" };
  const ref = { side: "before", trace: "a", model: "expert", paths: ["S1.M2.1"] };
  const resolved = resolveABSamples([ref], [row], "S1");
  assert.equal(resolved.items[0].row, row);
  assert.equal(resolved.items[0].ref, ref);
  assert.equal(resolved.items[0].n, 1);
  // A retest with no generated detail cannot open, and must not substitute the baseline.
  assert.deepEqual(resolveABSamples([{ ...ref, side: "after" }], [row], "S1"), { items: [], unavailable: 1 });
  // Schema 3: the retest carries its own eq reference, so no recall-index row is needed.
  const retest = { ...ref, side: "after", pair: "a", detail: 7, q: "Q" };
  const after = resolveABSamples([retest], [row], "S1");
  assert.equal(after.items[0].row.s, "7");
  assert.equal(after.items[0].ref, retest);
  // An online ref still resolves through its sample slug.
  const online = { side: "online", slug: "live-1", paths: ["S1.M2.2"] };
  assert.equal(resolveABSamples([online], [row, { ...row, s: "live-1" }], "S1").items[0].row.s, "live-1");
  // A baseline trace that matches more than one index row stays unavailable: never guess.
  assert.deepEqual(resolveABSamples([ref], [row, { ...row, s: "retest" }], "S1"), { items: [], unavailable: 1 });
});

test("heatmap drills only the taxonomy axis and reads each parent union once", () => {
  const leaf = { name: "加工计算错误", prefix: "S9.M5.1" };
  const mechanism = { name: "计算", prefix: "S9.M5", children: [leaf] };
  const stage = { name: "答案合成", prefix: "S9", children: [mechanism] };
  const root = { children: [stage] };
  const scenes = new Set([0]);
  const top = matrixHeatSummary(trend, root, [], scenes);
  const middle = matrixHeatSummary(trend, root, ["S9"], scenes);
  const bottom = matrixHeatSummary(trend, root, ["S9", "S9.M5"], scenes);
  assert.deepEqual(top.dates, bottom.dates);
  assert.deepEqual(top.daily, bottom.daily);
  assert.deepEqual(top.daily.map((day) => day.sessions), [100, 100, 100]);
  assert.equal(top.groups[0].days[0].hits, 80);
  assert.equal(middle.groups[0].days[0].hits, 60);
  assert.equal(bottom.groups[0].days[0].hits, 50);
  assert.equal(bottom.groups[0].days[1].observed, true); // Evaluated day with no matching problem is a real zero.
  assert.equal(bottom.groups[0].days[1].hits, 0);
  assert.deepEqual(bottom.path.map((node) => node.prefix), ["S9", "S9.M5"]);
  const invalid = matrixHeatSummary(trend, root, ["S9", "other", "S9.M5"], scenes);
  assert.deepEqual(invalid.path.map((node) => node.prefix), ["S9"]);
  assert.deepEqual(matrixHeatSummary(trend, root, [], new Set([1])).daily.map((day) => day.sessions), [0, 0, 0]);
  assert.equal(matrixHeatSummary(trend, null), null);
});

test("heatmap preserves missing union data instead of summing overlapping severities", () => {
  const root = { children: [{ name: "答案合成", prefix: "S9" }] };
  const legacy = { ...trend, cells: [cell(0, 0, 165, 80).slice(0, 15)] };
  const day = matrixHeatSummary(legacy, root, [], new Set([0])).groups[0].days[0];
  assert.equal(day.n, 165);
  assert.equal(day.observed, false);
  assert.equal(day.hits, 0);
});

test("point picking chooses the closest observed date and series, excluding missing and ghost points", () => {
  const { geo } = lineTrendSVG({
    width: 720, xLabels: ["01", "02", "10"], xDates: trend.dates,
    series: [{ values: [20, null, 80] }, { values: [50, 60, 40] }, { ghost: true, values: [90, 90, 90] }],
  });
  assert.deepEqual(nearestTrendPoint(geo, geo.xOf(2) + 2, geo.yOf(40) + 2), { series: 1, index: 2 });
  assert.deepEqual(nearestTrendPoint(geo, geo.xOf(0), geo.yOf(20)), { series: 0, index: 0 });
  assert.equal(nearestTrendPoint(geo, geo.xOf(1), geo.yOf(20), 1), null);
  assert.equal(nearestTrendPoint(geo, geo.xOf(1), geo.yOf(90), 1), null);
  assert.equal(nearestTrendPoint(geo, -100, -100), null);
});

test("overlapping point clicks and keyboard activation open the exact series with a return target", () => {
  const listeners = {}, attributes = {};
  const point = {
    dataset: { trendPoint: "1:0" }, closest: () => point,
    setAttribute: (key, value) => { attributes[key] = value; },
    addEventListener: (key, handler) => { listeners[`point:${key}`] = handler; },
  };
  const svg = {
    classList: { add() {} }, querySelectorAll: () => [point],
    addEventListener: (key, handler) => { listeners[key] = handler; },
  };
  const { geo } = lineTrendSVG({ xLabels: ["01"], xDates: [trend.dates[0]], series: [
    { label: "P0", values: [10] }, { label: "P1", values: [10] },
  ] });
  const selections = [];
  globalThis.document = { getElementById: () => ({ classList: { remove() {} } }) };
  try {
    wireTrendPointPick({ querySelector: () => svg }, geo, (pick) => selections.push(pick));
    listeners.click({ target: point });
    listeners["point:keydown"]({ key: "Enter", preventDefault() {} });
    assert.deepEqual(selections.map((pick) => [pick.date, pick.series.label, pick.seriesIndex, pick.index]), [
      [trend.dates[0], "P1", 1, 0], [trend.dates[0], "P1", 1, 0],
    ]);
    assert.equal(attributes.role, "button");
  } finally { delete globalThis.document; }
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
