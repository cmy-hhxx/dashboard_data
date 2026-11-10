/* 版本对比: one fixed question set before / after a release, the same question's two sample
   details side by side. The left pane picks the question; the right pane mounts the shared
   sample-detail factory twice (prefix "b" / "a"). An `online` sample has no same-question twin,
   so it is shown alone in the same page.

   Route: ?view=compare&product=…&round=<roundId>&pair=<口径① trace>[&online=<slug>]
   Sample entries in the A/B panel land here; every other sample entry stays on 具体数据. */
import { $, $$, esc, fmt, getJSON } from "./core.js";
import { createSampleDetail, detailPaneHTML } from "./sample_detail.js";

const PAGE = 50;
const AB_CACHE = new Map();
const SAMPLE_VIEW_RESET = {
  detail: null, ed: null, em: null, ep: null, edp: null, p: null, q: null, w: null, split: null,
  model: null, scene: null, sub: null, stage: null, mech: null, case: null, trace: null,
};

const C = {
  root: null, ctx: null, product: null, round: null, pairs: [], list: [], page: 1, query: "",
  online: null, pairId: null, gen: "", skelKey: "", listKey: "", sidesKey: "", token: 0, details: [],
  listOff: false, syncScroll: false, sides: { b: true, a: true }, fold: { b: false, a: false },
};

/* ---------------------------------------------------------------- pure helpers (tested) */
export function parseCompareURL(search) {
  const q = new URLSearchParams(search || "");
  const clean = (value) => (value == null || value === "" ? null : value);
  return { round: clean(q.get("round")), pair: clean(q.get("pair")), online: clean(q.get("online")) };
}

export function pickRound(rounds, id) {
  const list = Array.isArray(rounds) ? rounds : [];
  if (!list.length) return null;
  if (id != null) {
    const hit = list.find((round) => String(round.id) === String(id));
    if (hit) return hit;
  }
  return list[list.length - 1];
}

/* Latest prediction accuracy for one model. The compare page only reads the same optional
   prediction feed as 预测体系; when it is absent the row still exists and reads —. */
export function predictionRate(productData, model) {
  const rows = Array.isArray(productData?.prediction?.accuracy) ? productData.prediction.accuracy : [];
  let latest = null;
  rows.forEach((row) => {
    if (model && row.model && String(row.model) !== String(model)) return;
    const total = Number(row.total) || 0;
    const rate = total > 0 ? (100 * (Number(row.correct) || 0)) / total : Number(row.accuracy) * 100;
    if (!Number.isFinite(rate)) return;
    const at = Date.parse(row.at || "") || 0;
    if (!latest || at >= latest.at) latest = { at, rate };
  });
  return latest ? latest.rate : null;
}

const roundName = (round, i = 0) => round?.label || round?.title || round?.version || `第 ${i + 1} 期`;
const roundDate = (round) => String(round?.released_at || round?.release_label || "").slice(0, 10);
const roundMeta = (round) => {
  const models = (Array.isArray(round?.models) ? round.models : []).join(" + ");
  const pairs = Array.isArray(round?.pairs) ? round.pairs.length : 0;
  return [models, roundDate(round), pairs ? `${fmt(pairs)} 道同题` : ""].filter(Boolean).join(" · ");
};

/* ---------------------------------------------------------------- testset timeline */
const DAY = 86400000;
const monthStart = (ms) => {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
};
const nextMonth = (ms) => {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
};

/* The first screen is one wide release timeline. Rounds sit on a single time scale padded on
   both sides (a lone round lands near the middle, never in a corner); nodes alternate above and
   below the axis, and each side is pushed apart just enough for its labels not to collide. */
export function timelineModel(rounds, width = 1200) {
  const list = (Array.isArray(rounds) ? rounds : []).map((round, order) => {
    const ms = Date.parse(roundDate(round));
    return { round, order, time: Number.isFinite(ms) ? ms : null };
  });
  if (!list.length) return { nodes: [], months: [] };
  const dated = list.filter((item) => item.time != null).sort((a, b) => a.time - b.time);
  const anchor = dated.length ? dated[dated.length - 1].time : Date.now();
  list.forEach((item) => { if (item.time == null) item.time = anchor; });
  const ordered = list.slice().sort((a, b) => a.time - b.time || a.order - b.order);
  const min = ordered[0].time;
  const max = ordered[ordered.length - 1].time;
  const span = max - min;
  const pad = span > 0 ? Math.max(40 * DAY, span * 0.12) : 78 * DAY;
  const start = monthStart(min - pad);
  const end = nextMonth(monthStart(max + pad));
  const total = Math.max(1, end - start);
  const inset = Math.max(48, Math.min(110, width * 0.06));
  const usable = Math.max(1, width - inset * 2);
  const at = (ms) => ((inset + ((ms - start) / total) * usable) / width) * 100;
  const nodes = ordered.map((item, i) => ({
    round: item.round, time: item.time,
    side: i % 2 ? "down" : "up", x: at(item.time),
  }));
  const lo = (inset / width) * 100;
  const hi = 100 - lo;
  const gap = (Math.max(150, Math.min(190, width * 0.13)) / width) * 100;
  const spread = (side) => {
    const items = nodes.filter((node) => node.side === side).sort((a, b) => a.x - b.x);
    if (items.length < 2) return;
    const room = (items.length - 1) * gap <= hi - lo;
    if (room) {
      let prev = -Infinity;
      items.forEach((item) => { item.x = Math.max(item.x, lo, prev + gap); prev = item.x; });
      const over = items[items.length - 1].x - hi;
      if (over > 0) {
        items.forEach((item) => { item.x -= over; });
        prev = -Infinity;
        items.forEach((item) => { item.x = Math.max(item.x, lo, prev + gap); prev = item.x; });
      }
    }
    // Too many rounds for the width: even spacing still reads, an overlap does not.
    if (!room || items[items.length - 1].x > hi + 1e-9) {
      const step = (hi - lo) / (items.length - 1);
      items.forEach((item, i) => { item.x = lo + step * i; });
    }
  };
  spread("up");
  spread("down");
  const months = [];
  for (let cursor = start; cursor < end; cursor = nextMonth(cursor)) {
    const d = new Date(cursor);
    months.push({ x: at(cursor), year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, label: null });
  }
  const every = Math.max(1, Math.ceil(months.length / Math.max(4, Math.floor(usable / 112))));
  months.forEach((month, i) => {
    const first = i === 0;
    const yearStart = !first && month.year !== months[i - 1].year;
    if (first || yearStart) month.label = `${month.year}.${String(month.month).padStart(2, "0")}`;
    else if (i % every === 0) month.label = `${month.month}月`;
  });
  return { nodes, months };
}

const timelineShell = (single, still) => `<section class="compare-tl${single ? " is-single" : ""}${still ? " is-still" : ""}" aria-label="测试集时间轴"><div class="compare-tl-plot"></div></section>`;

function timelinePlotHTML(model) {
  const ticks = model.months.map((month, i) => `<span class="compare-tl-tick" style="--x:${month.x.toFixed(3)}%;--i:${i}" aria-hidden="true"><i></i><b>${esc(month.label || "")}</b></span>`).join("");
  const nodes = model.nodes.map((node, i) => {
    const round = node.round;
    const name = roundName(round, i);
    const date = roundDate(round);
    const models = (Array.isArray(round.models) ? round.models : []).join(" + ");
    const pairs = Array.isArray(round.pairs) ? round.pairs.length : 0;
    const meta = [models, pairs ? `${fmt(pairs)} 道同题` : ""].filter(Boolean).join(" · ");
    return `<button type="button" class="compare-tl-node" data-round="${esc(round.id)}" data-side="${node.side}" style="--x:${node.x.toFixed(3)}%;--i:${i};--dir:${node.side === "up" ? -1 : 1}" aria-label="${esc([name, date, meta].filter(Boolean).join("，"))}">
      <span class="compare-tl-body">
        <span class="compare-tl-name">${esc(name)}</span>
        ${date ? `<span class="compare-tl-date num">${esc(date)}</span>` : ""}
        ${meta ? `<span class="compare-tl-meta">${esc(meta)}</span>` : ""}
      </span>
      <span class="compare-tl-stem" aria-hidden="true"></span>
      <span class="compare-tl-dot" aria-hidden="true"></span>
    </button>`;
  }).join("");
  // 只有一个 round 时，一条贯穿高度的淡竖线把这一天钉在轴上，避免上下留白显得空。
  const guide = model.nodes.length === 1
    ? `<span class="compare-tl-guide" style="--x:${model.nodes[0].x.toFixed(3)}%" aria-hidden="true"></span>`
    : "";
  return `<span class="compare-tl-axis" aria-hidden="true"></span>${guide}
    <div class="compare-tl-ruler" aria-hidden="true">${ticks}</div>
    <div class="compare-tl-nodes">${nodes}</div>`;
}

/* Resizing only moves the existing nodes: rebuilding them would replay the entrance. */
function positionTimeline(root, model) {
  const plot = $(".compare-tl-plot", root);
  if (!plot) return;
  $$(".compare-tl-node", plot).forEach((el, i) => {
    if (model.nodes[i]) el.style.setProperty("--x", `${model.nodes[i].x.toFixed(3)}%`);
  });
  const guide = $(".compare-tl-guide", plot);
  if (guide && model.nodes.length === 1) guide.style.setProperty("--x", `${model.nodes[0].x.toFixed(3)}%`);
  $$(".compare-tl-tick", plot).forEach((el, i) => {
    const month = model.months[i];
    const label = el.lastElementChild;
    if (!month || !label) return;
    el.style.setProperty("--x", `${month.x.toFixed(3)}%`);
    label.textContent = month.label || "";
    label.hidden = !month.label;
  });
}

let pickerRO = null;
function stopPickerObserver() {
  if (pickerRO) { pickerRO.disconnect(); pickerRO = null; }
}

function testsetPicker(root, ctx, rounds) {
  destroyDetails();
  C.skelKey = ""; C.listKey = ""; C.sidesKey = "";
  stopPickerObserver();
  const list = Array.isArray(rounds) ? rounds : [];
  if (!list.length) {
    root.innerHTML = `<section class="compare-tl compare-tl-empty"><div class="empty">暂无测试集</div></section>`;
    return;
  }
  root.innerHTML = timelineShell(list.length === 1, !!ctx?.refresh);
  const plot = $(".compare-tl-plot", root);
  plot.innerHTML = timelinePlotHTML(timelineModel(list, plot.clientWidth || 1200));
  $(".compare-tl", root).addEventListener("click", (event) => {
    const node = event.target.closest("[data-round]");
    if (node && C.ctx) C.ctx.navigate({ round: node.dataset.round, pair: null, online: null });
  });
  pickerRO = new ResizeObserver(() => {
    if (!C.root || C.root !== root) return;
    positionTimeline(root, timelineModel(list, plot.clientWidth || 1200));
  });
  pickerRO.observe(plot);
}

/* The list sorts by how comparable a question is, then by how much it moved: both sides
   openable first, one side next, then |改版后 − 改版前| and the fixed-question order. A fast-model
   baseline (before === null) or a retest without attribution never outranks a real pair. */
export const detailReady = (side) => !!side && side.detail != null;
export const readyOf = (pair) => (detailReady(pair.before) ? 1 : 0) + (detailReady(pair.after) ? 1 : 0);
const changeOf = (pair) => Math.abs(Number(pair.after?.n || 0) - Number(pair.before?.n || 0));
export function sortPairs(pairs) {
  return (Array.isArray(pairs) ? pairs : [])
    .slice()
    .sort((a, b) => readyOf(b) - readyOf(a) || changeOf(b) - changeOf(a) || Number(a.eq || 0) - Number(b.eq || 0));
}

export function filterPairs(pairs, query) {
  const needle = String(query || "").trim().toLowerCase();
  if (!needle) return Array.isArray(pairs) ? pairs.slice() : [];
  return (Array.isArray(pairs) ? pairs : []).filter((pair) => String(pair.q || "").toLowerCase().includes(needle));
}

export function pagePairs(pairs, page, size = PAGE) {
  const list = Array.isArray(pairs) ? pairs : [];
  const pages = Math.max(1, Math.ceil(list.length / size));
  const at = Math.max(1, Math.min(pages, Number(page) || 1));
  return { rows: list.slice((at - 1) * size, at * size), page: at, pages };
}

/* 缺详情分支: a side without a detail keeps its label but leaves the pane to the empty state. */
export function pairGaps(pair) {
  const before = pair && pair.before ? pair.before : null;
  const after = pair && pair.after ? pair.after : null;
  return { before: !(before && before.detail), after: !(after && after.detail != null) };
}

/* 一侧有详情、另一侧没有时按单列展示；两侧都缺或两侧都全时维持用户选择。 */
export function sideLayout(gaps, sides = { b: true, a: true }) {
  const autoSingle = !!(sides.b && sides.a && gaps.before !== gaps.after);
  return { autoSingle, sides: autoSingle ? { b: !gaps.before, a: !gaps.after } : { ...sides } };
}

/* ---------------------------------------------------------------- data */
function loadAB(ctx) {
  const key = `${ctx.product}|${ctx.data?.generated_at || ""}`;
  if (!AB_CACHE.has(key)) AB_CACHE.set(key, getJSON(`abtests-${ctx.product}.json`).catch(() => null));
  return AB_CACHE.get(key);
}

function onlineRef(round, slug) {
  return (round.sample_refs?.online || []).find((ref) => ref.slug === slug) || null;
}

/* ---------------------------------------------------------------- icons (one 16px chevron set) */
const ICON = (d) => `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" aria-hidden="true"><path d="${d}" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const CHEV_LEFT = ICON("M10 3.5 5.5 8 10 12.5");
const CHEV_RIGHT = ICON("M6 3.5 10.5 8 6 12.5");
const CHEV_UP = ICON("M3.5 10 8 5.5 12.5 10");

/* ---------------------------------------------------------------- shell */
function skeleton(root, round) {
  root.innerHTML = `<div class="compare-top">
    <button type="button" class="compare-back" data-act="testsets">${CHEV_LEFT}<span>测试集</span></button>
    <b class="compare-top-name">${esc(roundName(round))}</b>
    <span class="compare-top-meta">${esc(roundMeta(round))}</span>
    <span class="compare-models" role="group" aria-label="选择要展示的模型"></span>
    <button type="button" class="compare-sync" data-act="sync" aria-pressed="${C.syncScroll}"><span class="compare-sync-knob" aria-hidden="true"></span>同步滚动</button>
  </div>
  <div class="bench bench-compare">
    <aside class="pane pane-sticky compare-list" aria-label="同题列表">
      <button type="button" class="compare-rail-btn" data-act="toggle-list" title="展开同题列表" aria-label="展开同题列表">${CHEV_RIGHT}<span class="compare-rail-label">同题列表</span></button>
      <div class="pane-head compare-list-head">
        <input class="search" id="cmpq" type="search" placeholder="搜索问题" autocomplete="off">
        <div class="list-meta"><span id="cmpcount" class="num"></span><button type="button" class="compare-icon-btn" data-act="toggle-list" title="折叠同题列表" aria-label="折叠同题列表">${CHEV_LEFT}</button></div>
      </div>
      <div class="pane-scroll" id="cmplist" tabindex="0" aria-label="同题"></div>
      <div class="pager" id="cmppager" hidden></div>
    </aside>
    <div class="compare-panes" id="cmppanes"></div>
  </div>`;
  wireSkeleton(root);
}

function wireSkeleton(root) {
  let timer = 0;
  const search = $("#cmpq", root);
  search.value = C.query;
  search.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      C.query = search.value.trim();
      C.page = 1;
      C.list = filterPairs(sortPairs(C.pairs), C.query);
      C.listKey = "";
      paintList(pagePairs(C.list, C.page));
    }, 140);
  });
  $("#cmppager", root).addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-page]");
    if (!btn) return;
    const current = pagePairs(C.list, C.page);
    C.page = btn.dataset.page === "first" ? 1
      : btn.dataset.page === "last" ? current.pages
        : btn.dataset.page === "prev" ? C.page - 1 : C.page + 1;
    C.page = Math.max(1, Math.min(current.pages, C.page));
    C.listKey = "";
    paintList(pagePairs(C.list, C.page));
    $("#cmplist", root).scrollTop = 0;
  });
  $("#cmplist", root).addEventListener("click", (e) => {
    const row = e.target.closest(".srow");
    if (!row) return;
    if (!C.online && String(row.dataset.pair) === String(C.pairId)) return;
    C.ctx.navigate({ pair: row.dataset.pair, online: null });
  });
  $(".bench-compare", root).addEventListener("click", (e) => {
    const act = e.target.closest("[data-act]");
    if (act?.dataset.act === "toggle-list") {
      C.listOff = !C.listOff;
      applyLayout();
    }
  });
  $(".compare-top", root).addEventListener("click", (e) => {
    const act = e.target.closest("[data-act]");
    if (act?.dataset.act === "testsets") {
      if (C.ctx) C.ctx.navigate({ round: null, pair: null, online: null });
      return;
    }
    if (act?.dataset.act === "sync") {
      C.syncScroll = !C.syncScroll;
      act.setAttribute("aria-pressed", String(C.syncScroll));
      wireSyncScroll();
    }
    if (act?.dataset.act === "side") {
      const side = act.dataset.side;
      if (!C.sides || !(side in C.sides)) return;
      const next = { ...C.sides, [side]: !C.sides[side] };
      if (!next.b && !next.a) return;
      C.sides = next;
      C.sidesKey = "";
      const pair = (C.pairs || []).find((item) => String(item.id) === String(C.pairId));
      if (!C.online && pair) paintSides(C.round, pair, null);
    }
  });
}

/* The question list can fold to a rail; the model columns always stay side by side. */
function applyLayout() {
  const bench = $(".bench-compare", C.root);
  const list = $(".compare-list", C.root);
  if (!bench || !list) return;
  bench.classList.toggle("is-list-off", C.listOff);
  list.classList.toggle("is-collapsed", C.listOff);
}

function rowHTML(pair) {
  // A missing side is unknown, never "0 problems": the count is cluster hits, and the row must
  // not imply the release fixed something the data simply does not cover.
  const before = pair.before ? Number(pair.before.n || 0) : null;
  const after = pair.after ? Number(pair.after.n || 0) : null;
  return `<button type="button" class="srow" data-pair="${esc(pair.id)}" style="--c:var(--t3)">
    <span class="bar"></span>
    <span class="srow-body"><span class="q">${esc(pair.q || "（无提问）")}</span>
    <span class="m num"><span class="srow-model">改版前 ${before == null ? "—" : fmt(before)} · 改版后 ${after == null ? "—" : fmt(after)}</span></span></span>
  </button>`;
}

function paintList(page) {
  const root = C.root;
  const key = `${C.gen}|${C.round.id}|${C.query}|${C.page}|${C.list.length}|${C.online || ""}`;
  $("#cmpcount", root).textContent = `${fmt(C.list.length)} / ${fmt(C.pairs.length)} 道同题`;
  const list = $("#cmplist", root);
  if (key !== C.listKey) {
    C.listKey = key;
    list.innerHTML = page.rows.length ? page.rows.map(rowHTML).join("") : `<div class="empty">没有符合条件的题目</div>`;
    renderPager(page.pages);
  }
  $$(".srow", list).forEach((row) => row.setAttribute("aria-current", String(!C.online && String(row.dataset.pair) === String(C.pairId))));
}

function renderPager(pages) {
  const el = $("#cmppager", C.root);
  el.hidden = pages <= 1;
  if (el.hidden) {
    el.innerHTML = "";
    return;
  }
  const btn = (key, label, off) => `<button type="button" data-page="${key}"${off ? " disabled" : ""}>${label}</button>`;
  el.innerHTML = `${btn("first", "«", C.page === 1)}${btn("prev", "上一页", C.page === 1)}
    <span class="pager-info">第 <b class="num">${C.page}</b> / ${pages} 页</span>
    ${btn("next", "下一页", C.page === pages)}${btn("last", "»", C.page === pages)}`;
}

/* ---------------------------------------------------------------- detail panes */
function sideHeadHTML(label, n, side, model) {
  const count = n == null ? "" : `<span class="pill">${fmt(n)} 个落点</span>`;
  const tag = model ? `<small class="compare-model-tag">${esc(model)}</small>` : "";
  return `<div class="pane-head compare-side-head"><span class="cg"><span class="cg-k">${esc(label)}</span>${tag}${count}</span></div>`;
}

function sideHTML(prefix, label, ref, gap, model) {
  const n = ref && !gap ? Number(ref.n || 0) : null;
  const body = gap ? `<div class="empty">这一侧没有可用的评测详情</div>` : detailPaneHTML(prefix);
  return `<section class="pane pane-out pane-sticky compare-side${gap ? " is-gap" : ""}" data-side="${prefix}" aria-label="${esc(label)}">${sideHeadHTML(label, n, prefix, model)}${body}</section>`;
}

/* One switch mirrors the two model columns. Ratio keeps the same part of both details visible
   even when their collapsed heights differ; the lock prevents the mirrored scroll from echoing. */
function wireSyncScroll() {
  const panes = $("#cmppanes", C.root);
  if (!panes) return;
  if (panes._syncCleanup) { panes._syncCleanup(); panes._syncCleanup = null; }
  if (!C.syncScroll) return;
  const scrollers = [...panes.querySelectorAll(".compare-side .pane-scroll")];
  if (scrollers.length < 2) return;
  let lock = false;
  const onScroll = (event) => {
    if (lock) return;
    const source = event.currentTarget;
    const max = source.scrollHeight - source.clientHeight;
    const ratio = max > 0 ? source.scrollTop / max : 0;
    lock = true;
    scrollers.forEach((target) => {
      if (target !== source) target.scrollTop = ratio * Math.max(0, target.scrollHeight - target.clientHeight);
    });
    requestAnimationFrame(() => { lock = false; });
  };
  scrollers.forEach((el) => el.addEventListener("scroll", onScroll, { passive: true }));
  panes._syncCleanup = () => scrollers.forEach((el) => el.removeEventListener("scroll", onScroll));
}

function destroyDetails() {
  C.details.forEach((detail) => {
    try { detail.destroy?.(); } catch (e) { /* already detached */ }
  });
  C.details = [];
}

/* 单 trace 评测把一个会话拆成了多行；对比页拿到的 detail 往往只是其中一条 trace。
   这里按 session id 把同一会话的其它行找回来，交给详情组件重新拼成一整段会话。 */
const INDEX_ROWS = new Map();
async function sampleRows(ctx) {
  const product = ctx.product;
  if (!INDEX_ROWS.has(product)) {
    const index = await ctx.loadIndex(product);
    INDEX_ROWS.set(product, index?.products?.[product]?.rows || []);
  }
  return INDEX_ROWS.get(product);
}

export function sessionRows(rows, sid, model = "", split = "") {
  return (Array.isArray(rows) ? rows : []).filter((row) => String(row.sid || "") === String(sid || "")
    && (!model || !row.m || row.m === model)
    && (!split || !row.sp || row.sp === split));
}

async function expandSession(session, ctx, loadDetail, seed) {
  if (!session || session.rows.length !== 1) return session;
  try {
    const slug = session.rows[0].s;
    if (!seed[slug]) seed[slug] = await loadDetail(slug);
    const detail = seed[slug];
    const sid = detail?.ids?.session;
    // 一份已经聚合好的多 trace 详情就是整段会话，不需要再找兄弟行。
    const traces = Math.max(detail?.input?.traces?.length || 0, detail?.attribution?.turns?.length || 0);
    if (!sid || traces > 1) return session;
    const rows = await sampleRows(ctx);
    const sibs = sessionRows(rows, sid, detail.model || session.m, detail.split || session.sp);
    if (sibs.length <= 1) return session;
    return { ...session, sid, rows: sibs.map((row) => ({ s: row.s })) };
  } catch (err) {
    // 索引导出失败不该把对比页打空：退回单条详情，详情组件自己会给错误态。
    return session;
  }
}

async function mountDetail(host, spec) {
  const ctx = C.ctx;
  const seed = {};
  const session = spec.expand ? await expandSession(spec.session, ctx, spec.loadDetail, seed) : spec.session;
  const detail = createSampleDetail(host, ctx, {
    prefix: spec.prefix,
    product: ctx.product,
    prod: ctx.data?.products?.[ctx.product],
    sessions: [session],
    seedDetails: seed,
    loadDetail: spec.loadDetail,
    // The compared pair is one question inside a whole session; the pane title must name that
    // round, not the session's first question.
    roundQuestion: true,
    // 版本对比的详情栏用更紧凑的折叠：轨迹可收起、中间链路默认收起、最终答案可收起。
    compareFolds: spec.compareFolds === true,
    // Cluster paths have no filter on this page; 具体数据 already owns that drill.
    onPattern: (path) => ctx.navigate({ ...SAMPLE_VIEW_RESET, view: "samples", product: ctx.product, pattern: path }),
  });
  C.details.push(detail);
  await detail.load(session, spec.focus);
  detail.refreshThreads?.();
}

function beforeSession(pair, ref) {
  return { key: ref.detail, rows: [{ s: ref.detail }], sid: "", m: ref.model || "", sp: "", d: "", q: pair.q || "", uid: "", ut: "", case: "" };
}

function afterSession(round, pair, ref) {
  return {
    key: `ab:${round.id}:${ref.detail}`, rows: [{ s: String(ref.detail) }],
    sid: "", m: ref.model || "", sp: "", d: "", q: pair.q || "", uid: "", ut: "", case: "",
  };
}

function onlineSession(slug, ref) {
  return { key: slug, rows: [{ s: slug }], sid: "", m: ref?.model || "", sp: "", d: "", q: ref?.q || "", uid: "", ut: "", case: "" };
}

async function paintSides(round, pair, online) {
  const panes = $("#cmppanes", C.root);
  const sidesKey = `${C.sides.b ? 1 : 0}${C.sides.a ? 1 : 0}`;
  const key = online
    ? `${C.gen}|online|${C.product}|${round.id}|${online}`
    : `${C.gen}|pair|${C.product}|${round.id}|${pair.id}|${sidesKey}`;
  if (C.sidesKey === key) return;
  C.sidesKey = key;
  destroyDetails();
  const token = ++C.token;
  const productData = C.ctx.data?.products?.[C.product];
  const fallbackModel = Array.isArray(round.models) && round.models.length === 1 ? round.models[0] : "";
  const before = online ? null : (pair.before || {});
  const after = online ? null : (pair.after || null);
  const gaps = online ? { before: true, after: true } : pairGaps(pair);
  // 只有一侧有详情时，不要给另一侧留一块空白错误态：单侧就按单列渲染。
  // 用户手动隐藏过某一侧时尊重手动选择，不自动切换。
  const { autoSingle, sides: activeSides } = online
    ? { autoSingle: false, sides: C.sides }
    : sideLayout(gaps, C.sides);
  const onlineSource = online ? onlineRef(round, online) : null;
  const allColumns = online
    ? [{ prefix: "o", label: "线上真实", ref: onlineSource, gap: false, model: onlineSource?.model || fallbackModel, online: true }]
    : [
        { prefix: "b", label: "改版前", ref: before, gap: gaps.before, model: before?.model || fallbackModel },
        { prefix: "a", label: "改版后", ref: after, gap: gaps.after, model: after?.model || fallbackModel },
      ];
  const columns = online ? allColumns : allColumns.filter((column) => activeSides[column.prefix] !== false);
  panes.classList.toggle("is-single", columns.length === 1);
  // 两列及以上才需要折叠；单列就是具体数据页的完整工作台（含 threads）。
  const folds = columns.length > 1;
  const modelHost = $(".compare-models", C.root);
  if (modelHost) {
    modelHost.hidden = !!online || autoSingle;
    if (!online && !autoSingle) {
      const distinct = new Set(allColumns.map((column) => column.model).filter(Boolean)).size > 1;
      modelHost.innerHTML = allColumns.map((column) => {
        const on = C.sides[column.prefix] !== false;
        const main = distinct ? (column.model || column.label) : column.label;
        const sub = distinct ? column.label : (column.model || "");
        return `<button type="button" class="compare-model" data-act="side" data-side="${column.prefix}" aria-pressed="${on}" title="${esc(`${on ? "隐藏" : "显示"} ${column.label}${column.model ? ` · ${column.model}` : ""}`)}">${esc(main)}${sub ? `<small>${esc(sub)}</small>` : ""}</button>`;
      }).join("");
    }
  }
  const rates = columns.map((column) => predictionRate(productData, column.model));
  const hasPrediction = rates.some((rate) => rate != null);
  const caps = rates.map((rate) => `<div class="compare-cap-cell">${rate == null ? "—" : `${fmt(rate, 1)}%`}</div>`).join("");
  panes.classList.toggle("no-pred", !hasPrediction);
  panes.innerHTML = `${hasPrediction ? `<div class="compare-pred">
      <span class="compare-cap-label">预测能力</span>
      <div class="compare-cap-row" style="--cols:${columns.length}">${caps}</div>
    </div>` : ""}
    <div class="compare-side-row${columns.length === 1 ? " is-single" : ""}" style="--cols:${columns.length}">${columns.map((column) => sideHTML(column.prefix, column.label, column.ref, column.gap, column.model)).join("")}</div>`;
  applyLayout();
  const jobs = [];
  if (online) {
    const ref = onlineSource;
    jobs.push(mountDetail(panes.querySelector('[data-side="o"]'), {
      prefix: "o", session: onlineSession(online, ref),
      focus: {},
      expand: true,
      compareFolds: folds,
      loadDetail: (slug) => getJSON(`samples/${encodeURIComponent(slug)}.json`),
    }));
  } else {
    if (!gaps.before && C.sides.b) {
      jobs.push(mountDetail(panes.querySelector('[data-side="b"]'), {
        prefix: "b", session: beforeSession(pair, before),
        focus: { focusTrace: before.trace },
        expand: true,
        compareFolds: folds,
        loadDetail: (slug) => getJSON(`samples/${encodeURIComponent(slug)}.json`),
      }));
    }
    if (!gaps.after && C.sides.a) {
      jobs.push(mountDetail(panes.querySelector('[data-side="a"]'), {
        prefix: "a", session: afterSession(round, pair, after),
        focus: {},
        compareFolds: folds,
        loadDetail: (eq) => getJSON(`ab_samples/${encodeURIComponent(round.id)}/${encodeURIComponent(eq)}.json`),
      }));
    }
  }
  wireSyncScroll();
  await Promise.all(jobs);
  if (token !== C.token) return;
}

/* ---------------------------------------------------------------- render */
export async function render(root, ctx) {
  stopPickerObserver();
  C.root = root;
  C.ctx = ctx;
  C.product = ctx.product;
  const payload = await loadAB(ctx);
  const rounds = Array.isArray(payload?.rounds) ? payload.rounds : [];
  const url = parseCompareURL(location.search);
  const round = url.round ? rounds.find((item) => String(item.id) === String(url.round)) : null;
  if (!round) {
    testsetPicker(root, ctx, rounds);
    return;
  }
  const pairs = Array.isArray(round.pairs) ? round.pairs : [];
  if (!pairs.length) {
    destroyDetails();
    C.skelKey = ""; C.listKey = ""; C.sidesKey = "";
    C.round = round;
    root.innerHTML = `<div class="compare-top">
      <button type="button" class="compare-back" data-act="testsets">${CHEV_LEFT}<span>测试集</span></button>
      <b class="compare-top-name">${esc(roundName(round))}</b>
      <span class="compare-top-meta">${esc(roundMeta(round))}</span>
    </div><div class="bento"><div class="card" style="--span:12"><div class="empty">暂无同题详情</div></div></div>`;
    $(".compare-top", root).addEventListener("click", (event) => {
      if (event.target.closest("[data-act='testsets']")) ctx.navigate({ round: null, pair: null, online: null });
    });
    return;
  }
  C.round = round;
  const skelKey = `${ctx.product}|${round.id}`;
  if (C.skelKey !== skelKey || !root.querySelector(".bench-compare")) {
    destroyDetails();
    C.query = "";
    C.page = 1;
    skeleton(root, round);
    C.skelKey = skelKey;
    C.listKey = "";
    C.sidesKey = "";
  }
  C.gen = payload?.generated_at || "";
  C.round = round;
  C.online = url.online;
  C.pairs = pairs;
  C.list = filterPairs(sortPairs(pairs), C.query);
  let wanted = !url.online && url.pair ? C.list.find((pair) => String(pair.id) === String(url.pair)) : null;
  // A link from the A/B panel can land on a question the still-active search hides. Reset the
  // search only for that deep link, so the selected pair is never silently replaced by page one.
  if ((url.pair && !wanted) || url.online) {
    if (C.query) {
      C.query = "";
      $("#cmpq", root).value = "";
      C.list = filterPairs(sortPairs(pairs), "");
      wanted = !url.online && url.pair ? C.list.find((pair) => String(pair.id) === String(url.pair)) : null;
    }
  }
  if (wanted) C.page = Math.floor(C.list.indexOf(wanted) / PAGE) + 1;
  const page = pagePairs(C.list, C.page);
  C.page = page.page;
  const selected = url.online ? null : (wanted || page.rows[0] || pairs[0]);
  C.pairId = selected ? selected.id : null;
  paintList(page);
  await paintSides(round, selected, url.online);
}
