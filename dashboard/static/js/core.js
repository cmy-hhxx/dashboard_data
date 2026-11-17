/* Shared helpers: formatting, severity, counters, tooltip, segmented controls. */
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
export const REDUCED =
  new URLSearchParams(location.search).has("still") ||
  (window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches);
// 让 CSS 也走同一套「不要动效」：?still=1 时把标记挂到 <html> 上（见 base.css）。
if (new URLSearchParams(location.search).has("still")) document.documentElement.dataset.still = "";

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
/* K/M/B is the board's only big-number unit: K from 1e3 (1 decimal), M 1, B 2,
   dropping a meaningless `.0`. Every card uses this instead of its own tiering. */
export const compact = (n) => {
  if (n == null || !Number.isFinite(Number(n))) return "—";
  const v = Number(n);
  const size = Math.abs(v);
  const [base, unit, d] = size >= 1e9 ? [1e9, "B", 2] : size >= 1e6 ? [1e6, "M", 1] : size >= 1e3 ? [1e3, "K", 1] : [];
  return base ? fmt(v / base, d).replace(/\.0+$/, "") + unit : fmt(v);
};
export const sum = (a) => a.reduce((x, y) => x + y, 0);

/* Counters: width reserved in ch for the final string, so refreshes never shift layout.
   `unit` animates the raw number and renders it through compact(); `title` carries the
   exact value so rounded K/M/B strings stay inspectable. */
export function counter(value, { d = 0, suffix = "", cls = "", unit = false, title = "" } = {}) {
  const final = (unit ? compact(value) : fmt(value, d)) + suffix;
  return `<span class="num ${cls}"${title ? ` title="${esc(title)}"` : ""} data-count="${value}" data-d="${d}" data-suffix="${esc(suffix)}"${unit ? ' data-unit="1"' : ""} style="min-width:${final.length}ch">${final}</span>`;
}
export function runCounters(root) {
  $$("[data-count]", root).forEach((el) => {
    const end = Number(el.dataset.count);
    const d = Number(el.dataset.d || 0);
    const suffix = el.dataset.suffix || "";
    const unit = el.dataset.unit === "1";
    const show = (v) => (unit ? compact(v) : fmt(v, d)) + suffix;
    if (REDUCED || !Number.isFinite(end)) return;
    const t0 = performance.now();
    const token = (el._tok = (el._tok || 0) + 1);
    const step = (now) => {
      if (el._tok !== token) return;
      const p = Math.min(1, (now - t0) / 900);
      const e = 1 - Math.pow(1 - p, 4);
      el.textContent = show(p >= 1 ? end : end * e);
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

/* Tooltip: one floating node for the whole page, and only ever one tip on screen.
   - [data-tip] / [data-cell] / [data-mx] inside a bindTips(root, resolve) root get the root's HTML;
   - a native title is taken over on hover (kept as data-hint, so the browser's own tooltip never
     stacks on ours) and shown in the same node;
   - charts that place their own reading ([data-own-tip], .kl-host) keep it, and showing this node
     hides any chart reading still up.
   A small target gets the tip right below it (above when the viewport ends), a large one gets it
   beside the pointer; either way it flips at the right and bottom edges instead of being cut. */
const tipEl = () => document.getElementById("tip");
let tipByHover = false; // shown by the hover controller (vs. a chart or list calling showTip itself)
export function showTip(html, x, y, box = null) {
  const el = tipEl();
  if (!el) return;
  tipByHover = false;
  el.innerHTML = html;
  el.classList.add("is-on");
  document.querySelectorAll(".kl-tip:not([hidden])").forEach((t) => { t.hidden = true; });
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const gap = 10;
  let top;
  if (box && box.height <= 72) top = box.bottom + gap + h <= vh - 8 ? box.bottom + gap : box.top - h - gap;
  else top = y + 16 + h <= vh - 8 ? y + 16 : y - h - gap;
  const left = x + 12 + w <= vw - 8 ? x + 12 : x - w - 12;
  el.style.left = `${Math.max(8, Math.min(vw - w - 8, left))}px`;
  el.style.top = `${Math.max(8, Math.min(vh - h - 8, top))}px`;
}
export function hideTip() {
  tipEl()?.classList.remove("is-on");
}

const tipRoots = new Map();
// Move every title on the hovered chain into data-hint; an icon-only control keeps it as its label.
function adoptTitles(node) {
  for (let n = node; n && n.nodeType === 1 && n !== document.body; n = n.parentElement) {
    const text = n.getAttribute("title");
    if (text == null) continue;
    n.removeAttribute("title");
    if (!text) continue;
    n.dataset.hint = text;
    if (!n.hasAttribute("aria-label") && !n.textContent.trim()) n.setAttribute("aria-label", text);
  }
}
const deepest = (nodes) => nodes.filter(Boolean).reduce((a, b) => (!a || (a !== b && a.contains(b)) ? b : a), null);

export function installTips() {
  if (installTips.done) return;
  installTips.done = true;
  // A title set later (a toggle relabelling itself) is taken over at once, not on the next hover.
  new MutationObserver((list) => list.forEach((m) => {
    if (m.target.hasAttribute("title")) adoptTitles(m.target);
  })).observe(document.body, { attributes: true, attributeFilter: ["title"], subtree: true });
  let queued = null;
  let raf = 0;
  const show = (html, e, box) => {
    showTip(html, e.clientX, e.clientY, box);
    tipByHover = true;
  };
  const run = () => {
    raf = 0;
    const e = queued;
    if (!e || !(e.target instanceof Element)) return hideTip();
    adoptTitles(e.target);
    const hint = e.target.closest("[data-hint]");
    const chart = e.target.closest("[data-own-tip], .kl-host");
    let t = e.target.closest("[data-tip],[data-cell],[data-mx]");
    const root = t && deepest([...tipRoots.keys()].filter((r) => r.contains(t)));
    if (!root) t = null;
    // The innermost of a custom tip, a hint and a chart wins; a chart's own controls keep their hint.
    const pick = deepest([t, hint, chart]);
    // A chart or list that calls showTip itself also hides it; only a tip this controller left up goes.
    if (!pick || pick === chart) {
      if (tipByHover) hideTip();
      return;
    }
    const box = pick.getBoundingClientRect();
    if (pick === hint) return show(`<div class="t-hint">${esc(hint.dataset.hint)}</div>`, e, box);
    const resolve = tipRoots.get(root);
    const html = resolve ? resolve(t) : null;
    if (html) return show(html, e, box);
    if (t.dataset.tip) {
      const [a, b, note] = t.dataset.tip.split("|");
      const label = SEV_NAME[a] || a;
      return show(`<div class="t-row">${esc(label)}<b class="num">${esc(b ?? "")}</b></div>${note ? `<div class="t-note">${esc(note)}</div>` : ""}`, e, box);
    }
    if (tipByHover) hideTip();
  };
  // Over the session field this fires per tile; one hit-test per frame is enough.
  document.addEventListener("pointermove", (e) => {
    queued = e;
    if (!raf) raf = requestAnimationFrame(run);
  }, { passive: true });
  // Titles go before the browser's delay can show them, even when the pointer stops dead.
  document.addEventListener("pointerover", (e) => { if (e.target instanceof Element) adoptTitles(e.target); }, true);
  const off = () => { queued = null; hideTip(); };
  document.addEventListener("pointerleave", off);
  window.addEventListener("scroll", hideTip, { passive: true, capture: true });
  window.addEventListener("blur", off);
}

export function bindTips(root, resolve) {
  tipRoots.set(root, resolve || null);
  installTips();
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

/* Network status the shell shows as a "reconnecting" strip. A refused connection (the server is
   restarting, or its port is not listening yet) is retried with growing, jittered waits instead
   of failing the page after a second; 4xx answers are real and are never retried. */
const net = { down: 0, listeners: new Set() };
export function onNetwork(fn) { net.listeners.add(fn); return () => net.listeners.delete(fn); }
function netReport(ok, attempt = 0, wait = 0) {
  if (ok) {
    if (!net.down) return;
    net.down = 0;
  } else net.down = attempt;
  net.listeners.forEach((fn) => fn({ ok, attempt, wait }));
}
const backoff = (attempt) => Math.min(15000, 600 * 2 ** attempt) * (0.75 + Math.random() * 0.5);
const pause = (ms) => new Promise((resolve) => {
  // Coming back online (or to the tab) cuts the wait short.
  const done = () => { clearTimeout(t); window.removeEventListener("online", done); resolve(); };
  const t = setTimeout(done, ms);
  window.addEventListener("online", done, { once: true });
});

export async function getJSON(url, { retries = 6 } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    let res;
    try {
      res = await fetch(url, { cache: "no-cache" });
    } catch (err) {
      // fetch() rejects on ERR_CONNECTION_REFUSED / reset / offline: nothing answered at all.
      if (attempt >= retries) { netReport(false, attempt + 1, 0); throw err; }
      const wait = backoff(attempt);
      netReport(false, attempt + 1, wait);
      await pause(wait);
      continue;
    }
    netReport(true);
    if (res.ok) return await res.json();
    // A deploy/build can briefly put the reverse proxy in front of a restarting
    // server; retry only gateway/server failures, never 4xx.
    if (res.status < 500 || attempt >= retries) throw new Error(`${url} ${res.status}`);
    await pause(backoff(attempt));
  }
}

/* A view module that failed to load (server down mid-navigation) is retried with a cache-busting
   query: a rejected dynamic import is remembered by URL, so the same URL would fail forever. */
export async function importRetry(load, url, retries = 5) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const mod = await (attempt ? import(`${url}?retry=${Date.now()}`) : load());
      netReport(true);
      return mod;
    } catch (err) {
      if (attempt >= retries) throw err;
      const wait = backoff(attempt);
      netReport(false, attempt + 1, wait);
      await pause(wait);
    }
  }
}

export function announce(text) {
  const el = document.getElementById("announcer");
  if (el) el.textContent = text;
}

/* Copy text reliably on both HTTPS and plain HTTP (navigator.clipboard is undefined on non-localhost HTTP). */
export async function copyText(text) {
  const s = String(text ?? "");
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(s);
      return true;
    }
  } catch (err) {}
  try {
    const ta = document.createElement("textarea");
    ta.value = s;
    ta.setAttribute("readonly", "");
    ta.style.cssText = "position:fixed;top:0;left:-9999px;opacity:0";
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, s.length);
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch (err) {
    return false;
  }
}

const COPY_SVG = '<svg class="dc-copy-ic" viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="5.5" y="5.5" width="7.5" height="8" rx="1.5" stroke="currentColor" stroke-width="1.3"/><path d="M10.5 5.5V3.75A1.25 1.25 0 0 0 9.25 2.5h-5.5A1.25 1.25 0 0 0 2.5 3.75v6.5A1.25 1.25 0 0 0 3.75 11.5H5.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';
const CHECK_SVG = '<svg class="dc-copy-ic" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3.5 8.5 6.5 11.5 12.5 4.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

export function copyBtnHTML(label = "复制", { text = "", fn = "", target = "", pre = false, aria = "" } = {}) {
  const attrs = [
    text ? `data-copy="${esc(text)}"` : "",
    fn ? `data-copy-fn="${esc(fn)}"` : "",
    target ? `data-copy-target="${esc(target)}"` : "",
    pre ? "data-copy-pre" : "",
    aria ? `aria-label="${esc(aria)}"` : "",
  ].filter(Boolean).join(" ");
  return `<button type="button" class="dc-copy" ${attrs}>${COPY_SVG}<span data-copy-label>${esc(label)}</span></button>`;
}

export function flashCopy(btn, ok, idleHTML) {
  if (!btn) return;
  if (!btn._idleHTML) btn._idleHTML = idleHTML ?? btn.innerHTML;
  clearTimeout(btn._copyTimer);
  const icon = btn.querySelector(".dc-copy-ic");
  if (ok && icon) icon.outerHTML = CHECK_SVG;
  const label = btn.querySelector("[data-copy-label]");
  if (label) label.textContent = ok ? "已复制" : "复制失败";
  else btn.textContent = ok ? "已复制" : "复制失败";
  btn.classList.toggle("is-done", ok);
  btn.classList.toggle("is-fail", !ok);
  btn._copyTimer = setTimeout(() => {
    btn.innerHTML = btn._idleHTML;
    btn.classList.remove("is-done", "is-fail");
  }, 1400);
}

export function wireCopy(root, resolvers = {}) {
  if (!root) return;
  root._copyResolvers = resolvers;
  if (root._copyWired) return;
  root._copyWired = true;
  root.addEventListener("click", (e) => {
    const btn = e.target.closest(".dc-copy,[data-copy],[data-copy-fn],[data-copy-target],[data-copy-pre]");
    if (!btn || !root.contains(btn)) return;
    const map = root._copyResolvers || {};
    let text = null;
    if (btn.dataset.copyFn && map[btn.dataset.copyFn]) {
      text = map[btn.dataset.copyFn](btn);
    } else if (btn.dataset.copy != null) {
      text = btn.dataset.copy;
    } else if (btn.dataset.copyTarget) {
      const target = root.querySelector(btn.dataset.copyTarget) || document.querySelector(btn.dataset.copyTarget);
      text = target ? target.textContent.trim() : null;
    } else if (btn.hasAttribute("data-copy-pre")) {
      const box = btn.closest(".dc-codebox") || btn.closest(".cap-recipe") || btn.parentElement;
      const pre = box?.querySelector("pre");
      text = pre ? pre.textContent.trim() : null;
    }
    if (text == null) return;
    copyText(text).then((ok) => flashCopy(btn, ok));
  });
}
