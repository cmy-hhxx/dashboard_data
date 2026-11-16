/* 文档: the evaluation system's written reference. The index is a set of liquid flood cards (one
   per document); a card opens its document at ?view=docs&doc=<id>. The documents themselves are
   still being written, so each opens on a placeholder page that says so. */
import { $, esc } from "./core.js";
import { floodCards } from "./shader_flood.js";

const DOCS = [
  {
    id: "severity", title: "P0–P4 口径定义", kicker: "定级",
    desc: "每一级严重度代表什么、怎样判定，以及相邻两级的边界案例。",
    icon: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 20V14M10 20V10M15 20V6M20 20V3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    palette: ["#3a0a0c", "#d2452f", "#ffd6c6"],
  },
  {
    id: "capacity", title: "评测容量说明", kicker: "容量",
    desc: "每天能评多少会话、各环节的耗时与并发上限，以及容量不够时先评什么。",
    icon: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 15a8 8 0 1 1 16 0" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M12 15l4-5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="15" r="1.6" fill="currentColor"/><path d="M4 19h16" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    palette: ["#0b2358", "#3a63f0", "#d4e0ff"],
  },
];
const BACK = '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M10 3.5 5.5 8l4.5 4.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function indexHTML() {
  return `<div class="dc">
    <header class="dc-head"><span class="dc-k">文档</span><h1>评测体系说明</h1>
      <p>评测怎样定级、能评多少，写成可以反复查阅的说明。把指针移到卡片上，或用键盘 Tab 聚焦；点开进入文档。</p></header>
    <div class="dc-stage" id="dcStage">
      <div class="dc-grid" role="list">${DOCS.map((d, i) => `<a class="dc-card" role="listitem" href="?view=docs&amp;doc=${d.id}" data-flood data-doc="${d.id}" style="--dc-accent:${d.palette[1]};--i:${i}">
        <span class="dc-icon">${d.icon}</span>
        <span class="dc-body"><small>${esc(d.kicker)}</small><b>${esc(d.title)}</b><span>${esc(d.desc)}</span></span>
      </a>`).join("")}</div>
    </div>
  </div>`;
}

function docHTML(d) {
  return `<div class="dc dc-doc">
    <nav class="dc-crumb"><button type="button" class="dc-back" data-back>${BACK}文档</button><span>/</span><span>${esc(d.title)}</span></nav>
    <article class="card dc-page" style="--dc-accent:${d.palette[1]}">
      <header class="dc-page-head"><span class="dc-icon">${d.icon}</span><div><small>${esc(d.kicker)}</small><h1>${esc(d.title)}</h1><p>${esc(d.desc)}</p></div></header>
      <div class="dc-empty" role="status"><b>内容整理中</b><span>这份文档还在撰写，完成后会直接出现在这里。</span>
        <div class="dc-lines" aria-hidden="true"><i style="width:92%"></i><i style="width:78%"></i><i style="width:85%"></i><i style="width:40%"></i></div></div>
    </article>
  </div>`;
}

export async function render(root, c) {
  const id = new URLSearchParams(location.search).get("doc");
  const doc = DOCS.find((d) => d.id === id);
  const key = doc ? doc.id : "index";
  if (root._dcKey === key && root.firstChild) return;
  root._dcKey = key;
  root._flood?.destroy();
  root._flood = null;
  root.innerHTML = doc ? docHTML(doc) : indexHTML();
  if (!root._dcWired) {
    root._dcWired = true;
    root.addEventListener("click", (e) => {
      if (e.target.closest("[data-back]")) root._nav?.({ view: "docs", doc: null });
    });
  }
  root._nav = c.navigate;
  if (doc) return;
  const stage = $("#dcStage", root);
  const cards = [...stage.querySelectorAll("[data-flood]")];
  root._flood = floodCards(stage, cards, {
    palettes: DOCS.map((d) => d.palette),
    radius: 24,
    onOpen: (i) => c.navigate?.({ view: "docs", doc: DOCS[i].id }),
  });
}
