/* One complete ring card body: native ECharts, colors, legend and navigation. */
import { createRing, ringPalette } from "./ring.js";
import { normalizeHierarchy, createHierarchyState } from "./hierarchy-data.js";
import { fmt, esc, lerpColor, T } from "./core.js";

function coloredHierarchy(source) {
  const root = normalizeHierarchy(source);
  const names = [...new Set(root.children.map((node) => node.name))]
    .sort((a, b) => a.localeCompare(b, "zh-Hans-CN"));
  const colors = ringPalette(names.length);
  const byName = new Map(names.map((name, i) => [name, colors[i]]));
  const mixColor = T.mode === "dark" ? "#ffffff" : T.surface;
  function paint(node, base, index, count) {
    const mix = Math.min(0.48, 0.1 + (node.depth - 1) * 0.06 + index / Math.max(count - 1, 1) * 0.08);
    node.color = node.depth === 1 ? base : lerpColor(base, mixColor, mix);
    node.children.forEach((child, i) => paint(child, base, i, node.children.length));
  }
  root.children.forEach((child, i) => paint(child, byName.get(child.name), i, root.children.length));
  return root;
}

export function createHierarchyCard(body, initialProps) {
  body.innerHTML = `<div class="ring-wrap"><div class="ring-chart"></div><div class="ring-center"></div></div><div class="ring-legend"></div>`;
  const chartEl = body.querySelector(".ring-chart");
  const centerEl = body.querySelector(".ring-center");
  const legendEl = body.querySelector(".ring-legend");
  let props = initialProps;
  const state = createHierarchyState(coloredHierarchy(props.root));
  let ring = null;

  function navigate(action) {
    const keepFocus = body.contains(document.activeElement);
    if (!action()) return;
    draw();
    if (keepFocus) (body.querySelector(".rc-back:not([hidden])") || body.querySelector("button.rl-row"))?.focus({ preventScroll: true });
  }

  function draw() {
    if (ring) ring.destroy();
    ring = null;
    const view = state.snapshot();
    const { root, current, expanded } = view;
    const empty = !current.children.length;
    body.classList.toggle("is-empty", empty);
    centerEl.hidden = empty;
    legendEl.hidden = empty;
    if (empty) {
      chartEl.innerHTML = `<div class="empty-state"><p>${esc(props.emptyLabel || "暂无分类数据")}</p></div>`;
      legendEl.innerHTML = "";
    } else {
      chartEl.innerHTML = "";
      const rows = (expanded || current).children;
      legendEl.innerHTML = `<div class="rl-head"><span>${expanded ? esc(expanded.name) : "类别构成"}</span><span>${fmt(rows.length)} 类</span></div>` +
        `<div class="rl-rows">${rows.map((node) => {
          const branch = node.children.length > 0;
          const tag = branch ? "button" : "div";
          const attrs = branch ? ` type="button" aria-label="${esc(node.name)}，${fmt(node.value)} ${esc(props.unit)}"` : "";
          return `<${tag} class="rl-row${branch ? "" : " is-static"}" data-key="${esc(node.key)}"${attrs}>` +
            `<i class="rl-dot" style="background:${node.color}"></i><span class="rl-name">${esc(node.name)}</span>` +
            `<span class="rl-val">${fmt(node.value)}</span><span class="rl-pct">${node.share.toFixed(1)}%</span></${tag}>`;
        }).join("")}</div>`;
      ring = createRing(chartEl, centerEl, {
        root: current,
        expandedKey: expanded?.key || "",
        unit: props.unit,
        restValue: current.value,
        restLabel: props.restLabel || props.unit,
        centerNode: expanded || (current !== root ? current : null),
        canBack: view.canBack,
        backLabel: expanded ? `返回${current.name}` : `返回${view.path.at(-2)?.name || root.name}`,
        burstInteractive: true,
        ariaLabel: props.ariaLabel,
        onHover(arc) {
          legendEl.querySelectorAll(".rl-row").forEach((row) => row.classList.toggle("is-hover", row.dataset.key === arc?.key));
        },
        onSelect(node) { navigate(() => state.select(node.key)); },
        onBack() { navigate(() => state.back()); },
      });
      legendEl.querySelectorAll(".rl-row").forEach((row) => {
        const enter = () => { row.classList.add("is-hover"); ring?.hover(row.dataset.key); };
        const leave = () => { row.classList.remove("is-hover"); ring?.clear(); };
        row.addEventListener("pointerenter", enter);
        row.addEventListener("pointerleave", leave);
        row.addEventListener("focus", enter);
        row.addEventListener("blur", leave);
      });
    }
    props.onChange?.(view);
  }
  legendEl.onclick = (event) => {
    const row = event.target.closest("button.rl-row");
    if (row) navigate(() => state.select(row.dataset.key));
  };
  draw();
  return {
    update(nextProps) {
      props = nextProps;
      state.update(coloredHierarchy(props.root));
      draw();
    },
    destroy() {
      ring?.destroy();
      legendEl.onclick = null;
      body.innerHTML = "";
    },
  };
}
