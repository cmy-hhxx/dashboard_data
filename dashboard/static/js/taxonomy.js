/* Current-taxonomy lookup for stored problem codes.

   A rebuilt cluster tree can drop a level-4 leaf while keeping its level-3 parent.  The raw
   stored code stays useful for diagnosis, but the label must come from the current tree: walk
   up until a node exists and report which code supplied the name. */
export function patternOf(tax, code) {
  const patterns = tax && tax.patterns;
  if (!patterns || code == null) return null;
  const raw = String(code);
  let id = raw;
  for (;;) {
    const node = patterns[id];
    if (node) return { ...node, id, exact: id === raw };
    const cut = id.lastIndexOf(".");
    if (cut < 0) return null;
    id = id.slice(0, cut);
  }
}

export const patternName = (tax, code) => (patternOf(tax, code) || {}).name || code;
