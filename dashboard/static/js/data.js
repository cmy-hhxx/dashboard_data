/* 数据: 会话场 · 聚类矩阵 · 数据量 · 评测量 · 归因体系 · 聚类体系 · 预测体系. Titles only; the layout carries the rest.
   Charts drill in place; a session tile opens 具体数据 for that case, a matrix cell opens its trend chart in the card. */
import { $, $$, esc, fmt, pct, sum, compact, WORST, SEV_NAME, KIND, sevColor, counter, runCounters, bindTips, segmented, REDUCED, showTip, hideTip, getJSON } from "./core.js";
import { renderContent } from "./render.js";
import { sunburst } from "./sunburst.js";
import { sunburstTween } from "./motion.js";
import { galaxy } from "./galaxy.js";
import { mountAB } from "./abtest.js";
import { monotonePath, nebulaCluster, lineTrendSVG, wireLineTrendChart, wireTrendPointPick } from "./trend_chart.js";
import { mountProblemTrends } from "./problem_trends.js";
import { traceSeverityModel, traceShares } from "./trace_analysis.js";
import { matrixHeatSummary } from "./matrix_heat.js";
import { trendSampleFrame, abTrendSampleRefs, resolveABSamples, trendSampleCandidates, trendSampleProblems, traceSampleRefs } from "./trend_samples.js";

let ctx;
let abDocKey = null;
let shown = null;
let lastDetail = null;
/* View state per product that outlives a redraw: an in-place data refresh (or switching product
   and back) lands on the same filter, page, ring, drill path and tab. */
const UI = {};
const ui = (product) =>
  (UI[product] = UI[product] || {
    field: { w: null, pages: [] }, vol: {}, clu: {}, pred: "vol",
    mx: {
      rows: [], cols: [], trail: [], expanded: false, issueOpen: false, issueRange: "30", issuePath: [], analysisLevels: ["P0", "P1"],
      // 聚类矩阵格子的就地趋势图：口径 / 时间 / 场景 + 来源·模型·等级的折线组 + 是否打开都活在这里，
      // 就地刷新或切换产品再回来仍是同一张图。rowKeys/colKeys 是行列路径，刷新后用来重新定位。
      trend: { open: false, measure: "count", range: "30", scope: "row", lines: [], active: 0, seeded: false, rowKeys: null, colKeys: null },
    },
  });
const SPLIT_SHORT = { daily: "日常", lost: "流失" };
// A 数据量 branch with inputs but no evaluated case: the ring keeps it shut and says where to look.
const NO_CASE = "暂无已评测的 case，请去评测详情页面查看";
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
  document.body.classList.remove("is-ab-full");
  if (!p) {
    root.innerHTML = `<div class="bento"><article class="card" style="--span:12"><div class="empty">${
      c.product === "wencai" ? "问财" : "AIME"
    } 暂无评测数据。把数据放入 datasets/ 后运行 local_dev/refresh.sh。</div></article></div>`;
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
  root.innerHTML = `<div class="bento">${fieldCard(p, u)}${matrixCard(p, tax)}${volumeCard(p)}${evalCard(p)}${attrCard(p)}${clusterCard(p, tax)}${predictCard(p)}</div>`;
  wire($(".bento", root), p, tax, u);
  if (c.refresh) requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove("is-refresh")));
  else runCounters(root);
  if (lastDetail) {
    window.scrollTo(0, 0);
    lastDetail = null;
  }
}

const ICON_COLLAPSE = `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M6 15l6-6 6 6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
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
    .map((g, gi) => `<div class="fgroup" data-g="${gi}"><div class="fgroup-head"><b>${esc(groupName(p, g))}</b><span class="num">${fmt(g.cells.length)}</span>${
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
  model: null, scene: null, sub: null, stage: null, mech: null, pattern: null, case: null, trace: null,
};
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
        <span class="pager-info">第 <b class="num">${cur}</b> / ${pages} 页 · ${fmt(g.cells.length)} 条</span>
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
  const pending = `<span class="stat-pending" title="当前 data.json 还没有评测输入的工具调用 / Tokens 聚合，需补数据后接入">—</span>`;
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
  const note = lost ? `<div class="sb-keys"><span class="sb-key" title="外圈细环是该分支里流失用户 trace 的占比，列表红字是流失 trace 数"><i></i>流失</span></div>` : "";
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
const EV = { range: "30", model: "all", year: null };

function evalRows(p) {
  if (Array.isArray(p.daily) && p.daily.length) return p.daily;
  // Fallback for a payload built before daily input counts existed.
  return (p.dates || []).map((d) => {
    const n = dayCount(d);
    return { d: d.d, m: "all", sp: "", inputs: n, evaluated: n };
  });
}

function evalModels(p) {
  const labels = new Map(p.models.map((m) => [m.id, m.label]));
  const present = [...new Set(evalRows(p).map((r) => r.m).filter(Boolean))];
  const ids = p.models.map((m) => m.id).filter((id) => present.includes(id));
  const extra = present.filter((id) => id !== "all" && !ids.includes(id));
  return [{ id: "all", label: "全部" }, ...ids.map((id) => ({ id, label: labels.get(id) || id })),
    ...extra.map((id) => ({ id, label: id }))];
}

function evalWindow(p) {
  const byDay = new Map();
  const blank = () => ({ inputs: 0, evaluated: 0, traces: 0, tokens: 0, tokenRecords: 0, sessions: 0,
    inTraces: 0, hasTraces: true, hasIns: true, sids: new Set(), inSids: new Set() });
  evalRows(p)
    .filter((r) => EV.model === "all" || r.m === EV.model)
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
    return days.map((x) => ({ ...x, label: x.d.slice(5), tip: x.d }));
  }
  const months = new Map();
  days.forEach((x) => {
    if (!x.inputs && !x.evaluated) return;
    const key = x.d.slice(0, 7);
    let b = months.get(key);
    if (!b) months.set(key, (b = { d: x.d, d0: x.d, d1: x.d, inputs: 0, evaluated: 0 }));
    b.d0 = b.d0 < x.d ? b.d0 : x.d;
    b.d1 = b.d1 > x.d ? b.d1 : x.d;
    b.inputs += x.inputs;
    b.evaluated += x.evaluated;
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
    if (!b) years.set(y, (b = { year: y, d: `${y}-01-01`, d0: `${y}-01-01`, d1: `${y}-12-31`, inputs: 0, evaluated: 0 }));
    b.inputs += m.inputs;
    b.evaluated += m.evaluated;
  });
  return [...years.keys()].sort().map((y) => ({ ...years.get(y), label: y, tip: `${y} · 点击看月份` }));
}

function evalChart(p) {
  const bars = evalBuckets(evalWindow(p).days);
  if (!bars.length) return `<div class="empty">暂无评测日期</div>`;
  const max = Math.max(1, ...bars.map((x) => Math.max(x.inputs, x.evaluated)));
  const rows = [];
  for (let i = 0; i < bars.length; i += EV_PER_ROW) rows.push(bars.slice(i, i + EV_PER_ROW));
  const barH = rows.length === 1 ? 160 : 44;
  return `<div class="evrows${EV.range === "all" ? " is-buckets" : ` is-days${EV.range === "7" ? " is-week" : ""}`}" style="--bar-h:${barH}px">${rows
    .map((row) => `<div class="evrow" style="--n:${row.length}">${row
      .map((x) => {
        const total = Math.max(x.inputs, x.evaluated, 1);
        const height = Math.max(3, (barH * total) / max);
        const done = x.evaluated ? Math.min(100, (100 * x.evaluated) / Math.max(x.inputs, x.evaluated)) : 0;
        const tip = `${x.tip || x.d}|输入 ${fmt(x.inputs)} · 已完成 ${fmt(x.evaluated)} · ${pct(x.evaluated, x.inputs, 1)}`;
        return `<div class="evday${x.evaluated ? " is-live" : ""}${x.year ? " is-drill" : ""}"${x.year ? ` data-year="${esc(x.year)}"` : ""} data-d0="${x.d0 || x.d}" data-d1="${x.d1 || x.d}"><div class="evnums"><b class="num">${compact(x.evaluated)}</b><small class="num">${compact(x.inputs)}</small></div>
          <div class="evbar" style="height:${height}px" data-tip="${esc(tip)}"><i style="height:${done}%"></i></div>
          <small class="evdate num">${esc(x.label)}</small></div>`;
      })
      .join("")}</div>`)
    .join("")}</div>`;
}

/* 评测量是「输出 / 输入」对账：口径跟 ev-range 走，近 7/30 天用窗口合计，
   全部（以及年份下钻）用全量/该年合计。 */
function evalTotals(p) {
  const w = evalWindow(p);
  const k = p.kpi;
  const input = p.input || {};
  const scoped = EV.range !== "all" || !!EV.year;
  const model = EV.model !== "all";
  const allInput = model ? (input.models?.[EV.model] || {}) : input;
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
  return `<div class="ev-legend"><span><i class="ev-done"></i>已完成</span><span><i class="ev-in"></i>评测输入</span>${back}</div>`;
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
  const cols = miniCols(days.map((x) => ({ done: x.evaluated || 0, all: Math.max(x.inputs || 0, x.evaluated || 0) })));
  const ends = days.length > 1 ? [days[0], days[days.length - 1]] : days;
  const foot = days.length ? `<div class="cx-days">${cols}<span>${ends.map((x) => `<small>${esc(x.label)}</small>`).join("")}</span></div>` : "";
  // Per version over the same window: done / inputs, the bar is the version's completion.
  const inWindow = new Set(w.days.map((x) => x.d));
  const by = new Map();
  evalRows(p)
    .filter((r) => inWindow.has(r.d) && (EV.model === "all" || r.m === EV.model))
    .forEach((r) => {
      const x = by.get(r.m) || { m: r.m, inputs: 0, done: 0 };
      x.inputs += r.inputs || 0;
      x.done += r.evaluated || 0;
      by.set(r.m, x);
    });
  const rank = [...by.values()]
    .sort((a, b) => b.done - a.done || b.inputs - a.inputs)
    .slice(0, 8)
    .map((x) => ({ name: x.m === "all" ? "全部" : modelName(p, x.m), value: `${fmt(x.done)}<span class="stat-of"> / ${fmt(x.inputs)}</span>`, share: x.inputs ? x.done / x.inputs : 0 }));
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
    note.innerHTML = `共 <b class="num">${fmt(inputAll.length)}</b> 条评测输入，已有评测输出 <b class="num">${fmt(covered)}</b> 条`
      + (filtering ? ` · 命中 <b class="num">${fmt(rows.length)}</b> 条` : "");
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
  if (!traces.length) return `<div class="ed-expand-empty">该样本没有评测输入（流失侧样本未带输入）。</div>`;
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
    ? `<span class="sb-key is-note" title="归因没有匹配到聚类模式的问题：计入问题总数，不进矩阵"><i></i>未聚类 ${fmt(p.kpi.unclustered)}</span>`
    : "";
  const phases = (cluTree(p, tax).children || []).filter((c) => c.n > 0).sort((a, b) => b.n - a.n);
  const phaseTotal = sum(phases.map((c) => c.n)) || 1;
  return card(4, "聚类体系", `<div class="duo sm" id="clu"></div>
    <div class="sb-keys"><span class="sb-key" title="外圈细环是该分支里 P0·P1 问题的占比，列表红字是 P0+P1 数"><i></i>P0·P1</span>${note}</div>${GX}${miniView(miniRing([
      { n: p.kpi.clustered || 0, c: "var(--accent)" }, { n: p.kpi.unclustered || 0, c: "var(--t4)" },
    ]), [
      [counter(p.kpi.problems), "问题"], [pct(p.kpi.clustered, p.kpi.problems), "已聚类"],
    ], "", phases.slice(0, 6).map((c, i) => ({ name: c.name, value: fmt(c.n), share: c.n / phaseTotal, c: leadTone(i) })))}`, "", "clu");
}

const sevPair = (s) => [(s && s.P0) || 0, (s && s.P1) || 0];
const addPair = (a, b) => [a[0] + b[0], a[1] + b[1]];
const toSev = (pair) => ({ P0: pair[0], P1: pair[1] });

/* Patterns drill one level further than L3: a four-part path such as S9.M5.4.4 is a
   child of S9.M5.4. Build the parent tier from the ids themselves, so a branch whose
   matched problems only sit at L4 still gets its named L3 parent. */
const patName = (tax, id) => ((tax.patterns || {})[id] || {}).name || id;
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
  const rows = acc
    .map((x) => `<div class="li vrow" data-pm="${esc(x.m)}" data-tip="${esc(modelName(p, x.m))} · 准确率|${x.n ? `${fmt(x.c)} / ${fmt(x.n)}` : `${fmt(x.r, 1)}%`}"><span>${esc(modelName(p, x.m))}</span><span class="vbar"><i style="width:${x.r}%"></i></span><b class="num">${fmt(x.r, 1)}%</b></div>`)
    .join("");
  const right = sum(acc.map((x) => x.c));
  const causeTotal = sum(causes.map((x) => x.n));
  // Forecast questions = revealed + pending (questions[]) + those the export could not verify yet.
  const unver = Number.isFinite(pr.unverifiable) ? pr.unverifiable : 0;
  const forecast = qs.length + unver;
  const rest = Math.max(0, allQ - forecast);
  const panes = `<div class="pred-pane is-on" data-pane="vol">
      <div class="pred-top"><div class="hero"><b class="big">${counter(forecast)}</b><small>预测题</small></div>
        <div class="hero"><b class="big num">${pct(forecast, allQ, 1)}</b><small>占题库</small></div></div>
      ${bar([
        { n: open, c: "var(--accent)", l: "已揭晓" },
        { n: qs.length - open, c: "color-mix(in oklab, var(--accent) 38%, var(--card))", l: "待揭晓" },
        { n: unver, c: "var(--t3)", l: "不可核验" },
        { n: rest, c: "var(--t4)", l: "其他题" },
      ].filter((x) => x.n))}
      ${stats([["题库", counter(allQ)], ["已揭晓", counter(open)], ["待揭晓", counter(qs.length - open)], ["其他题", counter(rest)]])}
    </div>
    <div class="pred-pane" data-pane="acc">
      <div class="pred-top"><div class="hero"><b class="big num">${pooledN ? `${fmt((100 * right) / pooledN, 1)}%` : "—"}</b><small>准确率</small></div>
        <div class="hero"><b class="big num">${fmt(pooledN)}</b><small>已判定</small></div></div>
      ${rows ? `<div class="list pred-rows">${rows}</div>` : `<div class="empty">暂无准确率</div>`}
      ${pooledN ? bar([
        { n: right, c: "var(--accent)", l: "正确" },
        { n: pooledN - right, c: "var(--t4)", l: "错误" },
      ].filter((x) => x.n)) : ""}
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
  (p.cross || []).forEach(([task, sub, pats]) => {
    const n = sum(pats.map((x) => x[1]));
    let t = tasks.get(task);
    if (!t) tasks.set(task, (t = { name: task, n: 0, sessions: 0, subs: new Map() }));
    t.n += n;
    t.sessions += 1;
    if (sub) {
      let s = t.subs.get(sub);
      if (!s) t.subs.set(sub, (s = { name: sub, n: 0, sessions: 0 }));
      s.n += n;
      s.sessions += 1;
    }
  });
  return [...tasks.values()]
    .sort((a, b) => b.n - a.n || a.name.localeCompare(b.name))
    .map((t) => {
      const subs = [...t.subs.values()].sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));
      return {
        name: t.name, task: t.name, n: t.n, sessions: t.sessions, tasks: [t.name],
        children: subs.length
          ? subs.map((s) => ({ name: s.name, task: t.name, sub: s.name, n: s.n, sessions: s.sessions, children: [] }))
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
      name: "其他场景", group: true, n: sum(rest.map((x) => x.n)), sessions: sum(rest.map((x) => x.sessions)),
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
  const cells = rows.map(() => cols.map(() => ({ n: 0, sessions: 0, pats: new Map() })));
  (p.cross || []).forEach(([task, sub, pats]) => {
    const ri = rows.findIndex((r) => sceneMatches(r, task, sub));
    if (ri < 0) return;
    const hit = new Set();
    pats.forEach(([pid, n]) => {
      const ci = cols.findIndex((c) => clusterMatches(c, pid));
      if (ci < 0) return;
      const cell = cells[ri][ci];
      cell.n += n;
      cell.pats.set(pid, (cell.pats.get(pid) || 0) + n);
      if (!hit.has(ci)) {
        cell.sessions += 1;
        hit.add(ci);
      }
    });
  });
  return { rows, cols, cells };
}

function matrixTable(view) {
  const { rows, cols, cells } = view;
  if (!rows.length || !cols.length) return `<div class="empty">暂无聚类数据</div>`;
  let max = 1, maxTot = 1;
  const totals = rows.map((_, ri) => sum(cells[ri].map((x) => x.n)));
  cells.forEach((row) => row.forEach((x) => (max = Math.max(max, x.n))));
  totals.forEach((n) => (maxTot = Math.max(maxTot, n)));
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
    const label = `<span class="mx-lab">${esc(r.name)}</span>${drill ? `<i class="mx-caret" aria-hidden="true"></i>` : ""}`;
    rowLabels += drill
      ? `<button type="button" class="rh" data-row="${ri}" title="${esc(r.name)}" aria-label="下钻 ${esc(r.name)}">${label}</button>`
      : `<span class="rh" title="${esc(r.name)}">${label}</span>`;
    cols.forEach((_, ci) => {
      const cell = cells[ri][ci];
      const v = cell.n ? 0.08 + 0.72 * Math.sqrt(cell.n / max) : 0;
      gridCells += cell.n
        ? `<span class="cell num${v > 0.5 ? " hot" : ""}" style="--v:${v.toFixed(3)}" data-mx="${ri}:${ci}">${fmt(cell.n)}</span>`
        : `<span class="cell is-empty" data-mx="${ri}:${ci}"></span>`;
    });
    tots += `<span class="rowtot num"><i style="width:${(72 * totals[ri]) / maxTot}px"></i>${fmt(totals[ri])}</span>`;
  });
  return `<div class="matrix mx-swap-panel" style="--cols:${cols.length};--rows:${rows.length}">
    <div class="mx-rows"><span class="mx-corner" aria-hidden="true"></span>${rowLabels}</div>
    <div class="mx-scroll"><div class="mx-grid">${heads}${gridCells}</div></div>
    <div class="mx-tots"><span class="rowtot-head" title="该场景在各问题聚类上的问题数合计">问题合计</span>${tots}</div>
  </div>`;
}

/* Matrix analysis: exclusive Trace severity distribution and counts over time.
   The timeline uses deduplicated hit sessions for each type, never sums sibling hit counts. */
function mxTrendSummary(trend, view, clusterRoot, state) {
  if (!trend?.scenes) return null;
  const scenes = new Set(trend.scenes.map(([task, sub], i) => view.rows.some((row) => sceneMatches(row, task, sub)) ? i : -1).filter((i) => i >= 0));
  return matrixHeatSummary(trend, clusterRoot, state.heatPath || [], scenes);
}

const mxRateText = (v) => v == null ? "—" : `${fmt(v, 1)}%`;
const mxDeltaText = (v) => v == null ? "—" : `${v > 0 ? "+" : v < 0 ? "−" : ""}${fmt(Math.abs(v), 1)}`;

function mxPerspectiveTimeline(summary, loading) {
  if (!summary) return `<div class="mxp-chart-empty">${loading ? "正在读取趋势…" : "暂无趋势数据"}</div>`;
  const { dates, daily } = summary;
  const end = dayMs(dates[dates.length - 1]);
  const calendar = Array.from({ length: 30 }, (_, i) => isoDay(end - (29 - i) * DAY_MS));
  const index = new Map(dates.map((d, i) => [d, i]));
  const heat = (v) => (0.06 + 0.84 * Math.sqrt(Math.min(100, v) / 100)).toFixed(3);
  const periodRate = (group, start, stop) => {
    let hits = 0, sessions = 0;
    dates.forEach((d, i) => {
      if (dayMs(d) < start || dayMs(d) > stop || !group.days[i].observed) return;
      sessions += daily[i].sessions;
      hits += group.days[i].hits;
    });
    return sessions > 0 ? 100 * Math.min(hits, sessions) / sessions : null;
  };
  const rows = summary.groups.map((group) => {
    const recent = periodRate(group, end - 6 * DAY_MS, end);
    const prior = periodRate(group, end - 13 * DAY_MS, end - 7 * DAY_MS);
    const delta = recent != null && prior != null ? recent - prior : null;
    const cells = calendar.map((d) => {
      const i = index.get(d);
      const day = i == null ? null : group.days[i];
      const sessions = i == null ? 0 : daily[i].sessions;
      const rate = day?.observed && sessions > 0 ? 100 * Math.min(day.hits, sessions) / sessions : null;
      const tip = `${group.name}|${d} · ${mxRateText(rate)}|${day && rate != null ? `${fmt(day.hits)} 命中会话 / ${fmt(sessions)} 会话` : "无观测数据"}`;
      const color = rate == null ? "var(--sev-none)" : `color-mix(in oklab, var(--accent) ${Number(heat(rate)) * 100}%, var(--well))`;
      return `<span class="${rate == null ? "is-missing" : ""}" style="--c:${color}" data-tip="${esc(tip)}"></span>`;
    }).join("");
    return { group, recent, html: `<div class="mxp-heat-row">${group.node.children?.length ? `<button type="button" class="mxp-heat-name" data-heat-node="${esc(group.node.prefix)}" aria-label="下钻 ${esc(group.name)}" title="${esc(group.name)}">${esc(group.name)}<i class="mx-caret" aria-hidden="true"></i></button>` : `<span class="mxp-heat-name" title="${esc(group.name)}">${esc(group.name)}</span>`}<div class="tiles mxp-heat-days">${cells}</div><b class="num">${mxRateText(recent)}</b><span class="mxp-delta num ${delta == null || Math.abs(delta) < 0.05 ? "" : delta > 0 ? "is-up" : "is-down"}" title="较前 7 天变化，单位：百分点">${mxDeltaText(delta)}</span></div>` };
  }).filter(({ group }) => group.days.some((d, i) => d.n > 0 && dayMs(dates[i]) >= end - 29 * DAY_MS))
    .sort((a, b) => (b.recent || 0) - (a.recent || 0));
  const ticks = [0, 7, 14, 21, 29].map((i) => `<span style="grid-column:${i + 1};${i === 29 ? "justify-self:end" : ""}">${calendar[i].slice(5)}</span>`).join("");
  return `${summary.path.length ? `<div class="mxp-heat-nav"><button type="button" class="mx-back" data-heat-back aria-label="返回上一级问题分类">← 返回</button><span>${esc(summary.path[summary.path.length - 1].name)}</span></div>` : ""}<div class="mxp-heat" role="group" aria-label="近 30 天各类问题发生率">
    <div class="mxp-heat-head"><span>问题发生率</span><div class="mxp-heat-dates num">${ticks}</div><span>近 7 天</span><span>变化</span></div>
    ${rows.map((row) => row.html).join("") || '<div class="mxp-chart-empty">暂无带日期的问题</div>'}
  </div>`;
}

function mxRateTrendChart(model, width, selected, height = 232) {
  const last = model.rows[model.rows.length - 1]?.date;
  const from = dayMs(last) - 29 * DAY_MS;
  const days = model.rows.filter((day) => dayMs(day.date) >= from && sum(day.counts) > 0);
  return lineTrendSVG({
    width, height, compact: true, yAxis: true, minTop: 4,
    xLabels: days.map((day) => day.date.slice(5)), xDates: days.map((day) => day.date),
    series: model.levels.filter((level) => selected.includes(level)).map((level) => {
      const i = model.levels.indexOf(level);
      return { level, label: SEV_NAME[level], color: level === "none" ? "var(--muted)" : sevColor(level), values: days.map((day) => day.counts[i]) };
    }),
    aria: "近 30 天各问题等级的 Trace 数量趋势", formatValue: fmt, nebulaDots: 6,
  });
}

function wireMatrixAnalysis(panel, model, state, trend) {
  const chartHost = $(".mxp-rate-chart", panel);
  if (!chartHost) return;
  state.analysisLevels ||= ["P0", "P1"];
  const controls = $(".mxp-levels", panel);
  const paint = () => {
    if (!model?.total) return;
    chartHost._drawer?.destroy();
    const draw = () => {
      const chart = mxRateTrendChart(model, chartHost.clientWidth, state.analysisLevels, 232);
      chartHost.innerHTML = state.analysisLevels.length ? chart.html : '<div class="empty">选择问题等级</div>';
      wireLineTrendChart(chartHost, chart, "", (pick) => drawer.open(pick));
    };
    const drawer = trendSampleDrawer(chartHost, (pick) => loadTraceSamplePage(trend, pick), draw);
    chartHost._drawer = drawer;
    draw();
  };
  paint();
  controls?.addEventListener("click", (event) => {
    const button = event.target.closest(".mxt-chip");
    if (!button) return;
    const selected = new Set(state.analysisLevels);
    if (selected.has(button.dataset.value)) selected.delete(button.dataset.value);
    else selected.add(button.dataset.value);
    state.analysisLevels = WORST.filter((level) => selected.has(level));
    button.setAttribute("aria-pressed", String(selected.has(button.dataset.value)));
    paint();
  });
}

function matrixPerspectiveHTML(view, trend, loading = false, state = {}, clusterRoot) {
  const summary = mxTrendSummary(trend, view, clusterRoot, state);
  const model = traceSeverityModel(trend);
  const shares = model ? traceShares(model.counts) : [];
  const levels = model?.levels || WORST;
  const selected = state.analysisLevels || ["P0", "P1"];
  const empty = loading ? "正在读取趋势…" : model ? "暂无已评测 Trace" : "当前快照缺少 Trace 等级统计";
  const rows = levels.map((key, i) => `<div class="mxp-severity-row" role="row"><span role="cell">${SEV_NAME[key]}</span><div class="mxp-track" role="cell"><i style="--c:${sevColor(key)};width:${shares[i] || 0}%"></i></div><b class="num" role="cell">${model ? fmt(model.counts[i]) : "—"}</b><span class="num" role="cell">${shares[i] == null ? "—" : `${fmt(shares[i], 1)}%`}</span></div>`).join("");
  return `<div class="mxp">
    <div class="mxp-lenses">
      <section class="mxp-lens is-depth">
        <header><b>问题等级</b><small class="mxp-rule">每条 Trace 仅计入最严重等级</small></header>
        <div class="mxp-severity" role="table" aria-label="按最严重等级归类的 Trace 数量与占比">
          <div class="mxp-severity-row mxp-severity-head" role="row"><span role="columnheader">等级</span><span></span><span role="columnheader">Trace 数</span><span role="columnheader">占比</span></div>
          ${rows}
          <div class="mxp-severity-row mxp-severity-total" role="row"><span role="cell">合计</span><span></span><b class="num" role="cell">${model ? fmt(model.total) : "—"}</b><span class="num" role="cell">${model?.total ? "100.0%" : "—"}</span></div>
        </div>
      </section>
      <section class="mxp-lens is-speed">
        <header><b>Trace 趋势</b></header>
        <div class="mxp-levels" role="group" aria-label="选择趋势图的问题等级">${levels.map((level) => trendChip("analysis-level", level, SEV_NAME[level], selected.includes(level), false)).join("")}</div>
        ${trendSampleFrame(`<div class="mpt-chart mxp-rate-chart" data-own-tip>${model?.total ? mxRateTrendChart(model, 340, selected).html : `<div class="empty">${empty}</div>`}</div>`)}
      </section>
    </div>
    <section class="mxp-chart-panel">${mxPerspectiveTimeline(summary, loading)}</section>
  </div>`;
}

/* One line per title: the column pane never gets narrower than its widest title, so a narrow
   card scrolls the pane sideways instead of ending a label in an ellipsis. */
function fitMatrix(m) {
  if (!m) return;
  const labs = $$(".mh .mx-lab", m);
  if (!labs.length) return;
  const need = Math.ceil(Math.max(...labs.map((l) => l.scrollWidth))) + 9; // 4px gap + 5px caret
  m.style.setProperty("--mx-colw", `${need}px`);
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
function swapShell(shell, html, animate, source) {
  if (shell._swapCleanup) shell._swapCleanup();
  const panels = $$(".mx-swap-panel", shell);
  const prev = panels[panels.length - 1];
  if (!animate || REDUCED || !prev) {
    shell.innerHTML = html;
    fitMatrix(shell.querySelector(".matrix"));
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
  ], { duration: 180, easing: "cubic-bezier(0.4, 0, 1, 1)", fill: "forwards" });
  const enter = next.animate([
    { opacity: 1, clipPath: `circle(0px at ${ox}px ${oy}px)`, transform: "scale(0.997)" },
    { opacity: 1, clipPath: `circle(${radius.toFixed(1)}px at ${ox}px ${oy}px)`, transform: "none" },
  ], { duration: 500, delay: 20, easing: ease, fill: "forwards" });
  const resize = from !== to
    ? shell.animate([{ height: `${from}px` }, { height: `${to}px` }], { duration: 500, easing: ease, fill: "forwards" })
    : null;
  const ripple = probe.animate([
    { opacity: 0.6, transform: "translate(-50%, -50%) scale(0.25)" },
    { opacity: 0, transform: "translate(-50%, -50%) scale(9)" },
  ], { duration: 560, easing: ease, fill: "forwards" });
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
  };
  Promise.all([out.finished.catch(() => {}), enter.finished.catch(() => {}), resize ? resize.finished.catch(() => {}) : Promise.resolve()]).then(() => {
    if (token === shell._swapToken && shell._swapCleanup) shell._swapCleanup();
  });
}

/* ---------------------------------------------------------------- 聚类矩阵格子: 就地 P0-P4 时间趋势
   点格子不再跳具体数据：同一个「场景 × 问题聚类」在一张按时间轴的多折线图上看 P0-P4 的
   出现数或出现比例（当日同场景会话里出现该等级问题的会话占比），发版日期画成竖线。
   四层聚类都能点：列节点的任何前缀都在 payload 的 nodes 里。
   口径 / 时间 / 场景是单选；来源 / 模型 / 等级是多选，每条线 = 三个多选值的一组组合：
   颜色 = 等级、虚线 = 模型、明度 = 来源，右侧端点直接标最新值，同等级的两个模型之间
   画差距带并在右端标差值（领导汇报时不用对照 legend）。 */
const TREND_SEV = ["P0", "P1", "P2", "P3", "P4"];
const TREND_MEASURE = { count: "出现数", ratio: "出现比例" };
const TREND_UT_NAME = { all: "全部来源", real: "真实", test: "测试", internal: "内部", unknown: "未知" };
const TREND_TW = 1200;   // 宽屏的上限；实际 viewBox 宽度按容器量出来的像素走，字才不会被缩
const TREND_TH = 260;    // 最小绘图高度；线多时按条数长高，给右侧端点标签留位置
const TREND_PAD = { l: 56, r: 170, t: 16, b: 28 };
const TREND_CACHE = new Map();

/* One payload per (product, build); a rebuild invalidates it through generated_at. */
function loadTrend(c) {
  const key = `${c.product}|${c.data.generated_at}`;
  if (!TREND_CACHE.has(key)) {
    TREND_CACHE.set(key, getJSON(`trends-${c.product}.json`).catch(() => null));
  }
  return TREND_CACHE.get(key);
}

/* AB 轮次同样按 (产品, 构建) 缓存一次：几十 KB，切回来不再请求。 */
const AB_CACHE = new Map();
function loadAB(c, url) {
  const key = `${c.product}|${c.data.generated_at}`;
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
const trendLevelName = (l) => (l === "all" ? "全部问题" : l);
const TREND_UT_SHORT = { all: "全", real: "真", test: "测", internal: "内", unknown: "?" };
const trendUtShort = (u) => TREND_UT_SHORT[u] || trendUtName(u).slice(0, 1);
const trendValue = (v, measure) => {
  if (v == null) return "—";
  return measure === "ratio" ? `${fmt(v, Math.abs(v) >= 10 ? 1 : 2)}%` : fmt(Math.round(v));
};
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
const trendLevelsName = (levels) => (levels && levels.length ? levels.join("+") : "全部问题");
const trendLevelKey = (levels) => (levels && levels.length ? levels.slice().sort().join(",") : "*");
const trendLineName = (trend, line) => `${trendLineSourceName(trend, line)} · ${trendLineModelName(trend, line)} · ${trendLevelsName(line.levels)}`;
const trendSourceKey = (line) => ((line.uts && line.uts.length) ? line.uts.slice().sort().join(",") : "*");
const trendSortValues = (kind, list, data) => {
  const order = kind === "ut" ? (data.uts || []) : (data.models || []);
  return order.filter((v) => list.includes(v));
};

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
const trendSigned = (v, measure) => {
  const a = Math.abs(v);
  const text = measure === "ratio" ? `${fmt(a, a >= 10 ? 1 : 2)}pp` : fmt(Math.round(a));
  return `${v > 0 ? "+" : v < 0 ? "−" : ""}${text}`;
};

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
          // 旧 schema 没有 mask 直方图：多等级命中会话取逐级和与 all-level 并集的较小值近似。
          hits = Math.min(any, s.levelIdxs.reduce((sum, k) => sum + (h[k] || 0), 0));
        }
        s.hits[wi] += hits;
      }
    }
    for (const [d, sc, m, u, nx] of trend.base) {
      if (!spec.scenes.has(sc)) continue;
      const wi = winAt.get(d);
      if (wi == null) continue;
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
  }
  const peak = series.reduce((mx, s) => s.vals.reduce((m, v) => (v != null && v > m ? v : m), mx), 0);
  const top = spec.measure === "ratio" ? trendRatioCeil(peak) : trendCeil(peak);
  const empty = !series.length || !series.some((s) => s.vals.some((v) => v != null));
  return { win, series, top, measure: spec.measure, empty };
}

/* 两条折线只差模型、其他条件一致时，画差距带并在右端标最新差值。 */
function trendPairs(view) {
  const pairs = [];
  for (let i = 0; i < view.series.length; i++) {
    for (let j = i + 1; j < view.series.length; j++) {
      const a = view.series[i];
      const b = view.series[j];
      if (trendLevelKey(a.levels) !== trendLevelKey(b.levels)) continue;
      if (trendSourceKey(a) !== trendSourceKey(b)) continue;
      if (a.models.length !== 1 || b.models.length !== 1 || a.models[0] === b.models[0]) continue;
      let last = -1;
      for (let k = view.win.length - 1; k >= 0; k--) {
        if (a.vals[k] != null && b.vals[k] != null) { last = k; break; }
      }
      if (last < 0) continue;
      const gap = a.vals[last] - b.vals[last];
      pairs.push({
        a, b, i: last, gap,
        hi: gap >= 0 ? a : b,
        color: `color-mix(in oklab, ${a.color} 50%, ${b.color})`,
      });
    }
  }
  return pairs;
}

const trendTextWidth = (text, size = 10.5) => [...String(text)].reduce((w, ch) => {
  const cp = ch.codePointAt(0);
  return w + (cp >= 0x2e80 || "·—".includes(ch) ? size : size * 0.58);
}, 0);

/* A monotone cubic keeps the line soft without inventing overshoot outside neighbouring values. */
function trendCurvePath(points) {
  return monotonePath(points);
}

function trendSVG(view, title, releases, width) {
  const n = view.win.length;
  const series = view.series;
  const pairs = trendPairs(view);
  const TW = Math.max(320, Math.min(TREND_TW, Math.round(width || TREND_TW)));
  const narrow = TW < 640;
  const labelSize = 10.5;
  const fullLabelW = series.reduce((m, s) => s.last < 0 ? m : Math.max(
    m,
    trendTextWidth(s.name, labelSize) + trendTextWidth(trendValue(s.vals[s.last], view.measure), labelSize) + 16,
  ), 0);
  const baseRight = narrow ? 140 : Math.round(Math.max(160, Math.min(220, TW * 0.18)));
  const PAD = {
    l: narrow ? 40 : TREND_PAD.l,
    r: Math.round(Math.min(TW * 0.42, Math.max(baseRight, fullLabelW + 38))),
    // 发版标签要落在绘图区上方，给顶端留一行。
    t: (releases || []).length ? TREND_PAD.t + 14 : TREND_PAD.t,
    b: TREND_PAD.b,
  };
  const compactEnds = narrow || fullLabelW + 38 > PAD.r;
  const TH = Math.max(TREND_TH, Math.min(900, PAD.t + PAD.b + 70 + series.length * 17));
  const innerW = TW - PAD.l - PAD.r;
  const innerH = TH - PAD.t - PAD.b;
  const xOf = (i) => PAD.l + (n > 1 ? (i * innerW) / (n - 1) : innerW / 2);
  const yOf = (v) => PAD.t + innerH - (Math.max(0, Math.min(view.top, v)) / view.top) * innerH;
  const fmtAxis = (v) => (view.measure === "ratio"
    ? `${fmt(v, view.top < 1 ? 2 : view.top < 10 && v % 1 ? 1 : 0)}%`
    : fmt(Math.round(v)));

  let grid = "";
  for (let g = 0; g <= 4; g++) {
    const v = (view.top * g) / 4;
    const y = yOf(v).toFixed(1);
    grid += `<line x1="${PAD.l}" x2="${TW - PAD.r}" y1="${y}" y2="${y}"${g ? "" : ' class="is-base"'} />`;
    grid += `<text class="mxt-ylab" x="${PAD.l - 8}" y="${y}">${fmtAxis(v)}</text>`;
  }
  const tickMax = Math.max(2, Math.min(narrow ? 4 : 7, Math.floor(innerW / 72) + 1));
  const tickCount = Math.min(n, tickMax);
  const ticks = [...new Set(tickCount <= 1 ? [0] : Array.from({ length: tickCount }, (_, k) => Math.round((k * (n - 1)) / (tickCount - 1))))];
  const xlab = ticks.map((i) => `<text class="mxt-xlab" x="${xOf(i).toFixed(1)}" y="${TH - 8}">${esc(view.win[i].d.slice(5))}</text>`).join("");

  // 差距带：只连接两边都有值的日期；没有评测的日期直接跨过去，不把带子切碎。
  let bands = "";
  pairs.forEach((p) => {
    const both = [];
    for (let i = 0; i < n; i++) if (p.a.vals[i] != null && p.b.vals[i] != null) both.push(i);
    if (both.length < 2) return;
    const hi = both.map((k) => `${xOf(k).toFixed(1)},${yOf(Math.max(p.a.vals[k], p.b.vals[k])).toFixed(1)}`);
    const lo = both.slice().reverse().map((k) => `${xOf(k).toFixed(1)},${yOf(Math.min(p.a.vals[k], p.b.vals[k])).toFixed(1)}`);
    bands += `<path class="mxt-band" d="M${hi.join("L")}L${lo.join("L")}Z" style="fill:${p.color};fill-opacity:.075"/>`;
  });

  // 平滑曲线 + 极淡的面积，让升降方向比一串折点更快被读出来；标签则沿右侧独立排布。
  const baseY = PAD.t + innerH;
  const valueMax = Math.max(1, ...series.flatMap((s) => s.vals.filter((v) => v != null)));
  let defs = "", areas = "", nebulas = "", lines = "", dots = "";
  series.forEach((s, gi) => {
    const points = [];
    s.vals.forEach((v, i) => { if (v != null) points.push([xOf(i), yOf(v), v, i]); });
    if (points.length > 1) {
      const curve = trendCurvePath(points);
      const area = `${curve}L${points[points.length - 1][0].toFixed(1)},${baseY.toFixed(1)}L${points[0][0].toFixed(1)},${baseY.toFixed(1)}Z`;
      defs += `<linearGradient id="mxt-area-${gi}" gradientUnits="userSpaceOnUse" x1="0" x2="0" y1="${PAD.t}" y2="${baseY.toFixed(1)}"><stop offset="0" stop-color="${s.color}" stop-opacity=".12"/><stop offset="1" stop-color="${s.color}" stop-opacity="0"/></linearGradient>`;
      areas += `<path class="mxt-area" d="${area}" fill="url(#mxt-area-${gi})"/>`;
      lines += `<path class="mxt-line" d="${curve}" style="stroke:${s.color}"/>`;
    }
    points.forEach(([x, y, value, i]) => {
      const ratio = s.sessions[i] > 0 ? s.hits[i] / s.sessions[i] : value / valueMax;
      nebulas += nebulaCluster({ x, y, value, max: valueMax, ratio, color: s.color, maxDots: 14, spread: 8 });
      dots += `<circle class="mxt-dot" data-trend-point="${gi}:${i}" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.8" style="fill:${s.color}"/>`;
    });
  });

  // 发版日参照线：按真实日期在相邻窗口之间插值（不是就近吸附），线从顶轴贯到底轴，
  // 与下方总体趋势用同一套标记与配色。
  const winTimes = view.win.map((w) => Date.parse(`${w.d}T00:00:00Z`));
  const clampX = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const relMarks = [];
  (releases || []).forEach((r) => {
    const t = Date.parse(`${r && r.date}T00:00:00Z`);
    if (!Number.isFinite(t) || !winTimes.length || t < winTimes[0] || t > winTimes[winTimes.length - 1]) return;
    let k = winTimes.findIndex((time, i) => i === winTimes.length - 1 || winTimes[i + 1] > t);
    if (k < 0) k = winTimes.length - 1;
    const span = winTimes[k + 1] != null ? winTimes[k + 1] - winTimes[k] : 0;
    relMarks.push({ x: xOf(k + (span > 0 ? (t - winTimes[k]) / span : 0)), label: r.label || "发版" });
  });
  relMarks.sort((a, b) => a.x - b.x);
  const relBands = relMarks.map((m) => `<rect class="mxt-release-band" x="${(m.x - 3).toFixed(1)}" y="${PAD.t}" width="6" height="${innerH.toFixed(1)}" rx="3"/>`).join("");
  const relBars = relMarks.map((m) => `<line class="mxt-release-line" x1="${m.x.toFixed(1)}" x2="${m.x.toFixed(1)}" y1="${PAD.t}" y2="${(PAD.t + innerH).toFixed(1)}"/><circle class="mxt-release-dot" cx="${m.x.toFixed(1)}" cy="${PAD.t}" r="2.4"/><circle class="mxt-release-dot" cx="${m.x.toFixed(1)}" cy="${(PAD.t + innerH).toFixed(1)}" r="2.4"/>`).join("");
  const relLabels = relMarks.map((m) => `<text class="mxt-release-label" x="${clampX(m.x, PAD.l + 14, TW - PAD.r - 14).toFixed(1)}" y="${(PAD.t - 9).toFixed(1)}" text-anchor="middle">${esc(m.label)}</text>`).join("");

  // 端点标签：每条线的最新值直接标在右侧，按行距错开，线上不再用 legend。
  const endName = (s) => (compactEnds ? s.shortName : s.name);
  const ends = series.filter((s) => s.last >= 0).map((s) => ({
    s, value: s.vals[s.last], x: xOf(s.last), y: yOf(s.vals[s.last]), ly: yOf(s.vals[s.last]),
    name: endName(s),
  }));
  ends.sort((a, b) => a.ly - b.ly);
  const GAP = 18;
  ends.forEach((e) => { e.ly = Math.max(e.ly, PAD.t); });
  for (let i = 1; i < ends.length; i++) ends[i].ly = Math.max(ends[i].ly, ends[i - 1].ly + GAP);
  const maxY = PAD.t + innerH;
  if (ends.length && ends[ends.length - 1].ly > maxY) {
    ends[ends.length - 1].ly = maxY;
    for (let i = ends.length - 2; i >= 0; i--) ends[i].ly = Math.min(ends[i].ly, ends[i + 1].ly - GAP);
    if (ends[0].ly < PAD.t) {
      const shift = PAD.t - ends[0].ly;
      ends.forEach((e) => { e.ly += shift; });
    }
  }
  const labelX = TW - PAD.r + 10;
  const endsSvg = ends.map((e) => `<g class="mxt-end">
      <line class="mxt-end-line" x1="${e.x.toFixed(1)}" y1="${e.y.toFixed(1)}" x2="${(labelX - 7).toFixed(1)}" y2="${e.ly.toFixed(1)}" style="stroke:${e.s.color}"/>
      <line x1="${(labelX - 1).toFixed(1)}" x2="${(labelX + 8).toFixed(1)}" y1="${e.ly.toFixed(1)}" y2="${e.ly.toFixed(1)}" style="stroke:${e.s.color};stroke-width:2"/>
      <text x="${(labelX + 13).toFixed(1)}" y="${(e.ly + 3.4).toFixed(1)}"><tspan>${esc(e.name)}</tspan><tspan class="mxt-end-val" dx="6">${esc(trendValue(e.value, view.measure))}</tspan></text>
    </g>`).join("");

  // 差距标注：同一等级下两个模型的最新差值，标在差距带右端。
  const gaps = [];
  pairs.forEach((p) => {
    const y1 = yOf(p.a.vals[p.i]);
    const y2 = yOf(p.b.vals[p.i]);
    gaps.push({ p, y: (y1 + y2) / 2, x: xOf(p.i), y1, y2, gap: p.gap });
  });
  gaps.sort((a, b) => a.y - b.y);
  let prevY = -Infinity;
  const gapSvg = gaps.filter((g) => {
    if (g.y - prevY < 16) return false;
    prevY = g.y;
    return true;
  }).map((g) => {
    const delta = view.measure === "ratio" ? `${fmt(Math.abs(g.gap), Math.abs(g.gap) >= 10 ? 1 : 2)}pp` : fmt(Math.round(Math.abs(g.gap)));
    const label = g.gap === 0 ? "持平" : `${g.p.hi.modelName} 高 ${delta}`;
    const labelX = Math.max(PAD.l + trendTextWidth(label, 10) + 4, g.x - 6);
    return `<g class="mxt-gap-g">
      <line class="mxt-gap-line" x1="${g.x.toFixed(1)}" x2="${g.x.toFixed(1)}" y1="${g.y1.toFixed(1)}" y2="${g.y2.toFixed(1)}" style="stroke:${g.p.color}"/>
      <text class="mxt-gap" x="${labelX.toFixed(1)}" y="${(g.y + 3.2).toFixed(1)}" text-anchor="end" style="fill:var(--ink-2)">${esc(label)}</text>
    </g>`;
  }).join("");

  return {
    html: `<svg viewBox="0 0 ${TW} ${TH}" role="img" aria-label="${esc(title)}" data-n="${n}" data-l="${PAD.l}" data-r="${PAD.r}" data-t="${PAD.t}" data-b="${PAD.b}" data-top="${view.top}">
      <defs>${defs}</defs><g class="mxt-grid">${grid}${xlab}</g>${relBands}${areas}${nebulas}${bands}${lines}${dots}${relBars}${relLabels}${endsSvg}${gapSvg}
      <g class="mxt-cursor"><line y1="${PAD.t}" y2="${PAD.t + innerH}"/><g class="mxt-cursor-dots"></g></g></svg>`,
    geo: { W: TW, H: TH, TW, TH, PAD, innerW, innerH, xOf, yOf, xDates: view.win.map((day) => day.d), series: series.map((s) => ({ ...s, label: s.name, values: s.vals })) },
  };
}

/* 悬停：一根竖向游标 + 每条线的点 + 一张把当前日期所有线（以及模型差）列清楚的卡片。 */
function wireTrendHover(plot, view) {
  const svg = $("svg", plot);
  const cursor = svg && $(".mxt-cursor", svg);
  const dots = cursor && $(".mxt-cursor-dots", cursor);
  if (!svg || !cursor || !dots) return;
  const n = Number(svg.dataset.n) || view.win.length;
  const left = Number(svg.dataset.l);
  const right = Number(svg.dataset.r);
  const topPad = Number(svg.dataset.t);
  const botPad = Number(svg.dataset.b);
  const top = Number(svg.dataset.top) || 1;
  const vbw = svg.viewBox.baseVal.width || TREND_TW;
  const vbh = svg.viewBox.baseVal.height || TREND_TH;
  const innerW = vbw - left - right;
  const innerH = vbh - topPad - botPad;
  const xOf = (i) => left + (n > 1 ? (i * innerW) / (n - 1) : innerW / 2);
  const yOf = (v) => topPad + innerH - (Math.max(0, Math.min(top, v)) / top) * innerH;
  const [line] = $$("line", cursor);
  const pairs = trendPairs(view);
  let hovered = -1;

  const tipHTML = (i) => {
    const rows = view.series.filter((s) => s.vals[i] != null);
    const shown = rows.slice(0, 10);
    const label = (s) => s.name;
    const body = shown.map((s) => {
      const extra = view.measure === "ratio"
        ? `<span class="dim">${fmt(s.hits[i])}/${fmt(s.sessions[i])}</span>`
        : `<span class="dim">命中 ${pct(s.hits[i], s.sessions[i], 1)}</span>`;
      return `<div class="t-row"><span class="sev" style="--c:${s.color}"><i></i>${esc(label(s))}</span>
        <b class="num" style="margin-left:auto">${trendValue(s.vals[i], view.measure)}</b>${extra}</div>`;
    }).join("");
    const more = rows.length > shown.length ? `<div class="t-note">还有 ${rows.length - shown.length} 条线</div>` : "";
    const gaps = pairs.filter((p) => p.a.vals[i] != null && p.b.vals[i] != null).slice(0, 6).map((p) => {
      const d = p.a.vals[i] - p.b.vals[i];
      return `<div class="t-row"><span>${esc(`${p.a.levelName} 差`)}</span>
        <b class="num" style="margin-left:auto">${trendSigned(d, view.measure)}</b></div>`;
    }).join("");
    return `<div style="font-weight:var(--w-medium);margin-bottom:6px">${esc(view.win[i].d)}</div>${body}${more}
      ${rows.length ? "" : `<div class="t-note">当日无评测数据</div>`}
      ${gaps ? `<div class="t-note" style="margin:6px 0 2px">模型差（同来源同等级）</div>${gaps}` : ""}`;
  };

  svg.addEventListener("pointermove", (e) => {
    const box = svg.getBoundingClientRect();
    const vx = ((e.clientX - box.left) / box.width) * vbw;
    const i = n <= 1 ? 0 : Math.max(0, Math.min(n - 1, Math.round(((vx - left) / innerW) * (n - 1))));
    const x = xOf(i);
    if (i !== hovered) {
      hovered = i;
      line.setAttribute("x1", x.toFixed(1));
      line.setAttribute("x2", x.toFixed(1));
      dots.innerHTML = view.series
        .filter((s) => s.vals[i] != null)
        .map((s) => `<circle cx="${x.toFixed(1)}" cy="${yOf(s.vals[i]).toFixed(1)}" r="3" style="fill:${s.color}"/>`)
        .join("");
    }
    cursor.classList.add("is-on");
    showTip(tipHTML(i), e.clientX, e.clientY);
  });
  svg.addEventListener("pointerleave", () => {
    cursor.classList.remove("is-on");
    hovered = -1;
    hideTip();
  });
}

/* 条件池：来源、模型可多选合并，等级单选；这些条件共同组成当前选中的那一条折线。
   折线卡片最多 4 条，点卡片切换编辑对象；没有折线时显示待添加状态。 */
function trendChip(kind, value, label, on, draggable = true) {
  return `<button type="button" class="mxt-chip" draggable="${draggable}" data-kind="${kind}" data-value="${esc(value)}" aria-pressed="${on}" aria-label="${esc(label)}">${esc(label)}</button>`;
}

function trendPalette(data, line) {
  const uts = data.uts || [];
  const models = data.models || [];
  return `<div class="mxt-palette">
    <span class="mxt-pickgroup" role="group" aria-label="来源">
      <span class="mxt-pick-label">来源</span>${trendChip("uts", "all", "全部来源", !line.uts.length)}${uts.map((u) => trendChip("uts", u, trendUtName(u), line.uts.includes(u))).join("")}
    </span>
    <span class="mxt-pickgroup" role="group" aria-label="模型">
      <span class="mxt-pick-label">模型</span>${trendChip("models", "all", "全部模型", !line.models.length)}${models.map((m) => trendChip("models", m, trendModelName(data, m) || m, line.models.includes(m))).join("")}
    </span>
    <span class="mxt-pickgroup" role="group" aria-label="等级">
      <span class="mxt-pick-label">等级</span>${[["all", "全部问题"], ...TREND_SEV.map((s) => [s, s])].map(([v]) => trendChip("level", v, v === "all" ? "全部问题" : v, v === "all" ? !line.levels.length : line.levels.includes(v))).join("")}
    </span>
  </div>`;
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

const TREND_SEG_LABEL = { measure: "口径", range: "时间范围", scope: "场景范围" };
const TREND_SEG_TITLE = {
  measure: "出现数 = 该聚类 P0/P1/P2 问题条数；出现比例 = 命中会话占比：当日同场景会话中，出现该聚类该等级问题的会话占比",
  range: "以最近一天为锚点回看；没有评测的日期不补 0，折线按有数据的日期直接相连，避免断裂",
  scope: "本场景 = 点进来的这一行；全部场景 = 整个产品，不按场景拆分",
};

function trendSeg(id, key, items, value) {
  return `<div class="seg mxt-${key}" id="${id}" role="group" aria-label="${TREND_SEG_LABEL[key]}" title="${esc(TREND_SEG_TITLE[key])}">
    <span class="seg-knob" aria-hidden="true"></span>${items
    .map(([v, t]) => `<button type="button" data-value="${esc(v)}" aria-pressed="${v === value}">${esc(t)}</button>`)
    .join("")}</div>`;
}

function trendBodyHTML(data, spec, title) {
  const active = spec.lines[spec.active];
  return `<div class="mxt mx-swap-panel" data-own-tip>
    <div class="mxt-tools">
      ${trendSeg("mxtMeasure", "measure", [["count", TREND_MEASURE.count], ["ratio", TREND_MEASURE.ratio]], spec.measure)}
      ${trendSeg("mxtRange", "range", ["7", "30", "all"].map((v) => [v, RANGE_LABEL[v]]), spec.range)}
      ${trendSeg("mxtScope", "scope", [["row", `本场景：${spec.rowName || "—"}`], ["all", "全部场景"]], spec.scope)}
    </div>
    <div class="mxt-palette" id="mxtPalette">${active ? trendPalette(data, active) : ""}</div>
    <div class="mxt-lines" id="mxtLines">${trendLinesHTML(spec.lines, data, spec.active)}</div>
    ${trendSampleFrame(`<div class="mxt-plot" id="mxtPlot" data-own-tip aria-label="${esc(title)}"></div>`)}
  </div>`;
}

const plotWidth = (box) => ($("#mxtPlot", box) || box).clientWidth;

function paintTrendPlot(box, spec, trend, title) {
  const plot = $("#mxtPlot", box);
  if (!plot) return;
  plot._drawer?.destroy();
  if (!spec.lines.length) {
    plot.innerHTML = `<div class="empty">暂无折线，添加一条折线后显示趋势</div>`;
    return;
  }
  const view = trendSeries(trend, spec);
  if (view.empty) {
    plot.innerHTML = `<div class="empty">暂无趋势数据</div>`;
    return;
  }
  const draw = () => {
    const chart = trendSVG(view, title, trend.releases, plot.clientWidth);
    plot.innerHTML = chart.html;
    wireTrendHover(plot, view);
    wireTrendPointPick(plot, chart.geo, (pick) => drawer.open(pick));
  };
  const drawer = trendSampleDrawer(plot, (pick) => loadTrendSamplePage(trend, spec, pick), draw);
  plot._drawer = drawer;
  draw();
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
  const abBtn = p.ab && tax
    ? `<button type="button" class="link mx-ab" id="mxAB" aria-expanded="false" aria-controls="mxABFace" title="固定题集改版前后对比 + 线上真实用户验证">A/B Test<small>${esc(p.ab.label || "")}</small></button>`
    : "";
  const expandBtn = `<button type="button" class="mx-expand" id="mxExpand" aria-expanded="false" aria-controls="mxPerspective" title="查看问题等级与速率趋势">
    <span>问题分析</span><svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3.5 6l4.5 4 4.5-4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
  </button>`;
  const issueBtn = p.ab && tax ? `<button type="button" class="mx-expand mx-issue-toggle" id="mxIssueTrendsBtn" aria-expanded="false" aria-controls="mxIssueTrends" title="向下展开全部类型、全部场景的问题趋势">
    <span>总体趋势</span><svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3.5 6l4.5 4 4.5-4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
  </button>` : "";
  const matrix = (body, actions = "", chrome = false) => `<article class="card mx-card" id="mxCard" style="--span:12">
    <div class="mx-face mx-matrix-face" id="mxMatrixFace">
      <header class="card-head mx-card-head"><h2>聚类矩阵</h2>${chrome ? `<div class="mx-head-views">${issueBtn}${expandBtn}</div>` : ""}${actions ? `<div class="mx-head-actions">${actions}</div>` : ""}</header>
      ${body}
      ${chrome && p.ab ? `<section class="mx-issue-trends-shell" id="mxIssueTrends" hidden aria-label="全部问题类型趋势"></section>` : ""}
      ${chrome ? `<section class="mx-perspective" id="mxPerspective" hidden aria-label="聚类矩阵问题分析"></section>` : ""}
    </div>
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
    `${abBtn}<button type="button" class="mx-back" id="mxBack" hidden aria-label="返回上一级">← 返回</button>`,
    true,
  );
}

/* ---------------------------------------------------------------- push-pull: one card opens wide, its row mates fold
   Rows keep the 2 + 3 bento. Opening a card widens it (8 of 12 columns) and folds the others in its
   row down to their key numbers; the opened card shows the cases behind what was picked as a star
   map. The move is FLIP + Web Animations: measure, switch the layout, then play every card from its
   old box to its new one on one spring, so neighbours stay edge to edge the whole way. */
const ROW = { vol: "top", eval: "top", attr: "bottom", clu: "bottom", pred: "bottom" };
const WIDE = "(min-width: 1181px)";
const LAYOUT_EASE = window.CSS && CSS.supports && CSS.supports("transition-timing-function", "linear(0, 1)")
  ? "linear(0, 0.012, 0.047 2.6%, 0.18 5.6%, 0.738 17.3%, 0.928 23.1%, 1.012 28.4%, 1.04 33%, 1.042 37.4%, 1.027 43.7%, 1.003 55.8%, 0.996 66.3%, 1)"
  : "cubic-bezier(0.16, 1, 0.3, 1)";
const RESULT = { correct: "正确", wrong: "错误", undetermined: "无法判定", pending: "待揭晓", revealed: "已揭晓" };
const sevIdx = (w) => {
  const i = WORST.indexOf(w);
  return i < 0 ? 5 : i;
};
/* The cases behind an opened card, worst first, beside its star map: a severity (or result) dot, the
   question and its problem count (or verdict). The head is the slice's size and its severity split. */
const LEDGER_MAX = 120;
const predDot = (it) => (it.r === "correct" ? "var(--accent)" : it.r === "wrong" ? "var(--sev-1)" : it.r === "pending" ? "var(--muted)" : "var(--faint)");
function ledger(groups, pred, unit = null) {
  const all = groups.flatMap((g) => g.items);
  const items = pred ? all : [...all].sort((a, b) => a.w - b.w || b.n - a.n || (b.d || "").localeCompare(a.d || ""));
  const parts = pred
    ? ["correct", "wrong", "pending", "undetermined"].map((r) => ({ n: all.filter((it) => (r === "undetermined" ? !["correct", "wrong", "pending"].includes(it.r) : it.r === r)).length, c: predDot({ r }) }))
    : WORST.map((_, i) => ({ n: all.filter((it) => it.w === i).length, c: sevColor(i) }));
  const rows = items.slice(0, LEDGER_MAX).map((it, k) =>
    `<button type="button" class="gl-r${pred ? " is-inert" : ""}" data-i="${k}" style="--i:${Math.min(k, 14)};--c:${pred ? predDot(it) : sevColor(it.w)}"><i></i><span>${esc(it.q || "（无提问）")}</span><b class="num">${pred ? esc(RESULT[it.r] || "") : it.n ? fmt(it.n) : "—"}</b></button>`);
  const body = `<div class="gl-sum"><b class="num">${fmt(all.length)}</b><small>${unit || (pred ? "道预测题" : "个 case")}</small><span class="gl-strip" aria-hidden="true">${parts
    .filter((x) => x.n)
    .map((x) => `<i style="flex:${x.n} 1 0;background:${x.c}"></i>`)
    .join("")}</span></div><div class="gx-list">${rows.join("")}</div>`;
  return { items, body, html: `<div class="gx-side">${body}</div>` };
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
  let trigger = null;
  const clear = () => {
    [map, side].forEach((el) => { el.style.transform = ""; el.style.transformOrigin = ""; el.style.opacity = ""; });
  };
  const change = (next, animate = true) => {
    if (next === opened) return;
    cancel();
    const before = map.getBoundingClientRect();
    opened = next;
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
    (plot.querySelector(`[data-trend-point="${trigger}"]`) || plot.querySelector("[data-trend-point]"))?.focus({ preventScroll: true });
  };
  const head = (date, label) => `<header class="mxt-sample-head"><span>${esc(date)} · ${esc(label)}</span><button type="button" class="mx-back" data-samples-close aria-label="返回趋势图">← 返回</button></header>`;
  const open = async (pick) => {
    const stamp = ++token;
    trigger = `${pick.seriesIndex}:${pick.index}`;
    const title = head(pick.date, pick.series.label);
    side.innerHTML = `${title}<div class="empty">正在读取样本…</div>`;
    change(true);
    $("[data-samples-close]", side)?.focus({ preventScroll: true });
    try {
      const page = await load(pick);
      const paint = (result) => {
        if (stamp !== token || !side.isConnected || !opened) return;
        const led = ledger([{ items: result.items }], false, result.unit);
        const restoreFocus = side.contains(document.activeElement);
        const note = [result.note, result.items.length > LEDGER_MAX ? `展示前 ${LEDGER_MAX} 条` : ""].filter(Boolean).join(" · ");
        side.innerHTML = `${title}${result.items.length ? led.body : '<div class="empty">当前索引中没有匹配样本</div>'}${note ? `<p class="mxt-sample-note">${esc(note)}</p>` : ""}${result.more ? '<button type="button" class="mx-back mxt-sample-more" data-samples-more>加载更多</button>' : ""}`;
        if (restoreFocus) $("[data-samples-close]", side)?.focus({ preventScroll: true });
        side.querySelectorAll(".gl-r").forEach((row) => {
          row.title = led.items[Number(row.dataset.i)].q;
          row.addEventListener("click", async () => {
            const item = led.items[Number(row.dataset.i)];
            // An AB drawer opens the paired compare view; every other drawer stays on 具体数据.
            if (interaction.openItem) { interaction.openItem(item); return; }
            let trace = item.trace;
            if (!trace && item.turn != null) {
              try { trace = (await loadSample(item.s)).attribution?.turns?.[item.turn]?.trace_id; }
              catch { /* The sample page can still open the selected case. */ }
            }
            openSamples({ case: item.s, trace: trace || null });
          });
        });
        $("[data-samples-more]", side)?.addEventListener("click", async (event) => {
          event.target.disabled = true;
          try { paint(await result.more()); }
          catch { if (stamp === token) { event.target.disabled = false; event.target.textContent = "重试"; } }
        });
      };
      paint(page);
    } catch {
      if (stamp !== token || !side.isConnected || !opened) return;
      side.innerHTML = `${title}<div class="empty">样本读取失败</div><button type="button" class="mx-back" data-samples-retry>重试</button>`;
      $("[data-samples-retry]", side)?.addEventListener("click", () => open(pick));
    }
  };
  side.onclick = (event) => { if (event.target.closest("[data-samples-close]")) close(); };
  frame.onkeydown = (event) => { if (event.key === "Escape" && opened) { event.preventDefault(); event.stopPropagation(); close(); } };
  return { open, destroy: () => { token++; cancel(); opened = false; layout.classList.remove("is-open", "is-closing"); side.hidden = true; side.innerHTML = ""; map.inert = false; map.removeAttribute("aria-hidden"); clear(); } };
}

async function loadTrendSamplePage(trend, spec, pick) {
  const product = ctx.product;
  const index = await ctx.loadIndex(product);
  const series = pick.series;
  const candidates = trendSampleCandidates(index.products?.[product]?.rows || [], {
    date: pick.date, node: spec.node, models: series.models, uts: series.uts,
    scenes: !spec.scenes || spec.scenes.size === trend.scenes.length ? null : [...spec.scenes].map((i) => trend.scenes[i]),
  });
  let offset = 0, failures = 0;
  const items = [];
  const more = async () => {
    const batch = candidates.slice(offset, offset + 40);
    offset += batch.length;
    // Bound detail requests; a large spike must not launch hundreds of fetches at once.
    for (let start = 0; start < batch.length; start += 8) {
      const results = await Promise.allSettled(batch.slice(start, start + 8).map(async (row) => {
        const detail = await loadSample(row.s);
        const problems = trendSampleProblems(detail, spec.node, series.levelIdxs.map((i) => TREND_SEV[i]));
        if (!problems.length) return null;
        return { ...caseItem(row), n: problems.length, w: Math.min(...problems.map((problem) => sevIdx(problem.sev))) };
      }));
      results.forEach((result) => { if (result.status === "rejected") failures++; else if (result.value) items.push(result.value); });
    }
    return {
      items, unit: "个 case",
      note: [offset < candidates.length ? `已检查 ${fmt(offset)} / ${fmt(candidates.length)} 个候选样本` : "", failures ? `${fmt(failures)} 条读取失败` : ""].filter(Boolean).join(" · "),
      more: offset < candidates.length && items.length < LEDGER_MAX ? more : null,
    };
  };
  return more();
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
  return { items, unit: "条 Trace", note: items.length < refs.length ? `当前索引可查看 ${fmt(items.length)} / ${fmt(refs.length)} 条 Trace` : "", more: null };
}

async function loadABTrendSamplePage(spec, pick) {
  const { round, sides } = pick.series.samples[pick.index];
  if (!round.sample_refs) return { items: [], note: "当前快照缺少 A/B 样本关联" };
  const refs = abTrendSampleRefs(round, sides, spec.row, spec.node);
  const index = await ctx.loadIndex(ctx.product);
  const rows = index.products?.[ctx.product]?.rows || [];
  const { items, unavailable } = resolveABSamples(refs, rows, spec.node);
  return {
    items: items.map(({ row, trace, n, ref }) => ({ ...caseItem(row), trace, n, ref, pair: ref.pair || ref.trace, round: spec.round?.id })), unit: "个样本",
    note: unavailable ? `${fmt(unavailable)} 个样本缺少对应评测详情` : "",
  };
}

function mountSampleTrend(plot, renderChart, load, interaction = {}) {
  let dispose = () => {};
  const draw = () => {
    dispose();
    const chart = renderChart(plot.clientWidth);
    plot.innerHTML = chart.html;
    dispose = wireLineTrendChart(plot, chart, "", (pick) => drawer.open(pick), interaction);
  };
  const drawer = trendSampleDrawer(plot, load, draw, interaction);
  draw();
  return {
    destroy: () => { dispose(); drawer.destroy(); },
    // Recall a source the chart may not draw as its own point (e.g. online samples while the
    // matrix shows the paired change). The pick's series carries the sides to load.
    openPick: (pick) => drawer.open(pick),
  };
}

function mountABCellTrend(plot, spec) {
  return mountSampleTrend(plot, (width) => lineTrendSVG({ ...spec.chart, width }), (pick) => loadABTrendSamplePage(spec, pick), {
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
    if (rings[cur.card]) return rings[cur.card].up(); // the ring reports back through fromRing
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
    const spec = card === "vol" ? volSpec(focus, opened) : cluSpec(focus, opened);
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
    } else if (cur && cur.card === card) {
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
  const sceneKey = (r) => r.sub || r.sc || r.skill || "未接入分类体系";

  async function groupsFor(spec) {
    if (spec.card === "pred") {
      const items = ((p.prediction || {}).items || []).filter((it) =>
        spec.kind === "model" ? it.v === spec.key : spec.kind === "cause" ? it.e === spec.key : true);
      const by = new Map();
      items.forEach((it) => {
        if (!by.has(it.t)) by.set(it.t, { key: it.t, name: it.t, items: [] });
        by.get(it.t).items.push({ ...it, inert: true, n: 0 });
      });
      return [...by.values()];
    }
    const all = await rows();
    if (spec.card === "vol") {
      const picked = all.filter((r) => (!spec.model || r.m === spec.model) &&
        (spec.task ? (r.task || "未接入分类体系") === spec.task : spec.others ? !spec.others.includes(r.task || "未接入分类体系") : true));
      return groupCases(picked, spec.task || spec.others ? sceneKey : (r) => r.task || r.sc || r.skill || "未接入分类体系");
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

  const caseTip = (it) => `<div style="font-weight:var(--w-medium);margin-bottom:6px;max-width:300px;white-space:normal;line-height:1.5">${esc(it.q || "（无提问）")}</div>
    <div class="t-row"><span class="sev" style="--c:${sevColor(it.w)}"><i></i>${SEV_NAME[WORST[it.w]]}</span><span>${esc(modelName(p, it.m))} · ${esc((it.d || "").slice(5))}</span><b class="num" style="margin-left:auto">${it.n ? `${fmt(it.n)} 个问题` : "无问题"}</b></div>`;
  const predTip = (it) => `<div style="font-weight:var(--w-medium);margin-bottom:6px;max-width:300px;white-space:normal;line-height:1.5">${esc(it.q || "")}</div>
    <div class="t-row"><span>${esc(modelName(p, it.v))}</span><span>${esc(RESULT[it.r] || it.r || "")}</span>${it.e ? `<span class="dim">${esc(it.e)}</span>` : ""}</div>`;
  const predColor = (it, c) => (it.r === "correct" ? c.accent : it.r === "wrong" ? c.sev[1] : it.r === "pending" ? c.muted : c.faint);

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
      gx.innerHTML = `<div class="empty">暂无已评测的 case</div>`;
      return;
    }
    const pred = spec.card === "pred";
    const led = ledger(groups, pred);
    gx.innerHTML = `<div class="gx-in"><div class="gx-map"></div>${led.html}</div>`;
    const list = $(".gx-list", gx);
    const rowOf = new Map(led.items.slice(0, LEDGER_MAX).map((it, i) => [it, i]));
    let lit = null;
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
      onPick: pred ? null : (it) => openSamples({ case: it.s }),
      onHover: light,
    });
    const rowItem = (e) => {
      const r = e.target.closest(".gl-r");
      return r ? led.items[Number(r.dataset.i)] : null;
    };
    list.addEventListener("pointermove", (e) => {
      const it = rowItem(e);
      if (!it) return;
      map.mark(it);
      showTip((pred ? predTip : caseTip)(it), e.clientX, e.clientY);
    });
    list.addEventListener("pointerleave", () => {
      map.mark(null);
      hideTip();
    });
    list.addEventListener("click", (e) => {
      const it = rowItem(e);
      if (it && !pred) openSamples({ case: it.s });
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
    if (e.target.closest('[data-card="pred"] [data-pane="vol"] .comp')) toggle({ card: "pred", id: "pred|all", kind: "all", key: null });
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
    new ResizeObserver(() => {
      if (Math.abs(field.clientWidth - fieldW) < 2) return;
      fieldW = field.clientWidth;
      field._page = u.field.pages = [];
      paintField(field, p, u.field.w);
    }).observe(field);
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
  if (shell && tax) {
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
      swapShell(shell, matrixTable(mxView), animate, source);
      const back = $("#mxBack", bento);
      if (back) {
        back.textContent = "← 返回上一级";
        back.hidden = rowPath.length === 1 && colPath.length === 1;
      }
      renderPerspective();
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
      new ResizeObserver(() => {
        const m = shell.querySelector(".matrix:last-of-type");
        if (m && !shell.classList.contains("is-swapping")) fitMatrix(m);
      }).observe(shell);
    }

    /* ---- 格子的就地趋势：同一个 shell 里把表换成图，返回时按原来的行列路径重画矩阵 ---- */
    u.mx.trend = u.mx.trend || { open: false, measure: "count", range: "30", scope: "row", lines: [], active: 0, seeded: false };
    const trend = u.mx.trend;
    let trendToken = 0;
    const trendTitle = (row, node) => `${row.name} · ${patName(tax, node) || node} 的时间趋势`;
    const trendSpec = (row) => ({
      node: trend.node,
      rowName: row ? row.name : "",
      // 「全部场景」看整个产品在这个聚类上的问题率，不按点进来的那一行过滤。
      scope: trend.scope === "all" ? "all" : "row",
      scenes: trendScenes(trendData, row, trend.scope === "all" ? "all" : "row"),
      measure: trend.measure, range: trend.range,
      lines: trend.lines, active: trend.active,
    });
    let trendData = null;
    const perspectiveEl = $("#mxPerspective", bento);
    const expandBtn = $("#mxExpand", bento);
    const issueEl = $("#mxIssueTrends", bento);
    const issueBtn = $("#mxIssueTrendsBtn", bento);
    let perspectiveToken = 0;
    let perspectiveLoading = false;
    let issueData = null;
    let issueLoading = false;
    let issueToken = 0;
    const panelCard = shell.closest(".mx-card");
    let cancelPanelMotion = () => {};
    let paintedCardHeight = null;

    // Commit layout once, then move the following cards with transforms. The card surface and
    // incoming content reveal on the sunburst clock; no per-frame height/layout work is needed.
    function layoutPanels(update, animate = true) {
      const followers = [...bento.children].slice([...bento.children].indexOf(panelCard) + 1);
      const before = followers.map((el) => ({ el, top: el.getBoundingClientRect().top }));
      const beforeBox = panelCard.getBoundingClientRect();
      const beforeHeight = paintedCardHeight ?? beforeBox.height;
      cancelPanelMotion();
      const previous = [issueEl, perspectiveEl].find((el) => el && !el.hidden);
      const previousBox = previous?.getBoundingClientRect();
      const faceBox = panelCard.querySelector(".mx-matrix-face").getBoundingClientRect();
      bento.style.overflowAnchor = "none";
      update();
      if (!animate || REDUCED) {
        bento.style.overflowAnchor = "";
        return;
      }
      const afterHeight = panelCard.getBoundingClientRect().height;
      const jobs = before.map(({ el, top }) => ({ el, dy: top - el.getBoundingClientRect().top }));
      const incoming = [issueEl, perspectiveEl].find((el) => el && !el.hidden);
      const outgoing = previous?.hidden ? previous : null;
      if (outgoing) {
        outgoing.hidden = false;
        outgoing.inert = true;
        outgoing.setAttribute("aria-hidden", "true");
        Object.assign(outgoing.style, { position: "absolute", top: `${previousBox.top - faceBox.top}px`, left: `${previousBox.left - faceBox.left}px`, width: `${previousBox.width}px`, pointerEvents: "none" });
      }
      const surface = document.createElement("div");
      surface.className = "mx-motion-surface";
      surface.setAttribute("aria-hidden", "true");
      const surfaceHeight = Math.max(beforeHeight, afterHeight);
      surface.style.height = `${surfaceHeight}px`;
      panelCard.prepend(surface);
      panelCard.classList.add("is-panel-moving");
      const clearPanel = (el) => {
        if (!el) return;
        ["position", "top", "left", "width", "pointerEvents", "opacity", "transform", "clipPath"].forEach((key) => { el.style[key] = ""; });
      };
      const clean = () => {
        jobs.forEach(({ el }) => { el.style.transform = ""; });
        clearPanel(incoming);
        clearPanel(outgoing);
        if (outgoing) {
          outgoing.hidden = true;
          outgoing.inert = false;
          outgoing.removeAttribute("aria-hidden");
        }
        surface.remove();
        panelCard.classList.remove("is-panel-moving");
        bento.style.overflowAnchor = "";
        paintedCardHeight = null;
      };
      const cancel = sunburstTween((k) => {
        paintedCardHeight = beforeHeight + (afterHeight - beforeHeight) * k;
        surface.style.transform = `scaleY(${paintedCardHeight / surfaceHeight})`;
        jobs.forEach(({ el, dy }) => { if (Math.abs(dy) > 0.5) el.style.transform = `translateY(${dy * (1 - k)}px)`; });
        if (incoming && incoming !== previous) {
          incoming.style.clipPath = `inset(0 0 ${(1 - k) * 100}% 0)`;
          incoming.style.opacity = String(0.4 + 0.6 * k);
          incoming.style.transform = `translateY(${-4 * (1 - k)}px)`;
        }
        if (outgoing) {
          outgoing.style.clipPath = `inset(0 0 ${k * 100}% 0)`;
          outgoing.style.opacity = String(1 - k);
        }
      }, { finish: clean });
      cancelPanelMotion = () => { cancel(); clean(); };
    }

    function renderIssueTrends(reveal = true) {
      if (!issueEl || !u.mx.issueOpen || !issueData) return;
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
      if (!issueEl || !u.mx.issueOpen || issueLoading || issueData) return;
      issueLoading = true;
      const token = ++issueToken;
      const data = await loadTrend(ctx);
      if (token !== issueToken) return;
      issueLoading = false;
      issueData = data?.dates?.length ? data : null;
      if (u.mx.issueOpen && issueEl.isConnected) {
        if (issueData) renderIssueTrends();
        else layoutPanels(() => { issueEl.innerHTML = `<div class="mx-issue-loading"><div class="empty">暂无问题趋势数据</div></div>`; });
      }
    }

    function renderPerspective(loading = perspectiveLoading, reveal = true) {
      if (!perspectiveEl || !u.mx.expanded || !mxView) return;
      const update = () => { perspectiveEl.innerHTML = `<div class="mx-perspective-inner">${matrixPerspectiveHTML(mxView, trendData, loading, u.mx, clusterRoot)}</div>`; };
      if (reveal) layoutPanels(update);
      else update();
      wireMatrixAnalysis(perspectiveEl, traceSeverityModel(trendData), u.mx, trendData);
      const heatPanel = $(".mxp-chart-panel", perspectiveEl);
      heatPanel.onclick = (event) => {
        const down = event.target.closest("[data-heat-node]");
        const back = event.target.closest("[data-heat-back]");
        if (!down && !back) return;
        const current = mxTrendSummary(trendData, mxView, clusterRoot, u.mx);
        const keys = (current?.path || []).map((node) => node.prefix);
        u.mx.heatPath = down ? [...keys, down.dataset.heatNode] : keys.slice(0, -1);
        heatPanel._cancelHeat?.();
        layoutPanels(() => { heatPanel.innerHTML = mxPerspectiveTimeline(mxTrendSummary(trendData, mxView, clusterRoot, u.mx), false); });
        const clear = () => { heatPanel.style.opacity = ""; heatPanel.style.transform = ""; };
        const cancel = sunburstTween((k) => { heatPanel.style.opacity = String(.4 + .6 * k); heatPanel.style.transform = `translateY(${-4 * (1 - k)}px)`; }, { finish: clear });
        heatPanel._cancelHeat = () => { cancel(); clear(); };
        const focus = down ? $("[data-heat-back]", heatPanel) : $(`[data-heat-node="${keys[keys.length - 1]}"]`, heatPanel);
        focus?.focus({ preventScroll: true });
      };
    }

    async function hydratePerspective() {
      if (!perspectiveEl || !u.mx.expanded || trendData || perspectiveLoading) return;
      perspectiveLoading = true;
      const token = ++perspectiveToken;
      const data = await loadTrend(ctx);
      if (token !== perspectiveToken) return;
      perspectiveLoading = false;
      if (data?.dates?.length) {
        trendData = data;
        trendData.modelLabels = data.modelLabels || (p.models || []).map((m) => ({ id: m.id, label: m.label }));
      }
      if (u.mx.expanded && perspectiveEl.isConnected) renderPerspective(false);
    }

    function setMatrixPanel(kind, open, animate) {
      layoutPanels(() => {
        u.mx.issueOpen = kind === "issue" && open;
        u.mx.expanded = kind === "perspective" && open;
        if (issueEl && issueBtn) {
          issueEl.hidden = !u.mx.issueOpen;
          issueBtn.setAttribute("aria-expanded", String(u.mx.issueOpen));
        }
        if (perspectiveEl && expandBtn) {
          perspectiveEl.hidden = !u.mx.expanded;
          expandBtn.setAttribute("aria-expanded", String(u.mx.expanded));
          expandBtn.querySelector("span").textContent = u.mx.expanded ? "收起分析" : "问题分析";
        }
        if (u.mx.issueOpen) {
          if (issueData) renderIssueTrends(false);
          else issueEl.innerHTML = `<div class="mx-issue-loading"><div class="empty">正在读取问题趋势…</div></div>`;
        }
        if (u.mx.expanded) renderPerspective(!trendData, false);
      }, animate);
      if (u.mx.issueOpen) hydrateIssueTrends();
      if (u.mx.expanded) hydratePerspective();
    }
    const setIssueTrends = (open, animate = true) => setMatrixPanel("issue", open, animate);
    const setPerspective = (open, animate = true) => setMatrixPanel("perspective", open, animate);

    function trendFrame(row, animate = true, source = null) {
      const spec = trendSpec(row);
      const title = trendTitle(row, spec.node);
      swapShell(shell, trendBodyHTML(trendData, spec, title), animate, source);
      const box = $(".mxt", shell);
      const paintPlot = () => paintTrendPlot(box, trendSpec(row), trendData, title);
      const bind = (id, key) => {
        const el = $(`#${id}`, box);
        if (!el) return;
        const seg = segmented(el, (v) => {
          trend[key] = v;
          paintPlot();
        });
        seg.set(String(trend[key]), { silent: true });
      };
      bind("mxtMeasure", "measure");
      bind("mxtRange", "range");
      bind("mxtScope", "scope");
      // 条件池编辑当前选中的折线；点卡片切换，拖条件到卡片也能改；最多 4 条，可删到 0 条。
      const paletteEl = $("#mxtPalette", box);
      const linesEl = $("#mxtLines", box);
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
      box.addEventListener("click", (e) => {
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
      box.addEventListener("keydown", (e) => {
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
      box.addEventListener("dragstart", (e) => {
        const chip = e.target.closest(".mxt-chip");
        if (!chip) return;
        e.dataTransfer.setData("text/plain", JSON.stringify({ kind: chip.dataset.kind, value: chip.dataset.value }));
        e.dataTransfer.effectAllowed = "copy";
        chip.classList.add("is-dragging");
        box.classList.add("is-dragging");
      });
      box.addEventListener("dragend", (e) => {
        const chip = e.target.closest(".mxt-chip");
        if (chip) chip.classList.remove("is-dragging");
        box.classList.remove("is-dragging");
        $$(".mxt-linecard.is-over", box).forEach((el) => el.classList.remove("is-over"));
      });
      box.addEventListener("dragover", (e) => {
        if (!box.classList.contains("is-dragging")) return;
        const card = e.target.closest(".mxt-linecard");
        if (!card) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        $$(".mxt-linecard.is-over", box).forEach((el) => { if (el !== card) el.classList.remove("is-over"); });
        card.classList.add("is-over");
      });
      box.addEventListener("dragleave", (e) => {
        const card = e.target.closest(".mxt-linecard");
        if (card && !card.contains(e.relatedTarget)) card.classList.remove("is-over");
      });
      box.addEventListener("drop", (e) => {
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

    async function openTrend(row, col, source = null) {
      const node = col.prefix || col.pat;
      if (!node) return;
      hideTip();
      trend.open = true;
      trend.node = node;
      trend.rowName = row.name;
      trend.colPrefix = node;
      trend.rowKeys = rowPath.slice(1).map(rowKey);
      trend.colKeys = colPath.slice(1).map(colKey);
      const backBtn = $("#mxBack", bento);
      if (backBtn) {
        backBtn.textContent = "← 返回矩阵";
        backBtn.hidden = false;
      }
      shell.classList.add("is-probing");
      $$(".mx-trend-probe", shell).forEach((el) => el.remove());
      const status = document.createElement("span");
      status.className = "mx-trend-probe";
      status.textContent = "正在读取趋势";
      shell.appendChild(status);
      if (source && source.getBoundingClientRect && !REDUCED) {
        const box = shell.getBoundingClientRect();
        const src = source.getBoundingClientRect();
        const probe = document.createElement("i");
        probe.className = "mx-swap-probe";
        probe.style.left = `${Math.max(12, Math.min(box.width - 12, src.left + src.width / 2 - box.left))}px`;
        probe.style.top = `${Math.max(12, Math.min(box.height - 4, src.top + src.height / 2 - box.top))}px`;
        shell.appendChild(probe);
        probe.animate([
          { opacity: 0.7, transform: "translate(-50%, -50%) scale(0.3)" },
          { opacity: 0, transform: "translate(-50%, -50%) scale(9)" },
        ], { duration: 460, easing: "cubic-bezier(0.16, 1, 0.3, 1)", fill: "forwards" }).finished.catch(() => {}).then(() => probe.remove());
      }
      const token = ++trendToken;
      const data = await loadTrend(ctx);
      if (token !== trendToken || !trend.open || !shell.isConnected) return;
      shell.classList.remove("is-probing");
      $$(".mx-trend-probe, .mx-swap-probe", shell).forEach((el) => el.remove());
      if (!data || !data.dates || !data.dates.length) {
        swapShell(shell, `<div class="mxt mx-swap-panel"><div class="empty">暂无趋势数据</div></div>`, true, source);
        return;
      }
      trendData = data;
      trendData.modelLabels = data.modelLabels || (p.models || []).map((m) => ({ id: m.id, label: m.label }));
      normalizeTrend(trend, data);
      trendFrame(row, true, source);
    }

    function closeTrend(source = null) {
      trend.open = false;
      trendToken += 1;
      shell.classList.remove("is-probing");
      $$(".mx-trend-probe, .mx-swap-probe", shell).forEach((el) => el.remove());
      paint(true, source);
    }

    paint(false);
    if (perspectiveEl && expandBtn) {
      expandBtn.addEventListener("click", () => setPerspective(!u.mx.expanded, true));
      if (u.mx.expanded) setPerspective(true, false);
    }
    if (issueEl && issueBtn) {
      issueBtn.addEventListener("click", () => setIssueTrends(!u.mx.issueOpen, true));
      if (u.mx.issueOpen) setIssueTrends(true, false);
    }
    // 就地刷新或切产品回来：路径还在，趋势也重新打开在同一格上。
    if (trend.open && trend.node) {
      const row = (mxView.rows || []).find((x) => x.name === trend.rowName);
      const col = (mxView.cols || []).find((x) => (x.prefix || x.pat) === trend.colPrefix)
        || { name: patName(tax, trend.node) || trend.node, prefix: trend.node };
      if (row) openTrend(row, col);
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
            .map(([pid, n]) => `<div class="t-row"><span>${esc((tax.patterns[pid] || {}).name || pid)}</span><b class="num" style="margin-left:auto">${fmt(n)}</b></div>`)
            .join("");
      return `<div style="font-weight:var(--w-medium);margin-bottom:6px">${esc(row.name)} · ${esc(col.name)}</div>
        <div class="t-row"><span>问题</span><b class="num" style="margin-left:auto">${fmt(cell.n)}</b></div>
        <div class="t-row"><span>会话</span><b class="num" style="margin-left:auto">${fmt(cell.sessions)}</b></div>
        ${top ? `<div class="mx-tip-pats">${top}</div>` : ""}`;
    }
    if (!t.dataset.cell) return null;
    const [g, i] = t.dataset.cell.split(":").map(Number);
    const c = p.field[g].cells[i];
    return `<div style="font-weight:var(--w-medium);margin-bottom:4px">${esc(c[3])}</div>
      <div class="t-row"><span class="sev" style="--c:${sevColor(c[1])}"><i></i>${SEV_NAME[WORST[c[1]]]}</span>
      <span>${esc(groupName(p, p.field[g]))}</span>${c[4] ? `<span class="dim">流失用户</span>` : ""}<b class="num" style="margin-left:auto">${c[2]} 个问题</b></div>`;
  });

  /* A/B Test: 聚类矩阵卡原位翻转成背面的对比面板，返回时再翻回矩阵。
     数据按需拉一次；展开状态活在 u.ab 上，就地刷新后还停在原来那一期、步骤和格子。 */
  const abBtn = $("#mxAB", bento);
  const mxCard = $("#mxCard", bento);
  const matrixFace = $("#mxMatrixFace", bento);
  const abFace = $("#mxABFace", bento);
  const abBody = $("#abBody", bento);
  if (abBtn && mxCard && matrixFace && abFace && abBody && p.ab) {
    u.ab = u.ab || { open: false, round: -1, step: "summary", metric: "", rows: [], cols: [], cell: null };
    let targetBack = !abFace.hidden;
    let flipping = false;
    let loading = false;
    let loaded = false;
    const setFace = (back) => {
      matrixFace.hidden = back;
      abFace.hidden = !back;
      mxCard.classList.toggle("is-ab", back);
      abBtn.setAttribute("aria-expanded", String(back));
    };
    const wait = (anim) => (anim && anim.finished ? anim.finished.catch(() => {}) : Promise.resolve());
    const flipOnce = async (back) => {
      if (REDUCED || !mxCard.animate) return setFace(back);
      const oldH = mxCard.getBoundingClientRect().height;
      const out = mxCard.animate([
        { transform: "perspective(1600px) translateZ(0) rotateX(0deg) scale(1)", opacity: 1 },
        { transform: "perspective(1600px) translateZ(-18px) rotateX(2deg) scale(0.99)", opacity: 0 },
      ], { duration: 150, easing: "cubic-bezier(0.4, 0, 1, 1)", fill: "forwards" });
      await wait(out);
      out.cancel();
      setFace(back);
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
    const requestFace = async (back) => {
      targetBack = back;
      if (flipping) return;
      flipping = true;
      mxCard.classList.add("is-flipping");
      try {
        while (targetBack !== !abFace.hidden) await flipOnce(targetBack);
      } finally {
        flipping = false;
        mxCard.classList.remove("is-flipping");
      }
    };
    const hydrateAB = async () => {
      if (loaded || loading) return;
      loading = true;
      const data = await loadAB(ctx, p.ab.url);
      if (!data || !data.rounds || !data.rounds.length) {
        abBody.innerHTML = `<div class="empty">暂无 AB 测试数据</div>`;
        loaded = true;
        loading = false;
        return;
      }
      mountAB(abBody, data, u.ab, tax, p, { openCompare, mountCellTrend: mountABCellTrend });
      loaded = true;
      loading = false;
    };
    /* Fullscreen keeps the reader inside the same card: it leaves the bento, covers the viewport and
       returns to its slot on Esc or the same icon, so no second panel is mounted. */
    const fullBtn = $("#abFull", mxCard);
    const setFull = (on, animate = true) => {
      const had = mxCard.classList.contains("is-full");
      u.ab.full = on;
      if (had === on) return;
      const first = animate && !REDUCED ? mxCard.getBoundingClientRect() : null;
      mxCard.classList.toggle("is-full", on);
      document.body.classList.toggle("is-ab-full", on);
      if (fullBtn) {
        fullBtn.setAttribute("aria-pressed", String(on));
        const label = on ? "退出全屏" : "全屏查看 A/B Test";
        fullBtn.setAttribute("aria-label", label);
        fullBtn.title = on ? "退出全屏" : "全屏";
      }
      if (!first) return;
      const last = mxCard.getBoundingClientRect();
      mxCard.animate([
        { transform: `translate(${first.left - last.left}px, ${first.top - last.top}px) scale(${first.width / Math.max(1, last.width)}, ${first.height / Math.max(1, last.height)})`, transformOrigin: "0 0" },
        { transform: "none" },
      ], { duration: 360, easing: "cubic-bezier(0.16, 1, 0.3, 1)" });
    };
    const closeAB = () => {
      u.ab.open = false;
      setFull(false, false);
      requestFace(false);
    };
    const openAB = async () => {
      u.ab.open = true;
      await requestFace(true);
      if (u.ab.open) hydrateAB();
    };
    abBtn.addEventListener("click", () => (u.ab.open ? closeAB() : openAB()));
    $("#abClose", mxCard).addEventListener("click", closeAB);
    if (fullBtn) fullBtn.addEventListener("click", () => setFull(!u.ab.full));
    const onDocKey = (e) => {
      if (e.key !== "Escape" || !u.ab.open || !mxCard.isConnected) return;
      if (u.ab.full) setFull(false);
      else closeAB();
    };
    if (abDocKey) document.removeEventListener("keydown", abDocKey);
    abDocKey = onDocKey;
    document.addEventListener("keydown", abDocKey);
    if (u.ab.open) {
      setFace(true);
      targetBack = true;
      if (u.ab.full) setFull(true, false);
      hydrateAB();
    }
  }
}
