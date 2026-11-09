const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

// Run the actual card calculations without requiring a browser or copying the formulas.
const source = fs.readFileSync(path.join(__dirname, "../static/js/data.js"), "utf8");
const context = vm.createContext({ sum: (xs) => xs.reduce((a, b) => a + b, 0) });
vm.runInContext(source.slice(source.indexOf("const dayCount ="), source.indexOf("function evalStats(")) +
  "\nglobalThis.calc = (p, range, model = 'all') => { EV.range = range; EV.model = model; EV.year = null; return evalTotals(p); }; globalThis.defaultRange = EV.range;", context);

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
console.log("PASS: full default, time/model filters, trace units, cross-day session deduplication");
