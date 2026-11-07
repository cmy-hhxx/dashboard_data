const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

const file = path.join(__dirname, "../static/js/samples.js");
const source = fs.readFileSync(file, "utf8");
const js = source.replace(/^import .*\n/gm, "")
  .replace("export async function render", "async function render");
const prefix = 'const SEV = ["P0", "P1", "P2", "P3", "P4"];\nconst WORST = [...SEV, "none"];\n';
const cut = js.indexOf("async function render");
const context = vm.createContext({ console });
vm.runInContext(`${prefix}${js.slice(0, cut)}\nglobalThis.api = { groupSessions, severityHit, cascadeHit, listHit };`, context);

const rows = [
  { s: "r1", sid: "same", sp: "daily", m: "fast", d: "2026-11-01", q: "q", w: "P1", n: 1, tr: 1, sv: [0, 1, 0, 0, 0], pt: [], st: [], tg: [] },
  { s: "r2", sid: "same", sp: "daily", m: "fast", d: "2026-11-02", q: "q", w: "P0", n: 1, tr: 1, sv: [1, 0, 0, 0, 0], pt: [], st: [], tg: [] },
];
const [session] = context.api.groupSessions(rows);
assert.equal(JSON.stringify(session.sv), JSON.stringify([1, 1, 0, 0, 0]), "session severity counts must aggregate all rounds");
assert.equal(context.api.severityHit(session, "P0"), true, "P0 filter must match a P0 in any round");
assert.equal(context.api.severityHit(session, "P1"), true, "P1 filter must match a P1 in any round");
assert.equal(context.api.severityHit(session, "P2"), false, "P2 filter must not match absent severity");
assert.equal(context.api.severityHit({ w: "none", sv: [0, 0, 0, 0, 0] }, "none"), true);
assert.equal(context.api.severityHit({ w: "P0", sv: [] }, "P0"), true, "legacy rows fall back to worst severity");
assert.equal(context.api.severityHit({ w: "P0", sv: [0, 0, 0, 0, 0] }, "P0"), false, "counts win over a stale worst label");
const [legacy] = context.api.groupSessions([{ s: "legacy", sid: "legacy", sp: "daily", m: "fast", d: "2026-11-01", q: "q", w: "P0", n: 1, tr: 1, pt: [], st: [], tg: [] }]);
assert.equal(context.api.severityHit(legacy, "P0"), true, "rows without severity counts fall back to worst severity");
const taxRows = [
  { sc: "场景 A", sub: "子场景 A", st: ["S1"], pt: ["S1.M1.P1"] },
  { sc: "场景 B", sub: "子场景 B", st: ["S2"], pt: ["S2.M2.P1"] },
];
const f = { scene: "场景 A", sub: "子场景 A", stage: "S1", mech: "M1", pattern: "S1.M1" };
assert.equal(context.api.cascadeHit(taxRows[0], f), true, "selected cascade values match the same row");
assert.equal(context.api.cascadeHit(taxRows[1], f), false, "selected cascade values exclude other rows");
assert.equal(context.api.cascadeHit(taxRows[1], f, "scene"), false, "scene options still honor downstream constraints");
assert.equal(context.api.cascadeHit(taxRows[1], f, "scene,sub,stage,mech,pattern"), true, "upstream options ignore resettable downstream values");
assert.equal(context.api.listHit({ ...taxRows[0], sv: [1, 0, 0, 0, 0], w: "P0" }, { ...f, w: "P0" }), true);
assert.equal(context.api.listHit({ ...taxRows[1], sv: [0, 1, 0, 0, 0], w: "P1" }, { ...f, w: "P0" }), false, "cascade options honor the active severity filter");
assert(!source.includes('${r.w} · ${r.n}'), "session list must not append the ambiguous problem total");
assert(!source.includes("fit(group, nat.group)"), "attribution cards must not be clipped by the shared band");
console.log("PASS: session severity aggregation, filtering, and independent attribution cards");
