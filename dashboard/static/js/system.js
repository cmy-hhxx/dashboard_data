/* 评测体系: how a session becomes compact + attribution + clusters, told with the real batch. */
import { $, $$, esc, fmt, pct, sum, SEV, sevColor, KIND, ROLE_NOTE, counter, runCounters, REDUCED } from "./core.js";

let shown = null;

export function render(root, c) {
  const d = c.data;
  const key = d.generated_at;
  if (shown === key && root.firstChild) return;
  shown = key;
  const prods = Object.values(d.products || {});
  if (!prods.length) {
    root.innerHTML = `<div class="bento"><div class="card" style="--span:12"><div class="empty">暂无评测数据。</div></div></div>`;
    return;
  }
  const tot = (f) => sum(prods.map(f));
  const T = {
    sessions: tot((p) => p.kpi.sessions), traces: tot((p) => p.kpi.traces), messages: tot((p) => p.kpi.messages),
    calls: tot((p) => p.kpi.tool_calls), problems: tot((p) => p.kpi.problems), evidence: tot((p) => p.kpi.evidence),
    located: tot((p) => p.kpi.located), clustered: tot((p) => p.kpi.clustered),
    patterns: new Set(prods.flatMap((p) => p.patterns.map((x) => x.id))).size,
    step: (k) => tot((p) => (p.compact.steps[k] || { total: 0 }).total),
    sev: (s) => tot((p) => p.severity[s]),
  };
  root.innerHTML = `<div class="bento">
    ${flowCard(T, d)}
    ${anatomyCard(d.system && d.system.anatomy)}
    ${rubricCard(T, d.system)}
    ${roleCard(prods)}
    ${taxoCard(d.taxonomy, prods)}
  </div>`;
  runCounters(root);
  wireAnatomy(root, c);
  wireTaxo(root, d.taxonomy, prods);
  root.addEventListener("click", (e) => {
    const a = e.target.closest("[data-open]");
    if (!a) return;
    e.preventDefault();
    const [product, slug, p] = a.dataset.open.split("|");
    c.navigate({ view: "samples", product, case: slug, tab: "attr", p: p || null });
  });
}

function flowCard(T, d) {
  const runs = (d.taxonomy && d.taxonomy.meta) || {};
  const stage = (step, title, rows) => `<div class="stage"><span class="step">${step}</span>
    ${rows.map(([k, v]) => `<div class="k"><span>${k}</span><b>${v}</b></div>`).join("")}</div>`;
  return `<article class="card" style="--span:12">
    <header class="card-head"><h2>一条会话如何被评测</h2></header>
    <div class="flow">
      ${stage("输入", "会话原文", [["会话", counter(T.sessions)], ["轨迹", counter(T.traces)], ["消息", counter(T.messages)], ["工具调用", counter(T.calls)]])}
      ${stage("压缩", "Compact 轨迹", [["规划", counter(T.step("plans"))], ["执行链", counter(T.step("execution"))], ["工具报错", counter(T.step("tool_errors"))], ["关键数据", counter(T.step("key_data"))]])}
      ${stage("归因", "逐轮问题与证据", [["问题", counter(T.problems)], ["P0–P3", counter(SEV.slice(0, 4).reduce((a, s) => a + T.sev(s), 0))], ["证据", counter(T.evidence)], ["定位到原文", pct(T.located, T.evidence, 1)]])}
      ${stage("聚类", "环节 · 机制 · 模式", [["已聚类问题", counter(T.clustered)], ["出现的模式", counter(T.patterns)], ["环节 / 机制", `${(d.taxonomy && d.taxonomy.stages.length) || "—"} / ${(d.taxonomy && d.taxonomy.mechanisms.length) || "—"}`], ["聚类版本", esc(runs.version || "—")]])}
    </div>
  </article>`;
}

function anatomyCard(a) {
  if (!a) return "";
  const msgs = a.messages
    .map((m, i) => {
      const hit = a.problems.some((p) => p.msgs.includes(i));
      return `<div class="rail-msg k-${m.k}${hit ? " hit" : ""}" data-m="${i}"><span class="kind k-${m.k}">${KIND[m.k] || m.k}<span class="faint num">${i}</span></span><span class="text" title="${esc(m.text)}">${esc(m.name ? `${m.name} · ` : "")}${esc(m.text)}</span></div>`;
    })
    .join("");
  const probs = a.problems
    .slice()
    .sort((x, y) => SEV.indexOf(x.sev) - SEV.indexOf(y.sev))
    .map(
      (p) => `<button type="button" class="aprob" data-p="${p.id}" style="--c:${sevColor(p.sev)}">
        <span class="pill sevpill" style="--c:${sevColor(p.sev)}">${p.sev}</span>
        <span class="pill">${esc(roleName(p.role))}</span>${p.path ? `<span class="pill mono">${p.path}</span>` : ""}
        <div class="t">${esc(p.label)}</div><div class="s">${esc(p.comp || "")} · 证据落在消息 ${p.msgs.join("、") || "—"}</div></button>`,
    )
    .join("");
  return `<article class="card" style="--span:12">
    <header class="card-head"><h2>证据如何锚定</h2>
      <a class="link end" href="#" data-open="${a.product}|${a.slug}">打开这个样本</a></header>
    <div class="anatomy" id="anatomy">
      <div class="rail">${msgs}</div>
      <div class="threads"><svg aria-hidden="true"></svg></div>
      <div class="aprobs">${probs}
      </div>
    </div>
  </article>`;
}

const ROLE = { planning: "规划", request_generation: "请求生成", tool: "工具执行", script: "脚本执行", skill: "技能装载", delivery: "交付" };
const roleName = (r) => ROLE[r] || r || "—";

function rubricCard(T, sys) {
  const desc = {
    P0: "确认有剩余影响，程度最重",
    P1: "确认有剩余影响",
    P2: "确认有剩余影响",
    P3: "确认有剩余影响，程度最轻",
    P4: "过程缺陷已恢复，未进入交付",
  };
  const total = SEV.reduce((a, s) => a + T.sev(s), 0);
  const rows = SEV.map((s, i) => {
    const ex = ((sys && sys.severity_examples[s]) || [])[0];
    return `<div class="rub" style="--c:${sevColor(i)}">
      <div class="lvl"><i></i>${s}</div>
      <div><div class="d">${desc[s]}</div>${
        ex ? `<div class="ex">例：<a href="#" data-open="${ex.product}|${ex.slug}|${ex.p}">${esc(ex.label)}</a> — ${esc(ex.reason)}</div>` : ""
      }</div>
      <div class="n"><b class="num">${fmt(T.sev(s))}</b>${pct(T.sev(s), total, 1)}</div></div>`;
  }).join("");
  return `<article class="card" style="--span:7">
    <header class="card-head"><h2>严重度</h2></header>
    <div class="rubric">${rows}</div>
  </article>`;
}

function roleCard(prods) {
  const agg = {};
  prods.forEach((p) => p.roles.forEach((r) => {
    const e = (agg[r.id] = agg[r.id] || { id: r.id, label: r.label, problems: 0, fams: {} });
    e.problems += r.problems;
    r.families.forEach((f) => (e.fams[f.id] = (e.fams[f.id] || 0) + f.n));
  }));
  const order = ["planning", "request_generation", "tool", "script", "skill", "delivery"];
  const rows = order.filter((id) => agg[id]).map((id) => {
    const r = agg[id];
    const fams = Object.entries(r.fams).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k]) => k).join(" · ");
    return `<div class="role"><b>${esc(r.label)}</b><span class="n num">${fmt(r.problems)}</span><p>${esc(ROLE_NOTE[id] || "")} <span class="faint">${esc(fams)}</span></p></div>`;
  }).join("");
  return `<article class="card" style="--span:5">
    <header class="card-head"><h2>组件角色</h2></header>
    <div class="roles">${rows}</div>
  </article>`;
}

function taxoCard(tax, prods) {
  if (!tax) return "";
  const stageN = {};
  prods.forEach((p) => Object.entries(p.matrix).forEach(([s, row]) => (stageN[s] = (stageN[s] || 0) + sum(Object.values(row).map((x) => x.n)))));
  const cols = tax.phases.map((ph) => `<div class="taxo-col">${tax.stages
    .filter((s) => s.phase === ph.id)
    .map((s) => `<button type="button" class="stg" data-stage="${s.id}" aria-expanded="false"><code>${s.id}</code><b>${esc(s.name)}</b><span class="faint num" style="float:right">${fmt(stageN[s.id] || 0)}</span><p>${esc(s.def || "")}</p></button><div class="stg-detail" data-for="${s.id}" hidden></div>`)
    .join("")}</div>`).join("");
  const mechs = tax.mechanisms.map((m) => `<div class="mech"><b><code>${m.id}</code>${esc(m.name)}</b>${esc(m.def)}</div>`).join("");
  const tags = tax.tags.map((t) => `<span class="pill" title="${esc(t.def)}">${esc(t.id)} · ${esc(t.name)}</span>`).join("");
    return `<article class="card" style="--span:12">
    <header class="card-head"><h2>聚类体系</h2></header>
    <div class="taxo" id="taxo">${cols}</div>
    <div style="height:24px"></div>
    <div class="mechs">${mechs}</div>
    <div style="height:24px"></div>
    <div class="tags">${tags}</div>
  </article>`;
}

function wireTaxo(root, tax, prods) {
  const box = $("#taxo", root);
  if (!box) return;
  const counts = {};
  prods.forEach((p) => p.patterns.forEach((x) => (counts[x.id] = (counts[x.id] || 0) + x.sessions)));
  box.addEventListener("click", (e) => {
    const b = e.target.closest(".stg");
    if (!b) return;
    const open = b.getAttribute("aria-expanded") !== "true";
    b.setAttribute("aria-expanded", String(open));
    const det = $(`.stg-detail[data-for="${b.dataset.stage}"]`, box);
    if (open && !det.innerHTML) {
      const pats = Object.entries(tax.patterns)
        .filter(([id]) => id.startsWith(b.dataset.stage + "."))
        .sort((a, c) => (counts[c[0]] || 0) - (counts[a[0]] || 0));
      det.innerHTML = pats.map(([id, p]) => `<div class="pt"><span>${esc(p.name)}</span><span class="num faint">${counts[id] ? fmt(counts[id]) : "—"}</span><small>${esc(p.plain || "")}</small></div>`).join("") || `<span class="dim">暂无模式</span>`;
    }
    det.hidden = !open;
  });
}

function wireAnatomy(root, c) {
  const box = $("#anatomy", root);
  if (!box) return;
  const svg = $(".threads svg", box);
  const draw = () => {
    const host = svg.getBoundingClientRect();
    if (!host.width) return;
    let paths = "";
    $$(".aprob", box).forEach((pb) => {
      const pid = pb.dataset.p;
      const pr = pb.getBoundingClientRect();
      const y2 = pr.top + 22 - host.top;
      const a = c.data.system.anatomy.problems.find((x) => String(x.id) === pid);
      a.msgs.forEach((mi) => {
        const m = $(`.rail-msg[data-m="${mi}"]`, box);
        if (!m) return;
        const r = m.getBoundingClientRect();
        const y1 = r.top + r.height / 2 - host.top;
        const w = host.width;
        paths += `<path data-p="${pid}" style="--c:${sevColor(a.sev)}" d="M0 ${y1} C ${w * 0.55} ${y1}, ${w * 0.45} ${y2}, ${w} ${y2}"/>`;
      });
    });
    svg.innerHTML = paths;
  };
  requestAnimationFrame(draw);
  new ResizeObserver(draw).observe(box);
  const focus = (pid) => {
    box.classList.toggle("is-focus", pid != null);
    const prob = pid != null && c.data.system.anatomy.problems.find((x) => String(x.id) === pid);
    $$(".aprob", box).forEach((b) => b.classList.toggle("on", b.dataset.p === pid));
    $$(".threads path", box).forEach((p) => p.classList.toggle("on", p.dataset.p === pid));
    $$(".rail-msg", box).forEach((m) => m.classList.toggle("on", !!prob && prob.msgs.includes(Number(m.dataset.m))));
  };
  box.addEventListener("pointerover", (e) => {
    const b = e.target.closest(".aprob");
    focus(b ? b.dataset.p : null);
  });
  box.addEventListener("pointerleave", () => focus(null));
  box.addEventListener("click", (e) => {
    const b = e.target.closest(".aprob");
    if (b) c.navigate({ view: "samples", product: c.data.system.anatomy.product, case: c.data.system.anatomy.slug, tab: "attr", p: b.dataset.p });
  });
  if (REDUCED) return;
}
