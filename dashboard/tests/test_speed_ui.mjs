import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

globalThis.location = { search: "" };
globalThis.window = {};
const { deriveEvalStatus, shellHTML, buildTrackStats, renderTracksHTML, applyData } = await import("../static/js/speed.js");
const speedCss = fs.readFileSync(new URL("../static/css/speed.css", import.meta.url), "utf8");
const speedJs = fs.readFileSync(new URL("../static/js/speed.js", import.meta.url), "utf8");

test("applyData renders full telemetry without chunk or JS errors", () => {
  const byId = new Map();
  const makeNode = (id, tag = "div") => {
    const el = {
      id,
      tagName: tag.toUpperCase(),
      className: "",
      textContent: "",
      _html: "",
      title: "",
      hidden: false,
      disabled: false,
      style: { setProperty() {} },
      dataset: {},
      attributes: {},
      classList: {
        add() {},
        remove() {},
        toggle() {},
        contains() { return false; },
      },
      set innerHTML(v) { this._html = String(v); },
      get innerHTML() { return this._html; },
      setAttribute(k, v) { this.attributes[k] = String(v); },
      getAttribute(k) { return this.attributes[k]; },
      appendChild() {},
      replaceChildren() {},
      addEventListener() {},
      querySelectorAll() { return []; },
      querySelector() { return null; },
      getBoundingClientRect() { return { width: 960, height: 256, left: 0, top: 0, right: 960, bottom: 256 }; },
    };
    byId.set(id, el);
    return el;
  };
  for (const id of [
    "spFlowMini", "spFxWires", "spFxSparks", "spEvalState", "spEvalStateText", "spConn", "spConnText",
    "spInputTraces", "spNodeInSess", "spInputSub", "spCompactTotal", "spCompactPct", "spCompactSub",
    "spAttrTraces", "spRemainingTraces", "spPercent", "spClusterTraces", "spClusterPending", "spClusterPct",
    "spAttrRate", "spCompactRate", "spPartsAttrSub", "spPartsCompactSub", "spEta", "spEtaSub",
    "spTracks", "spGwSummary", "spGwRpm", "spGwRpmSub", "spGwMeter", "spGwMeterFill",
    "spGwPartsAttr", "spGwPartsComp", "spGwPartsSub", "spGwPermits", "spGwControlSub",
    "spGwLatency", "spGwProbeSub", "spGateways",
    "spChart", "spGrid", "spAxis", "spLine1", "spLine2", "spArea1", "spArea2", "spQuotaLine",
    "spHoverLine", "spPointLayer", "spChartLegend", "spChartEmpty",
  ]) makeNode(id);

  const waves = new Map();
  for (const w of ["in", "compact", "attr", "cluster"]) waves.set(w, makeNode(`wave-${w}`));
  globalThis.document = {
    documentElement: { dataset: { view: "speed" }, classList: { add() {}, remove() {}, contains() { return false; } } },
    hidden: false,
    createElementNS: (_ns, tag) => makeNode(`ns-${tag}`, tag),
    querySelectorAll: () => [],
  };

  const root = {
    querySelector(sel) {
      if (sel.startsWith("#")) return byId.get(sel.slice(1)) || null;
      const m = sel.match(/^\[data-wave-shift="([^"]+)"\]$/);
      if (m) return waves.get(m[1]) || null;
      return null;
    },
    querySelectorAll() { return []; },
  };
  const payload = {
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
    models: [{ name: "aime_fast", input_traces: 1000, attr_traces: 750, compact: 900, dates: [] }],
    gateways: {
      count: 1,
      healthy: 1,
      realtime_rpm: 140,
      rpm_limit: 500,
      active_writers: 2,
      newest_part_age_s: 3,
      active_replicas: 2,
      control: { paused: false, model_requests: 17, concurrency: 34, compact_backlog: 0 },
      items: [{ name: "gw1", url: "http://gw/v1", ok: true, healthy: true, code: 200, models: ["v4.1"], rpm: 140, rpm_limit: 500, permits: 17, concurrency: 34, active_replicas: 2, active_writers: 2, latency_ms: 42.3, active_ago_s: 4 }],
    },
    history: [[1000, 700, 840], [1300, 750, 900]],
    rpm_history: [[1000, 130, 18, 22], [1300, 140, 18, 22]],
  };
  applyData(root, payload);
  assert.equal(byId.get("spEvalStateText").textContent, "进行中 · 2 实例");
  assert.equal(byId.get("spInputTraces").textContent, "1,000");
  assert.equal(byId.get("spClusterTraces").textContent, "600");
  assert.equal(byId.get("spClusterPending").textContent, "150");
  assert.equal(waves.get("attr").getAttribute("transform"), "translate(180.0 0)");
  assert.equal(waves.get("compact").getAttribute("transform"), "translate(216.0 0)");
  assert.equal(waves.get("cluster").getAttribute("transform"), "translate(192.0 0)");
  assert.ok(byId.get("spTracks").innerHTML.includes("aime_fast"));
  assert.ok(!/chunk/i.test(byId.get("spTracks").innerHTML));
  assert.ok(!/chunk/i.test(byId.get("spGateways").innerHTML));

  // Verify paused/interrupted transition flips label cleanly to 中断中
  applyData(root, { ...payload, gateways: { ...payload.gateways, control: { paused: true } } });
  assert.equal(byId.get("spEvalStateText").textContent, "中断中 · 调度暂停");
});

test("speed UI removes all chunk concepts and verbose meta clutter", () => {
  const html = shellHTML();
  assert.ok(!/chunk/i.test(html), "shellHTML must not mention chunk");
  assert.ok(!/chunk/i.test(speedCss), "speed.css must not mention chunk");
  assert.ok(!html.includes("spQueue"), "shellHTML must not include old queue IDs");
  assert.ok(!html.includes('class="meta'), "shellHTML must not crowd headers with .meta small text");
  assert.ok(!html.includes(".parts"), "shellHTML must not expose raw .parts jargon");
  assert.ok(!speedJs.includes("sp-gw-url"), "speed.js must not render raw gw-url subtitle clutter");
});

test("speed shell embeds miniature pipeline visualization inspired by system flow", () => {
  const html = shellHTML();
  for (const token of [
    "spEvalState",
    "spFlowMini",
    "spFxWires",
    "spFxSparks",
    "sp-mini-hub",
    "sp-ico is-sev",
    "spLiquidSheen-compact",
    "spLiquidSheen-attr",
    "spLiquidSheen-cluster",
    "输入对话",
    "轨迹压缩",
    "问题归因",
    "层级聚类",
    "spTracks",
    "spDateView",
  ]) {
    assert.ok(html.includes(token), `shellHTML missing ${token}`);
  }
});

test("deriveEvalStatus accurately distinguishes 进行中 vs 中断中 vs 已完成 vs 采集中断", () => {
  assert.equal(deriveEvalStatus({ ok: false }).label, "采集中断");
  assert.equal(deriveEvalStatus({
    ok: true,
    input_traces: 1000,
    remaining_traces: 200,
    gateways: { control: { paused: true } },
    rates: { active_writers: 2, realtime_rpm: 120 },
  }).label, "中断中");

  const running = deriveEvalStatus({
    ok: true,
    input_traces: 1000,
    remaining_traces: 400,
    rates: { active_writers: 2, realtime_rpm: 180, newest_part_age_s: 5 },
    gateways: { active_replicas: 3, control: { paused: false } },
  });
  assert.equal(running.label, "进行中");
  assert.equal(running.running, true);
  assert.equal(running.detail, "3 实例");

  const stalled = deriveEvalStatus({
    ok: true,
    input_traces: 1000,
    remaining_traces: 400,
    rates: { active_writers: 0, realtime_rpm: 0, newest_part_age_s: 900, attr: 0, compact: 0 },
    queue: { running: 0, locks: [] },
    gateways: { control: { paused: false }, items: [{ ok: true, active_ago_s: 600 }] },
  });
  assert.equal(stalled.label, "中断中");
  assert.equal(stalled.running, false);

  const done = deriveEvalStatus({
    ok: true,
    input_traces: 1000,
    remaining_traces: 0,
    cluster: { traces: 1000, pending: 0 },
    rates: { active_writers: 0, realtime_rpm: 0 },
    queue: { running: 0, locks: [] },
    gateways: { control: { paused: false }, items: [] },
  });
  assert.equal(done.label, "已完成");
  assert.equal(done.running, false);
});

test("buildTrackStats & renderTracksHTML compute real compact, attr and cluster bars", () => {
  const sample = {
    ok: true,
    input_traces: 1000,
    remaining_traces: 200,
    cluster: {
      traces: 500,
      pending: 300,
      models: [
        { name: "aime_fast", traces: 400, output_traces: 600, pending: 200 },
        { name: "aime_expert", traces: 100, output_traces: 200, pending: 100 },
      ],
    },
    queue: { running: 1, locks: [{ model: "aime_fast", heartbeat_age_s: 5 }] },
    rates: { active_writers: 1, newest_part_age_s: 4 },
    gateways: { control: { paused: false } },
    models: [
      { name: "aime_fast", input_traces: 700, attr_traces: 600, compact: 650 },
      { name: "aime_expert", input_traces: 300, attr_traces: 200, compact: 300 },
    ],
  };
  const stats = buildTrackStats(sample);
  assert.equal(stats.length, 2);
  assert.equal(stats[0].remTraces, 100);
  assert.equal(stats[0].clDone, 400);
  assert.equal(stats[0].clPending, 200);
  assert.equal(stats[0].state.cls, "is-live");

  const html = renderTracksHTML(sample);
  assert.ok(html.includes('data-sp-model="aime_fast"'));
  assert.ok(html.includes("压缩"));
  assert.ok(html.includes("归因"));
  assert.ok(html.includes("聚类"));
  assert.ok(!/chunk/i.test(html));
});
