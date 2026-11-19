/* 文档: three reference documents under ?view=docs (&doc=severity | capacity | api).
   Index shows three quiet editorial cards; opening a card renders a progressive chaptered doc. */
import { $, $$, esc, segmented, copyText, copyBtnHTML, flashCopy, wireCopy } from "./core.js";
import { capacityDocHTML, wireCapacityDoc, capacityCopyResolvers } from "./doc_capacity.js";
import { apiDocHTML, wireApiDoc, apiCopyResolvers } from "./doc_api.js";

const ICON_ARROW = '<svg class="dc-arrow" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3.5 8h9m-3.5-3.5L12.5 8 9 11.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

const DOCS = [
  {
    id: "severity",
    num: "01",
    title: "P0–P4 定级标准",
    desc: "判级流程、五档边界与 75 个真实对照案例",
    anchor: `<span class="dc-anchor dc-anchor-sev" aria-hidden="true">
      <span class="dc-sev-bar"><i style="--c:var(--sev-0)"></i><i style="--c:var(--sev-1)"></i><i style="--c:var(--sev-2)"></i><i style="--c:var(--sev-3)"></i><i style="--c:var(--sev-4)"></i></span>
      <span class="dc-sev-keys"><b>P0</b><b>P1</b><b>P2</b><b>P3</b><b>P4</b></span>
    </span>`,
  },
  {
    id: "capacity",
    num: "02",
    title: "容量与性能说明",
    desc: "单条消耗拆解、并发配比试算与排查命令",
    anchor: `<span class="dc-anchor dc-anchor-cap" aria-hidden="true">
      <span class="dc-cap-stat"><b class="num">292.8</b><span>行 / 小时</span></span>
      <span class="dc-cap-stat"><b class="num">41.3 万</b><span>token / 条</span></span>
    </span>`,
  },
  {
    id: "api",
    num: "03",
    title: "评测接口指南",
    desc: "5003 供数接口调用与 5002 对话直达",
    anchor: `<span class="dc-anchor dc-anchor-api" aria-hidden="true">
      <span class="dc-api-line"><b class="num">5003</b><code>/api/v1/analysis/*</code></span>
      <span class="dc-api-line"><b class="num">5002</b><code>/?case=…&amp;trace=…</code></span>
    </span>`,
  },
];

let severityCache = null;

function indexHTML() {
  return `<div class="dc">
    <div class="dc-index">
      <header class="dc-index-head">
        <h1>文档</h1>
        <p>定级标准、运行容量与数据接口手册</p>
      </header>
      <div class="dc-grid" role="list">${DOCS.map((d, i) => `<a class="dc-card" role="listitem" href="?view=docs&amp;doc=${d.id}" data-doc="${d.id}" style="--i:${i}">
        <span class="dc-card-top">
          <span class="dc-num num">${esc(d.num)}</span>
          ${ICON_ARROW}
        </span>
        <span class="dc-card-copy">
          <b class="dc-title">${esc(d.title)}</b>
          <span class="dc-desc">${esc(d.desc)}</span>
        </span>
        ${d.anchor}
      </a>`).join("")}</div>
    </div>
  </div>`;
}

export function wireDocToc(shell, navSelector, { handleClick = true } = {}) {
  const nav = $(navSelector, shell);
  if (!nav) return null;
  const links = $$(":scope > a[href^=\"#\"], :scope .rail-row[href^=\"#\"]", nav);
  const targets = links.map((link) => {
    const id = (link.getAttribute("href") || "").slice(1);
    return { link, el: id ? document.getElementById(id) : null };
  }).filter((item) => item.el);

  const mark = (activeEl) => {
    targets.forEach(({ link, el }) => {
      if (el === activeEl) link.setAttribute("aria-current", "location");
      else link.removeAttribute("aria-current");
    });
  };
  if (targets.length) mark(targets[0].el);

  if (handleClick) {
    nav.addEventListener("click", (e) => {
      const link = e.target.closest('a[href^="#"]');
      if (!link) return;
      const id = (link.getAttribute("href") || "").slice(1);
      const target = id ? document.getElementById(id) : null;
      if (!target) return;
      e.preventDefault();
      mark(target);
      target.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  if (typeof IntersectionObserver === "undefined" || !targets.length) return null;
  const visible = new Set();
  const obs = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) visible.add(entry.target);
      else visible.delete(entry.target);
    });
    const top = targets.find((t) => visible.has(t.el));
    if (top) mark(top.el);
  }, { rootMargin: "-72px 0px -65% 0px", threshold: 0 });
  targets.forEach((t) => obs.observe(t.el));
  return obs;
}

function severityCopyResolvers(host) {
  return {
    sevOverview() {
      const rows = $$("#overview tbody tr", host).map((tr) => {
        const tds = $$("td", tr);
        return `${tds[0]?.textContent.trim()}: ${tds[1]?.textContent.trim()} (${tds[2]?.textContent.trim()} 例)`;
      });
      return rows.join("\n");
    },
    sevLevel(btn) {
      const sec = btn.closest(".level");
      if (!sec) return "";
      const code = $(".level-num", sec)?.textContent.trim() || "";
      const title = $(".level-head h3, .level-head h2", sec)?.textContent.trim() || "";
      const def = $(".level-def", sec)?.textContent.trim() || "";
      const cols = $$(".criteria > div", sec).map((box) => {
        const h = $("h4, h3", box)?.textContent.trim() || "";
        const items = $$("li", box).map((li) => `- ${li.textContent.trim()}`).join("\n");
        return `${h}:\n${items}`;
      });
      return [`${code} ${title}`, def, ...cols].filter(Boolean).join("\n\n");
    },
    sevCase(btn) {
      const art = btn.closest(".case");
      if (!art) return "";
      const id = $(".case-id", art)?.textContent.trim() || "";
      const src = $(".case-source", art)?.textContent.trim() || "";
      const tag = $(".judgment-label .tag", art)?.textContent.trim() || "";
      const title = $(".judgment-label > span:nth-child(2)", art)?.textContent.trim() || "";
      const plain = $$(".plain > div", art).map((r) => `${$("dt", r)?.textContent.trim()}: ${$("dd", r)?.textContent.trim()}`).join("\n");
      const why = $(".case-why", art)?.textContent.trim() || "";
      const cite = $$(".cite-items > span", art).map((s) => s.textContent.trim()).join(" | ");
      return [`${id} [${tag} · ${src}] ${title}`, plain, `定级依据: ${why}`, cite].filter(Boolean).join("\n");
    },
  };
}

function wireSeverityDoc(host) {
  const shell = $("#p4Top", host);
  if (!shell) return null;
  shell.dataset.trans = "on";

  // 注入复制按钮：五档速查、各档判据、每个案例与证据示例
  const ovHead = $("#overview .doc-sec-head, #overview .card-head", shell);
  if (ovHead && !$("[data-copy-fn='sevOverview']", ovHead)) {
    ovHead.insertAdjacentHTML("beforeend", copyBtnHTML("复制五档速查", { fn: "sevOverview" }));
  }
  $$(".level", shell).forEach((sec) => {
    const head = $(".level-head", sec);
    if (head && !$("[data-copy-fn='sevLevel']", head)) {
      head.insertAdjacentHTML("beforeend", copyBtnHTML("复制判据", { fn: "sevLevel" }));
    }
  });
  $$(".case", shell).forEach((art) => {
    const jl = $(".judgment-label", art);
    if (jl && !$("[data-copy-fn='sevCase']", jl)) {
      jl.insertAdjacentHTML("beforeend", copyBtnHTML("复制案例", { fn: "sevCase" }));
    }
  });
  const evHead = $("#evSampleBox .dc-codehead", shell);
  if (evHead && !$("[data-copy-pre]", evHead)) {
    evHead.insertAdjacentHTML("beforeend", copyBtnHTML("复制示例", { pre: true }));
  }

  // 译文开关
  const transIn = $("#transToggle", shell);
  const syncTrans = () => {
    const on = Boolean(transIn?.checked);
    shell.dataset.trans = on ? "on" : "off";
  };
  transIn?.addEventListener("change", syncTrans);
  syncTrans();

  // 筛选、搜索、只看人话
  const levels = $$(".level", shell);
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
    levels.forEach((sec) => {
      const hasVisible = $$(".case", sec).some((c) => !c.hidden);
      sec.hidden = !hasVisible;
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

  // 左侧目录折叠
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

  const jumpTo = (selector, expandGroup = true) => {
    const target = document.getElementById(selector.replace(/^#/, ""));
    if (!target) return;
    if (expandGroup) {
      const grp = groups.find((g) => g.dataset.level === target.id);
      if (grp) groups.forEach((other) => toggleGroup(other, other === grp));
    }
    target.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  // 复制定位 & 跳转（flowchart / overview / 左侧目录）
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
      copyText(text).then((ok) => flashCopy(copyBtn, ok));
      return;
    }

    const jumpEl = e.target.closest("[data-jump]");
    if (jumpEl) {
      jumpTo(jumpEl.dataset.jump, true);
      return;
    }

    const link = e.target.closest('.rail a[href^="#"]');
    if (link) {
      e.preventDefault();
      jumpTo(link.getAttribute("href"), !link.classList.contains("rail-row"));
    }
  });

  return wireDocToc(shell, ".rail-nav", { handleClick: false });
}

export async function render(root, c) {
  const id = new URLSearchParams(location.search).get("doc");
  const doc = DOCS.find((d) => d.id === id);
  const key = doc ? doc.id : "index";
  if (root._dcKey === key && root.firstChild) return;
  root._dcKey = key;
  root._tocObs?.disconnect();
  root._tocObs = null;
  root._nav = c.navigate;

  if (!root._dcWired) {
    root._dcWired = true;
    root.addEventListener("click", (e) => {
      if (e.target.closest("[data-back]")) {
        root._nav?.({ view: "docs", doc: null });
        return;
      }
      const card = e.target.closest(".dc-card[data-doc]");
      if (card && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey && e.button === 0) {
        e.preventDefault();
        root._nav?.({ view: "docs", doc: card.dataset.doc });
      }
    });
  }

  if (!doc) {
    root.innerHTML = indexHTML();
    return;
  }

  if (doc.id === "capacity") {
    root.innerHTML = `<div class="dc dc-doc">${capacityDocHTML()}</div>`;
    wireCapacityDoc(root);
    wireCopy(root, capacityCopyResolvers(root));
    root._tocObs = wireDocToc(root, ".doc-toc");
    return;
  }

  if (doc.id === "api") {
    root.innerHTML = `<div class="dc dc-doc">${apiDocHTML()}</div>`;
    wireApiDoc(root);
    wireCopy(root, apiCopyResolvers(root));
    root._tocObs = wireDocToc(root, ".doc-toc");
    return;
  }

  // doc.id === "severity"
  root.innerHTML = `<div class="dc dc-doc"><div id="dcSeverityBody"><div class="doc-loading"><div class="empty">正在加载 P0–P4 定级标准与 75 个案例…</div></div></div></div>`;
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
      root._tocObs = wireSeverityDoc(body);
      wireCopy(root, severityCopyResolvers(body));
    }
  } catch (err) {
    const body = $("#dcSeverityBody", root);
    if (body) body.innerHTML = `<div class="doc-loading"><div class="empty">文档加载失败：${esc(String(err.message || err))}</div></div>`;
  }
}
