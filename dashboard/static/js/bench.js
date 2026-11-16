/* Bench: the hand-picked case set in one place. Golden cases are the evaluator at its best (every
   problem traced back to its messages, picked by build.py for 评测体系's evidence loop); badcases
   are where the audit model caught the evaluator out (评测评测's list). Both open in place, and a
   golden case goes on to its full trajectory in 具体数据. */
import { $, esc, fmt, SEV, sevColor, SEV_NAME, KIND } from "./core.js";
import { judgeMock } from "./judge_mock.js";
import { badcaseRow } from "./judge.js";

let shown = null;
const F = { kind: "", sev: "", q: "", open: new Set() };
const ROLE = { planning: "规划", request_generation: "请求生成", tool: "工具执行", script: "脚本执行", skill: "技能装载", delivery: "交付" };
const chip = (k) => `<span class="jd-sev" style="--c:${sevColor(k)}"><i></i>${esc(SEV_NAME[k] || k)}</span>`;
const CHEV = `<svg class="jd-bcr-chev" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 6l4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const GO = `<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M6 4l4 4-4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

function goldensOf(d, product) {
  const src = d.system && d.system.goldens;
  const list = Array.isArray(src) ? src : (src && src[product]) || [];
  return (Array.isArray(list) ? list : [list]).filter((g) => g && (g.problems || []).length);
}
const worst = (sevs) => sevs.slice().sort((a, b) => SEV.indexOf(a) - SEV.indexOf(b))[0] || "none";

function goldenRow(g, i) {
  const id = `g-${g.slug}`;
  const open = F.open.has(id);
  const sev = worst(g.problems.map((p) => p.sev));
  const evidence = g.problems.reduce((n, p) => n + (p.msgs || []).length, 0);
  const probs = g.problems.slice().sort((a, b) => SEV.indexOf(a.sev) - SEV.indexOf(b.sev)).map((p) => {
    const quotes = (p.ev || []).filter((e) => e.q);
    return `<div class="bn-prob" style="--c:${sevColor(p.sev)}">
      <div class="bn-prob-top">${chip(p.sev)}<b>${esc(p.label)}</b></div>
      <div class="bn-prob-meta">${esc(ROLE[p.role] || p.role || "")}${p.path ? `<code>${esc(p.path)}</code>` : ""}${(p.msgs || []).length ? `<span class="num">${p.msgs.map((m) => `#${m}`).join(" ")}</span>` : ""}</div>
      ${quotes.length ? `<ol class="jd-ev">${quotes.map((e) => `<li><span class="num">${e.m == null ? "—" : `#${e.m}`}</span><q>${esc(e.q)}</q></li>`).join("")}</ol>` : ""}
    </div>`;
  }).join("");
  const kinds = new Map();
  (g.messages || []).forEach((m) => kinds.set(m.k, (kinds.get(m.k) || 0) + 1));
  return `<div class="jd-bcr bn-row${open ? " is-open" : ""}" style="--i:${i}" data-bn="${esc(id)}">
    <button type="button" class="jd-bcr-head" aria-expanded="${open}">
      <span class="bn-kind is-golden">Golden</span>
      ${chip(sev)}
      <span class="jd-bcr-q"><b>${esc(g.question || g.slug)}</b><span>${g.problems.length} 个问题 · ${fmt(evidence)} 处证据回到原文</span></span>
      <span class="jd-bcr-st">${esc(g.model || "")}</span>
      <span class="jd-bcr-m num">${esc((g.date || "").slice(5))}</span>
      ${CHEV}
    </button>
    <div class="jd-bcr-body" role="region" aria-label="${esc(g.question || g.slug)}"><div class="jd-bcr-in bn-in">
      <section class="jd-bcx"><span class="jd-bcx-k">评测器找到的问题</span>${probs}</section>
      <section class="jd-bcx is-side"><span class="jd-bcx-k">轨迹</span>
        <div class="bn-kinds">${[...kinds].map(([k, n]) => `<span><b class="num">${fmt(n)}</b>${esc(KIND[k] || k)}</span>`).join("")}</div>
        ${g.slug ? `<button type="button" class="jd-go bn-open" data-open="${esc(g.slug)}">完整轨迹${GO}</button>` : ""}
      </section>
    </div></div>
  </div>`;
}

function paint(root) {
  const { goldens, J } = root._bn;
  const needle = F.q.toLowerCase();
  const hit = (text) => !needle || String(text || "").toLowerCase().includes(needle);
  const golden = goldens
    .filter((g) => (!F.sev || g.problems.some((p) => p.sev === F.sev)) && (hit(g.question) || g.problems.some((p) => hit(p.label))))
    .map((g, i) => goldenRow(g, i));
  const bad = J.badcases
    .filter((b) => (!F.sev || b.sev === F.sev) && (hit(b.q) || hit(b.label)))
    .map((b, i) => badcaseRow(J, b, i, F.open.has(`b-${b.id}`))
      .replace(`data-bc="${b.id}"`, `data-bn="b-${esc(b.id)}"`)
      .replaceAll(`bc-${b.id}"`, `bn-bc-${b.id}"`));
  const rows = F.kind === "golden" ? golden : F.kind === "bad" ? bad : [...golden, ...bad];
  const seg = [["", "全部", goldens.length + J.badcases.length], ["golden", "Golden case", goldens.length], ["bad", "Badcase", J.badcases.length]]
    .map(([k, name, n]) => `<button type="button" data-kind="${k}" aria-pressed="${F.kind === k}">${name}<small class="num">${fmt(n)}</small></button>`).join("");
  const sevs = SEV.map((s) => `<button type="button" class="bn-sev" data-sev="${s}" aria-pressed="${F.sev === s}" style="--c:${sevColor(s)}"><i></i>${s}</button>`).join("");
  $("#bnTools", root).innerHTML = `<div class="jd-bc-seg" role="group" aria-label="类别">${seg}</div><div class="bn-sevs" role="group" aria-label="等级">${sevs}</div>`;
  $("#bnCount", root).textContent = `${fmt(rows.length)} 条`;
  $("#bnList", root).innerHTML = rows.join("") || `<div class="empty">没有符合条件的 case</div>`;
}

export async function render(root, c) {
  const d = c.data;
  const key = `${c.product}|${d.generated_at}`;
  if (shown === key && root.firstChild) return;
  shown = key;
  const J = d.judge?.[c.product] || judgeMock(c.product, d.taxonomy);
  root._bn = { goldens: goldensOf(d, c.product), J, nav: c.navigate, product: c.product };
  root.innerHTML = `<div class="bento bn">
    <article class="card" style="--span:12">
      <header class="card-head"><h2>Bench</h2>${J.mock ? `<span class="jd-mock" title="Badcase 用的是示例数据，Golden case 是真实样本">Badcase 为示例数据</span>` : ""}
        <div class="jd-bc-tools" id="bnTools"></div>
        <input class="search bn-q" id="bnQ" type="search" placeholder="搜索问题或现象" autocomplete="off" value="${esc(F.q)}">
        <span class="meta num" id="bnCount"></span></header>
      <div class="jd-bcl" id="bnList"></div>
    </article>
  </div>`;
  paint(root);
  if (root._bnWired) return;
  root._bnWired = true;
  let timer;
  root.addEventListener("input", (e) => {
    if (e.target.id !== "bnQ") return;
    clearTimeout(timer);
    timer = setTimeout(() => { F.q = e.target.value.trim(); paint(root); }, 140);
  });
  root.addEventListener("click", (e) => {
    const kind = e.target.closest("[data-kind]");
    if (kind) { F.kind = kind.dataset.kind; return paint(root); }
    const sev = e.target.closest("[data-sev]");
    if (sev) { F.sev = F.sev === sev.dataset.sev ? "" : sev.dataset.sev; return paint(root); }
    const go = e.target.closest("[data-open]");
    if (go) {
      const { nav, product } = root._bn;
      nav?.({ view: "samples", product, case: go.dataset.open, p: null, w: null, trace: null });
      return;
    }
    const head = e.target.closest(".jd-bcr-head");
    if (!head) return;
    const row = head.closest("[data-bn]");
    const id = row.dataset.bn;
    const open = !F.open.has(id);
    if (open) F.open.add(id); else F.open.delete(id);
    row.classList.toggle("is-open", open);
    head.setAttribute("aria-expanded", String(open));
  });
}
