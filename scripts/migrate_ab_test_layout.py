#!/usr/bin/env python3
"""Migrate legacy `/mnt/aime_eval_ssd/1_aime/ab_test` rounds into the canonical layout.

Legacy rounds (`0_version1106_test`, `1_version1112_test`) are converted into:
    version_<YYYYMMDD>_<model>/
      bench/bench.jsonl
      agent_before_opt/{res_before_opt.jsonl, eval_output/attribution.jsonl, cluster/}
      agent_after_opt/{res_after_opt.jsonl, eval_output/{attribution.jsonl,compact.jsonl}, cluster/}
      index_stats/{meta.json, pairs_index.csv, stats.json}
      [verify/verify.jsonl, gpt_answer/{questions.jsonl,raw/}]

`2_version1119_test`, `04_after_release_online_real`, `08_annoation_workbench`,
`09_model_chain`, and `99_provenance` are intentionally dropped.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import re
import shutil
import sqlite3
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

csv.field_size_limit(min(sys.maxsize, 2**31 - 1))

EQ_RE = re.compile(r"_eq_(\d+)$")

PAIRS_COLUMNS = [
    "eq_index",
    "case_key",
    "trace_id",
    "session_id",
    "question_time",
    "question",
    "task",
    "subtask",
    "before_status",
    "before_b_reason",
    "before_trace_id",
    "before_n_problem",
    "before_severity",
    "before_cls_paths",
    "before_cls_labels",
    "after_status",
    "after_trace_id",
    "after_session_id",
    "after_n_problem",
    "after_severity",
    "after_cls_paths",
    "after_cls_labels",
]


def _read_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _read_csv(path: Path) -> list[dict[str, str]]:
    if not path.is_file():
        return []
    with path.open("r", encoding="utf-8", newline="") as fh:
        return list(csv.DictReader(fh))


def _atomic_write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.parent / f".{path.name}.tmp"
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(tmp, path)


def _atomic_write_csv(path: Path, fieldnames: list[str], rows: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.parent / f".{path.name}.tmp"
    with tmp.open("w", encoding="utf-8", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=fieldnames)
        writer.writeheader()
        for row in rows:
            writer.writerow(row)
    os.replace(tmp, path)


def _extract_tids_from_input(rec: dict[str, Any]) -> list[str]:
    tids: list[str] = []
    for k in (rec.get("trace_id"), (rec.get("meta") or {}).get("trace_id")):
        if k and str(k) not in tids:
            tids.append(str(k))
    for tr in rec.get("traces") or []:
        if not isinstance(tr, dict):
            continue
        for k in (tr.get("trace_id"), (tr.get("meta") or {}).get("trace_id")):
            if k and str(k) not in tids:
                tids.append(str(k))
    return tids


def _extract_tids_from_attr(rec: dict[str, Any]) -> list[str]:
    tids: list[str] = []
    for t in rec.get("turns") or []:
        if not isinstance(t, dict):
            continue
        tid = (t.get("meta") or {}).get("trace_id")
        if tid and str(tid) not in tids:
            tids.append(str(tid))
    sm = rec.get("session_meta") or {}
    if not tids and sm.get("trace_id"):
        tids.append(str(sm["trace_id"]))
    return tids


def _max_severity(attr: dict[str, Any]) -> str:
    order = {"P0": 0, "P1": 1, "P2": 2, "P3": 3, "P4": 4}
    best = None
    for t in attr.get("turns") or []:
        for p in (t.get("problem") or []) if isinstance(t, dict) else []:
            sev = str((p or {}).get("severity") or "").upper()
            if sev in order and (best is None or order[sev] < order[best]):
                best = sev
    for p in attr.get("session_problem") or []:
        sev = str((p or {}).get("severity") or "").upper()
        if sev in order and (best is None or order[sev] < order[best]):
            best = sev
    return best or ""


def _load_build_input_locations(build_db: Path | None) -> dict[str, tuple[str, int]]:
    if not build_db or not build_db.is_file():
        return {}
    from array import array
    conn = sqlite3.connect(f"file:{build_db}?mode=ro", uri=True)
    try:
        rows = conn.execute(
            "SELECT path, tids, offsets FROM files "
            "WHERE path LIKE '%/eval_input/%' OR path LIKE '%/.archive/%'"
        ).fetchall()
        locs: dict[str, tuple[str, int]] = {}
        for path, tids, offsets in rows:
            offs = list(array("q", offsets))
            for i, arr in enumerate(json.loads(tids)):
                for tid in arr or []:
                    if tid:
                        locs.setdefault(str(tid), (str(path), int(offs[i])))
        return locs
    except (sqlite3.Error, ValueError, TypeError):
        return {}
    finally:
        conn.close()


def _load_live_scenes(live_abtests: Path | None) -> dict[str, dict[str, tuple[str, str]]]:
    """Return `{old_round_id: {trace_id: (task, subtask)}}` from existing abtests-aime.json."""
    if not live_abtests or not live_abtests.is_file():
        return {}
    data = _read_json(live_abtests)
    if not isinstance(data, dict):
        return {}
    out: dict[str, dict[str, tuple[str, str]]] = {}
    for rnd in data.get("rounds") or []:
        rid = str(rnd.get("id") or "")
        if not rid:
            continue
        scenes: dict[str, tuple[str, str]] = {}
        for side in ("before", "after"):
            for ref in (rnd.get("sample_refs") or {}).get(side) or []:
                tid = str(ref.get("pair") or ref.get("trace") or "")
                task = str(ref.get("task") or "").strip()
                sub = str(ref.get("sub") or "").strip()
                if tid and task and task != "未接入分类体系":
                    scenes.setdefault(tid, (task, sub))
        for pair in rnd.get("pairs") or []:
            tid = str(pair.get("id") or "")
            task = str(pair.get("scene") or "").strip()
            sub = str(pair.get("sub") or "").strip()
            if tid and task and task != "未接入分类体系":
                scenes.setdefault(tid, (task, sub))
        out[rid] = scenes
    return out


def _copy_cluster_dir(src_dir: Path, dst_dir: Path) -> None:
    if not src_dir.is_dir():
        return
    dst_dir.mkdir(parents=True, exist_ok=True)
    slice_src = src_dir / "item_index.slice.jsonl"
    raw_src = src_dir / "item_index.jsonl"
    for item in sorted(src_dir.iterdir()):
        if not item.is_file():
            continue
        if item.name in ("item_index.slice.jsonl", "item_index.jsonl"):
            continue
        shutil.copy2(item, dst_dir / item.name)
    chosen_index = slice_src if slice_src.is_file() else raw_src
    if chosen_index.is_file():
        shutil.copy2(chosen_index, dst_dir / "item_index.jsonl")


def _normalize_before_status(raw_status: str) -> str:
    s = (raw_status or "").strip()
    if s.startswith("已评测") or s == "evaluated":
        return "evaluated"
    return "missing"


def _normalize_b_reason(raw_reason: str) -> str:
    r = (raw_reason or "").strip()
    if "B1" in r or "无问题" in r:
        return "B1"
    if "B2" in r or "未进树" in r:
        return "B2"
    return r


def _normalize_after_status(raw_state: str) -> str:
    s = (raw_state or "").strip()
    if s.startswith("已重测") or s == "evaluated":
        return "evaluated"
    if "失败" in s or "无完整" in s or s == "failed":
        return "failed"
    if "待" in s or s == "pending":
        return "pending"
    return "missing"


def _is_non_expert(row: dict[str, str]) -> bool:
    mode = (row.get("mode") or "").strip().lower()
    store = (row.get("eval_store") or "").strip().lower()
    return mode == "fast" or "fast" in store


def _migrate_round(
    *,
    src_round: Path,
    dst_round: Path,
    version_yyyymmdd: str,
    model_name: str,
    datasets_root: Path,
    input_locs: dict[str, tuple[str, int]],
    live_scenes: dict[str, tuple[str, str]],
) -> dict[str, Any]:
    if dst_round.exists():
        shutil.rmtree(dst_round)
    dst_round.mkdir(parents=True, exist_ok=True)

    round_json = _read_json(src_round / "round.json") or {}
    released_at = str(
        round_json.get("released_at")
        or f"{version_yyyymmdd[:4]}-{version_yyyymmdd[4:6]}-{version_yyyymmdd[6:8]}"
    )
    label = str(round_json.get("label") or f"{version_yyyymmdd[4:]} 发版")
    title = str(round_json.get("title") or f"AIME v{version_yyyymmdd[4:]} 优化前后对比")

    # 1. Load coverage & scene maps
    cov_before_path = src_round / "00_manifest" / "coverage_before_release_cluster.csv"
    if not cov_before_path.is_file():
        cov_before_path = src_round / "00_manifest" / "coverage_before_release.csv"
    cov_before_rows = _read_csv(cov_before_path)
    cov_after_rows = _read_csv(src_round / "00_manifest" / "coverage_after_release_retest.csv")
    cov_after_by_tid = {str(r.get("trace_id") or ""): r for r in cov_after_rows if r.get("trace_id")}

    trace_scenes: dict[str, tuple[str, str]] = dict(live_scenes)
    for r in _read_csv(src_round / "00_manifest" / "trace_scenes.csv"):
        tid = str(r.get("trace_id") or "").strip()
        task = str(r.get("task") or "").strip()
        sub = str(r.get("subtask") or "").strip()
        if tid and task:
            trace_scenes.setdefault(tid, (task, sub))

    targets_raw: list[dict[str, Any]] = []
    q_path = src_round / "01_targets" / "questions.jsonl"
    if q_path.is_file():
        with q_path.open("r", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    targets_raw.append(json.loads(line))
                except ValueError:
                    continue

    # Filter out non-expert rows (e.g. 55 fast rows in 1106)
    cov_before_by_tid: dict[str, dict[str, str]] = {}
    dropped_fast_tids: set[str] = set()
    for r in cov_before_rows:
        tid = str(r.get("trace_id") or "")
        if not tid:
            continue
        if _is_non_expert(r):
            dropped_fast_tids.add(tid)
            continue
        cov_before_by_tid[tid] = r

    # Preserve existing eq_index for rows in coverage_after_release_retest.csv
    max_eq = 0
    for r in cov_after_rows:
        try:
            max_eq = max(max_eq, int(r.get("eq_index") or 0))
        except ValueError:
            pass

    target_entries: list[dict[str, Any]] = []
    seen_target_tids: set[str] = set()
    source_rows = targets_raw or [{"trace_id": r["trace_id"], **r} for r in cov_before_rows]
    next_eq = max_eq + 1
    for raw in source_rows:
        tid = str(raw.get("trace_id") or "")
        if not tid or tid in dropped_fast_tids or tid in seen_target_tids:
            continue
        cb = cov_before_by_tid.get(tid)
        if cb is None and cov_before_by_tid:
            continue
        seen_target_tids.add(tid)
        ca = cov_after_by_tid.get(tid) or {}
        eq_val: int | None = None
        if ca.get("eq_index"):
            try:
                eq_val = int(ca["eq_index"])
            except ValueError:
                eq_val = None
        if eq_val is None or eq_val <= 0:
            eq_val = next_eq
            next_eq += 1
        cb = cb or {}
        task, sub = trace_scenes.get(tid, ("", ""))
        target_entries.append(
            {
                "eq_index": eq_val,
                "case_key": f"eq_{eq_val:05d}",
                "trace_id": tid,
                "session_id": str(raw.get("session_id") or cb.get("session_id") or ""),
                "user_id": str(raw.get("user_id") or cb.get("user_id") or ""),
                "question_time": str(raw.get("question_time") or cb.get("question_time") or ""),
                "mode": "expert",
                "model": model_name,
                "question": str(raw.get("question") or cb.get("question") or ""),
                "task": task,
                "subtask": sub,
                "eval_category": str(raw.get("eval_category") or cb.get("eval_category") or ""),
                "cb": cb,
                "ca": ca,
            }
        )

    target_entries.sort(key=lambda x: x["eq_index"])
    kept_tids = {t["trace_id"] for t in target_entries}

    # 2. Write bench/bench.jsonl
    bench_dir = dst_round / "bench"
    bench_dir.mkdir(parents=True, exist_ok=True)
    with (bench_dir / "bench.jsonl").open("w", encoding="utf-8") as fh:
        for t in target_entries:
            bench_row = {
                "eq_index": t["eq_index"],
                "case_key": t["case_key"],
                "trace_id": t["trace_id"],
                "session_id": t["session_id"],
                "user_id": t["user_id"],
                "question_time": t["question_time"],
                "mode": t["mode"],
                "model": t["model"],
                "question": t["question"],
                "task": t["task"],
                "subtask": t["subtask"],
                "eval_category": t["eval_category"],
            }
            fh.write(json.dumps(bench_row, ensure_ascii=False, separators=(",", ":")) + "\n")

    # 3. Migrate agent_before_opt
    before_root = dst_round / "agent_before_opt"
    before_eval = before_root / "eval_output"
    before_eval.mkdir(parents=True, exist_ok=True)

    # 3a. before attribution
    before_attr_dir = src_round / "02_before_release" / "attribution" / model_name
    before_attr_tids: set[str] = set()
    before_attr_meta: dict[str, str] = {}
    seen_attr_keys: set[str] = set()
    with (before_eval / "attribution.jsonl").open("w", encoding="utf-8") as out_fh:
        if before_attr_dir.is_dir():
            for src_file in sorted(before_attr_dir.rglob("*.jsonl")):
                with src_file.open("r", encoding="utf-8", errors="replace") as in_fh:
                    for raw_line in in_fh:
                        line = raw_line.strip()
                        if not line:
                            continue
                        try:
                            obj = json.loads(line)
                        except ValueError:
                            continue
                        tids = _extract_tids_from_attr(obj)
                        # Drop lines belonging strictly to removed fast traces
                        if tids and all(tid in dropped_fast_tids for tid in tids):
                            continue
                        if kept_tids and tids and not any(tid in kept_tids for tid in tids):
                            continue
                        sm = obj.get("session_meta") or {}
                        dedup = f"{','.join(sorted(tids))}|{sm.get('session_id') or ''}|{sm.get('request_time') or ''}"
                        if not tids:
                            dedup = hashlib.sha1(line.encode("utf-8")).hexdigest()
                        if dedup in seen_attr_keys:
                            continue
                        seen_attr_keys.add(dedup)
                        out_fh.write(line + "\n")
                        sev = _max_severity(obj)
                        for tid in tids:
                            before_attr_tids.add(tid)
                            if sev:
                                before_attr_meta[tid] = sev

    # 3b. before inputs (+ backfill missing from build.sqlite3 input_locations)
    before_in_dir = src_round / "02_before_release" / "inputs" / model_name
    before_in_tids: set[str] = set()
    seen_input_hashes: set[str] = set()
    backfilled_count = 0
    with (before_root / "res_before_opt.jsonl").open("w", encoding="utf-8") as out_fh:
        if before_in_dir.is_dir():
            for src_file in sorted(before_in_dir.rglob("*.jsonl")):
                with src_file.open("r", encoding="utf-8", errors="replace") as in_fh:
                    for raw_line in in_fh:
                        line = raw_line.strip()
                        if not line:
                            continue
                        try:
                            obj = json.loads(line)
                        except ValueError:
                            continue
                        tids = _extract_tids_from_input(obj)
                        if tids and all(tid in dropped_fast_tids for tid in tids):
                            continue
                        h = hashlib.sha1(line.encode("utf-8")).hexdigest()
                        if h in seen_input_hashes:
                            continue
                        seen_input_hashes.add(h)
                        out_fh.write(line + "\n")
                        before_in_tids.update(tids)

        missing_before_tids = (before_attr_tids | (kept_tids & before_attr_tids)) - before_in_tids
        for tid in sorted(missing_before_tids):
            loc = input_locs.get(tid)
            if not loc:
                continue
            rel, offset = loc
            src_path = datasets_root / rel
            if not src_path.is_file():
                continue
            try:
                with src_path.open("rb") as fh:
                    fh.seek(offset)
                    raw_bytes = fh.readline()
                line = raw_bytes.decode("utf-8", "replace").strip()
                if not line:
                    continue
                obj = json.loads(line)
                h = hashlib.sha1(line.encode("utf-8")).hexdigest()
                if h in seen_input_hashes:
                    before_in_tids.update(_extract_tids_from_input(obj))
                    continue
                seen_input_hashes.add(h)
                out_fh.write(line + "\n")
                before_in_tids.update(_extract_tids_from_input(obj))
                backfilled_count += 1
            except (OSError, ValueError):
                continue

    # 3c. before cluster
    _copy_cluster_dir(
        src_round / "02_before_release" / "cluster_tree" / model_name,
        before_root / "cluster",
    )

    # 4. Migrate agent_after_opt
    after_root = dst_round / "agent_after_opt"
    after_eval = after_root / "eval_output"
    after_eval.mkdir(parents=True, exist_ok=True)

    # 4a. after attribution
    after_attr_dir = src_round / "03_after_release_retest" / "attribution" / model_name
    mapped_candidates = sorted(after_attr_dir.rglob("*mapped*.jsonl")) if after_attr_dir.is_dir() else []
    if mapped_candidates:
        attr_files = mapped_candidates
    else:
        attr_files = sorted(after_attr_dir.rglob("*.jsonl")) if after_attr_dir.is_dir() else []
    after_attr_eqs: dict[int, dict[str, str]] = {}
    with (after_eval / "attribution.jsonl").open("w", encoding="utf-8") as out_fh:
        for src_file in attr_files:
            with src_file.open("r", encoding="utf-8", errors="replace") as in_fh:
                for raw_line in in_fh:
                    line = raw_line.strip()
                    if not line:
                        continue
                    try:
                        obj = json.loads(line)
                    except ValueError:
                        continue
                    sm = obj.get("session_meta") or {}
                    case_id = str(sm.get("case_id") or "")
                    m = EQ_RE.search(case_id)
                    if m:
                        eq_num = int(m.group(1))
                        if not any(t["eq_index"] == eq_num for t in target_entries):
                            continue
                        turns = obj.get("turns") or []
                        tmeta = (turns[0].get("meta") or {}) if turns and isinstance(turns[0], dict) else {}
                        after_attr_eqs[eq_num] = {
                            "trace_id": str(tmeta.get("trace_id") or sm.get("trace_id") or ""),
                            "session_id": str(sm.get("session_id") or ""),
                            "severity": _max_severity(obj),
                        }
                    out_fh.write(line + "\n")

    # 4b. after inputs
    after_input_files = sorted((src_round / "03_after_release_retest" / "inputs").glob("*.jsonl"))
    if not after_input_files:
        after_input_files = sorted((src_round / "99_provenance" / "retest_input").glob("*.jsonl"))
    seen_after_ids: set[str] = set()
    with (after_root / "res_after_opt.jsonl").open("w", encoding="utf-8") as out_fh:
        for src_file in after_input_files:
            with src_file.open("r", encoding="utf-8", errors="replace") as in_fh:
                for raw_line in in_fh:
                    line = raw_line.strip()
                    if not line:
                        continue
                    try:
                        obj = json.loads(line)
                    except ValueError:
                        continue
                    meta = obj.get("meta") if isinstance(obj.get("meta"), dict) else {}
                    uid = str(meta.get("item_id") or meta.get("case_id") or obj.get("case_id") or "")
                    if not uid:
                        uid = hashlib.sha1(line.encode("utf-8")).hexdigest()
                    if uid in seen_after_ids:
                        continue
                    seen_after_ids.add(uid)
                    out_fh.write(line + "\n")

    # 4c. after compact
    compact_dir = src_round / "99_provenance" / "retest_eval_run" / "compact"
    compact_files = sorted(compact_dir.glob("*.jsonl")) if compact_dir.is_dir() else []
    if compact_files:
        with (after_eval / "compact.jsonl").open("w", encoding="utf-8") as out_fh:
            for src_file in compact_files:
                with src_file.open("r", encoding="utf-8", errors="replace") as in_fh:
                    for raw_line in in_fh:
                        line = raw_line.strip()
                        if line:
                            out_fh.write(line + "\n")

    # 4d. after cluster
    _copy_cluster_dir(
        src_round / "03_after_release_retest" / "cluster_tree" / model_name,
        after_root / "cluster",
    )

    # 5. Optional verify & gpt_answer (preserved for 1106)
    verify_src = src_round / "06_verify" / "verify.jsonl"
    if verify_src.is_file():
        (dst_round / "verify").mkdir(parents=True, exist_ok=True)
        shutil.copy2(verify_src, dst_round / "verify" / "verify.jsonl")

    gpt_src = src_round / "07_gpt_answer"
    if gpt_src.is_dir():
        gpt_dst = dst_round / "gpt_answer"
        gpt_dst.mkdir(parents=True, exist_ok=True)
        if (gpt_src / "questions.jsonl").is_file():
            shutil.copy2(gpt_src / "questions.jsonl", gpt_dst / "questions.jsonl")
        if (gpt_src / "raw").is_dir():
            shutil.copytree(gpt_src / "raw", gpt_dst / "raw", dirs_exist_ok=True)

    # 6. index_stats/{meta.json, pairs_index.csv, stats.json}
    pair_rows: list[dict[str, Any]] = []
    before_counter: Counter[str] = Counter()
    after_counter: Counter[str] = Counter()
    common_count = 0
    before_hits = 0
    after_hits = 0

    for t in target_entries:
        cb = t["cb"]
        ca = t["ca"]
        eq_idx = t["eq_index"]
        b_status = _normalize_before_status(cb.get("status") or "")
        a_status = _normalize_after_status(ca.get("retest_state") or "")
        b_paths = cb.get("cls_paths") or ""
        a_paths = ca.get("cls_paths") or ""
        b_n = int(cb.get("eval_n_problem") or len([p for p in b_paths.split(";") if p]) or 0)
        a_n = int(ca.get("n_problem") or len([p for p in a_paths.split(";") if p]) or 0)
        a_info = after_attr_eqs.get(eq_idx) or {}

        pair_rows.append(
            {
                "eq_index": eq_idx,
                "case_key": t["case_key"],
                "trace_id": t["trace_id"],
                "session_id": t["session_id"],
                "question_time": t["question_time"],
                "question": t["question"],
                "task": t["task"],
                "subtask": t["subtask"],
                "before_status": b_status,
                "before_b_reason": _normalize_b_reason(cb.get("b_reason") or ""),
                "before_trace_id": t["trace_id"] if t["trace_id"] in before_attr_tids else "",
                "before_n_problem": b_n,
                "before_severity": before_attr_meta.get(t["trace_id"], ""),
                "before_cls_paths": b_paths,
                "before_cls_labels": cb.get("cls_labels") or "",
                "after_status": a_status,
                "after_trace_id": ca.get("retest_trace_id") or a_info.get("trace_id") or "",
                "after_session_id": ca.get("retest_session_id") or a_info.get("session_id") or "",
                "after_n_problem": a_n,
                "after_severity": ca.get("severity") or a_info.get("severity") or "",
                "after_cls_paths": a_paths,
                "after_cls_labels": ca.get("cls_labels") or "",
            }
        )
        if b_status == "evaluated":
            before_counter["evaluated"] += 1
        else:
            before_counter["missing"] += 1
        after_counter[a_status] += 1
        if b_status == "evaluated" and a_status == "evaluated":
            common_count += 1
            before_hits += len([p for p in b_paths.split(";") if p])
            after_hits += len([p for p in a_paths.split(";") if p])

    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    meta_payload = {
        "version": version_yyyymmdd,
        "model": model_name,
        "released_at": released_at,
        "label": label,
        "title": title,
        "before_label": "优化前",
        "after_label": "优化后",
        "tier": len(target_entries),
        "run_id": "",
        "generated_at": now,
    }
    stats_payload = {
        "generated_at": now,
        "version": version_yyyymmdd,
        "model": model_name,
        "total_targets": len(target_entries),
        "before_evaluated": before_counter["evaluated"],
        "after_evaluated": after_counter["evaluated"],
        "common_traces": common_count,
        "common_before_hits": before_hits,
        "common_after_hits": after_hits,
        "before_attr_traces": len(before_attr_tids),
        "before_input_traces": len(before_in_tids),
        "before_input_backfilled": backfilled_count,
        "after_attr_eqs": len(after_attr_eqs),
    }

    idx_dir = dst_round / "index_stats"
    _atomic_write_json(idx_dir / "meta.json", meta_payload)
    _atomic_write_csv(idx_dir / "pairs_index.csv", PAIRS_COLUMNS, pair_rows)
    _atomic_write_json(idx_dir / "stats.json", stats_payload)

    return stats_payload


def migrate(
    *,
    src_root: Path,
    dst_root: Path,
    datasets_root: Path,
    build_db: Path | None,
    live_abtests: Path | None,
) -> dict[str, Any]:
    dst_root.mkdir(parents=True, exist_ok=True)
    # Preserve 5003 service state DB if present
    service_state = src_root / ".service_state"
    if service_state.is_dir():
        shutil.copytree(service_state, dst_root / ".service_state", dirs_exist_ok=True)

    input_locs = _load_build_input_locations(build_db)
    live_scenes = _load_live_scenes(live_abtests)

    round_map = [
        ("0_version1106_test", "version_20261106_aime_expert", "20261106", "aime_expert"),
        ("1_version1112_test", "version_20261112_aime_expert", "20261112", "aime_expert"),
    ]
    summary: dict[str, Any] = {}
    for old_name, new_name, ver, model in round_map:
        src_round = src_root / old_name
        if not src_round.is_dir():
            continue
        stats = _migrate_round(
            src_round=src_round,
            dst_round=dst_root / new_name,
            version_yyyymmdd=ver,
            model_name=model,
            datasets_root=datasets_root,
            input_locs=input_locs,
            live_scenes=live_scenes.get(old_name, {}),
        )
        summary[new_name] = stats
    return summary


def main() -> int:
    parser = argparse.ArgumentParser(description="Migrate legacy ab_test directory to canonical layout.")
    parser.add_argument("--src-root", required=True, type=Path, help="Legacy backup ab_test root")
    parser.add_argument("--dst-root", required=True, type=Path, help="Destination ab_test root")
    parser.add_argument(
        "--datasets-root",
        type=Path,
        default=Path("/mnt/aime_eval_ssd"),
        help="Root containing 1_aime/eval_input (for build.sqlite3 backfill)",
    )
    parser.add_argument(
        "--build-db",
        type=Path,
        default=Path("/opt/eval_dashboard/cache/build.sqlite3"),
        help="Optional dashboard build.sqlite3 for backfilling missing before inputs",
    )
    parser.add_argument(
        "--live-abtests",
        type=Path,
        default=Path("/opt/eval_dashboard/static/abtests-aime.json"),
        help="Optional live abtests-aime.json to preserve exact scene mappings",
    )
    args = parser.parse_args()
    summary = migrate(
        src_root=args.src_root,
        dst_root=args.dst_root,
        datasets_root=args.datasets_root,
        build_db=args.build_db,
        live_abtests=args.live_abtests,
    )
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
