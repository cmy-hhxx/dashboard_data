/* AB 测试记录: 同一批固定问句在发版前后各聚类一次，两棵树按叶子路径取并集看结构变化。
   展开在聚类体系卡片下方的一张整宽卡里，由 data.js 按需挂载（mountAB(body, data, state)）。

   三处容易读错的口径，界面上都写清楚，这里记一下来源：
   - targets = 固定题集句数（1,137）。A/B/C 把它拆成 有落点 / 无落点 / 无评测记录，
     右上角来源分布只覆盖有评测记录的 A+B（987 句），C 不在其中。
   - sides.before.traces 是有落点的句数（841），nodes[].before 是落点数（一句可落多个叶子，
     合计 2,939）。所以树上和中心数字的分子是落点，分母是句数，两个数不能互相替代。
   - 有没有 after 只看 round.sides.after：没有 04_retest_after 时 nodes[].after 也被算成 0，
     拿它判断会把「未回填」误读成「问题归零」。
   state 是 data.js 里的 u.ab（{open, round, path}），就地刷新后按它复原期次和选中节点。 */
import { $, esc, fmt, pct } from "./core.js";
import { sunburst } from "./sunburst.js";

const ROOT = "ab.root";
const DASH = "—";
const parentOf = (id) => (id && String(id).includes(".") ? String(id).slice(0, String(id).lastIndexOf(".")) : "");
const orderParts = (id) => String(id).split(".").map((p) => Number(p.replace(/\D/g, "")) || 0);
const cmpOrder = (a, b) => {
  const x = orderParts(a);
  const y = orderParts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d;
  }
  return String(a).localeCompare(String(b));
};
const num = (v) => Number(v) || 0;
const deltaOf = (leaf) => num(leaf.after) - num(leaf.before);
const signed = (v) => (v > 0 ? `+${fmt(v)}` : v < 0 ? `−${fmt(-v)}` : "0");
const sumOf = (list) => list.reduce((s, v) => s + num(v), 0);

/* 2026-09-01～11-02：同年只留后一个月的 MM-DD，跨年才写全。 */
function dateRange(dates) {
  if (!Array.isArray(dates) || !dates.length) return "";
  const [a, b] = dates;
  if (!b || a === b) return a;
  return String(a).slice(0, 4) === String(b).slice(0, 4) ? `${a}～${String(b).slice(5)}` : `${a}～${b}`;
}

/* 计数轴上限：四格刻度、整数标签（和 data.js 的趋势轴同一个 1/2/4/5/10 阶梯）。 */
function ceilTop(v) {
  const max = num(v);
  if (max <= 4) return 4;
  const raw = max / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 4, 5, 10].map((m) => m * mag).find((s) => s >= raw) || 10 * mag;
  return Math.max(4, Math.round(step * 4));
}

/* nodes → children 树。sunburst 的 prep 会就地改结构，所以每次挂载都重建一棵。
   根节点 n = 顶层分支之和 = 这一侧的落点总数（不是句数，见文件头）。 */
function buildTree(rnd, side) {
  const pick = (n) => (side === "after" ? num(n.after) : num(n.before));
  const list = Array.isArray(rnd.nodes) ? rnd.nodes : [];
  const root = { id: ROOT, name: "全部", n: 0, children: [] };
  const byId = new Map([[ROOT, root]]);
  list.forEach((n) => byId.set(n.id, { id: n.id, name: n.name || n.id, n: pick(n), children: [] }));
  list.forEach((n) => {
    const self = byId.get(n.id);
    if (self) (byId.get(n.parent) || root).children.push(self);
  });
  root.n = sumOf(root.children.map((c) => c.n));
  return root;
}

/* 跨期趋势的小图：cols = 横轴标签，series = 1~2 条线（前 / 后）。
   缺值的点不连线，避免把断口画成假趋势；单点就只画点。 */
function plotSVG(width, cols, series, aria) {
  const n = cols.length;
  const W = Math.max(280, Math.min(1120, Math.round(num(width) || 640)));
  const H = 100;
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
      dots += `<circle class="mxt-dot" cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="2.6" style="fill:${s.color}"/>`;
    });
    flush();
  });
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(aria)}"><g class="mxt-grid">${grid}${xlab}</g>${lines}${dots}</svg>`;
}

export function mountAB(host, data, state) {
  const rounds = data && Array.isArray(data.rounds) ? data.rounds : [];
  if (!rounds.length) {
    host.innerHTML = `<div class="empty">暂无 AB 测试数据</div>`;
    return;
  }
  const labels = data.labels || {};
  if (!(Number(state.round) >= 0 && Number(state.round) < rounds.length)) state.round = rounds.length - 1;
  state.round = Number(state.round);

  host.innerHTML = `<div class="abw">
    <div class="ab-bar"></div>
    <ul class="ab-ledger"></ul>
    <p class="ab-note" hidden></p>
    <div class="ab-main">
      <section class="ab-treecol" aria-label="四层合并聚类树">
        <div class="ab-treehead"></div>
        <div class="ab-tree"></div>
        <p class="ab-treefoot"></p>
      </section>
      <section class="ab-listcol" aria-label="叶子明细">
        <div class="ab-listhead"><nav class="ab-crumbs" aria-label="当前子树"></nav><span class="ab-listmeta"></span></div>
        <div class="ab-listwrap">
          <div class="ab-table" role="table" aria-label="叶子明细" aria-colcount="4">
            <div class="ab-thead" role="rowgroup"><div class="ab-tr" role="row">
              <span class="ab-th" role="columnheader">叶子</span>
              <span class="ab-th num" role="columnheader">前</span>
              <span class="ab-th num" role="columnheader" data-after>后</span>
              <span class="ab-th num" role="columnheader" data-delta>Δ</span>
            </div></div>
            <div class="ab-tbody" role="rowgroup"></div>
          </div>
        </div>
        <section class="ab-trend" aria-live="polite" aria-label="跨期趋势"></section>
      </section>
    </div>
  </div>`;

  const el = {
    bar: $(".ab-bar", host),
    ledger: $(".ab-ledger", host),
    note: $(".ab-note", host),
    treehead: $(".ab-treehead", host),
    tree: $(".ab-tree", host),
    treefoot: $(".ab-treefoot", host),
    crumbs: $(".ab-crumbs", host),
    listmeta: $(".ab-listmeta", host),
    listwrap: $(".ab-listwrap", host),
    tbody: $(".ab-tbody", host),
    table: $(".ab-table", host),
    thAfter: $(".ab-thead [data-after]", host),
    thDelta: $(".ab-thead [data-delta]", host),
    trend: $(".ab-trend", host),
  };

  let rnd = rounds[state.round];
  let paired = false;
  let nodesById = new Map();
  let leafById = new Map();
  let selected = null; // 选中节点 id（叶子或内部节点）；null = 没有选中
  let scope = null; // 列表的子树范围 id；null = 整棵树
  let curFocus = ROOT; // sunburst 当前焦点，中心按钮回退时用来同步选中

  const stName = (k) => (((labels.status || {})[k] || [])[0]) || k;
  const stNote = (k) => (((labels.status || {})[k] || [])[1]) || "";
  const srcName = (k) => ((labels.sources || {})[k]) || k;
  const modelName = (k) => ((labels.models || {})[k]) || k;
  const bReasonTip = () => Object.entries(rnd.b_reason || {})
    .map(([k, v]) => {
      const b = (labels.b_reason || {})[k] || [];
      return `${k} ${b[0] || ""} ${fmt(v)}`.trim();
    })
    .join(" · ");
  const sideStats = (side) => (rnd.sides || {})[side] || null;

  /* 选中叶子时列表不收窄到一片：左上角的行点击是「选中」，下钻由树和面包屑负责。 */
  const isLeaf = (id) => leafById.has(id);
  const scopeOf = (id) => (id ? (isLeaf(id) ? parentOf(id) || null : id) : null);

  function renderBar() {
    const tip = (r) => [
      r.label || "",
      r.title || "",
      `固定题集 ${fmt(r.targets)} 句`,
      dateRange(r.dates) ? `日期 ${dateRange(r.dates)}` : "",
      r.sides && r.sides.after ? "发版后已配对" : "发版后待回填",
    ].filter(Boolean).join(" · ");
    const left = rounds.length > 1
      ? `<div class="ab-rounds" role="group" aria-label="期次">${rounds.map((r, i) => `<button type="button" class="ab-chip" data-round="${i}" aria-pressed="${i === state.round}" title="${esc(tip(r))}">${esc(r.label || `第 ${i + 1} 期`)}</button>`).join("")}</div>`
      : `<span class="ab-roundonly" title="${esc(tip(rnd))}">${esc(rnd.label || "")}</span>`;
    const dates = dateRange(rnd.dates);
    el.bar.innerHTML = `${left}<span class="ab-fixed">固定题集 <b class="num">${fmt(rnd.targets)}</b> 句${dates ? ` · 日期 <span class="num">${esc(dates)}</span>` : ""}</span>`;
  }

  function renderLedger() {
    const st = rnd.status || {};
    const stat = (k) => {
      const n = num(st[k]);
      const reason = k === "B" ? bReasonTip() : "";
      const tip = [`${k} · ${stName(k)}`, stNote(k), `${fmt(n)} 句`, `占固定题集 ${pct(n, rnd.targets)}`, reason]
        .filter(Boolean).join(" · ");
      return `<li class="ab-stat" title="${esc(tip)}"><b class="num">${fmt(n)}</b><small><i class="ab-k">${k}</i>${esc(stName(k))}</small></li>`;
    };
    const sources = Array.isArray(rnd.sources) ? rnd.sources : [];
    const srcSum = sumOf(sources.map((x) => x[1]));
    const srcs = sources.map(([k, n]) => `<span class="ab-src" title="${esc(`${srcName(k)}：${fmt(n)} 句`)}">${esc(srcName(k))} <b class="num">${fmt(n)}</b></span>`).join("");
    el.ledger.innerHTML = `<li class="ab-stat" title="${esc(`固定题集：每期重跑的同一批问句（targets），共 ${fmt(rnd.targets)} 句`)}"><b class="num">${fmt(rnd.targets)}</b><small>固定题集</small></li>
      ${["A", "B", "C"].map(stat).join("")}
      ${srcs ? `<li class="ab-srcs" title="${esc(`来源分布只统计有评测记录的 ${fmt(srcSum)} 句（A+B）；${fmt(num(st.C))} 句无评测记录（C）不在其中`)}"><small class="ab-srcs-lab">来源分布 <b class="num">${fmt(srcSum)}</b> 句</small>${srcs}</li>` : ""}`;
  }

  function renderNote() {
    el.note.hidden = paired;
    el.note.innerHTML = paired
      ? ""
      : `<i aria-hidden="true"></i><span>发版后重评测未回填（04_retest_after 为空），先记基线；回填后这里自动出前/后对比</span>`;
  }

  function renderTree() {
    const side = paired ? "after" : "before";
    const s = sideStats(side);
    const hits = s ? num(s.hits) : null;
    const traces = s ? num(s.traces) : null;
    const word = paired ? "发版后" : "发版前";
    el.treehead.innerHTML = `<span class="ab-side${paired ? " is-after" : ""}"><i aria-hidden="true"></i>当前看：${word}${paired ? "" : "（基线）"}</span><span class="ab-treeunit">${word}落点</span>`;
    const head = `节点数 = ${word}落点数，合计 <b class="num">${fmt(hits)}</b>，来自 <b class="num">${fmt(traces)}</b> 句有落点（一句可落多个叶子）；分母不是 <b class="num">${fmt(rnd.targets)}</b> 句固定题集。`;
    el.treefoot.innerHTML = paired
      ? `${head} 树按发版后计数绘制，发版后归零的叶子只在右侧列表出现。`
      : head;

    const sb = { focus: scope ? parentOf(scope) || ROOT : ROOT };
    if (scope) sb.open = scope;
    sunburst(el.tree, buildTree(rnd, side), {
      unit: "落点",
      state: sb,
      animate: true,
      onChange: (focus) => { curFocus = focus.id; },
    });
    curFocus = sb.focus;
  }

  function rowTip(leaf, scopeTotal) {
    const models = Object.entries(leaf.model_before || {}).map(([k, v]) => `${modelName(k)} ${fmt(v)}`).join(" / ");
    const sources = Object.entries(leaf.source_before || {}).map(([k, v]) => `${srcName(k)} ${fmt(v)}`).join(" / ");
    const extra = [leaf.id, models ? `模型 ${models}` : "", sources ? `来源 ${sources}` : ""].filter(Boolean).join(" · ");
    return paired
      ? [`前 ${fmt(leaf.before)} → 后 ${fmt(leaf.after)}`, `Δ ${signed(deltaOf(leaf))}`, extra]
      : [`前 ${fmt(leaf.before)}`, `占该子树落点 ${pct(num(leaf.before), scopeTotal)}`, extra];
  }

  function rowHTML(leaf, scopeTotal) {
    const d = paired ? deltaOf(leaf) : null;
    const cls = d == null ? "" : d > 0 ? " is-worse" : d < 0 ? " is-better" : " is-zero";
    const delta = paired ? `<span class="ab-td num ab-d${cls}" role="cell">${signed(d)}</span>` : "";
    return `<div class="ab-tr ab-row" role="row" data-leaf="${esc(leaf.id)}" tabindex="0" aria-current="false" data-tip="${esc(rowTip(leaf, scopeTotal).join("|"))}">
      <span class="ab-td ab-name" role="cell"><span class="ab-namein"><span class="ab-n">${esc(leaf.name || leaf.id)}</span><i class="ab-lid">${esc(leaf.id)}</i></span></span>
      <span class="ab-td num" role="cell">${fmt(leaf.before)}</span>
      <span class="ab-td num${paired ? "" : " is-na"}" role="cell">${paired ? fmt(leaf.after) : DASH}</span>
      ${delta}
    </div>`;
  }

  function scopeRows() {
    const leaves = Array.isArray(rnd.leaves) ? rnd.leaves : [];
    const rows = leaves.filter((l) => !scope || l.id === scope || String(l.id).startsWith(`${scope}.`));
    rows.sort((a, b) => (paired
      ? Math.abs(deltaOf(b)) - Math.abs(deltaOf(a)) || num(b.after) - num(a.after) || cmpOrder(a.id, b.id)
      : num(b.before) - num(a.before) || cmpOrder(a.id, b.id)));
    return rows;
  }

  function markSelected() {
    Array.from(el.tbody.querySelectorAll(".ab-row")).forEach((row) => {
      const on = row.dataset.leaf === selected;
      row.classList.toggle("is-sel", on);
      row.setAttribute("aria-current", on ? "true" : "false");
    });
  }

  function paintList(scrollTop) {
    const rows = scopeRows();
    const total = sumOf(rows.map((l) => (paired ? l.after : l.before)));
    el.tbody.innerHTML = rows.length
      ? rows.map((l) => rowHTML(l, total)).join("")
      : `<div class="ab-tr ab-emptyrow" role="row"><span class="ab-td" role="cell">该子树下没有叶子</span></div>`;
    el.listmeta.innerHTML = `${fmt(rows.length)} 片叶子 · ${paired ? "按 |Δ| 降序" : "按 前 降序"}`;
    if (scrollTop) el.listwrap.scrollTop = 0;
    markSelected();
  }

  function paintCrumbs() {
    const chain = [];
    if (scope) {
      let acc = "";
      String(scope).split(".").forEach((seg) => {
        acc = acc ? `${acc}.${seg}` : seg;
        chain.push(acc);
      });
    }
    const crumb = (id, text, current) => `<button type="button" class="ab-crumb" data-scope="${esc(id)}"${current ? ' aria-current="true"' : ""}>${esc(text)}</button>`;
    const out = [crumb("", "全部", !scope)];
    chain.forEach((id, i) => {
      const node = nodesById.get(id) || {};
      out.push(`<i class="ab-crumb-sep" aria-hidden="true">›</i>`, crumb(id, node.name || id, i === chain.length - 1));
    });
    el.crumbs.innerHTML = out.join("");
  }

  function paintTrend() {
    if (!selected) {
      el.trend.classList.remove("is-on");
      el.trend.innerHTML = `<p class="ab-trend-hint">点树上的节点或右侧的叶子，看它在各期的走势。</p>`;
      return;
    }
    el.trend.classList.add("is-on");
    const node = nodesById.get(selected) || {};
    const name = node.name || selected;
    const rows = rounds.map((r) => {
      const hit = (Array.isArray(r.nodes) ? r.nodes : []).find((x) => x.id === selected);
      const hasAfter = !!(r.sides && r.sides.after);
      return {
        label: r.label || "",
        paired: hasAfter,
        before: hit ? num(hit.before) : null,
        after: hasAfter && hit ? num(hit.after) : null,
      };
    });
    const cur = rows[state.round] || { before: null, after: null, paired: false };
    const anyPaired = rows.some((r) => r.paired);
    let cols;
    let series;
    if (rows.length === 1) {
      const one = rows[0];
      if (one.paired) {
        cols = ["前", "后"];
        series = [
          { label: "前", color: "var(--t2)", values: [one.before, null] },
          { label: "后", color: "var(--accent)", values: [null, one.after] },
        ];
      } else {
        cols = [one.label];
        series = [{ label: "前", color: "var(--t2)", values: [one.before] }];
      }
    } else {
      cols = rows.map((r) => r.label);
      series = [{ label: "前", color: "var(--t2)", values: rows.map((r) => r.before) }];
      if (anyPaired) series.push({ label: "后", color: "var(--accent)", values: rows.map((r) => r.after) });
    }
    const aria = `跨期趋势：${name}，${rows.map((r) => `${r.label} 前 ${r.before == null ? "无" : fmt(r.before)}${r.paired ? ` 后 ${fmt(r.after)}` : ""}`).join("；")}`;
    const d = cur.paired ? num(cur.after) - num(cur.before) : null;
    const dcls = d == null ? "" : d > 0 ? " is-worse" : d < 0 ? " is-better" : " is-zero";
    const legend = series.map((s) => `<span><i style="--c:${s.color}"></i>${s.label}</span>`).join("");
    const vals = [`<span>前 <b class="num">${fmt(cur.before)}</b></span>`];
    if (cur.paired) vals.push(`<span>后 <b class="num">${fmt(cur.after)}</b></span>`, `<span class="ab-d${dcls}">Δ ${signed(d)}</span>`);
    const pending = rows.filter((r) => !r.paired).map((r) => r.label).filter(Boolean);
    let note;
    if (rows.length === 1 && !anyPaired) {
      note = `基线第 1 期：${rows[0].label} 只有发版前的记录，先记基线；发版后重评测（04_retest_after）回填后这里会出现第 2 期与后侧的点。`;
    } else if (rows.length === 1) {
      note = `${rows[0].label}：这一期已配对，前 / 后两个点就是本次发版的差值。`;
    } else {
      note = `前 = 发版前落点，后 = 发版后落点，每期是同一批固定问句。${pending.length ? ` 待回填：${pending.join("、")}（只有前）。` : ""}`;
    }
    const width = el.trend.getBoundingClientRect().width || 640;
    /* 只有 1 期时就是「一个点」：把画布收窄，别让一个点撑满整行；多期才铺满宽度。 */
    const cap = rows.length === 1 ? 520 : 1120;
    el.trend.innerHTML = `<div class="ab-trendhead">
        <span class="ab-trendname">${esc(name)}</span>
        <code class="ab-trendpath">${esc(selected)}</code>
        <span class="ab-trendlegend">${legend}</span>
        <span class="ab-trendvals">${vals.join("")}</span>
      </div>
      <div class="ab-trendplot"${rows.length === 1 ? ` style="max-width:${cap}px"` : ""}>${plotSVG(Math.min(width, cap), cols, series, aria)}</div>
      <p class="ab-trendnote">${note}</p>`;
  }

  function select(id) {
    selected = id && nodesById.has(id) ? id : null;
    state.path = selected;
    const next = scopeOf(selected);
    if (next !== scope) {
      scope = next;
      paintList(true);
      paintCrumbs();
    } else {
      markSelected();
    }
    paintTrend();
  }

  function renderRound() {
    rnd = rounds[state.round];
    paired = !!(rnd.sides && rnd.sides.after);
    nodesById = new Map((Array.isArray(rnd.nodes) ? rnd.nodes : []).map((n) => [n.id, n]));
    leafById = new Map((Array.isArray(rnd.leaves) ? rnd.leaves : []).map((l) => [l.id, l]));
    selected = state.path && nodesById.has(state.path) ? state.path : null;
    state.path = selected;
    scope = scopeOf(selected);
    renderBar();
    renderLedger();
    renderNote();
    renderTree();
    // 没有 after 就不给 Δ 这一列：一列「—」只会让人觉得是坏了，后列已经说明了缺什么。
    el.table.classList.toggle("is-single", !paired);
    el.table.setAttribute("aria-colcount", paired ? "4" : "3");
    if (el.thAfter) el.thAfter.title = paired ? "发版后重评测落点数" : "发版后重评测未回填，暂无可比数据";
    if (el.thDelta) el.thDelta.title = "Δ = 后 − 前；变多（+）视为变差";
    paintList(true);
    paintCrumbs();
    paintTrend();
  }

  el.bar.addEventListener("click", (e) => {
    const chip = e.target.closest(".ab-chip");
    if (!chip) return;
    const i = Number(chip.dataset.round);
    if (!(i >= 0 && i < rounds.length) || i === state.round) return;
    state.round = i;
    renderRound();
  });

  el.crumbs.addEventListener("click", (e) => {
    const crumb = e.target.closest("[data-scope]");
    if (crumb) select(crumb.dataset.scope || null);
  });

  el.tbody.addEventListener("click", (e) => {
    const row = e.target.closest(".ab-row");
    if (row && row.dataset.leaf) select(row.dataset.leaf);
  });
  el.tbody.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const row = e.target.closest(".ab-row");
    if (!row || !row.dataset.leaf) return;
    e.preventDefault();
    select(row.dataset.leaf);
  });

  /* sunburst 自己的点击先改焦点/展开，再冒泡到这里：读它落下的 data-n 作为选中节点。
     中心按钮没有 data-n，用 onChange 记下的当前焦点同步（回退一层就选回父节点）。 */
  el.tree.addEventListener("click", (e) => {
    if (e.target.closest(".sb-c")) {
      select(curFocus && curFocus !== ROOT ? curFocus : null);
      return;
    }
    const hit = e.target.closest("[data-n]");
    if (hit) select(hit.dataset.n);
  });

  /* 窄屏 / 拖动窗口后按新宽度重画趋势图（viewBox 跟着容器走，字才不会被缩放）。 */
  const onResize = () => {
    if (!host.isConnected) {
      window.removeEventListener("resize", onResize);
      return;
    }
    paintTrend();
  };
  window.addEventListener("resize", onResize);

  renderRound();
}
