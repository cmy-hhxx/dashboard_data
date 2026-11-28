import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

globalThis.location = { search: "" };
globalThis.window = {};
const { deriveEvalStatus, shellHTML, modelRowsHTML, buildMonthlySeries, monthBarHTML, dateChartHTML, dateDetailHTML, applyData, buildPgSpeedSamples, buildPgRpmSamples } = await import("../static/js/speed.js");
const speedCss = fs.readFileSync(new URL("../static/css/speed.css", import.meta.url), "utf8");
const systemCss = fs.readFileSync(new URL("../static/css/system.css", import.meta.url), "utf8");
const speedJs = fs.readFileSync(new URL("../static/js/speed.js", import.meta.url), "utf8");

const SAMPLE_TAX = {
  phases: [{ id: "execute", name: "执行" }],
  stages: [{ id: "S1", name: "工具调用", phase: "execute", def: "调用外部工具" }],
  mechanisms: [{ id: "M1", name: "空转未执行", def: "未触发步骤" }],
  l2: {},
  patterns: {
    "S1.M1.1": { name: "工具未调用", plain: "未发起必须的工具请求" },
    "S1.M1.2": { name: "重试缺失", plain: "失败后未重试" },
  },
};
const SAMPLE_PD = { clusters: { "S1.M1.1": 120, "S1.M1.2": 40 } };

const PAYLOAD = {
  available: true,
  ok: true,
  total: 1000,
  input_sessions: 400,
  input_traces: 1000,
  attr_sessions: 300,
  attr_traces: 750,
  compact: 900,
  remaining_sessions: 100,
  remaining_traces: 250,
  progress: 0.75,
  eta_minutes: 12,
  updated_at: "2026-11-19T08:30:00Z",
  rates: { attr: 20, compact: 25, parts_attr: 18, parts_compact: 22, realtime_rpm: 140, active_writers: 2, newest_part_age_s: 3 },
  cluster: { traces: 600, pending: 150, models: [{ name: "aime_fast", traces: 600, output_traces: 750, pending: 150 }] },
  queue: { running: 1, locks: [{ model: "aime_fast", heartbeat_age_s: 4 }] },
  models: [{
    name: "aime_fast", input_sessions: 400, input_traces: 1000, attr_traces: 750, compact: 900,
    dates: [
      { date: "2026-10-30", input_sessions: 100, input_traces: 250, attr_traces: 250, compact: 250, remaining_traces: 0 },
      { date: "2026-11-18", input_sessions: 160, input_traces: 400, attr_traces: 300, compact: 360, remaining_traces: 100 },
      { date: "2026-11-19", input_sessions: 140, input_traces: 350, attr_traces: 200, compact: 290, remaining_traces: 150 },
    ],
  }],
  gateways: {
    count: 1, healthy: 1, realtime_rpm: 140, rpm_limit: 500, active_writers: 2, newest_part_age_s: 3, active_replicas: 2,
    control: { paused: false, model_requests: 17, concurrency: 34, compact_backlog: 0 },
    items: [{ name: "gw1", url: "http://gw/v1", ok: true, healthy: true, code: 200, models: ["v4.1"], rpm: 140, rpm_limit: 500, permits: 17, concurrency: 34, active_replicas: 2, active_writers: 2, latency_ms: 42.3, active_ago_s: 4 }],
  },
  history: [[1000, 700, 840], [1300, 750, 900]],
  rpm_history: [[1000, 130, 18, 22], [1300, 140, 18, 22]],
};

test("speed UI has no chunk, no funnel progress bar, and no verbose meta clutter", () => {
  const html = shellHTML(SAMPLE_TAX, SAMPLE_PD);
  assert.ok(!/chunk/i.test(html));
  assert.ok(!/chunk/i.test(speedCss));
  assert.ok(!html.includes("sp-funnel"));
  assert.ok(!speedCss.includes("sp-funnel"));
  assert.ok(!html.includes("spQueue"));
  assert.ok(!html.includes('class="meta'));
  assert.ok(!html.includes(".parts"));
  assert.ok(!speedJs.includes("sp-gw-url"));
  assert.ok(!speedJs.includes("Math.sin(") && !speedJs.includes("Math.cos("), "gateway RPM/latency/rates must never use synthetic sine-wave jitter");
});

test("overview card uses concentric ring chart without explanatory ring tags and shows input, evaluated and clustered traces", () => {
  const html = shellHTML(SAMPLE_TAX, SAMPLE_PD);
  const ov = html.slice(0, html.indexOf("评测流水线"));
  for (const id of ["spRingAttr", "spRingCl", "spRingPct", "spRingClPct", "spInputTraces", "spInputSessions", "spAttrTraces", "spClusterTraces", "spEvalState"]) {
    assert.ok(ov.includes(`id="${id}"`), `overview missing ${id}`);
  }
  assert.ok(!ov.includes("外环") && !ov.includes("内环"), "overview must not contain redundant ring tags");
  assert.ok(!ov.includes("sp-ring-tag") && !speedCss.includes(".sp-ring-tag"));
  assert.ok(!ov.includes("spAttrSessions"), "evaluated count must be trace-only");
});

test("pipeline card reuses native horizontal fx-diagram with pending cluster pool, Ant Design active surge, and no fake controls", () => {
  const html = shellHTML(SAMPLE_TAX, SAMPLE_PD);
  for (const token of [
    'class="fx-diagram is-horiz is-headless has-pool"',
    'class="fx-tree is-horiz"',
    'id="spfxDiagram"',
    'id="spfxPool"',
    'id="spfxPoolFill"',
    'id="spfxPoolNum"',
    "待聚类",
    'id="spfxTree"',
    'id="spfxRootClip"',
    'data-rw="86"',
    'data-rh="156"',
    "is-vroot",
    "fx-leaf-bar",
    'viewBox="0 0 940 540"',
    "fx-ant-active",
    "fx-box fx-in",
    "fx-hub",
    "fx-ring",
    "fx-core",
    "fx-box fx-out",
    "fx-ico is-sev",
    "全部问题",
    "is-phase",
    "is-stage",
    "is-cell",
    "is-leaf",
  ]) {
    assert.ok(html.includes(token), `native horizontal pipeline missing ${token}`);
  }
  for (const removed of ["spfxPause", "spfxSpeed", "fx-label", "原始对话", "轨迹压缩", "问题归因", "层级聚类"]) {
    assert.ok(!html.includes(removed), `speed pipeline must not contain ${removed}`);
  }
  assert.ok(systemCss.includes(".fx-diagram.is-idle") && systemCss.includes("fx-ant-active") && systemCss.includes(".fx-pool"), "pool & Ant Design active surge styles missing");
  assert.ok(html.indexOf("评测流水线") > html.indexOf("评测总览"));
  assert.ok(html.lastIndexOf("<article") < html.indexOf("日期分布"), "日期分布 must be the last card");
  assert.ok(html.includes('id="spDateView"'));
});

test("deriveEvalStatus distinguishes 评测中 / 重评中 / 聚类中 / 空闲中 / 中断中 / 已完成 / 采集中断", () => {
  assert.equal(deriveEvalStatus({ ok: false }).label, "采集中断");
  assert.equal(deriveEvalStatus({ ok: true, gateways: { control: { paused: true } }, rates: { active_writers: 2 } }).label, "中断中");
  const running = deriveEvalStatus({ ok: true, input_traces: 10, remaining_traces: 4, rates: { active_writers: 2 }, gateways: { active_replicas: 3, control: {} } });
  assert.equal(running.label, "评测中");
  assert.equal(running.evalRunning, true);
  assert.equal(running.detail, "3 实例");
  const reevalRunning = deriveEvalStatus({
    ok: true, mode: "pg", input_traces: 100, remaining_traces: 12,
    new_remaining_traces: 0, reeval_remaining_traces: 12,
    rates: { attr: 4.5, cluster: 0 },
    pg_pipeline: { eval_rate_5m: 4.5, cluster_rate_5m: 0, active_workers: [{ worker: "va-0", claimed: 2, expired: 0 }] },
    queue: { running: 2 }, gateways: { control: {} },
  });
  assert.equal(reevalRunning.label, "重评中");
  assert.equal(reevalRunning.reeval, true);
  assert.equal(reevalRunning.evalRunning, true);
  assert.equal(reevalRunning.clusterRunning, false);
  assert.equal(reevalRunning.detail, "1 实例");
  const reevalClaimedZeroRate = deriveEvalStatus({
    ok: true, mode: "pg", input_traces: 100, remaining_traces: 5,
    new_remaining_traces: 0, reeval_remaining_traces: 5,
    rates: { attr: 0, cluster: 0 },
    pg_pipeline: { eval_rate_5m: 0, cluster_rate_5m: 0, active_workers: [{ worker: "va-0", claimed: 5, expired: 0 }] },
    queue: { running: 5 }, gateways: { control: {} },
  });
  assert.equal(reevalClaimedZeroRate.label, "重评中");
  assert.equal(reevalClaimedZeroRate.evalRunning, true);
  const mixedRunning = deriveEvalStatus({
    ok: true, mode: "pg", input_traces: 100, remaining_traces: 15,
    new_remaining_traces: 3, reeval_remaining_traces: 12,
    rates: { attr: 5.0, cluster: 0 },
    pg_pipeline: { eval_rate_5m: 5.0, cluster_rate_5m: 0, active_workers: [{ worker: "va-0", claimed: 3, expired: 0 }] },
    queue: { running: 3 }, gateways: { control: {} },
  });
  assert.equal(mixedRunning.label, "评测中");
  assert.equal(mixedRunning.reeval, false);
  const stalled = deriveEvalStatus({
    ok: true, input_traces: 10, remaining_traces: 4,
    rates: { active_writers: 0, realtime_rpm: 0, newest_part_age_s: 900, attr: 0, compact: 0 },
    queue: { running: 0, locks: [] }, gateways: { control: {}, items: [{ ok: true, active_ago_s: 600 }] },
  });
  assert.equal(stalled.label, "中断中");
  const done = deriveEvalStatus({
    ok: true, input_traces: 10, remaining_traces: 0, cluster: { pending: 0 },
    rates: {}, queue: { locks: [] }, gateways: { control: {}, items: [] },
  });
  assert.equal(done.label, "已完成");
});

test("modelRowsHTML renders compact model selector pills with live progress stats", () => {
  const html = modelRowsHTML(PAYLOAD);
  assert.ok(html.includes('data-sp-model="aime_fast"'));
  assert.ok(html.includes("sp-model-pill"));
  assert.ok(html.includes("75%"));
  assert.ok(html.includes("1,000"));
  assert.ok(html.includes("600"));
  assert.ok(html.includes("250"));
});

test("date distribution uses monthly bar chart and click-to-open concentric ring detail", () => {
  const series = buildMonthlySeries(PAYLOAD, "aime_fast", "");
  assert.deepEqual(series.months, ["2026-10", "2026-11"]);
  assert.equal(series.activeMonth, "2026-11");
  // Trims empty trailing/leading days (PAYLOAD has 11-18 and 11-19 -> 2 focused columns)
  assert.equal(series.days.length, 2);
  assert.equal(series.totals.input_traces, 750);
  assert.equal(series.totals.attr_traces, 500);

  const barHead = monthBarHTML(series);
  assert.ok(barHead.includes("2026 年 11 月"));
  assert.ok(barHead.includes('data-sp-month="2026-10"'));

  const chart = dateChartHTML(series, "2026-11-18");
  assert.ok(chart.includes("sp-mchart-bars"));
  assert.ok(chart.includes('data-sp-day="2026-11-18"'));
  assert.ok(chart.includes('is-selected'));
  assert.ok(chart.includes("sp-bar-val") && chart.includes("sp-bar-pct"));
  assert.ok(!chart.includes("sp-ring-card"));
  assert.ok(speedCss.includes(".sp-day-detail[hidden] { display: none; }"), "close button requires [hidden] to override display:grid");

  const detail = dateDetailHTML(series.byDate.get("2026-11-18"), "aime_fast", "2026-10-30", "2026-11-19");
  assert.ok(detail.includes("2026-11-18"));
  assert.ok(detail.includes("sp-dd-ring"));
  assert.ok(detail.includes("sp-dd-arc is-comp"));
  assert.ok(detail.includes("sp-dd-arc is-attr"));
  assert.ok(detail.includes("75.0%"));
  assert.ok(detail.includes("待测 100"));
});

test("applyData updates concentric rings and KPI counters from real numbers", () => {
  const byId = new Map();
  const node = (id) => {
    const el = {
      id, className: "", textContent: "", _html: "", hidden: false, disabled: false,
      style: { setProperty() {} }, dataset: {}, attributes: {},
      classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
      set innerHTML(v) { this._html = String(v); },
      get innerHTML() { return this._html; },
      setAttribute(k, v) { this.attributes[k] = String(v); },
      getAttribute(k) { return this.attributes[k]; },
      appendChild() {}, replaceChildren() {}, addEventListener() {},
      querySelectorAll() { return []; }, querySelector() { return null; },
      getBoundingClientRect() { return { width: 960, height: 256, left: 0, top: 0, right: 960, bottom: 256 }; },
    };
    byId.set(id, el);
    return el;
  };
  const ids = speedJs.match(/id="(sp[A-Za-z0-9]+)"/g).map((x) => x.slice(4, -1));
  for (const id of new Set(ids)) node(id);
  globalThis.document = {
    documentElement: { dataset: { view: "speed" }, classList: { add() {}, remove() {}, contains() { return false; } } },
    hidden: true,
    createElementNS: (_ns, tag) => node(`ns-${tag}-${Math.random()}`),
    querySelectorAll: () => [],
  };
  const root = {
    querySelector(sel) { return sel.startsWith("#") ? byId.get(sel.slice(1)) || null : null; },
    querySelectorAll() { return []; },
  };
  applyData(root, PAYLOAD);
  assert.equal(byId.get("spInputTraces").textContent, "1,000");
  assert.equal(byId.get("spInputSessions").textContent, "400");
  assert.equal(byId.get("spAttrTraces").textContent, "750");
  assert.equal(byId.get("spClusterTraces").textContent, "600");
  assert.equal(byId.get("spRingPct").textContent, "75.0%");
  assert.equal(byId.get("spRingClPct").textContent, "聚类 60.0%");
  assert.equal(byId.get("spAttrPct").textContent, "待评测 250");
  assert.equal(byId.get("spClusterPct").textContent, "待聚类 150");
  assert.ok(!byId.get("spAttrPct").textContent.includes("占输入"));
  assert.ok(!byId.get("spClusterPct").textContent.includes("占输入"));
  const outOff = Number(byId.get("spRingAttr").getAttribute("stroke-dashoffset"));
  const inOff = Number(byId.get("spRingCl").getAttribute("stroke-dashoffset"));
  assert.ok(Math.abs(outOff - 2 * Math.PI * 64 * 0.25) < 0.05);
  assert.ok(Math.abs(inOff - 2 * Math.PI * 49 * 0.40) < 0.05);
  assert.equal(byId.get("spEvalStateText").textContent, "评测中 · 2 实例");
  assert.ok(byId.get("spModels").innerHTML.includes("aime_fast"));
  applyData(root, { ...PAYLOAD, gateways: { ...PAYLOAD.gateways, control: { paused: true } } });
  assert.equal(byId.get("spEvalStateText").textContent, "中断中 · 调度暂停");
  // When input_traces grows, both evaluated and clustered ratios must adjust downward proportionally.
  applyData(root, { ...PAYLOAD, input_traces: 1500, remaining_traces: 750 });
  assert.equal(byId.get("spRingPct").textContent, "50.0%");
  assert.equal(byId.get("spRingClPct").textContent, "聚类 40.0%");
  const grownOutOff = Number(byId.get("spRingAttr").getAttribute("stroke-dashoffset"));
  const grownInOff = Number(byId.get("spRingCl").getAttribute("stroke-dashoffset"));
  assert.ok(Math.abs(grownOutOff - 2 * Math.PI * 64 * 0.5) < 0.05);
  assert.ok(Math.abs(grownInOff - 2 * Math.PI * 49 * 0.6) < 0.05);
  // When attr_traces and cluster.traces grow on refresh, +n danmu badges trigger only on core counters.
  applyData(root, {
    ...PAYLOAD,
    input_traces: 1500,
    attr_traces: 785,
    cluster: { ...PAYLOAD.cluster, traces: 622, pending: 163 },
  });
  assert.equal(byId.get("spAttrTraces").dataset.lastDanmu, "+35");
  assert.equal(byId.get("spClusterTraces").dataset.lastDanmu, "+22");
  assert.equal(byId.get("spInputTraces").dataset.lastDanmu, undefined);
  assert.equal(byId.get("spClusterPct").dataset.lastDanmu, undefined);
  // When requeue drops attr_traces downward, counters sync immediately without fake +n danmu.
  delete byId.get("spAttrTraces").dataset.lastDanmu;
  applyData(root, {
    ...PAYLOAD,
    mode: "pg",
    input_traces: 1500,
    attr_traces: 600,
    remaining_traces: 900,
    new_remaining_traces: 0,
    reeval_remaining_traces: 900,
    cluster: { traces: 500, pending: 100, models: [{ name: "aime_fast", traces: 500, output_traces: 600, pending: 100 }] },
    pg_pipeline: { eval_rate_5m: 5.0, cluster_rate_5m: 0, active_workers: [{ worker: "va-0", claimed: 2, expired: 0 }], series: [] },
  });
  assert.equal(byId.get("spAttrTraces").textContent, "600");
  assert.equal(byId.get("spAttrPct").textContent, "待重评 900");
  assert.equal(byId.get("spEvalStateText").textContent, "重评中 · 1 实例");
  assert.equal(byId.get("spAttrTraces").dataset.lastDanmu, undefined);
  // Zero throughput must not report running even when locks or gateway probe are fresh.
  const zeroSpeed = deriveEvalStatus({
    ok: true, input_traces: 100, remaining_traces: 40,
    rates: { active_writers: 0, realtime_rpm: 0, attr: 0, compact: 0, parts_attr: 0, parts_compact: 0 },
    queue: { running: 2, locks: [{ heartbeat_age_s: 5 }] },
    gateways: { control: {}, items: [{ ok: true, active_ago_s: 2 }] },
  });
  assert.equal(zeroSpeed.running, false);
  assert.equal(zeroSpeed.label, "中断中");
  assert.ok(speedCss.includes(".sp-danmu") && systemCss.includes(".fx-pool-danmu"));

  // PG mode: eval & cluster speed bucketing, idle status, and cluster-rate card rendering
  const nowTs = 1795759200;
  const pgSeries = [
    [nowTs - 180, 12, 12, 8, 24],
    [nowTs - 120, 18, 18, 10, 30],
    [nowTs - 60, 15, 15, 6, 18],
  ];
  const pgBuilt = buildPgSpeedSamples(pgSeries, 300, nowTs, "eval_cluster");
  assert.equal(pgBuilt.step, 60);
  assert.ok(pgBuilt.samples.some((s) => s.v1 === 18 && s.v2 === 10));
  const pgIdle = deriveEvalStatus({
    ok: true, mode: "pg", input_traces: 100, remaining_traces: 5, cluster: { pending: 0 },
    rates: { attr: 0, cluster: 0, active_writers: 0 }, queue: { running: 0, locks: [] }, gateways: { control: {} },
  });
  assert.equal(pgIdle.label, "空闲中");
  assert.equal(pgIdle.detail, "待评测 5");
  const pgReevalIdle = deriveEvalStatus({
    ok: true, mode: "pg", input_traces: 100, remaining_traces: 7,
    new_remaining_traces: 0, reeval_remaining_traces: 7, cluster: { pending: 0 },
    rates: { attr: 0, cluster: 0, active_writers: 0 }, queue: { running: 0, locks: [] }, gateways: { control: {} },
  });
  assert.equal(pgReevalIdle.label, "空闲中");
  assert.equal(pgReevalIdle.detail, "待重评 7");
  const pgClRun = deriveEvalStatus({
    ok: true, mode: "pg", input_traces: 100, remaining_traces: 0, cluster: { pending: 20 },
    rates: { attr: 0, cluster: 12.5, active_writers: 0 }, queue: { running: 0, locks: [] }, gateways: { control: {} },
  });
  assert.equal(pgClRun.label, "聚类中");
  assert.equal(pgClRun.running, true);
  assert.equal(pgClRun.evalRunning, false);
  assert.equal(pgClRun.clusterRunning, true);

  // PG mode: live gateway RPM & utilization in top card, gateway KPI/table, and RPM chart bucketing
  const pgRpmBuilt = buildPgRpmSamples([[nowTs - 120, 225, 10, 10], [nowTs - 60, 240, 11, 11]], 300, nowTs);
  assert.equal(pgRpmBuilt.step, 60);
  assert.ok(pgRpmBuilt.samples.some((s) => s.v1 === 225 && s.pa === 10));

  applyData(root, {
    ...PAYLOAD,
    mode: "pg",
    new_remaining_traces: 0,
    reeval_remaining_traces: 250,
    pg_pipeline: {
      now_epoch: nowTs,
      eval_rate_5m: 9.8,
      eval_rate_1h: 7.2,
      eval_24h: 12000,
      compact_rate_5m: 9.8,
      cluster_rate_5m: 14.0,
      cluster_rate_1h: 11.5,
      cluster_24h: 320,
      cluster_prob_rate_5m: 42.0,
      cluster_pending_problems: 80,
      cluster_eta_minutes: 5.7,
      last_eval_ago_s: 2,
      last_cluster_ago_s: 15,
      expired_leases: 0,
      active_workers: [{ worker: "va-0", model: "aime_fast", claimed: 25, expired: 0, age_s: 3 }],
      series: pgSeries,
    },
    gateways: {
      count: 1, healthy: 1, realtime_rpm: 221.4, rpm_1h: 175.0, rpm_limit: 300, rpm_source: "key",
      rpm_utilization: 0.738, active_replicas: 3, active_writers: 3, control: { paused: false, model_requests: 200, concurrency: 150 },
      items: [{
        name: "evaluation-gateway", url: "http://gw/v1", ok: true, healthy: true, code: 200,
        models: ["deepseek-v4.1-flash"], rpm: 221.4, rpm_limit: 300, rpm_utilization: 0.738,
        permits: 200, concurrency: 150, latency_ms: 28.4, active_ago_s: 1,
      }],
    },
    rpm_history: [[nowTs - 120, 225, 10, 10], [nowTs - 60, 240, 11, 11]],
  });
  assert.equal(byId.get("spTopGwRpm").textContent, "221.4");
  assert.equal(byId.get("spTopGwUtil").textContent, "73.8%");
  assert.equal(byId.get("spTopGwSub").textContent, "配额 300 · 1h 175.0");
  assert.equal(byId.get("spGwRpm").textContent, "221.4");
  assert.equal(byId.get("spGwRpmSub").textContent, "配额 300");
  assert.equal(byId.get("spPartsAttrSub").textContent, "1h 均速 7.2 · 24h 12,000");
  assert.equal(byId.get("spPartsCompactSub").textContent, "1h 均速 11.5 · 24h 320");
  assert.equal(byId.get("spEtaSub").textContent, "待重评 250 · 待聚类 150");
  assert.equal(byId.get("spGwPartsSub").textContent, "待重评 250");
  assert.equal(byId.get("spGwControlSub").textContent, "未聚类问题 80");
  assert.ok(byId.get("spGateways").innerHTML.includes("73.8%"));
  assert.ok(byId.get("spGateways").innerHTML.includes("evaluation-gateway"));
  assert.equal(byId.get("spWorkersWrap").hidden, false);
  assert.ok(byId.get("spWorkers").innerHTML.includes("va-0"));
});

test("reeval date board and decoupled pipeline idle classes stay consistent", async () => {
  const reevalSeries = buildMonthlySeries({
    models: [{
      name: "aime_expert",
      dates: [{
        date: "2026-11-27", input_sessions: 40, input_traces: 100,
        attr_traces: 80, compact: 80, remaining_traces: 15, reeval_remaining: 15,
      }],
    }],
  }, "aime_expert", "2026-11");
  assert.equal(reevalSeries.totals.remaining_traces, 15);
  assert.equal(reevalSeries.totals.reeval_remaining, 15);
  assert.ok(monthBarHTML(reevalSeries).includes("待重评 <b>15</b>"));
  assert.ok(dateChartHTML(reevalSeries).includes("待重评 15"));
  const detail = dateDetailHTML(reevalSeries.byDate.get("2026-11-27"), "aime_expert");
  assert.ok(detail.includes("待重评 15"));
  assert.ok(detail.includes("<span>待重评</span>"));

  assert.ok(systemCss.includes(".fx-diagram.is-eval-idle") && systemCss.includes(".fx-diagram.is-cluster-idle"));

  // Check mountFxDiagram decoupled evalRunning / clusterRunning classes in headless mode
  const { mountFxDiagram } = await import("../static/js/system.js");
  const classes = new Set();
  const makeEl = () => ({
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      toggle: (c, f) => (f ? classes.add(c) : classes.delete(c)),
      contains: (c) => classes.has(c),
    },
    dataset: {},
    style: { setProperty() {} },
    setAttribute() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }),
    querySelector: () => null,
    querySelectorAll: () => [],
  });
  const diagramEl = makeEl();
  const rootStub = {
    querySelector: (sel) => (sel === "#spfxDiagram" ? diagramEl : null),
    querySelectorAll: () => [],
  };
  globalThis.document = {
    documentElement: { hasAttribute: () => true },
    addEventListener() {},
    removeEventListener() {},
  };
  const ctl = mountFxDiagram(rootStub, SAMPLE_TAX, SAMPLE_PD, { horizontal: true, idPrefix: "spfx", liveControl: true });
  ctl.setLiveProgress({ ratio: 0.8, pending: 20, evalRunning: true, clusterRunning: false, evalRate: 5.0, clusterRate: 0 });
  assert.equal(classes.has("is-idle"), false);
  assert.equal(classes.has("is-eval-idle"), false);
  assert.equal(classes.has("is-cluster-idle"), true);
  ctl.setLiveProgress({ ratio: 0.8, pending: 20, evalRunning: false, clusterRunning: true, evalRate: 0, clusterRate: 6.0 });
  assert.equal(classes.has("is-idle"), false);
  assert.equal(classes.has("is-eval-idle"), true);
  assert.equal(classes.has("is-cluster-idle"), false);
  ctl.destroy();
});
