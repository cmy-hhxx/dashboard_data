/* 数据: 会话场 · 数据量 · 评测量 · 归因体系 · 聚类体系 · 预测体系 · 聚类矩阵. Titles only; the layout carries the rest.
   Charts drill in place; a session tile or a matrix cell opens 具体数据 with that case / filter set. */
import { $, $$, esc, fmt, pct, sum, WORST, SEV_NAME, sevColor, counter, runCounters, bindTips, segmented, REDUCED } from "./core.js";
import { sunburst } from "./sunburst.js";
import { galaxy } from "./galaxy.js";

let ctx;
let shown = null;
let lastDetail = null;
/* View state per product that outlives a redraw: an in-place data refresh (or switching product
   and back) lands on the same filter, page, ring, drill path and tab. */
const UI = {};
const ui = (product) =>
  (UI[product] = UI[product] || { field: { w: null, pages: [] }, vol: {}, clu: {}, mx: { rows: [], cols: [], trail: [] }, pred: "vol" });
const SPLIT_SHORT = { daily: "日常", lost: "流失" };
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
  if (!p) {
    root.innerHTML = `<div class="bento"><article class="card" style="--span:12"><div class="empty">${
      c.product === "wencai" ? "问财" : "AIME"
    } 暂无评测数据。把数据放入 datasets/ 后运行 local_dev/refresh.sh。</div></article></div>`;
    return;
  }
  if (detail) {
    const state = evalDetailState(p, { ed, em, ep, edp });
    const indexP = c.loadIndex(c.product).catch(() => null);
    const index = state.model ? await indexP : null;
    root.innerHTML = evalDetailPage(p, state, index);
    wireEvalDetail(root, state);
    window.scrollTo(0, 0);
    lastDetail = true;
    return;
  }
  const tax = c.data.taxonomy;
  const u = ui(c.product);
  if (c.refresh) root.classList.add("is-refresh");
  root.innerHTML = `<div class="bento">${fieldCard(p, u)}${volumeCard(p)}${evalCard(p)}${attrCard(p)}${clusterCard(p, tax)}${predictCard(p)}${matrixCard(p, tax)}</div>`;
  wire($(".bento", root), p, tax, u);
  if (c.refresh) requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove("is-refresh")));
  else runCounters(root);
  if (lastDetail) {
    window.scrollTo(0, 0);
    lastDetail = null;
  }
}

const card = (span, title, body, end = "", key = "") =>
  `<article class="card" style="--span:${span}"${key ? ` data-card="${key}"` : ""}><header class="card-head"><h2>${title}</h2>${end}</header>${body}</article>`;
/* Push-pull slots: the star map an opened card shows, and the key numbers a folded card keeps. */
const GX = `<div class="gx" data-own-tip hidden></div>`;
const compactBody = (items) =>
  `<div class="compact" aria-hidden="true">${items.filter(Boolean).map(([v, l], i) => `<div${i ? "" : ' class="lead"'}><b class="num">${v}</b><small>${esc(l)}</small></div>`).join("")}</div>`;
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
  model: null, scene: null, sub: null, stage: null, mech: null, pattern: null, case: null,
};
function openSamples(patch) {
  ctx.navigate({ ...SAMPLE_RESET, view: "samples", product: ctx.product, ...patch });
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
    ? `${tokenNum(tin || 0)}<span class="stat-of"> / ${tokenNum(tout || 0)}</span>`
    : pending;
  const lost = input.lost;
  const items = [
    ["评测输入记录", counter(input.records ?? k.inputs)],
    ["轨迹", counter(input.traces ?? k.traces)],
    ...(lost != null ? [["流失轨迹", counter(lost)]] : []),
    ["工具调用", input.tool_calls != null ? counter(input.tool_calls) : pending],
    ["Tokens 输入/输出", tokens],
  ];
  const note = lost ? `<div class="sb-keys"><span class="sb-key" title="外圈细环是该分支里流失用户 trace 的占比，列表红字是流失 trace 数"><i></i>流失</span></div>` : "";
  const folded = compactBody([
    [fmt(input.traces ?? k.traces), "评测输入轨迹"], [fmt(input.records ?? k.inputs), "记录"],
    lost != null ? [fmt(lost), "流失轨迹"] : null, tin != null ? [tokenNum(tin), "输入 Tokens"] : null,
  ]);
  return card(6, "数据量", `<div class="duo" id="vol"></div>${note}${stats(items, items.length > 4 ? 5 : 4)}${GX}${folded}`, "", "vol");
}
function inputTaskNodes(prefix, tasks) {
  return (tasks || []).map((t) => ({
    id: `${prefix}/${t.task}`, name: t.task, n: t.n, lost: t.lost || 0,
    children: (t.sub || []).map((s) => ({
      id: `${prefix}/${t.task}/${s.sub}`, name: s.sub, n: s.n, lost: s.lost || 0,
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
            id: `v/${id}`, name: m.label || modelName(p, id), n: m.traces, lost: m.lost || 0,
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

/* ---------------------------------------------------------------- 评测量: inputs vs completed per day */
const dayCount = (d) => Object.entries(d).reduce((n, [k, v]) => (k === "d" ? n : n + (v || 0)), 0);
const DAY_MS = 86400000;
const dayMs = (d) => Date.parse(`${d}T00:00:00Z`);
const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const EV_PER_ROW = 15;
const RANGE_LABEL = { 7: "近 7 天", 30: "近 30 天", all: "全部" };
const EV = { range: "30", model: "all" };

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
  const blank = () => ({ inputs: 0, evaluated: 0, traces: 0, tokens: 0, sessions: 0, sids: new Set() });
  evalRows(p)
    .filter((r) => EV.model === "all" || r.m === EV.model)
    .forEach((r) => {
      const x = byDay.get(r.d) || blank();
      x.inputs += r.inputs || 0;
      x.evaluated += r.evaluated || 0;
      x.traces += r.traces ?? r.evaluated ?? 0;
      x.tokens += r.tokens || 0;
      if (Array.isArray(r.sids)) r.sids.forEach((sid) => x.sids.add(`${r.sp}|${r.m}|${sid}`));
      else x.sessions += r.sessions || r.evaluated || 0;
      byDay.set(r.d, x);
    });
  const dates = [...byDay.keys()].sort();
  if (!dates.length) return { days: [], totalInputs: 0, totalEval: 0, totalSessions: 0, totalTraces: 0, totalTokens: 0, peakEval: 0 };
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
    totalSessions: sessions.size || sum(days.map((x) => x.sessions)),
    totalTraces: sum(days.map((x) => x.traces)),
    totalTokens: sum(days.map((x) => x.tokens)),
    peakEval: Math.max(0, ...days.map((x) => x.evaluated)),
  };
}

function evalBuckets(days) {
  if (EV.range !== "all") {
    return days.map((x) => ({ ...x, label: x.d.slice(5), tip: x.d }));
  }
  // The full history gets at most 12 buckets, keeping the card height fixed.
  const size = Math.max(1, Math.ceil(days.length / 12));
  const out = [];
  for (let i = 0; i < days.length; i += size) {
    const chunk = days.slice(i, i + size);
    const start = chunk[0].d.slice(5);
    const end = chunk[chunk.length - 1].d.slice(5);
    out.push({
      d: chunk[0].d, d0: chunk[0].d, d1: chunk[chunk.length - 1].d,
      inputs: sum(chunk.map((x) => x.inputs)),
      evaluated: sum(chunk.map((x) => x.evaluated)),
      label: start,
      tip: `${start}–${end}`,
    });
  }
  return out;
}

const barNum = (v) => (v >= 1000 ? `${fmt(v / 1000, v >= 10000 ? 0 : 1)}k` : fmt(v));
const tokenNum = (v) => {
  const n = Number(v) || 0;
  const [base, unit, digits] = n >= 1e9 ? [1e9, "B", 2] : n >= 1e6 ? [1e6, "M", 1] : n >= 1e3 ? [1e3, "K", 1] : [];
  return base ? fmt(n / base, digits).replace(/\.0+$/, "") + unit : fmt(n);
};

function evalChart(p) {
  const bars = evalBuckets(evalWindow(p).days);
  if (!bars.length) return `<div class="empty">暂无评测日期</div>`;
  const max = Math.max(1, ...bars.map((x) => Math.max(x.inputs, x.evaluated)));
  const rows = [];
  for (let i = 0; i < bars.length; i += EV_PER_ROW) rows.push(bars.slice(i, i + EV_PER_ROW));
  const barH = rows.length === 1 ? 160 : 52;
  return `<div class="evrows" style="--bar-h:${barH}px">${rows
    .map((row) => `<div class="evrow" style="--n:${row.length}">${row
      .map((x) => {
        const total = Math.max(x.inputs, x.evaluated, 1);
        const height = Math.max(3, (barH * total) / max);
        const done = x.evaluated ? Math.min(100, (100 * x.evaluated) / Math.max(x.inputs, x.evaluated)) : 0;
        const tip = `${x.tip || x.d}|输入 ${fmt(x.inputs)} · 已完成 ${fmt(x.evaluated)} · ${pct(x.evaluated, x.inputs, 1)}`;
        return `<div class="evday" data-d0="${x.d0 || x.d}" data-d1="${x.d1 || x.d}"><div class="evnums"><b class="num">${barNum(x.evaluated)}</b><small class="num">${barNum(x.inputs)}</small></div>
          <div class="evbar" style="height:${height}px" data-tip="${esc(tip)}"><i style="height:${done}%"></i></div>
          <small class="evdate num">${esc(x.label)}</small></div>`;
      })
      .join("")}</div>`)
    .join("")}</div>`;
}

function evalStats(p) {
  const w = evalWindow(p);
  const ratio = (a, b) => `${counter(a)}<span class="stat-of"> / ${fmt(b)}</span>`;
  const tin = p.kpi.tokens_in;
  const tout = p.kpi.tokens_out;
  const items = [
    ["完成 Session / 总量", ratio(w.totalSessions, p.kpi.unique_sessions)],
    ["完成 Trace / 总量", ratio(w.totalTraces, p.kpi.traces)],
    ["评测 Tokens 输入/输出", tin != null || tout != null
      ? `${tokenNum(tin || 0)}<span class="stat-of"> / ${tokenNum(tout || 0)}</span>`
      : tokenNum(w.totalTokens)],
  ];
  return stats(items);
}

function evalCard(p) {
  const models = evalModels(p);
  if (!models.some((m) => m.id === EV.model)) EV.model = "all";
  return card(6, "评测量", `<div class="eval-content">
    <div class="ev-tools">
      <div class="seg ev-range" id="evRange"><span class="seg-knob" aria-hidden="true"></span>
        ${["7", "30", "all"].map((v) => `<button type="button" data-value="${v}">${RANGE_LABEL[v]}</button>`).join("")}
      </div>
      <div class="seg ev-model" id="evModel"><span class="seg-knob" aria-hidden="true"></span>
        ${models.map((m) => `<button type="button" data-value="${esc(m.id)}">${esc(m.label)}</button>`).join("")}
      </div>
    </div>
    <div class="ev-legend"><span><i class="ev-done"></i>已完成</span><span><i class="ev-in"></i>评测输入</span></div>
    <div id="evChart">${evalChart(p)}</div>
    <div id="evStats">${evalStats(p)}</div></div>${GX}${evalCompact(p)}`,
    `<button type="button" class="link end" id="evDetail" aria-label="查看评测数据详情">详情</button>`, "eval");
}
function evalCompact(p) {
  const w = evalWindow(p);
  return compactBody([[fmt(w.totalSessions), "完成 Session"], [pct(w.totalEval, w.totalInputs, 1), "完成率"], [fmt(w.totalTraces), "完成 Trace"]]);
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

/* Status is progress: a quiet ring for partially evaluated days/models, ✅ only when every input is done. */
const edRing = (ratio, title) =>
  `<span class="st-ring" role="img" aria-label="${esc(title)}" title="${esc(title)}"><svg viewBox="0 0 18 18" aria-hidden="true"><circle class="st-track" cx="9" cy="9" r="6.5"/><circle class="st-arc" cx="9" cy="9" r="6.5" pathLength="100" style="stroke-dasharray:${Math.round(ratio * 100)} 100"/></svg></span>`;
const edStatus = (r) => {
  const inputs = r.inputs || 0;
  const done = r.evaluated || 0;
  if (!inputs) return `<span class="faint">—</span>`;
  if (done >= inputs) return `<span class="ok" aria-label="全部评测完成" title="全部评测完成">✅</span>`;
  return edRing(done / inputs, `已评测 ${fmt(done)} / ${fmt(inputs)} · ${pct(done, inputs, 1)}`);
};

function edSessionGroups(rows) {
  const groups = new Map();
  rows.forEach((r) => {
    const key = `${r.sp}|${r.m}|${r.sid || r.s}`;
    let g = groups.get(key);
    if (!g) {
      g = { key, q: r.q || "", tr: 0, n: 0, w: "none" };
      groups.set(key, g);
    }
    g.tr += r.tr || 1;
    g.n += r.n || 0;
    if (r.q) g.q = r.q;
    if (WORST.indexOf(r.w) >= 0 && (g.w === "none" || WORST.indexOf(r.w) < WORST.indexOf(g.w))) g.w = r.w;
  });
  return [...groups.values()].sort((a, b) => WORST.indexOf(a.w) - WORST.indexOf(b.w) || b.n - a.n || (a.q || "").localeCompare(b.q || ""));
}

function evalDetailState(p, raw) {
  const days = edDays(p);
  const day = days.some((x) => x.d === raw.ed) ? raw.ed : "";
  const models = day ? edModels(p, day) : [];
  const model = models.some((x) => x.key === raw.em) ? raw.em : "";
  return { days, day, models, model, ep: raw.ep, edp: raw.edp };
}

const edTable = (head, rows, cls = "") =>
  `<div class="md-table ed-table${cls ? ` ${cls}` : ""}"><table><thead><tr>${head}</tr></thead><tbody>${rows.join("")}</tbody></table></div>`;

function edPager(page, pages, total, unit, kind) {
  if (pages <= 1) return "";
  const btn = (to, label, off) => `<button type="button" data-${kind}="${to}"${off ? " disabled" : ""}>${label}</button>`;
  return `<div class="pager">${btn(1, "«", page === 1)}${btn(page - 1, "上一页", page === 1)}
    <span class="pager-info">第 <b class="num">${page}</b> / ${pages} 页 · ${fmt(total)} ${unit}</span>
    ${btn(page + 1, "下一页", page === pages)}${btn(pages, "»", page === pages)}</div>`;
}

function evalDetailPage(p, state, index) {
  const { days, day, models, model } = state;
  const dPages = Math.max(1, Math.ceil(days.length / ED_PAGE));
  const dpage = Math.min(Math.max(1, state.edp), dPages);
  const modelRow = models.find((x) => x.key === model);
  const all = ((index && index.products && index.products[ctx.product]) || {}).rows || [];
  const mid = p.unified ? model.slice(1) : "";
  const picked = model
    ? all.filter((r) => r.d === day && (p.unified ? r.m === mid : `${r.sp}|${r.m}` === model))
    : [];
  const groups = edSessionGroups(picked);
  const sPages = Math.max(1, Math.ceil(groups.length / ES_PAGE));
  const spage = Math.min(Math.max(1, state.ep), sPages);
  const rowTotal = modelRow || {};

  const rootCrumb = day ? `<button type="button" class="mx-crumb" data-ed="root">全部日期</button>` : `<b>全部日期</b>`;
  const dayCrumb = day
    ? ` <i class="mx-sep">/</i> ${model ? `<button type="button" class="mx-crumb" data-ed="day">${esc(day)}</button>` : `<b>${esc(day)}</b>`}`
    : "";
  const modelCrumb = model ? ` <i class="mx-sep">/</i> <b>${esc(rowTotal.label || model)}</b>` : "";
  // One obvious way out of each level: model → day → date list → dashboard.
  const backLabel = model ? `← ${esc(day)}` : day ? "← 全部日期" : "← 返回数据看板";
  const num = (v, d = 0) => `<td class="num${v ? "" : " is-zero"}">${fmt(v, d)}</td>`;
  const rate = (part, whole) => `<td class="num${part ? "" : " is-zero"}">${pct(part, whole, 1)}</td>`;

  let body = "";
  let pager = "";
  if (!days.length) {
    body = `<div class="empty">暂无评测日期</div>`;
  } else if (!day) {
    const head = `<th>日期</th><th title="圆环 = 评测进度（已评测 / 评测输入）；全部评测完才显示 ✅">状态</th><th class="num">评测输入</th><th class="num">评测输出</th><th class="num">完成率</th><th class="num">Session</th><th class="num">Trace</th><th class="num">Tokens</th>`;
    const rows = days.slice((dpage - 1) * ED_PAGE, dpage * ED_PAGE).map((r) => `<tr>
      <td><button type="button" class="link" data-eday="${esc(r.d)}">${esc(r.d)}</button></td>
      <td class="st">${edStatus(r)}</td>
      ${num(r.inputs)}${num(r.evaluated)}${rate(r.evaluated, r.inputs)}${num(r.sessions)}${num(r.traces)}
      <td class="num${r.tokens ? "" : " is-zero"}">${tokenNum(r.tokens)}</td>
    </tr>`);
    body = edTable(head, rows, "is-day");
    pager = edPager(dpage, dPages, days.length, "天", "edp");
  } else if (!model) {
    const head = `<th>模型</th><th title="圆环 = 评测进度（已评测 / 评测输入）；全部评测完才显示 ✅">状态</th><th class="num">评测输入</th><th class="num">评测输出</th><th class="num">完成率</th><th class="num">Session</th><th class="num">Trace</th><th class="num">Tokens</th>`;
    const rows = models.map((r) => `<tr>
      <td><button type="button" class="link" data-emodel="${esc(r.key)}">${esc(r.label)}</button></td>
      <td class="st">${edStatus(r)}</td>
      ${num(r.inputs)}${num(r.evaluated)}${rate(r.evaluated, r.inputs)}${num(r.sessions)}${num(r.traces)}
      <td class="num${r.tokens ? "" : " is-zero"}">${tokenNum(r.tokens)}</td>
    </tr>`);
    body = edTable(head, rows, "is-model");
  } else if (!index) {
    body = `<div class="empty">样本索引读取失败，无法列出会话。</div>`;
  } else if (!groups.length) {
    body = `<div class="empty">该分组当天没有已完成的评测输出。</div>`;
  } else {
    const head = `<th>评测输入</th><th>评测输出</th><th class="num">轮</th><th></th>`;
    const rows = groups.slice((spage - 1) * ES_PAGE, spage * ES_PAGE).map((g) => `<tr>
      <td>${esc(g.q || "（无提问）")}</td>
      <td class="st"><span class="ok" aria-label="已评测">✅</span><span class="sev" style="--c:${sevColor(g.w)}"><i></i>${g.w === "none" ? "无问题" : `${g.w} · ${g.n} 个问题`}</span></td>
      <td class="num">${fmt(g.tr)}</td>
      <td class="num act"><button type="button" class="link" data-ecase="${esc(g.key)}">查看</button></td>
    </tr>`);
    body = edTable(head, rows, "is-session");
    pager = edPager(spage, sPages, groups.length, "个 session", "ep");
  }

  return `<div class="bento"><article class="card" style="--span:12">
    <header class="card-head"><h2>评测数据详情</h2>
      <button type="button" class="link ed-back" id="edBack">${backLabel}</button>
      <div class="mx-crumbs" id="edCrumbs">${day ? `<span class="mx-crumb-group">${rootCrumb}${dayCrumb}${modelCrumb}</span>` : ""}</div>
      ${day ? `<button type="button" class="link ed-home" id="edHome">返回数据看板</button>` : ""}</header>
    ${body}${pager}
  </article></div>`;
}

function wireEvalDetail(root, state) {
  const card = $(".card", root) || root;
  card.addEventListener("click", (e) => {
    const back = e.target.closest("#edBack");
    if (back) {
      if (state.model) ctx.navigate({ detail: "eval", ed: state.day, em: null, ep: null });
      else if (state.day) ctx.navigate({ detail: "eval", ed: null, em: null, ep: null, edp: null });
      else ctx.navigate({ detail: null, ed: null, em: null, ep: null, edp: null });
      return;
    }
    if (e.target.closest("#edHome")) {
      ctx.navigate({ detail: null, ed: null, em: null, ep: null, edp: null });
      return;
    }
    const crumb = e.target.closest("[data-ed]");
    if (crumb) {
      if (crumb.dataset.ed === "root") ctx.navigate({ detail: "eval", ed: null, em: null, ep: null, edp: null });
      else ctx.navigate({ detail: "eval", ed: state.day, em: null, ep: null, edp: null });
      return;
    }
    const day = e.target.closest("[data-eday]");
    if (day) {
      ctx.navigate({ detail: "eval", ed: day.dataset.eday, em: null, ep: null, edp: null });
      return;
    }
    const model = e.target.closest("[data-emodel]");
    if (model) {
      ctx.navigate({ detail: "eval", ed: state.day, em: model.dataset.emodel, ep: null });
      return;
    }
    const session = e.target.closest("[data-ecase]");
    if (session) {
      ctx.navigate({
        view: "samples", product: ctx.product, case: session.dataset.ecase,
        detail: null, ed: null, em: null, ep: null, edp: null,
        p: null, tab: null, q: null, w: null, split: null, model: null, stage: null, mech: null, pattern: null,
      });
      return;
    }
    const dpage = e.target.closest("[data-edp]");
    if (dpage) {
      ctx.navigate({ detail: "eval", edp: Number(dpage.dataset.edp), ep: null });
      return;
    }
    const spage = e.target.closest("[data-ep]");
    if (spage) ctx.navigate({ detail: "eval", ep: Number(spage.dataset.ep) });
  });
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
  return card(4, "归因体系", `<div class="hero"><b class="big">${counter(p.kpi.problems)}</b><small>个问题</small></div>
    ${sankeySVG(left, right, (l, r) => l.roles[r.key] || 0, { id: "ska", x0: 128, x1: 322 })}${GX}${compactBody([
      [fmt(p.kpi.problems), "问题"], top ? [pct(top.n, p.kpi.problems), `${top.name}占比`] : null,
    ])}`, "", "attr");
}

/* ---------------------------------------------------------------- 聚类体系: phase → stage → mechanism → pattern */
function clusterCard(p, tax) {
  if (!tax) return card(4, "聚类体系", `<div class="empty">缺少聚类体系文件</div>`);
  const note = p.kpi.unclustered
    ? `<span class="sb-key is-note" title="归因没有匹配到聚类模式的问题：计入问题总数，不进矩阵"><i></i>未聚类 ${fmt(p.kpi.unclustered)}</span>`
    : "";
  return card(4, "聚类体系", `<div class="duo sm" id="clu"></div>
    <div class="sb-keys"><span class="sb-key" title="外圈细环是该分支里 P0·P1 问题的占比，列表红字是 P0+P1 数"><i></i>P0·P1</span>${note}</div>${GX}${compactBody([
      [fmt(p.kpi.problems), "问题"], [pct(p.kpi.clustered, p.kpi.problems), "已聚类"],
    ])}`, "", "clu");
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

function predictCard(p) {
  const pr = p.prediction;
  if (!pr) {
    const panes = ["vol", "acc", "cause"].map((k, i) => `<div class="pred-pane${i ? "" : " is-on"}" data-pane="${k}"><div class="empty">暂无预测数据</div></div>`);
    return card(4, "预测体系", `<div class="pred-panes">${panes.join("")}</div>${compactBody([["—", "预测题"]])}`, PRED_TABS, "pred");
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
  const folded = compactBody([[fmt(forecast), "预测题"], pooledN ? [`${fmt((100 * right) / pooledN, 1)}%`, "准确率"] : null]);
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
  let html = `<span></span>${cols
    .map((c, ci) => {
      const title = `${c.id ? `${c.id} · ` : ""}${c.name}`;
      const label = `<span class="mx-lab">${esc(c.name)}</span>`;
      return c.children.length
        ? `<button type="button" class="mh" data-col="${ci}" title="${esc(title)}" aria-label="下钻 ${esc(c.name)}">${label}<i class="mx-caret" aria-hidden="true"></i></button>`
        : `<span class="mh" title="${esc(title)}">${label}</span>`;
    })
    .join("")}<span class="rowtot-head" title="该场景在各问题聚类上的问题数合计">问题合计</span>`;
  rows.forEach((r, ri) => {
    const drill = r.children.length;
    const label = `<span class="mx-lab">${esc(r.name)}</span>${drill ? `<i class="mx-caret" aria-hidden="true"></i>` : ""}`;
    html += drill
      ? `<button type="button" class="rh" data-row="${ri}" title="${esc(r.name)}" aria-label="下钻 ${esc(r.name)}">${label}</button>`
      : `<span class="rh" title="${esc(r.name)}">${label}</span>`;
    cols.forEach((_, ci) => {
      const cell = cells[ri][ci];
      const v = cell.n ? 0.08 + 0.72 * Math.sqrt(cell.n / max) : 0;
      html += cell.n
        ? `<span class="cell num${v > 0.5 ? " hot" : ""}" style="--v:${v.toFixed(3)}" data-mx="${ri}:${ci}">${fmt(cell.n)}</span>`
        : `<span class="cell is-empty" data-mx="${ri}:${ci}"></span>`;
    });
    html += `<span class="rowtot num"><i style="width:${(72 * totals[ri]) / maxTot}px"></i>${fmt(totals[ri])}</span>`;
  });
  return `<div class="matrix" style="--cols:${cols.length}">${html}</div>`;
}

/* Swap one matrix for the next without the layout jump: the old table fades out where it stands,
   the card height eases to the new table, and the new one fades up into place. */
function swapMatrix(shell, html, animate) {
  clearTimeout(shell._swap);
  shell.classList.remove("is-swapping");
  shell.style.height = "";
  shell.querySelectorAll(".matrix.is-out").forEach((el) => el.remove());
  const prev = shell.querySelector(".matrix");
  if (!animate || REDUCED || !prev) {
    shell.innerHTML = html;
    return;
  }
  prev.classList.remove("is-in", "is-on");
  const from = shell.offsetHeight;
  shell.insertAdjacentHTML("beforeend", html);
  const next = shell.lastElementChild;
  const to = next.offsetHeight;
  shell.style.height = `${from}px`;
  shell.classList.add("is-swapping");
  prev.classList.add("is-out");
  next.classList.add("is-in");
  void next.offsetWidth;
  requestAnimationFrame(() => {
    shell.style.height = `${to}px`;
    setTimeout(() => next.classList.add("is-on"), 70);
  });
  shell._swap = setTimeout(() => {
    prev.remove();
    next.classList.remove("is-in", "is-on");
    shell.classList.remove("is-swapping");
    shell.style.height = "";
  }, 460);
}

function crumbPath(path, axis) {
  return path
    .map((n, i) => {
      const text = i ? `<i class="mx-sep" aria-hidden="true">›</i>` : "";
      return `${text}${i === path.length - 1
        ? `<b>${esc(n.name)}</b>`
        : `<button type="button" class="mx-crumb" data-${axis}="${i}" aria-label="返回 ${esc(n.name)}">${esc(n.name)}</button>`}`;
    })
    .join("");
}

const crumbs = (rowPath, colPath) =>
  `<span class="mx-crumb-group"><span class="mx-crumb-label">场景</span>${crumbPath(rowPath, "rp")}</span>
   <span class="mx-crumb-group"><span class="mx-crumb-label">问题</span>${crumbPath(colPath, "cp")}</span>`;

function matrixCard(p, tax) {
  if (!tax) return "";
  const sceneRoot = { name: "全部", children: capScenes(sceneTree(p)) };
  const clusterRoot = clusterTree(p, tax);
  if (!sceneRoot.children.length || !clusterRoot.children.length) {
    return card(12, "聚类矩阵", `<div class="empty">暂无聚类数据</div>`);
  }
  return card(
    12,
    "聚类矩阵",
    `<div id="mxShell">${matrixTable(matrixView(p, sceneRoot.children, clusterRoot.children))}</div>`,
    `<button type="button" class="link mx-back" id="mxBack" hidden aria-label="返回上一级">← 返回</button>
     <div class="mx-crumbs" id="mxCrumbs">${crumbs([sceneRoot], [clusterRoot])}</div>`,
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
const ICON_CLOSE = `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M7 7l10 10M17 7 7 17" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`;

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
        c.classList.toggle("is-deep", !!spec && spec.card === k);
        c.classList.toggle("is-compact", !!spec && spec.card !== k);
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
    if (spec) {
      // Same spec on a live board: only the highlight moved. While booting the DOM is new, so apply.
      if (cur && cur.id === spec.id && !booting) {
        cur.focus = spec.focus;
        if (maps[card] && maps[card].id === spec.id) maps[card].map.focus(spec.focus);
        return;
      }
      u.deep[row] = spec;
      apply(row);
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
    if (!at) return null;
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
  const sceneKey = (r) => r.sub || r.sc || r.skill || "未标注";

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
        (spec.task ? (r.task || "未标注") === spec.task : spec.others ? !spec.others.includes(r.task || "未标注") : true));
      return groupCases(picked, spec.task || spec.others ? sceneKey : (r) => r.task || r.sc || r.skill || "未标注");
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
    const close = `<button type="button" class="icon-btn gx-close" aria-label="收起">${ICON_CLOSE}</button>`;
    if (!groups.some((g) => g.items.length)) {
      gx.innerHTML = `<div class="empty">暂无已评测的 case</div>${close}`;
      return;
    }
    const pred = spec.card === "pred";
    const map = galaxy(gx, groups, {
      focus: spec.focus,
      tip: pred ? predTip : caseTip,
      colorOf: pred ? predColor : null,
      onPick: pred ? null : (it) => openSamples({ case: it.s }),
    });
    gx.insertAdjacentHTML("beforeend", close);
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
    const shut = e.target.closest(".gx-close");
    if (shut) {
      close(ROW[shut.closest(".card").dataset.card]);
      return;
    }
    const folded = e.target.closest(".card.is-compact");
    if (folded && matchMedia(WIDE).matches) {
      close(ROW[folded.dataset.card]);
      return;
    }
    const day = e.target.closest('[data-card="eval"] .evday');
    if (day) {
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
    const repaint = () => {
      $("#evChart", bento).innerHTML = evalChart(p);
      const s = $("#evStats", bento);
      s.innerHTML = evalStats(p);
      runCounters(s);
    };
    // A new window or model invalidates the picked day's star map.
    const range = segmented(evRange, (v) => { EV.range = v; push.closeEval(); repaint(); });
    const model = segmented(evModel, (v) => { EV.model = v; push.closeEval(); repaint(); });
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
    const syncTrail = () => {
      trail = [...Array(rowPath.length - 1).fill("r"), ...Array(colPath.length - 1).fill("c")];
    };
    const remember = () => {
      u.mx.rows = rowPath.slice(1).map(rowKey);
      u.mx.cols = colPath.slice(1).map(colKey);
      u.mx.trail = trail.slice();
    };
    const paint = (animate = true) => {
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
      swapMatrix(shell, matrixTable(mxView), animate);
      const crumbsEl = $("#mxCrumbs", bento);
      if (crumbsEl) crumbsEl.innerHTML = crumbs(rowPath, colPath);
      const back = $("#mxBack", bento);
      if (back) back.hidden = rowPath.length === 1 && colPath.length === 1;
    };
    const clearHover = () => {
      if (!mxKey) return;
      mxKey = "";
      const m = shell.querySelector(".matrix");
      if (!m) return;
      m.classList.remove("is-hover");
      $$(".is-hl, .is-cur", m).forEach((x) => x.classList.remove("is-hl", "is-cur"));
    };
    const hover = (ri, ci) => {
      const key = `${ri}:${ci}`;
      if (key === mxKey) return;
      mxKey = key;
      const m = shell.querySelector(".matrix");
      if (!m) return;
      m.classList.add("is-hover");
      $$(".cell", m).forEach((c) => {
        const [r, k] = (c.dataset.mx || "").split(":").map(Number);
        c.classList.toggle("is-hl", r === ri || k === ci);
        c.classList.toggle("is-cur", r === ri && k === ci);
      });
      $$(".rh", m).forEach((h, i) => h.classList.toggle("is-hl", i === ri));
      $$(".mh", m).forEach((h, i) => h.classList.toggle("is-hl", i === ci));
      $$(".rowtot", m).forEach((h, i) => h.classList.toggle("is-hl", i === ri));
    };
    shell.addEventListener("pointerover", (e) => {
      const cell = e.target.closest(".cell[data-mx]");
      if (cell) {
        const [ri, ci] = cell.dataset.mx.split(":").map(Number);
        return hover(ri, ci);
      }
      const rh = e.target.closest(".rh");
      if (rh) return hover($$(".rh", shell).indexOf(rh), -1);
      const mh = e.target.closest(".mh");
      if (mh) return hover(-1, $$(".mh", shell).indexOf(mh));
    });
    shell.addEventListener("pointerleave", clearHover);
    paint(false);
    bento.addEventListener("click", (e) => {
      const back = e.target.closest("#mxBack");
      if (back) {
        const axis = trail.pop();
        if (axis === "r" && rowPath.length > 1) rowPath = rowPath.slice(0, -1);
        else if (axis === "c" && colPath.length > 1) colPath = colPath.slice(0, -1);
        else if (colPath.length > 1) colPath = colPath.slice(0, -1);
        else if (rowPath.length > 1) rowPath = rowPath.slice(0, -1);
        paint();
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
          paint();
          return;
        }
        const task = r.task || rowPath.slice(1).map((n) => n.task).find(Boolean);
        const sub = r.sub || "";
        const [stage, mech] = (c.prefix || "").split(".");
        openSamples({ scene: task || null, sub: sub || null, stage: stage || null, mech: mech || null, pattern: c.pat || null });
        return;
      }
      const row = e.target.closest("#mxShell [data-row]");
      if (row) {
        const node = mxView.rows[Number(row.dataset.row)];
        if (node && node.children.length) {
          rowPath = [...rowPath, node];
          trail.push("r");
          paint();
        }
        return;
      }
      const col = e.target.closest("#mxShell [data-col]");
      if (col) {
        const node = mxView.cols[Number(col.dataset.col)];
        if (node && node.children.length) {
          colPath = [...colPath, node];
          trail.push("c");
          paint();
        }
        return;
      }
      const rp = e.target.closest("#mxCrumbs [data-rp]");
      if (rp) {
        rowPath = rowPath.slice(0, Number(rp.dataset.rp) + 1);
        syncTrail();
        paint();
        return;
      }
      const cp = e.target.closest("#mxCrumbs [data-cp]");
      if (cp) {
        colPath = colPath.slice(0, Number(cp.dataset.cp) + 1);
        syncTrail();
        paint();
      }
    });
  }

  push.rings.vol = sunburst($("#vol", bento), volTree(p), {
    unit: "评测输入", state: u.vol, animate: !ctx.refresh, onChange: (f, o) => push.fromRing("vol", f, o),
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
}
