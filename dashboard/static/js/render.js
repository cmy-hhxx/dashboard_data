/* Shared rendering for message content: plain text, Markdown and JSON.
 *
 * One entry point keeps every pane consistent, and evidence marks survive it:
 *   1. segment the text at evidence offsets (caller-supplied), wrapping each
 *      covered range in private-use sentinels so sizes never affect offsets;
 *   2. format the whole string (Markdown / JSON pretty-print);
 *   3. swap the sentinels for real <mark> elements.
 * Offsets are therefore absolute inside the original text, and formatting only
 * adds decoration around them — never moves the characters that get marked.
 */
import { esc } from "./core.js";

const O = "";
const C = "";
const RANGE = /(\d+)([\s\S]*?)(\d+)/g;
const TOKEN = /(\d+)/g;

/* ---------------------------------------------------------------- segmentation */

/**
 * Split text into runs covered by evidence ranges.
 * `segs` = [{e, s, z, kind}] with offsets in `text` (not in the outer block).
 * Returns HTML; caller supplies `mark(ids, kind)` → opening/closing tags.
 */
export function segment(text, segs, mark, mode) {
  if (!text) return "";
  if (!segs || !segs.length || !text.length) {
    if (mode === "inline") return inline(text);
    return mode === "md" ? md(text) : esc(text);
  }
  const cuts = new Set([0, text.length]);
  segs.forEach((k) => {
    if (k.z > 0 && k.s < text.length) {
      cuts.add(Math.max(0, Math.min(text.length, k.s)));
      cuts.add(Math.max(0, Math.min(text.length, k.z)));
    }
  });
  const cs = [...cuts].sort((a, b) => a - b);
  let out = "";
  for (let j = 0; j < cs.length - 1; j++) {
    const a = cs[j];
    const z = cs[j + 1];
    if (z <= a) continue;
    const body = mode === "inline" ? inline(text.slice(a, z)) : esc(text.slice(a, z));
    const cover = segs.filter((k) => k.s <= a && k.z >= z);
    out += cover.length ? mark(cover, body) : body;
  }
  return out;
}

/* ---------------------------------------------------------------- markdown */

const codeSpan = (s) =>
  `<code>${esc(s)}</code>`;

function inline(src) {
  let s = esc(src);
  // Protect inline code first so its contents are never re-formatted.
  const held = [];
  s = s.replace(/`([^`\n]+)`/g, (_, code) => {
    held.push(codeSpan(code));
    return `${held.length - 1}`;
  });
  s = s
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_\n]+)__/g, "<strong>$1</strong>")
    .replace(/(^|[\s（(“‘])\*([^*\n]+)\*(?=$|[\s）)”，。、：；！？])/g, "$1<em>$2</em>")
    .replace(/~~([^~\n]+)~~/g, "<del>$1</del>")
    .replace(/\[([^\]\n]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
  return s.replace(/(\d+)/g, (_, i) => held[Number(i)]);
}

const LIST_LINE = /^\s*([-*+]|\d+[.)])\s+(.*)$/;
const HEAD_LINE = /^(#{1,6})\s+(.*)$/;
const RULE_LINE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const FENCE = /^\s*```([\w+-]*)\s*$/;

function tableRow(line) {
  const cells = line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
  return `<tr>${cells.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`;
}

/**
 * Markdown-lite → HTML. Covers what model output actually uses: headings,
 * fenced code, ordered/unordered lists, GFM tables, quotes, rules, paragraphs.
 */
export function md(src) {
  const lines = String(src == null ? "" : src).replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    const fence = FENCE.exec(line);
    if (fence) {
      const body = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) body.push(lines[i++]);
      i++;
      out.push(`<pre class="code"${fence[1] ? ` data-lang="${esc(fence[1])}"` : ""}><code>${esc(body.join("\n"))}</code></pre>`);
      continue;
    }

    if (!line.trim()) {
      i++;
      continue;
    }

    if (RULE_LINE.test(line)) {
      out.push("<hr>");
      i++;
      continue;
    }

    const head = HEAD_LINE.exec(line);
    if (head) {
      const n = Math.min(6, head[1].length + 2);
      out.push(`<h${n} class="md-h">${inline(head[2])}</h${n}>`);
      i++;
      continue;
    }

    // Table: pipe header + separator row.
    if (/\|/.test(line) && i + 1 < lines.length && /^\s*\|?[\s:-]*-[\s:|-]*$/.test(lines[i + 1]) && /-/.test(lines[i + 1])) {
      const head = line.trim().replace(/^\||\|$/g, "");
      const rows = [];
      i += 2;
      while (i < lines.length && /\|/.test(lines[i]) && lines[i].trim()) rows.push(tableRow(lines[i++]));
      out.push(`<div class="md-table"><table><thead>${tableRow(head).replace(/<td>/g, "<th>").replace(/<\/td>/g, "</th>")}</thead><tbody>${rows.join("")}</tbody></table></div>`);
      continue;
    }

    if (/^\s*>/.test(line)) {
      const body = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ""));
      out.push(`<blockquote>${md(body.join("\n"))}</blockquote>`);
      continue;
    }

    if (LIST_LINE.test(line)) {
      const ordered = /^\s*\d/.test(line);
      const items = [];
      while (i < lines.length && LIST_LINE.test(lines[i])) {
        const m = LIST_LINE.exec(lines[i]);
        if (/^\s*\d/.test(lines[i]) !== ordered) break;
        let body = m[2];
        i++;
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !LIST_LINE.test(lines[i])) body += ` ${lines[i++].trim()}`;
        items.push(`<li>${inline(body)}</li>`);
      }
      out.push(`<${ordered ? "ol" : "ul"} class="md-list">${items.join("")}</${ordered ? "ol" : "ul"}>`);
      continue;
    }

    const para = [];
    while (i < lines.length && lines[i].trim() && !FENCE.test(lines[i]) && !HEAD_LINE.test(lines[i]) && !LIST_LINE.test(lines[i]) && !RULE_LINE.test(lines[i]) && !/^\s*>/.test(lines[i])) {
      para.push(lines[i++]);
    }
    if (para.length) out.push(`<p>${para.map(inline).join("<br>")}</p>`);
    else i++;
  }
  return out.join("");
}

/* ---------------------------------------------------------------- json */

function prettyJSON(text) {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch (e) {
    return null;
  }
}

function jsonHTML(text) {
  const pretty = prettyJSON(text);
  if (pretty == null) return null;
  return pretty
    .split("\n")
    .map((line) =>
      esc(line)
        .replace(/(&quot;(?:[^&]|&(?!quot;))*?&quot;)(\s*:)/g, '<i class="k">$1</i>$2')
        .replace(/:\s*(&quot;[^&]*?&quot;)/g, ': <i class="s">$1</i>')
        .replace(/\b(true|false|null)\b/g, '<i class="l">$1</i>')
        .replace(/(:\s*)(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g, '$1<i class="n">$2</i>'),
    )
    .join("\n");
}

/* ---------------------------------------------------------------- public entry */

/**
 * renderContent(text, format, segs, mark)
 *   text   original (possibly trimmed) string
 *   format "json" | "text" | "image"
 *   segs   evidence ranges with offsets relative to `text`
 *   mark   (coveringRanges, escapedBody) → HTML
 * When any evidence range falls inside the block, formatting is skipped for
 * that block: the marks must land on the exact characters the evaluator cited,
 * and pretty-printing would move them. Fragments still render inline styles.
 */
export function renderContent(text, format, segs, mark) {
  const t = String(text == null ? "" : text);
  if (!t) return "";
  if (format === "image") return `<span class="cx-img">${esc(t)}</span>`;
  if (segs && segs.length && mark) return segment(t, segs, mark);

  if (format === "json") {
    const html = jsonHTML(t);
    if (html != null) return `<pre class="json-view">${html}</pre>`;
    return `<pre class="json-view raw">${esc(t)}</pre>`;
  }

  // Heuristic: providers often hand back JSON as text.
  if (/^\s*[[{]/.test(t) && t.length > 2) {
    const html = jsonHTML(t);
    if (html != null) return `<pre class="json-view">${html}</pre>`;
  }
  return md(t);
}
