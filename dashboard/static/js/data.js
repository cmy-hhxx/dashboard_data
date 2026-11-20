/* 数据: 会话场 · 聚类矩阵 · 数据量 · 评测量 · 归因体系 · 聚类体系 · 预测体系. Titles only; the layout carries the rest.
   Charts drill in place; a session tile opens 具体数据 for that Trace, a matrix cell opens its trend chart in the card. */
import { $, $$, esc, fmt, pct, sum, compact, WORST, SEV_NAME, KIND, sevColor, counter, runCounters, bindTips, segmented, REDUCED, showTip, hideTip, getJSON } from "./core.js";
import { renderContent } from "./render.js";
import { sunburst } from "./sunburst.js";
import { sunburstTween } from "./motion.js";
import { galaxy } from "./galaxy.js";
import { mountAB } from "./abtest.js";
import { mountDailyTop, resolveDailyTip } from "./daily_top.js";
import { mountProblemTrends } from "./problem_trends.js";
import { traceSeverityModel, traceShares } from "./trace_analysis.js";
import { createKlineChart, createTrendChart, KLINE_PERIODS } from "./kline_chart.js";
import { buildIntradayCandles } from "./kline_data.js";
import { trendSampleFrame, abTrendSampleRefs, resolveABSamples, trendSampleCandidates, trendSampleProblems, traceSampleRefs } from "./trend_samples.js";
import { patternName as patName } from "./taxonomy.js";

let ctx;
let abDocKey = null;
let mxDocKey = null;
let mxMoreCleanup = null;
let shown = null;
let lastDetail = null;
/* View state per product that outlives a redraw: an in-place data refresh (or switching product
   and back) lands on the same filter, page, ring, drill path and tab. */
const UI = {};
const ui = (product) =>
  (UI[product] = UI[product] || {
    field: { w: null, pages: [] }, vol: {}, clu: {}, prd: {}, pred: "vol",
    mx: {
      rows: [], cols: [], trail: [], issuePath: [], analysisLevels: ["P0", "P1"], analysisPeriod: "day", analysisZoom: false,
      // 聚类矩阵格子的就地趋势图：口径 / 场景 + 来源·模型·等级的折线组 + 是否打开都活在这里，
      // 就地刷新或切换产品再回来仍是同一张图。rowKeys/colKeys 是行列路径，刷新后用来重新定位。
      trend: { open: false, measure: "count", scope: "row", lines: [], active: 0, seeded: false, rowKeys: null, colKeys: null, zoom: false },
    },
  });
const SPLIT_SHORT = { daily: "日常", lost: "流失" };
// A 数据量 branch with inputs but no evaluated Trace: the ring keeps it shut and says where to look.
const NO_CASE = "暂无已评测 Trace";
const dot = (c) => `<i style="--c:${c}"></i>`;

export async function render(root, c) {
  ctx = c;
  const p = c.data.products[c.product];
  const params = new URLSearchParams(location.search);
  const detail = params.get("detail") === "eval";
  const ed = detail ? params.get("ed") || "" : "";
  const em = detail ? params.get("em") || "" : "";
  const ep = Math.max(1, Number(params.get("ep")) || 1);
  const edp = Math.max(1, Number(params.get("edp")) || 1);
  const key = `${c.product}|${c.data.generated_at}|${detail ? `eval|${ed}|${em}|${ep}|${edp}` : "home"}`;
  if (shown === key && root.firstChild) return;
  shown = key;
  // A redraw replaces the whole board: drop the fullscreen lock first, the AB block re-applies it.
  document.body.classList.remove("is-ab-full", "is-mxp-full", "is-mx-full");
  if (!p) {
    root.innerHTML = `<div class="bento"><article class="card" style="--span:12"><div class="empty">${
      c.product === "wencai" ? "问财" : "AIME"
    } 暂无评测数据</div></article></div>`;
    return;
  }
  if (detail) {
    const state = evalDetailState(p, { ed, em, ep, edp });
    root.innerHTML = evalDetailPage(p, state);
    runCounters(root);
    wireEvalDetail(root, state);
    if (state.day && state.model) fillEvalInputs(root, state);
    window.scrollTo(0, 0);
    lastDetail = true;
    return;
  }
  const tax = c.data.taxonomy;
  const u = ui(c.product);
  if (c.refresh) root.classList.add("is-refresh");
  // 数据页顺序：规模/质量读数 → 聚类矩阵 → 三个分析体系 → 会话场（最重、放最后）。
  root.innerHTML = `<div class="bento">${volumeCard(p)}${evalCard(p)}${matrixCard(p, tax)}${attrCard(p)}${clusterCard(p, tax)}${predictCard(p)}${fieldCard(p, u)}</div>`;
  wire($(".bento", root), p, tax, u);
  if (c.refresh) requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove("is-refresh")));
  else runCounters(root);
  if (lastDetail) {
    window.scrollTo(0, 0);
    lastDetail = null;
  }
}

const ICON_COLLAPSE = `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M15 6l-6 6 6 6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
/* Every push-pull card carries the way back to its default state in the head, so one card's
   transition reads the same as the next instead of hiding inside the star map. */
const stateBtn = `<button type="button" class="icon-btn card-state" data-collapse hidden aria-label="收起卡片" title="收起">${ICON_COLLAPSE}</button>`;
const card = (span, title, body, end = "", key = "", cls = "") =>
  `<article class="card${cls ? ` ${cls}` : ""}" style="--span:${span}"${key ? ` data-card="${key}"` : ""}><header class="card-head"><h2>${title}</h2>${end}${key ? stateBtn : ""}</header>${body}</article>`;
/* Push-pull slots: the star map an opened card shows, and the mini view a folded card keeps. */
const GX = `<div class="gx" data-own-tip hidden></div>`;
/* Folded cards keep their identity: each card's compact state draws its own little graphic —
   a ring, day columns, a severity strip or an accuracy line — beside its key numbers. */
const miniRing = (segs) => {
  const total = sum(segs.map((s) => s.n)) || 1;
  let acc = 0;
  const arcs = segs
    .filter((s) => s.n > 0)
    .map((s) => {
      const len = (100 * s.n) / total;
      const dash = Math.max(0.9, len - 1);
      const at = acc;
      acc += len;
      return `<circle class="cxr-a" cx="24" cy="24" r="18" pathLength="100" style="stroke:${s.c};stroke-dasharray:${dash} ${100 - dash};stroke-dashoffset:${-at}"/>`;
    })
    .join("");
  return `<svg class="cxr" viewBox="0 0 48 48" aria-hidden="true"><circle class="cxr-t" cx="24" cy="24" r="18"/>${arcs}</svg>`;
};
const miniStrip = (parts) =>
  `<span class="cxs" aria-hidden="true">${parts.filter((p) => p.n > 0).map((p) => `<i style="flex:${p.n} 1 0;background:${p.c}"></i>`).join("")}</span>`;
const miniCols = (bars) => {
  const max = Math.max(1, ...bars.map((b) => b.all || 0));
  return `<span class="cxcols" aria-hidden="true">${bars.map((b) => `<i style="height:${Math.max(8, (100 * (b.all || 0)) / max)}%"><b style="height:${b.all ? Math.min(100, (100 * (b.done || 0)) / b.all) : 0}%"></b></i>`).join("")}</span>`;
};
const miniLine = (vals) => {
  if (vals.length < 2) return `<span class="cxvoid" aria-hidden="true"></span>`;
  const W = 48, H = 34, pad = 4;
  const xs = vals.map((_, i) => pad + (i * (W - pad * 2)) / (vals.length - 1));
  const ys = vals.map((v) => H - pad - (Math.max(0, Math.min(100, v)) / 100) * (H - pad * 2));
  return `<svg class="cxline" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true"><polyline points="${xs.map((x, i) => `${x.toFixed(1)},${ys[i].toFixed(1)}`).join(" ")}"/></svg>`;
};
/* Under the numbers, the ranking behind them: a name, a value and a share bar per row, so a folded
   card still answers "which one" instead of leaving a hollow card around two figures. */
const miniRank = (rows) =>
  rows.length
    ? `<div class="cr-list">${rows
        .map((r, i) => {
          const w = r.share > 0 ? Math.max(1.5, Math.min(100, 100 * r.share)) : 0;
          return `<div class="cr" style="--i:${i};--w:${w.toFixed(1)}%${r.c ? `;--c:${r.c}` : ""}"><span>${esc(r.name)}</span><b class="num">${r.value}</b><i></i></div>`;
        })
        .join("")}</div>`
    : "";
const miniView = (viz, items, hint = "", rank = [], foot = "") =>
  `<div class="compact" aria-hidden="true"><div class="cx-top"><div class="cn">${items
    .filter(Boolean)
    .map(([v, l], i) => `<div${i ? "" : ' class="lead"'}><b class="num">${v}</b><small>${esc(l)}</small></div>`)
    .join("")}</div><div class="cx">${viz}</div></div>${hint ? `<small class="cxhint">${esc(hint)}</small>` : ""}${miniRank(rank)}${foot}</div>`;
// The leader of a ranking in accent, the rest in one quiet tone.
const leadTone = (i) => (i ? "var(--t2)" : "var(--accent)");
const modelName = (p, id) => (p.models.find((m) => m.id === id) || { label: id }).label;
const groupName = (p, g) => (p.unified || p.splits.length <= 1 ? "" : `${SPLIT_SHORT[g.split] || g.split} · `) + modelName(p, g.model);
const stats = (items, cols = 4) => `<div class="stats${cols === 5 ? " stats-5" : ""}">${items.map(([l, v]) => `<div><b class="num">${v}</b><small>${l}</small></div>`).join("")}</div>`;
/* Versions: first half accent, second half ink; Fast full, Expert lighter. */
const shade = (i, n) =>
  i < Math.ceil(n / 2) ? `color-mix(in oklab, var(--accent) ${i % 2 ? 48 : 100}%, var(--card))` : `color-mix(in oklab, var(--ink) ${i % 2 ? 34 : 70}%, var(--card))`;

/* ---------------------------------------------------------------- 会话场 */
const FIELD_ROWS = 16;
const FIELD_TILE = 13; // 11px tile + 2px gap

function fieldCard(p, u) {
  const groups = p.field
    .map((g, gi) => `<div class="fgroup" data-g="${gi}"><div class="fgroup-head"><b>${esc(groupName(p, g))}</b><span class="num">${fmt(g.cells.length)} 条 · ${fmt(g.sessions ?? g.cells.length)} 场</span>${
      g.lost ? `<span class="fgroup-lost"><i></i>流失会话 ${fmt(g.lost)}</span>` : ""
    }</div><div class="tiles"></div><div class="pager field-pager" data-pager="${gi}" hidden></div></div>`)
    .join("");
  const legend = `<div class="legend end" id="fieldLegend">${WORST.map(
    (w, i) => `<button type="button" style="--c:${sevColor(i)}" data-w="${i}" aria-pressed="${u.field.w === String(i)}"><i></i>${SEV_NAME[w]}<b class="num">${fmt(p.worst[w])}</b></button>`,
  ).join("")}</div>`;
  return card(12, "会话场", `<div class="field is-intro" id="field"><div class="field-groups">${groups}</div></div>`, legend);
}

/* Every jump into 具体数据 starts from a clean filter set plus what the click pins down. */
const SAMPLE_RESET = {
  detail: null, ed: null, em: null, ep: null, edp: null, p: null, tab: null, q: null, w: null, split: null,
  date: null, model: null, scene: null, sub: null, stage: null, mech: null, pattern: null, case: null, trace: null,
};
function openForecast(slug) {
  ctx.navigate({ ...SAMPLE_RESET, view: "forecast", product: ctx.product, case: slug, res: null, cls: null, typ: null, cause: null });
}
function openSamples(patch) {
  ctx.navigate({ ...SAMPLE_RESET, view: "samples", product: ctx.product, ...patch });
}
/* A/B sample entries land on the version-compare page instead: the same question before and
   after the release, side by side. `pair` selects the question, `online` opens a live sample on
   its own (no same-question twin). */
const COMPARE_RESET = { ...SAMPLE_RESET, pair: null, online: null, round: null };
function openCompare(patch) {
  ctx.navigate({ ...COMPARE_RESET, view: "compare", product: ctx.product, ...patch });
}

/* One tile per evaluation record. Each model/split group has its own pager. Pages
   are filled to the measured capacity, and each severity is spread across the
   pages in proportion so a full page keeps the same mix as the group. */
function dealFieldPages(cells, capacity) {
  const total = cells.length;
  const count = Math.max(1, Math.ceil(total / capacity));
  const counts = Array.from({ length: count }, (_, p) => Math.min(capacity, total - p * capacity));
  const buckets = WORST.map(() => []);
  cells.forEach((c, i) => buckets[c[1]].push({ c, i }));
  const rem = buckets.map((b) => b.length);
  const alloc = counts.map(() => Array(WORST.length).fill(0));
  for (let p = 0; p < count; p++) {
    if (p === count - 1) {
      alloc[p] = rem.slice();
      continue;
    }
    const need = counts[p];
    const totalRem = sum(rem);
    const quotas = rem.map((n) => (need * n) / totalRem);
    const base = quotas.map(Math.floor);
    let left = need - sum(base);
    const order = quotas.map((q, s) => ({ s, f: q - base[s] })).sort((a, b) => b.f - a.f);
    while (left > 0) {
      let moved = false;
      for (const { s } of order) {
        if (left <= 0) break;
        if (base[s] < rem[s]) {
          base[s] += 1;
          left -= 1;
          moved = true;
        }
      }
      if (!moved) break;
    }
    alloc[p] = base;
    base.forEach((n, s) => (rem[s] -= n));
  }
  const pages = counts.map(() => []);
  buckets.forEach((bucket, s) => {
    let offset = 0;
    for (let p = 0; p < count; p++) {
      const n = alloc[p][s];
      pages[p].push(...bucket.slice(offset, offset + n));
      offset += n;
    }
  });
  return { pages, counts };
}

function paintField(field, p, filter) {
  const groups = $$(".fgroup", field);
  if (!groups.length) return;
  const groupsEl = $(".field-groups", field);
  const cols = Math.max(1, getComputedStyle(groupsEl).gridTemplateColumns.split(" ").filter(Boolean).length);
  const groupRows = Math.ceil(p.field.length / cols);
  const rows = Math.max(1, Math.floor(FIELD_ROWS / groupRows));
  field._page = field._page || [];
  p.field.forEach((g, gi) => {
    const group = groups[gi];
    const tiles = $(".tiles", group);
    const pager = $(".field-pager", group);
    if (!tiles) return;
    const perRow = Math.max(1, Math.floor((tiles.clientWidth + 2) / FIELD_TILE));
    const capacity = Math.max(1, perRow * rows);
    const dealt = dealFieldPages(g.cells, capacity);
    const pages = dealt.pages.length;
    const cur = Math.min(Math.max(1, field._page[gi] || 1), pages);
    field._page[gi] = cur;
    tiles.style.minHeight = `${Math.max(0, rows * FIELD_TILE - 2)}px`;
    tiles.innerHTML = dealt.pages[cur - 1]
      .map(({ c, i }, k) => `<span style="--c:${sevColor(c[1])};--i:${Math.min(k, 240)}" data-cell="${gi}:${i}" data-w="${c[1]}"></span>`)
      .join("");
    if (!pager) return;
    pager.hidden = pages <= 1;
    pager.dataset.page = String(cur);
    pager.dataset.pages = String(pages);
    if (pages > 1) {
      const btn = (key, label, off) => `<button type="button" data-page="${key}"${off ? " disabled" : ""}>${label}</button>`;
      pager.innerHTML = `${btn("prev", "上一页", cur === 1)}
        <span class="pager-info">第 <b class="num">${cur}</b> / ${pages} 页 · ${fmt(g.cells.length)} 条记录</span>
        ${btn("next", "下一页", cur === pages)}`;
    }
  });
  field.classList.toggle("is-filtered", !!filter);
  $$(".tiles span", field).forEach((t) => t.classList.toggle("on", !!filter && t.dataset.w === filter));
}

/* ---------------------------------------------------------------- 数据量: version → task → subtask */
function volumeCard(p) {
  const k = p.kpi;
  const input = p.input || {};
  const pending = `<span class="stat-pending" title="工具调用和 Token 用量的数据还没接进来">—</span>`;
  const tin = input.tokens_in;
  const tout = input.tokens_out;
  // Input tokens lead; the output side rides along small, so the cell never truncates.
  const tokens = tin != null || tout != null
    ? `${compact(tin || 0)}<span class="stat-of"> / ${compact(tout || 0)}</span>`
    : pending;
  const lost = input.lost;
  const records = input.records ?? k.inputs;
  // Session 是去重会话数（session×模型×split，和「完成 Session」同口径），Trace 是输入快照里的
  // trace 条数；两者正好做评测量卡「完成 / 输入」的分母，两张卡的合计因此逐位对得上。
  const sessions = input.sessions;
  const num = (v) => counter(v, { unit: true, title: fmt(v) });
  const items = [
    ["评测输入 Session", sessions != null ? num(sessions) : counter(records)],
    ["评测输入 Trace", num(input.traces ?? k.traces)],
    ...(lost != null ? [["流失轨迹", num(lost)]] : []),
    ["工具调用", input.tool_calls != null ? num(input.tool_calls) : pending],
    ["Tokens 输入/输出", tokens],
  ];
  const note = lost ? `<div class="sb-keys"><span class="sb-key" title="外圈细环是这一类里流失用户的 Trace 占比；红字是流失 Trace 的个数"><i></i>流失</span></div>` : "";
  const segs = volMiniSegs(p);
  const segTotal = sum(segs.map((x) => x.n)) || 1;
  const folded = miniView(miniRing(segs), [
    [compact(sessions ?? records), "评测输入 Session"], [compact(input.traces ?? k.traces), "评测输入 Trace"],
    lost != null ? [compact(lost), "流失轨迹"] : null, tin != null ? [compact(tin), "输入 Tokens"] : null,
  ], "", [...segs].sort((a, b) => b.n - a.n).slice(0, 8).map((x) => ({ name: x.name, value: fmt(x.n), share: x.n / segTotal, c: x.c })));
  return card(6, "数据量", `<div class="duo" id="vol"></div>${note}${stats(items, items.length > 4 ? 5 : 4)}${GX}${folded}`, "", "vol");
}
function inputTaskNodes(prefix, tasks) {
  return (tasks || []).map((t) => ({
    id: `${prefix}/${t.task}`, name: t.task, n: t.n, lost: t.lost || 0, ev: t.ev,
    children: (t.sub || []).map((s) => ({
      id: `${prefix}/${t.task}/${s.sub}`, name: s.sub, n: s.n, lost: s.lost || 0, ev: s.ev,
    })),
  }));
}
function volTree(p) {
  const input = p.input;
  if (input?.models && Object.keys(input.models).length) {
    return {
      id: "v", name: "全部", n: input.traces || sum(Object.values(input.models).map((m) => m.traces)),
      lost: input.lost || 0,
      children: (() => {
        const order = new Map((p.models || []).map((m, i) => [m.id, i]));
        return Object.entries(input.models)
          .sort(([a], [b]) => (order.get(a) ?? 99) - (order.get(b) ?? 99))
          .map(([id, m]) => ({
            id: `v/${id}`, name: m.label || modelName(p, id), n: m.traces, lost: m.lost || 0, ev: m.ev,
            children: inputTaskNodes(`v/${id}`, m.tasks),
          }));
      })(),
    };
  }
  if (input?.tasks?.length) {
    return {
      id: "v", name: "全部", n: input.traces || sum(input.tasks.map((t) => t.n)),
      lost: input.lost || 0, children: inputTaskNodes("v", input.tasks),
    };
  }
  return { id: "v", name: "全部", n: p.kpi.inputs || 0, lost: 0, children: [] };
}
/* The folded card mirrors the ring's innermost split: models first, then the top-level tasks. */
function volMiniSegs(p) {
  const input = p.input || {};
  if (input.models && Object.keys(input.models).length) {
    const order = new Map((p.models || []).map((m, i) => [m.id, i]));
    const list = Object.entries(input.models).sort(([a], [b]) => (order.get(a) ?? 99) - (order.get(b) ?? 99));
    const n = Math.max(list.length, (p.models || []).length, 1);
    return list.map(([id, m], i) => ({ name: m.label || modelName(p, id), n: m.traces || 0, c: shade(order.has(id) ? order.get(id) : i, n) }));
  }
  const tasks = input.tasks || [];
  return tasks.slice(0, 6).map((t, i) => ({ name: t.task, n: t.n || 0, c: shade(i, Math.max(tasks.length, 1)) }));
}

/* ---------------------------------------------------------------- 评测量: inputs vs completed per day */
const dayCount = (d) => Object.entries(d).reduce((n, [k, v]) => (k === "d" ? n : n + (v || 0)), 0);
const DAY_MS = 86400000;
const dayMs = (d) => Date.parse(`${d}T00:00:00Z`);
const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const EV_PER_ROW = 15;
const RANGE_LABEL = { 7: "近 7 天", 30: "近 30 天", all: "全部" };
// year: 「全部」柱状图超过 12 个月时切到年份，点某一年再下钻成该年的月份。
const EV = { range: "all", model: "all", year: null };
// 模型分段只保留这几个已知家族：变体（b_expert_only_*、b_expert_search_test_v2）按前缀归入
// 对应家族，归不进去的模型不占用分段，也不进入任何单模型口径（全部里仍然算）。
const EV_FAMILIES = [
  { id: "a_fast", label: "A Fast", match: /^a_fast/ },
  { id: "b_fast", label: "B Fast", match: /^b_fast/ },
  { id: "a_expert", label: "A Expert", match: /^a_expert/ },
  { id: "b_expert", label: "B Expert", match: /^b_expert/ },
  { id: "aime_fast", label: "Fast", match: /^aime_fast/ },
  { id: "aime_expert", label: "Expert", match: /^aime_expert/ },
  { id: "fast", label: "Fast", match: /^fast/ },
  { id: "expert", label: "Expert", match: /^expert/ },
];
const modelFamily = (id) => EV_FAMILIES.find((f) => f.match.test(String(id || "").toLowerCase()))?.id || null;
function familyInput(input, family) {
  const models = input?.models || {};
  return Object.keys(models).reduce((acc, key) => {
    if (modelFamily(key) !== family) return acc;
    acc.sessions += models[key].sessions || 0;
    acc.traces += models[key].traces || 0;
    return acc;
  }, { sessions: 0, traces: 0 });
}

function evalRows(p) {
  if (Array.isArray(p.daily) && p.daily.length) return p.daily;
  // Fallback for a payload built before daily input counts existed.
  return (p.dates || []).map((d) => {
    const n = dayCount(d);
    return { d: d.d, m: "all", sp: "", inputs: n, evaluated: n };
  });
}

function evalModels(p) {
  const present = new Set();
  evalRows(p).forEach((row) => {
    const family = modelFamily(row.m);
    if (family) present.add(family);
  });
  return [{ id: "all", label: "全部" }, ...EV_FAMILIES.filter((f) => present.has(f.id)).map(({ id, label }) => ({ id, label }))];
}

function evalWindow(p) {
  const byDay = new Map();
  const blank = () => ({ inputs: 0, evaluated: 0, traces: 0, tokens: 0, tokenRecords: 0, sessions: 0,
    inTraces: 0, hasTraces: true, hasIns: true, sids: new Set(), inSids: new Set() });
  evalRows(p)
    .filter((r) => EV.model === "all" || modelFamily(r.m) === EV.model)
    .forEach((r) => {
      const x = byDay.get(r.d) || blank();
      x.inputs += r.inputs || 0;
      x.evaluated += r.evaluated || 0;
      x.traces += r.traces ?? r.evaluated ?? 0;
      x.tokens += r.tokens || 0;
      x.tokenRecords += r.token_records || 0;
      if (r.input_traces == null) x.hasTraces = false;
      else x.inTraces += r.input_traces;
      if (!Array.isArray(r.in_sids)) x.hasIns = false;
      else r.in_sids.forEach((sid) => x.inSids.add(`${r.sp}|${r.m}|${sid}`));
      if (Array.isArray(r.sids)) r.sids.forEach((sid) => x.sids.add(`${r.sp}|${r.m}|${sid}`));
      else x.sessions += r.sessions || r.evaluated || 0;
      byDay.set(r.d, x);
    });
  let dates = [...byDay.keys()].sort();
  // 「全部」下钻到某一年时，窗口只保留这一年；月份桶怎么切由 evalBuckets 决定。
  if (EV.range === "all" && EV.year) dates = dates.filter((d) => d.startsWith(EV.year));
  if (!dates.length) {
    return { days: [], totalInputs: 0, totalEval: 0, totalSessions: 0, totalTraces: 0, totalTokens: 0, totalInputSessions: null, totalInputTraces: null, peakEval: 0 };
  }
  const end = dayMs(dates[dates.length - 1]);
  const start = EV.range === "all" ? dayMs(dates[0]) : end - (Number(EV.range) - 1) * DAY_MS;
  const days = [];
  for (let t = start; t <= end; t += DAY_MS) {
    const d = isoDay(t);
    days.push({ d, ...(byDay.get(d) || blank()) });
  }
  const sessions = new Set(days.flatMap((x) => [...x.sids]));
  return {
    days,
    totalInputs: sum(days.map((x) => x.inputs)),
    totalEval: sum(days.map((x) => x.evaluated)),
    totalSessions: sessions.size + sum(days.map((x) => x.sessions)),
    totalTraces: sum(days.map((x) => x.traces)),
    totalTokens: sum(days.map((x) => x.tokens)),
    totalTokenRecords: sum(days.map((x) => x.tokenRecords)),
    totalInputSessions: days.every((x) => x.hasIns) ? new Set(days.flatMap((x) => [...x.inSids])).size : null,
    totalInputTraces: days.every((x) => x.hasTraces) ? sum(days.map((x) => x.inTraces)) : null,
    peakEval: Math.max(0, ...days.map((x) => x.evaluated)),
  };
}

/* 全部：最多 12 根柱子。有数据的月份 ≤12 就按月（只画有数据的月）；超过 12 个月按年，
   点某年再回到那一年的月份。近 7/30 天保持按天，和以前一样。 */
function evalBuckets(days) {
  if (EV.range !== "all") {
    return days.map((x) => ({
      ...x,
      inTraces: x.hasTraces ? x.inTraces : x.inputs,
      label: x.d.slice(5),
      tip: x.d,
    }));
  }
  const months = new Map();
  days.forEach((x) => {
    const inTr = x.hasTraces ? x.inTraces : x.inputs;
    if (!x.inputs && !x.evaluated && !inTr && !x.traces) return;
    const key = x.d.slice(0, 7);
    let b = months.get(key);
    if (!b) months.set(key, (b = { d: x.d, d0: x.d, d1: x.d, inputs: 0, evaluated: 0, inTraces: 0, traces: 0 }));
    b.d0 = b.d0 < x.d ? b.d0 : x.d;
    b.d1 = b.d1 > x.d ? b.d1 : x.d;
    b.inputs += x.inputs;
    b.evaluated += x.evaluated;
    b.inTraces += inTr;
    b.traces += x.traces;
  });
  const keys = [...months.keys()].sort();
  const monthBar = (k) => ({ ...months.get(k), label: `${Number(k.slice(5))}月`, tip: k });
  if (EV.year || keys.length <= 12) {
    return keys.filter((k) => !EV.year || k.startsWith(EV.year)).map(monthBar);
  }
  const years = new Map();
  keys.forEach((k) => {
    const y = k.slice(0, 4);
    const m = months.get(k);
    let b = years.get(y);
    if (!b) years.set(y, (b = { year: y, d: `${y}-01-01`, d0: `${y}-01-01`, d1: `${y}-12-31`, inputs: 0, evaluated: 0, inTraces: 0, traces: 0 }));
    b.inputs += m.inputs;
    b.evaluated += m.evaluated;
    b.inTraces += m.inTraces;
    b.traces += m.traces;
  });
  return [...years.keys()].sort().map((y) => ({ ...years.get(y), label: y, tip: y }));
}

function evalChart(p) {
  const bars = evalBuckets(evalWindow(p).days);
  if (!bars.length) return `<div class="empty">暂无评测日期</div>`;
  const max = Math.max(1, ...bars.map((x) => Math.max(x.inTraces, x.traces)));
  const rows = [];
  for (let i = 0; i < bars.length; i += EV_PER_ROW) rows.push(bars.slice(i, i + EV_PER_ROW));
  const barH = rows.length === 1 ? 160 : 44;
  return `<div class="evrows${EV.range === "all" ? " is-buckets" : ` is-days${EV.range === "7" ? " is-week" : ""}`}" style="--bar-h:${barH}px">${rows
    .map((row) => `<div class="evrow" style="--n:${row.length}">${row
      .map((x) => {
        const total = Math.max(x.inTraces, x.traces, 1);
        const height = Math.max(3, (barH * total) / max);
        const done = x.traces ? Math.min(100, (100 * x.traces) / Math.max(x.inTraces, x.traces)) : 0;
        const tip = `${x.tip || x.d}|输入 ${compact(x.inTraces)} 条 Trace · 已完成 ${compact(x.traces)} 条 Trace · ${pct(x.traces, x.inTraces, 1)}`;
        return `<div class="evday${x.traces ? " is-live" : ""}${x.year ? " is-drill" : ""}"${x.year ? ` data-year="${esc(x.year)}"` : ""} data-d0="${x.d0 || x.d}" data-d1="${x.d1 || x.d}"><div class="evnums"><b class="num">${compact(x.traces)}</b><small class="num">${compact(x.inTraces)}</small></div>
          <div class="evbar" style="height:${height}px" data-tip="${esc(tip)}"><i style="height:${done}%"></i></div>
          <small class="evdate num">${esc(x.label)}</small></div>`;
      })
      .join("")}</div>`)
    .join("")}</div>`;
}

/* 评测量是「输出 / 输入」对账：口径跟 ev-range 走，近 7/30 天用窗口合计，
   全部（以及年份下钻）用全量/该年合计。默认全部，所以首次加载的
   完成 Session / 输入 Session、完成 Trace / 输入 Trace 与数据量卡逐位相等；
   切到近 7/30 天是本卡的缩放，不再声称与全量数据量卡对账。 */
function evalTotals(p) {
  const w = evalWindow(p);
  const k = p.kpi;
  const input = p.input || {};
  const scoped = EV.range !== "all" || !!EV.year;
  const model = EV.model !== "all";
  const allInput = model ? familyInput(input, EV.model) : input;
  return {
    scoped,
    sessions: [scoped || model ? w.totalSessions : k.unique_sessions, scoped ? w.totalInputSessions : allInput.sessions],
    traces: [scoped || model ? w.totalTraces : k.traces, scoped ? w.totalInputTraces : allInput.traces],
    tokens: scoped || model ? w.totalTokens : k.tokens,
    tokenRecords: scoped || model ? (w.totalTokenRecords || 0) : k.token_records,
    records: scoped || model ? w.totalEval : k.sessions,
  };
}

function evalStats(p) {
  const t = evalTotals(p);
  const ratio = ([a, b]) =>
    b == null
      ? counter(a, { unit: true, title: fmt(a) })
      : `${counter(a, { unit: true, title: `已完成 ${fmt(a)}` })}<span class="stat-of"> / ${counter(b, { unit: true, title: `输入 ${fmt(b)}` })}</span>`;
  const items = [
    ["完成 Session / 输入", ratio(t.sessions)],
    ["完成 Trace / 输入", ratio(t.traces)],
    ["评测 Tokens",
      counter(t.tokens, { unit: true, title: `已上报 tokens 合计 ${fmt(t.tokens)} · 覆盖 ${fmt(t.tokenRecords)} / ${fmt(t.records)} 条评测记录` })],
  ];
  return stats(items);
}

/* 图例行右侧的「‹ 2026 年」只在年份下钻时出现，点它回到全部年份。 */
function evalLegend() {
  const back = EV.range === "all" && EV.year
    ? `<button type="button" class="link ev-back" id="evYearBack" aria-label="返回全部年份">‹ ${esc(EV.year)} 年</button>`
    : "";
  return `<div class="ev-legend"><span><i class="ev-done"></i>已完成 Trace</span><span><i class="ev-in"></i>评测输入 Trace</span>${back}</div>`;
}

function evalCard(p) {
  const models = evalModels(p);
  if (!models.some((m) => m.id === EV.model)) EV.model = "all";
  // 产品/数据变了以后旧的下钻年份可能已经没有数据，退回全部年份。
  if (EV.year && !evalRows(p).some((r) => r.d.startsWith(EV.year))) EV.year = null;
  return card(6, "评测量", `<div class="eval-content">
    <div class="ev-tools">
      <div class="seg ev-range" id="evRange"><span class="seg-knob" aria-hidden="true"></span>
        ${["7", "30", "all"].map((v) => `<button type="button" data-value="${v}">${RANGE_LABEL[v]}</button>`).join("")}
      </div>
      <div class="seg ev-model" id="evModel"><span class="seg-knob" aria-hidden="true"></span>
        ${models.map((m) => `<button type="button" data-value="${esc(m.id)}">${esc(m.label)}</button>`).join("")}
      </div>
    </div>
    <div id="evLegend">${evalLegend()}</div>
    <div id="evChart">${evalChart(p)}</div>
    <div id="evStats">${evalStats(p)}</div></div>${GX}${evalCompact(p)}`,
    `<button type="button" class="link end" id="evDetail" aria-label="查看评测数据详情">详情</button>`, "eval");
}
/* 换窗口 / 换模型 / 年份下钻都只重画这一张卡：图、图例（含返回按钮）、三个数、折叠态。 */
function repaintEvalCard(bento, p) {
  const chart = $("#evChart", bento);
  if (chart) chart.innerHTML = evalChart(p);
  const legend = $("#evLegend", bento);
  if (legend) legend.innerHTML = evalLegend();
  const box = $("#evStats", bento);
  if (box) {
    box.innerHTML = evalStats(p);
    runCounters(box);
  }
  const compact = $('[data-card="eval"] > .compact', bento);
  if (compact) compact.outerHTML = evalCompact(p);
}
function evalCompact(p) {
  const w = evalWindow(p);
  const days = evalBuckets(w.days).slice(-12);
  // The folded card keeps the day chart it had open, scaled into whatever height the versions leave.
  const cols = miniCols(days.map((x) => ({ done: x.traces || 0, all: Math.max(x.inTraces || 0, x.traces || 0) })));
  const ends = days.length > 1 ? [days[0], days[days.length - 1]] : days;
  const foot = days.length ? `<div class="cx-days">${cols}<span>${ends.map((x) => `<small>${esc(x.label)}</small>`).join("")}</span></div>` : "";
  // Per version over the same window: done / inputs, the bar is the version's completion.
  const inWindow = new Set(w.days.map((x) => x.d));
  const by = new Map();
  evalRows(p)
    .filter((r) => inWindow.has(r.d) && (EV.model === "all" || modelFamily(r.m) === EV.model))
    .forEach((r) => {
      const family = modelFamily(r.m);
      if (!family) return;
      const x = by.get(family) || { m: family, inputs: 0, done: 0 };
      x.inputs += r.input_traces ?? r.inputs ?? 0;
      x.done += r.traces ?? r.evaluated ?? 0;
      by.set(family, x);
    });
  const rank = [...by.values()]
    .sort((a, b) => b.done - a.done || b.inputs - a.inputs)
    .slice(0, 8)
    .map((x) => ({ name: x.m === "all" ? "全部" : modelName(p, x.m), value: `${compact(x.done)}<span class="stat-of"> / ${compact(x.inputs)}</span>`, share: x.inputs ? x.done / x.inputs : 0 }));
  // 图和展开态一样按窗口/模型走；底部三个数也跟 ev-range 同一口径。
  const t = evalTotals(p);
  const ratio = ([a, b]) => `${compact(a)}${b == null ? "" : `<span class="stat-of"> / ${compact(b)}</span>`}`;
  return miniView("", [
    [ratio(t.sessions), "完成 Session / 输入"],
    [pct(t.sessions[0], t.sessions[1], 1), "Session 完成率"],
    [ratio(t.traces), "完成 Trace / 输入"],
  ], "", rank, foot);
}

/* ---------------------------------------------------------------- 评测量详情: day → model → session */
const ED_PAGE = 30;
const ES_PAGE = 30;

function edDays(p) {
  const by = new Map();
  evalRows(p).forEach((r) => {
    const x = by.get(r.d) || { d: r.d, inputs: 0, evaluated: 0, sessions: 0, traces: 0, tokens: 0 };
    x.inputs += r.inputs || 0;
    x.evaluated += r.evaluated || 0;
    x.sessions += r.sessions ?? r.evaluated ?? 0;
    x.traces += r.traces ?? r.evaluated ?? 0;
    x.tokens += r.tokens || 0;
    by.set(r.d, x);
  });
  return [...by.values()].sort((a, b) => b.d.localeCompare(a.d));
}

function edModels(p, day) {
  const by = new Map();
  evalRows(p)
    .filter((r) => r.d === day)
    .forEach((r) => {
      const key = p.unified ? `|${r.m}` : `${r.sp || ""}|${r.m}`;
      const x = by.get(key) || {
        key, label: groupName(p, { split: r.sp || "", model: r.m }),
        inputs: 0, evaluated: 0, sessions: 0, traces: 0, tokens: 0,
      };
      x.inputs += r.inputs || 0;
      x.evaluated += r.evaluated || 0;
      x.sessions += r.sessions ?? r.evaluated ?? 0;
      x.traces += r.traces ?? r.evaluated ?? 0;
      x.tokens += r.tokens || 0;
      by.set(key, x);
    });
  return [...by.values()].sort((a, b) => b.inputs - a.inputs || b.evaluated - a.evaluated || a.label.localeCompare(b.label));
}

/* 完成度圆环：一圈轨道 + 一段进度弧 + 中心百分比，替代原来的进度条和「完成率」列。
   某天 / 某个模型的数据拉齐了没有，扫一眼这一列就够了；100% 变绿，空数据是灰环。 */
const edRing = (r) => {
  const inputs = r.inputs || 0;
  const done = Math.min(r.evaluated || 0, inputs);
  const p = inputs ? Math.round((100 * done) / inputs) : null;
  const R = 16;
  const C = 2 * Math.PI * R;
  const off = p == null ? C : C * (1 - Math.min(100, Math.max(0, p)) / 100);
  const title = inputs ? `已评测 ${fmt(done)} / ${fmt(inputs)} · ${p}%` : "暂无评测输入";
  return `<td class="ring"><span class="ed-ring${p === 100 ? " is-full" : ""}" title="${esc(title)}">
    <svg viewBox="0 0 40 40" aria-hidden="true">
      <circle class="ring-track" cx="20" cy="20" r="${R}"/>
      ${p == null ? "" : `<circle class="ring-fill" cx="20" cy="20" r="${R}" style="stroke-dasharray:${C.toFixed(2)};stroke-dashoffset:${off.toFixed(2)}"/>`}
    </svg>
    <b>${p == null ? "—" : `${p}<small>%</small>`}</b>
  </span></td>`;
};
function evalDetailState(p, raw) {
  const days = edDays(p);
  const day = days.some((x) => x.d === raw.ed) ? raw.ed : "";
  const models = day ? edModels(p, day) : [];
  const model = models.some((x) => x.key === raw.em) ? raw.em : "";
  return { days, day, models, model, ep: raw.ep, edp: raw.edp };
}

/* 固定列宽，数字列右对齐、圆环居中；表头与单元格用同一套 colgroup，所以上下一定对齐。 */
const edTable = (cols, head, rows, cls = "") =>
  `<div class="md-table ed-table${cls ? ` ${cls}` : ""}"><table>
    <colgroup>${cols.map((w) => `<col${w === "auto" ? "" : ` style="width:${w}"`}>`).join("")}</colgroup>
    <thead><tr>${head}</tr></thead><tbody>${rows.join("")}</tbody></table></div>`;

function edPager(page, pages, total, unit, kind) {
  if (pages <= 1) return "";
  const btn = (to, label, off) => `<button type="button" data-${kind}="${to}"${off ? " disabled" : ""}>${label}</button>`;
  return `<div class="pager">${btn(1, "«", page === 1)}${btn(page - 1, "上一页", page === 1)}
    <span class="pager-info">第 <b class="num">${page}</b> / ${pages} 页 · ${fmt(total)} ${unit}</span>
    ${btn(page + 1, "下一页", page === pages)}${btn(pages, "»", page === pages)}</div>`;
}

function evalDetailPage(p, state) {
  const { days, day, models, model } = state;
  const dPages = Math.max(1, Math.ceil(days.length / ED_PAGE));
  const dpage = Math.min(Math.max(1, state.edp), dPages);

  // One obvious way out of each level: model → day → date list → dashboard.
  const backLabel = model ? `← ${esc(day)}` : day ? "← 全部日期" : "← 返回数据看板";

  const num = (v, d = 0) => `<td class="num${v ? "" : " is-zero"}">${fmt(v, d)}</td>`;
  const nums = (r) => `${num(r.inputs)}${num(r.evaluated)}${num(r.sessions)}${num(r.traces)}`;
  const NUM_HEAD = `<th class="num">评测输入</th><th class="num">评测输出</th><th class="num">Session</th><th class="num">Trace</th>`;
  const NUM_COLS = ["19.5%", "19.5%", "19.5%", "19.5%"];
  const row = (r, i, first) =>
    `<tr style="--i:${Math.min(i, 30)}"><td class="first">${first}</td>${edRing(r)}${nums(r)}</tr>`;

  let body = "";
  let pager = "";
  if (!days.length) {
    body = `<div class="empty">暂无评测日期</div>`;
  } else if (!day) {
    const rows = days.slice((dpage - 1) * ED_PAGE, dpage * ED_PAGE).map((r, i) =>
      row(r, i, `<button type="button" class="link" data-eday="${esc(r.d)}">${esc(r.d)}</button>`));
    body = edTable(["150px", "8%", ...NUM_COLS], `<th class="first">日期</th><th class="ring">进度</th>${NUM_HEAD}`, rows, "is-day");
    pager = edPager(dpage, dPages, days.length, "天", "edp");
  } else if (!model) {
    const rows = models.map((r, i) =>
      row(r, i, `<button type="button" class="link" data-emodel="${esc(r.key)}" title="${esc(r.label)}">${esc(r.label)}</button>`));
    body = edTable(["150px", "8%", ...NUM_COLS], `<th class="first">模型</th><th class="ring">进度</th>${NUM_HEAD}`, rows, "is-model");
  } else {
    // 第三级看的是「这一天的评测输入对不对」，输入清单按天现读（server 的 /inputs.json），
    // 评测输出只作为行尾的状态位，不再决定哪些会话能出现。
    body = `<div class="ed-inputs" id="edInputs"><div class="empty">正在读取评测输入…</div></div>`;
  }

  return `<div class="bento"><article class="card card-detail" style="--span:12">
    <header class="card-head"><h2>评测数据详情</h2>
      <button type="button" class="link ed-back" id="edBack">${backLabel}</button></header>
    ${body}${pager}
  </article></div>`;
}

/* ---------------------------------------------------------------- 评测详情: 第三级 = 当天的评测输入 */

/* 这一级回答的是「当天的输入对不对」：输入清单由 server 按天现读（/inputs.json），
   评测输出只在行尾做状态位（✓ 有 / — 无），不再决定哪些会话能出现。 */
const splitOfModel = (key) => {
  const [sp, m] = String(key || "").split("|");
  return { split: sp || "daily", model: m || String(key || "") };
};

let inputAll = [];      // 当前分组的全部输入行（未过滤）
let inputView = null;   // { day, model, split, ep }
const inputSeq = { n: 0 };
// 筛选条件：问句 / Trace ID / Session ID 文本 + 类别 + 评测量状态 + 问题分布
const inputF = { q: "", cat: "", state: "", dist: "" };
const emptyFilter = () => Object.assign(inputF, { q: "", cat: "", state: "", dist: "" });

const inputHit = (r) => {
  if (inputF.q) {
    const q = inputF.q.toLowerCase();
    if (![r.q, r.sid, r.tid].some((v) => String(v || "").toLowerCase().includes(q))) return false;
  }
  if (inputF.cat && (r.cat || "") !== inputF.cat) return false;
  if (inputF.state === "yes" && !r.ev) return false;
  if (inputF.state === "no" && r.ev) return false;
  if (inputF.dist) {
    if (!r.ev) return false;
    const sv = Array.isArray(r.sv) ? r.sv : null;
    if (inputF.dist === "none") return !sv || !sv.some((n) => n > 0);
    const i = WORST.indexOf(inputF.dist);
    return !!sv && i >= 0 && Number(sv[i] || 0) > 0;
  }
  return true;
};

/* P0–P4 分布：只画有的档位（P0 3 · P2 5），零值不占位，读起来比五个 0 干净。 */
const sevDist = (sv) => {
  if (!Array.isArray(sv)) return `<span class="ed-dist-none">—</span>`;
  const total = sv.reduce((n, v) => n + (v || 0), 0);
  if (!total) return `<span class="ed-dist-none">无问题</span>`;
  return sv.map((n, i) => (n
    ? `<span class="ed-sev" style="--c:${sevColor(i)}" title="${SEV_NAME[WORST[i]]}：${n} 个问题"><i></i>${WORST[i]}<b>${fmt(n)}</b></span>`
    : "")).join("");
};

const ED_INPUT_COLS = '<colgroup><col><col style="width:116px"><col style="width:52px"><col style="width:224px"><col style="width:56px"><col style="width:72px"></colgroup>';

function renderInputTable() {
  if (!inputView) return;
  const table = $("#edTable");
  const note = $("#edNote");
  const pager = $("#edPager");
  if (!table) return;
  const rows = inputAll.filter(inputHit);
  const covered = inputAll.reduce((n, r) => n + (r.ev ? 1 : 0), 0);
  if (note) {
    const filtering = inputF.q || inputF.cat || inputF.state || inputF.dist;
    note.innerHTML = `输入 <b class="num">${fmt(inputAll.length)}</b> · 已输出 <b class="num">${fmt(covered)}</b>`
      + (filtering ? ` · 命中 <b class="num">${fmt(rows.length)}</b>` : "");
  }
  if (!rows.length) {
    table.innerHTML = `<div class="empty">${inputAll.length ? "没有匹配的输入。" : "该分组当天没有评测输入。"}</div>`;
    if (pager) pager.innerHTML = "";
    return;
  }
  const pages = Math.max(1, Math.ceil(rows.length / ES_PAGE));
  const page = Math.min(Math.max(1, inputView.ep || 1), pages);
  inputView.ep = page;
  const body = rows.slice((page - 1) * ES_PAGE, page * ES_PAGE).map((r, i) => `<tr class="ed-session" style="--i:${Math.min(i, 30)}"
      data-ref="${esc(r.r)}" data-d="${esc(inputView.day)}" data-m="${esc(inputView.model)}" data-sp="${esc(inputView.split)}"${r.s ? ` data-slug="${esc(r.s)}"` : ""}>
      <td class="first"><span class="ed-q">${esc(r.q || "（无提问）")}</span></td>
      <td class="cat"><span class="ed-cat" title="${esc(r.cat || "")}">${esc(r.cat || "—")}</span></td>
      <td class="num">${fmt(r.tr)}</td>
      <td class="dist">${r.ev ? sevDist(r.sv) : `<span class="ed-dist-none">—</span>`}</td>
      <td class="out">${r.ev ? `<span class="ed-out is-yes" title="已有评测输出">✓</span>` : `<span class="ed-out" title="尚无评测输出">—</span>`}</td>
      <td class="act"><button type="button" class="ed-open">查看</button></td>
    </tr>`).join("");
  table.innerHTML = `<div class="md-table ed-table is-session"><table>${ED_INPUT_COLS}
      <thead><tr><th class="first">样本</th><th class="cat">类别</th><th class="num">轮</th><th class="dist">问题分布 P0–P4</th><th class="out">输出</th><th class="act">操作</th></tr></thead>
      <tbody>${body}</tbody></table></div>`;
  if (pager) pager.innerHTML = edPager(page, pages, rows.length, "条输入", "edpg");
}

async function fillEvalInputs(root, state) {
  const host = $("#edInputs", root);
  if (!host) return;
  const seq = ++inputSeq.n;
  const { split, model } = splitOfModel(state.model);
  inputAll = [];
  emptyFilter();
  inputView = { day: state.day, model, split, ep: state.ep };
  host.innerHTML = `<div class="ed-tools">
      <div class="ed-search-row">
        <input class="ed-search" id="edSearch" type="search" placeholder="搜索 Trace ID / Session ID / 问句" autocomplete="off" aria-label="搜索评测输入">
        <select class="ed-filter" id="edCat" aria-label="按类别筛选"><option value="">全部类别</option></select>
        <select class="ed-filter" id="edState" aria-label="按评测状态筛选">
          <option value="">全部状态</option><option value="yes">有评测输出</option><option value="no">无评测输出</option>
        </select>
        <select class="ed-filter" id="edDist" aria-label="按问题分布筛选">
          <option value="">全部分布</option><option value="P0">含 P0</option><option value="P1">含 P1</option>
          <option value="P2">含 P2</option><option value="P3">含 P3</option><option value="P4">含 P4</option><option value="none">无问题</option>
        </select>
      </div>
      <div class="ed-input-note" id="edNote"></div>
    </div>
    <div id="edTable"><div class="empty">正在读取评测输入…</div></div>
    <div id="edPager"></div>`;
  const q = `product=${encodeURIComponent(ctx.product)}&d=${encodeURIComponent(state.day)}&m=${encodeURIComponent(model)}&sp=${encodeURIComponent(split)}`;
  let rows;
  try {
    const res = await fetch(`inputs.json?${q}`, { cache: "no-cache" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    rows = (await res.json()).rows || [];
  } catch (err) {
    if (seq === inputSeq.n) $("#edTable").innerHTML = `<div class="empty">评测输入读取失败：${esc(err.message)}</div>`;
    return;
  }
  if (seq !== inputSeq.n || !host.isConnected) return;
  inputAll = rows;
  const cats = new Map();
  rows.forEach((r) => {
    const c = r.cat || "";
    if (c) cats.set(c, (cats.get(c) || 0) + 1);
  });
  const catOpts = [...cats.entries()].sort((a, b) => b[1] - a[1])
    .map(([c, n]) => `<option value="${esc(c)}">${esc(c)}（${fmt(n)}）</option>`).join("");
  const catSel = $("#edCat", host);
  if (catSel) catSel.insertAdjacentHTML("beforeend", catOpts);
  renderInputTable();
}

/* ---------------------------------------------------------------- 评测详情: 输入详情弹窗 */

let edModal = null;

function ensureModal() {
  if (edModal && edModal.isConnected) return edModal;
  edModal = document.createElement("div");
  edModal.className = "ed-modal";
  edModal.hidden = true;
  edModal.innerHTML = `<div class="ed-modal-mask" data-close></div>
    <div class="ed-modal-card" role="dialog" aria-modal="true" aria-label="评测输入详情">
      <header class="ed-modal-head">
        <div class="ed-modal-main"><h3 class="ed-modal-title" id="edModalTitle"></h3>
          <div class="ed-modal-meta" id="edModalMeta"></div></div>
        <button type="button" class="ed-modal-x" data-close aria-label="关闭">✕</button>
      </header>
      <div class="ed-modal-body" id="edModalBody"></div>
    </div>`;
  document.body.appendChild(edModal);
  edModal.addEventListener("click", (e) => {
    if (e.target.closest("[data-close]")) {
      closeModal();
      return;
    }
    const roundHead = e.target.closest(".ed-round-head");
    if (roundHead) {
      const open = roundHead.closest(".ed-round").classList.toggle("is-open");
      roundHead.setAttribute("aria-expanded", String(open));
      return;
    }
    const chainHead = e.target.closest(".ed-chain-head");
    if (chainHead) {
      const open = chainHead.closest(".ed-chain").classList.toggle("is-open");
      chainHead.setAttribute("aria-expanded", String(open));
      return;
    }
    const stepHead = e.target.closest(".ed-step-head");
    if (stepHead) {
      const open = stepHead.closest(".ed-step").classList.toggle("is-open");
      stepHead.setAttribute("aria-expanded", String(open));
      return;
    }
    const copy = e.target.closest("[data-copy]");
    if (copy) {
      const text = copy.dataset.copy;
      (navigator.clipboard?.writeText(text) || Promise.reject()).then(() => {
        copy.classList.add("is-done");
        setTimeout(() => copy.classList.remove("is-done"), 1200);
      }).catch(() => {});
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && edModal && !edModal.hidden) closeModal();
  });
  return edModal;
}

function closeModal() {
  if (!edModal || edModal.hidden) return;
  edModal.hidden = true;
  document.body.classList.remove("is-modal");
}

function modalMeta(row, D) {
  const bits = [];
  if (row.cat || D?.meta?.skill || D?.meta?.task) bits.push(esc(row.cat || D.meta.skill || D.meta.task));
  if (row.d || D?.date) bits.push(esc(row.d || D.date));
  if (row.m || D?.model) bits.push(esc(row.m || D.model));
  bits.push(`第 ${fmt(row.tr || (D?.input?.traces || []).length || 1)} 轮`);
  bits.push(row.ev ? `<b class="ok">已有评测输出</b>` : `尚无评测输出`);
  const sid = row.sid || D?.ids?.session;
  const tid = row.tid || D?.ids?.trace;
  return `<span>${bits.join(" · ")}</span>${sid ? `<button type="button" class="ed-id" data-copy="${esc(sid)}" title="复制 Session ID">Session ${esc(String(sid).slice(0, 8))}…</button>` : ""}${tid ? `<button type="button" class="ed-id" data-copy="${esc(tid)}" title="复制 Trace ID">Trace ${esc(String(tid).slice(0, 8))}…</button>` : ""}`;
}

async function openInputModal(btn) {
  const tr = btn.closest("tr");
  if (!tr) return;
  const slug = tr.dataset.slug || "";
  const row = inputAll.find((r) => r.r === tr.dataset.ref) || {};
  const modal = ensureModal();
  $("#edModalTitle").textContent = row.q || "（无提问）";
  $("#edModalMeta").innerHTML = modalMeta(row, null);
  $("#edModalBody").innerHTML = `<div class="ed-expand-loading">正在加载…</div>`;
  modal.hidden = false;
  document.body.classList.add("is-modal");
  try {
    const D = slug ? await loadSample(slug) : await loadInput(tr);
    if (modal.hidden) return;
    $("#edModalTitle").textContent = D.question || D.question_zh || row.q || "（无提问）";
    $("#edModalMeta").innerHTML = modalMeta(row, D);
    $("#edModalBody").innerHTML = renderModalBody(D);
    bindTips($("#edModalBody"));
  } catch (err) {
    $("#edModalBody").innerHTML = `<div class="ed-expand-error">加载失败：${esc(err.message)}</div>`;
  }
}

function wireEvalDetail(root, state) {
  const card = $(".card", root) || root;

  card.addEventListener("click", (e) => {
    const open = e.target.closest(".ed-open");
    if (open) {
      e.preventDefault();
      openInputModal(open);
      return;
    }
    const back = e.target.closest("#edBack");
    if (back) {
      if (state.model) ctx.navigate({ detail: "eval", ed: state.day, em: null, ep: null });
      else if (state.day) ctx.navigate({ detail: "eval", ed: null, ep: null });
      else ctx.navigate({ detail: null, ed: null, em: null, ep: null, edp: null });
      return;
    }
    const day = e.target.closest("[data-eday]");
    if (day) {
      ctx.navigate({ detail: "eval", ed: day.dataset.eday, em: null, ep: null });
      return;
    }
    const model = e.target.closest("[data-emodel]");
    if (model) {
      ctx.navigate({ detail: "eval", ed: state.day, em: model.dataset.emodel, ep: null });
      return;
    }
    const dpage = e.target.closest("[data-edp]");
    if (dpage) {
      ctx.navigate({ detail: "eval", edp: Number(dpage.dataset.edp), ep: null });
      return;
    }
    const spage = e.target.closest("[data-edpg]");
    if (spage) {
      inputView.ep = Number(spage.dataset.edpg);
      renderInputTable();
    }
  });

  card.addEventListener("input", (e) => {
    if (e.target.id !== "edSearch") return;
    inputF.q = e.target.value.trim();
    if (inputView) inputView.ep = 1;
    renderInputTable();
  });

  card.addEventListener("change", (e) => {
    const id = e.target.id;
    if (id !== "edCat" && id !== "edState" && id !== "edDist") return;
    inputF[id === "edCat" ? "cat" : id === "edState" ? "state" : "dist"] = e.target.value;
    if (inputView) inputView.ep = 1;
    renderInputTable();
  });
}

/* ---------------------------------------------------------------- 评测详情: 输入详情（弹窗内容） */

const inputCache = new Map();
const loadInput = (tr) => {
  const q = new URLSearchParams({ product: ctx.product, d: tr.dataset.d, m: tr.dataset.m, sp: tr.dataset.sp });
  const url = `inputs/${encodeURIComponent(tr.dataset.ref)}.json?${q}`;
  if (!inputCache.has(url)) {
    const p = fetch(url).then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    }).catch((err) => {
      inputCache.delete(url);
      throw err;
    });
    inputCache.set(url, p);
  }
  return inputCache.get(url);
};

const sampleCache = new Map();
const loadSample = (slug) => {
  if (!sampleCache.has(slug)) {
    const p = fetch(`samples/${encodeURIComponent(slug)}.json`).then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    }).catch((err) => {
      sampleCache.delete(slug);
      throw err;
    });
    sampleCache.set(slug, p);
  }
  return sampleCache.get(slug);
};

const blockText = (b) => (b.x || []).map((x) => (typeof x === "string" ? x : "\u2026")).join("");

function blocksHTML(m) {
  return (m.blocks || []).map((b) => {
    const text = blockText(b);
    if (!text.trim()) return "";
    return `<div class="ed-block">${renderContent(text, b.f)}</div>`;
  }).join("");
}

const stepName = (m) => {
  const call = (m.blocks || []).map((b) => b.l).find((x) => x && x.startsWith("call:"));
  return m.name || (call ? call.slice(5) : "");
};

const durText = (ms) => (ms == null ? "" : ms >= 1000 ? `${fmt(ms / 1000, 1)} s` : `${Math.round(ms)} ms`);

/* 一行一条链路步骤：箭头 / 角色 / 工具名 / 耗时四列对齐，正文缩进和工具名同一条竖线。 */
function stepHTML(m) {
  const label = KIND[m.k] || m.k;
  const name = stepName(m);
  const body = blocksHTML(m);
  return `<div class="ed-step">
    <button type="button" class="ed-step-head" aria-expanded="false">
      <span class="ed-caret" aria-hidden="true"></span>
      <span class="ed-step-role">${esc(label)}</span>
      <span class="ed-step-name">${name ? esc(name) : ""}</span>
      <span class="ed-step-dur">${durText(m.dur)}</span>
    </button>
    ${body ? `<div class="ed-step-body">${body}</div>` : ""}
  </div>`;
}

function mainMsgHTML(m, cls) {
  return `<div class="ed-msg ${cls}">
    <div class="ed-msg-head"><span class="ed-role">${esc(KIND[m.k] || m.k)}</span></div>
    <div class="ed-msg-body">${blocksHTML(m)}</div>
  </div>`;
}

/* 中间链路：不再用方框包住，就是一行可折叠的步骤汇总，展开后每条步骤各自再折。 */
function chainHTML(msgs, chainMs) {
  const dur = chainMs ? `<span class="ed-chain-dur">${fmt(chainMs / 1000, 1)} s</span>` : "";
  return `<div class="ed-chain">
    <button type="button" class="ed-chain-head" aria-expanded="false">
      <span class="ed-caret" aria-hidden="true"></span>
      <span class="ed-chain-label">中间链路</span>
      <span class="ed-chain-count">${msgs.length} 步</span>
      ${dur}
    </button>
    <div class="ed-chain-body">${msgs.map(stepHTML).join("")}</div>
  </div>`;
}

/* 一轮 = 用户问题 → 中间链路 → 回答；多轮时按轮折叠，默认只展开第一轮。 */
function roundParts(trace) {
  const parts = [];
  let chain = [];
  let chainMs = 0;
  const flush = () => {
    if (!chain.length) return;
    parts.push(chainHTML(chain, chainMs));
    chain = [];
    chainMs = 0;
  };
  (trace.messages || []).forEach((m) => {
    if (m.k === "user") {
      flush();
      parts.push(mainMsgHTML(m, "is-q"));
    } else if (m.k === "answer") {
      flush();
      parts.push(mainMsgHTML(m, "is-a"));
    } else {
      chainMs += m.dur || 0;
      chain.push(m);
    }
  });
  flush();
  return parts.join("");
}

function roundStats(trace) {
  const msgs = trace.messages || [];
  let steps = 0;
  let ms = 0;
  msgs.forEach((m) => {
    if (m.k === "user" || m.k === "answer") return;
    steps += 1;
    ms += m.dur || 0;
  });
  return { steps, ms };
}

function roundSection(trace, i, total) {
  const open = total === 1 || i === 0;
  const { steps, ms } = roundStats(trace);
  const meta = [steps ? `${steps} 步` : "", ms ? fmt(ms / 1000, 1) + " s" : ""].filter(Boolean).join(" · ");
  const head = total > 1
    ? `<button type="button" class="ed-round-head" aria-expanded="${open}">
        <span class="ed-caret" aria-hidden="true"></span>
        <span class="ed-round-label">第 ${i + 1} 轮</span>
        <span class="ed-round-meta">${meta}</span>
      </button>`
    : "";
  return `<section class="ed-round${open ? " is-open" : ""}">${head}
    <div class="ed-round-body">${roundParts(trace)}</div>
  </section>`;
}

function renderModalBody(D) {
  const traces = (D.input && D.input.traces) || [];
  if (!traces.length) return `<div class="ed-expand-empty">该样本没有评测输入</div>`;
  return `<div class="ed-rounds">${traces.map((t, i) => roundSection(t, i, traces.length)).join("")}</div>`;
}

/* ---------------------------------------------------------------- 归因体系: version → component role */
function spread(ys, min, H) {
  const o = ys.map((y) => Math.max(min / 2, y));
  for (let i = 1; i < o.length; i++) o[i] = Math.max(o[i], o[i - 1] + min);
  for (let i = o.length - 1; i >= 0; i--) o[i] = Math.min(o[i], i === o.length - 1 ? H - min / 2 : o[i + 1] - min);
  return o;
}

/* Two-column sankey shared by 归因体系 and 预测归因. `left` = versions ({key, name, n, c}),
   `right` = categories ({key, name, n}), `value(l, r)` = the flow between them. The drawing is
   tall enough for one label line per node, flows keep both columns' order (no crossings inside a
   node), the largest category carries the emphasis, and flows sweep in from the left. */
function sankeySVG(left, right, value, { W = 440, H = 212, x0 = 130, x1 = 340, id = "sk", cls = "" } = {}) {
  const LINE = 18;
  const gap = 6;
  const h = Math.max(H, Math.max(left.length, right.length) * LINE);
  const lt = sum(left.map((x) => x.n)) || 1;
  const rt = sum(right.map((x) => x.n)) || 1;
  const kL = (h - gap * (left.length - 1)) / lt;
  const kR = (h - gap * (right.length - 1)) / rt;
  const xm = (x0 + x1) / 2;
  let y = 0;
  const L = left.map((x) => {
    const o = { x, y, h: x.n * kL, off: 0 };
    y += o.h + gap;
    return o;
  });
  y = 0;
  const R = right.map((x) => {
    const o = { x, y, h: x.n * kR, off: 0 };
    y += o.h + gap;
    return o;
  });
  let flows = "";
  let d = 0;
  L.forEach((l, li) =>
    R.forEach((r) => {
      const n = value(l.x, r.x);
      if (!n) return;
      const a0 = l.y + l.off, a1 = a0 + n * kL, b0 = r.y + r.off, b1 = b0 + n * kR;
      l.off += n * kL;
      r.off += n * kR;
      const tip = `${l.x.name} → ${r.x.name}|${fmt(n)} · 占 ${l.x.name} ${pct(n, l.x.n, 1)}`;
      flows += `<path class="sk-f" style="--d:${d++}" d="M${x0} ${a0}C${xm} ${a0} ${xm} ${b0} ${x1} ${b0}L${x1} ${b1}C${xm} ${b1} ${xm} ${a1} ${x0} ${a1}Z" fill="url(#${id}g${li})" data-g="${esc(l.x.key)}" data-r="${esc(r.x.key)}" data-tip="${esc(tip)}"/>`;
    }),
  );
  const ly = spread(L.map((o) => o.y + o.h / 2), LINE, h);
  const ry = spread(R.map((o) => o.y + o.h / 2), LINE, h);
  const top = R.reduce((a, b) => (!a || b.x.n > a.x.n ? b : a), null);
  const defs = L.map(
    (l, i) => `<linearGradient id="${id}g${i}" gradientUnits="userSpaceOnUse" x1="${x0}" x2="${x1}" y1="0" y2="0"><stop offset="0" style="stop-color:${l.x.c};stop-opacity:.58"/><stop offset="1" style="stop-color:${l.x.c};stop-opacity:.16"/></linearGradient>`,
  ).join("") + `<clipPath id="${id}clip"><rect class="sk-reveal" x="0" y="-8" width="${W}" height="${h + 16}"/></clipPath>`;
  const lnode = L.map(
    (l, i) => `<g class="sk-node" data-g="${esc(l.x.key)}"><rect x="${x0 - 5}" y="${l.y}" width="5" height="${Math.max(1, l.h)}" rx="2" style="fill:${l.x.c}"/>
      <text x="${x0 - 12}" y="${ly[i]}" text-anchor="end" class="sk-t">${esc(l.x.name)}<tspan class="sk-n" dx="6">${fmt(l.x.n)}</tspan></text></g>`,
  ).join("");
  const rnode = R.map(
    (r, i) => `<g class="sk-node${r === top ? " is-top" : ""}" data-r="${esc(r.x.key)}"><rect x="${x1}" y="${r.y}" width="5" height="${Math.max(1, r.h)}" rx="2"/>
      <text x="${x1 + 12}" y="${ry[i]}" class="sk-t">${esc(r.x.name)}<tspan class="sk-n" dx="6">${fmt(r.x.n)}</tspan><tspan class="sk-p" dx="5">${pct(r.x.n, rt)}</tspan></text></g>`,
  ).join("");
  return `<svg class="sankey${cls ? ` ${cls}` : ""}" viewBox="0 0 ${W} ${h}"><defs>${defs}</defs><g clip-path="url(#${id}clip)">${flows}</g>${lnode}${rnode}</svg>`;
}

function attrCard(p) {
  const left = p.field
    .map((g, i) => ({ key: String(i), name: groupName(p, g), roles: g.roles || {}, c: shade(i, p.field.length) }))
    .map((g) => ({ ...g, n: sum(Object.values(g.roles)) }))
    .filter((g) => g.n);
  const right = p.roles.filter((r) => r.problems).map((r) => ({ key: r.id, name: r.label, n: r.problems }));
  const top = right.reduce((a, b) => (!a || b.n > a.n ? b : a), null);
  const sevParts = WORST.map((w, i) => ({ n: p.severity[w] || 0, c: sevColor(i) }));
  return card(4, "归因体系", `<div class="hero"><b class="big">${counter(p.kpi.problems)}</b><small>个问题</small></div>
    ${sankeySVG(left, right, (l, r) => l.roles[r.key] || 0, { id: "ska", x0: 128, x1: 322 })}${GX}${miniView(miniStrip(sevParts), [
      [counter(p.kpi.problems), "问题"], top ? [pct(top.n, p.kpi.problems), `${top.name}占比`] : null,
    ], "", [...right].sort((a, b) => b.n - a.n).slice(0, 6).map((r, i) => ({ name: r.name, value: fmt(r.n), share: r.n / (sum(right.map((x) => x.n)) || 1), c: leadTone(i) })))}`, "", "attr");
}

/* ---------------------------------------------------------------- 聚类体系: phase → stage → mechanism → pattern */
function clusterCard(p, tax) {
  if (!tax) return card(4, "聚类体系", `<div class="empty">缺少聚类体系文件</div>`);
  const note = p.kpi.unclustered
    ? `<span class="sb-key is-note" title="没归到任何问题类型的问题：算进问题总数，但不出现在矩阵里"><i></i>未聚类 ${fmt(p.kpi.unclustered)}</span>`
    : "";
  const phases = (cluTree(p, tax).children || []).filter((c) => c.n > 0).sort((a, b) => b.n - a.n);
  const phaseTotal = sum(phases.map((c) => c.n)) || 1;
  return card(4, "聚类体系", `<div class="duo sm" id="clu"></div>
    <div class="sb-keys"><span class="sb-key" title="外圈细环是这一类里 P0、P1 问题的占比；红字是 P0、P1 问题的个数"><i></i>P0·P1</span>${note}</div>${GX}${miniView(miniRing([
      { n: p.kpi.clustered || 0, c: "var(--accent)" }, { n: p.kpi.unclustered || 0, c: "var(--t4)" },
    ]), [
      [counter(p.kpi.problems), "问题"], [pct(p.kpi.clustered, p.kpi.problems), "已聚类"],
    ], "", phases.slice(0, 6).map((c, i) => ({ name: c.name, value: fmt(c.n), share: c.n / phaseTotal, c: leadTone(i) })))}`, "", "clu");
}

const sevPair = (s) => [(s && s.P0) || 0, (s && s.P1) || 0];
const addPair = (a, b) => [a[0] + b[0], a[1] + b[1]];
const toSev = (pair) => ({ P0: pair[0], P1: pair[1] });

/* Patterns drill one level further than L3: a four-part path such as S9.M5.4.4 is a
   child of S9.M5.4. patName() resolves it to the nearest node that still exists in the
   current tree, so a retired L4 leaf shows its L3 name instead of a bare code. */
const patOrder = (a, b) => {
  const pa = a.split(".").map((x) => Number(x.replace(/\D/g, "")) || 0);
  const pb = b.split(".").map((x) => Number(x.replace(/\D/g, "")) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
};
function patIds(p) {
  const ids = new Set();
  (p.patterns || []).forEach((x) => {
    const parts = x.id.split(".");
    for (let i = 3; i <= parts.length; i += 1) ids.add(parts.slice(0, i).join("."));
  });
  return [...ids];
}
function cluPatterns(ids, depth, byId, tax) {
  return ids
    .filter((id) => id.split(".").length === depth)
    .sort(patOrder)
    .map((id) => {
      const children = cluPatterns(ids.filter((x) => x.startsWith(`${id}.`)), depth + 1, byId, tax);
      const own = byId.get(id) || {};
      const sev = children.reduce((a, c) => addPair(a, sevPair(c.sev)), sevPair(own.sev));
      return {
        id: `c/${id}`, name: patName(tax, id), n: (own.n || 0) + sum(children.map((c) => c.n)),
        sev: toSev(sev), children,
      };
    });
}

function cluTree(p, tax) {
  const cell = (s, m) => (p.matrix[s] || {})[m] || {};
  let clusteredSev = [0, 0];
  Object.values(p.matrix || {}).forEach((mechs) =>
    Object.values(mechs).forEach((c) => (clusteredSev = addPair(clusteredSev, sevPair(c.sev)))));
  const ids = patIds(p);
  const byId = new Map((p.patterns || []).map((x) => [x.id, x]));
  const phases = tax.phases.map((ph) => {
    let phaseSev = [0, 0];
    const stages = tax.stages
      .filter((s) => s.phase === ph.id)
      .map((s) => {
        let stageSev = [0, 0];
        const mechs = tax.mechanisms.map((m) => {
          const c = cell(s.id, m.id);
          const sev = sevPair(c.sev);
          stageSev = addPair(stageSev, sev);
          return {
            id: `c/${s.id}.${m.id}`, name: m.name, n: c.n || 0, sev: toSev(sev),
            children: cluPatterns(ids.filter((id) => id.startsWith(`${s.id}.${m.id}.`)), 3, byId, tax),
          };
        });
        phaseSev = addPair(phaseSev, stageSev);
        return { id: `c/${s.id}`, name: s.name, n: sum(mechs.map((m) => m.n)), sev: toSev(stageSev), children: mechs };
      });
    return { id: `c/${ph.id}`, name: ph.name, n: sum(stages.map((s) => s.n)), sev: toSev(phaseSev), children: stages };
  });
  if (p.kpi.unclustered) {
    const total = sevPair(p.severity);
    const rest = [Math.max(0, total[0] - clusteredSev[0]), Math.max(0, total[1] - clusteredSev[1])];
    phases.push({ id: "c/~un", name: "未聚类", n: p.kpi.unclustered, sev: toSev(rest), other: true });
  }
  return { id: "c", name: "全部", n: p.kpi.problems, sev: toSev(sevPair(p.severity)), children: phases };
}

/* ---------------------------------------------------------------- 预测体系 (docs/prediction-data.md) */
function when(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number") return v;
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return Date.parse(`${s}T23:59:59.999+08:00`);
  const t = /([zZ]|[+-]\d{2}:?\d{2})$/.test(s) ? Date.parse(s) : Date.parse(`${s.replace(" ", "T")}+08:00`);
  return Number.isFinite(t) ? t : null;
}
/* Batch dates the forecast export covers, as the header note: 10-23 or 10-01～10-27. */
function predCover(dates) {
  const ds = (dates || []).map((d) => String(d).slice(5, 10)).filter(Boolean);
  if (!ds.length) return "";
  return `覆盖 ${ds[0]}${ds.length > 1 ? `～${ds[ds.length - 1]}` : ""}`;
}

function predSankey(p, models, causes, flows) {
  const left = models
    .map((m, i) => ({ key: m, name: modelName(p, m), n: sum(causes.map((c) => (flows[m] || [])[c.i] || 0)), c: shade(i, models.length) }))
    .filter((x) => x.n);
  if (!left.length || !causes.length) return "";
  const right = causes.map((c) => ({ key: String(c.i), name: c.l, n: c.n, i: c.i }));
  return sankeySVG(left, right, (l, r) => (flows[l.key] || [])[r.i] || 0, { H: 176, x0: 96, x1: 330, id: "skp", cls: "pred-sk" });
}

const PRED_TABS = `<div class="seg pred-tabs" id="predTab"><span class="seg-knob" aria-hidden="true"></span>
      <button type="button" data-value="vol" aria-pressed="true">题量</button>
      <button type="button" data-value="acc">能力</button>
      <button type="button" data-value="cause">归因</button></div>`;

/* Folded forecast card: the accuracy history as one quiet line. */
function predSeries(pr) {
  return (pr.accuracy || [])
    .map((a) => ({ t: when(a.at) ?? 0, v: a.total > 0 ? (100 * (a.correct || 0)) / a.total : Number(a.accuracy) * 100 }))
    .filter((x) => Number.isFinite(x.v))
    .sort((a, b) => a.t - b.t)
    .slice(-12)
    .map((x) => x.v);
}

/* 标的类别 → 题型 over the verifiable questions (one count per question, however many versions answered it). */
const qkey = (it) => (it.i != null ? it.i : it.q);
function predTree(items) {
  const all = new Set();
  const byClass = new Map();
  items.forEach((it) => {
    const k = qkey(it);
    const cls = it.c || "其他";
    const typ = it.t || "其他";
    const node = byClass.get(cls) || { id: `p/${cls}`, name: cls, qs: new Set(), kids: new Map() };
    node.qs.add(k);
    if (!node.kids.has(typ)) node.kids.set(typ, new Set());
    node.kids.get(typ).add(k);
    byClass.set(cls, node);
    all.add(k);
  });
  return {
    id: "p", name: "全部", n: all.size,
    children: [...byClass.values()].sort((a, b) => b.qs.size - a.qs.size).map((c) => ({
      id: c.id, name: c.name, n: c.qs.size,
      children: [...c.kids].sort((a, b) => b[1].size - a[1].size).map(([name, qs]) => ({ id: `${c.id}/${name}`, name, n: qs.size, children: [] })),
    })),
  };
}

function predictCard(p) {
  const pr = p.prediction;
  if (!pr) {
    // No feed: the card rests in its folded state — one ghost line and one number, nothing to open.
    return card(4, "预测体系", miniView(`<span class="cxvoid" aria-hidden="true"></span>`, [["—", "预测题"]], "暂无预测数据"), "", "pred", "is-mini");
  }
  // The export's own bank (questions it scanned) when given, else this product's distinct questions.
  const allQ = Number.isFinite(pr.bank) ? pr.bank : new Set(p.field.flatMap((g) => g.cells.map((c) => c[3]))).size;
  const asOf = when(pr.as_of) ?? when(ctx.data.generated_at);
  const qs = Array.isArray(pr.questions) ? pr.questions : [];
  const open = qs.filter((q) => {
    const t = when(q.answer_at);
    return t != null && t <= asOf;
  }).length;
  const latest = {};
  (pr.accuracy || []).forEach((a) => {
    const t = when(a.at);
    if (t == null || t > asOf) return;
    if (!latest[a.model] || t > latest[a.model].t) latest[a.model] = { t, c: 0, n: 0, pct: null };
    const e = latest[a.model];
    if (e.t !== t) return;
    if (a.total > 0) {
      e.c += a.correct || 0;
      e.n += a.total;
    } else if (a.accuracy != null) e.pct = Number(a.accuracy);
  });
  const acc = Object.entries(latest).map(([m, e]) => ({ m, r: e.n ? (100 * e.c) / e.n : e.pct, c: e.c, n: e.n })).filter((x) => x.r != null);
  const pooledN = sum(acc.map((x) => x.n));
  const at = pr.attribution || {};
  const predModels = at.models && at.models.length ? at.models : Object.keys(at.flows || {});
  // `i` keeps the position in `errors`: flows are indexed by it, not by the filtered list.
  const causes = (at.errors || []).map((l, i) => ({ l, i, n: sum(predModels.map((m) => ((at.flows || {})[m] || [])[i] || 0)) })).filter((x) => x.n);
  const bar = (items) =>
    `<div class="comp">${items.map((x) => `<span style="flex:${x.n} 1 0;--c:${x.c}" data-tip="${esc(x.l)}|${fmt(x.n)}"></span>`).join("")}</div>
    <div class="keys">${items.map((x) => `<span>${dot(x.c)}${esc(x.l)}<b class="num">${fmt(x.n)}</b></span>`).join("")}</div>`;
  const right = sum(acc.map((x) => x.c));
  // 能力: accuracy by 标的类别 × version, from the judged answers (items), with the sample size per cell.
  const items = pr.items || [];
  const versions = (p.models || []).map((m) => m.id).filter((id) => items.some((it) => it.v === id));
  const grid = new Map();
  const tally = (cls, v, it) => {
    const e = grid.get(`${cls}|${v}`) || { ok: 0, bad: 0 };
    if (it.r === "correct") e.ok += 1;
    else if (it.r === "wrong") e.bad += 1;
    grid.set(`${cls}|${v}`, e);
  };
  const classes = new Map();
  items.forEach((it) => {
    const cls = it.c || "其他";
    classes.set(cls, (classes.get(cls) || 0) + (it.r === "correct" || it.r === "wrong" ? 1 : 0));
    tally(cls, it.v, it);
    tally("全部", it.v, it);
    tally(cls, "*", it);
    tally("全部", "*", it);
  });
  const classOrder = ["全部", ...[...classes].filter(([, n]) => n > 0).sort((x, y) => y[1] - x[1]).map(([c]) => c)];
  const MIN_N = 10;
  const cell = (cls, v) => {
    const e = grid.get(`${cls}|${v}`) || { ok: 0, bad: 0 };
    const n = e.ok + e.bad;
    if (!n) return `<span class="cap-c is-empty">—</span>`;
    const r = (100 * e.ok) / n;
    const tone = Math.round(14 + Math.max(0, Math.min(1, (r - 35) / 45)) * 62);
    return `<span class="cap-c${n < MIN_N ? " is-thin" : ""}" style="--t:${tone}%" data-cv="${esc(`${cls}|${v}`)}" data-tip="${esc(cls)} · ${esc(v === "*" ? "全部版本" : modelName(p, v))}|${fmt(e.ok)} / ${fmt(n)}${n < MIN_N ? " · 样本少" : ""}"><b class="num">${fmt(r, 0)}</b><small class="num">${fmt(n)}</small></span>`;
  };
  const capMatrix = classOrder.length > 1 && versions.length
    ? `<div class="cap-mx" style="--cols:${versions.length}">
        <span></span>${versions.map((v) => `<span class="cap-h" data-pm="${esc(v)}">${esc(modelName(p, v))}</span>`).join("")}<span class="cap-h">合计</span>
        ${classOrder.map((cls) => `<span class="cap-r${cls === "全部" ? " is-all" : ""}">${esc(cls)}</span>${versions.map((v) => cell(cls, v)).join("")}${cell(cls, "*")}`).join("")}
      </div><div class="cap-note">每道题由各版本分别作答。单元格：准确率 % 与回答数，浅色为不足 ${MIN_N} 份</div>`
    : `<div class="empty">暂无准确率</div>`;
  // 题量: 标的类别 → 题型 over the judged answers; opens the same star map as the other rings.
  const predRoot = predTree(items);
  const causeTotal = sum(causes.map((x) => x.n));
  // Forecast questions = revealed + pending (questions[]) + those the export could not verify yet.
  const unver = Number.isFinite(pr.unverifiable) ? pr.unverifiable : 0;
  const forecast = qs.length + unver;
  const panes = `<div class="pred-pane is-on" data-pane="vol">
      ${predRoot.n ? `<div class="duo" id="prd"></div>` : `<div class="empty">暂无预测数据</div>`}
      ${stats([["预测题", counter(forecast)], ["已揭晓", counter(open)], ["待揭晓", counter(qs.length - open)], ["不可核验", counter(unver)]])}
    </div>
    <div class="pred-pane" data-pane="acc">
      <div class="pred-top"><div class="hero"><b class="big num">${pooledN ? `${fmt((100 * right) / pooledN, 1)}%` : "—"}</b><small>准确率</small></div>
        <div class="hero"><b class="big num">${fmt(pooledN)}</b><small>已判定</small></div></div>
      ${capMatrix}
    </div>
    <div class="pred-pane" data-pane="cause">
      <div class="pred-top"><div class="hero"><b class="big">${counter(causeTotal)}</b><small>错误</small></div>
        <div class="hero"><b class="big num">${causes.length}</b><small>类别</small></div></div>
      ${causes.length ? predSankey(p, predModels, causes, at.flows || {}) : `<div class="empty">暂无预测归因</div>`}
    </div>`;
  const cover = predCover(pr.dates);
  const folded = miniView(miniLine(predSeries(pr)), [[counter(forecast), "预测题"], pooledN ? [`${fmt((100 * right) / pooledN, 1)}%`, "准确率"] : null], "",
    [...acc].sort((a, b) => b.r - a.r).slice(0, 6).map((x) => ({ name: modelName(p, x.m), value: `${fmt(x.r, 1)}%`, share: x.r / 100, c: "var(--accent)" })));
  return card(4, `预测体系${cover ? ` <span class="status">${esc(cover)}</span>` : ""}`, `<div class="pred-panes">${panes}</div>${GX}${folded}`, PRED_TABS, "pred");
}

/* ---------------------------------------------------------------- 聚类矩阵: 场景 × 问题聚类, two-axis drill in place */
const MX_HEAD = 10;
const MX_MIN = 12;
const byNum = (a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1));

function sceneTree(p) {
  const tasks = new Map();
  (p.cross || []).forEach(([task, sub, pats, tr]) => {
    const n = sum(pats.map((x) => x[1]));
    let t = tasks.get(task);
    if (!t) tasks.set(task, (t = { name: task, n: 0, traces: 0, subs: new Map() }));
    t.n += n;
    t.traces += Number(tr) || 0;
    if (sub) {
      let s = t.subs.get(sub);
      if (!s) t.subs.set(sub, (s = { name: sub, n: 0, traces: 0 }));
      s.n += n;
      s.traces += Number(tr) || 0;
    }
  });
  return [...tasks.values()]
    .sort((a, b) => b.n - a.n || a.name.localeCompare(b.name))
    .map((t) => {
      const subs = [...t.subs.values()].sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));
      return {
        name: t.name, task: t.name, n: t.n, traces: t.traces, tasks: [t.name],
        children: subs.length
          ? subs.map((s) => ({ name: s.name, task: t.name, sub: s.name, n: s.n, traces: s.traces, children: [] }))
          : [],
      };
    });
}

// Long task lists fold into a group that opens as its own table; the fold is display-only.
function capScenes(nodes) {
  if (nodes.length <= MX_MIN) return nodes;
  const rest = nodes.slice(MX_HEAD);
  return [
    ...nodes.slice(0, MX_HEAD),
    {
      name: "其他场景", group: true, n: sum(rest.map((x) => x.n)), traces: sum(rest.map((x) => x.traces)),
      tasks: rest.flatMap((x) => x.tasks || [x.task]), children: rest,
    },
  ];
}

const sceneMatches = (node, task, sub) =>
  node.group ? node.tasks.includes(task) : node.sub ? node.task === task && node.sub === sub : !node.task || node.task === task;

function patternTree(ids, depth, tax) {
  return ids
    .filter((id) => id.split(".").length === depth)
    .sort(patOrder)
    .map((id) => ({
      name: patName(tax, id), id, pat: id, prefix: id,
      children: patternTree(ids.filter((x) => x.startsWith(`${id}.`)), depth + 1, tax),
    }));
}

function clusterTree(p, tax) {
  const ids = patIds(p);
  const stages = [...tax.stages].sort(byNum).map((s) => {
    const mechs = tax.mechanisms.map((m) => {
      const children = patternTree(ids.filter((id) => id.startsWith(`${s.id}.${m.id}.`)), 3, tax);
      return children.length ? { name: m.name, id: m.id, prefix: `${s.id}.${m.id}`, children } : null;
    }).filter(Boolean);
    return mechs.length ? { name: s.name, id: s.id, prefix: s.id, children: mechs } : null;
  }).filter(Boolean);
  return { name: "全部", children: stages };
}

const clusterMatches = (node, pid) => !node.prefix || pid === node.prefix || pid.startsWith(`${node.prefix}.`);

function matrixView(p, rows, cols) {
  // 一格 = 命中该聚类的 Trace 数（同一条 Trace 命中同一列的多个叶子只算一次），
  // 分母 = 该场景全部已评测 Trace（含无问题），所以占比不会超过 100%。
  const cells = rows.map(() => cols.map(() => ({ n: 0, hits: 0, pats: new Map() })));
  const traces = rows.map(() => 0);
  (p.cross || []).forEach(([task, sub, pats, tr]) => {
    const ri = rows.findIndex((r) => sceneMatches(r, task, sub));
    if (ri < 0) return;
    traces[ri] += Number(tr) || 0;
    const hit = new Set();
    pats.forEach(([pid, n]) => {
      const ci = cols.findIndex((c) => clusterMatches(c, pid));
      if (ci < 0) return;
      const cell = cells[ri][ci];
      cell.n += n;
      cell.pats.set(pid, (cell.pats.get(pid) || 0) + n);
      if (!hit.has(ci)) {
        cell.hits += 1;
        hit.add(ci);
      }
    });
  });
  return { rows, cols, cells, traces };
}

function matrixTable(view) {
  const { rows, cols, cells, traces } = view;
  if (!rows.length || !cols.length) return `<div class="empty">暂无聚类数据</div>`;
  let maxHits = 1;
  const totals = rows.map((_, ri) => sum(cells[ri].map((x) => x.n)));
  const colHits = cols.map((_, ci) => sum(rows.map((_, ri) => cells[ri][ci].hits)));
  const colTotals = cols.map((_, ci) => sum(rows.map((_, ri) => cells[ri][ci].n)));
  const grand = sum(colTotals);
  const grandTraces = sum(traces) || 0;
  cells.forEach((row) => row.forEach((x) => (maxHits = Math.max(maxHits, x.hits))));
  // 格子主数字是命中 Trace 数，占比 = 命中 Trace ÷ 该场景全部已评测 Trace；
  // 问题条数只留在悬浮说明和「问题合计」列里。
  const cellData = (hits, den) => `<span class="cell-data"><span class="cell-main"><b>${fmt(hits)}</b></span><span class="cell-pct">${pct(hits, den, 1)}</span></span>`;
  const heads = cols
    .map((c, ci) => {
      const title = `${c.id ? `${c.id} · ` : ""}${c.name}`;
      const label = `<span class="mx-lab">${esc(c.name)}</span>`;
      return c.children.length
        ? `<button type="button" class="mh" data-col="${ci}" title="${esc(title)}" aria-label="下钻 ${esc(c.name)}">${label}<i class="mx-caret" aria-hidden="true"></i></button>`
        : `<span class="mh" title="${esc(title)}">${label}</span>`;
    })
    .join("");
  let rowLabels = "", gridCells = "", tots = "";
  rows.forEach((r, ri) => {
    const drill = r.children.length;
    const label = `<span class="mx-lab">${esc(r.name)}<em class="mx-vol num">${fmt(traces[ri])}</em></span>${drill ? `<i class="mx-caret" aria-hidden="true"></i>` : ""}`;
    rowLabels += drill
      ? `<button type="button" class="rh" data-row="${ri}" title="${esc(r.name)}" aria-label="下钻 ${esc(r.name)}">${label}</button>`
      : `<span class="rh" title="${esc(r.name)}">${label}</span>`;
    cols.forEach((c, ci) => {
      const cell = cells[ri][ci];
      const v = cell.hits ? 0.08 + 0.72 * Math.sqrt(cell.hits / maxHits) : 0;
      gridCells += cell.hits
        ? `<span class="cell num${v > 0.5 ? " hot" : ""}" style="--v:${v.toFixed(3)}" data-mx="${ri}:${ci}" title="${esc(r.name)} · ${esc(c.name)}：${fmt(cell.hits)} 条 Trace 命中 · ${fmt(cell.n)} 个问题 · 场景 ${fmt(traces[ri])} 条 Trace">${cellData(cell.hits, traces[ri])}</span>`
        : `<span class="cell is-empty" data-mx="${ri}:${ci}"></span>`;
    });
    tots += `<span class="rowtot num">${fmt(totals[ri])}</span>`;
  });
  const foot = cols.map((c, ci) => `<button type="button" class="cell coltot" style="--v:0.08" data-mx="${rows.length}:${ci}" title="全部场景 · ${esc(c.name)}：${fmt(colHits[ci])} 条 Trace 命中 / ${fmt(grandTraces)} 条 Trace · ${pct(colHits[ci], grandTraces, 1)}（共 ${fmt(colTotals[ci])} 个问题）">${cellData(colHits[ci], grandTraces)}</button>`).join("");
  return `<div class="matrix mx-swap-panel" style="--cols:${cols.length};--rows:${rows.length}">
    <div class="mx-rows"><span class="mx-corner" aria-hidden="true"></span>${rowLabels}<span class="rh"><span class="mx-lab mx-total-lab">场景合计<em class="mx-vol num">${fmt(grandTraces)}</em></span></span></div>
    <div class="mx-scroll"><div class="mx-grid">${heads}${gridCells}${foot}</div></div>
    <div class="mx-tots"><span class="rowtot-head" title="这个场景在所有问题类型上的问题数加起来"><span class="mx-lab mx-total-lab">问题合计</span></span>${tots}<span class="rowtot rowtot-foot">${fmt(grand)}</span></div>
  </div>`;
}

const KLINE_NAME = Object.fromEntries(KLINE_PERIODS);
const CLOCK = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hour12: false });
const clockOf = (time) => (typeof time === "number" ? CLOCK.format(new Date(time * 1000)) : String(time));

/* Plain names for the tip rows: the picked levels' Trace count and the evaluated Trace volume. */
function rateLabels(period, levels = []) {
  const picked = levels.map((name) => SEV_NAME[name] || name).join("+") || "所选等级";
  if (period === "intraday") return { close: `${picked} 累计 Trace`, volume: "本时段评测 Trace" };
  return { close: `${picked} Trace`, volume: "评测 Trace" };
}

/* 行情蜡烛按 5 分钟槽累计今天的问题数；点开时把该槽命中最多的一级交给样本抽屉。 */
function mxIntradayPick(intraday, model, candle, selected) {
  const counts = intraday.buckets?.find(([minute]) => minute === candle.from)?.slice(1) || [];
  let level = selected[0];
  let best = -1;
  selected.forEach((name) => {
    const n = Number(counts[model.levels.indexOf(name)] || 0);
    if (n > best) { best = n; level = name; }
  });
  return {
    date: intraday.date, when: `${intraday.date} ${candle.label}`, index: 0, seriesIndex: 0,
    series: {
      label: `${selected.map((name) => SEV_NAME[name] || name).join("+")} · 日内行情`,
      level,
      levelIdxs: selected.map((name) => model.levels.indexOf(name)).filter((i) => i >= 0),
      levelAll: false, models: [], uts: [],
    },
  };
}

/* 矩阵研究面板的 K 线口径：全量日期，蜡烛是该周期内「所选等级 Trace 数」的开高低收，
   量能是同一周期内所有等级的总 Trace 数（评测体量）。 */
function mxRateKlineRows(model, selected) {
  const idx = selected.map((level) => model.levels.indexOf(level)).filter((i) => i >= 0);
  if (!idx.length) return [];
  return model.rows.map(({ date, counts }) => ({
    date,
    value: idx.reduce((n, i) => n + (counts[i] || 0), 0),
    volume: counts.reduce((n, value) => n + (value || 0), 0),
  })).filter((row) => row.volume > 0);
}

/* 点一根蜡烛时打开它收盘日的样本；多等级同时选中时取当天命中最多的那一级。 */
function mxRatePick(model, candle, selected, period) {
  const row = model.rows.find((day) => day.date === candle.to);
  let level = selected[0];
  let best = -1;
  if (row) {
    selected.forEach((name) => {
      const n = row.counts[model.levels.indexOf(name)] || 0;
      if (n > best) { best = n; level = name; }
    });
  }
  return {
    date: candle.to, when: candle.to, index: 0, seriesIndex: 0,
    series: {
      label: `${selected.map((name) => SEV_NAME[name] || name).join("+")} · ${KLINE_NAME[period] || ""}`,
      level,
      levelIdxs: selected.map((name) => model.levels.indexOf(name)).filter((i) => i >= 0),
      levelAll: false, models: [], uts: [],
    },
  };
}

/* The two columns share one baseline: the trend fills the lens until its bottom meets the left
   card grid's bottom. The lens is sized by its content, so measuring the chrome on the current
   paint stays valid as the chart grows. */
function analysisChartHeight(panel, chartHost) {
  const lens = panel.querySelector(".mxp-lens");
  if (lens?.classList.contains("is-full")) return Math.max(480, Math.round(window.innerHeight - 260));
  const panels = panel.closest(".mx-panels");
  const issueShell = document.getElementById("mxIssueTrends");
  if (!panels?.classList.contains("is-both") || !issueShell || issueShell.hidden) return 260;
  if (!lens) return 260;
  const lr = issueShell.getBoundingClientRect();
  const pr = lens.getBoundingClientRect();
  if (!lr.height || !pr.height) return 260;
  const chrome = pr.height - chartHost.getBoundingClientRect().height;
  return Math.max(200, Math.round(lr.bottom - pr.top - chrome));
}

function wireMatrixAnalysis(panel, model, state, trend) {
  const chartHost = $(".mxp-rate-chart", panel);
  if (!chartHost) return;
  panel._mxFullCleanup?.();
  document.body.classList.remove("is-mxp-full");
  const rows = $$(".mxp-overview .mxp-legend-row[data-level]", panel);
  const levels = model?.levels || WORST;
  state.analysisLevels ||= ["P0", "P1"];
  state.analysisPeriod ||= "day";
  const intradayPack = trend?.trace_severity?.intraday;
  const intradayDays = intradayPack
    ? (Object.keys(intradayPack.days || {}).length ? Object.keys(intradayPack.days).sort() : [intradayPack.date].filter(Boolean))
    : [];
  const intradayFor = (day) => {
    if (!intradayPack) return null;
    const days = intradayPack.days || {};
    const hasDays = Object.keys(days).length > 0;
    const date = day || intradayPack.date;
    const entry = days[date];
    return {
      date,
      bucket_minutes: Number(intradayPack.bucket_minutes) || 5,
      prev: entry?.prev || intradayPack.prev || [0, 0, 0, 0, 0, 0],
      buckets: entry?.buckets || (!hasDays && date === intradayPack.date ? intradayPack.buckets || [] : []),
    };
  };
  const navEl = panel.querySelector("#mxpDayNav");
  const dayEl = panel.querySelector("#mxpDay");
  const syncDayNav = () => {
    if (!navEl || !dayEl) return;
    const prev = navEl.querySelector('[data-day-step="-1"]');
    const next = navEl.querySelector('[data-day-step="1"]');
    const value = dayEl.value;
    if (prev) prev.disabled = !value || value <= dayEl.min;
    if (next) next.disabled = !value || value >= dayEl.max;
  };
  const stepDay = (delta) => {
    if (!dayEl?.value) return;
    const d = new Date(`${dayEl.value}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + delta);
    const next = d.toISOString().slice(0, 10);
    if (!dayEl.min || !dayEl.max || next < dayEl.min || next > dayEl.max) return;
    dayEl.value = next;
    state.analysisDay = next;
    syncDayNav();
    paint();
  };
  if (dayEl) {
    if (!state.analysisDay || state.analysisDay < dayEl.min || state.analysisDay > dayEl.max) {
      state.analysisDay = dayEl.value || intradayPack?.date || "";
    }
    dayEl.onchange = () => { state.analysisDay = dayEl.value; syncDayNav(); paint(); };
    panel.querySelectorAll("[data-day-step]").forEach((btn) => {
      btn.onclick = () => stepDay(Number(btn.dataset.dayStep));
    });
    syncDayNav();
  }
  let paintToken = 0;
  let firstPaint = true;
  // The severity rows are the only filter; the ring is the same set drawn as shares.
  const sync = () => {
    const on = new Set(state.analysisLevels);
    rows.forEach((el) => el.setAttribute("aria-pressed", String(on.has(el.dataset.level))));
    const focus = on.size ? on : new Set(levels);
    $$(".mxp-ring-arc", panel).forEach((arc) => arc.classList.toggle("is-off", !focus.has(arc.dataset.level)));
  };
  // 抽屉是 K 线地图的侧栏：开合只改宽度，图表用 autoSize 跟着走，不需要重画。
  const drawer = trendSampleDrawer(chartHost, (pick) => loadTraceSamplePage(trend, pick), () => {}, {
    onOpenChange: (open) => {
      const seg = panel.querySelector(".mxp-kseg");
      if (seg) seg.hidden = open;
    },
  });
  chartHost._drawer = drawer;
  const zoomBtn = panel.querySelector("[data-mxp-zoom]");
  const setZoom = (on) => {
    state.analysisZoom = on;
    if (!zoomBtn) return;
    zoomBtn.setAttribute("aria-pressed", String(on));
    zoomBtn.setAttribute("aria-label", on ? "滚轮缩放已解锁" : "滚轮缩放已锁定");
    zoomBtn.title = on ? "点击锁定滚轮缩放" : "点击解锁滚轮缩放";
  };
  zoomBtn?.addEventListener("click", () => setZoom(!state.analysisZoom));
  setZoom(!!state.analysisZoom);
  const paint = () => {
    if (!model?.total) return;
    const token = ++paintToken;
    const draw = () => {
      if (token !== paintToken) return;
      chartHost._kline?.destroy();
      chartHost._kline = null;
      if (!state.analysisLevels.length) {
        chartHost.innerHTML = '<div class="empty">选择问题等级</div>';
        chartHost.style.opacity = "";
        return;
      }
      const period = state.analysisPeriod;
      const isIntraday = period === "intraday";
      if (navEl) navEl.hidden = !isIntraday || intradayDays.length <= 1;
      syncDayNav();
      const intraday = intradayFor(state.analysisDay);
      const candles = isIntraday ? buildIntradayCandles(intraday, state.analysisLevels, model.levels) : null;
      if (isIntraday && !candles.length) {
        chartHost.innerHTML = '<div class="empty">暂无日内行情数据</div>';
        chartHost.style.opacity = "";
        return;
      }
      const labels = rateLabels(period, state.analysisLevels);
      // Release lines (v1106, v1112 …) need the room of the full-screen chart; the panel-sized one
      // stays clean.
      const full = !!panel.querySelector(".mxp-lens")?.classList.contains("is-full");
      chartHost._kline = createKlineChart(chartHost, {
        rows: isIntraday ? [] : mxRateKlineRows(model, state.analysisLevels),
        candles: isIntraday ? candles : undefined,
        period,
        height: analysisChartHeight(panel, chartHost),
        volumeName: "Trace",
        releases: isIntraday || !full ? [] : trend.releases,
        wheelZoom: () => !!state.analysisZoom,
        emptyText: "暂无已评测 Trace",
        closeLabel: labels.close,
        volumeLabel: labels.volume,
        tickText: isIntraday ? (time) => clockOf(time) : undefined,
        tipTime: isIntraday ? (candle) => `${intraday.date} ${candle.label}` : undefined,
        onPick: (candle) => drawer.open(isIntraday
          ? mxIntradayPick(intraday, model, candle, state.analysisLevels)
          : mxRatePick(model, candle, state.analysisLevels, period)),
      });
      chartHost.style.opacity = "";
    };
    if (REDUCED || firstPaint) { firstPaint = false; draw(); return; }
    // 只在重画时淡一下：高度不变，所以不会带出任何布局跳动。
    chartHost.style.opacity = "0.35";
    requestAnimationFrame(draw);
  };
  const lens = panel.querySelector(".mxp-lens");
  const fullBtn = panel.querySelector("[data-mxp-full]");
  const setFull = (on) => {
    if (!lens) return;
    if (lens.classList.contains("is-full") === on) return;
    lens.classList.toggle("is-full", on);
    document.body.classList.toggle("is-mxp-full", on);
    if (fullBtn) {
      const label = on ? "退出全屏" : "全屏查看问题分析";
      fullBtn.setAttribute("aria-pressed", String(on));
      fullBtn.setAttribute("aria-label", label);
      fullBtn.title = on ? "退出全屏" : "全屏";
    }
    paint();
  };
  const onFullKey = (event) => {
    if (event.key !== "Escape" || !lens?.isConnected || !lens.classList.contains("is-full")) return;
    if (panel.querySelector(".mxt-sample-layout.is-open")) return;
    event.preventDefault();
    setFull(false);
  };
  document.addEventListener("keydown", onFullKey);
  panel._mxFullCleanup = () => {
    document.removeEventListener("keydown", onFullKey);
    document.body.classList.remove("is-mxp-full");
  };
  fullBtn?.addEventListener("click", () => setFull(!lens.classList.contains("is-full")));

  const toggle = (level) => {
    if (!level) return;
    const on = new Set(state.analysisLevels);
    if (on.has(level)) on.delete(level);
    else on.add(level);
    state.analysisLevels = levels.filter((l) => on.has(l));
    sync();
    paint();
  };
  const periodEl = $(".mxp-kseg", panel);
  const periodControl = periodEl ? segmented(periodEl, (value) => {
    state.analysisPeriod = value;
    paint();
  }) : null;
  requestAnimationFrame(() => periodControl?.set(state.analysisPeriod, { silent: true }));
  sync();
  paint();
  rows.forEach((row) => row.addEventListener("click", () => toggle(row.dataset.level)));
  let lastChartH = 0;
  let fitRaf = 0;
  const fit = () => {
    fitRaf = 0;
    if (!panel.isConnected) {
      panel._mxFitObserver?.disconnect();
      return;
    }
    const h = analysisChartHeight(panel, chartHost);
    if (Math.abs(h - lastChartH) >= 2) { lastChartH = h; paint(); }
  };
  panel._mxFitObserver?.disconnect();
  const ro = new ResizeObserver(() => {
    if (!fitRaf) fitRaf = requestAnimationFrame(fit);
  });
  ro.observe(panel);
  const issueShell = document.getElementById("mxIssueTrends");
  if (issueShell) ro.observe(issueShell);
  panel._mxFitObserver = ro;
}

function matrixPerspectiveHTML(trend, loading = false, state = {}) {
  const model = traceSeverityModel(trend);
  const shares = model ? traceShares(model.counts) : [];
  const levels = model?.levels || WORST;
  const selected = state.analysisLevels || ["P0", "P1"];
  const empty = loading ? "正在读取趋势…" : model ? "暂无已评测 Trace" : "当前快照缺少 Trace 等级统计";
  // 环形图负责「占比」，折线图负责「时间」；等级行是唯一开关，两边共用 analysisLevels。
  // 空白选择视为「全部」：没有筛选时整圈保持同等亮度，不把环形图做成禁用态。
  const focus = new Set(selected.length ? selected : levels);
  let at = 0;
  const arcs = levels.map((key, i) => ({ key, n: model ? model.counts[i] : 0, share: shares[i] || 0, c: sevColor(key) }))
    .filter((seg) => seg.share > 0)
    .map((seg, i) => {
      const dash = Math.max(0.6, seg.share - 0.8);
      const offset = at;
      at += seg.share;
      return `<circle class="mxp-ring-arc${focus.has(seg.key) ? "" : " is-off"}" data-level="${esc(seg.key)}" cx="48" cy="48" r="38" pathLength="100" style="--ring-i:${i};stroke:${seg.c};stroke-dasharray:${dash.toFixed(2)} ${(100 - dash).toFixed(2)};stroke-dashoffset:${(-offset).toFixed(2)}"/>`;
    }).join("");
  const legend = levels.map((key, i) => {
    const on = selected.includes(key);
    const count = model ? fmt(model.counts[i]) : "—";
    const share = shares[i] == null ? "—" : `${fmt(shares[i], 1)}%`;
    return `<button type="button" class="mxp-legend-row" data-level="${key}" aria-pressed="${on}" title="${esc(`${SEV_NAME[key]} · ${count} Trace · ${share}`)}" aria-label="${esc(`${SEV_NAME[key]}，${count} Trace，${share}，${on ? "正在" : "不在"}趋势中显示`)}"><i style="--c:${sevColor(key)}" aria-hidden="true"></i><span>${SEV_NAME[key]}</span><b class="num mxp-legend-share">${share}</b><small class="num mxp-legend-count">${count} Trace</small></button>`;
  }).join("");
  const intraday = trend?.trace_severity?.intraday;
  const dayList = intraday
    ? (Object.keys(intraday.days || {}).length ? Object.keys(intraday.days).sort() : [intraday.date].filter(Boolean))
    : [];
  const minDay = dayList[0] || "";
  const maxDay = dayList[dayList.length - 1] || "";
  const pickedDay = state.analysisDay && (!dayList.length || (state.analysisDay >= minDay && state.analysisDay <= maxDay))
    ? state.analysisDay
    : (intraday?.date || "");
  const dayNav = dayList.length
    ? `<span class="mxp-daynav" id="mxpDayNav"${state.analysisPeriod === "intraday" ? "" : " hidden"}>
        <button type="button" class="mxp-daystep" data-day-step="-1" aria-label="前一天" title="前一天">‹</button>
        <input class="mxp-day" id="mxpDay" type="date" aria-label="日内行情日期" min="${esc(minDay)}" max="${esc(maxDay)}" value="${esc(pickedDay)}">
        <button type="button" class="mxp-daystep" data-day-step="1" aria-label="后一天" title="后一天">›</button>
      </span>`
    : "";
  return `<div class="mxp">
    <section class="mxp-lens mxp-overview" aria-label="问题等级与 Trace 趋势">
      <button type="button" class="icon-btn mxp-full" data-mxp-full aria-pressed="false" aria-label="全屏查看问题分析" title="全屏">
        <svg class="i-mxpfull-open" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M6 2.5H2.5V6M10 2.5h3.5V6M6 13.5H2.5V10M10 13.5h3.5V10" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
        <svg class="i-mxpfull-close" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M2.5 6H6V2.5M13.5 6H10V2.5M2.5 10H6v3.5M13.5 10H10v3.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
      <div class="mxp-dist" role="group" aria-label="按最严重等级归类的 Trace 数量与占比；点一行可在 Trace 趋势中显示或隐藏">
        <div class="mxp-ring-wrap">
          <svg class="mxp-ring" viewBox="0 0 96 96" role="img" aria-label="按最严重等级归类的 Trace 占比，合计 100%">
            <circle class="mxp-ring-track" cx="48" cy="48" r="38"/>
            ${arcs}
          </svg>
          <div class="mxp-ring-center"><b class="num">${model?.total ? fmt(model.total) : "—"}</b><small>Trace</small></div>
        </div>
        <div class="mxp-legend">${legend}</div>
      </div>
      <div class="mxp-trend">
        <div class="mxp-trend-head"><b>Trace 趋势</b>${model?.total ? `<div class="mxp-trend-tools">
          <button type="button" class="mxt-zoom" data-mxp-zoom aria-pressed="${!!state.analysisZoom}" aria-label="${state.analysisZoom ? "滚轮缩放已解锁" : "滚轮缩放已锁定"}" title="${state.analysisZoom ? "点击锁定滚轮缩放" : "点击解锁滚轮缩放"}">
            <svg class="i-zoom-lock" viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="4" y="7" width="8" height="6" rx="1.2" stroke="currentColor" stroke-width="1.3"/><path d="M6 7V5.3a2 2 0 0 1 4 0V7" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>
            <svg class="i-zoom-unlock" viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="4" y="7" width="8" height="6" rx="1.2" stroke="currentColor" stroke-width="1.3"/><path d="M6 7V5.3a2 2 0 0 1 3.8-.8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>
          </button>
          <div class="seg mxp-kseg" id="mxpKPeriod" role="group" aria-label="K 线周期">
            <span class="seg-knob" aria-hidden="true"></span>
            ${KLINE_PERIODS.map(([value, label]) => `<button type="button" data-value="${value}" aria-pressed="${(state.analysisPeriod || "day") === value}">${label}</button>`).join("")}
          </div>
          ${dayNav}
        </div>` : ""}</div>
        ${trendSampleFrame(`<div class="mpt-chart mxp-rate-chart" data-own-tip>${model?.total ? "" : `<div class="empty">${empty}</div>`}</div>`)}
      </div>
    </section>
  </div>`;
}

/* Fullscreen grows the matrix as one piece. Column widths stay at their content width and every
   row height / font scales with them; stretching only the columns turned a 38px row into a wide
   flat strip. The zoom stops at MX_FULL_ZOOM_MAX so a 32:9 monitor does not blow the cells up. */
const MX_FULL_ZOOM_MAX = 1.5;

/* One line per title: the column pane never gets narrower than its widest title, so a narrow
   card scrolls the pane sideways instead of ending a label in an ellipsis. */
function fitMatrix(m) {
  if (!m) return;
  const labs = $$(".mh .mx-lab", m);
  if (!labs.length) return;
  const widths = [...labs, ...$$(".mx-grid .cell-main, .mx-grid .cell-pct", m)].map((el) => el.scrollWidth);
  const need = Math.ceil(Math.max(...widths)) + 9; // 4px gap + 5px caret
  m.style.setProperty("--mx-colw", `${need}px`);
  if (m.closest(".mx-card.is-mx-full, .mx-card.is-page")) {
    const cols = Number(m.style.getPropertyValue("--cols")) || 0;
    const rows = m.querySelector(".mx-rows");
    const tots = m.querySelector(".mx-tots");
    // offsetWidth stays in unzoomed layout pixels, so repeated fits keep measuring the same table.
    const natural = cols
      ? (rows?.offsetWidth || 0) + (tots?.offsetWidth || 0) + cols * need + Math.max(0, cols - 1) * 4 + 8
      : 0;
    const avail = m.parentElement?.clientWidth || 0;
    const zoom = natural && avail ? Math.min(MX_FULL_ZOOM_MAX, Math.max(1, avail / natural)) : 1;
    m.style.zoom = zoom > 1.001 ? zoom.toFixed(4) : "";
  } else if (m.style.zoom) {
    m.style.zoom = "";
  }
  const pane = m.querySelector(".mx-scroll");
  if (pane) {
    pane.classList.toggle("is-overflow", pane.scrollWidth > pane.clientWidth + 1);
    pane.classList.toggle("is-at-end", pane.scrollLeft + pane.clientWidth >= pane.scrollWidth - 2);
  }
}

/* Drill pages use the clicked table element as the transition origin. The outgoing panel recedes a
   few pixels while the incoming panel is revealed by an opaque radial clip, then the shell settles
   to its new height. It reads as a ring opening from the pointer, like the sunburst, instead of a
   hard old-page/new-page cut. */
function swapShell(shell, html, animate, source, done = null) {
  if (shell._swapCleanup) shell._swapCleanup();
  const panels = $$(".mx-swap-panel", shell);
  const prev = panels[panels.length - 1];
  if (!animate || REDUCED || !prev) {
    shell.innerHTML = html;
    fitMatrix(shell.querySelector(".matrix"));
    hideTip();
    done?.();
    return;
  }
  const token = (shell._swapToken || 0) + 1;
  shell._swapToken = token;
  const box = shell.getBoundingClientRect();
  const src = source && source.getBoundingClientRect ? source.getBoundingClientRect() : null;
  const ox = src && source.id !== "mxBack"
    ? Math.max(12, Math.min(box.width - 12, src.left + src.width / 2 - box.left))
    : box.width / 2;
  const oy = src ? Math.max(12, Math.min(Math.max(12, box.height - 4), src.top + src.height / 2 - box.top)) : box.height / 2;
  const from = prev.offsetHeight;
  shell.style.height = `${from}px`;
  shell.classList.add("is-swapping");
  shell.insertAdjacentHTML("beforeend", html);
  const next = shell.querySelector(".mx-swap-panel:last-child");
  if (!next) {
    shell.classList.remove("is-swapping");
    shell.style.height = "";
    return;
  }
  fitMatrix(next.classList.contains("matrix") ? next : null);
  const to = next.offsetHeight;
  next.style.position = "absolute";
  next.style.inset = "0 0 auto";
  next.style.background = "var(--card)";
  next.style.transformOrigin = `${ox}px ${oy}px`;
  next.style.clipPath = `circle(0px at ${ox}px ${oy}px)`;
  prev.style.transformOrigin = `${ox}px ${oy}px`;
  const probe = document.createElement("i");
  probe.className = "mx-swap-probe";
  probe.style.left = `${ox}px`;
  probe.style.top = `${oy}px`;
  shell.appendChild(probe);
  const radius = Math.hypot(Math.max(ox, box.width - ox), Math.max(oy, to - oy)) + 12;
  const ease = "cubic-bezier(0.25, 1, 0.5, 1)";
  const out = prev.animate([
    { opacity: 1, transform: "scale(1)" },
    { opacity: 0, transform: "scale(0.992)" },
  ], { duration: 140, easing: "cubic-bezier(0.4, 0, 1, 1)", fill: "forwards" });
  const enter = next.animate([
    { opacity: 1, clipPath: `circle(0px at ${ox}px ${oy}px)`, transform: "scale(0.997)" },
    { opacity: 1, clipPath: `circle(${radius.toFixed(1)}px at ${ox}px ${oy}px)`, transform: "none" },
  ], { duration: 340, delay: 10, easing: ease, fill: "forwards" });
  const resize = from !== to
    ? shell.animate([{ height: `${from}px` }, { height: `${to}px` }], { duration: 340, easing: ease, fill: "forwards" })
    : null;
  const ripple = probe.animate([
    { opacity: 0.6, transform: "translate(-50%, -50%) scale(0.25)" },
    { opacity: 0, transform: "translate(-50%, -50%) scale(9)" },
  ], { duration: 380, easing: ease, fill: "forwards" });
  const anims = [out, enter, resize, ripple].filter(Boolean);
  shell._swapCleanup = () => {
    anims.forEach((anim) => anim.cancel());
    const current = $$(".mx-swap-panel", shell);
    const keep = current[current.length - 1];
    current.slice(0, -1).forEach((panel) => panel.remove());
    $$(".mx-swap-probe", shell).forEach((el) => el.remove());
    if (keep) {
      keep.style.position = "";
      keep.style.inset = "";
      keep.style.background = "";
      keep.style.transformOrigin = "";
      keep.style.clipPath = "";
    }
    shell.style.height = "";
    shell.classList.remove("is-swapping");
    shell._swapCleanup = null;
    fitMatrix(keep && keep.classList.contains("matrix") ? keep : null);
    hideTip();
  };
  Promise.all([out.finished.catch(() => {}), enter.finished.catch(() => {}), resize ? resize.finished.catch(() => {}) : Promise.resolve()]).then(() => {
    if (token !== shell._swapToken || !shell._swapCleanup) return;
    shell._swapCleanup();
    done?.();
  });
}

/* ---------------------------------------------------------------- 聚类矩阵格子: 就地 P0-P4 时间趋势
   点格子不再跳具体数据：同一个「场景 × 问题聚类」在一张按时间轴的多折线图上看 P0-P4 的
   出现数或出现比例（当日同场景已评测 Trace 中命中该等级问题的 Trace 占比），发版日期画成竖线。
   四层聚类都能点：列节点的任何前缀都在 payload 的 nodes 里。
   口径 / 时间 / 场景是单选；来源 / 模型 / 等级是多选，每条线 = 三个多选值的一组组合：
   颜色 = 等级、虚线 = 模型、明度 = 来源，右侧端点直接标最新值，同等级的两个模型之间
   画差距带并在右端标差值（领导汇报时不用对照 legend）。 */
const TREND_SEV = ["P0", "P1", "P2", "P3", "P4"];
const TREND_MEASURE = { count: "出现数", ratio: "出现比例" };
const TREND_UT_NAME = { all: "全部来源", real: "真实", test: "测试", internal: "内部", unknown: "未知" };
const TREND_CACHE = new Map();
const TREND_READY = new Map();

/* One payload per (product, build); a rebuild invalidates it through generated_at. */
const trendKey = (c) => `${c.product}|${c.data.generated_at}`;
const trendReady = (c) => TREND_READY.get(trendKey(c));
/* Only the current build's payload is kept: a page left open across many rebuilds must not
   hold every earlier ~10 MB trends payload in memory. */
const keepOnly = (map, key) => [...map.keys()].forEach((k) => { if (k !== key) map.delete(k); });
function loadTrend(c) {
  const key = trendKey(c);
  keepOnly(TREND_READY, key);
  keepOnly(TREND_CACHE, key);
  if (TREND_READY.has(key)) return Promise.resolve(TREND_READY.get(key));
  if (!TREND_CACHE.has(key)) {
    TREND_CACHE.set(key, getJSON(`trends-${c.product}.json`)
      .then((data) => { TREND_READY.set(key, data); return data; })
      .catch(() => null));
  }
  return TREND_CACHE.get(key);
}

/* AB 轮次同样按 (产品, 构建) 缓存一次：几十 KB，切回来不再请求。 */
const AB_CACHE = new Map();
function loadAB(c, url) {
  const key = `${c.product}|${c.data.generated_at}`;
  keepOnly(AB_CACHE, key);
  if (!AB_CACHE.has(key)) AB_CACHE.set(key, getJSON(url).catch(() => null));
  return AB_CACHE.get(key);
}

/* 场景行 → payload.scenes 下标：subtask 行精确匹配，task 行取它下面的全部 subtask；
   范围切到「全部场景」时不按行过滤，就是整个产品的问题率。 */
function trendScenes(trend, row, scope) {
  const set = new Set();
  if (scope === "all") {
    trend.scenes.forEach((_, i) => set.add(i));
    return set;
  }
  trend.scenes.forEach(([task, sub], i) => {
    if (task !== row.task) return;
    if (row.sub && sub !== row.sub) return;
    set.add(i);
  });
  return set;
}

/* Calendar window ending on the last built day. Only days that actually carry a cell for the
   selected scene × cluster are returned, so an empty calendar prefix never becomes a flat
   baseline full of meaningless date ticks. */
function trendWindow(trend, range, activeDates) {
  const present = trend.dates
    .map((d, idx) => ({ d, idx }))
    .filter((w) => !activeDates || activeDates.has(w.idx));
  if (range === "all" || !trend.dates.length) return present;
  const end = dayMs(trend.dates[trend.dates.length - 1]);
  const start = end - (Number(range) - 1) * DAY_MS;
  const from = isoDay(start);
  const to = isoDay(end);
  return present.filter((w) => w.d >= from && w.d <= to);
}

/* 一条折线 = 一组「来源 · 模型 · 等级」条件；来源和模型可多选合并，等级单选。
   条件池编辑当前选中的折线，点折线卡片切换编辑对象，拖条件到卡片也能改；最多 4 条，
   可以删到 0 条（图表显示空状态），不把多选条件拆成多条线。 */
const trendUtName = (u) => (u === "all" ? "全部来源" : TREND_UT_NAME[u] || u || "全部");
const TREND_UT_SHORT = { all: "全", real: "真", test: "测", internal: "内", unknown: "?" };
const trendUtShort = (u) => TREND_UT_SHORT[u] || trendUtName(u).slice(0, 1);
const trendModelName = (trend, id) => {
  if (!id) return "";
  const m = (trend.modelLabels || []).find((x) => x.id === id);
  return (m && m.label) || id;
};
const TREND_MAX_GROUPS = 4;
const trendGroupColor = (i) => `var(--mx-c${Math.min(i, 3) + 1})`;
const trendLineSourceName = (trend, line) => {
  const all = Array.isArray(trend.uts) ? trend.uts : [];
  const sel = line.uts && line.uts.length ? line.uts : all;
  if (!all.length || sel.length === all.length) return "全部来源";
  return sel.map(trendUtName).join("+");
};
const trendLineModelName = (trend, line) => {
  const all = Array.isArray(trend.models) && trend.models.length ? trend.models : [""];
  const sel = line.models && line.models.length ? line.models : all;
  if (!all.length || sel.length === all.length) return "全部模型";
  return sel.map((m) => trendModelName(trend, m) || m).filter(Boolean).join("+");
};
const trendLevelsName = (levels) => (levels && levels.length ? levels.join("+") : "全部等级");
const trendLineName = (trend, line) => `${trendLineSourceName(trend, line)} · ${trendLineModelName(trend, line)} · ${trendLevelsName(line.levels)}`;

/* 纵轴上限：四格刻度（含 0），刻度走 1/2/4/5/10 阶梯，标签永远是整数（计数）
   或整齐的百分数（比例），不会出现 0/67/133 这种读不出来的刻度。 */
function trendTop(v, ratio) {
  if (!(v > 0)) return ratio ? 1 : 4;
  if (!ratio && v <= 4) return 4;
  const raw = v / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const ladder = ratio ? [1, 2, 2.5, 4, 5, 10] : [1, 2, 4, 5, 10];
  const step = ladder.map((m) => m * mag).find((s) => s >= raw) || 10 * mag;
  const top = step * 4;
  return ratio ? top : Math.max(2, Math.round(top));
}
const trendCeil = (v) => trendTop(v, false);
const trendRatioCeil = (v) => trendTop(v, true);

function trendSeries(trend, spec) {
  const node = trend.nodes.indexOf(spec.node);
  // The x-axis is stable across line conditions: it contains every date on which this scene ×
  // cluster has a payload cell, even if the currently selected model has a zero count that day.
  const activeDates = new Set();
  if (node >= 0 && spec.scenes.size) {
    for (const [d, sc, nd] of trend.cells) {
      if (nd === node && spec.scenes.has(sc)) activeDates.add(d);
    }
  }
  const win = trendWindow(trend, spec.range, activeDates);
  const n = win.length;
  const models = Array.isArray(trend.models) && trend.models.length ? trend.models : [""];
  const uts = Array.isArray(trend.uts) ? trend.uts : [];
  const lines = (Array.isArray(spec.lines) ? spec.lines : []).slice(0, TREND_MAX_GROUPS);
  const series = lines.map((line, gi) => {
    const utsSel = (line.uts && line.uts.length ? line.uts : uts).filter((u) => uts.includes(u));
    const modelsSel = (line.models && line.models.length ? line.models : models).filter((m) => models.includes(m));
    const lineLevels = line.levels && line.levels.length ? line.levels.filter((l) => TREND_SEV.includes(l)) : [];
    const levelsSel = lineLevels.length ? lineLevels : TREND_SEV;
    const levelIdxs = levelsSel.map((l) => TREND_SEV.indexOf(l));
    const levelMask = levelIdxs.reduce((m, k) => m | (1 << k), 0);
    return {
      gi, uts: utsSel, models: modelsSel, levels: lineLevels,
      utSet: new Set(utsSel.map((u) => uts.indexOf(u))),
      modelSet: new Set(modelsSel.map((m) => models.indexOf(m))),
      levelIdxs, levelMask, levelAll: levelIdxs.length === TREND_SEV.length,
      levelName: trendLevelsName(lineLevels),
      modelName: modelsSel.length === 1 ? (trendModelName(trend, modelsSel[0]) || modelsSel[0]) : "",
      name: trendLineName(trend, { uts: utsSel, models: modelsSel, levels: lineLevels }),
      shortName: `${utsSel.length === uts.length ? "全源" : utsSel.length === 1 ? trendUtShort(utsSel[0]) : "多源"}·${modelsSel.length === models.length ? "全模型" : modelsSel.length === 1 ? (trendModelName(trend, modelsSel[0]) || modelsSel[0]) : "多模型"}·${levelIdxs.length === TREND_SEV.length ? "全部" : levelsSel.join("+")}`,
      color: trendGroupColor(gi),
      count: new Array(n).fill(0),
      hits: new Array(n).fill(0),
      sessions: new Array(n).fill(0),
      vals: new Array(n).fill(null),
      last: -1,
    };
  });
  if (node >= 0 && spec.scenes.size && series.length) {
    const volume = new Array(n).fill(0);
    const volUts = new Set();
    const volModels = new Set();
    series.forEach((s) => {
      s.utSet.forEach((i) => volUts.add(i));
      s.modelSet.forEach((i) => volModels.add(i));
    });
    const winAt = new Map();
    win.forEach((w, i) => { if (w.idx >= 0) winAt.set(w.idx, i); });
    for (const [d, sc, nd, m, u, ...rest] of trend.cells) {
      if (nd !== node || !spec.scenes.has(sc)) continue;
      const wi = winAt.get(d);
      if (wi == null) continue;
      const p = rest.slice(0, TREND_SEV.length);
      const h = rest.slice(TREND_SEV.length, TREND_SEV.length * 2);
      const any = rest[TREND_SEV.length * 2] || 0;
      const hist = [];
      for (let j = TREND_SEV.length * 2 + 1; j + 1 < rest.length; j += 2) hist.push([rest[j], rest[j + 1]]);
      const total = p.reduce((a, b) => a + b, 0);
      for (const s of series) {
        if (!s.utSet.has(u) || !s.modelSet.has(m)) continue;
        s.count[wi] += s.levelAll ? total : s.levelIdxs.reduce((sum, k) => sum + (p[k] || 0), 0);
        let hits;
        if (hist.length) {
          hits = 0;
          for (const [mask, count] of hist) if (mask & s.levelMask) hits += count;
        } else if (s.levelAll) {
          hits = any;
        } else if (s.levelIdxs.length === 1) {
          hits = h[s.levelIdxs[0]] || 0;
        } else {
          // 旧 schema 没有 mask 直方图：多等级命中 Trace 取逐级和与 all-level 并集的较小值近似。
          hits = Math.min(any, s.levelIdxs.reduce((sum, k) => sum + (h[k] || 0), 0));
        }
        s.hits[wi] += hits;
      }
    }
    for (const [d, sc, m, u, nx] of trend.base) {
      if (!spec.scenes.has(sc)) continue;
      const wi = winAt.get(d);
      if (wi == null) continue;
      if (volModels.has(m) && volUts.has(u)) volume[wi] += nx;
      for (const s of series) if (s.utSet.has(u) && s.modelSet.has(m)) s.sessions[wi] += nx;
    }
    series.forEach((s) => {
      for (let i = 0; i < n; i++) {
        if (win[i].idx < 0) { s.vals[i] = null; continue; }
        s.vals[i] = spec.measure === "ratio"
          ? (s.sessions[i] > 0 ? (100 * Math.min(s.hits[i], s.sessions[i])) / s.sessions[i] : null)
          : s.count[i];
        if (s.vals[i] != null) s.last = i;
      }
    });
    const peak = series.reduce((mx, s) => s.vals.reduce((m, v) => (v != null && v > m ? v : m), mx), 0);
    const top = spec.measure === "ratio" ? trendRatioCeil(peak) : trendCeil(peak);
    const empty = !series.length || !series.some((s) => s.vals.some((v) => v != null));
    return { win, series, top, measure: spec.measure, empty, volume };
  }
  const peak = series.reduce((mx, s) => s.vals.reduce((m, v) => (v != null && v > m ? v : m), mx), 0);
  const top = spec.measure === "ratio" ? trendRatioCeil(peak) : trendCeil(peak);
  const empty = !series.length || !series.some((s) => s.vals.some((v) => v != null));
  return { win, series, top, measure: spec.measure, empty, volume: [] };
}

/* 条件池：来源、模型可多选合并，等级单选；这些条件共同组成当前选中的那一条折线。
   折线卡片最多 4 条，点卡片切换编辑对象；没有折线时显示待添加状态。 */
function trendChip(kind, value, label, on, draggable = true) {
  return `<button type="button" class="mxt-chip" draggable="${draggable}" data-kind="${kind}" data-value="${esc(value)}" aria-pressed="${on}" aria-label="${esc(label)}">${esc(label)}</button>`;
}

function trendPalette(data, line) {
  const uts = data.uts || [];
  const models = data.models || [];
  return `<span class="mxt-pickgroup" role="group" aria-label="来源">
    <span class="mxt-pick-label">来源</span>${trendChip("uts", "all", "全部来源", !line.uts.length)}${uts.map((u) => trendChip("uts", u, trendUtName(u), line.uts.includes(u))).join("")}
  </span>
  <span class="mxt-pickgroup" role="group" aria-label="模型">
    <span class="mxt-pick-label">模型</span>${trendChip("models", "all", "全部模型", !line.models.length)}${models.map((m) => trendChip("models", m, trendModelName(data, m) || m, line.models.includes(m))).join("")}
  </span>
  <span class="mxt-pickgroup" role="group" aria-label="等级">
    <span class="mxt-pick-label">等级</span>${[["all", "全部等级"], ...TREND_SEV.map((s) => [s, s])].map(([v, lbl]) => trendChip("level", v, lbl, v === "all" ? !line.levels.length : line.levels.includes(v))).join("")}
  </span>`;
}

function trendLinesHTML(lines, data, active) {
  if (!lines.length) {
    return `<span class="mxt-lines-empty">暂无折线</span><button type="button" class="mxt-line-add" data-add="1" aria-label="添加一条折线">＋ 添加折线</button>`;
  }
  const cards = lines.map((line, i) => `<div class="mxt-linecard${i === active ? " is-active" : ""}" data-line="${i}" tabindex="0" role="group" aria-label="折线 ${i + 1}：${esc(trendLineName(data, line))}">
    <i class="mxt-gdot" style="--c:${trendGroupColor(i)}"></i>
    <span class="mxt-gname">${esc(trendLineName(data, line))}</span>
    <button type="button" class="mxt-gdel" data-del="${i}" aria-label="删除这条折线">×</button>
  </div>`).join("");
  return `<span class="mxt-lines-label">折线</span>${cards}<button type="button" class="mxt-line-add" data-add="1" aria-label="添加一条折线"${lines.length >= TREND_MAX_GROUPS ? " disabled" : ""}>+</button>`;
}

const TREND_SEG_LABEL = { measure: "口径", scope: "场景范围" };
const TREND_SEG_TITLE = {
  measure: "出现数 = 该聚类的问题条数；出现比例 = 命中 Trace 占比：当日同场景已评测 Trace 中，命中该聚类该等级问题的 Trace 占比",
  scope: "本场景 = 点进来的这一行；全部场景 = 整个产品，不按场景拆分",
};

function trendSeg(id, key, items, value) {
  return `<div class="seg mxt-${key}" id="${id}" role="group" aria-label="${TREND_SEG_LABEL[key]}" title="${esc(TREND_SEG_TITLE[key])}">
    <span class="seg-knob" aria-hidden="true"></span>${items
    .map(([v, t]) => `<button type="button" data-value="${esc(v)}" aria-pressed="${v === value}">${esc(t)}</button>`)
    .join("")}</div>`;
}

function trendFilterCount(spec) {
  let n = 0;
  const lines = Array.isArray(spec?.lines) ? spec.lines : [];
  if (lines.length > 1) n += lines.length - 1;
  lines.forEach((l) => {
    if (l?.uts?.length) n += 1;
    if (l?.models?.length) n += 1;
    if (l?.levels?.length) n += 1;
  });
  if (spec?.rowName && spec.rowName !== "全部场景" && spec.scope === "all") n += 1;
  return n;
}

function trendBarHTML(data, spec, crumb) {
  const active = spec.lines[spec.active];
  const moreCount = trendFilterCount(spec);
  const hasScope = Boolean(spec.rowName && spec.rowName !== "全部场景");
  return `<div class="mxt-bar is-head">
    ${crumb ? `<span class="mxt-crumb" title="${esc(crumb.full)}">${crumb.prefix ? `<span class="mxt-crumb-p">${esc(crumb.prefix)}</span><i aria-hidden="true">/</i>` : ""}<b>${esc(crumb.label)}</b></span>` : ""}
    <div class="mxt-tools">
      ${trendSeg("mxtMeasure", "measure", [["count", TREND_MEASURE.count], ["ratio", TREND_MEASURE.ratio]], spec.measure)}
    </div>
    <div class="bn-more-wrap mxt-more-wrap" id="mxtMoreWrap">
      <button type="button" class="bn-more-toggle${moreCount ? " has-active" : ""}" id="mxtMoreToggle" aria-haspopup="true" aria-expanded="false">
        <span class="bn-more-plus" aria-hidden="true"></span>
        <span>筛选</span>
        <span class="bn-more-badge" id="mxtMoreBadge"${moreCount ? "" : " hidden"}>${moreCount}</span>
      </button>
      <div class="bn-more-pop mxt-more-pop" id="mxtMorePop" inert>
        ${hasScope ? `<div class="mxt-pop-sec"><span class="mxt-pick-label">场景范围</span>${trendSeg("mxtScope", "scope", [["row", `本场景：${spec.rowName}`], ["all", "全部场景"]], spec.scope)}</div>` : ""}
        <div class="mxt-pop-sec">
          <div class="mxt-lines" id="mxtLines">${trendLinesHTML(spec.lines, data, spec.active)}</div>
        </div>
        <div class="mxt-palette" id="mxtPalette">${active ? trendPalette(data, active) : ""}</div>
        <div class="bn-more-foot">
          <span class="mxt-pop-hint" id="mxtMoreHint">${moreCount ? `已启用 ${moreCount} 项条件` : "按来源 / 模型 / 等级筛选或添加对比线"}</span>
          <button type="button" class="bn-chip-clear" id="mxtMoreClr"${moreCount ? "" : " hidden"}>重置筛选</button>
        </div>
      </div>
    </div>
    <button type="button" class="mxt-zoom" id="mxtZoom" aria-pressed="${!!spec.zoom}" aria-label="${spec.zoom ? "滚轮缩放已解锁" : "滚轮缩放已锁定"}" title="${spec.zoom ? "点击锁定滚轮缩放" : "点击解锁滚轮缩放"}">
      <svg class="i-zoom-lock" viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="4" y="7" width="8" height="6" rx="1.2" stroke="currentColor" stroke-width="1.3"/><path d="M6 7V5.3a2 2 0 0 1 4 0V7" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>
      <svg class="i-zoom-unlock" viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="4" y="7" width="8" height="6" rx="1.2" stroke="currentColor" stroke-width="1.3"/><path d="M6 7V5.3a2 2 0 0 1 3.8-.8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>
    </button>
    <span class="mxt-vol-key"><i aria-hidden="true"></i>Trace 数量</span>
  </div>`;
}

function trendBodyHTML(_data, _spec, title) {
  return `<div class="mxt mxt-stage mx-swap-panel" data-own-tip>
    ${trendSampleFrame(`<div class="mxt-plot" id="mxtPlot" data-own-tip aria-label="${esc(title)}"></div>`)}
  </div>`;
}

const plotWidth = (box) => ($("#mxtPlot", box) || box).clientWidth;

function paintTrendPlot(box, spec, trend, onOpenChange = null, wheelZoom = null, initialPickDate = null) {
  const plot = $("#mxtPlot", box);
  if (!plot) return;
  plot._drawer?.destroy();
  plot._trend?.destroy();
  plot._trend = null;
  if (!spec.lines.length) {
    plot.innerHTML = `<div class="empty">暂无折线</div>`;
    return;
  }
  const view = trendSeries(trend, spec);
  if (view.empty) {
    plot.innerHTML = `<div class="empty">暂无趋势数据</div>`;
    return;
  }
  const draw = () => {
    // 折线图统一走 K 线的 lightweight-charts 外壳：滚轮缩放、拖拽平移、十字线读数都在里面。
    plot.tabIndex = -1;
    plot._trend?.destroy();
    plot._trend = createTrendChart(plot, {
      series: view.series.map((s) => ({
        name: s.name,
        color: s.color,
        data: view.win.map((w, i) => ({ time: w.d, value: s.vals[i] })).filter((d) => d.value != null),
      })),
      measure: view.measure,
      releases: trend.releases,
      volume: view.win.map((w, i) => ({ time: w.d, value: view.volume?.[i] ?? 0 })),
      wheelZoom: typeof wheelZoom === "function" ? wheelZoom : () => false,
      height: box.closest(".mx-card.is-mx-full")
        ? Math.max(420, Math.min(760, Math.round(window.innerHeight - 220)))
        : Math.max(280, Math.min(460, Math.round(plotWidth(box) * 0.32))),
      onPick: ({ time, seriesIndex }) => {
        const i = view.win.findIndex((w) => w.d === time);
        const series = view.series[seriesIndex];
        if (i < 0 || !series) return;
        drawer.open({ date: time, series, seriesIndex, index: i });
      },
    });
  };
  const drawer = trendSampleDrawer(plot, (pick) => loadTrendSamplePage(trend, spec, pick), () => {},
    onOpenChange ? { onOpenChange } : {});
  plot._drawer = drawer;
  draw();
  if (initialPickDate && view.series.length) {
    const idx = view.win.findIndex((w) => w.d === initialPickDate);
    if (idx >= 0) {
      drawer.open({ date: initialPickDate, series: view.series[0], seriesIndex: 0, index: idx });
    }
  }
}

/* 默认折线先看总盘：全部来源 × 全部模型 × 全部问题合成一条线。 */
function trendDefaultLines(data) {
  return [{ uts: [], models: [], levels: [] }];
}

function normalizeTrend(trend, data) {
  const uts = Array.isArray(data.uts) ? data.uts : [];
  const models = Array.isArray(data.models) && data.models.length ? data.models : [""];
  if (!trend.seeded) {
    trend.lines = trendDefaultLines(data);
    trend.active = 0;
    trend.seeded = true;
  }
  const fix = (line) => {
    const levels = Array.isArray(line && line.levels)
      ? TREND_SEV.filter((l) => line.levels.includes(l))
      : [];
    return {
      uts: Array.isArray(line && line.uts) ? uts.filter((u) => line.uts.includes(u)) : [],
      models: Array.isArray(line && line.models) ? models.filter((m) => line.models.includes(m)) : [],
      levels: levels.length === TREND_SEV.length ? [] : levels,
    };
  };
  trend.lines = (Array.isArray(trend.lines) ? trend.lines : []).slice(0, TREND_MAX_GROUPS).map(fix);
  trend.active = trend.lines.length ? Math.max(0, Math.min(trend.active || 0, trend.lines.length - 1)) : 0;
}

function matrixCard(p, tax) {
  const page = document.documentElement.dataset.matrix === "1";
  const klineBtn = tax
    ? `<button type="button" class="link mx-kline" id="mxKline" aria-expanded="false" aria-controls="mxKlineFace">问题K线图</button>`
    : "";
  const abBtn = p.ab && tax
    ? `<button type="button" class="link mx-ab" id="mxAB" aria-expanded="false" aria-controls="mxABFace" title="固定题集改版前后对比 + 线上真实用户验证">A/B Test<small>${esc(p.ab.label || "")}</small></button>`
    : "";
  const matrix = (body, actions = "", chrome = false) => `<article class="card mx-card${page ? " is-page" : ""}" id="mxCard" style="--span:12">
    <div class="mx-face mx-matrix-face" id="mxMatrixFace">
      <header class="card-head mx-card-head"><h2>聚类矩阵</h2><div class="mx-head-mxt" id="mxHeadMxt" hidden></div>${actions ? `<div class="mx-head-actions">${actions}</div>` : ""}</header>
      ${body}
      ${chrome ? `<section class="mx-daily" id="mxDaily" hidden aria-label="每日 TOP 问题"></section>` : ""}
    </div>
    ${chrome ? `<div class="mx-face mx-kline-face" id="mxKlineFace" hidden>
      <header class="card-head ab-card-head mx-kline-head">
        <h2>问题K线图</h2>
        <div class="ab-head-actions">
          <button type="button" class="icon-btn ab-full" id="klineFull" aria-pressed="false" aria-label="全屏查看问题K线图" title="全屏">
            <svg class="i-abfull-open" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M6 2.5H2.5V6M10 2.5h3.5V6M6 13.5H2.5V10M10 13.5h3.5V10" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
            <svg class="i-abfull-close" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M2.5 6H6V2.5M13.5 6H10V2.5M2.5 10H6v3.5M13.5 10H10v3.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
          <button type="button" class="link ab-close" id="klineClose" aria-label="返回聚类矩阵">← 返回矩阵</button>
        </div>
      </header>
      <div class="mx-panels is-both" id="mxPanels" hidden>
        <section class="mx-issue-trends-shell" id="mxIssueTrends" hidden aria-label="全部问题类型趋势"></section>
        <section class="mx-perspective" id="mxPerspective" hidden aria-label="聚类矩阵问题分析"></section>
      </div>
    </div>` : ""}
    <div class="mx-face mx-ab-face" id="mxABFace" hidden>
      <header class="card-head ab-card-head">
        <h2>A/B Test</h2>
        <div class="ab-rounds" id="abRounds" role="group" aria-label="AB 测试期次"></div>
        <div class="ab-head-actions">
          <button type="button" class="icon-btn ab-full" id="abFull" aria-pressed="false" aria-label="全屏查看 A/B Test" title="全屏">
            <svg class="i-abfull-open" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M6 2.5H2.5V6M10 2.5h3.5V6M6 13.5H2.5V10M10 13.5h3.5V10" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
            <svg class="i-abfull-close" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M2.5 6H6V2.5M13.5 6H10V2.5M2.5 10H6v3.5M13.5 10H10v3.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
          <button type="button" class="link ab-close" id="abClose" aria-label="返回聚类矩阵">← 返回矩阵</button>
        </div>
      </header>
      <div class="ab-body" id="abBody"><div class="empty">正在读取 AB 测试数据…</div></div>
    </div>
  </article>`;
  if (!tax) return matrix(`<div class="empty">缺少聚类体系文件</div>`);
  const sceneRoot = { name: "全部", children: capScenes(sceneTree(p)) };
  const clusterRoot = clusterTree(p, tax);
  if (!sceneRoot.children.length || !clusterRoot.children.length) {
    return matrix(`<div class="empty">暂无聚类数据</div>`);
  }
  return matrix(
    `<div id="mxShell">${matrixTable(matrixView(p, sceneRoot.children, clusterRoot.children))}</div>`,
    `${klineBtn}${abBtn}<button type="button" class="icon-btn mx-full" id="mxFull" aria-pressed="false" aria-label="全屏查看聚类矩阵" title="全屏">
      <svg class="i-mxfull-open" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M6 2.5H2.5V6M10 2.5h3.5V6M6 13.5H2.5V10M10 13.5h3.5V10" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
      <svg class="i-mxfull-close" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M2.5 6H6V2.5M13.5 6H10V2.5M2.5 10H6v3.5M13.5 10H10v3.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </button><button type="button" class="mx-back" id="mxBack" hidden aria-label="返回上一级">← 返回</button>`,
    true,
  );
}

/* ---------------------------------------------------------------- push-pull: one card opens wide, its row mates fold
   Rows keep the 2 + 3 bento. Opening a card widens it (8 of 12 columns) and folds the others in its
   row down to their key numbers; the opened card shows the Traces behind what was picked as a star
   map. The move is FLIP + Web Animations: measure, switch the layout, then play every card from its
   old box to its new one on one spring, so neighbours stay edge to edge the whole way. */
const ROW = { vol: "top", eval: "top", attr: "bottom", clu: "bottom", pred: "bottom" };
const WIDE = "(min-width: 1181px)";
const LAYOUT_EASE = window.CSS && CSS.supports && CSS.supports("transition-timing-function", "linear(0, 1)")
  ? "linear(0, 0.012, 0.047 2.6%, 0.18 5.6%, 0.738 17.3%, 0.928 23.1%, 1.012 28.4%, 1.04 33%, 1.042 37.4%, 1.027 43.7%, 1.003 55.8%, 0.996 66.3%, 1)"
  : "cubic-bezier(0.16, 1, 0.3, 1)";
const RESULT = { correct: "正确", wrong: "错误", mixed: "各版本不一", undetermined: "无法判定", pending: "待揭晓", revealed: "已揭晓" };
const sevIdx = (w) => {
  const i = WORST.indexOf(w);
  return i < 0 ? 5 : i;
};
/* The Traces behind an opened card, worst first, beside its star map: a severity (or result) dot, the
   question and its problem count (or verdict). The head is the slice's size and its severity split. */
const LEDGER_MAX = 120;
const predDot = (it) => (it.r === "correct" ? "var(--accent)" : it.r === "wrong" ? "var(--sev-1)" : it.r === "mixed" ? "var(--sev-3)" : it.r === "pending" ? "var(--muted)" : "var(--faint)");
function ledger(groups, pred, unit = null, rows = null, { count = true, strip = true, size = LEDGER_MAX, page = 0, sum = true } = {}) {
  const all = groups.flatMap((g) => g.items);
  const ordered = pred ? all : [...all].sort((a, b) => a.w - b.w || b.n - a.n || (b.d || "").localeCompare(a.d || ""));
  const pages = Math.max(1, Math.ceil(ordered.length / size));
  const at = Math.max(0, Math.min(pages - 1, page));
  // The summary always speaks about everything found; the list is one page of it.
  const items = rows ?? ordered.slice(at * size, (at + 1) * size);
  const parts = pred
    ? ["correct", "wrong", "mixed", "pending", "undetermined"].map((r) => ({ n: all.filter((it) => (r === "undetermined" ? !["correct", "wrong", "mixed", "pending"].includes(it.r) : it.r === r)).length, c: predDot({ r }) }))
    : WORST.map((_, i) => ({ n: all.filter((it) => it.w === i).length, c: sevColor(i) }));
  const rowHTML = (it, k) =>
    `<button type="button" class="gl-r${pred && !it.s ? " is-inert" : ""}" data-i="${k}" style="--i:${Math.min(k, 14)};--c:${pred ? predDot(it) : sevColor(it.w)}" title="${esc(it.q || "（无提问）")}"><i></i><span>${esc(it.q || "（无提问）")}</span>${count ? `<b class="num">${pred ? esc(RESULT[it.r] || "") : it.n ? fmt(it.n) : "—"}</b>` : ""}</button>`;
  const rowsHtml = items.slice(0, size).map(rowHTML);
  const sumHtml = `<div class="gl-sum"><b class="num">${fmt(all.length)}</b><small>${unit || (pred ? "道预测题" : "条 Trace")}</small>${strip ? `<span class="gl-strip" aria-hidden="true">${parts
    .filter((x) => x.n)
    .map((x) => `<i style="flex:${x.n} 1 0;background:${x.c}"></i>`)
    .join("")}</span>` : ""}</div>`;
  const body = `${sum ? sumHtml : ""}<div class="gx-list">${rowsHtml.join("")}</div>`;
  return { items, all, ordered, parts, pages, page: at, size, rowHTML, sumHtml, body, html: `<div class="gx-side">${body}</div>` };
}
const caseItem = (r) => ({ s: r.s, w: sevIdx(r.w), n: r.n || 0, q: r.q || "", m: r.m, sp: r.sp, d: r.d || "" });
function groupCases(rows, keyOf, nameOf = (k) => k) {
  const by = new Map();
  rows.forEach((r) => {
    const k = keyOf(r);
    if (!by.has(k)) by.set(k, { key: k, name: nameOf(k), items: [] });
    by.get(k).items.push(caseItem(r));
  });
  return [...by.values()];
}

/* The same gx-map / gx-side and ledger used by 数据量, revealed on the sunburst clock. */
function trendSampleDrawer(plot, load, repaint, interaction = {}) {
  const frame = plot.closest(".mxt-samples");
  const layout = $(".mxt-sample-layout", frame);
  const map = $(".gx-map", layout);
  const side = $(".mxt-sample-side", layout);
  let opened = false, token = 0, cancel = () => {};
  const clear = () => {
    [map, side].forEach((el) => { el.style.transform = ""; el.style.transformOrigin = ""; el.style.opacity = ""; });
  };
  const change = (next, animate = true) => {
    if (next === opened) return;
    cancel();
    const before = map.getBoundingClientRect();
    opened = next;
    interaction.onOpenChange?.(next);
    side.hidden = false;
    layout.classList.toggle("is-open", next);
    layout.classList.toggle("is-closing", !next);
    const overlay = frame.clientWidth < 640;
    map.inert = next && overlay;
    if (map.inert) map.setAttribute("aria-hidden", "true");
    else map.removeAttribute("aria-hidden");
    repaint();
    const after = map.getBoundingClientRect();
    const clean = () => {
      clear();
      layout.classList.remove("is-closing");
      side.hidden = !opened;
    };
    const stop = sunburstTween((k) => {
      const progress = next ? k : 1 - k;
      side.style.transform = `translateX(${(1 - progress) * 100}%)`;
      side.style.opacity = String(progress);
      map.style.transformOrigin = "0 50%";
      map.style.transform = overlay
        ? `translateX(${-progress * 100}%)`
        : `scaleX(${1 + (before.width / Math.max(1, after.width) - 1) * (1 - k)})`;
      map.style.opacity = String(overlay ? 1 - progress : 1);
    }, { animate, finish: clean });
    cancel = () => { stop(); clean(); };
  };
  const close = () => {
    token++;
    change(false);
    pickNow = null;
    current = null;
    scanNext = null;
    plot.focus({ preventScroll: true });
  };
  /* 抽屉：抬头只写日期和样本量；列表按 20 条一页，扫描在后台补页。 */
  const head = (pick, count = null) => `<header class="mxt-sample-head">
    <span class="mxt-sample-when num">${esc(pick.when || pick.date)}</span>
    ${count == null ? "" : `<span class="mxt-sample-vol num">量 ${fmt(count)}</span>`}
    <button type="button" class="mx-back" data-samples-close aria-label="返回趋势图">← 返回</button>
  </header>`;
  const PAGE = 20;
  let current = null, page = 0, pageItems = [], scanNext = null, pumping = false, busy = false, pickNow = null;
  const focusKey = () => {
    const el = document.activeElement;
    if (!el || !side.contains(el)) return null;
    if (el.matches("[data-samples-close]")) return "close";
    if (el.matches("[data-sample-page]")) return `page:${el.dataset.samplePage}`;
    if (el.matches(".gl-r")) return `row:${el.dataset.i}`;
    return null;
  };
  const restoreFocus = (key) => {
    if (!key) return;
    const el = key === "close" ? $("[data-samples-close]", side)
      : key.startsWith("page:") ? $(`[data-sample-page="${key.slice(5)}"]`, side)
        : $(`.gl-r[data-i="${key.slice(4)}"]`, side);
    el?.focus({ preventScroll: true });
  };
  const pagesOf = () => Math.max(1, Math.ceil((current?.items.length || 0) / PAGE));
  const loading = () => `<div class="mxt-sample-loading"><div class="empty">正在读取样本…</div>${!busy && current?.canScan ? '<button type="button" class="mx-back" data-sample-scan>继续读取</button>' : ""}</div>`;
  const render = () => {
    if (!current || !pickNow) return;
    const key = focusKey();
    if (!current.items.length) {
      side.innerHTML = `${head(pickNow, current.items.length)}${current.done
        ? `<div class="empty">${esc(current.emptyText || "当前索引中没有匹配样本")}</div>`
        : loading()}`;
      restoreFocus(key);
      return;
    }
    const pages = pagesOf();
    page = Math.max(0, Math.min(pages - 1, page));
    const led = ledger([{ items: current.items }], false, current.unit, current.items.slice(page * PAGE, (page + 1) * PAGE), { count: false, strip: false, sum: false });
    pageItems = led.items;
    const scanning = busy;
    const canNext = page + 1 < pages || (current.canScan && !busy);
    const pager = pages > 1 ? `<div class="mxt-sample-pager">
      <button type="button" data-sample-page="prev" aria-label="上一页"${page === 0 ? " disabled" : ""}>‹</button>
      <span class="mxt-sample-page num">第 <b>${page + 1}</b> / ${pages} 页${scanning ? '<span class="mxt-sample-reading">读取中…</span>' : ""}</span>
      <button type="button" data-sample-page="next" aria-label="下一页"${canNext ? "" : " disabled"}>›</button>
    </div>` : current.canScan && !busy ? '<button type="button" class="mx-back mxt-sample-scan" data-sample-scan>继续读取更多</button>' : "";
    side.innerHTML = `${head(pickNow, current.items.length)}${led.body}${pager}`;
    restoreFocus(key);
  };
  const scan = async () => {
    if (!scanNext || !current?.canScan) return false;
    const snap = await scanNext();
    if (!pickNow) return false;
    current = snap;
    return true;
  };
  /* Bounded scan: at most `chunks` candidate chunks, and stop once `need` rows are in hand. A
     sparse cluster must not drag hundreds of detail requests along just to prefetch one page. */
  const scanChunks = async (chunks, need = Infinity) => {
    if (!scanNext || busy) return;
    busy = true;
    render();
    for (let n = 0; n < chunks && current?.canScan && current.items.length < need; n += 1) {
      if (!(await scan())) break;
      render();
    }
    busy = false;
    render();
  };
  const pump = () => {
    if (pumping || !scanNext) return;
    pumping = true;
    // 预取到当前页的下一页，翻页时基本不用等；再往后的页在用户翻到附近时补。
    scanChunks(3, (page + 2) * PAGE).finally(() => { pumping = false; });
  };
  const flip = async (dir) => {
    if (!current) return;
    if (dir === "prev") {
      if (page > 0) { page -= 1; render(); $(".gx-list", side).scrollTop = 0; }
      return;
    }
    if (page + 1 >= pagesOf() && current.canScan) await scanChunks(8, (page + 2) * PAGE);
    if (page + 1 < pagesOf()) { page += 1; render(); $(".gx-list", side).scrollTop = 0; }
  };
  const openItem = async (item) => {
    // An AB drawer opens the paired compare view; every other drawer stays on 具体数据.
    if (interaction.openItem) { interaction.openItem(item); return; }
    let trace = item.trace;
    if (!trace && item.turn != null) {
      try { trace = (await loadSample(item.s)).attribution?.turns?.[item.turn]?.trace_id; }
      catch { /* The sample page can still open the selected Trace. */ }
    }
    openSamples({ case: item.s, trace: trace || null });
  };
  const open = async (pick) => {
    const stamp = ++token;
    pickNow = pick;
    current = null;
    page = 0;
    pageItems = [];
    scanNext = null;
    side.innerHTML = `${head(pick)}<div class="empty">正在读取样本…</div>`;
    change(true);
    $("[data-samples-close]", side)?.focus({ preventScroll: true });
    try {
      const first = await load(pick);
      if (stamp !== token || !side.isConnected || !opened) return;
      current = first;
      scanNext = typeof first.scanMore === "function" ? first.scanMore : null;
      render();
      pump();
    } catch {
      if (stamp !== token || !side.isConnected || !opened) return;
      side.innerHTML = `${head(pickNow)}<div class="empty">样本读取失败</div><button type="button" class="mx-back" data-samples-retry>重试</button>`;
      $("[data-samples-retry]", side)?.addEventListener("click", () => open(pick));
    }
  };
  side.onclick = async (event) => {
    if (event.target.closest("[data-samples-close]")) { close(); return; }
    if (event.target.closest("[data-sample-scan]")) { await scanChunks(6, (page + 1) * PAGE); return; }
    const flipBtn = event.target.closest("[data-sample-page]");
    if (flipBtn) { await flip(flipBtn.dataset.samplePage); return; }
    const row = event.target.closest(".gl-r");
    const item = row && pageItems[Number(row.dataset.i)];
    if (item) await openItem(item);
  };
  frame.onkeydown = (event) => { if (event.key === "Escape" && opened) { event.preventDefault(); event.stopPropagation(); close(); } };
  return {
    open,
    // A drawer is a split of the same frame: revealing it narrows the map on purpose, so the
    // caller must not treat that resize as a reason to rebuild and close it.
    isOpen: () => opened,
    destroy: () => { token++; cancel(); opened = false; pickNow = null; current = null; scanNext = null; layout.classList.remove("is-open", "is-closing"); side.hidden = true; side.innerHTML = ""; map.inert = false; map.removeAttribute("aria-hidden"); clear(); },
  };
}

/* One chunk of candidates per scan: details arrive in waves, and the first chunk is small enough
   that the drawer has rows to paint well before a whole page of candidates has been read. */
async function loadTrendSamplePage(trend, spec, pick) {
  const product = ctx.product;
  const index = await ctx.loadIndex(product);
  const series = pick.series;
  const candidates = trendSampleCandidates(index.products?.[product]?.rows || [], {
    date: pick.date, node: spec.node, models: series.models, uts: series.uts,
    scenes: !spec.scenes || spec.scenes.size === trend.scenes.length ? null : [...spec.scenes].map((i) => trend.scenes[i]),
  });
  // A session whose worst problem is milder than every selected level cannot match this line;
  // skipping it up-front avoids most of the detail requests for P0–P4 lines.
  const mildest = series.levelAll ? -1 : Math.max(...series.levelIdxs);
  const pool = mildest < 0 ? candidates : candidates.filter((row) => {
    const worst = WORST.indexOf(row.w);
    return worst < 0 || worst <= mildest;
  });
  const state = { items: [], scanned: 0, done: false };
  const total = pool.length;
  const CHUNK = 12;
  const CONCURRENCY = 8;
  const snapshot = () => ({
    items: state.items.slice(), unit: "条 Trace",
    // No candidate at all is not the same as candidates that miss the cluster/levels: say which
    // one happened instead of blaming the index for every empty drawer.
    emptyText: candidates.length ? "候选样本没有命中该簇的问题" : "",
    done: state.done, canScan: !state.done && state.scanned < total && state.items.length < LEDGER_MAX,
  });
  const scanMore = async () => {
    if (state.done || state.scanned >= total || state.items.length >= LEDGER_MAX) {
      state.done = true;
      return snapshot();
    }
    const batch = pool.slice(state.scanned, state.scanned + CHUNK);
    state.scanned += batch.length;
    for (let start = 0; start < batch.length; start += CONCURRENCY) {
      const results = await Promise.allSettled(batch.slice(start, start + CONCURRENCY).map(async (row) => {
        const detail = await loadSample(row.s);
        const problems = trendSampleProblems(detail, spec.node, series.levelIdxs.map((i) => TREND_SEV[i]));
        if (!problems.length) return null;
        return { ...caseItem(row), n: problems.length, w: Math.min(...problems.map((problem) => sevIdx(problem.sev))) };
      }));
      results.forEach((result) => { if (result.status === "fulfilled" && result.value) state.items.push(result.value); });
      if (state.items.length >= LEDGER_MAX) break;
    }
    if (state.scanned >= total || state.items.length >= LEDGER_MAX) state.done = true;
    return snapshot();
  };
  await scanMore();
  return { ...snapshot(), scanMore };
}

async function loadTraceSamplePage(trend, pick) {
  const product = ctx.product;
  const refs = traceSampleRefs(trend, pick.date, pick.series.level);
  const index = await ctx.loadIndex(product);
  const bySlug = new Map((index.products?.[product]?.rows || []).map((row) => [row.s, row]));
  const items = refs.map(([, slug, turn, level, trace]) => {
    const row = bySlug.get(slug);
    return row ? { ...caseItem(row), w: level, trace, turn, n: 0, q: `${row.q || "（无提问）"} · 第 ${turn + 1} 轮` } : null;
  }).filter(Boolean);
  return { items, unit: "条 Trace", done: true, canScan: false, scanMore: null };
}

async function loadABTrendSamplePage(spec, pick) {
  const { round, sides } = pick.series.samples[pick.index];
  if (!round.sample_refs) return { items: [], emptyText: "当前快照缺少 A/B 样本关联" };
  const refs = abTrendSampleRefs(round, sides, spec.row, spec.node);
  const index = await ctx.loadIndex(ctx.product);
  const rows = index.products?.[ctx.product]?.rows || [];
  const { items } = resolveABSamples(refs, rows, spec.node);
  return {
    items: items.map(({ row, trace, n, ref }) => ({ ...caseItem(row), trace, n, ref, pair: ref.pair || ref.trace, round: spec.round?.id })), unit: "个样本",
    // An empty drawer must name the real reason: this side of the batch has no hit here, or the
    // hits exist but have no detail to open — never "no samples in the index" for AB data.
    emptyText: refs.length ? "这些样本暂无可打开的评测详情" : "该批次这一格没有命中样本",
    done: true, canScan: false, scanMore: null,
  };
}

/* A K-line whose candles open the shared sample drawer. The chart follows its host's width on its
   own (ResizeObserver), so opening or closing the drawer needs no redraw. */
function mountSampleTrend(plot, makeChart, load, interaction = {}) {
  const drawer = trendSampleDrawer(plot, load, () => {}, interaction);
  const chart = makeChart(plot, (pick) => drawer.open(pick));
  return {
    destroy: () => { chart.destroy(); drawer.destroy(); },
    // Recall a source the chart may not draw as its own point (e.g. online samples while the
    // matrix shows the paired change). The pick's series carries the sides to load.
    openPick: (pick) => drawer.open(pick),
  };
}

function mountABCellTrend(plot, spec) {
  const makeChart = (host, onPick) => createKlineChart(host, {
    ...spec.kline,
    onPick: (candle) => {
      const sample = spec.picks.get(String(candle.time));
      if (sample) onPick({ date: String(candle.time), series: { samples: [sample] }, index: 0 });
    },
  });
  return mountSampleTrend(plot, makeChart, (pick) => loadABTrendSamplePage(spec, pick), {
    openItem: (item) => {
      if (item.ref?.side === "online") openCompare({ online: item.ref.slug, round: item.round });
      else openCompare({ pair: item.pair, round: item.round });
    },
  });
}

function pushPull(bento, p, tax, u) {
  u.deep = u.deep || { top: null, bottom: null };
  const cardOf = (k) => $(`[data-card="${k}"]`, bento);
  const rings = {};
  const maps = {};
  let booting = true;
  const versionKey = (sp, m) => (p.unified ? m : `${sp || ""}|${m}`);
  const versionName = (k) => {
    const [sp, m] = p.unified ? ["", k] : k.split("|");
    return groupName(p, { split: sp, model: m });
  };
  /* A card only has a deep state while there is something behind it to open: empty cards keep
     their default size instead of pushing a row mate into a star map with no stars. */
  const openable = {
    vol: () => (p.field || []).some((g) => (g.cells || []).length),
    eval: () => evalRows(p).some((r) => (r.evaluated || 0) > 0),
    attr: () => (p.roles || []).some((r) => r.problems),
    clu: () => !!(tax && (p.kpi.clustered || 0) > 0),
    pred: () => !!p.prediction && ((p.prediction.items || []).length > 0),
  };

  function relayout(mutate) {
    const cards = $$(":scope > .card", bento);
    const before = new Map(cards.map((c) => [c, c.getBoundingClientRect()]));
    mutate();
    if (booting || REDUCED || ctx.refresh || !matchMedia(WIDE).matches) return;
    cards.forEach((c) => {
      const a = before.get(c);
      const b = c.getBoundingClientRect();
      if (Math.abs(a.left - b.left) < 0.5 && Math.abs(a.width - b.width) < 0.5) return;
      c.getAnimations().forEach((x) => x.cancel());
      c.animate(
        [{ transform: `translateX(${a.left - b.left}px)`, width: `${a.width}px` }, { transform: "none", width: `${b.width}px` }],
        { duration: 680, easing: LAYOUT_EASE },
      );
    });
  }

  function apply(row) {
    const spec = u.deep[row];
    const keys = Object.keys(ROW).filter((k) => ROW[k] === row);
    relayout(() => {
      if (spec) bento.dataset[row] = spec.card;
      else delete bento.dataset[row];
      keys.forEach((k) => {
        const c = cardOf(k);
        if (!c) return;
        const deep = !!spec && spec.card === k;
        const compact = !!spec && !deep;
        const folding = compact && !c.classList.contains("is-compact");
        c.classList.toggle("is-deep", deep);
        c.classList.toggle("is-compact", compact);
        // The head button is the one visible way back for every card; folded mates stay clickable.
        const btn = $(".card-state", c);
        if (btn) btn.hidden = !deep;
        if (folding) runCounters($(".compact", c));
        if (compact) {
          c.tabIndex = 0;
          c.setAttribute("role", "button");
          c.setAttribute("aria-label", "恢复本行卡片");
        } else {
          c.removeAttribute("tabindex");
          c.removeAttribute("role");
          c.removeAttribute("aria-label");
        }
      });
    });
    keys.forEach((k) => {
      const gx = cardOf(k) && $(".gx", cardOf(k));
      if (!gx) return;
      if (spec && spec.card === k) {
        gx.hidden = false;
        paintGalaxy(k, gx, spec);
      } else {
        gx.hidden = true;
        if (maps[k]) maps[k].map.destroy();
        maps[k] = null;
        gx.innerHTML = "";
      }
    });
    markTriggers();
  }

  function open(spec) {
    if (!openable[spec.card] || !openable[spec.card]()) return;
    const row = ROW[spec.card];
    const cur = u.deep[row];
    // A ring that is still at its innermost level would disagree with a sibling taking the row.
    Object.entries(rings).forEach(([k, ring]) => k !== spec.card && ROW[k] === row && cur && cur.card === k && ring.up());
    u.deep[row] = spec;
    apply(row);
  }

  function close(row) {
    const cur = u.deep[row];
    if (!cur) return;
    if (rings[cur.card] && (cur.card !== "pred" || cur.kind === "class")) return rings[cur.card].up(); // the ring reports back through fromRing
    u.deep[row] = null;
    apply(row);
  }

  function toggle(spec) {
    const cur = u.deep[ROW[spec.card]];
    if (cur && cur.id === spec.id) close(ROW[spec.card]);
    else open(spec);
  }

  /* Rings open their card at the innermost level: a focus whose children are all leaves, or a leaf
     picked under a non-root focus. */
  function fromRing(card, focus, opened) {
    const row = ROW[card];
    const spec = card === "vol" ? volSpec(focus, opened) : card === "pred" ? predSpec(focus, opened) : cluSpec(focus, opened);
    const cur = u.deep[row];
    if (spec && openable[card] && openable[card]()) {
      // Same spec on a live board: only the highlight moved. While booting the DOM is new, so apply.
      if (cur && cur.id === spec.id && !booting) {
        cur.focus = spec.focus;
        if (maps[card] && maps[card].id === spec.id) maps[card].map.focus(spec.focus);
        return;
      }
      u.deep[row] = spec;
      apply(row);
    } else if (spec) {
      return; // nothing behind the drill: leave the row as it is
    } else if (cur && cur.card === card && (card !== "pred" || cur.kind === "class")) {
      u.deep[row] = null;
      apply(row);
    }
  }

  const innermost = (focus, opened) => {
    if (!focus.parent) return null;
    const kids = focus.children || [];
    if (kids.length && kids.every((c) => !c.children)) return focus;
    return opened && !opened.children ? opened : null;
  };

  function volSpec(focus, opened) {
    const at = innermost(focus, opened);
    if (!at || at.ev === 0) return null;
    const chain = [];
    for (let n = at; n; n = n.parent) chain.unshift(n);
    const models = !!(p.input && p.input.models && Object.keys(p.input.models).length);
    const model = models ? (chain[1] && chain[1].id.split("/")[1]) : null;
    const task = chain[models ? 2 : 1] || null;
    return {
      card: "vol", id: `vol|${model || ""}|${task ? task.id : ""}`, model,
      task: task && !task.other ? task.name : null,
      others: task && task.other ? (task.parent.children || []).filter((c) => !c.other).map((c) => c.name) : null,
      focus: at === focus && opened ? opened.name : null,
    };
  }

  /* The 题量 ring is 标的类别 → 题型: a class opens its star map, a type focuses that cluster. */
  function predSpec(focus, opened) {
    const at = innermost(focus, opened);
    if (!at || at.other) return null;
    const cls = at.parent && at.parent.parent ? at.parent : at;
    if (cls.other) return null;
    return {
      card: "pred", id: `pred|k|${cls.name}`, kind: "class", key: cls.name,
      focus: at !== cls ? at.name : at === focus && opened && !opened.other ? opened.name : null,
    };
  }

  function cluSpec(focus, opened) {
    const at = innermost(focus, opened);
    if (!at || at.other || !at.id.includes(".")) return null;
    const prefix = at.id.slice(2);
    const kids = at === focus ? (focus.children || []).filter((c) => !c.other).map((c) => ({ key: c.id.slice(2), name: c.name })) : [];
    return { card: "clu", id: `clu|${prefix}`, prefix, kids, focus: at === focus && opened ? opened.id.slice(2) : null };
  }

  async function rows() {
    const index = await ctx.loadIndex(ctx.product);
    return ((index.products || {})[ctx.product] || {}).rows || [];
  }
  const sceneKey = (r) => r.sub || r.sc || r.task || "未接入分类体系";

  async function groupsFor(spec) {
    if (spec.card === "pred") {
      const items = ((p.prediction || {}).items || []).filter((it) =>
        spec.kind === "model" ? it.v === spec.key : spec.kind === "cause" ? it.e === spec.key
          : spec.kind === "class" ? (it.c || "其他") === spec.key
          : spec.kind === "cv" ? (spec.cls === "全部" || (it.c || "其他") === spec.cls) && (!spec.ver || it.v === spec.ver) : true);
      // Clusters are the 标的类别; inside one class they are the question type.
      const groupOf = spec.kind === "class" || (spec.kind === "cv" && spec.cls !== "全部") ? (it) => it.t : (it) => it.c || "其他";
      // One star per question; its versions' answers ride along for the tooltip.
      const qs = new Map();
      items.forEach((it) => {
        const k = qkey(it);
        if (!qs.has(k)) qs.set(k, { i: it.i, q: it.q, c: it.c, t: it.t, d: it.d, vers: [] });
        qs.get(k).vers.push({ v: it.v, r: it.r, e: it.e, s: it.s });
      });
      const by = new Map();
      qs.forEach((g) => {
        const rs = g.vers.map((x) => x.r);
        const pick = g.vers.find((x) => x.r === "wrong" && x.s) || g.vers.find((x) => x.s) || {};
        const it = { ...g, r: rs.every((x) => x === rs[0]) ? rs[0] : "mixed", s: pick.s, f: undefined };
        const key = groupOf(it);
        if (!by.has(key)) by.set(key, { key, name: key, items: [] });
        by.get(key).items.push({ ...it, inert: !it.s, n: 0 });
      });
      return [...by.values()];
    }
    const all = await rows();
    if (spec.card === "vol") {
      const picked = all.filter((r) => (!spec.model || r.m === spec.model) &&
        (spec.task ? (r.task || "未接入分类体系") === spec.task : spec.others ? !spec.others.includes(r.task || "未接入分类体系") : true));
      return groupCases(picked, spec.task || spec.others ? sceneKey : (r) => r.task || r.sc || "未接入分类体系");
    }
    if (spec.card === "eval") {
      const picked = all.filter((r) => r.d >= spec.d0 && r.d <= spec.d1 && (spec.model === "all" || r.m === spec.model));
      return groupCases(picked, (r) => versionKey(r.sp, r.m), versionName);
    }
    if (spec.card === "attr") {
      if (spec.role) return groupCases(all.filter((r) => (r.r || []).includes(spec.role)), (r) => versionKey(r.sp, r.m), versionName);
      const role = (id) => (p.roles.find((x) => x.id === id) || { label: id }).label;
      return groupCases(all.filter((r) => versionKey(r.sp, r.m) === spec.version && (r.r || []).length), (r) => r.r[0], role);
    }
    if (spec.card === "clu") {
      const hit = (r) => (r.pt || []).some((x) => x === spec.prefix || x.startsWith(`${spec.prefix}.`));
      const kidOf = (r) => {
        const k = spec.kids.find((c) => (r.pt || []).some((x) => x === c.key || x.startsWith(`${c.key}.`)));
        return k ? k.key : spec.kids.length ? "~" : spec.prefix;
      };
      const names = new Map(spec.kids.map((c) => [c.key, c.name]));
      return groupCases(all.filter(hit), kidOf, (k) => names.get(k) || (k === "~" ? "其他" : patName(tax, k)));
    }
    return [];
  }

  const caseTip = (it) => `<div class="t-head">${esc(it.q || "（无提问）")}</div>
    <div class="t-row"><span class="sev" style="--c:${sevColor(it.w)}"><i></i>${SEV_NAME[WORST[it.w]]}</span><span>${esc(modelName(p, it.m))} · ${esc((it.d || "").slice(5))}</span><b class="num">${it.n ? `${fmt(it.n)} 个问题` : "无问题"}</b></div>`;
  const predTip = (it) => `<div class="t-head">${esc(it.q || "")}</div>
    <div class="t-row"><span>${esc(it.c || "其他")} · ${esc(it.t || "")}${it.d ? ` · ${esc(String(it.d).slice(5))}` : ""}</span></div>
    ${(it.vers || []).map((x) => `<div class="t-row"><span>${esc(modelName(p, x.v))}</span>${x.e ? `<span class="dim">${esc(x.e)}</span>` : ""}<b>${esc(RESULT[x.r] || x.r || "")}</b></div>`).join("")}`;
  const predColor = (it, c) => (it.r === "correct" ? c.accent : it.r === "wrong" ? c.sev[1] : it.r === "mixed" ? c.sev[3] : it.r === "pending" ? c.muted : c.faint);

  async function paintGalaxy(k, gx, spec) {
    if (maps[k] && maps[k].id === spec.id) return maps[k].map.focus(spec.focus);
    const token = (gx._token = (gx._token || 0) + 1);
    if (maps[k]) maps[k].map.destroy();
    maps[k] = null;
    gx.innerHTML = `<div class="gx-wait" aria-hidden="true"></div>`;
    let groups = [];
    try {
      groups = await groupsFor(spec);
    } catch (err) {
      console.error(err);
    }
    if (gx._token !== token || gx.hidden) return;
    if (!groups.some((g) => g.items.length)) {
      gx.innerHTML = `<div class="empty">暂无已评测的 Trace</div>`;
      return;
    }
    const pred = spec.card === "pred";
    // The star map still reads the whole slice; the Trace list beside it is paged so a 20k-Trace
    // selection only puts one page of rows in the DOM (and the page is reachable without a cap).
    const GX_PAGE = 40;
    let page = 0;
    const pagerHTML = (n) => (n <= 1 ? "" : `<div class="gx-pager mxt-sample-pager" role="group" aria-label="Trace 分页">
      <button type="button" data-gxpage="prev" aria-label="上一页"${page === 0 ? " disabled" : ""}>‹</button>
      <span class="mxt-sample-page num">第 <b>${page + 1}</b> / ${n} 页</span>
      <button type="button" data-gxpage="next" aria-label="下一页"${page === n - 1 ? " disabled" : ""}>›</button>
    </div>`);
    let led = ledger(groups, pred, null, null, { size: GX_PAGE, page });
    gx.innerHTML = `<div class="gx-in"><div class="gx-map"></div><div class="gx-side">${led.sumHtml}<div class="gx-list"></div><div class="gx-pager-slot"></div></div></div>`;
    const side = $(".gx-side", gx);
    let list = $(".gx-list", side);
    let rowOf = new Map();
    let lit = null;
    const paintPage = (next) => {
      led = ledger(groups, pred, null, null, { size: GX_PAGE, page: next });
      page = led.page;
      list.innerHTML = led.items.map(led.rowHTML).join("");
      rowOf = new Map(led.items.map((it, i) => [it, i]));
      lit = null;
      $(".gx-pager-slot", side).innerHTML = pagerHTML(led.pages);
      list.scrollTop = 0;
    };
    paintPage(0);
    // A star under the pointer lights its row, scrolling the ledger only when the row is out of view.
    const light = (it) => {
      if (lit) lit.classList.remove("is-hl");
      lit = it && rowOf.has(it) ? list.children[rowOf.get(it)] : null;
      if (!lit) return;
      lit.classList.add("is-hl");
      const top = lit.offsetTop;
      if (top < list.scrollTop || top + lit.offsetHeight > list.scrollTop + list.clientHeight) {
        list.scrollTo({ top: top - (list.clientHeight - lit.offsetHeight) / 2, behavior: REDUCED ? "auto" : "smooth" });
      }
    };
    const map = galaxy($(".gx-map", gx), groups, {
      focus: spec.focus,
      tip: pred ? predTip : caseTip,
      colorOf: pred ? predColor : null,
      onPick: (it) => (pred ? openForecast(it.s) : openSamples({ case: it.s })),
      onHover: light,
    });
    const rowItem = (e) => {
      const r = e.target.closest(".gl-r");
      return r ? led.items[Number(r.dataset.i)] : null;
    };
    side.addEventListener("pointermove", (e) => {
      const it = rowItem(e);
      if (!it) return;
      map.mark(it);
      showTip((pred ? predTip : caseTip)(it), e.clientX, e.clientY);
    });
    side.addEventListener("pointerleave", () => {
      map.mark(null);
      hideTip();
    });
    side.addEventListener("click", (e) => {
      const flip = e.target.closest("[data-gxpage]");
      if (flip) {
        paintPage(flip.dataset.gxpage === "prev" ? page - 1 : page + 1);
        return;
      }
      const it = rowItem(e);
      if (it) pred ? openForecast(it.s) : openSamples({ case: it.s });
    });
    maps[k] = { id: spec.id, map };
  }

  function markTriggers() {
    const t = u.deep.top;
    $$("#evChart .evday", bento).forEach((d) => d.classList.toggle("is-on", !!t && t.card === "eval" && d.dataset.d0 === t.d0));
    const b = u.deep.bottom && u.deep.bottom.card === "attr" ? u.deep.bottom : null;
    $$('[data-card="attr"] .sk-node', bento).forEach((n) =>
      n.classList.toggle("is-pick", !!b && (b.role ? n.dataset.r === b.role : n.dataset.g === b.gi)));
    $$('[data-card="attr"] .sankey', bento).forEach((sv) => sv.classList.toggle("is-picked", !!b));
    $$('[data-card="attr"] .sk-f', bento).forEach((f) =>
      f.classList.toggle("is-pick", !!b && (b.role ? f.dataset.r === b.role : f.dataset.g === b.gi)));
    const pr = u.deep.bottom && u.deep.bottom.card === "pred" ? u.deep.bottom : null;
    $$('[data-card="pred"] [data-pm]', bento).forEach((n) => n.classList.toggle("is-pick", !!pr && pr.kind === "model" && n.dataset.pm === pr.key));
  }

  bento.addEventListener("click", (e) => {
    const shut = e.target.closest("[data-collapse]");
    if (shut) {
      close(ROW[shut.closest(".card").dataset.card]);
      return;
    }
    const folded = e.target.closest(".card.is-compact");
    if (folded && matchMedia(WIDE).matches) {
      close(ROW[folded.dataset.card]);
      return;
    }
    if (e.target.closest("#evYearBack")) {
      EV.year = null;
      close(ROW.eval);
      repaintEvalCard(bento, p);
      return;
    }
    const day = e.target.closest('[data-card="eval"] .evday');
    if (day) {
      // 年份柱是下钻入口（点它看这一年的月份），月份/日柱才是打开当天。
      if (day.dataset.year) {
        EV.year = day.dataset.year;
        close(ROW.eval);
        repaintEvalCard(bento, p);
        return;
      }
      toggle({ card: "eval", id: `eval|${day.dataset.d0}|${day.dataset.d1}|${EV.model}`, d0: day.dataset.d0, d1: day.dataset.d1, model: EV.model });
      return;
    }
    const sk = e.target.closest('[data-card="attr"] .sankey [data-g], [data-card="attr"] .sankey [data-r]');
    if (sk) {
      // Left keys are p.field indexes (one per version); right keys are component roles.
      const gi = sk.dataset.g != null ? sk.dataset.g : null;
      const g = gi != null ? p.field[Number(gi)] : null;
      const vkey = g ? versionKey(g.split, g.model) : null;
      if (sk.dataset.r) toggle({ card: "attr", id: `attr|${sk.dataset.r}`, role: sk.dataset.r, focus: vkey });
      else if (vkey) toggle({ card: "attr", id: `attr|v|${vkey}`, version: vkey, gi });
      return;
    }
    const pm = e.target.closest('[data-card="pred"] [data-pm]');
    if (pm) {
      toggle({ card: "pred", id: `pred|m|${pm.dataset.pm}`, kind: "model", key: pm.dataset.pm });
      return;
    }
    const pk = e.target.closest('[data-card="pred"] .pred-sk [data-g], [data-card="pred"] .pred-sk [data-r]');
    if (pk) {
      const at = (p.prediction.attribution || {}).errors || [];
      if (pk.dataset.r != null) toggle({ card: "pred", id: `pred|c|${pk.dataset.r}`, kind: "cause", key: at[Number(pk.dataset.r)] });
      else toggle({ card: "pred", id: `pred|m|${pk.dataset.g}`, kind: "model", key: pk.dataset.g });
      return;
    }
    const pc = e.target.closest('[data-card="pred"] [data-cv]');
    if (pc) {
      const [cls, ver] = pc.dataset.cv.split("|");
      toggle({ card: "pred", id: `pred|cv|${pc.dataset.cv}`, kind: "cv", cls, ver: ver === "*" ? null : ver });
      return;
    }
  });
  // A folded mate is a real button for the keyboard too: Enter / Space brings the row back.
  bento.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const folded = e.target.closest(".card.is-compact");
    if (!folded) return;
    e.preventDefault();
    close(ROW[folded.dataset.card]);
  });

  return {
    rings,
    fromRing,
    start() {
      // Restore what the reader had open (rings report themselves while they are built).
      ["top", "bottom"].forEach((row) => {
        const spec = u.deep[row];
        if (spec && !rings[spec.card]) apply(row);
        else if (!spec) apply(row);
      });
      booting = false;
    },
    closeEval() {
      if (u.deep.top && u.deep.top.card === "eval") close("top");
    },
  };
}

/* ---------------------------------------------------------------- interaction */
function wire(bento, p, tax, u) {
  const push = pushPull(bento, p, tax, u);
  const field = $("#field", bento);
  field._page = u.field.pages;
  paintField(field, p, u.field.w);
  setTimeout(() => field.classList.remove("is-intro"), REDUCED || ctx.refresh ? 0 : 1600);
  const legend = $("#fieldLegend", bento);
  legend.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    const on = b.getAttribute("aria-pressed") !== "true";
    $$("button", legend).forEach((x) => x.setAttribute("aria-pressed", String(on && x === b)));
    u.field.w = on ? b.dataset.w : null;
    field.classList.toggle("is-filtered", on);
    $$(".tiles span", field).forEach((t) => t.classList.toggle("on", on && t.dataset.w === b.dataset.w));
  });
  field.addEventListener("click", (e) => {
    const tile = e.target.closest(".tiles span[data-cell]");
    if (tile) {
      const [g, i] = tile.dataset.cell.split(":").map(Number);
      const c = p.field[g] && p.field[g].cells[i];
      if (c) openSamples({ case: c[0] });
      return;
    }
    const b = e.target.closest(".field-pager button[data-page]");
    if (!b) return;
    const pager = b.closest(".field-pager");
    const gi = Number(pager.dataset.pager);
    const cur = Number(pager.dataset.page);
    const pages = Number(pager.dataset.pages);
    const key = b.dataset.page;
    field._page[gi] = key === "prev" ? Math.max(1, cur - 1) : Math.min(pages, cur + 1);
    paintField(field, p, u.field.w);
  });
  if (window.ResizeObserver) {
    let fieldW = field.clientWidth;
    const fieldRo = new ResizeObserver(() => {
      if (!field.isConnected) { fieldRo.disconnect(); return; }
      if (Math.abs(field.clientWidth - fieldW) < 2) return;
      fieldW = field.clientWidth;
      field._page = u.field.pages = [];
      paintField(field, p, u.field.w);
    });
    fieldRo.observe(field);
  }
  const tabs = $("#predTab", bento);
  if (tabs) {
    const show = (v) => $$(".pred-pane", bento).forEach((x) => x.classList.toggle("is-on", x.dataset.pane === v));
    const seg = segmented(tabs, (v) => {
      u.pred = v;
      show(v);
    });
    seg.set(u.pred, { silent: true });
    show(seg.get());
  }

  const evDetail = $("#evDetail", bento);
  if (evDetail) evDetail.addEventListener("click", () => ctx.navigate({ detail: "eval" }));

  const evRange = $("#evRange", bento);
  const evModel = $("#evModel", bento);
  if (evRange && evModel) {
    // A new window or model invalidates the picked day's star map; a new window also
    // drops the year drill (it belongs to 「全部」).
    const range = segmented(evRange, (v) => { EV.range = v; EV.year = null; push.closeEval(); repaintEvalCard(bento, p); });
    const model = segmented(evModel, (v) => { EV.model = v; push.closeEval(); repaintEvalCard(bento, p); });
    range.set(EV.range, { silent: true });
    model.set(EV.model, { silent: true });
  }

  // Matrix: two axes walk their own trees and the whole table is redrawn in place.
  // Rows: task → subtask (long task lists fold into 其他场景). Columns: stage → mechanism → pattern.
  const shell = $("#mxShell", bento);
  let mxView = null;
  let setKlinePanelsOpen = () => {};
  if (shell && tax) {
    /* 聚类矩阵全屏：卡片离开 bento 铺满视口，Esc 或同一枚键回到原位。 */
    const mxCardEl = shell.closest(".mx-card");
    const mxFullBtn = $("#mxFull", bento);
    const setMxFull = (on, animate = true) => {
      u.mx.full = on;
      if (!mxCardEl || mxCardEl.classList.contains("is-mx-full") === on) return;
      const first = animate && !REDUCED ? mxCardEl.getBoundingClientRect() : null;
      mxCardEl.classList.toggle("is-mx-full", on);
      document.body.classList.toggle("is-mx-full", on);
      // The fullscreen card is wider than the bento card, so the table zooms before the FLIP
      // measures its destination box.
      fitMatrix(mxCardEl.querySelector(".matrix"));
      if (mxFullBtn) {
        const label = on ? "退出全屏" : "全屏查看聚类矩阵";
        mxFullBtn.setAttribute("aria-pressed", String(on));
        mxFullBtn.setAttribute("aria-label", label);
        mxFullBtn.title = on ? "退出全屏" : "全屏";
      }
      if (!first) return;
      const last = mxCardEl.getBoundingClientRect();
      mxCardEl.animate([
        { transform: `translate(${first.left - last.left}px, ${first.top - last.top}px) scale(${first.width / Math.max(1, last.width)}, ${first.height / Math.max(1, last.height)})`, transformOrigin: "0 0" },
        { transform: "none" },
      ], { duration: 360, easing: "cubic-bezier(0.16, 1, 0.3, 1)" });
    };
    const onMxFullKey = (event) => {
      if (event.key !== "Escape" || !u.mx.full || !mxCardEl?.isConnected) return;
      if (mxCardEl.querySelector(".mxt-sample-layout.is-open")) return;
      setMxFull(false);
    };
    if (mxDocKey) document.removeEventListener("keydown", mxDocKey);
    mxDocKey = onMxFullKey;
    document.addEventListener("keydown", mxDocKey);
    mxFullBtn?.addEventListener("click", () => setMxFull(!u.mx.full));
    if (u.mx.full) setMxFull(true, false);
    /* 全屏卡自己就是滚动容器；指针停在矩阵上时，部分浏览器不会把竖向滚轮链到它。
       这里显式滚动卡片，同时让样本列表这类真正可竖向滚动的子元素优先。 */
    const onMxWheel = (event) => {
      if (event.defaultPrevented || !u.mx.full || event.ctrlKey || event.metaKey || event.shiftKey || event.deltaX) return;
      if (!event.deltaY) return;
      let node = event.target;
      while (node && node !== mxCardEl) {
        const style = getComputedStyle(node);
        if ((style.overflowY === "auto" || style.overflowY === "scroll") && node.scrollHeight > node.clientHeight + 1) return;
        node = node.parentElement;
      }
      const max = mxCardEl.scrollHeight - mxCardEl.clientHeight;
      if (max <= 0) return;
      const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
      event.preventDefault();
      mxCardEl.scrollTop = Math.max(0, Math.min(max, mxCardEl.scrollTop + delta));
    };
    mxCardEl?.addEventListener("wheel", onMxWheel, { passive: false });
    const sceneRoot = { name: "全部", children: capScenes(sceneTree(p)) };
    const clusterRoot = clusterTree(p, tax);
    // Paths are kept as names / prefixes so they can be walked again on a fresh tree.
    const walk = (rootNode, keys, keyOf) => {
      const path = [rootNode];
      for (const k of keys) {
        const next = (path[path.length - 1].children || []).find((n) => keyOf(n) === k);
        if (!next) break;
        path.push(next);
      }
      return path;
    };
    const rowKey = (n) => n.name;
    const colKey = (n) => n.prefix || n.name;
    let rowPath = walk(sceneRoot, u.mx.rows, rowKey);
    let colPath = walk(clusterRoot, u.mx.cols, colKey);
    let trail = u.mx.trail.filter((a) => (a === "r" ? rowPath.length > 1 : colPath.length > 1));
    let mxKey = "";
    const remember = () => {
      u.mx.rows = rowPath.slice(1).map(rowKey);
      u.mx.cols = colPath.slice(1).map(colKey);
      u.mx.trail = trail.slice();
    };
    const paint = (animate = true, source = null) => {
      const rowNode = rowPath[rowPath.length - 1];
      const colNode = colPath[colPath.length - 1];
      const view = matrixView(p, rowNode.children || [], colNode.children || []);
      // Once a problem cluster is selected, keep only scenes that actually carry it.
      if (colPath.length > 1) {
        const rows = [], cells = [];
        view.rows.forEach((r, i) => {
          if (sum(view.cells[i].map((x) => x.n))) {
            rows.push(r);
            cells.push(view.cells[i]);
          }
        });
        view.rows = rows;
        view.cells = cells;
      }
      mxView = view;
      mxKey = "";
      remember();
      swapShell(shell, matrixTable(mxView), animate, source, () => { if (!trend.open) setDailyOpen(true); });
      const back = $("#mxBack", bento);
      if (back) {
        back.textContent = "← 返回上一级";
        back.hidden = rowPath.length === 1 && colPath.length === 1;
      }
      renderPerspective(undefined, false);
    };
    const activeMatrix = () => shell.querySelector(".matrix:last-of-type");
    const clearHover = () => {
      if (!mxKey) return;
      mxKey = "";
      const m = activeMatrix();
      if (!m) return;
      $$(".is-hl, .is-cur", m).forEach((x) => x.classList.remove("is-hl", "is-cur"));
    };
    const hover = (ri, ci) => {
      const key = `${ri}:${ci}`;
      if (key === mxKey) return;
      mxKey = key;
      const m = activeMatrix();
      if (!m) return;
      $(".cell.is-cur", m)?.classList.remove("is-cur");
      $(`.cell[data-mx="${ri}:${ci}"]`, m)?.classList.add("is-cur");
      $$(".rh", m).forEach((h, i) => h.classList.toggle("is-hl", i === ri));
      $$(".mh", m).forEach((h, i) => h.classList.toggle("is-hl", i === ci));
      $$(".rowtot", m).forEach((h, i) => h.classList.toggle("is-hl", i === ri));
      $$(".coltot", m).forEach((h, i) => h.classList.toggle("is-hl", i === ci));
    };
    shell.addEventListener("pointerover", (e) => {
      // The table under the pointer is being replaced, or a trend view took its place.
      if (trend.open || shell.classList.contains("is-swapping")) return;
      const cell = e.target.closest(".cell[data-mx]");
      if (cell) {
        // An empty cell is a gap in the heat map, not a row/column to read.
        if (cell.classList.contains("is-empty")) return clearHover();
        const [ri, ci] = cell.dataset.mx.split(":").map(Number);
        return hover(ri, ci);
      }
      const rh = e.target.closest(".rh");
      if (rh) return hover($$(".rh", shell).indexOf(rh), -1);
      const mh = e.target.closest(".mh");
      if (mh) return hover(-1, $$(".mh", shell).indexOf(mh));
    });
    shell.addEventListener("pointerleave", clearHover);
    // Keep the column pane's edge fade honest while it scrolls (scroll events do not bubble).
    shell.addEventListener("scroll", (e) => {
      const pane = e.target;
      if (!pane.classList || !pane.classList.contains("mx-scroll")) return;
      pane.classList.toggle("is-at-end", pane.scrollLeft + pane.clientWidth >= pane.scrollWidth - 2);
    }, true);
    // Column titles are kept on one line by sizing the scroll pane; refit whenever the card resizes.
    fitMatrix(shell.querySelector(".matrix"));
    if (window.ResizeObserver) {
      const shellRo = new ResizeObserver(() => {
        if (!shell.isConnected) { shellRo.disconnect(); return; }
        const m = shell.querySelector(".matrix:last-of-type");
        if (m && !shell.classList.contains("is-swapping")) fitMatrix(m);
      });
      shellRo.observe(shell);
    }

    /* ---- 格子的就地趋势：同一个 shell 里把表换成图，返回时按原来的行列路径重画矩阵 ---- */
    u.mx.trend = u.mx.trend || { open: false, measure: "count", scope: "row", lines: [], active: 0, seeded: false, zoom: false };
    const trend = u.mx.trend;
    let trendToken = 0;
    const trendTitle = (row, node) => `${row.name} · ${patName(tax, node) || node} 的时间趋势`;
    const trendSpec = (row) => ({
      node: trend.node,
      rowName: row ? row.name : "",
      // 「全部场景」看整个产品在这个聚类上的问题率，不按点进来的那一行过滤。
      scope: trend.scope === "all" ? "all" : "row",
      scenes: trendScenes(trendData, row, trend.scope === "all" ? "all" : "row"),
      measure: trend.measure, range: "all", zoom: !!trend.zoom,
      lines: trend.lines, active: trend.active,
    });
    let trendData = null;
    const dailyEl = $("#mxDaily", bento);
    const perspectiveEl = $("#mxPerspective", bento);
    const issueEl = $("#mxIssueTrends", bento);
    const panelsEl = $("#mxPanels", bento);
    /* 每日 TOP 问题面板常驻在矩阵下方，只有进入某个格子的就地趋势时才让位；
       原本的两张 K 线分析面板移到翻转背面「问题K线图」（#mxKlineFace）。 */
    let dailyOpen = false;
    let dailyLoading = false;
    let dailyToken = 0;
    let panelsOpen = false;
    let perspectiveToken = 0;
    let perspectiveLoading = false;
    let issueData = null;
    let issueLoading = false;
    let issueToken = 0;
    const panelCard = shell.closest(".mx-card");
    let cancelPanelMotion = () => {};

    /* Both analysis panels can be open at once. Commit the new grid/card height, then move the
       cards below with one short transform so the page does not jump. */
    function layoutPanels(update, animate = true) {
      if (!panelCard || !bento) { update(); return; }
      const children = [...bento.children].filter((el) => el && el.nodeType === 1);
      const at = children.indexOf(panelCard);
      const followers = at >= 0 ? children.slice(at + 1) : [];
      const before = followers.map((el) => ({ el, top: el.getBoundingClientRect().top }));
      const beforeHeight = panelCard.getBoundingClientRect().height;
      const prevOverflow = panelCard.style.overflow;
      cancelPanelMotion();
      bento.style.overflowAnchor = "none";
      update();
      if (!animate || REDUCED) {
        bento.style.overflowAnchor = "";
        return;
      }
      const afterHeight = panelCard.getBoundingClientRect().height;
      const ease = "cubic-bezier(0.2, 1, 0.3, 1)";
      const anims = [];
      if (Math.abs(afterHeight - beforeHeight) > 0.5) {
        panelCard.style.overflow = "hidden";
        anims.push(panelCard.animate([{ height: `${beforeHeight}px` }, { height: `${afterHeight}px` }], { duration: 320, easing: ease }));
      }
      followers.forEach(({ el, top }) => {
        if (!el || !el.isConnected) return;
        const dy = top - el.getBoundingClientRect().top;
        if (Math.abs(dy) > 0.5) anims.push(el.animate([{ transform: `translateY(${dy}px)` }, { transform: "none" }], { duration: 320, easing: ease }));
      });
      const clean = () => {
        anims.forEach((a) => a.cancel());
        panelCard.style.height = "";
        panelCard.style.overflow = prevOverflow;
        bento.style.overflowAnchor = "";
      };
      if (anims.length) Promise.all(anims.map((a) => a.finished.catch(() => {}))).then(clean);
      else clean();
      cancelPanelMotion = () => { anims.forEach((a) => a.cancel()); clean(); };
    }

    function renderDailyTop(reveal = true) {
      if (!dailyEl || !dailyOpen || !trendData) return;
      const update = () => mountDailyTop(dailyEl, trendData, tax, u.mx, {
        onPickProblem: ({ code, name, date, source }) => {
          openTrend({ name: "全部场景", all: true }, { name, prefix: code, pat: code }, source, true, date || null);
        },
      });
      if (reveal) layoutPanels(update);
      else update();
    }

    async function hydrateDailyTop() {
      if (!dailyEl || !dailyOpen || trendData || dailyLoading) return;
      dailyLoading = true;
      const token = ++dailyToken;
      const data = await loadTrend(ctx);
      if (token !== dailyToken) return;
      dailyLoading = false;
      if (data?.dates?.length) {
        trendData = data;
        trendData.modelLabels = data.modelLabels || (p.models || []).map((m) => ({ id: m.id, label: m.label }));
        issueData = issueData || data;
      }
      if (dailyOpen && dailyEl.isConnected) {
        if (trendData) renderDailyTop();
        else layoutPanels(() => { dailyEl.innerHTML = `<div class="mx-issue-loading"><div class="empty">暂无每日问题数据</div></div>`; });
      }
    }

    function setDailyOpen(open, animate = true) {
      if (dailyOpen === open) return;
      dailyOpen = open;
      layoutPanels(() => {
        if (!dailyEl) return;
        dailyEl.hidden = !open;
        if (open) {
          if (trendData) renderDailyTop(false);
          else dailyEl.innerHTML = `<div class="mx-issue-loading"><div class="empty">正在读取每日问题…</div></div>`;
        }
      }, animate);
      if (open) hydrateDailyTop();
    }

    function renderIssueTrends(reveal = true) {
      if (!issueEl || !panelsOpen || !issueData) return;
      u.mx.issueZoom = null;
      const names = new Map();
      (tax.stages || []).forEach((node) => { if (node && node.id) names.set(node.id, node.name); });
      (tax.stages || []).forEach((stage) => (tax.mechanisms || []).forEach((mech) => {
        if (stage && mech && stage.id && mech.id) names.set(`${stage.id}.${mech.id}`, mech.name);
      }));
      Object.entries(tax.patterns || {}).forEach(([id, node]) => { if (node?.name) names.set(id, node.name); });
      const update = () => mountProblemTrends(issueEl, issueData, u.mx, names, layoutPanels, {
        mountDetailChart: (plot, node, renderChart, interaction) => mountSampleTrend(plot, renderChart,
          (pick) => loadTrendSamplePage(issueData, { node, scenes: null }, pick), interaction),
      });
      if (reveal) layoutPanels(update);
      else update();
    }

    async function hydrateIssueTrends() {
      if (!issueEl || !panelsOpen || issueLoading || issueData) return;
      issueLoading = true;
      const token = ++issueToken;
      const data = await loadTrend(ctx);
      if (token !== issueToken) return;
      issueLoading = false;
      issueData = data?.dates?.length ? data : null;
      if (panelsOpen && issueEl.isConnected) {
        if (issueData) renderIssueTrends();
        else layoutPanels(() => { issueEl.innerHTML = `<div class="mx-issue-loading"><div class="empty">暂无问题趋势数据</div></div>`; });
      }
    }

    function renderPerspective(loading = perspectiveLoading, reveal = true) {
      if (!perspectiveEl || !panelsOpen || !mxView) return;
      const update = () => {
        perspectiveEl._mxFullCleanup?.();
        const old = perspectiveEl.querySelector(".mxp-rate-chart");
        old?._drawer?.destroy();
        old?._kline?.destroy();
        perspectiveEl.innerHTML = `<div class="mx-perspective-inner">${matrixPerspectiveHTML(trendData, loading, u.mx)}</div>`;
      };
      if (reveal) layoutPanels(update);
      else update();
      wireMatrixAnalysis(perspectiveEl, traceSeverityModel(trendData), u.mx, trendData);
    }

    async function hydratePerspective() {
      if (!perspectiveEl || !panelsOpen || trendData || perspectiveLoading) return;
      perspectiveLoading = true;
      const token = ++perspectiveToken;
      const data = await loadTrend(ctx);
      if (token !== perspectiveToken) return;
      perspectiveLoading = false;
      if (data?.dates?.length) {
        trendData = data;
        trendData.modelLabels = data.modelLabels || (p.models || []).map((m) => ({ id: m.id, label: m.label }));
      }
      if (panelsOpen && perspectiveEl.isConnected) renderPerspective(false);
    }

    function setPanelsOpen(open, animate = true) {
      if (panelsOpen === open) return;
      panelsOpen = open;
      layoutPanels(() => {
        const issueVisible = !!issueEl && open;
        const perspectiveVisible = !!perspectiveEl && open;
        if (panelsEl) {
          panelsEl.hidden = !issueVisible && !perspectiveVisible;
          panelsEl.classList.toggle("is-both", issueVisible && perspectiveVisible);
          panelsEl.classList.toggle("is-issue", issueVisible && !perspectiveVisible);
          panelsEl.classList.toggle("is-perspective", perspectiveVisible && !issueVisible);
        }
        if (issueEl) {
          issueEl.hidden = !issueVisible;
          if (issueVisible) {
            if (issueData) renderIssueTrends(false);
            else issueEl.innerHTML = `<div class="mx-issue-loading"><div class="empty">正在读取问题趋势…</div></div>`;
          }
        }
        if (perspectiveEl) {
          if (!perspectiveVisible) {
            perspectiveEl.querySelector(".mxp-lens.is-full")?.classList.remove("is-full");
            document.body.classList.remove("is-mxp-full");
          }
          perspectiveEl.hidden = !perspectiveVisible;
          if (perspectiveVisible) renderPerspective(!trendData, false);
        }
      }, animate);
      if (!open) return;
      if (issueEl) hydrateIssueTrends();
      if (perspectiveEl) hydratePerspective();
    }
    setKlinePanelsOpen = setPanelsOpen;

    const headMxt = $("#mxHeadMxt", bento);
    const clearHeadMxt = () => {
      if (!headMxt) return;
      if (mxMoreCleanup) {
        mxMoreCleanup();
        mxMoreCleanup = null;
      }
      headMxt.innerHTML = "";
      headMxt.hidden = true;
    };

    const trendCrumb = (row, node) => {
      const code = String(node || "");
      const stageId = code.split(".")[0] || "";
      const stageObj = (tax.stages || []).find((s) => s.id === stageId);
      const label = patName(tax, code) || code;
      const prefix = row && row.name && row.name !== "全部场景"
        ? row.name
        : (stageObj && stageObj.name !== label ? stageObj.name : "");
      return { prefix, label, full: prefix ? `${prefix} / ${label}` : label };
    };

    function trendFrame(row, animate = true, source = null, pickDate = null) {
      clearHeadMxt();
      const spec = trendSpec(row);
      const title = trendTitle(row, spec.node);
      const crumb = trendCrumb(row, spec.node);
      if (headMxt) {
        headMxt.innerHTML = trendBarHTML(trendData, spec, crumb);
        headMxt.hidden = false;
      }
      swapShell(shell, trendBodyHTML(trendData, spec, title), animate, source, () => setDailyOpen(false));
      const box = $(".mxt", shell);
      const barHost = $(".mxt-bar", headMxt) || headMxt || box;
      const zoomBtn = $("#mxtZoom", barHost);
      const setZoom = (on) => {
        trend.zoom = on;
        if (!zoomBtn) return;
        zoomBtn.setAttribute("aria-pressed", String(on));
        zoomBtn.setAttribute("aria-label", on ? "滚轮缩放已解锁" : "滚轮缩放已锁定");
        zoomBtn.title = on ? "点击锁定滚轮缩放" : "点击解锁滚轮缩放";
      };
      zoomBtn?.addEventListener("click", () => setZoom(!trend.zoom));
      setZoom(!!trend.zoom);

      /* Unified frosted-glass "+" filter popover (same interaction model as Bench .bn-more-wrap) */
      const moreWrap = $("#mxtMoreWrap", barHost);
      const moreBtn = $("#mxtMoreToggle", barHost);
      const morePop = $("#mxtMorePop", barHost);
      const moreBadge = $("#mxtMoreBadge", barHost);
      const moreHint = $("#mxtMoreHint", barHost);
      const moreClr = $("#mxtMoreClr", barHost);
      let moreOpen = false;
      const setMoreOpen = (open) => {
        moreOpen = !!open;
        moreWrap?.classList.toggle("is-open", moreOpen);
        morePop?.classList.toggle("is-open", moreOpen);
        if (morePop) morePop.inert = !moreOpen;
        moreBtn?.setAttribute("aria-expanded", String(moreOpen));
      };
      const syncMoreBadge = () => {
        const cnt = trendFilterCount(trendSpec(row));
        moreBtn?.classList.toggle("has-active", cnt > 0);
        if (moreBadge) {
          moreBadge.textContent = String(cnt);
          moreBadge.hidden = cnt <= 0;
        }
        if (moreHint) {
          moreHint.textContent = cnt ? `已启用 ${cnt} 项条件` : "按来源 / 模型 / 等级筛选或添加对比线";
        }
        if (moreClr) moreClr.hidden = cnt <= 0;
      };
      moreBtn?.addEventListener("click", (e) => {
        e.stopPropagation();
        setMoreOpen(!moreOpen);
      });
      if (headMxt) {
        const onDocClick = (e) => {
          if (moreOpen && moreWrap && !moreWrap.contains(e.target)) setMoreOpen(false);
        };
        const onDocKey = (e) => {
          if (moreOpen && e.key === "Escape") setMoreOpen(false);
        };
        document.addEventListener("click", onDocClick);
        document.addEventListener("keydown", onDocKey);
        mxMoreCleanup = () => {
          document.removeEventListener("click", onDocClick);
          document.removeEventListener("keydown", onDocKey);
        };
      }

      /* Opening the sample drawer splits the frame and narrows the map: that resize is expected
         and must not rebuild (and thereby close) the drawer. Defer the repaint instead and play
         it once the drawer is back, so condition changes made meanwhile still land. */
      let deferred = false;
      let pendingPickDate = pickDate || null;
      const paintPlot = (force = false) => {
        const plot = $("#mxtPlot", box);
        if (!force && plot?._drawer?.isOpen?.()) { deferred = true; return; }
        deferred = false;
        const initDate = pendingPickDate;
        pendingPickDate = null;
        paintTrendPlot(box, trendSpec(row), trendData, (open) => {
          if (open) return;
          setTimeout(() => { if (deferred && box.isConnected) paintPlot(true); }, 280);
        }, () => !!trend.zoom, initDate);
      };
      const bind = (id, key) => {
        const el = $(`#${id}`, barHost);
        if (!el) return null;
        const seg = segmented(el, (v) => {
          trend[key] = v;
          syncMoreBadge();
          paintPlot();
        });
        seg.set(String(trend[key]), { silent: true });
        return seg;
      };
      bind("mxtMeasure", "measure");
      const scopeSeg = bind("mxtScope", "scope");
      // 条件池编辑当前选中的折线；点卡片切换，拖条件到卡片也能改；最多 4 条，可删到 0 条。
      const paletteEl = $("#mxtPalette", barHost);
      const linesEl = $("#mxtLines", barHost);
      let active = trend.active;
      const sortList = (kind, list) => {
        const order = kind === "uts" ? (trendData.uts || []) : (trendData.models || []);
        return order.filter((v) => list.includes(v));
      };
      const renderPalette = () => {
        const line = trend.lines[active];
        if (paletteEl) paletteEl.innerHTML = line ? trendPalette(trendData, line) : "";
      };
      const renderLines = () => {
        if (linesEl) linesEl.innerHTML = trendLinesHTML(trend.lines, trendData, active);
        syncMoreBadge();
      };
      const paint = () => paintPlot();
      const setActive = (i) => {
        active = i;
        trend.active = i;
        renderPalette();
        renderLines();
      };
      const applyChip = (line, kind, value) => {
        if (!line) return;
        if (kind === "level") {
          if (value === "all") {
            line.levels = [];
            return;
          }
          const list = (line.levels || []).slice();
          const at = list.indexOf(value);
          if (at >= 0) list.splice(at, 1);
          else list.push(value);
          line.levels = list.length === TREND_SEV.length ? [] : TREND_SEV.filter((l) => list.includes(l));
          return;
        }
        if (value === "all") {
          line[kind] = [];
          return;
        }
        const list = line[kind].slice();
        const at = list.indexOf(value);
        if (at >= 0) list.splice(at, 1);
        else list.push(value);
        line[kind] = sortList(kind, list);
      };
      const removeLine = (i) => {
        trend.lines.splice(i, 1);
        if (i < active) active -= 1;
        else if (i === active) active = Math.min(active, trend.lines.length - 1);
        active = trend.lines.length ? Math.max(0, active) : 0;
        trend.active = active;
        renderPalette();
        renderLines();
        paint();
      };
      const addLine = () => {
        if (trend.lines.length >= TREND_MAX_GROUPS) return;
        trend.lines.push({ uts: [], models: [], levels: [] });
        active = trend.lines.length - 1;
        trend.active = active;
        renderPalette();
        renderLines();
        paint();
      };
      moreClr?.addEventListener("click", () => {
        trend.lines = trendDefaultLines(trendData);
        active = 0;
        trend.active = 0;
        if (row && row.name !== "全部场景") {
          trend.scope = "row";
          scopeSeg?.set("row", { silent: true });
        }
        renderPalette();
        renderLines();
        paint();
      });
      barHost.addEventListener("click", (e) => {
        const chip = e.target.closest(".mxt-chip");
        if (chip) {
          applyChip(trend.lines[active], chip.dataset.kind, chip.dataset.value);
          renderPalette();
          renderLines();
          paint();
          return;
        }
        const del = e.target.closest(".mxt-gdel");
        if (del) return removeLine(Number(del.dataset.del));
        if (e.target.closest(".mxt-line-add")) return addLine();
        const card = e.target.closest(".mxt-linecard");
        if (card) setActive(Number(card.dataset.line));
      });
      barHost.addEventListener("keydown", (e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        if (e.target.closest("button")) return;
        const card = e.target.closest(".mxt-linecard");
        if (!card) return;
        e.preventDefault();
        setActive(Number(card.dataset.line));
      });
      const payloadOf = (e) => {
        try { return JSON.parse(e.dataTransfer.getData("text/plain") || "null"); } catch { return null; }
      };
      barHost.addEventListener("dragstart", (e) => {
        const chip = e.target.closest(".mxt-chip");
        if (!chip) return;
        e.dataTransfer.setData("text/plain", JSON.stringify({ kind: chip.dataset.kind, value: chip.dataset.value }));
        e.dataTransfer.effectAllowed = "copy";
        chip.classList.add("is-dragging");
        barHost.classList.add("is-dragging");
      });
      barHost.addEventListener("dragend", (e) => {
        const chip = e.target.closest(".mxt-chip");
        if (chip) chip.classList.remove("is-dragging");
        barHost.classList.remove("is-dragging");
        $$(".mxt-linecard.is-over", barHost).forEach((el) => el.classList.remove("is-over"));
      });
      barHost.addEventListener("dragover", (e) => {
        if (!barHost.classList.contains("is-dragging")) return;
        const card = e.target.closest(".mxt-linecard");
        if (!card) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        $$(".mxt-linecard.is-over", barHost).forEach((el) => { if (el !== card) el.classList.remove("is-over"); });
        card.classList.add("is-over");
      });
      barHost.addEventListener("dragleave", (e) => {
        const card = e.target.closest(".mxt-linecard");
        if (card && !card.contains(e.relatedTarget)) card.classList.remove("is-over");
      });
      barHost.addEventListener("drop", (e) => {
        const card = e.target.closest(".mxt-linecard");
        if (!card) return;
        e.preventDefault();
        card.classList.remove("is-over");
        const payload = payloadOf(e);
        if (!payload) return;
        const i = Number(card.dataset.line);
        applyChip(trend.lines[i], payload.kind, payload.value);
        if (i !== active) {
          active = i;
          trend.active = i;
        }
        renderPalette();
        renderLines();
        paint();
      });
      renderPalette();
      renderLines();
      paintPlot();
      if (window.ResizeObserver) {
        let wide = plotWidth(box);
        const ro = new ResizeObserver(() => {
          const next = plotWidth(box);
          if (Math.abs(next - wide) < 8) return;
          wide = next;
          paintPlot();
        });
        ro.observe(box);
        box._ro = ro;
      }
    }

    async function openTrend(row, col, source = null, allScenes = false, pickDate = null) {
      const node = col.prefix || col.pat;
      if (!node) return;
      hideTip();
      trend.open = true;
      trend.node = node;
      trend.rowName = row.name;
      if (allScenes) trend.scope = "all";
      trend.colPrefix = node;
      trend.rowKeys = rowPath.slice(1).map(rowKey);
      trend.colKeys = colPath.slice(1).map(colKey);
      const backBtn = $("#mxBack", bento);
      if (backBtn) {
        backBtn.textContent = "← 返回矩阵";
        backBtn.hidden = false;
      }
      const ready = trendReady(ctx);
      $$(".mx-trend-probe", shell).forEach((el) => el.remove());
      if (!ready) {
        const status = document.createElement("span");
        status.className = "mx-trend-probe";
        status.textContent = "正在读取趋势";
        shell.appendChild(status);
      }
      const token = ++trendToken;
      const data = ready || await loadTrend(ctx);
      if (token !== trendToken || !trend.open || !shell.isConnected) return;
      $$(".mx-trend-probe, .mx-swap-probe", shell).forEach((el) => el.remove());
      if (!data || !data.dates || !data.dates.length) {
        clearHeadMxt();
        swapShell(shell, `<div class="mxt mx-swap-panel"><div class="empty">暂无趋势数据</div></div>`, !!ready, source, () => setDailyOpen(false));
        return;
      }
      trendData = data;
      trendData.modelLabels = data.modelLabels || (p.models || []).map((m) => ({ id: m.id, label: m.label }));
      normalizeTrend(trend, data);
      trendFrame(row, !!ready, source, pickDate);
    }

    function closeTrend(source = null) {
      trend.open = false;
      trendToken += 1;
      clearHeadMxt();
      $$(".mx-trend-probe, .mx-swap-probe", shell).forEach((el) => el.remove());
      paint(true, source);
    }

    paint(false);
    // The trend payload is 6-7 MB: fetch it while the matrix is idle so the first cell
    // click swaps in an already-parsed chart instead of waiting on the network.
    const preloadTrend = () => loadTrend(ctx);
    if ("requestIdleCallback" in window) requestIdleCallback(preloadTrend, { timeout: 3000 });
    else setTimeout(preloadTrend, 1200);
    // 默认展开每日 TOP 问题面板；进入某个格子的就地趋势时它保持收着。
    setDailyOpen(!trend.open, false);
    // 就地刷新或切产品回来：路径还在，趋势也重新打开在同一格上。
    if (trend.open && trend.node) {
      const row = (mxView.rows || []).find((x) => x.name === trend.rowName);
      const col = (mxView.cols || []).find((x) => (x.prefix || x.pat) === trend.colPrefix)
        || { name: patName(tax, trend.node) || trend.node, prefix: trend.node };
      if (trend.rowName === "全部场景") openTrend({ name: "全部场景", all: true }, col, null, true);
      else if (row) openTrend(row, col);
      else trend.open = false;
    }
    bento.addEventListener("click", (e) => {
      const back = e.target.closest("#mxBack");
      if (back) {
        if (trend.open) return closeTrend(back);
        const axis = trail.pop();
        if (axis === "r" && rowPath.length > 1) rowPath = rowPath.slice(0, -1);
        else if (axis === "c" && colPath.length > 1) colPath = colPath.slice(0, -1);
        else if (colPath.length > 1) colPath = colPath.slice(0, -1);
        else if (rowPath.length > 1) rowPath = rowPath.slice(0, -1);
        paint(true, back);
        return;
      }
      const cell = e.target.closest("#mxShell .cell[data-mx]:not(.is-empty)");
      if (cell) {
        // A cell is a ready-made 具体数据 filter: its scene row × its problem column.
        const [ri, ci] = cell.dataset.mx.split(":").map(Number);
        if (ri === mxView.rows.length) {
          const c = mxView.cols[ci];
          if (!c) return;
          openTrend({ name: "全部场景", all: true }, c, cell, true);
          return;
        }
        const r = mxView.rows[ri];
        const c = mxView.cols[ci];
        if (!r || !c) return;
        if (r.group) {
          rowPath = [...rowPath, r];
          trail.push("r");
          paint(true, cell);
          return;
        }
        openTrend(r, c, cell);
        return;
      }
      const row = e.target.closest("#mxShell [data-row]");
      if (row) {
        const node = mxView.rows[Number(row.dataset.row)];
        if (node && node.children.length) {
          rowPath = [...rowPath, node];
          trail.push("r");
          paint(true, row);
        }
        return;
      }
      const col = e.target.closest("#mxShell [data-col]");
      if (col) {
        const node = mxView.cols[Number(col.dataset.col)];
        if (node && node.children.length) {
          colPath = [...colPath, node];
          trail.push("c");
          paint(true, col);
        }
        return;
      }
    });
  }

  push.rings.vol = sunburst($("#vol", bento), volTree(p), {
    unit: "评测输入", state: u.vol, animate: !ctx.refresh, onChange: (f, o) => push.fromRing("vol", f, o),
    inert: (n) => (n.ev === 0 ? NO_CASE : null),
  });
  if (tax) {
    push.rings.clu = sunburst($("#clu", bento), cluTree(p, tax), {
      unit: "问题", sort: true, state: u.clu, animate: !ctx.refresh, onChange: (f, o) => push.fromRing("clu", f, o),
    });
  }
  if (p.prediction && $("#prd", bento)) {
    push.rings.pred = sunburst($("#prd", bento), predTree(p.prediction.items || []), {
      unit: "可核验题", state: u.prd, animate: !ctx.refresh, onChange: (f, o) => push.fromRing("pred", f, o),
    });
  }
  push.start();

  $$(".sankey", bento).forEach((sk) => {
    sk.addEventListener("pointerover", (e) => {
      const t = e.target.closest("[data-g],[data-r]");
      sk.classList.toggle("hl", !!t);
      if (!t) return;
      const hit = (f) => (t.classList.contains("sk-f") ? f === t : t.dataset.g != null ? f.dataset.g === t.dataset.g : f.dataset.r === t.dataset.r);
      $$(".sk-f", sk).forEach((f) => f.classList.toggle("on", hit(f)));
    });
    sk.addEventListener("pointerleave", () => sk.classList.remove("hl"));
  });

  bindTips(bento, (t) => {
    if (t.dataset.mxdTipKind) return resolveDailyTip(t);
    if (t.dataset.mx) {
      if (!mxView) return null;
      const [ri, ci] = t.dataset.mx.split(":").map(Number);
      const row = mxView.rows[ri], col = mxView.cols[ci], cell = mxView.cells[ri] && mxView.cells[ri][ci];
      if (!row || !col || !cell || !cell.n) return null;
      const top = col.pat
        ? ""
        : [...cell.pats.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 3)
            .map(([pid, n]) => `<div class="t-row"><span>${esc(patName(tax, pid))}</span><b class="num">${fmt(n)}</b></div>`)
            .join("");
      return `<div class="t-head">${esc(row.name)} · ${esc(col.name)}</div>
        <div class="t-row"><span>问题</span><b class="num">${fmt(cell.n)}</b></div>
        <div class="t-row"><span>会话</span><b class="num">${fmt(cell.sessions)}</b></div>
        ${top ? `<div class="mx-tip-pats">${top}</div>` : ""}`;
    }
    if (!t.dataset.cell) return null;
    const [g, i] = t.dataset.cell.split(":").map(Number);
    const c = p.field[g].cells[i];
    return `<div class="t-head">${esc(c[3])}</div>
      <div class="t-row"><span class="sev" style="--c:${sevColor(c[1])}"><i></i>${SEV_NAME[WORST[c[1]]]}</span>
      <span>${esc(groupName(p, p.field[g]))}</span>${c[4] ? `<span class="dim">流失用户</span>` : ""}<b class="num">${c[2]} 个问题</b></div>`;
  });

  /* 问题K线图 & A/B Test: 聚类矩阵卡原位翻转成背面的分析或对比面板，返回时再翻回矩阵。
     数据按需拉一次；展开状态活在 u.kline / u.ab 上，就地刷新后还停在原来那一面。 */
  const klineBtn = $("#mxKline", bento);
  const klineFace = $("#mxKlineFace", bento);
  const abBtn = $("#mxAB", bento);
  const mxCard = $("#mxCard", bento);
  const matrixFace = $("#mxMatrixFace", bento);
  const abFace = $("#mxABFace", bento);
  const abBody = $("#abBody", bento);
  if (mxCard && matrixFace && (klineFace || (abBtn && abFace && abBody && p.ab))) {
    u.kline = u.kline || { open: false, full: false };
    u.ab = u.ab || { open: false, full: false, round: -1, metric: "", cell: null, mxRows: [], mxCols: [], mxTrail: [] };
    let currentFace = "matrix";
    let targetFace = "matrix";
    let flipping = false;
    let abLoading = false;
    let abLoaded = false;

    const setFace = (face) => {
      currentFace = face;
      matrixFace.hidden = face !== "matrix";
      if (klineFace) klineFace.hidden = face !== "kline";
      if (abFace) abFace.hidden = face !== "ab";
      mxCard.classList.toggle("is-kline", face === "kline");
      mxCard.classList.toggle("is-ab", face === "ab");
      if (klineBtn) klineBtn.setAttribute("aria-expanded", String(face === "kline"));
      if (abBtn) abBtn.setAttribute("aria-expanded", String(face === "ab"));
      setKlinePanelsOpen(face === "kline", false);
      if (face === "matrix" && shell) fitMatrix(shell.querySelector(".matrix:last-of-type"));
    };

    const wait = (anim) => (anim && anim.finished ? anim.finished.catch(() => {}) : Promise.resolve());
    const flipOnce = async (face) => {
      if (REDUCED || !mxCard.animate) return setFace(face);
      const oldH = mxCard.getBoundingClientRect().height;
      const out = mxCard.animate([
        { transform: "perspective(1600px) translateZ(0) rotateX(0deg) scale(1)", opacity: 1 },
        { transform: "perspective(1600px) translateZ(-18px) rotateX(2deg) scale(0.99)", opacity: 0 },
      ], { duration: 150, easing: "cubic-bezier(0.4, 0, 1, 1)", fill: "forwards" });
      await wait(out);
      out.cancel();
      setFace(face);
      const newH = mxCard.getBoundingClientRect().height;
      mxCard.style.height = `${oldH}px`;
      mxCard.style.overflow = "hidden";
      const enter = mxCard.animate([
        { transform: "perspective(1600px) translateZ(-16px) rotateX(-2deg) scale(0.99)", opacity: 0 },
        { transform: "perspective(1600px) translateZ(0) rotateX(0deg) scale(1)", opacity: 1 },
      ], { duration: 320, easing: "cubic-bezier(0.16, 1, 0.3, 1)", fill: "forwards" });
      const resize = Math.abs(newH - oldH) > 1
        ? mxCard.animate([{ height: `${oldH}px` }, { height: `${newH}px` }], { duration: 320, easing: "cubic-bezier(0.16, 1, 0.3, 1)", fill: "forwards" })
        : null;
      await Promise.all([wait(enter), wait(resize)]);
      enter.cancel();
      if (resize) resize.cancel();
      mxCard.style.height = "";
      mxCard.style.overflow = "";
    };

    const requestFace = async (face) => {
      targetFace = face;
      if (flipping) return;
      flipping = true;
      mxCard.classList.add("is-flipping");
      try {
        while (targetFace !== currentFace) await flipOnce(targetFace);
      } finally {
        flipping = false;
        mxCard.classList.remove("is-flipping");
      }
    };

    const hydrateAB = async () => {
      if (!abBody || !p.ab || abLoaded || abLoading) return;
      abLoading = true;
      const data = await loadAB(ctx, p.ab.url);
      if (!data || !data.rounds || !data.rounds.length) {
        abBody.innerHTML = `<div class="empty">暂无 AB 测试数据</div>`;
        abLoaded = true;
        abLoading = false;
        return;
      }
      mountAB(abBody, data, u.ab, tax, p, { openCompare, mountCellTrend: mountABCellTrend });
      abLoaded = true;
      abLoading = false;
    };

    /* Fullscreen keeps the reader inside the same card: it leaves the bento, covers the viewport and
       returns to its slot on Esc or the same icon, so no second panel is mounted. */
    const klineFullBtn = $("#klineFull", mxCard);
    const abFullBtn = $("#abFull", mxCard);
    const setFull = (on, animate = true) => {
      const had = mxCard.classList.contains("is-full");
      if (currentFace === "kline") u.kline.full = on;
      if (currentFace === "ab") u.ab.full = on;
      if (had === on) return;
      const first = animate && !REDUCED ? mxCard.getBoundingClientRect() : null;
      mxCard.classList.toggle("is-full", on);
      document.body.classList.toggle("is-ab-full", on);
      [
        [klineFullBtn, "全屏查看问题K线图"],
        [abFullBtn, "全屏查看 A/B Test"],
      ].forEach(([btn, openLabel]) => {
        if (!btn) return;
        btn.setAttribute("aria-pressed", String(on));
        btn.setAttribute("aria-label", on ? "退出全屏" : openLabel);
        btn.title = on ? "退出全屏" : "全屏";
      });
      if (!first) return;
      const last = mxCard.getBoundingClientRect();
      mxCard.animate([
        { transform: `translate(${first.left - last.left}px, ${first.top - last.top}px) scale(${first.width / Math.max(1, last.width)}, ${first.height / Math.max(1, last.height)})`, transformOrigin: "0 0" },
        { transform: "none" },
      ], { duration: 360, easing: "cubic-bezier(0.16, 1, 0.3, 1)" });
    };

    const closeBackFace = () => {
      u.kline.open = false;
      u.kline.full = false;
      u.ab.open = false;
      u.ab.full = false;
      setFull(false, false);
      requestFace("matrix");
    };
    const openKline = async () => {
      u.kline.open = true;
      u.ab.open = false;
      await requestFace("kline");
    };
    const openAB = async () => {
      if (!p.ab || !abFace) return;
      u.ab.open = true;
      u.kline.open = false;
      await requestFace("ab");
      if (u.ab.open) hydrateAB();
    };

    klineBtn?.addEventListener("click", () => (u.kline.open ? closeBackFace() : openKline()));
    $("#klineClose", mxCard)?.addEventListener("click", closeBackFace);
    klineFullBtn?.addEventListener("click", () => setFull(!mxCard.classList.contains("is-full")));

    if (abBtn && abFace && abBody && p.ab) {
      abBtn.addEventListener("click", () => (u.ab.open ? closeBackFace() : openAB()));
      $("#abClose", mxCard)?.addEventListener("click", closeBackFace);
      abFullBtn?.addEventListener("click", () => setFull(!mxCard.classList.contains("is-full")));
    }

    const onDocKey = (e) => {
      if (e.key !== "Escape" || (!u.ab.open && !u.kline.open) || !mxCard.isConnected) return;
      if (mxCard.querySelector(".mxt-sample-layout.is-open") || mxCard.querySelector(".mxp-lens.is-full")) return;
      if (mxCard.classList.contains("is-full")) setFull(false);
      else closeBackFace();
    };
    if (abDocKey) document.removeEventListener("keydown", abDocKey);
    abDocKey = onDocKey;
    document.addEventListener("keydown", abDocKey);

    if (u.kline.open && klineFace) {
      setFace("kline");
      targetFace = "kline";
      if (u.kline.full) setFull(true, false);
    } else if (u.ab.open && abFace && p.ab) {
      setFace("ab");
      targetFace = "ab";
      if (u.ab.full) setFull(true, false);
      hydrateAB();
    }
  }
}
