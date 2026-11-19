import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

globalThis.location = { search: "" };
globalThis.window = {};
const { deriveEvalStatus, shellHTML, modelRowsHTML, applyData } = await import("../static/js/speed.js");
const speedCss = fs.readFileSync(new URL("../static/css/speed.css", import.meta.url), "utf8");
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
  models: [{ name: "aime_fast", input_sessions: 400, input_traces: 1000, attr_traces: 750, compact: 900, dates: [] }],
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
});

test("overview card uses concentric ring chart and shows input sessions+traces, evaluated traces and clustered traces", () => {
  const html = shellHTML(SAMPLE_TAX, SAMPLE_PD);
  const ov = html.slice(0, html.indexOf("评测流水线"));
  for (const id of ["spRingAttr", "spRingCl", "spRingPct", "spInputTraces", "spInputSessions", "spAttrTraces", "spClusterTraces", "spEvalState"]) {
    assert.ok(ov.includes(`id="${id}"`), `overview missing ${id}`);
  }
  assert.ok(!ov.includes("spAttrSessions"), "evaluated count must be trace-only");
});

test("pipeline card reuses native horizontal fx-diagram from system.js with full cluster tree nodes", () => {
  const html = shellHTML(SAMPLE_TAX, SAMPLE_PD);
  for (const token of [
    'class="fx-diagram is-horiz"',
    'id="spfxDiagram"',
    'id="spfxTree"',
    'id="spfxRootClip"',
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
    "原始对话",
    "轨迹压缩",
    "问题归因",
    "层级聚类",
  ]) {
    assert.ok(html.includes(token), `native horizontal pipeline missing ${token}`);
  }
  assert.ok(html.indexOf("评测流水线") > html.indexOf("评测总览"));
  assert.ok(html.lastIndexOf("<article") < html.indexOf("日期分布"), "日期分布 must be the last card");
  assert.ok(html.includes('id="spDateView"'));
});

test("deriveEvalStatus distinguishes 进行中 / 中断中 / 已完成 / 采集中断", () => {
  assert.equal(deriveEvalStatus({ ok: false }).label, "采集中断");
  assert.equal(deriveEvalStatus({ ok: true, gateways: { control: { paused: true } }, rates: { active_writers: 2 } }).label, "中断中");
  const running = deriveEvalStatus({ ok: true, input_traces: 10, remaining_traces: 4, rates: { active_writers: 2 }, gateways: { active_replicas: 3, control: {} } });
  assert.equal(running.label, "进行中");
  assert.equal(running.detail, "3 实例");
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

test("modelRowsHTML lists trace-based progress with nested cluster bar", () => {
  const html = modelRowsHTML(PAYLOAD);
  assert.ok(html.includes('data-sp-model="aime_fast"'));
  assert.ok(html.includes("1,000"));
  assert.ok(html.includes("600"));
  assert.ok(html.includes("250"));
  assert.ok(html.includes('class="is-cl"'));
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
  const outOff = Number(byId.get("spRingAttr").getAttribute("stroke-dashoffset"));
  const inOff = Number(byId.get("spRingCl").getAttribute("stroke-dashoffset"));
  assert.ok(Math.abs(outOff - 2 * Math.PI * 56 * 0.25) < 0.05);
  assert.ok(Math.abs(inOff - 2 * Math.PI * 42 * 0.40) < 0.05);
  assert.equal(byId.get("spEvalStateText").textContent, "进行中 · 2 实例");
  assert.ok(byId.get("spModels").innerHTML.includes("aime_fast"));
  applyData(root, { ...PAYLOAD, gateways: { ...PAYLOAD.gateways, control: { paused: true } } });
  assert.equal(byId.get("spEvalStateText").textContent, "中断中 · 调度暂停");
});
