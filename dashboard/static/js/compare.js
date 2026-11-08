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

/* ---------------------------------------------------------------- shell */
function skeleton(root) {
  root.innerHTML = `<div class="bench bench-compare">
    <aside class="pane pane-sticky compare-list" aria-label="同题列表">
      <div class="pane-head">
        <input class="search" id="cmpq" type="search" placeholder="搜索问题" autocomplete="off">
        <div class="list-meta"><span id="cmpcount" class="num"></span></div>
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
function sideHeadHTML(label, n) {
  const count = n == null ? "" : `<span class="pill">${fmt(n)} 个落点</span>`;
  return `<div class="pane-head compare-side"><span class="cg"><span class="cg-k">${esc(label)}</span>${count}</span></div>`;
}

function sideHTML(prefix, label, ref, gap) {
  const n = ref && !gap ? Number(ref.n || 0) : null;
  const body = gap ? `<div class="empty">这一侧没有可用的评测详情</div>` : detailPaneHTML(prefix);
  return `<section class="pane pane-out pane-sticky compare-side" data-side="${prefix}" aria-label="${esc(label)}">${sideHeadHTML(label, n)}${body}</section>`;
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
  if (online) {
    panes.classList.add("is-single");
    const ref = onlineRef(round, online);
    panes.innerHTML = `<section class="pane pane-out pane-sticky compare-side" data-side="o" aria-label="线上真实">
      ${sideHeadHTML("线上真实", ref && Array.isArray(ref.paths) ? ref.paths.length : null)}
      ${detailPaneHTML("o")}
    </section>`;
    await mountDetail(panes.querySelector('[data-side="o"]'), {
      prefix: "o", session: onlineSession(online, ref),
      focus: {},
      loadDetail: (slug) => getJSON(`samples/${encodeURIComponent(slug)}.json`),
    });
    if (token !== C.token) return;
    return;
  }
  panes.classList.remove("is-single");
  const before = pair.before || {};
  const after = pair.after || null;
  const gaps = pairGaps(pair);
  panes.innerHTML = sideHTML("b", "改版前", before, gaps.before) + sideHTML("a", "改版后", after, gaps.after);
  const jobs = [];
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
  const round = pickRound(rounds, url.round);
  const pairs = round && Array.isArray(round.pairs) ? round.pairs : [];
  if (!round || !pairs.length) {
    destroyDetails();
    C.skelKey = ""; C.listKey = ""; C.sidesKey = "";
    root.innerHTML = `<div class="bento"><div class="card" style="--span:12"><div class="empty">暂无版本对比数据</div></div></div>`;
    return;
  }
  const skelKey = `${ctx.product}|${round.id}`;
  if (C.skelKey !== skelKey || !root.querySelector(".bench-compare")) {
    destroyDetails();
    C.query = "";
    C.page = 1;
    skeleton(root);
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
