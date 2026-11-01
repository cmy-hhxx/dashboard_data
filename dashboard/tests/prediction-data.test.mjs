import test from "node:test";
import assert from "node:assert/strict";
import { predictionData, predictionSnapshot, parsePredictionTime, predictionInputValue, predictionTimeLabel } from "../static/js/prediction-data.js";

const at = parsePredictionTime;
const make = (questions, accuracy = [], asOf = "2026-11-02T12:00+08:00") => predictionData({ prediction: { questions, accuracy } }, "wencai", asOf);

function consistent(snapshot) {
  assert.equal(snapshot.available + snapshot.pending, snapshot.total);
  assert.equal(snapshot.distribution.reduce((sum, category) => sum + category.value, 0), snapshot.available);
  assert.equal(snapshot.cumulative.at(-1)[1], snapshot.available);
  snapshot.distribution.forEach((category) => assert.equal(category.values.at(-1)[1], category.value));
}

test("cutoff includes the exact publication instant and respects timezone offsets", () => {
  const data = make([
    { id: "a", category: "行情", answer_at: "2026-11-01T10:00+08:00" },
    { id: "b", category: "研报", answer_at: "2026-11-01T04:00:00Z" },
    { id: "c", category: "行情", answer_at: "2026-11-01T12:01+08:00" },
    { id: "d", category: "未定" },
  ]);
  const snapshot = predictionSnapshot(data, "2026-11-01T12:00");
  assert.equal(snapshot.available, 2);
  assert.equal(snapshot.pending, 2);
  assert.equal(snapshot.scheduled, 3);
  consistent(snapshot);
  assert.equal(predictionSnapshot(data, at("2026-11-01T12:01")).available, 3);
});

test("timeline follows publication timestamps, preserving intraday and unequal gaps", () => {
  const timestamps = ["2026-11-01T10:05", "2026-11-01T10:20", "2026-11-02T18:00"];
  const data = make(timestamps.map((time, index) => ({ id: index, category: "行情", answer_at: time, created_at: "2020-01-01" })));
  const snapshot = predictionSnapshot(data, at("2026-11-03T00:00"));
  timestamps.forEach((time, index) => assert.deepEqual(snapshot.cumulative.find(([x]) => x === at(time)), [at(time), index + 1]));
  consistent(snapshot);
});

test("category tail aggregation conserves every available question", () => {
  const questions = Array.from({ length: 18 }, (_, index) => ({ id: index, category: `分类 ${index % 6}`, answer_at: "2026-11-01T09:00" }));
  const snapshot = predictionSnapshot(make(questions));
  assert.equal(snapshot.distribution.length, 5);
  assert.equal(snapshot.distribution.find((category) => category.name === "其他").value, 6);
  consistent(snapshot);
});

test("date-only deadlines use the end of the Shanghai calendar day", () => {
  const data = make([{ id: "a", category: "行情", answer_at: "2026-11-01" }]);
  assert.equal(predictionSnapshot(data, at("2026-11-01T12:00")).available, 0);
  assert.equal(predictionSnapshot(data, at("2026-11-02T00:00")).available, 1);
  assert.equal(predictionInputValue(at("2026-11-01T04:00Z")), "2026-11-01T12:00");
  assert.equal(predictionTimeLabel(at("2026-11-01T04:00Z"), true), "2026-11-01 12:00");
});

test("accuracy is weighted by scored questions and cannot leak future observations", () => {
  const data = make([{ id: "a", answer_at: "2026-11-01T09:00" }], [
    { model: "a_expert", at: "2026-11-01T20:00", correct: 1, total: 2 },
    { model: "a_expert", at: "2026-11-01T20:00", correct: 9, total: 18 },
    { model: "a_expert", at: "2026-11-03T20:00", correct: 20, total: 20 },
    { model: "bad", at: "2026-11-01", correct: 12, total: 10 },
    null,
  ]);
  const snapshot = predictionSnapshot(data, at("2026-11-10T00:00"));
  assert.equal(snapshot.accuracy.length, 1);
  assert.equal(snapshot.accuracy[0].points.length, 1);
  assert.equal(snapshot.accuracy[0].points[0].accuracy, 50);
  assert.equal(snapshot.accuracy[0].points[0].total, 20);
  assert.equal(predictionSnapshot(data, at("2026-11-01T19:59")).accuracy.length, 0);
});

test("real empty banks and missing metrics never become example data or zero accuracy", () => {
  const data = make([], [{ model: "fast", at: "2026-11-01", total: 0, correct: 0 }]);
  assert.equal(data.prototype, false);
  assert.equal(data.accuracy.length, 0);
  const snapshot = predictionSnapshot(data);
  assert.equal(snapshot.total, 0);
  consistent(snapshot);
});

test("both products have deterministic 1000-question examples with coherent snapshots", () => {
  for (const product of ["wencai", "aime"]) {
    const source = { input: { categories: { task: [{ name: "行情", value: 3 }, { name: "研报", value: 1 }] } } };
    const data = predictionData(source, product, "2026-11-01T09:43+08:00");
    assert.equal(data.prototype, true);
    assert.equal(data.questions.length, 1000);
    assert.deepEqual(data.questions, predictionData(source, product, "2026-11-01T09:43+08:00").questions);
    const snapshot = predictionSnapshot(data);
    assert.ok(snapshot.available > 0 && snapshot.available < 1000);
    assert.ok(new Set(data.questions.map((question) => question.answerAt)).size > 100);
    consistent(snapshot);
    snapshot.cumulative.filter((_, i) => i % 50 === 0).forEach(([time, value]) => {
      assert.equal(value, data.questions.filter((question) => question.answerAt <= time).length);
    });
    const future = predictionSnapshot(data, data.asOf + 40 * 86400000);
    assert.equal(future.available, 1000);
    assert.equal(future.pending, 0);
    consistent(future);
    assert.ok(future.accuracy.every((curve) => curve.points.every((point) => point.at <= data.asOf && point.accuracy >= 0 && point.accuracy <= 100)));
  }
});
