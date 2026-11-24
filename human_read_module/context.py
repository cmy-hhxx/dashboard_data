"""Minimal-sufficient context extraction from paired eval_input records.

Instead of feeding hundreds of KB of raw tool JSON to the translator, we extract:
1. User question(s) for the relevant turn/trace.
2. Model final answer(s) for the relevant turn/trace (clipped cleanly).
3. Exact message snippets referenced by attribution `evidence[].position` or
   compact `evidence[].evidence_id` (centered around the quoted text when long).
"""
from __future__ import annotations

import json
import re
from typing import Any

POSITION_RE = re.compile(r"trace_index\s+(\d+)\s*/\s*message_index\s+(\d+)\s*/\s*path\s+(\S+)")
EVIDENCE_ID_RE = re.compile(r"^ev_[0-9a-f-]{36}_(\d+)_")


def _as_text(val: Any) -> str:
    if val is None:
        return ""
    if isinstance(val, str):
        return val
    try:
        return json.dumps(val, ensure_ascii=False)
    except (TypeError, ValueError):
        return str(val)


def _content_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for item in content:
            if isinstance(item, dict) and isinstance(item.get("text"), str):
                parts.append(item["text"])
            elif isinstance(item, dict) and "image" in str(item.get("type", "")):
                parts.append("[图片]")
            else:
                parts.append(_as_text(item))
        return "\n".join(p for p in parts if p)
    return _as_text(content)


def message_kind(msg: dict) -> str:
    t = msg.get("type")
    role = msg.get("role")
    if t == "user_question":
        return "user"
    if t == "final_answer":
        return "answer"
    if t == "llm_turn":
        return "llm"
    if t in ("tool_call", "function_call"):
        return "call"
    if t in ("tool_result", "function_call_output"):
        return "result"
    if t == "reasoning":
        return "think"
    if role == "system":
        return "system"
    if role == "user":
        return "user"
    if role == "assistant":
        return "answer"
    return "other"


def message_text(msg: dict) -> str:
    t = msg.get("type")
    if t == "llm_turn":
        out = msg.get("output")
        if isinstance(out, str):
            return out
        parts = []
        for o in out or []:
            if not isinstance(o, dict):
                parts.append(_as_text(o))
                continue
            if o.get("reasoning_content"):
                parts.append("[思考] " + str(o["reasoning_content"]))
            if o.get("content"):
                parts.append(_content_text(o["content"]))
            for tc in o.get("tool_calls") or []:
                fn = (tc or {}).get("function") or {}
                name = fn.get("name") or "?"
                args = fn.get("arguments")
                parts.append(f"[调用 {name}] {_as_text(args)}")
        return "\n".join(p for p in parts if p)
    if t == "tool_call":
        name = msg.get("name") or ""
        head = f"[工具调用 {name}] " if name else "[工具调用] "
        return head + _as_text(msg.get("input"))
    if t == "tool_result":
        name = msg.get("name") or ""
        head = f"[工具返回 {name}] " if name else "[工具返回] "
        return head + _content_text(msg.get("output"))
    if t == "function_call":
        name = msg.get("name") or ""
        return f"[工具调用 {name}] {_as_text(msg.get('arguments'))}"
    if t == "function_call_output":
        return "[工具返回] " + _content_text(msg.get("output"))
    if t == "reasoning":
        return "[思考] " + _content_text(msg.get("summary") or [])
    if "content" in msg:
        return _content_text(msg.get("content"))
    return _as_text({k: v for k, v in msg.items() if k != "input_messages"})


def clip_middle(text: str, limit: int) -> str:
    text = (text or "").strip()
    if len(text) <= limit:
        return text
    head = int(limit * 0.65)
    tail = max(0, limit - head - 20)
    return f"{text[:head]}\n...（中间省略 {len(text) - head - tail} 字）...\n{text[-tail:]}"


def clip_around_quote(text: str, quote: str | None, limit: int = 1200) -> str:
    text = (text or "").strip()
    if len(text) <= limit:
        return text
    if quote:
        q = quote.strip()
        anchor = q[:60] if len(q) > 60 else q
        pos = text.find(anchor) if anchor else -1
        if pos >= 0:
            half = max(200, (limit - len(anchor)) // 2)
            start = max(0, pos - half)
            end = min(len(text), pos + len(anchor) + half)
            prefix = "…" if start > 0 else ""
            suffix = "…" if end < len(text) else ""
            return prefix + text[start:end] + suffix
    return clip_middle(text, limit)


class EvalInputContext:
    """Indexed view of a single eval_input session for fast, targeted snippet extraction."""

    def __init__(self, eval_input: dict | None, fallback_question: str = ""):
        self.has_input = isinstance(eval_input, dict) and bool(eval_input.get("traces"))
        self.fallback_question = (fallback_question or "").strip()
        self.traces: list[list[dict]] = []
        self.flat_map: list[tuple[int, int]] = []  # global_msg_idx -> (trace_idx, local_msg_idx)

        if self.has_input:
            for ti, tr in enumerate(eval_input.get("traces") or []):
                msgs = tr.get("messages") or []
                self.traces.append(msgs)
                for mi in range(len(msgs)):
                    self.flat_map.append((ti, mi))

    def _trace_idx(self, turn_idx: int) -> int:
        if not self.traces:
            return -1
        return min(max(0, turn_idx), len(self.traces) - 1)

    def user_question(self, turn_idx: int = 0, limit: int = 2000) -> str:
        ti = self._trace_idx(turn_idx)
        if ti >= 0:
            for msg in self.traces[ti]:
                if message_kind(msg) == "user":
                    txt = message_text(msg).strip()
                    if txt:
                        return clip_middle(txt, limit)
        return clip_middle(self.fallback_question, limit)

    def final_answer(self, turn_idx: int = 0, limit: int = 4500) -> str:
        ti = self._trace_idx(turn_idx)
        if ti < 0:
            return ""
        msgs = self.traces[ti]
        for msg in reversed(msgs):
            if message_kind(msg) == "answer":
                txt = message_text(msg).strip()
                if txt:
                    return clip_middle(txt, limit)
        # Fallback: last llm_turn content if no explicit final_answer message
        for msg in reversed(msgs):
            if message_kind(msg) == "llm":
                txt = message_text(msg).strip()
                if txt:
                    return clip_middle(txt, limit)
        return ""

    def snippet_by_position(self, position: str, quote: str | None = None, limit: int = 1200) -> tuple[str, str] | None:
        m = POSITION_RE.search(position or "")
        if not m or not self.traces:
            return None
        ti, mi = int(m.group(1)), int(m.group(2))
        if ti < 0 or ti >= len(self.traces):
            return None
        msgs = self.traces[ti]
        if mi < 0 or mi >= len(msgs):
            return None
        msg = msgs[mi]
        kind = message_kind(msg)
        key = f"trace#{ti}/msg#{mi}({kind})"
        snippet = clip_around_quote(message_text(msg), quote, limit=limit)
        return key, snippet

    def snippet_by_evidence_id(self, evidence_id: str, quote: str | None = None, limit: int = 800) -> tuple[str, str] | None:
        m = EVIDENCE_ID_RE.match(evidence_id or "")
        if not m or not self.flat_map:
            return None
        gidx = int(m.group(1))
        if gidx < 0 or gidx >= len(self.flat_map):
            return None
        ti, mi = self.flat_map[gidx]
        msg = self.traces[ti][mi]
        kind = message_kind(msg)
        key = f"trace#{ti}/msg#{mi}({kind})"
        snippet = clip_around_quote(message_text(msg), quote, limit=limit)
        return key, snippet

    def build_attribution_context(
        self,
        turn_idx: int,
        problems: list[dict],
        max_evidence_snippets: int = 8,
        answer_limit: int = 4500,
    ) -> dict[str, Any]:
        """Build a concise, high-signal context dict for translating attribution fields."""
        q = self.user_question(turn_idx)
        ans = self.final_answer(turn_idx, limit=answer_limit)
        seen: dict[str, str] = {}
        for p in problems:
            for ev in p.get("evidence") or []:
                if len(seen) >= max_evidence_snippets:
                    break
                hit = self.snippet_by_position(ev.get("position") or "", ev.get("quote"), limit=1100)
                if not hit:
                    continue
                key, snippet = hit
                # Skip duplicating full user/answer if already included verbatim
                if key not in seen and snippet:
                    seen[key] = snippet
        return {
            "has_input": self.has_input,
            "user_question": q,
            "final_answer": ans,
            "evidence_messages": [{"loc": k, "excerpt": v} for k, v in seen.items()],
        }

    def build_compact_context(
        self,
        turn_idx: int,
        items: list[dict],
        max_evidence_snippets: int = 4,
    ) -> dict[str, Any]:
        """Build lightweight context for translating a batch of compact trajectory steps."""
        q = self.user_question(turn_idx, limit=1200)
        ans = self.final_answer(turn_idx, limit=1800)
        seen: dict[str, str] = {}
        for it in items:
            for ev in it.get("evidence") or []:
                if len(seen) >= max_evidence_snippets:
                    break
                hit = self.snippet_by_evidence_id(ev.get("evidence_id") or "", ev.get("quote"), limit=600)
                if hit and hit[0] not in seen and hit[1]:
                    seen[hit[0]] = hit[1]
        return {
            "has_input": self.has_input,
            "user_question": q,
            "final_answer_preview": ans,
            "evidence_messages": [{"loc": k, "excerpt": v} for k, v in seen.items()],
        }
