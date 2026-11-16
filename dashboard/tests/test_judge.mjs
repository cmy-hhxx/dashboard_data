import assert from "node:assert/strict";
import test from "node:test";

const { judgeMock } = await import("../static/js/judge_mock.js");

test("the mock is flagged and deterministic per product", () => {
  const a = judgeMock("aime", null);
  assert.equal(a.mock, true);
  assert.deepEqual(judgeMock("aime", null), a);
  assert.notDeepEqual(judgeMock("wencai", null).human.confusion, a.human.confusion);
});

test("the mock keeps the shape the real judge feed must follow", () => {
  const j = judgeMock("aime", { stages: [{ id: "S2", name: "规划" }, { id: "S1", name: "理解" }] });
  const rate = (v) => typeof v === "number" && v >= 0 && v <= 1;

  assert.deepEqual(j.dims.map((d) => d.key), ["grade", "evidence", "output"]);
  j.dims.forEach((d) => {
    assert.ok(rate(d.rate) && rate(d.prev));
    assert.deepEqual(d.bySev.map((s) => s.sev), ["P0", "P1", "P2", "P3", "P4"]);
    d.bySev.forEach((s) => assert.ok(rate(s.rate) && s.n > 0));
    assert.ok(d.reasons.length && d.reasons.every((x) => x.name && x.n > 0));
  });

  assert.deepEqual(j.stages.map((s) => s.id), ["S1", "S2"]);
  j.stages.forEach((s) => ["grade", "evidence", "output"].forEach((k) => assert.ok(rate(s[k]))));

  assert.equal(j.repeat.runs, j.runs);
  j.repeat.bySev.forEach((s) => assert.ok(Math.abs(s.agree.reduce((a, b) => a + b, 0) - 1) < 0.01));
  assert.equal(j.repeat.overlap.length, 10);
  ["sameSev", "sameSet", "sameEvidence"].forEach((k) => assert.ok(rate(j.repeat[k]) && rate(j.repeat.prev[k])));

  assert.equal(j.human.confusion.labels.length, 6);
  j.human.confusion.m.forEach((r) => assert.equal(r.length, 6));
  j.human.bySev.forEach((s) => assert.ok(rate(s.precision) && rate(s.recall)));

  // Every badcase fails exactly the dimension it is filed under, and the stage it names exists.
  const stages = new Set(j.stages.map((s) => s.id));
  j.badcases.forEach((b) => {
    assert.ok(stages.has(b.stage));
    assert.equal(b.verdict[b.fail].ok, false);
    assert.ok(b.verdict[b.fail].note);
    assert.equal(Object.values(b.verdict).filter((v) => !v.ok).length, 1);
    assert.equal(b.runs.length, j.runs);
    assert.ok(b.evidence.length > 0);
  });
  assert.ok(["grade", "evidence", "output"].every((k) => j.badcases.some((b) => b.fail === k)));
});
