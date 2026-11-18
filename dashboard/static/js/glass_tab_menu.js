/* Frosted glass tab bar + morphing "+" overflow menu (inspired by glass-tab-menu). */
import { $, $$, REDUCED } from "./core.js";

const clamp = (v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
const smooth = (a, b, x) => {
  const t = clamp((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

function stepSpring(s, dt, k, d) {
  s.v += ((s.target - s.p) * k - s.v * d) * dt;
  s.p += s.v * dt;
  if (Math.abs(s.p - s.target) < 1e-4 && Math.abs(s.v) < 1e-3) {
    s.p = s.target;
    s.v = 0;
  }
  return s.p !== s.target || s.v !== 0;
}

export function glassTabMenu(cluster, onPick) {
  const panel = $(".vs-panel", cluster);
  const tabs = $(".vs-tabs", cluster);
  const indicator = $(".vs-selection", cluster);
  const lens = $(".vs-lens", cluster);
  const toggle = $(".vs-toggle", cluster);
  const plus = $(".vs-plus", cluster);
  const menu = $(".vs-menu", cluster);
  const tabBtns = $$(".vs-tab", cluster);
  const actions = $$(".vs-action", cluster);
  const tabValues = tabBtns.map((b) => b.dataset.value);

  const opening = { p: 0, v: 0, target: 0 };
  const content = { p: 0, v: 0, target: 0 };
  const selection = { p: 0, v: 0, target: 0 };
  const selVis = { p: 1, v: 0, target: 1 };
  const compression = { p: 0, v: 0, target: 0 };
  const press = { p: 0, v: 0, target: 0 };

  let value = tabValues[0] || "data";
  let frame = 0;
  let last = 0;
  let morphDelay = 0;
  let compressionDelay = 0;
  let contentDelay = 0;
  let pendingKick = 0;
  let menuFocus = -1;
  let destroyed = false;
  let baseW = 344;
  let baseH = 40;
  let menuW = 344;
  let menuH = 184;
  let tabW = 83;

  const measure = () => {
    const cs = getComputedStyle(cluster);
    baseH = parseFloat(cs.getPropertyValue("--vs-h")) || 40;
    baseW = parseFloat(cs.getPropertyValue("--vs-w")) || 344;
    menuW = parseFloat(cs.getPropertyValue("--vs-menu-w")) || baseW;
    menuH = parseFloat(cs.getPropertyValue("--vs-menu-h")) || 184;
    if (tabBtns[0]) tabW = tabBtns[0].offsetWidth || (baseW - 8) / Math.max(1, tabBtns.length);
  };

  const draw = () => {
    const e = clamp(opening.p);
    const n = clamp(compression.p, -0.02, 0.36);
    const targetW = baseW + (menuW - baseW) * e;
    const w = targetW * (1 - n);
    const h = baseH + (menuH - baseH) * clamp(opening.p, 0, 1.02);
    const vel = clamp(Math.abs(selection.v) / 6.5);
    const vis = clamp(selVis.p);
    const o = clamp(content.p);
    const tabBlur = 11 * Math.sin(e * Math.PI);
    const menuBlur = 11 * (1 - o);

    panel.style.width = `${w.toFixed(2)}px`;
    panel.style.left = `${((baseW - w) / 2).toFixed(2)}px`;
    panel.style.height = `${h.toFixed(2)}px`;
    panel.style.borderRadius = `${(baseH / 2 + 4 * e).toFixed(2)}px`;
    panel.classList.toggle("is-open", e > 0.04 || !!opening.target);

    tabs.style.transform = `translateX(-50%) scaleX(${(w / baseW).toFixed(4)})`;
    tabs.style.opacity = String(1 - smooth(0.03, 0.39, e));
    tabs.style.filter = tabBlur > 0.05 ? `blur(${tabBlur.toFixed(2)}px)` : "none";
    tabs.inert = Boolean(opening.target) || e > 0.38;

    menu.style.transform = `translateX(-50%) scale(${(w / menuW).toFixed(4)},${(h / menuH).toFixed(4)})`;
    menu.style.opacity = String(o);
    menu.style.filter = menuBlur > 0.05 ? `blur(${menuBlur.toFixed(2)}px)` : "none";
    menu.style.pointerEvents = opening.target && o > 0.62 ? "auto" : "none";
    menu.inert = !opening.target || o <= 0.62;

    const sx = (1 + vel * 0.07) * (0.86 + 0.14 * vis);
    const sy = (1 + vel * 0.20) * (0.86 + 0.14 * vis);
    const selTransform = `translateX(${(selection.p * tabW).toFixed(2)}px) scale(${sx.toFixed(4)},${sy.toFixed(4)})`;
    indicator.style.width = `${tabW}px`;
    indicator.style.transform = selTransform;
    indicator.style.opacity = String(vis);
    indicator.style.setProperty("--vs-a", vel.toFixed(3));

    lens.style.width = `${tabW}px`;
    lens.style.transform = selTransform;
    lens.style.opacity = String(vel * vis);

    const s = clamp(press.p, 0, 0.48);
    plus.style.transform = `rotate(${(45 * e).toFixed(2)}deg)`;
    toggle.style.transform = `scale(${(1 + s * 0.36).toFixed(4)})`;
    toggle.style.setProperty("--vs-press", clamp(s * 2, 0, 1).toFixed(3));

    if (menuFocus >= 0 && o > 0.72) {
      const idx = menuFocus;
      menuFocus = -1;
      focusAction(idx);
    }
  };

  const settle = () => {
    cancelAnimationFrame(frame);
    frame = 0;
    last = 0;
    morphDelay = 0;
    compressionDelay = 0;
    contentDelay = 0;
    pendingKick = 0;
    for (const s of [opening, content, selection, selVis, compression, press]) {
      s.p = s.target;
      s.v = 0;
    }
    draw();
  };

  const tick = (now) => {
    frame = 0;
    if (destroyed) return;
    if (REDUCED) {
      settle();
      return;
    }
    const dt = Math.min(0.032, (now - (last || now - 16)) / 1000);
    last = now;
    let moving = false;
    for (let i = 0; i < 3; i += 1) {
      const stepDt = dt / 3;
      if (morphDelay > 0) {
        morphDelay = Math.max(0, morphDelay - stepDt);
        moving = true;
      } else {
        moving = stepSpring(opening, stepDt, 400, 26) || moving;
      }
      if (compressionDelay > 0) {
        compressionDelay = Math.max(0, compressionDelay - stepDt);
        moving = true;
      } else if (pendingKick) {
        compression.v = Math.min(16, compression.v + pendingKick);
        pendingKick = 0;
      }
      if (contentDelay > 0) {
        contentDelay = Math.max(0, contentDelay - stepDt);
        moving = true;
      } else {
        moving = stepSpring(content, stepDt, 480, 30) || moving;
      }
      moving = stepSpring(selection, stepDt, 330, 26) || moving;
      moving = stepSpring(selVis, stepDt, 380, 28) || moving;
      moving = stepSpring(compression, stepDt, 400, 22) || moving;
      moving = stepSpring(press, stepDt, 420, 24) || moving;
    }
    draw();
    if (moving) frame = requestAnimationFrame(tick);
    else last = 0;
  };

  const wake = () => {
    if (destroyed) return;
    if (REDUCED) {
      settle();
      return;
    }
    if (!frame) frame = requestAnimationFrame(tick);
  };

  const focusAction = (idx) => {
    actions.forEach((btn, i) => { btn.tabIndex = i === idx ? 0 : -1; });
    actions[idx]?.focus();
  };

  const setOpen = (open, focusIdx = -1) => {
    if (destroyed) return;
    const t = open ? 1 : 0;
    if (t !== opening.target && !REDUCED) {
      const dist = Math.abs(t - opening.p);
      morphDelay = dist > 0.95 ? 0.065 : 0;
      compressionDelay = dist > 0.95 ? 0.08 : 0;
      contentDelay = t && dist > 0.95 ? 0.14 : 0;
      pendingKick = 11 * dist;
      press.v = Math.min(16, press.v + 13);
    }
    opening.target = t;
    content.target = t;
    menuFocus = open ? focusIdx : -1;
    if (!open && actions.includes(document.activeElement)) toggle.focus();
    toggle.setAttribute("aria-expanded", String(Boolean(open)));
    toggle.setAttribute("aria-label", open ? "关闭更多页面菜单" : "更多页面");
    if (!open) actions.forEach((btn) => { btn.tabIndex = -1; });
    draw();
    wake();
  };

  const syncVisuals = (v) => {
    const idx = tabValues.indexOf(v);
    const inMenu = idx === -1;
    if (idx >= 0) {
      if (selVis.p < 0.05) selection.p = idx;
      selection.target = idx;
      selVis.target = 1;
    } else {
      selVis.target = 0;
    }
    tabBtns.forEach((b, i) => {
      const on = i === idx;
      b.setAttribute("aria-selected", String(on));
      b.tabIndex = on || (inMenu && i === 0) ? 0 : -1;
    });
    actions.forEach((b) => {
      const on = b.dataset.value === v;
      b.classList.toggle("is-active", on);
      b.setAttribute("aria-current", on ? "page" : "false");
    });
    toggle.classList.toggle("has-active", inMenu);
    const activeAction = actions.find((b) => b.dataset.value === v);
    toggle.dataset.activeName = activeAction ? activeAction.textContent.trim() : "";
  };

  const set = (v, { silent = false } = {}) => {
    const valid = tabValues.includes(v) || actions.some((a) => a.dataset.value === v);
    const next = valid ? v : tabValues[0];
    const changed = next !== value;
    value = next;
    syncVisuals(value);
    wake();
    if (!silent && changed) onPick(value);
  };

  tabBtns.forEach((btn, idx) => {
    btn.addEventListener("click", () => {
      if (opening.target) setOpen(false);
      set(btn.dataset.value);
    });
    btn.addEventListener("keydown", (e) => {
      let next = idx;
      if (e.key === "ArrowRight") next = (idx + 1) % tabBtns.length;
      else if (e.key === "ArrowLeft") next = (idx + tabBtns.length - 1) % tabBtns.length;
      else if (e.key === "Home") next = 0;
      else if (e.key === "End") next = tabBtns.length - 1;
      else return;
      e.preventDefault();
      set(tabBtns[next].dataset.value);
      tabBtns[next].focus();
    });
  });

  toggle.addEventListener("click", (e) => {
    setOpen(!opening.target, e.detail === 0 && !opening.target ? 0 : -1);
  });
  toggle.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setOpen(true, e.key === "ArrowDown" ? 0 : actions.length - 1);
    } else if (e.key === "Escape" && opening.target) {
      e.preventDefault();
      setOpen(false);
      toggle.focus();
    }
  });

  actions.forEach((btn, idx) => {
    btn.addEventListener("click", () => {
      setOpen(false);
      set(btn.dataset.value);
    });
    btn.addEventListener("keydown", (e) => {
      let next = idx;
      if (e.key === "ArrowRight") next = (idx + 1) % actions.length;
      else if (e.key === "ArrowLeft") next = (idx + actions.length - 1) % actions.length;
      else if (e.key === "ArrowDown") next = (idx + 3) % actions.length;
      else if (e.key === "ArrowUp") next = (idx + actions.length - 3) % actions.length;
      else if (e.key === "Home") next = 0;
      else if (e.key === "End") next = actions.length - 1;
      else if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
        toggle.focus();
        return;
      } else return;
      e.preventDefault();
      focusAction(next);
    });
  });

  const onDocDown = (e) => {
    if (opening.target && !e.composedPath().includes(cluster)) setOpen(false);
  };
  const onFocusOut = (e) => {
    if (opening.target && !cluster.contains(e.relatedTarget)) setOpen(false);
  };
  document.addEventListener("pointerdown", onDocDown);
  cluster.addEventListener("focusout", onFocusOut);

  const ro = new ResizeObserver(() => {
    measure();
    draw();
  });
  ro.observe(cluster);

  measure();
  syncVisuals(value);
  settle();

  return {
    set,
    get: () => value,
    close: () => setOpen(false),
    destroy: () => {
      destroyed = true;
      cancelAnimationFrame(frame);
      ro.disconnect();
      document.removeEventListener("pointerdown", onDocDown);
      cluster.removeEventListener("focusout", onFocusOut);
    },
  };
}
