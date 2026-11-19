/* 评测容量说明 (doc=capacity): progressive 5-chapter editorial document.
   Uses the dashboard's shared tooltip (#tip via showTip / hideTip / bindTips) and counter formatting. */
import { $, $$, fmt, compact, pct, showTip, hideTip, bindTips, runCounters, copyBtnHTML } from "./core.js";

const NS = "http://www.w3.org/2000/svg";

const SAMPLE = {
  date: "2026-11-16",
  cases: 34,
  concurrency: 34,
  modelRequests: 64,
  model: "deepseek-v4.1-flash · 2 个网关",
  walls: [
    { label: "main 基线 · 第 1 次", seconds: 150 },
    { label: "main 基线 · 第 2 次", seconds: 208 },
    { label: "优化分支 · 第 1 步", seconds: 147 },
  ],
  stages: [
    { key: "compact-field", name: "Compact 字段", stage: "attribution-compact-field", attempts: 302, p50: 4.4, p90: 18.5, resubmit: [0.01, 0.01], cacheTokens: 2.0e6, outputTokens: 63e3 },
    { key: "component", name: "Component", stage: "attribution-component", attempts: 99, p50: 36, p90: 66, resubmit: [0.11, 0.16], toolCalls: 3.8, cacheTokens: [6e6, 8e6], outputTokens: 150e3 },
    { key: "trace", name: "Trace", stage: "attribution-trace", attempts: 34, p50: [2.8, 3.5], p90: [6, 8], resubmit: null, cacheTokens: 0.1e6, outputTokens: 7e3 },
  ],
  slowFields: [
    { field: "components", p50: 17.7, p90: 30.4 },
    { field: "execution_chain", p50: 13.9, p90: 23.0 },
    { field: "plans", p50: 5.0, p90: 11.7 },
    { field: "session_overview", p50: 4.9, p90: 9.1 },
    { field: "reasoning_chain", p50: 2.4, p90: 20.2 },
  ],
  rejectCodes: [
    { code: "schema_required", count: 4, meaning: "缺必填字段" },
    { code: "p4_delivery_proof", count: 3, meaning: "记 P4 却没有证明交付未受影响的证据" },
    { code: "final_process_severity", count: 2, meaning: "终稿问题被定成 P4，应为 P0–P3" },
    { code: "schema_maxLength", count: 2, meaning: "字段超长" },
    { code: "schema_uniqueItems", count: 1, meaning: "数组里有重复项" },
    { code: "evidence_source_invalid", count: 1, meaning: "证据 ID 指向了别的来源" },
  ],
};

const FIXES = [
  { title: "长尾 case 全被拒", after: "子进程带上身份，长尾 case 正常评测。", before: "≥4 个 trace 或 ≥2 MiB 的 case 走长尾子进程，子进程丢了目录推断的身份，以 missing_version 拒绝。", look: "摘要 rejects_by_reason 出现 missing_version，数量接近 heavy" },
  { title: "失败 case 堵住准入", after: "失败即释放缓冲。", before: "失败的 case 留在 CompactGate 缓冲里，缓冲满后新 case 进不来。", look: "摘要 compact_ready_peak 贴着 --compact-backlog，同时 failed 在涨" },
  { title: "Compact 字段排队", after: "默认改为 12（--task-concurrency）。", before: "单 case 任务窗口默认 8，9 个 Compact 字段要排队，派发等待最长 40–70 s。", look: "task_prepared 的 timings.dispatchWaitMs 出现几十秒" },
];

const LADDER = [
  { cases: 16, budget: 32, admitted: 39, completed: 38, failed: 0, attribution: 29, compact: 38, wall: 679, rss: 719 },
  { cases: 32, budget: 64, admitted: 61, completed: 60, failed: 0, attribution: 38, compact: 60, wall: 663, rss: 1027 },
  { cases: 64, budget: 128, admitted: 99, completed: 98, failed: 0, attribution: 51, compact: 98, wall: 677, rss: 1751 },
  { cases: 100, budget: 200, admitted: 121, completed: 112, failed: 3, attribution: 34, compact: 112, wall: 674, rss: 2599 },
  { cases: 128, budget: 128, admitted: 140, completed: 123, failed: 11, attribution: 7, compact: 123, wall: 678, rss: 2743 },
];

const CALIBRATION = {
  rows: 200, elapsed: 1498, attempts: 3530, tokens: 82577046, modelSeconds: 239842,
  cacheTokens: 76000000, ioTokens: 6540000,
  stages: [
    { key: "compact", name: "Compact", attempts: 2415, tokens: 16185164, mean: 11.6, p95: 37.3, modelSeconds: 28020 },
    { key: "component", name: "Component", attempts: 800, tokens: 64339405, mean: 257.3, p95: 480.1, modelSeconds: 205835 },
    { key: "trace", name: "Trace", attempts: 278, tokens: 843336, mean: 6.6, p95: 10.3, modelSeconds: 1834 },
    { key: "session", name: "Session", attempts: 37, tokens: 1209141, mean: 112.3, p95: 212.7, modelSeconds: 4153 },
  ],
};

const ENGINEER_STRIP = [
  { k: "重启跳过", v: "136 ms", note: "跳过已完成，不调用模型" },
  { k: "两进程合并", v: "0 重复", note: "双进程各完成 4/4" },
  { k: "百万行索引", v: "0.48 s", note: "扫描 890 MB 输入文件" },
  { k: "32 条并发", v: "357.6 s", note: "322 行/小时短批实测" },
];

const PER_ROW = {
  attempts: CALIBRATION.attempts / CALIBRATION.rows,
  tokens: CALIBRATION.tokens / CALIBRATION.rows,
  modelSeconds: CALIBRATION.modelSeconds / CALIBRATION.rows,
  cacheShare: CALIBRATION.cacheTokens / CALIBRATION.tokens,
  ioShare: CALIBRATION.ioTokens / CALIBRATION.tokens,
  inputOutputTokens: CALIBRATION.ioTokens,
};

const rowsPerHour = (r) => (r.attribution * 3600) / r.wall;
const budgetShare = (r) => Math.max(1, Math.floor(r.budget / r.cases));
const serviceTime = (r) => (r.cases * 3600) / rowsPerHour(r);
const stageOf = (k) => CALIBRATION.stages.find((s) => s.key === k);
const stageDerived = (s) => {
  const rowModelSeconds = (s.attempts / CALIBRATION.rows) * s.mean;
  return {
    name: s.name, key: s.key,
    attemptsPerRow: s.attempts / CALIBRATION.rows,
    tokensPerTask: s.tokens / s.attempts,
    tokensPerRow: s.tokens / CALIBRATION.rows,
    mean: s.mean, p95: s.p95,
    callShare: s.attempts / CALIBRATION.attempts,
    tokenShare: s.tokens / CALIBRATION.tokens,
    modelShare: rowModelSeconds / PER_ROW.modelSeconds,
    modelSecondsPerRow: rowModelSeconds,
    attempts: s.attempts, tokens: s.tokens,
  };
};

const LEVERS = [
  {
    name: "Compact 调用次数 −20%", detail: "每字段一个单轮会话，当前 12.1 次/条",
    attempts: -stageOf("compact").attempts * 0.2,
    tokens: -stageOf("compact").attempts * 0.2 * (stageOf("compact").tokens / stageOf("compact").attempts),
    modelSeconds: -stageOf("compact").attempts * 0.2 * stageOf("compact").mean,
  },
  {
    name: "Component 上下文 −20%", detail: "单任务 80.4k token，主要是工具补读与重发",
    attempts: 0, tokens: -stageOf("component").tokens * 0.2, modelSeconds: 0,
  },
  {
    name: "Component 延迟 −20%", detail: "均值 257.3 s，p95 480.1 s",
    attempts: 0, tokens: 0, modelSeconds: -stageOf("component").modelSeconds * 0.2,
  },
];

const ARTIFACTS = [
  { name: "摘要 JSON", owner: "--summary-file，进程结束时写", use: "cases / completed / failed / rejected / heavy、elapsed_ms、rss_mb、attribution_rows / compact_rows、compact_ready_peak、heavy_dropped、rejects_by_reason", limit: "只有整批合计，无单次耗时和 token" },
  { name: "runtime.log · attempt_metrics", owner: "<EVAL_LOG_DIR>/runtime.log", use: "每次模型尝试一行：阶段、业务坐标、四类 token、模型 / 工具 / 提交耗时、工具调用、返工次数与被拒原因", limit: "不含正文；只给 token，不给金额" },
  { name: "runtime.log · task_prepared", owner: "<EVAL_LOG_DIR>/runtime.log", use: "派发前等待：排队、等上游依赖、等派发，以及本机准备耗时", limit: "只带 task_id / attempt_id，阶段和字段按 attempt_id 关联" },
  { name: "runtime.log · attempt_failed", owner: "<EVAL_LOG_DIR>/runtime.log", use: "失败代码、渠道、第几次尝试；同类失败到阈值时另有 stage_paused", limit: "成功的尝试不出现" },
  { name: "evaluation.log", owner: "<EVAL_LOG_DIR>/evaluation.log", use: "每个任务的提交记录", limit: "看提交内容，不看速度" },
  { name: "输入审计", owner: "<output>/.audit/<writer>.jsonl", use: "哪一行被拒或带警告、原因、文件 / 行 / 字节坐标与业务身份", limit: "只说明输入能否使用" },
  { name: "正式 JSONL", owner: "merge 写入输出根", use: "交付的归因行和 compact 行", limit: "只有内容，无成本数据" },
];

const FIELDS = [
  { event: "attempt_metrics", key: "stage · identity", def: "阶段；identity 含 version、batch_id、case_id、session_id、trace_index、compact_field、component_group", use: "定位 case 的字段 / 组件组" },
  { event: "attempt_metrics", key: "timings.modelMs · toolMs · submissionMs · inputIoMs · requiredReadMs", def: "模型生成、工具执行、提交校验、读输入、读必读材料的累计毫秒", use: "区分慢在模型还是工具" },
  { event: "attempt_metrics", key: "usage.input · output · cacheRead · cacheWrite · totalTokens · reasoning", def: "四类 token 与合计；reasoning 为推理 token", use: "核算成本、上下文膨胀" },
  { event: "attempt_metrics", key: "channel · model · model_usage", def: "实际渠道与模型；按渠道 / 模型拆开的用量", use: "检查网关均衡度" },
  { event: "attempt_metrics", key: "calls · requiredReadCalls", def: "工具调用次数；其中必读材料调用", use: "检查 Component 补读次数" },
  { event: "attempt_metrics", key: "contentSubmissions · submissionCodes", def: "内容提交次数（>1 即返工）；每个被拒代码次数", use: "统计返工率与返工原因" },
  { event: "attempt_metrics", key: "confirmed · status", def: "是否拿到提交回执；尝试最终状态", use: "区分成功、失败、超时" },
  { event: "task_prepared", key: "timings.queuedMs · dependencyWaitMs · dispatchWaitMs", def: "总等待、等上游依赖、依赖就绪后等派发的时间", use: "区分排队与上游串行等待" },
  { event: "task_prepared", key: "timings.bindingMs · profileMs · dispatchMs", def: "组装材料、准备、发给 Worker 的耗时", use: "排查本机准备耗时" },
  { event: "attempt_failed", key: "errors[].code · channel · attempt", def: "失败代码（transport_failed、attempt_timeout 等）、渠道、第几次尝试", use: "定位失败集中的网关 / 阶段" },
];

const RECIPES = [
  {
    q: "整批运行概览",
    cmd: `jq '{cases, completed, failed, rejected, heavy, heavy_dropped,\n     elapsed_ms, rss_mb, attribution_rows, compact_ready_peak,\n     rejects_by_reason}' summary.json`,
    read: "rejected 偏高查 rejects_by_reason 与 .audit；heavy_dropped > 0 说明长尾队列满；compact_ready_peak 贴着 --compact-backlog 说明 attribution 跟不上 compact。",
  },
  {
    q: "最慢的 Compact 字段",
    cmd: `jq -s '[.[] | select(.event=="attempt_metrics" and .stage=="attribution-compact-field")]\n  | group_by(.identity.compact_field)\n  | map((map(.timings.modelMs) | sort) as $t\n      | {field: .[0].identity.compact_field, n: length,\n         p50: $t[length/2|floor], p90: $t[length*0.9|floor]})\n  | sort_by(-.p90)' runtime.log`,
    read: "按 p90 倒序。将 stage 换成 attribution-component、字段换成 identity.component_group 即为组件调查耗时表。",
  },
  {
    q: "返工原因分布",
    cmd: `jq -s '[.[] | select(.event=="attempt_metrics") | .stage as $s\n        | .submissionCodes | to_entries[] | {stage: $s, code: .key, n: .value}]\n  | group_by([.stage, .code])\n  | map({stage: .[0].stage, code: .[0].code, n: (map(.n) | add)})\n  | sort_by(-.n)' runtime.log`,
    read: "schema_* 为 Schema 校验，p4_delivery_proof 等为业务规则校验；配合 select(.contentSubmissions > 1) 可定位具体慢 case。",
  },
  {
    q: "区分排队等待与模型生成",
    cmd: `jq -s '(map(select(.event=="attempt_metrics")) | INDEX(.attempt_id)) as $m\n  | [.[] | select(.event=="task_prepared")\n     | {task_id, wait: .timings.dispatchWaitMs, dep: .timings.dependencyWaitMs,\n        stage: $m[.attempt_id].stage, field: $m[.attempt_id].identity.compact_field}]\n  | sort_by(-.wait) | .[:20]' runtime.log`,
    read: "dispatchWaitMs 达数十秒说明 --task-concurrency 或 --model-requests 不足；dependencyWaitMs 大属于正常等待上游关口。",
  },
  {
    q: "失败网关与错误码聚合",
    cmd: `jq -s '[.[] | select(.event=="attempt_failed") | .stage as $s\n        | .errors[] | {stage: $s, code}]\n  | group_by([.stage, .code])\n  | map({stage: .[0].stage, code: .[0].code, n: length})\n  | sort_by(-.n)' runtime.log`,
    read: "transport_failed、attempt_timeout 集中在单一 channel 时优先排查对应网关；出现 stage_paused 表示同类失败触发阈值暂停。",
  },
];

const METRICS = [
  { term: "正式归因行", def: "交付的归因行，一个 trace 一行，速度统一按它计算。" },
  { term: "归因行 / 小时", def: "正式归因行 ÷ 运行时间 × 3600。" },
  { term: "case", def: "一个 trace 的评测单元，产出一行归因。" },
  { term: "attempt", def: "一次 agent 任务，内部含多次模型请求、工具调用与内容提交。" },
  { term: "Compact 字段", def: "单 trace case 的 Compact 拆成 9 个字段任务，各自一次 attempt（identity.compact_field）。" },
  { term: "返工", def: "提交被校验拒绝后重交（contentSubmissions > 1），每次重新生成整段 JSON。" },
  { term: "模型时间", def: "timings.modelMs：一次尝试内模型生成的累计耗时，不含派发前排队。" },
  { term: "派发等待", def: "task_prepared 的 timings.dispatchWaitMs：依赖已就绪、等待任务槽或请求额度的时间。" },
];

const SOURCES = [
  { title: "34 条抽样实测", date: "2026-11-16", result: "整批 150 s / 208 s / 147 s；Component 单次模型时间中位 36 s、p90 66 s；返工原因取自 submissionCodes。" },
  { title: "五档容量阶梯", date: "2026-11-09", result: "最快 271.2 行/h（64 并发 / 128 额度）；128 档因额度摊薄至每 case 1 个请求降至 37.2 行/h。" },
  { title: "30 分钟长测", date: "2026-11-09", result: "100 并发 / 200 额度读完输入：准入 249 条，完成 222 条，产出 138 行正式归因（292.8 行/h）。" },
  { title: "200 条单位工作量标定", date: "2026-11-08", result: "单条归因均值：412,885 token、17.65 次调用、1,199 s 模型工时（其中 92% 为缓存读写）。" },
];

function svgEl(tag, attrs) {
  const node = document.createElementNS(NS, tag);
  if (attrs) Object.entries(attrs).forEach(([k, v]) => node.setAttribute(k, String(v)));
  return node;
}

function spanText(value, format) {
  if (value == null) return "—";
  if (!Array.isArray(value)) return format(value);
  let lo = format(value[0]);
  const hi = format(value[1]);
  if (lo === hi) return lo;
  const unit = (hi.match(/[^\d.]*$/) || [""])[0];
  if (unit && lo.endsWith(unit)) lo = lo.slice(0, -unit.length);
  return `${lo.trim()}–${hi}`;
}

export function capacityDocHTML() {
  const workRows = ["compact", "component", "trace", "session"].map((key, idx) => {
    const d = stageDerived(stageOf(key));
    return `<tr>
      <td><span class="cap-name" style="--c:var(--cap-c${idx + 1})"><i></i><b>${d.name}</b></span></td>
      <td class="num">${d.attemptsPerRow.toFixed(2)}</td>
      <td class="num">${fmt(Math.round(d.tokensPerTask))}</td>
      <td class="num">${fmt(Math.round(d.tokensPerRow))}</td>
      <td class="num">${fmt(d.mean, 1)}</td>
      <td class="num">${fmt(d.p95, 1)}</td>
    </tr>`;
  }).join("");

  const shareRows = ["compact", "component", "trace", "session"].map((key, idx) => {
    const d = stageDerived(stageOf(key));
    const cell = (s) => `<td><div class="cap-meter"><b class="num">${fmt(s * 100, 0)}%</b><span class="cap-track"><i style="width:${(s * 100).toFixed(1)}%;background:var(--cap-c${idx + 1})"></i></span></div></td>`;
    return `<tr><td><span class="cap-name" style="--c:var(--cap-c${idx + 1})"><i></i><b>${d.name}</b></span></td>${cell(d.callShare)}${cell(d.tokenShare)}${cell(d.modelShare)}</tr>`;
  }).join("");

  const leverRows = LEVERS.map((l) => {
    const cell = (d, b) => (!d ? '<td class="num muted">0</td>' : `<td class="num"><b class="cap-good">−${pct(Math.abs(d), b, 1)}</b></td>`);
    return `<tr><td><b>${l.name}</b><span class="cap-sub">${l.detail}</span></td>${cell(l.attempts, CALIBRATION.attempts)}${cell(l.tokens, CALIBRATION.tokens)}${cell(l.modelSeconds, CALIBRATION.modelSeconds)}</tr>`;
  }).join("");

  const rateFigures = LADDER.map((r) => {
    const note = r.cases === 64 ? "峰值" : r.cases === 128 ? "拥堵" : "";
    return `<div class="cap-fig${r.cases === 64 ? " is-peak" : r.cases === 128 ? " is-warn" : ""}">
      <span class="cap-k">${r.cases} 并发 / ${r.budget} 额度${note ? ` · ${note}` : ""}</span>
      <b class="num">${pct(r.attribution, r.admitted, 0)}</b>
      <span class="cap-fig-detail">归因 ${r.attribution} / 准入 ${r.admitted}</span>
    </div>`;
  }).join("");

  const fixRows = FIXES.map((f) => `<tr><td><b>${f.title}</b><span class="cap-sub">${f.after}</span></td><td>${f.before}</td><td class="muted">${f.look}</td></tr>`).join("");

  const engCells = ENGINEER_STRIP.map((e) => `<div class="cap-fig"><span class="cap-k">${e.k}</span><b class="num">${e.v}</b><span class="cap-fig-detail">${e.note}</span></div>`).join("");

  const artRows = ARTIFACTS.map((a) => `<tr><td><b>${a.name}</b><span class="cap-sub"><code>${a.owner.replace(/</g, "&lt;")}</code></span></td><td>${a.use}</td><td class="muted">${a.limit}</td></tr>`).join("");

  let lastEv = "";
  const fieldRows = FIELDS.map((f) => {
    const head = f.event !== lastEv ? `<tr class="cap-group"><td colspan="3">event = ${f.event}</td></tr>` : "";
    lastEv = f.event;
    return `${head}<tr><td><code>${f.key}</code></td><td>${f.def}</td><td class="muted">${f.use}</td></tr>`;
  }).join("");

  const recipeItems = RECIPES.map((r, i) => `<li class="cap-recipe"><div class="cap-recipe-head"><span class="num">0${i + 1}</span><h4>${r.q}</h4>${copyBtnHTML("复制命令", { pre: true })}</div><pre class="code">${r.cmd}</pre><p>${r.read}</p></li>`).join("");

  const sampleWallCells = SAMPLE.walls.map((w) => `<div class="cap-fig"><span class="cap-k">${w.label}</span><b class="num">${w.seconds} s</b><span class="cap-fig-detail">整批墙钟</span></div>`).join("");

  const sampleStageRows = SAMPLE.stages.map((s, idx) => `<tr>
    <td><span class="cap-name" style="--c:var(--cap-c${idx + 1})"><i></i><b>${s.name}</b></span><span class="cap-sub"><code>${s.stage}</code>${s.toolCalls ? ` · 均值 ${s.toolCalls} 次工具调用` : ""}</span></td>
    <td class="num">≈${fmt(s.attempts)}</td>
    <td class="num">${spanText(s.p50, (v) => fmt(v, 1))} s</td>
    <td class="num">${spanText(s.p90, (v) => fmt(v, 1))} s</td>
    <td class="num">${s.resubmit ? spanText(s.resubmit, (v) => `${Math.round(v * 100)}%`) : "—"}</td>
    <td class="num">${spanText(s.cacheTokens, (v) => compact(v))}</td>
    <td class="num">${spanText(s.outputTokens, (v) => compact(v))}</td>
  </tr>`).join("");

  const maxP90 = Math.max(...SAMPLE.slowFields.map((f) => f.p90));
  const slowBars = SAMPLE.slowFields.map((f) => `<div class="cap-fieldbar">
    <code>${f.field}</code>
    <span class="cap-track"><i class="p90" style="width:${((f.p90 / maxP90) * 100).toFixed(1)}%"></i><i class="p50" style="width:${((f.p50 / maxP90) * 100).toFixed(1)}%"></i></span>
    <b class="num">${f.p50.toFixed(1)} / ${f.p90.toFixed(1)} s</b>
  </div>`).join("");

  const codeRows = SAMPLE.rejectCodes.map((c) => `<tr><td><code>${c.code}</code></td><td class="muted">${c.meaning}</td><td class="num">${c.count}</td></tr>`).join("");

  const metricRows = METRICS.map((m) => `<tr><td><b>${m.term}</b></td><td>${m.def}</td></tr>`).join("");

  const sourceRows = SOURCES.map((s) => `<div class="cap-src"><div class="cap-src-head"><b>${s.title}</b><time class="num">${s.date}</time></div><p>${s.result}</p></div>`).join("");

  return `<div class="doc-shell cap-shell">
    <aside class="doc-side">
      <div class="dc-side-head">
        <button type="button" class="dc-back" data-back><svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M10 3.5 5.5 8l4.5 4.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>全部文档</button>
      </div>
      <div class="doc-side-title">容量与性能说明</div>
      <nav class="doc-toc" id="capToc" aria-label="容量章节">
        <a href="#cap-baseline"><span class="num">01</span><span>口径与基准</span></a>
        <a href="#cap-cost"><span class="num">02</span><span>分阶段消耗</span></a>
        <a href="#cap-speed"><span class="num">03</span><span>并发与瓶颈</span></a>
        <a href="#cap-calc"><span class="num">04</span><span>容量试算</span></a>
        <a href="#cap-obs"><span class="num">05</span><span>观测与排查</span></a>
      </nav>
    </aside>

    <div class="doc-main">
      <header class="doc-hero">
        <div class="doc-hero-top">
          <h1>容量与性能说明</h1>
          ${copyBtnHTML("复制基准", { fn: "capHero" })}
        </div>
        <p class="doc-lead">200 条 AIME 标定显示，每产出 1 行正式归因平均消耗 41.3 万 token、17.65 次模型调用、1,199 秒模型工时（其中 92% 为前缀缓存读写）。100 条并发、200 个模型请求额度下，Runner 28 分钟（1,697 秒）产出 138 行正式归因，实测吞吐 292.8 行/小时。</p>
        <div class="doc-kpis">
          <div class="doc-kpi"><b class="num" data-count="292.8" data-d="1">292.8</b><span>行 / 小时（100 并发 / 200 额度）</span></div>
          <div class="doc-kpi"><b class="num">412,885</b><span>token / 条（92% 缓存读写）</span></div>
          <div class="doc-kpi"><b class="num">17.65</b><span>次模型调用 / 条（1,199 s 工时）</span></div>
        </div>
      </header>

      <section class="doc-sec" id="cap-baseline" aria-label="口径与基准">
        <div class="doc-sec-head"><span class="doc-idx num">01</span><h2>计量口径与核心公式</h2></div>
        <p class="doc-lead">所有速度与成本均以最终交付的「正式归因行」为统一分母，避免单次调用、中间草稿或失败重试把吞吐数字抬高。一条 Trace 按如下四级逐层拆解。</p>
        <div class="cap-chain">
          <div class="cap-chain-node"><span class="num">01</span><b>输入行</b><code>1 行 JSONL</code><span>一条会话输入记录</span></div>
          <div class="cap-chain-node"><span class="num">02</span><b>Trace</b><code>1 : 1</code><span>每条 Trace 产出一行正式归因</span></div>
          <div class="cap-chain-node"><span class="num">03</span><b>attempt</b><code>17.65 : 1</code><span>一次 agent 任务，含多次请求与重试</span></div>
          <div class="cap-chain-node"><span class="num">04</span><b>token</b><code>2.34 万 : 1</code><span>输入 + 输出 + 缓存读写</span></div>
        </div>
        <div class="doc-formula-pair">
          <div class="doc-sub">
            <div class="doc-sub-head"><h3>速度公式</h3>${copyBtnHTML("复制公式", { text: "行/h = 归因行 × 3600 ÷ 墙钟 = case 并发 × 3600 ÷ 单条墙钟（实测 292.8 行/h，100 并发 / 200 额度）" })}</div>
            <div class="cap-formula">
              <div><em>行/h</em> = 归因行 × 3600 ÷ 墙钟 = case 并发 × 3600 ÷ 单条墙钟</div>
              <div class="cap-formula-out"><b class="num">292.8</b><span>行/h（138 行 × 3600 ÷ 1,697 s）</span></div>
            </div>
          </div>
          <div class="doc-sub">
            <div class="doc-sub-head"><h3>消耗公式</h3>${copyBtnHTML("复制公式", { text: "token/条 = Σ 次数/条 × token/次 · 工时/条 = Σ 次数/条 × 单次秒数（标定 412,885 token/条，92% 缓存读写）" })}</div>
            <div class="cap-formula">
              <div><em>token/条</em> = Σ 次数/条 × token/次 · <em>工时/条</em> = Σ 次数/条 × 单次秒数</div>
              <div class="cap-formula-out"><b class="num">412,885</b><span>token/条（92% 缓存读写）</span></div>
            </div>
          </div>
        </div>
      </section>

      <section class="doc-sec" id="cap-cost" aria-label="分阶段消耗">
        <div class="doc-sec-head"><span class="doc-idx num">02</span><h2>分阶段消耗拆解</h2></div>
        <p class="doc-lead">单条归因的 92% token 为缓存读写，成本与耗时大头不在字段摘要而在组件调查（Component）——它只占 22.7% 的调用次数，却占用了 77.9% 的总 token 与 85.8% 的模型时间。</p>
        <div class="doc-sub">
          <div class="doc-sub-head"><h3>分阶段工作量（200 条 AIME 标定）</h3></div>
          <div class="cap-table-wrap">
            <table class="cap-table">
              <thead><tr><th>阶段</th><th class="num">次 / 条</th><th class="num">token / 次</th><th class="num">token / 条</th><th class="num">均值 (s)</th><th class="num">p95 (s)</th></tr></thead>
              <tbody>${workRows}</tbody>
            </table>
          </div>
        </div>
        <div class="doc-split">
          <div class="doc-sub">
            <div class="doc-sub-head"><h3>调用、token 与模型时间占比</h3></div>
            <div class="cap-table-wrap">
              <table class="cap-table">
                <thead><tr><th>阶段</th><th>调用占比</th><th>token 占比</th><th>时间占比</th></tr></thead>
                <tbody>${shareRows}</tbody>
              </table>
            </div>
          </div>
          <div class="doc-sub">
            <div class="doc-sub-head"><h3>token 构成</h3></div>
            <div class="cap-stack-card">
              <div class="cap-stackbar">
                <i style="width:${(PER_ROW.ioShare * 100).toFixed(1)}%;background:var(--cap-c3)" title="输入 + 输出：${pct(PER_ROW.ioShare, 1, 1)}"></i>
                <i style="width:${(PER_ROW.cacheShare * 100).toFixed(1)}%;background:var(--cap-c4)" title="缓存读写：${pct(PER_ROW.cacheShare, 1, 1)}"></i>
              </div>
              <div class="cap-stacklegend">
                <div><i style="background:var(--cap-c3)"></i><span>输入 + 输出（新内容）</span><b class="num">${pct(PER_ROW.ioShare, 1, 1)}</b></div>
                <div><i style="background:var(--cap-c4)"></i><span>缓存读写（前缀复用）</span><b class="num">${pct(PER_ROW.cacheShare, 1, 1)}</b></div>
              </div>
            </div>
          </div>
        </div>
        <div class="doc-sub">
          <div class="doc-sub-head"><h3>优化杠杆效果（相对 200 条批次总量）</h3></div>
          <div class="cap-table-wrap">
            <table class="cap-table">
              <thead><tr><th>优化方式</th><th class="num">调用次数</th><th class="num">总 token</th><th class="num">模型时间</th></tr></thead>
              <tbody>${leverRows}</tbody>
            </table>
          </div>
        </div>
      </section>

      <section class="doc-sec" id="cap-speed" aria-label="并发与瓶颈">
        <div class="doc-sec-head"><span class="doc-idx num">03</span><h2>并发阶梯与瓶颈定位</h2></div>
        <p class="doc-lead">决定整批墙钟的关键约束是「每条在途 case 至少保有 2 个模型请求额度」，让同一条 Trace 内的多组组件调查得以并行推进。64 并发 / 128 额度实测最快（271.2 行/小时）；并发翻倍到 128 而额度仍为 128 时，每条只剩 1 个请求，吞吐骤降至 37.2 行/小时。</p>
        <div class="doc-sub">
          <div class="doc-sub-head"><h3>五档容量阶梯（2026-11-09 实测 · 540 s 准入 + 120 s 排空）</h3></div>
          <div class="cap-chart-box">
            <div class="cap-chart-wrap"><svg id="capLadderChart" class="cap-chart" role="img" aria-label="五档实测容量阶梯"></svg></div>
            <div class="cap-figs" style="--cols:5">${rateFigures}</div>
          </div>
        </div>
        <div class="doc-split">
          <div class="doc-sub">
            <div class="doc-sub-head"><h3>单条等效占用时间（推算 · 对数轴）</h3></div>
            <div class="cap-chart-box">
              <div class="cap-chart-wrap"><svg id="capServiceChart" class="cap-chart" role="img" aria-label="单条归因占用时间"></svg></div>
            </div>
          </div>
          <div class="doc-sub">
            <div class="doc-sub-head"><h3>本机工程性能基线（非瓶颈）</h3></div>
            <div class="cap-figs" style="--cols:2">${engCells}</div>
          </div>
        </div>
        <div class="doc-sub">
          <div class="doc-sub-head"><h3>2026-11-16 修复的三处调度卡点</h3></div>
          <div class="cap-table-wrap">
            <table class="cap-table">
              <thead><tr><th>卡点与修复</th><th>修复前现象</th><th>日志特征</th></tr></thead>
              <tbody>${fixRows}</tbody>
            </table>
          </div>
        </div>
      </section>

      <section class="doc-sec" id="cap-calc" aria-label="容量试算">
        <div class="doc-sec-head"><span class="doc-idx num">04</span><h2>容量与配比试算</h2></div>
        <p class="doc-lead">基于 200 条单位标定与五档实测规则，按批量规模、并发数、模型请求额度或目标吞吐量直接测算资源需求。</p>
        <div class="doc-sub">
          <div class="doc-sub-head"><h3>批量规划器</h3>${copyBtnHTML("复制测算", { fn: "capPlan" })}</div>
          <div class="cap-calc-card">
            <div class="cap-calc-grid">
              <div class="cap-controls">
                <div class="cap-presets" role="group" aria-label="常用批量">
                  <button type="button" data-plan-rows="500">500 条</button>
                  <button type="button" data-plan-rows="1000" aria-pressed="true">1,000 条</button>
                  <button type="button" data-plan-rows="5000">5,000 条</button>
                  <button type="button" data-plan-rows="10000">10,000 条</button>
                </div>
                <label class="cap-range"><span>批量 <b class="num"><span id="capPlanRowsOut">1,000</span> 条</b></span><input id="capPlanRows" type="range" min="100" max="20000" step="100" value="1000"></label>
                <label class="cap-range"><span>速度 <b class="num"><span id="capPlanRateOut">293</span> 条/h</b></span><input id="capPlanRate" type="range" min="150" max="400" step="1" value="293"></label>
              </div>
              <div class="cap-readout">
                <div class="cap-ro-main"><span>预计总 token</span><div><b class="num" id="capPlanTokens">4.13 亿</b><em>token</em></div></div>
                <div class="cap-ro-grid">
                  <div><span>agent 调用</span><b class="num" id="capPlanAttempts">17,650</b></div>
                  <div><span>模型工时</span><b class="num" id="capPlanModel">333 h</b></div>
                  <div><span>实际墙钟</span><b class="num" id="capPlanWall">3.4 h</b></div>
                  <div><span>并发模型流</span><b class="num"><span id="capPlanStreams">98</span> 条</b></div>
                </div>
              </div>
            </div>
          </div>
        </div>
        <div class="doc-split">
          <div class="doc-sub">
            <div class="doc-sub-head"><h3>并发与额度配比试算</h3>${copyBtnHTML("复制配置", { fn: "capShare" })}</div>
            <div class="cap-calc-card">
              <div class="cap-controls">
                <div class="cap-presets" role="group" aria-label="常见配比">
                  <button type="button" data-share-preset="64,128" aria-pressed="true">推荐 64 / 128</button>
                  <button type="button" data-share-preset="100,200">100 / 200</button>
                  <button type="button" data-share-preset="128,128">过载 128 / 128</button>
                </div>
                <label class="cap-range"><span>同时跑 case 数 <b class="num" id="capShareCasesOut">64</b></span><input id="capShareCases" type="range" min="4" max="256" step="4" value="64"></label>
                <label class="cap-range"><span>模型请求额度 <b class="num" id="capShareBudgetOut">128</b></span><input id="capShareBudget" type="range" min="32" max="512" step="8" value="128"></label>
              </div>
              <div class="cap-ro-grid">
                <div><span>每条在途上限</span><b class="num"><span id="capShareValue">2</span> 个</b></div>
                <div><span>实际在用请求</span><b class="num"><span id="capShareStreams">128</span> 个</b></div>
                <div><span>额度 : 并发</span><b class="num" id="capShareRatio">2.00 : 1</b></div>
              </div>
              <div class="cap-callout" id="capShareVerdict" data-tone="ok">
                <b>每条 2 个在途请求</b>
                <span>多组组件调查可以并行推进，对应实测最快的 64 并发 / 128 额度档。</span>
              </div>
            </div>
          </div>
          <div class="doc-sub">
            <div class="doc-sub-head"><h3>目标速度反推并发流</h3>${copyBtnHTML("复制结果", { fn: "capTarget" })}</div>
            <div class="cap-calc-card">
              <div class="cap-controls">
                <label class="cap-range"><span>目标速度 <b class="num"><span id="capTargetRateOut">300</span> 行/h</b></span><input id="capTargetRate" type="range" min="100" max="600" step="5" value="300"></label>
                <label class="cap-range"><span>单条模型工时 <b class="num"><span id="capTargetWorkOut">1,200</span> s</b></span><input id="capTargetWork" type="range" min="400" max="2400" step="50" value="1200"></label>
              </div>
              <div class="cap-readout">
                <div class="cap-ro-main"><span>需常驻在途请求</span><div><b class="num" id="capTargetStreams">100.0</b><em>条</em></div></div>
                <div class="cap-ro-grid cap-ro-grid-2">
                  <div><span>每 100 条流产出</span><b class="num"><span id="capTargetPer100">300</span> 行/h</b></div>
                  <div><span>128 额度评估</span><b id="capTargetBadge" class="cap-verdict-num">128 够用</b></div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section class="doc-sec" id="cap-obs" aria-label="观测与排查">
        <div class="doc-sec-head"><span class="doc-idx num">05</span><h2>线上观测与排查手册</h2></div>
        <p class="doc-lead">运行变慢、准入停滞或产出骤降时，按「整批摘要 → 分阶段延迟 → 返工与排队 → 失败网关」的顺序直接运行以下命令定位。</p>
        <div class="doc-sub">
          <div class="doc-sub-head"><h3>常用 jq 排查命令（耗时单位均为毫秒）</h3></div>
          <ol class="cap-recipes">${recipeItems}</ol>
        </div>
        <div class="doc-sub">
          <div class="doc-sub-head"><h3>Runner 产物职责</h3></div>
          <div class="cap-table-wrap">
            <table class="cap-table">
              <thead><tr><th style="width:24%">产物</th><th>回答什么</th><th style="width:28%">边界</th></tr></thead>
              <tbody>${artRows}</tbody>
            </table>
          </div>
        </div>
        <div class="doc-sub">
          <div class="doc-sub-head"><h3>runtime.log 事件与字段</h3></div>
          <div class="cap-table-wrap">
            <table class="cap-table">
              <thead><tr><th style="width:32%">字段</th><th>定义</th><th style="width:24%">排查用途</th></tr></thead>
              <tbody>${fieldRows}</tbody>
            </table>
          </div>
        </div>
        <div class="doc-sub">
          <div class="doc-sub-head"><h3>34 条抽样实测拆解（${SAMPLE.date} · ${SAMPLE.model} · ${SAMPLE.concurrency} 并发 / ${SAMPLE.modelRequests} 额度）</h3></div>
          <div class="cap-figs" style="--cols:3">${sampleWallCells}</div>
          <div class="cap-table-wrap">
            <table class="cap-table">
              <thead><tr><th>阶段</th><th class="num">次 / 批</th><th class="num">模型中位</th><th class="num">p90</th><th class="num">返工率</th><th class="num">缓存 token</th><th class="num">输出 token</th></tr></thead>
              <tbody>${sampleStageRows}</tbody>
            </table>
          </div>
          <div class="doc-split">
            <div>
              <h4 class="cap-subhead">最慢 Compact 字段（中位 / p90）</h4>
              <div class="cap-fieldbars">${slowBars}</div>
            </div>
            <div>
              <h4 class="cap-subhead">返工原因（submissionCodes 合计）</h4>
              <div class="cap-table-wrap">
                <table class="cap-table">
                  <thead><tr><th>代码</th><th>含义</th><th class="num">次数</th></tr></thead>
                  <tbody>${codeRows}</tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
        <div class="doc-split">
          <div class="doc-sub">
            <div class="doc-sub-head"><h3>核心术语</h3></div>
            <div class="cap-table-wrap">
              <table class="cap-table">
                <thead><tr><th style="width:30%">术语</th><th>定义</th></tr></thead>
                <tbody>${metricRows}</tbody>
              </table>
            </div>
          </div>
          <div class="doc-sub">
            <div class="doc-sub-head"><h3>数据来源记录</h3></div>
            <div class="cap-srcs">${sourceRows}</div>
          </div>
        </div>
      </section>
    </div>
  </div>`;
}

function drawLadderChart(svgNode) {
  if (!svgNode || svgNode.childElementCount) return;
  const W = 1100;
  const H = 300;
  const pad = { l: 56, r: 24, t: 28, b: 54 };
  const plotW = W - pad.l - pad.r;
  const plotH = H - pad.t - pad.b;
  const maxY = 320;
  svgNode.setAttribute("viewBox", `0 0 ${W} ${H}`);

  const xAt = (i) => pad.l + (plotW * (i + 0.5)) / LADDER.length;
  const yAt = (v) => pad.t + plotH * (1 - v / maxY);

  [0, 100, 200, 300].forEach((tick) => {
    const y = yAt(tick);
    svgNode.appendChild(svgEl("line", { class: "gridline", x1: pad.l, x2: W - pad.r, y1: y, y2: y }));
    const label = svgEl("text", { class: "axis-label", x: pad.l - 10, y: y + 4, "text-anchor": "end" });
    label.textContent = String(tick);
    svgNode.appendChild(label);
  });
  const title = svgEl("text", { class: "axis-title", x: pad.l, y: pad.t - 10, "text-anchor": "start" });
  title.textContent = "归因行 / 小时";
  svgNode.appendChild(title);

  const pts = LADDER.map((r, i) => ({ x: xAt(i), y: yAt(rowsPerHour(r)), r }));
  const d = pts.map((p, i) => `${i ? "L" : "M"}${p.x} ${p.y}`).join(" ");
  svgNode.appendChild(svgEl("path", { class: "line rows", d }));

  pts.forEach((p) => {
    const { r } = p;
    const rate = rowsPerHour(r);
    const isPeak = r.cases === 64;
    const isBroken = r.cases === 128;
    svgNode.appendChild(svgEl("circle", {
      class: `point${isPeak ? " is-peak" : isBroken ? " is-broken" : ""}`,
      cx: p.x, cy: p.y, r: 5,
    }));
    const vLab = svgEl("text", { class: "point-label", x: p.x, y: p.y - 11, "text-anchor": "middle" });
    vLab.textContent = fmt(rate, 1);
    svgNode.appendChild(vLab);

    const xLab = svgEl("text", { class: "axis-label", x: p.x, y: H - pad.b + 18, "text-anchor": "middle" });
    xLab.textContent = `${r.cases} 并发`;
    svgNode.appendChild(xLab);
    const subLab = svgEl("text", { class: "band-label", x: p.x, y: H - pad.b + 34, "text-anchor": "middle" });
    subLab.textContent = `额度 ${r.budget}`;
    svgNode.appendChild(subLab);

    const hit = svgEl("rect", {
      class: "hit", x: p.x - plotW / LADDER.length / 2, y: pad.t,
      width: plotW / LADDER.length, height: plotH,
    });
    hit.addEventListener("pointermove", (e) => {
      showTip(
        `<div class="t-head">${r.cases} 并发 · ${r.budget} 额度</div>`
        + `<div class="t-row">归因行/h<b class="num">${fmt(rate, 1)}</b></div>`
        + `<div class="t-row">准入 / 完成 / 失败<b class="num">${r.admitted} / ${r.completed} / ${r.failed}</b></div>`
        + `<div class="t-row">归因完成度<b class="num">${pct(r.attribution, r.admitted, 0)}</b></div>`
        + `<div class="t-row">每 case 在途份额<b class="num">${budgetShare(r)}</b></div>`
        + `<div class="t-row">峰值 RSS<b class="num">${fmt(r.rss)} MB</b></div>`,
        e.clientX, e.clientY,
      );
    });
    hit.addEventListener("pointerleave", hideTip);
    svgNode.appendChild(hit);
  });
}

function drawServiceChart(svgNode) {
  if (!svgNode || svgNode.childElementCount) return;
  const W = 560;
  const H = 240;
  const pad = { l: 52, r: 16, t: 26, b: 36 };
  const plotW = W - pad.l - pad.r;
  const plotH = H - pad.t - pad.b;
  const min = 100;
  const max = 20000;
  const logMin = Math.log10(min);
  const logMax = Math.log10(max);
  const yAt = (v) => pad.t + plotH * (1 - (Math.log10(Math.max(min, v)) - logMin) / (logMax - logMin));
  svgNode.setAttribute("viewBox", `0 0 ${W} ${H}`);

  [100, 1000, 10000].forEach((tick) => {
    const y = yAt(tick);
    svgNode.appendChild(svgEl("line", { class: "gridline", x1: pad.l, x2: W - pad.r, y1: y, y2: y }));
    const label = svgEl("text", { class: "axis-label", x: pad.l - 8, y: y + 4, "text-anchor": "end" });
    label.textContent = tick >= 1000 ? `${tick / 1000}k s` : `${tick} s`;
    svgNode.appendChild(label);
  });

  const band = plotW / LADDER.length;
  LADDER.forEach((r, i) => {
    const v = serviceTime(r);
    const isPeak = r.cases === 64;
    const isBroken = r.cases === 128;
    const x = pad.l + band * i + band * 0.22;
    const barW = band * 0.56;
    const y = yAt(v);
    svgNode.appendChild(svgEl("rect", {
      class: `bar${isPeak ? " is-peak" : isBroken ? " is-broken" : ""}`,
      x, y, width: barW, height: pad.t + plotH - y, rx: 4,
    }));
    const lab = svgEl("text", { class: "bar-label", x: x + barW / 2, y: y - 6, "text-anchor": "middle" });
    lab.textContent = v >= 1000 ? `${(v / 1000).toFixed(1)}k` : fmt(Math.round(v));
    svgNode.appendChild(lab);
    const xLab = svgEl("text", { class: "bar-axis", x: x + barW / 2, y: H - pad.b + 16, "text-anchor": "middle" });
    xLab.textContent = String(r.cases);
    svgNode.appendChild(xLab);
  });
}

export function wireCapacityDoc(root) {
  bindTips(root);
  runCounters(root);
  drawLadderChart($("#capLadderChart", root));
  drawServiceChart($("#capServiceChart", root));

  // 批量规划器
  const rowsIn = $("#capPlanRows", root);
  const rateIn = $("#capPlanRate", root);
  const syncPlan = () => {
    if (!rowsIn || !rateIn) return;
    const rows = Number(rowsIn.value);
    const rate = Number(rateIn.value);
    const attempts = rows * PER_ROW.attempts;
    const tokens = rows * PER_ROW.tokens;
    const modelH = (rows * PER_ROW.modelSeconds) / 3600;
    const wallH = rows / rate;
    const streams = (rate * PER_ROW.modelSeconds) / 3600;
    $("#capPlanRowsOut", root).textContent = fmt(rows);
    $("#capPlanRateOut", root).textContent = fmt(rate);
    $("#capPlanAttempts", root).textContent = fmt(Math.round(attempts));
    $("#capPlanTokens", root).textContent = compact(tokens);
    $("#capPlanModel", root).textContent = `${fmt(Math.round(modelH))} h`;
    $("#capPlanWall", root).textContent = wallH >= 1 ? `${wallH.toFixed(1)} h` : `${Math.round(wallH * 60)} min`;
    $("#capPlanStreams", root).textContent = fmt(Math.round(streams));
  };
  const syncPlanPresets = () => {
    const cur = Number(rowsIn?.value || 0);
    $$("[data-plan-rows]", root).forEach((b) => b.setAttribute("aria-pressed", String(Number(b.dataset.planRows) === cur)));
  };
  rowsIn?.addEventListener("input", () => { syncPlan(); syncPlanPresets(); });
  rateIn?.addEventListener("input", syncPlan);
  $$("[data-plan-rows]", root).forEach((btn) => {
    btn.addEventListener("click", () => {
      if (!rowsIn) return;
      rowsIn.value = btn.dataset.planRows;
      syncPlan();
      syncPlanPresets();
    });
  });
  syncPlan();
  syncPlanPresets();

  // 并发与额度配比试算
  const casesIn = $("#capShareCases", root);
  const budgetIn = $("#capShareBudget", root);
  const syncSharePresets = () => {
    const key = `${casesIn?.value},${budgetIn?.value}`;
    $$("[data-share-preset]", root).forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.sharePreset === key)));
  };
  const syncShare = () => {
    if (!casesIn || !budgetIn) return;
    const cases = Number(casesIn.value);
    const budget = Number(budgetIn.value);
    const share = Math.max(1, Math.floor(budget / cases));
    const streams = Math.min(cases * share, budget);
    $("#capShareCasesOut", root).textContent = fmt(cases);
    $("#capShareBudgetOut", root).textContent = fmt(budget);
    $("#capShareValue", root).textContent = String(share);
    $("#capShareStreams", root).textContent = fmt(streams);
    $("#capShareRatio", root).textContent = `${(budget / cases).toFixed(2)} : 1`;
    const verdict = $("#capShareVerdict", root);
    if (verdict) {
      const ok = share >= 2;
      verdict.dataset.tone = ok ? "ok" : "warn";
      verdict.innerHTML = ok
        ? `<b>每条 ${share} 个在途请求</b><span>多组组件调查可并行推进，实测 64 并发 / 128 额度属于该区间。</span>`
        : `<b>每条仅 1 个在途请求</b><span>组件调查退化为串行排队，单条耗时显著拉长（128 并发 / 128 额度下完成度仅 5%）。</span>`;
    }
    syncSharePresets();
  };
  casesIn?.addEventListener("input", syncShare);
  budgetIn?.addEventListener("input", syncShare);
  $$("[data-share-preset]", root).forEach((btn) => {
    btn.addEventListener("click", () => {
      if (!casesIn || !budgetIn) return;
      const [c, b] = btn.dataset.sharePreset.split(",");
      casesIn.value = c;
      budgetIn.value = b;
      syncShare();
    });
  });
  syncShare();

  // 目标速度反推
  const tRateIn = $("#capTargetRate", root);
  const tWorkIn = $("#capTargetWork", root);
  const syncTarget = () => {
    if (!tRateIn || !tWorkIn) return;
    const rate = Number(tRateIn.value);
    const work = Number(tWorkIn.value);
    const streams = (rate * work) / 3600;
    const per100 = (100 * 3600) / work;
    $("#capTargetRateOut", root).textContent = fmt(rate);
    $("#capTargetWorkOut", root).textContent = fmt(work);
    $("#capTargetStreams", root).textContent = fmt(streams, 1);
    $("#capTargetPer100", root).textContent = fmt(Math.round(per100));
    const badge = $("#capTargetBadge", root);
    if (badge) {
      badge.textContent = streams <= 128 ? "128 够用" : streams <= 200 ? "需 200 额度" : "需 >200 额度";
      badge.dataset.tone = streams <= 128 ? "ok" : "warn";
    }
  };
  tRateIn?.addEventListener("input", syncTarget);
  tWorkIn?.addEventListener("input", syncTarget);
  syncTarget();
}

export function capacityCopyResolvers(root) {
  return {
    capHero: () => "292.8 行/h（100 并发 / 200 额度，138 行 / 1,697 s）｜单条 412,885 token（17.65 次调用，1,199 s 模型工时，92% 缓存）",
    capPlan: () => `批量 ${$("#capPlanRowsOut", root)?.textContent} 条 @ ${$("#capPlanRateOut", root)?.textContent} 条/h → 预计 ${$("#capPlanTokens", root)?.textContent} token · ${$("#capPlanAttempts", root)?.textContent} 次调用 · 模型工时 ${$("#capPlanModel", root)?.textContent} · 墙钟 ${$("#capPlanWall", root)?.textContent} · 需并发流 ${$("#capPlanStreams", root)?.textContent} 条`,
    capShare: () => `并发 ${$("#capShareCasesOut", root)?.textContent} / 额度 ${$("#capShareBudgetOut", root)?.textContent}（${$("#capShareRatio", root)?.textContent}）→ 每条上限 ${$("#capShareValue", root)?.textContent} 个 · 实际在用 ${$("#capShareStreams", root)?.textContent} 个 · ${$("#capShareVerdict b", root)?.textContent}`,
    capTarget: () => `目标速度 ${$("#capTargetRateOut", root)?.textContent} 行/h · 单条模型工时 ${$("#capTargetWorkOut", root)?.textContent} s → 需常驻流 ${$("#capTargetStreams", root)?.textContent} 条（${$("#capTargetBadge", root)?.textContent}）`,
  };
}
