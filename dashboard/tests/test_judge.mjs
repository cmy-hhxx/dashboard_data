import assert from "node:assert/strict";
import test from "node:test";

const { judgeMock } = await import("../static/js/judge_mock.js");

test("the mock is flagged and deterministic per product", () => {
  const a = judgeMock("aime", null);
  assert.equal(a.mock, true);
  assert.deepEqual(judgeMock("aime", null), a);
  assert.notDeepEqual(judgeMock("wencai", null).confusion, a.confusion);
});

test("the mock keeps the shape the real judge feed must follow", () => {
  const j = judgeMock("aime", { stages: [{ id: "S2", name: "规划" }, { id: "S1", name: "理解" }] });
  assert.equal(j.confusion.labels.length, 6);
  assert.equal(j.confusion.m.length, 6);
  j.confusion.m.forEach((row) => assert.equal(row.length, 6));
  assert.deepEqual(j.categories.map((c) => c.id), ["S1", "S2"]);
  j.stability.forEach((s) => assert.ok(Math.abs(s.agree.reduce((a, b) => a + b, 0) - 1) < 0.01));
  j.bias.forEach((b) => assert.ok(b.lo <= b.shift && b.shift <= b.hi));
  assert.ok(j.trend.every((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.date) && r.value > 0 && r.volume > 0));
  assert.deepEqual(j.releases.map((r) => r.date), ["2026-11-06", "2026-11-12"]);
  ["kappa", "precision", "recall", "ece", "repeat", "evidence"].forEach((k) => {
    assert.equal(typeof j.kpi[k], "number");
    assert.equal(typeof j.kpiPrev[k], "number");
  });
});
