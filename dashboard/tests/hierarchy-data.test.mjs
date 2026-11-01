import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { classificationHierarchy, normalizeHierarchy, hierarchyDepth, createHierarchyState } from "../static/js/hierarchy-data.js";

const chain = (depth) => ({ name: "全部", children: [branch(depth)] });
const branch = (depth) => ({ name: `第${depth}层`, value: 10, children: depth > 1 ? [branch(depth - 1)] : [] });

test("classification keeps supplied third levels and stops where the actual data stops", () => {
  const third = { name: "技术指标", value: 10, children: [{ name: "均线", value: 10 }] };
  const input = { total: 20, categories: {
    task: [{ name: "选股", value: 10 }, { name: "资讯", value: 10 }],
    task_subtask: { 选股: [third] },
  } };
  const original = JSON.stringify(input);
  const root = normalizeHierarchy(classificationHierarchy(input, "wencai"));
  assert.equal(hierarchyDepth(root), 3);
  assert.equal(root.children.find((node) => node.name === "选股").children[0].children[0].name, "均线");
  assert.equal(root.children.find((node) => node.name === "资讯").children.length, 0);
  assert.equal(JSON.stringify(input), original);
  for (const product of ["wencai", "aime"]) {
    const tree = chain(3);
    assert.equal(hierarchyDepth(normalizeHierarchy(classificationHierarchy({ categories: { tree } }, product))), 3);
    assert.equal(hierarchyDepth(normalizeHierarchy(classificationHierarchy({ categories: { task: tree.children } }, product))), 3);
  }
});

test("shallow classification and deep clustering use the same navigation with no depth limit or leaf actions", () => {
  for (const depth of [1, 2, 3, 7]) {
    const root = normalizeHierarchy(chain(depth));
    const state = createHierarchyState(root);
    assert.equal(state.snapshot().current, root);
    assert.equal(state.snapshot().expanded, null);
    assert.equal(state.snapshot().canBack, false);
    for (let i = 0; i < depth; i++) {
      const view = state.snapshot();
      const child = (view.expanded || view.current).children[0];
      if (!child.children.length) {
        assert.equal(state.select(child.key), false);
        assert.deepEqual(state.snapshot(), view);
        break;
      }
      assert.equal(state.select(child.key), true);
    }
    let backs = 0;
    while (state.back()) {
      assert.ok(++backs <= depth, "back always reaches the root");
    }
    assert.equal(state.snapshot().current, root);
    assert.equal(state.snapshot().expanded, null);
  }
});

test("branches toggle consistently and data refresh preserves only valid drill paths", () => {
  const root = normalizeHierarchy(chain(4));
  const state = createHierarchyState(root);
  const first = root.children[0];
  assert.equal(state.select(first.key), true);
  assert.equal(state.snapshot().expanded, first);
  assert.equal(state.select(first.key), true);
  assert.equal(state.snapshot().expanded, null);
  state.select(first.key);
  state.select(first.children[0].key);
  const currentKey = state.snapshot().current.key;
  const refreshed = normalizeHierarchy(chain(4));
  state.update(refreshed);
  assert.equal(state.snapshot().current.key, currentKey);
  assert.notEqual(state.snapshot().current, first.children[0]);
  const replacement = normalizeHierarchy({ name: "全部", children: [{ name: "新分类", value: 5 }] });
  state.update(replacement);
  assert.equal(state.snapshot().current, replacement);
  assert.equal(state.snapshot().canBack, false);
});

test("normalization preserves counts and distinguishes repeated labels across branches", () => {
  const root = normalizeHierarchy({ name: "全部", sessions: 100, children: [
    { name: "A", sessions: 60, count: 120, children: [{ name: "相同分类", value: 60 }] },
    { name: "B", value: 40, children: [{ name: "相同分类", value: 40 }, { name: "空分类", value: 0 }] },
  ] });
  assert.equal(root.value, 100);
  assert.equal(root.children[0].items, 120);
  assert.deepEqual(root.children.map((node) => node.share), [60, 40]);
  assert.notEqual(root.children[0].children[0].key, root.children[1].children[0].key);
  assert.equal(root.children[1].children.length, 1);
  assert.equal(root.children[1].children[0].share, 100);
});

test("both bundled products feed the same normalized hierarchy contract", async () => {
  const data = JSON.parse(await readFile(new URL("../static/data.json", import.meta.url), "utf8"));
  for (const product of ["wencai", "aime"]) {
    const source = data[product];
    for (const raw of [classificationHierarchy(source.input, product), source.cluster.tree]) {
      const root = normalizeHierarchy(raw);
      assert.ok(root.value > 0 && root.children.length > 0);
      assert.ok(hierarchyDepth(root) >= 2);
      const view = createHierarchyState(root).snapshot();
      assert.equal(view.expanded, null);
      assert.equal(view.current, root);
      assert.equal(view.canBack, false);
    }
  }
});
