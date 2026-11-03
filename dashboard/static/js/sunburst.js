/* Drill-down sunburst: the inner ring holds the focus's children; the outer ring holds the open child's
   children, inside that child's arc. Click an inner arc to open it (again to drill in), an outer arc to
   drill in, the centre to step back. Arcs tween between states; nothing navigates away.
   `state` ({focus, open} node ids) is kept up to date so a redraw on fresh data lands on the same
   ring; `onChange(focus, open)` reports every move. */
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
  const childLost = kids.reduce((s, c) => s + (c.lost || 0), 0);
  node.lost = Math.max(0, Math.min(node.n || 0, node.lost != null ? node.lost : childLost));
  const sumSev = (list) => list.reduce((a, c) => ({ P0: a.P0 + ((c.sev && c.sev.P0) || 0), P1: a.P1 + ((c.sev && c.sev.P1) || 0) }), { P0: 0, P1: 0 });
  if (!node.sev) {
    const sev = sumSev(kids);
    if (sev.P0 || sev.P1) node.sev = sev;
  }
  if (kids.length > KEEP + 1) {
    const small = new Set([...kids].sort((a, b) => b.n - a.n).slice(KEEP));
    const rest = kids.filter((c) => small.has(c));
    kids = kids.filter((c) => !small.has(c));
    kids.push({ id: `${node.id}/~`, name: "其他", n: rest.reduce((s, c) => s + c.n, 0),
      lost: rest.reduce((s, c) => s + (c.lost || 0), 0), sev: sumSev(rest), other: true });
  }
  node.children = kids.length ? kids : null;
  if (node.children) node.children.forEach((c) => prep(c, node));
  return node;
}
const biggest = (n) => (n.children || []).filter((c) => !c.other).reduce((a, b) => (!a || b.n > a.n ? b : a), null);

/* Outer thin marks: 流失 for 数据量, P0/P1 for 聚类体系 — same little ring, one or two tones. */
const marks = (node) =>
  node.sev
    ? [
        { n: node.sev.P0 || 0, label: "P0", c: "var(--sev-0)" },
        { n: node.sev.P1 || 0, label: "P1", c: "var(--sev-1)" },
      ].filter((m) => m.n > 0)
    : node.lost ? [{ n: node.lost, label: "流失", c: "var(--sev-1)" }] : [];
const markTotal = (node) => marks(node).reduce((s, m) => s + m.n, 0);
const byVolume = (a, b) => b.n - a.n || String(a.name).localeCompare(String(b.name));

export function sunburst(host, tree, { unit = "", sort = false, state = null, animate = true, onChange = null } = {}) {
  const root = prep(tree, null);
  const byId = new Map();
  const index = (n) => {
    byId.set(n.id, n);
    (n.children || []).forEach(index);
  };
  index(root);
  let focus = (state && byId.get(state.focus)) || root;
  let open = state && state.open !== undefined && state.focus === focus.id ? byId.get(state.open) || null : biggest(focus);
  if (open && open.parent !== focus) open = biggest(focus);
  const save = () => {
    if (state) {
      state.focus = focus.id;
      state.open = open ? open.id : null;
    }
    if (onChange) onChange(focus, open);
  };
  host.classList.add("sbx");
  host.innerHTML = `<div class="sb-view"><div class="sb"><svg viewBox="0 0 ${S} ${S}"></svg><button type="button" class="sb-c"></button></div><div class="list sb-list"></div></div>`;
  const svg = host.querySelector("svg");
  const center = host.querySelector(".sb-c");
  const list = host.querySelector(".sb-list");
  const els = new Map();
  let raf = 0;

  function layout() {
    const out = [];
    const push = (node, ring, g, fill) => {
      out.push({ node, ring, g, fill });
      const list = marks(node);
      const total = list.reduce((s, m) => s + m.n, 0);
      if (total > 0 && node.n > 0) {
        const end = g.a0 + (g.a1 - g.a0) * Math.min(1, total / node.n);
        let a = g.a0;
        list.forEach((m, i) => {
          const a1 = i === list.length - 1 ? end : a + ((end - g.a0) * m.n) / total;
          if (a1 - a > 1e-4) {
            out.push({ node, ring, mark: i, label: m.label, n: m.n,
              g: { a0: a, a1, r0: g.r1 + 1.2, r1: g.r1 + 4.2 }, fill: m.c });
          }
          a = a1;
        });
      }
    };
    const kids = focus.children || [];
    const total = kids.reduce((s, c) => s + c.n, 0) || 1;
    let a = 0;
    let span = null;
    kids.forEach((c) => {
      const a1 = a + (TAU * c.n) / total;
      push(c, "in", { a0: a, a1, r0: IN[0], r1: IN[1] },
        c === open ? "var(--accent)" : c.other ? "var(--t3)" : "var(--t2)");
      if (c === open) span = [a, a1];
      a = a1;
    });
    if (open && open.children && span) {
      const t = open.children.reduce((s, c) => s + c.n, 0) || 1;
      let b = span[0];
      open.children.forEach((c, i) => {
        const b1 = b + ((span[1] - span[0]) * c.n) / t;
        push(c, "out", { a0: b, a1: b1, r0: OUT[0], r1: OUT[1] },
          c.other ? "var(--t4)" : tint(i, open.children.length));
        b = b1;
      });
    }
    return out;
  }

  function chrome(target) {
    const up = focus.parent;
    center.disabled = !up;
    center.setAttribute("aria-label", up ? `返回 ${up.name}` : focus.name);
    center.innerHTML = `${up ? `<i>‹ ${esc(up.name)}</i>` : ""}<b class="num">${fmt(focus.n)}</b><small>${esc(up ? focus.name : unit)}</small>${
      focus.lost ? `<small class="sb-lostc">流失 ${fmt(focus.lost)}</small>` : ""}`;
    const fill = new Map(target.filter((t) => t.mark == null).map((t) => [t.node, t.fill]));
    const row = (n, cls) => {
      const total = markTotal(n);
      const tip = n.sev
        ? [["P0", n.sev.P0 || 0], ["P1", n.sev.P1 || 0]].filter((x) => x[1]).map(([k, v]) => `${k} ${fmt(v)}`).join(" · ")
        : n.lost ? `流失 ${fmt(n.lost)}` : "";
      return `<button type="button" class="li sb-r ${cls}" data-k="${esc(n.id)}" data-n="${esc(n.id)}"><i style="--c:${fill.get(n)}"></i><span title="${esc(n.name)}">${esc(n.name)}</span><small class="sb-markn num"${tip ? ` title="${esc(`${tip} · 占 ${pct(total, n.n, 1)}`)}"` : ""}>${total ? fmt(total) : ""}</small><b class="num">${fmt(n.n)}</b><em class="num">${pct(n.n, n.parent.n)}</em></button>`;
    };
    // Keep sibling categories visible while expanding the selected branch. 聚类体系 ranks by volume;
    // the arcs keep taxonomy order, the dots tie each row back to its arc.
    const kids = focus.children || [];
    const order = sort ? [...kids].sort(byVolume) : kids;
    list.innerHTML = order.map((n) =>
      row(n, n === open ? "head" : "") +
      (n === open && n.children ? (sort ? [...n.children].sort(byVolume) : n.children).map((c) => row(c, "sub")).join("") : "")
    ).join("");
  }

  function draw(animate) {
    const target = layout();
    const seen = new Set();
    const jobs = [];
    target.forEach((t) => {
      const key = t.mark == null ? t.node.id : `${t.node.id}#m${t.mark}`;
      seen.add(key);
      let el = els.get(key);
      let from = el && el._g;
      if (!el) {
        el = document.createElementNS(NS, "path");
        el.dataset.k = key;
        el.dataset.n = t.node.id;
        el.style.opacity = "0";
        els.set(key, el);
        from = { ...t.g, r1: t.g.r0 };
        el._g = from;
      }
      svg.appendChild(el);
      el._t = t;
      el.setAttribute("class", `sb-a${t.mark == null ? "" : " sb-mark"}${t.node === open && t.mark == null ? " on" : ""}`);
      el.style.fill = t.fill;
      el.dataset.tip = t.mark == null
        ? `${t.node.name}${t.node.sev && (t.node.sev.P0 || t.node.sev.P1) ? ` · P0 ${fmt(t.node.sev.P0 || 0)} · P1 ${fmt(t.node.sev.P1 || 0)}` : ""}|${fmt(t.node.n)} · ${pct(t.node.n, t.node.parent.n)}`
        : `${t.node.name} · ${t.label}|${fmt(t.n)} · ${pct(t.n, t.node.n)}`;
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
    save();
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
    save();
  });
  const hl = (id) => {
    host.classList.toggle("hovering", !!id);
    host.querySelectorAll(".hl").forEach((x) => x.classList.remove("hl"));
    if (id) host.querySelectorAll(`[data-n="${CSS.escape(id)}"]`).forEach((x) => x.classList.add("hl"));
  };
  host.addEventListener("pointerover", (e) => {
    const el = e.target.closest("[data-n]");
    hl(el && (el.tagName !== "path" || el._t) ? el.dataset.n : null);
  });
  host.addEventListener("pointerleave", () => hl(null));
  draw(animate);
  save();
  return {
    /* One ring out, as the centre does; a folded push-pull card uses it to leave the innermost level. */
    up() {
      if (!focus.parent) {
        if (open && !open.children) {
          open = null;
          draw(true);
          save();
        }
        return;
      }
      open = focus;
      focus = focus.parent;
      draw(true);
      save();
    },
  };
}
