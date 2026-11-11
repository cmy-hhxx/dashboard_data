import assert from "node:assert/strict";
import test from "node:test";

const { patternOf, patternName } = await import("../static/js/taxonomy.js");

const tax = {
  patterns: {
    S9: { name: "答案合成" },
    "S9.M5": { name: "加工计算错误" },
    "S9.M5.3": { name: "数值推算算错", plain: "百分比、倍数、估值推算本身算错", tags: ["口径"] },
  },
};

test("a retired L4 code resolves to its current L3 parent", () => {
  const node = patternOf(tax, "S9.M5.3.4");
  assert.equal(node.id, "S9.M5.3");
  assert.equal(node.name, "数值推算算错");
  assert.equal(node.exact, false);
  assert.equal(patternName(tax, "S9.M5.3.4"), "数值推算算错");
});

test("exact codes keep their own name and are marked exact", () => {
  const node = patternOf(tax, "S9.M5.3");
  assert.equal(node.id, "S9.M5.3");
  assert.equal(node.exact, true);
  assert.equal(patternName(tax, "S9.M5.3"), "数值推算算错");
});

test("unknown roots and missing taxonomy fall back to the raw code", () => {
  assert.equal(patternOf(tax, "S8.M1"), null);
  assert.equal(patternName(tax, "S8.M1"), "S8.M1");
  assert.equal(patternName(null, "S9.M5.3.4"), "S9.M5.3.4");
});
