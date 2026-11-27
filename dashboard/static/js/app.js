/* Router and shell: ?view=data|system|samples&product=wencai|aime (+ sample params). */
import { $, $$, esc, segmented, getJSON, announce, installTips, importRetry, onNetwork, REDUCED } from "./core.js";
import { glassTabMenu } from "./glass_tab_menu.js";
import { pixelToggle } from "./pixel_toggle.js";

const VIEWS = ["data", "speed", "system", "judge", "bench", "samples", "forecast", "compare", "docs"];
const PRODUCTS = ["wencai", "aime"];
const VIEW_NAME = { data: "数据看板", speed: "评测速度", system: "评测体系", judge: "评测评测", bench: "Bench", samples: "具体数据", forecast: "预测数据", compare: "版本对比", docs: "文档" };
// Sample params (case / trace / filters) and compare params (pair / round / online) never leak
// across views, or a stale deep link would reopen the previous drill on the next page.
const SAMPLE_PARAMS = {
  detail: null, ed: null, em: null, ep: null, edp: null, p: null, q: null, w: null, split: null,
  model: null, ut: null, hr: null, scene: null, sub: null, stage: null, mech: null, pattern: null, date: null, case: null, trace: null,
  res: null, cls: null, typ: null, cause: null,
};
const COMPARE_PARAMS = { pair: null, round: null, face: null };
const BENCH_PARAMS = { bm: null, bl: null, bt: null, bd: null, bv: null };
// Views that read data-<product>.json (17 MB for AIME). The others only need the data.json shell,
// so they neither wait for it nor spend the bandwidth their own payloads need.
const NEEDS_PRODUCT = new Set(["data", "forecast", "compare"]);
// Each product's board runs on its own server; a product with no data here opens its server instead.
// The map comes from the server's config/sites.json, inlined into index.html.
const SITES = (() => {
  try {
    return JSON.parse(document.getElementById("sites")?.textContent || "{}");
  } catch (err) {
    return {};
  }
})();
// Enabled products on this host, inlined by server.py so boot() can start data-<product>.json
// and trends_summary-<product>.json in parallel with data.json instead of waiting sequentially.
const BOOT = (() => {
  try {
    return JSON.parse(document.getElementById("boot")?.textContent || "{}");
  } catch (err) {
    return {};
  }
})();
// Non-first-screen view stylesheets load on demand so HTTP/1.1 does not queue 7 unrelated CSS files
// ahead of the active view's data payloads.
const VIEW_CSS = {
  speed: ["speed.css"],
  system: ["system.css"],
  judge: ["judge.css"],
  bench: ["samples.css", "bench.css"],
  samples: ["samples.css"],
  forecast: ["samples.css"],
  compare: ["samples.css", "compare.css"],
  docs: ["docs.css"],
};
const CSS_PREFIX = (() => {
  const link = document.querySelector('link[rel="stylesheet"][href*="css/base.css"]');
  const href = link ? link.getAttribute("href") || "" : "";
  return href.replace(/base\.css(?:\?.*)?$/, "") || "css/";
})();
const loadedCSS = new Map();
function ensureCSS(file) {
  if (loadedCSS.has(file)) return loadedCSS.get(file);
  const href = `${CSS_PREFIX}${file}`;
  if (document.querySelector(`link[rel="stylesheet"][href$="/${file}"], link[rel="stylesheet"][href="css/${file}"]`)) {
    const done = Promise.resolve();
    loadedCSS.set(file, done);
    return done;
  }
  const p = new Promise((resolve) => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    link.onload = () => resolve();
    link.onerror = () => resolve();
    document.head.appendChild(link);
  });
  loadedCSS.set(file, p);
  return p;
}
function ensureViewCSS(view) {
  const files = VIEW_CSS[view];
  return files ? Promise.all(files.map(ensureCSS)) : Promise.resolve();
}
const state = { view: "data", product: "wencai", data: null, indexes: {}, indexP: {}, productData: {}, productP: {}, trendSummaryP: {} };
const modules = {};
// Each view module loads on first visit; a refused connection retries instead of breaking the view.
const loaders = Object.fromEntries([
  ["data", () => import("./data.js")], ["speed", () => import("./speed.js")], ["system", () => import("./system.js")], ["judge", () => import("./judge.js")],
  ["bench", () => import("./bench.js")], ["samples", () => import("./samples.js")], ["forecast", () => import("./forecast.js")],
  ["compare", () => import("./compare.js")], ["docs", () => import("./docs.js")],
].map(([view, load]) => [view, () => importRetry(load, `./${view}.js`)]));

/* While a view's code or data is on its way it shows its own shape in shimmering placeholders,
   so the page never flashes empty; the view's render replaces it. */
const SKELETON = {
  data: [[3, 132], [3, 132], [3, 132], [3, 132], [8, 360], [4, 360], [12, 420]],
  speed: [[12, 168], [12, 168], [4, 124], [4, 124], [4, 124], [12, 280], [12, 240]],
  system: [[12, 420], [12, 520]],
  judge: [[12, 64], [4, 380], [4, 380], [4, 380], [12, 150], [7, 320], [5, 320]],
  bench: [[12, 168], [5, 390], [7, 390], [7, 360], [5, 360], [12, 420]],
  compare: [[12, 72], [12, 560]],
  docs: [[4, 380], [4, 380], [4, 380]],
};
function skeletonHTML(view) {
  if (view === "samples" || view === "forecast") {
    return `<div class="bench-skel"><div class="skel-card"><span class="skel" style="height:36px"></span>${'<span class="skel skel-line"></span>'.repeat(9)}</div><div class="skel-card"><span class="skel" style="height:56px"></span><span class="skel" style="flex:1"></span></div></div>`;
  }
  return `<div class="bento" aria-busy="true">${(SKELETON[view] || SKELETON.system).map(([span, h], i) =>
    `<div class="card skel-card" style="--span:${span};height:${h}px;--i:${i}"><span class="skel skel-title"></span><span class="skel" style="flex:1"></span></div>`).join("")}</div>`;
}

function readURL() {
  const q = new URLSearchParams(location.search);
  state.view = VIEWS.includes(q.get("view")) ? q.get("view") : "data";
  state.product = PRODUCTS.includes(q.get("product")) ? q.get("product") : state.product;
  // The standalone matrix / compare pages reuse this router under /matrix/ and /compare/;
  // the flags keep their own view and survive pushState navigation.
  document.documentElement.dataset.matrix = q.has("matrix") ? "1" : "";
  document.documentElement.dataset.compare = q.has("compare") ? "1" : "";
  if (q.has("matrix")) document.title = "聚类矩阵 · 评测看板";
  else if (q.has("compare")) document.title = "版本对比 · 评测看板";
  else if (/^(聚类矩阵|版本对比) · 评测看板$/.test(document.title)) document.title = "评测看板";
}

export function navigate(params, { replace = false } = {}) {
  const q = new URLSearchParams(location.search);
  Object.entries(params).forEach(([k, v]) => (v == null || v === "" ? q.delete(k) : q.set(k, v)));
  // A standalone page only owns one view: sample recall opens the detail page, A/B recall opens
  // the compare page, and anything that still needs the full board opens /dashboard/.  The base
  // keeps DSW proxy prefixes intact (the frontend must never link to a root-absolute path).
  const standalone = /^\/(?:.*\/)?(?:matrix|compare|compare_details)\//.test(location.pathname)
    && (document.documentElement.dataset.matrix === "1" || document.documentElement.dataset.compare === "1");
  if (standalone && params.view && params.view !== "data") {
    const view = params.view;
    const base = location.pathname.replace(/\/(?:matrix|compare|compare_details)(?:\/.*)?$/, "/");
    const next = new URLSearchParams(q);
    next.delete("matrix");
    next.delete("compare");
    if (view === "samples") {
      const recalled = next.get("case") || next.get("slug");
      if (recalled) {
        // The matrix drawer carries the 10-hex sample slug in `case`; the detail page's
        // backend resolves slugs only through `slug`.
        if (next.get("case") && /^[0-9a-f]{10}$/.test(next.get("case"))) {
          next.set("slug", next.get("case"));
          next.delete("case");
        }
        next.delete("view");
        location.assign(`${base}?${next}`);
      } else {
        location.assign(`${base}dashboard/?${next}`);
      }
    } else if (view === "compare") {
      location.assign(`${base}compare/?compare=1&${next}`);
    } else {
      location.assign(`${base}dashboard/?${next}`);
    }
    return;
  }
  history[replace ? "replaceState" : "pushState"](null, "", `${location.pathname}?${q}`);
  if (!replace) render();
}
window.addEventListener("popstate", () => render());

const servedHere = (p) => Boolean(state.data && p in (state.data.products || {}));

/* The other server's URL for a product not built here; null when it is served here (or this is its server). */
function awayURL(product, params) {
  const site = SITES[product];
  if (!site || servedHere(product)) return null;
  const url = new URL(site.url);
  if (url.origin === location.origin) return null;
  url.search = new URLSearchParams(params).toString();
  return url.href;
}

let viewSeg;
let productSeg;
let lastView = null;

async function loadProductData(product = state.product) {
  // "failed" must not stick: one flaky request used to blank this product until the next build.
  if (state.productData[product] === true) return state.data?.products?.[product] || null;
  const meta = state.data?.products?.[product];
  if (!meta) return null;
  state.productP[product] = state.productP[product] || getJSON(`data-${product}.json`);
  try {
    const payload = await state.productP[product];
    state.data.products[product] = payload.products[product];
    state.productData[product] = true;
    return state.data.products[product];
  } catch (err) {
    state.productP[product] = null;
    state.productData[product] = "failed";
    state.data.products[product] = null;
    throw err;
  }
}

function loadTrendSummary(product = state.product) {
  if (!state.trendSummaryP[product]) {
    state.trendSummaryP[product] = getJSON(`trends_summary-${product}.json`, { retries: 1 }).catch(() => {
      state.trendSummaryP[product] = null;
      return null;
    });
  }
  return state.trendSummaryP[product];
}

async function loadIndex(product = state.product) {
  if (state.indexes[product]) return state.indexes[product];
  state.indexP[product] = state.indexP[product] || getJSON(`samples-${product}.json`);
  try {
    state.indexes[product] = await state.indexP[product];
    return state.indexes[product];
  } catch (err) {
    state.indexP[product] = null;
    throw err;
  }
}

/* The first page of the sample list (recall-<product>.json, a few hundred KB) paints while the
   full index (tens of MB) is still downloading; null when the head is unavailable. */
const recallP = {};
function loadRecallHead(product = state.product) {
  recallP[product] = recallP[product] || getJSON(`recall-${product}.json`).catch(() => {
    recallP[product] = null;
    return null;
  });
  return recallP[product];
}
const peekIndex = (product = state.product) => state.indexes[product] || null;

/* Server-side recall: uncapped paginated session recall for 具体数据 and bounded (<= 500)
   slices for 数据看板 (sunburst galaxy, trend drawer, compare sibling lookup) to keep requests
   to a few KB instead of pulling the tens-of-MB full samples index into the browser. */
const recallCache = new Map();
const RECALL_CACHE_MAX = 64;
let recallApiBroken = false;
function clearRecallCache() {
  recallCache.clear();
  recallApiBroken = false;
}
function cachedRecall(url) {
  if (recallApiBroken) return Promise.resolve(null);
  if (recallCache.has(url)) {
    const p = recallCache.get(url);
    recallCache.delete(url);
    recallCache.set(url, p);
    return p;
  }
  const p = getJSON(url, { retries: 0 }).catch((err) => {
    recallCache.delete(url);
    if (err && /404|405/.test(String(err.message || err))) recallApiBroken = true;
    return null;
  });
  recallCache.set(url, p);
  if (recallCache.size > RECALL_CACHE_MAX) {
    recallCache.delete(recallCache.keys().next().value);
  }
  return p;
}
function buildQS(params) {
  const sp = new URLSearchParams();
  Object.entries(params || {}).forEach(([k, v]) => {
    if (v != null && v !== "") sp.set(k, String(v));
  });
  return sp.toString();
}
function recallPage(product = state.product, params = {}) {
  const qs = buildQS(params);
  return cachedRecall(`api/recall/${encodeURIComponent(product)}.json${qs ? `?${qs}` : ""}`);
}
function recallSlice(product = state.product, params = {}) {
  const qs = buildQS(params);
  return cachedRecall(`api/recall_slice/${encodeURIComponent(product)}.json${qs ? `?${qs}` : ""}`);
}
function inputSlice(product = state.product, params = {}) {
  const qs = buildQS(params);
  return cachedRecall(`api/input_slice/${encodeURIComponent(product)}.json${qs ? `?${qs}` : ""}`);
}
async function recallLookup(product = state.product, { slugs = [], tids = [], cap = 500 } = {}) {
  if (recallApiBroken) return null;
  try {
    const res = await fetch(`api/recall_lookup/${encodeURIComponent(product)}.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slugs, tids, cap }),
    });
    if (res.status === 404 || res.status === 405) {
      recallApiBroken = true;
      return null;
    }
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function render({ refresh = false } = {}) {
  readURL();
  document.documentElement.dataset.view = state.view;
  viewSeg.set(state.view, { silent: true });
  productSeg.set(state.product, { silent: true });
  $$(".view").forEach((v) => v.classList.toggle("is-active", v.dataset.view === state.view));
  if (lastView !== state.view) {
    window.scrollTo(0, 0);
  }
  lastView = state.view;
  const root = $(`.view[data-view="${state.view}"]`);
  const waiting = !modules[state.view] || (state.data && NEEDS_PRODUCT.has(state.view) && state.productData[state.product] !== true);
  if (waiting && !root.firstChild) root.innerHTML = skeletonHTML(state.view);
  try {
    const cssP = ensureViewCSS(state.view);
    modules[state.view] = modules[state.view] || (await loaders[state.view]());
    await cssP;
    if (state.data && NEEDS_PRODUCT.has(state.view)) {
      try {
        await loadProductData(state.product);
      } catch (err) {
        console.error(err);
      }
    }
    await modules[state.view].render(root, { ...state, navigate, loadIndex, peekIndex, loadRecallHead, loadTrendSummary, recallPage, recallSlice, inputSlice, recallLookup, refresh });
  } catch (err) {
    console.error(err);
    root.innerHTML = `<div class="bento"><div class="card" style="--span:12"><div class="empty">页面加载失败：${esc(String(err.message || err))}</div></div></div>`;
  }
  $("#mask").classList.add("is-off");
}

/* ---------------------------------------------------------------- incremental refresh
   The server rebuilds every 10 minutes; the page revalidates data.json every 2 (a 304 when
   nothing changed) and, when a new build landed, swaps the payloads under the current view
   without touching the URL or the view's own drill / filter / page state. */
const POLL_MS = 120000;
let polling = false;

/* Data timestamps are Beijing time. A bare stamp (older payload) is read as +08:00, and the
   label is always rendered in Beijing time instead of the viewer's browser zone. */
function beijing(at) {
  const s = String(at).trim();
  const zoned = /(?:Z|[+-]\d{2}:?\d{2})$/.test(s);
  const t = new Date(zoned ? s : `${s.replace(" ", "T")}+08:00`);
  return Number.isNaN(t.getTime()) ? null : new Date(t.getTime() + 8 * 3600 * 1000);
}

function stamp(pulse = false) {
  const el = $("#stamp");
  const at = state.data && state.data.generated_at;
  if (!el || !at) return;
  const t = beijing(at);
  const now = beijing(new Date().toISOString());
  if (!t || !now) return;
  const p2 = (n) => String(n).padStart(2, "0");
  const today = now.getUTCFullYear() === t.getUTCFullYear() && now.getUTCMonth() === t.getUTCMonth() && now.getUTCDate() === t.getUTCDate();
  el.textContent = `截至 ${today ? "" : `${p2(t.getUTCMonth() + 1)}-${p2(t.getUTCDate())} `}${p2(t.getUTCHours())}:${p2(t.getUTCMinutes())}`;
  el.dateTime = at;
  el.hidden = false;
  if (pulse) {
    el.classList.remove("is-new");
    void el.offsetWidth;
    el.classList.add("is-new");
  }
}

async function poll() {
  if (polling || document.hidden || !state.data) return;
  polling = true;
  try {
    const fresh = await getJSON("data.json", { retries: 0 });
    const index = state.indexes[state.product];
    const staleIndex = index && index.generated_at !== state.data.generated_at;
    if (!fresh || !fresh.generated_at) return;
    if (fresh.generated_at === state.data.generated_at) {
      // samples-<p>.json is written right after data.json; pick it up if we raced the build.
      if (staleIndex && state.view === "samples") {
        state.indexes = {};
        state.indexP = {};
        Object.keys(recallP).forEach((p) => delete recallP[p]);
        clearRecallCache();
        await render({ refresh: true });
      }
      return;
    }
    state.data = fresh;
    state.productData = {};
    state.productP = {};
    state.trendSummaryP = {};
    state.indexes = {};
    state.indexP = {};
    Object.keys(recallP).forEach((p) => delete recallP[p]);
    clearRecallCache();
    await render({ refresh: true });
    stamp(true);
  } catch (err) {
    // A failed check just waits for the next one.
  } finally {
    polling = false;
  }
}

async function boot() {
  viewSeg = glassTabMenu($("#viewSwitch"), (v) => {
    announce(`切换到${VIEW_NAME[v]}`);
    const leaveBench = state.view === "bench" && v !== "bench" ? { ...BENCH_PARAMS, trace: null } : {};
    navigate({ view: v, doc: null, ...leaveBench, ...(v === "compare" || v === "forecast" ? SAMPLE_PARAMS : {}), ...(v === "data" ? { detail: null, ed: null, em: null, ep: null, edp: null } : {}), ...COMPARE_PARAMS });
  });
  productSeg = segmented($("#productSwitch"), (p) => {
    const away = awayURL(p, { view: state.view, product: p });
    if (away) location.assign(away);
    else navigate({ product: p, case: null, ...BENCH_PARAMS, ...COMPARE_PARAMS });
  });
  // Back from the other product's server (bfcache): the knob moved before leaving; put it back.
  window.addEventListener("pageshow", (e) => e.persisted && productSeg.set(state.product, { silent: true }));
  // 数据 / 文档 tab already active on a subpage: clicking it returns to the root index.
  $("#viewSwitch").addEventListener("click", (e) => {
    const dataBtn = e.target.closest('button[data-value="data"]');
    if (dataBtn && new URLSearchParams(location.search).get("detail")) {
      navigate({ view: "data", detail: null, ed: null, em: null, ep: null, edp: null });
      return;
    }
    const docsBtn = e.target.closest('button[data-value="docs"]');
    if (docsBtn && new URLSearchParams(location.search).get("doc")) {
      navigate({ view: "docs", doc: null });
      return;
    }
    const cmpBtn = e.target.closest('button[data-value="compare"]');
    if (cmpBtn) {
      const sp = new URLSearchParams(location.search);
      if (sp.get("face") || sp.get("pair")) {
        navigate({ view: "compare", face: null, pair: null });
      }
    }
  });
  // The theme switch is a pixel day/night toggle. Flipping it (click, drag or keyboard) grows the
  // new theme as a circle out of the knob; without view transitions every colour eases over.
  pixelToggle($("#themeToggle"), {
    day: document.documentElement.dataset.mode !== "dark",
    onChange: (day, el) => {
      const next = day ? "light" : "dark";
      const apply = () => {
        document.documentElement.dataset.mode = next;
        try {
          localStorage.setItem("eval-mode", next);
        } catch (err) {}
      };
      const root = document.documentElement;
      if (REDUCED) return apply();
      if (document.startViewTransition) {
        const r = el.getBoundingClientRect();
        root.style.setProperty("--vt-x", `${r.left + (day ? r.width - 14 : 14)}px`);
        root.style.setProperty("--vt-y", `${r.top + r.height / 2}px`);
        root.classList.add("is-theming");
        document.startViewTransition(apply).finished.finally(() => root.classList.remove("is-theming"));
        return null;
      }
      root.classList.add("is-theme-fade");
      apply();
      setTimeout(() => root.classList.remove("is-theme-fade"), 520);
      return null;
    },
  });
  // A strip under the bar while requests are being retried; it leaves once something answers.
  onNetwork(({ ok, attempt, wait }) => {
    const bar = $("#net");
    if (ok) {
      if (!bar.hidden) {
        $("#netText").textContent = "已重新连上";
        bar.classList.add("is-ok");
        setTimeout(() => { bar.hidden = true; bar.classList.remove("is-ok"); }, 1600);
        poll();
      }
      return;
    }
    bar.hidden = false;
    bar.classList.remove("is-ok");
    $("#netText").textContent = wait
      ? `连不上服务器，${Math.max(1, Math.round(wait / 1000))} 秒后第 ${attempt} 次重试`
      : "连不上服务器，稍后会自动再试";
  });
  window.addEventListener("online", () => poll());
  installTips();
  // Start the initial view's code, CSS, and data in parallel — no sequential data.json -> data-<p>.json waterfall.
  readURL();
  const asked = new URLSearchParams(location.search).get("product");
  const localProducts = Array.isArray(BOOT.products) ? BOOT.products : [];
  const eagerProduct = PRODUCTS.includes(asked)
    ? (localProducts.length && !localProducts.includes(asked) ? null : asked)
    : (PRODUCTS.find((p) => localProducts.includes(p)) || null);
  const cssP = ensureViewCSS(state.view);
  const dataP = getJSON("data.json").catch(() => ({ products: {}, source: { pairs: 0 } }));
  const moduleP = loaders[state.view]().catch(() => null);
  if (eagerProduct && NEEDS_PRODUCT.has(state.view)) {
    state.productP[eagerProduct] = state.productP[eagerProduct] || getJSON(`data-${eagerProduct}.json`);
    if (state.view === "data") loadTrendSummary(eagerProduct);
  }
  state.data = await dataP;
  if (!asked) {
    state.product = PRODUCTS.find((p) => state.data.products[p]) || "wencai";
  }
  // A link to a product served elsewhere (?product=aime on the 问财 server) continues on its server.
  const away = PRODUCTS.includes(asked) && awayURL(asked, new URLSearchParams(location.search));
  if (away) return location.replace(away);
  // The product payload is already in flight when eagerProduct matched; await it alongside code + CSS.
  const productP = NEEDS_PRODUCT.has(state.view) ? loadProductData(state.product).catch((err) => console.error(err)) : null;
  const [mod] = await Promise.all([moduleP, cssP, productP]);
  if (mod) modules[state.view] = mod;
  render();
  stamp();
  setInterval(poll, POLL_MS);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) poll();
  });
}

boot();
