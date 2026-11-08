/* Trace-level analysis consumes the builder's exclusive worst-severity bins.
   Session hits and problem counts cannot reconstruct this distribution. */
export function traceSeverityModel(trend) {
  const source = trend?.trace_severity;
  const levels = ["P0", "P1", "P2", "P3", "P4", "none"];
  if (!source || !levels.every((level, i) => source.levels?.[i] === level) || source.daily?.length !== trend.dates?.length) return null;
  const rows = trend.dates.map((date, i) => ({ date, counts: source.daily[i] }))
    .filter(({ date, counts }) => /^\d{4}-\d{2}-\d{2}$/.test(date) && counts?.length === 6 && counts.every((n) => Number.isInteger(n) && n >= 0));
  const counts = levels.map((_, level) => rows.reduce((total, day) => total + day.counts[level], 0));
  return { levels, rows, counts, total: counts.reduce((a, b) => a + b, 0), unresolved: source.unresolved || 0 };
}

// Largest remainders keep the displayed six shares at exactly 100.0%.
export function traceShares(counts) {
  const total = counts.reduce((a, b) => a + b, 0);
  if (!total) return counts.map(() => null);
  const raw = counts.map((n) => n * 1000 / total);
  const units = raw.map(Math.floor);
  const order = raw.map((n, i) => ({ i, remainder: n - units[i] })).sort((a, b) => b.remainder - a.remainder || a.i - b.i);
  for (let i = 0, left = 1000 - units.reduce((a, b) => a + b, 0); i < left; i++) units[order[i].i]++;
  return units.map((n) => n / 10);
}
