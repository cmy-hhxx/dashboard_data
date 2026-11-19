import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

globalThis.location = { search: "" };
globalThis.window = {};
const { deriveEvalStatus, shellHTML, modelRowsHTML, applyData } = await import("../static/js/speed.js");
const speedCss = fs.readFileSync(new URL("../static/css/speed.css", import.meta.url), "utf8");
const speedJs = fs.readFileSync(new URL("../static/js/speed.js", import.meta.url), "utf8");

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

test("speed UI has no chunk concept and no verbose meta clutter", () => {
  const html = shellHTML();
  assert.ok(!/chunk/i.test(html));
  assert.ok(!/chunk/i.test(speedCss));
  assert.ok(!html.includes("spQueue"));
  assert.ok(!html.includes('class="meta'));
  assert.ok(!html.includes(".parts"));
  assert.ok(!speedJs.includes("sp-gw-url"));
});

test("overview card shows input sessions+traces, evaluated traces and clustered traces with a nested funnel", () => {
  const html = shellHTML();
  const ov = html.slice(0, html.indexOf("评测流水线"));
  for (const id of ["spInputTraces", "spInputSessions", "spAttrTraces", "spClusterTraces", "spFunnelAttr", "spFunnelCl", "spEvalState"]) {
    assert.ok(ov.includes(`id="${id}"`), `overview missing ${id}`);
  }
  assert.ok(!ov.includes("spAttrSessions"), "evaluated count must be trace-only");
});

test("pipeline card mirrors the system fx-diagram (inputs, hub, outputs, cluster pool) and date distribution sits last", () => {
  const html = shellHTML();
  for (const token of ["spFx", "spFxWires", "spFxSparks", "fx-box fx-in", "fx-hub sp-hub", "fx-ring", "fx-core", "fx-box fx-out", "fx-ico is-sev", "spPool", "spPoolLevel", "原始对话", "轨迹压缩", "问题归因", "层级聚类"]) {
    assert.ok(html.includes(token), `pipeline missing ${token}`);
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

test("applyData fills the overview and pipeline counters from real numbers", () => {
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
  assert.equal(byId.get("spFunnelAttr").style.width, "75.00%");
  assert.equal(byId.get("spFunnelCl").style.width, "60.00%");
  assert.equal(byId.get("spEvalStateText").textContent, "进行中 · 2 实例");
  assert.ok(byId.get("spModels").innerHTML.includes("aime_fast"));
  applyData(root, { ...PAYLOAD, gateways: { ...PAYLOAD.gateways, control: { paused: true } } });
  assert.equal(byId.get("spEvalStateText").textContent, "中断中 · 调度暂停");
});
