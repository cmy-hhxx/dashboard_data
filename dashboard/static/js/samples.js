/* 具体数据: recall list → chat transcript → attribution / compact, with evidence → message links. */
import { $, $$, esc, fmt, compact, SEV, WORST, SEV_NAME, sevColor, KIND, segmented, getJSON, bindTips, REDUCED } from "./core.js";
import { renderContent, segment } from "./render.js";

const ROLE = { planning: "规划", request_generation: "请求生成", tool: "工具执行", script: "脚本执行", skill: "技能装载", delivery: "交付" };
const FOLD_OPEN = new Set(["user", "answer"]);
const PAGE = 50;
const S = { product: null, all: [], rows: [], pageRows: [], page: 1, slug: null, sessionKey: null, D: null, round: 0, trace: 0, cturn: 0, open: new Set(), active: null, cache: new Map() };
let ctx;
let root;
let outSeg;

const params = () => new URLSearchParams(location.search);
const F = () => {
  const q = params();
  return {
    q: q.get("q") || "", w: q.get("w") || "", split: q.get("split") || "", model: q.get("model") || "",
    stage: q.get("stage") || "", mech: q.get("mech") || "", pattern: q.get("pattern") || "", sort: q.get("sort") || "sev",
  };
};
const dirty = () => Object.entries(F()).some(([k, v]) => k !== "sort" && v);

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
        q: "", d: "", tid: "", case: "", task: "", skill: "", lang: r.lang,
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
    g.skill = g.skill || r.skill || "";
  });
  return [...groups.values()].map((g) => {
    const rowsByDate = g.rows.slice().sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));
    const last = rowsByDate[rowsByDate.length - 1];
    return {
      ...last, key: g.key, s: g.key, rows: g.rows,
      q: last.q, d: last.d, w: g.w, n: g.n, tr: g.tr,
      pt: [...g.pt], st: [...g.st], tg: [...g.tg], lb: [...g.lb].join("｜"),
      tid: g.tid, case: g.case, task: g.task, skill: g.skill,
    };
  });
}

export async function render(r, c) {
  ctx = c;
  root = r;
  const index = await c.loadIndex();
  const prod = index.products[c.product];
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
      index.products[other] ? `<a class="link" href="?view=samples&product=${other}">查看 ${other === "aime" ? "AIME" : "问财"} 样本</a>` : ""
    }</div></div></div>`;
    S.product = null;
    return;
  }
  syncFilters();
  renderList();
  const wanted = params().get("case");
  let session = wanted
    ? S.all.find((x) => x.key === wanted) || S.all.find((x) => x.rows.some((r) => r.s === wanted))
    : null;
  if (!session) session = S.rows[0] || S.all[0];
  const key = session.key;
  const focusSlug = wanted && wanted !== key ? wanted : null;
  if (wanted !== key) c.navigate({ case: key }, { replace: true });
  revealPage(key);
  if (key !== S.sessionKey || !S.D) await loadSession(session, focusSlug);
  else if (focusSlug) selectSlugRound(focusSlug);
  markCurrent();
  const tab = params().get("tab") === "compact" ? "compact" : "attr";
  if (outSeg.get() !== tab) {
    outSeg.set(tab, { silent: true });
    renderOut();
  }
  const p = params().get("p");
  if (p != null && S.D) {
    let pid = Number(p);
    if (focusSlug) {
      const at = S.D.attribution.problems.findIndex((x) => x.origin?.slug === focusSlug && x.origin?.id === Number(p));
      if (at >= 0) pid = at;
    }
    requestAnimationFrame(() => flash($(`#pc-${pid}`, root)));
  }
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
    <section class="pane" id="sin" aria-label="评测输入"></section>
    <section class="pane pane-out pane-sticky" aria-label="评测输出">
      <div class="otabs"><div class="seg" id="otab"><span class="seg-knob"></span><button type="button" data-value="attr">归因</button><button type="button" data-value="compact">轨迹</button></div></div>
      <div class="pane-scroll" id="sout"></div>
    </section>
  </div>`;
  outSeg = segmented($("#otab", root), (v) => {
    ctx.navigate({ tab: v }, { replace: true });
    renderOut();
    if (v === "attr") requestAnimationFrame(() => scrollRound(S.round));
  });
  outSeg.set(params().get("tab") === "compact" ? "compact" : "attr", { silent: true });
  let timer;
  $("#sq", root).addEventListener("input", (e) => {
    clearTimeout(timer);
    timer = setTimeout(() => setFilter({ q: e.target.value.trim() }), 140);
  });
  $("#ssort", root).addEventListener("change", (e) => setFilter({ sort: e.target.value }));
  $("#sreset", root).addEventListener("click", () =>
    setFilter({ q: "", w: "", split: "", model: "", stage: "", mech: "", pattern: "", sort: "sev" }),
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
  $("#sin", root).addEventListener("click", onInputClick);
  $("#sout", root).addEventListener("click", onOutClick);
  wireCmapPan($("#sout", root));
  bindTips($("#sout", root), (t) => {
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
    const stages = tax.stages.filter((s) => S.all.some((r) => r.st.includes(s.id))).sort(byNum);
    const mechs = tax.mechanisms
      .filter((m) => S.all.some((r) => r.pt.some((x) => x.split(".")[1] === m.id && (!f.stage || x.startsWith(`${f.stage}.`)))))
      .sort(byNum);
    const pats = Object.keys(tax.patterns)
      .filter((id) => {
        const [s, m] = id.split(".");
        return (!f.stage || s === f.stage) && (!f.mech || m === f.mech) && S.all.some((r) => r.pt.includes(id));
      })
      .sort((a, b) => {
        const pa = a.split(".").map((x) => Number(x.slice(1)));
        const pb = b.split(".").map((x) => Number(x.slice(1)));
        return pa[0] - pb[0] || pa[1] - pb[1] || pa[2] - pb[2];
      });
    const opt = (v, label, on) => `<option value="${esc(v)}"${on ? " selected" : ""}>${esc(label)}</option>`;
    html += `<div class="cascade">
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
    [r.q, r.lb, r.s, r.sid, r.tid, r.case, r.task, r.skill].some((x) => x && String(x).toLowerCase().includes(needle)) ||
    r.rows.some((x) => [x.q, x.sid, x.tid, x.case, x.task, x.skill].some((v) => v && String(v).toLowerCase().includes(needle)));
  S.rows = S.all.filter(
    (r) =>
      (!f.w || r.w === f.w) && (!f.split || r.sp === f.split) && (!f.model || r.m === f.model) &&
      (!f.stage || r.st.includes(f.stage)) &&
      (!f.mech || r.pt.some((x) => {
        const [s, m] = x.split(".");
        return m === f.mech && (!f.stage || s === f.stage);
      })) &&
      (!f.pattern || r.pt.some((x) => x === f.pattern || x.startsWith(f.pattern + "."))) &&
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
  clear && clear.addEventListener("click", () => setFilter({ q: "", w: "", split: "", model: "", stage: "", mech: "", pattern: "" }));
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
  el.innerHTML = `${btn("first", "«", S.page === 1)}${btn("prev", "上一页", S.page === 1)}
    <span class="pager-info">第 <b class="num">${S.page}</b> / ${pages} 页 · ${fmt(S.rows.length)} 个会话</span>
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
  d.rounds = Array.from({ length: n }, (_, i) => ({ slug: part.slug, trace: i, turn: i, compact: i }));
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

async function loadSession(session, focusSlug) {
  S.slug = session.key;
  S.sessionKey = session.key;
  S.session = session;
  $("#sin", root).innerHTML = `<div class="empty">正在读取会话…</div>`;
  let parts;
  try {
    parts = await Promise.all(session.rows.map(async (row) => ({ slug: row.s, detail: await fetchDetail(row.s) })));
  } catch (e) {
    $("#sin", root).innerHTML = `<div class="empty">会话详情读取失败（${esc(e.message)}）。运行 local_dev/refresh.sh 重新生成。</div>`;
    $("#sout", root).innerHTML = "";
    return;
  }
  parts.sort((a, b) => String(a.detail.meta?.request_time || a.detail.date || "").localeCompare(String(b.detail.meta?.request_time || b.detail.date || "")));
  const kept = dropSubsetParts(parts);
  const D = kept.length === 1 ? withRounds(kept[0]) : mergeSessionDetails(kept, session);
  index(D);
  S.D = D;
  S.round = D.rounds.length - 1;
  if (focusSlug) {
    const at = D.rounds.findIndex((r) => r.slug === focusSlug);
    if (at >= 0) S.round = at;
  }
  S.trace = S.round;
  S.cturn = S.round;
  S.open = new Set();
  S.active = null;
  renderIn();
  renderOut();
}

function scrollRound(i) {
  if (outSeg.get() !== "attr") return;
  const el = $(`#round-${i}`, root);
  if (!el) return;
  el.scrollIntoView({ block: "nearest", behavior: REDUCED ? "auto" : "smooth" });
  flash(el);
}

function selectRound(i, { scroll = true } = {}) {
  const D = S.D;
  if (!D) return;
  const n = D.rounds?.length || 1;
  const round = Math.max(0, Math.min(n - 1, Number(i) || 0));
  S.round = round;
  S.trace = round;
  S.cturn = round;
  renderTrace();
  renderOut();
  $$("#atabs .pill", root).forEach((b) => b.setAttribute("aria-pressed", String(Number(b.dataset.at) === round)));
  if (scroll) scrollRound(round);
}

function selectSlugRound(slug) {
  const at = S.D?.rounds?.findIndex((r) => r.slug === slug) ?? -1;
  if (at >= 0) selectRound(at, { scroll: false });
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

function renderIn() {
  const D = S.D;
  const m = D.meta || {};
  const label = (S.prod.models.find((x) => x.id === D.model) || { label: D.model }).label;
  const scene = [m.task, m.subtask, m.difficulty, m.skill, m.mode].filter(Boolean);
  const scale = [m.tokens_in ? `${compact((m.tokens_in || 0) + (m.tokens_out || 0))} tokens` : null,
    m.finish_ms ? `${fmt(m.finish_ms / 1000, 1)} s` : null].filter(Boolean);
  const ids = [["会话 ID", D.ids.session], ["Trace ID", D.ids.trace], ["Case ID", D.ids.case]].filter((x) => x[1]);
  const traces = D.input.traces;
  const group = (k, cls, vals) =>
    vals.length
      ? `<span class="cg${cls ? ` ${cls}` : ""}"><span class="cg-k">${k}</span>${vals.map((v) => `<span class="pill">${esc(v)}</span>`).join("")}</span>`
      : "";
  $("#sin", root).innerHTML = `<div class="sample-head">
      <h2 title="${esc(D.question || "")}">${esc(D.question || "（无提问）")}</h2>
      <div class="chip-groups">
        ${D.split === "lost" ? `<span class="cg"><span class="pill lost">流失用户</span></span>` : ""}
        ${group("模型", "is-model", [label])}
        ${group("日期", "is-plain", [D.date])}
        ${group("场景", "is-scene", scene)}
        ${group("规模", "is-scale", scale)}
      </div>
      <div class="idline">${ids.map(([k, v]) => `<button type="button" class="copy" data-copy="${esc(v)}">${k} <span class="num">${esc(v.length > 18 ? `${v.slice(0, 8)}…${v.slice(-6)}` : v)}</span></button>`).join("")}</div>
      ${traces.length > 1 ? `<div class="trace-tabs" id="ttabs">${traces.map((t, i) => `<button type="button" class="pill" data-t="${i}" aria-pressed="${i === S.trace}">第 ${i + 1} 轮${t.agent ? ` · ${esc(t.agent)}` : ""}</button>`).join("")}</div>` : ""}
      <div id="wf"></div>
    </div>
    <div class="timeline" id="tl"></div>`;
  if (D.input.missing) {
    $("#tl", root).innerHTML = `<div class="empty">这一组没有找到对应的评测输入。</div>`;
    return;
  }
  renderTrace();
}

function renderTrace() {
  const tr = S.D.input.traces[S.trace];
  if (!tr) return;
  $$("#ttabs .pill", root).forEach((b) => b.setAttribute("aria-pressed", String(Number(b.dataset.t) === S.trace)));
  $("#wf", root).innerHTML = waterfall(tr.messages);
  $("#tl", root).innerHTML = tr.messages.map((m, i) => msgHTML(S.trace, i, m)).join("") || `<div class="empty">该轮没有消息</div>`;
}

function waterfall(msgs) {
  const timed = msgs.filter((m) => Number.isFinite(m.at) && Number.isFinite(m.dur) && m.at >= 0 && m.dur > 0 && (m.k === "llm" || m.k === "call"));
  if (timed.length < 2) return "";
  const start = Math.min(...timed.map((m) => m.at));
  const end = Math.max(...timed.map((m) => m.at + m.dur), 1);
  const span = Math.max(1, end - start);
  // Pack overlapping intervals into sub-lanes so simultaneous calls do not cover each other.
  const pack = (kind) => {
    const list = timed.filter((m) => m.k === kind).sort((a, b) => a.at - b.at || b.dur - a.dur);
    const ends = [];
    list.forEach((m) => {
      let i = ends.findIndex((e) => m.at >= e);
      if (i < 0) {
        i = ends.length;
        ends.push(0);
      }
      ends[i] = m.at + m.dur;
      m.sub = i;
    });
    return Math.max(1, ends.length);
  };
  const llmRows = pack("llm");
  const callRows = pack("call");
  const toolTop = 8 + llmRows * 7 + 5;
  const height = Math.max(34, toolTop + callRows * 7 + 6);
  const bars = timed
    .map((m) => {
      const left = Math.max(0, Math.min(99.8, (100 * (m.at - start)) / span));
      const width = Math.max(0.2, Math.min(100 - left, (100 * m.dur) / span));
      const top = (m.k === "llm" ? 8 : toolTop) + (m.sub || 0) * 7;
      return `<span class="k-${m.k}" style="left:${left}%;width:${width}%;top:${top}px" title="${esc(m.name || (m.k === "llm" ? "模型" : "工具"))} · ${fmt(m.dur / 1000, 1)} s"></span>`;
    })
    .join("");
  return `<div class="waterfall" style="height:${height}px" title="模型 / 工具调用时间轴 · 共 ${fmt(span / 1000, 1)} s">${bars}</div>
    <div class="hist-axis num"><span>${start ? `${fmt(start / 1000, 1)} s` : "0 s"}</span><span>模型 ▬ 上 · 工具 ▬ 下</span><span>${fmt(end / 1000, 1)} s</span></div>`;
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
  return `<div class="msg k-${m.k}${chat ? " is-chat" : ""}${folded ? " is-folded" : ""}" id="m-${t}-${i}" data-key="${key}">
    ${chat ? "" : '<span class="msg-dot" aria-hidden="true"></span>'}
    <div class="msg-body"><div class="msg-top"><span class="who">${who}</span><span class="num faint">#${i}</span>
      ${m.name ? `<span class="mname">${esc(m.name)}</span>` : ""}${m.model ? `<span class="faint">${esc(m.model)}</span>` : ""}${time}
      <span class="evs">${sevs.map((s) => `<i style="--c:${sevColor(s)}" title="${s} 证据"></i>`).join("")}</span>
      ${FOLD_OPEN.has(m.k) ? "" : `<button type="button" class="toggle" data-fold="${key}">${folded ? "展开" : "收起"}</button>`}</div>
      ${blockHTML(t, i, m)}${trans ? `<div class="msg-zh">${esc(trans)}</div>` : ""}</div></div>`;
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
      const body = pieceHTML(t, mi, bi, b);
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

function pieceHTML(t, mi, bi, b) {
  const D = S.D;
  const ids = (D._ix.byBlock.get(`${t}:${mi}:${bi}`) || []).filter((e) => D.evidence[e].src === "attr" || e === S.active);
  const marks = ids
    .filter((e) => D.evidence[e].o)
    .map((e) => ({ e: [e], src: D.evidence[e].src, s: D.evidence[e].o[0], z: D.evidence[e].o[1] }));
  const gaps = b.x.some((x) => typeof x !== "string");

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
    selectRound(Number(tab.dataset.t));
    return;
  }
  const copy = e.target.closest("[data-copy]");
  if (copy) {
    navigator.clipboard && navigator.clipboard.writeText(copy.dataset.copy);
    const old = copy.textContent;
    copy.textContent = "已复制";
    copy.classList.add("done");
    setTimeout(() => {
      copy.textContent = old;
      copy.classList.remove("done");
    }, 1200);
    return;
  }
  const mark = e.target.closest("mark.ev");
  if (mark) {
    const p = S.D._ix.owner.get(Number(mark.dataset.e.split(" ")[0]));
    if (outSeg.get() !== "attr") {
      outSeg.set("attr", { silent: true });
      ctx.navigate({ tab: "attr" }, { replace: true });
      renderOut();
    }
    flash($(`#pc-${p}`, root), true);
  }
}

function jump(eid) {
  const ev = S.D.evidence[eid];
  if (!ev || ev.m == null) return;
  if (ev.t !== S.trace) {
    S.trace = ev.t;
    S.round = ev.t;
    S.cturn = ev.t;
    renderTrace();
    $$("#atabs .pill", root).forEach((b) => b.setAttribute("aria-pressed", String(Number(b.dataset.at) === ev.t)));
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

/* ---------------------------------------------------------------- output */
function renderOut() {
  const D = S.D;
  if (!D) return;
  $("#sout", root).innerHTML = `<div class="out">${outSeg.get() === "compact" ? compactHTML(D) : attrHTML(D)}</div>`;
  requestAnimationFrame(markCmapScroll);
}

const evAt = (ev, multi) => (ev.m == null ? "未定位" : `${multi ? `${ev.t + 1}·` : ""}#${ev.m}`);

function attrHTML(D) {
  const A = D.attribution;
  const multi = D.input.traces.length > 1;
  const counts = SEV.map((s) => A.problems.filter((p) => p.sev === s).length);
  const total = A.problems.length;
  const tax = ctx.data.taxonomy;

  const card = (p) => {
    const pat = p.cl && tax && tax.patterns[p.cl.path];
    const evOne = (e) => {
      const ev = D.evidence[e];
      return `<button type="button" class="evbtn" data-e="${e}"${ev.m == null ? " disabled" : ""}><span class="at">${evAt(ev, multi)}</span><span class="qt">${esc(ev.q)}</span></button>`;
    };
    const CAP = 3;
    const evs = p.ev.length > CAP
      ? `${p.ev.slice(0, CAP).map(evOne).join("")}<details class="evmore"><summary>其余 ${p.ev.length - CAP} 条证据</summary>${p.ev.slice(CAP).map(evOne).join("")}</details>`
      : p.ev.map(evOne).join("");
    const more = [p.why && ["原因", p.why], p.sevr && ["定级理由", p.sevr], p.calc && p.calc.length && ["核算", p.calc.join("\n")]].filter(Boolean);
    return `<article class="pcard" id="pc-${p.id}" style="--c:${sevColor(p.sev)}">
      <div class="pcard-head"><span class="sev-badge">${p.sev || "—"}</span><h3>${esc(p.label)}</h3></div>
      <div class="pcard-meta"><span>${esc(ROLE[p.role] || p.role || "—")}</span>${p.fam ? `<span class="faint">${esc(p.fam)} › ${esc(p.comp || "")}</span>` : ""}
        ${p.cl ? `<button type="button" class="path" data-pattern="${p.cl.path}" title="${esc((pat && pat.plain) || "")}"><span class="mono">${p.cl.path}</span>${esc(pat ? pat.name : "")}</button>` : `<span class="faint">未聚类</span>`}</div>
      ${p.ph ? `<p class="pcard-ph">${esc(p.ph)}</p>` : ""}
      ${more.length ? `<details class="pcard-more"><summary>${more.map(([k]) => k).join(" · ")}</summary><dl>${
        more.map(([k, v]) => `<dt>${k}</dt><dd${k === "核算" ? ' class="mono"' : ""}>${esc(v)}</dd>`).join("")
      }</dl></details>` : ""}
      <div class="evlist">${evs}</div></article>`;
  };
  const order = (ids) => ids.map((i) => A.problems[i]).sort((a, b) => SEV.indexOf(a.sev) - SEV.indexOf(b.sev));
  const group = (title, note, ids, round = null) => {
    const cards = order(ids);
    if (!cards.length) return "";
    return `<section class="tgroup"${round != null ? ` id="round-${round}" data-round="${round}"` : ""}><header class="tgroup-head"><span>${title}</span><span class="faint num">${cards.length}</span>${note ? `<span class="faint">${note}</span>` : ""}</header>${cards.map(card).join("")}</section>`;
  };
  const current = A.turns[Math.max(0, Math.min(S.round, A.turns.length - 1))];
  let body = current
    ? group(multi ? `第 ${S.round + 1} 轮` : "本轮", current.correct === false ? "判为错误" : current.correct === true ? "判为正确" : "", current.problems, S.round)
    : "";
  body += group("整场会话", "", A.session_problems);

  const sumHTML = A.summary ? `<div class="sum-box"><p class="summary">${esc(A.summary)}</p></div>` : "";
  return `<div class="attr-head">
      ${sumHTML}
      <div class="sevrow" role="list" aria-label="问题严重度">
        ${SEV.map((s, i) => counts[i]
          ? `<span class="sev-tile" role="listitem" style="--c:${sevColor(i)}"><b class="num">${counts[i]}</b><span>${s}</span></span>`
          : "").join("")}
        <span class="sev-total num">${total ? `${total} 个问题` : "无问题"}</span>
      </div>
    </div>
    ${multi ? `<div class="trace-tabs ctabs" id="atabs">${A.turns.map((t, i) =>
      `<button type="button" class="pill" data-at="${i}" aria-pressed="${i === S.round}">第 ${i + 1} 轮</button>`).join("")}</div>` : ""}
    ${body || `<div class="empty">归因没有记下问题</div>`}`;
}

function compactHTML(D) {
  const C = D.compact;
  if (!C || !C.turns || !C.turns.length) return `<div class="empty">这一组没有 compact 输出</div>`;
  const turns = C.turns;
  const multi = turns.length > 1;
  S.cturn = Math.max(0, Math.min(S.cturn || 0, turns.length - 1));
  let html = (C.overview || []).length
    ? `<ol class="overview">${C.overview.map((x) => `<li>${esc(x)}</li>`).join("")}</ol>`
    : "";
  if (multi) {
    html += `<div class="trace-tabs ctabs">${turns.map((t, i) =>
      `<button type="button" class="pill" data-ct="${i}" aria-pressed="${i === S.cturn}">第 ${i + 1} 轮</button>`).join("")}</div>`;
  }
  const t = turns[S.cturn];
  return html + (t ? compactTurnHTML(D, t, multi) : "");
}

function compactTurnHTML(D, t, multi) {
  const nodes = [];
  CX.forEach(([key, name, cls], ci) => {
    let prev = cls === "plan" ? -1 : null;
    (t[key] || []).forEach((x, i) => {
      const ms = x.ev.map((e) => D.evidence[e]).filter((ev) => ev && ev.m != null).map((ev) => ev.m);
      const pos = ms.length ? Math.min(...ms) : prev ?? (cls === "data" || cls === "art" ? Infinity : -1);
      prev = pos;
      nodes.push({ x, name, cls, ci, i, pos, ev: x.ev.filter((e) => D.evidence[e] && D.evidence[e].m != null) });
    });
  });
  nodes.sort((a, b) => a.pos - b.pos || a.ci - b.ci || a.i - b.i);
  const at = (pos) => (Number.isFinite(pos) && pos >= 0 ? `${multi ? `${t.turn + 1}·` : ""}#${pos}` : "");
  const flow = nodes
    .map((n, k) => {
      const tag = !k || nodes[k - 1].cls !== n.cls ? n.name : "";
      const refs = n.ev.length > 1 ? `<span class="refs">${n.ev.map((e) => `<button type="button" data-e="${e}">${evAt(D.evidence[e], multi)}</button>`).join("")}</span>` : "";
      return `<div class="cf ${n.cls}" id="cf-${t.turn}-${k}"${n.ev.length ? ` data-e="${n.ev[0]}"` : ""}><span class="cf-dot"></span>
        <span class="cf-tag">${tag}</span><div class="cf-body"><span class="cf-at num">${at(n.pos)}</span><span class="cf-text">${esc(n.x.c)}</span>${refs}</div></div>`;
    })
    .join("");
  return `${flowMap(nodes, t.turn, at)}${skillPoints(t.components || [], D, at)}<div class="cflow">${flow}</div>`;
}

const CX = [
  ["plans", "规划", "plan"], ["reasoning", "推理", "think"], ["execution", "执行", "exec"], ["tool_errors", "报错", "err"],
  ["reflections", "反思", "refl"], ["key_data", "关键数据", "data"], ["artifacts", "产物", "art"],
];

/* Swimlane map of one turn: lanes are step types, x is the order in the trace, one path threads the steps. */
const LANES = ["plan", "think", "exec", "err", "refl"];
const LANE_NAME = Object.fromEntries(CX.map(([, name, cls]) => [cls, name]));
function flowMap(nodes, turn, at) {
  const steps = nodes.map((n, k) => ({ n, k })).filter((s) => LANES.includes(s.n.cls));
  if (steps.length < 2) return "";
  const lanes = LANES.filter((c) => steps.some((s) => s.n.cls === c));
  const L = 40;
  const H = 26;
  const P = 12;
  const avail = Math.max(280, ($("#sout", root) || {}).clientWidth - 56 || 400);
  const dx = Math.max(10, Math.min(44, (avail - L - 2 * P) / (steps.length - 1)));
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
      return `<button type="button" class="sp" style="--c:${c}" data-e="${x.ev[0]}" data-tip="${esc(x.x.name)}|${esc(label)} · ${x.ev.length} 处证据 · ${at(x.first) || "—"}${x.x.c ? ` — ${esc(x.x.c)}` : ""}">
        <i class="sp-dot"></i><span class="sp-name">${esc(base)}</span><span class="sp-n num">${x.ev.length}</span></button>`;
    })
    .join("");
  return `<div class="sp-box"><span class="sp-k">组件</span><div class="sp-list">${chips}</div></div>`;
}

function onOutClick(e) {
  const at = e.target.closest("[data-at]");
  if (at) {
    selectRound(Number(at.dataset.at));
    return;
  }
  const ct = e.target.closest("[data-ct]");
  if (ct) {
    selectRound(Number(ct.dataset.ct), { scroll: false });
    return;
  }
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
