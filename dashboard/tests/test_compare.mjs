import assert from "node:assert/strict";
import test from "node:test";

// compare.js only touches the DOM inside render(); the pure seam needs the same globals as
// the other front-end tests (core.js reads location.search at import time).
globalThis.location = { search: "" };
globalThis.window = {};
const { parseCompareURL, pickRound, sortPairs, filterPairs, pagePairs, pairGaps, readyOf, detailReady, timelineModel } =
  await import("../static/js/compare.js");

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

test("a lone round sits in the middle of a padded time window, never in a corner", () => {
  const model = timelineModel([{ id: "0_version1106_test", label: "v1106", released_at: "2026-11-06" }], 1200);
  assert.equal(model.nodes.length, 1);
  assert.equal(model.nodes[0].round.id, "0_version1106_test");
  assert.equal(model.nodes[0].side, "up");
  assert.ok(model.nodes[0].x > 40 && model.nodes[0].x < 65, `x=${model.nodes[0].x}`);
  // The ruler spans the padded window: enough months for a full-width hero, all inside the plot.
  assert.ok(model.months.length >= 4, `months=${model.months.length}`);
  const xs = model.months.map((month) => month.x);
  assert.deepEqual(xs, xs.slice().sort((a, b) => a - b));
  assert.ok(xs[0] >= 4 && xs[xs.length - 1] <= 96);
  assert.match(model.months[0].label, /^2026\.\d{1,2}$/);
});

test("rounds are laid out by release date, alternating above and below the axis", () => {
  const rounds = [
    { id: "late", label: "v1112", released_at: "2026-11-12" },
    { id: "early", label: "v1030", released_at: "2026-10-30" },
    { id: "mid", label: "v1106", released_at: "2026-11-06" },
  ];
  const model = timelineModel(rounds, 1200);
  assert.deepEqual(model.nodes.map((node) => node.round.id), ["early", "mid", "late"]);
  assert.deepEqual(model.nodes.map((node) => node.side), ["up", "down", "up"]);
  const xs = model.nodes.map((node) => node.x);
  assert.deepEqual(xs, xs.slice().sort((a, b) => a - b));
});

test("rounds released on the same days keep each side's labels apart", () => {
  const rounds = Array.from({ length: 6 }, (_, i) => ({ id: `r${i}`, label: `v${i}`, released_at: `2026-11-0${i + 1}` }));
  const model = timelineModel(rounds, 1200);
  assert.equal(model.nodes.length, 6);
  for (const side of ["up", "down"]) {
    const xs = model.nodes.filter((node) => node.side === side).map((node) => node.x).sort((a, b) => a - b);
    assert.equal(xs.length, 3);
    for (let i = 1; i < xs.length; i += 1) assert.ok(xs[i] - xs[i - 1] >= 12.5, `${side}: ${xs}`);
  }
  assert.ok(model.nodes.every((node) => node.x >= 4 && node.x <= 96));
});

test("an empty payload or rounds without a release date still produce a usable timeline", () => {
  assert.deepEqual(timelineModel([], 1200), { nodes: [], months: [] });
  const model = timelineModel([{ id: "a", label: "vA" }, { id: "b", label: "vB" }], 1200);
  assert.equal(model.nodes.length, 2);
  assert.ok(model.nodes.every((node) => Number.isFinite(node.x)));
});
