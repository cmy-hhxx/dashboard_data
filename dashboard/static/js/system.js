/* Evaluation-system explainer: one module-owned rAF loop, three animated scenes. */
const TAB_ORDER = ["overview", "chain", "quality"];

const REDUCED_MQ =
  typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-reduced-motion: reduce)")
    : { matches: false, addEventListener() {} };

const ICONS = {
  play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.1v13.8L18.7 12 8 5.1Z" fill="currentColor"/></svg>',
  pause:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7.2" y="5.5" width="3.3" height="13" rx="1.2" fill="currentColor"/><rect x="13.5" y="5.5" width="3.3" height="13" rx="1.2" fill="currentColor"/></svg>',
  prev: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14.7 5.6 8.1 12l6.6 6.4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  next: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9.3 5.6 6.6 6.4-6.6 6.4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  arrow:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h13.2M13.8 6.6 19.2 12l-5.4 5.4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  replay:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5.4 9.3A7.2 7.2 0 1 1 5 13.8M5.4 9.3V5.4m0 3.9H9.3" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  check:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.6 4.4 4.3L19.2 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

const BRANCHES = [
  { name: "Comparison", sub: "整场两两对比", color: "var(--ai)", independent: false },
  { name: "Instruction Review", sub: "指令遵循复核", color: "var(--cl-2)", independent: false },
  { name: "Rewrite", sub: "文本槽位润色", color: "var(--cl-4)", independent: false },
  { name: "Clustering", sub: "问题观察聚类", color: "var(--cl-3)", independent: false },
  { name: "Score", sub: "独立评分", color: "var(--b)", independent: true },
];

const STAGES = [
  {
    tag: "INPUT",
    title: "输入与来源",
    desc: "每一行就是一条评测记录，保留该记录的全部 trace、消息顺序与原始坐标；没有完整最终回答的记录先过滤，不补造上下文。",
    facts: [
      "多 trace 可以共享 session_id，但不会自动合并上下文；外层计数不与实际采集量混用。",
      "证据空间从输入建立：trace_index / message_index / 原始字段 path / 半开 UTF-16 范围。",
    ],
    source: "docs/attribution.md · 输入边界",
    ms: 1500,
  },
  {
    tag: "PREP",
    title: "Criteria / Compact",
    desc: "两条准备线并行：Criteria 定义共同交付边界；Compact 把过程材料整理成有界、可引用、可续跑的结构化字段。",
    facts: [
      "Criteria 只读原题、公开要求与统一质量规范，不读内部指令、标准答案或候选回答。",
      "Compact 每个字段一个独立模型会话，由代码拼装；不调用汇总模型，也不保留临时编号。",
    ],
    source: "docs/contract.md · 阶段职责",
    ms: 2000,
  },
  {
    tag: "TRACE",
    title: "Trace 归因",
    desc: "每个 trace 沿完整过程审查：先核对请求、返回与实际使用，再从 taxonomy 选择最具体的责任条目，并保留可回跳的证据引用。",
    facts: [
      "模型选择条目 ID 与 actor_index；程序回填具体组件名、完整 evidence_id 与短引文。",
      "同一上游问题沿用到终稿不重复计责；报错、零行、截断是线索，不凭关键词直接定责。",
    ],
    source: "docs/attribution.md · Trace 汇总",
    ms: 2000,
  },
  {
    tag: "SESSION",
    title: "Session 归因",
    desc: "在逐轮结果之上只复核跨轮前提、条件与结论变化；各轮结果由程序原样回填，单轮 session 直接生成终态。",
    facts: [
      "Session 不重做每轮数值和工具审查，避免把局部评语当成原始事实。",
      "接受后立即写 attribution.jsonl，其他 session 不必等待整批完成。",
    ],
    source: "docs/attribution.md · Session 汇总",
    ms: 2000,
  },
  {
    tag: "OUTPUT",
    title: "JSONL 产物",
    desc: "compact 与 attribution 各自追加 JSONL：一行一条输入记录，任务 UUID、行号、原始来源与可续跑状态一起保留。",
    facts: [
      "compact.jsonl 在 Compact 接受后立即落盘；正式行保留六字段与证据坐标。",
      "已接受判词不因续跑或复用被改写；同一 ID 同内容跳过，同 ID 不同正文报错。",
    ],
    source: "docs/contract.md · 正式契约",
    ms: 1800,
  },
  {
    tag: "DOWNSTREAM",
    title: "五个下游消费者",
    desc: "已接受结果进入 Comparison、Instruction Review、Rewrite 与 Clustering；Score 保留独立 Agent 契约，尚未接入 session workflow。",
    facts: [
      "分支只消费主链判词，不反向改写归因；Rewrite 只润色指定文本槽位。",
      "Clustering 固定所选归因引用；未知责任不交给聚类猜测。",
    ],
    source: "README.md · 评测能力",
    tone: "b",
    ms: 2600,
  },
];

const MECHANISMS = [
  { id: "M1", name: "空转未执行", short: "空转", color: "var(--cl-6)" },
  { id: "M2", name: "目标错配", short: "错配", color: "var(--cl-2)" },
  { id: "M3", name: "执行失败", short: "失败", color: "var(--cl-5)" },
  { id: "M4", name: "结果不可用", short: "不可用", color: "var(--cl-3)" },
  { id: "M5", name: "加工计算错误", short: "计算", color: "var(--cl-4)" },
  { id: "M6", name: "无依据断言", short: "断言", color: "var(--b-mid)" },
  { id: "M7", name: "交付不符", short: "交付", color: "var(--wc-mid)" },
];

const MATRIX = [
  { id: "S1", name: "取数规划", counts: [3, 11, 2, 0, 0, 1, 0] },
  { id: "S2", name: "检索规划", counts: [3, 9, 1, 1, 0, 1, 0] },
  { id: "S3", name: "结构化取数", counts: [1, 8, 7, 7, 4, 1, 0] },
  { id: "S4", name: "本地计算", counts: [1, 2, 10, 7, 3, 1, 1] },
  { id: "S5", name: "网页检索", counts: [0, 0, 1, 6, 0, 0, 0] },
  { id: "S6", name: "客服知识库", counts: [0, 0, 2, 4, 0, 2, 2] },
  { id: "S7", name: "记忆", counts: [1, 0, 2, 1, 0, 0, 0] },
  { id: "S8", name: "能力装载", counts: [1, 0, 1, 1, 1, 0, 0] },
  { id: "S9", name: "终稿生成", counts: [2, 2, 1, 1, 6, 7, 4] },
];

const QUALITY = [
  { label: "Krippendorff α", value: "0.918", width: "91.8%", tone: "alpha", note: "两位标注员彼此一致率 · 576 条双盲样本" },
  { label: "质量模式 vs 双盲共识", value: "91.3%", width: "91.3%", tone: "quality", note: "叶子级 exact · 快速模式为 88.1%" },
  { label: "双盲金标", value: "529", width: "91.8%", tone: "gold", note: "576 条抽样中两人一致的 529 条 · 机制层 97.0%" },
];

let instance = null;
let controller = null;
let raf = 0;
let lastFrame = 0;

const esc = (value) =>
  String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const pad = (n) => String(n).padStart(2, "0");
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const easeOut = (v) => 1 - Math.pow(1 - clamp(v, 0, 1), 3);

/* ------------------------------------------------------------------ markup */

function tabsMarkup() {
  const tabs = [
    ["overview", "01", "总览", "主链路"],
    ["chain", "02", "归因链", "证据回跳"],
    ["quality", "03", "聚类与质量", "版本事实"],
  ];
  return tabs
    .map(
      ([id, num, name, hint]) =>
        `<button class="sys-tab" id="sysTab-${id}" type="button" role="tab" data-scene="${id}" aria-controls="sysScene-${id}" aria-selected="false" tabindex="-1"><span class="sys-tab-num">${num}</span><span class="sys-tab-name">${name}</span><span class="sys-tab-hint">${hint}</span></button>`,
    )
    .join("");
}

function detailMarkup(stage) {
  const s = STAGES[stage];
  const branches =
    stage === 5
      ? `<div class="sys-branch-list">${BRANCHES.map(
          (b) =>
            `<span class="sys-branch-pill" style="--c:${b.color}"><i></i>${esc(b.name)}<em>${esc(b.sub)}</em></span>`,
        ).join("")}</div>`
      : "";
  return `<div class="sys-detail-body is-swap" data-stage="${stage}">
    <div class="sys-detail-head"><span class="sys-detail-index">${pad(stage + 1)}</span><span class="sys-detail-tag">${esc(s.tag)}</span></div>
    <h3>${esc(s.title)}</h3>
    <p>${esc(s.desc)}</p>
    <ul class="sys-detail-facts">${s.facts.map((f) => `<li>${esc(f)}</li>`).join("")}</ul>
    ${branches}
    <div class="sys-detail-source"><span>SOURCE</span><code>${esc(s.source)}</code></div>
  </div>`;
}

function pipelineSvg() {
  const node = (stage, x, y, w, h, num, title, sub, color) => `
    <g class="sys-node" data-stage="${stage}" tabindex="0" role="button" aria-label="${esc(title)}，查看阶段说明" style="--c:${color}">
      <rect class="node-halo" x="${x - 3}" y="${y - 3}" width="${w + 6}" height="${h + 6}" rx="21"/>
      <rect class="node-bg" x="${x}" y="${y}" width="${w}" height="${h}" rx="18"/>
      <rect class="node-accent" x="${x + 14}" y="${y + 13}" width="18" height="3" rx="1.5"/>
      <text class="node-num" x="${x + 14}" y="${y + 34}">${num}</text>
      <text class="node-title" x="${x + 14}" y="${y + 63}">${title}</text>
      <text class="node-sub" x="${x + 14}" y="${y + 82}">${sub}</text>
    </g>`;
  const rail = (i) => {
    const sources = [675, 675, 864, 864, 864];
    const tx = [128, 304, 480, 656, 832][i];
    const d = `M${sources[i]} 190 V238 H${tx} V304`;
    return `<path class="sys-rail${BRANCHES[i].independent ? " is-independent" : ""}" data-rail="${i}" style="--c:${BRANCHES[i].color}" d="${d}"/>`;
  };
  const branch = (b, i) => {
    const x = 46 + i * 176;
    const y = 304;
    return `<g class="sys-branch" style="--c:${b.color}" aria-hidden="true">
      <rect class="branch-bg" x="${x}" y="${y}" width="164" height="48" rx="12"/>
      <circle class="branch-dot" cx="${x + 18}" cy="${y + 19}" r="3.5"/>
      <text class="branch-name" x="${x + 29}" y="${y + 21}">${esc(b.name)}</text>
      <text class="branch-sub" x="${x + 29}" y="${y + 36}">${esc(b.sub)}</text>
    </g>`;
  };
  return `<svg class="sys-pipeline-svg" viewBox="0 0 960 410" role="group" aria-label="评测主链动画：输入到 Criteria 与 Compact，再到 Trace 归因、Session 归因和 JSONL 产物，末端连接五个下游消费者">
    <defs>
      <linearGradient id="sysFlow" x1="0" x2="1" y1="0" y2="0">
        <stop offset="0" stop-color="var(--wc)" stop-opacity=".18"/>
        <stop offset=".48" stop-color="var(--wc)" stop-opacity=".55"/>
        <stop offset="1" stop-color="var(--ai)" stop-opacity=".28"/>
      </linearGradient>
      <pattern id="sysDots" width="22" height="22" patternUnits="userSpaceOnUse">
        <circle cx="1.2" cy="1.2" r="1" fill="var(--faint)" opacity=".16"/>
      </pattern>
      <filter id="sysGlow" x="-140%" y="-140%" width="380%" height="380%">
        <feGaussianBlur stdDeviation="4.5" result="blur"/>
        <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
      </filter>
    </defs>
    <rect x="0" y="0" width="960" height="410" fill="url(#sysDots)" rx="18"/>
    <g class="sys-rails" aria-hidden="true">
      ${BRANCHES.map((_, i) => rail(i)).join("")}
      <path class="sys-rail-feed" d="M493 190 V238 M675 190 V238 M864 190 V238"/>
      <text class="rail-caption" x="24" y="258">下游消费者</text>
      <text class="rail-caption rail-caption--right" x="864" y="258" text-anchor="end">只读 / 可续跑</text>
    </g>
    <path class="sys-mainline" d="M22 132 H864"/>
    <g class="sys-packets" aria-hidden="true">
      <g class="sys-packet" data-main-packet="1" style="--c:var(--wc)"><circle class="packet-halo" r="10"/><circle class="packet-core" r="3.4"/></g>
      ${BRANCHES.map(
        (b, i) =>
          `<g class="sys-packet sys-packet--branch is-hidden" data-branch-packet="${i}" style="--c:${b.color}"><circle class="packet-halo" r="7"/><circle class="packet-core" r="2.8"/></g>`,
      ).join("")}
    </g>
    <g class="sys-nodes">
      ${node(0, 22, 74, 132, 116, "01", "输入", "trace · message", "var(--wc)")}
      <g class="sys-node sys-node--prep" data-stage="1" tabindex="0" role="button" aria-label="准备层：Criteria 与 Compact，查看阶段说明" style="--c:var(--wc)">
        <rect class="node-halo" x="193" y="55" width="190" height="154" rx="21"/>
        <rect class="node-bg" x="196" y="58" width="184" height="148" rx="18"/>
        <rect class="node-accent" x="210" y="71" width="18" height="3" rx="1.5"/>
        <text class="node-num" x="210" y="92">02</text>
        <text class="node-title" x="210" y="113">准备层</text>
        <g class="prep-tile" style="--c:var(--wc)">
          <rect x="210" y="123" width="156" height="36" rx="12"/>
          <text class="prep-name" x="222" y="139">Criteria</text><text class="prep-sub" x="222" y="151">共同基准 · 交付边界</text>
        </g>
        <g class="prep-tile" style="--c:var(--ai)">
          <rect x="210" y="164" width="156" height="36" rx="12"/>
          <text class="prep-name" x="222" y="180">Compact</text><text class="prep-sub" x="222" y="192">过程材料 · 可引用字段</text>
        </g>
      </g>
      ${node(2, 424, 74, 142, 116, "03", "Trace 归因", "每 trace 过程审查", "var(--wc)")}
      ${node(3, 610, 74, 142, 116, "04", "Session 归因", "跨轮复核 · 回填", "var(--wc)")}
      ${node(4, 790, 74, 148, 116, "05", "JSONL 产物", "compact + attribution", "var(--ai)")}
    </g>
    <g class="sys-branches">${BRANCHES.map((b, i) => branch(b, i)).join("")}</g>
    <text class="sys-axis" x="480" y="392" text-anchor="middle">数据包沿主路径移动 · 节点逐段激活 · 动画仅示意流程，不表示实时吞吐</text>
  </svg>`;
}

function qualitySvgless() {
  const stats = [
    ["9", "环节", "taxonomy v3.0.0"],
    ["7", "机制", "M1 – M7"],
    ["133", "模式", "inventory.json"],
    ["124", "叶子", "冻结叶集 · README"],
  ];
  const max = Math.max(...MATRIX.flatMap((r) => r.counts));
  const header = `<div class="sys-matrix-head" role="row">
    <span class="matrix-corner" role="columnheader">环节 ↓ / 机制 →</span>
    ${MECHANISMS.map(
      (m) =>
        `<span class="matrix-mhead" role="columnheader" data-colhead="${m.id}" style="--m:${m.color}"><i class="m-dot"></i><b>${m.id}</b><span>${esc(m.short)}</span></span>`,
    ).join("")}
  </div>`;
  const rows = MATRIX.map((row, r) => {
    const total = row.counts.reduce((a, b) => a + b, 0);
    return `<div class="matrix-row" data-row="${r}" role="row">
      <span class="matrix-rowlabel" role="rowheader"><b>${row.id}</b><span>${esc(row.name)}</span><em>${total}</em></span>
      ${row.counts
        .map((count, c) => {
          const m = MECHANISMS[c];
          const alpha = count ? 12 + Math.round((count / max) * 40) : 0;
          return `<span class="matrix-cell${count ? " has-value" : " is-zero"}" role="cell" data-row="${r}" data-col="${c}" style="--m:${m.color};--a:${alpha}%" title="${esc(row.id)} · ${esc(m.id)} ${esc(m.name)}：${count} 个模式" aria-label="${esc(row.id)} ${esc(row.name)} × ${esc(m.id)} ${esc(m.name)}，${count} 个模式">${count || "·"}</span>`;
        })
        .join("")}
    </div>`;
  }).join("");
  return { stats, matrix: `<div class="sys-matrix" data-matrix role="table" aria-label="9 环节 × 7 机制的模式数矩阵">${header}${rows}</div>` };
}

function pageMarkup() {
  const qual = qualitySvgless();
  return `<div class="sys-root" data-scene="overview">
    <header class="sys-hero">
      <div class="sys-hero-main">
        <p class="sys-eyebrow"><i class="sys-live-dot" aria-hidden="true"></i>EVALUATION SYSTEM · 版本化说明</p>
        <h2>评测不是一句结论，<br><em>而是一条能回到原文的证据链。</em></h2>
        <p class="sys-lead">从输入、Compact、Trace 到 Session，评测把过程材料、责任判断与原文坐标一起落成可续跑的 JSONL。这里解释主链如何运转、证据如何回跳，以及 9 环节 × 7 机制的聚类分类法如何被验证。</p>
      </div>
      <aside class="sys-version" aria-label="固定版本来源">
        <span class="sys-version-eyebrow">PINNED · 版本事实</span>
        <div class="sys-version-row"><strong>r486</strong><span>eval_agent_harness</span></div>
        <div class="sys-version-row"><strong>v3.0.0</strong><span>cluster taxonomy</span></div>
        <p>数字为仓库版本事实，不随看板数据刷新。</p>
      </aside>
    </header>

    <nav class="sys-tabs" role="tablist" aria-label="评测体系场景" data-active="overview">
      <span class="sys-tab-knob" aria-hidden="true"></span>
      ${tabsMarkup()}
    </nav>

    <section class="sys-scene is-active" id="sysScene-overview" role="tabpanel" aria-labelledby="sysTab-overview" data-scene="overview">
      <header class="sys-scene-head">
        <div>
          <p class="sys-kicker">SCENE 01 · 主链路</p>
          <h2>一条主链，五个下游消费者</h2>
        </div>
        <p class="sys-scene-note">节点逐段点亮 · 分支只消费已接受结果，不反向改写主链</p>
      </header>
      <div class="sys-overview-grid">
        <article class="sys-panel sys-pipeline-panel" data-playing="1">
          <header class="sys-panel-head">
            <h3>评测主链</h3>
            <span class="sys-legend" aria-hidden="true"><span><i class="sys-legend-dot"></i>数据包</span><span><i class="sys-legend-line"></i>主路径</span><span><i class="sys-legend-dash"></i>独立接口</span></span>
          </header>
          <div class="sys-pipeline-scroll" id="sysPipelineCanvas"></div>
          <p class="sys-pipeline-hint" aria-hidden="true">横向滑动查看完整链路 →</p>
          <div class="sys-controls">
            <div class="sys-controls-left">
              <button class="sys-ctl" type="button" data-act="prev" aria-label="上一步" title="上一步">${ICONS.prev}</button>
              <button class="sys-play" type="button" data-act="play" title="暂停自动播放" aria-label="暂停自动播放"><span class="sys-play-icon">${ICONS.pause}</span><span class="sys-play-label">暂停</span></button>
              <button class="sys-ctl" type="button" data-act="next" aria-label="下一步" title="下一步">${ICONS.next}</button>
              <span class="sys-count"><b data-stage-count>01</b><span>/ 06</span></span>
            </div>
            <div class="sys-segs" data-segs role="group" aria-label="跳转到阶段"></div>
          </div>
        </article>
        <aside class="sys-panel sys-detail" aria-label="当前阶段说明">
          <div id="sysStageDetail">${detailMarkup(0)}</div>
        </aside>
      </div>
    </section>

    <section class="sys-scene" id="sysScene-chain" role="tabpanel" aria-labelledby="sysTab-chain" data-scene="chain" hidden>
      <header class="sys-scene-head">
        <div>
          <p class="sys-kicker">SCENE 02 · 证据回跳</p>
          <h2>三级材料，一条可回放的证据链</h2>
        </div>
        <p class="sys-scene-note">消息 → Compact → Trace → Session · 引文最终回到 trace 的原始坐标</p>
      </header>
      <div class="sys-chain" data-chain>
        <article class="sys-chain-step" style="--i:0">
          <header><b>01</b><span>原始消息</span><em>trace / message</em></header>
          <div class="sys-msg-stack">
            <div class="sys-msg"><i>user</i><span>问：这个标的近一年营收？</span></div>
            <div class="sys-msg"><i>tool</i><span>finquery 返回 0 行</span></div>
            <div class="sys-msg is-target" data-evidence-target><i>answer</i><span>“为您找到0条数据”</span></div>
          </div>
          <p>顺序、对象与原文路径都保留，不把拼接问答注册成原始消息。</p>
        </article>
        <span class="sys-chain-arrow" aria-hidden="true">→</span>
        <article class="sys-chain-step" style="--i:1">
          <header><b>02</b><span>Compact 字段</span><em>per-field session</em></header>
          <div class="sys-tiles">
            ${["session_overview", "plan", "execution_facts", "key_data", "gaps", "final_context"]
              .map((name, i) => `<span class="sys-tile" style="--i:${i}"><i></i>${name}</span>`)
              .join("")}
          </div>
          <p>字段各自提取、代码拼装；临时编号不进入正式 Compact。</p>
        </article>
        <span class="sys-chain-arrow" aria-hidden="true">→</span>
        <article class="sys-chain-step" style="--i:2">
          <header><b>03</b><span>Trace 审查</span><em>process review</em></header>
          <div class="sys-review">
            <span class="sys-review-mark">${ICONS.check}</span>
            <div class="sys-review-copy"><strong>沿完整过程归因</strong><span>S3.M3.4 · SQL 零行仍报成功</span></div>
            <div class="sys-chiprow"><span>quote</span><span>position</span><span>actor</span></div>
          </div>
          <p>先看请求、返回与实际使用，再选择最具体的责任条目。</p>
        </article>
        <span class="sys-chain-arrow" aria-hidden="true">→</span>
        <article class="sys-chain-step" style="--i:3">
          <header><b>04</b><span>Session 审查</span><em>cross-turn</em></header>
          <div class="sys-review">
            <span class="sys-review-mark is-ai">${ICONS.replay}</span>
            <div class="sys-review-copy"><strong>只查跨轮变化</strong><span>前提 / 条件 / 结论 · 回填 turns[]</span></div>
            <div class="sys-chiprow"><span>session_summary</span><span>session_problem</span></div>
          </div>
          <p>逐轮判词由程序回填，Session 不重做数值和工具审查。</p>
        </article>
      </div>

      <section class="sys-panel sys-evidence" aria-labelledby="sysEvidenceTitle">
        <header class="sys-panel-head">
          <h3 id="sysEvidenceTitle">证据回到原文</h3>
          <button class="sys-replay" type="button" data-act="replay">${ICONS.replay}<span>回放证据路径</span></button>
        </header>
        <div class="sys-evidence-loop" data-evidence-loop>
          <div class="sys-ev-card sys-ev-source">
            <span class="sys-ev-label">原始坐标 · source</span>
            <div class="sys-ev-target" data-evidence-target-card>
              <div class="sys-ev-target-head"><span>trace_index 0</span><span>message_index 3</span><span>/output/0/text</span></div>
              <p>“为您找到0条数据”</p>
            </div>
            <div class="sys-ev-coord">evidence_id ev_1111…_3_text_0_8_<br>/output/0/text · UTF-16 [0, 8)</div>
          </div>
          <div class="sys-ev-bridge" aria-hidden="true">
            <svg viewBox="0 0 68 48" preserveAspectRatio="none"><path d="M60 8C42 8 30 38 8 38"/><path d="M14 33l-7 5 8 4"/></svg>
            <span>snap back</span>
          </div>
          <div class="sys-ev-card sys-ev-quote" data-evidence-quote>
            <span class="sys-ev-label">正式引文 · quote</span>
            <q>为您找到0条数据</q>
            <div class="sys-ev-coord">trace_index 0 / message_index 3 / path /output/0/text</div>
            <div class="sys-ev-rule">必须是精确连续原文 · 上限 400 字 · 不拼接、不截断</div>
          </div>
          <span class="snap-ghost" data-snap-ghost aria-hidden="true">“为您找到0条数据”</span>
        </div>
        <div class="sys-evidence-foot">
          <div><b>position</b><span>trace / message / path / evidence_id 全保留</span></div>
          <div><b>component</b><span>reasoning / tool_call / answer 定位责任位置</span></div>
          <div class="sys-evidence-status" aria-live="polite" data-evidence-status>等待回放</div>
        </div>
      </section>

      <section class="sys-panel sys-jsonl" aria-labelledby="sysJsonlTitle">
        <div class="sys-jsonl-copy">
          <p class="sys-kicker">OUTPUT · JSONL</p>
          <h3 id="sysJsonlTitle">产物是一行一行的 JSONL</h3>
          <p>Compact 接受后先写 <code>compact.jsonl</code>；Session 接受后再追加 <code>attribution.jsonl</code>。每行绑定任务 UUID、一基行号与原始来源，可恢复、可续跑，也允许跨版本混合已接受判词。</p>
          <div class="sys-chiprow sys-chiprow--wide"><span>1 行 = 1 条输入记录</span><span>接受即落盘</span><span>判词不覆盖</span></div>
        </div>
        <pre class="sys-code" aria-label="JSONL 产物字段示意"><code><span class="jk">"session_meta"</span>: { … },
<span class="jk">"turns"</span>: [{
  <span class="jk">"summary"</span>: "…",
  <span class="jk">"problem"</span>: [{
    <span class="jk">"component"</span>: "finquery 取数服务",
    <span class="jk">"label"</span>: "零行结果未识别",
    <span class="jk">"evidence"</span>: [{ <span class="jk">"quote"</span>: "为您找到0条数据" }]
  }]
}],
<span class="jk">"session_summary"</span>: "…",
<span class="jk">"session_problem"</span>: []</code></pre>
      </section>
    </section>

    <section class="sys-scene" id="sysScene-quality" role="tabpanel" aria-labelledby="sysTab-quality" data-scene="quality" hidden>
      <header class="sys-scene-head">
        <div>
          <p class="sys-kicker">SCENE 03 · 聚类与质量</p>
          <h2>分类法不是灵感，是可复算的刻度</h2>
        </div>
        <p class="sys-scene-note">9 环节 × 7 机制 · 每个数字都有版本与口径</p>
      </header>
      <div class="sys-stats" role="list" aria-label="分类法仓库版本事实">
        ${qual.stats
          .map(
            ([value, label, note]) =>
              `<div class="sys-stat" role="listitem"><strong>${value}</strong><span>${label}</span><em>${note}</em></div>`,
          )
          .join("")}
      </div>
      <p class="sys-count-note"><span>REPO FACTS</span>9 / 7 / 133 来自 taxonomy v3.0.0 与 inventory.json；124 叶子为 README 冻结叶集记载。不随后台数据刷新。</p>
      <div class="sys-quality-grid">
        <article class="sys-panel sys-matrix-panel" aria-labelledby="sysMatrixTitle">
          <header class="sys-panel-head">
            <h3 id="sysMatrixTitle">9 环节 × 7 机制</h3>
            <span class="sys-scan-caption" data-scan-caption aria-hidden="true">行 / 列扫描</span>
          </header>
          <div class="sys-matrix-scroll">${qual.matrix}</div>
          <p class="sys-matrix-swipe" aria-hidden="true">横向滑动查看其余机制 →</p>
          <div class="sys-matrix-foot"><span><i class="sys-heat"></i>格内数字 = 该组合的模式数</span><span>行 = 责任环节 · 列 = 失效机制</span><span>峰值 S1·M2 = 11</span></div>
          <div class="sys-matrix-read">
            <span><b>L1</b> component 唯一映射，不靠语义猜</span>
            <span><b>L2</b> 按 M1→M7 取最早失效点</span>
            <span><b>L3</b> 互斥、可派工、可复现</span>
          </div>
        </article>
        <aside class="sys-quality">
          <article class="sys-panel sys-meters" data-quality aria-labelledby="sysMetersTitle">
            <header class="sys-panel-head"><h3 id="sysMetersTitle">质量刻度</h3><span class="sys-repo-tag">2026-10-30 批次</span></header>
            ${QUALITY.map(
              (m) =>
                `<div class="meter meter--${m.tone}"><div class="meter-head"><span>${esc(m.label)}</span><b>${esc(m.value)}</b></div><div class="meter-track"><i style="--v:${m.width}"></i></div><span class="meter-note">${esc(m.note)}</span></div>`,
            ).join("")}
            <p class="sys-meter-foot">质量模式已接近两位标注员彼此一致率；再往上需要更细分类法或人工仲裁，而不是继续加长提示词。</p>
          </article>
          <article class="sys-panel sys-recall-panel">
            <p class="sys-kicker">RECALL · eval:recall</p>
            <h3>把分类落回真实样本</h3>
            <p>聚类回答“像什么”，召回验证“是不是”。按钮只派发页面事件，不在这里发起网络请求。</p>
            <button class="sys-recall" type="button" data-act="recall">召回样本 ${ICONS.arrow}</button>
            <span class="sys-recall-status" data-recall-status aria-live="polite">detail: { product: "wencai" }</span>
          </article>
        </aside>
      </div>
    </section>

    <footer class="sys-foot">
      <div class="sys-foot-pins">
        <span class="sys-pin">eval_agent_harness r486</span>
        <span class="sys-pin">cluster taxonomy v3.0.0</span>
        <span class="sys-pin">docs/contract.md · attribution.md</span>
      </div>
      <p>本页是版本化说明：数字来自仓库文档与版本清单，是 repo facts，不是实时测量；当前看板批次以页头为准。证据引文与坐标仅作结构示例。</p>
    </footer>
  </div>`;
}

/* ------------------------------------------------------------------ state */

function clearRaf() {
  if (raf) cancelAnimationFrame(raf);
  raf = 0;
}

function ensureRaf() {
  if (raf || !instance || !instance.active || !instance.tick || document.hidden) return;
  lastFrame = performance.now();
  raf = requestAnimationFrame(frame);
}

function frame(now) {
  raf = 0;
  if (!instance || !instance.active || !instance.tick || document.hidden) return;
  const dt = Math.min(80, Math.max(0, now - lastFrame));
  lastFrame = now;
  const keep = instance.tick(dt);
  if (keep !== false && instance && instance.active && instance.tick && !document.hidden) {
    raf = requestAnimationFrame(frame);
  }
}

function clearTimers() {
  if (!instance) return;
  instance.timers.forEach((id) => clearTimeout(id));
  instance.timers = [];
}

function later(fn, ms) {
  if (!instance) return 0;
  const id = setTimeout(fn, ms);
  instance.timers.push(id);
  return id;
}

/* ---------------------------------------------------------------- pipeline */

function mountPipeline() {
  const host = instance.root.querySelector("#sysPipelineCanvas");
  if (!host) return null;
  host.innerHTML = pipelineSvg();
  const svg = host.querySelector("svg");
  const nodes = Array.from(svg.querySelectorAll(".sys-node"));
  const branches = Array.from(svg.querySelectorAll(".sys-branch"));
  const rails = BRANCHES.map((_, i) => svg.querySelector(`[data-rail="${i}"]`));
  const packets = BRANCHES.map((_, i) => svg.querySelector(`[data-branch-packet="${i}"]`));
  return {
    host,
    svg,
    nodes,
    branches,
    rails,
    packets,
    mainPacket: svg.querySelector("[data-main-packet]"),
    centers: [88, 288, 493, 675, 864],
    railLens: [],
    stage: 0,
    t: 0,
    playing: !instance.reduced,
  };
}

function renderPipeline() {
  const p = instance && instance.pipeline;
  if (!p) return;
  const stage = p.stage;
  const ms = STAGES[stage].ms;
  const pct = clamp(p.t / ms, 0, 1);
  if (stage < 5) {
    const from = stage === 0 ? 26 : p.centers[stage - 1];
    const to = p.centers[stage];
    const x = from + (to - from) * easeOut(pct / 0.62);
    p.mainPacket.classList.remove("is-hidden");
    p.mainPacket.setAttribute("transform", `translate(${x.toFixed(2)} 132)`);
    p.packets.forEach((packet) => packet.classList.add("is-hidden"));
  } else {
    p.mainPacket.classList.add("is-hidden");
    p.packets.forEach((packet, i) => {
      const rail = p.rails[i];
      if (!rail) return;
      if (!p.railLens[i]) {
        try {
          p.railLens[i] = rail.getTotalLength();
        } catch (e) {
          p.railLens[i] = 0;
        }
      }
      const local = clamp((p.t - i * 110) / 980, 0, 1);
      const point = rail.getPointAtLength(p.railLens[i] * easeOut(local));
      packet.classList.toggle("is-hidden", local <= 0);
      packet.setAttribute("transform", `translate(${point.x.toFixed(2)} ${point.y.toFixed(2)})`);
    });
  }
}

function applyPipelineStage() {
  const p = instance.pipeline;
  const stage = p.stage;
  p.nodes.forEach((node, i) => {
    const active = i === stage || (stage === 5 && i === 4);
    node.classList.toggle("is-active", active);
    node.classList.toggle("is-done", i < stage || stage === 5);
    if (active) node.setAttribute("aria-current", "step");
    else node.removeAttribute("aria-current");
  });
  p.branches.forEach((b) => b.classList.toggle("is-active", stage === 5));
  const detail = instance.root.querySelector("#sysStageDetail");
  if (detail) {
    detail.innerHTML = detailMarkup(stage);
    const body = detail.firstElementChild;
    if (body && !instance.reduced) {
      body.classList.remove("is-swap");
      void body.offsetWidth;
      body.classList.add("is-swap");
    }
  }
  const detailPanel = instance.root.querySelector(".sys-detail");
  if (detailPanel) detailPanel.dataset.tone = STAGES[stage].tone || "wc";
  const counts = instance.root.querySelectorAll("[data-stage-count]");
  counts.forEach((el) => (el.textContent = pad(stage + 1)));
  const segs = instance.root.querySelectorAll(".sys-seg");
  segs.forEach((seg, i) => {
    seg.classList.toggle("is-active", i === stage);
    seg.classList.toggle("is-done", i < stage || stage === 5);
    if (i === stage) seg.setAttribute("aria-current", "step");
    else seg.removeAttribute("aria-current");
  });
}

function renderSegs() {
  const host = instance.root.querySelector("[data-segs]");
  if (!host) return;
  host.innerHTML = STAGES.map(
    (s, i) =>
      `<button class="sys-seg" type="button" data-stage="${i}" aria-label="跳转到 ${pad(i + 1)} ${esc(s.title)}" title="${pad(i + 1)} · ${esc(s.title)}"><span class="sys-seg-fill"></span></button>`,
  ).join("");
}

function updatePlayButton() {
  const p = instance.pipeline;
  const btn = instance.root.querySelector('[data-act="play"]');
  if (!btn) return;
  const icon = btn.querySelector(".sys-play-icon");
  const label = btn.querySelector(".sys-play-label");
  const panel = instance.root.querySelector(".sys-pipeline-panel");
  if (panel) panel.dataset.playing = p.playing && !instance.reduced ? "1" : "0";
  if (instance.reduced) {
    btn.disabled = true;
    btn.setAttribute("aria-label", "已按系统设置减少动态效果");
    btn.title = "已按系统设置减少动态；可用上一步 / 下一步查看各阶段";
    if (icon) icon.innerHTML = ICONS.pause;
    if (label) label.textContent = "减少动态";
    return;
  }
  btn.disabled = false;
  if (icon) icon.innerHTML = p.playing ? ICONS.pause : ICONS.play;
  if (label) label.textContent = p.playing ? "暂停" : "播放";
  btn.setAttribute("aria-label", p.playing ? "暂停自动播放" : "继续自动播放");
  btn.title = p.playing ? "暂停自动播放" : "继续自动播放";
}

function tickPipeline(dt) {
  const p = instance.pipeline;
  if (!p.playing || instance.reduced) {
    instance.tick = null;
    return false;
  }
  p.t += dt;
  let guard = 0;
  while (p.t >= STAGES[p.stage].ms && guard++ < 8) {
    p.t -= STAGES[p.stage].ms;
    p.stage = (p.stage + 1) % STAGES.length;
    applyPipelineStage();
  }
  renderPipeline();
  return true;
}

function startPipelineLoop() {
  const p = instance.pipeline;
  if (!p || instance.reduced || !p.playing) return;
  instance.tick = tickPipeline;
  ensureRaf();
}

function stopPipelineLoop() {
  instance.tick = null;
  clearRaf();
}

function selectStage(stage) {
  const p = instance.pipeline;
  if (!p) return;
  stopPipelineLoop();
  p.playing = false;
  p.stage = clamp(stage, 0, STAGES.length - 1);
  p.t = STAGES[p.stage].ms * 0.76;
  applyPipelineStage();
  renderPipeline();
  updatePlayButton();
}

function stepStage(dir) {
  const p = instance.pipeline;
  if (!p) return;
  const next = (p.stage + dir + STAGES.length) % STAGES.length;
  selectStage(next);
}

function togglePlay() {
  if (!instance || instance.reduced || !instance.pipeline) return;
  const p = instance.pipeline;
  if (p.playing) {
    p.playing = false;
    stopPipelineLoop();
  } else {
    p.playing = true;
    if (instance.active && instance.scene === "overview") startPipelineLoop();
  }
  updatePlayButton();
  applyPipelineStage();
  renderPipeline();
}

/* ------------------------------------------------------------------- chain */

function playEvidenceSnap() {
  if (!instance || !instance.active || instance.scene !== "chain" || instance.reduced) return;
  const loop = instance.root.querySelector("[data-evidence-loop]");
  const ghost = instance.root.querySelector("[data-snap-ghost]");
  const quote = instance.root.querySelector("[data-evidence-quote]");
  const target = instance.root.querySelector("[data-evidence-target-card]");
  const status = instance.root.querySelector("[data-evidence-status]");
  if (!loop || !ghost || !quote || !target) return;
  const qr = quote.getBoundingClientRect();
  const tr = target.getBoundingClientRect();
  const lr = loop.getBoundingClientRect();
  if (!qr.width || !tr.width) return;
  ghost.style.left = `${qr.left - lr.left + 14}px`;
  ghost.style.top = `${qr.top - lr.top + 8}px`;
  ghost.style.setProperty("--dx", `${tr.left - qr.left + Math.min(34, tr.width * 0.12)}px`);
  ghost.style.setProperty("--dy", `${tr.top - qr.top - 6}px`);
  ghost.classList.remove("is-snapping");
  void ghost.offsetWidth;
  ghost.classList.add("is-snapping");
  loop.classList.add("is-snapping");
  target.classList.remove("is-hit");
  void target.offsetWidth;
  target.classList.add("is-hit");
  if (status) status.textContent = "已回跳 · trace 0 / message 3 / /output/0/text";
  later(() => {
    ghost.classList.remove("is-snapping");
    loop.classList.remove("is-snapping");
  }, 1000);
  later(() => target.classList.remove("is-hit"), 1400);
}

function enterChain() {
  const chain = instance.root.querySelector("[data-chain]");
  if (!chain) return;
  chain.classList.remove("is-entered");
  void chain.offsetWidth;
  chain.classList.add("is-entered");
  const target = instance.root.querySelector("[data-evidence-target-card]");
  const status = instance.root.querySelector("[data-evidence-status]");
  if (instance.reduced) {
    if (target) target.classList.add("is-hit");
    if (status) status.textContent = "静态定位 · trace 0 / message 3 / /output/0/text";
    return;
  }
  if (status) status.textContent = "等待回放";
  later(playEvidenceSnap, 760);
}

/* ------------------------------------------------------------------ matrix */

function mountMatrix() {
  const matrix = instance.root.querySelector("[data-matrix]");
  if (!matrix) return null;
  const rows = Array.from(matrix.querySelectorAll(".matrix-row"));
  const cells = Array.from(matrix.querySelectorAll(".matrix-cell"));
  const heads = Array.from(matrix.querySelectorAll("[data-colhead]"));
  return {
    matrix,
    rows,
    cells,
    heads,
    order: [
      ...MATRIX.map((_, i) => ({ type: "row", i })),
      ...MECHANISMS.map((_, i) => ({ type: "col", i })),
    ],
    step: 0,
    acc: 0,
    hold: 0,
  };
}

function clearScan() {
  const m = instance && instance.matrix;
  if (!m) return;
  m.rows.forEach((row) => row.classList.remove("is-scan"));
  m.cells.forEach((cell) => cell.classList.remove("is-hot"));
  m.heads.forEach((head) => head.classList.remove("is-hot"));
  const caption = instance.root.querySelector("[data-scan-caption]");
  if (caption) caption.textContent = instance.reduced ? "静态矩阵" : "行 / 列扫描";
}

function applyScan(step) {
  const m = instance.matrix;
  clearScan();
  const caption = instance.root.querySelector("[data-scan-caption]");
  if (step.type === "row") {
    const row = m.rows[step.i];
    if (!row) return;
    row.classList.add("is-scan");
    m.cells.filter((c) => Number(c.dataset.row) === step.i).forEach((c) => c.classList.add("is-hot"));
    if (caption) caption.textContent = `${MATRIX[step.i].id} · ${MATRIX[step.i].name} · ${MATRIX[step.i].counts.reduce((a, b) => a + b, 0)} 个模式`;
  } else {
    m.heads.forEach((h, i) => h.classList.toggle("is-hot", i === step.i));
    m.cells.filter((c) => Number(c.dataset.col) === step.i).forEach((c) => c.classList.add("is-hot"));
    if (caption) caption.textContent = `${MECHANISMS[step.i].id} · ${MECHANISMS[step.i].name} · ${MATRIX.reduce((sum, r) => sum + r.counts[step.i], 0)} 个模式`;
  }
}

function tickMatrix(dt) {
  const m = instance.matrix;
  if (!m || instance.reduced) {
    instance.tick = null;
    return false;
  }
  if (m.hold > 0) {
    m.hold -= dt;
    return true;
  }
  m.acc += dt;
  if (m.acc < 640) return true;
  m.acc = 0;
  m.step += 1;
  if (m.step >= m.order.length) {
    clearScan();
    const caption = instance.root.querySelector("[data-scan-caption]");
    if (caption) caption.textContent = "扫描完成 · 9 × 7";
    m.step = 0;
    m.hold = 1200;
    return true;
  }
  applyScan(m.order[m.step]);
  return true;
}

function enterQuality() {
  const quality = instance.root.querySelector("[data-quality]");
  if (quality) {
    quality.classList.remove("is-ready");
    void quality.offsetWidth;
    quality.classList.add("is-ready");
  }
  const m = instance.matrix;
  if (!m) return;
  clearScan();
  m.step = 0;
  m.acc = 0;
  m.hold = 0;
  if (!instance.reduced) {
    applyScan(m.order[0]);
    instance.tick = tickMatrix;
    ensureRaf();
  }
}

/* --------------------------------------------------------------- lifecycle */

function syncSceneUI() {
  const scene = instance.scene;
  instance.root.dataset.scene = scene;
  const inner = instance.root.querySelector(".sys-root");
  if (inner) inner.dataset.scene = scene;
  const tabs = instance.root.querySelector(".sys-tabs");
  if (tabs) tabs.dataset.active = scene;
  instance.root.querySelectorAll(".sys-tab").forEach((tab) => {
    const on = tab.dataset.scene === scene;
    tab.classList.toggle("is-active", on);
    tab.setAttribute("aria-selected", String(on));
    tab.tabIndex = on ? 0 : -1;
  });
  instance.root.querySelectorAll(".sys-scene").forEach((panel) => {
    const on = panel.dataset.scene === scene;
    panel.hidden = !on;
    panel.classList.toggle("is-active", on);
  });
}

function clearSceneAnimations() {
  if (!instance) return;
  instance.tick = null;
  clearRaf();
  clearTimers();
  const chain = instance.root.querySelector("[data-chain]");
  if (chain) chain.classList.remove("is-entered");
  const quality = instance.root.querySelector("[data-quality]");
  if (quality) quality.classList.remove("is-ready");
  clearScan();
  const ghost = instance.root.querySelector("[data-snap-ghost]");
  if (ghost) ghost.classList.remove("is-snapping");
  const loop = instance.root.querySelector("[data-evidence-loop]");
  if (loop) loop.classList.remove("is-snapping");
  instance.root.querySelectorAll(".is-hit").forEach((el) => el.classList.remove("is-hit"));
}

function enterScene(scene) {
  if (!instance) return;
  clearSceneAnimations();
  instance.scene = scene;
  syncSceneUI();
  if (!instance.active) return;
  if (scene === "overview") {
    const p = instance.pipeline;
    if (instance.reduced) {
      p.playing = false;
      applyPipelineStage();
      renderPipeline();
    } else {
      if (p.playing) startPipelineLoop();
      else stopPipelineLoop();
      renderPipeline();
    }
    updatePlayButton();
  } else if (scene === "chain") {
    enterChain();
  } else {
    enterQuality();
  }
}

function selectScene(scene) {
  if (!instance || !TAB_ORDER.includes(scene) || scene === instance.scene) return;
  instance.scene = scene;
  syncSceneUI();
  if (instance.active) enterScene(scene);
}

function onReducedChange() {
  if (!instance) return;
  instance.reduced = Boolean(REDUCED_MQ.matches);
  instance.root.classList.toggle("is-reduced", instance.reduced);
  if (instance.reduced && instance.pipeline) {
    instance.pipeline.playing = false;
    instance.pipeline.stage = 5;
    instance.pipeline.t = STAGES[5].ms;
    applyPipelineStage();
    renderPipeline();
    updatePlayButton();
  }
  if (instance.active) enterScene(instance.scene);
}

function bind() {
  controller = new AbortController();
  const { signal } = controller;
  const root = instance.root;

  const tabs = root.querySelector(".sys-tabs");
  if (tabs) {
    tabs.addEventListener(
      "click",
      (ev) => {
        const tab = ev.target.closest(".sys-tab");
        if (tab) selectScene(tab.dataset.scene);
      },
      { signal },
    );
    tabs.addEventListener(
      "keydown",
      (ev) => {
        const current = instance.scene;
        const index = TAB_ORDER.indexOf(current);
        let next = null;
        if (ev.key === "ArrowRight") next = TAB_ORDER[(index + 1) % TAB_ORDER.length];
        else if (ev.key === "ArrowLeft") next = TAB_ORDER[(index + TAB_ORDER.length - 1) % TAB_ORDER.length];
        else if (ev.key === "Home") next = TAB_ORDER[0];
        else if (ev.key === "End") next = TAB_ORDER[TAB_ORDER.length - 1];
        if (!next) return;
        ev.preventDefault();
        selectScene(next);
        const tab = root.querySelector(`.sys-tab[data-scene="${next}"]`);
        if (tab) tab.focus();
      },
      { signal },
    );
  }

  root.addEventListener(
    "click",
    (ev) => {
      const act = ev.target.closest("[data-act]");
      if (act) {
        const name = act.dataset.act;
        if (name === "prev") stepStage(-1);
        else if (name === "next") stepStage(1);
        else if (name === "play") togglePlay();
        else if (name === "replay") playEvidenceSnap();
        else if (name === "recall") {
          const status = root.querySelector("[data-recall-status]");
          if (status) status.textContent = "已派发 · 正在打开样本页";
          act.classList.add("is-dispatched");
          window.dispatchEvent(new CustomEvent("eval:recall", { detail: { product: "wencai" } }));
          later(() => act.classList.remove("is-dispatched"), 900);
        }
        return;
      }
      const seg = ev.target.closest(".sys-seg");
      if (seg) {
        selectStage(Number(seg.dataset.stage));
        return;
      }
      const node = ev.target.closest(".sys-node[data-stage]");
      if (node) selectStage(Number(node.dataset.stage));
    },
    { signal },
  );

  const svg = root.querySelector(".sys-pipeline-svg");
  if (svg) {
    svg.addEventListener(
      "keydown",
      (ev) => {
        const node = ev.target.closest(".sys-node[data-stage]");
        if (!node) return;
        if (ev.key === "Enter" || ev.key === " ") {
          ev.preventDefault();
          selectStage(Number(node.dataset.stage));
        }
      },
      { signal },
    );
  }

  document.addEventListener(
    "visibilitychange",
    () => {
      if (!instance) return;
      if (document.hidden) {
        clearRaf();
      } else if (instance.active && instance.tick) {
        ensureRaf();
      }
    },
    { signal },
  );

  if (typeof REDUCED_MQ.addEventListener === "function") {
    REDUCED_MQ.addEventListener("change", onReducedChange, { signal });
  }
}

function teardown() {
  if (controller) {
    controller.abort();
    controller = null;
  }
  clearRaf();
  if (instance) {
    instance.timers.forEach((id) => clearTimeout(id));
    if (instance.root) instance.root.innerHTML = "";
  }
  instance = null;
}

/* --------------------------------------------------------------------- api */

export function initSystem(root, opts) {
  teardown();
  if (!root) return;
  root.innerHTML = pageMarkup();
  root.classList.remove("is-live");
  const options = opts || {};
  instance = {
    root,
    opts: options,
    data: options.data == null ? null : options.data,
    scene: "overview",
    active: false,
    reduced: Boolean(REDUCED_MQ.matches),
    tick: null,
    timers: [],
    pipeline: null,
    matrix: null,
  };
  instance.root.classList.toggle("is-reduced", instance.reduced);
  instance.pipeline = mountPipeline();
  instance.matrix = mountMatrix();
  if (!instance.pipeline) return;
  renderSegs();
  bind();
  syncSceneUI();
  if (instance.reduced) {
    instance.pipeline.stage = 5;
    instance.pipeline.t = STAGES[5].ms;
    instance.pipeline.playing = false;
  }
  applyPipelineStage();
  renderPipeline();
  updatePlayButton();
}

export function setSystemActive(active) {
  if (!instance) return;
  const next = Boolean(active);
  if (next === instance.active) return;
  instance.active = next;
  instance.root.classList.toggle("is-live", next);
  if (!next) {
    if (instance.root.contains(document.activeElement)) document.activeElement.blur();
    clearSceneAnimations();
    return;
  }
  enterScene(instance.scene);
}

export function refreshSystem() {
  if (!instance) return;
  instance.reduced = Boolean(REDUCED_MQ.matches);
  instance.root.classList.toggle("is-reduced", instance.reduced);
  instance.root.dataset.mode = document.documentElement.dataset.mode || "light";
  updatePlayButton();
}
