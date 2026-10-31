/* Shell: three views, product switch, hash routing, theme and data loading. */
import { $, $$, readTokens, disposeAllCharts, resizeAllCharts, settleCounters, startCounters } from "./core.js";
import { initBoard, setBoardProduct, refreshBoard, resizeBoard, getBoardProduct } from "./board.js";
import { initSystem, setSystemActive, refreshSystem } from "./system.js";
import {
  initSamples,
  openSampleQuery,
  setSamplesProduct,
  refreshSamples,
  setSamplesActive,
} from "./samples.js";

const VIEWS = new Set(["data", "system", "samples"]);
const PRODUCTS = new Set(["wencai", "aime"]);
let DATA = null;
let SAMPLES = null;
let samplesPromise = null;
let activeView = "data";
let activeProduct = "wencai";

/* ------------------------------------------------------------------ helpers */

function parseHash() {
  const raw = (location.hash || "#/data").replace(/^#\/?/, "");
  const [name, query = ""] = raw.split("?");
  const params = new URLSearchParams(query);
  return { view: VIEWS.has(name) ? name : "data", params };
}

function hashFor(view, params) {
  const q = new URLSearchParams();
  Object.entries(params || {}).forEach(([k, v]) => {
    if (v != null && v !== "") q.set(k, v);
  });
  const body = q.toString();
  return `#/${view}${body ? `?${body}` : ""}`;
}

function setHash(view, params, replace) {
  const next = hashFor(view, params);
  if (location.hash === next) return;
  if (replace) history.replaceState(null, "", next);
  else location.hash = next;
}

function setProduct(product, persist = true) {
  if (!PRODUCTS.has(product)) return;
  activeProduct = product;
  const sw = $("productSwitch");
  if (sw) {
    sw.dataset.active = product;
    sw.querySelectorAll(".product-tab").forEach((tab) => {
      const on = tab.dataset.tab === product;
      tab.classList.toggle("is-active", on);
      tab.setAttribute("aria-selected", String(on));
      tab.tabIndex = on ? 0 : -1;
    });
  }
  if (persist) {
    try {
      localStorage.setItem("eval-product", product);
    } catch (e) {}
  }
  setBoardProduct(product);
  setSamplesProduct(product);
  resizeBoard();
}

/* --------------------------------------------------------------------- nav */

function navigate(view, params = {}, { replace = false } = {}) {
  if (!VIEWS.has(view)) return;
  const next = { ...params };
  if ((view === "data" || view === "samples") && next.product == null) next.product = activeProduct;
  setHash(view, next, replace);
  applyRoute(parseHash());
}

function applyRoute(route) {
  activeView = route.view;
  document.body.dataset.view = activeView;

  $$(".view").forEach((v) => {
    const on = v.dataset.view === activeView;
    v.classList.toggle("is-active", on);
    v.setAttribute("aria-hidden", String(!on));
  });

  const sw = $("viewSwitch");
  if (sw) {
    sw.dataset.active = activeView;
    sw.querySelectorAll(".view-tab").forEach((tab) => {
      const on = tab.dataset.view === activeView;
      tab.classList.toggle("is-active", on);
      if (on) tab.setAttribute("aria-current", "page");
      else tab.removeAttribute("aria-current");
    });
  }

  const product = route.params.get("product");
  if (product && PRODUCTS.has(product) && product !== activeProduct) setProduct(product, false);

  if (activeView === "system") {
    setSystemActive(true);
  } else {
    setSystemActive(false);
  }

  if (activeView === "samples") {
    setSamplesActive(true);
    ensureSamples()
      .then(() => {
        openSampleQuery({
          product: activeProduct,
          component: route.params.get("component") || "",
          severity: route.params.get("severity") || "",
          cluster: route.params.get("cluster") || "",
          label: route.params.get("label") || "",
          case: route.params.get("case") || "",
          q: route.params.get("q") || "",
        });
      })
      .catch(() => {
        /* the samples module owns the empty/error surface */
      });
  } else {
    setSamplesActive(false);
  }

  if (activeView === "data") {
    requestAnimationFrame(() => {
      resizeBoard();
      resizeAllCharts();
    });
    window.setTimeout(() => {
      resizeBoard();
      resizeAllCharts();
    }, 280);
  }
}

function initNav() {
  const sw = $("viewSwitch");
  if (sw) {
    sw.addEventListener("click", (ev) => {
      const tab = ev.target.closest(".view-tab");
      if (tab) navigate(tab.dataset.view);
    });
    sw.addEventListener("keydown", (ev) => {
      if (ev.key !== "ArrowLeft" && ev.key !== "ArrowRight") return;
      ev.preventDefault();
      const order = ["data", "system", "samples"];
      const i = order.indexOf(activeView);
      const next = order[(i + (ev.key === "ArrowRight" ? 1 : order.length - 1)) % order.length];
      navigate(next);
      const tab = sw.querySelector(`.view-tab[data-view="${next}"]`);
      if (tab) tab.focus();
    });
  }

  const productSwitch = $("productSwitch");
  if (productSwitch) {
    productSwitch.addEventListener("click", (ev) => {
      const tab = ev.target.closest(".product-tab");
      if (!tab) return;
      setProduct(tab.dataset.tab);
      const route = parseHash();
      const params = activeView === "samples"
        ? { product: tab.dataset.tab }
        : { ...Object.fromEntries(route.params), product: tab.dataset.tab };
      navigate(activeView, params, { replace: true });
    });
    productSwitch.addEventListener("keydown", (ev) => {
      if (ev.key !== "ArrowLeft" && ev.key !== "ArrowRight") return;
      ev.preventDefault();
      const next = activeProduct === "wencai" ? "aime" : "wencai";
      setProduct(next);
      const tab = productSwitch.querySelector(`.product-tab[data-tab="${next}"]`);
      if (tab) tab.focus();
    });
  }
}

/* ------------------------------------------------------------------- theme */

function updateThemeButton() {
  const btn = $("themeToggle");
  if (!btn) return;
  const dark = document.documentElement.dataset.mode === "dark";
  const label = dark ? "切换浅色模式" : "切换深色模式";
  btn.setAttribute("aria-label", label);
  btn.title = label;
}

function applyMode(mode, persist) {
  document.documentElement.dataset.mode = mode;
  if (persist) {
    try {
      localStorage.setItem("eval-mode", mode);
    } catch (e) {}
  }
  updateThemeButton();
  if (!DATA) return;
  readTokens();
  disposeAllCharts();
  refreshBoard();
  refreshSamples();
  refreshSystem();
  settleCounters();
  resizeBoard();
  resizeAllCharts();
}

function initTheme() {
  updateThemeButton();
  const btn = $("themeToggle");
  if (btn) {
    btn.addEventListener("click", () => {
      applyMode(document.documentElement.dataset.mode === "dark" ? "light" : "dark", true);
    });
  }
  if (window.matchMedia) {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (ev) => {
      let saved = null;
      try {
        saved = localStorage.getItem("eval-mode");
      } catch (e) {}
      if (!saved) applyMode(ev.matches ? "dark" : "light", false);
    };
    if (mq.addEventListener) mq.addEventListener("change", onChange);
  }
}

/* ------------------------------------------------------------------ samples */

function ensureSamples() {
  if (SAMPLES) return Promise.resolve(SAMPLES);
  if (samplesPromise) return samplesPromise;
  samplesPromise = fetch("samples.json?t=" + Date.now(), { cache: "no-store" })
    .then((r) => {
      if (!r.ok) throw new Error(`samples.json ${r.status}`);
      return r.json();
    })
    .then((data) => {
      SAMPLES = data;
      initSamples($("samplesRoot"), data, { onNavigate: navigate });
      return data;
    })
    .catch((err) => {
      console.warn("[samples]", err);
      initSamples($("samplesRoot"), null, { onNavigate: navigate, error: err });
      throw err;
    });
  return samplesPromise;
}

function onRecall(ev) {
  const d = ev.detail || {};
  const product = PRODUCTS.has(d.product) ? d.product : activeProduct;
  navigate("samples", {
    product,
    component: d.component || "",
    severity: d.severity || "",
    cluster: d.cluster || "",
    label: d.label || "",
    case: d.case || "",
  });
}

/* -------------------------------------------------------------------- boot */

function setFreshness(data) {
  const el = $("freshnessChip");
  if (!el) return;
  const f = data.freshness || {};
  const a = f.attribution || {};
  const c = f.cluster || {};
  const stamp = (x) => String(x.date || x.at || "—").slice(5, 10);
  const stale = Boolean(a.stale || c.stale);
  el.classList.toggle("is-stale", stale);
  el.textContent = `归因 ${stamp(a)} · 聚类 ${stamp(c)}${stale ? " · 待刷新" : ""}`;
  el.title = [
    `归因：${a.label || a.at || "未知"}${a.stale ? "（非最新批次）" : ""}`,
    `聚类：${c.label || c.at || "未知"}${c.stale ? "（非最新批次）" : ""}`,
  ].join("\n");
}

function renderAll() {
  initBoard(DATA, {
    onRecall: (detail) => onRecall({ detail }),
    navigate,
  });
  initSystem($("systemRoot"), {
    data: DATA,
    onRecall: (detail) => onRecall({ detail }),
    navigate,
  });
  setFreshness(DATA);
  $("updated").textContent = (DATA.generated_at || "—").slice(5, 16).replace("T", " ");
  setProduct(activeProduct, false);
  applyRoute(parseHash());
}

function reveal() {
  const mask = $("mask");
  if (mask) {
    mask.classList.add("is-hidden");
    setTimeout(() => mask.remove(), 400);
  }
  const board = document.querySelector(".board");
  if (board) board.classList.add("is-ready");
  setTimeout(() => startCounters(0.8), 120);
  setTimeout(() => {
    window.__boardReady = true;
  }, 700);
}

function fail(err) {
  const mask = $("mask");
  if (!mask) return;
  mask.innerHTML =
    `<div class="mask-inner mask-error"><span>数据加载失败：${String(err.message || err)}</span>` +
    `<button onclick="location.reload()">重试</button></div>`;
  console.error(err);
}

function boot() {
  try {
    const saved = localStorage.getItem("eval-product");
    if (PRODUCTS.has(saved)) activeProduct = saved;
  } catch (e) {}
  readTokens();
  initTheme();
  initNav();

  window.addEventListener("hashchange", () => applyRoute(parseHash()));
  window.addEventListener("resize", resizeAllCharts);
  window.addEventListener("eval:recall", onRecall);

  fetch("data.json?t=" + Date.now(), { cache: "no-store" })
    .then((r) => {
      if (!r.ok) throw new Error("data.json " + r.status);
      return r.json();
    })
    .then((d) => {
      DATA = d;
      readTokens();
      renderAll();
      requestAnimationFrame(reveal);
    })
    .catch(fail);
}

boot();
