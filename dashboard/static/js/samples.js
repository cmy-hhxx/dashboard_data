/* Sample browser: recall by attribution / cluster, input card, output info + attribution cards. */
import { esc } from "./core.js";

const S = {
  root: null,
  data: null,
  opts: {},
  product: "wencai",
  filter: { component: "", severity: "", cluster: "", label: "", q: "" },
  activeId: null,
  sort: "severity",
  mobileDetail: false,
  railOpen: false,
  built: false,
};

const PRODUCT_LABEL = { wencai: "问财", aime: "AIME" };
const SEV_ORDER = { P0: 0, P1: 1, P2: 2, P3: 3, 未分级: 4 };
const SEV_LIST = ["P0", "P1", "P2", "P3", "未分级"];

function q(sel, root = S.root) {
  return root ? root.querySelector(sel) : null;
}

function shellEl() {
  return S.root ? S.root.querySelector(".sample-shell") : null;
}

function samples(product = S.product) {
  const p = S.data && S.data.products && S.data.products[product];
  return (p && p.samples) || [];
}

function productMeta(product = S.product) {
  return (S.data && S.data.products && S.data.products[product]) || {};
}

function modelLabel(sample) {
  const raw = String((sample && sample.model) || "");
  if (raw === "a_fast") return "A·fast";
  if (raw === "a_expert") return "A·expert";
  if (raw === "b_fast") return "B·fast";
  if (raw === "b_expert") return "B·expert";
  if (raw.startsWith("aime_")) return raw.slice(5);
  return raw || "—";
}

function sevRank(sample) {
  const sevs = sample.severities || [];
  if (!sevs.length) return 9;
  return Math.min(...sevs.map((s) => (SEV_ORDER[s] == null ? 8 : SEV_ORDER[s])));
}

function sevClass(sev) {
  const map = { P0: "sev-0", P1: "sev-1", P2: "sev-2", P3: "sev-3", 未分级: "sev-4" };
  return map[sev] || "sev-4";
}

function clusterMatches(cluster, filterValue) {
  if (!filterValue) return true;
  if (!cluster) return false;
  filterValue = String(filterValue).replace(/^归因聚类\//, "").replace(/^root\//, "");
  if (cluster.id === filterValue) return true;
  if ((cluster.ids || []).includes(filterValue)) return true;
  const path = (cluster.path || []).join("/");
  return path === filterValue || path.startsWith(`${filterValue}/`) || filterValue.startsWith(`${path}/`);
}

function clusterKey(cluster) {
  return cluster && cluster.path && cluster.path.length ? cluster.path.join("/") : "";
}

function clusterLabel(cluster) {
  if (!cluster) return "未归簇";
  if (cluster.path && cluster.path.length) return cluster.path.join(" · ");
  return cluster.name || cluster.id || "未归簇";
}

function filtered({ includeCase = false } = {}) {
  const f = S.filter;
  const term = (f.q || "").trim().toLowerCase();
  const out = samples().filter((s) => {
    if (f.component && !(s.components || []).includes(f.component)) return false;
    if (f.severity && !(s.severities || []).includes(f.severity)) return false;
    if (f.cluster && !clusterMatches(s.cluster, f.cluster)) return false;
    if (f.label) {
      const hay = [...(s.labels || []), ...((s.output && s.output.problems) || []).map((p) => p.label || "")]
        .join(" ")
        .toLowerCase();
      if (!hay.includes(f.label.toLowerCase())) return false;
    }
    if (term) {
      const hay = [
        s.question,
        s.case_id,
        s.session_id,
        s.trace_id,
        s.model,
        s.date,
        s.summary,
        clusterLabel(s.cluster),
        ...(s.components || []),
        ...(s.labels || []),
      ]
        .join(" ")
        .toLowerCase();
      if (!hay.includes(term)) return false;
    }
    if (includeCase && f.case && s.case_id !== f.case && s.id !== f.case) return false;
    return true;
  });
  return sortSamples(out);
}

function sortSamples(list) {
  const arr = [...list];
  if (S.sort === "date") {
    arr.sort((a, b) => String(b.date).localeCompare(String(a.date)) || sevRank(a) - sevRank(b));
  } else if (S.sort === "problem") {
    arr.sort((a, b) => (b.problem_count || 0) - (a.problem_count || 0) || sevRank(a) - sevRank(b));
  } else if (S.sort === "question") {
    arr.sort((a, b) => String(a.question).localeCompare(String(b.question), "zh"));
  } else {
    arr.sort((a, b) => sevRank(a) - sevRank(b) || String(b.date).localeCompare(String(a.date)));
  }
  return arr;
}

function activeSample() {
  const list = filtered();
  let s = list.find((x) => x.id === S.activeId || x.case_id === S.activeId);
  if (!s && S.activeId) s = samples().find((x) => x.id === S.activeId || x.case_id === S.activeId);
  return s || list[0] || null;
}

/* ---------------------------------------------------------------- markdown */

function md(text) {
  if (text == null) return "";
  let s = String(text);
  s = s.replace(/data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=\s]+/gi, "[图片已省略]");
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, "[图片]");
  s = esc(s);
  const blocks = [];
  s = s.replace(/```([\s\S]*?)```/g, (_, code) => {
    blocks.push(code.replace(/^\n+|\n+$/g, ""));
    return `\u0000B${blocks.length - 1}\u0000`;
  });
  s = s.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,，。；;:]|$)/g, "$1<em>$2</em>");
  s = s.replace(
    /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
  );
  s = s.replace(/\n/g, "<br>");
  s = s.replace(/\u0000B(\d+)\u0000/g, (_, i) => `<pre class="code-block"><code>${blocks[Number(i)]}</code></pre>`);
  return s;
}

function clampHtml(html, words, className = "") {
  return (
    `<div class="clamp-wrap ${className}">` +
    `<div class="clamp-body">${html}</div>` +
    `<button class="clamp-toggle" type="button" data-clamp>展开全文</button>` +
    `</div>`
  );
}

/* ------------------------------------------------------------------- shell */

function buildShell() {
  if (!S.root) return;
  S.root.innerHTML = `
    <div class="sample-shell">
      <aside class="sample-rail" aria-label="召回筛选">
        <div class="sr-head">
          <div class="sr-title">召回<span>样本</span></div>
          <button class="sr-clear" type="button" data-clear-all>清除</button>
        </div>
        <label class="sr-search">
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="10.5" cy="10.5" r="5.8" stroke="currentColor" stroke-width="1.7"/><path d="m15 15 4.2 4.2" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>
          <input id="sampleSearch" type="search" placeholder="搜问题 / case / 标签" autocomplete="off" spellcheck="false">
        </label>
        <div class="sr-scroll" id="railBody"></div>
        <div class="sr-foot" id="railFoot"></div>
      </aside>
      <div class="sample-rail-backdrop" data-close-rail></div>
      <section class="sample-list-pane" aria-label="样本列表">
        <header class="sl-head">
          <button class="sl-filter-btn" type="button" data-open-rail aria-label="打开筛选">
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 6h16M7 12h10M10 18h4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
          </button>
          <div class="sl-count"><b id="listCount">0</b><span>条样本</span></div>
          <select id="sampleSort" class="sl-sort" aria-label="样本排序">
            <option value="severity">按严重度</option>
            <option value="date">按日期</option>
            <option value="problem">按问题数</option>
            <option value="question">按问题</option>
          </select>
        </header>
        <div class="sample-list" id="sampleList" role="listbox" aria-label="召回样本" tabindex="0"></div>
      </section>
      <section class="sample-detail" id="sampleDetail" aria-label="样本详情"></section>
    </div>`;
  S.built = true;
  bindEvents();
}

function bindEvents() {
  const search = q("#sampleSearch");
  if (search) {
    let timer = 0;
    search.addEventListener("input", () => {
      S.filter.q = search.value;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        S.activeId = null;
        renderList();
        renderDetail();
        syncHash();
      }, 140);
    });
  }
  const sort = q("#sampleSort");
  if (sort) {
    sort.value = S.sort;
    sort.addEventListener("change", () => {
      S.sort = sort.value;
      renderList();
    });
  }
  if (!S.root) return;
  S.root.addEventListener("click", (ev) => {
    const t = ev.target;
    if (t.closest("[data-clear-all]")) {
      clearFilters();
      return;
    }
    if (t.closest("[data-open-rail]")) {
      S.railOpen = true;
      const shell = shellEl(); if (shell) shell.classList.add("is-rail-open");
      return;
    }
    if (t.closest("[data-close-rail]") || t.closest(".sample-rail-backdrop")) {
      S.railOpen = false;
      const shell = shellEl(); if (shell) shell.classList.remove("is-rail-open");
      return;
    }
    const chip = t.closest(".rf-chip");
    if (chip) {
      const kind = chip.dataset.kind;
      const value = chip.dataset.value || "";
      if (kind === "component") S.filter.component = S.filter.component === value ? "" : value;
      if (kind === "severity") S.filter.severity = S.filter.severity === value ? "" : value;
      afterFilterChange();
      return;
    }
    const clearChip = t.closest("[data-clear-filter]");
    if (clearChip) {
      const key = clearChip.dataset.clearFilter;
      if (key in S.filter) S.filter[key] = "";
      afterFilterChange();
      return;
    }
    const clusterRow = t.closest(".ct-row");
    if (clusterRow) {
      const value = clusterRow.dataset.cluster || "";
      S.filter.cluster = S.filter.cluster === value ? "" : value;
      afterFilterChange();
      return;
    }
    const item = t.closest(".sample-item");
    if (item) {
      selectSample(item.dataset.id);
      return;
    }
    const prev = t.closest("[data-prev]");
    if (prev) {
      stepSample(-1);
      return;
    }
    const next = t.closest("[data-next]");
    if (next) {
      stepSample(1);
      return;
    }
    const back = t.closest("[data-back-list]");
    if (back) {
      S.mobileDetail = false;
      const shell = shellEl(); if (shell) shell.classList.remove("is-detail-open");
      return;
    }
    const copy = t.closest("[data-copy]");
    if (copy) {
      copyText(copy.dataset.copy || "", copy);
      return;
    }
    const clusterFilter = t.closest("[data-cluster-filter]");
    if (clusterFilter) {
      S.filter.cluster = clusterFilter.dataset.clusterFilter || "";
      afterFilterChange();
      return;
    }
    const toggle = t.closest("[data-clamp]");
    if (toggle) {
      const wrap = toggle.closest(".clamp-wrap");
      if (wrap) {
        const open = wrap.classList.toggle("is-open");
        toggle.textContent = open ? "收起" : "展开全文";
      }
      return;
    }
    const railSample = t.closest("[data-rail-sample]");
    if (railSample) {
      S.railOpen = false;
      const shell = shellEl(); if (shell) shell.classList.remove("is-rail-open");
      selectSample(railSample.dataset.railSample);
    }
  });
  S.root.addEventListener("keydown", (ev) => {
    const list = q("#sampleList");
    if (!list || !list.contains(document.activeElement)) return;
    if (ev.key !== "ArrowDown" && ev.key !== "ArrowUp" && ev.key !== "Enter") return;
    const items = [...list.querySelectorAll(".sample-item")];
    if (!items.length) return;
    const current = items.findIndex((x) => x.classList.contains("is-active"));
    if (ev.key === "Enter") {
      if (items[current]) selectSample(items[current].dataset.id);
      return;
    }
    ev.preventDefault();
    const delta = ev.key === "ArrowDown" ? 1 : -1;
    const next = Math.min(items.length - 1, Math.max(0, current + delta));
    items[next].focus();
    items[next].scrollIntoView({ block: "nearest" });
  });
}

function clearFilters() {
  S.filter = { component: "", severity: "", cluster: "", label: "", q: "" };
  const search = q("#sampleSearch");
  if (search) search.value = "";
  afterFilterChange();
}

function afterFilterChange() {
  const list = filtered();
  if (!list.some((s) => s.id === S.activeId || s.case_id === S.activeId)) {
    S.activeId = list.length ? list[0].id : null;
  }
  renderAll();
}

function selectSample(id) {
  S.activeId = id;
  S.mobileDetail = true;
  const shell = shellEl();
  if (shell) shell.classList.add("is-detail-open");
  renderList();
  renderDetail();
  syncHash();
  const detail = q("#sampleDetail");
  if (detail && window.innerWidth > 900) detail.scrollTop = 0;
}

function stepSample(delta) {
  const list = filtered();
  if (!list.length) return;
  const current = list.findIndex((s) => s.id === S.activeId || s.case_id === S.activeId);
  const next = list[Math.min(list.length - 1, Math.max(0, (current < 0 ? 0 : current) + delta))];
  if (next) selectSample(next.id);
}

function copyText(text, btn) {
  const done = () => {
    if (!btn) return;
    const old = btn.textContent;
    btn.textContent = "已复制";
    window.setTimeout(() => { btn.textContent = old; }, 1200);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
  } else {
    fallbackCopy(text, done);
  }
}

function fallbackCopy(text, done) {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand("copy"); done(); } catch (e) {}
  ta.remove();
}

/* -------------------------------------------------------------------- rail */

function facetCounts(list) {
  const comps = new Map();
  const sevs = new Map();
  list.forEach((s) => {
    (s.components || []).forEach((c) => comps.set(c, (comps.get(c) || 0) + 1));
    (s.severities || []).forEach((x) => sevs.set(x, (sevs.get(x) || 0) + 1));
  });
  return {
    components: [...comps.entries()].sort((a, b) => b[1] - a[1]),
    severities: SEV_LIST.filter((s) => sevs.has(s)).map((s) => [s, sevs.get(s)]),
  };
}

function buildClusterTree(list) {
  const root = { key: "", name: "全部聚类", count: 0, children: [] };
  const map = new Map();
  list.forEach((s) => {
    if (!s.cluster || !s.cluster.path || !s.cluster.path.length) return;
    let parent = root;
    s.cluster.path.forEach((name, i) => {
      const key = s.cluster.path.slice(0, i + 1).join("/");
      let node = map.get(key);
      if (!node) {
        node = { key, name, count: 0, children: [] };
        map.set(key, node);
        parent.children.push(node);
      }
      node.count += 1;
      parent = node;
    });
    root.count += 1;
  });
  const sortTree = (node) => {
    node.children.sort((a, b) => b.count - a.count);
    node.children.forEach(sortTree);
  };
  sortTree(root);
  return root;
}

function renderRail() {
  const body = q("#railBody");
  const foot = q("#railFoot");
  if (!body) return;
  const list = samples();
  const facets = facetCounts(list);
  const f = S.filter;
  const activeChips = [];
  if (f.component) activeChips.push(["component", `环节：${f.component}`]);
  if (f.severity) activeChips.push(["severity", `严重度：${f.severity}`]);
  if (f.cluster) activeChips.push(["cluster", `聚类：${String(f.cluster).split("/").join(" · ")}`]);
  if (f.label) activeChips.push(["label", `标签：${f.label}`]);
  if (f.q) activeChips.push(["q", `搜索：${f.q}`]);

  const compChips = facets.components
    .map(
      ([name, count]) =>
        `<button class="rf-chip${f.component === name ? " is-active" : ""}" type="button" data-kind="component" data-value="${esc(name)}" title="${esc(name)} · ${count} 条样本">` +
        `<span>${esc(name)}</span><em>${count}</em></button>`
    )
    .join("");

  const sevChips = facets.severities.length
    ? facets.severities
        .map(
          ([sev, count]) =>
            `<button class="rf-chip rf-chip--sev ${sevClass(sev)}${f.severity === sev ? " is-active" : ""}" type="button" data-kind="severity" data-value="${esc(sev)}" title="${sev} · ${count} 条样本">` +
            `<i></i><span>${sev}</span><em>${count}</em></button>`
        )
        .join("")
    : `<p class="rf-note">该批次归因没有严重度字段（问财 1,508 条均为空），只能按环节召回。</p>`;

  const tree = buildClusterTree(list);
  const clusterRows = [];
  const walk = (node, depth) => {
    if (node.key) {
      const active = f.cluster && (f.cluster === node.key || f.cluster.startsWith(`${node.key}/`) || node.key.startsWith(`${f.cluster}/`));
      clusterRows.push(
        `<button class="ct-row${active ? " is-active" : ""}" type="button" data-cluster="${esc(node.key)}" style="--depth:${depth}" title="${esc(node.key)} · ${node.count} 条样本">` +
        `<i class="ct-caret" aria-hidden="true">${node.children.length ? "▾" : ""}</i>` +
        `<span class="ct-name">${esc(node.name)}</span><em>${node.count}</em></button>`
      );
    }
    node.children.forEach((c) => walk(c, depth + 1));
  };
  walk(tree, 0);

  body.innerHTML = `
    ${activeChips.length ? `<div class="rf-active">${activeChips.map(([key, label]) => `<button class="rf-active-chip" type="button" data-clear-filter="${key}">${esc(label)}<span>×</span></button>`).join("")}</div>` : ""}
    <section class="rf-sec">
      <div class="rf-title"><span>按归因召回</span><em>${list.length} 条</em></div>
      ${compChips ? `<div class="rf-chips">${compChips}</div>` : `<p class="rf-note">暂无可用的环节字段。</p>`}
      <div class="rf-sub">严重度</div>
      <div class="rf-chips">${sevChips}</div>
    </section>
    <section class="rf-sec">
      <div class="rf-title"><span>按聚类召回</span><em>${tree.count} 条归簇</em></div>
      <div class="cluster-tree" role="tree">
        <button class="ct-row ct-root${!f.cluster ? " is-active" : ""}" type="button" data-cluster="" style="--depth:0"><i class="ct-caret"></i><span class="ct-name">全部聚类</span><em>${tree.count}</em></button>
        ${clusterRows.join("")}
      </div>
    </section>
    <section class="rf-sec rf-sec--meta">
      <p>${S.data && S.data.is_demo ? "示例数据" : "真实快照"} · 归因 / 聚类快照 ${esc((S.data && S.data.generated_at || "—").slice(5, 16).replace("T", " "))}</p>
      <p>${esc((S.data && S.data.freshness && S.data.freshness.reason) || "样本来自当前可用的归因与聚类快照。")}</p>
    </section>`;

  if (foot) {
    foot.innerHTML = `<span>当前召回 <b>${filtered().length}</b> / ${list.length}</span><button type="button" data-clear-all>清除全部</button>`;
  }
}

/* -------------------------------------------------------------------- list */

function renderList() {
  const el = q("#sampleList");
  const count = q("#listCount");
  if (!el) return;
  const list = filtered();
  if (count) count.textContent = String(list.length);
  if (!list.length) {
    el.innerHTML = `<div class="sample-list-empty"><span>∅</span><p>没有匹配的样本</p><button type="button" data-clear-all>清除筛选</button></div>`;
    return;
  }
  const active = activeSample();
  el.innerHTML = list
    .map((s) => {
      const sevs = (s.severities || []).slice(0, 3);
      const sevHtml = sevs.length
        ? sevs.map((x) => `<span class="sev-pill ${sevClass(x)}"><i></i>${x}</span>`).join("")
        : `<span class="sev-pill sev-none">无分级</span>`;
      return (
        `<button class="sample-item${active && (s.id === active.id) ? " is-active" : ""}" type="button" role="option" aria-selected="${active && s.id === active.id}" data-id="${esc(s.id)}">` +
        `<span class="si-top"><span class="si-model">${esc(PRODUCT_LABEL[s.product] || s.product)} · ${esc(modelLabel(s))}</span><span class="si-date">${esc(s.date)}</span></span>` +
        `<span class="si-q">${esc(s.question || "（无原问）")}</span>` +
        `<span class="si-foot">` +
        `<span class="si-cluster" title="${esc(clusterLabel(s.cluster))}">${esc(s.cluster && s.cluster.name ? s.cluster.name : "未归簇")}</span>` +
        `<span class="si-sevs">${sevHtml}</span>` +
        `<span class="si-probs">${s.problem_count || 0}</span>` +
        `</span>` +
        `</button>`
      );
    })
    .join("");
}

/* ------------------------------------------------------------------ detail */

function msgSummary(m) {
  if (m.type === "reasoning") return "思考摘要";
  if (m.type === "function_call") return `工具调用 · ${m.name || "unknown"}`;
  if (m.type === "function_call_output") return "工具返回";
  return m.role || m.type || "消息";
}

function renderMessages(messages) {
  if (!messages || !messages.length) return `<p class="detail-empty">未载入消息。</p>`;
  return messages
    .map((m) => {
      const role = m.role || m.type || "";
      if (role === "system") {
        const text = m.text || "";
        return `<details class="msg msg--system"><summary><span class="msg-role">system</span><span>系统提示 · ${text.length.toLocaleString()} 字</span><i class="msg-caret"></i></summary><div class="msg-body">${md(text)}</div></details>`;
      }
      if (m.type === "reasoning") {
        return `<details class="msg msg--reason"><summary><span class="msg-role">reason</span><span>思考摘要</span><i class="msg-caret"></i></summary><div class="msg-body">${md(m.summary || "")}</div></details>`;
      }
      if (m.type === "function_call") {
        return `<details class="msg msg--tool"><summary><span class="msg-role">tool</span><span>${esc(m.name || "工具")} · 参数</span><i class="msg-caret"></i></summary><div class="msg-body"><pre class="code-block"><code>${esc(m.arguments || "")}</code></pre></div></details>`;
      }
      if (m.type === "function_call_output") {
        const out = m.output || "";
        return `<details class="msg msg--tool msg--output"><summary><span class="msg-role">return</span><span>工具返回 · ${out.length.toLocaleString()} 字</span><i class="msg-caret"></i></summary><div class="msg-body"><pre class="code-block"><code>${esc(out)}</code></pre></div></details>`;
      }
      if (role === "user") {
        return `<div class="msg msg--user"><div class="msg-head"><span class="msg-role">user</span><span>用户输入</span></div><div class="msg-body">${md(m.text || "")}</div></div>`;
      }
      if (role === "assistant") {
        const text = m.text || "";
        const body = md(text);
        return `<div class="msg msg--assistant"><div class="msg-head"><span class="msg-role">assistant</span><span>最终回答</span><span class="msg-len">${text.length.toLocaleString()} 字</span></div>${text.length > 900 ? clampHtml(body, text.length) : `<div class="msg-body">${body}</div>`}</div>`;
      }
      if (m.text) {
        return `<div class="msg"><div class="msg-head"><span class="msg-role">${esc(role || "material")}</span></div><div class="msg-body">${md(m.text)}</div></div>`;
      }
      return `<details class="msg msg--raw"><summary><span class="msg-role">raw</span><span>${esc(m.type || "材料")}</span><i class="msg-caret"></i></summary><div class="msg-body"><pre class="code-block"><code>${esc(JSON.stringify(m, null, 2))}</code></pre></div></details>`;
    })
    .join("");
}

function verdictOf(sample) {
  const v = sample.is_correct;
  if (v === 1) return { cls: "ok", text: "与标准一致" };
  if (v === 0) return { cls: "bad", text: "与标准不一致" };
  return { cls: "na", text: "无标准 / 未判定" };
}

function renderProblem(p, index, selected) {
  const sev = p.severity || "未分级";
  const evidence = (p.evidence || [])
    .map(
      (e) =>
        `<figure class="evidence"><blockquote>${esc(e.quote || "")}</blockquote>` +
        `<figcaption><span>${esc(String(e.position || "").split(" / ").slice(0, 3).join(" / "))}</span><em>${esc(e.component || "")}</em></figcaption></figure>`
    )
    .join("");
  return (
    `<article class="problem${selected ? " is-focus" : ""}" data-problem="${index}">` +
    `<header class="problem-head">` +
    `<span class="sev-pill ${sevClass(sev)}"><i></i>${esc(sev)}</span>` +
    `<span class="problem-component">${esc(p.component || "未标注环节")}</span>` +
    `<span class="problem-idx">#${index + 1}</span>` +
    `</header>` +
    `<h4 class="problem-label">${esc(p.label || "未命名问题")}</h4>` +
    `<p class="problem-def">${esc(p.definition || "")}</p>` +
    `<details class="problem-detail"${selected ? " open" : ""}>` +
    `<summary>判定依据与证据 <span>${(p.evidence || []).length} 条证据</span></summary>` +
    (p.problem_phenomena ? `<p class="problem-phen"><b>现象</b>${esc(p.problem_phenomena)}</p>` : "") +
    (p.reason ? `<p class="problem-reason"><b>理由</b>${esc(p.reason)}</p>` : "") +
    (p.severity_reason ? `<p class="problem-sev"><b>分级理由</b>${esc(p.severity_reason)}</p>` : "") +
    (evidence ? `<div class="evidence-list">${evidence}</div>` : `<p class="detail-empty">没有结构化证据。</p>`) +
    `</details>` +
    `</article>`
  );
}

function renderDetail() {
  const el = q("#sampleDetail");
  if (!el) return;
  const s = activeSample();
  if (!s) {
    el.innerHTML = `<div class="sample-empty"><div class="se-orb">⌕</div><h3>没有可展示的样本</h3><p>当前筛选下没有样本。清除筛选，或换一个产品/召回条件。</p><button type="button" data-clear-all>清除筛选</button></div>`;
    return;
  }
  const list = filtered();
  const idx = list.findIndex((x) => x.id === s.id);
  const prev = list[idx - 1];
  const next = list[idx + 1];
  const inMeta = (s.input && s.input.meta) || {};
  const stats = (s.input && s.input.stats) || {};
  const out = s.output || {};
  const problems = out.problems || [];
  const verdict = verdictOf(s);
  const selectedProblem = problems.findIndex((p) => p.selected);
  const cluster = s.cluster;
  const tools = (s.input && s.input.tools) || [];

  const metaChips = [
    ["任务", inMeta.task],
    ["子类", inMeta.subtask],
    ["难度", inMeta.difficulty],
    ["来源", inMeta.source],
    ["Skill", inMeta.skill_name],
    ["模式", inMeta.agent_mode],
  ]
    .filter(([, v]) => v)
    .map(([k, v]) => `<span class="meta-chip"><em>${k}</em>${esc(v)}</span>`)
    .join("");

  const toolChips = tools.length
    ? `<div class="tool-strip"><span class="tool-title">可用工具</span>${tools.map((t) => `<span class="tool-chip">${esc(t.name || t)}</span>`).join("")}</div>`
    : "";

  const problemHtml = problems.length
    ? problems.map((p, i) => renderProblem(p, i, i === selectedProblem || (selectedProblem < 0 && i === 0))).join("")
    : `<div class="detail-empty detail-empty--box">这条样本没有登记归因问题。</div>`;

  const infoSummary = out.summary
    ? `<div class="info-block"><h4>逐轮总结</h4><p>${md(out.summary)}</p></div>`
    : "";
  const sessionSummary = out.session_summary
    ? `<details class="info-block info-block--fold"${out.session_summary.length < 700 ? " open" : ""}><summary>会话总结 <span>${out.session_summary.length.toLocaleString()} 字</span></summary><p>${md(out.session_summary)}</p></details>`
    : "";
  const correctReason = out.correct_reason
    ? `<p class="verdict-reason">${esc(out.correct_reason)}</p>`
    : "";

  el.innerHTML = `
    <header class="sd-head">
      <button class="sd-back" type="button" data-back-list aria-label="返回样本列表">← 列表</button>
      <div class="sd-identity">
        <div class="sd-case"><span>${esc(s.case_id || s.id)}</span><button type="button" data-copy="${esc(s.case_id || s.id)}" title="复制 case_id">复制</button></div>
        <div class="sd-sub"><span>${esc(PRODUCT_LABEL[s.product] || s.product)}</span><span>${esc(modelLabel(s))}</span><span>${esc(s.date)}</span><span>${esc(s.split || "")}</span></div>
      </div>
      <div class="sd-nav">
        <button type="button" data-prev ${prev ? "" : "disabled"} title="上一条">↑</button>
        <button type="button" data-next ${next ? "" : "disabled"} title="下一条">↓</button>
        <span>${idx + 1} / ${list.length}</span>
      </div>
    </header>
    <div class="sd-grid">
      <article class="sample-card input-card">
        <header class="sample-card-head">
          <div><span class="card-kicker">评测输入</span><h3>${esc(s.input ? "原始 trace" : "输入缺失")}</h3></div>
          <span class="card-side">${s.input ? `${stats.n_messages || (s.input.messages || []).length} 条消息 · ${stats.tool_count || tools.length || 0} 次工具` : "未对齐"}</span>
        </header>
        <div class="sample-card-body">
          <div class="input-question">${esc(s.question || "（无原问）")}</div>
          <div class="meta-chips">${metaChips || `<span class="meta-chip">无任务元数据</span>`}</div>
          ${toolChips}
          ${s.input ? `<div class="trace-rail">${renderMessages(s.input.messages)}</div>` : `<div class="detail-empty detail-empty--box">${esc((s.quality && s.quality.input_missing_reason) || "输入记录未能与 trace 对齐。")}</div>`}
        </div>
      </article>
      <div class="output-col">
        <article class="sample-card info-card">
          <header class="sample-card-head">
            <div><span class="card-kicker">评测输出 · 信息</span><h3>判词与产出</h3></div>
            <span class="verdict ${verdict.cls}">${verdict.text}</span>
          </header>
          <div class="sample-card-body">
            <div class="metric-grid">
              <span><em>问题</em><b>${problems.length}</b></span>
              <span><em>Tokens</em><b>${Number(stats.total_tokens || out.metrics && out.metrics.tokens || 0).toLocaleString()}</b></span>
              <span><em>P50</em><b>${out.metrics && out.metrics.p50 ? out.metrics.p50.toFixed(1) + "s" : "—"}</b></span>
              <span><em>回答字数</em><b>${(out.metrics && out.metrics.answer_len) || stats.answer_len || inMeta.answer_len ? Number((out.metrics && out.metrics.answer_len) || stats.answer_len || inMeta.answer_len).toLocaleString() : "—"}</b></span>
            </div>
            ${infoSummary}
            ${sessionSummary}
            ${correctReason ? `<div class="info-block info-block--reason"><h4>一致性说明</h4>${correctReason}</div>` : ""}
            ${(s.quality && (s.quality.input_missing || s.quality.cluster_missing || s.quality.severity_missing)) ? `<div class="quality-note">${s.quality.input_missing ? "输入未对齐 · " : ""}${s.quality.cluster_missing ? "未归簇 · " : ""}${s.quality.severity_missing ? "该批次无严重度" : ""}</div>` : ""}
          </div>
        </article>
        <article class="sample-card attr-card">
          <header class="sample-card-head">
            <div><span class="card-kicker">评测输出 · 归因</span><h3>${problems.length} 个问题</h3></div>
            <button class="cluster-jump" type="button" data-cluster-filter="${esc(clusterKey(cluster))}" ${cluster ? "" : "disabled"} title="按此聚类继续召回">按簇召回</button>
          </header>
          <div class="sample-card-body">
            <div class="attr-cluster">
              <span class="attr-cluster-label">聚类路径</span>
              <div class="attr-path">${cluster ? (cluster.path || [cluster.name]).map((x) => `<span>${esc(x)}</span>`).join("<i>›</i>") : `<span class="muted">未归簇</span>`}</div>
              ${cluster && cluster.id ? `<code>${esc(cluster.id)}</code>` : ""}
            </div>
            <div class="problem-list">${problemHtml}</div>
          </div>
        </article>
      </div>
    </div>`;
}

/* -------------------------------------------------------------------- state */

function syncHash() {
  if (!S.built) return;
  const s = activeSample();
  const params = new URLSearchParams();
  params.set("product", S.product);
  ["component", "severity", "cluster", "label", "q"].forEach((k) => {
    if (S.filter[k]) params.set(k, S.filter[k]);
  });
  if (s && s.case_id) params.set("case", s.case_id);
  try {
    history.replaceState(null, "", `#/samples?${params.toString()}`);
  } catch (e) {}
}

function renderAll() {
  if (!S.root) return;
  if (!S.data) {
    S.root.innerHTML = `<div class="sample-empty sample-empty--page"><div class="se-orb">⌕</div><h3>样本数据尚未生成</h3><p>运行 <code>python3 prepare_samples.py</code> 生成 samples.json，或在数据接入后刷新页面。</p></div>`;
    return;
  }
  if (!S.built) buildShell();
  renderRail();
  renderList();
  renderDetail();
  const shell = shellEl();
  if (shell) {
    shell.classList.toggle("is-detail-open", S.mobileDetail);
    shell.classList.toggle("is-rail-open", S.railOpen);
  }
  syncHash();
}

/* --------------------------------------------------------------------- API */

export function initSamples(root, data, opts = {}) {
  S.root = root;
  S.data = data;
  S.opts = opts || {};
  S.built = false;
  if (!data) {
    renderAll();
    return;
  }
  const products = Object.keys((data && data.products) || {});
  if (!products.includes(S.product)) S.product = products[0] || "wencai";
  if (!samples(S.product).length && products.length) S.product = products.find((p) => samples(p).length) || S.product;
  S.activeId = null;
  S.filter = { component: "", severity: "", cluster: "", label: "", q: "" };
  renderAll();
}

export function openSampleQuery(filter = {}) {
  if (!S.data) return;
  if (filter.product && PRODUCT_LABEL[filter.product]) S.product = filter.product;
  S.filter = {
    component: filter.component || "",
    severity: filter.severity || "",
    cluster: filter.cluster || "",
    label: filter.label || "",
    q: filter.q || "",
  };
  const target = filter.case ? samples().find((s) => s.case_id === filter.case || s.id === filter.case) : null;
  const list = filtered();
  S.activeId = target ? target.id : list.length ? list[0].id : null;
  S.mobileDetail = Boolean(filter.case);
  S.railOpen = false;
  if (S.built) {
    renderAll();
    const search = q("#sampleSearch");
    if (search) search.value = S.filter.q;
  }
}

export function setSamplesProduct(product) {
  if (!PRODUCT_LABEL[product] || product === S.product) return;
  S.product = product;
  S.filter = { component: "", severity: "", cluster: "", label: "", q: "" };
  S.activeId = null;
  S.mobileDetail = false;
  S.railOpen = false;
  if (S.built) {
    const search = q("#sampleSearch");
    if (search) search.value = "";
    renderAll();
  }
}

export function refreshSamples() {
  if (S.built) renderAll();
}

export function setSamplesActive() {
  /* no timers in this view */
}
