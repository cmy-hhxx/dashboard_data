/* Pixel day–night toggle: a pill switch whose knob carries a pixel-art moon (night, left) or sun
   (day, right). Flipping it bursts the pixels apart; they swarm while the knob slides and settle
   into the other icon, while a band of light runs round the knob's rim. The knob can be dragged
   (a flick decides by its speed), the pixels shy away from the pointer, and the track, knob and
   glow all blend between the night and day colours as the knob travels.

   The element is a real button with role="switch"; Space / Enter toggle it. Reduced motion keeps
   the switch but jumps straight to the end state with no particles. */
import { REDUCED } from "./core.js";

const TAU = Math.PI * 2;
const W = 52;           // track
const H = 28;
const KNOB = 22;
const PAD = 14;         // canvas margin for the glow
const TRAVEL = W - 6 - KNOB;
const CELL = 2;         // one pixel of the icon, in CSS px
const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const mixRGB = (a, b, t) => a.map((x, i) => Math.round(lerp(x, b[i], t)));
const rgba = (c, a = 1) => `rgba(${c.join(",")},${a})`;

const NIGHT_DAY = {
  trackTop: [[11, 13, 20], [226, 224, 219]],
  trackBottom: [[22, 25, 36], [240, 238, 233]],
  trackRim: [[38, 41, 54], [255, 255, 255]],
  knobTop: [[154, 159, 189], [255, 255, 255]],
  knobBottom: [[74, 77, 99], [242, 239, 233]],
  pixel: [[236, 238, 255], [60, 56, 53]],
};
const BAND = [[[112, 110, 255], [224, 225, 255]], [[255, 168, 18], [255, 232, 150]]];

/* Icons as cell lists [x, y, opacity] around the knob's centre. */
function moon() {
  const out = [];
  for (let y = -5; y <= 5; y++) {
    for (let x = -5; x <= 5; x++) {
      if (Math.hypot(x + 0.4, y + 0.3) > 4.2) continue;
      const bite = Math.hypot(x - 1.5, y + 1.5);
      if (bite > 3.1) out.push([x, y, 1]);
      else if (bite > 2.6 && (x + y) % 2 === 0) out.push([x, y, 0.35]);
    }
  }
  return out.concat([[3, -4, 0.8], [4, -2, 0.45], [2, -5, 0.4]]);
}
function sun() {
  const out = [];
  for (let y = -3; y <= 3; y++) for (let x = -3; x <= 3; x++) if (Math.hypot(x, y) <= 2.3) out.push([x, y, 1]);
  for (let k = 0; k < 8; k++) {
    const a = (k * Math.PI) / 4;
    (k % 2 ? [3.7] : [3.7, 4.6]).forEach((r) => out.push([Math.round(Math.cos(a) * r), Math.round(Math.sin(a) * r), k % 2 ? 0.7 : 0.9]));
  }
  return out;
}
const ICONS = [moon(), sun()];
const COUNT = Math.max(...ICONS.map((i) => i.length)) + 8;

function swarm() {
  const ps = Array.from({ length: COUNT }, () => {
    const a = Math.random() * TAU;
    const r = Math.sqrt(Math.random()) * 7.5;
    return { sx: Math.cos(a) * r, sy: Math.sin(a) * r * 0.85, x: 0, y: 0, vx: 0, vy: 0, tx: 0, ty: 0, o: 0, to: 0, ph: Math.random() * TAU };
  });
  let icon = -1;
  const assign = (k, snap) => {
    icon = k;
    const cells = ICONS[k].slice();
    for (let i = cells.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [cells[i], cells[j]] = [cells[j], cells[i]]; }
    ps.forEach((p, i) => {
      const c = cells[i];
      p.tx = c ? c[0] : p.sx;
      p.ty = c ? c[1] : p.sy;
      p.to = c ? c[2] : 0;
      if (snap) { p.x = p.tx; p.y = p.ty; p.o = p.to; p.vx = p.vy = 0; }
    });
  };
  const burst = (s) => ps.forEach((p) => {
    const a = Math.random() * TAU;
    const v = (2 + Math.random() * 7) * s;
    p.vx += Math.cos(a) * v * 10;
    p.vy += Math.sin(a) * v * 10;
  });
  /* mix: 0 night … 1 day; scatter: extra spread from a recent burst; poke: pointer in cells */
  const advance = (mix, scatter, poke, dt) => {
    const k = mix > 0.5 ? 1 : 0;
    if (k !== icon) assign(k, false);
    const spread = Math.max(scatter, clamp(1 - Math.abs(2 * mix - 1) * 1.6));
    let moving = false;
    ps.forEach((p) => {
      p.ph += dt * 2;
      const gx = lerp(p.tx, p.sx, spread) + Math.sin(p.ph) * spread * 0.8;
      const gy = lerp(p.ty, p.sy, spread) + Math.cos(p.ph * 0.8) * spread * 0.8;
      p.vx += ((gx - p.x) * 340 - p.vx * 27) * dt;
      p.vy += ((gy - p.y) * 340 - p.vy * 27) * dt;
      if (poke) {
        const dx = p.x - poke.x;
        const dy = p.y - poke.y;
        const d = Math.hypot(dx, dy);
        if (d > 0 && d < 4) { const f = (1 - (d / 4) ** 2) * 600 * dt / d; p.vx += dx * f; p.vy += dy * f; }
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      const goal = Math.max(p.to * (1 - spread * 0.25), spread * 0.55);
      p.o = lerp(p.o, goal, Math.min(1, dt * (goal > p.o ? 9 : 12)));
      moving = moving || Math.abs(gx - p.x) + Math.abs(gy - p.y) > 0.04 || Math.abs(p.vx) + Math.abs(p.vy) > 0.3 || Math.abs(goal - p.o) > 0.01;
    });
    return { moving, spread };
  };
  const draw = (ctx, cx, cy, color) => {
    ps.forEach((p) => {
      if (p.o < 0.02) return;
      const sp = clamp(Math.hypot(p.vx, p.vy) / 140);
      const s = CELL * 0.82 * (1 - sp * 0.35);
      ctx.fillStyle = rgba(color, p.o * (1 - sp * 0.2));
      ctx.fillRect(cx + p.x * CELL - s / 2, cy + p.y * CELL - s / 2, s * (1 + sp * 0.6), s);
    });
  };
  return { assign, burst, advance, draw };
}

/* el: the button to turn into the switch; day: initial state; onChange(day, el) when the user flips it. */
export function pixelToggle(el, { day = false, onChange } = {}) {
  el.classList.add("px-toggle");
  el.setAttribute("role", "switch");
  el.innerHTML = '<span class="px-track" aria-hidden="true"></span><canvas class="px-fx" aria-hidden="true"></canvas>';
  const cv = el.querySelector("canvas");
  const ctx = cv.getContext("2d");
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  cv.width = Math.round((W + PAD * 2) * dpr);
  cv.height = Math.round((H + PAD * 2) * dpr);
  const px = swarm();
  let on = !!day;
  let pos = Number(on);   // knob position 0..1
  let vel = 0;
  let mix = pos;          // colour blend, lags the knob a touch
  let band = on ? 0.5 : 0; // band phase around the rim
  let bandTo = band;
  let flash = 0;
  let scatter = 0;
  let raf = 0;
  let last = 0;
  let drag = null;
  let dragged = false;
  let poke = null;

  const label = () => {
    el.setAttribute("aria-checked", String(on));
    el.setAttribute("aria-label", "日间模式");
    el.title = on ? "切到深色模式（可拖动）" : "切到浅色模式（可拖动）";
  };
  const colours = () => {
    const c = (k) => mixRGB(NIGHT_DAY[k][0], NIGHT_DAY[k][1], mix);
    el.style.setProperty("--px-top", rgba(c("trackTop")));
    el.style.setProperty("--px-bottom", rgba(c("trackBottom")));
    el.style.setProperty("--px-rim", rgba(c("trackRim"), lerp(0.4, 1, mix)));
  };
  const draw = () => {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W + PAD * 2, H + PAD * 2);
    const stretch = Math.min(0.22, Math.abs(vel) * 0.05);
    const kw = KNOB * (1 + stretch);
    const kh = KNOB * (1 - stretch * 0.4);
    const cx = PAD + 3 + KNOB / 2 + pos * TRAVEL;
    const cy = PAD + H / 2;
    // the band of light: a short glowing arc that runs round the knob as the switch flips
    const b0 = mixRGB(BAND[0][0], BAND[1][0], mix);
    const b1 = mixRGB(BAND[0][1], BAND[1][1], mix);
    const head = band * TAU - Math.PI / 2;
    const len = TAU * (0.3 + 0.1 * flash);
    ctx.save();
    ctx.globalCompositeOperation = mix < 0.55 ? "lighter" : "source-over";
    [[9, 0.32, 10], [4, 0.6, 4], [1.8, 0.95, 0]].forEach(([w, a, blur]) => {
      ctx.beginPath();
      ctx.ellipse(cx, cy, kw / 2 + 2.5, kh / 2 + 2.5, 0, head - len, head);
      ctx.strokeStyle = rgba(w > 2 ? b0 : b1, a * lerp(0.75, 0.55, mix) * (0.7 + 0.3 * flash));
      ctx.lineWidth = w;
      ctx.lineCap = "round";
      ctx.shadowColor = rgba(b0, 0.9);
      ctx.shadowBlur = blur;
      ctx.stroke();
    });
    ctx.restore();
    // the knob
    const g = ctx.createLinearGradient(0, cy - kh / 2, 0, cy + kh / 2);
    g.addColorStop(0, rgba(mixRGB(NIGHT_DAY.knobTop[0], NIGHT_DAY.knobTop[1], mix)));
    g.addColorStop(1, rgba(mixRGB(NIGHT_DAY.knobBottom[0], NIGHT_DAY.knobBottom[1], mix)));
    ctx.save();
    ctx.shadowColor = `rgba(0,0,0,${lerp(0.45, 0.22, mix)})`;
    ctx.shadowBlur = 6;
    ctx.shadowOffsetY = 2;
    ctx.beginPath();
    ctx.ellipse(cx, cy, kw / 2, kh / 2, 0, 0, TAU);
    ctx.fillStyle = g;
    ctx.fill();
    ctx.restore();
    ctx.beginPath();
    ctx.ellipse(cx, cy, kw / 2 - 0.5, kh / 2 - 0.5, 0, 0, TAU);
    ctx.strokeStyle = `rgba(255,255,255,${lerp(0.28, 0.7, mix)})`;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.save();
    ctx.beginPath();
    ctx.ellipse(cx, cy, kw / 2, kh / 2, 0, 0, TAU);
    ctx.clip();
    px.draw(ctx, cx + 0.5, cy, mixRGB(NIGHT_DAY.pixel[0], NIGHT_DAY.pixel[1], mix));
    ctx.restore();
    colours();
  };

  const settle = () => {
    pos = Number(on); vel = 0; mix = pos; band = bandTo; flash = 0; scatter = 0;
    px.assign(Number(on), true);
    draw();
  };
  const tick = (now) => {
    raf = 0;
    const dt = last ? clamp((now - last) / 1000, 0.001, 0.033) : 1 / 60;
    last = now;
    if (!drag) {
      // the knob: a critically-ish damped spring to its end
      for (let i = 0; i < 4; i++) { vel += ((Number(on) - pos) * 380 - vel * 26.5) * (dt / 4); pos += vel * (dt / 4); }
      if (Math.abs(pos - Number(on)) < 1e-4 && Math.abs(vel) < 1e-3) { pos = Number(on); vel = 0; }
    }
    mix = lerp(mix, drag ? clamp(pos) : Number(on), 1 - Math.exp(-dt * (drag ? 18 : 9)));
    if (Math.abs(mix - (drag ? clamp(pos) : Number(on))) < 1e-3) mix = drag ? clamp(pos) : Number(on);
    band = lerp(band, bandTo, 1 - Math.exp(-dt * 5));
    flash = Math.max(0, flash - dt * 2.2);
    scatter = Math.max(drag ? 0.25 : 0, scatter - dt * 6);
    const { moving } = px.advance(clamp(mix), scatter, poke, dt);
    draw();
    const busy = moving || drag || flash > 0 || scatter > 0 || Math.abs(band - bandTo) > 1e-3 || pos !== Number(on) || mix !== Number(on);
    if (busy) raf = requestAnimationFrame(tick); else last = 0;
  };
  const run = () => { if (!raf && !REDUCED) raf = requestAnimationFrame(tick); };

  const set = (next, user) => {
    const changed = next !== on;
    on = next;
    label();
    if (REDUCED) settle();
    else {
      bandTo += 0.46 * (changed ? 1 : 0);
      flash = 1;
      scatter = 0.9;
      px.burst(1);
      run();
    }
    if (changed && user) onChange?.(on, el);
  };

  // pointer: a click flips it; a drag slides the knob and decides on release
  const local = (e) => {
    const r = el.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  el.addEventListener("pointerdown", (e) => {
    if (!e.isPrimary || e.button !== 0) return;
    const p = local(e);
    drag = { id: e.pointerId, x0: p.x, pos0: pos, x: p.x, at: performance.now(), v: 0, active: false };
    dragged = false;
    el.setPointerCapture(e.pointerId);
    if (!REDUCED) { scatter = 0.3; px.burst(0.3); run(); }
  });
  el.addEventListener("pointermove", (e) => {
    const p = local(e);
    const cx = 3 + KNOB / 2 + pos * TRAVEL;
    poke = e.pointerType === "touch" && !drag ? null : { x: (p.x - cx) / CELL, y: (p.y - H / 2) / CELL };
    if (drag && e.pointerId === drag.id) {
      const dx = p.x - drag.x0;
      if (!drag.active && Math.abs(dx) > 3) { drag.active = true; el.dataset.dragging = ""; }
      if (drag.active) {
        const raw = drag.pos0 + dx / TRAVEL;
        const next = raw < 0 ? -((-raw) ** 0.6) * 0.05 : raw > 1 ? 1 + (raw - 1) ** 0.6 * 0.05 : raw;
        const now = performance.now();
        const dtm = Math.max(1, now - drag.at);
        drag.v = lerp(drag.v, (p.x - drag.x) / dtm, 0.5);
        vel = lerp(vel, ((next - pos) * 1000) / dtm, 0.5);
        drag.x = p.x;
        drag.at = now;
        pos = next;
        if (REDUCED) { mix = clamp(pos); px.assign(mix >= 0.5 ? 1 : 0, true); draw(); }
      }
    }
    run();
  });
  el.addEventListener("pointerleave", () => { poke = null; run(); });
  const release = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag;
    drag = null;
    delete el.dataset.dragging;
    if (!d.active) return;
    dragged = true;
    const flick = performance.now() - d.at <= 120 && Math.abs(d.v) > 0.6;
    const next = e.type === "pointerup" ? (flick ? d.v > 0 : pos >= 0.5) : on;
    set(next, e.type === "pointerup");
    if (REDUCED) settle();
  };
  el.addEventListener("pointerup", release);
  el.addEventListener("pointercancel", release);
  el.addEventListener("lostpointercapture", release);
  el.addEventListener("click", (e) => {
    if (e.detail && dragged) { dragged = false; return; }
    set(!on, true);
  });
  document.addEventListener("visibilitychange", () => { if (document.hidden) { cancelAnimationFrame(raf); raf = 0; last = 0; settle(); } });

  label();
  settle();
  return {
    /* follow a theme change made elsewhere (another tab, the OS) without firing onChange */
    set(next) { if (next !== on) set(next, false); },
    get on() { return on; },
    knob() {
      const r = el.getBoundingClientRect();
      return { x: r.left + 3 + KNOB / 2 + pos * TRAVEL, y: r.top + H / 2 };
    },
  };
}
