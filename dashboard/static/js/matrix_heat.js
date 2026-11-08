/* The heatmap changes only its problem axis. Parent cells already contain their
   descendants, so every row reads exactly one payload node at every depth. */
export function matrixHeatSummary(trend, root, keys = [], scenes = new Set()) {
  if (!trend?.dates?.length || !Array.isArray(trend.cells) || !root) return null;
  const path = [];
  let focus = root;
  for (const key of keys) {
    const next = (focus.children || []).find((node) => node.prefix === key && node.children?.length);
    if (!next) break;
    path.push(next);
    focus = next;
  }
  const dates = trend.dates;
  const groups = (focus.children || []).map((node) => ({
    node, name: node.name, days: dates.map(() => ({ n: 0, hits: 0, observed: false, unknown: false })),
  }));
  const nodeIndexes = new Map((trend.nodes || []).map((node, i) => [node, i]));
  const groupForNode = new Map(groups.map((group) => [nodeIndexes.get(group.node.prefix), group]));
  const daily = dates.map(() => ({ sessions: 0 }));
  for (const [di, sc, , , sessions] of trend.base || []) {
    if (scenes.has(sc) && daily[di]) daily[di].sessions += Number(sessions) || 0;
  }
  for (const raw of trend.cells) {
    const [di, sc, ni] = raw;
    const group = groupForNode.get(ni);
    if (!scenes.has(sc) || !group?.days[di]) continue;
    const day = group.days[di];
    day.n += raw.slice(5, 10).reduce((total, count) => total + (Number(count) || 0), 0);
    if (raw[15] != null) {
      day.hits += Number(raw[15]) || 0;
    } else day.unknown = true;
  }
  groups.forEach((group) => group.days.forEach((day, i) => {
    day.observed = daily[i].sessions > 0 && nodeIndexes.has(group.node.prefix) && !day.unknown;
  }));
  return { dates, daily, groups, path };
}
