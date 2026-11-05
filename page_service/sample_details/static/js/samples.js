/* 具体数据: recall list → chat transcript → attribution / compact, with evidence → message links. */
import { $, $$, esc, fmt, compact, SEV, WORST, SEV_NAME, sevColor, KIND, getJSON, bindTips, REDUCED } from "./core.js";
import { renderContent, segment } from "./render.js";
import { threadFlow } from "./particles.js";

const FOLD_OPEN = new Set(["user", "answer"]);
const PAGE = 50;
const S = { product: null, all: [], rows: [], pageRows: [], page: 1, slug: null, sessionKey: null, D: null, round: 0, trace: 0, turn: 0, cturn: 0, sessionView: false, open: new Set(), active: null, cache: new Map() };
let ctx;
let root;

const params = () => new URLSearchParams(location.search);
const F = () => {
  const q = params();
  return {
    q: q.get("q") || "", w: q.get("w") || "", split: q.get("split") || "", model: q.get("model") || "",
    scene: q.get("scene") || "", sub: q.get("sub") || "", stage: q.get("stage") || "", mech: q.get("mech") || "", pattern: q.get("pattern") || "", sort: q.get("sort") || "sev",
  };
};
const dirty = () => Object.entries(F()).some(([k, v]) => k !== "sort" && v);
// `sc` is the scene the matrix filed the sample under when it differs from task / skill (问财 B versions).
const sceneOf = (r) => r.sc || r.task || r.skill || "未标注";
const subOf = (r) => r.sub || "";
const problemHit = (r, f) =>
  (!f.stage || r.st.includes(f.stage)) &&
  (!f.mech || r.pt.some((x) => x.split(".")[1] === f.mech && (!f.stage || x.startsWith(`${f.stage}.`)))) &&
  (!f.pattern || r.pt.some((x) => x === f.pattern || x.startsWith(f.pattern + ".")));

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
        w: "none", n: 0, tr: 0, pt: new Set(), st: new Set(), tg: new Set(), lb: new Set(),
        q: "", d: "", tid: "", case: "", task: "", sub: "", skill: "", sc: "", lang: r.lang,
      };
      groups.set(key, g);
    }
    g.rows.push(r);
    g.n += r.n || 0;
    g.tr += r.tr || 1;
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
  });
  return [...groups.values()].map((g) => {
    const rowsByDate = g.rows.slice().sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));
    const last = rowsByDate[rowsByDate.length - 1];
    return {
      ...last, key: g.key, s: g.key, rows: g.rows,
      q: last.q, d: last.d, w: g.w, n: g.n, tr: g.tr,
      pt: [...g.pt], st: [...g.st], tg: [...g.tg], lb: [...g.lb].join("｜"),
      tid: g.tid, case: g.case, task: g.task, sub: g.sub, skill: g.skill, sc: g.sc,
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
  }
  if (S.product !== c.product || !$(".bench", root)) {
    S.product = c.product;
    S.all = prod ? groupSessions(prod.rows) : [];
    S.prod = prod;
    S.slug = null;
    S.sessionKey = null;
    S.D = null;
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
  S.traceMiss = null;
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
  if (key !== S.sessionKey || !S.D) await loadSession(session, focusSlug, focusTrace);
  else if (focusSlug) selectSlugRound(focusSlug);
  else if (focusTrace) selectTraceRound(focusTrace);
  markCurrent();
  const p = params().get("p");
  if (p != null && S.D) {
    let pid = Number(p);
    if (focusSlug) {
      const at = S.D.attribution.problems.findIndex((x) => x.origin?.slug === focusSlug && x.origin?.id === Number(p));
      if (at >= 0) pid = at;
    }
    requestAnimationFrame(() => flash($(`#pc-${pid}`, root)));
  } else if (S.D) {
    const sev = params().get("w");
    const card = sev && $(`#sattr .pcard[data-sev="${sev}"]`, root);
    if (card) requestAnimationFrame(() => flash(card));
  }
  return { trace: focusTrace || null, traceMiss: S.traceMiss };
}

/* ---------------------------------------------------------------- skeleton & filters */
function skeleton() {
  root.innerHTML = `<div class="bench">
    <aside class="pane pane-sticky" aria-label="样本列表">
      <div class="pane-head">
        <input class="search" id="sq" type="search" placeholder="搜索问题 · Session ID · Trace ID" autocomplete="off">
        <div class="filters" id="sf"></div>
        <div class="list-meta"><span id="scount" class="num"></span>
          <span class="meta-end">
            <button type="button" class="reset" id="sreset" hidden>重置</button>
            <select id="ssort" aria-label="排序"><option value="sev">严重度优先</option><option value="n">问题数</option><option value="date">日期新→旧</option></select>
          </span></div>
      </div>
      <div class="pane-scroll" id="slist" tabindex="0" aria-label="样本"></div>
      <div class="pager" id="spager" hidden></div>
    </aside>
    <section class="pane pane-out pane-sticky" aria-label="数据详情">
      <div class="pane-scroll" id="sbody">
        <div id="shead"></div>
        <div class="anatomy" id="sanatomy">
          <div class="traj" id="sout"></div>
          <div class="timeline" id="stl"></div>
          <div class="threads"><svg aria-hidden="true"></svg></div>
          <div class="aprobs" id="sattr"></div>
        </div>
      </div>
    </section>
  </div>`;
  wireThreads();
  let timer;
  $("#sq", root).addEventListener("input", (e) => {
    clearTimeout(timer);
    timer = setTimeout(() => setFilter({ q: e.target.value.trim() }), 140);
  });
  $("#ssort", root).addEventListener("change", (e) => setFilter({ sort: e.target.value }));
  $("#sreset", root).addEventListener("click", () =>
    setFilter({ q: "", w: "", split: "", model: "", scene: "", sub: "", stage: "", mech: "", pattern: "", sort: "sev" }),
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
    if (next) ctx.navigate({ case: next.s, p: null }, { replace: true }) || render(root, ctx);
  });
  $("#sbody", root).addEventListener("click", onInputClick);
  $("#shead", root).addEventListener("click", onOutClick);
  $("#sout", root).addEventListener("click", onOutClick);
  $("#sattr", root).addEventListener("click", onOutClick);
  wireCmapPan($("#shead", root));
  bindTips($("#shead", root), (t) => {
    if ((!t.closest(".cmap") && !t.closest(".sp")) || !t.dataset.tip) return null;
    const i = t.dataset.tip.indexOf("|");
    return `<div style="font-weight:var(--w-medium);margin-bottom:4px">${esc(t.dataset.tip.slice(0, i))}</div><div style="max-width:300px;white-space:normal;line-height:1.6">${esc(t.dataset.tip.slice(i + 1))}</div>`;
  });
}

function wireCmapPan(host) {
  let drag = null;
  let suppress = false;
  host.addEventListener("pointerdown", (e) => {
    if (e.pointerType !== "mouse" || e.button !== 0) return;
    const c = e.target.closest(".cmap");
    if (!c || c.scrollWidth <= c.clientWidth + 1) return;
    drag = { c, x: e.clientX, left: c.scrollLeft, moved: false, id: e.pointerId };
    c.setPointerCapture(e.pointerId);
    c.classList.add("is-dragging");
  });
  host.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x;
    if (Math.abs(dx) > 3) drag.moved = true;
    drag.c.scrollLeft = drag.left - dx;
  });
  const end = () => {
    if (!drag) return;
    const d = drag;
    drag = null;
    d.c.classList.remove("is-dragging");
    try { d.c.releasePointerCapture(d.id); } catch (e) {}
    if (d.moved) {
      suppress = true;
      setTimeout(() => { suppress = false; }, 0);
    }
  };
  host.addEventListener("pointerup", end);
  host.addEventListener("pointercancel", end);
  host.addEventListener("click", (e) => {
    if (!suppress) return;
    e.stopPropagation();
    e.preventDefault();
  }, true);
}

function markCmapScroll() {
  $$(".cmap", root).forEach((c) => {
    const overflow = c.scrollWidth > c.clientWidth + 1;
    c.classList.toggle("is-scrollable", overflow);
    c.title = overflow ? "拖动查看完整链路" : "";
    let label = c.querySelector(":scope > .cmap-k");
    if (overflow && !label) {
      label = document.createElement("div");
      label.className = "cmap-k";
      label.textContent = "链路概览";
      c.prepend(label);
    } else if (!overflow && label) {
      label.remove();
    }
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
  let html = row("sev", WORST.map((w, i) => btn("w", w, SEV_NAME[w], sevColor(i))).join(""));
  if (p.splits.some((s) => s.id === "lost")) html += row("", btn("split", "lost", "仅看流失用户"));
  html += row("", p.models.map((m) => btn("model", m.id, m.label)).join(""));

  const tax = ctx.data.taxonomy;
  if (tax) {
    const byNum = (a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1));
    const scenePool = S.all.filter((r) => (!f.scene || sceneOf(r) === f.scene) && (!f.sub || subOf(r) === f.sub));
    const scenes = [...new Set([...S.all.filter((r) => problemHit(r, f) && (!f.sub || subOf(r) === f.sub)).map(sceneOf), f.scene].filter(Boolean))]
      .sort((a, b) => a.localeCompare(b, "zh"));
    const subs = [...new Set([...S.all.filter((r) => problemHit(r, f) && (!f.scene || sceneOf(r) === f.scene)).map(subOf), f.sub].filter(Boolean))]
      .sort((a, b) => a.localeCompare(b, "zh"));
    const stages = tax.stages.filter((s) => scenePool.some((r) => r.st.includes(s.id))).sort(byNum);
    const mechs = tax.mechanisms
      .filter((m) => scenePool.some((r) => r.pt.some((x) => x.split(".")[1] === m.id && (!f.stage || x.startsWith(`${f.stage}.`)))))
      .sort(byNum);
    const pats = Object.keys(tax.patterns)
      .filter((id) => {
        const [s, m] = id.split(".");
        return (!f.stage || s === f.stage) && (!f.mech || m === f.mech) && scenePool.some((r) => r.pt.includes(id));
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
      (!f.w || r.w === f.w) && (!f.split || r.sp === f.split) && (!f.model || r.m === f.model) &&
      (!f.scene || sceneOf(r) === f.scene) &&
      (!f.sub || subOf(r) === f.sub) &&
      problemHit(r, f) &&
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
      <span class="m num"><span class="srow-model">${esc(label(r.m))}</span><span>${r.d.slice(5)}</span>${r.tr > 1 ? `<span>${r.tr} 轮</span>` : ""}<span class="srow-sev" style="color:${r.w === "none" ? "var(--muted)" : sevColor(r.w)}">${r.n ? `${r.w} · ${r.n}` : "无问题"}</span>${
            r.sp === "lost" ? '<span class="tag-lost">流失</span>' : ""
          }</span></span></button>`,
        )
        .join("")
    : `<div class="empty">没有符合条件的会话<br><button type="button" class="link" id="sclear">清除筛选</button></div>`;
  renderPager(pages);
  const clear = $("#sclear", root);
  clear && clear.addEventListener("click", () => setFilter({ q: "", w: "", split: "", model: "", scene: "", sub: "", stage: "", mech: "", pattern: "" }));
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
  }
}

/* ---------------------------------------------------------------- detail */
const clone = (value) => JSON.parse(JSON.stringify(value));
const traceSet = (d) => new Set((d.attribution?.turns || []).map((t) => t.trace_id).filter(Boolean));
const roundCount = (d) => Math.max(d.input?.traces?.length || 0, d.attribution?.turns?.length || 0, d.compact?.turns?.length || 0, 1);

async function fetchDetail(slug) {
  let D = S.cache.get(slug);
  if (!D) {
    D = await getJSON(`samples/${slug}.json`);
    S.cache.set(slug, D);
    if (S.cache.size > 32) S.cache.delete(S.cache.keys().next().value);
  }
  return D;
}

/* If a full-session detail and a per-trace detail overlap, keep the one that contains
   the other's trace ids. Disjoint per-trace evaluations are all kept. */
function dropSubsetParts(parts) {
  const meta = parts.map((part) => ({ part, ids: traceSet(part.detail) }));
  return meta
    .filter((a, i) =>
      !meta.some((b, j) => {
        if (i === j || !a.ids.size || !b.ids.size) return false;
        if (![...a.ids].every((id) => b.ids.has(id))) return false;
        if (b.ids.size > a.ids.size) return true;
        if (b.ids.size === a.ids.size) {
          if (b.part.detail.evidence.length > a.part.detail.evidence.length) return true;
          if (b.part.detail.evidence.length === a.part.detail.evidence.length && j < i) return true;
        }
        return false;
      }),
    )
    .map((x) => x.part);
}

function withRounds(part) {
  const d = part.detail;
  const n = roundCount(d);
  const lastTrace = Math.max(0, (d.input?.traces?.length || 1) - 1);
  d.rounds = Array.from({ length: n }, (_, i) => ({
    slug: part.slug,
    trace: Math.min(i, lastTrace),
    turn: i,
    compact: i,
    tid: d.attribution?.turns?.[i]?.trace_id || "",
  }));
  return d;
}

function mergeSessionDetails(parts, session) {
  const D = {
    session: true,
    product: S.product,
    split: session.sp,
    model: session.m,
    date: session.d,
    question: session.q,
    question_zh: parts[0].detail.question_zh,
    lang: parts[0].detail.lang,
    ids: { session: session.sid, trace: "", case: session.case },
    meta: { ...(parts[parts.length - 1].detail.meta || {}) },
    input: { traces: [], missing: false },
    attribution: { summary: "", turns: [], problems: [], session_problems: [] },
    compact: { overview: [], turns: [] },
    evidence: [],
    rounds: [],
  };
  for (const part of parts) {
    const d = part.detail;
    const traces = d.input?.traces || [];
    const turns = d.attribution?.turns || [];
    const compacts = d.compact?.turns || [];
    const baseEv = D.evidence.length;
    const baseProb = D.attribution.problems.length;
    const startTrace = D.input.traces.length;
    const n = Math.max(traces.length, turns.length, compacts.length);
    for (let i = 0; i < n; i++) {
      const round = D.rounds.length;
      const trace = traces[i] ? clone(traces[i]) : { messages: [] };
      (trace.messages || []).forEach((m) => {
        if (m.ev) m.ev = m.ev.map((id) => id + baseEv);
      });
      D.input.traces.push(trace);

      const turn = turns[i];
      if (turn) {
        const copy = clone(turn);
        copy.problems = (copy.problems || []).map((id) => id + baseProb);
        D.attribution.turns.push(copy);
      }

      const compactTurn = compacts[i];
      if (compactTurn) {
        const copy = clone(compactTurn);
        ["plans", "reasoning", "execution", "reflections", "tool_errors", "key_data", "artifacts"].forEach((key) => {
          (copy[key] || []).forEach((step) => {
            if (step.ev) step.ev = step.ev.map((id) => id + baseEv);
          });
        });
        (copy.components || []).forEach((step) => {
          if (step.ev) step.ev = step.ev.map((id) => id + baseEv);
        });
        copy.turn = round;
        D.compact.turns.push(copy);
      }

      D.rounds.push({
        slug: part.slug, trace: startTrace + i,
        turn: D.attribution.turns.length - 1,
        compact: D.compact.turns.length - 1,
        tid: turn?.trace_id || "",
      });
    }

    (d.attribution?.problems || []).forEach((problem, localId) => {
      const copy = clone(problem);
      copy.origin = { slug: part.slug, id: problem.id ?? localId };
      copy.id = D.attribution.problems.length;
      copy.ev = (copy.ev || []).map((id) => id + baseEv);
      D.attribution.problems.push(copy);
    });
    (d.evidence || []).forEach((ev) => {
      const copy = clone(ev);
      if (typeof copy.t === "number") copy.t += startTrace;
      D.evidence.push(copy);
    });
    (d.attribution?.session_problems || []).forEach((id) => D.attribution.session_problems.push(id + baseProb));
    (d.compact?.overview || []).forEach((line) => {
      if (!D.compact.overview.includes(line)) D.compact.overview.push(line);
    });
    if (!D.attribution.summary && d.attribution?.summary) D.attribution.summary = d.attribution.summary;
  }
  D.attribution.problems.forEach((p, i) => { p.id = i; });
  const firstTurn = D.attribution.turns.find((t) => t.trace_id);
  D.ids.trace = firstTurn?.trace_id || parts[0].detail.ids?.trace || "";
  return D;
}

async function loadSession(session, focusSlug, focusTrace) {
  S.slug = session.key;
  S.sessionKey = session.key;
  S.session = session;
  $("#shead", root).innerHTML = `<div class="empty">正在读取会话…</div>`;
  $("#stl", root).innerHTML = "";
  $("#sout", root).innerHTML = "";
  $("#sattr", root).innerHTML = "";
  scheduleThreads();
  let parts;
  try {
    parts = await Promise.all(session.rows.map(async (row) => ({ slug: row.s, detail: await fetchDetail(row.s) })));
  } catch (e) {
    $("#shead", root).innerHTML = `<div class="empty">会话详情读取失败（${esc(e.message)}）。运行 local_dev/refresh.sh 重新生成。</div>`;
    $("#stl", root).innerHTML = "";
    $("#sout", root).innerHTML = "";
    $("#sattr", root).innerHTML = "";
    scheduleThreads();
    return;
  }
  parts.sort((a, b) => String(a.detail.meta?.request_time || a.detail.date || "").localeCompare(String(b.detail.meta?.request_time || b.detail.date || "")));
  const kept = dropSubsetParts(parts);
  const D = kept.length === 1 ? withRounds(kept[0]) : mergeSessionDetails(kept, session);
  index(D);
  S.D = D;
  S.round = D.rounds.length - 1;
  S.sessionView = false;
  // A single part's rounds share the same slug, so a case deep link must not
  // pin the first round; only merged parts have round-specific slugs.
  if (focusSlug && kept.length > 1) {
    const at = D.rounds.findIndex((r) => r.slug === focusSlug);
    if (at >= 0) S.round = at;
  } else {
    // 从「P0」这类严重度筛选里点进样本时，落在有该等级问题的那一轮：
    // 用户想看的是自己点的那类问题，而不是整段会话最后一轮碰巧出现的问题。
    const sev = params().get("w");
    const at = sev ? roundWithSev(D, sev) : -1;
    if (at >= 0) S.round = at;
  }
  S.traceMiss = null;
  if (focusTrace) {
    const at = D.rounds.findIndex((r) => r.tid === focusTrace);
    if (at >= 0) S.round = at;
    else S.traceMiss = focusTrace;
  }
  const init = D.rounds[S.round];
  S.trace = init?.trace ?? 0;
  S.turn = init?.turn ?? S.round;
  S.cturn = init?.compact ?? S.round;
  S.open = new Set();
  S.active = null;
  renderIn();
  renderOut();
}

/* 某一严重度的问题落在第几轮：取第一条该等级问题的轮次，找不到返回 -1。 */
function roundWithSev(D, sev) {
  const turns = D.attribution?.turns || [];
  const problems = D.attribution?.problems || [];
  const hit = (turn) => (turn?.problems || []).some((idx) => problems[idx]?.sev === sev);
  const turnAt = turns.findIndex(hit);
  if (turnAt < 0) return -1;
  const at = (D.rounds || []).findIndex((r) => (r.turn ?? -1) === turnAt);
  return at >= 0 ? at : Math.min(turnAt, (D.rounds || []).length - 1);
}

function scrollRound(i) {
  const el = $(`#round-${i}`, root);
  if (!el) return;
  el.scrollIntoView({ block: "nearest", behavior: REDUCED ? "auto" : "smooth" });
  flash(el);
}

function selectRound(i, { scroll = true } = {}) {
  const D = S.D;
  if (!D) return;
  if (i === "session") {
    S.sessionView = true;
    renderTrace();
    renderOut();
    return;
  }
  S.sessionView = false;
  const n = D.rounds?.length || 1;
  const round = Math.max(0, Math.min(n - 1, Number(i) || 0));
  const r = D.rounds?.[round];
  S.round = round;
  S.trace = r?.trace ?? round;
  S.turn = r?.turn ?? round;
  S.cturn = r?.compact ?? round;
  renderTrace();
  renderOut();
  if (scroll) scrollRound(round);
}

function selectTraceRound(trace) {
  const at = (S.D?.rounds || []).findIndex((r) => r.tid && r.tid === trace);
  if (at >= 0) selectRound(at, { scroll: false });
  return at;
}

function selectSlugRound(slug) {
  const rounds = S.D?.rounds || [];
  const hits = rounds.filter((r) => r.slug === slug);
  if (hits.length === 1) selectRound(rounds.indexOf(hits[0]), { scroll: false });
}

function index(D) {
  if (D._ix) return;
  const byBlock = new Map();
  const sev = new Map();
  const owner = new Map();
  D.attribution.problems.forEach((p) => p.ev.forEach((e) => { sev.set(e, p.sev); owner.set(e, p.id); }));
  D.evidence.forEach((ev, i) => {
    if (ev.b == null) return;
    const k = `${ev.t}:${ev.m}:${ev.b}`;
    (byBlock.get(k) || byBlock.set(k, []).get(k)).push(i);
  });
  D._ix = { byBlock, sev, owner };
}

function summaryInner(D) {
  const turns = D.attribution.turns || [];
  const turn = turns[Math.max(0, Math.min(S.turn, turns.length - 1))];
  const text = S.sessionView ? D.attribution.summary : (turn?.summary || "");
  return `<div class="sum-box"><span class="sp-k">${S.sessionView ? "Session 点评" : "Trace 点评"}</span>${
    text ? `<p class="summary">${esc(text)}</p>` : `<p class="summary faint">暂无点评</p>`
  }</div>`;
}

function renderSummary() {
  const box = $("#sumBox", root);
  if (box && S.D) box.innerHTML = summaryInner(S.D);
}

function overviewItems(D) {
  const C = D.compact;
  if (!C?.turns?.length) return [];
  const t = C.turns[Math.max(0, Math.min(S.cturn || 0, C.turns.length - 1))];
  const comps = (t.components || []).filter((c) => c.kind === "model" && c.c).map((c) => c.c);
  if (comps.length) return comps;
  const answer = (t.components || []).find((c) => /答案|answer|合成|final/i.test(c.name || ""));
  return [...(t.plans || []).slice(0, 2).map((x) => x.c), answer?.c].filter(Boolean);
}

function renderOverviewItems() {
  const box = $("#ovBox", root);
  if (!box || !S.D) return;
  const items = overviewItems(S.D);
  box.innerHTML = items.length
    ? `<span class="sp-k">Overview</span><div class="ov-list">${items
        .map((x, i) => `<div class="ov-item" title="${esc(x)}"><p><span class="ov-n" aria-hidden="true">${String(i + 1).padStart(2, "0")}</span><span class="ov-t">${esc(x)}</span></p></div>`)
        .join("")}</div>`
    : "";
}

function renderIn() {
  const D = S.D;
  $("#sanatomy", root)?.classList.remove("is-session");
  $("#shead", root)?.classList.remove("is-session");
  const m = D.meta || {};
  const label = (S.prod.models.find((x) => x.id === D.model) || { label: D.model }).label;
  const scene = [m.task, m.subtask, m.difficulty, m.skill, m.mode].filter(Boolean);
  const scale = [m.tokens_in ? `${compact((m.tokens_in || 0) + (m.tokens_out || 0))} tokens` : null,
    m.finish_ms ? `${fmt(m.finish_ms / 1000, 1)} s` : null].filter(Boolean);
  const ids = [["会话 ID", D.ids.session], ["Trace ID", D.ids.trace], ["Case ID", D.ids.case]].filter((x) => x[1]);
  const rounds = D.rounds || [];
  const group = (k, cls, vals) =>
    vals.length
      ? `<span class="cg${cls ? ` ${cls}` : ""}"><span class="cg-k">${k}</span>${vals.map((v) => `<span class="pill">${esc(v)}</span>`).join("")}</span>`
      : "";
  const fullQ = D.question || "（无提问）";
  const shortQ = fullQ.length > 80 ? `${fullQ.slice(0, 80)}…` : fullQ;
  const idline = `<div class="idline">${ids.map(([k, v]) => `<button type="button" class="copy" data-copy="${esc(v)}">${k} <span class="num">${esc(v.length > 18 ? `${v.slice(0, 8)}…${v.slice(-6)}` : v)}</span></button>`).join("")}</div>`;
  $("#shead", root).innerHTML = `<div class="sample-head">
      <div class="headline">
        <h2 title="${esc(fullQ)}">${esc(shortQ)}</h2>
        ${idline}
      </div>
      <div class="chip-groups">
        ${D.split === "lost" ? `<span class="cg"><span class="pill lost">流失用户</span></span>` : ""}
        ${group("模型", "is-model", [label])}
        ${group("日期", "is-plain", [D.date])}
        ${group("场景", "is-scene", scene)}
        ${group("规模", "is-scale", scale)}
      </div>
      ${rounds.length || D.attribution.summary || D.attribution.session_problems?.length ? `<div class="trace-tabs" id="ttabs">${rounds.map((r, i) => {
        const t = D.input.traces[r.trace];
        return `<button type="button" class="pill" data-t="${i}" aria-pressed="${!S.sessionView && i === S.round}"${t?.agent ? ` title="${esc(t.agent)}"` : ""}>第 ${i + 1} 轮</button>`;
      }).join("")}<button type="button" class="pill" data-t="session" aria-pressed="${S.sessionView}">session 总评</button></div>` : ""}
      <div id="ovBox" class="ov-box"></div>
      <div id="sumBox">${summaryInner(D)}</div>
      <div id="ov" class="ov-grid"></div>
    </div>`;
  if (D.input.missing) {
    $("#stl", root).innerHTML = `<div class="empty">这一组没有找到对应的评测输入。</div>`;
    $("#ov", root).innerHTML = "";
    scheduleThreads();
    return;
  }
  renderTrace();
}

function renderTrace() {
  renderSummary();
  const D = S.D;
  const session = S.sessionView;
  renderOverviewItems();
  $("#sanatomy", root)?.classList.toggle("is-session", session);
  $("#shead", root)?.classList.toggle("is-session", session);
  $$("#ttabs .pill", root).forEach((b) => {
    const tab = b.dataset.t === "session";
    b.setAttribute("aria-pressed", String(tab ? session : (!session && Number(b.dataset.t) === S.round)));
  });
  if (session) {
    $("#sout", root).innerHTML = "";
    $("#stl", root).innerHTML = qaHTML(D);
    scheduleThreads();
    return;
  }
  const tr = D.input.traces[S.trace];
  if (!tr) return;
  renderOverview();
  $("#stl", root).innerHTML = timelineHTML(S.trace, tr.messages || []) || `<div class="empty">该轮没有消息</div>`;
  scheduleThreads();
}

/* 用户与回答之间的那一串思考 / 调用 / 返回（中间链路）单独收进一个固定高度的盒子：
   一条 trace 动辄上百步，平铺会把整页拉成上万像素，回答被顶到屏幕外。
   链路在自己的盒子里滚，用户问句和最终回答始终留在盒子的上下。 */
const CHAIN_KINDS = new Set(["user", "answer"]);

function timelineHTML(t, messages) {
  const out = [];
  let run = [];
  const flush = () => {
    if (!run.length) return;
    out.push(`<div class="chain-box">
      <div class="chain-head"><span class="chain-k">中间链路</span><span class="num faint">${run.length} 步</span></div>
      <div class="chain-body">${run.map((i) => msgHTML(t, i, messages[i])).join("")}</div>
    </div>`);
    run = [];
  };
  messages.forEach((m, i) => {
    if (CHAIN_KINDS.has(m.k)) {
      flush();
      out.push(msgHTML(t, i, m));
    } else {
      run.push(i);
    }
  });
  flush();
  return out.join("");
}

/* Session 总评: only the chat turns, so the page reads Q → A → Q → A instead of
   the full tool/LLM trace. */
function qaHTML(D) {
  const rows = [];
  (D.input.traces || []).forEach((tr, t) => {
    (tr.messages || []).forEach((m, i) => {
      if (m.k === "user" || m.k === "answer") rows.push(msgHTML(t, i, m));
    });
  });
  return rows.join("") || `<div class="empty">这一组没有 QA 消息</div>`;
}

/* Chat scene: the user speaks on the right, the answer answers on the left,
   everything the agent did in between is a compact step row. */
function msgHTML(t, i, m) {
  const D = S.D;
  const key = `${t}:${i}`;
  const chat = m.k === "user" || m.k === "answer";
  const folded = !FOLD_OPEN.has(m.k) && !S.open.has(key);
  const sevs = [...new Set((m.ev || []).map((e) => D._ix.sev.get(e)).filter(Boolean))].sort();
  const time = m.dur != null ? `<span class="num">${m.dur >= 1000 ? fmt(m.dur / 1000, 1) + " s" : m.dur + " ms"}</span>` : "";
  const who = KIND[m.k] || m.k;
  const firstUser = t === 0 ? S.D.input.traces[0].messages.findIndex((x) => x.k === "user") : -1;
  const trans = t === 0 && i === firstUser && S.D.question_zh && S.D.question_zh !== S.D.question ? S.D.question_zh : "";
  const body = blockHTML(t, i, m);
  const hasBody = body || trans;
  return `<div class="msg k-${m.k}${chat ? " is-chat" : ""}${folded ? " is-folded" : ""}" id="m-${t}-${i}" data-key="${key}">
    ${chat ? "" : '<span class="msg-dot" aria-hidden="true"></span>'}
    <div class="msg-body"><div class="msg-top"><span class="who">${who}</span><span class="num faint">#${i}</span>
      ${m.name ? `<span class="mname">${esc(m.name)}</span>` : ""}${m.model ? `<span class="faint">${esc(m.model)}</span>` : ""}${time}
      <span class="evs">${sevs.map((s) => `<i style="--c:${sevColor(s)}" title="${s} 证据"></i>`).join("")}</span>
      ${FOLD_OPEN.has(m.k) || !hasBody ? "" : `<button type="button" class="toggle" data-fold="${key}">${folded ? "展开" : "收起"}</button>`}</div>
      ${body}${trans ? `<div class="msg-zh">${esc(trans)}</div>` : ""}</div></div>`;
}

function blockHTML(t, mi, m) {
  const blocks = m.blocks
    .map((b, bi) => ({ b, bi }))
    .filter(({ b }) => {
      const text = b.x.map((x) => (typeof x === "string" ? x : "")).join("").trim();
      const bare = text.replace(/^```(?:json)?\s*/i, "").replace(/```$/, "").trim();
      return bare && !["[]", "{}", "null"].includes(bare);
    });
  if (!blocks.length) return "";
  return blocks
    .map(({ b, bi }) => {
      const lab = b.l === "think" ? "思考" : b.l && b.l.startsWith("call:") ? `→ ${b.l.slice(5)}` : "";
      const body = pieceHTML(t, mi, bi, b, m.k === "answer");
      return `${lab ? `<span class="blk-label">${esc(lab)}</span>` : ""}<div class="blk${b.f === "json" ? " is-json" : ""}">${body}</div>`;
    })
    .join("");
}

function markHTML(cover, body) {
  const cx = cover.find((k) => k.src === "compact");
  if (cx) return `<mark class="cx" data-e="${cx.e[0]}">${body}</mark>`;
  const attr = cover.filter((k) => k.src === "attr");
  const e = attr.flatMap((k) => k.e);
  return `<mark class="ev" data-e="${e.join(" ")}" style="--c:${sevColor(S.D._ix.sev.get(e[0]))}">${body}</mark>`;
}

function pieceHTML(t, mi, bi, b, plain = false) {
  const D = S.D;
  const gaps = b.x.some((x) => typeof x !== "string");
  // The final answer is prose we want to read: give Markdown precedence over
  // per-character evidence highlighting, which would otherwise leave raw
  // tables/lists on screen. Evidence dots stay in the message header.
  if (plain && !gaps) return renderContent(b.x.join(""), b.f);
  const ids = (D._ix.byBlock.get(`${t}:${mi}:${bi}`) || []).filter((e) => D.evidence[e].src === "attr" || e === S.active);
  const marks = ids
    .filter((e) => D.evidence[e].o)
    .map((e) => ({ e: [e], src: D.evidence[e].src, s: D.evidence[e].o[0], z: D.evidence[e].o[1] }));

  if (!marks.length && !gaps) return renderContent(b.x.join(""), b.f);
  if (!marks.length) {
    let pos = 0;
    return b.x
      .map((x) => {
        if (typeof x !== "string") {
          pos += x.g;
          return `<span class="gap">··· 省略 ${fmt(x.g)} 字 ···</span>`;
        }
        pos += x.length;
        return `<span class="piece">${esc(x)}</span>`;
      })
      .join("");
  }
  // Marks demand the original characters, so formatting stays inline-only.
  let pos = 0;
  return b.x
    .map((x) => {
      if (typeof x !== "string") {
        pos += x.g;
        return `<span class="gap">··· 省略 ${fmt(x.g)} 字 ···</span>`;
      }
      const local = marks
        .filter((k) => k.s < pos + x.length && k.z > pos)
        .map((k) => ({ s: Math.max(0, k.s - pos), z: Math.min(x.length, k.z - pos), e: k.e, src: k.src }));
      pos += x.length;
      return segment(x, local, markHTML, "inline");
    })
    .join("");
}

function rerenderMsg(t, i) {
  const el = $(`#m-${t}-${i}`, root);
  if (el) el.outerHTML = msgHTML(t, i, S.D.input.traces[t].messages[i]);
  // 中间链路盒子高度封顶后，展开/收起某一步不会改变盒子高度（也就不会触发 ResizeObserver），
  // 里面步骤的位置变了，连线得手动重画一次。
  scheduleThreads();
}

async function copyText(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (e) {}
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "0";
    ta.style.left = "-9999px";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch (e) {
    return false;
  }
}

function onInputClick(e) {
  const fold = e.target.closest("[data-fold]");
  if (fold) {
    const [t, i] = fold.dataset.fold.split(":").map(Number);
    S.open.has(fold.dataset.fold) ? S.open.delete(fold.dataset.fold) : S.open.add(fold.dataset.fold);
    rerenderMsg(t, i);
    return;
  }
  const tab = e.target.closest("#ttabs [data-t]");
  if (tab) {
    selectRound(tab.dataset.t === "session" ? "session" : Number(tab.dataset.t));
    if (params().get("trace")) ctx.navigate({ trace: null }, { replace: true });
    return;
  }
  const copy = e.target.closest("[data-copy]");
  if (copy) {
    const old = copy.textContent;
    copyText(copy.dataset.copy).then((ok) => {
      copy.textContent = ok ? "已复制" : "复制失败";
      copy.classList.add("done");
      setTimeout(() => {
        copy.textContent = old;
        copy.classList.remove("done");
      }, 1200);
    });
    return;
  }
  const mark = e.target.closest("mark.ev");
  if (mark) {
    const p = S.D._ix.owner.get(Number(mark.dataset.e.split(" ")[0]));
    flash($(`#pc-${p}`, root), true);
  }
}

function jump(eid) {
  const ev = S.D.evidence[eid];
  if (!ev || ev.m == null) return;
  const wasSession = S.sessionView;
  S.sessionView = false;
  if (ev.t !== S.trace) {
    const at = S.D.rounds?.findIndex((r) => r.trace === ev.t) ?? -1;
    const rr = at >= 0 ? S.D.rounds[at] : null;
    S.trace = ev.t;
    if (rr) {
      S.round = at;
      S.turn = rr.turn;
      S.cturn = rr.compact;
    }
    renderTrace();
    renderOut();
  } else if (wasSession) {
    renderTrace();
    renderOut();
  }
  const prev = S.active;
  S.active = ev.src === "compact" ? eid : null;
  if (prev != null && S.D.evidence[prev]) rerenderMsg(S.D.evidence[prev].t, S.D.evidence[prev].m);
  S.open.add(`${ev.t}:${ev.m}`);
  rerenderMsg(ev.t, ev.m);
  const el = $(`#m-${ev.t}-${ev.m}`, root);
  $$("mark.on", root).forEach((m) => m.classList.remove("on"));
  $$(`mark[data-e~="${eid}"]`, el).forEach((m) => m.classList.add("on"));
  const target = $(`mark[data-e~="${eid}"]`, el) || el;
  target.scrollIntoView({ block: "center", behavior: REDUCED ? "auto" : "smooth" });
  flash(el);
}

function flash(el, scroll) {
  if (!el) return;
  if (scroll) el.scrollIntoView({ block: "nearest", behavior: REDUCED ? "auto" : "smooth" });
  el.classList.remove("flash");
  void el.offsetWidth;
  el.classList.add("flash");
}

/* ---------------------------------------------------------------- evidence threads */
let threadFrame = 0;
let threadTimers = [];
let threadObs = null;

function wireThreads() {
  const box = $("#sanatomy", root);
  if (!box) return;
  const focus = (pid) => {
    const svg = $(".threads svg", box);
    if (!svg) return;
    const prob = pid == null || !S.D ? null : S.D.attribution.problems.find((p) => p.id === pid);
    // 证据按「轮次:消息」定位，session 总评里同一张卡可能落在多轮上。
    const msgs = new Set(prob ? prob.ev.map((e) => S.D.evidence[e]).filter((ev) => ev && ev.m != null).map((ev) => `${ev.t}:${ev.m}`) : []);
    box.classList.toggle("is-focus", !!prob);
    $$(".msg", box).forEach((m) => m.classList.toggle("on", msgs.has(m.dataset.key)));
    $$("path", svg).forEach((p) => p.classList.toggle("on", p.dataset.p === String(pid)));
  };
  box.addEventListener("pointerover", (e) => {
    const c = e.target.closest(".pcard");
    if (c) focus(Number(c.id.replace("pc-", "")));
  });
  box.addEventListener("pointerleave", () => focus(null));
  threadFlow($(".threads svg", box));
  if (threadObs) threadObs.disconnect();
  threadObs = new ResizeObserver(scheduleThreads);
  threadObs.observe(box);
  // 时间线里的滚动条 / 字号变化会让消息右缘移动几个像素，连线跟着重画一次；
  // 窗口 resize 也要重画（外部分享页整页 zoom 过，尺寸换算依赖当前布局）。
  // 中间链路盒子内部滚动时同理：capture 拿得到不冒泡的 scroll。
  box.addEventListener("scroll", () => scheduleThreads(), true);
  const stl = $("#stl", root);
  if (stl) threadObs.observe(stl);
  if (!wireThreads.bound) {
    wireThreads.bound = true;
    window.addEventListener("resize", () => scheduleThreads(), { passive: true });
    window.addEventListener("load", () => scheduleThreads(), { once: true });
  }
}

function scheduleThreads() {
  if (threadFrame) return;
  threadFrame = requestAnimationFrame(() => {
    threadFrame = 0;
    markChainScroll();
    drawThreads();
    // 首屏的字号、折叠状态、上方 Overview/点评的高度都会在下一拍才稳定；
    // 位置一变连线就得重画，否则出入点会落在旧位置上。
    // 首屏与后续重排（滚动条出现、折叠态、字体）都会让消息位置变；跑一串补偿重画，
    // 每次都很便宜（几十条 path），比监听所有祖先元素稳。
    threadTimers.forEach(clearTimeout);
    threadTimers = [220, 600, 1200, 2400].map((ms) => setTimeout(() => drawThreads(), ms));
  });
}

/* 链路盒子里还有没露出来的步骤时，底部渐隐一下，提示「还能往下滚」。 */
function markChainScroll() {
  $$(".chain-box", root).forEach((box) => {
    const body = $(".chain-body", box);
    if (body) body.classList.toggle("is-more", body.scrollHeight - body.scrollTop - body.clientHeight > 4);
  });
}

/* 右栏不跟着用户问句起：把 timeline 第一条非用户消息的位置量出来，差值补到 .aprobs 的 padding 上。 */
function alignAprobs() {
  const box = $("#sattr", root);
  const card = box && $(".pcard", box);
  // 和第一条「非用户」内容对齐（单轮是中间链路的盒子顶，session 总评是第一条回答），不跟用户问句起。
  const first = $("#stl .chain-box, #stl .msg:not(.k-user)", root);
  if (!box) return;
  const cur = parseFloat(box.style.getPropertyValue("--ap-off")) || 0;
  if (!card || !first) {
    if (cur) box.style.setProperty("--ap-off", "0px");
    return;
  }
  const delta = first.getBoundingClientRect().top - card.getBoundingClientRect().top;
  const next = Math.max(0, Math.round(cur + delta));
  if (Math.abs(next - cur) > 0.5) box.style.setProperty("--ap-off", `${next}px`);
}

function drawThreads() {
  const box = $("#sanatomy", root);
  const svg = box && $(".threads svg", box);
  if (!svg) return;
  if (!S.D) {
    svg.innerHTML = "";
    return;
  }
  alignAprobs();
  const host = svg.getBoundingClientRect();
  if (!host.width) return;
  // 连线坐标统一走 SVG 自己的坐标系：外部分享页整页用 zoom 放大了，
  // getBoundingClientRect 给的是放大后的像素，直接相减会让连线的出入点整体偏移。
  const ctm = svg.getScreenCTM();
  if (!ctm) return;
  const scale = ctm.a || 1;            // zoom 后的实际缩放（外部分享页 >1，内部页 1）
  const inv = ctm.inverse();
  const probe = svg.createSVGPoint();
  const toLocal = (x, y) => {
    probe.x = x;
    probe.y = y;
    return probe.matrixTransform(inv);
  };
  let paths = "";
  $$("#sattr .pcard", root).forEach((card) => {
    const pid = Number(card.id.replace("pc-", ""));
    const prob = S.D.attribution.problems.find((p) => p.id === pid);
    if (!prob) return;
    const pr = card.getBoundingClientRect();
    const end = toLocal(pr.left, pr.top + 22 * scale);
    const x2 = end.x;
    const y2 = end.y;
    const seen = new Set();
    prob.ev.forEach((e) => {
      const ev = S.D.evidence[e];
      const key = ev && `${ev.t}:${ev.m}`;
      // 消息 id 自带轮次（m-<trace>-<index>），session 总评把多轮消息铺在同一条时间线上，
      // 所以按证据自己的轮次找，而不是当前选中轮；找不到（该轮这类消息没进总评）就跳过。
      if (!ev || ev.m == null || seen.has(key)) return;
      const msg = $(`#m-${ev.t}-${ev.m}`, root);
      if (!msg) return;
      seen.add(key);
      const r = ($(".msg-body", msg) || msg).getBoundingClientRect();
      let y = r.top + Math.min(26 * scale, r.height / 2);
      // 中间链路盒子内部滚过之后，消息可能已经滚出盒子的可视区：把出入点夹到盒子上下边缘，
      // 线仍然指进这段链路，而不是飘到盒子外面去。
      const clipBox = msg.closest(".chain-body");
      if (clipBox) {
        const cb = clipBox.getBoundingClientRect();
        y = Math.max(cb.top + 4 * scale, Math.min(cb.bottom - 4 * scale, y));
      }
      const start = toLocal(r.right, y);
      const x1 = start.x;
      const y1 = start.y;
      const span = Math.max(24, x2 - x1);
      paths += `<path data-p="${pid}" data-m="${ev.m}" style="--c:${sevColor(prob.sev)}" d="M${x1} ${y1} C ${x1 + span * 0.55} ${y1}, ${x2 - span * 0.45} ${y2}, ${x2} ${y2}"/>`;
    });
  });
  svg.innerHTML = paths;
}

/* ---------------------------------------------------------------- output */
function renderOut() {
  const D = S.D;
  if (!D) return;
  $("#sout", root).innerHTML = `<div class="out">${compactHTML(D)}</div>`;
  $("#sattr", root).innerHTML = `<div class="out">${attrHTML(D)}</div>`;
  requestAnimationFrame(markCmapScroll);
  scheduleThreads();
}

const evAt = (ev, multi) => (ev.m == null ? "未定位" : `${multi ? `${ev.t + 1}·` : ""}#${ev.m}`);

function attrHTML(D) {
  const A = D.attribution;
  const multi = D.input.traces.length > 1;
  const tax = ctx.data.taxonomy;

  const card = (p) => {
    const pat = p.cl && tax && tax.patterns[p.cl.path];
    const evOne = (e) => {
      const ev = D.evidence[e];
      return `<button type="button" class="evbtn" data-e="${e}"${ev.m == null ? " disabled" : ""}><span class="at">${evAt(ev, multi)}</span><span class="qt">${esc(ev.q)}</span></button>`;
    };
    const evs = p.ev.map(evOne).join("");
    const more = [p.ph && ["现象", p.ph], p.why && ["原因", p.why], p.sevr && ["定级理由", p.sevr], p.calc && p.calc.length && ["核算", p.calc.join("\n")]].filter(Boolean);
    const comp = p.fam && p.comp && p.fam !== p.comp ? `${p.fam} › ${p.comp}` : (p.comp || p.fam || "");
    return `<article class="pcard" id="pc-${p.id}" data-sev="${esc(p.sev || "")}" style="--c:${sevColor(p.sev)}">
      <div class="pcard-head"><span class="sev-badge">${p.sev || "—"}</span><h3>${esc(p.label)}</h3></div>
      <div class="pcard-meta">${comp ? `<span class="faint">${esc(comp)}</span>` : ""}
        ${p.cl ? `<button type="button" class="path" data-pattern="${p.cl.path}" title="${esc((pat && pat.plain) || "")}"><span class="mono">${p.cl.path}</span><span>${esc(pat ? pat.name : "")}</span></button>` : `<span class="faint">未聚类</span>`}</div>
      ${more.length ? `<details class="pcard-more"><summary>${more.map(([k]) => k).join(" · ")}</summary><dl>${
        more.map(([k, v]) => `<dt>${k}</dt><dd${k === "核算" ? ' class="mono"' : ""}>${esc(v)}</dd>`).join("")
      }</dl></details>` : ""}
      ${p.ev.length ? `<details class="pcard-more pcard-evidence"><summary>证据 ${p.ev.length}</summary><div class="evlist">${evs}</div></details>` : ""}</article>`;
  };
  const order = (ids) => ids.map((i) => A.problems[i]).sort((a, b) => SEV.indexOf(a.sev) - SEV.indexOf(b.sev));
  const group = (ids, round = null) => {
    const cards = order(ids);
    if (!cards.length) return "";
    return `<section class="tgroup"${round != null ? ` id="round-${round}" data-round="${round}"` : ""}>${cards.map(card).join("")}</section>`;
  };
  const turn = D.rounds?.[S.round]?.turn ?? S.turn ?? S.round;
  const current = A.turns[Math.max(0, Math.min(turn, A.turns.length - 1))];
  let body = S.sessionView ? group(A.session_problems || []) : (current ? group(current.problems, S.round) : "");
  return body || `<div class="empty">未发现 跨trace 问题 👍</div>`;
}

function renderOverview() {
  const ov = $("#ov", root);
  if (!ov) return;
  requestAnimationFrame(() => {
    if (!ov.isConnected) return;
    const C = S.D && S.D.compact;
    const t = C && C.turns && C.turns[S.cturn];
    ov.innerHTML = t ? compactMapHTML(S.D, t, C.turns.length > 1) : "";
    requestAnimationFrame(markCmapScroll);
  });
}

function compactHTML(D) {
  const C = D.compact;
  if (!C || !C.turns || !C.turns.length) return `<div class="empty">这一组没有 compact 输出</div>`;
  const turns = C.turns;
  const multi = turns.length > 1;
  S.cturn = Math.max(0, Math.min(S.cturn || 0, turns.length - 1));
  const t = turns[S.cturn];
  return t ? compactFlowHTML(D, t, multi) : "";
}

function compactParts(D, t, multi) {
  const nodes = [];
  const trace = D.rounds?.find((r) => r.compact === t.turn)?.trace ?? t.turn;
  CX.forEach(([key, name, cls], ci) => {
    let prev = cls === "plan" ? -1 : null;
    (t[key] || []).forEach((x, i) => {
      const ms = x.ev.map((e) => D.evidence[e]).filter((ev) => ev && ev.m != null).map((ev) => ev.m);
      const pos = ms.length ? Math.min(...ms) : prev ?? (cls === "data" || cls === "art" ? Infinity : -1);
      prev = pos;
      nodes.push({ x, name, cls, ci, i, pos, ev: x.ev.filter((e) => D.evidence[e] && D.evidence[e].m != null) });
    });
  });
  const answer = (t.components || []).find((c) => /答案|answer|合成|final/i.test(c.name || ""));
  const msgs = D.input.traces?.[trace]?.messages || [];
  let lastAnswer = -1;
  msgs.forEach((m, i) => { if (m.k === "answer") lastAnswer = i; });
  if (answer || lastAnswer >= 0) {
    let ev = (answer?.ev || []).filter((e) => D.evidence[e] && D.evidence[e].m != null);
    if (!ev.length && lastAnswer >= 0) {
      const anchor = D.evidence.findIndex((e) => e.t === trace && e.m === lastAnswer && e.src === "attr");
      if (anchor >= 0) ev = [anchor];
    }
    const ms = ev.map((e) => D.evidence[e].m);
    const pos = ms.length ? Math.max(...ms) : (lastAnswer >= 0 ? lastAnswer : Infinity);
    nodes.push({
      x: { c: answer?.c || "生成最终答案并交付" }, name: "答案生成", cls: "answer",
      ci: CX.length + 1, i: 0, pos, ev,
    });
  }
  nodes.sort((a, b) => a.pos - b.pos || a.ci - b.ci || a.i - b.i);
  const at = (pos) => (Number.isFinite(pos) && pos >= 0 ? `${multi ? `${trace + 1}·` : ""}#${pos}` : "");
  return { nodes, at };
}

function compactMapHTML(D, t, multi) {
  const { nodes, at } = compactParts(D, t, multi);
  const sp = skillPoints(t.components || [], D, at);
  const ov = $("#ov", root);
  const avail = Math.max(300, ov ? ov.clientWidth : 900);
  return `${flowMap(nodes, t.turn, at, avail)}${sp}`;
}

function compactFlowHTML(D, t, multi) {
  const { nodes, at } = compactParts(D, t, multi);
  const flow = nodes
    .map((n, k) => {
      const tag = !k || nodes[k - 1].cls !== n.cls ? n.name : "";
      const refs = n.ev.length > 1 ? `<span class="refs">${n.ev.map((e) => `<button type="button" data-e="${e}">${evAt(D.evidence[e], multi)}</button>`).join("")}</span>` : "";
      return `<div class="cf ${n.cls}" id="cf-${t.turn}-${k}"${n.ev.length ? ` data-e="${n.ev[0]}"` : ""}><span class="cf-dot"></span>
        <span class="cf-tag">${tag}</span><div class="cf-body"><span class="cf-at num">${at(n.pos)}</span><span class="cf-text">${esc(n.x.c)}</span>${refs}</div></div>`;
    })
    .join("");
  return `<div class="cflow">${flow}</div>`;
}

const CX = [
  ["plans", "规划", "plan"], ["reasoning", "推理", "think"], ["execution", "执行", "exec"], ["tool_errors", "报错", "err"],
  ["reflections", "反思", "refl"], ["artifacts", "产物", "art"],
];

/* Swimlane map of one turn: lanes are step types, x is the order in the trace, one path threads the steps. */
const LANES = ["plan", "think", "exec", "err", "refl"];
const LANE_NAME = Object.fromEntries(CX.map(([, name, cls]) => [cls, name]));
function flowMap(nodes, turn, at, avail) {
  const steps = nodes.map((n, k) => ({ n, k })).filter((s) => LANES.includes(s.n.cls));
  if (steps.length < 2) return "";
  const lanes = LANES.filter((c) => steps.some((s) => s.n.cls === c));
  const L = 40;
  const H = 26;
  const P = 12;
  const dx = Math.max(8, (avail - L - 2 * P) / Math.max(1, steps.length - 1));
  const W = L + 2 * P + dx * (steps.length - 1);
  const h = 2 * P + (lanes.length - 1) * H;
  const xy = steps.map((s, i) => [L + P + i * dx, P + lanes.indexOf(s.n.cls) * H]);
  let d = `M${xy[0][0]} ${xy[0][1]}`;
  for (let i = 1; i < xy.length; i++) {
    const [x0, y0] = xy[i - 1];
    const [x1, y1] = xy[i];
    const xm = (x0 + x1) / 2;
    d += y0 === y1 ? `L${x1} ${y1}` : `C${xm} ${y0} ${xm} ${y1} ${x1} ${y1}`;
  }
  const grid = lanes
    .map((c, i) => `<text x="0" y="${P + i * H}" class="cm-l">${LANE_NAME[c]}</text><line class="cm-g" x1="${L}" x2="${W}" y1="${P + i * H}" y2="${P + i * H}"/>`)
    .join("");
  const marks = steps
    .map((s, i) => {
      const shape = s.n.cls === "plan" ? `<rect x="-4.5" y="-4.5" width="9" height="9" rx="1.5" transform="rotate(45)"/>` : `<circle r="${s.n.cls === "think" || s.n.cls === "refl" ? 3.5 : 5}"/>`;
      const where = at(s.n.pos);
      return `<g transform="translate(${xy[i][0]} ${xy[i][1]})"><g class="cm-n ${s.n.cls}" data-cf="cf-${turn}-${s.k}" data-tip="${esc(s.n.name + (where ? ` · ${where}` : ""))}|${esc(s.n.x.c)}"><circle r="11" class="cm-hit"/>${shape}</g></g>`;
    })
    .join("");
  return `<div class="cmap"><svg width="${W}" height="${h}" viewBox="0 0 ${W} ${h}">${grid}<path class="cm-p" d="${d}"/>${marks}</svg></div>`;
}

/* Components as skill points: one chip per tool / script / model, click to jump. */
const COMP_KIND = { model: ["模型", "var(--t1)"], tool: ["工具", "var(--accent)"], script: ["脚本", "var(--t2)"], skill: ["技能", "var(--t3)"] };
function skillPoints(list, D, at) {
  const items = list
    .map((x) => {
      const ev = (x.ev || []).filter((e) => D.evidence[e] && D.evidence[e].m != null);
      const ms = ev.map((e) => D.evidence[e].m);
      return { x, ev, first: ms.length ? Math.min(...ms) : null, kind: COMP_KIND[x.kind] ? x.kind : null };
    })
    .filter((x) => x.first != null);
  if (!items.length) return "";
  const chips = items
    .sort((a, b) => a.first - b.first)
    .map((x) => {
      const [label, c] = COMP_KIND[x.kind] || [x.x.kind || "组件", "var(--t3)"];
      const base = String(x.x.name).split("/").filter(Boolean).pop() || x.x.name;
      return `<button type="button" class="sp" style="--c:${c}" data-e="${x.ev[0]}" data-tip="${esc(x.x.name)}|${esc(label)} · ${x.ev.length} 次调用 · ${at(x.first) || "—"}${x.x.c ? ` — ${esc(x.x.c)}` : ""}">
        <i class="sp-dot"></i><span class="sp-name">${esc(base)}</span><span class="sp-n num">${x.ev.length} 次调用</span></button>`;
    })
    .join("");
  return `<div class="sp-box"><span class="sp-k">组件</span><div class="sp-list">${chips}</div></div>`;
}

function onOutClick(e) {
  const cm = e.target.closest("[data-cf]");
  if (cm) {
    const row = document.getElementById(cm.dataset.cf);
    if (!row) return;
    row.classList.add("open");
    flash(row, true);
    if (row.dataset.e) jump(Number(row.dataset.e));
    return;
  }
  const cf = e.target.closest(".cf");
  if (cf && !e.target.closest(".refs")) cf.classList.toggle("open");
  const ev = e.target.closest("[data-e]");
  if (ev && !ev.disabled) return jump(Number(ev.dataset.e));
  const pat = e.target.closest("[data-pattern]");
  if (pat) setFilter({ pattern: pat.dataset.pattern });
}
