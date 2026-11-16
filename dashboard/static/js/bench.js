/* Bench: the evaluator's two ends of the same data, one list each. Golden cases are cases the
   evaluator left alone (no problem at all); badcases are the cases it filed a P0 or P1 on. The
   list comes from the server a page at a time (/bench/<product>.json); a row opens in place, and a
   golden case goes on to its full trajectory in 具体数据. */
import { $, esc, fmt, SEV, SEV_NAME, sevColor, KIND, getJSON } from "./core.js";

const PAGE = 25;
const S = { kind: "golden", page: 1, sev: "", open: new Set(), counts: null, total: 0, pages: 1, rows: [], detail: new Map(), token: 0 };
const KIND_NAME = { golden: "Golden", bad: "Badcase" };
const SEG_NAME = { golden: "Golden case", bad: "Badcase" };
const CHEV = `<svg class="jd-bcr-chev" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 6l4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const GO = `<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M6 4l4 4-4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

const chip = (k) => `<span class="jd-sev" style="--c:${sevColor(k)}"><i></i>${esc(SEV_NAME[k] || k || "无问题")}</span>`;

/* One row: the facts Bench has from the list, then the case's own problems on demand. */
function rowHTML(r, i) {
  const open = S.open.has(r.i);
  const sub = r.w === "none"
    ? "评测未发现问题"
    : `${fmt(r.n)} 个问题${r.c && r.c.P0 ? ` · P0 ${fmt(r.c.P0)}` : ""}${r.c && r.c.P1 ? ` · P1 ${fmt(r.c.P1)}` : ""}`;
  return `<div class="jd-bcr bn-row${open ? " is-open" : ""}" style="--i:${i}" data-bn="${esc(r.i)}">
    <button type="button" class="jd-bcr-head" aria-expanded="${open}" aria-controls="bn-${esc(r.i)}">
      <span class="bn-kind ${r.w === "none" ? "is-golden" : "is-bad"}">${KIND_NAME[r.w === "none" ? "golden" : "bad"]}</span>
      ${chip(r.w)}
      <span class="jd-bcr-q"><b>${esc(r.q)}</b><span>${esc(sub)}</span></span>
      <span class="jd-bcr-st">${esc(r.m || "")}</span>
      <span class="jd-bcr-m num">${esc(r.d || "")}</span>
      ${CHEV}
    </button>
    <div class="jd-bcr-body" id="bn-${esc(r.i)}" role="region" aria-label="${esc(r.q)}"><div class="jd-bcr-in bn-in" data-body="1">${open ? bodyHTML(r) : ""}</div></div>
  </div>`;
}

const clip = (text, max) => {
  const s = String(text == null ? "" : text);
  return s.length > max ? `${s.slice(0, max)}…` : s;
};

function problemHTML(d, p) {
  const ev = (p.ev || []).map((k) => (d.evidence || [])[k]).filter((e) => e && e.q).slice(0, 3);
  const path = p.cl && p.cl.path;
  return `<div class="bn-prob" style="--c:${sevColor(p.sev)}">
    <div class="bn-prob-top">${chip(p.sev)}<b>${esc(p.label)}</b></div>
    <div class="bn-prob-meta">${esc(p.comp || p.role || "")}${path ? `<code>${esc(path)}</code>` : ""}${ev.length ? `<span class="num">${ev.map((e) => `#${e.m}`).join(" ")}</span>` : ""}</div>
    ${ev.length ? `<ol class="jd-ev">${ev.map((e) => `<li><span class="num">${e.m == null ? "—" : `#${e.m}`}</span><q>${esc(clip(e.q, 220))}</q></li>`).join("")}</ol>` : ""}
  </div>`;
}

function bodyHTML(r) {
  const d = S.detail.get(r.i);
  if (!d) {
    return `<section class="jd-bcx"><span class="jd-bcx-k">正在读取这道 case</span><span class="bn-note">…</span></section>`;
  }
  if (d.error) {
    return `<section class="jd-bcx"><span class="jd-bcx-k">完整轨迹</span><p class="bn-note">${esc(d.error)}</p></section>`;
  }
  if (d.note) return `<section class="jd-bcx"><span class="jd-bcx-k">说明</span><p class="bn-note">${esc(d.note)}</p></section>`;
  const probs = ((d.attribution && d.attribution.problems) || []).slice()
    .sort((a, b) => SEV.indexOf(a.sev) - SEV.indexOf(b.sev));
  const kinds = new Map();
  ((d.input && d.input.traces) || []).forEach((t) => (t.messages || []).forEach((m) => kinds.set(m.k, (kinds.get(m.k) || 0) + 1)));
  const msgs = [...kinds.values()].reduce((a, b) => a + b, 0);
  const left = probs.length
    ? `<section class="jd-bcx"><span class="jd-bcx-k">评测器找到的问题 · ${fmt(probs.length)}</span>${probs.map((p) => problemHTML(d, p)).join("")}</section>`
    : `<section class="jd-bcx"><span class="jd-bcx-k">评测器找到的问题</span><p class="bn-none">没有发现问题，这道 case 的全部输出都通过了评测。</p></section>`;
  return `${left}
    <section class="jd-bcx is-side"><span class="jd-bcx-k">轨迹</span>
      <div class="bn-kinds">${[...kinds].map(([k, n]) => `<span><b class="num">${fmt(n)}</b>${esc(KIND[k] || k)}</span>`).join("") || `<span class="bn-note">没有消息记录</span>`}</div>
      ${r.s ? `<button type="button" class="jd-go bn-open" data-open="${esc(r.s)}">完整轨迹${GO}</button>` : `<span class="bn-note">这条 case 没有挂上具体数据</span>`}
      <span class="bn-note num">${fmt(msgs)} 条消息</span>
    </section>`;
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
  $("#bnList", root).innerHTML = `<div class="bn-wait">正在取第 ${S.page} 页…</div>`;
  $("#bnTools", root).innerHTML = segHTML();
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
    // An open row whose detail was still in flight when the page changed resumes here.
    S.rows.forEach((r) => { if (S.open.has(r.i) && !S.detail.get(r.i)) loadDetail(root, r); });
  } catch (err) {
    if (token !== S.token) return;
    S.rows = [];
    S.total = 0;
    $("#bnList", root).innerHTML = `<div class="empty">这一组读取失败：${esc(String(err.message || err))}</div>`;
    $("#bnPager", root).hidden = true;
  }
}

/* The row's own case, read once and kept: a page flip does not refetch what was opened. */
async function loadDetail(root, r) {
  if (!r || S.detail.has(r.i)) return;
  S.detail.set(r.i, null);
  const body = root.querySelector(`[data-bn="${CSS.escape(r.i)}"] [data-body]`);
  if (body) body.innerHTML = bodyHTML(r);
  if (!r.s) {
    S.detail.set(r.i, { note: "这道 case 没有挂上具体数据，只有列表里的信息。" });
    const only = root.querySelector(`[data-bn="${CSS.escape(r.i)}"] [data-body]`);
    if (only) only.innerHTML = bodyHTML(r);
    return;
  }
  try {
    const d = await getJSON(`samples/${encodeURIComponent(r.s)}.json`);
    S.detail.set(r.i, d || { error: "这道 case 的轨迹暂时读不到。" });
  } catch (err) {
    S.detail.set(r.i, { error: "这道 case 的轨迹暂时读不到。" });
  }
  const now = root.querySelector(`[data-bn="${CSS.escape(r.i)}"] [data-body]`);
  if (now) now.innerHTML = bodyHTML(r);
}

export async function render(root, c) {
  const d = c.data;
  const key = `${c.product}|${d.generated_at}`;
  if (root._bnKey === key && root.firstChild) return;
  root._bnKey = key;
  S.kind = "golden";
  S.page = 1;
  S.sev = "";
  S.open.clear();
  S.detail.clear();
  root.innerHTML = `<div class="bento bn">
    <article class="card" style="--span:12">
      <header class="card-head"><h2>Bench</h2>
        <div class="jd-bc-tools" id="bnTools"></div>
        <span class="meta end num" id="bnCount"></span></header>
      <div class="jd-bcl" id="bnList"></div>
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
      const go = e.target.closest("[data-open]");
      if (go) {
        ctx.navigate?.({ view: "samples", product: ctx.product, case: go.dataset.open, p: null, w: null, trace: null });
        return;
      }
      const head = e.target.closest(".jd-bcr-head");
      if (!head) return;
      const row = head.closest("[data-bn]");
      const id = row.dataset.bn;
      const open = !S.open.has(id);
      if (open) S.open.add(id); else S.open.delete(id);
      row.classList.toggle("is-open", open);
      head.setAttribute("aria-expanded", String(open));
      const r = S.rows.find((x) => String(x.i) === id);
      if (open && r) loadDetail(root, r);
    });
  }
  await load(root, c);
}
