/* Sample workbench: recall list, evaluation input trace, compact + attribution output. */
import { esc } from "./core.js";

const S = {
  root: null,
  data: null,
  opts: {},
  product: "aime",
  filter: { q: "", model: "", severity: "", component: "", date: "", sort: "severity" },
  activeId: null,
  activeTurn: 0,
  turnExplicit: false,
  outTab: "attr",
  moreOpen: false,
  mobileDetail: false,
  built: false,
  globalBound: false,
};

const detailCache = new Map();
const detailPending = new Map();

const SORT_LABEL = {
  severity: "按严重度",
  date: "按日期",
  problems: "按问题数",
  question: "按问题",
};
const SEV_ORDER = { P0: 0, P1: 1, P2: 2, P3: 3, P4: 4, 未分级: 5 };
const SEV_CLASS = {
  P0: "sev-0",
  P1: "sev-1",
  P2: "sev-2",
  P3: "sev-3",
  P4: "sev-p4",
  未分级: "sev-none",
};

/* ------------------------------------------------------------------ icons */

const svg = (body, size = 18) =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" aria-hidden="true">${body}</svg>`;

const ICONS = {
  search: svg('<circle cx="10.5" cy="10.5" r="5.7" stroke="currentColor" stroke-width="1.7"/><path d="m15 15 4.2 4.2" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>'),
  system: svg('<path d="M4 7h9M17 7h3M4 12h3M11 12h9M4 17h9M17 17h3" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><circle cx="15" cy="7" r="2" stroke="currentColor" stroke-width="1.7"/><circle cx="9" cy="12" r="2" stroke="currentColor" stroke-width="1.7"/><circle cx="15" cy="17" r="2" stroke="currentColor" stroke-width="1.7"/>'),
  user: svg('<circle cx="12" cy="8" r="3.2" stroke="currentColor" stroke-width="1.7"/><path d="M5.5 19c.7-3 3.2-4.7 6.5-4.7s5.8 1.7 6.5 4.7" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>'),
  reason: svg('<path d="M12 3.6l1.6 4.4 4.4 1.6-4.4 1.6L12 15.6l-1.6-4.4L6 9.6l4.4-1.6L12 3.6Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M18.5 15.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7.7-1.8Z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>'),
  tool: svg('<path d="M14.2 5.2a4.2 4.2 0 0 0-5.4 5.4l-4.6 4.6 1.9 1.9 4.6-4.6a4.2 4.2 0 0 0 5.4-5.4l-2.4 2.4-2-2 2.5-2.3Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>'),
  return: svg('<path d="M9 7 4.5 11.5 9 16" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/><path d="M4.5 11.5H14a5 5 0 0 1 5 5v1" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>'),
  answer: svg('<path d="M5 5.5h14v10H9l-4 3v-13Z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M8.5 9h7M8.5 12h4.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>'),
  copy: svg('<rect x="8" y="8" width="10" height="10" rx="2" stroke="currentColor" stroke-width="1.6"/><path d="M6 15H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v1" stroke="currentColor" stroke-width="1.6"/>', 14),
  chevron: svg('<path d="m7 9.5 5 5 5-5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>', 14),
  warning: svg('<path d="M12 4 21 20H3L12 4Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M12 10v4.2" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><circle cx="12" cy="17" r=".9" fill="currentColor"/>'),
  empty: svg('<circle cx="11" cy="11" r="6.2" stroke="currentColor" stroke-width="1.6"/><path d="m16 16 3.5 3.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>', 24),
  back: svg('<path d="M15 5 8 12l7 7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>', 16),
};

const KIND = {
  system: { label: "System", icon: ICONS.system, cls: "system" },
  user: { label: "User", icon: ICONS.user, cls: "user" },
  reason: { label: "Reason", icon: ICONS.reason, cls: "reason" },
  tool: { label: "Tool", icon: ICONS.tool, cls: "tool" },
  return: { label: "Return", icon: ICONS.return, cls: "return" },
  answer: { label: "Answer", icon: ICONS.answer, cls: "answer" },
};

/* --------------------------------------------------------------- utilities */

const q = (sel, root = S.root) => (root ? root.querySelector(sel) : null);
const qa = (sel, root = S.root) => (root ? Array.from(root.querySelectorAll(sel)) : []);

function samples(product = S.product) {
  const item = S.data && S.data.products && S.data.products[product];
  return (item && item.samples) || [];
}

function productMeta(product = S.product) {
  return (S.data && S.data.products && S.data.products[product]) || {};
}

function modelLabel(model) {
  const raw = String(model || "");
  if (raw === "aime_fast") return "Fast";
  if (raw === "aime_expert") return "Expert";
  if (raw === "a_fast") return "A·fast";
  if (raw === "a_expert") return "A·expert";
  if (raw === "b_fast") return "B·fast";
  if (raw === "b_expert") return "B·expert";
  return raw || "—";
}

function modelFamily(sample) {
  return /expert/i.test(sample.model || "") ? "expert" : "fast";
}

function questionOf(sample) {
  if (!sample) return "（无样本）";
  return sample.question_zh || sample.question || "（无原问）";
}

function sevRank(severity) {
  return SEV_ORDER[severity] == null ? 8 : SEV_ORDER[severity];
}

function sampleSevRank(sample) {
  if (!sample.severities || !sample.severities.length) return 9;
  return Math.min(...sample.severities.map(sevRank));
}

function sevClass(severity) {
  return SEV_CLASS[severity] || "sev-none";
}

function bestSeverity(sample) {
  if (!sample.severities || !sample.severities.length) return "未分级";
  return [...sample.severities].sort((a, b) => sevRank(a) - sevRank(b))[0];
}

function bestTurn(sample) {
  if (!sample || !sample.turns || !sample.turns.length) return 0;
  let best = 0;
  let bestKey = null;
  sample.turns.forEach((turn, index) => {
    const problems = turn.problems || [];
    const rank = problems.length ? Math.min(...problems.map((p) => sevRank(p.severity))) : 9;
    const key = [rank, -problems.length];
    if (bestKey === null || key[0] < bestKey[0] || (key[0] === bestKey[0] && key[1] < bestKey[1])) {
      best = index;
      bestKey = key;
    }
  });
  return best;
}

function activeTurnOf(sample) {
  if (!sample || !sample.turns || !sample.turns.length) return null;
  const index = Math.min(Math.max(S.activeTurn, 0), sample.turns.length - 1);
  return sample.turns[index];
}

function activeSample() {
  const list = filtered();
  let sample = list.find((item) => item.id === S.activeId);
  if (!sample) sample = samples().find((item) => item.id === S.activeId);
  return sample || list[0] || null;
}

function filtered() {
  const filter = S.filter;
  const tokens = String(filter.q || "").trim().toLowerCase().split(/\s+/).filter(Boolean);
  const list = samples().filter((sample) => {
    if (filter.model && modelFamily(sample) !== filter.model) return false;
    if (filter.severity && !(sample.severities || []).includes(filter.severity)) return false;
    if (filter.component && !(sample.components || []).includes(filter.component)) return false;
    if (filter.date && sample.date !== filter.date) return false;
    if (tokens.length) {
      const hay = [
        sample.session_id,
        sample.trace_id,
        sample.question,
        sample.question_zh,
        ...(sample.trace_ids || []),
        ...(sample.questions || []),
        ...(sample.turns || []).map((turn) => `${turn.trace_id} ${turn.question} ${turn.question_zh}`),
        ...(sample.labels || []),
        ...(sample.components || []),
        ...(sample.turns || []).flatMap((turn) => (turn.problems || []).map((p) => p.label)),
      ]
        .join(" ")
        .toLowerCase();
      if (!tokens.every((token) => hay.includes(token))) return false;
    }
    return true;
  });
  return sortSamples(list);
}

function sortSamples(list) {
  const arr = [...list];
  if (S.filter.sort === "date") {
    arr.sort((a, b) => String(b.date).localeCompare(String(a.date)) || sampleSevRank(a) - sampleSevRank(b));
  } else if (S.filter.sort === "problems") {
    arr.sort((a, b) => (b.problem_count || 0) - (a.problem_count || 0) || sampleSevRank(a) - sampleSevRank(b));
  } else if (S.filter.sort === "question") {
    arr.sort((a, b) => questionOf(a).localeCompare(questionOf(b), "zh"));
  } else {
    arr.sort((a, b) => sampleSevRank(a) - sampleSevRank(b) || String(b.date).localeCompare(String(a.date)));
  }
  return arr;
}

function fmtNum(value) {
  return value == null || Number.isNaN(Number(value)) ? "—" : Number(value).toLocaleString("en-US");
}

function fmtSeconds(ms) {
  if (!ms) return "—";
  return `${(Number(ms) / 1000).toFixed(1)}s`;
}

function clipText(text, limit) {
  const value = String(text || "");
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}

function shortPosition(position) {
  const text = String(position || "");
  const match = text.match(/message_index\s+(\d+)/);
  if (match) return `消息 ${match[1]}`;
  return clipText(text, 44);
}

/* ---------------------------------------------------------------- markdown */

function md(text) {
  if (text == null) return "";
  let value = String(text);
  value = value.replace(/data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=\s]+/gi, "[图片已省略]");
  value = value.replace(/!\[[^\]]*\]\([^)]*\)/g, "[图片]");
  value = esc(value);
  const blocks = [];
  value = value.replace(/```([\s\S]*?)```/g, (_, code) => {
    blocks.push(code.replace(/^\n+|\n+$/g, ""));
    return `\u0000B${blocks.length - 1}\u0000`;
  });
  value = value.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  value = value.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  value = value.replace(
    /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
  );
  value = value.replace(/\n/g, "<br>");
  value = value.replace(/\u0000B(\d+)\u0000/g, (_, index) => `<pre class="ev-code">${blocks[Number(index)]}</pre>`);
  return value;
}

function clampHtml(html, className = "", label = "展开全文") {
  return (
    `<div class="ev-clamp ${className}">` +
    `<div class="ev-clamp-body">${html}</div>` +
    `<button class="ev-clamp-toggle" type="button" data-clamp data-label="${esc(label)}">${esc(label)}</button>` +
    `</div>`
  );
}

function truncNote(original, shown) {
  const total = Number(original || 0);
  const visible = Number(shown || 0);
  if (!total || total <= visible) return "";
  return `<p class="ev-trunc">已截取，显示 ${fmtNum(visible)} / ${fmtNum(total)} 字</p>`;
}

/* ------------------------------------------------------------------- shell */

function buildShell() {
  S.root.innerHTML = `
    <div class="smp-shell" data-product="${esc(S.product)}">
      <aside class="smp-recall" aria-label="召回样本">
        <div class="smp-recall-head">
          <div class="smp-recall-title">召回 <em>样本</em></div>
          <button class="smp-reset" type="button" data-clear-all>重置</button>
        </div>
        <label class="smp-search">
          ${ICONS.search}
          <input id="smpSearch" type="search" placeholder="搜索 Trace / Session / 问题" autocomplete="off" spellcheck="false" aria-label="搜索 Trace ID、Session ID 或问题关键词">
          <kbd>/</kbd>
        </label>
        <div class="smp-filterbar">
          <div class="smp-seg" id="smpModelSeg" role="tablist" aria-label="模型筛选">
            <button type="button" data-model="" class="is-active">全部</button>
            <button type="button" data-model="fast">Fast</button>
            <button type="button" data-model="expert">Expert</button>
          </div>
          <button class="smp-more-btn" type="button" data-toggle-more aria-expanded="false">
            筛选<span id="smpFilterCount"></span>${ICONS.chevron}
          </button>
        </div>
        <div class="smp-more" id="smpMore" hidden>
          <label class="smp-field"><span>严重度</span><select id="smpSeverity"></select></label>
          <label class="smp-field"><span>环节</span><select id="smpComponent"></select></label>
          <label class="smp-field"><span>日期</span><select id="smpDate"></select></label>
          <label class="smp-field"><span>排序</span><select id="smpSort">
            <option value="severity">按严重度</option>
            <option value="date">按日期</option>
            <option value="problems">按问题数</option>
            <option value="question">按问题</option>
          </select></label>
        </div>
        <div class="smp-active" id="smpActive" hidden></div>
        <div class="smp-list-head">
          <span><b id="smpCount">0</b> 条样本</span>
          <span class="smp-sort-label" id="smpSortLabel">按严重度</span>
          <span class="smp-list-nav">
            <button type="button" data-prev title="上一条" aria-label="上一条">↑</button>
            <button type="button" data-next title="下一条" aria-label="下一条">↓</button>
          </span>
        </div>
        <div class="smp-list" id="smpList" role="listbox" aria-label="召回样本" tabindex="0"></div>
        <div class="smp-recall-foot" id="smpFoot"></div>
      </aside>

      <section class="smp-pane smp-pane--input" aria-label="评测输入">
        <header class="smp-pane-head">
          <div class="smp-pane-title">
            <span class="smp-kicker">评测输入</span>
            <h2 id="smpInputTitle">对话轨迹</h2>
          </div>
          <div class="smp-pane-actions" id="smpInputActions"></div>
        </header>
        <div class="smp-pane-body" id="smpInputBody"></div>
      </section>

      <section class="smp-pane smp-pane--output" aria-label="评测输出">
        <header class="smp-pane-head">
          <div class="smp-pane-title">
            <span class="smp-kicker">评测输出</span>
            <h2 id="smpOutputTitle">归因结果</h2>
          </div>
          <div class="smp-tabs" id="smpOutTabs" role="tablist" aria-label="评测输出视图">
            <button type="button" data-tab="attr" class="is-active">归因</button>
            <button type="button" data-tab="compact">紧凑轨迹</button>
          </div>
        </header>
        <div class="smp-pane-body" id="smpOutputBody"></div>
      </section>
    </div>`;
  S.built = true;
  bindEvents();
}

function bindEvents() {
  const search = q("#smpSearch");
  if (search) {
    let timer = 0;
    search.addEventListener("input", () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        S.filter.q = search.value;
        afterFilterChange();
      }, 140);
    });
    search.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        search.value = "";
        S.filter.q = "";
        afterFilterChange();
        search.blur();
      }
    });
  }
  const sort = q("#smpSort");
  if (sort) {
    sort.addEventListener("change", () => {
      S.filter.sort = sort.value;
      afterFilterChange();
    });
  }
  ["smpSeverity", "smpComponent", "smpDate"].forEach((id) => {
    const select = q(`#${id}`);
    if (select) {
      select.addEventListener("change", () => {
        const key = id === "smpSeverity" ? "severity" : id === "smpComponent" ? "component" : "date";
        S.filter[key] = select.value;
        afterFilterChange();
      });
    }
  });

  S.root.addEventListener("click", (event) => {
    const target = event.target;

    if (target.closest("[data-clear-all]")) {
      clearFilters();
      return;
    }
    if (target.closest("[data-toggle-more]")) {
      S.moreOpen = !S.moreOpen;
      const panel = q("#smpMore");
      const button = q("[data-toggle-more]");
      if (panel) panel.hidden = !S.moreOpen;
      if (button) button.setAttribute("aria-expanded", String(S.moreOpen));
      return;
    }
    const modelButton = target.closest("[data-model]");
    if (modelButton) {
      S.filter.model = modelButton.dataset.model || "";
      afterFilterChange();
      return;
    }
    const clearChip = target.closest("[data-clear-filter]");
    if (clearChip) {
      const key = clearChip.dataset.clearFilter;
      if (key in S.filter) S.filter[key] = "";
      afterFilterChange();
      return;
    }
    const turnButton = target.closest("[data-turn]");
    if (turnButton) {
      setActiveTurn(Number(turnButton.dataset.turn));
      return;
    }
    const tab = target.closest("[data-tab]");
    if (tab) {
      S.outTab = tab.dataset.tab === "compact" ? "compact" : "attr";
      renderOutput(activeSample());
      syncRoute();
      return;
    }
    const copy = target.closest("[data-copy-kind]");
    if (copy) {
      copyActive(copy.dataset.copyKind, copy);
      return;
    }
    const item = target.closest(".smp-item");
    if (item) {
      selectSample(item.dataset.id);
      return;
    }
    if (target.closest("[data-prev]")) {
      stepSample(-1);
      return;
    }
    if (target.closest("[data-next]")) {
      stepSample(1);
      return;
    }
    if (target.closest("[data-back-list]")) {
      S.mobileDetail = false;
      const shell = q(".smp-shell");
      if (shell) shell.classList.remove("is-detail-open");
      return;
    }
    if (target.closest("[data-retry-detail]")) {
      renderDetail();
      return;
    }
    const clamp = target.closest("[data-clamp]");
    if (clamp) {
      const wrap = clamp.closest(".ev-clamp");
      if (wrap) {
        const open = wrap.classList.toggle("is-open");
        clamp.textContent = open ? "收起" : (clamp.dataset.label || "展开全文");
      }
    }
  });

  S.root.addEventListener("toggle", (event) => {
    const group = event.target.closest && event.target.closest("[data-turn-group]");
    if (!group || !group.open) return;
    S.activeTurn = Number(group.dataset.turnGroup);
    S.turnExplicit = true;
    renderInput(activeSample());
    syncRoute();
  }, true);

  S.root.addEventListener("keydown", (event) => {
    const list = q("#smpList");
    if (list && list.contains(document.activeElement)) {
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Enter") return;
      const items = qa(".smp-item", list);
      if (!items.length) return;
      const current = items.findIndex((item) => item.classList.contains("is-active"));
      if (event.key === "Enter") {
        if (items[current]) selectSample(items[current].dataset.id);
        return;
      }
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      const next = Math.min(items.length - 1, Math.max(0, current + delta));
      items[next].focus();
      items[next].scrollIntoView({ block: "nearest" });
    }
  });

  if (!S.globalBound) {
    S.globalBound = true;
    window.addEventListener("keydown", (event) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      const tag = (document.activeElement && document.activeElement.tagName) || "";
      if (["INPUT", "TEXTAREA", "SELECT"].includes(tag)) return;
      const input = q("#smpSearch");
      if (input) {
        event.preventDefault();
        input.focus();
        input.select();
      }
    });
  }
}
/* -------------------------------------------------------------------- list */

function renderFilterOptions() {
  const facets = productMeta().facets || {};
  const severity = q("#smpSeverity");
  if (severity) {
    const entries = Object.entries(facets.severities || {});
    severity.innerHTML =
      `<option value="">全部严重度</option>` +
      entries.map(([name, count]) => `<option value="${esc(name)}">${esc(name)} · ${count}</option>`).join("");
  }
  const component = q("#smpComponent");
  if (component) {
    const entries = Object.entries(facets.components || {});
    component.innerHTML =
      `<option value="">全部环节</option>` +
      entries.map(([name, count]) => `<option value="${esc(name)}">${esc(name)} · ${count}</option>`).join("");
  }
  const date = q("#smpDate");
  if (date) {
    const entries = Object.entries(facets.dates || {});
    date.innerHTML =
      `<option value="">全部日期</option>` +
      entries.map(([name, count]) => `<option value="${esc(name)}">${esc(name)} · ${count}</option>`).join("");
  }
}

function renderFilterState() {
  qa("[data-model]").forEach((button) => {
    button.classList.toggle("is-active", (button.dataset.model || "") === S.filter.model);
  });
  const severity = q("#smpSeverity");
  if (severity) severity.value = S.filter.severity;
  const component = q("#smpComponent");
  if (component) component.value = S.filter.component;
  const date = q("#smpDate");
  if (date) date.value = S.filter.date;
  const sort = q("#smpSort");
  if (sort) sort.value = S.filter.sort;
  const sortLabel = q("#smpSortLabel");
  if (sortLabel) sortLabel.textContent = SORT_LABEL[S.filter.sort] || "按严重度";

  const active = [];
  if (S.filter.q) active.push(["q", `搜索：${S.filter.q}`]);
  if (S.filter.model) active.push(["model", `模型：${S.filter.model === "fast" ? "Fast" : "Expert"}`]);
  if (S.filter.severity) active.push(["severity", `严重度：${S.filter.severity}`]);
  if (S.filter.component) active.push(["component", `环节：${S.filter.component}`]);
  if (S.filter.date) active.push(["date", `日期：${S.filter.date}`]);

  const wrap = q("#smpActive");
  if (wrap) {
    wrap.hidden = !active.length;
    wrap.innerHTML = active
      .map(
        ([key, label]) =>
          `<button type="button" class="smp-chip" data-clear-filter="${key}" title="清除${esc(label)}">${esc(label)}<span>×</span></button>`
      )
      .join("");
  }
  const count = q("#smpFilterCount");
  if (count) {
    const n = active.filter(([key]) => key !== "q").length;
    count.textContent = n ? String(n) : "";
    count.hidden = !n;
  }
}

function renderList() {
  const listEl = q("#smpList");
  const countEl = q("#smpCount");
  if (!listEl) return;
  const list = filtered();
  if (countEl) countEl.textContent = String(list.length);
  if (!list.length) {
    listEl.innerHTML = `<div class="smp-list-empty">${ICONS.empty}<p>没有匹配的样本</p><button type="button" data-clear-all>清除筛选</button></div>`;
    return;
  }
  const active = activeSample();
  listEl.innerHTML = list
    .map((sample) => {
      const severity = bestSeverity(sample);
      const on = active && sample.id === active.id;
      const component = (sample.components || [])[0] || "";
      return (
        `<button class="smp-item${on ? " is-active" : ""}" type="button" role="option" aria-selected="${on}" data-id="${sample.id}">` +
        `<span class="smp-item-top">` +
        `<span class="smp-item-sev ${sevClass(severity)}">${sample.problem_count ? esc(severity) : "OK"}</span>` +
        `<span class="smp-item-model">${esc(modelLabel(sample.model))} · ${esc(sample.date)}</span>` +
        (sample.turn_count > 1 ? `<span class="smp-item-turns">${sample.turn_count} 轮</span>` : "") +
        `</span>` +
        `<span class="smp-item-q">${esc(questionOf(sample))}</span>` +
        `<span class="smp-item-foot">` +
        `<span>${sample.problem_count ? `${sample.problem_count} 个问题` : "无归因问题"}</span>` +
        (component ? `<span class="smp-item-comp">${esc(component)}</span>` : "") +
        `</span>` +
        `</button>`
      );
    })
    .join("");
  const activeEl = listEl.querySelector(".smp-item.is-active");
  if (activeEl) activeEl.scrollIntoView({ block: "nearest" });
}

function renderFoot() {
  const foot = q("#smpFoot");
  if (!foot) return;
  const generated = String((S.data && S.data.generated_at) || "").slice(5, 16).replace("T", " ");
  foot.innerHTML = `<span>Compact + Attribution</span><span>${esc(generated || "—")}</span>`;
}

function clearFilters() {
  S.filter = { q: "", model: "", severity: "", component: "", date: "", sort: S.filter.sort || "severity" };
  const search = q("#smpSearch");
  if (search) search.value = "";
  afterFilterChange();
}

function afterFilterChange() {
  const list = filtered();
  if (!list.some((sample) => sample.id === S.activeId)) {
    S.activeId = list.length ? list[0].id : null;
    S.turnExplicit = false;
    S.activeTurn = bestTurn(activeSample());
  }
  renderFilterState();
  renderList();
  renderDetail();
  syncRoute();
}

function selectSample(id) {
  const sample = samples().find((item) => item.id === id);
  if (!sample) return;
  S.activeId = id;
  S.turnExplicit = false;
  S.activeTurn = sample.turns ? bestTurn(sample) : 0;
  S.mobileDetail = true;
  renderList();
  renderDetail();
  syncRoute();
  const shell = q(".smp-shell");
  if (shell) shell.classList.add("is-detail-open");
  const body = q("#smpInputBody");
  if (body) body.scrollTop = 0;
}

function stepSample(delta) {
  const list = filtered();
  if (!list.length) return;
  const current = list.findIndex((sample) => sample.id === S.activeId);
  const next = list[Math.min(list.length - 1, Math.max(0, (current < 0 ? 0 : current) + delta))];
  if (next) selectSample(next.id);
}

function setActiveTurn(index) {
  const sample = activeSample();
  if (!sample || !sample.turns || !sample.turns[index]) return;
  S.activeTurn = index;
  S.turnExplicit = true;
  renderInput(sample);
  renderOutput(sample);
  syncRoute();
  const body = q("#smpInputBody");
  if (body) body.scrollTop = 0;
}

/* ------------------------------------------------------------------ input */

function metaChips(sample, turn) {
  const chips = [];
  chips.push(`<span class="smp-meta-chip"><em>模型</em>${esc(modelLabel(sample.model))}</span>`);
  chips.push(`<span class="smp-meta-chip"><em>日期</em>${esc(sample.date)}</span>`);
  if (turn && turn.task) {
    chips.push(`<span class="smp-meta-chip"><em>任务</em>${esc(turn.task)}${turn.subtask ? ` / ${esc(turn.subtask)}` : ""}</span>`);
  }
  if (turn && turn.difficulty) {
    chips.push(`<span class="smp-meta-chip"><em>难度</em>${esc(turn.difficulty)}</span>`);
  }
  const stats = (turn && turn.input && turn.input.stats) || {};
  const tokens = stats.total_tokens || (turn && turn.tokens) || sample.tokens;
  const duration = stats.duration_ms || (turn && turn.duration_ms) || sample.duration_ms;
  if (tokens || duration) {
    const usage = [tokens ? `${fmtNum(tokens)} tokens` : "", duration ? fmtSeconds(duration) : ""]
      .filter(Boolean)
      .join(" · ");
    chips.push(`<span class="smp-meta-chip"><em>用量</em>${usage}</span>`);
  }
  return chips.join("");
}

function renderTurnTabs(sample) {
  if (!sample.turns || sample.turns.length <= 1) return "";
  return (
    `<div class="smp-turn-tabs" role="tablist" aria-label="会话轮次">` +
    sample.turns
      .map((turn, index) => {
        const on = index === S.activeTurn;
        return (
          `<button type="button" class="smp-turn-tab${on ? " is-active" : ""}" role="tab" aria-selected="${on}" data-turn="${index}">` +
          `第 ${index + 1} 轮` +
          `<em class="${turn.problem_count ? "" : "is-clean"}">${turn.problem_count || "OK"}</em>` +
          `</button>`
        );
      })
      .join("") +
    `</div>`
  );
}

function renderEvent(event, question) {
  const meta = KIND[event.kind] || KIND.reason;
  const head =
    `<div class="ev-head">` +
    `<span class="ev-kind">${meta.label}</span>` +
    (event.name ? `<span class="ev-name">${esc(event.name)}</span>` : "") +
    (event.summary ? `<span class="ev-summary">${esc(event.summary)}</span>` : "") +
    (event.chars ? `<span class="ev-meta">${fmtNum(event.chars)} 字</span>` : "") +
    `</div>`;

  let body = "";
  if (event.kind === "system") {
    const items = (event.items || [])
      .map(
        (item) =>
          `<div class="ev-sys-item"><div class="ev-sys-head"><span>${esc(item.name)}</span><em>${fmtNum(item.chars)} 字</em></div><pre class="ev-code">${esc(item.text)}</pre></div>`
      )
      .join("");
    const original = (event.items || []).reduce((sum, item) => sum + Number(item.chars || 0), 0);
    const shown = (event.items || []).reduce((sum, item) => sum + String(item.text || "").length, 0);
    const note = truncNote(original, shown);
    body = `<details class="ev-fold"><summary>查看系统提示</summary><div class="ev-fold-body">${note}${items}</div></details>`;
  } else if (event.kind === "user") {
    const same = question && String(event.text || "").trim() === String(question).trim();
    if (!same) body = `<div class="ev-text ev-text--user">${md(event.text)}</div>`;
    if (event.raw) {
      body += `<details class="ev-fold"><summary>原始用户输入</summary><div class="ev-fold-body"><pre class="ev-code">${esc(event.raw)}</pre></div></details>`;
    }
  } else if (event.kind === "tool") {
    const note = truncNote(event.chars, (event.text || "").length);
    body =
      `<div class="ev-query">${esc(event.summary || "")}</div>` +
      `<details class="ev-fold"><summary>调用参数</summary><div class="ev-fold-body">${note}<pre class="ev-code">${esc(event.text || "")}</pre></div></details>`;
  } else if (event.kind === "return") {
    const text = event.text || "";
    const preview = text
      ? text.length > 300
        ? clampHtml(md(text), "ev-text ev-clamp--return", "展开")
        : `<div class="ev-text">${md(text)}</div>`
      : "";
    const detail = event.detail
      ? `<details class="ev-fold"><summary>结构化返回</summary><div class="ev-fold-body"><pre class="ev-code">${esc(event.detail)}</pre></div></details>`
      : "";
    body = preview + detail;
  } else if (event.kind === "answer") {
    const text = event.text || "";
    const html = md(text);
    const note = truncNote(event.chars, text.length);
    const label = Number(event.chars || 0) > text.length ? "展开更多" : "展开全文";
    body = (Number(event.chars || 0) > 600 ? clampHtml(html, "ev-text", label) : `<div class="ev-text">${html}</div>`) + note;
  } else {
    const text = event.text || "";
    const html = md(text);
    const note = event.parsed ? "" : truncNote(event.chars, text.length);
    if (text.length > 220) {
      body = `<details class="ev-fold"><summary>${esc(event.summary || "展开思考过程")}</summary><div class="ev-fold-body">${note}<div class="ev-text">${html}</div></div></details>`;
    } else {
      body = `<div class="ev-text">${html}</div>${note}`;
    }
  }

  return (
    `<div class="ev ev--${meta.cls}">` +
    `<span class="ev-icon">${meta.icon}</span>` +
    `<div class="ev-main">${head}${body}</div>` +
    `</div>`
  );
}

const MISSING_REASON = {
  input_file_missing: "输入文件缺失",
  input_file_too_large: "输入文件过大",
  input_id_not_found: "输入文件中未找到该会话",
};

function renderInput(sample) {
  const body = q("#smpInputBody");
  const title = q("#smpInputTitle");
  if (!body) return;
  if (!sample) {
    body.innerHTML = `<div class="smp-empty">${ICONS.empty}<h3>没有可展示的样本</h3><p>当前筛选下没有样本。清除筛选，或换一个产品。</p></div>`;
    if (title) title.textContent = "对话轨迹";
    return;
  }
  const turn = activeTurnOf(sample);
  const question = (turn && turn.question) || sample.question || "（无原问）";
  const zh = (turn && turn.question_zh) || (sample.question_zh !== question ? sample.question_zh : "");
  const events = ((turn && turn.input && turn.input.events) || []).filter(
    (event) =>
      event.kind !== "user" ||
      event.raw ||
      String(event.text || "").trim() !== String(question).trim()
  );
  if (title) title.textContent = sample.turn_count > 1 ? `对话轨迹 · 第 ${S.activeTurn + 1} 轮` : "对话轨迹";

  const reason = sample.quality && sample.quality.input_missing_reason;
  const rawNote =
    !turn || !turn.input
      ? `<div class="smp-inline-note">未找到这一轮的输入轨迹${reason ? `（${esc(MISSING_REASON[reason] || "输入缺失")}）` : ""}。</div>`
      : "";

  body.innerHTML =
    `<header class="smp-question">` +
    `<h1>${esc(question)}</h1>` +
    (zh && zh !== question ? `<p class="smp-question-zh">${esc(zh)}</p>` : "") +
    `<div class="smp-question-meta">${metaChips(sample, turn)}</div>` +
    `</header>` +
    renderTurnTabs(sample) +
    rawNote +
    (events.length
      ? `<div class="smp-section-label">轨迹事件 <em>${events.length}</em></div><div class="ev-list">${events.map((event) => renderEvent(event, question)).join("")}</div>`
      : turn && turn.input
        ? `<div class="smp-inline-note">这一轮没有可展示的轨迹事件。</div>`
        : "");
}

/* ----------------------------------------------------------------- output */

function renderProblem(problem, index) {
  const evidence = (problem.evidence || [])
    .map((item) => {
      const quote = item.quote || "";
      const shown = item.quote_full > quote.length ? `${quote}…` : quote;
      return (
        `<figure class="out-evidence"><blockquote>${esc(shown)}</blockquote>` +
        `<figcaption><span title="${esc(item.position || "")}">${esc(shortPosition(item.position))}</span><em>${esc(item.component || "")}</em></figcaption></figure>`
      );
    })
    .join("");
  const field = (label, value) =>
    value ? `<div class="out-field"><b>${label}</b><p>${esc(value)}</p></div>` : "";
  return (
    `<article class="out-problem">` +
    `<div class="out-problem-top">` +
    `<span class="smp-sev ${sevClass(problem.severity)}">${esc(problem.severity)}</span>` +
    `<span class="out-problem-comp">${esc(problem.component || "未标注环节")}</span>` +
    `<span class="out-problem-idx">#${index + 1}</span>` +
    `</div>` +
    `<h3>${esc(problem.label || "未命名问题")}</h3>` +
    (problem.definition ? `<p class="out-problem-def">${esc(problem.definition)}</p>` : "") +
    `<details class="out-problem-more"><summary>判定依据<span>${problem.evidence_count || 0} 条证据</span></summary>` +
    field("现象", problem.phenomena) +
    field("理由", problem.reason) +
    field("分级理由", problem.severity_reason) +
    (evidence ? `<div class="out-evidence-list">${evidence}</div>` : `<p class="smp-inline-note">没有结构化证据。</p>`) +
    `</details>` +
    `</article>`
  );
}

function renderProblems(problems, emptyText) {
  if (!problems || !problems.length) return `<p class="smp-inline-note">${esc(emptyText || "未发现归因问题。")}</p>`;
  return `<div class="out-problems">${problems.map(renderProblem).join("")}</div>`;
}

function renderSeverityMix(sample) {
  const counts = {};
  (sample.turns || []).forEach((turn) => (turn.problems || []).forEach((problem) => {
    counts[problem.severity] = (counts[problem.severity] || 0) + 1;
  }));
  (sample.session_problems || []).forEach((problem) => {
    counts[problem.severity] = (counts[problem.severity] || 0) + 1;
  });
  return Object.keys(counts)
    .sort((a, b) => sevRank(a) - sevRank(b))
    .map((severity) => `<span class="smp-sev ${sevClass(severity)}">${esc(severity)}<em>${counts[severity]}</em></span>`)
    .join("");
}

function renderAttribution(sample) {
  const turn = activeTurnOf(sample);
  const summary = sample.session_summary || "";
  const summaryHtml = summary
    ? summary.length > 420
      ? clampHtml(md(summary), "out-summary-text")
      : `<p class="out-summary-text">${md(summary)}</p>`
    : `<p class="smp-inline-note">这份归因记录没有会话结论。</p>`;

  const turnProblems = turn ? turn.problems || [] : [];
  const turnProblemCount = (sample.turns || []).reduce((sum, item) => sum + (item.problem_count || 0), 0);
  const groups =
    sample.turns && sample.turns.length > 1
      ? sample.turns
          .map((item) => {
            const open = item.index === S.activeTurn;
            return (
              `<details class="out-turn" data-turn-group="${item.index}"${open ? " open" : ""}>` +
              `<summary><span class="out-turn-name">第 ${item.index + 1} 轮</span>` +
              `<span class="out-turn-count">${item.problem_count || 0} 个问题</span>` +
              `<p>${esc(clipText(item.summary || questionOf(sample), 120))}</p>` +
              `</summary>` +
              `<div class="out-turn-body">` +
              (item.summary ? `<p class="out-turn-text">${esc(item.summary)}</p>` : "") +
              renderProblems(item.problems, "本轮未发现归因问题。") +
              `</div>` +
              `</details>`
            );
          })
          .join("")
      : renderProblems(turnProblems, "本轮未发现归因问题。");

  return (
    `<div class="out-summary">` +
    `<div class="out-summary-head"><span class="smp-kicker">会话结论</span><span class="out-summary-mix">${renderSeverityMix(sample)}</span></div>` +
    summaryHtml +
    `</div>` +
    `<div class="smp-section-label">归因问题 <em>${turnProblemCount}</em></div>` +
    groups +
    (sample.session_problems && sample.session_problems.length
      ? `<div class="smp-section-label smp-section-label--sub">跨轮问题 <em>${sample.session_problems.length}</em></div>` +
        renderProblems(sample.session_problems, "")
      : "")
  );
}

function renderCompactList(items, kind = "step") {
  if (!items || !items.length) return `<p class="smp-inline-note">这一节没有记录。</p>`;
  return (
    `<ol class="cmp-list">` +
    items
      .map(
        (item, index) =>
          `<li class="cmp-item cmp-item--${kind}">` +
          `<span class="cmp-idx">${index + 1}</span>` +
          `<p>${esc(item.content || "")}</p>` +
          (item.evidence_count ? `<em>${item.evidence_count} 证据</em>` : "") +
          `</li>`
      )
      .join("") +
    `</ol>`
  );
}

function renderCompact(sample) {
  const turn = activeTurnOf(sample);
  if (!turn || !turn.compact) {
    return `<div class="smp-empty">${ICONS.empty}<h3>紧凑轨迹缺失</h3><p>这个样本只有归因记录，没有 compact 记录。</p></div>`;
  }
  const compact = turn.compact;
  const sections = [
    ["规划", compact.plans],
    ["推理", compact.reasoning],
    ["执行", compact.execution],
  ];
  const extras = [
    ["工具错误", compact.tool_errors, "warn"],
    ["自我修正", compact.reflections],
  ];
  const components = compact.components || [];
  return (
    (sample.overview && sample.overview.length
      ? `<section class="cmp-overview"><span class="smp-kicker">会话概览</span><ul>${sample.overview.map((line) => `<li>${esc(line)}</li>`).join("")}</ul></section>`
      : "") +
    sections
      .filter(([, items]) => items && items.length)
      .map(
        ([title, items]) =>
          `<section class="cmp-section"><header><span class="cmp-title">${title}</span><em>${items.length}</em></header>${renderCompactList(items)}</section>`
      )
      .join("") +
    extras
      .filter(([, items]) => items && items.length)
      .map(
        ([title, items, tone]) =>
          `<section class="cmp-section${tone === "warn" ? " is-warn" : ""}"><header><span class="cmp-title">${title}</span><em>${items.length}</em></header>${renderCompactList(items, tone === "warn" ? "warn" : "step")}</section>`
      )
      .join("") +
    (components.length
      ? `<section class="cmp-section"><header><span class="cmp-title">组件</span><em>${components.length}</em></header><div class="cmp-components">` +
        components
          .map(
            (item) =>
              `<div class="cmp-comp"><span class="cmp-kind" title="${item.kind === "tool" ? "工具" : "推理"}">${item.kind === "tool" ? ICONS.tool : ICONS.reason}</span><div><b>${esc(item.name)}</b><p>${esc(item.content)}</p></div>${item.evidence_count ? `<em>${item.evidence_count}</em>` : ""}</div>`
          )
          .join("") +
        `</div></section>`
      : "") +
    `<p class="cmp-foot">完整回答与工具返回见左侧评测输入。</p>`
  );
}

function renderOutput(sample) {
  const body = q("#smpOutputBody");
  const title = q("#smpOutputTitle");
  if (!body) return;
  if (!sample) {
    body.innerHTML = `<div class="smp-empty">${ICONS.empty}<h3>没有可展示的评测输出</h3><p>当前筛选下没有样本。</p></div>`;
    if (title) title.textContent = "归因结果";
    return;
  }
  const tab = S.outTab === "compact" ? "compact" : "attr";
  if (title) title.textContent = tab === "attr" ? "归因结果" : "紧凑轨迹";
  qa("[data-tab]").forEach((button) => {
    const on = button.dataset.tab === tab;
    button.classList.toggle("is-active", on);
    button.setAttribute("aria-selected", String(on));
  });
  body.innerHTML = tab === "attr" ? renderAttribution(sample) : renderCompact(sample);
}

/* ---------------------------------------------------------------- actions */

function copyText(text, button) {
  const done = () => {
    if (!button) return;
    const label = button.textContent;
    button.textContent = "已复制";
    button.classList.add("is-copied");
    window.setTimeout(() => {
      button.textContent = label;
      button.classList.remove("is-copied");
    }, 1200);
  };
  if (!text) return;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
  } else {
    fallbackCopy(text, done);
  }
}

function fallbackCopy(text, done) {
  const area = document.createElement("textarea");
  area.value = text;
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  try {
    if (document.execCommand("copy")) done();
  } catch (error) {
    /* ignore */
  }
  area.remove();
}

function copyActive(kind, button) {
  const sample = activeSample();
  if (!sample) return;
  const turn = activeTurnOf(sample);
  const values = {
    user: sample.user_id,
    session: sample.session_id,
    trace: (turn && turn.trace_id) || sample.trace_id,
  };
  copyText(values[kind] || "", button);
}

function renderActions(sample) {
  const el = q("#smpInputActions");
  if (!el) return;
  if (!sample) {
    el.innerHTML = "";
    return;
  }
  const turn = activeTurnOf(sample);
  const has = {
    user: Boolean(sample.user_id),
    session: Boolean(sample.session_id),
    trace: Boolean((turn && turn.trace_id) || sample.trace_id),
  };
  el.innerHTML =
    `<button class="smp-back" type="button" data-back-list>${ICONS.back}<span>列表</span></button>` +
    `<div class="smp-copy-group" aria-label="复制样本标识">` +
    `<span class="smp-copy-label">${ICONS.copy}<span>复制</span></span>` +
    `<button type="button" data-copy-kind="user" title="复制 User ID" aria-label="复制 User ID"${has.user ? "" : " disabled"}>User</button>` +
    `<button type="button" data-copy-kind="session" title="复制 Session ID" aria-label="复制 Session ID"${has.session ? "" : " disabled"}>Session</button>` +
    `<button type="button" data-copy-kind="trace" title="复制 Trace ID" aria-label="复制 Trace ID"${has.trace ? "" : " disabled"}>Trace</button>` +
    `</div>`;
}

/* ------------------------------------------------------------------- page */

function loadDetail(sample) {
  if (!sample) return Promise.resolve(null);
  if (sample.turns) return Promise.resolve(sample);
  if (detailCache.has(sample.id)) {
    Object.assign(sample, detailCache.get(sample.id));
    return Promise.resolve(sample);
  }
  if (detailPending.has(sample.id)) {
    return detailPending.get(sample.id).then(() => sample);
  }
  const promise = fetch(`samples/${encodeURIComponent(sample.id)}.json`, { cache: "no-cache" })
    .then((response) => {
      if (!response.ok) throw new Error(`samples/${sample.id}.json ${response.status}`);
      return response.json();
    })
    .then((detail) => {
      detailCache.set(sample.id, detail);
      Object.assign(sample, detail);
      return sample;
    })
    .finally(() => {
      detailPending.delete(sample.id);
    });
  detailPending.set(sample.id, promise);
  return promise;
}

function renderDetailLoading() {
  const body =
    `<div class="smp-loading"><span class="smp-spinner" aria-hidden="true"></span><p>正在载入样本…</p></div>`;
  const input = q("#smpInputBody");
  if (input) input.innerHTML = body;
  const output = q("#smpOutputBody");
  if (output) output.innerHTML = body;
}

function renderDetailError() {
  const body =
    `<div class="smp-empty">${ICONS.warning}<h3>样本详情载入失败</h3><p>确认静态目录下已经生成 samples/ 详情文件。</p>` +
    `<button class="smp-retry" type="button" data-retry-detail>重试</button></div>`;
  const input = q("#smpInputBody");
  if (input) input.innerHTML = body;
  const output = q("#smpOutputBody");
  if (output) output.innerHTML = body;
}

function renderDetail() {
  const sample = activeSample();
  renderActions(sample);
  if (!sample) {
    renderInput(null);
    renderOutput(null);
    return;
  }
  if (!sample.turns) {
    renderDetailLoading();
    loadDetail(sample)
      .then(() => {
        if (S.activeId !== sample.id) return;
        if (!S.turnExplicit) S.activeTurn = bestTurn(sample);
        S.activeTurn = Math.min(Math.max(S.activeTurn, 0), Math.max(sample.turns.length - 1, 0));
        renderInput(sample);
        renderOutput(sample);
        syncRoute();
      })
      .catch(() => {
        if (S.activeId === sample.id) renderDetailError();
      });
    return;
  }
  renderInput(sample);
  renderOutput(sample);
}

function renderAll() {
  if (!S.built) buildShell();
  const shell = q(".smp-shell");
  if (shell) shell.dataset.product = S.product;
  renderFilterOptions();
  renderFilterState();
  renderList();
  renderDetail();
  renderFoot();
  const wrap = q(".smp-shell");
  if (wrap) {
    wrap.classList.toggle("is-detail-open", S.mobileDetail);
    wrap.classList.toggle("is-rail-open", false);
  }
}

function syncRoute() {
  if (!S.built) return;
  const sample = activeSample();
  const params = new URLSearchParams();
  params.set("view", "samples");
  params.set("product", S.product);
  ["q", "model", "severity", "component", "date"].forEach((key) => {
    if (S.filter[key]) params.set(key, S.filter[key]);
  });
  if (S.filter.sort && S.filter.sort !== "severity") params.set("sort", S.filter.sort);
  if (sample) params.set("case", sample.id);
  if (sample && sample.turn_count > 1) params.set("turn", String(S.activeTurn));
  if (S.outTab !== "attr") params.set("tab", S.outTab);
  try {
    history.replaceState(null, "", `?${params.toString()}`);
  } catch (error) {
    /* ignore */
  }
}

/* --------------------------------------------------------------------- API */

function firstProductWithSamples() {
  const products = Object.keys((S.data && S.data.products) || {});
  return products.find((product) => samples(product).length) || products[0] || "aime";
}

export function samplesProductFor(product) {
  if (!S.data) return product;
  return samples(product).length ? product : firstProductWithSamples();
}

export function initSamples(root, data, opts = {}) {
  S.root = root;
  S.data = data;
  S.opts = opts || {};
  S.built = false;
  S.activeId = null;
  S.activeTurn = 0;
  S.turnExplicit = false;
  S.outTab = "attr";
  S.moreOpen = false;
  S.mobileDetail = false;
  S.filter = { q: "", model: "", severity: "", component: "", date: "", sort: "severity" };
  if (!data) {
    if (root) {
      root.innerHTML = `<div class="smp-empty smp-empty--page">${ICONS.empty}<h3>样本数据尚未生成</h3><p>运行 <code>python3 prepare_samples.py</code> 生成 samples.json。</p></div>`;
    }
    return;
  }
  if (!samples(S.product).length) S.product = samplesProductFor(S.product);
  const list = filtered();
  S.activeId = list.length ? list[0].id : null;
  S.activeTurn = bestTurn(activeSample());
  renderAll();
}

export function openSampleQuery(filter = {}) {
  if (!S.data) return S.product;
  const products = Object.keys(S.data.products || {});
  const wanted = filter.product && products.includes(filter.product)
    ? samplesProductFor(filter.product)
    : samplesProductFor(S.product);
  S.product = wanted;
  S.filter = {
    q: filter.q || "",
    model: filter.model || "",
    severity: filter.severity || "",
    component: filter.component || "",
    date: filter.date || "",
    sort: filter.sort || "severity",
  };
  S.outTab = filter.tab === "compact" ? "compact" : "attr";
  S.moreOpen = false;
  const list = filtered();
  let target = null;
  if (filter.case) {
    target = samples().find((sample) => sample.id === filter.case || sample.session_id === filter.case);
  }
  if (!target && list.length) target = list[0];
  S.activeId = target ? target.id : null;
  S.turnExplicit = filter.turn != null && filter.turn !== "" && Number.isFinite(Number(filter.turn));
  S.activeTurn = S.turnExplicit
    ? Number(filter.turn)
    : (target && target.turns ? bestTurn(target) : 0);
  if (!Number.isFinite(S.activeTurn)) S.activeTurn = 0;
  S.mobileDetail = Boolean(filter.case);
  if (S.built) {
    const search = q("#smpSearch");
    if (search) search.value = S.filter.q;
    renderFilterOptions();
    renderAll();
  }
  syncRoute();
  return S.product;
}

export function setSamplesProduct(product) {
  if (!S.data || !(S.data.products || {})[product]) return;
  S.product = product;
  S.filter = { q: "", model: "", severity: "", component: "", date: "", sort: "severity" };
  S.mobileDetail = false;
  const list = filtered();
  S.activeId = list.length ? list[0].id : null;
  S.turnExplicit = false;
  S.activeTurn = bestTurn(activeSample());
  const search = q("#smpSearch");
  if (search) search.value = "";
  if (S.built) {
    renderFilterOptions();
    renderAll();
  }
  syncRoute();
}

export function refreshSamples() {
  if (S.built) renderAll();
}

export function setSamplesActive() {
  /* no timers in this view */
}
