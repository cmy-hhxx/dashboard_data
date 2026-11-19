/* 评测体系: end-to-end architecture (inputs → compact → attribution → 2D clustering),
   clustering methodology & cell specification drilldown (?view=system&cell=...),
   evidence closure golden traces, and attribution timeline. */
import {
  $, $$, esc, fmt, SEV, sevColor, KIND, getJSON,
  bindTips, hideTip, copyBtnHTML, wireCopy, REDUCED,
} from "./core.js";
import { threadFlow } from "./particles.js";
import { openTheater } from "./evidence_theater.js";
import { buildPage } from "./builder.js";
import { timelineCardHTML, wireTimeline } from "./system_timeline.js";

let shown = null;

const ROLE = { planning: "规划", request_generation: "请求生成", tool: "工具执行", script: "脚本执行", skill: "技能装载", delivery: "交付" };

const E = { product: null, goldens: [], raw: [], index: 0, obs: null, flow: null, details: new Map(), theater: new Map() };

function compactAnatomy(a) {
  if (!a || a.empty || !(a.messages || []).length || a.messages.length <= 22) return a;
  const keep = new Set([0, a.messages.length - 1]);
  (a.problems || []).forEach((p) => (p.msgs || []).forEach((i) => [i - 1, i, i + 1].forEach((j) => {
    if (j >= 0 && j < a.messages.length) keep.add(j);
  })));
  const idx = [...keep].sort((x, y) => x - y);
  return {
    ...a,
    messages: idx.map((i) => ({ ...a.messages[i], i })),
    problems: (a.problems || []).map((p) => ({ ...p, msgs: (p.msgs || []).filter((i) => keep.has(i)) })),
    total: a.messages.length,
    shown: idx.length,
  };
}

function clearEffects(root) {
  clearInterval(E.fxTimer);
  E.fxTimer = null;
  if (E.fxT) E.fxT.forEach(clearTimeout);
  E.fxT = new Set();
  if (E.fxObs) { E.fxObs.disconnect(); E.fxObs = null; }
  if (E.obs) { E.obs.disconnect(); E.obs = null; }
  if (E.flow) { E.flow.destroy(); E.flow = null; }
  root?._builder?.destroy();
  if (root) root._builder = null;
  root?._specTocObs?.disconnect();
  if (root) root._specTocObs = null;
}

export async function render(root, c) {
  const d = c.data;
  const cellParam = (new URLSearchParams(location.search).get("cell") || "").trim();
  const key = `${c.product}|${d.generated_at}|${cellParam}`;
  if (shown === key && root.firstChild) return;
  shown = key;
  clearEffects(root);
  E.details.clear();
  E.theater.clear();

  const prods = Object.values(d.products || {});
  if (!prods.length) {
    root.innerHTML = `<div class="bento"><div class="card" style="--span:12"><div class="empty">暂无评测数据。</div></div></div>`;
    return;
  }

  E.nav = c.navigate || null;
  E.tax = d.taxonomy;
  const pd = d.products && d.products[c.product];

  if (cellParam && d.taxonomy) {
    renderCellSpec(root, d.taxonomy, pd, cellParam, c);
    return;
  }

  const src = d.system && d.system.goldens;
  let picked = [];
  if (Array.isArray(src)) picked = src;
  else if (src) picked = src[c.product] || [];
  if (E.product !== c.product) E.index = 0;
  E.product = c.product;
  E.raw = (Array.isArray(picked) ? picked : picked ? [picked] : []).filter((g) => g && (g.messages || []).length && (g.problems || []).length);
  E.goldens = (Array.isArray(picked) ? picked : picked ? [picked] : []).map(compactAnatomy);
  if (E.index >= E.goldens.length) E.index = 0;

  root.innerHTML = `<div class="bento">
    ${flowCard(d.taxonomy, pd)}
    ${goldenCard(E.goldens, E.index)}
    ${timelineCardHTML()}
  </div>`;
  if (!root._sysTips) {
    root._sysTips = true;
    bindTips(root);
  }
  wireGoldens(root);
  wireAnatomy(root, E.goldens[E.index]);
  wireFx(root, d.taxonomy);
  wireTimeline(root);
  // The page builds itself under a dozen cursors on the first visit of the session; afterwards it
  // simply appears, and the player in the corner can replay the build on request.
  buildPage(root, { key: "sys", targets: buildTargets(root) });
}

/* What the cursors build, in reading order: each card's frame, then its blocks. */
function buildTargets(root) {
  return $$(".bento > .card", root).flatMap((card) => [
    { el: card, kind: "frame", label: "Card" },
    { el: $(".card-head h2", card), kind: "text", label: "Heading" },
    ...$$(".fx-col > .fx-label, .fx-box, .fx-hub, .fx-bridge, .fx-cl-how, .fx-g, .echo-bar, .anatomy .rail, .anatomy .aprobs", card)
      .map((el) => ({ el, kind: el.matches(".fx-label") ? "text" : el.matches(".fx-g, .fx-cl-how, .rail, .aprobs") ? "grid" : "block",
        label: el.matches(".fx-g") ? "Heatmap" : el.matches(".fx-cl-how") ? "Method" : el.matches(".fx-bridge") ? "Bridge" : el.matches(".rail") ? "Messages" : el.matches(".aprobs") ? "Problems" : el.matches(".fx-label") ? "Label" : el.matches(".fx-hub") ? "Hub" : "Block" })),
  ].filter((t) => t.el));
}

/* ---------------------------------------------------------------- 评测体系: unified 4-step architecture */
const FX_IN = [
  ["user", "用户提问", "原始问句与追问"],
  ["think", "模型思考", "推理、规划与自我修正"],
  ["call", "工具调用", "参数、返回与报错"],
  ["answer", "最终回答", "交给用户的结论"],
];
const FX_STEPS = [["规划", "var(--t0)"], ["推理", "var(--t2)"], ["执行", "var(--accent)"], ["报错", "var(--sev-1)"], ["反思", "var(--t2)"], ["关键数据", "var(--t1)"], ["产物", "var(--t1)"]];
const FX_OUT = [
  ["问题", "标签与现象", "只记能回到原文的问题", "var(--sev-1)"],
  ["定级", "P0 最重 → P4 最轻", "按对用户的影响", "var(--sev-0)"],
  ["证据", "原文引用 → 消息位置", "逐字回链原文", "var(--accent)"],
  ["归属", "组件与环节角色", "交给聚类归入模式", "var(--t1)"],
];
const taxoNum = (a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1));
const patNum = (id) => id.split(".").map((x) => Number(x.replace(/\D/g, "")) || 0);
const l3 = (tax) => Object.entries((tax && tax.patterns) || {}).filter(([id]) => id.split(".").length === 3);
const l4 = (tax) => Object.entries((tax && tax.patterns) || {}).filter(([id]) => id.split(".").length === 4);

export function flowCard(tax, pd) {
  const ticks = Array.from({ length: 60 }, (_, k) => {
    const c = k % 9 === 0 ? FX_STEPS[(k / 9) % FX_STEPS.length][1] : "";
    const a = (k * Math.PI) / 30;
    const r0 = c ? 63 : 67;
    const [x0, y0, x1, y1] = [Math.cos(a) * r0, Math.sin(a) * r0, Math.cos(a) * 74, Math.sin(a) * 74].map((v) => v.toFixed(1));
    return `<line x1="${x0}" y1="${y0}" x2="${x1}" y2="${y1}"${c ? ` class="c" style="--c:${c}"` : ""}/>`;
  }).join("");
  const tiles = [2, 9, 0, 9, 2, 9, 9, 4, 9].map((v) => `<i style="--c:${v < 5 ? `var(--sev-${v})` : "var(--sev-none)"}"></i>`).join("");
  const ins = FX_IN.map(([k, t, sub]) =>
    `<div class="fx-box fx-in k-${k}" title="${sub}"><i class="fx-dot"></i><span class="fx-txt"><b>${t}</b></span></div>`).join("");
  const outs = FX_OUT.map(([t, sub, rule, c], i) => {
    const label = i === 1 ? `<span class="fx-sub">${sub}</span>` : "";
    const ico = i === 1
      ? `<span class="fx-ico is-sev">${SEV.map((_, k) => `<i style="--c:${sevColor(k)};--k:${k}"></i>`).join("")}</span>`
      : `<span class="fx-ico"><i></i></span>`;
    return `<div class="fx-box fx-out" style="--c:${c}" title="${sub} · ${rule}">${ico}<span class="fx-txt"><b>${t}</b>${label}</span></div>`;
  }).join("");

  const clHow = `<div class="fx-cl-how">
    <div class="fx-how-step">
      <div class="fx-how-top"><span class="num">01</span><b>纵轴 · 定位发生环节（L1）</b></div>
      <p>先按归因认定的责任组件，把每条问题落到「规划 → 请求 → 执行 → 交付」四阶段下的具体环节，明确问题出在链路哪一步。</p>
    </div>
    <div class="fx-how-step">
      <div class="fx-how-top"><span class="num">02</span><b>横轴 · 判定失效机制（L2）</b></div>
      <p>再按共性错误机理横向切分（如空转未执行、目标错配、计算算错、无依据断言），区分同一环节下的不同错因。</p>
    </div>
    <div class="fx-how-step">
      <div class="fx-how-top"><span class="num">03</span><b>格内 · 沉淀标准模式（L3 / L4）</b></div>
      <p>同一格内的相似问题经语义聚类形成带纳入与排除边界的标准模式；未命中任何模式的单条问题保持「未聚类」，绝不强行塞入「其他」。</p>
    </div>
  </div>`;

  const taxBody = tax
    ? `<div class="fx-cl">${taxGrid(tax, pd)}</div>`
    : `<div class="empty">聚类矩阵待接入（需提供 cluster_tree.json）</div>`;

  return `<article class="card" style="--span:12">
    <header class="card-head"><h2>评测体系</h2></header>
    <div class="fx-diagram" id="fxDiagram">
      <svg class="fx-wires" aria-hidden="true"></svg>
      <div class="fx" id="fx">
        <div class="fx-col"><div class="fx-label"><span class="num">01</span>会话输入</div>${ins}</div>
        <div class="fx-col fx-mid"><div class="fx-label"><span class="num">02</span>Compact 压缩</div>
          <div class="fx-hubwrap">
            <div class="fx-hub"><span class="fx-orbit"><i></i></span><svg class="fx-ring" viewBox="-80 -80 160 160" aria-hidden="true">${ticks}</svg><span class="fx-core"><span>${tiles}</span></span></div>
          </div>
        </div>
        <div class="fx-col"><div class="fx-label"><span class="num">03</span>归因</div>${outs}</div>
      </div>
      <div class="fx-bridge">
        <div class="fx-junction" id="fxJunction">
          <span class="fx-j-dot" aria-hidden="true"></span>
          <b>归因问题进入二维聚类</b>
          <span>环节 × 机制 → 标准模式</span>
        </div>
      </div>
      <div class="fx-tax" id="fxTax">
        <div class="fx-label fx-tax-label"><span class="num">04</span>聚类体系</div>
        ${clHow}
        ${taxBody}
      </div>
    </div>
  </article>`;
}

/* The taxonomy is one grid: 环节 (rows, grouped by phase) × 机制 (columns), drawn as a heatmap.
   With a batch on hand a cell's number is how many problems were clustered into that pair;
   without one it is how many L3 patterns the pair defines. */
function cellCounts(tax, pd) {
  const pats = l3(tax);
  const byPattern = (sid, mid) => pats.filter(([id]) => id.startsWith(`${sid}.${mid}.`)).length;
  const mx = pd && pd.matrix;
  if (mx && Object.keys(mx).length) {
    return { unit: "问题", n: (sid, mid) => ((mx[sid] || {})[mid] || {}).n || 0, has: byPattern };
  }
  return { unit: "模式", n: byPattern, has: byPattern };
}

function taxGrid(tax, pd) {
  const stages = (tax.stages || []).slice().sort(taxoNum);
  const mechs = (tax.mechanisms || []).slice().sort(taxoNum);
  const cc = cellCounts(tax, pd);
  const n = (sid, mid) => cc.n(sid, mid);
  let max = 0;
  stages.forEach((st) => mechs.forEach((m) => { max = Math.max(max, n(st.id, m.id)); }));
  const heat = (v) => (max ? Math.sqrt(v / max) : 0).toFixed(3);
  const head = `<span class="fx-g-corner"></span><span></span>${mechs.map((m) =>
    `<button type="button" class="fx-g-col" data-m="${m.id}" data-tip="m" aria-label="${esc(`${m.id} ${m.name} 口径详解`)}"><code>${m.id}</code><span>${esc(m.name)}</span></button>`).join("")}`;
  const body = (tax.phases || []).map((ph) => {
    const list = stages.filter((st) => st.phase === ph.id);
    if (!list.length) return "";
    return list.map((st, i) => `${i === 0 ? `<span class="fx-g-ph" style="grid-row:span ${list.length}">${esc(ph.name)}</span>` : ""}<button type="button" class="fx-g-row" data-s="${st.id}" data-tip="s" aria-label="${esc(`${st.id} ${st.name} 口径详解`)}"><code>${st.id}</code><span>${esc(st.name)}</span></button>${mechs.map((m) => {
      const v = n(st.id, m.id);
      return v || cc.has(st.id, m.id)
        ? `<button type="button" class="fx-g-c${Number(heat(v)) > 0.62 ? " is-hot" : ""}" data-s="${st.id}" data-m="${m.id}" data-n="${v}" data-tip="c" style="--h:${heat(v)}" aria-label="${esc(`${st.id} ${st.name} × ${m.id} ${m.name}：${fmt(v)} 个${cc.unit}，查看口径详解`)}"><b class="num">${v ? fmt(v) : "·"}</b></button>`
        : `<span class="fx-g-c is-empty" data-s="${st.id}" data-m="${m.id}"></span>`;
    }).join("")}`).join("");
  }).join("");
  const meta = `<div class="fx-g-meta">
    <span class="fx-g-formula">编码读法：<code>S 环节</code> × <code>M 机制</code> → <code>S.M.n 模式</code></span>
    <span class="fx-g-ramp"><span>${cc.unit}数</span><b class="num">0</b><i></i><b class="num">${fmt(max)}</b></span>
  </div>`;
  return `<div class="fx-gw" data-unit="${cc.unit}">${meta}<div class="fx-g" style="--cols:${mechs.length}">${head}${body}</div></div>`;
}

function taxTip(tax, el) {
  const sid = el.dataset.s || null;
  const mid = el.dataset.m || null;
  const st = sid && tax.stages.find((x) => x.id === sid);
  const m = mid && tax.mechanisms.find((x) => x.id === mid);
  const coord = [sid, mid].filter(Boolean).join(".");
  const pats = l3(tax)
    .filter(([id]) => (!sid || id.startsWith(`${sid}.`)) && (!mid || id.split(".")[1] === mid))
    .sort((a, b) => { const pa = patNum(a[0]); const pb = patNum(b[0]); return pa[0] - pb[0] || pa[1] - pb[1] || pa[2] - pb[2]; });
  const name = [st && st.name, m && m.name].filter(Boolean).join(" × ");
  const unit = el.closest(".fx-gw")?.dataset.unit || "问题";
  const count = el.dataset.n != null && unit === "问题"
    ? `<div class="t-row">问题<b class="num">${fmt(Number(el.dataset.n))}</b></div>` : "";
  const MAX = 8;
  const list = pats.slice(0, MAX).map(([id, pt]) => `<div class="fx-tip-pat"><code>${id}</code><span>${esc(pt.name || id)}</span></div>`).join("");
  return `<div class="t-head">${coord ? `<code>${esc(coord)}</code> ` : ""}${esc(name)}</div>${count}<div class="t-row">模式<b class="num">${pats.length}</b></div>${list ? `<div class="fx-tip-pats">${list}${pats.length > MAX ? `<div class="fx-tip-more">… 另 ${pats.length - MAX} 个</div>` : ""}</div>` : ""}`;
}

/* ---------------------------------------------------------------- 聚类口径详解 (?view=system&cell=...) */
export function parseCellParam(tax, raw) {
  const parts = String(raw || "").trim().toUpperCase().split(".");
  let st = null;
  let mech = null;
  for (const p of parts) {
    if (!st && /^S\d+$/.test(p)) st = (tax.stages || []).find((x) => x.id === p) || null;
    else if (!mech && /^M\d+$/.test(p)) mech = (tax.mechanisms || []).find((x) => x.id === p) || null;
  }
  return { st, mech, code: [st && st.id, mech && mech.id].filter(Boolean).join(".") };
}

function phaseNameOf(tax, phaseId) {
  return ((tax.phases || []).find((p) => p.id === phaseId) || {}).name || phaseId || "—";
}

function matchingPatterns(tax, sid, mid) {
  const sortPat = (a, b) => {
    const pa = patNum(a[0]);
    const pb = patNum(b[0]);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
    }
    return 0;
  };
  const hits = (id) => (!sid || id.startsWith(`${sid}.`)) && (!mid || id.split(".")[1] === mid);
  const top = l3(tax).filter(([id]) => hits(id)).sort(sortPat);
  const children = l4(tax).filter(([id]) => hits(id)).sort(sortPat);
  const byParent = new Map();
  children.forEach(([id, pt]) => {
    const p3 = id.split(".").slice(0, 3).join(".");
    if (!byParent.has(p3)) byParent.set(p3, []);
    byParent.get(p3).push([id, pt]);
  });
  return { top, children, byParent };
}

function batchCountOf(pd, sid, mid) {
  const mx = pd && pd.matrix;
  if (!mx || !Object.keys(mx).length) return null;
  let total = 0;
  Object.entries(mx).forEach(([s, mechs]) => {
    if (sid && s !== sid) return;
    Object.entries(mechs || {}).forEach(([m, info]) => {
      if (mid && m !== mid) return;
      total += info?.n || 0;
    });
  });
  return total;
}

export function cellSpecHTML(tax, pd, cellParam, product = "aime") {
  const { st, mech, code } = parseCellParam(tax, cellParam);
  if (!st && !mech) {
    return `<div class="doc-shell sys-spec">
      <aside class="doc-side">
        <div class="dc-side-head"><button type="button" class="dc-back" data-sys-back><svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M10 3.5 5.5 8l4.5 4.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>返回评测体系</button></div>
        <div class="doc-side-title">聚类口径详解</div>
      </aside>
      <div class="doc-main">
        <header class="doc-hero"><h1>未找到对应的聚类口径</h1><p class="doc-lead">参数 <code>${esc(cellParam)}</code> 未匹配到已知环节或机制，请返回评测体系矩阵重新选择。</p></header>
      </div>
    </div>`;
  }

  const sid = st && st.id;
  const mid = mech && mech.id;
  const { top, children, byParent } = matchingPatterns(tax, sid, mid);
  const batchCount = batchCountOf(pd, sid, mid);
  const l2Node = sid && mid ? (tax.l2 || {})[`${sid}.${mid}`] : null;
  const tagMap = new Map((tax.tags || []).map((t) => [t.id || t.name, t]));
  const stagesSorted = (tax.stages || []).slice().sort(taxoNum);
  const mechsSorted = (tax.mechanisms || []).slice().sort(taxoNum);

  const title = st && mech
    ? `${st.id} ${st.name} × ${mech.id} ${mech.name}`
    : st ? `${st.id} ${st.name}` : `${mech.id} ${mech.name}`;
  const sideTitle = code ? `${code} 口径详解` : "聚类口径详解";
  const phaseLabel = st ? `所属阶段：${phaseNameOf(tax, st.phase)}` : "跨环节失效机制";
  const lead = st && mech
    ? `${phaseLabel}。当问题归属在「${st.name}」且失效表现为「${mech.name}」时，进入坐标格 ${code}，当前定义 ${top.length} 个标准 L3 模式${children.length ? `与 ${children.length} 个 L4 子模式` : ""}。`
    : st
      ? `${phaseLabel}。汇总「${st.name}」下跨全部失效机制的 ${top.length} 个标准 L3 模式${children.length ? `与 ${children.length} 个 L4 子模式` : ""}。`
      : `汇总失效机制「${mech.name}」在全部环节下的 ${top.length} 个标准 L3 模式${children.length ? `与 ${children.length} 个 L4 子模式` : ""}。`;

  // Sibling navigation list in left rail
  const sibItems = st
    ? mechsSorted.map((m) => {
        const count = l3(tax).filter(([id]) => id.startsWith(`${st.id}.${m.id}.`)).length;
        if (!count && m.id !== mid) return "";
        const target = `${st.id}.${m.id}`;
        const active = mech && m.id === mech.id;
        return `<button type="button" class="sys-sib" data-cell="${esc(target)}" aria-current="${active ? "true" : "false"}"><code>${esc(target)}</code><span>${esc(m.name)}</span><b class="num">${count}</b></button>`;
      }).filter(Boolean).join("")
    : stagesSorted.map((s) => {
        const count = l3(tax).filter(([id]) => id.startsWith(`${s.id}.${mech.id}.`)).length;
        if (!count) return "";
        const target = `${s.id}.${mech.id}`;
        return `<button type="button" class="sys-sib" data-cell="${esc(target)}" aria-current="false"><code>${esc(target)}</code><span>${esc(s.name)}</span><b class="num">${count}</b></button>`;
      }).filter(Boolean).join("");

  const stageSection = st
    ? `<div class="sys-def-card">
        <div class="sys-def-head"><code>${esc(st.id)}</code><h3>${esc(st.name)}</h3><span class="sys-phase-tag">${esc(phaseNameOf(tax, st.phase))}阶段</span></div>
        <p>${esc(st.def || "暂无环节定义。")}</p>
        ${(st.components || []).length ? `<div class="sys-comp-row"><span class="sys-k">责任组件</span><div class="sys-chips">${st.components.map((cp) => `<code>${esc(cp)}</code>`).join("")}</div></div>` : ""}
      </div>`
    : `<div class="sys-axis-grid">${stagesSorted.map((s) => {
        const cnt = l3(tax).filter(([id]) => id.startsWith(`${s.id}.${mech.id}.`)).length;
        if (!cnt) return "";
        return `<button type="button" class="sys-axis-card" data-cell="${esc(`${s.id}.${mech.id}`)}">
          <div class="sys-axis-top"><code>${esc(s.id)}</code><b>${esc(s.name)}</b><span class="num">${cnt} 个模式</span></div>
          <p>${esc(s.def || phaseNameOf(tax, s.phase))}</p>
        </button>`;
      }).filter(Boolean).join("")}</div>`;

  const mechSection = mech
    ? `<div class="sys-def-card">
        <div class="sys-def-head"><code>${esc(mech.id)}</code><h3>${esc(mech.name)}</h3></div>
        <p>${esc(mech.def || "暂无机制定义。")}</p>
        ${l2Node && l2Node.def ? `<div class="sys-l2-cross"><span class="sys-k">${esc(`${st.id}.${mech.id}`)} 交叉口径定义</span><p>${esc(l2Node.def)}</p></div>` : ""}
      </div>`
    : `<div class="sys-axis-grid">${mechsSorted.map((m) => {
        const cnt = l3(tax).filter(([id]) => id.startsWith(`${st.id}.${m.id}.`)).length;
        if (!cnt) return "";
        const l2 = (tax.l2 || {})[`${st.id}.${m.id}`];
        return `<button type="button" class="sys-axis-card" data-cell="${esc(`${st.id}.${m.id}`)}">
          <div class="sys-axis-top"><code>${esc(`${st.id}.${m.id}`)}</code><b>${esc(m.name)}</b><span class="num">${cnt} 个模式</span></div>
          <p>${esc((l2 && l2.def) || m.def || "")}</p>
        </button>`;
      }).filter(Boolean).join("")}</div>`;

  const patternCards = top.map(([pid, pt]) => {
    const subs = byParent.get(pid) || [];
    const tags = (pt.tags || []).map((t) => {
      const info = tagMap.get(t);
      const tip = info && info.def ? ` title="${esc(info.def)}"` : "";
      return `<span class="sys-tag"${tip}>${esc(t)}</span>`;
    }).join("");
    const l4HTML = subs.length
      ? `<div class="sys-l4-list">${subs.map(([l4id, l4pt]) => `<div class="sys-l4-item">
          <div class="sys-l4-head"><code>${esc(l4id)}</code><b>${esc(l4pt.name || l4id)}</b></div>
          ${l4pt.plain ? `<p class="sys-pat-plain">${esc(l4pt.plain)}</p>` : ""}
          ${l4pt.def ? `<p>${esc(l4pt.def)}</p>` : ""}
          ${l4pt.include || l4pt.exclude ? `<div class="sys-bounds">
            <div><span>纳入边界</span><p>${esc(l4pt.include || "—")}</p></div>
            <div><span>排除边界</span><p>${esc(l4pt.exclude || "—")}</p></div>
          </div>` : ""}
        </div>`).join("")}</div>`
      : "";
    return `<article class="sys-pat-card" data-pat="${esc(pid)}">
      <header class="sys-pat-head">
        <code>${esc(pid)}</code>
        <h3>${esc(pt.name || pid)}</h3>
        ${copyBtnHTML("复制模式", { fn: "patSpec" })}
      </header>
      ${pt.plain ? `<p class="sys-pat-plain">${esc(pt.plain)}</p>` : ""}
      ${pt.def ? `<div class="sys-pat-def"><span class="sys-k">正式定义</span><p>${esc(pt.def)}</p></div>` : ""}
      ${pt.include || pt.exclude ? `<div class="sys-bounds">
        <div><span>纳入边界（Include）</span><p>${esc(pt.include || "—")}</p></div>
        <div><span>排除边界（Exclude）</span><p>${esc(pt.exclude || "—")}</p></div>
      </div>` : ""}
      ${tags ? `<div class="sys-tags">${tags}</div>` : ""}
      ${l4HTML}
    </article>`;
  }).join("") || `<div class="empty">该坐标格尚未定义标准模式。</div>`;

  return `<div class="doc-shell sys-spec" data-product="${esc(product)}">
    <aside class="doc-side">
      <div class="dc-side-head">
        <button type="button" class="dc-back" data-sys-back><svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M10 3.5 5.5 8l4.5 4.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>返回评测体系</button>
      </div>
      <div class="doc-side-title">${esc(sideTitle)}</div>
      <nav class="doc-toc" id="sysSpecToc" aria-label="口径章节">
        <a href="#spec-stage"><span class="num">01</span><span>环节口径</span></a>
        <a href="#spec-mech"><span class="num">02</span><span>机制口径</span></a>
        <a href="#spec-patterns"><span class="num">03</span><span>模式口径</span></a>
        <a href="#spec-rules"><span class="num">04</span><span>归类规则</span></a>
      </nav>
      ${sibItems ? `<div class="sys-sibs-wrap"><div class="sys-sibs-title">${st ? `${esc(st.id)} 下其余机制` : `${esc(mech.id)} 下各环节`}</div><div class="sys-sibs">${sibItems}</div></div>` : ""}
    </aside>

    <div class="doc-main">
      <header class="doc-hero">
        <div class="doc-hero-top">
          <h1>${esc(title)}</h1>
          <div class="sys-spec-actions">
            ${copyBtnHTML("复制口径", { fn: "cellSpec" })}
            <button type="button" class="sys-jump-btn" data-open-samples="${esc(sid || "")}|${esc(mid || "")}">查看真实样本 →</button>
          </div>
        </div>
        <p class="doc-lead">${esc(lead)}</p>
        <div class="doc-kpis">
          <div class="doc-kpi"><b class="num">${esc(code)}</b><span>坐标编码</span></div>
          <div class="doc-kpi"><b class="num">${fmt(top.length)}</b><span>L3 标准模式${children.length ? `（含 ${fmt(children.length)} 个 L4 子模式）` : ""}</span></div>
          <div class="doc-kpi"><b class="num">${batchCount != null ? fmt(batchCount) : "—"}</b><span>${batchCount != null ? "当前批次归入问题数" : "暂无批次问题统计"}</span></div>
        </div>
      </header>

      <section class="doc-sec" id="spec-stage" aria-label="环节口径">
        <div class="doc-sec-head"><span class="doc-idx num">01</span><h2>纵轴 · 发生环节口径（L1）</h2></div>
        ${stageSection}
      </section>

      <section class="doc-sec" id="spec-mech" aria-label="机制口径">
        <div class="doc-sec-head"><span class="doc-idx num">02</span><h2>横轴 · 失效机制口径（L2）</h2></div>
        ${mechSection}
      </section>

      <section class="doc-sec" id="spec-patterns" aria-label="标准模式口径">
        <div class="doc-sec-head"><span class="doc-idx num">03</span><h2>格内 · 标准模式口径清单（L3 / L4）</h2></div>
        <p class="doc-lead">每条模式同时给出通俗说明、正式定义与纳入/排除硬边界，用于判别问题是否归入该编码。</p>
        <div class="sys-pats">${patternCards}</div>
      </section>

      <section class="doc-sec" id="spec-rules" aria-label="归类判定规则">
        <div class="doc-sec-head"><span class="doc-idx num">04</span><h2>归类判定规则</h2></div>
        <div class="sys-rule-list">
          <div class="sys-rule-item"><span class="num">01</span><div><b>先按责任组件定纵轴（L1）</b><p>归因阶段为每条问题标定环节角色与责任组件，唯一映射到规划、请求、执行、交付四阶段下的一个环节。</p></div></div>
          <div class="sys-rule-item"><span class="num">02</span><div><b>再按失效机理定横轴（L2）</b><p>结合问题现象、原始证据与推导推理，判定其对应的共性失效机制（如空转未执行、目标错配、加工计算错误），锁定二维坐标格。</p></div></div>
          <div class="sys-rule-item"><span class="num">03</span><div><b>严格按纳入/排除边界落入模式</b><p>只有同时满足模式的纳入边界且不触犯排除边界时才赋予定型编码；新问题或边缘案例保持「未聚类（code = null）」，绝不强行归入「其他」。</p></div></div>
        </div>
      </section>
    </div>
  </div>`;
}

function renderCellSpec(root, tax, pd, cellParam, c) {
  root.innerHTML = cellSpecHTML(tax, pd, cellParam, c.product);
  const { st, mech, code } = parseCellParam(tax, cellParam);
  const topPatterns = matchingPatterns(tax, st && st.id, mech && mech.id).top;

  wireCopy(root, {
    cellSpec() {
      const lines = [
        `${code}${st ? ` ${st.name}` : ""}${mech ? ` × ${mech.name}` : ""}`,
        st && st.def ? `L1 环节定义：${st.def}` : "",
        mech && mech.def ? `L2 机制定义：${mech.def}` : "",
        ...topPatterns.map(([id, pt]) => `${id} ${pt.name}：${pt.plain || pt.def || ""}`),
      ];
      return lines.filter(Boolean).join("\n");
    },
    patSpec(btn) {
      const card = btn.closest(".sys-pat-card");
      if (!card) return "";
      const pid = card.dataset.pat;
      const pt = (tax.patterns || {})[pid];
      if (!pt) return pid;
      return [
        `${pid} ${pt.name}`,
        pt.plain ? `说明：${pt.plain}` : "",
        pt.def ? `定义：${pt.def}` : "",
        pt.include ? `纳入：${pt.include}` : "",
        pt.exclude ? `排除：${pt.exclude}` : "",
      ].filter(Boolean).join("\n");
    },
  });

  const specEl = $(".sys-spec", root);
  specEl?.addEventListener("click", (e) => {
    if (e.target.closest("[data-sys-back]")) {
      E.nav?.({ view: "system", cell: null });
      return;
    }
    const cellBtn = e.target.closest("[data-cell]");
    if (cellBtn) {
      E.nav?.({ view: "system", cell: cellBtn.dataset.cell });
      return;
    }
    const jump = e.target.closest("[data-open-samples]");
    if (jump) {
      const [sid, mid] = jump.dataset.openSamples.split("|");
      E.nav?.({
        view: "samples", product: c.product, cell: null,
        stage: sid || null, mech: mid || null,
        p: null, q: null, w: null, split: null, model: null, scene: null, sub: null, pattern: null, date: null, case: null, trace: null,
      });
    }
  });

  // Wire smooth scroll + IntersectionObserver for spec TOC
  const nav = $("#sysSpecToc", root);
  if (nav) {
    const links = $$("a[href^='#']", nav);
    const targets = links.map((link) => {
      const id = (link.getAttribute("href") || "").slice(1);
      return { link, el: id ? document.getElementById(id) : null };
    }).filter((item) => item.el);
    const mark = (activeEl) => targets.forEach(({ link, el }) => {
      if (el === activeEl) link.setAttribute("aria-current", "location");
      else link.removeAttribute("aria-current");
    });
    if (targets.length) mark(targets[0].el);
    nav.addEventListener("click", (e) => {
      const link = e.target.closest("a[href^='#']");
      if (!link) return;
      const target = document.getElementById(link.getAttribute("href").slice(1));
      if (!target) return;
      e.preventDefault();
      mark(target);
      target.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    if (typeof IntersectionObserver !== "undefined" && targets.length) {
      const visible = new Set();
      const obs = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) visible.add(entry.target);
          else visible.delete(entry.target);
        });
        const top = targets.find((t) => visible.has(t.el));
        if (top) mark(top.el);
      }, { rootMargin: "-72px 0px -65% 0px", threshold: 0 });
      targets.forEach((t) => obs.observe(t.el));
      root._specTocObs = obs;
    }
  }
  window.scrollTo(0, 0);
}

/* ---------------------------------------------------------------- evidence closure */
const ICON_PREV = `<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M10 4L6 8l4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const ICON_NEXT = `<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M6 4l4 4-4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

function goldenCard(cases, index) {
  const a = cases[index];
  const worst = a && (a.problems || []).map((p) => p.sev).sort((x, y) => SEV.indexOf(x) - SEV.indexOf(y))[0];
  const player = cases.length
    ? `<div class="echo-bar"><div class="echo-tabs" id="eTabs" role="group" aria-label="切换案例">
        <button type="button" class="echo-step" data-step="-1" aria-label="上一个案例"${cases.length <= 1 ? " hidden" : ""}>${ICON_PREV}</button>
        <span class="echo-now" id="eNow" title="${esc((a && a.question) || "")}"><i style="--c:${sevColor(worst)}"></i><b>${esc((a && (a.question || a.slug)) || "—")}</b></span>
        <span class="echo-idx num" id="eIdx"${cases.length <= 1 ? " hidden" : ""}>${index + 1} / ${cases.length}</span>
        <button type="button" class="echo-step" data-step="1" aria-label="下一个案例"${cases.length <= 1 ? " hidden" : ""}>${ICON_NEXT}</button>
        <span class="echo-dots" role="tablist">${cases.length > 1 ? cases.map((g, i) => {
          const w = (g.problems || []).map((p) => p.sev).sort((x, y) => SEV.indexOf(x) - SEV.indexOf(y))[0];
          return `<button type="button" role="tab" data-i="${i}" aria-selected="${i === index}" style="--c:${sevColor(w)}" title="${esc(g.question || g.slug)}" aria-label="${esc(`案例 ${i + 1}：${g.question || g.slug}`)}"></button>`;
        }).join("") : ""}</span>
      </div></div>`
    : "";
  return `<article class="card" style="--span:12">
    <header class="card-head"><h2>证据闭环</h2></header>
    ${player}
    ${a ? `<div class="echo"><div class="echo-main"><div id="anatomyBody">${anatomyBody(a)}</div></div></div>` : `<div class="empty">暂无 golden Trace。</div>`}
  </article>`;
}

function anatomyBody(a) {
  if (!a || a.empty || !(a.messages || []).length || !(a.problems || []).length) {
    return `<div class="empty">该样本没有可定位的证据</div>`;
  }
  const msgs = a.messages
    .map((m, i) => {
      const idx = m.i == null ? i : m.i;
      const hit = a.problems.some((p) => (p.msgs || []).includes(idx));
      const more = m.full && m.full !== m.text;
      return `<div class="rail-msg k-${m.k}${hit ? " hit" : ""}${more ? " has-more" : ""}" data-m="${idx}"${more ? ' role="button" tabindex="0" aria-expanded="false"' : ""}><span class="kind k-${m.k}">${KIND[m.k] || m.k}<span class="faint num">${idx}</span></span><span class="text">${esc(m.name ? `${m.name} · ` : "")}${esc(m.text)}</span>${more ? `<span class="full">${esc(m.full)}</span>` : ""}</div>`;
    })
    .join("");
  const probs = a.problems
    .slice()
    .sort((x, y) => SEV.indexOf(x.sev) - SEV.indexOf(y.sev))
    .map((p) => `<div class="aprob" data-p="${p.id}" style="--c:${sevColor(p.sev)}" role="button" tabindex="0" aria-haspopup="dialog" aria-label="${esc(`${p.sev} ${p.label}：全屏逐步查看证据`)}">
        <div class="aprob-top"><span class="sev-badge">${p.sev}</span><span>${esc(roleName(p.role))}</span>${p.path ? `<span class="mono faint">${esc(p.path)}</span>` : ""}<span class="aprob-n">逐步推导<i aria-hidden="true"></i></span></div>
        <div class="t">${esc(p.label)}</div><div class="s">${esc(p.comp || "")}${(p.msgs || []).length ? ` · ${p.msgs.map((m) => `#${m}`).join(" ")}` : ""}</div></div>`)
    .join("");
  return `<div class="anatomy${a.messages.length >= 12 ? " is-fill" : ""}">
    <div class="rail">${msgs}</div>
    <div class="threads"><svg aria-hidden="true"></svg></div>
    <div class="aprobs${a.problems.length >= 4 ? " is-spread" : ""}">${probs}</div>
  </div>`;
}

const roleName = (r) => ROLE[r] || r || "—";

function showCase(root) {
  const a = E.goldens[E.index];
  const body = $("#anatomyBody", root);
  if (!a || !body) return;
  body.innerHTML = anatomyBody(a);
  body.scrollTop = 0;
  wireAnatomy(root, a);
  const worst = (a.problems || []).map((p) => p.sev).sort((x, y) => SEV.indexOf(x) - SEV.indexOf(y))[0];
  const now = $("#eNow", root);
  if (now) {
    now.title = a.question || "";
    now.innerHTML = `<i style="--c:${sevColor(worst)}"></i><b>${esc(a.question || a.slug)}</b>`;
  }
  const idx = $("#eIdx", root);
  if (idx) idx.textContent = `${E.index + 1} / ${E.goldens.length}`;
  $$("#eTabs [data-i]", root).forEach((t) => t.setAttribute("aria-selected", String(Number(t.dataset.i) === E.index)));
}

/* The full-screen walk-through; it reads the uncompacted case (every message) and pulls the case's
   full detail for the phenomenon, the reasoning and the grading reason. */
function theater(from, problem) {
  const g = E.goldens[E.index];
  const index = Math.max(0, E.raw.findIndex((x) => x.slug === (g && g.slug)));
  openTheater({
    cases: E.raw, index, problem, product: E.product, tax: E.tax, nav: E.nav, from, details: E.theater,
    fetch: (slug) => getJSON(`samples/${slug}.json`, { retries: 1 }).catch(() => null),
  });
}

function wireGoldens(root) {
  $("#eTabs", root)?.addEventListener("click", (e) => {
    const step = e.target.closest("[data-step]");
    if (step && E.goldens.length > 1) {
      E.index = (E.index + Number(step.dataset.step) + E.goldens.length) % E.goldens.length;
      showCase(root);
      return;
    }
    const t = e.target.closest("[data-i]");
    if (!t || Number(t.dataset.i) === E.index) return;
    E.index = Number(t.dataset.i);
    showCase(root);
  });
}

function wireAnatomy(root, a) {
  if (E.obs) {
    E.obs.disconnect();
    E.obs = null;
  }
  const box = $("#anatomyBody .anatomy", root);
  if (!box || !a || a.empty) return;
  const draw = () => {
    const svg = $(".threads svg", box);
    if (!svg) return;
    const host = svg.getBoundingClientRect();
    if (!host.width) return;
    let paths = "";
    $$(".aprob", box).forEach((pb) => {
      const pid = pb.dataset.p;
      const pr = pb.getBoundingClientRect();
      const y2 = pr.top + 22 - host.top;
      const prob = a.problems.find((x) => String(x.id) === pid);
      if (!prob) return;
      (prob.msgs || []).forEach((mi) => {
        const m = $(`.rail-msg[data-m="${mi}"]`, box);
        if (!m) return;
        const r = m.getBoundingClientRect();
        const y1 = r.top + Math.min(r.height / 2, 14) - host.top;
        const w = host.width;
        paths += `<path data-p="${pid}" pathLength="1" style="--c:${sevColor(prob.sev)}" d="M0 ${y1} C ${w * 0.55} ${y1}, ${w * 0.45} ${y2}, ${w} ${y2}"/>`;
      });
    });
    svg.innerHTML = paths;
    const on = box.querySelector(".aprob.on");
    if (on) $$(".threads path", box).forEach((p) => p.classList.toggle("on", p.dataset.p === on.dataset.p));
  };
  requestAnimationFrame(draw);
  E.obs = new ResizeObserver(() => requestAnimationFrame(draw));
  E.obs.observe(box);
  $$(".rail-msg, .aprob", box).forEach((el) => E.obs.observe(el));
  if (E.flow) E.flow.destroy();
  E.flow = threadFlow($(".threads svg", box));

  const focus = (pid) => {
    box.classList.toggle("is-focus", pid != null);
    const prob = pid != null && a.problems.find((x) => String(x.id) === pid);
    $$(".aprob", box).forEach((b) => b.classList.toggle("on", b.dataset.p === pid));
    $$(".threads path", box).forEach((p) => p.classList.toggle("on", p.dataset.p === pid));
    $$(".rail-msg", box).forEach((m) => m.classList.toggle("on", !!prob && (prob.msgs || []).includes(Number(m.dataset.m))));
  };
  box.addEventListener("pointerover", (e) => {
    const b = e.target.closest(".aprob");
    focus(b ? b.dataset.p : null);
  });
  box.addEventListener("pointerleave", () => focus(null));
  const toggle = (el) => {
    if (el.classList.contains("aprob")) {
      theater(el, el.dataset.p);
      return;
    }
    if (!el.classList.contains("has-more")) return;
    const open = !el.classList.contains("is-open");
    el.classList.toggle("is-open", open);
    el.setAttribute("aria-expanded", String(open));
  };
  box.addEventListener("click", (e) => {
    const el = e.target.closest(".aprob, .rail-msg");
    if (el) toggle(el);
  });
  box.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const el = e.target.closest(".aprob, .rail-msg");
    if (!el) return;
    e.preventDefault();
    toggle(el);
  });
}

/* ---------------------------------------------------------------- 聚类: hover highlight + click jump to 口径详解 */
function wireCluster(tx, tax) {
  bindTips(tx, (el) => (el.closest(".fx-g") ? taxTip(tax, el) : null));
  tx.addEventListener("pointerover", (e) => {
    tx._hovering = true;
    const c = e.target.closest(".fx-g-c:not(.is-empty)");
    $$(".fx-g-row", tx).forEach((x) => x.classList.toggle("is-hl", !!c && x.dataset.s === c.dataset.s));
    $$(".fx-g-col", tx).forEach((x) => x.classList.toggle("is-hl", !!c && x.dataset.m === c.dataset.m));
  });
  tx.addEventListener("pointerleave", () => {
    tx._hovering = false;
    $$(".is-hl", tx).forEach((x) => x.classList.remove("is-hl"));
  });
  tx.addEventListener("click", (e) => {
    const cell = e.target.closest(".fx-g-c:not(.is-empty)");
    if (cell) {
      hideTip();
      E.nav?.({ view: "system", cell: `${cell.dataset.s}.${cell.dataset.m}` });
      return;
    }
    const row = e.target.closest(".fx-g-row[data-s]");
    if (row) {
      hideTip();
      E.nav?.({ view: "system", cell: row.dataset.s });
      return;
    }
    const col = e.target.closest(".fx-g-col[data-m]");
    if (col) {
      hideTip();
      E.nav?.({ view: "system", cell: col.dataset.m });
    }
  });
}

/* ---------------------------------------------------------------- 评测体系 wiring: continuous wires & pulses */
function wireFx(root, tax) {
  clearInterval(E.fxTimer);
  if (E.fxT) E.fxT.forEach(clearTimeout);
  E.fxT = new Set();
  if (E.fxObs) E.fxObs.disconnect();

  const diagram = $("#fxDiagram", root);
  const box = $("#fx", root);
  if (!diagram || !box) return;
  const svg = $(".fx-wires", diagram);
  const hub = $(".fx-hub", box);
  const junction = $("#fxJunction", diagram);
  const tx = $("#fxTax", diagram);

  const draw = () => {
    const h = diagram.getBoundingClientRect();
    if (!h.width) return;
    const hr = hub.getBoundingClientRect();
    const cy = hr.top + hr.height / 2 - h.top;
    const curve = (x0, y0, x1, y1, id, cls) => {
      const xm = (x0 + x1) / 2;
      return `<path id="${id}" class="fx-w ${cls}" d="M${x0.toFixed(1)} ${y0.toFixed(1)}C${xm.toFixed(1)} ${y0.toFixed(1)} ${xm.toFixed(1)} ${y1.toFixed(1)} ${x1.toFixed(1)} ${y1.toFixed(1)}"/>`;
    };
    let d = "";
    $$(".fx-in", box).forEach((b, i) => {
      const r = b.getBoundingClientRect();
      d += curve(r.right - h.left, r.top + r.height / 2 - h.top, hr.left - h.left + 8, cy, `fw-i${i}`, "in");
    });
    const outs = $$(".fx-out", box);
    outs.forEach((b, i) => {
      const r = b.getBoundingClientRect();
      d += curve(hr.right - h.left - 8, cy, r.left - h.left, r.top + r.height / 2 - h.top, `fw-o${i}`, "out");
    });
    if (junction && outs.length >= 4) {
      const jr = junction.getBoundingClientRect();
      const jx = jr.left + jr.width / 2 - h.left;
      const jyBot = jr.bottom - h.top;
      const r3 = outs[3].getBoundingClientRect();
      const bx = r3.left + r3.width / 2 - h.left;
      const by = r3.bottom - h.top;
      const jRight = jr.right - h.left;
      const jyMid = jr.top + jr.height / 2 - h.top;
      const rad = Math.max(0, Math.min(18, jyMid - by, bx - jRight));
      d += `<path id="fw-b1" class="fx-w bridge" d="M${bx.toFixed(1)} ${by.toFixed(1)}L${bx.toFixed(1)} ${(jyMid - rad).toFixed(1)}Q${bx.toFixed(1)} ${jyMid.toFixed(1)} ${(bx - rad).toFixed(1)} ${jyMid.toFixed(1)}L${jRight.toFixed(1)} ${jyMid.toFixed(1)}"/>`;
      if (tx) {
        const tr = tx.getBoundingClientRect();
        d += `<path id="fw-t0" class="fx-w bridge" d="M${jx.toFixed(1)} ${jyBot.toFixed(1)}L${jx.toFixed(1)} ${(tr.top - h.top).toFixed(1)}"/>`;
      }
    }
    svg.setAttribute("viewBox", `0 0 ${h.width} ${h.height}`);
    svg.innerHTML = d;
  };
  draw();
  E.fxObs = new ResizeObserver(draw);
  E.fxObs.observe(diagram);

  if (tx && tax) wireCluster(tx, tax);
  if (REDUCED) return;

  const ins = $$(".fx-in", box);
  const outs = $$(".fx-out", box);
  const ring = $(".fx-ring", box);
  const tiles = $$(".fx-core i", box);
  const later = (fn, ms) => {
    const id = setTimeout(() => { E.fxT.delete(id); fn(); }, ms);
    E.fxT.add(id);
  };
  const restart = (el, cls) => { el.classList.remove(cls); void el.offsetWidth; el.classList.add(cls); };
  const shoot = (id, color, dur) => {
    const path = svg.querySelector(`#${id}`);
    if (!path) return;
    path.style.setProperty("--c", color);
    path.classList.add("on");
    const trail = [3.8, 2.8, 2, 1.3].map((r, k) =>
      `<circle class="fx-pulse" r="${r}" style="--c:${color};opacity:${(1 - k * 0.22).toFixed(2)}"><animateMotion dur="${(dur + k * 0.05).toFixed(2)}s" begin="indefinite" fill="freeze" calcMode="spline" keyTimes="0;1" keyPoints="0;1" keySplines="0.5 0 0.2 1"><mpath href="#${id}"/></animateMotion></circle>`).join("");
    svg.insertAdjacentHTML("beforeend", `<g>${trail}</g>`);
    const g = svg.lastElementChild;
    [...g.children].forEach((c) => c.firstElementChild.beginElement());
    later(() => { g.remove(); path.classList.remove("on"); }, dur * 1000 + 260);
  };
  let rot = 0;
  let step = -1;
  const receive = () => {
    rot += 40;
    ring.style.transform = `rotate(${rot}deg)`;
    restart(hub, "is-hit");
    hub.insertAdjacentHTML("beforeend", '<span class="fx-ripple"></span>');
    const rp = hub.lastElementChild;
    later(() => rp.remove(), 950);
    step = (step + 1) % FX_STEPS.length;
    const c = FX_STEPS[step][1];
    const lit = new Set([4]);
    while (lit.size < 3 + (step % 3)) lit.add(Math.floor(Math.random() * 9));
    tiles.forEach((t, k) => {
      t.style.setProperty("--c", lit.has(k) ? c : "var(--sev-none)");
      t.style.animationDelay = `${((k % 3) + Math.floor(k / 3)) * 35}ms`;
      restart(t, "pop");
    });
  };
  const land = (el) => {
    restart(el, "is-on");
    later(() => el.classList.remove("is-on"), 1100);
  };
  const pulseCell = (idx) => {
    if (!tx) return;
    const cells = $$(".fx-g-c:not(.is-empty)", tx);
    if (!cells.length) return;
    const cell = cells[idx % cells.length];
    cell.classList.add("is-pulse");
    const row = !tx._hovering && $(`.fx-g-row[data-s="${cell.dataset.s}"]`, tx);
    const col = !tx._hovering && $(`.fx-g-col[data-m="${cell.dataset.m}"]`, tx);
    if (row) row.classList.add("is-hl");
    if (col) col.classList.add("is-hl");
    later(() => {
      cell.classList.remove("is-pulse");
      if (!tx._hovering) {
        if (row) row.classList.remove("is-hl");
        if (col) col.classList.remove("is-hl");
      }
    }, 900);
  };
  let n = 0;
  const fire = (i, j) => {
    const seq = n;
    land(ins[i]);
    shoot(`fw-i${i}`, "var(--accent)", 0.75);
    later(receive, 720);
    const go = (jj, delay) => {
      later(() => shoot(`fw-o${jj}`, outs[jj].style.getPropertyValue("--c") || "var(--accent)", 0.8), delay);
      later(() => land(outs[jj]), delay + 760);
    };
    go(j, 860);
    if (i === 3) go((j + 2) % outs.length, 960);
    if (junction) {
      const bridgeStart = 1480;
      later(() => shoot("fw-b1", "var(--accent)", 0.45), bridgeStart);
      later(() => land(junction), bridgeStart + 420);
      later(() => shoot("fw-t0", "var(--accent)", 0.35), bridgeStart + 480);
      later(() => pulseCell(seq), bridgeStart + 820);
    }
  };
  const cycle = () => {
    if (!diagram.isConnected) {
      clearInterval(E.fxTimer);
      return;
    }
    if (!diagram.offsetParent || document.hidden) return;
    fire(n % ins.length, (n * 3 + 1) % outs.length);
    n++;
  };
  let lastHover = 0;
  ins.forEach((el, i) => el.addEventListener("pointerenter", () => {
    const now = performance.now();
    if (now - lastHover < 450) return;
    lastHover = now;
    fire(i, (i + 1) % outs.length);
  }));
  cycle();
  E.fxTimer = setInterval(cycle, 1600);
}
