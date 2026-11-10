/* K 线图：把按天采样的计数序列聚合成日/周/月/年蜡烛，叠加 MA5 / MA10 / MA20 和成交式量能。
   基于 TradingView 的 lightweight-charts（Apache-2.0，vendor 在 static/vendor）；不自绘 Canvas。
   数据口径由调用方给全量 rows；这里只负责聚合和绘制，不做任何筛选。 */
import { createChart, CandlestickSeries, HistogramSeries, LineSeries, ColorType } from "../vendor/lightweight-charts.production.js";
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
    up: colorOf("--sev-1", "#bf3822"),
    down: colorOf("--loc-ulq", "#1d7d72"),
    volume: colorOf("--t3", "#aeb5bf"),
    ma5: colorOf("--accent", "#3552d8"),
    ma10: colorOf("--mx-c4", "#b3651f"),
    ma20: colorOf("--mx-c3", "#6a43b8"),
  };
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
    rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.08, bottom: 0.08 } },
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
      mouseWheel: true, pinch: true, axisDoubleClickReset: true,
      axisPressedMouseMove: { time: true, price: false },
    },
    localization: { timeFormatter: (time) => tick(time) },
  });

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
      sizeObserver.disconnect();
      theme.disconnect();
      chart.remove();
      host.innerHTML = "";
      host.style.height = "";
      host.classList.remove("kl-host");
    },
  };
}
