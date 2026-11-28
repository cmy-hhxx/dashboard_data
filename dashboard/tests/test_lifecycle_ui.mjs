import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const JS_DIR = path.resolve(HERE, "../static/js");

globalThis.location = { search: "" };
globalThis.window = {};
const { ledger } = await import("../static/js/sample_drawer.js");

const dataJs = fs.readFileSync(path.join(JS_DIR, "data.js"), "utf8");
const benchJs = fs.readFileSync(path.join(JS_DIR, "bench.js"), "utf8");
const samplesJs = fs.readFileSync(path.join(JS_DIR, "samples.js"), "utf8");

test("sample_drawer ledger supports 5 input lifecycle states and Wencai ev fallback", () => {
  const groups = [{
    key: "k1",
    name: "股票研究",
    items: [
      { r: "pg:1", q: "已评问题", ev: 1, es: "evaluated" },
      { r: "pg:2", q: "重评问题", ev: 0, es: "reeval" },
      { r: "pg:3", q: "待评问题", ev: 0, es: "pending" },
      { r: "pg:4", q: "失败问题", ev: 0, es: "failed" },
      { r: "pg:5", q: "跳过问题", ev: 0, es: "skipped" },
      { r: "f:6", q: "问财旧格式", ev: 1 },
    ],
  }];
  const res = ledger(groups, false, null, null, { isInput: true });
  assert.deepEqual(res.parts.map((x) => x.n), [2, 1, 1, 1, 1]);
  assert.ok(res.html.includes("已评"));
  assert.ok(res.html.includes("重评"));
  assert.ok(res.html.includes("待评"));
  assert.ok(res.html.includes("失败"));
  assert.ok(res.html.includes("跳过"));
  assert.ok(res.html.includes("var(--sev-2)"));
  assert.ok(res.html.includes("var(--sev-1)"));
});

test("data board input table and filter expose reeval/pending/failed states without small-text explanations", () => {
  for (const token of [
    'option value="evaluated">已评测',
    'option value="reeval">重评中',
    'option value="pending">待评测',
    'option value="failed">失败',
    '<th class="out">状态</th>',
    "重评中 <b class=",
  ]) {
    assert.ok(dataJs.includes(token), `data.js missing token: ${token}`);
  }
  assert.ok(!dataJs.includes('class="meta'), "data.js must not add explanatory meta paragraphs");
});

test("bench view surfaces reeval/failed tags cleanly without small-text explanations", () => {
  for (const token of [
    'is-reeval">重评中</span>',
    'is-fail">失败</span>',
    'full.eval_status === "reeval" ? "重评中"',
  ]) {
    assert.ok(benchJs.includes(token), `bench.js missing token: ${token}`);
  }
  assert.ok(!benchJs.includes('class="meta'), "bench.js must not add explanatory meta paragraphs");
  assert.ok(!samplesJs.includes("reeval") || !samplesJs.includes('class="meta'), "samples.js must stay clean");
});
