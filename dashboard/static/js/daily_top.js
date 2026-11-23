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
const HEAT_PAGE_SIZE = HEAT_COLS * HEAT_ROWS;
const LINE_COLORS_UP = ["var(--accent)", "#c86d3b", "#6e59bd", "#248277", "#9e6378"];
const LINE_COLORS_DOWN = ["#248277", "var(--accent)", "#6e59bd", "#4e8752", "#b57c3c"];

const signed = (n) => (n > 0 ? `+${fmt(n)}` : n < 0 ? `-${fmt(Math.abs(n))}` : "0");
const pairNum = (n) => (Math.abs(n) >= 10000 ? compact(n) : fmt(n));
const ratioText = (ratio) => (ratio > 0 ? fmt(ratio, 2) : "0.00");

const CHEVRON_LEFT_SVG = `<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M9.75 3.75L5.5 8l4.25 4.25" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const CHEVRON_RIGHT_SVG = `<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M6.25 3.75L10.5 8l-4.25 4.25" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const CLOSE_X_SVG = `<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" stroke="currentColor" stroke-width="1.65" stroke-linecap="round"/></svg>`;

function daysInCalendarMonth(ym) {
  const [y, m] = String(ym || "").split("-").map(Number);
  if (!Number.isFinite(y) || !Number.isFinite(m) || m < 1 || m > 12) return 30;
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export function shiftCalendarMonth(ym, delta) {
  const [y, m] = String(ym || "").split("-").map(Number);
  if (!Number.isFinite(y) || !Number.isFinite(m) || m < 1 || m > 12) return String(ym || "");
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function buildCalendarMonthSlice(ym, byDate) {
  const total = daysInCalendarMonth(ym);
  const fullMonth = [];
  for (let dayNum = 1; dayNum <= total; dayNum += 1) {
    const date = `${ym}-${String(dayNum).padStart(2, "0")}`;
    const existing = byDate instanceof Map ? byDate.get(date) : null;
    if (existing) {
      fullMonth.push({ ...existing, hasData: true, month: ym });
    } else {
      fullMonth.push({
        date,
        month: ym,
        hasData: false,
        traces: 0,
        problems: 0,
        perTrace: 0,
        p01: 0,
        sevs: [0, 0, 0, 0, 0],
        traceSevs: [0, 0, 0, 0, 0, 0],
        topAppear: [],
        topRise: [],
        topDrop: [],
      });
    }
  }
  return fullMonth;
}

/* Group evaluated days strictly by full calendar month (YYYY-MM-01 .. YYYY-MM-lastDay).
   Every calendar day of the month is present in order; evaluated days carry `hasData: true`,
   and unevaluated calendar days in the same month carry `hasData: false`. */
export function buildHeatPages(days) {
  if (!Array.isArray(days) || !days.length) return [];
  const byDate = new Map();
  const months = [];
  days.forEach((d) => {
    const date = String(d?.date || "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
    byDate.set(date, d);
    const ym = date.slice(0, 7);
    if (!months.includes(ym)) months.push(ym);
  });
  months.sort();
  return months.map((ym) => buildCalendarMonthSlice(ym, byDate));
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

    const sparkOf = (node) => {
      const from = Math.max(0, di - 6);
      const pts = [];
      for (let k = from; k <= di; k += 1) pts.push(node.counts[k] || 0);
      return pts;
    };

    // 1. Top 10 most frequent specific problems on day `di` (strictly descending by count, then delta)
    const appearSorted = [...nodes]
      .sort((a, b) => (
        b.counts[di] - a.counts[di]
        || (b.counts[di] - baselineOf(b)) - (a.counts[di] - baselineOf(a))
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
        spark: sparkOf(node),
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

    // 2. Top 10 most dropped specific problems on day `di` (strictly descending by drop magnitude |delta|)
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
        spark: sparkOf(node),
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

    // Guarantee strict descending order of drop magnitude across all tiers
    topDrop.sort((a, b) => a.delta - b.delta || b.prev - a.prev || a.count - b.count || a.code.localeCompare(b.code));

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

function tipRingSVG(counts, centerVal, centerUnit, cls = "mxd-tip-ring", activeSev = "") {
  const total = counts.reduce((a, b) => a + b, 0);
  const shares = traceShares(total > 0 ? counts : [0, 0, 0, 0, 0, 0]);
  let offset = 0;
  const arcs = total > 0
    ? counts.map((n, i) => ({
        n,
        key: TIP_SEV_META[i]?.key || String(i),
        c: TIP_SEV_META[i]?.color || "var(--accent)",
      }))
        .filter((seg) => seg.n > 0)
        .map((seg) => {
          const share = (100 * seg.n) / total;
          const dash = Math.max(0.8, share - 0.8);
          const at = offset;
          offset += share;
          const isSel = Boolean(activeSev && activeSev === seg.key);
          const isDim = Boolean(activeSev && activeSev !== seg.key);
          return `<circle class="mxd-tip-arc${isSel ? " is-active" : ""}${isDim ? " is-dim" : ""}" data-daily-sev="${esc(seg.key)}" cx="28" cy="28" r="21" pathLength="100" style="--c:${seg.c};stroke:${seg.c};stroke-dasharray:${dash.toFixed(2)} ${(100 - dash).toFixed(2)};stroke-dashoffset:${(-at).toFixed(2)}"/>`;
        }).join("")
    : "";
  const selIdx = activeSev ? TIP_SEV_META.findIndex((m) => m.key === activeSev) : -1;
  const selMeta = selIdx >= 0 ? TIP_SEV_META[selIdx] : null;
  const cVal = selMeta ? `${fmt(shares[selIdx] || 0, 1)}%` : centerVal;
  const cUnit = selMeta ? `${selMeta.label} · ${fmt(counts[selIdx] || 0)}` : centerUnit;
  return `<div class="${cls}${selMeta ? " has-focus" : ""}">
    <svg viewBox="0 0 56 56" aria-hidden="true">
      <circle class="mxd-tip-track" cx="28" cy="28" r="21"/>
      ${arcs}
    </svg>
    <div class="mxd-tip-center${selMeta ? " is-sev-focus" : ""}"${selMeta ? ` style="--c:${selMeta.color}"` : ""}><b class="num">${esc(cVal)}</b><span>${esc(cUnit)}</span></div>
  </div>`;
}

function tipDaySevGridHTML(tCounts, pCounts, { interactive = false, activeSev = "" } = {}) {
  const shares = traceShares(sum(tCounts) > 0 ? tCounts : [...pCounts, 0]);
  return `<div class="mxd-tip-grid${interactive ? " is-interactive" : ""}${activeSev ? " has-focus" : ""}">
    ${TIP_SEV_META.map((meta, i) => {
      const tVal = tCounts[i] || 0;
      const pVal = i < 5 ? (pCounts[i] || 0) : 0;
      const shareNum = shares[i] != null ? shares[i] : 0;
      const shareStr = `${fmt(shareNum, 1)}%`;
      const isSel = Boolean(activeSev && activeSev === meta.key);
      const inner = `<span class="mxd-tip-sev"><i style="--c:${meta.color}"></i><span>${esc(meta.label)}</span></span>
        <b class="mxd-tip-pct num">${esc(shareStr)}</b>
        <span class="mxd-tip-tr num">${fmt(tVal)} Trace</span>
        <span class="mxd-tip-pr num">${fmt(pVal)} 问题</span>`;
      if (interactive) {
        return `<button type="button" class="mxd-tip-line is-interactive${isSel ? " is-active" : ""}" data-daily-sev="${esc(meta.key)}" aria-pressed="${isSel}" style="--c:${meta.color};--w:${Math.min(100, shareNum).toFixed(1)}%">${inner}</button>`;
      }
      return `<div class="mxd-tip-line" style="--c:${meta.color};--w:${Math.min(100, shareNum).toFixed(1)}%">${inner}</div>`;
    }).join("")}
  </div>`;
}

function tipBoardSevStripHTML(prevCounts, curCounts) {
  const chips = TIP_SEV_META.slice(0, 5)
    .map((meta, i) => {
      const prevVal = prevCounts[i] || 0;
      const curVal = curCounts[i] || 0;
      const diff = curVal - prevVal;
      if (curVal === 0 && prevVal === 0) return "";
      const diffCls = diff > 0 ? "is-up" : diff < 0 ? "is-down" : "is-flat";
      return `<span class="mxd-tip-chip"><i style="--c:${meta.color}"></i><span>${esc(meta.label)}</span><b class="num">${fmt(curVal)}</b><em class="num ${diffCls}">(${signed(diff)})</em></span>`;
    })
    .filter(Boolean);
  if (!chips.length) return "";
  return `<div class="mxd-tip-sevs">${chips.join("")}</div>`;
}

function dayModalBodyHTML(day, activeSev = "") {
  const pCounts = (day.sevs || [0, 0, 0, 0, 0]).slice(0, 5);
  const tCounts = (day.traceSevs || [...pCounts, 0]).slice(0, 6);
  const ringCounts = sum(tCounts) > 0 ? tCounts : [...pCounts, 0];
  return `${tipRingSVG(ringCounts, fmt(day.traces || day.problems), day.traces ? "Trace" : "问题", "mxd-tip-ring is-modal", activeSev)}
    ${tipDaySevGridHTML(tCounts, pCounts, { interactive: true, activeSev })}`;
}

/* In-place flipped day detail card inside the left calendar column, linked to the two Top-10 boards on the right. */
export function dayModalHTML(day, activeSev = "") {
  if (!day) return "";
  const ratio = ratioText(day.perTrace);
  const top1 = day.topAppear?.[0];
  const drop1 = day.topDrop?.[0];
  const linkedFoot = (top1 || drop1)
    ? `<div class="mxd-pop-foot">
        ${top1 ? `<button type="button" class="mxd-pop-link is-top" data-daily-code="${esc(top1.code)}" data-daily-name="${esc(top1.name)}">
          <i aria-hidden="true"></i>
          <span class="mxd-pop-tag">当日最多</span>
          <b class="mxd-pop-name">${esc(top1.name)}</b>
          <span class="mxd-pop-num num">${fmt(top1.count)} <em class="${top1.delta > 0 ? "is-up" : top1.delta < 0 ? "is-down" : ""}">(${signed(top1.delta)})</em></span>
        </button>` : ""}
        ${drop1 ? `<button type="button" class="mxd-pop-link is-drop" data-daily-code="${esc(drop1.code)}" data-daily-name="${esc(drop1.name)}">
          <i aria-hidden="true"></i>
          <span class="mxd-pop-tag">下降最多</span>
          <b class="mxd-pop-name">${esc(drop1.name)}</b>
          <span class="mxd-pop-num num">${fmt(drop1.prev)}→${fmt(drop1.count)} <em class="is-down">(${signed(drop1.delta)})</em></span>
        </button>` : ""}
      </div>`
    : "";
  return `<div class="mxd-modal-backdrop mxd-pop-anchor" data-daily-modal-backdrop role="dialog" aria-label="${esc(`${day.date} 评测详情`)}">
    <div class="mxd-modal mxd-pop">
      <div class="mxd-modal-head">
        <div class="mxd-pop-nav">
          <button type="button" class="mxd-page-btn" data-daily-step="-1" aria-label="前一天">${CHEVRON_LEFT_SVG}</button>
          <b class="mxd-modal-date num">${esc(day.date)}</b>
          <button type="button" class="mxd-page-btn" data-daily-step="1" aria-label="后一天">${CHEVRON_RIGHT_SVG}</button>
        </div>
        <div class="mxd-pop-kpis">
          <span class="mxd-pop-kpi"><span>问题</span><b class="num">${fmt(day.problems)}</b></span>
          <span class="mxd-pop-kpi"><span>Trace</span><b class="num">${fmt(day.traces)}</b></span>
          <span class="mxd-pop-kpi is-accent"><span>问题/Trace</span><b class="num">${esc(ratio)}</b></span>
        </div>
        <button type="button" class="mxd-modal-close" data-daily-modal-close aria-label="关闭">${CLOSE_X_SVG}</button>
      </div>
      <div class="mxd-modal-body">
        ${dayModalBodyHTML(day, activeSev)}
      </div>
      ${linkedFoot}
    </div>
  </div>`;
}

/* Clean, scannable hover tooltip for bottom Top-10 rows and date summary. */
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
    const { name, stage, prev = "0", count, delta, share = "", sevs = "", prevSevs = "", plain } = target.dataset;
    const d = Number(delta) || 0;
    const move = signed(d);
    const moveCls = d > 0 ? "is-up" : d < 0 ? "is-down" : "";
    const curCounts = parseCounts(sevs, 5);
    const prvCounts = prevSevs ? parseCounts(prevSevs, 5) : curCounts;
    return `<div class="mxd-board-tip">
      <div class="t-head">${esc(stage)} · ${esc(name)}</div>
      <div class="t-row"><span>今日出现</span><b class="num is-key">${esc(count)} 次${share ? ` (${esc(share)})` : ""}</b></div>
      <div class="t-row"><span>前一日</span><b class="num">${esc(prev)} 次</b></div>
      <div class="t-row"><span>较前日变化</span><b class="num ${moveCls}">${esc(move)}</b></div>
      ${tipBoardSevStripHTML(prvCounts, curCounts)}
      ${plain ? `<div class="t-note">${esc(plain)}</div>` : ""}
    </div>`;
  }
  if (target.dataset.mxdTipKind === "drop") {
    const { name, stage, prev, count, drop, dropPct = "", sevs = "", prevSevs = "", plain } = target.dataset;
    const curCounts = parseCounts(sevs, 5);
    const prvCounts = prevSevs ? parseCounts(prevSevs, 5) : curCounts.map((v, i) => (i === 4 ? v + (Number(String(drop).replace(/,/g, "")) || 0) : v));
    const minusDrop = `-${String(drop || "0").replace(/^[-−+]/, "")}`;
    const cleanPct = String(dropPct || "").replace(/^[-−+]/, "");
    return `<div class="mxd-board-tip">
      <div class="t-head">${esc(stage)} · ${esc(name)}</div>
      <div class="t-row"><span>前一日</span><b class="num">${esc(prev)} 次</b></div>
      <div class="t-row"><span>今日出现</span><b class="num is-key">${esc(count)} 次</b></div>
      <div class="t-row"><span>较前日下降</span><b class="num is-down">${esc(minusDrop)}${cleanPct ? ` (-${esc(cleanPct)})` : ""}</b></div>
      ${tipBoardSevStripHTML(prvCounts, curCounts)}
      ${plain ? `<div class="t-note">${esc(plain)}</div>` : ""}
    </div>`;
  }
  return null;
}

function sparkSVG(pts, toneCls) {
  const list = Array.isArray(pts) && pts.length ? pts : [0];
  const W = 52;
  const H = 18;
  const padX = 2.5;
  const padY = 3;
  const min = Math.min(...list);
  const max = Math.max(...list);
  const span = max - min;
  const coords = list.map((v, i) => {
    const x = list.length === 1 ? W - padX : padX + (i * (W - padX * 2)) / (list.length - 1);
    const norm = span > 0 ? (v - min) / span : 0.5;
    const y = H - padY - norm * (H - padY * 2);
    return [x, y];
  });
  const poly = coords.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const last = coords[coords.length - 1];
  return `<span class="mxd-spark ${toneCls}" aria-hidden="true"><svg viewBox="0 0 ${W} ${H}" fill="none">${coords.length > 1 ? `<polyline points="${poly}"/>` : ""}<circle cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="2.1"/></svg></span>`;
}

export function dailyTopBoardsHTML(day) {
  if (!day) return "";
  const maxAppear = Math.max(1, ...day.topAppear.map((x) => x.count));
  const maxDrop = Math.max(1, ...day.topDrop.map((x) => Math.abs(x.delta)));

  const appearRows = day.topAppear.map((item, i) => {
    const w = item.count > 0 ? Math.max(6, (100 * item.count) / maxAppear) : 0;
    const deltaCls = item.delta > 0 ? "is-up" : item.delta < 0 ? "is-down" : "is-flat";
    const sevsStr = (item.sevs || []).join(",");
    const prevSevsStr = (item.prevSevs || []).join(",");
    const shareStr = `${fmt(item.share, 1)}%`;
    return `<button type="button" class="mxd-row is-top" style="--w:${w.toFixed(1)}%" data-daily-code="${esc(item.code)}" data-daily-name="${esc(item.name)}" data-tip="1" data-mxd-tip-kind="top" data-name="${esc(item.name)}" data-stage="${esc(item.stageName)}" data-prev="${esc(fmt(item.prev))}" data-count="${esc(fmt(item.count))}" data-delta="${esc(String(item.delta))}" data-p01="${esc(fmt(item.p01))}" data-share="${esc(shareStr)}" data-sevs="${esc(sevsStr)}" data-prev-sevs="${esc(prevSevsStr)}" data-plain="${esc(item.plain || "")}">
      <span class="mxd-rank num">${String(i + 1).padStart(2, "0")}</span>
      <span class="mxd-name">${esc(item.name)}</span>
      ${sparkSVG(item.spark, deltaCls === "is-down" ? "is-down" : "is-up")}
      <span class="mxd-pair num"><span class="is-from">${pairNum(item.prev)}</span><i aria-hidden="true">→</i><b class="is-to">${pairNum(item.count)}</b></span>
      <b class="mxd-delta num ${deltaCls}">${signed(item.delta)}</b>
    </button>`;
  }).join("");

  const dropRows = day.topDrop.map((item, i) => {
    const w = item.delta !== 0 ? Math.max(6, (100 * Math.abs(item.delta)) / maxDrop) : 0;
    const deltaCls = item.delta < 0 ? "is-down" : item.delta > 0 ? "is-up" : "is-flat";
    const sevsStr = (item.sevs || []).join(",");
    const prevSevsStr = (item.prevSevs || []).join(",");
    const dropPctStr = `${fmt(item.dropPct, 0)}%`;
    return `<button type="button" class="mxd-row is-drop" style="--w:${w.toFixed(1)}%" data-daily-code="${esc(item.code)}" data-daily-name="${esc(item.name)}" data-tip="1" data-mxd-tip-kind="drop" data-name="${esc(item.name)}" data-stage="${esc(item.stageName)}" data-prev="${esc(fmt(item.prev))}" data-count="${esc(fmt(item.count))}" data-drop="${esc(fmt(Math.abs(item.delta)))}" data-drop-pct="${esc(dropPctStr)}" data-sevs="${esc(sevsStr)}" data-prev-sevs="${esc(prevSevsStr)}" data-plain="${esc(item.plain || "")}">
      <span class="mxd-rank num">${String(i + 1).padStart(2, "0")}</span>
      <span class="mxd-name">${esc(item.name)}</span>
      ${sparkSVG(item.spark, "is-down")}
      <span class="mxd-pair num"><span class="is-from">${pairNum(item.prev)}</span><i aria-hidden="true">→</i><b class="is-to">${pairNum(item.count)}</b></span>
      <b class="mxd-delta num ${deltaCls}">${signed(item.delta)}</b>
    </button>`;
  }).join("");

  return `<div class="mxd-board is-top" role="list" aria-label="${esc(`${day.date} 出现最多 TOP 10`)}">${appearRows}</div>
    <div class="mxd-board is-drop" role="list" aria-label="${esc(`${day.date} 下降最多 TOP 10`)}">${dropRows}</div>`;
}

function heatPageForDate(pages, date) {
  const ym = String(date || "").slice(0, 7);
  for (let i = 0; i < pages.length; i += 1) {
    if (pages[i].some((d) => d.date === date || d.date?.slice(0, 7) === ym)) return i;
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

const WEEKDAYS = ["一", "二", "三", "四", "五", "六", "日"];

function heatHeadHTML(metric = "problems") {
  const metricSeg = `<div class="seg mxd-dir-seg mxd-metric-seg" role="group" aria-label="热力图口径">
    <button type="button" data-daily-metric="problems" aria-pressed="${metric === "problems"}">问题数</button>
    <button type="button" data-daily-metric="traces" aria-pressed="${metric === "traces"}">Trace 数</button>
    <button type="button" data-daily-metric="ratio" aria-pressed="${metric === "ratio"}">问题 / Trace</button>
  </div>`;
  return `<div class="mxd-head">
      <div class="mxd-heat-controls">${metricSeg}</div>
      <button type="button" class="mxd-flip-btn" data-daily-flip="line" aria-label="翻转查看问题折线走势">
        <svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M2 11.5l3.8-4 2.8 2.4L14 4.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M11 4.5h3v3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
        <span>问题走势</span>
      </button>
    </div>`;
}

function calendarCardHTML(model, activeDate, pageIndex, metric = "problems", activeMonth = "") {
  const pageCount = model.pages.length;
  const page = Math.max(0, Math.min(pageCount - 1, pageIndex));
  const baseSlice = model.pages[page] || model.days;
  const baseYm = baseSlice[0]?.date.slice(0, 7) || String(activeDate || "").slice(0, 7);
  const monthLabel = /^\d{4}-\d{2}$/.test(activeMonth) ? activeMonth : baseYm;
  const matchedPageIdx = model.pages.findIndex((p) => p[0]?.date.slice(0, 7) === monthLabel);
  const slice = matchedPageIdx >= 0
    ? model.pages[matchedPageIdx]
    : buildCalendarMonthSlice(monthLabel, model.byDate);

  // Apple Calendar alignment: Monday = 0 ... Sunday = 6
  const [yy, mm] = monthLabel.split("-").map(Number);
  const firstDow = Number.isFinite(yy) && Number.isFinite(mm)
    ? (new Date(Date.UTC(yy, mm - 1, 1)).getUTCDay() + 6) % 7
    : 0;
  const cells = [];
  for (let i = 0; i < firstDow; i += 1) {
    cells.push(`<span class="mxd-day is-void" aria-hidden="true"></span>`);
  }
  for (const day of slice) {
    const dayNum = String(Number(day.date.slice(8)));
    if (day.hasData === false) {
      cells.push(`<span class="mxd-day is-empty" aria-label="${esc(`${day.date} 暂无评测数据`)}"><span class="mxd-day-date num">${esc(dayNum)}</span></span>`);
      continue;
    }
    const active = day.date === activeDate;
    const v = cellHeatValue(model, day, metric);
    cells.push(`<button type="button" class="mxd-day${active ? " is-active" : ""}${v > 0.52 ? " hot" : ""}" data-daily-day="${esc(day.date)}" aria-pressed="${active}" aria-label="${esc(day.date)}" style="--v:${v.toFixed(3)}">
      <span class="mxd-day-date num">${esc(dayNum)}</span>
    </button>`);
  }
  const trailing = (7 - (cells.length % 7)) % 7;
  for (let i = 0; i < trailing; i += 1) {
    cells.push(`<span class="mxd-day is-void" aria-hidden="true"></span>`);
  }

  const latestYm = model.pages[pageCount - 1]?.[0]?.date.slice(0, 7) || baseYm;
  const prevYm = shiftCalendarMonth(monthLabel, -1);
  const nextYm = shiftCalendarMonth(monthLabel, 1);
  const prevPage = matchedPageIdx > 0 ? matchedPageIdx - 1 : 0;
  const nextPage = matchedPageIdx >= 0 && matchedPageIdx < pageCount - 1 ? matchedPageIdx + 1 : pageCount - 1;
  const atEarliest = monthLabel <= "2020-01";
  const atLatest = monthLabel >= latestYm;
  const titleText = Number.isFinite(yy) && Number.isFinite(mm) ? `${yy} 年 ${mm} 月` : monthLabel;

  return `<div class="mxd-cal">
      <div class="mxd-cal-bar">
        <span class="mxd-cal-title num">${esc(titleText)}</span>
        <div class="mxd-pager" role="group" aria-label="月份切换">
          <button type="button" class="mxd-page-btn" data-daily-month="${esc(prevYm)}" data-daily-page="${prevPage}" aria-label="上一个月"${atEarliest ? " disabled" : ""}>${CHEVRON_LEFT_SVG}</button>
          <button type="button" class="mxd-page-btn" data-daily-month="${esc(nextYm)}" data-daily-page="${nextPage}" aria-label="下一个月"${atLatest ? " disabled" : ""}>${CHEVRON_RIGHT_SVG}</button>
        </div>
      </div>
      <div class="mxd-cal-week" aria-hidden="true">${WEEKDAYS.map((w) => `<span>${w}</span>`).join("")}</div>
      <div class="mxd-heat" role="group" aria-label="日期热力图">${cells.join("")}</div>
    </div>`;
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
  const activeMonth = options.month || "";
  const flipped = options.face === "line";
  const dir = options.dir === "down" ? "down" : "up";
  const metric = ["problems", "traces", "ratio"].includes(options.metric) ? options.metric : "problems";
  const disabledSet = options.disabled instanceof Set ? options.disabled : new Set();
  const zoomUnlocked = Boolean(options.zoom);
  const modalDay = options.modalDate ? model.byDate.get(options.modalDate) : null;
  const modalSev = options.modalSev || "";

  return `<div class="mxd">
    <div class="mxd-top${flipped ? " is-line" : ""}" id="mxdTop">
      <div class="mxd-face mxd-face-heat" id="mxdHeatFace"${flipped ? " hidden" : ""}>
        <div id="mxdHeatHead">${heatHeadHTML(metric)}</div>
        <div class="mxd-tri">
          <div class="mxd-cal-stage${modalDay ? " is-flipped" : ""}" id="mxdCalStage">
            <div class="mxd-cal-face mxd-cal-front" id="mxdCalFront">${calendarCardHTML(model, activeDay.date, page, metric, activeMonth)}</div>
            <div class="mxd-cal-face mxd-cal-back mxd-modal-slot" id="mxdModalSlot">${modalDay ? dayModalHTML(modalDay, modalSev) : ""}</div>
          </div>
          <div class="mxd-boards" id="mxdBoards">${dailyTopBoardsHTML(activeDay)}</div>
        </div>
      </div>
      <div class="mxd-face mxd-face-line" id="mxdLineFace"${flipped ? "" : " hidden"}>${lineFaceHTML(activeDay, dir, disabledSet, zoomUnlocked)}</div>
    </div>
  </div>`;
}

export function mountDailyTop(host, trend, tax, state = {}, actions = {}) {
  if (!host) return;
  if (host._mxdClick) host.removeEventListener("click", host._mxdClick);
  if (host._mxdClearTimers) host._mxdClearTimers();
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
  if (!state.dailyMonth || !/^\d{4}-\d{2}$/.test(state.dailyMonth)) {
    state.dailyMonth = model.pages[state.dailyPage]?.[0]?.date.slice(0, 7) || state.dailyDay.slice(0, 7);
  }
  state.dailyFace = state.dailyFace === "line" ? "line" : "heat";
  state.dailyDir = state.dailyDir === "down" ? "down" : "up";
  state.dailyMetric = ["problems", "traces", "ratio"].includes(state.dailyMetric) ? state.dailyMetric : "problems";
  state.dailyHidden = state.dailyHidden instanceof Set ? state.dailyHidden : new Set();
  state.dailyZoom = Boolean(state.dailyZoom);
  state.dailyModalSev = state.dailyModalSev || "";

  host.innerHTML = dailyTopHTML(model, state.dailyDay, {
    page: state.dailyPage,
    month: state.dailyMonth,
    face: state.dailyFace,
    dir: state.dailyDir,
    metric: state.dailyMetric,
    disabled: state.dailyHidden,
    zoom: state.dailyZoom,
    modalDate: state.dailyModalDate,
    modalSev: state.dailyModalSev,
  });

  let pickTimer = 0;
  let swapTimer = 0;
  let flipTimer = 0;
  let revealTimer = 0;
  host._mxdClearTimers = () => {
    clearTimeout(pickTimer);
    clearTimeout(swapTimer);
    clearTimeout(flipTimer);
    clearTimeout(revealTimer);
  };

  const pulseClass = (el, cls, ms, prev) => {
    clearTimeout(prev);
    if (!el || REDUCED || typeof el.classList?.remove !== "function" || typeof el.classList?.add !== "function") return 0;
    el.classList.remove(cls);
    void el.offsetWidth;
    el.classList.add(cls);
    return setTimeout(() => el.classList?.remove(cls), ms);
  };

  const repaintCalendar = () => {
    const calFront = host.querySelector("#mxdCalFront");
    if (calFront) calFront.innerHTML = calendarCardHTML(model, state.dailyDay, state.dailyPage, state.dailyMetric, state.dailyMonth);
  };

  const setModalDate = (date) => {
    const nextDate = date && model.byDate.has(date) ? date : null;
    const prevFlipped = Boolean(state.dailyModalDate);
    const nextFlipped = Boolean(nextDate);
    if (nextDate !== state.dailyModalDate) state.dailyModalSev = "";
    state.dailyModalDate = nextDate;
    const slot = host.querySelector("#mxdModalSlot");
    if (slot) {
      slot.innerHTML = state.dailyModalDate
        ? dayModalHTML(model.byDate.get(state.dailyModalDate), state.dailyModalSev)
        : "";
    }
    const stage = host.querySelector("#mxdCalStage");
    if (stage?.classList) {
      stage.classList.toggle("is-flipped", nextFlipped);
      if (prevFlipped !== nextFlipped) {
        flipTimer = pulseClass(stage, "is-flipping", 640, flipTimer);
      }
      if (nextFlipped) {
        const modal = slot?.querySelector?.(".mxd-modal");
        revealTimer = pulseClass(modal, "is-reveal", 500, revealTimer);
      }
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
      topAlpha: 0.08,
      bottomAlpha: 0,
      wheelZoom: () => !!state.dailyZoom,
      height: 310,
      onPick: ({ time }) => {
        if (!time || !model.byDate.has(time) || time === state.dailyDay) return;
        selectDay(time, false);
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
        const headEl = host.querySelector("#mxdHeatHead");
        if (headEl) headEl.innerHTML = heatHeadHTML(state.dailyMetric);
        repaintCalendar();
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

  const selectDay = (nextDate, openModal = false) => {
    if (!nextDate || !model.byDate.has(nextDate)) return;
    const changed = nextDate !== state.dailyDay;
    if (changed) {
      state.dailyDay = nextDate;
      const targetPage = heatPageForDate(model.pages, nextDate);
      const targetMonth = nextDate.slice(0, 7);
      let pickedBtn = null;
      if (targetPage !== state.dailyPage || targetMonth !== state.dailyMonth) {
        state.dailyPage = targetPage;
        state.dailyMonth = targetMonth;
        repaintCalendar();
        pickedBtn = [...(host.querySelectorAll("[data-daily-day]") || [])].find((btn) => btn.dataset.dailyDay === nextDate) || null;
      } else {
        host.querySelectorAll("[data-daily-day]").forEach((btn) => {
          const on = btn.dataset.dailyDay === nextDate;
          if (on) pickedBtn = btn;
          btn.classList.toggle("is-active", on);
          btn.setAttribute("aria-pressed", String(on));
        });
      }
      if (!openModal) pickTimer = pulseClass(pickedBtn, "is-just-picked", 300, pickTimer);
      const boards = host.querySelector("#mxdBoards");
      if (boards) {
        boards.innerHTML = dailyTopBoardsHTML(model.byDate.get(nextDate));
        swapTimer = pulseClass(boards, "is-swap", 400, swapTimer);
      }
    }
    if (openModal || state.dailyModalDate) {
      setModalDate(nextDate);
    }
  };

  const onClick = (e) => {
    if (e.target.closest("[data-daily-modal-close]")) {
      setModalDate(null);
      return;
    }
    const sevBtn = e.target.closest("[data-daily-sev]");
    if (sevBtn && state.dailyModalDate) {
      const nextSev = sevBtn.dataset.dailySev || "";
      state.dailyModalSev = state.dailyModalSev === nextSev ? "" : nextSev;
      const modalDay = model.byDate.get(state.dailyModalDate);
      const slot = host.querySelector("#mxdModalSlot");
      const body = slot?.querySelector ? slot.querySelector(".mxd-modal-body") : null;
      if (body && modalDay) {
        body.innerHTML = dayModalBodyHTML(modalDay, state.dailyModalSev);
      } else if (slot && modalDay) {
        slot.innerHTML = dayModalHTML(modalDay, state.dailyModalSev);
      }
      return;
    }
    const stepBtn = e.target.closest("[data-daily-step]");
    if (stepBtn) {
      const step = Number(stepBtn.dataset.dailyStep) || 0;
      const curIdx = model.dates.indexOf(state.dailyDay);
      const nextIdx = curIdx + step;
      if (curIdx >= 0 && nextIdx >= 0 && nextIdx < model.dates.length) {
        selectDay(model.dates[nextIdx], true);
      }
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
      const headEl = host.querySelector("#mxdHeatHead");
      if (headEl) headEl.innerHTML = heatHeadHTML(state.dailyMetric);
      repaintCalendar();
      return;
    }
    const pageBtn = e.target.closest("[data-daily-month], [data-daily-page]");
    if (pageBtn) {
      if (typeof document !== "undefined") hideTip();
      const targetMonth = pageBtn.dataset.dailyMonth || "";
      if (targetMonth && /^\d{4}-\d{2}$/.test(targetMonth)) {
        if (targetMonth === state.dailyMonth) return;
        state.dailyMonth = targetMonth;
        const idx = model.pages.findIndex((p) => p[0]?.date.slice(0, 7) === targetMonth);
        if (idx >= 0) state.dailyPage = idx;
      } else {
        const nextPage = Number(pageBtn.dataset.dailyPage);
        if (!Number.isFinite(nextPage) || nextPage < 0 || nextPage >= model.pages.length || nextPage === state.dailyPage) return;
        state.dailyPage = nextPage;
        state.dailyMonth = model.pages[nextPage]?.[0]?.date.slice(0, 7) || state.dailyMonth;
      }
      repaintCalendar();
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
      if (nextDate === state.dailyDay && !state.dailyModalDate) {
        setModalDate(nextDate);
      } else {
        selectDay(nextDate, Boolean(state.dailyModalDate));
      }
      return;
    }
    const rowBtn = e.target.closest("[data-daily-code]");
    if (rowBtn && actions.onPickProblem) {
      if (typeof document !== "undefined") hideTip();
      setModalDate(null);
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
