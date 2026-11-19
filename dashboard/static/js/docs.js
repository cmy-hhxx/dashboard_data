/* 文档: three reference documents under ?view=docs (&doc=severity | capacity | api).
   Index shows three equal liquid-flood cards; opening a card renders a progressive chaptered doc. */
import { $, $$, esc, segmented, copyText, copyBtnHTML, flashCopy, wireCopy } from "./core.js";
import { floodCards } from "./shader_flood.js";
import { capacityDocHTML, wireCapacityDoc, capacityCopyResolvers } from "./doc_capacity.js";
import { apiDocHTML, wireApiDoc, apiCopyResolvers } from "./doc_api.js";

const ICON_ARROW = '<svg class="dc-arrow" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3.5 8h9m-3.5-3.5L12.5 8 9 11.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

const DOCS = [
  {
    id: "severity",
    num: "01",
    short: "定级标准",
    title: "P0–P4 定级标准",
    desc: "五档判级边界与 75 个真实案例",
    palette: ["#3a0a0c", "#d2452f", "#ffd6c6"],
    visual: `<span class="dc-visual dc-sev-scale" aria-hidden="true">
      <span class="dc-sev-col"><i style="--c:var(--sev-0)"></i><b>P0</b></span>
      <span class="dc-sev-col"><i style="--c:var(--sev-1)"></i><b>P1</b></span>
      <span class="dc-sev-col"><i style="--c:var(--sev-2)"></i><b>P2</b></span>
      <span class="dc-sev-col"><i style="--c:var(--sev-3)"></i><b>P3</b></span>
      <span class="dc-sev-col"><i style="--c:var(--sev-4)"></i><b>P4</b></span>
    </span>`,
  },
  {
    id: "capacity",
    num: "02",
    short: "容量性能",
    title: "容量与性能",
    desc: "单条消耗拆解与并发配比试算",
    palette: ["#0b2358", "#3a63f0", "#d4e0ff"],
    visual: `<span class="dc-visual dc-cap-preview" aria-hidden="true">
      <span class="dc-cap-kpi"><b class="num">292.8</b><em>行 / 小时</em></span>
      <span class="dc-cap-pair">
        <span><em>单条</em><b class="num">41.3 万</b></span>
        <span><em>配比</em><b class="num">64 / 128</b></span>
      </span>
    </span>`,
  },
  {
    id: "api",
    num: "03",
    short: "评测接口",
    title: "评测接口",
    desc: "5003 供数接口与 5002 对话直达",
    palette: ["#092e2a", "#1d7d72", "#c8f2ec"],
    visual: `<span class="dc-visual dc-api-preview" aria-hidden="true">
      <span class="dc-api-step"><em>5003</em><code>/api/v1/analysis/*</code></span>
      <span class="dc-api-step"><em>5002</em><code>/?case=…&amp;trace=…</code></span>
    </span>`,
  },
];

let severityCache = null;

function indexHTML() {
  return `<div class="dc">
    <div class="dc-stage" id="dcStage">
      <div class="dc-grid" role="list">${DOCS.map((d, i) => `<a class="dc-card" role="listitem" href="?view=docs&amp;doc=${d.id}" data-flood data-doc="${d.id}" style="--dc-accent:${d.palette[1]};--i:${i}">
        <span class="dc-body">
          <span class="dc-top"><span class="dc-num num">${esc(d.num)}</span>${ICON_ARROW}</span>
          <span class="dc-card-head">
            <b class="dc-title">${esc(d.title)}</b>
            <span class="dc-desc">${esc(d.desc)}</span>
          </span>
          ${d.visual}
        </span>
      </a>`).join("")}</div>
    </div>
  </div>`;
}

function docChromeHTML() {
  return `<div class="dc-progress" role="progressbar" aria-label="文档浏览进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><i class="dc-progress-fill"></i></div>`;
}

function wireDocProgress(root) {
  root._docProgressCleanup?.();
  const bar = $(".dc-progress", root);
  const fill = $(".dc-progress-fill", root);
  if (!bar || !fill) return;

  let raf = 0;
  const update = () => {
    raf = 0;
    const docEl = document.documentElement;
    const max = Math.max(0, docEl.scrollHeight - window.innerHeight);
    const y = Math.max(0, window.scrollY || docEl.scrollTop || 0);
    const ratio = max > 0 ? Math.min(1, y / max) : 1;
    const pct = Math.round(ratio * 100);
    fill.style.transform = `scaleX(${ratio.toFixed(4)})`;
    bar.setAttribute("aria-valuenow", String(pct));
  };
  const onScroll = () => {
    if (!root.isConnected || !bar.isConnected) { root._docProgressCleanup?.(); return; }
    if (!raf) raf = requestAnimationFrame(update);
  };
  const onKey = (e) => {
    if (!root.isConnected || !bar.isConnected) { root._docProgressCleanup?.(); return; }
    if (e.key === "Escape" && !e.defaultPrevented && !e.target?.closest("input, textarea, select")) {
      window.scrollTo({ top: 0, behavior: "instant" });
      root._nav?.({ view: "docs", doc: null });
    }
  };
  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", onScroll, { passive: true });
  window.addEventListener("keydown", onKey);
  update();

  root._docProgressCleanup = () => {
    if (raf) cancelAnimationFrame(raf);
    window.removeEventListener("scroll", onScroll);
    window.removeEventListener("resize", onScroll);
    window.removeEventListener("keydown", onKey);
  };
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
  root._flood?.destroy();
  root._flood = null;
  root._docProgressCleanup?.();
  root._docProgressCleanup = null;
  root._tocObs?.disconnect();
  root._tocObs = null;
  root._nav = c.navigate;

  if (!root._dcWired) {
    root._dcWired = true;
    root.addEventListener("click", (e) => {
      if (e.target.closest("[data-back]")) {
        window.scrollTo({ top: 0, behavior: "instant" });
        root._nav?.({ view: "docs", doc: null });
        return;
      }
      const card = e.target.closest(".dc-card[data-doc]");
      if (card && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey && e.button === 0) {
        e.preventDefault();
        window.scrollTo({ top: 0, behavior: "instant" });
        root._nav?.({ view: "docs", doc: card.dataset.doc });
      }
    });
  }

  if (!doc) {
    root.innerHTML = indexHTML();
    const stage = $("#dcStage", root);
    const cards = [...stage.querySelectorAll("[data-flood]")];
    root._flood = floodCards(stage, cards, {
      palettes: DOCS.map((d) => d.palette),
      radius: 28,
      onOpen: (i) => c.navigate?.({ view: "docs", doc: DOCS[i].id }),
    });
    return;
  }

  if (doc.id === "capacity") {
    root.innerHTML = `<div class="dc dc-doc">${docChromeHTML(doc.id)}${capacityDocHTML()}</div>`;
    wireCapacityDoc(root);
    wireCopy(root, capacityCopyResolvers(root));
    root._tocObs = wireDocToc(root, ".doc-toc");
    wireDocProgress(root);
    return;
  }

  if (doc.id === "api") {
    root.innerHTML = `<div class="dc dc-doc">${docChromeHTML(doc.id)}${apiDocHTML()}</div>`;
    wireApiDoc(root);
    wireCopy(root, apiCopyResolvers(root));
    root._tocObs = wireDocToc(root, ".doc-toc");
    wireDocProgress(root);
    return;
  }

  // doc.id === "severity"
  root.innerHTML = `<div class="dc dc-doc">${docChromeHTML(doc.id)}<div id="dcSeverityBody"><div class="doc-loading"><div class="empty">正在加载 P0–P4 定级标准与 75 个案例…</div></div></div></div>`;
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
      wireDocProgress(root);
    }
  } catch (err) {
    const body = $("#dcSeverityBody", root);
    if (body) body.innerHTML = `<div class="doc-loading"><div class="empty">文档加载失败：${esc(String(err.message || err))}</div></div>`;
    wireDocProgress(root);
  }
}
