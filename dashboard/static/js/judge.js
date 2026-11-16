/* 评测评测: how far the evaluator itself can be trusted. Six readings of one judge version against
   human re-labels and its own repeated runs: agreement, calibration, repeatability, per-stage error,
   bias, and agreement over time. Reads data.json's judge[<p>]; until that feed exists it shows the
   clearly marked mock from judge_mock.js. */
import { esc, fmt, sevColor, SEV_NAME, bindTips, counter, runCounters } from "./core.js";
import { createKlineChart } from "./kline_chart.js";
import { judgeMock } from "./judge_mock.js";

let shown = null;
let kline = null;
const tips = new Map();
const tip = (html) => {
  const k = `j${tips.size}`;
  tips.set(k, html);
  return `data-tip="1" data-k="${k}"`;
};
const row = (label, value) => `<div class="t-row"><span>${esc(label)}</span><b class="num">${value}</b></div>`;
const pc = (v, d = 0) => `${fmt(100 * v, d)}%`;
const signed = (v, d = 2) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${fmt(Math.abs(v), d)}`;
const sevName = (k) => SEV_NAME[k] || k;
const chip = (k) => `<span class="jd-sev" style="--c:${sevColor(k)}"><i></i>${esc(sevName(k))}</span>`;

/* ---------------------------------------------------------------- headline */
const KPIS = [
  ["kappa", "人工一致 κ", (v) => fmt(v, 2), 2, 1],
  ["precision", "精确率", (v) => pc(v), 0, 100],
  ["recall", "召回率", (v) => pc(v), 0, 100],
  ["ece", "校准误差", (v) => fmt(v, 3), 3, 1, true],
  ["repeat", "重复一致", (v) => pc(v), 0, 100],
  ["evidence", "证据可回链", (v) => pc(v), 0, 100],
];
function headline(J) {
  const tiles = KPIS.map(([key, name, show, d, scale, lowerBetter], i) => {
    const v = J.kpi[key];
    const prev = J.kpiPrev?.[key];
    const delta = prev == null ? null : v - prev;
    const good = delta == null ? null : lowerBetter ? delta < 0 : delta > 0;
    const shownDelta = delta == null ? "" : scale === 100 ? `${signed(delta * 100, 1)}pt` : signed(delta, d);
    return `<div class="jd-kpi" style="--i:${i}" ${tip(`<div class="t-head">${esc(name)}</div>${row(J.version, show(v))}${prev == null ? "" : row(J.prev, show(prev))}`)}>
      <span class="jd-kpi-n">${esc(name)}</span>
      <b class="mid">${counter(v * scale, { d: scale === 100 ? 0 : d, suffix: scale === 100 ? "%" : "" })}</b>
      ${delta == null ? "" : `<span class="jd-delta${good ? " is-good" : " is-bad"}">${delta > 0 ? "▲" : "▼"} ${shownDelta}</span>`}
    </div>`;
  }).join("");
  return `<article class="card jd-head" style="--span:12">
    <header class="card-head"><h2>评测评测</h2>${J.mock ? `<span class="jd-mock" title="judge_mock.js">示例数据</span>` : ""}
      <span class="meta end num">${esc(J.version)} · ${fmt(J.labeled)} 条人工复标 · ${J.runs} 次重跑</span></header>
    <div class="jd-kpis">${tiles}</div>
  </article>`;
}

/* ---------------------------------------------------------------- agreement: human × judge */
function confusionCard(J) {
  const { labels, m } = J.confusion;
  const rowSum = m.map((r) => r.reduce((a, b) => a + b, 0));
  const head = `<span></span>${labels.map((k) => `<span class="jd-cm-h">${esc(sevName(k))}</span>`).join("")}`;
  const body = labels.map((h, i) => `<span class="jd-cm-r">${chip(h)}</span>${labels.map((j, k) => {
    const share = rowSum[i] ? m[i][k] / rowSum[i] : 0;
    const diag = i === k;
    return `<span class="jd-cm-c${diag ? " is-diag" : ""}" style="--a:${Math.round(8 + share * 82)}%;--i:${i + k}" ${tip(`<div class="t-head">人工 ${esc(sevName(h))} · 评测器 ${esc(sevName(j))}</div>${row("样本", fmt(m[i][k]))}${row("占该行", pc(share, 1))}`)}>${m[i][k] ? fmt(m[i][k]) : ""}</span>`;
  }).join("")}`).join("");
  const agree = labels.reduce((a, _, i) => a + m[i][i], 0) / rowSum.reduce((a, b) => a + b, 0);
  return `<article class="card" style="--span:5">
    <header class="card-head"><h2>一致性</h2><span class="meta end num">对角 ${pc(agree, 1)}</span></header>
    <div class="jd-cm"><span class="jd-cm-axis is-y">人工</span><span class="jd-cm-axis is-x">评测器</span>
      <div class="jd-cm-grid">${head}${body}</div></div>
  </article>`;
}

/* ---------------------------------------------------------------- calibration */
function calibrationCard(J) {
  const W = 300, H = 222, L = 30, R = 292, T = 8, B = 156, VT = 172, VB = 208;
  const x = (v) => L + (R - L) * v;
  const y = (v) => B - (B - T) * v;
  const bins = J.calibration;
  const nMax = Math.max(...bins.map((b) => b.n));
  const ece = bins.reduce((a, b) => a + b.n * Math.abs(b.hit - b.c), 0) / bins.reduce((a, b) => a + b.n, 0);
  const curve = bins.map((b) => `${x(b.c).toFixed(1)},${y(b.hit).toFixed(1)}`).join(" ");
  const gap = `${bins.map((b) => `${x(b.c).toFixed(1)},${y(b.c).toFixed(1)}`).join(" ")} ${bins.slice().reverse().map((b) => `${x(b.c).toFixed(1)},${y(b.hit).toFixed(1)}`).join(" ")}`;
  const bw = (R - L) / bins.length;
  const grid = [0, 0.5, 1].map((v) => `<line class="jd-grid" x1="${L}" x2="${R}" y1="${y(v)}" y2="${y(v)}"/><text class="jd-ax" x="${L - 6}" y="${y(v) + 3.5}" text-anchor="end">${pc(v)}</text>`).join("");
  const xt = [0, 0.5, 1].map((v) => `<text class="jd-ax" x="${x(v)}" y="${H - 2}" text-anchor="${v === 0 ? "start" : v === 1 ? "end" : "middle"}">${pc(v)}</text>`).join("");
  const vols = bins.map((b, i) => {
    const h = ((VB - VT) * b.n) / nMax;
    return `<rect class="jd-vol" x="${(L + i * bw + 1).toFixed(1)}" y="${(VB - h).toFixed(1)}" width="${(bw - 2).toFixed(1)}" height="${h.toFixed(1)}" rx="1.5" style="--i:${i}"/>`;
  }).join("");
  const dots = bins.map((b) => `<circle class="jd-dot" cx="${x(b.c).toFixed(1)}" cy="${y(b.hit).toFixed(1)}" r="3.5"/>`).join("");
  const hits = bins.map((b, i) => `<rect class="jd-hit" x="${(L + i * bw).toFixed(1)}" y="${T}" width="${bw.toFixed(1)}" height="${VB - T}" ${tip(`<div class="t-head">置信度 ${pc(b.c - 0.05)}–${pc(b.c + 0.05)}</div>${row("人工确认", pc(b.hit, 1))}${row("偏差", `${signed((b.hit - b.c) * 100, 1)}pt`)}${row("样本", fmt(b.n))}`)}/>`).join("");
  return `<article class="card" style="--span:4">
    <header class="card-head"><h2>校准</h2><span class="meta end num">ECE ${fmt(ece, 3)}</span></header>
    <svg class="jd-cal" viewBox="0 0 ${W} ${H}" role="img" aria-label="评测器置信度与人工确认率">
      ${grid}<line class="jd-ideal" x1="${x(0)}" y1="${y(0)}" x2="${x(1)}" y2="${y(1)}"/>
      <polygon class="jd-gap" points="${gap}"/><polyline class="jd-curve" points="${curve}"/>${dots}${vols}${xt}${hits}
    </svg>
  </article>`;
}

/* ---------------------------------------------------------------- repeatability */
const AGREE = ["5/5", "4/5", "3/5", "≤2/5"];
function stabilityCard(J) {
  const rows = J.stability.map((s, i) => `<div class="jd-st" style="--i:${i}" ${tip(`<div class="t-head">人工 ${esc(sevName(s.sev))} · ${fmt(s.n)} 条</div>${s.agree.map((v, k) => row(`${J.runs} 次中 ${AGREE[k]} 相同`, pc(v, 1))).join("")}`)}>
      ${chip(s.sev)}<span class="jd-st-bar">${s.agree.map((v, k) => `<i style="flex:${v} 1 0;--k:${k}"></i>`).join("")}</span><b class="num">${pc(s.agree[0])}</b></div>`).join("");
  return `<article class="card" style="--span:3">
    <header class="card-head"><h2>重复一致</h2><span class="meta end num">${J.runs} 次重跑</span></header>
    <div class="jd-sts">${rows}</div>
    <div class="jd-key">${AGREE.map((a, k) => `<span><i style="--k:${k}"></i>${a}</span>`).join("")}</div>
  </article>`;
}

/* ---------------------------------------------------------------- per-stage precision / recall */
function categoryCard(J) {
  const lo = Math.floor(Math.min(...J.categories.flatMap((c) => [c.precision, c.recall])) * 10) / 10;
  const span = 1 - lo;
  const at = (v) => `${(((v - lo) / span) * 100).toFixed(2)}%`;
  const f1 = (c) => (2 * c.precision * c.recall) / (c.precision + c.recall);
  const rows = J.categories.slice().sort((a, b) => f1(a) - f1(b)).map((c, i) => {
    const a = Math.min(c.precision, c.recall), b = Math.max(c.precision, c.recall);
    return `<div class="jd-db" style="--i:${i}" ${tip(`<div class="t-head">${esc(c.name)}</div>${row("精确率", pc(c.precision, 1))}${row("召回率", pc(c.recall, 1))}${row("F1", fmt(f1(c), 2))}${row("样本", fmt(c.n))}`)}>
      <span class="jd-db-n"><code>${esc(c.id)}</code>${esc(c.name)}</span>
      <span class="jd-db-t"><i class="jd-db-l" style="left:${at(a)};width:calc(${at(b)} - ${at(a)})"></i><i class="jd-db-p" style="left:${at(c.precision)}"></i><i class="jd-db-r" style="left:${at(c.recall)}"></i></span>
      <b class="num">${fmt(f1(c), 2)}</b></div>`;
  }).join("");
  const ticks = [lo, lo + span / 2, 1].map((v) => `<span style="left:${at(v)}">${pc(v)}</span>`).join("");
  return `<article class="card" style="--span:7">
    <header class="card-head"><h2>分环节误差</h2>
      <span class="jd-legend end"><span><i class="jd-db-p"></i>精确率</span><span><i class="jd-db-r"></i>召回率</span><span class="num">F1</span></span></header>
    <div class="jd-dbs">${rows}<div class="jd-db jd-db-axis"><span></span><span class="jd-db-t">${ticks}</span><span></span></div></div>
  </article>`;
}

/* ---------------------------------------------------------------- bias: severity shift by slice */
function biasCard(J) {
  const lim = Math.max(0.3, ...J.bias.map((b) => Math.max(Math.abs(b.lo), Math.abs(b.hi))));
  const at = (v) => `${(50 + (50 * v) / lim).toFixed(2)}%`;
  const rows = J.bias.slice().sort((a, b) => b.shift - a.shift).map((b, i) => {
    const from = Math.min(0, b.shift), to = Math.max(0, b.shift);
    return `<div class="jd-bi" style="--i:${i}" ${tip(`<div class="t-head">${esc(b.name)}</div>${row("评测器 − 人工", `${signed(b.shift)} 级`)}${row("95% 区间", `${signed(b.lo)} ~ ${signed(b.hi)}`)}${row("样本", fmt(b.n))}`)}>
      <span class="jd-bi-n">${esc(b.name)}</span>
      <span class="jd-bi-t"><i class="jd-bi-b${b.shift > 0 ? " is-pos" : " is-neg"}" style="left:${at(from)};width:calc(${at(to)} - ${at(from)})"></i><i class="jd-bi-ci" style="left:${at(b.lo)};width:calc(${at(b.hi)} - ${at(b.lo)})"></i></span>
      <b class="num">${signed(b.shift)}</b></div>`;
  }).join("");
  return `<article class="card" style="--span:5">
    <header class="card-head"><h2>定级偏差</h2></header>
    <div class="jd-bis">${rows}<div class="jd-bi jd-bi-axis"><span></span><span class="jd-bi-t"><span style="left:0">偏轻</span><span style="left:50%">0</span><span style="left:100%">偏重</span></span><span></span></div></div>
  </article>`;
}

/* ---------------------------------------------------------------- over time + disagreements */
function trendCard() {
  return `<article class="card" style="--span:8">
    <header class="card-head"><h2>一致性走势</h2></header>
    <div class="jd-trend" data-own-tip></div>
  </article>`;
}
function disagreeCard(J) {
  const rows = J.disagreements.map((d, i) => `<div class="jd-dis" style="--i:${i}" ${tip(`<div class="t-head">${esc(d.q)}</div>${row("人工", esc(sevName(d.human)))}${row("评测器", esc(sevName(d.judge)))}`)}>
      <span class="jd-dis-q">${esc(d.q)}</span><span class="jd-dis-v">${chip(d.human)}<i aria-hidden="true">→</i>${chip(d.judge)}</span><span class="jd-dis-k">${esc(d.kind)}</span></div>`).join("");
  return `<article class="card" style="--span:4">
    <header class="card-head"><h2>分歧样本</h2><span class="meta end num">${fmt(J.disagreements.length)}</span></header>
    <div class="jd-diss">${rows}</div>
  </article>`;
}

export async function render(root, c) {
  const d = c.data;
  const key = `${c.product}|${d.generated_at}`;
  if (shown === key && root.firstChild) return;
  shown = key;
  tips.clear();
  const J = d.judge?.[c.product] || judgeMock(c.product, d.taxonomy);
  root.innerHTML = `<div class="bento jd">
    ${headline(J)}${confusionCard(J)}${calibrationCard(J)}${stabilityCard(J)}${categoryCard(J)}${biasCard(J)}${trendCard()}${disagreeCard(J)}
  </div>`;
  if (!root._jdTips) {
    root._jdTips = true;
    bindTips(root, (t) => tips.get(t.dataset.k) || null);
  }
  runCounters(root);
  kline?.destroy();
  kline = createKlineChart(root.querySelector(".jd-trend"), {
    rows: J.trend, period: "day", height: 280, releases: J.releases || [],
    valueFormat: (v) => fmt(v, 2), volumeName: "人工复标", volumeLabel: "人工复标",
    openLabel: "前一日 κ", closeLabel: "κ",
  });
}
