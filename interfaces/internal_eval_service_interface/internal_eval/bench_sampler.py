"""Benchmark question sampler & dispatch JSONL builder.

Reads frozen stratified tier files from:
    <bench_root>/<model>/tier_<tier>.jsonl

Assigns stable pairing keys (`eq_00001`..`eq_NNNNN`), writes the dashboard-
compatible `01_targets/questions.jsonl`, and writes structured dispatch JSONLs
under `98_service/dispatch/` (by default two files: `before_questions.jsonl` and
`after_questions.jsonl`, with configurable `by_turn` / `both` split support).
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any


def _extract_history_messages(row: dict[str, Any]) -> list[dict[str, Any]]:
    """Extract prior conversation turns before the final target user question."""
    messages = row.get("messages")
    if not isinstance(messages, list) or not messages:
        return []

    last_user_idx = -1
    for idx, msg in enumerate(messages):
        if not isinstance(msg, dict):
            continue
        if msg.get("role") == "user" or msg.get("type") == "user_question":
            last_user_idx = idx

    if last_user_idx <= 0:
        return []

    history: list[dict[str, Any]] = []
    for msg in messages[:last_user_idx]:
        if not isinstance(msg, dict):
            continue
        role = msg.get("role")
        mtype = msg.get("type")
        if role not in ("user", "assistant") and mtype not in ("user_question", "final_answer", "assistant_message"):
            continue
        content = msg.get("content")
        if content is None or (isinstance(content, str) and not content.strip()):
            continue
        resolved_role = role or ("user" if mtype == "user_question" else "assistant")
        history.append({"role": resolved_role, "content": content})
    return history


def _tier_file_path(bench_root: Path, model: str, tier: int) -> Path:
    exact = bench_root / model / f"tier_{tier}.jsonl"
    if exact.is_file():
        return exact
    # Allow sampling a smaller subset from the smallest available tier when custom tier is enabled
    for candidate in (500, 1000, 5000, 10000):
        path = bench_root / model / f"tier_{candidate}.jsonl"
        if path.is_file() and candidate >= tier:
            return path
    raise FileNotFoundError(f"未找到 bench 题集文件：{exact}")


def sample_bench_targets(
    bench_root: Path,
    model: str,
    tier: int,
    *,
    limit_override: int | None = None,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Load questions from the frozen bench tier file and assign stable case_keys."""
    src_path = _tier_file_path(bench_root, model, tier)
    target_limit = limit_override if limit_override is not None else tier
    targets: list[dict[str, Any]] = []
    single_count = 0
    multi_count = 0
    severity_counts: dict[str, int] = {}

    with src_path.open("r", encoding="utf-8", errors="replace") as fh:
        for raw_line in fh:
            line = raw_line.strip()
            if not line:
                continue
            row = json.loads(line)
            if not isinstance(row, dict):
                continue
            eq_index = len(targets) + 1
            case_key = f"eq_{eq_index:05d}"
            meta = row.get("meta") if isinstance(row.get("meta"), dict) else {}
            bench_info = row.get("bench") if isinstance(row.get("bench"), dict) else {}
            question = str(row.get("question") or meta.get("question") or meta.get("question_text") or "").strip()
            turn = str(row.get("turn") or ("multi" if int(row.get("session_round") or 1) > 1 else "single")).lower()
            if turn not in ("single", "multi"):
                turn = "single"
            if turn == "multi":
                multi_count += 1
            else:
                single_count += 1

            sev = str(row.get("severity") or "").strip().upper()
            if sev:
                severity_counts[sev] = severity_counts.get(sev, 0) + 1

            history_messages = _extract_history_messages(row) if turn == "multi" else []
            targets.append(
                {
                    "case_key": case_key,
                    "eq_index": eq_index,
                    "source_trace_id": str(row.get("trace_id") or meta.get("trace_id") or ""),
                    "source_session_id": str(row.get("session_id") or meta.get("session_id") or ""),
                    "user_id": str(meta.get("user_id") or row.get("user_id") or ""),
                    "model": str(row.get("model") or model),
                    "question": question,
                    "turn": turn,
                    "session_round": int(row.get("session_round") or 1),
                    "turn_index": int(row.get("turn_index") or 1),
                    "request_time": str(row.get("request_time") or meta.get("request_time") or ""),
                    "batch_id": str(row.get("batch_id") or ""),
                    "group": str(row.get("group") or ""),
                    "bench_rank": int(bench_info.get("rank", eq_index - 1)),
                    "bench_seed": str(bench_info.get("seed") or ""),
                    "bench_severity": sev,
                    "bench_primary": row.get("primary") if isinstance(row.get("primary"), dict) else {},
                    "history_messages": history_messages,
                }
            )
            if len(targets) >= target_limit:
                break

    if not targets:
        raise ValueError(f"bench 题集文件为空：{src_path}")

    meta_summary = {
        "source_file": str(src_path),
        "model": model,
        "requested_count": target_limit,
        "actual_count": len(targets),
        "shortfall": max(0, target_limit - len(targets)),
        "single_turn": single_count,
        "multi_turn": multi_count,
        "bench_severity_distribution": severity_counts,
    }
    return targets, meta_summary


def write_targets_and_dispatch_files(
    *,
    run_id: str,
    version: str,
    model: str,
    tier: int,
    sides: list[str],
    before_agent: dict[str, Any],
    after_agent: dict[str, Any],
    targets: list[dict[str, Any]],
    targets_jsonl_path: Path,
    dispatch_dir: Path,
    split_mode: str = "by_side",
) -> dict[str, str]:
    """Write `01_targets/questions.jsonl` and colleague dispatch JSONL files.

    Returns a dict of logical dispatch keys -> absolute file paths.
    Default (`by_side`) creates two JSONL files:
      - `before_questions.jsonl`
      - `after_questions.jsonl`
    When `split_mode` is `by_turn` or `both`, also creates:
      - `single_turn.jsonl`
      - `multi_turn.jsonl`
    """
    targets_jsonl_path.parent.mkdir(parents=True, exist_ok=True)
    dispatch_dir.mkdir(parents=True, exist_ok=True)

    # 1. Dashboard-compatible 01_targets/questions.jsonl
    with targets_jsonl_path.open("w", encoding="utf-8") as fh:
        for t in targets:
            row = {
                "trace_id": t["source_trace_id"],
                "session_id": t["source_session_id"],
                "user_id": t.get("user_id", ""),
                "case_key": t["case_key"],
                "eq_index": t["eq_index"],
                "question_time": t.get("request_time", ""),
                "mode": "fast" if "fast" in model else "expert",
                "model": model,
                "question": t["question"],
                "turn": t["turn"],
                "session_round": t["session_round"],
                "severity": t["bench_severity"],
                "tier": tier,
                "bench_rank": t["bench_rank"],
            }
            fh.write(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n")

    dispatch_files: dict[str, str] = {"targets": str(targets_jsonl_path)}
    mode = (split_mode or "by_side").strip().lower()

    # 2. Per-side JSONLs (two files: before_questions.jsonl & after_questions.jsonl)
    if mode in ("by_side", "both"):
        for side in sides:
            agent_cfg = before_agent if side == "before" else after_agent
            out_path = dispatch_dir / f"{side}_questions.jsonl"
            with out_path.open("w", encoding="utf-8") as fh:
                for t in targets:
                    payload = {
                        "run_id": run_id,
                        "version": version,
                        "side": side,
                        "agent": agent_cfg,
                        "model": model,
                        "case_key": t["case_key"],
                        "eq_index": t["eq_index"],
                        "case_id": f"{run_id}_{side}_{t['case_key']}",
                        "source_trace_id": t["source_trace_id"],
                        "source_session_id": t["source_session_id"],
                        "question": t["question"],
                        "turn": t["turn"],
                        "session_round": t["session_round"],
                        "history_messages": t["history_messages"],
                    }
                    fh.write(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n")
            dispatch_files[side] = str(out_path)

    # 3. Optional single/multi-turn split JSONLs
    if mode in ("by_turn", "both"):
        single_path = dispatch_dir / "single_turn.jsonl"
        multi_path = dispatch_dir / "multi_turn.jsonl"
        with single_path.open("w", encoding="utf-8") as sfh, multi_path.open("w", encoding="utf-8") as mfh:
            for t in targets:
                payload = {
                    "run_id": run_id,
                    "version": version,
                    "model": model,
                    "sides": sides,
                    "before_agent": before_agent,
                    "after_agent": after_agent,
                    "case_key": t["case_key"],
                    "eq_index": t["eq_index"],
                    "source_trace_id": t["source_trace_id"],
                    "source_session_id": t["source_session_id"],
                    "question": t["question"],
                    "turn": t["turn"],
                    "session_round": t["session_round"],
                    "history_messages": t["history_messages"],
                }
                line = json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n"
                if t["turn"] == "multi":
                    mfh.write(line)
                else:
                    sfh.write(line)
        dispatch_files["single_turn"] = str(single_path)
        dispatch_files["multi_turn"] = str(multi_path)

    return dispatch_files
