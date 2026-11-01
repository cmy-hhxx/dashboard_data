/* 样本: recall list → input timeline → attribution / compact, with evidence → message links. */
import { $, $$, esc, fmt, compact, SEV, WORST, SEV_NAME, sevColor, KIND, segmented, getJSON, stack, bindTips, REDUCED } from "./core.js";

const ROLE = { planning: "规划", request_generation: "请求生成", tool: "工具执行", script: "脚本执行", skill: "技能装载", delivery: "交付" };
const FOLD_OPEN = new Set(["user", "answer"]);
const S = { product: null, all: [], rows: [], slug: null, D: null, trace: 0, open: new Set(), active: null, cache: new Map() };
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

export async function render(r, c) {
  ctx = c;
  root = r;
  const index = await c.loadIndex();
  const prod = index.products[c.product];
  if (S.product !== c.product || !$(".bench", root)) {
    S.product = c.product;
    S.all = prod ? prod.rows : [];
    S.prod = prod;
    S.slug = null;
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
  let slug = params().get("case");
  if (!slug || !S.all.some((x) => x.s === slug)) {
    slug = (S.rows[0] || S.all[0]).s;
    c.navigate({ case: slug }, { replace: true });
  }
  if (slug !== S.slug) await loadDetail(slug);
  markCurrent();
  const tab = params().get("tab") === "compact" ? "compact" : "attr";
  if (outSeg.get() !== tab) {
    outSeg.set(tab, { silent: true });
    renderOut();
  }
  const p = params().get("p");
  if (p != null && S.D) requestAnimationFrame(() => flash($(`#pc-${p}`, root)));
}

/* ---------------------------------------------------------------- skeleton & filters */
function skeleton() {
  root.innerHTML = `<div class="bench">
    <aside class="pane pane-sticky" aria-label="样本列表">
      <div class="pane-head">
        <input class="search" id="sq" type="search" placeholder="搜索提问、问题标签、任务" autocomplete="off">
        <div class="filters" id="sf"></div>
        <div class="list-meta"><span id="scount" class="num"></span>
          <select id="ssort" aria-label="排序"><option value="sev">严重度优先</option><option value="n">问题数</option><option value="date">日期新→旧</option></select></div>
      </div>
      <div class="pane-scroll" id="slist" tabindex="0" aria-label="样本"></div>
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
  });
  outSeg.set(params().get("tab") === "compact" ? "compact" : "attr", { silent: true });
  let timer;
  $("#sq", root).addEventListener("input", (e) => {
    clearTimeout(timer);
    timer = setTimeout(() => setFilter({ q: e.target.value.trim() }), 140);
  });
  $("#ssort", root).addEventListener("change", (e) => setFilter({ sort: e.target.value }));
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
  bindTips($("#sout", root), (t) => {
    if ((!t.closest(".cmap") && !t.closest(".cf-comps")) || !t.dataset.tip) return null;
    const i = t.dataset.tip.indexOf("|");
    return `<div style="font-weight:var(--w-medium);margin-bottom:4px">${esc(t.dataset.tip.slice(0, i))}</div><div style="max-width:300px;white-space:normal;line-height:1.6">${esc(t.dataset.tip.slice(i + 1))}</div>`;
  });
}

function setFilter(patch) {
  ctx.navigate(patch, { replace: true });
  syncFilters();
  renderList();
}

function syncFilters() {
  const f = F();
  const p = S.prod;
  $("#sq", root).value !== f.q && document.activeElement !== $("#sq", root) && ($("#sq", root).value = f.q);
  $("#ssort", root).value = f.sort;
  const btn = (k, v, label, color) =>
    `<button type="button" data-k="${k}" data-v="${esc(v)}" aria-pressed="${f[k] === v}"${color ? ` style="--c:${color}"` : ""}>${color ? "<i></i>" : ""}${esc(label)}</button>`;
  const row = (cls, items) => `<div class="frow${cls ? ` ${cls}` : ""}">${items}</div>`;
  let html = row("sev", WORST.map((w, i) => btn("w", w, SEV_NAME[w], sevColor(i))).join(""));
  if (p.splits.length > 1) html += row("", p.splits.map((s) => btn("split", s.id, s.label)).join(""));
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
  S.rows = S.all.filter(
    (r) =>
      (!f.w || r.w === f.w) && (!f.split || r.sp === f.split) && (!f.model || r.m === f.model) &&
      (!f.stage || r.st.includes(f.stage)) &&
      (!f.mech || r.pt.some((x) => {
        const [s, m] = x.split(".");
        return m === f.mech && (!f.stage || s === f.stage);
      })) &&
      (!f.pattern || r.pt.some((x) => x === f.pattern || x.startsWith(f.pattern + "."))) &&
      (!needle || r.q.toLowerCase().includes(needle) || r.lb.toLowerCase().includes(needle) || (r.task || "").includes(f.q) || (r.skill || "").includes(f.q) || r.s === f.q),
  );
  if (f.sort === "n") S.rows = S.rows.slice().sort((a, b) => b.n - a.n);
  if (f.sort === "date") S.rows = S.rows.slice().sort((a, b) => (a.d < b.d ? 1 : -1));
  const label = (id) => (S.prod.models.find((m) => m.id === id) || { label: id }).label;
  $("#scount", root).textContent = `${fmt(S.rows.length)} / ${fmt(S.all.length)} 个会话`;
  $("#slist", root).innerHTML = S.rows.length
    ? S.rows
        .map(
          (r) => `<button type="button" class="srow" data-s="${r.s}" style="--c:${sevColor(r.w)}" aria-current="${r.s === S.slug}">
      <span class="bar"></span><span><span class="q">${esc(r.q || "（无提问）")}</span>
      <span class="m num"><span>${esc(label(r.m))}${S.prod.splits.length > 1 ? ` · ${r.sp === "lost" ? "流失" : "日常"}` : ""}</span><span>${r.d.slice(5)}</span><span>${r.n ? `${r.w} · ${r.n} 个问题` : "无问题"}</span></span></span></button>`,
        )
        .join("")
    : `<div class="empty">没有符合条件的会话<br><button type="button" class="link" id="sclear">清除筛选</button></div>`;
  const clear = $("#sclear", root);
  clear && clear.addEventListener("click", () => setFilter({ q: "", w: "", split: "", model: "", stage: "", mech: "", pattern: "" }));
}

function markCurrent() {
  $$(".srow", root).forEach((b) => b.setAttribute("aria-current", String(b.dataset.s === S.slug)));
  const cur = $(`.srow[data-s="${S.slug}"]`, root);
  if (cur) {
    const list = $("#slist", root);
    const r = cur.getBoundingClientRect();
    const lr = list.getBoundingClientRect();
    if (r.top < lr.top || r.bottom > lr.bottom) cur.scrollIntoView({ block: "nearest" });
  }
}

/* ---------------------------------------------------------------- detail */
async function loadDetail(slug) {
  S.slug = slug;
  $("#sin", root).innerHTML = `<div class="empty">正在读取样本…</div>`;
  let D = S.cache.get(slug);
  if (!D) {
    try {
      D = await getJSON(`samples/${slug}.json`);
    } catch (e) {
      $("#sin", root).innerHTML = `<div class="empty">样本详情读取失败（${esc(e.message)}）。运行 local_dev/refresh.sh 重新生成。</div>`;
      $("#sout", root).innerHTML = "";
      return;
    }
    S.cache.set(slug, D);
    if (S.cache.size > 24) S.cache.delete(S.cache.keys().next().value);
  }
  if (S.slug !== slug) return;
  index(D);
  S.D = D;
  S.trace = 0;
  S.open = new Set();
  S.active = null;
  renderIn();
  renderOut();
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
  const facts = [
    S.prod.splits.length > 1 ? (D.split === "lost" ? "流失用户" : "日常评测") : null, label, D.date,
    m.task, m.subtask, m.difficulty, m.skill, m.mode,
    m.tokens_in ? `${compact((m.tokens_in || 0) + (m.tokens_out || 0))} tokens` : null,
    m.finish_ms ? `${fmt(m.finish_ms / 1000, 1)} s` : null,
  ].filter(Boolean);
  const ids = [["会话 ID", D.ids.session], ["Trace ID", D.ids.trace], ["Case ID", D.ids.case]].filter((x) => x[1]);
  const traces = D.input.traces;
  $("#sin", root).innerHTML = `<div class="sample-head">
      <h2>${esc(D.question || "（无提问）")}</h2>
      ${D.question_zh && D.question_zh !== D.question ? `<div class="zh">${esc(D.question_zh)}</div>` : ""}
      <div class="chips">${facts.map((x) => `<span class="pill">${esc(x)}</span>`).join("")}</div>
      <div class="chips">${ids.map(([k, v]) => `<button type="button" class="copy" data-copy="${esc(v)}">复制${k}</button>`).join("")}</div>
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
  const timed = msgs.filter((m) => m.at != null && m.dur != null && (m.k === "llm" || m.k === "call"));
  if (timed.length < 2) return "";
  const end = Math.max(...timed.map((m) => m.at + m.dur), 1);
  const bars = timed
    .map((m) => `<span class="k-${m.k}" style="left:${(100 * m.at) / end}%;width:${Math.max(0.4, (100 * m.dur) / end)}%;top:${m.k === "llm" ? 8 : 20}px"></span>`)
    .join("");
  return `<div class="waterfall" title="模型 / 工具调用时间轴 · 共 ${fmt(end / 1000, 1)} s">${bars}</div>
    <div class="hist-axis num"><span>0 s</span><span>模型 ▬ 上 · 工具 ▬ 下</span><span>${fmt(end / 1000, 1)} s</span></div>`;
}

function msgHTML(t, i, m) {
  const D = S.D;
  const key = `${t}:${i}`;
  const folded = !FOLD_OPEN.has(m.k) && !S.open.has(key);
  const sevs = [...new Set((m.ev || []).map((e) => D._ix.sev.get(e)).filter(Boolean))].sort();
  const blocks = m.blocks
    .map((b, bi) => {
      const lab = b.l === "think" ? "思考" : b.l && b.l.startsWith("call:") ? `→ ${b.l.slice(5)}` : "";
      return `${lab ? `<span class="blk-label">${esc(lab)}</span>` : ""}<div class="blk${b.f === "json" ? " json" : ""}">${pieces(t, i, bi, b)}</div>`;
    })
    .join("");
  const time = m.dur != null ? `<span class="num">${m.dur >= 1000 ? fmt(m.dur / 1000, 1) + " s" : m.dur + " ms"}</span>` : "";
  return `<div class="msg k-${m.k}${folded ? " is-folded" : ""}" id="m-${t}-${i}" data-key="${key}">
    <span class="msg-dot" aria-hidden="true"></span>
    <div class="msg-body"><div class="msg-top"><span class="who">${KIND[m.k] || m.k}</span><span class="num faint">#${i}</span>
      ${m.name ? `<span>${esc(m.name)}</span>` : ""}${m.model ? `<span class="faint">${esc(m.model)}</span>` : ""}${time}
      <span class="evs">${sevs.map((s) => `<i style="--c:${sevColor(s)}" title="${s} 证据"></i>`).join("")}</span>
      ${FOLD_OPEN.has(m.k) ? "" : `<button type="button" class="toggle" data-fold="${key}">${folded ? "展开" : "收起"}</button>`}</div>
      ${blocks}</div></div>`;
}

function pieces(t, mi, bi, b) {
  const D = S.D;
  const ids = (D._ix.byBlock.get(`${t}:${mi}:${bi}`) || []).filter((e) => D.evidence[e].src === "attr" || e === S.active);
  const marks = ids.map((e) => ({ e, s: D.evidence[e].o[0], z: D.evidence[e].o[1], src: D.evidence[e].src }));
  let pos = 0;
  let out = "";
  for (const x of b.x) {
    if (typeof x !== "string") {
      out += `<span class="gap">··· 省略 ${fmt(x.g)} 字 ···</span>`;
      pos += x.g;
      continue;
    }
    const len = x.length;
    const cuts = new Set([0, len]);
    marks.forEach((k) => {
      if (k.s < pos + len && k.z > pos) {
        cuts.add(Math.max(0, k.s - pos));
        cuts.add(Math.min(len, k.z - pos));
      }
    });
    const cs = [...cuts].sort((a, c) => a - c);
    for (let j = 0; j < cs.length - 1; j++) {
      const a = cs[j];
      const z = cs[j + 1];
      const seg = esc(x.slice(a, z));
      const cover = marks.filter((k) => k.s <= pos + a && k.z >= pos + z);
      if (!cover.length) {
        out += seg;
        continue;
      }
      const cx = cover.find((k) => k.src === "compact");
      const attr = cover.filter((k) => k.src === "attr");
      out += cx
        ? `<mark class="cx" data-e="${cx.e}">${seg}</mark>`
        : `<mark class="ev" data-e="${attr.map((k) => k.e).join(" ")}" style="--c:${sevColor(D._ix.sev.get(attr[0].e))}">${seg}</mark>`;
    }
    pos += len;
  }
  return out;
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
    S.trace = Number(tab.dataset.t);
    renderTrace();
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
    renderTrace();
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
}

const evAt = (ev, multi) => (ev.m == null ? "未定位" : `${multi ? `${ev.t + 1}·` : ""}#${ev.m}`);

function attrHTML(D) {
  const A = D.attribution;
  const multi = D.input.traces.length > 1;
  const counts = SEV.map((s) => A.problems.filter((p) => p.sev === s).length);
  const tax = ctx.data.taxonomy;
  const card = (p) => {
    const pat = p.cl && tax && tax.patterns[p.cl.path];
    const evs = p.ev
      .map((e) => {
        const ev = D.evidence[e];
        return `<button type="button" class="evbtn" data-e="${e}"${ev.m == null ? " disabled" : ""}><span class="at">${evAt(ev, multi)}</span><span class="qt">${esc(ev.q)}</span>${ev.r ? `<span class="rs">${esc(ev.r)}</span>` : ""}</button>`;
      })
      .join("");
    return `<article class="pcard" id="pc-${p.id}" style="--c:${sevColor(p.sev)}">
      <div class="chips"><span class="pill sevpill" style="--c:${sevColor(p.sev)}">${p.sev || "—"}</span><span class="pill">${esc(ROLE[p.role] || p.role || "—")}</span>
        ${p.cl ? `<button type="button" class="pill" data-pattern="${p.cl.path}" title="${esc((pat && pat.plain) || "")}"><span class="mono">${p.cl.path}</span>${esc(pat ? pat.name : "")}</button>` : `<span class="pill faint">未聚类</span>`}</div>
      <h3>${esc(p.label)}</h3>
      <div class="path"><b>${esc(p.fam || "—")}</b><span class="faint">›</span><span>${esc(p.comp || "—")}</span></div>
      <dl>${p.ph ? `<dt>现象</dt><dd>${esc(p.ph)}</dd>` : ""}${p.why ? `<dt>原因</dt><dd>${esc(p.why)}</dd>` : ""}${
        p.sevr ? `<dt>定级理由</dt><dd>${esc(p.sevr)}</dd>` : ""}${p.calc && p.calc.length ? `<dt>核算</dt><dd class="mono">${p.calc.map(esc).join("<br>")}</dd>` : ""}</dl>
      <div class="evlist">${evs}</div></article>`;
  };
  const order = (ids) => ids.map((i) => A.problems[i]).sort((a, b) => SEV.indexOf(a.sev) - SEV.indexOf(b.sev));
  let body = "";
  A.turns.forEach((t) => (body += order(t.problems).map(card).join("")));
  if (A.session_problems.length) body += order(A.session_problems).map(card).join("");
  return `${A.summary ? `<p class="summary">${esc(A.summary)}</p>` : ""}
    <div>${stack(counts, { tall: true, title: "问题严重度构成" })}
      <div class="legend" style="margin-top:8px;gap:4px 12px">${SEV.map((s, i) => `<span class="sev" style="--c:${sevColor(i)}"><i></i>${s}<b class="num">${counts[i]}</b></span>`).join("")}</div></div>
    ${body || `<div class="empty">归因没有记下问题</div>`}`;
}

function compactHTML(D) {
  const C = D.compact;
  if (!C) return `<div class="empty">这一组没有 compact 输出</div>`;
  const multi = D.input.traces.length > 1;
  let html = C.overview.length ? `<ol class="overview">${C.overview.map((x) => `<li>${esc(x)}</li>`).join("")}</ol>` : "";
  C.turns.forEach((t) => {
    // Every compact item sits where its evidence sits in the trace: the flow is the session itself.
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
        const tag = !k || nodes[k - 1].cls !== n.cls ? `<span class="cf-tag">${n.name}</span>` : "";
        const refs = n.ev.length > 1 ? `<span class="refs">${n.ev.map((e) => `<button type="button" data-e="${e}">${evAt(D.evidence[e], multi)}</button>`).join("")}</span>` : "";
        return `<div class="cf ${n.cls}" id="cf-${t.turn}-${k}"${n.ev.length ? ` data-e="${n.ev[0]}"` : ""}><span class="cf-at num">${at(n.pos)}</span><span class="cf-dot"></span>
          <div class="cf-body">${tag}<span class="cf-text">${esc(n.x.c)}</span>${refs}</div></div>`;
      })
      .join("");
    html += `${flowMap(nodes, t.turn, at)}<div class="cflow">${flow}</div>${componentRail(t.components || [], D, at)}`;
  });
  return html;
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

/* Components as a small span chart: one bar per component from its first to last evidence message. */
const COMP_KIND = { model: ["模型", "var(--t1)"], tool: ["工具", "var(--accent)"], script: ["脚本", "var(--t2)"], skill: ["技能", "var(--t3)"] };
const COMP_ORDER = ["model", "tool", "script", "skill"];
function componentRail(list, D, at) {
  const items = list
    .map((x) => {
      const ev = (x.ev || []).filter((e) => D.evidence[e] && D.evidence[e].m != null);
      const ms = ev.map((e) => D.evidence[e].m);
      return { x, ev, first: ms.length ? Math.min(...ms) : null, last: ms.length ? Math.max(...ms) : null, kind: COMP_KIND[x.kind] ? x.kind : null };
    })
    .filter((x) => x.first != null);
  if (!items.length) return "";
  const lo = Math.min(...items.map((x) => x.first));
  const hi = Math.max(...items.map((x) => x.last));
  const span = Math.max(1, hi - lo + 1);
  const keys = COMP_ORDER.filter((k) => items.some((x) => x.kind === k))
    .map((k) => `<span><i style="--c:${COMP_KIND[k][1]}"></i>${COMP_KIND[k][0]} ${items.filter((x) => x.kind === k).length}</span>`)
    .join("");
  const rows = items
    .sort((a, b) => a.first - b.first || a.last - b.last)
    .map((x) => {
      const [label, c] = COMP_KIND[x.kind] || [x.x.kind || "", "var(--t3)"];
      const left = (100 * (x.first - lo)) / span;
      const width = Math.max(1.4, (100 * (x.last - x.first + 1)) / span);
      const base = String(x.x.name).split("/").filter(Boolean).pop() || x.x.name;
      return `<button type="button" class="cf-comp" style="--c:${c}" data-e="${x.ev[0]}" data-tip="${esc(x.x.name)}|${esc(label)} · ${x.ev.length} 处证据 · ${at(x.first) || "—"}${x.x.c ? ` — ${esc(x.x.c)}` : ""}">
        <i class="mk"></i><span class="nm">${esc(base)}</span>
        <span class="bar"><i style="left:${left.toFixed(2)}%;width:${width.toFixed(2)}%"></i></span></button>`;
    })
    .join("");
  return `<div class="cf-comps"><div class="cf-keys">${keys}</div>${rows}</div>`;
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
