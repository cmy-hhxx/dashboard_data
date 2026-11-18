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
  assert.equal(benchMod.bucketLabel("stage", { key: "NA" }, maps), "未分类");
  assert.equal(benchMod.bucketLabel("tokens", { key: "unknown" }, maps), "未记录长度");
  assert.equal(benchMod.bucketLabel("group", { key: "0_daily_eval" }, maps), "日常评测");
});

test("filterBenchCases, sortBenchCases, groupFieldCases, deriveTierFromCases and buildSunburstTree work seamlessly", () => {
  const norm = benchMod.normalizeBenchPayload(SAMPLE_RAW, null);
  const derived = benchMod.deriveTierFromCases(SAMPLE_CASES, 500, norm.models.aime_expert.pool_stats, norm.manifest.params, null);
  assert.equal(derived.actual, 2);
  assert.equal(derived.coverage.length, 11);
  assert.ok(!derived.coverage.some((c) => c.dim === "difficulty"));
  assert.equal(derived.extra.known_tokens_p50, 72000);

  assert.equal(benchMod.filterBenchCases(SAMPLE_CASES, { sev: "P0" }).length, 1);
  assert.equal(benchMod.filterBenchCases(SAMPLE_CASES, { tok: "unknown" }).length, 1);
  assert.equal(benchMod.filterBenchCases(SAMPLE_CASES, { tok: "64-128k" }).length, 1);
  assert.equal(benchMod.filterBenchCases(SAMPLE_CASES, { rnd: "4-10" }).length, 1);
  assert.equal(benchMod.filterBenchCases(SAMPLE_CASES, { rec: "lost_user" }).length, 1);
  assert.equal(benchMod.filterBenchCases(SAMPLE_CASES, { dupOnly: true }).length, 1);
  assert.equal(benchMod.filterBenchCases(SAMPLE_CASES, { q: "finquery" }).length, 1);

  assert.equal(benchMod.sortBenchCases(SAMPLE_CASES, "sev")[0].severity, "P0");
  assert.equal(benchMod.sortBenchCases(SAMPLE_CASES, "tokens")[0].stats.total_tokens, 72000);

  const bySev = benchMod.groupFieldCases(SAMPLE_CASES, "sev", norm.stageNames);
  assert.deepEqual(bySev.map((g) => g.label), ["P0", "goldencase"]);

  const tree = benchMod.buildSunburstTree(derived, SAMPLE_CASES, null, norm.stageNames, norm.mechNames, norm.patNames);
  assert.equal(tree.id, "b");
  assert.equal(tree.n, 2);
  assert.ok(tree.children.every((c) => !c.name.includes("未归因")));
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
  assert.ok(!src.includes("难度"), "must not expose removed difficulty dimension");
  assert.ok(!src.includes("Join "), "must not expose raw English Join label");
  assert.ok(!/>\s*Tier\b/.test(src), "must not expose raw English Tier label");
  assert.ok(!src.includes("Δpp"), "must not expose obscure Δpp label");
});
