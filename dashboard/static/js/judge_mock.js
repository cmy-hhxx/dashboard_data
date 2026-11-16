/* MOCK · 评测评测 sample data. Nothing in this file is measured.
   The evaluator audit pipeline (human re-labels, repeated judge runs) does not exist yet; until it
   does, judge.js falls back to judgeMock(). The real feed replaces it by putting the same shape at
   `judge[<p>]` in the data.json shell (small, so the page never waits for data-<p>.json) with
   `mock` unset — judge.js reads that first and the 示例数据 badge disappears.

   Shape (every rate in 0..1):
   {
     mock: true,
     version: "J-1112", prev: "J-1106",             judge versions being compared
     labeled: 1200, runs: 5,                       human-labelled samples, repeated judge runs
     kpi: { kappa, precision, recall, ece, repeat, evidence } and kpiPrev with the same keys,
     confusion: { labels: [P0..P4, none], m: [[human row][judge col] counts] },
     calibration: [{ c: mean confidence, hit: human-confirmed share, n }],
     categories: [{ id, name, precision, recall, n }],
     stability: [{ sev, n, agree: [5/5, 4/5, 3/5, ≤2/5] shares }],
     bias: [{ name, shift: mean judge − human severity steps, lo, hi, n }],
     trend: [{ date, value: daily κ, volume: labelled samples }], releases: [{ date, label }],
     disagreements: [{ q, human, judge, kind }]
   } */

const LEVELS = ["P0", "P1", "P2", "P3", "P4", "none"];

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const seedOf = (s) => [...String(s)].reduce((h, ch) => Math.imul(h ^ ch.charCodeAt(0), 16777619), 2166136261);
const round = (v, d = 3) => Math.round(v * 10 ** d) / 10 ** d;

const FALLBACK_STAGES = [
  ["S1", "意图理解"], ["S2", "任务规划"], ["S3", "工具选择"], ["S4", "参数构造"], ["S5", "结果解析"],
  ["S6", "数据核验"], ["S7", "推理计算"], ["S8", "答案组织"], ["S9", "表达呈现"],
];

const QUESTIONS = [
  "近五日北向资金净流入最多的行业", "宁德时代三季报毛利率同比变化", "今年以来涨幅超过 50% 的科创板股票",
  "比亚迪和特斯拉最近一季度交付量对比", "沪深 300 估值分位与历史均值", "美联储降息对 A 股银行板块的影响",
  "半导体 ETF 本周资金流向", "茅台近三年分红率", "光伏组件价格最新走势", "黄金与美元指数相关性",
];

export function judgeMock(product, tax) {
  const r = rng(seedOf(`judge|${product}`));
  const jitter = (v, w) => v + (r() - 0.5) * w;

  // Confusion: mostly diagonal, neighbours bleed, the judge is a touch harsher on P2/P3.
  const sizes = [40, 120, 260, 300, 220, 260];
  const m = LEVELS.map((_, i) => LEVELS.map((__, j) => {
    const d = Math.abs(i - j);
    const base = d === 0 ? 0.72 : d === 1 ? 0.11 + (j < i ? 0.03 : 0) : d === 2 ? 0.025 : 0.006;
    return Math.max(0, Math.round(sizes[i] * Math.max(0, jitter(base, base * 0.5))));
  }));

  const calibration = Array.from({ length: 10 }, (_, k) => {
    const c = 0.05 + k * 0.1;
    // Over-confident at the top end, a little timid at the bottom.
    const hit = Math.min(1, Math.max(0, c + (c > 0.6 ? -(c - 0.6) * 0.35 : (0.6 - c) * 0.12) + (r() - 0.5) * 0.04));
    return { c: round(c, 2), hit: round(hit), n: Math.round(20 + 160 * Math.exp(-((c - 0.78) ** 2) / 0.06) + r() * 20) };
  });

  const stageList = (tax?.stages || []).length
    ? tax.stages.slice().sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1))).map((s) => [s.id, s.name])
    : FALLBACK_STAGES;
  const categories = stageList.map(([id, name]) => {
    const p = Math.min(0.97, Math.max(0.45, jitter(0.8, 0.3)));
    const rc = Math.min(0.97, Math.max(0.4, jitter(0.74, 0.36)));
    return { id, name, precision: round(p), recall: round(rc), n: Math.round(40 + r() * 260) };
  });

  const stability = LEVELS.map((sev, i) => {
    const firm = sev === "none" ? 0.78 : [0.74, 0.62, 0.5, 0.47, 0.55][i];
    const a = Math.max(0.2, jitter(firm, 0.08));
    const b = (1 - a) * jitter(0.55, 0.1);
    const c = (1 - a - b) * jitter(0.65, 0.1);
    return { sev, n: sizes[i], agree: [a, b, c, Math.max(0, 1 - a - b - c)].map((v) => round(v)) };
  });

  const bias = [
    ["回答超过 2k 字", 0.34], ["含表格 / 图表", 0.18], ["多轮追问", 0.12], ["工具报错后自我修正", -0.27],
    ["英文问句", -0.08], ["港美股标的", 0.05], ["新上线技能", 0.22], ["凌晨请求", -0.03],
  ].map(([name, s]) => {
    const shift = jitter(s, 0.06);
    const w = 0.05 + r() * 0.08;
    return { name, shift: round(shift), lo: round(shift - w), hi: round(shift + w), n: Math.round(60 + r() * 400) };
  });

  const days = 21;
  const end = Date.UTC(2026, 10, 15);
  const trend = Array.from({ length: days }, (_, k) => {
    const t = new Date(end - (days - 1 - k) * 86400000).toISOString().slice(0, 10);
    const step = t >= "2026-11-12" ? 0.05 : t >= "2026-11-06" ? 0.025 : 0;
    return { date: t, value: round(Math.min(0.92, 0.64 + step + (r() - 0.5) * 0.05)), volume: Math.round(30 + r() * 70) };
  });

  const disagreements = QUESTIONS.map((q, k) => {
    const human = LEVELS[Math.floor(r() * 6)];
    let j = LEVELS.indexOf(human) + (r() < 0.5 ? -1 : 1) * (1 + (r() < 0.2 ? 1 : 0));
    j = Math.max(0, Math.min(5, j));
    if (LEVELS[j] === human) j = (j + 1) % 6;
    return { q, human, judge: LEVELS[j], kind: ["漏报", "误报", "定级偏重", "定级偏轻", "证据不实"][k % 5] };
  });

  const kpi = { kappa: 0.71, precision: 0.83, recall: 0.76, ece: 0.062, repeat: 0.81, evidence: 0.94 };
  const kpiPrev = { kappa: 0.66, precision: 0.8, recall: 0.71, ece: 0.081, repeat: 0.77, evidence: 0.91 };
  Object.keys(kpi).forEach((k) => { kpi[k] = round(jitter(kpi[k], 0.02)); });

  return {
    mock: true, version: "J-1112", prev: "J-1106", labeled: sizes.reduce((a, b) => a + b, 0), runs: 5,
    kpi, kpiPrev, confusion: { labels: LEVELS, m }, calibration, categories, stability, bias, trend,
    releases: [{ date: "2026-11-06", label: "v1106" }, { date: "2026-11-12", label: "v1112" }],
    disagreements,
  };
}
