import assert from "node:assert/strict";
import test from "node:test";

// compare.js only touches the DOM inside render(); the pure seam needs the same globals as
// the other front-end tests (core.js reads location.search at import time).
globalThis.location = { search: "" };
globalThis.window = {};
const { parseCompareURL, pickRound, sortPairs, filterPairs, pagePairs, pairGaps, readyOf, detailReady } = await import("../static/js/compare.js");

const pair = (eq, before, after, q = `题目 ${eq}`) => ({ id: `t${eq}`, eq, q, before: { n: before, detail: "s1" }, after: after == null ? null : { n: after, detail: eq } });

test("compare URL keeps round, pair and online as separate optional selections", () => {
  assert.deepEqual(parseCompareURL(""), { round: null, pair: null, online: null });
  assert.deepEqual(parseCompareURL("?view=compare&product=aime&round=0_version1106_test&pair=t7"),
    { round: "0_version1106_test", pair: "t7", online: null });
  assert.deepEqual(parseCompareURL("?view=compare&round=&pair=&online=sample-1"),
    { round: null, pair: null, online: "sample-1" });
  assert.equal(parseCompareURL("?pair=0").pair, "0");
});

test("an unknown round falls back to the latest, never to nothing", () => {
  const rounds = [{ id: "v1030" }, { id: "v1106" }];
  assert.equal(pickRound(rounds, "v1030").id, "v1030");
  assert.equal(pickRound(rounds, "missing").id, "v1106");
  assert.equal(pickRound(rounds, null).id, "v1106");
  assert.equal(pickRound([], "v1106"), null);
});

test("the question list ranks comparable pairs first, then by how much the question moved", () => {
  const list = sortPairs([pair(3, 2, 2), pair(1, 4, 0), pair(2, 1, 3), pair(4, 5, 0)]);
  assert.deepEqual(list.map((entry) => entry.eq), [4, 1, 2, 3]);
  assert.deepEqual(sortPairs([]), []);
  // A retest without its own detail is one-sided: a real pair always outranks it.
  assert.deepEqual(sortPairs([pair(1, 3, null), pair(2, 0, 1)]).map((entry) => entry.eq), [2, 1]);
  // A fast-model baseline (before === null) is also one-sided, ranked by its after count.
  const fast = { id: "t9", eq: 9, q: "fast", before: null, after: { n: 2, detail: 9 } };
  assert.deepEqual(sortPairs([pair(1, 3, null), fast, pair(2, 0, 1)]).map((entry) => entry.eq), [2, 1, 9]);
});

test("search filters on the question text only and leaves the order alone", () => {
  const list = [pair(1, 0, 1, "问财净利润"), pair(2, 0, 1, "AIME geometry"), pair(3, 0, 1, "净利润排名")];
  assert.deepEqual(filterPairs(list, " 净利润 ").map((entry) => entry.eq), [1, 3]);
  assert.deepEqual(filterPairs(list, "aime").map((entry) => entry.eq), [2]);
  assert.deepEqual(filterPairs(list, "").map((entry) => entry.eq), [1, 2, 3]);
  assert.deepEqual(filterPairs(list, "没有这道题"), []);
  assert.deepEqual(filterPairs([{ id: "x", eq: 1 }], "任意"), []);
});

test("paging clamps to the real page count instead of inventing empty pages", () => {
  const list = Array.from({ length: 120 }, (_, i) => pair(i + 1, 0, 0));
  assert.deepEqual(pagePairs(list, 1), { rows: list.slice(0, 50), page: 1, pages: 3 });
  assert.deepEqual(pagePairs(list, 99).rows, list.slice(100));
  assert.equal(pagePairs(list, 99).page, 3);
  assert.equal(pagePairs(list, 0).page, 1);
  assert.deepEqual(pagePairs([], 5), { rows: [], page: 1, pages: 1 });
});

test("a side without its own detail is a gap, not a copy of the other side", () => {
  assert.deepEqual(pairGaps(pair(1, 2, 3)), { before: false, after: false });
  // eq 0 is a real detail reference.
  assert.deepEqual(pairGaps({ before: { detail: "slug" }, after: { detail: 0 } }), { before: false, after: false });
  assert.deepEqual(pairGaps({ before: { detail: "slug" }, after: { detail: null } }), { before: false, after: true });
  assert.deepEqual(pairGaps({ before: { detail: null }, after: null }), { before: true, after: true });
  assert.deepEqual(pairGaps({ before: null, after: { detail: 3 } }), { before: true, after: false });
  assert.deepEqual(pairGaps({}), { before: true, after: true });
});
