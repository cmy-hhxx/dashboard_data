/* 评测体系说明：一条会话如何变成可复核的判词。 */
import { STILL, esc } from "./core.js";

const STAGES = [
  {
    id: "input",
    num: "01",
    name: "输入",
    actor: "程序",
    role: "保留原文",
    summary: "一行一条评测记录，保留全部轮次原文与可回溯坐标。",
    input: "一行一条评测记录；保留该记录的全部 trace、message_pool 与 tool_sets 索引。",
    model: "不调用模型。",
    program: "过滤缺最终回答的记录；恢复池化消息索引；原样透传 meta，不补造上下文。",
    output: "可供后续阶段引用的会话材料与原文坐标。",
    rules: ["缺最终回答整条过滤", "多 trace 共享 session_id 也独立评测", "不按外层计数补内容"],
    note: "证据坐标从这里开始；后续所有 quote 都必须能回到原始消息。",
  },
  {
    id: "compact",
    num: "02",
    name: "压缩",
    actor: "模型 + 程序",
    role: "字段员",
    summary: "每轮 8 个字段各起一个单轮模型会话，程序拼装成 Compact。",
    input: "一场会话的逐轮原文、真实调用记录与组件目录。",
    model: "只提交固定文字槽位和 evidence 整数选号；不写结构、不写来源对象。",
    program: "拼装 8 个字段、复制终稿原文、统计工具调用与报错、把选号解析成 ≤400 字引文。",
    output: "compact.jsonl：session_overview / session_meta / trace_meta / turns。",
    rules: ["每轮 8 字段 + 1 次会话概览", "字段可独立续跑", "Compact 是归因的必需前置"],
    note: "模型只做被允许的局部判断；结构、复制与统计全部由程序完成。",
  },
  {
    id: "components",
    num: "03",
    name: "组件调查",
    actor: "模型 + 程序",
    role: "组件调查员",
    summary: "按调用链分组，逐组调查请求、回执与最终交付。",
    input: "Compact 组件目录；逐次配对的请求/回执；终稿关键数据。",
    model: "逐组核对主体、期间、单位、字段与计算；每条问题选最早出错的能力。",
    program: "按调用链建组、绑定真实组件名、合并问题，并按剩余影响定 P0–P3 / P4。",
    output: "组件问题：证据坐标、责任组件、严重度与理由。",
    rules: ["工具链组与交付组分开调查", "正常组返回空", "组件失败记为覆盖缺口，不算被评对象缺陷"],
    note: "组件存在不证明有错；错误请求定位请求生成者，实现错误定位具体脚本或服务。",
  },
  {
    id: "trace",
    num: "04",
    name: "逐轮摘要",
    actor: "模型 + 程序",
    role: "逐轮摘要员",
    summary: "每轮只写一句摘要；问题由程序原样合并。",
    input: "该轮全部组件问题与组件结论。",
    model: "只写 summary；有标准答案时另写 is_correct / correct_reason。",
    program: "原样合并问题与 meta；无标准时固定 is_correct = null。",
    output: "turn summary + 原样问题列表。",
    rules: ["模型不能增删改问题", "覆盖缺口不转成被评组件缺陷", "部分组件失败时标注覆盖不完整"],
    note: "逐轮摘要失败会阻塞 Session，不能跳过失败轮次生成会话归因。",
  },
  {
    id: "session",
    num: "05",
    name: "跨轮复核",
    actor: "程序 / 模型（仅多轮）",
    role: "跨轮复核员",
    summary: "单轮由代码拼装；多轮只做一次轻量跨轮审查。",
    input: "全部 trace 摘要、问题概要与必要的原始问答。",
    model: "仅多轮：生成 session_summary 与独立跨轮问题；每条至少两轮原文证据。",
    program: "单轮 0 次模型调用；把跨轮问题的 {index, reason} 映射回原文坐标，保留已有 turns。",
    output: "attribution.jsonl 中的 session 判词。",
    rules: ["单轮 0 次模型", "只查跨轮，不重复单轮问题", "至少两轮原文证据"],
    note: "跨轮问题与 turn 问题同形；覆盖缺口不转化为被评组件缺陷。",
  },
  {
    id: "gate",
    num: "06",
    name: "草稿闸门",
    actor: "程序",
    role: "三张草稿",
    summary: "原文坐标、异常处置、剩余影响三项全过，问题才成立。",
    input: "字段草稿、组件问题草稿、逐轮/跨轮草稿。",
    model: "不参与闸门；闸门只做程序校验。",
    program: "逐字核对 ≤400 字原文；每条异常恰好处置一次；确认终稿是否采用。",
    output: "P0–P3 判词 / P4 过程缺陷 / 不生成问题。",
    rules: ["引文必须精确连续", "5 种处置只能选 1 种", "说不清的不生成问题"],
    note: "校验只检查 Schema、字段范围、证据身份与原文坐标，不做语义相似度返工。",
  },
  {
    id: "output",
    num: "07",
    name: "落盘",
    actor: "程序",
    role: "两份产物",
    summary: "压缩接受即写 compact，会话接受后追加 attribution。",
    input: "已接受的问题草稿与 Compact。",
    model: "不参与落盘。",
    program: "立即追加；保留任务 UUID、一基行号与原始来源；支持中断续跑。",
    output: "compact.jsonl → attribution.jsonl。",
    rules: ["只追加、不覆盖", "一行一条记录", "接受提交后立即唤醒下游调度"],
    note: "其他 session 无需等待；已完成工作可复用。",
  },
];

const AGENTS = [
  {
    num: "01",
    name: "字段员",
    phase: "压缩 · Compact",
    role: "把一轮会话拆成 8 个固定字段，并选出可回溯的原文。",
    model: [
      "每轮 8 个字段各起一个独立单轮会话",
      "只提交文字槽位与 evidence 选号",
      "另用一次会话概括用户问题与交付",
    ],
    program: [
      "拼装固定结构、复制终稿、统计工具次数",
      "把选号解析成 ≤400 字原文",
      "校验字段范围与引用身份",
    ],
    output: "Compact 字段",
  },
  {
    num: "02",
    name: "组件调查员",
    phase: "调查 · Components",
    role: "按调用链分组，逐次核对请求、回执与最终交付。",
    model: [
      "逐组调查工具链与交付",
      "配对每次调用与回执",
      "每条异常处置一次，选最早出错的能力",
    ],
    program: [
      "按调用链建组、绑定真实组件名",
      "合并问题、派生 component_family / role",
      "按剩余影响定 P0–P3 / P4",
    ],
    output: "组件问题",
  },
  {
    num: "03",
    name: "逐轮摘要员",
    phase: "汇总 · Trace",
    role: "每轮只写摘要；问题与 meta 原样保留。",
    model: [
      "只写一句 summary",
      "有标准时写 is_correct / correct_reason",
      "不增删改组件问题",
    ],
    program: [
      "原样合并问题与 meta",
      "无标准时固定 is_correct = null",
      "标注覆盖缺口，不转成被评缺陷",
    ],
    output: "逐轮摘要",
  },
  {
    num: "04",
    name: "跨轮复核员",
    phase: "会话 · Session",
    role: "仅在多轮会话查跨轮问题；单轮由代码拼装。",
    model: [
      "一次轻量跨轮审查",
      "生成 session_summary 与跨轮问题",
      "每条跨轮问题至少两轮原文",
    ],
    program: [
      "单轮 0 次模型调用",
      "把 {index, reason} 映射回原文坐标",
      "保留已有 turns，不重复单轮问题",
    ],
    output: "Session 判词",
  },
];

const GATE_CHECKS = [
  {
    tag: "A",
    title: "原文坐标",
    rule: "逐字连续 · ≤400 字",
    text: "引文必须能在原始消息中逐字定位；不能拼接、截断，也不能由模型改写来源对象。",
  },
  {
    tag: "B",
    title: "异常处置",
    rule: "逐条一次 · 5 选 1",
    text: "每条工具异常恰好处置一次；处置方式决定问题是否成立，以及进入哪一档。",
  },
  {
    tag: "C",
    title: "剩余影响",
    rule: "终稿是否采用",
    text: "只按最终交付的已确认影响定级；已补救的问题按残余影响计算，不用异常类型代替影响。",
  },
];

const DISPOSITIONS = [
  {
    code: "unresolved_impact",
    name: "未恢复 · 有影响",
    text: "工具异常未恢复，且仍影响最终交付。",
    outcome: "P0–P3",
    tone: "impact",
  },
  {
    code: "recovered_impact",
    name: "已恢复 · 有影响",
    text: "已恢复，但残余影响仍进入最终交付。",
    outcome: "P0–P3",
    tone: "impact",
  },
  {
    code: "recovered_no_impact",
    name: "已恢复 · 无影响",
    text: "已恢复，且终稿未采用该结果、已用替代来源完成。",
    outcome: "P4",
    tone: "process",
  },
  {
    code: "no_delivery_impact",
    name: "未恢复 · 交付无影响",
    text: "异常未恢复，但最终交付不受影响。",
    outcome: "P4",
    tone: "process",
  },
  {
    code: "uncertain",
    name: "说不清",
    text: "根因或影响无法确认。",
    outcome: "不生成问题",
    tone: "unknown",
  },
];

const SEVERITIES = [
  {
    key: "P0",
    title: "核心结论错误或关键依据虚构",
    text: "整份回答不可采信。",
    use: "进入判词",
  },
  {
    key: "P1",
    title: "重要内容错误或缺失",
    text: "需要实质修改才能使用。",
    use: "进入判词",
  },
  {
    key: "P2",
    title: "局部错误",
    text: "修正后不改变主要结论。",
    use: "进入判词",
  },
  {
    key: "P3",
    title: "已确认的轻微交付影响",
    text: "表达或展示偏差，影响范围有限。",
    use: "进入判词",
  },
  {
    key: "P4",
    title: "过程缺陷，最终交付未受影响",
    text: "终稿未采用、已用替代来源完成，或错误已修正且无残余影响。",
    use: "只保留在报告中",
  },
];

const OUTPUTS = [
  {
    file: "compact.jsonl",
    when: "压缩接受即写",
    text: "一行一条输入记录；先于归因落盘，是归因的必需前置。",
    fields: [
      ["session_overview", "三条文字：问题、调用与报错、回复与交付"],
      ["session_meta", "外层元信息原样透传"],
      ["trace_meta", "各轮 trace 元信息原样透传"],
      ["turns", "8 个固定字段 + 原样最终回复"],
    ],
  },
  {
    file: "attribution.jsonl",
    when: "会话接受后追加",
    text: "一行一条 session；turn 问题与跨轮问题同形，只追加、可续跑。",
    fields: [
      ["session_meta", "原样保留输入元信息"],
      ["turns", "summary / problem / is_correct / correct_reason"],
      ["session_summary", "整场会话总结"],
      ["session_problem", "独立跨轮问题"],
    ],
  },
];

const MYTHS = [
  {
    title: "覆盖缺口 ≠ 被评对象缺陷",
    text: "组件或 trace 失败只说明这一段没评到；报告标注覆盖不完整，不把系统故障算成被评 Agent 的问题。",
  },
  {
    title: "组件存在 ≠ 有错",
    text: "组件目录只定义调查对象；正常组返回空。名称被提及，也不证明它实际执行过。",
  },
  {
    title: "异常 ≠ 问题",
    text: "exit_code=0 或文件保存成功仍要核对实际内容；空表、零行、错误公式都可能没有执行异常。",
  },
  {
    title: "P4 ≠ session 成功",
    text: "同一 session 可以同时有 P4 和 P0–P3。P4 不参与 Comparison 判胜，也不进入聚类身份。",
  },
  {
    title: "无标准 ≠ 判错",
    text: "没有标准答案时 is_correct 固定为 null，程序写入说明；问题归因仍独立成立。",
  },
  {
    title: "跨轮 ≠ 重复单轮",
    text: "跨轮问题必须至少有两轮原文证据，且不能重复单轮已经记录的问题。",
  },
];

const CONTRACT = `{
  "session_meta": {},
  "turns": [
    {
      "meta": {},
      "summary": "",
      "problem": [],
      "is_correct": 1,
      "correct_reason": ""
    }
  ],
  "session_summary": "",
  "session_problem": []
}`;

const PROBLEM_EXAMPLE = `{
  "component": "finquery 取数服务",
  "component_family": "finquery",
  "component_role": "tool",
  "label": "零行结果未识别",
  "definition": "应返回数据的查询返回零行，后续仍据此形成事实结论。",
  "problem_phenomena": "第一问把零行取数结果当成有数据支持。",
  "reason": "工具请求查询 X，原始返回为零行，下一轮仍给出肯定结论。",
  "severity": "P1",
  "severity_reason": "重要结论缺少数据支持，需要重新取数核对后才能使用。",
  "evidence": [
    {
      "position": "trace_index 0 / message_index 3 / path /output/0/text",
      "component": "tool_call: finquery 取数服务",
      "quote": "为您找到0条数据",
      "reason": "证明工具返回零行。"
    }
  ],
  "calculations": []
}`;

const ICONS = {
  play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.2v13.6L18.8 12 8 5.2Z" fill="currentColor"/></svg>',
  pause:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7.2" y="5.4" width="3.4" height="13.2" rx="1.2" fill="currentColor"/><rect x="13.4" y="5.4" width="3.4" height="13.2" rx="1.2" fill="currentColor"/></svg>',
};

const MQ =
  typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-reduced-motion: reduce)")
    : { matches: false, addEventListener() {} };

let instance = null;

/* ------------------------------------------------------------------ markup */

function stageTabs(active) {
  return STAGES.map((stage) => {
    const on = stage.id === active;
    return `<button type="button" class="sys-stage" id="sysStageTab-${stage.id}" role="tab" aria-selected="${on}" aria-controls="sysStagePanel" tabindex="${on ? 0 : -1}" data-stage="${stage.id}">
      <span class="sys-stage-num">${stage.num}</span>
      <span class="sys-stage-name">${stage.name}</span>
      <span class="sys-stage-actor">${stage.actor}</span>
    </button>`;
  }).join("");
}

function stagePanel(stage) {
  return `<div class="sys-stage-head">
      <span class="sys-stage-code">${stage.num}</span>
      <div class="sys-stage-title">
        <h3>${stage.name}</h3>
        <p>${stage.role}</p>
      </div>
      <span class="sys-stage-badge">${stage.actor}</span>
    </div>
    <p class="sys-stage-summary">${stage.summary}</p>
    <div class="sys-stage-grid">
      <div class="sys-cell"><span class="sys-term">输入</span><p>${stage.input}</p></div>
      <div class="sys-cell is-model"><span class="sys-term">模型写</span><p>${stage.model}</p></div>
      <div class="sys-cell is-program"><span class="sys-term">程序做</span><p>${stage.program}</p></div>
      <div class="sys-cell"><span class="sys-term">输出</span><p>${stage.output}</p></div>
    </div>
    <ul class="sys-rules">${stage.rules.map((rule) => `<li>${esc(rule)}</li>`).join("")}</ul>
    <p class="sys-stage-note">${stage.note}</p>`;
}

function agentCard(agent) {
  const item = (text) => `<li>${esc(text)}</li>`;
  return `<article class="sys-agent-card">
    <header class="sys-agent-head">
      <span class="sys-agent-num">${agent.num}</span>
      <div><h3>${agent.name}</h3><p>${agent.phase}</p></div>
    </header>
    <p class="sys-agent-role">${agent.role}</p>
    <div class="sys-agent-split">
      <div><span class="sys-term">模型</span><ul>${agent.model.map(item).join("")}</ul></div>
      <div><span class="sys-term">程序</span><ul>${agent.program.map(item).join("")}</ul></div>
    </div>
    <footer class="sys-agent-foot"><span class="sys-term">产出</span><b>${agent.output}</b></footer>
  </article>`;
}

function gateCheck(check) {
  return `<article class="sys-check-card">
    <span class="sys-check-tag">${check.tag}</span>
    <h3>${check.title}</h3>
    <p class="sys-check-rule">${check.rule}</p>
    <p class="sys-check-text">${check.text}</p>
  </article>`;
}

function dispositionRow(item) {
  return `<div class="sys-disposition is-${item.tone}">
    <div class="sys-disp-name"><code>${item.code}</code><b>${item.name}</b></div>
    <p>${item.text}</p>
    <span class="sys-disp-outcome">${item.outcome}</span>
  </div>`;
}

function severityRow(item) {
  return `<div class="sys-sev-row">
    <span class="sys-sev-pill" style="--sev:var(--sev-${item.key.slice(1)})"><i aria-hidden="true"></i>${item.key}</span>
    <b>${item.title}</b>
    <p>${item.text}</p>
    <span class="sys-sev-use">${item.use}</span>
  </div>`;
}

function outputCard(out) {
  return `<article class="sys-file-card">
    <header><code>${out.file}</code><span>${out.when}</span></header>
    <p>${out.text}</p>
    <dl>${out.fields
      .map(([key, text]) => `<div><dt><code>${key}</code></dt><dd>${text}</dd></div>`)
      .join("")}</dl>
  </article>`;
}

function mythCard(item) {
  return `<div class="sys-myth">
    <span class="sys-myth-mark" aria-hidden="true">≠</span>
    <div><b>${item.title}</b><p>${item.text}</p></div>
  </div>`;
}

function pageMarkup(active) {
  return `<div class="sys-page">
    <header class="sys-hero">
      <p class="sys-overline">评测体系 · 归因调度</p>
      <h1 class="sys-title">一条会话，如何变成可复核的判词</h1>
      <p class="sys-lead">程序路由器只负责调度与校验；四个专业代理各管一段；模型只写被允许的字段，结构、统计与合并由代码完成。每条问题都必须落在原文坐标上，再由闸门决定它是 P0–P3、P4，还是不生成。</p>
      <ul class="sys-facts">
        <li><b>4</b><span>个专业代理</span></li>
        <li><b>7</b><span>个阶段</span></li>
        <li><b>2</b><span>份 JSONL 产物</span></li>
        <li><b>0</b><span>次轮询</span></li>
      </ul>
    </header>

    <nav class="sys-toc" aria-label="页面目录">
      <a href="#sys-flow">流程</a>
      <a href="#sys-agents">分工</a>
      <a href="#sys-gate">闸门</a>
      <a href="#sys-severity">严重度</a>
      <a href="#sys-output">产物</a>
      <a href="#sys-boundary">边界</a>
      <a href="#sys-contract">契约</a>
    </nav>

    <section class="sys-section" id="sys-flow" aria-labelledby="sysFlowTitle">
      <header class="sys-section-head">
        <span class="sys-section-num">01</span>
        <div class="sys-section-title">
          <h2 id="sysFlowTitle">流程总览</h2>
          <p>七个阶段，两次接受事件。点击任一阶段查看模型与程序各自做什么；播放只演示一次，播完即停。</p>
        </div>
        <div class="sys-section-tools">
          <span class="sys-play-hint" data-play-hint>点击阶段查看细节</span>
          <button class="sys-play" type="button" data-act="play" aria-pressed="false">${ICONS.play}<span>播放流程</span></button>
        </div>
      </header>
      <div class="sys-flow" role="tablist" aria-label="归因流程阶段">${stageTabs(active)}</div>
      <div class="sys-stage-panel" id="sysStagePanel" role="tabpanel" aria-labelledby="sysStageTab-${active}" tabindex="0"></div>
    </section>

    <section class="sys-section" id="sys-agents" aria-labelledby="sysAgentsTitle">
      <header class="sys-section-head">
        <span class="sys-section-num">02</span>
        <div class="sys-section-title">
          <h2 id="sysAgentsTitle">四个专业代理</h2>
          <p>四个代理不是四个自由发挥的 Agent。每个代理只负责一段判断，其余由程序拼装、绑定和校验。</p>
        </div>
      </header>
      <div class="sys-agents">${AGENTS.map(agentCard).join("")}</div>
    </section>

    <section class="sys-section" id="sys-gate" aria-labelledby="sysGateTitle">
      <header class="sys-section-head">
        <span class="sys-section-num">03</span>
        <div class="sys-section-title">
          <h2 id="sysGateTitle">草稿闸门</h2>
          <p>不是所有异常都成为问题。三张草稿必须同时通过三项检查，才决定一条记录的去处。</p>
        </div>
      </header>
      <div class="sys-checks">${GATE_CHECKS.map(gateCheck).join("")}</div>
      <div class="sys-dispositions">${DISPOSITIONS.map(dispositionRow).join("")}</div>
      <p class="sys-section-note">异常处置不是问题白名单：即使工具成功返回，也要核对实际内容、公式、单位与验收结果；已恢复且无残余影响的异常只记 P4。</p>
    </section>

    <section class="sys-section" id="sys-severity" aria-labelledby="sysSeverityTitle">
      <header class="sys-section-head">
        <span class="sys-section-num">04</span>
        <div class="sys-section-title">
          <h2 id="sysSeverityTitle">严重度 P0–P4</h2>
          <p>按本次已确认的最终交付影响判定，不按工具异常类型、修复难度或发生次数。</p>
        </div>
      </header>
      <div class="sys-severities">${SEVERITIES.map(severityRow).join("")}</div>
      <p class="sys-section-note">P4 只表示过程缺陷，不代表 session 成功；同一 session 可以同时有 P4 与 P0–P3。P4 不参与 Comparison 判胜或聚类身份。</p>
    </section>

    <section class="sys-section" id="sys-output" aria-labelledby="sysOutputTitle">
      <header class="sys-section-head">
        <span class="sys-section-num">05</span>
        <div class="sys-section-title">
          <h2 id="sysOutputTitle">产物与续跑</h2>
          <p>两份 JSONL 只追加、不覆盖。Compact 是归因的必需前置；已完成的工作可以续跑复用。</p>
        </div>
      </header>
      <div class="sys-files">${OUTPUTS.map(outputCard).join("")}</div>
      <ul class="sys-output-rules">
        <li><b>只追加</b><span>不覆盖已接受记录</span></li>
        <li><b>可追溯</b><span>任务 UUID · 一基行号 · 原始来源</span></li>
        <li><b>先压缩</b><span>Compact 接受后立即落盘</span></li>
        <li><b>可续跑</b><span>复用已完成的字段与归因</span></li>
      </ul>
    </section>

    <section class="sys-section" id="sys-boundary" aria-labelledby="sysBoundaryTitle">
      <header class="sys-section-head">
        <span class="sys-section-num">06</span>
        <div class="sys-section-title">
          <h2 id="sysBoundaryTitle">边界与常见误解</h2>
          <p>这些边界决定了报告里为什么有的异常没有变成问题，以及 P4 为什么不能当作成功。</p>
        </div>
      </header>
      <div class="sys-myths">${MYTHS.map(mythCard).join("")}</div>
    </section>

    <section class="sys-section" id="sys-contract" aria-labelledby="sysContractTitle">
      <header class="sys-section-head">
        <span class="sys-section-num">07</span>
        <div class="sys-section-title">
          <h2 id="sysContractTitle">正式契约</h2>
          <p>一行一条 session 的顶层结构，以及一条问题对象的完整形状；完整字段以 Schema 为准。</p>
        </div>
      </header>
      <details class="sys-details">
        <summary>展开 Session 契约<span>session_meta / turns / session_summary / session_problem</span></summary>
        <pre class="sys-code"><code>${esc(CONTRACT)}</code></pre>
      </details>
      <details class="sys-details">
        <summary>展开 Problem 示例<span>证据坐标、责任组件、严重度与理由</span></summary>
        <pre class="sys-code"><code>${esc(PROBLEM_EXAMPLE)}</code></pre>
      </details>
    </section>

    <footer class="sys-footer">
      <p>口径来自 eval_agent_harness：<code>docs/attribution.md</code> · <code>docs/schema-fields.md</code> · <code>packages/prompts/resources/attribution/problem-output.md</code></p>
      <p>页面更新 2026-11-01 · 数据视图与样本视图在顶部导航切换</p>
    </footer>
  </div>`;
}

/* ------------------------------------------------------------------- state */

function updateUrl(stageId) {
  try {
    const url = new URL(location.href);
    if (url.searchParams.get("view") !== "system") return;
    url.searchParams.set("stage", stageId);
    history.replaceState(null, "", url);
  } catch (e) {}
}

function selectStage(stageId, opts = {}) {
  if (!instance) return;
  const stage = STAGES.find((item) => item.id === stageId) || STAGES[0];
  instance.stage = stage.id;
  const root = instance.root;
  root.querySelectorAll("[data-stage]").forEach((tab) => {
    const on = tab.dataset.stage === stage.id;
    tab.classList.toggle("is-active", on);
    tab.setAttribute("aria-selected", String(on));
    tab.tabIndex = on ? 0 : -1;
  });
  const panel = root.querySelector("#sysStagePanel");
  if (panel) {
    panel.innerHTML = stagePanel(stage);
    panel.setAttribute("aria-labelledby", `sysStageTab-${stage.id}`);
  }
  if (opts.focus) {
    const tab = root.querySelector(`[data-stage="${stage.id}"]`);
    if (tab) tab.focus();
  }
  if (opts.url !== false) updateUrl(stage.id);
}

function updatePlayButton() {
  if (!instance) return;
  const btn = instance.root.querySelector("[data-act='play']");
  const hint = instance.root.querySelector("[data-play-hint]");
  if (!btn) return;
  const reduced = instance.reduced;
  btn.hidden = reduced;
  if (reduced) {
    if (hint) hint.textContent = "已按系统设置减少动态；点击阶段查看细节";
    return;
  }
  const label = instance.playing ? "暂停演示" : instance.finished ? "重播流程" : "播放流程";
  btn.innerHTML = `${instance.playing ? ICONS.pause : ICONS.play}<span>${label}</span>`;
  btn.setAttribute("aria-pressed", String(instance.playing));
  btn.setAttribute("aria-label", label);
  if (hint) hint.textContent = instance.playing ? "正在按顺序演示" : "点击阶段查看细节";
}

function stopPlay(finished) {
  if (!instance) return;
  if (instance.timer) {
    clearTimeout(instance.timer);
    instance.timer = 0;
  }
  instance.playing = false;
  if (finished) instance.finished = true;
  updatePlayButton();
}

function stepThrough(index) {
  if (!instance || !instance.playing) return;
  if (index >= STAGES.length) {
    instance.timer = setTimeout(() => stopPlay(true), 1100);
    return;
  }
  selectStage(STAGES[index].id, { url: true });
  instance.timer = setTimeout(() => stepThrough(index + 1), 1500);
}

function togglePlay() {
  if (!instance || instance.reduced) return;
  if (instance.playing) {
    stopPlay(false);
    return;
  }
  instance.playing = true;
  instance.finished = false;
  updatePlayButton();
  const start = STAGES.findIndex((stage) => stage.id === instance.stage);
  stepThrough(start >= STAGES.length - 1 ? 0 : Math.max(0, start));
}

function applyReduced(reduced) {
  if (!instance) return;
  instance.reduced = Boolean(reduced);
  instance.root.classList.toggle("is-reduced", instance.reduced);
  if (instance.reduced) stopPlay(false);
  updatePlayButton();
}

/* -------------------------------------------------------------------- bind */

function bind() {
  const controller = new AbortController();
  instance.controller = controller;
  const { signal } = controller;
  const root = instance.root;

  root.addEventListener(
    "click",
    (event) => {
      const tab = event.target.closest("[data-stage]");
      if (tab) {
        stopPlay(false);
        selectStage(tab.dataset.stage, { url: true });
        return;
      }
      if (event.target.closest("[data-act='play']")) togglePlay();
    },
    { signal },
  );

  root.addEventListener(
    "keydown",
    (event) => {
      const tab = event.target.closest("[data-stage]");
      if (!tab) return;
      const current = STAGES.findIndex((stage) => stage.id === tab.dataset.stage);
      let next = current;
      if (event.key === "ArrowRight" || event.key === "ArrowDown") next = (current + 1) % STAGES.length;
      else if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = (current - 1 + STAGES.length) % STAGES.length;
      else if (event.key === "Home") next = 0;
      else if (event.key === "End") next = STAGES.length - 1;
      else return;
      event.preventDefault();
      stopPlay(false);
      selectStage(STAGES[next].id, { focus: true, url: true });
    },
    { signal },
  );

  document.addEventListener(
    "visibilitychange",
    () => {
      if (document.hidden) stopPlay(false);
    },
    { signal },
  );

  if (typeof MQ.addEventListener === "function") {
    MQ.addEventListener("change", (event) => applyReduced(STILL || event.matches), { signal });
  }

  const tocLinks = Array.from(root.querySelectorAll(".sys-toc a"));
  if (tocLinks.length) {
    const sections = Array.from(root.querySelectorAll(".sys-section"));
    const syncToc = () => {
      instance.tocFrame = 0;
      let current = sections[0];
      for (const section of sections) {
        if (section.getBoundingClientRect().top <= 160) current = section;
      }
      tocLinks.forEach((link) => {
        const on = current && link.getAttribute("href") === `#${current.id}`;
        link.classList.toggle("is-active", Boolean(on));
        if (on) link.setAttribute("aria-current", "location");
        else link.removeAttribute("aria-current");
      });
    };
    const onScroll = () => {
      if (instance.tocFrame) return;
      instance.tocFrame = requestAnimationFrame(syncToc);
    };
    const scroller = root.closest(".view--system");
    window.addEventListener("scroll", onScroll, { passive: true, signal });
    if (scroller) scroller.addEventListener("scroll", onScroll, { passive: true, signal });
    syncToc();
  }
}

/* --------------------------------------------------------------------- api */

function teardown() {
  if (instance) {
    if (instance.timer) clearTimeout(instance.timer);
    if (instance.tocFrame) cancelAnimationFrame(instance.tocFrame);
    if (instance.controller) instance.controller.abort();
    if (instance.root) instance.root.innerHTML = "";
  }
  instance = null;
}

export function initSystem(root) {
  teardown();
  if (!root) return;
  const initial =
    (() => {
      try {
        return new URLSearchParams(location.search).get("stage") || "input";
      } catch (e) {
        return "input";
      }
    })() || "input";
  const active = STAGES.some((stage) => stage.id === initial) ? initial : "input";
  root.innerHTML = pageMarkup(active);
  instance = {
    root,
    stage: active,
    active: false,
    reduced: Boolean(STILL || MQ.matches),
    playing: false,
    finished: false,
    timer: 0,
    tocFrame: 0,
    controller: null,
  };
  root.classList.toggle("is-reduced", instance.reduced);
  bind();
  selectStage(active, { url: false });
  updatePlayButton();
}

export function setSystemActive(active) {
  if (!instance) return;
  instance.active = Boolean(active);
  if (!instance.active) stopPlay(false);
}

export function refreshSystem() {
  /* 说明页是静态内容；主题切换只需要 CSS token，不重建 DOM。 */
}
