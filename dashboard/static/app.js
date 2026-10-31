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
  let resizeRaf = 0;
  const resizeQueue = new Set();

  const C = {
    a: "#0f766e",
    aMid: "#3fb3a8",
    b: "#ea580c",
    bMid: "#f6b48e",
    ai: "#4338ca",
    aiMid: "#6366f1",
    aiLight: "#a5b4fc",
  };

  const AIME_SEVERITIES = ["P0", "P1", "P2", "P3", "未分级"];
  const SEV_COLOR = {
    P0: "#7f1d1d",
    P1: "#dc2626",
    P2: "#f59e0b",
    P3: "#94a3b8",
    未分级: "#cbd5e1",
  };

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

  function isDark(hex) {
    const n = parseInt(hex.slice(1), 16);
    const r = (n >> 16) & 255;
    const g = (n >> 8) & 255;
    const b = n & 255;
    return 0.299 * r + 0.587 * g + 0.114 * b < 150;
  }

  const abColor = (bShare) =>
    bShare <= 0.5
      ? lerpColor(C.a, "#e2e8f0", bShare * 2)
      : lerpColor("#e2e8f0", C.b, (bShare - 0.5) * 2);

  // ---------------------------------------------------------------- tooltip
  const tip = {
    backgroundColor: "#ffffff",
    borderColor: "#e7ecf2",
    borderWidth: 1,
    padding: 0,
    textStyle: { color: "#0f172a", fontSize: 11.5, fontFamily: FONT },
    extraCssText: "border-radius:12px;box-shadow:0 16px 36px -16px rgba(15,23,42,.35);",
    appendToBody: true,
    confine: false,
  };
  const tipCard = (html) => `<div class="tip-card">${html}</div>`;
  const tipHead = (title, meta, color) =>
    `<div class="tip-head"><i style="background:${color || "#94a3b8"}"></i><span>${title}</span>` +
    `${meta ? `<em>${meta}</em>` : ""}</div>`;
  const tipSep = () => `<div class="tip-sep"></div>`;
  const tipRow = (color, label, value) =>
    `<div class="tip-row"><i style="background:${color}"></i><span>${label}</span><b>${value}</b></div>`;

  // ------------------------------------------------------------------ utils
  function setNum(id, value, opts) {
    const el = $(id);
    if (!el) return;
    el.dataset.count = String(value == null ? 0 : value);
    if (opts && opts.decimals != null) el.dataset.decimals = String(opts.decimals);
    if (opts && opts.suffix) el.dataset.suffix = opts.suffix;
  }

  function startCounters() {
    const CU = (window.countUp && window.countUp.CountUp) || window.CountUp;
    document.querySelectorAll("[data-count]").forEach((el) => {
      const end = Number(el.dataset.count);
      if (!Number.isFinite(end)) return;
      const decimals = Number(el.dataset.decimals || 0);
      const suffix = el.dataset.suffix || "";
      if (REDUCED || !CU) {
        el.textContent = fmtFixed(end, decimals) + suffix;
        return;
      }
      const counter = new CU(el, end, {
        duration: 1.1,
        decimalPlaces: decimals,
        separator: ",",
        decimal: ".",
        suffix,
        useGrouping: true,
      });
      if (counter.error) {
        el.textContent = fmtFixed(end, decimals) + suffix;
      } else {
        counter.start();
      }
    });
  }

  function animateTo(id, value, decimals) {
    const el = $(id);
    if (!el) return;
    const d = decimals || 0;
    el.dataset.count = String(value == null ? 0 : value);
    const CU = (window.countUp && window.countUp.CountUp) || window.CountUp;
    if (REDUCED || !CU) {
      el.textContent = fmtFixed(value || 0, d);
      return;
    }
    const counter = new CU(el, value || 0, {
      duration: 0.45,
      decimalPlaces: d,
      separator: ",",
      decimal: ".",
      useGrouping: true,
    });
    if (counter.error) el.textContent = fmtFixed(value || 0, d);
    else counter.start();
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
      new ResizeObserver(() => scheduleResize(c, el)).observe(el);
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
    const from = isWc ? "#0b5f59" : "#312e81";
    const to = isWc ? "#d9f0ec" : "#e0e7ff";
    return lerpColor(from, to, n > 1 ? i / (n - 1) : 0);
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
      right.innerHTML = `${fmt(total)} <span>条</span>`;
    } else {
      back.hidden = true;
      note.textContent = "最大类";
      const top = tasksOf(st.src, isWc)[0];
      right.innerHTML = top
        ? `${top.name} <b>${pct(top.value, st.src.input.total).toFixed(1)}%</b>`
        : "—";
    }
  }

  function renderTaskList(product) {
    const isWc = product === "wencai";
    const st = volumeState[product];
    const el = $(isWc ? "wcTaskList" : "aiTaskList");
    if (!el) return;
    const tasks = tasksOf(st.src, isWc);
    const total = st.src.input.total || tasks.reduce((n, c) => n + (c.value || 0), 0) || 1;
    const max = Math.max(1, ...tasks.map((c) => c.value || 0));
    el.innerHTML =
      `<div class="task-grid">` +
      tasks
        .map((c, i) => {
          const share = pct(c.value, total);
          const color = volumeColor(isWc, i, tasks.length);
          return (
            `<button class="task-row" type="button" data-task="${c.name}" title="${c.name} · ${fmt(c.value)} 条 · ${share.toFixed(1)}%">` +
            `<span class="task-name">${c.name}</span>` +
            `<span class="task-track"><i class="task-fill" data-w="${((100 * (c.value || 0)) / max).toFixed(1)}" style="background:${color}"></i></span>` +
            `<span class="task-val">${fmt(c.value)}</span>` +
            `<span class="task-pct">${share.toFixed(1)}%</span>` +
            `</button>`
          );
        })
        .join("") +
      `</div>`;
    const animate = () =>
      el.querySelectorAll(".task-fill").forEach((f) => {
        f.style.width = `${f.dataset.w}%`;
      });
    if (REDUCED) animate();
    else requestAnimationFrame(animate);
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
        const color = volumeColor(isWc, i, subs.length);
        return (
          `<div class="sub-row" title="${c.name} · ${fmt(c.value)} 条 · ${share.toFixed(1)}%">` +
          `<span class="sub-name">${c.name}</span>` +
          `<span class="sub-track"><i class="sub-fill" data-w="${((100 * (c.value || 0)) / max).toFixed(1)}" style="background:${color}"></i></span>` +
          `<span class="sub-val">${fmt(c.value)}</span>` +
          `<span class="sub-pct">${share.toFixed(1)}%</span>` +
          `</div>`
        );
      })
      .join("");
    const animate = () =>
      list.querySelectorAll(".sub-fill").forEach((f) => {
        f.style.width = `${f.dataset.w}%`;
      });
    if (REDUCED) animate();
    else requestAnimationFrame(animate);
  }

  function drawVolume(product) {
    const isWc = product === "wencai";
    const st = volumeState[product];
    const taskList = $(isWc ? "wcTaskList" : "aiTaskList");
    const subList = $(isWc ? "wcSubList" : "aiSubList");
    if (!st.src || !taskList || !subList) return;
    if (st.task) {
      taskList.hidden = true;
      subList.hidden = false;
      renderSubList(product);
    } else {
      subList.hidden = true;
      taskList.hidden = false;
      renderTaskList(product);
    }
    updateVolumeNote(product);
  }

  // -------------------------------------------------------------- volume card
  function renderVolume(product, d) {
    const isWc = product === "wencai";
    const src = isWc ? d.wencai : d.aime;
    volumeState[product] = { src, task: null };

    const taskList = $(isWc ? "wcTaskList" : "aiTaskList");
    if (taskList) {
      taskList.onclick = (ev) => {
        const row = ev.target.closest(".task-row");
        if (!row) return;
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
        drawVolume(product);
      };
    }

    drawVolume(product);
    const input = src.input;
    setNum(isWc ? "wcTotal" : "aiTotal", input.total);
    $(isWc ? "wcVolMeta" : "aiVolMeta").textContent = dateRange(input.date_range);
  }

  // ------------------------------------------------------------ coverage card
  function renderRing(id, evaluated, pending, color) {
    const total = evaluated + pending;
    chart(id, {
      animationDuration: REDUCED ? 0 : 900,
      animationEasing: "cubicOut",
      animationDelay: REDUCED ? 0 : 160,
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
            { value: Math.max(0, pending), name: "待评测", itemStyle: { color: "#e9eef5" } },
          ],
        },
      ],
    });
  }

  function renderModels(id, rows) {
    const el = $(id);
    if (!el) return;
    const max = Math.max(1, ...rows.map((r) => r.value));
    el.innerHTML = rows
      .map(
        (r) =>
          `<div class="model-row" title="${r.name} · ${fmt(r.value)} 条">` +
          `<span class="model-name">${r.name}</span>` +
          `<span class="model-track"><i class="model-fill" data-w="${((100 * r.value) / max).toFixed(1)}" style="background:${r.color}"></i></span>` +
          `<span class="model-val">${fmt(r.value)}</span>` +
          `</div>`
      )
      .join("");
    const animate = () =>
      el.querySelectorAll(".model-fill").forEach((f) => {
        f.style.width = `${f.dataset.w}%`;
      });
    if (REDUCED) animate();
    else requestAnimationFrame(animate);
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
      `<b>${(out.problems / Math.max(1, evaluated)).toFixed(1)}</b>`;

    let p50 = out.p50 || 0;
    if (isWc) {
      const vals = Object.values(out.versions || {})
        .map((v) => v.p50)
        .filter((v) => v > 0);
      p50 = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
    }
    $(isWc ? "wcEvalStats" : "aiEvalStats").innerHTML = [
      `问题 <b>${fmt(out.problems)}</b>`,
      `Tokens <b>${fmtTokens(out.tokens || 0)}</b>`,
      `P50 <b>${p50 ? p50.toFixed(1) + "s" : "—"}</b>`,
    ]
      .map((x) => `<span>${x}</span>`)
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
      renderModels(
        "wcModels",
        defs.map(([key, name, color]) => ({
          name,
          color,
          value: (out.versions[key] && out.versions[key].answers) || 0,
        }))
      );
    } else {
      renderModels("aiModels", [
        { name: "fast", color: C.aiMid, value: (out.by_model && out.by_model.fast) || 0 },
        { name: "expert", color: C.aiLight, value: (out.by_model && out.by_model.expert) || 0 },
      ]);
      renderSpark(out.per_day || []);
    }
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
          `<i class="spark-bar" style="--h:${h}%;background:linear-gradient(180deg,rgba(129,140,248,${alpha}),rgba(67,56,202,${alpha}))"` +
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
    const max = Math.max(1, ...rows.map((r) => r.value));
    el.innerHTML = rows
      .map((r) => {
        let segs = "";
        let title = `${r.name} · ${fmt(r.value)} 问题`;
        if (mode === "wc") {
          segs =
            `<i class="attr-seg a" data-w="${((100 * r.a) / max).toFixed(2)}"></i>` +
            `<i class="attr-seg b" data-w="${((100 * r.b) / max).toFixed(2)}"></i>`;
          title += ` · A 组 ${fmt(r.a)} / B 组 ${fmt(r.b)}`;
        } else {
          segs = AIME_SEVERITIES.map(
            (sev, i) =>
              `<i class="attr-seg s${i}" data-w="${((100 * (r.severity[sev] || 0)) / max).toFixed(2)}"></i>`
          ).join("");
          title += ` · P1 ${fmt(r.severity.P1 || 0)}`;
        }
        return (
          `<div class="attr-row" title="${title}">` +
          `<span class="attr-name">${r.name}</span>` +
          `<span class="attr-track">${segs}</span>` +
          `<span class="attr-val">${fmt(r.value)}</span>` +
          `</div>`
        );
      })
      .join("");
    const animate = () =>
      el.querySelectorAll(".attr-seg").forEach((seg) => {
        seg.style.width = `${seg.dataset.w}%`;
      });
    if (REDUCED) animate();
    else requestAnimationFrame(animate);
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
  const CLUSTER_COLORS = {
    wencai: ["#0f766e", "#0ea5e9", "#f59e0b", "#8b5cf6", "#ef4444", "#64748b"],
    aime: ["#4338ca", "#0ea5e9", "#f59e0b", "#ec4899", "#14b8a6", "#64748b"],
  };

  function decorateCluster(node, color, depth) {
    const bg = depth === 0 ? color : lerpColor(color, "#ffffff", 0.12 + depth * 0.08);
    const out = {
      id: node.id || node.name,
      name: node.name,
      value: node.value,
      items: node.items || 0,
      itemStyle: { color: bg },
      label: { color: isDark(bg) ? "#ffffff" : "#0f172a" },
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
      return [{}, { r0: "30%", r: "94%", label: { rotate: 0, fontSize: 10, minAngle: 8 } }];
    }
    if (depth === 2) {
      return [
        {},
        { r0: "26%", r: "60%", label: { rotate: 0, fontSize: 9, minAngle: 10 } },
        { r0: "60%", r: "94%", label: { show: false } },
      ];
    }
    return [
      {},
      { r0: "20%", r: "48%", label: { rotate: 0, fontSize: 9, minAngle: 10 } },
      { r0: "48%", r: "70%", label: { show: false } },
      { r0: "70%", r: "94%", label: { show: false } },
    ];
  }

  function clusterOption(product) {
    const isWc = product === "wencai";
    const st = clusterState[product];
    const current = st.stack.length ? st.stack[st.stack.length - 1] : st.root;
    const branches = (current && current.children) || [];
    const palette = CLUSTER_COLORS[isWc ? "wencai" : "aime"];
    const data = branches.map((n, i) => decorateCluster(n, palette[i % palette.length], 0));
    const total = st.meta ? st.meta.total_sessions : (current && current.value) || 1;

    return {
      animationDuration: REDUCED ? 0 : 850,
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
              tipRow("#94a3b8", "会话", fmt(p.value)) +
              tipRow("#94a3b8", "条目", fmt((p.data && p.data.items) || 0)) +
              (path ? `<div class="tip-path">${path}</div>` : "")
          );
        },
      },
      series: [
        {
          type: "sunburst",
          radius: ["20%", "94%"],
          center: ["50%", "50%"],
          data,
          nodeClick: false,
          sort: null,
          itemStyle: { borderColor: "#fff", borderWidth: 1.5 },
          label: {
            rotate: 0,
            fontSize: 9,
            minAngle: 10,
            formatter: (p) => p.name,
          },
          levels: clusterLevels(data),
          emphasis: { focus: "ancestor" },
        },
      ],
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

    clusterState[product] = { src, root, meta, stack: [], nodeById };
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
        const stack = [];
        for (const name of names) {
          const next = (node.children || []).find((c) => c.name === name);
          if (!next) break;
          stack.push(next);
          node = next;
        }
        if (!stack.length) return;
        st.stack = stack;
        drawCluster(product);
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
    $(isWc ? "wcForecastNote" : "aiForecastNote").textContent = `±${Math.round(band * 100)}%`;

    const actualData = [...demo, ...Array(7).fill(null)];
    const forecastData = [...Array(n - 1).fill(null), demo[n - 1], ...forecast];
    const lowerData = [...Array(n).fill(null), ...lower];
    const bandData = [...Array(n).fill(null), ...upper.map((u, i) => u - lower[i])];

    chart(isWc ? "wcForecastChart" : "aiForecastChart", {
      animationDuration: REDUCED ? 0 : 950,
      animationEasing: "cubicOut",
      tooltip: {
        ...tip,
        trigger: "axis",
        axisPointer: { type: "line", lineStyle: { color: "#e2e8f0" } },
        formatter: (params) => {
          const i = params[0].dataIndex;
          const date = labels[i];
          if (i >= n) {
            const k = i - n;
            return tipCard(
              tipHead(date, "预测", "#f59e0b") +
                tipRow("#f59e0b", "预测值", fmt(forecast[k])) +
                tipRow("#94a3b8", "区间", `${fmt(lower[k])}–${fmt(upper[k])}`)
            );
          }
          return tipCard(tipHead(date, "实际", accent) + tipRow(accent, "实际值", fmt(demo[i])));
        },
      },
      grid: { left: 18, right: 16, top: 12, bottom: 20 },
      xAxis: {
        type: "category",
        data: labels,
        boundaryGap: false,
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { fontSize: 8.5, color: "#94a3b8", interval: 5, fontFamily: FONT },
      },
      yAxis: { type: "value", show: false, min: 0 },
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
        },
        {
          name: "预测",
          type: "line",
          data: forecastData,
          smooth: 0.35,
          symbol: "none",
          lineStyle: { width: 1.8, type: "dashed", color: "#f59e0b" },
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
  let switching = false;

  function initSwitch() {
    const btn = $("switchProduct");
    if (!btn) return;
    btn.addEventListener("click", () => {
      if (switching) return;
      const current = document.querySelector(".page.is-active");
      const nextProduct = activeProduct === "wencai" ? "aime" : "wencai";
      const next = document.querySelector(`.page[data-product="${nextProduct}"]`);
      if (!current || !next) return;
      activeProduct = nextProduct;
      $("switchLabel").textContent = nextProduct === "wencai" ? "切换到 AIME" : "切换到 问财";
      $("switchArrow").textContent = nextProduct === "wencai" ? "→" : "←";
      current.setAttribute("aria-hidden", "true");
      next.setAttribute("aria-hidden", "false");

      if (REDUCED) {
        current.classList.remove("is-active");
        next.classList.add("is-active");
        requestAnimationFrame(() => charts.forEach((c) => c.resize()));
        return;
      }

      switching = true;
      current.classList.add("animate__animated", "animate__flipOutY", "is-leaving");
      current.style.animationDuration = "0.55s";
      next.classList.add("is-active", "animate__animated", "animate__flipInY");
      next.style.animationDuration = "0.55s";
      requestAnimationFrame(() => charts.forEach((c) => c.resize()));

      setTimeout(() => {
        current.classList.remove(
          "is-active",
          "is-leaving",
          "animate__animated",
          "animate__flipOutY"
        );
        current.style.animationDuration = "";
        next.classList.remove("animate__animated", "animate__flipInY");
        next.style.animationDuration = "";
        switching = false;
        charts.forEach((c) => c.resize());
      }, 580);
    });
  }

  // -------------------------------------------------------------------- boot
  function reveal() {
    const mask = $("mask");
    if (mask) {
      mask.classList.add("is-hidden");
      setTimeout(() => mask.remove(), 400);
    }
    if (!REDUCED) {
      document.querySelectorAll("[data-card]").forEach((el, i) => {
        el.classList.add("animate__animated", "animate__fadeInUp");
        el.style.animationDelay = `${80 + i * 45}ms`;
        el.style.animationDuration = "520ms";
      });
    }
    setTimeout(startCounters, REDUCED ? 0 : 120);
    setTimeout(() => {
      window.__boardReady = true;
    }, 700);
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
      renderHeader(d);
      renderVolume("wencai", d);
      renderEvaluation("wencai", d);
      renderWencaiAttr(d);
      renderCluster("wencai", d);
      renderPrediction("wencai", d);
      renderVolume("aime", d);
      renderEvaluation("aime", d);
      renderAimeAttr(d);
      renderCluster("aime", d);
      renderPrediction("aime", d);
      initSwitch();
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
