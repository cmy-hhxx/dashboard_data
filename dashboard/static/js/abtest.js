/* AB Test: one fixed question set before / after a release, plus post-release real-user
   online validation. The outer step answers whether the fixed-set problems moved; the next
   step keeps the normal cluster-matrix interaction (scene × cluster drill, cell trend).

   The three sides are deliberately not one denominator:
   - before / after are the same fixed targets and can be subtracted;
   - online is a different real-user population and is shown as validation only.
   State lives in data.js's u.ab so an in-place dashboard refresh returns to the same round,
   summary / matrix step, metric and selected cell. */
import { esc, fmt, REDUCED, sevColor, segmented } from "./core.js";
import { sunburst } from "./sunburst.js";
import { lineTrendSVG, wireLineTrendChart } from "./trend_chart.js";
import { trendSampleFrame } from "./trend_samples.js";

const SIDES = ["before", "after", "online"];
const SIDE_SHORT = { before: "改版前", after: "改版后", online: "线上" };
const METRICS = [
  ["all", "三批合计"],
  ["delta", "变化"],
  ["before", "改版前"],
  ["after", "改版后"],
  ["online", "线上"],
];
const NO_SCENE = "未接入分类体系";
const DASH = "—";
const num = (v) => Number(v) || 0;
const signed = (v) => (v > 0 ? `+${fmt(v)}` : v < 0 ? `−${fmt(-v)}` : "0");
const sumOf = (list) => list.reduce((s, v) => s + num(v), 0);
const pathRelated = (a, b) => a === b || String(a).startsWith(`${b}.`) || String(b).startsWith(`${a}.`);
const SIDE_TONE = { before: "var(--t2)", after: "var(--accent)", online: "var(--loc-ulq)" };

const sideReady = (rnd, side) => !!(rnd.sides && rnd.sides[side]);
const defaultMetric = (rnd) => (sideReady(rnd, "after") ? "delta" : "all");
const roundLabel = (rnd, i) => rnd.label || rnd.release_label || `第 ${i + 1} 期`;

/* Reuse 评测量 bars, grouping the two post-release populations without mixing them. */
export function abComparisonHTML(rnd) {
  const before = rnd.sides?.before;
  const after = rnd.sides?.after;
  const labels = { before: "同题基线", after: "同题复测", online: "线上真实" };
  const max = Math.max(1, ...SIDES.map((side) => num(rnd.sides?.[side]?.hits)));
  const columns = SIDES.map((side) => {
    const result = rnd.sides?.[side];
    const n = result ? num(result.hits) : null;
    const traces = result?.traces == null ? DASH : fmt(result.traces);
    // Fixed-set extracts count only traces with cluster paths; online counts evaluated records.
    const volumeLabel = side === "online" ? "评测样本" : "有问题 Trace";
    const volume = `${traces} ${volumeLabel}`;
    return `<div class="evday${result ? "" : " is-missing"}">
      <div class="evnums"><b class="num">${n == null ? DASH : fmt(n)}</b></div>
      <div class="ab-result-column">${n == null
        ? '<span class="ab-result-empty">暂无结果</span>'
        : `<div class="evbar" style="height:${156 * n / max}px;--c:${SIDE_TONE[side]}" data-tip="${SIDE_SHORT[side]} · ${labels[side]}|${fmt(n)} 个问题 · ${volume}"><i style="height:100%"></i></div>`}</div>
      <span class="evdate">${labels[side]}</span><small class="ab-result-volume"><b class="num">${traces}</b><span>${volumeLabel}</span></small>
    </div>`;
  }).join("");
  const delta = before && after ? num(after.hits) - num(before.hits) : null;
  const change = delta == null ? "" : `<span class="ab-result-change ${delta > 0 ? "is-worse" : delta < 0 ? "is-better" : ""}">同题${delta === 0 ? "持平" : `${delta < 0 ? "减少" : "增加"} ${fmt(Math.abs(delta))}`}</span>`;
  return `<div class="ab-results"><header><span>问题数量</span>${change}</header><div class="ab-result-groups"><span>改版前</span><span>改版后</span></div><div class="evrow ab-result-bars" style="--n:3;--bar-h:156px">${columns}</div></div>`;
}

function crossFor(rnd, side) {
  if (!sideReady(rnd, side)) return null;
  const source = rnd.matrix && rnd.matrix[side];
  if (Array.isArray(source)) return source;
  // sides says the batch exists but its matrix has not been rebuilt yet: do not fall back to
  // leaves for after/online, or an empty batch would read as "everything improved".
  if (Array.isArray(rnd.leaves) && side !== "before") return null;
  // Compatibility with schema 1: matrix files can be rebuilt before the browser cache rolls.
  const leaves = Array.isArray(rnd.leaves) ? rnd.leaves : [];
  const pats = leaves.map((leaf) => [leaf.id, leaf[side]]).filter(([, n]) => n != null && num(n) > 0);
  return pats.length ? [[NO_SCENE, "", pats]] : [];
}

function allCross(rnd) {
  return SIDES.flatMap((side) => crossFor(rnd, side) || []);
}

function metricValue(cell, metric, rnd) {
  if (metric === "before") return cell.before;
  if (metric === "after") return sideReady(rnd, "after") ? cell.after : null;
  if (metric === "online") return sideReady(rnd, "online") ? cell.online : null;
  if (metric === "delta") return sideReady(rnd, "after") ? cell.after - cell.before : null;
  return cell.before + (sideReady(rnd, "after") ? cell.after : 0) + (sideReady(rnd, "online") ? cell.online : 0);
}

function sceneMatches(node, task, sub) {
  return node.group ? (node.tasks || []).includes(task) : node.sub ? node.task === task && node.sub === sub : !node.task || node.task === task;
}

function sceneTree(cross) {
  const tasks = new Map();
  cross.forEach(([task, sub, pats]) => {
    const name = task || NO_SCENE;
    const n = sumOf(pats.map((x) => x[1]));
    let t = tasks.get(name);
    if (!t) tasks.set(name, (t = { name, task: name, n: 0, sessions: 0, tasks: [name], subs: new Map() }));
    t.n += n;
    t.sessions += 1;
    if (sub) {
      let s = t.subs.get(sub);
      if (!s) t.subs.set(sub, (s = { name: sub, task: name, sub, n: 0, sessions: 0 }));
      s.n += n;
      s.sessions += 1;
    }
  });
  return [...tasks.values()]
    .sort((a, b) => b.n - a.n || a.name.localeCompare(b.name))
    .map((t) => {
      const subs = [...t.subs.values()].sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));
      return {
        name: t.name, task: t.task, n: t.n, sessions: t.sessions, tasks: t.tasks,
        children: subs.length ? subs.map((s) => ({ name: s.name, task: s.task, sub: s.sub, n: s.n, sessions: s.sessions, children: [] })) : [],
      };
    });
}

function capScenes(nodes) {
  if (nodes.length <= 12) return nodes;
  const rest = nodes.slice(10);
  return [
    ...nodes.slice(0, 10),
    { name: "其他场景", group: true, n: sumOf(rest.map((x) => x.n)), sessions: sumOf(rest.map((x) => x.sessions)),
      tasks: rest.flatMap((x) => x.tasks || [x.task]), children: rest },
  ];
}

function clusterTree(cross, tax, names) {
  const root = { name: "全部", children: [] };
  const byId = new Map();
  const add = (parent, id, depth) => {
    const key = parent === root ? id : `${parent.prefix}.${id}`;
    let node = byId.get(key);
    if (!node) {
      const stage = depth === 1 ? (tax.stages || []).find((x) => x.id === id) : null;
      const mech = depth === 2 ? (tax.mechanisms || []).find((x) => x.id === id) : null;
      const pattern = depth >= 3 ? (tax.patterns || {})[key] : null;
      node = { name: (stage && stage.name) || (mech && mech.name) || (pattern && pattern.name) || names.get(key) || id,
        id, prefix: key, pat: key, children: [] };
      byId.set(key, node);
      parent.children.push(node);
    }
    return node;
  };
  cross.forEach(([, , pats]) => pats.forEach(([path]) => {
    let parent = root;
    String(path).split(".").forEach((part, i) => { parent = add(parent, part, i + 1); });
  }));
  const order = (id) => String(id).split(".").map((p) => Number(p.replace(/\D/g, "")) || 0);
  const sort = (node) => {
    node.children.sort((a, b) => {
      const x = order(a.prefix), y = order(b.prefix);
      for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
        const d = (x[i] || 0) - (y[i] || 0);
        if (d) return d;
      }
      return a.name.localeCompare(b.name);
    });
    node.children.forEach(sort);
  };
  sort(root);
  return root;
}

function matrixViewAb(rnd, rows, cols, metric) {
  const cells = rows.map(() => cols.map(() => ({ before: 0, after: 0, online: 0, pats: new Map() })));
  SIDES.forEach((side) => {
    const cross = crossFor(rnd, side);
    if (!cross) return;
    cross.forEach(([task, sub, pats]) => {
      const ri = rows.findIndex((r) => sceneMatches(r, task || NO_SCENE, sub || ""));
      if (ri < 0) return;
      pats.forEach(([pid, n]) => {
        const ci = cols.findIndex((c) => pid === c.prefix || String(pid).startsWith(`${c.prefix}.`));
        if (ci < 0) return;
        const cell = cells[ri][ci];
        cell[side] += num(n);
        cell.pats.set(pid, (cell.pats.get(pid) || 0) + num(n));
      });
    });
  });
  cells.forEach((row) => row.forEach((cell) => { cell.n = metricValue(cell, metric, rnd); }));
  return { rows, cols, cells };
}

function matrixTableAb(view, rnd, metric, selected) {
  const { rows, cols, cells } = view;
  if (!rows.length || !cols.length) return `<div class="empty">暂无聚类矩阵数据</div>`;
  let max = 1;
  cells.forEach((row) => row.forEach((x) => { if (x.n != null) max = Math.max(max, Math.abs(x.n)); }));
  const totals = rows.map((_, ri) => sumOf(cells[ri].map((x) => x.n == null ? 0 : x.n)));
  const maxTot = Math.max(1, ...totals.map((n) => Math.abs(n)));
  const heads = cols.map((c, ci) => {
    const title = `${c.prefix ? `${c.prefix} · ` : ""}${c.name}`;
    const label = `<span class="mx-lab">${esc(c.name)}</span>`;
    return c.children.length
      ? `<button type="button" class="mh" data-act="col" data-i="${ci}" title="${esc(title)}" aria-label="下钻 ${esc(c.name)}">${label}<i class="mx-caret" aria-hidden="true"></i></button>`
      : `<span class="mh" title="${esc(title)}">${label}</span>`;
  }).join("");
  let rowLabels = "", gridCells = "", tots = "";
  rows.forEach((r, ri) => {
    const label = `<span class="mx-lab">${esc(r.name)}</span>${r.children.length ? '<i class="mx-caret" aria-hidden="true"></i>' : ""}`;
    rowLabels += r.children.length
      ? `<button type="button" class="rh" data-act="row" data-i="${ri}" title="${esc(r.name)}" aria-label="下钻 ${esc(r.name)}">${label}</button>`
      : `<span class="rh" title="${esc(r.name)}">${label}</span>`;
    cols.forEach((c, ci) => {
      const cell = cells[ri][ci];
      const v = cell.n;
      const tone = metric === "delta" && v != null ? (v < 0 ? " is-better" : v > 0 ? " is-worse" : " is-zero") : "";
      const zero = metric !== "delta" && v != null && v === 0;
      const on = selected && selected.ri === ri && selected.ci === ci;
      const tip = `${r.name} · ${c.name}|前 ${fmt(cell.before)} · 后 ${sideReady(rnd, "after") ? fmt(cell.after) : DASH} · 线上 ${sideReady(rnd, "online") ? fmt(cell.online) : DASH}`;
      gridCells += v == null || zero
        ? `<span class="cell is-empty" data-mx="${ri}:${ci}"></span>`
        : `<span class="cell num${tone}${on ? " is-sel" : ""}" style="--v:${(0.08 + 0.62 * Math.sqrt(Math.abs(v) / max)).toFixed(3)}" data-act="cell" data-ri="${ri}" data-ci="${ci}" data-mx="${ri}:${ci}" data-tip="${esc(tip)}">${metric === "delta" ? signed(v) : fmt(v)}</span>`;
    });
    tots += `<span class="rowtot num"><i class="${metric === "delta" && totals[ri] < 0 ? "is-better" : metric === "delta" && totals[ri] > 0 ? "is-worse" : ""}" style="width:${(72 * Math.abs(totals[ri])) / maxTot}px"></i>${metric === "delta" ? signed(totals[ri]) : fmt(totals[ri])}</span>`;
  });
  return `<div class="matrix abmatrix" style="--cols:${cols.length};--rows:${rows.length}">
    <div class="mx-rows"><span class="mx-corner" aria-hidden="true"></span>${rowLabels}</div>
    <div class="mx-scroll"><div class="mx-grid">${heads}${gridCells}</div></div>
    <div class="mx-tots"><span class="rowtot-head" title="该场景在当前口径下的问题数合计">${metric === "delta" ? "变化合计" : "问题合计"}</span>${tots}</div>
  </div>`;
}

function fitMatrix(m) {
  if (!m) return;
  const labs = [...m.querySelectorAll(".mh .mx-lab")];
  if (!labs.length) return;
  const need = Math.ceil(Math.max(...labs.map((l) => l.scrollWidth))) + 9;
  m.style.setProperty("--mx-colw", `${need}px`);
  const pane = m.querySelector(".mx-scroll");
  if (pane) {
    pane.classList.toggle("is-overflow", pane.scrollWidth > pane.clientWidth + 1);
    pane.classList.toggle("is-at-end", pane.scrollLeft + pane.clientWidth >= pane.scrollWidth - 2);
  }
}

function walk(root, keys, keyOf) {
  const path = [root];
  for (const k of keys) {
    const next = (path[path.length - 1].children || []).find((n) => keyOf(n) === k);
    if (!next) break;
    path.push(next);
  }
  return path;
}

const rowScope = (row) => ({ name: row.name, task: row.task, sub: row.sub, group: !!row.group, tasks: row.tasks || [] });

function treeCount(rnd, side, row, colPrefix) {
  const cross = crossFor(rnd, side);
  if (!cross) return null;
  let total = 0;
  cross.forEach(([task, sub, pats]) => {
    if (!sceneMatches(row, task || NO_SCENE, sub || "")) return;
    pats.forEach(([pid, n]) => {
      if (pid === colPrefix || String(pid).startsWith(`${colPrefix}.`)) total += num(n);
    });
  });
  return total;
}

export function mountAB(host, data, state, tax, product = null, actions = {}) {
  const rounds = data && Array.isArray(data.rounds) ? data.rounds : [];
  if (!rounds.length) {
    host.innerHTML = `<div class="empty">暂无 AB 测试数据</div>`;
    return;
  }
  const labels = data.labels || {};
  if (!(Number(state.round) >= 0 && Number(state.round) < rounds.length)) state.round = rounds.length - 1;
  state.round = Number(state.round);
  state.step = state.step === "matrix" ? "matrix" : "summary";
  state.rows = Array.isArray(state.rows) ? state.rows : [];
  state.cols = Array.isArray(state.cols) ? state.cols : [];
  state.orbit = state.orbit && typeof state.orbit === "object" && (state.orbit.before || state.orbit.after)
    ? state.orbit : { before: state.orbit || {}, after: {} };
  state.orbit.before = state.orbit.before || {};
  state.orbit.after = state.orbit.after || {};
  state.orbitSide = state.orbitSide === "after" ? "after" : "before";
  state.metric = METRICS.some(([k]) => k === state.metric) ? state.metric : defaultMetric(rounds[state.round]);
  if (((state.metric === "after" || state.metric === "delta") && !sideReady(rounds[state.round], "after"))
      || (state.metric === "online" && !sideReady(rounds[state.round], "online"))) state.metric = "all";
  if (!state.cell || typeof state.cell !== "object") state.cell = null;
  let cellTrendChart = null;
  let cellTrendDrawer = null;
  let orbitApi = null;

  const resetMatrix = () => { state.rows = []; state.cols = []; state.cell = null; };

  function roundBar() {
    const items = rounds.map((r, i) => {
      return `<button type="button" class="ab-round" data-act="round" data-i="${i}" aria-pressed="${i === state.round}" title="${esc(roundLabel(r, i))}">
        <b>${esc(roundLabel(r, i))}</b>
      </button>`;
    }).join("");
    return `<div class="ab-rounds" role="group" aria-label="AB 测试对比记录">${items}</div>`;
  }

  const patternList = Array.isArray(product && product.patterns) ? product.patterns : [];

  function samplesFor(node) {
    const exact = patternList.find((pattern) => pattern.id === node.id);
    if (exact && exact.examples && exact.examples.length) return exact.examples;
    const child = patternList
      .filter((pattern) => String(pattern.id).startsWith(`${node.id}.`) && pattern.examples && pattern.examples.length)
      .sort((a, b) => String(a.id).length - String(b.id).length)[0];
    return child ? child.examples : [];
  }

  function samplePane(node) {
    const rows = samplesFor(node);
    const parts = ["P0", "P1", "P2", "P3", "P4"].map((severity) => ({
      n: rows.filter((row) => row.worst === severity).length,
      c: sevColor(severity),
    })).filter((part) => part.n);
    const body = rows.length
      ? rows.map((row, i) => `<button type="button" class="gl-r" style="--i:${Math.min(i, 8)};--c:${sevColor(row.worst)}" data-sample="${esc(row.slug)}" title="${esc(row.q || row.label || "")}">
          <i></i><span>${esc(row.q || row.label || "（无提问）")}</span><b class="num">${esc(row.model || row.worst || "")}</b>
        </button>`).join("")
      : `<p class="ab-sample-empty">暂无具体样本</p>`;
    return `<div class="gx-side ab-sample-pane">
      <div class="ab-sample-head"><span title="${esc(node.name)}">${esc(node.name)}</span><button type="button" class="link" data-act="orbitBack">← 对比概览</button></div>
      <div class="gl-sum"><b class="num">${fmt(rows.length)}</b><small>个样本</small>${parts.length ? `<span class="gl-strip" aria-hidden="true">${parts.map((part) => `<i style="flex:${part.n} 1 0;background:${part.c}"></i>`).join("")}</span>` : ""}</div>
      <div class="gx-list ab-sample-list">${body}</div>
    </div>`;
  }

  function batchOrbit(rnd) {
    return `<section class="ab-overview" aria-label="A/B Test 改版前后问题对比">
      <div class="ab-orbit-card">
        <div class="seg ab-orbit-switch" id="abOrbitSides" role="group" aria-label="聚类树版本">
          <span class="seg-knob" aria-hidden="true"></span>
          <button type="button" data-value="before" aria-pressed="${state.orbitSide === "before"}">改版前</button>
          <button type="button" data-value="after" aria-pressed="${state.orbitSide === "after"}">改版后</button>
        </div>
        <div class="ab-orbit-sunburst" id="abOrbit" aria-label="聚类树"></div>
      </div>
      <div class="ab-overview-side" id="abOverviewSide">
        <div class="ab-side-pane" data-pane="sides">${abComparisonHTML(rnd)}</div>
        <div class="ab-side-pane" data-pane="samples"></div>
      </div>
    </section>`;
  }

  function orbitTree(rnd, side) {
    const nodes = Array.isArray(rnd.nodes) ? rnd.nodes : [];
    const root = { id: "ab/root", name: "固定题集", n: 0, children: [] };
    const byId = new Map();
    nodes.forEach((node) => {
      const n = side === "after" ? num(node.after) + num(node.online) : num(node.before);
      if (n > 0) byId.set(node.id, { id: node.id, name: node.name || node.id, n, children: [] });
    });
    nodes.forEach((node) => {
      const item = byId.get(node.id);
      if (!item) return;
      const parent = node.parent ? byId.get(node.parent) : root;
      if (parent) parent.children.push(item);
    });
    root.n = root.children.reduce((s, node) => s + node.n, 0);
    return root;
  }

  function changes(rnd) {
    return (Array.isArray(rnd.leaves) ? rnd.leaves : [])
      .filter((leaf) => leaf.after != null || leaf.online != null)
      .map((leaf) => {
        const after = (leaf.after == null ? 0 : num(leaf.after)) + (leaf.online == null ? 0 : num(leaf.online));
        return { leaf, before: num(leaf.before), after, online: leaf.online == null ? null : num(leaf.online), d: after - num(leaf.before) };
      });
  }

  function rankPanel(title, rows, tone, max, total, rnd) {
    const body = rows.length
      ? rows.map((row) => `<button type="button" class="ab-rankrow ${tone}" data-act="focus" data-leaf="${esc(row.leaf.id)}" title="${esc(`${row.leaf.id} · 前 ${fmt(row.before)} → 后 ${fmt(row.after)} · 线上 ${row.online == null ? DASH : fmt(row.online)}`)}">
          <span class="ab-rankname">${esc(row.leaf.name || row.leaf.id)}</span>
          <span class="ab-rankbar"><i style="--w:${Math.max(3, (100 * Math.abs(row.d)) / max).toFixed(1)}%"></i></span>
          <b class="num">${row.before} → ${row.after}</b>
          <small>${row.online > 0 ? `线上 ${fmt(row.online)}` : row.onlineMatched ? "线上同簇" : ""}</small>
        </button>`).join("")
      : `<p class="ab-rankempty">${sideReady(rnd, "after") || sideReady(rnd, "online") ? "暂无变化" : "改版后暂无结果"}</p>`;
    return `<section class="ab-rank ${tone}"><header><span>${title}</span><b class="num">${total}</b></header>${body}</section>`;
  }

  function summary(rnd) {
    const changesNow = changes(rnd);
    const improved = changesNow.filter((x) => x.d < 0).sort((a, b) => a.d - b.d || b.before - a.before);
    const worsened = changesNow.filter((x) => x.d > 0).sort((a, b) => b.d - a.d || b.after - a.after);
    const max = Math.max(1, ...changesNow.map((x) => Math.abs(x.d)));
    const resolved = improved.filter((x) => x.after === 0).length;
    const added = worsened.filter((x) => x.before === 0).length;
    const onlineRows = (Array.isArray(rnd.leaves) ? rnd.leaves : []).filter((leaf) => num(leaf.online) > 0);
    changesNow.forEach((row) => { row.onlineMatched = onlineRows.some((leaf) => pathRelated(row.leaf.id, leaf.id)); });
    return `<section class="ab-summary">
      ${batchOrbit(rnd)}
      <div class="ab-change-head"><span>问题变化</span><span class="ab-change-pills"><i class="is-better"></i>改善 <b class="num">${fmt(improved.length)}</b><i class="is-worse"></i>变差 <b class="num">${fmt(worsened.length)}</b><small>消除 ${fmt(resolved)} · 新增 ${fmt(added)}</small></span></div>
      <div class="ab-summary-grid">${rankPanel("变好的问题", improved.slice(0, 5), "is-better", max, improved.length, rnd)}${rankPanel("变差的问题", worsened.slice(0, 5), "is-worse", max, worsened.length, rnd)}</div>
      <div class="ab-summary-foot"><button type="button" class="link ab-next" data-act="matrix">下一步：查看聚类矩阵 →</button></div>
    </section>`;
  }

  function showOrbitPane(node) {
    const wrap = host.querySelector("#abOverviewSide");
    if (!wrap) return;
    const samples = wrap.querySelector('[data-pane="samples"]');
    const leaf = node && (!node.children || !node.children.length);
    if (!leaf) {
      wrap.classList.remove("is-sample");
      if (samples) samples.innerHTML = "";
      return;
    }
    if (samples) samples.innerHTML = samplePane(node);
    wrap.classList.add("is-sample");
  }

  function mountOrbit(rnd, animate = true) {
    const orbitHost = host.querySelector("#abOrbit");
    if (!orbitHost) { orbitApi = null; return; }
    const tree = orbitTree(rnd, state.orbitSide);
    const ready = state.orbitSide === "before" ? sideReady(rnd, "before") : sideReady(rnd, "after") || sideReady(rnd, "online");
    orbitApi = sunburst(orbitHost, tree, {
      unit: ready ? "个问题" : "暂无结果", sort: true, state: state.orbit[state.orbitSide], animate: animate && !REDUCED,
      onChange: (_focus, open) => showOrbitPane(open),
    });
  }

  function trend(rnd, selectedCell) {
    if (!selectedCell) return "";
    const { row, col } = selectedCell;
    const rows = rounds.map((r, i) => ({
      label: roundLabel(r, i),
      before: treeCount(r, "before", row, col.prefix),
      after: (() => {
        const after = treeCount(r, "after", row, col.prefix);
        const online = treeCount(r, "online", row, col.prefix);
        return after == null && online == null ? null : num(after) + num(online);
      })(),
    }));
    const cur = rows[state.round];
    const cols = rows.length === 1 ? ["改版前", "改版后"] : rows.map((r) => r.label);
    const series = rows.length === 1
      ? [{ label: col.name, color: "var(--accent)", values: [cur.before, cur.after], samples: [{ round: rnd, sides: ["before"] }, { round: rnd, sides: ["after", "online"] }] }]
      : [
          { label: "改版前", color: "var(--t2)", values: rows.map((r) => r.before), samples: rounds.map((round) => ({ round, sides: ["before"] })) },
          { label: "改版后", color: "var(--accent)", values: rows.map((r) => r.after), samples: rounds.map((round) => ({ round, sides: ["after", "online"] })) },
        ];
    const aria = `AB 趋势：${row.name} · ${col.name}，${rows.map((r) => `${r.label} 改版前 ${r.before == null ? "无" : fmt(r.before)} 改版后 ${r.after == null ? "无" : fmt(r.after)}`).join("；")}`;
    const width = host.getBoundingClientRect().width || 720;
    const chart = { height: 260, yAxis: true, endLabels: series.every((s) => s.values[s.values.length - 1] != null), xLabels: cols, xDates: cols, series, aria, formatValue: fmt };
    cellTrendChart = { chart, row, node: col.prefix };
    return `<section class="ab-trend is-on" aria-live="polite">
      <div class="ab-trendhead"><span class="ab-trendname">${esc(row.name)} · ${esc(col.name)}</span></div>
      ${trendSampleFrame(`<div class="mxt-plot" id="abCellTrend" data-own-tip>${lineTrendSVG({ ...chart, width }).html}</div>`)}
    </section>`;
  }

  function metricChips(rnd) {
    return METRICS.map(([key, label]) => {
      const disabled = (key === "after" && !sideReady(rnd, "after"))
        || (key === "online" && !sideReady(rnd, "online"))
        || (key === "delta" && !sideReady(rnd, "after"));
      return `<button type="button" class="ab-chip" data-act="metric" data-metric="${key}" aria-pressed="${state.metric === key}"${disabled ? " disabled" : ""}>${label}</button>`;
    }).join("");
  }

  function matrix(rnd) {
    const names = new Map((Array.isArray(rnd.nodes) ? rnd.nodes : []).map((n) => [n.id, n.name]));
    const cross = allCross(rnd);
    const sceneRoot = { name: "全部", children: capScenes(sceneTree(cross)) };
    const clusterRoot = clusterTree(cross, tax || {}, names);
    const rowPath = walk(sceneRoot, state.rows, (n) => n.name);
    const colPath = walk(clusterRoot, state.cols, (n) => n.prefix);
    state.rows = rowPath.slice(1).map((n) => n.name);
    state.cols = colPath.slice(1).map((n) => n.prefix);
    const rowNode = rowPath[rowPath.length - 1];
    const colNode = colPath[colPath.length - 1];
    const view = matrixViewAb(rnd, rowNode.children || [], colNode.children || [], state.metric);
    let selectedIdx = null;
    if (state.cell) {
      const ri = view.rows.findIndex((r) => sceneMatches(state.cell.row, r.task || NO_SCENE, r.sub || ""));
      const ci = view.cols.findIndex((c) => c.prefix === state.cell.col.prefix);
      if (ri >= 0 && ci >= 0) selectedIdx = { ri, ci };
      else state.cell = null;
    }
    const back = '<button type="button" class="link ab-back" data-act="summary">← 返回汇总</button>'
      + (rowPath.length > 1 || colPath.length > 1 ? '<button type="button" class="link ab-back ab-up" data-act="back">← 上一级</button>' : "");
    return `<section class="ab-matrixstep">
      <div class="ab-matrixhead"><div class="ab-matrix-title">${back}<h3>聚类矩阵</h3></div><div class="ab-metrics" role="group" aria-label="矩阵口径">${metricChips(rnd)}</div><span class="ab-matrixmeta">${esc(roundLabel(rnd, state.round))} · ${esc(rnd.released_at || (rnd.dates || []).join(" ~ ") || "")}</span></div>
      <div class="ab-mxshell" id="abMxShell">${matrixTableAb(view, rnd, state.metric, selectedIdx)}</div>
      ${trend(rnd, state.cell)}
    </section>`;
  }

  function render() {
    cellTrendDrawer?.destroy();
    cellTrendDrawer = null;
    cellTrendChart = null;
    const rnd = rounds[state.round];
    host.innerHTML = `<div class="abw">${roundBar()}${state.step === "matrix" ? matrix(rnd) : summary(rnd)}</div>`;
    const sideSwitch = host.querySelector("#abOrbitSides");
    if (sideSwitch) {
      const control = segmented(sideSwitch, (side) => {
        if (side === state.orbitSide) return;
        state.orbitSide = side;
        showOrbitPane(null);
        const orbitHost = host.querySelector("#abOrbit");
        if (!orbitHost) return;
        mountOrbit(rnd, true);
      });
      control.set(state.orbitSide, { silent: true });
    }
    mountOrbit(rnd, true);
    const chartHost = host.querySelector("#abCellTrend");
    if (chartHost && cellTrendChart) {
      if (actions.mountCellTrend) cellTrendDrawer = actions.mountCellTrend(chartHost, cellTrendChart);
      else wireLineTrendChart(chartHost, lineTrendSVG({ ...cellTrendChart.chart, width: chartHost.clientWidth }));
    }
    requestAnimationFrame(() => fitMatrix(host.querySelector(".abmatrix")));
  }

  host.addEventListener("click", (e) => {
    const sample = e.target.closest("[data-sample]");
    if (sample) {
      actions.openSample && actions.openSample(sample.dataset.sample);
      return;
    }
    const action = e.target.closest("[data-act]");
    if (!action) return;
    const act = action.dataset.act;
    const rnd = rounds[state.round];
    if (act === "orbitBack") { if (orbitApi) orbitApi.up(); return; }
    if (act === "round") {
      const i = Number(action.dataset.i);
      if (!(i >= 0 && i < rounds.length) || i === state.round) return;
      state.round = i;
      state.step = "summary";
      state.metric = defaultMetric(rounds[i]);
      state.orbit = { before: {}, after: {} };
      state.orbitSide = "before";
      resetMatrix();
      render();
      return;
    }
    if (act === "matrix") { state.step = "matrix"; resetMatrix(); render(); return; }
    if (act === "summary") { state.step = "summary"; render(); return; }
    if (act === "back") {
      if (state.cols.length) state.cols.pop();
      else state.rows.pop();
      state.cell = null;
      render();
      return;
    }
    if (act === "focus") {
      const leaf = (Array.isArray(rnd.leaves) ? rnd.leaves : []).find((item) => item.id === action.dataset.leaf);
      if (!leaf) return;
      state.step = "matrix";
      state.metric = defaultMetric(rnd);
      state.rows = [];
      state.cols = leaf.id.split(".").slice(0, -1);
      state.cell = null;
      render();
      return;
    }
    if (act === "metric") {
      const next = action.dataset.metric;
      if (!METRICS.some(([key]) => key === next) || action.disabled) return;
      if ((next === "after" || next === "delta") && !sideReady(rnd, "after")) return;
      if (next === "online" && !sideReady(rnd, "online")) return;
      state.metric = next;
      state.cell = null;
      render();
      return;
    }
    if (act === "row" || act === "col") {
      const names = new Map((Array.isArray(rnd.nodes) ? rnd.nodes : []).map((n) => [n.id, n.name]));
      const cross = allCross(rnd);
      const sceneRoot = { name: "全部", children: capScenes(sceneTree(cross)) };
      const clusterRoot = clusterTree(cross, tax || {}, names);
      const rowPath = walk(sceneRoot, state.rows, (n) => n.name);
      const colPath = walk(clusterRoot, state.cols, (n) => n.prefix);
      const node = act === "row"
        ? (rowPath[rowPath.length - 1].children || [])[Number(action.dataset.i)]
        : (colPath[colPath.length - 1].children || [])[Number(action.dataset.i)];
      if (!node) return;
      if (act === "row") state.rows.push(node.name);
      else state.cols.push(node.prefix);
      state.cell = null;
      render();
      return;
    }
    if (act === "cell") {
      const ri = Number(action.dataset.ri);
      const ci = Number(action.dataset.ci);
      const names = new Map((Array.isArray(rnd.nodes) ? rnd.nodes : []).map((n) => [n.id, n.name]));
      const cross = allCross(rnd);
      const sceneRoot = { name: "全部", children: capScenes(sceneTree(cross)) };
      const clusterRoot = clusterTree(cross, tax || {}, names);
      const rowPath = walk(sceneRoot, state.rows, (n) => n.name);
      const colPath = walk(clusterRoot, state.cols, (n) => n.prefix);
      const row = (rowPath[rowPath.length - 1].children || [])[ri];
      const col = (colPath[colPath.length - 1].children || [])[ci];
      if (!row || !col) return;
      state.cell = { row: rowScope(row), col: { name: col.name, prefix: col.prefix } };
      render();
    }
  });

  host.addEventListener("pointerover", (e) => {
    const cell = e.target.closest(".cell[data-mx]");
    const table = host.querySelector(".abmatrix");
    if (!table) return;
    if (!cell || cell.classList.contains("is-empty")) {
      table.classList.remove("is-hover");
      table.querySelectorAll(".is-hl, .is-cur").forEach((x) => x.classList.remove("is-hl", "is-cur"));
      return;
    }
    const [ri, ci] = cell.dataset.mx.split(":").map(Number);
    table.classList.add("is-hover");
    table.querySelectorAll(".cell").forEach((c) => {
      const [r, k] = (c.dataset.mx || "").split(":").map(Number);
      c.classList.toggle("is-hl", r === ri || k === ci);
      c.classList.toggle("is-cur", r === ri && k === ci);
    });
    table.querySelectorAll(".rh").forEach((h, i) => h.classList.toggle("is-hl", i === ri));
    table.querySelectorAll(".mh").forEach((h, i) => h.classList.toggle("is-hl", i === ci));
    table.querySelectorAll(".rowtot").forEach((h, i) => h.classList.toggle("is-hl", i === ri));
  });

  host.addEventListener("scroll", (e) => {
    const pane = e.target;
    if (!pane.classList || !pane.classList.contains("mx-scroll")) return;
    pane.classList.toggle("is-at-end", pane.scrollLeft + pane.clientWidth >= pane.scrollWidth - 2);
  }, true);

  const onResize = () => {
    if (!host.isConnected) { window.removeEventListener("resize", onResize); return; }
    fitMatrix(host.querySelector(".abmatrix"));
  };
  window.addEventListener("resize", onResize);
  render();
}
