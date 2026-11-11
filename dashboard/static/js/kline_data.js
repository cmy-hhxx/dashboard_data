/* K 线聚合：把按天采样的计数序列折叠成日/周/月/年蜡烛。纯函数，图表模块和测试共用。 */
export const KLINE_PERIODS = [
  ["intraday", "日内行情"],
  ["day", "日K"],
  ["week", "周K"],
  ["month", "月K"],
  ["year", "年K"],
];

export const PERIOD_NAME = Object.fromEntries(KLINE_PERIODS);
const DAY_MS = 86400000;
const dateMs = (date) => Date.parse(`${date}T00:00:00Z`);

/* 周按周一开始；月/年直接取前缀。蜡烛 time 用该周期最后一天，刻度落在收盘日。 */
function bucketKey(date, period) {
  if (period === "month") return date.slice(0, 7);
  if (period === "year") return date.slice(0, 4);
  if (period !== "week") return date;
  const ms = dateMs(date);
  const weekday = new Date(ms).getUTCDay();      // 0 = 周日
  return new Date(ms - ((weekday + 6) % 7) * DAY_MS).toISOString().slice(0, 10);
}

/* 日序列只有每天一个值，没有日内高低：开盘取上一周期收盘（第一根取自身），
   最高 / 最低取周期内所有日值与开盘的极值。这样日K不会退化成一根横线，
   周/月/年也保持连续的跳空关系。 */
export function buildCandles(rows, period = "day") {
  const groups = [];
  let current = null;
  for (const row of rows) {
    const date = String(row?.date || "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const value = Number(row.value);
    const volume = Number(row.volume);
    if (!Number.isFinite(value) || !Number.isFinite(volume) || volume <= 0) continue;
    const key = bucketKey(date, period);
    if (!current || current.key !== key) {
      current = { key, from: date, to: date, values: [], volume: 0 };
      groups.push(current);
    }
    current.to = date;
    current.values.push(value);
    current.volume += volume;
  }
  let previous = null;
  return groups.map((group) => {
    const open = previous == null ? group.values[0] : previous;
    const close = group.values[group.values.length - 1];
    const high = Math.max(open, ...group.values);
    const low = Math.min(open, ...group.values);
    previous = close;
    return {
      time: group.to, open, high, low, close,
      volume: group.volume, from: group.from, to: group.to,
      label: period === "day" ? group.to : `${group.from} ~ ${group.to}`,
    };
  });
}

/* 行情：只取最新交易日，按 5 分钟槽累计所选等级的问题数。图从当日 0 起算，槽内没有新数据
   就沿用上一个累计值，画成平蜡烛；前一交易日总数只作为悬浮里的参照。 */
export function buildIntradayCandles(intraday, selected, levels) {
  const buckets = Array.isArray(intraday?.buckets) ? intraday.buckets : [];
  const idx = (selected || []).map((level) => levels.indexOf(level)).filter((i) => i >= 0);
  if (!buckets.length || !idx.length) return [];
  const date = String(intraday.date || "");
  const base = Date.parse(`${date}T00:00:00+08:00`);
  if (!Number.isFinite(base)) return [];
  const step = Math.max(1, Number(intraday.bucket_minutes) || 5);
  const at = new Map(buckets.map(([minute, ...counts]) => [Number(minute), counts.map(Number)]));
  // A bucket outside the local day would stretch the axis into a second date; the backend
  // already scopes by local date, this keeps a malformed row from doing it again.
  const minutes = [...at.keys()]
    .filter((minute) => Number.isInteger(minute) && minute >= 0 && minute < 1440)
    .sort((a, b) => a - b);
  if (!minutes.length) return [];
  let cumulative = 0;
  let previous = 0;
  const candles = [];
  for (let minute = minutes[0]; minute <= minutes[minutes.length - 1]; minute += step) {
    const counts = at.get(minute);
    const added = counts ? idx.reduce((n, i) => n + (counts[i] || 0), 0) : 0;
    const volume = counts ? counts.reduce((n, value) => n + (value || 0), 0) : 0;
    cumulative += added;
    const open = previous;
    const close = cumulative;
    const clock = `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
    candles.push({
      time: Math.floor(base / 1000) + minute * 60,
      open, high: Math.max(open, close), low: Math.min(open, close), close,
      volume, from: minute, to: minute + step, label: clock,
    });
    previous = close;
  }
  return candles;
}

export function movingAverage(candles, span) {
  const out = [];
  let total = 0;
  for (let i = 0; i < candles.length; i++) {
    total += candles[i].close;
    if (i >= span) total -= candles[i - span].close;
    if (i >= span - 1) out.push({ time: candles[i].time, value: Math.round((total / span) * 100) / 100 });
  }
  return out;
}
