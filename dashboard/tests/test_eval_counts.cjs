const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

// Run the actual card calculations without requiring a browser or copying the formulas.
const source = fs.readFileSync(path.join(__dirname, "../static/js/data.js"), "utf8");
const compact = (n) => {
  const v = Number(n);
  const s = Math.abs(v);
  const [b, u, d] = s >= 1e9 ? [1e9, "B", 2] : s >= 1e6 ? [1e6, "M", 1] : s >= 1e3 ? [1e3, "K", 1] : [];
  return b ? (v / b).toFixed(d).replace(/\.0+$/, "") + u : String(v);
};
const context = vm.createContext({
  sum: (xs) => xs.reduce((a, b) => a + b, 0),
  esc: (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]),
  fmt: (n, d = 0) => Number(n).toFixed(d),
  pct: (a, b, d = 0) => (b ? `${((100 * a) / b).toFixed(d)}%` : "—"),
  compact,
  counter: (v) => String(v),
  stats: () => "",
});
vm.runInContext(source.slice(source.indexOf("const dayCount ="), source.indexOf("function evalCard(")) +
  "\nglobalThis.calc = (p, range, model = 'all') => { EV.range = range; EV.model = model; EV.year = null; return evalTotals(p); }; globalThis.families = (p) => evalModels(p); globalThis.defaultRange = EV.range; globalThis.chartHTML = (p, range, model = 'all') => { EV.range = range; EV.model = model; EV.year = null; return evalChart(p); }; globalThis.legendHTML = () => evalLegend();", context);

const p = {
  kpi: { unique_sessions: 2, traces: 5, tokens: 150 },
  input: { sessions: 3, traces: 9, models: { fast: { sessions: 2, traces: 7 }, expert: { sessions: 1, traces: 2 } } },
  daily: [
    { d: "2026-11-01", m: "fast", sp: "daily", inputs: 1, input_traces: 3, evaluated: 1, traces: 2, tokens: 50, sessions: 1, sids: [0], in_sessions: 2, in_sids: [0, 1] },
    { d: "2026-11-02", m: "fast", sp: "daily", inputs: 1, input_traces: 4, evaluated: 1, traces: 2, tokens: 60, sessions: 1, sids: [0], in_sessions: 1, in_sids: [0] },
    { d: "2026-11-02", m: "expert", sp: "daily", inputs: 1, input_traces: 2, evaluated: 1, traces: 1, tokens: 40, sessions: 1, sids: [1], in_sessions: 1, in_sids: [2] },
  ],
};
const plain = (x) => JSON.parse(JSON.stringify(x));
assert.equal(context.defaultRange, "all", "Default must be the full range so the volume cards reconcile");
const full = plain(context.calc(p, "all"));
assert.deepEqual(full.sessions, [2, 3], "Full range uses the same session keys as the volume card");
assert.deepEqual(full.traces, [5, 9], "Full range uses the same trace totals as the volume card");
assert.equal(full.tokens, 150);
const window = plain(context.calc(p, "30"));
assert.deepEqual(window.traces, [5, 9], "Trace denominator must count traces, not JSONL rows");
assert.deepEqual(window.sessions, [2, 3], "Both sides must deduplicate sessions across dates");
const model = plain(context.calc(p, "all", "fast"));
assert.deepEqual(model.sessions, [1, 2], "All-time totals must follow model selection");
assert.deepEqual(model.traces, [4, 7]);
assert.equal(model.tokens, 110);
const historical = { ...p, kpi: { unique_sessions: 3299, traces: 3299, tokens: 316442385 },
  daily: [{ d: "2026-10-01", m: "fast", sp: "daily", evaluated: 3299 }, { d: "2026-11-03", m: "fast", sp: "daily", inputs: 78 }] };
assert.equal(context.calc(historical, "all").sessions[0], 3299);
assert.equal(context.calc(historical, "30").sessions[0], 0, "An explicit 30-day window is still windowed");

// The model segment keeps only the known families; prefixed variants fold into their family and
// unlabelled models do not become a segment (they still count in 全部).
const grouped = {
  kpi: { unique_sessions: 0, traces: 0, tokens: 0 },
  input: { models: {
    b_expert: { sessions: 1, traces: 9 }, b_expert_only_doubao_search: { sessions: 1, traces: 3 }, "未标注": { sessions: 1, traces: 1 },
  } },
  daily: [
    { d: "2026-11-01", m: "a_fast", inputs: 1, evaluated: 1, traces: 2, sessions: 1, sids: [0], tokens: 10 },
    { d: "2026-11-01", m: "b_expert", inputs: 1, evaluated: 1, traces: 2, sessions: 1, sids: [1], tokens: 10 },
    { d: "2026-11-02", m: "b_expert_only_doubao_search", inputs: 1, evaluated: 1, traces: 3, sessions: 1, sids: [2], tokens: 20 },
    { d: "2026-11-02", m: "未标注", inputs: 1, evaluated: 1, traces: 1, sessions: 1, sids: [3], tokens: 5 },
  ],
};
assert.deepEqual(plain(context.families(grouped)).map((m) => m.label), ["全部", "A Fast", "B Expert"]);
const bExpert = plain(context.calc(grouped, "all", "b_expert"));
assert.deepEqual(bExpert.traces, [5, 12], "B Expert includes its prefixed variants on both sides");
assert.deepEqual(bExpert.sessions, [2, 2]);

// AIME has one Fast and one Expert family, so the segment never grows an A/B split.
const aime = {
  kpi: { unique_sessions: 0, traces: 0, tokens: 0 },
  input: { models: { aime_fast: { sessions: 2, traces: 4 }, aime_expert: { sessions: 1, traces: 6 } } },
  daily: [
    { d: "2026-11-01", m: "aime_fast", inputs: 2, evaluated: 2, traces: 3, sessions: 2, sids: [0, 1], tokens: 10 },
    { d: "2026-11-02", m: "aime_expert", inputs: 1, evaluated: 1, traces: 5, sessions: 1, sids: [2], tokens: 20 },
  ],
};
assert.deepEqual(plain(context.families(aime)).map((m) => m.label), ["全部", "Fast", "Expert"]);
assert.deepEqual(plain(context.calc(aime, "all", "aime_expert")).traces, [5, 6]);

// Eval chart bars & hover tips use Trace counts with K/M/B units, not record counts.
const traceBarSample = {
  kpi: { unique_sessions: 10, traces: 2599, tokens: 0 },
  input: { sessions: 10, traces: 3798, models: { aime_fast: { sessions: 10, traces: 3798 } } },
  daily: [
    { d: "2026-11-14", m: "aime_fast", sp: "daily", inputs: 1500, input_traces: 3798, evaluated: 1000, traces: 2599, tokens: 0, sessions: 10, sids: [0], in_sessions: 10, in_sids: [0] },
  ],
};
const html = context.chartHTML(traceBarSample, "7");
assert.match(html, /输入 3\.8K 条 Trace · 已完成 2\.6K 条 Trace · 68\.4%/);
assert.match(html, /<b class="num">2\.6K<\/b><small class="num">3\.8K<\/small>/);
assert.doesNotMatch(html, /条记录/);
const legend = context.legendHTML();
assert.match(legend, /已完成 Trace/);
assert.match(legend, /评测输入 Trace/);
console.log("PASS: full default, time/model filters, trace units, cross-day session deduplication, model families");
