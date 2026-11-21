import {
  $, $$, sevColor, esc, fmt, pct, compact, sum,
  runCounters, bindTips, segmented, getJSON, announce, copyText, flashCopy,
} from "./core.js";
import { sunburst } from "./sunburst.js";
import { renderContent } from "./render.js";

const SEVS_ALL = ["GOLD", "P0", "P1", "P2", "P3", "P4"];
const SEV_RANK = Object.fromEntries(["P0", "P1", "P2", "P3", "P4", "GOLD", "none"].map((k, i) => [k, i]));
const DIM_META = [
  { key: "day", label: "按天分布", audit: true },
  { key: "round", label: "对话轮数", audit: true },
  { key: "stage", label: "问题环节", audit: false },
  { key: "mechanism", label: "问题机制", audit: false },
  { key: "pattern", label: "具体问题", audit: false },
  { key: "turn_type", label: "单/多轮", audit: false },
  { key: "severity", label: "问题等级", audit: false },
];

const MODEL_LABEL = { aime_expert: "Expert", aime_fast: "Fast" };
const DEFAULT_STAGE_NAMES = {
  S1: "取数规划", S2: "检索规划", S3: "结构化取数", S4: "本地计算",
  S5: "网页检索", S6: "客服知识库", S7: "记忆", S8: "能力装载",
  S9: "答案合成", S10: "请求生成", S11: "图表与可视化", S12: "任务编排",
};
const DEFAULT_MECH_NAMES = {
  M1: "空转未执行", M2: "目标错配", M3: "执行失败", M4: "结果不可用",
  M5: "加工计算错误", M6: "无依据断言", M7: "交付不符",
};
const MECH_SHORT = {
  M1: "未执行", M2: "目标错配", M3: "执行失败", M4: "结果失效",
  M5: "加工计算", M6: "无据断言", M7: "交付不符",
};
const KIND_LABEL = {
  user_question: "用户提问",
  llm_turn: "模型思考与调度",
  tool_call: "工具调用",
  tool_result: "工具返回",
  final_answer: "最终回答",
};
const PATH_SRC_LABEL = {
  join: "聚类对齐",
  component: "组件映射",
  item_index: "聚类对齐",
  cluster: "聚类映射",
  rule: "规则映射",
  llm: "模型判别",
  none: "无需匹配",
};
const TOK_LABELS = {
  "<8k": "< 8K",
  "8-32k": "8K–32K",
  "32-64k": "32K–64K",
  "64-128k": "64K–128K",
  ">=128k": "≥ 128K",
  unknown: "未记录长度",
};
const ROUND_LABELS = {
  1: "单轮",
  "2-3": "2–3 轮",
  "4-10": "4–10 轮",
  "11+": "11 轮以上",
};
const POOL_ROLE_LABEL = { user: "用户", assistant: "助手", tool: "工具", system: "系统" };
const MECH_ORDER = ["M1", "M2", "M3", "M4", "M5", "M6", "M7"];
const MECH_PALETTE = [
  "var(--sev-1)", "var(--sev-2)", "var(--accent)",
  "var(--loc-vir)", "var(--loc-ulq)", "var(--sev-3)", "var(--muted)",
];

const EMPTY_FILTER = () => ({
  sev: "", l1: "", l2: "", l3: "", turn: "", tok: "", rnd: "",
  day: "", psrc: "", dupOnly: false, longOnly: false, q: "",
});

export const sevTone = (key) => (key === "GOLD" || key === "none" ? "var(--loc-ulq)" : sevColor(key));
export const sevLabel = (key) => (!key || key === "GOLD" || key === "none" ? "goldencase" : key);
const tierTagLabel = (n, isLong) => (isLong ? `长对话 ${n} 条` : `${fmt(n)} 条档`);

export function modelLabel(id) {
  return MODEL_LABEL[id] || id;
}

export function tokBucketKey(tokens) {
  const t = Number(tokens || 0);
  if (t <= 0) return "unknown";
  if (t < 8192) return "<8k";
  if (t < 32768) return "8-32k";
  if (t < 65536) return "32-64k";
  if (t < 131072) return "64-128k";
  return ">=128k";
}

export function roundBucketKey(turn, rnd) {
  const n = Number(rnd || 0);
  if (turn === "single" || n <= 1) return "1";
  if (n <= 3) return "2-3";
  if (n <= 10) return "4-10";
  return "11+";
}

function stageLabel(s, names) {
  if (!s || s === "NA") return "";
  return names?.[s] || DEFAULT_STAGE_NAMES[s] || s;
}

function mechLabel(m, names, short = false) {
  if (!m || m === "NA") return "";
  if (short && MECH_SHORT[m]) return MECH_SHORT[m];
  return names?.[m] || DEFAULT_MECH_NAMES[m] || m;
}

export function patternDisplayName(code, rowBucket, patNames, stageNames, mechNames) {
  if (!code || code === "NA") return "";
  const mapped = (patNames && patNames[code]) || (rowBucket && rowBucket !== code && rowBucket !== "NA" ? rowBucket : "");
  if (mapped) return mapped;
  const parts = String(code).split(".");
  if (parts.length >= 2) {
    return [stageLabel(parts[0], stageNames), mechLabel(parts[1], mechNames)].filter(Boolean).join(" · ");
  }
  return stageLabel(code, stageNames);
}

export function bucketLabel(dim, row, maps = {}) {
  const k = row?.key ?? "";
  const raw = row?.bucket && row.bucket !== k ? row.bucket : "";
  if (dim === "severity") return sevLabel(k);
  if (dim === "stage") return stageLabel(k, maps.stageNames);
  if (dim === "mechanism") return mechLabel(k, maps.mechNames);
  if (dim === "pattern") return patternDisplayName(k, raw, maps.patNames, maps.stageNames, maps.mechNames);
  if (dim === "turn_type") return k === "multi" ? "多轮对话" : "单轮对话";
  if (dim === "tokens") return TOK_LABELS[k] || raw || k;
  if (dim === "round") return ROUND_LABELS[k] || raw || k;
  if (dim === "pattern_source") return PATH_SRC_LABEL[k] || raw || k;
  return raw || k;
}

const EXPORT_ROLE_MAP = { user: "user", human: "user", assistant: "assistant", ai: "assistant" };

function extractExportMsgText(val) {
  if (typeof val === "string") return val.trim();
  if (Array.isArray(val)) {
    return val
      .map((item) => (typeof item === "string" ? item.trim() : extractExportMsgText(item?.text ?? item?.content ?? item?.value)))
      .filter(Boolean)
      .join("\n")
      .trim();
  }
  if (val && typeof val === "object") {
    return extractExportMsgText(val.text ?? val.content ?? val.user_question ?? "");
  }
  return "";
}

/** Build a clean 11-field flat Bench export record matching backend `format_export_case`. */
export function formatClientExportCase(c, maps = {}) {
  const src = c && typeof c === "object" ? c : {};
  const rawPool = Array.isArray(src.message_pool)
    ? src.message_pool
    : Array.isArray(src.history)
      ? src.history
      : Array.isArray(src.conversation)
        ? src.conversation
        : null;
  const turns = [];
  if (rawPool) {
    rawPool.forEach((m) => {
      if (!m || typeof m !== "object") return;
      const role = EXPORT_ROLE_MAP[String(m.role || "").trim().toLowerCase()];
      if (!role) return;
      const content = extractExportMsgText(m.content != null ? m.content : m.text);
      if (content) turns.push({ role, content });
    });
  }
  const curQ = String(src.question_full || src.question || "").trim();
  if (curQ) {
    const userSet = new Set(turns.filter((t) => t.role === "user").map((t) => t.content));
    const lastRole = turns.length ? turns[turns.length - 1].role : "";
    if (!turns.length || (lastRole !== "user" && !userSet.has(curQ))) {
      turns.push({ role: "user", content: curQ });
    }
  }
  const userTurns = turns.filter((t) => t.role === "user").length;
  const turnType = String(src.turn || "").toLowerCase() === "multi" || userTurns > 1 ? "multi" : "single";
  let turnCount = userTurns > 0 ? userTurns : turns.length ? 1 : 0;
  if (turnType === "multi" && turnCount <= 1 && !rawPool) {
    turnCount = Math.max(1, Number(src.session_round || src.turn_index || 1));
  }
  const pr = src.primary && typeof src.primary === "object" ? src.primary : {};
  const l1 = pr.l1 && pr.l1 !== "NA" ? String(pr.l1) : "";
  const l2 = pr.l2 && pr.l2 !== "NA" ? String(pr.l2) : "";
  const l3 = (pr.l3 || pr.path) && (pr.l3 || pr.path) !== "NA" ? String(pr.l3 || pr.path) : "";
  const sev = String(src.severity || "GOLD") || "GOLD";
  const stage = l1 ? stageLabel(l1, maps.stageNames) || l1 : "";
  const mechanism = l2 ? mechLabel(l2, maps.mechNames) || l2 : "";
  let problem = String(pr.label || "").trim();
  if (!problem && l3) {
    problem = patternDisplayName(l3, "", maps.patNames, maps.stageNames, maps.mechNames) || l3;
  }
  if (!problem && sev === "GOLD") problem = "goldencase";

  return {
    case_id: String(src.trace_id || ""),
    session_id: String(src.session_id || ""),
    turn_type: turnType,
    turn_count: turnCount,
    turns,
    model: String(src.model || ""),
    date: String(src.day || ""),
    severity: sev,
    stage,
    mechanism,
    problem,
  };
}

function svgDonutHTML(items, { size = 148, rOut = 64, rIn = 40, centerVal = "", centerSub = "", defaultVal = centerVal, defaultSub = centerSub } = {}) {
  const total = sum(items.map((x) => Math.max(0, Number(x.value || 0))));
  const cx = size / 2;
  const cy = size / 2;
  const r = (rOut + rIn) / 2;
  const ringW = Math.max(4, rOut - rIn);
  const activeItem = items.find((x) => x.active && Number(x.value || 0) > 0) || null;
  const showVal = activeItem?.centerVal ?? centerVal;
  const showSub = activeItem?.centerSub ?? centerSub;
  const midCls = `bn-pie-mid${activeItem ? " is-focus" : ""}`;
  const midStyle = activeItem?.color ? ` style="--c:${activeItem.color}"` : "";

  if (total <= 0) {
    return `<div class="bn-pie-box" style="width:${size}px;height:${size}px;--ring-w:${ringW}">
      <svg viewBox="0 0 ${size} ${size}" aria-hidden="true"><circle class="bn-ring-track" cx="${cx}" cy="${cy}" r="${r.toFixed(2)}"/></svg>
      <div class="${midCls}" data-default-val="${esc(defaultVal)}" data-default-sub="${esc(defaultSub)}"><b class="num">${esc(showVal)}</b><span>${esc(showSub)}</span></div>
    </div>`;
  }

  const nonZero = items.filter((x) => Number(x.value || 0) > 0);
  const gap = nonZero.length > 1 ? 0.9 : 0;
  let offset = 0;
  const arcs = nonZero
    .map((x, ai) => {
      const share = (Number(x.value) / total) * 100;
      const dash = nonZero.length > 1 ? Math.max(0.8, share - gap) : 100;
      const at = offset;
      offset += share;
      const cls = `bn-ring-arc${x.active ? " is-active" : activeItem ? " is-dim" : ""}`;
      const interactiveAttrs = x.attr
        ? `${x.attr} tabindex="0" role="button" aria-pressed="${Boolean(x.active)}" data-ring-val="${esc(x.centerVal ?? "")}" data-ring-sub="${esc(x.centerSub ?? "")}" data-ring-color="${esc(x.color)}"`
        : "";
      return `<circle class="${cls}" cx="${cx}" cy="${cy}" r="${r.toFixed(2)}" pathLength="100" style="--c:${x.color};--ri:${ai};stroke:${x.color};stroke-dasharray:${dash.toFixed(2)} ${(100 - dash).toFixed(2)};stroke-dashoffset:${(-at).toFixed(2)}" ${interactiveAttrs} data-tip="${esc(x.tip || "")}"/>`;
    })
    .join("");

  return `<div class="bn-pie-box" style="width:${size}px;height:${size}px;--ring-w:${ringW}">
    <svg viewBox="0 0 ${size} ${size}" role="img" aria-label="${esc(defaultSub || "占比环形图")}">
      <circle class="bn-ring-track" cx="${cx}" cy="${cy}" r="${r.toFixed(2)}"/>
      ${arcs}
    </svg>
    <div class="${midCls}"${midStyle} data-default-val="${esc(defaultVal)}" data-default-sub="${esc(defaultSub)}"><b class="num">${esc(showVal)}</b><span>${esc(showSub)}</span></div>
  </div>`;
}

function sortedTiers(obj) {
  return Object.keys(obj || {})
    .map((k) => Number(k))
    .filter((n) => Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b);
}

function quant(arr, q) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((s.length - 1) * q))] || 0;
}

/* Aggregate missing dims / crosstab / severity dynamically from cases when backend omits precomputed summaries. */
export function deriveTierFromCases(cases, tierN, poolStats, params, taxonomy) {
  const actual = cases.length;
  const poolSize = Number(poolStats?.pool_size || 0);
  const stageMap = new Map();
  (taxonomy?.stages || []).forEach((s) => { if (s.id && s.id !== "NA") stageMap.set(s.id, s.name); });
  Object.entries(DEFAULT_STAGE_NAMES).forEach(([id, name]) => { if (!stageMap.has(id)) stageMap.set(id, name); });

  const mechIds = [...MECH_ORDER];
  const sevActual = Object.fromEntries(SEVS_ALL.map((s) => [s, 0]));
  const turnActual = { single: 0, multi: 0 };
  const stageActual = {};
  const mechActual = {};
  const ctRows = {};
  const sevCells = {};
  const ctTotals = { ...Object.fromEntries(mechIds.map((m) => [m, 0])), bench_total: 0, pool_total: poolSize };

  for (const [sid] of stageMap) {
    ctRows[sid] = { ...Object.fromEntries(mechIds.map((m) => [m, 0])), bench_total: 0, pool_total: 0 };
  }

  const dimCount = {};
  const incDim = (d, k) => {
    if (!dimCount[d]) dimCount[d] = new Map();
    dimCount[d].set(k, (dimCount[d].get(k) || 0) + 1);
  };

  const poolDims = poolStats?.dims || {};
  (poolDims.stage || []).forEach((pr) => {
    const sk = pr?.key;
    if (sk && ctRows[sk]) ctRows[sk].pool_total = Number(pr.count || 0);
  });

  let withTool = 0;
  let latSum = 0;
  let dupGe2 = 0;
  const toks = [];

  cases.forEach((c) => {
    const sev = c.severity || "GOLD";
    sevActual[sev] = (sevActual[sev] || 0) + 1;
    const t = c.turn === "multi" ? "multi" : "single";
    turnActual[t] += 1;
    const l1 = c.primary?.l1 && c.primary.l1 !== "NA" ? c.primary.l1 : "";
    const l2 = c.primary?.l2 && c.primary.l2 !== "NA" ? c.primary.l2 : "";
    const l3 = c.primary?.l3 && c.primary.l3 !== "NA" ? c.primary.l3 : "";
    if (l1) {
      stageActual[l1] = (stageActual[l1] || 0) + 1;
      if (!ctRows[l1]) ctRows[l1] = { ...Object.fromEntries(mechIds.map((m) => [m, 0])), bench_total: 0, pool_total: 0 };
      if (l2) {
        ctRows[l1][l2] = (ctRows[l1][l2] || 0) + 1;
        ctRows[l1].bench_total += 1;
        ctTotals[l2] = (ctTotals[l2] || 0) + 1;
        ctTotals.bench_total += 1;
      }
    }
    if (l2) mechActual[l2] = (mechActual[l2] || 0) + 1;
    if (l1 && l2 && (sev === "P0" || sev === "P1")) {
      const ck = `${l1}.${l2}`;
      if (!sevCells[ck]) sevCells[ck] = { P0: 0, P1: 0 };
      sevCells[ck][sev] += 1;
    }

    const totalTok = Number(c.stats?.total_tokens || 0);
    toks.push(totalTok);
    if ((c.stats?.tool_count || 0) > 0) withTool += 1;
    latSum += Number(c.stats?.latency || 0);
    if ((c.stats?.dup_question || 1) >= 2) dupGe2 += 1;

    incDim("severity", sev);
    incDim("turn_type", t);
    if (l1) incDim("stage", l1);
    if (l2) incDim("mechanism", l2);
    if (l3) incDim("pattern", l3);
    incDim("day", c.day || "");
    incDim("round", roundBucketKey(t, c.session_round));
  });

  const stagePoolSum = Object.values(ctRows).reduce((s, r) => s + Number(r.pool_total || 0), 0);
  if (stagePoolSum > 0) ctTotals.pool_total = stagePoolSum;
  const defectTotal = ctTotals.bench_total;

  const dims = {};
  const byDesignSet = new Set(DIM_META.filter((d) => !d.audit).map((d) => d.key));
  const coverage = [];
  const tol = Number(params.tolerance_pp ?? 10.0);

  DIM_META.forEach(({ key: dim }) => {
    const cmap = dimCount[dim] || new Map();
    const poolList = poolDims[dim] || [];
    const poolByKey = new Map(poolList.map((r) => [r.key, r]));
    const keys = poolList.length
      ? [...new Set([...poolList.map((r) => r.key), ...cmap.keys()])]
      : [...cmap.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
    const skipNA = dim === "stage" || dim === "mechanism" || dim === "pattern";
    const denom = skipNA ? defectTotal : actual;

    dims[dim] = keys.filter((k) => k !== "" && (!skipNA || k !== "NA")).map((k) => {
      const pr = poolByKey.get(k);
      const cnt = cmap.get(k) || 0;
      const sb = denom ? cnt / denom : 0;
      const sp = pr ? Number(pr.share ?? (poolSize ? (pr.count || 0) / poolSize : 0)) : 0;
      return {
        key: k,
        bucket: pr?.bucket || stageMap.get(k) || k,
        count: cnt,
        share_in_bench: sb,
        share_in_pool: sp,
        delta_pp: +((sb - sp) * 100).toFixed(2),
      };
    });

    const maxAbs = dims[dim].reduce((m, r) => Math.max(m, Math.abs(r.delta_pp)), 0);
    const byDesign = byDesignSet.has(dim);
    coverage.push({
      dim,
      max_abs_delta_pp: +maxAbs.toFixed(2),
      n_keys: dims[dim].length,
      n_keys_missing: dims[dim].filter((r) => r.count === 0).length,
      tolerance_pp: tol,
      by_design: byDesign,
      ok: byDesign ? true : maxAbs <= tol,
    });
  });

  const gTarget = Math.round(tierN * (params.golden_share ?? 0.2));
  const p0Max = Math.round(tierN * (params.p0_cap ?? 0.25));
  const rem = Math.max(0, tierN - gTarget - p0Max);
  const pRat = params.p_ratio || { P1: 0.4, P2: 0.3, P3: 0.2, P4: 0.1 };
  const nzToks = toks.filter((x) => x > 0);

  return {
    requested: tierN,
    actual,
    shortfall: Math.max(0, tierN - actual),
    pool: poolSize,
    severity_target: {
      GOLD: gTarget, P0: p0Max,
      P1: Math.round(rem * pRat.P1), P2: Math.round(rem * pRat.P2),
      P3: Math.round(rem * pRat.P3), P4: Math.round(rem * pRat.P4),
    },
    severity_actual: sevActual,
    stage_actual: stageActual,
    mechanism_actual: mechActual,
    turn_actual: turnActual,
    tokens: { p50: quant(toks, 0.5), p90: quant(toks, 0.9), p99: quant(toks, 0.99) },
    extra: {
      with_tool_rate: actual ? withTool / actual : 0,
      avg_latency: actual ? +(latSum / actual).toFixed(1) : 0,
      dup_ge2_count: dupGe2,
      known_tokens_p50: quant(nzToks, 0.5),
      known_tokens_p90: quant(nzToks, 0.9),
    },
    dims,
    coverage,
    crosstab: {
      stages: [...stageMap.keys()],
      stage_names: Object.fromEntries(stageMap),
      mechanisms: mechIds,
      rows: ctRows,
      totals: ctTotals,
      sev_cells: sevCells,
    },
  };
}

export function normalizeBenchPayload(raw, taxonomy) {
  const m = raw?.manifest || {};
  const p = m.params || {};
  const params = {
    golden_share: p.golden_share ?? 0.2,
    p0_cap: p.p0_cap ?? 0.25,
    p_ratio: p.p_ratio || { P1: 0.4, P2: 0.3, P3: 0.2, P4: 0.1 },
    turn_target: p.turn_target || { single: 0.75, multi: 0.25 },
    long_tokens: p.long_tokens ?? 65536,
    long_share: p.long_share ?? 0.02,
    tolerance_pp: p.tolerance_pp ?? 10.0,
    tiers: p.tiers || [500, 1000, 5000, 10000],
    long_tiers: p.long_tiers || [10, 20, 100, 200],
  };

  const models = {};
  Object.entries(raw?.models || {}).forEach(([id, md]) => {
    const stdKeys = sortedTiers(md?.tiers);
    const lngKeys = sortedTiers(md?.long_tiers);
    models[id] = {
      id,
      label: modelLabel(id),
      pool_size: Number(md?.pool_size ?? md?.pool_stats?.pool_size ?? 0),
      base_pool: Number(md?.base_pool ?? Math.max(0, (md?.pool_size || 0) - (md?.long_pool || 0))),
      long_pool: Number(md?.long_pool ?? 0),
      pool_daily: Array.isArray(md?.pool_daily) ? md.pool_daily : [],
      pool_stats: md?.pool_stats || {},
      tiers: md?.tiers || {},
      long_tiers: md?.long_tiers || {},
      stdKeys: stdKeys.length ? stdKeys : params.tiers,
      longKeys: lngKeys.length ? lngKeys : params.long_tiers,
    };
  });

  const stageNames = { ...DEFAULT_STAGE_NAMES, ...(raw?.stage_names || {}) };
  (taxonomy?.stages || []).forEach((s) => { if (s.id && s.name) stageNames[s.id] = s.name; });
  const mechNames = { ...DEFAULT_MECH_NAMES, ...(raw?.mech_names || {}) };
  (taxonomy?.mechanisms || []).forEach((mc) => { if (mc.id && mc.name) mechNames[mc.id] = mc.name; });
  const patNames = { ...(raw?.pat_names || {}) };
  Object.entries(taxonomy?.patterns || {}).forEach(([k, v]) => {
    if (v?.name) patNames[k] = v.name;
  });

  return {
    schema: 2,
    product: raw?.product || "aime",
    generated_at: raw?.generated_at || "",
    manifest: { ...m, params },
    models,
    modelOrder: (p.models || []).filter((id) => models[id]).concat(Object.keys(models).filter((id) => !(p.models || []).includes(id))),
    stageNames,
    mechNames,
    patNames,
  };
}

const ISO_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const BN_WEEKDAYS = ["一", "二", "三", "四", "五", "六", "日"];
const BN_CHEVRON_L = `<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M10 3.5L5.5 8 10 12.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const BN_CHEVRON_R = `<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M6 3.5L10.5 8 6 12.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const BN_CLOSE_X = `<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`;

function shiftYm(ym, deltaMonths) {
  const [y, m] = String(ym || "").split("-").map(Number);
  if (!Number.isFinite(y) || !Number.isFinite(m)) return ym;
  const d = new Date(Date.UTC(y, m - 1 + deltaMonths, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function compactPlus(n) {
  const v = Math.round(Number(n) || 0);
  if (v <= 0) return "";
  if (v >= 10000) return `+${(v / 10000).toFixed(1)}w`;
  if (v >= 1000) return `+${(v / 1000).toFixed(1)}k`;
  return `+${v}`;
}

function signedDelta(n) {
  const v = Math.round(Number(n) || 0);
  if (v > 0) return `+${fmt(v)}`;
  if (v < 0) return `-${fmt(Math.abs(v))}`;
  return "0";
}

/* Merge daily pool_daily, pool_stats.dims.day and tierData.dims.day into a cumulative dynamic timeline. */
export function buildBenchDailyModel(md, tierData) {
  const rawPoolMap = new Map();
  (md?.pool_daily || []).forEach((r) => {
    const k = String(r?.key || "").slice(0, 10);
    if (ISO_DAY_RE.test(k)) rawPoolMap.set(k, Number(r.count || 0));
  });
  const usableMap = new Map();
  (md?.pool_stats?.dims?.day || []).forEach((r) => {
    const k = String(r?.key || "").slice(0, 10);
    if (ISO_DAY_RE.test(k)) usableMap.set(k, Number(r.count || 0));
  });
  const benchMap = new Map();
  (tierData?.dims?.day || []).forEach((r) => {
    const k = String(r?.key || "").slice(0, 10);
    if (ISO_DAY_RE.test(k)) benchMap.set(k, Number(r.count || 0));
  });

  const hasRawPool = rawPoolMap.size > 0;
  const allDates = [...new Set([...rawPoolMap.keys(), ...usableMap.keys(), ...benchMap.keys()])].sort();
  let poolCum = 0;
  let usableCum = 0;
  let benchCum = 0;
  let prevPool = null;
  let prevBench = null;
  const days = [];
  const byDate = new Map();

  for (const date of allDates) {
    const usableAdded = usableMap.get(date) || 0;
    const poolAdded = hasRawPool ? (rawPoolMap.get(date) || 0) : usableAdded;
    const benchAdded = benchMap.get(date) || 0;
    poolCum += poolAdded;
    usableCum += usableAdded;
    benchCum += benchAdded;
    const rec = {
      date,
      poolAdded,
      usableAdded,
      benchAdded,
      poolCum,
      usableCum,
      benchCum,
      poolDelta: prevPool == null ? 0 : poolAdded - prevPool,
      benchDelta: prevBench == null ? 0 : benchAdded - prevBench,
    };
    prevPool = poolAdded;
    prevBench = benchAdded;
    days.push(rec);
    byDate.set(date, rec);
  }

  const months = [...new Set(days.map((d) => d.date.slice(0, 7)))].sort();
  const tail7 = days.slice(-7);
  return {
    days,
    byDate,
    months,
    hasRawPool,
    latestDay: days[days.length - 1] || null,
    firstDay: days[0] || null,
    last7Pool: tail7.reduce((s, d) => s + d.poolAdded, 0),
    last7Bench: tail7.reduce((s, d) => s + d.benchAdded, 0),
    maxPoolAdded: Math.max(1, ...days.map((d) => d.poolAdded)),
    maxBenchAdded: Math.max(1, ...days.map((d) => d.benchAdded)),
    totalPoolCum: poolCum,
    totalBenchCum: benchCum,
  };
}

export function caseMatchesFilter(c, f, longThreshold = 65536) {
  if (!c) return false;
  if (f.sev && c.severity !== f.sev) return false;
  const p = c.primary || {};
  if (f.l1 && (p.l1 || "NA") !== f.l1) return false;
  if (f.l2 && (p.l2 || "NA") !== f.l2) return false;
  if (f.l3 && (p.l3 || "NA") !== f.l3) return false;
  if (f.turn && c.turn !== f.turn) return false;
  const st = c.stats || {};
  const mt = c.meta || {};
  if (f.tok && tokBucketKey(st.total_tokens) !== f.tok) return false;
  if (f.rnd && roundBucketKey(c.turn, c.session_round) !== f.rnd) return false;
  if (f.day && c.day !== f.day) return false;
  if (f.psrc && (p.path_source || "none") !== f.psrc) return false;
  if (f.dupOnly && (st.dup_question || 1) < 2) return false;
  if (f.longOnly && (st.total_tokens || 0) < longThreshold) return false;
  if (f.q) {
    const q = f.q.toLowerCase();
    const hay = [
      c.question, c.trace_id, c.session_id, p.label, p.path,
      ...(mt.tool_names || []),
      c.probs_search || ((c.problems || []).map((x) => `${x.label || ""} ${x.path || ""}`).join(" ")),
    ].filter(Boolean).join(" ").toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
}

function rowProbsCount(c) {
  return c?.probs_count ?? (c?.problems?.length || 0);
}

export function filterBenchCases(cases, f, longThreshold = 65536) {
  return (cases || []).filter((c) => caseMatchesFilter(c, f, longThreshold));
}

export function sortBenchCases(cases, sortBy = "rank") {
  const arr = [...(cases || [])];
  arr.sort((a, b) => {
    const sa = a.stats || {};
    const sb = b.stats || {};
    if (sortBy === "sev") {
      return (SEV_RANK[a.severity] ?? 9) - (SEV_RANK[b.severity] ?? 9)
        || rowProbsCount(b) - rowProbsCount(a)
        || (a.bench?.rank ?? 9e9) - (b.bench?.rank ?? 9e9);
    }
    if (sortBy === "dup") {
      return (sb.dup_question || 1) - (sa.dup_question || 1) || (a.bench?.rank ?? 9e9) - (b.bench?.rank ?? 9e9);
    }
    if (sortBy === "tokens") {
      return (sb.total_tokens || 0) - (sa.total_tokens || 0) || (a.bench?.rank ?? 9e9) - (b.bench?.rank ?? 9e9);
    }
    if (sortBy === "latency") {
      return (sb.latency || 0) - (sa.latency || 0) || (a.bench?.rank ?? 9e9) - (b.bench?.rank ?? 9e9);
    }
    if (sortBy === "probs") {
      return rowProbsCount(b) - rowProbsCount(a)
        || (SEV_RANK[a.severity] ?? 9) - (SEV_RANK[b.severity] ?? 9);
    }
    if (sortBy === "day") {
      return String(b.request_time || b.day || "").localeCompare(String(a.request_time || a.day || ""));
    }
    return (a.bench?.rank ?? 9e9) - (b.bench?.rank ?? 9e9);
  });
  return arr;
}

export function groupFieldCases(cases, by = "l1", stageNames = {}) {
  const groups = new Map();
  const keyOf = (c) => {
    if (by === "l1") {
      if (c.severity === "GOLD") return "GOLD";
      return c.primary?.l1 && c.primary.l1 !== "NA" ? c.primary.l1 : "";
    }
    if (by === "min_tier") return c.bench?.long_tier ? `长对话 ${c.bench.long_tier}` : `常规 ${c.bench?.min_tier || c.bench?.tier || "?"}`;
    return c.severity || "GOLD";
  };
  const labelOf = (k) => {
    if (by === "l1") return k === "GOLD" ? "goldencase" : stageLabel(k, stageNames);
    if (by === "sev") return sevLabel(k);
    return k;
  };
  cases.forEach((c) => {
    const k = keyOf(c);
    if (!k) return;
    if (!groups.has(k)) groups.set(k, { key: k, label: labelOf(k), items: [] });
    groups.get(k).items.push(c);
  });
  const list = [...groups.values()];
  if (by === "sev") {
    list.sort((a, b) => (SEV_RANK[a.key] ?? 9) - (SEV_RANK[b.key] ?? 9));
  } else if (by === "min_tier") {
    list.sort((a, b) => Number(a.key.replace(/\D/g, "")) - Number(b.key.replace(/\D/g, "")));
  } else {
    list.sort((a, b) => b.items.length - a.items.length);
  }
  return list;
}

export function buildSunburstTree(tierData, cases, taxonomy, stageNames, mechNames, patNames) {
  const ct = tierData?.crosstab || {};
  const rows = ct.rows || {};
  const sevCells = ct.sev_cells || {};
  const patDim = tierData?.dims?.pattern || [];

  const cellSevFallback = {};
  if (!Object.keys(sevCells).length && cases?.length) {
    cases.forEach((c) => {
      if (c.severity !== "P0" && c.severity !== "P1") return;
      const key = `${c.primary?.l1 || "NA"}.${c.primary?.l2 || "NA"}`;
      if (!cellSevFallback[key]) cellSevFallback[key] = { P0: 0, P1: 0 };
      cellSevFallback[key][c.severity] += 1;
    });
  }
  const sevOfCell = (l1, l2) => sevCells[`${l1}.${l2}`] || cellSevFallback[`${l1}.${l2}`] || { P0: 0, P1: 0 };

  const patChildren = new Map();
  patDim.forEach((p) => {
    const key = String(p.key || "");
    const parts = key.split(".");
    if (parts.length < 2 || !p.count || parts[0] === "NA" || parts[1] === "NA") return;
    const cm = `${parts[0]}.${parts[1]}`;
    if (!patChildren.has(cm)) patChildren.set(cm, []);
    const pName = patternDisplayName(key, p.bucket, patNames, stageNames, mechNames);
    patChildren.get(cm).push({ id: `b/${key}`, name: pName, n: p.count });
  });

  const sIds = (ct.stages?.length ? ct.stages : Object.keys(rows)).filter((s) => s && s !== "NA");
  const mIds = (ct.mechanisms?.length ? ct.mechanisms : MECH_ORDER).filter((m) => m && m !== "NA");

  let rootP0 = 0;
  let rootP1 = 0;
  const stageNodes = [];

  sIds.forEach((sid) => {
    const row = rows[sid] || {};
    const mechs = [];
    let stN = 0;
    let stP0 = 0;
    let stP1 = 0;
    mIds.forEach((mid) => {
      const n = Number(row[mid] || 0);
      if (!n) return;
      const sv = sevOfCell(sid, mid);
      stN += n;
      stP0 += sv.P0 || 0;
      stP1 += sv.P1 || 0;
      mechs.push({
        id: `b/${sid}.${mid}`,
        name: mechLabel(mid, mechNames),
        n,
        sev: sv,
        children: patChildren.get(`${sid}.${mid}`) || [],
      });
    });
    if (stN > 0) {
      rootP0 += stP0;
      rootP1 += stP1;
      stageNodes.push({
        id: `b/${sid}`,
        name: stageLabel(sid, stageNames),
        n: stN,
        sev: { P0: stP0, P1: stP1 },
        children: mechs,
      });
    }
  });

  return {
    id: "b",
    name: "全部",
    n: sum(stageNodes.map((x) => x.n)),
    sev: { P0: rootP0, P1: rootP1 },
    children: stageNodes,
  };
}

export function resolveSampleHref(product, c) {
  if (!c?.case_key && !c?.slug) return null;
  const qs = new URLSearchParams({ view: "samples", product: product || "aime" });
  qs.set("case", c.case_key || c.slug);
  if (c.trace_id) qs.set("trace", c.trace_id);
  return `?${qs}`;
}

function activeFilterPills(f, maps) {
  const items = [];
  const add = (k, lbl) => items.push({ k, lbl });
  if (f.sev) add("sev", `等级 ${sevLabel(f.sev)}`);
  if (f.l1) add("l1", `环节 ${stageLabel(f.l1, maps.stageNames)}`);
  if (f.l2) add("l2", `机制 ${mechLabel(f.l2, maps.mechNames)}`);
  if (f.l3) add("l3", `问题 ${patternDisplayName(f.l3, "", maps.patNames, maps.stageNames, maps.mechNames)}`);
  if (f.turn) add("turn", f.turn === "multi" ? "多轮对话" : "单轮对话");
  if (f.tok) add("tok", `长度 ${TOK_LABELS[f.tok] || f.tok}`);
  if (f.rnd) add("rnd", `轮次 ${ROUND_LABELS[f.rnd] || f.rnd}`);
  if (f.day) add("day", `日期 ${f.day}`);
  if (f.psrc) add("psrc", `来源 ${PATH_SRC_LABEL[f.psrc] || f.psrc}`);
  if (f.dupOnly) add("dupOnly", "高频重问 ≥2");
  if (f.longOnly) add("longOnly", "长对话 ≥64K");
  if (f.q) add("q", `关键词 “${f.q}”`);
  return items;
}

function queryFromUrl() {
  const sp = new URLSearchParams(location.search);
  return {
    bm: sp.get("bm") || "",
    bl: sp.get("bl") === "1",
    bt: sp.get("bt") || "",
    bd: sp.get("bd") || "day",
    bv: sp.get("bv") === "field" ? "field" : "list",
    trace: sp.get("trace") || "",
  };
}

function syncUrl(patch) {
  const url = new URL(location.href);
  Object.entries(patch).forEach(([k, v]) => {
    if (v === null || v === undefined || v === "" || v === false) url.searchParams.delete(k);
    else url.searchParams.set(k, v === true ? "1" : String(v));
  });
  history.replaceState(null, "", url);
}

/* ---------------------------------------------------------------- Main Schema:2 Bench View */
export async function render(root, ctx) {
  const urlInit = queryFromUrl();
  const taxonomy = ctx.data?.taxonomy || null;

  let raw = null;
  try {
    raw = await getJSON(`/bench/${ctx.product}.json?view=summary`, { retries: 2 });
  } catch {
    raw = null;
  }

  if (!raw || raw.schema !== 2) {
    // Only the dynamic (3_dynamic_bench) bench is supported. A golden/bad summary is not
    // another layout, it is missing dynamic data — never fall back to the retired list view.
    root.innerHTML = `<div class="bento bn-bento"><section class="card" style="--span:12"><div class="bn-empty">暂无 Bench 数据</div></section></div>`;
    return;
  }

  const data = normalizeBenchPayload(raw, taxonomy);
  const { manifest, models, modelOrder, stageNames, mechNames, patNames } = data;
  const maps = { stageNames, mechNames, patNames };
  const params = manifest.params;

  const S = {
    model: models[urlInit.bm] ? urlInit.bm : (modelOrder[0] || ""),
    isLong: urlInit.bl,
    tier: urlInit.bt,
    dim: DIM_META.some((d) => d.key === urlInit.bd) ? urlInit.bd : "day",
    view: urlInit.bv,
    groupBy: "l1",
    sort: "rank",
    page: 1,
    size: 25,
    fieldPages: {},
    moreOpen: false,
    mxMode: "bench",
    f: EMPTY_FILTER(),
    trace: urlInit.trace,
    caseCache: new Map(),
    tierCasesCache: new Map(),
    sunburstState: { focus: "b", open: null },
    stepFilter: "all",
    showFullQ: false,
    calMonth: "",
    calMode: "pool",
    calModalDate: "",
    flippedStages: new Set(),
    stageFocus: new Map(),
  };

  const currentModel = () => models[S.model] || Object.values(models)[0];
  const validTier = () => {
    const md = currentModel();
    const keys = S.isLong ? md.longKeys : md.stdKeys;
    if (keys.includes(Number(S.tier))) return String(S.tier);
    return String(keys[0] || (S.isLong ? 10 : 500));
  };
  S.tier = validTier();

  const loadTierCases = async () => {
    const md = currentModel();
    const tNum = Number(S.tier);
    const cacheKey = `${md.id}|${S.isLong ? "L" : "B"}|${tNum}`;
    if (S.tierCasesCache.has(cacheKey)) return S.tierCasesCache.get(cacheKey);

    const qs = new URLSearchParams({
      view: "fields", model: md.id, tier: String(tNum), long: S.isLong ? "1" : "0",
    });
    try {
      const res = await getJSON(`/bench/${data.product}.json?${qs}`, { retries: 2 });
      const rows = Array.isArray(res) ? res : (res.cases || res.rows || []);
      S.tierCasesCache.set(cacheKey, rows);
      return rows;
    } catch {
      S.tierCasesCache.set(cacheKey, []);
      return [];
    }
  };

  const activeTierStats = (cases) => {
    const md = currentModel();
    const store = S.isLong ? md.long_tiers : md.tiers;
    const rawTier = store?.[S.tier];
    if (rawTier && rawTier.dims && rawTier.crosstab) return rawTier;
    return { ...(rawTier || {}), ...deriveTierFromCases(cases, Number(S.tier), md.pool_stats, params, taxonomy) };
  };

  let lastFiltered = [];
  let focusSearchAfterRender = false;
  let searchPos = null;
  let sheetBackdrop = null;

  function syncSunburstFromFilter() {
    if (S.f.l3 && S.f.l1 && S.f.l2 && S.f.l1 !== "NA" && S.f.l2 !== "NA") {
      S.sunburstState = { focus: `b/${S.f.l1}.${S.f.l2}`, open: `b/${S.f.l3}` };
    } else if (S.f.l1 && S.f.l2 && S.f.l1 !== "NA" && S.f.l2 !== "NA") {
      S.sunburstState = { focus: `b/${S.f.l1}.${S.f.l2}`, open: null };
    } else if (S.f.l1 && S.f.l1 !== "NA") {
      S.sunburstState = { focus: `b/${S.f.l1}`, open: null };
    } else {
      S.sunburstState = { focus: "b", open: null };
    }
  }

  const toggleFilter = (k, v) => {
    if (k === "dupOnly" || k === "longOnly") {
      S.f[k] = !S.f[k];
    } else {
      S.f[k] = S.f[k] === v ? "" : v;
      if (k === "l1" && !S.f.l1) S.f.l3 = "";
      if (k === "l2" && !S.f.l2) S.f.l3 = "";
      if (k === "l1" || k === "l2" || k === "l3") syncSunburstFromFilter();
    }
    S.page = 1;
    S.fieldPages = {};
    repaint({ rebuildSummary: k === "l1" || k === "l2" || k === "l3" });
  };

  const openTrace = async (traceId) => {
    S.trace = traceId;
    S.stepFilter = "all";
    S.showFullQ = false;
    syncUrl({ trace: traceId || null });
    await paintSheet();
    $$(".bn-lrow[aria-current], .bn-ftile[aria-current]", root).forEach((el) => el.removeAttribute("aria-current"));
    if (traceId) {
      const target = root.querySelector(`[data-trace="${CSS.escape(traceId)}"]`);
      if (target) target.setAttribute("aria-current", "true");
    }
  };

  const loadFullCase = async (mdId, traceId, summaryCase) => {
    const key = `${mdId}|${traceId}`;
    if (S.caseCache.has(key)) return S.caseCache.get(key);
    let full = null;
    try {
      full = await getJSON(`/bench_case/${data.product}/${mdId}/${encodeURIComponent(traceId)}.json`, { retries: 1 });
    } catch {
      full = summaryCase || null;
    }
    if (full?.slug) {
      try {
        full._sample = await getJSON(`/samples/${full.slug}.json`, { retries: 0 });
      } catch { /* sample detail enrichment is optional */ }
    }
    if (full) S.caseCache.set(key, full);
    return full;
  };

  function benchDayTipHTML(rec, isBenchMode, tierLabel) {
    if (!rec) return "";
    const added = isBenchMode ? rec.benchAdded : rec.poolAdded;
    const cum = isBenchMode ? rec.benchCum : rec.poolCum;
    const dlt = isBenchMode ? rec.benchDelta : rec.poolDelta;
    const dCls = dlt > 0 ? "is-up" : dlt < 0 ? "is-down" : "";
    return `<div class="t-head">${esc(rec.date)}</div>
      <div class="t-row"><span>${isBenchMode ? `入选 ${tierLabel}` : "当日动态入池"}</span><b class="num is-key">+${fmt(added)}</b></div>
      <div class="t-row"><span>较前日变化</span><b class="num ${dCls}">${signedDelta(dlt)}</b></div>
      <div class="t-row"><span>累计规模</span><b class="num">${fmt(cum)}</b></div>
      ${isBenchMode
        ? `<div class="t-row"><span>当日候选池新增</span><b class="num">+${fmt(rec.poolAdded)}</b></div>`
        : `<div class="t-row"><span>入选 ${tierLabel}</span><b class="num">${fmt(rec.benchAdded)}</b></div>`}`;
  }

  function renderGrowthChartHTML(daily, isBenchMode, tierLabel) {
    const days = daily.days || [];
    const last7 = isBenchMode ? daily.last7Bench : daily.last7Pool;
    const latest = daily.latestDay;
    const totalCum = isBenchMode ? daily.totalBenchCum : daily.totalPoolCum;
    const firstCum = days.length ? (isBenchMode ? days[0].benchCum : days[0].poolCum) : 0;
    const latestVal = latest ? (isBenchMode ? latest.benchAdded : latest.poolAdded) : 0;
    if (!days.length) {
      return `<div class="bn-growth-card"><div class="bn-growth-head"><span class="bn-fstage-k">动态增长</span><b class="num">—</b></div></div>`;
    }
    const W = 460;
    const H = 84;
    const padX = 8;
    const padT = 10;
    const padB = 8;
    const plotW = W - padX * 2;
    const plotH = H - padT - padB;
    const maxAdd = Math.max(1, isBenchMode ? daily.maxBenchAdded : daily.maxPoolAdded);
    const maxCum = Math.max(1, totalCum);
    const stepX = days.length > 1 ? plotW / (days.length - 1) : 0;
    const barW = Math.max(2.5, Math.min(9, (plotW / Math.max(1, days.length)) * 0.62));

    const pts = days.map((d, i) => {
      const add = isBenchMode ? d.benchAdded : d.poolAdded;
      const cum = isBenchMode ? d.benchCum : d.poolCum;
      const x = days.length > 1 ? padX + i * stepX : W / 2;
      const yCum = padT + (1 - cum / maxCum) * plotH;
      const barH = Math.max(2, (add / maxAdd) * (plotH * 0.72));
      return { d, x, yCum, barH, add };
    });

    const lineD = pts.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(1)},${p.yCum.toFixed(1)}`).join("");
    const baseY = (padT + plotH).toFixed(1);
    const areaD = pts.length > 1
      ? `${lineD}L${pts[pts.length - 1].x.toFixed(1)},${baseY}L${pts[0].x.toFixed(1)},${baseY}Z`
      : "";
    const lastPt = pts[pts.length - 1];
    const bars = pts.map((p) => {
      const active = S.f.day === p.d.date || S.calModalDate === p.d.date;
      const tip = benchDayTipHTML(p.d, isBenchMode, tierLabel);
      return `<rect class="bn-g-bar${active ? " is-on" : ""}" x="${(p.x - barW / 2).toFixed(1)}" y="${(padT + plotH - p.barH).toFixed(1)}" width="${barW.toFixed(1)}" height="${p.barH.toFixed(1)}" rx="1.5" data-bn-day="${esc(p.d.date)}" data-tip="1" data-tip-html="${esc(tip)}"/>`;
    }).join("");

    return `<div class="bn-growth-card">
      <div class="bn-growth-head">
        <span class="bn-fstage-k">${isBenchMode ? `${tierLabel} 累计增长` : "动态入池走势"}</span>
        <div class="bn-growth-kpis num">
          <span class="bn-g-range">${fmt(firstCum)} → <b>${fmt(totalCum)}</b></span>
          ${latest ? `<span class="bn-delta-pill is-live">${esc(latest.date.slice(5))} +${fmt(latestVal)}</span>` : ""}
          <span class="bn-delta-pill">近 7 日 +${fmt(last7)}</span>
        </div>
      </div>
      <div class="bn-growth-plot">
        <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Bench 每日入库与累计增长曲线">
          ${areaD ? `<path class="bn-g-area" d="${areaD}"/>` : ""}
          <g class="bn-g-bars">${bars}</g>
          ${lineD ? `<path class="bn-g-line" d="${lineD}"/>` : ""}
          ${lastPt ? `<circle class="bn-g-halo" cx="${lastPt.x.toFixed(1)}" cy="${lastPt.yCum.toFixed(1)}" r="6"/><circle class="bn-g-dot" cx="${lastPt.x.toFixed(1)}" cy="${lastPt.yCum.toFixed(1)}" r="3.2"/>` : ""}
        </svg>
      </div>
    </div>`;
  }

  function renderCalFrontHTML(daily, isBenchMode, tierLabel) {
    const months = daily.months || [];
    const latestYm = months[months.length - 1] || new Date().toISOString().slice(0, 7);
    const activeYm = /^\d{4}-\d{2}$/.test(S.calMonth) ? S.calMonth : latestYm;
    const [yy, mm] = activeYm.split("-").map(Number);
    const daysInMonth = Number.isFinite(yy) && Number.isFinite(mm)
      ? new Date(Date.UTC(yy, mm, 0)).getUTCDate()
      : 30;
    const firstDow = Number.isFinite(yy) && Number.isFinite(mm)
      ? (new Date(Date.UTC(yy, mm - 1, 1)).getUTCDay() + 6) % 7
      : 0;
    const maxVal = Math.max(1, isBenchMode ? daily.maxBenchAdded : daily.maxPoolAdded);
    const prevYm = shiftYm(activeYm, -1);
    const nextYm = shiftYm(activeYm, 1);
    const atEarliest = activeYm <= "2020-01";
    const atLatest = activeYm >= latestYm;

    const cells = [];
    for (let i = 0; i < firstDow; i += 1) {
      cells.push(`<span class="bn-cal-cell is-void" aria-hidden="true"></span>`);
    }
    let monthAdded = 0;
    for (let d = 1; d <= daysInMonth; d += 1) {
      const dateStr = `${activeYm}-${String(d).padStart(2, "0")}`;
      const rec = daily.byDate.get(dateStr);
      const val = rec ? (isBenchMode ? rec.benchAdded : rec.poolAdded) : 0;
      monthAdded += val;
      if (!rec || val <= 0) {
        cells.push(`<span class="bn-cal-cell is-empty" aria-label="${esc(dateStr)}"><span class="bn-cal-d num">${d}</span></span>`);
        continue;
      }
      const ratio = val / maxVal;
      const heat = 0.08 + 0.88 * (ratio ** 0.72);
      const isActive = S.f.day === dateStr || S.calModalDate === dateStr;
      const tip = benchDayTipHTML(rec, isBenchMode, tierLabel);
      cells.push(`<button type="button" class="bn-cal-cell${isActive ? " is-active" : ""}${heat > 0.56 ? " is-hot" : ""}" data-bn-day="${esc(dateStr)}" data-tip="1" data-tip-html="${esc(tip)}" aria-pressed="${isActive}" style="--v:${heat.toFixed(3)}">
        <span class="bn-cal-d num">${d}</span>
        <b class="bn-cal-v num">${esc(compactPlus(val))}</b>
      </button>`);
    }
    const trailing = (7 - (cells.length % 7)) % 7;
    for (let i = 0; i < trailing; i += 1) {
      cells.push(`<span class="bn-cal-cell is-void" aria-hidden="true"></span>`);
    }

    const title = Number.isFinite(yy) && Number.isFinite(mm) ? `${yy} 年 ${mm} 月` : activeYm;
    return `<div class="bn-cal">
      <div class="bn-cal-bar">
        <div class="bn-cal-head-l">
          <span class="bn-cal-title num">${esc(title)}</span>
          ${monthAdded > 0 ? `<span class="bn-delta-pill num">+${fmt(monthAdded)}</span>` : ""}
        </div>
        <div class="bn-cal-head-r">
          <div class="bn-cal-mode" role="group" aria-label="日历口径">
            <button type="button" data-bn-cal-mode="pool" aria-pressed="${!isBenchMode}">入池</button>
            <button type="button" data-bn-cal-mode="bench" aria-pressed="${isBenchMode}">当前档</button>
          </div>
          <div class="bn-cal-nav" role="group" aria-label="月份切换">
            <button type="button" class="bn-cal-navbtn" data-bn-cal-month="${esc(prevYm)}" aria-label="上一个月"${atEarliest ? " disabled" : ""}>${BN_CHEVRON_L}</button>
            <button type="button" class="bn-cal-navbtn" data-bn-cal-month="${esc(nextYm)}" aria-label="下一个月"${atLatest ? " disabled" : ""}>${BN_CHEVRON_R}</button>
          </div>
        </div>
      </div>
      <div class="bn-cal-week" aria-hidden="true">${BN_WEEKDAYS.map((w) => `<span>${w}</span>`).join("")}</div>
      <div class="bn-cal-grid" role="group" aria-label="动态入库日历">${cells.join("")}</div>
    </div>`;
  }

  function renderCalBackHTML(daily, dateStr, isBenchMode, tierLabel) {
    const rec = daily.byDate.get(dateStr);
    if (!rec) return "";
    const idx = daily.days.findIndex((d) => d.date === dateStr);
    const hasPrev = idx > 0;
    const hasNext = idx >= 0 && idx < daily.days.length - 1;
    const added = isBenchMode ? rec.benchAdded : rec.poolAdded;
    const cum = isBenchMode ? rec.benchCum : rec.poolCum;
    const dlt = isBenchMode ? rec.benchDelta : rec.poolDelta;
    const dCls = dlt > 0 ? "is-up" : dlt < 0 ? "is-down" : "";
    const isFiltered = S.f.day === dateStr;

    // 7-day momentum window centered around selected day
    const start = Math.max(0, Math.min(daily.days.length - 7, idx - 3));
    const win = daily.days.slice(start, start + 7);
    const winMax = Math.max(1, ...win.map((x) => (isBenchMode ? x.benchAdded : x.poolAdded)));
    const W = 320;
    const H = 82;
    const padX = 16;
    const padT = 16;
    const padB = 18;
    const pH = H - padT - padB;
    const step = win.length > 1 ? (W - padX * 2) / (win.length - 1) : 0;
    const pts = win.map((w, i) => {
      const v = isBenchMode ? w.benchAdded : w.poolAdded;
      const x = win.length > 1 ? padX + i * step : W / 2;
      const h = Math.max(3, (v / winMax) * pH);
      const y = padT + pH - h;
      return { w, v, x, y, h, cur: w.date === dateStr };
    });
    const lineD = pts.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join("");
    const barsSVG = pts.map((p) => `<g class="bn-mbar-g${p.cur ? " is-cur" : ""}">
      <rect x="${(p.x - 10).toFixed(1)}" y="${p.y.toFixed(1)}" width="20" height="${p.h.toFixed(1)}" rx="4"/>
      <text class="bn-mbar-val" x="${p.x.toFixed(1)}" y="${Math.max(11, p.y - 4).toFixed(1)}" text-anchor="middle">${esc(compactPlus(p.v))}</text>
      <text class="bn-mbar-day" x="${p.x.toFixed(1)}" y="${H - 4}" text-anchor="middle">${esc(p.w.date.slice(8))}</text>
    </g>`).join("");

    return `<div class="bn-cal-detail">
      <div class="bn-cal-dhead">
        <div class="bn-cal-dnav">
          <button type="button" class="bn-cal-navbtn" data-bn-cal-step="-1" aria-label="前一天"${hasPrev ? "" : " disabled"}>${BN_CHEVRON_L}</button>
          <span class="bn-cal-ddate num">${esc(dateStr)}</span>
          <button type="button" class="bn-cal-navbtn" data-bn-cal-step="1" aria-label="后一天"${hasNext ? "" : " disabled"}>${BN_CHEVRON_R}</button>
        </div>
        <button type="button" class="bn-cal-close" data-bn-cal-close aria-label="返回日历">${BN_CLOSE_X}</button>
      </div>
      <div class="bn-cal-dkpis num">
        <div class="bn-cal-dkpi is-accent"><span>当日新增</span><b>+${fmt(added)}</b></div>
        <div class="bn-cal-dkpi"><span>累计规模</span><b>${fmt(cum)}</b></div>
        <div class="bn-cal-dkpi"><span>较前日</span><b class="${dCls}">${signedDelta(dlt)}</b></div>
      </div>
      <div class="bn-cal-dmom">
        <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="前后 7 日动态入库量">
          ${barsSVG}
          ${pts.length > 1 ? `<path class="bn-g-line" d="${lineD}"/>` : ""}
          ${pts.map((p) => `<circle class="bn-dmom-dot${p.cur ? " is-cur" : ""}" cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${p.cur ? 3.6 : 2.2}"/>`).join("")}
        </svg>
      </div>
      <div class="bn-cal-dfoot">
        <div class="bn-cal-dpills num">
          <span>候选池 <b>+${fmt(rec.poolAdded)}</b></span>
          <span>${esc(tierLabel)} <b>${fmt(rec.benchAdded)}</b></span>
        </div>
        <button type="button" class="bn-cal-filterbtn${isFiltered ? " is-on" : ""}" data-bn-day-filter="${esc(dateStr)}">${isFiltered ? "取消当日筛选" : "筛选当日样本"}</button>
      </div>
    </div>`;
  }

  /* Card 1 front graphic: 14-day luminous inflow area sparkline */
  function frontSparkAreaSVG(days) {
    const tail = (days || []).slice(-14);
    if (tail.length < 2) return "";
    const W = 98;
    const H = 34;
    const padX = 3;
    const padY = 4;
    const vals = tail.map((d) => Number(d.poolAdded || 0));
    const maxV = Math.max(1, ...vals);
    const pts = vals.map((v, i) => [
      padX + (i / (vals.length - 1)) * (W - padX * 2),
      H - padY - (v / maxV) * (H - padY * 2),
    ]);
    const line = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join("");
    const area = `${line}L${pts[pts.length - 1][0].toFixed(1)},${(H - padY).toFixed(1)}L${pts[0][0].toFixed(1)},${(H - padY).toFixed(1)}Z`;
    const last = pts[pts.length - 1];
    return `<svg class="bn-fviz bn-fviz-spark" viewBox="0 0 ${W} ${H}" aria-hidden="true">
      <path class="bn-fv-area" d="${area}"/>
      <path class="bn-fv-line" d="${line}"/>
      <circle class="bn-fv-dot" cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="2.6"/>
    </svg>`;
  }

  /* Card 2 front graphic: 10×3 proportional composition dot matrix */
  function frontDotMatrixHTML(segments) {
    const total = segments.reduce((acc, s) => acc + Math.max(0, Number(s.value) || 0), 0);
    if (total <= 0) return "";
    const CELLS = 30;
    const colors = [];
    let assigned = 0;
    segments.forEach((s, idx) => {
      const val = Math.max(0, Number(s.value) || 0);
      if (val <= 0) return;
      const count = idx === segments.length - 1
        ? Math.max(0, CELLS - assigned)
        : Math.max(1, Math.round((val / total) * CELLS));
      for (let k = 0; k < count && colors.length < CELLS; k += 1) colors.push(s.color);
      assigned = colors.length;
    });
    while (colors.length < CELLS) colors.push(segments[0]?.color || "var(--accent)");
    return `<div class="bn-fviz bn-fviz-dots" aria-hidden="true">${colors.map((c) => `<i style="background:${c}"></i>`).join("")}</div>`;
  }

  /* Card 3 front graphic: 14-day mini column rhythm bars */
  function frontMiniBarsSVG(days) {
    const tail = (days || []).slice(-14);
    if (!tail.length) return "";
    const W = 98;
    const H = 34;
    const vals = tail.map((d) => Number(d.poolAdded || 0));
    const maxV = Math.max(1, ...vals);
    const gap = 2.5;
    const bw = Math.max(3, (W - gap * (vals.length - 1)) / vals.length);
    const bars = vals.map((v, i) => {
      const h = Math.max(3, (v / maxV) * (H - 4));
      const x = i * (bw + gap);
      const y = H - h;
      const isLast = i === vals.length - 1;
      return `<rect class="bn-fv-bar${isLast ? " is-last" : ""}" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="1.6"/>`;
    }).join("");
    return `<svg class="bn-fviz bn-fviz-bars" viewBox="0 0 ${W} ${H}" aria-hidden="true">${bars}</svg>`;
  }

  function stageDonutSVG(id, segments, defaultCenter, defaultSub = "", focusIdx = -1) {
    const R = 31;
    const C = 2 * Math.PI * R;
    const total = segments.reduce((acc, s) => acc + Math.max(0, Number(s.value) || 0), 0);
    let offset = 0;
    const hasFocus = focusIdx >= 0 && focusIdx < segments.length;
    const arcs = total > 0
      ? segments.map((s, idx) => {
        const val = Math.max(0, Number(s.value) || 0);
        if (val <= 0) return "";
        const len = (val / total) * C;
        const dash = `${Math.max(1.2, len - 1.8).toFixed(2)} ${(C - Math.max(1.2, len - 1.8)).toFixed(2)}`;
        const isSel = hasFocus && idx === focusIdx;
        const cls = `bn-farc${isSel ? " is-active" : hasFocus ? " is-dim" : ""}`;
        const seg = `<circle class="${cls}" cx="40" cy="40" r="${R}" stroke="${s.color}" style="--c:${s.color}" stroke-dasharray="${dash}" stroke-dashoffset="${(-offset).toFixed(2)}" data-bn-fseg="${esc(`${id}:${idx}`)}"/>`;
        offset += len;
        return seg;
      }).join("")
      : "";
    const sel = hasFocus ? segments[focusIdx] : null;
    const selPct = sel && total > 0 ? `${Math.round((Math.max(0, sel.value) / total) * 100)}%` : defaultCenter;
    const subLabel = sel ? (sel.label || "") : defaultSub;
    return `<div class="bn-fring${hasFocus ? " has-focus" : ""}">
      <svg viewBox="0 0 80 80" role="img" aria-label="占比圆环">
        <circle class="bn-fring-track" cx="40" cy="40" r="${R}"/>
        ${arcs}
      </svg>
      <div class="bn-fring-center${sel ? " is-focus" : ""}"${sel ? ` style="--c:${sel.color}"` : ""}>
        <b class="num">${esc(selPct)}</b>
        ${subLabel ? `<span>${esc(subLabel)}</span>` : ""}
      </div>
    </div>`;
  }

  function stageBackBodyHTML({ id, ringCenter, ringSub = "", segments, rows }) {
    const focusIdx = S.stageFocus.has(id) ? S.stageFocus.get(id) : -1;
    const total = segments.reduce((acc, s) => acc + Math.max(0, Number(s.value) || 0), 0);
    const hasFocus = focusIdx >= 0 && focusIdx < segments.length;
    return `${stageDonutSVG(id, segments, ringCenter, ringSub, focusIdx)}
      <div class="bn-fback-rows num${hasFocus ? " has-focus" : ""}">
        ${rows.map((r) => {
          const isSlice = Number.isInteger(r.segIdx) && r.segIdx >= 0 && r.segIdx < segments.length;
          const shareNum = isSlice && total > 0 ? (Math.max(0, Number(segments[r.segIdx].value) || 0) / total) * 100 : 0;
          const shareStr = isSlice && total > 0 ? `${shareNum.toFixed(1).replace(/\.0$/, "")}%` : "";
          const isSel = isSlice && hasFocus && r.segIdx === focusIdx;
          if (isSlice) {
            return `<button type="button" class="bn-fback-row is-pickable${isSel ? " is-active" : ""}" data-bn-fseg="${esc(`${id}:${r.segIdx}`)}" aria-pressed="${isSel}" style="--c:${r.color};--w:${Math.min(100, shareNum).toFixed(1)}%">
              <span class="bn-fback-k"><i></i>${esc(r.label)}</span>
              <span class="bn-fback-pct">${esc(shareStr)}</span>
              <b>${esc(r.val)}</b>
            </button>`;
          }
          return `<div class="bn-fback-row" style="--c:${r.color}">
            <span class="bn-fback-k"><i></i>${esc(r.label)}</span>
            <span class="bn-fback-pct"></span>
            <b>${esc(r.val)}</b>
          </div>`;
        }).join("")}
      </div>`;
  }

  function flipStageHTML(spec) {
    const { id, title, pill = "", value, focus = false, footer = "", frontStats = [], viz = "" } = spec;
    const flipped = S.flippedStages.has(id);
    const statsFooter = !footer && frontStats.length
      ? `<div class="bn-fstats num">${frontStats.map((r) => `<span class="bn-fstat" style="--c:${r.color}"><i></i><span>${esc(r.label)}</span><b>${esc(r.val)}</b></span>`).join("")}</div>`
      : "";
    return `<div class="bn-fcard${focus ? " is-focus" : ""}${flipped ? " is-flipped" : ""}" data-bn-stage-flip="${esc(id)}" role="button" tabindex="0" aria-pressed="${flipped}">
      <div class="bn-fface bn-ffront">
        <div class="bn-fstage-top">
          <span class="bn-fstage-k">${esc(title)}</span>
          ${pill}
        </div>
        <div class="bn-ffront-main">
          <div class="bn-fstage-v num">${esc(value)}</div>
          ${viz}
        </div>
        ${footer || statsFooter}
      </div>
      <div class="bn-fface bn-fback">
        <div class="bn-fstage-top">
          <span class="bn-fstage-k">${esc(title)}</span>
          <button type="button" class="bn-fback-close" data-bn-stage-close="${esc(id)}" aria-label="返回">${BN_CLOSE_X}</button>
        </div>
        <div class="bn-fback-body" data-bn-fback-body="${esc(id)}">${stageBackBodyHTML(spec)}</div>
      </div>
    </div>`;
  }

  function buildHeroStageSpecs(md, tierData, daily) {
    const keys = S.isLong ? md.longKeys : md.stdKeys;
    const pool = manifest.pool || {};
    const actualN = Number(tierData.actual || 0);
    const poolBase = S.isLong ? md.long_pool : md.base_pool;
    const tierPct = poolBase ? pct(actualN, poolBase, 1) : "—";
    const rawPoolTotal = Number(pool.cases || pool.cases_raw || sum(modelOrder.map((id) => models[id].pool_size)));
    const usableTotal = Number(pool.usable_cases || pool.cases_dedup || sum(modelOrder.map((id) => models[id].pool_size)));
    const dupDrop = Number(pool.dup_collapsed || 0);
    const emptyDrop = Number(pool.empty_question || 0);
    const otherDrop = Math.max(0, rawPoolTotal - usableTotal - dupDrop - emptyDrop);
    const keepPct = rawPoolTotal ? `${Math.round((usableTotal / rawPoolTotal) * 100)}%` : "—";
    const refreshNew = Number(pool.refresh?.new_cases || 0);
    const latestPoolAdd = daily.latestDay?.poolAdded || 0;
    const liveBadge = refreshNew > 0 ? `+${fmt(refreshNew)}` : (latestPoolAdd > 0 ? `+${fmt(latestPoolAdd)}` : "");

    const goldN = Number(tierData.severity_actual?.GOLD || 0);
    const probN = Math.max(0, actualN - goldN);
    const probPct = actualN ? `${Math.round((probN / actualN) * 100)}%` : "—";
    const basePct = md.pool_size ? `${Math.round((md.base_pool / md.pool_size) * 100)}%` : "—";
    const modelPalette = ["var(--accent)", "var(--loc-ulq)", "var(--loc-vir)", "var(--sev-2)"];
    const activeModelPct = usableTotal ? `${Math.round((md.pool_size / usableTotal) * 100)}%` : "—";

    const nestFooter = `<div class="bn-nest">
      ${keys.map((k) => {
        const kn = Number(k);
        const cur = Number(S.tier);
        const on = kn === cur;
        const inside = kn < cur;
        const sub = S.isLong ? `长 ${kn}` : fmt(kn);
        return `<button type="button" class="bn-nest-btn ${on ? "is-on" : inside ? "is-in" : ""}" data-nest="${kn}">${sub}${inside ? '<span class="bn-nest-sub">⊂</span>' : ""}</button>`;
      }).join("")}
    </div>`;

    const modelSegments = modelOrder.map((id, idx) => ({
      label: models[id].label,
      value: models[id].pool_size,
      color: modelPalette[idx % modelPalette.length],
    }));

    return [
      {
        id: "raw",
        title: "动态主池",
        pill: liveBadge ? `<span class="bn-delta-pill is-live num">${esc(liveBadge)}</span>` : "",
        value: fmt(rawPoolTotal),
        viz: frontSparkAreaSVG(daily.days),
        frontStats: [
          { label: "可采样", val: compact(usableTotal), color: "var(--loc-ulq)" },
          { label: "去重", val: `−${compact(dupDrop)}`, color: "var(--muted)" },
          ...(emptyDrop > 0 ? [{ label: "空句", val: `−${compact(emptyDrop)}`, color: "var(--sev-2)" }] : []),
        ],
        ringCenter: keepPct,
        ringSub: "可采样",
        segments: [
          { label: "可采样", value: usableTotal, color: "var(--loc-ulq)" },
          { label: "去重", value: dupDrop, color: "var(--muted)" },
          { label: "空句", value: emptyDrop + otherDrop, color: "var(--sev-2)" },
        ],
        rows: [
          { segIdx: 0, label: "可采样", val: fmt(usableTotal), color: "var(--loc-ulq)" },
          { segIdx: 1, label: "去重", val: `−${fmt(dupDrop)}`, color: "var(--muted)" },
          ...(emptyDrop > 0 ? [{ segIdx: 2, label: "空句", val: `−${fmt(emptyDrop)}`, color: "var(--sev-2)" }] : []),
        ],
      },
      {
        id: "usable",
        title: "可采样候选池",
        pill: rawPoolTotal ? `<span class="bn-delta-pill num">${keepPct}</span>` : "",
        value: fmt(usableTotal),
        viz: frontDotMatrixHTML(modelSegments),
        frontStats: modelOrder.slice(0, 3).map((id, idx) => ({
          label: models[id].label,
          val: compact(models[id].pool_size),
          color: modelPalette[idx % modelPalette.length],
        })),
        ringCenter: activeModelPct,
        ringSub: md.label,
        segments: modelSegments,
        rows: modelOrder.map((id, idx) => ({
          segIdx: idx,
          label: models[id].label,
          val: fmt(models[id].pool_size),
          color: modelPalette[idx % modelPalette.length],
        })),
      },
      {
        id: "model",
        title: `${md.label} 候选池`,
        pill: daily.last7Pool > 0 ? `<span class="bn-delta-pill num">7日 +${compact(daily.last7Pool)}</span>` : "",
        value: fmt(md.pool_size),
        viz: frontMiniBarsSVG(daily.days),
        frontStats: [
          { label: "常规", val: compact(md.base_pool), color: "var(--accent)" },
          { label: "长对话", val: compact(md.long_pool), color: "var(--loc-vir)" },
        ],
        ringCenter: basePct,
        ringSub: "常规",
        segments: [
          { label: "常规", value: md.base_pool, color: "var(--accent)" },
          { label: "长对话", value: md.long_pool, color: "var(--loc-vir)" },
        ],
        rows: [
          { segIdx: 0, label: "常规", val: fmt(md.base_pool), color: "var(--accent)" },
          { segIdx: 1, label: "长对话", val: fmt(md.long_pool), color: "var(--loc-vir)" },
          ...(daily.last7Pool > 0 ? [{ label: "近 7 日", val: `+${fmt(daily.last7Pool)}`, color: "var(--loc-ulq)" }] : []),
        ],
      },
      {
        id: "tier",
        title: S.isLong ? `长对话 ${S.tier} 条档` : `${fmt(Number(S.tier))} 条基准档`,
        pill: `<span class="bn-delta-pill is-accent num">${tierPct}</span>`,
        value: fmt(actualN),
        focus: true,
        viz: `<div class="bn-fviz bn-fviz-kv num">
          <span style="--c:var(--sev-1)"><i></i><span>问题</span><b>${fmt(probN)}</b></span>
          <span style="--c:var(--loc-ulq)"><i></i><span>goldencase</span><b>${fmt(goldN)}</b></span>
        </div>`,
        footer: nestFooter,
        ringCenter: probPct,
        ringSub: "问题",
        segments: [
          { label: "问题", value: probN, color: "var(--sev-1)" },
          { label: "goldencase", value: goldN, color: "var(--loc-ulq)" },
        ],
        rows: [
          { segIdx: 0, label: "问题", val: fmt(probN), color: "var(--sev-1)" },
          { segIdx: 1, label: "goldencase", val: fmt(goldN), color: "var(--loc-ulq)" },
          ...(tierData.shortfall > 0
            ? [{ label: "缺口", val: fmt(tierData.shortfall), color: "var(--sev-2)" }]
            : [{ label: "占候选池", val: tierPct, color: "var(--accent)" }]),
        ],
      },
    ];
  }

  /* ---- Render sub-sections ---- */
  function renderHeroHTML(md, tierData) {
    const keys = S.isLong ? md.longKeys : md.stdKeys;
    const daily = buildBenchDailyModel(md, tierData);
    const isBenchMode = S.calMode === "bench";
    const tierLabel = tierTagLabel(Number(S.tier), S.isLong);
    const modalDate = S.calModalDate && daily.byDate.has(S.calModalDate) ? S.calModalDate : "";
    const stageSpecs = buildHeroStageSpecs(md, tierData, daily);

    return `<section class="card bn-hero" style="--span:12">
      <div class="bn-topbar">
        <div class="bn-controls">
          <div class="seg" id="bn-seg-model" role="group" aria-label="模型池">
            <span class="seg-knob" aria-hidden="true"></span>
            ${modelOrder.map((id) => `<button type="button" data-value="${esc(id)}" aria-pressed="${S.model === id}">${esc(models[id].label)} · ${compact(models[id].pool_size)}</button>`).join("")}
          </div>
          <div class="seg" id="bn-seg-mode" role="group" aria-label="对话长度档">
            <span class="seg-knob" aria-hidden="true"></span>
            <button type="button" data-value="std" aria-pressed="${!S.isLong}">常规规模</button>
            <button type="button" data-value="long" aria-pressed="${S.isLong}">长对话 ≥${Math.round((params.long_tokens || 65536) / 1024)}K</button>
          </div>
          <div class="seg" id="bn-seg-tier" role="group" aria-label="基准规模">
            <span class="seg-knob" aria-hidden="true"></span>
            ${keys.map((k) => `<button type="button" data-value="${k}" aria-pressed="${String(k) === S.tier}">${S.isLong ? `长 ${k}` : fmt(k)}</button>`).join("")}
          </div>
        </div>
      </div>

      <div class="bn-hero-grid">
        <div class="bn-hero-left">
          <div class="bn-funnel-grid">${stageSpecs.map((sp) => flipStageHTML(sp)).join("")}</div>
          ${renderGrowthChartHTML(daily, isBenchMode, tierLabel)}
        </div>

        <div class="bn-cal-stage${modalDate ? " is-flipped" : ""}" id="bnCalStage">
          <div class="bn-cal-face bn-cal-front" id="bnCalFront">${renderCalFrontHTML(daily, isBenchMode, tierLabel)}</div>
          <div class="bn-cal-face bn-cal-back" id="bnCalBack">${modalDate ? renderCalBackHTML(daily, modalDate, isBenchMode, tierLabel) : ""}</div>
        </div>
      </div>
    </section>`;
  }

  function renderQuotaHTML(md, tierData) {
    const actualN = Number(tierData.actual || 1);
    const reqN = Number(tierData.requested || actualN || 1);
    const pBySev = md.pool_stats?.by_severity || {};
    const sevPoolSum = sum(SEVS_ALL.map((s) => Number(pBySev[s] || 0)));
    const poolDistSize = Number(md.pool_stats?.pool_size || sevPoolSum || md.base_pool || md.pool_size || 1);
    const sActual = tierData.severity_actual || {};
    const sTarget = tierData.severity_target || {};
    const poolLbl = S.isLong ? "常规候选池" : "候选池";

    const sevEntries = SEVS_ALL.map((sev) => {
      const cnt = Number(sActual[sev] || 0);
      const tgtCnt = Number(sTarget[sev] || 0);
      const bPct = actualN ? (cnt / actualN) * 100 : 0;
      const tPct = reqN ? (tgtCnt / reqN) * 100 : 0;
      const pPct = poolDistSize ? (Number(pBySev[sev] || 0) / poolDistSize) * 100 : 0;
      const c = sevTone(sev);
      const tStr = `${tPct.toFixed(1).replace(/\.0$/, "")}%`;
      const tgtText = sev === "P0" && tPct >= (params.p0_cap * 100 - 0.5) ? `≤${tStr}` : tStr;
      const lbl = sevLabel(sev);
      const pressed = S.f.sev === sev;
      const tip = `${lbl} · 已选 ${fmt(cnt)} 条 (${bPct.toFixed(1)}%) · 目标 ${tgtText} · ${poolLbl} ${pPct.toFixed(1)}%`;
      return { sev, cnt, bPct, tPct, pPct, c, tgtText, lbl, pressed, tip };
    });

    const sevDonut = svgDonutHTML(
      sevEntries.map((x) => ({
        value: x.cnt,
        color: x.c,
        active: x.pressed,
        attr: `data-fsev="${x.sev}"`,
        centerVal: `${x.bPct.toFixed(1)}%`,
        centerSub: `${x.lbl} · ${fmt(x.cnt)}`,
        tip: x.tip,
      })),
      {
        size: 144,
        rOut: 62,
        rIn: 44,
        centerVal: fmt(actualN),
        centerSub: "已选等级",
        defaultVal: fmt(actualN),
        defaultSub: "已选等级",
      },
    );

    const legendGrid = `<div class="bn-qpie-leg${S.f.sev ? " has-focus" : ""}">${sevEntries.map((x) => `
      <button type="button" class="bn-qitem" data-fsev="${x.sev}" aria-pressed="${x.pressed}" data-tip="${esc(x.tip)}" style="--c:${x.c}">
        <span class="bn-qsev"><i></i>${x.lbl}</span>
        <span class="bn-qitem-val num"><b>${x.bPct.toFixed(1)}%</b><small>${fmt(x.cnt)}</small></span>
        <span class="bn-qitem-sub num">标 ${x.tgtText} · ${esc(poolLbl)} ${x.pPct.toFixed(1)}%</span>
      </button>`).join("")}</div>`;

    const ta = tierData.turn_actual || {};
    const singleN = Number(ta.single || 0);
    const multiN = Number(ta.multi || 0);
    const tTot = Math.max(1, singleN + multiN);
    const sPct = (singleN / tTot) * 100;
    const mPct = (multiN / tTot) * 100;
    const tTgtSingle = Number(params.turn_target?.single ?? 0.75) * 100;
    const poolTurn = md.pool_stats?.by_turn || {};
    const pTurnTot = (poolTurn.single || 0) + (poolTurn.multi || 0);
    const pSinglePct = pTurnTot ? ((poolTurn.single || 0) / pTurnTot) * 100 : 0;
    const pMultiPct = pTurnTot ? ((poolTurn.multi || 0) / pTurnTot) * 100 : 0;

    const waffleN = 50;
    let singleDots = Math.round((sPct / 100) * waffleN);
    if (singleN > 0 && singleDots === 0) singleDots = 1;
    if (multiN > 0 && singleDots === waffleN) singleDots = waffleN - 1;
    singleDots = Math.max(0, Math.min(waffleN, singleDots));
    const singleTip = `单轮对话 · ${fmt(singleN)} 条 (${sPct.toFixed(1)}%) · 池 ${pSinglePct.toFixed(0)}%`;
    const multiTip = `多轮对话 · ${fmt(multiN)} 条 (${mPct.toFixed(1)}%) · 池 ${pMultiPct.toFixed(0)}%`;
    const turnWaffle = `<div class="bn-turn-waffle${S.f.turn ? " has-focus" : ""}" role="group" aria-label="单多轮占比点阵">
      ${Array.from({ length: waffleN }, (_, idx) => {
        const isSingle = idx < singleDots;
        const tKey = isSingle ? "single" : "multi";
        const c = isSingle ? "var(--accent)" : "var(--loc-ulq)";
        const tip = isSingle ? singleTip : multiTip;
        return `<button type="button" class="bn-wdot" data-fturn="${tKey}" aria-pressed="${S.f.turn === tKey}" data-tip="${esc(tip)}" style="--c:${c};--wi:${idx}" aria-label="${isSingle ? "单轮" : "多轮"}"></button>`;
      }).join("")}
    </div>`;

    const mActual = tierData.mechanism_actual || {};
    const probTot = Number(tierData.crosstab?.totals?.bench_total ?? Math.max(0, actualN - Number(sActual.GOLD || 0)));
    const mSum = Math.max(1, sum(MECH_ORDER.map((m) => Number(mActual[m] || 0))));
    const mechItems = MECH_ORDER.map((m, i) => {
      const n = Number(mActual[m] || 0);
      const share = (n / mSum) * 100;
      const fullLbl = mechLabel(m, mechNames);
      const shortLbl = mechLabel(m, mechNames, true).slice(0, 4);
      const c = MECH_PALETTE[i % MECH_PALETTE.length];
      return { m, n, share, fullLbl, shortLbl, c, idx: i };
    }).sort((a, b) => (b.n - a.n) || (a.idx - b.idx));
    const maxMechShare = Math.max(1, ...mechItems.map((x) => x.share));

    return `<section class="card bn-quota-card">
      <div class="card-head">
        <h2>配比结构</h2>
        <span class="bn-count-pill">已选 ${fmt(actualN)} 条</span>
      </div>

      <div class="bn-qpie-wrap">
        ${sevDonut}
        ${legendGrid}
      </div>

      <div class="bn-subquota">
        <div class="bn-subwell">
          <div class="bn-subhead">
            <strong>单 / 多轮</strong>
            <span>目标 ${tTgtSingle.toFixed(0)}:${(100 - tTgtSingle).toFixed(0)}</span>
          </div>
          <div class="bn-turn-col">
            ${turnWaffle}
            <div class="bn-turn-list${S.f.turn ? " has-focus" : ""}">
              <button type="button" class="bn-turn-row" data-fturn="single" aria-pressed="${S.f.turn === "single"}" data-tip="${esc(`单轮 · 池 ${pSinglePct.toFixed(0)}%`)}" style="--c:var(--accent)">
                <i></i>
                <span class="bn-tname">单轮</span>
                <b class="bn-tpct num">${sPct.toFixed(0)}%</b>
                <small class="bn-tcnt num">${fmt(singleN)}</small>
              </button>
              <button type="button" class="bn-turn-row" data-fturn="multi" aria-pressed="${S.f.turn === "multi"}" data-tip="${esc(`多轮 · 池 ${pMultiPct.toFixed(0)}%`)}" style="--c:var(--loc-ulq)">
                <i></i>
                <span class="bn-tname">多轮</span>
                <b class="bn-tpct num">${mPct.toFixed(0)}%</b>
                <small class="bn-tcnt num">${fmt(multiN)}</small>
              </button>
            </div>
          </div>
        </div>

        <div class="bn-subwell">
          <div class="bn-subhead">
            <strong>问题机制分布</strong>
            <span>${fmt(probTot)} 条 · ${mechItems.filter((x) => x.n > 0).length} / 7 类</span>
          </div>
          <div class="bn-mech-rank${S.f.l2 ? " has-focus" : ""}">
            ${mechItems.map((x) => {
              const dotPx = x.n > 0 ? 5 + (x.share / maxMechShare) * 6 : 4;
              return `<button type="button" class="bn-mrow${x.n ? "" : " is-zero"}" data-fmech="${x.m}" aria-pressed="${S.f.l2 === x.m}" data-tip="${esc(x.fullLbl)} · ${fmt(x.n)} 条 (${x.share.toFixed(1)}%)" style="--c:${x.c};--s:${dotPx.toFixed(1)}px">
                <span class="bn-mdot" aria-hidden="true"><i></i></span>
                <span class="bn-mname">${esc(x.shortLbl)}</span>
                <b class="bn-mpct num">${x.share >= 1 || x.n === 0 ? `${x.share.toFixed(0)}%` : "<1%"}</b>
                <small class="bn-mcnt num">${fmt(x.n)}</small>
              </button>`;
            }).join("")}
          </div>
        </div>
      </div>
    </section>`;
  }

  function renderDistHTML(tierData) {
    const covByDim = Object.fromEntries((tierData.coverage || []).map((c) => [c.dim, c]));
    const auditMeta = DIM_META.filter((d) => d.audit);
    const designMeta = DIM_META.filter((d) => !d.audit);
    const activeMeta = DIM_META.find((d) => d.key === S.dim) || DIM_META[0];
    const activeCov = covByDim[S.dim] || { max_abs_delta_pp: 0, by_design: !activeMeta.audit, ok: true, tolerance_pp: params.tolerance_pp };
    const isTaxDim = S.dim === "stage" || S.dim === "mechanism" || S.dim === "pattern";
    const rows = (tierData.dims?.[S.dim] || []).filter((r) => r.key && (!isTaxDim || r.key !== "NA"));
    const tol = Number(activeCov.tolerance_pp || params.tolerance_pp || 10);
    const isAudit = !activeCov.by_design;

    const filterKeyForDim = {
      day: "day", tokens: "tok", round: "rnd",
      stage: "l1", mechanism: "l2",
      pattern: "l3", turn_type: "turn", pattern_source: "psrc", severity: "sev",
    }[S.dim];

    const byCnt = [...rows].sort((a, b) => (b.count || 0) - (a.count || 0));
    const topRow = byCnt[0] || null;
    const byBias = [...rows].sort((a, b) => Math.abs(Number(b.delta_pp || 0)) - Math.abs(Number(a.delta_pp || 0)));
    const biasRow = byBias[0] || null;
    const coveredN = rows.filter((r) => (r.count || 0) > 0).length;

    const insightsHTML = rows.length ? `<div class="bn-dist-insights">
      <div class="bn-di-item"><span>维度覆盖</span><b class="num">${coveredN} / ${rows.length} 项</b></div>
      <div class="bn-di-item"><span>主导分布</span><b class="num">${topRow ? `${esc(bucketLabel(S.dim, topRow, maps))} · ${(Number(topRow.share_in_bench || 0) * 100).toFixed(1)}%` : "—"}</b></div>
      <div class="bn-di-item"><span>${isAudit ? `最大偏差 ±${tol}%` : "最大偏移"}</span><b class="num ${isAudit && biasRow && Math.abs(Number(biasRow.delta_pp || 0)) > tol ? "is-warn" : ""}">${biasRow ? `${esc(bucketLabel(S.dim, biasRow, maps))} ${Number(biasRow.delta_pp || 0) > 0 ? "+" : ""}${Number(biasRow.delta_pp || 0).toFixed(1)}%` : "—"}</b></div>
    </div>` : "";

    let bodyHTML = "";
    if (S.dim === "day" && rows.length) {
      const sorted = [...rows].sort((a, b) => String(a.key).localeCompare(String(b.key)));
      const maxShare = Math.max(0.01, ...sorted.flatMap((r) => [Number(r.share_in_bench || 0), Number(r.share_in_pool || 0)]));
      const maxAbs = Math.max(tol * 1.15, ...sorted.map((r) => Math.abs(Number(r.delta_pp || 0))), 5);
      const tolTop = 50 - (tol / maxAbs) * 46;
      const tolBot = 50 + (tol / maxAbs) * 46;
      const colsCss = `grid-template-columns: repeat(${sorted.length}, minmax(0, 1fr))`;

      // Smooth SVG baseline area + stroke for candidate pool across days
      const aw = 600;
      const ah = 100;
      const nDays = sorted.length;
      const pts = sorted.map((r, idx) => {
        const x = nDays === 1 ? aw / 2 : ((idx + 0.5) / nDays) * aw;
        const y = ah - Math.max(2, (Number(r.share_in_pool || 0) / maxShare) * (ah - 6));
        return [Number(x.toFixed(1)), Number(y.toFixed(1))];
      });
      const linePath = pts.map(([x, y], i) => `${i ? "L" : "M"}${x},${y}`).join(" ");
      const areaPath = pts.length ? `${linePath} L${pts[pts.length - 1][0]},${ah} L${pts[0][0]},${ah} Z` : "";

      bodyHTML = `<div class="bn-daychart">
        <div class="bn-dleg">
          <span class="bn-ql-item"><i class="bn-dleg-dot" style="background:var(--accent)"></i>已选占比</span>
          <span class="bn-ql-item"><i class="bn-dleg-area"></i>候选池曲线</span>
          <span class="bn-ql-item"><i class="bn-dleg-line"></i>±${tol}% 参考线</span>
        </div>
        <div class="bn-day-bars" style="${colsCss}">
          <span class="bn-day-axis is-top">${(maxShare * 100).toFixed(0)}%</span>
          <span class="bn-day-axis is-mid">${(maxShare * 50).toFixed(0)}%</span>
          <span class="bn-day-axis is-bot">0%</span>
          <svg class="bn-day-svg" viewBox="0 0 ${aw} ${ah}" preserveAspectRatio="none" aria-hidden="true">
            <line x1="0" y1="${ah / 2}" x2="${aw}" y2="${ah / 2}" class="bn-day-grid"/>
            ${areaPath ? `<path d="${areaPath}" class="bn-day-area"/>` : ""}
            ${linePath ? `<path d="${linePath}" class="bn-day-pline"/>` : ""}
          </svg>
          ${sorted.map((r) => {
            const hb = Math.max(3, (Number(r.share_in_bench || 0) / maxShare) * 100);
            const warn = Math.abs(Number(r.delta_pp || 0)) > tol;
            const dStr = String(r.key);
            const tip = `${dStr} · 已选 ${fmt(r.count)} 条 (${(r.share_in_bench * 100).toFixed(1)}%) · 候选池 ${(r.share_in_pool * 100).toFixed(1)}% · 差值 ${r.delta_pp > 0 ? "+" : ""}${r.delta_pp.toFixed(1)}%`;
            return `<button type="button" class="bn-day-col ${warn ? "is-warn" : ""}" data-dimk="day" data-dimv="${esc(dStr)}" aria-pressed="${S.f.day === dStr}" data-tip="${esc(tip)}">
              <span class="bn-day-b" style="height:${hb.toFixed(1)}%"></span>
            </button>`;
          }).join("")}
        </div>
        <div class="bn-day-ticks">
          ${(() => {
            const ticks = [];
            const step = sorted.length <= 7 ? 1 : Math.ceil((sorted.length - 1) / 5);
            for (let i = 0; i < sorted.length; i += step) ticks.push(sorted[i].key);
            if (ticks[ticks.length - 1] !== sorted[sorted.length - 1].key) {
              if (sorted.length > 7 && ticks.length >= 2) ticks[ticks.length - 1] = sorted[sorted.length - 1].key;
              else ticks.push(sorted[sorted.length - 1].key);
            }
            return ticks.map((d) => `<span>${esc(String(d).slice(5))}</span>`).join("");
          })()}
        </div>
        <div class="bn-day-div" style="${colsCss}">
          <span class="bn-day-axis is-top">+${tol}%</span>
          <span class="bn-day-axis is-mid">0</span>
          <span class="bn-day-axis is-bot">−${tol}%</span>
          <div class="bn-day-tol" style="top:${tolTop.toFixed(1)}%"></div>
          <div class="bn-day-zero"></div>
          <div class="bn-day-tol" style="top:${tolBot.toFixed(1)}%"></div>
          ${sorted.map((r) => {
            const dp = Number(r.delta_pp || 0);
            const warn = Math.abs(dp) > tol;
            const mag = Math.min(46, Math.max(2, (Math.abs(dp) / maxAbs) * 46));
            const style = dp >= 0 ? `bottom:50%;height:${mag.toFixed(1)}%` : `top:50%;height:${mag.toFixed(1)}%`;
            const tip = `${r.key} · 差值 ${dp > 0 ? "+" : ""}${dp.toFixed(1)}%`;
            return `<button type="button" class="bn-day-dcol" data-dimk="day" data-dimv="${esc(r.key)}" aria-pressed="${S.f.day === r.key}" data-tip="${esc(tip)}">
              <span class="bn-day-dbar ${warn ? "is-warn" : ""}" style="${style}"></span>
            </button>`;
          }).join("")}
        </div>
      </div>`;
    } else if ((S.dim === "severity" || S.dim === "mechanism") && rows.length) {
      const displayRows = S.dim === "severity"
        ? SEVS_ALL.map((s) => rows.find((r) => r.key === s)).filter(Boolean)
        : MECH_ORDER.map((m) => rows.find((r) => r.key === m)).filter(Boolean).concat(
            rows.filter((r) => !MECH_ORDER.includes(r.key)),
          );
      const maxS = Math.max(0.12, ...displayRows.flatMap((r) => [Number(r.share_in_bench || 0), Number(r.share_in_pool || 0)])) * 1.08;
      const midPct = ((maxS * 50)).toFixed(0);
      const maxPct = ((maxS * 100)).toFixed(0);
      const mechColorMap = Object.fromEntries(MECH_ORDER.map((m, i) => [m, MECH_PALETTE[i % MECH_PALETTE.length]]));

      bodyHTML = `<div class="bn-dbell-wrap">
        <div class="bn-dleg">
          <span class="bn-ql-item"><i class="bn-dleg-dot is-ring"></i>候选池</span>
          <span class="bn-ql-item"><i class="bn-dleg-dot is-solid"></i>已选</span>
        </div>
        <div class="bn-dbell-axis-row">
          <span></span>
          <div class="bn-dbell-scale num"><span>0%</span><span>${midPct}%</span><span>${maxPct}%</span></div>
          <span class="bn-dbell-hcol">已选</span>
          <span class="bn-dbell-hcol">偏差</span>
          <span class="bn-dbell-hcol">倍率</span>
          <span class="bn-dbell-hcol">条数</span>
        </div>
        <div class="bn-dbell-list">
          ${displayRows.map((r) => {
            const sb = Number(r.share_in_bench || 0);
            const sp = Number(r.share_in_pool || 0);
            const dp = Number(r.delta_pp || 0);
            const lift = sp > 0.0005 ? sb / sp : null;
            const posB = Math.min(97, Math.max(2, (sb / maxS) * 100));
            const posP = Math.min(97, Math.max(2, (sp / maxS) * 100));
            const segLeft = Math.min(posB, posP);
            const segWidth = Math.max(1, Math.abs(posB - posP));
            const tone = S.dim === "severity" ? sevTone(r.key) : (mechColorMap[r.key] || "var(--accent)");
            const warn = isAudit && Math.abs(dp) > tol;
            const pressed = filterKeyForDim && S.f[filterKeyForDim] === r.key;
            const bLabel = bucketLabel(S.dim, r, maps);
            const liftText = lift == null ? "—" : lift >= 10 ? `${lift.toFixed(0)}×` : `${lift.toFixed(1)}×`;
            const tip = `${bLabel} · 已选 ${(sb * 100).toFixed(1)}% (${fmt(r.count)} 条) · 候选池 ${(sp * 100).toFixed(1)}% · ${liftText}`;
            return `<button type="button" class="bn-dbell-row" data-dimk="${filterKeyForDim || ""}" data-dimv="${esc(r.key)}" aria-pressed="${pressed}" data-tip="${esc(tip)}" style="--c:${tone}">
              <span class="bn-dbell-lbl"><i></i>${esc(bLabel)}</span>
              <span class="bn-dbell-track">
                <i class="bn-dbell-g"></i>
                <i class="bn-dbell-beam" style="left:${segLeft.toFixed(2)}%;width:${segWidth.toFixed(2)}%"></i>
                <i class="bn-dbell-pdot" style="left:${posP.toFixed(2)}%"></i>
                <i class="bn-dbell-bdot" style="left:${posB.toFixed(2)}%"></i>
              </span>
              <b class="bn-dbell-val num">${(sb * 100).toFixed(1)}%</b>
              <span class="bn-db-pp ${warn ? "is-warn" : dp >= 0 ? "is-pos" : ""} num">${dp > 0 ? "+" : ""}${dp.toFixed(1)}%</span>
              <span class="bn-dbell-lift ${lift != null && lift >= 1.5 ? "is-up" : ""} num">${liftText}</span>
              <span class="bn-dbell-cnt num">${fmt(r.count)}</span>
            </button>`;
          }).join("")}
        </div>
      </div>`;
    } else if (S.dim === "round" && rows.length) {
      const roundOrder = ["1", "2-3", "4-10", "11+"];
      const displayRows = roundOrder
        .map((k) => rows.find((r) => String(r.key) === k))
        .filter(Boolean)
        .concat(rows.filter((r) => !roundOrder.includes(String(r.key))));
      const maxS = Math.max(0.1, ...displayRows.flatMap((r) => [Number(r.share_in_bench || 0), Number(r.share_in_pool || 0)]));
      let accB = 0;
      const cumRows = displayRows.map((r) => {
        accB = Math.min(1, accB + Number(r.share_in_bench || 0));
        return { r, cumB: accB };
      });
      const nCols = cumRows.length;
      const cw = 400;
      const ch = 120;
      const cPts = cumRows.map((x, idx) => {
        const px = ((idx + 0.5) / nCols) * cw;
        const py = ch - 12 - x.cumB * (ch - 26);
        return { x: px, y: py, cum: x.cumB * 100 };
      });
      const polyPts = cPts.map((pt) => `${pt.x.toFixed(1)},${pt.y.toFixed(1)}`).join(" ");

      bodyHTML = `<div class="bn-rcum-wrap">
        <div class="bn-dleg">
          <span class="bn-ql-item"><i class="bn-dleg-dot" style="background:var(--accent)"></i>已选</span>
          <span class="bn-ql-item"><i class="bn-dleg-dot" style="background:var(--t3)"></i>候选池</span>
          <span class="bn-ql-item"><i class="bn-dleg-cline"></i>累计占比</span>
        </div>
        <div class="bn-rcum-stage">
          <svg class="bn-rcum-svg" viewBox="0 0 ${cw} ${ch}" preserveAspectRatio="none" aria-hidden="true">
            <line x1="0" y1="${ch - 12}" x2="${cw}" y2="${ch - 12}" class="bn-day-grid"/>
            <line x1="0" y1="${ch / 2 - 4}" x2="${cw}" y2="${ch / 2 - 4}" class="bn-day-grid"/>
            ${polyPts ? `<polyline points="${polyPts}" class="bn-rcum-line"/>` : ""}
          </svg>
          <div class="bn-rcum-cols" style="grid-template-columns:repeat(${nCols}, minmax(0, 1fr))">
            ${cumRows.map(({ r, cumB }) => {
              const sb = Number(r.share_in_bench || 0);
              const sp = Number(r.share_in_pool || 0);
              const dp = Number(r.delta_pp || 0);
              const hb = Math.max(4, (sb / maxS) * 100);
              const hp = Math.max(4, (sp / maxS) * 100);
              const warn = Math.abs(dp) > tol;
              const pressed = S.f.rnd === r.key;
              const bLabel = bucketLabel("round", r, maps);
              const tip = `${bLabel} · 已选 ${(sb * 100).toFixed(1)}% · 候选池 ${(sp * 100).toFixed(1)}% · 累计 ${(cumB * 100).toFixed(1)}%`;
              return `<button type="button" class="bn-vcol ${warn ? "is-warn" : ""}" data-dimk="rnd" data-dimv="${esc(r.key)}" aria-pressed="${pressed}" data-tip="${esc(tip)}">
                <span class="bn-vcol-cum num">${(cumB * 100).toFixed(0)}%</span>
                <div class="bn-vcol-bars">
                  <span class="bn-vcol-b" style="height:${hb.toFixed(1)}%;background:${warn ? "var(--sev-1)" : "var(--accent)"}"></span>
                  <span class="bn-vcol-p" style="height:${hp.toFixed(1)}%"></span>
                </div>
                <span class="bn-vcol-dp ${warn ? "is-warn" : "is-ok"} num">${dp > 0 ? "+" : ""}${dp.toFixed(1)}%</span>
                <span class="bn-vcol-lbl">${esc(bLabel)}</span>
                <span class="bn-vcol-cnt num">${fmt(r.count)} (${(sb * 100).toFixed(1)}%)</span>
              </button>`;
            }).join("")}
          </div>
        </div>
      </div>`;
    } else if (S.dim === "turn_type" && rows.length) {
      const sRow = rows.find((r) => r.key === "single") || rows[0];
      const mRow = rows.find((r) => r.key === "multi") || rows[1] || { key: "multi", count: 0, share_in_bench: 0, share_in_pool: 0, delta_pp: 0 };
      const sbS = Number(sRow?.share_in_bench || 0) * 100;
      const sbM = Number(mRow?.share_in_bench || 0) * 100;
      const spS = Number(sRow?.share_in_pool || 0) * 100;
      const spM = Number(mRow?.share_in_pool || 0) * 100;

      const benchRing = svgDonutHTML(
        [
          { value: sbS, color: "var(--accent)", active: S.f.turn === "single", attr: 'data-dimk="turn" data-dimv="single"', tip: `已选单轮 · ${sbS.toFixed(1)}%` },
          { value: sbM, color: "var(--loc-ulq)", active: S.f.turn === "multi", attr: 'data-dimk="turn" data-dimv="multi"', tip: `已选多轮 · ${sbM.toFixed(1)}%` },
        ],
        { size: 112, rOut: 48, rIn: 31, centerVal: `${(S.f.turn === "multi" ? sbM : sbS).toFixed(0)}%`, centerSub: "已选" },
      );
      const poolRing = svgDonutHTML(
        [
          { value: spS, color: "var(--accent)", active: S.f.turn === "single", attr: 'data-dimk="turn" data-dimv="single"', tip: `候选池单轮 · ${spS.toFixed(1)}%` },
          { value: spM, color: "var(--loc-ulq)", active: S.f.turn === "multi", attr: 'data-dimk="turn" data-dimv="multi"', tip: `候选池多轮 · ${spM.toFixed(1)}%` },
        ],
        { size: 112, rOut: 48, rIn: 31, centerVal: `${(S.f.turn === "multi" ? spM : spS).toFixed(0)}%`, centerSub: "候选池" },
      );
      const tItems = [
        { key: "single", lbl: "单轮对话", c: "var(--accent)", row: sRow, b: sbS, p: spS },
        { key: "multi", lbl: "多轮对话", c: "var(--loc-ulq)", row: mRow, b: sbM, p: spM },
      ];
      bodyHTML = `<div class="bn-tcmp-wrap">
        <div class="bn-tcmp-rings">
          ${benchRing}
          <span class="bn-tcmp-vs">vs</span>
          ${poolRing}
        </div>
        <div class="bn-tcmp-rows">
          ${tItems.map((it) => {
            const dp = Number(it.row?.delta_pp || 0);
            const cnt = Number(it.row?.count || 0);
            const pressed = S.f.turn === it.key;
            return `<button type="button" class="bn-tcmp-row" data-dimk="turn" data-dimv="${it.key}" aria-pressed="${pressed}" style="--c:${it.c}">
              <span class="bn-tcmp-lbl"><i></i>${it.lbl}</span>
              <span class="bn-tcmp-vals num"><b>${it.b.toFixed(1)}%</b><small>池 ${it.p.toFixed(1)}%</small></span>
              <span class="bn-db-pp ${dp >= 0 ? "is-pos" : ""} num">${dp > 0 ? "+" : ""}${dp.toFixed(1)}%</span>
              <span class="bn-dbell-cnt num">${fmt(cnt)} 条</span>
            </button>`;
          }).join("")}
        </div>
      </div>`;
    } else if (rows.length && rows.length <= 8) {
      const maxS = Math.max(0.05, ...byCnt.flatMap((r) => [Number(r.share_in_bench || 0), Number(r.share_in_pool || 0)]));
      bodyHTML = `<div class="bn-vcols-wrap">
        <div class="bn-dleg">
          <span class="bn-ql-item"><i class="bn-dleg-dot" style="background:var(--accent)"></i>已选占比</span>
          <span class="bn-ql-item"><i class="bn-dleg-dot" style="background:var(--t3)"></i>候选池占比</span>
        </div>
        <div class="bn-vcols" style="grid-template-columns:repeat(${byCnt.length}, minmax(0, 1fr))">
          ${byCnt.map((r) => {
            const sb = Number(r.share_in_bench || 0);
            const sp = Number(r.share_in_pool || 0);
            const dp = Number(r.delta_pp || 0);
            const hb = Math.max(4, (sb / maxS) * 100);
            const hp = Math.max(4, (sp / maxS) * 100);
            const pressed = filterKeyForDim && S.f[filterKeyForDim] === r.key;
            const bLabel = bucketLabel(S.dim, r, maps);
            const tip = `${bLabel} · 已选 ${fmt(r.count)} 条 (${(sb * 100).toFixed(1)}%) · 候选池 ${(sp * 100).toFixed(1)}% · 差值 ${dp > 0 ? "+" : ""}${dp.toFixed(1)}%`;
            return `<button type="button" class="bn-vcol" data-dimk="${filterKeyForDim || ""}" data-dimv="${esc(r.key)}" aria-pressed="${pressed}" data-tip="${esc(tip)}">
              <span class="bn-vcol-top num">${(sb * 100).toFixed(1)}%</span>
              <div class="bn-vcol-bars">
                <span class="bn-vcol-b" style="height:${hb.toFixed(1)}%;background:var(--accent)"></span>
                <span class="bn-vcol-p" style="height:${hp.toFixed(1)}%"></span>
              </div>
              <span class="bn-vcol-dp num">${dp > 0 ? "+" : ""}${dp.toFixed(1)}%</span>
              <span class="bn-vcol-lbl" title="${esc(bLabel)}">${esc(bLabel)}</span>
              <span class="bn-vcol-cnt num">${fmt(r.count)}</span>
            </button>`;
          }).join("")}
        </div>
      </div>`;
    } else if (rows.length) {
      const displayRows = byCnt.slice(0, 30);
      const maxS = Math.max(0.05, ...displayRows.flatMap((r) => [Number(r.share_in_bench || 0), Number(r.share_in_pool || 0)]));
      const maxAbsBias = Math.max(tol, 5, ...displayRows.map((r) => Math.abs(Number(r.delta_pp || 0))));
      bodyHTML = `<div class="bn-hs-head">
        <span>分布项</span><span>已选 / 候选池占比</span><span>偏差幅度</span><span style="text-align:right">条数</span>
      </div>
      <div class="bn-dist-body">
        ${displayRows.map((r) => {
          const sb = Number(r.share_in_bench || 0);
          const sp = Number(r.share_in_pool || 0);
          const dp = Number(r.delta_pp || 0);
          const wBench = Math.min(100, (sb / maxS) * 100);
          const wPool = Math.min(100, (sp / maxS) * 100);
          const mag = Math.min(48, Math.max(3, (Math.abs(dp) / maxAbsBias) * 48));
          const biasStyle = dp >= 0 ? `left:50%;width:${mag.toFixed(1)}%` : `right:50%;width:${mag.toFixed(1)}%`;
          const cls = isAudit ? (Math.abs(dp) > tol ? "is-warn" : "is-ok") : dp >= 0 ? "is-pos" : "is-neg";
          const pressed = filterKeyForDim && S.f[filterKeyForDim] === r.key;
          const bLabel = bucketLabel(S.dim, r, maps);
          const tip = `${bLabel} · 已选 ${fmt(r.count)} 条 (${(sb * 100).toFixed(1)}%) · 候选池 ${(sp * 100).toFixed(1)}% · 差值 ${dp > 0 ? "+" : ""}${dp.toFixed(1)}%`;
          return `<button type="button" class="bn-hs-row" data-dimk="${filterKeyForDim || ""}" data-dimv="${esc(r.key)}" aria-pressed="${pressed}" data-tip="${esc(tip)}">
            <span class="bn-hs-lbl" title="${esc(bLabel)}">${esc(bLabel)}</span>
            <div class="bn-hs-bars">
              <div class="bn-hs-pair">
                <span class="bn-hs-b" style="width:${wBench.toFixed(1)}%"></span>
                <span class="bn-hs-p" style="width:${wPool.toFixed(1)}%"></span>
              </div>
              <span class="bn-hs-pct num"><b>${(sb * 100).toFixed(1)}%</b><small>${(sp * 100).toFixed(1)}%</small></span>
            </div>
            <div class="bn-hs-bias">
              <div class="bn-hs-div"><span class="bn-hs-zero"></span><span class="bn-hs-dfill ${cls}" style="${biasStyle}"></span></div>
              <span class="bn-db-pp ${cls} num">${dp > 0 ? "+" : ""}${dp.toFixed(1)}%</span>
            </div>
            <span class="bn-db-cnt num">${fmt(r.count)}</span>
          </button>`;
        }).join("")}
      </div>`;
    } else {
      bodyHTML = `<div class="bn-empty">暂无维度统计</div>`;
    }

    const pillBtn = (d) => {
      const cv = covByDim[d.key];
      const maxPp = cv ? Number(cv.max_abs_delta_pp || 0) : 0;
      const warn = d.audit && cv && cv.ok === false;
      return `<button type="button" class="bn-dim-btn ${S.dim === d.key ? "is-on" : ""} ${warn ? "is-warn" : ""} ${d.audit ? "" : "is-design"}" data-dimpick="${d.key}">
        <span>${d.label}</span>
        ${d.audit && cv ? `<span class="bn-dim-pp">${maxPp.toFixed(1)}%</span>` : ""}
      </button>`;
    };

    const toks = tierData.tokens || {};
    const extra = tierData.extra || {};
    const p50Show = extra.known_tokens_p50 > 0 ? extra.known_tokens_p50 : (toks.p50 || 0);
    const p90Show = extra.known_tokens_p90 > 0 ? extra.known_tokens_p90 : (toks.p90 || 0);

    const bodyStageHTML = `<div class="bn-dist-stage${bodyHTML.includes("bn-dist-body") ? " is-scroll" : ""}">${bodyHTML}</div>`;

    return `<section class="card bn-dist-card">
      <div class="card-head">
        <h2>数据分布与偏差</h2>
      </div>
      <div class="bn-dimgroups">
        ${auditMeta.map(pillBtn).join("")}
        <span class="bn-dim-sep" aria-hidden="true"></span>
        ${designMeta.map(pillBtn).join("")}
      </div>
      ${insightsHTML}
      ${bodyStageHTML}
      <div class="bn-scale-strip">
        <div class="bn-scell"><span>已知长度中位</span><b>${p50Show ? compact(p50Show) : "—"}</b></div>
        <div class="bn-scell"><span>已知长度 P90</span><b>${p90Show ? compact(p90Show) : "—"}</b></div>
        <div class="bn-scell"><span>工具调用率</span><b>${extra.with_tool_rate != null ? `${(extra.with_tool_rate * 100).toFixed(1)}%` : "—"}</b></div>
        <div class="bn-scell"><span>平均耗时</span><b>${extra.avg_latency != null ? `${extra.avg_latency}s` : "—"}</b></div>
        <button type="button" class="bn-scell" id="bn-dup-btn" aria-pressed="${S.f.dupOnly}"><span>高频重问 ≥2</span><b>${extra.dup_ge2_count != null ? fmt(extra.dup_ge2_count) : "—"}</b></button>
      </div>
    </section>`;
  }

  function renderMatrixHTML(tierData) {
    const ct = tierData.crosstab || {};
    const rows = ct.rows || {};
    const totals = ct.totals || {};
    const sIds = (ct.stages?.length ? ct.stages : Object.keys(rows)).filter((s) => s && s !== "NA");
    const mIds = (ct.mechanisms?.length ? ct.mechanisms : MECH_ORDER).filter((m) => m && m !== "NA");

    const maxCell = Math.max(1, ...sIds.flatMap((s) => mIds.map((m) => {
      const b = Number(rows[s]?.[m] || 0);
      if (S.mxMode === "share") {
        const pt = Number(rows[s]?.pool_total || 0);
        return pt ? b / pt : 0;
      }
      return b;
    })));
    const rowTot = (s) => sum(mIds.map((m) => Number(rows[s]?.[m] || 0)));
    const colTot = (m) => sum(sIds.map((s) => Number(rows[s]?.[m] || 0)));
    const grandTot = sum(sIds.map(rowTot));
    const totalActual = Number(tierData.actual || 0);
    const totalPool = sum(sIds.map((s) => Number(rows[s]?.pool_total || 0))) || Number(totals.pool_total || 0);

    return `<section class="card bn-mx-card">
      <div class="card-head">
        <h2>环节 × 机制</h2>
        <span class="bn-count-pill">问题 ${fmt(grandTot)}${totalActual ? ` / ${fmt(totalActual)}` : ""}</span>
        <div class="seg end" id="bn-seg-mx" role="group">
          <span class="seg-knob" aria-hidden="true"></span>
          <button type="button" data-value="bench" aria-pressed="${S.mxMode === "bench"}">数量</button>
          <button type="button" data-value="share" aria-pressed="${S.mxMode === "share"}">占池比</button>
        </div>
      </div>
      <div class="matrix bn-matrix" style="--rows:${sIds.length};--cols:${mIds.length}">
        <div class="mx-rows">
          <div class="mx-corner">环节</div>
          ${sIds.map((s) => {
            const label = ct.stage_names?.[s] && ct.stage_names[s] !== "NA" ? ct.stage_names[s] : stageLabel(s, stageNames);
            const hl = S.f.l1 === s;
            const tip = `${label} · 已选 ${fmt(rowTot(s))} · 候选池 ${fmt(rows[s]?.pool_total || 0)}`;
            return `<button type="button" class="rh ${hl ? "is-hl" : ""}" data-mxs="${esc(s)}" data-tip="${esc(tip)}">
              <span class="mx-lab">${esc(label)}</span>
              <i class="mx-caret" aria-hidden="true"></i>
            </button>`;
          }).join("")}
          <div class="rh mx-total-lab"><span class="mx-lab">合计</span></div>
        </div>

        <div class="mx-scroll">
          <div class="mx-grid">
            ${mIds.map((m) => {
              const hl = S.f.l2 === m;
              const fullLbl = mechLabel(m, mechNames);
              const shortLbl = mechLabel(m, mechNames, true);
              const tip = `${fullLbl} · 已选 ${fmt(colTot(m))} 条`;
              return `<button type="button" class="mh ${hl ? "is-hl" : ""}" data-mxm="${esc(m)}" data-tip="${esc(tip)}">
                <span>${esc(shortLbl)}</span>
              </button>`;
            }).join("")}

            ${sIds.map((s) => mIds.map((m) => {
              const b = Number(rows[s]?.[m] || 0);
              const pt = Number(rows[s]?.pool_total || 0);
              const val = S.mxMode === "share" ? (pt ? b / pt : 0) : b;
              const ratio = maxCell ? val / maxCell : 0;
              const mix = b ? Math.round(8 + ratio * 38) : 0;
              const cur = S.f.l1 === s && S.f.l2 === m;
              const bg = b ? `background: color-mix(in oklab, var(--accent) ${mix}%, var(--well))` : "";
              const display = !b ? "·" : S.mxMode === "share" ? (pt ? `${((b / pt) * 100).toFixed(1)}%` : fmt(b)) : fmt(b);
              const sLbl = ct.stage_names?.[s] || stageLabel(s, stageNames);
              const mLbl = mechLabel(m, mechNames);
              const tip = `${sLbl} × ${mLbl} · 已选 ${fmt(b)} 条 · 环节候选池 ${fmt(pt)}`;
              return `<button type="button" class="cell ${b ? "" : "is-empty"} ${cur ? "is-cur" : ""} ${ratio > 0.68 ? "hot" : ""}" style="${bg}" data-mxs="${esc(s)}" data-mxm="${esc(m)}" ${b ? `data-tip="${esc(tip)}"` : "disabled"}>
                <span class="cell-main"><b>${display}</b></span>
              </button>`;
            }).join("")).join("")}

            ${mIds.map((m) => {
              const tot = colTot(m);
              const hl = S.f.l2 === m;
              return `<button type="button" class="coltot ${hl ? "is-hl" : ""}" data-mxm="${esc(m)}">${fmt(tot)}</button>`;
            }).join("")}
          </div>
        </div>

        <div class="mx-tots">
          <div class="rowtot-head"><span>已选</span><span>池</span></div>
          ${sIds.map((s) => {
            const bt = rowTot(s);
            const pt = Number(rows[s]?.pool_total || 0);
            return `<button type="button" class="rowtot ${S.f.l1 === s ? "is-hl" : ""}" data-mxs="${esc(s)}" data-tip="已选 ${fmt(bt)} · 候选池 ${fmt(pt)}">
              <b>${fmt(bt)}</b><small class="bn-pool-n">${compact(pt)}</small>
            </button>`;
          }).join("")}
          <div class="rowtot-foot"><b>${fmt(grandTot)}</b><small class="bn-pool-n">${compact(totalPool)}</small></div>
        </div>
      </div>
    </section>`;
  }

  let fieldGroupsCache = [];
  let fieldResizeObs = null;
  let mxResizeObs = null;

  function paintBenchField(card) {
    const fieldEl = $(".bn-field", card);
    if (!fieldEl || !fieldGroupsCache.length) return;
    const grpEls = $$(".bn-fgrp", fieldEl);
    if (!grpEls.length) return;
    const cols = Math.max(1, getComputedStyle(fieldEl).gridTemplateColumns.split(" ").filter(Boolean).length);
    const groupRows = Math.max(1, Math.ceil(fieldGroupsCache.length / cols));
    const FIELD_ROWS = 16;
    const FIELD_TILE = 13; // 11px tile + 2px gap
    const rows = Math.max(4, Math.floor(FIELD_ROWS / groupRows));

    fieldGroupsCache.forEach((g, gi) => {
      const grpEl = grpEls[gi];
      const tilesEl = grpEl && $(".bn-ftiles", grpEl);
      const pagerEl = grpEl && $(".bn-field-pager", grpEl);
      if (!tilesEl) return;
      const perRow = Math.max(1, Math.floor((tilesEl.clientWidth + 2) / FIELD_TILE));
      const capacity = Math.max(1, perRow * rows);
      const pages = Math.max(1, Math.ceil(g.items.length / capacity));
      const cur = Math.min(Math.max(1, S.fieldPages[g.key] || 1), pages);
      S.fieldPages[g.key] = cur;
      const usedRows = Math.min(rows, Math.ceil(g.items.length / perRow));
      tilesEl.style.minHeight = `${Math.max(0, usedRows * FIELD_TILE - 2)}px`;
      const slice = g.items.slice((cur - 1) * capacity, cur * capacity);
      tilesEl.innerHTML = slice.map((c) => {
        const col = sevTone(c.severity);
        const pLbl = c.primary?.label || (c.severity === "GOLD" ? "goldencase" : stageLabel(c.primary?.l1, stageNames));
        const tip = `${sevLabel(c.severity)} · ${pLbl} · ${compact(c.stats?.total_tokens || 0)}\n${c.question}`;
        return `<button type="button" class="bn-ftile ${(c.stats?.dup_question || 1) >= 2 ? "is-dup" : ""}" data-trace="${esc(c.trace_id)}" aria-current="${S.trace === c.trace_id}" style="--c:${col}" data-tip="${esc(tip)}"></button>`;
      }).join("");
      if (!pagerEl) return;
      pagerEl.hidden = pages <= 1;
      if (pages > 1) {
        pagerEl.innerHTML = `<button type="button" data-fg="${esc(g.key)}" data-fdir="prev" ${cur <= 1 ? "disabled" : ""}>上一页</button>
          <span class="bn-fpager-info">第 <b class="num">${cur}</b> / ${pages} 页 · ${fmt(g.items.length)} 条</span>
          <button type="button" data-fg="${esc(g.key)}" data-fdir="next" ${cur >= pages ? "disabled" : ""}>下一页</button>`;
      } else {
        pagerEl.innerHTML = "";
      }
    });
  }

  function renderCasesHTML(allCases, filteredCases, tierData) {
    const chips = activeFilterPills(S.f, maps);
    const total = filteredCases.length;
    const isField = S.view === "field";
    const pages = Math.max(1, Math.ceil(total / S.size));
    S.page = Math.max(1, Math.min(pages, S.page));
    const slice = isField ? [] : filteredCases.slice((S.page - 1) * S.size, S.page * S.size);
    const moreCount = [S.f.l1, S.f.l2, S.f.turn, S.f.tok, S.f.dupOnly ? "1" : ""].filter(Boolean).length;
    fieldGroupsCache = isField ? groupFieldCases(filteredCases, S.groupBy, stageNames) : [];

    const optList = (dimKey, label, curVal) => {
      let list = (tierData.dims?.[dimKey] || []).filter((r) => (r.count || 0) > 0 && r.key && r.key !== "NA");
      if (!list.length && dimKey === "tokens") {
        const cntMap = new Map();
        allCases.forEach((c) => {
          const bk = tokBucketKey(c.stats?.total_tokens);
          cntMap.set(bk, (cntMap.get(bk) || 0) + 1);
        });
        list = ["<8k", "8-32k", "32-64k", "64-128k", ">=128k", "unknown"]
          .filter((k) => (cntMap.get(k) || 0) > 0)
          .map((k) => ({ key: k, count: cntMap.get(k) }));
      }
      return `<select class="bn-sel ${curVal ? "is-on" : ""}" data-fsel="${dimKey}" aria-label="${label}">
        <option value="">${label}</option>
        ${list.map((r) => `<option value="${esc(r.key)}" ${curVal === r.key ? "selected" : ""}>${esc(bucketLabel(dimKey, r, maps))} (${fmt(r.count)})</option>`).join("")}
      </select>`;
    };

    const pagerHTML = !isField && total ? `<div class="bn-pager">
      <div class="bn-pager-btns">
        <button type="button" data-page="first" ${S.page <= 1 ? "disabled" : ""}>首页</button>
        <button type="button" data-page="prev" ${S.page <= 1 ? "disabled" : ""}>上一页</button>
        <span class="bn-pager-info">${S.page} / ${pages}</span>
        <button type="button" data-page="next" ${S.page >= pages ? "disabled" : ""}>下一页</button>
        <button type="button" data-page="last" ${S.page >= pages ? "disabled" : ""}>末页</button>
      </div>
      <div class="bn-pager-btns">
        <span class="bn-pager-info">${fmt((S.page - 1) * S.size + 1)}–${fmt(Math.min(S.page * S.size, total))} / ${fmt(total)} 条</span>
        <select class="bn-sel" id="bn-pagesize" aria-label="每页条数">
          ${[25, 50, 100].map((n) => `<option value="${n}" ${S.size === n ? "selected" : ""}>${n} 条/页</option>`).join("")}
        </select>
      </div>
    </div>` : "";

    const bodyHTML = !filteredCases.length
      ? `<div class="bn-empty">暂无匹配问句</div>`
      : isField
        ? `<div class="bn-field field-groups">
            ${fieldGroupsCache.map((g) => `<div class="bn-fgrp fgroup" data-fkey="${esc(g.key)}">
              <div class="fgroup-head"><b>${esc(g.label)}</b><span class="num">${fmt(g.items.length)} 条</span></div>
              <div class="bn-ftiles tiles"></div>
              <div class="bn-field-pager field-pager" hidden></div>
            </div>`).join("")}
          </div>`
        : `<div class="bn-list">
            <div class="bn-lhead"><span>等级</span><span>问句内容</span><span>问题归因</span><span>形态 · 工具</span><span style="text-align:right">规模 · 耗时</span><span style="text-align:right">基准档位</span></div>
            ${slice.map((c) => {
              const col = sevTone(c.severity);
              const st = c.stats || {};
              const pr = c.primary || {};
              const pCount = rowProbsCount(c);
              const isLongCase = (st.total_tokens || 0) >= (params.long_tokens || 65536);
              const tTag = c.bench?.long_tier ? `长 ${c.bench.long_tier}` : `${fmt(c.bench?.min_tier || c.bench?.tier || S.tier)} 档`;
              const turnTxt = c.turn === "multi" ? `多轮 ${c.session_round || 2} 轮` : "单轮";
              const stName = pr.l1 && pr.l1 !== "NA" ? stageLabel(pr.l1, stageNames) : "";
              const patName = pr.l3 && pr.l3 !== "NA" ? patternDisplayName(pr.l3, "", patNames, stageNames, mechNames) : "";
              const attrMain = !stName ? (pr.label && pr.label !== "goldencase" ? pr.label : "无问题")
                : (patName && patName !== stName ? (patName.startsWith(`${stName} ·`) ? patName : `${stName} · ${patName}`) : stName);
              const extraLbl = pr.label && pr.label !== "goldencase" && pr.label !== patName && pr.label !== attrMain ? pr.label : "";
              const hasFlags = (st.dup_question || 1) >= 2 || isLongCase;
              return `<button type="button" class="bn-lrow" data-trace="${esc(c.trace_id)}" aria-current="${S.trace === c.trace_id}" style="--c:${col}">
                <span class="bn-sev-tag" style="--c:${col}">${esc(sevLabel(c.severity))}</span>
                <div class="bn-lq">
                  <span class="bn-lq-txt" title="${esc(c.question)}">${esc(c.question)}</span>
                  ${hasFlags ? `<span class="bn-lq-flags">
                    ${(st.dup_question || 1) >= 2 ? `<span class="bn-mtag is-dup">×${st.dup_question} 重问</span>` : ""}
                    ${isLongCase ? `<span class="bn-mtag is-long">≥64K</span>` : ""}
                  </span>` : ""}
                </div>
                <div class="bn-lpat">
                  <span class="bn-lpat-main ${!stName && !extraLbl ? "is-none" : ""}" title="${esc(extraLbl ? `${attrMain} · ${extraLbl}` : attrMain)}">${esc(attrMain)}</span>
                  ${pCount > 1 ? `<span class="bn-mtag">+${pCount - 1}</span>` : ""}
                </div>
                <span class="bn-cell-meta">${turnTxt} · ${st.tool_count || 0} 工具</span>
                <span class="bn-cell-meta bn-lscale"><b>${st.total_tokens ? compact(st.total_tokens) : "—"}</b><em>${st.latency || 0}s</em></span>
                <span class="bn-tier-col">
                  <span class="bn-tier-tag">${tTag}</span>
                  ${c.slug ? '<span class="bn-loc-dot" title="已入库可跳转"></span>' : ""}
                </span>
              </button>`;
            }).join("")}
          </div>
          ${pagerHTML}`;

    return `<section class="card bn-cases-card">
      <div class="bn-fbar">
        <span class="bn-fbar-title">问句全景</span>
        <span class="bn-count-pill">${fmt(filteredCases.length)} / ${fmt(allCases.length)}</span>
        <input type="text" class="bn-search" id="bn-search" value="${esc(S.f.q)}" placeholder="搜索问句 / 标签…" autocomplete="off">
        <div class="bn-sev-pills">
          <button type="button" class="bn-sev-pill" data-fsev="" aria-pressed="${!S.f.sev}">全部</button>
          ${SEVS_ALL.map((s) => `<button type="button" class="bn-sev-pill" data-fsev="${s}" aria-pressed="${S.f.sev === s}" style="--c:${sevTone(s)}"><i></i>${sevLabel(s)}</button>`).join("")}
        </div>
        <div class="bn-more-wrap ${S.moreOpen ? "is-open" : ""}" id="bn-more-wrap">
          <button type="button" class="bn-more-toggle ${moreCount ? "has-active" : ""}" id="bn-more-toggle" aria-haspopup="true" aria-expanded="${S.moreOpen}">
            <span class="bn-more-plus" aria-hidden="true"></span>
            <span>更多筛选</span>
            ${moreCount ? `<span class="bn-more-badge">${moreCount}</span>` : ""}
          </button>
          <div class="bn-more-pop ${S.moreOpen ? "is-open" : ""}" id="bn-more-pop" ${S.moreOpen ? "" : "inert"}>
            <div class="bn-more-grid">
              <label class="bn-more-field"><span>问题环节</span>${optList("stage", "全部环节", S.f.l1)}</label>
              <label class="bn-more-field"><span>问题机制</span>${optList("mechanism", "全部机制", S.f.l2)}</label>
              <label class="bn-more-field"><span>对话形态</span>${optList("turn_type", "全部形态", S.f.turn)}</label>
              <label class="bn-more-field"><span>文本长度</span>${optList("tokens", "全部长度", S.f.tok)}</label>
            </div>
            <div class="bn-more-foot">
              <button type="button" class="bn-toggle-pill" id="bn-tog-dup" aria-pressed="${S.f.dupOnly}">仅看高频重问 ≥2</button>
              ${moreCount ? `<button type="button" class="bn-chip-clear" id="bn-more-clr">清空筛选</button>` : ""}
            </div>
          </div>
        </div>
        <div class="bn-fbar-end">
          <div class="seg" id="bn-seg-view" role="group" aria-label="展示方式">
            <span class="seg-knob" aria-hidden="true"></span>
            <button type="button" data-value="list" aria-pressed="${!isField}">清单</button>
            <button type="button" data-value="field" aria-pressed="${isField}">方阵</button>
          </div>
          ${isField ? `<select class="bn-sel" id="bn-groupby" aria-label="分组维度">
            <option value="l1" ${S.groupBy === "l1" ? "selected" : ""}>按环节</option>
            <option value="sev" ${S.groupBy === "sev" ? "selected" : ""}>按等级</option>
            <option value="min_tier" ${S.groupBy === "min_tier" ? "selected" : ""}>按档位</option>
          </select>` : ""}
          <select class="bn-sel" id="bn-sort" aria-label="排序方式">
            <option value="rank" ${S.sort === "rank" ? "selected" : ""}>抽样序</option>
            <option value="sev" ${S.sort === "sev" ? "selected" : ""}>问题等级</option>
            <option value="dup" ${S.sort === "dup" ? "selected" : ""}>高频重问</option>
            <option value="tokens" ${S.sort === "tokens" ? "selected" : ""}>文本长度</option>
            <option value="latency" ${S.sort === "latency" ? "selected" : ""}>耗时降序</option>
            <option value="probs" ${S.sort === "probs" ? "selected" : ""}>问题数</option>
            <option value="day" ${S.sort === "day" ? "selected" : ""}>时间倒序</option>
          </select>
          <button type="button" class="bn-btn" id="bn-export-jsonl" title="导出当前筛选问句为 JSONL（一行一 Case，支持单轮/多轮）">导出 JSONL</button>
        </div>
      </div>

      <div class="bn-chips" ${chips.length ? "" : "hidden"}>
        ${chips.map((c) => `<button type="button" class="bn-chip" data-clrk="${c.k}">${esc(c.lbl)} ×</button>`).join("")}
        ${chips.length > 1 ? `<button type="button" class="bn-chip-clear" id="bn-clr-all">清空全部</button>` : ""}
      </div>

      ${bodyHTML}
    </section>`;
  }

  /* ---- Slide-over Trace Scene Workbench ---- */
  function foldLong(html, rawText, threshold = 900) {
    const s = String(rawText || "");
    if (s.length <= threshold) return html;
    const prev = s.replace(/\s+/g, " ").trim().slice(0, 140);
    return `<details class="bn-fold">
      <summary>
        <span class="bn-fold-prev">${esc(prev)}${s.length > 140 ? "…" : ""}</span>
        <span class="bn-fold-tag">展开 ${compact(s.length)} 字</span>
      </summary>
      <div class="bn-fold-body">${html}</div>
    </details>`;
  }

  function renderStepBody(m) {
    const t = m.type;
    if (t === "llm_turn" && Array.isArray(m.output)) {
      return m.output.map((o) => {
        const parts = [];
        if (o.reasoning_content) {
          parts.push(`<details class="bn-think"><summary>思考过程 (${fmt(String(o.reasoning_content).length)} 字)</summary><div class="bn-fold-body">${renderContent(String(o.reasoning_content), "text")}</div></details>`);
        }
        if (o.content) {
          const raw = String(o.content);
          parts.push(`<div class="bn-msg-body">${foldLong(renderContent(raw, "md"), raw, 1800)}</div>`);
        }
        (o.tool_calls || []).forEach((tc) => {
          const fn = tc?.function || {};
          const callStr = `${fn.name || "tool"}(${typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments || {})})`;
          parts.push(`<div class="bn-msg-body">${foldLong(`<pre>${esc(callStr)}</pre>`, callStr, 700)}</div>`);
        });
        return parts.join("");
      }).join("");
    }
    if (t === "tool_call") {
      const txt = typeof m.input === "string" ? m.input : JSON.stringify(m.input || {}, null, 2);
      return `<div class="bn-msg-body">${foldLong(`<pre>${esc(txt)}</pre>`, txt, 700)}</div>`;
    }
    if (t === "tool_result") {
      const rawOut = m.output ?? m.content ?? "";
      const txt = typeof rawOut === "string" ? rawOut : JSON.stringify(rawOut, null, 2);
      const mode = txt.trim().startsWith("{") || txt.trim().startsWith("[") ? "json" : "md";
      return `<div class="bn-msg-body">${foldLong(renderContent(txt, mode), txt, 800)}</div>`;
    }
    if (t === "final_answer") {
      return `<div class="bn-msg-body is-final">${renderContent(String(m.content || ""), "md")}</div>`;
    }
    if (Array.isArray(m.blocks)) {
      return m.blocks.map((b) => {
        const raw = (b.x || []).join("");
        return `<div class="bn-msg-body">${foldLong(renderContent(raw, b.f || "text"), raw, 1200)}</div>`;
      }).join("");
    }
    const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content || "", null, 2);
    return `<div class="bn-msg-body">${foldLong(renderContent(content, t === "user_question" ? "text" : "md"), content, 1200)}</div>`;
  }

  let sheetReqId = 0;

  async function paintSheet() {
    if (!sheetBackdrop) return;
    let sheetEl = $("#bn-sheet", sheetBackdrop);
    if (!sheetEl) {
      sheetBackdrop.innerHTML = `<aside class="bn-sheet" id="bn-sheet" role="dialog" aria-label="样本执行现场"></aside>`;
      sheetEl = $("#bn-sheet", sheetBackdrop);
    }
    if (!S.trace) {
      sheetReqId += 1;
      sheetBackdrop.classList.remove("is-open");
      sheetBackdrop.setAttribute("aria-hidden", "true");
      return;
    }

    const reqId = ++sheetReqId;
    const wasOpen = sheetBackdrop.classList.contains("is-open");
    const idx = lastFiltered.findIndex((x) => x.trace_id === S.trace);
    const summaryCase = idx >= 0 ? lastFiltered[idx] : null;
    const prevCase = idx > 0 ? lastFiltered[idx - 1] : null;
    const nextCase = idx >= 0 && idx < lastFiltered.length - 1 ? lastFiltered[idx + 1] : null;

    const cacheKey = `${S.model}|${S.trace}`;
    const isCached = S.caseCache.has(cacheKey);
    if (!isCached) {
      const sc = summaryCase || {};
      const sb = sc.bench || {};
      const sTone = sevTone(sc.severity || "GOLD");
      sheetEl.innerHTML = `<div class="bn-sh-head">
          <div class="bn-sh-id">
            ${sc.severity ? `<span class="bn-sev-tag" style="--c:${sTone}">${esc(sevLabel(sc.severity))}</span>` : ""}
            <span class="bn-badge is-accent">${esc(modelLabel(sc.model || S.model))}</span>
            <span class="bn-tier-tag">${tierTagLabel(sb.long_tier || sb.min_tier || sb.tier || S.tier, !!sb.long_tier)}</span>
          </div>
          <div class="bn-sh-acts">
            <button type="button" class="bn-btn bn-btn-icon" id="bn-sh-close" title="关闭">✕</button>
          </div>
        </div>
        <div class="bn-sh-scroll">
          ${sc.question ? `<div class="bn-sh-qbox"><div class="bn-sh-q is-clamped">${esc(sc.question)}</div></div>` : ""}
          <div class="bn-sh-skel"><span class="skel skel-title"></span><span class="skel skel-line"></span><span class="skel skel-line"></span></div>
        </div>`;
      const quickClose = $("#bn-sh-close", sheetEl);
      if (quickClose) quickClose.onclick = () => openTrace("");
    }

    if (!wasOpen) {
      sheetBackdrop.setAttribute("aria-hidden", "false");
      if (typeof requestAnimationFrame === "function") {
        void sheetEl.offsetWidth;
        requestAnimationFrame(() => {
          if (reqId === sheetReqId && S.trace) sheetBackdrop.classList.add("is-open");
        });
      } else {
        sheetBackdrop.classList.add("is-open");
      }
    }

    const full = await loadFullCase(S.model, S.trace, summaryCase);
    if (reqId !== sheetReqId || !S.trace) return;
    if (!full) {
      sheetEl.innerHTML = `<div class="bn-sh-head"><div class="bn-sh-id"><code>${esc(S.trace)}</code></div><div class="bn-sh-acts"><button type="button" class="bn-btn" id="bn-sh-close">关闭 ✕</button></div></div><div class="bn-sh-scroll"><div class="bn-empty">未找到对应样本记录</div></div>`;
      $("#bn-sh-close", sheetEl).onclick = () => openTrace("");
      return;
    }

    const st = full.stats || {};
    const mt = full.meta || {};
    const b = full.bench || {};
    const c = sevTone(full.severity || "GOLD");
    const sampleHref = resolveSampleHref(data.product, full);
    const msgs = full.messages || [];
    const poolMsgs = full.message_pool || [];
    const ansIdx = msgs.findLastIndex ? msgs.findLastIndex((m) => m.type === "final_answer") : -1;

    const shownMsgs = msgs.map((m, i) => ({ m, i })).filter(({ m }) => {
      if (S.stepFilter === "llm") return m.type === "llm_turn";
      if (S.stepFilter === "tool") return m.type === "tool_call" || m.type === "tool_result";
      if (S.stepFilter === "ans") return m.type === "final_answer";
      return true;
    });

    const probs = full.problems || [];
    const sampleProbs = full._sample?.attribution?.problems || [];
    const sampleEv = full._sample?.evidence || [];

    sheetEl.innerHTML = `<div class="bn-sh-head">
        <div class="bn-sh-id">
          <span class="bn-sev-tag" style="--c:${c}">${esc(sevLabel(full.severity))}</span>
          <span class="bn-badge is-accent">${esc(modelLabel(full.model || S.model))}</span>
          <span class="bn-tier-tag">${tierTagLabel(b.long_tier || b.min_tier || b.tier || S.tier, !!b.long_tier)}</span>
        </div>
        <div class="bn-sh-acts">
          <button type="button" class="bn-btn bn-btn-icon" id="bn-sh-prev" ${prevCase ? "" : "disabled"} title="上一条">↑</button>
          <button type="button" class="bn-btn bn-btn-icon" id="bn-sh-next" ${nextCase ? "" : "disabled"} title="下一条">↓</button>
          <button type="button" class="bn-btn" id="bn-sh-copyurl">复制现场链接</button>
          ${sampleHref
            ? `<a class="bn-btn is-primary" href="${esc(sampleHref)}" data-samplejump="1">在具体数据中查看 ↗</a>`
            : `<span class="bn-btn is-disabled">暂未关联样本库</span>`}
          <button type="button" class="bn-btn bn-btn-icon" id="bn-sh-close" title="关闭">✕</button>
        </div>
      </div>

      <div class="bn-sh-scroll">
        <div class="bn-sh-qbox">
          <div class="bn-sh-q ${!S.showFullQ && String(full.question || "").length > 220 ? "is-clamped" : ""}">${esc(full.question)}</div>
          ${(String(full.question || "").length > 220 || (full.question_full && full.question_full !== full.question)) ? `<div class="bn-sh-qfull">
            <button type="button" class="bn-btn" id="bn-sh-qfull">${S.showFullQ ? "收起完整输入" : "展开完整输入"}</button>
            ${S.showFullQ && full.question_full && full.question_full !== full.question ? `<pre>${esc(full.question_full)}</pre>` : ""}
          </div>` : ""}
          <div class="bn-sh-kvgrid">
            <span class="bn-sh-kv"><span>traceid</span><code>${esc(full.trace_id)}</code></span>
            ${full.session_id ? `<span class="bn-sh-kv"><span>session id</span><code>${esc(full.session_id)}</code></span>` : ""}
            <span class="bn-sh-kv"><span>时间</span><b>${esc(full.request_time || full.day || "—")}</b></span>
            <span class="bn-sh-kv"><span>对话形态</span><b>${full.turn === "multi" ? `多轮 第 ${full.turn_index || full.session_round}/${full.session_round} 轮` : "单轮"}</b></span>
            <span class="bn-sh-kv"><span>文本长度</span><b>${st.total_tokens ? `${fmt(st.total_tokens)} (${fmt(st.input_tokens || 0)} + ${fmt(mt.output_tokens || Math.max(0, (st.total_tokens || 0) - (st.input_tokens || 0)))})` : "未记录"}</b></span>
            <span class="bn-sh-kv"><span>耗时</span><b>${st.latency || 0}s</b></span>
            <span class="bn-sh-kv"><span>工具调用</span><b>${st.tool_count || 0} 次</b></span>
            ${mt.comefrom ? `<span class="bn-sh-kv"><span>产品入口</span><b>${esc(mt.comefrom)}</b></span>` : ""}
            ${(st.dup_question || 1) >= 2 ? `<span class="bn-sh-kv"><span>同问复现</span><b>×${st.dup_question}</b></span>` : ""}
          </div>
        </div>

        <div class="bn-sh-cols">
          <div class="bn-sh-rail">
            ${probs.length ? probs.map((p, pi) => {
              const pc = sevTone(p.severity || full.severity);
              const sp = sampleProbs[pi] || null;
              const pCode = p.path || p.l3 || "";
              const pPathName = [
                stageLabel(p.l1, stageNames),
                mechLabel(p.l2, mechNames),
                patternDisplayName(pCode, "", patNames, stageNames, mechNames),
              ].filter((x, idx2, arr) => x && arr.indexOf(x) === idx2).join(" › ");
              return `<div class="bn-prob-card" style="--c:${pc}">
                <div class="bn-prob-top">
                  <span class="bn-sev-tag" style="--c:${pc}">${esc(sevLabel(p.severity || full.severity))}</span>
                  ${pi === 0 ? `<span class="bn-mtag is-path">主问题</span>` : ""}
                  ${p.path_source ? `<span class="bn-mtag">${esc(PATH_SRC_LABEL[p.path_source] || p.path_source)}</span>` : ""}
                </div>
                <div class="bn-prob-lbl">${esc(p.label)}</div>
                ${pPathName ? `<div class="bn-prob-path" title="${esc(pCode)}">${esc(pPathName)}</div>` : ""}
                <div class="bn-prob-comp">
                  ${p.component ? `<span class="bn-mtag">${esc(p.component)}</span>` : ""}
                  ${p.component_role ? `<span class="bn-mtag">${esc(p.component_role)}</span>` : ""}
                </div>
                ${sp?.why ? `<div class="bn-pool-msg" style="margin-top:4px">${esc(sp.why)}</div>` : ""}
                ${(sp?.ev || []).length ? `<div class="bn-prob-comp">${sp.ev.map((eid) => {
                  const ev = sampleEv[eid];
                  return ev?.m != null ? `<button type="button" class="bn-step-pill" data-jumpm="${ev.m}">定位第 ${ev.m + 1} 步</button>` : "";
                }).join("")}</div>` : ""}
              </div>`;
            }).join("") : `<div class="bn-prob-card" style="--c:var(--loc-ulq)">
              <div class="bn-prob-top"><span class="bn-sev-tag" style="--c:var(--loc-ulq)">goldencase</span></div>
              <div class="bn-prob-lbl">无问题记录</div>
            </div>`}

            ${(mt.tool_names || []).length ? `<div class="bn-subwell">
              <div class="bn-subhead"><strong>涉及工具</strong><span>${mt.tool_names.length}</span></div>
              <div class="bn-prob-comp">${mt.tool_names.map((t) => `<span class="bn-mtag">${esc(t)}</span>`).join("")}</div>
            </div>` : ""}
          </div>

          <div class="bn-sh-main">
            ${poolMsgs.length ? `<details class="bn-pool-acc">
              <summary><span>历史多轮对话上下文</span><span class="bn-mtag">${poolMsgs.length} 条记录</span></summary>
              <div class="bn-pool-list">
                ${poolMsgs.map((pm) => {
                  const ptxt = typeof pm.content === "string" ? pm.content : JSON.stringify(pm.content || "");
                  return `<div class="bn-pool-msg"><span class="bn-pool-role">${esc(POOL_ROLE_LABEL[pm.role] || pm.role || "消息")}</span>${foldLong(`<span>${esc(ptxt)}</span>`, ptxt, 260)}</div>`;
                }).join("")}
              </div>
            </details>` : ""}

            <div class="bn-stepbar">
              <div class="bn-stepbar-tabs">
                ${[
                  ["all", `全部 (${msgs.length})`],
                  ["llm", "思考与调度"],
                  ["tool", "工具交互"],
                  ["ans", "最终回答"],
                ].map(([k, l]) => `<button type="button" class="bn-step-pill" data-stpf="${k}" aria-pressed="${S.stepFilter === k}">${l}</button>`).join("")}
              </div>
              ${ansIdx >= 0 ? `<button type="button" class="bn-step-pill" id="bn-jump-ans">定位最终回答 ↓</button>` : ""}
            </div>

            <div class="bn-timeline">
              ${shownMsgs.map(({ m, i }) => {
                const isAns = m.type === "final_answer";
                const isUsr = m.type === "user_question";
                return `<div class="bn-msg ${isAns ? "is-answer" : isUsr ? "is-user" : ""}" id="bn-step-${i}">
                  <div class="bn-msg-head">
                    <span class="bn-msg-kind">#${i + 1} · ${esc(KIND_LABEL[m.type] || m.type || "消息")}${m.name ? ` · ${esc(m.name)}` : ""}</span>
                    <span>${m.latency != null ? `${m.latency}s` : m.dur != null ? `${(m.dur / 1000).toFixed(2)}s` : ""}</span>
                  </div>
                  ${renderStepBody(m)}
                </div>`;
              }).join("") || '<div class="bn-empty">当前筛选无步骤内容</div>'}
            </div>
          </div>
        </div>
      </div>`;

    $("#bn-sh-close", sheetEl).onclick = () => openTrace("");
    $("#bn-sh-prev", sheetBackdrop).onclick = () => prevCase && openTrace(prevCase.trace_id);
    $("#bn-sh-next", sheetBackdrop).onclick = () => nextCase && openTrace(nextCase.trace_id);
    const qf = $("#bn-sh-qfull", sheetBackdrop);
    if (qf) qf.onclick = () => { S.showFullQ = !S.showFullQ; paintSheet(); };

    const cpBtn = $("#bn-sh-copyurl", sheetBackdrop);
    cpBtn.onclick = async () => {
      const ok = await copyText(location.href);
      flashCopy(cpBtn, ok, "复制现场链接");
    };
    const ja = $("#bn-jump-ans", sheetBackdrop);
    if (ja) {
      ja.onclick = () => {
        const el = $(`#bn-step-${ansIdx}`, sheetBackdrop);
        if (el) {
          el.scrollIntoView({ behavior: "smooth", block: "start" });
          el.classList.add("is-hl");
          setTimeout(() => el.classList.remove("is-hl"), 1200);
        }
      };
    }
    $$("[data-stpf]", sheetBackdrop).forEach((btn) => btn.addEventListener("click", () => {
      S.stepFilter = btn.dataset.stpf;
      paintSheet();
    }));
    $$("[data-jumpm]", sheetBackdrop).forEach((btn) => btn.addEventListener("click", () => {
      const el = $(`#bn-step-${btn.dataset.jumpm}`, sheetBackdrop);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        el.classList.add("is-hl");
        setTimeout(() => el.classList.remove("is-hl"), 1200);
      }
    }));
    const sj = $('[data-samplejump="1"]', sheetBackdrop);
    if (sj) {
      sj.addEventListener("click", (e) => {
        if (!ctx.navigate) return;
        e.preventDefault();
        openTrace("");
        ctx.navigate({
          view: "samples",
          case: full.case_key || full.slug,
          trace: full.trace_id,
          bm: null, bl: null, bt: null, bd: null, bv: null,
        });
      });
    }
  }

  function syncRingBox(box, attr, activeVal) {
    if (!box) return;
    const arcs = $$(".bn-ring-arc", box);
    let activeArc = null;
    arcs.forEach((arc) => {
      const match = Boolean(activeVal && arc.getAttribute(attr) === activeVal);
      if (match) activeArc = arc;
      arc.classList.toggle("is-active", match);
      arc.classList.toggle("is-dim", Boolean(activeVal && !match));
      arc.setAttribute("aria-pressed", String(match));
    });
    const mid = $(".bn-pie-mid", box);
    if (!mid) return;
    const bEl = $("b", mid);
    const sEl = $("span", mid);
    if (activeArc && activeArc.dataset.ringVal) {
      mid.classList.add("is-focus");
      if (activeArc.dataset.ringColor) mid.style.setProperty("--c", activeArc.dataset.ringColor);
      if (bEl) bEl.textContent = activeArc.dataset.ringVal;
      if (sEl && activeArc.dataset.ringSub) sEl.textContent = activeArc.dataset.ringSub;
    } else {
      mid.classList.remove("is-focus");
      mid.style.removeProperty("--c");
      if (bEl && mid.dataset.defaultVal != null) bEl.textContent = mid.dataset.defaultVal;
      if (sEl && mid.dataset.defaultSub != null) sEl.textContent = mid.dataset.defaultSub;
    }
  }

  function syncHighlights() {
    $$(".bn-quota-card [data-fsev]", root).forEach((b) => b.setAttribute("aria-pressed", String(S.f.sev === b.dataset.fsev)));
    $$(".bn-quota-card [data-fturn]", root).forEach((b) => b.setAttribute("aria-pressed", String(S.f.turn === b.dataset.fturn)));
    $$(".bn-quota-card [data-fmech]", root).forEach((b) => b.setAttribute("aria-pressed", String(S.f.l2 === b.dataset.fmech)));
    $(".bn-qpie-leg", root)?.classList.toggle("has-focus", Boolean(S.f.sev));
    $(".bn-turn-waffle", root)?.classList.toggle("has-focus", Boolean(S.f.turn));
    $(".bn-turn-list", root)?.classList.toggle("has-focus", Boolean(S.f.turn));
    $(".bn-mech-rank", root)?.classList.toggle("has-focus", Boolean(S.f.l2));
    $(".bn-dbell-list", root)?.classList.toggle("has-focus", Boolean((S.dim === "severity" && S.f.sev) || (S.dim === "mechanism" && S.f.l2)));
    $(".bn-tcmp-rows", root)?.classList.toggle("has-focus", Boolean(S.dim === "turn_type" && S.f.turn));
    syncRingBox($(".bn-qpie-wrap .bn-pie-box", root), "data-fsev", S.f.sev);
    $$(".bn-dist-card .bn-pie-box", root).forEach((box) => {
      if ($(".bn-ring-arc[data-dimk='turn']", box)) syncRingBox(box, "data-dimv", S.f.turn);
    });
    $$(".bn-sb-card [data-fpat]", root).forEach((b) => b.setAttribute("aria-pressed", String(S.f.l3 === b.dataset.fpat)));
    const dupBtn = $("#bn-dup-btn", root);
    if (dupBtn) dupBtn.setAttribute("aria-pressed", String(S.f.dupOnly));
    $$(".bn-dist-card [data-dimk]", root).forEach((b) => {
      const k = b.dataset.dimk;
      b.setAttribute("aria-pressed", String(Boolean(k && S.f[k] === b.dataset.dimv)));
    });
    $$(".bn-matrix [data-mxs], .bn-matrix [data-mxm]", root).forEach((b) => {
      const s = b.dataset.mxs || "";
      const m = b.dataset.mxm || "";
      if (s && m) b.classList.toggle("is-cur", S.f.l1 === s && S.f.l2 === m);
      else if (s) b.classList.toggle("is-hl", S.f.l1 === s);
      else if (m) b.classList.toggle("is-hl", S.f.l2 === m);
    });
    $$(".bn-cal-cell[data-bn-day]", root).forEach((el) => {
      const on = Boolean(S.f.day && S.f.day === el.dataset.bnDay);
      el.classList.toggle("is-active", on);
      el.setAttribute("aria-pressed", String(on));
    });
    $$(".bn-g-bar[data-bn-day]", root).forEach((el) => {
      el.classList.toggle("is-on", Boolean(S.f.day && S.f.day === el.dataset.bnDay));
    });
    $$("[data-bn-day-filter]", root).forEach((el) => {
      const on = Boolean(S.f.day && S.f.day === el.dataset.bnDayFilter);
      el.classList.toggle("is-on", on);
      el.textContent = on ? "取消当日筛选" : "筛选当日样本";
    });
  }

  async function repaint({ rebuildSummary = true } = {}) {
    S.tier = validTier();
    syncUrl({ bm: S.model, bl: S.isLong ? "1" : null, bt: S.tier, bd: S.dim, bv: S.view === "field" ? "field" : null, trace: S.trace || null });

    const md = currentModel();
    const allCases = await loadTierCases();
    const tierData = activeTierStats(allCases);
    const filtered = sortBenchCases(filterBenchCases(allCases, S.f, params.long_tokens), S.sort);
    lastFiltered = filtered;
    const topPatterns = (tierData.dims?.pattern || [])
      .filter((p) => p.key && p.key !== "NA" && p.count > 0)
      .sort((a, b) => (b.count || 0) - (a.count || 0))
      .slice(0, 8);
    const totalActual = Number(tierData.actual || 0);
    const probTotal = Number(tierData.crosstab?.totals?.bench_total ?? Math.max(0, totalActual - Number(tierData.severity_actual?.GOLD || 0)))
      || sum((tierData.dims?.stage || []).map((x) => Number(x.count || 0)));

    const container = $(".bn-bento", root);
    const didRebuild = !container || rebuildSummary;
    if (didRebuild) {
      root.innerHTML = `<div class="bento bn-bento">
        ${renderHeroHTML(md, tierData)}
        ${renderQuotaHTML(md, tierData)}
        ${renderDistHTML(tierData)}
        ${renderMatrixHTML(tierData)}
        <section class="card bn-sb-card">
          <div class="card-head">
            <h2>问题分类占比</h2>
            <span class="bn-count-pill">问题 ${fmt(probTotal)}${totalActual ? ` / ${fmt(totalActual)}` : ""}</span>
            <button type="button" class="bn-chip-clear end" id="bn-sb-reset" hidden>返回全部</button>
          </div>
          <div id="bn-sb-host"></div>
          ${topPatterns.length ? `<div class="bn-toppats">
            <div class="bn-subhead"><strong>高频具体问题</strong><span>占问题样本 · ${fmt(probTotal)} 条</span></div>
            <div class="bn-patgrid">
              ${topPatterns.map((p) => {
                const pName = patternDisplayName(p.key, p.bucket, patNames, stageNames, mechNames);
                const parts = String(p.key).split(".");
                const sub = parts.length >= 2 ? `${stageLabel(parts[0], stageNames)} · ${mechLabel(parts[1], mechNames)}` : "";
                return `<button type="button" class="bn-patitem" data-fpat="${esc(p.key)}" aria-pressed="${S.f.l3 === p.key}" data-tip="${esc(`${sub} · ${pName} · ${fmt(p.count)} 条`)}">
                  <span class="bn-patname">${esc(pName)}</span>
                  <span class="bn-patmeta num"><b>${fmt(p.count)}</b>${probTotal ? `<small>${pct(p.count, probTotal, 1)}</small>` : ""}</span>
                </button>`;
              }).join("")}
            </div>
          </div>` : ""}
        </section>
        ${renderCasesHTML(allCases, filtered, tierData)}
      </div>
      <div class="bn-backdrop" id="bn-backdrop" aria-hidden="true"><aside class="bn-sheet" id="bn-sheet" role="dialog" aria-label="样本执行现场"></aside></div>`;

      sheetBackdrop = $("#bn-backdrop", root);
      sheetBackdrop.addEventListener("click", (e) => {
        if (e.target === sheetBackdrop) openTrace("");
      });
      wireSummary(tierData);
      runCounters(root);
    } else {
      const curCard = $(".bn-cases-card", root);
      const wrap = document.createElement("div");
      wrap.innerHTML = renderCasesHTML(allCases, filtered, tierData);
      curCard.replaceWith(wrap.firstElementChild);
      syncHighlights();
    }

    wireCases(filtered);
    if (didRebuild) bindTips(root, (el) => el.dataset.tipHtml || el.dataset.tip || "");
    if (S.trace) paintSheet();
  }

  function wireSummary(tierData) {
    const segM = $("#bn-seg-model", root);
    if (segM) {
      const ctl = segmented(segM, (v) => {
        S.model = v;
        S.calMonth = "";
        S.calModalDate = "";
        S.page = 1;
        S.sunburstState = { focus: "b", open: null };
        repaint();
      });
      ctl.set(S.model, { silent: true });
    }
    const segMode = $("#bn-seg-mode", root);
    if (segMode) {
      const ctl = segmented(segMode, (v) => {
        S.isLong = v === "long";
        S.tier = validTier();
        S.page = 1;
        S.sunburstState = { focus: "b", open: null };
        repaint();
      });
      ctl.set(S.isLong ? "long" : "std", { silent: true });
    }
    const segT = $("#bn-seg-tier", root);
    if (segT) {
      const ctl = segmented(segT, (v) => {
        S.tier = v;
        S.page = 1;
        S.sunburstState = { focus: "b", open: null };
        repaint();
      });
      ctl.set(S.tier, { silent: true });
    }
    const segMx = $("#bn-seg-mx", root);
    if (segMx) {
      const ctl = segmented(segMx, (v) => {
        S.mxMode = v;
        repaint();
      });
      ctl.set(S.mxMode, { silent: true });
    }

    const heroEl = $(".bn-hero", root);
    if (heroEl) {
      const toggleStageFlip = (card) => {
        const sid = card?.dataset?.bnStageFlip;
        if (!sid) return;
        const next = !S.flippedStages.has(sid);
        if (next) S.flippedStages.add(sid);
        else S.flippedStages.delete(sid);
        card.classList.toggle("is-flipped", next);
        card.setAttribute("aria-pressed", String(next));
      };
      heroEl.addEventListener("keydown", (e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        const card = e.target.closest("[data-bn-stage-flip]");
        if (card && !e.target.closest("[data-nest]")) {
          e.preventDefault();
          toggleStageFlip(card);
        }
      });
      heroEl.addEventListener("click", (e) => {
        const segEl = e.target.closest("[data-bn-fseg]");
        if (segEl) {
          const [sid, rawIdx] = String(segEl.dataset.bnFseg || "").split(":");
          const idx = Number(rawIdx);
          if (sid && Number.isInteger(idx)) {
            if (S.stageFocus.get(sid) === idx) S.stageFocus.delete(sid);
            else S.stageFocus.set(sid, idx);
            const md = currentModel();
            const daily = buildBenchDailyModel(md, tierData);
            const spec = buildHeroStageSpecs(md, tierData, daily).find((sp) => sp.id === sid);
            const body = heroEl.querySelector(`[data-bn-fback-body="${CSS.escape(sid)}"]`);
            if (spec && body) body.innerHTML = stageBackBodyHTML(spec);
          }
          return;
        }
        const closeStageBtn = e.target.closest("[data-bn-stage-close]");
        if (closeStageBtn) {
          const card = closeStageBtn.closest("[data-bn-stage-flip]");
          if (card) {
            S.stageFocus.delete(card.dataset.bnStageFlip);
            toggleStageFlip(card);
          }
          return;
        }
        const stageCard = e.target.closest("[data-bn-stage-flip]");
        if (stageCard && !e.target.closest("[data-nest]")) {
          if (!stageCard.classList.contains("is-flipped")) {
            toggleStageFlip(stageCard);
          } else if (!e.target.closest(".bn-fback-body")) {
            S.stageFocus.delete(stageCard.dataset.bnStageFlip);
            toggleStageFlip(stageCard);
          }
          return;
        }
        const md = currentModel();
        const daily = buildBenchDailyModel(md, tierData);
        const isBenchMode = S.calMode === "bench";
        const tierLabel = tierTagLabel(Number(S.tier), S.isLong);
        const stage = $("#bnCalStage", heroEl);
        const front = $("#bnCalFront", heroEl);
        const back = $("#bnCalBack", heroEl);

        const refreshHeroCal = () => {
          if (front) front.innerHTML = renderCalFrontHTML(daily, S.calMode === "bench", tierLabel);
          if (back) back.innerHTML = S.calModalDate ? renderCalBackHTML(daily, S.calModalDate, S.calMode === "bench", tierLabel) : "";
          stage?.classList?.toggle("is-flipped", Boolean(S.calModalDate));
          const oldGrowth = $(".bn-growth-card", heroEl);
          if (oldGrowth) {
            const tmp = document.createElement("div");
            tmp.innerHTML = renderGrowthChartHTML(daily, S.calMode === "bench", tierLabel);
            oldGrowth.replaceWith(tmp.firstElementChild);
          }
        };

        const closeBtn = e.target.closest("[data-bn-cal-close]");
        if (closeBtn) {
          S.calModalDate = "";
          stage?.classList?.remove("is-flipped");
          return;
        }
        const modeBtn = e.target.closest("[data-bn-cal-mode]");
        if (modeBtn) {
          const nextMode = modeBtn.dataset.bnCalMode === "bench" ? "bench" : "pool";
          if (nextMode !== S.calMode) {
            S.calMode = nextMode;
            refreshHeroCal();
          }
          return;
        }
        const monthBtn = e.target.closest("[data-bn-cal-month]");
        if (monthBtn && !monthBtn.disabled) {
          S.calMonth = monthBtn.dataset.bnCalMonth || "";
          if (front) front.innerHTML = renderCalFrontHTML(daily, isBenchMode, tierLabel);
          return;
        }
        const stepBtn = e.target.closest("[data-bn-cal-step]");
        if (stepBtn && !stepBtn.disabled && S.calModalDate) {
          const step = Number(stepBtn.dataset.bnCalStep) || 0;
          const idx = daily.days.findIndex((d) => d.date === S.calModalDate);
          const nextRec = daily.days[idx + step];
          if (nextRec) {
            S.calModalDate = nextRec.date;
            S.calMonth = nextRec.date.slice(0, 7);
            refreshHeroCal();
          }
          return;
        }
        const filterBtn = e.target.closest("[data-bn-day-filter]");
        if (filterBtn) {
          const day = filterBtn.dataset.bnDayFilter || "";
          if (day) {
            toggleFilter("day", day);
            $(".bn-cases-card", root)?.scrollIntoView?.({ behavior: "smooth", block: "nearest" });
          }
          return;
        }
        const dayEl = e.target.closest("[data-bn-day]");
        if (dayEl) {
          const dateStr = dayEl.dataset.bnDay || "";
          if (dateStr && daily.byDate.has(dateStr)) {
            S.calModalDate = dateStr;
            S.calMonth = dateStr.slice(0, 7);
            if (back) back.innerHTML = renderCalBackHTML(daily, dateStr, isBenchMode, tierLabel);
            stage?.classList?.add("is-flipped");
          }
        }
      });
    }

    $$("[data-nest]", root).forEach((b) => b.addEventListener("click", () => {
      S.tier = b.dataset.nest;
      S.page = 1;
      S.sunburstState = { focus: "b", open: null };
      repaint();
    }));

    const bindKeyToggle = (el, fn) => {
      el.addEventListener("click", fn);
      if (el.tagName !== "BUTTON" && el.tagName !== "A") {
        el.addEventListener("keydown", (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            fn();
          }
        });
      }
    };
    const wireDistCard = (td) => {
      $$(".bn-dist-card [data-dimpick]", root).forEach((b) => b.addEventListener("click", () => {
        const nextDim = b.dataset.dimpick;
        if (nextDim && nextDim !== S.dim) {
          S.dim = nextDim;
          refreshDistCard(td);
        }
      }));
      $$(".bn-dist-card [data-dimk]", root).forEach((b) => bindKeyToggle(b, () => {
        const k = b.dataset.dimk;
        const v = b.dataset.dimv;
        if (k) toggleFilter(k, v);
      }));
      const dupBtn = $("#bn-dup-btn", root);
      if (dupBtn) dupBtn.onclick = () => toggleFilter("dupOnly", true);
    };
    const refreshDistCard = (td) => {
      const curDist = $(".bn-dist-card", root);
      if (!curDist) return;
      const wrap = document.createElement("div");
      wrap.innerHTML = renderDistHTML(td);
      const nextDist = wrap.firstElementChild;
      if (!nextDist) return;
      curDist.replaceWith(nextDist);
      wireDistCard(td);
      syncHighlights();
      syncUrl({ bm: S.model, bl: S.isLong ? "1" : null, bt: S.tier, bd: S.dim, bv: S.view === "field" ? "field" : null, trace: S.trace || null });
    };
    const linkQuotaDim = (filterKey, val, targetDim) => {
      toggleFilter(filterKey, val);
      if (S.f[filterKey] && targetDim && S.dim !== targetDim) {
        S.dim = targetDim;
        refreshDistCard(tierData);
      }
    };
    $$(".bn-quota-card [data-fsev]", root).forEach((b) => bindKeyToggle(b, () => linkQuotaDim("sev", b.dataset.fsev, "severity")));
    $$(".bn-quota-card [data-fturn]", root).forEach((b) => bindKeyToggle(b, () => linkQuotaDim("turn", b.dataset.fturn, "turn_type")));
    $$(".bn-quota-card [data-fmech]", root).forEach((b) => bindKeyToggle(b, () => linkQuotaDim("l2", b.dataset.fmech, "mechanism")));
    $$(".bn-sb-card [data-fpat]", root).forEach((b) => b.addEventListener("click", () => {
      const code = b.dataset.fpat;
      const same = S.f.l3 === code;
      const parts = code.split(".");
      S.f.l1 = same ? "" : (parts[0] || "");
      S.f.l2 = same ? "" : (parts[1] || "");
      S.f.l3 = same ? "" : code;
      syncSunburstFromFilter();
      S.page = 1;
      S.fieldPages = {};
      repaint();
    }));
    wireDistCard(tierData);

    $$(".bn-matrix [data-mxs], .bn-matrix [data-mxm]", root).forEach((btn) => btn.addEventListener("click", () => {
      const s = btn.dataset.mxs || "";
      const m = btn.dataset.mxm || "";
      if (s && m) {
        const same = S.f.l1 === s && S.f.l2 === m;
        S.f.l1 = same ? "" : s;
        S.f.l2 = same ? "" : m;
        S.f.l3 = "";
      } else if (s) {
        S.f.l1 = S.f.l1 === s ? "" : s;
        if (!S.f.l1) { S.f.l2 = ""; S.f.l3 = ""; }
      } else if (m) {
        S.f.l2 = S.f.l2 === m ? "" : m;
        if (!S.f.l2) S.f.l3 = "";
      }
      syncSunburstFromFilter();
      S.page = 1;
      repaint();
    }));

    mxResizeObs?.disconnect();
    mxResizeObs = null;
    const mxPane = $(".bn-matrix .mx-scroll", root);
    if (mxPane) {
      const syncScroll = () => {
        if (!mxPane.isConnected) { mxResizeObs?.disconnect(); return; }
        mxPane.classList.toggle("is-overflow", mxPane.scrollWidth > mxPane.clientWidth + 1);
        mxPane.classList.toggle("is-at-end", mxPane.scrollLeft + mxPane.clientWidth >= mxPane.scrollWidth - 2);
      };
      mxPane.addEventListener("scroll", syncScroll, { passive: true });
      mxResizeObs = new ResizeObserver(syncScroll);
      mxResizeObs.observe(mxPane);
      syncScroll();
    }

    const sbHost = $("#bn-sb-host", root);
    if (sbHost && !sbHost.firstChild) {
      const tree = buildSunburstTree(tierData, lastFiltered, taxonomy, stageNames, mechNames, patNames);
      let sbReady = false;
      sunburst(sbHost, tree, {
        unit: "问题样本",
        sort: true,
        fold: false,
        state: S.sunburstState,
        onChange: (focus, open) => {
          const resetBtn = $("#bn-sb-reset", root);
          if (resetBtn) resetBtn.hidden = focus.id === "b" && !S.f.l1 && !S.f.l3;
          if (!sbReady) return;
          const fCode = focus.id === "b" ? "" : focus.id.slice(2);
          const fParts = fCode.split(".");
          if (open && !open.children && !open.other && open.id.startsWith("b/") && open.id.slice(2).split(".").length >= 3) {
            const oCode = open.id.slice(2);
            const oParts = oCode.split(".");
            S.f.l1 = oParts[0] || "";
            S.f.l2 = oParts[1] || "";
            S.f.l3 = oCode;
          } else {
            S.f.l1 = fParts[0] || "";
            S.f.l2 = fParts[1] || "";
            S.f.l3 = fParts.length > 2 ? fCode : "";
          }
          if (resetBtn) resetBtn.hidden = focus.id === "b" && !S.f.l1 && !S.f.l3;
          S.page = 1;
          S.fieldPages = {};
          repaint({ rebuildSummary: false });
        },
      });
      sbReady = true;
      const rs = $("#bn-sb-reset", root);
      if (rs) {
        rs.onclick = () => {
          S.sunburstState = { focus: "b", open: null };
          S.f.l1 = "";
          S.f.l2 = "";
          S.f.l3 = "";
          S.page = 1;
          S.fieldPages = {};
          repaint();
        };
      }
    }
  }

  function wireCases(filtered) {
    const card = $(".bn-cases-card", root);
    if (!card) return;
    fieldResizeObs?.disconnect();
    fieldResizeObs = null;

    if (S.view === "field") {
      paintBenchField(card);
      const fieldEl = $(".bn-field", card);
      if (fieldEl) {
        let lastW = fieldEl.clientWidth;
        let fieldRaf = 0;
        fieldResizeObs = new ResizeObserver(() => {
          if (!fieldEl.isConnected) { fieldResizeObs?.disconnect(); return; }
          const w = fieldEl.clientWidth;
          if (Math.abs(w - lastW) < 2) return;
          lastW = w;
          if (fieldRaf) return;
          fieldRaf = requestAnimationFrame(() => {
            fieldRaf = 0;
            if (fieldEl.isConnected) paintBenchField(card);
          });
        });
        fieldResizeObs.observe(fieldEl);
      }
      card.addEventListener("click", (e) => {
        const pBtn = e.target.closest("[data-fg][data-fdir]");
        if (!pBtn) return;
        const k = pBtn.dataset.fg;
        const dir = pBtn.dataset.fdir;
        S.fieldPages[k] = (S.fieldPages[k] || 1) + (dir === "next" ? 1 : -1);
        paintBenchField(card);
      });
    }

    const segV = $("#bn-seg-view", card);
    if (segV) {
      const ctl = segmented(segV, (v) => {
        S.view = v;
        S.page = 1;
        repaint({ rebuildSummary: false });
      });
      ctl.set(S.view, { silent: true });
    }

    const srch = $("#bn-search", card);
    if (srch) {
      if (focusSearchAfterRender) {
        srch.focus();
        if (searchPos != null) srch.setSelectionRange(searchPos, searchPos);
        focusSearchAfterRender = false;
      }
      srch.addEventListener("input", (e) => {
        S.f.q = e.target.value.trim();
        S.page = 1;
        S.fieldPages = {};
        focusSearchAfterRender = true;
        searchPos = e.target.selectionStart;
        repaint({ rebuildSummary: false });
      });
    }
    $$("[data-fsev]", card).forEach((b) => b.addEventListener("click", () => { S.fieldPages = {}; toggleFilter("sev", b.dataset.fsev); }));

    const moreWrap = $("#bn-more-wrap", card);
    const moreBtn = $("#bn-more-toggle", card);
    const morePop = $("#bn-more-pop", card);
    const setMoreOpen = (open) => {
      S.moreOpen = Boolean(open);
      if (moreWrap) moreWrap.classList.toggle("is-open", S.moreOpen);
      if (morePop) {
        morePop.classList.toggle("is-open", S.moreOpen);
        morePop.inert = !S.moreOpen;
      }
      if (moreBtn) moreBtn.setAttribute("aria-expanded", String(S.moreOpen));
    };
    if (moreBtn) {
      moreBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        setMoreOpen(!S.moreOpen);
      });
    }
    const moreClr = $("#bn-more-clr", card);
    if (moreClr) {
      moreClr.addEventListener("click", () => {
        S.f.l1 = "";
        S.f.l2 = "";
        S.f.l3 = "";
        S.f.turn = "";
        S.f.tok = "";
        S.f.dupOnly = false;
        S.sunburstState = { focus: "b", open: null };
        S.page = 1;
        S.fieldPages = {};
        repaint();
      });
    }
    root._bnMoreDocCleanup?.();
    const onMoreDocDown = (e) => {
      if (S.moreOpen && moreWrap && !moreWrap.contains(e.target)) setMoreOpen(false);
    };
    const onMoreKey = (e) => {
      if (e.key === "Escape" && S.moreOpen) {
        setMoreOpen(false);
        moreBtn?.focus();
      }
    };
    document.addEventListener("pointerdown", onMoreDocDown);
    document.addEventListener("keydown", onMoreKey);
    root._bnMoreDocCleanup = () => {
      document.removeEventListener("pointerdown", onMoreDocDown);
      document.removeEventListener("keydown", onMoreKey);
    };

    $$("[data-fsel]", card).forEach((sel) => sel.addEventListener("change", (e) => {
      const key = {
        stage: "l1", mechanism: "l2", turn_type: "turn", tokens: "tok",
      }[sel.dataset.fsel];
      if (!key) return;
      S.f[key] = e.target.value;
      if (key === "l1" && !e.target.value) S.f.l3 = "";
      if (key === "l1" || key === "l2") syncSunburstFromFilter();
      S.page = 1;
      S.fieldPages = {};
      repaint({ rebuildSummary: key === "l1" || key === "l2" });
    }));
    const togDup = $("#bn-tog-dup", card);
    if (togDup) togDup.onclick = () => { S.f.dupOnly = !S.f.dupOnly; S.page = 1; S.fieldPages = {}; repaint({ rebuildSummary: false }); };

    const sortEl = $("#bn-sort", card);
    if (sortEl) sortEl.onchange = (e) => { S.sort = e.target.value; S.page = 1; S.fieldPages = {}; repaint({ rebuildSummary: false }); };
    const exportBtn = $("#bn-export-jsonl", card);
    if (exportBtn) {
      exportBtn.onclick = async () => {
        if (exportBtn.disabled) return;
        const origText = exportBtn.textContent;
        exportBtn.disabled = true;
        exportBtn.textContent = "导出中…";
        try {
          const qp = new URLSearchParams();
          if (S.model) qp.set("model", S.model);
          if (S.tier) qp.set("tier", S.tier);
          if (S.isLong) qp.set("long", "1");
          if (S.f.sev) qp.set("sev", S.f.sev);
          if (S.f.l1) qp.set("l1", S.f.l1);
          if (S.f.l2) qp.set("l2", S.f.l2);
          if (S.f.l3) qp.set("l3", S.f.l3);
          if (S.f.turn) qp.set("turn", S.f.turn);
          if (S.f.tok) qp.set("tok", S.f.tok);
          if (S.f.rnd) qp.set("rnd", S.f.rnd);
          if (S.f.day) qp.set("day", S.f.day);
          if (S.f.psrc) qp.set("psrc", S.f.psrc);
          if (S.f.dupOnly) qp.set("dup", "1");
          if (S.f.longOnly) qp.set("longOnly", "1");
          if (S.f.q) qp.set("q", S.f.q);
          if (S.sort) qp.set("sort", S.sort);

          let text = "";
          const url = `bench_export/${encodeURIComponent(data.product)}.jsonl?${qp.toString()}`;
          try {
            const res = await fetch(url);
            if (res.ok) text = await res.text();
          } catch {
            text = "";
          }
          if (!text) {
            text = filtered.map((c) => JSON.stringify(formatClientExportCase(c, maps))).join("\n") + (filtered.length ? "\n" : "");
          }
          const blob = new Blob([text], { type: "application/x-ndjson;charset=utf-8" });
          const blobUrl = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = blobUrl;
          a.download = `bench-${data.product}-${S.model}-${S.isLong ? "long" : "std"}-${S.tier}.jsonl`;
          document.body.appendChild(a);
          a.click();
          a.remove();
          setTimeout(() => URL.revokeObjectURL(blobUrl), 2500);
          announce(`已导出 ${fmt(filtered.length)} 条测试集 JSONL`);
        } finally {
          exportBtn.disabled = false;
          exportBtn.textContent = origText;
        }
      };
    }
    const grpEl = $("#bn-groupby", card);
    if (grpEl) grpEl.onchange = (e) => { S.groupBy = e.target.value; S.fieldPages = {}; repaint({ rebuildSummary: false }); };
    const psEl = $("#bn-pagesize", card);
    if (psEl) {
      psEl.onchange = (e) => {
        S.size = Number(e.target.value);
        S.page = 1;
        repaint({ rebuildSummary: false });
      };
    }

    $$("[data-clrk]", card).forEach((b) => b.addEventListener("click", () => {
      const k = b.dataset.clrk;
      S.f[k] = typeof S.f[k] === "boolean" ? false : "";
      if (k === "l1") S.f.l3 = "";
      if (k === "l1" || k === "l2" || k === "l3") syncSunburstFromFilter();
      S.page = 1;
      S.fieldPages = {};
      repaint({ rebuildSummary: k === "l1" || k === "l2" || k === "l3" });
    }));
    const clrAll = $("#bn-clr-all", card);
    if (clrAll) {
      clrAll.onclick = () => {
        S.f = EMPTY_FILTER();
        S.sunburstState = { focus: "b", open: null };
        S.page = 1;
        S.fieldPages = {};
        repaint();
      };
    }

    $$("[data-page]", card).forEach((b) => b.addEventListener("click", () => {
      const pages = Math.max(1, Math.ceil(filtered.length / S.size));
      if (b.dataset.page === "first") S.page = 1;
      else if (b.dataset.page === "prev") S.page -= 1;
      else if (b.dataset.page === "next") S.page += 1;
      else if (b.dataset.page === "last") S.page = pages;
      repaint({ rebuildSummary: false });
    }));

    // Delegated trace click keeps Tier 10,000 field tiles instant
    card.addEventListener("click", (e) => {
      const el = e.target.closest("[data-trace]");
      if (el) openTrace(el.dataset.trace);
    });
  }

  root._bnCleanup?.();
  const onKeyDown = (e) => {
    if (!document.body.contains(root) || root.hidden || !S.trace) return;
    if (e.key === "Escape") {
      e.preventDefault();
      openTrace("");
    } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      const idx = lastFiltered.findIndex((x) => x.trace_id === S.trace);
      if (idx < 0) return;
      const next = lastFiltered[idx + (e.key === "ArrowDown" ? 1 : -1)];
      if (next) {
        e.preventDefault();
        openTrace(next.trace_id);
      }
    }
  };
  document.addEventListener("keydown", onKeyDown);
  root._bnCleanup = () => {
    document.removeEventListener("keydown", onKeyDown);
    root._bnMoreDocCleanup?.();
    mxResizeObs?.disconnect();
    mxResizeObs = null;
    fieldResizeObs?.disconnect();
    fieldResizeObs = null;
  };

  await repaint();
  announce("Bench 页面已加载");
}
