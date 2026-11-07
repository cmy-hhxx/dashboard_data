/* AB Test: one fixed question set before / after a release, plus post-release real-user
   online validation. The outer step answers whether the fixed-set problems moved; the next
   step keeps the normal cluster-matrix interaction (scene × cluster drill, cell trend).

   The three sides are deliberately not one denominator:
   - before / after are the same fixed targets and can be subtracted;
   - online is a different real-user population and is shown as validation only.
   State lives in data.js's u.ab so an in-place dashboard refresh returns to the same round,
   summary / matrix step, metric and selected cell. */
import { esc, fmt } from "./core.js";

const SIDES = ["before", "after", "online"];
const SIDE_SHORT = { before: "改版前", after: "改版后", online: "线上" };
const METRICS = [
  ["all", "三批合计"],
  ["delta", "变化"],
  ["before", "改版前"],
  ["after", "改版后"],
  ["online", "线上"],
];
const NO_SCENE = "未接入分类体系";
const DASH = "—";
const num = (v) => Number(v) || 0;
const signed = (v) => (v > 0 ? `+${fmt(v)}` : v < 0 ? `−${fmt(-v)}` : "0");
const sumOf = (list) => list.reduce((s, v) => s + num(v), 0);
const pathRelated = (a, b) => a === b || String(a).startsWith(`${b}.`) || String(b).startsWith(`${a}.`);

function dateRange(dates) {
  if (!Array.isArray(dates) || !dates.length) return "";
  const [a, b] = dates;
  if (!b || a === b) return a;
  return String(a).slice(0, 4) === String(b).slice(0, 4) ? `${a}～${String(b).slice(5)}` : `${a}～${b}`;
}

function ceilTop(v) {
  const max = num(v);
  if (max <= 4) return 4;
  const raw = max / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 4, 5, 10].map((m) => m * mag).find((s) => s >= raw) || 10 * mag;
  return Math.max(4, Math.round(step * 4));
}

function plotSVG(width, cols, series, aria) {
  const n = cols.length;
  const W = Math.max(280, Math.min(1120, Math.round(num(width) || 640)));
  const H = 118;
  const L = 42;
  const R = 16;
  const T = 12;
  const B = 24;
  const iw = W - L - R;
  const ih = H - T - B;
  const vals = [];
  series.forEach((s) => s.values.forEach((v) => { if (v != null) vals.push(v); }));
  const top = ceilTop(vals.length ? Math.max(...vals) : 0);
  const xOf = (i) => L + (n > 1 ? (i * iw) / (n - 1) : iw / 2);
  const yOf = (v) => T + ih - (v / top) * ih;
  let grid = "";
  for (let g = 0; g <= 4; g += 1) {
    const v = (top * g) / 4;
    const y = yOf(v).toFixed(1);
    grid += `<line x1="${L}" x2="${W - R}" y1="${y}" y2="${y}"${g ? "" : ' class="is-base"'}/><text class="mxt-ylab" x="${L - 7}" y="${y}">${fmt(v)}</text>`;
  }
  const xlab = cols.map((c, i) => `<text class="mxt-xlab" x="${xOf(i).toFixed(1)}" y="${H - 8}">${esc(c)}</text>`).join("");
  let lines = "";
  let dots = "";
  series.forEach((s) => {
    let run = [];
    const flush = () => {
      if (run.length > 1) {
        lines += `<path class="mxt-line" pathLength="1" d="${run.map((p, j) => `${j ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join("")}" style="stroke:${s.color}"/>`;
      }
      run = [];
    };
    s.values.forEach((v, i) => {
      if (v == null) {
        flush();
        return;
      }
      const p = [xOf(i), yOf(v)];
      run.push(p);
      dots += `<circle class="mxt-dot" cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="2.8" style="fill:${s.color}"/>`;
    });
    flush();
  });
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(aria)}"><g class="mxt-grid">${grid}${xlab}</g>${lines}${dots}</svg>`;
}

const sideReady = (rnd, side) => !!(rnd.sides && rnd.sides[side]);
const roundLabel = (rnd, i) => rnd.label || rnd.release_label || `第 ${i + 1} 期`;
const sideLabel = (data, side) => ((data.labels || {}).sides || {})[side] || SIDE_SHORT[side];

function crossFor(rnd, side) {
  if (!sideReady(rnd, side)) return null;
  const source = rnd.matrix && rnd.matrix[side];
  if (Array.isArray(source)) return source;
  // Compatibility with schema 1: matrix files can be rebuilt before the browser cache rolls.
  const leaves = Array.isArray(rnd.leaves) ? rnd.leaves : [];
  const pats = leaves.map((leaf) => [leaf.id, leaf[side]]).filter(([, n]) => n != null && num(n) > 0);
  return pats.length ? [[NO_SCENE, "", pats]] : [];
}

function allCross(rnd) {
  return SIDES.flatMap((side) => crossFor(rnd, side) || []);
}

function metricValue(cell, metric, rnd) {
  if (metric === "before") return cell.before;
  if (metric === "after") return sideReady(rnd, "after") ? cell.after : null;
  if (metric === "online") return sideReady(rnd, "online") ? cell.online : null;
  if (metric === "delta") return sideReady(rnd, "after") ? cell.after - cell.before : null;
  return cell.before + (sideReady(rnd, "after") ? cell.after : 0) + (sideReady(rnd, "online") ? cell.online : 0);
}

function sceneMatches(node, task, sub) {
  return node.group ? (node.tasks || []).includes(task) : node.sub ? node.task === task && node.sub === sub : !node.task || node.task === task;
}

function sceneTree(cross) {
  const tasks = new Map();
  cross.forEach(([task, sub, pats]) => {
    const name = task || NO_SCENE;
    const n = sumOf(pats.map((x) => x[1]));
    let t = tasks.get(name);
    if (!t) tasks.set(name, (t = { name, task: name, n: 0, sessions: 0, tasks: [name], subs: new Map() }));
    t.n += n;
    t.sessions += 1;
    if (sub) {
      let s = t.subs.get(sub);
      if (!s) t.subs.set(sub, (s = { name: sub, task: name, sub, n: 0, sessions: 0 }));
      s.n += n;
      s.sessions += 1;
    }
  });
  return [...tasks.values()]
    .sort((a, b) => b.n - a.n || a.name.localeCompare(b.name))
    .map((t) => {
      const subs = [...t.subs.values()].sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));
      return {
        name: t.name, task: t.task, n: t.n, sessions: t.sessions, tasks: t.tasks,
        children: subs.length ? subs.map((s) => ({ name: s.name, task: s.task, sub: s.sub, n: s.n, sessions: s.sessions, children: [] })) : [],
      };
    });
}

function capScenes(nodes) {
  if (nodes.length <= 12) return nodes;
  const rest = nodes.slice(10);
  return [
    ...nodes.slice(0, 10),
    { name: "其他场景", group: true, n: sumOf(rest.map((x) => x.n)), sessions: sumOf(rest.map((x) => x.sessions)),
      tasks: rest.flatMap((x) => x.tasks || [x.task]), children: rest },
  ];
}

function clusterTree(cross, tax, names) {
  const root = { name: "全部", children: [] };
  const byId = new Map();
  const add = (parent, id, depth) => {
    const key = parent === root ? id : `${parent.prefix}.${id}`;
    let node = byId.get(key);
    if (!node) {
      const stage = depth === 1 ? (tax.stages || []).find((x) => x.id === id) : null;
      const mech = depth === 2 ? (tax.mechanisms || []).find((x) => x.id === id) : null;
      const pattern = depth >= 3 ? (tax.patterns || {})[key] : null;
      node = { name: (stage && stage.name) || (mech && mech.name) || (pattern && pattern.name) || names.get(key) || id,
        id, prefix: key, pat: key, children: [] };
      byId.set(key, node);
      parent.children.push(node);
    }
    return node;
  };
  cross.forEach(([, , pats]) => pats.forEach(([path]) => {
    let parent = root;
    String(path).split(".").forEach((part, i) => { parent = add(parent, part, i + 1); });
  }));
  const order = (id) => String(id).split(".").map((p) => Number(p.replace(/\D/g, "")) || 0);
  const sort = (node) => {
    node.children.sort((a, b) => {
      const x = order(a.prefix), y = order(b.prefix);
      for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
        const d = (x[i] || 0) - (y[i] || 0);
        if (d) return d;
      }
      return a.name.localeCompare(b.name);
    });
    node.children.forEach(sort);
  };
  sort(root);
  return root;
}

function matrixViewAb(rnd, rows, cols, metric) {
  const cells = rows.map(() => cols.map(() => ({ before: 0, after: 0, online: 0, pats: new Map() })));
  SIDES.forEach((side) => {
    const cross = crossFor(rnd, side);
    if (!cross) return;
    cross.forEach(([task, sub, pats]) => {
      const ri = rows.findIndex((r) => sceneMatches(r, task || NO_SCENE, sub || ""));
      if (ri < 0) return;
      pats.forEach(([pid, n]) => {
        const ci = cols.findIndex((c) => pid === c.prefix || String(pid).startsWith(`${c.prefix}.`));
        if (ci < 0) return;
        const cell = cells[ri][ci];
        cell[side] += num(n);
        cell.pats.set(pid, (cell.pats.get(pid) || 0) + num(n));
      });
    });
  });
  cells.forEach((row) => row.forEach((cell) => { cell.n = metricValue(cell, metric, rnd); }));
  return { rows, cols, cells };
}

function matrixTableAb(view, rnd, metric, selected) {
  const { rows, cols, cells } = view;
  if (!rows.length || !cols.length) return `<div class="empty">暂无聚类矩阵数据</div>`;
  let max = 1;
  cells.forEach((row) => row.forEach((x) => { if (x.n != null) max = Math.max(max, Math.abs(x.n)); }));
  const totals = rows.map((_, ri) => sumOf(cells[ri].map((x) => x.n == null ? 0 : x.n)));
  const maxTot = Math.max(1, ...totals.map((n) => Math.abs(n)));
  const heads = cols.map((c, ci) => {
    const title = `${c.prefix ? `${c.prefix} · ` : ""}${c.name}`;
    const label = `<span class="mx-lab">${esc(c.name)}</span>`;
    return c.children.length
      ? `<button type="button" class="mh" data-act="col" data-i="${ci}" title="${esc(title)}" aria-label="下钻 ${esc(c.name)}">${label}<i class="mx-caret" aria-hidden="true"></i></button>`
      : `<span class="mh" title="${esc(title)}">${label}</span>`;
  }).join("");
  let rowLabels = "", gridCells = "", tots = "";
  rows.forEach((r, ri) => {
    const label = `<span class="mx-lab">${esc(r.name)}</span>${r.children.length ? '<i class="mx-caret" aria-hidden="true"></i>' : ""}`;
    rowLabels += r.children.length
      ? `<button type="button" class="rh" data-act="row" data-i="${ri}" title="${esc(r.name)}" aria-label="下钻 ${esc(r.name)}">${label}</button>`
      : `<span class="rh" title="${esc(r.name)}">${label}</span>`;
    cols.forEach((c, ci) => {
      const cell = cells[ri][ci];
      const v = cell.n;
      const tone = metric === "delta" && v != null ? (v < 0 ? " is-better" : v > 0 ? " is-worse" : " is-zero") : "";
      const zero = metric !== "delta" && v != null && v === 0;
      const on = selected && selected.ri === ri && selected.ci === ci;
      const tip = `${r.name} · ${c.name}|前 ${fmt(cell.before)} · 后 ${sideReady(rnd, "after") ? fmt(cell.after) : DASH} · 线上 ${sideReady(rnd, "online") ? fmt(cell.online) : DASH}`;
      gridCells += v == null || zero
        ? `<span class="cell is-empty" data-mx="${ri}:${ci}"></span>`
        : `<span class="cell num${tone}${on ? " is-sel" : ""}" style="--v:${(0.08 + 0.62 * Math.sqrt(Math.abs(v) / max)).toFixed(3)}" data-act="cell" data-ri="${ri}" data-ci="${ci}" data-mx="${ri}:${ci}" data-tip="${esc(tip)}">${metric === "delta" ? signed(v) : fmt(v)}</span>`;
    });
    tots += `<span class="rowtot num"><i class="${metric === "delta" && totals[ri] < 0 ? "is-better" : metric === "delta" && totals[ri] > 0 ? "is-worse" : ""}" style="width:${(72 * Math.abs(totals[ri])) / maxTot}px"></i>${metric === "delta" ? signed(totals[ri]) : fmt(totals[ri])}</span>`;
  });
  return `<div class="matrix abmatrix" style="--cols:${cols.length};--rows:${rows.length}">
    <div class="mx-rows"><span class="mx-corner" aria-hidden="true"></span>${rowLabels}</div>
    <div class="mx-scroll"><div class="mx-grid">${heads}${gridCells}</div></div>
    <div class="mx-tots"><span class="rowtot-head" title="该场景在当前口径下的问题数合计">${metric === "delta" ? "变化合计" : "问题合计"}</span>${tots}</div>
  </div>`;
}

function fitMatrix(m) {
  if (!m) return;
  const labs = [...m.querySelectorAll(".mh .mx-lab")];
  if (!labs.length) return;
  const need = Math.ceil(Math.max(...labs.map((l) => l.scrollWidth))) + 9;
  m.style.setProperty("--mx-colw", `${need}px`);
  const pane = m.querySelector(".mx-scroll");
  if (pane) {
    pane.classList.toggle("is-overflow", pane.scrollWidth > pane.clientWidth + 1);
    pane.classList.toggle("is-at-end", pane.scrollLeft + pane.clientWidth >= pane.scrollWidth - 2);
  }
}

function walk(root, keys, keyOf) {
  const path = [root];
  for (const k of keys) {
    const next = (path[path.length - 1].children || []).find((n) => keyOf(n) === k);
    if (!next) break;
    path.push(next);
  }
  return path;
}

const rowScope = (row) => ({ name: row.name, task: row.task, sub: row.sub, group: !!row.group, tasks: row.tasks || [] });

function treeCount(rnd, side, row, colPrefix) {
  const cross = crossFor(rnd, side);
  if (!cross) return null;
  let total = 0;
  cross.forEach(([task, sub, pats]) => {
    if (!sceneMatches(row, task || NO_SCENE, sub || "")) return;
    pats.forEach(([pid, n]) => {
      if (pid === colPrefix || String(pid).startsWith(`${colPrefix}.`)) total += num(n);
    });
  });
  return total;
}

export function mountAB(host, data, state, tax) {
  const rounds = data && Array.isArray(data.rounds) ? data.rounds : [];
  if (!rounds.length) {
    host.innerHTML = `<div class="empty">暂无 AB 测试数据</div>`;
    return;
  }
  const labels = data.labels || {};
  if (!(Number(state.round) >= 0 && Number(state.round) < rounds.length)) state.round = rounds.length - 1;
  state.round = Number(state.round);
  state.step = state.step === "matrix" ? "matrix" : "summary";
  state.rows = Array.isArray(state.rows) ? state.rows : [];
  state.cols = Array.isArray(state.cols) ? state.cols : [];
  state.metric = METRICS.some(([k]) => k === state.metric) ? state.metric : (sideReady(rounds[state.round], "after") ? "delta" : "all");
  if (((state.metric === "after" || state.metric === "delta") && !sideReady(rounds[state.round], "after"))
      || (state.metric === "online" && !sideReady(rounds[state.round], "online"))) state.metric = "all";
  if (!state.cell || typeof state.cell !== "object") state.cell = null;

  const stName = (k) => (((labels.status || {})[k] || [])[0]) || k;
  const stNote = (k) => (((labels.status || {})[k] || [])[1]) || "";
  const srcName = (k) => ((labels.sources || {})[k]) || k;
  const resetMatrix = () => { state.rows = []; state.cols = []; state.cell = null; };

  function roundBar(rnd) {
    const items = rounds.map((r, i) => {
      const online = sideReady(r, "online") ? `线上 ${fmt(r.sides.online.traces)}` : "线上待回填";
      const paired = sideReady(r, "after") ? "固定题集已配对" : "固定题集待回填";
      return `<button type="button" class="ab-round" data-act="round" data-i="${i}" aria-pressed="${i === state.round}" title="${esc(`${roundLabel(r, i)} · ${paired} · ${online}`)}">
        <b>${esc(roundLabel(r, i))}</b><small>${esc(r.released_at || dateRange(r.dates) || "")}</small><span>${esc(paired)} · ${esc(online)}</span>
      </button>`;
    }).join("");
    return `<div class="ab-rounds" role="group" aria-label="AB 测试对比记录">${items}</div>`;
  }

  function batchCard(rnd, side) {
    const s = rnd.sides && rnd.sides[side];
    const count = side === "online" ? (s ? s.traces : null) : (s ? rnd.targets : null);
    const details = !s
      ? (side === "online" ? "发版后线上数据待回填" : "发版后重评测待回填")
      : side === "online"
        ? `${fmt(s.hits)} 个问题落点 · ${s.from || ""}${s.to ? `～${s.to}` : ""}`
        : `固定题集 · ${fmt(s.traces)} 条有落点 · ${fmt(s.hits)} 个落点`;
    return `<article class="ab-batch${side === "online" ? " is-online" : ""}${s ? "" : " is-pending"}">
      <header><span>${esc(sideLabel(data, side))}</span>${side === "online" && s ? '<i class="ab-live" title="真实用户"></i>' : ""}</header>
      <b class="num">${count == null ? DASH : fmt(count)}</b>
      <small>${count == null ? (side === "online" && !rnd.released_at ? "缺少发版日期" : "待回填") : (side === "online" ? "条真实用户评测" : "道固定问题")}</small>
      <p>${esc(details)}</p>
    </article>`;
  }

  function ledger(rnd) {
    const st = rnd.status || {};
    const sources = Array.isArray(rnd.sources) ? rnd.sources : [];
    const srcSum = sumOf(sources.map((x) => x[1]));
    const srcs = sources.map(([k, n]) => `<span class="ab-src" title="${esc(`${srcName(k)}：${fmt(n)} 句`)}">${esc(srcName(k))} <b class="num">${fmt(n)}</b></span>`).join("");
    return `<ul class="ab-ledger">
      ${["A", "B", "C"].map((k) => `<li class="ab-stat" title="${esc(`${k} · ${stName(k)} · ${stNote(k)}`)}"><b class="num">${fmt(st[k])}</b><small><i class="ab-k">${k}</i>${esc(stName(k))}</small></li>`).join("")}
      ${srcs ? `<li class="ab-srcs" title="${esc(`来源分布只统计有评测记录的 ${fmt(srcSum)} 句`)}"><small class="ab-srcs-lab">来源分布 <b class="num">${fmt(srcSum)}</b> 句</small>${srcs}</li>` : ""}
    </ul>`;
  }

  function changes(rnd) {
    return (Array.isArray(rnd.leaves) ? rnd.leaves : [])
      .filter((leaf) => leaf.after != null)
      .map((leaf) => ({ leaf, before: num(leaf.before), after: num(leaf.after), online: leaf.online == null ? null : num(leaf.online), d: num(leaf.after) - num(leaf.before) }));
  }

  function rankPanel(title, rows, tone, max, total, rnd) {
    const body = rows.length
      ? rows.map((row) => `<button type="button" class="ab-rankrow ${tone}" data-act="focus" data-leaf="${esc(row.leaf.id)}" title="${esc(`${row.leaf.id} · 前 ${fmt(row.before)} → 后 ${fmt(row.after)} · 线上 ${row.online == null ? DASH : fmt(row.online)}`)}">
          <span class="ab-rankname">${esc(row.leaf.name || row.leaf.id)}</span>
          <span class="ab-rankbar"><i style="--w:${Math.max(3, (100 * Math.abs(row.d)) / max).toFixed(1)}%"></i></span>
          <b class="num">${row.before} → ${row.after}</b>
          <small>${row.online > 0 ? `线上 ${fmt(row.online)}` : row.onlineMatched ? "线上同簇" : ""}</small>
        </button>`).join("")
      : `<p class="ab-rankempty">${sideReady(rnd, "after") ? "暂无变化" : "改版后待回填"}</p>`;
    return `<section class="ab-rank ${tone}"><header><span>${title}</span><b class="num">${total}</b></header>${body}</section>`;
  }

  function summary(rnd) {
    const changesNow = changes(rnd);
    const improved = changesNow.filter((x) => x.d < 0).sort((a, b) => a.d - b.d || b.before - a.before);
    const worsened = changesNow.filter((x) => x.d > 0).sort((a, b) => b.d - a.d || b.after - a.after);
    const max = Math.max(1, ...changesNow.map((x) => Math.abs(x.d)));
    const resolved = improved.filter((x) => x.after === 0).length;
    const added = worsened.filter((x) => x.before === 0).length;
    const onlineReady = sideReady(rnd, "online");
    const onlineRows = (Array.isArray(rnd.leaves) ? rnd.leaves : []).filter((leaf) => num(leaf.online) > 0);
    changesNow.forEach((row) => { row.onlineMatched = onlineRows.some((leaf) => pathRelated(row.leaf.id, leaf.id)); });
    const overlap = changesNow.filter((x) => x.d !== 0 && x.onlineMatched);
    const online = onlineReady
      ? `<section class="ab-online">
          <div><b class="num">${fmt(rnd.sides.online.traces)}</b><small>线上真实用户评测</small></div>
          <div><b class="num">${fmt(rnd.sides.online.hits)}</b><small>线上问题落点</small></div>
          <div><b class="num">${fmt(onlineRows.length)}</b><small>线上命中问题聚类</small></div>
          <p>线上命中的聚类中，<b class="num">${fmt(overlap.length)}</b> 个与固定题集的变化重合。</p>
        </section>`
      : `<section class="ab-online is-pending"><p>${rnd.released_at ? "线上真实用户评测待回填。" : "缺少发版日期，无法切线上验证窗口。"}</p></section>`;
    return `<section class="ab-summary">
      <div class="ab-batches">${batchCard(rnd, "before")}${batchCard(rnd, "after")}${batchCard(rnd, "online")}</div>
      ${ledger(rnd)}
      <div class="ab-change-head"><span>问题变化</span><span class="ab-change-pills"><i class="is-better"></i>改善 <b class="num">${fmt(improved.length)}</b><i class="is-worse"></i>变差 <b class="num">${fmt(worsened.length)}</b><small>消除 ${fmt(resolved)} · 新增 ${fmt(added)}</small></span></div>
      <div class="ab-summary-grid">${rankPanel("变好的问题", improved.slice(0, 5), "is-better", max, improved.length, rnd)}${rankPanel("变差的问题", worsened.slice(0, 5), "is-worse", max, worsened.length, rnd)}</div>
      ${online}
      <div class="ab-summary-foot"><button type="button" class="link ab-next" data-act="matrix">下一步：查看聚类矩阵 →</button></div>
    </section>`;
  }

  function crumbs(rowPath, colPath) {
    const group = (label, path, kind, keyOf) => `<span class="mx-crumb-group"><span class="mx-crumb-label">${label}</span>${path.map((node, i) => {
      const current = i === path.length - 1;
      return `${i ? '<i class="mx-sep">›</i>' : ""}<button type="button" class="mx-crumb" data-act="${kind}crumb" data-depth="${i + 1}"${current ? ' aria-current="true"' : ""}>${esc(keyOf(node))}</button>`;
    }).join("")}</span>`;
    return `${group("场景", rowPath, "row", (n) => n.name)}${group("问题", colPath, "col", (n) => n.name)}`;
  }

  function metricChips(rnd) {
    return METRICS.map(([key, label]) => {
      const disabled = (key === "after" && !sideReady(rnd, "after")) || (key === "online" && !sideReady(rnd, "online")) || (key === "delta" && !sideReady(rnd, "after"));
      return `<button type="button" class="ab-chip" data-act="metric" data-metric="${key}" aria-pressed="${state.metric === key}"${disabled ? " disabled" : ""}>${label}</button>`;
    }).join("");
  }

  function trend(rnd, selectedCell) {
    if (!selectedCell) return `<section class="ab-trend" aria-live="polite"><p class="ab-trend-hint">尚未选择聚类格</p></section>`;
    const { row, col } = selectedCell;
    const rows = rounds.map((r, i) => ({
      label: roundLabel(r, i),
      before: treeCount(r, "before", row, col.prefix),
      after: treeCount(r, "after", row, col.prefix),
      online: treeCount(r, "online", row, col.prefix),
    }));
    const cur = rows[state.round];
    const ready = SIDES.filter((side) => sideReady(rnd, side));
    let cols;
    let series;
    if (rows.length === 1) {
      cols = ready.map((side) => SIDE_SHORT[side]);
      series = ready.map((side, i) => ({
        label: SIDE_SHORT[side], color: side === "before" ? "var(--t2)" : side === "after" ? "var(--accent)" : "var(--loc-ulq)",
        values: cols.map((_, j) => (j === i ? cur[side] : null)),
      }));
    } else {
      cols = rows.map((r) => r.label);
      series = ready.map((side) => ({
        label: SIDE_SHORT[side], color: side === "before" ? "var(--t2)" : side === "after" ? "var(--accent)" : "var(--loc-ulq)",
        values: rows.map((r) => r[side]),
      }));
    }
    const d = sideReady(rnd, "after") ? num(cur.after) - num(cur.before) : null;
    const dcls = d == null ? "" : d > 0 ? " is-worse" : d < 0 ? " is-better" : " is-zero";
    const vals = [`<span>前 <b class="num">${cur.before == null ? DASH : fmt(cur.before)}</b></span>`];
    if (sideReady(rnd, "after")) vals.push(`<span>后 <b class="num">${fmt(cur.after)}</b></span>`, `<span class="ab-d${dcls}">Δ ${signed(d)}</span>`);
    if (sideReady(rnd, "online")) vals.push(`<span>线上 <b class="num">${fmt(cur.online)}</b></span>`);
    const legend = series.map((s) => `<span><i style="--c:${s.color}"></i>${s.label}</span>`).join("");
    const aria = `AB 趋势：${row.name} · ${col.name}，${rows.map((r) => `${r.label} 前 ${r.before == null ? "无" : fmt(r.before)} 后 ${r.after == null ? "无" : fmt(r.after)} 线上 ${r.online == null ? "无" : fmt(r.online)}`).join("；")}`;
    const width = host.getBoundingClientRect().width || 720;
    const note = sideReady(rnd, "online")
      ? "固定题集前 / 后可做配对差值；线上是另一批真实用户，只用于验证问题是否继续出现。"
      : "固定题集前 / 后可做配对差值；线上窗口待回填。";
    return `<section class="ab-trend is-on" aria-live="polite">
      <div class="ab-trendhead"><span class="ab-trendname">${esc(row.name)} · ${esc(col.name)}</span><code class="ab-trendpath">${esc(col.prefix)}</code><span class="ab-trendlegend">${legend}</span><span class="ab-trendvals">${vals.join("")}</span></div>
      <div class="ab-trendplot">${plotSVG(Math.min(width, 1120), cols, series, aria)}</div>
      <p class="ab-trendnote">${note}</p>
    </section>`;
  }

  function matrix(rnd) {
    const names = new Map((Array.isArray(rnd.nodes) ? rnd.nodes : []).map((n) => [n.id, n.name]));
    const cross = allCross(rnd);
    const sceneRoot = { name: "全部", children: capScenes(sceneTree(cross)) };
    const clusterRoot = clusterTree(cross, tax || {}, names);
    const rowPath = walk(sceneRoot, state.rows, (n) => n.name);
    const colPath = walk(clusterRoot, state.cols, (n) => n.prefix);
    state.rows = rowPath.slice(1).map((n) => n.name);
    state.cols = colPath.slice(1).map((n) => n.prefix);
    const rowNode = rowPath[rowPath.length - 1];
    const colNode = colPath[colPath.length - 1];
    const view = matrixViewAb(rnd, rowNode.children || [], colNode.children || [], state.metric);
    let selectedIdx = null;
    if (state.cell) {
      const ri = view.rows.findIndex((r) => sceneMatches(state.cell.row, r.task || NO_SCENE, r.sub || ""));
      const ci = view.cols.findIndex((c) => c.prefix === state.cell.col.prefix);
      if (ri >= 0 && ci >= 0) selectedIdx = { ri, ci };
      else state.cell = null;
    }
    const back = '<button type="button" class="link ab-back" data-act="summary">← 返回汇总</button>'
      + (rowPath.length > 1 || colPath.length > 1 ? '<button type="button" class="link ab-back" data-act="back">← 返回上一级</button>' : "");
    return `<section class="ab-matrixstep">
      <div class="ab-matrixhead">${back}<div class="ab-metrics" role="group" aria-label="矩阵口径">${metricChips(rnd)}</div><span class="ab-matrixmeta">${esc(roundLabel(rnd, state.round))} · ${esc(rnd.released_at || dateRange(rnd.dates) || "")}</span></div>
      <div class="mx-crumbs ab-mxcrumbs">${crumbs(rowPath, colPath)}</div>
      <div class="ab-mxshell" id="abMxShell">${matrixTableAb(view, rnd, state.metric, selectedIdx)}</div>
      ${trend(rnd, state.cell)}
    </section>`;
  }

  function render() {
    const rnd = rounds[state.round];
    host.innerHTML = `<div class="abw">${roundBar(rnd)}${state.step === "matrix" ? matrix(rnd) : summary(rnd)}</div>`;
    requestAnimationFrame(() => fitMatrix(host.querySelector(".abmatrix")));
  }

  host.addEventListener("click", (e) => {
    const action = e.target.closest("[data-act]");
    if (!action) return;
    const act = action.dataset.act;
    const rnd = rounds[state.round];
    if (act === "round") {
      const i = Number(action.dataset.i);
      if (!(i >= 0 && i < rounds.length) || i === state.round) return;
      state.round = i;
      state.step = "summary";
      state.metric = sideReady(rounds[i], "after") ? "delta" : "all";
      resetMatrix();
      render();
      return;
    }
    if (act === "matrix") { state.step = "matrix"; resetMatrix(); render(); return; }
    if (act === "summary") { state.step = "summary"; render(); return; }
    if (act === "metric") {
      const next = action.dataset.metric;
      if (!METRICS.some(([k]) => k === next) || action.disabled) return;
      state.metric = next;
      state.cell = null;
      render();
      return;
    }
    if (act === "back") {
      if (state.cols.length) state.cols.pop();
      else state.rows.pop();
      state.cell = null;
      render();
      return;
    }
    if (act === "rowcrumb") { state.rows = state.rows.slice(0, Number(action.dataset.depth) - 1); state.cell = null; render(); return; }
    if (act === "colcrumb") { state.cols = state.cols.slice(0, Number(action.dataset.depth) - 1); state.cell = null; render(); return; }
    if (act === "focus") {
      const leaf = (Array.isArray(rnd.leaves) ? rnd.leaves : []).find((item) => item.id === action.dataset.leaf);
      if (!leaf) return;
      state.step = "matrix";
      state.metric = "delta";
      state.rows = [];
      state.cols = leaf.id.split(".").slice(0, -1);
      state.cell = null;
      render();
      return;
    }
    if (act === "row" || act === "col") {
      const names = new Map((Array.isArray(rnd.nodes) ? rnd.nodes : []).map((n) => [n.id, n.name]));
      const cross = allCross(rnd);
      const sceneRoot = { name: "全部", children: capScenes(sceneTree(cross)) };
      const clusterRoot = clusterTree(cross, tax || {}, names);
      const rowPath = walk(sceneRoot, state.rows, (n) => n.name);
      const colPath = walk(clusterRoot, state.cols, (n) => n.prefix);
      const node = act === "row"
        ? (rowPath[rowPath.length - 1].children || [])[Number(action.dataset.i)]
        : (colPath[colPath.length - 1].children || [])[Number(action.dataset.i)];
      if (!node) return;
      if (act === "row") state.rows.push(node.name);
      else state.cols.push(node.prefix);
      state.cell = null;
      render();
      return;
    }
    if (act === "cell") {
      const ri = Number(action.dataset.ri);
      const ci = Number(action.dataset.ci);
      const names = new Map((Array.isArray(rnd.nodes) ? rnd.nodes : []).map((n) => [n.id, n.name]));
      const cross = allCross(rnd);
      const sceneRoot = { name: "全部", children: capScenes(sceneTree(cross)) };
      const clusterRoot = clusterTree(cross, tax || {}, names);
      const rowPath = walk(sceneRoot, state.rows, (n) => n.name);
      const colPath = walk(clusterRoot, state.cols, (n) => n.prefix);
      const row = (rowPath[rowPath.length - 1].children || [])[ri];
      const col = (colPath[colPath.length - 1].children || [])[ci];
      if (!row || !col) return;
      state.cell = { row: rowScope(row), col: { name: col.name, prefix: col.prefix } };
      render();
    }
  });

  host.addEventListener("pointerover", (e) => {
    const cell = e.target.closest(".cell[data-mx]");
    const table = host.querySelector(".abmatrix");
    if (!table) return;
    if (!cell || cell.classList.contains("is-empty")) {
      table.classList.remove("is-hover");
      table.querySelectorAll(".is-hl, .is-cur").forEach((x) => x.classList.remove("is-hl", "is-cur"));
      return;
    }
    const [ri, ci] = cell.dataset.mx.split(":").map(Number);
    table.classList.add("is-hover");
    table.querySelectorAll(".cell").forEach((c) => {
      const [r, k] = (c.dataset.mx || "").split(":").map(Number);
      c.classList.toggle("is-hl", r === ri || k === ci);
      c.classList.toggle("is-cur", r === ri && k === ci);
    });
    table.querySelectorAll(".rh").forEach((h, i) => h.classList.toggle("is-hl", i === ri));
    table.querySelectorAll(".mh").forEach((h, i) => h.classList.toggle("is-hl", i === ci));
    table.querySelectorAll(".rowtot").forEach((h, i) => h.classList.toggle("is-hl", i === ri));
  });

  host.addEventListener("scroll", (e) => {
    const pane = e.target;
    if (!pane.classList || !pane.classList.contains("mx-scroll")) return;
    pane.classList.toggle("is-at-end", pane.scrollLeft + pane.clientWidth >= pane.scrollWidth - 2);
  }, true);

  const onResize = () => {
    if (!host.isConnected) { window.removeEventListener("resize", onResize); return; }
    fitMatrix(host.querySelector(".abmatrix"));
  };
  window.addEventListener("resize", onResize);
  render();
}
