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
    // Canvases (星图) hit-test and place their own tooltip.
    if (e.target.closest("[data-own-tip]")) return;
    const t = e.target.closest("[data-tip],[data-cell],[data-mx]");
    if (!t || !root.contains(t)) return hideTip();
    const html = resolve ? resolve(t) : null;
    if (html) return showTip(html, e.clientX, e.clientY);
    if (t.dataset.tip) {
      const [a, b, note] = t.dataset.tip.split("|");
      const label = SEV_NAME[a] || a;
      showTip(`<div class="t-row">${esc(label)}<b class="num" style="margin-left:auto">${esc(b)}</b></div>${note ? `<div class="t-note">${esc(note)}</div>` : ""}`, e.clientX, e.clientY);
    } else hideTip();
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

export async function getJSON(url, { retries = 3 } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    let res;
    try {
      res = await fetch(url, { cache: "no-cache" });
    } catch (err) {
      if (attempt >= retries) throw err;
      await new Promise((resolve) => setTimeout(resolve, 350 * (attempt + 1)));
      continue;
    }
    if (res.ok) return await res.json();
    // A deploy/build can briefly put the reverse proxy in front of a restarting
    // server; retry only gateway/server failures, never 4xx.
    if (res.status < 500 || attempt >= retries) throw new Error(`${url} ${res.status}`);
    await new Promise((resolve) => setTimeout(resolve, 350 * (attempt + 1)));
  }
}

export function announce(text) {
  const el = document.getElementById("announcer");
  if (el) el.textContent = text;
}
