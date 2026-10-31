/* 归因调度台：一个程序路由器、四个专业代理、事件驱动、草稿闸门。 */

const PHASES = [
  { id: "input", ms: 1600, live: "输入材料进入；原文与坐标全部保留。" },
  { id: "fields", ms: 2600, agent: 0, live: "字段员逐字段整理；压缩结果由代码拼装。" },
  { id: "components", ms: 3200, agent: 1, live: "组件调查员按调用链分组，逐次核对请求与回执。" },
  { id: "trace", ms: 2200, agent: 2, live: "逐轮摘要员只写摘要；问题由代码原样合并。" },
  { id: "session", ms: 2400, agent: 3, live: "跨轮复核员只查跨轮；单轮会话由代码拼装。" },
  { id: "gate", ms: 3000, live: "草稿闸门依次校验原文、异常处置与剩余影响。" },
  { id: "output", ms: 1800, live: "接受结果立即追加到两份产物。" },
];

const GATE_KIND = {
  input: "输入材料",
  fields: "压缩结构",
  components: "组件问题",
  trace: "逐轮摘要",
  session: "跨轮问题",
  gate: "三张草稿",
  output: "已接受",
  static: "已接受",
};

const EVENTS = [
  ["record", "会话记录", "一行一条"],
  ["trace", "轮次原文", "全部保留"],
  ["call", "调用回执", "逐次配对"],
  ["error", "工具异常", "逐条处置"],
  ["accept", "接受事件", "只此触发"],
];

const FIELDS = ["会话概览", "计划", "推理", "执行", "反思", "异常", "组件", "数据", "产物"];

const ICONS = {
  pause:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7.2" y="5.5" width="3.3" height="13" rx="1.2" fill="currentColor"/><rect x="13.5" y="5.5" width="3.3" height="13" rx="1.2" fill="currentColor"/></svg>',
  play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.1v13.8L18.7 12 8 5.1Z" fill="currentColor"/></svg>',
  clockOff:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M12 7.4V12l3 1.9M4.2 4.2l15.6 15.6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  check:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.6 4.4 4.3L19.2 7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  repair:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5.4 9.3A7.2 7.2 0 1 1 5 13.8M5.4 9.3V5.4m0 3.9H9.3" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

const MQ =
  typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-reduced-motion: reduce)")
    : { matches: false, addEventListener() {} };

let instance = null;
let controller = null;
let raf = 0;

/* ------------------------------------------------------------------ markup */

function fieldMarkup() {
  return FIELDS.map(
    (name, i) =>
      `<span class="sys-field${i === 0 ? " is-session" : ""}" style="--i:${i}">${name}</span>`,
  ).join("");
}

function eventMarkup() {
  return EVENTS.map(
    ([id, name, sub]) =>
      `<div class="sys-event${id === "accept" ? " is-accept" : ""}" data-event="${id}"><i class="sys-event-dot" aria-hidden="true"></i><b>${name}</b><em>${sub}</em></div>`,
  ).join("");
}

function agentOne() {
  return `<div class="sys-agent" role="button" tabindex="0" data-agent="0" aria-label="字段员：压缩开始时逐字段整理，每字段一个独立会话">
      <span class="sys-agent-port" aria-hidden="true">01</span>
      <header><b>字段员</b><em>压缩开始</em></header>
      <div class="sys-agent-body">
        <div class="sys-fields" aria-hidden="true">${fieldMarkup()}</div>
        <div class="sys-agent-tags"><span>每字段 1 会话</span><span>选证据编号</span><span>代码拼装</span><span>终稿程序复制</span></div>
      </div>
      <span class="sys-beam" aria-hidden="true"></span>
    </div>`;
}

function agentTwo() {
  return `<div class="sys-agent" role="button" tabindex="0" data-agent="1" aria-label="组件调查员：压缩接受后按调用链分组，调查工具链与交付">
      <span class="sys-agent-port" aria-hidden="true">02</span>
      <header><b>组件调查员</b><em>压缩接受后分组</em></header>
      <div class="sys-agent-body">
        <div class="sys-groups" aria-hidden="true">
          <div class="sys-group"><span class="sys-group-name">工具链组</span><div class="sys-chain"><span style="--i:0">请求</span><i>→</i><span style="--i:1">工具</span><i>→</i><span style="--i:2">脚本</span><i>→</i><span style="--i:3">技能</span></div></div>
          <div class="sys-group"><span class="sys-group-name">交付组</span><div class="sys-caps"><span style="--i:0">取值</span><span style="--i:1">计算</span><span style="--i:2">推断</span><span style="--i:3">无据</span><span style="--i:4">引用</span><span style="--i:5">指令</span><span class="is-muted" style="--i:6">推理</span><span class="is-muted" style="--i:7">规划</span></div></div>
        </div>
        <div class="sys-agent-tags"><span>按调用链分组</span><span>逐次配对</span><span>正常组返回空</span><span>按最早偏差</span></div>
      </div>
      <span class="sys-beam" aria-hidden="true"></span>
    </div>`;
}

function agentThree() {
  return `<div class="sys-agent" role="button" tabindex="0" data-agent="2" aria-label="逐轮摘要员：组结果齐后只写摘要，问题由代码原样合并">
      <span class="sys-agent-port" aria-hidden="true">03</span>
      <header><b>逐轮摘要员</b><em>组结果齐后</em></header>
      <div class="sys-agent-body">
        <div class="sys-merge" aria-hidden="true">
          <div class="sys-merge-in"><span style="--i:0">问题 1</span><span style="--i:1">问题 2</span><span style="--i:2">问题 3</span></div>
          <i>→</i>
          <div class="sys-merge-out"><b>一句摘要</b><em>问题原样保留</em></div>
        </div>
        <div class="sys-agent-tags"><span>模型只写摘要</span><span>代码合并问题</span><span>覆盖缺口不算缺陷</span></div>
      </div>
      <span class="sys-beam" aria-hidden="true"></span>
    </div>`;
}

function agentFour() {
  return `<div class="sys-agent" role="button" tabindex="0" data-agent="3" aria-label="跨轮复核员：仅在多轮会话中查跨轮问题，单轮由代码拼装">
      <span class="sys-agent-port" aria-hidden="true">04</span>
      <header><b>跨轮复核员</b><em>全部摘要成功后</em></header>
      <div class="sys-agent-body">
        <div class="sys-turns" aria-hidden="true">
          <span class="sys-turn">第 1 轮</span><span class="sys-turn">第 2 轮</span><span class="sys-turn">第 3 轮</span>
          <svg class="sys-turn-arc" viewBox="0 0 220 30" preserveAspectRatio="none"><path d="M8 24C55 2 165 2 212 24"/></svg>
        </div>
        <div class="sys-agent-tags"><span>仅多轮</span><span>只查跨轮</span><span>至少两轮原文</span><span>单轮 0 次模型</span></div>
      </div>
      <span class="sys-beam" aria-hidden="true"></span>
    </div>`;
}

function gateRow(row, draft, original, error, impact, outcome) {
  const draftChips = draft
    .map(([text, tone]) => `<span class="sys-draft-chip is-${tone}"><i aria-hidden="true"></i>${text}</span>`)
    .join("");
  return `<tr data-gate-row="${row}"><th scope="row">${draftChips}</th><td><span class="sys-check is-${original.tone}">${original.icon || ""}${original.text}</span></td><td><span class="sys-check is-${error.tone}">${error.icon || ""}${error.text}</span></td><td><span class="sys-check is-${impact.tone}">${impact.text}</span></td><td><span class="sys-outcome is-${outcome.tone}">${outcome.text}</span></td></tr>`;
}

function gateMarkup() {
  const pass = { icon: ICONS.check, tone: "pass" };
  return `<section class="sys-gate" aria-labelledby="sysGateLabel">
      <header class="sys-gate-head">
        <div class="sys-gate-title"><span class="sys-label" id="sysGateLabel">草稿闸门</span><span class="sys-gate-kind" data-gate-kind>输入材料</span></div>
        <span class="sys-gate-repair">${ICONS.repair}定向修复</span>
      </header>
      <div class="sys-gate-scroll">
        <table class="sys-gate-table">
          <caption class="sys-sr">草稿闸门：原文坐标、异常处置与剩余影响决定问题去处</caption>
          <thead><tr><th scope="col">草稿</th><th scope="col">原文坐标<span>逐字连续 · ≤400 字</span></th><th scope="col">异常处置<span>逐条一次 · 5 选 1</span></th><th scope="col">剩余影响<span>终稿是否采用</span></th><th scope="col">去处</th></tr></thead>
          <tbody>
            ${gateRow(0, [["未恢复·有影响", "impact"], ["已恢复·有影响", "impact"]], { text: "逐字", ...pass }, { text: "逐条", ...pass }, { text: "有", tone: "pass" }, { text: "P0–P3 进入判词", tone: "impact" })}
            ${gateRow(1, [["已恢复·无影响", "process"], ["交付无影响", "process"]], { text: "逐字", ...pass }, { text: "逐条", ...pass }, { text: "无", tone: "pass" }, { text: "P4 过程缺陷", tone: "process" })}
            ${gateRow(2, [["说不清", "unknown"]], { text: "无法确认", tone: "unknown" }, { text: "无法确认", tone: "unknown" }, { text: "不清", tone: "unknown" }, { text: "不生成问题", tone: "unknown" })}
          </tbody>
        </table>
      </div>
    </section>`;
}

function outputMarkup() {
  return `<section class="sys-output" aria-label="落盘产物">
      <div class="sys-reel" data-reel="0">
        <div class="sys-reel-copy"><b>compact.jsonl</b><em>压缩接受即写</em></div>
        <span class="sys-reel-tape" aria-hidden="true"></span>
        <span class="sys-reel-stamp">已接受</span>
      </div>
      <div class="sys-reel" data-reel="1">
        <div class="sys-reel-copy"><b>attribution.jsonl</b><em>会话接受后追加</em></div>
        <span class="sys-reel-tape" aria-hidden="true"></span>
        <span class="sys-reel-stamp">已接受</span>
      </div>
      <div class="sys-output-note"><span>一行一条记录</span><span>追加不覆盖</span><span>任务编号 / 行号 / 来源</span><span>可续跑</span></div>
    </section>`;
}

function pageMarkup() {
  return `<div class="sys-root" data-phase="input" data-playing="1">
    <header class="sys-head">
      <div class="sys-head-title">
        <span class="sys-mark" aria-hidden="true">归</span>
        <span class="sys-head-word">归因调度台</span>
      </div>
      <div class="sys-head-state">
        <span class="sys-pill is-live"><i aria-hidden="true"></i>事件驱动</span>
        <span class="sys-pill is-off">${ICONS.clockOff}无轮询</span>
        <button class="sys-pause" type="button" data-act="pause" aria-label="暂停演示" title="暂停演示">${ICONS.pause}</button>
      </div>
    </header>

    <div class="sys-board">
      <div class="sys-top">
        <section class="sys-pane sys-events" aria-label="输入事件">
          <span class="sys-label">事件源</span>
          <div class="sys-event-list">${eventMarkup()}</div>
          <div class="sys-evidence"><span></span>原文与坐标全部保留</div>
        </section>

        <section class="sys-pane sys-router" aria-label="程序路由器">
          <div class="sys-router-top"><span class="sys-router-index">1</span><div class="sys-router-name"><b>路由器</b><em>程序侧 · 调度与校验</em></div></div>
          <div class="sys-router-duties" aria-label="程序职责"><span>分组</span><span>命名</span><span>回填坐标</span><span>合并问题</span><span>校验</span></div>
          <div class="sys-router-rule"><span>只转已接受</span><span>不轮询</span></div>
          <div class="sys-router-foot">${ICONS.clockOff}<b>0 次轮询</b><em>接受才唤醒</em></div>
          <div class="sys-ports" aria-hidden="true"><span class="sys-port" data-port="0">01</span><span class="sys-port" data-port="1">02</span><span class="sys-port" data-port="2">03</span><span class="sys-port" data-port="3">04</span></div>
        </section>

        <section class="sys-agents" aria-label="四个专业代理">${agentOne()}${agentTwo()}${agentThree()}${agentFour()}</section>
      </div>

      ${gateMarkup()}
      ${outputMarkup()}
    </div>

    <p class="sys-sr">归因调度示意：一条记录的全部轮次进入程序路由器；路由器只在接受事件到达时，唤醒字段员、组件调查员、逐轮摘要员和跨轮复核员。问题草稿在草稿闸门通过原文坐标、异常处置与剩余影响三项校验后，才成为 P0–P3 判词或 P4 过程缺陷；无法确认的草稿不生成问题。压缩接受后立即写 compact.jsonl，会话接受后追加 attribution.jsonl。</p>
    <p class="sys-sr" data-live aria-live="polite"></p>
  </div>`;
}

/* ------------------------------------------------------------------ state */

function currentPhase() {
  return PHASES[instance.phase];
}

function isAgentDone(index, phase) {
  if (phase.id === "gate" || phase.id === "output" || phase.id === "static") return true;
  return phase.agent != null && index < phase.agent;
}

function eventActive(id, phase) {
  if (phase === "input" || phase === "fields") return id === "record" || id === "trace";
  if (phase === "components") return id === "accept" || id === "call" || id === "error";
  if (phase === "gate") return id === "accept" || id === "error";
  return id === "accept";
}

function setGateStep(step, doneAll = false) {
  if (!instance) return;
  const rows = instance.root.querySelectorAll("[data-gate-row]");
  rows.forEach((row, i) => {
    row.classList.toggle("is-on", i <= step);
    row.classList.toggle("is-done", doneAll || i < step);
  });
  instance.gateStep = step;
}

function applyPhase() {
  if (!instance) return;
  const root = instance.root;
  const phase = currentPhase();
  root.dataset.phase = phase.id;
  root.dataset.playing = instance.playing ? "1" : "0";

  root.querySelectorAll(".sys-agent").forEach((el, i) => {
    el.classList.toggle("is-active", phase.agent === i);
    el.classList.toggle("is-done", isAgentDone(i, phase));
  });
  root.querySelectorAll("[data-port]").forEach((el, i) => {
    el.classList.toggle("is-active", phase.agent === i);
    el.classList.toggle("is-done", isAgentDone(i, phase));
  });
  root.querySelectorAll(".sys-event").forEach((el) => {
    el.classList.toggle("is-active", eventActive(el.dataset.event, phase.id));
  });

  const kind = root.querySelector("[data-gate-kind]");
  if (kind) kind.textContent = GATE_KIND[phase.id] || "输入材料";
  root.querySelectorAll("[data-gate-row]").forEach((row) => row.classList.remove("is-on", "is-done"));
  instance.gateStep = -1;
  instance.gateDone = false;
  if (phase.id === "components" || phase.id === "session") setGateStep(0);
  else if (phase.id === "output") setGateStep(2, true);

  const compactWritten = ["fields", "components", "trace", "session", "gate", "output"].includes(phase.id);
  root.querySelectorAll("[data-reel]").forEach((el, i) => {
    el.classList.toggle("is-write", i === 0 ? compactWritten : phase.id === "output");
  });

  const live = root.querySelector("[data-live]");
  if (live) live.textContent = phase.live;
}

function applyStatic() {
  if (!instance) return;
  const root = instance.root;
  root.dataset.phase = "static";
  root.dataset.playing = "0";
  root.querySelectorAll(".sys-agent").forEach((el) => {
    el.classList.remove("is-active");
    el.classList.add("is-done");
  });
  root.querySelectorAll("[data-port]").forEach((el) => {
    el.classList.remove("is-active");
    el.classList.add("is-done");
  });
  root.querySelectorAll(".sys-event").forEach((el) => {
    el.classList.toggle("is-active", el.dataset.event === "accept");
  });
  const kind = root.querySelector("[data-gate-kind]");
  if (kind) kind.textContent = "已接受";
  setGateStep(2, true);
  root.querySelectorAll("[data-reel]").forEach((el) => el.classList.add("is-write"));
  const live = root.querySelector("[data-live]");
  if (live) live.textContent = "静态示意：四个专业代理已完成，草稿闸门已校验，产物已追加。";
}

function updatePlayButton() {
  if (!instance) return;
  const btn = instance.root.querySelector("[data-act='pause']");
  if (!btn) return;
  if (instance.reduced) {
    btn.disabled = true;
    btn.innerHTML = ICONS.play;
    btn.setAttribute("aria-label", "已按系统设置减少动态效果");
    btn.title = "已按系统设置减少动态；可点击专业代理查看阶段";
    return;
  }
  btn.disabled = false;
  btn.innerHTML = instance.playing ? ICONS.pause : ICONS.play;
  const label = instance.playing ? "暂停演示" : "继续演示";
  btn.setAttribute("aria-label", label);
  btn.title = label;
}

/* -------------------------------------------------------------------- loop */

function stop() {
  if (raf) cancelAnimationFrame(raf);
  raf = 0;
}

function start() {
  if (!instance || !instance.active || instance.reduced || !instance.playing || raf) return;
  instance.last = performance.now();
  raf = requestAnimationFrame(tick);
}

function updateGateProgress() {
  const phase = currentPhase();
  if (phase.id !== "gate") return;
  const p = instance.elapsed / phase.ms;
  const step = p < 0.3 ? 0 : p < 0.6 ? 1 : 2;
  if (step !== instance.gateStep) setGateStep(step);
  if (p > 0.92 && !instance.gateDone) {
    setGateStep(2, true);
    instance.gateDone = true;
  }
}

function tick(now) {
  raf = 0;
  if (!instance || !instance.active || instance.reduced || !instance.playing) return;
  const dt = Math.min(80, Math.max(0, now - instance.last));
  instance.last = now;
  instance.elapsed += dt;
  let guard = 0;
  while (instance.elapsed >= currentPhase().ms && guard++ < 8) {
    instance.elapsed -= currentPhase().ms;
    instance.phase = (instance.phase + 1) % PHASES.length;
    applyPhase();
  }
  updateGateProgress();
  raf = requestAnimationFrame(tick);
}

function togglePlay() {
  if (!instance || instance.reduced) return;
  instance.playing = !instance.playing;
  instance.root.dataset.playing = instance.playing ? "1" : "0";
  if (instance.playing) {
    updatePlayButton();
    start();
  } else {
    stop();
    updatePlayButton();
  }
}

function focusAgent(index) {
  if (!instance) return;
  const phase = PHASES.findIndex((item) => item.agent === index);
  if (phase < 0) return;
  instance.playing = false;
  stop();
  instance.phase = phase;
  instance.elapsed = 0;
  applyPhase();
  updatePlayButton();
}

function setReduced(reduced) {
  if (!instance || reduced === instance.reduced) return;
  instance.reduced = reduced;
  instance.root.classList.toggle("is-reduced", reduced);
  if (reduced) {
    stop();
    instance.playing = false;
    applyStatic();
    updatePlayButton();
    return;
  }
  instance.root.dataset.phase = "input";
  instance.phase = 0;
  instance.elapsed = 0;
  instance.playing = true;
  applyPhase();
  updatePlayButton();
  start();
}

function bind() {
  controller = new AbortController();
  const { signal } = controller;
  const root = instance.root;

  root.addEventListener(
    "click",
    (ev) => {
      const agent = ev.target.closest(".sys-agent[data-agent]");
      if (agent) {
        focusAgent(Number(agent.dataset.agent));
        return;
      }
      if (ev.target.closest("[data-act='pause']")) togglePlay();
    },
    { signal },
  );

  root.addEventListener(
    "keydown",
    (ev) => {
      const agent = ev.target.closest(".sys-agent[data-agent]");
      if (!agent || (ev.key !== "Enter" && ev.key !== " ")) return;
      ev.preventDefault();
      focusAgent(Number(agent.dataset.agent));
    },
    { signal },
  );

  document.addEventListener(
    "visibilitychange",
    () => {
      if (!instance) return;
      if (document.hidden) stop();
      else if (instance.active && instance.playing && !instance.reduced) start();
    },
    { signal },
  );

  if (typeof MQ.addEventListener === "function") {
    MQ.addEventListener("change", (ev) => setReduced(Boolean(ev.matches)), { signal });
  }
}

/* --------------------------------------------------------------------- api */

function teardown() {
  stop();
  if (controller) {
    controller.abort();
    controller = null;
  }
  if (instance && instance.root) instance.root.innerHTML = "";
  instance = null;
}

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
    active: false,
    reduced: Boolean(MQ.matches),
    playing: true,
    phase: 0,
    elapsed: 0,
    gateStep: -1,
    gateDone: false,
    last: 0,
  };
  root.classList.toggle("is-reduced", instance.reduced);
  bind();
  if (instance.reduced) {
    instance.playing = false;
    applyStatic();
  } else {
    applyPhase();
  }
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
    stop();
    return;
  }
  start();
}

export function refreshSystem() {
  if (!instance) return;
  setReduced(Boolean(MQ.matches));
}
