/* Shared helpers: formatting, severity, counters, tooltip, segmented controls. */
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
export const REDUCED =
  new URLSearchParams(location.search).has("still") ||
  (window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches);

export const SEV = ["P0", "P1", "P2", "P3", "P4"];
export const WORST = [...SEV, "none"];
export const SEV_NAME = { P0: "P0", P1: "P1", P2: "P2", P3: "P3", P4: "P4", none: "无问题" };
export const sevColor = (key) => {
  const i = typeof key === "number" ? key : WORST.indexOf(key);
  return i >= 0 && i < 5 ? `var(--sev-${i})` : "var(--sev-none)";
};
export const KIND = {
  system: "系统", user: "用户", think: "思考", llm: "模型", call: "调用", result: "返回", answer: "回答", other: "其他",
};
export const ROLE_NOTE = {
  planning: "决定做几步、先查什么：规划器与任务编排。",
  request_generation: "把计划落成可执行的请求：参数、字段、查询语句与代码。",
  tool: "取数、检索、抓取等工具的执行与回执。",
  script: "代码解释器与 shell 脚本的执行。",
  skill: "技能文件与外部能力的装载。",
  delivery: "把材料组织成终稿：取值、推断、引用、计算与指令遵循。",
};

export const esc = (s) =>
  String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
export const fmt = (n, d = 0) =>
  n == null || !Number.isFinite(Number(n))
    ? "—"
    : Number(n).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
export const pct = (a, b, d = 0) => (b ? fmt((100 * a) / b, d) + "%" : "—");
export const compact = (n) =>
  n >= 1e9 ? fmt(n / 1e9, 1) + "B" : n >= 1e6 ? fmt(n / 1e6, 1) + "M" : n >= 1e4 ? fmt(n / 1e3, 0) + "K" : fmt(n);
export const sum = (a) => a.reduce((x, y) => x + y, 0);

/* Counters: width reserved in ch for the final string, so refreshes never shift layout. */
export function counter(value, { d = 0, suffix = "", cls = "" } = {}) {
  const final = fmt(value, d) + suffix;
  return `<span class="num ${cls}" data-count="${value}" data-d="${d}" data-suffix="${esc(suffix)}" style="min-width:${final.length}ch">${final}</span>`;
}
export function runCounters(root) {
  $$("[data-count]", root).forEach((el) => {
    const end = Number(el.dataset.count);
    const d = Number(el.dataset.d || 0);
    const suffix = el.dataset.suffix || "";
    if (REDUCED || !Number.isFinite(end)) return;
    const t0 = performance.now();
    const token = (el._tok = (el._tok || 0) + 1);
    const step = (now) => {
      if (el._tok !== token) return;
      const p = Math.min(1, (now - t0) / 900);
      const e = 1 - Math.pow(1 - p, 4);
      el.textContent = fmt(p >= 1 ? end : end * e, d) + suffix;
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

export function stack(counts, { tall = false, title = "" } = {}) {
  const total = sum(counts);
  if (!total) return `<div class="stack${tall ? " tall" : ""}"><span style="--c:var(--sev-none);flex:1"></span></div>`;
  return (
    `<div class="stack${tall ? " tall" : ""}" role="img" aria-label="${esc(title)}">` +
    counts
      .map((n, i) => (n ? `<span style="--c:${sevColor(i)};flex:${n} 1 0" data-tip="${WORST[i]}|${n}"></span>` : ""))
      .join("") +
    "</div>"
  );
}

export function hist(h, label) {
  if (!h) return "";
  const max = Math.max(...h.counts, 1);
  const bars = h.counts
    .map((c, i) => {
      const lo = h.edges[i];
      const hi = h.edges[i + 1];
      const range = hi != null ? `${compact(lo)}–${compact(hi - (Number.isInteger(hi) ? 1 : 0))}` : `≥ ${compact(lo)}`;
      return `<span style="height:${Math.max(3, (100 * c) / max)}%;animation-delay:${i * 40}ms" data-tip="${esc(label)} ${range}|${c}"></span>`;
    })
    .join("");
  return `<div class="hist">${bars}</div><div class="hist-axis num"><span>${compact(h.edges[0])}</span><span>${compact(h.edges[h.edges.length - 1])}+</span></div>`;
}

export function barRows(items, { max, fmtVal = fmt } = {}) {
  const top = max || Math.max(...items.map((x) => x.n), 1);
  return (
    `<div class="bars">` +
    items
      .map(
        (x, i) =>
          `<div class="bar-row"><span class="lbl" title="${esc(x.label || x.id)}">${esc(x.label || x.id)}</span>` +
          `<span class="track"><i style="width:${(100 * x.n) / top}%;animation-delay:${i * 35}ms"></i></span>` +
          `<span class="val num">${fmtVal(x.n)}</span></div>`,
      )
      .join("") +
    `</div>`
  );
}

/* Tooltip: one floating node; any [data-tip="title|value"] or element.tipHTML gets it. */
const tipEl = () => document.getElementById("tip");
export function showTip(html, x, y) {
  const el = tipEl();
  el.innerHTML = html;
  el.classList.add("is-on");
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  const left = Math.min(window.innerWidth - w - 12, x + 14);
  const top = y + h + 20 > window.innerHeight ? y - h - 12 : y + 16;
  el.style.left = `${Math.max(8, left)}px`;
  el.style.top = `${Math.max(8, top)}px`;
}
export function hideTip() {
  tipEl().classList.remove("is-on");
}
export function bindTips(root, resolve) {
  root.addEventListener("pointermove", (e) => {
    const t = e.target.closest("[data-tip],[data-cell],[data-mx]");
    if (!t || !root.contains(t)) return hideTip();
    const html = resolve ? resolve(t) : null;
    if (html) return showTip(html, e.clientX, e.clientY);
    if (t.dataset.tip) {
      const [a, b] = t.dataset.tip.split("|");
      const label = SEV_NAME[a] || a;
      showTip(`<div class="t-row">${esc(label)}<b class="num" style="margin-left:auto">${esc(b)}</b></div>`, e.clientX, e.clientY);
    }
  });
  root.addEventListener("pointerleave", hideTip);
}

/* Segmented control: click springs the knob; dragging tracks the pointer 1:1 and snaps crisply. */
export function segmented(el, onPick) {
  const knob = $(".seg-knob", el);
  const buttons = $$("button", el);
  let value = null;
  const place = (btn) => {
    knob.style.width = `${btn.offsetWidth}px`;
    knob.style.transform = `translateX(${btn.offsetLeft}px)`;
  };
  const set = (v, { silent = false } = {}) => {
    const btn = buttons.find((b) => b.dataset.value === v) || buttons[0];
    value = btn.dataset.value;
    buttons.forEach((b) => b.setAttribute("aria-pressed", String(b === btn)));
    place(btn);
    if (!silent) onPick(value);
  };
  let drag = null;
  el.addEventListener("pointerdown", (e) => {
    const start = buttons.find((b) => b.getAttribute("aria-pressed") === "true");
    if (!start || !e.target.closest("button")) return;
    drag = { x: e.clientX, left: start.offsetLeft, moved: false, id: e.pointerId };
  });
  el.addEventListener("pointermove", (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x;
    if (!drag.moved && Math.abs(dx) < 4) return;
    if (!drag.moved) {
      drag.moved = true;
      el.setPointerCapture(e.pointerId);
      el.classList.add("is-dragging");
    }
    const maxLeft = el.clientWidth - knob.offsetWidth - 3;
    knob.style.transform = `translateX(${Math.max(3, Math.min(maxLeft, drag.left + dx))}px)`;
  });
  const end = (e) => {
    if (!drag) return;
    const moved = drag.moved;
    drag = null;
    el.classList.remove("is-dragging");
    if (!moved) return;
    const box = knob.getBoundingClientRect();
    const mid = box.left + box.width / 2;
    const nearest = buttons.reduce((best, b) => {
      const r = b.getBoundingClientRect();
      const dist = Math.abs(r.left + r.width / 2 - mid);
      return dist < best.d ? { b, d: dist } : best;
    }, { b: buttons[0], d: Infinity }).b;
    el.classList.add("is-snapping");
    setTimeout(() => el.classList.remove("is-snapping"), 140);
    el._suppressClick = true;
    if (nearest.dataset.value !== value) set(nearest.dataset.value);
    else place(nearest);
    e.preventDefault();
  };
  el.addEventListener("pointerup", end);
  el.addEventListener("pointercancel", end);
  el.addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    if (el._suppressClick) {
      el._suppressClick = false;
      return;
    }
    if (btn.dataset.value !== value) set(btn.dataset.value);
  });
  new ResizeObserver(() => {
    const btn = buttons.find((b) => b.dataset.value === value);
    if (btn) place(btn);
  }).observe(el);
  return { set, get: () => value };
}

export async function getJSON(url) {
  const res = await fetch(url, { cache: "no-cache" });
  if (!res.ok) throw new Error(`${url} ${res.status}`);
  return res.json();
}

export function announce(text) {
  const el = document.getElementById("announcer");
  if (el) el.textContent = text;
}
