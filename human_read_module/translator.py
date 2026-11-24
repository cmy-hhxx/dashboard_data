"""Core translators for attribution.jsonl and compact.jsonl records.

Guarantees:
- Original dict is never mutated; output is a deep copy with ONLY whitelisted text fields replaced.
- Frozen fields (evidence, severity, component*, meta, IDs, components_name/kind) are 100% preserved.
- Every LLM batch passes hard structural & numeric validation, retrying up to 2 times with
  targeted error feedback. On failure, raises TranslationError so callers safely skip & fallback.
"""
from __future__ import annotations

import copy
import datetime as dt
import hashlib
import json
from dataclasses import dataclass, field
from typing import Any

from .config import ATTR_PROBLEM_FIELDS, COMPACT_LIST_SPECS, GatewayConfig, PROMPT_VERSION
from .context import EvalInputContext
from .gateway import GatewayClient
from .prompts import (
    build_attr_problems_messages,
    build_attr_summaries_messages,
    build_compact_batch_messages,
)
from .validator import (
    validate_attr_problems,
    validate_attr_summaries,
    validate_compact_batch,
)


class TranslationError(RuntimeError):
    """Raised when a record fails hard accuracy validation after retries."""


@dataclass
class TranslationStats:
    llm_calls: int = 0
    retries: int = 0
    prompt_tokens: int = 0
    completion_tokens: int = 0
    elapsed_s: float = 0.0
    warnings: list[str] = field(default_factory=list)

    def add_call(self, meta: dict[str, Any]):
        self.llm_calls += 1
        self.elapsed_s = round(self.elapsed_s + float(meta.get("elapsed_s") or 0.0), 2)
        usage = meta.get("usage") or {}
        self.prompt_tokens += int(usage.get("prompt_tokens") or 0)
        self.completion_tokens += int(usage.get("completion_tokens") or 0)


def _now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def attribution_text_fingerprint(attr: dict[str, Any]) -> str:
    """Content hash of ONLY the whitelisted attribution text fields (immune to meta backfills)."""
    payload = {
        "session_summary": attr.get("session_summary") or "",
        "turns": [
            {
                "summary": t.get("summary") or "",
                "problem": [
                    {k: p.get(k) or "" for k in ATTR_PROBLEM_FIELDS}
                    for p in (t.get("problem") or [])
                ],
            }
            for t in (attr.get("turns") or [])
        ],
        "session_problem": [
            {k: p.get(k) or "" for k in ATTR_PROBLEM_FIELDS}
            for p in (attr.get("session_problem") or [])
        ],
    }
    raw = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()[:16]


def compact_text_fingerprint(comp: dict[str, Any]) -> str:
    """Content hash of ONLY the whitelisted compact text fields."""
    turns_out = []
    for t in comp.get("turns") or []:
        t_obj = {}
        for list_key, text_key, _ in COMPACT_LIST_SPECS:
            t_obj[list_key] = [str(it.get(text_key) or "") for it in (t.get(list_key) or [])]
        turns_out.append(t_obj)
    raw = json.dumps(turns_out, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()[:16]


def _call_with_validation(
    client: GatewayClient,
    build_msgs_fn,
    validate_fn,
    stats: TranslationStats,
    max_validation_retries: int = 2,
) -> Any:
    feedback: str | None = None
    last_errors: list[str] = []
    for attempt in range(max_validation_retries + 1):
        messages = build_msgs_fn(feedback)
        parsed, meta = client.chat_json(messages)
        stats.add_call(meta)
        errors = validate_fn(parsed)
        if not errors:
            return parsed
        last_errors = errors
        if attempt < max_validation_retries:
            stats.retries += 1
            feedback = "\n".join(f"- {e}" for e in errors)
    raise TranslationError("Hard validation failed after retries: " + "; ".join(last_errors))


def translate_attribution(
    attr: dict[str, Any],
    eval_input: dict[str, Any] | None,
    client: GatewayClient,
    cfg: GatewayConfig | None = None,
) -> tuple[dict[str, Any], TranslationStats]:
    """Return a deep-copied attribution record with whitelisted text fields translated."""
    cfg = cfg or client.cfg
    stats = TranslationStats()
    sm = attr.get("session_meta") or {}
    fallback_q = sm.get("question") or sm.get("question_text") or ""
    ctx_helper = EvalInputContext(eval_input, fallback_question=fallback_q)

    out = copy.deepcopy(attr)
    turns = out.get("turns") or []

    # 1. Translate problems per turn in manageable batches
    for ti, turn in enumerate(turns):
        probs = turn.get("problem") or []
        if not probs:
            continue
        for start in range(0, len(probs), cfg.problem_batch_size):
            batch = probs[start : start + cfg.problem_batch_size]
            batch_payload = []
            for offset, p in enumerate(batch):
                idx = start + offset
                batch_payload.append({
                    "idx": idx,
                    "severity": p.get("severity"),
                    "component": p.get("component"),
                    "label": p.get("label") or "",
                    "problem_phenomena": p.get("problem_phenomena") or "",
                    "reason": p.get("reason") or "",
                    "severity_reason": p.get("severity_reason") or "",
                })
            context = ctx_helper.build_attribution_context(ti, batch)
            parsed = _call_with_validation(
                client,
                lambda fb, c=context, bp=batch_payload: build_attr_problems_messages(c, bp, fb),
                lambda res, bp=batch_payload: validate_attr_problems(bp, res),
                stats,
            )
            by_idx = {item["idx"]: item for item in parsed["problems"]}
            for offset, p in enumerate(batch):
                tr = by_idx[start + offset]
                for field_name in ATTR_PROBLEM_FIELDS:
                    if (p.get(field_name) or "").strip():
                        p[field_name] = tr[field_name].strip()

    # 2. Translate session_problem[] if present
    sess_probs = out.get("session_problem") or []
    for start in range(0, len(sess_probs), cfg.problem_batch_size):
        batch = sess_probs[start : start + cfg.problem_batch_size]
        batch_payload = [
            {
                "idx": start + offset,
                "severity": p.get("severity"),
                "component": p.get("component"),
                "label": p.get("label") or "",
                "problem_phenomena": p.get("problem_phenomena") or "",
                "reason": p.get("reason") or "",
                "severity_reason": p.get("severity_reason") or "",
            }
            for offset, p in enumerate(batch)
        ]
        context = ctx_helper.build_attribution_context(0, batch)
        parsed = _call_with_validation(
            client,
            lambda fb, c=context, bp=batch_payload: build_attr_problems_messages(c, bp, fb),
            lambda res, bp=batch_payload: validate_attr_problems(bp, res),
            stats,
        )
        by_idx = {item["idx"]: item for item in parsed["problems"]}
        for offset, p in enumerate(batch):
            tr = by_idx[start + offset]
            for field_name in ATTR_PROBLEM_FIELDS:
                if (p.get(field_name) or "").strip():
                    p[field_name] = tr[field_name].strip()

    # 3. Translate turn summaries + session_summary (if any non-empty)
    turn_summaries = [
        {"turn_idx": ti, "summary": (t.get("summary") or "").strip()}
        for ti, t in enumerate(turns)
        if (t.get("summary") or "").strip()
    ]
    sess_summary = (out.get("session_summary") or "").strip()
    if turn_summaries or sess_summary:
        summaries_payload = {
            "session_summary": sess_summary,
            "turn_summaries": turn_summaries,
        }
        sum_ctx = {
            "has_input": ctx_helper.has_input,
            "user_question": ctx_helper.user_question(0),
            "final_answer": ctx_helper.final_answer(0, limit=3000),
        }
        parsed = _call_with_validation(
            client,
            lambda fb, c=sum_ctx, sp=summaries_payload: build_attr_summaries_messages(c, sp, fb),
            lambda res, sp=summaries_payload: validate_attr_summaries(sp, res),
            stats,
        )
        if sess_summary:
            out["session_summary"] = parsed["session_summary"].strip()
        by_ti = {it["turn_idx"]: it["summary"].strip() for it in (parsed.get("turn_summaries") or [])}
        for ti, t in enumerate(turns):
            if ti in by_ti and (t.get("summary") or "").strip():
                t["summary"] = by_ti[ti]

    out["_human_read"] = {
        "prompt_version": PROMPT_VERSION,
        "model": cfg.model,
        "source_hash": attribution_text_fingerprint(attr),
        "has_input": ctx_helper.has_input,
        "translated_at": _now_iso(),
    }
    return out, stats


def translate_compact(
    comp: dict[str, Any],
    eval_input: dict[str, Any] | None,
    client: GatewayClient,
    cfg: GatewayConfig | None = None,
) -> tuple[dict[str, Any], TranslationStats]:
    """Return a deep-copied compact record with whitelisted trajectory step texts translated."""
    cfg = cfg or client.cfg
    stats = TranslationStats()
    sm = comp.get("session_meta") or {}
    fallback_q = sm.get("question") or sm.get("question_text") or ""
    ctx_helper = EvalInputContext(eval_input, fallback_question=fallback_q)

    out = copy.deepcopy(comp)
    for ti, turn in enumerate(out.get("turns") or []):
        # Collect all translatable items in this turn with pointer references
        entries: list[tuple[str, dict[str, Any], str, str, str]] = []
        # (item_id, target_dict, text_key, stage_label, orig_text)
        for list_key, text_key, stage_name in COMPACT_LIST_SPECS:
            for idx, item in enumerate(turn.get(list_key) or []):
                if not isinstance(item, dict):
                    continue
                orig_text = (item.get(text_key) or "").strip()
                if not orig_text:
                    continue
                item_id = f"{list_key}[{idx}]"
                entries.append((item_id, item, text_key, stage_name, orig_text))

        if not entries:
            continue

        for start in range(0, len(entries), cfg.compact_batch_size):
            chunk = entries[start : start + cfg.compact_batch_size]
            items_payload = []
            raw_dicts = []
            for item_id, item_dict, _tk, stage_name, orig_text in chunk:
                row = {"id": item_id, "stage": stage_name, "text": orig_text}
                if item_id.startswith("components["):
                    row["component_name"] = item_dict.get("components_name") or ""
                    row["component_kind"] = item_dict.get("components_kind") or ""
                items_payload.append(row)
                raw_dicts.append(item_dict)

            context = ctx_helper.build_compact_context(ti, raw_dicts)
            parsed = _call_with_validation(
                client,
                lambda fb, c=context, ip=items_payload: build_compact_batch_messages(c, ip, fb),
                lambda res, ip=items_payload: validate_compact_batch(ip, res),
                stats,
            )
            by_id = {
                it["id"]: it["text"].strip()
                for it in parsed["items"]
                if isinstance(it, dict) and isinstance(it.get("id"), str) and isinstance(it.get("text"), str)
            }
            for item_id, item_dict, text_key, _sn, _ot in chunk:
                item_dict[text_key] = by_id[item_id]

    out["_human_read"] = {
        "prompt_version": PROMPT_VERSION,
        "model": cfg.model,
        "source_hash": compact_text_fingerprint(comp),
        "has_input": ctx_helper.has_input,
        "translated_at": _now_iso(),
    }
    return out, stats
