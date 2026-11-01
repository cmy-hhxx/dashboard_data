/* 评测体系: how a session becomes compact + attribution + clusters, told with the real batch. */
import {
  $, $$, esc, fmt, pct, sum, SEV, WORST, SEV_NAME, sevColor, KIND,
  counter, runCounters, getJSON, bindTips,
} from "./core.js";

let shown = null;

const ROLE = { planning: "规划", request_generation: "请求生成", tool: "工具执行", script: "脚本执行", skill: "技能装载", delivery: "交付" };

const emptyFilter = () => ({ q: "", w: "", split: "", model: "", stage: "", mech: "", pattern: "" });
const E = {
  product: null, prod: null, rows: [], tax: null, filter: emptyFilter(), slug: null,
  anatomy: null, rendered: null, cache: new Map(), seq: 0, obs: null, timer: null,
};

const clip = (s, n) => {
  const t = String(s == null ? "" : s).replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

function compactAnatomy(a) {
  if (!a || a.empty || !(a.messages || []).length || a.messages.length <= 22) return a;
  const keep = new Set([0, a.messages.length - 1]);
  (a.problems || []).forEach((p) => (p.msgs || []).forEach((i) => [i - 1, i, i + 1].forEach((j) => {
    if (j >= 0 && j < a.messages.length) keep.add(j);
  })));
  const idx = [...keep].sort((x, y) => x - y);
  return {
    ...a,
    messages: idx.map((i) => ({ ...a.messages[i], i })),
    problems: (a.problems || []).map((p) => ({ ...p, msgs: (p.msgs || []).filter((i) => keep.has(i)) })),
    total: a.messages.length,
    shown: idx.length,
  };
}

export async function render(root, c) {
  const d = c.data;
  const key = `${c.product}|${d.generated_at}`;
  if (shown === key && root.firstChild) return;
  shown = key;
  if (E.timer) {
    clearTimeout(E.timer);
    E.timer = null;
  }
  const prods = Object.values(d.products || {});
  if (!prods.length) {
    root.innerHTML = `<div class="bento"><div class="card" style="--span:12"><div class="empty">暂无评测数据。</div></div></div>`;
    return;
  }
  const tot = (f) => sum(prods.map(f));
  const T = {
    sessions: tot((p) => p.kpi.sessions), traces: tot((p) => p.kpi.traces), messages: tot((p) => p.kpi.messages),
    calls: tot((p) => p.kpi.tool_calls), problems: tot((p) => p.kpi.problems), evidence: tot((p) => p.kpi.evidence),
    located: tot((p) => p.kpi.located), clustered: tot((p) => p.kpi.clustered),
    patterns: new Set(prods.flatMap((p) => p.patterns.map((x) => x.id))).size,
    step: (k) => tot((p) => (p.compact.steps[k] || { total: 0 }).total),
    sev: (s) => tot((p) => p.severity[s]),
  };

  let index = null;
  try {
    index = await c.loadIndex();
  } catch (e) {
    index = null;
  }
  const prod = (index && index.products && index.products[c.product]) || null;
  if (E.product !== c.product) {
    E.product = c.product;
    E.filter = emptyFilter();
    E.slug = null;
    E.anatomy = null;
    E.rendered = null;
    E.cache.clear();
    E.seq++;
  }
  E.prod = prod;
  E.rows = (prod && prod.rows) || [];
  E.tax = d.taxonomy || null;

  const raw = d.system && d.system.anatomy;
  const anatomyMap = raw ? (raw.product ? { [raw.product]: raw } : raw) : {};
  const curated = anatomyMap[c.product] || Object.values(anatomyMap)[0] || null;
  if (!E.anatomy) E.anatomy = compactAnatomy(curated);
  if (E.anatomy) E.cache.set(E.anatomy.slug, E.anatomy);
  if (!E.slug || !E.rows.some((r) => r.s === E.slug)) E.slug = (E.anatomy && E.anatomy.slug) || (E.rows[0] && E.rows[0].s) || null;
  if (E.anatomy && E.anatomy.slug !== E.slug) E.anatomy = null;

  root.innerHTML = `<div class="bento">
    ${flowCard(T, d)}
    ${anatomyCard(E.anatomy, E.rows.length > 0)}
    ${taxoCard(d.taxonomy)}
  </div>`;
  E.rendered = E.anatomy ? E.anatomy.slug : null;
  runCounters(root);
  if (!root._sysTips) {
    root._sysTips = true;
    bindTips(root);
  }
  wireAnatomy(root, E.anatomy);
  if (E.rows.length) wireEvidence(root, c);
  else renderMeta(root, E.anatomy);
  wireTaxo(root, d.taxonomy);
}

/* ---------------------------------------------------------------- overview */

function flowCard(T, d) {
  const runs = (d.taxonomy && d.taxonomy.meta) || {};
  const stage = (step, title, rows) => `<div class="stage"><span class="step">${step}<span class="faint"> · ${esc(title)}</span></span>
    ${rows.map(([k, v]) => `<div class="k"><span>${k}</span><b>${v}</b></div>`).join("")}</div>`;
  return `<article class="card" style="--span:12">
    <header class="card-head"><h2>评测体系</h2></header>
    <div class="flow">
      ${stage("输入", "会话原文", [["会话", counter(T.sessions)], ["轨迹", counter(T.traces)], ["消息", counter(T.messages)], ["工具调用", counter(T.calls)]])}
      ${stage("压缩", "Compact 轨迹", [["规划", counter(T.step("plans"))], ["执行链", counter(T.step("execution"))], ["工具报错", counter(T.step("tool_errors"))], ["关键数据", counter(T.step("key_data"))]])}
      ${stage("归因", "逐轮问题与证据", [["问题", counter(T.problems)], ["P0–P3", counter(SEV.slice(0, 4).reduce((a, s) => a + T.sev(s), 0))], ["证据", counter(T.evidence)], ["定位到原文", pct(T.located, T.evidence, 1)]])}
      ${stage("聚类", "环节 · 机制 · 模式", [["已聚类问题", counter(T.clustered)], ["出现的模式", counter(T.patterns)], ["环节 / 机制", `${(d.taxonomy && d.taxonomy.stages.length) || "—"} / ${(d.taxonomy && d.taxonomy.mechanisms.length) || "—"}`], ["聚类版本", esc(runs.version || "—")]])}
    </div>
  </article>`;
}

/* ---------------------------------------------------------------- evidence closure */

function anatomyCard(a, hasIndex) {
  const body = a ? anatomyBody(a) : `<div class="empty">正在读取样本…</div>`;
  return `<article class="card" style="--span:12">
    <header class="card-head"><h2>证据闭环</h2><span class="meta end" id="eMeta"></span></header>
    ${hasIndex ? `<div class="echo">
      <aside class="echo-side" aria-label="证据样本筛选">
        <input class="search" id="eq" type="search" placeholder="搜索问题 · Session ID · Trace ID" autocomplete="off">
        <div class="filters" id="ef"></div>
        <div class="list-meta"><span id="ecount"></span></div>
        <div class="echo-list" id="elist"></div>
      </aside>
      <div class="echo-main"><div id="anatomyBody">${body}</div></div>
    </div>` : `<div class="echo-main"><div id="anatomyBody">${body}</div></div>`}
  </article>`;
}

function anatomyBody(a) {
  if (!a || a.empty || !(a.messages || []).length || !(a.problems || []).length) {
    return `<div class="empty">该样本没有可定位的证据</div>`;
  }
  const msgs = a.messages
    .map((m, i) => {
      const idx = m.i == null ? i : m.i;
      const hit = a.problems.some((p) => (p.msgs || []).includes(idx));
      return `<div class="rail-msg k-${m.k}${hit ? " hit" : ""}" data-m="${idx}"><span class="kind k-${m.k}">${KIND[m.k] || m.k}<span class="faint num">${idx}</span></span><span class="text" title="${esc(m.text)}">${esc(m.name ? `${m.name} · ` : "")}${esc(m.text)}</span></div>`;
    })
    .join("");
  const probs = a.problems
    .slice()
    .sort((x, y) => SEV.indexOf(x.sev) - SEV.indexOf(y.sev))
    .map(
      (p) => `<div class="aprob" data-p="${p.id}" style="--c:${sevColor(p.sev)}">
        <span class="pill sevpill" style="--c:${sevColor(p.sev)}">${p.sev}</span>
        <span class="pill">${esc(roleName(p.role))}</span>${p.path ? `<span class="pill mono">${esc(p.path)}</span>` : ""}
        <div class="t">${esc(p.label)}</div><div class="s">${esc(p.comp || "")} · 证据落在消息 ${(p.msgs || []).join("、") || "—"}</div></div>`,
    )
    .join("");
  return `<div class="anatomy">
    <div class="rail">${msgs}</div>
    <div class="threads"><svg aria-hidden="true"></svg></div>
    <div class="aprobs">${probs}</div>
  </div>`;
}

const roleName = (r) => ROLE[r] || r || "—";

/* Filter the reconstruction from samples.json; the detail rail is fetched per pick. */
function wireEvidence(root, c) {
  const eq = $("#eq", root);
  const ef = $("#ef", root);
  const list = $("#elist", root);
  if (!eq || !ef || !list) return;
  applyEcho(root);
  ef.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-k]");
    if (!b) return;
    const cur = E.filter[b.dataset.k];
    E.filter[b.dataset.k] = cur === b.dataset.v ? "" : b.dataset.v;
    applyEcho(root);
  });
  ef.addEventListener("change", (e) => {
    const s = e.target.closest("select[data-k]");
    if (!s) return;
    const k = s.dataset.k;
    E.filter[k] = s.value;
    if (k === "stage") Object.assign(E.filter, { mech: "", pattern: "" });
    if (k === "mech") E.filter.pattern = "";
    applyEcho(root);
  });
  eq.addEventListener("input", (e) => {
    clearTimeout(E.timer);
    E.timer = setTimeout(() => {
      E.filter.q = e.target.value.trim();
      applyEcho(root);
    }, 140);
  });
  list.addEventListener("click", (e) => {
    const clear = e.target.closest("[data-clear]");
    if (clear) {
      E.filter = emptyFilter();
      const q = $("#eq", root);
      if (q) q.value = "";
      applyEcho(root);
      return;
    }
    const b = e.target.closest(".srow");
    if (!b) return;
    E.slug = b.dataset.s;
    markCurrent(root);
    loadSample(root, E.slug);
  });
}

function syncEchoFilters(root) {
  const ef = $("#ef", root);
  if (!ef) return;
  const prod = E.prod;
  if (!prod) {
    ef.innerHTML = "";
    return;
  }
  const f = E.filter;
  const btn = (k, v, label, color) =>
    `<button type="button" data-k="${k}" data-v="${esc(v)}" aria-pressed="${f[k] === v}"${color ? ` style="--c:${color}"` : ""}>${color ? "<i></i>" : ""}${esc(label)}</button>`;
  const row = (cls, items) => `<div class="frow${cls ? ` ${cls}` : ""}">${items}</div>`;
  let html = row("sev", WORST.map((w, i) => btn("w", w, SEV_NAME[w], sevColor(i))).join(""));
  if ((prod.splits || []).some((s) => s.id === "lost")) html += row("", btn("split", "lost", "仅看流失用户"));
  html += row("", (prod.models || []).map((m) => btn("model", m.id, m.label)).join(""));
  const tax = E.tax;
  if (tax) {
    const byNum = (a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1));
    const stages = tax.stages.filter((s) => E.rows.some((r) => (r.st || []).includes(s.id))).sort(byNum);
    const mechs = tax.mechanisms
      .filter((m) => E.rows.some((r) => (r.pt || []).some((x) => x.split(".")[1] === m.id && (!f.stage || x.startsWith(`${f.stage}.`)))))
      .sort(byNum);
    const pats = Object.keys(tax.patterns)
      .filter((id) => {
        const [s, m] = id.split(".");
        return (!f.stage || s === f.stage) && (!f.mech || m === f.mech) && E.rows.some((r) => (r.pt || []).includes(id));
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
  ef.innerHTML = html;
}

function applyEcho(root) {
  const count = $("#ecount", root);
  const list = $("#elist", root);
  const body = $("#anatomyBody", root);
  if (!count || !list || !body) return;
  const rows = filterRows(E.rows, E.filter).sort((a, b) => sevRank(a.w) - sevRank(b.w) || (b.n || 0) - (a.n || 0));
  if (!rows.length) {
    count.textContent = `${prodLabel()} · 0 / ${fmt(E.rows.length)} 个会话`;
    list.innerHTML = `<div class="empty">没有符合条件的会话<br><button type="button" class="link" data-clear>清除筛选</button></div>`;
    body.innerHTML = `<div class="empty">没有符合条件的会话</div>`;
    E.slug = null;
    E.rendered = null;
    renderMeta(root, null);
    syncEchoFilters(root);
    return;
  }
  if (!E.slug || !rows.some((r) => r.s === E.slug)) E.slug = rows[0].s;
  count.textContent = `${prodLabel()} · ${fmt(rows.length)} / ${fmt(E.rows.length)} 个会话`;
  list.innerHTML = rows.map(rowHTML).join("");
  syncEchoFilters(root);
  markCurrent(root);
  scrollCurrent(root);
  if (E.anatomy && E.anatomy.slug === E.slug && E.rendered === E.slug) {
    renderMeta(root, E.anatomy);
    return;
  }
  if (E.anatomy && E.anatomy.slug === E.slug) {
    showAnatomy(root, E.anatomy);
    return;
  }
  loadSample(root, E.slug);
}

function rowHTML(r) {
  const models = (E.prod && E.prod.models) || [];
  const label = ((models.find((m) => m.id === r.m) || {}).label) || r.m;
  return `<button type="button" class="srow" data-s="${r.s}" style="--c:${sevColor(r.w)}" aria-current="${r.s === E.slug}">
    <span class="bar"></span><span><span class="q">${esc(r.q || "（无提问）")}</span>
    <span class="m num"><span>${esc(label)}</span><span>${esc((r.d || "").slice(5))}</span><span>${r.n ? `${r.w} · ${r.n} 个问题` : "无问题"}</span>${r.sp === "lost" ? '<span class="tag-lost">流失</span>' : ""}</span></span></button>`;
}

function filterRows(rows, f) {
  const needle = f.q.toLowerCase();
  return rows.filter((r) => {
    const hay = [r.q, r.lb, r.s, r.sid, r.tid, r.case, r.task, r.skill].filter(Boolean).join(" ").toLowerCase();
    return (
      (!f.w || r.w === f.w) &&
      (!f.split || r.sp === f.split) &&
      (!f.model || r.m === f.model) &&
      (!f.stage || (r.st || []).includes(f.stage)) &&
      (!f.mech || (r.pt || []).some((x) => {
        const [s, m] = x.split(".");
        return m === f.mech && (!f.stage || s === f.stage);
      })) &&
      (!f.pattern || (r.pt || []).some((x) => x === f.pattern || x.startsWith(`${f.pattern}.`))) &&
      (!needle || hay.includes(needle))
    );
  });
}

const sevRank = (w) => (SEV.includes(w) ? SEV.indexOf(w) : 99);
const prodLabel = () => (E.prod && E.prod.label) || (E.product === "wencai" ? "问财" : "AIME");

function markCurrent(root) {
  const list = $("#elist", root);
  if (!list) return;
  $$(".srow", list).forEach((b) => b.setAttribute("aria-current", String(b.dataset.s === E.slug)));
}

function scrollCurrent(root) {
  const list = $("#elist", root);
  const cur = list && $(`.srow[data-s="${E.slug}"]`, list);
  if (!list || !cur) return;
  const lr = list.getBoundingClientRect();
  const cr = cur.getBoundingClientRect();
  if (cr.top < lr.top) list.scrollTop -= lr.top - cr.top;
  else if (cr.bottom > lr.bottom) list.scrollTop += cr.bottom - lr.bottom;
}

function renderMeta(root, a) {
  const el = $("#eMeta", root);
  if (!el) return;
  if (!a || a.empty || !(a.messages || []).length) {
    el.textContent = "";
    return;
  }
  const total = a.total == null ? a.messages.length : a.total;
  const shown = a.shown == null ? a.messages.length : a.shown;
  const trace = a.traces > 1 ? `第 ${(a.trace || 0) + 1} 轮 · ` : "";
  el.textContent = `${trace}${shown < total ? `${fmt(shown)} / ${fmt(total)} 条消息` : `${fmt(total)} 条消息`}`;
}

/* ---------------------------------------------------------------- detail loading */

async function loadSample(root, slug) {
  if (!slug) return;
  const body = $("#anatomyBody", root);
  if (!body) return;
  const token = ++E.seq;
  E.rendered = null;
  const hit = E.cache.get(slug);
  if (hit) {
    showAnatomy(root, hit);
    return;
  }
  body.innerHTML = `<div class="empty">正在读取样本…</div>`;
  renderMeta(root, null);
  try {
    const detail = await getJSON(`samples/${slug}.json`);
    if (token !== E.seq) return;
    const a = anatomyFrom(detail);
    E.cache.set(slug, a);
    if (E.cache.size > 16) E.cache.delete(E.cache.keys().next().value);
    showAnatomy(root, a);
  } catch (e) {
    if (token !== E.seq) return;
    body.innerHTML = `<div class="empty">样本详情读取失败（${esc(e.message)}）</div>`;
    renderMeta(root, null);
  }
}

function showAnatomy(root, a) {
  E.anatomy = a;
  E.slug = a.slug;
  E.rendered = a.slug;
  const body = $("#anatomyBody", root);
  if (body) body.innerHTML = anatomyBody(a);
  renderMeta(root, a);
  wireAnatomy(root, a);
  markCurrent(root);
}

function anatomyFrom(detail) {
  const traces = (detail.input && detail.input.traces) || [];
  let best = null;
  traces.forEach((tr, ti) => {
    const msgs = tr.messages || [];
    const probs = ((detail.attribution && detail.attribution.problems) || [])
      .map((p) => {
        const seen = new Set();
        (p.ev || []).forEach((e) => {
          const ev = detail.evidence && detail.evidence[e];
          if (!ev || (ev.t == null ? 0 : ev.t) !== ti || ev.m == null) return;
          if (ev.m >= 0 && ev.m < msgs.length) seen.add(ev.m);
        });
        return {
          id: p.id, sev: p.sev, label: p.label, role: p.role, comp: p.comp,
          path: p.cl ? p.cl.path : null,
          msgs: [...seen].sort((a, b) => a - b),
        };
      })
      .filter((p) => p.msgs.length);
    const evCount = probs.reduce((a, p) => a + p.msgs.length, 0);
    const score = probs.length * 20 + Math.min(evCount, 24) - Math.max(0, msgs.length - 40);
    if (!best || score > best.score) best = { tr, ti, probs, score };
  });
  const base = { slug: detail.slug, product: detail.product, model: detail.model, question: detail.question, traces: traces.length };
  if (!best) return { ...base, empty: true, messages: [], problems: [], trace: 0, total: 0, shown: 0 };
  const all = best.tr.messages || [];
  if (!best.probs.length) return { ...base, empty: true, messages: [], problems: [], trace: best.ti, total: all.length, shown: 0 };
  const keep = new Set();
  best.probs.forEach((p) => p.msgs.forEach((i) => keep.add(i)));
  if (all.length > 22) {
    keep.add(0);
    keep.add(all.length - 1);
    [...keep].forEach((i) => {
      [i - 1, i + 1].forEach((j) => {
        if (j >= 0 && j < all.length) keep.add(j);
      });
    });
  } else {
    all.forEach((_, i) => keep.add(i));
  }
  const indices = [...keep].sort((a, b) => a - b);
  const messages = indices.map((i) => ({
    i, k: all[i].k, name: all[i].name, dur: all[i].dur, text: clip(messageText(all[i]), 90),
  }));
  const problems = best.probs.map((p) => ({ ...p, msgs: p.msgs.filter((i) => keep.has(i)) }));
  return { ...base, messages, problems, trace: best.ti, total: all.length, shown: indices.length };
}

function messageText(m) {
  const blocks = m.blocks || [];
  for (const b of blocks) {
    const xs = Array.isArray(b.x) ? b.x : [b.x];
    const text = xs.find((x) => typeof x === "string" && x.trim());
    if (text) return text;
  }
  return "";
}

/* ---------------------------------------------------------------- anatomy wiring */

function wireAnatomy(root, a) {
  if (E.obs) {
    E.obs.disconnect();
    E.obs = null;
  }
  const box = $("#anatomyBody .anatomy", root);
  if (!box || !a || a.empty) return;
  const draw = () => {
    const svg = $(".threads svg", box);
    if (!svg) return;
    const host = svg.getBoundingClientRect();
    if (!host.width) return;
    let paths = "";
    $$(".aprob", box).forEach((pb) => {
      const pid = pb.dataset.p;
      const pr = pb.getBoundingClientRect();
      const y2 = pr.top + 22 - host.top;
      const prob = a.problems.find((x) => String(x.id) === pid);
      if (!prob) return;
      (prob.msgs || []).forEach((mi) => {
        const m = $(`.rail-msg[data-m="${mi}"]`, box);
        if (!m) return;
        const r = m.getBoundingClientRect();
        const y1 = r.top + r.height / 2 - host.top;
        const w = host.width;
        paths += `<path data-p="${pid}" style="--c:${sevColor(prob.sev)}" d="M0 ${y1} C ${w * 0.55} ${y1}, ${w * 0.45} ${y2}, ${w} ${y2}"/>`;
      });
    });
    svg.innerHTML = paths;
  };
  requestAnimationFrame(draw);
  E.obs = new ResizeObserver(draw);
  E.obs.observe(box);

  const focus = (pid) => {
    box.classList.toggle("is-focus", pid != null);
    const prob = pid != null && a.problems.find((x) => String(x.id) === pid);
    $$(".aprob", box).forEach((b) => b.classList.toggle("on", b.dataset.p === pid));
    $$(".threads path", box).forEach((p) => p.classList.toggle("on", p.dataset.p === pid));
    $$(".rail-msg", box).forEach((m) => m.classList.toggle("on", !!prob && (prob.msgs || []).includes(Number(m.dataset.m))));
  };
  box.addEventListener("pointerover", (e) => {
    const b = e.target.closest(".aprob");
    focus(b ? b.dataset.p : null);
  });
  box.addEventListener("pointerleave", () => focus(null));
}

/* ---------------------------------------------------------------- taxonomy */

const taxoNum = (a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1));

function taxoCard(tax) {
  if (!tax) return "";
  const mechs = (tax.mechanisms || []).slice().sort(taxoNum);
  const tint = (i, n) => `color-mix(in oklab, var(--accent) ${Math.round(n > 1 ? 88 - (i * 54) / (n - 1) : 88)}%, var(--card))`;
  const cols = tax.phases
    .map((ph, pi) => {
      const stages = tax.stages.filter((s) => s.phase === ph.id).sort(taxoNum);
      const span = stages.length === 1 ? 6 : stages.length === 2 ? 3 : 2;
      return `<div class="taxo-col">
      <div class="taxo-ph"><span class="faint num">${String(pi + 1).padStart(2, "0")}</span> ${esc(ph.name)}</div>
      <div class="stg-grid">${stages
        .map((s) => `<button type="button" class="stg" data-stage="${s.id}" aria-expanded="false" style="--span:${span}">
            <span class="stg-top"><code>${s.id}</code><b>${esc(s.name)}</b></span>
            <p title="${esc(s.def || "")}">${esc(s.def || "")}</p></button><div class="stg-detail" data-for="${s.id}" hidden></div>`)
        .join("")}</div></div>`;
    })
    .join("");
  const mechList = mechs
    .map((m, i) => `<div class="mech"><i style="--c:${tint(i, mechs.length)}"></i><div><b>${esc(m.id)} ${esc(m.name)}</b><p>${esc(m.def || "")}</p></div></div>`)
    .join("");
  return `<article class="card" style="--span:12">
    <header class="card-head"><h2>聚类体系</h2><span class="meta end">${tax.phases.length} 阶段 · ${tax.stages.length} 环节 · ${tax.mechanisms.length} 机制 · ${Object.keys(tax.patterns).length} 模式</span></header>
    <div id="taxo" class="taxo-wrap">
      <div class="taxo">${cols}</div>
      <aside class="taxo-method">
        <span class="taxo-label">聚类方法</span>
        <div class="mech-list">${mechList}</div>
      </aside>
    </div>
  </article>`;
}

function wireTaxo(root, tax) {
  const box = $("#taxo", root);
  if (!box || !tax) return;
  const patNum = (id) => id.split(".").map((x) => Number(x.slice(1)));
  box.addEventListener("click", (e) => {
    const b = e.target.closest(".stg");
    if (!b) return;
    const open = b.getAttribute("aria-expanded") !== "true";
    b.setAttribute("aria-expanded", String(open));
    const det = $(`.stg-detail[data-for="${b.dataset.stage}"]`, box);
    if (!det) return;
    if (open && !det.innerHTML) {
      const pats = Object.entries(tax.patterns)
        .filter(([id]) => id.startsWith(`${b.dataset.stage}.`))
        .sort((a, c) => {
          const pa = patNum(a[0]);
          const pc = patNum(c[0]);
          return pa[0] - pc[0] || pa[1] - pc[1] || pa[2] - pc[2];
        });
      det.innerHTML = pats.map(([, p]) => `<div class="pt"><span>${esc(p.name)}</span><small>${esc(p.plain || "")}</small></div>`).join("") || `<span class="dim">暂无模式</span>`;
    }
    det.hidden = !open;
  });
}
