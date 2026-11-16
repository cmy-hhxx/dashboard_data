/* Hierarchical problem-type trends. The first view is the stage level; each branch opens only its
   children. Every card is a daily K-line of the occurrence rate with the evaluated sessions as
   volume underneath and the configured releases as vertical lines. A day only appears where that
   branch has an observation, never a filled zero. Every scene is aggregated into the same series. */
import { esc, fmt, hideTip, sum } from "./core.js";
import { createKlineChart, mountKlineWhenVisible } from "./kline_chart.js";
import { sunburstTween } from "./motion.js";
import { trendSampleFrame } from "./trend_samples.js";

const CARD_CHART_H = 112;
const DETAIL_CHART_H = 320;
const rateText = (v) => `${fmt(v, v < 1 ? 2 : 1)}%`;
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
    const parent = (node.id.includes(".") ? byId.get(node.id.split(".").slice(0, -1).join(".")) : root) || root;
    parent.children.push(node);
    node.parent = parent;
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

function allIndexes(model) {
  return model.dates.map((_, i) => i).filter((i) => Number.isFinite(Date.parse(`${model.dates[i]}T00:00:00Z`)));
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

/* One row per observed day: the rate is the candle, the evaluated sessions are the volume. */
export function problemKlineRows(model, node, idx) {
  idx = observationIndexes(model, node, idx);
  const values = problemRateValues(node, model.base, idx);
  return idx.map((i, at) => ({
    date: model.dates[i], value: values[at], volume: model.base[i],
    problems: node.counts[i], hits: node.hits[i],
  }));
}

/* Chart spec shared by the card and the expanded view; onPick opens the sample drawer. */
export function problemKlineSpec(model, node, idx, expanded = false, onPick = null) {
  const rows = problemKlineRows(model, node, idx);
  const byDate = new Map(rows.map((row) => [row.date, row]));
  return {
    rows, period: "day", compact: !expanded, height: expanded ? DETAIL_CHART_H : CARD_CHART_H,
    releases: model.releases, valueFormat: rateText, volumeName: "评测会话",
    openLabel: "前一观测日", closeLabel: "发生率", volumeLabel: "评测会话",
    // The hover reads the whole day for this branch: how many problems and sessions it hit, its
    // share of the level above, and the leading child, so a card can be read without opening it.
    tipExtra: (candle) => {
      const row = byDate.get(String(candle.time));
      if (!row) return "";
      const di = model.dates.indexOf(row.date);
      const up = node.parent;
      const share = up && up !== model.root && up.counts[di] > 0 ? row.problems / up.counts[di] : null;
      const lead = node.children.filter((child) => child.counts[di] > 0)
        .sort((a, b) => b.counts[di] - a.counts[di])[0];
      const line = (label, value) => `<div class="kl-tip-row"><span>${esc(label)}</span><b class="num">${value}</b></div>`;
      return line("问题", fmt(row.problems))
        + line("命中会话", fmt(row.hits))
        + (share == null ? "" : line(`占${up.name}`, `${fmt(100 * share, 1)}%`))
        + (lead ? `<div class="kl-tip-row kl-tip-lead"><span>最多</span><b title="${esc(lead.name)}">${esc(lead.name)} · ${fmt(lead.counts[di])}</b></div>` : "");
    },
    emptyText: "当前分类暂无时间趋势",
    onPick: onPick && ((candle) => onPick({
      date: String(candle.time), seriesIndex: 0, index: rows.findIndex((row) => row.date === String(candle.time)),
      series: { label: node.name, levelIdxs: [0, 1, 2, 3, 4] },
    })),
  };
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
  state.issuePath = Array.isArray(state.issuePath) ? state.issuePath : [];
  const resolved = resolvePath(model, state.issuePath);
  state.issuePath = resolved.nodes.map((node) => node.id);
  host.innerHTML = `<div class="mpt"><nav class="mpt-path" id="mptPath" aria-label="问题层级"></nav><div class="mpt-grid" id="mptGrid"></div></div>`;

  const grid = host.querySelector("#mptGrid");
  const trail = host.querySelector("#mptPath");
  // The way back: every level above the open one is a step; the last one is where you are.
  const paintPath = (path) => {
    const steps = [{ name: model.root.name, depth: 0 }, ...path.nodes.map((node, i) => ({ name: node.name, depth: i + 1 }))];
    trail.hidden = steps.length < 2;
    trail.innerHTML = steps.map((step, i) => (i === steps.length - 1
      ? `<span aria-current="location">${esc(step.name)}</span>`
      : `<button type="button" data-trend-path="${step.depth}">${esc(step.name)}</button><i aria-hidden="true">›</i>`)).join("");
  };
  const paint = (animate = false, source = null) => {
    hideTip();
    const path = resolvePath(model, state.issuePath);
    paintPath(path);
    const idx = allIndexes(model);
    const hasObservations = (node) => observationIndexes(model, node, idx).length > 0;
    const children = path.node.children
      .filter(hasObservations)
      .map((node) => ({ node, total: sum(observationIndexes(model, node, idx).map((i) => node.counts[i])) }))
      .sort((a, b) => b.total - a.total || a.node.id.localeCompare(b.node.id));
    const focused = children.find(({ node }) => node.id === state.issueZoom);
    if (!focused) state.issueZoom = null;
    const expanded = Boolean(focused);
    const shown = focused ? [focused] : children;
    const cards = shown.map(({ node, total }) => {
      const values = problemRateValues(node, model.base, idx);
      const latest = [...values].reverse().find((v) => v != null);
      const branch = node.children.some(hasObservations);
      const tag = `${node.children.filter(hasObservations).length} 个子类`;
      // 分支卡片本身也是下钻入口；放大镜只负责把单条曲线展开看细节。
      const plot = `<div class="mpt-chart${expanded ? " mpt-chart-detail" : ""}" role="img" aria-label="${esc(`${node.name} 的问题发生率日 K 线与评测会话数`)}"></div>`;
      return `<article class="mpt-card${branch ? " is-branch" : ""}${expanded ? " is-expanded" : ""}" data-trend-card="${esc(node.id)}">
        <header><h4 title="${esc(node.name)}">${esc(node.name)}</h4><button type="button" class="icon-btn mpt-action" data-trend-zoom="${esc(node.id)}" aria-expanded="${expanded}" aria-label="${expanded ? "还原" : "放大"} ${esc(node.name)}" title="${expanded ? "还原" : "放大"}"><svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="${expanded ? "M6 3v3H3m7-3v3h3m0 4h-3v3m-4 0v-3H3" : "M3 6V3h3M10 3h3v3M13 10v3h-3M6 13H3v-3"}" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg></button></header>
        ${expanded ? trendSampleFrame(plot) : plot}
        <footer><span class="num">${fmt(total)} 个问题</span><b class="num" title="最近观测日的问题发生率">${latest == null ? "—" : rateText(latest)}</b>${branch ? `<span class="mpt-children">${tag}</span>` : ""}</footer>
      </article>`;
    }).join("");
    if (host._mptCancel) host._mptCancel();
    let transitioning = animate;
    const disposeCharts = [];
    grid.setAttribute("aria-busy", String(transitioning));
    // Keep navigation in view when a lower card splits into a shorter set of children.
    // The page owns vertical scrolling; the grid never traps a wheel or touch gesture.
    if (animate && grid.getBoundingClientRect().top < 116) {
      host.scrollIntoView({ block: "start", behavior: "instant" });
    }
    const swap = () => {
      grid.innerHTML = cards || `<div class="mpt-empty">当前分类暂无时间趋势</div>`;
      shown.forEach(({ node }) => {
        const card = [...grid.children].find((el) => el.dataset.trendCard === node.id);
        if (!card) return;
        const plot = card.querySelector(".mpt-chart");
        if (expanded && actions.mountDetailChart) {
          const drawer = actions.mountDetailChart(plot, node.id,
            (chartHost, onPick) => createKlineChart(chartHost, problemKlineSpec(model, node, idx, true, onPick)));
          disposeCharts.push(() => drawer.destroy());
        } else if (expanded) {
          const chart = createKlineChart(plot, problemKlineSpec(model, node, idx, true));
          disposeCharts.push(() => chart.destroy());
        } else {
          const chart = mountKlineWhenVisible(plot, problemKlineSpec(model, node, idx));
          disposeCharts.push(() => chart.destroy());
        }
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

  paint(false);

  const onClick = (e) => {
    if (grid.contains(e.target) && grid.getAttribute("aria-busy") === "true") return;
    const up = e.target.closest("[data-trend-path]");
    if (up) {
      state.issuePath = state.issuePath.slice(0, Number(up.dataset.trendPath));
      state.issueZoom = null;
      paint(true, up);
      actions.onPath?.(state.issuePath.slice());
      return;
    }
    const zoom = e.target.closest("[data-trend-zoom]");
    if (zoom) {
      const id = zoom.dataset.trendZoom;
      state.issueZoom = state.issueZoom === id ? null : id;
      paint(true, zoom.closest(".mpt-card"));
      [...grid.querySelectorAll("[data-trend-zoom]")].find((el) => el.dataset.trendZoom === id)?.focus({ preventScroll: true });
      return;
    }
    if (state.issueZoom) return;
    const card = e.target.closest("[data-trend-card]");
    if (!card) return;
    const node = model.byId.get(card.dataset.trendCard);
    if (!node) return;
    // 只有还有可观测子类的卡片才下钻；叶子卡片保持只读。
    const idx = allIndexes(model);
    if (!node.children.some((child) => observationIndexes(model, child, idx).length > 0)) return;
    const path = resolvePath(model, state.issuePath).nodes.map((item) => item.id);
    state.issuePath = [...path, node.id];
    state.issueZoom = null;
    paint(true, card);
  };
  host._mptClick = onClick;
  host.addEventListener("click", onClick);
}
