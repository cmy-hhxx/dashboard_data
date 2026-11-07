/* Router and shell: ?view=data|system|samples&product=wencai|aime (+ sample params). */
import { $, $$, segmented, getJSON, announce } from "./core.js";

const VIEWS = ["data", "system", "samples"];
const PRODUCTS = ["wencai", "aime"];
// Each product's board runs on its own server; a product with no data here opens its server instead.
const SITES = {
  wencai: { url: "http://117.50.195.94:2768/", name: "乌兰察布" },
  aime: { url: "http://10.217.219.2:2221/", name: "弗吉尼亚" },
};
const state = { view: "data", product: "wencai", data: null, indexes: {}, indexP: {}, productData: {}, productP: {} };
const modules = {};
const loaders = { data: () => import("./data.js"), system: () => import("./system.js"), samples: () => import("./samples.js") };

function readURL() {
  const q = new URLSearchParams(location.search);
  state.view = VIEWS.includes(q.get("view")) ? q.get("view") : "data";
  state.product = PRODUCTS.includes(q.get("product")) ? q.get("product") : state.product;
}

export function navigate(params, { replace = false } = {}) {
  const q = new URLSearchParams(location.search);
  Object.entries(params).forEach(([k, v]) => (v == null || v === "" ? q.delete(k) : q.set(k, v)));
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

async function render({ refresh = false } = {}) {
  readURL();
  document.documentElement.dataset.view = state.view;
  viewSeg.set(state.view, { silent: true });
  productSeg.set(state.product, { silent: true });
  $$(".view").forEach((v) => v.classList.toggle("is-active", v.dataset.view === state.view));
  if (lastView !== state.view) window.scrollTo(0, 0);
  lastView = state.view;
  const root = $(`.view[data-view="${state.view}"]`);
  try {
    modules[state.view] = modules[state.view] || (await loaders[state.view]());
    if (state.data) {
      try {
        await loadProductData(state.product);
      } catch (err) {
        console.error(err);
      }
    }
    await modules[state.view].render(root, { ...state, navigate, loadIndex, refresh });
  } catch (err) {
    console.error(err);
    root.innerHTML = `<div class="bento"><div class="card" style="--span:12"><div class="empty">页面加载失败：${String(err.message || err)}</div></div></div>`;
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
        await render({ refresh: true });
      }
      return;
    }
    state.data = fresh;
    state.productData = {};
    state.productP = {};
    state.indexes = {};
    state.indexP = {};
    await render({ refresh: true });
    stamp(true);
  } catch (err) {
    // A failed check just waits for the next one.
  } finally {
    polling = false;
  }
}

async function boot() {
  viewSeg = segmented($("#viewSwitch"), (v) => {
    announce(`切换到${{ data: "数据看板", system: "评测体系", samples: "具体数据" }[v]}`);
    navigate(v === "data" ? { view: v, detail: null, ed: null, em: null, ep: null, edp: null } : { view: v });
  });
  productSeg = segmented($("#productSwitch"), (p) => {
    const away = awayURL(p, { view: state.view, product: p });
    if (away) location.assign(away);
    else navigate({ product: p, case: null });
  });
  // Back from the other product's server (bfcache): the knob moved before leaving; put it back.
  window.addEventListener("pageshow", (e) => e.persisted && productSeg.set(state.product, { silent: true }));
  // 数据 tab already active on the evaluation-detail subpage: clicking it returns to the dashboard.
  $("#viewSwitch").addEventListener("click", (e) => {
    const b = e.target.closest('button[data-value="data"]');
    if (!b || !new URLSearchParams(location.search).get("detail")) return;
    navigate({ view: "data", detail: null, ed: null, em: null, ep: null, edp: null });
  });
  $("#themeToggle").addEventListener("click", () => {
    const next = document.documentElement.dataset.mode === "dark" ? "light" : "dark";
    document.documentElement.dataset.mode = next;
    try {
      localStorage.setItem("eval-mode", next);
    } catch (e) {}
  });
  // Start the initial view's code and data before the shell waits on the JSON.
  readURL();
  const dataP = getJSON("data.json").catch(() => ({ products: {}, source: { pairs: 0 } }));
  const moduleP = loaders[state.view]().catch(() => null);
  if (state.view === "samples") {
    state.indexP[state.product] = getJSON(`samples-${state.product}.json`);
    state.indexP[state.product].catch(() => {});
  }
  state.data = await dataP;
  const mod = await moduleP;
  if (mod) modules[state.view] = mod;
  const asked = new URLSearchParams(location.search).get("product");
  if (!asked) {
    state.product = PRODUCTS.find((p) => state.data.products[p]) || "wencai";
  }
  // A link to a product served elsewhere (?product=aime on the 问财 server) continues on its server.
  const away = PRODUCTS.includes(asked) && awayURL(asked, new URLSearchParams(location.search));
  if (away) return location.replace(away);
  try {
    await loadProductData(state.product);
  } catch (err) {
    console.error(err);
  }
  render();
  stamp();
  setInterval(poll, POLL_MS);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) poll();
  });
}

boot();
