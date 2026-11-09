/* Hierarchical problem-type trends. The first view is the stage level; each branch opens only its
   children. Curves contain only dates where that branch actually has a problem hit, never filled
   zeroes. Every scene is aggregated into the same series. */
import { esc, fmt, segmented, hideTip } from "./core.js";
import { lineTrendSVG, wireLineTrendChart } from "./trend_chart.js";
import { sunburstTween } from "./motion.js";
import { trendSampleFrame } from "./trend_samples.js";

const sum = (list) => list.reduce((a, b) => a + b, 0);
const RANGE_LABEL = { "7": "近 7 天", "30": "近 30 天", all: "全部" };

export function buildProblemTrendModel(trend, names = new Map()) {
  const dates = Array.isArray(trend.dates) ? trend.dates : [];
  const ids = Array.isArray(trend.nodes) ? trend.nodes : [];
  const base = new Float64Array(dates.length);
  (trend.base || []).forEach(([di, , , , sessions]) => {
    if (di >= 0 && di < base.length) base[di] += Number(sessions) || 0;
  });
  const byId = new Map();
  ids.forEach((id) => byId.set(id, {
    id,
    name: names.get(id) || id,
    counts: new Float64Array(dates.length),
    hits: new Float64Array(dates.length),
    observed: new Uint8Array(dates.length),
    children: [],
  }));
  (trend.cells || []).forEach((raw) => {
    if (!Array.isArray(raw)) return;
    const [di, , ni] = raw;
    const node = byId.get(ids[ni]);
    if (!node || di < 0 || di >= dates.length) return;
    node.counts[di] += sum(raw.slice(5, 10).map(Number));
    if (raw[15] != null) {
      node.hits[di] += Number(raw[15]) || 0;
      node.observed[di] = 1;
    }
  });
  const root = { id: "root", name: "全部问题", counts: new Float64Array(dates.length), children: [] };
  [...byId.values()].forEach((node) => {
    const parent = node.id.includes(".") ? byId.get(node.id.split(".").slice(0, -1).join(".")) : root;
    (parent || root).children.push(node);
  });
  // Parents in the payload already carry aggregate counts; fill any missing fallback from children.
  const fill = (node) => {
    node.children.forEach(fill);
    if (sum([...node.counts]) === 0) {
      node.children.forEach((child) => child.counts.forEach((n, i) => { node.counts[i] += n; }));
    }
    node.hasSignal = sum([...node.counts]) > 0;
    return node;
  };
  fill(root);
  return { dates, base, byId, root, releases: Array.isArray(trend.releases) ? trend.releases : [] };
}

function rangeIndexes(model, range) {
  const idx = model.dates.map((_, i) => i).filter((i) => Number.isFinite(Date.parse(`${model.dates[i]}T00:00:00Z`)));
  if (!idx.length || range === "all") return idx;
  const end = new Date(`${model.dates[idx[idx.length - 1]]}T00:00:00Z`);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (Number(range) - 1));
  const from = start.toISOString().slice(0, 10);
  return idx.filter((i) => model.dates[i] >= from);
}

export function problemRateValues(node, base, idx) {
  return idx.map((i) => {
    if (!(base[i] > 0) || !(node.counts[i] > 0) || !node.observed[i]) return null;
    return (100 * Math.min(node.hits[i], base[i])) / base[i];
  });
}

function observationIndexes(model, node, idx) {
  const values = problemRateValues(node, model.base, idx);
  return idx.filter((i, at) => values[at] != null && Number.isFinite(Date.parse(`${model.dates[i]}T00:00:00Z`)));
}

export function problemTrendChart(model, node, idx, width, expanded = false) {
  idx = observationIndexes(model, node, idx);
  const values = problemRateValues(node, model.base, idx);
  return lineTrendSVG({
    width, height: expanded ? 320 : 76, compact: !expanded, yAxis: expanded, endLabels: false,
    xLabels: idx.map((i) => model.dates[i].slice(5)), xDates: idx.map((i) => model.dates[i]),
    series: [{
      label: node.name, color: "var(--accent)", values, levelIdxs: [0, 1, 2, 3, 4],
      volumes: idx.map((i) => node.counts[i]), ratios: values.map((v) => (v || 0) / 100),
      details: idx.map((i) => `${fmt(node.counts[i])} 个问题 · ${fmt(node.hits[i])} / ${fmt(model.base[i])} 会话`),
    }],
    aria: `${node.name} 的问题发生率与问题数量`, formatValue: (v) => `${fmt(v, v < 1 ? 2 : 1)}%`,
    nebulaDots: expanded ? 16 : 6, connectGaps: true, releases: model.releases,
  });
}

function resolvePath(model, path) {
  const nodes = [];
  let node = model.root;
  for (const id of Array.isArray(path) ? path : []) {
    const next = node.children.find((child) => child.id === id);
    if (!next) break;
    nodes.push(next);
    node = next;
  }
  return { node, nodes };
}

export function mountProblemTrends(host, trend, state = {}, names = new Map(), layout = (update) => update(), actions = {}) {
  if (host._mptCancel) host._mptCancel();
  if (host._mptClick) host.removeEventListener("click", host._mptClick);
  const model = buildProblemTrendModel(trend || {}, names);
  if (!model.dates.length || !model.root.hasSignal) {
    host.innerHTML = `<div class="empty">暂无问题趋势数据</div>`;
    return;
  }
  state.range = RANGE_LABEL[state.range] ? String(state.range) : "30";
  state.issuePath = Array.isArray(state.issuePath) ? state.issuePath : [];
  const resolved = resolvePath(model, state.issuePath);
  state.issuePath = resolved.nodes.map((node) => node.id);
  host.innerHTML = `<div class="mpt">
    <div class="mpt-toolbar">
      <div class="seg mpt-range" id="mptRange" role="group" aria-label="问题趋势时间范围">
        <span class="seg-knob" aria-hidden="true"></span>
        ${["7", "30", "all"].map((v) => `<button type="button" data-value="${v}" aria-pressed="${state.range === v}">${RANGE_LABEL[v]}</button>`).join("")}
      </div>
    </div>
    <div class="mpt-grid" id="mptGrid"></div>
  </div>`;

  const grid = host.querySelector("#mptGrid");
  const range = host.querySelector("#mptRange");
  const paint = (animate = false, source = null) => {
    hideTip();
    const path = resolvePath(model, state.issuePath);
    const idx = rangeIndexes(model, state.range);
    const hasObservations = (node) => observationIndexes(model, node, idx).length > 0;
    const children = path.node.children
      .filter(hasObservations)
      .map((node) => ({ node, total: sum(observationIndexes(model, node, idx).map((i) => node.counts[i])) }))
      .sort((a, b) => b.total - a.total || a.node.id.localeCompare(b.node.id));
    const columns = Math.max(1, Math.floor((host.clientWidth + 8) / 213));
    const chartWidth = Math.max(180, (host.clientWidth - (columns - 1) * 8) / columns - 24);
    const focused = children.find(({ node }) => node.id === state.issueZoom);
    if (!focused) state.issueZoom = null;
    const expanded = Boolean(focused);
    const charts = [];
    const cards = (focused ? [focused] : children).map(({ node, total }) => {
      const values = problemRateValues(node, model.base, idx);
      const latest = [...values].reverse().find((v) => v != null);
      const branch = node.children.some(hasObservations);
      const chart = problemTrendChart(model, node, idx, expanded ? host.clientWidth - 32 : chartWidth, expanded);
      charts.push({ node, chart });
      const tag = `${node.children.filter(hasObservations).length} 个子类`;
      // The heatmap owns the drill; the cards only show the current level.
      const plot = `<div class="mpt-chart${expanded ? " mpt-chart-detail" : ""}" data-own-tip>${chart.html}</div>`;
      return `<article class="mpt-card${branch ? " is-branch" : ""}${expanded ? " is-expanded" : ""}" data-trend-card="${esc(node.id)}">
        <header><h4 title="${esc(node.name)}">${esc(node.name)}</h4><button type="button" class="icon-btn mpt-action" data-trend-zoom="${esc(node.id)}" aria-expanded="${expanded}" aria-label="${expanded ? "还原" : "放大"} ${esc(node.name)}" title="${expanded ? "还原" : "放大"}"><svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="${expanded ? "M6 3v3H3m7-3v3h3m0 4h-3v3m-4 0v-3H3" : "M3 6V3h3M10 3h3v3M13 10v3h-3M6 13H3v-3"}" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg></button></header>
        ${expanded ? trendSampleFrame(plot) : plot}
        <footer><span class="num">${fmt(total)} 个问题</span><b class="num" title="最近观测日的问题发生率">${latest == null ? "—" : `${fmt(latest, latest < 1 ? 2 : 1)}%`}</b>${branch ? `<span class="mpt-children">${tag}</span>` : ""}</footer>
      </article>`;
    }).join("");
    if (host._mptCancel) host._mptCancel();
    let transitioning = animate;
    const disposeCharts = [];
    grid.setAttribute("aria-busy", String(transitioning));
    // Keep navigation in view when a lower card splits into a shorter set of children.
    // The page owns vertical scrolling; the grid never traps a wheel or touch gesture.
    if (animate && grid.getBoundingClientRect().top < 116) {
      range.closest(".mpt-toolbar").scrollIntoView({ block: "start", behavior: "instant" });
    }
    const swap = () => {
      grid.innerHTML = cards || `<div class="mpt-empty">当前分类暂无时间趋势</div>`;
      charts.forEach(({ node, chart }) => {
        const card = [...grid.children].find((el) => el.dataset.trendCard === node.id);
        if (!card) return;
        const interaction = { hoverDelay: 160, canHover: () => !transitioning };
        const plot = card.querySelector(".mpt-chart");
        if (expanded && actions.mountDetailChart) {
          const drawer = actions.mountDetailChart(plot, node.id,
            (width) => problemTrendChart(model, node, idx, width, true), interaction);
          disposeCharts.push(() => drawer.destroy());
        } else disposeCharts.push(wireLineTrendChart(plot, chart, "", null, interaction));
      });
    };
    const sourceBox = source && source.getBoundingClientRect();
    if (animate) layout(swap);
    else swap();
    const box = grid.getBoundingClientRect();
    grid.style.transformOrigin = sourceBox ? `${Math.max(0, Math.min(box.width, sourceBox.left - box.left + sourceBox.width / 2))}px 0` : "50% 0";
    const clear = () => {
      transitioning = false;
      grid.setAttribute("aria-busy", "false");
      grid.style.opacity = "";
      grid.style.transform = "";
    };
    const cancel = sunburstTween((k) => {
      grid.style.opacity = String(0.4 + 0.6 * k);
      grid.style.transform = `translateY(${-4 * (1 - k)}px) scale(${0.985 + 0.015 * k})`;
    }, { animate, finish: clear });
    host._mptCancel = () => { cancel(); clear(); disposeCharts.splice(0).forEach((dispose) => dispose()); };
  };

  const control = segmented(range, (value) => {
    state.range = value;
    paint(true, range);
  });
  control.set(state.range, { silent: true });
  paint(false);

  const onClick = (e) => {
    if (grid.contains(e.target) && grid.getAttribute("aria-busy") === "true") return;
    const zoom = e.target.closest("[data-trend-zoom]");
    if (zoom) {
      const id = zoom.dataset.trendZoom;
      state.issueZoom = state.issueZoom === id ? null : id;
      paint(true, zoom.closest(".mpt-card"));
      [...grid.querySelectorAll("[data-trend-zoom]")].find((el) => el.dataset.trendZoom === id)?.focus({ preventScroll: true });
      return;
    }
  };
  host._mptClick = onClick;
  host.addEventListener("click", onClick);
}
