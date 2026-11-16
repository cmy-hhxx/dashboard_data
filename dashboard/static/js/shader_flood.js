/* Liquid flood cards: a live liquid texture fills a card from the point the pointer came in at and
   drains back out towards the point it left by. One canvas sits over the whole card grid, between
   the cards' backgrounds and their text; each card is one scissored draw of the same fragment
   shader with its own three-colour palette, seed and reveal circle. No WebGL (or no derivatives
   extension) falls back to a 2D canvas with a gradient and drawn currents under the same circle.

   Motion: the reveal eases out over ~0.5 s and the liquid drifts while any card is wet. Reduced
   motion keeps the interaction but snaps the reveal and freezes the liquid. */
import { REDUCED } from "./core.js";

const VERT = "attribute vec2 p;varying vec2 v;void main(){v=p*.5+.5;gl_Position=vec4(p,0.,1.);}";
const FRAG = `#extension GL_OES_standard_derivatives : enable
precision highp float;
varying vec2 v;
uniform vec2 uSize, uFrom;
uniform float uFill, uTime, uSeed, uRadius;
uniform vec3 uDeep, uBody, uFoam;
float h21(vec2 x){ x = fract(x * vec2(123.34, 456.21)); x += dot(x, x + 45.32); return fract(x.x * x.y); }
float vnoise(vec2 x){
  vec2 i = floor(x), f = fract(x);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1.0, 0.0)), u.x), mix(h21(i + vec2(0.0, 1.0)), h21(i + vec2(1.0)), u.x), u.y);
}
float fbm(vec2 x){
  float s = 0.0, a = 0.52;
  mat2 r = mat2(0.82, 0.57, -0.57, 0.82);
  for (int k = 0; k < 4; k++) { s += a * vnoise(x); x = r * x * 2.02 + vec2(3.1, 7.7); a *= 0.5; }
  return s;
}
void main(){
  vec2 px = vec2(v.x, 1.0 - v.y) * uSize;
  // the card's rounded outline, so the liquid never spills past its corners
  vec2 e = abs(px - uSize * 0.5) - (uSize * 0.5 - 1.0) + uRadius;
  float box = length(max(e, 0.0)) + min(max(e.x, e.y), 0.0) - uRadius;
  // the reveal: a circle from the entry point that reaches the far corner at uFill = 1
  float reach = uFill * 1.08 * length(uSize);
  float disc = length(px - uFrom * uSize) - reach;
  float alpha = (1.0 - smoothstep(-0.7, 0.7, box)) * (1.0 - smoothstep(-0.7, 0.7, disc));
  if (alpha < 0.002) discard;
  // domain-warped noise: two warp passes give the slow, folded look of a poured liquid
  vec2 q = (v - 0.5) * vec2(uSize.x / uSize.y, 1.0) * 2.3 + uSeed * vec2(0.19, 0.11);
  float t = uTime * 0.14;
  vec2 w1 = vec2(fbm(q + vec2(0.2 * t, -0.15 * t)), fbm(q + vec2(4.9, 1.7) - vec2(0.17 * t, -0.21 * t))) - 0.5;
  vec2 w2 = vec2(fbm(q + 3.2 * w1 + vec2(1.4, 8.8) + 0.12 * t), fbm(q + 3.2 * w1 + vec2(7.6, 2.4) - 0.11 * t)) - 0.5;
  float f = fbm(q + 2.9 * w2 + 1.1 * w1);
  float g = smoothstep(0.16, 0.78, f);
  vec3 col = mix(uDeep, uBody, smoothstep(0.04, 0.58, g));
  col = mix(col, uFoam, pow(smoothstep(0.7, 0.99, g), 1.6) * 0.6);
  // thin dark folds along two level sets, and a faint sheen where the field is flat
  float fold = (1.0 - smoothstep(0.006, 0.032, abs(f - 0.44))) * 0.85 + (1.0 - smoothstep(0.003, 0.016, abs(f - 0.6))) * 0.22;
  col = mix(col, uDeep * 0.3, min(fold, 0.92));
  float slope = length(vec2(dFdx(f), dFdy(f))) * uSize.y * 0.17;
  col += uFoam * pow(max(0.0, 1.0 - slope * 2.0), 8.0) * 0.03;
  // darker towards the bottom, where the text sits
  col *= mix(0.26, 1.1, smoothstep(-0.06, 1.0, v.y));
  gl_FragColor = vec4(col, alpha);
}`;

const hex = (h) => {
  const s = h.replace("#", "");
  const f = s.length === 3 ? [...s].map((c) => c + c).join("") : s;
  return [0, 2, 4].map((i) => parseInt(f.slice(i, i + 2), 16) / 255);
};

function glRenderer(canvas) {
  const gl = canvas.getContext("webgl", { alpha: true, antialias: false, premultipliedAlpha: false, depth: false, stencil: false, powerPreference: "low-power" });
  if (!gl || !gl.getExtension("OES_standard_derivatives")) return null;
  const sh = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  };
  const prog = gl.createProgram();
  try {
    const vs = sh(gl.VERTEX_SHADER, VERT);
    const fs = sh(gl.FRAGMENT_SHADER, FRAG);
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
  } catch (err) {
    return null;
  }
  gl.useProgram(prog);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, "p");
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const u = Object.fromEntries(["uSize", "uFrom", "uFill", "uTime", "uSeed", "uRadius", "uDeep", "uBody", "uFoam"].map((n) => [n, gl.getUniformLocation(prog, n)]));
  return {
    mode: "webgl",
    draw(cards, time, dpr) {
      gl.disable(gl.SCISSOR_TEST);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.enable(gl.SCISSOR_TEST);
      cards.forEach((c) => {
        if (c.fill <= 0) return;
        const x = Math.round(c.x * dpr);
        const y = canvas.height - Math.round((c.y + c.h) * dpr);
        const w = Math.round(c.w * dpr);
        const h = Math.round(c.h * dpr);
        gl.viewport(x, y, w, h);
        gl.scissor(x, y, w, h);
        gl.uniform2f(u.uSize, c.w, c.h);
        gl.uniform2f(u.uFrom, c.from[0], c.from[1]);
        gl.uniform1f(u.uFill, c.fill);
        gl.uniform1f(u.uTime, time);
        gl.uniform1f(u.uSeed, c.seed);
        gl.uniform1f(u.uRadius, c.r);
        gl.uniform3fv(u.uDeep, c.pal[0]);
        gl.uniform3fv(u.uBody, c.pal[1]);
        gl.uniform3fv(u.uFoam, c.pal[2]);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
      });
      gl.disable(gl.SCISSOR_TEST);
    },
    destroy() {
      gl.deleteBuffer(buf);
      gl.deleteProgram(prog);
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    },
  };
}

function flatRenderer(canvas) {
  const ctx = canvas.getContext("2d");
  const rgb = (c) => `rgb(${c.map((x) => Math.round(x * 255)).join(",")})`;
  return {
    mode: "canvas2d",
    draw(cards, time, dpr) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr);
      cards.forEach((c) => {
        if (c.fill <= 0) return;
        ctx.save();
        ctx.translate(c.x, c.y);
        ctx.beginPath();
        ctx.roundRect(1, 1, c.w - 2, c.h - 2, c.r);
        ctx.clip();
        ctx.beginPath();
        ctx.arc(c.from[0] * c.w, c.from[1] * c.h, c.fill * 1.08 * Math.hypot(c.w, c.h), 0, Math.PI * 2);
        ctx.clip();
        const g = ctx.createLinearGradient(0, c.h, c.w * 0.3, 0);
        c.pal.forEach((col, i) => g.addColorStop(i / 2, rgb(col)));
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, c.w, c.h);
        for (let k = 0; k < 20; k++) {
          const ph = k * 0.87 + c.seed * 0.41 + time * 0.2;
          ctx.beginPath();
          for (let i = 0; i <= 24; i++) {
            const x = (i / 24) * c.w;
            const y = (k / 19) * c.h + Math.sin(i * 0.45 + ph) * 22 + Math.sin(i * 0.9 - ph * 0.7) * 10;
            if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
          }
          ctx.strokeStyle = k % 3 ? "#00000026" : "#ffffff30";
          ctx.lineWidth = k % 3 ? 3 : 7;
          ctx.stroke();
        }
        const shade = ctx.createLinearGradient(0, c.h * 0.35, 0, c.h);
        shade.addColorStop(0, "#0000");
        shade.addColorStop(1, "#0009");
        ctx.fillStyle = shade;
        ctx.fillRect(0, 0, c.w, c.h);
        ctx.restore();
      });
    },
    destroy() {},
  };
}

/* stage: the element the cards sit in; nodes: the card elements; palettes: [[deep, body, foam]]
   per card. Returns { destroy }. */
export function floodCards(stage, nodes, { palettes, radius = 24, onOpen } = {}) {
  const canvas = document.createElement("canvas");
  canvas.className = "sf-canvas";
  canvas.setAttribute("aria-hidden", "true");
  stage.prepend(canvas);
  let gfx = null;
  try { gfx = glRenderer(canvas); } catch (err) { gfx = null; }
  if (!gfx) {
    const flat = canvas.cloneNode();
    canvas.replaceWith(flat);
    gfx = flatRenderer(flat);
    gfx.canvas = flat;
  } else gfx.canvas = canvas;
  let cv = gfx.canvas;
  stage.dataset.renderer = gfx.mode;
  const cards = nodes.map((node, i) => ({
    node, i, pal: (palettes[i % palettes.length]).map(hex), seed: 3.7 + i * 7.31, r: radius,
    from: [0.5, 0.5], fill: 0, start: 0, to: 0, at: 0, dur: 520, x: 0, y: 0, w: 0, h: 0,
  }));
  let dpr = 1;
  let raf = 0;
  let last = 0;
  let time = 0;
  let visible = true;
  let dead = false;

  const measure = () => {
    const s = stage.getBoundingClientRect();
    cards.forEach((c) => {
      const r = c.node.getBoundingClientRect();
      Object.assign(c, { x: r.left - s.left, y: r.top - s.top, w: r.width, h: r.height });
    });
    dpr = Math.min(1.5, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(s.width * dpr));
    const h = Math.max(1, Math.round(s.height * dpr));
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  };
  const paint = () => {
    gfx.draw(cards, REDUCED ? 0 : time, dpr);
    cards.forEach((c) => {
      c.node.dataset.state = c.fill === c.to ? (c.to ? "active" : "idle") : c.to ? "entering" : "leaving";
    });
  };
  const busy = () => cards.some((c) => c.fill !== c.to || (!REDUCED && c.fill > 0));
  const frame = (now) => {
    raf = 0;
    if (dead || !visible || document.hidden) return;
    const dt = last ? Math.min((now - last) / 1000, 0.08) : 0;
    last = now;
    time += dt;
    cards.forEach((c) => {
      if (c.fill === c.to) return;
      const k = Math.min(1, (now - c.at) / c.dur);
      c.fill = k >= 1 ? c.to : c.start + (c.to - c.start) * (1 - (1 - k) ** 3);
    });
    paint();
    kick();
  };
  const kick = () => {
    if (!raf && !dead && visible && !document.hidden && busy()) raf = requestAnimationFrame(frame);
    if (!busy()) last = 0;
  };
  const set = (c, on, from = [0.5, 0.5]) => {
    c.from = from;
    c.start = c.fill;
    c.to = on ? 1 : 0;
    c.at = performance.now();
    c.dur = on ? 520 : 420;
    c.node.dataset.active = String(on);
    if (REDUCED) c.fill = c.to;
    paint();
    kick();
  };
  const at = (c, e) => {
    const r = c.node.getBoundingClientRect();
    return [Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), Math.max(0, Math.min(1, (e.clientY - r.top) / r.height))];
  };
  const cardOf = (e) => {
    const n = e.target.closest?.("[data-flood]");
    return n ? cards.find((c) => c.node === n) : null;
  };
  const on = [];
  const listen = (el, type, fn, opt) => { el.addEventListener(type, fn, opt); on.push([el, type, fn, opt]); };
  listen(stage, "pointerover", (e) => {
    if (e.pointerType === "touch") return;
    const c = cardOf(e);
    if (c && !c.node.contains(e.relatedTarget)) set(c, true, at(c, e));
  });
  listen(stage, "pointerout", (e) => {
    if (e.pointerType === "touch") return;
    const c = cardOf(e);
    if (c && !c.node.contains(e.relatedTarget) && document.activeElement !== c.node) set(c, false, at(c, e));
  });
  // Touch: the first tap pours the card from the finger, then opens it once the liquid is in.
  listen(stage, "pointerdown", (e) => {
    if (e.pointerType !== "touch") return;
    const c = cardOf(e);
    if (!c) return;
    cards.forEach((x) => x !== c && x.to && set(x, false));
    set(c, true, at(c, e));
  });
  listen(stage, "click", (e) => {
    const c = cardOf(e);
    if (!c) return;
    e.preventDefault();
    const touch = e.pointerType === "touch" || (e.sourceCapabilities && e.sourceCapabilities.firesTouchEvents);
    if (touch && !REDUCED) setTimeout(() => !dead && onOpen?.(c.i, c.node), 380);
    else onOpen?.(c.i, c.node);
  });
  listen(stage, "focusin", (e) => {
    const c = cardOf(e);
    if (c && c.node.matches(":focus-visible")) set(c, true);
  });
  listen(stage, "focusout", (e) => {
    const c = cardOf(e);
    if (c && !c.node.matches(":hover")) set(c, false);
  });
  listen(stage, "keydown", (e) => {
    if (e.key === "Escape") { cards.forEach((c) => c.to && set(c, false)); return; }
    const c = cardOf(e);
    if (!c) return;
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    const to = step != null ? (c.i + step + cards.length) % cards.length : e.key === "Home" ? 0 : e.key === "End" ? cards.length - 1 : null;
    if (to == null) return;
    e.preventDefault();
    cards[to].node.focus();
  });
  listen(document, "visibilitychange", () => (document.hidden ? (cancelAnimationFrame(raf), raf = 0) : kick()));
  if (gfx.mode === "webgl") {
    listen(cv, "webglcontextlost", (e) => {
      e.preventDefault();
      const f = cv.cloneNode();
      cv.replaceWith(f);
      cv = f;
      gfx = flatRenderer(f);
      measure();
      paint();
    });
  }
  const ro = new ResizeObserver(() => { measure(); paint(); });
  ro.observe(stage);
  const io = new IntersectionObserver(([en]) => { visible = en.isIntersecting; if (visible) kick(); });
  io.observe(stage);
  measure();
  paint();
  return {
    destroy() {
      dead = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      io.disconnect();
      on.forEach(([el, type, fn, opt]) => el.removeEventListener(type, fn, opt));
      gfx.destroy();
      stage.querySelector(".sf-canvas")?.remove();
    },
  };
}
