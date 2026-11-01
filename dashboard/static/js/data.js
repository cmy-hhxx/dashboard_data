/* 数据: 会话场 · 数据量 · 评测量 · 归因体系 · 聚类体系 · 预测体系 · 聚类矩阵. Titles only; the layout carries the rest.
   Everything drills in place; this page never opens a sample. */
import { $, $$, esc, fmt, pct, compact, sum, WORST, SEV_NAME, sevColor, counter, runCounters, bindTips, segmented, REDUCED } from "./core.js";
import { sunburst } from "./sunburst.js";

let ctx;
let shown = null;
const RING = 168;
const SPLIT_SHORT = { daily: "日常", lost: "流失" };
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
const groupName = (p, g) => (p.unified || p.splits.length <= 1 ? "" : `${SPLIT_SHORT[g.split] || g.split} · `) + modelName(p, g.model);
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
const FIELD_BUDGET = 2000;
function fieldCard(p) {
  const total = sum(p.field.map((g) => g.cells.length));
  const k = Math.max(1, Math.ceil(total / FIELD_BUDGET));
  const dense = k > 1;
  // Keep one cell per session until the field gets too large; then merge adjacent
  // same-severity sessions into one cell (heavier sessions still read as one tile).
  const buckets = (cells) => {
    const out = [];
    cells.forEach((c, i) => {
      const last = out[out.length - 1];
      if (last && last.sev === c[1] && last.size < k) {
        last.size += 1;
        last.n += c[2];
      } else out.push({ sev: c[1], size: 1, n: c[2], i });
    });
    return out;
  };
  const groups = p.field
    .map((g, gi) => {
      const cells = dense ? buckets(g.cells) : g.cells.map((c, i) => ({ sev: c[1], size: 1, n: c[2], i }));
      return `<div class="fgroup"><div class="fgroup-head"><b>${esc(groupName(p, g))}</b><span class="num">${fmt(g.cells.length)}</span>${
        g.lost ? `<span class="fgroup-lost"><i></i>流失 ${fmt(g.lost)}</span>` : ""
      }</div>
      <div class="tiles">${cells.map((b, i) => `<span style="--c:${sevColor(b.sev)};--i:${Math.min(i, 400)}" data-cell="${gi}:${b.i}" data-w="${b.sev}"${dense ? ` data-k="${b.size}" data-p="${b.n}"` : ""}></span>`).join("")}</div></div>`;
    })
    .join("");
  const legend = `<div class="legend end" id="fieldLegend">${WORST.map(
    (w, i) => `<button type="button" style="--c:${sevColor(i)}" data-w="${i}" aria-pressed="false"><i></i>${SEV_NAME[w]}<b class="num">${fmt(p.worst[w])}</b></button>`,
  ).join("")}</div>`;
  const note = dense ? `<span class="meta" title="会话过多时，相邻且同为最严重等级的会话合并为一格">每格 ≤ ${k} 场</span>` : "";
  return card(12, "会话场", `<div class="field is-intro${dense ? " is-dense" : ""}" id="field"><div class="field-groups">${groups}</div></div>`, `${note}${legend}`);
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

/* ---------------------------------------------------------------- 评测量: how many were evaluated each day */
const dayCount = (d) => Object.entries(d).reduce((n, [k, v]) => (k === "d" ? n : n + (v || 0)), 0);

function evalCard(p) {
  const k = p.kpi;
  const inputs = Math.max(k.inputs || 0, k.sessions);
  const paths = arcs(
    [{ v: k.sessions, c: "var(--accent)", tip: `已评测|${fmt(k.sessions)}` }, { v: inputs - k.sessions, c: "var(--t4)", tip: `待评测|${fmt(inputs - k.sessions)}` }],
    RING / 2 - 18, RING / 2,
  );
  const max = Math.max(...p.field.map((g) => g.cells.length), 1);
  const rows = p.field
    .map((g) => {
      const n = g.cells.length;
      const name = groupName(p, g);
      return `<div class="li vrow" data-tip="${esc(name)} · 已评测|${fmt(n)} 条 · ${pct(n, k.sessions)}"><span>${esc(name)}</span><span class="vbar"><i style="width:${(100 * n) / max}%"></i></span><b class="num">${fmt(n)}</b><em class="num">${pct(n, k.sessions)}</em></div>`;
    })
    .join("");
  const days = (p.dates || []).map((d) => ({ d: d.d, n: dayCount(d) })).filter((d) => d.n);
  const peak = Math.max(...days.map((d) => d.n), 1);
  const total = sum(days.map((d) => d.n));
  const avg = days.length ? total / days.length : 0;
  const chart =
    days.length === 1
      ? `<div class="evsingle"><i></i><span class="num">${esc(days[0].d)}</span><b class="num">${fmt(days[0].n)}</b><small>条</small></div>`
      : days.length
        ? `<div class="evdays" style="--n:${days.length}">${days
            .map(
              (x) => `<div class="evday"><b class="num">${fmt(x.n)}</b><span style="height:${Math.max(3, (52 * x.n) / peak)}px" data-tip="${esc(x.d)}|${fmt(x.n)} 条"></span>
        <small class="num">${esc(x.d.slice(5))}</small></div>`,
            )
            .join("")}</div>`
        : "";
  return card(6, "评测量", `<div class="eval-content"><div class="duo eval-summary">${ring(paths, pct(k.sessions, inputs, 1), `${fmt(k.sessions)} / ${fmt(inputs)}`)}<div class="list">${rows}</div></div>
    ${chart}
    ${stats([["评测总量", counter(k.sessions)], ["评测天数", counter(days.length)], ["日均", counter(avg, { d: avg % 1 ? 1 : 0 })], ["单日峰值", counter(days.length ? peak : 0)]])}</div>`);
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

function predSankey(p, models, causes, flows) {
  const left = models
    .map((m, i) => ({ m, name: modelName(p, m), n: sum(causes.map((_, j) => ((flows[m] || [])[j] || 0))), c: shade(i, models.length) }))
    .filter((x) => x.n);
  if (!left.length || !causes.length) return "";
  const total = sum(left.map((x) => x.n)) || 1;
  const W = 440, H = 176, gap = 7, x0 = 96, x1 = W - 96;
  const kL = (H - gap * (left.length - 1)) / total;
  const kR = (H - gap * (causes.length - 1)) / total;
  let y = 0;
  const L = left.map((x) => {
    const o = { x, y, h: x.n * kL, off: 0 };
    y += o.h + gap;
    return o;
  });
  y = 0;
  const R = causes.map((x) => {
    const o = { x, y, h: x.n * kR, off: 0 };
    y += o.h + gap;
    return o;
  });
  let paths = "";
  L.forEach((l, li) =>
    R.forEach((r, ri) => {
      const n = (flows[l.x.m] || [])[ri] || 0;
      if (!n) return;
      const a0 = l.y + l.off, a1 = a0 + n * kL, b0 = r.y + r.off, b1 = b0 + n * kR;
      l.off += n * kL;
      r.off += n * kR;
      paths += `<path class="sk-f" d="M${x0} ${a0}C${(x0 + x1) / 2} ${a0} ${(x0 + x1) / 2} ${b0} ${x1} ${b0}L${x1} ${b1}C${(x0 + x1) / 2} ${b1} ${(x0 + x1) / 2} ${a1} ${x0} ${a1}Z" fill="url(#psk${li})" data-g="${li}" data-r="${ri}" data-tip="${esc(l.x.name)} → ${esc(r.x.l)}|${fmt(n)}"/>`;
    }),
  );
  const ly = spread(L.map((o) => o.y + o.h / 2), 14, H);
  const ry = spread(R.map((o) => o.y + o.h / 2), 14, H);
  const defs = L.map(
    (l, i) => `<linearGradient id="psk${i}" gradientUnits="userSpaceOnUse" x1="${x0}" x2="${x1}" y1="0" y2="0"><stop offset="0" style="stop-color:${l.x.c};stop-opacity:.55"/><stop offset="1" style="stop-color:${l.x.c};stop-opacity:.16"/></linearGradient>`,
  ).join("");
  const lnode = L.map(
    (l, i) => `<g class="sk-node" data-g="${i}"><rect x="${x0 - 5}" y="${l.y}" width="5" height="${Math.max(1, l.h)}" rx="2" style="fill:${l.x.c}"/>
      <text x="${x0 - 12}" y="${ly[i]}" text-anchor="end" class="sk-t">${esc(l.x.name)}<tspan class="sk-n" dx="6">${fmt(l.x.n)}</tspan></text></g>`,
  ).join("");
  const rnode = R.map(
    (r, i) => `<g class="sk-node" data-r="${i}"><rect x="${x1}" y="${r.y}" width="5" height="${Math.max(1, r.h)}" rx="2" style="fill:var(--t1)"/>
      <text x="${x1 + 12}" y="${ry[i]}" class="sk-t">${esc(r.x.l)}<tspan class="sk-n" dx="6">${fmt(r.x.n)}</tspan></text></g>`,
  ).join("");
  return `<svg class="sankey pred-sk" viewBox="0 0 ${W} ${H}"><defs>${defs}</defs>${paths}${lnode}${rnode}</svg>`;
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
  const predModels = at.models && at.models.length ? at.models : Object.keys(at.flows || {});
  const causes = (at.errors || []).map((l, i) => ({ l, n: sum(predModels.map((m) => ((at.flows || {})[m] || [])[i] || 0)) })).filter((x) => x.n);
  const bar = (items) =>
    `<div class="comp">${items.map((x) => `<span style="flex:${x.n} 1 0;--c:${x.c}" data-tip="${esc(x.l)}|${fmt(x.n)}"></span>`).join("")}</div>
    <div class="keys">${items.map((x) => `<span>${dot(x.c)}${esc(x.l)}<b class="num">${fmt(x.n)}</b></span>`).join("")}</div>`;
  const rows = acc
    .map((x) => `<div class="li vrow" data-tip="${esc(modelName(p, x.m))} · 准确率|${x.n ? `${fmt(x.c)} / ${fmt(x.n)}` : `${fmt(x.r, 1)}%`}"><span>${esc(modelName(p, x.m))}</span><span class="vbar"><i style="width:${x.r}%"></i></span><b class="num">${fmt(x.r, 1)}%</b></div>`)
    .join("");
  const right = sum(acc.map((x) => x.c));
  const causeTotal = sum(causes.map((x) => x.n));
  const panes = `<div class="pred-pane is-on" data-pane="vol">
      <div class="pred-top"><div class="hero"><b class="big">${counter(qs.length)}</b><small>预测题</small></div>
        <div class="hero"><b class="big num">${pct(qs.length, allQ, 1)}</b><small>占题库</small></div></div>
      ${bar([
        { n: open, c: "var(--accent)", l: "已揭晓" },
        { n: qs.length - open, c: "color-mix(in oklab, var(--accent) 38%, var(--card))", l: "待揭晓" },
        { n: Math.max(0, allQ - qs.length), c: "var(--t4)", l: "其他题" },
      ].filter((x) => x.n))}
      ${stats([["题库", counter(allQ)], ["已揭晓", counter(open)], ["待揭晓", counter(qs.length - open)], ["其他题", counter(Math.max(0, allQ - qs.length))]])}
    </div>
    <div class="pred-pane" data-pane="acc">
      <div class="pred-top"><div class="hero"><b class="big num">${pooledN ? `${fmt((100 * right) / pooledN, 1)}%` : "—"}</b><small>准确率</small></div>
        <div class="hero"><b class="big num">${fmt(pooledN)}</b><small>已判定</small></div></div>
      ${rows ? `<div class="list pred-rows">${rows}</div>` : `<div class="empty">暂无准确率</div>`}
      ${pooledN ? bar([
        { n: right, c: "var(--accent)", l: "正确" },
        { n: pooledN - right, c: "var(--t4)", l: "错误" },
      ].filter((x) => x.n)) : ""}
    </div>
    <div class="pred-pane" data-pane="cause">
      <div class="pred-top"><div class="hero"><b class="big">${counter(causeTotal)}</b><small>错误</small></div>
        <div class="hero"><b class="big num">${causes.length}</b><small>类别</small></div></div>
      ${causes.length ? predSankey(p, predModels, causes, at.flows || {}) : `<div class="empty">暂无预测归因</div>`}
    </div>`;
  return card(
    4,
    `预测体系${p.prediction ? "" : ` <span class="status">示例数据</span>`}`,
    `<div class="pred-panes">${panes}</div>`,
    `<div class="seg pred-tabs" id="predTab"><span class="seg-knob" aria-hidden="true"></span>
      <button type="button" data-value="vol" aria-pressed="true">题量</button>
      <button type="button" data-value="acc">能力</button>
      <button type="button" data-value="cause">归因</button></div>`,
  );
}

/* ---------------------------------------------------------------- 聚类矩阵: 场景 × 问题聚类, two-axis drill in place */
const MX_HEAD = 10;
const MX_MIN = 12;
const byNum = (a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1));

function sceneTree(p) {
  const tasks = new Map();
  (p.cross || []).forEach(([task, sub, pats]) => {
    const n = sum(pats.map((x) => x[1]));
    let t = tasks.get(task);
    if (!t) tasks.set(task, (t = { name: task, n: 0, sessions: 0, subs: new Map() }));
    t.n += n;
    t.sessions += 1;
    if (sub) {
      let s = t.subs.get(sub);
      if (!s) t.subs.set(sub, (s = { name: sub, n: 0, sessions: 0 }));
      s.n += n;
      s.sessions += 1;
    }
  });
  return [...tasks.values()]
    .sort((a, b) => b.n - a.n || a.name.localeCompare(b.name))
    .map((t) => {
      const subs = [...t.subs.values()].sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));
      return {
        name: t.name, task: t.name, n: t.n, sessions: t.sessions, tasks: [t.name],
        children: subs.length
          ? subs.map((s) => ({ name: s.name, task: t.name, sub: s.name, n: s.n, sessions: s.sessions, children: [] }))
          : [],
      };
    });
}

// Long task lists fold into a group that opens as its own table; the fold is display-only.
function capScenes(nodes) {
  if (nodes.length <= MX_MIN) return nodes;
  const rest = nodes.slice(MX_HEAD);
  return [
    ...nodes.slice(0, MX_HEAD),
    {
      name: "其他场景", group: true, n: sum(rest.map((x) => x.n)), sessions: sum(rest.map((x) => x.sessions)),
      tasks: rest.flatMap((x) => x.tasks || [x.task]), children: rest,
    },
  ];
}

const sceneMatches = (node, task, sub) =>
  node.group ? node.tasks.includes(task) : node.sub ? node.task === task && node.sub === sub : !node.task || node.task === task;

function clusterTree(p, tax) {
  const pats = new Map((p.patterns || []).map((x) => [x.id, x]));
  const stages = [...tax.stages].sort(byNum).map((s) => {
    const mechs = tax.mechanisms.map((m) => {
      const children = [...pats.values()]
        .filter((x) => x.id.startsWith(`${s.id}.${m.id}.`))
        .sort((a, b) => Number(a.id.split(".")[2]) - Number(b.id.split(".")[2]))
        .map((x) => ({ name: (tax.patterns[x.id] || {}).name || x.id, id: x.id, pat: x.id, prefix: x.id, children: [] }));
      return children.length ? { name: m.name, id: m.id, prefix: `${s.id}.${m.id}`, children } : null;
    }).filter(Boolean);
    return mechs.length ? { name: s.name, id: s.id, prefix: s.id, children: mechs } : null;
  }).filter(Boolean);
  return { name: "全部", children: stages };
}

const clusterMatches = (node, pid) => !node.prefix || pid === node.prefix || pid.startsWith(`${node.prefix}.`);

function matrixView(p, rows, cols) {
  const cells = rows.map(() => cols.map(() => ({ n: 0, sessions: 0, pats: new Map() })));
  (p.cross || []).forEach(([task, sub, pats]) => {
    const ri = rows.findIndex((r) => sceneMatches(r, task, sub));
    if (ri < 0) return;
    const hit = new Set();
    pats.forEach(([pid, n]) => {
      const ci = cols.findIndex((c) => clusterMatches(c, pid));
      if (ci < 0) return;
      const cell = cells[ri][ci];
      cell.n += n;
      cell.pats.set(pid, (cell.pats.get(pid) || 0) + n);
      if (!hit.has(ci)) {
        cell.sessions += 1;
        hit.add(ci);
      }
    });
  });
  return { rows, cols, cells };
}

function matrixTable(view) {
  const { rows, cols, cells } = view;
  if (!rows.length || !cols.length) return `<div class="empty">暂无聚类数据</div>`;
  let max = 1, maxTot = 1;
  const totals = rows.map((_, ri) => sum(cells[ri].map((x) => x.n)));
  cells.forEach((row) => row.forEach((x) => (max = Math.max(max, x.n))));
  totals.forEach((n) => (maxTot = Math.max(maxTot, n)));
  let html = `<span></span>${cols
    .map((c, ci) => {
      const title = `${c.id ? `${c.id} · ` : ""}${c.name}`;
      const label = `<span class="mx-lab">${esc(c.name)}</span>`;
      return c.children.length
        ? `<button type="button" class="mh" data-col="${ci}" title="${esc(title)}" aria-label="下钻 ${esc(c.name)}">${label}<i class="mx-caret" aria-hidden="true"></i></button>`
        : `<span class="mh" title="${esc(title)}">${label}</span>`;
    })
    .join("")}<span></span>`;
  rows.forEach((r, ri) => {
    const drill = r.children.length;
    const label = `<span class="mx-lab">${esc(r.name)}</span>${drill ? `<i class="mx-caret" aria-hidden="true"></i>` : ""}`;
    html += drill
      ? `<button type="button" class="rh" data-row="${ri}" title="${esc(r.name)}" aria-label="下钻 ${esc(r.name)}">${label}</button>`
      : `<span class="rh" title="${esc(r.name)}">${label}</span>`;
    cols.forEach((_, ci) => {
      const cell = cells[ri][ci];
      const v = cell.n ? 0.08 + 0.72 * Math.sqrt(cell.n / max) : 0;
      html += cell.n
        ? `<span class="cell num${v > 0.5 ? " hot" : ""}" style="--v:${v.toFixed(3)}" data-mx="${ri}:${ci}">${fmt(cell.n)}</span>`
        : `<span class="cell is-empty"></span>`;
    });
    html += `<span class="rowtot num"><i style="width:${(72 * totals[ri]) / maxTot}px"></i>${fmt(totals[ri])}</span>`;
  });
  return `<div class="matrix" style="--cols:${cols.length}">${html}</div>`;
}

function crumbPath(path, axis) {
  return path
    .map((n, i) => {
      const text = i ? `<i class="mx-sep" aria-hidden="true">›</i>` : "";
      return `${text}${i === path.length - 1
        ? `<b>${esc(n.name)}</b>`
        : `<button type="button" class="mx-crumb" data-${axis}="${i}" aria-label="返回 ${esc(n.name)}">${esc(n.name)}</button>`}`;
    })
    .join("");
}

const crumbs = (rowPath, colPath) =>
  `<span class="mx-crumb-group"><span class="mx-crumb-label">场景</span>${crumbPath(rowPath, "rp")}</span>
   <span class="mx-crumb-group"><span class="mx-crumb-label">问题</span>${crumbPath(colPath, "cp")}</span>`;

function matrixCard(p, tax) {
  if (!tax) return "";
  const sceneRoot = { name: "全部", children: capScenes(sceneTree(p)) };
  const clusterRoot = clusterTree(p, tax);
  if (!sceneRoot.children.length || !clusterRoot.children.length) {
    return card(12, "聚类矩阵", `<div class="empty">暂无聚类数据</div>`);
  }
  return card(
    12,
    "聚类矩阵",
    `<div id="mxShell">${matrixTable(matrixView(p, sceneRoot.children, clusterRoot.children))}</div>`,
    `<button type="button" class="link mx-back" id="mxBack" hidden aria-label="返回上一级">← 返回</button>
     <div class="mx-crumbs" id="mxCrumbs">${crumbs([sceneRoot], [clusterRoot])}</div>`,
  );
}

/* ---------------------------------------------------------------- interaction */
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
  const tabs = $("#predTab", bento);
  if (tabs) {
    const seg = segmented(tabs, (v) => $$(".pred-pane", bento).forEach((x) => x.classList.toggle("is-on", x.dataset.pane === v)));
    seg.set("vol", { silent: true });
  }

  // Matrix: two axes walk their own trees and the whole table is redrawn in place.
  // Rows: task → subtask (long task lists fold into 其他场景). Columns: stage → mechanism → pattern.
  const shell = $("#mxShell", bento);
  let mxView = null;
  if (shell && tax) {
    const sceneRoot = { name: "全部", children: capScenes(sceneTree(p)) };
    const clusterRoot = clusterTree(p, tax);
    let rowPath = [sceneRoot];
    let colPath = [clusterRoot];
    let trail = [];
    const syncTrail = () => {
      trail = [...Array(rowPath.length - 1).fill("r"), ...Array(colPath.length - 1).fill("c")];
    };
    const paint = () => {
      const rowNode = rowPath[rowPath.length - 1];
      const colNode = colPath[colPath.length - 1];
      const view = matrixView(p, rowNode.children || [], colNode.children || []);
      // Once a problem cluster is selected, keep only scenes that actually carry it.
      if (colPath.length > 1) {
        const rows = [], cells = [];
        view.rows.forEach((r, i) => {
          if (sum(view.cells[i].map((x) => x.n))) {
            rows.push(r);
            cells.push(view.cells[i]);
          }
        });
        view.rows = rows;
        view.cells = cells;
      }
      mxView = view;
      shell.innerHTML = matrixTable(mxView);
      const crumbsEl = $("#mxCrumbs", bento);
      if (crumbsEl) crumbsEl.innerHTML = crumbs(rowPath, colPath);
      const back = $("#mxBack", bento);
      if (back) back.hidden = rowPath.length === 1 && colPath.length === 1;
    };
    paint();
    bento.addEventListener("click", (e) => {
      const back = e.target.closest("#mxBack");
      if (back) {
        const axis = trail.pop();
        if (axis === "r" && rowPath.length > 1) rowPath = rowPath.slice(0, -1);
        else if (axis === "c" && colPath.length > 1) colPath = colPath.slice(0, -1);
        else if (colPath.length > 1) colPath = colPath.slice(0, -1);
        else if (rowPath.length > 1) rowPath = rowPath.slice(0, -1);
        paint();
        return;
      }
      const row = e.target.closest("#mxShell [data-row]");
      if (row) {
        const node = mxView.rows[Number(row.dataset.row)];
        if (node && node.children.length) {
          rowPath = [...rowPath, node];
          trail.push("r");
          paint();
        }
        return;
      }
      const col = e.target.closest("#mxShell [data-col]");
      if (col) {
        const node = mxView.cols[Number(col.dataset.col)];
        if (node && node.children.length) {
          colPath = [...colPath, node];
          trail.push("c");
          paint();
        }
        return;
      }
      const rp = e.target.closest("#mxCrumbs [data-rp]");
      if (rp) {
        rowPath = rowPath.slice(0, Number(rp.dataset.rp) + 1);
        syncTrail();
        paint();
        return;
      }
      const cp = e.target.closest("#mxCrumbs [data-cp]");
      if (cp) {
        colPath = colPath.slice(0, Number(cp.dataset.cp) + 1);
        syncTrail();
        paint();
      }
    });
  }

  sunburst($("#vol", bento), volTree(p), { unit: "会话" });
  if (tax) sunburst($("#clu", bento), cluTree(p, tax), { unit: "问题" });

  $$(".sankey", bento).forEach((sk) => {
    sk.addEventListener("pointerover", (e) => {
      const t = e.target.closest("[data-g],[data-r]");
      sk.classList.toggle("hl", !!t);
      if (!t) return;
      const hit = (f) => (t.classList.contains("sk-f") ? f === t : t.dataset.g != null ? f.dataset.g === t.dataset.g : f.dataset.r === t.dataset.r);
      $$(".sk-f", sk).forEach((f) => f.classList.toggle("on", hit(f)));
    });
    sk.addEventListener("pointerleave", () => sk.classList.remove("hl"));
  });

  bindTips(bento, (t) => {
    if (t.dataset.mx) {
      if (!mxView) return null;
      const [ri, ci] = t.dataset.mx.split(":").map(Number);
      const row = mxView.rows[ri], col = mxView.cols[ci], cell = mxView.cells[ri] && mxView.cells[ri][ci];
      if (!row || !col || !cell || !cell.n) return null;
      const top = col.pat
        ? ""
        : [...cell.pats.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 3)
            .map(([pid, n]) => `<div class="t-row"><span>${esc((tax.patterns[pid] || {}).name || pid)}</span><b class="num" style="margin-left:auto">${fmt(n)}</b></div>`)
            .join("");
      return `<div style="font-weight:var(--w-medium);margin-bottom:6px">${esc(row.name)} · ${esc(col.name)}</div>
        <div class="t-row"><span>问题</span><b class="num" style="margin-left:auto">${fmt(cell.n)}</b></div>
        <div class="t-row"><span>会话</span><b class="num" style="margin-left:auto">${fmt(cell.sessions)}</b></div>
        ${top ? `<div class="mx-tip-pats">${top}</div>` : ""}`;
    }
    if (!t.dataset.cell) return null;
    const [g, i] = t.dataset.cell.split(":").map(Number);
    const c = p.field[g].cells[i];
    const bucketed = t.dataset.k != null;
    const size = Number(t.dataset.k) || 1;
    const probs = Number(t.dataset.p) || c[2];
    return `<div style="font-weight:var(--w-medium);margin-bottom:4px">${bucketed ? `<span class="faint">示例</span> ` : ""}${esc(c[3])}</div>
      <div class="t-row"><span class="sev" style="--c:${sevColor(c[1])}"><i></i>${SEV_NAME[WORST[c[1]]]}</span>
      <span>${esc(groupName(p, p.field[g]))}</span>${c[4] ? `<span class="dim">流失用户</span>` : ""}<b class="num" style="margin-left:auto">${
        bucketed ? `${fmt(size)} 个会话 · ${fmt(probs)} 个问题` : `${c[2]} 个问题`
      }</b></div>`;
  });
}
