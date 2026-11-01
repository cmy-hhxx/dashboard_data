/* Router and shell: ?view=data|system|samples&product=wencai|aime (+ sample params). */
import { $, $$, segmented, getJSON, announce, fmt } from "./core.js";

const VIEWS = ["data", "system", "samples"];
const PRODUCTS = ["wencai", "aime"];
const state = { view: "data", product: "wencai", data: null, index: null };
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
  if (!state.index) state.index = await getJSON("samples.json");
  return state.index;
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

function stamp(data) {
  const src = data && data.source;
  $("#stamp").textContent =
    src && src.pairs
      ? `${fmt(src.pairs)} 组样本 · 生成于 ${(data.generated_at || "").replace("T", " ").slice(5, 16)}`
      : "等待数据接入";
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
  try {
    state.data = await getJSON("data.json");
  } catch (e) {
    state.data = { products: {}, source: { pairs: 0 } };
  }
  stamp(state.data);
  if (!new URLSearchParams(location.search).get("product")) {
    state.product = PRODUCTS.find((p) => state.data.products[p]) || "wencai";
  }
  render();
}

boot();
