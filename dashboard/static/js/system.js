/* 评测体系: one vertical slide. A conversation (01) pours into the compression hub (02), fans out into
   the four attribution outputs (03), then funnels into a Galton board whose pegs scatter every problem
   into one bin per failure mechanism — bins that sit exactly above the cluster matrix columns (04).
   A cell opens a centered explanation dialog instead of leaving the page.
   Below: evidence closure (golden traces) and the attribution timeline. */
import {
  $, $$, esc, fmt, SEV, sevColor, KIND, getJSON,
  bindTips, hideTip, copyText, flashCopy, REDUCED,
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
  E.fx?.destroy();
  E.fx = null;
  if (E.obs) { E.obs.disconnect(); E.obs = null; }
  if (E.flow) { E.flow.destroy(); E.flow = null; }
  root?._builder?.destroy();
  if (root) root._builder = null;
  closeCellModal(true);
}

export async function render(root, c) {
  const d = c.data;
  const key = `${c.product}|${d.generated_at}`;
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
  E.pd = d.products && d.products[c.product];

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
    ${flowCard(d.taxonomy, E.pd)}
    ${goldenCard(E.goldens, E.index)}
    ${timelineCardHTML()}
  </div>`;
  if (!root._sysTips) {
    root._sysTips = true;
    bindTips(root);
  }
  wireGoldens(root);
  wireAnatomy(root, E.goldens[E.index]);
  wireFx(root, d.taxonomy, E.pd);
  wireTimeline(root);
  buildPage(root, { key: "sys", targets: buildTargets(root) });
}

function buildTargets(root) {
  return $$(".bento > .card", root).flatMap((card) => [
    { el: card, kind: "frame", label: "Card" },
    { el: $(".card-head h2", card), kind: "text", label: "Heading" },
    ...$$(".fx-stage > .fx-label, .fx-box, .fx-hub, .fx-cl-how, .fx-board, .fx-g, .echo-bar, .anatomy .rail, .anatomy .aprobs", card)
      .map((el) => ({ el, kind: el.matches(".fx-label") ? "text" : el.matches(".fx-g, .fx-board, .fx-cl-how, .rail, .aprobs") ? "grid" : "block",
        label: el.matches(".fx-g") ? "Heatmap" : el.matches(".fx-board") ? "Board" : el.matches(".fx-cl-how") ? "Method" : el.matches(".rail") ? "Messages" : el.matches(".aprobs") ? "Problems" : el.matches(".fx-label") ? "Label" : el.matches(".fx-hub") ? "Hub" : "Block" })),
  ].filter((t) => t.el));
}

/* ---------------------------------------------------------------- the vertical slide */
const FX_IN = [["user", "用户提问"], ["think", "模型思考"], ["call", "工具调用"], ["answer", "最终回答"]];
const FX_STEPS = [["规划", "var(--t0)"], ["推理", "var(--t2)"], ["执行", "var(--accent)"], ["报错", "var(--sev-1)"], ["反思", "var(--t2)"], ["关键数据", "var(--t1)"], ["产物", "var(--t1)"]];
const FX_OUT = [
  ["问题", "哪里出了错，只记能回到原文的问题", "var(--sev-1)"],
  ["定级", "P0 最重，P4 最轻，按对用户的影响", "var(--sev-0)"],
  ["证据", "每条问题都逐字回链到原文", "var(--accent)"],
  ["归属", "出在哪一步、哪个组件", "var(--t1)"],
];
const taxoNum = (a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1));
const patNum = (id) => id.split(".").map((x) => Number(x.replace(/\D/g, "")) || 0);
const byPat = (a, b) => {
  const pa = patNum(a[0]);
  const pb = patNum(b[0]);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
};
const l3 = (tax) => Object.entries((tax && tax.patterns) || {}).filter(([id]) => id.split(".").length === 3);
const l4 = (tax) => Object.entries((tax && tax.patterns) || {}).filter(([id]) => id.split(".").length === 4);

/* Counts per cell: problems from the batch when there is one, else how many patterns the cell defines. */
function cellCounts(tax, pd) {
  const pats = l3(tax);
  const byPattern = (sid, mid) => pats.filter(([id]) => id.startsWith(`${sid}.${mid}.`)).length;
  const mx = pd && pd.matrix;
  if (mx && Object.keys(mx).length) {
    return { unit: "问题", n: (sid, mid) => ((mx[sid] || {})[mid] || {}).n || 0, has: byPattern };
  }
  return { unit: "模式", n: byPattern, has: byPattern };
}

function matrixModel(tax, pd) {
  const stages = (tax.stages || []).slice().sort(taxoNum);
  const mechs = (tax.mechanisms || []).slice().sort(taxoNum);
  const cc = cellCounts(tax, pd);
  let max = 0;
  const colTot = mechs.map((m) => stages.reduce((s, st) => {
    const v = cc.n(st.id, m.id);
    max = Math.max(max, v);
    return s + v;
  }, 0));
  return { stages, mechs, cc, max, colTot, maxCol: Math.max(1, ...colTot) };
}

export function flowCard(tax, pd) {
  const ticks = Array.from({ length: 60 }, (_, k) => {
    const c = k % 9 === 0 ? FX_STEPS[(k / 9) % FX_STEPS.length][1] : "";
    const a = (k * Math.PI) / 30;
    const r0 = c ? 63 : 67;
    const [x0, y0, x1, y1] = [Math.cos(a) * r0, Math.sin(a) * r0, Math.cos(a) * 74, Math.sin(a) * 74].map((v) => v.toFixed(1));
    return `<line x1="${x0}" y1="${y0}" x2="${x1}" y2="${y1}"${c ? ` class="c" style="--c:${c}"` : ""}/>`;
  }).join("");
  const tiles = [2, 9, 0, 9, 2, 9, 9, 4, 9].map((v) => `<i style="--c:${v < 5 ? `var(--sev-${v})` : "var(--sev-none)"}"></i>`).join("");
  const ins = FX_IN.map(([k, t], i) => `<div class="fx-box fx-in k-${k}" data-i="${i}"><i class="fx-dot"></i><b>${t}</b></div>`).join("");
  const outs = FX_OUT.map(([t, tip, c], i) => {
    const ico = i === 1
      ? `<span class="fx-ico is-sev">${SEV.map((_, k) => `<i style="--c:${sevColor(k)};--k:${k}"></i>`).join("")}</span>`
      : `<span class="fx-ico"><i></i></span>`;
    return `<div class="fx-box fx-out" data-o="${i}" style="--c:${c}" title="${tip}">${ico}<b>${t}</b></div>`;
  }).join("");

  const clHow = `<div class="fx-cl-how">
    <div class="fx-how-step"><div class="fx-how-top"><span class="num">01</span><b>先看出在哪一步</b></div>
      <p>按归因认定的责任组件，把问题落到「规划、请求、执行、交付」下的某个环节，这是矩阵的行。</p></div>
    <div class="fx-how-step"><div class="fx-how-top"><span class="num">02</span><b>再看错在哪种方式</b></div>
      <p>同一环节里，按错法再分一次，比如没去做、找错了对象、算错了、没依据就下结论，这是矩阵的列。</p></div>
    <div class="fx-how-step"><div class="fx-how-top"><span class="num">03</span><b>最后归进标准模式</b></div>
      <p>同一格里相似的问题合成一种标准模式，写清收什么、不收什么；对不上任何模式的问题保持「未聚类」。</p></div>
  </div>`;

  return `<article class="card fx-card" style="--span:12">
    <header class="card-head"><h2>评测体系</h2></header>
    <div class="fx-diagram" id="fxDiagram">
      <svg class="fx-wires" aria-hidden="true"></svg>
      <canvas class="fx-sparks" aria-hidden="true"></canvas>
      <section class="fx-stage"><div class="fx-label"><span class="num">01</span>一段对话</div><div class="fx-row">${ins}</div></section>
      <section class="fx-stage fx-mid"><div class="fx-label"><span class="num">02</span>压缩成要点</div>
        <div class="fx-hub"><span class="fx-orbit"><i></i></span><svg class="fx-ring" viewBox="-80 -80 160 160" aria-hidden="true">${ticks}</svg><span class="fx-core"><span>${tiles}</span></span></div>
      </section>
      <section class="fx-stage"><div class="fx-label"><span class="num">03</span>找出问题</div><div class="fx-row">${outs}</div></section>
      <section class="fx-stage fx-tax" id="fxTax">
        <div class="fx-label"><span class="num">04</span>落进分类</div>
        ${tax ? `${taxBoard(tax, pd)}${clHow}${taxGrid(tax, pd)}` : `${clHow}<div class="empty">聚类矩阵待接入</div>`}
      </section>
    </div>
  </article>`;
}

/* The Galton board: pegs are drawn into the shared SVG, bins share the matrix's column grid so every
   bin stands right above its own mechanism column. */
function taxBoard(tax, pd) {
  const { mechs, cc, colTot, maxCol } = matrixModel(tax, pd);
  return `<div class="fx-board" id="fxBoard" style="--cols:${mechs.length}">
    <div class="fx-pegs" id="fxPegs" aria-hidden="true"></div>
    <span class="fx-board-k">${cc.unit === "问题" ? "每种错法的问题数" : "每种错法的模式数"}</span>
    ${mechs.map((m, j) => `<div class="fx-bin" data-m="${m.id}" style="--v:${(colTot[j] / maxCol).toFixed(3)};--j:${j}"><b class="num">${fmt(colTot[j])}</b><i></i></div>`).join("")}
  </div>`;
}

function taxGrid(tax, pd) {
  const { stages, mechs, cc, max } = matrixModel(tax, pd);
  const heat = (v) => (max ? Math.sqrt(v / max) : 0).toFixed(3);
  const head = `<span class="fx-g-corner"></span><span></span>${mechs.map((m) =>
    `<button type="button" class="fx-g-col" data-m="${m.id}" data-tip="m" aria-label="${esc(`${m.name}：查看口径`)}"><code>${m.id}</code><span>${esc(m.name)}</span></button>`).join("")}`;
  const body = (tax.phases || []).map((ph) => {
    const list = stages.filter((st) => st.phase === ph.id);
    if (!list.length) return "";
    return list.map((st, i) => `${i === 0 ? `<span class="fx-g-ph" style="grid-row:span ${list.length}">${esc(ph.name)}</span>` : ""}<button type="button" class="fx-g-row" data-s="${st.id}" data-tip="s" aria-label="${esc(`${st.name}：查看口径`)}"><code>${st.id}</code><span>${esc(st.name)}</span></button>${mechs.map((m) => {
      const v = cc.n(st.id, m.id);
      return v || cc.has(st.id, m.id)
        ? `<button type="button" class="fx-g-c${Number(heat(v)) > 0.62 ? " is-hot" : ""}" data-s="${st.id}" data-m="${m.id}" data-n="${v}" data-tip="c" style="--h:${heat(v)}" aria-label="${esc(`${st.name} × ${m.name}：${fmt(v)} 个${cc.unit}，查看口径`)}"><b class="num">${v ? fmt(v) : "·"}</b></button>`
        : `<span class="fx-g-c is-empty" data-s="${st.id}" data-m="${m.id}"></span>`;
    }).join("")}`).join("");
  }).join("");
  return `<div class="fx-gw" data-unit="${cc.unit}"><div class="fx-g" style="--cols:${mechs.length}">${head}${body}</div></div>`;
}

function taxTip(tax, el) {
  const sid = el.dataset.s || null;
  const mid = el.dataset.m || null;
  const st = sid && tax.stages.find((x) => x.id === sid);
  const m = mid && tax.mechanisms.find((x) => x.id === mid);
  const pats = l3(tax).filter(([id]) => (!sid || id.startsWith(`${sid}.`)) && (!mid || id.split(".")[1] === mid));
  const name = [st && st.name, m && m.name].filter(Boolean).join(" × ");
  const unit = el.closest(".fx-gw")?.dataset.unit || "问题";
  const count = el.dataset.n != null && unit === "问题" ? `<div class="t-row">问题<b class="num">${fmt(Number(el.dataset.n))}</b></div>` : "";
  return `<div class="t-head">${esc(name)}</div>${count}<div class="t-row">标准模式<b class="num">${pats.length}</b></div>`;
}

/* ---------------------------------------------------------------- the centered explanation dialog */
function matchingPatterns(tax, sid, mid) {
  const hits = (id) => (!sid || id.startsWith(`${sid}.`)) && (!mid || id.split(".")[1] === mid);
  const top = l3(tax).filter(([id]) => hits(id)).sort(byPat);
  const byParent = new Map();
  l4(tax).filter(([id]) => hits(id)).sort(byPat).forEach(([id, pt]) => {
    const p3 = id.split(".").slice(0, 3).join(".");
    if (!byParent.has(p3)) byParent.set(p3, []);
    byParent.get(p3).push([id, pt]);
  });
  return { top, byParent };
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

const phaseName = (tax, id) => ((tax.phases || []).find((p) => p.id === id) || {}).name || "";
const ICON_X = '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
const ICON_L = '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M10 4L6 8l4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_R = '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M6 4l4 4-4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

/* Pure markup for one cell (S × M), one stage (S) or one mechanism (M); exported for tests. */
export function cellModalHTML(tax, pd, sid, mid, { pos = null } = {}) {
  const st = sid ? (tax.stages || []).find((x) => x.id === sid) : null;
  const m = mid ? (tax.mechanisms || []).find((x) => x.id === mid) : null;
  if (!st && !m) return `<div class="sm-body"><p class="sm-lead">没有找到这一格的口径。</p></div>`;
  const cc = cellCounts(tax, pd);
  const n = batchCountOf(pd, st && st.id, m && m.id);
  const { top, byParent } = matchingPatterns(tax, st && st.id, m && m.id);
  const title = st && m ? `${st.name} × ${m.name}` : (st || m).name;
  const coord = [st && st.id, m && m.id].filter(Boolean).map((c) => `<code>${esc(c)}</code>`).join('<i aria-hidden="true">×</i>');

  let lead;
  if (st && m) lead = `问题出在「${esc(st.name)}」这一步，错法属于「${esc(m.name)}」。${n != null ? `本批有 <b class="num">${fmt(n)}</b> 条问题落在这一格，` : ""}共归成 <b class="num">${top.length}</b> 种标准模式。`;
  else if (st) lead = `「${esc(st.name)}」属于${esc(phaseName(tax, st.phase))}阶段。下面是这一步可能出错的几种方式，选一格看它具体收哪些问题。`;
  else lead = `「${esc(m.name)}」这种错法会出现在下面几个环节，选一格看它具体收哪些问题。`;

  const axis = (k, name, def) => `<section class="sm-axis"><span class="sm-k">${k}</span><b>${esc(name)}</b>${def ? `<p>${esc(def)}</p>` : ""}</section>`;
  const l2 = st && m ? (tax.l2 || {})[`${st.id}.${m.id}`] : null;
  const axes = `<div class="sm-axes${st && m ? "" : " is-one"}">
    ${st ? axis("在哪一步出错", st.name, st.def) : ""}
    ${m ? axis("错在哪种方式", m.name, (l2 && l2.def) || m.def) : ""}
  </div>`;

  let body;
  if (st && m) {
    body = top.length ? `<section class="sm-sec"><h3>这一格收哪些问题</h3><ol class="sm-pats">${top.map(([pid, pt]) => {
      const subs = byParent.get(pid) || [];
      return `<li class="sm-pat">
        <div class="sm-pat-head"><code>${esc(pid)}</code><b>${esc(pt.name || pid)}</b></div>
        ${pt.plain || pt.def ? `<p>${esc(pt.plain || pt.def)}</p>` : ""}
        ${pt.include || pt.exclude ? `<div class="sm-bounds">
          <div><span>算进来</span><p>${esc(pt.include || "—")}</p></div>
          <div><span>不算进来</span><p>${esc(pt.exclude || "—")}</p></div>
        </div>` : ""}
        ${subs.length ? `<ul class="sm-subs">${subs.map(([id, sp]) => `<li><code>${esc(id)}</code><span>${esc(sp.name || id)}${sp.plain ? `：${esc(sp.plain)}` : ""}</span></li>`).join("")}</ul>` : ""}
      </li>`;
    }).join("")}</ol></section>` : `<section class="sm-sec"><p class="sm-lead">这一格还没有沉淀出标准模式。</p></section>`;
  } else {
    const others = st
      ? (tax.mechanisms || []).slice().sort(taxoNum).map((x) => ({ s: st.id, m: x.id, name: x.name }))
      : (tax.stages || []).slice().sort(taxoNum).map((x) => ({ s: x.id, m: m.id, name: x.name }));
    const cells = others
      .map((o) => ({ ...o, v: cc.n(o.s, o.m), has: cc.has(o.s, o.m) }))
      .filter((o) => o.v || o.has);
    body = `<section class="sm-sec"><h3>${st ? "这一步的几种错法" : "出现在这些环节"}</h3><div class="sm-cells">${cells.map((o) =>
      `<button type="button" class="sm-cell" data-cell="${o.s}.${o.m}"><code>${o.s}.${o.m}</code><span>${esc(o.name)}</span><b class="num">${fmt(o.v)}</b></button>`).join("") || '<p class="sm-lead">暂无。</p>'}</div></section>`;
  }

  const nav = pos ? `<div class="sm-nav">
      <button type="button" class="sm-icon" data-step="-1" aria-label="上一格"${pos.i <= 0 ? " disabled" : ""}>${ICON_L}</button>
      <span class="num">${pos.i + 1} / ${pos.n}</span>
      <button type="button" class="sm-icon" data-step="1" aria-label="下一格"${pos.i >= pos.n - 1 ? " disabled" : ""}>${ICON_R}</button>
    </div>` : "";

  return `<header class="sm-head">
      <div class="sm-coord">${coord}</div>
      <button type="button" class="sm-icon sm-close" data-close aria-label="关闭">${ICON_X}</button>
      <h2 id="smTitle">${esc(title)}</h2>
      <p class="sm-lead">${lead}</p>
    </header>
    <div class="sm-body">${axes}${body}</div>
    <footer class="sm-foot">
      ${nav}
      <span class="sm-spacer"></span>
      <button type="button" class="sm-btn" data-copy-spec>复制口径</button>
      <button type="button" class="sm-btn is-primary" data-samples="${esc(st ? st.id : "")}|${esc(m ? m.id : "")}">查看真实样本</button>
    </footer>`;
}

const MOD = { el: null, back: null, list: [], key: null };

function specText(tax, sid, mid) {
  const st = sid && tax.stages.find((x) => x.id === sid);
  const m = mid && tax.mechanisms.find((x) => x.id === mid);
  const { top } = matchingPatterns(tax, sid, mid);
  return [
    [st && `${st.id} ${st.name}`, m && `${m.id} ${m.name}`].filter(Boolean).join(" × "),
    st && st.def ? `环节：${st.def}` : "",
    m && m.def ? `错法：${m.def}` : "",
    ...top.map(([id, pt]) => [`${id} ${pt.name}：${pt.plain || pt.def || ""}`, pt.include ? `  算进来：${pt.include}` : "", pt.exclude ? `  不算进来：${pt.exclude}` : ""].filter(Boolean).join("\n")),
  ].filter(Boolean).join("\n");
}

function paintModal(key, swap) {
  const [sid, mid] = key.split("|");
  const panel = $(".sm-panel", MOD.el);
  const i = sid && mid ? MOD.list.indexOf(`${sid}.${mid}`) : -1;
  panel.innerHTML = cellModalHTML(E.tax, E.pd, sid || null, mid || null, { pos: i >= 0 ? { i, n: MOD.list.length } : null });
  MOD.key = key;
  if (swap && !REDUCED) {
    panel.classList.remove("is-swap");
    void panel.offsetWidth;
    panel.classList.add("is-swap");
  }
  $$("#fxTax .is-sel", document).forEach((x) => x.classList.remove("is-sel"));
  if (sid && mid) $(`#fxTax .fx-g-c[data-s="${sid}"][data-m="${mid}"]`)?.classList.add("is-sel");
}

function onModalKey(e) {
  if (!MOD.el) return;
  if (e.key === "Escape") { e.preventDefault(); closeCellModal(); return; }
  if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
    const btn = $(`[data-step="${e.key === "ArrowLeft" ? -1 : 1}"]`, MOD.el);
    if (btn && !btn.disabled) { e.preventDefault(); btn.click(); }
    return;
  }
  if (e.key === "Tab") {
    const f = $$("button:not([disabled])", MOD.el).filter((x) => x.offsetParent);
    if (!f.length) return;
    const [first, last] = [f[0], f[f.length - 1]];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
}

function openCellModal(sid, mid, from) {
  if (!E.tax) return;
  hideTip();
  MOD.list = $$("#fxTax .fx-g-c:not(.is-empty)").map((x) => `${x.dataset.s}.${x.dataset.m}`);
  if (!MOD.el) {
    MOD.back = from || document.activeElement;
    const el = document.createElement("div");
    el.className = "sm";
    el.innerHTML = `<div class="sm-scrim" data-close></div><div class="sm-panel" role="dialog" aria-modal="true" aria-labelledby="smTitle"></div>`;
    if (from) {
      const r = from.getBoundingClientRect();
      el.style.setProperty("--ox", `${r.left + r.width / 2}px`);
      el.style.setProperty("--oy", `${r.top + r.height / 2}px`);
    }
    document.body.appendChild(el);
    MOD.el = el;
    document.documentElement.classList.add("is-modal");
    document.addEventListener("keydown", onModalKey, true);
    el.addEventListener("click", (e) => {
      if (e.target.closest("[data-close]")) { closeCellModal(); return; }
      const cell = e.target.closest("[data-cell]");
      if (cell) { const [s, m] = cell.dataset.cell.split("."); paintModal(`${s}|${m}`, true); return; }
      const step = e.target.closest("[data-step]");
      if (step) {
        const [s, m] = MOD.key.split("|");
        const next = MOD.list[MOD.list.indexOf(`${s}.${m}`) + Number(step.dataset.step)];
        if (next) { const [ns, nm] = next.split("."); paintModal(`${ns}|${nm}`, true); }
        return;
      }
      const copy = e.target.closest("[data-copy-spec]");
      if (copy) {
        const [s, m] = MOD.key.split("|");
        copyText(specText(E.tax, s || null, m || null)).then((ok) => flashCopy(copy, ok));
        return;
      }
      const go = e.target.closest("[data-samples]");
      if (go) {
        const [s, m] = go.dataset.samples.split("|");
        closeCellModal();
        E.nav?.({ view: "samples", product: E.product, stage: s || null, mech: m || null, pattern: null, p: null, q: null, w: null, case: null, trace: null });
      }
    });
    paintModal(`${sid || ""}|${mid || ""}`, false);
    requestAnimationFrame(() => {
      el.classList.add("is-in");
      $(".sm-close", el)?.focus({ preventScroll: true });
    });
    return;
  }
  paintModal(`${sid || ""}|${mid || ""}`, true);
}

function closeCellModal(now = false) {
  if (!MOD.el) return;
  const el = MOD.el;
  MOD.el = null;
  document.removeEventListener("keydown", onModalKey, true);
  document.documentElement.classList.remove("is-modal");
  $$("#fxTax .is-sel").forEach((x) => x.classList.remove("is-sel"));
  if (now || REDUCED) el.remove();
  else {
    el.classList.remove("is-in");
    setTimeout(() => el.remove(), 240);
  }
  if (!now) MOD.back?.focus?.({ preventScroll: true });
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

/* ---------------------------------------------------------------- wiring: wires, pegs, falling sparks */
function wireCluster(tx, tax) {
  bindTips(tx, (el) => (el.closest(".fx-g") ? taxTip(tax, el) : null));
  tx.addEventListener("pointerover", (e) => {
    tx._hovering = true;
    const c = e.target.closest(".fx-g-c:not(.is-empty)");
    $$(".fx-g-row", tx).forEach((x) => x.classList.toggle("is-hl", !!c && x.dataset.s === c.dataset.s));
    $$(".fx-g-col, .fx-bin", tx).forEach((x) => x.classList.toggle("is-hl", !!c && x.dataset.m === c.dataset.m));
  });
  tx.addEventListener("pointerleave", () => {
    tx._hovering = false;
    $$(".is-hl", tx).forEach((x) => x.classList.remove("is-hl"));
  });
  tx.addEventListener("click", (e) => {
    const cell = e.target.closest(".fx-g-c:not(.is-empty)");
    if (cell) { openCellModal(cell.dataset.s, cell.dataset.m, cell); return; }
    const row = e.target.closest(".fx-g-row[data-s]");
    if (row) { openCellModal(row.dataset.s, null, row); return; }
    const col = e.target.closest(".fx-g-col[data-m], .fx-bin[data-m]");
    if (col) openCellModal(null, col.dataset.m, col);
  });
}

const easeInOut = (u) => (u < 0.5 ? 4 * u * u * u : 1 - (-2 * u + 2) ** 3 / 2);
const easeIn = (u) => u * u;

function wireFx(root, tax, pd) {
  const diagram = $("#fxDiagram", root);
  if (!diagram) return;
  const svg = $(".fx-wires", diagram);
  const canvas = $(".fx-sparks", diagram);
  const ctx = canvas.getContext("2d");
  const hub = $(".fx-hub", diagram);
  const ring = $(".fx-ring", diagram);
  const tiles = $$(".fx-core i", diagram);
  const ins = $$(".fx-in", diagram);
  const outs = $$(".fx-out", diagram);
  const tx = $("#fxTax", diagram);
  const pegsEl = $("#fxPegs", diagram);
  const bins = $$(".fx-bin", diagram);
  const model = tax ? matrixModel(tax, pd) : null;
  const geo = { board: null, dpr: 1, w: 0, h: 0 };
  const paths = new Map();

  const draw = () => {
    const h = diagram.getBoundingClientRect();
    if (!h.width) return;
    const rel = (el) => {
      const r = el.getBoundingClientRect();
      return { l: r.left - h.left, t: r.top - h.top, r: r.right - h.left, b: r.bottom - h.top, cx: r.left + r.width / 2 - h.left, cy: r.top + r.height / 2 - h.top, w: r.width, hgt: r.height };
    };
    const vcurve = (x0, y0, x1, y1, id, cls) => {
      const ym = (y0 + y1) / 2;
      return `<path id="${id}" class="fx-w ${cls}" d="M${x0.toFixed(1)} ${y0.toFixed(1)}C${x0.toFixed(1)} ${ym.toFixed(1)} ${x1.toFixed(1)} ${ym.toFixed(1)} ${x1.toFixed(1)} ${y1.toFixed(1)}"/>`;
    };
    const hr = rel(hub);
    let d = "";
    ins.forEach((b, i) => { const r = rel(b); d += vcurve(r.cx, r.b, hr.cx, hr.t + 18, `fw-i${i}`, "in"); });
    outs.forEach((b, i) => { const r = rel(b); d += vcurve(hr.cx, hr.b - 18, r.cx, r.t, `fw-o${i}`, "out"); });
    geo.board = null;
    if (pegsEl && bins.length > 1) {
      const pg = rel(pegsEl);
      const centers = bins.map((b) => rel(b));
      const cols = bins.length;
      const rows = cols - 1;
      const w = (centers[cols - 1].cx - centers[0].cx) / (cols - 1);
      const apex = { x: (centers[0].cx + centers[cols - 1].cx) / 2, y: pg.t + 6 };
      const gap = (pg.hgt - 18) / rows;
      const pegY = (r) => apex.y + 14 + r * gap;
      outs.forEach((b, i) => { const r = rel(b); d += vcurve(r.cx, r.b, apex.x, apex.y - 2, `fw-c${i}`, "funnel"); });
      for (let r = 0; r < rows; r++) {
        for (let k = 0; k <= r; k++) {
          d += `<circle class="fx-peg" cx="${(apex.x + (k - r / 2) * w).toFixed(1)}" cy="${pegY(r).toFixed(1)}" r="2.6"/>`;
        }
      }
      const binY = bins.map((b) => $("i", b).getBoundingClientRect().top - h.top - 4);
      geo.board = { apex, w, rows, pegY, binY };
    }
    svg.setAttribute("viewBox", `0 0 ${h.width} ${h.height}`);
    svg.innerHTML = d;
    paths.clear();
    $$("path[id]", svg).forEach((p) => paths.set(p.id, p));
    geo.dpr = Math.min(2, window.devicePixelRatio || 1);
    geo.w = h.width;
    geo.h = h.height;
    canvas.width = Math.round(h.width * geo.dpr);
    canvas.height = Math.round(h.height * geo.dpr);
  };
  draw();
  const ro = new ResizeObserver(draw);
  ro.observe(diagram);
  if (tx && tax) wireCluster(tx, tax);

  const timers = new Set();
  const later = (fn, ms) => { const id = setTimeout(() => { timers.delete(id); fn(); }, ms); timers.add(id); };
  const restart = (el, cls) => { el.classList.remove(cls); void el.offsetWidth; el.classList.add(cls); };
  const land = (el, ms = 700) => { if (!el) return; restart(el, "is-on"); later(() => el.classList.remove("is-on"), ms); };
  let rot = 0;
  let step = -1;
  let lastHit = 0;
  const receive = () => {
    const now = performance.now();
    if (now - lastHit < 420) return;
    lastHit = now;
    rot += 40;
    ring.style.transform = `rotate(${rot}deg)`;
    restart(hub, "is-hit");
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
  const hitBin = (j) => {
    const bin = bins[j];
    if (!bin) return;
    land(bin, 520);
    if (!tx || tx._hovering || !model) return;
    const mid = bin.dataset.m;
    const col = $(`.fx-g-col[data-m="${mid}"]`, tx);
    const cells = $$(`.fx-g-c[data-m="${mid}"]:not(.is-empty)`, tx);
    let cell = null;
    if (cells.length) {
      const ws = cells.map((c) => Math.max(1, Number(c.dataset.n) || 0));
      let r = Math.random() * ws.reduce((a, b) => a + b, 0);
      cell = cells.find((_, k) => (r -= ws[k]) <= 0) || cells[0];
    }
    col?.classList.add("is-hl");
    cell?.classList.add("is-pulse");
    later(() => { if (!tx._hovering) col?.classList.remove("is-hl"); cell?.classList.remove("is-pulse"); }, 760);
  };

  if (REDUCED) {
    E.fx = { destroy() { ro.disconnect(); timers.forEach(clearTimeout); } };
    return;
  }

  /* Sparks: each one slides 01 → 02 → 03 → down the funnel, then bounces through the pegs into a bin. */
  const sparks = [];
  const weights = model ? model.colTot.map((v) => Math.max(v, 0.0001)) : [];
  const pickBin = () => {
    let r = Math.random() * weights.reduce((a, b) => a + b, 0);
    for (let j = 0; j < weights.length; j++) if ((r -= weights[j]) <= 0) return j;
    return weights.length - 1;
  };
  const spawn = (i = Math.floor(Math.random() * ins.length)) => {
    if (sparks.length > 28) return;
    const j = Math.floor(Math.random() * outs.length);
    land(ins[i], 600);
    sparks.push({ i, j, phase: 0, t0: performance.now(), trail: [], bin: geo.board ? pickBin() : -1 });
  };
  const DUR = [720, 620, 680];
  const along = (id, u) => {
    const p = paths.get(id);
    if (!p) return null;
    const L = p.getTotalLength();
    return p.getPointAtLength(L * u);
  };
  const galtonPoint = (s, u) => {
    const b = geo.board;
    if (!s.walk) {
      const rights = Array.from({ length: b.rows }, (_, k) => k < s.bin);
      for (let k = rights.length - 1; k > 0; k--) { const q = Math.floor(Math.random() * (k + 1)); [rights[k], rights[q]] = [rights[q], rights[k]]; }
      const pts = [{ x: b.apex.x, y: b.apex.y }];
      let r = 0;
      for (let row = 0; row < b.rows; row++) {
        pts.push({ x: b.apex.x + (r - row / 2) * b.w, y: b.pegY(row) - 5 });
        if (rights[row]) r++;
      }
      pts.push({ x: b.apex.x + (r - b.rows / 2) * b.w, y: b.binY[s.bin] });
      s.walk = pts;
    }
    const segs = s.walk.length - 1;
    const f = Math.min(segs - 1e-6, u * segs);
    const k = Math.floor(f);
    const v = f - k;
    const a = s.walk[k];
    const c = s.walk[k + 1];
    const hop = k > 0 && k < segs - 1 ? Math.sin(Math.PI * v) * 5 : 0;
    return { x: a.x + (c.x - a.x) * v, y: a.y + (c.y - a.y) * easeIn(v) - hop };
  };

  let raf = 0;
  let visible = true;
  let lastSpawn = 0;
  let accent = "";
  const frame = (now) => {
    raf = 0;
    if (!diagram.isConnected) return;
    if (!visible || document.hidden) return;
    if (now - lastSpawn > 520) { lastSpawn = now; spawn(); accent = getComputedStyle(diagram).getPropertyValue("--accent").trim() || "#3552d8"; }
    ctx.setTransform(geo.dpr, 0, 0, geo.dpr, 0, 0);
    ctx.clearRect(0, 0, geo.w, geo.h);
    for (let n = sparks.length - 1; n >= 0; n--) {
      const s = sparks[n];
      const el = now - s.t0;
      let pt = null;
      if (s.phase < 3) {
        const u = Math.min(1, el / DUR[s.phase]);
        const id = s.phase === 0 ? `fw-i${s.i}` : s.phase === 1 ? `fw-o${s.j}` : `fw-c${s.j}`;
        pt = along(id, easeInOut(u));
        if (u >= 1) {
          if (s.phase === 0) receive();
          if (s.phase === 1) land(outs[s.j], 520);
          if (s.phase === 2 && !geo.board) { sparks.splice(n, 1); continue; }
          s.phase += 1;
          s.t0 = now;
        }
      } else {
        const dur = 150 * (geo.board.rows + 2);
        const u = Math.min(1, el / dur);
        pt = galtonPoint(s, u);
        if (u >= 1) { hitBin(s.bin); sparks.splice(n, 1); continue; }
      }
      if (!pt) { sparks.splice(n, 1); continue; }
      s.trail.unshift({ x: pt.x, y: pt.y });
      if (s.trail.length > 6) s.trail.pop();
      s.trail.forEach((p, k) => {
        ctx.globalAlpha = (1 - k / 6) * (k ? 0.35 : 0.95);
        ctx.fillStyle = accent;
        ctx.beginPath();
        ctx.arc(p.x, p.y, k ? 2.4 - k * 0.25 : 3.2, 0, Math.PI * 2);
        ctx.fill();
      });
      ctx.globalAlpha = 1;
    }
    raf = requestAnimationFrame(frame);
  };
  const kick = () => { if (!raf && visible && !document.hidden && diagram.isConnected) raf = requestAnimationFrame(frame); };
  const io = new IntersectionObserver(([en]) => { visible = en.isIntersecting; kick(); }, { threshold: 0.05 });
  io.observe(diagram);
  const onVis = () => kick();
  document.addEventListener("visibilitychange", onVis);
  let lastHover = 0;
  ins.forEach((el, i) => el.addEventListener("pointerenter", () => {
    const now = performance.now();
    if (now - lastHover < 300) return;
    lastHover = now;
    spawn(i);
  }));
  kick();

  E.fx = {
    destroy() {
      cancelAnimationFrame(raf);
      ro.disconnect();
      io.disconnect();
      document.removeEventListener("visibilitychange", onVis);
      timers.forEach(clearTimeout);
    },
  };
}
