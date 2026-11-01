/* Data board: concentric rings, evaluation coverage, attribution, cluster and prediction. */
import {
  $, FONT, REDUCED, fmt, pct, clamp, fmtBytes, fmtTokens, dateRange, esc,
  hexA, readTokens, T, C, tip, tipCard,
  tipHead, tipRow, createChart, disposeChart, setNum, settleCounters, resizeAllCharts,
} from "./core.js";
import { ringPalette } from "./ring.js";
import { createHierarchyCard } from "./hierarchy-card.js";
import { classificationHierarchy, hierarchyDepth } from "./hierarchy-data.js";
import {
  predictionData, predictionSnapshot,
  predictionInputValue, predictionTimeLabel,
} from "./prediction-data.js";

const board = {
  data: null,
  opts: {},
  product: "wencai",
  predict: { wencai: { dim: "distribution" }, aime: { dim: "distribution" } },
  rings: { wencai: { volume: null, cluster: null }, aime: { volume: null, cluster: null } },
  rendered: { wencai: false, aime: false },
};

const VERSION_DEFS = {
  a_expert: { label: "A·expert", color: () => T.wc, group: "A" },
  a_fast: { label: "A·fast", color: () => T.wcMid, group: "A" },
  b_expert: { label: "B·expert", color: () => T.b, group: "B" },
  b_fast: { label: "B·fast", color: () => T.bMid, group: "B" },
  fast: { label: "fast", color: () => T.predFast || T.aiMid, group: "AI" },
  expert: { label: "expert", color: () => T.ai, group: "AI" },
};

const isWc = (product) => product === "wencai";
const getSrc = (product) => (isWc(product) ? board.data.wencai : board.data.aime);
const productLabel = (product) => (isWc(product) ? "问财" : "AIME");

function showChartEmpty(el, text) {
  if (!el) return;
  disposeChart(el);
  el.innerHTML = `<div class="empty-state"><span class="empty-mark">∅</span><p>${esc(text)}</p></div>`;
}

/* --------------------------------------------------------- hierarchy cards */

function maybeNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function paletteByName(names) {
  const colors = ringPalette(names.length);
  const ordered = [...names].sort((a, b) => String(a).localeCompare(String(b), "zh-Hans-CN"));
  return new Map(ordered.map((name, i) => [name, colors[i]]));
}

// Both cards mount the same complete component; their adapters supply only data/copy.
function renderHierarchy(product, slot, props) {
  const prefix = isWc(product) ? "wc" : "ai";
  const body = $(`${prefix}${slot === "volume" ? "VolumeHierarchy" : "ClusterHierarchy"}`);
  if (!body) return;
  const component = board.rings[product][slot];
  if (component) component.update(props);
  else board.rings[product][slot] = createHierarchyCard(body, props);
}

function renderVolume(product) {
  const src = getSrc(product);
  const prefix = isWc(product) ? "wc" : "ai";
  const root = classificationHierarchy(src.input, product);
  const meta = $(`${prefix}VolMeta`);
  if (meta) meta.textContent = dateRange(src.input.date_range).replace(/^\d{4}-/, "");
  renderHierarchy(product, "volume", {
    root,
    unit: "条",
    restLabel: "条输入",
    emptyLabel: "任务分类数据待接入",
    ariaLabel: `${productLabel(product)}数据量分类`,
    onChange({ root: normalized }) {
      const stats = $(`${prefix}VolStats`);
      if (!stats) return;
      const classified = normalized.children.reduce((sum, node) => sum + node.value, 0);
      const useClassified = classified > 0 && classified < normalized.value;
      stats.innerHTML = [
        ["体量", fmtBytes(src.input.bytes)],
        [useClassified ? "已归类" : "文件", useClassified ? fmt(classified) : fmt(src.input.files)],
        ["已评测", fmt(src.input.evaluated)],
      ].map(([label, value]) => `<span>${label} <b>${value}</b></span>`).join("");
    },
  });
}

/* ------------------------------------------------------------- evaluation */

function evaluationRows(product) {
  const out = getSrc(product).output || {};
  const keys = isWc(product) ? ["a_expert", "a_fast", "b_expert", "b_fast"] : ["fast", "expert"];
  return keys.map((key) => {
    const version = (out.versions && out.versions[key]) || {};
    const core = out.meets_core && out.meets_core[key];
    return {
      name: VERSION_DEFS[key].label,
      color: VERSION_DEFS[key].color(),
      answers: maybeNumber(version.answers ?? (out.by_model && out.by_model[key])),
      core: core != null && core !== "" && Number.isFinite(Number(core)) ? Number(core) : null,
      p50: maybeNumber(version.p50),
      tokens: maybeNumber(version.tokens),
    };
  });
}

function renderEvalVersions(product) {
  const el = $(isWc(product) ? "wcModels" : "aiModels");
  if (!el) return;
  const rows = evaluationRows(product);
  const empty = !rows.some((row) => row.answers > 0);
  const section = el.closest(".eval-versions");
  if (section) section.classList.toggle("is-empty", empty);
  if (empty) {
    el.innerHTML = `<div class="ev-empty">评测输出待接入</div>`;
    return;
  }
  // Keep the same columns for both products. Missing core data is not an answer-count metric.
  el.innerHTML = rows.map((row) => {
    const display = row.core == null ? "—" : `${row.core.toFixed(1)}%`;
    const width = row.core == null ? 0 : clamp(row.core, 0, 100);
    const metricLabel = row.core == null ? "核心达成率暂无数据" : `核心达成率 ${display}`;
    const title = `${esc(row.name)} · ${fmt(row.answers)} 条回答 · 核心 ${display} · P50 ${row.p50 ? row.p50.toFixed(1) + "s" : "—"} · Tokens ${fmtTokens(row.tokens)}`;
    return (
      `<div class="ev-row" style="--c:${row.color}" title="${title}">` +
        `<span class="ev-model"><i aria-hidden="true"></i><span>${esc(row.name)}</span></span>` +
        `<span class="ev-count">${fmt(row.answers)} 条</span>` +
        `<span class="ev-meter" role="img" aria-label="${esc(row.name)} ${metricLabel}">` +
          `<span class="ev-meter-track"><i style="width:${width.toFixed(2)}%"></i></span>` +
          `<b>${display}</b>` +
        `</span>` +
      `</div>`
    );
  }).join("") + `<div class="ev-scale" aria-hidden="true"><span>0</span><span>50%</span><span>100%</span></div>`;
}

function renderDifficulty(product) {
  const el = $(isWc(product) ? "wcDifficulty" : "aiDifficulty");
  if (!el) return;
  const src = getSrc(product);
  const counts = Object.create(null);
  let total = 0;
  Object.values((src.output && src.output.versions) || {}).forEach((v) => {
    Object.entries(v.difficulty || {}).forEach(([k, n]) => {
      const count = Math.max(0, Number(n) || 0);
      counts[k] = (counts[k] || 0) + count;
      total += count;
    });
  });
  if (!total) {
    ((src.input && src.input.categories && src.input.categories.difficulty) || []).forEach((item) => {
      const count = Math.max(0, Number(item.value) || 0);
      if (!count) return;
      counts[item.name] = (counts[item.name] || 0) + count;
      total += count;
    });
  }
  if (!total) {
    const totalEl = $(isWc(product) ? "wcDiffTotal" : "aiDiffTotal");
    if (totalEl) totalEl.textContent = "暂无数据";
    el.innerHTML = `<div class="diff-empty">难度标注待接入</div>`;
    return;
  }
  const order = ["简单", "中等", "困难", "复杂"];
  const colors = { 简单: T.wcMid, 中等: T.wc, 困难: T.bMid, 复杂: T.b };
  // Missing annotations and other source labels still belong to the total.
  // Keep them visible so the last named segment never absorbs the remainder.
  Object.keys(counts).forEach((name) => {
    if (!order.includes(name) && counts[name] > 0) {
      order.push(name);
      colors[name] = T.faint;
    }
  });
  let cursor = 0;
  const stops = order.map((k) => {
    const from = cursor;
    cursor += pct(counts[k] || 0, total);
    return `${colors[k]} ${from.toFixed(2)}% ${cursor.toFixed(2)}%`;
  });
  const totalEl = $(isWc(product) ? "wcDiffTotal" : "aiDiffTotal");
  if (totalEl) totalEl.textContent = `${fmt(total)} 条`;
  el.innerHTML =
    `<div class="diff-layout">` +
      `<div class="diff-donut" role="img" aria-label="难度构成，共 ${fmt(total)} 条" style="--diff-gradient:conic-gradient(from -90deg, ${stops.join(",")})">` +
        `<span><b>${fmt(total)}</b><em>条评测</em></span>` +
      `</div>` +
      `<div class="diff-legend">` +
      order
        .map(
          (k) =>
            `<span title="${esc(k)} · ${fmt(counts[k] || 0)} 条 · ${pct(counts[k] || 0, total).toFixed(1)}%">` +
              `<i style="background:${colors[k]}"></i><em>${esc(k)}</em><b>${pct(counts[k] || 0, total).toFixed(0)}%</b><small>${fmt(counts[k] || 0)} 条</small>` +
            `</span>`
        )
        .join("") +
      `</div>` +
    `</div>`;
}

function outputP50(src) {
  if (src.output && src.output.p50) return Number(src.output.p50);
  const days = (src.output && src.output.per_day) || [];
  const withP50 = days.filter((d) => Number(d.p50) > 0);
  if (withP50.length) {
    const total = withP50.reduce((n, d) => n + Math.max(1, Number(d.answers) || 1), 0);
    return withP50.reduce((n, d) => n + Number(d.p50) * Math.max(1, Number(d.answers) || 1), 0) / total;
  }
  const versions = Object.values((src.output && src.output.versions) || {});
  const valid = versions.filter((v) => Number(v.p50) > 0);
  const total = valid.reduce((n, v) => n + Math.max(1, Number(v.answers) || 1), 0);
  if (!total) return 0;
  return valid.reduce((n, v) => n + Number(v.p50) * Math.max(1, Number(v.answers) || 1), 0) / total;
}

function renderEvalFacts(product) {
  const src = getSrc(product);
  const out = src.output || {};
  const p50 = outputP50(src);
  const el = $(isWc(product) ? "wcEvalStats" : "aiEvalStats");
  if (!el) return;
  el.innerHTML = [
    ["问题", fmt(out.problems || 0)],
    ["Tokens", fmtTokens(out.tokens || 0)],
    ["P50", p50 ? p50.toFixed(1) + "s" : "—"],
  ]
    .map(([label, value]) => `<span><em>${label}</em><b>${value}</b></span>`)
    .join("");
}

function renderEvaluation(product) {
  const wc = isWc(product);
  const src = getSrc(product);
  const out = src.output || {};
  const input = src.input;
  const evaluated = input.evaluated || 0;
  const pending = input.pending || 0;
  const total = input.total || 0;
  const cover = clamp(pct(evaluated, total), 0, 100);

  setNum(wc ? "wcEvaluated" : "aiEvaluated", evaluated);
  setNum(wc ? "wcCoverPct" : "aiCoverPct", cover, { decimals: 1, suffix: "%" });

  const inputTotal = $(wc ? "wcInputTotal" : "aiInputTotal");
  if (inputTotal) inputTotal.textContent = fmt(total);
  const done = $(wc ? "wcCoverDone" : "aiCoverDone");
  if (done) done.textContent = fmt(evaluated);
  const rest = $(wc ? "wcCoverPending" : "aiCoverPending");
  if (rest) rest.textContent = fmt(pending);
  const coverBar = $(wc ? "wcCoverBar" : "aiCoverBar");
  if (coverBar) {
    coverBar.style.setProperty("--coverage", `${cover.toFixed(2)}%`);
    coverBar.setAttribute(
      "aria-label",
      `评测覆盖率 ${cover.toFixed(1)}%，已评测 ${fmt(evaluated)} 条，共 ${fmt(total)} 条`
    );
  }

  const days = (out.per_day || []).filter((d) => Number(d.answers) > 0);
  const batchEl = $(wc ? "wcCoverBatch" : "aiCoverBatch");
  if (batchEl) {
    batchEl.textContent = days.length ? `${days[days.length - 1].date.slice(5)} 批次` : "输出待接入";
  }
  const meta = $(wc ? "wcEvalMeta" : "aiEvalMeta");
  if (meta) meta.textContent = "";

  renderEvalVersions(product);
  renderDifficulty(product);
  renderEvalFacts(product);
}

/* ----------------------------------------------------------- attribution */

function shortComp(name) {
  const s = String(name || "");
  const paren = s.match(/^其他工具（(.+)）$/);
  if (paren) return paren[1];
  const latin = s.match(/^[A-Za-z0-9_.-]+\s+(.+)$/);
  if (latin) return latin[1];
  return s;
}

function versionLabel(id) {
  return (VERSION_DEFS[id] && VERSION_DEFS[id].label) || id;
}

function attributionRows(product) {
  const src = getSrc(product);
  const comp = (src.output && src.output.components) || {};
  let matrix;
  if (comp.by_version && Object.keys(comp.by_version).length) {
    matrix = comp.by_version;
  } else if (comp.by_model && Object.keys(comp.by_model).length) {
    matrix = comp.by_model;
  } else if (["fast", "expert"].some((key) => Array.isArray(comp[key]))) {
    matrix = Object.fromEntries(["fast", "expert"].map((key) => [
      key, Object.fromEntries((comp.names || []).map((name, i) => [name, (comp[key] || [])[i] || 0])),
    ]));
  } else {
    const legacy = src.components || {};
    matrix = Object.fromEntries(["A", "B"].map((key) => [
      `${key} 组`, Object.fromEntries((legacy.names || []).map((name, i) => [name, (legacy[key] || [])[i] || 0])),
    ]));
  }
  return Object.entries(matrix).map(([key, components]) => ({
    key,
    label: versionLabel(key),
    color: VERSION_DEFS[key] ? VERSION_DEFS[key].color() : key === "B 组" ? C.b : C.a,
    components: Object.fromEntries(Object.entries(components || {})
      .map(([name, value]) => [name, maybeNumber(value)]).filter(([, value]) => value > 0)),
  })).filter((row) => Object.keys(row.components).length);
}

function buildSankey(product) {
  const rows = attributionRows(product);
  const totals = new Map();
  rows.forEach((row) => Object.entries(row.components).forEach(([name, value]) => {
    totals.set(name, (totals.get(name) || 0) + value);
  }));
  const ranked = [...totals].sort((a, b) => b[1] - a[1]);
  const top = ranked.slice(0, 6).map(([name]) => name);
  const extra = ranked.slice(6).map(([name]) => name);
  const phaseColor = T.mode === "dark" ? T.surface3 : T.track;
  const nodes = rows.map((row) => ({
    name: `source:${row.key}`,
    display: row.label,
    depth: 0,
    itemStyle: { color: row.color },
    label: { position: "left" },
    tipMeta: row.key,
  }));
  const addPhase = (key, label, meta = label) => nodes.push({
    name: key,
    display: shortComp(label),
    depth: 1,
    itemStyle: { color: phaseColor },
    label: { position: "right" },
    tipMeta: meta,
  });
  top.forEach((name) => addPhase(`phase:${name}`, name));
  if (extra.length) addPhase("phase:other", "其他环节", `${extra.length} 类长尾`);

  const links = [];
  const addLink = (row, target, label, value) => {
    if (value <= 0) return;
    links.push({
      source: `source:${row.key}`,
      target,
      sourceLabel: row.label,
      targetLabel: label,
      value,
      lineStyle: { color: hexA(row.color, 0.42), opacity: 0.6 },
    });
  };
  rows.forEach((row) => {
    top.forEach((name) => addLink(row, `phase:${name}`, name, row.components[name] || 0));
    if (extra.length) {
      addLink(row, "phase:other", "其他环节", extra.reduce((sum, name) => sum + (row.components[name] || 0), 0));
    }
  });
  return { nodes, links };
}

function sankeyOption(graph) {
  const { nodes, links } = graph;
  return {
    animationDuration: REDUCED ? 0 : 650,
    animationEasing: "cubicOut",
    tooltip: {
      ...tip,
      formatter: (p) => {
        const color = (p.data && p.data.itemStyle && p.data.itemStyle.color) || T.muted;
        if (p.dataType === "edge") {
          const s = p.data.sourceLabel || p.data.source;
          const t = p.data.targetLabel || p.data.target;
          return tipCard(
            tipHead(`${s} → ${t}`, fmt(p.value), color) +
              tipRow(color, "问题数", fmt(p.value))
          );
        }
        const d = p.data || {};
        return tipCard(
          tipHead(d.display || p.name, "", color) +
            tipRow(color, "问题数", fmt(p.value)) +
            (d.tipMeta ? `<div class="tip-path">${esc(d.tipMeta)}</div>` : "")
        );
      },
    },
    series: [
      {
        type: "sankey",
        left: 56,
        right: 92,
        top: 14,
        bottom: 2,
        nodeWidth: 8,
        nodeGap: 9,
        layoutIterations: 40,
        nodeAlign: "justify",
        draggable: false,
        data: nodes,
        links,
        lineStyle: { curveness: 0.55, opacity: 0.5 },
        itemStyle: { borderWidth: 0, borderRadius: 2 },
        label: {
          fontSize: 11,
          fontFamily: FONT,
          color: T.ink2,
          distance: 5,
          overflow: "truncate",
          formatter: (p) => (p.data && p.data.display) || p.name,
        },
        emphasis: {
          focus: "adjacency",
          lineStyle: { opacity: 0.8 },
          label: { fontWeight: 600 },
        },
      },
    ],
  };
}

function renderAttribution(product) {
  const wc = isWc(product);
  const src = getSrc(product);
  const out = src.output || {};
  const id = wc ? "wcAttr" : "aiAttr";
  const el = $(id);
  const graph = buildSankey(product);

  setNum(wc ? "wcProblems" : "aiProblems", out.problems ?? graph.links.reduce((n, l) => n + l.value, 0));

  if (!el) return;
  if (!graph.links.length) {
    showChartEmpty(el, "归因数据待接入");
    return;
  }
  el.innerHTML = "";
  createChart(el, sankeyOption(graph));
  el.style.removeProperty("cursor");
}

/* --------------------------------------------------------------- cluster */

function renderCluster(product) {
  const src = getSrc(product);
  const prefix = isWc(product) ? "wc" : "ai";
  renderHierarchy(product, "cluster", {
    root: src.cluster?.tree || null,
    unit: "会话",
    restLabel: "会话",
    emptyLabel: "聚类数据待接入",
    ariaLabel: `${productLabel(product)}聚类体系`,
    onChange({ root, current, expanded, path }) {
      const meta = $(`${prefix}ClusterMeta`);
      const trail = [...path.slice(1), ...(expanded ? [expanded] : [])];
      if (meta) {
        meta.textContent = !root.children.length ? "" : trail.length
          ? `L${(expanded || current).depth} · ${trail.map((node) => node.name).join(" / ")}`
          : `${hierarchyDepth(root)} 级聚类 · ${root.children.length} 个分支`;
        meta.title = meta.textContent;
      }
      const stats = $(`${prefix}ClusterStats`);
      if (stats) stats.innerHTML = root.children.length
        ? `<span>${fmt((expanded || current).items)} <em>条目</em></span>` : "";
    },
  });
}

/* ------------------------------------------------------------ prediction */

function predictionModel(product) {
  const state = board.predict[product];
  const source = getSrc(product);
  const generatedAt = board.data.generated_at;
  if (!state.model || state.source !== source || state.generatedAt !== generatedAt) {
    state.model = predictionData(source, product, generatedAt);
    state.source = source;
    state.generatedAt = generatedAt;
  }
  return state.model;
}

function predictionView(product) {
  const model = predictionModel(product);
  return predictionSnapshot(model);
}

function predictionTimeAxis(first, last) {
  const span = Math.max(last - first, 86400000);
  return {
    type: "time",
    min: first === last ? first - 86400000 : first,
    max: last,
    splitNumber: 4,
    axisLine: { show: false },
    axisTick: { show: false },
    splitLine: { show: false },
    axisLabel: {
      fontSize: 11, color: T.faint, fontFamily: FONT,
      margin: 10, hideOverlap: true,
      formatter: (value) => span < 2 * 86400000
        ? predictionInputValue(value).slice(11)
        : span > 365 * 86400000 ? predictionInputValue(value).slice(0, 7) : predictionTimeLabel(value),
    },
  };
}

function renderPredDistribution(snapshot, chartEl) {
  if (!snapshot.total || !snapshot.scheduled) {
    showChartEmpty(chartEl, snapshot.total ? "暂无答案公布时间数据" : "题库暂无预测题");
    return;
  }
  const colors = paletteByName(snapshot.distribution.map((series) => series.name));
  const totals = new Map(snapshot.distribution.map((series) => [series.name, series.value]));
  createChart(chartEl, {
    animationDuration: REDUCED ? 0 : 450,
    animationEasing: "cubicOut",
    tooltip: {
      ...tip,
      trigger: "axis",
      axisPointer: { type: "line", lineStyle: { color: T.muted, type: "dashed" } },
      formatter(params) {
        if (!params.length) return "";
        const rows = params.filter((row) => row.seriesName !== "累计可解");
        const totalPoint = params.find((row) => row.seriesName === "累计可解");
        const total = totalPoint ? Number(totalPoint.value[1]) : rows.reduce((sum, row) => sum + (Number(row.value[1]) || 0), 0);
        return tipCard(
          tipHead(predictionTimeLabel(params[0].axisValue, true), `${fmt(total)} 题可解`, T.forecast) +
          rows.filter((row) => Number(row.value[1]) > 0)
            .sort((a, b) => Number(b.value[1]) - Number(a.value[1]))
            .map((row) => tipRow(row.color, esc(row.seriesName), `${fmt(row.value[1])} 题 · ${pct(row.value[1], total).toFixed(1)}%`)).join("")
        );
      },
    },
    legend: {
      type: "scroll", top: 0, left: 0, right: 0,
      data: snapshot.distribution.map((series) => series.name),
      itemWidth: 8, itemHeight: 8, icon: "circle", itemGap: 12,
      textStyle: { fontSize: 11, color: T.muted, fontFamily: FONT },
      formatter: (name) => `${name} ${fmt(totals.get(name) || 0)}`,
      pageIconSize: 9,
      pageTextStyle: { fontFamily: FONT, color: T.muted, fontSize: 11 },
    },
    grid: { left: 40, right: 78, top: 30, bottom: 28 },
    xAxis: predictionTimeAxis(snapshot.cumulative[0][0], snapshot.cutoff),
    yAxis: {
      type: "value", min: 0, minInterval: 1, splitNumber: 3,
      axisLine: { show: false }, axisTick: { show: false },
      axisLabel: { fontSize: 11, color: T.faint, fontFamily: FONT },
      splitLine: { lineStyle: { color: T.hairline } },
    },
    series: [
      ...snapshot.distribution.map((series) => ({
        name: series.name, type: "line", stack: "available", step: "end",
        data: series.values, showSymbol: false, symbol: "circle", symbolSize: 5,
        lineStyle: { width: 1.5, color: colors.get(series.name) },
        itemStyle: { color: colors.get(series.name) },
        areaStyle: { color: colors.get(series.name), opacity: 0.16 },
        emphasis: { focus: "series" },
      })),
      {
        name: "累计可解", type: "line", step: "end", data: snapshot.cumulative,
        showSymbol: false, symbol: "circle", symbolSize: 5,
        lineStyle: { width: 2.4, color: T.forecast }, itemStyle: { color: T.forecast },
        endLabel: {
          show: true, color: T.ink, fontSize: 11, fontWeight: 600,
          formatter: (params) => `${fmt(params.value[1])} 题`,
        },
        emphasis: { focus: "none" },
      },
    ],
  });
}

function renderPredAccuracy(snapshot, chartEl) {
  if (!snapshot.accuracy.length) {
    showChartEmpty(chartEl, "暂无已公布答案的准确率数据");
    return;
  }
  const points = snapshot.accuracy.flatMap((curve) => curve.points);
  const first = points.reduce((min, point) => Math.min(min, point.at), Infinity);
  const last = points.reduce((max, point) => Math.max(max, point.at), -Infinity);
  const minRate = points.reduce((min, point) => Math.min(min, point.accuracy), 100);
  createChart(chartEl, {
    animationDuration: REDUCED ? 0 : 450,
    animationEasing: "cubicOut",
    tooltip: {
      ...tip,
      trigger: "axis",
      axisPointer: { type: "line", lineStyle: { color: T.muted, type: "dashed" } },
      formatter(params) {
        if (!params.length) return "";
        return tipCard(
          tipHead(predictionTimeLabel(params[0].axisValue, true), "预测准确率", T.forecast) +
          params.slice().sort((a, b) => Number(b.value[1]) - Number(a.value[1]))
            .map((row) => {
              const curve = snapshot.accuracy.find((item) => versionLabel(item.key) === row.seriesName);
              const point = curve && curve.points[row.dataIndex];
              const count = point && point.total != null ? ` · ${fmt(point.correct)} / ${fmt(point.total)} 题` : "";
              return tipRow(row.color, esc(row.seriesName), `${Number(row.value[1]).toFixed(1)}%${count}`);
            }).join("")
        );
      },
    },
    legend: {
      type: "scroll", top: 0, left: 0, right: 0,
      itemWidth: 8, itemHeight: 8, icon: "circle", itemGap: 12,
      textStyle: { fontSize: 11, color: T.muted, fontFamily: FONT },
      pageIconSize: 9,
      pageTextStyle: { fontFamily: FONT, color: T.muted, fontSize: 11 },
    },
    grid: { left: 40, right: 106, top: 30, bottom: 28 },
    xAxis: predictionTimeAxis(first, last),
    yAxis: {
      type: "value", min: Math.max(0, Math.floor((minRate - 10) / 10) * 10), max: 100,
      splitNumber: 4, minInterval: 10,
      axisLine: { show: false }, axisTick: { show: false },
      axisLabel: { fontSize: 11, color: T.faint, fontFamily: FONT, formatter: "{value}%" },
      splitLine: { lineStyle: { color: T.hairline } },
    },
    series: snapshot.accuracy.map((curve, index) => {
      const color = VERSION_DEFS[curve.key] ? VERSION_DEFS[curve.key].color() : ringPalette(snapshot.accuracy.length)[index];
      return {
        name: versionLabel(curve.key), type: "line",
        data: curve.points.map((point) => [point.at, point.accuracy]),
        smooth: 0.25, smoothMonotone: "x",
        symbol: "circle", symbolSize: 6, showSymbol: false,
        lineStyle: { width: 2.6, color, cap: "round" },
        itemStyle: { color, borderColor: T.surface, borderWidth: 2 },
        emphasis: { focus: "series", lineStyle: { width: 3.5 } },
        endLabel: {
          show: true, distance: 8, color, fontSize: 11, fontWeight: 600,
          formatter: (params) => `${params.seriesName} ${Number(params.value[1]).toFixed(1)}%`,
        },
        labelLayout: { moveOverlap: "shiftY" },
      };
    }),
  });
}

function renderPredAttribution(snapshot, chartEl) {
  const graph = snapshot.attribution;
  if (!graph || !Array.isArray(graph.models) || !Array.isArray(graph.errors)) {
    showChartEmpty(chartEl, "预测归因数据待接入");
    return;
  }
  const errorColors = [T.b, T.bMid, T.wcMid, T.muted];
  const nodes = [];
  const links = [];
  graph.models.forEach((key, index) => {
    const color = VERSION_DEFS[key] ? VERSION_DEFS[key].color() : ringPalette(graph.models.length)[index];
    nodes.push({ name: `model:${key}`, display: versionLabel(key), itemStyle: { color }, label: { position: "left" } });
    graph.errors.forEach((error, i) => {
      const value = Number((graph.flows && graph.flows[key] || [])[i]) || 0;
      if (value > 0) links.push({
        source: `model:${key}`, target: `error:${i}`,
        sourceLabel: versionLabel(key), targetLabel: error, value,
        lineStyle: { color: hexA(color, 0.4), opacity: 0.55 },
      });
    });
  });
  graph.errors.forEach((error, index) => nodes.push({
    name: `error:${index}`, display: error,
    itemStyle: { color: errorColors[index % errorColors.length] }, label: { position: "right" },
  }));
  if (!links.length) {
    showChartEmpty(chartEl, "暂无预测归因问题");
    return;
  }
  createChart(chartEl, {
    animationDuration: REDUCED ? 0 : 450,
    tooltip: {
      ...tip,
      formatter: (params) => tipCard(
        tipHead(esc(params.dataType === "edge" ? `${params.data.sourceLabel} → ${params.data.targetLabel}` : params.data.display), "", T.forecast) +
        tipRow(T.forecast, "错误数", fmt(params.value))
      ),
    },
    series: [{
      type: "sankey", left: 58, right: 76, top: 14, bottom: 8,
      nodeWidth: 8, nodeGap: 12, layoutIterations: 32, nodeAlign: "justify", draggable: false,
      data: nodes, links,
      lineStyle: { curveness: 0.55, opacity: 0.5 }, itemStyle: { borderWidth: 0, borderRadius: 2 },
      label: { fontSize: 11, fontFamily: FONT, color: T.ink2, distance: 4, overflow: "truncate", formatter: (params) => params.data.display },
      emphasis: { focus: "adjacency", lineStyle: { opacity: 0.8 } },
    }],
  });
}

function renderPrediction(product) {
  const prefix = isWc(product) ? "wc" : "ai";
  const snapshot = predictionView(product);
  const dim = board.predict[product].dim;
  const tabs = $(`${prefix}PredictTabs`);
  if (tabs) tabs.querySelectorAll(".predict-tab").forEach((tab) => {
    const on = tab.dataset.dim === dim;
    tab.classList.toggle("is-active", on);
    tab.setAttribute("aria-selected", String(on));
  });
  const status = $(`${prefix}PredStatus`);
  if (status) status.hidden = !snapshot.prototype;
  setNum(`${prefix}PredTotal`, snapshot.total);
  const available = $(`${prefix}PredAvailable`);
  if (available) available.textContent = fmt(snapshot.available);
  const pending = $(`${prefix}PredPending`);
  if (pending) pending.textContent = fmt(snapshot.pending);
  const progress = pct(snapshot.available, snapshot.total);
  const gauge = $(`${prefix}PredGauge`);
  if (gauge) {
    gauge.style.setProperty("--progress", `${progress.toFixed(2)}%`);
    gauge.setAttribute("aria-label", `截面可解题占比 ${progress.toFixed(1)}%，可解 ${fmt(snapshot.available)} 题，共 ${fmt(snapshot.total)} 题`);
  }
  setNum(`${prefix}PredGaugeText`, progress, { decimals: 1, suffix: "%" });
  const chartEl = $(`${prefix}ForecastChart`);
  if (!chartEl) return;
  chartEl.setAttribute("aria-label", `${productLabel(product)}${{ distribution: "预测数据分布", accuracy: "预测准确率", attribution: "预测归因" }[dim]}`);
  chartEl.style.cursor = "default";
  settleCounters(chartEl.closest(".card--predict"));
  if (dim === "distribution") renderPredDistribution(snapshot, chartEl);
  else if (dim === "accuracy") renderPredAccuracy(snapshot, chartEl);
  else renderPredAttribution(snapshot, chartEl);
}

function bindPredictTabs(product) {
  const prefix = isWc(product) ? "wc" : "ai";
  const tabs = $(`${prefix}PredictTabs`);
  if (!tabs) return;
  const order = ["distribution", "accuracy", "attribution"];
  tabs.onclick = (event) => {
    const tab = event.target.closest(".predict-tab");
    if (!tab) return;
    board.predict[product].dim = tab.dataset.dim;
    renderPrediction(product);
  };
  tabs.onkeydown = (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const index = order.indexOf(board.predict[product].dim);
    const next = order[(index + (event.key === "ArrowRight" ? 1 : order.length - 1)) % order.length];
    board.predict[product].dim = next;
    renderPrediction(product);
    tabs.querySelector(`.predict-tab[data-dim="${next}"]`).focus();
  };
}

/* ------------------------------------------------------------------ page */

function mountBoardCards() {
  const template = $("dataCardsTemplate");
  if (!template) return;
  document.querySelectorAll(".view--data .page[data-product]").forEach((page) => {
    const grid = page.querySelector(".page-grid");
    if (!grid || grid.childElementCount) return;
    const prefix = isWc(page.dataset.product) ? "wc" : "ai";
    const cards = template.content.cloneNode(true);
    cards.querySelectorAll("[data-card-id]").forEach((el) => {
      el.id = `${prefix}${el.dataset.cardId}`;
      el.removeAttribute("data-card-id");
    });
    grid.append(cards);
  });
}

function renderProduct(product) {
  renderVolume(product);
  renderEvaluation(product);
  renderAttribution(product);
  renderCluster(product);
  renderPrediction(product);
  // A product rendered after the reveal must write its final counters itself;
  // otherwise the lazy page shows the initial "0" placeholders.
  settleCounters(document.querySelector(`.view--data .page[data-product="${product}"]`) || document);
  board.rendered[product] = true;
}

function renderedProducts() {
  return ["wencai", "aime"].filter((product) => board.rendered[product]);
}

export function initBoard(data, opts = {}) {
  mountBoardCards();
  board.data = data;
  board.product = ["wencai", "aime"].includes(opts.product) ? opts.product : "wencai";
  board.rendered = { wencai: false, aime: false };
  readTokens();
  bindPredictTabs("wencai");
  bindPredictTabs("aime");
  // Render only the product that is visible now. The other one is rendered on
  // its first switch, so a cold data view does half the chart work.
  setBoardProduct(board.product);
}

export function setBoardProduct(product) {
  if (!["wencai", "aime"].includes(product)) return;
  board.product = product;
  document.querySelectorAll(".view--data .page").forEach((page) => {
    const on = page.dataset.product === product;
    page.classList.toggle("is-active", on);
    page.setAttribute("aria-hidden", String(!on));
  });
  if (!board.rendered[product]) renderProduct(product);
  resizeAllCharts();
}

export function refreshBoard() {
  readTokens();
  const products = renderedProducts();
  (products.length ? products : [board.product]).forEach(renderProduct);
}

export function resizeBoard() {
  resizeAllCharts();
}

export function getBoardProduct() {
  return board.product;
}
