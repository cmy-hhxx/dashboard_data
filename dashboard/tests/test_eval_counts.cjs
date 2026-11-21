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
  "\nglobalThis.calc = (p, month = null, model = 'all') => { EV.month = month; EV.model = model; return evalTotals(p); }; globalThis.families = (p) => evalModels(p); globalThis.months = (p, model = 'all') => evalMonths(p, model); globalThis.chartHTML = (p, month = null, model = 'all') => { EV.month = month; EV.model = model; return evalChart(p); };", context);

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
assert.deepEqual(plain(context.months(p)), ["2026-11"]);
const full = plain(context.calc(p));
assert.equal(full.month, "2026-11");
assert.deepEqual(full.sessions, [2, 3], "Month view uses the same deduplicated sessions across dates");
assert.deepEqual(full.traces, [5, 9], "Trace denominator must count traces, not JSONL rows");
assert.equal(full.tokens, 150);

const model = plain(context.calc(p, "2026-11", "fast"));
assert.deepEqual(model.sessions, [1, 2], "Monthly totals must follow model selection");
assert.deepEqual(model.traces, [4, 7]);
assert.equal(model.tokens, 110);

const historical = {
  ...p,
  kpi: { unique_sessions: 3299, traces: 3299, tokens: 316442385 },
  daily: [
    { d: "2026-10-01", m: "fast", sp: "daily", evaluated: 3299, traces: 3299, input_traces: 3299, sessions: 3299, in_sessions: 3299 },
    { d: "2026-11-03", m: "fast", sp: "daily", inputs: 78, input_traces: 78, evaluated: 0, traces: 0, in_sids: [10], sids: [] },
  ],
};
assert.deepEqual(plain(context.months(historical)), ["2026-10", "2026-11"]);
assert.equal(context.calc(historical).month, "2026-11", "Default selects the latest month");
assert.equal(context.calc(historical).sessions[0], 0);
assert.equal(context.calc(historical, "2026-10").sessions[0], 3299, "Selecting an earlier month scopes cleanly to that month");

// The model segment keeps only the known families; prefixed variants fold into their family and
// unlabelled models do not become a segment (they still count in 全部).
const grouped = {
  kpi: { unique_sessions: 0, traces: 0, tokens: 0 },
  input: { models: {
    b_expert: { sessions: 1, traces: 9 }, b_expert_only_doubao_search: { sessions: 1, traces: 3 }, "未标注": { sessions: 1, traces: 1 },
  } },
  daily: [
    { d: "2026-11-01", m: "a_fast", inputs: 1, input_traces: 1, evaluated: 1, traces: 2, sessions: 1, sids: [0], in_sids: [10], tokens: 10 },
    { d: "2026-11-01", m: "b_expert", inputs: 1, input_traces: 9, evaluated: 1, traces: 2, sessions: 1, sids: [1], in_sids: [11], tokens: 10 },
    { d: "2026-11-02", m: "b_expert_only_doubao_search", inputs: 1, input_traces: 3, evaluated: 1, traces: 3, sessions: 1, sids: [2], in_sids: [12], tokens: 20 },
    { d: "2026-11-02", m: "未标注", inputs: 1, input_traces: 1, evaluated: 1, traces: 1, sessions: 1, sids: [3], in_sids: [13], tokens: 5 },
  ],
};
assert.deepEqual(plain(context.families(grouped)).map((m) => m.label), ["全部", "A Fast", "B Expert"]);
const bExpert = plain(context.calc(grouped, "2026-11", "b_expert"));
assert.deepEqual(bExpert.traces, [5, 12], "B Expert includes its prefixed variants on both sides");
assert.deepEqual(bExpert.sessions, [2, 2]);

// AIME has one Fast and one Expert family, so the segment never grows an A/B split.
const aime = {
  kpi: { unique_sessions: 0, traces: 0, tokens: 0 },
  input: { models: { aime_fast: { sessions: 2, traces: 4 }, aime_expert: { sessions: 1, traces: 6 } } },
  daily: [
    { d: "2026-11-01", m: "aime_fast", inputs: 2, input_traces: 4, evaluated: 2, traces: 3, sessions: 2, sids: [0, 1], in_sids: [0, 1], tokens: 10 },
    { d: "2026-11-02", m: "aime_expert", inputs: 1, input_traces: 6, evaluated: 1, traces: 5, sessions: 1, sids: [2], in_sids: [2], tokens: 20 },
  ],
};
assert.deepEqual(plain(context.families(aime)).map((m) => m.label), ["全部", "Fast", "Expert"]);
assert.deepEqual(plain(context.calc(aime, "2026-11", "aime_expert")).traces, [5, 6]);

// Monthly bar chart uses 2 rows x 15 bars per row and Trace units, not record counts.
const traceBarSample = {
  kpi: { unique_sessions: 10, traces: 2599, tokens: 0 },
  input: { sessions: 10, traces: 3798, models: { aime_fast: { sessions: 10, traces: 3798 } } },
  daily: [
    { d: "2026-11-14", m: "aime_fast", sp: "daily", inputs: 1500, input_traces: 3798, evaluated: 1000, traces: 2599, tokens: 0, sessions: 10, sids: [0], in_sessions: 10, in_sids: [0] },
  ],
};
const html = context.chartHTML(traceBarSample, "2026-11");
assert.match(html, /class="ev-cal-rows"/);
assert.equal((html.match(/class="ev-bar-row"/g) || []).length, 2);
assert.match(html, /输入 3\.8K 条 Trace · 已完成 2\.6K 条 Trace · 68\.4%/);
assert.match(html, /<small class="evday-val num">2\.6K<\/small>/);
assert.doesNotMatch(html, /条记录/);
assert.match(html, /已完成 Trace/);
assert.match(html, /评测输入 Trace/);

// All-time view aggregates across months with deduplicated sessions and renders clickable month bars.
const allHtml = context.chartHTML(historical, "all");
assert.match(allHtml, /class="ev-month-row"/);
assert.match(allHtml, /data-jump-month="2026-10"/);
assert.match(allHtml, /data-jump-month="2026-11"/);
const allTotals = plain(context.calc(historical, "all", "all"));
assert.equal(allTotals.month, "all");
assert.deepEqual(allTotals.traces, [3299, 3377]);
console.log("PASS: 2-row 15-bar monthly chart, all-time mode, model filters, trace units, cross-day session deduplication, model families");
