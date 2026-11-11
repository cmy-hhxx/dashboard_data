/* K 线图：把按天采样的计数序列聚合成日/周/月/年蜡烛，叠加 MA5 / MA10 / MA20 和成交式量能。
   基于 TradingView 的 lightweight-charts（Apache-2.0，vendor 在 static/vendor）；不自绘 Canvas。
   数据口径由调用方给全量 rows；这里只负责聚合和绘制，不做任何筛选。 */
import { createChart, CandlestickSeries, HistogramSeries, LineSeries, AreaSeries, ColorType } from "../vendor/lightweight-charts.production.js";
import { esc, fmt } from "./core.js";
import { KLINE_PERIODS, PERIOD_NAME, buildCandles, movingAverage } from "./kline_data.js";

export { KLINE_PERIODS } from "./kline_data.js";
/* Custom properties may hold var()/color-mix(); resolve them to a concrete sRGB color the chart
   canvas parser accepts (oklab() from color-mix is rejected by lightweight-charts). */
let probe = null;
let swatch = null;
function colorOf(name, fallback) {
  if (typeof document === "undefined") return fallback;
  probe = probe || document.createElement("i");
  if (!probe.isConnected) document.body.appendChild(probe);
  probe.style.color = `var(${name})`;
  const css = getComputedStyle(probe).color;
  probe.remove();
  if (!css) return fallback;
  swatch = swatch || document.createElement("canvas");
  swatch.width = swatch.height = 1;
  const ctx = swatch.getContext("2d", { willReadFrequently: true });
  ctx.clearRect(0, 0, 1, 1);
  ctx.fillStyle = fallback;
  ctx.fillStyle = css;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
  return `rgba(${r}, ${g}, ${b}, ${(a / 255).toFixed(3)})`;
}

function palette() {
  return {
    text: colorOf("--muted", "#697280"),
    grid: colorOf("--well-2", "#e7eaee"),
    border: colorOf("--t4", "#dfe3e8"),
    card: colorOf("--card", "#f7f8fa"),
    up: colorOf("--sev-1", "#bf3822"),
    down: colorOf("--loc-ulq", "#1d7d72"),
    volume: alphaColor(colorOf("--muted", "#697280"), 0.5),
    ma5: colorOf("--accent", "#3552d8"),
    ma10: colorOf("--mx-c4", "#b3651f"),
    ma20: colorOf("--mx-c3", "#6a43b8"),
    release: colorOf("--release", "#b3261e"),
  };
}

/* 折线组用 var(--mx-cN) 传色；画布只认具体颜色，所以在建图时解析一次。 */
function cssColor(value, fallback) {
  const name = /^var\(\s*(--[\w-]+)\s*\)$/.exec(String(value || ""))?.[1];
  return name ? colorOf(name, fallback) : (value || fallback);
}

/* 面积叠层需要同一颜色的低透明度版本；解析后的颜色都是 rgba(r, g, b, a)。 */
function alphaColor(color, alpha) {
  const m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/.exec(String(color || ""));
  return m ? `rgba(${m[1]}, ${m[2]}, ${m[3]}, ${alpha})` : color;
}

/* 发版日：轻量图表没有内置垂线，用 series primitive 在绘图区画一根贯穿上下的红线。
   版本名写在红线右侧并带卡片色描边，线不会穿过文字。 */
function releaseLinePrimitive(chart, items, color, fontFamily, backdrop) {
  let requestUpdate = () => {};
  let stroke = color;
  let halo = backdrop;
  const draw = (target) => {
    target.useBitmapCoordinateSpace((scope) => {
      const { context, horizontalPixelRatio: hr, verticalPixelRatio: vr, bitmapSize } = scope;
      const timeScale = chart.timeScale();
      context.save();
      context.strokeStyle = stroke;
      context.fillStyle = stroke;
      context.lineWidth = Math.max(1, Math.round(1.4 * hr));
      context.font = `${Math.round(10 * vr)}px ${fontFamily}`;
      context.textBaseline = "top";
      let lastLabel = -Infinity;
      items.forEach(({ time, label }) => {
        const x = timeScale.timeToCoordinate(time);
        if (x == null) return;
        const px = Math.round(x * hr) + 0.5;
        context.strokeStyle = stroke;
        context.lineWidth = Math.max(1, Math.round(1.4 * hr));
        context.beginPath();
        context.moveTo(px, 0);
        context.lineTo(px, bitmapSize.height);
        context.stroke();
        // 版本名只在有空间时写，挤在一起的两根线不叠字；靠近右边缘时改为左对齐。
        if (px - lastLabel >= 52 * hr) {
          const gap = 6 * hr;
          const y = 4 * vr;
          const textW = context.measureText(label).width;
          const right = px + gap + textW > bitmapSize.width;
          context.textAlign = right ? "right" : "left";
          const tx = right ? px - gap : px + gap;
          context.lineJoin = "round";
          context.lineWidth = Math.max(2, Math.round(3 * hr));
          context.strokeStyle = halo;
          context.strokeText(label, tx, y);
          context.fillStyle = stroke;
          context.fillText(label, tx, y);
          lastLabel = px;
        }
      });
      context.restore();
    });
  };
  return {
    attached({ requestUpdate: update }) { requestUpdate = update; },
    setColors(nextStroke, nextBackdrop) { stroke = nextStroke; halo = nextBackdrop; requestUpdate(); },
    paneViews() {
      return [{ renderer: () => ({ draw }), zOrder: () => "top" }];
    },
  };
}

/* 滚轮默认还给页面；按住 Ctrl/⌘ 才缩放图表，避免指针停在图上时滚不动页面。 */
function wireWheelZoom(host, chart, enabled) {
  const onWheel = (event) => {
    if (!event.deltaY || !enabled()) return;
    event.preventDefault();
    event.stopPropagation();
    const range = chart.timeScale().getVisibleLogicalRange();
    if (!range) return;
    const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
    const factor = Math.exp(Math.max(-120, Math.min(120, delta)) * 0.0025);
    const mid = (range.from + range.to) / 2;
    const half = Math.max(0.5, ((range.to - range.from) / 2) * factor);
    chart.timeScale().setVisibleLogicalRange({ from: mid - half, to: mid + half });
  };
  host.addEventListener("wheel", onWheel, { passive: false, capture: true });
  host.title = "拖拽平移 · 解锁后滚轮缩放";
  return () => host.removeEventListener("wheel", onWheel, true);
}

const MA_DEFS = [["MA5", 5, "ma5"], ["MA10", 10, "ma10"], ["MA20", 20, "ma20"]];

const timeText = (time) => (typeof time === "string" ? time : time?.year ? `${time.year}-${String(time.month).padStart(2, "0")}-${String(time.day).padStart(2, "0")}` : String(time || ""));

function tickText(date, period) {
  const text = timeText(date);
  if (period === "year") return text.slice(0, 4);
  if (period === "month") return text.slice(0, 7);
  return text.slice(5);
}

/* rows: [{date, value, volume}], full history. host gets a fixed height around the chart. */
export function createKlineChart(host, spec = {}) {
  const rows = Array.isArray(spec.rows) ? spec.rows : [];
  const period = PERIOD_NAME[spec.period] ? spec.period : "day";
  const height = Math.max(120, Number(spec.height) || host.clientHeight || 240);
  const empty = spec.emptyText || "暂无趋势数据";
  host.className = `${host.className.replace(/\s*kl-host/g, "")} kl-host`;
  host.innerHTML = "";
  const candles = Array.isArray(spec.candles) ? spec.candles : buildCandles(rows, period);
  const tick = (time) => (typeof spec.tickText === "function" ? spec.tickText(time) : tickText(time, period));
  if (!candles.length) {
    host.innerHTML = `<div class="empty">${esc(empty)}</div>`;
    return {
      destroy: () => {
        host.innerHTML = "";
        host.style.height = "";
        host.classList.remove("kl-host");
      },
    };
  }
  host.style.height = `${height}px`;

  const colors = palette();
  const maSeries = [];
  host.innerHTML = `<div class="kl-legend">
      ${MA_DEFS.map(([name, , key]) => `<span><i style="--c:${colors[key]}"></i>${name}</span>`).join("")}
      <span class="kl-vol-key"><i class="is-vol"></i>量能 · ${esc(spec.volumeName || "Trace")}</span>
      ${spec.legendNote ? `<span class="kl-note">${esc(spec.legendNote)}</span>` : ""}
    </div><div class="kl-canvas"></div><div class="kl-tip" hidden></div>`;
  const canvas = host.querySelector(".kl-canvas");
  const tip = host.querySelector(".kl-tip");

  const chart = createChart(canvas, {
    width: Math.max(1, canvas.clientWidth),
    height: Math.max(1, canvas.clientHeight),
    layout: {
      background: { type: ColorType.Solid, color: "transparent" },
      textColor: colors.text,
      fontSize: 10,
      fontFamily: getComputedStyle(document.body).fontFamily,
      attributionLogo: false,
    },
    grid: { vertLines: { color: colors.grid }, horzLines: { color: colors.grid } },
    rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.14, bottom: 0.02 } },
    timeScale: {
      borderVisible: false, fixLeftEdge: true, fixRightEdge: true,
      tickMarkFormatter: (time) => tick(time),
    },
    crosshair: {
      vertLine: { color: colors.border, width: 1, style: 3 },
      horzLine: { color: colors.border, width: 1, style: 3 },
    },
    handleScroll: { mouseWheel: false, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
    handleScale: {
      mouseWheel: false, pinch: true, axisDoubleClickReset: true,
      axisPressedMouseMove: { time: true, price: false },
    },
    localization: { timeFormatter: (time) => tick(time) },
  });
  const wheelAllowed = typeof spec.wheelZoom === "function" ? spec.wheelZoom : () => spec.wheelZoom === true;
  const offWheel = wireWheelZoom(host, chart, wheelAllowed);

  const candleSeries = chart.addSeries(CandlestickSeries, {
    upColor: colors.up, downColor: colors.down,
    borderUpColor: colors.up, borderDownColor: colors.down,
    wickUpColor: colors.up, wickDownColor: colors.down,
    priceFormat: { type: "price", precision: 0, minMove: 1 },
    priceLineVisible: false,
  }, 0);
  candleSeries.setData(candles.map(({ time, open, high, low, close }) => ({ time, open, high, low, close })));

  for (const [name, span, key] of MA_DEFS) {
    const series = chart.addSeries(LineSeries, {
      color: colors[key], lineWidth: 1, priceLineVisible: false, lastValueVisible: false,
      crosshairMarkerVisible: false, priceFormat: { type: "price", precision: 1, minMove: 0.1 },
    }, 0);
    series.setData(movingAverage(candles, span));
    maSeries.push([name, key, series]);
  }

  const volumePane = chart.addPane();
  const volumeSeries = volumePane.addSeries(HistogramSeries, {
    priceScaleId: "volume", color: colors.volume, priceFormat: { type: "volume" },
    priceLineVisible: false, lastValueVisible: false,
  });
  volumeSeries.setData(candles.map(({ time, volume }) => ({ time, value: volume })));
  chart.priceScale("volume", 1).applyOptions({ visible: false });
  const panes = chart.panes();
  if (panes[0]) panes[0].setStretchFactor(3);
  volumePane.setStretchFactor(1);
  chart.timeScale().fitContent();
  let disposed = false;
  const sizeObserver = new ResizeObserver(() => {
    if (disposed || !canvas.isConnected) return;
    const width = canvas.clientWidth;
    const total = canvas.clientHeight;
    if (width > 0 && total > 0) chart.resize(width, total);
  });
  sizeObserver.observe(canvas);

  const byTime = new Map(candles.map((candle) => [String(candle.time), candle]));
  const number = (value) => fmt(value, Number.isInteger(value) ? 0 : 1);
  chart.subscribeCrosshairMove((param) => {
    if (!param?.point || param.time == null) {
      tip.hidden = true;
      return;
    }
    const candle = byTime.get(String(param.time));
    if (!candle) {
      tip.hidden = true;
      return;
    }
    const when = typeof spec.tipTime === "function" ? spec.tipTime(candle) : String(candle.time);
    const span = period === "day" || period === "intraday" ? "" : ` · ${candle.from.slice(5)}~${candle.to.slice(5)}`;
    const unit = typeof spec.tipPeriod === "function" ? spec.tipPeriod(candle) : `${PERIOD_NAME[period]}${span}`;
    const openValue = spec.openValue == null
      ? candle.open
      : (typeof spec.openValue === "function" ? spec.openValue(candle) : spec.openValue);
    tip.innerHTML = `<div class="kl-tip-head"><b class="num">${esc(when)}</b><span>${esc(unit)}</span></div>
      <div class="kl-tip-row"><span>${esc(spec.openLabel || "开盘")}</span><b class="num">${number(openValue)}</b></div>
      <div class="kl-tip-row"><span>${esc(spec.closeLabel || "收盘")}</span><b class="num">${number(candle.close)}</b></div>`;
    tip.hidden = false;
    const pad = 8;
    const width = tip.offsetWidth;
    const left = Math.min(Math.max(pad, param.point.x + 14), host.clientWidth - width - pad);
    const top = Math.max(pad, Math.min(param.point.y + 12, host.clientHeight - tip.offsetHeight - pad));
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
  });

  if (typeof spec.onPick === "function") {
    chart.subscribeClick((param) => {
      if (!param?.time) return;
      const candle = byTime.get(String(param.time));
      if (candle) spec.onPick(candle);
    });
  }

  const theme = new MutationObserver(() => {
    const next = palette();
    chart.applyOptions({
      layout: { textColor: next.text },
      grid: { vertLines: { color: next.grid }, horzLines: { color: next.grid } },
      crosshair: { vertLine: { color: next.border }, horzLine: { color: next.border } },
    });
    candleSeries.applyOptions({
      upColor: next.up, downColor: next.down,
      borderUpColor: next.up, borderDownColor: next.down, wickUpColor: next.up, wickDownColor: next.down,
    });
    for (const [, key, series] of maSeries) series.applyOptions({ color: next[key] });
    volumeSeries.applyOptions({ color: next.volume });
    host.querySelectorAll(".kl-legend i").forEach((dot, i) => {
      dot.style.setProperty("--c", i < MA_DEFS.length ? next[MA_DEFS[i][2]] : next.volume);
    });
  });
  theme.observe(document.documentElement, { attributes: true, attributeFilter: ["data-mode"] });

  return {
    chart,
    destroy: () => {
      disposed = true;
      offWheel();
      sizeObserver.disconnect();
      theme.disconnect();
      chart.remove();
      host.innerHTML = "";
      host.style.height = "";
      host.classList.remove("kl-host");
    },
  };
}

/* 折线趋势：和 K 线共用 lightweight-charts 外壳、滚轮缩放、拖拽平移与悬浮读数。
   spec.series = [{ name, color, data: [{ time, value }] }]；spec.measure = count | ratio。 */
export function createTrendChart(host, spec = {}) {
  const input = (Array.isArray(spec.series) ? spec.series : []).map((s) => ({
    ...s,
    data: (Array.isArray(s.data) ? s.data : [])
      .filter((p) => p && p.time != null && Number.isFinite(Number(p.value)))
      .map((p) => ({ time: String(p.time), value: Number(p.value) }))
      .sort((a, b) => a.time.localeCompare(b.time)),
  })).filter((s) => s.data.length);
  const volume = (Array.isArray(spec.volume) ? spec.volume : [])
    .filter((p) => p && p.time != null && Number.isFinite(Number(p.value)))
    .map((p) => ({ time: String(p.time), value: Number(p.value) }))
    .sort((a, b) => a.time.localeCompare(b.time));
  const height = Math.max(220, Number(spec.height) || host.clientHeight || 300);
  const empty = spec.emptyText || "暂无趋势数据";
  host.className = `${host.className.replace(/\s*kl-host/g, "")} kl-host kl-trend`;
  host.innerHTML = "";
  if (!input.length) {
    host.innerHTML = `<div class="empty">${esc(empty)}</div>`;
    return {
      destroy: () => {
        host.innerHTML = "";
        host.style.height = "";
        host.classList.remove("kl-host", "kl-trend");
      },
    };
  }
  host.style.height = `${height}px`;

  const colors = palette();
  const measure = spec.measure === "ratio" ? "ratio" : "count";
  const valueText = (v) => (measure === "ratio" ? `${fmt(v, Math.abs(v) >= 10 ? 1 : 2)}%` : fmt(Math.round(v)));
  const timeTextOf = (time) => timeText(time);
  const priceFormat = measure === "ratio"
    ? { type: "custom", formatter: valueText, minMove: 0.01 }
    : { type: "price", precision: 0, minMove: 1 };
  // 折线身份由上方折线卡承担，图内不再重复一排 legend。
  host.innerHTML = `<div class="kl-canvas"></div><div class="kl-tip" hidden></div>`;
  const canvas = host.querySelector(".kl-canvas");
  const tip = host.querySelector(".kl-tip");

  const chart = createChart(canvas, {
    width: Math.max(1, canvas.clientWidth),
    height: Math.max(1, canvas.clientHeight),
    layout: {
      background: { type: ColorType.Solid, color: "transparent" },
      textColor: colors.text,
      fontSize: 10,
      fontFamily: getComputedStyle(document.body).fontFamily,
      attributionLogo: false,
    },
    grid: { vertLines: { color: colors.grid }, horzLines: { color: colors.grid } },
    rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.14, bottom: 0.08 } },
    timeScale: {
      borderVisible: false, rightOffset: 2,
      tickMarkFormatter: (time) => timeTextOf(time).slice(5),
    },
    crosshair: {
      vertLine: { color: colors.border, width: 1, style: 3 },
      horzLine: { color: colors.border, width: 1, style: 3 },
    },
    handleScroll: { mouseWheel: false, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
    handleScale: {
      mouseWheel: false, pinch: true, axisDoubleClickReset: true,
      axisPressedMouseMove: { time: true, price: false },
    },
    localization: { timeFormatter: (time) => timeTextOf(time) },
  });
  const wheelAllowed = typeof spec.wheelZoom === "function" ? spec.wheelZoom : () => spec.wheelZoom === true;
  const offWheel = wireWheelZoom(host, chart, wheelAllowed);

  const byApi = new Map();
  const lineSeries = input.map((s) => {
    const color = cssColor(s.color, colors.ma5);
    const series = chart.addSeries(AreaSeries, {
      lineColor: color,
      topColor: alphaColor(color, 0.14),
      bottomColor: alphaColor(color, 0.01),
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: true,
      crosshairMarkerRadius: 4,
      priceFormat,
    });
    series.setData(s.data);
    byApi.set(series, s);
    return series;
  });

  // 量能：同一时间轴上的 Trace 柱，放在下方独立 pane，和上方曲线共享缩放。
  let volumeSeries = null;
  if (volume.some((d) => d.value > 0)) {
    const volumePane = chart.addPane();
    volumeSeries = volumePane.addSeries(HistogramSeries, {
      priceScaleId: "volume",
      color: colors.volume,
      priceFormat: { type: "volume" },
      priceLineVisible: false,
      lastValueVisible: false,
    });
    volumeSeries.setData(volume);
    chart.priceScale("volume", 1).applyOptions({ visible: false });
    const panes = chart.panes();
    if (panes[0]) panes[0].setStretchFactor(3);
    volumePane.setStretchFactor(1);
  }
  chart.timeScale().fitContent();

  const lookup = new Map(input.map((s) => [s, new Map(s.data.map((d) => [d.time, d.value]))]));
  const dates = [...new Set(input.flatMap((s) => s.data.map((d) => d.time)))].sort();
  const markerTime = (date) => dates.find((time) => time >= date) || null;
  const releaseItems = (() => {
    const seen = new Set();
    return (Array.isArray(spec.releases) ? spec.releases : []).map((r) => {
      if (!r || !r.date) return null;
      const date = String(r.date);
      if (!dates.length || date < dates[0] || date > dates[dates.length - 1]) return null;
      const time = markerTime(date);
      if (!time || seen.has(time)) return null;
      seen.add(time);
      return { time, label: r.label || "发版" };
    }).filter(Boolean);
  })();
  const releaseLines = releaseItems.length
    ? releaseLinePrimitive(chart, releaseItems, colors.release, getComputedStyle(document.body).fontFamily, colors.card)
    : null;
  if (releaseLines) lineSeries[0].attachPrimitive(releaseLines);

  chart.subscribeCrosshairMove((param) => {
    if (!param?.point || param.time == null) {
      tip.hidden = true;
      return;
    }
    const when = timeTextOf(param.time);
    const rows = input
      .map((s) => ({ s, v: lookup.get(s).get(when) }))
      .filter((row) => row.v != null);
    if (!rows.length) {
      tip.hidden = true;
      return;
    }
    tip.innerHTML = `<div class="kl-tip-head"><b class="num">${esc(when)}</b><span>${esc(measure === "ratio" ? "出现比例" : "出现数")}</span></div>${rows
      .map(({ s, v }) => `<div class="kl-tip-row"><span class="kl-tip-name"><i style="--c:${cssColor(s.color, colors.ma5)}"></i>${esc(s.name || "")}</span><b class="num">${esc(valueText(v))}</b></div>`)
      .join("")}`;
    tip.hidden = false;
    const pad = 8;
    const left = Math.min(Math.max(pad, param.point.x + 14), host.clientWidth - tip.offsetWidth - pad);
    const top = Math.max(pad, canvas.offsetTop + Math.min(param.point.y + 12, canvas.clientHeight - tip.offsetHeight - pad));
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
  });

  if (typeof spec.onPick === "function") {
    chart.subscribeClick((param) => {
      if (!param?.time) return;
      const when = timeTextOf(param.time);
      let si = param.hoveredSeries ? input.indexOf(byApi.get(param.hoveredSeries)) : -1;
      // 没点在线条本身时，取指针纵向上最近的那条（放大后线条仍可点）。
      if (si < 0 && param.point) {
        let best = Infinity;
        input.forEach((s, i) => {
          const v = lookup.get(s).get(when);
          if (v == null) return;
          const y = lineSeries[i].priceToCoordinate(v);
          if (y == null) return;
          const d = Math.abs(y - param.point.y);
          if (d < best) { best = d; si = i; }
        });
      }
      if (si < 0) si = input.findIndex((s) => lookup.get(s).has(when));
      if (si >= 0) spec.onPick({ time: when, seriesIndex: si });
    });
  }

  let disposed = false;
  const sizeObserver = new ResizeObserver(() => {
    if (disposed || !canvas.isConnected) return;
    const width = canvas.clientWidth;
    const total = canvas.clientHeight;
    if (width > 0 && total > 0) chart.resize(width, total);
  });
  sizeObserver.observe(canvas);

  const theme = new MutationObserver(() => {
    const next = palette();
    chart.applyOptions({
      layout: { textColor: next.text },
      grid: { vertLines: { color: next.grid }, horzLines: { color: next.grid } },
      crosshair: { vertLine: { color: next.border }, horzLine: { color: next.border } },
    });
    lineSeries.forEach((series, i) => {
      const color = cssColor(input[i].color, next.ma5);
      series.applyOptions({ lineColor: color, topColor: alphaColor(color, 0.14), bottomColor: alphaColor(color, 0.01) });
    });
    if (volumeSeries) volumeSeries.applyOptions({ color: next.volume });
    releaseLines?.setColors(next.release, next.card);
  });
  theme.observe(document.documentElement, { attributes: true, attributeFilter: ["data-mode"] });

  return {
    chart,
    destroy: () => {
      disposed = true;
      offWheel();
      sizeObserver.disconnect();
      theme.disconnect();
      chart.remove();
      host.innerHTML = "";
      host.style.height = "";
      host.classList.remove("kl-host", "kl-trend");
    },
  };
}
