/* Standalone entry for one sample's pane.
 *
 * dashboard/static/js/* is a frozen snapshot (see README.md); this file is the
 * only new frontend code.  It asks the backend for a mini recall index of the
 * session, then lets the snapshot's samples.js render the pane exactly as the
 * dashboard does, left list and top nav left out by detail.css.
 */
import { render } from "./js/samples.js";

const root = document.getElementById("root");
const params = new URLSearchParams(location.search);
const product = params.get("product") || "";
const caseKey = params.get("case") || "";
const slug = params.get("slug") || "";
const focusTrace = params.get("trace") || "";

const esc = (value) =>
  String(value == null ? "" : value).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

function message(title, body) {
  root.innerHTML = `<div class="usage"><h1>${esc(title)}</h1><p class="faint">${esc(body)}</p></div>`;
}

function usage() {
  root.innerHTML = `<div class="usage">
    <h1>评测样本详情</h1>
    <p>这个地址单独展示一个样本的评测输入与输出：轨迹、对话与归因，和看板「具体数据」页右侧的详情一致。</p>
    <p>在地址后面带上参数之一：</p>
    <pre><code>?product=wencai&amp;case=daily%7Cb_fast%7Cthread_…   一个会话（多轮自动合并）
?product=wencai&amp;slug=4941606c59                 一条评测输出
&amp;trace=&lt;trace_id&gt;                            直接定位到会话里的某一轮</code></pre>
    <p class="faint">完整链接向数据负责人索取；不带参数的地址就是本说明页。</p>
  </div>`;
}

async function boot() {
  if (!caseKey && !slug) return usage();
  root.innerHTML = `<div class="usage"><p class="faint">正在读取样本…</p></div>`;

  const query = new URLSearchParams();
  if (product) query.set("product", product);
  if (caseKey) query.set("case", caseKey);
  if (slug) query.set("slug", slug);
  if (focusTrace) query.set("trace", focusTrace);

  let response;
  try {
    // 保持相对路径：页面也会挂在路径前缀下（如 /bmtp/proxy/dsw/trace-detail/），
    // 前导 "/" 会跳出前缀导致接口 404。
    response = await fetch(`api/context?${query}`, { cache: "no-store" });
  } catch (err) {
    return message("数据服务暂时不可用", "请稍后重试。");
  }
  if (response.status === 404) {
    return message("没有找到这个样本", "检查链接里的 case / slug 是否正确；样本也可能已被新一轮构建替换，请向数据负责人确认。");
  }
  if (!response.ok) return message("数据服务异常", `HTTP ${response.status}，请稍后重试。`);

  const payload = await response.json();
  const ctx = {
    product: payload.product,
    data: { taxonomy: payload.taxonomy },
    // 单样本页只渲染一个会话，索引是子集（行号对不上全量 labels）：快照别去拉 labels。
    oneSession: true,
    loadIndex: async () => payload.index,
    navigate: (patch, { replace = false } = {}) => {
      const url = new URL(location.href);
      Object.entries(patch).forEach(([key, value]) =>
        value == null || value === "" ? url.searchParams.delete(key) : url.searchParams.set(key, value),
      );
      if (patch.case) url.searchParams.delete("slug");
      if (!url.searchParams.get("product")) url.searchParams.set("product", payload.product);
      history[replace ? "replaceState" : "pushState"](null, "", url);
    },
  };

  const result = await render(root, ctx);
  if (result && result.traceMiss) {
    return message("没有找到这条 trace", `链接里的 trace（${result.traceMiss}）不在这个会话里；可能是链接过期，或它属于别的会话。去掉 trace 参数可查看会话默认轮。`);
  }
  const headline = root.querySelector("#shead h2");
  if (headline && headline.textContent) document.title = `${headline.textContent} · 样本详情`;
}

boot().catch((err) => {
  console.error(err);
  message("页面加载失败", String((err && err.message) || err));
});
