"""Benchmark question sampler & dispatch JSONL builder.

Reads frozen stratified tier files from:
    <bench_root>/<model>/tier_<tier>.jsonl

Assigns stable pairing keys (`eq_00001`..`eq_NNNNN`), writes `bench/bench.jsonl`,
and writes structured dispatch JSONLs under `.work/dispatch/`.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

_LEADING_STAMP_RE = re.compile(
    r"^(?:\[client_id=[^\]]+\][ \t]+)?\[\d{4}-\d{2}-\d{2}T[^\]]{1,40}\][ \t]*"
)


def _clean_pool_content(content: Any) -> Any:
    if isinstance(content, str):
        return _LEADING_STAMP_RE.sub("", content).strip()
    return content


def _extract_history_messages(row: dict[str, Any]) -> list[dict[str, Any]]:
    """Extract prior conversation turns before the final target user question."""
    messages = row.get("messages")
    if isinstance(messages, list) and messages:
        last_user_idx = -1
        for idx, msg in enumerate(messages):
            if not isinstance(msg, dict):
                continue
            if msg.get("role") == "user" or msg.get("type") == "user_question":
                last_user_idx = idx

        if last_user_idx > 0:
            history: list[dict[str, Any]] = []
            for msg in messages[:last_user_idx]:
                if not isinstance(msg, dict):
                    continue
                role = msg.get("role")
                mtype = msg.get("type")
                if role not in ("user", "assistant") and mtype not in (
                    "user_question",
                    "final_answer",
                    "assistant_message",
                ):
                    continue
                content = msg.get("content")
                if content is None or (isinstance(content, str) and not content.strip()):
                    continue
                resolved_role = role or ("user" if mtype == "user_question" else "assistant")
                history.append({"role": resolved_role, "content": content})
            if history:
                return history

    # Fallback for slimmed `3_dynamic_bench` multi-turn rows where prior turns live in `message_pool`
    pool = row.get("message_pool")
    if not isinstance(pool, list) or not pool:
        return []
    target_q = str(row.get("question") or "").strip()
    pool_turns: list[dict[str, Any]] = []
    for msg in pool:
        if not isinstance(msg, dict):
            continue
        role = msg.get("role")
        if role not in ("user", "assistant"):
            continue
        content = _clean_pool_content(msg.get("content"))
        if content is None or (isinstance(content, str) and not content.strip()):
            continue
        if pool_turns and pool_turns[-1]["role"] == role and pool_turns[-1]["content"] == content:
            continue
        pool_turns.append({"role": role, "content": content})

    if not pool_turns:
        return []
    # Find the target question occurrence (or last user turn) and keep turns strictly before it
    cut_idx = -1
    if target_q:
        for idx in range(len(pool_turns) - 1, -1, -1):
            if pool_turns[idx]["role"] == "user" and str(pool_turns[idx]["content"]).strip() == target_q:
                cut_idx = idx
                break
    if cut_idx < 0:
        for idx in range(len(pool_turns) - 1, -1, -1):
            if pool_turns[idx]["role"] == "user":
                cut_idx = idx
                break
    return pool_turns[:cut_idx] if cut_idx > 0 else []


ORIGIN_BENCH = "bench"
ORIGIN_EXTRA = "算法提供"
ORIGIN_BOTH = "bench+算法提供"


def normalize_extra_traces(raw: Any) -> list[dict[str, str]]:
    """Normalize `extra_traces` payload into ordered unique items (`trace_id` or `question`).

    Ignores colleague-specific tags; provenance is tracked strictly as bench vs 算法提供 (or overlap).
    """
    if raw is None:
        return []
    if not isinstance(raw, list):
        raise ValueError("extra_traces 必须是数组（支持 trace_id 字符串、{trace_id} 或 {question} 对象）")
    items: list[dict[str, str]] = []
    seen_tids: set[str] = set()
    for idx, entry in enumerate(raw):
        if isinstance(entry, str):
            tid = entry.strip()
            if not tid:
                continue
            if tid in seen_tids:
                continue
            seen_tids.add(tid)
            items.append({"trace_id": tid})
        elif isinstance(entry, dict):
            tid = str(entry.get("trace_id") or entry.get("id") or "").strip()
            q = str(entry.get("question") or entry.get("query") or "").strip()
            if tid:
                if tid in seen_tids:
                    continue
                seen_tids.add(tid)
                item: dict[str, str] = {"trace_id": tid}
                if q:
                    item["question"] = q
                items.append(item)
            elif q:
                items.append({"question": q})
            else:
                raise ValueError(f"extra_traces[{idx}] 缺少 trace_id 或 question")
        else:
            raise ValueError(f"extra_traces[{idx}] 必须是字符串或对象")
    return items


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


def _row_to_target(
    row: dict[str, Any],
    *,
    eq_index: int,
    model: str,
    source_origin: str,
) -> dict[str, Any]:
    case_key = f"eq_{eq_index:05d}"
    meta = row.get("meta") if isinstance(row.get("meta"), dict) else {}
    bench_info = row.get("bench") if isinstance(row.get("bench"), dict) else {}
    question = str(row.get("question") or meta.get("question") or meta.get("question_text") or "").strip()
    turn = str(row.get("turn") or ("multi" if int(row.get("session_round") or 1) > 1 else "single")).lower()
    if turn not in ("single", "multi"):
        turn = "single"
    sev = str(row.get("severity") or "").strip().upper()
    history_messages = _extract_history_messages(row) if turn == "multi" else []
    source_model = str(row.get("model") or model)
    return {
        "case_key": case_key,
        "eq_index": eq_index,
        "source_input_id": row.get("source_input_id"),
        "source_trace_id": str(row.get("trace_id") or meta.get("trace_id") or ""),
        "source_session_id": str(row.get("session_id") or meta.get("session_id") or ""),
        "source_model": source_model,
        "source_origin": source_origin,
        "user_id": str(meta.get("user_id") or row.get("user_id") or ""),
        "model": model,
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
        "task": str(meta.get("task_category") or row.get("task_category") or "").strip(),
        "subtask": str(meta.get("subtask_category") or row.get("subtask_category") or "").strip(),
        "history_messages": history_messages,
    }


def _find_rows_in_bench_files(bench_root: Path, model: str, wanted_tids: set[str]) -> dict[str, dict[str, Any]]:
    found: dict[str, dict[str, Any]] = {}
    if not wanted_tids:
        return found
    model_order = [model] + [m for m in ("aime_expert", "aime_fast") if m != model]
    for cand_model in model_order:
        mdir = bench_root / cand_model
        if not mdir.is_dir():
            continue
        for tier_size in (10000, 5000, 1000, 500):
            p = mdir / f"tier_{tier_size}.jsonl"
            if not p.is_file():
                continue
            with p.open("r", encoding="utf-8", errors="replace") as fh:
                for raw_line in fh:
                    line = raw_line.strip()
                    if not line:
                        continue
                    try:
                        row = json.loads(line)
                    except ValueError:
                        continue
                    if not isinstance(row, dict):
                        continue
                    meta = row.get("meta") if isinstance(row.get("meta"), dict) else {}
                    tid = str(row.get("trace_id") or meta.get("trace_id") or "").strip()
                    if tid and tid in wanted_tids and tid not in found:
                        row_copy = dict(row)
                        row_copy.setdefault("model", cand_model)
                        found[tid] = row_copy
                        if len(found) == len(wanted_tids):
                            return found
    return found


def sample_bench_targets(
    bench_root: Path,
    model: str,
    tier: int,
    *,
    limit_override: int | None = None,
    extra_traces: list[dict[str, str]] | None = None,
    dedupe: bool = True,
    ignore_missing: bool = False,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Load questions from the frozen bench tier file, optionally merge `extra_traces`, and assign stable case_keys."""
    target_limit = limit_override if limit_override is not None else tier
    norm_extra = normalize_extra_traces(extra_traces) if extra_traces else []
    targets: list[dict[str, Any]] = []
    by_trace_id: dict[str, dict[str, Any]] = {}
    src_path: Path | None = None

    if target_limit > 0:
        src_path = _tier_file_path(bench_root, model, max(1, tier))
        with src_path.open("r", encoding="utf-8", errors="replace") as fh:
            for raw_line in fh:
                line = raw_line.strip()
                if not line:
                    continue
                row = json.loads(line)
                if not isinstance(row, dict):
                    continue
                t = _row_to_target(row, eq_index=len(targets) + 1, model=model, source_origin=ORIGIN_BENCH)
                targets.append(t)
                if t["source_trace_id"]:
                    by_trace_id.setdefault(t["source_trace_id"], t)
                if len(targets) >= target_limit:
                    break

    bench_count = len(targets)
    overlap_count = 0
    extra_added = 0
    missing_tids: list[str] = []

    if norm_extra:
        lookup_tids = {
            item["trace_id"]
            for item in norm_extra
            if item.get("trace_id") and not (dedupe and item["trace_id"] in by_trace_id)
        }
        resolved_map = _find_rows_in_bench_files(bench_root, model, lookup_tids)
        for item in norm_extra:
            tid = item.get("trace_id") or ""
            if tid:
                if dedupe and tid in by_trace_id:
                    by_trace_id[tid]["source_origin"] = ORIGIN_BOTH
                    overlap_count += 1
                    continue
                row = resolved_map.get(tid)
                if row is None:
                    if item.get("question"):
                        row = {"trace_id": tid, "question": item["question"], "model": model, "turn": "single"}
                    else:
                        missing_tids.append(tid)
                        continue
                t = _row_to_target(row, eq_index=len(targets) + 1, model=model, source_origin=ORIGIN_EXTRA)
                targets.append(t)
                by_trace_id.setdefault(tid, t)
                extra_added += 1
            else:
                row = {"trace_id": "", "question": item["question"], "model": model, "turn": "single"}
                t = _row_to_target(row, eq_index=len(targets) + 1, model=model, source_origin=ORIGIN_EXTRA)
                targets.append(t)
                extra_added += 1

    if missing_tids and not ignore_missing:
        raise ValueError(f"以下 {len(missing_tids)} 条 extra_traces 未找到：{missing_tids[:20]}")

    if not targets:
        raise ValueError(f"抽题结果为空（bench={src_path}, extra_traces={len(norm_extra)}）")

    single_count = sum(1 for t in targets if t["turn"] != "multi")
    multi_count = len(targets) - single_count
    severity_counts: dict[str, int] = {}
    origin_counts: dict[str, int] = {}
    for t in targets:
        sev = t.get("bench_severity") or ""
        if sev:
            severity_counts[sev] = severity_counts.get(sev, 0) + 1
        orig = t.get("source_origin") or ORIGIN_BENCH
        origin_counts[orig] = origin_counts.get(orig, 0) + 1

    meta_summary = {
        "source_file": str(src_path) if src_path else "extra_traces_only",
        "model": model,
        "requested_count": target_limit,
        "bench_count": bench_count,
        "extra_requested_count": len(norm_extra),
        "extra_added_count": extra_added,
        "overlap_count": overlap_count,
        "missing_extra_trace_ids": missing_tids,
        "actual_count": len(targets),
        "shortfall": max(0, target_limit - bench_count),
        "single_turn": single_count,
        "multi_turn": multi_count,
        "origin_counts": origin_counts,
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
    """Write `bench/bench.jsonl` and colleague dispatch JSONL files."""
    targets_jsonl_path.parent.mkdir(parents=True, exist_ok=True)
    dispatch_dir.mkdir(parents=True, exist_ok=True)

    # 1. Canonical bench/bench.jsonl
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
                "source_model": t.get("source_model") or model,
                "source_origin": t.get("source_origin") or ORIGIN_BENCH,
                "eval_category": t.get("source_origin") or ORIGIN_BENCH,
                "question": t["question"],
                "task": t.get("task", ""),
                "subtask": t.get("subtask", ""),
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
                        "source_origin": t.get("source_origin") or ORIGIN_BENCH,
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
