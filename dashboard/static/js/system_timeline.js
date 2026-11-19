/* 归因时序: embedded in the 评测体系 page after 证据闭环.
   01 单条时间线 — a Gantt that plays itself once it scrolls into view, a five-step stepper that
      fills in sync with the playhead, a failure simulation and one plain-language focus panel.
   02 整批调度 — a 16-conversation simulation whose bars grow with the playhead.
   Every label is plain Chinese: no stage ids, file paths or command-line flags. */
import { $, $$, segmented, REDUCED } from "./core.js";

const NS = "http://www.w3.org/2000/svg";
const VB_W = 1200;

const FIELDS = [
  { key: "session_overview", label: "整场概览", dur: 4, session: true },
  { key: "plans", label: "计划", dur: 4 },
  { key: "reasoning_chain", label: "推理链", dur: 6 },
  { key: "execution_chain", label: "执行链", dur: 14, toolOnly: true },
  { key: "reflections", label: "反思", dur: 4 },
  { key: "tool_errors", label: "工具报错", dur: 5, toolOnly: true },
  { key: "components", label: "组件", dur: 18 },
  { key: "key_data", label: "关键数据", dur: 6 },
  { key: "artifacts", label: "产物", dur: 4 },
];
const GROUP_DUR = [30, 38, 26, 42];
const DELIVERY_DUR = 36;
const REWORK = { reject: 34, end: 70 };
const TRACE_DUR = 5;

const STEPS = [
  { sec: "field", title: "逐项摘要", who: "模型" },
  { sec: "compact", title: "拼装验收", who: "程序" },
  { sec: "group", title: "组件调查", who: "模型" },
  { sec: "trace", title: "写小结", who: "模型" },
  { sec: "session", title: "组装成行", who: "程序" },
];

const clamp = (v, min, max) => (v < min ? min : v > max ? max : v);
const fmtSec = (s) => `${Math.round(s)} s`;

function svg(tag, attrs) {
  const node = document.createElementNS(NS, tag);
  if (attrs) {
    Object.entries(attrs).forEach(([k, v]) => {
      if (v != null) node.setAttribute(k, String(v));
    });
  }
  return node;
}
function add(parent, tag, attrs, text) {
  const node = svg(tag, attrs);
  if (text != null) node.textContent = String(text);
  parent.appendChild(node);
  return node;
}

const PLAY_SVG = `<svg class="i-play" viewBox="0 0 16 16" aria-hidden="true"><path d="M5 3.5v9l7-4.5z" fill="currentColor"/></svg><svg class="i-pause" viewBox="0 0 16 16" aria-hidden="true"><path d="M5 3.5h2v9H5zM9 3.5h2v9H9z" fill="currentColor"/></svg>`;

export function timelineCardHTML() {
  return `<article class="card tl-card" id="tlCard" style="--span:12" aria-label="归因时序">
    <header class="card-head"><h2>归因时序</h2></header>

    <div class="tl-sections">
      <section class="tl-sec" aria-label="单条时间线">
        <div class="tl-subhead">
          <h3><span class="tl-num num">01</span>单条时间线</h3>
          <div class="tl-end">
            <div class="seg" id="tl-lens-seg" role="group" aria-label="视角">
              <span class="seg-knob" aria-hidden="true"></span>
              <button type="button" data-value="time" aria-pressed="true">看时序</button>
              <button type="button" data-value="fail" aria-pressed="false">模拟失败</button>
            </div>
            <div class="tl-step"><span class="tl-step-k">调查组</span><button type="button" id="tl-g-dec" aria-label="减少调查组">−</button><b class="num" id="tl-v-g">2</b><button type="button" id="tl-g-inc" aria-label="增加调查组">+</button></div>
            <button class="tl-pill" id="tl-notool" type="button" aria-pressed="false">没调工具</button>
            <button class="tl-pill" id="tl-rework" type="button" aria-pressed="false">提交被退回</button>
            <button class="tl-play" id="tl-c-play" type="button" aria-pressed="false" aria-label="播放">${PLAY_SVG}</button>
          </div>
        </div>

        <ol class="tl-pipe" id="tl-pipe" aria-label="五个步骤">${STEPS.map((s, i) => `<li class="tl-pipe-step${s.who === "程序" ? " is-code" : ""}" data-sec="${s.sec}" style="--p:0">
          <span class="tl-pipe-n num">${i + 1}</span>
          <span class="tl-pipe-t"><b>${s.title}</b><em>${s.who}</em></span>
          <i class="tl-pipe-bar" aria-hidden="true"></i>
        </li>`).join("")}</ol>

        <div class="tl-canvas-wrap" id="tl-c-wrap"><svg class="tl-canvas" id="tl-c-canvas" role="img" aria-label="一条对话的时间线：逐项摘要、拼装验收、组件调查、写小结、组装成行"></svg></div>

        <div class="tl-legend">
          <span class="tl-lg"><i class="tl-sw model"></i>模型已执行</span>
          <span class="tl-lg"><i class="tl-sw later"></i>待执行</span>
          <span class="tl-lg"><i class="tl-sw code"></i>本地程序处理</span>
          <span class="tl-lg"><i class="tl-sw file"></i>落盘产出文件</span>
          <span class="tl-lg"><i class="tl-sw gate"></i>阶段汇聚点</span>
          <span class="tl-lg"><i class="tl-sw fail"></i>执行失败</span>
          <span class="tl-lg"><i class="tl-sw blocked"></i>前置失败已跳过</span>
        </div>

        <div class="tl-focus" id="tl-focus" aria-live="polite"></div>
      </section>

      <section class="tl-sec" aria-label="整批调度">
        <div class="tl-subhead">
          <h3><span class="tl-num num">02</span>整批调度</h3>
          <div class="tl-end">
            <div class="tl-step"><span class="tl-step-k">同时处理</span><button type="button" data-tl-g="conc" data-d="-1" aria-label="减少同时处理的对话">−</button><b class="num" id="tl-v-conc">6</b><button type="button" data-tl-g="conc" data-d="1" aria-label="增加同时处理的对话">+</button></div>
            <div class="tl-step"><span class="tl-step-k">请求上限</span><button type="button" data-tl-g="req" data-d="-2" aria-label="降低请求上限">−</button><b class="num" id="tl-v-req">12</b><button type="button" data-tl-g="req" data-d="2" aria-label="提高请求上限">+</button></div>
            <button class="tl-play" id="tl-g-play" type="button" aria-pressed="false" aria-label="播放">${PLAY_SVG}</button>
          </div>
        </div>

        <div class="tl-stats" id="tl-stats">
          <div class="tl-stat"><span>整批用时</span><b class="num" data-stat="end">—</b></div>
          <div class="tl-stat"><span>已写完</span><b class="num" data-stat="done">—</b></div>
          <div class="tl-stat"><span>请求峰值</span><b class="num" data-stat="peak">—</b></div>
        </div>

        <div class="tl-canvas-wrap" id="tl-g-wrap"><svg class="tl-canvas" id="tl-g-canvas" role="img" aria-label="一批对话的排队情况：每条对话的等待、逐项摘要、组件调查与写完时刻"></svg></div>

        <div class="tl-legend">
          <span class="tl-lg"><i class="tl-sw wait"></i>排队等待</span>
          <span class="tl-lg"><i class="tl-sw compact"></i>逐项摘要</span>
          <span class="tl-lg"><i class="tl-sw model"></i>组件调查与小结</span>
          <span class="tl-lg"><i class="tl-sw end"></i>完成落盘</span>
        </div>
      </section>
    </div>
  </article>`;
}

export function wireTimeline(root) {
  const host = $("#tlCard", root);
  if (!host) return;
  if (host._tlCleanup) host._tlCleanup();

  const still = REDUCED || document.documentElement.hasAttribute("data-still");
  const S = { lens: "time", g: 2, noTool: false, rework: false, fail: null, sel: "f:components", t: 0, playing: false };
  const G = { total: 16, conc: 6, req: 12, play: false, t: 0, data: null };
  let rafC = 0;
  let rafG = 0;

  function setPlay(button, on) {
    if (!button) return;
    button.setAttribute("aria-pressed", String(on));
    button.setAttribute("aria-label", on ? "暂停" : "播放");
    button.classList.toggle("is-on", on);
  }

  function plan() {
    const rows = [];
    let compactAt = 0;
    FIELDS.forEach((field) => {
      const skipped = S.noTool && field.toolOnly;
      const dur = skipped ? 0 : field.dur;
      compactAt = Math.max(compactAt, dur);
      rows.push({ id: `f:${field.key}`, sec: "field", kind: skipped ? "skip" : "model", label: field.label, start: 0, end: dur, field });
    });
    rows.push({ id: "compact", sec: "compact", kind: "code", label: "拼装验收", start: compactAt, end: compactAt });
    const groups = [];
    const g = S.noTool ? 0 : S.g;
    for (let i = 0; i < g; i++) groups.push({ id: `g:${i}`, label: `调查组 ${i + 1}`, dur: GROUP_DUR[i], n: i + 1 });
    groups.push({ id: "g:delivery", label: "交付组", dur: DELIVERY_DUR, delivery: true });
    let settleAt = compactAt;
    groups.forEach((group) => {
      const rework = S.rework && group.delivery;
      const end = compactAt + (rework ? REWORK.end : group.dur);
      settleAt = Math.max(settleAt, end);
      rows.push({ id: group.id, sec: "group", kind: "model", label: group.label, start: compactAt, end, group, rework: rework ? compactAt + REWORK.reject : null, waitFrom: 0 });
    });
    rows.push({ id: "trace", sec: "trace", kind: "model", label: "写小结", start: settleAt, end: settleAt + TRACE_DUR, waitFrom: 0 });
    const doneAt = settleAt + TRACE_DUR;
    rows.push({ id: "session", sec: "session", kind: "code", label: "组装成行", start: doneAt, end: doneAt });
    return { rows, compactAt, settleAt, doneAt, groups: groups.length };
  }

  function statusOf(row) {
    const f = S.fail;
    if (!f) return "ok";
    if (row.id === f) return "fail";
    const fieldFail = f.startsWith("f:");
    if (fieldFail && row.sec !== "field") return "blocked";
    if (fieldFail && row.id === "file:compact") return "blocked";
    if (f.startsWith("g:") && row.id === "trace") return "gap";
    if (f === "trace" && (row.id === "session" || row.id === "file:attr")) return "blocked";
    return "ok";
  }

  const SECTIONS = {
    field: { title: "① 逐项摘要", note: () => `模型 · ${S.noTool ? "7 项同时写，另 2 项没调工具直接留空" : "9 项同时写"} · 不用工具` },
    compact: { title: "② 拼装验收", note: () => "程序 · 每项交回就检查，全部通过后拼成压缩稿" },
    group: { title: "③ 组件调查", note: (P) => `模型 · ${P.groups} 组同时深查 · 可翻原文、看图、算数 · 每组最多提交 4 次` },
    trace: { title: "④ 写小结", note: () => "模型 · 一段话总结，问题清单由程序合并" },
    session: { title: "⑤ 组装成行", note: () => "程序 · 组装成最终的归因结果" },
  };

  const cBoard = { root: $("#tl-c-canvas", host), P: null, geo: null, playhead: null, rowNodes: {}, gates: [], ranges: {} };

  function caseGeo(P) {
    const L = 168;
    const R = VB_W - 16;
    const tmax = Math.ceil((P.doneAt * 1.12 + 4) / 10) * 10;
    return { L, R, tmax, x: (t) => L + ((R - L) * t) / tmax };
  }

  function pick(id) {
    if (S.lens === "fail") {
      const row = cBoard.rowNodes[id]?.row;
      if (row && row.kind === "model") S.fail = S.fail === id ? null : id;
    }
    S.sel = id;
    refreshCase();
    syncFocus();
  }

  function drawRow(layer, row, y, rowH, geo) {
    const node = add(layer, "g", { class: "row", tabindex: "0", role: "button", "aria-label": row.label });
    cBoard.rowNodes[row.id] = { node, row };
    add(node, "rect", { x: 0, y, width: VB_W, height: rowH, rx: 6, class: "row-hit" });
    add(node, "text", { x: 24, y: y + 15, class: "row-label" }, row.label);
    const midY = y + rowH / 2;
    if (row.waitFrom !== undefined && row.start > 0) {
      add(node, "line", { x1: geo.x(row.waitFrom), y1: midY, x2: geo.x(row.start) - 2, y2: midY, class: "wait-line" });
    }
    if (row.kind === "model") {
      const x0 = geo.x(row.start);
      const x1 = geo.x(row.end);
      add(node, "rect", { x: x0, y: midY - 6, width: Math.max(3, x1 - x0), height: 12, rx: 6, class: "bar-model" });
      row._done = add(node, "rect", { x: x0, y: midY - 6, width: 0, height: 12, rx: 6, class: "bar-model-done" });
      if (row.sec === "group") {
        const firstEnd = row.rework !== null ? row.rework : row.end;
        [0.15, 0.32, 0.5, 0.68].forEach((f) => {
          const tx = geo.x(row.start + (firstEnd - row.start) * f * 0.92);
          add(node, "line", { x1: tx, y1: midY - 6, x2: tx, y2: midY + 6, class: "bar-tick" });
        });
        if (row.rework !== null) {
          const rx = geo.x(row.rework);
          add(node, "line", { x1: rx, y1: midY - 9, x2: rx, y2: midY + 9, class: "bar-reject" });
          add(node, "text", { x: geo.x(row.end) + 44, y: y + 15, class: "reject-label" }, "第 1 次提交被退回，多给 3 次查询额度重查");
          [0.2, 0.42, 0.64].forEach((f) => {
            const tx = geo.x(row.rework + (row.end - row.rework) * f);
            add(node, "line", { x1: tx, y1: midY - 6, x2: tx, y2: midY + 6, class: "bar-tick" });
          });
        }
      }
      add(node, "text", { x: x1 + 8, y: y + 15, class: "dur" }, fmtSec(row.end - row.start));
    } else if (row.kind === "skip") {
      const sx = geo.x(0);
      add(node, "path", { d: `M${sx},${midY - 5} l5,5 l-5,5 l-5,-5 z`, class: "code-mark" });
      add(node, "text", { x: sx + 12, y: y + 15, class: "skip-label" }, "没调工具，这一项直接留空");
    } else {
      const cx = geo.x(row.start);
      add(node, "path", { d: `M${cx},${midY - 6} l6,6 l-6,6 l-6,-6 z`, class: "code-mark" });
      const isCompact = row.id === "compact";
      add(node, "text", { x: cx + 12, y: y + 15, class: "code-label" }, isCompact ? "程序拼装，不调模型" : "程序组装，不调模型");
      const file = isCompact ? { id: "file:compact", name: "写出压缩稿" } : { id: "file:attr", name: "写出归因结果" };
      const fnode = add(layer, "g", { class: "row" });
      cBoard.rowNodes[file.id] = { node: fnode, row: { id: file.id }, passive: true };
      if (isCompact) {
        const fx = cx + 150;
        add(fnode, "rect", { x: fx, y: midY - 7, width: 10, height: 13, rx: 2, class: "file-mark" });
        add(fnode, "text", { x: fx + 16, y: y + 15, class: "file-label" }, file.name);
      } else {
        add(fnode, "rect", { x: cx - 26, y: midY - 7, width: 10, height: 13, rx: 2, class: "file-mark" });
        add(fnode, "text", { x: cx - 32, y: y + 15, "text-anchor": "end", class: "file-label" }, file.name);
      }
    }
    node.addEventListener("click", () => pick(row.id));
    node.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(row.id); }
    });
  }

  const hl = (s) => `<mark class="tl-hl">${s}</mark>`;

  function metaOf(id) {
    if (id.startsWith("f:")) {
      const field = FIELDS.find((f) => f.key === id.slice(2));
      const skipped = S.noTool && field.toolOnly;
      return {
        title: `摘要 · ${field.label}`,
        who: skipped ? "程序" : "模型",
        what: skipped
          ? `本轮未调用工具，程序直接留空，${hl("不消耗模型请求")}。`
          : `仅阅读${field.session ? "整场对话" : "当前轮次"}原文，提炼「${field.label}」摘要，${hl("纯文本生成、不调工具")}。`,
        when: `对话进入后，${hl("9 项摘要同时并行启动")}。`,
        fail: `${hl("整条对话立即中止")}，压缩稿与归因结果均不落盘，等待下次重跑。`,
      };
    }
    if (id === "compact") {
      return {
        title: "拼装验收",
        who: "程序",
        what: `本地程序逐项校验格式与完整性，全部通过后${hl("拼装为统一压缩稿")}（不调模型）。`,
        when: `等待 ${hl("9 项摘要全部交回")}（汇聚点 1）。`,
        fail: `缺任意一项都无法通过校验，${hl("整条对话立即中止")}。`,
      };
    }
    if (id.startsWith("g:")) {
      const delivery = id === "g:delivery";
      return {
        title: delivery ? "交付组 · 核查最终回答" : `调查组 ${Number(id.slice(2)) + 1} · 沿一条调用链深查`,
        who: "模型",
        what: `可主动翻原文、搜关键词、看图与跑代码核验；每组${hl("最多提交 4 次")}，被退回时${hl("追加 3 次查询额度")}重查。`,
        when: `压缩稿验收通过后（汇聚点 1），${hl("各调查组并行启动")}。`,
        fail: `${hl("仅缺失该组结论")}，其余组继续执行；小结注明「覆盖不完整」，结果${hl("照常落盘")}。`,
      };
    }
    if (id === "trace") {
      return {
        title: "写小结",
        who: "模型",
        what: `用一段话概括本条对话的核心问题；${hl("问题清单由程序直接合并")}，模型不做篡改。`,
        when: `等待${hl("全部调查组结束")}（汇聚点 2，含失败组）。`,
        fail: `${hl("归因结果无法写出")}，但压缩稿已保存，下次重跑整条对话。`,
      };
    }
    if (id === "session") {
      return {
        title: "组装成行",
        who: "程序",
        what: `本地程序将小结与问题清单${hl("组装为最终归因记录")}并落盘，同时${hl("释放并发名额")}给下一条对话。`,
        when: `${hl("写小结完成后")}立即执行。`,
        fail: "—",
      };
    }
    if (id === "file:compact") {
      return {
        title: "压缩稿",
        who: "程序",
        what: `将 9 项摘要合并落盘为压缩稿，${hl("供后续各调查组共享读取")}。`,
        when: `${hl("汇聚点 1 验收通过")}后写入。`,
        fail: "—",
      };
    }
    return {
      title: "归因结果",
      who: "程序",
      what: `落盘本条对话的${hl("最终归因结果")}，供后续批量聚类消费。`,
      when: `${hl("组装成行完成")}后写入。`,
      fail: "—",
    };
  }

  function syncFocus() {
    const node = $("#tl-focus", host);
    if (!node) return;
    const m = S.sel ? metaOf(S.sel) : null;
    node.innerHTML = `<div class="tl-focus-main">${m
      ? `<div class="tl-focus-head"><b>${m.title}</b><span class="tl-chip${m.who === "程序" ? " is-code" : ""}">${m.who}</span></div>
         <dl class="tl-focus-dl">
           <div><dt>做什么</dt><dd>${m.what}</dd></div>
           <div><dt>何时开始</dt><dd>${m.when}</dd></div>
           <div><dt>失败影响</dt><dd class="${S.sel === S.fail ? "is-bad" : ""}">${m.fail}</dd></div>
         </dl>`
      : `<div class="tl-focus-head"><b>步骤详情</b></div>`}</div>`;
  }

  /* Per frame: bar fills, running rows, playhead, gates and the stepper. */
  function refreshCase() {
    const { geo } = cBoard;
    Object.entries(cBoard.rowNodes).forEach(([id, entry]) => {
      const { row } = entry;
      const state = statusOf(row);
      let running = false;
      if (row._done) {
        const w = clamp(geo.x(Math.min(S.t, row.end)) - geo.x(row.start), 0, geo.x(row.end) - geo.x(row.start));
        row._done.setAttribute("width", String(Math.max(0, w)));
        running = state !== "blocked" && S.t >= row.start && S.t < row.end && (S.playing || S.t < cBoard.P.doneAt);
      }
      const cls = `row${state !== "ok" ? ` is-${state}` : ""}${S.sel === id ? " is-sel" : ""}${running ? " is-run" : ""}`;
      entry.node.setAttribute("class", cls);
    });
    cBoard.gates.forEach((g) => g.node.setAttribute("class", `gate-g${S.t >= g.t ? " is-passed" : ""}`));

    const ph = cBoard.playhead;
    ph.textContent = "";
    add(ph, "line", { x1: 0, y1: cBoard.top - 2, x2: 0, y2: cBoard.height - 26 });
    add(ph, "rect", { x: -22, y: 1, width: 44, height: 18, rx: 9 });
    add(ph, "text", { x: 0, y: 14, "text-anchor": "middle" }, fmtSec(S.t));
    ph.setAttribute("transform", `translate(${geo.x(S.t).toFixed(1)},0)`);

    $$(".tl-pipe-step", host).forEach((li) => {
      const r = cBoard.ranges[li.dataset.sec];
      if (!r) return;
      const p = r.end > r.start ? clamp((S.t - r.start) / (r.end - r.start), 0, 1) : (S.t >= r.start ? 1 : 0);
      li.style.setProperty("--p", p.toFixed(3));
      const blocked = r.rows.every((row) => statusOf(row) === "blocked");
      const failed = r.rows.some((row) => statusOf(row) === "fail");
      li.classList.toggle("is-done", p >= 1 && !blocked);
      li.classList.toggle("is-now", p > 0 && p < 1);
      li.classList.toggle("is-blocked", blocked);
      li.classList.toggle("is-fail", failed);
      li.classList.toggle("is-sel", r.rows.some((row) => row.id === S.sel));
    });
  }

  function renderCase() {
    const wasEnd = !cBoard.P || S.t >= cBoard.P.doneAt - 1e-6;
    const P = plan();
    cBoard.P = P;
    const geo = caseGeo(P);
    cBoard.geo = geo;
    const svgRoot = cBoard.root;
    svgRoot.textContent = "";
    cBoard.rowNodes = {};
    cBoard.gates = [];
    cBoard.ranges = {};
    const layer = add(svgRoot, "g", {});
    const top = 30;
    const secH = 26;
    const rowH = 22;
    let y = top;
    const layout = [];
    ["field", "compact", "group", "trace", "session"].forEach((sec) => {
      layout.push({ type: "sec", sec, y });
      y += secH;
      const rows = P.rows.filter((row) => row.sec === sec);
      rows.forEach((row) => { layout.push({ type: "row", row, y }); y += rowH; });
      cBoard.ranges[sec] = { rows, start: Math.min(...rows.map((r) => r.start)), end: Math.max(...rows.map((r) => r.end)) };
      y += 6;
    });
    const height = y + 34;
    svgRoot.setAttribute("viewBox", `0 0 ${VB_W} ${height}`);

    for (let t = 0; t <= geo.tmax; t += 10) {
      const gx = geo.x(t);
      add(layer, "line", { x1: gx, y1: top - 2, x2: gx, y2: height - 26, class: "grid-line" });
      add(layer, "text", { x: gx, y: height - 10, "text-anchor": "middle", class: "axis-label" }, `${t} s`);
    }

    const secY = {};
    layout.forEach((item) => { if (item.type === "sec") secY[item.sec] = item.y; });
    const gate = (t, label, yTop) => {
      const g = add(layer, "g", { class: "gate-g" });
      const gx = geo.x(t);
      add(g, "line", { x1: gx, y1: yTop, x2: gx, y2: height - 26, class: "gate" });
      add(g, "text", { x: gx + 6, y: height - 30, class: "gate-label" }, label);
      cBoard.gates.push({ t, node: g });
    };

    layout.forEach((item) => {
      if (item.type === "sec") {
        const sec = SECTIONS[item.sec];
        add(layer, "rect", { x: 0, y: item.y + 3, width: VB_W, height: secH - 6, rx: 8, class: "sec-bg" });
        add(layer, "text", { x: 12, y: item.y + 17, class: "sec-title" }, sec.title);
        add(layer, "text", { x: geo.L + 4, y: item.y + 17, class: "sec-note" }, sec.note(P));
        return;
      }
      drawRow(layer, item.row, item.y, rowH, geo);
    });
    gate(P.compactAt, "汇聚点 1 · 9 项摘要全部通过", secY.compact);
    gate(P.settleAt, "汇聚点 2 · 全部调查组结束", secY.trace);

    cBoard.playhead = add(svgRoot, "g", { class: "playhead" });
    cBoard.height = height;
    cBoard.top = top;
    if (still || (wasEnd && !S.playing)) S.t = P.doneAt;
    S.t = clamp(S.t, 0, P.doneAt);
    $("#tl-v-g", host).textContent = S.noTool ? "0" : String(S.g);
    $("#tl-g-dec", host).disabled = S.noTool || S.g <= 0;
    $("#tl-g-inc", host).disabled = S.noTool || S.g >= 4;
    refreshCase();
    syncFocus();
  }

  function stopCase() {
    S.playing = false;
    setPlay($("#tl-c-play", host), false);
    if (rafC) { cancelAnimationFrame(rafC); rafC = 0; }
    if (cBoard.P) refreshCase();
  }

  let lastCaseTick = 0;
  function caseTick(now) {
    if (!S.playing || !host.isConnected) { rafC = 0; return; }
    const dt = Math.min(0.05, (now - (lastCaseTick || now)) / 1000);
    lastCaseTick = now;
    S.t += (dt * cBoard.P.doneAt) / 7;
    if (S.t >= cBoard.P.doneAt) {
      S.t = cBoard.P.doneAt;
      stopCase();
      return;
    }
    refreshCase();
    rafC = requestAnimationFrame(caseTick);
  }
  function playCase(fromStart) {
    if (still) return;
    if (fromStart || S.t >= cBoard.P.doneAt) S.t = 0;
    S.playing = true;
    lastCaseTick = 0;
    setPlay($("#tl-c-play", host), true);
    if (!rafC) rafC = requestAnimationFrame(caseTick);
  }

  const lensEl = $("#tl-lens-seg", host);
  if (lensEl) {
    const seg = segmented(lensEl, (v) => {
      S.lens = v;
      if (v !== "fail") S.fail = null;
      else if (!S.fail) {
        const selRow = S.sel && cBoard.rowNodes[S.sel]?.row;
        S.fail = (selRow && selRow.kind === "model") ? S.sel : "f:components";
        S.sel = S.fail;
      }
      refreshCase();
      syncFocus();
    });
    requestAnimationFrame(() => seg.set("time", { silent: true }));
  }

  $("#tl-g-dec", host)?.addEventListener("click", () => {
    S.g = clamp(S.g - 1, 0, 4);
    S.fail = null;
    if (S.sel && S.sel.startsWith("g:") && S.sel !== "g:delivery") S.sel = null;
    renderCase();
  });
  $("#tl-g-inc", host)?.addEventListener("click", () => {
    S.g = clamp(S.g + 1, 0, 4);
    S.fail = null;
    renderCase();
  });
  $("#tl-notool", host)?.addEventListener("click", (e) => {
    S.noTool = !S.noTool;
    e.currentTarget.setAttribute("aria-pressed", String(S.noTool));
    S.fail = null;
    if (S.sel && S.sel.startsWith("g:") && S.sel !== "g:delivery") S.sel = null;
    renderCase();
  });
  $("#tl-rework", host)?.addEventListener("click", (e) => {
    S.rework = !S.rework;
    e.currentTarget.setAttribute("aria-pressed", String(S.rework));
    if (S.rework) S.sel = "g:delivery";
    renderCase();
    playCase(true);
  });
  $("#tl-c-play", host)?.addEventListener("click", () => {
    if (S.playing) { stopCase(); return; }
    playCase(false);
  });
  $("#tl-pipe", host)?.addEventListener("click", (e) => {
    const li = e.target.closest(".tl-pipe-step");
    const r = li && cBoard.ranges[li.dataset.sec];
    if (!r || !r.rows.length) return;
    const first = r.rows.find((row) => row.kind === "model") || r.rows[0];
    pick(first.id);
  });
  cBoard.root?.addEventListener("pointerdown", (e) => {
    if (e.target.closest(".row")) return;
    const rect = cBoard.root.getBoundingClientRect();
    const vx = (e.clientX - rect.left) * (VB_W / rect.width);
    const { geo } = cBoard;
    if (vx < geo.L - 4) return;
    if (S.playing) { S.playing = false; setPlay($("#tl-c-play", host), false); }
    S.t = clamp(((vx - geo.L) / (geo.R - geo.L)) * geo.tmax, 0, cBoard.P.doneAt);
    refreshCase();
  });

  /* 02 · 整批调度 */
  function rng(seed) {
    let s = seed;
    return () => {
      s = (s * 1664525 + 1013904223) % 4294967296;
      return s / 4294967296;
    };
  }
  function makeCases() {
    const r = rng(7);
    const list = [];
    for (let i = 0; i < G.total; i++) {
      const noTool = r() < 0.2;
      const fields = FIELDS.map((f) => (noTool && f.toolOnly ? 0 : f.dur * (0.6 + r() * 0.9)));
      const groups = [];
      const n = noTool ? 1 : 2 + Math.floor(r() * 3);
      for (let k = 0; k < n; k++) groups.push(20 + r() * 30);
      if (i === 4) groups[0] += 40;
      list.push({ i, fields, groups, trace: 3 + r() * 3 });
    }
    return list;
  }
  function simulate() {
    const cases = makeCases().map((c) => ({ c, admit: null, compactAt: null, end: null, tasks: [], stage: "queued" }));
    const high = G.conc;
    const low = Math.max(1, Math.floor(high / 2));
    const dt = 0.25;
    let t = 0;
    let guard = 0;
    const samples = [];
    let next = 0;
    let done = 0;
    const spawn = (cs, kind, durs) => {
      durs.forEach((d) => { if (d > 0) cs.tasks.push({ kind, rem: d, run: false }); });
    };
    while (done < cases.length && guard++ < 20000) {
      let inflight = 0;
      let buffer = 0;
      cases.forEach((cs) => {
        if (cs.admit !== null && cs.end === null) inflight++;
        if (cs.compactAt !== null && cs.end === null) buffer++;
      });
      while (next < cases.length && inflight < G.conc && buffer < high) {
        const cs = cases[next++];
        cs.admit = t;
        cs.stage = "compact";
        inflight++;
        spawn(cs, "field", cs.c.fields);
      }
      let running = 0;
      const ready = [];
      cases.forEach((cs) => {
        if (cs.admit === null || cs.end !== null) return;
        let active = 0;
        cs.tasks.forEach((task) => { if (task.run) { running++; active++; } });
        cs.tasks.forEach((task) => { if (!task.run && task.rem > 0) ready.push({ cs, task, room: 12 - active }); });
      });
      const prio = (kind) => (kind === "field" ? (buffer >= high ? 100 : buffer <= low ? -1 : 2) : kind === "trace" ? 0 : 1);
      ready.sort((a, b) => prio(a.task.kind) - prio(b.task.kind) || a.cs.admit - b.cs.admit);
      const used = {};
      ready.forEach((item) => {
        const key = item.cs.c.i;
        used[key] = used[key] || 0;
        if (running >= G.req || used[key] >= item.room) return;
        item.task.run = true;
        running++;
        used[key]++;
      });
      samples.push([t, running]);
      cases.forEach((cs) => {
        if (cs.admit === null || cs.end !== null) return;
        let finished = 0;
        cs.tasks.forEach((task) => {
          if (!task.run) return;
          task.rem -= dt;
          if (task.rem <= 1e-9) { task.rem = 0; task.run = false; finished++; }
        });
        if (!finished) return;
        if (cs.tasks.every((task) => task.rem === 0)) {
          if (cs.stage === "compact") { cs.stage = "groups"; cs.compactAt = t + dt; cs.tasks = []; spawn(cs, "group", cs.c.groups); }
          else if (cs.stage === "groups") { cs.stage = "trace"; cs.tasks = []; spawn(cs, "trace", [cs.c.trace]); }
          else { cs.stage = "done"; cs.end = t + dt; done++; }
        }
      });
      t += dt;
    }
    return { cases, end: t, samples };
  }

  const gBoard = { root: $("#tl-g-canvas", host), playhead: null, rows: [], clip: null };

  function paintGlobal() {
    const { data } = G;
    const t = G.t;
    const x = gBoard.x;
    gBoard.rows.forEach((r) => {
      const { cs } = r;
      if (r.wait) r.wait.setAttribute("x2", x(clamp(t, 0, cs.admit)).toFixed(1));
      const compW = t <= cs.admit ? 0 : Math.max(t >= cs.compactAt ? 2 : 0, x(Math.min(t, cs.compactAt)) - x(cs.admit));
      const attrW = t <= cs.compactAt ? 0 : Math.max(t >= cs.end ? 2 : 0, x(Math.min(t, cs.end)) - x(cs.compactAt));
      r.comp.setAttribute("width", compW.toFixed(1));
      r.attr.setAttribute("width", attrW.toFixed(1));
      r.end.setAttribute("class", `g-end${t >= cs.end - 1e-6 ? " is-on" : ""}`);
    });
    gBoard.clip.setAttribute("width", Math.max(0, x(t) - gBoard.L + 1).toFixed(1));
    const landed = data.cases.filter((cs) => cs.end <= t + 1e-6).length;
    const peak = data.samples.reduce((m, s) => (s[0] <= t ? Math.max(m, s[1]) : m), 0);
    const stat = (k, v) => { const el = $(`[data-stat="${k}"]`, host); if (el) el.textContent = v; };
    stat("end", fmtSec(data.end));
    stat("done", `${landed} / ${G.total}`);
    stat("peak", `${peak} / ${G.req}`);
    const ph = gBoard.playhead;
    ph.textContent = "";
    if (!G.play && t >= data.end - 1e-6) return;
    add(ph, "line", { x1: 0, y1: 14, x2: 0, y2: gBoard.height - 18 });
    ph.setAttribute("transform", `translate(${x(Math.min(t, data.end)).toFixed(1)},0)`);
  }

  function drawGlobal() {
    const data = simulate();
    G.data = data;
    const svgRoot = gBoard.root;
    svgRoot.textContent = "";
    const L = 52;
    const R = VB_W - 8;
    const chartTop = 22;
    const chartH = 50;
    const rowsTop = chartTop + chartH + 22;
    const rowH = 15;
    const height = rowsTop + data.cases.length * rowH + 24;
    svgRoot.setAttribute("viewBox", `0 0 ${VB_W} ${height}`);
    const span = Math.ceil(data.end / 20) * 20;
    const x = (t) => L + ((R - L) * t) / span;
    Object.assign(gBoard, { x, height, span, L, rows: [] });

    const defs = add(svgRoot, "defs", {});
    const cp = add(defs, "clipPath", { id: "tl-occ-clip" });
    gBoard.clip = add(cp, "rect", { x: L, y: 0, width: R - L, height });

    for (let t = 0; t <= span; t += 20) {
      add(svgRoot, "line", { x1: x(t), y1: chartTop, x2: x(t), y2: height - 20, class: "grid-line" });
      add(svgRoot, "text", { x: x(t), y: height - 5, "text-anchor": "middle", class: "axis-label" }, `${t} s`);
    }

    const maxY = Math.max(G.req, 1);
    const base = chartTop + chartH;
    const y = (v) => base - chartH * clamp(v / maxY, 0, 1);
    add(svgRoot, "line", { x1: L, y1: y(G.req), x2: R, y2: y(G.req), class: "cap-line" });
    add(svgRoot, "text", { x: L - 8, y: y(G.req) + 4, "text-anchor": "end", class: "cap-label" }, String(G.req));
    add(svgRoot, "text", { x: L - 8, y: base + 4, "text-anchor": "end", class: "cap-label" }, "0");
    add(svgRoot, "text", { x: L + 6, y: chartTop - 8, class: "cap-label" }, "同时在跑的模型请求");
    const pts = data.samples.filter((_, k) => k % 2 === 0);
    if (pts.length) {
      let d = `M${x(pts[0][0]).toFixed(1)},${base}`;
      let line = "";
      pts.forEach((p, k) => {
        const seg = `${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`;
        d += ` L${seg}`;
        line += `${k ? " L" : "M"}${seg}`;
      });
      d += ` L${x(pts[pts.length - 1][0]).toFixed(1)},${base} Z`;
      const occ = add(svgRoot, "g", { "clip-path": "url(#tl-occ-clip)" });
      add(occ, "path", { d, class: "occ-area" });
      add(occ, "path", { d: line, class: "occ-line" });
    }

    data.cases.forEach((cs, index) => {
      const ry = rowsTop + index * rowH;
      add(svgRoot, "text", { x: L - 8, y: ry + 8.5, "text-anchor": "end", class: "case-label" }, `#${index + 1}`);
      const row = add(svgRoot, "g", { class: "g-row" });
      const wait = cs.admit > 0 ? add(row, "line", { x1: x(0), y1: ry + 5, x2: x(cs.admit), y2: ry + 5, class: "g-wait" }) : null;
      const comp = add(row, "rect", { x: x(cs.admit), y: ry, width: 0, height: 10, rx: 5, class: "g-compact" });
      const attr = add(row, "rect", { x: x(cs.compactAt), y: ry, width: 0, height: 10, rx: 5, class: "g-attr" });
      const end = add(row, "line", { x1: x(cs.end), y1: ry - 2, x2: x(cs.end), y2: ry + 12, class: "g-end" });
      gBoard.rows.push({ cs, wait, comp, attr, end });
    });
    gBoard.playhead = add(svgRoot, "g", { class: "playhead" });
    if (!G.play) G.t = data.end;
    paintGlobal();
  }

  function stopGlobal() {
    G.play = false;
    setPlay($("#tl-g-play", host), false);
    if (rafG) { cancelAnimationFrame(rafG); rafG = 0; }
  }

  let lastGTick = 0;
  function gTick(now) {
    if (!G.play || !host.isConnected) { rafG = 0; return; }
    const dt = Math.min(0.06, (now - (lastGTick || now)) / 1000);
    lastGTick = now;
    G.t += (dt * G.data.end) / 8;
    if (G.t >= G.data.end) {
      G.t = G.data.end;
      stopGlobal();
      paintGlobal();
      return;
    }
    paintGlobal();
    rafG = requestAnimationFrame(gTick);
  }
  function playGlobal(fromStart) {
    if (still) return;
    if (fromStart || G.t >= G.data.end - 1e-6) G.t = 0;
    G.play = true;
    lastGTick = 0;
    setPlay($("#tl-g-play", host), true);
    if (!rafG) rafG = requestAnimationFrame(gTick);
  }

  $("#tl-g-play", host)?.addEventListener("click", () => {
    if (G.play) { stopGlobal(); paintGlobal(); return; }
    playGlobal(false);
  });

  $$("[data-tl-g]", host).forEach((button) => {
    button.addEventListener("click", () => {
      const delta = Number(button.dataset.d);
      if (button.dataset.tlG === "conc") {
        G.conc = clamp(G.conc + delta, 1, 12);
        $("#tl-v-conc", host).textContent = String(G.conc);
      } else {
        G.req = clamp(G.req + delta, 4, 48);
        $("#tl-v-req", host).textContent = String(G.req);
      }
      stopGlobal();
      drawGlobal();
      playGlobal(true);
    });
  });

  renderCase();
  drawGlobal();

  // Each block plays itself once, the first time it scrolls into view.
  let io = null;
  if (!still && typeof IntersectionObserver !== "undefined") {
    const seen = new Set();
    io = new IntersectionObserver((entries) => {
      entries.forEach((en) => {
        if (!en.isIntersecting || seen.has(en.target.id)) return;
        seen.add(en.target.id);
        if (en.target.id === "tl-c-wrap") playCase(true);
        else { stopGlobal(); playGlobal(true); }
      });
    }, { threshold: 0.35 });
    ["#tl-c-wrap", "#tl-g-wrap"].forEach((sel) => { const el = $(sel, host); if (el) io.observe(el); });
  }

  host._tlCleanup = () => {
    io?.disconnect();
    stopCase();
    stopGlobal();
  };
}
