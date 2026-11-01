/* 仅呈现已确认的归因流程；问题类型与结果字段由后续实际数据补充。 */
import { esc, REDUCED } from "./core.js";

const STEPS = [
  {
    id: "source", title: "完整 Session",
  },
  {
    id: "compact", title: "Compat 摘要",
  },
  {
    id: "trace", title: "逐 Trace 归因",
  },
  {
    id: "session", title: "跨 Trace 检查",
  },
  {
    id: "assemble", title: "组装结论",
  },
  {
    id: "result", title: "单条评测结果",
  },
];

const EDGES = [
  { from: "source", to: "compact", label: "" },
  { from: "source", to: "trace", label: "原文" },
  { from: "compact", to: "trace", label: "" },
  { from: "trace", to: "session", label: "" },
  { from: "trace", to: "assemble", label: "逐轮结论" },
  { from: "session", to: "assemble", label: "Session 归因" },
  { from: "assemble", to: "result", label: "" },
];

let instance = null;

function nodeMarkup(step) {
  return `<li class="sys-flow-item sys-flow-item--${step.id}">
    <button class="sys-node" type="button" data-node="${step.id}" aria-pressed="false">
      <span class="sys-node-title">${esc(step.title)}</span>
    </button>
  </li>`;
}

function pageMarkup() {
  return `<div class="sys-page${REDUCED ? " is-reduced" : ""}">
    <header class="sys-head">
      <h2>归因流程</h2>
    </header>
    <div class="sys-canvas">
      <p class="sr-only">完整 Session 先生成 Compat 现场摘要。原始 Session 和 Compat 同时进入逐 Trace 归因；逐轮完成后检查跨 Trace 问题，形成 Session 归因。最后组装逐轮和 Session 的全部结论，生成单条评测结果。</p>
      <svg class="sys-wires" aria-hidden="true"><defs>
        <marker id="sysArrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="m1 1 5 3-5 3" fill="none" stroke="context-stroke" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></marker>
      </defs><g class="sys-wire-paths"></g></svg>
      <ol class="sys-flow-grid" aria-label="归因流程步骤">${STEPS.map(nodeMarkup).join("")}</ol>
    </div>
  </div>`;
}

function selectStep(id, focus = false) {
  if (!instance) return;
  const step = STEPS.find((item) => item.id === id);
  if (!step) return;
  instance.selected = id;
  instance.root.querySelectorAll("[data-node]").forEach((node) => {
    const selected = node.dataset.node === id;
    node.setAttribute("aria-pressed", String(selected));
    if (selected && focus) node.focus();
  });
  instance.root.querySelectorAll("[data-edge]").forEach((edge) => {
    edge.classList.toggle("is-selected", edge.dataset.from === id || edge.dataset.to === id);
  });
}

/* SVG routes follow actual HTML node bounds, keeping labels and keyboard targets native. */
function drawWires() {
  if (!instance || !instance.active) return;
  const canvas = instance.root.querySelector(".sys-canvas");
  const bounds = canvas.getBoundingClientRect();
  if (!bounds.width || !bounds.height) return;
  const boxes = {};
  instance.root.querySelectorAll("[data-node]").forEach((node) => {
    const rect = node.getBoundingClientRect();
    boxes[node.dataset.node] = { x: rect.left - bounds.left, y: rect.top - bounds.top, w: rect.width, h: rect.height };
  });
  const mode = getComputedStyle(canvas).getPropertyValue("--sys-layout").trim();
  const port = (id, side, at = 0.5) => {
    const b = boxes[id];
    return side === "left" ? [b.x, b.y + b.h * at] : side === "right" ? [b.x + b.w, b.y + b.h * at] : side === "top" ? [b.x + b.w * at, b.y] : [b.x + b.w * at, b.y + b.h];
  };
  const horizontal = (a, b) => `M${a} C${(a[0] + b[0]) / 2},${a[1]} ${(a[0] + b[0]) / 2},${b[1]} ${b}`;
  const vertical = (a, b) => `M${a} C${a[0]},${(a[1] + b[1]) / 2} ${b[0]},${(a[1] + b[1]) / 2} ${b}`;
  const svg = canvas.querySelector(".sys-wires");
  svg.setAttribute("viewBox", `0 0 ${bounds.width} ${bounds.height}`);
  svg.querySelector(".sys-wire-paths").innerHTML = EDGES.map((edge) => {
    const { from, to } = edge;
    let a, b, d, labelX, labelY, rotate = false;
    if (mode === "wide") {
      if (from === "trace" && to === "assemble") {
        a = port(from, "bottom"); b = port(to, "bottom");
        const lane = Math.max(...Object.values(boxes).map((box) => box.y + box.h)) + 46;
        d = `M${a} C${a[0]},${lane} ${a[0]},${lane} ${a[0] + 44},${lane} L${b[0] - 44},${lane} C${b[0]},${lane} ${b[0]},${lane} ${b}`;
        labelX = (a[0] + b[0]) / 2; labelY = lane - 9;
      } else {
        a = port(from, "right", from === "source" && to === "compact" ? 0.25 : 0.5);
        b = port(to, "left", from === "compact" ? 0.2 : 0.5);
        d = horizontal(a, b);
        labelX = (a[0] + b[0]) / 2; labelY = (a[1] + b[1]) / 2 - 12;
      }
    } else if (mode === "paired") {
      const sameRow = Math.abs(boxes[from].y - boxes[to].y) < 36;
      if (sameRow) {
        a = port(from, "right"); b = port(to, "left"); d = horizontal(a, b);
        labelX = (a[0] + b[0]) / 2; labelY = a[1] - 12;
      } else {
        const diagonal = from === "compact" || from === "session";
        a = port(from, "bottom"); b = port(to, "top", diagonal ? 0.73 : 0.27);
        const lane = (a[1] + b[1]) / 2;
        if (diagonal) {
          d = `M${a} C${a[0]},${lane} ${a[0]},${lane} ${a[0] - 24},${lane} L${b[0] + 24},${lane} C${b[0]},${lane} ${b[0]},${lane} ${b}`;
          labelX = (a[0] + b[0]) / 2; labelY = lane - 9;
        } else {
          a = port(from, "bottom", 0.27); d = vertical(a, b);
          labelX = a[0] + 10; labelY = lane;
        }
      }
    } else {
      const bypass = (from === "source" && to === "trace") || (from === "trace" && to === "assemble");
      if (bypass) {
        a = port(from, "left", from === "trace" ? 0.75 : 0.5);
        b = port(to, "left", to === "trace" ? 0.25 : 0.5);
        const lane = 17;
        d = `M${a} C${lane},${a[1]} ${lane},${a[1]} ${lane},${a[1] + 28} L${lane},${b[1] - 28} C${lane},${b[1]} ${lane},${b[1]} ${b}`;
        labelX = 7; labelY = (a[1] + b[1]) / 2; rotate = true;
      } else {
        a = port(from, "bottom"); b = port(to, "top"); d = vertical(a, b);
        labelX = (a[0] + b[0]) / 2 + 12; labelY = (a[1] + b[1]) / 2;
      }
    }
    const selected = instance.selected === from || instance.selected === to;
    const anchor = mode === "stacked" && !rotate ? "start" : mode === "paired" && from === "source" && to === "trace" ? "start" : "middle";
    return `<g data-edge data-from="${from}" data-to="${to}" class="${selected ? "is-selected" : ""}">
      <path d="${d}" marker-end="url(#sysArrow)"/>
      ${edge.label ? `<text x="${labelX}" y="${labelY}" text-anchor="${anchor}"${rotate ? ` transform="rotate(-90 ${labelX} ${labelY})"` : ""}>${esc(edge.label)}</text>` : ""}</g>`;
  }).join("");
}

function scheduleWires() {
  if (!instance || !instance.active || instance.frame) return;
  instance.frame = requestAnimationFrame(() => {
    if (!instance) return;
    instance.frame = 0;
    drawWires();
  });
}

export function initSystem(root) {
  if (instance) {
    cancelAnimationFrame(instance.frame);
    instance.controller.abort();
    instance.observer.disconnect();
  }
  instance = null;
  if (!root) return;
  root.innerHTML = pageMarkup();
  const controller = new AbortController();
  instance = { root, controller, selected: "trace", active: false, frame: 0, observer: new ResizeObserver(scheduleWires) };
  instance.observer.observe(root.querySelector(".sys-canvas"));
  root.addEventListener("click", (event) => {
    const node = event.target.closest("[data-node]");
    if (node) selectStep(node.dataset.node);
  }, { signal: controller.signal });
  root.addEventListener("keydown", (event) => {
    const node = event.target.closest("[data-node]");
    if (!node) return;
    const index = STEPS.findIndex((step) => step.id === node.dataset.node);
    let next;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") next = (index + 1) % STEPS.length;
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = (index + STEPS.length - 1) % STEPS.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = STEPS.length - 1;
    else return;
    event.preventDefault(); selectStep(STEPS[next].id, true);
  }, { signal: controller.signal });
  selectStep("trace");
}

export function setSystemActive(active) {
  if (!instance) return;
  instance.active = Boolean(active);
  if (instance.active) scheduleWires();
  else { cancelAnimationFrame(instance.frame); instance.frame = 0; }
}

export function refreshSystem() { scheduleWires(); }
