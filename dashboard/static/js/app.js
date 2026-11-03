/* Router and shell: ?view=data|system|samples&product=wencai|aime (+ sample params). */
import { $, $$, segmented, getJSON, announce } from "./core.js";

const VIEWS = ["data", "system", "samples"];
const PRODUCTS = ["wencai", "aime"];
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

let viewSeg;
let productSeg;
let lastView = null;

async function loadProductData(product = state.product) {
  if (state.productData[product]) return state.data?.products?.[product] || null;
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

async function render() {
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
    await modules[state.view].render(root, { ...state, navigate, loadIndex });
  } catch (err) {
    console.error(err);
    root.innerHTML = `<div class="bento"><div class="card" style="--span:12"><div class="empty">页面加载失败：${String(err.message || err)}</div></div></div>`;
  }
  $("#mask").classList.add("is-off");
}

async function boot() {
  viewSeg = segmented($("#viewSwitch"), (v) => {
    announce(`切换到${{ data: "数据看板", system: "评测体系", samples: "具体数据" }[v]}`);
    navigate(v === "data" ? { view: v, detail: null, ed: null, em: null, ep: null, edp: null } : { view: v });
  });
  productSeg = segmented($("#productSwitch"), (p) => navigate({ product: p, case: null }));
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
  if (!new URLSearchParams(location.search).get("product")) {
    state.product = PRODUCTS.find((p) => state.data.products[p]) || "wencai";
  }
  try {
    await loadProductData(state.product);
  } catch (err) {
    console.error(err);
  }
  render();
}

boot();
