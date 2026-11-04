/* 星图: one star per case, one galaxy per group, all on one canvas so a few thousand cases stay
   smooth. Inside a galaxy, stars sit on a golden-angle spiral with the most severe at the core;
   galaxies are shelf-packed by size so every label has its own room. Stars spiral out of their
   core on entry, a sparse few twinkle afterwards, and the loop sleeps while the map is off screen,
   the tab is hidden or motion is reduced. Hover names a case, click hands it to `onPick`. */
import { esc, showTip, hideTip, REDUCED } from "./core.js";

const GOLDEN = Math.PI * (3 - Math.sqrt(5));
const MAX_GROUPS = 12;
const FLAT = 0.84;
const INTRO_MS = 1100;
const SEV_VARS = ["--sev-0", "--sev-1", "--sev-2", "--sev-3", "--sev-4", "--sev-none"];

const label = (g) => (g.name.length > 9 ? `${g.name.slice(0, 8)}…` : g.name);
const easeOut = (t) => 1 - Math.pow(1 - t, 3);
/* A little overshoot for the spiral-out, settling like the cards' spring. */
const easeBack = (t) => 1 + 2.2 * Math.pow(t - 1, 3) + 1.2 * Math.pow(t - 1, 2);

function resolve(host) {
  const cs = getComputedStyle(host);
  const v = (name) => cs.getPropertyValue(name).trim();
  return {
    sev: SEV_VARS.map(v), ink: v("--ink"), ink2: v("--ink-2"), muted: v("--muted"), faint: v("--faint"),
    accent: v("--accent"), card: v("--card"), font: v("--font") || "sans-serif",
    named: (name) => v(name),
  };
}

/* Fold the long tail into one 其他 galaxy so labels stay legible. */
function fold(groups) {
  const list = groups.filter((g) => g.items.length).sort((a, b) => b.items.length - a.items.length);
  if (list.length <= MAX_GROUPS) return list;
  const rest = list.slice(MAX_GROUPS - 1);
  return [...list.slice(0, MAX_GROUPS - 1), { key: "~", name: "其他", other: true, items: rest.flatMap((g) => g.items) }];
}

/* Shelf-pack one cell per galaxy (its disc plus its label) into rows that fit the canvas, centring
   each row, and binary-search the largest scale that still fits the height: labels never collide. */
function shelves(cells, W, H, scale) {
  const GAP = 10;
  const rows = [];
  let row = { items: [], w: 0, h: 0 };
  cells.forEach((c) => {
    const w = Math.max(c.d * scale, c.label + 6);
    const h = c.d * scale * FLAT + 20;
    if (row.items.length && row.w + GAP + w > W) {
      rows.push(row);
      row = { items: [], w: 0, h: 0 };
    }
    row.items.push({ c, w, h });
    row.w += (row.items.length > 1 ? GAP : 0) + w;
    row.h = Math.max(row.h, h);
  });
  if (row.items.length) rows.push(row);
  const total = rows.reduce((t, r) => t + r.h, 0) + GAP * Math.max(0, rows.length - 1);
  return { rows, total, fits: total <= H && rows.every((r) => r.w <= W + 0.5) };
}

export function galaxy(host, groups, { onPick = null, tip = null, focus = null, colorOf = null, onHover = null } = {}) {
  host.innerHTML = `<canvas aria-hidden="true"></canvas>`;
  const canvas = host.querySelector("canvas");
  const ctx2d = canvas.getContext("2d");
  const still = REDUCED;
  let colors = resolve(host);
  let W = 0;
  let H = 0;
  let dpr = 1;
  let stars = [];
  let gals = [];
  let hover = null;
  let hoverGal = null;
  let born = performance.now();
  let raf = 0;
  let visible = true;
  let alive = true;
  let lit = focus;
  let dust = [];

  const folded = fold(groups);
  const total = folded.reduce((s, g) => s + g.items.length, 0);

  function layout() {
    const rect = host.getBoundingClientRect();
    W = Math.max(1, rect.width);
    H = Math.max(1, rect.height);
    dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    // Unit space: a galaxy of N stars has diameter 2√N; its label is measured in pixels.
    ctx2d.font = `500 11.5px ${colors.font}`;
    const cells = folded.map((g) => ({
      g, d: 2 * (Math.sqrt(g.items.length) * 1.02 + 0.9),
      label: ctx2d.measureText(label(g)).width + 5 + ctx2d.measureText(String(g.items.length)).width,
    }));
    const pad = 10;
    const iw = W - pad * 2;
    const ih = H - pad * 2;
    let lo = 0.2, hi = 40;
    for (let i = 0; i < 28; i += 1) {
      const mid = (lo + hi) / 2;
      if (shelves(cells, iw, ih, mid).fits) lo = mid;
      else hi = mid;
    }
    const scale = lo;
    const packed = shelves(cells, iw, ih, scale);
    const base = Math.max(1.05, Math.min(3.1, scale * 0.36));
    gals = [];
    let y = pad + (ih - packed.total) / 2;
    packed.rows.forEach((row, ri) => {
      let x = pad + (iw - row.w) / 2;
      row.items.forEach((cell, ci) => {
        const r = (cell.c.d / 2) * scale;
        // A small vertical stagger keeps the rows from reading as a table.
        const lift = row.items.length > 1 ? ((ci + ri) % 2 ? -1 : 1) * Math.min(6, (row.h - cell.h) / 2) : 0;
        gals.push({
          g: cell.c.g, x: x + cell.w / 2, y: y + (row.h - 20) / 2 + lift, r,
          on: lit != null && cell.c.g.key === lit,
        });
        x += cell.w + 10;
      });
      y += row.h + 10;
    });
    // Faint dust across the whole map, fixed per layout so it never flickers.
    dust = Array.from({ length: Math.round((W * H) / 2600) }, (_, i) => ({
      x: ((i * 7919) % 1000) / 1000 * W, y: ((i * 104729) % 1000) / 1000 * H, r: 0.5 + ((i * 31) % 10) / 14,
    }));
    stars = [];
    gals.forEach((gal) => {
      const items = gal.g.items.slice().sort((a, b) => (a.w ?? 5) - (b.w ?? 5) || (b.n || 0) - (a.n || 0));
      items.forEach((it, k) => {
        const rho = Math.sqrt(k + 0.5) * 0.98 * scale;
        const th = k * GOLDEN + gal.x * 0.013;
        stars.push({
          it, gal, k, n: items.length,
          x: gal.x + Math.cos(th) * rho,
          y: gal.y + Math.sin(th) * rho * FLAT,
          r: base * (0.78 + 0.13 * Math.sqrt(Math.min(it.n || 0, 25))),
          tw: k % 7 === 3 ? 0.6 + ((k * 37) % 100) / 60 : 0,
          ph: (k * 2.17) % (Math.PI * 2),
        });
      });
    });
  }

  function colorFor(it) {
    if (colorOf) return colorOf(it, colors);
    return colors.sev[it.w ?? 5] || colors.faint;
  }

  function draw(now) {
    const t = now - born;
    ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx2d.clearRect(0, 0, W, H);
    const dimOthers = hoverGal || gals.some((g) => g.on);
    ctx2d.fillStyle = colors.faint;
    ctx2d.globalAlpha = 0.22;
    dust.forEach((d) => {
      ctx2d.beginPath();
      ctx2d.arc(d.x, d.y, d.r, 0, Math.PI * 2);
      ctx2d.fill();
    });
    // Soft cores: a faint glow under each galaxy, brighter for the one in focus.
    gals.forEach((gal) => {
      const lit = hoverGal ? gal === hoverGal : gal.on;
      const grd = ctx2d.createRadialGradient(gal.x, gal.y, 0, gal.x, gal.y, Math.max(6, gal.r));
      grd.addColorStop(0, colors.accent);
      grd.addColorStop(1, "transparent");
      ctx2d.globalAlpha = lit ? 0.14 : 0.055;
      ctx2d.fillStyle = grd;
      ctx2d.beginPath();
      ctx2d.ellipse(gal.x, gal.y, Math.max(6, gal.r), Math.max(6, gal.r) * FLAT, 0, 0, Math.PI * 2);
      ctx2d.fill();
    });
    let moving = false;
    stars.forEach((s) => {
      let x = s.x, y = s.y, a = 0.92;
      if (!still) {
        const delay = (s.k / Math.max(1, s.n)) * 420;
        const p = Math.min(1, Math.max(0, (t - delay) / (INTRO_MS - 420)));
        if (p < 1) {
          moving = true;
          const e = easeBack(p);
          const spin = (1 - easeOut(p)) * 1.4;
          const dx = s.x - s.gal.x, dy = (s.y - s.gal.y) / FLAT;
          const cos = Math.cos(spin), sin = Math.sin(spin);
          x = s.gal.x + (dx * cos - dy * sin) * e;
          y = s.gal.y + (dx * sin + dy * cos) * e * FLAT;
          a *= Math.min(1, p * 2.2);
        } else if (s.tw) {
          a = 0.55 + 0.4 * (0.5 + 0.5 * Math.sin((t / 1000) * s.tw * 2.2 + s.ph));
        }
      }
      if (dimOthers && (hoverGal ? s.gal !== hoverGal : !s.gal.on)) a *= 0.5;
      ctx2d.globalAlpha = a;
      ctx2d.fillStyle = colorFor(s.it);
      ctx2d.beginPath();
      ctx2d.arc(x, y, s === hover ? s.r + 1.2 : s.r, 0, Math.PI * 2);
      ctx2d.fill();
    });
    if (hover) {
      ctx2d.globalAlpha = 1;
      ctx2d.strokeStyle = colors.ink;
      ctx2d.lineWidth = 1.25;
      ctx2d.beginPath();
      ctx2d.arc(hover.x, hover.y, hover.r + 3.2, 0, Math.PI * 2);
      ctx2d.stroke();
    }
    // Labels: name in ink, count in muted, centred under each galaxy.
    const labelIn = still ? 1 : Math.min(1, Math.max(0, (t - 260) / 520));
    gals.forEach((gal) => {
      const lit = hoverGal ? gal === hoverGal : gal.on || !dimOthers;
      ctx2d.globalAlpha = labelIn * (lit ? 1 : 0.5);
      const y = gal.y + gal.r * FLAT + 12;
      const name = label(gal.g);
      const count = String(gal.g.items.length);
      ctx2d.font = `500 11.5px ${colors.font}`;
      const wName = ctx2d.measureText(name).width;
      ctx2d.font = `400 11px ${colors.font}`;
      const wCount = ctx2d.measureText(count).width;
      const x = gal.x - (wName + 5 + wCount) / 2;
      ctx2d.textBaseline = "middle";
      ctx2d.font = `500 11.5px ${colors.font}`;
      ctx2d.fillStyle = colors.ink2;
      ctx2d.fillText(name, x, y);
      ctx2d.font = `400 11px ${colors.font}`;
      ctx2d.fillStyle = colors.muted;
      ctx2d.fillText(count, x + wName + 5, y);
    });
    ctx2d.globalAlpha = 1;
    return moving;
  }

  function loop(now) {
    raf = 0;
    if (!alive) return;
    if (!host.isConnected) return destroy();
    const moving = draw(now);
    // Entry runs at full rate; the idle twinkle is cheap and capped near 24 fps.
    if (!still && visible && !document.hidden) {
      if (moving) raf = requestAnimationFrame(loop);
      else setTimeout(() => !raf && alive && (raf = requestAnimationFrame(loop)), 42);
    }
  }
  const kick = () => {
    if (!raf && alive) raf = requestAnimationFrame(loop);
  };

  function pick(e) {
    const r = canvas.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    let best = null;
    let bd = Infinity;
    for (const s of stars) {
      const d = (s.x - x) ** 2 + (s.y - y) ** 2;
      if (d < bd) {
        bd = d;
        best = s;
      }
    }
    if (best && Math.sqrt(bd) <= Math.max(6, best.r + 3)) return { star: best, gal: best.gal };
    const gal = gals.find((g) => Math.hypot(g.x - x, (g.y - y) / FLAT) <= g.r + 6) || null;
    return { star: null, gal };
  }

  const onMove = (e) => {
    const hit = pick(e);
    const changed = hit.star !== hover || hit.gal !== hoverGal;
    hover = hit.star;
    hoverGal = hit.gal;
    canvas.style.cursor = hover && onPick && !hover.it.inert ? "pointer" : "default";
    if (hover) {
      showTip(tip ? tip(hover.it, hover.gal.g) : `<div class="t-row">${esc(hover.it.q || "")}</div>`, e.clientX, e.clientY);
    } else if (hoverGal) {
      showTip(`<div class="t-row">${esc(hoverGal.g.name)}<b class="num" style="margin-left:auto">${hoverGal.g.items.length}</b></div>`, e.clientX, e.clientY);
    } else hideTip();
    if (changed) {
      if (onHover) onHover(hover ? hover.it : null);
      if (still || !visible) draw(performance.now());
      else kick();
    }
  };
  const onLeave = () => {
    hover = null;
    hoverGal = null;
    if (onHover) onHover(null);
    hideTip();
    draw(performance.now());
  };
  const onClick = (e) => {
    const hit = pick(e);
    if (hit.star && onPick && !hit.star.it.inert) onPick(hit.star.it, hit.star.gal.g);
  };
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerleave", onLeave);
  canvas.addEventListener("click", onClick);

  let sized = 0;
  const ro = new ResizeObserver(() => {
    cancelAnimationFrame(sized);
    sized = requestAnimationFrame(() => {
      layout();
      draw(performance.now());
      kick();
    });
  });
  ro.observe(host);
  const io = new IntersectionObserver((entries) => {
    visible = entries.some((x) => x.isIntersecting);
    if (visible) kick();
  });
  io.observe(host);
  const mo = new MutationObserver(() => {
    colors = resolve(host);
    draw(performance.now());
  });
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-mode"] });
  const onVis = () => !document.hidden && kick();
  document.addEventListener("visibilitychange", onVis);

  function destroy() {
    if (!alive) return;
    alive = false;
    cancelAnimationFrame(raf);
    ro.disconnect();
    io.disconnect();
    mo.disconnect();
    document.removeEventListener("visibilitychange", onVis);
  }

  layout();
  born = performance.now();
  draw(born);
  kick();
  return {
    destroy,
    total,
    /* Ring one case from outside (the ledger beside the map) and dim the other galaxies. */
    mark(it) {
      hover = (it && stars.find((s) => s.it === it)) || null;
      hoverGal = hover ? hover.gal : null;
      if (still || !visible) draw(performance.now());
      else kick();
    },
    /* Re-light one galaxy without replaying the entry. */
    focus(key) {
      lit = key;
      gals.forEach((g) => (g.on = key != null && g.g.key === key));
      draw(performance.now());
    },
  };
}
