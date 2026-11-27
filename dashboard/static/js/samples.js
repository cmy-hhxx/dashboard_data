/* 具体数据: recall list → chat transcript → attribution / compact, with evidence → message links. */
import { $, $$, esc, fmt, SEV, WORST, SEV_NAME, sevColor, getJSON } from "./core.js";
import { patternName } from "./taxonomy.js";
import { createSampleDetail, detailPaneHTML, flash, USER_TYPES, utOf, isLostRow } from "./sample_detail.js";

const CHEV_LEFT = `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" aria-hidden="true"><path d="M10 3.5 5.5 8 10 12.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const CHEV_RIGHT = `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const CHEV_DOWN = `<svg class="chev" viewBox="0 0 12 12" width="11" height="11" fill="none" aria-hidden="true"><path d="M3 4.5 6 7.5 9 4.5" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

const PAGE = 50;
const S = {
  product: null, all: [], rows: [], pageRows: [], page: 1, slug: null, refocusList: false, listOff: false,
  serverMode: false, pages: 1, total: 0, matched: 0, hrStats: null,
  facets: null, lastFilterSig: "", reqSeq: 0,
};
let ctx;
let root;
let labelsP = null;
let detail = null;

const params = () => new URLSearchParams(location.search);
const F = () => {
  const q = params();
  return {
    q: q.get("q") || "", w: q.get("w") || "", split: q.get("split") || "", model: q.get("model") || "",
    ut: q.get("ut") || "", hr: q.get("hr") || "", date: q.get("date") || "",
    scene: q.get("scene") || "", sub: q.get("sub") || "", stage: q.get("stage") || "", mech: q.get("mech") || "", pattern: q.get("pattern") || "", sort: q.get("sort") || "sev",
    res: q.get("res") || "", cls: q.get("cls") || "", typ: q.get("typ") || "", cause: q.get("cause") || "",
  };
};
const NO_FILTER = { q: "", w: "", split: "", model: "", ut: "", hr: "", scene: "", sub: "", stage: "", mech: "", pattern: "", date: "", res: "", cls: "", typ: "", cause: "" };
const dirty = () => Object.entries(F()).some(([k, v]) => k !== "sort" && v);
// `sc` is a legacy override kept for old payloads; scene is task, never skill.
const sceneOf = (r) => r.sc || r.task || "未接入分类体系";
const subOf = (r) => r.sub || "";
/* One predicate drives both the cascade options and the final list. When an
   upstream option changes, downstream options reset, so option pools omit the
   field being populated and everything below it (comma-separated in `omit`). */
const cascadeHit = (r, f, omit = "") => {
  const skip = new Set(omit ? omit.split(",") : []);
  return (skip.has("scene") || !f.scene || sceneOf(r) === f.scene) &&
    (skip.has("sub") || !f.sub || subOf(r) === f.sub) &&
    (skip.has("stage") || !f.stage || (r.st || []).includes(f.stage)) &&
    (skip.has("mech") || !f.mech || (r.pt || []).some((x) => x.split(".")[1] === f.mech && (!f.stage || x.startsWith(`${f.stage}.`)))) &&
    (skip.has("pattern") || !f.pattern || (r.pt || []).some((x) => x === f.pattern || x.startsWith(f.pattern + ".")));
};
const severityHit = (r, w) => {
  if (!w) return true;
  const hasCounts = Array.isArray(r.sv) && r.sv.length >= SEV.length;
  if (w === "none") return hasCounts ? !r.sv.some((n) => Number(n) > 0) : r.w === "none";
  const i = SEV.indexOf(w);
  return hasCounts ? i >= 0 && Number(r.sv[i] || 0) > 0 : r.w === w;
};
/* `date` only comes from the heat-cell jump, so it is an applied condition and not a picker:
   a session matches when any of its per-date rows is on that day (a session can span dates). */
const dateHit = (r, f) => !f.date || r.rows.some((x) => x.d === f.date);
/* A date-filtered list reads as that day's slice, so the row shows the day that matched
   instead of the session's last date. */
const rowDate = (r, f) => (f.date && (r.rows.find((x) => x.d === f.date) || {}).d) || r.d;
const listHit = (r, f, omit = "") => {
  const skip = new Set(omit ? omit.split(",") : []);
  return severityHit(r, f.w) &&
    (!f.split || (f.split === "lost" ? isLostRow(r) : r.sp === f.split)) &&
    (!f.model || r.m === f.model) &&
    (!f.ut || utOf(r) === f.ut) &&
    (skip.has("hr") || !f.hr || (f.hr === "human_read" ? Boolean(r.hr) : !r.hr)) &&
    cascadeHit(r, f, omit);
};

/* One list row is one session (per model); traces that were evaluated separately stay
   as rounds of that session instead of separate rows. */
function groupSessions(rows) {
  const groups = new Map();
  rows.forEach((r) => {
    const key = `${r.sp}|${r.m}|${r.sid || r.s}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        key, s: key, rows: [], sid: r.sid, m: r.m, sp: r.sp,
        w: "none", n: 0, tr: 0, sv: [0, 0, 0, 0, 0], hasSv: true, pt: new Set(), st: new Set(), tg: new Set(), lb: new Set(),
        q: "", d: "", tid: "", case: "", task: "", sub: "", skill: "", sc: "", lang: r.lang,
        uid: "", ut: "", ul: 0, hr: 0,
      };
      groups.set(key, g);
    }
    g.rows.push(r);
    g.n += r.n || 0;
    g.tr += r.tr || 1;
    if (Array.isArray(r.sv) && r.sv.length >= SEV.length) {
      r.sv.slice(0, SEV.length).forEach((n, i) => { g.sv[i] += Number(n) || 0; });
    } else g.hasSv = false;
    if (WORST.indexOf(r.w) >= 0 && (g.w === "none" || WORST.indexOf(r.w) < WORST.indexOf(g.w))) g.w = r.w;
    (r.pt || []).forEach((x) => g.pt.add(x));
    (r.st || []).forEach((x) => g.st.add(x));
    (r.tg || []).forEach((x) => g.tg.add(x));
    if (r.lb) g.lb.add(r.lb);
    g.tid = g.tid || r.tid || "";
    g.case = g.case || r.case || "";
    g.task = g.task || r.task || "";
    g.sub = g.sub || r.sub || "";
    g.skill = g.skill || r.skill || "";
    g.sc = g.sc || r.sc || "";
    g.uid = g.uid || r.uid || "";
    g.ut = g.ut || r.ut || "";
    if (r.ul) g.ul = 1;
    if (r.hr) g.hr = 1;
  });
  return [...groups.values()].map((g) => {
    const rowsByDate = g.rows.slice().sort((a, b) =>
      String(a.d || "").localeCompare(String(b.d || "")) ||
      String(a.tid || "").localeCompare(String(b.tid || "")) ||
      String(a.s || "").localeCompare(String(b.s || "")));
    const last = rowsByDate[rowsByDate.length - 1];
    const countedW = g.hasSv ? (SEV.find((s, i) => g.sv[i] > 0) || "none") : g.w;
    return {
      ...last, key: g.key, s: g.key, rows: rowsByDate,
      q: last.q, d: last.d, w: countedW, n: g.n, tr: g.tr, sv: g.hasSv ? g.sv : (Array.isArray(last.sv) ? last.sv : null),
      pt: [...g.pt], st: [...g.st], tg: [...g.tg], lb: [...g.lb].join("｜"),
      tid: g.tid, case: g.case, task: g.task, sub: g.sub, skill: g.skill, sc: g.sc,
      uid: g.uid, ut: g.ut, ul: g.ul, hr: g.hr,
    };
  });
}

/* The full recall index is tens of MB. The first page comes from the small recall head
   (every row of the sessions on the default first page) and the full index replaces it in
   place when it lands. Anything the head cannot answer exactly — a filter, another sort or
   page, a session outside it — waits for the full index instead. */
const sessionKey = (row) => `${row.sp}|${row.m}|${row.sid || row.s}`;
async function indexFor(c) {
  // An in-place refresh never steps back to the head: the reader may be filtering or paging.
  if (c.refresh || c.peekIndex?.(c.product) || !c.loadRecallHead || dirty() || F().sort !== "sev") {
    return c.loadIndex(c.product);
  }
  const head = await c.loadRecallHead(c.product);
  const rows = head?.products?.[c.product]?.rows;
  const wanted = params().get("case");
  if (!rows?.length || (wanted && !rows.some((row) => row.s === wanted || sessionKey(row) === wanted))) {
    return c.loadIndex(c.product);
  }
  return head;
}

/* Fetch the full index once the visible session is on screen, so its details do not share the
   line with tens of MB, then swap it in place (session and scroll stay). */
let upgrading = false;
function upgradeIndex() {
  if (upgrading || !S.prod?.head) return;
  upgrading = true;
  ctx.loadIndex(ctx.product)
    .then(() => { if (S.prod?.head && root?.isConnected && document.documentElement.dataset.view === "samples") return render(root, ctx); })
    .catch(() => {})
    .finally(() => { upgrading = false; });
}

/* Until the full index is in, list interactions queue behind it. */
function whenFull() {
  if (!S.prod?.head) return false;
  $("#slist", root)?.setAttribute("aria-busy", "true");
  ctx.loadIndex(ctx.product).then(() => render(root, ctx)).catch(() => {});
  return true;
}

/* A forecast answer without an attribution sample is not in the index: build its one-row
   session from the generated detail (DetailBuilder.ensure_forecast) so the case can be opened. */
async function addForecastSession(slug) {
  if (!slug || !/^[0-9a-f]{10}$/.test(slug) || S.all.some((x) => x.key === slug || x.rows.some((r) => r.s === slug))) return;
  let d;
  try {
    d = await getJSON(`samples/${slug}.json`);
  } catch (e) {
    return;
  }
  if (!d || !d.forecast) return;
  const row = {
    s: slug, q: d.question, m: d.model, sp: d.split || "daily", d: d.date, sid: d.ids?.session, tid: d.ids?.trace,
    case: d.ids?.case, fc: 1, w: "none", n: 0, tr: d.input?.traces?.length || 1, r: [], st: [], pt: [], tg: [], lb: "", lang: d.lang,
  };
  const g = groupSessions([row])[0];
  g.key = g.s = slug;
  S.all.unshift(g);
}

function filterSig(f) {
  return [f.q, f.w, f.split, f.model, f.ut, f.hr, f.date, f.scene, f.sub, f.stage, f.mech, f.pattern, f.sort].join("\u0001");
}

function buildRecallQuery(f, { page = 1, wanted = "", locate = false, facets = true } = {}) {
  return {
    q: f.q, w: f.w, split: f.split, model: f.model, ut: f.ut, hr: f.hr, date: f.date,
    scene: f.scene, sub: f.sub, stage: f.stage, mech: f.mech, pattern: f.pattern,
    sort: f.sort || "sev", page, size: PAGE,
    case: wanted || "", locate: locate ? "1" : "", facets: facets ? "1" : "0",
  };
}

function applyServerPage(res, f) {
  S.serverMode = true;
  S.prod = { models: res.models || [], splits: res.splits || [] };
  S.page = Number(res.page) || 1;
  S.pages = Math.max(1, Number(res.pages) || 1);
  S.total = Number(res.total_sessions) || 0;
  S.matched = Number(res.matched) || 0;
  S.hrStats = res.hr_stats || null;
  if (res.facets) S.facets = res.facets;
  S.pageRows = Array.isArray(res.rows) ? res.rows : [];
  S.rows = S.pageRows;
  S.all = res.target && !S.pageRows.some((x) => x.key === res.target.key)
    ? [res.target, ...S.pageRows]
    : S.pageRows;
  S.lastFilterSig = filterSig(f);
}

const FACET_KEYS = new Set(["w", "split", "model", "ut", "hr", "scene", "sub"]);

function prefetchNextServerPage(f, dir = 1) {
  if (!S.serverMode || !ctx?.recallPage) return;
  const target = Math.max(1, Math.min(S.pages, S.page + (dir < 0 ? -1 : 1)));
  if (target === S.page) return;
  ctx.recallPage(ctx.product, buildRecallQuery(f, { page: target, facets: false })).catch(() => {});
}

async function fetchServerList({ page = S.page, facets = true, sync = facets, scrollTop = false, prefetchDir = 1 } = {}) {
  if (!S.serverMode || !ctx?.recallPage) return;
  const seq = ++S.reqSeq;
  const f = F();
  $("#slist", root)?.setAttribute("aria-busy", "true");
  const res = await ctx.recallPage(ctx.product, buildRecallQuery(f, { page, facets }));
  if (seq !== S.reqSeq || !root?.isConnected) return;
  if (!res) {
    S.serverMode = false;
    await render(root, ctx);
    return;
  }
  applyServerPage(res, f);
  if (sync) syncFilters();
  else {
    const isDirty = dirty();
    const resetBtn = $("#sreset", root);
    if (resetBtn) resetBtn.hidden = !isDirty;
    $("#stoolbar", root)?.classList.toggle("has-reset", isDirty);
    const sortEl = $("#ssort", root);
    if (sortEl) sortEl.value = f.sort;
  }
  renderList();
  markCurrent();
  if (scrollTop) $("#slist", root).scrollTop = 0;
  prefetchNextServerPage(f, prefetchDir);
}

export async function render(r, c) {
  ctx = c;
  root = r;
  const f = F();
  const focusTrace = params().get("trace") || "";
  const wanted = params().get("case") || "";
  const canServerRecall = !c.forecast && !c.oneSession && typeof c.recallPage === "function";

  if (canServerRecall) {
    const fSig = filterSig(f);
    const sameContext = S.serverMode && S.product === c.product && S.root === root && $(".bench", root) && !c.refresh;
    const hitInPage = sameContext && S.lastFilterSig === fSig
      && (!wanted || S.all.some((x) => x.key === wanted || x.rows.some((row) => row.s === wanted)));

    if (!hitInPage) {
      const seq = ++S.reqSeq;
      const needLocate = Boolean(wanted) && (!sameContext || S.lastFilterSig !== fSig);
      const res = await c.recallPage(c.product, buildRecallQuery(f, {
        page: sameContext && S.lastFilterSig === fSig ? S.page : 1,
        wanted,
        locate: needLocate,
        facets: true,
      }));
      if (seq !== S.reqSeq) return { trace: focusTrace || null, traceMiss: detail ? detail.miss : null };
      if (res) {
        const needShell = S.product !== c.product || !$(".bench", root) || S.root !== root;
        applyServerPage(res, f);
        if (needShell) {
          S.root = root;
          S.product = c.product;
          labelsP = null;
          S.slug = null;
          skeleton();
        }
        if (!S.total) {
          const other = c.product === "wencai" ? "aime" : "wencai";
          root.innerHTML = `<div class="bento"><div class="card" style="--span:12"><div class="empty">${c.product === "wencai" ? "问财" : "AIME"} 暂无样本。${
            res.available?.includes(other) ? `<a class="link" href="?view=samples&product=${other}">查看 ${other === "aime" ? "AIME" : "问财"} 样本</a>` : ""
          }</div></div></div>`;
          S.product = null;
          return;
        }
        syncFilters();
        renderList();
        prefetchNextServerPage(f);
      } else {
        S.serverMode = false;
      }
    }
  } else {
    S.serverMode = false;
  }

  if (!S.serverMode) {
    const index = await indexFor(c);
    const prod = index.products[c.product];
    if (S.product === c.product && S.prod && prod && S.prod !== prod && $(".bench", root)) {
      // Fresh index from an in-place refresh: regroup, keep the reader's session and filters.
      S.all = groupSessions(prod.rows);
      S.prod = prod;
      labelsP = null; // labels are index-aligned; a rebuilt index needs the new file
    }
    // 具体数据 and 预测数据 share this module but not a root: a root that last rendered the other view
    // is rebuilt, or its detail pane would be driven by the wrong instance.
    if (S.product !== c.product || !$(".bench", root) || S.root !== root) {
      S.root = root;
      S.product = c.product;
      labelsP = null;
      S.all = prod ? groupSessions(prod.rows) : [];
      S.prod = prod;
      S.slug = null;
      S.page = 1;
      skeleton();
    }
    if (!prod || !S.all.length) {
      const other = c.product === "wencai" ? "aime" : "wencai";
      root.innerHTML = `<div class="bento"><div class="card" style="--span:12"><div class="empty">${c.product === "wencai" ? "问财" : "AIME"} 暂无样本。${
        index.available?.includes(other) ? `<a class="link" href="?view=samples&product=${other}">查看 ${other === "aime" ? "AIME" : "问财"} 样本</a>` : ""
      }</div></div></div>`;
      S.product = null;
      return;
    }
    if (c.forecast) await addForecastSession(wanted);
    syncFilters();
    renderList();
    // lb is the only search field paint does not need, so it ships separately (4.8MB of
    // the AIME index). Search works without it and gets more accurate when it lands.
    // 5002 单样本页的索引只含该会话那几行（子集），行号对不上全量 labels，由 entry 传
    // oneSession 跳过；那边的调用方要标签直接取 /labels-<product>.json 按行号配对。
    if (!c.oneSession && !prod.head && !c.forecast) {
      labelsP = labelsP || getJSON(`labels-${c.product}.json`)
        .then((payload) => {
          const labels = payload.labels || [];
          prod.rows.forEach((r, i) => { if (labels[i]) r.lb = labels[i]; });
          if (S.prod !== prod) return;
          S.all = groupSessions(prod.rows);
          renderList();
        })
        // A failed fetch must not stick: the next render tries again.
        .catch(() => { labelsP = null; });
    }
  }

  let session = wanted
    ? S.all.find((x) => x.key === wanted) || S.all.find((x) => x.rows.some((r) => r.s === wanted))
    : null;
  if (!session) session = S.rows[0] || S.all[0];
  if (!session) {
    S.slug = null;
    markCurrent();
    return { trace: focusTrace || null, traceMiss: null };
  }
  const key = session.key;
  const focusSlug = wanted && wanted !== key ? wanted : null;
  if (wanted !== key) c.navigate({ case: key }, { replace: true });
  if (!S.serverMode) revealPage(key);
  S.slug = key;
  if (detail) {
    detail.update({ prod: S.prod, sessions: S.all });
    await detail.load(session, { focusSlug, focusTrace, sev: params().get("w") });
  }
  markCurrent();
  const D = detail && detail.data();
  const p = params().get("p");
  if (p != null && D) {
    let pid = Number(p);
    if (focusSlug) {
      const at = D.attribution.problems.findIndex((x) => x.origin?.slug === focusSlug && x.origin?.id === Number(p));
      if (at >= 0) pid = at;
    }
    requestAnimationFrame(() => flash($(`#pc-${pid}`, root)));
  } else if (D) {
    const sev = params().get("w");
    const card = sev && $(`#sattr .pcard[data-sev="${sev}"]`, root);
    if (card) requestAnimationFrame(() => flash(card));
  }
  if (!S.serverMode) upgradeIndex();
  return { trace: focusTrace || null, traceMiss: detail ? detail.miss : null };
}

/* ---------------------------------------------------------------- skeleton & filters */
function skeleton() {
  root.innerHTML = `<div class="bench">
    <aside class="pane pane-sticky compare-list" aria-label="样本列表">
      <button type="button" class="compare-rail-btn" id="srail" title="展开样本列表" aria-label="展开样本列表">${CHEV_RIGHT}<span class="compare-rail-label">样本列表</span></button>
      <div class="pane-head compare-list-head samples-list-head${ctx.forecast ? " is-forecast" : ""}">
        ${ctx.forecast
          ? `<input class="search" id="sq" type="search" placeholder="搜索预测问题" autocomplete="off">
        <div class="filters" id="sf"></div>
        <div class="list-meta"><span id="scount" class="num"></span>
          <span class="meta-end">
            <button type="button" class="reset" id="sreset" hidden>重置</button>
            <label class="sort-wrap"><select id="ssort" aria-label="排序"><option value="sev">默认</option><option value="date">日期新→旧</option></select>${CHEV_DOWN}</label>
            <button type="button" class="compare-icon-btn" id="scollapse" aria-expanded="true" title="折叠样本列表" aria-label="折叠样本列表">${CHEV_LEFT}</button>
          </span></div>`
          : `<div class="search-row">
          <input class="search" id="sq" type="search" placeholder="搜索问题 · Session · Trace ID" autocomplete="off">
          <button type="button" class="compare-icon-btn collapse-btn" id="scollapse" aria-expanded="true" title="折叠样本列表" aria-label="折叠样本列表">${CHEV_LEFT}</button>
        </div>
        <div class="filters" id="sf-sev"></div>
        <div class="list-toolbar" id="stoolbar">
          <label class="sort-wrap"><select id="ssort" aria-label="排序"><option value="sev">严重度优先</option><option value="n">问题数</option><option value="date">日期新→旧</option></select>${CHEV_DOWN}</label>
          <button type="button" class="fmore-btn" id="smore" data-more aria-expanded="false" aria-controls="sfmore"><span>筛选</span><b class="num" id="smore-cnt" hidden></b>${CHEV_DOWN}</button>
          <button type="button" class="reset-btn" id="sreset" hidden>重置</button>
        </div>
        <div class="hr-bar" id="shr" hidden></div>
        <div class="filters" id="sf" hidden></div>`}
      </div>
      <div class="pane-scroll" id="slist" tabindex="0" aria-label="样本"></div>
      <div class="pager" id="spager" hidden></div>
    </aside>
    <section class="pane pane-out pane-sticky" id="sdetail" aria-label="数据详情">${detailPaneHTML()}</section>
  </div>`;
  const applyList = (off) => {
    S.listOff = off;
    $(".bench", root)?.classList.toggle("is-list-off", off);
    $(".compare-list", root)?.classList.toggle("is-collapsed", off);
    $("#scollapse", root)?.setAttribute("aria-expanded", String(!off));
  };
  applyList(S.listOff);
  $("#scollapse", root).addEventListener("click", () => applyList(!S.listOff));
  $("#srail", root).addEventListener("click", () => {
    applyList(false);
    $("#scollapse", root)?.focus({ preventScroll: true });
  });
  detail?.destroy();
  detail = createSampleDetail($("#sdetail", root), ctx, {
    product: ctx.product,
    prod: S.prod,
    sessions: S.all,
    roundQuestion: true,
    loadDetail: (slug) => getJSON(`samples/${slug}.json`),
    onPattern: (pattern) => setFilter({ pattern }),
  });
  let timer;
  $("#sq", root).addEventListener("input", (e) => {
    clearTimeout(timer);
    timer = setTimeout(() => setFilter({ q: e.target.value.trim() }), 200);
  });
  $("#ssort", root).addEventListener("change", (e) => setFilter({ sort: e.target.value }));
  $("#sreset", root).addEventListener("click", () =>
    setFilter({ ...NO_FILTER, sort: "sev" }),
  );
  const head = $(".samples-list-head", root);
  head.addEventListener("click", (e) => {
    const toggle = e.target.closest("[data-more]");
    if (toggle) {
      S.moreOpen = toggle.getAttribute("aria-expanded") !== "true";
      syncFilters();
      return;
    }
    const clearChip = e.target.closest("button[data-clear]");
    if (clearChip) {
      const k = clearChip.dataset.clear;
      if (k === "scene") setFilter({ scene: "", sub: "" });
      else if (k === "cluster") setFilter({ stage: "", mech: "", pattern: "" });
      else setFilter({ [k]: "" });
      return;
    }
    const b = e.target.closest("button[data-k]");
    if (!b) return;
    const cur = F()[b.dataset.k];
    setFilter({ [b.dataset.k]: cur === b.dataset.v ? "" : b.dataset.v });
  });
  head.addEventListener("change", (e) => {
    const s = e.target.closest("select[data-k]");
    if (!s) return;
    const k = s.dataset.k;
    if (k === "scenepath") {
      const [scene = "", sub = ""] = s.value.split("\u0001");
      setFilter({ scene, sub, stage: "", mech: "", pattern: "" });
      return;
    }
    if (k === "cluster") {
      const parts = s.value.split(".");
      const stage = parts[0] === "*" ? "" : parts[0] || "";
      setFilter({ stage, mech: parts[1] || "", pattern: parts.length > 2 ? s.value : "" });
      return;
    }
    const patch = { [k]: s.value };
    if (k === "scene") Object.assign(patch, { sub: "", stage: "", mech: "", pattern: "" });
    if (k === "sub") Object.assign(patch, { stage: "", mech: "", pattern: "" });
    if (k === "stage") Object.assign(patch, { mech: "", pattern: "" });
    if (k === "mech") patch.pattern = "";
    setFilter(patch);
  });
  const pager = $("#spager", root);
  pager.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-page]");
    if (!b) return;
    if (S.serverMode) {
      const action = b.dataset.page;
      const next = action === "first" ? 1
        : action === "last" ? S.pages
        : action === "prev" ? S.page - 1 : S.page + 1;
      const clamped = Math.max(1, Math.min(S.pages, next));
      const prefetchDir = action === "prev" || action === "last" ? -1 : 1;
      if (clamped !== S.page) fetchServerList({ page: clamped, facets: false, sync: false, scrollTop: true, prefetchDir });
      return;
    }
    if (whenFull()) return;
    const pages = Math.max(1, Math.ceil(S.rows.length / PAGE));
    S.page = b.dataset.page === "first" ? 1
      : b.dataset.page === "last" ? pages
      : b.dataset.page === "prev" ? S.page - 1 : S.page + 1;
    S.page = Math.max(1, Math.min(pages, S.page));
    renderList();
    $("#slist", root).scrollTop = 0;
  });
  const list = $("#slist", root);
  list.addEventListener("click", (e) => {
    const b = e.target.closest(".srow");
    const chip = e.target.closest(".vchip");
    if (b) ctx.navigate({ case: chip ? chip.dataset.s : b.dataset.s, p: null });
  });
  list.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const i = S.rows.findIndex((x) => rowHas(x, S.slug));
    const next = S.rows[Math.max(0, Math.min(S.rows.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))];
    if (!next) return;
    S.refocusList = true;   // 换样本会整表重画，焦点要还回新的当前行，否则只能按一次
    ctx.navigate({ case: next.s, p: null }, { replace: true }) || render(root, ctx);
  });

}

function setFilter(patch) {
  ctx.navigate(patch, { replace: true });
  S.page = 1;
  if (S.serverMode) {
    const keys = Object.keys(patch || {});
    const needFacets = !S.facets || keys.some((k) => FACET_KEYS.has(k));
    const needSync = needFacets || keys.some((k) => k !== "q" && k !== "sort");
    if (needSync) syncFilters();
    else {
      const isDirty = dirty();
      const resetBtn = $("#sreset", root);
      if (resetBtn) resetBtn.hidden = !isDirty;
      $("#stoolbar", root)?.classList.toggle("has-reset", isDirty);
    }
    fetchServerList({ page: 1, facets: needFacets, sync: needFacets, scrollTop: true, prefetchDir: 1 });
    return;
  }
  if (whenFull()) return;
  syncFilters();
  renderList();
}

function revealPage(slug) {
  const at = S.rows.findIndex((r) => rowHas(r, slug));
  if (at < 0) return;
  const page = Math.floor(at / PAGE) + 1;
  if (page !== S.page) {
    S.page = page;
    renderList();
  }
}

/* The forecast list head fits the 300px pane: result and version are full-width segments that
   carry their counts (and each version's hit rate), the long-tailed dimensions are selects. */
function forecastFilters(f, p) {
  const count = (key) => {
    const m = new Map();
    S.all.forEach((r) => m.set(r[key], (m.get(r[key]) || 0) + 1));
    return [...m].sort((a, b) => b[1] - a[1]);
  };
  const R = ctx.forecast.result;
  const resColor = { correct: "var(--accent)", wrong: "var(--sev-1)", pending: "var(--muted)" };
  const n = (pred) => S.all.filter(pred).length;
  const seg = (k, v, label, extra, color) =>
    `<button type="button" data-k="${k}" data-v="${esc(v)}" aria-pressed="${f[k] === v}"${color ? ` style="--c:${color}"` : ""}>${color ? "<i></i>" : ""}<span>${esc(label)}</span>${extra}</button>`;
  const res = ["correct", "wrong", "pending"].map((k) =>
    seg("res", k, R[k], `<small class="num">${fmt(n((r) => r.res === k))}</small>`, resColor[k])).join("");
  const vers = p.models.map((m) => {
    const settled = n((r) => r.m === m.id && (r.res === "correct" || r.res === "wrong"));
    const right = n((r) => r.m === m.id && r.res === "correct");
    const rate = settled ? `<small class="num" title="已揭晓 ${fmt(settled)} 份中正确 ${fmt(right)} 份">${Math.round((100 * right) / settled)}%</small>` : "";
    return seg("model", m.id, m.label, rate);
  }).join("");
  const opt = (v, label, on) => `<option value="${esc(v)}"${on ? " selected" : ""}>${esc(label)}</option>`;
  const sel = (k, all, items) => `<select data-k="${k}" aria-label="${all}" class="${f[k] ? "is-on" : ""}"><option value="">${all}</option>${items.map(([v, c]) => opt(v, `${v} · ${fmt(c)}`, f[k] === v)).join("")}</select>`;
  const causes = count("e").filter(([e]) => e);
  return `<div class="frow fc-seg">${res}</div>
    <div class="frow fc-seg is-ver">${vers}</div>
    <div class="cascade fc-sel">${sel("cls", "全部标的", count("c"))}${sel("typ", "全部题型", count("t"))}${causes.length ? sel("cause", "全部归因", causes) : ""}</div>`;
}

function syncFilters() {
  const f = F();
  const p = S.prod;
  const isDirty = dirty();
  $("#sq", root).value !== f.q && document.activeElement !== $("#sq", root) && ($("#sq", root).value = f.q);
  $("#ssort", root).value = f.sort;
  const resetBtn = $("#sreset", root);
  if (resetBtn) resetBtn.hidden = !isDirty;
  $("#stoolbar", root)?.classList.toggle("has-reset", isDirty);
  if (ctx.forecast) {
    $("#sf", root).innerHTML = forecastFilters(f, p);
    return;
  }
  const btn = (k, v, label, color) =>
    `<button type="button" data-k="${k}" data-v="${esc(v)}" aria-pressed="${f[k] === v}"${color ? ` style="--c:${color}"` : ""}>${color ? "<i></i>" : ""}${esc(label)}</button>`;
  const row = (cls, items) => `<div class="frow${cls ? ` ${cls}` : ""}">${items}</div>`;

  const sevHost = $("#sf-sev", root);
  if (sevHost) sevHost.innerHTML = row("sev", WORST.map((w, i) => btn("w", w, SEV_NAME[w], sevColor(i))).join(""));

  const more = (f.model ? 1 : 0)
    + (f.ut ? 1 : 0)
    + (f.split ? 1 : 0)
    + (f.scene || f.sub ? 1 : 0)
    + (f.stage || f.mech || f.pattern ? 1 : 0);
  const open = Boolean(S.moreOpen);
  const moreBtn = $("#smore", root);
  if (moreBtn) {
    moreBtn.setAttribute("aria-expanded", String(open));
    moreBtn.classList.toggle("is-active", more > 0);
    const cnt = $("#smore-cnt", root);
    if (cnt) {
      cnt.hidden = !more;
      cnt.textContent = more ? String(more) : "";
    }
  }

  const tax = ctx.data.taxonomy;
  const opt = (v, label, on) => `<option value="${esc(v)}"${on ? " selected" : ""}>${esc(label)}</option>`;
  // 场景 › 子场景 in one list: picking a sub-scene also pins its scene.
  const subsOf = new Map();
  if (S.serverMode && S.facets?.scenes) {
    Object.entries(S.facets.scenes).forEach(([sc, subs]) => {
      subsOf.set(sc, new Set(Array.isArray(subs) ? subs : []));
    });
  } else {
    const sceneRows = S.all.filter((r) => listHit(r, f, "scene,sub,stage,mech,pattern"));
    sceneRows.forEach((r) => {
      const sc = sceneOf(r);
      if (!subsOf.has(sc)) subsOf.set(sc, new Set());
      if (subOf(r)) subsOf.get(sc).add(subOf(r));
    });
  }
  if (f.scene && !subsOf.has(f.scene)) subsOf.set(f.scene, new Set(f.sub ? [f.sub] : []));
  const sceneValue = f.sub ? `${f.scene}\u0001${f.sub}` : f.scene;
  const sceneOpts = [...subsOf.keys()].sort((a, b) => a.localeCompare(b, "zh")).map((sc) =>
    opt(sc, sc, sceneValue === sc) + [...subsOf.get(sc)].sort((a, b) => a.localeCompare(b, "zh"))
      .map((sb) => opt(`${sc}\u0001${sb}`, `\u3000${sb}`, sceneValue === `${sc}\u0001${sb}`)).join("")).join("");
  let clusterSelect = "";
  let clusterLabel = "";
  if (tax) {
    // 阶段 › 机制 › 模式 in one list, built from the sessions the other filters leave.
    const stagesOn = new Set(), mechsOn = new Set(), paths = new Set();
    if (S.serverMode && S.facets) {
      (S.facets.stages || []).forEach((x) => stagesOn.add(x));
      (S.facets.mechs || []).forEach((x) => mechsOn.add(x));
      (S.facets.patterns || []).forEach((x) => paths.add(x));
    } else {
      const pool = S.all.filter((r) => listHit(r, f, "stage,mech,pattern"));
      pool.forEach((r) => {
        (r.st || []).forEach((x) => stagesOn.add(x));
        (r.pt || []).forEach((x) => { const [st, me] = x.split("."); if (me) mechsOn.add(`${st}.${me}`); paths.add(x); });
      });
    }
    const num = (x) => Number(String(x).replace(/\D/g, "")) || 0;
    const byPath = (a, b) => {
      const pa = a.split("."), pb = b.split(".");
      for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) if (num(pa[i]) !== num(pb[i])) return num(pa[i]) - num(pb[i]);
      return 0;
    };
    const patIds = Object.keys(tax.patterns).filter((id) => [...paths].some((x) => x === id || x.startsWith(`${id}.`))).sort(byPath);
    const mechName = new Map(tax.mechanisms.map((m) => [m.id, m.name]));
    const clusterValue = f.pattern || (f.stage && f.mech ? `${f.stage}.${f.mech}` : f.stage || (f.mech ? `*.${f.mech}` : ""));
    if (f.pattern) clusterLabel = patternName(tax, f.pattern);
    else if (f.stage && f.mech) clusterLabel = `${f.stage}.${f.mech} ${mechName.get(f.mech) || ""}`.trim();
    else if (f.stage) {
      const stObj = tax.stages.find((st) => st.id === f.stage);
      clusterLabel = stObj ? `${stObj.id} ${stObj.name}` : f.stage;
    } else if (f.mech) clusterLabel = `${f.mech} ${mechName.get(f.mech) || ""}`.trim();
    const stageOpts = tax.stages.filter((st) => stagesOn.has(st.id)).sort((a, b) => num(a.id) - num(b.id)).map((st) => {
      const mechs = [...mechsOn].filter((x) => x.startsWith(`${st.id}.`)).sort(byPath);
      return opt(st.id, `${st.id} ${st.name}`, clusterValue === st.id) + mechs.map((sm) =>
        opt(sm, `\u3000${sm} ${mechName.get(sm.split(".")[1]) || ""}`, clusterValue === sm)
        + patIds.filter((id) => id.startsWith(`${sm}.`))
          .map((id) => opt(id, `\u3000\u3000${patternName(tax, id)}`, clusterValue === id)).join("")).join("");
    }).join("");
    const crossStage = f.mech && !f.stage && !f.pattern ? opt(`*.${f.mech}`, `${f.mech} ${mechName.get(f.mech) || ""}`, true) : "";
    const clusterOn = Boolean(f.stage || f.mech || f.pattern);
    clusterSelect = `<label class="sel-wrap${clusterOn ? " is-on" : ""}"><select data-k="cluster" aria-label="聚类"><option value="">全部聚类</option>${crossStage}${stageOpts}</select>${CHEV_DOWN}</label>`;
  }

  const chips = [];
  const chip = (clearKey, text) => `<button type="button" class="fchip" data-clear="${clearKey}"><span>${esc(text)}</span><span aria-hidden="true">×</span></button>`;
  if (f.date) chips.push(chip("date", `日期 ${f.date.slice(5)}`));
  if (!open) {
    if (f.model) {
      const mLabel = (p.models.find((m) => m.id === f.model) || { label: f.model }).label;
      chips.push(chip("model", mLabel));
    }
    if (f.ut) {
      const uLabel = (USER_TYPES.find(([id]) => id === f.ut) || [, f.ut])[1];
      chips.push(chip("ut", uLabel));
    }
    if (f.split === "lost") chips.push(chip("split", "流失用户"));
    if (f.scene || f.sub) chips.push(chip("scene", f.sub || f.scene));
    if (f.stage || f.mech || f.pattern) chips.push(chip("cluster", clusterLabel || f.pattern || f.mech || f.stage));
  }

  const utOn = Boolean(f.ut);
  const sceneOn = Boolean(f.scene || f.sub);
  const hasLost = p.splits.some((s) => s.id === "lost");
  const modelGroup = p.models.length
    ? `<div class="fgroup"><span class="fgroup-label">模型</span><div class="seg-group" role="group" aria-label="模型">${p.models.map((m) => btn("model", m.id, m.label)).join("")}</div></div>`
    : "";
  const panelHtml = `<div class="fpanel" id="sfmore"${open ? "" : " hidden"}>
      ${modelGroup}
      <div class="fgroup">
        <span class="fgroup-label">用户</span>
        <div class="fgroup-row${hasLost ? " has-lost" : ""}">
          <label class="sel-wrap${utOn ? " is-on" : ""}"><select data-k="ut" aria-label="用户类型"><option value="">全部用户</option>${USER_TYPES.map(([id, label]) => opt(id, label, f.ut === id)).join("")}</select>${CHEV_DOWN}</label>
          ${hasLost ? btn("split", "lost", "流失用户") : ""}
        </div>
      </div>
      <div class="fgroup">
        <span class="fgroup-label">归类</span>
        <div class="fgroup-stack">
          <label class="sel-wrap${sceneOn ? " is-on" : ""}"><select data-k="scenepath" aria-label="场景"><option value="">全部场景</option>${sceneOpts}</select>${CHEV_DOWN}</label>
          ${clusterSelect}
        </div>
      </div>
    </div>`;

  const sfEl = $("#sf", root);
  sfEl.innerHTML = `${chips.length ? `<div class="fchips">${chips.join("")}</div>` : ""}${panelHtml}`;
  sfEl.hidden = !chips.length && !open;
}

function computeHrStats(f) {
  if (S.serverMode && S.hrStats) return S.hrStats;
  const needle = (f.q || "").toLowerCase();
  const hit = (r) =>
    !needle ||
    [r.q, r.lb, r.s, r.sid, r.tid, r.case, r.task, r.sub, r.skill].some((x) => x && String(x).toLowerCase().includes(needle)) ||
    (r.rows || []).some((x) => [x.q, x.sid, x.tid, x.case, x.task, x.sub, x.skill].some((v) => v && String(v).toLowerCase().includes(needle)));
  const pool = S.all.filter((r) => listHit(r, f, "hr") && dateHit(r, f) && hit(r));
  const hr = pool.filter((r) => r.hr).length;
  const hrTotal = S.all.filter((r) => r.hr).length;
  return { hr, raw: Math.max(0, pool.length - hr), total: pool.length, hr_total: hrTotal };
}

function shouldShowHr(stats) {
  return !ctx.forecast && (S.product === "aime" || (stats && stats.hr_total > 0));
}

function renderHrBar(f, stats) {
  const el = $("#shr", root);
  if (!el) return;
  const show = shouldShowHr(stats);
  el.hidden = !show;
  if (!show) {
    el.innerHTML = "";
    return;
  }
  const total = Number(stats?.total || 0);
  const hr = Number(stats?.hr || 0);
  const raw = Math.max(0, Number(stats?.raw ?? (total - hr)));
  const pct = total > 0 ? Math.round((1000 * hr) / total) / 10 : 0;
  const rawPct = total > 0 ? Math.round((100 - pct) * 10) / 10 : 0;
  const fmtPct = (v) => `${v % 1 === 0 ? v.toFixed(0) : v.toFixed(1)}%`;
  const arc = total > 0 ? Math.max(hr > 0 ? 1.5 : 0, Math.min(100, (100 * hr) / total)) : 0;
  el.innerHTML = `<span class="hr-ring" title="human_read ${fmt(hr)} · raw ${fmt(raw)}">
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <circle class="hr-ring-track" cx="10" cy="10" r="7.5" pathLength="100"></circle>
        <circle class="hr-ring-arc" cx="10" cy="10" r="7.5" pathLength="100" stroke-dasharray="${arc.toFixed(2)} 100"></circle>
      </svg>
    </span>
    <button type="button" class="hr-stat is-hr" data-k="hr" data-v="human_read" aria-pressed="${f.hr === "human_read"}" title="human_read ${fmt(hr)} / ${fmt(total)}"><i aria-hidden="true"></i><span>human_read</span><b class="num">${fmtPct(pct)}</b></button>
    <button type="button" class="hr-stat is-raw" data-k="hr" data-v="raw" aria-pressed="${f.hr === "raw"}" title="raw ${fmt(raw)} / ${fmt(total)}"><i aria-hidden="true"></i><span>raw</span><b class="num">${fmtPct(rawPct)}</b></button>`;
}

function renderList() {
  const f = F();
  let questionTotal = 0;
  let answerTotal = 0;
  let pages = 1;
  let countForPager = 0;
  const label = (id) => (S.prod.models.find((m) => m.id === id) || { label: id }).label;
  const scountEl = $("#scount", root);

  if (S.serverMode) {
    pages = S.pages;
    countForPager = S.matched;
  } else {
    const needle = f.q.toLowerCase();
    const hit = (r) =>
      !needle ||
      [r.q, r.lb, r.s, r.sid, r.tid, r.case, r.task, r.sub, r.skill].some((x) => x && String(x).toLowerCase().includes(needle)) ||
      r.rows.some((x) => [x.q, x.sid, x.tid, x.case, x.task, x.sub, x.skill].some((v) => v && String(v).toLowerCase().includes(needle)));
    S.rows = ctx.forecast
      ? S.all.filter(
          (r) =>
            (!f.res || r.res === f.res) && (!f.model || r.m === f.model) && (!f.cls || r.c === f.cls) &&
            (!f.typ || r.t === f.typ) && (!f.cause || r.e === f.cause) &&
            (!needle || [r.q, r.s].some((x) => x && String(x).toLowerCase().includes(needle))),
        )
      : S.all.filter(
          (r) =>
            listHit(r, f) &&
            dateHit(r, f) &&
            hit(r),
        );
    if (ctx.forecast) {
      // One list row per question: its versions' answers are chips inside the row.
      const order = new Map(S.prod.models.map((m, i) => [m.id, i]));
      const versions = new Map();
      S.all.forEach((r) => {
        const k = r.qi != null ? r.qi : r.s;
        if (!versions.has(k)) versions.set(k, []);
        versions.get(k).push(r);
      });
      questionTotal = versions.size;
      const hits = new Set(S.rows.map((r) => r.s));
      const seen = new Set();
      const rows = [];
      S.rows.forEach((r) => {
        const k = r.qi != null ? r.qi : r.s;
        if (seen.has(k)) return;
        seen.add(k);
        const vs = versions.get(k).slice().sort((a, b) => (order.get(a.m) ?? 99) - (order.get(b.m) ?? 99));
        answerTotal += vs.filter((x) => hits.has(x.s)).length;
        rows.push({ ...r, s: (vs.find((x) => hits.has(x.s)) || r).s, slugs: vs.map((x) => x.s), vers: vs.map((x) => ({ ...x, hit: hits.has(x.s) })) });
      });
      S.rows = rows;
    }
    if (f.sort === "n") S.rows = S.rows.slice().sort((a, b) => b.n - a.n);
    if (f.sort === "date") S.rows = S.rows.slice().sort((a, b) => (a.d < b.d ? 1 : -1));
    pages = Math.max(1, Math.ceil(S.rows.length / PAGE));
    S.page = Math.max(1, Math.min(pages, S.page));
    S.pageRows = S.rows.slice((S.page - 1) * PAGE, S.page * PAGE);
    // The head holds only the first page; its counts come from the full index it was cut from.
    const total = S.prod.head ? S.prod.head.sessions : S.all.length;
    if (scountEl && ctx.forecast) {
      scountEl.textContent = `${fmt(S.rows.length)} / ${fmt(questionTotal)} 题 · ${fmt(answerTotal)} 份回答`;
      scountEl.removeAttribute("title");
    }
    pages = S.prod.head ? Math.max(1, Math.ceil(total / PAGE)) : pages;
    countForPager = S.prod.head ? total : S.rows.length;
  }
  $("#slist", root).removeAttribute("aria-busy");
  const hrStats = computeHrStats(f);
  const showHr = shouldShowHr(hrStats);
  renderHrBar(f, hrStats);
  const resColor = { correct: "var(--accent)", wrong: "var(--sev-1)", pending: "var(--muted)" };
  $("#slist", root).innerHTML = S.pageRows.length
    ? S.pageRows
        .map(
          (r) => ctx.forecast
            ? `<button type="button" class="srow" data-s="${r.s}" data-ss="${r.slugs.join(",")}" style="--c:${resColor[r.res] || "var(--faint)"}" aria-current="${r.slugs.includes(S.slug)}">
      <span class="bar"></span><span class="srow-body"><span class="q">${esc(r.q || "（无提问）")}</span>
      <span class="m num"><span>${esc((r.d || "").slice(5))}</span><span>${esc(r.c || "")} · ${esc(r.t || "")}</span></span>
      <span class="vchips">${r.vers.map((x) => `<span class="vchip${x.hit ? "" : " is-off"}" data-s="${x.s}" style="--c:${resColor[x.res] || "var(--muted)"}" title="${esc(`${label(x.m)} · ${ctx.forecast.result[x.res] || x.res || ""}${x.e ? ` · ${x.e}` : ""}`)}"><i></i>${esc(label(x.m))}</span>`).join("")}</span></span></button>`
            : `<button type="button" class="srow" data-s="${r.s}" style="--c:${sevColor(r.w)}" aria-current="${r.s === S.slug}">
      <span class="bar"></span><span class="srow-body"><span class="q">${esc(r.q || "（无提问）")}</span>
      <span class="m num"><span class="srow-model">${esc(label(r.m))}</span><span>${rowDate(r, f).slice(5)}</span>${r.tr > 1 ? `<span>${r.tr} 轮</span>` : ""}<span class="srow-sev" style="color:${r.w === "none" ? "var(--muted)" : sevColor(r.w)}">${r.w === "none" ? "无问题" : r.w}</span>${
            isLostRow(r) ? '<span class="tag-lost">流失</span>' : ""
          }${showHr ? `<span class="tag-hr ${r.hr ? "is-hr" : "is-raw"}">${r.hr ? "human_read" : "raw"}</span>` : ""}</span></span></button>`,
        )
        .join("")
    : `<div class="empty">没有符合条件的会话<br><button type="button" class="link" id="sclear">清除筛选</button></div>`;
  renderPager(pages, countForPager);
  const clear = $("#sclear", root);
  clear && clear.addEventListener("click", () => setFilter({ ...NO_FILTER }));
}

function renderPager(pages, count) {
  const el = $("#spager", root);
  if (!el) return;
  el.hidden = count <= PAGE;
  if (el.hidden) {
    el.innerHTML = "";
    return;
  }
  const btn = (key, label, off) => `<button type="button" data-page="${key}"${off ? " disabled" : ""}>${label}</button>`;
  // The total count already sits in the list meta above; repeating it here pushed the last
  // button past the 300px pane, so the pager only carries the page it is on.
  el.innerHTML = `${btn("first", "«", S.page === 1)}${btn("prev", "上一页", S.page === 1)}
    <span class="pager-info">第 <b class="num">${fmt(S.page)}</b> / ${fmt(pages)} 页</span>
    ${btn("next", "下一页", S.page === pages)}${btn("last", "»", S.page === pages)}`;
}

const rowHas = (r, slug) => r.s === slug || (r.slugs || []).includes(slug);
const rowEl = (b) => b.dataset.s === S.slug || (b.dataset.ss || "").split(",").includes(S.slug);

function markCurrent() {
  $$(".srow", root).forEach((b) => b.setAttribute("aria-current", String(rowEl(b))));
  $$(".vchip", root).forEach((c) => c.classList.toggle("is-cur", c.dataset.s === S.slug));
  const cur = $$(".srow", root).find(rowEl);
  if (cur) {
    const list = $("#slist", root);
    const r = cur.getBoundingClientRect();
    const lr = list.getBoundingClientRect();
    if (r.top < lr.top || r.bottom > lr.bottom) cur.scrollIntoView({ block: "nearest" });
    if (S.refocusList) { S.refocusList = false; cur.focus({ preventScroll: true }); }
  }
}

