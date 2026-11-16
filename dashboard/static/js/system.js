/* 评测体系: how a session becomes compact + attribution + clusters, told with the real batch. */
import {
  $, $$, esc, fmt, pct, SEV, sevColor, KIND,
  bindTips, REDUCED,
} from "./core.js";
import { threadFlow } from "./particles.js";

let shown = null;

const ROLE = { planning: "规划", request_generation: "请求生成", tool: "工具执行", script: "脚本执行", skill: "技能装载", delivery: "交付" };

const E = { product: null, goldens: [], index: 0, obs: null, flow: null };

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

  const prods = Object.values(d.products || {});
  if (!prods.length) {
    root.innerHTML = `<div class="bento"><div class="card" style="--span:12"><div class="empty">暂无评测数据。</div></div></div>`;
    return;
  }

  const src = d.system && d.system.goldens;
  let picked = [];
  if (Array.isArray(src)) picked = src;
  else if (src) picked = src[c.product] || [];
  if (E.product !== c.product) E.index = 0;
  E.product = c.product;
  E.goldens = (Array.isArray(picked) ? picked : picked ? [picked] : []).map(compactAnatomy);
  if (E.index >= E.goldens.length) E.index = 0;

  root.innerHTML = `<div class="bento">
    ${flowCard(d.taxonomy, (d.products || {})[c.product])}
    ${goldenCard(E.goldens, E.index)}
  </div>`;
  if (!root._sysTips) {
    root._sysTips = true;
    bindTips(root);
  }
  wireGoldens(root);
  renderMeta(root, E.goldens[E.index]);
  wireAnatomy(root, E.goldens[E.index]);
  wireFx(root, d.taxonomy);
}

/* ---------------------------------------------------------------- 评测体系: one mechanism diagram */
const FX_IN = [
  ["user", "用户提问", "原始问句与追问"],
  ["think", "模型思考", "推理、规划与自我修正"],
  ["call", "工具调用", "参数、返回与报错"],
  ["answer", "最终回答", "交给用户的结论"],
];
const FX_STEPS = [["规划", "var(--t0)"], ["推理", "var(--t2)"], ["执行", "var(--accent)"], ["报错", "var(--sev-1)"], ["反思", "var(--t2)"], ["关键数据", "var(--t1)"], ["产物", "var(--t1)"]];
const FX_OUT = [
  ["问题", "标签与现象", "只记能回到原文的问题", "var(--sev-1)"],
  ["定级", "P0 最重 → P4 最轻", "按对用户的影响", "var(--sev-0)"],
  ["证据", "原文引用 → 消息位置", "逐字回链原文", "var(--accent)"],
  ["归属", "组件与环节角色", "交给聚类归入模式", "var(--t1)"],
];
const taxoNum = (a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1));
const patNum = (id) => id.split(".").map((x) => Number(x.replace(/\D/g, "")) || 0);

/* Each stage's real volume for the current product, next to its name. */
const fig = (text) => (text ? `<span class="fx-fig num">${text}</span>` : "");

function flowCard(tax, p) {
  const k = (p && p.kpi) || null;
  const ticks = Array.from({ length: 60 }, (_, k) => {
    const c = k % 9 === 0 ? FX_STEPS[(k / 9) % FX_STEPS.length][1] : "";
    const a = (k * Math.PI) / 30;
    const r0 = c ? 63 : 67;
    const [x0, y0, x1, y1] = [Math.cos(a) * r0, Math.sin(a) * r0, Math.cos(a) * 74, Math.sin(a) * 74].map((v) => v.toFixed(1));
    return `<line x1="${x0}" y1="${y0}" x2="${x1}" y2="${y1}"${c ? ` class="c" style="--c:${c}"` : ""}/>`;
  }).join("");
  const tiles = [2, 9, 0, 9, 2, 9, 9, 4, 9].map((v) => `<i style="--c:${v < 5 ? `var(--sev-${v})` : "var(--sev-none)"}"></i>`).join("");
  const ins = FX_IN.map(([k, t, sub]) =>
    `<div class="fx-box fx-in k-${k}" title="${sub}"><i class="fx-dot"></i><span class="fx-txt"><b>${t}</b></span></div>`).join("");
  const outs = FX_OUT.map(([t, sub, rule, c], i) => {
    // 定级's scale is a label; the other boxes keep their gloss in the title.
    const label = i === 1 ? `<small>${sub}</small>` : "";
    const ico = i === 1
      ? `<span class="fx-ico is-sev">${SEV.map((_, k) => `<i style="--c:${sevColor(k)};--k:${k}"></i>`).join("")}</span>`
      : `<span class="fx-ico"><i></i></span>`;
    return `<div class="fx-box fx-out" style="--c:${c}" title="${sub} · ${rule}">${ico}<span class="fx-txt"><b>${t}</b>${label}</span></div>`;
  }).join("");
  const taxHTML = tax ? `<div class="fx-tax" id="fxTax">
      <div class="fx-label"><span class="num">04</span>聚类${fig(k && p.patterns && `${fmt(p.patterns.length)} 个模式 · 覆盖 ${pct(k.clustered, k.problems)} 问题`)}</div>
      ${taxGrid(tax)}
      <div class="fx-pm" id="fxDetail"></div></div>` : "";
  return `<article class="card" style="--span:12">
    <header class="card-head"><h2>评测体系</h2></header>
    <div class="fx" id="fx"><svg class="fx-wires" aria-hidden="true"></svg>
      <div class="fx-col"><div class="fx-label"><span class="num">01</span>会话输入${fig(k && `${fmt(k.unique_sessions)} 个会话 · ${fmt(k.messages)} 条消息`)}</div>${ins}</div>
      <div class="fx-col fx-mid"><div class="fx-label"><span class="num">02</span>Compact 压缩${fig(k && `${fmt(k.compacted)} 条轨迹`)}</div>
        <div class="fx-hubwrap">
          <div class="fx-hub"><span class="fx-orbit"><i></i></span><svg class="fx-ring" viewBox="-80 -80 160 160" aria-hidden="true">${ticks}</svg><span class="fx-core"><span>${tiles}</span></span></div>
        </div></div>
      <div class="fx-col"><div class="fx-label"><span class="num">03</span>归因${fig(k && `${fmt(k.problems)} 个问题 · ${pct(k.located, k.evidence)} 证据可定位`)}</div>${outs}</div>
    </div>${taxHTML}</article>`;
}

/* The taxonomy is one grid: 环节 (rows, grouped by phase) × 机制 (columns); a cell is the number
   of L3 patterns filed there. A cell, a row head or a column head opens its patterns below. */
const l3 = (tax) => Object.entries(tax.patterns).filter(([id]) => id.split(".").length === 3);
function taxGrid(tax) {
  const stages = tax.stages.slice().sort(taxoNum);
  const mechs = tax.mechanisms.slice().sort(taxoNum);
  const pats = l3(tax);
  const n = (sid, mid) => pats.filter(([id]) => id.startsWith(`${sid}.${mid}.`)).length;
  const max = Math.max(1, ...stages.flatMap((st) => mechs.map((m) => n(st.id, m.id))));
  const head = `<span class="fx-g-corner"></span><span></span>${mechs.map((m) =>
    `<button type="button" class="fx-g-col" data-m="${m.id}" title="${esc(m.def || "")}"><code>${m.id}</code>${esc(m.name)}</button>`).join("")}<span class="fx-g-sum">合计</span>`;
  let d = 0;
  const body = tax.phases.map((ph) => {
    const list = stages.filter((st) => st.phase === ph.id);
    if (!list.length) return "";
    return list.map((st, i) => {
      const total = pats.filter(([id]) => id.startsWith(`${st.id}.`)).length;
      return `${i === 0 ? `<span class="fx-g-ph" style="grid-row:span ${list.length}">${esc(ph.name)}</span>` : ""}<button type="button" class="fx-g-row" data-s="${st.id}" title="${esc(st.def || "")}"><code>${st.id}</code>${esc(st.name)}</button>${mechs.map((m) => {
        const v = n(st.id, m.id);
        return v
          ? `<button type="button" class="fx-g-c" data-s="${st.id}" data-m="${m.id}" style="--a:${Math.round(14 + (70 * v) / max)}%;--d:${d++}" aria-label="${esc(`${st.name} × ${m.name}：${v} 个模式`)}">${v}</button>`
          : `<span class="fx-g-c is-empty" data-s="${st.id}" data-m="${m.id}"></span>`;
      }).join("")}<span class="fx-g-sum num">${total || ""}</span>`;
    }).join("");
  }).join("");
  return `<div class="fx-g" style="--cols:${mechs.length}">${head}${body}</div>`;
}

/* The patterns behind the picked cell / row / column, each with its full code. */
function patternList(tax, sid, mid) {
  const st = sid && tax.stages.find((x) => x.id === sid);
  const m = mid && tax.mechanisms.find((x) => x.id === mid);
  const pats = l3(tax)
    .filter(([id]) => (!sid || id.startsWith(`${sid}.`)) && (!mid || id.split(".")[1] === mid))
    .sort((a, b) => { const pa = patNum(a[0]); const pb = patNum(b[0]); return pa[0] - pb[0] || pa[1] - pb[1] || pa[2] - pb[2]; });
  const name = [st && st.name, m && m.name].filter(Boolean).join(" × ");
  return `<div class="fx-pm-side"><b>${esc(name)}</b><span class="fx-pm-n num">${pats.length} 个模式</span></div>
    <div class="fx-pm-items">${pats.map(([id, pt], i) => `<div class="fx-pat" style="--d:${i}" title="${esc(pt.plain || "")}"><code>${id}</code><span>${esc(pt.name || id)}</span></div>`).join("") || '<span class="dim">暂无模式</span>'}</div>`;
}

/* ---------------------------------------------------------------- evidence closure */

const ICON_PREV = `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M15 5 8 12l7 7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const ICON_NEXT = `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M9 5l7 7-7 7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

function goldenCard(cases, index) {
  const a = cases[index];
  const control = cases.length > 1
    ? `<span class="meta-end end">
        <span class="meta num" id="eIndex">${index + 1} / ${fmt(cases.length)}</span>
        <button type="button" class="icon-btn" id="ePrev" aria-label="上一条">${ICON_PREV}</button>
        <button type="button" class="icon-btn" id="eNext" aria-label="下一条">${ICON_NEXT}</button>
      </span>`
    : "";
  return `<article class="card" style="--span:12">
    <header class="card-head"><h2>证据闭环</h2><span class="meta" id="eMeta"></span>${control}</header>
    ${a ? `<div class="echo"><div class="echo-main"><div id="anatomyBody">${anatomyBody(a)}</div></div></div>` : `<div class="empty">暂无 golden case。</div>`}
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
        <div class="t">${esc(p.label)}</div><div class="s">${esc(p.comp || "")}${(p.msgs || []).length ? ` · ${p.msgs.map((m) => `#${m}`).join(" ")}` : ""}</div></div>`,
    )
    .join("");
  return `<div class="anatomy${a.messages.length >= 12 ? " is-fill" : ""}">
    <div class="rail">${msgs}</div>
    <div class="threads"><svg aria-hidden="true"></svg></div>
    <div class="aprobs${a.problems.length >= 4 ? " is-spread" : ""}">${probs}</div>
  </div>`;
}

const roleName = (r) => ROLE[r] || r || "—";

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

function showCase(root) {
  const a = E.goldens[E.index];
  const body = $("#anatomyBody", root);
  if (!a || !body) return;
  body.innerHTML = anatomyBody(a);
  body.scrollTop = 0;
  renderMeta(root, a);
  wireAnatomy(root, a);
  const index = $("#eIndex", root);
  if (index) index.textContent = `${E.index + 1} / ${fmt(E.goldens.length)}`;
}

function wireGoldens(root) {
  if (E.goldens.length < 2) return;
  const go = (step) => {
    E.index = (E.index + step + E.goldens.length) % E.goldens.length;
    showCase(root);
  };
  const prev = $("#ePrev", root);
  const next = $("#eNext", root);
  if (prev) prev.addEventListener("click", () => go(-1));
  if (next) next.addEventListener("click", () => go(1));
}

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
  if (E.flow) E.flow.destroy();
  E.flow = threadFlow($(".threads svg", box));

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
    const pick = (sid, mid) => {
      $$(".fx-g-c, .fx-g-row, .fx-g-col", tx).forEach((x) => {
        const on = (x.classList.contains("fx-g-row") ? !mid && x.dataset.s === sid
          : x.classList.contains("fx-g-col") ? !sid && x.dataset.m === mid
            : (!sid || x.dataset.s === sid) && (!mid || x.dataset.m === mid));
        x.classList.toggle("is-on", on);
      });
      $("#fxDetail", tx).innerHTML = patternList(tax, sid, mid);
    };
    tx.addEventListener("click", (e) => {
      const b = e.target.closest("button.fx-g-c, .fx-g-row, .fx-g-col");
      if (b) pick(b.dataset.s || null, b.dataset.m || null);
    });
    // Hovering a cell lights its row and column heads, so the two axes read as one coordinate.
    tx.addEventListener("pointerover", (e) => {
      const c = e.target.closest(".fx-g-c");
      $$(".fx-g-row", tx).forEach((x) => x.classList.toggle("is-hl", !!c && x.dataset.s === c.dataset.s));
      $$(".fx-g-col", tx).forEach((x) => x.classList.toggle("is-hl", !!c && x.dataset.m === c.dataset.m));
    });
    const first = $("button.fx-g-c", tx);
    if (first) pick(first.dataset.s, null);
  }
  if (REDUCED) return;

  const ins = $$(".fx-in", box);
  const outs = $$(".fx-out", box);
  const ring = $(".fx-ring", box);
  const tiles = $$(".fx-core i", box);
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
