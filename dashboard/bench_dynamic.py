#!/usr/bin/env python3
"""Indexer & lazy case reader for <datasets>/3_dynamic_bench."""
from __future__ import annotations

from collections import Counter, defaultdict
import csv
import hashlib
import json
import os
from pathlib import Path
import pickle
import re

try:
    import orjson as _orjson
except ImportError:  # pragma: no cover - stdlib fallback
    _orjson = None


DYNAMIC_DIR = "3_dynamic_bench"
DYNAMIC_SCHEMA = 2
_CACHE_VER = 3
DIMS = (
    "severity",
    "stage",
    "mechanism",
    "pattern",
    "turn_type",
    "day",
    "round",
    "group",
)
TAX_DIMS = {"stage", "mechanism", "pattern"}
BY_DESIGN_DIMS = {"severity", "stage", "mechanism", "pattern", "turn_type"}
SEVS_ALL = ("GOLD", "P0", "P1", "P2", "P3", "P4")
MECH_IDS = ("M1", "M2", "M3", "M4", "M5", "M6", "M7")
STAGE_ORDER = ("S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8", "S9", "S10", "S11", "S12")

_TID_PREFIX_RE = re.compile(rb'^\{\s*"trace_id"\s*:\s*"([^"]+)"')
_DAY_PREFIX_RE = re.compile(r"^(\d{4}-\d{2}-\d{2})")
_ROUND_RE = re.compile(r"^\d+$")


def _jloads(raw: bytes | str):
    if _orjson is not None:
        return _orjson.loads(raw)
    return json.loads(raw)


def _clean(val) -> str:
    if val is None:
        return ""
    s = val if isinstance(val, str) else str(val)
    if any("\ud800" <= ch <= "\udfff" for ch in s):
        return s.encode("utf-8", "ignore").decode("utf-8")
    return s


def _scrub_obj(obj):
    if isinstance(obj, str):
        return _clean(obj)
    if isinstance(obj, list):
        return [_scrub_obj(x) for x in obj]
    if isinstance(obj, dict):
        return {_clean(k): _scrub_obj(v) for k, v in obj.items()}
    return obj


def _clip(text: str, limit: int = 240) -> str:
    s = _clean(text).strip()
    return s if len(s) <= limit else s[: limit - 1] + "…"


def tokens_bucket(n) -> str:
    try:
        n = int(n or 0)
    except (TypeError, ValueError):
        n = 0
    if n <= 0:
        return "unknown"
    if n < 8192:
        return "<8k"
    if n < 32768:
        return "8-32k"
    if n < 65536:
        return "32-64k"
    if n < 131072:
        return "64-128k"
    return ">=128k"


def round_bucket(n) -> str:
    try:
        n = int(n or 0)
    except (TypeError, ValueError):
        n = 0
    if n <= 1:
        return "1"
    if n <= 3:
        return "2-3"
    if n <= 10:
        return "4-10"
    return "11+"


def _extract_day(rec: dict) -> str:
    for cand in (rec.get("request_time"), (rec.get("meta") or {}).get("question_at"), rec.get("batch_id")):
        s = _clean(cand).strip()
        m = _DAY_PREFIX_RE.match(s)
        if m:
            return m.group(1)
    return ""


def _quantile(sorted_vals: list[int], q: float) -> int:
    if not sorted_vals:
        return 0
    idx = min(len(sorted_vals) - 1, max(0, int((len(sorted_vals) - 1) * q)))
    return int(sorted_vals[idx])


def dynamic_bench_root(datasets: Path, product: str) -> Path | None:
    """Return ``datasets/3_dynamic_bench`` when present and published for ``product``."""
    root = Path(datasets) / DYNAMIC_DIR
    mf = root / "manifest.json"
    if not mf.is_file():
        return None
    try:
        manifest = json.loads(mf.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    channel = _clean(manifest.get("channel") or (manifest.get("params") or {}).get("channel"))
    if channel:
        return root if channel == product else None
    models = manifest.get("models") or {}
    if any(str(m).startswith(f"{product}_") or str(m) == product for m in models):
        return root
    return None


def _signature_files(root: Path, manifest: dict) -> list[Path]:
    files = [root / "manifest.json"]
    model_names = list((manifest.get("models") or {}).keys()) or (manifest.get("params") or {}).get("models") or []
    for m in model_names:
        mdir = root / m
        if not mdir.is_dir():
            continue
        ps = mdir / "pool_stats.json"
        if ps.is_file():
            files.append(ps)
        sdir = mdir / "stats"
        if sdir.is_dir():
            for p in sorted(sdir.iterdir()):
                if p.is_file() and "difficulty" not in p.name and p.suffix in (".json", ".csv"):
                    files.append(p)
        for p in sorted(mdir.glob("tier_*.jsonl")):
            files.append(p)
        ldir = mdir / "long"
        if ldir.is_dir():
            for p in sorted(ldir.glob("tier_*_long.jsonl")):
                files.append(p)
    return files


def dynamic_bench_signature(datasets: Path, product: str = "aime") -> str:
    """Cheap stat signature of ``3_dynamic_bench`` inputs so unchanged builds skip rescanning."""
    root = dynamic_bench_root(datasets, product)
    if not root:
        return ""
    try:
        manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return ""
    parts = [_CACHE_VER]
    for p in _signature_files(root, manifest):
        try:
            st = p.stat()
        except OSError:
            continue
        parts.append([p.relative_to(root).as_posix(), st.st_size, st.st_mtime_ns])
    return hashlib.sha1(json.dumps(parts, separators=(",", ":")).encode("utf-8")).hexdigest()


def _scan_trace_ids(path: Path) -> list[str]:
    """Read only each line's leading trace_id bytes so multi-GB sub-tiers never fully decode."""
    ids = []
    if not path.is_file():
        return ids
    with path.open("rb") as fh:
        for line in fh:
            if not line.strip():
                continue
            m = _TID_PREFIX_RE.match(line[:192])
            if m:
                ids.append(m.group(1).decode("utf-8", "ignore"))
                continue
            try:
                obj = _jloads(line)
                tid = _clean(obj.get("trace_id"))
                if tid:
                    ids.append(tid)
            except ValueError:
                continue
    return ids


def _read_dim_csv(path: Path) -> list[dict]:
    rows = []
    if not path.is_file():
        return rows
    with path.open(encoding="utf-8", errors="replace", newline="") as fh:
        for r in csv.DictReader(fh):
            rows.append({
                "key": _clean(r.get("key")),
                "bucket": _clean(r.get("bucket") or r.get("key")),
                "count": int(float(r.get("count") or 0)),
                "share_in_bench": float(r.get("share_in_bench") or 0.0),
                "share_in_pool": float(r.get("share_in_pool") or 0.0),
                "delta_pp": float(r.get("delta_pp") or 0.0),
            })
    return rows


def _read_coverage_csv(path: Path) -> list[dict]:
    out = []
    if not path.is_file():
        return out
    with path.open(encoding="utf-8", errors="replace", newline="") as fh:
        for r in csv.DictReader(fh):
            dim = _clean(r.get("dim"))
            if dim == "difficulty" or dim not in DIMS:
                continue
            by_design = _clean(r.get("by_design")).lower() in ("yes", "true", "1")
            ok_raw = _clean(r.get("ok")).lower()
            ok = True if by_design else ok_raw in ("yes", "true", "1")
            out.append({
                "dim": dim,
                "max_abs_delta_pp": float(r.get("max_abs_delta_pp") or 0.0),
                "n_keys": int(float(r.get("n_keys") or 0)),
                "n_keys_missing": int(float(r.get("n_keys_missing") or 0)),
                "tolerance_pp": float(r.get("tolerance_pp") or 10.0),
                "by_design": by_design,
                "ok": ok,
            })
    return out


def _read_crosstab_csv(path: Path) -> dict | None:
    if not path.is_file():
        return None
    stages = []
    stage_names = {}
    rows = {}
    mech_cols = list(MECH_IDS)
    with path.open(encoding="utf-8", errors="replace", newline="") as fh:
        reader = csv.DictReader(fh)
        if reader.fieldnames:
            skip_cols = {"stage", "stage_name", "bench_total", "pool_total", "bench_share", "pool_share"}
            mech_cols = [c for c in reader.fieldnames if c and c not in skip_cols and c != "NA"]
        for r in reader:
            st = _clean(r.get("stage"))
            if not st or st == "NA" or st == "TOTAL":
                continue
            stages.append(st)
            sname = _clean(r.get("stage_name"))
            if sname and sname != "NA":
                stage_names[st] = sname
            row_dict = {m: int(float(r.get(m) or 0)) for m in mech_cols}
            row_bench = sum(row_dict.values())
            row_dict["bench_total"] = int(float(r.get("bench_total") or 0)) if row_bench == 0 else row_bench
            row_dict["pool_total"] = int(float(r.get("pool_total") or 0))
            rows[st] = row_dict
    totals = {m: sum(int(rows[s].get(m) or 0) for s in stages) for m in mech_cols}
    totals["bench_total"] = sum(int(rows[s].get("bench_total") or 0) for s in stages)
    totals["pool_total"] = sum(int(rows[s].get("pool_total") or 0) for s in stages)
    order_idx = {k: i for i, k in enumerate(STAGE_ORDER)}
    stages.sort(key=lambda s: (order_idx.get(s, 99), s))
    return {
        "stages": stages,
        "stage_names": stage_names,
        "mechanisms": mech_cols,
        "rows": rows,
        "totals": totals,
    }


def _compact_case(rec: dict, relpath: str, offset: int, length: int, min_tier: int, is_long: bool) -> dict:
    probs_raw = rec.get("problems") or []
    probs = []
    for p in probs_raw:
        if not isinstance(p, dict):
            continue
        probs.append({
            "severity": _clean(p.get("severity") or rec.get("severity")),
            "label": _clip(p.get("label"), 140),
            "path": _clean(p.get("path")),
            "path_source": _clean(p.get("path_source")),
            "l1": _clean(p.get("l1")),
            "l2": _clean(p.get("l2")),
            "l3": _clean(p.get("l3")) or _clean(p.get("path")),
            "component": _clean(p.get("component")),
            "component_role": _clean(p.get("component_role")),
        })

    prim_in = rec.get("primary") or {}
    l1 = _clean(prim_in.get("l1")) or "NA"
    l2 = _clean(prim_in.get("l2")) or "NA"
    l3 = _clean(prim_in.get("l3")) or "NA"
    prim_prob = next((p for p in probs if l3 != "NA" and p.get("path") == l3), probs[0] if probs else {})
    primary = {
        "l1": l1,
        "l2": l2,
        "l3": l3,
        "label": _clip(prim_prob.get("label") or ("goldencase" if rec.get("severity") == "GOLD" else ""), 120),
        "path": _clean(prim_prob.get("path") or (l3 if l3 != "NA" else "")),
        "path_source": _clean(prim_prob.get("path_source") or ("none" if rec.get("severity") == "GOLD" else "join")),
    }

    st = rec.get("stats") or {}
    mt = rec.get("meta") or {}
    bn = rec.get("bench") or {}
    day = _extract_day(rec)
    tool_names = [x.strip() for x in _clean(mt.get("tool_names_text")).split(",") if x.strip()]
    return {
        "trace_id": _clean(rec.get("trace_id")),
        "session_id": _clean(rec.get("session_id")),
        "model": _clean(rec.get("model")),
        "day": day,
        "request_time": _clean(rec.get("request_time")),
        "group": _clean(rec.get("group")),
        "question": _clip(rec.get("question"), 220),
        "turn": _clean(rec.get("turn") or "single"),
        "session_round": int(rec.get("session_round") or 1),
        "turn_index": int(rec.get("turn_index") or 1),
        "severity": _clean(rec.get("severity") or "GOLD"),
        "primary": primary,
        "probs_count": len(probs),
        "probs_search": _clip(" | ".join(
            f"{x.get('label') or ''} {x.get('path') or ''}".strip() for x in probs if x.get("label") or x.get("path")
        ), 360),
        "stats": {
            "total_tokens": int(st.get("total_tokens") or 0),
            "input_tokens": int(st.get("input_tokens") or 0),
            "tool_count": int(st.get("tool_count") or 0),
            "latency": round(float(st.get("latency") or 0.0), 1),
            "dup_question": int(st.get("dup_question") or 1),
        },
        "meta": {
            "recalled_from": _clean(mt.get("recalled_from") or "unknown") or "unknown",
            "comefrom": _clean(mt.get("comefrom")),
            "source": _clean(mt.get("source")),
            "tool_names": tool_names[:12],
        },
        "bench": {
            "tier": int(bn.get("tier") or min_tier),
            "min_tier": 0 if is_long else min_tier,
            "long_tier": min_tier if is_long else 0,
            "rank": int(bn.get("rank") or 0),
            "pool_size": int(bn.get("pool_size") or 0),
        },
        "loc": [relpath, int(offset), int(length)],
    }


def _stream_max_tier(root: Path, jsonl_path: Path, tier_by_tid: dict[str, int], default_tier: int, is_long: bool):
    rows = []
    if not jsonl_path.is_file():
        return rows
    relpath = jsonl_path.relative_to(root).as_posix()
    with jsonl_path.open("rb") as fh:
        while True:
            offset = fh.tell()
            raw = fh.readline()
            if not raw:
                break
            length = len(raw)
            if not raw.strip():
                continue
            try:
                rec = _jloads(raw)
            except ValueError:
                continue
            tid = _clean(rec.get("trace_id"))
            if not tid:
                continue
            mtier = tier_by_tid.get(tid, default_tier)
            rows.append(_compact_case(rec, relpath, offset, length, mtier, is_long))
    rows.sort(key=lambda r: r["bench"]["rank"])
    return rows


def _derive_extra_and_sev_cells(cases: list[dict], tiers: list[int], is_long: bool) -> dict[int, dict]:
    out = {}
    for t in tiers:
        sub = [
            c for c in cases
            if (c["bench"]["long_tier"] if is_long else c["bench"]["min_tier"]) <= t
        ]
        n = len(sub)
        with_tool = sum(1 for c in sub if c["stats"]["tool_count"] > 0)
        lat_sum = sum(float(c["stats"]["latency"]) for c in sub)
        dup_ge2 = sum(1 for c in sub if c["stats"]["dup_question"] >= 2)
        all_toks = sorted(c["stats"]["total_tokens"] for c in sub)
        nz_toks = [x for x in all_toks if x > 0]
        sev_cells = defaultdict(lambda: {"P0": 0, "P1": 0})
        for c in sub:
            sev = c.get("severity")
            p = c["primary"]
            if sev in ("P0", "P1") and p["l1"] != "NA" and p["l2"] != "NA":
                sev_cells[f"{p['l1']}.{p['l2']}"][sev] += 1
        out[t] = {
            "tokens": {
                "p50": _quantile(all_toks, 0.5),
                "p90": _quantile(all_toks, 0.9),
                "p99": _quantile(all_toks, 0.99),
            },
            "extra": {
                "with_tool_rate": round(with_tool / n, 4) if n else 0.0,
                "avg_latency": round(lat_sum / n, 1) if n else 0.0,
                "dup_ge2_count": dup_ge2,
                "known_tokens_p50": _quantile(nz_toks, 0.5),
                "known_tokens_p90": _quantile(nz_toks, 0.9),
            },
            "sev_cells": dict(sev_cells),
        }
    return out


def _derive_long_tier_stats(cases: list[dict], req_n: int, pool_size: int, pool_stats: dict, params: dict, stage_names: dict, mech_names: dict, pat_names: dict) -> dict:
    sub = [c for c in cases if 0 < c["bench"]["long_tier"] <= req_n]
    actual = len(sub)
    sev_actual = Counter(c["severity"] for c in sub)
    turn_actual = Counter(c["turn"] for c in sub)
    stage_actual = Counter(c["primary"]["l1"] for c in sub if c["primary"]["l1"] != "NA")
    mech_actual = Counter(c["primary"]["l2"] for c in sub if c["primary"]["l2"] != "NA")

    g_share = float(params.get("golden_share") or 0.2)
    p0_cap = float(params.get("p0_cap") or 0.25)
    g_t = round(req_n * g_share)
    p0_t = round(req_n * p0_cap)
    rem = max(0, req_n - g_t - p0_t)
    sev_target = {
        "GOLD": g_t, "P0": p0_t,
        "P1": round(rem * 0.4), "P2": round(rem * 0.3),
        "P3": round(rem * 0.2), "P4": max(0, rem - round(rem * 0.4) - round(rem * 0.3) - round(rem * 0.2)),
    }

    toks = sorted(c["stats"]["total_tokens"] for c in sub)
    nz_toks = [x for x in toks if x > 0]
    with_tool = sum(1 for c in sub if c["stats"]["tool_count"] > 0)
    lat_sum = sum(float(c["stats"]["latency"]) for c in sub)
    dup_ge2 = sum(1 for c in sub if c["stats"]["dup_question"] >= 2)

    pool_dims = (pool_stats.get("dims") or {}) if isinstance(pool_stats, dict) else {}
    dim_counts = {d: Counter() for d in DIMS}
    sev_cells = defaultdict(lambda: {"P0": 0, "P1": 0})
    ct_rows = {}
    ct_totals = Counter()
    all_stages = [s for s in STAGE_ORDER if s in stage_names or stage_actual[s] > 0]
    for s in all_stages:
        ct_rows[s] = {m: 0 for m in MECH_IDS}
        ct_rows[s]["bench_total"] = 0
        ct_rows[s]["pool_total"] = 0

    defect_total = 0
    for c in sub:
        l1 = c["primary"]["l1"]
        l2 = c["primary"]["l2"]
        l3 = c["primary"]["l3"]
        if l1 != "NA" and l2 != "NA":
            defect_total += 1
            if l1 not in ct_rows:
                ct_rows[l1] = {m: 0 for m in MECH_IDS}
                ct_rows[l1]["bench_total"] = 0
                ct_rows[l1]["pool_total"] = 0
            ct_rows[l1][l2] = ct_rows[l1].get(l2, 0) + 1
            ct_rows[l1]["bench_total"] += 1
            ct_totals[l2] += 1
            if c["severity"] in ("P0", "P1"):
                sev_cells[f"{l1}.{l2}"][c["severity"]] += 1

        dim_counts["severity"][c["severity"]] += 1
        if l1 != "NA":
            dim_counts["stage"][l1] += 1
        if l2 != "NA":
            dim_counts["mechanism"][l2] += 1
        if l3 != "NA":
            dim_counts["pattern"][l3] += 1
        dim_counts["turn_type"][c["turn"]] += 1
        if c["day"]:
            dim_counts["day"][c["day"]] += 1
        dim_counts["round"][round_bucket(c["session_round"])] += 1
        if c["group"]:
            dim_counts["group"][c["group"]] += 1

    # Inject pool stage totals if present in pool_stats
    for pr in pool_dims.get("stage") or []:
        sk = pr.get("key")
        if sk in ct_rows:
            ct_rows[sk]["pool_total"] = int(pr.get("count") or 0)

    dims_out = {}
    coverage_out = []
    tol = float(params.get("tolerance_pp") or 10.0)
    for d in DIMS:
        plist = [x for x in (pool_dims.get(d) or []) if x.get("key") not in (None, "", "NA")]
        p_map = {str(x.get("key")): x for x in plist}
        keys = list(dict.fromkeys([str(x.get("key")) for x in plist] + list(dim_counts[d].keys())))
        denom = defect_total if d in TAX_DIMS else actual
        rows = []
        for k in keys:
            cnt = dim_counts[d][k]
            pr = p_map.get(k) or {}
            sb = cnt / denom if denom else 0.0
            sp = float(pr.get("share") or 0.0)
            bucket = _clean(pr.get("bucket")) or k
            if d == "pattern":
                bucket = pat_names.get(k) or stage_names.get(k) or bucket
            elif d == "stage":
                bucket = stage_names.get(k) or bucket
            elif d == "mechanism":
                bucket = mech_names.get(k) or bucket
            rows.append({
                "key": k,
                "bucket": bucket,
                "count": cnt,
                "share_in_bench": round(sb, 6),
                "share_in_pool": round(sp, 6),
                "delta_pp": round((sb - sp) * 100.0, 2),
            })
        dims_out[d] = rows
        max_abs = max((abs(r["delta_pp"]) for r in rows), default=0.0)
        by_design = d in BY_DESIGN_DIMS
        coverage_out.append({
            "dim": d,
            "max_abs_delta_pp": round(max_abs, 2),
            "n_keys": len(rows),
            "n_keys_missing": sum(1 for r in rows if r["count"] == 0),
            "tolerance_pp": tol,
            "by_design": by_design,
            "ok": True if by_design else max_abs <= tol,
        })

    return {
        "requested": req_n,
        "actual": actual,
        "shortfall": max(0, req_n - actual),
        "pool": pool_size,
        "severity_target": sev_target,
        "severity_actual": {s: sev_actual.get(s, 0) for s in SEVS_ALL},
        "stage_actual": dict(stage_actual),
        "mechanism_actual": dict(mech_actual),
        "turn_actual": {"single": turn_actual.get("single", 0), "multi": turn_actual.get("multi", 0)},
        "tokens": {"p50": _quantile(toks, 0.5), "p90": _quantile(toks, 0.9), "p99": _quantile(toks, 0.99)},
        "extra": {
            "with_tool_rate": round(with_tool / actual, 4) if actual else 0.0,
            "avg_latency": round(lat_sum / actual, 1) if actual else 0.0,
            "dup_ge2_count": dup_ge2,
            "known_tokens_p50": _quantile(nz_toks, 0.5),
            "known_tokens_p90": _quantile(nz_toks, 0.9),
        },
        "dims": dims_out,
        "coverage": coverage_out,
        "crosstab": {
            "stages": [s for s in all_stages if s in ct_rows],
            "stage_names": {k: v for k, v in stage_names.items() if k in ct_rows},
            "mechanisms": list(MECH_IDS),
            "rows": ct_rows,
            "totals": {**{m: ct_totals.get(m, 0) for m in MECH_IDS}, "bench_total": defect_total, "pool_total": sum(r.get("pool_total", 0) for r in ct_rows.values()) or pool_size},
            "sev_cells": dict(sev_cells),
        },
    }


def _scan_dynamic_bench(root: Path) -> tuple[dict, dict[str, list[dict]]]:
    manifest = _scrub_obj(json.loads((root / "manifest.json").read_text(encoding="utf-8")))
    params = manifest.get("params") or {}
    model_names = list((manifest.get("models") or {}).keys()) or list(params.get("models") or [])

    stage_names = {}
    mech_names = {}
    pat_names = {}
    models_out = {}
    models_cases = {}

    for m in model_names:
        mdir = root / m
        if not mdir.is_dir():
            continue
        ps_path = mdir / "pool_stats.json"
        pool_stats = _scrub_obj(json.loads(ps_path.read_text(encoding="utf-8"))) if ps_path.is_file() else {}
        if isinstance(pool_stats.get("dims"), dict):
            pool_stats["dims"].pop("difficulty", None)

        m_meta = (manifest.get("models") or {}).get(m) or {}
        pool_size = int(m_meta.get("pool_size") or pool_stats.get("pool_size") or 0)
        base_pool = int(m_meta.get("base_pool") or pool_size)
        long_pool = int(m_meta.get("long_pool") or 0)

        # Base tier files ordered ascending -> map trace_id -> smallest tier it appears in
        std_files = []
        for p in mdir.glob("tier_*.jsonl"):
            stem_num = p.stem[len("tier_"):]
            if _ROUND_RE.match(stem_num):
                std_files.append((int(stem_num), p))
        std_files.sort()

        tier_by_tid: dict[str, int] = {}
        for tnum, tpath in std_files[:-1]:
            for tid in _scan_trace_ids(tpath):
                tier_by_tid.setdefault(tid, tnum)
        max_std_tier, max_std_path = std_files[-1] if std_files else (0, None)
        std_cases = _stream_max_tier(root, max_std_path, tier_by_tid, max_std_tier, False) if max_std_path else []
        std_tier_nums = [t for t, _ in std_files]
        std_extra = _derive_extra_and_sev_cells(std_cases, std_tier_nums, False)

        # Long tier files
        long_files = []
        ldir = mdir / "long"
        if ldir.is_dir():
            for p in ldir.glob("tier_*_long.jsonl"):
                mid = p.stem[len("tier_"):-len("_long")]
                if _ROUND_RE.match(mid):
                    long_files.append((int(mid), p))
        long_files.sort()

        long_by_tid: dict[str, int] = {}
        for tnum, tpath in long_files[:-1]:
            for tid in _scan_trace_ids(tpath):
                long_by_tid.setdefault(tid, tnum)
        max_long_tier, max_long_path = long_files[-1] if long_files else (0, None)
        long_cases = _stream_max_tier(root, max_long_path, long_by_tid, max_long_tier, True) if max_long_path else []

        models_cases[m] = std_cases + long_cases

        # Load precomputed tier stats + CSVs cleanly
        tiers_out = {}
        sdir = mdir / "stats"
        for tnum in std_tier_nums:
            tj = sdir / f"tier_{tnum}.json"
            t_meta = _scrub_obj(json.loads(tj.read_text(encoding="utf-8"))) if tj.is_file() else {}
            dims = {}
            for d in DIMS:
                rows = _read_dim_csv(sdir / f"tier_{tnum}.dim_{d}.csv")
                if d in TAX_DIMS:
                    rows = [r for r in rows if r["key"] and r["key"] != "NA"]
                if d == "mechanism":
                    for r in rows:
                        if r["bucket"]:
                            mech_names.setdefault(r["key"], r["bucket"])
                elif d == "pattern":
                    for r in rows:
                        if r["bucket"] and r["bucket"] != r["key"]:
                            pat_names.setdefault(r["key"], r["bucket"])
                dims[d] = rows
            ct = _read_crosstab_csv(sdir / f"tier_{tnum}.crosstab_stage_mechanism.csv") or {}
            if ct.get("stage_names"):
                stage_names.update(ct["stage_names"])
            extra_info = std_extra.get(tnum) or {}
            if ct:
                ct["sev_cells"] = extra_info.get("sev_cells") or {}
            cov = _read_coverage_csv(sdir / f"tier_{tnum}.coverage.csv")
            tiers_out[str(tnum)] = {
                "requested": int(t_meta.get("requested") or tnum),
                "actual": int(t_meta.get("actual") or 0),
                "shortfall": int(t_meta.get("shortfall") or 0),
                "pool": base_pool,
                "severity_target": t_meta.get("severity_target") or {},
                "severity_actual": t_meta.get("severity_actual") or {},
                "stage_actual": t_meta.get("stage_actual") or {},
                "mechanism_actual": t_meta.get("mechanism_actual") or {},
                "turn_actual": t_meta.get("turn_actual") or {},
                "tokens": t_meta.get("tokens") or extra_info.get("tokens") or {"p50": 0, "p90": 0, "p99": 0},
                "extra": extra_info.get("extra") or {},
                "dims": dims,
                "coverage": cov,
                "crosstab": ct,
            }

        long_tiers_out = {}
        for lnum, _ in long_files:
            long_tiers_out[str(lnum)] = _derive_long_tier_stats(
                long_cases, lnum, long_pool, pool_stats, params, stage_names, mech_names, pat_names,
            )

        models_out[m] = {
            "pool_size": pool_size,
            "base_pool": base_pool,
            "long_pool": long_pool,
            "pool_stats": {
                "pool_size": int(pool_stats.get("pool_size") or base_pool),
                "base_pool": base_pool,
                "long_pool": long_pool,
                "by_severity": pool_stats.get("by_severity") or m_meta.get("pool_by_severity") or {},
                "by_turn": pool_stats.get("by_turn") or m_meta.get("pool_by_turn") or {},
                "tokens": pool_stats.get("tokens") or {},
                "dims": pool_stats.get("dims") or {},
            },
            "tiers": tiers_out,
            "long_tiers": long_tiers_out,
        }

    # Backfill primary.label on cases from pattern chinese names if needed
    for clist in models_cases.values():
        for c in clist:
            p = c["primary"]
            if not p["label"] and p["l3"] in pat_names:
                p["label"] = pat_names[p["l3"]]

    summary_base = {
        "schema": DYNAMIC_SCHEMA,
        "manifest": manifest,
        "stage_names": stage_names,
        "mech_names": mech_names,
        "pat_names": pat_names,
        "models": models_out,
    }
    return summary_base, models_cases


def build_dynamic_bench(
    datasets: Path,
    product: str,
    trace_refs: dict[str, tuple[str, str]] | None = None,
    cache_dir: Path | None = None,
) -> tuple[dict, dict] | None:
    """Build or refresh ``schema:2`` Bench summary + disk index, caching raw JSONL extraction by sig."""
    root = dynamic_bench_root(datasets, product)
    if not root:
        return None
    sig = dynamic_bench_signature(datasets, product)
    cache_path = (cache_dir / f"dynamic-bench-{product}.pkl") if cache_dir else None

    summary_base, models_cases = None, None
    if cache_path and cache_path.is_file():
        try:
            with cache_path.open("rb") as fh:
                cached = pickle.load(fh)
            if isinstance(cached, dict) and cached.get("sig") == sig:
                summary_base = cached["summary"]
                models_cases = cached["cases"]
        except (OSError, ValueError, pickle.PickleError, KeyError):
            summary_base, models_cases = None, None

    if summary_base is None or models_cases is None:
        summary_base, models_cases = _scan_dynamic_bench(root)
        if cache_path:
            try:
                cache_path.parent.mkdir(parents=True, exist_ok=True)
                tmp = cache_path.with_name(f"{cache_path.name}.{os.getpid()}.tmp")
                with tmp.open("wb") as fh:
                    pickle.dump({"sig": sig, "summary": summary_base, "cases": models_cases}, fh, protocol=pickle.HIGHEST_PROTOCOL)
                os.replace(tmp, cache_path)
            except OSError:
                pass

    refs = trace_refs or {}
    stamped_models = {}
    linked_counts = {}
    for m, rows in models_cases.items():
        stamped = []
        matched = 0
        for row in rows:
            tid = row.get("trace_id") or ""
            ref = refs.get(tid)
            copy = dict(row)
            if ref:
                copy["slug"] = ref[0]
                copy["case_key"] = ref[1]
                matched += 1
            else:
                copy["slug"] = None
                copy["case_key"] = None
            stamped.append(copy)
        stamped_models[m] = stamped
        linked_counts[m] = matched

    summary = {**summary_base, "product": product, "linked_counts": linked_counts}
    index = {"schema": DYNAMIC_SCHEMA, "product": product, "sig": sig, "models": stamped_models}
    return summary, index


def public_case_row(row: dict) -> dict:
    """Strip internal filesystem offset locator before sending compact case metadata to browser."""
    return {k: v for k, v in row.items() if k != "loc"}


def case_matches_query(row: dict, params: dict, long_threshold: int = 65536) -> bool:
    model = params.get("model") or ""
    if model and row.get("model") != model:
        return False
    want_long = str(params.get("long") or "0") == "1"
    bn = row.get("bench") or {}
    t_str = params.get("tier") or ""
    if want_long:
        lt = int(bn.get("long_tier") or 0)
        if lt <= 0:
            return False
        if t_str.isdigit() and lt > int(t_str):
            return False
    else:
        mt = int(bn.get("min_tier") or 0)
        if int(bn.get("long_tier") or 0) > 0 or mt <= 0:
            return False
        if t_str.isdigit() and mt > int(t_str):
            return False

    sev = params.get("sev") or ""
    if sev and row.get("severity") != sev:
        return False
    p = row.get("primary") or {}
    if params.get("l1") and (p.get("l1") or "NA") != params["l1"]:
        return False
    if params.get("l2") and (p.get("l2") or "NA") != params["l2"]:
        return False
    if params.get("l3") and (p.get("l3") or "NA") != params["l3"]:
        return False
    if params.get("turn") and row.get("turn") != params["turn"]:
        return False
    st = row.get("stats") or {}
    mt = row.get("meta") or {}
    if params.get("tok") and tokens_bucket(st.get("total_tokens")) != params["tok"]:
        return False
    if params.get("rnd") and round_bucket(row.get("session_round")) != params["rnd"]:
        return False
    if params.get("day") and row.get("day") != params["day"]:
        return False
    if params.get("grp") and row.get("group") != params["grp"]:
        return False
    if params.get("rec") and mt.get("recalled_from") != params["rec"]:
        return False
    if params.get("psrc") and (p.get("path_source") or "none") != params["psrc"]:
        return False
    if str(params.get("dup") or "") in ("1", "true") and int(st.get("dup_question") or 1) < 2:
        return False
    if str(params.get("longOnly") or "") in ("1", "true") and int(st.get("total_tokens") or 0) < long_threshold:
        return False
    q = (params.get("q") or "").strip().lower()
    if q:
        hay = " ".join([
            row.get("question") or "",
            row.get("trace_id") or "",
            row.get("session_id") or "",
            p.get("label") or "",
            p.get("path") or "",
            row.get("group") or "",
            " ".join(mt.get("tool_names") or []),
            row.get("probs_search") or " ".join(f"{x.get('label') or ''} {x.get('path') or ''}" for x in (row.get("problems") or [])),
        ]).lower()
        if q not in hay:
            return False
    return True


def _row_probs_count(row: dict) -> int:
    cnt = row.get("probs_count")
    if cnt is not None:
        return int(cnt)
    return len(row.get("problems") or [])


def sort_case_rows(rows: list[dict], sort_key: str = "rank") -> list[dict]:
    sev_order = {"P0": 0, "P1": 1, "P2": 2, "P3": 3, "P4": 4, "GOLD": 5}
    if sort_key == "sev":
        return sorted(rows, key=lambda r: (sev_order.get(r.get("severity"), 9), -_row_probs_count(r), r["bench"]["rank"]))
    if sort_key == "dup":
        return sorted(rows, key=lambda r: (-int(r["stats"].get("dup_question") or 1), r["bench"]["rank"]))
    if sort_key == "tokens":
        return sorted(rows, key=lambda r: (-int(r["stats"].get("total_tokens") or 0), r["bench"]["rank"]))
    if sort_key == "latency":
        return sorted(rows, key=lambda r: (-float(r["stats"].get("latency") or 0.0), r["bench"]["rank"]))
    if sort_key == "probs":
        return sorted(rows, key=lambda r: (-_row_probs_count(r), sev_order.get(r.get("severity"), 9)))
    if sort_key == "day":
        return sorted(rows, key=lambda r: r.get("request_time") or r.get("day") or "", reverse=True)
    return sorted(rows, key=lambda r: r["bench"]["rank"])


def load_bench_case(datasets: Path, row: dict) -> dict | None:
    """Seek a single full Bench record directly out of ``3_dynamic_bench`` JSONL."""
    loc = row.get("loc")
    if not isinstance(loc, (list, tuple)) or len(loc) != 3:
        return None
    relpath, offset, length = loc
    bench_root = (Path(datasets) / DYNAMIC_DIR).resolve()
    try:
        target = (bench_root / relpath).resolve()
        if not target.is_relative_to(bench_root):
            return None
        with target.open("rb") as fh:
            fh.seek(int(offset))
            raw = fh.read(int(length))
        rec = _scrub_obj(_jloads(raw))
    except (OSError, ValueError, TypeError):
        return None

    mt = rec.get("meta") if isinstance(rec.get("meta"), dict) else {}
    st = rec.get("stats") if isinstance(rec.get("stats"), dict) else {}
    st.pop("difficulty", None)
    if "tool_names" not in mt:
        mt["tool_names"] = [x.strip() for x in _clean(mt.get("tool_names_text")).split(",") if x.strip()]
    if "skill_names" not in mt:
        mt["skill_names"] = [x.strip() for x in _clean(mt.get("skill_names_text")).split(",") if x.strip()]

    rec["day"] = row.get("day") or _extract_day(rec)
    rec["primary"] = row.get("primary") or rec.get("primary") or {}
    rec["bench"] = {**(rec.get("bench") or {}), **(row.get("bench") or {})}
    rec["slug"] = row.get("slug")
    rec["case_key"] = row.get("case_key")
    return rec
