/* The page builds itself: a dozen named, coloured cursors circle the centre, scatter, the lead one
   drags out the page frame, and then each card is drawn as a selection box, its headings typed and
   its blocks boxed in, a cursor per job, while the idle ones watch. The build follows the reader's
   scroll (a block below the fold waits until it comes into view) and a player at the bottom can
   pause, replay or skip it. It plays on its own once per tab session; after that the page simply
   appears and the player folds into a 「重播构建」 pill. Reduced motion never builds.

   Hidden parts are hidden with clip-path only, so layout, sizes and every listener stay exactly as
   the view rendered them; finishing (or skipping) clears the clip and nothing else. */
import { REDUCED } from "./core.js";

const WORKERS = [
  ["规划", "#7b61ff"], ["检索", "#1bb47a"], ["执行", "#ff7262"], ["归因", "#18a0fb"],
  ["聚类", "#f2a100"], ["定级", "#e85aa7"], ["证据", "#0fb5ae"],
];
const WATCHERS = [["复核", "#8c7cf0"], ["评审", "#52c41a"], ["产品", "#fa8c16"], ["运营", "#2f88ff"], ["审阅", "#eb2f96"]];
const DUR = { frame: 0.72, block: 0.5, grid: 0.82, text: 0.5 };
const TOOL_OF = { frame: "cross", block: "cross", grid: "cross", text: "ibeam" };
const ICON = {
  arrow: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2.5v10l2.6-2.4 1.7 3.6 1.6-.8-1.7-3.5H12z" fill="currentColor"/></svg>',
  cross: '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="3" y="3" width="10" height="10" rx="1.5" stroke="currentColor" stroke-width="1.4" stroke-dasharray="2.4 1.6"/></svg>',
  ibeam: '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M6 3h4M6 13h4M8 3v10" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
  pause: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="4" y="3.5" width="2.6" height="9" rx="1" fill="currentColor"/><rect x="9.4" y="3.5" width="2.6" height="9" rx="1" fill="currentColor"/></svg>',
  play: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 3.5v9l7.5-4.5z" fill="currentColor"/></svg>',
  replay: '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3.5 8a4.5 4.5 0 1 0 1.4-3.3M3.5 2.8v2.6h2.6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  skip: '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 4l5 4-5 4zM11.5 4v8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const easeOut = (t) => 1 - (1 - t) ** 3;

const seen = (key) => {
  try { return sessionStorage.getItem(`eval-build:${key}`) === "1"; } catch (err) { return false; }
};
const remember = (key) => {
  try { sessionStorage.setItem(`eval-build:${key}`, "1"); } catch (err) { /* private mode: replays next time */ }
};

export function buildPage(root, { key, targets }) {
  root._builder?.destroy();
  if (REDUCED || !targets.length) return;
  const b = new Builder(root, key, targets);
  root._builder = b;
  if (seen(key)) b.idle();
  else b.start();
}

class Builder {
  constructor(root, key, targets) {
    this.root = root;
    this.key = key;
    this.targets = targets;
    this.raf = 0;
    this.running = false;
    this.playing = true;
    this.dead = false;
    this.canvas = document.createElement("canvas");
    this.canvas.className = "mcb-canvas";
    this.canvas.setAttribute("aria-hidden", "true");
    this.bar = document.createElement("div");
    this.bar.className = "mcb";
    this.bar.setAttribute("role", "toolbar");
    this.bar.setAttribute("aria-label", "页面搭建");
    root.append(this.canvas, this.bar);
    this.ctx = this.canvas.getContext("2d");
    this.bar.addEventListener("click", (e) => {
      const a = e.target.closest("[data-a]")?.dataset.a;
      if (a === "pause") this.toggle();
      else if (a === "replay") this.start();
      else if (a === "skip") this.finish(true);
    });
    this.onResize = () => this.size();
    window.addEventListener("resize", this.onResize);
    this.onVis = () => { if (!document.hidden && this.running && this.playing) this.loop(); };
    document.addEventListener("visibilitychange", this.onVis);
  }

  /* ------------------------------------------------------------ player */
  barHTML() {
    return `<span class="mcb-tools" aria-hidden="true">${["arrow", "cross", "ibeam"].map((t) => `<i data-t="${t}">${ICON[t]}</i>`).join("")}</span>
      <span class="mcb-txt"><b>正在搭建评测体系</b><span class="num" id="mcbPct">0%</span></span>
      <span class="mcb-sep"></span>
      <button type="button" data-a="pause" aria-label="暂停搭建">${ICON.pause}<span>暂停</span></button>
      <button type="button" data-a="replay" aria-label="重播搭建">${ICON.replay}<span>重播</span></button>
      <button type="button" data-a="skip" aria-label="跳过搭建，直接显示页面">${ICON.skip}<span>跳过</span></button>`;
  }
  idle() {
    this.bar.className = "mcb is-pill";
    this.bar.innerHTML = `<button type="button" data-a="replay" title="用多光标把这一页重新搭一遍">${ICON.replay}<span>重播构建</span></button>`;
  }
  toggle() {
    this.playing = !this.playing;
    const btn = this.bar.querySelector('[data-a="pause"]');
    if (btn) {
      btn.innerHTML = `${this.playing ? ICON.pause : ICON.play}<span>${this.playing ? "暂停" : "继续"}</span>`;
      btn.setAttribute("aria-label", this.playing ? "暂停搭建" : "继续搭建");
    }
    if (this.playing) { this.last = 0; this.loop(); }
  }

  /* ------------------------------------------------------------ setup */
  size() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.dpr = dpr;
    this.w = window.innerWidth;
    this.h = window.innerHeight;
    this.canvas.width = Math.round(this.w * dpr);
    this.canvas.height = Math.round(this.h * dpr);
  }
  start() {
    this.size();
    this.bar.className = "mcb";
    this.bar.innerHTML = this.barHTML();
    this.playing = true;
    this.running = true;
    this.root.classList.add("is-building");
    const top = this.root.getBoundingClientRect().top + window.scrollY - 72;
    if (window.scrollY > top) window.scrollTo({ top: Math.max(0, top), behavior: "auto" });
    // Jobs: every target once, a block waiting for the card frame it sits in.
    const frames = this.targets.filter((t) => t.kind === "frame").map((t) => t.el);
    this.jobs = this.targets.map((t, i) => {
      const parent = t.kind === "frame" ? null : frames.find((f) => f !== t.el && f.contains(t.el)) || null;
      return { ...t, i, parent, s: 0, state: "wait", cursor: null };
    });
    this.byEl = new Map(this.jobs.map((j) => [j.el, j]));
    this.jobs.forEach((j) => this.clip(j, 0));
    const cx = this.w / 2;
    const cy = this.h / 2;
    this.cursors = [...WORKERS.map(([name, col], f) => ({ name, col, f, worker: true, home: [0.08 + 0.84 * ((f * 0.37 + 0.1) % 1), 0.2 + 0.6 * ((f * 0.61 + 0.2) % 1)] })),
      ...WATCHERS.map(([name, col], f) => ({ name, col, f: f + 7, worker: false, tgt: f % 7, ox: 0, oy: 0, sw: 0 }))]
      .map((c) => ({ ...c, x: cx, y: cy, a: 0, tool: "arrow", job: null, tr: null, down: 0, ph: Math.random() * 6.28 }));
    this.ripples = [];
    this.phase = "intro";
    this.t = 0;
    this.pt = 0;
    this.last = 0;
    this.loop();
  }

  clip(j, s) {
    const el = j.el;
    if (s >= 1) { el.style.clipPath = ""; return; }
    if (j.kind === "text") {
      const steps = Math.max(4, Math.min(24, (el.textContent || "").trim().length));
      const q = Math.floor(s * steps) / steps;
      el.style.clipPath = `inset(0 ${((1 - q) * 100).toFixed(2)}% 0 0)`;
      return;
    }
    el.style.clipPath = `inset(0 ${((1 - s) * 100).toFixed(2)}% ${((1 - s) * 100).toFixed(2)}% 0 round 2px)`;
  }

  finish(skipped) {
    if (!this.running) return;
    this.running = false;
    cancelAnimationFrame(this.raf);
    this.jobs.forEach((j) => this.clip(j, 1));
    this.root.classList.remove("is-building");
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    remember(this.key);
    if (skipped) { this.idle(); return; }
    const txt = this.bar.querySelector(".mcb-txt");
    if (txt) txt.innerHTML = "<b>搭建完成</b>";
    this.bar.querySelectorAll('[data-a="pause"], [data-a="skip"]').forEach((x) => x.remove());
    setTimeout(() => { if (!this.running && !this.dead) this.idle(); }, 1600);
  }

  destroy() {
    this.dead = true;
    if (this.running) this.jobs.forEach((j) => this.clip(j, 1));
    this.running = false;
    cancelAnimationFrame(this.raf);
    window.removeEventListener("resize", this.onResize);
    document.removeEventListener("visibilitychange", this.onVis);
    this.root.classList.remove("is-building");
    this.canvas.remove();
    this.bar.remove();
  }

  /* ------------------------------------------------------------ the frame loop */
  loop() {
    if (this.raf || !this.running) return;
    this.raf = requestAnimationFrame((now) => {
      this.raf = 0;
      if (!this.running || !this.playing || document.hidden) return;
      // Leaving the view mid-build would strand it half drawn: finish instead.
      if (!this.root.offsetParent) { this.finish(true); return; }
      const dt = this.last ? Math.min(0.05, (now - this.last) / 1000) : 1 / 60;
      this.last = now;
      this.t += dt;
      this.step(dt);
      this.draw();
      this.loop();
    });
  }

  step(dt) {
    const { w, h } = this;
    const cx = w / 2;
    const cy = h / 2;
    const lead = this.cursors[0];
    if (this.phase === "intro") {
      // Six orbits, two cursors each, the rings turning against each other.
      this.cursors.forEach((c, e) => {
        const s = e % 6;
        const n = Math.floor(e / 6);
        const ang = s * 1.047 + this.t * (s % 2 ? 1 : -1) * (1.3 + (s % 3) * 0.15);
        const r = 80 + (s % 3) * 28 + Math.sin(this.t * 1.7 + s) * 10;
        const tang = ang + (s % 2 ? 1.57 : -1.57);
        c.x = cx + Math.cos(ang) * r * 1.5 - Math.cos(tang) * n * 22;
        c.y = cy + Math.sin(ang) * r * 0.66 - Math.sin(tang) * n * 22;
        c.a = Math.min(1, this.t * 1.8);
      });
      if (this.t > 1.6) {
        this.phase = "burst";
        this.pt = this.t;
        this.cursors.forEach((c) => {
          const ang = Math.atan2(c.y - cy, c.x - cx) + (Math.random() - 0.5) * 0.5;
          const s = 220 + Math.random() * 220;
          c.bx = c.x; c.by = c.y; c.ex = cx + Math.cos(ang) * s * 1.5; c.ey = cy + Math.sin(ang) * s;
        });
      }
    } else if (this.phase === "burst") {
      const k = easeOut(clamp((this.t - this.pt) / 0.55));
      this.cursors.forEach((c) => { c.x = lerp(c.bx, c.ex, k); c.y = lerp(c.by, c.ey, k); });
      if (k >= 1) { this.phase = "board"; this.pt = this.t; lead.bx = lead.x; lead.by = lead.y; }
    } else if (this.phase === "board") {
      // The lead cursor drags the page frame over the area the cards will fill.
      const r = this.root.getBoundingClientRect();
      const x0 = Math.max(8, r.left);
      const y0 = Math.max(64, r.top);
      const x1 = Math.min(w - 8, r.right);
      const y1 = Math.min(h - 8, r.bottom);
      const s = this.t - this.pt;
      if (s < 0.32) {
        const k = easeInOut(s / 0.32);
        lead.x = lerp(lead.bx, x0, k); lead.y = lerp(lead.by, y0, k); lead.tool = "arrow";
      } else {
        const k = easeInOut(clamp((s - 0.32) / 0.7));
        lead.tool = "cross"; lead.down = 1;
        lead.x = lerp(x0, x1, k); lead.y = lerp(y0, y1, k);
        this.board = { x: x0, y: y0, w: (x1 - x0) * k, h: (y1 - y0) * k, col: lead.col };
        if (k >= 1) {
          lead.down = 0; lead.tool = "arrow";
          this.ripple(lead.x, lead.y, lead.col);
          this.board = null;
          this.phase = "build";
          this.pt = this.t;
        }
      }
      this.cursors.forEach((c) => { if (c !== lead) { c.x += Math.sin(this.t * 1.1 + c.f) * 0.2; } });
    } else {
      this.build(dt);
    }
  }

  build(dt) {
    const { h } = this;
    const rect = (j) => j.el.getBoundingClientRect();
    // Hand ready jobs to the nearest idle worker: a job is ready when its card frame is drawn,
    // the job before it has started and its top has scrolled into view.
    for (const j of this.jobs) {
      if (j.state !== "wait") continue;
      const r = rect(j);
      if (r.top > h * 0.9) continue;
      if (j.parent && this.byEl.get(j.parent)?.state !== "done") continue;
      const prev = this.jobs[j.i - 1];
      if (prev && prev.state === "wait" && rect(prev).top <= h * 0.9) break;
      if (r.bottom < -40 || !r.width) { j.state = "done"; j.s = 1; this.clip(j, 1); continue; }
      let best = null;
      let bd = Infinity;
      this.cursors.forEach((c) => {
        if (!c.worker || c.job) return;
        const d = Math.hypot(c.x - r.left, c.y - r.top);
        if (d < bd) { bd = d; best = c; }
      });
      if (!best) break;
      j.state = "travel";
      j.cursor = best;
      best.job = j;
      best.tr = { x: best.x, y: best.y, t: 0, d: clamp(bd / 1600, 0.22, 0.5) };
    }
    for (const c of this.cursors) {
      const j = c.job;
      if (c.worker && j) {
        const r = rect(j);
        const start = j.kind === "text" ? [r.left, r.top + r.height / 2] : [r.left, r.top];
        if (j.state === "travel") {
          c.tr.t += dt;
          const k = easeInOut(clamp(c.tr.t / c.tr.d));
          c.x = lerp(c.tr.x, start[0], k);
          c.y = lerp(c.tr.y, start[1], k);
          c.tool = k > 0.85 ? TOOL_OF[j.kind] : "arrow";
          if (k >= 1) { j.state = "work"; this.ripple(c.x, c.y, c.col); }
        } else {
          j.s = clamp(j.s + dt / DUR[j.kind]);
          const k = easeInOut(j.s);
          c.tool = TOOL_OF[j.kind];
          c.down = 1;
          c.x = lerp(r.left, r.right, k);
          c.y = j.kind === "text" ? start[1] : lerp(r.top, r.bottom, k);
          this.clip(j, k);
          if (j.s >= 1) {
            j.state = "done";
            j.doneAt = this.t;
            this.clip(j, 1);
            this.ripple(c.x, Math.min(c.y, h - 12), c.col);
            c.job = null; c.down = 0; c.tool = "arrow";
          }
        }
      } else if (c.worker) {
        const tx = this.w * c.home[0] + Math.sin(this.t / 1.9 + c.ph) * 50;
        const ty = this.h * c.home[1] + Math.cos(this.t / 1.5 + c.ph) * 36;
        const k = 1 - Math.exp(-dt * 1.4);
        c.x += (tx - c.x) * k;
        c.y += (ty - c.y) * k;
      } else {
        // Watchers drift after a busy worker, switching every few seconds.
        const busy = this.cursors.filter((x) => x.worker && x.job);
        c.sw -= dt;
        let tx;
        let ty;
        if (busy.length) {
          if (c.sw <= 0 || !this.cursors[c.tgt].job) {
            c.tgt = busy[(c.f + Math.floor(this.t / 2.6)) % busy.length].f;
            c.sw = 2 + Math.random() * 2;
            const a = Math.random() * 6.28;
            const d = 70 + Math.random() * 70;
            c.ox = Math.cos(a) * d; c.oy = Math.sin(a) * d * 0.6;
          }
          const t = this.cursors[c.tgt];
          tx = t.x + c.ox; ty = t.y + c.oy;
        } else {
          tx = this.w * (0.08 + 0.84 * ((c.f * 0.29 + 0.13) % 1)); ty = this.h * (0.2 + 0.6 * ((c.f * 0.53 + 0.3) % 1));
        }
        const k = 1 - Math.exp(-dt * 2);
        c.x += (tx - c.x) * k;
        c.y += (ty - c.y) * k;
      }
      c.a += ((c.worker && c.job ? 1 : 0.85) - c.a) * (1 - Math.exp(-dt * 5));
    }
    const done = this.jobs.filter((j) => j.state === "done").length;
    const pct = this.bar.querySelector("#mcbPct");
    if (pct) pct.textContent = `${Math.round((done / this.jobs.length) * 100)}%`;
    // Everything in view is built and the rest is below the fold: say how to go on.
    this.idleT = this.cursors.some((c) => c.job) ? 0 : (this.idleT || 0) + dt;
    const waiting = this.idleT > 0.8 && done < this.jobs.length;
    const label = this.bar.querySelector(".mcb-txt b");
    if (label) label.textContent = waiting ? "向下滚动，继续搭建" : "正在搭建评测体系";
    const tool = this.cursors.find((c) => c.worker && c.job)?.tool || "arrow";
    this.bar.querySelectorAll(".mcb-tools i").forEach((i) => i.classList.toggle("on", i.dataset.t === tool));
    if (done === this.jobs.length) this.finish(false);
  }

  ripple(x, y, col) { this.ripples.push({ x, y, col, t: 0 }); }

  /* ------------------------------------------------------------ drawing */
  draw() {
    const { ctx, dpr } = this;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);
    if (this.board) this.box(this.board.x, this.board.y, this.board.w, this.board.h, this.board.col, "评测体系", 1);
    if (this.phase === "build") {
      for (const j of this.jobs) {
        const fade = j.state === "done" ? 1 - (this.t - j.doneAt) / 0.6 : j.state === "work" ? 1 : 0;
        if (fade <= 0 || !j.cursor) continue;
        const r = j.el.getBoundingClientRect();
        if (r.bottom < 0 || r.top > this.h) continue;
        const k = j.state === "done" ? 1 : easeInOut(j.s);
        if (j.kind === "text") {
          this.box(r.left - 2, r.top - 2, r.width * k + 4, r.height + 4, j.cursor.col, j.label, fade, false);
        } else {
          this.box(r.left, r.top, r.width * k, r.height * k, j.cursor.col, j.label, fade, true);
        }
      }
    }
    for (let i = this.ripples.length - 1; i >= 0; i--) {
      const p = this.ripples[i];
      p.t += 1 / 60;
      if (p.t > 0.45) { this.ripples.splice(i, 1); continue; }
      const u = p.t / 0.45;
      ctx.globalAlpha = (1 - u) * 0.7;
      ctx.strokeStyle = p.col;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 3 + u * 14, 0, 6.283);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    this.cursors.forEach((c) => this.cursor(c));
  }

  box(x, y, w, h, col, label, alpha, dims = true) {
    const { ctx } = this;
    if (w < 1 || h < 1) return;
    ctx.globalAlpha = alpha;
    ctx.fillStyle = `${col}14`;
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = col;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, Math.round(w), Math.round(h));
    ctx.fillStyle = "#fff";
    [[x, y], [x + w, y], [x, y + h], [x + w, y + h]].forEach(([px, py]) => {
      ctx.fillRect(px - 3, py - 3, 6, 6);
      ctx.strokeRect(px - 3 + 0.5, py - 3 + 0.5, 5, 5);
    });
    const text = dims ? `${label}  ${Math.round(w)} × ${Math.round(h)}` : label;
    ctx.font = "500 11px ui-sans-serif, system-ui, -apple-system, 'PingFang SC', sans-serif";
    const tw = ctx.measureText(text).width + 12;
    const ly = y > 26 ? y - 22 : y + 4;
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.roundRect(x, ly, tw, 18, 4);
    ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.fillText(text, x + 6, ly + 12.5);
    ctx.globalAlpha = 1;
  }

  cursor(c) {
    const { ctx } = this;
    const x = clamp(c.x, 4, this.w - 4);
    const y = clamp(c.y, 60, this.h - 8);
    ctx.save();
    ctx.globalAlpha = c.a;
    ctx.translate(x, y);
    ctx.lineJoin = "round";
    if (c.tool === "ibeam") {
      ctx.strokeStyle = "#fff"; ctx.lineWidth = 4;
      ctx.beginPath(); ctx.moveTo(-3, -9); ctx.lineTo(3, -9); ctx.moveTo(0, -9); ctx.lineTo(0, 9); ctx.moveTo(-3, 9); ctx.lineTo(3, 9); ctx.stroke();
      ctx.strokeStyle = c.col; ctx.lineWidth = 1.6; ctx.stroke();
    } else if (c.tool === "cross") {
      ctx.strokeStyle = "#fff"; ctx.lineWidth = 4;
      ctx.beginPath(); ctx.moveTo(-8, 0); ctx.lineTo(8, 0); ctx.moveTo(0, -8); ctx.lineTo(0, 8); ctx.stroke();
      ctx.strokeStyle = c.col; ctx.lineWidth = 1.6; ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.moveTo(0, 0); ctx.lineTo(0, 15); ctx.lineTo(4, 11.4); ctx.lineTo(7, 17.6); ctx.lineTo(9.4, 16.5); ctx.lineTo(6.6, 10.6); ctx.lineTo(11.6, 10.6);
      ctx.closePath();
      ctx.fillStyle = c.col;
      ctx.shadowColor = "rgba(0,0,0,.18)"; ctx.shadowBlur = 4; ctx.shadowOffsetY = 1;
      ctx.fill();
      ctx.shadowColor = "transparent";
      ctx.strokeStyle = "#fff"; ctx.lineWidth = 1.4; ctx.stroke();
    }
    ctx.font = "500 11px ui-sans-serif, system-ui, -apple-system, 'PingFang SC', sans-serif";
    const tw = ctx.measureText(c.name).width + 12;
    ctx.fillStyle = c.col;
    ctx.beginPath();
    ctx.roundRect(12, 16, tw, 18, 9);
    ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.fillText(c.name, 18, 28.5);
    ctx.restore();
  }
}

