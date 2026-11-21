import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const JS_DIR = path.resolve(HERE, "../static/js");

globalThis.location = { search: "" };
globalThis.window = {};
const benchMod = await import("../static/js/bench.js");

const SAMPLE_RAW = {
  schema: 2,
  product: "aime",
  stage_names: { S1: "取数规划", S9: "答案合成", S10: "请求生成" },
  mech_names: { M1: "空转未执行", M2: "目标错配", M6: "无依据断言" },
  pat_names: { "S10.M2.8": "未按技能拆分阈值与资产类别", "S9.M1.1": "未生成回答" },
  manifest: {
    module: "bench_module",
    version: "1.0.0",
    channel: "aime",
    params: { golden_share: 0.2, p0_cap: 0.25, long_tokens: 65536, tiers: [500, 1000], long_tiers: [10, 20], models: ["aime_expert"] },
    pool: { cases_raw: 1000, cases_dedup: 600, dup_collapsed: 300, empty_question: 10 },
    quality: { join_rate: 0.9973 },
  },
  models: {
    aime_expert: {
      pool_size: 600,
      base_pool: 580,
      long_pool: 20,
      pool_stats: {
        pool_size: 600,
        by_severity: { GOLD: 120, P0: 30, P1: 150, P2: 180, P3: 80, P4: 40 },
        by_turn: { single: 450, multi: 150 },
        tokens: { p50: 0, p90: 32000, p99: 62000 },
        dims: {
          stage: [{ key: "S9", bucket: "答案合成", count: 300, share: 0.5 }],
        },
      },
      tiers: {},
      long_tiers: {},
    },
  },
};

const SAMPLE_CASES = [
  {
    trace_id: "20003020179362274681000000000199",
    session_id: "thread_1",
    model: "aime_expert",
    day: "2026-11-06",
    request_time: "2026-11-06 16:01:27",
    group: "0_daily_eval",
    question: "分析宁德时代扣非归母净利润变化趋势",
    turn: "multi",
    session_round: 5,
    severity: "P0",
    primary: { l1: "S10", l2: "M2", l3: "S10.M2.8", label: "未按技能拆分阈值与资产类别", path: "S10.M2.8", path_source: "join" },
    problems: [
      { severity: "P0", label: "未按技能拆分阈值与资产类别", path: "S10.M2.8", l1: "S10", l2: "M2", l3: "S10.M2.8" },
      { severity: "P1", label: "缺失同比基准", path: "S9.M6.1", l1: "S9", l2: "M6", l3: "S9.M6.1" },
    ],
    stats: { total_tokens: 72000, input_tokens: 68000, tool_count: 3, latency: 12.4, dup_question: 4 },
    meta: { recalled_from: "lost_user", tool_names: ["finquery"] },
    bench: { tier: 500, min_tier: 500, long_tier: 0, rank: 0, pool_size: 580 },
    slug: "slug-1",
    case_key: "daily|aime_expert|thread_1",
  },
  {
    trace_id: "20003020179399888704300000000276",
    session_id: "thread_2",
    model: "aime_expert",
    day: "2026-11-07",
    request_time: "2026-11-07 09:00:00",
    group: "2_task_eval/0_lost_user_back_test",
    question: "今日涨幅居前的板块有哪些？",
    turn: "single",
    session_round: 1,
    severity: "GOLD",
    primary: { l1: "NA", l2: "NA", l3: "NA", label: "goldencase", path: "", path_source: "none" },
    problems: [],
    stats: { total_tokens: 0, input_tokens: 0, tool_count: 1, latency: 4.2, dup_question: 1 },
    meta: { recalled_from: "unknown", tool_names: ["stock_sector"] },
    bench: { tier: 500, min_tier: 500, long_tier: 0, rank: 1, pool_size: 580 },
    slug: null,
    case_key: null,
  },
];

test("mock dataset file is deleted and unused", () => {
  assert.equal(fs.existsSync(path.join(JS_DIR, "bench_mock.js")), false);
});

test("tokBucketKey and roundBucketKey match backend benchlib/common.py buckets", () => {
  assert.equal(benchMod.tokBucketKey(0), "unknown");
  assert.equal(benchMod.tokBucketKey(4000), "<8k");
  assert.equal(benchMod.tokBucketKey(12000), "8-32k");
  assert.equal(benchMod.tokBucketKey(45000), "32-64k");
  assert.equal(benchMod.tokBucketKey(80000), "64-128k");
  assert.equal(benchMod.tokBucketKey(200000), ">=128k");

  assert.equal(benchMod.roundBucketKey("single", 1), "1");
  assert.equal(benchMod.roundBucketKey("multi", 3), "2-3");
  assert.equal(benchMod.roundBucketKey("multi", 8), "4-10");
  assert.equal(benchMod.roundBucketKey("multi", 15), "11+");
});

test("severity and taxonomy labels stay in clean Chinese or goldencase without raw codes", () => {
  assert.equal(benchMod.sevLabel("GOLD"), "goldencase");
  assert.equal(benchMod.sevLabel("none"), "goldencase");
  assert.equal(benchMod.sevLabel("P0"), "P0");

  const norm = benchMod.normalizeBenchPayload(SAMPLE_RAW, null);
  const maps = { stageNames: norm.stageNames, mechNames: norm.mechNames, patNames: norm.patNames };
  assert.equal(benchMod.patternDisplayName("S10.M2.8", "", maps.patNames, maps.stageNames, maps.mechNames),
    "未按技能拆分阈值与资产类别");
  assert.equal(benchMod.patternDisplayName("S9.M2.999", "", maps.patNames, maps.stageNames, maps.mechNames),
    "答案合成 · 目标错配");
  assert.equal(benchMod.bucketLabel("stage", { key: "NA" }, maps), "");
  assert.equal(benchMod.bucketLabel("tokens", { key: "unknown" }, maps), "未记录长度");
});

test("filterBenchCases, sortBenchCases, groupFieldCases, deriveTierFromCases and buildSunburstTree work seamlessly", () => {
  const norm = benchMod.normalizeBenchPayload(SAMPLE_RAW, null);
  const derived = benchMod.deriveTierFromCases(SAMPLE_CASES, 500, norm.models.aime_expert.pool_stats, norm.manifest.params, null);
  assert.equal(derived.actual, 2);
  assert.equal(derived.coverage.length, 7);
  assert.ok(!derived.coverage.some((c) => ["difficulty", "group", "recalled_from", "tokens", "pattern_source"].includes(c.dim)));
  assert.ok(!derived.crosstab.stages.includes("NA"));
  assert.ok(!derived.crosstab.mechanisms.includes("NA"));
  assert.equal(derived.crosstab.totals.bench_total, 1);
  assert.equal(derived.crosstab.rows.S9.pool_total, 300);
  assert.equal(derived.dims.stage.find((r) => r.key === "S10").share_in_bench, 1);
  assert.equal(derived.extra.known_tokens_p50, 72000);
  assert.equal(derived.extra.known_tokens_p90, 72000);

  assert.equal(benchMod.filterBenchCases(SAMPLE_CASES, { sev: "P0" }).length, 1);
  assert.equal(benchMod.filterBenchCases(SAMPLE_CASES, { tok: "unknown" }).length, 1);
  assert.equal(benchMod.filterBenchCases(SAMPLE_CASES, { tok: "64-128k" }).length, 1);
  assert.equal(benchMod.filterBenchCases(SAMPLE_CASES, { rnd: "4-10" }).length, 1);
  assert.equal(benchMod.filterBenchCases(SAMPLE_CASES, { dupOnly: true }).length, 1);
  assert.equal(benchMod.filterBenchCases(SAMPLE_CASES, { q: "finquery" }).length, 1);

  assert.equal(benchMod.sortBenchCases(SAMPLE_CASES, "sev")[0].severity, "P0");
  assert.equal(benchMod.sortBenchCases(SAMPLE_CASES, "tokens")[0].stats.total_tokens, 72000);

  const bySev = benchMod.groupFieldCases(SAMPLE_CASES, "sev", norm.stageNames);
  assert.deepEqual(bySev.map((g) => g.label), ["P0", "goldencase"]);

  const tree = benchMod.buildSunburstTree(derived, SAMPLE_CASES, null, norm.stageNames, norm.mechNames, norm.patNames);
  assert.equal(tree.id, "b");
  assert.equal(tree.n, 1);
  assert.ok(tree.children.every((c) => !c.name.includes("未归因") && !c.name.includes("未分类") && c.id !== "b/NA"));
  const s10 = tree.children.find((c) => c.id === "b/S10");
  assert.ok(s10 && s10.children.some((m) => m.id === "b/S10.M2"));
});

test("resolveSampleHref builds valid samples deep links", () => {
  assert.equal(benchMod.resolveSampleHref("aime", SAMPLE_CASES[0]),
    "?view=samples&product=aime&case=daily%7Caime_expert%7Cthread_1&trace=20003020179362274681000000000199");
  assert.equal(benchMod.resolveSampleHref("aime", SAMPLE_CASES[1]), null);
});

test("bench view forbids mock data, difficulty, 未归因, and obscure English jargon", () => {
  const src = fs.readFileSync(path.join(JS_DIR, "bench.js"), "utf8");
  assert.ok(!src.includes("bench_mock"), "must not reference deleted mock module");
  assert.ok(!src.includes("示例模板"), "must not include mock badge");
  assert.ok(!src.includes("未归因"), "must not use banned 未归因 wording");
  assert.ok(!src.includes("未分类"), "must not expose 未分类 wording in bench view");
  assert.ok(src.includes("fold: false"), "bench sunburst must disable folding into 其他");
  assert.ok(!src.includes("难度"), "must not expose removed difficulty dimension");
  assert.ok(!src.includes("Join "), "must not expose raw English Join label");
  assert.ok(!/>\s*Tier\b/.test(src), "must not expose raw English Tier label");
  assert.ok(!src.includes("Δpp"), "must not expose obscure Δpp label");
  assert.ok(!src.includes("bn-badges"), "must not render bn-badges");
  assert.ok(!src.includes("bn-explorer-top"), "must not render bn-explorer-top");
  assert.ok(!src.includes('class="meta"'), "must not render secondary gray meta subtitles");
  assert.ok(!src.includes("业务分组") && !src.includes("召回来源"), "must not filter by group or recall");
  assert.ok(src.includes("paintBenchField") && src.includes("bn-field-pager"), "field view must mirror 会话场 per-group pagination");
  assert.ok(src.includes(".slice(0, 8)"), "bn-toppats should show up to 8 items");
  assert.ok(src.includes('unit: "问题样本"'), "bench sunburst must clarify denominator as 问题样本");
  assert.ok(!src.includes('focus: `b/${S.f.l3}`'), "sunburst focus must stay on parent mechanism, never leaf pattern");
  const css = fs.readFileSync(path.resolve(HERE, "../static/css/bench.css"), "utf8");
  assert.ok(!/\.bn-prob-card\s*\{[^}]*border-left/.test(css), "bn-prob-card must not use border-left");
  assert.ok(!/\.bn-more-pop\s*\{[^}]*(?:^|[;\s])filter:\s*blur/.test(css), "bn-more-pop must not animate blur filter");
});

test("index.html #viewSwitch exposes 4 main tabs and 5 overflow items in + menu", () => {
  const html = fs.readFileSync(path.resolve(HERE, "../static/index.html"), "utf8");
  const navMatch = html.match(/<nav[^>]*id="viewSwitch"[\s\S]*?<\/nav>/);
  assert.ok(navMatch, "#viewSwitch nav must exist");
  const nav = navMatch[0];
  const tabs = [...nav.matchAll(/class="vs-tab"[^>]*>([^<]+)</g)].map((m) => m[1]);
  assert.deepEqual(tabs, ["数据看板", "Bench", "版本对比", "具体数据"]);
  const actions = [...nav.matchAll(/class="vs-action"[\s\S]*?<span>([^<]+)<\/span>/g)].map((m) => m[1]);
  assert.deepEqual(actions, ["评测速度", "评测体系", "评测评测", "预测数据", "文档"]);
  assert.ok(nav.includes('class="vs-toggle"'), "must include + toggle button");
});

test("buildBenchDailyModel computes cumulative pool/bench growth and day-over-day deltas", () => {
  const daily = benchMod.buildBenchDailyModel(
    {
      pool_daily: [
        { key: "2026-11-17", count: 128 },
        { key: "2026-11-18", count: 448 },
        { key: "2026-11-19", count: 263 },
      ],
      pool_stats: {
        dims: {
          day: [
            { key: "2026-11-17", count: 94 },
            { key: "2026-11-18", count: 105 },
            { key: "2026-11-19", count: 38 },
          ],
        },
      },
    },
    {
      dims: {
        day: [
          { key: "2026-11-17", count: 10 },
          { key: "2026-11-18", count: 14 },
          { key: "2026-11-19", count: 6 },
        ],
      },
    },
  );
  assert.equal(daily.days.length, 3);
  assert.equal(daily.hasRawPool, true);
  assert.equal(daily.totalPoolCum, 839);
  assert.equal(daily.totalBenchCum, 30);
  assert.equal(daily.byDate.get("2026-11-18").poolDelta, 320);
  assert.equal(daily.byDate.get("2026-11-19").poolCum, 839);
  assert.equal(daily.last7Pool, 839);
  assert.equal(daily.last7Bench, 30);
});

test("formatClientExportCase produces clean flat 11-field records for single & multi-turn cases", () => {
  const single = benchMod.formatClientExportCase(
    {
      trace_id: "t-s1",
      session_id: "sess-s1",
      turn: "single",
      model: "aime_fast",
      day: "2026-11-18",
      severity: "GOLD",
      question: "上证指数今天收多少？",
      primary: { l1: "NA", l2: "NA", l3: "NA", label: "goldencase" },
    },
    {},
  );
  assert.deepEqual(Object.keys(single), [
    "case_id", "session_id", "turn_type", "turn_count", "turns",
    "model", "date", "severity", "stage", "mechanism", "problem",
  ]);
  assert.equal(single.turn_type, "single");
  assert.equal(single.turn_count, 1);
  assert.deepEqual(single.turns, [{ role: "user", content: "上证指数今天收多少？" }]);

  const multi = benchMod.formatClientExportCase(
    {
      trace_id: "t-m1",
      session_id: "sess-m1",
      turn: "multi",
      session_round: 2,
      model: "aime_expert",
      day: "2026-11-19",
      severity: "P1",
      question: "那净资产收益率是多少？",
      message_pool: [
        { role: "system", content: "ignore" },
        { role: "user", content: "查贵州茅台净利润" },
        { role: "assistant", content: "归母净利润 608 亿元" },
      ],
      primary: { l1: "S9", l2: "M6", l3: "S9.M6.1", label: "指标口径混淆" },
    },
    { stageNames: { S9: "答案合成" }, mechNames: { M6: "无依据断言" } },
  );
  assert.equal(multi.turn_type, "multi");
  assert.equal(multi.turn_count, 2);
  assert.deepEqual(multi.turns, [
    { role: "user", content: "查贵州茅台净利润" },
    { role: "assistant", content: "归母净利润 608 亿元" },
    { role: "user", content: "那净资产收益率是多少？" },
  ]);
  assert.equal(multi.stage, "答案合成");
  assert.equal(multi.mechanism, "无依据断言");
  assert.equal(multi.problem, "指标口径混淆");
});
