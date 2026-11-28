/* 评测速度: live AIME throughput, overview concentric rings, native horizontal pipeline & gateway telemetry. */
import { $, esc, fmt, pct, segmented, showTip, hideTip, bindTips, getJSON } from "./core.js";
import { fxDiagramHTML, mountFxDiagram } from "./system.js";

const POLL_MS = 30000;
const SVG_NS = "http://www.w3.org/2000/svg";
const CHART_PAD = { L: 48, R: 24, T: 18, B: 32 };
const RING_OUT_C = 2 * Math.PI * 64;
const RING_IN_C = 2 * Math.PI * 49;
const DETAIL_OUT_C = 2 * Math.PI * 62;
const DETAIL_IN_C = 2 * Math.PI * 51;
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
  evalRunning: false,
  clusterRunning: false,
  pendWord: "待评测",
  selectedModel: "__all__",
  selectedMonth: "",
  selectedDate: "",
  range: 300,
  userPickedRange: false,
  chartMode: "landing",
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
  prevRawAttrTraces: null,
  prevRawClusterTraces: null,
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
const shortNum = (v) => {
  const n = Number(v) || 0;
  if (n >= 10000) return `${(n / 1000).toFixed(n >= 100000 ? 0 : 1).replace(/\.0$/, "")}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(Math.round(n));
};
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

/* Derive overall pipeline run state (`评测中` / `重评中` / `聚类中` / `空闲中` / `中断中` / `已完成` / `采集中断`). */
export function deriveEvalStatus(data) {
  if (!data || data.ok === false) {
    return { key: "error", label: "采集中断", cls: "is-bad", running: false, evalRunning: false, clusterRunning: false, reeval: false, detail: "" };
  }
  const isPg = data.mode === "pg";
  const ctrl = data.gateways?.control || {};
  const rates = data.rates || {};
  const pg = data.pg_pipeline || {};
  const queue = data.queue || {};
  const locks = queue.locks || [];
  const cluster = data.cluster || {};
  const inputTraces = Number(data.input_traces) || 0;
  const remainingTraces = Number(data.remaining_traces) || 0;
  const reevalRem = Number(data.reeval_remaining_traces ?? queue.reeval_pending ?? pg.reeval_remaining) || 0;
  const newRem = data.new_remaining_traces != null
    ? (Number(data.new_remaining_traces) || 0)
    : Math.max(0, remainingTraces - reevalRem);
  const pureReeval = reevalRem > 0 && newRem === 0;
  const pendWord = pureReeval ? "待重评" : "待评测";
  const clusterPending = Number(cluster.pending) || 0;
  const activeWriters = Number(rates.active_writers) || 0;
  const runningJobs = Number(queue.running) || 0;
  const rpm = Number(rates.realtime_rpm) || 0;
  const partsRate = (Number(rates.parts_attr) || 0) + (Number(rates.parts_compact) || 0);
  const attrRate = Number(rates.attr) || 0;
  const compactRate = Number(rates.compact) || 0;
  const clusterRate = isPg ? (Number(pg.cluster_rate_5m ?? rates.cluster) || 0) : (Number(rates.cluster) || 0);
  const evalRate = isPg
    ? (Number(pg.eval_rate_5m ?? rates.attr) || 0)
    : Math.max(attrRate, Number(rates.parts_attr) || 0, compactRate, Number(rates.parts_compact) || 0);
  const pgWorkers = pg.active_workers || [];
  const pgActiveWorkers = pgWorkers.length
    ? pgWorkers.filter((w) => (Number(w.claimed) || 0) > (Number(w.expired) || 0)).length
    : (Number(pg.active_worker_count ?? queue.active_workers ?? activeWriters) || 0);
  const freshLock = locks.some((l) => l.heartbeat_age_s == null || Number(l.heartbeat_age_s) <= 180);
  const gwFresh = (data.gateways?.items || []).some((g) => g.ok && g.active_ago_s != null && Number(g.active_ago_s) <= 90);

  if (ctrl.paused) {
    return { key: "paused", label: "中断中", cls: "is-bad", running: false, evalRunning: false, clusterRunning: false, reeval: pureReeval, detail: "调度暂停" };
  }
  const evalRunning = isPg
    ? (evalRate >= 0.05 || pgActiveWorkers > 0 || runningJobs > 0 || (remainingTraces > 0 && rpm > 0.5))
    : (activeWriters > 0 || partsRate >= 0.05 || attrRate >= 0.05 || compactRate >= 0.05 || (remainingTraces > 0 && rpm > 0.5));
  const clusterRunning = clusterRate >= 0.05 || (isPg && !evalRunning && remainingTraces <= 0 && clusterPending > 0 && rpm > 0.5);
  if (evalRunning || clusterRunning) {
    const workers = isPg
      ? (pgActiveWorkers || data.gateways?.active_replicas || 0)
      : (data.gateways?.active_replicas || activeWriters || runningJobs);
    if (evalRunning && pureReeval) {
      return { key: "reeval", label: "重评中", cls: "is-ok is-live", running: true, evalRunning: true, clusterRunning, reeval: true, detail: workers ? `${workers} 实例` : "" };
    }
    if (evalRunning) {
      return { key: "running", label: "评测中", cls: "is-ok is-live", running: true, evalRunning: true, clusterRunning, reeval: false, detail: workers ? `${workers} 实例` : "" };
    }
    return { key: "clustering", label: "聚类中", cls: "is-ok is-live", running: true, evalRunning: false, clusterRunning: true, reeval: false, detail: "" };
  }
  if (inputTraces > 0 && remainingTraces <= 0 && clusterPending <= 0) {
    return { key: "done", label: "已完成", cls: "is-ok", running: false, evalRunning: false, clusterRunning: false, reeval: false, detail: "" };
  }
  if (isPg) {
    const detail = remainingTraces > 0
      ? `${pendWord} ${num(remainingTraces)}`
      : (clusterPending > 0 ? `待聚类 ${num(clusterPending)}` : "");
    return { key: "idle", label: "空闲中", cls: "is-warn", running: false, evalRunning: false, clusterRunning: false, reeval: pureReeval, detail };
  }
  return { key: "stalled", label: "中断中", cls: "is-warn", running: false, evalRunning: false, clusterRunning: false, reeval: false, detail: runningJobs > 0 || freshLock || gwFresh ? "速率为 0" : "" };
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
        <div class="sp-ov-ring" role="img" aria-label="已评测、已聚类占评测输入比例">
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
            <span class="sp-ov-lbl">已完成评测</span>
            <div class="sp-ov-val"><span class="big num" id="spAttrTraces">—</span><span class="unit">trace</span></div>
            <span class="sp-ov-sub" id="spAttrPct">—</span>
          </div>
          <div class="sp-ov-stat" style="--c:var(--loc-ulq)">
            <span class="sp-ov-lbl">已聚类</span>
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

    <article class="card sp-rate-card is-rate-attr" style="--span:3">
      <header class="card-head"><h2 id="spRateTitle1">归因速率</h2></header>
      <div class="sp-rate"><span class="big num" id="spAttrRate">—</span><span class="unit">trace/分钟</span></div>
      <p class="sp-rate-sub" id="spPartsAttrSub">在途 —</p>
    </article>

    <article class="card sp-rate-card is-rate-comp" id="spRateCard2" style="--span:3">
      <header class="card-head"><h2 id="spRateTitle2">压缩速率</h2></header>
      <div class="sp-rate"><span class="big num" id="spCompactRate">—</span><span class="unit">trace/分钟</span></div>
      <p class="sp-rate-sub" id="spPartsCompactSub">在途 —</p>
    </article>

    <article class="card sp-rate-card is-rate-rpm" id="spRateCardGw" style="--span:3">
      <header class="card-head">
        <h2>网关 RPM</h2>
        <span class="sp-util-pill num" id="spTopGwUtil">—</span>
      </header>
      <div class="sp-rate"><span class="big num" id="spTopGwRpm">—</span><span class="unit">RPM</span></div>
      <div class="sp-gw-meter sp-rate-meter" id="spTopGwMeter"><i id="spTopGwMeterFill" style="width:0%"></i></div>
      <p class="sp-rate-sub num" id="spTopGwSub">配额 —</p>
    </article>

    <article class="card sp-rate-card" style="--span:3">
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
            <button type="button" id="spModeBtn1" data-value="landing">落地速度</button>
            <button type="button" id="spModeBtn3" data-value="attr_compact" hidden>归因与压缩</button>
            <button type="button" id="spModeBtn2" data-value="rpm">网关 RPM</button>
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
        <svg class="sp-chart" id="spChart" viewBox="0 0 960 256" role="img" aria-label="评测与聚类速度实时趋势">
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
        <div class="sp-chart-empty" id="spChartEmpty" hidden>暂无趋势数据</div>
      </div>
    </article>

    <article class="card" style="--span:12">
      <header class="card-head">
        <h2 id="spSchedTitle">网关与实时调度</h2>
        <span class="sp-conn is-quiet end" id="spGwSummary">—</span>
      </header>
      <div class="sp-gw-kpis">
        <div class="sp-gw-kpi">
          <span class="sp-gw-kpi-label" id="spKpiLbl1">网关 RPM</span>
          <div class="sp-gw-kpi-val"><b class="mid num" id="spGwRpm">—</b><span class="unit" id="spKpiUnit1">RPM</span></div>
          <div class="sp-gw-meter" id="spGwMeter"><i id="spGwMeterFill" style="width:0%"></i></div>
          <span class="sp-gw-kpi-sub" id="spGwRpmSub">配额 —</span>
        </div>
        <div class="sp-gw-kpi">
          <span class="sp-gw-kpi-label" id="spKpiLbl2">在途吞吐</span>
          <div class="sp-gw-kpi-val"><b class="mid num" id="spGwPartsAttr">—</b><span class="sp-slash" id="spKpiSlash2">/</span><b class="mid num" id="spGwPartsComp">—</b><span class="unit" id="spKpiUnit2">条/分</span></div>
          <span class="sp-gw-kpi-sub" id="spGwPartsSub">写入流 —</span>
        </div>
        <div class="sp-gw-kpi">
          <span class="sp-gw-kpi-label" id="spKpiLbl3">并发预算</span>
          <div class="sp-gw-kpi-val"><b class="mid num" id="spGwPermits">—</b><span class="unit" id="spKpiUnit3">许可</span></div>
          <span class="sp-gw-kpi-sub" id="spGwControlSub">—</span>
        </div>
        <div class="sp-gw-kpi">
          <span class="sp-gw-kpi-label" id="spKpiLbl4">网关延迟</span>
          <div class="sp-gw-kpi-val"><b class="mid num" id="spGwLatency">—</b><span class="unit" id="spKpiUnit4">ms</span></div>
          <span class="sp-gw-kpi-sub" id="spGwProbeSub">—</span>
        </div>
      </div>
      <div class="md-table sp-table" id="spGwTableWrap">
        <table>
          <thead id="spGwThead">
            <tr>
              <th>网关 / 渠道</th><th>状态</th><th>模型</th>
              <th class="num">实时 RPM / 配额</th><th class="num">利用率</th><th class="num">并发许可</th>
              <th class="num">探活延迟</th><th class="num">最近活跃</th>
            </tr>
          </thead>
          <tbody id="spGateways"><tr><td colspan="8" class="empty">读取中…</td></tr></tbody>
        </table>
      </div>
      <div class="md-table sp-table sp-workers-wrap" id="spWorkersWrap" hidden>
        <table>
          <thead>
            <tr>
              <th>执行 Worker</th><th>状态</th><th>模型</th>
              <th class="num">持有租约</th><th class="num">过期租约</th><th class="num">最近活跃</th>
            </tr>
          </thead>
          <tbody id="spWorkers"></tbody>
        </table>
      </div>
    </article>

    <article class="card sp-date-card" style="--span:12">
      <header class="card-head sp-date-card-head">
        <h2>日期分布</h2>
        <div class="sp-model-pills" id="spModels" role="tablist" aria-label="模型筛选"></div>
        <div class="sp-ring-legend" id="spDateLegend">
          <span><i class="is-cl"></i>已完成</span>
          <span><i class="is-attr"></i>已评测</span>
          <span><i class="is-pend"></i>待评测</span>
        </div>
      </header>
      <div id="spDateView" class="sp-date-view">
        <div class="sp-month-bar" id="spMonthBar"></div>
        <div class="sp-date-stage" id="spDateStage">
          <div class="sp-bar-panel" id="spDateChart"><div class="empty">读取中…</div></div>
          <aside class="sp-day-detail" id="spDateDetail" hidden aria-label="当日评测环形图详情"></aside>
        </div>
      </div>
    </article>
  </div>`;
}

export function modelRowsHTML(data, { attrCarry = 0, clCarry = 0, selectedModel = "__all__" } = {}) {
  const models = data?.models || [];
  if (!models.length) return "";
  const cl = new Map((data?.cluster?.models || []).map((c) => [c.name, Number(c.traces) || 0]));
  const runningModels = new Set((data?.queue?.locks || []).map((l) => l.model).filter(Boolean));
  const preferredIdx = models.findIndex((m) => runningModels.has(m.name));
  const activeSel = models.length === 1
    ? models[0].name
    : (selectedModel && (selectedModel === "__all__" || models.some((m) => m.name === selectedModel)) ? selectedModel : "__all__");
  let carryAssigned = false;

  const pills = [];
  if (models.length > 1) {
    const totIn = models.reduce((s, m) => s + (Number(m.input_traces) || 0), 0);
    const totAttr = Math.min(totIn || Infinity, models.reduce((s, m) => s + (Number(m.attr_traces) || 0), 0) + attrCarry);
    const totPct = totIn > 0 ? pct(totAttr, totIn, 0) : "—";
    const allTip = `<div class="t-head">全部模型</div>
      <div class="t-row"><span>输入总量</span><b class="num">${num(totIn)} trace</b></div>
      <div class="t-row"><span>已完成评测</span><b class="num">${num(totAttr)} (${totIn ? pct(totAttr, totIn, 1) : "—"})</b></div>`;
    pills.push(`<button type="button" class="sp-model-pill${activeSel === "__all__" ? " is-active" : ""}" role="tab" aria-selected="${activeSel === "__all__"}" data-sp-model="__all__" data-tip="1" data-tip-html="${esc(allTip)}">
      <span>全部模型</span><em class="num">${esc(totPct)}</em>
    </button>`);
  }

  for (let idx = 0; idx < models.length; idx++) {
    const m = models[idx];
    const inTr = Number(m.input_traces) || 0;
    const rawAttr = Number(m.attr_traces) || 0;
    const isPreferred = preferredIdx >= 0 ? idx === preferredIdx : (rawAttr < inTr || idx === 0);
    const isActiveModel = !carryAssigned && isPreferred;
    if (isActiveModel && (attrCarry > 0 || clCarry > 0)) carryAssigned = true;
    const attrTr = isActiveModel ? Math.min(inTr || Infinity, rawAttr + attrCarry) : rawAttr;
    const rawRem = m.remaining != null ? Math.max(0, Number(m.remaining) || 0) : Math.max(0, inTr - rawAttr);
    const remTr = isActiveModel ? Math.max(0, rawRem - attrCarry) : rawRem;
    const reevalRem = Number(m.reeval_remaining) || 0;
    const pendLbl = remTr > 0 && reevalRem >= remTr ? "待重评" : "待评测";
    const hasCl = cl.has(m.name);
    const rawCl = cl.get(m.name) || 0;
    const clTr = isActiveModel && hasCl ? Math.min(attrTr, rawCl + clCarry) : rawCl;
    const done = remTr === 0 && inTr > 0;
    const pctText = inTr > 0 ? (done ? "100%" : pct(attrTr, inTr, 0)) : "—";
    const tip = `<div class="t-head">${esc(m.name)}</div>
      <div class="t-row"><span>评测输入</span><b class="num">${num(inTr)} trace · ${num(m.input_sessions)} sess</b></div>
      <div class="t-row"><span>已完成评测</span><b class="num">${num(attrTr)} (${inTr ? pct(attrTr, inTr, 1) : "—"})</b></div>
      ${hasCl ? `<div class="t-row"><span>已聚类</span><b class="num">${num(clTr)} (${inTr ? pct(clTr, inTr, 1) : "—"})</b></div>` : ""}
      <div class="t-row"><span>${pendLbl}</span><b class="num">${done ? "已完成" : `${num(remTr)} trace`}</b></div>`;
    const isSel = activeSel === m.name;
    pills.push(`<button type="button" class="sp-model-pill${isSel ? " is-active" : ""}${done ? " is-done" : ""}${isPreferred || remTr > 0 ? " is-active-model" : ""}" role="tab" aria-selected="${isSel}" data-sp-model="${esc(m.name)}" data-sp-mattr="${attrTr}" data-sp-min="${inTr}" data-sp-mrem="${remTr}" data-sp-mcl="${clTr}" data-tip="1" data-tip-html="${esc(tip)}">
      <i class="sp-mp-dot" aria-hidden="true"></i>
      <span>${esc(m.name)}</span>
      <em class="num" data-sp-mpct="${esc(m.name)}">${esc(pctText)}</em>
    </button>`);
  }
  return pills.join("");
}


function gatewayUtilRatio(gw) {
  const g = gw || {};
  if (g.rpm_utilization != null && Number.isFinite(Number(g.rpm_utilization))) {
    return Math.max(0, Number(g.rpm_utilization));
  }
  const limit = Number(g.rpm_limit) || 0;
  const live = g.realtime_rpm != null ? Number(g.realtime_rpm) : null;
  if (limit > 0 && live != null && Number.isFinite(live)) return Math.max(0, live / limit);
  return null;
}

function utilPctText(ratio) {
  if (ratio == null || !Number.isFinite(ratio)) return "—";
  return `${(ratio * 100).toFixed(1)}%`;
}

function gatewayRowsHTML(items) {
  return items.map((item) => {
    const cls = item.cooldown ? "is-warn" : item.ok ? "is-ok" : "";
    const statusText = item.cooldown ? "冷却中" : item.healthy ? "健康" : item.ok ? `HTTP ${item.code}` : "离线";
    const modelsText = (item.models || []).length ? item.models.join(", ") : "—";
    const urlTitle = String(item.url || "").replace(/\/v1\/?$/, "");
    const rpmCell = item.rpm != null
      ? `${rate(item.rpm)}${item.rpm_limit ? `<span class="faint"> / ${num(item.rpm_limit)}</span>` : ""}`
      : (item.rpm_limit ? `—<span class="faint"> / ${num(item.rpm_limit)}</span>` : "—");
    const itemUtil = item.rpm_utilization != null
      ? Math.max(0, Number(item.rpm_utilization))
      : (item.rpm != null && item.rpm_limit ? Math.max(0, Number(item.rpm) / Number(item.rpm_limit)) : null);
    const barW = itemUtil != null ? Math.min(100, itemUtil * 100).toFixed(1) : "0";
    const utilTone = itemUtil != null && itemUtil >= 0.98 ? " is-full" : (itemUtil != null && itemUtil >= 0.85 ? " is-hot" : "");
    const utilCell = itemUtil != null
      ? `<span class="sp-util-cell${utilTone}"><span class="sp-util-bar"><i style="width:${barW}%"></i></span><b class="num">${esc(utilPctText(itemUtil))}</b></span>`
      : "—";
    const permitCell = item.permits != null
      ? `${num(item.permits)}${item.concurrency != null ? `<span class="faint"> / ${num(item.concurrency)}</span>` : ""}`
      : "—";
    const latCell = item.latency_ms != null ? `${fmt(item.latency_ms, 1)} ms` : "—";
    return `<tr>
      <td><span class="sp-gw-name" title="${esc(urlTitle)}">${esc(item.name)}</span></td>
      <td><span class="sp-badge ${cls}"><i></i>${esc(statusText)}</span></td>
      <td><span class="sp-chip">${esc(modelsText)}</span></td>
      <td class="num">${rpmCell}</td>
      <td class="num">${utilCell}</td>
      <td class="num">${permitCell}</td>
      <td class="num">${latCell}</td>
      <td class="num">${esc(agoLabel(item.active_ago_s))}</td>
    </tr>`;
  }).join("");
}

function renderTopGatewayCard(root, gw) {
  const g = gw || {};
  const liveRpm = g.realtime_rpm;
  const limit = g.rpm_limit;
  const util = gatewayUtilRatio(g);
  const lead = (g.items || [])[0] || null;

  setText(root, "spTopGwRpm", liveRpm == null ? "—" : rate(liveRpm));
  const pill = $("#spTopGwUtil", root);
  if (pill) {
    setText(root, "spTopGwUtil", util != null ? utilPctText(util) : "—");
    pill.classList?.toggle("is-hot", util != null && util >= 0.85 && util < 0.98);
    pill.classList?.toggle("is-full", util != null && util >= 0.98);
  }
  const meter = $("#spTopGwMeter", root);
  const meterFill = $("#spTopGwMeterFill", root);
  if (meter && meterFill) {
    meterFill.style.width = `${Math.min(100, (util || 0) * 100).toFixed(1)}%`;
    meter.classList?.toggle("is-hot", util != null && util >= 0.85 && util < 0.98);
    meter.classList?.toggle("is-full", util != null && util >= 0.98);
  }
  const parts = [limit ? `配额 ${num(limit)}` : "配额 —"];
  if (g.rpm_1h != null && Number.isFinite(Number(g.rpm_1h))) parts.push(`1h ${rate(g.rpm_1h)}`);
  setText(root, "spTopGwSub", parts.join(" · "));
}

function renderPgSchedule(root, data) {
  const pg = data.pg_pipeline || {};
  const q = data.queue || {};
  const g = data.gateways || {};
  const items = g.items || [];
  const ctrl = g.control || {};
  const workers = pg.active_workers || [];
  const remTr = Number(data.remaining_traces) || 0;
  const reevalRem = Number(data.reeval_remaining_traces ?? q.reeval_pending ?? pg.reeval_remaining) || 0;
  const newRem = data.new_remaining_traces != null ? (Number(data.new_remaining_traces) || 0) : Math.max(0, remTr - reevalRem);
  const pendWord = reevalRem > 0 && newRem === 0 ? "待重评" : "待评测";
  const clPending = Number(data.cluster?.pending) || 0;
  const pendingProb = Number(pg.cluster_pending_problems) || 0;
  const claimed = Number(q.running) || 0;
  const retrying = Number(q.retrying ?? pg.retrying) || 0;
  const failed = Number(q.failed) || 0;
  const expired = Number(pg.expired_leases) || 0;
  const liveRpm = g.realtime_rpm;
  const limit = g.rpm_limit;
  const util = gatewayUtilRatio(g);
  const lead = items[0] || null;

  setText(root, "spSchedTitle", "网关与实时调度");
  const summaryParts = [];
  if (items.length) summaryParts.push(`${g.healthy} / ${g.count} 健康${ctrl.paused ? " · 已暂停" : ""}`);
  summaryParts.push(workers.length ? `${num(workers.length)} 活跃 worker · 持有 ${num(claimed)} 条` : "队列空闲");
  setText(root, "spGwSummary", summaryParts.join(" · "));

  setText(root, "spKpiLbl1", "网关 RPM");
  setText(root, "spGwRpm", liveRpm == null ? "—" : rate(liveRpm));
  setText(root, "spKpiUnit1", "RPM");
  setText(root, "spGwRpmSub", limit ? `配额 ${num(limit)}` : `1h 均速 ${rate(g.rpm_1h)}`);
  const meter = $("#spGwMeter", root);
  const meterFill = $("#spGwMeterFill", root);
  if (meter && meterFill) {
    meterFill.style.width = `${Math.min(100, (util || 0) * 100).toFixed(1)}%`;
    meter.classList?.toggle("is-hot", util != null && util >= 0.85 && util < 0.98);
    meter.classList?.toggle("is-full", util != null && util >= 0.98);
  }

  setText(root, "spKpiLbl2", "在途租约");
  setText(root, "spGwPartsAttr", num(claimed));
  const slash2 = $("#spKpiSlash2", root);
  const comp2 = $("#spGwPartsComp", root);
  if (slash2) slash2.hidden = true;
  if (comp2) comp2.hidden = true;
  setText(root, "spKpiUnit2", "trace");
  setText(root, "spGwPartsSub", `${pendWord} ${num(remTr)}${retrying > 0 ? ` · 重试 ${num(retrying)}` : ""}${failed > 0 ? ` · 异常 ${num(failed)}` : ""}${expired > 0 ? ` · 过期 ${num(expired)}` : ""}`);

  setText(root, "spKpiLbl3", "待聚类池");
  setText(root, "spGwPermits", num(clPending));
  setText(root, "spKpiUnit3", "trace");
  setText(root, "spGwControlSub", `未聚类问题 ${num(pendingProb)}`);

  if (lead) {
    setText(root, "spKpiLbl4", "网关延迟");
    setText(root, "spGwLatency", lead.latency_ms != null ? fmt(lead.latency_ms, 1) : "—");
    setText(root, "spKpiUnit4", "ms");
    const repLabel = g.active_replicas != null ? `${num(g.active_replicas)} 实例` : "0 实例";
    setText(root, "spGwProbeSub", `HTTP ${lead.code || "—"} · ${repLabel} · ${agoLabel(lead.active_ago_s)}`);
  } else {
    const lastAgo = pg.last_eval_ago_s != null && pg.last_cluster_ago_s != null
      ? Math.min(pg.last_eval_ago_s, pg.last_cluster_ago_s)
      : (pg.last_eval_ago_s ?? pg.last_cluster_ago_s);
    setText(root, "spKpiLbl4", "最近落库");
    setText(root, "spGwLatency", agoLabel(lastAgo));
    setText(root, "spKpiUnit4", "");
    setText(root, "spGwProbeSub", `评测 ${clock(pg.last_eval_at)} · 聚类 ${clock(pg.last_cluster_at)}`);
  }

  const gwWrap = $("#spGwTableWrap", root);
  if (gwWrap) gwWrap.hidden = items.length === 0;
  if (items.length) {
    setHTML(root, "spGwThead", `<tr>
      <th>网关 / 渠道</th><th>状态</th><th>模型</th>
      <th class="num">实时 RPM / 配额</th><th class="num">利用率</th><th class="num">并发许可</th>
      <th class="num">探活延迟</th><th class="num">最近活跃</th>
    </tr>`);
    setHTML(root, "spGateways", gatewayRowsHTML(items));
  }

  const workersWrap = $("#spWorkersWrap", root);
  if (workersWrap) workersWrap.hidden = workers.length === 0;
  if (workers.length) {
    const rowsHTML = workers.map((w) => {
      const ok = (w.claimed || 0) > (w.expired || 0);
      return `<tr>
        <td><span class="sp-gw-name">${esc(w.worker)}</span></td>
        <td><span class="sp-badge ${ok ? "is-ok" : "is-warn"}"><i></i>${ok ? "执行中" : "租约过期"}</span></td>
        <td><span class="sp-chip">${esc(w.model)}</span></td>
        <td class="num">${num(w.claimed)} trace</td>
        <td class="num">${num(w.expired)}</td>
        <td class="num">${esc(agoLabel(w.age_s))}</td>
      </tr>`;
    }).join("");
    setHTML(root, "spWorkers", rowsHTML);
  }
}


function renderGateways(root, gw) {
  const wrap = $("#spGwTableWrap", root);
  if (wrap) wrap.hidden = false;
  const workersWrap = $("#spWorkersWrap", root);
  if (workersWrap) workersWrap.hidden = true;
  const slash2 = $("#spKpiSlash2", root);
  const comp2 = $("#spGwPartsComp", root);
  if (slash2) slash2.hidden = false;
  if (comp2) comp2.hidden = false;
  setText(root, "spSchedTitle", "网关与实时调度");
  setText(root, "spKpiLbl1", "网关 RPM");
  setText(root, "spKpiUnit1", "RPM");
  setText(root, "spKpiLbl2", "在途吞吐");
  setText(root, "spKpiUnit2", "条/分");
  setText(root, "spKpiLbl3", "并发预算");
  setText(root, "spKpiUnit3", "许可");
  setText(root, "spKpiLbl4", "网关延迟");
  setText(root, "spKpiUnit4", "ms");
  const g = gw || {};
  const items = g.items || [];
  const ctrl = g.control || {};
  const limit = g.rpm_limit;
  const liveRpm = g.realtime_rpm;
  const util = gatewayUtilRatio(g);

  setText(root, "spGwSummary", items.length
    ? `${g.healthy} / ${g.count} 健康${ctrl.paused ? " · 已暂停" : ""}`
    : "未配置网关");

  setText(root, "spGwRpm", liveRpm == null ? "—" : rate(liveRpm));
  setText(root, "spGwRpmSub", limit
    ? `利用率 ${utilPctText(util)} · 配额 ${num(limit)}`
    : "配额 —");
  const meter = $("#spGwMeter", root);
  const meterFill = $("#spGwMeterFill", root);
  if (meter && meterFill) {
    meterFill.style.width = `${Math.min(100, (util || 0) * 100).toFixed(1)}%`;
    meter.classList?.toggle("is-hot", util != null && util >= 0.85 && util < 0.98);
    meter.classList?.toggle("is-full", util != null && util >= 0.98);
  }

  setText(root, "spGwPartsAttr", rate(g.parts_attr_rate));
  setText(root, "spGwPartsComp", rate(g.parts_compact_rate));
  const writers = g.active_writers ?? 0;
  const ageStr = g.newest_part_age_s != null ? ` · ${agoLabel(g.newest_part_age_s)}` : "";
  setText(root, "spGwPartsSub", `${num(writers)} 写入流${ageStr}`);

  setText(root, "spGwPermits", ctrl.model_requests != null ? num(ctrl.model_requests) : "—");
  setText(root, "spGwControlSub", ctrl.concurrency != null
    ? `任务并发 ${num(ctrl.concurrency)}${ctrl.compact_backlog ? ` · 积压 ${num(ctrl.compact_backlog)}` : ""}`
    : "—");

  const lead = items[0];
  setText(root, "spGwLatency", lead?.latency_ms != null ? fmt(lead.latency_ms, 1) : "—");
  const repLabel = g.active_replicas != null ? `${num(g.active_replicas)} 实例` : "0 实例";
  setText(root, "spGwProbeSub", lead
    ? `HTTP ${lead.code || "—"} · ${repLabel} · ${agoLabel(lead.active_ago_s)}`
    : repLabel);

  setHTML(root, "spGwThead", `<tr>
    <th>网关 / 渠道</th><th>状态</th><th>模型</th>
    <th class="num">实时 RPM / 配额</th><th class="num">利用率</th><th class="num">并发许可</th>
    <th class="num">探活延迟</th><th class="num">最近活跃</th>
  </tr>`);
  if (!items.length) {
    setHTML(root, "spGateways", `<tr><td colspan="8" class="empty">未配置网关</td></tr>`);
    return;
  }
  setHTML(root, "spGateways", gatewayRowsHTML(items));
}

function ymLabel(ym) {
  if (!ym || ym.length < 7) return ym || "—";
  return `${ym.slice(0, 4)} 年 ${Number(ym.slice(5, 7))} 月`;
}

function daysInMonth(ym) {
  const y = Number(ym.slice(0, 4));
  const m = Number(ym.slice(5, 7));
  if (!y || !m) return 30;
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function niceBarMax(rawMax) {
  const target = Math.max(1, Number(rawMax) * 1.08);
  const exp = 10 ** Math.floor(Math.log10(target));
  for (const m of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) {
    const val = Math.round(m * exp);
    if (val >= target) return val;
  }
  return Math.ceil(target);
}

/* 聚合所选模型（或全部模型）的按日数据，构造月度柱状图序列与点击详情数据。 */
export function buildMonthlySeries(data, selectedModel = "__all__", preferredMonth = "") {
  const allModels = data?.models || [];
  const effectiveModel = allModels.length === 1
    ? allModels[0].name
    : (selectedModel && selectedModel !== "__all__" && allModels.some((m) => m.name === selectedModel)
      ? selectedModel
      : "__all__");
  const pickedModels = effectiveModel === "__all__"
    ? allModels
    : allModels.filter((m) => m.name === effectiveModel);

  const byDate = new Map();
  for (const m of pickedModels) {
    for (const d of m.dates || []) {
      const ds = String(d.date || "").slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(ds)) continue;
      let rec = byDate.get(ds);
      if (!rec) {
        rec = {
          date: ds,
          input_traces: 0,
          input_sessions: 0,
          attr_traces: 0,
          compact: 0,
          hasCompact: false,
          remaining_traces: 0,
          reeval_remaining: 0,
          models: [],
        };
        byDate.set(ds, rec);
      }
      const inTr = Number(d.input_traces) || 0;
      const inSess = Number(d.input_sessions) || 0;
      const attrTr = Number(d.attr_traces) || 0;
      const compTr = d.compact != null ? (Number(d.compact) || 0) : null;
      const remTr = d.remaining_traces != null ? Math.max(0, Number(d.remaining_traces) || 0) : Math.max(0, inTr - attrTr);
      const reevTr = Math.max(0, Number(d.reeval_remaining) || 0);
      rec.input_traces += inTr;
      rec.input_sessions += inSess;
      rec.attr_traces += attrTr;
      if (compTr != null) {
        rec.compact += compTr;
        rec.hasCompact = true;
      }
      rec.remaining_traces += remTr;
      rec.reeval_remaining += reevTr;
      rec.models.push({
        name: m.name,
        input_traces: inTr,
        input_sessions: inSess,
        attr_traces: attrTr,
        compact: compTr,
        remaining_traces: remTr,
        reeval_remaining: reevTr,
      });
    }
  }

  const allDates = [...byDate.keys()].sort();
  const months = [...new Set(allDates.map((d) => d.slice(0, 7)))].sort();
  const activeMonth = preferredMonth && months.includes(preferredMonth)
    ? preferredMonth
    : (months[months.length - 1] || "");

  const days = [];
  const totals = { input_traces: 0, input_sessions: 0, attr_traces: 0, compact: 0, remaining_traces: 0, reeval_remaining: 0, activeDays: 0 };
  let maxVal = 0;

  if (activeMonth) {
    const dim = daysInMonth(activeMonth);
    const monthDates = allDates.filter((d) => d.startsWith(`${activeMonth}-`));
    const firstActive = monthDates.length ? Number(monthDates[0].slice(8, 10)) : 1;
    const lastActive = monthDates.length ? Number(monthDates[monthDates.length - 1].slice(8, 10)) : dim;
    const isLatestMonth = activeMonth === months[months.length - 1];
    const startDay = firstActive > 5 ? firstActive : 1;
    const endDay = isLatestMonth ? lastActive : (lastActive < dim - 4 ? lastActive : dim);
    for (let day = startDay; day <= endDay; day++) {
      const ds = `${activeMonth}-${String(day).padStart(2, "0")}`;
      const rec = byDate.get(ds) || null;
      const topVal = rec ? Math.max(rec.input_traces, rec.attr_traces) : 0;
      if (rec) {
        totals.input_traces += rec.input_traces;
        totals.input_sessions += rec.input_sessions;
        totals.attr_traces += rec.attr_traces;
        totals.compact += rec.hasCompact ? rec.compact : 0;
        totals.remaining_traces += rec.remaining_traces;
        totals.reeval_remaining += rec.reeval_remaining;
        if (topVal > 0) totals.activeDays += 1;
        if (topVal > maxVal) maxVal = topVal;
      }
      days.push({ day, date: ds, rec, topVal });
    }
  }

  return {
    model: effectiveModel,
    months,
    activeMonth,
    days,
    allDates,
    byDate,
    maxVal: niceBarMax(maxVal || 1),
    rawMax: maxVal,
    totals,
  };
}

export function monthBarHTML(series) {
  const { months, activeMonth, totals } = series;
  if (!months.length) {
    return `<div class="sp-mbar-left"><span class="sp-mbar-cur">暂无按日数据</span></div>`;
  }
  const idx = months.indexOf(activeMonth);
  const prevYm = idx > 0 ? months[idx - 1] : "";
  const nextYm = idx >= 0 && idx < months.length - 1 ? months[idx + 1] : "";
  const quickMonths = months.slice(-6).map((ym) => {
    const active = ym === activeMonth;
    const label = ym.slice(0, 4) === activeMonth.slice(0, 4) ? `${Number(ym.slice(5, 7))}月` : `${ym.slice(2, 4)}/${ym.slice(5, 7)}`;
    return `<button type="button" class="sp-mchip${active ? " is-active" : ""}" data-sp-month="${esc(ym)}" aria-pressed="${active}">${esc(label)}</button>`;
  }).join("");
  const donePct = totals.input_traces > 0 ? pct(totals.attr_traces, totals.input_traces, 1) : "—";
  const pendLbl = totals.reeval_remaining > 0 && totals.reeval_remaining >= totals.remaining_traces ? "待重评" : "待测";
  return `<div class="sp-mbar-left">
      <div class="sp-mnav">
        <button type="button" class="sp-mnav-btn" data-sp-month="${esc(prevYm)}"${prevYm ? "" : " disabled"} aria-label="上个月">‹</button>
        <b class="sp-mbar-cur num">${esc(ymLabel(activeMonth))}</b>
        <button type="button" class="sp-mnav-btn" data-sp-month="${esc(nextYm)}"${nextYm ? "" : " disabled"} aria-label="下个月">›</button>
      </div>
      ${months.length > 1 ? `<div class="sp-mchips" role="group" aria-label="快速切月">${quickMonths}</div>` : ""}
    </div>
    <div class="sp-mbar-stats num">
      <span>输入 <b>${num(totals.input_traces)}</b></span>
      <span>已测 <b class="is-attr">${num(totals.attr_traces)}</b><em>${esc(donePct)}</em></span>
      ${totals.remaining_traces > 0
        ? `<span>${pendLbl} <b>${num(totals.remaining_traces)}</b></span>`
        : (totals.input_traces > 0 ? `<span class="is-done">本月已完成</span>` : "")}
    </div>`;
}

export function dateChartHTML(series, selectedDate = "") {
  if (!series.activeMonth || !series.days.length) {
    return `<div class="empty">暂无日期数据</div>`;
  }
  const maxY = Math.max(1, series.maxVal);
  const midY = Math.round(maxY / 2);
  const dense = series.days.length > 24;
  const cols = series.days.map(({ day, date, rec, topVal }) => {
    if (!rec || topVal <= 0) {
      return `<div class="sp-bar-col is-empty" aria-hidden="true">
        <div class="sp-bar-well"><span class="sp-bar-dot"></span></div>
        <span class="sp-bar-day num">${day}</span>
        <span class="sp-bar-pct num">—</span>
      </div>`;
    }
    const inTr = rec.input_traces;
    const attrTr = rec.attr_traces;
    const compTr = rec.hasCompact ? rec.compact : null;
    const remTr = rec.remaining_traces != null ? Math.max(0, Number(rec.remaining_traces) || 0) : Math.max(0, inTr - attrTr);
    const reevTr = Number(rec.reeval_remaining) || 0;
    const pendLbl = remTr > 0 && reevTr >= remTr ? "待重评" : "待测";
    const totalPct = Math.max(5, Math.min(100, (topVal / maxY) * 100));
    const aRatio = inTr > 0 ? Math.min(1, attrTr / inTr) : 0;
    const attrPct = topVal > 0 ? Math.max(attrTr > 0 ? 4 : 0, Math.min(100, (attrTr / topVal) * 100)) : 0;
    const done = inTr > 0 && remTr === 0;
    const isSel = selectedDate === date;
    const pctShort = done ? "✓" : (inTr > 0 ? `${Math.round(aRatio * 100)}%` : "—");
    const tip = `<div class="t-head">${esc(date)}</div>
      <div class="t-row"><span>评测输入</span><b class="num">${num(inTr)} trace · ${num(rec.input_sessions)} sess</b></div>
      <div class="t-row"><span>已完成评测</span><b class="num">${num(attrTr)} (${inTr ? pct(attrTr, inTr, 1) : "—"})</b></div>
      ${compTr != null ? `<div class="t-row"><span>已完成压缩</span><b class="num">${num(compTr)} (${inTr ? pct(Math.min(inTr, compTr), inTr, 1) : "—"})</b></div>` : ""}
      <div class="t-row"><span>状态</span><b class="num">${done ? "已完成" : `${pendLbl} ${num(remTr)}`}</b></div>`;
    return `<button type="button" class="sp-bar-col${isSel ? " is-selected" : ""}${done ? " is-done" : " is-pending"}" data-sp-day="${esc(date)}" aria-pressed="${isSel}" data-tip="1" data-tip-html="${esc(tip)}">
      <div class="sp-bar-well">
        <span class="sp-bar-track" style="height:${totalPct.toFixed(1)}%">
          <span class="sp-bar-val num">${esc(shortNum(inTr))}</span>
          <span class="sp-bar-fill"><i class="sp-bar-attr" style="height:${attrPct.toFixed(1)}%"></i></span>
        </span>
      </div>
      <span class="sp-bar-day num">${day}日</span>
      <span class="sp-bar-pct num${done ? " is-done" : (aRatio < 0.8 ? " is-low" : "")}">${esc(pctShort)}</span>
    </button>`;
  }).join("");

  return `<div class="sp-mchart${dense ? " is-dense" : ""}" style="--days:${series.days.length}">
    <div class="sp-mchart-yaxis num" aria-hidden="true">
      <span>${num(maxY)}</span>
      <span>${num(midY)}</span>
      <span>0</span>
    </div>
    <div class="sp-mchart-plot">
      <div class="sp-mchart-grid" aria-hidden="true"><i></i><i></i><i></i></div>
      <div class="sp-mchart-bars" role="group" aria-label="${esc(ymLabel(series.activeMonth))}每日评测柱状图">${cols}</div>
    </div>
  </div>`;
}

export function dateDetailHTML(rec, modelName = "__all__", prevDate = "", nextDate = "") {
  if (!rec) return "";
  const inTr = Number(rec.input_traces) || 0;
  const inSess = Number(rec.input_sessions) || 0;
  const attrTr = Number(rec.attr_traces) || 0;
  const compTr = rec.hasCompact ? Number(rec.compact) || 0 : null;
  const remTr = rec.remaining_traces != null ? Math.max(0, Number(rec.remaining_traces) || 0) : Math.max(0, inTr - attrTr);
  const reevTr = Number(rec.reeval_remaining) || 0;
  const isPureReeval = remTr > 0 && reevTr >= remTr;
  const pendShort = isPureReeval ? "待重评" : "待测";
  const pendTitle = isPureReeval ? "待重评" : "待评测";
  const aRatio = inTr > 0 ? Math.min(1, attrTr / inTr) : 0;
  const cRatio = inTr > 0 && compTr != null ? Math.min(1, compTr / inTr) : null;
  const outerRatio = cRatio != null ? cRatio : aRatio;
  const outerCls = cRatio != null ? "is-comp" : "is-attr";
  const outOff = (DETAIL_OUT_C * (1 - outerRatio)).toFixed(2);
  const inOff = (DETAIL_IN_C * (1 - aRatio)).toFixed(2);
  const done = inTr > 0 && remTr === 0;
  const pctStr = inTr > 0 ? (done ? "100%" : `${(aRatio * 100).toFixed(1)}%`) : "—";
  const compPctStr = cRatio != null ? `${(cRatio * 100).toFixed(1)}%` : "";

  const modelList = modelName === "__all__" && (rec.models || []).length > 1
    ? `<div class="sp-dd-models">
        ${rec.models.map((m) => {
          const r = m.input_traces > 0 ? Math.min(1, m.attr_traces / m.input_traces) : 0;
          return `<button type="button" class="sp-dd-mrow" data-sp-model="${esc(m.name)}">
            <span class="sp-dd-mname">${esc(m.name)}</span>
            <span class="sp-dd-mbar"><i style="width:${(r * 100).toFixed(1)}%"></i></span>
            <b class="num">${m.input_traces ? pct(m.attr_traces, m.input_traces, 0) : "—"}</b>
          </button>`;
        }).join("")}
      </div>`
    : "";

  return `<div class="sp-dd-head">
      <div class="sp-dd-title">
        <b class="num">${esc(rec.date)}</b>
        <span class="sp-rc-tag${done ? " is-done" : ""}">${done ? "已完成" : `${pendShort} ${num(remTr)}`}</span>
      </div>
      <div class="sp-dd-actions">
        <button type="button" class="sp-mnav-btn" data-sp-day="${esc(prevDate)}"${prevDate ? "" : " disabled"} aria-label="前一天">‹</button>
        <button type="button" class="sp-mnav-btn" data-sp-day="${esc(nextDate)}"${nextDate ? "" : " disabled"} aria-label="后一天">›</button>
        <button type="button" class="sp-dd-close" id="spDateClose" aria-label="关闭详情">×</button>
      </div>
    </div>
    <div class="sp-dd-ring-wrap">
      <div class="sp-dd-ring" role="img" aria-label="${esc(rec.date)} 评测完成度环形图">
        <svg viewBox="0 0 144 144" aria-hidden="true">
          <g transform="rotate(-90 72 72)">
            <circle class="sp-dd-track" cx="72" cy="72" r="62"/>
            <circle class="sp-dd-arc ${outerCls}" cx="72" cy="72" r="62" stroke-dasharray="${DETAIL_OUT_C.toFixed(2)}" stroke-dashoffset="${outOff}"/>
            ${cRatio != null ? `<circle class="sp-dd-track" cx="72" cy="72" r="51"/><circle class="sp-dd-arc is-attr" cx="72" cy="72" r="51" stroke-dasharray="${DETAIL_IN_C.toFixed(2)}" stroke-dashoffset="${inOff}"/>` : ""}
          </g>
        </svg>
        <div class="sp-dd-center">
          <b class="num">${esc(pctStr)}</b>
          <span>已评测</span>
        </div>
      </div>
      <div class="sp-dd-legend num">
        ${cRatio != null ? `<span><i class="is-comp"></i>压缩 <b>${esc(compPctStr)}</b></span><span><i class="is-attr"></i>评测 <b>${esc(pctStr)}</b></span>` : `<span><i class="is-attr"></i>已评测占比</span>`}
      </div>
    </div>
    <div class="sp-dd-grid">
      <div class="sp-dd-kv"><span>评测输入</span><b class="num">${num(inTr)}</b><small class="num">${num(inSess)} sess</small></div>
      <div class="sp-dd-kv"><span>已完成评测</span><b class="num is-attr">${num(attrTr)}</b><small class="num">${inTr ? pct(attrTr, inTr, 1) : "—"}</small></div>
      <div class="sp-dd-kv"><span>已完成压缩</span><b class="num is-comp">${compTr != null ? num(compTr) : "—"}</b><small class="num">${cRatio != null ? pct(Math.min(inTr, compTr), inTr, 1) : "—"}</small></div>
      <div class="sp-dd-kv"><span>${pendTitle}</span><b class="num">${num(remTr)}</b><small>${done ? "已全部完成" : "trace"}</small></div>
    </div>
    ${modelList}`;
}

function renderDateBoard(root, data) {
  const series = buildMonthlySeries(data, S.selectedModel, S.selectedMonth);
  S.selectedModel = series.model;
  S.selectedMonth = series.activeMonth;
  if (S.selectedDate && !series.byDate.has(S.selectedDate)) {
    S.selectedDate = "";
  }
  setHTML(root, "spMonthBar", monthBarHTML(series));
  setHTML(root, "spDateChart", dateChartHTML(series, S.selectedDate));
  const stage = $("#spDateStage", root);
  const detail = $("#spDateDetail", root);
  if (S.selectedDate && series.byDate.has(S.selectedDate)) {
    const rec = series.byDate.get(S.selectedDate);
    const idx = series.allDates.indexOf(S.selectedDate);
    const prevDate = idx > 0 ? series.allDates[idx - 1] : "";
    const nextDate = idx >= 0 && idx < series.allDates.length - 1 ? series.allDates[idx + 1] : "";
    setHTML(root, "spDateDetail", dateDetailHTML(rec, series.model, prevDate, nextDate));
    if (detail) detail.hidden = false;
    stage?.classList?.add("has-detail");
  } else {
    if (detail) {
      detail.hidden = true;
      setHTML(root, "spDateDetail", "");
    }
    stage?.classList?.remove("has-detail");
  }
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

export function buildPgSpeedSamples(series, range, nowTs, mode = "eval_cluster") {
  const now = Number(nowTs) || Math.floor(Date.now() / 1000);
  const step = range <= 600 ? 60 : range <= 3600 ? 60 : range <= 21600 ? 300 : range <= 86400 ? 900 : 1800;
  const alignedEnd = Math.floor(now / step) * step;
  const count = Math.max(2, Math.round(range / step));
  const start = alignedEnd - count * step;
  const bins = Array.from({ length: count + 1 }, (_, i) => ({
    t: start + i * step,
    c1: 0,
    c2: 0,
    v1: 0,
    v2: 0,
  }));
  const isAttrComp = mode === "attr_compact";
  for (const row of series || []) {
    const ts = Number(row[0]) || 0;
    if (ts < start || ts > alignedEnd + step) continue;
    const idx = Math.max(0, Math.min(count, Math.floor((ts - start) / step)));
    const ea = Number(row[1]) || 0;
    const ec = Number(row[2]) || 0;
    const ct = Number(row[3]) || 0;
    bins[idx].c1 += ea;
    bins[idx].c2 += isAttrComp ? ec : ct;
  }
  const perMin = step / 60;
  for (const b of bins) {
    b.v1 = b.c1 / perMin;
    b.v2 = b.c2 / perMin;
  }
  return { samples: bins, now: alignedEnd, step };
}

export function buildPgRpmSamples(rpmHistory, range, nowTs) {
  const now = Number(nowTs) || Math.floor(Date.now() / 1000);
  const step = range <= 600 ? 60 : range <= 3600 ? 60 : range <= 21600 ? 300 : range <= 86400 ? 900 : 1800;
  const curBucket = Math.floor(now / step) * step;
  const rows = rpmHistory || [];
  const hasCur = rows.some((r) => (Number(r[0]) || 0) >= curBucket && (Number(r[1]) || 0) > 0);
  const alignedEnd = hasCur || (now - curBucket) >= step * 0.85 ? curBucket : curBucket - step;
  const count = Math.max(2, Math.round(range / step));
  const start = alignedEnd - count * step;
  const bins = Array.from({ length: count + 1 }, (_, i) => ({
    t: start + i * step,
    reqs: 0,
    pa: 0,
    pc: 0,
    v1: 0,
    v2: 0,
  }));
  for (const row of rows) {
    const ts = Number(row[0]) || 0;
    if (ts < start || ts >= alignedEnd + step) continue;
    const idx = Math.max(0, Math.min(count, Math.floor((ts - start) / step)));
    bins[idx].reqs += Number(row[1]) || 0;
    bins[idx].pa += Number(row[2]) || 0;
    bins[idx].pc += Number(row[3]) || 0;
  }
  const perMin = step / 60;
  for (const b of bins) {
    b.v1 = b.reqs / perMin;
    b.pa = b.pa / perMin;
    b.pc = b.pc / perMin;
  }
  return { samples: bins, now: alignedEnd, step };
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
  const isPg = S.data?.mode === "pg" && Boolean(S.data?.pg_pipeline);
  const isRpm = S.chartMode === "rpm";
  const isPgAttrComp = isPg && S.chartMode === "attr_compact";
  const quota = S.data?.gateways?.rpm_limit || null;

  if (legend) {
    if (isRpm) {
      legend.innerHTML = `<span style="--c:var(--accent)"><i></i>网关 RPM</span>${quota ? `<span class="is-dashed" style="--c:var(--sev-2)"><i></i>配额 ${num(quota)} RPM</span>` : ""}`;
    } else if (isPg) {
      legend.innerHTML = isPgAttrComp
        ? `<span style="--c:var(--accent)"><i></i>归因 (条/分)</span><span style="--c:var(--loc-vir)"><i></i>压缩 (条/分)</span>`
        : `<span style="--c:var(--accent)"><i></i>评测速度 (条/分)</span><span style="--c:var(--loc-ulq)"><i></i>聚类速度 (条/分)</span>`;
    } else {
      legend.innerHTML = `<span style="--c:var(--accent)"><i></i>Attribution</span><span style="--c:var(--loc-vir)"><i></i>Compact</span>`;
    }
  }

  const built = isRpm
    ? (isPg
      ? buildPgRpmSamples(S.data?.rpm_history || [], S.range, S.data.pg_pipeline.now_epoch)
      : buildRpmSamples(S.data?.rpm_history || [], S.range))
    : (isPg
      ? buildPgSpeedSamples(S.data.pg_pipeline.series || [], S.range, S.data.pg_pipeline.now_epoch, isPgAttrComp ? "attr_compact" : "eval_cluster")
      : buildLandingSamples(S.data?.history || [], S.data?.rpm_history || [], S.range));
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

  const line2Cls = isPg && !isPgAttrComp ? "sp-line-cl" : "sp-line-comp";
  const area2Cls = isPg && !isPgAttrComp ? "sp-area-cl" : "sp-area-comp";
  const pt2Cls = isPg && !isPgAttrComp ? "sp-point-cl" : "sp-point-comp";
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
        area2.setAttribute("class", `sp-area ${area2Cls}`);
        area2.setAttribute("d", `${p2}L${xEnd},${baseY}L${xBegin},${baseY}Z`);
      }
    }
  } else {
    area1.setAttribute("d", "");
    if (area2) area2.setAttribute("d", "");
  }
  line2.setAttribute("class", `sp-line ${line2Cls}`);
  line2.setAttribute("d", isRpm ? "" : linePath("v2"));

  const last = samples[samples.length - 1];
  const dots = isRpm ? [[last.v1, "sp-point-rpm"]] : [[last.v1, "sp-point-attr"], [last.v2, pt2Cls]];
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
  const isPg = S.data?.mode === "pg" && Boolean(S.data?.pg_pipeline);
  const quota = S.data?.gateways?.rpm_limit;
  let html;
  if (S.chartMode === "rpm") {
    html = `<div class="t-head">${esc(d)}</div>
       <div class="t-row"><span>网关 RPM</span><b class="num">${rate(best.v1)} RPM</b></div>
       ${quota ? `<div class="t-row"><span>利用率</span><b class="num">${pct(best.v1, quota, 1)}</b></div>` : ""}
       <div class="t-row"><span>${isPg ? "评测 / 压缩" : "在途 Attr / Compact"}</span><b class="num">${rate(best.pa)} / ${rate(best.pc)} 条/分</b></div>`;
  } else if (isPg) {
    const isAttrComp = S.chartMode === "attr_compact";
    html = isAttrComp
      ? `<div class="t-head">${esc(d)}</div>
         <div class="t-row"><span>归因速度</span><b class="num">${rate(best.v1)} 条/分</b></div>
         <div class="t-row"><span>压缩速度</span><b class="num">${rate(best.v2)} 条/分</b></div>
         <div class="t-row"><span>时段新增</span><b class="num">${num(best.c1)} / ${num(best.c2)}</b></div>`
      : `<div class="t-head">${esc(d)}</div>
         <div class="t-row"><span>评测速度</span><b class="num">${rate(best.v1)} 条/分</b></div>
         <div class="t-row"><span>聚类速度</span><b class="num">${rate(best.v2)} 条/分</b></div>
         <div class="t-row"><span>时段新增</span><b class="num">${num(best.c1)} / ${num(best.c2)}</b></div>`;
  } else {
    html = `<div class="t-head">${esc(d)}</div>
       <div class="t-row"><span>Attribution</span><b class="num">${rate(best.v1)} 条/分</b></div>
       <div class="t-row"><span>Compact</span><b class="num">${rate(best.v2)} 条/分</b></div>
       <div class="t-row"><span>累计</span><b class="num">${num(best.a)} / ${num(best.c)}</b></div>`;
  }
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
  const isPg = S.data.mode === "pg";
  const d = Math.max(0, Math.round(Number(evt.delta) || 0));
  if (d <= 0) return 0;
  if (evt.kind === "attr") {
    if (!S.evalRunning) return 0;
    const cap = S.simMaxCarry > 0 ? S.simMaxCarry : 30;
    const baseRem = Number(S.data.remaining_traces) || 0;
    const remainSpace = inTr > 0 ? Math.max(0, inTr - S.shownAttrTraces) : baseRem;
    const allowed = Math.max(0, Math.min(d, cap - S.simAttrCarry, remainSpace));
    if (allowed <= 0) return 0;
    S.simAttrCarry += allowed;
    S.shownAttrTraces = Math.min(inTr || Infinity, S.shownAttrTraces + allowed);
    S.shownPendingTraces = Math.max(0, S.shownAttrTraces - S.shownClusterTraces);
    const attrRatio = inTr > 0 ? Math.min(1, S.shownAttrTraces / inTr) : 0;
    const clInRatio = inTr > 0 ? Math.min(attrRatio, S.shownClusterTraces / inTr) : 0;
    const liveRemTr = Math.max(0, baseRem - S.simAttrCarry);
    const remSess = Number(S.data.remaining_sessions) || 0;
    setText(root, "spAttrTraces", num(S.shownAttrTraces));
    setText(root, "spAttrPct", inTr
      ? (liveRemTr > 0 ? `${S.pendWord} ${num(liveRemTr)}` : "已全部评测")
      : "—");
    setText(root, "spClusterPct", inTr
      ? (S.shownPendingTraces > 0 ? `待聚类 ${num(S.shownPendingTraces)}` : "已全部聚类")
      : "—");
    setText(root, "spEtaSub", isPg
      ? `${S.pendWord} ${num(liveRemTr)} · 待聚类 ${num(S.shownPendingTraces)}`
      : `剩余 ${num(liveRemTr)} trace · ${num(remSess)} session`);
    setRing($("#spRingAttr", root), RING_OUT_C, attrRatio);
    setText(root, "spRingPct", inTr ? `${(attrRatio * 100).toFixed(1)}%` : "—");
    spawnDanmu(root, "spAttrTraces", `+${num(allowed)}`, { tone: "attr" });
    const activePill = $(".sp-model-pill.is-active-model", root) || $(".sp-model-pill[data-sp-mattr]", root);
    if (activePill) {
      const mIn = Number(activePill.dataset.spMin) || 0;
      const nextAttr = Math.min(mIn || Infinity, (Number(activePill.dataset.spMattr) || 0) + allowed);
      const nextRem = Math.max(0, (Number(activePill.dataset.spMrem) || 0) - allowed);
      activePill.dataset.spMattr = String(nextAttr);
      activePill.dataset.spMrem = String(nextRem);
      const pctEl = $("[data-sp-mpct]", activePill);
      if (pctEl && mIn > 0) pctEl.textContent = nextRem <= 0 ? "100%" : pct(nextAttr, mIn, 0);
    }
    return allowed;
  }
  if (evt.kind === "cluster") {
    if (!S.clusterRunning) return 0;
    const avail = Math.max(0, S.shownAttrTraces - S.shownClusterTraces);
    const allowed = Math.max(0, Math.min(d, avail));
    if (allowed <= 0) return 0;
    S.simClusterCarry += allowed;
    S.shownClusterTraces = Math.min(S.shownAttrTraces, S.shownClusterTraces + allowed);
    S.shownPendingTraces = Math.max(0, S.shownAttrTraces - S.shownClusterTraces);
    const attrRatio = inTr > 0 ? Math.min(1, S.shownAttrTraces / inTr) : 0;
    const clInRatio = inTr > 0 ? Math.min(attrRatio, S.shownClusterTraces / inTr) : 0;
    const liveRemTr = Math.max(0, (Number(S.data.remaining_traces) || 0) - S.simAttrCarry);
    setText(root, "spClusterTraces", num(S.shownClusterTraces));
    setText(root, "spClusterPct", inTr
      ? (S.shownPendingTraces > 0 ? `待聚类 ${num(S.shownPendingTraces)}` : "已全部聚类")
      : "—");
    if (isPg) setText(root, "spEtaSub", `${S.pendWord} ${num(liveRemTr)} · 待聚类 ${num(S.shownPendingTraces)}`);
    setRing($("#spRingCl", root), RING_IN_C, clInRatio);
    setText(root, "spRingClPct", inTr ? `聚类 ${(clInRatio * 100).toFixed(1)}%` : "聚类 —");
    spawnDanmu(root, "spClusterTraces", `+${num(allowed)}`, { tone: "cl" });
    const activePill = $(".sp-model-pill.is-active-model", root) || $(".sp-model-pill[data-sp-mcl]", root);
    if (activePill) {
      activePill.dataset.spMcl = String((Number(activePill.dataset.spMcl) || 0) + allowed);
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
    S.evalRunning = false;
    S.clusterRunning = false;
    S.pendWord = "待评测";
    S.prevInputTraces = null;
    S.prevInputSessions = null;
    S.prevAttrTraces = null;
    S.prevClusterTraces = null;
    S.prevPendingTraces = null;
    S.prevRawAttrTraces = null;
    S.prevRawClusterTraces = null;
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
  S.evalRunning = Boolean(ev.evalRunning);
  S.clusterRunning = Boolean(ev.clusterRunning);
  S.pendWord = ev.reeval ? "待重评" : "待评测";
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
  const isPg = data.mode === "pg" && Boolean(data.pg_pipeline);
  const pg = data.pg_pipeline || {};
  const attrRate = r.attr == null || (Number(r.attr) === 0 && Number(r.parts_attr) > 0) ? r.parts_attr : r.attr;
  const compactRate = r.compact == null || (Number(r.compact) === 0 && Number(r.parts_compact) > 0) ? r.parts_compact : r.compact;
  const evalFlowRate = isPg
    ? Number(pg.eval_rate_5m || 0)
    : ((Number(r.parts_attr) || 0) + (Number(r.parts_compact) || 0) || (Number(attrRate) || 0) + (Number(compactRate) || 0));
  const clusterFlowRate = isPg ? Number(pg.cluster_rate_5m || 0) : Number(r.cluster || 0);
  const evalFlowActive = ev.evalRunning && evalFlowRate >= 0.05;
  const clusterFlowActive = ev.clusterRunning && clusterFlowRate >= 0.05;

  const hasPrev = S.prevInputTraces != null;
  const attrDropped = S.prevRawAttrTraces != null && rawAttrTr < S.prevRawAttrTraces;
  const clDropped = S.prevRawClusterTraces != null && rawClTr < S.prevRawClusterTraces;
  const maxCarry = evalFlowActive
    ? Math.min(rawRemTr, Math.max(12, Math.round((evalFlowRate / 60) * 45)))
    : 0;
  S.simMaxCarry = maxCarry;
  if (isBrowser() && hasPrev && evalFlowActive && !attrDropped) {
    // 固定 4s 节拍负责实时推进，30s 轮询只与真实落盘对齐；若发生重评回落则立刻清零
    S.simAttrCarry = rawAttrTr >= S.shownAttrTraces
      ? 0
      : Math.min(maxCarry, Math.max(0, S.shownAttrTraces - rawAttrTr));
  } else {
    S.simAttrCarry = 0;
  }
  const nextAttr = Math.min(rawInTr || Infinity, rawAttrTr + S.simAttrCarry);
  if (isBrowser() && hasPrev && clusterFlowActive && !clDropped && !attrDropped) {
    S.simClusterCarry = rawClTr >= S.shownClusterTraces
      ? 0
      : Math.min(Math.max(0, nextAttr - rawClTr), Math.max(0, S.shownClusterTraces - rawClTr));
  } else {
    S.simClusterCarry = 0;
  }

  const inTr = rawInTr;
  const inSess = rawInSess;
  const attrTr = Math.min(inTr || Infinity, rawAttrTr + S.simAttrCarry);
  const clTr = Math.min(attrTr, rawClTr + S.simClusterCarry);
  const pendingTr = hasPrev && isBrowser() && (evalFlowActive || clusterFlowActive) && !attrDropped && !clDropped
    ? Math.max(0, attrTr - clTr)
    : rawPendingTr;
  const remTr = Math.max(0, rawRemTr - S.simAttrCarry);
  const attrRatio = inTr > 0 ? Math.min(1, attrTr / inTr) : 0;
  const clInRatio = inTr > 0 ? Math.min(attrRatio, clTr / inTr) : 0;

  const prevShownAttr = hasPrev ? S.shownAttrTraces : attrTr;
  const prevShownCluster = hasPrev ? S.shownClusterTraces : clTr;
  const deltaAttr = hasPrev && !attrDropped ? Math.max(0, attrTr - prevShownAttr) : 0;
  const deltaCluster = hasPrev && !clDropped ? Math.max(0, clTr - prevShownCluster) : 0;
  const numAttrRate = Number(attrRate) || 0;
  const numCompRate = Number(compactRate) || 0;
  const numGwRpm = Number(data.gateways?.realtime_rpm);

  S.prevInputTraces = inTr;
  S.prevInputSessions = inSess;
  S.prevAttrTraces = attrTr;
  S.prevClusterTraces = clTr;
  S.prevPendingTraces = pendingTr;
  S.prevRawAttrTraces = rawAttrTr;
  S.prevRawClusterTraces = rawClTr;
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
    ? (remTr > 0 ? `${S.pendWord} ${num(remTr)}` : "已全部评测")
    : "—");
  setText(root, "spClusterTraces", num(clTr));
  setText(root, "spClusterPct", inTr
    ? (pendingTr > 0 ? `待聚类 ${num(pendingTr)}` : "已全部聚类")
    : "—");
  setRing($("#spRingAttr", root), RING_OUT_C, attrRatio);
  setRing($("#spRingCl", root), RING_IN_C, clInRatio);
  setText(root, "spRingPct", inTr ? `${(attrRatio * 100).toFixed(1)}%` : "—");
  setText(root, "spRingClPct", inTr ? `聚类 ${(clInRatio * 100).toFixed(1)}%` : "聚类 —");

  const rateCard2 = $("#spRateCard2", root);
  const modeBtn3 = $("#spModeBtn3", root);
  if (isPg) {
    setText(root, "spRateTitle1", "评测速率");
    setText(root, "spRateTitle2", "聚类速率");
    if (rateCard2?.classList) {
      rateCard2.classList.remove("is-rate-comp");
      rateCard2.classList.add("is-rate-cl");
    }
    setText(root, "spModeBtn1", "评测与聚类");
    if (modeBtn3) modeBtn3.hidden = false;
    setText(root, "spModeBtn2", "网关 RPM");
    S.modeSeg?.set(S.chartMode, { silent: true });
    setText(root, "spAttrRate", rate(pg.eval_rate_5m));
    setText(root, "spCompactRate", rate(pg.cluster_rate_5m));
    setText(root, "spPartsAttrSub", `1h 均速 ${rate(pg.eval_rate_1h)} · 24h ${num(pg.eval_24h)}`);
    setText(root, "spPartsCompactSub", `1h 均速 ${rate(pg.cluster_rate_1h)} · 24h ${num(pg.cluster_24h)}`);
    const effEta = remTr > 0 ? data.eta_minutes : (pendingTr > 0 ? pg.cluster_eta_minutes : 0);
    setText(root, "spEta", etaLabel(effEta));
    setText(root, "spEtaSub", `${S.pendWord} ${num(remTr)} · 待聚类 ${num(pendingTr)}`);
    if (!S.userPickedRange) {
      const ser = pg.series || [];
      const nowEpoch = Number(pg.now_epoch) || Date.now() / 1000;
      const lastTs = ser.length ? Number(ser[ser.length - 1][0]) : 0;
      const age = lastTs ? Math.max(0, nowEpoch - lastTs) : Infinity;
      const ideal = age <= 300 ? 300 : age <= 3600 ? 3600 : age <= 21600 ? 21600 : 86400;
      if (S.range !== ideal) {
        S.range = ideal;
        S.rangeSeg?.set(String(ideal), { silent: true });
      }
    }
  } else {
    setText(root, "spRateTitle1", "归因速率");
    setText(root, "spRateTitle2", "压缩速率");
    if (rateCard2?.classList) {
      rateCard2.classList.remove("is-rate-cl");
      rateCard2.classList.add("is-rate-comp");
    }
    setText(root, "spModeBtn1", "落地速度");
    if (modeBtn3) modeBtn3.hidden = true;
    if (S.chartMode === "attr_compact") S.chartMode = "landing";
    setText(root, "spModeBtn2", "网关 RPM");
    S.modeSeg?.set(S.chartMode, { silent: true });
    setText(root, "spAttrRate", rate(attrRate));
    setText(root, "spCompactRate", rate(compactRate));
    setText(root, "spPartsAttrSub", `在途 ${rate(r.parts_attr)} 条/分钟`);
    setText(root, "spPartsCompactSub", `在途 ${rate(r.parts_compact)} 条/分钟`);
    setText(root, "spEta", etaLabel(data.eta_minutes));
    setText(root, "spEtaSub", `剩余 ${num(remTr)} trace · ${num(remSess)} session`);
  }
  renderTopGatewayCard(root, data.gateways);

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
    running: evalFlowActive || clusterFlowActive,
    evalRunning: evalFlowActive,
    clusterRunning: clusterFlowActive,
    evalRate: evalFlowRate,
    clusterRate: clusterFlowRate,
    rate: evalFlowRate + clusterFlowRate,
    deltaAttr,
    deltaCluster,
    windowMs: POLL_MS * 0.92,
    done: ev.key === "done",
  });

  if (isPg) renderPgSchedule(root, data);
  else renderGateways(root, data.gateways);
  renderDateBoard(root, data);
  setHTML(root, "spModels", modelRowsHTML(data, { attrCarry: S.simAttrCarry, clCarry: S.simClusterCarry, selectedModel: S.selectedModel }));

  // 克制弹幕：仅在核心两处总览数字（已完成评测、已聚类）+ 流水线待聚类池出现真实增长时弹出 +n
  if (deltaAttr > 0) spawnDanmu(root, "spAttrTraces", `+${num(deltaAttr)}`, { tone: "attr" });
  if (deltaCluster > 0) spawnDanmu(root, "spClusterTraces", `+${num(deltaCluster)}`, { tone: "cl" });

  drawChart(root);
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
      S.userPickedRange = true;
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
        if (el.dataset.tipHtml) return el.dataset.tipHtml;
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
      if (modelBtn && S.data) {
        S.selectedModel = modelBtn.dataset.spModel || "__all__";
        renderDateBoard(root, S.data);
        setHTML(root, "spModels", modelRowsHTML(S.data, { attrCarry: S.simAttrCarry, clCarry: S.simClusterCarry, selectedModel: S.selectedModel }));
        return;
      }
      const monthBtn = e.target.closest("[data-sp-month]");
      if (monthBtn && !monthBtn.disabled && S.data) {
        const ym = monthBtn.dataset.spMonth || "";
        if (ym) {
          S.selectedMonth = ym;
          if (S.selectedDate && !S.selectedDate.startsWith(`${ym}-`)) S.selectedDate = "";
          renderDateBoard(root, S.data);
        }
        return;
      }
      if (e.target.closest("#spDateClose")) {
        S.selectedDate = "";
        hideTip();
        if (S.data) renderDateBoard(root, S.data);
        return;
      }
      const dayBtn = e.target.closest("[data-sp-day]");
      if (dayBtn && !dayBtn.disabled && S.data) {
        const ds = dayBtn.dataset.spDay || "";
        if (!ds) return;
        const inDetail = Boolean(dayBtn.closest("#spDateDetail"));
        S.selectedDate = (!inDetail && S.selectedDate === ds) ? "" : ds;
        if (S.selectedDate) S.selectedMonth = S.selectedDate.slice(0, 7);
        hideTip();
        renderDateBoard(root, S.data);
      }
    });
    if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
      document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && S.selectedDate && S.root && document.documentElement?.dataset?.view === "speed") {
          S.selectedDate = "";
          if (S.data) renderDateBoard(S.root, S.data);
        }
      });
    }
  }
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
