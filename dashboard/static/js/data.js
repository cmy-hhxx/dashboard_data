/* 数据: 会话场 · 数据量 · 评测量 · 归因体系 · 聚类体系 · 预测体系 · 聚类矩阵. Titles only; the layout carries the rest.
   Only the cluster matrix opens samples; everything else drills in place. */
import { $, $$, esc, fmt, pct, compact, sum, WORST, SEV_NAME, sevColor, counter, runCounters, bindTips, REDUCED } from "./core.js";
import { sunburst } from "./sunburst.js";

let ctx;
let shown = null;
const RING = 168;
const SPLIT_SHORT = { daily: "日常", lost: "流失" };
const tone = (i) => `var(--t${Math.min(i, 4)})`;
const dot = (c) => `<i style="--c:${c}"></i>`;

export function render(root, c) {
  ctx = c;
  const p = c.data.products[c.product];
  const key = `${c.product}|${c.data.generated_at}`;
  if (shown === key && root.firstChild) return;
  shown = key;
  if (!p) {
    root.innerHTML = `<div class="bento"><article class="card" style="--span:12"><div class="empty">${
      c.product === "wencai" ? "问财" : "AIME"
    } 暂无评测数据。把数据放入 datasets/ 后运行 local_dev/refresh.sh。</div></article></div>`;
    return;
  }
  const tax = c.data.taxonomy;
  root.innerHTML = `<div class="bento">${fieldCard(p)}${volumeCard(p)}${evalCard(p)}${attrCard(p)}${clusterCard(tax)}${predictCard(p)}${matrixCard(p, tax)}</div>`;
  wire($(".bento", root), p, tax);
  runCounters(root);
}

const card = (span, title, body, end = "") =>
  `<article class="card" style="--span:${span}"><header class="card-head"><h2>${title}</h2>${end}</header>${body}</article>`;
const modelName = (p, id) => (p.models.find((m) => m.id === id) || { label: id }).label;
const groupName = (p, g) => (p.splits.length > 1 ? `${SPLIT_SHORT[g.split] || g.split} · ` : "") + modelName(p, g.model);
const stats = (items) => `<div class="stats">${items.map(([l, v]) => `<div><b class="num">${v}</b><small>${l}</small></div>`).join("")}</div>`;
/* Versions: first half accent, second half ink; Fast full, Expert lighter. */
const shade = (i, n) =>
  i < Math.ceil(n / 2) ? `color-mix(in oklab, var(--accent) ${i % 2 ? 48 : 100}%, var(--card))` : `color-mix(in oklab, var(--ink) ${i % 2 ? 34 : 70}%, var(--card))`;

/* ---------------------------------------------------------------- rings */
function arc(r0, r1, a0, a1) {
  if (a1 - a0 > 2 * Math.PI - 1e-6) return arc(r0, r1, a0, a0 + Math.PI) + arc(r0, r1, a0 + Math.PI, a1);
  const R = RING / 2;
  const pt = (r, a) => `${(R + r * Math.sin(a)).toFixed(2)} ${(R - r * Math.cos(a)).toFixed(2)}`;
  const big = a1 - a0 > Math.PI ? 1 : 0;
  return `M${pt(r1, a0)}A${r1} ${r1} 0 ${big} 1 ${pt(r1, a1)}L${pt(r0, a1)}A${r0} ${r0} 0 ${big} 0 ${pt(r0, a0)}Z`;
}
function arcs(segs, r0, r1) {
  const total = sum(segs.map((s) => s.v)) || 1;
  const gap = segs.filter((s) => s.v > 0).length > 1 ? 2.5 / r1 : 0;
  let a = 0;
  return segs
    .map((s) => {
      const span = (2 * Math.PI * s.v) / total;
      const a0 = a + gap / 2;
      const a1 = a + span - gap / 2;
      a += span;
      if (!(s.v > 0) || a1 <= a0) return "";
      return `<path d="${arc(r0, r1, a0, a1)}" style="fill:${s.c}"${s.tip ? ` data-tip="${esc(s.tip)}"` : ""}/>`;
    })
    .join("");
}
const ring = (paths, num, unit) =>
  `<div class="ring"><svg viewBox="0 0 ${RING} ${RING}">${paths}</svg><div class="ring-c"><b class="num">${num}</b><small class="num">${unit}</small></div></div>`;

/* ---------------------------------------------------------------- 会话场 */
function fieldCard(p) {
  const groups = p.field
    .map((g, gi) => `<div class="fgroup"><div class="fgroup-head"><b>${esc(groupName(p, g))}</b><span class="num">${fmt(g.cells.length)}</span></div>
      <div class="tiles">${g.cells.map((c, i) => `<span style="--c:${sevColor(c[1])};--i:${Math.min(i, 400)}" data-cell="${gi}:${i}" data-w="${c[1]}"></span>`).join("")}</div></div>`)
    .join("");
  const legend = `<div class="legend end" id="fieldLegend">${WORST.map(
    (w, i) => `<button type="button" style="--c:${sevColor(i)}" data-w="${i}" aria-pressed="false"><i></i>${SEV_NAME[w]}<b class="num">${fmt(p.worst[w])}</b></button>`,
  ).join("")}</div>`;
  return card(12, "会话场", `<div class="field is-intro" id="field"><div class="field-groups">${groups}</div></div>`, legend);
}

/* ---------------------------------------------------------------- 数据量: version → task → subtask */
function volumeCard(p) {
  const k = p.kpi;
  return card(6, "数据量", `<div class="duo" id="vol"></div>${stats([["轨迹", counter(k.traces)], ["消息", counter(k.messages)], ["工具调用", counter(k.tool_calls)], ["Tokens", compact(k.tokens)]])}`);
}
function volTree(p) {
  return {
    id: "v", name: "全部", n: p.kpi.sessions,
    children: p.field.map((g) => {
      const id = `v/${g.split}/${g.model}`;
      return {
        id, name: groupName(p, g), n: g.cells.length,
        children: (g.tree || []).map((t) => ({
          id: `${id}/${t.id}`, name: t.id, n: t.n,
          children: t.sub.map((s) => ({ id: `${id}/${t.id}/${s.id}`, name: s.id, n: s.n })),
        })),
      };
    }),
  };
}

/* ---------------------------------------------------------------- 评测量 */
function evalCard(p) {
  const k = p.kpi;
  const inputs = Math.max(k.inputs || 0, k.sessions);
  const paths = arcs(
    [{ v: k.sessions, c: "var(--t0)", tip: `已评测|${fmt(k.sessions)}` }, { v: inputs - k.sessions, c: "var(--t4)", tip: `待评测|${fmt(inputs - k.sessions)}` }],
    RING / 2 - 18, RING / 2,
  );
  const rows = p.field
    .map((g) => {
      const bm = p.by_model.find((x) => x.id === g.model) || {};
      const m = (p.splits.length > 1 && bm.splits && bm.splits[g.split]) || bm;
      const name = groupName(p, g);
      // is_correct is empty in the current batch; until it is filled the bar is the share without a P0–P3 problem.
      const r = m.judged ? (100 * m.correct) / m.judged : (100 * ((m.worst.P4 || 0) + (m.worst.none || 0))) / Math.max(1, m.sessions);
      return `<div class="li vrow" data-tip="${esc(name)} · ${m.judged ? "正确率" : "无实质问题"}|${fmt(r, 1)}%"><span>${esc(name)}</span><span class="vbar"><i style="width:${r}%"></i></span><b class="num">${fmt(r, 1)}%</b></div>`;
    })
    .join("");
  return card(6, "评测量", `<div class="duo">${ring(paths, pct(k.sessions, inputs, 1), `${fmt(k.sessions)} / ${fmt(inputs)}`)}<div class="list">${rows}</div></div>
    ${stats([["归因", counter(k.sessions)], ["Compact", counter(k.compacted || 0)], ["证据", counter(k.evidence)], ["已定位", pct(k.located, k.evidence)]])}`);
}

/* ---------------------------------------------------------------- 归因体系: version → component role */
function spread(ys, min, H) {
  const o = ys.map((y) => Math.max(min / 2, y));
  for (let i = 1; i < o.length; i++) o[i] = Math.max(o[i], o[i - 1] + min);
  for (let i = o.length - 1; i >= 0; i--) o[i] = Math.min(o[i], i === o.length - 1 ? H - min / 2 : o[i + 1] - min);
  return o;
}

function attrCard(p) {
  const groups = p.field
    .map((g, i) => ({ i, name: groupName(p, g), roles: g.roles || {}, c: shade(i, p.field.length) }))
    .map((g) => ({ ...g, n: sum(Object.values(g.roles)) }))
    .filter((g) => g.n);
  const roles = p.roles.filter((r) => r.problems);
  const total = sum(groups.map((g) => g.n)) || 1;
  const W = 440;
  const H = 212;
  const gap = 7;
  const x0 = 130;
  const x1 = W - 100;
  const xm = (x0 + x1) / 2;
  const kL = (H - gap * (groups.length - 1)) / total;
  const kR = (H - gap * (roles.length - 1)) / total;
  let y = 0;
  const L = groups.map((g) => {
    const o = { g, y, h: g.n * kL, off: 0 };
    y += o.h + gap;
    return o;
  });
  y = 0;
  const R = roles.map((r) => {
    const o = { r, y, h: r.problems * kR, off: 0 };
    y += o.h + gap;
    return o;
  });
  let flows = "";
  L.forEach((l) =>
    R.forEach((r) => {
      const n = l.g.roles[r.r.id] || 0;
      if (!n) return;
      const a0 = l.y + l.off;
      const a1 = a0 + n * kL;
      const b0 = r.y + r.off;
      const b1 = b0 + n * kR;
      l.off += n * kL;
      r.off += n * kR;
      flows += `<path class="sk-f" d="M${x0} ${a0}C${xm} ${a0} ${xm} ${b0} ${x1} ${b0}L${x1} ${b1}C${xm} ${b1} ${xm} ${a1} ${x0} ${a1}Z" fill="url(#skg${l.g.i})" data-g="${l.g.i}" data-r="${r.r.id}" data-tip="${esc(l.g.name)} → ${esc(r.r.label)}|${fmt(n)}"/>`;
    }),
  );
  const ly = spread(L.map((l) => l.y + l.h / 2), 16, H);
  const ry = spread(R.map((r) => r.y + r.h / 2), 16, H);
  const defs = groups
    .map((g) => `<linearGradient id="skg${g.i}" gradientUnits="userSpaceOnUse" x1="${x0}" x2="${x1}" y1="0" y2="0"><stop offset="0" style="stop-color:${g.c};stop-opacity:.6"/><stop offset="1" style="stop-color:${g.c};stop-opacity:.18"/></linearGradient>`)
    .join("");
  const left = L.map(
    (l, i) => `<g class="sk-node" data-g="${l.g.i}"><rect x="${x0 - 5}" y="${l.y}" width="5" height="${Math.max(1, l.h)}" rx="2" style="fill:${l.g.c}"/>
      <text x="${x0 - 12}" y="${ly[i]}" text-anchor="end" class="sk-t">${esc(l.g.name)}<tspan class="sk-n" dx="6">${fmt(l.g.n)}</tspan></text></g>`,
  ).join("");
  const right = R.map(
    (r, i) => `<g class="sk-node" data-r="${r.r.id}"><rect x="${x1}" y="${r.y}" width="5" height="${Math.max(1, r.h)}" rx="2" style="fill:var(--t1)"/>
      <text x="${x1 + 12}" y="${ry[i]}" class="sk-t">${esc(r.r.label)}<tspan class="sk-n" dx="6">${fmt(r.r.problems)}</tspan></text></g>`,
  ).join("");
  return card(4, "归因体系", `<div class="hero"><b class="big">${counter(p.kpi.problems)}</b><small>个问题</small></div>
    <svg class="sankey" viewBox="0 0 ${W} ${H}"><defs>${defs}</defs>${flows}${left}${right}</svg>`);
}

/* ---------------------------------------------------------------- 聚类体系: phase → stage → mechanism → pattern */
const clusterCard = (tax) => card(4, "聚类体系", tax ? `<div class="duo sm" id="clu"></div>` : `<div class="empty">缺少聚类体系文件</div>`);
function cluTree(p, tax) {
  const cell = (s, m) => ((p.matrix[s] || {})[m] || {}).n || 0;
  const phases = tax.phases.map((ph) => {
    const stages = tax.stages
      .filter((s) => s.phase === ph.id)
      .map((s) => {
        const mechs = tax.mechanisms.map((m) => ({
          id: `c/${s.id}.${m.id}`, name: m.name, n: cell(s.id, m.id),
          children: p.patterns
            .filter((x) => x.id.startsWith(`${s.id}.${m.id}.`))
            .map((x) => ({ id: `c/${x.id}`, name: (tax.patterns[x.id] || {}).name || x.id, n: x.n })),
        }));
        return { id: `c/${s.id}`, name: s.name, n: sum(mechs.map((m) => m.n)), children: mechs };
      });
    return { id: `c/${ph.id}`, name: ph.name, n: sum(stages.map((s) => s.n)), children: stages };
  });
  if (p.kpi.unclustered) phases.push({ id: "c/~un", name: "未聚类", n: p.kpi.unclustered, other: true });
  return { id: "c", name: "全部", n: p.kpi.problems, children: phases };
}

/* ---------------------------------------------------------------- 预测体系 (docs/prediction-data.md; labelled mock until the file lands) */
function when(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number") return v;
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return Date.parse(`${s}T23:59:59.999+08:00`);
  const t = /([zZ]|[+-]\d{2}:?\d{2})$/.test(s) ? Date.parse(s) : Date.parse(`${s.replace(" ", "T")}+08:00`);
  return Number.isFinite(t) ? t : null;
}
const MOCK_ACC = [0.541, 0.618, 0.472, 0.583];
const MOCK_CAUSE = [["信息滞后", 0.31], ["趋势外推", 0.24], ["事件遗漏", 0.19], ["逻辑跳跃", 0.14], ["数据缺失", 0.12]];
function mockPrediction(p, allQ) {
  const now = when(ctx.data.generated_at) || Date.now();
  const n = Math.round(allQ * 0.14);
  const questions = Array.from({ length: n }, (_, i) => ({ id: `mock-${i}`, answer_at: now + (i < n * 0.7 ? -1 : 1) * 864e5 * (1 + (i % 9)) }));
  const total = questions.filter((q) => q.answer_at <= now).length;
  const accuracy = p.models.map((m, i) => ({ model: m.id, at: now, correct: Math.round(total * MOCK_ACC[i % MOCK_ACC.length]), total }));
  const flows = {};
  accuracy.forEach((a) => {
    let left = a.total - a.correct;
    const wrong = left;
    flows[a.model] = MOCK_CAUSE.map(([, f], i) => {
      const k = i === MOCK_CAUSE.length - 1 ? left : Math.round(wrong * f);
      left -= k;
      return k;
    });
  });
  return { as_of: now, questions, accuracy, attribution: { models: p.models.map((m) => m.id), errors: MOCK_CAUSE.map(([e]) => e), flows } };
}

function predictCard(p) {
  const allQ = new Set(p.field.flatMap((g) => g.cells.map((c) => c[3]))).size;
  const pr = p.prediction || mockPrediction(p, allQ);
  const asOf = when(pr.as_of) ?? when(ctx.data.generated_at);
  const qs = Array.isArray(pr.questions) ? pr.questions : [];
  const open = qs.filter((q) => {
    const t = when(q.answer_at);
    return t != null && t <= asOf;
  }).length;
  const latest = {};
  (pr.accuracy || []).forEach((a) => {
    const t = when(a.at);
    if (t == null || t > asOf) return;
    if (!latest[a.model] || t > latest[a.model].t) latest[a.model] = { t, c: 0, n: 0, pct: null };
    const e = latest[a.model];
    if (e.t !== t) return;
    if (a.total > 0) {
      e.c += a.correct || 0;
      e.n += a.total;
    } else if (a.accuracy != null) e.pct = Number(a.accuracy);
  });
  const acc = Object.entries(latest).map(([m, e]) => ({ m, r: e.n ? (100 * e.c) / e.n : e.pct, c: e.c, n: e.n })).filter((x) => x.r != null);
  const pooledN = sum(acc.map((x) => x.n));
  const at = pr.attribution || {};
  const causes = (at.errors || []).map((l, i) => ({ l, n: sum((at.models || []).map((m) => ((at.flows || {})[m] || [])[i] || 0)) })).filter((x) => x.n);
  const bar = (items) =>
    `<div class="comp">${items.map((x) => `<span style="flex:${x.n} 1 0;--c:${x.c}" data-tip="${esc(x.l)}|${fmt(x.n)}"></span>`).join("")}</div>
    <div class="keys">${items.map((x) => `<span>${dot(x.c)}${esc(x.l)}<b class="num">${fmt(x.n)}</b></span>`).join("")}</div>`;
  const rows = acc
    .map((x) => `<div class="li vrow" data-tip="${esc(modelName(p, x.m))} · 准确率|${x.n ? `${fmt(x.c)} / ${fmt(x.n)}` : `${fmt(x.r, 1)}%`}"><span>${esc(modelName(p, x.m))}</span><span class="vbar"><i style="width:${x.r}%"></i></span><b class="num">${fmt(x.r, 1)}%</b></div>`)
    .join("");
  return card(4, "预测体系", `<div class="pred-top">
      <div class="hero"><b class="big">${counter(qs.length)}</b><small>预测题</small></div>
      <div class="hero"><b class="big num">${pooledN ? `${fmt((100 * sum(acc.map((x) => x.c))) / pooledN, 1)}%` : "—"}</b><small>准确率</small></div></div>
    ${bar([
      { n: open, c: "var(--accent)", l: "已揭晓" },
      { n: qs.length - open, c: "color-mix(in oklab, var(--accent) 38%, var(--card))", l: "待揭晓" },
      { n: Math.max(0, allQ - qs.length), c: "var(--t4)", l: "其他题" },
    ].filter((x) => x.n))}
    ${rows ? `<div class="list pred-rows">${rows}</div>` : ""}${causes.length ? bar(causes.map((x, i) => ({ ...x, c: tone(i) }))) : ""}`,
  p.prediction ? "" : `<span class="status end">示例数据</span>`);
}

/* ---------------------------------------------------------------- 聚类矩阵: stage × mechanism — the one place that opens samples */
function matrixCard(p, tax) {
  if (!tax) return "";
  const mechs = tax.mechanisms;
  let max = 1;
  Object.values(p.matrix).forEach((row) => Object.values(row).forEach((x) => (max = Math.max(max, x.n))));
  const totals = {};
  tax.stages.forEach((s) => (totals[s.id] = sum(Object.values(p.matrix[s.id] || {}).map((x) => x.n))));
  const maxTot = Math.max(...Object.values(totals), 1);
  let html = `<span></span>${mechs.map((m) => `<span class="mh">${esc(m.name)}</span>`).join("")}<span></span>`;
  tax.phases.forEach((ph, pi) => {
    if (pi) html += `<span class="sep"></span>`;
    tax.stages
      .filter((s) => s.phase === ph.id)
      .forEach((s) => {
        html += `<button type="button" class="rh" data-go="stage=${s.id}">${esc(s.name)}<small>${s.id}</small></button>`;
        mechs.forEach((m) => {
          const n = ((p.matrix[s.id] || {})[m.id] || {}).n || 0;
          const v = n ? 0.08 + 0.72 * Math.sqrt(n / max) : 0;
          html += n
            ? `<button type="button" class="cell num${v > 0.5 ? " hot" : ""}" style="--v:${v.toFixed(3)}" data-mx="${s.id}|${m.id}" data-go="pattern=${s.id}.${m.id}">${n}</button>`
            : `<span class="cell"></span>`;
        });
        html += `<span class="rowtot num"><i style="width:${(72 * totals[s.id]) / maxTot}px"></i>${fmt(totals[s.id])}</span>`;
      });
  });
  return card(12, "聚类矩阵", `<div class="matrix" style="--cols:${mechs.length}">${html}</div>`);
}

/* ---------------------------------------------------------------- interaction */
const go = (params) =>
  ctx.navigate({ view: "samples", product: ctx.product, case: null, q: null, w: null, split: null, model: null, role: null, stage: null, pattern: null, ...params });

function wire(bento, p, tax) {
  const field = $("#field", bento);
  setTimeout(() => field.classList.remove("is-intro"), REDUCED ? 0 : 1600);
  const legend = $("#fieldLegend", bento);
  legend.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    const on = b.getAttribute("aria-pressed") !== "true";
    $$("button", legend).forEach((x) => x.setAttribute("aria-pressed", String(on && x === b)));
    field.classList.toggle("is-filtered", on);
    $$(".tiles span", field).forEach((t) => t.classList.toggle("on", on && t.dataset.w === b.dataset.w));
  });
  bento.addEventListener("click", (e) => {
    const t = e.target.closest(".matrix [data-go]");
    if (t) go(Object.fromEntries(new URLSearchParams(t.dataset.go)));
  });
  sunburst($("#vol", bento), volTree(p), { unit: "会话" });
  if (tax) sunburst($("#clu", bento), cluTree(p, tax), { unit: "问题" });

  const sk = $(".sankey", bento);
  sk.addEventListener("pointerover", (e) => {
    const t = e.target.closest("[data-g],[data-r]");
    sk.classList.toggle("hl", !!t);
    if (!t) return;
    const hit = (f) => (t.classList.contains("sk-f") ? f === t : t.dataset.g != null ? f.dataset.g === t.dataset.g : f.dataset.r === t.dataset.r);
    $$(".sk-f", sk).forEach((f) => f.classList.toggle("on", hit(f)));
  });
  sk.addEventListener("pointerleave", () => sk.classList.remove("hl"));

  bindTips(bento, (t) => {
    if (t.dataset.mx) {
      const [s, m] = t.dataset.mx.split("|");
      const name = (list, id) => (list.find((x) => x.id === id) || { name: id }).name;
      const pats = p.patterns.filter((x) => x.id.startsWith(`${s}.${m}.`)).slice(0, 4);
      return `<div style="font-weight:var(--w-medium);margin-bottom:6px">${esc(name(tax.stages, s))} · ${esc(name(tax.mechanisms, m))}</div>${pats
        .map((x) => `<div class="t-row"><span>${esc((tax.patterns[x.id] || {}).name || x.id)}</span><b class="num" style="margin-left:auto">${fmt(x.sessions)}</b></div>`)
        .join("")}`;
    }
    if (!t.dataset.cell) return null;
    const [g, i] = t.dataset.cell.split(":").map(Number);
    const c = p.field[g].cells[i];
    return `<div style="font-weight:var(--w-medium);margin-bottom:4px">${esc(c[3])}</div>
      <div class="t-row"><span class="sev" style="--c:${sevColor(c[1])}"><i></i>${SEV_NAME[WORST[c[1]]]}</span>
      <span>${esc(groupName(p, p.field[g]))}</span><b class="num" style="margin-left:auto">${c[2]} 个问题</b></div>`;
  });
}
