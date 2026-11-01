/* Ring: a labeled base ring with the selected branch's children as outer radial bars. */
import { fmt, pct, labelOn } from "./core.js";

const NS = "http://www.w3.org/2000/svg";
const TAU = Math.PI * 2;
const R = 38;
const HOLE = 21.5;
const BURST_R0 = 39.4;
const BURST_MAX = 52.6;
const BURST_MIN = 5.0;
const ARC_GAP = 0.024;
const LABEL_SIZE = 2.9;

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

function textUnits(name) {
  return [...String(name)].reduce(
    (n, ch) => n + (/[⺀-鿿豈-﫿＀-￯]/.test(ch) ? 1 : 0.56),
    0
  );
}

function labelFits(name, arc) {
  const mid = (arc.r0 + arc.r1) / 2;
  const span = arc.a1 - arc.a0;
  const chord = 2 * mid * Math.sin(Math.max(0, span) / 2);
  return span >= 0.08 && textUnits(name) * LABEL_SIZE + 1.4 <= chord;
}

function setRadialLift(el, angle) {
  const ux = Math.sin(angle);
  const uy = -Math.cos(angle);
  el.style.setProperty("--hover-x", `${(ux * 1.15).toFixed(2)}px`);
  el.style.setProperty("--hover-y", `${(uy * 1.15).toFixed(2)}px`);
  el.style.setProperty("--selected-x", `${(ux * 2.05).toFixed(2)}px`);
  el.style.setProperty("--selected-y", `${(uy * 2.05).toFixed(2)}px`);
}

export function createRing(chartEl, centerEl, opts = {}) {
  if (!chartEl) return null;
  chartEl.innerHTML = "";
  if (centerEl) centerEl.innerHTML = "";

  const root = opts.root;
  const baseArcs = [];
  const burstArcs = [];
  const byKey = new Map();
  const kids = Array.isArray(root && root.children) ? root.children : [];
  const total = kids.reduce((n, child) => n + Math.max(0, Number(child.value) || 0), 0);
  const baseInteractive = (child) =>
    Boolean(child && child.children && child.children.length) || Boolean(opts.leafInteractive);

  let angle = 0;
  kids.forEach((child, index) => {
    const value = Math.max(0, Number(child.value) || 0);
    if (!value || !total) return;
    const span = TAU * (value / total);
    const key = child.key || `base/${index}`;
    child.key = key;
    const pad = Math.min(ARC_GAP, span * 0.28);
    const arc = {
      key,
      node: child,
      kind: "base",
      depth: 1,
      a0: angle + pad / 2,
      a1: angle + span - pad / 2,
      midAngle: angle + span / 2,
      r0: HOLE,
      r1: R,
      parentKey: "root",
      color: child.color || "currentColor",
      expandable: Boolean(child.children && child.children.length),
      interactive: baseInteractive(child),
    };
    baseArcs.push(arc);
    byKey.set(key, arc);
    angle += span;
  });

  const parentArc = opts.expandedKey ? byKey.get(opts.expandedKey) : null;
  if (parentArc) {
    const burstKids = (Array.isArray(parentArc.node.children) ? parentArc.node.children : [])
      .filter((child) => Number(child.value) > 0);
    const maxValue = burstKids.reduce(
      (n, child) => Math.max(n, Math.max(0, Number(child.value) || 0)),
      0
    );
    const parentSpan = parentArc.a1 - parentArc.a0;
    const fanSpan = Math.min(parentSpan, Math.PI * 0.48);
    const fanStart = (parentArc.a0 + parentArc.a1) / 2 - fanSpan / 2;
    const slotSpan = burstKids.length ? fanSpan / burstKids.length : 0;
    burstKids.forEach((child, index) => {
      const value = Math.max(0, Number(child.value) || 0);
      if (!value || !maxValue) return;
      const key = child.key || `${parentArc.key}/burst/${index}`;
      child.key = key;
      const center = fanStart + slotSpan * (index + 0.5);
      const pad = Math.min(0.012, slotSpan * 0.12);
      const a0 = center - slotSpan / 2 + pad / 2;
      const a1 = center + slotSpan / 2 - pad / 2;
      const r1 = BURST_R0 + BURST_MIN + (value / maxValue) * (BURST_MAX - BURST_R0 - BURST_MIN);
      const mid = (BURST_R0 + r1) / 2;
      const width = Math.min(
        4.8,
        Math.max(1.9, 2 * mid * Math.sin(Math.max(0, slotSpan) / 2) * 0.6)
      );
      const arc = {
        key,
        node: child,
        kind: "burst",
        depth: 2,
        a0,
        a1,
        r0: BURST_R0,
        r1,
        width,
        parentKey: parentArc.key,
        color: child.color || parentArc.color,
        expandable: Boolean(child.children && child.children.length),
        interactive: child.children && child.children.length
          ? Boolean(opts.burstInteractive)
          : Boolean(opts.leafInteractive),
      };
      burstArcs.push(arc);
      byKey.set(key, arc);
    });
  }

  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 100 100");
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
  svg.setAttribute("class", "ring-svg");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", opts.ariaLabel || "圆环图");
  chartEl.appendChild(svg);

  const group = document.createElementNS(NS, "g");
  svg.appendChild(group);

  const track = document.createElementNS(NS, "circle");
  track.setAttribute("cx", "50");
  track.setAttribute("cy", "50");
  track.setAttribute("r", ((HOLE + R) / 2).toFixed(3));
  track.setAttribute("fill", "none");
  track.setAttribute("stroke-width", (R - HOLE).toFixed(3));
  track.setAttribute("class", "ring-track");
  group.appendChild(track);

  baseArcs.forEach((arc) => {
    const path = document.createElementNS(NS, "path");
    path.setAttribute("d", arcPath(50, 50, arc.r0, arc.r1, arc.a0, arc.a1));
    path.setAttribute("fill", arc.color);
    path.setAttribute(
      "class",
      `ring-arc${arc.expandable ? " is-expandable" : ""}${arc.key === opts.expandedKey ? " is-expanded is-selected" : ""}`
    );
    path.setAttribute("data-key", arc.key);
    path.setAttribute("data-kind", arc.kind);
    path.setAttribute("data-expandable", String(arc.expandable));
    path.setAttribute("stroke-width", "0.8");
    setRadialLift(path, arc.midAngle);
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

  const innerHairline = document.createElementNS(NS, "circle");
  innerHairline.setAttribute("cx", "50");
  innerHairline.setAttribute("cy", "50");
  innerHairline.setAttribute("r", (HOLE - 1.15).toFixed(3));
  innerHairline.setAttribute("fill", "none");
  innerHairline.setAttribute("stroke-width", "0.35");
  innerHairline.setAttribute("class", "ring-hairline ring-hairline--inner");
  group.appendChild(innerHairline);

  baseArcs.forEach((arc) => {
    if (!labelFits(arc.node.name, arc)) return;
    const angle = (arc.a0 + arc.a1) / 2;
    const mid = (arc.r0 + arc.r1) / 2;
    const [x, y] = point(50, 50, mid, angle);
    const label = document.createElementNS(NS, "text");
    label.setAttribute("x", x.toFixed(3));
    label.setAttribute("y", y.toFixed(3));
    label.setAttribute("text-anchor", "middle");
    label.setAttribute("dominant-baseline", "central");
    label.setAttribute("class", "ring-arc-label");
    label.setAttribute("fill", labelOn(arc.color));
    label.setAttribute("font-size", String(LABEL_SIZE));
    label.setAttribute("aria-hidden", "true");
    label.textContent = arc.node.name;
    group.appendChild(label);
    arc.labelEl = label;
  });

  burstArcs.forEach((arc) => {
    const mid = (arc.r0 + arc.r1) / 2;
    const height = arc.r1 - arc.r0;
    const rect = document.createElementNS(NS, "rect");
    rect.setAttribute("x", (50 - arc.width / 2).toFixed(3));
    rect.setAttribute("y", (50 - mid - height / 2).toFixed(3));
    rect.setAttribute("width", arc.width.toFixed(3));
    rect.setAttribute("height", height.toFixed(3));
    rect.setAttribute("rx", (Math.min(arc.width, height) / 2).toFixed(3));
    rect.setAttribute("transform", `rotate(${((arc.a0 + arc.a1) / 2 * 180 / Math.PI).toFixed(3)} 50 50)`);
    rect.setAttribute("fill", arc.color);
    rect.setAttribute("class", "ring-burst");
    rect.setAttribute("data-key", arc.key);
    rect.setAttribute("data-kind", arc.kind);
    rect.setAttribute("data-expandable", String(arc.expandable));
    group.appendChild(rect);
    arc.el = rect;
  });

  if (centerEl) {
    centerEl.innerHTML =
      `<div class="rc-rest">` +
      `<span class="rc-rest-value"></span><span class="rc-rest-label"></span>` +
      `</div>` +
      `<div class="rc-live">` +
      `<span class="rc-line"><b class="rc-value"></b><span class="rc-unit"></span><span class="rc-meta"></span></span>` +
      `<span class="rc-name"></span>` +
      `</div>` +
      `<button class="rc-back" type="button" aria-label="返回上一级"><span aria-hidden="true">←</span><span class="rc-back-text"></span></button>` +
      `<span class="rc-hint"></span>`;
  }
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
  if (centerEl) centerEl.classList.toggle("has-focus", Boolean(opts.centerNode));
  if (backTextEl) backTextEl.textContent = opts.backLabel || "上一级";
  if (backEl) {
    backEl.hidden = !opts.canBack;
    backEl.addEventListener("click", (ev) => {
      ev.stopPropagation();
      if (opts.onBack) opts.onBack();
    });
  }

  let activeKey;

  function setHint(arc) {
    if (!hintEl) return;
    let text = "";
    if (arc) {
      if (arc.kind === "burst") {
        text = arc.expandable
          ? opts.burstHint || opts.expandHint || ""
          : opts.leafHint || "";
      } else if (arc.expandable) {
        if (opts.expandedKey && arc.key === opts.expandedKey) {
          text = opts.collapseHint || "点击收起子类";
        } else if (opts.expandedKey) {
          text = opts.switchHint || opts.expandHint || "";
        } else {
          text = opts.expandHint || "";
        }
      } else {
        text = opts.leafHint || "";
      }
    } else if (opts.canBack) {
      text = opts.backHint || "";
    } else {
      text = opts.hint || "";
    }
    hintEl.textContent = text;
    hintEl.hidden = !text;
  }

  function paintCenter(arc) {
    if (!centerEl) return;
    const node = arc ? arc.node : opts.centerNode;
    centerEl.classList.toggle("is-live", Boolean(node));
    if (!node) return;
    if (nameEl) {
      nameEl.textContent = node.name;
      nameEl.title = node.name;
    }
    if (valueEl) valueEl.textContent = fmt(node.value);
    if (metaEl) {
      const share = node.share != null
        ? node.share
        : pct(node.value, opts.shareTotal || opts.restValue || 1);
      metaEl.textContent = `${Number(share).toFixed(1)}%`;
    }
  }

  function setActive(key, silent) {
    if (activeKey === key) return;
    activeKey = key;
    const active = key ? byKey.get(key) : null;
    svg.style.cursor = active && active.interactive ? "pointer" : "default";
    baseArcs.forEach((arc) => {
      let dim = false;
      let hot = false;
      if (active) {
        if (active.kind === "base") {
          dim = arc.key !== active.key;
          hot = arc.key === active.key;
        } else {
          dim = arc.key !== active.parentKey;
        }
      }
      arc.el.classList.toggle("is-dim", dim);
      arc.el.classList.toggle("is-hot", hot);
      if (arc.labelEl) {
        arc.labelEl.classList.toggle("is-dim", dim);
        arc.labelEl.classList.toggle("is-hot", hot);
      }
    });
    burstArcs.forEach((arc) => {
      let dim = false;
      let hot = false;
      if (active) {
        if (active.kind === "burst") {
          dim = arc.key !== active.key;
          hot = arc.key === active.key;
        } else {
          dim = active.key !== arc.parentKey;
        }
      }
      arc.el.classList.toggle("is-dim", dim);
      arc.el.classList.toggle("is-hot", hot);
    });
    paintCenter(active);
    setHint(active);
    if (!silent && opts.onHover) opts.onHover(active, active ? active.node : null);
  }

  function hitTest(x, y) {
    const r = Math.hypot(x - 50, y - 50);
    if (r < HOLE - 1.2 || r > BURST_MAX + 1.2) return null;
    let a = Math.atan2(x - 50, -(y - 50));
    if (a < 0) a += TAU;
    let best = null;
    let bestScore = -Infinity;
    [...baseArcs, ...burstArcs].forEach((arc) => {
      if (r < arc.r0 - 1.1 || r > arc.r1 + 1.1) return;
      let dist = 0;
      if (a < arc.a0 || a > arc.a1) {
        dist = Math.min(Math.abs(a - arc.a0), Math.abs(a - arc.a1));
        dist = Math.min(dist, TAU - dist);
        if (dist > 0.03) return;
      }
      const score = (arc.kind === "burst" ? 200 : 100) - dist;
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
    return pt.matrixTransform(ctm.inverse());
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
    if (arc && arc.interactive && opts.onSelect) opts.onSelect(arc.node, arc);
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
