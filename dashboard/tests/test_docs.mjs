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

test("docs index restores liquid-flood cards without dc-index-head and doc shells drop dc-head, dc-switch", () => {
  assert.ok(!docsSource.includes("dc-index-head"));
  assert.ok(!docsSource.includes("dc-head"));
  assert.ok(!docsSource.includes("dc-switch"));
  assert.ok(!docsSource.includes("dc-crumb"));
  assert.ok(docsSource.includes("shader_flood"));
  assert.ok(docsSource.includes("dc-foot"));
  assert.ok(docsSource.includes("dc-visual"));
  assert.ok(!severityHTML.includes("p4-head"));
  assert.ok(!cssSource.includes("dc-index-head"));
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
  const semanticColors = new Set([...colors].map((c) => (c === "var(--dc-on)" ? "var(--card)" : c)));
  assert.ok(semanticColors.size <= 5, `expected <=5 text colors, got ${[...semanticColors]}`);
});

test("all three documents provide progressive sections, sidebar back controls and copy buttons", () => {
  const cap = capacityDocHTML();
  const api = apiDocHTML();
  for (const [name, html] of [["capacity", cap], ["api", api]]) {
    assert.ok(html.includes('class="dc-back"'), `${name} missing dc-back`);
    assert.ok(html.includes("dc-copy"), `${name} missing dc-copy`);
    assert.ok(html.includes("doc-shell"), `${name} missing doc-shell`);
    assert.ok(!html.includes('class="meta"'), `${name} must not render class="meta"`);
    assert.ok(!html.includes("cap-prov"), `${name} must not render cap-prov badges`);
    assert.ok(!html.includes("cap-badges"), `${name} must not render cap-badges`);
  }
  assert.ok(severityHTML.includes('class="dc-back"'));
  assert.ok(docsSource.includes("复制五档速查"));
  assert.ok(docsSource.includes("复制判据"));
  assert.ok(docsSource.includes("复制案例"));
  assert.ok(severityHTML.includes("cite-copy"));
  // Default API commands are ready to run without $API placeholder expansion
  assert.ok(api.includes("http://10.217.219.2:2477/api/v1/analysis/severity"));
  // Share calculator step granularity keeps 100 / 200 preset exact
  assert.ok(cap.includes('id="capShareCases" type="range" min="4" max="256" step="4"'));
  assert.ok(cap.includes('id="capShareBudget" type="range" min="32" max="512" step="8"'));
});

test("severity document removes duplicate #main and p4-side-meta, orders boundary & evidence before 75 cases", () => {
  assert.ok(!severityHTML.includes('id="main"'));
  assert.ok(!severityHTML.includes("p4-side-meta"));
  const caseMatches = severityHTML.match(/<article class="case"/g) || [];
  assert.equal(caseMatches.length, 75);
  const idxEdge = severityHTML.indexOf('id="edge"');
  const idxEvidence = severityHTML.indexOf('id="evidence"');
  const idxCases = severityHTML.indexOf('id="p4CasesCard"');
  assert.ok(idxEdge > 0 && idxEvidence > idxEdge && idxCases > idxEvidence);
});
