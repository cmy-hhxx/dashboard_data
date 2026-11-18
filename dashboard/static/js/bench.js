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
  { key: "tokens", label: "对话长度", audit: true },
  { key: "round", label: "对话轮数", audit: true },
  { key: "group", label: "业务分组", audit: true },
  { key: "recalled_from", label: "召回来源", audit: true },
  { key: "stage", label: "问题环节", audit: false },
  { key: "mechanism", label: "问题机制", audit: false },
  { key: "pattern", label: "具体问题", audit: false },
  { key: "turn_type", label: "单/多轮", audit: false },
  { key: "pattern_source", label: "匹配方式", audit: false },
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
  M5: "加工计算", M6: "无据断言", M7: "交付不符", NA: "未分类",
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
const GROUP_LABELS = {
  "0_daily_eval": "日常评测",
  "2_task_eval/0_lost_user_back_test": "流失用户回测",
};
const RECALL_LABELS = {
  lost_user: "流失用户召回",
  unknown: "常规来源",
};
const POOL_ROLE_LABEL = { user: "用户", assistant: "助手", tool: "工具", system: "系统" };
const MECH_ORDER = ["M1", "M2", "M3", "M4", "M5", "M6", "M7"];

const EMPTY_FILTER = () => ({
  sev: "", l1: "", l2: "", l3: "", turn: "", tok: "", rnd: "",
  day: "", grp: "", rec: "", psrc: "", dupOnly: false, longOnly: false, q: "",
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
  if (!s || s === "NA") return "未分类";
  return names?.[s] || DEFAULT_STAGE_NAMES[s] || s;
}

function mechLabel(m, names, short = false) {
  if (!m || m === "NA") return "未分类";
  if (short && MECH_SHORT[m]) return MECH_SHORT[m];
  return names?.[m] || DEFAULT_MECH_NAMES[m] || m;
}

export function patternDisplayName(code, rowBucket, patNames, stageNames, mechNames) {
  if (!code || code === "NA") return "未分类";
  const mapped = (patNames && patNames[code]) || (rowBucket && rowBucket !== code ? rowBucket : "");
  if (mapped) return mapped;
  const parts = String(code).split(".");
  if (parts.length >= 2) {
    return `${stageLabel(parts[0], stageNames)} · ${mechLabel(parts[1], mechNames)}`;
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
  if (dim === "group") return GROUP_LABELS[k] || raw || k;
  if (dim === "recalled_from") return RECALL_LABELS[k] || raw || k;
  if (dim === "pattern_source") return PATH_SRC_LABEL[k] || raw || k;
  return raw || k;
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
  (taxonomy?.stages || []).forEach((s) => { if (s.id) stageMap.set(s.id, s.name); });
  Object.entries(DEFAULT_STAGE_NAMES).forEach(([id, name]) => { if (!stageMap.has(id)) stageMap.set(id, name); });
  stageMap.set("NA", "未分类");

  const mechIds = [...MECH_ORDER, "NA"];
  const sevActual = Object.fromEntries(SEVS_ALL.map((s) => [s, 0]));
  const turnActual = { single: 0, multi: 0 };
  const stageActual = {};
  const mechActual = {};
  const ctRows = {};
  const sevCells = {};
  const ctTotals = { ...Object.fromEntries(mechIds.map((m) => [m, 0])), bench_total: actual, pool_total: poolSize };

  for (const [sid] of stageMap) {
    ctRows[sid] = { ...Object.fromEntries(mechIds.map((m) => [m, 0])), bench_total: 0, pool_total: 0 };
  }

  const dimCount = {};
  const incDim = (d, k) => {
    if (!dimCount[d]) dimCount[d] = new Map();
    dimCount[d].set(k, (dimCount[d].get(k) || 0) + 1);
  };

  let withTool = 0;
  let latSum = 0;
  let dupGe2 = 0;
  const toks = [];

  cases.forEach((c) => {
    const sev = c.severity || "GOLD";
    sevActual[sev] = (sevActual[sev] || 0) + 1;
    const t = c.turn === "multi" ? "multi" : "single";
    turnActual[t] += 1;
    const l1 = c.primary?.l1 || "NA";
    const l2 = c.primary?.l2 || "NA";
    stageActual[l1] = (stageActual[l1] || 0) + 1;
    mechActual[l2] = (mechActual[l2] || 0) + 1;

    if (!ctRows[l1]) ctRows[l1] = { ...Object.fromEntries(mechIds.map((m) => [m, 0])), bench_total: 0, pool_total: 0 };
    ctRows[l1][l2] = (ctRows[l1][l2] || 0) + 1;
    ctRows[l1].bench_total += 1;
    ctTotals[l2] = (ctTotals[l2] || 0) + 1;
    if (sev === "P0" || sev === "P1") {
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
    incDim("stage", l1);
    incDim("mechanism", l2);
    incDim("pattern", c.primary?.l3 || "NA");
    incDim("day", c.day || "");
    incDim("tokens", tokBucketKey(totalTok));
    incDim("round", roundBucketKey(t, c.session_round));
    incDim("group", c.group || "NA");
    incDim("recalled_from", c.meta?.recalled_from || "unknown");
    incDim("pattern_source", c.primary?.path_source || "none");
  });

  const dims = {};
  const poolDims = poolStats?.dims || {};
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

    dims[dim] = keys.filter((k) => k !== "").map((k) => {
      const pr = poolByKey.get(k);
      const cnt = cmap.get(k) || 0;
      const sb = actual ? cnt / actual : 0;
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
      known_tokens_p50: quant(toks.filter((x) => x > 0), 0.5),
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
  if (f.grp && c.group !== f.grp) return false;
  if (f.rec && (mt.recalled_from || "unknown") !== f.rec) return false;
  if (f.psrc && (p.path_source || "none") !== f.psrc) return false;
  if (f.dupOnly && (st.dup_question || 1) < 2) return false;
  if (f.longOnly && (st.total_tokens || 0) < longThreshold) return false;
  if (f.q) {
    const q = f.q.toLowerCase();
    const hay = [
      c.question, c.trace_id, c.session_id, p.label, p.path, c.group,
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
    if (by === "l1") return c.severity === "GOLD" && (!c.primary?.l1 || c.primary?.l1 === "NA") ? "GOLD" : (c.primary?.l1 || "NA");
    if (by === "min_tier") return c.bench?.long_tier ? `长对话 ${c.bench.long_tier}` : `常规 ${c.bench?.min_tier || c.bench?.tier || "?"}`;
    if (by === "group") return c.group || "NA";
    return c.severity || "GOLD";
  };
  const labelOf = (k) => {
    if (by === "l1") return k === "GOLD" ? "goldencase" : stageLabel(k, stageNames);
    if (by === "sev") return sevLabel(k);
    if (by === "group") return GROUP_LABELS[k] || k;
    return k;
  };
  cases.forEach((c) => {
    const k = keyOf(c);
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
    if (parts.length < 2 || !p.count) return;
    const cm = `${parts[0]}.${parts[1]}`;
    if (!patChildren.has(cm)) patChildren.set(cm, []);
    const pName = patternDisplayName(key, p.bucket, patNames, stageNames, mechNames);
    patChildren.get(cm).push({ id: `b/${key}`, name: pName, n: p.count });
  });

  const sIds = (ct.stages?.length ? ct.stages : Object.keys(rows)).filter((s) => s !== "NA");
  const mIds = (ct.mechanisms?.length ? ct.mechanisms : MECH_ORDER).filter((m) => m !== "NA");

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

  const naTotal = Number(rows.NA?.bench_total || 0);
  if (naTotal > 0) {
    stageNodes.push({ id: "b/NA", name: "goldencase / 未分类", n: naTotal, other: true });
  }

  return {
    id: "b",
    name: "全部",
    n: Number(ct.totals?.bench_total || tierData?.actual || sum(stageNodes.map((x) => x.n))),
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
  if (f.grp) add("grp", `分组 ${GROUP_LABELS[f.grp] || f.grp}`);
  if (f.rec) add("rec", `召回 ${RECALL_LABELS[f.rec] || f.rec}`);
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
    mxMode: "bench",
    f: EMPTY_FILTER(),
    moreOpen: false,
    trace: urlInit.trace,
    caseCache: new Map(),
    tierCasesCache: new Map(),
    sunburstState: { focus: "b", open: null },
    stepFilter: "all",
    showFullQ: false,
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
    if (S.f.l3 && S.f.l1 !== "NA") S.sunburstState = { focus: `b/${S.f.l3}`, open: null };
    else if (S.f.l1 && S.f.l2 && S.f.l1 !== "NA" && S.f.l2 !== "NA") S.sunburstState = { focus: `b/${S.f.l1}.${S.f.l2}`, open: null };
    else if (S.f.l1) S.sunburstState = { focus: `b/${S.f.l1}`, open: null };
    else S.sunburstState = { focus: "b", open: null };
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
    repaint();
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

  /* ---- Render sub-sections ---- */
  function renderHeroHTML(md, tierData) {
    const keys = S.isLong ? md.longKeys : md.stdKeys;
    const pool = manifest.pool || {};
    const q = manifest.quality || {};
    const joinRate = Number(q.join_rate ?? manifest.source?.join_rate ?? 1);
    const joinOk = joinRate >= 0.98;
    const unbiased = (tierData.coverage || []).filter((c) => !c.by_design);
    const maxUnbiased = unbiased.reduce((m, c) => Math.max(m, Number(c.max_abs_delta_pp || 0)), 0);
    const tol = Number(unbiased[0]?.tolerance_pp || params.tolerance_pp || 10);
    const auditOk = maxUnbiased <= tol;
    const sf = Number(tierData.shortfall || 0);
    const actualN = Number(tierData.actual || 0);
    const poolBase = S.isLong ? md.long_pool : md.base_pool;
    const tierPct = poolBase ? pct(actualN, poolBase, 1) : "—";
    const midLen = Number(md.pool_stats?.tokens?.p50 || 0);

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
        <div class="bn-badges">
          <span class="bn-badge ${joinOk ? "is-ok" : "is-warn"}"><i></i>标签对齐 ${pct(joinRate, 1, 1)}</span>
          <span class="bn-badge ${auditOk ? "is-ok" : "is-warn"}"><i></i>${auditOk ? `抽样偏差 ≤${maxUnbiased.toFixed(1)}%` : `偏差关注 ${maxUnbiased.toFixed(1)}%`}</span>
          ${sf > 0 ? `<span class="bn-badge is-warn"><i></i>数量缺口 −${fmt(sf)}</span>` : ""}
        </div>
      </div>

      <div class="bn-funnel">
        <div class="bn-fstage">
          <span class="bn-fstage-k">全量评测记录</span>
          <div class="bn-fstage-v">${fmt(pool.cases_raw || md.pool_size)}</div>
          <div class="bn-fstage-sub">
            <span><em>去重合并</em> −${compact(pool.dup_collapsed || 0)}</span>
            ${pool.empty_question ? `<span><em>过滤空句</em> −${fmt(pool.empty_question)}</span>` : ""}
          </div>
        </div>
        <div class="bn-fsep" aria-hidden="true">›</div>
        <div class="bn-fstage">
          <span class="bn-fstage-k">去重后候选总池</span>
          <div class="bn-fstage-v">${fmt(pool.cases_dedup || sum(modelOrder.map((id) => models[id].pool_size)))}</div>
          <div class="bn-fstage-sub">
            ${modelOrder.map((id) => `<span><em>${esc(models[id].label)}</em> ${compact(models[id].pool_size)}</span>`).join("")}
          </div>
        </div>
        <div class="bn-fsep" aria-hidden="true">›</div>
        <div class="bn-fstage">
          <span class="bn-fstage-k">${esc(md.label)} 候选池</span>
          <div class="bn-fstage-v">${fmt(md.pool_size)}</div>
          <div class="bn-fstage-sub">
            <span><em>常规</em> ${compact(md.base_pool)}</span>
            <span><em>长对话</em> ${fmt(md.long_pool)}</span>
            ${midLen > 0 ? `<span><em>中位长</em> ${compact(midLen)}</span>` : ""}
          </div>
        </div>
        <div class="bn-fsep" aria-hidden="true">›</div>
        <div class="bn-fstage is-focus">
          <span class="bn-fstage-k">${S.isLong ? `长对话 ${S.tier} 条档` : `${fmt(Number(S.tier))} 条基准档`}</span>
          <div class="bn-fstage-v">${fmt(actualN)}</div>
          <div class="bn-nest">
            ${keys.map((k) => {
              const kn = Number(k);
              const cur = Number(S.tier);
              const on = kn === cur;
              const inside = kn < cur;
              const sub = S.isLong ? `长 ${kn}` : fmt(kn);
              return `<button type="button" class="bn-nest-btn ${on ? "is-on" : inside ? "is-in" : ""}" data-nest="${kn}">${sub}${inside ? '<span class="bn-nest-sub">⊂</span>' : ""}</button>`;
            }).join("")}
            <span class="bn-nest-sub" style="margin-left:auto">占候选池 ${tierPct}</span>
          </div>
        </div>
      </div>
    </section>`;
  }

  function renderQuotaHTML(md, tierData) {
    const actualN = Number(tierData.actual || 1);
    const poolBaseSize = Number(tierData.pool || (S.isLong ? md.long_pool : md.base_pool) || md.pool_size || 1);
    const sActual = tierData.severity_actual || {};
    const sTarget = tierData.severity_target || {};
    const pBySev = md.pool_stats?.by_severity || {};

    const maxScale = Math.max(
      ...SEVS_ALL.map((s) => Math.max(
        actualN ? (Number(sActual[s] || 0) / actualN) * 100 : 0,
        Number(tierData.requested || actualN) ? (Number(sTarget[s] || 0) / Number(tierData.requested || actualN)) * 100 : 0,
        poolBaseSize ? (Number(pBySev[s] || 0) / poolBaseSize) * 100 : 0,
      )),
      30,
    );

    const rows = SEVS_ALL.map((sev) => {
      const cnt = Number(sActual[sev] || 0);
      const tgtCnt = Number(sTarget[sev] || 0);
      const bPct = actualN ? (cnt / actualN) * 100 : 0;
      const tPct = Number(tierData.requested || actualN) ? (tgtCnt / Number(tierData.requested || actualN)) * 100 : 0;
      const pPct = poolBaseSize ? (Number(pBySev[sev] || 0) / poolBaseSize) * 100 : 0;
      const toW = (p) => Math.min(100, Math.max(0, (p / maxScale) * 100)).toFixed(1);
      const c = sevTone(sev);
      const tStr = `${tPct.toFixed(1).replace(/\.0$/, "")}%`;
      const tgtText = sev === "P0" && tPct >= (params.p0_cap * 100 - 0.5) ? `≤${tStr}` : tStr;
      const pressed = S.f.sev === sev;
      const lbl = sevLabel(sev);
      const tip = `${lbl} · 已选 ${fmt(cnt)} 条 (${bPct.toFixed(1)}%) · 目标 ${tgtText} · 候选池 ${pPct.toFixed(1)}%`;

      return `<button type="button" class="bn-qrow" data-fsev="${sev}" aria-pressed="${pressed}" data-tip="${esc(tip)}" style="--c:${c}">
        <span class="bn-qsev"><i></i>${lbl}</span>
        <div class="bn-qtrack">
          <div class="bn-qfill" style="width:${toW(bPct)}%"></div>
          ${tPct > 0 ? `<div class="bn-qtarget" style="left:${toW(tPct)}%"></div>` : ""}
          ${pPct > 0 ? `<div class="bn-qpool" style="left:${toW(pPct)}%"></div>` : ""}
        </div>
        <span class="bn-qnum">${bPct.toFixed(1)}%<small>${fmt(cnt)}</small></span>
        <span class="bn-qtgt">${tgtText}</span>
        <span class="bn-qp">${pPct.toFixed(1)}%</span>
      </button>`;
    }).join("");

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

    const mActual = tierData.mechanism_actual || {};
    const mMax = Math.max(1, ...MECH_ORDER.map((m) => Number(mActual[m] || 0)));

    return `<section class="card bn-quota-card">
      <div class="card-head">
        <h2>配比结构</h2>
        <span class="meta">${fmt(actualN)} / ${fmt(tierData.requested || actualN)} 条</span>
        <div class="bn-qlegend">
          <span class="bn-ql-item"><i class="bn-ql-bar"></i>已选</span>
          <span class="bn-ql-item"><i class="bn-ql-tick"></i>目标</span>
          <span class="bn-ql-item"><i class="bn-ql-dot"></i>候选池</span>
        </div>
      </div>
      <div class="bn-qlist">${rows}</div>
      <div class="bn-subquota">
        <div class="bn-subwell">
          <div class="bn-subhead">
            <strong>单 / 多轮</strong>
            <span>目标 ${tTgtSingle.toFixed(0)}:${(100 - tTgtSingle).toFixed(0)}${pSinglePct ? ` · 池 ${pSinglePct.toFixed(0)}%` : ""}</span>
          </div>
          <div class="bn-turnbar">
            <div class="bn-turn-seg" style="width:${sPct.toFixed(1)}%" data-fturn="single" aria-pressed="${S.f.turn === "single"}" data-tip="单轮对话 · ${fmt(singleN)} 条 (${sPct.toFixed(1)}%)"></div>
            <div class="bn-turn-seg" style="width:${mPct.toFixed(1)}%" data-fturn="multi" aria-pressed="${S.f.turn === "multi"}" data-tip="多轮对话 · ${fmt(multiN)} 条 (${mPct.toFixed(1)}%)"></div>
            <div class="bn-qtarget" style="left:${tTgtSingle.toFixed(1)}%"></div>
            ${pSinglePct ? `<div class="bn-qpool" style="left:${pSinglePct.toFixed(1)}%"></div>` : ""}
          </div>
          <div class="bn-turn-labels">
            <button type="button" data-fturn="single" aria-pressed="${S.f.turn === "single"}" style="--c:var(--accent)"><i></i>单轮 ${sPct.toFixed(0)}% (${fmt(singleN)})</button>
            <button type="button" data-fturn="multi" aria-pressed="${S.f.turn === "multi"}" style="--c:var(--loc-ulq)"><i></i>多轮 ${mPct.toFixed(0)}% (${fmt(multiN)})</button>
          </div>
        </div>

        <div class="bn-subwell">
          <div class="bn-subhead">
            <strong>问题机制分布</strong>
            <span>覆盖 ${MECH_ORDER.filter((m) => (mActual[m] || 0) > 0).length} / 7 类</span>
          </div>
          <div class="bn-mechbars">
            ${MECH_ORDER.map((m) => {
              const n = Number(mActual[m] || 0);
              const h = n ? Math.max(14, Math.round((n / mMax) * 100)) : 8;
              const fullLbl = mechLabel(m, mechNames);
              const shortLbl = mechLabel(m, mechNames, true).slice(0, 4);
              return `<button type="button" class="bn-mbar ${n ? "" : "is-zero"}" data-fmech="${m}" aria-pressed="${S.f.l2 === m}" data-tip="${esc(fullLbl)} · ${fmt(n)} 条">
                <span class="bn-mbar-n">${fmt(n)}</span>
                <span class="bn-mbar-col" style="height:${h}%"></span>
                <span class="bn-mbar-k">${esc(shortLbl)}</span>
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
    const rows = tierData.dims?.[S.dim] || [];
    const tol = Number(activeCov.tolerance_pp || params.tolerance_pp || 10);
    const isAudit = !activeCov.by_design;

    const filterKeyForDim = {
      day: "day", tokens: "tok", round: "rnd",
      group: "grp", recalled_from: "rec", stage: "l1", mechanism: "l2",
      pattern: "l3", turn_type: "turn", pattern_source: "psrc", severity: "sev",
    }[S.dim];

    let bodyHTML = "";
    if (S.dim === "day" && rows.length) {
      const sorted = [...rows].sort((a, b) => String(a.key).localeCompare(String(b.key)));
      const maxShare = Math.max(0.01, ...sorted.flatMap((r) => [Number(r.share_in_bench || 0), Number(r.share_in_pool || 0)]));
      const maxAbs = Math.max(tol * 1.15, ...sorted.map((r) => Math.abs(Number(r.delta_pp || 0))), 5);
      const tolTop = 50 - (tol / maxAbs) * 46;
      const tolBot = 50 + (tol / maxAbs) * 46;
      const colsCss = `grid-template-columns: repeat(${sorted.length}, minmax(0, 1fr))`;

      bodyHTML = `<div class="bn-daychart">
        <div class="bn-dleg">
          <span class="bn-ql-item"><i class="bn-dleg-dot" style="background:var(--accent)"></i>已选占比</span>
          <span class="bn-ql-item"><i class="bn-dleg-dot" style="background:var(--t3)"></i>候选池</span>
          <span class="bn-ql-item"><i class="bn-dleg-line"></i>±${tol}% 参考线</span>
        </div>
        <div class="bn-day-bars" style="${colsCss}">
          ${sorted.map((r) => {
            const hb = Math.max(3, (Number(r.share_in_bench || 0) / maxShare) * 100);
            const hp = Math.max(3, (Number(r.share_in_pool || 0) / maxShare) * 100);
            const warn = Math.abs(Number(r.delta_pp || 0)) > tol;
            const dStr = String(r.key);
            const tip = `${dStr} · 已选 ${fmt(r.count)} 条 (${(r.share_in_bench * 100).toFixed(1)}%) · 候选池 ${(r.share_in_pool * 100).toFixed(1)}% · 差值 ${r.delta_pp > 0 ? "+" : ""}${r.delta_pp.toFixed(1)}%`;
            return `<button type="button" class="bn-day-col ${warn ? "is-warn" : ""}" data-dimk="day" data-dimv="${esc(dStr)}" aria-pressed="${S.f.day === dStr}" data-tip="${esc(tip)}">
              <div class="bn-day-pair">
                <span class="bn-day-b" style="height:${hb.toFixed(1)}%"></span>
                <span class="bn-day-p" style="height:${hp.toFixed(1)}%"></span>
              </div>
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
    } else if (rows.length) {
      const displayRows = [...rows].sort((a, b) => (b.count || 0) - (a.count || 0)).slice(0, 30);
      const maxS = Math.max(0.05, ...displayRows.flatMap((r) => [Number(r.share_in_bench || 0), Number(r.share_in_pool || 0)]));
      bodyHTML = `<div class="bn-db-head">
        <span>分布项</span><span>已选 ● 与候选池 ○</span><span>已选</span><span>候选池</span><span>差值</span>
      </div>
      <div class="bn-dist-body">
        ${displayRows.map((r) => {
          const sb = Number(r.share_in_bench || 0);
          const sp = Number(r.share_in_pool || 0);
          const dp = Number(r.delta_pp || 0);
          const leftPct = Math.min(98, (Math.min(sb, sp) / maxS) * 92 + 4);
          const rightPct = Math.min(98, (Math.max(sb, sp) / maxS) * 92 + 4);
          const bPos = Math.min(98, (sb / maxS) * 92 + 4);
          const pPos = Math.min(98, (sp / maxS) * 92 + 4);
          const cls = isAudit ? (Math.abs(dp) > tol ? "is-warn" : "is-ok") : "";
          const pressed = filterKeyForDim && S.f[filterKeyForDim] === r.key;
          const bLabel = bucketLabel(S.dim, r, maps);
          const tip = `${bLabel} · 已选 ${fmt(r.count)} 条 (${(sb * 100).toFixed(1)}%) · 候选池 ${(sp * 100).toFixed(1)}% · 差值 ${dp > 0 ? "+" : ""}${dp.toFixed(1)}%`;
          return `<button type="button" class="bn-db-row" data-dimk="${filterKeyForDim || ""}" data-dimv="${esc(r.key)}" aria-pressed="${pressed}" data-tip="${esc(tip)}">
            <span class="bn-db-lbl">${esc(bLabel)}</span>
            <div class="bn-db-track">
              <div class="bn-db-rail"></div>
              <div class="bn-db-span ${cls}" style="left:${leftPct.toFixed(1)}%;width:${Math.max(0, rightPct - leftPct).toFixed(1)}%"></div>
              <div class="bn-db-pool" style="left:${pPos.toFixed(1)}%"></div>
              <div class="bn-db-bench ${cls}" style="left:${bPos.toFixed(1)}%"></div>
            </div>
            <span class="bn-db-bench-n">${(sb * 100).toFixed(1)}%<small>${fmt(r.count)}</small></span>
            <span class="bn-db-pool-n">${(sp * 100).toFixed(1)}%</span>
            <span class="bn-db-pp ${cls}">${dp > 0 ? "+" : ""}${dp.toFixed(1)}%</span>
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
        ${cv ? `<span class="bn-dim-pp">${maxPp.toFixed(1)}%</span>` : ""}
      </button>`;
    };

    const toks = tierData.tokens || {};
    const extra = tierData.extra || {};
    const p50Show = extra.known_tokens_p50 > 0 ? extra.known_tokens_p50 : (toks.p50 || 0);

    return `<section class="card bn-dist-card">
      <div class="card-head">
        <h2>数据分布与偏差</h2>
        <span class="meta">${activeMeta.label} · ${rows.length} 项</span>
        <span class="bn-badge ${isAudit ? (activeCov.ok === false ? "is-warn" : "is-ok") : "is-accent"} end">
          <i></i>${isAudit ? (activeCov.ok === false ? `偏差关注 >${tol}%` : `偏差正常 ≤${tol}%`) : "主动配比维度"} · ${Number(activeCov.max_abs_delta_pp || 0).toFixed(1)}%
        </span>
      </div>
      <div class="bn-dimgroups">
        <div class="bn-dgrp"><span class="bn-dgrp-lbl">质检维度</span>${auditMeta.map(pillBtn).join("")}</div>
        <div class="bn-dgrp"><span class="bn-dgrp-lbl">配比维度</span>${designMeta.map(pillBtn).join("")}</div>
      </div>
      ${bodyHTML}
      <div class="bn-scale-strip">
        <div class="bn-scell"><span>已知长度中位</span><b>${p50Show ? compact(p50Show) : "—"}</b></div>
        <div class="bn-scell"><span>长度 90分位</span><b>${toks.p90 ? compact(toks.p90) : "—"}</b></div>
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
    const sIds = ct.stages?.length ? ct.stages : Object.keys(rows);
    const mIds = ct.mechanisms?.length ? ct.mechanisms : [...MECH_ORDER, "NA"];
    const nonEmptyCells = sIds.reduce((acc, s) => acc + mIds.filter((m) => (rows[s]?.[m] || 0) > 0).length, 0);

    const maxCell = Math.max(1, ...sIds.flatMap((s) => mIds.map((m) => {
      const b = Number(rows[s]?.[m] || 0);
      if (S.mxMode === "share") {
        const pt = Number(rows[s]?.pool_total || 0);
        return pt ? b / pt : 0;
      }
      return b;
    })));
    const maxRow = Math.max(1, ...sIds.map((s) => Number(rows[s]?.bench_total || 0)));
    const totalPool = Number(totals.pool_total || sum(sIds.map((s) => Number(rows[s]?.pool_total || 0))) || 0);

    return `<section class="card bn-mx-card">
      <div class="card-head">
        <h2>环节 × 机制</h2>
        <span class="meta">${fmt(totals.bench_total || tierData.actual || 0)} 样本 · ${nonEmptyCells} 非空组合</span>
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
            const name = ct.stage_names?.[s] && ct.stage_names[s] !== "NA" ? ct.stage_names[s] : stageLabel(s, stageNames);
            const hl = S.f.l1 === s;
            const label = s === "NA" ? "goldencase" : name;
            const tip = `${label} · 已选 ${fmt(rows[s]?.bench_total || 0)} · 候选池 ${fmt(rows[s]?.pool_total || 0)}`;
            return `<button type="button" class="rh ${hl ? "is-hl" : ""}" data-mxs="${esc(s)}" data-tip="${esc(tip)}">
              <span class="mx-lab">${esc(label)}</span>
              <span class="mx-caret" aria-hidden="true">›</span>
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
              const tip = `${fullLbl} · 已选 ${fmt(totals[m] || 0)} 条`;
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
              const sLbl = s === "NA" ? "goldencase / 未分类" : (ct.stage_names?.[s] || stageLabel(s, stageNames));
              const mLbl = mechLabel(m, mechNames);
              const tip = `${sLbl} × ${mLbl} · 已选 ${fmt(b)} 条 · 环节候选池 ${fmt(pt)}`;
              return `<button type="button" class="cell ${b ? "" : "is-empty"} ${cur ? "is-cur" : ""} ${ratio > 0.68 ? "hot" : ""}" style="${bg}" data-mxs="${esc(s)}" data-mxm="${esc(m)}" ${b ? `data-tip="${esc(tip)}"` : "disabled"}>
                <span class="cell-main"><b>${display}</b></span>
              </button>`;
            }).join("")).join("")}

            ${mIds.map((m) => {
              const tot = Number(totals[m] || 0);
              const hl = S.f.l2 === m;
              return `<button type="button" class="coltot ${hl ? "is-hl" : ""}" data-mxm="${esc(m)}">${fmt(tot)}</button>`;
            }).join("")}
          </div>
        </div>

        <div class="mx-tots">
          <div class="rowtot-head">已选 / 池</div>
          ${sIds.map((s) => {
            const bt = Number(rows[s]?.bench_total || 0);
            const pt = Number(rows[s]?.pool_total || 0);
            const w = Math.round((bt / maxRow) * 100);
            return `<button type="button" class="rowtot ${S.f.l1 === s ? "is-hl" : ""}" data-mxs="${esc(s)}" data-tip="已选 ${fmt(bt)} · 候选池 ${fmt(pt)}">
              <b>${fmt(bt)}</b><small class="bn-pool-n">${compact(pt)}</small>
              <span class="rowtot-bar"><i style="width:${w}%"></i></span>
            </button>`;
          }).join("")}
          <div class="rowtot-foot"><b>${fmt(totals.bench_total || 0)}</b><small class="bn-pool-n">${compact(totalPool)}</small></div>
        </div>
      </div>
    </section>`;
  }

  function renderCasesHTML(allCases, filteredCases, tierData) {
    const chips = activeFilterPills(S.f, maps);
    const total = filteredCases.length;
    const pages = Math.max(1, Math.ceil(total / S.size));
    S.page = Math.max(1, Math.min(pages, S.page));
    const slice = filteredCases.slice((S.page - 1) * S.size, S.page * S.size);
    const secActiveCount = [S.f.l2, S.f.turn, S.f.tok, S.f.grp, S.f.dupOnly ? "1" : ""].filter(Boolean).length;
    const secExpanded = S.moreOpen || secActiveCount > 0;

    const optList = (dimKey, label, curVal) => {
      const list = (tierData.dims?.[dimKey] || []).filter((r) => (r.count || 0) > 0);
      return `<select class="bn-sel ${curVal ? "is-on" : ""}" data-fsel="${dimKey}" aria-label="${label}">
        <option value="">${label}</option>
        ${list.map((r) => `<option value="${esc(r.key)}" ${curVal === r.key ? "selected" : ""}>${esc(bucketLabel(dimKey, r, maps))} (${fmt(r.count)})</option>`).join("")}
      </select>`;
    };

    const bodyHTML = !filteredCases.length
      ? `<div class="bn-empty">暂无匹配问句</div>`
      : S.view === "field"
        ? `<div class="bn-field">
            ${groupFieldCases(filteredCases, S.groupBy, stageNames).map((g) => `<div class="bn-fgrp">
              <div class="bn-fgrp-head"><strong>${esc(g.label)}</strong><span>${fmt(g.items.length)}</span></div>
              <div class="bn-ftiles">
                ${g.items.map((c) => {
                  const col = sevTone(c.severity);
                  const pLbl = c.primary?.label || (c.severity === "GOLD" ? "goldencase" : stageLabel(c.primary?.l1, stageNames));
                  const tip = `${sevLabel(c.severity)} · ${pLbl} · ${compact(c.stats?.total_tokens || 0)}\n${c.question}`;
                  return `<button type="button" class="bn-ftile ${(c.stats?.dup_question || 1) >= 2 ? "is-dup" : ""}" data-trace="${esc(c.trace_id)}" aria-current="${S.trace === c.trace_id}" style="--c:${col}" data-tip="${esc(tip)}"></button>`;
                }).join("")}
              </div>
            </div>`).join("")}
          </div>`
        : `<div class="bn-list">
            <div class="bn-lhead"><span>等级</span><span>问句内容与问题定位</span><span>对话形态</span><span>规模与耗时</span><span style="text-align:right">基准档位</span></div>
            ${slice.map((c) => {
              const col = sevTone(c.severity);
              const st = c.stats || {};
              const pr = c.primary || {};
              const pCount = rowProbsCount(c);
              const isLongCase = (st.total_tokens || 0) >= (params.long_tokens || 65536);
              const tTag = c.bench?.long_tier ? `长 ${c.bench.long_tier}` : `${fmt(c.bench?.min_tier || c.bench?.tier || S.tier)} 档`;
              const turnTxt = c.turn === "multi" ? `多轮 · ${c.session_round || 2} 轮` : "单轮";
              const stName = pr.l1 && pr.l1 !== "NA" ? stageLabel(pr.l1, stageNames) : "";
              const patName = pr.l3 && pr.l3 !== "NA" ? patternDisplayName(pr.l3, "", patNames, stageNames, mechNames) : "";
              const pathTag = !stName ? "" : (patName && patName !== stName
                ? (patName.startsWith(`${stName} ·`) ? patName : `${stName} · ${patName}`)
                : stName);
              return `<button type="button" class="bn-lrow" data-trace="${esc(c.trace_id)}" aria-current="${S.trace === c.trace_id}" style="--c:${col}">
                <span class="bn-sev-tag" style="--c:${col}">${esc(sevLabel(c.severity))}</span>
                <div class="bn-lq">
                  <span class="bn-lq-txt" title="${esc(c.question)}">${esc(c.question)}</span>
                  <span class="bn-lq-tags">
                    ${pathTag ? `<span class="bn-mtag is-path">${esc(pathTag)}</span>` : ""}
                    ${pr.label && pr.label !== "goldencase" && pr.label !== patName ? `<span class="bn-mtag">${esc(pr.label)}</span>` : ""}
                    ${pCount > 1 ? `<span class="bn-mtag">+${pCount - 1} 问题</span>` : ""}
                    ${(st.dup_question || 1) >= 2 ? `<span class="bn-mtag is-dup">×${st.dup_question} 重问</span>` : ""}
                    ${isLongCase ? `<span class="bn-mtag is-long">≥64K</span>` : ""}
                    ${c.group ? `<span class="bn-mtag">${esc(GROUP_LABELS[c.group] || c.group)}</span>` : ""}
                  </span>
                </div>
                <span class="bn-cell-meta">${turnTxt}</span>
                <span class="bn-cell-meta">${st.total_tokens ? compact(st.total_tokens) : "—"}<small>${st.tool_count || 0} 工具 · ${st.latency || 0}s</small></span>
                <span class="bn-tier-col">
                  <span class="bn-tier-tag">${tTag} #${c.bench?.rank ?? "—"}</span>
                  ${c.slug ? '<span class="bn-loc-dot" title="已入库可跳转"></span>' : ""}
                </span>
              </button>`;
            }).join("")}
          </div>
          <div class="bn-pager">
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
          </div>`;

    return `<section class="card bn-cases-card">
      <div class="bn-explorer-top">
        <div class="bn-explorer-title">
          <h2>问句全景</h2>
          <span class="bn-count-pill">${fmt(filteredCases.length)} / ${fmt(allCases.length)} 条</span>
        </div>
        <div class="bn-explorer-acts">
          <div class="seg" id="bn-seg-view" role="group" aria-label="展示方式">
            <span class="seg-knob" aria-hidden="true"></span>
            <button type="button" data-value="list" aria-pressed="${S.view === "list"}">清单</button>
            <button type="button" data-value="field" aria-pressed="${S.view === "field"}">方阵</button>
          </div>
          ${S.view === "field" ? `<select class="bn-sel" id="bn-groupby" aria-label="分组维度">
            <option value="l1" ${S.groupBy === "l1" ? "selected" : ""}>按环节分组</option>
            <option value="sev" ${S.groupBy === "sev" ? "selected" : ""}>按等级分组</option>
            <option value="min_tier" ${S.groupBy === "min_tier" ? "selected" : ""}>按首入档位</option>
            <option value="group" ${S.groupBy === "group" ? "selected" : ""}>按业务分组</option>
          </select>` : ""}
          <select class="bn-sel" id="bn-sort" aria-label="排序方式">
            <option value="rank" ${S.sort === "rank" ? "selected" : ""}>默认抽样序</option>
            <option value="sev" ${S.sort === "sev" ? "selected" : ""}>按问题等级</option>
            <option value="dup" ${S.sort === "dup" ? "selected" : ""}>高频重问优先</option>
            <option value="tokens" ${S.sort === "tokens" ? "selected" : ""}>文本长度降序</option>
            <option value="latency" ${S.sort === "latency" ? "selected" : ""}>耗时降序</option>
            <option value="probs" ${S.sort === "probs" ? "selected" : ""}>问题数降序</option>
            <option value="day" ${S.sort === "day" ? "selected" : ""}>时间倒序</option>
          </select>
        </div>
      </div>

      <div class="bn-chips" ${chips.length ? "" : "hidden"}>
        ${chips.map((c) => `<button type="button" class="bn-chip" data-clrk="${c.k}">${esc(c.lbl)} ×</button>`).join("")}
        ${chips.length > 1 ? `<button type="button" class="bn-chip-clear" id="bn-clr-all">清空全部</button>` : ""}
      </div>

      <div class="bn-fbar">
        <div class="bn-fprimary">
          <input type="search" class="bn-search" id="bn-search" value="${esc(S.f.q)}" placeholder="搜索问句 / 问题标签 / 轨迹编号…" autocomplete="off">
          <div class="bn-sev-pills">
            <button type="button" class="bn-sev-pill" data-fsev="" aria-pressed="${!S.f.sev}">全部</button>
            ${SEVS_ALL.map((s) => `<button type="button" class="bn-sev-pill" data-fsev="${s}" aria-pressed="${S.f.sev === s}" style="--c:${sevTone(s)}"><i></i>${sevLabel(s)}</button>`).join("")}
          </div>
          ${optList("stage", "全部环节", S.f.l1)}
          <button type="button" class="bn-toggle-pill bn-fmore" id="bn-fmore" aria-expanded="${secExpanded}">
            更多筛选${secActiveCount ? `<span class="bn-fmore-n">${secActiveCount}</span>` : ""}
          </button>
        </div>
        <div class="bn-fsec" ${secExpanded ? "" : "hidden"}>
          ${optList("mechanism", "问题机制", S.f.l2)}
          ${optList("turn_type", "对话形态", S.f.turn)}
          ${optList("tokens", "文本长度", S.f.tok)}
          ${optList("group", "业务分组", S.f.grp)}
          <button type="button" class="bn-toggle-pill" id="bn-tog-dup" aria-pressed="${S.f.dupOnly}">仅看高频重问 ≥2</button>
        </div>
      </div>

      ${bodyHTML}
    </section>`;
  }

  /* ---- Slide-over Trace Scene Workbench ---- */
  function renderStepBody(m) {
    const t = m.type;
    if (t === "llm_turn" && Array.isArray(m.output)) {
      return m.output.map((o) => {
        const parts = [];
        if (o.reasoning_content) {
          parts.push(`<details class="bn-think"><summary>思考过程 (${fmt(String(o.reasoning_content).length)} 字)</summary><div>${renderContent(String(o.reasoning_content), "text")}</div></details>`);
        }
        if (o.content) parts.push(`<div class="bn-msg-body">${renderContent(String(o.content), "md")}</div>`);
        (o.tool_calls || []).forEach((tc) => {
          const fn = tc?.function || {};
          parts.push(`<div class="bn-msg-body"><pre>${esc(`${fn.name || "tool"}(${typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments || {})})`)}</pre></div>`);
        });
        return parts.join("");
      }).join("");
    }
    if (t === "tool_call") {
      const txt = typeof m.input === "string" ? m.input : JSON.stringify(m.input || {}, null, 2);
      return `<div class="bn-msg-body"><pre>${esc(txt)}</pre></div>`;
    }
    if (t === "tool_result") {
      const rawOut = m.output ?? m.content ?? "";
      const txt = typeof rawOut === "string" ? rawOut : JSON.stringify(rawOut, null, 2);
      return `<div class="bn-msg-body">${renderContent(txt, txt.trim().startsWith("{") || txt.trim().startsWith("[") ? "json" : "md")}</div>`;
    }
    if (t === "final_answer") {
      return `<div class="bn-msg-body">${renderContent(String(m.content || ""), "md")}</div>`;
    }
    if (Array.isArray(m.blocks)) {
      return m.blocks.map((b) => `<div class="bn-msg-body">${renderContent((b.x || []).join(""), b.f || "text")}</div>`).join("");
    }
    const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content || "", null, 2);
    return `<div class="bn-msg-body">${renderContent(content, t === "user_question" ? "text" : "md")}</div>`;
  }

  async function paintSheet() {
    if (!sheetBackdrop) return;
    if (!S.trace) {
      sheetBackdrop.classList.remove("is-open");
      sheetBackdrop.setAttribute("aria-hidden", "true");
      return;
    }
    sheetBackdrop.classList.add("is-open");
    sheetBackdrop.setAttribute("aria-hidden", "false");

    const idx = lastFiltered.findIndex((x) => x.trace_id === S.trace);
    const summaryCase = idx >= 0 ? lastFiltered[idx] : null;
    const prevCase = idx > 0 ? lastFiltered[idx - 1] : null;
    const nextCase = idx >= 0 && idx < lastFiltered.length - 1 ? lastFiltered[idx + 1] : null;

    const full = await loadFullCase(S.model, S.trace, summaryCase);
    if (!S.trace) return;
    if (!full) {
      sheetBackdrop.innerHTML = `<div class="bn-sheet"><div class="bn-sh-head"><div class="bn-sh-id"><code>${esc(S.trace)}</code></div><div class="bn-sh-acts"><button type="button" class="bn-btn" id="bn-sh-close">关闭 ✕</button></div></div><div class="bn-sh-scroll"><div class="bn-empty">未找到对应样本记录</div></div></div>`;
      $("#bn-sh-close", sheetBackdrop).onclick = () => openTrace("");
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

    sheetBackdrop.innerHTML = `<aside class="bn-sheet" role="dialog" aria-label="样本执行现场">
      <div class="bn-sh-head">
        <div class="bn-sh-id">
          <span class="bn-sev-tag" style="--c:${c}">${esc(sevLabel(full.severity))}</span>
          <span class="bn-badge is-accent">${esc(modelLabel(full.model || S.model))}</span>
          <span class="bn-tier-tag">${tierTagLabel(b.long_tier || b.min_tier || b.tier || S.tier, !!b.long_tier)} #${b.rank ?? "—"}</span>
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
          <div class="bn-sh-q">${esc(full.question)}</div>
          ${full.question_full && full.question_full !== full.question ? `<div class="bn-sh-qfull">
            <button type="button" class="bn-btn" id="bn-sh-qfull" style="margin-bottom:8px">${S.showFullQ ? "收起完整输入" : "查看完整输入上下文"}</button>
            ${S.showFullQ ? `<pre>${esc(full.question_full)}</pre>` : ""}
          </div>` : ""}
          <div class="bn-sh-kvgrid">
            <span class="bn-sh-kv"><span>轨迹编号</span><code>${esc(full.trace_id)}</code></span>
            ${full.session_id ? `<span class="bn-sh-kv"><span>会话编号</span><code>${esc(full.session_id)}</code></span>` : ""}
            <span class="bn-sh-kv"><span>时间</span><b>${esc(full.request_time || full.day || "—")}</b></span>
            <span class="bn-sh-kv"><span>对话形态</span><b>${full.turn === "multi" ? `多轮 第 ${full.turn_index || full.session_round}/${full.session_round} 轮` : "单轮"}</b></span>
            <span class="bn-sh-kv"><span>文本长度</span><b>${st.total_tokens ? `${fmt(st.total_tokens)} (${fmt(st.input_tokens || 0)} + ${fmt(mt.output_tokens || Math.max(0, (st.total_tokens || 0) - (st.input_tokens || 0)))})` : "未记录"}</b></span>
            <span class="bn-sh-kv"><span>耗时</span><b>${st.latency || 0}s</b></span>
            <span class="bn-sh-kv"><span>工具调用</span><b>${st.tool_count || 0} 次</b></span>
            ${full.group ? `<span class="bn-sh-kv"><span>业务分组</span><b>${esc(GROUP_LABELS[full.group] || full.group)}</b></span>` : ""}
            ${mt.recalled_from ? `<span class="bn-sh-kv"><span>召回来源</span><b>${esc(RECALL_LABELS[mt.recalled_from] || mt.recalled_from)}</b></span>` : ""}
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
              ].filter((x, idx2, arr) => x && x !== "未分类" && arr.indexOf(x) === idx2).join(" › ");
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
                ${poolMsgs.map((pm) => `<div class="bn-pool-msg"><span class="bn-pool-role">${esc(POOL_ROLE_LABEL[pm.role] || pm.role || "消息")}</span>${esc(typeof pm.content === "string" ? pm.content : JSON.stringify(pm.content || ""))}</div>`).join("")}
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
      </div>
    </aside>`;

    $("#bn-sh-close", sheetBackdrop).onclick = () => openTrace("");
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

  function syncHighlights() {
    $$(".bn-quota-card [data-fsev]", root).forEach((b) => b.setAttribute("aria-pressed", String(S.f.sev === b.dataset.fsev)));
    $$(".bn-quota-card [data-fturn]", root).forEach((b) => b.setAttribute("aria-pressed", String(S.f.turn === b.dataset.fturn)));
    $$(".bn-quota-card [data-fmech]", root).forEach((b) => b.setAttribute("aria-pressed", String(S.f.l2 === b.dataset.fmech)));
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
      .slice(0, 4);

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
            <span class="meta" id="bn-sb-meta">全部</span>
            <button type="button" class="bn-chip-clear end" id="bn-sb-reset" hidden>返回全部</button>
          </div>
          <div id="bn-sb-host"></div>
          ${topPatterns.length ? `<div class="bn-toppats">
            <div class="bn-subhead"><strong>高频具体问题</strong><span>前 ${topPatterns.length} 项</span></div>
            <div class="bn-patgrid">
              ${topPatterns.map((p) => {
                const pName = patternDisplayName(p.key, p.bucket, patNames, stageNames, mechNames);
                const parts = String(p.key).split(".");
                const sub = parts.length >= 2 ? `${stageLabel(parts[0], stageNames)} · ${mechLabel(parts[1], mechNames)}` : "";
                return `<button type="button" class="bn-patitem" data-fpat="${esc(p.key)}" aria-pressed="${S.f.l3 === p.key}" data-tip="${esc(`${sub} · ${pName} · ${fmt(p.count)} 条`)}">
                  <span class="bn-patname">${esc(pName)}</span>
                  <b>${fmt(p.count)}</b>
                </button>`;
              }).join("")}
            </div>
          </div>` : ""}
        </section>
        ${renderCasesHTML(allCases, filtered, tierData)}
      </div>
      <div class="bn-backdrop" id="bn-backdrop" aria-hidden="true"></div>`;

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
    if (didRebuild) bindTips(root, (el) => el.dataset.tip || "");
    if (S.trace) paintSheet();
  }

  function wireSummary(tierData) {
    const segM = $("#bn-seg-model", root);
    if (segM) {
      const ctl = segmented(segM, (v) => {
        S.model = v;
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

    $$("[data-nest]", root).forEach((b) => b.addEventListener("click", () => {
      S.tier = b.dataset.nest;
      S.page = 1;
      S.sunburstState = { focus: "b", open: null };
      repaint();
    }));

    $$(".bn-quota-card [data-fsev]", root).forEach((b) => b.addEventListener("click", () => toggleFilter("sev", b.dataset.fsev)));
    $$(".bn-quota-card [data-fturn]", root).forEach((b) => b.addEventListener("click", () => toggleFilter("turn", b.dataset.fturn)));
    $$(".bn-quota-card [data-fmech]", root).forEach((b) => b.addEventListener("click", () => toggleFilter("l2", b.dataset.fmech)));
    $$(".bn-sb-card [data-fpat]", root).forEach((b) => b.addEventListener("click", () => {
      const code = b.dataset.fpat;
      const same = S.f.l3 === code;
      const parts = code.split(".");
      S.f.l1 = same ? "" : (parts[0] || "");
      S.f.l2 = same ? "" : (parts[1] || "");
      S.f.l3 = same ? "" : code;
      syncSunburstFromFilter();
      S.page = 1;
      repaint();
    }));
    $$(".bn-dist-card [data-dimpick]", root).forEach((b) => b.addEventListener("click", () => { S.dim = b.dataset.dimpick; repaint(); }));
    $$(".bn-dist-card [data-dimk]", root).forEach((b) => b.addEventListener("click", () => {
      const k = b.dataset.dimk;
      const v = b.dataset.dimv;
      if (k) toggleFilter(k, v);
    }));
    const dupTop = $("#bn-dup-btn", root);
    if (dupTop) dupTop.onclick = () => toggleFilter("dupOnly", true);

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

    const sbHost = $("#bn-sb-host", root);
    if (sbHost && !sbHost.firstChild) {
      const tree = buildSunburstTree(tierData, lastFiltered, taxonomy, stageNames, mechNames, patNames);
      let sbReady = false;
      sunburst(sbHost, tree, {
        unit: "样本",
        sort: true,
        state: S.sunburstState,
        onChange: (focus) => {
          const meta = $("#bn-sb-meta", root);
          const resetBtn = $("#bn-sb-reset", root);
          if (meta) meta.textContent = focus.id === "b" ? "全部" : focus.name;
          if (resetBtn) resetBtn.hidden = focus.id === "b";
          if (!sbReady) return;
          const code = focus.id === "b" ? "" : focus.id.slice(2);
          const parts = code.split(".");
          S.f.l1 = parts[0] || "";
          S.f.l2 = parts[1] || "";
          S.f.l3 = parts.length > 2 ? code : "";
          S.page = 1;
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
          repaint();
        };
      }
    }
  }

  function wireCases(filtered) {
    const card = $(".bn-cases-card", root);
    if (!card) return;
    const segV = $("#bn-seg-view", card);
    if (segV) {
      const ctl = segmented(segV, (v) => {
        S.view = v;
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
        focusSearchAfterRender = true;
        searchPos = e.target.selectionStart;
        repaint({ rebuildSummary: false });
      });
    }
    $$("[data-fsev]", card).forEach((b) => b.addEventListener("click", () => toggleFilter("sev", b.dataset.fsev)));
    const fmoreBtn = $("#bn-fmore", card);
    if (fmoreBtn) {
      fmoreBtn.addEventListener("click", () => {
        S.moreOpen = !S.moreOpen;
        const tray = $(".bn-fsec", card);
        if (tray) tray.hidden = !S.moreOpen;
        fmoreBtn.setAttribute("aria-expanded", String(S.moreOpen));
      });
    }
    $$("[data-fsel]", card).forEach((sel) => sel.addEventListener("change", (e) => {
      const key = {
        stage: "l1", mechanism: "l2", turn_type: "turn", tokens: "tok", group: "grp",
      }[sel.dataset.fsel];
      if (!key) return;
      S.f[key] = e.target.value;
      if (key === "l1" && !e.target.value) S.f.l3 = "";
      syncSunburstFromFilter();
      S.page = 1;
      repaint();
    }));
    const togDup = $("#bn-tog-dup", card);
    if (togDup) togDup.onclick = () => { S.f.dupOnly = !S.f.dupOnly; S.page = 1; repaint(); };

    const sortEl = $("#bn-sort", card);
    if (sortEl) sortEl.onchange = (e) => { S.sort = e.target.value; repaint({ rebuildSummary: false }); };
    const grpEl = $("#bn-groupby", card);
    if (grpEl) grpEl.onchange = (e) => { S.groupBy = e.target.value; repaint({ rebuildSummary: false }); };
    const psEl = $("#bn-pagesize", card);
    if (psEl) psEl.onchange = (e) => { S.size = Number(e.target.value); S.page = 1; repaint({ rebuildSummary: false }); };

    $$("[data-clrk]", card).forEach((b) => b.addEventListener("click", () => {
      const k = b.dataset.clrk;
      S.f[k] = typeof S.f[k] === "boolean" ? false : "";
      if (k === "l1") S.f.l3 = "";
      syncSunburstFromFilter();
      S.page = 1;
      repaint();
    }));
    const clrAll = $("#bn-clr-all", card);
    if (clrAll) {
      clrAll.onclick = () => {
        S.f = EMPTY_FILTER();
        S.sunburstState = { focus: "b", open: null };
        S.page = 1;
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
  root._bnCleanup = () => document.removeEventListener("keydown", onKeyDown);

  await repaint();
  announce("Bench 页面已加载");
}
