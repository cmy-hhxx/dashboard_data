"""Pilot runner: translates a JSON bundle of paired samples and writes a side-by-side comparison."""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
import json
import sys
import time
from pathlib import Path

from .config import ATTR_PROBLEM_FIELDS, COMPACT_LIST_SPECS, GatewayConfig
from .gateway import GatewayClient
from .translator import translate_attribution, translate_compact


def verify_frozen_attribution(orig: dict, trans: dict) -> list[str]:
    """Paranoid post-check: verify NO frozen field was modified anywhere in attribution."""
    diffs = []
    for k in ("session_meta",):
        if orig.get(k) != trans.get(k):
            diffs.append(f"top-level {k} changed")
    oturns, tturns = orig.get("turns") or [], trans.get("turns") or []
    if len(oturns) != len(tturns):
        return diffs + [f"turns count mismatch: {len(oturns)} vs {len(tturns)}"]
    for ti, (ot, tt) in enumerate(zip(oturns, tturns)):
        for k in ("meta", "is_correct", "correct_reason"):
            if ot.get(k) != tt.get(k):
                diffs.append(f"turn[{ti}].{k} changed")
        op, tp = ot.get("problem") or [], tt.get("problem") or []
        if len(op) != len(tp):
            diffs.append(f"turn[{ti}].problem count mismatch")
            continue
        for pi, (a, b) in enumerate(zip(op, tp)):
            for k in a:
                if k in ATTR_PROBLEM_FIELDS:
                    continue
                if a.get(k) != b.get(k):
                    diffs.append(f"turn[{ti}].problem[{pi}].{k} changed")
    return diffs


def verify_frozen_compact(orig: dict, trans: dict) -> list[str]:
    """Paranoid post-check: verify NO frozen field was modified anywhere in compact."""
    diffs = []
    for k in ("session_meta", "trace_meta"):
        if orig.get(k) != trans.get(k):
            diffs.append(f"top-level {k} changed")
    oturns, tturns = orig.get("turns") or [], trans.get("turns") or []
    if len(oturns) != len(tturns):
        return diffs + ["compact turns count mismatch"]
    spec_map = {lk: tk for lk, tk, _ in COMPACT_LIST_SPECS}
    for ti, (ot, tt) in enumerate(zip(oturns, tturns)):
        for lk, tk in spec_map.items():
            ol, tl = ot.get(lk) or [], tt.get(lk) or []
            if len(ol) != len(tl):
                diffs.append(f"compact turn[{ti}].{lk} count mismatch")
                continue
            for idx, (a, b) in enumerate(zip(ol, tl)):
                for k in a:
                    if k == tk:
                        continue
                    if a.get(k) != b.get(k):
                        diffs.append(f"compact turn[{ti}].{lk}[{idx}].{k} changed")
    return diffs


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--bundle", required=True, help="Path to pilot bundle JSON")
    ap.add_argument("--out-json", required=True, help="Path to save full pilot results JSON")
    ap.add_argument("--model", default=None)
    ap.add_argument("--resume", action="store_true", help="Reuse already-succeeded parts in --out-json")
    ap.add_argument("--workers", type=int, default=3, help="Concurrent samples")
    args = ap.parse_args()

    cfg = GatewayConfig()
    if args.model:
        cfg.model = args.model

    samples = json.loads(Path(args.bundle).read_text(encoding="utf-8"))
    existing = {}
    out_path = Path(args.out_json)
    if args.resume and out_path.is_file():
        for prev in json.loads(out_path.read_text(encoding="utf-8")):
            existing[prev["tag"]] = prev

    t_all = time.monotonic()

    def run_one(item):
        idx, sample = item
        client = GatewayClient(cfg)
        tag = sample["tag"]
        attr = sample["attribution"]
        comp = sample.get("compact")
        inp = sample.get("eval_input")
        prev = existing.get(tag) or {}
        print(f"[{idx}/{len(samples)}] Translating {tag} ...", flush=True)

        rec = {
            "tag": tag,
            "model": sample["model"],
            "date": sample["date"],
            "attr_file": sample["attr_file"],
            "attr_line": sample["attr_line"],
            "question": (attr.get("session_meta") or {}).get("question")
            or (attr.get("session_meta") or {}).get("question_text")
            or "",
            "orig_attribution": attr,
            "orig_compact": comp,
        }

        if prev.get("human_attribution"):
            rec["human_attribution"] = prev["human_attribution"]
            rec["attr_stats"] = prev.get("attr_stats")
            print(f"  [{tag}] attr CACHED", flush=True)
        else:
            try:
                tr_attr, st_attr = translate_attribution(attr, inp, client, cfg)
                frozen_diffs = verify_frozen_attribution(attr, tr_attr)
                rec["human_attribution"] = tr_attr
                rec["attr_stats"] = {
                    "llm_calls": st_attr.llm_calls,
                    "retries": st_attr.retries,
                    "prompt_tokens": st_attr.prompt_tokens,
                    "completion_tokens": st_attr.completion_tokens,
                    "elapsed_s": st_attr.elapsed_s,
                    "frozen_diffs": frozen_diffs,
                }
                print(
                    f"  [{tag}] attr OK: calls={st_attr.llm_calls} retries={st_attr.retries} "
                    f"tokens={st_attr.prompt_tokens}+{st_attr.completion_tokens} "
                    f"time={st_attr.elapsed_s}s frozen_diffs={len(frozen_diffs)}",
                    flush=True,
                )
            except Exception as exc:
                rec["attr_error"] = str(exc)
                print(f"  [{tag}] attr FAILED: {exc}", file=sys.stderr, flush=True)

        if comp:
            if prev.get("human_compact"):
                rec["human_compact"] = prev["human_compact"]
                rec["compact_stats"] = prev.get("compact_stats")
                print(f"  [{tag}] compact CACHED", flush=True)
            else:
                try:
                    tr_comp, st_comp = translate_compact(comp, inp, client, cfg)
                    frozen_diffs_c = verify_frozen_compact(comp, tr_comp)
                    rec["human_compact"] = tr_comp
                    rec["compact_stats"] = {
                        "llm_calls": st_comp.llm_calls,
                        "retries": st_comp.retries,
                        "prompt_tokens": st_comp.prompt_tokens,
                        "completion_tokens": st_comp.completion_tokens,
                        "elapsed_s": st_comp.elapsed_s,
                        "frozen_diffs": frozen_diffs_c,
                    }
                    print(
                        f"  [{tag}] compact OK: calls={st_comp.llm_calls} retries={st_comp.retries} "
                        f"tokens={st_comp.prompt_tokens}+{st_comp.completion_tokens} "
                        f"time={st_comp.elapsed_s}s frozen_diffs={len(frozen_diffs_c)}",
                        flush=True,
                    )
                except Exception as exc:
                    rec["compact_error"] = str(exc)
                    print(f"  [{tag}] compact FAILED: {exc}", file=sys.stderr, flush=True)

        return rec

    with ThreadPoolExecutor(max_workers=max(1, args.workers)) as pool:
        results = list(pool.map(run_one, enumerate(samples, 1)))

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"DONE in {round(time.monotonic() - t_all, 1)}s -> {out_path}", flush=True)


if __name__ == "__main__":
    main()
