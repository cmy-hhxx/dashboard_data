/* Daily Top-10 anomaly board:
   1. Top interactive stage (.mxd-top) that flips in 3D between:
      - Front (.mxd-face-heat): Paged 42-day heatmap (14 columns × 3 rows = 6 weeks per page,
        7 + 7 columns aligned symmetrically over the two Top-10 boards below). Supports three
        metrics (问题数 / Trace 数 / 问题÷Trace 比例) and shows date, problem count, trace count
        and problems-per-trace ratio in every cell.
      - Back (.mxd-face-line): All-time interactive multi-problem line trend chart (draggable &
        zoomable via LightweightCharts, with an 上涨问题 / 下降问题 toggle button and per-problem chips).
   2. Bottom symmetric 10-row anomaly boards (.mxd-boards):
      - Left: Top 10 most frequent specific problems on the selected day.
      - Right: Top 10 most dropped specific problems on the selected day. */
import { compact, esc, fmt, hideTip, REDUCED, sum } from "./core.js";
import { createTrendChart } from "./kline_chart.js";
import { patternName as patName, patternOf } from "./taxonomy.js";
import { traceShares } from "./trace_analysis.js";

const TOP_LIMIT = 10;
const LINE_LIMIT = 5;
const HEAT_COLS = 10;
const HEAT_ROWS = 3;
const HEAT_PAGE_SIZE = HEAT_COLS * HEAT_ROWS; // 10 × 3 = 30 days
const LINE_COLORS_UP = ["var(--accent)", "#c86d3b", "#6e59bd", "#248277", "#9e6378"];
const LINE_COLORS_DOWN = ["#248277", "var(--accent)", "#6e59bd", "#4e8752", "#b57c3c"];

const signed = (n) => (n > 0 ? `+${fmt(n)}` : n < 0 ? `-${fmt(Math.abs(n))}` : "0");
const pairNum = (n) => (Math.abs(n) >= 10000 ? compact(n) : fmt(n));
const ratioText = (ratio) => (ratio > 0 ? fmt(ratio, 2) : "0.00");

/* Divide days into pages of at most 30 days (10 × 3) so the newest page (default) always shows
   a full 30-day window when total days >= 30, and earlier pages hold the older dates in order. */
export function buildHeatPages(days, pageSize = HEAT_PAGE_SIZE) {
  if (!Array.isArray(days) || !days.length) return [];
  if (days.length <= pageSize) return [days];
  const pages = [];
  const headCount = days.length - pageSize;
  for (let i = 0; i < headCount; i += pageSize) {
    pages.push(days.slice(i, Math.min(i + pageSize, headCount)));
  }
  pages.push(days.slice(days.length - pageSize));
  return pages;
}

export function buildDailyTopModel(trend, tax = {}) {
  const dates = Array.isArray(trend?.dates) ? trend.dates.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)) : [];
  const rawNodes = Array.isArray(trend?.nodes) ? trend.nodes : [];
  const rawCells = Array.isArray(trend?.cells) ? trend.cells : [];
  if (!dates.length || !rawNodes.length || !rawCells.length) return null;

  const dateIndexMap = new Map();
  trend.dates.forEach((d, idx) => {
    const cleanIdx = dates.indexOf(d);
    if (cleanIdx >= 0) dateIndexMap.set(idx, cleanIdx);
  });

  const stageNames = new Map((tax?.stages || []).map((s) => [s.id, s.name]));
  const mechNames = new Map((tax?.mechanisms || []).map((m) => [m.id, m.name]));

  // Specific problems live at depth 3 (S{x}.M{y}.{z}) in the taxonomy, where each node already
  // aggregates any depth-4 children in trends.cells without double-counting. Fall back to leaf
  // nodes when a synthetic fixture only defines shallower codes.
  const hasDepth3 = rawNodes.some((code) => String(code).split(".").length === 3);
  const nodeSet = new Set(rawNodes);
  const pickedIdxs = rawNodes
    .map((code, ni) => ({ code: String(code), ni, depth: String(code).split(".").length }))
    .filter(({ code, depth }) => (hasDepth3
      ? depth === 3
      : !rawNodes.some((other) => other !== code && String(other).startsWith(`${code}.`))));

  if (!pickedIdxs.length) return null;

  const dayCount = dates.length;
  const traces = new Float64Array(dayCount);
  (trend.base || []).forEach(([rawDi, , , , tr]) => {
    const di = dateIndexMap.get(rawDi);
    if (di != null) traces[di] += Number(tr) || 0;
  });

  const rawTraceDaily = Array.isArray(trend?.trace_severity?.daily) ? trend.trace_severity.daily : null;
  const traceSevsByDay = Array.from({ length: dayCount }, () => [0, 0, 0, 0, 0, 0]);
  if (rawTraceDaily) {
    rawTraceDaily.forEach((row, rawDi) => {
      const di = dateIndexMap.get(rawDi);
      if (di == null || !Array.isArray(row) || row.length < 6) return;
      for (let k = 0; k < 6; k += 1) {
        traceSevsByDay[di][k] = Number(row[k]) || 0;
      }
    });
  }

  const byNodeIdx = new Map();
  pickedIdxs.forEach(({ code, ni }) => {
    const parts = code.split(".");
    const stageId = parts[0] || code;
    const mechId = parts[1] || "";
    const pat = patternOf(tax, code);
    byNodeIdx.set(ni, {
      ni,
      code,
      name: patName(tax, code) || code,
      stageId,
      stageName: stageNames.get(stageId) || stageId,
      mechId,
      mechName: mechNames.get(mechId) || mechId,
      plain: pat?.plain || pat?.def || "",
      counts: new Float64Array(dayCount),
      p01: new Float64Array(dayCount),
      hits: new Float64Array(dayCount),
      sevs: Array.from({ length: dayCount }, () => [0, 0, 0, 0, 0]),
      totalCount: 0,
      maxCount: 0,
    });
  });

  rawCells.forEach((raw) => {
    if (!Array.isArray(raw)) return;
    const di = dateIndexMap.get(raw[0]);
    const node = byNodeIdx.get(raw[2]);
    if (di == null || !node) return;
    const p0 = Number(raw[5]) || 0;
    const p1 = Number(raw[6]) || 0;
    const p2 = Number(raw[7]) || 0;
    const p3 = Number(raw[8]) || 0;
    const p4 = Number(raw[9]) || 0;
    const sumP = p0 + p1 + p2 + p3 + p4;
    node.counts[di] += sumP;
    node.p01[di] += p0 + p1;
    node.sevs[di][0] += p0;
    node.sevs[di][1] += p1;
    node.sevs[di][2] += p2;
    node.sevs[di][3] += p3;
    node.sevs[di][4] += p4;
    if (raw[15] != null) node.hits[di] += Number(raw[15]) || 0;
  });

  const nodes = [...byNodeIdx.values()].filter((node) => {
    let total = 0;
    let max = 0;
    for (let di = 0; di < dayCount; di += 1) {
      const c = node.counts[di];
      total += c;
      if (c > max) max = c;
    }
    node.totalCount = total;
    node.maxCount = max;
    return total > 0 || nodeSet.has(node.code);
  });

  const byCode = new Map(nodes.map((n) => [n.code, n]));
  const totalAllTraces = Math.max(1, sum([...traces]));
  const limit = Math.min(TOP_LIMIT, nodes.length);

  const days = dates.map((date, di) => {
    let problems = 0;
    let p01 = 0;
    const sevs = [0, 0, 0, 0, 0];
    nodes.forEach((node) => {
      problems += node.counts[di];
      p01 += node.p01[di];
      for (let k = 0; k < 5; k += 1) sevs[k] += node.sevs[di][k];
    });
    const dayTraces = traces[di] || 0;
    const perTrace = dayTraces > 0 ? problems / dayTraces : 0;
    const rawTSevs = traceSevsByDay[di];
    const traceSevs = sum(rawTSevs) > 0
      ? rawTSevs.slice()
      : (() => {
          const est = sevs.map((n) => Math.min(n, dayTraces));
          const used = Math.min(dayTraces, sum(est));
          return [...est, Math.max(0, dayTraces - used)];
        })();

    const scaleSevs = (node, targetTotal) => {
      if (di > 0 && targetTotal === node.counts[di - 1]) return node.sevs[di - 1].slice();
      for (let k = di - 1; k >= 0; k -= 1) {
        if (node.counts[k] === targetTotal) return node.sevs[k].slice();
      }
      const curSum = sum(node.sevs[di]);
      if (curSum > 0 && targetTotal > 0) {
        const scaled = node.sevs[di].map((v) => Math.round((v * targetTotal) / curSum));
        const diff = targetTotal - sum(scaled);
        const maxIdx = scaled.indexOf(Math.max(...scaled));
        if (maxIdx >= 0) scaled[maxIdx] = Math.max(0, scaled[maxIdx] + diff);
        return scaled;
      }
      return [0, 0, 0, 0, targetTotal];
    };

    const baselineOf = (node) => {
      if (di > 0) return node.counts[di - 1];
      if (dayCount > 1) {
        const exp = Math.round((node.totalCount * (traces[di] || 1)) / totalAllTraces);
        return exp > node.counts[di] ? exp : node.maxCount;
      }
      return node.counts[di];
    };

    // 1. Top 10 most frequent specific problems on day `di`
    const appearSorted = [...nodes]
      .sort((a, b) => (
        b.counts[di] - a.counts[di]
        || b.p01[di] - a.p01[di]
        || b.hits[di] - a.hits[di]
        || b.totalCount - a.totalCount
        || a.code.localeCompare(b.code)
      ));
    const activeAppear = appearSorted.filter((n) => n.counts[di] > 0);
    const appearNodes = (activeAppear.length >= limit ? activeAppear : appearSorted).slice(0, limit);
    const topAppear = appearNodes.map((node) => {
      const count = node.counts[di];
      const prev = baselineOf(node);
      return {
        code: node.code,
        name: node.name,
        stageId: node.stageId,
        stageName: node.stageName,
        mechName: node.mechName,
        plain: node.plain,
        count,
        prev,
        delta: count - prev,
        p01: node.p01[di],
        sevs: node.sevs[di],
        prevSevs: scaleSevs(node, prev),
        hits: node.hits[di],
        share: problems > 0 ? (100 * count) / problems : 0,
      };
    });

    // Top rising specific problems on day `di` (for the multi-line chart's "上涨问题" mode)
    const riseSorted = [...nodes]
      .map((node) => {
        const count = node.counts[di];
        const prev = di > 0 ? node.counts[di - 1] : Math.min(node.counts[di], Math.round(node.totalCount / Math.max(1, dayCount)));
        return { node, count, prev, delta: count - prev };
      })
      .filter((x) => x.count > 0)
      .sort((a, b) => b.delta - a.delta || b.count - a.count || a.node.code.localeCompare(b.node.code));
    const topRise = riseSorted.slice(0, Math.min(LINE_LIMIT, riseSorted.length)).map(({ node, count, prev, delta }) => ({
      code: node.code,
      name: node.name,
      stageName: node.stageName,
      count,
      prev,
      delta,
    }));

    // 2. Top 10 most dropped specific problems on day `di`
    const topDrop = [];
    const picked = new Set();
    const pushDrop = (node, prev) => {
      const count = node.counts[di];
      const delta = count - prev;
      picked.add(node.code);
      topDrop.push({
        code: node.code,
        name: node.name,
        stageId: node.stageId,
        stageName: node.stageName,
        mechName: node.mechName,
        plain: node.plain,
        count,
        prev,
        delta,
        dropPct: prev > 0 ? (100 * Math.abs(delta)) / prev : 0,
        p01: node.p01[di],
        sevs: node.sevs[di],
        prevSevs: scaleSevs(node, prev),
        hits: node.hits[di],
      });
    };

    // Tier 1: Direct drop vs previous evaluated day (di - 1)
    if (di > 0) {
      const tier1 = nodes
        .filter((node) => node.counts[di] < node.counts[di - 1])
        .sort((a, b) => (
          (a.counts[di] - a.counts[di - 1]) - (b.counts[di] - b.counts[di - 1])
          || b.counts[di - 1] - a.counts[di - 1]
          || a.code.localeCompare(b.code)
        ));
      tier1.slice(0, limit).forEach((node) => pushDrop(node, node.counts[di - 1]));
    }

    // Tier 2: Drop vs prior active peak before day `di` (covers volume-surge days)
    if (topDrop.length < limit && di > 0) {
      const tier2 = [];
      nodes.forEach((node) => {
        if (picked.has(node.code)) return;
        let prior = 0;
        for (let k = 0; k < di; k += 1) {
          if (node.counts[k] > prior) prior = node.counts[k];
        }
        if (node.counts[di] < prior) tier2.push({ node, prev: prior, delta: node.counts[di] - prior });
      });
      tier2
        .sort((a, b) => a.delta - b.delta || b.prev - a.prev || a.node.code.localeCompare(b.node.code))
        .slice(0, limit - topDrop.length)
        .forEach(({ node, prev }) => pushDrop(node, prev));
    }

    // Tier 3: Drop vs volume-normalized daily baseline or multi-day peak (covers day 0)
    if (topDrop.length < limit) {
      const tier3 = [];
      nodes.forEach((node) => {
        if (picked.has(node.code)) return;
        const normExp = node.totalCount > 0 ? Math.max(1, Math.round((node.totalCount * (traces[di] || 1)) / totalAllTraces)) : 0;
        const prev = normExp > node.counts[di] ? normExp : node.maxCount;
        if (node.counts[di] < prev) tier3.push({ node, prev, delta: node.counts[di] - prev });
      });
      tier3
        .sort((a, b) => a.delta - b.delta || b.prev - a.prev || a.node.code.localeCompare(b.node.code))
        .slice(0, limit - topDrop.length)
        .forEach(({ node, prev }) => pushDrop(node, prev));
    }

    // Tier 4 fallback for tiny synthetic fixtures
    if (topDrop.length < limit) {
      nodes
        .filter((node) => !picked.has(node.code))
        .sort((a, b) => (
          (a.counts[di] - baselineOf(a)) - (b.counts[di] - baselineOf(b))
          || a.counts[di] - b.counts[di]
          || a.code.localeCompare(b.code)
        ))
        .slice(0, limit - topDrop.length)
        .forEach((node) => pushDrop(node, baselineOf(node)));
    }

    return {
      date,
      di,
      traces: dayTraces,
      problems,
      perTrace,
      p01,
      sevs,
      traceSevs,
      topAppear,
      topRise,
      topDrop,
    };
  });

  const maxDayProblems = Math.max(1, ...days.map((d) => d.problems));
  const maxDayTraces = Math.max(1, ...days.map((d) => d.traces));
  const activeRatios = days.map((d) => d.perTrace).filter((r) => r > 0);
  const minDayPerTrace = activeRatios.length ? Math.min(...activeRatios) : 0;
  const maxDayPerTrace = activeRatios.length ? Math.max(...activeRatios) : 1;
  const byDate = new Map(days.map((d) => [d.date, d]));
  const defaultDate = [...days].reverse().find((d) => d.problems > 0)?.date || days[days.length - 1].date;
  const pages = buildHeatPages(days, HEAT_PAGE_SIZE);

  return {
    dates,
    days,
    pages,
    byDate,
    byCode,
    traces,
    releases: Array.isArray(trend?.releases) ? trend.releases : [],
    maxDayProblems,
    maxDayTraces,
    minDayPerTrace,
    maxDayPerTrace,
    defaultDate,
    heatCols: HEAT_COLS,
  };
}

const TIP_SEV_META = [
  { key: "P0", label: "P0", color: "var(--sev-0)" },
  { key: "P1", label: "P1", color: "var(--sev-1)" },
  { key: "P2", label: "P2", color: "var(--sev-2)" },
  { key: "P3", label: "P3", color: "var(--sev-3)" },
  { key: "P4", label: "P4", color: "var(--sev-4)" },
  { key: "none", label: "无问题", color: "var(--sev-none)" },
];

function parseCounts(str, len) {
  const raw = String(str || "").split(",").map((x) => Number(x) || 0);
  return Array.from({ length: len }, (_, i) => raw[i] || 0);
}

function tipRingSVG(counts, centerVal, centerUnit, cls = "mxd-tip-ring") {
  const total = counts.reduce((a, b) => a + b, 0);
  let offset = 0;
  const arcs = total > 0
    ? counts.map((n, i) => ({ n, c: TIP_SEV_META[i]?.color || "var(--accent)" }))
        .filter((seg) => seg.n > 0)
        .map((seg) => {
          const share = (100 * seg.n) / total;
          const dash = Math.max(0.8, share - 0.8);
          const at = offset;
          offset += share;
          return `<circle class="mxd-tip-arc" cx="28" cy="28" r="21" pathLength="100" style="stroke:${seg.c};stroke-dasharray:${dash.toFixed(2)} ${(100 - dash).toFixed(2)};stroke-dashoffset:${(-at).toFixed(2)}"/>`;
        }).join("")
    : "";
  return `<div class="${cls}">
    <svg viewBox="0 0 56 56" aria-hidden="true">
      <circle class="mxd-tip-track" cx="28" cy="28" r="21"/>
      ${arcs}
    </svg>
    <div class="mxd-tip-center"><b class="num">${esc(centerVal)}</b><span>${esc(centerUnit)}</span></div>
  </div>`;
}

function tipDaySevGridHTML(tCounts, pCounts) {
  const shares = traceShares(sum(tCounts) > 0 ? tCounts : [...pCounts, 0]);
  return `<div class="mxd-tip-grid">
    ${TIP_SEV_META.map((meta, i) => {
      const tVal = tCounts[i] || 0;
      const pVal = i < 5 ? (pCounts[i] || 0) : 0;
      const shareNum = shares[i] != null ? shares[i] : 0;
      const shareStr = `${fmt(shareNum, 1)}%`;
      return `<div class="mxd-tip-line">
        <span class="mxd-tip-sev"><i style="--c:${meta.color}"></i>${esc(meta.label)}</span>
        <span class="mxd-modal-bar" aria-hidden="true"><i style="width:${Math.min(100, shareNum).toFixed(1)}%;background:${meta.color}"></i></span>
        <b class="mxd-tip-pct num">${esc(shareStr)}</b>
        <span class="mxd-tip-tr num">${fmt(tVal)} Trace</span>
        <span class="mxd-tip-pr num">${fmt(pVal)} 问题</span>
      </div>`;
    }).join("")}
  </div>`;
}

function tipProblemDeltaGridHTML(prevCounts, curCounts) {
  return `<div class="mxd-tip-grid">
    ${TIP_SEV_META.slice(0, 5).map((meta, i) => {
      const prevVal = prevCounts[i] || 0;
      const curVal = curCounts[i] || 0;
      const diff = curVal - prevVal;
      const diffCls = diff > 0 ? "is-up" : diff < 0 ? "is-down" : "is-flat";
      return `<div class="mxd-tip-line is-prob">
        <span class="mxd-tip-sev"><i style="--c:${meta.color}"></i>${esc(meta.label)}</span>
        <span class="mxd-tip-pair num">${fmt(prevVal)} → ${fmt(curVal)}</span>
        <b class="mxd-tip-delta num ${diffCls}">${signed(diff)}</b>
      </div>`;
    }).join("")}
  </div>`;
}

/* Centered floating modal card shown when clicking a date cell in the heatmap. */
export function dayModalHTML(day) {
  if (!day) return "";
  const pCounts = (day.sevs || [0, 0, 0, 0, 0]).slice(0, 5);
  const tCounts = (day.traceSevs || [...pCounts, 0]).slice(0, 6);
  const ringCounts = sum(tCounts) > 0 ? tCounts : [...pCounts, 0];
  const ratio = ratioText(day.perTrace);
  return `<div class="mxd-modal-backdrop" data-daily-modal-backdrop role="dialog" aria-modal="true" aria-label="${esc(`${day.date} 评测详情`)}">
    <div class="mxd-modal">
      <div class="mxd-modal-head">
        <b class="mxd-modal-date num">${esc(day.date)}</b>
        <button type="button" class="mxd-modal-close" data-daily-modal-close aria-label="关闭">×</button>
      </div>
      <div class="mxd-modal-kpis">
        <div class="mxd-modal-kpi"><span>问题数</span><b class="num">${fmt(day.problems)}</b></div>
        <div class="mxd-modal-kpi"><span>Trace 数</span><b class="num">${fmt(day.traces)}</b></div>
        <div class="mxd-modal-kpi"><span>问题 / Trace</span><b class="num">${esc(ratio)}</b></div>
      </div>
      <div class="mxd-modal-body">
        ${tipRingSVG(ringCounts, ratio, "问题/Trace", "mxd-tip-ring is-modal")}
        ${tipDaySevGridHTML(tCounts, pCounts)}
      </div>
    </div>
  </div>`;
}

/* Plain-language, beginner-friendly structured hover tooltip with explicit + / - signs. */
export function resolveDailyTip(target) {
  if (!target) return null;
  if (target.dataset.mxdTipKind === "day") {
    const { date, problems, traces, ratio = "0.00", sevs = "", traceSevs = "" } = target.dataset;
    const pCounts = parseCounts(sevs, 5);
    const rawT = traceSevs ? parseCounts(traceSevs, 6) : [...pCounts, 0];
    const ringCounts = sum(rawT) > 0 ? rawT : [...pCounts, 0];
    return `<div class="mxd-tip-wrap">
      <div class="mxd-tip-head">
        <div class="t-head">${esc(date)}</div>
        <div class="mxd-tip-kpis">
          <span>问题数 <b class="num">${esc(problems)}</b></span>
          <span>Trace 数 <b class="num">${esc(traces)}</b></span>
          <span>问题/Trace <b class="num">${esc(ratio)}</b></span>
        </div>
      </div>
      <div class="mxd-tip-card">
        ${tipRingSVG(ringCounts, ratio, "问题/Trace")}
        ${tipDaySevGridHTML(rawT, pCounts)}
      </div>
    </div>`;
  }
  if (target.dataset.mxdTipKind === "top") {
    const { name, stage, prev = "0", count, delta, sevs = "", prevSevs = "", plain } = target.dataset;
    const d = Number(delta) || 0;
    const move = signed(d);
    const moveCls = d > 0 ? "is-up" : d < 0 ? "is-down" : "";
    const curCounts = parseCounts(sevs, 5);
    const prvCounts = prevSevs ? parseCounts(prevSevs, 5) : curCounts;
    return `<div class="mxd-tip-wrap">
      <div class="mxd-tip-head">
        <div class="t-head">${esc(name)}</div>
        <div class="mxd-tip-kpis">
          <span>环节 <b>${esc(stage)}</b></span>
          <span>前一天 <b class="num">${esc(prev)}</b> → 今天 <b class="num">${esc(count)}</b></span>
          <span>变化 <b class="num ${moveCls}">${esc(move)}</b></span>
        </div>
      </div>
      <div class="mxd-tip-card">
        ${tipRingSVG([...curCounts, 0], move, "较前日")}
        ${tipProblemDeltaGridHTML(prvCounts, curCounts)}
      </div>
    </div>${plain ? `<div class="t-note">${esc(plain)}</div>` : ""}`;
  }
  if (target.dataset.mxdTipKind === "drop") {
    const { name, stage, prev, count, drop, dropPct = "", sevs = "", prevSevs = "", plain } = target.dataset;
    const curCounts = parseCounts(sevs, 5);
    const prvCounts = prevSevs ? parseCounts(prevSevs, 5) : curCounts.map((v, i) => (i === 4 ? v + (Number(String(drop).replace(/,/g, "")) || 0) : v));
    const dropCounts = prvCounts.map((p, i) => Math.max(0, p - curCounts[i]));
    const ringCounts = sum(dropCounts) > 0 ? [...dropCounts, 0] : [...curCounts, 0];
    const minusDrop = `-${String(drop || "0").replace(/^[-−+]/, "")}`;
    return `<div class="mxd-tip-wrap">
      <div class="mxd-tip-head">
        <div class="t-head">${esc(name)}</div>
        <div class="mxd-tip-kpis">
          <span>环节 <b>${esc(stage)}</b></span>
          <span>前一天 <b class="num">${esc(prev)}</b> → 今天 <b class="num">${esc(count)}</b></span>
          <span>下降 <b class="num is-down">${esc(minusDrop)}${dropPct ? ` (-${esc(String(dropPct).replace(/^[-−+]/, ""))})` : ""}</b></span>
        </div>
      </div>
      <div class="mxd-tip-card">
        ${tipRingSVG(ringCounts, minusDrop, "较前日")}
        ${tipProblemDeltaGridHTML(prvCounts, curCounts)}
      </div>
    </div>${plain ? `<div class="t-note">${esc(plain)}</div>` : ""}`;
  }
  return null;
}

export function dailyTopBoardsHTML(day) {
  if (!day) return "";
  const maxAppear = Math.max(1, ...day.topAppear.map((x) => x.count));
  const maxDrop = Math.max(1, ...day.topDrop.map((x) => Math.abs(x.delta)));

  const appearRows = day.topAppear.map((item, i) => {
    const w = item.count > 0 ? Math.max(3, (100 * item.count) / maxAppear) : 0;
    const wP01 = item.p01 > 0 ? Math.max(2, (100 * item.p01) / maxAppear) : 0;
    const deltaCls = item.delta > 0 ? "is-up" : item.delta < 0 ? "is-down" : "is-flat";
    const sevsStr = (item.sevs || []).join(",");
    const prevSevsStr = (item.prevSevs || []).join(",");
    const shareStr = `${fmt(item.share, 1)}%`;
    return `<button type="button" class="mxd-row is-top" data-daily-code="${esc(item.code)}" data-daily-name="${esc(item.name)}" data-tip="1" data-mxd-tip-kind="top" data-name="${esc(item.name)}" data-stage="${esc(item.stageName)}" data-prev="${esc(fmt(item.prev))}" data-count="${esc(fmt(item.count))}" data-delta="${esc(String(item.delta))}" data-p01="${esc(fmt(item.p01))}" data-share="${esc(shareStr)}" data-sevs="${esc(sevsStr)}" data-prev-sevs="${esc(prevSevsStr)}" data-plain="${esc(item.plain || "")}">
      <span class="mxd-rank num">${String(i + 1).padStart(2, "0")}</span>
      <span class="mxd-stage">${esc(item.stageName)}</span>
      <span class="mxd-name">${esc(item.name)}</span>
      <span class="mxd-bar is-top" aria-hidden="true"><i class="mxd-bar-fill" style="width:${w.toFixed(1)}%"></i>${wP01 > 0 ? `<i class="mxd-bar-p01" style="width:${Math.min(w, wP01).toFixed(1)}%"></i>` : ""}</span>
      <b class="mxd-count num">${fmt(item.count)}</b>
      <span class="mxd-delta num ${deltaCls}">${signed(item.delta)}</span>
    </button>`;
  }).join("");

  const dropRows = day.topDrop.map((item, i) => {
    const w = item.delta !== 0 ? Math.max(3, (100 * Math.abs(item.delta)) / maxDrop) : 0;
    const deltaCls = item.delta < 0 ? "is-down" : item.delta > 0 ? "is-up" : "is-flat";
    const sevsStr = (item.sevs || []).join(",");
    const prevSevsStr = (item.prevSevs || []).join(",");
    const dropPctStr = `${fmt(item.dropPct, 0)}%`;
    return `<button type="button" class="mxd-row is-drop" data-daily-code="${esc(item.code)}" data-daily-name="${esc(item.name)}" data-tip="1" data-mxd-tip-kind="drop" data-name="${esc(item.name)}" data-stage="${esc(item.stageName)}" data-prev="${esc(fmt(item.prev))}" data-count="${esc(fmt(item.count))}" data-drop="${esc(fmt(Math.abs(item.delta)))}" data-drop-pct="${esc(dropPctStr)}" data-sevs="${esc(sevsStr)}" data-prev-sevs="${esc(prevSevsStr)}" data-plain="${esc(item.plain || "")}">
      <span class="mxd-rank num">${String(i + 1).padStart(2, "0")}</span>
      <span class="mxd-stage">${esc(item.stageName)}</span>
      <span class="mxd-name">${esc(item.name)}</span>
      <span class="mxd-bar is-drop" aria-hidden="true"><i class="mxd-bar-fill" style="width:${w.toFixed(1)}%"></i></span>
      <span class="mxd-pair num"><span class="is-from">${pairNum(item.prev)}</span><i aria-hidden="true">→</i><span class="is-to">${pairNum(item.count)}</span></span>
      <b class="mxd-delta num ${deltaCls}">${signed(item.delta)}</b>
    </button>`;
  }).join("");

  return `<div class="mxd-board is-top" role="list" aria-label="${esc(`${day.date} 出现最多 TOP 10`)}">${appearRows}</div>
    <div class="mxd-board is-drop" role="list" aria-label="${esc(`${day.date} 下降最多 TOP 10`)}">${dropRows}</div>`;
}

function heatPageForDate(pages, date) {
  for (let i = 0; i < pages.length; i += 1) {
    if (pages[i].some((d) => d.date === date)) return i;
  }
  return Math.max(0, pages.length - 1);
}

function cellHeatValue(model, day, metric) {
  if (metric === "traces") {
    const r = day.traces > 0 ? day.traces / model.maxDayTraces : 0;
    return day.traces > 0 ? 0.05 + 0.90 * (r ** 0.78) : 0;
  }
  if (metric === "ratio") {
    if (!(day.perTrace > 0)) return 0;
    const span = model.maxDayPerTrace - model.minDayPerTrace;
    const r = span > 0.01 ? (day.perTrace - model.minDayPerTrace) / span : 0.5;
    return 0.08 + 0.88 * (Math.max(0, Math.min(1, r)) ** 0.85);
  }
  const r = day.problems > 0 ? day.problems / model.maxDayProblems : 0;
  return day.problems > 0 ? 0.05 + 0.90 * (r ** 0.78) : 0;
}

function heatGridHTML(model, activeDate, pageIndex, metric = "problems") {
  const pageCount = model.pages.length;
  const page = Math.max(0, Math.min(pageCount - 1, pageIndex));
  const slice = model.pages[page] || model.days;
  const firstDate = slice[0]?.date.slice(5) || "";
  const lastDate = slice[slice.length - 1]?.date.slice(5) || "";

  // Pad trailing slots to complete rows of 10 (at least 1 row for tiny fixtures, up to 3 rows = 30).
  const totalSlots = Math.max(HEAT_COLS, Math.ceil(slice.length / HEAT_COLS) * HEAT_COLS);
  const cells = [];
  for (let i = 0; i < totalSlots; i += 1) {
    const day = slice[i];
    if (!day) {
      cells.push(`<span class="mxd-day is-void" aria-hidden="true"></span>`);
      continue;
    }
    const active = day.date === activeDate;
    const v = cellHeatValue(model, day, metric);
    cells.push(`<button type="button" class="mxd-day${active ? " is-active" : ""}${v > 0.52 ? " hot" : ""}" data-daily-day="${esc(day.date)}" aria-pressed="${active}" style="--v:${v.toFixed(3)}">
      <span class="mxd-day-date num">${esc(day.date.slice(5))}</span>
    </button>`);
  }

  const pager = pageCount > 1
    ? `<div class="mxd-pager" role="group" aria-label="日期分页">
        <button type="button" class="mxd-page-btn" data-daily-page="${page - 1}" aria-label="上一页"${page <= 0 ? " disabled" : ""}>‹</button>
        <span class="mxd-page-span num">${esc(`${firstDate} ~ ${lastDate}`)}</span>
        <span class="mxd-page-idx num">${page + 1} / ${pageCount}</span>
        <button type="button" class="mxd-page-btn" data-daily-page="${page + 1}" aria-label="下一页"${page >= pageCount - 1 ? " disabled" : ""}>›</button>
      </div>`
    : `<div class="mxd-pager"><span class="mxd-page-span num">${esc(`${firstDate} ~ ${lastDate}`)}</span></div>`;

  const metricSeg = `<div class="seg mxd-dir-seg mxd-metric-seg" role="group" aria-label="热力图口径">
    <button type="button" data-daily-metric="problems" aria-pressed="${metric === "problems"}">问题数</button>
    <button type="button" data-daily-metric="traces" aria-pressed="${metric === "traces"}">Trace 数</button>
    <button type="button" data-daily-metric="ratio" aria-pressed="${metric === "ratio"}">问题 / Trace</button>
  </div>`;

  return `<div class="mxd-head">
      <div class="mxd-heat-controls">${metricSeg}${pager}</div>
      <button type="button" class="mxd-flip-btn" data-daily-flip="line" aria-label="翻转查看问题折线走势">
        <svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M2 11.5l3.8-4 2.8 2.4L14 4.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M11 4.5h3v3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
        <span>问题走势</span>
      </button>
    </div>
    <div class="mxd-heat" role="group" aria-label="日期热力图" style="--heat-cols:${HEAT_COLS}">${cells.join("")}</div>`;
}

function lineCandidatesFor(day, dir) {
  if (!day) return [];
  const raw = dir === "down" ? day.topDrop.slice(0, LINE_LIMIT) : day.topRise.slice(0, LINE_LIMIT);
  const palette = dir === "down" ? LINE_COLORS_DOWN : LINE_COLORS_UP;
  return raw.map((item, i) => ({
    ...item,
    color: palette[i % palette.length],
  }));
}

function lineChipsHTML(candidates, disabledSet) {
  return candidates.map((item) => {
    const on = !disabledSet.has(item.code);
    const deltaCls = item.delta > 0 ? "is-up" : item.delta < 0 ? "is-down" : "is-flat";
    return `<button type="button" class="mxd-line-chip${on ? " is-on" : ""}" data-daily-series="${esc(item.code)}" aria-pressed="${on}" style="--c:${item.color}">
      <i aria-hidden="true"></i>
      <span class="mxd-chip-name">${esc(item.name)}</span>
      <b class="num ${deltaCls}">${signed(item.delta)}</b>
    </button>`;
  }).join("");
}

const ZOOM_LOCK_ICONS = `<svg class="i-zoom-lock" viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="4" y="7" width="8" height="6" rx="1.2" stroke="currentColor" stroke-width="1.3"/><path d="M6 7V5.3a2 2 0 0 1 4 0V7" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg><svg class="i-zoom-unlock" viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="4" y="7" width="8" height="6" rx="1.2" stroke="currentColor" stroke-width="1.3"/><path d="M6 7V5.3a2 2 0 0 1 3.8-.8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>`;
const zoomLockLabel = (unlocked) => (unlocked ? "点击锁定缩放与拖动" : "点击解锁缩放与拖动");

function lineFaceHTML(day, dir, disabledSet, zoomUnlocked = false) {
  const candidates = lineCandidatesFor(day, dir);
  const lockLabel = zoomLockLabel(zoomUnlocked);
  return `<div class="mxd-head is-line">
      <div class="mxd-line-controls">
        <div class="seg mxd-dir-seg" role="group" aria-label="问题走势方向">
          <button type="button" data-daily-dir="up" aria-pressed="${dir === "up"}">上涨问题</button>
          <button type="button" data-daily-dir="down" aria-pressed="${dir === "down"}">下降问题</button>
        </div>
        <div class="mxd-line-chips" id="mxdLineChips">${lineChipsHTML(candidates, disabledSet)}</div>
      </div>
      <div class="mxd-line-actions">
        <button type="button" class="mxt-zoom mxd-zoom-lock" data-daily-zoom aria-pressed="${zoomUnlocked}" aria-label="${lockLabel}" title="${lockLabel}">${ZOOM_LOCK_ICONS}</button>
        <button type="button" class="mxd-flip-btn" data-daily-flip="heat" aria-label="翻转返回日期热力图">← 返回热力图</button>
      </div>
    </div>
    <div class="mxd-line-plot${zoomUnlocked ? " is-unlocked" : ""}" id="mxdLinePlot" data-own-tip aria-label="多问题日期折线趋势图"></div>`;
}

export function dailyTopHTML(model, selectedDate = "", options = {}) {
  if (!model || !model.days.length) return `<div class="empty">暂无每日问题数据</div>`;
  const activeDay = model.byDate.get(selectedDate) || model.byDate.get(model.defaultDate) || model.days[model.days.length - 1];
  const page = options.page != null ? options.page : heatPageForDate(model.pages, activeDay.date);
  const flipped = options.face === "line";
  const dir = options.dir === "down" ? "down" : "up";
  const metric = ["problems", "traces", "ratio"].includes(options.metric) ? options.metric : "problems";
  const disabledSet = options.disabled instanceof Set ? options.disabled : new Set();
  const zoomUnlocked = Boolean(options.zoom);
  const modalDay = options.modalDate ? model.byDate.get(options.modalDate) : null;

  return `<div class="mxd">
    <div class="mxd-top${flipped ? " is-line" : ""}" id="mxdTop">
      <div class="mxd-face mxd-face-heat" id="mxdHeatFace"${flipped ? " hidden" : ""}>${heatGridHTML(model, activeDay.date, page, metric)}</div>
      <div class="mxd-face mxd-face-line" id="mxdLineFace"${flipped ? "" : " hidden"}>${lineFaceHTML(activeDay, dir, disabledSet, zoomUnlocked)}</div>
    </div>
    <div class="mxd-boards" id="mxdBoards">${dailyTopBoardsHTML(activeDay)}</div>
    <div class="mxd-modal-slot" id="mxdModalSlot">${modalDay ? dayModalHTML(modalDay) : ""}</div>
  </div>`;
}

export function mountDailyTop(host, trend, tax, state = {}, actions = {}) {
  if (!host) return;
  if (host._mxdClick) host.removeEventListener("click", host._mxdClick);
  if (host._mxdKey) {
    if (typeof document !== "undefined") document.removeEventListener("keydown", host._mxdKey);
    host._mxdKey = null;
  }
  if (host._mxdChart) {
    host._mxdChart.destroy();
    host._mxdChart = null;
  }
  const model = buildDailyTopModel(trend, tax);
  if (!model) {
    host.innerHTML = `<div class="empty">暂无每日问题数据</div>`;
    return;
  }
  if (!state.dailyDay || !model.byDate.has(state.dailyDay)) {
    state.dailyDay = model.defaultDate;
  }
  if (state.dailyPage == null || state.dailyPage < 0 || state.dailyPage >= model.pages.length) {
    state.dailyPage = heatPageForDate(model.pages, state.dailyDay);
  }
  state.dailyFace = state.dailyFace === "line" ? "line" : "heat";
  state.dailyDir = state.dailyDir === "down" ? "down" : "up";
  state.dailyMetric = ["problems", "traces", "ratio"].includes(state.dailyMetric) ? state.dailyMetric : "problems";
  state.dailyHidden = state.dailyHidden instanceof Set ? state.dailyHidden : new Set();
  state.dailyZoom = Boolean(state.dailyZoom);

  host.innerHTML = dailyTopHTML(model, state.dailyDay, {
    page: state.dailyPage,
    face: state.dailyFace,
    dir: state.dailyDir,
    metric: state.dailyMetric,
    disabled: state.dailyHidden,
    zoom: state.dailyZoom,
    modalDate: state.dailyModalDate,
  });

  const setModalDate = (date) => {
    state.dailyModalDate = date && model.byDate.has(date) ? date : null;
    const slot = host.querySelector("#mxdModalSlot");
    if (slot) {
      slot.innerHTML = state.dailyModalDate ? dayModalHTML(model.byDate.get(state.dailyModalDate)) : "";
    }
  };

  if (typeof document !== "undefined") {
    const onKey = (ev) => {
      if (ev.key === "Escape" && state.dailyModalDate) {
        ev.preventDefault();
        setModalDate(null);
      }
    };
    host._mxdKey = onKey;
    document.addEventListener("keydown", onKey);
  }

  const applyChartLock = (unlocked) => {
    const plot = host.querySelector("#mxdLinePlot");
    if (plot) plot.classList.toggle("is-unlocked", unlocked);
    host._mxdChart?.chart?.applyOptions({
      handleScroll: unlocked
        ? { mouseWheel: false, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false }
        : false,
      handleScale: unlocked
        ? { mouseWheel: false, pinch: true, axisDoubleClickReset: true, axisPressedMouseMove: { time: true, price: false } }
        : false,
    });
  };

  const paintLineChart = () => {
    const plot = host.querySelector("#mxdLinePlot");
    if (!plot || state.dailyFace !== "line") return;
    host._mxdChart?.destroy();
    host._mxdChart = null;
    const activeDay = model.byDate.get(state.dailyDay) || model.days[model.days.length - 1];
    const isDown = state.dailyDir === "down";
    const candidates = lineCandidatesFor(activeDay, state.dailyDir);
    const activeSeries = candidates
      .filter((item) => !state.dailyHidden.has(item.code))
      .map((item) => {
        const node = model.byCode.get(item.code);
        return {
          name: item.name,
          color: item.color,
          data: model.dates.map((time, di) => {
            const raw = node ? node.counts[di] : 0;
            return { time, value: isDown ? -raw : raw };
          }),
        };
      });
    if (!activeSeries.length) {
      plot.innerHTML = `<div class="empty">选择上方问题标签查看走势</div>`;
      return;
    }
    host._mxdChart = createTrendChart(plot, {
      series: activeSeries,
      measure: "count",
      invertArea: isDown,
      tipLabel: isDown ? "下降问题" : "上涨问题",
      valueFormat: (v) => {
        const n = Math.round(Math.abs(Number(v) || 0));
        if (n === 0) return "0";
        return isDown ? `-${fmt(n)}` : `+${fmt(n)}`;
      },
      releases: model.releases,
      volume: model.dates.map((time, di) => ({ time, value: model.traces[di] || 0 })),
      topAlpha: 0.03,
      bottomAlpha: 0,
      wheelZoom: () => !!state.dailyZoom,
      height: 186,
      onPick: ({ time }) => {
        if (!time || !model.byDate.has(time) || time === state.dailyDay) return;
        state.dailyDay = time;
        state.dailyPage = heatPageForDate(model.pages, time);
        const heatFace = host.querySelector("#mxdHeatFace");
        if (heatFace) heatFace.innerHTML = heatGridHTML(model, state.dailyDay, state.dailyPage, state.dailyMetric);
        const boards = host.querySelector("#mxdBoards");
        if (boards) boards.innerHTML = dailyTopBoardsHTML(model.byDate.get(time));
      },
    });
    applyChartLock(state.dailyZoom);
  };

  if (state.dailyFace === "line") paintLineChart();

  let flipping = false;
  const flipTopFace = async (nextFace) => {
    if (flipping || state.dailyFace === nextFace) return;
    setModalDate(null);
    state.dailyFace = nextFace;
    const topEl = host.querySelector("#mxdTop");
    const heatFace = host.querySelector("#mxdHeatFace");
    const lineFace = host.querySelector("#mxdLineFace");
    if (!topEl || !heatFace || !lineFace) return;
    const applyFace = () => {
      const isLine = nextFace === "line";
      topEl.classList.toggle("is-line", isLine);
      heatFace.hidden = isLine;
      lineFace.hidden = !isLine;
      if (isLine) {
        const activeDay = model.byDate.get(state.dailyDay) || model.days[model.days.length - 1];
        lineFace.innerHTML = lineFaceHTML(activeDay, state.dailyDir, state.dailyHidden, state.dailyZoom);
        paintLineChart();
      } else {
        host._mxdChart?.destroy();
        host._mxdChart = null;
        heatFace.innerHTML = heatGridHTML(model, state.dailyDay, state.dailyPage, state.dailyMetric);
      }
    };
    if (REDUCED || typeof topEl.animate !== "function") {
      applyFace();
      return;
    }
    flipping = true;
    const oldH = topEl.getBoundingClientRect().height;
    try {
      const out = topEl.animate([
        { transform: "perspective(1400px) rotateX(0deg) scale(1)", opacity: 1 },
        { transform: "perspective(1400px) rotateX(4deg) scale(0.992)", opacity: 0 },
      ], { duration: 130, easing: "cubic-bezier(0.4, 0, 1, 1)", fill: "forwards" });
      await (out.finished ? out.finished.catch(() => {}) : Promise.resolve());
      out.cancel();
      applyFace();
      const newH = topEl.getBoundingClientRect().height;
      topEl.style.height = `${oldH}px`;
      topEl.style.overflow = "hidden";
      const enter = topEl.animate([
        { transform: "perspective(1400px) rotateX(-4deg) scale(0.992)", opacity: 0 },
        { transform: "perspective(1400px) rotateX(0deg) scale(1)", opacity: 1 },
      ], { duration: 260, easing: "cubic-bezier(0.16, 1, 0.3, 1)", fill: "forwards" });
      const resize = Math.abs(newH - oldH) > 1
        ? topEl.animate([{ height: `${oldH}px` }, { height: `${newH}px` }], { duration: 260, easing: "cubic-bezier(0.16, 1, 0.3, 1)", fill: "forwards" })
        : null;
      await Promise.all([
        enter.finished ? enter.finished.catch(() => {}) : Promise.resolve(),
        resize?.finished ? resize.finished.catch(() => {}) : Promise.resolve(),
      ]);
      enter.cancel();
      resize?.cancel();
    } finally {
      topEl.style.height = "";
      topEl.style.overflow = "";
      flipping = false;
    }
  };

  const onClick = (e) => {
    if (e.target.closest("[data-daily-modal-close]")) {
      setModalDate(null);
      return;
    }
    const backdrop = e.target.closest("[data-daily-modal-backdrop]");
    if (backdrop && !e.target.closest(".mxd-modal")) {
      setModalDate(null);
      return;
    }
    const flipBtn = e.target.closest("[data-daily-flip]");
    if (flipBtn) {
      if (typeof document !== "undefined") hideTip();
      flipTopFace(flipBtn.dataset.dailyFlip);
      return;
    }
    const metricBtn = e.target.closest("[data-daily-metric]");
    if (metricBtn) {
      const nextMetric = metricBtn.dataset.dailyMetric;
      if (!["problems", "traces", "ratio"].includes(nextMetric) || nextMetric === state.dailyMetric) return;
      state.dailyMetric = nextMetric;
      const heatFace = host.querySelector("#mxdHeatFace");
      if (heatFace) heatFace.innerHTML = heatGridHTML(model, state.dailyDay, state.dailyPage, state.dailyMetric);
      return;
    }
    const pageBtn = e.target.closest("[data-daily-page]");
    if (pageBtn) {
      if (typeof document !== "undefined") hideTip();
      const nextPage = Number(pageBtn.dataset.dailyPage);
      if (!Number.isFinite(nextPage) || nextPage < 0 || nextPage >= model.pages.length || nextPage === state.dailyPage) return;
      state.dailyPage = nextPage;
      const heatFace = host.querySelector("#mxdHeatFace");
      if (heatFace) heatFace.innerHTML = heatGridHTML(model, state.dailyDay, state.dailyPage, state.dailyMetric);
      return;
    }
    const zoomBtn = e.target.closest("[data-daily-zoom]");
    if (zoomBtn) {
      state.dailyZoom = !state.dailyZoom;
      const label = zoomLockLabel(state.dailyZoom);
      zoomBtn.setAttribute("aria-pressed", String(state.dailyZoom));
      zoomBtn.setAttribute("aria-label", label);
      zoomBtn.title = label;
      applyChartLock(state.dailyZoom);
      return;
    }
    const dirBtn = e.target.closest("[data-daily-dir]");
    if (dirBtn) {
      const nextDir = dirBtn.dataset.dailyDir === "down" ? "down" : "up";
      if (nextDir === state.dailyDir) return;
      state.dailyDir = nextDir;
      state.dailyHidden.clear();
      const lineFace = host.querySelector("#mxdLineFace");
      const activeDay = model.byDate.get(state.dailyDay) || model.days[model.days.length - 1];
      if (lineFace) {
        lineFace.innerHTML = lineFaceHTML(activeDay, state.dailyDir, state.dailyHidden, state.dailyZoom);
        paintLineChart();
      }
      return;
    }
    const chipBtn = e.target.closest("[data-daily-series]");
    if (chipBtn) {
      const code = chipBtn.dataset.dailySeries;
      if (!code) return;
      if (state.dailyHidden.has(code)) state.dailyHidden.delete(code);
      else state.dailyHidden.add(code);
      const chipsEl = host.querySelector("#mxdLineChips");
      const activeDay = model.byDate.get(state.dailyDay) || model.days[model.days.length - 1];
      if (chipsEl) chipsEl.innerHTML = lineChipsHTML(lineCandidatesFor(activeDay, state.dailyDir), state.dailyHidden);
      paintLineChart();
      return;
    }
    const dayBtn = e.target.closest("[data-daily-day]");
    if (dayBtn) {
      if (typeof document !== "undefined") hideTip();
      const nextDate = dayBtn.dataset.dailyDay;
      if (!nextDate || !model.byDate.has(nextDate)) return;
      if (nextDate !== state.dailyDay) {
        state.dailyDay = nextDate;
        host.querySelectorAll("[data-daily-day]").forEach((btn) => {
          const on = btn.dataset.dailyDay === nextDate;
          btn.classList.toggle("is-active", on);
          btn.setAttribute("aria-pressed", String(on));
        });
        const boards = host.querySelector("#mxdBoards");
        if (boards) boards.innerHTML = dailyTopBoardsHTML(model.byDate.get(nextDate));
      }
      setModalDate(nextDate);
      return;
    }
    const rowBtn = e.target.closest("[data-daily-code]");
    if (rowBtn && actions.onPickProblem) {
      if (typeof document !== "undefined") hideTip();
      actions.onPickProblem({
        code: rowBtn.dataset.dailyCode,
        name: rowBtn.dataset.dailyName || rowBtn.dataset.dailyCode,
        date: state.dailyDay,
        source: rowBtn,
      });
    }
  };
  host._mxdClick = onClick;
  host.addEventListener("click", onClick);
}
