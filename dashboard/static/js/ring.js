/* Shared ECharts sunburst component for data volume and cluster hierarchy. */
import { createChart, disposeChart, fmt, pct, esc, labelOn, FONT, REDUCED, T } from "./core.js";

const SERIES_ID = "hierarchy-ring";

const PALETTES = {
  light: ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948", "#184f95", "#a8431a", "#127a56", "#a06b00", "#a83e62", "#0a6b0a"],
  dark: ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767", "#4f90e0", "#c96a45", "#2a9a6d", "#b88a00", "#c45f85", "#2f9a2f"],
};

export function ringPalette(n) {
  const colors = PALETTES[T.mode === "dark" ? "dark" : "light"];
  return Array.from({ length: n }, (_, i) => colors[i % colors.length]);
}

export function createRing(chartEl, centerEl, opts = {}) {
  if (!chartEl) return null;

  const byKey = new Map();
  const children = ((opts.root && opts.root.children) || []).filter((node) => Number(node.value) > 0);

  function item(node, key, kind, parentKey, weight = Number(node.value)) {
    const expandable = Boolean((node.children || []).length);
    const interactive = kind === "base"
      ? expandable || Boolean(opts.leafInteractive)
      : expandable ? Boolean(opts.burstInteractive) : Boolean(opts.leafInteractive);
    byKey.set(key, { key, node, kind, parentKey, expandable, interactive });
    return {
      id: key,
      // Stable unique names let ECharts highlight repeated category labels correctly.
      name: key,
      displayName: node.name,
      value: weight,
      cursor: interactive ? "pointer" : "default",
      itemStyle: {
        color: node.color || T.wc,
        borderWidth: key === opts.expandedKey ? 4 : 2,
      },
      label: { color: labelOn(node.color || T.wc) },
      emphasis: { focus: kind === "base" ? "descendant" : "ancestor" },
    };
  }

  const data = children.map((node, index) => {
    const key = node.key || `base/${index}`;
    const entry = item(node, key, "base", "root");
    if (key === opts.expandedKey) {
      const descendants = (node.children || []).filter((child) => Number(child.value) > 0);
      const total = descendants.reduce((sum, child) => sum + Number(child.value), 0);
      // Partition the selected branch; retain source counts in the center and tooltip.
      entry.children = descendants.map((child, i) => item(
        child,
        child.key || `${key}/child/${i}`,
        "burst",
        key,
        total ? Number(node.value) * Number(child.value) / total : 0
      ));
    }
    return entry;
  });

  function shareOf(node) {
    return Number(node.share != null
      ? node.share
      : pct(node.value, opts.shareTotal || opts.restValue || 1));
  }

  const chart = createChart(chartEl, {
    animation: !REDUCED,
    animationDuration: 400,
    animationDurationUpdate: 250,
    textStyle: { fontFamily: FONT },
    aria: {
      enabled: true,
      label: {
        description: `${opts.ariaLabel || "分类圆环图"}。${children.map((node) => `${node.name} ${fmt(node.value)} ${opts.unit || ""}`).join("，")}`,
      },
    },
    tooltip: {
      trigger: "item",
      appendToBody: true,
      backgroundColor: T.tooltip,
      borderWidth: 0,
      textStyle: { color: T.ink, fontFamily: FONT, fontSize: 12 },
      formatter(params) {
        const arc = byKey.get(params.name);
        if (!arc) return "";
        return `${esc(arc.node.name)}<br>${fmt(arc.node.value)} ${esc(opts.unit || "")} · ${shareOf(arc.node).toFixed(1)}%`;
      },
    },
    series: [{
      id: SERIES_ID,
      name: opts.ariaLabel || "分类圆环图",
      type: "sunburst",
      data,
      center: ["50%", "50%"],
      radius: ["44%", "94%"],
      sort: null,
      nodeClick: false,
      stillShowZeroSum: false,
      renderLabelForZeroData: false,
      label: {
        position: "inside",
        rotate: 0,
        minAngle: 18,
        fontSize: 11,
        fontFamily: FONT,
        overflow: "truncate",
        width: 64,
        formatter: (params) => params.data.displayName || "",
      },
      labelLayout: { hideOverlap: true },
      itemStyle: { borderColor: T.surface, borderWidth: 2, borderRadius: 3 },
      emphasis: { focus: "descendant" },
      blur: { itemStyle: { opacity: 0.2 }, label: { opacity: 0.3 } },
      levels: [
        {},
        { radius: ["44%", "76%"] },
        { radius: ["78%", "94%"], label: { show: false } },
      ],
    }],
  });
  if (!chart) return null;

  if (centerEl) {
    centerEl.innerHTML =
      `<div class="rc-rest">` +
        `<span class="rc-rest-value"></span><span class="rc-rest-label"></span>` +
      `</div>` +
      `<div class="rc-live">` +
        `<span class="rc-line"><b class="rc-value"></b><span class="rc-unit"></span><span class="rc-meta"></span></span>` +
        `<span class="rc-name"></span>` +
      `</div>` +
      `<button class="rc-back" type="button" aria-label="返回上一级">` +
        `<svg viewBox="0 0 20 20" width="16" height="16" fill="none" aria-hidden="true"><path d="m11.5 5-5 5 5 5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>` +
      `</button>`;
  }
  const find = (selector) => centerEl && centerEl.querySelector(selector);
  const restValueEl = find(".rc-rest-value");
  const restLabelEl = find(".rc-rest-label");
  const nameEl = find(".rc-name");
  const valueEl = find(".rc-value");
  const unitEl = find(".rc-unit");
  const metaEl = find(".rc-meta");
  const backEl = find(".rc-back");

  if (restValueEl) restValueEl.textContent = fmt(opts.restValue);
  if (restLabelEl) restLabelEl.textContent = opts.restLabel || "";
  if (unitEl) unitEl.textContent = opts.unit || "";
  if (centerEl) centerEl.classList.toggle("has-focus", Boolean(opts.centerNode));
  if (backEl) {
    backEl.hidden = !opts.canBack;
    backEl.setAttribute("aria-label", opts.backLabel || "返回上一级");
    backEl.addEventListener("click", (event) => {
      event.stopPropagation();
      if (opts.onBack) opts.onBack();
    });
  }

  function paintCenter(arc) {
    const node = arc ? arc.node : opts.centerNode;
    if (centerEl) centerEl.classList.toggle("is-live", Boolean(node));
    if (node) {
      if (nameEl) {
        nameEl.textContent = node.name;
        nameEl.title = node.name;
      }
      if (valueEl) valueEl.textContent = fmt(node.value);
      if (metaEl) metaEl.textContent = `${shareOf(node).toFixed(1)}%`;
    }
  }

  function setActive(key, silent = false, external = false) {
    if (chart.isDisposed()) return;
    const arc = byKey.get(key) || null;
    if (external) {
      chart.dispatchAction({ type: "downplay", seriesId: SERIES_ID });
      if (arc) chart.dispatchAction({ type: "highlight", seriesId: SERIES_ID, name: arc.key });
    }
    paintCenter(arc);
    if (!silent && opts.onHover) opts.onHover(arc, arc ? arc.node : null);
  }

  chart.on("mouseover", (params) => setActive(params.name));
  chart.on("mouseout", () => setActive(null));
  chart.on("globalout", () => setActive(null));
  chart.on("click", (params) => {
    const arc = byKey.get(params.name);
    if (arc && arc.interactive && opts.onSelect) opts.onSelect(arc.node, arc);
  });
  paintCenter(null);

  return {
    hover(key) { setActive(key, true, true); },
    clear() { setActive(null, true, true); },
    destroy() {
      disposeChart(chartEl);
      if (centerEl) centerEl.innerHTML = "";
    },
  };
}
