/* 评测体系: how a session becomes compact + attribution + clusters, told with the real batch. */
import {
  $, $$, esc, fmt, SEV, WORST, SEV_NAME, sevColor, KIND,
  getJSON, bindTips, REDUCED,
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
    ${flowCard(d.taxonomy)}
    ${anatomyCard(E.anatomy, E.rows.length > 0)}
  </div>`;
  E.rendered = E.anatomy ? E.anatomy.slug : null;
  if (!root._sysTips) {
    root._sysTips = true;
    bindTips(root);
  }
  wireAnatomy(root, E.anatomy);
  if (E.rows.length) wireEvidence(root, c);
  else renderMeta(root, E.anatomy);
  wireFx(root, d.taxonomy);
}

/* ---------------------------------------------------------------- 评测体系: one mechanism diagram */
const FX_IN = [
  ["user", "用户提问", "原始问句 · 追问", "user"],
  ["think", "模型思考", "推理 · 规划 · 自我修正", "llm"],
  ["call", "工具调用", "参数 → 返回 · 报错", "tool"],
  ["answer", "最终回答", "交付给用户的结论", "final"],
];
const FX_STEPS = [["规划", "var(--t0)"], ["推理", "var(--t2)"], ["执行", "var(--accent)"], ["报错", "var(--sev-1)"], ["反思", "var(--t2)"], ["关键数据", "var(--t1)"], ["产物", "var(--t1)"]];
const FX_OUT = [
  ["问题", "一句话标签 + 现象", "只记能回链原文的问题", "var(--sev-1)"],
  ["定级", "P0 最严重 → P4 最轻", "按对用户的影响定级", "var(--sev-0)"],
  ["证据", "引用原文 → 消息 #n", "点一下就回到原文", "var(--accent)"],
  ["归属", "组件 · 环节角色", "交给聚类归入模式", "var(--t1)"],
];
const taxoNum = (a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1));
const patNum = (id) => id.split(".").map((x) => Number(x.replace(/\D/g, "")) || 0);
const mechTint = (i, n) => `color-mix(in oklab, var(--accent) ${Math.round(n > 1 ? 88 - (i * 54) / (n - 1) : 88)}%, var(--card))`;

function flowCard(tax) {
  const ticks = Array.from({ length: 60 }, (_, k) => {
    const c = k % 9 === 0 ? FX_STEPS[(k / 9) % FX_STEPS.length][1] : "";
    const a = (k * Math.PI) / 30;
    const r0 = c ? 63 : 67;
    const [x0, y0, x1, y1] = [Math.cos(a) * r0, Math.sin(a) * r0, Math.cos(a) * 74, Math.sin(a) * 74].map((v) => v.toFixed(1));
    return `<line x1="${x0}" y1="${y0}" x2="${x1}" y2="${y1}"${c ? ` class="c" style="--c:${c}"` : ""}/>`;
  }).join("");
  const tiles = [2, 9, 0, 9, 2, 9, 9, 4, 9].map((v) => `<i style="--c:${v < 5 ? `var(--sev-${v})` : "var(--sev-none)"}"></i>`).join("");
  const ins = FX_IN.map(([k, t, sub, tag]) =>
    `<div class="fx-box fx-in k-${k}"><i class="fx-dot"></i><span class="fx-txt"><b>${t}</b><small>${sub}</small></span><span class="fx-end">${tag}</span></div>`).join("");
  const outs = FX_OUT.map(([t, sub, rule, c], i) => {
    const ico = i === 1
      ? `<span class="fx-ico is-sev">${SEV.map((_, k) => `<i style="--c:${sevColor(k)};--k:${k}"></i>`).join("")}</span>`
      : `<span class="fx-ico"><i></i></span>`;
    return `<div class="fx-box fx-out" style="--c:${c}">${ico}<span class="fx-txt"><b>${t}</b><small>${sub}</small><em>${rule}</em></span><span class="fx-end num">0${i + 1}</span></div>`;
  }).join("");
  let taxHTML = "";
  if (tax) {
    const stages = tax.stages.slice().sort(taxoNum);
    const mechs = tax.mechanisms.slice().sort(taxoNum);
    const pids = Object.keys(tax.patterns);
    const count = (sid) => pids.filter((id) => id.startsWith(`${sid}.`)).length;
    const first = stages.find((st) => count(st.id)) || stages[0];
    const phases = tax.phases.map((ph) => {
      const list = stages.filter((st) => st.phase === ph.id);
      if (!list.length) return "";
      return `<div class="fx-ph"><span class="fx-ph-n">${esc(ph.name)}</span><span class="fx-ph-s">${list.map((st) =>
        `<button type="button" class="fx-stg" data-stage="${st.id}" aria-pressed="${st === first}" title="${esc(st.def || "")}"><code>${st.id}</code>${esc(st.name)}<span class="n num">${count(st.id)}</span></button>`).join("")}</span></div>`;
    }).join("");
    const mechRows = mechs.map((m, i) =>
      `<span class="fx-mech" data-m="${m.id}" title="${esc(m.def || "")}"><i style="--c:${mechTint(i, mechs.length)}"></i><code>${m.id}</code><b>${esc(m.name)}</b><small>${esc(m.def || "")}</small></span>`).join("");
    taxHTML = `<div class="fx-tax" id="fxTax">
      <div class="fx-label"><span class="num">04</span>聚类<span class="faint"> · 问题落在哪个环节 × 以什么机制失败 → 归入一个模式</span></div>
      <div class="fx-tax-grid">
        <div class="fx-box fx-stgbox"><span class="fx-k">环节 · ${stages.length}<span>点选环节，下方列出它的全部模式</span></span><div class="fx-phs">${phases}</div></div>
        <div class="fx-box fx-mechbox"><span class="fx-k">机制 · ${mechs.length}<span>亮起的是当前环节用到的机制</span></span><div class="fx-mechs">${mechRows}</div></div>
        <div class="fx-box fx-pm" id="fxDetail">${first ? patternMatrix(tax, first.id) : ""}</div>
      </div></div>`;
  }
  return `<article class="card" style="--span:12">
    <header class="card-head"><h2>评测体系</h2><span class="meta end">会话 → 压缩 → 归因 → 聚类</span></header>
    <div class="fx" id="fx"><svg class="fx-wires" aria-hidden="true"></svg>
      <div class="fx-col"><div class="fx-label"><span class="num">01</span>会话输入</div>${ins}</div>
      <div class="fx-col fx-mid"><div class="fx-label"><span class="num">02</span>Compact 压缩</div>
        <div class="fx-hubwrap">
          <div class="fx-ask">保留轨迹顺序<b>是</b></div>
          <div class="fx-hub"><span class="fx-orbit"><i></i></span><svg class="fx-ring" viewBox="-80 -80 160 160" aria-hidden="true">${ticks}</svg><span class="fx-core"><span>${tiles}</span></span></div>
          <p class="fx-cap">每条轨迹压成 7 类关键步骤<br><em>每一步都带原文位置</em></p>
          <div class="fx-steps">${FX_STEPS.map(([n, c]) => `<span style="--c:${c}"><i></i>${n}</span>`).join("")}</div>
        </div></div>
      <div class="fx-col"><div class="fx-label"><span class="num">03</span>归因</div>${outs}</div>
    </div>${taxHTML}</article>`;
}

/* Every pattern of one stage, grouped by mechanism: stage × mechanism → pattern. */
function patternMatrix(tax, sid) {
  const st = tax.stages.find((x) => x.id === sid);
  if (!st) return "";
  const mechs = tax.mechanisms.slice().sort(taxoNum);
  const pats = Object.entries(tax.patterns)
    .filter(([id]) => id.startsWith(`${sid}.`))
    .sort((a, b) => { const pa = patNum(a[0]); const pb = patNum(b[0]); return pa[1] - pb[1] || pa[2] - pb[2]; });
  const known = new Set(mechs.map((m) => m.id));
  const groups = mechs.map((m, i) => [m.id, m.name, mechTint(i, mechs.length)]);
  if (pats.some(([id]) => !known.has(id.split(".")[1]))) groups.push(["", "其他", "var(--t3)"]);
  let d = 0;
  const cols = groups.map(([mid, name, c]) => {
    const list = pats.filter(([id]) => (mid ? id.split(".")[1] === mid : !known.has(id.split(".")[1])));
    if (!list.length) return "";
    return `<div class="fx-pm-col" data-m="${mid}"><div class="fx-pm-h"><i style="--c:${c}"></i><code>${mid || "—"}</code><b>${esc(name)}</b><span class="num">${list.length}</span></div>${
      list.map(([id, pt]) => `<div class="fx-pat" style="--d:${d++}" title="${esc(pt.plain || "")}"><code>${id}</code><span>${esc(pt.name || id)}</span></div>`).join("")}</div>`;
  }).join("");
  const ex = pats[0] ? pats[0][0].split(".") : [sid, "M1", "1"];
  const used = new Set(pats.map(([id]) => id.split(".")[1]));
  return `<div class="fx-pm-side">
      <span class="fx-k">模式编号</span>
      <div class="fx-code"><span><b>${ex[0]}</b><small>环节</small></span><i>.</i><span><b>${ex[1]}</b><small>机制</small></span><i>.</i><span><b>${ex[2]}</b><small>序号</small></span></div>
      <p class="fx-def"><b>${esc(st.name)}</b>${esc(st.def || "")}</p>
      <span class="fx-pm-n num">${pats.length} 个模式 · ${used.size} 种机制</span>
    </div>
    <div class="fx-pm-grid">${cols || '<span class="dim">该环节暂无模式</span>'}</div>`;
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
        <div class="aprob-top"><span class="sev-badge">${p.sev}</span><span>${esc(roleName(p.role))}</span>${p.path ? `<span class="mono faint">${esc(p.path)}</span>` : ""}</div>
        <div class="t">${esc(p.label)}</div><div class="s">${esc(p.comp || "")} · 证据落在消息 ${(p.msgs || []).join("、") || "—"}</div></div>`,
    )
    .join("");
  return `<div class="anatomy${a.messages.length >= 12 ? " is-fill" : ""}">
    <div class="rail">${msgs}</div>
    <div class="threads"><svg aria-hidden="true"></svg></div>
    <div class="aprobs${a.problems.length >= 4 ? " is-spread" : ""}">${probs}</div>
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

/* ---------------------------------------------------------------- 评测体系 wiring: wires, pulses, stage picker */

function wireFx(root, tax) {
  clearInterval(E.fxTimer);
  if (E.fxT) E.fxT.forEach(clearTimeout);
  E.fxT = new Set();
  if (E.fxObs) E.fxObs.disconnect();
  const box = $("#fx", root);
  if (!box) return;
  const svg = $(".fx-wires", box);
  const hub = $(".fx-hub", box);
  const draw = () => {
    const h = box.getBoundingClientRect();
    if (!h.width) return;
    const hr = hub.getBoundingClientRect();
    const cy = hr.top + hr.height / 2 - h.top;
    const curve = (x0, y0, x1, y1, id, cls) => {
      const xm = (x0 + x1) / 2;
      return `<path id="${id}" class="fx-w ${cls}" d="M${x0.toFixed(1)} ${y0.toFixed(1)}C${xm.toFixed(1)} ${y0.toFixed(1)} ${xm.toFixed(1)} ${y1.toFixed(1)} ${x1.toFixed(1)} ${y1.toFixed(1)}"/>`;
    };
    let d = "";
    $$(".fx-in", box).forEach((b, i) => {
      const r = b.getBoundingClientRect();
      d += curve(r.right - h.left, r.top + r.height / 2 - h.top, hr.left - h.left + 8, cy, `fw-i${i}`, "in");
    });
    $$(".fx-out", box).forEach((b, i) => {
      const r = b.getBoundingClientRect();
      d += curve(hr.right - h.left - 8, cy, r.left - h.left, r.top + r.height / 2 - h.top, `fw-o${i}`, "out");
    });
    svg.setAttribute("viewBox", `0 0 ${h.width} ${h.height}`);
    svg.innerHTML = d;
  };
  draw();
  E.fxObs = new ResizeObserver(draw);
  E.fxObs.observe(box);

  const tx = $("#fxTax", root);
  if (tx && tax) {
    const pick = (sid) => {
      $$(".fx-stg", tx).forEach((x) => x.setAttribute("aria-pressed", String(x.dataset.stage === sid)));
      $("#fxDetail", tx).innerHTML = patternMatrix(tax, sid);
      const used = new Set(Object.keys(tax.patterns).filter((id) => id.startsWith(`${sid}.`)).map((id) => id.split(".")[1]));
      $$(".fx-mech", tx).forEach((m) => m.classList.toggle("is-off", !used.has(m.dataset.m)));
    };
    const focus = (mid) => {
      $$(".fx-pm-col", tx).forEach((c) => c.classList.toggle("is-dim", !!mid && c.dataset.m !== mid));
      $$(".fx-mech", tx).forEach((c) => c.classList.toggle("is-hl", !!mid && c.dataset.m === mid));
    };
    tx.addEventListener("click", (e) => {
      const b = e.target.closest(".fx-stg");
      if (b) pick(b.dataset.stage);
    });
    tx.addEventListener("pointerover", (e) => {
      const m = e.target.closest(".fx-mech, .fx-pm-col");
      focus(m ? m.dataset.m : null);
    });
    tx.addEventListener("pointerleave", () => focus(null));
    const cur = $('.fx-stg[aria-pressed="true"]', tx);
    if (cur) pick(cur.dataset.stage);
  }
  if (REDUCED) return;

  const ins = $$(".fx-in", box);
  const outs = $$(".fx-out", box);
  const ring = $(".fx-ring", box);
  const tiles = $$(".fx-core i", box);
  const steps = $$(".fx-steps span", box);
  const later = (fn, ms) => {
    const id = setTimeout(() => { E.fxT.delete(id); fn(); }, ms);
    E.fxT.add(id);
  };
  const restart = (el, cls) => { el.classList.remove(cls); void el.offsetWidth; el.classList.add(cls); };
  /* A comet: four dots on one path, each a touch slower, so the tail stretches and lands together. */
  const shoot = (id, color, dur) => {
    const path = svg.querySelector(`#${id}`);
    if (!path) return;
    path.style.setProperty("--c", color);
    path.classList.add("on");
    const trail = [3.8, 2.8, 2, 1.3].map((r, k) =>
      `<circle class="fx-pulse" r="${r}" style="--c:${color};opacity:${(1 - k * 0.22).toFixed(2)}"><animateMotion dur="${(dur + k * 0.05).toFixed(2)}s" begin="indefinite" fill="freeze" calcMode="spline" keyTimes="0;1" keyPoints="0;1" keySplines="0.5 0 0.2 1"><mpath href="#${id}"/></animateMotion></circle>`).join("");
    svg.insertAdjacentHTML("beforeend", `<g>${trail}</g>`);
    const g = svg.lastElementChild;
    [...g.children].forEach((c) => c.firstElementChild.beginElement());
    later(() => { g.remove(); path.classList.remove("on"); }, dur * 1000 + 260);
  };
  let rot = 0;
  let step = -1;
  const receive = () => {
    rot += 40;
    ring.style.transform = `rotate(${rot}deg)`;
    restart(hub, "is-hit");
    hub.insertAdjacentHTML("beforeend", '<span class="fx-ripple"></span>');
    const rp = hub.lastElementChild;
    later(() => rp.remove(), 950);
    step = (step + 1) % FX_STEPS.length;
    const c = FX_STEPS[step][1];
    const lit = new Set([4]);
    while (lit.size < 3 + (step % 3)) lit.add(Math.floor(Math.random() * 9));
    tiles.forEach((t, k) => {
      t.style.setProperty("--c", lit.has(k) ? c : "var(--sev-none)");
      t.style.animationDelay = `${((k % 3) + Math.floor(k / 3)) * 35}ms`;
      restart(t, "pop");
    });
    steps.forEach((s, k) => s.classList.toggle("is-on", k === step));
  };
  const land = (el) => {
    restart(el, "is-on");
    later(() => el.classList.remove("is-on"), 1100);
  };
  const fire = (i, j) => {
    land(ins[i]);
    shoot(`fw-i${i}`, "var(--accent)", 0.75);
    later(receive, 720);
    const go = (jj, delay) => {
      later(() => shoot(`fw-o${jj}`, outs[jj].style.getPropertyValue("--c") || "var(--accent)", 0.8), delay);
      later(() => land(outs[jj]), delay + 760);
    };
    go(j, 860);
    if (i === 3) go((j + 2) % outs.length, 960);
  };
  let n = 0;
  const cycle = () => {
    if (!box.isConnected) {
      clearInterval(E.fxTimer);
      return;
    }
    if (!box.offsetParent || document.hidden) return;
    fire(n % ins.length, (n * 3 + 1) % outs.length);
    n++;
  };
  let lastHover = 0;
  ins.forEach((el, i) => el.addEventListener("pointerenter", () => {
    const now = performance.now();
    if (now - lastHover < 450) return;
    lastHover = now;
    fire(i, (i + 1) % outs.length);
  }));
  cycle();
  E.fxTimer = setInterval(cycle, 1400);
}
