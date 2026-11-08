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
const { detailPaneHTML, utOf, isLostRow, USER_TYPE_SHORT } = await import("../static/js/sample_detail.js");

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
  assert.ok(source.includes("detailPaneHTML()"));
  for (const gone of ["function loadSession", "function renderOut", "function attrHTML", "function drawThreads"]) {
    assert.ok(!source.includes(gone), `${gone} must live in sample_detail.js only`);
  }
});
