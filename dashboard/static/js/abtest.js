/* AB Test: one fixed question set before / after a release, plus post-release real-user
   online validation. The outer step answers whether the fixed-set problems moved; the next
   step keeps the normal cluster-matrix interaction (scene × cluster drill, cell trend).

   The three sides are deliberately not one denominator:
   - before / after are the same fixed targets and can be subtracted;
   - online is a different real-user population and is shown as validation only.
   The matrix reads either the paired change, the pre-release baseline, or the
   post-release volume (retest + online), matching the orbit tree's release side.
   State lives in data.js's u.ab so an in-place dashboard refresh returns to the same round,
   summary / matrix step, metric and selected cell. */
import { esc, fmt, REDUCED, sevColor, segmented } from "./core.js";
import { sunburst } from "./sunburst.js";
import { lineTrendSVG, wireLineTrendChart } from "./trend_chart.js";
import { trendSampleFrame, abTrendSampleRefs } from "./trend_samples.js";

const SIDES = ["before", "after", "online"];
const SIDE_SHORT = { before: "改版前", after: "改版后", online: "线上" };
const METRICS = [
  ["paired", "同题变化"],
  ["delta", "同题+线上变化"],
  ["before", "发版前"],
  ["post", "发版后（同题回测+线上真实）"],
];
const NO_SCENE = "未接入分类体系";
// The round may test one model or both; the page only needs the three pre-defined tags.
const MODEL_BADGE = { expert: "expert", fast: "fast", both: "fast+expert" };
const modelBadge = (rnd) => {
  const models = new Set((Array.isArray(rnd.models) ? rnd.models : []).map((m) => String(m || "").toLowerCase()));
  const fast = models.has("fast");
  const expert = models.has("expert");
  if (fast && expert) return MODEL_BADGE.both;
  if (expert) return MODEL_BADGE.expert;
  if (fast) return MODEL_BADGE.fast;
  return "";
};
const DASH = "—";
const num = (v) => Number(v) || 0;
const signed = (v) => (v > 0 ? `+${fmt(v)}` : v < 0 ? `−${fmt(-v)}` : "0");
const sumOf = (list) => list.reduce((s, v) => s + num(v), 0);
const pathRelated = (a, b) => a === b || String(a).startsWith(`${b}.`) || String(b).startsWith(`${a}.`);
const SIDE_TONE = { before: "var(--t2)", after: "var(--accent)", online: "var(--loc-ulq)" };
/* The overview is three cards sharing one row: the release tree, the paired change broken into its
   four flows, and the three release populations.  Any card can take the row while the other two
   fold, borrowing the bento push-pull: measure, switch the layout, play every card from its old box. */
const OVERVIEW_CARDS = ["orbit", "bridge", "sides"];
const BAR_H = 112;
const PUSH_ICON = `<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M2.5 8h3.2M2.5 8 5.1 5.4M2.5 8 5.1 10.6M13.5 8H10.3M13.5 8l-2.6-2.6M13.5 8l-2.6 2.6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

const sideReady = (rnd, side) => !!(rnd.sides && rnd.sides[side]);
const postReady = (rnd) => sideReady(rnd, "after") || sideReady(rnd, "online");
const defaultMetric = (rnd) => (sideReady(rnd, "after") ? "paired" : postReady(rnd) ? "delta" : "before");
const roundLabel = (rnd, i) => rnd.label || rnd.release_label || `第 ${i + 1} 期`;

/* The comparison records live in the card head, so a new AB round is one more chip there instead of
   another row above the charts.  The model tag stays the only thing a round adds to its label. */
export function abRoundsHTML(rounds, active) {
  return (Array.isArray(rounds) ? rounds : []).map((r, i) => {
    const badge = modelBadge(r);
    const label = roundLabel(r, i);
    return `<button type="button" class="ab-round" data-act="round" data-i="${i}" aria-pressed="${i === active}" title="${esc(label)}${badge ? ` · ${badge}` : ""}"><b>${esc(label)}</b>${badge ? `<small class="ab-model">${esc(badge)}</small>` : ""}</button>`;
  }).join("");
}

/* Reuse 评测量 bars, grouping the two post-release populations without mixing them.  The bars are
   one of three overview cards, so each column prints its own count and the volume behind it. */
export function abComparisonHTML(rnd) {
  const labels = { before: "同题基线", after: "同题复测", online: "线上真实" };
  const max = Math.max(1, ...SIDES.map((side) => num(rnd.sides?.[side]?.hits)));
  const columns = SIDES.map((side) => {
    const result = rnd.sides?.[side];
    const n = result ? num(result.hits) : null;
    const traces = result?.traces == null ? DASH : fmt(result.traces);
    // Fixed-set extracts count only traces with cluster paths; online counts evaluated records.
    const volumeLabel = side === "online" ? "评测样本" : "有问题 Trace";
    const h = n == null ? 0 : Math.max(3, Math.round((BAR_H * n) / max));
    return `<div class="evday${result ? "" : " is-missing"}">
      <div class="evnums"><b class="num">${n == null ? DASH : fmt(n)}</b></div>
      <div class="ab-result-column">${n == null
        ? '<span class="ab-result-empty">暂无结果</span>'
        : `<div class="evbar" style="height:${h}px;--c:${SIDE_TONE[side]}" data-tip="${SIDE_SHORT[side]} · ${labels[side]}|${fmt(n)} 个问题|${traces} ${volumeLabel}"><i style="height:100%"></i></div>`}</div>
      <span class="evdate">${labels[side]}</span><small class="ab-result-volume"><b class="num">${traces}</b><span>${volumeLabel}</span></small>
    </div>`;
  }).join("");
  return `<div class="ab-results"><header><span>问题数量</span></header><div class="ab-result-groups"><span>改版前</span><span>改版后</span></div><div class="evrow ab-result-bars" style="--n:3;--bar-h:${BAR_H}px">${columns}</div></div>`;
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

export function metricValue(cell, metric, rnd) {
  if (metric === "before") return cell.before;
  if (metric === "post") {
    const after = sideReady(rnd, "after") ? cell.after : null;
    const online = sideReady(rnd, "online") ? cell.online : null;
    return after == null && online == null ? null : num(after) + num(online);
  }
  if (metric === "paired") return sideReady(rnd, "after") ? cell.after - cell.before : null;
  if (metric === "delta") {
    const post = metricValue(cell, "post", rnd);
    return sideReady(rnd, "before") && post != null ? post - cell.before : null;
  }
  return null;
}

/* The tooltip must explain the number printed in the cell, with the same sides and arithmetic.
   Two change readings are offered because the release side has two populations:
   - 同题变化: 同题复测 − 同题基线 (the fixed set alone);
   - 同题+线上变化: 发版后（同题复测 + 线上真实）− 同题基线. */
export function metricTip(cell, metric, rnd) {
  if (metric === "before") return { value: `发版前 ${fmt(cell.before)}`, note: "同题基线" };
  const afterReady = sideReady(rnd, "after");
  const onlineReady = sideReady(rnd, "online");
  const post = metricValue(cell, "post", rnd);
  if (metric === "post") {
    return {
      value: `发版后 ${post == null ? DASH : fmt(post)}`,
      note: `同题复测 ${afterReady ? fmt(cell.after) : DASH} + 线上真实 ${onlineReady ? fmt(cell.online) : DASH}`,
    };
  }
  if (metric === "paired") {
    const value = metricValue(cell, "paired", rnd);
    return {
      value: value == null ? `同题变化 ${DASH}` : `同题变化 ${signed(value)}`,
      note: `同题基线 ${fmt(cell.before)} → 同题复测 ${afterReady ? fmt(cell.after) : DASH}`,
    };
  }
  const value = metricValue(cell, "delta", rnd);
  const note = post == null
    ? "发版后缺失，无法计算同题+线上变化"
    : `同题基线 ${fmt(cell.before)} → 发版后 ${fmt(post)}（同题复测 ${afterReady ? fmt(cell.after) : DASH} + 线上真实 ${onlineReady ? fmt(cell.online) : DASH}）`;
  return { value: value == null ? `同题+线上变化 ${DASH}` : `同题+线上变化 ${signed(value)}`, note };
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
  // Both change readings are signed: a real 0 is data, so it is printed (unlike a 0 count).
  const change = metric === "paired" || metric === "delta";
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
      const tone = change && v != null ? (v < 0 ? " is-better" : v > 0 ? " is-worse" : " is-zero") : "";
      const zero = !change && v != null && v === 0;
      const on = selected && selected.ri === ri && selected.ci === ci;
      const tipParts = metricTip(cell, metric, rnd);
      const tip = `${r.name} · ${c.name}|${tipParts.value}|${tipParts.note}`;
      gridCells += v == null || zero
        ? `<span class="cell is-empty" data-abmx="${ri}:${ci}"></span>`
        : `<span class="cell num${tone}${on ? " is-sel" : ""}" style="--v:${(0.08 + 0.62 * Math.sqrt(Math.abs(v) / max)).toFixed(3)}" data-act="cell" data-ri="${ri}" data-ci="${ci}" data-abmx="${ri}:${ci}" data-tip="${esc(tip)}">${change ? signed(v) : fmt(v)}</span>`;
    });
    tots += `<span class="rowtot num"><i class="${change && totals[ri] < 0 ? "is-better" : change && totals[ri] > 0 ? "is-worse" : ""}" style="width:${(72 * Math.abs(totals[ri])) / maxTot}px"></i>${change ? signed(totals[ri]) : fmt(totals[ri])}</span>`;
  });
  return `<div class="matrix abmatrix" style="--cols:${cols.length};--rows:${rows.length}">
    <div class="mx-rows"><span class="mx-corner" aria-hidden="true"></span>${rowLabels}</div>
    <div class="mx-scroll"><div class="mx-grid">${heads}${gridCells}</div></div>
    <div class="mx-tots"><span class="rowtot-head" title="该场景在当前口径下的问题数合计">${change ? "变化合计" : "问题合计"}</span>${tots}</div>
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
  const current = rounds[state.round];
  if (state.metric === "paired" && !sideReady(current, "after")) state.metric = defaultMetric(current);
  if ((state.metric === "delta" || state.metric === "post") && !postReady(current)) state.metric = defaultMetric(current);
  state.overviewOpen = OVERVIEW_CARDS.includes(state.overviewOpen) ? state.overviewOpen : "";
  if (!state.cell || typeof state.cell !== "object") state.cell = null;
  let cellTrendChart = null;
  let cellTrendDrawer = null;
  let orbitApi = null;
  let overviewTimer = 0;
  /* The records and the fullscreen control sit in the card head, outside the body re-rendered here. */
  const face = typeof host.closest === "function" ? host.closest(".mx-ab-face") : null;
  const roundsHost = face ? face.querySelector("#abRounds") : null;

  const resetMatrix = () => { state.rows = []; state.cols = []; state.cell = null; };

  function pickRound(i) {
    if (!(i >= 0 && i < rounds.length) || i === state.round) return;
    state.round = i;
    state.step = "summary";
    state.metric = defaultMetric(rounds[i]);
    state.orbit = { before: {}, after: {} };
    state.orbitSide = "before";
    state.overviewOpen = "";
    resetMatrix();
    render();
  }

  if (roundsHost) {
    roundsHost.addEventListener("click", (e) => {
      const btn = e.target.closest('[data-act="round"]');
      if (btn) pickRound(Number(btn.dataset.i));
    });
  }

  const patternList = Array.isArray(product && product.patterns) ? product.patterns : [];

  function samplesFor(node) {
    const models = Array.isArray(rounds[state.round].models) ? rounds[state.round].models.map(String) : [];
    // The round may test one model: a sample from the other one would disagree with every count here.
    const inScope = (row) => !models.length || !row.model || models.some((m) => String(row.model).includes(m));
    const exact = patternList.find((pattern) => pattern.id === node.id);
    if (exact && exact.examples && exact.examples.length) return exact.examples.filter(inScope);
    const child = patternList
      .filter((pattern) => String(pattern.id).startsWith(`${node.id}.`) && pattern.examples && pattern.examples.length)
      .sort((a, b) => String(a.id).length - String(b.id).length)[0];
    return child ? child.examples.filter(inScope) : [];
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

  /* One quiet control in each card's corner: it is the way into the card and the way back out. */
  function pushButton(card, name) {
    const open = state.overviewOpen === card;
    const label = `${open ? "收起" : "放大"}${name}`;
    return `<button type="button" class="ab-card-btn" data-act="abcard" data-card="${card}" aria-pressed="${open}" aria-label="${label}" title="${esc(label)}">${PUSH_ICON}</button>`;
  }

  function orbitCard() {
    return `<section class="ab-card ab-orbit-card${state.overviewOpen === "orbit" ? " is-deep" : state.overviewOpen ? " is-compact" : ""}" data-abcard="orbit" data-abname="聚类树">
      <div class="ab-card-top">
        <div class="seg ab-orbit-switch" id="abOrbitSides" role="group" aria-label="聚类树版本">
          <span class="seg-knob" aria-hidden="true"></span>
          <button type="button" data-value="before" aria-pressed="${state.orbitSide === "before"}">改版前</button>
          <button type="button" data-value="after" aria-pressed="${state.orbitSide === "after"}">改版后</button>
        </div>
        ${pushButton("orbit", "聚类树")}
      </div>
      <div class="ab-orbit-sunburst" id="abOrbit" aria-label="聚类树"></div>
    </section>`;
  }

  /* 同题变化 split by what the release did to each problem: cleared out, fallen back, climbed, or
     newly appeared.  The four flows add up to the same net the two bars carry. */
  function changeFlows(rnd) {
    const flows = [
      { key: "clear", name: "消除", sign: -1, dir: "is-better", n: 0, count: 0 },
      { key: "down", name: "减少", sign: -1, dir: "is-better", n: 0, count: 0 },
      { key: "up", name: "增加", sign: 1, dir: "is-worse", n: 0, count: 0 },
      { key: "add", name: "新增", sign: 1, dir: "is-worse", n: 0, count: 0 },
    ];
    const by = new Map(flows.map((flow) => [flow.key, flow]));
    (Array.isArray(rnd.leaves) ? rnd.leaves : []).forEach((leaf) => {
      if (leaf.after == null) return;
      const before = num(leaf.before);
      const after = num(leaf.after);
      const key = before > 0 && after === 0 ? "clear"
        : before > 0 && after > 0 && after < before ? "down"
          : before === 0 && after > 0 ? "add"
            : before > 0 && after > before ? "up" : "";
      const flow = by.get(key);
      if (!flow) return;
      flow.n += key === "clear" ? before : key === "down" ? before - after : key === "add" ? after : after - before;
      flow.count += 1;
    });
    return flows;
  }

  function bridgeCard(rnd) {
    const before = num(rnd.sides?.before?.hits);
    const after = num(rnd.sides?.after?.hits);
    const net = after - before;
    const flows = changeFlows(rnd);
    const max = Math.max(1, ...flows.map((flow) => flow.n));
    const rows = flows.map((flow) => `<div class="ab-flow ${flow.dir}" title="${esc(`${flow.name} ${signed(flow.sign * flow.n)} 个问题 · ${flow.count} 个问题类型`)}">
      <span>${flow.name}</span>
      <i class="ab-flow-bar"><b style="--w:${flow.n ? Math.max(2, (100 * flow.n) / max).toFixed(1) : 0}%"></b></i>
      <b class="num">${signed(flow.sign * flow.n)}</b>
    </div>`).join("");
    return `<section class="ab-card ab-bridge-card${state.overviewOpen === "bridge" ? " is-deep" : state.overviewOpen ? " is-compact" : ""}" data-abcard="bridge" data-abname="变化构成">
      <div class="ab-card-top"><span class="ab-bridge-pair num">${fmt(before)}<i>→</i>${fmt(after)}</span>${pushButton("bridge", "变化构成")}</div>
      <div class="ab-bridge-main"><b class="num${net < 0 ? " is-better" : net > 0 ? " is-worse" : ""}">${signed(net)}</b><small>个问题</small></div>
      <div class="ab-flows">${rows}</div>
    </section>`;
  }

  function sidesCard(rnd) {
    return `<section class="ab-card ab-sides-card ab-overview-side${state.overviewOpen === "sides" ? " is-deep" : state.overviewOpen ? " is-compact" : ""}" id="abOverviewSide" data-abcard="sides" data-abname="问题数量">
      <div class="ab-side-pane" data-pane="sides">${abComparisonHTML(rnd)}</div>
      <div class="ab-side-pane" data-pane="samples"></div>
      ${pushButton("sides", "问题数量")}
    </section>`;
  }

  function overview(rnd) {
    const paired = sideReady(rnd, "before") && sideReady(rnd, "after");
    return `<section class="ab-overview" id="abOverview" data-open="${state.overviewOpen}" data-cards="${paired ? 3 : 2}" aria-label="A/B Test 改版前后问题对比">
      ${orbitCard()}
      ${paired ? bridgeCard(rnd) : ""}
      ${sidesCard(rnd)}
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
    // 同题变化: the ranking and its counts stay on the paired fixed set.  The online batch is a
    // different population, so it is shown as evidence on each row instead of being added in.
    return (Array.isArray(rnd.leaves) ? rnd.leaves : [])
      .filter((leaf) => leaf.after != null)
      .map((leaf) => ({
        leaf, before: num(leaf.before), after: num(leaf.after),
        online: leaf.online == null ? null : num(leaf.online), d: num(leaf.after) - num(leaf.before),
      }));
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
    const onlineRows = (Array.isArray(rnd.leaves) ? rnd.leaves : []).filter((leaf) => num(leaf.online) > 0);
    changesNow.forEach((row) => { row.onlineMatched = onlineRows.some((leaf) => pathRelated(row.leaf.id, leaf.id)); });
    return `<section class="ab-summary">
      ${overview(rnd)}
      <div class="ab-change-head"><span title="同题变化：同题复测 − 同题基线；线上真实只在「问题数量」和矩阵的「同题+线上变化 / 发版后」里计入">问题变化（同题）</span><span class="ab-change-pills"><i class="is-better"></i>改善 <b class="num">${fmt(improved.length)}</b><i class="is-worse"></i>变差 <b class="num">${fmt(worsened.length)}</b></span></div>
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

  function trend(rnd, selectedCell, metric) {
    if (!selectedCell) return "";
    const { row, col } = selectedCell;
    const before = treeCount(rnd, "before", row, col.prefix);
    const fixedAfter = treeCount(rnd, "after", row, col.prefix);
    const online = treeCount(rnd, "online", row, col.prefix);
    // 同题变化 reads the fixed set alone; 同题+线上变化 / 发版后 add the real-user batch.
    const withOnline = metric === "delta" || metric === "post";
    const releaseCount = (r) => {
      const after = treeCount(r, "after", row, col.prefix);
      if (!withOnline) return after;
      const live = treeCount(r, "online", row, col.prefix);
      return after == null && live == null ? null : num(after) + num(live);
    };
    const rows = rounds.map((r, i) => ({
      label: roundLabel(r, i),
      before: treeCount(r, "before", row, col.prefix),
      after: releaseCount(r),
    }));
    const cur = rows[state.round];
    const afterLabel = withOnline ? "发版后" : "改版后";
    const cols = rows.length === 1 ? ["改版前", afterLabel] : rows.map((r) => r.label);
    const second = withOnline ? ["after", "online"] : ["after"];
    const series = rows.length === 1
      ? [{ label: col.name, color: "var(--accent)", values: [cur.before, cur.after], samples: [{ round: rnd, sides: ["before"] }, { round: rnd, sides: second }] }]
      : [
          { label: "改版前", color: "var(--t2)", values: rows.map((r) => r.before), samples: rounds.map((r) => ({ round: r, sides: ["before"] })) },
          { label: afterLabel, color: "var(--accent)", values: rows.map((r) => r.after), samples: rounds.map((r) => ({ round: r, sides: second })) },
        ];
    const releaseTotal = fixedAfter == null && online == null ? null : num(fixedAfter) + num(online);
    const current = metric === "post"
      ? releaseTotal
      : metric === "paired" ? (fixedAfter == null ? null : fixedAfter - before)
      : metric === "before" ? before
      : (releaseTotal == null || before == null ? null : releaseTotal - before);
    const detail = metric === "post"
      ? `同题复测 ${fmt(fixedAfter)} + 线上真实 ${fmt(online)}`
      : metric === "before"
        ? "同题基线"
        : metric === "paired"
          ? `同题基线 ${fmt(before)} → 同题复测 ${fmt(fixedAfter)}`
          : releaseTotal == null
            ? "发版后缺失，无法计算同题+线上变化"
            : `同题基线 ${fmt(before)} → 发版后 ${fmt(releaseTotal)}（同题复测 ${fmt(fixedAfter)} + 线上真实 ${fmt(online)}）`;
    // Sample recall is per side, not per metric: the cell's samples stay recallable even when the
    // printed number is a paired delta. The retest side has no detail page in 5002, so it only
    // gets a chip when its refs actually carry a slug.
    const sampleSides = [
      { sides: ["before"], source: "改版前" },
      { sides: ["after"], source: "改版后" },
      { sides: ["online"], source: "线上真实" },
    ];
    const chips = sampleSides.map(({ sides, source }) => {
      const refs = abTrendSampleRefs(rnd, sides, row, col.prefix);
      const resolvable = sides[0] === "after" ? refs.some((ref) => ref.slug) : refs.length > 0;
      if (!resolvable) return "";
      return `<button type="button" class="ab-samplechip" data-act="samples" data-sides="${sides.join(",")}" data-source="${source}" title="召回「${source}」命中 ${esc(row.name)} × ${esc(col.name)} 的样本">${source}样本 <b class="num">${fmt(refs.length)}</b></button>`;
    }).join("");
    const aria = `AB 趋势：${row.name} · ${col.name}，${rows.map((r) => `${r.label} 改版前 ${r.before == null ? "无" : fmt(r.before)} ${afterLabel} ${r.after == null ? "无" : fmt(r.after)}`).join("；")}`;
    const width = host.getBoundingClientRect().width || 720;
    // One round compares two batches, so the release sits on the boundary between them; mark it
    // with a full-height release line, labelled with the version that shipped.
    const releaseMarks = rows.length === 1 ? [{ at: 0.5, label: roundLabel(rnd, state.round) }] : null;
    const chart = { height: 260, yAxis: true, minTop: 4, endLabels: series.every((s) => s.values[s.values.length - 1] != null), xLabels: cols, xDates: cols, series, aria, formatValue: fmt, marks: releaseMarks };
    cellTrendChart = { chart, row, node: col.prefix, colName: col.name };
    return `<section class="ab-trend is-on" aria-live="polite">
      <div class="ab-trendhead">
        <span class="ab-trendname">${esc(row.name)} · ${esc(col.name)}</span>
        <span class="ab-trendmetric">${esc(metric === "post" ? "发版后" : metric === "before" ? "发版前" : metric === "paired" ? "同题变化" : "同题+线上变化")} <b class="num">${current == null ? DASH : metric === "paired" || metric === "delta" ? signed(current) : fmt(current)}</b><small>${esc(detail)}</small></span>
        <span class="ab-trendacts">${chips || '<small class="ab-trendhint">当前簇没有可召回样本</small>'}</span>
      </div>
      ${trendSampleFrame(`<div class="mxt-plot" id="abCellTrend" data-own-tip>${lineTrendSVG({ ...chart, width }).html}</div>`)}
    </section>`;
  }

  function metricChips(rnd) {
    return METRICS.map(([key, label]) => {
      const disabled = (key === "paired" && !sideReady(rnd, "after"))
        || ((key === "delta" || key === "post") && !postReady(rnd));
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
      ${trend(rnd, state.cell, state.metric)}
    </section>`;
  }

  /* Open one overview card and fold the other two, the same move the bento cards make: switch the
     row first, then play every card from its old box so neighbours stay edge to edge. */
  function setOverviewOpen(next) {
    const row = host.querySelector("#abOverview");
    if (!row) return;
    if (state.overviewOpen === next) next = "";
    if (next === "bridge" && !(sideReady(rounds[state.round], "before") && sideReady(rounds[state.round], "after"))) next = "";
    const cards = [...row.querySelectorAll(":scope > .ab-card")];
    const first = new Map(cards.map((card) => [card, card.getBoundingClientRect()]));
    state.overviewOpen = next;
    row.dataset.open = next;
    cards.forEach((card) => {
      const deep = card.dataset.abcard === next;
      card.classList.toggle("is-deep", deep);
      card.classList.toggle("is-compact", !!next && !deep);
      const btn = card.querySelector(".ab-card-btn");
      if (btn) {
        const label = `${deep ? "收起" : "放大"}${card.dataset.abname || ""}`;
        btn.setAttribute("aria-pressed", String(deep));
        btn.setAttribute("aria-label", label);
        btn.title = label;
      }
    });
    if (!REDUCED) {
      cards.forEach((card) => {
        const a = first.get(card);
        const b = card.getBoundingClientRect();
        if (!a || (Math.abs(a.left - b.left) < 0.5 && Math.abs(a.width - b.width) < 0.5)) return;
        card.getAnimations().forEach((anim) => anim.cancel());
        card.animate([
          { transform: `translateX(${a.left - b.left}px)`, width: `${a.width}px` },
          { transform: "none", width: `${b.width}px` },
        ], { duration: 460, easing: "cubic-bezier(0.16, 1, 0.3, 1)" });
      });
    }
    // The tree is drawn for its box: redraw it once the row has settled.
    clearTimeout(overviewTimer);
    overviewTimer = setTimeout(() => {
      if (host.isConnected) mountOrbit(rounds[state.round], false);
    }, 480);
  }

  function render() {
    cellTrendDrawer?.destroy();
    cellTrendDrawer = null;
    cellTrendChart = null;
    const rnd = rounds[state.round];
    if (roundsHost) roundsHost.innerHTML = abRoundsHTML(rounds, state.round);
    host.innerHTML = `<div class="abw">${state.step === "matrix" ? matrix(rnd) : summary(rnd)}</div>`;
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
    host.querySelectorAll(".ab-samplechip").forEach((chip) => {
      chip.addEventListener("click", () => {
        if (!cellTrendDrawer || !cellTrendChart) return;
        const sides = chip.dataset.sides.split(",");
        // The chart's own clickable points still recall their side; these chips recall a side that
        // the current metric does not draw (e.g. online samples while reading the paired change).
        cellTrendDrawer.openPick?.({
          date: chip.dataset.source,
          series: { label: cellTrendChart.colName, samples: [{ round: rnd, sides }] },
          seriesIndex: -1,
          index: 0,
        });
      });
    });
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
    if (act === "abcard") { setOverviewOpen(action.dataset.card); return; }
    if (act === "round") { pickRound(Number(action.dataset.i)); return; }
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
      if ((next === "paired" && !sideReady(rnd, "after")) || ((next === "delta" || next === "post") && !postReady(rnd))) return;
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
    const cell = e.target.closest(".cell[data-abmx]");
    const table = host.querySelector(".abmatrix");
    if (!table) return;
    if (!cell || cell.classList.contains("is-empty")) {
      table.classList.remove("is-hover");
      table.querySelectorAll(".is-hl, .is-cur").forEach((x) => x.classList.remove("is-hl", "is-cur"));
      return;
    }
    const [ri, ci] = cell.dataset.abmx.split(":").map(Number);
    table.classList.add("is-hover");
    table.querySelectorAll(".cell").forEach((c) => {
      const [r, k] = (c.dataset.abmx || "").split(":").map(Number);
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
    if (!host.isConnected) {
      window.removeEventListener("resize", onResize);
      if (ro) ro.disconnect();
      return;
    }
    fitMatrix(host.querySelector(".abmatrix"));
  };
  window.addEventListener("resize", onResize);
  /* The card width changes on its own when it goes full screen, not only on a window resize. */
  let ro = null;
  if (typeof ResizeObserver === "function") {
    let lastWidth = host.getBoundingClientRect().width || 0;
    let refit = 0;
    ro = new ResizeObserver(() => {
      if (!host.isConnected) { ro.disconnect(); return; }
      const width = host.getBoundingClientRect().width || 0;
      if (Math.abs(width - lastWidth) < 8) return;
      lastWidth = width;
      clearTimeout(refit);
      refit = setTimeout(() => {
        if (!host.isConnected) return;
        fitMatrix(host.querySelector(".abmatrix"));
        mountOrbit(rounds[state.round], false);
      }, 160);
    });
    ro.observe(host);
  }
  render();
}
