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
const {
  detailPaneHTML, detailIds, utOf, isLostRow, USER_TYPE_SHORT,
  mergeSessionDetails, dropSubsetParts, hasSessionComment, roundQuestionOf,
  sortSessionRows, canLazyLoadSession, pickLazyRound, buildLazyRoundDetail,
  blockPageLimit, splitBlockPages, pageIndexForOffset, pageWindow,
} = await import("../static/js/sample_detail.js");
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

test("large per-trace sessions use lazy round loading with deterministic ordering and targeting", () => {
  const rows = Array.from({ length: 25 }, (_, i) => ({
    s: `slug_${String(24 - i).padStart(2, "0")}`,
    d: i < 10 ? "2026-11-21" : "2026-11-20",
    tid: `20003020${String(1000 + (24 - i))}`,
    w: i === 5 ? "P0" : "P2",
    sv: i === 5 ? [1, 0, 0, 0, 0] : [0, 0, 1, 0, 0],
  }));
  const sorted = sortSessionRows(rows);
  assert.equal(canLazyLoadSession(sorted), true);
  assert.equal(canLazyLoadSession(sorted.slice(0, 5)), false, "small sessions stay eager");
  assert.equal(canLazyLoadSession([{ ...sorted[0], tr: 2 }, ...sorted.slice(1)]), false, "multi-trace parts stay eager");
  assert.equal(canLazyLoadSession(sorted.map(({ tid, ...rest }) => rest), "t-missing"), false, "deep-link trace falls back when tid is absent");

  assert.equal(pickLazyRound(sorted).round, 24, "defaults to the chronologically last round");
  assert.equal(pickLazyRound(sorted, { focusSlug: "slug_10" }).round, sorted.findIndex((r) => r.s === "slug_10"));
  assert.equal(pickLazyRound(sorted, { focusTrace: "200030201012" }).round, sorted.findIndex((r) => r.tid === "200030201012"));
  assert.equal(pickLazyRound(sorted, { focusTrace: "nonexistent" }).traceMiss, "nonexistent");
  assert.equal(pickLazyRound(sorted, { sev: "P0" }).round, sorted.findIndex((r) => r.w === "P0"));

  const active = traceDetail("200030201024").detail;
  const D = buildLazyRoundDetail(active, sorted, 24, { sid: "thread_s1" }, "aime");
  assert.equal(D.rounds.length, 25);
  assert.equal(D.rounds[24].loaded, true);
  assert.equal(D.rounds[24].trace, 0);
  assert.equal(D.rounds[0].loaded, false);
  assert.equal(D.rounds[0].trace, -1);
});

test("splitBlockPages preserves every character without elision and snaps to line breaks", () => {
  assert.deepEqual(splitBlockPages("", 1000), []);
  assert.equal(splitBlockPages("short text", 1000).length, 1);
  // Slightly over pageSize (<= 1.2x) stays on one page to avoid a tiny trailing page.
  assert.equal(splitBlockPages("a".repeat(1150), 1000).length, 1);

  const lines = Array.from({ length: 200 }, (_, i) => `line-${String(i).padStart(3, "0")}: ${"x".repeat(40)}\n`).join("");
  const pages = splitBlockPages(lines, 1000);
  assert.ok(pages.length > 5);
  assert.equal(pages.map((p) => p.text).join(""), lines, "concatenation must recover the exact original text");
  assert.equal(pages[0].start, 0);
  assert.equal(pages[pages.length - 1].end, lines.length);
  for (let i = 1; i < pages.length; i += 1) {
    assert.equal(pages[i].start, pages[i - 1].end, "pages must be contiguous");
    assert.ok(pages[i - 1].text.endsWith("\n"), "page cuts should snap to newline boundaries when nearby");
  }
  assert.equal(pageIndexForOffset(pages, 0), 0);
  assert.equal(pageIndexForOffset(pages, lines.length - 1), pages.length - 1);
  const mid = Math.floor(lines.length / 2);
  const midPage = pageIndexForOffset(pages, mid);
  assert.ok(mid >= pages[midPage].start && mid < pages[midPage].end);
});

test("splitBlockPages handles long single-line JSON and UTF-16 surrogate pairs safely", () => {
  const raw = "A".repeat(999) + "😀" + "B".repeat(2500);
  const pages = splitBlockPages(raw, 1000);
  assert.ok(pages.length >= 3);
  assert.equal(pages.map((p) => p.text).join(""), raw);
  // Ensure no page ends with an unpaired high surrogate.
  for (const p of pages) {
    const last = p.text.charCodeAt(p.text.length - 1);
    assert.ok(!(last >= 0xd800 && last <= 0xdbff), "must not split a surrogate pair");
  }
  assert.equal(blockPageLimit("result"), 3200);
  assert.equal(blockPageLimit("answer"), 14000);
  assert.equal(blockPageLimit("llm", "think"), 3200);
});

test("pageWindow keeps page navigation compact for large blocks", () => {
  assert.deepEqual(pageWindow(0, 5), [0, 1, 2, 3, 4]);
  assert.deepEqual(pageWindow(0, 12), [0, 1, 2, 3, "…", 11]);
  assert.deepEqual(pageWindow(5, 12), [0, "…", 4, 5, 6, "…", 11]);
  assert.deepEqual(pageWindow(11, 12), [0, "…", 8, 9, 10, 11]);
});
