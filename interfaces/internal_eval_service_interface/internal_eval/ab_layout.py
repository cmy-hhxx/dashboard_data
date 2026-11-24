"""AB-test round directory layout manager.

Maintains full compatibility with the existing three-scope layout read by
5001 dashboard (`dashboard/ab_test.py`) and 5002 compare page:

    /mnt/aime_eval_ssd/1_aime/ab_test/<order>_version<ver>_test/
      round.json
      00_manifest/
        summary.json
        scope_summary.json
        coverage_before_release_cluster.csv
        coverage_after_release_retest.csv
      01_targets/
        questions.jsonl
      02_before_release/
        inputs/<model>/
        attribution/<model>/
        cluster_tree/<model>/
      03_after_release_retest/
        inputs/<model>/
        attribution/<model>/
        cluster_tree/<model>/
      04_after_release_online_real/
        attribution/
        cluster_tree/
      05_compare/
        baseline_leaf_counts.csv
        baseline_severity.csv
        baseline_trace_level.csv
        compare_snapshot.json
      98_service/
        dispatch/
        raw_traces/{before,after}/
        prepared/{before,after}/
        audit/{before,after}/
        taxonomy/
        logs/
"""

from __future__ import annotations

import csv
import json
import os
import re
import shutil
import threading
from collections import Counter
from pathlib import Path
from typing import Any

from .timeutil import today_iso, utc_rfc3339

ROUND_DIR_RE = re.compile(r"^(\d+)_version([0-9A-Za-z.]+?)(?:_test)?$")
SCOPE_DIR_BY_SIDE = {
    "before": "02_before_release",
    "after": "03_after_release_retest",
}
_ALLOC_LOCK = threading.Lock()


def sanitize_version_token(version: str) -> str:
    """Keep version token compatible with dashboard ROUND_RE (`[0-9A-Za-z.]+`)."""
    raw = (version or "").strip()
    if raw.lower().startswith("v") and len(raw) > 1 and raw[1].isdigit():
        raw = raw[1:]
    cleaned = re.sub(r"[^0-9A-Za-z.]+", ".", raw).strip(".")
    return cleaned or today_iso().replace("-", "")[-4:]


def allocate_round_dir(ab_test_root: Path, version: str) -> tuple[int, str, Path]:
    """Allocate a fresh `<order>_version<token>[.rN]_test` folder without overwriting."""
    ab_test_root.mkdir(parents=True, exist_ok=True)
    token = sanitize_version_token(version)

    with _ALLOC_LOCK:
        max_order = -1
        existing_names: set[str] = set()
        for child in ab_test_root.iterdir():
            if not child.is_dir() or child.name.startswith("."):
                continue
            existing_names.add(child.name)
            m = ROUND_DIR_RE.match(child.name)
            if m:
                max_order = max(max_order, int(m.group(1)))

        order = max_order + 1
        # Check whether the exact version token already has a round folder
        same_token_count = sum(
            1
            for name in existing_names
            if (m := ROUND_DIR_RE.match(name)) and (m.group(2) == token or m.group(2).startswith(f"{token}r"))
        )
        suffix = "" if same_token_count == 0 else f"r{same_token_count + 1}"
        dir_name = f"{order}_version{token}{suffix}_test"
        while dir_name in existing_names or (ab_test_root / dir_name).exists():
            order += 1
            dir_name = f"{order}_version{token}{suffix}_test"

        round_dir = ab_test_root / dir_name
        round_dir.mkdir(parents=True, exist_ok=True)
        return order, dir_name, round_dir


def init_round_layout(
    *,
    round_dir: Path,
    version: str,
    model: str,
    tier: int,
    before_agent_label: str,
    after_agent_label: str,
    run_id: str,
    base_taxonomy_dir: Path,
) -> dict[str, Path]:
    """Create the complete directory skeleton and copy isolated round taxonomy."""
    paths = {
        "manifest": round_dir / "00_manifest",
        "targets": round_dir / "01_targets",
        "before_inputs": round_dir / "02_before_release" / "inputs" / model,
        "before_attribution": round_dir / "02_before_release" / "attribution" / model,
        "before_cluster": round_dir / "02_before_release" / "cluster_tree" / model,
        "after_inputs": round_dir / "03_after_release_retest" / "inputs" / model,
        "after_attribution": round_dir / "03_after_release_retest" / "attribution" / model,
        "after_cluster": round_dir / "03_after_release_retest" / "cluster_tree" / model,
        "online_attribution": round_dir / "04_after_release_online_real" / "attribution",
        "online_cluster": round_dir / "04_after_release_online_real" / "cluster_tree",
        "compare": round_dir / "05_compare",
        "service": round_dir / "98_service",
        "dispatch": round_dir / "98_service" / "dispatch",
        "raw_before": round_dir / "98_service" / "raw_traces" / "before",
        "raw_after": round_dir / "98_service" / "raw_traces" / "after",
        "prepared_before": round_dir / "98_service" / "prepared" / "before",
        "prepared_after": round_dir / "98_service" / "prepared" / "after",
        "audit_before": round_dir / "98_service" / "audit" / "before",
        "audit_after": round_dir / "98_service" / "audit" / "after",
        "taxonomy": round_dir / "98_service" / "taxonomy",
        "logs": round_dir / "98_service" / "logs",
    }
    for p in paths.values():
        p.mkdir(parents=True, exist_ok=True)

    # Copy read-only baseline taxonomy into this round so both sides share one isolated taxonomy
    if base_taxonomy_dir.is_dir() and not any(paths["taxonomy"].iterdir()):
        for item in base_taxonomy_dir.iterdir():
            if item.is_file():
                shutil.copy2(item, paths["taxonomy"] / item.name)

    round_meta = {
        "released_at": today_iso(),
        "label": f"{version} 内部评测",
        "title": f"AIME v{version} 内部评测（{before_agent_label} vs {after_agent_label} · {tier} 题）",
        "run_id": run_id,
        "model": model,
        "tier": tier,
        "before_agent": before_agent_label,
        "after_agent": after_agent_label,
    }
    _atomic_write_json(round_dir / "round.json", round_meta)
    return paths


def sync_cluster_slice_alias(cluster_dir: Path) -> None:
    """Ensure `item_index.slice.jsonl` mirrors `item_index.jsonl` for 5001/5002 dashboard compatibility."""
    src = cluster_dir / "item_index.jsonl"
    dst = cluster_dir / "item_index.slice.jsonl"
    if not src.is_file():
        return
    tmp = cluster_dir / ".item_index.slice.jsonl.tmp"
    shutil.copy2(src, tmp)
    os.replace(tmp, dst)


def sync_round_manifests(
    *,
    round_dir: Path,
    run: dict[str, Any],
    targets: list[dict[str, Any]],
    before_cases: dict[str, dict[str, Any]],
    after_cases: dict[str, dict[str, Any]],
    compare_payload: dict[str, Any],
) -> None:
    """Atomically refresh `00_manifest/*` and `05_compare/*` from current SQLite state."""
    manifest_dir = round_dir / "00_manifest"
    compare_dir = round_dir / "05_compare"
    manifest_dir.mkdir(parents=True, exist_ok=True)
    compare_dir.mkdir(parents=True, exist_ok=True)

    model = run["model"]
    mode_short = "fast" if "fast" in model else "expert"

    # 1. coverage_before_release_cluster.csv (read by dashboard/ab_test.py)
    before_rows = []
    status_counter: Counter[str] = Counter()
    b_reason_counter: Counter[str] = Counter()
    for t in targets:
        ck = t["case_key"]
        c = before_cases.get(ck)
        if c and c["status"] == "ready":
            if c["is_gold"]:
                st_label = "已评测_无落点"
                b_reason = "B1_评测无问题"
                status_counter["B_已评测_无落点"] += 1
                b_reason_counter["B1_评测无问题"] += 1
            elif c["cluster_paths"]:
                st_label = "已评测_有落点"
                b_reason = ""
                status_counter["A_已评测_有落点"] += 1
            else:
                st_label = "已评测_无落点"
                b_reason = "B2_有问题未进树"
                status_counter["B_已评测_无落点"] += 1
                b_reason_counter["B2_有问题未进树"] += 1
            before_rows.append(
                {
                    "trace_id": c.get("trace_id") or t.get("source_trace_id", ""),
                    "session_id": c.get("session_id") or t.get("source_session_id", ""),
                    "user_id": "",
                    "question_time": c.get("request_time") or "",
                    "mode": mode_short,
                    "question": t.get("question", ""),
                    "qtype": "string",
                    "status": st_label,
                    "b_reason": b_reason,
                    "eval_category": "internal_eval",
                    "eval_store": "internal_eval_before",
                    "eval_file": c.get("attribution_file") or "",
                    "eval_line": "",
                    "eval_n_problem": c["problem_count"],
                    "eval_is_correct": "" if c["is_correct"] is None else str(c["is_correct"]),
                    "cls_n_items": len(c["cluster_paths"]),
                    "cls_paths": ";".join(c["cluster_paths"]),
                    "cls_labels": ";".join(c["cluster_labels"]),
                    "severity": c["max_severity"] or ("GOLD" if c["is_gold"] else ""),
                    "turn": t.get("turn", "single"),
                    "session_round": t.get("session_round", 1),
                    "tier": run["tier"],
                    "bench_rank": t.get("bench_rank", 0),
                    "case_key": ck,
                    "eq_index": t["eq_index"],
                }
            )
        else:
            status_counter["C_无评测记录"] += 1
            before_rows.append(
                {
                    "trace_id": (c.get("trace_id") if c else "") or t.get("source_trace_id", ""),
                    "session_id": (c.get("session_id") if c else "") or t.get("source_session_id", ""),
                    "user_id": "",
                    "question_time": "",
                    "mode": mode_short,
                    "question": t.get("question", ""),
                    "qtype": "string",
                    "status": "无评测记录",
                    "b_reason": "",
                    "eval_category": "internal_eval",
                    "eval_store": "internal_eval_before",
                    "eval_file": "",
                    "eval_line": "",
                    "eval_n_problem": 0,
                    "eval_is_correct": "",
                    "cls_n_items": 0,
                    "cls_paths": "",
                    "cls_labels": "",
                    "severity": "",
                    "turn": t.get("turn", "single"),
                    "session_round": t.get("session_round", 1),
                    "tier": run["tier"],
                    "bench_rank": t.get("bench_rank", 0),
                    "case_key": ck,
                    "eq_index": t["eq_index"],
                }
            )

    if before_rows:
        _atomic_write_csv(
            manifest_dir / "coverage_before_release_cluster.csv",
            list(before_rows[0].keys()),
            before_rows,
        )

    # 2. coverage_after_release_retest.csv (read by dashboard/ab_test.py & ab_detail.py)
    after_rows = []
    for t in targets:
        ck = t["case_key"]
        c = after_cases.get(ck)
        if c and c["status"] == "ready":
            retest_state = "已重测_有归因"
            n_prob = c["problem_count"]
            cls_paths = ";".join(c["cluster_paths"])
            cls_labels = ";".join(c["cluster_labels"])
            cls_n = len(c["cluster_paths"])
        elif c and c["status"] in ("failed", "rejected"):
            retest_state = f"重测失败_{c.get('failed_stage') or 'unknown'}"
            n_prob = 0
            cls_paths = ""
            cls_labels = ""
            cls_n = 0
        else:
            retest_state = "待重测"
            n_prob = 0
            cls_paths = ""
            cls_labels = ""
            cls_n = 0
        after_rows.append(
            {
                "trace_id": t["source_trace_id"],
                "retest_trace_id": (c.get("trace_id") if c else "") or "",
                "eq_index": t["eq_index"],
                "case_key": ck,
                "retest_state": retest_state,
                "n_problem": n_prob,
                "retest_session_id": (c.get("session_id") if c else "") or "",
                "cls_n_items": cls_n,
                "cls_paths": cls_paths,
                "cls_labels": cls_labels,
                "severity": (c.get("max_severity") if c else "") or "",
            }
        )

    if after_rows:
        _atomic_write_csv(
            manifest_dir / "coverage_after_release_retest.csv",
            list(after_rows[0].keys()),
            after_rows,
        )

    # 3. 00_manifest/summary.json & scope_summary.json
    now = utc_rfc3339()
    summary_payload = {
        "generated_at": now,
        "run_id": run["run_id"],
        "version": run["version"],
        "model": model,
        "tier": run["tier"],
        "target_traces": len(targets),
        "status": dict(status_counter),
        "b_reason": dict(b_reason_counter),
        "eval_category": {"internal_eval": len(targets)},
        "before_agent": run["before_agent_label"],
        "after_agent": run["after_agent_label"],
        "run_status": run["status"],
    }
    _atomic_write_json(manifest_dir / "summary.json", summary_payload)
    _atomic_write_json(
        manifest_dir / "scope_summary.json",
        {
            "generated_at": now,
            "run_id": run["run_id"],
            "before": compare_payload.get("before_summary", {}),
            "after": compare_payload.get("after_summary", {}),
            "paired": compare_payload.get("paired_summary", {}),
        },
    )

    # 4. 05_compare/*
    _atomic_write_json(compare_dir / "compare_snapshot.json", compare_payload)
    leaf_rows = compare_payload.get("leaf_comparison", [])
    _atomic_write_csv(
        compare_dir / "baseline_leaf_counts.csv",
        ["path", "name", "before_traces", "after_traces", "delta_traces", "before_problems", "after_problems"],
        [
            {
                "path": item["path"],
                "name": item["name"],
                "before_traces": item["before_traces"],
                "after_traces": item["after_traces"],
                "delta_traces": item["delta_traces"],
                "before_problems": item["before_problems"],
                "after_problems": item["after_problems"],
            }
            for item in leaf_rows
        ],
    )
    sev_rows = []
    for sev, vals in (compare_payload.get("severity_comparison") or {}).items():
        sev_rows.append(
            {
                "severity": sev,
                "before_count": vals.get("before", 0),
                "after_count": vals.get("after", 0),
                "delta": vals.get("delta", 0),
                "before_rate": vals.get("before_rate", 0.0),
                "after_rate": vals.get("after_rate", 0.0),
            }
        )
    _atomic_write_csv(
        compare_dir / "baseline_severity.csv",
        ["severity", "before_count", "after_count", "delta", "before_rate", "after_rate"],
        sev_rows,
    )
    trace_rows = []
    for t in targets:
        ck = t["case_key"]
        bc = before_cases.get(ck)
        ac = after_cases.get(ck)
        trace_rows.append(
            {
                "case_key": ck,
                "eq_index": t["eq_index"],
                "source_trace_id": t["source_trace_id"],
                "before_status": bc["status"] if bc else "missing",
                "before_severity": (bc["max_severity"] or "") if bc else "",
                "before_problems": bc["problem_count"] if bc else 0,
                "before_paths": ";".join(bc["cluster_paths"]) if bc else "",
                "after_status": ac["status"] if ac else "missing",
                "after_severity": (ac["max_severity"] or "") if ac else "",
                "after_problems": ac["problem_count"] if ac else 0,
                "after_paths": ";".join(ac["cluster_paths"]) if ac else "",
            }
        )
    _atomic_write_csv(
        compare_dir / "baseline_trace_level.csv",
        [
            "case_key",
            "eq_index",
            "source_trace_id",
            "before_status",
            "before_severity",
            "before_problems",
            "before_paths",
            "after_status",
            "after_severity",
            "after_problems",
            "after_paths",
        ],
        trace_rows,
    )


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
