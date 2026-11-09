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
  listOff: false, syncScroll: false, fold: { b: false, a: false },
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

function testsetPicker(root, ctx, rounds) {
  destroyDetails();
  C.skelKey = ""; C.listKey = ""; C.sidesKey = "";
  const cards = (Array.isArray(rounds) ? rounds : []).map((round, i) => {
    const name = roundName(round, i);
    return `<button type="button" class="compare-picker-card" data-round="${esc(round.id)}">
      <span class="compare-picker-name">${esc(name)}</span>
      <span class="compare-picker-meta">${esc(roundMeta(round))}</span>
      ${CHEV_RIGHT}
    </button>`;
  }).join("");
  root.innerHTML = `<section class="compare-picker">
    <h1>版本对比</h1>
    <div class="compare-picker-lead">选择测试集</div>
    <div class="compare-picker-grid">${cards || `<div class="empty">暂无测试集</div>`}</div>
  </section>`;
  $(".compare-picker", root).addEventListener("click", (event) => {
    const card = event.target.closest("[data-round]");
    if (card && C.ctx) C.ctx.navigate({ round: card.dataset.round, pair: null, online: null });
  });
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

async function mountDetail(host, spec) {
  const ctx = C.ctx;
  const detail = createSampleDetail(host, ctx, {
    prefix: spec.prefix,
    product: ctx.product,
    prod: ctx.data?.products?.[ctx.product],
    sessions: [spec.session],
    loadDetail: spec.loadDetail,
    // The compared pair is one question inside a whole session; the pane title must name that
    // round, not the session's first question.
    roundQuestion: true,
    // Cluster paths have no filter on this page; 具体数据 already owns that drill.
    onPattern: (path) => ctx.navigate({ ...SAMPLE_VIEW_RESET, view: "samples", product: ctx.product, pattern: path }),
  });
  C.details.push(detail);
  await detail.load(spec.session, spec.focus);
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
  const key = online
    ? `${C.gen}|online|${C.product}|${round.id}|${online}`
    : `${C.gen}|pair|${C.product}|${round.id}|${pair.id}`;
  if (C.sidesKey === key) return;
  C.sidesKey = key;
  destroyDetails();
  const token = ++C.token;
  const productData = C.ctx.data?.products?.[C.product];
  const fallbackModel = Array.isArray(round.models) && round.models.length === 1 ? round.models[0] : "";
  const before = online ? null : (pair.before || {});
  const after = online ? null : (pair.after || null);
  const gaps = online ? { before: true, after: true } : pairGaps(pair);
  const onlineSource = online ? onlineRef(round, online) : null;
  const columns = online
    ? [{ prefix: "o", label: "线上真实", ref: onlineSource, gap: false, model: onlineSource?.model || fallbackModel, online: true }]
    : [
        { prefix: "b", label: "改版前", ref: before, gap: gaps.before, model: before?.model || fallbackModel },
        { prefix: "a", label: "改版后", ref: after, gap: gaps.after, model: after?.model || fallbackModel },
      ];
  panes.classList.toggle("is-single", !!online);
  const caps = columns.map((column) => {
    const rate = predictionRate(productData, column.model);
    return `<div class="compare-cap-cell">${rate == null ? "—" : `${fmt(rate, 1)}%`}</div>`;
  }).join("");
  panes.innerHTML = `<div class="compare-pred">
      <span class="compare-cap-label">预测能力</span>
      <div class="compare-cap-row" style="--cols:${columns.length}">${caps}</div>
    </div>
    <div class="compare-side-row" style="--cols:${columns.length}">${columns.map((column) => sideHTML(column.prefix, column.label, column.ref, column.gap, column.model)).join("")}</div>`;
  applyLayout();
  const jobs = [];
  if (online) {
    const ref = onlineSource;
    jobs.push(mountDetail(panes.querySelector('[data-side="o"]'), {
      prefix: "o", session: onlineSession(online, ref),
      focus: {},
      loadDetail: (slug) => getJSON(`samples/${encodeURIComponent(slug)}.json`),
    }));
  } else {
    if (!gaps.before) {
      jobs.push(mountDetail(panes.querySelector('[data-side="b"]'), {
        prefix: "b", session: beforeSession(pair, before),
        focus: { focusTrace: before.trace },
        loadDetail: (slug) => getJSON(`samples/${encodeURIComponent(slug)}.json`),
      }));
    }
    if (!gaps.after) {
      jobs.push(mountDetail(panes.querySelector('[data-side="a"]'), {
        prefix: "a", session: afterSession(round, pair, after),
        focus: {},
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
