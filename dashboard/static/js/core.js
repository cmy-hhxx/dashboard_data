/* Shared design tokens, formatters, ECharts lifecycle and count-up helpers. */
export const $ = (id) => document.getElementById(id);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
export const FONT =
  '"Inter","SF Pro Text",-apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif';
export const STILL = (() => {
  try {
    return new URLSearchParams(location.search).has("still");
  } catch (e) {
    return false;
  }
})();
export const REDUCED =
  STILL || (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);

export const fmt = (n) =>
  n == null || Number.isNaN(Number(n)) ? "—" : Number(n).toLocaleString("en-US");
export const fmtFixed = (n, d) =>
  Number(n).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
export const pct = (a, b) => (b ? (100 * a) / b : 0);
export const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
export const fmtBytes = (n) => {
  if (!n) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = Number(n);
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
};
export const fmtTokens = (n) => {
  if (!n) return "—";
  if (n >= 1e9) return (n / 1e9).toFixed(1) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return Math.round(n / 1e3) + "K";
  return String(n);
};
export const dateRange = (r) => {
  if (!r) return "—";
  return r.start === r.end ? r.start : `${r.start.slice(5)} → ${r.end.slice(5)}`;
};
export const esc = (s) =>
  String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

export function lerpColor(a, b, t) {
  if (!a || !b || !a.startsWith("#") || !b.startsWith("#")) return a || b || "transparent";
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const mix = (s) =>
    Math.round(((pa >> s) & 255) + (((pb >> s) & 255) - ((pa >> s) & 255)) * clamp(t, 0, 1));
  return (
    "#" +
    [16, 8, 0]
      .map((s) => mix(s).toString(16).padStart(2, "0"))
      .join("")
  );
}

export function hexA(hex, alpha) {
  if (!hex || !hex.startsWith("#")) return hex || `rgba(100,116,139,${alpha})`;
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

export function labelOn(hex) {
  const n = parseInt(hex.slice(1), 16);
  const lin = (c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  const L =
    0.2126 * lin((n >> 16) & 255) +
    0.7152 * lin((n >> 8) & 255) +
    0.0722 * lin(n & 255);
  const white = 1.05 / (L + 0.05);
  const black = (L + 0.05) / 0.05;
  return white >= black ? "#ffffff" : T.mode === "dark" ? "#0e1217" : T.ink;
}

export function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export const T = {};
export const C = {};
export const SEV_COLOR = {};
export const tip = {};
export const AIME_SEVERITIES = ["P0", "P1", "P2", "P3", "未分级"];

export function readTokens() {
  const names = [
    "bg", "surface", "surface-2", "surface-3", "tooltip", "track", "hairline",
    "ink", "ink-2", "muted", "faint",
    "wc", "wc-mid", "wc-soft", "ai", "ai-mid", "ai-light", "ai-soft",
    "b", "b-mid", "forecast", "sev-0", "sev-1", "sev-2", "sev-3", "sev-4",
    "cl-1", "cl-2", "cl-3", "cl-4", "cl-5", "cl-6",
  ];
  names.forEach((n) => {
    const key = n.replace(/-(\w)/g, (_, c) => c.toUpperCase());
    T[key] = cssVar(`--${n}`);
  });
  T.mode = document.documentElement.dataset.mode || "light";
  Object.assign(C, {
    a: T.wc,
    aMid: T.wcMid,
    b: T.b,
    bMid: T.bMid,
    ai: T.ai,
    aiMid: T.aiMid,
    aiLight: T.aiLight,
  });
  Object.assign(SEV_COLOR, {
    P0: T.sev0,
    P1: T.sev1,
    P2: T.sev2,
    P3: T.sev3,
    未分级: T.sev4,
  });
  Object.assign(tip, {
    backgroundColor: T.tooltip,
    borderColor: "transparent",
    borderWidth: 0,
    padding: 0,
    textStyle: { color: T.ink, fontSize: 11, fontFamily: FONT },
    extraCssText: `border-radius:8px;box-shadow:0 4px 14px ${
      T.mode === "dark" ? "rgba(0,0,0,.22)" : "rgba(15,23,42,.1)"
    };`,
    className: "chart-tooltip",
    appendToBody: true,
    confine: false,
  });
  return T;
}

export const clusterPalette = () => [T.cl1, T.cl2, T.cl3, T.cl4, T.cl5, T.cl6];

export const tipCard = (html) => `<div class="tip-card">${html}</div>`;
export const tipHead = (title, meta, color) =>
  `<div class="tip-head"><i style="background:${color || T.muted}"></i><span>${title}</span>` +
  `${meta ? `<em>${meta}</em>` : ""}</div>`;
export const tipSep = () => `<div class="tip-sep"></div>`;
export const tipRow = (color, label, value) =>
  `<div class="tip-row"><i style="background:${color}"></i><span>${label}</span><b>${value}</b></div>`;

/* ------------------------------------------------------------------ charts */

const chartInstances = new Set();
const chartByEl = new WeakMap();
let resizeRaf = 0;
const resizeQueue = new Set();

function scheduleResize(c, el) {
  if (!el.clientWidth || !el.clientHeight) return;
  resizeQueue.add(c);
  if (resizeRaf) return;
  resizeRaf = requestAnimationFrame(() => {
    resizeRaf = 0;
    resizeQueue.forEach((x) => {
      try {
        x.resize();
      } catch (e) {}
    });
    resizeQueue.clear();
  });
}

export function createChart(elOrId, option) {
  const el = typeof elOrId === "string" ? $(elOrId) : elOrId;
  if (!el || typeof echarts === "undefined") return null;
  const old = chartByEl.get(el) || echarts.getInstanceByDom(el);
  if (old) {
    try {
      old.dispose();
    } catch (e) {}
    chartInstances.delete(old);
  }
  el.innerHTML = "";
  const c = echarts.init(el, null, { renderer: "canvas" });
  c.setOption(option);
  chartInstances.add(c);
  chartByEl.set(el, c);
  if (window.ResizeObserver) {
    const ro = new ResizeObserver(() => scheduleResize(c, el));
    c.__ro = ro;
    ro.observe(el);
  }
  return c;
}

export function disposeAllCharts() {
  chartInstances.forEach((c) => {
    if (c.__ro) c.__ro.disconnect();
    try {
      c.dispose();
    } catch (e) {}
    chartInstances.delete(c);
  });
  resizeQueue.clear();
}

export function resizeAllCharts() {
  requestAnimationFrame(() => {
    chartInstances.forEach((c) => {
      try {
        c.dispatchAction({ type: "hideTip" });
        c.resize();
      } catch (e) {}
    });
  });
}

export function chartCount() {
  return chartInstances.size;
}

/* ---------------------------------------------------------------- counters */

function lockNum(el, value, decimals) {
  if (!el) return;
  const s = fmtFixed(Number(value) || 0, decimals || 0);
  // Reserve the final formatted value, including its suffix, before animating.
  // Keep the largest reservation during refreshes that cross a digit boundary.
  const width = s.length + (el.dataset.suffix || "").length;
  el._numWidth = Math.max(el._numWidth || 0, width, 2);
  el.style.minWidth = `${el._numWidth}ch`;
}

export function setNum(id, value, opts) {
  const el = typeof id === "string" ? $(id) : id;
  if (!el) return;
  el.dataset.count = String(value == null ? 0 : value);
  if (opts && opts.decimals != null) el.dataset.decimals = String(opts.decimals);
  if (opts && opts.suffix) el.dataset.suffix = opts.suffix;
  lockNum(el, value, (opts && opts.decimals) || 0);
}

export function settleCounters(root = document) {
  root.querySelectorAll("[data-count]").forEach((el) => {
    const end = Number(el.dataset.count);
    if (!Number.isFinite(end)) return;
    const decimals = Number(el.dataset.decimals || 0);
    el._numToken = (el._numToken || 0) + 1;
    el.textContent = fmtFixed(end, decimals) + (el.dataset.suffix || "");
  });
}

export function tweenNumber(el, end, decimals, suffix, duration) {
  const d = decimals || 0;
  const token = (el._numToken = (el._numToken || 0) + 1);
  const started = performance.now();
  const ms = Math.max(1, duration);
  const step = (now) => {
    if (el._numToken !== token) return;
    const p = Math.min(1, (now - started) / ms);
    const eased = 1 - Math.pow(1 - p, 3);
    if (p >= 1) {
      el.textContent = fmtFixed(end, d) + suffix;
      return;
    }
    el.textContent = fmtFixed(end * eased, d) + suffix;
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

export function startCounters(duration, root = document) {
  root.querySelectorAll("[data-count]").forEach((el) => {
    const end = Number(el.dataset.count);
    if (!Number.isFinite(end)) return;
    const decimals = Number(el.dataset.decimals || 0);
    const suffix = el.dataset.suffix || "";
    lockNum(el, end, decimals);
    if (REDUCED) {
      el.textContent = fmtFixed(end, decimals) + suffix;
      return;
    }
    tweenNumber(el, end, decimals, suffix, (duration || 0.8) * 1000);
  });
}

export function bump(el) {
  if (!el || REDUCED) return;
  el.classList.remove("is-bump");
  void el.offsetWidth;
  el.classList.add("is-bump");
  window.setTimeout(() => el.classList.remove("is-bump"), 380);
}

export function animateTo(id, value, decimals) {
  const el = typeof id === "string" ? $(id) : id;
  if (!el) return;
  const d = decimals || 0;
  el.dataset.count = String(value == null ? 0 : value);
  lockNum(el, value, d);
  bump(el);
  if (REDUCED) {
    el.textContent = fmtFixed(value || 0, d);
    return;
  }
  tweenNumber(el, value || 0, d, "", 450);
}
