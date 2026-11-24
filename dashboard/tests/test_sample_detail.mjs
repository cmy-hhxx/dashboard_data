import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The detail pane lives in one module so samples and compare share it; these checks keep the
// seam honest: prefixed ids for side-by-side panes, no second copy of the detail code.
globalThis.location = { search: "" };
globalThis.window = {};
const dir = path.dirname(fileURLToPath(import.meta.url));
const { detailPaneHTML, detailIds, utOf, isLostRow, USER_TYPE_SHORT, mergeSessionDetails, dropSubsetParts, hasSessionComment, roundQuestionOf } = await import("../static/js/sample_detail.js");
const { sessionRows } = await import("../static/js/compare.js");

test("detail pane ids carry the prefix so two panes can coexist", () => {
  const first = detailPaneHTML("");
  const second = detailPaneHTML("b");
  for (const name of ["shead", "sanatomy", "sout", "stl", "sattr"]) {
    assert.ok(first.includes(`id="${name}"`), `${name} in the unprefixed pane`);
    assert.ok(second.includes(`id="b${name}"`), `${name} in the prefixed pane`);
    assert.ok(!second.includes(`id="${name}"`), `${name} must not stay unprefixed`);
  }
  assert.ok(second.includes('class="pane-scroll"'));
});

test("id line shows the current trace once and never a case id", () => {
  const D = {
    ids: { session: "thread_s1", trace: "thread_s1", case: "case_1" },
    input: { traces: [{ trace_id: "t1" }, { trace_id: "t2" }] },
  };
  assert.deepEqual(detailIds(D, 1), [["会话 ID", "thread_s1"], ["Trace ID", "t2"]]);
  const same = { ids: { session: "thread_s1", trace: "thread_s1" }, input: { traces: [{ trace_id: "thread_s1" }] } };
  assert.deepEqual(detailIds(same, 0), [["会话 ID", "thread_s1"]],
    "a trace id equal to the session id is redundant");
});

test("user type helpers match the dashboard vocabulary", () => {
  assert.equal(utOf({ ut: "real" }), "real");
  assert.equal(utOf({ ut: "nope" }), "unknown");
  assert.equal(USER_TYPE_SHORT.real, "真实");
  assert.equal(isLostRow({ ul: 1 }), true);
  assert.equal(isLostRow({ sp: "lost" }), true);
  assert.equal(isLostRow({}), false);
});

test("samples.js keeps the list and delegates the detail to the shared module", () => {
  const source = fs.readFileSync(path.join(dir, "../static/js/samples.js"), "utf8");
  assert.ok(source.includes("createSampleDetail"));
  assert.ok(source.includes("roundQuestion: true"), "samples page headline must follow the selected round's user message");
  assert.ok(source.includes("detailPaneHTML()"));
  for (const gone of ["function loadSession", "function renderOut", "function attrHTML", "function drawThreads"]) {
    assert.ok(!source.includes(gone), `${gone} must live in sample_detail.js only`);
  }
});

test("roundQuestionOf follows the selected trace's user message and falls back in session view", () => {
  const D = {
    question: "National security is easily rationalized",
    input: {
      traces: [
        { messages: [{ k: "user", blocks: [{ x: ["Round 1 question"] }] }] },
        { messages: [{ k: "user", blocks: [{ x: ["Suppose to work that way"] }] }] },
        { messages: [{ k: "answer", blocks: [{ x: ["No user msg"] }] }] },
      ],
    },
  };
  assert.equal(roundQuestionOf(D, 0, false), "Round 1 question");
  assert.equal(roundQuestionOf(D, 1, false), "Suppose to work that way");
  assert.equal(roundQuestionOf(D, 2, false), "National security is easily rationalized");
  assert.equal(roundQuestionOf(D, 1, true), "National security is easily rationalized");
});


/* ---- 单 trace 输出 → 会话详情聚合 ------------------------------------------------- */
function traceDetail(trace, summary = "", problems = 1) {
  return {
    slug: trace,
    detail: {
      product: "aime", split: "daily", model: "aime_fast", date: "2026-10-01",
      question: "Q", question_zh: null, lang: "en",
      ids: { session: "thread_s1", trace }, meta: { request_time: "2026-10-01 10:00:00", app: "app", comefrom: "web" },
      session_meta: { app: "app", comefrom: "web" },
      input: { traces: [{ trace_id: trace, meta: { trace_id: trace }, messages: [{ k: "user", blocks: [] }] }], missing: false },
      attribution: {
        summary,
        turns: [{ trace_id: trace, summary: summary || "trace summary", problems: Array.from({ length: problems }, (_, i) => i) }],
        problems: Array.from({ length: problems }, (_, i) => ({ id: i, ev: [i] })),
        session_problems: [],
      },
      compact: { overview: [], turns: [] },
      evidence: Array.from({ length: problems }, (_, i) => ({ q: `ev${i}` })),
    },
  };
}

test("per-trace parts merge into one session with re-indexed problems and evidence", () => {
  const a = traceDetail("t1");
  const b = traceDetail("t2");
  const D = mergeSessionDetails([a, b], { sp: "daily", m: "aime_fast", sid: "thread_s1", q: "Q", d: "2026-10-01" }, "aime");
  assert.equal(D.input.traces.length, 2);
  assert.equal(D.attribution.turns.length, 2);
  assert.equal(D.attribution.problems.length, 2);
  assert.equal(D.evidence.length, 2);
  assert.deepEqual(D.attribution.problems.map((p) => p.id), [0, 1]);
  assert.deepEqual(D.attribution.problems[1].ev, [1], "second part's evidence ids are offset into the merged list");
  assert.deepEqual(D.rounds.map((r) => r.trace), [0, 1]);
  assert.deepEqual(D.rounds.map((r) => r.tid), ["t1", "t2"]);
  assert.deepEqual(D.session_meta, { app: "app", comefrom: "web" });
  assert.deepEqual(D.input.traces.map((t) => t.meta.trace_id), ["t1", "t2"]);
});

test("session comment only exists when a part carries a session_summary field", () => {
  const plain = mergeSessionDetails([traceDetail("t1"), traceDetail("t2")],
    { sp: "daily", m: "aime_fast", sid: "thread_s1", q: "Q", d: "2026-10-01" }, "aime");
  assert.equal(plain.attribution.summary, "");
  assert.equal(hasSessionComment(plain), false, "new per-trace output must not invent a session comment");

  const withComment = mergeSessionDetails([traceDetail("t1", "整段会话点评"), traceDetail("t2")],
    { sp: "daily", m: "aime_fast", sid: "thread_s1", q: "Q", d: "2026-10-01" }, "aime");
  assert.equal(withComment.attribution.summary, "整段会话点评");
  assert.equal(hasSessionComment(withComment), true, "old / post-processed data keeps its session comment");
});

test("a full-session part wins over its per-trace parts", () => {
  const full = traceDetail("t1", "会话点评");
  full.detail.attribution.turns.push({ trace_id: "t2", summary: "", problems: [1] });
  full.detail.input.traces.push({ messages: [] });
  full.detail.attribution.problems.push({ id: 1, ev: [1] });
  full.detail.evidence.push({ q: "ev1" });
  const onlyT1 = traceDetail("t1");
  const onlyT2 = traceDetail("t2");
  const kept = dropSubsetParts([onlyT1, full, onlyT2]);
  assert.deepEqual(kept.map((part) => part.slug), ["t1"], "the aggregated detail contains both traces");
  const D = mergeSessionDetails(kept, { sp: "daily", m: "aime_fast", sid: "thread_s1", q: "Q", d: "2026-10-01" }, "aime");
  assert.equal(D.attribution.turns.length, 2);
  assert.equal(D.attribution.summary, "会话点评");
});

test("compare finds the whole session's rows by session id and model", () => {
  const rows = [
    { s: "a", sid: "thread_s1", m: "aime_fast", sp: "daily" },
    { s: "b", sid: "thread_s1", m: "aime_fast", sp: "daily" },
    { s: "c", sid: "thread_s1", m: "aime_expert", sp: "daily" },
    { s: "d", sid: "thread_s2", m: "aime_fast", sp: "daily" },
  ];
  assert.deepEqual(sessionRows(rows, "thread_s1", "aime_fast", "daily").map((row) => row.s), ["a", "b"]);
  assert.deepEqual(sessionRows(rows, "thread_s1", "", "").map((row) => row.s), ["a", "b", "c"]);
  assert.deepEqual(sessionRows(rows, "missing", "", ""), []);
});
