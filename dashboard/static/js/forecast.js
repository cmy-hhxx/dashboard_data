/* 预测数据: every judged forecast answer as a list row, opening the same trajectory pane as 具体数据
   (samples.js in forecast mode) with the 预测核验 box above the trajectory. */
import { render as renderSamples } from "./samples.js";

const RESULT = { correct: "正确", wrong: "错误", pending: "待揭晓", undetermined: "无法判定" };

function forecastIndex(p) {
  const items = ((p && p.prediction) || {}).items || [];
  const rows = items.filter((it) => it.s).map((it) => ({
    s: it.s, f: it.f || "", qi: it.i, q: it.q || "", m: it.v, sp: "daily", d: it.d || "", w: "none", n: 0, tr: 1,
    r: [], st: [], pt: [], tg: [], lb: "", fc: 1, c: it.c || "其他", t: it.t || "其他", res: it.r, e: it.e || "",
  }));
  return {
    products: {
      [p.key]: { label: p.label, models: p.models || [], splits: [{ id: "daily" }], rows },
    },
  };
}

export async function render(root, c) {
  const p = c.data.products[c.product];
  if (!p || !p.prediction || !(p.prediction.items || []).length) {
    root.innerHTML = `<div class="bento"><div class="card" style="--span:12"><div class="empty">暂无预测数据</div></div></div>`;
    return;
  }
  const idx = forecastIndex({ ...p, key: c.product });
  idx.generated_at = c.data.generated_at;
  return renderSamples(root, { ...c, forecast: { result: RESULT }, loadIndex: async () => idx });
}
