/* MOCK · 评测评测 sample data. Nothing in this file is measured.
   The audit pipeline does not exist yet: a second model re-reads every P0–P4 problem the evaluator
   filed and rules on three things — is the severity right (定级合理), do the cited evidence quotes
   on their own lead to the problem (证据闭环), is the written problem true to the transcript
   (输出准确). Each case is also re-run several times (重复一致) and a sample is re-labelled by
   people (人工一致). Until the feed exists judge.js falls back to judgeMock(); the real feed puts
   the same shape at `judge[<p>]` in the data.json shell with `mock` unset, and the 示例数据 badge
   disappears.

   Shape (every rate in 0..1):
   {
     mock: true, version: "J-1112", prev: "J-1106", audited, runs, labeled,
     dims: [{ key: "grade"|"evidence"|"output", name, rate, prev, n,
              bySev: [{ sev, rate, n }],                 per severity the evaluator gave
              reasons: [{ name, n }] }],                 why the audit model rejected it
     stages: [{ id, name, n, grade, evidence, output }], pass rate per stage and dimension
     repeat: { runs, sameSev, sameSet, sameEvidence, prev: {…same keys},
               bySev: [{ sev, n, agree: [all, all−1, all−2, worse] shares }],
               overlap: [{ lo, hi, n }] },               per-case problem-set Jaccard histogram
     human: { kappa, prev, labeled, confusion: { labels: [P0..P4, none], m },
              bySev: [{ sev, precision, recall, n }] },
     badcases: [{ id, q, model, date, stage, sev, label, evidence: [{ m, quote, ok }],
                  verdict: { grade|evidence|output: { ok, note } }, suggest, human, runs: [sev…] }]
   } */

const LEVELS = ["P0", "P1", "P2", "P3", "P4", "none"];
const SEVS = LEVELS.slice(0, 5);

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
const clamp = (v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));

const FALLBACK_STAGES = [
  ["S1", "意图理解"], ["S2", "任务规划"], ["S3", "工具选择"], ["S4", "参数构造"], ["S5", "结果解析"],
  ["S6", "数据核验"], ["S7", "推理计算"], ["S8", "答案组织"], ["S9", "表达呈现"],
];

const DIMS = [
  ["grade", "定级合理", 0.84, 0.8, [["定级偏重", 46], ["定级偏轻", 31], ["影响面判断错", 12]]],
  ["evidence", "证据闭环", 0.78, 0.71, [["证据推不出现象", 52], ["引用与原文不符", 23], ["只有结论没有过程", 18], ["证据位置错位", 9]]],
  ["output", "输出准确", 0.88, 0.86, [["现象描述失实", 27], ["归错环节", 22], ["同一问题重复报告", 15], ["把正确行为当问题", 11]]],
];

/* Hand-written badcases: each one fails exactly the dimension it is filed under, so the list shows
   what a failure in that dimension looks like. */
const CASES = [
  {
    q: "近五日北向资金净流入最多的行业", sev: "P1", stage: 6, label: "北向资金口径用错，把沪股通单边当成合计",
    evidence: [[7, "调用 hsgt_flow(market=\"SH\") 返回 5 日净流入 82.3 亿", true], [12, "回答：北向资金近五日净流入最多的是电子，合计 82.3 亿", true]],
    fail: "grade", note: "口径错误只影响数值大小，行业排名与结论不变；按影响面应为 P2。", suggest: "P2", human: "P2",
  },
  {
    q: "宁德时代三季报毛利率同比变化", sev: "P0", stage: 7, label: "毛利率同比算成环比",
    evidence: [[9, "Q3 毛利率 22.4%，Q2 21.1%", true], [14, "回答：毛利率同比提升 1.3 个百分点", true]],
    fail: "grade", note: "结论方向错误但数值在答案中可见，用户可自行发现；P0 留给会直接导致错误决策的问题，应为 P1。", suggest: "P1", human: "P1",
  },
  {
    q: "今年以来涨幅超过 50% 的科创板股票", sev: "P2", stage: 4, label: "筛选条件漏掉了上市不满一年的股票",
    evidence: [[5, "调用 stock_screen(board=\"STAR\", ytd_gt=50)", true], [6, "返回 37 只", false]],
    fail: "evidence", note: "两条证据只说明调用了筛选并返回 37 只，看不出有股票被漏掉；需要引用缺失的个股或筛选参数的默认值。",
  },
  {
    q: "比亚迪和特斯拉最近一季度交付量对比", sev: "P1", stage: 5, label: "把特斯拉产量当成交付量",
    evidence: [[8, "特斯拉 Q3 生产 46.9 万辆", true], [8, "Q3 交付 46.3 万辆", false]],
    fail: "evidence", note: "第二条引用在原文第 8 条消息中不存在，原文写的是\"交付 46.29 万辆\"，数字被改写。",
  },
  {
    q: "沪深 300 估值分位与历史均值", sev: "P2", stage: 7, label: "估值分位的时间窗口与历史均值不一致",
    evidence: [[11, "当前 PE 分位 38%（近 5 年）", true], [11, "历史均值 12.6 倍", true], [15, "回答：低于历史均值", false]],
    fail: "evidence", note: "引用说明了两个口径，但没有证据表明窗口不同，\"历史均值\"的区间在原文里找不到。只有结论没有过程。",
  },
  {
    q: "美联储降息对 A 股银行板块的影响", sev: "P3", stage: 8, label: "回答没有给出银行板块的具体影响",
    evidence: [[16, "降息通常利好成长股，对银行息差形成压力", true]],
    fail: "output", note: "原文第 16 条已写明\"对银行息差形成压力\"，问题描述与原文不符，属于把正确行为当问题。",
  },
  {
    q: "半导体 ETF 本周资金流向", sev: "P2", stage: 3, label: "选了行业指数接口而不是 ETF 份额接口",
    evidence: [[4, "调用 index_flow(code=\"半导体\")", true], [9, "调用 etf_share(code=\"512480\")", true]],
    fail: "output", note: "第 9 条已改用 ETF 份额接口并给出正确结果；问题应记在工具选择后的自我修正，环节归属错误。",
  },
  {
    q: "茅台近三年分红率", sev: "P1", stage: 6, label: "2023 年分红率缺失特别分红",
    evidence: [[10, "2023 年度现金分红 309 亿", true], [10, "另有特别分红 194 亿", true], [13, "回答：2023 年分红率 51.9%", true]],
    fail: "output", note: "与第 2 个问题\"分红口径不完整\"描述的是同一现象，属于重复报告。",
  },
  {
    q: "光伏组件价格最新走势", sev: "P3", stage: 5, label: "价格单位元/W 与元/片混用",
    evidence: [[6, "组件均价 0.74 元/W", true], [12, "回答：组件价格约 0.74 元每片", true]],
    fail: "grade", note: "单位错误使价格量级完全失真，用户会据此得出错误判断；应为 P1。", suggest: "P1", human: "P1",
  },
  {
    q: "黄金与美元指数相关性", sev: "P2", stage: 7, label: "相关系数的样本区间没有说明",
    evidence: [[9, "计算得到相关系数 -0.42", true]],
    fail: "evidence", note: "一条证据只给出系数，推不出\"区间未说明\"；应引用回答中缺少区间的那一句。",
  },
  {
    q: "中证 1000 成分股中 ROE 连续三年大于 15% 的公司", sev: "P2", stage: 4, label: "ROE 用了 TTM 而不是年报口径",
    evidence: [[5, "调用 fin_screen(field=\"roe_ttm\", gt=15, years=3)", true]],
    fail: "grade", note: "口径差异会改变筛选结果但答案注明了 TTM，影响有限；应为 P3。", suggest: "P3", human: "P3",
  },
  {
    q: "港股通南向资金本月持仓变化最大的个股", sev: "P1", stage: 5, label: "持股变动把股数当成市值排序",
    evidence: [[7, "按 change_shares 降序取前 10", true], [8, "腾讯控股增持 1.2 亿股", true], [11, "回答：南向资金本月增持市值最多的是腾讯", true]],
    fail: "output", note: "原文第 11 条回答写的是\"增持股数最多\"，问题描述把回答内容写错了。",
  },
];

export function judgeMock(product, tax) {
  const r = rng(seedOf(`judge|${product}`));
  const jitter = (v, w) => v + (r() - 0.5) * w;

  const stageList = (tax?.stages || []).length
    ? tax.stages.slice().sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1))).map((s) => [s.id, s.name])
    : FALLBACK_STAGES;

  const audited = 2400;
  const sevShare = [0.05, 0.16, 0.31, 0.29, 0.19];
  const dims = DIMS.map(([key, name, rate, prev, reasons]) => {
    const v = round(clamp(jitter(rate, 0.02)));
    return {
      key, name, rate: v, prev, n: audited,
      // Heavier severities are argued over more: the audit model disagrees with P0/P1 more often.
      bySev: SEVS.map((sev, i) => ({
        sev, n: Math.round(audited * sevShare[i]),
        rate: round(clamp(jitter(v - 0.1 + i * 0.045, 0.06))),
      })),
      reasons: reasons.map(([n2, n]) => ({ name: n2, n: Math.round(n * (0.8 + r() * 0.4)) })),
    };
  });

  const stages = stageList.map(([id, name]) => ({
    id, name, n: Math.round(80 + r() * 320),
    grade: round(clamp(jitter(dims[0].rate, 0.2), 0.5, 0.98)),
    evidence: round(clamp(jitter(dims[1].rate, 0.26), 0.45, 0.98)),
    output: round(clamp(jitter(dims[2].rate, 0.16), 0.55, 0.99)),
  }));

  const runs = 5;
  const repeatBySev = LEVELS.map((sev, i) => {
    const firm = sev === "none" ? 0.8 : [0.71, 0.62, 0.52, 0.48, 0.57][i];
    const a = clamp(jitter(firm, 0.08), 0.2, 0.95);
    const b = (1 - a) * jitter(0.55, 0.1);
    const c = (1 - a - b) * jitter(0.65, 0.1);
    return { sev, n: Math.round(audited * (sevShare[i] || 0.12)), agree: [a, b, c, Math.max(0, 1 - a - b - c)].map((v) => round(v)) };
  });
  // Jaccard of the problem sets across the reruns of one case: mostly high, a long low tail.
  const overlap = Array.from({ length: 10 }, (_, k) => ({
    lo: k / 10, hi: (k + 1) / 10,
    n: Math.round(12 + 340 * Math.exp(-((k - 7.6) ** 2) / 3.2) + r() * 14),
  }));
  const repeat = {
    runs, sameSev: round(jitter(0.81, 0.02)), sameSet: round(jitter(0.69, 0.02)), sameEvidence: round(jitter(0.74, 0.02)),
    prev: { sameSev: 0.77, sameSet: 0.63, sameEvidence: 0.7 },
    bySev: repeatBySev, overlap,
  };

  const sizes = [40, 120, 260, 300, 220, 260];
  const m = LEVELS.map((_, i) => LEVELS.map((__, j) => {
    const d = Math.abs(i - j);
    const base = d === 0 ? 0.72 : d === 1 ? 0.11 + (j < i ? 0.03 : 0) : d === 2 ? 0.025 : 0.006;
    return Math.max(0, Math.round(sizes[i] * Math.max(0, jitter(base, base * 0.5))));
  }));
  const colSum = LEVELS.map((_, j) => m.reduce((a, row) => a + row[j], 0));
  const rowSum = m.map((row) => row.reduce((a, b) => a + b, 0));
  const human = {
    kappa: round(jitter(0.71, 0.02)), prev: 0.66, labeled: sizes.reduce((a, b) => a + b, 0),
    confusion: { labels: LEVELS, m },
    // Per severity: of what the evaluator filed at this level, how much people agree (precision);
    // of what people put at this level, how much the evaluator found at it (recall).
    bySev: SEVS.map((sev, i) => ({ sev, precision: round(m[i][i] / (colSum[i] || 1)), recall: round(m[i][i] / (rowSum[i] || 1)), n: rowSum[i] })),
  };

  const models = ["v1106", "v1112"];
  const badcases = CASES.map((c, k) => {
    const st = stageList[Math.min(stageList.length - 1, c.stage - 1)] || stageList[0];
    const verdict = Object.fromEntries(DIMS.map(([key]) => [key, key === c.fail
      ? { ok: false, note: c.note }
      : { ok: true, note: "" }]));
    const si = SEVS.indexOf(c.sev);
    const runsOut = Array.from({ length: runs }, (_, i) => {
      if (i === 0) return c.sev;
      const roll = r();
      return roll < 0.6 ? c.sev : SEVS[clamp(si + (roll < 0.8 ? 1 : -1), 0, 4)];
    });
    return {
      id: `bc${k + 1}`, q: c.q, model: models[k % 2], date: `2026-11-${String(15 - (k % 9)).padStart(2, "0")}`,
      stage: st[0], stageName: st[1], sev: c.sev, label: c.label,
      evidence: c.evidence.map(([mi, quote, ok]) => ({ m: mi, quote, ok })),
      verdict, fail: c.fail, suggest: c.suggest || null, human: c.human || c.sev, runs: runsOut,
    };
  });

  return {
    mock: true, version: "J-1112", prev: "J-1106", audited, runs, labeled: human.labeled,
    dims, stages, repeat, human, badcases,
  };
}
