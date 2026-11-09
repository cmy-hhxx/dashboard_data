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
import { esc, fmt, pct, REDUCED, segmented } from "./core.js";
import { sunburst } from "./sunburst.js";
import { lineTrendSVG, wireLineTrendChart } from "./trend_chart.js";
import { trendSampleFrame, abTrendSampleRefs, abLeafRefs } from "./trend_samples.js";

const SIDES = ["before", "after", "online"];
const SIDE_SHORT = { before: "改版前", after: "改版后", online: "线上" };
const METRICS = [
  ["paired", "同题变化"],
  ["before", "发版前"],
  ["after", "发版后同题"],
  ["online", "线上真实"],
];
const NO_SCENE = "未接入分类体系";
const metricLabel = (key) => (METRICS.find(([k]) => k === key) || ["", ""])[1];
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
const metricReady = (rnd, metric) => metric === "paired"
  ? sideReady(rnd, "before") && sideReady(rnd, "after")
  : metric === "before" ? sideReady(rnd, "before")
  : metric === "after" ? sideReady(rnd, "after")
  : metric === "online" ? sideReady(rnd, "online")
  : false;
const defaultMetric = (rnd) => (sideReady(rnd, "before") && sideReady(rnd, "after") ? "paired"
  : sideReady(rnd, "before") ? "before" : sideReady(rnd, "after") ? "after" : "online");
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
   one of three overview cards, so each column prints its own count and the volume behind it.
   The release boundary is one hairline of release red; the two post-release columns sit closer to
   each other than to the baseline, so the card reads as "one baseline, then the release pair". */
export function abComparisonHTML(rnd) {
  const labels = { before: "同题基线", after: "同题复测", online: "线上真实" };
  const max = Math.max(1, ...SIDES.map((side) => num(rnd.sides?.[side]?.hits)));
  const column = (side) => {
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
  };
  return `<div class="ab-results"><header><span>问题数量</span></header><div class="ab-result-groups" style="--bar-h:${BAR_H}px">
    <div class="ab-result-group is-before"><span>改版前</span>${column("before")}</div>
    <div class="ab-result-group is-post"><span>改版后</span><div class="ab-result-post">${column("after")}${column("online")}</div></div>
  </div></div>`;
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
  if (metric === "before") return sideReady(rnd, "before") ? cell.before : null;
  if (metric === "after") return sideReady(rnd, "after") ? cell.after : null;
  if (metric === "online") return sideReady(rnd, "online") ? cell.online : null;
  if (metric === "paired") return sideReady(rnd, "after") && sideReady(rnd, "before") ? cell.after - cell.before : null;
  return null;
}

/* The tooltip explains the number printed in the cell.  The four matrices read the same
   three batches directly: 同题变化 = 同题复测 − 同题基线; 发版前/发版后同题/线上真实 are
   each one batch on its own. */
export function metricTip(cell, metric, rnd) {
  if (metric === "before") return { value: `发版前 ${fmt(cell.before)}`, note: "同题基线" };
  if (metric === "after") return { value: `发版后同题 ${fmt(cell.after)}`, note: "同题复测" };
  if (metric === "online") return { value: `线上真实 ${fmt(cell.online)}`, note: "线上真实用户" };
  const value = metricValue(cell, "paired", rnd);
  return {
    value: value == null ? `同题变化 ${DASH}` : `同题变化 ${signed(value)}`,
    note: `同题基线 ${fmt(cell.before)} → 同题复测 ${fmt(cell.after)}`,
  };
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
  const traces = { before: rows.map(() => 0), after: rows.map(() => 0), online: rows.map(() => 0) };
  SIDES.forEach((side) => {
    const cross = crossFor(rnd, side);
    if (!cross) return;
    cross.forEach(([task, sub, pats, sceneTraces]) => {
      const ri = rows.findIndex((r) => sceneMatches(r, task || NO_SCENE, sub || ""));
      if (ri < 0) return;
      traces[side][ri] += num(sceneTraces);
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
  return { rows, cols, cells, traces };
}

function matrixTableAb(view, rnd, metric, selected) {
  const { rows, cols, cells, traces } = view;
  if (!rows.length || !cols.length) return `<div class="empty">暂无聚类矩阵数据</div>`;
  // 同题变化 is signed: a real 0 is data, so it is printed (unlike a 0 count).
  const change = metric === "paired";
  const denSide = change ? "before" : metric;
  const rowDen = (ri) => (traces?.[denSide]?.[ri] || 0);
  const grandDen = sumOf(rows.map((_, ri) => rowDen(ri)));
  const cellData = (v, den) => `<span class="cell-data"><span class="cell-main"><b>${change ? signed(v) : fmt(v)}</b><span class="cell-den">/ ${fmt(den)}</span></span><span class="cell-pct">${pct(v, den, 1)}</span></span>`;
  let max = 1;
  cells.forEach((row) => row.forEach((x) => { if (x.n != null) max = Math.max(max, Math.abs(x.n)); }));
  const totals = rows.map((_, ri) => sumOf(cells[ri].map((x) => x.n == null ? 0 : x.n)));
  const colTotals = cols.map((_, ci) => sumOf(rows.map((_, ri) => cells[ri][ci].n == null ? 0 : cells[ri][ci].n)));
  const grand = sumOf(colTotals);
  const heads = cols.map((c) => {
    const title = `${c.prefix ? `${c.prefix} · ` : ""}${c.name}`;
    return `<span class="mh" title="${esc(title)}"><span class="mx-lab">${esc(c.name)}</span></span>`;
  }).join("");
  let rowLabels = "", gridCells = "", tots = "";
  rows.forEach((r, ri) => {
    const label = `<span class="mx-lab">${esc(r.name)}</span>`;
    rowLabels += `<span class="rh" title="${esc(r.name)}">${label}</span>`;
    cols.forEach((c, ci) => {
      const cell = cells[ri][ci];
      const v = cell.n;
      const tone = change && v != null ? (v < 0 ? " is-better" : v > 0 ? " is-worse" : " is-zero") : "";
      const zero = !change && v != null && v === 0;
      const on = selected && selected.ri === ri && selected.ci === ci;
      const tipParts = metricTip(cell, metric, rnd);
      const den = rowDen(ri);
      const tip = `${r.name} · ${c.name}|${tipParts.value} / ${fmt(den)} Trace · ${pct(v, den, 1)}|${tipParts.note}`;
      gridCells += v == null || zero
        ? `<span class="cell is-empty" data-abmx="${ri}:${ci}"></span>`
        : `<span class="cell num${tone}${on ? " is-sel" : ""}" style="--v:${(0.08 + 0.62 * Math.sqrt(Math.abs(v) / max)).toFixed(3)}" data-act="cell" data-ri="${ri}" data-ci="${ci}" data-abmx="${ri}:${ci}" data-tip="${esc(tip)}">${cellData(v, den)}</span>`;
    });
    tots += `<span class="rowtot num">${change ? signed(totals[ri]) : fmt(totals[ri])}</span>`;
  });
  const foot = cols.map((c, ci) => {
    const v = colTotals[ci];
    const tone = change ? (v < 0 ? " is-better" : v > 0 ? " is-worse" : "") : "";
    return `<button type="button" class="cell coltot num${tone}" style="--v:0.08" data-act="cell" data-ri="total" data-ci="${ci}" title="全部场景 · ${esc(c.name)}">${cellData(v, grandDen)}</button>`;
  }).join("");
  const grandTone = change ? (grand < 0 ? " is-better" : grand > 0 ? " is-worse" : "") : "";
  return `<div class="matrix abmatrix" style="--cols:${cols.length};--rows:${rows.length}">
    <div class="mx-rows"><span class="mx-corner" aria-hidden="true"></span>${rowLabels}<span class="rh"><span class="mx-lab mx-total-lab">场景合计</span></span></div>
    <div class="mx-scroll"><div class="mx-grid">${heads}${gridCells}${foot}</div></div>
    <div class="mx-tots"><span class="rowtot-head" title="该场景在当前口径下的问题数合计"><span class="mx-lab mx-total-lab">${change ? "变化合计" : "问题合计"}</span></span>${tots}<span class="rowtot rowtot-foot">${change ? signed(grand) : fmt(grand)}</span></div>
  </div>`;
}

function fitMatrix(m) {
  if (!m) return;
  const labs = [...m.querySelectorAll(".mh .mx-lab")];
  if (!labs.length) return;
  const widths = [...labs, ...m.querySelectorAll(".mx-grid .cell-main")].map((el) => el.scrollWidth);
  const need = Math.ceil(Math.max(...widths)) + 9;
  m.style.setProperty("--mx-colw", `${need}px`);
  const pane = m.querySelector(".mx-scroll");
  if (pane) {
    pane.classList.toggle("is-overflow", pane.scrollWidth > pane.clientWidth + 1);
    pane.classList.toggle("is-at-end", pane.scrollLeft + pane.clientWidth >= pane.scrollWidth - 2);
  }
}

const rowScope = (row) => ({ name: row.name, task: row.task, sub: row.sub, group: !!row.group, tasks: row.tasks || [] });

function treeCount(rnd, side, row, colPrefix) {
  const cross = crossFor(rnd, side);
  if (!cross) return null;
  let total = 0;
  cross.forEach(([task, sub, pats]) => {
    if (!row.all && !sceneMatches(row, task || NO_SCENE, sub || "")) return;
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
  state.orbit = state.orbit && typeof state.orbit === "object" && (state.orbit.before || state.orbit.after)
    ? state.orbit : { before: state.orbit || {}, after: {} };
  state.orbit.before = state.orbit.before || {};
  state.orbit.after = state.orbit.after || {};
  state.orbitSide = state.orbitSide === "after" ? "after" : "before";
  state.metric = METRICS.some(([k]) => k === state.metric) ? state.metric : defaultMetric(rounds[state.round]);
  const current = rounds[state.round];
  if (!metricReady(current, state.metric)) state.metric = defaultMetric(current);
  state.overviewOpen = OVERVIEW_CARDS.includes(state.overviewOpen) ? state.overviewOpen : "";
  if (!state.cell || typeof state.cell !== "object") state.cell = null;
  let cellTrendChart = null;
  let cellTrendDrawer = null;
  let orbitApi = null;
  let overviewTimer = 0;
  /* The records and the fullscreen control sit in the card head, outside the body re-rendered here. */
  const face = typeof host.closest === "function" ? host.closest(".mx-ab-face") : null;
  const roundsHost = face ? face.querySelector("#abRounds") : null;

  function pickRound(i) {
    if (!(i >= 0 && i < rounds.length) || i === state.round) return;
    state.round = i;
    state.metric = defaultMetric(rounds[i]);
    state.orbit = { before: {}, after: {} };
    state.orbitSide = "before";
    state.overviewOpen = "";
    state.cell = null;
    render();
  }

  if (roundsHost) {
    roundsHost.addEventListener("click", (e) => {
      const btn = e.target.closest('[data-act="round"]');
      if (btn) pickRound(Number(btn.dataset.i));
    });
  }

  /* The leaf list is the current round's own batch, not the main taxonomy's examples: a
     pre-release ref opens the paired baseline, a retest ref opens its generated detail, and an
     online ref has no same-question twin so it opens the compare page on its own. */
  function samplePane(node) {
    const sides = state.orbitSide === "before" ? ["before"] : ["after", "online"];
    const refs = abLeafRefs(rounds[state.round], sides, node.id);
    const body = refs.length
      ? refs.map((ref, i) => {
          const jump = ref.side === "online"
            ? `data-compare-online="${esc(ref.slug || "")}"`
            : `data-compare-pair="${esc(ref.pair || ref.trace || "")}"`;
          return `<button type="button" class="gl-r" style="--i:${Math.min(i, 8)};--c:${SIDE_TONE[ref.side]}" ${jump} title="${esc(ref.q || "")}">
          <i></i><span>${esc(ref.q || "（无提问）")}</span><b>${SIDE_SHORT[ref.side]}</b>
        </button>`;
        }).join("")
      : `<p class="ab-sample-empty">暂无具体样本</p>`;
    return `<div class="gx-side ab-sample-pane">
      <div class="ab-sample-head"><span title="${esc(node.name)}">${esc(node.name)}</span><button type="button" class="link" data-act="orbitBack">← 对比概览</button></div>
      <div class="gl-sum"><b class="num">${fmt(refs.length)}</b><small>个样本</small></div>
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

  /* 变化构成：一根从左到右的桥，而不是四根各自起跑的长条。  Each problem the release touched
     moves the running total once, so the four steps walk 改版前 → 改版后 and the head keeps the two
     totals.  The plot is zoomed to the change band (totals in the head, values on every step), so a
     483 out of 3288 still reads; the dashed step lines carry the running total between columns. */
  function bridgeCard(rnd) {
    const before = num(rnd.sides?.before?.hits);
    const after = num(rnd.sides?.after?.hits);
    const net = after - before;
    let level = before;
    const steps = changeFlows(rnd).map((flow) => {
      const from = level;
      level += flow.sign * flow.n;
      return { ...flow, from, to: level, delta: flow.sign * flow.n };
    });
    const levels = [before, ...steps.map((step) => step.to)];
    const lo = Math.min(...levels);
    const hi = Math.max(...levels);
    const pad = Math.max(1, (hi - lo) * 0.08);
    const floor = lo - pad;
    const span = Math.max(1, hi + pad - floor);
    const y = (value) => (100 * (1 - (value - floor) / span)).toFixed(2);
    const cols = steps.map((step, i) => {
      const top = Math.min(Number(y(step.from)), Number(y(step.to)));
      const h = Math.abs(Number(y(step.from)) - Number(y(step.to)));
      const bar = step.n ? `<i class="ab-wf-bar" style="top:${top.toFixed(2)}%;height:${h.toFixed(2)}%"></i>` : "";
      const link = i < steps.length - 1 ? `<span class="ab-wf-link" style="top:${y(step.to)}%"></span>` : "";
      return `<div class="ab-wf-col ${step.dir}" data-flow="${step.key}" title="${esc(`${step.name} ${signed(step.delta)} 个问题 · ${step.count} 个问题类型`)}">${bar}${link}</div>`;
    }).join("");
    const labels = steps.map((step) => `<div class="ab-wf-label"><span>${step.name}</span><b class="num" data-flow="${step.key}">${signed(step.delta)}</b></div>`).join("");
    const aria = `变化构成（纵轴只展开变化区间）：${steps.map((step) => `${step.name} ${signed(step.delta)}`).join("，")}；${fmt(before)} → ${fmt(after)}`;
    return `<section class="ab-card ab-bridge-card${state.overviewOpen === "bridge" ? " is-deep" : state.overviewOpen ? " is-compact" : ""}" data-abcard="bridge" data-abname="变化构成">
      <div class="ab-card-top"><span class="ab-bridge-pair num">${fmt(before)}<i>→</i>${fmt(after)}</span>${pushButton("bridge", "变化构成")}</div>
      <div class="ab-bridge-main"><b class="num${net < 0 ? " is-better" : net > 0 ? " is-worse" : ""}">${signed(net)}</b><small>个问题</small></div>
      <div class="ab-wf" role="img" aria-label="${esc(aria)}" title="纵轴只展开变化区间 ${fmt(lo)}–${fmt(hi)}，未从 0 起">
        <div class="ab-wf-plot">${cols}</div>
        <div class="ab-wf-labels">${labels}</div>
      </div>
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

  /* 前 / 后各一个点、中间一根连线（哑铃），两条轴都画在 0–max 的同一把尺上：读数不再只剩 |Δ|，
     两行之间的差距也能直接比出来。  0…max 的公共刻度由 summary() 传进来，两块面板因此可比。 */
  function rankPanel(title, rows, tone, max, total, rnd) {
    const body = rows.length
      ? rows.map((row) => {
          const from = Math.min(100, Math.max(0, (100 * row.before) / max));
          const to = Math.min(100, Math.max(0, (100 * row.after) / max));
          const left = Math.min(from, to);
          const width = Math.abs(to - from);
          return `<div class="ab-rankrow ${tone}" title="${esc(`${row.leaf.id} · 前 ${fmt(row.before)} → 后 ${fmt(row.after)} · 线上 ${row.online == null ? DASH : fmt(row.online)}`)}">
          <span class="ab-rankname">${esc(row.leaf.name || row.leaf.id)}</span>
          <span class="ab-dumbbell" aria-hidden="true">
            <i class="ab-db-rule"></i>
            <i class="ab-db-link" style="left:${left.toFixed(1)}%;width:${Math.max(width, 0.6).toFixed(1)}%"></i>
            <i class="ab-db-dot is-from" style="left:${from.toFixed(1)}%"></i>
            <i class="ab-db-dot is-to" style="left:${to.toFixed(1)}%"></i>
          </span>
          <b class="num">${fmt(row.before)} → ${fmt(row.after)}</b>
        </div>`;
        }).join("")
      : `<p class="ab-rankempty">${sideReady(rnd, "after") || sideReady(rnd, "online") ? "暂无变化" : "改版后暂无结果"}</p>`;
    return `<section class="ab-rank ${tone}"><header><span>${title}</span><b class="num">${total}</b></header>
      <div class="ab-rank-axis" aria-hidden="true"><div class="ab-rank-axis-track"><span>0</span><span>${fmt(max)}</span></div></div>
      ${body}</section>`;
  }

  function summary(rnd) {
    const changesNow = changes(rnd);
    const improved = changesNow.filter((x) => x.d < 0).sort((a, b) => a.d - b.d || b.before - a.before);
    const worsened = changesNow.filter((x) => x.d > 0).sort((a, b) => b.d - a.d || b.after - a.after);
    const max = Math.max(1, ...changesNow.map((x) => Math.max(x.before, x.after)));
    const onlineRows = (Array.isArray(rnd.leaves) ? rnd.leaves : []).filter((leaf) => num(leaf.online) > 0);
    changesNow.forEach((row) => { row.onlineMatched = onlineRows.some((leaf) => pathRelated(row.leaf.id, leaf.id)); });
    return `<section class="ab-summary">
      ${overview(rnd)}
      <div class="ab-change-head"><span title="同题变化：同题复测 − 同题基线；线上真实只在「问题数量」和「线上真实」矩阵里单独计入">问题变化（同题）</span><span class="ab-change-pills"><i class="is-from"></i>改版前<i class="is-to"></i>改版后<i class="is-better"></i>改善 <b class="num">${fmt(improved.length)}</b><i class="is-worse"></i>变差 <b class="num">${fmt(worsened.length)}</b></span></div>
      <div class="ab-summary-grid">${rankPanel("变好的问题", improved.slice(0, 5), "is-better", max, improved.length, rnd)}${rankPanel("变差的问题", worsened.slice(0, 5), "is-worse", max, worsened.length, rnd)}</div>
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
    const values = rounds.map((r, i) => ({
      label: roundLabel(r, i),
      before: treeCount(r, "before", row, col.prefix),
      after: treeCount(r, "after", row, col.prefix),
      online: treeCount(r, "online", row, col.prefix),
    }));
    const cur = values[state.round];
    const label = metricLabel(metric);
    const current = metric === "paired"
      ? (cur.before == null || cur.after == null ? null : cur.after - cur.before)
      : metric === "before" ? cur.before
      : metric === "after" ? cur.after
      : cur.online;
    let cols, series;
    if (metric === "paired") {
      if (values.length === 1) {
        cols = ["发版前", "发版后同题"];
        series = [{ label: col.name, color: "var(--accent)", values: [cur.before, cur.after],
          samples: [{ round: rnd, sides: ["before"] }, { round: rnd, sides: ["after"] }] }];
      } else {
        cols = values.map((v) => v.label);
        series = [
          { label: "发版前", color: "var(--t2)", values: values.map((v) => v.before),
            samples: rounds.map((r) => ({ round: r, sides: ["before"] })) },
          { label: "发版后同题", color: "var(--accent)", values: values.map((v) => v.after),
            samples: rounds.map((r) => ({ round: r, sides: ["after"] })) },
        ];
      }
    } else {
      cols = values.length === 1 ? [label] : values.map((v) => v.label);
      series = [{ label, color: "var(--accent)", values: values.map((v) => v[metric]),
        samples: rounds.map((r) => ({ round: r, sides: [metric] })) }];
    }
    // Sample recall is per side, not per metric, so every side stays recallable.
    const sampleSides = [
      { sides: ["before"], source: "改版前" },
      { sides: ["after"], source: "改版后" },
      { sides: ["online"], source: "线上真实" },
    ];
    const chips = sampleSides.map(({ sides, source }) => {
      const refs = abTrendSampleRefs(rnd, sides, row, col.prefix);
      if (!refs.length) return "";
      return `<button type="button" class="ab-samplechip" data-act="samples" data-sides="${sides.join(",")}" data-source="${source}" title="召回「${source}」命中 ${esc(row.name)} × ${esc(col.name)} 的样本">${source}样本 <b class="num">${fmt(refs.length)}</b></button>`;
    }).join("");
    const amount = (v) => (v == null ? "无" : fmt(v));
    const aria = `AB 趋势：${row.name} · ${col.name}，${values.map((v) => `${v.label} 发版前 ${amount(v.before)} 发版后同题 ${amount(v.after)} 线上真实 ${amount(v.online)}`).join("；")}`;
    const width = host.getBoundingClientRect().width || 720;
    // A paired single round compares two batches across the release boundary.
    const releaseMarks = metric === "paired" && values.length === 1 ? [{ at: 0.5, label: roundLabel(rnd, state.round) }] : null;
    const chart = { height: 260, yAxis: true, minTop: 4, endLabels: series.every((s) => s.values[s.values.length - 1] != null), xLabels: cols, xDates: cols, series, aria, formatValue: fmt, marks: releaseMarks };
    cellTrendChart = { chart, row, node: col.prefix, colName: col.name, round: rnd };
    return `<section class="ab-trend is-on" aria-live="polite">
      <div class="ab-trendhead">
        <span class="ab-trendname">${esc(row.name)} · ${esc(col.name)}</span>
        <span class="ab-trendmetric">${esc(label)} <b class="num">${current == null ? DASH : metric === "paired" ? signed(current) : fmt(current)}</b></span>
        <span class="ab-trendacts">${chips || '<small class="ab-trendhint">当前簇没有可召回样本</small>'}</span>
      </div>
      ${trendSampleFrame(`<div class="mxt-plot" id="abCellTrend" data-own-tip>${lineTrendSVG({ ...chart, width }).html}</div>`)}
    </section>`;
  }

  function metricChips(rnd) {
    return METRICS.map(([key, label]) => {
      const disabled = !metricReady(rnd, key);
      return `<button type="button" class="ab-chip" data-act="metric" data-metric="${key}" aria-pressed="${state.metric === key}"${disabled ? " disabled" : ""}>${label}</button>`;
    }).join("");
  }

  function matrix(rnd) {
    const names = new Map((Array.isArray(rnd.nodes) ? rnd.nodes : []).map((n) => [n.id, n.name]));
    const cross = allCross(rnd);
    const sceneRoot = { name: "全部", children: capScenes(sceneTree(cross)) };
    const clusterRoot = clusterTree(cross, tax || {}, names);
    const view = matrixViewAb(rnd, sceneRoot.children, clusterRoot.children, state.metric);
    let selectedIdx = null;
    if (state.cell && !state.cell.row.all) {
      const ri = view.rows.findIndex((r) => sceneMatches(state.cell.row, r.task || NO_SCENE, r.sub || ""));
      const ci = view.cols.findIndex((c) => c.prefix === state.cell.col.prefix);
      if (ri >= 0 && ci >= 0) selectedIdx = { ri, ci };
      else state.cell = null;
    }
    return `<section class="ab-matrixstep">
      <div class="ab-matrixhead"><div class="ab-matrix-title"><h3>聚类矩阵</h3></div><div class="ab-metrics" role="group" aria-label="矩阵口径">${metricChips(rnd)}</div><span class="ab-matrixmeta">${esc(roundLabel(rnd, state.round))} · ${esc(rnd.released_at || (rnd.dates || []).join(" ~ ") || "")}</span></div>
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
    host.innerHTML = `<div class="abw">${summary(rnd)}${matrix(rnd)}</div>`;
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
    const ref = e.target.closest("[data-compare-pair], [data-compare-online]");
    if (ref) {
      const rnd = rounds[state.round];
      if (ref.dataset.compareOnline != null) actions.openCompare && actions.openCompare({ online: ref.dataset.compareOnline, round: rnd.id });
      else actions.openCompare && actions.openCompare({ pair: ref.dataset.comparePair, round: rnd.id });
      return;
    }
    const action = e.target.closest("[data-act]");
    if (!action) return;
    const act = action.dataset.act;
    const rnd = rounds[state.round];
    if (act === "orbitBack") { if (orbitApi) orbitApi.up(); return; }
    if (act === "abcard") { setOverviewOpen(action.dataset.card); return; }
    if (act === "round") { pickRound(Number(action.dataset.i)); return; }
    if (act === "metric") {
      const next = action.dataset.metric;
      if (!METRICS.some(([key]) => key === next) || action.disabled || !metricReady(rnd, next)) return;
      state.metric = next;
      state.cell = null;
      render();
      return;
    }
    if (act === "cell") {
      const total = action.dataset.ri === "total";
      const ri = Number(action.dataset.ri);
      const ci = Number(action.dataset.ci);
      const names = new Map((Array.isArray(rnd.nodes) ? rnd.nodes : []).map((n) => [n.id, n.name]));
      const cross = allCross(rnd);
      const sceneRoot = { name: "全部", children: capScenes(sceneTree(cross)) };
      const clusterRoot = clusterTree(cross, tax || {}, names);
      const col = clusterRoot.children[ci];
      if (!col) return;
      if (total) {
        state.cell = { row: { name: "全部场景", all: true }, col: { name: col.name, prefix: col.prefix } };
      } else {
        const row = sceneRoot.children[ri];
        if (!row) return;
        state.cell = { row: rowScope(row), col: { name: col.name, prefix: col.prefix } };
      }
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
