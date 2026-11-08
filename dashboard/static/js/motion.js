/* The sunburst's interruptible 620ms quartic motion, shared by matrix disclosures and drills. */
import { REDUCED } from "./core.js";

export function sunburstTween(frame, { animate = true, finish = () => {} } = {}) {
  if (!animate || REDUCED) {
    frame(1);
    finish();
    return () => {};
  }
  const start = performance.now();
  let raf = 0;
  const step = (now) => {
    const p = Math.min(1, (now - start) / 620);
    frame(1 - Math.pow(1 - p, 4));
    if (p < 1) raf = requestAnimationFrame(step);
    else finish();
  };
  frame(0);
  raf = requestAnimationFrame(step);
  return () => cancelAnimationFrame(raf);
}
