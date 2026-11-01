/* Drill-down sunburst: the inner ring holds the focus's children; the outer ring holds the open child's
   children, inside that child's arc. Click an inner arc to open it (again to drill in), an outer arc to
   drill in, the centre to step back. Arcs tween between states; nothing navigates away. */
import { esc, fmt, pct, REDUCED } from "./core.js";

const S = 220;
const C = S / 2;
const IN = [62, 83];
const OUT = [87, 106];
const TAU = Math.PI * 2;
const KEEP = 7;
const NS = "http://www.w3.org/2000/svg";

const pt = (r, a) => `${(C + r * Math.sin(a)).toFixed(2)} ${(C - r * Math.cos(a)).toFixed(2)}`;
function arcD({ a0, a1, r0, r1 }) {
  if (a1 - a0 < 1e-4 || r1 - r0 < 0.05) return "M0 0";
  a1 = Math.min(a1, a0 + TAU - 1e-4);
  const big = a1 - a0 > Math.PI ? 1 : 0;
  return `M${pt(r1, a0)}A${r1} ${r1} 0 ${big} 1 ${pt(r1, a1)}L${pt(r0, a1)}A${r0} ${r0} 0 ${big} 0 ${pt(r0, a0)}Z`;
}
const lerp = (a, b, t) => a + (b - a) * t;
const tint = (i, n) => `color-mix(in oklab, var(--accent) ${Math.round(n > 1 ? 92 - (i * 56) / (n - 1) : 92)}%, var(--card))`;

/* Fold the smallest children beyond KEEP into one "其他" leaf, keeping the given order. */
function prep(node, parent) {
  node.parent = parent;
  let kids = (node.children || []).filter((c) => c.n > 0);
  if (kids.length > KEEP + 1) {
    const small = new Set([...kids].sort((a, b) => b.n - a.n).slice(KEEP));
    const rest = kids.filter((c) => small.has(c));
    kids = kids.filter((c) => !small.has(c));
    kids.push({ id: `${node.id}/~`, name: "其他", n: rest.reduce((s, c) => s + c.n, 0), other: true });
  }
  node.children = kids.length ? kids : null;
  if (node.children) node.children.forEach((c) => prep(c, node));
  return node;
}
const biggest = (n) => (n.children || []).filter((c) => !c.other).reduce((a, b) => (!a || b.n > a.n ? b : a), null);

export function sunburst(host, tree, { unit = "" } = {}) {
  const root = prep(tree, null);
  let focus = root;
  let open = biggest(root);
  host.classList.add("sbx");
  host.innerHTML = `<div class="sb"><svg viewBox="0 0 ${S} ${S}"></svg><button type="button" class="sb-c"></button></div><div class="list sb-list"></div>`;
  const svg = host.querySelector("svg");
  const center = host.querySelector(".sb-c");
  const list = host.querySelector(".sb-list");
  const els = new Map();
  let raf = 0;

  function layout() {
    const out = [];
    const kids = focus.children || [];
    const total = kids.reduce((s, c) => s + c.n, 0) || 1;
    let a = 0;
    let span = null;
    kids.forEach((c) => {
      const a1 = a + (TAU * c.n) / total;
      out.push({ node: c, ring: "in", g: { a0: a, a1, r0: IN[0], r1: IN[1] }, fill: c === open ? "var(--accent)" : c.other ? "var(--t3)" : "var(--t2)" });
      if (c === open) span = [a, a1];
      a = a1;
    });
    if (open && open.children && span) {
      const t = open.children.reduce((s, c) => s + c.n, 0) || 1;
      let b = span[0];
      open.children.forEach((c, i) => {
        const b1 = b + ((span[1] - span[0]) * c.n) / t;
        out.push({ node: c, ring: "out", g: { a0: b, a1: b1, r0: OUT[0], r1: OUT[1] }, fill: c.other ? "var(--t4)" : tint(i, open.children.length) });
        b = b1;
      });
    }
    return out;
  }

  function chrome(target) {
    const up = focus.parent;
    center.disabled = !up;
    center.setAttribute("aria-label", up ? `返回 ${up.name}` : focus.name);
    center.innerHTML = `${up ? `<i>‹ ${esc(up.name)}</i>` : ""}<b class="num">${fmt(focus.n)}</b><small>${esc(up ? focus.name : unit)}</small>`;
    const fill = new Map(target.map((t) => [t.node, t.fill]));
    const row = (n, cls) =>
      `<button type="button" class="li sb-r ${cls}" data-k="${esc(n.id)}"><i style="--c:${fill.get(n)}"></i><span>${esc(n.name)}</span><b class="num">${fmt(n.n)}</b><em class="num">${pct(n.n, n.parent.n)}</em></button>`;
    list.innerHTML =
      open && open.children
        ? row(open, "head") + open.children.map((n) => row(n, "sub")).join("")
        : (focus.children || []).map((n) => row(n, n === open ? "head" : "")).join("");
  }

  function draw(animate) {
    const target = layout();
    const seen = new Set();
    const jobs = [];
    target.forEach((t) => {
      seen.add(t.node.id);
      let el = els.get(t.node.id);
      let from = el && el._g;
      if (!el) {
        el = document.createElementNS(NS, "path");
        el.dataset.k = t.node.id;
        el.style.opacity = "0";
        els.set(t.node.id, el);
        from = { ...t.g, r1: t.g.r0 };
        el._g = from;
      }
      svg.appendChild(el);
      el._t = t;
      el.setAttribute("class", `sb-a${t.node === open ? " on" : ""}`);
      el.style.fill = t.fill;
      el.dataset.tip = `${t.node.name}|${fmt(t.node.n)} · ${pct(t.node.n, t.node.parent.n)}`;
      jobs.push({ el, from, to: t.g, o0: Number(el.style.opacity || 1), o1: 1 });
    });
    els.forEach((el, id) => {
      if (seen.has(id)) return;
      el._t = null;
      jobs.push({ el, from: el._g, to: { ...el._g, r1: el._g.r0 }, o0: Number(el.style.opacity || 1), o1: 0, drop: id });
    });
    chrome(target);
    cancelAnimationFrame(raf);
    const finish = () =>
      jobs.forEach((j) => {
        if (j.drop && !j.el._t) {
          j.el.remove();
          els.delete(j.drop);
        }
      });
    const frame = (k) =>
      jobs.forEach((j) => {
        const g = { a0: lerp(j.from.a0, j.to.a0, k), a1: lerp(j.from.a1, j.to.a1, k), r0: lerp(j.from.r0, j.to.r0, k), r1: lerp(j.from.r1, j.to.r1, k) };
        j.el._g = g;
        j.el.setAttribute("d", arcD(g));
        j.el.style.opacity = String(lerp(j.o0, j.o1, Math.min(1, k * 1.5)));
      });
    if (!animate || REDUCED) {
      frame(1);
      return finish();
    }
    const t0 = performance.now();
    const step = (now) => {
      const p = Math.min(1, (now - t0) / 620);
      frame(1 - Math.pow(1 - p, 4));
      if (p < 1) raf = requestAnimationFrame(step);
      else finish();
    };
    raf = requestAnimationFrame(step);
  }

  function pick(node, ring) {
    if (ring === "in") {
      if (node === open && node.children) {
        focus = node;
        open = biggest(node);
      } else open = node;
    } else {
      focus = open;
      open = node;
    }
    draw(true);
  }

  svg.addEventListener("click", (e) => {
    const t = e.target.closest("path") && e.target.closest("path")._t;
    if (t) pick(t.node, t.ring);
  });
  list.addEventListener("click", (e) => {
    const r = e.target.closest("[data-k]");
    const t = r && els.get(r.dataset.k) && els.get(r.dataset.k)._t;
    if (t) pick(t.node, t.ring);
  });
  center.addEventListener("click", () => {
    if (!focus.parent) return;
    open = focus;
    focus = focus.parent;
    draw(true);
  });
  const hl = (k) => {
    host.classList.toggle("hovering", !!k);
    host.querySelectorAll(".hl").forEach((x) => x.classList.remove("hl"));
    if (k) host.querySelectorAll(`[data-k="${CSS.escape(k)}"]`).forEach((x) => x.classList.add("hl"));
  };
  host.addEventListener("pointerover", (e) => {
    const k = e.target.closest("[data-k]");
    hl(k && (k.tagName !== "path" || k._t) ? k.dataset.k : null);
  });
  host.addEventListener("pointerleave", () => hl(null));
  draw(true);
}
