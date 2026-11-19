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
    ${goldenCard(E.goldens, E.index, d.taxonomy)}
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
    ...$$(".fx-stage > .fx-label, .fx-tax-head .fx-label, .fx-box, .fx-hub, .fx-tree-wrap, .fx-g, .echo-bar, .anatomy .rail, .anatomy .aprobs", card)
      .map((el) => ({ el, kind: el.matches(".fx-label") ? "text" : el.matches(".fx-g, .fx-tree-wrap, .rail, .aprobs") ? "grid" : "block",
        label: el.matches(".fx-g") ? "Heatmap" : el.matches(".fx-tree-wrap") ? "Tree" : el.matches(".rail") ? "Messages" : el.matches(".aprobs") ? "Problems" : el.matches(".fx-label") ? "Label" : el.matches(".fx-hub") ? "Hub" : "Block" })),
  ].filter((t) => t.el));
}

/* ---------------------------------------------------------------- the vertical slide */
const FX_IN = [["user", "用户提问"], ["think", "模型思考"], ["call", "工具调用"], ["answer", "最终回答"]];
const FX_STEPS = [["规划", "var(--t0)"], ["推理", "var(--t2)"], ["执行", "var(--accent)"], ["报错", "var(--sev-1)"], ["反思", "var(--t2)"], ["关键数据", "var(--t1)"], ["产物", "var(--t1)"]];
const FX_OUT = [
  ["问题", "var(--sev-1)"],
  ["定级", "var(--sev-0)"],
  ["证据", "var(--accent)"],
  ["归属", "var(--t1)"],
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
  const stages = (tax.stages || []).slice();
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
const TREE_H = 440;
const TREE_PAD_X = 24;
const TREE_Y = [30, 102, 182, 268, 344];

/* Compute optimal capacity so every phase, stage, M{n} circle and leaf dot fits on a single row without crowding. */
export function computeOptimalBudget(W = TREE_W) {
  const usable = Math.max(480, W - TREE_PAD_X * 2);
  const maxCells = Math.max(12, Math.floor((usable + 4) / 24.5));
  const maxLeaves = Math.max(24, Math.floor(usable / 12.3));
  return { maxCells, maxLeaves };
}

/* Select the highest-impact subset within optimal capacity while keeping every node's real problem count. */
export function selectOptimalTree(model, budget = computeOptimalBudget(TREE_W)) {
  if (!model) return model;
  if (model.cells.length <= budget.maxCells && model.leaves.length <= budget.maxLeaves) {
    model.all.forEach((n) => { n.shownLeafTotal = n.n; });
    return { ...model, totalPatterns: model.leaves.length, shownPatterns: model.leaves.length, isSampled: false };
  }

  const chosenCells = new Set();
  model.stages.forEach((sn) => {
    if (chosenCells.size >= budget.maxCells || !sn.children.length) return;
    const top = sn.children.reduce((best, c) => (c.n > best.n ? c : best), sn.children[0]);
    chosenCells.add(top.id);
  });
  model.cells
    .slice()
    .sort((a, b) => b.n - a.n)
    .forEach((c) => {
      if (chosenCells.size < budget.maxCells) chosenCells.add(c.id);
    });

  const root = { ...model.root, children: [], shownLeafTotal: 0 };
  const phaseClones = [];
  const orphanStageClones = [];
  const keptCellEntries = [];

  const attachStages = (srcStages, parentClone, outBucket) => {
    srcStages.forEach((sn) => {
      const keptCells = sn.children.filter((c) => chosenCells.has(c.id));
      if (!keptCells.length) return;
      const snClone = { ...sn, children: [], parent: parentClone, shownLeafTotal: 0 };
      outBucket.push(snClone);
      keptCells.forEach((c) => {
        const cnClone = { ...c, children: [], parent: snClone, shownLeafTotal: 0 };
        snClone.children.push(cnClone);
        keptCellEntries.push({ src: c, cnClone });
      });
    });
  };

  model.phases.forEach((ph) => {
    const phClone = { ...ph, children: [], parent: root, shownLeafTotal: 0 };
    attachStages(ph.children, phClone, phClone.children);
    if (phClone.children.length) {
      phaseClones.push(phClone);
      root.children.push(phClone);
    }
  });
  attachStages(model.stages.filter((sn) => sn.parent === model.root), root, orphanStageClones);
  root.children.push(...orphanStageClones);

  const chosenLeaves = new Set();
  keptCellEntries.forEach(({ src }) => {
    if (chosenLeaves.size >= budget.maxLeaves || !src.children.length) return;
    const top = src.children.reduce((best, l) => (l.n > best.n ? l : best), src.children[0]);
    chosenLeaves.add(top.id);
  });
  keptCellEntries
    .flatMap(({ src }) => src.children)
    .filter((lf) => !chosenLeaves.has(lf.id))
    .sort((a, b) => b.n - a.n)
    .forEach((lf) => {
      if (chosenLeaves.size < budget.maxLeaves) chosenLeaves.add(lf.id);
    });

  keptCellEntries.forEach(({ src, cnClone }) => {
    src.children
      .filter((lf) => chosenLeaves.has(lf.id))
      .forEach((lf) => {
        cnClone.children.push({ ...lf, children: [], parent: cnClone, shownLeafTotal: lf.n });
      });
    cnClone.shownLeafTotal = cnClone.children.reduce((t, lf) => t + lf.n, 0);
  });

  const stages = [...phaseClones.flatMap((ph) => ph.children), ...orphanStageClones];
  stages.forEach((sn) => { sn.shownLeafTotal = sn.children.reduce((t, c) => t + c.shownLeafTotal, 0); });
  phaseClones.forEach((ph) => { ph.shownLeafTotal = ph.children.reduce((t, s) => t + s.shownLeafTotal, 0); });
  root.shownLeafTotal = root.children.reduce((t, x) => t + (x.shownLeafTotal || 0), 0);

  const cells = stages.flatMap((sn) => sn.children);
  const leaves = cells.flatMap((cn) => cn.children);
  const all = [root, ...phaseClones, ...stages, ...cells, ...leaves];
  const byId = new Map(all.map((n) => [n.id, n]));
  const maxLeaf = Math.max(1, ...leaves.map((l) => l.n));
  return {
    root,
    all,
    phases: phaseClones,
    stages,
    cells,
    leaves,
    byId,
    maxLeaf,
    unit: model.unit,
    totalPatterns: model.leaves.length,
    shownPatterns: leaves.length,
    isSampled: leaves.length < model.leaves.length,
  };
}

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

/* Center-aligned compact 5-tier layout matching 9ec5c4e with M{n} circles and dot leaves. */
function layoutTree(model, W = TREE_W) {
  const usable = W - TREE_PAD_X * 2;
  const stages = model.stages;
  model.root.x = W / 2;
  model.root.y = TREE_Y[0];
  model.root.hh = 22;
  if (!stages.length) {
    return { ...model, treeH: TREE_H, cellMode: "pill", cellW: 52, maxR: 8, minR: 3, leafRadius: () => 5, minFinalDx: 48, showLeafNums: false };
  }

  const contentW = stages.length <= 7 ? Math.min(usable, Math.max(460, stages.length * 160)) : usable;
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
    const padIn = Math.min(16, span * 0.14);
    const leaves = sn.children.flatMap((c) => c.children);
    leaves.forEach((lf, k) => {
      lf.x = x + padIn + ((k + 0.5) * Math.max(1, span - padIn * 2)) / leaves.length;
    });
    sn.children.forEach((cn) => {
      cn.x = cn.children.length ? (cn.children[0].x + cn.children[cn.children.length - 1].x) / 2 : sn.x;
    });
    x += span;
  });

  relaxX(stages, 96, 56, W - 56);

  model.phases.forEach((ph) => {
    const first = ph.children[0];
    const last = ph.children[ph.children.length - 1];
    ph.x = (first.x + last.x) / 2;
  });
  relaxX(model.phases, 128, 86, W - 86);

  const cells = model.cells;
  const cellMode = cells.length <= 20 ? "pill" : "circle";
  const cellW = cellMode === "pill" ? Math.min(54, Math.max(44, (usable - 40) / Math.max(1, cells.length) - 10)) : 24;
  if (cellMode === "pill") {
    relaxX(cells, cellW + 10, 56, W - 56);
  } else {
    const cellPitch = cells.length > 1 ? usable / (cells.length - 1) : 48;
    const cellR = Math.max(6.5, Math.min(11.5, (cellPitch - 3) / 2));
    cells.forEach((cn) => { cn.r = cellR; });
    relaxX(cells, Math.min(cellR * 2 + 3, cellPitch * 0.94), TREE_PAD_X + cellR, W - TREE_PAD_X - cellR);
  }

  const leaves = model.leaves;
  let minInitDx = leaves.length > 1 ? Infinity : 48;
  for (let i = 1; i < leaves.length; i++) minInitDx = Math.min(minInitDx, leaves[i].x - leaves[i - 1].x);
  const leafPitch = leaves.length > 1 ? usable / (leaves.length - 1) : 48;
  const maxR = Math.max(1.8, Math.min(9.5, Math.min(minInitDx, leafPitch) * 0.39));
  const minR = Math.max(1.4, maxR * 0.56);
  relaxX(leaves, Math.min(maxR * 2 + 2.0, leafPitch * 0.92), TREE_PAD_X + maxR, W - TREE_PAD_X - maxR);

  let minFinalDx = leaves.length > 1 ? Infinity : 48;
  for (let i = 1; i < leaves.length; i++) minFinalDx = Math.min(minFinalDx, leaves[i].x - leaves[i - 1].x);
  const leafRadius = (count) => {
    if (count <= 0) return minR;
    return minR + Math.sqrt(Math.min(1, count / model.maxLeaf)) * (maxR - minR);
  };
  leaves.forEach((lf) => {
    lf.r = leafRadius(lf.n);
    lf.y = TREE_Y[4];
    lf.hh = lf.r;
  });
  model.phases.forEach((ph) => { ph.y = TREE_Y[1]; ph.hh = 16; });
  stages.forEach((sn) => { sn.y = TREE_Y[2]; sn.hh = 22; });
  cells.forEach((cn) => { cn.y = TREE_Y[3]; cn.hh = cellMode === "pill" ? 12 : cn.r || 10; });

  const showLeafNums = leaves.length <= 24 && minFinalDx >= 26;
  return { ...model, treeH: TREE_H, cellMode, cellW, maxR, minR, leafRadius, minFinalDx, showLeafNums };
}

const nodeHalf = (n) => n.hh ?? (n.row === 0 ? 22 : n.row === 1 ? 16 : n.row === 2 ? 22 : n.row === 3 ? 12 : n.r || 5);

function linkCurve(n) {
  const p = n.parent;
  const y0 = p.y + nodeHalf(p);
  const y1 = n.y - nodeHalf(n);
  const ym = (y0 + y1) / 2;
  return { x0: p.x, y0, ym, x1: n.x, y1 };
}

function treeSVG(model, W = TREE_W) {
  const links = model.all.filter((n) => n.parent).map((n) => {
    const c = linkCurve(n);
    return `<path class="fx-link r${n.row}" data-link="${esc(n.id)}" pathLength="1" d="M${c.x0.toFixed(1)} ${c.y0.toFixed(1)}C${c.x0.toFixed(1)} ${c.ym.toFixed(1)} ${c.x1.toFixed(1)} ${c.ym.toFixed(1)} ${c.x1.toFixed(1)} ${c.y1.toFixed(1)}"/>`;
  }).join("");

  const nodes = model.all.map((n) => {
    const at = `data-node="${esc(n.id)}" data-tip="t"`;
    if (n.row === 0) {
      return `<g class="fx-tn is-root" ${at}><rect x="${(n.x - 118).toFixed(1)}" y="${n.y - 22}" width="236" height="44" rx="22"/>
        <text class="fx-tn-k" x="${(n.x - 94).toFixed(1)}" y="${n.y + 5}">全部问题</text>
        <text class="fx-tn-big num" x="${(n.x + 94).toFixed(1)}" y="${n.y + 6}" text-anchor="end" data-num="root">${fmt(n.n)}</text></g>`;
    }
    if (n.row === 1) {
      return `<g class="fx-tn is-phase" ${at}><rect x="${(n.x - 58).toFixed(1)}" y="${n.y - 16}" width="116" height="32" rx="16"/>
        <text class="fx-tn-name" x="${(n.x - 42).toFixed(1)}" y="${n.y + 4.5}">${esc(n.name)}</text>
        <text class="fx-tn-num num" x="${(n.x + 42).toFixed(1)}" y="${n.y + 4.5}" text-anchor="end" data-num="${esc(n.id)}">${fmt(n.n)}</text></g>`;
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
        return `<g class="fx-tn is-cell" ${at} role="button" tabindex="0" aria-label="${esc(`${n.parent?.name || ""} · ${n.name}：${fmt(n.n)}，查看口径`)}"><rect x="${(n.x - w / 2).toFixed(1)}" y="${n.y - 12}" width="${w.toFixed(1)}" height="24" rx="8"/>
          <text class="fx-tn-code" x="${(n.x - w / 2 + 7).toFixed(1)}" y="${n.y + 4}">${esc(n.m)}</text>
          <text class="fx-tn-cnum num" x="${(n.x + w / 2 - 7).toFixed(1)}" y="${n.y + 4}" text-anchor="end" data-num="${esc(n.id)}">${fmt(n.n)}</text></g>`;
      }
      const r = n.r || 10;
      return `<g class="fx-tn is-cell is-circle" ${at} role="button" tabindex="0" aria-label="${esc(`${n.parent?.name || ""} · ${n.name}：${fmt(n.n)}，查看口径`)}"><circle cx="${n.x.toFixed(1)}" cy="${n.y}" r="${r.toFixed(1)}"/>
        <text class="fx-tn-code" x="${n.x.toFixed(1)}" y="${n.y + 3.5}" text-anchor="middle">${esc(n.m)}</text></g>`;
    }
    const lbl = model.showLeafNums ? `<text class="fx-tn-lnum num" x="${n.x.toFixed(1)}" y="${(n.y + model.maxR + 13).toFixed(1)}" text-anchor="middle" data-num="${esc(n.id)}">${fmt(n.n)}</text>` : "";
    return `<g class="fx-tn is-leaf" ${at} role="button" tabindex="0" aria-label="${esc(`${n.name}：${fmt(n.n)}，查看口径`)}"><circle cx="${n.x.toFixed(1)}" cy="${n.y}" r="${n.r.toFixed(1)}"/><circle class="fx-tn-hit" cx="${n.x.toFixed(1)}" cy="${n.y}" r="10"/>${lbl}</g>`;
  }).join("");

  return `<svg class="fx-tree" id="fxTree" viewBox="0 0 ${W} ${TREE_H}" width="${W}" height="${TREE_H}" role="img" aria-label="聚类树：全部问题按阶段、环节、错法逐层展开到标准模式">
    <g class="fx-links">${links}</g>
    <g class="fx-nodes">${nodes}</g>
    <g class="fx-fx" aria-hidden="true"></g>
    <g class="fx-toasts" aria-hidden="true"></g>
  </svg>`;
}

function clusterGearSVG() {
  const teeth = (cx, cy, rOut, rIn, n) => {
    const pts = [];
    for (let i = 0; i < n; i++) {
      const a0 = (i * 2 * Math.PI) / n;
      const step = (2 * Math.PI) / n;
      const a1 = a0 + step * 0.22;
      const a2 = a0 + step * 0.42;
      const a3 = a0 + step * 0.72;
      const a4 = a0 + step * 0.92;
      pts.push(
        `${(cx + Math.cos(a0) * rIn).toFixed(2)},${(cy + Math.sin(a0) * rIn).toFixed(2)}`,
        `${(cx + Math.cos(a1) * rOut).toFixed(2)},${(cy + Math.sin(a1) * rOut).toFixed(2)}`,
        `${(cx + Math.cos(a2) * rOut).toFixed(2)},${(cy + Math.sin(a2) * rOut).toFixed(2)}`,
        `${(cx + Math.cos(a3) * rIn).toFixed(2)},${(cy + Math.sin(a3) * rIn).toFixed(2)}`,
        `${(cx + Math.cos(a4) * rIn).toFixed(2)},${(cy + Math.sin(a4) * rIn).toFixed(2)}`
      );
    }
    return `M${pts[0]}L${pts.slice(1).join("L")}Z`;
  };
  return `<span class="fx-clu-gear" aria-hidden="true"><svg viewBox="0 0 36 28" fill="none">
    <g class="fx-gear-a"><path d="${teeth(13, 15, 10.5, 8.2, 10)}"/><circle cx="13" cy="15" r="3.4"/></g>
    <g class="fx-gear-b"><path d="${teeth(26.5, 9.5, 6.8, 5.1, 7)}"/><circle cx="26.5" cy="9.5" r="2.1"/></g>
  </svg></span>`;
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
  const outs = FX_OUT.map(([t, c], i) => {
    const ico = i === 1
      ? `<span class="fx-ico is-sev">${SEV.map((_, k) => `<i style="--c:${sevColor(k)};--k:${k}"></i>`).join("")}</span>`
      : `<span class="fx-ico"><i></i></span>`;
    return `<div class="fx-box fx-out" data-o="${i}" style="--c:${c}">${ico}<b>${t}</b></div>`;
  }).join("");

  const model = tax ? layoutTree(selectOptimalTree(treeModel(tax, pd), { maxCells: Infinity, maxLeaves: Infinity }), TREE_W) : null;
  const hasTree = !!(model && model.leaves.length);
  const treeBlock = hasTree
    ? `<div class="fx-tree-wrap">${treeSVG(model, TREE_W)}</div>
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
        <div class="fx-tax-head">
          <div class="fx-label">${clusterGearSVG()}<span class="num">04</span>层级聚类</div>
          ${hasTree ? `<div class="fx-prog" id="fxProg" role="progressbar" aria-label="聚类落入进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><span class="fx-prog-track"><i class="fx-prog-fill"></i></span><span class="fx-prog-txt num">0% · 0 / ${fmt(model.root.n)}</span></div>` : ""}
          ${hasTree ? `<div class="fx-ctls"><button type="button" class="fx-ctl" id="fxPause" aria-pressed="false">暂停</button><button type="button" class="fx-ctl" id="fxReplay">重播</button></div>` : ""}
        </div>
        ${treeBlock}
      </section>
    </div>
  </article>`;
}

function taxGrid(tax, pd) {
  const { stages, mechs, cc, max } = matrixModel(tax, pd);
  const heat = (v) => (max ? Math.sqrt(v / max) : 0).toFixed(3);
  const colSums = new Map(mechs.map((m) => [m.id, 0]));
  let grandSum = 0;
  const activeStages = [];
  (tax.phases || []).forEach((ph) => {
    stages.filter((st) => st.phase === ph.id).forEach((st) => activeStages.push(st));
  });
  activeStages.forEach((st) => {
    mechs.forEach((m) => {
      const v = cc.n(st.id, m.id);
      colSums.set(m.id, (colSums.get(m.id) || 0) + v);
      grandSum += v;
    });
  });

  const head = `<span class="fx-g-corner"></span><span></span>${mechs.map((m) =>
    `<button type="button" class="fx-g-col" data-m="${m.id}" data-tip="m" aria-label="${esc(`${m.id} ${m.name}：查看口径`)}"><code>${m.id}</code><span>${esc(m.name)}</span></button>`).join("")}<span class="fx-g-col fx-g-sum-head"><span>汇总</span></span>`;

  const body = (tax.phases || []).map((ph) => {
    const list = stages.filter((st) => st.phase === ph.id);
    if (!list.length) return "";
    return list.map((st, i) => {
      let rowSum = 0;
      const cells = mechs.map((m) => {
        const v = cc.n(st.id, m.id);
        rowSum += v;
        return v || cc.has(st.id, m.id)
          ? `<button type="button" class="fx-g-c${Number(heat(v)) > 0.62 ? " is-hot" : ""}" data-s="${st.id}" data-m="${m.id}" data-phase="${ph.id}" data-n="${v}" data-max="${max}" data-tip="c" style="--h:${heat(v)}" aria-label="${esc(`${st.id} ${st.name} × ${m.id} ${m.name}：${fmt(v)} 个${cc.unit}，查看口径`)}"><b class="num">${v ? fmt(v) : "·"}</b></button>`
          : `<span class="fx-g-c is-empty" data-s="${st.id}" data-m="${m.id}" data-phase="${ph.id}"></span>`;
      }).join("");
      const sumCell = `<button type="button" class="fx-g-sum is-row-sum" data-row-sum="${st.id}" data-s="${st.id}" data-phase="${ph.id}" data-target="${rowSum}" data-tip="s" aria-label="${esc(`${st.id} ${st.name} 汇总：${fmt(rowSum)}，查看口径`)}"><b class="num">${rowSum ? fmt(rowSum) : "·"}</b></button>`;
      return `${i === 0 ? `<span class="fx-g-ph" data-phase="${ph.id}" style="grid-row:span ${list.length}">${esc(ph.name)}</span>` : ""}<button type="button" class="fx-g-row" data-s="${st.id}" data-phase="${ph.id}" data-tip="s" aria-label="${esc(`${st.id} ${st.name}：查看口径`)}"><code>${st.id}</code><span>${esc(st.name)}</span></button>${cells}${sumCell}`;
    }).join("");
  }).join("");

  const sumRow = `<span class="fx-g-sum-lbl">汇总</span>${mechs.map((m) => {
    const v = colSums.get(m.id) || 0;
    return `<button type="button" class="fx-g-sum is-col-sum" data-col-sum="${m.id}" data-m="${m.id}" data-target="${v}" data-tip="m" aria-label="${esc(`${m.id} ${m.name} 汇总：${fmt(v)}，查看口径`)}"><b class="num">${v ? fmt(v) : "·"}</b></button>`;
  }).join("")}<span class="fx-g-sum is-grand-sum" id="fxGrandSum" data-target="${grandSum}"><b class="num">${fmt(grandSum)}</b></span>`;

  return `<div class="fx-gw" data-unit="${cc.unit}"><div class="fx-g" style="--cols:${mechs.length}">${head}${body}${sumRow}</div></div>`;
}

function taxTip(tax, el, state) {
  const tid = el.dataset.node;
  if (tid && state && state.model) {
    const n = state.model.byId.get(tid);
    if (!n) return null;
    const now = state.live.get(n.id) ?? n.n;
    const isHidden = el.classList.contains("is-hidden");
    const rowLabel = state.model.unit === "问题" ? "问题" : "模式";
    const title = n.row === 3 ? `${n.parent?.name || ""} × ${n.name}` : n.name;
    const sub = n.row === 4 && n.plain ? `<div class="t-note">${esc(n.plain)}</div>` : "";
    const countRow = isHidden
      ? `<div class="t-row">${rowLabel}<b class="num">待生成</b></div>`
      : `<div class="t-row">${rowLabel}<b class="num">${fmt(now)}</b></div>`;
    return `<div class="t-head">${esc(title)}</div>${countRow}${sub}`;
  }
  const sid = el.dataset.s || null;
  const mid = el.dataset.m || null;
  const st = sid && tax.stages.find((x) => x.id === sid);
  const m = mid && tax.mechanisms.find((x) => x.id === mid);
  const pats = l3(tax).filter(([id]) => (!sid || id.startsWith(`${sid}.`)) && (!mid || id.split(".")[1] === mid));
  const name = [st && `${st.id} ${st.name}`, m && `${m.id} ${m.name}`].filter(Boolean).join(" × ");
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
  if (!st && !m) return `<div class="sm-body"><div class="sm-empty">未找到对应条目。</div></div>`;
  const cc = cellCounts(tax, pd);
  const n = batchCountOf(pd, st && st.id, m && m.id);
  const pCounts = patternCounts(pd);
  const { top, byParent } = matchingPatterns(tax, st && st.id, m && m.id);
  const title = st && m ? `${st.name} × ${m.name}` : (st || m).name;
  const coord = [st && st.id, m && m.id].filter(Boolean).map((c) => `<code>${esc(c)}</code>`).join('<i aria-hidden="true">×</i>');
  const phase = st ? phaseName(tax, st.phase) : "";

  const stats = [];
  if (st && m) {
    if (n != null) stats.push(`<span class="sm-stat"><b class="num">${fmt(n)}</b> 问题</span>`);
    stats.push(`<span class="sm-stat"><b class="num">${top.length}</b> 标准模式</span>`);
  } else if (st) {
    if (phase) stats.push(`<span class="sm-stat">${esc(phase)}</span>`);
    if (n != null) stats.push(`<span class="sm-stat"><b class="num">${fmt(n)}</b> 问题</span>`);
  } else {
    if (n != null) stats.push(`<span class="sm-stat"><b class="num">${fmt(n)}</b> 问题</span>`);
  }

  const nodeHTML = (tier, tag, code, name, def, children = "") => `<div class="sm-node is-${tier}">
    <div class="sm-node-box">
      <div class="sm-node-head"><i class="sm-dot" aria-hidden="true"></i><span class="sm-tag">${tag}</span>${code ? `<code>${esc(code)}</code>` : ""}<b>${esc(name)}</b></div>
      ${def ? `<p>${esc(def)}</p>` : ""}
    </div>
    ${children}
  </div>`;

  let treeHTML;
  if (st && m) {
    const l2 = (tax.l2 || {})[`${st.id}.${m.id}`] || null;
    const patTotal = top.reduce((t, [pid]) => t + (pCounts ? pCounts.get(pid) || 0 : 0), 0);
    const maxPat = Math.max(1, ...top.map(([pid]) => (pCounts ? pCounts.get(pid) || 0 : 0)));
    const patsHTML = top.length ? `<ol class="sm-children sm-pats">${top.map(([pid, pt]) => {
      const subs = byParent.get(pid) || [];
      const pn = pCounts ? pCounts.get(pid) || 0 : 0;
      const pct = patTotal > 0 && pn > 0 ? Math.round((pn / patTotal) * 100) : 0;
      const share = pn > 0 ? (pn / maxPat).toFixed(3) : "0";
      const focus = pattern === pid ? " is-focus" : "";
      return `<li class="sm-pat${focus}" data-pid="${esc(pid)}" style="--share:${share}">
        <div class="sm-pat-head"><i class="sm-pat-dot" aria-hidden="true"></i><span class="sm-tag">模式</span><code>${esc(pid)}</code><b>${esc(pt.name || "未命名模式")}</b>${pn ? `<span class="sm-pat-n num">${fmt(pn)}${pct ? ` · ${pct}%` : ""}</span>` : ""}</div>
        ${pn ? `<span class="sm-pat-bar" aria-hidden="true"><i></i></span>` : ""}
        ${pt.plain || pt.def ? `<p>${esc(pt.plain || pt.def)}</p>` : ""}
        ${pt.include ? `<div class="sm-bounds"><div><span>纳入</span><p>${esc(pt.include)}</p></div></div>` : ""}
        ${subs.length ? `<ul class="sm-children sm-subs">${subs.map(([spid, sp]) => `<li><code>${esc(spid)}</code><span>${esc(sp.name || "")}${sp.plain ? `：${esc(sp.plain)}` : ""}</span></li>`).join("")}</ul>` : ""}
      </li>`;
    }).join("")}</ol>` : `<div class="sm-children"><div class="sm-empty">暂无标准模式</div></div>`;
    const mechHTML = nodeHTML("t3", "错法", m.id, m.name, (l2 && l2.def) || m.def, patsHTML);
    const stageHTML = nodeHTML("t2", "环节", st.id, st.name, st.def, `<div class="sm-children">${mechHTML}</div>`);
    treeHTML = phase ? nodeHTML("t1", "阶段", st.phase || "", phase, "", `<div class="sm-children">${stageHTML}</div>`) : stageHTML;
  } else {
    const others = st
      ? (tax.mechanisms || []).slice().sort(taxoNum).map((x) => ({ s: st.id, m: x.id, code: x.id, name: x.name }))
      : (tax.stages || []).slice().map((x) => ({ s: x.id, m: m.id, code: x.id, name: x.name }));
    const cells = others
      .map((o) => ({ ...o, v: cc.n(o.s, o.m), has: cc.has(o.s, o.m) }))
      .filter((o) => o.v || o.has);
    const maxCell = Math.max(1, ...cells.map((o) => o.v || 0));
    stats.push(`<span class="sm-stat"><b class="num">${cells.length}</b> ${st ? "错法" : "环节"}</span>`);
    const cellsHTML = cells.length
      ? `<div class="sm-children sm-cells">${cells.map((o) => {
        const share = o.v > 0 ? (o.v / maxCell).toFixed(3) : "0";
        return `<button type="button" class="sm-cell" data-cell="${o.s}.${o.m}" style="--share:${share}"><code>${o.s}.${o.m}</code><span>${esc(o.name)}</span><span class="sm-cell-meter" aria-hidden="true"><i></i></span><b class="num">${fmt(o.v)}</b></button>`;
      }).join("")}</div>`
      : `<div class="sm-children"><div class="sm-empty">暂无标准模式</div></div>`;
    if (st) {
      const stageHTML = nodeHTML("t2", "环节", st.id, st.name, st.def, cellsHTML);
      treeHTML = phase ? nodeHTML("t1", "阶段", st.phase || "", phase, "", `<div class="sm-children">${stageHTML}</div>`) : stageHTML;
    } else {
      treeHTML = nodeHTML("t3", "错法", m.id, m.name, m.def, cellsHTML);
    }
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
      <div class="sm-meta">${stats.join("")}</div>
    </header>
    <div class="sm-body"><div class="sm-tree">${treeHTML}</div></div>
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
    ...top.map(([pid, pt]) => [`${pid} ${pt.name || ""}：${pt.plain || pt.def || ""}`, pt.include ? `  纳入：${pt.include}` : ""].filter(Boolean).join("\n")),
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
  $$("#fxTax .is-sel, #fxTree .is-sel", document).forEach((x) => x.classList.remove("is-sel"));
  if (sid && mid) $(`#fxTax .fx-g-c[data-s="${sid}"][data-m="${mid}"]`)?.classList.add("is-sel");
  const treeTarget = pattern ? `${pattern}` : sid && mid ? `${sid}.${mid}` : sid;
  const phaseId = sid && E.tax?.stages?.find((x) => x.id === sid)?.phase;
  const selNode = (treeTarget && $(`#fxTree .fx-tn[data-node="${treeTarget}"]`))
    || (sid && $(`#fxTree .fx-tn[data-node="${sid}"]`))
    || (phaseId && $(`#fxTree .fx-tn[data-node="ph:${phaseId}"]`));
  selNode?.classList.add("is-sel");
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
  $$("#fxTax .is-sel, #fxTree .is-sel").forEach((x) => x.classList.remove("is-sel"));
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

function pathLabel(tax, path) {
  if (!path) return "";
  const pats = (tax && tax.patterns) || {};
  const parts = String(path).split(".");
  const pt = pats[path] || (parts.length >= 3 ? pats[parts.slice(0, 3).join(".")] : null);
  if (pt && pt.name) return pt.name;
  const st = parts[0] && tax?.stages?.find((x) => x.id === parts[0]);
  const m = parts[1] && tax?.mechanisms?.find((x) => x.id === parts[1]);
  return [st?.name, m?.name].filter(Boolean).join(" · ") || "";
}

function goldenCard(cases, index, tax = E.tax) {
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
    ${a ? `<div class="echo"><div class="echo-main"><div id="anatomyBody">${anatomyBody(a, tax)}</div></div></div>` : `<div class="empty">暂无 golden Trace。</div>`}
  </article>`;
}

function anatomyBody(a, tax = E.tax) {
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
    .map((p) => {
      const patName = pathLabel(tax, p.path);
      return `<div class="aprob" data-p="${p.id}" style="--c:${sevColor(p.sev)}" role="button" tabindex="0" aria-haspopup="dialog" aria-label="${esc(`${p.sev} ${p.label}：全屏逐步查看证据`)}">
        <div class="aprob-top"><span class="sev-badge">${p.sev}</span><span>${esc(roleName(p.role))}</span>${patName ? `<span class="faint">${esc(patName)}</span>` : ""}<span class="aprob-n">逐步推导<i aria-hidden="true"></i></span></div>
        <div class="t">${esc(p.label)}</div><div class="s">${esc(p.comp || "")}${(p.msgs || []).length ? ` · ${p.msgs.map((m) => `#${m}`).join(" ")}` : ""}</div></div>`;
    })
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
  body.innerHTML = anatomyBody(a, E.tax);
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
   and ensuring every unborn leaf sprouts visibly before its follow-up match sparks. */
export function buildReplaySchedule(model) {
  const leaves = model.leaves || [];
  const rand = prng(42);
  const seedMap = new Map();
  if (!leaves.length) return { seedMap, events: [] };

  const seededIds = new Set();
  const maxSeed = leaves.length >= 2
    ? Math.max(1, Math.min(leaves.length - 1, Math.round(leaves.length * 0.30)))
    : 0;

  const shuffleInPlace = (arr) => {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  };

  /* Build stage-balanced queues so every stage (including smaller or later stages like 记忆)
     seeds and sprouts uniformly across the entire timeline instead of piling up at the end. */
  const stageQueues = (model.stages || []).map((sn) => {
    const q = [];
    (sn.children || []).forEach((cn) => (cn.children || []).forEach((lf) => q.push(lf)));
    return shuffleInPlace(q);
  }).filter((q) => q.length > 0);

  if (maxSeed > 0) {
    // Round-robin pick across stages so every stage starts with balanced coverage
    let picked = true;
    while (seededIds.size < maxSeed && picked) {
      picked = false;
      for (const q of stageQueues) {
        if (seededIds.size >= maxSeed) break;
        if (q.length > 1 || (q.length === 1 && leaves.length <= stageQueues.length)) {
          const lf = q.shift();
          seededIds.add(lf.id);
          picked = true;
        }
      }
    }
    if (seededIds.size < maxSeed) {
      for (const q of stageQueues) {
        if (seededIds.size >= maxSeed) break;
        if (q.length) seededIds.add(q.shift().id);
      }
    }
  }

  const unbornLeaves = [];
  const unbornQueues = stageQueues.map((q) => q.slice());
  let more = true;
  while (more) {
    more = false;
    unbornQueues.forEach((q) => {
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

  const maxMatchPerLeaf = leaves.length > 20 ? 1 : 2;
  const seededMatches = [];
  const sprouts = [];
  const followupsBySprout = new Map();

  leaves.forEach((lf) => {
    if (seededIds.has(lf.id)) {
      if (lf.n <= 1) {
        seedMap.set(lf.id, lf.n);
      } else {
        const init = Math.max(1, Math.round(lf.n * 0.28));
        seedMap.set(lf.id, init);
        splitChunks(lf.n - init, maxMatchPerLeaf).forEach((delta) => {
          seededMatches.push({ leaf: lf, delta, isNew: false });
        });
      }
    } else {
      seedMap.set(lf.id, 0);
    }
  });

  unbornLeaves.forEach((lf, idx) => {
    const hasFollow = leaves.length <= 26 || idx < 18;
    const firstDelta = !hasFollow || lf.n <= 1 ? lf.n : Math.min(lf.n, Math.max(1, Math.round(lf.n * 0.45)));
    sprouts.push({ leaf: lf, delta: firstDelta, isNew: true });
    const chunks = splitChunks(lf.n - firstDelta, maxMatchPerLeaf).map((delta) => ({ leaf: lf, delta, isNew: false }));
    followupsBySprout.set(idx, chunks);
  });

  for (let i = seededMatches.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [seededMatches[i], seededMatches[j]] = [seededMatches[j], seededMatches[i]];
  }

  const S = sprouts.length;
  const buckets = Array.from({ length: S + 1 }, () => []);
  seededMatches.forEach((ev, k) => {
    const b = k % (S + 1);
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
  const treeSvg = $("#fxTree", tx);
  const gridEl = $(".fx-g", tx);
  const clearHl = () => {
    $$(".is-hl", tx).forEach((x) => x.classList.remove("is-hl"));
    treeSvg?.classList.remove("is-hovering");
    gridEl?.classList.remove("is-hovering");
  };
  const hlAncestors = (node) => {
    treeSvg?.classList.add("is-hovering");
    for (let cur = node; cur; cur = cur.parent) {
      $(`#fxTree .fx-tn[data-node="${cur.id}"]`, tx)?.classList.add("is-hl");
      if (cur.parent) $(`#fxTree .fx-link[data-link="${cur.id}"]`, tx)?.classList.add("is-hl");
    }
  };
  const hlSubtree = (node) => {
    treeSvg?.classList.add("is-hovering");
    $(`#fxTree .fx-tn[data-node="${node.id}"]`, tx)?.classList.add("is-hl");
    (node.children || []).forEach((ch) => {
      $(`#fxTree .fx-link[data-link="${ch.id}"]`, tx)?.classList.add("is-hl");
      hlSubtree(ch);
    });
  };
  const hlRowMatrix = (sid) => {
    gridEl?.classList.add("is-hovering");
    $(`.fx-g-row[data-s="${sid}"]`, tx)?.classList.add("is-hl");
    $(`.fx-g-sum[data-row-sum="${sid}"]`, tx)?.classList.add("is-hl");
    $$(`.fx-g-c[data-s="${sid}"]:not(.is-empty)`, tx).forEach((x) => x.classList.add("is-hl"));
  };
  const hlColMatrix = (mid) => {
    gridEl?.classList.add("is-hovering");
    $(`.fx-g-col[data-m="${mid}"]`, tx)?.classList.add("is-hl");
    $(`.fx-g-sum[data-col-sum="${mid}"]`, tx)?.classList.add("is-hl");
    $$(`.fx-g-c[data-m="${mid}"]:not(.is-empty)`, tx).forEach((x) => x.classList.add("is-hl"));
  };
  const hlPhaseMatrix = (ph) => {
    gridEl?.classList.add("is-hovering");
    $(`.fx-g-ph[data-phase="${ph}"]`, tx)?.classList.add("is-hl");
    $$(`.fx-g-row[data-phase="${ph}"]`, tx).forEach((x) => x.classList.add("is-hl"));
    $$(`.fx-g-sum[data-phase="${ph}"]`, tx).forEach((x) => x.classList.add("is-hl"));
    $$(`.fx-g-c[data-phase="${ph}"]:not(.is-empty)`, tx).forEach((x) => x.classList.add("is-hl"));
  };

  tx.addEventListener("pointerover", (e) => {
    tx._hovering = !!e.target.closest(".fx-tree, .fx-g, .fx-ctls");
    clearHl();
    const tn = e.target.closest(".fx-tn[data-node]");
    if (tn && state?.model) {
      const n = state.model.byId.get(tn.dataset.node);
      if (n) {
        hlAncestors(n);
        if (n.row === 0) {
          hlSubtree(n);
          gridEl?.classList.remove("is-hovering");
          $(`#fxGrandSum`, tx)?.classList.add("is-hl");
        } else if (n.row === 1) {
          hlSubtree(n);
          hlPhaseMatrix(n.phase);
        } else if (n.row === 2) {
          hlSubtree(n);
          hlRowMatrix(n.s);
        } else if (n.row >= 3) {
          if (n.row === 3) hlSubtree(n);
          gridEl?.classList.add("is-hovering");
          if (n.s) {
            $(`.fx-g-row[data-s="${n.s}"]`, tx)?.classList.add("is-hl");
            $(`.fx-g-sum[data-row-sum="${n.s}"]`, tx)?.classList.add("is-hl");
          }
          if (n.m) {
            $(`.fx-g-col[data-m="${n.m}"]`, tx)?.classList.add("is-hl");
            $(`.fx-g-sum[data-col-sum="${n.m}"]`, tx)?.classList.add("is-hl");
          }
          if (n.s && n.m) $(`.fx-g-c[data-s="${n.s}"][data-m="${n.m}"]`, tx)?.classList.add("is-hl");
        }
      }
      return;
    }
    const c = e.target.closest(".fx-g-c:not(.is-empty)");
    if (c) {
      gridEl?.classList.add("is-hovering");
      c.classList.add("is-hl");
      $(`.fx-g-row[data-s="${c.dataset.s}"]`, tx)?.classList.add("is-hl");
      $(`.fx-g-col[data-m="${c.dataset.m}"]`, tx)?.classList.add("is-hl");
      $(`.fx-g-sum[data-row-sum="${c.dataset.s}"]`, tx)?.classList.add("is-hl");
      $(`.fx-g-sum[data-col-sum="${c.dataset.m}"]`, tx)?.classList.add("is-hl");
      const cellNode = state?.model?.byId.get(`${c.dataset.s}.${c.dataset.m}`);
      const target = cellNode || state?.model?.byId.get(c.dataset.s) || state?.model?.byId.get(`ph:${c.dataset.phase}`);
      if (target) {
        hlAncestors(target);
        if (cellNode) hlSubtree(cellNode);
      }
      return;
    }
    const row = e.target.closest(".fx-g-row[data-s], .fx-g-sum[data-row-sum]");
    if (row) {
      const sid = row.dataset.s || row.dataset.rowSum;
      hlRowMatrix(sid);
      const stNode = state?.model?.byId.get(sid);
      const target = stNode || state?.model?.byId.get(`ph:${row.dataset.phase}`);
      if (target) {
        hlAncestors(target);
        if (stNode) hlSubtree(stNode);
      }
      return;
    }
    const ph = e.target.closest(".fx-g-ph[data-phase]");
    if (ph) {
      hlPhaseMatrix(ph.dataset.phase);
      const phNode = state?.model?.byId.get(`ph:${ph.dataset.phase}`);
      if (phNode) { hlAncestors(phNode); hlSubtree(phNode); }
      return;
    }
    const col = e.target.closest(".fx-g-col[data-m], .fx-g-sum[data-col-sum]");
    if (col && state?.model) {
      const mid = col.dataset.m || col.dataset.colSum;
      hlColMatrix(mid);
      state.model.cells.filter((cn) => cn.m === mid).forEach((cn) => {
        hlAncestors(cn);
        hlSubtree(cn);
      });
      return;
    }
    if (e.target.closest("#fxGrandSum") && state?.model?.root) {
      hlSubtree(state.model.root);
      $(`#fxGrandSum`, tx)?.classList.add("is-hl");
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
    const row = e.target.closest(".fx-g-row[data-s], .fx-g-sum[data-row-sum]");
    if (row) { openCellModal(row.dataset.s || row.dataset.rowSum, null, row); return; }
    const col = e.target.closest(".fx-g-col[data-m], .fx-g-sum[data-col-sum]");
    if (col) openCellModal(null, col.dataset.m || col.dataset.colSum, col);
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
  const pauseBtn = $("#fxPause", diagram);
  const replayBtn = $("#fxReplay", diagram);

  const matModel = tax ? matrixModel(tax, pd) : null;
  const tree = tax && treeSvg ? layoutTree(selectOptimalTree(treeModel(tax, pd), { maxCells: Infinity, maxLeaves: Infinity }), TREE_W) : null;
  const liveLeaf = new Map();
  const live = new Map();
  if (tree) {
    tree.all.forEach((n) => live.set(n.id, n.n));
    tree.leaves.forEach((lf) => liveLeaf.set(lf.id, lf.n));
  }
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
      const s = el.dataset.s;
      const m = el.dataset.m;
      cellEls.set(`${s}.${m}`, {
        el,
        b: el.querySelector("b"),
        s,
        m,
        phase: el.dataset.phase || "",
        target: matModel ? matModel.cc.n(s, m) : (Number(el.dataset.n) || 0),
      });
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
        const sy = tr.height / tree.treeH;
        const mapPt = (nx, ny) => ({ x: tr.left - h.left + nx * sx, y: tr.top - h.top + ny * sy });
        const rootTop = mapPt(tree.root.x, tree.root.y - 22);
        outs.forEach((b, i) => {
          const r = rel(b);
          d += vcurve(r.cx, r.b, rootTop.x, rootTop.y, `fw-c${i}`, "funnel");
        });
        tree.all.filter((n) => n.parent).forEach((n) => {
          const c = linkCurve(n);
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
  const progEl = $("#fxProg", diagram);
  const progFill = progEl ? $(".fx-prog-fill", progEl) : null;
  const progTxt = progEl ? $(".fx-prog-txt", progEl) : null;
  const cluGear = $(".fx-clu-gear", diagram);
  const cluGearA = cluGear ? $(".fx-gear-a", cluGear) : null;
  const cluGearB = cluGear ? $(".fx-gear-b", cluGear) : null;
  let cluAngle = 0;

  const rowSumEls = new Map();
  const colSumEls = new Map();
  const grandSumEl = tx ? $("#fxGrandSum b", tx) : null;
  if (tx) {
    $$(".fx-g-sum[data-row-sum]", tx).forEach((el) => rowSumEls.set(el.dataset.rowSum, el.querySelector("b")));
    $$(".fx-g-sum[data-col-sum]", tx).forEach((el) => colSumEls.set(el.dataset.colSum, el.querySelector("b")));
  }

  const updateProgress = (cur, total) => {
    if (!progEl) return;
    const ratio = total > 0 ? Math.min(1, cur / total) : 1;
    const pct = Math.round(ratio * 100);
    if (progFill) progFill.style.transform = `scaleX(${ratio.toFixed(4)})`;
    progEl.setAttribute("aria-valuenow", String(pct));
    progEl.classList.toggle("is-done", ratio >= 1);
    if (progTxt) progTxt.textContent = `${pct}% · ${fmt(cur)} / ${fmt(total)}`;
  };

  const restart = (el, cls) => { if (!el) return; el.classList.remove(cls); void el.offsetWidth; el.classList.add(cls); };
  const land = (el, ms = 700) => { if (!el) return; restart(el, "is-on"); later(() => el.classList.remove("is-on"), ms); };
  const tickEl = (el, ms = 320) => {
    if (!el || (tx && tx._hovering)) return;
    el.classList.add("is-tick");
    later(() => el.classList.remove("is-tick"), ms);
  };

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
      later(() => entry.el.classList.remove("is-pulse"), 440);
      tickEl($(`.fx-g-row[data-s="${entry.s}"]`, tx));
      tickEl($(`.fx-g-col[data-m="${entry.m}"]`, tx));
      tickEl($(`.fx-g-sum[data-row-sum="${entry.s}"]`, tx));
      tickEl($(`.fx-g-sum[data-col-sum="${entry.m}"]`, tx));
    }
  };

  const recomputeLive = () => {
    if (!tree) return;
    let totalLeafNow = 0;
    const cellSums = new Map();
    tree.leaves.forEach((lf) => {
      const v = liveLeaf.get(lf.id) || 0;
      live.set(lf.id, v);
      totalLeafNow += v;
      if (lf.parent) cellSums.set(lf.parent.id, (cellSums.get(lf.parent.id) || 0) + v);
    });
    const rootProg = tree.root.shownLeafTotal > 0 ? Math.min(1, totalLeafNow / tree.root.shownLeafTotal) : 1;
    tree.cells.forEach((cn) => {
      const leafSum = cellSums.get(cn.id) || 0;
      const p = cn.shownLeafTotal > 0 ? Math.min(1, leafSum / cn.shownLeafTotal) : rootProg;
      live.set(cn.id, p >= 1 ? cn.n : Math.round(cn.n * p));
    });
    tree.stages.forEach((sn) => {
      let sLeafNow = 0;
      sn.children.forEach((cn) => { sLeafNow += cellSums.get(cn.id) || 0; });
      const p = sn.shownLeafTotal > 0 ? Math.min(1, sLeafNow / sn.shownLeafTotal) : rootProg;
      live.set(sn.id, p >= 1 ? sn.n : Math.round(sn.n * p));
    });
    tree.phases.forEach((ph) => {
      let pLeafNow = 0;
      ph.children.forEach((sn) => sn.children.forEach((cn) => { pLeafNow += cellSums.get(cn.id) || 0; }));
      const p = ph.shownLeafTotal > 0 ? Math.min(1, pLeafNow / ph.shownLeafTotal) : rootProg;
      live.set(ph.id, p >= 1 ? ph.n : Math.round(ph.n * p));
    });
    const rootNow = rootProg >= 1 ? tree.root.n : Math.round(tree.root.n * rootProg);
    live.set("root", rootNow);
    updateProgress(rootNow, tree.root.n);
  };

  const syncMatrix = (pulseKey = null) => {
    const rootNode = tree?.root;
    const rootP = rootNode && rootNode.n > 0 ? Math.min(1, (live.get("root") || 0) / rootNode.n) : 1;
    const rSums = new Map();
    const cSums = new Map();
    let gSum = 0;
    cellEls.forEach((entry, key) => {
      let val;
      if (tree && tree.byId.has(key)) {
        val = live.get(key) || 0;
      } else {
        const stNode = tree?.byId.get(entry.s);
        const phNode = tree?.byId.get(`ph:${entry.phase}`);
        const ref = stNode || phNode;
        const p = ref && ref.n > 0 ? Math.min(1, (live.get(ref.id) || 0) / ref.n) : rootP;
        val = p >= 1 ? entry.target : Math.round(entry.target * p);
      }
      rSums.set(entry.s, (rSums.get(entry.s) || 0) + val);
      cSums.set(entry.m, (cSums.get(entry.m) || 0) + val);
      gSum += val;
      updateMatrixCell(key, val, key === pulseKey);
    });
    rowSumEls.forEach((b, sid) => { const v = rSums.get(sid) || 0; b.textContent = v ? fmt(v) : "·"; });
    colSumEls.forEach((b, mid) => { const v = cSums.get(mid) || 0; b.textContent = v ? fmt(v) : "·"; });
    if (grandSumEl) grandSumEl.textContent = fmt(gSum);
  };

  const syncAllNodes = () => {
    if (!tree) return;
    tree.all.forEach((n) => {
      const val = live.get(n.id) || 0;
      const numEl = numElMap.get(n.id);
      if (numEl) numEl.textContent = fmt(val);
    });
    tree.leaves.forEach((lf) => {
      const val = live.get(lf.id) || 0;
      const c = leafCircleMap.get(lf.id);
      if (c) c.setAttribute("r", tree.leafRadius(val).toFixed(1));
    });
  };

  const snapToFinal = () => {
    if (!tree) return;
    tree.all.forEach((n) => live.set(n.id, n.n));
    tree.leaves.forEach((lf) => liveLeaf.set(lf.id, lf.n));
    nodeElMap.forEach((el) => el.classList.remove("is-hidden", "is-sprout", "is-hit"));
    linkElMap.forEach((el) => el.classList.remove("is-hidden", "is-sprout", "is-lit"));
    const rSums = new Map();
    const cSums = new Map();
    let gSum = 0;
    cellEls.forEach((entry, key) => {
      updateMatrixCell(key, entry.target, false);
      rSums.set(entry.s, (rSums.get(entry.s) || 0) + entry.target);
      cSums.set(entry.m, (cSums.get(entry.m) || 0) + entry.target);
      gSum += entry.target;
    });
    rowSumEls.forEach((b, sid) => { const v = rSums.get(sid) || 0; b.textContent = v ? fmt(v) : "·"; });
    colSumEls.forEach((b, mid) => { const v = cSums.get(mid) || 0; b.textContent = v ? fmt(v) : "·"; });
    if (grandSumEl) grandSumEl.textContent = fmt(gSum);
    updateProgress(tree.root.n, tree.root.n);
    syncAllNodes();
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
    if (now - lastHit < 240) return;
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
      t.style.animationDelay = `${((k % 3) + Math.floor(k / 3)) * 28}ms`;
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
  let nextSpawnAt = 0;
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
    later(() => c.remove(), isSprout ? 1150 : 680);
  };

  const measureLabelW = (s) => {
    let w = 26;
    for (const ch of String(s || "")) w += ch.charCodeAt(0) > 127 ? 11.4 : 6.6;
    return Math.max(120, Math.min(TREE_W - 24, Math.ceil(w)));
  };

  const spawnToast = (leaf, delta = 0) => {
    if (!toastLayer) return;
    const text = `+ 新叶子 · ${leaf.name}${delta > 0 ? ` (+${fmt(delta)})` : ""}`;
    const w = measureLabelW(text);
    const tx = Math.max(w / 2 + 12, Math.min(TREE_W - w / 2 - 12, leaf.x));
    const ty = 408;
    for (let i = activeToasts.length - 1; i >= 0; i--) {
      const other = activeToasts[i];
      if (Math.abs(other.x - tx) < (other.w + w) / 2 + 12 || activeToasts.length >= 2) {
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
    const entry = { el: g, x: tx, w };
    activeToasts.push(entry);
    later(() => {
      g.remove();
      const idx = activeToasts.indexOf(entry);
      if (idx >= 0) activeToasts.splice(idx, 1);
    }, 1900);
  };

  const lightLink = (id, ms = 500) => {
    const el = linkElMap.get(id);
    if (!el || el.classList.contains("is-hidden")) return;
    el.classList.add("is-lit");
    later(() => el.classList.remove("is-lit"), ms);
  };

  const revealNodeAndLink = (nodeId) => {
    const nEl = nodeElMap.get(nodeId);
    const lEl = linkElMap.get(nodeId);
    if (lEl && lEl.classList.contains("is-hidden")) {
      lEl.classList.remove("is-hidden");
      restart(lEl, "is-sprout");
      later(() => lEl.classList.remove("is-sprout"), 2200);
    }
    if (nEl && nEl.classList.contains("is-hidden")) {
      nEl.classList.remove("is-hidden");
      restart(nEl, "is-sprout");
      later(() => nEl.classList.remove("is-sprout"), 2400);
    }
  };

  const revealLeafBranch = (leaf) => {
    for (let cur = leaf.parent; cur && cur.row >= 1; cur = cur.parent) revealNodeAndLink(cur.id);
    const linkEl = linkElMap.get(leaf.id);
    if (linkEl && linkEl.classList.contains("is-hidden")) {
      linkEl.classList.remove("is-hidden");
      restart(linkEl, "is-sprout");
      later(() => linkEl.classList.remove("is-sprout"), 2200);
    }
  };

  const applyArrival = (ev) => {
    const lf = ev.leaf;
    const leafEl = nodeElMap.get(lf.id);
    const wasHidden = !!(leafEl && leafEl.classList.contains("is-hidden"));
    if (wasHidden) {
      revealLeafBranch(lf);
      leafEl.classList.remove("is-hidden");
      restart(leafEl, "is-sprout");
      later(() => leafEl.classList.remove("is-sprout"), 2400);
      spawnRipple(lf.x, lf.y, 7, true);
      spawnToast(lf, ev.delta);
    } else if (leafEl) {
      restart(leafEl, "is-hit");
      later(() => leafEl.classList.remove("is-hit"), 440);
      if (ev.delta > 0) spawnRipple(lf.x, lf.y, tree.leafRadius(liveLeaf.get(lf.id) || lf.n), false);
    }

    if (ev.delta > 0) {
      liveLeaf.set(lf.id, (liveLeaf.get(lf.id) || 0) + ev.delta);
      recomputeLive();
      syncAllNodes();
      const c = leafCircleMap.get(lf.id);
      if (c) c.setAttribute("r", tree.leafRadius(liveLeaf.get(lf.id) || 0).toFixed(1));
      for (let cur = lf.parent; cur && cur.row >= 1; cur = cur.parent) land(nodeElMap.get(cur.id), 480);
      land(nodeElMap.get("root"), 440);
      syncMatrix(lf.s && lf.m ? `${lf.s}.${lf.m}` : null);
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
    nextSpawnAt = 0;

    liveLeaf.clear();
    const cellHasSeeded = new Set();
    const stageHasSeeded = new Set();
    tree.leaves.forEach((lf) => {
      const sVal = schedule.seedMap.get(lf.id) || 0;
      const leafEl = nodeElMap.get(lf.id);
      const linkEl = linkElMap.get(lf.id);
      leafEl?.classList.remove("is-sprout", "is-hit");
      linkEl?.classList.remove("is-sprout", "is-lit");
      liveLeaf.set(lf.id, sVal);
      if (sVal > 0) {
        if (lf.parent) {
          cellHasSeeded.add(lf.parent.id);
          if (lf.parent.parent) stageHasSeeded.add(lf.parent.parent.id);
        }
        leafEl?.classList.remove("is-hidden");
        linkEl?.classList.remove("is-hidden");
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
    });

    tree.stages.forEach((sn) => {
      const sEl = nodeElMap.get(sn.id);
      const lEl = linkElMap.get(sn.id);
      sEl?.classList.remove("is-sprout", "is-hit");
      lEl?.classList.remove("is-sprout", "is-lit");
      const active = stageHasSeeded.has(sn.id);
      sEl?.classList.toggle("is-hidden", !active);
      lEl?.classList.toggle("is-hidden", !active);
    });

    recomputeLive();
    syncAllNodes();
    syncMatrix();
  };

  initSeed();

  const DUR = [460, 390, 360];
  const HOP_DUR = [200, 180, 175, 200];
  const MATCH_GAP = 220;
  const SPROUT_GAP = 340;

  const along = (id, u) => {
    const p = paths.get(id);
    if (!p) return null;
    return p.getPointAtLength(p.getTotalLength() * u);
  };

  const makeChain = (leaf) => {
    const chain = [];
    for (let cur = leaf; cur && cur.parent; cur = cur.parent) chain.unshift(cur.id);
    return chain;
  };

  const refreshColors = () => {
    const cs = getComputedStyle(diagram);
    accent = cs.getPropertyValue("--accent").trim() || "#3552d8";
    sproutCol = cs.getPropertyValue("--loc-ulq").trim() || "#1d7d72";
  };

  const spawn = (forcedInput, forcedEv, forcedOut = null, delayMs = 0) => {
    if (!forcedEv && sparks.length >= 84) return;
    const ev = forcedEv || (phaseState === "replay" && evIdx < schedule.events.length ? schedule.events[evIdx++] : null);
    if (!ev) return;
    refreshColors();
    const i = forcedInput != null ? forcedInput : Math.floor(Math.random() * ins.length);
    const j = forcedOut != null ? forcedOut : Math.floor(Math.random() * outs.length);
    sparks.push({
      i, j,
      ev,
      chain: makeChain(ev.leaf),
      phase: 0,
      hop: 0,
      t0: performance.now() + delayMs,
      launched: false,
      trail: [],
    });
  };

  const spawnWave = (now) => {
    if (evIdx >= schedule.events.length || sparks.length >= 76) return null;
    const batch = [];
    let hasSprout = false;
    while (evIdx < schedule.events.length && batch.length < 7 && sparks.length + batch.length < 84) {
      const nextEv = schedule.events[evIdx];
      if (nextEv.isNew && hasSprout) break;
      if (nextEv.isNew) hasSprout = true;
      batch.push(schedule.events[evIdx++]);
    }
    if (!batch.length) return null;
    const in0 = Math.floor(Math.random() * ins.length);
    const out0 = Math.floor(Math.random() * outs.length);
    batch.forEach((ev, k) => spawn((in0 + k) % ins.length, ev, (out0 + k) % outs.length, k * 45));
    return now + (hasSprout ? SPROUT_GAP : MATCH_GAP);
  };

  const shiftTiming = (delta) => {
    sparks.forEach((s) => { s.t0 += delta; });
    if (lastSpawn) lastSpawn += delta;
    if (nextSpawnAt) nextSpawnAt += delta;
    if (holdSince) holdSince += delta;
  };

  const frame = (now) => {
    raf = 0;
    if (!diagram.isConnected || paused || !visible || document.hidden) return;
    if (lastFrame && now - lastFrame > 180) shiftTiming(now - lastFrame - 16);
    lastFrame = now;

    if (!accent) refreshColors();

    if (phaseState === "replay") {
      if (evIdx < schedule.events.length && now >= nextSpawnAt) {
        const nextT = spawnWave(now);
        if (nextT) nextSpawnAt = nextT;
      } else if (evIdx >= schedule.events.length && !sparks.some((s) => s.ev.delta > 0)) {
        phaseState = "hold";
        holdSince = now;
        snapToFinal();
      }
    } else if (phaseState === "hold") {
      if (now - lastSpawn > 900 && tree.leaves.length) {
        lastSpawn = now;
        const in0 = Math.floor(Math.random() * ins.length);
        const out0 = Math.floor(Math.random() * outs.length);
        for (let k = 0; k < 3; k++) {
          const lf = tree.leaves[Math.floor(Math.random() * tree.leaves.length)];
          spawn((in0 + k) % ins.length, { leaf: lf, delta: 0, isNew: false }, (out0 + k) % outs.length, k * 85);
        }
      }
      if (holdSince && now - holdSince > 8000 && !tx?._hovering && !MOD.el) {
        initSeed();
      }
    }

    if (cluGearA && cluGearB) {
      cluAngle = (cluAngle + (phaseState === "replay" ? 1.55 : 0.35)) % 3600;
      cluGearA.setAttribute("transform", `rotate(${cluAngle.toFixed(1)} 13 15)`);
      cluGearB.setAttribute("transform", `rotate(${(-cluAngle * (10 / 7)).toFixed(1)} 26.5 9.5)`);
    }

    ctx.setTransform(geo.dpr, 0, 0, geo.dpr, 0, 0);
    ctx.clearRect(0, 0, geo.w, geo.h);

    for (let n = sparks.length - 1; n >= 0; n--) {
      const s = sparks[n];
      if (now < s.t0) continue;
      if (!s.launched) {
        s.launched = true;
        land(ins[s.i], 420);
      }
      const el = now - s.t0;
      let pt = null;
      if (s.phase < 3) {
        const u = Math.min(1, el / DUR[s.phase]);
        const id = s.phase === 0 ? `fw-i${s.i}` : s.phase === 1 ? `fw-o${s.j}` : `fw-c${s.j}`;
        pt = along(id, easeInOut(u));
        if (u >= 1) {
          if (s.phase === 0) receive();
          if (s.phase === 1) land(outs[s.j], 420);
          if (s.phase === 2) {
            if (!geo.hasTree) { sparks.splice(n, 1); continue; }
            land(nodeElMap.get("root"), 380);
            cluAngle += 4;
            if (s.chain.length) lightLink(s.chain[0], 420);
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
            const curEl = nodeElMap.get(curId);
            if (curEl) {
              if (curEl.classList.contains("is-hidden")) {
                curEl.classList.remove("is-hidden");
                restart(curEl, "is-sprout");
                later(() => curEl.classList.remove("is-sprout"), 2000);
              } else {
                land(curEl, 380);
              }
            }
            const nextLink = linkElMap.get(nextId);
            if (s.ev.isNew && nextLink && nextLink.classList.contains("is-hidden")) {
              nextLink.classList.remove("is-hidden");
              restart(nextLink, "is-sprout");
              later(() => nextLink.classList.remove("is-sprout"), 1900);
            }
            lightLink(nextId, 420);
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
      if (s.trail.length > 7) s.trail.pop();
      s.trail.forEach((p, k) => {
        ctx.globalAlpha = (1 - k / 7) * (k ? 0.38 : 0.96);
        ctx.fillStyle = col;
        ctx.beginPath();
        ctx.arc(p.x, p.y, k ? 2.5 - k * 0.24 : (s.phase === 3 && s.ev.isNew ? 4.0 : 3.4), 0, Math.PI * 2);
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
