/* Eval dashboard — 问财 / AIME, one visual system: 数据量 → 评测量 → 归因体系. */
(function () {
  const $ = (id) => document.getElementById(id);
  const FONT =
    '"Inter","SF Pro Text",-apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif';
  const REDUCED = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const charts = [];
  const volumeState = {
    wencai: { src: null, task: null },
    aime: { src: null, task: null },
  };
  const clusterState = {
    wencai: { src: null, stack: [], root: null },
    aime: { src: null, stack: [], root: null },
  };
  const clusterCharts = {};
  const volumeCharts = {};
  let resizeRaf = 0;
  const resizeQueue = new Set();
  let DATA = null;

  // ------------------------------------------------------- design tokens
  // 颜色/字重/动效全部来自 CSS 变量，暗色模式下自动换一套；
  // 图表不能吃 CSS，所以通过 getComputedStyle 把 token 读给 ECharts。
  let T = {};
  let C = {};
  let SEV_COLOR = {};
  let tip = {};

  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  function readTokens() {
    const names = [
      "bg", "surface", "surface-2", "surface-3", "tooltip", "track", "hairline",
      "ink", "ink-2", "muted", "faint",
      "wc", "wc-mid", "wc-soft", "ai", "ai-mid", "ai-light", "ai-soft",
      "b", "b-mid", "forecast", "sev-0", "sev-1", "sev-2", "sev-3", "sev-4",
      "cl-1", "cl-2", "cl-3", "cl-4", "cl-5", "cl-6",
    ];
    T = {};
    names.forEach((n) => {
      const key = n.replace(/-(\w)/g, (_, c) => c.toUpperCase());
      // 保留原 key + camelCase 两份，写图表配置时更省事
      T[key] = cssVar(`--${n}`);
    });
    T.mode = document.documentElement.dataset.mode || "light";

    C = {
      a: T.wc,
      aMid: T.wcMid,
      b: T.b,
      bMid: T.bMid,
      ai: T.ai,
      aiMid: T.aiMid,
      aiLight: T.aiLight,
    };

    SEV_COLOR = {
      P0: T.sev0,
      P1: T.sev1,
      P2: T.sev2,
      P3: T.sev3,
      未分级: T.sev4,
    };

    tip = {
      backgroundColor: T.tooltip,
      borderColor: "transparent",
      borderWidth: 0,
      padding: 0,
      textStyle: { color: T.ink, fontSize: 11, fontFamily: FONT },
      extraCssText: `border-radius:12px;box-shadow:0 16px 36px -16px ${
        T.mode === "dark" ? "rgba(0,0,0,.8)" : "rgba(15,23,42,.35)"
      };`,
      appendToBody: true,
      confine: false,
    };
  }

  function chartPalette() {
    return {
      cluster: [T.cl1, T.cl2, T.cl3, T.cl4, T.cl5, T.cl6],
    };
  }

  const AIME_SEVERITIES = ["P0", "P1", "P2", "P3", "未分级"];

  const fmt = (n) => (n == null || Number.isNaN(Number(n)) ? "—" : Number(n).toLocaleString("en-US"));
  const fmtFixed = (n, d) =>
    Number(n).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
  const pct = (a, b) => (b ? (100 * a) / b : 0);
  const fmtTokens = (n) => {
    if (!n) return "—";
    if (n >= 1e9) return (n / 1e9).toFixed(1) + "B";
    if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
    if (n >= 1e3) return Math.round(n / 1e3) + "K";
    return String(n);
  };
  const dateRange = (r) => {
    if (!r) return "—";
    return r.start === r.end ? r.start : `${r.start.slice(5)} → ${r.end.slice(5)}`;
  };
  const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

  function lerpColor(a, b, t) {
    const pa = parseInt(a.slice(1), 16);
    const pb = parseInt(b.slice(1), 16);
    const mix = (s) =>
      Math.round(((pa >> s) & 255) + (((pb >> s) & 255) - ((pa >> s) & 255)) * clamp(t, 0, 1));
    return (
      "#" +
      [16, 8, 0]
        .map((s) => mix(s).toString(16).padStart(2, "0"))
        .join("")
    );
  }

  function hexA(hex, alpha) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
  }

  function labelOn(hex) {
    const n = parseInt(hex.slice(1), 16);
    const lin = (c) => {
      const v = c / 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    };
    const L =
      0.2126 * lin((n >> 16) & 255) +
      0.7152 * lin((n >> 8) & 255) +
      0.0722 * lin(n & 255);
    const white = 1.05 / (L + 0.05);
    const black = (L + 0.05) / 0.05;
    return white >= black ? "#ffffff" : T.mode === "dark" ? "#0e1217" : T.ink;
  }

  const abColor = (bShare) =>
    bShare <= 0.5
      ? lerpColor(C.a, T.track, bShare * 2)
      : lerpColor(T.track, C.b, (bShare - 0.5) * 2);

  readTokens();

  // ---------------------------------------------------------------- tooltip
  const tipCard = (html) => `<div class="tip-card">${html}</div>`;
  const tipHead = (title, meta, color) =>
    `<div class="tip-head"><i style="background:${color || T.muted}"></i><span>${title}</span>` +
    `${meta ? `<em>${meta}</em>` : ""}</div>`;
  const tipSep = () => `<div class="tip-sep"></div>`;
  const tipRow = (color, label, value) =>
    `<div class="tip-row"><i style="background:${color}"></i><span>${label}</span><b>${value}</b></div>`;

  // ------------------------------------------------------------------ utils
  const fmtBytes = (n) => {
    if (!n) return "—";
    const units = ["B", "KB", "MB", "GB", "TB"];
    let v = Number(n);
    let i = 0;
    while (v >= 1024 && i < units.length - 1) {
      v /= 1024;
      i += 1;
    }
    return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
  };

  // 数字锁宽：tabular-nums 保证单个数字等宽，min-width 兜住位数变化，
  // 计数动画和集群下钻都不会把右侧元素推来推去。
  function lockNum(el, value, decimals) {
    if (!el) return;
    const s = fmtFixed(Number(value) || 0, decimals || 0);
    const width = s.length - (s.includes(",") ? 0.35 : 0);
    el.style.minWidth = `${Math.max(2, width).toFixed(2)}ch`;
  }

  function setNum(id, value, opts) {
    const el = $(id);
    if (!el) return;
    el.dataset.count = String(value == null ? 0 : value);
    if (opts && opts.decimals != null) el.dataset.decimals = String(opts.decimals);
    if (opts && opts.suffix) el.dataset.suffix = opts.suffix;
    lockNum(el, value, (opts && opts.decimals) || 0);
  }

  function settleCounters() {
    document.querySelectorAll("[data-count]").forEach((el) => {
      const end = Number(el.dataset.count);
      if (!Number.isFinite(end)) return;
      const decimals = Number(el.dataset.decimals || 0);
      el._numToken = (el._numToken || 0) + 1;
      el.textContent = fmtFixed(end, decimals) + (el.dataset.suffix || "");
    });
  }

  // 自绘数字补间：只有一条 rAF 链，结束帧强制写终值，
  // 不会出现 CountUp 最后一帧差 1 的问题，也不会和 tabular 锁宽打架。
  function tweenNumber(el, end, decimals, suffix, duration) {
    const d = decimals || 0;
    const token = (el._numToken = (el._numToken || 0) + 1);
    const started = performance.now();
    const ms = Math.max(1, duration);
    const step = (now) => {
      if (el._numToken !== token) return;
      const p = Math.min(1, (now - started) / ms);
      const eased = 1 - Math.pow(1 - p, 3);
      if (p >= 1) {
        el.textContent = fmtFixed(end, d) + suffix;
        return;
      }
      el.textContent = fmtFixed(end * eased, d) + suffix;
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  function startCounters(duration) {
    document.querySelectorAll("[data-count]").forEach((el) => {
      const end = Number(el.dataset.count);
      if (!Number.isFinite(end)) return;
      const decimals = Number(el.dataset.decimals || 0);
      const suffix = el.dataset.suffix || "";
      lockNum(el, end, decimals);
      if (REDUCED) {
        el.textContent = fmtFixed(end, decimals) + suffix;
        return;
      }
      tweenNumber(el, end, decimals, suffix, (duration || 0.8) * 1000);
    });
  }

  function bump(el) {
    if (!el || REDUCED) return;
    el.classList.remove("is-bump");
    void el.offsetWidth;
    el.classList.add("is-bump");
    window.setTimeout(() => el.classList.remove("is-bump"), 380);
  }

  function animateTo(id, value, decimals) {
    const el = $(id);
    if (!el) return;
    const d = decimals || 0;
    el.dataset.count = String(value == null ? 0 : value);
    lockNum(el, value, d);
    bump(el);
    if (REDUCED) {
      el.textContent = fmtFixed(value || 0, d);
      return;
    }
    tweenNumber(el, value || 0, d, "", 450);
  }

  function scheduleResize(chart, el) {
    if (!el.clientWidth || !el.clientHeight) return;
    resizeQueue.add(chart);
    if (resizeRaf) return;
    resizeRaf = requestAnimationFrame(() => {
      resizeRaf = 0;
      resizeQueue.forEach((c) => c.resize());
      resizeQueue.clear();
    });
  }

  function chart(id, option) {
    const el = $(id);
    if (!el || typeof echarts === "undefined") return null;
    const c = echarts.init(el, null, { renderer: "canvas" });
    c.setOption(option);
    charts.push(c);
    if (window.ResizeObserver) {
      const ro = new ResizeObserver(() => scheduleResize(c, el));
      c.__ro = ro;
      ro.observe(el);
    }
    return c;
  }

  // ----------------------------------------------------------- volume drill
  const TASK_HIDE = new Set(["其他", "其它", "未标注"]);

  function tasksOf(src, isWc) {
    let cats = [...((src.input.categories && src.input.categories.task) || [])]
      .map((c) => ({ ...c }))
      .filter((c) => c.name !== "未标注")
      .sort((a, b) => (b.value || 0) - (a.value || 0));
    if (isWc) {
      cats = cats.filter((c) => !TASK_HIDE.has(c.name));
    } else {
      // AIME 的「其它」并进「其他」，避免两个同义块；其他保留，尾部仍有量。
      const other = cats.find((c) => c.name === "其他");
      const qita = cats.find((c) => c.name === "其它");
      if (qita) {
        if (other) other.value += qita.value;
        else cats.push({ name: "其他", value: qita.value });
        cats = cats.filter((c) => c.name !== "其它");
      }
      cats.sort((a, b) => (b.value || 0) - (a.value || 0));
    }
    return cats;
  }

  function subtasksOf(src, task, isWc) {
    if (task === "其他" || task === "其它") return [];
    const map = (src.input.categories && src.input.categories.task_subtask) || {};
    const subs = (map[task] || []).filter((c) => c.name !== "未标注");
    const taskValue = (tasksOf(src, isWc).find((t) => t.name === task) || {}).value || 0;
    const sum = subs.reduce((n, c) => n + (c.value || 0), 0);
    if (taskValue > sum) subs.push({ name: "其他", value: taskValue - sum });
    return subs;
  }

  function isDrillable(src, task, isWc) {
    return subtasksOf(src, task, isWc).length > 0;
  }

  function volumeColor(isWc, i, n) {
    const from = isWc ? T.wc : T.ai;
    const to = T.mode === "dark" ? T.surface3 : T.track;
    return lerpColor(from, to, n > 1 ? (i / (n - 1)) * 0.72 : 0);
  }

  function updateVolumeNote(product) {
    const isWc = product === "wencai";
    const st = volumeState[product];
    const back = $(isWc ? "wcVolBack" : "aiVolBack");
    const note = $(isWc ? "wcVolNote" : "aiVolNote");
    const right = $(isWc ? "wcVolMax" : "aiVolMax");
    if (st.task) {
      back.hidden = false;
      note.textContent = st.task;
      const total = subtasksOf(st.src, st.task, isWc).reduce((n, c) => n + (c.value || 0), 0);
      right.innerHTML = `${fmt(total)} <span>条 · ${pct(total, st.src.input.total).toFixed(1)}%</span>`;
    } else {
      back.hidden = true;
      note.textContent = "面积 = 条数";
      const top = tasksOf(st.src, isWc)[0];
      right.innerHTML = top
        ? `最大类 ${top.name} <b>${pct(top.value, st.src.input.total).toFixed(1)}%</b>`
        : "—";
    }
  }

  function disposeVolumeChart(product) {
    const c = volumeCharts[product];
    if (!c) return;
    const i = charts.indexOf(c);
    if (i >= 0) charts.splice(i, 1);
    resizeQueue.delete(c);
    if (c.__ro) c.__ro.disconnect();
    try {
      c.dispose();
    } catch (e) {}
    delete volumeCharts[product];
  }

  function renderTaskTreemap(product) {
    const isWc = product === "wencai";
    const st = volumeState[product];
    const id = isWc ? "wcTaskChart" : "aiTaskChart";
    const el = $(id);
    if (!el) return;
    const tasks = tasksOf(st.src, isWc);
    const total = st.src.input.total || tasks.reduce((n, c) => n + (c.value || 0), 0) || 1;
    const data = tasks.map((c, i) => {
      const color = volumeColor(isWc, i, tasks.length);
      return {
        name: c.name,
        value: c.value,
        drillable: isDrillable(st.src, c.name, isWc),
        itemStyle: { color },
        label: { color: labelOn(color) },
      };
    });
    disposeVolumeChart(product);
    const c = chart(id, {
      animationDuration: REDUCED ? 0 : 560,
      animationEasing: "cubicOut",
      tooltip: {
        ...tip,
        formatter: (p) =>
          tipCard(
            tipHead(p.name, `${pct(p.value, total).toFixed(1)}%`, p.color) +
              tipRow(p.color, "条数", fmt(p.value)) +
              (p.data && p.data.drillable ? `<div class="tip-path">点击方块查看子类</div>` : "")
          ),
      },
      series: [
        {
          type: "treemap",
          left: 0,
          right: 0,
          top: 0,
          bottom: 0,
          roam: false,
          nodeClick: false,
          breadcrumb: { show: false },
          sort: "desc",
          itemStyle: {
            borderColor: T.surface,
            borderWidth: 2,
            gapWidth: 2,
            borderRadius: 6,
          },
          label: {
            show: true,
            fontSize: 10.5,
            lineHeight: 14.5,
            overflow: "truncate",
            formatter: (p) => {
              const share = pct(p.value, total);
              if (share >= 4) return `${p.name}\n${fmt(p.value)} · ${share.toFixed(1)}%`;
              if (share >= 2) return p.name;
              return fmt(p.value);
            },
          },
          upperLabel: { show: false },
          emphasis: {
            itemStyle: { borderColor: T.ink2, borderWidth: 1 },
          },
          data,
        },
      ],
    });
    volumeCharts[product] = c;
    if (c) {
      c.on("click", (p) => {
        const st2 = volumeState[product];
        if (!p.data || !p.data.name) return;
        if (!isDrillable(st2.src, p.data.name, isWc)) return;
        st2.task = p.data.name;
        drawVolume(product);
      });
    }
    el.style.cursor = data.some((d) => d.drillable) ? "pointer" : "default";
  }

  function renderTaskCompact(product) {
    const isWc = product === "wencai";
    const st = volumeState[product];
    const el = $(isWc ? "wcTaskCompact" : "aiTaskCompact");
    if (!el) return;
    const tasks = tasksOf(st.src, isWc);
    const total = st.src.input.total || tasks.reduce((n, c) => n + (c.value || 0), 0) || 1;
    el.innerHTML = tasks
      .map((c) => {
        const share = pct(c.value, total);
        const drillable = isDrillable(st.src, c.name, isWc);
        return (
          `<button class="tc-row" type="button" data-task="${c.name}" data-drill="${drillable ? 1 : 0}"` +
          ` title="${c.name} · ${fmt(c.value)} 条 · ${share.toFixed(1)}%">` +
          `<span class="tc-name">${c.name}</span>` +
          `<span class="tc-val">${fmt(c.value)}</span>` +
          `<span class="tc-pct">${share.toFixed(1)}%</span>` +
          `</button>`
        );
      })
      .join("");
  }

  function renderSubList(product) {
    const isWc = product === "wencai";
    const st = volumeState[product];
    const list = $(isWc ? "wcSubList" : "aiSubList");
    if (!list) return;
    const subs = subtasksOf(st.src, st.task, isWc);
    const total = subs.reduce((n, c) => n + (c.value || 0), 0) || 1;
    const max = Math.max(1, ...subs.map((c) => c.value || 0));
    list.innerHTML = subs
      .map((c, i) => {
        const share = pct(c.value, total);
        const ratio = (c.value || 0) / max;
        const a = T.mode === "dark" ? 0.04 + ratio * 0.18 : 0.025 + ratio * 0.14;
        const bg = hexA(isWc ? T.wc : T.ai, a.toFixed(3));
        return (
          `<div class="sub-row" style="background:${bg}" title="${c.name} · ${fmt(c.value)} 条 · ${share.toFixed(1)}%">` +
          `<span class="sub-rank">${i + 1}</span>` +
          `<span class="sub-name">${c.name}</span>` +
          `<span class="sub-val">${fmt(c.value)}</span>` +
          `<span class="sub-pct">${share.toFixed(1)}%</span>` +
          `</div>`
        );
      })
      .join("");
  }

  function drawVolume(product, rebuild) {
    const isWc = product === "wencai";
    const st = volumeState[product];
    const chartEl = $(isWc ? "wcTaskChart" : "aiTaskChart");
    const compactEl = $(isWc ? "wcTaskCompact" : "aiTaskCompact");
    const subList = $(isWc ? "wcSubList" : "aiSubList");
    if (!st.src || !chartEl || !compactEl || !subList) return;
    if (st.task) {
      chartEl.hidden = true;
      compactEl.hidden = true;
      subList.hidden = false;
      renderSubList(product);
    } else {
      subList.hidden = true;
      chartEl.hidden = false;
      compactEl.hidden = false;
      if (rebuild || !volumeCharts[product]) renderTaskTreemap(product);
      renderTaskCompact(product);
      requestAnimationFrame(() => {
        const c = volumeCharts[product];
        if (c) c.resize();
      });
    }
    updateVolumeNote(product);
  }

  // -------------------------------------------------------------- volume card
  function renderVolume(product, d) {
    const isWc = product === "wencai";
    const src = isWc ? d.wencai : d.aime;
    const prev = volumeState[product];
    volumeState[product] = { src, task: (prev && prev.task) || null };

    const compact = $(isWc ? "wcTaskCompact" : "aiTaskCompact");
    if (compact) {
      compact.onclick = (ev) => {
        const row = ev.target.closest(".tc-row");
        if (!row || row.dataset.drill === "0") return;
        const st = volumeState[product];
        if (!isDrillable(st.src, row.dataset.task, isWc)) return;
        st.task = row.dataset.task;
        drawVolume(product);
      };
    }
    const back = $(isWc ? "wcVolBack" : "aiVolBack");
    if (back) {
      back.onclick = () => {
        volumeState[product].task = null;
        drawVolume(product, true);
      };
    }

    drawVolume(product, true);
    const input = src.input;
    const days = (input.per_day && input.per_day.length) || 1;
    setNum(isWc ? "wcTotal" : "aiTotal", input.total);
    $(isWc ? "wcVolMeta" : "aiVolMeta").textContent = dateRange(input.date_range);
    $(isWc ? "wcVolSide" : "aiVolSide").innerHTML =
      `活跃日均 <b>${fmt(Math.round(input.total / days))}</b> 条`;
    $(isWc ? "wcVolStats" : "aiVolStats").innerHTML = [
      ["体量", fmtBytes(input.bytes)],
      ["文件", fmt(input.files)],
      ["活跃", `${fmt(days)} 天`],
      ["已评测", fmt(input.evaluated)],
    ]
      .map(([label, value]) => `<span>${label} <b>${value}</b></span>`)
      .join("");
  }

  // ------------------------------------------------------------ coverage card
  function renderRing(id, evaluated, pending, color) {
    const total = evaluated + pending;
    chart(id, {
      animationDuration: REDUCED ? 0 : 660,
      animationEasing: "cubicOut",
      animationDelay: REDUCED ? 0 : 120,
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
          radius: ["72%", "94%"],
          center: ["50%", "50%"],
          startAngle: 90,
          avoidLabelOverlap: false,
          label: { show: false },
          labelLine: { show: false },
          itemStyle: { borderWidth: 0, borderRadius: 6 },
          emphasis: {
            scale: true,
            scaleSize: 2,
            itemStyle: { shadowBlur: 12, shadowColor: "rgba(15,23,42,.18)" },
          },
          data: [
            { value: evaluated, name: "已评测", itemStyle: { color } },
            { value: Math.max(0, pending), name: "待评测", itemStyle: { color: T.track } },
          ],
        },
      ],
    });
  }

  function renderVersionTable(out, defs) {
    const el = $("wcModels");
    if (!el) return;
    const rows = defs.map(([key, name, color]) => ({
      name,
      color,
      value: (out.versions[key] && out.versions[key].answers) || 0,
      p50: (out.versions[key] && out.versions[key].p50) || 0,
      core: (out.meets_core && out.meets_core[key]) || 0,
      tokens: (out.versions[key] && out.versions[key].tokens) || 0,
    }));
    const p50s = rows.map((r) => r.p50).filter((v) => v > 0);
    const fastest = p50s.length ? Math.min(...p50s) : 0;
    const slowest = p50s.length ? Math.max(...p50s) : 0;
    const bestCore = Math.max(0, ...rows.map((r) => r.core));
    el.innerHTML =
      `<div class="v-head"><span>版本</span><span>回答</span><span>P50</span><span>核心</span><span>Tokens</span></div>` +
      rows
        .map(
          (r) =>
            `<div class="v-row" title="${r.name} · ${fmt(r.value)} 条 · P50 ${r.p50.toFixed(1)}s · 核心 ${r.core.toFixed(1)}% · ${fmt(r.tokens)} tokens">` +
            `<span class="v-name"><i class="v-dot" style="background:${r.color}"></i>${r.name}</span>` +
            `<span class="v-val">${fmt(r.value)}</span>` +
            `<span class="v-p50${r.p50 === fastest ? " is-fast" : ""}${r.p50 === slowest ? " is-slow" : ""}">${r.p50 ? r.p50.toFixed(1) + "s" : "—"}</span>` +
            `<span class="v-core${r.core === bestCore ? " is-best" : ""}">${r.core ? r.core.toFixed(1) + "%" : "—"}</span>` +
            `<span class="v-tokens">${fmtTokens(r.tokens)}</span>` +
            `</div>`
        )
        .join("");
  }

  function renderModelTiles(out) {
    const el = $("aiModels");
    if (!el) return;
    el.classList.add("model-tiles");
    const rows = [
      { name: "fast", color: C.aiMid, value: (out.by_model && out.by_model.fast) || 0 },
      { name: "expert", color: C.aiLight, value: (out.by_model && out.by_model.expert) || 0 },
    ];
    const total = rows.reduce((n, r) => n + r.value, 0) || 1;
    el.innerHTML = rows
      .map(
        (r) =>
          `<div class="model-tile" title="${r.name} · ${fmt(r.value)} 条 · ${pct(r.value, total).toFixed(1)}%">` +
          `<span class="mt-head"><i class="mt-dot" style="background:${r.color}"></i>${r.name}</span>` +
          `<b class="mt-value">${fmt(r.value)}</b>` +
          `<span class="mt-share">${pct(r.value, total).toFixed(1)}% · ${fmt(r.value)} 条</span>` +
          `</div>`
      )
      .join("");
  }
  function renderEvaluation(product, d) {
    const isWc = product === "wencai";
    const src = isWc ? d.wencai : d.aime;
    const out = src.output;
    const input = src.input;
    const evaluated = input.evaluated || 0;
    const pending = input.pending || 0;

    setNum(isWc ? "wcEvaluated" : "aiEvaluated", evaluated);
    setNum(isWc ? "wcCoverPct" : "aiCoverPct", pct(evaluated, input.total), {
      decimals: 1,
      suffix: "%",
    });
    $(isWc ? "wcPending" : "aiPending").textContent = fmt(pending);
    $(isWc ? "wcEvalNote" : "aiEvalNote").innerHTML =
      `<b>${(out.problems / Math.max(1, evaluated)).toFixed(1)}</b> 问题/回答`;
    $(isWc ? "wcEvalMeta" : "aiEvalMeta").textContent = isWc
      ? `比对 ${fmt(out.comparison_total)} 组`
      : `密度 ${(out.density || 0).toFixed(2)} 条/回答`;

    let p50 = out.p50 || 0;
    if (isWc) {
      const vals = Object.values(out.versions || {})
        .map((v) => v.p50)
        .filter((v) => v > 0);
      p50 = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
    }
    let core = 0;
    if (isWc) {
      let num = 0;
      let den = 0;
      Object.entries(out.meets_core || {}).forEach(([key, value]) => {
        const n = (out.versions[key] && out.versions[key].answers) || 0;
        num += value * n;
        den += n;
      });
      core = den ? num / den : 0;
    }
    $(isWc ? "wcEvalStats" : "aiEvalStats").innerHTML = (
      isWc
        ? [
            ["问题", fmt(out.problems)],
            ["Tokens", fmtTokens(out.tokens || 0)],
            ["P50", p50 ? p50.toFixed(1) + "s" : "—"],
            ["核心达标", core ? core.toFixed(1) + "%" : "—"],
          ]
        : [
            ["问题", fmt(out.problems)],
            ["Tokens", fmtTokens(out.tokens || 0)],
            ["P50", p50 ? p50.toFixed(1) + "s" : "—"],
            ["密度", (out.density || 0).toFixed(2)],
          ]
    )
      .map(([label, value]) => `<span><em>${label}</em><b>${value}</b></span>`)
      .join("");

    renderRing(
      isWc ? "wcCover" : "aiCover",
      evaluated,
      pending,
      isWc ? C.a : C.ai
    );

    if (isWc) {
      const defs = [
        ["a_expert", "A·expert", C.a],
        ["a_fast", "A·fast", C.aMid],
        ["b_expert", "B·expert", C.b],
        ["b_fast", "B·fast", C.bMid],
      ];
      renderVersionTable(out, defs);
      renderDifficulty(d);
      renderEvalInsights(out, defs);
    } else {
      renderModelTiles(out);
      renderSpark(out.per_day || []);
      renderTaskMini(out);
    }
  }

  function renderTaskMini(out) {
    const el = $("aiEvalTasks");
    if (!el) return;
    const source =
      out.subtasks && Object.keys(out.subtasks).length ? out.subtasks : out.tasks || {};
    const all = Object.entries(source);
    const total = all.reduce((n, [, v]) => n + v, 0) || out.task_total || 1;
    const rows = all
      .filter(([name]) => name !== "其它" && name !== "未标注" && name !== "其他")
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
            `<div class="mini-row" title="${name} · ${fmt(value)} 条 · ${pct(value, total).toFixed(1)}%">` +
            `<i class="mini-bubble" style="width:${size}px;height:${size}px;background:${hexA(C.aiMid, alpha)}"></i>` +
            `<span class="mini-name">${name}</span>` +
            `<span class="mini-val">${fmt(value)}</span>` +
            `<span class="mini-pct">${pct(value, total).toFixed(1)}%</span>` +
            `</div>`
          );
        })
        .join("");
  }

  function renderEvalInsights(out, defs) {
    const el = $("wcEvalInsights");
    if (!el) return;
    const rows = defs.map(([key, name]) => {
      const v = out.versions[key] || {};
      return {
        name,
        p50: v.p50 || 0,
        core: (out.meets_core && out.meets_core[key]) || 0,
      };
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

  function renderDifficulty(d) {
    const el = $("wcDifficulty");
    if (!el) return;
    const order = ["简单", "中等", "困难", "复杂"];
    const colors = { 简单: T.wcMid, 中等: T.wc, 困难: T.bMid, 复杂: T.b };
    const counts = {};
    let total = 0;
    Object.values(d.wencai.output.versions || {}).forEach((v) => {
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

  function renderSpark(perDay) {
    const values = perDay.map((x) => ({
      date: x.date,
      value: (x.fast || 0) + (x.expert || 0),
    }));
    const peak = values.reduce(
      (best, x) => (x.value > best.value ? x : best),
      { date: "—", value: 0 }
    );
    $("aiSparkPeak").innerHTML = `峰值 <b>${fmt(peak.value)}</b> · ${peak.date.slice(5)}`;
    $("aiSparkStart").textContent = values.length ? values[0].date.slice(5) : "";
    $("aiSparkEnd").textContent = values.length ? values[values.length - 1].date.slice(5) : "";
    const max = Math.max(1, ...values.map((x) => x.value));
    $("aiSpark").innerHTML = values
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
      $("aiSpark")
        .querySelectorAll(".spark-bar")
        .forEach((b) => {
          b.style.height = b.style.getPropertyValue("--h");
        });
    if (REDUCED) animate();
    else requestAnimationFrame(animate);
  }

  // ---------------------------------------------------------- attribution kit
  function renderAttrRows(id, rows, mode) {
    const el = $(id);
    if (!el) return;
    el.className = `attr-matrix ${mode}`;
    const sum = rows.reduce((n, r) => n + (r.value || 0), 0) || 1;
    const maxTotal = Math.max(1, ...rows.map((r) => r.value || 0));
    const heatA = (ratio) => {
      const a = T.mode === "dark" ? 0.1 + ratio * 0.38 : 0.06 + ratio * 0.32;
      return hexA(T.wc, a.toFixed(2));
    };
    const heatB = (ratio) => {
      const a = T.mode === "dark" ? 0.1 + ratio * 0.38 : 0.06 + ratio * 0.32;
      return hexA(T.b, a.toFixed(2));
    };
    const rowTint = (ratio) => {
      const base = mode === "wc" ? T.wc : T.ink2;
      const a = T.mode === "dark" ? 0.03 + ratio * 0.06 : 0.015 + ratio * 0.045;
      return hexA(base, a.toFixed(3));
    };

    let head = "";
    let body = "";
    if (mode === "wc") {
      const maxA = Math.max(1, ...rows.map((r) => r.a || 0));
      const maxB = Math.max(1, ...rows.map((r) => r.b || 0));
      head =
        `<div class="am-row am-head-row">` +
        `<div class="am-head am-name">环节</div>` +
        `<div class="am-head"><i class="am-dot" style="background:${T.wc}"></i>A 组</div>` +
        `<div class="am-head"><i class="am-dot" style="background:${T.b}"></i>B 组</div>` +
        `<div class="am-head">合计</div><div class="am-head">占比</div>` +
        `</div>`;
      body = rows
        .map((r) => {
          const share = pct(r.value, sum);
          return (
            `<div class="am-row" style="background:${rowTint((r.value || 0) / maxTotal)}">` +
            `<div class="am-name" title="${r.name}">${r.name}</div>` +
            `<div class="am-cell${r.a ? "" : " is-zero"}" style="background:${r.a ? heatA(r.a / maxA) : ""}" title="${r.name} · A 组 ${fmt(r.a)}">${r.a ? fmt(r.a) : "·"}</div>` +
            `<div class="am-cell${r.b ? "" : " is-zero"}" style="background:${r.b ? heatB(r.b / maxB) : ""}" title="${r.name} · B 组 ${fmt(r.b)}">${r.b ? fmt(r.b) : "·"}</div>` +
            `<div class="am-total">${fmt(r.value)}</div>` +
            `<div class="am-pct">${share.toFixed(1)}%</div>` +
            `</div>`
          );
        })
        .join("");
    } else {
      const maxSev = {};
      AIME_SEVERITIES.forEach((s) => {
        maxSev[s] = Math.max(1, ...rows.map((r) => r.severity[s] || 0));
      });
      head =
        `<div class="am-row am-head-row">` +
        `<div class="am-head am-name">环节</div>` +
        AIME_SEVERITIES.map(
          (s) =>
            `<div class="am-head"><i class="am-dot" style="background:${SEV_COLOR[s]}"></i>${s}</div>`
        ).join("") +
        `<div class="am-head">合计</div><div class="am-head">占比</div>` +
        `</div>`;
      body = rows
        .map((r) => {
          const share = pct(r.value, sum);
          const cells = AIME_SEVERITIES.map((s) => {
            const v = r.severity[s] || 0;
            const ratio = v / maxSev[s];
            const a = T.mode === "dark" ? 0.09 + ratio * 0.4 : 0.05 + ratio * 0.36;
            return `<div class="am-cell${v ? "" : " is-zero"}" style="background:${v ? hexA(SEV_COLOR[s], a.toFixed(2)) : ""}" title="${r.name} · ${s} ${fmt(v)}">${v ? fmt(v) : "·"}</div>`;
          }).join("");
          return (
            `<div class="am-row" style="background:${rowTint((r.value || 0) / maxTotal)}">` +
            `<div class="am-name" title="${r.name}">${r.name}</div>` +
            cells +
            `<div class="am-total">${fmt(r.value)}</div>` +
            `<div class="am-pct">${share.toFixed(1)}%</div>` +
            `</div>`
          );
        })
        .join("");
    }
    el.innerHTML = head + body;
  }

  function renderWencaiAttr(d) {
    const comp = d.wencai.components;
    const out = d.wencai.output;
    const totalA = ["a_expert", "a_fast"].reduce(
      (s, k) => s + ((out.versions[k] && out.versions[k].problems) || 0),
      0
    );
    const totalB = ["b_expert", "b_fast"].reduce(
      (s, k) => s + ((out.versions[k] && out.versions[k].problems) || 0),
      0
    );

    const names = (comp.names || []).slice();
    const A = (comp.A || []).slice();
    const B = (comp.B || []).slice();
    const sumA = A.reduce((s, v) => s + v, 0);
    const sumB = B.reduce((s, v) => s + v, 0);
    if (totalA > sumA || totalB > sumB) {
      names.push("其他");
      A.push(Math.max(0, totalA - sumA));
      B.push(Math.max(0, totalB - sumB));
    }

    const rows = names.map((name, i) => {
      const a = A[i] || 0;
      const b = B[i] || 0;
      return { name, a, b, value: a + b };
    });

    $("wcAttrSide").innerHTML = `A 组 <b>${fmt(totalA)}</b> · B 组 <b>${fmt(totalB)}</b>`;
    $("wcAttrMeta").textContent = `${rows.length} 类环节`;
    setNum("wcProblems", out.problems);
    renderAttrRows("wcAttr", rows, "wc");
  }

  function renderAimeAttr(d) {
    const out = d.aime.output;
    const comp = out.components || {};
    const names = (comp.names || []).slice();
    const fast = (comp.fast || []).slice();
    const expert = (comp.expert || []).slice();
    const severity = {};
    names.forEach((n) => {
      severity[n] = { ...(comp.severity[n] || {}) };
    });

    const componentTotal = fast.reduce((s, v) => s + v, 0) + expert.reduce((s, v) => s + v, 0);
    if (out.problems > componentTotal) {
      const rest = {};
      AIME_SEVERITIES.forEach((s) => {
        const known = names.reduce((acc, n) => acc + (severity[n][s] || 0), 0);
        rest[s] = Math.max(0, (out.severity[s] || 0) - known);
      });
      names.push("其他");
      severity["其他"] = rest;
    }

    const rows = names.map((name) => ({
      name,
      value: AIME_SEVERITIES.reduce((sum, s) => sum + (severity[name][s] || 0), 0),
      severity: severity[name],
    }));

    $("aiAttrSide").innerHTML = `P1 <b>${(d.conclusion.aime.p1_share || 0).toFixed(1)}%</b>`;
    $("aiAttrMeta").textContent = "P0–P3 分级";
    setNum("aiProblems", out.problems);

    $("aiSevChips").innerHTML = AIME_SEVERITIES.map((s) => {
      const share = pct(out.severity[s] || 0, out.problems);
      return (
        `<span class="sev-chip"><i class="sev-dot" style="background:${SEV_COLOR[s]}"></i>` +
        `${s} <b>${share.toFixed(1)}%</b></span>`
      );
    }).join("");

    renderAttrRows("aiAttr", rows, "ai");
  }

  // ----------------------------------------------------------- cluster card
  function decorateCluster(node, color, depth) {
    const bg = depth === 0 ? color : lerpColor(color, T.surface, 0.12 + depth * 0.08);
    const out = {
      id: node.id || node.name,
      name: node.name,
      value: node.value,
      items: node.items || 0,
      itemStyle: { color: bg },
    };
    if (node.children && node.children.length) {
      out.children = node.children.map((c) => decorateCluster(c, color, depth + 1));
    }
    return out;
  }

  function clusterLevels(data) {
    const maxDepth = (nodes) =>
      nodes.reduce((m, n) => Math.max(m, 1 + (n.children && n.children.length ? maxDepth(n.children) : 0)), 0);
    const depth = maxDepth(data);
    if (depth <= 1) {
      return [{}, { r0: "30%", r: "94%", label: { show: false } }];
    }
    if (depth === 2) {
      return [
        {},
        { r0: "26%", r: "60%", label: { show: false } },
        { r0: "60%", r: "94%", label: { show: false } },
      ];
    }
    return [
      {},
      { r0: "20%", r: "48%", label: { show: false } },
      { r0: "48%", r: "70%", label: { show: false } },
      { r0: "70%", r: "94%", label: { show: false } },
    ];
  }

  function clusterOption(product) {
    const st = clusterState[product];
    const current = st.stack.length ? st.stack[st.stack.length - 1] : st.root;
    const branches = (current && current.children) || [];
    const palette = chartPalette().cluster;
    const data = branches.map((n, i) => decorateCluster(n, palette[i % palette.length], 0));
    const total = st.meta ? st.meta.total_sessions : (current && current.value) || 1;

    return {
      animationDuration: REDUCED ? 0 : 620,
      animationEasing: "cubicOut",
      tooltip: {
        ...tip,
        formatter: (p) => {
          const path = (p.treePathInfo || [])
            .map((x) => x.name)
            .filter((n) => n && n !== "归因聚类" && n !== "root")
            .join(" / ");
          return tipCard(
            tipHead(p.name, `${pct(p.value, total).toFixed(1)}%`, p.color) +
              tipRow(T.muted, "会话", fmt(p.value)) +
              tipRow(T.muted, "条目", fmt((p.data && p.data.items) || 0)) +
              (path ? `<div class="tip-path">${path}</div>` : "")
          );
        },
      },
      series: [
        {
          type: "sunburst",
          radius: ["20%", "96%"],
          center: ["50%", "50%"],
          data,
          nodeClick: false,
          sort: null,
          itemStyle: { borderColor: T.surface, borderWidth: 2 },
          label: { show: false },
          levels: clusterLevels(data),
          emphasis: {
            focus: "ancestor",
            itemStyle: { shadowBlur: 10, shadowColor: "rgba(15,23,42,.18)" },
          },
        },
      ],
    };
  }

  function clusterPath(root, target) {
    if (!root || !target) return null;
    if (root === target) return [];
    for (const child of root.children || []) {
      if (child === target) return [child];
      const rest = clusterPath(child, target);
      if (rest) return [child, ...rest];
    }
    return null;
  }

  function drillCluster(product, node) {
    const st = clusterState[product];
    const path = clusterPath(st.root, node);
    if (!path || !path.length) return;
    st.stack = path;
    drawCluster(product);
  }

  function renderClusterLegend(product) {
    const isWc = product === "wencai";
    const el = $(isWc ? "wcClusterLegend" : "aiClusterLegend");
    const st = clusterState[product];
    if (!el || !st.root) return;
    const current = st.stack.length ? st.stack[st.stack.length - 1] : st.root;
    const children = current.children || [];
    const total = current.value || 1;
    const palette = chartPalette().cluster;
    if (!children.length) {
      el.innerHTML = "";
      return;
    }
    el.innerHTML =
      `<div class="cl-head"><span></span><span>环节</span><span>会话</span><span>占比</span></div>` +
      children
        .map((n, i) => {
          const drillable = (n.children || []).length > 0;
          const color = palette[i % palette.length];
          return (
            `<button class="cl-row${drillable ? "" : " is-static"}" type="button" data-idx="${i}"` +
            `${drillable ? "" : ' tabindex="-1" aria-disabled="true"'}` +
            ` title="${n.name} · ${fmt(n.value)} 会话 · ${pct(n.value, total).toFixed(1)}%">` +
            `<i class="cl-dot" style="background:${color}"></i>` +
            `<span class="cl-name">${n.name}</span>` +
            `<span class="cl-val">${fmt(n.value)}</span>` +
            `<span class="cl-pct">${pct(n.value, total).toFixed(1)}%</span>` +
            `</button>`
          );
        })
        .join("");
    el.onclick = (ev) => {
      const row = ev.target.closest(".cl-row");
      if (!row || row.classList.contains("is-static")) return;
      const node = children[Number(row.dataset.idx)];
      if (node) drillCluster(product, node);
    };
  }

  function updateClusterNote(product) {
    const isWc = product === "wencai";
    const st = clusterState[product];
    const back = $(isWc ? "wcClusterBack" : "aiClusterBack");
    const note = $(isWc ? "wcClusterNote" : "aiClusterNote");
    const right = $(isWc ? "wcClusterNoteR" : "aiClusterNoteR");
    const current = st.stack.length ? st.stack[st.stack.length - 1] : st.root;
    if (st.stack.length) {
      back.hidden = false;
      const path = ["全部", ...st.stack.map((n) => n.name)].join(" / ");
      note.textContent = path;
      right.textContent = `${(current.children || []).length} 子类`;
    } else {
      back.hidden = true;
      note.textContent = `${(st.root.children || []).length} 环节`;
      right.textContent = `${(st.meta && st.meta.depth) || 3} 层`;
    }
  }

  function drawCluster(product) {
    const isWc = product === "wencai";
    const st = clusterState[product];
    const current = st.stack.length ? st.stack[st.stack.length - 1] : st.root;
    const c = clusterCharts[product];
    if (!c || !current) return;
    c.setOption(clusterOption(product), true);
    animateTo(isWc ? "wcClusterSessions" : "aiClusterSessions", current.value || 0);
    $(isWc ? "wcClusterSide" : "aiClusterSide").innerHTML = `${fmt(current.items || 0)} <span>条目</span>`;
    updateClusterNote(product);
    renderClusterLegend(product);
    const el = $(isWc ? "wcCluster" : "aiCluster");
    el.style.cursor = (current.children || []).length ? "pointer" : "default";
  }

  function renderCluster(product, d) {
    const isWc = product === "wencai";
    const src = isWc ? d.wencai : d.aime;
    const cl = src.cluster;
    const root = (cl && cl.tree) || { name: "归因聚类", value: 0, items: 0, children: [] };
    const meta = (cl && cl.meta) || {};
    const nodeById = new Map();
    const scan = (node) => {
      nodeById.set(node.id || node.name, node);
      (node.children || []).forEach(scan);
    };
    scan(root);

    clusterState[product] = {
      src,
      root,
      meta,
      stack: ((clusterState[product] && clusterState[product].stack) || []).filter(
        (n) => clusterPath(root, n) !== null
      ),
      nodeById,
    };
    const c = chart(isWc ? "wcCluster" : "aiCluster", clusterOption(product));
    clusterCharts[product] = c;
    if (c) {
      c.on("click", (p) => {
        const st = clusterState[product];
        if (!(p.data && p.data.children && p.data.children.length)) return;
        const names = (p.treePathInfo || [])
          .map((x) => x.name)
          .filter((n) => n && n !== "归因聚类" && n !== "root");
        let node = st.root;
        for (const name of names) {
          const next = (node.children || []).find((c) => c.name === name);
          if (!next) break;
          node = next;
        }
        if (node === st.root) return;
        drillCluster(product, node);
      });
    }

    const back = $(isWc ? "wcClusterBack" : "aiClusterBack");
    if (back) {
      back.onclick = () => {
        const st = clusterState[product];
        st.stack.pop();
        drawCluster(product);
      };
    }

    drawCluster(product);
  }

  // -------------------------------------------------------- prediction card
  const DEMO_SERIES = {
    wencai: [62, 68, 65, 72, 78, 74, 81, 85, 83, 90, 94, 92, 99, 103],
    aime: [820, 860, 845, 910, 960, 940, 1010, 1060, 1040, 1110, 1160, 1140, 1210, 1260],
  };

  function dayLabel(base, offset) {
    const d = new Date(`${base}T00:00:00`);
    if (Number.isNaN(d.getTime())) return "—";
    d.setDate(d.getDate() + offset);
    return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  function renderPrediction(product, d) {
    const isWc = product === "wencai";
    const src = isWc ? d.wencai : d.aime;
    const demo = DEMO_SERIES[isWc ? "wencai" : "aime"];
    const n = demo.length;
    const end = (src.input.date_range && src.input.date_range.end) || "2026-10-23";
    const actualDates = demo.map((_, i) => dayLabel(end, i - n + 1));
    const futureDates = Array.from({ length: 7 }, (_, i) => dayLabel(end, i + 1));
    const labels = [...actualDates, ...futureDates];
    const slope = (demo[n - 1] - demo[0]) / (n - 1);
    const forecast = Array.from({ length: 7 }, (_, i) =>
      Math.max(1, Math.round(demo[n - 1] + slope * (i + 1)))
    );
    const band = isWc ? 0.08 : 0.12;
    const lower = forecast.map((v) => Math.round(v * (1 - band)));
    const upper = forecast.map((v) => Math.round(v * (1 + band)));
    const next = forecast[0];
    const growth = pct(next - demo[n - 1], demo[n - 1]);
    const accent = isWc ? C.a : C.ai;
    const trendClass = growth >= 0 ? "trend-up" : "trend-down";

    setNum(isWc ? "wcForecast" : "aiForecast", next);
    $(isWc ? "wcForecastTrend" : "aiForecastTrend").innerHTML =
      `<span class="${trendClass}">${growth >= 0 ? "+" : ""}${growth.toFixed(1)}%</span>`;
    $(isWc ? "wcForecastNote" : "aiForecastNote").textContent = `±${Math.round(band * 100)}% 区间`;
    const total7 = forecast.reduce((a, b) => a + b, 0);
    const peak7 = Math.max(...forecast);
    $(isWc ? "wcForecastStats" : "aiForecastStats").innerHTML = [
      ["7 日合计", fmt(total7)],
      ["峰值", fmt(peak7)],
      ["日均", fmt(Math.round(total7 / 7))],
    ]
      .map(([label, value]) => `<span><em>${label}</em><b>${value}</b></span>`)
      .join("");

    const actualData = [...demo, ...Array(7).fill(null)];
    const forecastData = [...Array(n - 1).fill(null), demo[n - 1], ...forecast];
    const lowerData = [...Array(n).fill(null), ...lower];
    const bandData = [...Array(n).fill(null), ...upper.map((u, i) => u - lower[i])];

    chart(isWc ? "wcForecastChart" : "aiForecastChart", {
      animationDuration: REDUCED ? 0 : 680,
      animationEasing: "cubicOut",
      tooltip: {
        ...tip,
        trigger: "axis",
        axisPointer: { type: "line", lineStyle: { color: T.track } },
        formatter: (params) => {
          const i = params[0].dataIndex;
          const date = labels[i];
          if (i >= n) {
            const k = i - n;
            return tipCard(
              tipHead(date, "预测", T.forecast) +
                tipRow(T.forecast, "预测值", fmt(forecast[k])) +
                tipRow(T.muted, "区间", `${fmt(lower[k])}–${fmt(upper[k])}`)
            );
          }
          return tipCard(tipHead(date, "实际", accent) + tipRow(accent, "实际值", fmt(demo[i])));
        },
      },
      grid: { left: 32, right: 8, top: 8, bottom: 18 },
      xAxis: {
        type: "category",
        data: labels,
        boundaryGap: false,
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { fontSize: 8, color: T.faint, interval: 5, fontFamily: FONT },
      },
      yAxis: {
        type: "value",
        min: 0,
        splitNumber: 3,
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { fontSize: 8, color: T.faint, fontFamily: FONT, margin: 4 },
        splitLine: { lineStyle: { color: T.hairline, type: "dashed" } },
      },
      series: [
        {
          name: "下界",
          type: "line",
          data: lowerData,
          stack: "confidence",
          symbol: "none",
          lineStyle: { opacity: 0 },
          areaStyle: { opacity: 0 },
          silent: true,
        },
        {
          name: "区间",
          type: "line",
          data: bandData,
          stack: "confidence",
          symbol: "none",
          lineStyle: { opacity: 0 },
          areaStyle: { color: hexA(accent, 0.12) },
          silent: true,
        },
        {
          name: "实际",
          type: "line",
          data: actualData,
          smooth: 0.35,
          symbol: "none",
          lineStyle: { width: 2, color: accent },
          areaStyle: { color: hexA(accent, 0.06) },
          markLine: {
            silent: true,
            symbol: "none",
            lineStyle: { color: T.faint, type: "dashed", width: 1, opacity: 0.6 },
            label: { show: false },
            data: [{ xAxis: actualDates[n - 1] }],
          },
        },
        {
          name: "预测",
          type: "line",
          data: forecastData,
          smooth: 0.35,
          symbol: "none",
          lineStyle: { width: 1.8, type: "dashed", color: T.forecast },
        },
      ],
    });
  }

  // ------------------------------------------------------------------ header
  function renderHeader(d) {
    $("updated").textContent = (d.generated_at || "—").slice(5, 16).replace("T", " ");
  }

  // ------------------------------------------------------------- page switch
  let activeProduct = "wencai";

  function setProduct(product) {
    if (product !== "wencai" && product !== "aime") return;
    activeProduct = product;
    document.querySelectorAll(".page").forEach((page) => {
      const on = page.dataset.product === product;
      page.classList.toggle("is-active", on);
      page.setAttribute("aria-hidden", String(!on));
    });
    const sw = $("productSwitch");
    if (sw) {
      sw.dataset.active = product;
      sw.querySelectorAll(".product-tab").forEach((tab) => {
        const on = tab.dataset.tab === product;
        tab.classList.toggle("is-active", on);
        tab.setAttribute("aria-selected", String(on));
        tab.tabIndex = on ? 0 : -1;
      });
    }
    requestAnimationFrame(() => charts.forEach((c) => c.resize()));
    window.setTimeout(() => charts.forEach((c) => c.resize()), 260);
  }

  function initSwitch() {
    const sw = $("productSwitch");
    if (!sw) return;
    sw.addEventListener("click", (ev) => {
      const tab = ev.target.closest(".product-tab");
      if (tab) setProduct(tab.dataset.tab);
    });
    sw.addEventListener("keydown", (ev) => {
      if (ev.key !== "ArrowLeft" && ev.key !== "ArrowRight") return;
      ev.preventDefault();
      const next = activeProduct === "wencai" ? "aime" : "wencai";
      setProduct(next);
      const tab = sw.querySelector(`.product-tab[data-tab="${next}"]`);
      if (tab) tab.focus();
    });
    setProduct(activeProduct);
  }

  // ----------------------------------------------------------- theme switch
  function disposeCharts() {
    charts.forEach((c) => {
      if (c.__ro) c.__ro.disconnect();
      try {
        c.dispose();
      } catch (e) {}
    });
    charts.length = 0;
    Object.keys(clusterCharts).forEach((k) => delete clusterCharts[k]);
    Object.keys(volumeCharts).forEach((k) => delete volumeCharts[k]);
    resizeQueue.clear();
  }

  function updateThemeButton() {
    const btn = $("themeToggle");
    if (!btn) return;
    const dark = document.documentElement.dataset.mode === "dark";
    const label = dark ? "切换浅色模式" : "切换深色模式";
    btn.setAttribute("aria-label", label);
    btn.title = label;
  }

  function applyMode(mode, persist) {
    document.documentElement.dataset.mode = mode;
    if (persist) {
      try {
        localStorage.setItem("eval-mode", mode);
      } catch (e) {}
    }
    updateThemeButton();
    if (!DATA) return;
    readTokens();
    disposeCharts();
    renderAll();
    settleCounters();
  }

  function initTheme() {
    updateThemeButton();
    const btn = $("themeToggle");
    if (btn) {
      btn.addEventListener("click", () => {
        applyMode(document.documentElement.dataset.mode === "dark" ? "light" : "dark", true);
      });
    }
    if (window.matchMedia) {
      const mq = window.matchMedia("(prefers-color-scheme: dark)");
      const onChange = (ev) => {
        let saved = null;
        try {
          saved = localStorage.getItem("eval-mode");
        } catch (e) {}
        if (!saved) applyMode(ev.matches ? "dark" : "light", false);
      };
      if (mq.addEventListener) mq.addEventListener("change", onChange);
    }
  }

  // -------------------------------------------------------------------- boot
  function reveal() {
    const mask = $("mask");
    if (mask) {
      mask.classList.add("is-hidden");
      setTimeout(() => mask.remove(), 400);
    }
    const board = document.querySelector(".board");
    if (board) board.classList.add("is-ready");
    setTimeout(() => startCounters(0.8), REDUCED ? 0 : 120);
    setTimeout(() => {
      window.__boardReady = true;
    }, 700);
  }

  function renderAll() {
    if (!DATA) return;
    renderHeader(DATA);
    renderVolume("wencai", DATA);
    renderEvaluation("wencai", DATA);
    renderWencaiAttr(DATA);
    renderCluster("wencai", DATA);
    renderPrediction("wencai", DATA);
    renderVolume("aime", DATA);
    renderEvaluation("aime", DATA);
    renderAimeAttr(DATA);
    renderCluster("aime", DATA);
    renderPrediction("aime", DATA);
  }

  function fail(err) {
    const mask = $("mask");
    if (!mask) return;
    mask.innerHTML =
      `<div class="mask-inner mask-error"><span>数据加载失败：${err.message}</span>` +
      `<button onclick="location.reload()">重试</button></div>`;
    console.error(err);
  }

  fetch("data.json?t=" + Date.now(), { cache: "no-store" })
    .then((r) => {
      if (!r.ok) throw new Error("data.json " + r.status);
      return r.json();
    })
    .then((d) => {
      DATA = d;
      readTokens();
      initSwitch();
      initTheme();
      renderAll();
      requestAnimationFrame(reveal);
    })
    .catch(fail);

  window.addEventListener("resize", () => {
    if (resizeRaf) return;
    resizeRaf = requestAnimationFrame(() => {
      resizeRaf = 0;
      charts.forEach((c) => c.resize());
    });
  });
})();
