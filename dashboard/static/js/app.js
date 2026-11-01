/* Shell: three views, product switch, query routing, theme and on-demand data loading. */
import { $, $$, readTokens, disposeAllCharts, resizeAllCharts, settleCounters, startCounters } from "./core.js";

const VIEWS = new Set(["data", "system", "samples"]);
const PRODUCTS = new Set(["wencai", "aime"]);
const VIEW_CSS = { data: "board.css", system: "system.css", samples: "samples.css" };
const VIEW_LABELS = { data: "数据看板", system: "评测体系", samples: "样本" };
const VIEW_TITLES = { data: "数据", system: "评测体系", samples: "样本" };

let DATA = null;
let SAMPLES = null;
let dataPromise = null;
let samplesPromise = null;

let boardModule = null;
let systemModule = null;
let samplesModule = null;
let boardPromise = null;
let systemPromise = null;
let samplesModulePromise = null;
let echartsPromise = null;

let boardInited = false;
let systemInited = false;
let samplesInited = false;
let revealed = false;
let routeToken = 0;

let activeView = "data";
let activeProduct = "wencai";

/* ------------------------------------------------------------------ helpers */

function parseRoute() {
  const params = new URLSearchParams(location.search);
  const view = params.get("view") || "data";
  return { view: VIEWS.has(view) ? view : "data", params };
}

function routeFor(view, params) {
  const q = new URLSearchParams();
  q.set("view", view);
  Object.entries(params || {}).forEach(([k, v]) => {
    // Carried-over query parameters must not override the requested page.
    if (k !== "view" && v != null && v !== "") q.set(k, v);
  });
  return `?${q.toString()}`;
}

function setRoute(view, params, replace) {
  const next = routeFor(view, params);
  if (location.search === next) return;
  history[replace ? "replaceState" : "pushState"](null, "", next);
}

function announce(message) {
  const el = $("viewAnnouncer");
  if (el) el.textContent = message;
}

function setDocumentTitle() {
  document.title = `${VIEW_TITLES[activeView]} · 评测数据看板`;
}

function setViewBusy(view, busy) {
  const el = document.querySelector(`.view[data-view="${view}"]`);
  if (el) el.setAttribute("aria-busy", busy ? "true" : "false");
}

function viewRoot(view) {
  return view === "system" ? $("systemRoot") : view === "samples" ? $("samplesRoot") : null;
}

function errorText(err) {
  const raw = String((err && err.message) || err || "未知错误");
  if (/Failed to fetch|dynamically imported module|NetworkError|Load failed/i.test(raw)) {
    return "资源加载失败。";
  }
  if (/\b(?:samples|data)\.json \d{3}\b/.test(raw)) {
    return "数据文件暂不可用。";
  }
  return raw;
}

function showViewPending(view) {
  const root = viewRoot(view);
  if (!root) return;
  if (root.childElementCount && !root.querySelector(".view-state--error")) return;
  root.innerHTML =
    `<div class="view-state" role="status"><span class="spinner" aria-hidden="true"></span>` +
    `<p>正在加载${VIEW_LABELS[view]}…</p></div>`;
}

function showViewError(view, err) {
  setViewBusy(view, false);
  const root = viewRoot(view);
  if (!root) {
    showAppError(err);
    return;
  }
  root.innerHTML =
    `<div class="view-state view-state--error" role="alert">` +
    `<span class="view-state__mark" aria-hidden="true">!</span>` +
    `<h2></h2><p></p><button class="view-state__retry" type="button">重试</button></div>`;
  root.querySelector("h2").textContent = `${VIEW_LABELS[view]}加载失败`;
  root.querySelector("p").textContent = errorText(err);
  root.querySelector(".view-state__retry").addEventListener("click", () => applyRoute(parseRoute()));
  announce(`${VIEW_LABELS[view]}加载失败`);
}

function clearAppError() {
  const el = $("appError");
  if (el) el.remove();
}

function showAppError(err) {
  clearAppError();
  const el = document.createElement("div");
  el.id = "appError";
  el.className = "app-error";
  el.setAttribute("role", "alert");
  const text = document.createElement("span");
  text.className = "app-error__text";
  text.textContent = `数据加载失败：${errorText(err)}`;
  const retry = document.createElement("button");
  retry.type = "button";
  retry.textContent = "重试";
  retry.addEventListener("click", () => {
    clearAppError();
    applyRoute(parseRoute());
  });
  el.append(text, retry);
  document.body.appendChild(el);
  announce("数据加载失败");
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
  if (boardModule) boardModule.setBoardProduct(product);
  // The samples module owns its own URL/query sync. Only update it while the
  // samples view is active, otherwise changing products on Data can rewrite
  // the route back to Samples.
  if (samplesModule && activeView === "samples") samplesModule.setSamplesProduct(product);
}

/* ------------------------------------------------------------ lazy loading */

const cssLoaded = new Set();

function ensureCss(href) {
  if (cssLoaded.has(href)) return Promise.resolve();
  const existing = document.querySelector(`link[data-view-css="${href}"]`);
  if (existing) {
    if (existing.sheet) {
      cssLoaded.add(href);
      return Promise.resolve();
    }
    return new Promise((resolve) => existing.addEventListener("load", resolve, { once: true }));
  }
  return new Promise((resolve, reject) => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    link.dataset.viewCss = href;
    link.addEventListener("load", () => {
      cssLoaded.add(href);
      resolve();
    }, { once: true });
    link.addEventListener("error", () => reject(new Error(`${href} 加载失败`)), { once: true });
    // Keep the cascade order: app → shell → view → taste. View CSS is fetched on
    // demand but must stay before taste.css, which carries the shared overrides.
    const taste = document.querySelector('link[href="taste.css"]');
    document.head.insertBefore(link, taste || null);
  });
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.addEventListener("load", resolve, { once: true });
    script.addEventListener("error", () => reject(new Error(`${src} 加载失败`)), { once: true });
    document.head.appendChild(script);
  });
}

function ensureECharts() {
  if (window.echarts) return Promise.resolve();
  if (!echartsPromise) echartsPromise = loadScript("echarts.min.js");
  return echartsPromise;
}

function loadBoardModule() {
  if (boardModule) return Promise.resolve(boardModule);
  if (!boardPromise) {
    boardPromise = (async () => {
      await ensureECharts();
      boardModule = await import("./board.js");
      return boardModule;
    })().catch((err) => {
      boardPromise = null;
      throw err;
    });
  }
  return boardPromise;
}

function loadSystemModule() {
  if (systemModule) return Promise.resolve(systemModule);
  if (!systemPromise) {
    systemPromise = import("./system.js")
      .then((mod) => {
        systemModule = mod;
        return mod;
      })
      .catch((err) => {
        systemPromise = null;
        throw err;
      });
  }
  return systemPromise;
}

function loadSamplesModule() {
  if (samplesModule) return Promise.resolve(samplesModule);
  if (!samplesModulePromise) {
    samplesModulePromise = import("./samples.js")
      .then((mod) => {
        samplesModule = mod;
        return mod;
      })
      .catch((err) => {
        samplesModulePromise = null;
        throw err;
      });
  }
  return samplesModulePromise;
}

function ensureData() {
  if (DATA) {
    setFreshness(DATA);
    return Promise.resolve(DATA);
  }
  if (dataPromise) return dataPromise;
  dataPromise = fetch("data.json", { cache: "no-cache" })
    .then((response) => {
      if (!response.ok) throw new Error(`data.json ${response.status}`);
      return response.json();
    })
    .then((data) => {
      DATA = data;
      setFreshness(data);
      return data;
    })
    .catch((err) => {
      dataPromise = null;
      throw err;
    });
  return dataPromise;
}

async function prepareBoard() {
  await ensureCss(VIEW_CSS.data);
  const mod = await loadBoardModule();
  await ensureData();
  return mod;
}

async function prepareSystem() {
  await ensureCss(VIEW_CSS.system);
  return loadSystemModule();
}

function ensureSamples(initial) {
  if (SAMPLES) {
    setSamplesFreshness(SAMPLES);
    return Promise.resolve(SAMPLES);
  }
  if (samplesPromise) return samplesPromise;
  samplesPromise = (async () => {
    await ensureCss(VIEW_CSS.samples);
    const mod = await loadSamplesModule();
    try {
      const response = await fetch("samples.json", { cache: "no-cache" });
      if (!response.ok) throw new Error(`samples.json ${response.status}`);
      const data = await response.json();
      SAMPLES = data;
      if (!samplesInited) {
        mod.initSamples($("samplesRoot"), data, { onNavigate: navigate, product: activeProduct, initial });
        samplesInited = true;
      }
      setSamplesFreshness(data);
      return data;
    } catch (err) {
      console.warn("[samples]", err);
      if (!samplesInited) {
        mod.initSamples($("samplesRoot"), null, { onNavigate: navigate, error: err });
      }
      samplesPromise = null;
      throw err;
    }
  })();
  return samplesPromise;
}

/* --------------------------------------------------------------------- nav */

function navigate(view, params = {}, { replace = false } = {}) {
  if (!VIEWS.has(view)) return;
  const next = { ...params };
  if (view === "data" && next.product == null) next.product = activeProduct;
  setRoute(view, next, replace);
  applyRoute(parseRoute());
}

function setViewChrome() {
  document.body.dataset.view = activeView;
  setDocumentTitle();
  const productSwitch = $("productSwitch");
  if (productSwitch) {
    const visible = activeView !== "system";
    productSwitch.hidden = !visible;
    productSwitch.setAttribute("aria-hidden", String(!visible));
  }
  $$(".view").forEach((view) => {
    const on = view.dataset.view === activeView;
    view.classList.toggle("is-active", on);
    view.setAttribute("aria-hidden", String(!on));
    if (!on) view.setAttribute("aria-busy", "false");
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
}

function sampleQueryFrom(route) {
  const turn = route.params.get("turn");
  return {
    product: route.params.get("product") || activeProduct,
    cluster: route.params.get("cluster") || "",
    component: route.params.get("component") || "",
    severity: route.params.get("severity") || "",
    model: route.params.get("model") || "",
    date: route.params.get("date") || "",
    case: route.params.get("case") || "",
    q: route.params.get("q") || "",
    sort: route.params.get("sort") || "severity",
    tab: route.params.get("tab") || "attr",
    turn: turn == null || turn === "" ? null : Number(turn),
  };
}

async function applyRoute(route) {
  const token = ++routeToken;
  activeView = route.view;
  setViewChrome();
  clearAppError();

  const product = route.params.get("product");
  if (product && PRODUCTS.has(product) && product !== activeProduct) setProduct(product, false);

  if (activeView !== "system" && systemModule) systemModule.setSystemActive(false);
  if (activeView !== "samples" && samplesModule) samplesModule.setSamplesActive(false);

  if (activeView === "system") {
    setViewBusy("system", true);
    if (!systemInited) showViewPending("system");
    try {
      const mod = await prepareSystem();
      if (token !== routeToken) return;
      if (!systemInited) {
        mod.initSystem($("systemRoot"));
        systemInited = true;
      }
      mod.setSystemActive(true);
      reveal();
      setViewBusy("system", false);
      announce(`已切换到${VIEW_LABELS.system}`);
    } catch (err) {
      if (token === routeToken) fail(err);
    }
    return;
  }

  if (activeView === "samples") {
    const initial = {
      ...sampleQueryFrom(route),
      product: activeProduct,
    };
    setViewBusy("samples", true);
    if (!samplesInited) showViewPending("samples");
    let loadError = null;
    try {
      await ensureSamples(initial);
    } catch (err) {
      /* the samples module owns the empty/error surface */
      loadError = err;
    }
    if (token !== routeToken) return;
    if (!samplesModule) {
      if (loadError) fail(loadError);
      else setViewBusy("samples", false);
      return;
    }
    if (loadError) {
      fail(loadError);
      return;
    }
    const explicit = PRODUCTS.has(route.params.get("product") || "");
    const effective = explicit ? activeProduct : samplesModule.samplesProductFor(activeProduct);
    if (effective !== activeProduct) {
      setProduct(effective, false);
      const params = Object.fromEntries(new URLSearchParams(location.search));
      params.product = effective;
      setRoute("samples", params, true);
    }
    samplesModule.setSamplesActive(true);
    samplesModule.openSampleQuery(sampleQueryFrom(route));
    reveal();
    setViewBusy("samples", false);
    announce(loadError ? `${VIEW_LABELS.samples}加载失败` : `已切换到${VIEW_LABELS.samples}`);
    return;
  }

  setViewBusy("data", true);
  try {
    const mod = await prepareBoard();
    if (token !== routeToken || activeView !== "data") return;
    if (!boardInited) {
      mod.initBoard(DATA, {
        product: activeProduct,
      });
      boardInited = true;
    }
    mod.setBoardProduct(activeProduct);
    requestAnimationFrame(() => mod.resizeBoard());
    window.setTimeout(() => mod.resizeBoard(), 280);
    reveal();
    setViewBusy("data", false);
    announce(`已切换到${VIEW_LABELS.data}`);
  } catch (err) {
    if (token === routeToken) fail(err);
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
      if (!tab || activeView === "system") return;
      setProduct(tab.dataset.tab);
      const route = parseRoute();
      const params = activeView === "samples"
        ? { product: tab.dataset.tab }
        : { ...Object.fromEntries(route.params), product: tab.dataset.tab };
      navigate(activeView, params, { replace: true });
    });
    productSwitch.addEventListener("keydown", (ev) => {
      if (ev.key !== "ArrowLeft" && ev.key !== "ArrowRight") return;
      if (activeView === "system") return;
      ev.preventDefault();
      const next = activeProduct === "wencai" ? "aime" : "wencai";
      setProduct(next);
      const route = parseRoute();
      const params = activeView === "samples"
        ? { product: next }
        : { ...Object.fromEntries(route.params), product: next };
      navigate(activeView, params, { replace: true });
      const tab = productSwitch.querySelector(`.product-tab[data-tab="${next}"]`);
      if (tab) tab.focus();
    });
  }

  window.addEventListener("eval:switch-product", (ev) => {
    const product = ev.detail && ev.detail.product;
    if (activeView !== "samples" || !PRODUCTS.has(product)) return;
    setProduct(product);
    navigate(activeView, { product }, { replace: true });
  });
}

/* ------------------------------------------------------------------- theme */

function updateThemeButton() {
  const btn = $("themeToggle");
  if (!btn) return;
  const dark = document.documentElement.dataset.mode === "dark";
  const label = dark ? "切换浅色模式" : "切换深色模式";
  btn.setAttribute("aria-label", label);
}

function applyMode(mode, persist) {
  document.documentElement.dataset.mode = mode;
  if (persist) {
    try {
      localStorage.setItem("eval-mode", mode);
    } catch (e) {}
  }
  updateThemeButton();
  if (!DATA && !boardModule && !samplesModule && !systemModule) return;
  readTokens();
  if (boardModule) {
    disposeAllCharts();
    boardModule.refreshBoard();
    boardModule.resizeBoard();
  }
  if (samplesModule) samplesModule.refreshSamples();
  if (systemModule) systemModule.refreshSystem();
  settleCounters();
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

/* ------------------------------------------------------------------ status */

function setFreshness(data) {
  const el = $("freshnessChip");
  if (!el || !data) return;
  const f = data.freshness || {};
  const input = f.input || {};
  const a = f.attribution || {};
  const c = f.cluster || {};
  const stamp = (x) => x.date || x.at ? String(x.date || x.at).slice(5, 10) : "—";
  const waiting = !input.at && !a.at && !c.at;
  const stale = !waiting && Boolean(input.stale || a.stale || c.stale);
  const outputMissing = !a.date && !a.at;
  const statusLabel = waiting ? "数据待接入" : outputMissing ? "输出待落盘" : stale ? "待刷新" : "已同步";
  el.classList.toggle("is-stale", stale);
  el.dataset.state = outputMissing ? "pending" : stale ? "stale" : "ok";
  if (waiting) {
    el.title = "数据状态：数据待接入";
    el.setAttribute("aria-label", el.title);
    return;
  }
  el.title = [
    `数据状态：${statusLabel}`,
    `输入：${input.label || input.at || "未知"}${input.stale ? "（仍在更新）" : ""}`,
    `归因：${a.label || a.at || "未知"}${a.stale ? "（非最新批次）" : ""}`,
    `聚类：${c.label || c.at || "未知"}${c.stale ? "（非最新批次）" : ""}`,
    `更新：${(data.generated_at || "—").slice(5, 16).replace("T", " ")}`,
  ].join("\n");
  el.setAttribute("aria-label", `数据状态：${statusLabel}。输入 ${stamp(input)}，归因 ${stamp(a)}，聚类 ${stamp(c)}`);
}

function setSamplesFreshness(samples) {
  const el = $("freshnessChip");
  if (!el || !samples) return;
  const at = String(samples.generated_at || "").slice(0, 16).replace("T", " ");
  const waiting = !Object.values(samples.products || {}).some((product) => product.total > 0);
  el.classList.remove("is-stale");
  el.dataset.state = waiting ? "pending" : "ok";
  el.title = waiting ? "样本数据待接入" : `样本索引：${at || "已加载"}`;
  el.setAttribute("aria-label", waiting ? "样本数据待接入" : `样本索引已加载${at ? `，生成于 ${at}` : ""}`);
}

/* -------------------------------------------------------------------- boot */

function reveal() {
  window.__viewReady = Math.round(performance.now());
  if (revealed) return;
  revealed = true;
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
  console.error(err);
  setViewBusy(activeView, false);
  const mask = $("mask");
  if (!mask) {
    showViewError(activeView, err);
    return;
  }
  mask.innerHTML =
    `<div class="mask-inner mask-error"><span>看板加载失败：${String(err.message || err)}</span>` +
    `<button onclick="location.reload()">重试</button></div>`;
}

function boot() {
  try {
    const saved = localStorage.getItem("eval-product");
    if (PRODUCTS.has(saved)) activeProduct = saved;
  } catch (e) {}
  readTokens();
  initTheme();
  initNav();

  window.addEventListener("popstate", () => applyRoute(parseRoute()));
  window.addEventListener("resize", () => {
    if (boardModule) resizeAllCharts();
  });
  applyRoute(parseRoute());
}

boot();
