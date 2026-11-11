import assert from "node:assert/strict";
import test from "node:test";

const { buildCandles, buildIntradayCandles, movingAverage, KLINE_PERIODS } = await import("../static/js/kline_data.js");

const row = (date, value, volume = 1) => ({ date, value, volume });

test("daily candles use the previous close as open, so a one-value day is not a flat line", () => {
  const candles = buildCandles([row("2026-11-01", 10, 100), row("2026-11-02", 14, 120), row("2026-11-03", 9, 80)]);
  assert.equal(candles.length, 3);
  assert.deepEqual(
    candles.map(({ time, open, high, low, close, volume }) => ({ time, open, high, low, close, volume })),
    [
      { time: "2026-11-01", open: 10, high: 10, low: 10, close: 10, volume: 100 },
      { time: "2026-11-02", open: 10, high: 14, low: 10, close: 14, volume: 120 },
      { time: "2026-11-03", open: 14, high: 14, low: 9, close: 9, volume: 80 },
    ],
  );
});

test("weeks start on Monday and carry the prior close across the boundary", () => {
  const candles = buildCandles([
    row("2026-11-01", 10, 10),   // 周日，属于 10-26 那一周
    row("2026-11-02", 20, 20),   // 周一
    row("2026-11-03", 30, 30),
  ], "week");
  assert.equal(candles.length, 2);
  assert.deepEqual(
    candles.map(({ time, from, to, open, high, low, close, volume }) => ({ time, from, to, open, high, low, close, volume })),
    [
      { time: "2026-11-01", from: "2026-11-01", to: "2026-11-01", open: 10, high: 10, low: 10, close: 10, volume: 10 },
      { time: "2026-11-03", from: "2026-11-02", to: "2026-11-03", open: 10, high: 30, low: 10, close: 30, volume: 50 },
    ],
  );
  assert.equal(candles[1].label, "2026-11-02 ~ 2026-11-03");
});

test("month and year candles aggregate high, low, close and volume", () => {
  const rows = [row("2026-10-31", 5, 1), row("2026-11-01", 8, 2), row("2026-11-05", 10, 3)];
  const months = buildCandles(rows, "month");
  assert.deepEqual(months.map(({ time, open, high, low, close, volume }) => ({ time, open, high, low, close, volume })), [
    { time: "2026-10-31", open: 5, high: 5, low: 5, close: 5, volume: 1 },
    { time: "2026-11-05", open: 5, high: 10, low: 5, close: 10, volume: 5 },
  ]);
  const years = buildCandles(rows, "year");
  assert.equal(years.length, 1);
  assert.deepEqual(years[0], { time: "2026-11-05", open: 5, high: 10, low: 5, close: 10, volume: 6, from: "2026-10-31", to: "2026-11-05", label: "2026-10-31 ~ 2026-11-05" });
});

test("invalid dates and days with no evaluated volume are skipped", () => {
  const candles = buildCandles([row("not-a-date", 4), row("2026-11-01", 4, 0), row("2026-11-02", 0, 3)]);
  assert.deepEqual(candles.map((candle) => [candle.time, candle.close]), [["2026-11-02", 0]]);
});

test("MA5 averages the last five closes and starts only when the window is full", () => {
  const candles = [1, 2, 3, 4, 5, 6].map((value, i) => buildCandles([row(`2026-11-0${i + 1}`, value, 1)])[0]);
  const ma = movingAverage(candles, 5);
  assert.deepEqual(ma, [
    { time: "2026-11-05", value: 3 },
    { time: "2026-11-06", value: 4 },
  ]);
});

test("all five period buttons exist in display order", () => {
  assert.deepEqual(KLINE_PERIODS, [["intraday", "日内行情"], ["day", "日K"], ["week", "周K"], ["month", "月K"], ["year", "年K"]]);
});

test("intraday 5-minute candles carry yesterday's total as the first open and stay flat on empty slots", () => {
  const intraday = {
    date: "2026-11-09",
    bucket_minutes: 5,
    prev: [10, 20, 0, 0, 0, 0],
    buckets: [
      [0, 2, 0, 0, 0, 0, 0],
      [10, 0, 3, 0, 0, 0, 0],
      [25, 1, 0, 0, 0, 0, 0],
    ],
  };
  const candles = buildIntradayCandles(intraday, ["P0", "P1"], ["P0", "P1", "P2", "P3", "P4", "none"]);
  assert.equal(candles.length, 6);
  assert.deepEqual(candles.map(({ label, open, high, low, close, volume }) => ({ label, open, high, low, close, volume })), [
    { label: "00:00", open: 0, high: 2, low: 0, close: 2, volume: 2 },
    { label: "00:05", open: 2, high: 2, low: 2, close: 2, volume: 0 },
    { label: "00:10", open: 2, high: 5, low: 2, close: 5, volume: 3 },
    { label: "00:15", open: 5, high: 5, low: 5, close: 5, volume: 0 },
    { label: "00:20", open: 5, high: 5, low: 5, close: 5, volume: 0 },
    { label: "00:25", open: 5, high: 6, low: 5, close: 6, volume: 1 },
  ]);
  const midnight = Date.parse("2026-11-09T00:00:00+08:00") / 1000;
  assert.equal(candles[0].time, midnight);
  assert.equal(candles[1].time, midnight + 5 * 60);
});

test("intraday without buckets or selected levels stays empty", () => {
  assert.deepEqual(buildIntradayCandles({ date: "2026-11-09", buckets: [] }, ["P0"], ["P0"]), []);
  assert.deepEqual(buildIntradayCandles({ date: "2026-11-09", buckets: [[0, 1]] }, [], ["P0"]), []);
});

test("intraday drops buckets that fall outside the local day", () => {
  const levels = ["P0", "P1"];
  const intraday = {
    date: "2026-11-09",
    bucket_minutes: 5,
    buckets: [[1440, 3, 0], [1500, 0, 7], [785, 1, 2]],
  };
  const candles = buildIntradayCandles(intraday, ["P0", "P1"], levels);
  assert.deepEqual(candles.map(({ label, close }) => [label, close]), [["13:05", 3]]);
  assert.deepEqual(buildIntradayCandles({ date: "2026-11-09", bucket_minutes: 5, buckets: [[1440, 1, 0]] }, ["P0"], levels), []);
});
