/* 评测体系: one vertical slide (01 → 02 → 03 → 04 5-tier cluster tree → matrix) + centered cell dialog.
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
    ...$$(".fx-stage > .fx-label, .fx-box, .fx-hub, .fx-tree-wrap, .fx-tree-bar, .fx-g, .echo-bar, .anatomy .rail, .anatomy .aprobs", card)
      .map((el) => ({ el, kind: el.matches(".fx-label") ? "text" : el.matches(".fx-g, .fx-tree-wrap, .rail, .aprobs") ? "grid" : "block",
        label: el.matches(".fx-g") ? "Heatmap" : el.matches(".fx-tree-wrap") ? "Tree" : el.matches(".fx-tree-bar") ? "Controls" : el.matches(".rail") ? "Messages" : el.matches(".aprobs") ? "Problems" : el.matches(".fx-label") ? "Label" : el.matches(".fx-hub") ? "Hub" : "Block" })),
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

/* Accept either the data.json shell (`clusters`: {path: n}) or a loaded product payload (`patterns`: [{id, n}]). */
function clusterMap(pd) {
  if (!pd) return null;
  if (pd.clusters && Object.keys(pd.clusters).length) return pd.clusters;
  if (Array.isArray(pd.patterns) && pd.patterns.length) {
    const out = {};
    pd.patterns.forEach((p) => {
      if (p && p.id && Number(p.n) > 0) out[p.id] = Number(p.n);
    });
    if (Object.keys(out).length) return out;
  }
  return null;
}

/* Counts per cell: clustered problems when available, else batch matrix, else defined patterns. */
function cellCounts(tax, pd) {
  const pats = l3(tax);
  const byPattern = (sid, mid) => pats.filter(([id]) => id.startsWith(`${sid}.${mid}.`)).length;
  const cl = clusterMap(pd);
  if (cl) {
    const cells = {};
    Object.entries(cl).forEach(([path, rawN]) => {
      const n = Number(rawN) || 0;
      if (n <= 0) return;
      const [s, m] = String(path).split(".");
      if (s && m) cells[`${s}.${m}`] = (cells[`${s}.${m}`] || 0) + n;
    });
    return { unit: "问题", n: (sid, mid) => cells[`${sid}.${mid}`] || 0, has: byPattern };
  }
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
  stages.forEach((st) => mechs.forEach((m) => { max = Math.max(max, cc.n(st.id, m.id)); }));
  return { stages, mechs, cc, max };
}

/* 5-tier cluster tree: 全部问题 → 阶段 → 环节 → 错法 → 标准模式 (leaves).
   Keeps phases & stages in non-crossing planar order (phase order -> stage order -> mech -> pattern). */
export function treeModel(tax, pd) {
  const root = { id: "root", row: 0, name: "全部问题", children: [], n: 0, parent: null };
  if (!tax) {
    return { root, all: [root], phases: [], stages: [], cells: [], leaves: [], byId: new Map([["root", root]]), maxLeaf: 1, unit: "问题" };
  }
  const cl = clusterMap(pd);
  const mx = !cl && pd && pd.matrix && Object.keys(pd.matrix).length ? pd.matrix : null;
  const unit = cl || mx ? "问题" : "模式";
  const leaves = new Map();

  if (cl) {
    Object.entries(cl).forEach(([path, rawN]) => {
      const n = Number(rawN) || 0;
      const p = String(path).split(".");
      if (p.length < 2 || n <= 0) return;
      const id = p.length >= 3 ? p.slice(0, 3).join(".") : `${p[0]}.${p[1]}.~`;
      leaves.set(id, (leaves.get(id) || 0) + n);
    });
  } else if (mx) {
    const allL3 = l3(tax).sort(byPat);
    Object.entries(mx).forEach(([s, mechs]) => {
      Object.entries(mechs || {}).forEach(([m, info]) => {
        const n = Number(info && info.n) || 0;
        if (n <= 0) return;
        const pats = allL3.filter(([id]) => id.startsWith(`${s}.${m}.`));
        if (!pats.length) {
          leaves.set(`${s}.${m}.~`, (leaves.get(`${s}.${m}.~`) || 0) + n);
          return;
        }
        const base = Math.floor(n / pats.length);
        const rem = n % pats.length;
        pats.forEach(([id], idx) => {
          const share = base + (idx < rem ? 1 : 0);
          if (share > 0) leaves.set(id, (leaves.get(id) || 0) + share);
        });
      });
    });
  } else {
    l3(tax).forEach(([id]) => leaves.set(id, 1));
  }

  const stageById = new Map((tax.stages || []).map((s, idx) => [s.id, { ...s, _idx: idx }]));
  const mechById = new Map((tax.mechanisms || []).map((m) => [m.id, m]));
  const stageNodes = new Map();
  [...leaves.entries()].forEach(([id, n]) => {
    const [s, m] = id.split(".");
    const st = stageById.get(s);
    if (!st) return;
    let sn = stageNodes.get(s);
    if (!sn) {
      sn = { id: s, row: 2, name: st.name, s, phase: st.phase, _idx: st._idx, children: [], n: 0, parent: null };
      stageNodes.set(s, sn);
    }
    let cn = sn.children.find((c) => c.m === m);
    if (!cn) {
      cn = { id: `${s}.${m}`, row: 3, name: (mechById.get(m) || {}).name || m, s, m, children: [], n: 0, parent: sn };
      sn.children.push(cn);
    }
    const pt = (tax.patterns || {})[id];
    cn.children.push({ id, row: 4, name: (pt && pt.name) || "未细分", plain: pt && pt.plain, s, m, children: [], n, parent: cn });
  });

  const phases = (tax.phases || []).map((ph) => ({ id: `ph:${ph.id}`, row: 1, name: ph.name, phase: ph.id, children: [], n: 0, parent: root }));
  const phaseById = new Map(phases.map((ph) => [ph.phase, ph]));
  const orphanStages = [];

  [...stageNodes.values()]
    .sort((a, b) => a._idx - b._idx)
    .forEach((sn) => {
      sn.children.sort((a, b) => (Number(a.m.slice(1)) - Number(b.m.slice(1))) || a.m.localeCompare(b.m));
      sn.children.forEach((cn) => {
        cn.children.sort((a, b) => byPat([a.id], [b.id]));
        cn.n = cn.children.reduce((t, x) => t + x.n, 0);
      });
      sn.n = sn.children.reduce((t, x) => t + x.n, 0);
      const ph = phaseById.get(sn.phase);
      if (ph) {
        sn.parent = ph;
        ph.children.push(sn);
      } else {
        sn.parent = root;
        orphanStages.push(sn);
      }
    });

  const activePhases = phases.filter((ph) => {
    ph.n = ph.children.reduce((t, x) => t + x.n, 0);
    return ph.children.length > 0;
  });
  root.children = [...activePhases, ...orphanStages];
  root.n = root.children.reduce((t, x) => t + x.n, 0);

  const stages = [...activePhases.flatMap((ph) => ph.children), ...orphanStages];
  const cells = stages.flatMap((sn) => sn.children);
  const leafList = cells.flatMap((cn) => cn.children);
  const all = [root, ...activePhases, ...stages, ...cells, ...leafList];
  const byId = new Map(all.map((n) => [n.id, n]));
  const maxLeaf = Math.max(1, ...leafList.map((l) => l.n));
  return { root, all, phases: activePhases, stages, cells, leaves: leafList, byId, maxLeaf, unit };
}

const TREE_W = 1280;
const TREE_H = 432;
const TREE_PAD = 64;
const TREE_Y = [32, 108, 192, 278, 352];
const TIERS = [["总计", TREE_Y[0]], ["阶段", TREE_Y[1]], ["环节", TREE_Y[2]], ["错法", TREE_Y[3]], ["模式", TREE_Y[4]]];

function relaxX(nodes, minGap, minX, maxX) {
  if (!nodes.length) return;
  if (nodes.length === 1) {
    nodes[0].x = Math.max(minX, Math.min(maxX, nodes[0].x));
    return;
  }
  const span = Math.max(0, maxX - minX);
  const step = Math.min(minGap, span / Math.max(1, nodes.length - 1));
  for (let pass = 0; pass < 4; pass++) {
    nodes[0].x = Math.max(minX, nodes[0].x);
    for (let i = 1; i < nodes.length; i++) {
      if (nodes[i].x - nodes[i - 1].x < step) nodes[i].x = nodes[i - 1].x + step;
    }
    nodes[nodes.length - 1].x = Math.min(maxX, nodes[nodes.length - 1].x);
    for (let i = nodes.length - 2; i >= 0; i--) {
      if (nodes[i + 1].x - nodes[i].x < step) nodes[i].x = nodes[i + 1].x - step;
    }
    nodes[0].x = Math.max(minX, nodes[0].x);
  }
}

/* Center-aligned tidy layout with anti-collision relaxation on every tier. */
function layoutTree(model, W = TREE_W) {
  const usable = W - TREE_PAD * 2;
  const stages = model.stages;
  model.root.x = W / 2;
  model.root.y = TREE_Y[0];
  if (!stages.length) return { ...model, cellMode: "pill", cellW: 52, minLeafDx: 48, showLeafNums: false };

  const contentW = stages.length <= 7 ? Math.min(usable, Math.max(440, stages.length * 150)) : usable;
  const minSpan = Math.min(84, contentW / stages.length);
  const extra = Math.max(0, contentW - stages.length * minSpan);
  const leafCounts = stages.map((sn) => Math.max(1, sn.children.reduce((t, c) => t + c.children.length, 0)));
  const weights = leafCounts.map((c) => Math.max(0, c - 1));
  const wSum = weights.reduce((a, b) => a + b, 0);

  let x = (W - contentW) / 2;
  stages.forEach((sn, i) => {
    const span = wSum > 0 ? minSpan + extra * (weights[i] / wSum) : contentW / stages.length;
    sn.x = x + span / 2;
    sn.span = span;
    sn.w = Math.min(92, Math.max(66, span - 6));
    const padIn = Math.min(18, span * 0.16);
    const leaves = sn.children.flatMap((c) => c.children);
    leaves.forEach((lf, k) => {
      lf.x = x + padIn + ((k + 0.5) * Math.max(1, span - padIn * 2)) / leaves.length;
    });
    sn.children.forEach((cn) => {
      cn.x = cn.children.reduce((t, l) => t + l.x, 0) / cn.children.length;
    });
    x += span;
  });

  relaxX(stages, 72, 92, W - 92);

  model.phases.forEach((ph) => {
    const first = ph.children[0];
    const last = ph.children[ph.children.length - 1];
    ph.x = (first.x + last.x) / 2;
  });
  relaxX(model.phases, 118, 118, W - 118);

  const cells = model.cells;
  const cellMode = cells.length <= 20 ? "pill" : "circle";
  const cellW = cellMode === "pill" ? Math.min(48, Math.max(40, (W - 180) / Math.max(1, cells.length) - 8)) : 24;
  if (cellMode === "pill") relaxX(cells, cellW + 12, 92, W - 92);
  else {
    const cellR = Math.max(9.5, Math.min(12.5, (contentW / Math.max(1, cells.length)) * 0.42));
    cells.forEach((cn) => { cn.r = cellR; });
    relaxX(cells, cellR * 2 + 4, 78, W - 78);
  }

  const leaves = model.leaves;
  let minInitDx = leaves.length > 1 ? Infinity : 48;
  for (let i = 1; i < leaves.length; i++) minInitDx = Math.min(minInitDx, leaves[i].x - leaves[i - 1].x);
  const maxR = Math.max(3.5, Math.min(10.5, minInitDx * 0.34));
  const minR = Math.max(2.6, maxR * 0.48);
  relaxX(leaves, maxR * 2 + 4, 72, W - 72);

  let minFinalDx = leaves.length > 1 ? Infinity : 48;
  for (let i = 1; i < leaves.length; i++) minFinalDx = Math.min(minFinalDx, leaves[i].x - leaves[i - 1].x);
  const leafRadius = (count) => {
    if (count <= 0) return minR;
    return minR + Math.sqrt(Math.min(1, count / model.maxLeaf)) * (maxR - minR);
  };
  leaves.forEach((lf) => { lf.r = leafRadius(lf.n); });
  model.all.forEach((n) => { n.y = TREE_Y[n.row]; });
  const showLeafNums = leaves.length <= 24 && minFinalDx >= 26;
  return { ...model, cellMode, cellW, maxR, minR, leafRadius, minFinalDx, showLeafNums };
}

const nodeHalf = (n, cellMode) => (n.row === 0 ? 21 : n.row === 1 ? 15 : n.row === 2 ? 22 : n.row === 3 ? (cellMode === "pill" ? 12 : n.r || 11) : n.r || 5);

function linkCurve(n, cellMode) {
  const p = n.parent;
  const y0 = p.y + nodeHalf(p, cellMode);
  const y1 = n.y - nodeHalf(n, cellMode);
  const ym = (y0 + y1) / 2;
  return { x0: p.x, y0, ym, x1: n.x, y1 };
}

function treeSVG(model, W = TREE_W) {
  const tiers = TIERS.map(([lbl, y]) =>
    `<line class="fx-tier-line" x1="50" y1="${y}" x2="${W - 24}" y2="${y}"/><text class="fx-tier-lbl" x="12" y="${y + 4}">${lbl}</text>`
  ).join("");

  const links = model.all.filter((n) => n.parent).map((n) => {
    const c = linkCurve(n, model.cellMode);
    return `<path class="fx-link r${n.row}" data-link="${esc(n.id)}" pathLength="1" d="M${c.x0.toFixed(1)} ${c.y0.toFixed(1)}C${c.x0.toFixed(1)} ${c.ym.toFixed(1)} ${c.x1.toFixed(1)} ${c.ym.toFixed(1)} ${c.x1.toFixed(1)} ${c.y1.toFixed(1)}"/>`;
  }).join("");

  const nodes = model.all.map((n) => {
    const at = `data-node="${esc(n.id)}" data-tip="t"`;
    if (n.row === 0) {
      return `<g class="fx-tn is-root" ${at}><rect x="${(n.x - 110).toFixed(1)}" y="${n.y - 21}" width="220" height="42" rx="21"/>
        <text class="fx-tn-k" x="${(n.x - 88).toFixed(1)}" y="${n.y + 5}">全部问题</text>
        <text class="fx-tn-big num" x="${(n.x + 88).toFixed(1)}" y="${n.y + 6}" text-anchor="end" data-num="root">${fmt(n.n)}</text></g>`;
    }
    if (n.row === 1) {
      return `<g class="fx-tn is-phase" ${at}><rect x="${(n.x - 54).toFixed(1)}" y="${n.y - 15}" width="108" height="30" rx="15"/>
        <text class="fx-tn-name" x="${(n.x - 38).toFixed(1)}" y="${n.y + 4.5}">${esc(n.name)}</text>
        <text class="fx-tn-num num" x="${(n.x + 39).toFixed(1)}" y="${n.y + 4.5}" text-anchor="end" data-num="${esc(n.id)}">${fmt(n.n)}</text></g>`;
    }
    if (n.row === 2) {
      const w = n.w || 78;
      return `<g class="fx-tn is-stage" ${at} role="button" tabindex="0" aria-label="${esc(`${n.name}：${fmt(n.n)}，查看口径`)}"><rect x="${(n.x - w / 2).toFixed(1)}" y="${n.y - 22}" width="${w.toFixed(1)}" height="44" rx="11"/>
        <text class="fx-tn-name" x="${n.x.toFixed(1)}" y="${n.y - 3}" text-anchor="middle">${esc(n.name)}</text>
        <text class="fx-tn-num num" x="${n.x.toFixed(1)}" y="${n.y + 13}" text-anchor="middle" data-num="${esc(n.id)}">${fmt(n.n)}</text></g>`;
    }
    if (n.row === 3) {
      if (model.cellMode === "pill") {
        const w = model.cellW;
        return `<g class="fx-tn is-cell" ${at} role="button" tabindex="0" aria-label="${esc(`${n.id} ${n.name}：查看口径`)}"><rect x="${(n.x - w / 2).toFixed(1)}" y="${n.y - 12}" width="${w.toFixed(1)}" height="24" rx="8"/>
          <text class="fx-tn-code" x="${(n.x - w / 2 + 7).toFixed(1)}" y="${n.y + 4}">${esc(n.m)}</text>
          <text class="fx-tn-cnum num" x="${(n.x + w / 2 - 7).toFixed(1)}" y="${n.y + 4}" text-anchor="end" data-num="${esc(n.id)}">${fmt(n.n)}</text></g>`;
      }
      const r = n.r || 11;
      return `<g class="fx-tn is-cell is-circle" ${at} role="button" tabindex="0" aria-label="${esc(`${n.id} ${n.name}：查看口径`)}"><circle cx="${n.x.toFixed(1)}" cy="${n.y}" r="${r.toFixed(1)}"/>
        <text class="fx-tn-code" x="${n.x.toFixed(1)}" y="${n.y + 3.5}" text-anchor="middle">${esc(n.m)}</text></g>`;
    }
    const lbl = model.showLeafNums ? `<text class="fx-tn-lnum num" x="${n.x.toFixed(1)}" y="${(n.y + model.maxR + 13).toFixed(1)}" text-anchor="middle" data-num="${esc(n.id)}">${fmt(n.n)}</text>` : "";
    return `<g class="fx-tn is-leaf" ${at} role="button" tabindex="0" aria-label="${esc(`${n.name}：查看口径`)}"><circle cx="${n.x.toFixed(1)}" cy="${n.y}" r="${n.r.toFixed(1)}"/><circle class="fx-tn-hit" cx="${n.x.toFixed(1)}" cy="${n.y}" r="14"/>${lbl}</g>`;
  }).join("");

  return `<svg class="fx-tree" id="fxTree" viewBox="0 0 ${W} ${TREE_H}" width="${W}" height="${TREE_H}" role="img" aria-label="聚类树：全部问题按阶段、环节、错法逐层展开到标准模式">
    <g class="fx-tiers" aria-hidden="true">${tiers}</g>
    <g class="fx-links">${links}</g>
    <g class="fx-nodes">${nodes}</g>
    <g class="fx-fx" aria-hidden="true"></g>
    <g class="fx-toasts" aria-hidden="true"></g>
  </svg>`;
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

  const model = tax ? layoutTree(treeModel(tax, pd), TREE_W) : null;
  const hasTree = !!(model && model.leaves.length);
  const treeBlock = hasTree
    ? `<div class="fx-tree-wrap">${treeSVG(model, TREE_W)}</div>
      <div class="fx-tree-bar" id="fxTreeBar">
        <div class="fx-stats">
          <div class="fx-stat"><span>已归入</span><b class="num" id="fxStatProb">${fmt(model.root.n)}</b><span class="faint num"> / ${fmt(model.root.n)}</span></div>
          <div class="fx-stat"><span>标准模式</span><b class="num" id="fxStatLeaf">${fmt(model.leaves.length)}</b><span class="faint num"> / ${fmt(model.leaves.length)}</span></div>
        </div>
        <div class="fx-feed" id="fxFeed" aria-live="polite"><span class="fx-feed-dot" aria-hidden="true"></span><span class="fx-feed-txt">${model.unit === "问题" ? "问题汇总就绪" : "模式树就绪"}</span></div>
        <div class="fx-ctls">
          <button type="button" class="fx-ctl" id="fxPause" aria-pressed="false">暂停</button>
          <button type="button" class="fx-ctl" id="fxReplay">重播</button>
        </div>
      </div>
      ${taxGrid(tax, pd)}`
    : `<div class="empty">聚类树待接入</div>`;

  return `<article class="card fx-card" style="--span:12">
    <header class="card-head"><h2>评测体系</h2></header>
    <div class="fx-diagram" id="fxDiagram">
      <svg class="fx-wires" aria-hidden="true"></svg>
      <canvas class="fx-sparks" aria-hidden="true"></canvas>
      <section class="fx-stage"><div class="fx-label"><span class="num">01</span>原始对话</div><div class="fx-row">${ins}</div></section>
      <section class="fx-stage fx-mid"><div class="fx-label"><span class="num">02</span>轨迹压缩</div>
        <div class="fx-hub"><span class="fx-orbit"><i></i></span><svg class="fx-ring" viewBox="-80 -80 160 160" aria-hidden="true">${ticks}</svg><span class="fx-core"><span>${tiles}</span></span></div>
      </section>
      <section class="fx-stage"><div class="fx-label"><span class="num">03</span>问题归因</div><div class="fx-row">${outs}</div></section>
      <section class="fx-stage fx-tax" id="fxTax">
        <div class="fx-label"><span class="num">04</span>层级聚类</div>
        ${treeBlock}
      </section>
    </div>
  </article>`;
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
        ? `<button type="button" class="fx-g-c${Number(heat(v)) > 0.62 ? " is-hot" : ""}" data-s="${st.id}" data-m="${m.id}" data-n="${v}" data-max="${max}" data-tip="c" style="--h:${heat(v)}" aria-label="${esc(`${st.name} × ${m.name}：${fmt(v)} 个${cc.unit}，查看口径`)}"><b class="num">${v ? fmt(v) : "·"}</b></button>`
        : `<span class="fx-g-c is-empty" data-s="${st.id}" data-m="${m.id}"></span>`;
    }).join("")}`).join("");
  }).join("");
  return `<div class="fx-gw" data-unit="${cc.unit}"><div class="fx-g" style="--cols:${mechs.length}">${head}${body}</div></div>`;
}

function taxTip(tax, el, state) {
  const tid = el.dataset.node;
  if (tid && state && state.model) {
    const n = state.model.byId.get(tid);
    if (!n) return null;
    const now = state.live.get(n.id) ?? n.n;
    const isHidden = el.classList.contains("is-hidden");
    const rowLabel = state.model.unit === "问题" ? "问题" : "模式";
    const sub = n.row === 4 && n.plain ? `<div class="t-note">${esc(n.plain)}</div>` : n.row === 3 ? `<div class="t-note">${esc(n.s)} × ${esc(n.m)}</div>` : "";
    const countRow = isHidden
      ? `<div class="t-row">${rowLabel}<b class="num">待生成</b></div>`
      : `<div class="t-row">${rowLabel}<b class="num">${fmt(now)}${now !== n.n ? ` / ${fmt(n.n)}` : ""}</b></div>`;
    return `<div class="t-head">${n.row >= 3 ? `<code>${esc(n.id)}</code> ` : ""}${esc(n.name)}</div>${countRow}${sub}`;
  }
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

function patternCounts(pd) {
  const cl = clusterMap(pd);
  if (!cl) return null;
  const counts = new Map();
  Object.entries(cl).forEach(([path, rawN]) => {
    const n = Number(rawN) || 0;
    if (n <= 0) return;
    counts.set(path, (counts.get(path) || 0) + n);
    const parts = String(path).split(".");
    if (parts.length >= 4) {
      const p3 = parts.slice(0, 3).join(".");
      counts.set(p3, (counts.get(p3) || 0) + n);
    }
  });
  return counts;
}

function batchCountOf(pd, sid, mid) {
  const cl = clusterMap(pd);
  if (cl) {
    let total = 0;
    Object.entries(cl).forEach(([path, rawN]) => {
      const [s, m] = String(path).split(".");
      if (sid && s !== sid) return;
      if (mid && m !== mid) return;
      total += Number(rawN) || 0;
    });
    return total;
  }
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
export function cellModalHTML(tax, pd, sid, mid, { pos = null, pattern = null } = {}) {
  const st = sid ? (tax.stages || []).find((x) => x.id === sid) : null;
  const m = mid ? (tax.mechanisms || []).find((x) => x.id === mid) : null;
  if (!st && !m) return `<div class="sm-body"><p class="sm-lead">没有找到这一格的口径。</p></div>`;
  const cc = cellCounts(tax, pd);
  const n = batchCountOf(pd, st && st.id, m && m.id);
  const pCounts = patternCounts(pd);
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
      const pn = pCounts ? pCounts.get(pid) || 0 : 0;
      const focus = pattern === pid ? " is-focus" : "";
      return `<li class="sm-pat${focus}" data-pid="${esc(pid)}">
        <div class="sm-pat-head"><code>${esc(pid)}</code><b>${esc(pt.name || pid)}</b>${pn ? `<span class="sm-pat-n num">${fmt(pn)}</span>` : ""}</div>
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
      <button type="button" class="sm-btn is-primary" data-samples="${esc(st ? st.id : "")}|${esc(m ? m.id : "")}|${esc(pattern || "")}">查看真实样本</button>
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

function paintModal(key, swap, pattern = null) {
  const [sid, mid] = key.split("|");
  const panel = $(".sm-panel", MOD.el);
  const i = sid && mid ? MOD.list.indexOf(`${sid}.${mid}`) : -1;
  panel.innerHTML = cellModalHTML(E.tax, E.pd, sid || null, mid || null, { pos: i >= 0 ? { i, n: MOD.list.length } : null, pattern });
  MOD.key = key;
  if (swap && !REDUCED) {
    panel.classList.remove("is-swap");
    void panel.offsetWidth;
    panel.classList.add("is-swap");
  }
  $$("#fxTax .is-sel", document).forEach((x) => x.classList.remove("is-sel"));
  if (sid && mid) $(`#fxTax .fx-g-c[data-s="${sid}"][data-m="${mid}"]`)?.classList.add("is-sel");
  const treeTarget = pattern ? `${pattern}` : sid && mid ? `${sid}.${mid}` : sid;
  if (treeTarget) $(`#fxTree .fx-tn[data-node="${treeTarget}"]`)?.classList.add("is-sel");
  if (pattern) {
    requestAnimationFrame(() => {
      const hit = $(".sm-pat.is-focus", panel);
      hit?.scrollIntoView?.({ block: "nearest", behavior: REDUCED ? "auto" : "smooth" });
    });
  }
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

function openCellModal(sid, mid, from, pattern = null) {
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
        const [s, m, pat] = go.dataset.samples.split("|");
        closeCellModal();
        E.nav?.({ view: "samples", product: E.product, stage: s || null, mech: m || null, pattern: pat || null, p: null, q: null, w: null, case: null, trace: null });
      }
    });
    paintModal(`${sid || ""}|${mid || ""}`, false, pattern);
    requestAnimationFrame(() => {
      el.classList.add("is-in");
      $(".sm-close", el)?.focus({ preventScroll: true });
    });
    return;
  }
  paintModal(`${sid || ""}|${mid || ""}`, true, pattern);
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

/* ---------------------------------------------------------------- wiring: living tree, matrix sync, sparks */
const SVG_NS = "http://www.w3.org/2000/svg";
const shortName = (s, max = 12) => (String(s || "").length > max ? `${String(s).slice(0, max)}…` : String(s || ""));

function svgEl(tag, attrs, text) {
  const el = document.createElementNS(SVG_NS, tag);
  if (attrs) Object.entries(attrs).forEach(([k, v]) => { if (v != null) el.setAttribute(k, String(v)); });
  if (text != null) el.textContent = String(text);
  return el;
}

function prng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/* Deterministic schedule guaranteeing seed + sum(deltas) === leaf.n for every leaf,
   and ensuring every unborn leaf's sprout spark precedes its follow-up match sparks. */
export function buildReplaySchedule(model) {
  const leaves = model.leaves || [];
  const rand = prng(42);
  const seedMap = new Map();
  if (!leaves.length) return { seedMap, events: [] };

  const seededIds = new Set();
  const maxSeed = leaves.length >= 2 ? Math.max(1, Math.min(leaves.length - 1, Math.round(leaves.length * 0.38))) : 0;
  if (maxSeed > 0) {
    const byCount = leaves.slice().sort((a, b) => b.n - a.n);
    const seenPhase = new Set();
    byCount.forEach((lf) => {
      if (seededIds.size >= maxSeed) return;
      const phId = lf.parent?.parent?.parent?.id || "root";
      if (!seenPhase.has(phId)) {
        seenPhase.add(phId);
        seededIds.add(lf.id);
      }
    });
    byCount.forEach((lf) => {
      if (seededIds.size < maxSeed) seededIds.add(lf.id);
    });
  }

  const unbornLeaves = [];
  const phaseBuckets = (model.phases.length ? model.phases : [{ children: model.stages }])
    .map((ph) => {
      const list = [];
      (ph.children || []).forEach((sn) => (sn.children || []).forEach((cn) => (cn.children || []).forEach((lf) => {
        if (!seededIds.has(lf.id)) list.push(lf);
      })));
      return list;
    });
  let more = true;
  while (more) {
    more = false;
    phaseBuckets.forEach((q) => {
      if (q.length) {
        unbornLeaves.push(q.shift());
        more = true;
      }
    });
  }
  leaves.forEach((lf) => {
    if (!seededIds.has(lf.id) && !unbornLeaves.includes(lf)) unbornLeaves.push(lf);
  });

  const splitChunks = (rem, maxK) => {
    if (rem <= 0) return [];
    const k = Math.min(rem, maxK);
    const base = Math.floor(rem / k);
    const extra = rem % k;
    return Array.from({ length: k }, (_, i) => base + (i < extra ? 1 : 0));
  };

  const matchBudget = Math.max(12, Math.min(48, 62 - unbornLeaves.length));
  const maxMatchPerLeaf = Math.max(1, Math.min(3, Math.ceil(matchBudget / Math.max(1, leaves.length))));
  const seededMatches = [];
  const sprouts = [];
  const followupsBySprout = new Map();

  leaves.forEach((lf) => {
    if (seededIds.has(lf.id)) {
      const init = lf.n <= 1 ? lf.n : Math.max(1, Math.round(lf.n * 0.25));
      seedMap.set(lf.id, init);
      splitChunks(lf.n - init, maxMatchPerLeaf).forEach((delta) => {
        seededMatches.push({ leaf: lf, delta, isNew: false });
      });
    } else {
      seedMap.set(lf.id, 0);
    }
  });

  unbornLeaves.forEach((lf, idx) => {
    const firstDelta = lf.n <= 1 ? lf.n : Math.min(lf.n, Math.max(1, Math.round(lf.n * 0.34)));
    sprouts.push({ leaf: lf, delta: firstDelta, isNew: true });
    const chunks = splitChunks(lf.n - firstDelta, Math.min(2, maxMatchPerLeaf)).map((delta) => ({ leaf: lf, delta, isNew: false }));
    followupsBySprout.set(idx, chunks);
  });

  for (let i = seededMatches.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [seededMatches[i], seededMatches[j]] = [seededMatches[j], seededMatches[i]];
  }

  const S = sprouts.length;
  const buckets = Array.from({ length: S + 1 }, () => []);
  seededMatches.forEach((ev, k) => {
    const b = k < 2 && S > 0 ? 0 : Math.floor(rand() * (S + 1));
    buckets[b].push(ev);
  });
  followupsBySprout.forEach((chunks, sIdx) => {
    chunks.forEach((ev) => {
      const minB = sIdx + 1;
      const b = minB + Math.floor(rand() * (S + 1 - minB));
      buckets[b].push(ev);
    });
  });

  const events = [];
  for (let b = 0; b <= S; b++) {
    const bk = buckets[b];
    for (let i = bk.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [bk[i], bk[j]] = [bk[j], bk[i]];
    }
    bk.forEach((ev) => events.push(ev));
    if (b < S) events.push(sprouts[b]);
  }
  return { seedMap, events };
}

function wireCluster(tx, tax, state) {
  bindTips(tx, (el) => (el.closest(".fx-g") || el.closest(".fx-tree") ? taxTip(tax, el, state) : null));
  const clearHl = () => $$(".is-hl", tx).forEach((x) => x.classList.remove("is-hl"));
  const hlAncestors = (node) => {
    for (let cur = node; cur; cur = cur.parent) {
      $(`#fxTree .fx-tn[data-node="${cur.id}"]`, tx)?.classList.add("is-hl");
      if (cur.parent) $(`#fxTree .fx-link[data-link="${cur.id}"]`, tx)?.classList.add("is-hl");
    }
  };
  const hlSubtree = (node) => {
    $(`#fxTree .fx-tn[data-node="${node.id}"]`, tx)?.classList.add("is-hl");
    (node.children || []).forEach((ch) => {
      $(`#fxTree .fx-link[data-link="${ch.id}"]`, tx)?.classList.add("is-hl");
      hlSubtree(ch);
    });
  };

  tx.addEventListener("pointerover", (e) => {
    tx._hovering = !!e.target.closest(".fx-tree, .fx-g, .fx-tree-bar");
    clearHl();
    const tn = e.target.closest(".fx-tn[data-node]");
    if (tn && state?.model) {
      const n = state.model.byId.get(tn.dataset.node);
      if (n) {
        hlAncestors(n);
        if (n.s) $(`.fx-g-row[data-s="${n.s}"]`, tx)?.classList.add("is-hl");
        if (n.m) $(`.fx-g-col[data-m="${n.m}"]`, tx)?.classList.add("is-hl");
        if (n.s && n.m) $(`.fx-g-c[data-s="${n.s}"][data-m="${n.m}"]`, tx)?.classList.add("is-hl");
      }
      return;
    }
    const c = e.target.closest(".fx-g-c:not(.is-empty)");
    if (c) {
      $(`.fx-g-row[data-s="${c.dataset.s}"]`, tx)?.classList.add("is-hl");
      $(`.fx-g-col[data-m="${c.dataset.m}"]`, tx)?.classList.add("is-hl");
      const cellNode = state?.model?.byId.get(`${c.dataset.s}.${c.dataset.m}`);
      if (cellNode) { hlAncestors(cellNode); hlSubtree(cellNode); }
      return;
    }
    const row = e.target.closest(".fx-g-row[data-s]");
    if (row) {
      row.classList.add("is-hl");
      const stNode = state?.model?.byId.get(row.dataset.s);
      if (stNode) { hlAncestors(stNode); hlSubtree(stNode); }
      return;
    }
    const col = e.target.closest(".fx-g-col[data-m]");
    if (col && state?.model) {
      col.classList.add("is-hl");
      state.model.cells.filter((cn) => cn.m === col.dataset.m).forEach((cn) => {
        hlAncestors(cn);
        hlSubtree(cn);
      });
    }
  });

  tx.addEventListener("pointerleave", () => {
    tx._hovering = false;
    clearHl();
  });

  const activateTree = (tn) => {
    if (!tn || !state?.model) return false;
    const n = state.model.byId.get(tn.dataset.node);
    if (!n) return false;
    if (n.row === 2) { openCellModal(n.s, null, tn); return true; }
    if (n.row === 3) { openCellModal(n.s, n.m, tn); return true; }
    if (n.row === 4) { openCellModal(n.s, n.m, tn, n.id.endsWith(".~") ? null : n.id); return true; }
    return false;
  };

  tx.addEventListener("click", (e) => {
    const tn = e.target.closest(".fx-tn[data-node]");
    if (activateTree(tn)) return;
    const cell = e.target.closest(".fx-g-c:not(.is-empty)");
    if (cell) { openCellModal(cell.dataset.s, cell.dataset.m, cell); return; }
    const row = e.target.closest(".fx-g-row[data-s]");
    if (row) { openCellModal(row.dataset.s, null, row); return; }
    const col = e.target.closest(".fx-g-col[data-m]");
    if (col) openCellModal(null, col.dataset.m, col);
  });

  tx.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const tn = e.target.closest('.fx-tn[role="button"]');
    if (!tn) return;
    e.preventDefault();
    activateTree(tn);
  });
}

const easeInOut = (u) => (u < 0.5 ? 4 * u * u * u : 1 - (-2 * u + 2) ** 3 / 2);

function evalVBezier(seg, u) {
  const m = 1 - u;
  const m2 = m * m;
  const u2 = u * u;
  return {
    x: m2 * m * seg.x0 + 3 * m2 * u * seg.x0 + 3 * m * u2 * seg.x1 + u2 * u * seg.x1,
    y: m2 * m * seg.y0 + 3 * m2 * u * seg.ym + 3 * m * u2 * seg.ym + u2 * u * seg.y1,
  };
}

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
  const treeSvg = $("#fxTree", diagram);
  const fxLayer = treeSvg ? $(".fx-fx", treeSvg) : null;
  const toastLayer = treeSvg ? $(".fx-toasts", treeSvg) : null;
  const statProb = $("#fxStatProb", diagram);
  const statLeaf = $("#fxStatLeaf", diagram);
  const feedEl = $("#fxFeed", diagram);
  const feedTxt = feedEl ? $(".fx-feed-txt", feedEl) : null;
  const pauseBtn = $("#fxPause", diagram);
  const replayBtn = $("#fxReplay", diagram);

  const matModel = tax ? matrixModel(tax, pd) : null;
  const tree = tax && treeSvg ? layoutTree(treeModel(tax, pd), TREE_W) : null;
  const live = new Map();
  if (tree) tree.all.forEach((n) => live.set(n.id, n.n));
  const fxState = { model: tree, live };

  const nodeElMap = new Map();
  const numElMap = new Map();
  const linkElMap = new Map();
  const leafCircleMap = new Map();
  if (treeSvg) {
    $$(".fx-tn[data-node]", treeSvg).forEach((el) => {
      nodeElMap.set(el.dataset.node, el);
      if (el.classList.contains("is-leaf")) leafCircleMap.set(el.dataset.node, el.querySelector("circle"));
    });
    $$("[data-num]", treeSvg).forEach((el) => numElMap.set(el.dataset.num, el));
    $$(".fx-link[data-link]", treeSvg).forEach((el) => linkElMap.set(el.dataset.link, el));
  }

  const cellEls = new Map();
  if (tx) {
    $$(".fx-g-c[data-s][data-m]:not(.is-empty)", tx).forEach((el) => {
      cellEls.set(`${el.dataset.s}.${el.dataset.m}`, { el, b: el.querySelector("b") });
    });
  }

  const geo = { dpr: 1, w: 0, h: 0, hasTree: false, links: new Map() };
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

    geo.links.clear();
    geo.hasTree = false;
    if (tree && treeSvg) {
      const tr = treeSvg.getBoundingClientRect();
      if (tr.width > 0 && tr.height > 0) {
        const sx = tr.width / TREE_W;
        const sy = tr.height / TREE_H;
        const mapPt = (nx, ny) => ({ x: tr.left - h.left + nx * sx, y: tr.top - h.top + ny * sy });
        const rootTop = mapPt(tree.root.x, tree.root.y - 21);
        outs.forEach((b, i) => {
          const r = rel(b);
          d += vcurve(r.cx, r.b, rootTop.x, rootTop.y, `fw-c${i}`, "funnel");
        });
        tree.all.filter((n) => n.parent).forEach((n) => {
          const c = linkCurve(n, tree.cellMode);
          const p0 = mapPt(c.x0, c.y0);
          const p1 = mapPt(c.x1, c.y1);
          geo.links.set(n.id, { x0: p0.x, y0: p0.y, ym: (p0.y + p1.y) / 2, x1: p1.x, y1: p1.y });
        });
        geo.hasTree = true;
      }
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
  if (tx && tax) wireCluster(tx, tax, fxState);

  const timers = new Set();
  const later = (fn, ms) => { const id = setTimeout(() => { timers.delete(id); fn(); }, ms); timers.add(id); };
  const restart = (el, cls) => { if (!el) return; el.classList.remove(cls); void el.offsetWidth; el.classList.add(cls); };
  const land = (el, ms = 700) => { if (!el) return; restart(el, "is-on"); later(() => el.classList.remove("is-on"), ms); };

  const updateMatrixCell = (key, val, pulse) => {
    const entry = cellEls.get(key);
    if (!entry) return;
    const baseMax = matModel ? matModel.max : 1;
    const h = baseMax ? Math.sqrt(val / baseMax) : 0;
    entry.el.dataset.n = String(val);
    entry.el.style.setProperty("--h", h.toFixed(3));
    entry.el.classList.toggle("is-hot", h > 0.62);
    if (entry.b) entry.b.textContent = val ? fmt(val) : "·";
    if (pulse && tx && !tx._hovering) {
      entry.el.classList.add("is-pulse");
      later(() => entry.el.classList.remove("is-pulse"), 520);
    }
  };

  const syncAllNodes = () => {
    if (!tree) return;
    tree.all.forEach((n) => {
      const val = live.get(n.id) || 0;
      const numEl = numElMap.get(n.id);
      if (numEl) numEl.textContent = fmt(val);
    });
    let visibleLeaves = 0;
    tree.leaves.forEach((lf) => {
      const val = live.get(lf.id) || 0;
      const hidden = nodeElMap.get(lf.id)?.classList.contains("is-hidden");
      if (!hidden) visibleLeaves++;
      const c = leafCircleMap.get(lf.id);
      if (c) c.setAttribute("r", tree.leafRadius(val).toFixed(1));
    });
    if (statProb) statProb.textContent = fmt(live.get("root") || 0);
    if (statLeaf) statLeaf.textContent = fmt(visibleLeaves);
  };

  const snapToFinal = () => {
    if (!tree) return;
    tree.all.forEach((n) => live.set(n.id, n.n));
    nodeElMap.forEach((el) => el.classList.remove("is-hidden", "is-sprout", "is-hit"));
    linkElMap.forEach((el) => el.classList.remove("is-hidden", "is-sprout", "is-lit"));
    const cellTots = new Map();
    tree.cells.forEach((cn) => cellTots.set(cn.id, (cellTots.get(cn.id) || 0) + cn.n));
    cellEls.forEach((_, key) => {
      const val = cellTots.get(key) ?? (matModel ? matModel.cc.n(...key.split(".")) : 0);
      updateMatrixCell(key, val, false);
    });
    syncAllNodes();
    if (feedEl && feedTxt) {
      feedEl.classList.remove("is-sprout");
      feedTxt.textContent = `已归入全部 ${fmt(tree.root.n)} 条${tree.unit === "问题" ? "问题" : "模式"} · 共 ${tree.leaves.length} 种标准模式`;
    }
  };

  const still = REDUCED || document.documentElement.hasAttribute("data-still");
  if (still || !tree || !tree.leaves.length) {
    snapToFinal();
    E.fx = { destroy() { ro.disconnect(); timers.forEach(clearTimeout); } };
    return;
  }

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

  const schedule = buildReplaySchedule(tree);
  const sparks = [];
  const activeToasts = [];
  let evIdx = 0;
  let phaseState = "replay"; // "replay" | "hold"
  let holdSince = 0;
  let paused = false;
  let pauseStarted = 0;
  let visible = true;
  let raf = 0;
  let lastSpawn = 0;
  let lastFrame = 0;
  let accent = "";
  let sproutCol = "";

  const clearFX = () => {
    if (fxLayer) fxLayer.textContent = "";
    if (toastLayer) toastLayer.textContent = "";
    activeToasts.length = 0;
  };

  const spawnRipple = (x, y, baseR, isSprout) => {
    if (!fxLayer) return;
    const c = svgEl("circle", {
      class: `fx-ripple${isSprout ? " is-sprout" : " is-hit"}`,
      cx: x.toFixed(1), cy: y.toFixed(1), r: Math.max(5, baseR).toFixed(1),
    });
    fxLayer.appendChild(c);
    later(() => c.remove(), isSprout ? 920 : 640);
  };

  const spawnToast = (leaf) => {
    if (!toastLayer) return;
    const text = `+ 新叶子 · ${shortName(leaf.name, 9)}`;
    const w = Math.max(118, Math.min(204, Math.round(text.length * 10.5 + 28)));
    const tx = Math.max(w / 2 + 12, Math.min(TREE_W - w / 2 - 12, leaf.x));
    const ty = 403;
    for (let i = activeToasts.length - 1; i >= 0; i--) {
      const other = activeToasts[i];
      if (Math.abs(other.x - tx) < 185 || activeToasts.length >= 2) {
        other.el.remove();
        activeToasts.splice(i, 1);
      }
    }
    const g = svgEl("g", { class: "fx-toast" });
    const l0y = (tree.showLeafNums ? leaf.y + tree.maxR + 17 : leaf.y + Math.max(4, leaf.r) + 3).toFixed(1);
    g.appendChild(svgEl("line", { class: "fx-toast-stem", x1: leaf.x.toFixed(1), y1: l0y, x2: tx.toFixed(1), y2: ty - 12 }));
    g.appendChild(svgEl("rect", { x: (tx - w / 2).toFixed(1), y: ty - 12, width: w, height: 24, rx: 12 }));
    g.appendChild(svgEl("text", { x: tx.toFixed(1), y: ty + 4, "text-anchor": "middle" }, text));
    toastLayer.appendChild(g);
    const entry = { el: g, x: tx };
    activeToasts.push(entry);
    later(() => {
      g.remove();
      const idx = activeToasts.indexOf(entry);
      if (idx >= 0) activeToasts.splice(idx, 1);
    }, 1750);
  };

  const lightLink = (id, ms = 360) => {
    const el = linkElMap.get(id);
    if (!el || el.classList.contains("is-hidden")) return;
    el.classList.add("is-lit");
    later(() => el.classList.remove("is-lit"), ms);
  };

  const revealCellBranch = (cellNode) => {
    if (!cellNode) return;
    const cellEl = nodeElMap.get(cellNode.id);
    const linkEl = linkElMap.get(cellNode.id);
    if (cellEl && cellEl.classList.contains("is-hidden")) {
      cellEl.classList.remove("is-hidden");
      restart(cellEl, "is-sprout");
    }
    if (linkEl && linkEl.classList.contains("is-hidden")) {
      linkEl.classList.remove("is-hidden");
      restart(linkEl, "is-sprout");
    }
  };

  const revealLeafBranch = (leaf) => {
    revealCellBranch(leaf.parent);
    const linkEl = linkElMap.get(leaf.id);
    if (linkEl && linkEl.classList.contains("is-hidden")) {
      linkEl.classList.remove("is-hidden");
      restart(linkEl, "is-sprout");
    }
  };

  const applyArrival = (ev) => {
    const lf = ev.leaf;
    const leafEl = nodeElMap.get(lf.id);
    const cellNode = lf.parent;
    const stageNode = cellNode?.parent;
    const phaseNode = stageNode?.parent;

    const wasHidden = !!(leafEl && leafEl.classList.contains("is-hidden"));
    if (wasHidden) {
      revealCellBranch(cellNode);
      linkElMap.get(lf.id)?.classList.remove("is-hidden");
      leafEl.classList.remove("is-hidden");
      restart(leafEl, "is-sprout");
      spawnRipple(lf.x, lf.y, 7, true);
      spawnToast(lf);
    } else if (leafEl) {
      restart(leafEl, "is-hit");
      if (ev.delta > 0) spawnRipple(lf.x, lf.y, tree.leafRadius(live.get(lf.id) || lf.n), false);
    }

    if (ev.delta > 0) {
      [lf, cellNode, stageNode, phaseNode, tree.root].forEach((node) => {
        if (!node) return;
        const next = (live.get(node.id) || 0) + ev.delta;
        live.set(node.id, next);
        const numEl = numElMap.get(node.id);
        if (numEl) numEl.textContent = fmt(next);
        if (node.row >= 1 && node.row <= 3) land(nodeElMap.get(node.id), 380);
      });
      land(nodeElMap.get("root"), 340);

      const newLeafVal = live.get(lf.id) || 0;
      const c = leafCircleMap.get(lf.id);
      if (c) c.setAttribute("r", tree.leafRadius(newLeafVal).toFixed(1));

      if (statProb) statProb.textContent = fmt(live.get("root") || 0);
      if (statLeaf && wasHidden) {
        const curShown = tree.leaves.reduce((acc, x) => acc + (nodeElMap.get(x.id)?.classList.contains("is-hidden") ? 0 : 1), 0);
        statLeaf.textContent = fmt(curShown);
      }
      if (cellNode) {
        const nextCell = live.get(cellNode.id) || 0;
        updateMatrixCell(`${lf.s}.${lf.m}`, nextCell, true);
      }
      if (feedEl && feedTxt) {
        feedEl.classList.toggle("is-sprout", wasHidden || ev.isNew);
        feedTxt.textContent = wasHidden || ev.isNew
          ? `新增叶子 · ${shortName(lf.name, 14)} (+${fmt(ev.delta)})`
          : `归入模式 · ${shortName(lf.name, 14)} +${fmt(ev.delta)}`;
      }
    }
  };

  const initSeed = () => {
    timers.forEach(clearTimeout);
    timers.clear();
    sparks.length = 0;
    clearFX();
    evIdx = 0;
    phaseState = "replay";
    holdSince = 0;
    lastSpawn = 0;

    tree.all.forEach((n) => live.set(n.id, 0));
    cellEls.forEach((_, key) => updateMatrixCell(key, 0, false));

    let shownLeaves = 0;
    const cellHasSeeded = new Set();
    tree.leaves.forEach((lf) => {
      const sVal = schedule.seedMap.get(lf.id) || 0;
      const leafEl = nodeElMap.get(lf.id);
      const linkEl = linkElMap.get(lf.id);
      leafEl?.classList.remove("is-sprout", "is-hit");
      linkEl?.classList.remove("is-sprout", "is-lit");
      if (sVal > 0) {
        shownLeaves++;
        cellHasSeeded.add(lf.parent.id);
        leafEl?.classList.remove("is-hidden");
        linkEl?.classList.remove("is-hidden");
        for (let cur = lf; cur; cur = cur.parent) live.set(cur.id, (live.get(cur.id) || 0) + sVal);
      } else {
        leafEl?.classList.add("is-hidden");
        linkEl?.classList.add("is-hidden");
      }
    });

    tree.cells.forEach((cn) => {
      const cEl = nodeElMap.get(cn.id);
      const lEl = linkElMap.get(cn.id);
      cEl?.classList.remove("is-sprout", "is-hit");
      lEl?.classList.remove("is-sprout", "is-lit");
      const active = cellHasSeeded.has(cn.id);
      cEl?.classList.toggle("is-hidden", !active);
      lEl?.classList.toggle("is-hidden", !active);
      updateMatrixCell(`${cn.s}.${cn.m}`, live.get(cn.id) || 0, false);
    });

    syncAllNodes();
    if (statLeaf) statLeaf.textContent = fmt(shownLeaves);
    if (feedEl && feedTxt) {
      feedEl.classList.remove("is-sprout");
      feedTxt.textContent = "等待问题落入聚类树…";
    }
  };

  initSeed();

  const DUR = [680, 560, 520];
  const HOP_DUR = [260, 240, 240, 280];
  const spawnInterval = Math.max(150, Math.min(250, Math.round(11500 / Math.max(18, schedule.events.length))));

  const along = (id, u) => {
    const p = paths.get(id);
    if (!p) return null;
    return p.getPointAtLength(p.getTotalLength() * u);
  };

  const makeChain = (leaf) => {
    const chain = [];
    for (let cur = leaf; cur && cur.parent; cur = cur.parent) chain.unshift(cur.id);
    return chain; // [ph, stage, cell, leaf] (or [stage, cell, leaf] if orphan)
  };

  const refreshColors = () => {
    const cs = getComputedStyle(diagram);
    accent = cs.getPropertyValue("--accent").trim() || "#3552d8";
    sproutCol = cs.getPropertyValue("--loc-ulq").trim() || "#1d7d72";
  };

  const spawn = (forcedInput, forcedEv) => {
    if (sparks.length > 30) return;
    const ev = forcedEv || (phaseState === "replay" && evIdx < schedule.events.length ? schedule.events[evIdx++] : null);
    if (!ev) return;
    refreshColors();
    const i = forcedInput != null ? forcedInput : Math.floor(Math.random() * ins.length);
    const j = Math.floor(Math.random() * outs.length);
    land(ins[i], 560);
    sparks.push({
      i, j,
      ev,
      chain: makeChain(ev.leaf),
      phase: 0,
      hop: 0,
      t0: performance.now(),
      trail: [],
    });
  };

  const shiftTiming = (delta) => {
    sparks.forEach((s) => { s.t0 += delta; });
    if (lastSpawn) lastSpawn += delta;
    if (holdSince) holdSince += delta;
  };

  const frame = (now) => {
    raf = 0;
    if (!diagram.isConnected || paused || !visible || document.hidden) return;
    if (lastFrame && now - lastFrame > 180) shiftTiming(now - lastFrame - 16);
    lastFrame = now;

    if (!accent) refreshColors();

    if (phaseState === "replay") {
      if (evIdx < schedule.events.length && (!lastSpawn || now - lastSpawn >= spawnInterval)) {
        lastSpawn = now;
        spawn();
      } else if (evIdx >= schedule.events.length && !sparks.some((s) => s.ev.delta > 0)) {
        phaseState = "hold";
        holdSince = now;
        snapToFinal();
      }
    } else if (phaseState === "hold") {
      if (now - lastSpawn > 760 && tree.leaves.length) {
        lastSpawn = now;
        const lf = tree.leaves[Math.floor(Math.random() * tree.leaves.length)];
        spawn(undefined, { leaf: lf, delta: 0, isNew: false });
      }
      if (holdSince && now - holdSince > 6000 && !tx?._hovering && !MOD.el) {
        initSeed();
      }
    }

    ctx.setTransform(geo.dpr, 0, 0, geo.dpr, 0, 0);
    ctx.clearRect(0, 0, geo.w, geo.h);

    for (let n = sparks.length - 1; n >= 0; n--) {
      const s = sparks[n];
      const el = Math.max(0, now - s.t0);
      let pt = null;
      if (s.phase < 3) {
        const u = Math.min(1, el / DUR[s.phase]);
        const id = s.phase === 0 ? `fw-i${s.i}` : s.phase === 1 ? `fw-o${s.j}` : `fw-c${s.j}`;
        pt = along(id, easeInOut(u));
        if (u >= 1) {
          if (s.phase === 0) receive();
          if (s.phase === 1) land(outs[s.j], 480);
          if (s.phase === 2) {
            if (!geo.hasTree) { sparks.splice(n, 1); continue; }
            land(nodeElMap.get("root"), 280);
            if (s.chain.length) lightLink(s.chain[0], 300);
          }
          s.phase += 1;
          s.t0 = now;
        }
      } else {
        const linkId = s.chain[s.hop];
        const seg = linkId && geo.links.get(linkId);
        if (!seg) { sparks.splice(n, 1); continue; }
        const dur = HOP_DUR[Math.min(s.hop, HOP_DUR.length - 1)];
        const u = Math.min(1, el / dur);
        pt = evalVBezier(seg, easeInOut(u));
        if (u >= 1) {
          if (s.hop < s.chain.length - 1) {
            const curId = s.chain[s.hop];
            const nextId = s.chain[s.hop + 1];
            const curNode = tree.byId.get(curId);
            const nextNode = tree.byId.get(nextId);
            if (curNode && !nodeElMap.get(curId)?.classList.contains("is-hidden")) {
              land(nodeElMap.get(curId), 280);
            }
            if (s.ev.isNew && nextNode) {
              if (nextNode.row === 3) revealCellBranch(nextNode);
              else if (nextNode.row === 4) revealLeafBranch(nextNode);
            }
            lightLink(nextId, 300);
            s.hop += 1;
            s.t0 = now;
          } else {
            applyArrival(s.ev);
            sparks.splice(n, 1);
            continue;
          }
        }
      }
      if (!pt) { sparks.splice(n, 1); continue; }
      const col = s.phase === 3 && s.ev.isNew ? sproutCol : accent;
      s.trail.unshift({ x: pt.x, y: pt.y });
      if (s.trail.length > 6) s.trail.pop();
      s.trail.forEach((p, k) => {
        ctx.globalAlpha = (1 - k / 6) * (k ? 0.35 : 0.95);
        ctx.fillStyle = col;
        ctx.beginPath();
        ctx.arc(p.x, p.y, k ? 2.4 - k * 0.25 : (s.phase === 3 && s.ev.isNew ? 3.8 : 3.2), 0, Math.PI * 2);
        ctx.fill();
      });
      ctx.globalAlpha = 1;
    }

    raf = requestAnimationFrame(frame);
  };

  const kick = () => {
    if (!raf && !paused && visible && !document.hidden && diagram.isConnected) {
      lastFrame = 0;
      raf = requestAnimationFrame(frame);
    }
  };

  pauseBtn?.addEventListener("click", () => {
    paused = !paused;
    pauseBtn.setAttribute("aria-pressed", String(paused));
    pauseBtn.textContent = paused ? "继续" : "暂停";
    if (paused) {
      pauseStarted = performance.now();
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
    } else {
      if (pauseStarted) shiftTiming(performance.now() - pauseStarted);
      pauseStarted = 0;
      kick();
    }
  });

  replayBtn?.addEventListener("click", () => {
    paused = false;
    pauseStarted = 0;
    if (pauseBtn) {
      pauseBtn.setAttribute("aria-pressed", "false");
      pauseBtn.textContent = "暂停";
    }
    initSeed();
    kick();
  });

  const io = new IntersectionObserver(([en]) => { visible = en.isIntersecting; kick(); }, { threshold: 0.05 });
  io.observe(diagram);
  const onVis = () => {
    if (document.hidden && !pauseStarted) pauseStarted = performance.now();
    else if (!document.hidden && !paused && pauseStarted) {
      shiftTiming(performance.now() - pauseStarted);
      pauseStarted = 0;
    }
    kick();
  };
  document.addEventListener("visibilitychange", onVis);

  let lastHover = 0;
  ins.forEach((el, i) => el.addEventListener("pointerenter", () => {
    if (paused) return;
    const now = performance.now();
    if (now - lastHover < 320 || !tree.leaves.length) return;
    lastHover = now;
    const lf = tree.leaves[Math.floor(Math.random() * tree.leaves.length)];
    spawn(i, { leaf: lf, delta: 0, isNew: false });
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
