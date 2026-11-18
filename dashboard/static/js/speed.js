/* 评测速度: migrated from eval_agent_harness/server_monitor and upgraded with live RPM & gateway telemetry. */
import { $, esc, fmt, compact, pct, segmented, showTip, hideTip, getJSON } from "./core.js";

const POLL_MS = 15000;
const DATE_PAGE_SIZE = 12;
const SVG_NS = "http://www.w3.org/2000/svg";

const CHART_PAD = { L: 48, R: 24, T: 18, B: 32 };

const S = {
  data: null,
  timer: 0,
  inflight: false,
  selectedModel: null,
  range: 300,
  chartMode: "landing",
  dateFilter: { year: "all", month: "all", page: 1 },
  chartSamples: [],
  chartPlotStart: 0,
  chartPlotSpan: 300,
  rangeSeg: null,
  modeSeg: null,
  sourceUrl: "speed.json",
  root: null,
  ctx: null,
};

const sitesMap = () => {
  try {
    return JSON.parse(document.getElementById("sites")?.textContent || "{}");
  } catch {
    return {};
  }
};

const num = (v) => (v == null || !Number.isFinite(Number(v)) ? "—" : fmt(Number(v)));
const rate = (v) => (v == null || !Number.isFinite(Number(v)) ? "—" : fmt(Number(v), 1));
const clock = (iso) => {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleTimeString("zh-CN", { hour12: false });
};

function agoLabel(sec) {
  if (sec == null || !Number.isFinite(Number(sec))) return "—";
  const s = Math.max(0, Math.round(Number(sec)));
  if (s < 60) return `${s}s 前`;
  if (s < 3600) return `${Math.floor(s / 60)}m 前`;
  return `${(s / 3600).toFixed(1)}h 前`;
}

function etaLabel(minutes) {
  if (minutes == null || !Number.isFinite(Number(minutes))) return "—";
  const m = Number(minutes);
  if (m <= 0) return "已完成";
  if (m < 60) return `${Math.max(1, Math.ceil(m))} 分钟`;
  if (m < 1440) return `${(m / 60).toFixed(1)} 小时`;
  return `${(m / 1440).toFixed(1)} 天`;
}

function setText(root, id, value) {
  const el = $(`#${id}`, root);
  if (el && el.textContent !== value) el.textContent = value;
}

function setHTML(root, id, html) {
  const el = $(`#${id}`, root);
  if (el && el._lastHTML !== html) {
    el.innerHTML = html;
    el._lastHTML = html;
  }
}

function progressBarCell(ratio) {
  const clamped = Math.max(0, Math.min(1, Number(ratio) || 0));
  return `<td class="sp-prog-cell"><span class="sp-mini-bar"><i style="width:${(clamped * 100).toFixed(1)}%"></i></span><span class="num">${(clamped * 100).toFixed(1)}%</span></td>`;
}

function shellHTML() {
  return `<div class="bento sp-bento">
    <article class="card" style="--span:12">
      <header class="card-head">
        <h2>评测输入与总进度</h2>
        <span class="sp-conn" id="spConn"><i></i><span id="spConnText">读取中</span></span>
        <span class="meta num" id="spInputUpdated"></span>
        <time class="meta num end" id="spUpdated">—</time>
      </header>
      <div class="sp-grid-4">
        <div class="sp-stat">
          <span class="sp-stat-label">输入 Session</span>
          <div class="sp-stat-val"><span class="big num" id="spInputSessions">—</span><span class="unit">session</span></div>
          <p class="sp-stat-sub">Trace <b class="num" id="spInputTraces">—</b></p>
        </div>
        <div class="sp-stat">
          <span class="sp-stat-label">已评测</span>
          <div class="sp-stat-val"><span class="mid num" id="spAttrSessions">—</span><span class="unit">session</span></div>
          <p class="sp-stat-sub">Trace <b class="num" id="spAttrTraces">—</b></p>
        </div>
        <div class="sp-stat">
          <span class="sp-stat-label">待评测</span>
          <div class="sp-stat-val"><span class="mid num" id="spRemainingSessions">—</span><span class="unit">session</span></div>
          <p class="sp-stat-sub">Trace <b class="num" id="spRemainingTraces">—</b></p>
        </div>
        <div class="sp-stat">
          <span class="sp-stat-label">完成度</span>
          <div class="sp-stat-val"><span class="mid num" id="spPercent">—</span></div>
          <p class="sp-stat-sub">Trace 完成度 <b class="num" id="spTracePercent">—</b></p>
        </div>
      </div>
      <div class="sp-bar" role="progressbar" aria-label="评测完成度" aria-valuemin="0" aria-valuemax="100" id="spBar"><i id="spProgress"></i></div>
    </article>

    <article class="card" style="--span:12">
      <header class="card-head">
        <h2>本批 Chunk 队列</h2>
        <span class="meta num" id="spQueueTotal">—</span>
        <span class="meta num end" id="spQueueEta">—</span>
      </header>
      <div class="sp-grid-4">
        <div class="sp-stat">
          <span class="sp-stat-label">已完成</span>
          <div class="sp-stat-val"><span class="mid num" id="spQueueDone">—</span><span class="unit">chunk</span></div>
        </div>
        <div class="sp-stat">
          <span class="sp-stat-label">运行中</span>
          <div class="sp-stat-val"><span class="mid num" id="spQueueRunning">—</span><span class="unit">chunk</span></div>
        </div>
        <div class="sp-stat">
          <span class="sp-stat-label">待跑 / 重试</span>
          <div class="sp-stat-val"><span class="mid num" id="spQueuePending">—</span><span class="unit">chunk</span></div>
        </div>
        <div class="sp-stat">
          <span class="sp-stat-label">完成度</span>
          <div class="sp-stat-val"><span class="mid num" id="spQueuePercent">—</span></div>
          <p class="sp-stat-sub" id="spQueueModels">等待队列数据…</p>
        </div>
      </div>
      <div class="sp-bar" role="progressbar" aria-label="本批 chunk 完成度" aria-valuemin="0" aria-valuemax="100" id="spQueueBar"><i id="spQueueProgress"></i></div>
      <div class="sp-locks" id="spLocks" hidden></div>
    </article>

    <article class="card sp-rate-card is-rate-attr" style="--span:4">
      <header class="card-head"><h2>Attribution 落地</h2><span class="meta" id="spAttrWindow">近 5 分钟</span></header>
      <div class="sp-rate"><span class="big num" id="spAttrRate">—</span><span class="unit">条/分钟</span></div>
      <p class="sp-rate-sub" id="spPartsAttrSub">在途实时 (.parts) —</p>
    </article>

    <article class="card sp-rate-card is-rate-comp" style="--span:4">
      <header class="card-head"><h2>Compact</h2><span class="meta" id="spCompactWindow">近 5 分钟</span></header>
      <div class="sp-rate"><span class="big num" id="spCompactRate">—</span><span class="unit">条/分钟</span></div>
      <p class="sp-rate-sub" id="spPartsCompactSub">在途实时 (.parts) —</p>
    </article>

    <article class="card sp-rate-card" style="--span:4">
      <header class="card-head"><h2>预计跑完</h2><span class="meta" id="spEtaMeta">按已评测 Trace 增量</span></header>
      <div class="sp-rate"><span class="big num" id="spEta">—</span></div>
      <p class="sp-rate-sub" id="spEtaSub">剩余 —</p>
    </article>

    <article class="card" style="--span:12">
      <header class="card-head">
        <h2>速度趋势</h2>
        <div class="sp-legend" id="spChartLegend"></div>
        <div class="sp-chart-tools">
          <div class="seg" id="spChartMode" role="group" aria-label="趋势指标">
            <span class="seg-knob" aria-hidden="true"></span>
            <button type="button" data-value="landing">落地速度</button>
            <button type="button" data-value="rpm">实时 RPM</button>
          </div>
          <div class="seg" id="spRange" role="group" aria-label="历史窗口">
            <span class="seg-knob" aria-hidden="true"></span>
            <button type="button" data-value="300">5 分钟</button>
            <button type="button" data-value="3600">1 小时</button>
            <button type="button" data-value="21600">6 小时</button>
            <button type="button" data-value="86400">24 小时</button>
            <button type="button" data-value="172800">48 小时</button>
          </div>
        </div>
      </header>
      <div class="sp-chart-wrap" id="spChartWrap">
        <svg class="sp-chart" id="spChart" viewBox="0 0 960 256" role="img" aria-label="评测速度与 RPM 实时趋势">
          <g class="sp-grid" id="spGrid"></g>
          <path class="sp-area sp-area-attr" id="spArea1" d=""></path>
          <path class="sp-area sp-area-comp" id="spArea2" d=""></path>
          <line class="sp-line sp-line-quota" id="spQuotaLine" x1="0" x2="0" y1="0" y2="0" visibility="hidden"></line>
          <line class="sp-hover-line" id="spHoverLine" x1="0" x2="0" y1="18" y2="224" visibility="hidden"></line>
          <path class="sp-line sp-line-attr" id="spLine1" d=""></path>
          <path class="sp-line sp-line-comp" id="spLine2" d=""></path>
          <g class="sp-axis" id="spAxis"></g>
          <g id="spPointLayer"></g>
        </svg>
        <div class="sp-chart-empty" id="spChartEmpty" hidden>正在采集实时数据，约 15–30 秒后绘出趋势…</div>
      </div>
    </article>

    <article class="card" style="--span:12">
      <header class="card-head">
        <h2>网关与实时调度</h2>
        <span class="meta" id="spGwSummary">—</span>
        <span class="meta num end" id="spGwTuneAt">—</span>
      </header>
      <div class="sp-gw-kpis">
        <div class="sp-gw-kpi">
          <span class="sp-gw-kpi-label">实时请求速度</span>
          <div class="sp-gw-kpi-val"><b class="mid num" id="spGwRpm">—</b><span class="unit">RPM</span></div>
          <div class="sp-gw-meter" id="spGwMeter"><i id="spGwMeterFill" style="width:0%"></i></div>
          <span class="sp-gw-kpi-sub" id="spGwRpmSub">配额 —</span>
        </div>
        <div class="sp-gw-kpi">
          <span class="sp-gw-kpi-label">在途吞吐 (.parts)</span>
          <div class="sp-gw-kpi-val"><b class="mid num" id="spGwPartsAttr">—</b><span class="sp-slash">/</span><b class="mid num" id="spGwPartsComp">—</b><span class="unit">条/分</span></div>
          <span class="sp-gw-kpi-sub" id="spGwPartsSub">活跃写入流 —</span>
        </div>
        <div class="sp-gw-kpi">
          <span class="sp-gw-kpi-label">调度并发预算 (Control)</span>
          <div class="sp-gw-kpi-val"><b class="mid num" id="spGwPermits">—</b><span class="unit">许可 / 实例</span></div>
          <span class="sp-gw-kpi-sub" id="spGwControlSub">任务并发 —</span>
        </div>
        <div class="sp-gw-kpi">
          <span class="sp-gw-kpi-label">网关探活与延迟</span>
          <div class="sp-gw-kpi-val"><b class="mid num" id="spGwLatency">—</b><span class="unit">ms</span></div>
          <span class="sp-gw-kpi-sub" id="spGwProbeSub">最近活跃 —</span>
        </div>
      </div>
      <div class="md-table sp-table">
        <table>
          <thead>
            <tr>
              <th>网关 / 渠道</th>
              <th>状态</th>
              <th>模型</th>
              <th class="num">实时 RPM / 配额</th>
              <th class="num">并发许可</th>
              <th class="num">运行实例 / 写入流</th>
              <th class="num">探活延迟</th>
              <th class="num">最近活跃</th>
            </tr>
          </thead>
          <tbody id="spGateways"><tr><td colspan="8" class="empty">读取中…</td></tr></tbody>
        </table>
      </div>
    </article>

    <article class="card" style="--span:12">
      <header class="card-head"><h2>聚类进度</h2></header>
      <div class="sp-grid-2">
        <div class="sp-stat">
          <span class="sp-stat-label">已处理 Trace</span>
          <div class="sp-stat-val"><span class="big num" id="spClusterTraces">—</span></div>
        </div>
        <div class="sp-stat">
          <span class="sp-stat-label">待聚类 Trace</span>
          <div class="sp-stat-val"><span class="big num" id="spClusterPending">—</span></div>
        </div>
      </div>
      <div class="md-table sp-table">
        <table>
          <thead><tr><th>目录</th><th class="num">已处理 Trace</th><th class="num">已落地 Trace</th><th class="num">待聚类 Trace</th></tr></thead>
          <tbody id="spClusterModels"><tr><td colspan="4" class="empty">读取中…</td></tr></tbody>
        </table>
      </div>
    </article>

    <article class="card" style="--span:12">
      <header class="card-head"><h2>输入分布</h2></header>
      <div id="spModelList" class="md-table sp-table">
        <table>
          <thead>
            <tr><th>目录</th><th class="num">输入 Session</th><th class="num">输入 Trace</th><th class="num">已评测 Session</th><th class="num">已评测 Trace</th><th class="num">待评 Session</th><th class="num">待评 Trace</th><th>进度</th></tr>
          </thead>
          <tbody id="spModels"><tr><td colspan="8" class="empty">读取中…</td></tr></tbody>
        </table>
      </div>
      <div id="spDateView" hidden>
        <div class="sp-date-head">
          <button type="button" class="sp-back" id="spBack">← 返回目录</button>
          <div class="sp-filters">
            <label>年 <select class="sp-select" id="spDateYear"></select></label>
            <label>月 <select class="sp-select" id="spDateMonth"></select></label>
          </div>
          <div class="pager">
            <span class="pager-info" id="spDatePageInfo"></span>
            <button type="button" id="spDatePrev">上一页</button>
            <button type="button" id="spDateNext">下一页</button>
          </div>
        </div>
        <div class="md-table sp-table">
          <table>
            <thead>
              <tr><th>日期</th><th class="num">输入 Session</th><th class="num">输入 Trace</th><th class="num">已评测 Session</th><th class="num">已评测 Trace</th><th class="num">待评 Session</th><th class="num">待评 Trace</th><th>进度</th></tr>
            </thead>
            <tbody id="spDates"></tbody>
          </table>
        </div>
      </div>
    </article>
  </div>`;
}

function renderLocks(root, queue) {
  const box = $("#spLocks", root);
  if (!box) return;
  const locks = queue?.locks || [];
  if (!locks.length) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  const html = locks.map((l) => {
    const label = [l.model, l.date, l.chunk].filter(Boolean).join(" · ") || l.unit;
    const owner = l.owner !== "" ? `实例 #${esc(l.owner)}` : "运行中";
    return `<span class="sp-lock"><i></i><b>${esc(label)}</b><span>${owner} · ${fmt(l.elapsed_m, 1)}m · 心跳 ${fmt(l.heartbeat_age_s, 0)}s 前</span></span>`;
  }).join("");
  setHTML(root, "spLocks", html);
}

function renderQueue(root, q) {
  const queue = q || {};
  if (queue.total == null) {
    setText(root, "spQueueTotal", "等待队列数据…");
    return;
  }
  const total = Number(queue.total) || 0;
  const done = Number(queue.done) || 0;
  const running = Number(queue.running) || 0;
  const left = Math.max(0, (Number(queue.pending) || 0) + (Number(queue.retry) || 0));
  const ratio = total ? done / total : 0;
  setText(root, "spQueueTotal", `共 ${num(total)} 个 chunk`);
  setText(root, "spQueueDone", num(done));
  setText(root, "spQueueRunning", num(running));
  setText(root, "spQueuePending", num(left));
  setText(root, "spQueuePercent", pct(done, total, 1));
  const fill = $("#spQueueProgress", root);
  if (fill) fill.style.width = `${Math.max(0, Math.min(1, ratio)) * 100}%`;
  const bar = $("#spQueueBar", root);
  if (bar) bar.setAttribute("aria-valuenow", String(Math.round(ratio * 100)));
  setText(root, "spQueueEta", queue.eta_minutes == null ? "本批 ETA —" : `本批约 ${etaLabel(queue.eta_minutes)}`);
  const models = (queue.models || []).map((m) => `${m.name} ${num(m.done)}/${num(m.total)}`);
  setText(root, "spQueueModels", models.length ? models.join(" · ") : "—");
  renderLocks(root, queue);
}

function renderGateways(root, gw) {
  const g = gw || {};
  const items = g.items || [];
  const ctrl = g.control || {};
  const limit = g.rpm_limit;
  const liveRpm = g.realtime_rpm;
  const util = limit && liveRpm != null ? Math.max(0, Math.min(1, liveRpm / limit)) : 0;

  setText(root, "spGwSummary", items.length
    ? `${g.healthy} / ${g.count} 健康${ctrl.paused ? " · 已暂停" : ""}`
    : "未配置网关");
  setText(root, "spGwTuneAt", ctrl.auto_tune_at
    ? `自动调速 ${clock(ctrl.auto_tune_at)}${items[0]?.rpm_window ? ` · ${items[0].rpm_window}` : ""}`
    : (items[0]?.rpm_window || "—"));

  setText(root, "spGwRpm", liveRpm == null ? "—" : rate(liveRpm));
  setText(root, "spGwRpmSub", limit
    ? `限额 ${num(limit)} RPM · 利用率 ${liveRpm == null ? "—" : pct(liveRpm, limit, 1)}`
    : "限额 —");
  const meter = $("#spGwMeter", root);
  const meterFill = $("#spGwMeterFill", root);
  if (meter && meterFill) {
    meterFill.style.width = `${(util * 100).toFixed(1)}%`;
    meter.classList.toggle("is-hot", util >= 0.85);
  }

  setText(root, "spGwPartsAttr", rate(g.parts_attr_rate));
  setText(root, "spGwPartsComp", rate(g.parts_compact_rate));
  const writers = g.active_writers ?? 0;
  const ageStr = g.newest_part_age_s != null ? ` · ${agoLabel(g.newest_part_age_s)}写入` : "";
  setText(root, "spGwPartsSub", `${num(writers)} 个活跃写入流${ageStr}`);

  setText(root, "spGwPermits", ctrl.model_requests != null ? num(ctrl.model_requests) : "—");
  setText(root, "spGwControlSub", ctrl.concurrency != null
    ? `任务并发 ${num(ctrl.concurrency)} · Heavy ${num(ctrl.heavy_model_requests)} · Backlog ${num(ctrl.compact_backlog)}`
    : "等待 control.json");

  const lead = items[0];
  setText(root, "spGwLatency", lead?.latency_ms != null ? fmt(lead.latency_ms, 1) : "—");
  const repLabel = g.active_replicas != null ? `${num(g.active_replicas)} 台运行中` : "0 台运行中";
  setText(root, "spGwProbeSub", lead
    ? `HTTP ${lead.code || "—"} · 活跃 ${agoLabel(lead.active_ago_s)} · ${repLabel}`
    : repLabel);

  if (!items.length) {
    setHTML(root, "spGateways", `<tr><td colspan="8" class="empty">未配置网关</td></tr>`);
    return;
  }
  const rowsHTML = items.map((item) => {
    const cls = item.cooldown ? "is-warn" : item.ok ? "is-ok" : "";
    const statusText = item.cooldown ? "冷却中" : item.healthy ? "健康 200" : item.ok ? `可连接 ${item.code}` : "离线";
    const modelsText = (item.models || []).length ? item.models.join(", ") : "—";
    const urlShort = String(item.url || "").replace(/^https?:\/\//, "").replace(/\/v1\/?$/, "");
    const rpmCell = item.rpm != null
      ? `${rate(item.rpm)}${item.rpm_limit ? `<span class="faint"> / ${num(item.rpm_limit)}</span>` : ""}`
      : (item.rpm_limit ? `—<span class="faint"> / ${num(item.rpm_limit)}</span>` : "—");
    const permitCell = item.permits != null
      ? `${num(item.permits)}${item.concurrency != null ? `<span class="faint"> / ${num(item.concurrency)}</span>` : ""}`
      : "—";
    const streamCell = `${item.active_replicas != null ? `${num(item.active_replicas)} 台` : "—"} · ${num(item.active_writers)} 流`;
    const latCell = item.latency_ms != null ? `${fmt(item.latency_ms, 1)} ms` : "—";
    return `<tr>
      <td><span class="sp-gw-name">${esc(item.name)}</span><span class="sp-gw-url">${esc(urlShort)}</span></td>
      <td><span class="sp-badge ${cls}"><i></i>${esc(statusText)}</span></td>
      <td><span class="sp-chip">${esc(modelsText)}</span></td>
      <td class="num">${rpmCell}</td>
      <td class="num">${permitCell}</td>
      <td class="num">${streamCell}</td>
      <td class="num">${latCell}</td>
      <td class="num">${esc(agoLabel(item.active_ago_s))}</td>
    </tr>`;
  }).join("");
  setHTML(root, "spGateways", rowsHTML);
}

function renderCluster(root, cluster) {
  const c = cluster || {};
  const models = c.models || [];
  setText(root, "spClusterTraces", num(c.traces));
  setText(root, "spClusterPending", num(c.pending));
  if (!models.length) {
    setHTML(root, "spClusterModels", `<tr><td colspan="4" class="empty">暂无聚类数据</td></tr>`);
    return;
  }
  const html = models.map((m) => `<tr>
    <td>${esc(m.name)}</td>
    <td class="num">${num(m.traces)}</td>
    <td class="num">${num(m.output_traces)}</td>
    <td class="num">${num(m.pending)}</td>
  </tr>`).join("");
  setHTML(root, "spClusterModels", html);
}

function renderModels(root, models) {
  if (!models || !models.length) {
    setHTML(root, "spModels", `<tr><td colspan="8" class="empty">等待数据…</td></tr>`);
    return;
  }
  const html = models.map((m) => {
    const remSess = Math.max(0, (m.input_sessions || 0) - (m.attr_sessions || 0));
    const remTr = Math.max(0, (m.input_traces || 0) - (m.attr_traces || 0));
    const ratio = m.input_sessions ? m.attr_sessions / m.input_sessions : 0;
    return `<tr>
      <td><button type="button" class="sp-model-btn" data-sp-model="${esc(m.name)}">${esc(m.name)}</button></td>
      <td class="num">${num(m.input_sessions)}</td>
      <td class="num">${num(m.input_traces)}</td>
      <td class="num">${num(m.attr_sessions)}</td>
      <td class="num">${num(m.attr_traces)}</td>
      <td class="num">${num(remSess)}</td>
      <td class="num">${num(remTr)}</td>
      ${progressBarCell(ratio)}
    </tr>`;
  }).join("");
  setHTML(root, "spModels", html);
}

function fillSelect(select, entries, value) {
  const sig = entries.map(([k]) => k).join("\u0000");
  if (select.dataset.signature !== sig) {
    select.replaceChildren(...entries.map(([k, label]) => {
      const opt = document.createElement("option");
      opt.value = k;
      opt.textContent = label;
      return opt;
    }));
    select.dataset.signature = sig;
  }
  select.value = entries.some(([k]) => k === value) ? value : entries[0][0];
  return select.value;
}

function renderDates(root, model) {
  const dates = (model?.dates || []).slice().sort((a, b) => b.date.localeCompare(a.date));
  const ySel = $("#spDateYear", root);
  const mSel = $("#spDateMonth", root);
  if (!dates.length) {
    fillSelect(ySel, [["all", "全部年份"]], "all");
    fillSelect(mSel, [["all", "全部月份"]], "all");
    setText(root, "spDatePageInfo", "共 0 天");
    $("#spDatePrev", root).disabled = true;
    $("#spDateNext", root).disabled = true;
    setHTML(root, "spDates", `<tr><td colspan="8" class="empty">暂无日期数据</td></tr>`);
    return;
  }
  const years = [...new Set(dates.map((d) => d.date.slice(0, 4)))].sort().reverse();
  S.dateFilter.year = fillSelect(ySel, [["all", "全部年份"], ...years.map((y) => [y, `${y} 年`])], S.dateFilter.year);
  const byYear = S.dateFilter.year === "all" ? dates : dates.filter((d) => d.date.startsWith(`${S.dateFilter.year}-`));
  const months = [...new Set(byYear.map((d) => d.date.slice(5, 7)))].sort();
  S.dateFilter.month = fillSelect(mSel, [["all", "全部月份"], ...months.map((m) => [m, `${Number(m)} 月`])], S.dateFilter.month);

  const filtered = dates.filter((d) =>
    (S.dateFilter.year === "all" || d.date.startsWith(`${S.dateFilter.year}-`)) &&
    (S.dateFilter.month === "all" || d.date.slice(5, 7) === S.dateFilter.month));
  const pages = Math.max(1, Math.ceil(filtered.length / DATE_PAGE_SIZE));
  S.dateFilter.page = Math.min(Math.max(1, S.dateFilter.page), pages);
  const start = (S.dateFilter.page - 1) * DATE_PAGE_SIZE;
  const pageRows = filtered.slice(start, start + DATE_PAGE_SIZE);
  setText(root, "spDatePageInfo", filtered.length ? `共 ${filtered.length} 天 · 第 ${S.dateFilter.page}/${pages} 页` : "当前筛选无日期");
  $("#spDatePrev", root).disabled = S.dateFilter.page <= 1;
  $("#spDateNext", root).disabled = S.dateFilter.page >= pages;

  if (!pageRows.length) {
    setHTML(root, "spDates", `<tr><td colspan="8" class="empty">当前筛选暂无日期</td></tr>`);
    return;
  }
  const html = pageRows.map((d) => {
    const remSess = Math.max(0, (d.input_sessions || 0) - (d.attr_sessions || 0));
    const remTr = Math.max(0, (d.input_traces || 0) - (d.attr_traces || 0));
    const ratio = d.input_sessions ? d.attr_sessions / d.input_sessions : 0;
    return `<tr>
      <td class="num">${esc(d.date)}</td>
      <td class="num">${num(d.input_sessions)}</td>
      <td class="num">${num(d.input_traces)}</td>
      <td class="num">${num(d.attr_sessions)}</td>
      <td class="num">${num(d.attr_traces)}</td>
      <td class="num">${num(remSess)}</td>
      <td class="num">${num(remTr)}</td>
      ${progressBarCell(ratio)}
    </tr>`;
  }).join("");
  setHTML(root, "spDates", html);
}

function axisLabel(back, plotSpan) {
  if (back <= 1) return "现在";
  if (plotSpan <= 3600) return `-${Math.round(back / 60)}m`;
  const h = back / 3600;
  if (h < 10 && Math.abs(h - Math.round(h)) >= 0.08) return `-${h.toFixed(1)}h`;
  return `-${Math.round(h)}h`;
}

function niceAxisMax(rawMax, ticks = 4) {
  const target = Math.max(1, rawMax * 1.12);
  const perTick = target / ticks;
  const steps = [
    0.5, 1, 2, 2.5, 5, 8, 10, 12, 15, 20, 25, 30, 40, 50, 60, 75,
    100, 125, 150, 200, 250, 300, 400, 500, 750, 1000,
  ];
  for (const s of steps) {
    if (s >= perTick) return s * ticks;
  }
  const exp = 10 ** Math.floor(Math.log10(perTick));
  for (const m of [1, 2, 2.5, 5, 10]) {
    if (m * exp >= perTick) return m * exp * ticks;
  }
  return Math.ceil(perTick) * ticks;
}

function lookupPartsRate(rpmHist, colIdx, t) {
  if (!rpmHist.length) return 0;
  if (t <= rpmHist[0][0]) return Number(rpmHist[0][colIdx]) || 0;
  const last = rpmHist[rpmHist.length - 1];
  if (t >= last[0]) return Number(last[colIdx]) || 0;
  let lo = 0, hi = rpmHist.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (rpmHist[mid][0] <= t) lo = mid; else hi = mid;
  }
  const p0 = rpmHist[lo], p1 = rpmHist[hi];
  const f = p1[0] === p0[0] ? 0 : (t - p0[0]) / (p1[0] - p0[0]);
  return (Number(p0[colIdx]) || 0) + ((Number(p1[colIdx]) || 0) - (Number(p0[colIdx]) || 0)) * f;
}

function blendPartsTail(history, rpmHist) {
  const eff = history.map((p) => [p[0], Number(p[1]) || 0, Number(p[2]) || 0]);
  if (eff.length < 2 || !rpmHist.length) return eff;
  const lastT = eff[eff.length - 1][0];
  for (const [col, rCol] of [[1, 2], [2, 3]]) {
    const tailVal = eff[eff.length - 1][col];
    let flatStart = eff.length - 1;
    while (flatStart > 0 && eff[flatStart - 1][col] === tailVal && lastT - eff[flatStart - 1][0] <= 600) {
      flatStart -= 1;
    }
    if (flatStart < eff.length - 1) {
      let acc = 0;
      for (let i = flatStart + 1; i < eff.length; i++) {
        const dt = Math.max(0, eff[i][0] - eff[i - 1][0]);
        const perMin = Math.max(0, lookupPartsRate(rpmHist, rCol, eff[i][0]));
        acc += (perMin / 60) * dt;
        eff[i][col] = tailVal + acc;
      }
    }
  }
  return eff;
}

function buildRpmSamples(raw, range) {
  if (!raw.length) return { samples: [], now: Date.now() / 1000, step: 15 };
  const now = raw[raw.length - 1][0];
  const start = now - range;
  const from = Math.max(start, raw[0][0]);
  const step = range <= 600 ? 15 : range <= 3600 ? 30 : range <= 21600 ? 120 : range <= 86400 ? 300 : 600;
  const samples = [];
  if (now - from < 10) {
    const last = raw[raw.length - 1];
    samples.push({ t: last[0], v1: Number(last[1]) || 0, pa: Number(last[2]) || 0, pc: Number(last[3]) || 0 });
    return { samples, now, step };
  }
  const count = Math.max(1, Math.min(240, Math.ceil((now - from) / step)));
  const half = Math.max(step * 0.65, 20);
  const maxGap = Math.max(300, step * 3);
  const interpAt = (t) => {
    if (t <= raw[0][0]) return raw[0];
    const last = raw[raw.length - 1];
    if (t >= last[0]) return last;
    let lo = 0, hi = raw.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (raw[mid][0] <= t) lo = mid; else hi = mid;
    }
    const p0 = raw[lo], p1 = raw[hi];
    if (p1[0] - p0[0] > maxGap) return [t, 0, 0, 0];
    const f = p1[0] === p0[0] ? 0 : (t - p0[0]) / (p1[0] - p0[0]);
    return [
      t,
      (Number(p0[1]) || 0) + ((Number(p1[1]) || 0) - (Number(p0[1]) || 0)) * f,
      (Number(p0[2]) || 0) + ((Number(p1[2]) || 0) - (Number(p0[2]) || 0)) * f,
      (Number(p0[3]) || 0) + ((Number(p1[3]) || 0) - (Number(p0[3]) || 0)) * f,
    ];
  };
  let idx = 0;
  for (let i = 0; i <= count; i++) {
    const t = from + (now - from) * (i / count);
    while (idx < raw.length && raw[idx][0] < t - half) idx++;
    let sv = 0, spa = 0, spc = 0, n = 0;
    for (let k = idx; k < raw.length && raw[k][0] <= t + half; k++) {
      sv += Number(raw[k][1]) || 0;
      spa += Number(raw[k][2]) || 0;
      spc += Number(raw[k][3]) || 0;
      n++;
    }
    if (n > 0) {
      samples.push({ t, v1: sv / n, pa: spa / n, pc: spc / n });
    } else {
      const q = interpAt(t);
      samples.push({ t, v1: q[1], pa: q[2], pc: q[3] });
    }
  }
  const last = raw[raw.length - 1];
  samples[samples.length - 1] = { t: now, v1: Number(last[1]) || 0, pa: Number(last[2]) || 0, pc: Number(last[3]) || 0 };
  return { samples, now, step };
}

function buildLandingSamples(history, rpmHist, range) {
  if (!history.length) return { samples: [], now: Date.now() / 1000, step: 15 };
  const all = range <= 3600 ? blendPartsTail(history, rpmHist) : history;
  const now = all[all.length - 1][0];
  const start = now - range;
  const firstT = all[0][0];
  const step = range <= 600 ? 15 : range <= 3600 ? 30 : range <= 21600 ? 60 : range <= 86400 ? 300 : 600;
  const rateWindow = Math.max(300, step * 6);
  const from = Math.max(start, firstT);
  const count = Math.max(1, Math.min(240, Math.ceil((now - from) / step)));
  const at = (t) => {
    if (t <= firstT) return [firstT, all[0][1], all[0][2]];
    const last = all[all.length - 1];
    if (t >= last[0]) return last;
    let lo = 0, hi = all.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (all[mid][0] <= t) lo = mid; else hi = mid;
    }
    const p0 = all[lo], p1 = all[hi];
    const f = p1[0] === p0[0] ? 0 : (t - p0[0]) / (p1[0] - p0[0]);
    return [t, p0[1] + (p1[1] - p0[1]) * f, p0[2] + (p1[2] - p0[2]) * f];
  };
  const samples = [];
  for (let i = 0; i <= count; i++) {
    const t = from + (now - from) * (i / count);
    const cur = at(t);
    const base = at(Math.max(firstT, t - rateWindow));
    const span = t - base[0];
    if (span < 30) continue;
    samples.push({
      t,
      a: Math.round(cur[1]),
      c: Math.round(cur[2]),
      v1: Math.max(0, (cur[1] - base[1]) / span * 60),
      v2: Math.max(0, (cur[2] - base[2]) / span * 60),
    });
  }
  const smooth = (key) => samples.map((_, i) => {
    let sum = 0, n = 0;
    for (let j = Math.max(0, i - 1); j <= Math.min(samples.length - 1, i + 1); j++) {
      sum += samples[j][key];
      n++;
    }
    return sum / n;
  });
  const v1 = smooth("v1"), v2 = smooth("v2");
  samples.forEach((s, i) => { s.v1 = v1[i]; s.v2 = v2[i]; });
  return { samples, now, step };
}

function drawChart(root) {
  const chart = $("#spChart", root);
  const grid = $("#spGrid", root);
  const axis = $("#spAxis", root);
  const line1 = $("#spLine1", root);
  const line2 = $("#spLine2", root);
  const area1 = $("#spArea1", root);
  const area2 = $("#spArea2", root);
  const quotaLine = $("#spQuotaLine", root);
  const hoverLine = $("#spHoverLine", root);
  const pointLayer = $("#spPointLayer", root);
  const legend = $("#spChartLegend", root);
  const empty = $("#spChartEmpty", root);
  if (!chart || !grid || !axis) return;

  grid.replaceChildren();
  axis.replaceChildren();
  pointLayer.replaceChildren();
  const rect = chart.getBoundingClientRect();
  const W = Math.max(320, Math.round(rect.width || 960));
  const H = Math.max(200, Math.round(rect.height || 256));
  chart.setAttribute("viewBox", `0 0 ${W} ${H}`);
  const { L, R, T, B } = CHART_PAD;
  if (hoverLine) {
    hoverLine.setAttribute("y1", T);
    hoverLine.setAttribute("y2", H - B);
  }
  const isRpm = S.chartMode === "rpm";
  const quota = S.data?.gateways?.rpm_limit || null;

  if (legend) {
    legend.innerHTML = isRpm
      ? `<span style="--c:var(--accent)"><i></i>实时请求 (RPM)</span>${quota ? `<span class="is-dashed" style="--c:var(--sev-2)"><i></i>限额 ${num(quota)} RPM</span>` : ""}`
      : `<span style="--c:var(--accent)"><i></i>Attribution</span><span style="--c:var(--loc-vir)"><i></i>Compact</span>`;
  }

  const built = isRpm
    ? buildRpmSamples(S.data?.rpm_history || [], S.range)
    : buildLandingSamples(S.data?.history || [], S.data?.rpm_history || [], S.range);
  const { samples, now, step } = built;

  S.chartSamples = samples;
  empty.hidden = samples.length > 0;
  chart.style.display = samples.length > 0 ? "block" : "none";
  if (!samples.length) {
    line1.setAttribute("d", "");
    line2.setAttribute("d", "");
    area1.setAttribute("d", "");
    if (area2) area2.setAttribute("d", "");
    quotaLine.setAttribute("visibility", "hidden");
    return;
  }

  const start = now - S.range;
  const firstSampleT = samples[0].t;
  const plotStart = S.range - (now - firstSampleT) > step * 2 ? firstSampleT : start;
  const plotSpan = Math.max(60, now - plotStart);
  S.chartPlotStart = plotStart;
  S.chartPlotSpan = plotSpan;

  let rawMax = isRpm && quota ? quota : 0;
  for (const s of samples) rawMax = Math.max(rawMax, s.v1 || 0, s.v2 || 0);
  const max = niceAxisMax(rawMax, 4);
  const x = (t) => L + ((t - plotStart) / plotSpan) * (W - L - R);
  const y = (v) => T + (1 - v / max) * (H - T - B);

  for (let i = 0; i <= 4; i++) {
    const yy = T + ((H - T - B) * i) / 4;
    const g = document.createElementNS(SVG_NS, "line");
    g.setAttribute("x1", L); g.setAttribute("x2", W - R);
    g.setAttribute("y1", yy); g.setAttribute("y2", yy);
    grid.appendChild(g);
    const val = (max * (4 - i)) / 4;
    const text = document.createElementNS(SVG_NS, "text");
    text.setAttribute("x", L - 8); text.setAttribute("y", yy + 4);
    text.setAttribute("text-anchor", "end");
    text.textContent = Number.isInteger(val) ? String(val) : val.toFixed(1);
    axis.appendChild(text);
  }
  for (let i = 0; i <= 5; i++) {
    const back = plotSpan * (1 - i / 5);
    const xx = x(now - back);
    const vg = document.createElementNS(SVG_NS, "line");
    vg.setAttribute("class", "sp-grid-v");
    vg.setAttribute("x1", xx); vg.setAttribute("x2", xx);
    vg.setAttribute("y1", T); vg.setAttribute("y2", H - B);
    grid.appendChild(vg);
    const text = document.createElementNS(SVG_NS, "text");
    text.setAttribute("x", xx);
    text.setAttribute("y", H - 10);
    text.setAttribute("text-anchor", "middle");
    text.textContent = axisLabel(back, plotSpan);
    axis.appendChild(text);
  }

  if (isRpm && quota) {
    const qy = y(quota);
    quotaLine.setAttribute("x1", L); quotaLine.setAttribute("x2", W - R);
    quotaLine.setAttribute("y1", qy); quotaLine.setAttribute("y2", qy);
    quotaLine.setAttribute("visibility", "visible");
  } else {
    quotaLine.setAttribute("visibility", "hidden");
  }

  const linePath = (key) => samples.map((s, i) => `${i ? "L" : "M"}${x(s.t).toFixed(1)},${y(s[key]).toFixed(1)}`).join("");
  const p1 = linePath("v1");
  line1.setAttribute("class", `sp-line ${isRpm ? "sp-line-rpm" : "sp-line-attr"}`);
  line1.setAttribute("d", p1);
  if (samples.length > 1) {
    const baseY = y(0).toFixed(1);
    const xEnd = x(samples[samples.length - 1].t).toFixed(1);
    const xBegin = x(samples[0].t).toFixed(1);
    area1.setAttribute("class", `sp-area ${isRpm ? "sp-area-rpm" : "sp-area-attr"}`);
    area1.setAttribute("d", `${p1}L${xEnd},${baseY}L${xBegin},${baseY}Z`);
    if (area2) {
      if (isRpm) {
        area2.setAttribute("d", "");
      } else {
        const p2 = linePath("v2");
        area2.setAttribute("class", "sp-area sp-area-comp");
        area2.setAttribute("d", `${p2}L${xEnd},${baseY}L${xBegin},${baseY}Z`);
      }
    }
  } else {
    area1.setAttribute("d", "");
    if (area2) area2.setAttribute("d", "");
  }
  line2.setAttribute("class", "sp-line sp-line-comp");
  line2.setAttribute("d", isRpm ? "" : linePath("v2"));

  const last = samples[samples.length - 1];
  const dots = isRpm ? [[last.v1, "sp-point-rpm"]] : [[last.v1, "sp-point-attr"], [last.v2, "sp-point-comp"]];
  for (const [val, cls] of dots) {
    const dot = document.createElementNS(SVG_NS, "circle");
    dot.setAttribute("cx", x(last.t).toFixed(1));
    dot.setAttribute("cy", y(val).toFixed(1));
    dot.setAttribute("r", "4");
    dot.setAttribute("class", `sp-point ${cls}`);
    pointLayer.appendChild(dot);
  }
}

function handleChartMove(event, root) {
  if (!S.chartSamples.length) return;
  const chart = $("#spChart", root);
  if (!chart) return;
  const cr = chart.getBoundingClientRect();
  const W = Math.max(320, Math.round(cr.width || 960));
  const { L, R } = CHART_PAD;
  const px = event.clientX - cr.left;
  const plot = W - L - R;
  if (px < L || px > W - R) {
    handleChartLeave(root);
    return;
  }
  const plotStart = S.chartPlotStart;
  const plotSpan = S.chartPlotSpan || S.range;
  const target = plotStart + ((px - L) / plot) * plotSpan;
  let best = S.chartSamples[0];
  for (const s of S.chartSamples) {
    if (Math.abs(s.t - target) < Math.abs(best.t - target)) best = s;
  }
  const x = L + ((best.t - plotStart) / plotSpan) * plot;
  const line = $("#spHoverLine", root);
  if (line) {
    line.setAttribute("x1", x); line.setAttribute("x2", x);
    line.setAttribute("visibility", "visible");
  }
  const d = new Date(best.t * 1000).toLocaleTimeString("zh-CN", { hour12: false });
  const quota = S.data?.gateways?.rpm_limit;
  const html = S.chartMode === "rpm"
    ? `<div class="t-head">${esc(d)}</div>
       <div class="t-row"><span>实时请求</span><b class="num">${rate(best.v1)} RPM</b></div>
       ${quota ? `<div class="t-row"><span>配额占比</span><b class="num">${pct(best.v1, quota, 1)}</b></div>` : ""}
       <div class="t-row"><span>在途 Attr / Compact</span><b class="num">${rate(best.pa)} / ${rate(best.pc)} 条/分</b></div>`
    : `<div class="t-head">${esc(d)}</div>
       <div class="t-row"><span>Attribution</span><b class="num">${rate(best.v1)} 条/分</b></div>
       <div class="t-row"><span>Compact</span><b class="num">${rate(best.v2)} 条/分</b></div>
       <div class="t-row"><span>累计</span><b class="num">${num(best.a)} / ${num(best.c)}</b></div>`;
  showTip(html, event.clientX, event.clientY);
}

function handleChartLeave(root) {
  const line = $("#spHoverLine", root);
  if (line) line.setAttribute("visibility", "hidden");
  hideTip();
}

function applyData(root, data) {
  S.data = data;
  if (!data || data.available === false) {
    const sites = sitesMap();
    const aimeUrl = sites.aime?.url ? `${sites.aime.url.replace(/\/+$/, "")}/?view=speed&product=aime` : "";
    root.innerHTML = `<div class="bento"><article class="card" style="--span:12"><div class="sp-unavail">
      <h2>评测速度监控</h2>
      <p>${esc(data?.error || "当前节点未挂载 AIME 评测流水线目录。")}</p>
      ${aimeUrl ? `<a class="sp-unavail-btn" href="${esc(aimeUrl)}">打开弗吉尼亚 AIME 评测速度</a>` : ""}
    </div></article></div>`;
    S.rangeSeg = null;
    S.modeSeg = null;
    return;
  }

  if (!$("#spProgress", root)) {
    root.innerHTML = shellHTML();
    wireControls(root);
  }

  const ready = data.total != null;
  const traces = data.input_traces || 0;
  const attrTraces = data.attr_traces || 0;
  setText(root, "spInputSessions", ready ? num(data.input_sessions) : "—");
  setText(root, "spInputTraces", ready ? num(data.input_traces) : "—");
  setText(root, "spAttrSessions", num(data.attr_sessions));
  setText(root, "spAttrTraces", num(data.attr_traces));
  setText(root, "spRemainingSessions", ready ? num(data.remaining_sessions) : "—");
  setText(root, "spRemainingTraces", ready ? num(data.remaining_traces) : "—");
  setText(root, "spPercent", data.progress == null ? "—" : `${(data.progress * 100).toFixed(1)}%`);
  setText(root, "spTracePercent", traces ? pct(attrTraces, traces, 1) : "—");
  const p = Math.max(0, Math.min(100, (data.progress || 0) * 100));
  const prog = $("#spProgress", root);
  if (prog) prog.style.width = `${p}%`;
  const bar = $("#spBar", root);
  if (bar) bar.setAttribute("aria-valuenow", String(Math.round(p)));
  setText(root, "spInputUpdated", data.input_updated_at ? `输入统计于 ${clock(data.input_updated_at)}` : "");

  const r = data.rates || {};
  const attrRate = r.attr == null || (Number(r.attr) === 0 && Number(r.parts_attr) > 0) ? r.parts_attr : r.attr;
  const compactRate = r.compact == null || (Number(r.compact) === 0 && Number(r.parts_compact) > 0) ? r.parts_compact : r.compact;
  setText(root, "spAttrRate", rate(attrRate));
  setText(root, "spCompactRate", rate(compactRate));
  setText(root, "spPartsAttrSub", `在途实时 (.parts) ${rate(r.parts_attr)} 条/分钟`);
  setText(root, "spPartsCompactSub", `在途实时 (.parts) ${rate(r.parts_compact)} 条/分钟`);
  setText(root, "spEta", etaLabel(data.eta_minutes));
  setText(root, "spEtaSub", `待评测 ${compact(data.remaining_traces)} 条 Trace · ${compact(data.remaining_sessions)} 个 Session`);

  renderQueue(root, data.queue);
  renderGateways(root, data.gateways);
  renderCluster(root, data.cluster);
  renderModels(root, data.models);
  if (S.selectedModel) {
    const model = (data.models || []).find((m) => m.name === S.selectedModel);
    if (model) renderDates(root, model);
    else closeDates(root);
  }
  drawChart(root);

  const conn = $("#spConn", root);
  if (conn) {
    conn.className = `sp-conn ${data.ok ? "is-ok" : "is-bad"}`;
    setText(root, "spConnText", data.ok ? "实时 · 15s" : "连接异常");
  }
  setText(root, "spUpdated", data.ok
    ? `更新 ${clock(data.updated_at)}`
    : (data.last_success ? `最后成功 ${clock(data.last_success)}` : "等待首次统计…"));
}

function openDates(root, modelName) {
  const model = (S.data?.models || []).find((m) => m.name === modelName);
  if (!model) return;
  S.selectedModel = modelName;
  S.dateFilter = { year: "all", month: "all", page: 1 };
  $("#spModelList", root).hidden = true;
  $("#spDateView", root).hidden = false;
  renderDates(root, model);
}

function closeDates(root) {
  S.selectedModel = null;
  const dv = $("#spDateView", root);
  const ml = $("#spModelList", root);
  if (dv) dv.hidden = true;
  if (ml) ml.hidden = false;
}

function wireControls(root) {
  const modeEl = $("#spChartMode", root);
  const rangeEl = $("#spRange", root);
  if (modeEl) {
    S.modeSeg = segmented(modeEl, (v) => {
      S.chartMode = v;
      drawChart(root);
      handleChartLeave(root);
    });
    S.modeSeg.set(S.chartMode, { silent: true });
  }
  if (rangeEl) {
    S.rangeSeg = segmented(rangeEl, (v) => {
      S.range = Number(v);
      drawChart(root);
      handleChartLeave(root);
    });
    S.rangeSeg.set(String(S.range), { silent: true });
  }
  const chart = $("#spChart", root);
  if (chart) {
    chart.addEventListener("pointermove", (e) => handleChartMove(e, root));
    chart.addEventListener("pointerleave", () => handleChartLeave(root));
    if (typeof ResizeObserver === "function") {
      let resizeRaf = 0;
      new ResizeObserver(() => {
        if (resizeRaf) return;
        resizeRaf = requestAnimationFrame(() => {
          resizeRaf = 0;
          if (S.data) drawChart(root);
        });
      }).observe(chart);
    }
  }
  if (!root._spClickWired) {
    root._spClickWired = true;
    root.addEventListener("click", (e) => {
      const modelBtn = e.target.closest("[data-sp-model]");
      if (modelBtn) {
        openDates(root, modelBtn.dataset.spModel);
        return;
      }
      if (e.target.closest("#spBack")) {
        closeDates(root);
        return;
      }
      if (e.target.closest("#spDatePrev")) {
        S.dateFilter.page = Math.max(1, S.dateFilter.page - 1);
        const model = (S.data?.models || []).find((m) => m.name === S.selectedModel);
        if (model) renderDates(root, model);
        return;
      }
      if (e.target.closest("#spDateNext")) {
        S.dateFilter.page += 1;
        const model = (S.data?.models || []).find((m) => m.name === S.selectedModel);
        if (model) renderDates(root, model);
      }
    });
  }
  $("#spDateYear", root)?.addEventListener("change", (e) => {
    S.dateFilter.year = e.target.value;
    S.dateFilter.month = "all";
    S.dateFilter.page = 1;
    const model = (S.data?.models || []).find((m) => m.name === S.selectedModel);
    if (model) renderDates(root, model);
  });
  $("#spDateMonth", root)?.addEventListener("change", (e) => {
    S.dateFilter.month = e.target.value;
    S.dateFilter.page = 1;
    const model = (S.data?.models || []).find((m) => m.name === S.selectedModel);
    if (model) renderDates(root, model);
  });
}

async function fetchQuietJSON(url, timeoutMs = 3000) {
  const ac = typeof AbortController === "function" ? new AbortController() : null;
  const timer = ac ? setTimeout(() => ac.abort(), timeoutMs) : 0;
  try {
    const res = await fetch(url, { cache: "no-store", signal: ac ? ac.signal : undefined });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function fetchSpeed() {
  if (S.inflight || document.hidden || document.documentElement.dataset.view !== "speed") return;
  S.inflight = true;
  try {
    let data = S.sourceUrl === "speed.json"
      ? await getJSON(S.sourceUrl, { retries: 1 })
      : await fetchQuietJSON(S.sourceUrl);
    if (data && data.available === false && S.sourceUrl === "speed.json") {
      const aimeUrl = sitesMap().aime?.url;
      if (aimeUrl) {
        const remoteUrl = `${aimeUrl.replace(/\/+$/, "")}/speed.json`;
        const remoteData = await fetchQuietJSON(remoteUrl);
        if (remoteData && remoteData.available !== false) {
          S.sourceUrl = remoteUrl;
          data = remoteData;
        }
      }
    }
    if (S.root && data) applyData(S.root, data);
  } catch (err) {
    if (S.root) {
      const conn = $("#spConn", S.root);
      if (conn) {
        conn.className = "sp-conn is-bad";
        setText(S.root, "spConnText", S.data ? "暂未连上" : "读取失败，自动重试中");
      }
    }
  } finally {
    S.inflight = false;
  }
}

export async function render(root, c) {
  S.root = root;
  S.ctx = c;
  if (!root.firstChild || !$("#spProgress", root)) {
    root.innerHTML = shellHTML();
    wireControls(root);
  }
  await fetchSpeed();
  if (!S.timer) {
    S.timer = setInterval(fetchSpeed, POLL_MS);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && document.documentElement.dataset.view === "speed") fetchSpeed();
    });
  }
}
