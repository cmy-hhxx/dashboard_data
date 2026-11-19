/* 评测速度: live AIME throughput, miniature pipeline visualization, running state & gateway telemetry. */
import { $, $$, esc, fmt, compact, pct, segmented, showTip, hideTip, getJSON, REDUCED } from "./core.js";

const POLL_MS = 15000;
const DATE_PAGE_SIZE = 12;
const SVG_NS = "http://www.w3.org/2000/svg";
const CHART_PAD = { L: 48, R: 24, T: 18, B: 32 };
const MINI_STEPS = ["var(--t0)", "var(--t2)", "var(--accent)", "var(--sev-1)", "var(--loc-vir)", "var(--t1)", "var(--loc-ulq)"];

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
  evalRunning: false,
  fx: null,
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

/* Derive overall pipeline run state (`进行中` / `中断中` / `已完成` / `采集中断`) from live telemetry. */
export function deriveEvalStatus(data) {
  if (!data || data.ok === false) {
    return { key: "error", label: "采集中断", cls: "is-bad", running: false, detail: "" };
  }
  const ctrl = data.gateways?.control || {};
  const rates = data.rates || {};
  const queue = data.queue || {};
  const locks = queue.locks || [];
  const cluster = data.cluster || {};
  const inputTraces = Number(data.input_traces) || 0;
  const remainingTraces = Number(data.remaining_traces) || 0;
  const clusterPending = Number(cluster.pending) || 0;
  const activeWriters = Number(rates.active_writers) || 0;
  const runningJobs = Number(queue.running) || 0;
  const rpm = Number(rates.realtime_rpm) || 0;
  const partsRate = (Number(rates.parts_attr) || 0) + (Number(rates.parts_compact) || 0);
  const attrRate = Number(rates.attr) || 0;
  const compactRate = Number(rates.compact) || 0;
  const partAge = rates.newest_part_age_s;
  const freshPart = partAge != null && Number(partAge) <= 180;
  const freshLock = locks.some((l) => l.heartbeat_age_s == null || Number(l.heartbeat_age_s) <= 180);
  const gwFresh = (data.gateways?.items || []).some((g) => g.ok && g.active_ago_s != null && Number(g.active_ago_s) <= 90);

  if (ctrl.paused) {
    return { key: "paused", label: "中断中", cls: "is-bad", running: false, detail: "调度暂停" };
  }
  const hasActivity = activeWriters > 0 || runningJobs > 0 || freshLock || partsRate > 0 || rpm > 0.5
    || freshPart || gwFresh || (attrRate > 0 && partAge == null) || (compactRate > 0 && partAge == null);
  if (hasActivity) {
    const workers = data.gateways?.active_replicas || activeWriters || runningJobs;
    return { key: "running", label: "进行中", cls: "is-ok is-live", running: true, detail: workers ? `${workers} 实例` : "" };
  }
  if (inputTraces > 0 && remainingTraces <= 0 && clusterPending <= 0) {
    return { key: "done", label: "已完成", cls: "is-ok", running: false, detail: "" };
  }
  return { key: "stalled", label: "中断中", cls: "is-warn", running: false, detail: "" };
}

const FX_IN = [["user", "用户提问"], ["think", "模型思考"], ["call", "工具调用"], ["answer", "最终回答"]];
const FX_OUT = [["问题", "var(--sev-1)"], ["定级", "var(--sev-0)"], ["证据", "var(--accent)"], ["归属", "var(--t1)"]];

function hubHTML() {
  const ticks = Array.from({ length: 60 }, (_, k) => {
    const c = k % 9 === 0 ? MINI_STEPS[(k / 9) % MINI_STEPS.length] : "";
    const a = (k * Math.PI) / 30;
    const r0 = c ? 63 : 67;
    const [x0, y0, x1, y1] = [Math.cos(a) * r0, Math.sin(a) * r0, Math.cos(a) * 74, Math.sin(a) * 74].map((v) => v.toFixed(1));
    return `<line x1="${x0}" y1="${y0}" x2="${x1}" y2="${y1}"${c ? ` class="c" style="--c:${c}"` : ""}/>`;
  }).join("");
  const tiles = [2, 9, 0, 9, 2, 9, 9, 4, 9].map((v) => `<i style="--c:${v < 5 ? `var(--sev-${v})` : "var(--sev-none)"}"></i>`).join("");
  return `<div class="fx-hub sp-hub"><span class="fx-orbit"><i></i></span><svg class="fx-ring" viewBox="-80 -80 160 160" aria-hidden="true">${ticks}</svg><span class="fx-core"><span>${tiles}</span></span></div>`;
}

/* 聚类池：液面高度 = 已聚类 / 已评测，水平双层波浪持续流动。 */
function poolHTML() {
  const wave = (y) => `M0 ${y}Q15 ${y - 5} 30 ${y}T60 ${y}T90 ${y}T120 ${y}T150 ${y}T180 ${y}T210 ${y}T240 ${y}V140H0Z`;
  return `<div class="sp-pool" id="spPool">
    <svg viewBox="0 0 120 120" preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <clipPath id="spPoolClip"><rect x="0" y="0" width="120" height="120" rx="20"/></clipPath>
        <linearGradient id="spPoolSheen" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stop-color="#ffffff" stop-opacity="0.36"/>
          <stop offset="60%" stop-color="#ffffff" stop-opacity="0.04"/>
          <stop offset="100%" stop-color="#ffffff" stop-opacity="0"/>
        </linearGradient>
      </defs>
      <g clip-path="url(#spPoolClip)">
        <rect class="sp-pool-bg" x="0" y="0" width="120" height="120"/>
        <g class="sp-pool-level" id="spPoolLevel" transform="translate(0 120)">
          <path class="sp-pool-back" d="${wave(6)}"/>
          <path class="sp-pool-front" d="${wave(9)}"/>
          <path class="sp-pool-sheen" d="${wave(9)}" fill="url(#spPoolSheen)"/>
        </g>
      </g>
      <rect class="sp-pool-ring" x="0.5" y="0.5" width="119" height="119" rx="19.5" fill="none"/>
    </svg>
    <b class="sp-pool-pct num" id="spPoolPct">—</b>
  </div>`;
}

export function shellHTML() {
  const ins = FX_IN.map(([k, t], i) => `<div class="fx-box fx-in k-${k}" data-i="${i}"><i class="fx-dot"></i><b>${t}</b></div>`).join("");
  const outs = FX_OUT.map(([t, c], i) => {
    const ico = i === 1
      ? `<span class="fx-ico is-sev">${[0, 1, 2, 3, 4].map((k) => `<i style="--c:var(--sev-${k});--k:${k}"></i>`).join("")}</span>`
      : `<span class="fx-ico"><i></i></span>`;
    return `<div class="fx-box fx-out" data-o="${i}" style="--c:${c}">${ico}<b>${t}</b></div>`;
  }).join("");
  return `<div class="bento sp-bento">
    <article class="card sp-ov-card" style="--span:12">
      <header class="card-head">
        <h2>评测总览</h2>
        <div class="sp-head-pills">
          <span class="sp-conn" id="spEvalState"><i></i><span id="spEvalStateText">读取中</span></span>
          <span class="sp-conn is-quiet" id="spConn"><i></i><span id="spConnText">实时</span></span>
        </div>
      </header>
      <div class="sp-ov">
        <div class="sp-ov-stat" style="--c:var(--t2)">
          <span class="sp-ov-lbl"><i></i>评测输入</span>
          <div class="sp-ov-val"><span class="big num" id="spInputTraces">—</span><span class="unit">trace</span></div>
          <span class="sp-ov-sub"><b class="num" id="spInputSessions">—</b> session</span>
        </div>
        <div class="sp-ov-stat" style="--c:var(--accent)">
          <span class="sp-ov-lbl"><i></i>已完成评测</span>
          <div class="sp-ov-val"><span class="big num" id="spAttrTraces">—</span><span class="unit">trace</span></div>
          <span class="sp-ov-sub" id="spAttrPct">—</span>
        </div>
        <div class="sp-ov-stat" style="--c:var(--loc-ulq)">
          <span class="sp-ov-lbl"><i></i>已聚类</span>
          <div class="sp-ov-val"><span class="big num" id="spClusterTraces">—</span><span class="unit">trace</span></div>
          <span class="sp-ov-sub" id="spClusterPct">—</span>
        </div>
      </div>
      <div class="sp-funnel" id="spFunnel" role="img" aria-label="评测与聚类覆盖">
        <i class="sp-funnel-attr" id="spFunnelAttr"></i>
        <i class="sp-funnel-cl" id="spFunnelCl"></i>
      </div>
      <div class="sp-funnel-keys">
        <span style="--c:var(--loc-ulq)"><i></i>已聚类</span>
        <span style="--c:var(--accent)"><i></i>已评测待聚类 <b class="num" id="spKeyClPending">—</b></span>
        <span style="--c:var(--well-2)"><i></i>待评测 <b class="num" id="spKeyRemain">—</b></span>
      </div>
    </article>

    <article class="card" style="--span:12">
      <header class="card-head"><h2>评测流水线</h2></header>
      <div class="sp-fx" id="spFx">
        <svg class="sp-fx-wires" id="spFxWires" aria-hidden="true"></svg>
        <canvas class="sp-fx-sparks" id="spFxSparks" aria-hidden="true"></canvas>
        <section class="sp-fx-col">
          <div class="fx-label"><span class="num">01</span>原始对话</div>
          <div class="sp-fx-stack">${ins}</div>
          <div class="sp-fx-foot"><b class="num" id="spFxIn">—</b>输入</div>
        </section>
        <section class="sp-fx-col">
          <div class="fx-label"><span class="num">02</span>轨迹压缩</div>
          ${hubHTML()}
          <div class="sp-fx-foot"><b class="num" id="spFxCompact">—</b>已压缩</div>
        </section>
        <section class="sp-fx-col">
          <div class="fx-label"><span class="num">03</span>问题归因</div>
          <div class="sp-fx-stack">${outs}</div>
          <div class="sp-fx-foot"><b class="num" id="spFxAttr">—</b>已归因</div>
        </section>
        <section class="sp-fx-col">
          <div class="fx-label"><span class="num">04</span>层级聚类</div>
          ${poolHTML()}
          <div class="sp-fx-foot"><b class="num" id="spFxCluster">—</b>已聚类</div>
        </section>
      </div>
    </article>

    <article class="card sp-rate-card is-rate-attr" style="--span:4">
      <header class="card-head"><h2>归因速率</h2></header>
      <div class="sp-rate"><span class="big num" id="spAttrRate">—</span><span class="unit">trace/分钟</span></div>
      <p class="sp-rate-sub" id="spPartsAttrSub">在途 —</p>
    </article>

    <article class="card sp-rate-card is-rate-comp" style="--span:4">
      <header class="card-head"><h2>压缩速率</h2></header>
      <div class="sp-rate"><span class="big num" id="spCompactRate">—</span><span class="unit">trace/分钟</span></div>
      <p class="sp-rate-sub" id="spPartsCompactSub">在途 —</p>
    </article>

    <article class="card sp-rate-card" style="--span:4">
      <header class="card-head"><h2>预计完成</h2></header>
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
        <span class="sp-conn is-quiet end" id="spGwSummary">—</span>
      </header>
      <div class="sp-gw-kpis">
        <div class="sp-gw-kpi">
          <span class="sp-gw-kpi-label">实时请求</span>
          <div class="sp-gw-kpi-val"><b class="mid num" id="spGwRpm">—</b><span class="unit">RPM</span></div>
          <div class="sp-gw-meter" id="spGwMeter"><i id="spGwMeterFill" style="width:0%"></i></div>
          <span class="sp-gw-kpi-sub" id="spGwRpmSub">配额 —</span>
        </div>
        <div class="sp-gw-kpi">
          <span class="sp-gw-kpi-label">在途吞吐</span>
          <div class="sp-gw-kpi-val"><b class="mid num" id="spGwPartsAttr">—</b><span class="sp-slash">/</span><b class="mid num" id="spGwPartsComp">—</b><span class="unit">条/分</span></div>
          <span class="sp-gw-kpi-sub" id="spGwPartsSub">写入流 —</span>
        </div>
        <div class="sp-gw-kpi">
          <span class="sp-gw-kpi-label">并发预算</span>
          <div class="sp-gw-kpi-val"><b class="mid num" id="spGwPermits">—</b><span class="unit">许可</span></div>
          <span class="sp-gw-kpi-sub" id="spGwControlSub">任务并发 —</span>
        </div>
        <div class="sp-gw-kpi">
          <span class="sp-gw-kpi-label">网关延迟</span>
          <div class="sp-gw-kpi-val"><b class="mid num" id="spGwLatency">—</b><span class="unit">ms</span></div>
          <span class="sp-gw-kpi-sub" id="spGwProbeSub">—</span>
        </div>
      </div>
      <div class="md-table sp-table">
        <table>
          <thead>
            <tr>
              <th>网关 / 渠道</th><th>状态</th><th>模型</th>
              <th class="num">实时 RPM / 配额</th><th class="num">并发许可</th>
              <th class="num">实例 / 写入流</th><th class="num">探活延迟</th><th class="num">最近活跃</th>
            </tr>
          </thead>
          <tbody id="spGateways"><tr><td colspan="8" class="empty">读取中…</td></tr></tbody>
        </table>
      </div>
    </article>

    <article class="card" style="--span:12">
      <header class="card-head"><h2>日期分布</h2></header>
      <div id="spModelList" class="md-table sp-table">
        <table>
          <thead>
            <tr><th>目录</th><th class="num">输入 Session</th><th class="num">输入 Trace</th><th class="num">已评测 Trace</th><th class="num">已聚类 Trace</th><th class="num">待评测 Trace</th><th>进度</th></tr>
          </thead>
          <tbody id="spModels"><tr><td colspan="7" class="empty">读取中…</td></tr></tbody>
        </table>
      </div>
      <div id="spDateView" hidden>
        <div class="sp-date-head">
          <button type="button" class="sp-back" id="spBack">← 全部目录</button>
          <b class="sp-date-title" id="spDateTitle"></b>
          <div class="sp-filters">
            <select class="sp-select" id="spDateYear" aria-label="年份"></select>
            <select class="sp-select" id="spDateMonth" aria-label="月份"></select>
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
              <tr><th>日期</th><th class="num">输入 Session</th><th class="num">输入 Trace</th><th class="num">已评测 Trace</th><th class="num">待评测 Trace</th><th>进度</th></tr>
            </thead>
            <tbody id="spDates"></tbody>
          </table>
        </div>
      </div>
    </article>
  </div>`;
}

/* 进度条：外层为已评测占比，内层叠加已聚类占比（聚类 ⊆ 评测）。 */
function stackCell(attrRatio, clRatio = null) {
  const a = Math.max(0, Math.min(1, Number(attrRatio) || 0));
  const c = clRatio == null ? null : Math.max(0, Math.min(a, Number(clRatio) || 0));
  return `<td class="sp-prog-cell"><span class="sp-mini-bar"><i style="width:${(a * 100).toFixed(1)}%"></i>${c == null ? "" : `<i class="is-cl" style="width:${(c * 100).toFixed(1)}%"></i>`}</span><span class="num">${(a * 100).toFixed(1)}%</span></td>`;
}

export function modelRowsHTML(data) {
  const models = data?.models || [];
  if (!models.length) return `<tr><td colspan="7" class="empty">等待数据…</td></tr>`;
  const cl = new Map((data?.cluster?.models || []).map((c) => [c.name, Number(c.traces) || 0]));
  return models.map((m) => {
    const inTr = Number(m.input_traces) || 0;
    const attrTr = Number(m.attr_traces) || 0;
    const clTr = cl.get(m.name) || 0;
    return `<tr>
      <td><button type="button" class="sp-model-btn" data-sp-model="${esc(m.name)}">${esc(m.name)}</button></td>
      <td class="num">${num(m.input_sessions)}</td>
      <td class="num">${num(inTr)}</td>
      <td class="num">${num(attrTr)}</td>
      <td class="num">${cl.has(m.name) ? num(clTr) : "—"}</td>
      <td class="num">${num(Math.max(0, inTr - attrTr))}</td>
      ${stackCell(inTr ? attrTr / inTr : 0, inTr && cl.has(m.name) ? clTr / inTr : null)}
    </tr>`;
  }).join("");
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

  setText(root, "spGwRpm", liveRpm == null ? "—" : rate(liveRpm));
  setText(root, "spGwRpmSub", limit
    ? `配额 ${num(limit)} · ${liveRpm == null ? "—" : pct(liveRpm, limit, 1)}`
    : "配额 —");
  const meter = $("#spGwMeter", root);
  const meterFill = $("#spGwMeterFill", root);
  if (meter && meterFill) {
    meterFill.style.width = `${(util * 100).toFixed(1)}%`;
    meter.classList.toggle("is-hot", util >= 0.85);
  }

  setText(root, "spGwPartsAttr", rate(g.parts_attr_rate));
  setText(root, "spGwPartsComp", rate(g.parts_compact_rate));
  const writers = g.active_writers ?? 0;
  const ageStr = g.newest_part_age_s != null ? ` · ${agoLabel(g.newest_part_age_s)}` : "";
  setText(root, "spGwPartsSub", `${num(writers)} 写入流${ageStr}`);

  setText(root, "spGwPermits", ctrl.model_requests != null ? num(ctrl.model_requests) : "—");
  setText(root, "spGwControlSub", ctrl.concurrency != null
    ? `任务并发 ${num(ctrl.concurrency)}${ctrl.compact_backlog ? ` · 积压 ${num(ctrl.compact_backlog)}` : ""}`
    : "等待调度数据");

  const lead = items[0];
  setText(root, "spGwLatency", lead?.latency_ms != null ? fmt(lead.latency_ms, 1) : "—");
  const repLabel = g.active_replicas != null ? `${num(g.active_replicas)} 实例` : "0 实例";
  setText(root, "spGwProbeSub", lead
    ? `HTTP ${lead.code || "—"} · ${repLabel} · ${agoLabel(lead.active_ago_s)}`
    : repLabel);

  if (!items.length) {
    setHTML(root, "spGateways", `<tr><td colspan="8" class="empty">未配置网关</td></tr>`);
    return;
  }
  const rowsHTML = items.map((item) => {
    const cls = item.cooldown ? "is-warn" : item.ok ? "is-ok" : "";
    const statusText = item.cooldown ? "冷却中" : item.healthy ? "健康" : item.ok ? `HTTP ${item.code}` : "离线";
    const modelsText = (item.models || []).length ? item.models.join(", ") : "—";
    const urlTitle = String(item.url || "").replace(/\/v1\/?$/, "");
    const rpmCell = item.rpm != null
      ? `${rate(item.rpm)}${item.rpm_limit ? `<span class="faint"> / ${num(item.rpm_limit)}</span>` : ""}`
      : (item.rpm_limit ? `—<span class="faint"> / ${num(item.rpm_limit)}</span>` : "—");
    const permitCell = item.permits != null
      ? `${num(item.permits)}${item.concurrency != null ? `<span class="faint"> / ${num(item.concurrency)}</span>` : ""}`
      : "—";
    const streamCell = `${item.active_replicas != null ? `${num(item.active_replicas)} 实例` : "—"} · ${num(item.active_writers)} 流`;
    const latCell = item.latency_ms != null ? `${fmt(item.latency_ms, 1)} ms` : "—";
    return `<tr>
      <td><span class="sp-gw-name" title="${esc(urlTitle)}">${esc(item.name)}</span></td>
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
    setHTML(root, "spDates", `<tr><td colspan="6" class="empty">暂无日期数据</td></tr>`);
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
  setText(root, "spDateTitle", model.name);
  setText(root, "spDatePageInfo", filtered.length ? `${filtered.length} 天 · ${S.dateFilter.page}/${pages}` : "当前筛选无日期");
  $("#spDatePrev", root).disabled = S.dateFilter.page <= 1;
  $("#spDateNext", root).disabled = S.dateFilter.page >= pages;

  if (!pageRows.length) {
    setHTML(root, "spDates", `<tr><td colspan="6" class="empty">当前筛选暂无日期</td></tr>`);
    return;
  }
  const html = pageRows.map((d) => {
    const inTr = Number(d.input_traces) || 0;
    const attrTr = Number(d.attr_traces) || 0;
    return `<tr>
      <td class="num">${esc(d.date)}</td>
      <td class="num">${num(d.input_sessions)}</td>
      <td class="num">${num(inTr)}</td>
      <td class="num">${num(attrTr)}</td>
      <td class="num">${num(Math.max(0, inTr - attrTr))}</td>
      ${stackCell(inTr ? attrTr / inTr : 0)}
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

/* Miniature animated flow diagram mirroring 评测体系 (`fx-diagram` wires + comet sparks + spinning hub). */
/* 评测流水线缩略图（照搬评测体系 fx-diagram 的视觉，横向排布）。
   粒子由真实进度指挥：每次轮询把「压缩 / 归因 / 聚类」的新增量拆成若干粒子，
   在下一次轮询前陆续送达；粒子到站时对应计数才往上走，液面才上涨。
   评测进行中时，另按在途速率放出不计数的流动粒子；中断时整张图静止变淡。 */
function wireFlow(root) {
  S.fx?.destroy();
  S.fx = null;
  const diagram = $("#spFx", root);
  const svg = $("#spFxWires", root);
  const canvas = $("#spFxSparks", root);
  if (!diagram || !svg || !canvas) return;
  const ctx = typeof canvas.getContext === "function" ? canvas.getContext("2d") : null;
  const hub = $(".sp-hub", diagram);
  const ring = $(".fx-ring", diagram);
  const tiles = $$(".fx-core i", diagram);
  const ins = $$(".fx-in", diagram);
  const outs = $$(".fx-out", diagram);
  const pool = $("#spPool", diagram);
  const paths = new Map();
  const geo = { dpr: 1, w: 0, h: 0 };
  const shown = { compact: null, attr: null, cluster: null };
  const target = { compact: null, attr: null, cluster: null };
  const sparks = [];
  let running = false;
  let ambientEvery = 0;
  let lastAmbient = 0;
  let raf = 0;
  let rot = 0;
  let step = 0;
  let lastHub = 0;
  let colors = null;

  const paint = () => {
    for (const k of ["compact", "attr", "cluster"]) {
      const id = k === "compact" ? "spFxCompact" : k === "attr" ? "spFxAttr" : "spFxCluster";
      setText(root, id, shown[k] == null ? "—" : num(Math.round(shown[k])));
    }
    const ratio = shown.attr > 0 && shown.cluster != null ? Math.max(0, Math.min(1, shown.cluster / shown.attr)) : 0;
    const level = $("#spPoolLevel", diagram);
    if (level) level.setAttribute("transform", `translate(0 ${(120 * (1 - ratio) - 4).toFixed(1)})`);
    setText(root, "spPoolPct", shown.attr > 0 ? `${(ratio * 100).toFixed(1)}%` : "—");
  };

  const redraw = () => {
    const h = diagram.getBoundingClientRect();
    if (!h.width) return;
    const rel = (el) => {
      const r = el.getBoundingClientRect();
      return { l: r.left - h.left, r: r.right - h.left, cy: r.top + r.height / 2 - h.top };
    };
    const curve = (a, b, id, cls) => {
      const xm = (a[0] + b[0]) / 2;
      return `<path id="${id}" class="fx-w ${cls}" d="M${a[0].toFixed(1)} ${a[1].toFixed(1)}C${xm.toFixed(1)} ${a[1].toFixed(1)} ${xm.toFixed(1)} ${b[1].toFixed(1)} ${b[0].toFixed(1)} ${b[1].toFixed(1)}"/>`;
    };
    let d = "";
    if (hub) {
      const hr = rel(hub);
      ins.forEach((b, i) => { const r = rel(b); d += curve([r.r, r.cy], [hr.l + 14, hr.cy], `spw-i${i}`, "in"); });
      outs.forEach((b, j) => { const r = rel(b); d += curve([hr.r - 14, hr.cy], [r.l, r.cy], `spw-o${j}`, "out"); });
    }
    if (pool) {
      const pr = rel(pool);
      outs.forEach((b, j) => { const r = rel(b); d += curve([r.r, r.cy], [pr.l, pr.cy], `spw-c${j}`, "funnel"); });
    }
    svg.setAttribute("viewBox", `0 0 ${h.width} ${h.height}`);
    svg.innerHTML = d;
    paths.clear();
    $$("path[id]", svg).forEach((p) => paths.set(p.id, p));
    geo.dpr = Math.min(2, window.devicePixelRatio || 1);
    geo.w = h.width;
    geo.h = h.height;
    canvas.width = Math.round(h.width * geo.dpr);
    canvas.height = Math.round(h.height * geo.dpr);
  };

  const flash = (el, cls = "is-on", ms = 420) => {
    if (!el) return;
    el.classList.remove(cls);
    void el.offsetWidth;
    el.classList.add(cls);
    setTimeout(() => el.classList.remove(cls), ms);
  };
  const hubHit = (now) => {
    if (now - lastHub < 220) return;
    lastHub = now;
    rot += 40;
    if (ring) ring.style.transform = `rotate(${rot}deg)`;
    flash(hub, "is-hit", 460);
    step = (step + 1) % MINI_STEPS.length;
    const lit = new Set([4, step % 9, (step * 4 + 1) % 9]);
    tiles.forEach((t, k) => t.style.setProperty("--c", lit.has(k) ? MINI_STEPS[step] : "var(--sev-none)"));
  };
  const along = (id, u) => {
    const p = paths.get(id);
    if (!p || typeof p.getTotalLength !== "function") return null;
    try { return p.getPointAtLength(p.getTotalLength() * u); } catch { return null; }
  };
  const readColors = () => {
    const cs = getComputedStyle(document.documentElement);
    const v = (n, f) => cs.getPropertyValue(n).trim() || f;
    colors = {
      in: v("--accent", "#3552d8"),
      outs: [v("--sev-1", "#bf3822"), v("--sev-0", "#a01e26"), v("--accent", "#3552d8"), v("--t1", "#596273")],
      pool: v("--loc-ulq", "#1d7d72"),
    };
  };
  /* kind: compact 止于压缩核心；attr 止于归因；cluster 止于聚类池；flow 为在途流动，不计数。 */
  const spawn = (kind, share, at) => {
    sparks.push({
      kind, share, t0: at, phase: 0, launched: false,
      i: Math.floor(Math.random() * Math.max(1, ins.length)),
      j: Math.floor(Math.random() * Math.max(1, outs.length)),
      trail: [],
    });
  };
  const arrive = (s) => {
    if (s.share > 0 && shown[s.kind] != null) {
      shown[s.kind] = Math.min(target[s.kind], shown[s.kind] + s.share);
      paint();
    }
  };
  const DUR = [760, 640, 700];

  const frame = (now) => {
    raf = 0;
    const visible = !document.hidden && document.documentElement.dataset.view === "speed";
    if (!visible) return;
    if (!colors) readColors();
    if (running && ambientEvery && now - lastAmbient > ambientEvery) {
      lastAmbient = now;
      spawn("flow", 0, now);
    }
    ctx.setTransform(geo.dpr, 0, 0, geo.dpr, 0, 0);
    ctx.clearRect(0, 0, geo.w, geo.h);
    for (let n = sparks.length - 1; n >= 0; n--) {
      const s = sparks[n];
      if (now < s.t0) continue;
      if (!s.launched) {
        s.launched = true;
        flash(ins[s.i]);
      }
      const u = Math.min(1, (now - s.t0) / DUR[s.phase]);
      const id = s.phase === 0 ? `spw-i${s.i}` : s.phase === 1 ? `spw-o${s.j}` : `spw-c${s.j}`;
      const pt = along(id, u < 0.5 ? 4 * u * u * u : 1 - (-2 * u + 2) ** 3 / 2);
      if (pt) {
        s.trail.push(pt);
        if (s.trail.length > 12) s.trail.shift();
        const col = s.phase === 0 ? colors.in : s.phase === 1 ? colors.outs[s.j] || colors.in : colors.pool;
        ctx.lineCap = "round";
        for (let k = 1; k < s.trail.length; k++) {
          const t = k / s.trail.length;
          ctx.strokeStyle = col;
          ctx.globalAlpha = t * (s.kind === "flow" ? 0.32 : 0.6);
          ctx.lineWidth = (s.kind === "flow" ? 2 : 2.8) * t;
          ctx.beginPath();
          ctx.moveTo(s.trail[k - 1].x, s.trail[k - 1].y);
          ctx.lineTo(s.trail[k].x, s.trail[k].y);
          ctx.stroke();
        }
        ctx.fillStyle = col;
        ctx.globalAlpha = s.kind === "flow" ? 0.55 : 0.95;
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, s.kind === "flow" ? 2.2 : 3, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      }
      if (u < 1) continue;
      s.trail.length = 0;
      if (s.phase === 0) {
        hubHit(now);
        if (s.kind === "compact") { arrive(s); sparks.splice(n, 1); continue; }
      } else if (s.phase === 1) {
        flash(outs[s.j]);
        if (s.kind === "attr" || s.kind === "flow") { arrive(s); sparks.splice(n, 1); continue; }
      } else {
        flash(pool, "is-hit", 520);
        arrive(s);
        sparks.splice(n, 1);
        continue;
      }
      s.phase += 1;
      s.t0 = now;
    }
    if (sparks.length || running) raf = requestAnimationFrame(frame);
  };
  const kick = () => {
    if (!raf && ctx && !REDUCED && typeof requestAnimationFrame === "function") raf = requestAnimationFrame(frame);
  };

  redraw();
  const ro = typeof ResizeObserver === "function" ? new ResizeObserver(redraw) : null;
  ro?.observe(diagram);

  S.fx = {
    redraw,
    /* next: {compact, attr, cluster} 的最新真实值；status: deriveEvalStatus 的结果；inflight: 在途条/分。 */
    feed(next, status, inflight) {
      running = !!status?.running;
      diagram.classList.toggle("is-idle", !running);
      ambientEvery = running ? Math.max(450, Math.min(3200, 60000 / Math.max(1, inflight || 0))) : 0;
      const animate = !!ctx && !REDUCED && !document.hidden;
      for (const k of ["compact", "attr", "cluster"]) {
        const v = Number(next[k]);
        if (!Number.isFinite(v)) continue;
        const prevTarget = target[k];
        target[k] = v;
        // 上一轮没送完的增量直接落账，避免累积。
        shown[k] = prevTarget == null ? v : prevTarget;
        const delta = prevTarget == null ? 0 : v - prevTarget;
        if (delta <= 0 || !animate) { shown[k] = v; continue; }
        const count = Math.max(1, Math.min(14, Math.round(Math.sqrt(delta) * 1.6)));
        const base = performance.now();
        const span = POLL_MS * 0.82;
        let left = delta;
        for (let c = 0; c < count; c++) {
          const share = c === count - 1 ? left : Math.round(delta / count);
          left -= share;
          spawn(k, share, base + (span * (c + Math.random() * 0.8)) / count);
        }
      }
      sparks.forEach((s) => { if (s.share > 0 && s.t0 < performance.now() - POLL_MS) s.share = 0; });
      paint();
      kick();
    },
    destroy() {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      ro?.disconnect();
    },
  };
}

export function applyData(root, data) {
  S.data = data;
  if (!data || data.available === false) {
    S.fx?.destroy();
    S.fx = null;
    const sites = sitesMap();
    const aimeUrl = sites.aime?.url ? `${sites.aime.url.replace(/\/+$/, "")}/?view=speed&product=aime` : "";
    root.innerHTML = `<div class="bento"><article class="card" style="--span:12"><div class="sp-unavail">
      <h2>评测总览</h2>
      <p>${esc(data?.error || "当前节点未挂载 AIME 评测流水线目录。")}</p>
      ${aimeUrl ? `<a class="sp-unavail-btn" href="${esc(aimeUrl)}">打开弗吉尼亚 AIME 评测速度</a>` : ""}
    </div></article></div>`;
    S.rangeSeg = null;
    S.modeSeg = null;
    return;
  }

  if (!$("#spFx", root)) {
    root.innerHTML = shellHTML();
    wireControls(root);
    wireFlow(root);
  }

  const ready = data.total != null;
  const inTr = Number(data.input_traces) || 0;
  const attrTr = Number(data.attr_traces) || 0;
  const compTr = Number(data.compact) || 0;
  const remTr = Number(data.remaining_traces) || 0;
  const remSess = Number(data.remaining_sessions) || 0;
  const cl = data.cluster || {};
  const clTr = Number(cl.traces) || 0;
  const clPending = Number(cl.pending) || 0;
  const attrRatio = inTr > 0 ? Math.min(1, attrTr / inTr) : 0;
  const clRatio = inTr > 0 ? Math.min(attrRatio, clTr / inTr) : 0;

  setText(root, "spInputTraces", ready ? num(inTr) : "—");
  setText(root, "spInputSessions", ready ? num(data.input_sessions) : "—");
  setText(root, "spAttrTraces", num(attrTr));
  setText(root, "spAttrPct", inTr ? `占输入 ${(attrRatio * 100).toFixed(1)}%` : "—");
  setText(root, "spClusterTraces", num(clTr));
  setText(root, "spClusterPct", attrTr ? `占已评测 ${pct(clTr, attrTr, 1)}` : "—");
  const fa = $("#spFunnelAttr", root);
  const fc = $("#spFunnelCl", root);
  if (fa) fa.style.width = `${(attrRatio * 100).toFixed(2)}%`;
  if (fc) fc.style.width = `${(clRatio * 100).toFixed(2)}%`;
  setText(root, "spKeyClPending", num(clPending));
  setText(root, "spKeyRemain", ready ? num(remTr) : "—");
  setText(root, "spFxIn", ready ? num(inTr) : "—");

  const r = data.rates || {};
  const attrRate = r.attr == null || (Number(r.attr) === 0 && Number(r.parts_attr) > 0) ? r.parts_attr : r.attr;
  const compactRate = r.compact == null || (Number(r.compact) === 0 && Number(r.parts_compact) > 0) ? r.parts_compact : r.compact;
  setText(root, "spAttrRate", rate(attrRate));
  setText(root, "spCompactRate", rate(compactRate));
  setText(root, "spPartsAttrSub", `在途 ${rate(r.parts_attr)} 条/分钟`);
  setText(root, "spPartsCompactSub", `在途 ${rate(r.parts_compact)} 条/分钟`);
  setText(root, "spEta", etaLabel(data.eta_minutes));
  setText(root, "spEtaSub", `剩余 ${compact(remTr)} trace · ${compact(remSess)} session`);

  const ev = deriveEvalStatus(data);
  const evalEl = $("#spEvalState", root);
  if (evalEl) evalEl.className = `sp-conn ${ev.cls}`;
  setText(root, "spEvalStateText", ev.detail ? `${ev.label} · ${ev.detail}` : ev.label);
  const conn = $("#spConn", root);
  if (conn) {
    conn.className = `sp-conn is-quiet ${data.ok ? "is-ok" : "is-bad"}`;
    setText(root, "spConnText", data.ok ? `更新 ${clock(data.updated_at)}` : "连接异常");
  }

  S.fx?.feed({ compact: compTr, attr: attrTr, cluster: clTr }, ev, (Number(r.parts_attr) || 0) + (Number(r.parts_compact) || 0) || Number(attrRate) || 0);

  renderGateways(root, data.gateways);
  setHTML(root, "spModels", modelRowsHTML(data));
  if (S.selectedModel) {
    const model = (data.models || []).find((m) => m.name === S.selectedModel);
    if (model) renderDates(root, model);
    else closeDates(root);
  }
  drawChart(root);
}


function openDates(root, modelName) {
  const model = (S.data?.models || []).find((m) => m.name === modelName);
  if (!model) return;
  S.selectedModel = modelName;
  S.dateFilter = { year: "all", month: "all", page: 1 };
  $("#spModelList", root).hidden = true;
  $("#spDateView", root).hidden = false;
  renderDates(root, model);
  S.fx?.redraw();
}

function closeDates(root) {
  S.selectedModel = null;
  const dv = $("#spDateView", root);
  const ml = $("#spModelList", root);
  if (dv) dv.hidden = true;
  if (ml) ml.hidden = false;
  S.fx?.redraw();
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

async function fetchSpeed() {
  if (S.inflight || document.hidden || document.documentElement.dataset.view !== "speed") return;
  S.inflight = true;
  try {
    // 评测速度只有 AIME（弗吉尼亚）接入：其它节点不转发、不借用别人的数据，直接显示暂无。
    const data = await getJSON(S.sourceUrl, { retries: 1 });
    if (data && data.available === false) {
      S.unavailable = true;
      if (S.root) showEmpty(S.root);
      return;
    }
    S.unavailable = false;
    if (S.root && data) applyData(S.root, data);
  } catch (err) {
    if (S.root) {
      const conn = $("#spConn", S.root);
      if (conn) {
        conn.className = "sp-conn is-quiet is-bad";
        setText(S.root, "spConnText", S.data ? "暂未连上" : "读取失败，自动重试中");
      }
    }
  } finally {
    S.inflight = false;
  }
}

function showEmpty(root) {
  S.fx?.destroy();
  S.fx = null;
  if (!$("#spEmpty", root)) {
    root.innerHTML = `<div class="bento sp-bento"><article class="card" style="--span:12">
      <header class="card-head"><h2>评测与聚类进程</h2></header>
      <div class="sp-empty" id="spEmpty">暂无</div>
    </article></div>`;
  }
}

export async function render(root, c) {
  S.root = root;
  S.ctx = c;
  if (!root.firstChild || (!$("#spFx", root) && !$("#spEmpty", root))) {
    root.innerHTML = shellHTML();
    wireControls(root);
    wireFlow(root);
  }
  await fetchSpeed();
  if (!S.timer) {
    S.timer = setInterval(fetchSpeed, POLL_MS);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && document.documentElement.dataset.view === "speed") fetchSpeed();
      else if (S.fx) S.fx.sync(!document.hidden && S.evalRunning);
    });
  }
}
