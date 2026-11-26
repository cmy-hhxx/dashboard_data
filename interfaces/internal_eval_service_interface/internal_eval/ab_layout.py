"""AB-test round directory layout manager (canonical layout).

Canonical round structure under `/mnt/aime_eval_ssd/1_aime/ab_test/`:

    version_<YYYYMMDD>_<model>[_rN]/
      bench/
        bench.jsonl
      agent_before_opt/
        res_before_opt.jsonl
        eval_output/
          attribution.jsonl
          attribution_human_read.jsonl   (optional)
          compact.jsonl
        cluster/                         (cluster_tree.json, item_index.jsonl, leaves.tsv, ...)
      agent_after_opt/
        res_after_opt.jsonl
        eval_output/
          attribution.jsonl
          attribution_human_read.jsonl   (optional)
          compact.jsonl
        cluster/
      index_stats/
        meta.json
        pairs_index.csv
        stats.json
      .work/                             (dispatch/, raw_traces/, prepared/, audit/, taxonomy/, logs/)
"""

from __future__ import annotations

import csv
import json
import os
import re
import shutil
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .timeutil import today_iso, utc_rfc3339

ROUND_DIR_RE = re.compile(r"^version_(\d{8})_(aime_(?:expert|fast))$")
SIDE_DIR = {
    "before": "agent_before_opt",
    "after": "agent_after_opt",
}
INPUT_FILENAME = {
    "before": "res_before_opt.jsonl",
    "after": "res_after_opt.jsonl",
}
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
_ALLOC_LOCK = threading.Lock()


def sanitize_version_token(version: str) -> str:
    """Keep a clean version token; prefer 8-digit YYYYMMDD when possible."""
    raw = (version or "").strip()
    if raw.lower().startswith("v") and len(raw) > 1 and raw[1].isdigit():
        raw = raw[1:]
    digits = re.sub(r"\D", "", raw)
    if len(digits) == 8:
        return digits
    if len(digits) == 4:
        return f"{today_iso()[:4]}{digits}"
    cleaned = re.sub(r"[^0-9A-Za-z.]+", ".", raw).strip(".")
    return cleaned or today_iso().replace("-", "")


def _normalize_date_token(version: str) -> str:
    """Strictly parse `version` as `YYYYMMDD` or `MMDD` date token."""
    raw = (version or "").strip()
    if raw.lower().startswith("v") and len(raw) > 1 and raw[1].isdigit():
        raw = raw[1:]
    if re.fullmatch(r"\d{8}", raw):
        datetime.strptime(raw, "%Y%m%d")
        return raw
    if re.fullmatch(r"\d{4}", raw):
        full = f"{today_iso()[:4]}{raw}"
        datetime.strptime(full, "%Y%m%d")
        return full
    raise ValueError("version 必须为 YYYYMMDD 或 MMDD 日期格式（例如 20261126 或 1126）")


def resolve_round_dir_name(version: str, model: str = "aime_expert") -> str:
    """Validate `(version, model)` and return canonical `version_<YYYYMMDD>_<model>` dir name."""
    date_tok = _normalize_date_token(version)
    clean_model = (model or "aime_expert").strip().lower()
    if clean_model not in ("aime_expert", "aime_fast"):
        raise ValueError(f"model 必须为 aime_expert 或 aime_fast，收到：{model!r}")
    return f"version_{date_tok}_{clean_model}"


def allocate_round_dir(ab_test_root: Path, version: str, model: str = "aime_expert") -> tuple[int, str, Path]:
    """Allocate strict `version_<YYYYMMDD>_aime_<expert|fast>` dir; reject same-day duplicates."""
    ab_test_root.mkdir(parents=True, exist_ok=True)
    dir_name = resolve_round_dir_name(version, model)

    with _ALLOC_LOCK:
        existing_names = {
            child.name
            for child in ab_test_root.iterdir()
            if child.is_dir() and not child.name.startswith(".")
        }
        round_names = [name for name in existing_names if ROUND_DIR_RE.match(name)]
        order = len(round_names)
        round_dir = ab_test_root / dir_name
        if round_dir.exists():
            raise FileExistsError(f"轮次目录已存在：{dir_name}，请先归档或更换日期版本")
        round_dir.mkdir(parents=True, exist_ok=False)
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
    """Create the canonical directory skeleton and copy isolated round taxonomy into `.work/taxonomy`."""
    work_dir = round_dir / ".work"
    paths = {
        "bench": round_dir / "bench",
        "before_root": round_dir / SIDE_DIR["before"],
        "before_eval": round_dir / SIDE_DIR["before"] / "eval_output",
        "before_cluster": round_dir / SIDE_DIR["before"] / "cluster",
        "after_root": round_dir / SIDE_DIR["after"],
        "after_eval": round_dir / SIDE_DIR["after"] / "eval_output",
        "after_cluster": round_dir / SIDE_DIR["after"] / "cluster",
        "index_stats": round_dir / "index_stats",
        "work": work_dir,
        "dispatch": work_dir / "dispatch",
        "raw_before": work_dir / "raw_traces" / "before",
        "raw_after": work_dir / "raw_traces" / "after",
        "prepared_before": work_dir / "prepared" / "before",
        "prepared_after": work_dir / "prepared" / "after",
        "audit_before": work_dir / "audit" / "before",
        "audit_after": work_dir / "audit" / "after",
        "taxonomy": work_dir / "taxonomy",
        "logs": work_dir / "logs",
    }
    for p in paths.values():
        p.mkdir(parents=True, exist_ok=True)

    if base_taxonomy_dir.is_dir() and not any(paths["taxonomy"].iterdir()):
        for item in base_taxonomy_dir.iterdir():
            if item.is_file():
                shutil.copy2(item, paths["taxonomy"] / item.name)

    try:
        date_tok = _normalize_date_token(version)
    except ValueError:
        date_tok = ""
    released_at = f"{date_tok[:4]}-{date_tok[4:6]}-{date_tok[6:8]}" if len(date_tok) == 8 else today_iso()
    meta_path = paths["index_stats"] / "meta.json"
    if not meta_path.is_file():
        meta_payload = {
            "version": version,
            "model": model,
            "released_at": released_at,
            "label": f"{version} 内部评测",
            "title": f"AIME v{version} 内部评测（{before_agent_label} vs {after_agent_label} · {tier} 题）",
            "before_label": before_agent_label,
            "after_label": after_agent_label,
            "tier": tier,
            "run_id": run_id,
            "generated_at": utc_rfc3339(),
        }
        _atomic_write_json(meta_path, meta_payload)
    return paths


def sync_round_manifests(
    *,
    round_dir: Path,
    run: dict[str, Any],
    targets: list[dict[str, Any]],
    before_cases: dict[str, dict[str, Any]],
    after_cases: dict[str, dict[str, Any]],
    compare_payload: dict[str, Any],
) -> None:
    """Atomically refresh `index_stats/{meta.json, pairs_index.csv, stats.json}` from SQLite state."""
    idx_dir = round_dir / "index_stats"
    idx_dir.mkdir(parents=True, exist_ok=True)
    now = utc_rfc3339()

    meta_path = idx_dir / "meta.json"
    meta_doc: dict[str, Any] = {}
    if meta_path.is_file():
        try:
            meta_doc = json.loads(meta_path.read_text(encoding="utf-8"))
        except ValueError:
            meta_doc = {}
    try:
        date_tok = _normalize_date_token(str(run.get("version") or ""))
    except ValueError:
        date_tok = ""
    default_rel = f"{date_tok[:4]}-{date_tok[4:6]}-{date_tok[6:8]}" if len(date_tok) == 8 else today_iso()
    meta_doc.setdefault("version", run["version"])
    meta_doc.setdefault("model", run["model"])
    meta_doc.setdefault("released_at", default_rel)
    meta_doc.setdefault("label", f"{run['version']} 内部评测")
    meta_doc.setdefault(
        "title",
        f"AIME v{run['version']} 内部评测（{run['before_agent_label']} vs {run['after_agent_label']} · {run['tier']} 题）",
    )
    meta_doc["before_label"] = run["before_agent_label"]
    meta_doc["after_label"] = run["after_agent_label"]
    meta_doc["tier"] = len(targets) or run["tier"]
    meta_doc["run_id"] = run["run_id"]
    meta_doc["run_status"] = run["status"]
    meta_doc["generated_at"] = now
    tm_state_path = round_dir / ".work" / "dispatch" / "TASK_MANAGER_STATE.json"
    if tm_state_path.is_file():
        try:
            tm_state = json.loads(tm_state_path.read_text(encoding="utf-8"))
        except ValueError:
            tm_state = None
        if isinstance(tm_state, dict) and tm_state.get("task_id"):
            meta_doc["task_manager"] = {
                "task_id": tm_state.get("task_id"),
                "task_name": tm_state.get("task_name"),
                "testset_id": tm_state.get("testset_id"),
                "task_drop_dir": tm_state.get("task_drop_dir"),
                "side_to_step_key": tm_state.get("side_to_step_key"),
            }
    _atomic_write_json(meta_path, meta_doc)

    pair_rows: list[dict[str, Any]] = []
    for t in targets:
        ck = t["case_key"]
        bc = before_cases.get(ck)
        ac = after_cases.get(ck)

        if bc and bc["status"] == "ready":
            b_status = "evaluated"
            b_reason = "B1" if bc["is_gold"] else ("" if bc["cluster_paths"] else "B2")
            b_tid = bc.get("trace_id") or ""
            b_n = bc["problem_count"]
            b_sev = bc["max_severity"] or ("GOLD" if bc["is_gold"] else "")
            b_paths = ";".join(bc["cluster_paths"])
            b_labels = ";".join(bc["cluster_labels"])
        else:
            b_status = "missing"
            b_reason = ""
            b_tid = (bc.get("trace_id") if bc else "") or ""
            b_n = 0
            b_sev = ""
            b_paths = ""
            b_labels = ""

        if ac and ac["status"] == "ready":
            a_status = "evaluated"
        elif ac and ac["status"] in ("failed", "rejected"):
            a_status = "failed"
        elif ac:
            a_status = "pending"
        else:
            a_status = "missing"

        pair_rows.append(
            {
                "eq_index": t["eq_index"],
                "case_key": ck,
                "trace_id": t.get("source_trace_id") or ck,
                "session_id": t.get("source_session_id") or "",
                "question_time": (bc.get("request_time") if bc else "") or t.get("request_time") or "",
                "question": t.get("question") or "",
                "task": t.get("task") or "",
                "subtask": t.get("subtask") or "",
                "before_status": b_status,
                "before_b_reason": b_reason,
                "before_trace_id": b_tid,
                "before_n_problem": b_n,
                "before_severity": b_sev,
                "before_cls_paths": b_paths,
                "before_cls_labels": b_labels,
                "after_status": a_status,
                "after_trace_id": (ac.get("trace_id") if ac else "") or "",
                "after_session_id": (ac.get("session_id") if ac else "") or "",
                "after_n_problem": (ac["problem_count"] if ac and ac["status"] == "ready" else 0),
                "after_severity": (ac.get("max_severity") if ac else "") or "",
                "after_cls_paths": ";".join(ac["cluster_paths"]) if ac and ac["status"] == "ready" else "",
                "after_cls_labels": ";".join(ac["cluster_labels"]) if ac and ac["status"] == "ready" else "",
            }
        )

    _atomic_write_csv(idx_dir / "pairs_index.csv", PAIRS_COLUMNS, pair_rows)

    stats_payload = {
        "generated_at": now,
        "run_id": run["run_id"],
        "version": run["version"],
        "model": run["model"],
        "total_targets": len(targets),
        "run_status": run["status"],
        "before": compare_payload.get("before_summary", {}),
        "after": compare_payload.get("after_summary", {}),
        "paired": compare_payload.get("paired_summary", {}),
        "leaf_comparison": compare_payload.get("leaf_comparison", []),
        "severity_comparison": compare_payload.get("severity_comparison", {}),
    }
    _atomic_write_json(idx_dir / "stats.json", stats_payload)


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
