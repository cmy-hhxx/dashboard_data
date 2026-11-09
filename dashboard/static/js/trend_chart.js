/* Shared trend geometry for the outer matrix, the AB matrix and the AB small multiples.
   A value is drawn once as a line point and once as a capped nebula cloud: the cloud never
   renders the raw count, it encodes relative volume plus the hit/session ratio. */
import { esc, fmt, showTip, hideTip } from "./core.js";

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export function monotonePath(points) {
  if (points.length < 2) return "";
  const secant = points.slice(1).map((p, i) => (p[1] - points[i][1]) / (p[0] - points[i][0] || 1));
  const slope = new Array(points.length).fill(0);
  slope[0] = secant[0];
  slope[slope.length - 1] = secant[secant.length - 1];
  for (let i = 1; i < points.length - 1; i++) {
    if (secant[i - 1] * secant[i] <= 0) continue;
    const h0 = points[i][0] - points[i - 1][0];
    const h1 = points[i + 1][0] - points[i][0];
    const w0 = 2 * h1 + h0;
    const w1 = h1 + 2 * h0;
    slope[i] = (w0 + w1) / (w0 / secant[i - 1] + w1 / secant[i]);
  }
  let d = `M${points[0][0].toFixed(1)},${points[0][1].toFixed(1)}`;
  for (let i = 0; i < points.length - 1; i++) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[i + 1];
    const h = x2 - x1;
    d += `C${(x1 + h / 3).toFixed(1)},${(y1 + (slope[i] * h) / 3).toFixed(1)} ${(x2 - h / 3).toFixed(1)},${(y2 - (slope[i + 1] * h) / 3).toFixed(1)} ${x2.toFixed(1)},${y2.toFixed(1)}`;
  }
  return d;
}

/* A cluster of problems at one point, drawn as a regular dotted rosette: volume sets the number of
   dots and the radius, the hit/session ratio sets their density. Dots sit on evenly spaced angles
   (no jitter), so a row of points reads as one rhythm, and the mark stays inside the plot padding so
   the first and last dates are never clipped by the chart edge. 1,000 observations never become
   1,000 circles. */
export function nebulaCluster({ x, y, value, max, ratio = 0, color, maxDots = 16, spread = 9, bounds = null }) {
  if (!(value > 0)) return "";
  const share = max > 0 ? clamp(value / max, 0, 1) : 0;
  const hitShare = clamp(ratio || share, 0, 1);
  const dots = Math.max(3, Math.min(maxDots, Math.round(3 + 13 * Math.sqrt(share))));
  const reach = 2.6 + spread * (0.28 + 0.72 * Math.sqrt(share));
  const dotR = spread > 7 ? 1.45 : spread > 4 ? 1.3 : 1.1;
  const opacity = (0.3 + 0.36 * hitShare).toFixed(2);
  const rings = dots >= 9 ? [6, dots - 6] : [dots];
  const radii = rings.length > 1 ? [reach * 0.55, reach] : [reach * 0.88];
  let out = `<g class="mxt-nebula" aria-hidden="true">`;
  rings.forEach((count, ring) => {
    const radius = radii[ring];
    const step = (Math.PI * 2) / count;
    const start = -Math.PI / 2 + (ring ? step / 2 : 0);
    for (let i = 0; i < count; i += 1) {
      const angle = start + i * step;
      const px = x + Math.cos(angle) * radius;
      const py = y + Math.sin(angle) * radius;
      // Keep every dot inside the plot's boundary instead of letting edge rosettes spill into
      // the axis padding or run into the neighbouring point.
      const cx = bounds ? clamp(px, bounds.l + dotR, bounds.r - dotR) : px;
      const cy = bounds ? clamp(py, bounds.t + dotR, bounds.b - dotR) : py;
      out += `<circle class="mxt-nebula-dot" cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${dotR}" fill="${color}" opacity="${opacity}"/>`;
    }
  });
  return `${out}</g>`;
}

function topFor(values) {
  const max = Math.max(0, ...values.filter((v) => v != null));
  if (max <= 0) return 1;
  const raw = max / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 4, 5, 10].map((m) => m * mag).find((s) => s >= raw) || 10 * mag;
  return step * 4;
}

export function lineTrendSVG({ width = 720, height = 170, xLabels = [], xDates = [], series = [], aria = "", compact = false, formatValue = fmt, nebulaDots = null, connectGaps = false, yAxis = false, endLabels = !compact, minTop = 0, releases = null, marks = null }) {
  const W = Math.max(compact ? 180 : 320, Math.min(1120, Math.round(width || 720)));
  const H = Math.max(compact ? 52 : 120, Math.round(height || 170));
  // A labelled release mark needs a strip above the plot for the version name; the line itself
  // always runs from the top axis to the bottom axis on one x mapping.
  const labelled = !compact && ((Array.isArray(releases) && releases.length) || (Array.isArray(marks) && marks.length));
  const PAD = compact
    ? (yAxis ? { l: 48, r: 16, t: 16, b: 24 } : { l: 12, r: 12, t: 12, b: 20 })
    : { l: 48, r: endLabels ? 116 : 16, t: labelled ? 32 : 16, b: 28 };
  const n = Math.max(1, xLabels.length);
  const all = series.flatMap((s) => s.values);
  const top = Math.max(minTop, topFor(all));
  const innerW = W - PAD.l - PAD.r;
  const innerH = H - PAD.t - PAD.b;
  const clusterBounds = { l: PAD.l, r: PAD.l + innerW, t: PAD.t, b: PAD.t + innerH };
  const clusterSpread = Math.min(compact ? 3.4 : 9, Math.max(2.2, (innerW / Math.max(1, n - 1)) * 0.36));
  const times = xDates.map((d) => Date.parse(`${d}T00:00:00Z`));
  const timeAxis = times.length === n && times.every(Number.isFinite) && times[n - 1] > times[0];
  const xOf = (i) => PAD.l + (n <= 1 ? innerW / 2 : innerW * (timeAxis ? (times[i] - times[0]) / (times[n - 1] - times[0]) : i / (n - 1)));
  const yOf = (v) => PAD.t + innerH - (clamp(v, 0, top) / top) * innerH;
  /* Release dates are placed on the same time axis as the curve, not snapped to the nearest
     sample, so the marker and the line agree; an index-based mark covers categorical x axes. */
  const releaseAt = (at) => PAD.l + (n <= 1 ? innerW / 2 : innerW * (clamp(at, 0, n - 1) / Math.max(1, n - 1)));
  const rel = [];
  if (timeAxis && Array.isArray(releases)) {
    releases.forEach((entry) => {
      const t = Date.parse(`${entry && entry.date}T00:00:00Z`);
      if (!Number.isFinite(t) || t < times[0] || t > times[n - 1]) return;
      rel.push({ x: PAD.l + (innerW * (t - times[0])) / (times[n - 1] - times[0]), label: entry.label || "发版", date: entry.date });
    });
  }
  if (Array.isArray(marks)) {
    marks.forEach((mark) => {
      if (!mark || !Number.isFinite(mark.at)) return;
      rel.push({ x: releaseAt(mark.at), label: mark.label || "发版", date: mark.date || null });
    });
  }
  rel.sort((a, b) => a.x - b.x);
  let grid = "";
  const gridLines = compact && !yAxis ? 1 : 4;
  for (let g = 0; g <= gridLines; g++) {
    const y = PAD.t + innerH - (g / gridLines) * innerH;
    grid += `<line x1="${PAD.l}" x2="${W - PAD.r}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}"${g ? "" : ' class="is-base"'}/>`;
    if (yAxis) grid += `<text class="mxt-ylab" x="${PAD.l - 8}" y="${y.toFixed(1)}">${esc(formatValue(top * g / gridLines))}</text>`;
  }
  const maxLabels = compact ? 3 : 6;
  const candidates = [...new Set(Array.from({ length: Math.min(n, maxLabels) }, (_, i) =>
    Math.round((i * (n - 1)) / Math.max(1, Math.min(n, maxLabels) - 1))))];
  // Irregular dates make evenly-picked ticks crowd at the right edge: keep a minimum pixel gap and
  // always keep the newest date, anchored to the plot edge so its label never runs out of the chart.
  const minGap = 54;
  const tickIdx = [];
  candidates.forEach((i) => {
    if (!tickIdx.length || xOf(i) - xOf(tickIdx[tickIdx.length - 1]) >= minGap) tickIdx.push(i);
  });
  const lastTick = candidates[candidates.length - 1];
  if (lastTick != null && tickIdx[tickIdx.length - 1] !== lastTick) {
    if (xOf(lastTick) - xOf(tickIdx[tickIdx.length - 1]) < minGap) tickIdx.pop();
    tickIdx.push(lastTick);
  }
  const xSvg = tickIdx.map((i) => `<text class="mxt-xlab" style="text-anchor:${i === 0 ? "start" : i === n - 1 ? "end" : "middle"}" x="${xOf(i).toFixed(1)}" y="${H - 4}">${esc(xLabels[i] == null ? "" : xLabels[i])}</text>`).join("");
  let areas = "";
  let lines = "";
  let dots = "";
  let nebula = "";
  const endpoints = [];
  series.forEach((s, si) => {
    const volumeMax = s.volumes ? Math.max(0, ...s.volumes) : top;
    const segments = [];
    let run = [];
    const flush = () => {
      if (run.length) segments.push(run);
      run = [];
    };
    s.values.forEach((v, i) => {
      if (v == null) {
        if (!connectGaps) flush();
        return;
      }
      const point = [xOf(i), yOf(v), v, i];
      run.push(point);
      if (!s.ghost) {
        const ratio = s.ratios && s.ratios[i] != null ? s.ratios[i] : v / top;
        nebula += nebulaCluster({ x: point[0], y: point[1], value: s.volumes ? s.volumes[i] : v, max: volumeMax, ratio, color: s.color, maxDots: nebulaDots || (compact ? 10 : 16), spread: clusterSpread, bounds: clusterBounds });
        dots += `<circle class="mxt-dot" data-trend-point="${si}:${i}" cx="${point[0].toFixed(1)}" cy="${point[1].toFixed(1)}" r="${compact ? 2 : 2.8}" style="fill:${s.color}" aria-label="${esc(`${s.label || ""} ${xLabels[i] || ""} · ${formatValue(v)}`)}"/>`;
      }
    });
    flush();
    segments.forEach((points) => {
      const path = monotonePath(points);
      if (points.length > 1) {
        const base = PAD.t + innerH;
        const area = `${path}L${points[points.length - 1][0].toFixed(1)},${base.toFixed(1)}L${points[0][0].toFixed(1)},${base.toFixed(1)}Z`;
        if (!s.dash) areas += `<path class="mxt-area" d="${area}" style="fill:${s.color};opacity:.055"/>`;
        lines += `<path class="mxt-line" pathLength="1" d="${path}" style="stroke:${s.color};${s.dash ? "stroke-dasharray:3 3;opacity:.48;" : ""}"/>`;
      }
    });
    let last = -1;
    for (let i = s.values.length - 1; i >= 0; i--) if (s.values[i] != null) { last = i; break; }
    if (endLabels && !s.ghost && last >= 0) endpoints.push({ s, i: last, value: s.values[last], x: xOf(last), y: yOf(s.values[last]), ly: yOf(s.values[last]) });
  });
  endpoints.sort((a, b) => a.ly - b.ly);
  endpoints.forEach((e, i) => { e.ly = Math.max(e.ly, PAD.t + i * 18); });
  const maxY = PAD.t + innerH;
  if (endpoints.length && endpoints[endpoints.length - 1].ly > maxY) {
    endpoints[endpoints.length - 1].ly = maxY;
    for (let i = endpoints.length - 2; i >= 0; i--) endpoints[i].ly = Math.min(endpoints[i].ly, endpoints[i + 1].ly - 18);
  }
  const labelX = W - PAD.r + 9;
  const ends = endpoints.map((e) => `<g class="mxt-end">
    <line class="mxt-end-line" x1="${e.x.toFixed(1)}" y1="${e.y.toFixed(1)}" x2="${(labelX - 7).toFixed(1)}" y2="${e.ly.toFixed(1)}" style="stroke:${e.s.color}"/>
    <line x1="${(labelX - 1).toFixed(1)}" x2="${(labelX + 8).toFixed(1)}" y1="${e.ly.toFixed(1)}" y2="${e.ly.toFixed(1)}" style="stroke:${e.s.color};stroke-width:2"/>
    <text x="${(labelX + 13).toFixed(1)}" y="${(e.ly + 3.4).toFixed(1)}"><tspan>${esc(e.s.label || "")}</tspan><tspan class="mxt-end-val" dx="6">${esc(formatValue(e.value))}</tspan></text>
  </g>`).join("");
  // 发版参照：一条从顶轴贯到底轴的实线 + 一条淡红带 + 顶端版本名，读图和读日期在同一个 x 上。
  // 小图里只留一根 1px 发版线（画在曲线之下），大图才用淡红带 + 端点 + 版本名强调。
  const relBands = compact ? "" : rel.map((m) => `<rect class="mxt-release-band" x="${(m.x - 3).toFixed(1)}" y="${PAD.t}" width="6" height="${innerH.toFixed(1)}" rx="3"/>`).join("");
  const relBars = rel.map((m) => compact
    ? `<line class="mxt-release-line is-compact" x1="${m.x.toFixed(1)}" x2="${m.x.toFixed(1)}" y1="${PAD.t}" y2="${(PAD.t + innerH).toFixed(1)}"/>`
    : `<line class="mxt-release-line" x1="${m.x.toFixed(1)}" x2="${m.x.toFixed(1)}" y1="${PAD.t}" y2="${(PAD.t + innerH).toFixed(1)}"/><circle class="mxt-release-dot" cx="${m.x.toFixed(1)}" cy="${PAD.t}" r="2.4"/><circle class="mxt-release-dot" cx="${m.x.toFixed(1)}" cy="${(PAD.t + innerH).toFixed(1)}" r="2.4"/>`).join("");
  let relLabels = "";
  if (!compact && rel.length) {
    const placed = [];
    rel.forEach((m) => {
      let y = PAD.t - 9;
      while (placed.some((p) => Math.abs(p.x - m.x) < 46 && Math.abs(p.y - y) < 11)) y += 12;
      placed.push({ x: m.x, y });
      relLabels += `<text class="mxt-release-label" x="${clamp(m.x, PAD.l + 14, W - PAD.r - 14).toFixed(1)}" y="${y.toFixed(1)}" text-anchor="middle">${esc(m.label)}</text>`;
    });
  }
  const html = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(aria)}" data-l="${PAD.l}" data-r="${PAD.r}" data-t="${PAD.t}" data-b="${PAD.b}" data-n="${n}" data-w="${W}" data-h="${H}">
    <g class="mxt-grid">${grid}${xSvg}</g>${relBands}${areas}${nebula}${compact ? relBars : ""}${lines}${dots}${compact ? "" : relBars}${relLabels}${ends}
    <g class="mxt-cursor"><line/><circle/></g>
  </svg>`;
  return { html, geo: { W, H, PAD, innerW, innerH, top, xOf, yOf, xLabels, xDates, series, formatValue, releases: rel } };
}

export function nearestTrendPoint(geo, x, y, radius = 24) {
  let best = null, distance = radius * radius;
  geo.series.forEach((series, si) => {
    if (series.ghost) return;
    series.values.forEach((value, i) => {
      if (value == null) return;
      const d = (geo.xOf(i) - x) ** 2 + (geo.yOf(value) - y) ** 2;
      if (d < distance) { distance = d; best = { series: si, index: i }; }
    });
  });
  return best;
}

export function wireTrendPointPick(host, geo, onPick) {
  const svg = host.querySelector("svg");
  if (!svg || !onPick) return;
  svg.classList.add("has-sample-picks");
  const choose = ({ series, index }) => {
    hideTip();
    onPick({ date: geo.xDates[index], series: geo.series[series], seriesIndex: series, index });
  };
  svg.addEventListener("click", (event) => {
    const point = event.target.closest("[data-trend-point]");
    if (point) {
      const [series, index] = point.dataset.trendPoint.split(":").map(Number);
      choose({ series, index });
      return;
    }
    const box = svg.getBoundingClientRect();
    const hit = nearestTrendPoint(geo, (event.clientX - box.left) * geo.W / box.width, (event.clientY - box.top) * geo.H / box.height, 24 * geo.W / box.width);
    if (hit) choose(hit);
  });
  svg.querySelectorAll("[data-trend-point]").forEach((point) => {
    const [si, i] = point.dataset.trendPoint.split(":").map(Number);
    point.setAttribute("tabindex", "0");
    point.setAttribute("role", "button");
    point.setAttribute("aria-label", `${geo.xDates[i]} ${geo.series[si].label || ""}，查看样本`);
    point.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      choose({ series: si, index: i });
    });
  });
}

export function wireLineTrendChart(host, chart, ariaLabel = "", onPick = null, { hoverDelay = 0, canHover = () => true } = {}) {
  const svg = host.querySelector("svg");
  const cursor = svg && svg.querySelector(".mxt-cursor");
  if (!svg || !cursor) return () => {};
  wireTrendPointPick(host, chart.geo, onPick);
  const { geo } = chart;
  const [line] = cursor.querySelectorAll("line");
  const [dot] = cursor.querySelectorAll("circle");
  let active = -1, timer = null, pending = null, showing = false, html = "";
  const clear = () => {
    clearTimeout(timer);
    timer = null;
    pending = null;
    active = -1;
    showing = false;
    cursor.classList.remove("is-on");
    hideTip();
  };
  const reveal = () => {
    timer = null;
    if (!pending || !canHover()) return clear();
    showing = true;
    showTip(html, pending.x, pending.y);
  };
  const move = (e) => {
    if (e.pointerType === "touch" || e.buttons || !canHover()) return clear();
    const box = svg.getBoundingClientRect();
    const x = ((e.clientX - box.left) / box.width) * geo.W;
    const i = geo.xLabels.reduce((best, _, at) => Math.abs(geo.xOf(at) - x) < Math.abs(geo.xOf(best) - x) ? at : best, 0);
    const changed = i !== active;
    if (changed) {
      active = i;
      const px = geo.xOf(i);
      const vals = geo.series.map((s) => ({ s, v: s.values[i] })).filter((x) => x.v != null && !x.s.ghost);
      const first = vals[0];
      const y = first ? geo.yOf(first.v) : geo.PAD.t + geo.innerH;
      line.setAttribute("x1", px);
      line.setAttribute("x2", px);
      line.setAttribute("y1", geo.PAD.t);
      line.setAttribute("y2", geo.PAD.t + geo.innerH);
      dot.setAttribute("cx", px);
      dot.setAttribute("cy", y);
      dot.style.fill = first ? first.s.color : "var(--muted)";
      cursor.classList.add("is-on");
      const body = vals.map(({ s, v }) => `<div class="t-row"><span class="sev"><i style="--c:${s.color}"></i>${esc(s.label || "")}</span><b class="num" style="margin-left:auto">${esc(geo.formatValue(v))}</b></div>${s.details?.[i] ? `<div class="t-row">${esc(s.details[i])}</div>` : ""}`).join("");
      html = `<div style="font-weight:var(--w-medium);margin-bottom:6px">${esc(geo.xDates[i] || geo.xLabels[i] || ariaLabel)}</div>${body}`;
    }
    pending = { x: e.clientX, y: e.clientY };
    if (showing || !hoverDelay) return reveal();
    if (changed || timer == null) {
      clearTimeout(timer);
      timer = setTimeout(reveal, hoverDelay);
    }
  };
  const listeners = { pointermove: move, pointerdown: clear, pointerleave: clear, pointercancel: clear };
  Object.entries(listeners).forEach(([type, handler]) => svg.addEventListener(type, handler));
  return () => {
    clear();
    Object.entries(listeners).forEach(([type, handler]) => svg.removeEventListener(type, handler));
  };
}
