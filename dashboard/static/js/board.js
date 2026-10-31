/* Data board: volume rings, evaluation blocks, attribution Sankey, cluster tree and 3-part forecast. */
import {
  $, FONT, REDUCED, fmt, fmtFixed, pct, clamp, fmtBytes, fmtTokens, dateRange, esc,
  lerpColor, hexA, labelOn, readTokens, T, C, SEV_COLOR, AIME_SEVERITIES, tip, tipCard,
  tipHead, tipRow, createChart, setNum, animateTo, tweenNumber, resizeAllCharts,
} from "./core.js";

const board = {
  data: null,
  opts: {},
  product: "wencai",
  volume: { wencai: { src: null, task: null, initialized: false }, aime: { src: null, task: null, initialized: false } },
  cluster: { wencai: { src: null, root: null, meta: {}, stack: [] }, aime: { src: null, root: null, meta: {}, stack: [] } },
  predict: { wencai: { dim: "volume" }, aime: { dim: "volume" } },
  clusterCharts: {},
};

const VERSION_DEFS = {
  a_expert: { label: "A·expert", color: () => T.wc, group: "A" },
  a_fast: { label: "A·fast", color: () => T.wcMid, group: "A" },
  b_expert: { label: "B·expert", color: () => T.b, group: "B" },
  b_fast: { label: "B·fast", color: () => T.bMid, group: "B" },
  fast: { label: "fast", color: () => T.aiMid, group: "AI" },
  expert: { label: "expert", color: () => T.ai, group: "AI" },
};

const TASK_COLORS = () => [
  T.wc, "#0ea5e9", "#f59e0b", "#8b5cf6", "#ef4444", "#14b8a6",
  "#6366f1", "#84cc16", "#ec4899", "#64748b", "#f97316", "#06b6d4",
];

const AIME_TASK_COLORS = () => [
  T.ai, "#0ea5e9", "#f59e0b", "#8b5cf6", "#ef4444", "#14b8a6",
  "#6366f1", "#84cc16", "#ec4899", "#64748b", "#f97316", "#06b6d4",
];

const isWc = (product) => product === "wencai";
const getSrc = (product) => (isWc(product) ? board.data.wencai : board.data.aime);
const taskPalette = (product) => (isWc(product) ? TASK_COLORS() : AIME_TASK_COLORS());

function recall(detail) {
  const d = { product: board.product, ...(detail || {}) };
  if (board.opts && board.opts.onRecall) board.opts.onRecall(d);
  else window.dispatchEvent(new CustomEvent("eval:recall", { detail: d }));
}

function emptyInto(el, text) {
  if (!el) return;
  el.innerHTML = `<div class="empty-state"><span class="empty-mark">∅</span><p>${esc(text)}</p></div>`;
}

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

/* ----------------------------------------------------------------- volume */

function volumeTotal(product) {
  const src = getSrc(product);
  return src.input.total || taskList(product).reduce((n, t) => n + (t.value || 0), 0) || 1;
}

function ringNode(product, task, i) {
  const pal = taskPalette(product);
  const total = volumeTotal(product);
  const color = pal[i % pal.length];
  const selected = board.volume[product].task;
  const dark = document.documentElement.dataset.mode === "dark";
  const node = {
    name: task.name,
    value: task.value,
    taskName: task.name,
    ringLevel: 0,
    share: pct(task.value, total),
    itemStyle: { color },
    label: { color: labelOn(color) },
  };
  if (selected === task.name) {
    const fold = 6;
    let subs = taskSubs(product, task.name);
    if (subs.length > fold) {
      const head = subs.slice(0, fold);
      const rest = subs.slice(fold).reduce((n, c) => n + c.value, 0);
      if (rest > 0) head.push({ name: "其他", value: rest });
      subs = head;
    }
    node.children = subs.map((s, j) => ({
      name: s.name,
      value: s.value,
      taskName: task.name,
      ringLevel: 1,
      share: pct(s.value, total),
      itemStyle: { color: lerpColor(color, T.surface, dark ? 0.42 : 0.22 + j * 0.045) },
      label: { color: T.ink2 },
    }));
  }
  return node;
}

function renderVolumeLegend(product) {
  const el = $(isWc(product) ? "wcVolumeLegend" : "aiVolumeLegend");
  if (!el) return;
  const tasks = taskList(product);
  const total = volumeTotal(product);
  const selected = tasks.find((t) => t.name === board.volume[product].task);
  const pal = taskPalette(product);
  if (selected) {
    const subs = taskSubs(product, selected.name).sort((a, b) => b.value - a.value);
    const subTotal = selected.value || subs.reduce((n, c) => n + c.value, 0) || 1;
    const selectedIndex = tasks.findIndex((t) => t.name === selected.name);
    const baseColor = pal[Math.max(0, selectedIndex) % pal.length];
    el.innerHTML =
      `<div class="vr-head"><span>${esc(selected.name)} · 子类</span><span>条数</span><span>占比</span></div>` +
      subs
        .map(
          (x, i) =>
            `<div class="vr-row is-static" title="${esc(x.name)} · ${fmt(x.value)} 条 · ${pct(x.value, subTotal).toFixed(1)}%">` +
            `<i class="vr-dot" style="background:${lerpColor(baseColor, T.surface, 0.22 + i * 0.06)}"></i>` +
            `<span class="vr-name">${esc(x.name)}</span>` +
            `<span class="vr-val">${fmt(x.value)}</span>` +
            `<span class="vr-pct">${pct(x.value, subTotal).toFixed(1)}%</span>` +
            `</div>`
        )
        .join("");
    el.onclick = null;
    return;
  }
  el.innerHTML =
    `<div class="vr-head"><span>任务</span><span>条数</span><span>占比</span></div>` +
    tasks
      .map(
        (t, i) =>
          `<button class="vr-row${selected === t.name ? " is-active" : ""}" type="button" data-task="${esc(t.name)}" title="${esc(t.name)} · ${fmt(t.value)} 条 · ${pct(t.value, total).toFixed(1)}%">` +
          `<i class="vr-dot" style="background:${pal[i % pal.length]}"></i>` +
          `<span class="vr-name">${esc(t.name)}</span>` +
          `<span class="vr-val">${fmt(t.value)}</span>` +
          `<span class="vr-pct">${pct(t.value, total).toFixed(1)}%</span>` +
          `</button>`
      )
      .join("");
  el.onclick = (ev) => {
    const row = ev.target.closest(".vr-row");
    if (!row) return;
    const task = row.dataset.task;
    board.volume[product].task = board.volume[product].task === task ? null : task;
    renderVolumeVisual(product);
  };
}

function renderVolumeVisual(product) {
  const wc = isWc(product);
  const total = volumeTotal(product);
  const tasks = taskList(product);
  const selected = tasks.find((t) => t.name === board.volume[product].task);
  if (!selected) board.volume[product].task = null;
  const current = selected ? selected.value : total;

  const valueEl = $(wc ? "wcRingValue" : "aiRingValue");
  const labelEl = $(wc ? "wcRingLabel" : "aiRingLabel");
  if (valueEl) valueEl.textContent = fmt(current);
  if (labelEl) {
    labelEl.textContent = selected ? selected.name : "条输入";
    labelEl.title = selected ? selected.name : "全部任务";
  }

  const note = $(wc ? "wcVolNote" : "aiVolNote");
  const back = $(wc ? "wcVolBack" : "aiVolBack");
  const right = $(wc ? "wcVolMax" : "aiVolMax");
  if (back) back.hidden = !selected;
  if (note) note.textContent = selected ? selected.name : "内环任务 · 点击展开子类";
  if (right) {
    right.innerHTML = selected
      ? `${fmt(selected.value)} <span>条 · ${pct(selected.value, total).toFixed(1)}%</span>`
      : (() => {
          const top = tasks[0];
          return top ? `最大类 ${esc(top.name)} <b>${pct(top.value, total).toFixed(1)}%</b>` : "—";
        })();
  }

  renderVolumeLegend(product);

  const el = $(wc ? "wcTaskChart" : "aiTaskChart");
  if (!el) return;
  if (!tasks.length) {
    showChartEmpty(el, "任务分类数据待接入");
    return;
  }
  el.innerHTML = "";
  const data = tasks.map((t, i) => ringNode(product, t, i));

  const narrow = window.innerWidth <= 760;
  const minShare = selected ? 4.4 : 5.5;
  const chart = createChart(el, {
    animationDuration: REDUCED ? 0 : 680,
    animationEasing: "cubicOut",
    tooltip: {
      ...tip,
      formatter: (p) => {
        const share = p.data && p.data.share != null ? p.data.share : pct(p.value, total);
        const path = p.data && p.data.ringLevel === 1 ? `${p.data.taskName} / ` : "";
        return tipCard(
          tipHead(`${path}${p.name}`, `${share.toFixed(1)}%`, p.color) +
            tipRow(p.color, "条数", fmt(p.value)) +
            `<div class="tip-path">${p.data && p.data.ringLevel === 0 ? "点击该任务下钻" : "点击切换任务"}</div>`
        );
      },
    },
    series: [
      {
        type: "sunburst",
        radius: ["26%", "96%"],
        center: ["50%", "50%"],
        data,
        sort: null,
        nodeClick: false,
        roam: false,
        itemStyle: { borderColor: T.surface, borderWidth: 2.4, borderRadius: 3 },
        label: { show: false },
        levels: [
          {},
          {
            r0: "26%",
            r: "59%",
            itemStyle: { borderWidth: 2.4 },
            label: {
              show: !narrow,
              position: "inside",
              fontSize: 9,
              lineHeight: 11,
              rotate: "none",
              color: "inherit",
              formatter: (p) => {
                const share = p.data && p.data.share != null ? p.data.share : 0;
                if (share < minShare) return "";
                const name = String(p.name || "");
                return name.length > 7 ? `${name.slice(0, 6)}…` : name;
              },
            },
          },
          {
            r0: "59%",
            r: "95%",
            itemStyle: { borderWidth: 2 },
            label: { show: false },
          },
        ],
        labelLayout: { hideOverlap: true },
        emphasis: {
          focus: "ancestor",
          itemStyle: { shadowBlur: 12, shadowColor: hexA(T.ink, 0.18) },
        },
      },
    ],
  });
  if (chart) {
    chart.on("click", (p) => {
      const task = p.data && p.data.taskName;
      if (!task) return;
      if (p.data.ringLevel === 0) {
        board.volume[product].task = board.volume[product].task === task ? null : task;
      } else {
        board.volume[product].task = task;
      }
      renderVolumeVisual(product);
    });
    el.style.cursor = tasks.length ? "pointer" : "default";
  }
}

function renderVolume(product) {
  const wc = isWc(product);
  const src = getSrc(product);
  const total = maybeNumber(src.input.total);
  board.volume[product].src = src;
  const tasks = taskList(product);
  if (board.volume[product].task && !tasks.some((t) => t.name === board.volume[product].task)) {
    board.volume[product].task = null;
  }
  if (!board.volume[product].initialized) {
    const pick = tasks.find((t) => !["其他", "其它"].includes(t.name)) || tasks[0];
    board.volume[product].task = pick ? pick.name : null;
    board.volume[product].initialized = true;
  }

  setNum(wc ? "wcTotal" : "aiTotal", total);
  const meta = $(wc ? "wcVolMeta" : "aiVolMeta");
  if (meta) meta.textContent = dateRange(src.input.date_range);
  const days = (src.input.per_day && src.input.per_day.length) || 1;
  const side = $(wc ? "wcVolSide" : "aiVolSide");
  if (side) side.innerHTML = `活跃日均 <b>${fmt(Math.round(total / days))}</b> 条`;
  const stats = $(wc ? "wcVolStats" : "aiVolStats");
  if (stats) {
    stats.innerHTML = [
      ["体量", fmtBytes(src.input.bytes)],
      ["文件", fmt(src.input.files)],
      ["活跃", `${fmt(days)} 天`],
      ["已评测", fmt(src.input.evaluated)],
    ]
      .map(([label, value]) => `<span>${label} <b>${value}</b></span>`)
      .join("");
  }
  const back = $(wc ? "wcVolBack" : "aiVolBack");
  if (back) {
    back.onclick = () => {
      board.volume[product].task = null;
      renderVolumeVisual(product);
    };
  }
  renderVolumeVisual(product);
}

function maybeNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/* ------------------------------------------------------------- evaluation */

function renderRing(id, evaluated, pending, color) {
  const total = evaluated + pending;
  const el = $(id);
  if (!el) return;
  return createChart(el, {
    animationDuration: REDUCED ? 0 : 660,
    animationEasing: "cubicOut",
    animationDelay: REDUCED ? 0 : 100,
    tooltip: {
      ...tip,
      formatter: (p) =>
        tipCard(
          tipHead(p.name, `${pct(p.value, total).toFixed(1)}%`, p.color) +
            tipRow(p.color, "条数", fmt(p.value))
        ),
    },
    series: [
      {
        type: "pie",
        radius: ["73%", "94%"],
        center: ["50%", "50%"],
        startAngle: 90,
        avoidLabelOverlap: false,
        label: { show: false },
        labelLine: { show: false },
        itemStyle: { borderWidth: 0, borderRadius: 6 },
        emphasis: { scale: true, scaleSize: 2 },
        data: [
          { value: evaluated, name: "已评测", itemStyle: { color } },
          { value: Math.max(0, pending), name: "待评测", itemStyle: { color: T.track } },
        ],
      },
    ],
  });
}

function dotGrid(value, count, color, label) {
  const filled = Math.round((clamp(value, 0, 100) * count) / 100);
  return (
    `<div class="dot-grid" role="img" aria-label="${esc(label)} ${Math.round(value)}%">` +
    Array.from({ length: count }, (_, i) => `<i class="${i < filled ? "is-on" : ""}" style="--dot:${color}"></i>`).join("") +
    `</div>`
  );
}

function renderVersionBlocks(out) {
  const el = $("wcModels");
  if (!el) return;
  const defs = [
    ["a_expert", "A·expert", C.a],
    ["a_fast", "A·fast", C.aMid],
    ["b_expert", "B·expert", C.b],
    ["b_fast", "B·fast", C.bMid],
  ];
  const rows = defs.map(([key, name, color]) => {
    const v = out.versions[key] || {};
    return {
      key,
      name,
      color,
      answers: v.answers || 0,
      p50: v.p50 || 0,
      core: (out.meets_core && out.meets_core[key]) || 0,
      tokens: v.tokens || 0,
    };
  });
  const total = rows.reduce((n, r) => n + r.answers, 0) || 1;
  const bestCore = Math.max(0, ...rows.map((r) => r.core));
  el.innerHTML = rows
    .map(
      (r) =>
        `<div class="eval-block" style="--accent:${r.color}" title="${esc(r.name)} · ${fmt(r.answers)} 条 · 核心达标 ${r.core.toFixed(1)}% · P50 ${r.p50.toFixed(1)}s">` +
        `<div class="eb-top"><i class="eb-dot" style="background:${r.color}"></i><span>${esc(r.name)}</span><em>${pct(r.answers, total).toFixed(0)}%</em></div>` +
        `<div class="eb-main"><b>${fmt(r.answers)}</b><span>条回答</span></div>` +
        `<div class="eb-grid-row">${dotGrid(r.core, 50, r.color, `${r.name} 核心达标`)}<span class="eb-core${r.core === bestCore ? " is-best" : ""}">${r.core ? r.core.toFixed(1) + "%" : "—"}<em>核心</em></span></div>` +
        `<div class="eb-foot"><span>P50 <b>${r.p50 ? r.p50.toFixed(1) + "s" : "—"}</b></span><span>Tokens <b>${fmtTokens(r.tokens)}</b></span></div>` +
        `</div>`
    )
    .join("");
}

function renderModelBlocks(out) {
  const el = $("aiModels");
  if (!el) return;
  const rows = [
    { name: "fast", color: C.aiMid, value: (out.by_model && out.by_model.fast) || 0 },
    { name: "expert", color: C.ai, value: (out.by_model && out.by_model.expert) || 0 },
  ];
  const total = rows.reduce((n, r) => n + r.value, 0) || 1;
  const max = Math.max(1, ...rows.map((r) => r.value));
  el.innerHTML = rows
    .map(
      (r) =>
        `<div class="eval-block eval-block--model" style="--accent:${r.color};flex-grow:${Math.max(1, r.value / max)}" title="${r.name} · ${fmt(r.value)} 条 · ${pct(r.value, total).toFixed(1)}%">` +
        `<div class="eb-top"><i class="eb-dot" style="background:${r.color}"></i><span>${r.name}</span><em>${pct(r.value, total).toFixed(0)}%</em></div>` +
        `<div class="eb-main"><b>${fmt(r.value)}</b><span>条回答</span></div>` +
        `<div class="eb-grid-row">${dotGrid((r.value / total) * 100, 50, r.color, `${r.name} 占比`)}<span class="eb-core">${pct(r.value, total).toFixed(1)}%<em>占比</em></span></div>` +
        `<div class="eb-foot"><span>共享 P50 <b>${out.p50 ? out.p50.toFixed(1) + "s" : "—"}</b></span><span>密度 <b>${(out.density || 0).toFixed(2)}</b></span></div>` +
        `</div>`
    )
    .join("");
}

function renderTaskMini(out) {
  const el = $("aiEvalTasks");
  if (!el) return;
  const source = out.subtasks && Object.keys(out.subtasks).length ? out.subtasks : out.tasks || {};
  const all = Object.entries(source);
  const total = all.reduce((n, [, v]) => n + v, 0) || out.task_total || 1;
  const rows = all
    .filter(([name]) => !["其它", "未标注", "其他"].includes(name))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4);
  if (!rows.length) {
    el.innerHTML = "";
    return;
  }
  const max = Math.max(1, ...rows.map(([, v]) => v));
  el.innerHTML =
    `<div class="mini-head"><span>评测子任务 Top 4</span><span>${fmt(out.task_total || total)} 条</span></div>` +
    rows
      .map(([name, value]) => {
        const ratio = value / max;
        const size = (4 + ratio * 4).toFixed(1);
        const alpha = (0.3 + ratio * 0.65).toFixed(2);
        return (
          `<div class="mini-row" title="${esc(name)} · ${fmt(value)} 条 · ${pct(value, total).toFixed(1)}%">` +
          `<i class="mini-bubble" style="width:${size}px;height:${size}px;background:${hexA(C.aiMid, alpha)}"></i>` +
          `<span class="mini-name">${esc(name)}</span>` +
          `<span class="mini-val">${fmt(value)}</span>` +
          `<span class="mini-pct">${pct(value, total).toFixed(1)}%</span>` +
          `</div>`
        );
      })
      .join("");
}

function renderDifficulty(src) {
  const el = $("wcDifficulty");
  if (!el) return;
  const order = ["简单", "中等", "困难", "复杂"];
  const colors = { 简单: T.wcMid, 中等: T.wc, 困难: T.bMid, 复杂: T.b };
  const counts = {};
  let total = 0;
  Object.values((src.output && src.output.versions) || {}).forEach((v) => {
    Object.entries(v.difficulty || {}).forEach(([k, n]) => {
      counts[k] = (counts[k] || 0) + n;
      total += n;
    });
  });
  if (!total) {
    el.innerHTML = "";
    return;
  }
  el.innerHTML =
    `<div class="diff-head"><span>难度构成</span><span>${fmt(total)} 条</span></div>` +
    order
      .map(
        (k) =>
          `<div class="diff-tile" title="${k} · ${fmt(counts[k] || 0)} 条 · ${pct(counts[k] || 0, total).toFixed(1)}%">` +
          `<span class="dt-head"><i class="dt-dot" style="background:${colors[k]}"></i>${k}</span>` +
          `<b class="dt-value">${pct(counts[k] || 0, total).toFixed(0)}%</b>` +
          `<span class="dt-count">${fmt(counts[k] || 0)} 条</span>` +
          `</div>`
      )
      .join("");
}

function renderEvalInsights(out, defs) {
  const el = $("wcEvalInsights");
  if (!el) return;
  const rows = defs.map(([key, name]) => {
    const v = out.versions[key] || {};
    return { name, p50: v.p50 || 0, core: (out.meets_core && out.meets_core[key]) || 0 };
  });
  const valid = rows.filter((r) => r.p50 > 0);
  if (!valid.length) {
    el.innerHTML = "";
    return;
  }
  const fast = valid.reduce((a, b) => (a.p50 <= b.p50 ? a : b));
  const slow = valid.reduce((a, b) => (a.p50 >= b.p50 ? a : b));
  const cores = rows.map((r) => r.core).filter((v) => v > 0);
  const coreMin = cores.length ? Math.min(...cores) : 0;
  const coreMax = cores.length ? Math.max(...cores) : 0;
  el.innerHTML =
    `<div class="ei-head"><span>版本极值</span><span>P50 / 核心</span></div>` +
    `<div class="ei-row"><span>最快 P50</span><b>${fast.name} · ${fast.p50.toFixed(1)}s</b></div>` +
    `<div class="ei-row"><span>最慢 P50</span><b>${slow.name} · ${slow.p50.toFixed(1)}s</b></div>` +
    `<div class="ei-row"><span>核心区间</span><b>${coreMin.toFixed(1)}–${coreMax.toFixed(1)}%</b></div>`;
}

function renderSpark(perDay) {
  const values = (perDay || []).map((x) => ({
    date: x.date,
    value: (x.fast || 0) + (x.expert || 0),
  }));
  const peak = values.reduce((best, x) => (x.value > best.value ? x : best), { date: "—", value: 0 });
  const peakEl = $("aiSparkPeak");
  if (peakEl) peakEl.innerHTML = `峰值 <b>${fmt(peak.value)}</b> · ${peak.date.slice(5)}`;
  const startEl = $("aiSparkStart");
  const endEl = $("aiSparkEnd");
  if (startEl) startEl.textContent = values.length ? values[0].date.slice(5) : "";
  if (endEl) endEl.textContent = values.length ? values[values.length - 1].date.slice(5) : "";
  const max = Math.max(1, ...values.map((x) => x.value));
  const spark = $("aiSpark");
  if (!spark) return;
  spark.innerHTML = values
    .slice(-28)
    .map((x) => {
      const ratio = x.value / max;
      const h = Math.max(3, Math.round(ratio * 100));
      const alpha = (0.3 + ratio * 0.7).toFixed(2);
      return (
        `<i class="spark-bar" style="--h:${h}%;background:linear-gradient(180deg,${hexA(T.aiMid, alpha)},${hexA(T.ai, alpha)})"` +
        ` title="${x.date} · ${fmt(x.value)} 条"></i>`
      );
    })
    .join("");
  const animate = () =>
    spark.querySelectorAll(".spark-bar").forEach((b) => {
      b.style.height = b.style.getPropertyValue("--h");
    });
  if (REDUCED) animate();
  else requestAnimationFrame(animate);
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

function outputDensity(src) {
  if (src.output && src.output.density) return Number(src.output.density);
  const answers = Number(src.input && src.input.evaluated) || 0;
  const problems = Number(src.output && src.output.problems) || 0;
  return answers ? problems / answers : 0;
}

function renderEvaluation(product) {
  const wc = isWc(product);
  const src = getSrc(product);
  const out = src.output || {};
  const input = src.input;
  const evaluated = input.evaluated || 0;
  const pending = input.pending || 0;

  setNum(wc ? "wcEvaluated" : "aiEvaluated", evaluated);
  setNum(wc ? "wcCoverPct" : "aiCoverPct", pct(evaluated, input.total), { decimals: 1, suffix: "%" });
  const pendingEl = $(wc ? "wcPending" : "aiPending");
  if (pendingEl) pendingEl.textContent = fmt(pending);
  const note = $(wc ? "wcEvalNote" : "aiEvalNote");
  if (note) note.innerHTML = `<b>${(out.problems / Math.max(1, evaluated)).toFixed(1)}</b> 问题/回答`;
  const meta = $(wc ? "wcEvalMeta" : "aiEvalMeta");
  if (meta) meta.textContent = wc
    ? `比对 ${fmt(out.comparison_total)} 组`
    : `密度 ${(out.density || 0).toFixed(2)} 条/回答`;

  const p50 = outputP50(src);
  const stats = $(wc ? "wcEvalStats" : "aiEvalStats");
  if (stats) {
    stats.innerHTML = (
      wc
        ? [
            ["问题", fmt(out.problems)],
            ["Tokens", fmtTokens(out.tokens || 0)],
            ["P50", p50 ? p50.toFixed(1) + "s" : "—"],
            ["覆盖率", pct(evaluated, input.total).toFixed(1) + "%"],
          ]
        : [
            ["问题", fmt(out.problems)],
            ["Tokens", fmtTokens(out.tokens || 0)],
            ["P50", p50 ? p50.toFixed(1) + "s" : "—"],
            ["密度", outputDensity(src).toFixed(2)],
          ]
    )
      .map(([label, value]) => `<span><em>${label}</em><b>${value}</b></span>`)
      .join("");
  }

  renderRing(wc ? "wcCover" : "aiCover", evaluated, pending, wc ? C.a : C.ai);

  if (wc) {
    const defs = [
      ["a_expert", "A·expert", C.a],
      ["a_fast", "A·fast", C.aMid],
      ["b_expert", "B·expert", C.b],
      ["b_fast", "B·fast", C.bMid],
    ];
    renderVersionBlocks(out);
    renderDifficulty(src);
    renderEvalInsights(out, defs);
  } else {
    renderModelBlocks(out);
    renderSpark(out.per_day || []);
    renderTaskMini(out);
  }
}

/* ----------------------------------------------------------- attribution */

function shortComp(name) {
  return String(name || "")
    .replace(/ 取数服务$/, "")
    .replace(/ 代码解释器$/, "")
    .replace(/ 网页检索$/, "")
    .replace(/ 网页抓取$/, "")
    .replace(/ 取数规划子模型$/, "")
    .replace(/ 检索规划子模型$/, "")
    .replace(/^其他工具（(.+)）$/, "$1");
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
  const addNode = (name, display, color, col, tipMeta) => {
    if (seen.has(name)) return;
    seen.add(name);
    nodes.push({
      name,
      display: display || name,
      depth: col,
      itemStyle: { color },
      label: { position: col === 0 ? "left" : col === 2 ? "right" : "top" },
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
      top.forEach((name) => addNode(name, shortComp(name), T.mode === "dark" ? T.surface3 : T.track, 1, name));
      if (extra.length) addNode("其他环节", "其他环节", T.mode === "dark" ? T.surface3 : T.track, 1, `${extra.length} 类长尾`);
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
    const totalA = (comp.A || []).reduce((n, v) => n + v, 0);
    const totalB = (comp.B || []).reduce((n, v) => n + v, 0);
    addNode("A 组", "A 组", C.a, 0, "A");
    if (totalB > 0) addNode("B 组", "B 组", C.b, 0, "B");
    (comp.names || []).forEach((name, i) => {
      const value = (comp.A[i] || 0) + (comp.B[i] || 0);
      if (value <= 0) return;
      addNode(name, shortComp(name), T.mode === "dark" ? T.surface3 : T.track, 1, name);
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
    if (total > 0) addNode(name, shortComp(name), T.mode === "dark" ? T.surface3 : T.track, 1, name);
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

function sankeyOption(product, graph) {
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
              tipRow(color, "问题数", fmt(p.value)) +
              `<div class="tip-path">点击回流召回相关样本</div>`
          );
        }
        const d = p.data || {};
        return tipCard(
          tipHead(d.display || p.name, "", color) +
            tipRow(color, "问题数", fmt(p.value)) +
            (d.tipMeta ? `<div class="tip-path">${esc(d.tipMeta)}</div>` : "") +
            `<div class="tip-path">点击节点或流召回样本</div>`
        );
      },
    },
    series: [
      {
        type: "sankey",
        left: 50,
        right: cols === 3 ? 52 : 74,
        top: 16,
        bottom: 3,
        nodeWidth: 8,
        nodeGap: 8,
        layoutIterations: 40,
        nodeAlign: "justify",
        draggable: false,
        data: nodes,
        links,
        lineStyle: { curveness: 0.55, opacity: 0.5 },
        itemStyle: { borderWidth: 0, borderRadius: 2 },
        label: {
          fontSize: 8.4,
          fontFamily: FONT,
          color: T.ink2,
          distance: 4,
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

function sankeyClick(product, p) {
  const src = getSrc(product);
  const graph = buildSankey(product);
  const compNames = new Set([
    ...((src.components && src.components.names) || []),
    ...((src.output && src.output.components && src.output.components.names) || []),
  ]);
  const sevNames = new Set(AIME_SEVERITIES);
  let component = "";
  let severity = "";
  const pick = (name) => {
    if (compNames.has(name)) component = name;
    else if (sevNames.has(name)) severity = name;
  };
  if (p.dataType === "edge") {
    pick(p.data.source);
    pick(p.data.target);
  } else {
    pick(p.name);
  }
  if (!component && !severity) return;
  recall({ component, severity });
}

function renderAttribution(product) {
  const wc = isWc(product);
  const src = getSrc(product);
  const out = src.output || {};
  const id = wc ? "wcAttr" : "aiAttr";
  const el = $(id);
  const graph = buildSankey(product);
  const total = graph.links.reduce((n, l) => n + l.value, 0) || 1;

  if (wc) {
    const comp = src.components || {};
    const totalA = (comp.A || []).reduce((n, v) => n + v, 0);
    const totalB = (comp.B || []).reduce((n, v) => n + v, 0);
    setNum("wcProblems", out.problems || total);
    const side = $("wcAttrSide");
    if (side) side.innerHTML = `A 组 <b>${fmt(totalA)}</b> · B 组 <b>${fmt(totalB)}</b>`;
    const meta = $("wcAttrMeta");
    if (meta) meta.textContent = `${(comp.names || []).length} 类环节`;
    const hint = $("wcAttrHint");
    if (hint) hint.textContent = "版本 → 环节 · 流宽 = 问题数 · 点击召回";
  } else {
    setNum("aiProblems", out.problems || total);
    const meta = $("aiAttrMeta");
    if (meta) meta.textContent = "P0–P3 分级";
    const hint = $("aiAttrHint");
    if (hint) hint.textContent = "模型 → 环节 → 严重度 · 点击召回";
    const side = $("aiAttrSide");
    if (side) side.innerHTML = `P1 <b>${(out.severity && out.problems ? pct(out.severity.P1 || 0, out.problems) : 0).toFixed(1)}%</b>`;
    const chips = $("aiSevChips");
    if (chips) {
      chips.innerHTML = AIME_SEVERITIES.map((s) => {
        const share = pct((out.severity && out.severity[s]) || 0, out.problems || 1);
        return (
          `<span class="sev-chip"><i class="sev-dot" style="background:${SEV_COLOR[s]}"></i>` +
          `${s} <b>${share.toFixed(1)}%</b></span>`
        );
      }).join("");
    }
  }

  if (!el) return;
  if (!graph.links.length) {
    showChartEmpty(el, "归因数据待接入");
    return;
  }
  el.innerHTML = "";
  const chart = createChart(el, sankeyOption(product, graph));
  if (chart) {
    chart.on("click", (p) => sankeyClick(product, p));
    el.style.cursor = "pointer";
  }
}

/* --------------------------------------------------------------- cluster */

function clusterValue(node) {
  return Number(node.value != null ? node.value : node.sessions || 0);
}

function decorateCluster(node, color, depth, parentPath) {
  const path = [...parentPath, node.name];
  const value = clusterValue(node);
  const out = {
    id: node.id || path.join("/"),
    name: node.name,
    value,
    items: Number(node.items != null ? node.items : node.count || 0),
    clusterKey: node.id || path.join("/"),
    clusterPath: path,
    itemStyle: { color: depth === 0 ? color : lerpColor(color, T.surface, 0.12 + depth * 0.09) },
  };
  if (node.children && node.children.length) out.children = node.children.map((c) => decorateCluster(c, color, depth + 1, path));
  return out;
}

function clusterLevels(data) {
  const maxDepth = (nodes) =>
    nodes.reduce((m, n) => Math.max(m, 1 + (n.children && n.children.length ? maxDepth(n.children) : 0)), 0);
  const depth = maxDepth(data);
  if (depth <= 1) return [{}, { r0: "28%", r: "94%", label: { show: false } }];
  if (depth === 2) return [{}, { r0: "26%", r: "60%", label: { show: false } }, { r0: "60%", r: "94%", label: { show: false } }];
  return [{}, { r0: "22%", r: "50%", label: { show: false } }, { r0: "50%", r: "72%", label: { show: false } }, { r0: "72%", r: "94%", label: { show: false } }];
}

function clusterCurrent(product) {
  const st = board.cluster[product];
  return st.stack.length ? st.stack[st.stack.length - 1] : st.root;
}

function findClusterNode(root, key) {
  if (!root) return null;
  if (root.clusterKey === key) return root;
  for (const child of root.children || []) {
    const hit = findClusterNode(child, key);
    if (hit) return hit;
  }
  return null;
}

function clusterOption(product) {
  const st = board.cluster[product];
  const current = clusterCurrent(product);
  const data = (current && current.children) || [];
  const total = (st.meta && st.meta.total_sessions) || (st.root && st.root.value) || 1;
  return {
    animationDuration: REDUCED ? 0 : 640,
    animationEasing: "cubicOut",
    tooltip: {
      ...tip,
      formatter: (p) => {
        const path = (p.treePathInfo || []).map((x) => x.name).filter((n) => n && n !== "归因聚类" && n !== "root").join(" / ");
        return tipCard(
          tipHead(p.name, `${pct(p.value, total).toFixed(1)}%`, p.color) +
            tipRow(T.muted, "会话", fmt(p.value)) +
            tipRow(T.muted, "条目", fmt((p.data && p.data.items) || 0)) +
            (path ? `<div class="tip-path">${esc(path)}</div>` : "") +
            `<div class="tip-path">${(p.data && p.data.children) ? "点击下钻" : "点击召回该簇样本"}</div>`
        );
      },
    },
    graphic: [
      {
        type: "text",
        left: "center",
        top: "middle",
        style: {
          text: `${fmt(current ? current.value : 0)}\n会话`,
          textAlign: "center",
          fill: T.ink,
          font: `600 12px ${FONT}`,
          lineHeight: 15,
        },
        silent: true,
      },
    ],
    series: [
      {
        type: "sunburst",
        radius: ["25%", "96%"],
        center: ["50%", "50%"],
        data,
        nodeClick: false,
        sort: null,
        itemStyle: { borderColor: T.surface, borderWidth: 2, borderRadius: 3 },
        label: { show: false },
        levels: clusterLevels(data),
        emphasis: {
          focus: "ancestor",
          itemStyle: { shadowBlur: 10, shadowColor: hexA(T.ink, 0.18) },
        },
      },
    ],
  };
}

function renderClusterLegend(product) {
  const wc = isWc(product);
  const el = $(wc ? "wcClusterLegend" : "aiClusterLegend");
  const st = board.cluster[product];
  if (!el || !st.root) return;
  const current = clusterCurrent(product);
  const children = current.children || [];
  if (!children.length) {
    el.innerHTML = `<div class="cl-empty">没有更细的聚类节点</div>`;
    return;
  }
  const total = current.value || 1;
  const palette = [T.cl1, T.cl2, T.cl3, T.cl4, T.cl5, T.cl6];
  el.innerHTML =
    `<div class="cl-head"><span></span><span>环节</span><span>会话</span><span>占比</span></div>` +
    children
      .map((n, i) => {
        const drillable = (n.children || []).length > 0;
        const color = palette[i % palette.length];
        return (
          `<button class="cl-row" type="button" data-key="${esc(n.clusterKey)}" data-drill="${drillable ? 1 : 0}"` +
          ` title="${esc(n.name)} · ${fmt(n.value)} 会话 · ${pct(n.value, total).toFixed(1)}%${drillable ? " · 点击下钻" : " · 点击召回样本"}">` +
          `<i class="cl-dot" style="background:${color}"></i>` +
          `<span class="cl-name">${esc(n.name)}</span>` +
          `<span class="cl-val">${fmt(n.value)}</span>` +
          `<span class="cl-pct">${pct(n.value, total).toFixed(1)}%</span>` +
          `</button>`
        );
      })
      .join("");
  el.onclick = (ev) => {
    const row = ev.target.closest(".cl-row");
    if (!row) return;
    const node = findClusterNode(st.root, row.dataset.key);
    if (!node) return;
    if ((node.children || []).length) drillCluster(product, node);
    else recall({ cluster: node.clusterKey });
  };
}

function updateClusterNote(product) {
  const wc = isWc(product);
  const st = board.cluster[product];
  const current = clusterCurrent(product);
  const back = $(wc ? "wcClusterBack" : "aiClusterBack");
  const note = $(wc ? "wcClusterNote" : "aiClusterNote");
  const right = $(wc ? "wcClusterNoteR" : "aiClusterNoteR");
  if (back) back.hidden = !st.stack.length;
  if (note) note.textContent = st.stack.length
    ? ["全部", ...st.stack.map((n) => n.name)].join(" / ")
    : `${(st.root && st.root.children ? st.root.children.length : 0)} 环节`;
  if (right) right.textContent = st.stack.length
    ? `${(current && current.children ? current.children.length : 0)} 子类`
    : `${(st.meta && st.meta.depth) || 3} 层`;
  const sampleBtn = $(wc ? "wcClusterSamples" : "aiClusterSamples");
  if (sampleBtn) {
    sampleBtn.onclick = () => {
      const node = clusterCurrent(product);
      recall({ cluster: node && node !== st.root ? node.clusterKey : "" });
    };
  }
}

function drawCluster(product) {
  const wc = isWc(product);
  const st = board.cluster[product];
  const current = clusterCurrent(product);
  const el = $(wc ? "wcCluster" : "aiCluster");
  if (!el || !current) return;
  const chart = createChart(el, clusterOption(product));
  board.clusterCharts[product] = chart;
  animateTo(wc ? "wcClusterSessions" : "aiClusterSessions", current.value || 0);
  const side = $(wc ? "wcClusterSide" : "aiClusterSide");
  if (side) side.innerHTML = `${fmt(current.items || 0)} <span>条目</span>`;
  updateClusterNote(product);
  renderClusterLegend(product);
  el.style.cursor = (current.children || []).length ? "pointer" : "default";
  if (chart) {
    chart.on("click", (p) => {
      const st2 = board.cluster[product];
      const names = (p.treePathInfo || []).map((x) => x.name).filter((n) => n && n !== "归因聚类" && n !== "root");
      let node = st2.root;
      for (const name of names) {
        const hit = findClusterNode(node, name);
        if (hit) node = hit;
        else break;
      }
      if (!node || node === st2.root) return;
      if ((node.children || []).length) drillCluster(product, node);
      else recall({ cluster: node.clusterKey });
    });
  }
}

function drillCluster(product, node) {
  const st = board.cluster[product];
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
  const stackKey = base.stack.length ? base.stack[base.stack.length - 1].clusterKey : "";
  board.cluster[product] = {
    src,
    root,
    meta,
    stack: [],
  };
  const metaEl = $(wc ? "wcClusterMeta" : "aiClusterMeta");
  if (metaEl) metaEl.textContent = "聚类快照";
  const chartEl = $(wc ? "wcCluster" : "aiCluster");
  if (!root || !clusterValue(root)) {
    if (chartEl) showChartEmpty(chartEl, "聚类数据待接入");
    const legend = $(wc ? "wcClusterLegend" : "aiClusterLegend");
    if (legend) legend.innerHTML = "";
    const back = $(wc ? "wcClusterBack" : "aiClusterBack");
    if (back) back.hidden = true;
    const note = $(wc ? "wcClusterNote" : "aiClusterNote");
    if (note) note.textContent = "待接入";
    const right = $(wc ? "wcClusterNoteR" : "aiClusterNoteR");
    if (right) right.textContent = "—";
    const sampleBtn = $(wc ? "wcClusterSamples" : "aiClusterSamples");
    if (sampleBtn) sampleBtn.onclick = () => recall({ cluster: "" });
    return;
  }
  const palette = [T.cl1, T.cl2, T.cl3, T.cl4, T.cl5, T.cl6];
  const prepared = {
    id: root.id || root.name,
    name: root.name,
    value: clusterValue(root),
    items: Number(root.items != null ? root.items : root.count || 0),
    clusterKey: root.id || root.name,
    clusterPath: [root.name],
    itemStyle: { color: palette[0] },
    children: (root.children || []).map((c, i) => decorateCluster(c, palette[i % palette.length], 0, [])),
  };
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

  const back = $(wc ? "wcClusterBack" : "aiClusterBack");
  if (back) {
    back.onclick = () => {
      board.cluster[product].stack.pop();
      drawCluster(product);
    };
  }
  drawCluster(product);
}

/* ------------------------------------------------------------ prediction */

function parseDay(value) {
  const d = new Date(`${value}T00:00:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function dayLabel(base, offset) {
  const d = parseDay(base);
  if (!d) return "—";
  d.setDate(d.getDate() + offset);
  return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function dayISO(base, offset) {
  const d = parseDay(base);
  if (!d) return "—";
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function synthSeries(n, base, seed, amp = 0.12, trend = 0) {
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const t = n > 1 ? i / (n - 1) : 0;
    const wave = Math.sin(i * 0.92 + seed) * amp + Math.cos(i * 1.73 + seed * 2.1) * amp * 0.38;
    out.push(Math.max(0, base * (1 + trend * (t - 0.5) + wave)));
  }
  return out;
}

function forecastSeries(values, horizon, opts = {}) {
  const n = values.length;
  const decimals = opts.decimals == null ? 0 : opts.decimals;
  const min = opts.min == null ? 0 : opts.min;
  const max = opts.max == null ? Infinity : opts.max;
  if (!n) {
    return { values: Array(horizon).fill(0), lower: Array(horizon).fill(0), upper: Array(horizon).fill(0) };
  }
  let slope = 0;
  let intercept = values[n - 1];
  if (n >= 3) {
    const xMean = (n - 1) / 2;
    const yMean = values.reduce((a, b) => a + b, 0) / n;
    let num = 0;
    let den = 0;
    values.forEach((y, i) => {
      num += (i - xMean) * (y - yMean);
      den += (i - xMean) ** 2;
    });
    slope = den ? num / den : 0;
    intercept = yMean - slope * xMean;
  }
  const residuals = values.map((y, i) => y - (intercept + slope * i));
  const sigma = Math.sqrt(residuals.reduce((a, r) => a + r * r, 0) / Math.max(1, n - 1));
  const fv = [];
  const lower = [];
  const upper = [];
  for (let h = 0; h < horizon; h += 1) {
    const damp = Math.pow(0.93, h);
    const raw = values[n - 1] + slope * (h + 1) * damp;
    const value = clamp(raw, min, max);
    const band = Math.max(
      Math.abs(value) * 0.035,
      1.96 * sigma * Math.sqrt(1 + (h + 1) / n),
      n < 3 ? Math.abs(value) * 0.08 : 0
    );
    const round = (x) => Number(clamp(x, min, max).toFixed(decimals));
    fv.push(round(value));
    lower.push(round(value - band));
    upper.push(round(value + band));
  }
  return { values: fv, lower, upper };
}

function volumeForecast(product) {
  const src = getSrc(product);
  const total = volumeTotal(product);
  const raw = (src.input.per_day || [])
    .map((x) => ({ date: x.date, value: Number(x.value) || 0 }))
    .filter((x) => x.value > 0);
  const end = (raw.length ? raw[raw.length - 1].date : null) || (src.input.date_range && src.input.date_range.end) || "2026-10-23";
  let points;
  let synthetic = false;
  let smoothed = false;
  if (raw.length >= 4) {
    const recent = raw.slice(-14);
    const values = recent.map((p) => p.value);
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const sd = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length);
    const cv = mean ? sd / mean : 0;
    if (cv > 0.5 && raw.length >= 10) {
      // Batchy data: use a trailing 7-day mean so one release spike does not own the forecast.
      const windowRaw = raw.slice(-28);
      const rolled = [];
      for (let i = 6; i < windowRaw.length; i += 1) {
        const window = windowRaw.slice(i - 6, i + 1);
        rolled.push({ date: windowRaw[i].date, value: window.reduce((a, b) => a + b.value, 0) / window.length });
      }
      points = rolled.slice(-14);
      smoothed = true;
    } else {
      points = recent;
    }
  } else {
    synthetic = true;
    const days = Math.max(1, raw.length || 1);
    const base = raw.length ? raw.reduce((a, b) => a + b.value, 0) / days : Math.max(1, total / 14);
    const values = synthSeries(14, base, isWc(product) ? 1.4 : 2.6, 0.11, 0.16);
    points = values.map((value, i) => ({ date: dayISO(end, i - 13), value }));
  }
  const values = points.map((p) => p.value);
  const fc = forecastSeries(values, 7, { min: 0, decimals: 0 });
  const lastDate = points.length ? points[points.length - 1].date : end;
  const futureDates = Array.from({ length: 7 }, (_, i) => dayISO(lastDate, i + 1));
  return {
    dates: [...points.map((p) => p.date), ...futureDates],
    values,
    forecast: fc,
    synthetic,
    smoothed,
    last: values[values.length - 1] || 0,
  };
}

function performanceForecast(product) {
  const src = getSrc(product);
  const inputDays = (src.input.per_day || []).map((x) => ({ date: x.date, value: Number(x.value) || 0 })).filter((x) => x.value > 0);
  const outDays = src.output.per_day || [];
  const outMap = new Map();
  outDays.forEach((d) => {
    const answers = d.answers != null ? Number(d.answers) : (Number(d.fast) || 0) + (Number(d.expert) || 0);
    if (answers > 0) outMap.set(d.date, answers);
  });
  const actual = [];
  let cumIn = 0;
  let cumOut = 0;
  inputDays.forEach((d) => {
    cumIn += d.value;
    cumOut += outMap.get(d.date) || 0;
    if (!cumIn) return;
    actual.push({ date: d.date, value: clamp((100 * cumOut) / cumIn, 0, 100) });
  });
  const currentCoverage = pct(src.input.evaluated || 0, src.input.total || 1);
  const end = (src.input.date_range && src.input.date_range.end) || (actual.length ? actual[actual.length - 1].date : "2026-10-23");
  let points;
  let synthetic = false;
  if (actual.length >= 4) {
    points = actual.slice(-14);
  } else {
    synthetic = true;
    const base = clamp(currentCoverage || 0.5, 0.5, 100);
    const values = synthSeries(14, base, isWc(product) ? 4.1 : 3.2, 0.035, 0.07).map((v) => clamp(v, 0, 100));
    points = values.map((value, i) => ({ date: dayISO(end, i - 13), value }));
  }
  const values = points.map((p) => p.value);
  const fc = forecastSeries(values, 7, { min: 0, max: 100, decimals: 1 });
  const futureDates = Array.from({ length: 7 }, (_, i) => dayISO(end, i + 1));

  const p50Raw = outDays.map((d) => Number(d.p50)).filter((v) => v > 0);
  const p50 = outputP50(src);
  let p50Points;
  let p50Synthetic = false;
  if (p50Raw.length >= 4) {
    p50Points = p50Raw.slice(-14);
  } else {
    p50Synthetic = true;
    p50Points = synthSeries(14, p50 || 1, isWc(product) ? 5.2 : 6.1, 0.05, 0.04);
  }
  const p50Fc = forecastSeries(p50Points, 7, { min: 0.1, decimals: 1 });
  return {
    dates: [...points.map((p) => p.date), ...futureDates],
    values,
    forecast: fc,
    synthetic,
    p50,
    p50Forecast: p50Fc.values[0],
    p50Synthetic,
    density: outputDensity(src),
    last: values[values.length - 1] || 0,
  };
}

function attributionForecast(product) {
  const src = getSrc(product);
  const wc = isWc(product);
  let cats;
  if (wc) {
    const comp = src.components || {};
    const names = comp.names || [];
    const pairs = names
      .map((name, i) => ({ name, value: (comp.A[i] || 0) + (comp.B[i] || 0) }))
      .filter((x) => x.value > 0)
      .sort((a, b) => b.value - a.value);
    const top = pairs.slice(0, 3);
    const rest = pairs.slice(3).reduce((n, x) => n + x.value, 0);
    if (rest > 0) top.push({ name: "其他环节", value: rest });
    const palette = [T.wc, T.wcMid, T.bMid, T.b];
    cats = top.map((x, i) => ({ name: x.name, value: x.value, color: palette[i % palette.length] }));
  } else {
    const sev = src.output.severity || {};
    cats = AIME_SEVERITIES.map((s) => ({ name: s, value: sev[s] || 0, color: SEV_COLOR[s] })).filter((x) => x.value > 0);
  }
  const sum = cats.reduce((n, c) => n + c.value, 0) || 1;
  const base = cats.map((c) => (100 * c.value) / sum);
  const outDays = (src.output.per_day || []).filter((d) => {
    if (!d.severity) return false;
    return (Number(d.severity.P0) || 0) + (Number(d.severity.P1) || 0) + (Number(d.severity.P2) || 0) + (Number(d.severity.P3) || 0) > 0;
  });
  const end = (src.input.date_range && src.input.date_range.end) || (src.output.per_day && src.output.per_day.length ? src.output.per_day[src.output.per_day.length - 1].date : "2026-10-23");
  const n = 14;
  let dates;
  let actual;
  let synthetic = false;
  const usable = !wc && outDays.length >= 3;
  if (usable) {
    const days = outDays.slice(-n);
    dates = days.map((d) => d.date);
    actual = cats.map((cat) =>
      days.map((d) => {
        const total = Object.values(d.severity).reduce((a, b) => a + (Number(b) || 0), 0) || 1;
        return (100 * (Number(d.severity[cat.name]) || 0)) / total;
      })
    );
  } else {
    synthetic = true;
    dates = Array.from({ length: n }, (_, i) => dayISO(end, i - n + 1));
    actual = cats.map((cat, ci) => {
      const baseShare = base[ci];
      return Array.from({ length: n }, (_, i) => {
        const wave = Math.sin(i * 0.7 + ci * 1.9) * 0.03 + Math.cos(i * 1.2 + ci) * 0.018;
        return Math.max(0, baseShare * (1 + wave));
      });
    });
  }
  // Normalize each historical day to 100%.
  for (let i = 0; i < dates.length; i += 1) {
    const sumDay = actual.reduce((a, row) => a + (row[i] || 0), 0) || 1;
    actual.forEach((row) => { row[i] = (100 * (row[i] || 0)) / sumDay; });
  }
  const futureDates = Array.from({ length: 7 }, (_, i) => dayISO(end, i + 1));
  const forecasts = actual.map((row) => forecastSeries(row, 7, { min: 0, max: 100, decimals: 1 }));
  for (let h = 0; h < 7; h += 1) {
    const sumDay = forecasts.reduce((a, f) => a + f.values[h], 0) || 1;
    forecasts.forEach((f) => { f.values[h] = (100 * f.values[h]) / sumDay; });
  }
  const futureAvg = cats.map((cat, ci) => forecasts[ci].values.reduce((a, b) => a + b, 0) / 7);
  const topIndex = futureAvg.indexOf(Math.max(...futureAvg));
  const lastActual = actual.map((row) => row[row.length - 1] || 0);
  return {
    cats,
    dates: [...dates, ...futureDates],
    actual,
    forecasts,
    synthetic,
    topIndex,
    topShare: futureAvg[topIndex] || 0,
    topChange: (futureAvg[topIndex] || 0) - (lastActual[topIndex] || 0),
    lastActualDate: dates[dates.length - 1],
  };
}

function setPredictHero(product, { value, decimals, suffix, unit, trend, trendClass }) {
  const wc = isWc(product);
  const id = wc ? "wcForecast" : "aiForecast";
  const el = $(id);
  setNum(id, value, { decimals, suffix });
  if (el) {
    lockHero(el, value, decimals, suffix);
    if (REDUCED) el.textContent = fmtFixed(value, decimals) + suffix;
    else tweenNumber(el, value, decimals, suffix, 520);
  }
  const unitEl = $(wc ? "wcForecastUnit" : "aiForecastUnit");
  if (unitEl) unitEl.textContent = unit;
  const trendEl = $(wc ? "wcForecastTrend" : "aiForecastTrend");
  if (trendEl) trendEl.innerHTML = `<span class="${trendClass}">${trend}</span>`;
}

function lockHero(el, value, decimals, suffix) {
  const s = fmtFixed(value || 0, decimals || 0) + (suffix || "");
  el.style.minWidth = `${Math.max(2, s.length - (s.includes(",") ? 0.35 : 0)).toFixed(2)}ch`;
}

function predictStats(rows) {
  return rows
    .map(([label, value, color]) =>
      `<span class="predict-stat${color ? " has-dot" : ""}">` +
      `${color ? `<i style="background:${color}"></i>` : ""}` +
      `<em>${esc(label)}</em><b>${value}</b></span>`
    )
    .join("");
}

function renderPrediction(product) {
  const wc = isWc(product);
  const dim = board.predict[product].dim;
  const tabs = $(wc ? "wcPredictTabs" : "aiPredictTabs");
  if (tabs) {
    tabs.querySelectorAll(".predict-tab").forEach((tab) => {
      const on = tab.dataset.dim === dim;
      tab.classList.toggle("is-active", on);
      tab.setAttribute("aria-selected", String(on));
    });
  }
  const metaEl = $(wc ? "wcForecastMeta" : "aiForecastMeta");
  const statsEl = $(wc ? "wcForecastStats" : "aiForecastStats");
  const chartEl = $(wc ? "wcForecastChart" : "aiForecastChart");
  const accent = wc ? C.a : C.ai;

  if (dim === "volume") {
    const p = volumeForecast(product);
    const next = p.forecast.values[0] || 0;
    const growth = p.last ? (100 * (next - p.last)) / p.last : 0;
    setPredictHero(product, {
      value: next,
      decimals: 0,
      suffix: "",
      unit: "条/日",
      trend: `${growth >= 0 ? "+" : ""}${growth.toFixed(1)}% vs 昨日`,
      trendClass: growth >= 0 ? "trend-up" : "trend-down",
    });
    if (metaEl) metaEl.textContent = `未来 7 天${p.smoothed ? " · 7 日平滑" : ""}${p.synthetic ? " · 原型" : ""}`;
    if (statsEl) {
      const total7 = p.forecast.values.reduce((a, b) => a + b, 0);
      const peak = Math.max(...p.forecast.values);
      statsEl.innerHTML = predictStats([
        ["7 日合计", fmt(total7)],
        ["峰值", fmt(peak)],
        ["日均", fmt(Math.round(total7 / 7))],
      ]);
    }
    const n = p.values.length;
    const actualData = [...p.values, ...Array(7).fill(null)];
    const forecastData = [...Array(n - 1).fill(null), p.values[n - 1], ...p.forecast.values];
    const lowerData = [...Array(n).fill(null), ...p.forecast.lower];
    const bandData = [...Array(n).fill(null), ...p.forecast.upper.map((u, i) => u - p.forecast.lower[i])];
    if (!chartEl) return;
    chartEl.innerHTML = "";
    createChart(chartEl, {
      animationDuration: REDUCED ? 0 : 680,
      animationEasing: "cubicOut",
      tooltip: {
        ...tip,
        trigger: "axis",
        axisPointer: { type: "line", lineStyle: { color: T.track } },
        formatter: (params) => {
          const i = params[0].dataIndex;
          const date = p.dates[i];
          if (i >= n) {
            const k = i - n;
            return tipCard(
              tipHead(date, "预测", T.forecast) +
                tipRow(T.forecast, "数据量", fmt(p.forecast.values[k])) +
                tipRow(T.muted, "区间", `${fmt(p.forecast.lower[k])}–${fmt(p.forecast.upper[k])}`) +
                (p.synthetic ? `<div class="tip-path">历史样本不足，按原型趋势外推</div>` : "")
            );
          }
          return tipCard(tipHead(date, "实际", accent) + tipRow(accent, "数据量", fmt(p.values[i])));
        },
      },
      grid: { left: 28, right: 7, top: 8, bottom: 16 },
      xAxis: {
        type: "category",
        data: p.dates,
        boundaryGap: false,
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { fontSize: 7.5, color: T.faint, interval: 3, fontFamily: FONT },
      },
      yAxis: {
        type: "value",
        min: 0,
        splitNumber: 3,
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { fontSize: 7.5, color: T.faint, fontFamily: FONT, margin: 4 },
        splitLine: { lineStyle: { color: T.hairline, type: "dashed" } },
      },
      series: [
        { name: "下界", type: "line", data: lowerData, stack: "ci", symbol: "none", lineStyle: { opacity: 0 }, areaStyle: { opacity: 0 }, silent: true },
        { name: "区间", type: "line", data: bandData, stack: "ci", symbol: "none", lineStyle: { opacity: 0 }, areaStyle: { color: hexA(accent, 0.13) }, silent: true },
        {
          name: "实际", type: "line", data: actualData, smooth: 0.35, symbol: "none",
          lineStyle: { width: 2, color: accent }, areaStyle: { color: hexA(accent, 0.06) },
          markLine: { silent: true, symbol: "none", lineStyle: { color: T.faint, type: "dashed", width: 1, opacity: 0.55 }, label: { show: false }, data: [{ xAxis: p.dates[n - 1] }] },
        },
        { name: "预测", type: "line", data: forecastData, smooth: 0.35, symbol: "none", lineStyle: { width: 1.8, type: "dashed", color: T.forecast } },
      ],
    });
    return;
  }

  if (dim === "performance") {
    const p = performanceForecast(product);
    const next = p.forecast.values[0] || 0;
    const delta = next - p.last;
    setPredictHero(product, {
      value: next,
      decimals: 1,
      suffix: "%",
      unit: "覆盖率",
      trend: `${delta >= 0 ? "+" : ""}${delta.toFixed(1)} pp vs 昨日`,
      trendClass: delta >= 0 ? "trend-up" : "trend-down",
    });
    if (metaEl) metaEl.textContent = `未来 7 天${p.synthetic ? " · 原型" : ""}`;
    if (statsEl) {
      statsEl.innerHTML = predictStats([
        ["当前 P50", p.p50 ? p.p50.toFixed(1) + "s" : "—"],
        ["7 日 P50", p.p50Forecast ? p.p50Forecast.toFixed(1) + "s" : "—"],
        ["问题密度", (p.density || 0).toFixed(2)],
      ]);
    }
    const n = p.values.length;
    const actualData = [...p.values, ...Array(7).fill(null)];
    const forecastData = [...Array(n - 1).fill(null), p.values[n - 1], ...p.forecast.values];
    const lowerData = [...Array(n).fill(null), ...p.forecast.lower];
    const bandData = [...Array(n).fill(null), ...p.forecast.upper.map((u, i) => u - p.forecast.lower[i])];
    if (!chartEl) return;
    chartEl.innerHTML = "";
    createChart(chartEl, {
      animationDuration: REDUCED ? 0 : 680,
      animationEasing: "cubicOut",
      tooltip: {
        ...tip,
        trigger: "axis",
        axisPointer: { type: "line", lineStyle: { color: T.track } },
        formatter: (params) => {
          const i = params[0].dataIndex;
          const date = p.dates[i];
          if (i >= n) {
            const k = i - n;
            return tipCard(
              tipHead(date, "预测", T.forecast) +
                tipRow(T.forecast, "覆盖率", p.forecast.values[k].toFixed(1) + "%") +
                tipRow(T.muted, "区间", `${p.forecast.lower[k].toFixed(1)}–${p.forecast.upper[k].toFixed(1)}%`)
            );
          }
          return tipCard(tipHead(date, "实际", accent) + tipRow(accent, "覆盖率", p.values[i].toFixed(1) + "%"));
        },
      },
      grid: { left: 30, right: 7, top: 8, bottom: 16 },
      xAxis: {
        type: "category",
        data: p.dates,
        boundaryGap: false,
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { fontSize: 7.5, color: T.faint, interval: 3, fontFamily: FONT },
      },
      yAxis: {
        type: "value",
        min: 0,
        max: 100,
        splitNumber: 3,
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { fontSize: 7.5, color: T.faint, formatter: "{value}%", fontFamily: FONT, margin: 4 },
        splitLine: { lineStyle: { color: T.hairline, type: "dashed" } },
      },
      series: [
        { name: "下界", type: "line", data: lowerData, stack: "ci", symbol: "none", lineStyle: { opacity: 0 }, areaStyle: { opacity: 0 }, silent: true },
        { name: "区间", type: "line", data: bandData, stack: "ci", symbol: "none", lineStyle: { opacity: 0 }, areaStyle: { color: hexA(accent, 0.13) }, silent: true },
        {
          name: "实际", type: "line", data: actualData, smooth: 0.35, symbol: "none",
          lineStyle: { width: 2, color: accent }, areaStyle: { color: hexA(accent, 0.07) },
          markLine: { silent: true, symbol: "none", lineStyle: { color: T.faint, type: "dashed", width: 1, opacity: 0.55 }, label: { show: false }, data: [{ xAxis: p.dates[n - 1] }] },
        },
        { name: "预测", type: "line", data: forecastData, smooth: 0.35, symbol: "none", lineStyle: { width: 1.8, type: "dashed", color: T.forecast } },
      ],
    });
    return;
  }

  const p = attributionForecast(product);
  const top = p.cats[p.topIndex];
  setPredictHero(product, {
    value: p.topShare,
    decimals: 1,
    suffix: "%",
    unit: "主因占比",
    trend: `${p.topChange >= 0 ? "+" : ""}${p.topChange.toFixed(1)} pp vs 昨日`,
    trendClass: p.topChange >= 0 ? "trend-up" : "trend-down",
  });
  if (metaEl) metaEl.textContent = `未来 7 天${p.synthetic ? " · 原型" : " · 分级日"}`;
  if (statsEl) {
    statsEl.innerHTML = predictStats([
      ["主要归因", top ? top.name : "—", top ? top.color : null],
      ["7 日均值", p.topShare.toFixed(1) + "%"],
      ["类别数", `${p.cats.length} 类`],
    ]);
  }
  if (!chartEl) return;
  chartEl.innerHTML = "";
  const futureStart = p.dates[p.actual[0].length];
  const series = p.cats.map((cat, i) => ({
    name: cat.name,
    type: "line",
    stack: "share",
    data: [...p.actual[i], ...p.forecasts[i].values],
    smooth: 0.25,
    symbol: "none",
    lineStyle: { width: 1.1, color: hexA(cat.color, 0.8) },
    areaStyle: { color: hexA(cat.color, i === p.topIndex ? 0.3 : 0.18) },
    emphasis: { focus: "series" },
    markArea: i === 0 ? {
      silent: true,
      itemStyle: { color: hexA(T.ink, T.mode === "dark" ? 0.04 : 0.025) },
      data: [[{ xAxis: futureStart }, { xAxis: p.dates[p.dates.length - 1] }]],
    } : undefined,
    markLine: i === 0 ? {
      silent: true,
      symbol: "none",
      lineStyle: { color: T.faint, type: "dashed", width: 1, opacity: 0.5 },
      label: { show: false },
      data: [{ xAxis: futureStart }],
    } : undefined,
  }));
  createChart(chartEl, {
    animationDuration: REDUCED ? 0 : 680,
    animationEasing: "cubicOut",
    tooltip: {
      ...tip,
      trigger: "axis",
      axisPointer: { type: "line", lineStyle: { color: T.track } },
      formatter: (params) => {
        const i = params[0].dataIndex;
        const date = p.dates[i];
        const future = i >= p.actual[0].length;
        const rows = params
          .filter((x) => x.value != null)
          .sort((a, b) => b.value - a.value)
          .map((x) => tipRow(x.color, x.seriesName, Number(x.value).toFixed(1) + "%"))
          .join("");
        return tipCard(tipHead(date, future ? "预测构成" : "实际构成", T.forecast) + rows + (p.synthetic ? `<div class="tip-path">历史分日数据不足，按原型分布外推</div>` : ""));
      },
    },
    grid: { left: 30, right: 7, top: 8, bottom: 16 },
    xAxis: {
      type: "category",
      data: p.dates,
      boundaryGap: false,
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { fontSize: 7.5, color: T.faint, interval: 3, fontFamily: FONT },
    },
    yAxis: {
      type: "value",
      min: 0,
      max: 100,
      splitNumber: 3,
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { fontSize: 7.5, color: T.faint, formatter: "{value}%", fontFamily: FONT, margin: 4 },
      splitLine: { lineStyle: { color: T.hairline, type: "dashed" } },
    },
    series,
  });
}

function bindPredictTabs(product) {
  const tabs = $(isWc(product) ? "wcPredictTabs" : "aiPredictTabs");
  if (!tabs) return;
  tabs.onclick = (ev) => {
    const tab = ev.target.closest(".predict-tab");
    if (!tab) return;
    board.predict[product].dim = tab.dataset.dim;
    renderPrediction(product);
  };
  tabs.onkeydown = (ev) => {
    if (ev.key !== "ArrowLeft" && ev.key !== "ArrowRight") return;
    ev.preventDefault();
    const order = ["volume", "performance", "attribution"];
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
}

function renderAll() {
  if (!board.data) return;
  renderProduct("wencai");
  renderProduct("aime");
}

export function initBoard(data, opts = {}) {
  board.data = data;
  board.opts = opts || {};
  readTokens();
  bindPredictTabs("wencai");
  bindPredictTabs("aime");
  renderAll();
}

export function setBoardProduct(product) {
  if (!["wencai", "aime"].includes(product)) return;
  board.product = product;
  document.querySelectorAll('.view--data .page').forEach((page) => {
    const on = page.dataset.product === product;
    page.classList.toggle("is-active", on);
    page.setAttribute("aria-hidden", String(!on));
  });
  resizeAllCharts();
  window.setTimeout(resizeAllCharts, 60);
}

export function refreshBoard() {
  readTokens();
  renderAll();
}

export function resizeBoard() {
  resizeAllCharts();
}

export function getBoardProduct() {
  return board.product;
}
