/* 证据闭环, full screen. One golden case is played as a derivation the reader can follow step by
   step: the problem the evaluator filed → the sentences it quoted → the messages those sentences
   come from (a line runs from each quote to its message, and the sentence lights up inside it) →
   the phenomenon it derived and the cluster pattern it was filed under. The whole trajectory stays
   on the left the entire time, so every claim on the right can be checked against the original. */
import { $, $$, esc, fmt, SEV, sevColor, SEV_NAME, KIND, REDUCED } from "./core.js";

const STEPS = [
  ["问题", "评测器的结论：哪里出了问题、有多严重"],
  ["证据引用", "它为这个结论摘下的原话"],
  ["原始消息", "每句原话回到轨迹里的那条消息"],
  ["推导出的现象", "从这些原文推出的现象，和它归入的聚类模式"],
];
const ROLE = { planning: "规划", request_generation: "请求生成", tool: "工具执行", script: "脚本执行", skill: "技能装载", delivery: "交付" };
const PLAY_MS = 2400;
const ICON = {
  close: '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
  prev: '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M10 4L6 8l4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  next: '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M6 4l4 4-4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  play: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 3.5v9l7.5-4.5z" fill="currentColor"/></svg>',
  pause: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="4" y="3.5" width="2.6" height="9" rx="1" fill="currentColor"/><rect x="9.4" y="3.5" width="2.6" height="9" rx="1" fill="currentColor"/></svg>',
  go: '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M6 4l4 4-4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

const T = { el: null, cases: [], ci: 0, pi: 0, step: 0, playing: false, timer: 0, raf: 0, opts: null, back: null, obs: null };

const sevChip = (s) => `<span class="et-sev" style="--c:${sevColor(s)}"><i></i>${esc(s || "—")}${SEV_NAME[s] && SEV_NAME[s] !== s ? `<small>${esc(SEV_NAME[s])}</small>` : ""}</span>`;
const order = (ps) => ps.slice().sort((a, b) => SEV.indexOf(a.sev) - SEV.indexOf(b.sev));
const norm = (s) => String(s || "").replace(/\s+/g, "").replace(/[…。]+$/, "");

/* Where a quote sits inside a message's text: the longest leading run of the quote that the text
   contains. Quotes and the rail are both clipped, so a prefix match is the honest test. */
function locate(text, quote) {
  const hay = String(text || "");
  const q = String(quote || "").replace(/…$/, "").trim();
  if (!hay || !q) return null;
  for (let n = Math.min(q.length, 160); n >= 8; n = Math.floor(n * 0.7)) {
    const at = hay.indexOf(q.slice(0, n));
    if (at >= 0) return [at, at + n];
  }
  const flat = norm(q).slice(0, 12);
  const at = flat.length >= 6 ? hay.replace(/\s+/g, "").indexOf(flat) : -1;
  return at >= 0 ? [at, at + flat.length] : null;
}

function marked(text, spans) {
  if (!spans.length) return esc(text);
  const cuts = spans.slice().sort((a, b) => a[0] - b[0]);
  let out = "";
  let at = 0;
  cuts.forEach(([s, e, k]) => {
    if (s < at) return;
    out += `${esc(text.slice(at, s))}<mark data-q="${k}">${esc(text.slice(s, e))}</mark>`;
    at = e;
  });
  return out + esc(text.slice(at));
}

/* ---------------------------------------------------------------- the case in hand */
function current() {
  const a = T.cases[T.ci];
  const probs = order(a.problems || []);
  return { a, probs, p: probs[T.pi] };
}

/* The problem as the reader sees it: golden fields first, the full detail (when it arrived) adds
   the phenomenon, the reasoning, the grading reason and any quotes the golden payload clipped. */
function enrich(a, p) {
  const d = T.opts.details.get(a.slug);
  const full = d && d.value && (d.value.attribution?.problems || []).find((x) => x.id === p.id);
  const evidence = (d && d.value && d.value.evidence) || [];
  let quotes = (p.ev || []).filter((e) => e.q).map((e) => ({ m: e.m, q: e.q }));
  if (full && (full.ev || []).length) {
    const rich = full.ev.map((k) => evidence[k]).filter((e) => e && e.q).map((e) => ({ m: e.m, q: e.q, r: e.r, c: e.c }));
    if (rich.length) quotes = rich;
  }
  return {
    quotes: quotes.slice(0, 6),
    ph: full && full.ph,
    why: full && full.why,
    sevr: full && full.sevr,
    def: full && full.def,
    tags: (full && full.cl && full.cl.tags) || [],
    loading: !!d && !d.done,
  };
}

/* ---------------------------------------------------------------- markup */
function railHTML(a, cited) {
  return a.messages.map((m, i) => {
    const idx = m.i == null ? i : m.i;
    const c = cited.get(idx);
    const text = c ? (m.full || m.text || "") : (m.text || "");
    const spans = c ? c.map((k) => { const at = locate(text, k.q); return at ? [at[0], at[1], k.k] : null; }).filter(Boolean) : [];
    return `<article class="et-msg k-${esc(m.k)}${c ? " is-cited" : ""}" data-m="${idx}">
      <header><span class="kind k-${esc(m.k)}">${esc(KIND[m.k] || m.k)}</span><span class="num">#${idx}</span>${m.name ? `<code>${esc(m.name)}</code>` : ""}</header>
      <p>${marked(text, spans)}</p></article>`;
  }).join("");
}

function pathHTML(path) {
  const tax = T.opts.tax;
  if (!path) return '<span class="dim">这个问题没有进入聚类</span>';
  const [sid, mid] = path.split(".");
  const st = tax && tax.stages.find((x) => x.id === sid);
  const m = tax && tax.mechanisms.find((x) => x.id === mid);
  const pt = tax && tax.patterns[path];
  const seg = (code, name, k) => `<span class="et-path-s" style="--k:${k}"><code>${esc(code)}</code>${esc(name || code)}</span>`;
  return `${seg(sid, st && st.name, 0)}<i aria-hidden="true">→</i>${seg(mid, m && m.name, 1)}<i aria-hidden="true">→</i>${seg(path, pt && pt.name, 2)}`;
}

function chainHTML(a, p, x) {
  const msgs = [...new Set(x.quotes.map((q) => q.m).filter((m) => m != null))].sort((u, v) => u - v);
  const node = (k, body) => {
    const state = k < T.step ? "is-done" : k === T.step ? "is-now" : "is-next";
    return `<li class="et-node ${state}" data-step="${k}"><span class="et-dot num">${k + 1}</span>
      <div class="et-node-h"><b>${STEPS[k][0]}</b><small>${STEPS[k][1]}</small></div>
      <div class="et-node-b">${k <= T.step ? body : ""}</div></li>`;
  };
  const role = ROLE[p.role] || p.role || "";
  const n0 = `<div class="et-claim">${sevChip(p.sev)}<b>${esc(p.label)}</b></div>
    <p class="et-sub">${[role && `环节角色：${esc(role)}`, p.comp && `组件：<code>${esc(p.comp)}</code>`].filter(Boolean).join(" · ")}</p>
    ${x.sevr ? `<p class="et-why"><em>为什么定 ${esc(p.sev)}</em>${esc(x.sevr)}</p>` : ""}`;
  const n1 = x.quotes.length
    ? `<ol class="et-qs">${x.quotes.map((q, k) => `<li class="et-q" data-q="${k}" data-m="${q.m == null ? "" : q.m}" style="--k:${k}">
        <span class="num">${q.m == null ? "—" : `#${q.m}`}</span><q>${esc(q.q)}</q>${q.r ? `<small>${esc(q.r)}</small>` : ""}</li>`).join("")}</ol>`
    : `<p class="et-sub">${x.loading ? "正在读取原文引用…" : "这条问题没有登记原文引用"}</p>`;
  const n2 = msgs.length
    ? `<p class="et-sub">${fmt(x.quotes.length)} 句原话落在 ${fmt(msgs.length)} 条消息上，左侧已高亮；连线指向原话所在的位置。</p>
       <div class="et-hops">${msgs.map((m) => {
         const msg = a.messages.find((y, i) => (y.i == null ? i : y.i) === m);
         return `<button type="button" class="et-hop" data-jump="${m}"><span class="kind k-${esc(msg ? msg.k : "")}">${esc(msg ? KIND[msg.k] || msg.k : "消息")}</span><span class="num">#${m}</span>${ICON.go}</button>`;
       }).join("")}</div>`
    : '<p class="et-sub">引用没有定位到具体消息</p>';
  const n3 = `<div class="et-ph">${x.ph ? `<p><em>现象</em>${esc(x.ph)}</p>` : `<p><em>现象</em>${esc(p.label)}</p>`}
      ${x.why ? `<p><em>推理</em>${esc(x.why)}</p>` : ""}
      ${x.def ? `<p><em>定义</em>${esc(x.def)}</p>` : ""}</div>
    <div class="et-path"><span class="et-path-k">聚类</span>${pathHTML(p.path)}</div>
    ${x.tags.length ? `<div class="et-tags">${x.tags.slice(0, 6).map((t) => `<span>${esc(t)}</span>`).join("")}</div>` : ""}`;
  return `<ol class="et-chain">${[n0, n1, n2, n3].map((b, k) => node(k, b)).join("")}</ol>`;
}

function shellHTML() {
  return `<div class="et-scrim" data-close></div>
  <div class="et-win" role="dialog" aria-modal="true" aria-labelledby="etTitle">
    <header class="et-top">
      <div class="et-title"><span class="et-k">证据闭环</span><b id="etTitle"></b><small id="etMeta"></small></div>
      <div class="et-cases" id="etCases"></div>
      <button type="button" class="et-icon" data-close aria-label="关闭（Esc）" title="关闭（Esc）">${ICON.close}</button>
    </header>
    <div class="et-body" id="etBody">
      <section class="et-rail" id="etRail" aria-label="消息轨迹"></section>
      <svg class="et-wires" id="etWires" aria-hidden="true"></svg>
      <section class="et-right">
        <nav class="et-probs" id="etProbs" aria-label="问题"></nav>
        <div class="et-chainbox" id="etChain"></div>
      </section>
    </div>
    <footer class="et-ctl">
      <div class="et-ctl-l"><span class="et-pos" id="etPos"></span></div>
      <div class="et-ctl-m">
        <button type="button" class="et-icon" data-act="prev" aria-label="上一步（←）" title="上一步（←）">${ICON.prev}</button>
        <button type="button" class="et-play" data-act="play" id="etPlay"></button>
        <button type="button" class="et-icon" data-act="next" aria-label="下一步（→）" title="下一步（→）">${ICON.next}</button>
      </div>
      <div class="et-ctl-r"><span class="et-keys"><kbd>←</kbd><kbd>→</kbd> 逐步 · <kbd>↑</kbd><kbd>↓</kbd> 换问题 · <kbd>空格</kbd> 播放 · <kbd>Esc</kbd> 关闭</span>
        <button type="button" class="et-link" data-act="trace" id="etTrace">完整轨迹${ICON.go}</button></div>
    </footer>
  </div>`;
}

/* ---------------------------------------------------------------- paint */
function paint(fresh) {
  const { a, probs, p } = current();
  const el = T.el;
  $("#etTitle", el).textContent = a.question || a.slug;
  $("#etMeta", el).textContent = [a.model, a.date, `${fmt(a.messages.length)} 条消息`, `${fmt(probs.length)} 个问题`].filter(Boolean).join(" · ");
  $("#etCases", el).innerHTML = T.cases.length > 1
    ? `<button type="button" class="et-icon" data-act="case-prev" aria-label="上一个案例" title="上一个案例">${ICON.prev}</button><span class="num">案例 ${T.ci + 1} / ${T.cases.length}</span><button type="button" class="et-icon" data-act="case-next" aria-label="下一个案例" title="下一个案例">${ICON.next}</button>`
    : "";
  $("#etProbs", el).innerHTML = probs.map((q, k) => `<button type="button" class="et-pb${k === T.pi ? " is-on" : ""}" data-pi="${k}" style="--c:${sevColor(q.sev)}" aria-pressed="${k === T.pi}"><i></i><span>${esc(q.label)}</span></button>`).join("");
  const x = enrich(a, p);
  const cited = new Map();
  if (T.step >= 2) {
    x.quotes.forEach((q, k) => {
      if (q.m == null) return;
      if (!cited.has(q.m)) cited.set(q.m, []);
      cited.get(q.m).push({ q: q.q, k });
    });
  }
  const rail = $("#etRail", el);
  const keep = fresh ? 0 : rail.scrollTop;
  rail.innerHTML = railHTML(a, cited);
  rail.scrollTop = keep;
  $("#etChain", el).innerHTML = chainHTML(a, p, x);
  $("#etPos", el).innerHTML = `问题 <b class="num">${T.pi + 1}</b> / ${probs.length} · 第 <b class="num">${T.step + 1}</b> 步 ${STEPS[T.step][0]}`;
  $("#etTrace", el).hidden = !(a.slug && T.opts.nav);
  playButton();
  if (T.step >= 2) {
    const first = $(".et-msg.is-cited", rail);
    if (first) first.scrollIntoView({ block: "center", behavior: REDUCED ? "auto" : "smooth" });
  }
  $(".et-node.is-now", el)?.scrollIntoView({ block: "nearest", behavior: REDUCED ? "auto" : "smooth" });
  wires(T.step === 2);
}

function playButton() {
  const b = $("#etPlay", T.el);
  b.innerHTML = `${T.playing ? ICON.pause : ICON.play}<span>${T.playing ? "暂停" : "自动播放"}</span>`;
  b.setAttribute("aria-pressed", String(T.playing));
  b.setAttribute("aria-label", T.playing ? "暂停（空格）" : "自动播放（空格）");
}

/* A line from each quote to the sentence it came from. Both columns scroll on their own, so the
   lines are redrawn on every scroll and resize; they only draw in when the step first opens. */
function wires(animate = false) {
  cancelAnimationFrame(T.raf);
  T.raf = requestAnimationFrame(() => {
    const el = T.el;
    if (!el) return;
    const svg = $("#etWires", el);
    const body = $("#etBody", el).getBoundingClientRect();
    svg.setAttribute("viewBox", `0 0 ${body.width} ${body.height}`);
    if (T.step < 2) { svg.innerHTML = ""; return; }
    const rail = $("#etRail", el).getBoundingClientRect();
    const right = $("#etChain", el).getBoundingClientRect();
    const { p } = current();
    let d = "";
    $$(".et-q", el).forEach((q) => {
      const m = q.dataset.m;
      if (m === "") return;
      const msg = $(`.et-msg[data-m="${m}"]`, el);
      if (!msg) return;
      const mark = $(`mark[data-q="${q.dataset.q}"]`, msg) || msg;
      const a = mark.getBoundingClientRect();
      const b = q.getBoundingClientRect();
      const clampY = (y, r) => Math.max(r.top + 4, Math.min(r.bottom - 4, y));
      const x0 = Math.min(a.right, rail.right) - body.left + 2;
      const y0 = clampY(a.top + Math.min(a.height, 22) / 2, rail) - body.top;
      const x1 = Math.max(b.left, right.left) - body.left - 2;
      const y1 = clampY(b.top + 14, right) - body.top;
      const mid = (x0 + x1) / 2;
      d += `<path pathLength="1" class="${animate ? "is-draw" : ""}" style="--c:${sevColor(p.sev)};--k:${q.dataset.q}" d="M${x0.toFixed(1)} ${y0.toFixed(1)}C${mid.toFixed(1)} ${y0.toFixed(1)} ${mid.toFixed(1)} ${y1.toFixed(1)} ${x1.toFixed(1)} ${y1.toFixed(1)}"/><circle r="3" cx="${x0.toFixed(1)}" cy="${y0.toFixed(1)}" style="--c:${sevColor(p.sev)}"/>`;
    });
    svg.innerHTML = d;
  });
}

/* ---------------------------------------------------------------- moving through the case */
function go(step, pi = T.pi, ci = T.ci) {
  const fresh = ci !== T.ci;
  T.ci = ci;
  T.pi = pi;
  T.step = step;
  const { a } = current();
  if (a.slug && !T.opts.details.has(a.slug)) {
    T.opts.details.set(a.slug, { done: false, value: null });
    T.opts.fetch(a.slug).then((v) => {
      T.opts.details.set(a.slug, { done: true, value: v });
      if (T.el && current().a.slug === a.slug) paint(false);
    });
  }
  paint(fresh);
}
function next() {
  const { probs } = current();
  if (T.step < STEPS.length - 1) return go(T.step + 1);
  if (T.pi < probs.length - 1) return go(0, T.pi + 1);
  stop();
  return null;
}
function prev() {
  if (T.step > 0) return go(T.step - 1);
  if (T.pi > 0) return go(STEPS.length - 1, T.pi - 1);
  return null;
}
function stop() {
  T.playing = false;
  clearInterval(T.timer);
  if (T.el) playButton();
}
function play() {
  if (REDUCED) return;
  const { probs } = current();
  if (T.step === STEPS.length - 1 && T.pi === probs.length - 1) go(0, 0);
  T.playing = true;
  clearInterval(T.timer);
  T.timer = setInterval(next, PLAY_MS);
  playButton();
}

/* ---------------------------------------------------------------- open / close */
function onKey(e) {
  if (!T.el) return;
  if (e.key === "Escape") { e.preventDefault(); close(); return; }
  if (e.key === "Tab") {
    const f = $$('button:not([hidden]), [href], [tabindex="0"]', T.el).filter((x) => x.offsetParent);
    if (!f.length) return;
    const [first, last] = [f[0], f[f.length - 1]];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    return;
  }
  const { probs } = current();
  const k = { ArrowRight: () => { stop(); next(); }, ArrowLeft: () => { stop(); prev(); },
    ArrowDown: () => { stop(); go(0, Math.min(probs.length - 1, T.pi + 1)); }, ArrowUp: () => { stop(); go(0, Math.max(0, T.pi - 1)); },
    " ": () => (T.playing ? stop() : play()) }[e.key];
  if (k && !e.target.closest("input, textarea")) { e.preventDefault(); k(); }
}

function onClick(e) {
  if (e.target.closest("[data-close]")) return close();
  const pb = e.target.closest("[data-pi]");
  if (pb) { stop(); return go(0, Number(pb.dataset.pi)); }
  const node = e.target.closest(".et-node.is-next, .et-node.is-done");
  if (node && !e.target.closest("button")) { stop(); return go(Number(node.dataset.step)); }
  const hop = e.target.closest("[data-jump]");
  if (hop) {
    const msg = $(`.et-msg[data-m="${hop.dataset.jump}"]`, T.el);
    msg?.scrollIntoView({ block: "center", behavior: REDUCED ? "auto" : "smooth" });
    msg?.classList.remove("is-ping");
    void msg?.offsetWidth;
    msg?.classList.add("is-ping");
    return null;
  }
  const act = e.target.closest("[data-act]")?.dataset.act;
  if (!act) return null;
  if (act === "prev") { stop(); return prev(); }
  if (act === "next") { stop(); return next(); }
  if (act === "play") return T.playing ? stop() : play();
  if (act === "case-prev" || act === "case-next") {
    stop();
    const n = T.cases.length;
    return go(0, 0, (T.ci + (act === "case-next" ? 1 : n - 1)) % n);
  }
  if (act === "trace") {
    const { a } = current();
    const nav = T.opts.nav;
    close();
    nav?.({ view: "samples", product: T.opts.product, case: a.slug, p: null, w: null, trace: null });
  }
  return null;
}

export function closeTheater() { close(); }

function close() {
  if (!T.el) return;
  stop();
  cancelAnimationFrame(T.raf);
  T.obs?.disconnect();
  document.removeEventListener("keydown", onKey, true);
  const el = T.el;
  T.el = null;
  document.documentElement.classList.remove("is-theater");
  const done = () => el.remove();
  if (REDUCED) done();
  else {
    el.classList.add("is-out");
    setTimeout(done, 260);
  }
  T.back?.focus?.({ preventScroll: true });
}

/* opts: { cases, index, problem (id), product, tax, nav, fetch(slug) → Promise, details: Map, from: Element } */
export function openTheater(opts) {
  if (!opts.cases.length) return;
  close();
  T.opts = opts;
  T.cases = opts.cases;
  T.back = document.activeElement;
  const el = document.createElement("div");
  el.className = "et";
  el.innerHTML = shellHTML();
  if (opts.from) {
    const r = opts.from.getBoundingClientRect();
    el.style.setProperty("--ox", `${r.left + r.width / 2}px`);
    el.style.setProperty("--oy", `${r.top + r.height / 2}px`);
  }
  document.body.appendChild(el);
  T.el = el;
  document.documentElement.classList.add("is-theater");
  el.addEventListener("click", onClick);
  document.addEventListener("keydown", onKey, true);
  const redraw = () => wires(false);
  $("#etRail", el).addEventListener("scroll", redraw, { passive: true });
  $("#etChain", el).addEventListener("scroll", redraw, { passive: true });
  T.obs = new ResizeObserver(redraw);
  T.obs.observe($("#etBody", el));
  const ci = Math.max(0, Math.min(opts.cases.length - 1, opts.index || 0));
  const probs = order(opts.cases[ci].problems || []);
  const pi = Math.max(0, probs.findIndex((p) => String(p.id) === String(opts.problem)));
  T.ci = -1;
  go(0, pi, ci);
  $(".et-top [data-close]", el).focus({ preventScroll: true });
  if (!REDUCED) play();
}
