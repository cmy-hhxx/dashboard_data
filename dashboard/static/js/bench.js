/* Bench: the evaluator's two ends of the same data, one list each. Golden cases are cases the
   evaluator left alone (no problem at all); badcases are the cases it filed a P0 or P1 on. The
   list comes from the server a page at a time (/bench/<product>.json); every row opens its case in
   具体数据, where the trajectory and the evidence live. */
import { $, esc, fmt, SEV_NAME, sevColor, getJSON } from "./core.js";

const PAGE = 25;
const S = { kind: "golden", page: 1, sev: "", counts: null, total: 0, pages: 1, rows: [], token: 0 };
const SEG_NAME = { golden: "Golden case", bad: "Badcase" };
const GO = `<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M6 4l4 4-4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const chip = (k) => `<span class="jd-sev" style="--c:${sevColor(k)}"><i></i>${esc(SEV_NAME[k] || k || "无问题")}</span>`;

/* One case, one line: what the list knows, and a way into its trajectory. */
function rowHTML(r, i) {
  const golden = r.w === "none";
  const sub = golden
    ? "评测未发现问题"
    : `${fmt(r.n)} 个问题${r.c && r.c.P0 ? ` · P0 ${fmt(r.c.P0)}` : ""}${r.c && r.c.P1 ? ` · P1 ${fmt(r.c.P1)}` : ""}`;
  const label = `<span class="bn-q"><b>${esc(r.q)}</b><span>${esc(sub)}</span></span>`;
  const meta = `<span class="bn-m">${esc(r.m || "")}</span><span class="bn-d num">${esc(r.d || "")}</span>`;
  if (!r.s) {
    return `<div class="bn-row is-static" style="--i:${i}">${chip(r.w)}${label}${meta}<span class="bn-go is-none">无详情</span></div>`;
  }
  return `<button type="button" class="bn-row" style="--i:${i}" data-open="${esc(r.s)}" title="在具体数据中打开这道 case">${chip(r.w)}${label}${meta}<span class="bn-go">查看${GO}</span></button>`;
}

function segHTML() {
  const n = (k) => (S.counts && S.counts[k] && S.counts[k].count) || 0;
  const item = (k) => `<button type="button" data-kind="${k}" aria-pressed="${S.kind === k}">${SEG_NAME[k]}<small class="num">${fmt(n(k))}</small></button>`;
  const sevs = S.kind === "bad"
    ? `<span class="bn-sevs" role="group" aria-label="等级">${["P0", "P1"].map((s) => `<button type="button" class="bn-sev" data-sev="${s}" aria-pressed="${S.sev === s}" style="--c:${sevColor(s)}"><i></i>${s}<small class="num">${fmt((S.counts && S.counts.bad && S.counts.bad.sev && S.counts.bad.sev[s]) || 0)}</small></button>`).join("")}</span>`
    : "";
  return `<div class="jd-bc-seg" role="group" aria-label="类别">${item("golden")}${item("bad")}</div>${sevs}`;
}

function pagerHTML() {
  const btn = (key, label, off) => `<button type="button" data-page="${key}"${off ? " disabled" : ""}>${label}</button>`;
  return `${btn("first", "«", S.page === 1)}${btn("prev", "上一页", S.page === 1)}
    <span class="pager-info">第 <b class="num">${S.page}</b> / ${fmt(S.pages)} 页 · 共 ${fmt(S.total)} 条</span>
    ${btn("next", "下一页", S.page === S.pages)}${btn("last", "»", S.page === S.pages)}`;
}

function paintList(root) {
  $("#bnTools", root).innerHTML = segHTML();
  $("#bnCount", root).textContent = `${fmt(S.total)} 条`;
  $("#bnList", root).innerHTML = S.rows.length
    ? S.rows.map((r, i) => rowHTML(r, i)).join("")
    : `<div class="empty">这一组还没有数据。</div>`;
  const pager = $("#bnPager", root);
  pager.hidden = S.total <= PAGE;
  pager.innerHTML = pager.hidden ? "" : pagerHTML();
}

async function load(root, c) {
  const token = (S.token += 1);
  $("#bnTools", root).innerHTML = segHTML();
  $("#bnList", root).innerHTML = `<div class="bn-wait">正在取第 ${S.page} 页…</div>`;
  const q = new URLSearchParams({ kind: S.kind, page: String(S.page), size: String(PAGE) });
  if (S.sev) q.set("sev", S.sev);
  try {
    const data = await getJSON(`bench/${encodeURIComponent(c.product)}.json?${q}`);
    if (token !== S.token) return;
    S.rows = data.rows || [];
    S.total = data.total || 0;
    S.pages = data.pages || 1;
    S.page = data.page || S.page;
    S.counts = data.kinds || S.counts;
    paintList(root);
  } catch (err) {
    if (token !== S.token) return;
    S.rows = [];
    S.total = 0;
    $("#bnList", root).innerHTML = `<div class="empty">这一组读取失败：${esc(String(err.message || err))}</div>`;
    $("#bnPager", root).hidden = true;
  }
}

export async function render(root, c) {
  const d = c.data;
  const key = `${c.product}|${d.generated_at}`;
  if (root._bnKey === key && root.firstChild) return;
  root._bnKey = key;
  S.kind = "golden";
  S.page = 1;
  S.sev = "";
  root.innerHTML = `<div class="bento bn">
    <article class="card" style="--span:12">
      <header class="card-head"><h2>Bench</h2>
        <div class="jd-bc-tools" id="bnTools"></div>
        <span class="meta end num" id="bnCount"></span></header>
      <div class="bn-list" id="bnList"></div>
      <div class="pager" id="bnPager" hidden></div>
    </article>
  </div>`;
  root._bnCtx = c;
  if (!root._bnWired) {
    root._bnWired = true;
    root.addEventListener("click", (e) => {
      const ctx = root._bnCtx;
      const kind = e.target.closest("[data-kind]");
      if (kind) {
        if (S.kind === kind.dataset.kind) return;
        S.kind = kind.dataset.kind;
        S.sev = "";
        S.page = 1;
        return load(root, ctx);
      }
      const sev = e.target.closest("[data-sev]");
      if (sev) {
        S.sev = S.sev === sev.dataset.sev ? "" : sev.dataset.sev;
        S.page = 1;
        return load(root, ctx);
      }
      const page = e.target.closest("[data-page]");
      if (page) {
        S.page = page.dataset.page === "first" ? 1
          : page.dataset.page === "last" ? S.pages
            : page.dataset.page === "prev" ? S.page - 1 : S.page + 1;
        S.page = Math.max(1, Math.min(S.pages, S.page));
        return load(root, ctx);
      }
      const row = e.target.closest("[data-open]");
      if (!row) return;
      ctx.navigate?.({ view: "samples", product: ctx.product, case: row.dataset.open, p: null, w: null, trace: null });
    });
  }
  await load(root, c);
}
