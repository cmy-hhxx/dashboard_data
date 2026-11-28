/* Shared bounded (<= 500) sample ledger and K-line sample drawer for data board & A/B compare. */
import { $, esc, fmt, WORST, sevColor } from "./core.js";
import { sunburstTween } from "./motion.js";
import { createKlineChart } from "./kline_chart.js";
import { abTrendSampleRefs, resolveABSamples, trendSampleCandidates, trendSampleProblems, traceSampleRefs } from "./trend_samples.js";

export const LEDGER_MAX = 120;
export const RECALL_CAP = 500;
export const TREND_SEV = ["P0", "P1", "P2", "P3", "P4"];
export const RESULT = {
  correct: "正确",
  wrong: "错误",
  mixed: "各版本不一",
  undetermined: "无法判定",
  pending: "待揭晓",
  revealed: "已揭晓",
};

export const sevIdx = (w) => {
  const i = WORST.indexOf(w);
  return i < 0 ? 5 : i;
};

export const caseItem = (r) => ({
  s: r.s,
  w: sevIdx(r.w),
  n: r.n || 0,
  q: r.q || "",
  m: r.m,
  sp: r.sp,
  d: r.d || "",
});

export function groupCases(rows, keyOf, nameOf = (k) => k) {
  const by = new Map();
  rows.forEach((r) => {
    const k = keyOf(r);
    if (!by.has(k)) by.set(k, { key: k, name: nameOf(k), items: [] });
    by.get(k).items.push(caseItem(r));
  });
  return [...by.values()];
}

const predDot = (it) =>
  it.r === "correct"
    ? "var(--accent)"
    : it.r === "wrong"
      ? "var(--sev-1)"
      : it.r === "mixed"
        ? "var(--sev-3)"
        : it.r === "pending"
          ? "var(--muted)"
          : "var(--faint)";

const INPUT_STATE_META = {
  evaluated: { dot: "var(--accent)", short: "已评" },
  reeval: { dot: "var(--sev-2)", short: "重评" },
  pending: { dot: "var(--muted)", short: "待评" },
  failed: { dot: "var(--sev-1)", short: "失败" },
  skipped: { dot: "var(--faint)", short: "跳过" },
};
const inputStateOf = (it) => (it && INPUT_STATE_META[it.es] ? it.es : (it?.ev ? "evaluated" : "pending"));
const inputDot = (it) => INPUT_STATE_META[inputStateOf(it)].dot;
const inputShort = (it) => INPUT_STATE_META[inputStateOf(it)].short;

export function ledger(
  groups,
  pred,
  unit = null,
  rows = null,
  { count = true, strip = true, size = LEDGER_MAX, page = 0, sum = true, total = null, rawParts = null, isInput = false } = {},
) {
  const all = groups.flatMap((g) => g.items);
  const ordered = pred || isInput
    ? all
    : [...all].sort((a, b) => a.w - b.w || b.n - a.n || (b.d || "").localeCompare(a.d || ""));
  const pages = Math.max(1, Math.ceil(ordered.length / size));
  const at = Math.max(0, Math.min(pages - 1, page));
  const items = rows ?? ordered.slice(at * size, (at + 1) * size);
  const parts = Array.isArray(rawParts) && !pred && !isInput
    ? WORST.map((_, i) => ({ n: Number(rawParts[i]) || 0, c: sevColor(i) }))
    : isInput
      ? ["evaluated", "reeval", "pending", "failed", "skipped"].map((k) => ({
          n: all.filter((it) => inputStateOf(it) === k).length,
          c: INPUT_STATE_META[k].dot,
        }))
      : pred
        ? ["correct", "wrong", "mixed", "pending", "undetermined"].map((r) => ({
            n: all.filter((it) => (r === "undetermined" ? !["correct", "wrong", "mixed", "pending"].includes(it.r) : it.r === r)).length,
            c: predDot({ r }),
          }))
        : WORST.map((_, i) => ({ n: all.filter((it) => it.w === i).length, c: sevColor(i) }));

  const rowHTML = (it, k) => {
    const col = pred ? predDot(it) : isInput ? inputDot(it) : sevColor(it.w);
    const badge = pred
      ? esc(RESULT[it.r] || "")
      : isInput
        ? inputShort(it)
        : it.n ? fmt(it.n) : "—";
    return `<button type="button" class="gl-r${pred && !it.s ? " is-inert" : ""}" data-i="${k}" style="--i:${Math.min(k, 14)};--c:${col}" title="${esc(it.q || "（无提问）")}"><i></i><span>${esc(it.q || "（无提问）")}</span>${count ? `<b class="num">${badge}</b>` : ""}</button>`;
  };
  const rowsHtml = items.slice(0, size).map(rowHTML);
  const capped = total != null && total > all.length;
  const countLabel = capped ? `${fmt(all.length)} / ${fmt(total)}` : fmt(all.length);
  const sumHtml = `<div class="gl-sum"><b class="num">${countLabel}</b><small>${unit || (pred ? "道预测题" : isInput ? "条评测输入" : "条 Trace")}</small>${
    strip
      ? `<span class="gl-strip" aria-hidden="true">${parts
          .filter((x) => x.n)
          .map((x) => `<i style="flex:${x.n} 1 0;background:${x.c}"></i>`)
          .join("")}</span>`
      : ""
  }</div>`;
  const body = `${sum ? sumHtml : ""}<div class="gx-list">${rowsHtml.join("")}</div>`;
  return { items, all, ordered, parts, pages, page: at, size, rowHTML, sumHtml, body, html: `<div class="gx-side">${body}</div>` };
}

/* The same gx-map / gx-side and ledger used by 数据量, revealed on the trend chart. */
export function trendSampleDrawer(plot, load, repaint, interaction = {}) {
  const frame = plot.closest(".mxt-samples");
  const layout = $(".mxt-sample-layout", frame);
  const map = $(".gx-map", layout);
  const side = $(".mxt-sample-side", layout);
  let opened = false;
  let token = 0;
  let cancel = () => {};

  const clear = () => {
    [map, side].forEach((el) => {
      el.style.transform = "";
      el.style.transformOrigin = "";
      el.style.opacity = "";
    });
  };
  const change = (next, animate = true) => {
    if (next === opened) return;
    cancel();
    const before = map.getBoundingClientRect();
    opened = next;
    interaction.onOpenChange?.(next);
    side.hidden = false;
    layout.classList.toggle("is-open", next);
    layout.classList.toggle("is-closing", !next);
    const overlay = frame.clientWidth < 640;
    map.inert = next && overlay;
    if (map.inert) map.setAttribute("aria-hidden", "true");
    else map.removeAttribute("aria-hidden");
    repaint();
    const after = map.getBoundingClientRect();
    const clean = () => {
      clear();
      layout.classList.remove("is-closing");
      side.hidden = !opened;
    };
    const stop = sunburstTween(
      (k) => {
        const progress = next ? k : 1 - k;
        side.style.transform = `translateX(${(1 - progress) * 100}%)`;
        side.style.opacity = String(progress);
        map.style.transformOrigin = "0 50%";
        map.style.transform = overlay
          ? `translateX(${-progress * 100}%)`
          : `scaleX(${1 + (before.width / Math.max(1, after.width) - 1) * (1 - k)})`;
        map.style.opacity = String(overlay ? 1 - progress : 1);
      },
      { animate, finish: clean },
    );
    cancel = () => {
      stop();
      clean();
    };
  };

  let current = null;
  let page = 0;
  let pageItems = [];
  let scanNext = null;
  let pumping = false;
  let busy = false;
  let pickNow = null;
  const PAGE = 20;

  const close = () => {
    token++;
    change(false);
    pickNow = null;
    current = null;
    scanNext = null;
    plot.focus({ preventScroll: true });
  };

  const head = (pick, count = null) => `<header class="mxt-sample-head">
    <span class="mxt-sample-when num">${esc(pick.when || pick.date)}</span>
    ${count == null ? "" : `<span class="mxt-sample-vol num">量 ${fmt(count)}</span>`}
    <button type="button" class="mx-back" data-samples-close aria-label="返回趋势图">← 返回</button>
  </header>`;

  const focusKey = () => {
    const el = document.activeElement;
    if (!el || !side.contains(el)) return null;
    if (el.matches("[data-samples-close]")) return "close";
    if (el.matches("[data-sample-page]")) return `page:${el.dataset.samplePage}`;
    if (el.matches(".gl-r")) return `row:${el.dataset.i}`;
    return null;
  };
  const restoreFocus = (key) => {
    if (!key) return;
    const el =
      key === "close"
        ? $("[data-samples-close]", side)
        : key.startsWith("page:")
          ? $(`[data-sample-page="${key.slice(5)}"]`, side)
          : $(`.gl-r[data-i="${key.slice(4)}"]`, side);
    el?.focus({ preventScroll: true });
  };
  const pagesOf = () => Math.max(1, Math.ceil((current?.items.length || 0) / PAGE));
  const loading = () =>
    `<div class="mxt-sample-loading"><div class="empty">正在读取样本…</div>${!busy && current?.canScan ? '<button type="button" class="mx-back" data-sample-scan>继续读取</button>' : ""}</div>`;

  const render = () => {
    if (!current || !pickNow) return;
    const key = focusKey();
    if (!current.items.length) {
      side.innerHTML = `${head(pickNow, current.items.length)}${
        current.done
          ? `<div class="empty">${esc(current.emptyText || "当前索引中没有匹配样本")}</div>`
          : loading()
      }`;
      restoreFocus(key);
      return;
    }
    const pages = pagesOf();
    page = Math.max(0, Math.min(pages - 1, page));
    const led = ledger(
      [{ items: current.items }],
      false,
      current.unit,
      current.items.slice(page * PAGE, (page + 1) * PAGE),
      { count: false, strip: false, sum: false },
    );
    pageItems = led.items;
    const scanning = busy;
    const canNext = page + 1 < pages || (current.canScan && !busy);
    const pager =
      pages > 1
        ? `<div class="mxt-sample-pager">
      <button type="button" data-sample-page="prev" aria-label="上一页"${page === 0 ? " disabled" : ""}>‹</button>
      <span class="mxt-sample-page num">第 <b>${page + 1}</b> / ${pages} 页${scanning ? '<span class="mxt-sample-reading">读取中…</span>' : ""}</span>
      <button type="button" data-sample-page="next" aria-label="下一页"${canNext ? "" : " disabled"}>›</button>
    </div>`
        : current.canScan && !busy
          ? '<button type="button" class="mx-back mxt-sample-scan" data-sample-scan>继续读取更多</button>'
          : "";
    side.innerHTML = `${head(pickNow, current.items.length)}${led.body}${pager}`;
    restoreFocus(key);
  };

  const scan = async () => {
    if (!scanNext || !current?.canScan) return false;
    const snap = await scanNext();
    if (!pickNow) return false;
    current = snap;
    return true;
  };
  const scanChunks = async (chunks, need = Infinity) => {
    if (!scanNext || busy) return;
    busy = true;
    render();
    for (let n = 0; n < chunks && current?.canScan && current.items.length < need; n += 1) {
      if (!(await scan())) break;
      render();
    }
    busy = false;
    render();
  };
  const pump = () => {
    if (pumping || !scanNext) return;
    pumping = true;
    scanChunks(3, (page + 2) * PAGE).finally(() => {
      pumping = false;
    });
  };
  const flip = async (dir) => {
    if (!current) return;
    if (dir === "prev") {
      if (page > 0) {
        page -= 1;
        render();
        $(".gx-list", side).scrollTop = 0;
      }
      return;
    }
    if (page + 1 >= pagesOf() && current.canScan) await scanChunks(8, (page + 2) * PAGE);
    if (page + 1 < pagesOf()) {
      page += 1;
      render();
      $(".gx-list", side).scrollTop = 0;
    }
  };

  const openItem = async (item) => {
    if (interaction.openItem) {
      interaction.openItem(item);
      return;
    }
    let trace = item.trace;
    if (!trace && item.turn != null && typeof interaction.loadSample === "function") {
      try {
        trace = (await interaction.loadSample(item.s)).attribution?.turns?.[item.turn]?.trace_id;
      } catch {
        /* Fallback to opening the sample case directly. */
      }
    }
    interaction.openSamples?.({ case: item.s, trace: trace || null });
  };

  const open = async (pick) => {
    const stamp = ++token;
    pickNow = pick;
    current = null;
    page = 0;
    pageItems = [];
    scanNext = null;
    side.innerHTML = `${head(pick)}<div class="empty">正在读取样本…</div>`;
    change(true);
    $("[data-samples-close]", side)?.focus({ preventScroll: true });
    try {
      const first = await load(pick);
      if (stamp !== token || !side.isConnected || !opened) return;
      current = first;
      scanNext = typeof first.scanMore === "function" ? first.scanMore : null;
      render();
      pump();
    } catch {
      if (stamp !== token || !side.isConnected || !opened) return;
      side.innerHTML = `${head(pickNow)}<div class="empty">样本读取失败</div><button type="button" class="mx-back" data-samples-retry>重试</button>`;
      $("[data-samples-retry]", side)?.addEventListener("click", () => open(pick));
    }
  };

  side.onclick = async (event) => {
    if (event.target.closest("[data-samples-close]")) {
      close();
      return;
    }
    if (event.target.closest("[data-sample-scan]")) {
      await scanChunks(6, (page + 1) * PAGE);
      return;
    }
    const flipBtn = event.target.closest("[data-sample-page]");
    if (flipBtn) {
      await flip(flipBtn.dataset.samplePage);
      return;
    }
    const row = event.target.closest(".gl-r");
    const item = row && pageItems[Number(row.dataset.i)];
    if (item) await openItem(item);
  };
  frame.onkeydown = (event) => {
    if (event.key === "Escape" && opened) {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  };

  return {
    open,
    isOpen: () => opened,
    destroy: () => {
      token++;
      cancel();
      opened = false;
      pickNow = null;
      current = null;
      scanNext = null;
      layout.classList.remove("is-open", "is-closing");
      side.hidden = true;
      side.innerHTML = "";
      map.inert = false;
      map.removeAttribute("aria-hidden");
      clear();
    },
  };
}

export async function loadTrendSamplePage(ctx, loadSample, trend, spec, pick) {
  const product = ctx.product;
  const series = pick.series;
  const scenesList =
    !spec.scenes || spec.scenes.size === trend.scenes.length
      ? null
      : [...spec.scenes].map((i) => trend.scenes[i]);
  const mildest = series.levelAll ? -1 : Math.max(...series.levelIdxs);
  const SLICE_PAGE = 48;
  const baseQuery = {
    mode: "trend",
    date: pick.date,
    node: spec.node || "",
    models: (series.models || []).join(","),
    uts: (series.uts || []).join(","),
    scenes: scenesList ? JSON.stringify(scenesList) : "",
    mildest: mildest >= 0 ? String(mildest) : "",
    cap: RECALL_CAP,
  };

  let pool = [];
  let candidateCount = 0;
  let serverPaged = false;
  let serverHasMore = false;
  let serverOffset = 0;

  if (typeof ctx.recallSlice === "function") {
    const first = await ctx.recallSlice(product, { ...baseQuery, offset: 0, limit: SLICE_PAGE });
    if (first && Array.isArray(first.rows)) {
      serverPaged = true;
      pool = first.rows.slice();
      candidateCount = Number(first.candidates ?? first.rows.length);
      serverHasMore = Boolean(first.has_more);
      serverOffset = first.rows.length;
    }
  }
  if (!serverPaged) {
    const index = await ctx.loadIndex(product);
    const candidates = trendSampleCandidates(index.products?.[product]?.rows || [], {
      date: pick.date,
      node: spec.node,
      models: series.models,
      uts: series.uts,
      scenes: scenesList,
    });
    candidateCount = candidates.length;
    const matched =
      mildest < 0
        ? candidates
        : candidates.filter((row) => {
            const worst = WORST.indexOf(row.w);
            return worst < 0 || worst <= mildest;
          });
    pool = matched.slice(0, RECALL_CAP);
  }

  const state = { items: [], scanned: 0, done: false };
  const CHUNK = 12;
  const CONCURRENCY = 8;
  const snapshot = () => ({
    items: state.items.slice(),
    unit: "条 Trace",
    emptyText: candidateCount ? "候选样本没有命中该簇的问题" : "",
    done: state.done,
    canScan: !state.done && (state.scanned < pool.length || serverHasMore) && state.items.length < LEDGER_MAX,
  });
  const ensureCandidates = async () => {
    if (!serverPaged || !serverHasMore || state.scanned < pool.length) return;
    const next = await ctx.recallSlice(product, { ...baseQuery, offset: serverOffset, limit: SLICE_PAGE });
    if (next && Array.isArray(next.rows) && next.rows.length) {
      pool.push(...next.rows);
      serverOffset += next.rows.length;
      serverHasMore = Boolean(next.has_more);
    } else {
      serverHasMore = false;
    }
  };
  const scanMore = async () => {
    if (state.done || state.items.length >= LEDGER_MAX) {
      state.done = true;
      return snapshot();
    }
    await ensureCandidates();
    if (state.scanned >= pool.length) {
      state.done = true;
      return snapshot();
    }
    const batch = pool.slice(state.scanned, state.scanned + CHUNK);
    state.scanned += batch.length;
    for (let start = 0; start < batch.length; start += CONCURRENCY) {
      const results = await Promise.allSettled(
        batch.slice(start, start + CONCURRENCY).map(async (row) => {
          const detail = await loadSample(row.s);
          const problems = trendSampleProblems(detail, spec.node, series.levelIdxs.map((i) => TREND_SEV[i]));
          if (!problems.length) return null;
          return { ...caseItem(row), n: problems.length, w: Math.min(...problems.map((problem) => sevIdx(problem.sev))) };
        }),
      );
      results.forEach((result) => {
        if (result.status === "fulfilled" && result.value) state.items.push(result.value);
      });
      if (state.items.length >= LEDGER_MAX) break;
    }
    if ((state.scanned >= pool.length && !serverHasMore) || state.items.length >= LEDGER_MAX) state.done = true;
    return snapshot();
  };
  await scanMore();
  return { ...snapshot(), scanMore };
}

export async function loadTraceSamplePage(ctx, trend, pick) {
  const product = ctx.product;
  const hasLocalRefs = Array.isArray(trend?.trace_severity?.refs);
  if (!hasLocalRefs && typeof ctx.recallSlice === "function") {
    const res = await ctx.recallSlice(product, {
      mode: "trace_sev",
      date: pick.date,
      level: pick.series.level,
      cap: RECALL_CAP,
    });
    if (res && Array.isArray(res.items)) {
      return { items: res.items, unit: "条 Trace", done: true, canScan: false, scanMore: null };
    }
  }
  const refs = traceSampleRefs(trend, pick.date, pick.series.level).slice(0, RECALL_CAP);
  const slugs = [...new Set(refs.map(([, slug]) => slug).filter(Boolean))];
  let rows = null;
  if (slugs.length && typeof ctx.recallLookup === "function") {
    const looked = await ctx.recallLookup(product, { slugs, cap: RECALL_CAP });
    if (looked && Array.isArray(looked.rows)) rows = looked.rows;
  }
  if (!rows) {
    const index = await ctx.loadIndex(product);
    rows = index.products?.[product]?.rows || [];
  }
  const bySlug = new Map(rows.map((row) => [row.s, row]));
  const items = refs
    .map(([, slug, turn, level, trace]) => {
      const row = bySlug.get(slug);
      return row ? { ...caseItem(row), w: level, trace, turn, n: 0, q: `${row.q || "（无提问）"} · 第 ${turn + 1} 轮` } : null;
    })
    .filter(Boolean);
  return { items, unit: "条 Trace", done: true, canScan: false, scanMore: null };
}

export async function loadABTrendSamplePage(ctx, spec, pick) {
  const { round, sides } = pick.series.samples[pick.index];
  if (!round.sample_refs) return { items: [], emptyText: "当前快照缺少 A/B 样本关联" };
  const refs = abTrendSampleRefs(round, sides, spec.row, spec.node).slice(0, RECALL_CAP);
  const { items } = resolveABSamples(refs, [], spec.node);
  return {
    items: items.map(({ row, trace, n, ref }) => ({
      ...caseItem(row),
      trace,
      n,
      ref,
      pair: ref.pair || ref.trace,
      round: spec.round?.id,
    })),
    unit: "个样本",
    emptyText: refs.length ? "这些样本暂无可打开的评测详情" : "该批次这一格没有命中样本",
    done: true,
    canScan: false,
    scanMore: null,
  };
}

export function mountSampleTrend(plot, makeChart, load, interaction = {}) {
  const drawer = trendSampleDrawer(plot, load, () => {}, interaction);
  const chart = makeChart(plot, (pick) => drawer.open(pick));
  return {
    destroy: () => {
      chart.destroy();
      drawer.destroy();
    },
    openPick: (pick) => drawer.open(pick),
  };
}

export function mountABCellTrend(plot, spec, ctx, onOpenCompare) {
  const makeChart = (host, onPick) =>
    createKlineChart(host, {
      ...spec.kline,
      onPick: (candle) => {
        const sample = spec.picks.get(String(candle.time));
        if (sample) onPick({ date: String(candle.time), series: { samples: [sample] }, index: 0 });
      },
    });
  return mountSampleTrend(plot, makeChart, (pick) => loadABTrendSamplePage(ctx, spec, pick), {
    openItem: (item) => onOpenCompare({ pair: item.pair, round: item.round }),
  });
}
