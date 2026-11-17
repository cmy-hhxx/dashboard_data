import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

globalThis.location = { search: "" };
globalThis.window = {};
const { capacityDocHTML } = await import("../static/js/doc_capacity.js");
const { apiDocHTML } = await import("../static/js/doc_api.js");
const docsSource = fs.readFileSync(new URL("../static/js/docs.js", import.meta.url), "utf8");
const cssSource = fs.readFileSync(new URL("../static/css/docs.css", import.meta.url), "utf8");
const severityHTML = fs.readFileSync(new URL("../static/docs/severity.html", import.meta.url), "utf8");

test("docs index and document shells drop dc-head and dc-switch", () => {
  assert.ok(!docsSource.includes("dc-head"));
  assert.ok(!docsSource.includes("dc-switch"));
  assert.ok(!docsSource.includes("dc-crumb"));
  assert.ok(!severityHTML.includes("p4-head"));
  assert.ok(!cssSource.includes("dc-head"));
  assert.ok(!cssSource.includes("dc-switch"));
  assert.ok(!cssSource.includes("dc-crumb"));
  assert.ok(!cssSource.includes("p4-head"));
});

test("docs CSS enforces at most 5 font sizes and 5 text colors", () => {
  const stripped = cssSource.replace(/\/\*[\s\S]*?\*\//g, "");
  const sizes = new Set([
    ...Array.from(stripped.matchAll(/font-size\s*:\s*([^;}\s]+)/g), (m) => m[1]),
    ...Array.from(stripped.matchAll(/font\s*:\s*[^;]*(var\(--fs-[^)/\s)]+\))/g), (m) => m[1]),
  ]);
  const colors = new Set(Array.from(stripped.matchAll(/(?<![a-z-])color\s*:\s*([^;}\n]+)/g), (m) => m[1].trim()));
  assert.ok(sizes.size <= 5, `expected <=5 font sizes, got ${[...sizes]}`);
  // --dc-on resolves to var(--card) in light mode and var(--ink) in dark mode
  const semanticColors = new Set([...colors].map((c) => (c === "var(--dc-on)" ? "var(--card)" : c)));
  assert.ok(semanticColors.size <= 5, `expected <=5 text colors, got ${[...semanticColors]}`);
});

test("all three documents provide sidebar back controls and copy buttons", () => {
  const cap = capacityDocHTML();
  const api = apiDocHTML();
  assert.ok(cap.includes('class="dc-back"'));
  assert.ok(api.includes('class="dc-back"'));
  assert.ok(severityHTML.includes('class="dc-back"'));
  assert.ok(cap.includes("dc-copy"));
  assert.ok(api.includes("dc-copy"));
  assert.ok(docsSource.includes("复制五档速查"));
  assert.ok(docsSource.includes("复制判据"));
  assert.ok(docsSource.includes("复制案例"));
  assert.ok(severityHTML.includes("cite-copy"));
  // Default API commands are ready to run without $API placeholder expansion
  assert.ok(api.includes("http://10.217.219.2:2477/api/v1/analysis/severity"));
});
