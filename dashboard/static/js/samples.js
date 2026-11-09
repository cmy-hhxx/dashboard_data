/* 具体数据: recall list → chat transcript → attribution / compact, with evidence → message links. */
import { $, $$, esc, fmt, SEV, WORST, SEV_NAME, sevColor, getJSON } from "./core.js";
import { createSampleDetail, detailPaneHTML, flash, USER_TYPES, utOf, isLostRow } from "./sample_detail.js";

const CHEV_LEFT = `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" aria-hidden="true"><path d="M10 3.5 5.5 8 10 12.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const CHEV_RIGHT = `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

const PAGE = 50;
const S = { product: null, all: [], rows: [], pageRows: [], page: 1, slug: null, refocusList: false, listOff: false };
let ctx;
let root;
let labelsP = null;
let detail = null;

const params = () => new URLSearchParams(location.search);
const F = () => {
  const q = params();
  return {
    q: q.get("q") || "", w: q.get("w") || "", split: q.get("split") || "", model: q.get("model") || "",
    ut: q.get("ut") || "", date: q.get("date") || "",
    scene: q.get("scene") || "", sub: q.get("sub") || "", stage: q.get("stage") || "", mech: q.get("mech") || "", pattern: q.get("pattern") || "", sort: q.get("sort") || "sev",
  };
};
const dirty = () => Object.entries(F()).some(([k, v]) => k !== "sort" && v);
// `sc` is the scene the matrix filed the sample under when it differs from task / skill (问财 B versions).
const sceneOf = (r) => r.sc || r.task || r.skill || "未接入分类体系";
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
const listHit = (r, f, omit = "") =>
  severityHit(r, f.w) &&
  (!f.split || (f.split === "lost" ? isLostRow(r) : r.sp === f.split)) &&
  (!f.model || r.m === f.model) &&
  (!f.ut || utOf(r) === f.ut) &&
  cascadeHit(r, f, omit);

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
        uid: "", ut: "", ul: 0,
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
  });
  return [...groups.values()].map((g) => {
    const rowsByDate = g.rows.slice().sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));
    const last = rowsByDate[rowsByDate.length - 1];
    const countedW = g.hasSv ? (SEV.find((s, i) => g.sv[i] > 0) || "none") : g.w;
    return {
      ...last, key: g.key, s: g.key, rows: g.rows,
      q: last.q, d: last.d, w: countedW, n: g.n, tr: g.tr, sv: g.hasSv ? g.sv : (Array.isArray(last.sv) ? last.sv : null),
      pt: [...g.pt], st: [...g.st], tg: [...g.tg], lb: [...g.lb].join("｜"),
      tid: g.tid, case: g.case, task: g.task, sub: g.sub, skill: g.skill, sc: g.sc,
      uid: g.uid, ut: g.ut, ul: g.ul,
    };
  });
}

export async function render(r, c) {
  ctx = c;
  root = r;
  const index = await c.loadIndex(c.product);
  const prod = index.products[c.product];
  if (S.product === c.product && S.prod && prod && S.prod !== prod && $(".bench", root)) {
    // Fresh index from an in-place refresh: regroup, keep the reader's session and filters.
    S.all = groupSessions(prod.rows);
    S.prod = prod;
    labelsP = null; // labels are index-aligned; a rebuilt index needs the new file
  }
  if (S.product !== c.product || !$(".bench", root)) {
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
  syncFilters();
  renderList();
  // lb is the only search field paint does not need, so it ships separately (4.8MB of
  // the AIME index). Search works without it and gets more accurate when it lands.
  // 5002 单样本页的索引只含该会话那几行（子集），行号对不上全量 labels，由 entry 传
  // oneSession 跳过；那边的调用方要标签直接取 /labels-<product>.json 按行号配对。
  if (!c.oneSession) {
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
  const focusTrace = params().get("trace") || "";
  const wanted = params().get("case");
  let session = wanted
    ? S.all.find((x) => x.key === wanted) || S.all.find((x) => x.rows.some((r) => r.s === wanted))
    : null;
  if (!session) session = S.rows[0] || S.all[0];
  const key = session.key;
  const focusSlug = wanted && wanted !== key ? wanted : null;
  if (wanted !== key) c.navigate({ case: key }, { replace: true });
  revealPage(key);
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
  return { trace: focusTrace || null, traceMiss: detail ? detail.miss : null };
}

/* ---------------------------------------------------------------- skeleton & filters */
function skeleton() {
  root.innerHTML = `<div class="bench">
    <aside class="pane pane-sticky compare-list" aria-label="样本列表">
      <button type="button" class="compare-rail-btn" id="srail" title="展开样本列表" aria-label="展开样本列表">${CHEV_RIGHT}<span class="compare-rail-label">样本列表</span></button>
      <div class="pane-head compare-list-head">
        <input class="search" id="sq" type="search" placeholder="搜索问题 · Session ID · Trace ID" autocomplete="off">
        <div class="filters" id="sf"></div>
        <div class="list-meta"><span id="scount" class="num"></span>
          <span class="meta-end">
            <button type="button" class="reset" id="sreset" hidden>重置</button>
            <select id="ssort" aria-label="排序"><option value="sev">严重度优先</option><option value="n">问题数</option><option value="date">日期新→旧</option></select>
            <button type="button" class="compare-icon-btn" id="scollapse" aria-expanded="true" title="折叠样本列表" aria-label="折叠样本列表">${CHEV_LEFT}</button>
          </span></div>
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
    loadDetail: (slug) => getJSON(`samples/${slug}.json`),
    onPattern: (pattern) => setFilter({ pattern }),
  });
  let timer;
  $("#sq", root).addEventListener("input", (e) => {
    clearTimeout(timer);
    timer = setTimeout(() => setFilter({ q: e.target.value.trim() }), 140);
  });
  $("#ssort", root).addEventListener("change", (e) => setFilter({ sort: e.target.value }));
  $("#sreset", root).addEventListener("click", () =>
    setFilter({ q: "", w: "", split: "", model: "", ut: "", date: "", scene: "", sub: "", stage: "", mech: "", pattern: "", sort: "sev" }),
  );
  $("#sf", root).addEventListener("click", (e) => {
    const b = e.target.closest("button[data-k]");
    if (!b) return;
    const cur = F()[b.dataset.k];
    setFilter({ [b.dataset.k]: cur === b.dataset.v ? "" : b.dataset.v });
  });
  $("#sf", root).addEventListener("change", (e) => {
    const s = e.target.closest("select[data-k]");
    if (!s) return;
    const k = s.dataset.k;
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
    if (b) ctx.navigate({ case: b.dataset.s, p: null });
  });
  list.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const i = S.rows.findIndex((x) => x.s === S.slug);
    const next = S.rows[Math.max(0, Math.min(S.rows.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))];
    if (!next) return;
    S.refocusList = true;   // 换样本会整表重画，焦点要还回新的当前行，否则只能按一次
    ctx.navigate({ case: next.s, p: null }, { replace: true }) || render(root, ctx);
  });

}

function setFilter(patch) {
  ctx.navigate(patch, { replace: true });
  S.page = 1;
  syncFilters();
  renderList();
}

function revealPage(slug) {
  const at = S.rows.findIndex((r) => r.s === slug);
  if (at < 0) return;
  const page = Math.floor(at / PAGE) + 1;
  if (page !== S.page) {
    S.page = page;
    renderList();
  }
}

function syncFilters() {
  const f = F();
  const p = S.prod;
  $("#sq", root).value !== f.q && document.activeElement !== $("#sq", root) && ($("#sq", root).value = f.q);
  $("#ssort", root).value = f.sort;
  const resetBtn = $("#sreset", root);
  if (resetBtn) resetBtn.hidden = !dirty();
  const btn = (k, v, label, color) =>
    `<button type="button" data-k="${k}" data-v="${esc(v)}" aria-pressed="${f[k] === v}"${color ? ` style="--c:${color}"` : ""}>${color ? "<i></i>" : ""}${esc(label)}</button>`;
  const row = (cls, items) => `<div class="frow${cls ? ` ${cls}` : ""}">${items}</div>`;
  let html = f.date ? row("", btn("date", f.date, `日期 ${f.date.slice(5)} ×`)) : "";
  html += row("sev", WORST.map((w, i) => btn("w", w, SEV_NAME[w], sevColor(i))).join(""));
  if (p.splits.some((s) => s.id === "lost")) html += row("", btn("split", "lost", "仅看流失用户"));
  html += row("", p.models.map((m) => btn("model", m.id, m.label)).join(""));

  const tax = ctx.data.taxonomy;
  if (tax) {
    const byNum = (a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1));
    const scenes = [...new Set([...S.all.filter((r) => listHit(r, f, "scene,sub,stage,mech,pattern")).map(sceneOf), f.scene].filter(Boolean))]
      .sort((a, b) => a.localeCompare(b, "zh"));
    const subs = [...new Set([...S.all.filter((r) => listHit(r, f, "sub,stage,mech,pattern")).map(subOf), f.sub].filter(Boolean))]
      .sort((a, b) => a.localeCompare(b, "zh"));
    const stages = tax.stages.filter((s) => S.all.some((r) => listHit(r, f, "stage,mech,pattern") && (r.st || []).includes(s.id))).sort(byNum);
    const mechs = tax.mechanisms.filter((m) => S.all.some((r) => listHit(r, f, "mech,pattern") && (r.pt || []).some((x) => x.split(".")[1] === m.id && (!f.stage || x.startsWith(`${f.stage}.`))))).sort(byNum);
    const pats = Object.keys(tax.patterns)
      .filter((id) => {
        return S.all.some((r) => listHit(r, f, "pattern") && (r.pt || []).some((x) => x === id || x.startsWith(id + ".")));
      })
      .sort((a, b) => {
        const pa = a.split(".").map((x) => Number(x.replace(/\D/g, "")) || 0);
        const pb = b.split(".").map((x) => Number(x.replace(/\D/g, "")) || 0);
        for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
          if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
        }
        return 0;
      });
    const opt = (v, label, on) => `<option value="${esc(v)}"${on ? " selected" : ""}>${esc(label)}</option>`;
    html += `<div class="cascade">
      <select data-k="ut" aria-label="用户类型" class="wide"><option value="">全部用户类型</option>${USER_TYPES.map(([id, label]) => opt(id, label, f.ut === id)).join("")}</select>
      <select data-k="scene" aria-label="场景"><option value="">全部场景</option>${scenes.map((s) => opt(s, s, f.scene === s)).join("")}</select>
      <select data-k="sub" aria-label="子场景"><option value="">全部子场景</option>${subs.map((s) => opt(s, s, f.sub === s)).join("")}</select>
      <select data-k="stage" aria-label="阶段"><option value="">全部阶段</option>${stages.map((s) => opt(s.id, `${s.id} ${s.name}`, f.stage === s.id)).join("")}</select>
      <select data-k="mech" aria-label="机制"><option value="">全部机制</option>${mechs.map((m) => opt(m.id, `${m.id} ${m.name}`, f.mech === m.id)).join("")}</select>
      <select data-k="pattern" aria-label="模式" class="wide"><option value="">全部模式</option>${pats.map((id) => opt(id, `${(tax.patterns[id] || {}).name || id} · ${id}`, f.pattern === id)).join("")}</select>
    </div>`;
  }
  $("#sf", root).innerHTML = html;
}

function renderList() {
  const f = F();
  const needle = f.q.toLowerCase();
  const hit = (r) =>
    !needle ||
    [r.q, r.lb, r.s, r.sid, r.tid, r.case, r.task, r.sub, r.skill].some((x) => x && String(x).toLowerCase().includes(needle)) ||
    r.rows.some((x) => [x.q, x.sid, x.tid, x.case, x.task, x.sub, x.skill].some((v) => v && String(v).toLowerCase().includes(needle)));
  S.rows = S.all.filter(
    (r) =>
      listHit(r, f) &&
      dateHit(r, f) &&
      hit(r),
  );
  if (f.sort === "n") S.rows = S.rows.slice().sort((a, b) => b.n - a.n);
  if (f.sort === "date") S.rows = S.rows.slice().sort((a, b) => (a.d < b.d ? 1 : -1));
  const pages = Math.max(1, Math.ceil(S.rows.length / PAGE));
  S.page = Math.max(1, Math.min(pages, S.page));
  S.pageRows = S.rows.slice((S.page - 1) * PAGE, S.page * PAGE);
  const label = (id) => (S.prod.models.find((m) => m.id === id) || { label: id }).label;
  $("#scount", root).textContent = `${fmt(S.rows.length)} / ${fmt(S.all.length)} 个会话`;
  $("#slist", root).innerHTML = S.pageRows.length
    ? S.pageRows
        .map(
          (r) => `<button type="button" class="srow" data-s="${r.s}" style="--c:${sevColor(r.w)}" aria-current="${r.s === S.slug}">
      <span class="bar"></span><span class="srow-body"><span class="q">${esc(r.q || "（无提问）")}</span>
      <span class="m num"><span class="srow-model">${esc(label(r.m))}</span><span>${rowDate(r, f).slice(5)}</span>${r.tr > 1 ? `<span>${r.tr} 轮</span>` : ""}<span class="srow-sev" style="color:${r.w === "none" ? "var(--muted)" : sevColor(r.w)}">${r.w === "none" ? "无问题" : r.w}</span>${
            isLostRow(r) ? '<span class="tag-lost">流失</span>' : ""
          }</span></span></button>`,
        )
        .join("")
    : `<div class="empty">没有符合条件的会话<br><button type="button" class="link" id="sclear">清除筛选</button></div>`;
  renderPager(pages);
  const clear = $("#sclear", root);
  clear && clear.addEventListener("click", () => setFilter({ q: "", w: "", split: "", model: "", ut: "", date: "", scene: "", sub: "", stage: "", mech: "", pattern: "" }));
}

function renderPager(pages) {
  const el = $("#spager", root);
  if (!el) return;
  el.hidden = S.rows.length <= PAGE;
  if (el.hidden) {
    el.innerHTML = "";
    return;
  }
  const btn = (key, label, off) => `<button type="button" data-page="${key}"${off ? " disabled" : ""}>${label}</button>`;
  // The total count already sits in the list meta above; repeating it here pushed the last
  // button past the 300px pane, so the pager only carries the page it is on.
  el.innerHTML = `${btn("first", "«", S.page === 1)}${btn("prev", "上一页", S.page === 1)}
    <span class="pager-info">第 <b class="num">${S.page}</b> / ${pages} 页</span>
    ${btn("next", "下一页", S.page === pages)}${btn("last", "»", S.page === pages)}`;
}

function markCurrent() {
  $$(".srow", root).forEach((b) => b.setAttribute("aria-current", String(b.dataset.s === S.slug)));
  const cur = $$(".srow", root).find((b) => b.dataset.s === S.slug);
  if (cur) {
    const list = $("#slist", root);
    const r = cur.getBoundingClientRect();
    const lr = list.getBoundingClientRect();
    if (r.top < lr.top || r.bottom > lr.bottom) cur.scrollIntoView({ block: "nearest" });
    if (S.refocusList) { S.refocusList = false; cur.focus({ preventScroll: true }); }
  }
}

