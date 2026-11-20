/* 评测速度: live AIME throughput, overview concentric rings, native horizontal pipeline & gateway telemetry. */
import { $, esc, fmt, pct, segmented, showTip, hideTip, bindTips, getJSON } from "./core.js";
import { fxDiagramHTML, mountFxDiagram } from "./system.js";

const POLL_MS = 30000;
const DATE_PAGE_SIZE = 12;
const SVG_NS = "http://www.w3.org/2000/svg";
const CHART_PAD = { L: 48, R: 24, T: 18, B: 32 };
const RING_OUT_C = 2 * Math.PI * 64;
const RING_IN_C = 2 * Math.PI * 49;
const HORIZ_TREE_W = 940;
const HORIZ_TREE_H = 540;

const S = {
  data: null,
  timer: 0,
  heartbeatTimer: 0,
  lastPollAt: 0,
  lastSyncDelta: 0,
  inflight: false,
  liveRunning: false,
  selectedModel: null,
  range: 300,
  chartMode: "landing",
  dateFilter: { year: "all", month: "all", page: 1 },
  chartSamples: [],
  chartPlotStart: 0,
  chartPlotSpan: 300,
  rangeSeg: null,
  modeSeg: null,
  taxKey: "",
  fx: null,
  prevInputTraces: null,
  prevInputSessions: null,
  prevAttrTraces: null,
  prevClusterTraces: null,
  prevPendingTraces: null,
  prevAttrRate: null,
  prevCompactRate: null,
  prevGwRpm: null,
  prevModels: new Map(),
  simAttrCarry: 0,
  simClusterCarry: 0,
  shownAttrTraces: 0,
  shownClusterTraces: 0,
  shownPendingTraces: 0,
  simMaxCarry: 0,
  chartRO: null,
  sourceUrl: "speed.json",
  root: null,
  ctx: null,
};

const isBrowser = () => typeof window !== "undefined" && typeof window.requestAnimationFrame === "function";

/* 在数字上方/右侧弹出「+ xxx」增长弹幕，保持目标元素 textContent 纯净不污染测试与读屏 */
export function spawnDanmu(root, targetOrId, text, { tone = "attr", micro = false } = {}) {
  const el = typeof targetOrId === "string" ? $(`#${targetOrId}`, root) : targetOrId;
  if (!el || !text) return null;
  if (el.dataset) el.dataset.lastDanmu = String(text);
  el.classList?.remove("is-bumped");
  el.classList?.add("is-bumped");
  if (typeof document === "undefined" || typeof document.createElement !== "function" || !el.parentElement) {
    return null;
  }
  const host = el.parentElement;
  host.classList?.add("sp-danmu-host");
  const existing = host.querySelectorAll ? host.querySelectorAll(".sp-danmu") : [];
  if (existing.length >= 2) existing[0].remove();
  const badge = document.createElement("span");
  badge.className = `sp-danmu is-${tone} ${micro ? "is-micro" : "is-burst"}`;
  badge.setAttribute("aria-hidden", "true");
  badge.textContent = String(text);
  host.appendChild(badge);
  setTimeout(() => {
    badge.remove();
    el.classList?.remove("is-bumped");
  }, micro ? 1600 : 2250);
  return badge;
}

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
  const hasThroughput = activeWriters > 0 || partsRate >= 0.05 || attrRate >= 0.05 || compactRate >= 0.05 || rpm > 0.5;
  if (hasThroughput) {
    const workers = data.gateways?.active_replicas || activeWriters || runningJobs;
    return { key: "running", label: "进行中", cls: "is-ok is-live", running: true, detail: workers ? `${workers} 实例` : "" };
  }
  if (inputTraces > 0 && remainingTraces <= 0 && clusterPending <= 0) {
    return { key: "done", label: "已完成", cls: "is-ok", running: false, detail: "" };
  }
  return { key: "stalled", label: "中断中", cls: "is-warn", running: false, detail: runningJobs > 0 || freshLock || gwFresh ? "速率为 0" : "" };
}

function ctxTax(c) {
  const tax = c?.data?.taxonomy || null;
  const products = c?.data?.products || {};
  const pd = (c?.product && products[c.product]) || Object.values(products)[0] || null;
  return { tax, pd };
}

export function shellHTML(tax = null, pd = null) {
  const cOut = RING_OUT_C.toFixed(2);
  const cIn = RING_IN_C.toFixed(2);
  return `<div class="bento sp-bento">
    <article class="card sp-ov-card" style="--span:12">
      <header class="card-head">
        <h2>评测总览</h2>
        <div class="sp-head-pills">
          <span class="sp-conn" id="spEvalState"><i></i><span id="spEvalStateText">读取中</span></span>
          <button type="button" class="sp-conn is-quiet is-refresh" id="spConn" title="点击立即刷新实时数据"><svg class="sp-conn-ico" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M13.2 8a5.2 5.2 0 1 1-1.4-3.55M13.2 2.8v2.6h-2.6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg><span id="spConnText">30s 实时</span></button>
        </div>
      </header>
      <div class="sp-ov-wrap">
        <div class="sp-ov-ring" role="img" aria-label="外环已评测、内环已聚类占评测输入比例">
          <svg viewBox="0 0 156 156" aria-hidden="true">
            <g transform="rotate(-90 78 78)">
              <circle class="sp-ring-track" cx="78" cy="78" r="64"/>
              <circle class="sp-ring-arc is-attr" id="spRingAttr" cx="78" cy="78" r="64" stroke-dasharray="${cOut}" stroke-dashoffset="${cOut}"/>
              <circle class="sp-ring-track" cx="78" cy="78" r="49"/>
              <circle class="sp-ring-arc is-cl" id="spRingCl" cx="78" cy="78" r="49" stroke-dasharray="${cIn}" stroke-dashoffset="${cIn}"/>
            </g>
          </svg>
          <div class="sp-ring-center">
            <b class="num" id="spRingPct">—</b>
            <span>已评测</span>
            <em class="sp-ring-cl num" id="spRingClPct">聚类 —</em>
          </div>
        </div>
        <div class="sp-ov">
          <div class="sp-ov-stat" style="--c:var(--t2)">
            <span class="sp-ov-lbl">评测输入</span>
            <div class="sp-ov-val"><span class="big num" id="spInputTraces">—</span><span class="unit">trace</span></div>
            <span class="sp-ov-sub"><b class="num" id="spInputSessions">—</b> session</span>
          </div>
          <div class="sp-ov-stat" style="--c:var(--accent)">
            <span class="sp-ov-lbl">已完成评测<i class="sp-ring-tag is-attr">外环</i></span>
            <div class="sp-ov-val"><span class="big num" id="spAttrTraces">—</span><span class="unit">trace</span></div>
            <span class="sp-ov-sub" id="spAttrPct">—</span>
          </div>
          <div class="sp-ov-stat" style="--c:var(--loc-ulq)">
            <span class="sp-ov-lbl">已聚类<i class="sp-ring-tag is-cl">内环</i></span>
            <div class="sp-ov-val"><span class="big num" id="spClusterTraces">—</span><span class="unit">trace</span></div>
            <span class="sp-ov-sub" id="spClusterPct">—</span>
          </div>
        </div>
      </div>
    </article>

    <article class="card fx-card" style="--span:12">
      <header class="card-head"><h2>评测流水线</h2></header>
      <div id="spFxHost">${fxDiagramHTML(tax, pd, { horizontal: true, showMatrix: false, showControls: false, showLabels: false, showPool: true, idPrefix: "spfx", treeW: HORIZ_TREE_W, treeH: HORIZ_TREE_H })}</div>
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
        <div class="sp-chart-empty" id="spChartEmpty" hidden>正在采集实时数据，约 30 秒后绘出趋势…</div>
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
      <header class="card-head">
        <h2>日期分布</h2>
        <div class="sp-ring-legend" id="spDateLegend">
          <span><i class="is-attr"></i>外环 已评测</span>
          <span><i class="is-cl"></i>内环 已聚类</span>
        </div>
      </header>
      <div id="spModelList">
        <div class="sp-ring-grid" id="spModels"><div class="empty">读取中…</div></div>
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
        <div class="sp-ring-grid is-dates" id="spDates"></div>
      </div>
    </article>
  </div>`;
}

const MINI_OUT_C = 2 * Math.PI * 34;
const MINI_IN_C = 2 * Math.PI * 26.5;

/* 双层同心小圆环：用于目录与日期分布卡片，与顶部评测总览保持一致视觉语言。 */
function miniRingHTML(outerRatio, innerRatio, { outerCls = "is-attr", innerCls = "is-cl", centerRatio = outerRatio } = {}) {
  const o = Math.max(0, Math.min(1, Number(outerRatio) || 0));
  const hasIn = innerRatio != null;
  const i = hasIn ? Math.max(0, Math.min(1, Number(innerRatio) || 0)) : 0;
  const c = Math.max(0, Math.min(1, Number(centerRatio) || 0));
  const oOff = (MINI_OUT_C * (1 - o)).toFixed(2);
  const iOff = (MINI_IN_C * (1 - i)).toFixed(2);
  const pctStr = c >= 0.9995 ? "100%" : `${(c * 100).toFixed(c >= 0.1 ? 0 : 1)}%`;
  return `<div class="sp-mring" aria-hidden="true">
    <svg viewBox="0 0 80 80">
      <g transform="rotate(-90 40 40)">
        <circle class="sp-mring-track" cx="40" cy="40" r="34"/>
        <circle class="sp-mring-arc ${outerCls}" cx="40" cy="40" r="34" stroke-dasharray="${MINI_OUT_C.toFixed(2)}" stroke-dashoffset="${oOff}"/>
        ${hasIn ? `<circle class="sp-mring-track" cx="40" cy="40" r="26.5"/><circle class="sp-mring-arc ${innerCls}" cx="40" cy="40" r="26.5" stroke-dasharray="${MINI_IN_C.toFixed(2)}" stroke-dashoffset="${iOff}"/>` : ""}
      </g>
    </svg>
    <b class="num">${pctStr}</b>
  </div>`;
}

export function modelRowsHTML(data, { attrCarry = 0, clCarry = 0 } = {}) {
  const models = data?.models || [];
  if (!models.length) return `<div class="empty">等待数据…</div>`;
  const cl = new Map((data?.cluster?.models || []).map((c) => [c.name, Number(c.traces) || 0]));
  const runningModels = new Set((data?.queue?.locks || []).map((l) => l.model).filter(Boolean));
  const preferredIdx = models.findIndex((m) => runningModels.has(m.name));
  let carryAssigned = false;
  return models.map((m, idx) => {
    const inTr = Number(m.input_traces) || 0;
    const rawAttr = Number(m.attr_traces) || 0;
    const isPreferred = preferredIdx >= 0 ? idx === preferredIdx : (rawAttr < inTr || idx === 0);
    const isActiveModel = !carryAssigned && isPreferred;
    if (isActiveModel && (attrCarry > 0 || clCarry > 0)) carryAssigned = true;
    const attrTr = isActiveModel ? Math.min(inTr || Infinity, rawAttr + attrCarry) : rawAttr;
    const remTr = Math.max(0, inTr - attrTr);
    const hasCl = cl.has(m.name);
    const rawCl = cl.get(m.name) || 0;
    const clTr = isActiveModel && hasCl ? Math.min(attrTr, rawCl + clCarry) : rawCl;
    const aRatio = inTr ? attrTr / inTr : 0;
    const cRatio = inTr && hasCl ? Math.min(aRatio, clTr / inTr) : null;
    const badge = remTr === 0 && inTr > 0
      ? `<span class="sp-rc-tag is-done">已完成</span>`
      : `<span class="sp-rc-tag" data-sp-mrem="${esc(m.name)}">待测 ${num(remTr)}</span>`;
    return `<button type="button" class="sp-ring-card is-model${isPreferred || remTr > 0 ? " is-active-model" : ""}" data-sp-model="${esc(m.name)}">
      ${miniRingHTML(aRatio, cRatio, { outerCls: "is-attr", innerCls: "is-cl", centerRatio: aRatio })}
      <div class="sp-rc-body">
        <div class="sp-rc-head">
          <b class="sp-rc-name">${esc(m.name)}<span class="sp-rc-arrow" aria-hidden="true">›</span></b>
          ${badge}
        </div>
        <div class="sp-rc-stats">
          <span>输入 <b class="num">${num(inTr)}</b> trace · <b class="num">${num(m.input_sessions)}</b> sess</span>
          <span>已测 <b class="num is-attr" data-sp-mattr="${esc(m.name)}">${num(attrTr)}</b>${hasCl ? ` · 已聚类 <b class="num is-cl" data-sp-mcl="${esc(m.name)}">${num(clTr)}</b>` : ""}</span>
        </div>
      </div>
    </button>`;
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
    setHTML(root, "spDates", `<div class="empty">暂无日期数据</div>`);
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
    setHTML(root, "spDates", `<div class="empty">当前筛选暂无日期</div>`);
    return;
  }
  const html = pageRows.map((d) => {
    const inTr = Number(d.input_traces) || 0;
    const attrTr = Number(d.attr_traces) || 0;
    const compTr = d.compact != null ? Number(d.compact) || 0 : null;
    const remTr = Math.max(0, inTr - attrTr);
    const aRatio = inTr ? attrTr / inTr : 0;
    const cRatio = inTr && compTr != null ? Math.min(1, Math.max(aRatio, compTr / inTr)) : null;
    const badge = remTr === 0 && inTr > 0
      ? `<span class="sp-rc-tag is-done">已完成</span>`
      : `<span class="sp-rc-tag">待测 ${num(remTr)}</span>`;
    return `<div class="sp-ring-card is-date">
      ${miniRingHTML(cRatio != null ? cRatio : aRatio, cRatio != null ? aRatio : null, {
        outerCls: cRatio != null ? "is-comp" : "is-attr",
        innerCls: "is-attr",
        centerRatio: aRatio,
      })}
      <div class="sp-rc-body">
        <div class="sp-rc-head">
          <b class="sp-rc-name num">${esc(d.date)}</b>
          ${badge}
        </div>
        <div class="sp-rc-stats">
          <span>输入 <b class="num">${num(inTr)}</b> trace · <b class="num">${num(d.input_sessions)}</b> sess</span>
          <span>已测 <b class="num is-attr">${num(attrTr)}</b>${compTr != null ? ` · 压缩 <b class="num is-comp">${num(compTr)}</b>` : ""}</span>
        </div>
      </div>
    </div>`;
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
    const cx = x(last.t).toFixed(1);
    const cy = y(val).toFixed(1);
    if (S.liveRunning) {
      const halo = document.createElementNS(SVG_NS, "circle");
      halo.setAttribute("cx", cx);
      halo.setAttribute("cy", cy);
      halo.setAttribute("r", "8");
      halo.setAttribute("class", `sp-point-halo ${cls}`);
      pointLayer.appendChild(halo);
    }
    const dot = document.createElementNS(SVG_NS, "circle");
    dot.setAttribute("cx", cx);
    dot.setAttribute("cy", cy);
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
  const dt = new Date(best.t * 1000);
  const timeStr = dt.toLocaleTimeString("zh-CN", { hour12: false });
  const d = S.range > 21600
    ? `${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")} ${timeStr}`
    : timeStr;
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

/* 当流水线批次粒子落地到「待聚类」或「聚类树」时，同步递增顶部总览数字并在仅有的两处总览指标弹出 +n 弹幕 */
function handleLiveTick(root, evt) {
  if (!root || !S.data || !S.liveRunning || !evt) return 0;
  const inTr = Number(S.data.input_traces) || 0;
  const d = Math.max(0, Math.round(Number(evt.delta) || 0));
  if (d <= 0) return 0;
  if (evt.kind === "attr") {
    const cap = S.simMaxCarry > 0 ? S.simMaxCarry : 30;
    const remainSpace = inTr > 0 ? Math.max(0, inTr - S.shownAttrTraces) : d;
    const allowed = Math.max(0, Math.min(d, cap - S.simAttrCarry, remainSpace));
    if (allowed <= 0) return 0;
    S.simAttrCarry += allowed;
    S.shownAttrTraces = Math.min(inTr || Infinity, S.shownAttrTraces + allowed);
    S.shownPendingTraces = Math.max(0, S.shownAttrTraces - S.shownClusterTraces);
    const attrRatio = inTr > 0 ? Math.min(1, S.shownAttrTraces / inTr) : 0;
    const clInRatio = inTr > 0 ? Math.min(attrRatio, S.shownClusterTraces / inTr) : 0;
    const liveRemTr = Math.max(0, inTr - S.shownAttrTraces);
    const remSess = Number(S.data.remaining_sessions) || 0;
    setText(root, "spAttrTraces", num(S.shownAttrTraces));
    setText(root, "spAttrPct", inTr
      ? `占输入 ${(attrRatio * 100).toFixed(1)}% · ${liveRemTr > 0 ? `待评测 ${num(liveRemTr)}` : "已全部评测"}`
      : "—");
    setText(root, "spClusterPct", inTr
      ? `占输入 ${(clInRatio * 100).toFixed(1)}% · ${S.shownPendingTraces > 0 ? `待聚类 ${num(S.shownPendingTraces)}` : "已全部聚类"}`
      : "—");
    setText(root, "spEtaSub", `剩余 ${num(liveRemTr)} trace · ${num(remSess)} session`);
    setRing($("#spRingAttr", root), RING_OUT_C, attrRatio);
    setText(root, "spRingPct", inTr ? `${(attrRatio * 100).toFixed(1)}%` : "—");
    spawnDanmu(root, "spAttrTraces", `+${num(allowed)}`, { tone: "attr" });
    const activeCard = $(".sp-ring-card.is-active-model", root) || $(".sp-ring-card", root);
    const activeAttr = activeCard && $("[data-sp-mattr]", activeCard);
    if (activeAttr) {
      const cur = Number(String(activeAttr.textContent || "").replace(/,/g, "")) || 0;
      activeAttr.textContent = num(cur + allowed);
    }
    const activeRem = activeCard && $("[data-sp-mrem]", activeCard);
    if (activeRem) {
      const curRem = Number(String(activeRem.textContent || "").replace(/[^\d]/g, "")) || 0;
      const nextRem = Math.max(0, curRem - allowed);
      activeRem.textContent = nextRem > 0 ? `待测 ${num(nextRem)}` : "已完成";
    }
    return allowed;
  }
  if (evt.kind === "cluster") {
    const avail = Math.max(0, S.shownAttrTraces - S.shownClusterTraces);
    const allowed = Math.max(0, Math.min(d, avail));
    if (allowed <= 0) return 0;
    S.simClusterCarry += allowed;
    S.shownClusterTraces = Math.min(S.shownAttrTraces, S.shownClusterTraces + allowed);
    S.shownPendingTraces = Math.max(0, S.shownAttrTraces - S.shownClusterTraces);
    const attrRatio = inTr > 0 ? Math.min(1, S.shownAttrTraces / inTr) : 0;
    const clInRatio = inTr > 0 ? Math.min(attrRatio, S.shownClusterTraces / inTr) : 0;
    setText(root, "spClusterTraces", num(S.shownClusterTraces));
    setText(root, "spClusterPct", inTr
      ? `占输入 ${(clInRatio * 100).toFixed(1)}% · ${S.shownPendingTraces > 0 ? `待聚类 ${num(S.shownPendingTraces)}` : "已全部聚类"}`
      : "—");
    setRing($("#spRingCl", root), RING_IN_C, clInRatio);
    setText(root, "spRingClPct", inTr ? `聚类 ${(clInRatio * 100).toFixed(1)}%` : "聚类 —");
    spawnDanmu(root, "spClusterTraces", `+${num(allowed)}`, { tone: "cl" });
    const activeCl = $(".sp-ring-card.is-active-model [data-sp-mcl]", root) || $("[data-sp-mcl]", root);
    if (activeCl) {
      const cur = Number(String(activeCl.textContent || "").replace(/,/g, "")) || 0;
      activeCl.textContent = num(cur + allowed);
    }
    return allowed;
  }
  return 0;
}

function mountPipeline(root, c) {
  S.fx?.destroy();
  S.fx = null;
  const { tax, pd } = ctxTax(c);
  S.taxKey = `${c?.product || ""}|${c?.data?.generated_at || ""}|${tax ? 1 : 0}`;
  S.fx = mountFxDiagram(root, tax, pd, {
    horizontal: true,
    idPrefix: "spfx",
    treeW: HORIZ_TREE_W,
    treeH: HORIZ_TREE_H,
    liveControl: true,
    nav: c?.navigate || null,
    product: c?.product || null,
    onLiveTick: (evt) => handleLiveTick(root, evt),
  });
}

function setRing(el, circ, ratio) {
  if (!el) return;
  const r = Math.max(0, Math.min(1, Number(ratio) || 0));
  el.setAttribute("stroke-dashoffset", (circ * (1 - r)).toFixed(2));
}

export function applyData(root, data) {
  S.data = data;
  if (!data || data.available === false) {
    S.fx?.destroy();
    S.fx = null;
    S.liveRunning = false;
    S.prevInputTraces = null;
    S.prevInputSessions = null;
    S.prevAttrTraces = null;
    S.prevClusterTraces = null;
    S.prevPendingTraces = null;
    S.prevAttrRate = null;
    S.prevCompactRate = null;
    S.prevGwRpm = null;
    S.prevModels.clear();
    S.simAttrCarry = 0;
    S.simClusterCarry = 0;
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

  if (!$("#spRingAttr", root)) {
    const { tax, pd } = ctxTax(S.ctx);
    root.innerHTML = shellHTML(tax, pd);
    wireControls(root);
    mountPipeline(root, S.ctx);
  }

  const ev = deriveEvalStatus(data);
  S.liveRunning = Boolean(ev.running);
  const bCard = $(".sp-bento", root);
  if (bCard && bCard.classList) bCard.classList.toggle("is-eval-running", S.liveRunning);

  const ready = data.total != null;
  const rawInTr = Number(data.input_traces) || 0;
  const rawInSess = Number(data.input_sessions) || 0;
  const rawAttrTr = Number(data.attr_traces) || 0;
  const rawRemTr = Number(data.remaining_traces) || 0;
  const remSess = Number(data.remaining_sessions) || 0;
  const cl = data.cluster || {};
  const hasCluster = cl.traces != null;
  const rawClTr = Number(cl.traces) || 0;
  const rawPendingTr = cl.pending != null ? Math.max(0, Number(cl.pending) || 0) : Math.max(0, rawAttrTr - rawClTr);
  const r = data.rates || {};
  const attrRate = r.attr == null || (Number(r.attr) === 0 && Number(r.parts_attr) > 0) ? r.parts_attr : r.attr;
  const compactRate = r.compact == null || (Number(r.compact) === 0 && Number(r.parts_compact) > 0) ? r.parts_compact : r.compact;
  const liveRate = (Number(r.parts_attr) || 0) + (Number(r.parts_compact) || 0) || (Number(attrRate) || 0) + (Number(compactRate) || 0);

  const hasPrev = S.prevInputTraces != null;
  const maxCarry = ev.running && liveRate >= 0.05
    ? Math.min(rawRemTr, Math.max(12, Math.round((liveRate / 60) * 45)))
    : 0;
  S.simMaxCarry = maxCarry;
  if (isBrowser() && hasPrev && ev.running && liveRate >= 0.05) {
    // 固定 4s/6s 节拍负责实时推进，30s 轮询只与真实落盘对齐，不额外叠波
    S.simAttrCarry = rawAttrTr >= S.shownAttrTraces
      ? 0
      : Math.min(maxCarry, Math.max(0, S.shownAttrTraces - rawAttrTr));
    const nextAttr = Math.min(rawInTr || Infinity, rawAttrTr + S.simAttrCarry);
    S.simClusterCarry = rawClTr >= S.shownClusterTraces
      ? 0
      : Math.min(Math.max(0, nextAttr - rawClTr), Math.max(0, S.shownClusterTraces - rawClTr));
  } else {
    S.simAttrCarry = 0;
    S.simClusterCarry = 0;
  }

  const inTr = rawInTr;
  const inSess = rawInSess;
  const attrTr = Math.min(inTr || Infinity, rawAttrTr + S.simAttrCarry);
  const clTr = Math.min(attrTr, rawClTr + S.simClusterCarry);
  const pendingTr = hasPrev && isBrowser() && ev.running && liveRate >= 0.05
    ? Math.max(0, attrTr - clTr)
    : rawPendingTr;
  const remTr = Math.max(0, rawRemTr - S.simAttrCarry);
  const attrRatio = inTr > 0 ? Math.min(1, attrTr / inTr) : 0;
  const clInRatio = inTr > 0 ? Math.min(attrRatio, clTr / inTr) : 0;

  const prevShownAttr = hasPrev ? S.shownAttrTraces : attrTr;
  const prevShownCluster = hasPrev ? S.shownClusterTraces : clTr;
  const deltaAttr = hasPrev ? Math.max(0, attrTr - prevShownAttr) : 0;
  const deltaCluster = hasPrev ? Math.max(0, clTr - prevShownCluster) : 0;
  const numAttrRate = Number(attrRate) || 0;
  const numCompRate = Number(compactRate) || 0;
  const numGwRpm = Number(data.gateways?.realtime_rpm);

  S.prevInputTraces = inTr;
  S.prevInputSessions = inSess;
  S.prevAttrTraces = attrTr;
  S.prevClusterTraces = clTr;
  S.prevPendingTraces = pendingTr;
  S.prevAttrRate = numAttrRate;
  S.prevCompactRate = numCompRate;
  S.prevGwRpm = Number.isFinite(numGwRpm) ? numGwRpm : null;
  S.shownAttrTraces = attrTr;
  S.shownClusterTraces = clTr;
  S.shownPendingTraces = pendingTr;
  S.lastPollAt = Date.now();
  S.lastSyncDelta = deltaAttr + deltaCluster;

  setText(root, "spInputTraces", ready ? num(inTr) : "—");
  setText(root, "spInputSessions", ready ? num(inSess) : "—");
  setText(root, "spAttrTraces", num(attrTr));
  setText(root, "spAttrPct", inTr
    ? `占输入 ${(attrRatio * 100).toFixed(1)}% · ${remTr > 0 ? `待评测 ${num(remTr)}` : "已全部评测"}`
    : "—");
  setText(root, "spClusterTraces", num(clTr));
  setText(root, "spClusterPct", inTr
    ? `占输入 ${(clInRatio * 100).toFixed(1)}% · ${pendingTr > 0 ? `待聚类 ${num(pendingTr)}` : "已全部聚类"}`
    : "—");
  setRing($("#spRingAttr", root), RING_OUT_C, attrRatio);
  setRing($("#spRingCl", root), RING_IN_C, clInRatio);
  setText(root, "spRingPct", inTr ? `${(attrRatio * 100).toFixed(1)}%` : "—");
  setText(root, "spRingClPct", inTr ? `聚类 ${(clInRatio * 100).toFixed(1)}%` : "聚类 —");

  setText(root, "spAttrRate", rate(attrRate));
  setText(root, "spCompactRate", rate(compactRate));
  setText(root, "spPartsAttrSub", `在途 ${rate(r.parts_attr)} 条/分钟`);
  setText(root, "spPartsCompactSub", `在途 ${rate(r.parts_compact)} 条/分钟`);
  setText(root, "spEta", etaLabel(data.eta_minutes));
  setText(root, "spEtaSub", `剩余 ${num(remTr)} trace · ${num(remSess)} session`);

  const evalEl = $("#spEvalState", root);
  if (evalEl) evalEl.className = `sp-conn ${ev.cls}`;
  setText(root, "spEvalStateText", ev.detail ? `${ev.label} · ${ev.detail}` : ev.label);
  const conn = $("#spConn", root);
  if (conn) {
    conn.className = `sp-conn is-quiet is-refresh ${data.ok ? "is-ok" : "is-bad"}${deltaAttr + deltaCluster > 0 ? " is-synced" : ""}`;
    setText(root, "spConnText", data.ok ? `30s 刷新 · ${clock(data.updated_at)}` : "连接异常 · 点击重试");
  }

  S.fx?.setLiveProgress({
    ratio: hasCluster ? clInRatio : attrRatio,
    pending: pendingTr,
    attrTraces: attrTr,
    clusterTraces: clTr,
    running: ev.running && liveRate >= 0.05,
    rate: liveRate,
    deltaAttr,
    deltaCluster,
    windowMs: POLL_MS * 0.92,
    done: ev.key === "done",
  });

  renderGateways(root, data.gateways);
  setHTML(root, "spModels", modelRowsHTML(data, { attrCarry: S.simAttrCarry, clCarry: S.simClusterCarry }));

  // 克制弹幕：仅在核心两处总览数字（已完成评测、已聚类）+ 流水线待聚类池出现真实增长时弹出 +n
  if (deltaAttr > 0) spawnDanmu(root, "spAttrTraces", `+${num(deltaAttr)}`, { tone: "attr" });
  if (deltaCluster > 0) spawnDanmu(root, "spClusterTraces", `+${num(deltaCluster)}`, { tone: "cl" });

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
  setHTML(root, "spDateLegend", `<span><i class="is-comp"></i>外环 已压缩</span><span><i class="is-attr"></i>内环 已评测</span>`);
  renderDates(root, model);
  S.fx?.redraw();
}

function closeDates(root) {
  S.selectedModel = null;
  const dv = $("#spDateView", root);
  const ml = $("#spModelList", root);
  if (dv) dv.hidden = true;
  if (ml) ml.hidden = false;
  setHTML(root, "spDateLegend", `<span><i class="is-attr"></i>外环 已评测</span><span><i class="is-cl"></i>内环 已聚类</span>`);
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
      S.chartRO?.disconnect();
      let resizeRaf = 0;
      S.chartRO = new ResizeObserver(() => {
        if (resizeRaf) return;
        resizeRaf = requestAnimationFrame(() => {
          resizeRaf = 0;
          if (S.data) drawChart(root);
        });
      });
      S.chartRO.observe(chart);
    }
  }
  if (!root._spClickWired) {
    root._spClickWired = true;
    if (typeof bindTips === "function") {
      bindTips(root, (el) => {
        if (el.dataset.tip !== "p") return null;
        const p = Number(el.dataset.pending) || 0;
        const a = Number(el.dataset.attr) || 0;
        const c = Number(el.dataset.clustered) || 0;
        return `<div class="t-head">待聚类池</div>
          <div class="t-row">待聚类<b class="num">${fmt(p)} trace</b></div>
          <div class="t-row">已聚类<b class="num">${fmt(c)} trace</b></div>
          <div class="t-row">已归因<b class="num">${fmt(a)} trace</b></div>`;
      });
    }
    root.addEventListener("click", (e) => {
      if (e.target.closest("#spConn")) {
        fetchSpeed({ force: true });
        return;
      }
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

function tickHeartbeat() {
  if (!S.root || !S.data || document.hidden || document.documentElement.dataset.view !== "speed") return;
  if (S.inflight) {
    setText(S.root, "spConnText", "正在刷新…");
    return;
  }
  if (S.data.ok) {
    const elapsed = Math.max(0, Date.now() - (S.lastPollAt || Date.now()));
    const remSec = Math.max(1, Math.ceil((POLL_MS - elapsed) / 1000));
    const conn = $("#spConn", S.root);
    if (elapsed < 2800 && (S.lastManualSync || S.lastSyncDelta > 0)) {
      conn?.classList?.add("is-synced");
      const msg = S.lastSyncDelta > 0 ? `已刷新 +${num(S.lastSyncDelta)}` : "已刷新 · 已是最新";
      setText(S.root, "spConnText", `${msg} · ${remSec}s`);
    } else {
      S.lastManualSync = false;
      conn?.classList?.remove("is-synced");
      setText(S.root, "spConnText", `${remSec}s 后刷新 · ${clock(S.data.updated_at)}`);
    }
  }
  if (!S.liveRunning) return;
  const sec = Math.floor(Date.now() / 1000);
  const wave = Math.sin(sec * 1.37) * 0.65 + Math.cos(sec * 0.73) * 0.35;
  const gw = S.data.gateways || {};
  const baseRpm = Number(gw.realtime_rpm) || 0;
  if (baseRpm > 0) {
    const liveRpm = Math.max(0.5, baseRpm + wave * Math.max(0.6, baseRpm * 0.015));
    setText(S.root, "spGwRpm", rate(liveRpm));
    if (gw.rpm_limit) {
      setText(S.root, "spGwRpmSub", `配额 ${num(gw.rpm_limit)} · ${pct(liveRpm, gw.rpm_limit, 1)}`);
      const fill = $("#spGwMeterFill", S.root);
      if (fill) fill.style.width = `${Math.max(0, Math.min(100, (liveRpm / gw.rpm_limit) * 100)).toFixed(1)}%`;
    }
  }
  const lead = gw.items?.[0];
  if (lead?.latency_ms != null && Number(lead.latency_ms) > 0) {
    const baseLat = Number(lead.latency_ms);
    const liveLat = Math.max(1, baseLat + Math.cos(sec * 1.91) * Math.max(0.4, baseLat * 0.022));
    setText(S.root, "spGwLatency", fmt(liveLat, 1));
  }
  const r = S.data.rates || {};
  const basePa = Number(r.parts_attr) || 0;
  const basePc = Number(r.parts_compact) || 0;
  if (basePa > 0 || basePc > 0) {
    const livePa = basePa > 0 ? Math.max(0.1, basePa + Math.sin(sec * 1.13) * Math.max(0.15, basePa * 0.025)) : 0;
    const livePc = basePc > 0 ? Math.max(0.1, basePc + Math.cos(sec * 1.29) * Math.max(0.12, basePc * 0.025)) : 0;
    setText(S.root, "spGwPartsAttr", rate(livePa));
    setText(S.root, "spGwPartsComp", rate(livePc));
    setText(S.root, "spPartsAttrSub", `在途 ${rate(livePa)} 条/分钟`);
    setText(S.root, "spPartsCompactSub", `在途 ${rate(livePc)} 条/分钟`);
  }
}

async function fetchSpeed({ force = false } = {}) {
  if (S.inflight || (!force && (document.hidden || document.documentElement.dataset.view !== "speed"))) return;
  S.inflight = true;
  const startedAt = Date.now();
  const conn = S.root ? $("#spConn", S.root) : null;
  if (conn) {
    conn.classList?.remove("is-synced");
    conn.classList?.add("is-spinning");
    if (S.data) setText(S.root, "spConnText", "正在刷新…");
  }
  try {
    // 评测速度只有 AIME（弗吉尼亚）接入：其它节点不转发、不借用别人的数据，直接显示暂无。
    const sep = S.sourceUrl.includes("?") ? "&" : "?";
    const data = await getJSON(`${S.sourceUrl}${sep}_=${Date.now()}`, { retries: 1 });
    if (force && isBrowser()) {
      const waitMs = Math.max(0, 460 - (Date.now() - startedAt));
      if (waitMs > 0) await new Promise((res) => setTimeout(res, waitMs));
    }
    if (data && data.available === false) {
      S.unavailable = true;
      if (S.root) showEmpty(S.root);
      return;
    }
    S.unavailable = false;
    S.lastManualSync = Boolean(force);
    if (S.root && data) {
      applyData(S.root, data);
      if (force) {
        const cEl = $("#spConn", S.root);
        cEl?.classList?.add("is-synced");
        const msg = S.lastSyncDelta > 0 ? `已刷新 +${num(S.lastSyncDelta)}` : "已刷新 · 已是最新";
        setText(S.root, "spConnText", `${msg} · ${Math.round(POLL_MS / 1000)}s`);
        const ovCard = $(".sp-ov-card", S.root);
        if (ovCard?.classList) {
          ovCard.classList.remove("is-refreshed");
          void ovCard.offsetWidth;
          ovCard.classList.add("is-refreshed");
        }
        if (S.timer) {
          clearInterval(S.timer);
          S.timer = setInterval(fetchSpeed, POLL_MS);
        }
      }
    }
  } catch (err) {
    if (S.root) {
      const cEl = $("#spConn", S.root);
      if (cEl) {
        cEl.className = "sp-conn is-quiet is-refresh is-bad";
        setText(S.root, "spConnText", S.data ? "暂未连上 · 点击重试" : "读取失败，自动重试中");
      }
    }
  } finally {
    S.inflight = false;
    if (S.root) $("#spConn", S.root)?.classList?.remove("is-spinning");
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
  const { tax, pd } = ctxTax(c);
  const nextTaxKey = `${c?.product || ""}|${c?.data?.generated_at || ""}|${tax ? 1 : 0}`;
  if (!root.firstChild || (!$("#spRingAttr", root) && !$("#spEmpty", root))) {
    root.innerHTML = shellHTML(tax, pd);
    wireControls(root);
    mountPipeline(root, c);
  } else if (S.taxKey !== nextTaxKey && $("#spFxHost", root)) {
    const host = $("#spFxHost", root);
    host.innerHTML = fxDiagramHTML(tax, pd, { horizontal: true, showMatrix: false, showControls: false, showLabels: false, showPool: true, idPrefix: "spfx", treeW: HORIZ_TREE_W, treeH: HORIZ_TREE_H });
    mountPipeline(root, c);
  }
  await fetchSpeed();
  if (!S.timer) {
    S.timer = setInterval(fetchSpeed, POLL_MS);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && document.documentElement.dataset.view === "speed") fetchSpeed();
    });
  }
  if (!S.heartbeatTimer && isBrowser()) {
    S.heartbeatTimer = setInterval(tickHeartbeat, 1000);
  }
}
