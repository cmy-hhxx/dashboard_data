/* 归因时序: embedded in the 评测体系 page after 证据闭环.
   Two interactive blocks in one system card:
   01 一条 Trace 的时间线 (Gantt + failure simulation + readout + 11-16 measured table)
   02 整批怎么调度 (16-Trace discrete simulation + concurrency / model-request steppers) */
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
  return `<article class="card tl-card" id="tlCard" style="--span:12" aria-label="归因时序说明">
    <header class="card-head">
      <h2>归因时序</h2>
    </header>

    <div class="tl-sections">
      <section class="tl-sec" aria-label="单条 Trace 的时间线">
        <div class="tl-subhead">
          <h3><span class="tl-num num">01</span>一条 Trace 的时间线</h3>
          <div class="tl-end">
            <div class="seg" id="tl-lens-seg" role="group" aria-label="视角">
              <span class="seg-knob" aria-hidden="true"></span>
              <button type="button" data-value="time" aria-pressed="true">看时序</button>
              <button type="button" data-value="fail" aria-pressed="false">模拟失败</button>
            </div>
            <div class="tl-step"><span class="tl-step-k">工具链组</span><button type="button" id="tl-g-dec" aria-label="减少工具链组">−</button><b class="num" id="tl-v-g">2</b><button type="button" id="tl-g-inc" aria-label="增加工具链组">+</button></div>
            <button class="tl-pill" id="tl-notool" type="button" aria-pressed="false">本轮没调工具</button>
            <button class="tl-pill" id="tl-rework" type="button" aria-pressed="false">一次提交被退回</button>
            <button class="icon-btn tl-play" id="tl-c-play" type="button" aria-pressed="false" aria-label="播放">${PLAY_SVG}</button>
          </div>
        </div>

        <div class="tl-pipe" aria-label="阶段顺序">
          <div class="tl-pipe-step is-model"><b>① 字段摘要</b><span>模型 · 9 次并行，无工具</span></div>
          <span class="tl-pipe-arrow" aria-hidden="true">→</span>
          <div class="tl-pipe-step is-code"><b>② 拼装 + 验收</b><span>程序 · 写出 compact 行</span></div>
          <span class="tl-pipe-arrow" aria-hidden="true">→</span>
          <div class="tl-pipe-step is-model"><b>③ 组件调查</b><span>模型 · 每组 1 任务，带工具</span></div>
          <span class="tl-pipe-arrow" aria-hidden="true">→</span>
          <div class="tl-pipe-step is-model"><b>④ 小结</b><span>模型 · 1 次，写 summary</span></div>
          <span class="tl-pipe-arrow" aria-hidden="true">→</span>
          <div class="tl-pipe-step is-code"><b>⑤ 组装整行</b><span>程序 · 写出 attribution 行</span></div>
        </div>

        <div class="tl-canvas-wrap"><svg class="tl-canvas" id="tl-c-canvas" role="img" aria-label="单条 Trace 的甘特图：字段摘要、拼装验收、组件调查、小结、组装整行"></svg></div>

        <div class="tl-legend">
          <span class="tl-lg"><i class="tl-sw model"></i>模型调用（已完成）</span>
          <span class="tl-lg"><i class="tl-sw later"></i>模型调用（未完成）</span>
          <span class="tl-lg"><i class="tl-sw code"></i>程序步骤</span>
          <span class="tl-lg"><i class="tl-sw file"></i>写出文件</span>
          <span class="tl-lg"><i class="tl-sw gate"></i>关口：等前面全部结束</span>
          <span class="tl-lg"><i class="tl-sw wait"></i>等待关口</span>
          <span class="tl-lg"><i class="tl-sw fail"></i>失败</span>
          <span class="tl-lg"><i class="tl-sw blocked"></i>因上游失败不运行</span>
        </div>

        <div class="tl-readout" aria-live="polite">
          <div class="tl-ro"><span class="tl-ro-k">选中项</span><span class="tl-ro-v" id="tl-ro-obj">—</span></div>
          <div class="tl-ro"><span class="tl-ro-k">阶段名</span><span class="tl-ro-v mono" id="tl-ro-stage">—</span></div>
          <div class="tl-ro"><span class="tl-ro-k">执行方</span><span class="tl-ro-v" id="tl-ro-who">—</span></div>
          <div class="tl-ro"><span class="tl-ro-k">前置条件</span><span class="tl-ro-v" id="tl-ro-dep">—</span></div>
          <div class="tl-ro"><span class="tl-ro-k">工具与提交</span><span class="tl-ro-v" id="tl-ro-tools">—</span></div>
          <div class="tl-ro"><span class="tl-ro-k">失败影响</span><span class="tl-ro-v" id="tl-ro-effect">—</span></div>
        </div>
        <div class="tl-outcome" id="tl-outcome" aria-live="polite"></div>

        <div class="tl-table-wrap">
          <table class="tl-table">
            <thead><tr><th>阶段</th><th>每条 Trace 模型调用</th><th class="num">中位</th><th class="num">p90</th><th>关键特征（2026-11-16 · 34 条 Trace 实测）</th></tr></thead>
            <tbody>
              <tr><td><b>① 字段摘要</b> <code>attribution-compact-field</code></td><td>9（无工具时 7）</td><td class="num">~4 s</td><td class="num">~18 s</td><td>9 个同时发出，耗时取决于最慢字段 <code>components</code>（中位 ~18 s，p90 ~30 s）与 <code>execution_chain</code>（中位 ~14 s）。</td></tr>
              <tr><td><b>③ 组件调查</b> <code>attribution-component</code></td><td>每组 1 个任务</td><td class="num">~36 s</td><td class="num">~66 s</td><td>平均每任务 ~3.8 次工具调用；各组同时跑，耗时取决于最慢的一组。</td></tr>
              <tr><td><b>④ 小结</b> <code>attribution-trace</code></td><td>1</td><td class="num">~3–6 s</td><td class="num">—</td><td>不带工具，只写 summary（有标准答案时加 is_correct）。</td></tr>
              <tr><td><b>② ⑤ 程序步骤</b> <code>compact / session</code></td><td>0</td><td class="num">≈0 s</td><td class="num">—</td><td>纯程序校验与拼装，不调模型。</td></tr>
              <tr><td><b>整批 34 条 Trace</b></td><td>—</td><td class="num" colspan="2">147–208 s 墙钟</td><td>长尾由单次长生成或提交被退回后重写决定。</td></tr>
            </tbody>
          </table>
        </div>
      </section>

      <section class="tl-sec" aria-label="整批调度">
        <div class="tl-subhead">
          <h3><span class="tl-num num">02</span>整批怎么调度</h3>
          <div class="tl-end">
            <div class="tl-step"><span class="tl-step-k">并发 Trace</span><button type="button" data-tl-g="conc" data-d="-1" aria-label="减少并发 Trace">−</button><b class="num" id="tl-v-conc">6</b><button type="button" data-tl-g="conc" data-d="1" aria-label="增加并发 Trace">+</button></div>
            <div class="tl-step"><span class="tl-step-k">请求上限</span><button type="button" data-tl-g="req" data-d="-2" aria-label="降低模型请求上限">−</button><b class="num" id="tl-v-req">12</b><button type="button" data-tl-g="req" data-d="2" aria-label="提高模型请求上限">+</button></div>
            <button class="icon-btn tl-play" id="tl-g-play" type="button" aria-pressed="false" aria-label="播放">${PLAY_SVG}</button>
          </div>
        </div>

        <div class="tl-canvas-wrap"><svg class="tl-canvas" id="tl-g-canvas" role="img" aria-label="整批调度：每条 Trace 的准入等待、字段摘要阶段、调查阶段与写出时刻"></svg></div>

        <div class="tl-legend">
          <span class="tl-lg"><i class="tl-sw wait"></i>等准入（名额或缓冲已满）</span>
          <span class="tl-lg"><i class="tl-sw compact"></i>① 字段摘要阶段</span>
          <span class="tl-lg"><i class="tl-sw model"></i>③ 组件调查 + ④ 小结</span>
          <span class="tl-lg"><i class="tl-sw end"></i>写出 attribution 行</span>
        </div>

        <div class="tl-rules">
          <div class="tl-rule"><b>Trace 名额</b><span>最多 <code>--concurrency</code> 个同时在跑（默认 32），结束才让出名额。</span></div>
          <div class="tl-rule"><b>单条 Trace 窗口</b><span>每条 Trace 最多同时 <code>--task-concurrency</code> 个任务（默认 12），9 个字段一次发齐。</span></div>
          <div class="tl-rule"><b>全局请求上限</b><span>在飞模型请求不超过 <code>--model-requests</code>（默认 256）；缓冲低时字段优先，高时调查与小结优先。</span></div>
          <div class="tl-rule"><b>compact 缓冲</b><span>已写 compact、未写 attribution 的 Trace 数上限 = <code>--compact-backlog</code>，Trace 结束或失败立即释放。</span></div>
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
      rows.push({
        id: `f:${field.key}`, sec: "field", kind: skipped ? "skip" : "model",
        label: field.label, key: field.key, start: 0, end: dur, field,
      });
    });
    rows.push({ id: "compact", sec: "compact", kind: "code", label: "拼装 + 验收", key: "attribution-compact", start: compactAt, end: compactAt });
    const groups = [];
    const g = S.noTool ? 0 : S.g;
    for (let i = 0; i < g; i++) groups.push({ id: `g:${i}`, label: `工具链组 ${i + 1}`, key: `tool-chain #${i + 1}`, dur: GROUP_DUR[i] });
    groups.push({ id: "g:delivery", label: "交付组", key: "delivery", dur: DELIVERY_DUR, delivery: true });
    let settleAt = compactAt;
    groups.forEach((group) => {
      const rework = S.rework && group.delivery;
      const end = compactAt + (rework ? REWORK.end : group.dur);
      settleAt = Math.max(settleAt, end);
      rows.push({
        id: group.id, sec: "group", kind: "model", label: group.label, key: group.key,
        start: compactAt, end, group, rework: rework ? compactAt + REWORK.reject : null, waitFrom: 0,
      });
    });
    rows.push({ id: "trace", sec: "trace", kind: "model", label: "写小结", key: "summary (+is_correct)", start: settleAt, end: settleAt + TRACE_DUR, waitFrom: 0 });
    const doneAt = settleAt + TRACE_DUR;
    rows.push({ id: "session", sec: "session", kind: "code", label: "组装整行", key: "attribution-session", start: doneAt, end: doneAt });
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
    field: { title: "① 字段摘要", stage: "attribution-compact-field", note: () => `模型 · ${S.noTool ? "7 次（2 个字段由程序判空）" : "9 次"} · 同时发出 · 无工具` },
    compact: { title: "② 拼装 + 验收", stage: "attribution-compact", code: true, note: () => "程序 · 每个字段交回时逐项 verifiedCompact，全部通过后拼装" },
    group: { title: "③ 组件调查", stage: "attribution-component", note: (P) => `模型 · ${P.groups} 个任务 · 同时发出 · 每个任务带工具，最多 4 次提交` },
    trace: { title: "④ 小结", stage: "attribution-trace", note: () => "模型 · 1 次 · 无工具 · 问题列表由程序合并，不交给模型改" },
    session: { title: "⑤ 组装整行", stage: "attribution-session", code: true, note: () => "程序 · 把 trace 结果组装成正式行" },
  };

  const cBoard = { root: $("#tl-c-canvas", host), P: null, geo: null, playhead: null, rowNodes: {} };

  function caseGeo(P) {
    const L = 300;
    const R = VB_W - 16;
    const tmax = Math.ceil((P.doneAt * 1.18 + 4) / 10) * 10;
    return { L, R, tmax, x: (t) => L + ((R - L) * t) / tmax };
  }

  function pick(id) {
    if (S.lens === "fail") {
      const row = cBoard.rowNodes[id]?.row;
      if (row && row.kind === "model") S.fail = S.fail === id ? null : id;
    }
    S.sel = id;
    refreshCase();
  }

  function drawRow(layer, row, y, rowH, geo) {
    const node = add(layer, "g", { class: "row", tabindex: "0", role: "button", "aria-label": `${row.label} ${row.key}` });
    cBoard.rowNodes[row.id] = { node, row };
    add(node, "rect", { x: 0, y, width: VB_W, height: rowH, class: "row-hit" });
    add(node, "text", { x: 24, y: y + 15, class: "row-label" }, row.label);
    add(node, "text", { x: 112, y: y + 15, class: "row-key" }, row.kind === "code" ? "" : row.key);
    const midY = y + rowH / 2;
    if (row.waitFrom !== undefined && row.start > 0) {
      add(node, "line", { x1: geo.x(row.waitFrom), y1: midY, x2: geo.x(row.start) - 2, y2: midY, class: "wait-line" });
    }
    if (row.kind === "model") {
      const x0 = geo.x(row.start);
      const x1 = geo.x(row.end);
      add(node, "rect", { x: x0, y: midY - 6, width: Math.max(3, x1 - x0), height: 12, rx: 3, class: "bar-model" });
      const done = add(node, "rect", { x: x0, y: midY - 6, width: 0, height: 12, rx: 3, class: "bar-model-done" });
      row._done = done;
      if (row.sec === "group") {
        const calls = [0.15, 0.32, 0.5, 0.68];
        const firstEnd = row.rework !== null ? row.rework : row.end;
        calls.forEach((f) => {
          const tx = geo.x(row.start + (firstEnd - row.start) * f * 0.92);
          add(node, "line", { x1: tx, y1: midY - 6, x2: tx, y2: midY + 6, class: "bar-tick" });
        });
        if (row.rework !== null) {
          const rx = geo.x(row.rework);
          add(node, "line", { x1: rx, y1: midY - 9, x2: rx, y2: midY + 9, class: "bar-reject" });
          add(node, "text", { x: geo.x(row.end) + 40, y: y + 15, class: "reject-label" }, "红线处第 1 次提交被退回，工具预算 +3，重新调查");
          [0.2, 0.42, 0.64].forEach((f) => {
            const tx = geo.x(row.rework + (row.end - row.rework) * f);
            add(node, "line", { x1: tx, y1: midY - 6, x2: tx, y2: midY + 6, class: "bar-tick" });
          });
        }
      }
      add(node, "text", { x: x1 + 6, y: y + 15, class: "dur" }, fmtSec(row.end - row.start));
    } else if (row.kind === "skip") {
      const sx = geo.x(0);
      add(node, "path", { d: `M${sx},${midY - 5} l5,5 l-5,5 l-5,-5 z`, class: "code-mark" });
      add(node, "text", { x: sx + 10, y: y + 15, class: "skip-label" }, "程序跳过：本轮没有工具调用，直接给空值");
    } else {
      const cx = geo.x(row.start);
      add(node, "path", { d: `M${cx},${midY - 6} l6,6 l-6,6 l-6,-6 z`, class: "code-mark" });
      const label = row.id === "compact" ? "程序拼装 compact，不调模型" : "程序组装，不调模型";
      add(node, "text", { x: cx + 12, y: y + 15, class: "code-label" }, label);
      const isCompact = row.id === "compact";
      const file = isCompact
        ? { id: "file:compact", name: "写出 <model>/compact/<model>_compact-<batch>.jsonl" }
        : { id: "file:attr", name: "写出 <model>/<model>_attribution-<batch>.jsonl" };
      const fnode = add(layer, "g", { class: "row" });
      cBoard.rowNodes[file.id] = { node: fnode, row: { id: file.id }, passive: true };
      if (isCompact) {
        const fx = cx + 12 + 186;
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

  function metaOf(id) {
    if (id.startsWith("f:")) {
      const key = id.slice(2);
      const field = FIELDS.find((f) => f.key === key);
      const skipped = S.noTool && field.toolOnly;
      return {
        obj: `${field.label}（${field.key}）`,
        stage: "attribution-compact-field",
        who: skipped ? "程序：无工具调用直接判空" : `模型：单轮调用，${field.session ? "整场范围" : "本轮范围"}`,
        dep: "Trace 启动即 9 个字段同时发出",
        tools: "无工具；提交不合格可返工",
        effect: "整条 Trace 终止：两份文件都不写",
      };
    }
    if (id === "compact") {
      return {
        obj: "拼装 Compact", stage: "attribution-compact", who: "程序（不调模型）",
        dep: "9 个字段全部交回并通过 verifiedCompact",
        tools: "—", effect: "写出 compact 行，开启分组调查",
      };
    }
    if (id.startsWith("g:")) {
      const delivery = id === "g:delivery";
      return {
        obj: delivery ? "交付组：核查终稿" : "工具链组：按调用图合并的一条调用链",
        stage: "attribution-component",
        who: "模型：每组 1 个任务；组由程序划分",
        dep: "关口 1：Compact 已拼装并验收",
        tools: "read_trace / search_trace / view_image / calculate / execute_code / read_artifact；初始 4 次，退回 +3，最多 4 次提交",
        effect: "仅该组无结果：小结标注“评测覆盖不完整”，两份文件照写",
      };
    }
    if (id === "trace") {
      return {
        obj: "本条 trace 小结", stage: "attribution-trace",
        who: "模型：1 次调用，只写 summary",
        dep: "关口 2：所有调查组结束（含失败）",
        tools: "无工具；问题列表由程序合并",
        effect: "attribution 行写不出；compact 行已在关口 1 写出",
      };
    }
    if (id === "session") {
      return {
        obj: "组装正式行", stage: "attribution-session", who: "程序（不调模型）",
        dep: "小结完成", tools: "—", effect: "写出 attribution 行，释放 Trace 名额",
      };
    }
    if (id === "file:compact") return { obj: "compact 文件", stage: "<model>_compact-<batch>.jsonl", who: "程序写盘", dep: "关口 1", tools: "—", effect: "—" };
    return { obj: "attribution 文件", stage: "<model>_attribution-<batch>.jsonl", who: "程序写盘", dep: "组装整行", tools: "—", effect: "—" };
  }

  function syncReadout() {
    const m = S.sel ? metaOf(S.sel) : null;
    $("#tl-ro-obj", host).textContent = m ? m.obj : "点任意一行";
    $("#tl-ro-stage", host).textContent = m ? m.stage : "—";
    $("#tl-ro-who", host).textContent = m ? m.who : "—";
    $("#tl-ro-dep", host).textContent = m ? m.dep : "—";
    $("#tl-ro-tools", host).textContent = m ? m.tools : "—";
    const eff = $("#tl-ro-effect", host);
    eff.textContent = m ? m.effect : "—";
    eff.className = `tl-ro-v${m && S.sel === S.fail ? " is-bad" : ""}`;
  }

  function syncOutcome() {
    const P = cBoard.P;
    const node = $("#tl-outcome", host);
    const f = S.fail;
    let text;
    let cls = "";
    if (S.lens === "fail" && !f) {
      text = "点甘特图中的任意模型调用（实心条），查看它失败后哪些步骤还会运行、哪份文件还会写出。";
    } else if (!f) {
      text = `时间集中在两段：① 等最慢字段 components（约 ${fmtSec(P.compactAt)}），③ 等最慢调查组（约 ${fmtSec(P.settleAt - P.compactAt)}）。${S.rework ? " 交付组第 1 次提交被退回重写，拖长整条 Trace。" : ""}`;
    } else if (f.startsWith("f:")) {
      cls = "is-bad";
      text = "字段失败：Compact 无法拼装，后续调查、小结、组装全部停止，两份文件都不写；下次续跑整条重评。";
    } else if (f.startsWith("g:")) {
      cls = "is-warn";
      text = "单组调查失败：其余组与小结照常运行，summary 加上“评测覆盖不完整：部分组件调查未完成；”，两份文件照常写出。";
    } else {
      cls = "is-bad";
      text = "小结失败：attribution 行写不出，但 compact 行已在关口 1 写出；下次续跑会整条重评。";
    }
    node.textContent = text;
    node.className = `tl-outcome${cls ? ` ${cls}` : ""}`;
  }

  function refreshCase() {
    const { geo } = cBoard;
    Object.entries(cBoard.rowNodes).forEach(([id, entry]) => {
      const { row } = entry;
      const state = statusOf(row);
      const cls = `row${state !== "ok" ? ` is-${state}` : ""}${S.sel === id ? " is-sel" : ""}`;
      entry.node.setAttribute("class", cls);
      if (row._done) {
        const w = clamp(geo.x(Math.min(S.t, row.end)) - geo.x(row.start), 0, geo.x(row.end) - geo.x(row.start));
        row._done.setAttribute("width", String(Math.max(0, w)));
      }
    });
    const ph = cBoard.playhead;
    ph.textContent = "";
    add(ph, "line", { x1: 0, y1: cBoard.top - 4, x2: 0, y2: cBoard.height - 26 });
    add(ph, "path", { d: "M-4,0 L4,0 L0,6 z", transform: `translate(0,${cBoard.top - 6})` });
    ph.setAttribute("transform", `translate(${geo.x(S.t).toFixed(1)},0)`);

    syncReadout();
    syncOutcome();
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
    const layer = add(svgRoot, "g", {});
    const top = 26;
    const secH = 24;
    const rowH = 22;
    let y = top;
    const layout = [];
    ["field", "compact", "group", "trace", "session"].forEach((sec) => {
      layout.push({ type: "sec", sec, y });
      y += secH;
      P.rows.forEach((row) => { if (row.sec === sec) { layout.push({ type: "row", row, y }); y += rowH; } });
      y += 6;
    });
    const height = y + 34;
    svgRoot.setAttribute("viewBox", `0 0 ${VB_W} ${height}`);

    for (let t = 0; t <= geo.tmax; t += 10) {
      const gx = geo.x(t);
      add(layer, "line", { x1: gx, y1: top - 4, x2: gx, y2: height - 26, class: "grid-line" });
      add(layer, "text", { x: gx, y: 14, "text-anchor": "middle", class: "axis-label" }, `${t} s`);
    }

    const secY = {};
    layout.forEach((item) => { if (item.type === "sec") secY[item.sec] = item.y; });
    const gate = (t, label, yTop) => {
      const gx = geo.x(t);
      add(layer, "line", { x1: gx, y1: yTop, x2: gx, y2: height - 26, class: "gate" });
      add(layer, "text", { x: gx + 5, y: height - 12, class: "gate-label" }, label);
    };
    gate(P.compactAt, "关口 1：9 个字段全部交回并验收", secY.compact);
    gate(P.settleAt, "关口 2：所有组结束（成功或失败）", secY.trace);

    layout.forEach((item) => {
      if (item.type === "sec") {
        const sec = SECTIONS[item.sec];
        add(layer, "rect", { x: 0, y: item.y + 2, width: VB_W, height: secH - 4, rx: 6, class: "sec-bg" });
        add(layer, "text", { x: 10, y: item.y + 16, class: "sec-title" }, sec.title);
        add(layer, "text", { x: 96, y: item.y + 16, class: `sec-stage${sec.code ? " is-code" : ""}` }, sec.stage);
        add(layer, "text", { x: geo.L + 4, y: item.y + 16, class: "sec-note" }, sec.note(P));
        return;
      }
      drawRow(layer, item.row, item.y, rowH, geo);
    });

    cBoard.playhead = add(svgRoot, "g", { class: "playhead" });
    cBoard.height = height;
    cBoard.top = top;
    if (still || wasEnd) S.t = P.doneAt;
    S.t = clamp(S.t, 0, P.doneAt);
    $("#tl-v-g", host).textContent = S.noTool ? "0" : String(S.g);
    $("#tl-g-dec", host).disabled = S.noTool || S.g <= 0;
    $("#tl-g-inc", host).disabled = S.noTool || S.g >= 4;
    refreshCase();
  }

  function stopCase() {
    S.playing = false;
    setPlay($("#tl-c-play", host), false);
    if (rafC) { cancelAnimationFrame(rafC); rafC = 0; }
  }

  let lastCaseTick = 0;
  function caseTick(now) {
    if (!S.playing || !host.isConnected) { rafC = 0; return; }
    const dt = Math.min(0.05, (now - (lastCaseTick || now)) / 1000);
    lastCaseTick = now;
    S.t += (dt * cBoard.P.doneAt) / 8;
    if (S.t >= cBoard.P.doneAt) {
      S.t = cBoard.P.doneAt;
      refreshCase();
      stopCase();
      return;
    }
    refreshCase();
    rafC = requestAnimationFrame(caseTick);
  }

  const lensEl = $("#tl-lens-seg", host);
  if (lensEl) {
    const seg = segmented(lensEl, (v) => {
      S.lens = v;
      if (v !== "fail") S.fail = null;
      refreshCase();
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
  });
  $("#tl-c-play", host)?.addEventListener("click", (e) => {
    if (S.playing) { stopCase(); return; }
    if (S.t >= cBoard.P.doneAt) S.t = 0;
    S.playing = true;
    lastCaseTick = 0;
    setPlay(e.currentTarget, true);
    rafC = requestAnimationFrame(caseTick);
  });
  cBoard.root?.addEventListener("pointerdown", (e) => {
    if (e.target.closest(".row")) return;
    const rect = cBoard.root.getBoundingClientRect();
    const vx = (e.clientX - rect.left) * (VB_W / rect.width);
    const { geo } = cBoard;
    if (vx < geo.L - 4) return;
    stopCase();
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

  const gBoard = { root: $("#tl-g-canvas", host), playhead: null };

  function paintGlobal() {
    const { data } = G;
    const ph = gBoard.playhead;
    ph.textContent = "";
    if (!G.play && G.t >= data.end - 1e-6) return;
    add(ph, "line", { x1: 0, y1: 14, x2: 0, y2: gBoard.height - 18 });
    ph.setAttribute("transform", `translate(${gBoard.x(Math.min(G.t, data.end)).toFixed(1)},0)`);
  }

  function drawGlobal() {
    const data = simulate();
    G.data = data;
    const svgRoot = gBoard.root;
    svgRoot.textContent = "";
    const L = 44;
    const R = VB_W - 8;
    const chartTop = 18;
    const chartH = 46;
    const rowsTop = chartTop + chartH + 22;
    const rowH = 14;
    const height = rowsTop + data.cases.length * rowH + 22;
    svgRoot.setAttribute("viewBox", `0 0 ${VB_W} ${height}`);
    const span = Math.ceil(data.end / 20) * 20;
    const x = (t) => L + ((R - L) * t) / span;
    gBoard.x = x;
    gBoard.height = height;
    gBoard.span = span;

    for (let t = 0; t <= span; t += 20) {
      add(svgRoot, "line", { x1: x(t), y1: chartTop, x2: x(t), y2: height - 18, class: "grid-line" });
      add(svgRoot, "text", { x: x(t), y: height - 4, "text-anchor": "middle", class: "axis-label" }, `${t} s`);
    }

    const maxY = Math.max(G.req, 1);
    const base = chartTop + chartH;
    const y = (v) => base - chartH * clamp(v / maxY, 0, 1);
    add(svgRoot, "line", { x1: L, y1: y(G.req), x2: R, y2: y(G.req), class: "cap-line" });
    add(svgRoot, "text", { x: L - 6, y: y(G.req) + 4, "text-anchor": "end", class: "cap-label" }, String(G.req));
    add(svgRoot, "text", { x: L - 6, y: base + 4, "text-anchor": "end", class: "cap-label" }, "0");
    add(svgRoot, "text", { x: L + 6, y: chartTop - 6, class: "cap-label" }, "在飞模型请求数");
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
      add(svgRoot, "path", { d, class: "occ-area" });
      add(svgRoot, "path", { d: line, class: "occ-line" });
    }

    data.cases.forEach((cs, index) => {
      const ry = rowsTop + index * rowH;
      add(svgRoot, "text", { x: L - 6, y: ry + 8, "text-anchor": "end", class: "case-label" }, `c${index + 1}`);
      const row = add(svgRoot, "g", { class: "g-row" });
      if (cs.admit > 0) add(row, "line", { x1: x(0), y1: ry + 4.5, x2: x(cs.admit), y2: ry + 4.5, class: "g-wait" });
      add(row, "rect", { x: x(cs.admit), y: ry, width: Math.max(2, x(cs.compactAt) - x(cs.admit)), height: 9, rx: 3, class: "g-compact" });
      add(row, "rect", { x: x(cs.compactAt), y: ry, width: Math.max(2, x(cs.end) - x(cs.compactAt)), height: 9, rx: 3, class: "g-attr" });
      add(row, "line", { x1: x(cs.end), y1: ry - 2, x2: x(cs.end), y2: ry + 11, class: "g-end" });
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
    G.t += (dt * G.data.end) / 10;
    if (G.t >= G.data.end) {
      G.t = G.data.end;
      paintGlobal();
      stopGlobal();
      return;
    }
    paintGlobal();
    rafG = requestAnimationFrame(gTick);
  }

  $("#tl-g-play", host)?.addEventListener("click", (e) => {
    if (G.play) { stopGlobal(); return; }
    if (G.t >= G.data.end - 1e-6) G.t = 0;
    G.play = true;
    lastGTick = 0;
    setPlay(e.currentTarget, true);
    rafG = requestAnimationFrame(gTick);
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
    });
  });

  renderCase();
  drawGlobal();

  host._tlCleanup = () => {
    stopCase();
    stopGlobal();
  };
}
