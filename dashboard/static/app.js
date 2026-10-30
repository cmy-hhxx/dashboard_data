/* Eval dashboard — two product sections, no bar charts. */
(function () {
  const $ = (id) => document.getElementById(id);
  const FONT = '-apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Microsoft YaHei", sans-serif';
  const charts = [];
  const relayout = [];

  const fmt = (n) => (n == null ? "—" : Number(n).toLocaleString("en-US"));
  const fmtK = (v) => (v >= 1000 ? (v / 1000).toFixed(v >= 10000 ? 0 : 1) + "k" : v);
  const pct = (a, b) => (b ? (100 * a) / b : 0);

  const C = {
    a: "#0f766e", aLight: "#7cc3b8",
    b: "#ea580c", bLight: "#f6b48e",
    ai: "#4338ca", aiMid: "#6366f1", aiLight: "#a5b4fc",
    sev0: "#7f1d1d", sev1: "#dc2626", sev2: "#f59e0b", sev3: "#94a3b8",
  };

  const SHORT = {
    "终稿生成轮": "终稿生成",
    "shell 代码解释器": "shell 解释器",
    "中间推理处理": "中间推理",
    "web_search 网页检索": "网页检索",
    "web_fetch 网页抓取": "网页抓取",
    "finquery 取数服务": "finquery",
    "其他工具（CodeInterpreter）": "CodeInterp.",
    "planner-finquery 取数规划子模型": "plan-finquery",
    "planner-search 检索规划子模型": "plan-search",
    "其他工具（aime_memory_read）": "memory_read",
    "其他工具（customer_services）": "customer_services",
    "Expert 推理轮": "Expert 推理",
  };
  const short = (s) => SHORT[s] || (s.length > 11 ? s.slice(0, 11) + "…" : s);

  const tip = {
    backgroundColor: "rgba(15,23,42,.95)",
    borderWidth: 0,
    padding: [9, 11],
    textStyle: { color: "#fff", fontSize: 11, fontFamily: FONT },
    extraCssText: "border-radius:10px;box-shadow:0 12px 30px rgba(15,23,42,.25);",
  };
  const tipRow = (color, label, value) =>
    `<div class="flex items-center gap-1.5 leading-5"><i class="inline-block h-1.5 w-1.5 rounded-sm" style="background:${color}"></i>` +
    `<span class="text-slate-300">${label}</span><b class="ml-auto pl-5 font-semibold text-white">${value}</b></div>`;
  const tipHead = (t) => `<div class="mb-1 text-[10.5px] text-slate-400">${t}</div>`;

  const axisStyle = { color: "#94a3b8", fontSize: 10, fontFamily: FONT };
  const splitLine = { lineStyle: { color: "#f1f5f9" } };

  function chart(id, option) {
    const el = $(id);
    if (!el) return null;
    const c = echarts.init(el, null, { renderer: "canvas" });
    c.setOption(option);
    charts.push(c);
    return c;
  }

  function legendDot(name, color) {
    return `<span class="inline-flex items-center gap-1"><i class="inline-block h-1.5 w-1.5 rounded-sm" style="background:${color}"></i>${name}</span>`;
  }

  function metric(label, value, unit) {
    return `<div class="metric"><dt>${label}</dt><dd>${value}${unit ? `<span>${unit}</span>` : ""}</dd></div>`;
  }

  function hexA(hex, alpha) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
  }

  function lerpColor(a, b, t) {
    const pa = parseInt(a.slice(1), 16);
    const pb = parseInt(b.slice(1), 16);
    const mix = (s) => Math.round(((pa >> s) & 255) + (((pb >> s) & 255) - ((pa >> s) & 255)) * t);
    return `rgb(${mix(16)},${mix(8)},${mix(0)})`;
  }

  // ------------------------------------------------------------ KPI strips
  function renderKpis(d) {
    const wc = d.wencai, ai = d.aime, cw = d.conclusion.wencai, ca = d.conclusion.aime;
    $("wcKpis").innerHTML = [
      metric("输入", fmt(wc.input.total), "条"),
      metric("对比覆盖", cw.coverage.toFixed(1), "%"),
      metric("胜场 A : B", `${cw.a_win}<span class="text-slate-300">:</span>${cw.b_win}`),
      metric("归因", fmt(wc.output.problems), "问题"),
    ].join("");
    $("aiKpis").innerHTML = [
      metric("输入", fmt(ai.input.total), "条"),
      metric("输出", fmt(ai.output.answers), "条"),
      metric("输出覆盖", ca.coverage.toFixed(1), "%"),
      metric("P1 占比", ca.p1_share.toFixed(1), "%"),
    ].join("");
  }

  // ------------------------------------------------------- 问财 · 输入趋势
  function renderWencaiInput(d) {
    const inp = d.wencai.input;
    const series = [
      ["a_expert", "A·expert", C.a],
      ["a_fast", "A·fast", C.aLight],
      ["b_expert", "B·expert", C.b],
      ["b_fast", "B·fast", C.bLight],
    ];
    $("wcInStat").textContent = `${fmt(inp.total)} 条 · ${(inp.bytes / 1e9).toFixed(1)} GB`;
    $("wcInLegend").innerHTML = series.map(([, name, color]) => legendDot(name, color)).join("");

    const gradient = (hex) =>
      new echarts.graphic.LinearGradient(0, 0, 0, 1, [
        { offset: 0, color: hexA(hex, 0.55) },
        { offset: 1, color: hexA(hex, 0.92) },
      ]);

    chart("wcInput", {
      animationDuration: 700,
      grid: { left: 36, right: 12, top: 10, bottom: 22 },
      tooltip: {
        ...tip,
        trigger: "axis",
        axisPointer: { type: "line", lineStyle: { color: "#cbd5e1", type: "dashed" } },
        formatter: (ps) => {
          const i = ps[0].dataIndex;
          const total = series.reduce((s, [k]) => s + (inp.series[k][i] || 0), 0);
          return (
            tipHead(inp.days[i]) +
            series.map(([k, name, color]) => tipRow(color, name, fmt(inp.series[k][i]))).join("") +
            `<div class="mt-1 flex items-center border-t border-white/10 pt-1 leading-5"><span class="text-slate-400">合计</span><b class="ml-auto pl-5 font-semibold">${fmt(total)}</b></div>`
          );
        },
      },
      xAxis: {
        type: "category",
        boundaryGap: false,
        data: inp.days.map((x) => x.slice(5)),
        axisLine: { lineStyle: { color: "#eef2f7" } },
        axisTick: { show: false },
        axisLabel: { ...axisStyle, interval: (i) => i % 3 === 0 },
      },
      yAxis: { type: "value", splitNumber: 3, axisLabel: { ...axisStyle, formatter: fmtK }, splitLine },
      series: series.map(([k, name, color]) => ({
        name,
        type: "line",
        stack: "in",
        smooth: 0.35,
        symbol: "none",
        lineStyle: { width: 1, color: hexA(color, 0.85) },
        areaStyle: { color: gradient(color) },
        emphasis: { focus: "series" },
        data: inp.series[k],
      })),
    });
  }

  // ------------------------------------------------------- 问财 · 对比结论
  function renderWencaiCompare(d) {
    const out = d.wencai.output;
    const cmp = out.comparisons || {};
    const fast = cmp.a_fast_vs_b_fast;
    const expert = cmp.a_expert_vs_b_expert;
    if (!fast || !expert) return;

    const rows = [
      { label: "胜率 · fast", a: pct(fast.a_win, fast.n), b: pct(fast.b_win, fast.n) },
      { label: "胜率 · expert", a: pct(expert.a_win, expert.n), b: pct(expert.b_win, expert.n) },
      { label: "核心达成 · fast", a: out.meets_core.a_fast, b: out.meets_core.b_fast },
      { label: "核心达成 · expert", a: out.meets_core.a_expert, b: out.meets_core.b_expert },
    ];
    $("wcCmpStat").textContent = `${fmt(out.coverage.decided)} 已决 / ${fmt(out.coverage.planned)}`;
    $("wcCmpLegend").innerHTML = [legendDot("A 组", C.a), legendDot("B 组", C.b)].join("");

    chart("wcCompare", {
      animationDuration: 700,
      grid: { left: 96, right: 34, top: 16, bottom: 24 },
      tooltip: {
        ...tip,
        trigger: "item",
        formatter: (p) => {
          const r = rows[p.dataIndex];
          return tipHead(r.label) + tipRow(C.a, "A 组", r.a.toFixed(1) + "%") + tipRow(C.b, "B 组", r.b.toFixed(1) + "%");
        },
      },
      xAxis: {
        type: "value",
        min: 0,
        max: 100,
        axisLabel: { ...axisStyle, formatter: "{value}%" },
        splitLine,
        axisLine: { show: false },
        axisTick: { show: false },
      },
      yAxis: {
        type: "category",
        inverse: true,
        data: rows.map((r) => r.label),
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { ...axisStyle, color: "#64748b", fontSize: 10.5 },
      },
      series: [
        {
          type: "custom",
          z: 1,
          silent: true,
          data: rows.map((r, i) => [r.a, i]),
          renderItem: (params, api) => {
            const i = params.dataIndex;
            const p1 = api.coord([rows[i].a, i]);
            const p2 = api.coord([rows[i].b, i]);
            return {
              type: "line",
              shape: { x1: p1[0], y1: p1[1], x2: p2[0], y2: p2[1] },
              style: { stroke: "#d7dee7", lineWidth: 5, lineCap: "round" },
            };
          },
        },
        {
          name: "A 组",
          type: "scatter",
          z: 2,
          symbolSize: 11,
          data: rows.map((r, i) => [r.a, i]),
          itemStyle: { color: C.a, borderColor: "#fff", borderWidth: 2 },
          label: {
            show: true,
            position: "top",
            distance: 9,
            fontSize: 9.5,
            color: C.a,
            fontFamily: FONT,
            formatter: (p) => p.value[0].toFixed(1) + "%",
          },
        },
        {
          name: "B 组",
          type: "scatter",
          z: 2,
          symbolSize: 11,
          data: rows.map((r, i) => [r.b, i]),
          itemStyle: { color: C.b, borderColor: "#fff", borderWidth: 2 },
          label: {
            show: true,
            position: "bottom",
            distance: 9,
            fontSize: 9.5,
            color: C.b,
            fontFamily: FONT,
            formatter: (p) => p.value[0].toFixed(1) + "%",
          },
        },
      ],
    });
  }

  // ------------------------------------------------------------ 问财 · 归因
  function renderWencaiAttr(d) {
    const comp = d.wencai.components;
    const out = d.wencai.output;
    const names = comp.names.map(short);
    const sumA = comp.A.reduce((s, v) => s + v, 0);
    const sumB = comp.B.reduce((s, v) => s + v, 0);
    const totalA = out.versions.a_expert.problems + out.versions.a_fast.problems;
    const totalB = out.versions.b_expert.problems + out.versions.b_fast.problems;

    $("wcAttrStat").textContent = `${fmt(out.problems)} 问题 / ${fmt(out.answers)} 回答`;
    $("wcAttrNote").textContent = `A 组 ${fmt(totalA)} · B 组 ${fmt(totalB)}`;
    $("wcAttrLegend").innerHTML = [legendDot("A 组", C.a), legendDot("B 组", C.b)].join("");

    const nodes = [
      { name: "A 组", itemStyle: { color: C.a }, label: { position: "left", color: C.a, fontWeight: 600 } },
      { name: "B 组", itemStyle: { color: C.b }, label: { position: "left", color: C.b, fontWeight: 600 } },
      ...names.map((n) => ({ name: n, itemStyle: { color: "#dbe2ea" } })),
      { name: "其他", itemStyle: { color: "#eef2f7" }, label: { color: "#94a3b8" } },
    ];

    const links = [];
    names.forEach((n, i) => {
      if (comp.A[i]) links.push({ source: "A 组", target: n, value: comp.A[i] });
      if (comp.B[i]) links.push({ source: "B 组", target: n, value: comp.B[i] });
    });
    const otherA = totalA - sumA;
    const otherB = totalB - sumB;
    if (otherA) links.push({ source: "A 组", target: "其他", value: otherA });
    if (otherB) links.push({ source: "B 组", target: "其他", value: otherB });

    chart("wcAttr", {
      animationDuration: 700,
      tooltip: {
        ...tip,
        trigger: "item",
        formatter: (p) => {
          if (p.dataType === "edge") {
            const color = p.data.source === "A 组" ? C.a : C.b;
            return tipHead(`${p.data.source} → ${p.data.target}`) + tipRow(color, "问题数", fmt(p.data.value));
          }
          return tipHead(p.name);
        },
      },
      series: [
        {
          type: "sankey",
          left: 46,
          right: 112,
          top: 12,
          bottom: 12,
          nodeWidth: 7,
          nodeGap: 9,
          nodeAlign: "justify",
          draggable: false,
          emphasis: { focus: "adjacency" },
          label: {
            fontSize: 10,
            fontFamily: FONT,
            color: "#475569",
            distance: 5,
            formatter: (p) => (p.name === "A 组" || p.name === "B 组" ? p.name : `${p.name}  ${fmt(p.value)}`),
          },
          lineStyle: { color: "gradient", opacity: 0.22, curveness: 0.52 },
          data: nodes,
          links,
        },
      ],
    });
  }

  // ------------------------------------------------------- AIME · 输入结构
  function renderAimeInput(d) {
    const g = d.aime.input.groups || {};
    const groups = [
      ["日常", "daily", "#3730a3"],
      ["流失", "lost", "#6d28d9"],
      ["归档", "lost_archive", "#4f46e5"],
    ];
    $("aiInStat").textContent = `${fmt(d.aime.input.total)} 条 · ${d.aime.input.files} 文件`;


    $("aiInLegend").innerHTML =
      groups
        .map(([name, key, color]) => {
          const v = ((g[key] || {}).expert || 0) + ((g[key] || {}).fast || 0);
          return `<span class="inline-flex items-center gap-1"><i class="inline-block h-1.5 w-1.5 rounded-sm" style="background:${color}"></i>${name} <b class="font-semibold text-slate-600">${fmt(v)}</b></span>`;
        })
        .join("") +
      `<span class="ml-auto inline-flex items-center gap-2 text-slate-400">` +
      `<span class="inline-flex items-center gap-1"><i class="inline-block h-1.5 w-1.5 rounded-sm bg-indigo-700"></i>expert</span>` +
      `<span class="inline-flex items-center gap-1"><i class="inline-block h-1.5 w-1.5 rounded-sm bg-indigo-300"></i>fast</span></span>`;

    const data = groups.map(([name, key, color]) => {
      const expert = (g[key] || {}).expert || 0;
      const fast = (g[key] || {}).fast || 0;
      return {
        name,
        value: expert + fast,
        itemStyle: { color },
        label: { color: "#fff", rotate: 0, show: name !== "流失" },
        children: [
          { name: "expert", value: expert, itemStyle: { color: "#4338ca" } },
          { name: "fast", value: fast, itemStyle: { color: "#a5b4fc" } },
        ],
      };
    });

    chart("aiInput", {
      animationDuration: 700,
      tooltip: {
        ...tip,
        formatter: (p) =>
          tipHead(p.name) +
          (p.data.children
            ? p.data.children.map((c) => tipRow(c.itemStyle.color, c.name, fmt(c.value))).join("")
            : tipRow(p.color, "条数", fmt(p.value))),
      },
      series: [
        {
          type: "sunburst",
          radius: ["26%", "92%"],
          center: ["50%", "52%"],
          sort: null,
          nodeClick: false,
          data,
          itemStyle: { borderColor: "#fff", borderWidth: 2 },
          label: { fontFamily: FONT, minAngle: 8 },
          levels: [
            {},
            {
              r0: "26%",
              r: "64%",
              label: { rotate: 0, fontSize: 10.5, formatter: (p) => p.name },
            },
            {
              r0: "64%",
              r: "92%",
              label: { show: false },
            },
          ],
        },
      ],
    });
  }

  // ------------------------------------------------------- AIME · 输出日历
  function renderAimeOutput(d) {
    const perDay = d.aime.output.per_day || [];
    const values = perDay.map((x) => ({ date: x.date, value: (x.expert || 0) + (x.fast || 0) }));
    const max = Math.max(1, ...values.map((x) => x.value));
    const map = new Map(values.map((x) => [x.date, x.value]));

    $("aiOutStat").textContent = `${fmt(d.aime.output.answers)} 结果 · 覆盖 ${d.conclusion.aime.coverage.toFixed(1)}%`;
    const busiest = values.reduce((best, x) => (x.value > best.value ? x : best), { date: "—", value: 0 });
    const activeDays = values.length;
    $("aiOutLegend").innerHTML =
      `<span class="inline-flex items-center gap-1"><i class="inline-block h-1.5 w-1.5 rounded-sm bg-ai"></i>峰值 <b class="font-semibold text-slate-600">${fmt(busiest.value)}</b> <span class="text-slate-400">${busiest.date.slice(5)}</span></span>` +
      `<span class="inline-flex items-center gap-1 text-slate-400">活跃 <b class="font-semibold text-slate-600">${activeDays}</b> 天</span>`;

    const el = $("aiOutput");
    const layout = () => {
      const w = el.clientWidth || 400;
      const h = el.clientHeight || 260;
      const weeks = 10;
      const cell = Math.max(20, Math.min(36, Math.floor(Math.min((w - 64) / weeks, (h - 74) / 7))));
      return {
        cell,
        left: Math.max(30, Math.round((w - weeks * cell) / 2)),
        top: Math.max(24, Math.round((h - 7 * cell) / 2)),
      };
    };

    const seriesData = [];
    const start = new Date(2026, 8, 1);
    for (let i = 0; i < 61; i++) {
      const dt = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
      const key = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
      const v = map.get(key) || 0;
      seriesData.push([key, v]);
    }

    const makeOption = () => {
      const l = layout();
      return {
        animationDuration: 700,
        tooltip: {
          ...tip,
          formatter: (p) => tipHead(p.value[0]) + tipRow(C.ai, "输出", fmt(p.value[1]) + " 条"),
        },
        visualMap: {
          min: 0,
          max,
          show: true,
          orient: "horizontal",
          left: "center",
          bottom: 2,
          itemWidth: 12,
          itemHeight: 110,
          calculable: false,
          text: ["多", "少"],
          textStyle: { fontSize: 9, color: "#94a3b8", fontFamily: FONT },
          inRange: { color: ["#f1f5f9", "#e0e7ff", "#a5b4fc", C.ai] },
        },
        calendar: {
          range: ["2026-09-01", "2026-10-31"],
          cellSize: [l.cell, l.cell],
          left: l.left,
          top: l.top,
          splitLine: { show: false },
          itemStyle: { color: "#fff", borderWidth: 2, borderColor: "#f8fafc" },
          dayLabel: {
            firstDay: 1,
            nameMap: ["日", "一", "二", "三", "四", "五", "六"],
            fontSize: 9,
            color: "#94a3b8",
            fontFamily: FONT,
          },
          monthLabel: { fontSize: 9.5, color: "#64748b", fontFamily: FONT, margin: 6 },
          yearLabel: { show: false },
        },
        series: [
          {
            type: "heatmap",
            coordinateSystem: "calendar",
            data: seriesData,
            itemStyle: { borderRadius: 5, borderWidth: 2, borderColor: "#fff" },
          },
        ],
      };
    };

    const c = chart("aiOutput", makeOption());
    if (c) relayout.push(() => c.setOption(makeOption(), { replaceMerge: ["calendar"] }));
  }

  // ------------------------------------------------------------ AIME · 归因
  function renderAimeAttr(d) {
    const out = d.aime.output;
    const comp = out.components;
    const sev = out.severity;
    const total = out.problems;

    $("aiAttrStat").textContent = `${fmt(total)} 问题 / ${fmt(out.answers)} 回答`;
    const chips = [
      ["P0", sev.P0 || 0, C.sev0],
      ["P1", sev.P1 || 0, C.sev1],
      ["P2", sev.P2 || 0, C.sev2],
      ["P3", sev.P3 || 0, C.sev3],
    ];
    $("aiSevChips").innerHTML = chips
      .map(
        ([name, v, color]) =>
          `<span class="inline-flex items-center gap-1"><i class="inline-block h-1.5 w-1.5 rounded-sm" style="background:${color}"></i>${name} <b class="font-semibold text-slate-600">${pct(v, total).toFixed(1)}%</b></span>`
      )
      .join("");

    const maxP1 = Math.max(...comp.names.map((n) => pct(comp.severity[n].P1 || 0, comp.fast[comp.names.indexOf(n)] + comp.expert[comp.names.indexOf(n)])));
    const items = comp.names.map((name, i) => {
      const fast = comp.fast[i];
      const expert = comp.expert[i];
      const totalC = fast + expert;
      const s = comp.severity[name];
      const p1 = pct(s.P1 || 0, totalC);
      const ratio = maxP1 ? p1 / maxP1 : 0;
      const color = lerpColor("#fee2e2", "#991b1b", Math.pow(ratio, 0.8));
      const dark = ratio > 0.45;
      return {
        name,
        value: totalC,
        p1,
        severity: s,
        fast,
        expert,
        itemStyle: { color },
        label: { color: dark ? "#fff" : "#7f1d1d" },
      };
    });

    chart("aiAttr", {
      animationDuration: 700,
      tooltip: {
        ...tip,
        formatter: (p) => {
          const it = items[p.dataIndex];
          const s = it.severity;
          return (
            tipHead(p.name) +
            tipRow("#fda4af", "合计", fmt(it.value)) +
            tipRow(C.aiLight, "fast", fmt(it.fast)) +
            tipRow(C.ai, "expert", fmt(it.expert)) +
            `<div class="mt-1 border-t border-white/10 pt-1"></div>` +
            tipRow(C.sev1, "P1", `${fmt(s.P1 || 0)} · ${it.p1.toFixed(1)}%`) +
            tipRow(C.sev2, "P2", fmt(s.P2 || 0)) +
            tipRow(C.sev3, "P3", fmt(s.P3 || 0))
          );
        },
      },
      series: [
        {
          type: "treemap",
          left: 4,
          right: 4,
          top: 4,
          bottom: 4,
          roam: false,
          nodeClick: false,
          breadcrumb: { show: false },
          itemStyle: { borderColor: "#fff", borderWidth: 2, gapWidth: 2, borderRadius: 6 },
          label: {
            show: true,
            fontFamily: FONT,
            fontSize: 11,
            lineHeight: 15,
            formatter: (p) => `${SHORT[p.name] || p.name}\n${fmt(p.value)}`,
          },
          data: items,
        },
      ],
    });
  }

  // ------------------------------------------------------------------ boot
  function renderHeader(d) {
    const status = (d.wencai.run && d.wencai.run.status) || "";
    const map = {
      interrupted: ["中断", "text-amber-600", "bg-amber-500"],
      finished: ["完成", "text-emerald-600", "bg-emerald-500"],
      running: ["运行中", "text-emerald-600", "bg-emerald-500"],
    };
    const [text, cls, dot] = map[status] || [status || "—", "text-slate-500", "bg-slate-400"];
    $("runState").innerHTML = `<i class="inline-block h-1.5 w-1.5 rounded-full ${dot}"></i><span class="${cls}">${text}</span>`;
    $("updated").textContent = (d.generated_at || "").slice(5, 16).replace("T", " ");
    $("counted").textContent = d.counts_at || "—";
  }

  fetch("data.json?t=" + Date.now())
    .then((r) => {
      if (!r.ok) throw new Error("data.json " + r.status);
      return r.json();
    })
    .then((d) => {
      renderHeader(d);
      renderKpis(d);
      renderWencaiInput(d);
      renderWencaiCompare(d);
      renderWencaiAttr(d);
      renderAimeInput(d);
      renderAimeOutput(d);
      renderAimeAttr(d);
      $("mask").classList.add("hidden");
      window.__boardReady = true;
    })
    .catch((err) => {
      $("mask").innerHTML = `<span class="text-rose-500">数据加载失败：${err.message}</span>`;
      console.error(err);
    });

  let raf = 0;
  const resizeAll = () => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      charts.forEach((c) => c.resize());
      relayout.forEach((fn) => fn());
    });
  };
  window.addEventListener("resize", resizeAll);
  if (window.ResizeObserver) {
    new ResizeObserver(resizeAll).observe(document.body);
  }
})();
