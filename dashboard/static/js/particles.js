/* 证据流: a few particles travel each evidence thread, from the cited message to the problem it
   supports. It reads the threads' own SVG paths every frame, so it follows each redraw without
   being told; density stays low (two per thread, fewer when crowded), a focused problem's threads
   run brighter and the rest fade. The loop sleeps while the threads are off screen or the tab is
   hidden, and nothing runs under reduced motion. */
import { REDUCED } from "./core.js";

const SPEED = 70; // px per second along the thread
const CURVE = /M\s*([-\d.]+)\s+([-\d.]+)\s*C\s*([-\d.]+)\s+([-\d.]+),?\s*([-\d.]+)\s+([-\d.]+),?\s*([-\d.]+)\s+([-\d.]+)/;

function bezier(p, t) {
  const u = 1 - t;
  const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
  return [a * p[0] + b * p[2] + c * p[4] + d * p[6], a * p[1] + b * p[3] + c * p[5] + d * p[7]];
}

export function threadFlow(svg) {
  const host = svg && svg.parentElement;
  if (REDUCED || !host) return { destroy() {} };
  const canvas = document.createElement("canvas");
  canvas.className = "flow-canvas";
  canvas.setAttribute("aria-hidden", "true");
  host.appendChild(canvas);
  const ctx = canvas.getContext("2d");
  const cache = new Map(); // d → {pts, len}
  const tint = new WeakMap(); // path → resolved stroke colour
  let raf = 0;
  let visible = true;
  let alive = true;

  const geometry = (d) => {
    let g = cache.get(d);
    if (!g) {
      const m = CURVE.exec(d);
      if (!m) return null;
      const pts = m.slice(1).map(Number);
      let len = 0;
      let prev = bezier(pts, 0);
      for (let i = 1; i <= 12; i += 1) {
        const q = bezier(pts, i / 12);
        len += Math.hypot(q[0] - prev[0], q[1] - prev[1]);
        prev = q;
      }
      g = { pts, len: Math.max(24, len) };
      if (cache.size > 600) cache.clear();
      cache.set(d, g);
    }
    return g;
  };

  function frame(now) {
    raf = 0;
    if (!alive) return;
    if (!svg.isConnected) return destroy();
    const W = host.clientWidth;
    const H = host.clientHeight;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const paths = svg.querySelectorAll("path");
    const focused = !!host.closest(".is-focus");
    const per = paths.length > 40 ? 1 : 2;
    const t0 = now / 1000;
    paths.forEach((path, k) => {
      const g = geometry(path.getAttribute("d") || "");
      if (!g) return;
      const on = path.classList.contains("on");
      if (focused && !on) return;
      let color = tint.get(path);
      if (!color) {
        color = getComputedStyle(path).stroke;
        tint.set(path, color);
      }
      ctx.fillStyle = color;
      const period = g.len / SPEED;
      for (let i = 0; i < per; i += 1) {
        const t = ((t0 + (k * 0.37 + i / per) * period) / period) % 1;
        const [x, y] = bezier(g.pts, t);
        ctx.globalAlpha = Math.sin(Math.PI * t) * (on ? 0.95 : 0.7);
        ctx.beginPath();
        ctx.arc(x, y, on ? 2.2 : 1.6, 0, Math.PI * 2);
        ctx.fill();
      }
    });
    ctx.globalAlpha = 1;
    schedule();
  }

  function schedule() {
    if (!raf && alive && visible && !document.hidden) raf = requestAnimationFrame(frame);
  }
  const io = new IntersectionObserver((entries) => {
    visible = entries.some((x) => x.isIntersecting);
    schedule();
  });
  io.observe(host);
  const onVis = () => schedule();
  document.addEventListener("visibilitychange", onVis);

  function destroy() {
    alive = false;
    cancelAnimationFrame(raf);
    io.disconnect();
    document.removeEventListener("visibilitychange", onVis);
    canvas.remove();
  }
  schedule();
  return { destroy };
}
