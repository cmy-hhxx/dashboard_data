/* Concentric ring: one level at a time, polar hit-testing, focus dimming and an in-ring readout. */
import { fmt, pct } from "./core.js";

const NS = "http://www.w3.org/2000/svg";
const TAU = Math.PI * 2;

function point(cx, cy, r, a) {
  return [cx + Math.sin(a) * r, cy - Math.cos(a) * r];
}

function arcPath(cx, cy, r0, r1, a0, a1) {
  const large = a1 - a0 > Math.PI ? 1 : 0;
  const [x0, y0] = point(cx, cy, r1, a0);
  const [x1, y1] = point(cx, cy, r1, a1);
  const [x2, y2] = point(cx, cy, r0, a1);
  const [x3, y3] = point(cx, cy, r0, a0);
  return `M${x0.toFixed(3)} ${y0.toFixed(3)}` +
    `A${r1.toFixed(3)} ${r1.toFixed(3)} 0 ${large} 1 ${x1.toFixed(3)} ${y1.toFixed(3)}` +
    `L${x2.toFixed(3)} ${y2.toFixed(3)}` +
    `A${r0.toFixed(3)} ${r0.toFixed(3)} 0 ${large} 0 ${x3.toFixed(3)} ${y3.toFixed(3)}Z`;
}

function treeDepth(node, limit) {
  if (!node || !node.children || !node.children.length || limit <= 0) return 0;
  return 1 + Math.max(...node.children.map((c) => treeDepth(c, limit - 1)));
}

export function createRing(chartEl, centerEl, opts = {}) {
  if (!chartEl) return null;
  chartEl.innerHTML = "";
  if (centerEl) centerEl.innerHTML = "";

  const R = 48.6;
  const HOLE = opts.hole || 30;
  const root = opts.root;
  const requestedDepth = Math.max(1, Number(opts.maxDepth) || 1);
  const levels = Math.max(1, Math.min(requestedDepth, treeDepth(root, requestedDepth)));
  const bandGap = 1.35;
  const weights = Array.from({ length: levels }, (_, i) => {
    const w = Number(opts.bandWeights && opts.bandWeights[i]);
    return w > 0 ? w : 1;
  });
  const weightSum = weights.reduce((n, w) => n + w, 0) || levels;
  const bandSpace = R - HOLE - (levels - 1) * bandGap;
  const bandSizes = weights.map((w) => (bandSpace * w) / weightSum);
  const bandStart = (depth) =>
    HOLE + (depth - 1) * bandGap + bandSizes.slice(0, depth - 1).reduce((n, w) => n + w, 0);
  const arcGap = opts.gap == null ? 0.026 : Math.max(0, Number(opts.gap) || 0);
  const arcs = [];
  const byKey = new Map();

  function walk(node, depth, a0, a1, parentKey, ancestors, topKey) {
    const kids = Array.isArray(node && node.children) ? node.children : [];
    const sum = kids.reduce((n, c) => n + Math.max(0, Number(c.value) || 0), 0);
    if (!sum || depth > levels) return;
    let a = a0;
    kids.forEach((child, index) => {
      const value = Math.max(0, Number(child.value) || 0);
      const span = (a1 - a0) * (value / sum);
      if (span <= 0) {
        a += span;
        return;
      }
      const key = child.key || `${parentKey}/${index}`;
      child.key = key;
      const r0 = bandStart(depth);
      const r1 = r0 + bandSizes[depth - 1];
      const pad = Math.min(arcGap, span * 0.28);
      const c0 = a + pad / 2;
      const c1 = a + span - pad / 2;
      const arc = {
        key,
        node: child,
        depth,
        a0: c0,
        a1: c1,
        r0,
        r1,
        parentKey,
        ancestors,
        topKey: topKey || key,
        expandable: Boolean(child.children && child.children.length),
      };
      arcs.push(arc);
      byKey.set(key, arc);
      if (child.children && child.children.length && depth < levels) {
        walk(child, depth + 1, c0, c1, key, [...ancestors, key], topKey || key);
      }
      a += span;
    });
  }

  walk(root, 1, 0, TAU, "root", [], null);

  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 100 100");
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
  svg.setAttribute("class", `ring-svg${levels === 1 ? " ring-svg--single" : ""}`);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", opts.ariaLabel || "同心圆");
  chartEl.appendChild(svg);

  const group = document.createElementNS(NS, "g");
  svg.appendChild(group);

  if (levels === 1) {
    const track = document.createElementNS(NS, "circle");
    track.setAttribute("cx", "50");
    track.setAttribute("cy", "50");
    track.setAttribute("r", ((HOLE + R) / 2).toFixed(3));
    track.setAttribute("fill", "none");
    track.setAttribute("stroke-width", (R - HOLE).toFixed(3));
    track.setAttribute("class", "ring-track");
    group.appendChild(track);
  }

  arcs.forEach((arc) => {
    const path = document.createElementNS(NS, "path");
    path.setAttribute("d", arcPath(50, 50, arc.r0, arc.r1, arc.a0, arc.a1));
    path.setAttribute("fill", arc.node.color || "currentColor");
    path.setAttribute("class", `ring-arc${arc.expandable ? " is-expandable" : ""}`);
    path.setAttribute("data-key", arc.key);
    path.setAttribute("data-depth", String(arc.depth));
    path.setAttribute("data-expandable", String(arc.expandable));
    path.setAttribute("stroke-width", arc.depth === 1 ? "0.7" : "0.55");
    group.appendChild(path);
    arc.el = path;
  });

  const hairline = document.createElementNS(NS, "circle");
  hairline.setAttribute("cx", "50");
  hairline.setAttribute("cy", "50");
  hairline.setAttribute("r", (R + 1.15).toFixed(3));
  hairline.setAttribute("fill", "none");
  hairline.setAttribute("stroke-width", "0.35");
  hairline.setAttribute("class", "ring-hairline");
  group.appendChild(hairline);

  if (levels === 1) {
    const innerHairline = document.createElementNS(NS, "circle");
    innerHairline.setAttribute("cx", "50");
    innerHairline.setAttribute("cy", "50");
    innerHairline.setAttribute("r", (HOLE - 1.15).toFixed(3));
    innerHairline.setAttribute("fill", "none");
    innerHairline.setAttribute("stroke-width", "0.35");
    innerHairline.setAttribute("class", "ring-hairline ring-hairline--inner");
    group.appendChild(innerHairline);
  }

  if (centerEl) {
    centerEl.innerHTML =
      `<span class="rc-crumb"></span>` +
      `<div class="rc-rest">` +
      `<span class="rc-rest-value"></span><span class="rc-rest-label"></span>` +
      `</div>` +
      `<div class="rc-live">` +
      `<span class="rc-name"></span>` +
      `<span class="rc-line"><b class="rc-value"></b><span class="rc-unit"></span><span class="rc-meta"></span></span>` +
      `</div>` +
      `<button class="rc-back" type="button" aria-label="返回上一级"><span aria-hidden="true">←</span><span class="rc-back-text"></span></button>` +
      `<span class="rc-hint"></span>`;
  }
  const crumbEl = centerEl && centerEl.querySelector(".rc-crumb");
  const restValueEl = centerEl && centerEl.querySelector(".rc-rest-value");
  const restLabelEl = centerEl && centerEl.querySelector(".rc-rest-label");
  const nameEl = centerEl && centerEl.querySelector(".rc-name");
  const valueEl = centerEl && centerEl.querySelector(".rc-value");
  const unitEl = centerEl && centerEl.querySelector(".rc-unit");
  const metaEl = centerEl && centerEl.querySelector(".rc-meta");
  const backEl = centerEl && centerEl.querySelector(".rc-back");
  const backTextEl = centerEl && centerEl.querySelector(".rc-back-text");
  const hintEl = centerEl && centerEl.querySelector(".rc-hint");

  if (restValueEl) restValueEl.textContent = fmt(opts.restValue);
  if (restLabelEl) restLabelEl.textContent = opts.restLabel || "";
  if (unitEl) unitEl.textContent = opts.unit || "";
  if (crumbEl) {
    const crumbs = Array.isArray(opts.crumbs) ? opts.crumbs.filter(Boolean) : [];
    if (crumbs.length) {
      crumbEl.textContent = crumbs.join(" / ");
      crumbEl.title = crumbs.join(" / ");
    }
  }
  if (centerEl) {
    centerEl.classList.toggle("has-focus", Boolean(opts.centerNode));
    centerEl.classList.toggle("is-live", Boolean(opts.centerNode));
  }
  if (backTextEl) backTextEl.textContent = opts.backLabel || "上一级";
  if (backEl) {
    backEl.hidden = !opts.canBack;
    backEl.addEventListener("click", (ev) => {
      ev.stopPropagation();
      if (opts.onBack) opts.onBack();
    });
  }

  const focusKeys = new Set();
  if (opts.focusKey) {
    focusKeys.add(opts.focusKey);
    arcs.forEach((arc) => {
      if (arc.ancestors.includes(opts.focusKey)) focusKeys.add(arc.key);
    });
  }

  let activeKey;

  function setHint(arc) {
    if (!hintEl) return;
    let text;
    if (arc) text = arc.expandable ? (opts.expandHint || "点击展开") : (opts.leafHint || "");
    else if (opts.canBack) text = opts.backHint || "";
    else text = opts.hint || "";
    hintEl.textContent = text;
    hintEl.hidden = !text;
  }

  function paintCenter(arc) {
    if (!centerEl) return;
    const node = arc ? arc.node : opts.centerNode;
    centerEl.classList.toggle("is-live", Boolean(node));
    if (!node) return;
    if (nameEl) {
      const resting = !arc && Boolean(opts.centerNode);
      nameEl.hidden = resting;
      if (!resting) {
        nameEl.textContent = node.name;
        nameEl.title = node.name;
      }
    }
    if (valueEl) valueEl.textContent = fmt(node.value);
    if (metaEl) {
      const share = node.share != null ? node.share : pct(node.value, opts.shareTotal || opts.restValue || 1);
      metaEl.textContent = `${Number(share).toFixed(1)}%`;
    }
  }

  function setActive(key, silent) {
    if (activeKey === key) return;
    activeKey = key;
    const active = key ? byKey.get(key) : null;
    const interactive = Boolean(active) && (active.expandable || Boolean(opts.leafInteractive));
    svg.style.cursor = interactive ? "pointer" : "default";
    arcs.forEach((arc) => {
      const inSubtree = Boolean(active) && (arc.key === active.key || arc.ancestors.includes(active.key));
      const isAncestor = Boolean(active) && active.ancestors.includes(arc.key);
      const dim = Boolean(active) && !inSubtree && !isAncestor;
      arc.el.classList.toggle("is-dim", dim);
      arc.el.classList.toggle("is-hot", Boolean(active) && arc.key === active.key);
      arc.el.classList.toggle("is-muted", !active && focusKeys.size > 0 && !focusKeys.has(arc.key));
    });
    paintCenter(active);
    setHint(active);
    if (!silent && opts.onHover) opts.onHover(active, active ? active.node : null);
  }

  function hitTest(x, y) {
    const r = Math.hypot(x - 50, y - 50);
    if (r < HOLE - 1.2 || r > R + 1.2) return null;
    let a = Math.atan2(x - 50, -(y - 50));
    if (a < 0) a += TAU;
    let best = null;
    let bestScore = -Infinity;
    arcs.forEach((arc) => {
      if (r < arc.r0 - 1.1 || r > arc.r1 + 1.1) return;
      let dist = 0;
      if (a < arc.a0 || a > arc.a1) {
        dist = Math.min(Math.abs(a - arc.a0), Math.abs(a - arc.a1));
        dist = Math.min(dist, TAU - dist);
        if (dist > 0.03) return;
      }
      const score = arc.depth * 100 - dist;
      if (score > bestScore) {
        best = arc;
        bestScore = score;
      }
    });
    return best;
  }

  function coords(ev) {
    const ctm = svg.getScreenCTM && svg.getScreenCTM();
    if (!ctm) return null;
    const pt = svg.createSVGPoint();
    pt.x = ev.clientX;
    pt.y = ev.clientY;
    const p = pt.matrixTransform(ctm.inverse());
    return p;
  }

  svg.addEventListener("pointermove", (ev) => {
    const p = coords(ev);
    if (!p) return;
    const arc = hitTest(p.x, p.y);
    setActive(arc ? arc.key : null);
  });
  svg.addEventListener("pointerleave", () => {
    svg.style.cursor = "default";
    setActive(null);
  });
  svg.addEventListener("click", (ev) => {
    const p = coords(ev);
    if (!p) return;
    const arc = hitTest(p.x, p.y);
    if (arc && (arc.expandable || opts.leafInteractive) && opts.onSelect) opts.onSelect(arc.node, arc);
  });

  setActive(null, true);

  return {
    hover(key) {
      setActive(key || null, true);
    },
    clear() {
      setActive(null, true);
    },
    destroy() {
      chartEl.innerHTML = "";
      if (centerEl) centerEl.innerHTML = "";
    },
  };
}
