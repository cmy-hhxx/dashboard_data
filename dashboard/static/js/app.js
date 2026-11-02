/* Router and shell: ?view=data|system|samples&product=wencai|aime (+ sample params). */
import { $, $$, segmented, getJSON, announce } from "./core.js";

const VIEWS = ["data", "system", "samples"];
const PRODUCTS = ["wencai", "aime"];
const state = { view: "data", product: "wencai", data: null, index: null, indexP: null };
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

async function loadIndex() {
  if (state.index) return state.index;
  state.indexP = state.indexP || getJSON("samples.json");
  try {
    state.index = await state.indexP;
    return state.index;
  } catch (err) {
    state.indexP = null;
    throw err;
  }
}

async function render() {
  readURL();
  viewSeg.set(state.view, { silent: true });
  productSeg.set(state.product, { silent: true });
  $$(".view").forEach((v) => v.classList.toggle("is-active", v.dataset.view === state.view));
  if (lastView !== state.view) window.scrollTo(0, 0);
  lastView = state.view;
  const root = $(`.view[data-view="${state.view}"]`);
  try {
    modules[state.view] = modules[state.view] || (await loaders[state.view]());
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
    navigate({ view: v });
  });
  productSeg = segmented($("#productSwitch"), (p) => navigate({ product: p, case: null }));
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
    state.indexP = getJSON("samples.json");
    state.indexP.catch(() => {});
  }
  state.data = await dataP;
  const mod = await moduleP;
  if (mod) modules[state.view] = mod;
  if (!new URLSearchParams(location.search).get("product")) {
    state.product = PRODUCTS.find((p) => state.data.products[p]) || "wencai";
  }
  render();
}

boot();
