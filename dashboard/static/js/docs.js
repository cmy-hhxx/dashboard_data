/* 文档: three reference documents under ?view=docs (&doc=severity | capacity | api).
   Index shows three liquid-flood cards; opening a card renders the full interactive document. */
import { $, $$, esc, segmented } from "./core.js";
import { floodCards } from "./shader_flood.js";
import { capacityDocHTML, wireCapacityDoc } from "./doc_capacity.js";
import { apiDocHTML, wireApiDoc } from "./doc_api.js";

const DOCS = [
  {
    id: "severity",
    title: "P0–P4 口径定义与实例",
    kicker: "定级",
    meta: "5 档口径 · 75 个案例 · 205 条证据",
    desc: "判级流程、五档严重度边界，以及问财与 AIME 的 75 个真实评测归因案例对照。",
    palette: ["#3a0a0c", "#d2452f", "#ffd6c6"],
  },
  {
    id: "capacity",
    title: "评测容量与性能说明",
    kicker: "容量",
    meta: "292.8 行/h · 41.3 万 token/条",
    desc: "单条归因消耗拆解、五档并发容量阶梯、配比试算器，以及 runtime.log 排查配方。",
    palette: ["#0b2358", "#3a63f0", "#d4e0ff"],
  },
  {
    id: "api",
    title: "评测接口使用指南",
    kicker: "接口",
    meta: "5003 供数 API · 5002 页面深链",
    desc: "乌兰察布与弗吉尼亚部署映射、统一统计口径、5003 查询与增量同步、5002 页面定位。",
    palette: ["#092e2a", "#1d7d72", "#c8f2ec"],
  },
];

const BACK = '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M10 3.5 5.5 8l4.5 4.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

let severityCache = null;

function indexHTML() {
  return `<div class="dc">
    <header class="dc-head"><span class="dc-k">文档</span><h1>评测体系文档</h1></header>
    <div class="dc-stage" id="dcStage">
      <div class="dc-grid" role="list">${DOCS.map((d, i) => `<a class="dc-card" role="listitem" href="?view=docs&amp;doc=${d.id}" data-flood data-doc="${d.id}" style="--dc-accent:${d.palette[1]};--i:${i}">
        <span class="dc-body">
          <span class="dc-top"><small>${esc(d.kicker)}</small><em class="num">${esc(d.meta)}</em></span>
          <b>${esc(d.title)}</b>
          <span>${esc(d.desc)}</span>
        </span>
      </a>`).join("")}</div>
    </div>
  </div>`;
}

function crumbHTML(d) {
  const pills = DOCS.map((item) => `<button type="button" class="dc-switch-btn" data-doc-pick="${item.id}" aria-pressed="${item.id === d.id}">${esc(item.title)}</button>`).join("");
  return `<nav class="dc-crumb" aria-label="文档导航">
    <button type="button" class="dc-back" data-back>${BACK}全部文档</button>
    <div class="dc-switch" role="group" aria-label="切换文档">${pills}</div>
  </nav>`;
}

function wireSeverityDoc(host) {
  const shell = $("#p4Top", host);
  if (!shell) return;
  shell.dataset.trans = "on";

  // 译文开关
  const transBtn = $("#transToggle", shell);
  transBtn?.addEventListener("click", () => {
    const on = shell.dataset.trans !== "on";
    shell.dataset.trans = on ? "on" : "off";
    transBtn.setAttribute("aria-pressed", String(on));
    transBtn.textContent = on ? "显示译文" : "隐藏译文";
  });

  // 筛选、搜索、只看人话
  const cases = $$(".case", shell);
  const railLinks = $$(".rail-sub a", shell);
  const searchIn = $("#caseSearch", shell);
  const clearBtn = $("#caseSearchClear", shell);
  const briefIn = $("#briefToggle", shell);
  const countEl = $("#caseCount", shell);
  const emptyEl = $("#caseEmpty", shell);
  let source = "all";
  let query = "";

  const rows = cases.map((item) => ({
    item,
    source: item.getAttribute("data-source"),
    text: [item.id, $(".judgment-label", item)?.textContent, $(".plain", item)?.textContent, $(".qa", item)?.textContent].join(" ").toLowerCase(),
  }));

  const filterCases = () => {
    const shown = {};
    let count = 0;
    rows.forEach((row) => {
      const visible = (source === "all" || row.source === source) && (!query || row.text.includes(query));
      row.item.hidden = !visible;
      shown[row.item.id] = visible;
      if (visible) count++;
    });
    railLinks.forEach((link) => {
      const id = (link.getAttribute("href") || "").slice(1);
      link.classList.toggle("is-muted", !shown[id]);
    });
    if (countEl) countEl.textContent = count === cases.length ? `${count} 例` : `${count} / ${cases.length} 例`;
    if (clearBtn) clearBtn.hidden = !query;
    if (emptyEl) emptyEl.hidden = count > 0;
  };

  const segEl = $("#sourceSeg", shell);
  if (segEl) {
    const seg = segmented(segEl, (v) => {
      source = v;
      filterCases();
    });
    requestAnimationFrame(() => seg.set("all", { silent: true }));
  }

  searchIn?.addEventListener("input", () => {
    query = (searchIn.value || "").trim().toLowerCase();
    filterCases();
  });
  clearBtn?.addEventListener("click", () => {
    if (!searchIn) return;
    searchIn.value = "";
    query = "";
    filterCases();
    searchIn.focus();
  });
  briefIn?.addEventListener("change", () => {
    shell.dataset.view = briefIn.checked ? "brief" : "full";
  });

  // 复制引用
  shell.addEventListener("click", (e) => {
    const copyBtn = e.target.closest(".cite-copy");
    if (copyBtn) {
      const cite = copyBtn.closest(".case-cite");
      if (!cite) return;
      const text = $$(".cite-items > span", cite).map((s) => {
        const em = $("em", s);
        const k = em ? em.textContent.trim() : "file";
        const v = em ? s.textContent.slice(em.textContent.length).trim() : s.textContent.trim();
        return `${k}: ${v}`;
      }).join("\n");
      navigator.clipboard?.writeText(text).catch(() => {});
      clearTimeout(copyBtn._t);
      copyBtn.textContent = "已复制";
      copyBtn.classList.add("is-done");
      copyBtn._t = setTimeout(() => {
        copyBtn.textContent = "复制";
        copyBtn.classList.remove("is-done");
      }, 1400);
      return;
    }

    // 目录跳转（不污染路由）
    const link = e.target.closest('.rail a[href^="#"]');
    if (link) {
      e.preventDefault();
      const id = link.getAttribute("href").slice(1);
      const target = document.getElementById(id);
      if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  });

  // 左侧目录折叠与滚动高亮
  const groups = $$(".rail-group", shell);
  const toggleGroup = (group, open) => {
    const row = $(".rail-row", group);
    const sub = $(".rail-sub", group);
    if (!row || !sub) return;
    sub.hidden = !open;
    group.classList.toggle("is-open", open);
    row.setAttribute("aria-expanded", String(open));
  };
  groups.forEach((group) => {
    $(".rail-row", group)?.addEventListener("click", () => {
      const open = $(".rail-sub", group).hidden;
      groups.forEach((other) => { if (other !== group) toggleGroup(other, false); });
      toggleGroup(group, open);
    });
  });
  if (groups[0]) toggleGroup(groups[0], true);
}

export async function render(root, c) {
  const id = new URLSearchParams(location.search).get("doc");
  const doc = DOCS.find((d) => d.id === id);
  const key = doc ? doc.id : "index";
  if (root._dcKey === key && root.firstChild) return;
  root._dcKey = key;
  root._flood?.destroy();
  root._flood = null;
  root._nav = c.navigate;

  if (!root._dcWired) {
    root._dcWired = true;
    root.addEventListener("click", (e) => {
      if (e.target.closest("[data-back]")) {
        root._nav?.({ view: "docs", doc: null });
        return;
      }
      const pick = e.target.closest("[data-doc-pick]");
      if (pick) {
        root._nav?.({ view: "docs", doc: pick.dataset.docPick });
      }
    });
  }

  if (!doc) {
    root.innerHTML = indexHTML();
    const stage = $("#dcStage", root);
    const cards = [...stage.querySelectorAll("[data-flood]")];
    root._flood = floodCards(stage, cards, {
      palettes: DOCS.map((d) => d.palette),
      radius: 20,
      onOpen: (i) => c.navigate?.({ view: "docs", doc: DOCS[i].id }),
    });
    return;
  }

  if (doc.id === "capacity") {
    root.innerHTML = `<div class="dc dc-doc">${crumbHTML(doc)}${capacityDocHTML()}</div>`;
    wireCapacityDoc(root);
    return;
  }

  if (doc.id === "api") {
    root.innerHTML = `<div class="dc dc-doc">${crumbHTML(doc)}${apiDocHTML()}</div>`;
    wireApiDoc(root);
    return;
  }

  // doc.id === "severity"
  root.innerHTML = `<div class="dc dc-doc">${crumbHTML(doc)}<div id="dcSeverityBody"><div class="card" style="padding:var(--sp-6)"><div class="empty">正在加载 P0–P4 口径与 75 个案例…</div></div></div></div>`;
  try {
    if (!severityCache) {
      const res = await fetch("docs/severity.html");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      severityCache = await res.text();
    }
    if (root._dcKey !== "severity") return;
    const body = $("#dcSeverityBody", root);
    if (body) {
      body.innerHTML = severityCache;
      wireSeverityDoc(body);
    }
  } catch (err) {
    const body = $("#dcSeverityBody", root);
    if (body) body.innerHTML = `<div class="card"><div class="empty">文档加载失败：${esc(String(err.message || err))}</div></div>`;
  }
}
