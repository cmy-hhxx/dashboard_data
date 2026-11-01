/* Data board: concentric rings, evaluation coverage, attribution, cluster and prediction. */
import {
  $, FONT, REDUCED, fmt, pct, clamp, fmtBytes, fmtTokens, dateRange, esc,
  lerpColor, hexA, readTokens, T, C, SEV_COLOR, AIME_SEVERITIES, tip, tipCard,
  tipHead, tipRow, createChart, setNum, settleCounters, resizeAllCharts,
} from "./core.js";
import { createRing } from "./ring.js";

const board = {
  data: null,
  opts: {},
  product: "wencai",
  volume: {
    wencai: { task: null, defaultExpanded: false },
    aime: { task: null, defaultExpanded: false },
  },
  cluster: {
    wencai: { src: null, root: null, meta: {}, stack: [], expandedKey: "" },
    aime: { src: null, root: null, meta: {}, stack: [], expandedKey: "" },
  },
  predict: { wencai: { dim: "review" }, aime: { dim: "review" } },
  rings: { wencai: { volume: null, cluster: null }, aime: { volume: null, cluster: null } },
  rendered: { wencai: false, aime: false },
};

const VERSION_DEFS = {
  a_expert: { label: "A·expert", color: () => T.wc, group: "A" },
  a_fast: { label: "A·fast", color: () => T.wcMid, group: "A" },
  b_expert: { label: "B·expert", color: () => T.b, group: "B" },
  b_fast: { label: "B·fast", color: () => T.bMid, group: "B" },
  fast: { label: "fast", color: () => T.predFast || T.aiMid, group: "AI" },
  expert: { label: "expert", color: () => T.ai, group: "AI" },
};

const isWc = (product) => product === "wencai";
const getSrc = (product) => (isWc(product) ? board.data.wencai : board.data.aime);
const productLabel = (product) => (isWc(product) ? "问财" : "AIME");

function showChartEmpty(el, text) {
  if (!el) return;
  const old = echarts.getInstanceByDom(el);
  if (old) {
    try { old.dispose(); } catch (e) {}
  }
  el.innerHTML = `<div class="empty-state"><span class="empty-mark">∅</span><p>${esc(text)}</p></div>`;
}

/* ------------------------------------------------------------------ tasks */

function taskList(product) {
  const src = getSrc(product);
  const wc = isWc(product);
  let cats = [...((src.input.categories && src.input.categories.task) || [])]
    .map((c) => ({ ...c }))
    .filter((c) => c.name !== "未标注")
    .sort((a, b) => (b.value || 0) - (a.value || 0));
  if (wc) {
    cats = cats.filter((c) => !["其他", "其它", "未标注"].includes(c.name));
  } else {
    const other = cats.find((c) => c.name === "其他");
    const qita = cats.find((c) => c.name === "其它");
    if (qita) {
      if (other) other.value += qita.value;
      else cats.push({ name: "其他", value: qita.value });
      cats = cats.filter((c) => c.name !== "其它");
    }
  }
  return cats;
}

function taskSubs(product, taskName) {
  const src = getSrc(product);
  const map = (src.input.categories && src.input.categories.task_subtask) || {};
  let subs = (map[taskName] || [])
    .map((c) => ({ ...c }))
    .filter((c) => c.name !== "未标注" && c.value > 0)
    .sort((a, b) => b.value - a.value);
  const task = taskList(product).find((t) => t.name === taskName);
  const total = task ? task.value : 0;
  const sum = subs.reduce((n, c) => n + c.value, 0);
  if (total > sum) {
    const label = subs.some((c) => c.name === "其他") ? "其余" : "其他";
    subs.push({ name: label, value: total - sum });
  }
  if (!subs.length && total > 0) subs = [{ name: "未细分", value: total }];
  return subs;
}

function maybeNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

const RING_LIGHT = [
  "#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4",
  "#008300", "#6250d6", "#e34948", "#184f95", "#a8431a",
  "#127a56", "#a06b00", "#a83e62", "#0a6b0a",
];
const RING_DARK = [
  "#3987e5", "#d95926", "#199e70", "#c98500", "#d55181",
  "#008300", "#9085e9", "#e66767", "#4f90e0", "#c96a45",
  "#2a9a6d", "#b88a00", "#c45f85", "#2f9a2f",
];

function ringPalette(n) {
  const colors = T.mode === "dark" ? RING_DARK : RING_LIGHT;
  return Array.from({ length: n }, (_, i) => colors[i % colors.length]);
}

function paletteByName(names) {
  const colors = ringPalette(names.length);
  const ordered = [...names].sort((a, b) => String(a).localeCompare(String(b), "zh-Hans-CN"));
  return new Map(ordered.map((name, i) => [name, colors[i]]));
}

function indexTree(root) {
  const map = new Map();
  const walk = (node) => {
    if (node.key) map.set(node.key, node);
    (node.children || []).forEach(walk);
  };
  walk(root);
  return map;
}

function markLegend(el, key) {
  if (!el) return;
  el.querySelectorAll(".rl-row").forEach((row) => {
    row.classList.toggle("is-hover", Boolean(key) && row.dataset.key === key);
  });
}

function bindLegendHover(el, getRing) {
  if (!el) return;
  el.querySelectorAll(".rl-row").forEach((row) => {
    const enter = () => {
      row.classList.add("is-hover");
      const ring = getRing();
      if (ring) ring.hover(row.dataset.key);
    };
    const leave = () => {
      row.classList.remove("is-hover");
      const ring = getRing();
      if (ring) ring.clear();
    };
    row.addEventListener("pointerenter", enter);
    row.addEventListener("pointerleave", leave);
    row.addEventListener("focus", enter);
    row.addEventListener("blur", leave);
  });
}

/* ----------------------------------------------------------------- volume */

function volumeTotal(product) {
  const src = getSrc(product);
  return src.input.total || taskList(product).reduce((n, t) => n + (t.value || 0), 0) || 1;
}

function volumeTree(product) {
  const tasks = taskList(product);
  const total = volumeTotal(product);
  const classified = tasks.reduce((n, t) => n + (t.value || 0), 0) || 1;
  const colorMap = paletteByName(tasks.map((task) => task.name));
  const childMix = T.mode === "dark" ? "#ffffff" : T.surface;
  const root = { key: "vol-root", name: "全部任务", value: total, children: [] };
  root.children = tasks.map((task) => {
    const key = `task:${task.name}`;
    const color = colorMap.get(task.name) || T.cl1;
    const subs = taskSubs(product, task.name);
    const subSum = subs.reduce((n, c) => n + (c.value || 0), 0) || 1;
    return {
      key,
      name: task.name,
      value: task.value,
      color,
      share: pct(task.value, classified),
      children: subs.map((s, j) => ({
        key: `${key}/${j}`,
        name: s.name,
        value: s.value,
        color: lerpColor(
          color,
          childMix,
          0.1 + (j / Math.max(subs.length - 1, 1)) * 0.18
        ),
        share: pct(s.value, subSum),
      })),
    };
  });
  return { root, tasks, total, classified, byKey: indexTree(root) };
}

function renderVolumeLegend(product, tree, focused) {
  const el = $(isWc(product) ? "wcVolumeLegend" : "aiVolumeLegend");
  if (!el) return;
  const rows = focused ? focused.children || [] : tree.root.children;
  if (!rows.length) {
    el.innerHTML = "";
    return;
  }
  const staticRows = Boolean(focused);
  const total = rows.reduce((n, node) => n + Math.max(0, Number(node.value) || 0), 0) || 1;
  const ranked = [...rows].sort((a, b) => Number(b.value || 0) - Number(a.value || 0));
  const top = ranked[0];
  const concentration = ranked.reduce((n, node) => {
    const share = Math.max(0, Number(node.value) || 0) / total;
    return n + share * share;
  }, 0);
  const concentrationLabel = concentration >= 0.5 ? "集中" : concentration >= 0.3 ? "均衡" : "分散";
  const stack = ranked
    .map((node) => {
      const width = pct(node.value, total);
      return `<i style="width:${width.toFixed(2)}%;background:${node.color}"></i>`;
    })
    .join("");

  el.classList.toggle("is-single", staticRows);
  el.innerHTML =
    `<div class="vbd-head">` +
      `<span>${staticRows ? "子类构成" : "类别构成"}</span>` +
      `<span>${fmt(rows.length)} 类</span>` +
    `</div>` +
    `<div class="vbd-stack" role="img" aria-label="${esc(top ? `${top.name}占比最高` : "类别构成")}">${stack}</div>` +
    `<div class="vbd-rows">` +
    rows
    .map((node) => {
      const title = `${node.name} · ${fmt(node.value)} 条 · ${Number(node.share || 0).toFixed(1)}%`;
      const tag = staticRows ? "div" : "button";
      const attrs = staticRows
        ? `class="rl-row vbd-row is-static"`
        : `class="rl-row vbd-row" type="button" aria-label="${esc(title)}"`;
      return (
        `<${tag} ${attrs} data-key="${esc(node.key)}" title="${esc(title)}">` +
          `<span class="vbd-top">` +
            `<i class="rl-dot" style="background:${node.color}"></i>` +
            `<span class="rl-name">${esc(node.name)}</span>` +
            `<b>${fmt(node.value)}</b>` +
            `<em>${Number(node.share || 0).toFixed(1)}%</em>` +
          `</span>` +
          `<span class="vbd-track" aria-hidden="true"><i style="width:${clamp(Number(node.share || 0), 0, 100).toFixed(2)}%;background:${node.color}"></i></span>` +
        `</${tag}>`
      );
    })
    .join("") +
    `</div>` +
    `<div class="vbd-foot">` +
      `<span><em>最大项</em><b>${esc(top ? top.name : "—")} · ${top ? Number(top.share || 0).toFixed(1) : "0.0"}%</b></span>` +
      `<span><em>分布</em><b>${concentrationLabel}</b></span>` +
    `</div>`;

  bindLegendHover(el, () => board.rings[product].volume);
  el.onclick = (ev) => {
    const row = ev.target.closest("button.vbd-row");
    if (!row || staticRows) return;
    const task = row.dataset.key.replace(/^task:/, "");
    const state = board.volume[product];
    state.task = state.task === task ? null : task;
    renderVolumeVisual(product);
  };
}

function renderVolumeVisual(product) {
  const tree = volumeTree(product);
  const state = board.volume[product];
  let focused = tree.tasks.find((t) => t.name === state.task);
  if (state.task && !focused) state.task = null;
  focused = focused ? tree.byKey.get(`task:${state.task}`) : null;
  if (!focused) state.task = null;

  const chartEl = $(isWc(product) ? "wcTaskChart" : "aiTaskChart");
  const centerEl = $(isWc(product) ? "wcRingCenter" : "aiRingCenter");
  const legendEl = $(isWc(product) ? "wcVolumeLegend" : "aiVolumeLegend");
  if (!chartEl) return;

  if (!tree.tasks.length) {
    showChartEmpty(chartEl, "任务分类数据待接入");
    if (centerEl) {
      centerEl.innerHTML = "";
      centerEl.hidden = true;
    }
    if (legendEl) legendEl.innerHTML = "";
    return;
  }
  if (centerEl) centerEl.hidden = false;

  board.rings[product].volume = createRing(chartEl, centerEl, {
    root: tree.root,
    expandedKey: focused ? focused.key : "",
    unit: "条",
    restValue: tree.total,
    restLabel: "条输入",
    shareTotal: tree.classified,
    centerNode: focused || null,
    canBack: Boolean(focused),
    backLabel: "全部任务",
    hint: "点击扇区展开 ›",
    expandHint: "点击展开子类 ›",
    collapseHint: "点击收起子类",
    switchHint: "点击切换展开 ›",
    leafHint: "已是最末级",
    backHint: "",
    ariaLabel: `${productLabel(product)}数据量圆环`,
    onHover: (arc) => markLegend(legendEl, arc ? arc.key : null),
    onSelect: (node, arc) => {
      if (!node || arc.kind !== "base" || !(node.children || []).length) return;
      state.task = state.task === node.name ? null : node.name;
      renderVolumeVisual(product);
    },
    onBack: () => {
      state.task = null;
      renderVolumeVisual(product);
    },
  });

  renderVolumeLegend(product, tree, focused);
}

function renderVolume(product) {
  const src = getSrc(product);
  const total = maybeNumber(src.input.total);
  const tasks = taskList(product);
  const classified = tasks.reduce((n, t) => n + (t.value || 0), 0);
  const state = board.volume[product];
  // Open the highest-volume category on first render so the subcategory
  // composition is visible without requiring an exploratory click.
  if (!state.defaultExpanded && tasks.length) {
    state.task = tasks[0].name;
    state.defaultExpanded = true;
  }
  if (state.task && !tasks.some((t) => t.name === state.task)) state.task = null;

  const meta = $(isWc(product) ? "wcVolMeta" : "aiVolMeta");
  if (meta) meta.textContent = dateRange(src.input.date_range).replace(/^\d{4}-/, "");

  const stats = $(isWc(product) ? "wcVolStats" : "aiVolStats");
  if (stats) {
    const useClassified = classified > 0 && classified < total;
    stats.innerHTML = [
      ["体量", fmtBytes(src.input.bytes)],
      [useClassified ? "已归类" : "文件", useClassified ? fmt(classified) : fmt(src.input.files)],
      ["已评测", fmt(src.input.evaluated)],
    ]
      .map(([label, value]) => `<span>${label} <b>${value}</b></span>`)
      .join("");
  }
  renderVolumeVisual(product);
}

/* ------------------------------------------------------------- evaluation */

function renderEvalVersions(product) {
  const out = getSrc(product).output || {};
  const el = $(isWc(product) ? "wcModels" : "aiModels");
  if (!el) return;
  let rows;
  if (isWc(product)) {
    rows = ["a_expert", "a_fast", "b_expert", "b_fast"].map((key) => {
      const v = out.versions[key] || {};
      return {
        name: VERSION_DEFS[key].label,
        color: VERSION_DEFS[key].color(),
        answers: v.answers || 0,
        core: (out.meets_core && out.meets_core[key]) || 0,
        p50: v.p50 || 0,
        tokens: v.tokens || 0,
      };
    });
  } else {
    rows = ["fast", "expert"].map((key) => ({
      name: key,
      color: VERSION_DEFS[key].color(),
      answers: (out.by_model && out.by_model[key]) || 0,
      core: 0,
      p50: 0,
      tokens: 0,
    }));
  }

  const empty = !rows.some((r) => r.answers > 0);
  const section = el.closest(".eval-versions");
  if (section) section.classList.toggle("is-empty", empty);
  if (empty) {
    el.innerHTML = `<div class="ev-empty">评测输出待接入</div>`;
    return;
  }

  const hasCore = rows.some((r) => Number(r.core) > 0);
  const metricHead = section && section.querySelector(".eval-module-head span");
  if (metricHead) metricHead.textContent = hasCore ? "核心达成率" : "回答量";
  const maxAnswers = Math.max(1, ...rows.map((r) => Number(r.answers) || 0));

  el.innerHTML = rows
    .map(
      (r) => {
        const metric = hasCore ? Number(r.core) || 0 : Number(r.answers) || 0;
        const max = hasCore ? 100 : maxAnswers;
        const width = clamp(pct(metric, max), 0, 100);
        const display = hasCore ? `${metric.toFixed(1)}%` : `${fmt(metric)} 条`;
        const title = `${esc(r.name)} · ${fmt(r.answers)} 条回答 · 核心 ${r.core ? r.core.toFixed(1) + "%" : "—"} · P50 ${r.p50 ? r.p50.toFixed(1) + "s" : "—"} · Tokens ${fmtTokens(r.tokens)}`;
        return (
          `<div class="ev-row" style="--c:${r.color}" title="${title}">` +
            `<span class="ev-model"><i></i><span>${esc(r.name)}</span><em>${fmt(r.answers)} 条</em></span>` +
            `<span class="ev-meter" role="img" aria-label="${esc(r.name)} ${hasCore ? "核心达成率" : "回答量"} ${display}">` +
              `<span class="ev-meter-track"><i style="width:${width.toFixed(2)}%"></i></span>` +
              `<b>${display}</b>` +
            `</span>` +
          `</div>`
        );
      }
    )
    .join("") +
    (hasCore
      ? `<div class="ev-scale" aria-hidden="true"><span>0</span><span>50%</span><span>100%</span></div>`
      : "");
}

function renderDifficulty(product) {
  const el = $(isWc(product) ? "wcDifficulty" : "aiDifficulty");
  if (!el) return;
  const src = getSrc(product);
  const counts = {};
  let total = 0;
  Object.values((src.output && src.output.versions) || {}).forEach((v) => {
    Object.entries(v.difficulty || {}).forEach(([k, n]) => {
      counts[k] = (counts[k] || 0) + n;
      total += n;
    });
  });
  if (!total) {
    ((src.input && src.input.categories && src.input.categories.difficulty) || []).forEach((item) => {
      const count = Number(item.value) || 0;
      if (!count) return;
      counts[item.name] = (counts[item.name] || 0) + count;
      total += count;
    });
  }
  if (!total) {
    const totalEl = $(isWc(product) ? "wcDiffTotal" : "aiDiffTotal");
    if (totalEl) totalEl.textContent = "暂无数据";
    el.innerHTML = `<div class="diff-empty">难度标注待接入</div>`;
    return;
  }
  const order = ["简单", "中等", "困难", "复杂"];
  const colors = { 简单: T.wcMid, 中等: T.wc, 困难: T.bMid, 复杂: T.b };
  let cursor = 0;
  const stops = order.map((k) => {
    const from = cursor;
    cursor += pct(counts[k] || 0, total);
    return `${colors[k]} ${from.toFixed(2)}% ${cursor.toFixed(2)}%`;
  });
  const totalEl = $(isWc(product) ? "wcDiffTotal" : "aiDiffTotal");
  if (totalEl) totalEl.textContent = `${fmt(total)} 条`;
  el.innerHTML =
    `<div class="diff-layout">` +
      `<div class="diff-donut" role="img" aria-label="难度构成，共 ${fmt(total)} 条" style="--diff-gradient:conic-gradient(from -90deg, ${stops.join(",")})">` +
        `<span><b>${fmt(total)}</b><em>条评测</em></span>` +
      `</div>` +
      `<div class="diff-legend">` +
      order
        .map(
          (k) =>
            `<span title="${k} · ${fmt(counts[k] || 0)} 条 · ${pct(counts[k] || 0, total).toFixed(1)}%">` +
              `<i style="background:${colors[k]}"></i><em>${k}</em><b>${pct(counts[k] || 0, total).toFixed(0)}%</b><small>${fmt(counts[k] || 0)} 条</small>` +
            `</span>`
        )
        .join("") +
      `</div>` +
    `</div>`;
}

function outputP50(src) {
  if (src.output && src.output.p50) return Number(src.output.p50);
  const days = (src.output && src.output.per_day) || [];
  const withP50 = days.filter((d) => Number(d.p50) > 0);
  if (withP50.length) {
    const total = withP50.reduce((n, d) => n + Math.max(1, Number(d.answers) || 1), 0);
    return withP50.reduce((n, d) => n + Number(d.p50) * Math.max(1, Number(d.answers) || 1), 0) / total;
  }
  const versions = Object.values((src.output && src.output.versions) || {});
  const valid = versions.filter((v) => Number(v.p50) > 0);
  const total = valid.reduce((n, v) => n + Math.max(1, Number(v.answers) || 1), 0);
  if (!total) return 0;
  return valid.reduce((n, v) => n + Number(v.p50) * Math.max(1, Number(v.answers) || 1), 0) / total;
}

function renderEvalFacts(product) {
  const src = getSrc(product);
  const out = src.output || {};
  const p50 = outputP50(src);
  const el = $(isWc(product) ? "wcEvalStats" : "aiEvalStats");
  if (!el) return;
  el.innerHTML = [
    ["问题", fmt(out.problems || 0)],
    ["Tokens", fmtTokens(out.tokens || 0)],
    ["P50", p50 ? p50.toFixed(1) + "s" : "—"],
  ]
    .map(([label, value]) => `<span><em>${label}</em><b>${value}</b></span>`)
    .join("");
}

function renderEvaluation(product) {
  const wc = isWc(product);
  const src = getSrc(product);
  const out = src.output || {};
  const input = src.input;
  const evaluated = input.evaluated || 0;
  const pending = input.pending || 0;
  const total = input.total || 0;
  const cover = clamp(pct(evaluated, total), 0, 100);

  setNum(wc ? "wcEvaluated" : "aiEvaluated", evaluated);
  setNum(wc ? "wcCoverPct" : "aiCoverPct", cover, { decimals: 1, suffix: "%" });

  const inputTotal = $(wc ? "wcInputTotal" : "aiInputTotal");
  if (inputTotal) inputTotal.textContent = fmt(total);
  const done = $(wc ? "wcCoverDone" : "aiCoverDone");
  if (done) done.textContent = fmt(evaluated);
  const rest = $(wc ? "wcCoverPending" : "aiCoverPending");
  if (rest) rest.textContent = fmt(pending);
  const coverBar = $(wc ? "wcCoverBar" : "aiCoverBar");
  if (coverBar) {
    coverBar.style.setProperty("--coverage", `${cover.toFixed(2)}%`);
    coverBar.setAttribute(
      "aria-label",
      `评测覆盖率 ${cover.toFixed(1)}%，已评测 ${fmt(evaluated)} 条，共 ${fmt(total)} 条`
    );
  }

  const days = (out.per_day || []).filter((d) => Number(d.answers) > 0);
  const batchEl = $(wc ? "wcCoverBatch" : "aiCoverBatch");
  if (batchEl) {
    batchEl.textContent = days.length ? `${days[days.length - 1].date.slice(5)} 批次` : "输出待接入";
  }
  const meta = $(wc ? "wcEvalMeta" : "aiEvalMeta");
  if (meta) meta.textContent = "";

  renderEvalVersions(product);
  renderDifficulty(product);
  renderEvalFacts(product);
}

/* ----------------------------------------------------------- attribution */

function shortComp(name) {
  const s = String(name || "");
  const paren = s.match(/^其他工具（(.+)）$/);
  if (paren) return paren[1];
  const latin = s.match(/^[A-Za-z0-9_.-]+\s+(.+)$/);
  if (latin) return latin[1];
  return s;
}

function versionLabel(id) {
  return (VERSION_DEFS[id] && VERSION_DEFS[id].label) || id;
}

function buildSankey(product) {
  const src = getSrc(product);
  const out = src.output || {};
  const wc = isWc(product);
  const nodes = [];
  const links = [];
  const seen = new Set();
  const addNode = (name, display, color, col, tipMeta, labelPos) => {
    if (seen.has(name)) return;
    seen.add(name);
    nodes.push({
      name,
      display: display || name,
      depth: col,
      itemStyle: { color },
      label: { position: labelPos || (col === 0 ? "left" : "right") },
      tipMeta: tipMeta || "",
    });
  };

  if (wc) {
    const comp = src.components || {};
    const byVersion = out.components && out.components.by_version;
    if (byVersion && Object.keys(byVersion).length) {
      const versions = Object.keys(byVersion).filter((k) => VERSION_DEFS[k]);
      const totals = {};
      versions.forEach((id) => {
        Object.entries(byVersion[id] || {}).forEach(([name, value]) => {
          totals[name] = (totals[name] || 0) + (Number(value) || 0);
        });
      });
      const ranked = Object.entries(totals).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
      const top = ranked.slice(0, 6).map(([name]) => name);
      const extra = ranked.slice(6).map(([name]) => name);
      versions.forEach((id) => {
        const def = VERSION_DEFS[id];
        addNode(versionLabel(id), versionLabel(id), def.color(), 0, id);
      });
      top.forEach((name) => addNode(name, shortComp(name), T.mode === "dark" ? T.surface3 : T.track, 1, name, "right"));
      if (extra.length) addNode("其他环节", "其他环节", T.mode === "dark" ? T.surface3 : T.track, 1, `${extra.length} 类长尾`, "right");
      versions.forEach((id) => {
        const def = VERSION_DEFS[id];
        top.forEach((name) => {
          const value = Number((byVersion[id] || {})[name] || 0);
          if (value <= 0) return;
          links.push({ source: versionLabel(id), target: name, value, lineStyle: { color: hexA(def.color(), 0.42), opacity: 0.6 } });
        });
        if (extra.length) {
          const rest = extra.reduce((n, name) => n + Number((byVersion[id] || {})[name] || 0), 0);
          if (rest > 0) links.push({ source: versionLabel(id), target: "其他环节", value: rest, lineStyle: { color: hexA(def.color(), 0.42), opacity: 0.6 } });
        }
      });
      return { nodes, links, cols: 2, labels: ["版本", "环节"] };
    }
    const totalB = (comp.B || []).reduce((n, v) => n + v, 0);
    addNode("A 组", "A 组", C.a, 0, "A");
    if (totalB > 0) addNode("B 组", "B 组", C.b, 0, "B");
    (comp.names || []).forEach((name, i) => {
      const value = (comp.A[i] || 0) + (comp.B[i] || 0);
      if (value <= 0) return;
      addNode(name, shortComp(name), T.mode === "dark" ? T.surface3 : T.track, 1, name, "right");
    });
    (comp.names || []).forEach((name, i) => {
      if (!seen.has(name)) return;
      const a = comp.A[i] || 0;
      const b = comp.B[i] || 0;
      if (a > 0) links.push({ source: "A 组", target: name, value: a, lineStyle: { color: hexA(C.a, 0.42), opacity: 0.6 } });
      if (b > 0) links.push({ source: "B 组", target: name, value: b, lineStyle: { color: hexA(C.b, 0.42), opacity: 0.6 } });
    });
    return { nodes, links, cols: 2, labels: ["组别", "环节"] };
  }

  const comp = out.components || {};
  const names = [...(comp.names || [])];
  const models = ["fast", "expert"].filter((m) => (comp.by_model && comp.by_model[m]) || (comp[m] || []).length);
  const byModel = comp.by_model || {
    fast: Object.fromEntries(names.map((n, i) => [n, (comp.fast || [])[i] || 0])),
    expert: Object.fromEntries(names.map((n, i) => [n, (comp.expert || [])[i] || 0])),
  };
  const hasSeverity = Boolean(comp.severity_by_model && Object.keys(comp.severity_by_model).length);
  models.forEach((m) => addNode(m, m, VERSION_DEFS[m].color(), 0, m));
  names.forEach((name) => {
    const total = models.reduce((n, m) => n + Number((byModel[m] || {})[name] || 0), 0);
    if (total > 0) addNode(name, shortComp(name), T.mode === "dark" ? T.surface3 : T.track, 1, name, hasSeverity ? "top" : "right");
  });
  models.forEach((m) => {
    names.forEach((name) => {
      const value = Number((byModel[m] || {})[name] || 0);
      if (value <= 0) return;
      links.push({
        source: m,
        target: name,
        value,
        lineStyle: { color: hexA(VERSION_DEFS[m].color(), 0.36), opacity: 0.55 },
      });
    });
  });
  if (hasSeverity) {
    const sevTotals = {};
    AIME_SEVERITIES.forEach((s) => {
      sevTotals[s] = 0;
      models.forEach((m) => {
        names.forEach((name) => {
          sevTotals[s] += Number((((comp.severity_by_model[m] || {})[name] || {})[s]) || 0);
        });
      });
    });
    AIME_SEVERITIES.forEach((s) => {
      if (sevTotals[s] > 0) addNode(s, s, SEV_COLOR[s], 2, s);
    });
    names.forEach((name) => {
      AIME_SEVERITIES.forEach((s) => {
        let value = 0;
        models.forEach((m) => {
          value += Number((((comp.severity_by_model[m] || {})[name] || {})[s]) || 0);
        });
        if (value <= 0) return;
        links.push({
          source: name,
          target: s,
          value,
          lineStyle: { color: hexA(SEV_COLOR[s], 0.34), opacity: 0.52 },
        });
      });
    });
    return { nodes, links, cols: 3, labels: ["模型", "环节", "严重度"] };
  }
  return { nodes, links, cols: 2, labels: ["模型", "环节"] };
}

function sankeyOption(graph) {
  const { nodes, links, cols } = graph;
  return {
    animationDuration: REDUCED ? 0 : 650,
    animationEasing: "cubicOut",
    tooltip: {
      ...tip,
      formatter: (p) => {
        const color = (p.data && p.data.itemStyle && p.data.itemStyle.color) || T.muted;
        if (p.dataType === "edge") {
          const s = p.data.source;
          const t = p.data.target;
          return tipCard(
            tipHead(`${s} → ${t}`, fmt(p.value), color) +
              tipRow(color, "问题数", fmt(p.value))
          );
        }
        const d = p.data || {};
        return tipCard(
          tipHead(d.display || p.name, "", color) +
            tipRow(color, "问题数", fmt(p.value)) +
            (d.tipMeta ? `<div class="tip-path">${esc(d.tipMeta)}</div>` : "")
        );
      },
    },
    series: [
      {
        type: "sankey",
        left: 56,
        right: cols === 3 ? 58 : 92,
        top: 14,
        bottom: 2,
        nodeWidth: 8,
        nodeGap: 9,
        layoutIterations: 40,
        nodeAlign: "justify",
        draggable: false,
        data: nodes,
        links,
        lineStyle: { curveness: 0.55, opacity: 0.5 },
        itemStyle: { borderWidth: 0, borderRadius: 2 },
        label: {
          fontSize: 11,
          fontFamily: FONT,
          color: T.ink2,
          distance: 5,
          overflow: "truncate",
          formatter: (p) => (p.data && p.data.display) || p.name,
        },
        emphasis: {
          focus: "adjacency",
          lineStyle: { opacity: 0.8 },
          label: { fontWeight: 600 },
        },
      },
    ],
  };
}

function renderAttribution(product) {
  const wc = isWc(product);
  const src = getSrc(product);
  const out = src.output || {};
  const id = wc ? "wcAttr" : "aiAttr";
  const el = $(id);
  const graph = buildSankey(product);

  setNum(wc ? "wcProblems" : "aiProblems", out.problems || graph.links.reduce((n, l) => n + l.value, 0));

  if (!wc) {
    const chips = $("aiSevChips");
    if (chips) {
      chips.innerHTML = out.problems
        ? AIME_SEVERITIES.map((s) => {
            const share = pct((out.severity && out.severity[s]) || 0, out.problems || 1);
            return (
              `<span class="sev-chip"><i class="sev-dot" style="background:${SEV_COLOR[s]}"></i>` +
              `${s} <b>${share.toFixed(0)}%</b></span>`
            );
          }).join("")
        : "";
    }
  }

  if (!el) return;
  if (!graph.links.length) {
    showChartEmpty(el, "归因数据待接入");
    return;
  }
  el.innerHTML = "";
  createChart(el, sankeyOption(graph));
  el.style.removeProperty("cursor");
}

/* --------------------------------------------------------------- cluster */

function clusterValue(node) {
  return Number(node.value != null ? node.value : node.sessions || 0);
}

function decorateCluster(node, color, depth, parentPath, index = 0, siblings = 1) {
  const path = [...parentPath, node.name];
  const value = clusterValue(node);
  const level = depth + 1;
  const childMix = T.mode === "dark" ? "#ffffff" : T.surface;
  const mix = Math.min(0.48, 0.1 + depth * 0.06 + (siblings > 1 ? (index / (siblings - 1)) * 0.08 : 0));
  const out = {
    key: node.id || path.join("/"),
    clusterKey: node.id || path.join("/"),
    name: node.name,
    value,
    items: Number(node.items != null ? node.items : node.count || 0),
    depth: level,
    levelName: node.level_name || "",
    clusterPath: path,
    color: depth === 0 ? color : lerpColor(color, childMix, mix),
  };
  if (node.children && node.children.length) {
    out.children = node.children.map((c, i) =>
      decorateCluster(c, color, depth + 1, path, i, node.children.length)
    );
  }
  return out;
}

function clusterExpanded(product) {
  const st = board.cluster[product];
  if (!st || !st.expandedKey) return null;
  const current = clusterCurrent(product);
  return (current.children || []).find((node) => node.key === st.expandedKey) || null;
}

function clusterCurrent(product) {
  const st = board.cluster[product];
  return st.stack.length ? st.stack[st.stack.length - 1] : st.root;
}

function findClusterNode(root, key) {
  if (!root) return null;
  if (root.key === key || root.clusterKey === key) return root;
  for (const child of root.children || []) {
    const hit = findClusterNode(child, key);
    if (hit) return hit;
  }
  return null;
}

function renderClusterLegend(product, current, expanded) {
  const el = $(isWc(product) ? "wcClusterLegend" : "aiClusterLegend");
  if (!el) return;
  const scope = expanded || current;
  const rows = (scope && scope.children) || [];
  if (!rows.length) {
    el.innerHTML = `<div class="cl-empty">没有更细的聚类节点</div>`;
    return;
  }
  el.innerHTML = rows
    .map(
      (node) => {
        const expandable = Boolean((node.children || []).length);
        const tag = expandable ? "button" : "div";
        const attrs = expandable
          ? `type="button" aria-label="${esc(node.name)}，${fmt(node.value)} 会话"`
          : "";
        return `<${tag} class="rl-row" ${attrs} data-key="${esc(node.key)}" title="${esc(node.name)} · ${fmt(node.value)} 会话 · ${Number(node.share || 0).toFixed(1)}%">` +
        `<i class="rl-dot" style="background:${node.color}"></i>` +
        `<span class="rl-name">${esc(node.name)}</span>` +
        `<span class="rl-val">${fmt(node.value)}</span>` +
        `</${tag}>`;
      }
    )
    .join("");
  bindLegendHover(el, () => board.rings[product].cluster);
  el.onclick = (ev) => {
    const row = ev.target.closest(".rl-row");
    if (!row) return;
    const node = (scope.children || []).find((child) => child.key === row.dataset.key);
    if (!node) return;
    if (expanded) {
      if ((node.children || []).length) drillCluster(product, node);
      return;
    }
    if ((node.children || []).length) {
      const st = board.cluster[product];
      st.expandedKey = st.expandedKey === node.key ? "" : node.key;
      drawCluster(product);
    }
  };
}

function drawCluster(product) {
  const st = board.cluster[product];
  const current = clusterCurrent(product);
  const expanded = clusterExpanded(product);
  const chartEl = $(isWc(product) ? "wcCluster" : "aiCluster");
  const centerEl = $(isWc(product) ? "wcClusterCenter" : "aiClusterCenter");
  const legendEl = $(isWc(product) ? "wcClusterLegend" : "aiClusterLegend");
  const metaEl = $(isWc(product) ? "wcClusterMeta" : "aiClusterMeta");
  if (!chartEl || !current) return;

  if (metaEl) {
    const trail = [...st.stack, ...(expanded ? [expanded] : [])];
    const maxDepth = Number(st.meta.depth) || 4;
    metaEl.textContent = trail.length
      ? `L${(expanded || current).depth || 1} · ${["全部", ...trail.map((node) => node.name)].join(" / ")}`
      : `${maxDepth} 级聚类 · ${(current.children || []).length} 个分支`;
    metaEl.title = metaEl.textContent;
  }

  const rootTotal = (st.root && st.root.value) || current.value || 1;
  board.rings[product].cluster = createRing(chartEl, centerEl, {
    root: current,
    expandedKey: expanded ? expanded.key : "",
    unit: "会话",
    restValue: current.value,
    restLabel: "会话",
    shareTotal: rootTotal,
    centerNode: expanded || (st.stack.length ? current : null),
    canBack: Boolean(expanded) || st.stack.length > 0,
    backLabel: expanded ? "收起" : "上一层",
    hint: "点击扇区展开 ›",
    expandHint: "点击展开子集 ›",
    collapseHint: "点击收起子集",
    switchHint: "点击切换展开 ›",
    burstHint: "点击进入下一层 ›",
    leafHint: "已是最末级",
    backHint: "",
    leafInteractive: false,
    burstInteractive: true,
    ariaLabel: `${productLabel(product)}聚类体系`,
    onHover: (arc) => markLegend(legendEl, arc ? arc.key : null),
    onSelect: (node, arc) => {
      if (!node) return;
      if (arc.kind === "base") {
        if ((node.children || []).length) {
          st.expandedKey = st.expandedKey === node.key ? "" : node.key;
          drawCluster(product);
        }
        return;
      }
      if ((node.children || []).length) drillCluster(product, node);
    },
    onBack: () => {
      if (st.expandedKey) {
        st.expandedKey = "";
        drawCluster(product);
        return;
      }
      st.stack.pop();
      drawCluster(product);
    },
  });

  const statsNode = expanded || current;
  const stats = $(isWc(product) ? "wcClusterStats" : "aiClusterStats");
  if (stats) stats.innerHTML = `<span>${fmt(statsNode.items || 0)} <em>条目</em></span>`;
  renderClusterLegend(product, current, expanded);

}

function drillCluster(product, node) {
  const st = board.cluster[product];
  st.expandedKey = "";
  if (!node || node === st.root) {
    st.stack = [];
    drawCluster(product);
    return;
  }
  const path = [];
  const walk = (cur, trail) => {
    if (cur === node) {
      path.splice(0, path.length, ...trail);
      return true;
    }
    for (const child of cur.children || []) {
      if (walk(child, [...trail, child])) return true;
    }
    return false;
  };
  if (walk(st.root, [])) {
    st.stack = path;
    drawCluster(product);
  }
}

function renderCluster(product) {
  const wc = isWc(product);
  const src = getSrc(product);
  const cl = src.cluster;
  const meta = (cl && cl.meta) || {};
  const root = (cl && cl.tree) || null;
  const base = board.cluster[product];
  const stackKey = base.stack.length ? base.stack[base.stack.length - 1].key : "";
  const expandedKey = base.expandedKey || "";
  board.cluster[product] = { src, root: null, meta, stack: [], expandedKey: "" };

  const chartEl = $(wc ? "wcCluster" : "aiCluster");
  const centerEl = $(wc ? "wcClusterCenter" : "aiClusterCenter");
  const metaEl = $(wc ? "wcClusterMeta" : "aiClusterMeta");
  if (metaEl) metaEl.textContent = "";

  if (!root || !clusterValue(root)) {
    if (chartEl) showChartEmpty(chartEl, "聚类数据待接入");
    if (centerEl) {
      centerEl.innerHTML = "";
      centerEl.hidden = true;
    }
    const legend = $(wc ? "wcClusterLegend" : "aiClusterLegend");
    if (legend) legend.innerHTML = "";
    const stats = $(wc ? "wcClusterStats" : "aiClusterStats");
    if (stats) stats.textContent = "";
    return;
  }
  if (centerEl) centerEl.hidden = false;

  const rootKids = root.children || [];
  const colorMap = paletteByName(rootKids.map((child) => child.name));
  const total = clusterValue(root);
  const prepared = {
    key: "cluster-root",
    clusterKey: "cluster-root",
    name: root.name,
    value: total,
    items: Number(root.items != null ? root.items : root.count || 0),
    depth: 0,
    levelName: "根节点",
    clusterPath: [root.name],
    color: ringPalette(1)[0],
    children: rootKids.map((child) =>
      decorateCluster(child, colorMap.get(child.name) || T.cl1, 0, [])
    ),
  };
  const setShare = (node) => {
    node.share = pct(node.value, total);
    (node.children || []).forEach(setShare);
  };
  setShare(prepared);
  board.cluster[product].root = prepared;

  if (stackKey) {
    const node = findClusterNode(prepared, stackKey);
    if (node && node !== prepared) {
      const path = [];
      const walk = (cur, trail) => {
        if (cur === node) {
          path.push(...trail);
          return true;
        }
        for (const child of cur.children || []) {
          if (walk(child, [...trail, child])) return true;
        }
        return false;
      };
      walk(prepared, []);
      board.cluster[product].stack = path.filter((n) => n !== prepared);
    }
  }

  if (expandedKey) {
    const current = clusterCurrent(product);
    const restored = (current.children || []).some((node) => node.key === expandedKey);
    if (restored) board.cluster[product].expandedKey = expandedKey;
  }

  drawCluster(product);
}

/* ------------------------------------------------------------ prediction */

const PRED_MOCK = {
  wencai: {
    share: 0.128,
    reviewRatio: 0.859,
    errorRate: 0.19,
    total: 312,
    inputTotal: 2400,
    reviewed: 268,
    pending: 44,
    days: [
      ["10-10", 8], ["10-11", 12], ["10-12", 15], ["10-13", 10], ["10-14", 18],
      ["10-15", 22], ["10-16", 14], ["10-17", 26], ["10-18", 20], ["10-19", 18],
      ["10-20", 24], ["10-21", 16], ["10-22", 22], ["10-23", 43],
    ],
    trend: {
      dates: ["09-04", "09-11", "09-18", "09-25", "10-02", "10-09", "10-16", "10-23"],
      models: [
        { key: "a_expert", values: [58, 61, 60, 64, 66, 68, 71, 74] },
        { key: "a_fast", values: [55, 57, 59, 58, 62, 64, 65, 69] },
        { key: "b_expert", values: [52, 55, 54, 58, 57, 61, 63, 66] },
        { key: "b_fast", values: [49, 51, 52, 54, 56, 55, 58, 60] },
      ],
    },
    attribution: {
      models: ["a_expert", "a_fast", "b_expert", "b_fast"],
      errors: ["方向错误", "依据不足", "幅度偏差", "过度自信", "时点错配"],
      flows: {
        a_expert: [42, 32, 20, 18, 6],
        a_fast: [34, 26, 18, 16, 10],
        b_expert: [22, 22, 18, 18, 10],
        b_fast: [18, 18, 14, 12, 16],
      },
    },
  },
  aime: {
    share: 0.124,
    reviewRatio: 0.717,
    errorRate: 0.21,
    total: 2146,
    inputTotal: 17243,
    reviewed: 1538,
    pending: 608,
    days: [
      ["10-18", 62], ["10-19", 74], ["10-20", 88], ["10-21", 96], ["10-22", 110],
      ["10-23", 120], ["10-24", 104], ["10-25", 132], ["10-26", 118], ["10-27", 126],
      ["10-28", 140], ["10-29", 112], ["10-30", 128], ["10-31", 128],
    ],
    trend: {
      dates: ["09-12", "09-19", "09-26", "10-03", "10-10", "10-17", "10-24", "10-31"],
      models: [
        { key: "fast", values: [63, 65, 64, 68, 70, 69, 72, 74] },
        { key: "expert", values: [67, 69, 71, 70, 74, 76, 75, 78] },
      ],
    },
    attribution: {
      models: ["fast", "expert"],
      errors: ["抽取错误", "方向错误", "幅度偏差", "依据不足"],
      flows: {
        fast: [28, 28, 24, 40],
        expert: [22, 26, 22, 40],
      },
    },
  },
};

const PRED_ERROR_COLORS = () => [T.sev0, T.sev1, T.sev2, T.sev3, T.cl4];

function predMock(product) {
  const base = PRED_MOCK[product];
  const src = getSrc(product);
  const inputTotal = maybeNumber(src.input && src.input.total) || base.inputTotal;
  const total = Math.max(1, Math.round(inputTotal * base.share));
  const reviewed = Math.min(total, Math.round(total * base.reviewRatio));
  const pending = Math.max(0, total - reviewed);
  const sourceDays = ((src.input && src.input.per_day) || []).slice(-14);
  const weights = sourceDays.map((day) => Math.max(1, Number(day.value ?? day.answers ?? 0)));
  const weightTotal = weights.reduce((n, value) => n + value, 0) || 1;
  let remaining = reviewed;
  const days = sourceDays.map((day, index) => {
    const value = index === sourceDays.length - 1
      ? remaining
      : Math.min(remaining, Math.round((reviewed * weights[index]) / weightTotal));
    remaining -= value;
    return [String(day.date || "").slice(5), Math.max(0, value)];
  });

  const sourceFlows = base.attribution && base.attribution.flows ? base.attribution.flows : {};
  const flowSum = Object.values(sourceFlows).reduce(
    (sum, row) => sum + row.reduce((n, value) => n + (Number(value) || 0), 0),
    0
  ) || 1;
  const errorTarget = Math.max(1, Math.round(reviewed * base.errorRate));
  const ratio = errorTarget / flowSum;
  let allocatedErrors = 0;
  const flatEntries = Object.entries(sourceFlows).flatMap(([model, row]) => row.map((value, index) => [model, index, value]));
  const flows = Object.fromEntries(Object.keys(sourceFlows).map((model) => [model, sourceFlows[model].map(() => 0)]));
  flatEntries.forEach(([model, index, value], position) => {
    const next = position === flatEntries.length - 1
      ? errorTarget - allocatedErrors
      : Math.round(value * ratio);
    flows[model][index] = Math.max(0, next);
    allocatedErrors += next;
  });

  return {
    ...base,
    total,
    inputTotal,
    reviewed,
    pending,
    days: days.length ? days : base.days,
    attribution: base.attribution ? { ...base.attribution, flows } : base.attribution,
  };
}

function predStats(el, rows) {
  if (!el) return;
  el.innerHTML = rows
    .map(
      ([label, value, color]) =>
        `<span class="predict-stat${color ? " has-dot" : ""}">` +
        `${color ? `<i style="background:${color}"></i>` : ""}` +
        `<em>${esc(label)}</em><b title="${esc(String(value))}">${value}</b></span>`
    )
    .join("");
}

function predErrorTotals(product) {
  const m = predMock(product).attribution;
  const totals = {};
  m.errors.forEach((error, i) => {
    totals[error] = m.models.reduce(
      (n, key) => n + (Number((m.flows[key] || [])[i]) || 0),
      0
    );
  });
  return totals;
}

function predSankey(product) {
  const m = predMock(product).attribution;
  const modelColors = Object.fromEntries(m.models.map((key) => [key, VERSION_DEFS[key].color()]));
  const errorColors = PRED_ERROR_COLORS();
  const errorColor = Object.fromEntries(m.errors.map((e, i) => [e, errorColors[i % errorColors.length]]));
  const nodes = [];
  const links = [];
  m.models.forEach((key) => {
    nodes.push({
      name: VERSION_DEFS[key].label,
      display: VERSION_DEFS[key].label,
      itemStyle: { color: modelColors[key] },
      label: { position: "left", width: 48 },
    });
  });
  m.errors.forEach((error) => {
    nodes.push({
      name: error,
      display: error,
      itemStyle: { color: errorColor[error] },
      label: { position: "right" },
    });
  });
  m.models.forEach((key) => {
    const label = VERSION_DEFS[key].label;
    m.errors.forEach((error, i) => {
      const value = Number((m.flows[key] || [])[i]) || 0;
      if (value <= 0) return;
      links.push({
        source: label,
        target: error,
        value,
        lineStyle: { color: hexA(modelColors[key], 0.4), opacity: 0.55 },
      });
    });
  });
  return { nodes, links };
}

function renderPredReview(product, chartEl) {
  const m = predMock(product);
  const cumulative = [];
  const daily = [];
  let running = 0;
  m.days.forEach(([date, value]) => {
    running += Number(value) || 0;
    daily.push([date, Number(value) || 0]);
    cumulative.push([date, running]);
  });
  const pace = m.days.map(([date], i) => [date, m.total * ((i + 1) / m.days.length)]);
  const peak = daily.reduce((best, row) => (row[1] > best[1] ? row : best), daily[0] || ["—", 0]);
  const avg = m.reviewed / Math.max(1, daily.length);

  createChart(chartEl, {
    animationDuration: REDUCED ? 0 : 620,
    animationEasing: "cubicOut",
    tooltip: {
      ...tip,
      trigger: "axis",
      axisPointer: { type: "line", lineStyle: { color: T.hairline } },
      formatter: (params) => {
        const p = params[0];
        const date = p ? p.axisValue : "";
        const day = daily.find((row) => row[0] === date);
        const cumulativePoint = cumulative.find((row) => row[0] === date);
        const pacePoint = pace.find((row) => row[0] === date);
        return tipCard(
          tipHead(date, "评阅完成曲线", T.forecast) +
            tipRow(T.forecast, "累计完成", `${fmt(cumulativePoint ? cumulativePoint[1] : 0)} / ${fmt(m.total)}`) +
            tipRow(T.faint, "均速参考", `${fmt(Math.round(pacePoint ? pacePoint[1] : 0))} 题`) +
            tipRow(T.muted, "当日评阅", `${fmt(day ? day[1] : 0)} 题`)
        );
      },
    },
    grid: { left: 38, right: 46, top: 18, bottom: 24 },
    xAxis: {
      type: "category",
      data: m.days.map(([date]) => date),
      boundaryGap: false,
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { fontSize: 11, color: T.faint, fontFamily: FONT, interval: 2, margin: 8 },
    },
    yAxis: {
      type: "value",
      min: 0,
      max: m.total,
      splitNumber: 3,
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { fontSize: 11, color: T.faint, fontFamily: FONT },
      splitLine: { lineStyle: { color: T.hairline, type: "solid" } },
    },
    series: [
      {
        name: "均速参考",
        type: "line",
        data: pace.map(([, value]) => Math.round(value)),
        symbol: "none",
        lineStyle: { width: 1, color: T.faint, type: "dashed" },
        silent: true,
      },
      {
        name: "累计完成",
        type: "line",
        data: cumulative.map(([, value]) => value),
        smooth: 0.22,
        symbol: "circle",
        symbolSize: 5,
        showSymbol: false,
        lineStyle: { width: 2.2, color: T.forecast },
        itemStyle: { color: T.forecast, borderColor: T.surface, borderWidth: 2 },
        areaStyle: {
          color: {
            type: "linear",
            x: 0,
            y: 0,
            x2: 0,
            y2: 1,
            colorStops: [
              { offset: 0, color: hexA(T.forecast, 0.2) },
              { offset: 1, color: hexA(T.forecast, 0) },
            ],
          },
        },
        emphasis: { focus: "series" },
        endLabel: {
          show: true,
          formatter: `{c}`,
          color: T.ink,
          fontSize: 11,
          fontWeight: 600,
          offset: [4, 0],
        },
      },
    ],
  });
  predStats($(isWc(product) ? "wcForecastStats" : "aiForecastStats"), [
    ["日均", `${avg.toFixed(1)} 题`],
    ["峰值日", `${peak[0]} · ${fmt(peak[1])} 题`],
    ["剩余", `${fmt(m.pending)} 题`],
  ]);
}

function renderPredCapability(product, chartEl) {
  const m = predMock(product).trend;
  const allValues = m.models.flatMap((model) => model.values);
  const minValue = Math.max(0, Math.floor((Math.min(...allValues) - 3) / 5) * 5);
  const maxValue = Math.ceil((Math.max(...allValues) + 2) / 5) * 5;
  const avgLine = allValues.reduce((n, value) => n + value, 0) / Math.max(1, allValues.length);
  const series = m.models.map((model) => {
    const color = VERSION_DEFS[model.key].color();
    return {
      name: VERSION_DEFS[model.key].label,
      type: "line",
      data: model.values,
      smooth: 0.24,
      symbol: "circle",
      symbolSize: 6,
      showSymbol: true,
      lineStyle: { width: 2, color },
      itemStyle: { color, borderColor: T.surface, borderWidth: 2 },
      emphasis: { focus: "series" },
      endLabel: {
        show: true,
        formatter: (p) => `${p.seriesName} ${p.value}%`,
        color,
        fontSize: 11,
        fontWeight: 600,
        offset: [5, 0],
      },
    };
  });
  createChart(chartEl, {
    animationDuration: REDUCED ? 0 : 650,
    animationEasing: "cubicOut",
    tooltip: {
      ...tip,
      trigger: "axis",
      axisPointer: { type: "line", lineStyle: { color: T.hairline } },
      formatter: (params) =>
        tipCard(
          tipHead(params[0] ? params[0].axisValue : "", "预测准确率", T.forecast) +
            params
              .slice()
              .sort((a, b) => (b.value || 0) - (a.value || 0))
              .map((p) => tipRow(p.color, p.seriesName, `${Number(p.value).toFixed(0)}%`))
              .join("")
        ),
    },
    legend: {
      top: 2,
      left: 2,
      itemWidth: 8,
      itemHeight: 8,
      icon: "circle",
      itemGap: 12,
      textStyle: { fontSize: 11, color: T.muted, fontFamily: FONT },
    },
    grid: { left: 36, right: 76, top: 30, bottom: 24 },
    xAxis: {
      type: "category",
      data: m.dates,
      boundaryGap: false,
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { fontSize: 11, color: T.faint, fontFamily: FONT, interval: 1, margin: 8 },
    },
    yAxis: {
      type: "value",
      min: minValue,
      max: maxValue,
      splitNumber: 3,
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { fontSize: 11, color: T.faint, fontFamily: FONT, formatter: "{value}%" },
      splitLine: { lineStyle: { color: T.hairline, type: "solid" } },
    },
    series: series.map((item, index) => index === 0 ? {
      ...item,
      markLine: {
        silent: true,
        symbol: "none",
        lineStyle: { color: T.hairline, type: "dashed" },
        label: { show: false },
        data: [{ yAxis: Number(avgLine.toFixed(1)) }],
      },
    } : item),
  });

  const latest = m.models.map((model) => ({
    key: model.key,
    name: VERSION_DEFS[model.key].label,
    value: model.values[model.values.length - 1],
    prev: model.values[model.values.length - 2] || model.values[model.values.length - 1],
  }));
  const best = latest.reduce((a, b) => (b.value >= a.value ? b : a), latest[0]);
  const avg = latest.reduce((n, x) => n + x.value, 0) / Math.max(1, latest.length);
  const delta = best.value - best.prev;
  predStats($(isWc(product) ? "wcForecastStats" : "aiForecastStats"), [
    ["最佳模型", `${best.name} ${best.value}%`],
    ["模型均值", `${avg.toFixed(1)}%`],
    ["较上期", `${delta >= 0 ? "+" : ""}${delta.toFixed(0)}pp`],
  ]);
}

function renderPredAttribution(product, chartEl) {
  const graph = predSankey(product);
  const foot = $(isWc(product) ? "wcForecastStats" : "aiForecastStats");
  const totals = predErrorTotals(product);
  const total = graph.links.filter((l) => totals[l.target] != null).reduce((n, l) => n + l.value, 0);
  const top = Object.entries(totals).sort((a, b) => b[1] - a[1])[0] || ["—", 0];
  const modelCount = predMock(product).attribution.models.length;
  const baseStats = () => [
    ["主因", `${top[0]} ${pct(top[1], total).toFixed(1)}%`],
    ["错误项合计", fmt(total)],
    ["涉及模型", `${modelCount} 个`],
  ];
  predStats(foot, baseStats());

  const chart = createChart(chartEl, {
    animationDuration: REDUCED ? 0 : 650,
    animationEasing: "cubicOut",
    tooltip: {
      ...tip,
      formatter: (p) => {
        if (p.dataType === "edge") {
          return tipCard(
            tipHead(`${p.data.source} → ${p.data.target}`, fmt(p.value), T.forecast) +
              tipRow(T.forecast, "错误数", fmt(p.value))
          );
        }
        return tipCard(tipHead(p.name, "", T.forecast) + tipRow(T.forecast, "错误数", fmt(p.value)));
      },
    },
    series: [
      {
        type: "sankey",
        left: 62,
        right: 70,
        top: 8,
        bottom: 2,
        nodeWidth: 8,
        nodeGap: 12,
        layoutIterations: 32,
        nodeAlign: "justify",
        draggable: false,
        data: graph.nodes,
        links: graph.links,
        lineStyle: { curveness: 0.55, opacity: 0.5 },
        itemStyle: { borderWidth: 0, borderRadius: 2 },
        label: {
          fontSize: 11,
          fontFamily: FONT,
          color: T.ink2,
          distance: 4,
          overflow: "truncate",
          formatter: (p) => (p.data && p.data.display) || p.name,
        },
        emphasis: { focus: "adjacency", lineStyle: { opacity: 0.8 } },
      },
    ],
  });
  if (chart) {
    chart.on("click", (p) => {
      const label = p.dataType === "edge" ? `${p.data.source} → ${p.data.target}` : p.name;
      predStats(foot, [
        ["已选", label],
        ["错误数", fmt(p.value)],
        ["错误项合计", fmt(total)],
      ]);
    });
    chartEl.style.cursor = "pointer";
  }
}

function renderPrediction(product) {
  const wc = isWc(product);
  const m = predMock(product);
  const dim = board.predict[product].dim;
  const tabs = $(wc ? "wcPredictTabs" : "aiPredictTabs");
  if (tabs) {
    tabs.querySelectorAll(".predict-tab").forEach((tab) => {
      const on = tab.dataset.dim === dim;
      tab.classList.toggle("is-active", on);
      tab.setAttribute("aria-selected", String(on));
    });
  }

  setNum(wc ? "wcPredTotal" : "aiPredTotal", m.total);
  const share = pct(m.total, m.inputTotal);
  const shareEl = $(wc ? "wcPredShare" : "aiPredShare");
  if (shareEl) shareEl.textContent = `占全部 ${share.toFixed(1)}%`;
  const reviewed = $(wc ? "wcPredReviewed" : "aiPredReviewed");
  if (reviewed) reviewed.textContent = fmt(m.reviewed);
  const pending = $(wc ? "wcPredPending" : "aiPredPending");
  if (pending) pending.textContent = fmt(m.pending);
  const reviewProgress = clamp(pct(m.reviewed, m.total), 0, 100);
  const gauge = $(wc ? "wcPredGauge" : "aiPredGauge");
  if (gauge) {
    gauge.style.setProperty("--progress", `${reviewProgress.toFixed(2)}%`);
    gauge.setAttribute(
      "aria-label",
      `预测题评阅进度 ${reviewProgress.toFixed(1)}%，已评阅 ${fmt(m.reviewed)} 题，共 ${fmt(m.total)} 题`
    );
  }
  setNum(wc ? "wcPredGaugeText" : "aiPredGaugeText", reviewProgress, { decimals: 1, suffix: "%" });

  const chartEl = $(wc ? "wcForecastChart" : "aiForecastChart");
  if (!chartEl) return;
  const dimLabel = { review: "预测题评阅数据", capability: "预测能力趋势", attribution: "预测归因" }[dim];
  chartEl.setAttribute("aria-label", `${productLabel(product)}${dimLabel}`);
  chartEl.innerHTML = "";
  chartEl.style.cursor = "default";
  if (dim === "review") renderPredReview(product, chartEl);
  else if (dim === "capability") renderPredCapability(product, chartEl);
  else renderPredAttribution(product, chartEl);
}

function bindPredictTabs(product) {
  const tabs = $(isWc(product) ? "wcPredictTabs" : "aiPredictTabs");
  if (!tabs) return;
  const order = ["review", "capability", "attribution"];
  tabs.onclick = (ev) => {
    const tab = ev.target.closest(".predict-tab");
    if (!tab) return;
    board.predict[product].dim = tab.dataset.dim;
    renderPrediction(product);
  };
  tabs.onkeydown = (ev) => {
    if (ev.key !== "ArrowLeft" && ev.key !== "ArrowRight") return;
    ev.preventDefault();
    const i = order.indexOf(board.predict[product].dim);
    const next = order[(i + (ev.key === "ArrowRight" ? 1 : order.length - 1)) % order.length];
    board.predict[product].dim = next;
    renderPrediction(product);
    const tab = tabs.querySelector(`.predict-tab[data-dim="${next}"]`);
    if (tab) tab.focus();
  };
}

/* ------------------------------------------------------------------ page */

function renderProduct(product) {
  renderVolume(product);
  renderEvaluation(product);
  renderAttribution(product);
  renderCluster(product);
  renderPrediction(product);
  // A product rendered after the reveal must write its final counters itself;
  // otherwise the lazy page shows the initial "0" placeholders.
  settleCounters(document.querySelector(`.view--data .page[data-product="${product}"]`) || document);
  board.rendered[product] = true;
}

function renderedProducts() {
  return ["wencai", "aime"].filter((product) => board.rendered[product]);
}

export function initBoard(data, opts = {}) {
  board.data = data;
  board.product = ["wencai", "aime"].includes(opts.product) ? opts.product : "wencai";
  board.rendered = { wencai: false, aime: false };
  readTokens();
  bindPredictTabs("wencai");
  bindPredictTabs("aime");
  // Render only the product that is visible now. The other one is rendered on
  // its first switch, so a cold data view does half the chart work.
  renderProduct(board.product);
}

export function setBoardProduct(product) {
  if (!["wencai", "aime"].includes(product)) return;
  board.product = product;
  document.querySelectorAll(".view--data .page").forEach((page) => {
    const on = page.dataset.product === product;
    page.classList.toggle("is-active", on);
    page.setAttribute("aria-hidden", String(!on));
  });
  if (!board.rendered[product]) renderProduct(product);
  resizeAllCharts();
}

export function refreshBoard() {
  readTokens();
  const products = renderedProducts();
  (products.length ? products : [board.product]).forEach(renderProduct);
}

export function resizeBoard() {
  resizeAllCharts();
}

export function getBoardProduct() {
  return board.product;
}
