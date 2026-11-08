/* Recall is constrained to the selected day, series and taxonomy prefix. Severity
   is checked on the problems themselves, never on a multi-label Session's worst. */
export function trendSampleFrame(chart) {
  return `<div class="gx mxt-samples"><div class="gx-in mxt-sample-layout"><div class="gx-map">${chart}</div><aside class="gx-side mxt-sample-side" aria-label="所选问题簇的样本" hidden></aside></div></div>`;
}

/* Layout leaf: every ref of one side's batch that lands on this cluster path. */
export function abLeafRefs(round, sides, node) {
  const refs = [];
  for (const side of sides) {
    for (const ref of round.sample_refs?.[side] || []) {
      if (!(ref.paths || []).some((path) => path === node || path.startsWith(`${node}.`))) continue;
      refs.push({ ...ref, side });
    }
  }
  return refs;
}

export function abTrendSampleRefs(round, sides, row, node) {
  const refs = [];
  for (const side of sides) {
    for (const ref of round.sample_refs?.[side] || []) {
      const scene = row.group ? row.tasks.includes(ref.task) : !row.task || row.task === ref.task && (!row.sub || row.sub === ref.sub);
      if (!scene || !ref.paths.some((path) => path === node || path.startsWith(`${node}.`))) continue;
      refs.push({ ...ref, side });
    }
  }
  return refs;
}

export function resolveABSamples(refs, rows, node) {
  const bySlug = new Map(rows.map((row) => [row.s, row]));
  const items = [], seen = new Set();
  let unavailable = 0;
  for (const ref of refs) {
    // The baseline and online batches live in the recall index; a retest keeps its own detail
    // reference (eq) instead, so it never borrows the baseline row for the same trace.
    const matches = ref.slug ? [bySlug.get(ref.slug)].filter(Boolean) : ref.side === "before"
      ? rows.filter((row) => row.tid === ref.trace && (!ref.model || row.m === ref.model || row.m.endsWith(`_${ref.model}`))) : [];
    const matched = matches.length === 1 ? matches[0] : null;
    const row = matched || (ref.side === "after" && ref.detail != null
      ? { s: String(ref.detail), q: ref.q || "", m: ref.model || "", sp: "", d: "" }
      : null);
    if (!row) { unavailable++; continue; }
    const key = ref.detail != null ? `eq:${ref.detail}` : `${row.s}|${ref.trace || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ row, trace: ref.trace, n: (ref.paths || []).filter((path) => path === node || path.startsWith(`${node}.`)).length, ref });
  }
  return { items, unavailable };
}

export function trendSampleCandidates(rows, { date, node, models = [], uts = [], scenes = null }) {
  return rows.filter((row) => row.d === date
    && (!models.length || models.includes(row.m))
    && (!uts.length || uts.includes(row.ut || "unknown"))
    && (!scenes || scenes.some(([task, sub]) => task === (row.task || row.sc || row.skill || "未接入分类体系") && sub === (row.sub || "")))
    && (row.pt || []).some((path) => path === node || path.startsWith(`${node}.`)));
}

export function trendSampleProblems(detail, node, levels) {
  return (detail.attribution?.problems || []).filter((problem) => {
    const path = problem.cl?.path || "";
    return (path === node || path.startsWith(`${node}.`)) && levels.includes(problem.sev);
  });
}

export function traceSampleRefs(trend, date, level) {
  const di = trend.dates.indexOf(date);
  const li = trend.trace_severity?.levels?.indexOf(level);
  if (di < 0 || li == null || li < 0) return [];
  return (trend.trace_severity.refs || []).filter(([day, , , severity]) => day === di && severity === li);
}
