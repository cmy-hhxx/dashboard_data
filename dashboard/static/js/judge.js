/* 评测评测: how far the evaluator itself can be trusted. Top to bottom: a second model's audit of
   every filed problem on three dimensions (定级合理 / 证据闭环 / 输出准确) and where by stage it
   fails; repeat consistency across reruns of one case; agreement with human re-labels; and the
   evaluator's badcases, each opening to the case, the evaluator's verdict and evidence, the audit
   model's ruling and the dimension it failed. Reads data.json's judge[<p>]; until that feed exists
   it shows the clearly marked mock from judge_mock.js. */
import { $, $$, esc, fmt, sevColor, SEV_NAME, bindTips, counter, runCounters } from "./core.js";
import { judgeMock } from "./judge_mock.js";

let shown = null;
const tips = new Map();
const tip = (html) => {
  const k = `j${tips.size}`;
  tips.set(k, html);
  return `data-tip="1" data-k="${k}"`;
};
const row = (label, value) => `<div class="t-row"><span>${esc(label)}</span><b class="num">${value}</b></div>`;
const pc = (v, d = 0) => `${fmt(100 * v, d)}%`;
const signed = (v, d = 1) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${fmt(Math.abs(v), d)}`;
const sevName = (k) => SEV_NAME[k] || k;
const chip = (k) => `<span class="jd-sev" style="--c:${sevColor(k)}"><i></i>${esc(sevName(k))}</span>`;
const delta = (now, prev, label) => {
  if (prev == null) return "";
  const d = (now - prev) * 100;
  return `<span class="jd-delta${d > 0 ? " is-good" : d < 0 ? " is-bad" : ""}" title="${esc(label)}">${d > 0 ? "▲" : d < 0 ? "▼" : "·"} ${signed(d)}pt</span>`;
};
// Pass rates tint by how far they fall short: 100% is the plain well, 55% and below is full tint.
const failTint = (rate) => `--a:${Math.round(4 + Math.max(0, Math.min(1, (1 - rate) / 0.45)) * 60)}%`;

/* Badcase filter: one dimension plus an optional severity or stage, set from anywhere on the page. */
const B = { dim: "", sev: "", stage: "", open: new Set() };
const DIM_ORDER = ["grade", "evidence", "output"];
const ICON = {
  ok: `<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  no: `<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4.5 4.5l7 7m0-7l-7 7" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>`,
  go: `<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M6 4l4 4-4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  chev: `<svg class="jd-bcr-chev" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 6l4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
};

/* ---------------------------------------------------------------- page head */
function topCard(J) {
  return `<article class="card jd-top" style="--span:12">
    <header class="card-head"><h2>评测评测</h2>${J.mock ? `<span class="jd-mock" title="这一页用的是示例数据，不是实测结果">示例数据</span>` : ""}
      <span class="meta end num">${esc(J.version)} 对比 ${esc(J.prev)} · ${fmt(J.audited)} 个问题复核 · ${J.runs} 次重跑 · ${fmt(J.labeled)} 条人工复标</span></header>
  </article>`;
}

/* ---------------------------------------------------------------- ① three dimensions */
function dimCard(J, d, i) {
  const bars = d.bySev.map((s, k) => `<button type="button" class="jd-sb" data-bc-dim="${d.key}" data-bc-sev="${s.sev}" style="--i:${k}" ${tip(`<div class="t-head">${esc(d.name)} · 评测器定为 ${esc(sevName(s.sev))}</div>${row("通过", pc(s.rate, 1))}${row("复核问题", fmt(s.n))}${row("未通过", fmt(Math.round(s.n * (1 - s.rate))))}`)}>
      ${chip(s.sev)}<span class="jd-sb-t"><i style="--w:${(s.rate * 100).toFixed(1)}%"></i></span><b class="num">${pc(s.rate)}</b></button>`).join("");
  const total = d.reasons.reduce((a, b) => a + b.n, 0) || 1;
  const reasons = d.reasons.map((x, k) => `<span class="jd-rs" style="--k:${k}" ${tip(`<div class="t-head">${esc(x.name)}</div>${row("未通过中占", pc(x.n / total, 1))}${row("问题", fmt(x.n))}`)}><i></i><em>${esc(x.name)}</em><b class="num">${pc(x.n / total)}</b></span>`).join("");
  const stack = d.reasons.map((x, k) => `<i style="flex:${x.n} 1 0;--k:${k}"></i>`).join("");
  const bad = J.badcases.filter((b) => b.fail === d.key).length;
  return `<article class="card jd-dim" style="--span:4;--i:${i}" data-dim="${d.key}">
    <header class="card-head"><h2>${esc(d.name)}</h2>
      <button type="button" class="jd-go end" data-bc-dim="${d.key}">${fmt(bad)} 个 badcase${ICON.go}</button></header>
    <div class="jd-dim-hero">
      <span class="jd-ring" style="--p:${(d.rate * 100).toFixed(1)}"><b class="mid">${counter(d.rate * 100, { d: 1, suffix: "%" })}</b></span>
      <div class="jd-dim-side">${delta(d.rate, d.prev, `上一版 ${J.prev} 是 ${pc(d.prev, 1)}`)}<span class="jd-dim-n num">${fmt(Math.round(d.n * (1 - d.rate)))} / ${fmt(d.n)} 未通过</span>
        <span class="jd-rstack">${stack}</span></div>
    </div>
    <div class="jd-sbs">${bars}</div>
    <div class="jd-rss">${reasons}</div>
  </article>`;
}

function stageCard(J) {
  const cols = J.stages;
  const head = `<span></span>${cols.map((s) => `<span class="jd-sg-h" title="${esc(s.name)}"><code>${esc(s.id)}</code>${esc(s.name)}</span>`).join("")}`;
  const body = J.dims.map((d) => `<span class="jd-sg-r">${esc(d.name)}</span>${cols.map((s, k) => {
    const v = s[d.key];
    return `<button type="button" class="jd-sg-c" data-bc-dim="${d.key}" data-bc-stage="${s.id}" style="${failTint(v)};--i:${k}" ${tip(`<div class="t-head">${esc(s.name)} · ${esc(d.name)}</div>${row("通过", pc(v, 1))}${row("复核问题", fmt(s.n))}${row("未通过", fmt(Math.round(s.n * (1 - v))))}`)}>${pc(v)}</button>`;
  }).join("")}`).join("");
  return `<article class="card jd-stage" style="--span:12">
    <div class="jd-sg" style="--cols:${cols.length}">${head}${body}</div>
  </article>`;
}

/* ---------------------------------------------------------------- ② repeat consistency */
const AGREE = (n) => [`${n}/${n}`, `${n - 1}/${n}`, `${n - 2}/${n}`, `≤${n - 3}/${n}`];
function repeatCard(J) {
  const R = J.repeat;
  const kpis = [["sameSev", "定级一致"], ["sameSet", "问题集一致"], ["sameEvidence", "证据一致"]].map(([k, name], i) => `<div class="jd-kpi" style="--i:${i}" ${tip(`<div class="t-head">${esc(name)}</div>${row(J.version, pc(R[k], 1))}${row(J.prev, pc(R.prev[k], 1))}`)}>
      <span class="jd-kpi-n">${esc(name)}</span><b class="mid">${counter(R[k] * 100, { d: 0, suffix: "%" })}</b>${delta(R[k], R.prev[k], `上一版 ${J.prev} 是 ${pc(R.prev[k], 1)}`)}</div>`).join("");
  const labels = AGREE(R.runs);
  const rows = R.bySev.map((s, i) => `<div class="jd-st" style="--i:${i}" ${tip(`<div class="t-head">${esc(sevName(s.sev))} · ${fmt(s.n)} 个 case</div>${s.agree.map((v, k) => row(`${labels[k]} 次定级相同`, pc(v, 1))).join("")}`)}>
      ${chip(s.sev)}<span class="jd-st-bar">${s.agree.map((v, k) => `<i style="flex:${v} 1 0;--k:${k}"></i>`).join("")}</span><b class="num">${pc(s.agree[0])}</b></div>`).join("");
  return `<article class="card jd-rep" style="--span:7">
    <header class="card-head"><h2>重复一致</h2><span class="meta end num">同一 case 重跑 ${R.runs} 次</span></header>
    <div class="jd-kpis is-3">${kpis}</div>
    <div class="jd-sts">${rows}</div>
    <div class="jd-key">${labels.map((a, k) => `<span><i style="--k:${k}"></i>${a}</span>`).join("")}</div>
  </article>`;
}

function overlapCard(J) {
  const bins = J.repeat.overlap;
  const max = Math.max(...bins.map((b) => b.n));
  const total = bins.reduce((a, b) => a + b.n, 0) || 1;
  const bars = bins.map((b, i) => `<span class="jd-hb${b.hi <= 0.5 ? " is-low" : ""}" style="--h:${((100 * b.n) / max).toFixed(1)}%;--i:${i}" ${tip(`<div class="t-head">问题集重合 ${pc(b.lo)}–${pc(b.hi)}</div>${row("case", fmt(b.n))}${row("占比", pc(b.n / total, 1))}`)}><i></i></span>`).join("");
  const low = bins.filter((b) => b.hi <= 0.5).reduce((a, b) => a + b.n, 0);
  return `<article class="card jd-ovl" style="--span:5">
    <header class="card-head"><h2>问题集重合</h2><span class="meta end num">低于 50% 的 case ${pc(low / total, 1)}</span></header>
    <div class="jd-hist">${bars}</div>
    <div class="jd-hist-x num"><span>0%</span><span>50%</span><span>100%</span></div>
  </article>`;
}

/* ---------------------------------------------------------------- ③ human agreement */
function confusionCard(J) {
  const { labels, m } = J.human.confusion;
  const rowSum = m.map((r) => r.reduce((a, b) => a + b, 0));
  const head = `<span></span>${labels.map((k) => `<span class="jd-cm-h">${esc(sevName(k))}</span>`).join("")}`;
  const body = labels.map((h, i) => `<span class="jd-cm-r">${chip(h)}</span>${labels.map((j, k) => {
    const share = rowSum[i] ? m[i][k] / rowSum[i] : 0;
    return `<span class="jd-cm-c${i === k ? " is-diag" : ""}" style="--a:${Math.round(8 + share * 82)}%;--i:${i + k}" ${tip(`<div class="t-head">人工 ${esc(sevName(h))} · 评测器 ${esc(sevName(j))}</div>${row("样本", fmt(m[i][k]))}${row("占该行", pc(share, 1))}`)}>${m[i][k] ? fmt(m[i][k]) : ""}</span>`;
  }).join("")}`).join("");
  const agree = labels.reduce((a, _, i) => a + m[i][i], 0) / (rowSum.reduce((a, b) => a + b, 0) || 1);
  return `<article class="card" style="--span:7">
    <header class="card-head"><h2>人工一致</h2>
      <span class="meta end num" title="人工与评测器定级的一致程度，1 为完全一致，0 相当于随机">一致系数 κ ${fmt(J.human.kappa, 2)}</span>${delta(J.human.kappa, J.human.prev, `上一版 ${J.prev} 是 ${fmt(J.human.prev, 2)}`)}<span class="meta num">对角 ${pc(agree, 1)}</span></header>
    <div class="jd-cm"><span class="jd-cm-axis is-y">人工</span><span class="jd-cm-axis is-x">评测器</span>
      <div class="jd-cm-grid">${head}${body}</div></div>
  </article>`;
}

function sevPrCard(J) {
  const at = (v) => `${(v * 100).toFixed(2)}%`;
  const rows = J.human.bySev.map((c, i) => {
    const a = Math.min(c.precision, c.recall), b = Math.max(c.precision, c.recall);
    return `<div class="jd-db" style="--i:${i}" ${tip(`<div class="t-head">${esc(sevName(c.sev))}</div>${row("精确率", pc(c.precision, 1))}${row("召回率", pc(c.recall, 1))}${row("人工样本", fmt(c.n))}`)}>
      <span class="jd-db-n">${chip(c.sev)}</span>
      <span class="jd-db-t"><i class="jd-db-l" style="left:${at(a)};width:calc(${at(b)} - ${at(a)})"></i><i class="jd-db-p" style="left:${at(c.precision)}"></i><i class="jd-db-r" style="left:${at(c.recall)}"></i></span>
      <b class="num">${pc((2 * c.precision * c.recall) / (c.precision + c.recall || 1))}</b></div>`;
  }).join("");
  const ticks = [0, 0.5, 1].map((v) => `<span style="left:${at(v)}">${pc(v)}</span>`).join("");
  return `<article class="card jd-pr" style="--span:5">
    <header class="card-head"><h2>分级对齐</h2>
      <span class="jd-legend end"><span><i class="jd-db-p"></i>精确率</span><span><i class="jd-db-r"></i>召回率</span><span class="num" title="精确率和召回率的综合分">综合</span></span></header>
    <div class="jd-dbs">${rows}<div class="jd-db jd-db-axis"><span></span><span class="jd-db-t">${ticks}</span><span></span></div></div>
  </article>`;
}

/* ---------------------------------------------------------------- ④ badcases */
function badcaseCard() {
  return `<article class="card jd-bc" style="--span:12" id="jdBadcases">
    <header class="card-head"><h2>评测器 badcase</h2><div class="jd-bc-tools" id="jdBcTools"></div><span class="meta end num" id="jdBcCount"></span></header>
    <div class="jd-bcl" id="jdBcList"></div>
  </article>`;
}

function bcTools(J) {
  const n = (key) => J.badcases.filter((b) => !key || b.fail === key).length;
  const seg = [["", "全部"], ...J.dims.map((d) => [d.key, d.name])].map(([k, name]) =>
    `<button type="button" data-bc-dim="${k}" data-bc-reset aria-pressed="${B.dim === k}">${esc(name)}<small class="num">${fmt(n(k))}</small></button>`).join("");
  const stage = B.stage && J.stages.find((s) => s.id === B.stage);
  const tokens = [
    B.sev ? `<button type="button" class="jd-tok" data-bc-clear="sev" aria-label="取消等级筛选">${chip(B.sev)}<i aria-hidden="true">×</i></button>` : "",
    stage ? `<button type="button" class="jd-tok" data-bc-clear="stage" aria-label="取消环节筛选"><code>${esc(stage.id)}</code>${esc(stage.name)}<i aria-hidden="true">×</i></button>` : "",
  ].join("");
  return `<div class="jd-bc-seg" role="group" aria-label="未通过维度">${seg}</div>${tokens}`;
}

function bcRow(J, b, i) {
  const dim = J.dims.find((d) => d.key === b.fail);
  const open = B.open.has(b.id);
  const ev = b.evidence.map((e) => `<li class="${e.ok ? "" : "is-bad"}"><span class="num">#${e.m}</span><q>${esc(e.quote)}</q>${e.ok ? "" : `<i class="jd-x">${ICON.no}</i>`}</li>`).join("");
  const verdicts = DIM_ORDER.map((k) => {
    const d = J.dims.find((x) => x.key === k);
    const v = b.verdict[k];
    return `<div class="jd-vd${v.ok ? " is-ok" : " is-fail"}"><span class="jd-vd-i">${v.ok ? ICON.ok : ICON.no}</span><b>${esc(d ? d.name : k)}</b>${v.ok ? "" : `<p>${esc(v.note)}</p>`}</div>`;
  }).join("");
  const runs = b.runs.map((s, k) => `<span class="jd-run${s === b.sev ? "" : " is-off"}" style="--c:${sevColor(s)}" title="第 ${k + 1} 次 · ${esc(sevName(s))}">${esc(s)}</span>`).join("");
  const same = b.runs.filter((s) => s === b.sev).length;
  return `<div class="jd-bcr${open ? " is-open" : ""}" style="--i:${i}" data-bc="${b.id}">
    <button type="button" class="jd-bcr-head" aria-expanded="${open}" aria-controls="bc-${b.id}">
      <span class="jd-bcr-dim" data-fail="${b.fail}">${esc(dim ? dim.name : b.fail)}</span>
      ${chip(b.sev)}
      <span class="jd-bcr-q"><b>${esc(b.label)}</b><span>${esc(b.q)}</span></span>
      <span class="jd-bcr-st"><code>${esc(b.stage)}</code>${esc(b.stageName)}</span>
      <span class="jd-bcr-m num">${esc(b.model)} · ${esc(b.date.slice(5))}</span>
      ${ICON.chev}
    </button>
    <div class="jd-bcr-body" id="bc-${b.id}" role="region" aria-label="${esc(b.label)}"><div class="jd-bcr-in">
      <section class="jd-bcx is-eval"><span class="jd-bcx-k">评测器</span>
        <div class="jd-bcx-q">${esc(b.q)}</div>
        <div class="jd-bcx-top">${chip(b.sev)}<b>${esc(b.label)}</b><span class="jd-bcx-st"><code>${esc(b.stage)}</code>${esc(b.stageName)}</span></div>
        <ol class="jd-ev">${ev}</ol></section>
      <section class="jd-bcx is-audit"><span class="jd-bcx-k">判定模型</span>${verdicts}
        ${b.suggest ? `<div class="jd-sug">${chip(b.sev)}<i aria-hidden="true">→</i>${chip(b.suggest)}</div>` : ""}</section>
      <section class="jd-bcx is-side"><span class="jd-bcx-k">重跑 <b class="num">${same}/${b.runs.length}</b></span><div class="jd-runs">${runs}</div>
        <span class="jd-bcx-k">人工</span><div class="jd-human">${chip(b.human)}${b.human === b.sev ? "" : `<i class="jd-x">${ICON.no}</i>`}</div></section>
    </div></div>
  </div>`;
}

function paintBadcases(root, J) {
  const list = J.badcases.filter((b) => (!B.dim || b.fail === B.dim) && (!B.sev || b.sev === B.sev) && (!B.stage || b.stage === B.stage));
  $("#jdBcTools", root).innerHTML = bcTools(J);
  $("#jdBcCount", root).textContent = `${fmt(list.length)} / ${fmt(J.badcases.length)}`;
  $("#jdBcList", root).innerHTML = list.length
    ? list.map((b, i) => bcRow(J, b, i)).join("")
    : `<div class="empty">没有符合条件的 badcase<br><button type="button" class="link" data-bc-dim="" data-bc-reset>查看全部</button></div>`;
  $$(".jd-dim", root).forEach((el) => el.classList.toggle("is-picked", el.dataset.dim === B.dim));
}

/* Every reading drills into the cases behind it: a dimension card, a severity bar or a stage cell
   narrows the badcase list and scrolls to it; the list's own segments reset the narrowing. */
function wire(root) {
  root.addEventListener("click", (e) => {
    const J = root._jd;
    if (!J) return;
    const head = e.target.closest(".jd-bcr-head");
    if (head) {
      const r = head.closest(".jd-bcr");
      const open = !B.open.has(r.dataset.bc);
      if (open) B.open.add(r.dataset.bc); else B.open.delete(r.dataset.bc);
      r.classList.toggle("is-open", open);
      head.setAttribute("aria-expanded", String(open));
      return;
    }
    const clear = e.target.closest("[data-bc-clear]");
    if (clear) {
      B[clear.dataset.bcClear] = "";
      paintBadcases(root, J);
      return;
    }
    const pick = e.target.closest("[data-bc-dim]");
    if (!pick) return;
    const inList = !!pick.closest("#jdBadcases");
    B.dim = pick.dataset.bcDim;
    if (pick.hasAttribute("data-bc-reset") || !inList) {
      B.sev = pick.dataset.bcSev || "";
      B.stage = pick.dataset.bcStage || "";
    }
    paintBadcases(root, J);
    if (!inList) $("#jdBadcases", root).scrollIntoView({ behavior: "smooth", block: "start" });
  });
}

export async function render(root, c) {
  const d = c.data;
  const key = `${c.product}|${d.generated_at}`;
  if (shown === key && root.firstChild) return;
  shown = key;
  tips.clear();
  B.dim = ""; B.sev = ""; B.stage = ""; B.open.clear();
  const J = d.judge?.[c.product] || judgeMock(c.product, d.taxonomy);
  root._jd = J;
  root.innerHTML = `<div class="bento jd">
    ${topCard(J)}${J.dims.map((x, i) => dimCard(J, x, i)).join("")}${stageCard(J)}
    ${repeatCard(J)}${overlapCard(J)}
    ${confusionCard(J)}${sevPrCard(J)}
    ${badcaseCard()}
  </div>`;
  paintBadcases(root, J);
  if (!root._jdWired) {
    root._jdWired = true;
    bindTips(root, (t) => tips.get(t.dataset.k) || null);
    wire(root);
  }
  runCounters(root);
}
