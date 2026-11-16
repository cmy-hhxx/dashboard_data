/* AB Test: one fixed question set before / after a release, plus post-release real-user
   online validation. The outer step answers whether the fixed-set problems moved; the next
   step keeps the normal cluster-matrix interaction (scene × cluster drill, cell trend).

   The three sides are deliberately not one denominator:
   - before / after are the same fixed targets and can be subtracted;
   - online is a different real-user population and is never subtracted from the fixed set.
   The matrix reads 同题变化 (fixed set alone), 发版前, 发版后同题 or 发版后线上, matching the
   orbit tree's release side.  State lives in data.js's u.ab so an in-place dashboard refresh
   returns to the same round, summary / matrix step, metric and selected cell. */
import { compact, esc, fmt, pct, REDUCED, segmented } from "./core.js";
import { patternOf } from "./taxonomy.js";
import { sunburst } from "./sunburst.js";
import { createKlineChart } from "./kline_chart.js";
import { trendSampleFrame, abTrendSampleRefs, abLeafRefs } from "./trend_samples.js";

const SIDES = ["before", "after", "online"];
const SIDE_SHORT = { before: "改版前", after: "改版后", online: "线上" };
const METRICS = [
  ["paired", "同题变化"],
  ["online", "线上真实"],
];
const METRIC_LABEL = { paired: "同题变化", before: "发版前", after: "发版后同题测试", online: "线上真实" };
const TREND_LABEL = METRIC_LABEL;
const TREE_LABEL = { before: "发版前", after: "发版后同题", online: "发版后线上" };
const NO_SCENE = "未接入分类体系";
const metricLabel = (key) => METRIC_LABEL[key] || "";
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
/* The overview is three cards sharing one row: the release tree, the paired change with its four
   flows, and the ranked movers.  Any card can take the row while the other two fold, borrowing
   the bento push-pull: measure, switch the layout, play every card from its old box. */
const OVERVIEW_CARDS = ["orbit", "change", "ranks"];
const PUSH_ICON = `<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M2.5 8h3.2M2.5 8 5.1 5.4M2.5 8 5.1 10.6M13.5 8H10.3M13.5 8l-2.6-2.6M13.5 8l-2.6 2.6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
// An open card folds back with the same left-pointing arrow every 收起 uses.
const BACK_ICON = `<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M10 3.5 5.5 8l4.5 4.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

const sideReady = (rnd, side) => !!(rnd.sides && rnd.sides[side]);
const metricReady = (rnd, metric) => metric === "paired"
  ? sideReady(rnd, "before") && sideReady(rnd, "after")
  : sideReady(rnd, metric);
const defaultMetric = (rnd) => (sideReady(rnd, "before") && sideReady(rnd, "after") ? "paired" : "online");
const roundLabel = (rnd, i) => rnd.label || rnd.release_label || `第 ${i + 1} 期`;
const roundDate = (rnd) => rnd.released_at || (rnd.dates || [])[1] || null;

/* The AB cell trend is a K-line like every other trend: one candle per release round on its
   release date. 同题变化 opens at the before-release count and closes at the after-release count of
   the same questions, so the candle colour reads better / worse at a glance; a single-side reading
   opens at the previous round's value. Volume is the round's fixed question set; every round's
   release is a vertical line. Rounds without a date cannot sit on a date axis and are left out. */
export function abTrendKline(rounds, values, metric, label) {
  const picks = new Map();
  const candles = [];
  let previous = null;
  rounds.forEach((rnd, i) => {
    const date = roundDate(rnd);
    const v = values[i];
    if (!date || !v) return;
    const paired = metric === "paired";
    const open = paired ? v.before : (previous ?? v[metric]);
    const close = paired ? v.after : v[metric];
    if (open == null || close == null) return;
    previous = close;
    candles.push({
      time: date, open, close, high: Math.max(open, close), low: Math.min(open, close),
      volume: Number(rnd.targets) || 0, from: date, to: date, label: v.label,
    });
    picks.set(date, { round: rnd, sides: paired ? ["before", "after"] : [metric] });
  });
  const spec = {
    candles, period: "day", height: 260, compact: false,
    releases: rounds.map((rnd, i) => ({ date: roundDate(rnd), label: roundLabel(rnd, i) })).filter((r) => r.date),
    openLabel: metric === "paired" ? "发版前" : "上一轮", closeLabel: metric === "paired" ? "发版后同题" : label,
    volumeName: "固定题", volumeLabel: "固定题", emptyText: "该格没有带发版日期的轮次",
    tipTime: (candle) => `${candle.label} · ${candle.time}`, tipPeriod: () => "问题数",
  };
  return { spec, picks };
}

/* The comparison records live in the card head, so a new AB round is one more chip there instead of
   another row above the charts.  The model tag stays the only thing a round adds to its label. */
export function abRoundsHTML(rounds, active) {
  return (Array.isArray(rounds) ? rounds : []).map((r, i) => {
    const badge = modelBadge(r);
    const label = roundLabel(r, i);
    return `<button type="button" class="ab-round" data-act="round" data-i="${i}" aria-pressed="${i === active}" title="${esc(label)}${badge ? ` · ${badge}` : ""}"><b>${esc(label)}</b>${badge ? `<small class="ab-model">${esc(badge)}</small>` : ""}</button>`;
  }).join("");
}

/* 三批问题数量收成一行读数：变化构成的卡头不再重复画一组柱子，每一批只留问题数与其体量。
   基线与复测之间仍是一条发丝红虚线，线上真实是另一批人，不参与相减。 */
export function abComparisonHTML(rnd) {
  const labels = { before: "改版前", after: "改版后同题", online: "线上真实" };
  return `<div class="ab-batches" role="group" aria-label="三批问题数量">${SIDES.map((side) => {
    const result = rnd.sides?.[side];
    const n = result ? num(result.hits) : null;
    const traces = result?.traces == null ? DASH : fmt(result.traces);
    const problemTraces = result?.problem_traces;
    const title = result
      ? side === "online"
        ? `线上真实：${fmt(n)} 个问题，${traces} 条评测样本`
        : `同题交集：${traces} 条 Trace，其中 ${problemTraces == null ? DASH : fmt(problemTraces)} 条有问题；共 ${fmt(n)} 个问题`
      : `${labels[side]}暂无数据`;
    return `<div class="ab-batch is-${side}${result ? "" : " is-missing"}" title="${esc(title)}">
      <span>${labels[side]}</span>
      <b class="num">${n == null ? DASH : fmt(n)}</b>
    </div>`;
  }).join("")}</div>`;
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
  if (metric === "before") return sideReady(rnd, "before") ? num(cell.before) : null;
  if (metric === "paired") return sideReady(rnd, "after") && sideReady(rnd, "before") ? num(cell.after) - num(cell.before) : null;
  if (metric === "after") return sideReady(rnd, "after") ? num(cell.after) : null;
  if (metric === "online") return sideReady(rnd, "online") ? num(cell.online) : null;
  return null;
}

/* The tooltip explains the number printed in the cell; 同题变化 still reads the fixed set alone. */
export function metricTip(cell, metric, rnd) {
  if (metric === "paired") {
    const value = metricValue(cell, "paired", rnd);
    return {
      value: value == null ? `同题变化 ${DASH}` : `同题变化 ${signed(value)}`,
      note: `同题基线 ${fmt(cell.before)} → 同题复测 ${fmt(cell.after)}`,
    };
  }
  return { value: `${metricLabel(metric)} ${fmt(cell[metric])}`, note: "" };
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
      const pattern = depth >= 3 ? patternOf(tax, key) : null;
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
  const addPaths = (ri, side, paths) => {
    (paths || []).forEach((pid) => {
      const ci = cols.findIndex((c) => pid === c.prefix || String(pid).startsWith(`${c.prefix}.`));
      if (ci < 0) return;
      const cell = cells[ri][ci];
      cell[side] += 1;
      cell.pats.set(pid, (cell.pats.get(pid) || 0) + 1);
    });
  };
  const common = Array.isArray(rnd.common?.rows) ? rnd.common.rows : null;
  if (common && metric !== "online") {
    // 发版前矩阵 / 发版后矩阵 / 同题变化矩阵共用同一个交集：
    // 发版前已评测 ∩ 发版后已重测。无问题 Trace 也计入场景 volume。
    common.forEach(([task, sub, beforePaths, afterPaths]) => {
      const ri = rows.findIndex((r) => sceneMatches(r, task || NO_SCENE, sub || ""));
      if (ri < 0) return;
      traces.before[ri] += 1;
      traces.after[ri] += 1;
      if (metric === "paired" || metric === "before") addPaths(ri, "before", beforePaths);
      if (metric === "paired" || metric === "after") addPaths(ri, "after", afterPaths);
    });
  } else if (metric === "paired") {
    // Old payloads without `common`: recall list is the only paired source available.
    const pairs = Array.isArray(rnd.pairs) ? rnd.pairs : [];
    pairs.forEach((pair) => {
      const ri = rows.findIndex((r) => sceneMatches(r, pair.scene || NO_SCENE, pair.sub || ""));
      if (ri < 0) return;
      ["before", "after"].forEach((side) => {
        const ref = pair[side];
        if (!ref) return;
        traces[side][ri] += 1;
        addPaths(ri, side, ref.paths);
      });
    });
  } else {
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
  }
  cells.forEach((row) => row.forEach((cell) => { cell.n = metricValue(cell, metric, rnd); }));
  return { rows, cols, cells, traces };
}

const ratioText = (delta, base) => (base
  ? `${fmt(Math.abs((100 * delta) / base), 1)}%`
  : DASH);

/* 同题变化 reads one cell as four numbers: 发版前问题数 → 发版后问题数, the net move and its rate. */
function changeCellData(before, after) {
  const b = num(before), a = num(after), d = a - b;
  // 数字本身居中，正负号和百分号挂在数字外侧，不参与列宽/中心计算。
  const sign = d > 0 ? "+" : d < 0 ? "−" : "";
  const rate = ratioText(d, b);
  const pctNum = b ? Math.abs((100 * d) / b) : null;
  // 比例也遵守 K/M/B 缩写，避免 1,000.0% 把 104px 的格子撑出边界。
  const rateText = pctNum == null ? rate
    : pctNum >= 1000 ? `${compact(pctNum)}%`
      : pctNum >= 10 ? `${fmt(pctNum, 0)}%`
        : `${fmt(pctNum, 1)}%`;
  return `<span class="cell-data is-change"><span class="cell-pair"><b class="is-from">${compact(b)}</b><i class="cell-arrow" aria-hidden="true">→</i><b class="is-to">${compact(a)}</b></span><span class="cell-delta"><b class="cell-delta-num"><span class="cell-sign">${sign}</span>${compact(Math.abs(d))}</b><i class="cell-dot" aria-hidden="true">·</i><span class="cell-ratio">${rateText}</span></span></span>`;
}
function countCellData(v, den) {
  return `<span class="cell-data"><span class="cell-main"><b>${fmt(v)}</b></span><span class="cell-pct">${pct(v, den, 1)}</span></span>`;
}

function matrixTableAb(view, rnd, metric, selected) {
  const { rows, cols, cells, traces } = view;
  if (!rows.length || !cols.length) return `<div class="empty">暂无聚类矩阵数据</div>`;
  const change = metric === "paired";
  const side = change ? null : metric;
  const rowDen = (ri) => (side && traces?.[side] ? traces[side][ri] || 0 : 0);
  const grandDen = sumOf(rows.map((_, ri) => rowDen(ri)));
  // The totals are the same readout as the cells: same semantic tone classes, same heat ramp.
  const toneOf = (v) => change && v != null ? (v < 0 ? " is-better" : v > 0 ? " is-worse" : " is-zero") : "";
  const maxDelta = Math.max(1, ...cells.flatMap((row) => row.map((x) => (x.n == null ? 0 : Math.abs(x.n)))));
  const maxCount = Math.max(1, ...cells.flatMap((row) => row.map((x) => num(x[side]))));
  const heatDelta = (v) => (0.08 + 0.62 * Math.sqrt(Math.min(1, Math.abs(v) / maxDelta))).toFixed(3);
  // 发版前 / 发版后同题 / 线上真实 和外部矩阵用同一条热力坡道。
  const heatCount = (v) => (0.08 + 0.72 * Math.sqrt(Math.min(1, v / maxCount))).toFixed(3);
  const rowBefore = rows.map((_, ri) => sumOf(cells[ri].map((x) => num(x.before))));
  const rowAfter = rows.map((_, ri) => sumOf(cells[ri].map((x) => num(x.after))));
  const rowCount = rows.map((_, ri) => sumOf(cells[ri].map((x) => num(x[side]))));
  const heads = cols.map((c, ci) => {
    const title = `${c.prefix ? `${c.prefix} · ` : ""}${c.name}`;
    const label = `<span class="mx-lab">${esc(c.name)}</span>`;
    return c.children?.length
      ? `<button type="button" class="mh" data-act="abcol" data-ci="${ci}" title="${esc(title)}" aria-label="下钻 ${esc(c.name)}">${label}<i class="mx-caret" aria-hidden="true"></i></button>`
      : `<span class="mh" title="${esc(title)}">${label}</span>`;
  }).join("");
  // 发版前矩阵 / 发版后矩阵 / 同题变化矩阵共用「发版前已评测 ∩ 发版后已重测」这一个交集；
  // 场景 volume 是这个交集里的 Trace 数（含无问题 Trace），问题数只影响格子。
  const sharedRows = Array.isArray(rnd.common?.scenes) ? rnd.common.scenes : null;
  const fixedCount = (row) => sharedRows
    ? sharedRows.reduce((n, [task, sub, count]) => n + (sceneMatches(row, task || NO_SCENE, sub || "") ? num(count) : 0), 0)
    : (Array.isArray(rnd.pairs)
      ? rnd.pairs.reduce((n, pair) => n + (sceneMatches(row, pair.scene || NO_SCENE, pair.sub || "") ? 1 : 0), 0)
      : null);
  let rowLabels = "", gridCells = "", tots = "";
  rows.forEach((r, ri) => {
    const fixed = change ? fixedCount(r) : null;
    const volume = `${fmt(fixed == null ? (change ? (traces?.before?.[ri] || 0) : rowDen(ri)) : fixed)}`;
    const label = `<span class="mx-lab">${esc(r.name)}<em class="mx-vol num">${volume}</em></span>`;
    rowLabels += r.children?.length
      ? `<button type="button" class="rh" data-act="abrow" data-ri="${ri}" title="${esc(r.name)}" aria-label="下钻 ${esc(r.name)}">${label}<i class="mx-caret" aria-hidden="true"></i></button>`
      : `<span class="rh" title="${esc(r.name)}">${label}</span>`;
    cols.forEach((c, ci) => {
      const cell = cells[ri][ci];
      const on = selected && selected.ri === ri && selected.ci === ci ? " is-sel" : "";
      if (change) {
        const b = num(cell.before), a = num(cell.after), d = a - b;
        if (!b && !a) { gridCells += `<span class="cell is-empty" data-abmx="${ri}:${ci}"></span>`; return; }
        const tip = `${r.name} · ${c.name}|同题变化 ${signed(d)} · ${ratioText(d, b)}|同题基线 ${fmt(b)} → 同题复测 ${fmt(a)}`;
        gridCells += `<span class="cell num${toneOf(d)}${on}" style="--v:${heatDelta(d)}" data-act="cell" data-ri="${ri}" data-ci="${ci}" data-abmx="${ri}:${ci}" data-tip="${esc(tip)}">${changeCellData(b, a)}</span>`;
        return;
      }
      const v = num(cell[side]);
      const den = rowDen(ri);
      if (!v) { gridCells += `<span class="cell is-empty" data-abmx="${ri}:${ci}"></span>`; return; }
      const hv = heatCount(v);
      const tip = `${r.name} · ${c.name}|${fmt(v)} 个问题 · ${pct(v, den, 1)}|${metricLabel(metric)} · ${fmt(den)} 条 Trace`;
      gridCells += `<span class="cell num${Number(hv) > 0.5 ? " hot" : ""}${on}" style="--v:${hv}" data-act="cell" data-ri="${ri}" data-ci="${ci}" data-abmx="${ri}:${ci}" data-tip="${esc(tip)}">${countCellData(v, den)}</span>`;
    });
    if (change) {
      const d = rowAfter[ri] - rowBefore[ri];
      tots += `<span class="rowtot num${toneOf(d)}" style="--v:${heatDelta(d)}">${changeCellData(rowBefore[ri], rowAfter[ri])}</span>`;
    } else {
      tots += `<span class="rowtot num">${fmt(rowCount[ri])}</span>`;
    }
  });
  const totalFixed = (sharedRows || Array.isArray(rnd.pairs)) ? sumOf(rows.map((r) => fixedCount(r))) : null;
  // 场景合计后的数与各行口径一致：变化矩阵是固定题集条数，其余是当前侧 Trace 数。
  const totalVolume = change
    ? (totalFixed == null ? sumOf(traces?.before || []) : totalFixed)
    : grandDen;
  const fixedInfo = rnd.fixed;
  const commonInfo = rnd.common;
  const totalTitle = change
    ? [
      `矩阵口径：发版前已评测 ∩ 发版后已重测 ${fmt(commonInfo?.total ?? totalVolume)} 条 Trace（含无问题）`,
      fixedInfo?.total != null ? `固定题集 ${fmt(fixedInfo.total)} 条` : "",
      fixedInfo?.before != null ? `发版前已评测 ${fmt(fixedInfo.before)} 条` : "",
      fixedInfo?.after != null ? `发版后已重测 ${fmt(fixedInfo.after)} 条` : "",
      Array.isArray(rnd.pairs) ? `两侧都有详情 ${fmt(rnd.pairs.length)} 条` : "",
    ].filter(Boolean).join("；")
    : "当前口径下全部场景的 Trace 数";
  const foot = cols.map((c, ci) => {
    if (change) {
      const before = sumOf(rows.map((_, ri) => num(cells[ri][ci].before)));
      const after = sumOf(rows.map((_, ri) => num(cells[ri][ci].after)));
      const d = after - before;
      return `<button type="button" class="cell coltot num${toneOf(d)}" style="--v:${heatDelta(d)}" data-act="cell" data-ri="total" data-ci="${ci}" title="全部场景 · ${esc(c.name)}">${changeCellData(before, after)}</button>`;
    }
    const v = sumOf(rows.map((_, ri) => num(cells[ri][ci][side])));
    return `<button type="button" class="cell coltot num" style="--v:0.08" data-act="cell" data-ri="total" data-ci="${ci}" title="全部场景 · ${esc(c.name)}">${countCellData(v, grandDen)}</button>`;
  }).join("");
  let footTotal;
  if (change) {
    const before = sumOf(rowBefore), after = sumOf(rowAfter), d = after - before;
    footTotal = `<span class="rowtot rowtot-foot num${toneOf(d)}" style="--v:${heatDelta(d)}">${changeCellData(before, after)}</span>`;
  } else {
    footTotal = `<span class="rowtot rowtot-foot num" style="--v:0.08">${fmt(sumOf(rowCount))}</span>`;
  }
  return `<div class="matrix abmatrix${change ? " is-change" : ""}" style="--cols:${cols.length};--rows:${rows.length}">
    <div class="mx-rows"><span class="mx-corner" aria-hidden="true"></span>${rowLabels}<span class="rh"><span class="mx-lab mx-total-lab" title="${esc(totalTitle)}">场景合计<em class="mx-vol num">${fmt(totalVolume)}</em></span></span></div>
    <div class="mx-scroll"><div class="mx-grid">${heads}${gridCells}${foot}</div></div>
    <div class="mx-tots"><span class="rowtot-head" title="这个场景按当前筛选的问题数加起来"><span class="mx-lab mx-total-lab">${change ? "变化合计" : "问题合计"}</span></span>${tots}${footTotal}</div>
  </div>`;
}

function fitMatrix(m) {
  if (!m) return;
  const pane = m.querySelector(".mx-scroll");
  // 变化矩阵的列宽交给 CSS（下限 82px，其余按可用宽度均分），这里只维护溢出状态。
  if (m.classList.contains("is-change")) {
    if (pane) {
      pane.classList.toggle("is-overflow", pane.scrollWidth > pane.clientWidth + 1);
      pane.classList.toggle("is-at-end", pane.scrollLeft + pane.clientWidth >= pane.scrollWidth - 2);
    }
    return;
  }
  const labs = [...m.querySelectorAll(".mh .mx-lab")];
  if (!labs.length) return;
  const widths = [...labs, ...m.querySelectorAll(".mx-grid .cell-main")].map((el) => el.scrollWidth);
  const need = Math.ceil(Math.max(...widths)) + 9;
  m.style.setProperty("--mx-colw", `${need}px`);
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
  state.orbit = state.orbit && typeof state.orbit === "object" && (state.orbit.before || state.orbit.after || state.orbit.online)
    ? state.orbit : { before: {}, after: {}, online: {} };
  SIDES.forEach((side) => { state.orbit[side] = state.orbit[side] || {}; });
  state.orbitSide = SIDES.includes(state.orbitSide) ? state.orbitSide : "before";
  if (!sideReady(rounds[state.round], state.orbitSide)) {
    state.orbitSide = SIDES.find((side) => sideReady(rounds[state.round], side)) || "before";
  }
  state.metric = METRICS.some(([k]) => k === state.metric) ? state.metric : defaultMetric(rounds[state.round]);
  const current = rounds[state.round];
  if (!metricReady(current, state.metric)) state.metric = defaultMetric(current);
  state.overviewOpen = OVERVIEW_CARDS.includes(state.overviewOpen) ? state.overviewOpen : "";
  if (!state.cell || typeof state.cell !== "object") state.cell = null;
  state.mxRows = Array.isArray(state.mxRows) ? state.mxRows : [];
  state.mxCols = Array.isArray(state.mxCols) ? state.mxCols : [];
  state.mxTrail = Array.isArray(state.mxTrail) ? state.mxTrail : [];
  let mxNow = null;
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
    state.orbit = { before: {}, after: {}, online: {} };
    state.orbitSide = SIDES.find((side) => sideReady(rounds[i], side)) || "before";
    state.overviewOpen = "";
    state.cell = null;
    state.mxRows = [];
    state.mxCols = [];
    state.mxTrail = [];
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
    const sides = [state.orbitSide];
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
    return `<button type="button" class="ab-card-btn" data-act="abcard" data-card="${card}" aria-pressed="${open}" aria-label="${label}" title="${esc(label)}">${open ? BACK_ICON : PUSH_ICON}</button>`;
  }

  function orbitCard(rnd) {
    const sides = SIDES.map((side) => `<button type="button" data-value="${side}" aria-pressed="${state.orbitSide === side}"${sideReady(rnd, side) ? "" : " disabled"}>${TREE_LABEL[side]}</button>`).join("");
    return `<section class="ab-card ab-orbit-card${state.overviewOpen === "orbit" ? " is-deep" : state.overviewOpen ? " is-compact" : ""}" data-abcard="orbit" data-abname="聚类树">
      <div class="ab-card-top">
        <span class="ab-card-title">聚类树</span>
        <div class="seg ab-orbit-switch" id="abOrbitSides" role="group" aria-label="聚类树版本">
          <span class="seg-knob" aria-hidden="true"></span>
          ${sides}
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

  /* 变化构成：三批总量收成一行读数，下方是四步瀑布桥。  Each problem the release touched
     moves the running total once, so the four steps walk 改版前 → 改版后 and the head keeps the two
     totals.  The plot is zoomed to the change band (totals in the head, values on every step), so a
     483 out of 3288 still reads; the dashed step lines carry the running total between columns.
     The card also hosts the orbit's leaf sample pane, so the tree stays a pure navigator. */
  /* Net change per stage (S1, S2 …): where the release moved problems, largest first. */
  function stageChanges(rnd) {
    const names = new Map((Array.isArray(rnd.nodes) ? rnd.nodes : []).map((n) => [n.id, n.name || n.id]));
    const by = new Map();
    (Array.isArray(rnd.leaves) ? rnd.leaves : []).forEach((leaf) => {
      if (leaf.after == null) return;
      const id = String(leaf.id || "").split(".")[0];
      if (!id) return;
      const row = by.get(id) || { id, name: names.get(id) || id, before: 0, after: 0 };
      row.before += num(leaf.before);
      row.after += num(leaf.after);
      by.set(id, row);
    });
    return [...by.values()].map((row) => ({ ...row, d: row.after - row.before }))
      .filter((row) => row.d).sort((a, b) => Math.abs(b.d) - Math.abs(a.d));
  }

  function stageRows(stages, limit) {
    const top = stages.slice(0, limit);
    const max = Math.max(1, ...top.map((row) => Math.abs(row.d)));
    return top.map((row) => {
      const w = (50 * Math.abs(row.d)) / max;
      const tone = row.d < 0 ? "is-better" : "is-worse";
      return `<div class="ab-stage ${tone}" title="${esc(`${row.id} ${row.name} · ${fmt(row.before)} → ${fmt(row.after)}`)}">
        <span class="ab-stage-name"><code>${esc(row.id)}</code>${esc(row.name)}</span>
        <span class="ab-stage-bar" aria-hidden="true"><i style="${row.d < 0 ? `right:50%` : `left:50%`};width:${w.toFixed(1)}%"></i></span>
        <span class="num ab-stage-ft">${fmt(row.before)}→${fmt(row.after)}</span>
        <b class="num">${signed(row.d)}</b>
      </div>`;
    }).join("");
  }

  function changeCard(rnd) {
    const measured = sideReady(rnd, "before") && sideReady(rnd, "after");
    const before = num(rnd.sides?.before?.hits);
    const after = num(rnd.sides?.after?.hits);
    const net = after - before;
    const flows = changeFlows(rnd);
    const better = flows.filter((f) => f.sign < 0).reduce((n, f) => n + f.count, 0);
    const worse = flows.filter((f) => f.sign > 0).reduce((n, f) => n + f.count, 0);
    const stages = measured ? stageChanges(rnd) : [];
    let level = before;
    const steps = flows.map((flow) => {
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
    return `<section class="ab-card ab-change-card ab-overview-side${state.overviewOpen === "change" ? " is-deep" : state.overviewOpen ? " is-compact" : ""}" id="abOverviewSide" data-abcard="change" data-abname="变化构成">
      <div class="ab-change-pane">
        <div class="ab-card-top"><span class="ab-card-title">变化构成</span></div>
        ${abComparisonHTML(rnd)}
        <div class="ab-bridge-main"><b class="num${measured && net < 0 ? " is-better" : measured && net > 0 ? " is-worse" : ""}">${measured ? signed(net) : DASH}</b><small>${measured ? "个问题" : "待复测"}</small>${measured && before ? `<span class="ab-bridge-chips"><span class="num${net < 0 ? " is-better" : net > 0 ? " is-worse" : ""}">${net > 0 ? "+" : net < 0 ? "−" : ""}${((100 * Math.abs(net)) / before).toFixed(1)}%</span><span class="is-better"><b class="num">${fmt(better)}</b> 类变好</span><span class="is-worse"><b class="num">${fmt(worse)}</b> 类变差</span></span>` : ""}</div>
        ${measured ? `<div class="ab-wf" role="img" aria-label="${esc(aria)}" title="纵轴只展开变化区间 ${fmt(lo)}–${fmt(hi)}，未从 0 起">
          <div class="ab-wf-plot">${cols}</div>
          <div class="ab-wf-labels">${labels}</div>
        </div>` : ""}
        ${stages.length ? `<div class="ab-stages" aria-label="各环节净变化">${stageRows(stages, state.overviewOpen === "change" ? 10 : 5)}</div>` : ""}
      </div>
      <div class="ab-side-pane" data-pane="samples"></div>
    </section>`;
  }

  /* 问题变化：变好与变差共用 0–max 刻度，两张排行合成一张卡；两段列表上下排，展开后卡更宽，
     哑铃和数值有更多横向空间。 */
  function rankCard(rnd, improved, worsened, max) {
    const open = state.overviewOpen === "ranks";
    return `<section class="ab-card ab-rank-card${open ? " is-deep" : state.overviewOpen ? " is-compact" : ""}" data-abcard="ranks" data-abname="问题变化">
      <div class="ab-card-top">
        <span class="ab-card-title" title="同一道题改版后的结果减去改版前的结果；线上真实用户的数据另算">问题变化</span>
        <span class="ab-rank-legend" aria-hidden="true"><i class="is-from"></i>改版前<i class="is-to"></i>改版后</span>
      </div>
      <div class="ab-rank-axis" aria-hidden="true"><div class="ab-rank-axis-track"><span>0</span><span>${fmt(max)}</span></div></div>
      ${rankPanel("变好", improved.slice(0, open ? 12 : 7), "is-better", max, improved.length, rnd)}
      ${rankPanel("变差", worsened.slice(0, open ? 12 : 7), "is-worse", max, worsened.length, rnd)}
    </section>`;
  }

  function overview(rnd, improved, worsened, max) {
    return `<section class="ab-overview" id="abOverview" data-open="${state.overviewOpen}" data-cards="3" aria-label="A/B Test 改版前后问题对比">
      ${orbitCard(rnd)}
      ${changeCard(rnd)}
      ${rankCard(rnd, improved, worsened, max)}
    </section>`;
  }

  function orbitTree(rnd, side) {
    const nodes = Array.isArray(rnd.nodes) ? rnd.nodes : [];
    const root = { id: "ab/root", name: TREE_LABEL[side], n: 0, children: [] };
    const byId = new Map();
    nodes.forEach((node) => {
      const n = num(node[side]);
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
      ${body}</section>`;
  }

  function summary(rnd) {
    const changesNow = changes(rnd);
    const improved = changesNow.filter((x) => x.d < 0).sort((a, b) => a.d - b.d || b.before - a.before);
    const worsened = changesNow.filter((x) => x.d > 0).sort((a, b) => b.d - a.d || b.after - a.after);
    const max = Math.max(1, ...changesNow.map((x) => Math.max(x.before, x.after)));
    const onlineRows = (Array.isArray(rnd.leaves) ? rnd.leaves : []).filter((leaf) => num(leaf.online) > 0);
    changesNow.forEach((row) => { row.onlineMatched = onlineRows.some((leaf) => pathRelated(row.leaf.id, leaf.id)); });
    return `<section class="ab-summary">${overview(rnd, improved, worsened, max)}</section>`;
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
    const ready = sideReady(rnd, state.orbitSide);
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
    const label = TREND_LABEL[metric] || metricLabel(metric);
    const kline = abTrendKline(rounds, values, metric, label);
    // 每个口径直接显示“问题数 · 涉及的 Trace 数”；Trace 数就是点击后召回的 case 数。
    // 变化矩阵只看发版前 / 发版后，不再混入线上真实样本。
    const refsBySide = {
      before: abTrendSampleRefs(rnd, ["before"], row, col.prefix),
      after: abTrendSampleRefs(rnd, ["after"], row, col.prefix),
      online: abTrendSampleRefs(rnd, ["online"], row, col.prefix),
    };
    const stat = (side, name, count) => {
      const refs = refsBySide[side];
      const body = `<span class="ab-trendstat-k">${name}</span><b class="num">${count == null ? DASH : fmt(count)}</b><span>个问题</span><span class="ab-trendstat-sep">·</span><b class="num">${fmt(refs.length)}</b><span>条 Trace</span>`;
      return refs.length
        ? `<button type="button" class="ab-trendstat" data-trend-samples data-sides="${side}" data-source="${name}" title="召回${name}命中的 ${fmt(refs.length)} 条 Trace">${body}</button>`
        : `<span class="ab-trendstat is-empty">${body}</span>`;
    };
    const stats = metric === "paired"
      ? `${stat("before", "发版前", cur.before)}${stat("after", "发版后", cur.after)}`
      : stat(metric, label, cur[metric]);
    const amount = (v) => (v == null ? "无" : fmt(v));
    const aria = metric === "paired"
      ? `AB 趋势：${row.name} · ${col.name}，${values.map((v) => `${v.label} 发版前 ${amount(v.before)} 发版后同题 ${amount(v.after)}`).join("；")}`
      : `AB 趋势：${row.name} · ${col.name}，${values.map((v) => `${v.label} ${label} ${amount(v[metric])}`).join("；")}`;
    cellTrendChart = { kline: kline.spec, picks: kline.picks, row, node: col.prefix, colName: col.name, round: rnd };
    return `<section class="ab-trend is-on" aria-live="polite">
      <div class="ab-trendhead">
        <span class="ab-trendname">${esc(row.name)} · ${esc(col.name)}</span>
        <span class="ab-trendmetric">${stats}</span>
      </div>
      ${trendSampleFrame(`<div class="mxt-plot" id="abCellTrend" role="img" aria-label="${esc(aria)}"></div>`)}
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
    const walk = (root, keys, keyOf) => {
      const path = [root];
      for (const k of Array.isArray(keys) ? keys : []) {
        const next = (path[path.length - 1].children || []).find((n) => keyOf(n) === k);
        if (!next) break;
        path.push(next);
      }
      return path;
    };
    const rowPath = walk(sceneRoot, state.mxRows, (n) => n.name);
    const colPath = walk(clusterRoot, state.mxCols, (n) => n.prefix || n.name);
    state.mxRows = rowPath.slice(1).map((n) => n.name);
    state.mxCols = colPath.slice(1).map((n) => n.prefix || n.name);
    state.mxTrail = state.mxTrail.filter((a) => (a === "r" ? rowPath.length > 1 : colPath.length > 1));
    const rowNode = rowPath[rowPath.length - 1];
    const colNode = colPath[colPath.length - 1];
    let view = matrixViewAb(rnd, rowNode.children || [], colNode.children || [], state.metric);
    // Only the scenes that carry this reading stay; each batch keeps its own empty state.
    const keep = view.rows.map((_, i) => i).filter((i) => view.cells[i].some((x) => state.metric === "paired"
      ? num(x.before) + num(x.after) > 0
      : num(x[state.metric]) > 0));
    if (keep.length && keep.length < view.rows.length) {
      view = {
        rows: keep.map((i) => view.rows[i]),
        cols: view.cols,
        cells: keep.map((i) => view.cells[i]),
        traces: Object.fromEntries(Object.entries(view.traces).map(([side, arr]) => [side, keep.map((i) => arr[i])])),
      };
    }
    // Same for the clusters: a stage that only appears in a batch outside this reading is not a column of this matrix.
    const keepCols = view.cols.map((_, ci) => ci).filter((ci) => view.cells.some((row) => state.metric === "paired"
      ? num(row[ci].before) + num(row[ci].after) > 0
      : num(row[ci][state.metric]) > 0));
    if (keepCols.length && keepCols.length < view.cols.length) {
      view = {
        rows: view.rows,
        cols: keepCols.map((ci) => view.cols[ci]),
        cells: view.cells.map((row) => keepCols.map((ci) => row[ci])),
        traces: view.traces,
      };
    }
    let selectedIdx = null;
    if (state.cell && !state.cell.row.all) {
      const ri = view.rows.findIndex((r) => r.name === state.cell.row.name || sceneMatches(state.cell.row, r.task || NO_SCENE, r.sub || ""));
      const ci = view.cols.findIndex((c) => c.prefix === state.cell.col.prefix);
      if (ri >= 0 && ci >= 0) selectedIdx = { ri, ci };
      else state.cell = null;
    }
    mxNow = { view, rowPath, colPath };
    const drilled = rowPath.length > 1 || colPath.length > 1;
    return `<section class="ab-matrixstep">
      <div class="ab-matrixhead"><div class="ab-matrix-title"><h3>聚类矩阵</h3>${drilled ? `<button type="button" class="mx-back" data-act="abmx-back" aria-label="返回上一级">← 返回</button>` : ""}</div><div class="ab-metrics" role="group" aria-label="矩阵口径">${metricChips(rnd)}</div><span class="ab-matrixmeta">${esc(roundLabel(rnd, state.round))} · ${esc(rnd.released_at || (rnd.dates || []).join(" ~ ") || "")}</span></div>
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
        btn.innerHTML = deep ? BACK_ICON : PUSH_ICON;
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

  function mountMatrixTail() {
    const rnd = rounds[state.round];
    const chartHost = host.querySelector("#abCellTrend");
    if (chartHost && cellTrendChart) {
      if (actions.mountCellTrend) cellTrendDrawer = actions.mountCellTrend(chartHost, cellTrendChart);
      else cellTrendDrawer = { ...createKlineChart(chartHost, cellTrendChart.kline), openPick: () => {} };
    }
    host.querySelectorAll("[data-trend-samples]").forEach((chip) => {
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

  /* Drill one layer without rebuilding the summary: only the matrix step is replaced, so the
     orbit, the cards' widths and the scroll position above stay exactly where they were. */
  function renderMatrix(animate = false) {
    const old = host.querySelector(".ab-matrixstep");
    if (!old || !host.isConnected) { render(); return; }
    cellTrendDrawer?.destroy();
    cellTrendDrawer = null;
    cellTrendChart = null;
    old.outerHTML = matrix(rounds[state.round]);
    const next = host.querySelector(".ab-matrixstep");
    if (animate && !REDUCED && next?.animate) {
      next.animate([
        { opacity: 0.35, transform: "translateY(-3px)" },
        { opacity: 1, transform: "none" },
      ], { duration: 180, easing: "cubic-bezier(0.2, 0.7, 0.2, 1)" });
    }
    mountMatrixTail();
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
        if (side === state.orbitSide || !sideReady(rnd, side)) return;
        state.orbitSide = side;
        showOrbitPane(null);
        const orbitHost = host.querySelector("#abOrbit");
        if (!orbitHost) return;
        mountOrbit(rnd, true);
      });
      control.set(state.orbitSide, { silent: true });
    }
    mountOrbit(rnd, true);
    mountMatrixTail();
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
      renderMatrix();
      return;
    }
    if (act === "abrow") {
      const node = mxNow?.view.rows[Number(action.dataset.ri)];
      if (!node?.children?.length) return;
      state.mxRows = [...state.mxRows, node.name];
      state.mxTrail = [...state.mxTrail, "r"];
      state.cell = null;
      renderMatrix(true);
      return;
    }
    if (act === "abcol") {
      const node = mxNow?.view.cols[Number(action.dataset.ci)];
      if (!node?.children?.length) return;
      state.mxCols = [...state.mxCols, node.prefix || node.name];
      state.mxTrail = [...state.mxTrail, "c"];
      state.cell = null;
      renderMatrix(true);
      return;
    }
    if (act === "abmx-back") {
      const axis = state.mxTrail.pop();
      if (axis === "r" && state.mxRows.length) state.mxRows = state.mxRows.slice(0, -1);
      else if (axis === "c" && state.mxCols.length) state.mxCols = state.mxCols.slice(0, -1);
      else if (state.mxCols.length) state.mxCols = state.mxCols.slice(0, -1);
      else if (state.mxRows.length) state.mxRows = state.mxRows.slice(0, -1);
      state.cell = null;
      renderMatrix(true);
      return;
    }
    if (act === "cell") {
      if (!mxNow) return;
      const { view } = mxNow;
      const total = action.dataset.ri === "total";
      const ri = Number(action.dataset.ri);
      const ci = Number(action.dataset.ci);
      const col = view.cols[ci];
      if (!col) return;
      if (total) {
        state.cell = { row: { name: "全部场景", all: true }, col: { name: col.name, prefix: col.prefix } };
      } else {
        const row = view.rows[ri];
        if (!row) return;
        state.cell = { row: rowScope(row), col: { name: col.name, prefix: col.prefix } };
      }
      renderMatrix();
    }
  });

  host.addEventListener("pointerover", (e) => {
    const cell = e.target.closest(".cell[data-abmx]");
    const table = host.querySelector(".abmatrix");
    if (!table) return;
    if (!cell || cell.classList.contains("is-empty")) {
      table.querySelectorAll(".is-hl, .is-cur").forEach((x) => x.classList.remove("is-hl", "is-cur"));
      return;
    }
    const [ri, ci] = cell.dataset.abmx.split(":").map(Number);
    table.querySelectorAll(".is-hl, .is-cur").forEach((x) => x.classList.remove("is-hl", "is-cur"));
    table.querySelector(`.cell[data-abmx="${ri}:${ci}"]`)?.classList.add("is-cur");
    table.querySelectorAll(".rh").forEach((h, i) => h.classList.toggle("is-hl", i === ri));
    table.querySelectorAll(".mh").forEach((h, i) => h.classList.toggle("is-hl", i === ci));
    table.querySelectorAll(".rowtot").forEach((h, i) => h.classList.toggle("is-hl", i === ri));
    table.querySelectorAll(".coltot").forEach((h, i) => h.classList.toggle("is-hl", i === ci));
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
