#!/usr/bin/env python3
"""Build static/samples.json from demo compact + attribution records.

One sample is one evaluated session.  The evaluation output of a sample is the
pair

    <model>/<model>_attribution-<date>.jsonl
    <model>/compact/<model>_compact-<date>.jsonl

joined by session_id.  The evaluation input is the matching trace in
eval_input, joined by trace_id / session_id.  Nothing is synthesised: a missing
side is reported in quality flags instead of being filled with demo text.

The payload is trimmed for the browser.  Raw trace JSON and long evidence stay
server-side; the page receives readable summaries plus the excerpts needed to
judge a sample.
"""
import argparse
import collections
import glob
import gzip
import hashlib
import json
import os
import re
from datetime import datetime, timedelta, timezone

import dataset_layout as layout

DATASETS = "/mnt/fin_bench/code_and_clean_data/datasets"
TZ = timezone(timedelta(hours=8), "CST")

PRODUCTS = {
    "aime": {
        "label": "AIME",
        "inputs": "1_aime/eval_input",
    },
    "wencai": {
        "label": "问财",
        "inputs": "0_wencai/eval_input",
    },
}

SEVERITY_ORDER = ["P0", "P1", "P2", "P3", "P4", "未分级"]

# Payload budgets (characters).  Each value is a display budget, not a data
# guarantee: the UI shows the summary line first and the excerpt on demand.
SYSTEM_CHARS = 200
REASON_CHARS = 700
TOOL_CHARS = 500
RETURN_CHARS = 620
ANSWER_CHARS = 2600
PROBLEM_CHARS = 260
EVIDENCE_CHARS = 240
SESSION_SUMMARY_CHARS = 1100
TURN_SUMMARY_CHARS = 500
COMPACT_ITEM_CHARS = 240
MAX_PROBLEMS = 16
MAX_EVIDENCE = 2
MAX_COMPACT_ITEMS = 8
DETAIL_FIELDS = ("turns", "session_summary", "session_problems", "overview")

NAME_RE = re.compile(
    r"^(?P<model>.+?)_(?P<kind>attribution|compact)-(?P<date>\d{4}-\d{2}-\d{2})\.jsonl$"
)


# ------------------------------------------------------------------ utilities

def now_iso():
    return datetime.now(TZ).isoformat(timespec="seconds")


def clip(value, limit, marker="…"):
    text = "" if value is None else str(value)
    if limit <= 0 or len(text) <= limit:
        return text
    return text[: max(0, limit - len(marker))] + marker


def json_text(value):
    if isinstance(value, str):
        return value
    try:
        return json.dumps(value, ensure_ascii=False)
    except (TypeError, ValueError):
        return str(value)


def block_text(value):
    """Flatten message content / tool payloads to text without losing order."""
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        parts = [block_text(item) for item in value]
        return "\n".join(part for part in parts if part)
    if isinstance(value, dict):
        for key in ("text", "content", "output", "summary"):
            if key in value:
                return block_text(value[key])
        return json_text(value)
    return str(value)


def question_text(value):
    """Questions may be strings, blocks, or lists; flatten them for display."""
    return re.sub(r"\s+", " ", block_text(value)).strip()


def file_date(path):
    match = re.search(r"(\d{4}-\d{2}-\d{2})", os.path.basename(path or ""))
    return match.group(1) if match else None


def record_key(record):
    meta = record.get("session_meta") or {}
    return str(meta.get("session_id") or meta.get("trace_id") or "")


def dedupe(values):
    seen = set()
    out = []
    for value in values:
        if value and value not in seen:
            seen.add(value)
            out.append(value)
    return out


def usage_of(meta):
    meta = meta or {}
    usage = meta.get("usage") or {}
    total = usage.get("total_tokens")
    if total is None:
        total = meta.get("total_tokens")
    return {
        "input_tokens": usage.get("input_tokens", meta.get("input_tokens")),
        "output_tokens": usage.get("output_tokens", meta.get("output_tokens")),
        "total_tokens": total,
    }


def duration_ms(meta):
    meta = meta or {}
    for key in ("total_duration_ms", "finish_answer_time_cost"):
        if meta.get(key):
            return meta[key]
    if meta.get("latency"):
        return meta["latency"] * 1000
    return None


# --------------------------------------------------------------- demo files

def demo_root(datasets, product):
    if product == "wencai":
        return layout.wencai_output_dir(datasets)
    groups = layout.aime_group_dirs(datasets)
    return groups[0][1] if groups else None


def demo_files(datasets, product):
    """Return (attribution, compact) lists of (model, date, path)."""
    root = demo_root(datasets, product)
    attribution, compact = [], []
    if not root:
        return attribution, compact
    for path in sorted(glob.glob(os.path.join(root, "**", "*.jsonl"), recursive=True)):
        match = NAME_RE.match(os.path.basename(path))
        if not match:
            continue
        item = (match.group("model"), match.group("date"), path)
        if match.group("kind") == "attribution":
            attribution.append(item)
        else:
            compact.append(item)
    return attribution, compact


def read_jsonl(path):
    records = []
    try:
        with open(path, encoding="utf-8", errors="replace") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    records.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
    except OSError:
        pass
    return records


# ------------------------------------------------------------------ trimming

COMPONENT_LABELS = {
    "final_answer": "最终答复",
    "最终答复生成": "最终答复",
    "planner": "规划",
    "planner-finquery": "规划 · 结构查询",
    "planner-search": "规划 · 搜索",
    "finquery": "结构查询",
    "web_search": "网页搜索",
    "analyze.py": "数据分析",
    "analysis": "数据分析",
}


def component_label(value):
    """Turn internal skill paths into short, stable labels for the recall UI."""
    text = str(value or "").strip()
    if not text:
        return "未标注环节"
    if text in COMPONENT_LABELS:
        return COMPONENT_LABELS[text]
    low = text.lower()
    if "finquery" in low:
        return "结构查询"
    if "web_search" in low or "search" in low:
        return "网页搜索"
    if "planner" in low:
        return "规划"
    if "answer" in low or "答复" in text:
        return "最终答复"
    if "/" in text:
        return clip(text.rstrip("/").rsplit("/", 1)[-1], 48)
    return clip(text, 48)


def trim_evidence(items):
    out = []
    for item in (items or [])[:MAX_EVIDENCE]:
        if not isinstance(item, dict):
            continue
        quote = block_text(item.get("quote"))
        out.append({
            "position": clip(item.get("position"), 220),
            "component": component_label(item.get("component")),
            "quote": clip(quote, EVIDENCE_CHARS),
            "quote_full": len(quote),
            "reason": clip(item.get("reason"), 140),
        })
    return out


def trim_problem(problem):
    problem = problem or {}
    return {
        "severity": problem.get("severity") or "未分级",
        "component": component_label(problem.get("component")),
        "label": clip(problem.get("label"), 220),
        "definition": clip(problem.get("definition"), PROBLEM_CHARS),
        "phenomena": clip(problem.get("problem_phenomena"), PROBLEM_CHARS),
        "reason": clip(problem.get("reason"), PROBLEM_CHARS),
        "severity_reason": clip(problem.get("severity_reason"), 320),
        "evidence_count": len(problem.get("evidence") or []),
        "evidence": trim_evidence(problem.get("evidence")),
    }


def trim_compact_item(item, content_keys, index_key):
    item = item or {}
    content = ""
    for key in content_keys:
        if item.get(key):
            content = block_text(item.get(key))
            break
    return {
        "index": item.get(index_key) or 0,
        "content": clip(content, COMPACT_ITEM_CHARS),
        "evidence_count": len(item.get("evidence") or []),
    }


def trim_compact_turn(turn):
    turn = turn or {}
    return {
        "index": turn.get("turn_idx") or 0,
        "plans": [
            trim_compact_item(item, ("content",), "step_idx")
            for item in (turn.get("plans") or [])[:MAX_COMPACT_ITEMS]
        ],
        "reasoning": [
            trim_compact_item(item, ("content",), "step_idx")
            for item in (turn.get("reasoning_chain") or [])[:MAX_COMPACT_ITEMS]
        ],
        "execution": [
            trim_compact_item(item, ("content",), "step_idx")
            for item in (turn.get("execution_chain") or [])[:MAX_COMPACT_ITEMS]
        ],
        "reflections": [
            trim_compact_item(item, ("reflection_content",), "reflection_idx")
            for item in (turn.get("reflections") or [])[:MAX_COMPACT_ITEMS]
        ],
        "tool_errors": [
            trim_compact_item(item, ("tool_error_content",), "tool_error_idx")
            for item in (turn.get("tool_errors") or [])[:MAX_COMPACT_ITEMS]
        ],
        "components": [
            {
                "name": item.get("components_name") or "",
                "kind": item.get("components_kind") or "",
                "content": clip(item.get("components_content"), COMPACT_ITEM_CHARS),
                "evidence_count": len(item.get("evidence") or []),
            }
            for item in (turn.get("components") or [])[:MAX_COMPACT_ITEMS]
        ],
        "answer_chars": len(turn.get("final_answer") or ""),
    }


# ----------------------------------------------------------------- input side

def parse_plan(text):
    """Turn a planner JSON payload into its list of query strings."""
    raw = text or ""
    match = re.search(r"```(?:json)?\s*([\s\S]*?)```", raw)
    if match:
        raw = match.group(1)
    try:
        data = json.loads(raw)
    except (TypeError, ValueError):
        return []
    if isinstance(data, dict):
        data = [data]
    if not isinstance(data, list):
        return []
    queries = []
    for item in data:
        if not isinstance(item, dict):
            continue
        content = item.get("content")
        if isinstance(content, str):
            queries.append(content)
        elif isinstance(content, list):
            queries.extend(str(x) for x in content if isinstance(x, str))
    return dedupe(queries)


def tool_call_view(payload):
    if isinstance(payload, dict):
        for key in ("query", "q", "keyword"):
            if isinstance(payload.get(key), str):
                return clip(payload[key], 500)
    return clip(json_text(payload), 500)


def tool_result_view(name, output):
    """Return (summary, preview, detail) for a tool result."""
    if name == "finquery" and isinstance(output, dict):
        rows = output.get("row_count")
        if rows is None and isinstance(output.get("datas"), list):
            rows = len(output["datas"])
        columns = output.get("columns") or []
        data = output.get("datas") or []
        status = output.get("status_msg") or ""
        warns = output.get("warns") or []
        bits = []
        if rows is not None:
            bits.append(f"{rows} 行")
        if columns:
            bits.append(f"{len(columns)} 列")
        if status:
            bits.append(str(status))
        if warns:
            bits.append(clip(warns[0], 90))
        summary = " · ".join(bits) or "finquery 返回"
        names = [str(c.get("key") or c.get("index_name") or "") for c in columns if isinstance(c, dict)]
        preview = []
        if names:
            preview.append("列：" + "，".join(names[:12]))
        if data and isinstance(data[0], dict):
            pairs = list(data[0].items())[:12]
            preview.append("首行：" + "，".join(f"{k}={v}" for k, v in pairs))
        detail = {
            "status": status,
            "warns": warns[:2],
            "columns": names[:20],
            "rows": data[:1],
        }
        return summary, clip("\n".join(preview), RETURN_CHARS), clip(json_text(detail), 900)
    if name == "web_search" and isinstance(output, dict):
        items = output.get("items") or []
        summary = f"{len(items)} 条结果"
        preview = []
        for item in items[:3]:
            if not isinstance(item, dict):
                continue
            title = item.get("title") or item.get("serial_number") or ""
            summary_text = block_text(item.get("summary"))
            preview.append(f"{title}：{clip(summary_text, 180)}")
        detail = {
            "items": [
                {
                    "id": item.get("serial_number") or "",
                    "title": clip(item.get("title"), 160),
                    "url": clip(item.get("url"), 300),
                    "summary": clip(block_text(item.get("summary")), 320),
                }
                for item in items[:3]
                if isinstance(item, dict)
            ]
        }
        return summary, clip("\n".join(preview), RETURN_CHARS), clip(json_text(detail), 1100)
    text = block_text(output)
    return "工具返回", clip(text, RETURN_CHARS), clip(json_text(output), 700)


def same_answer(left, right):
    left = (left or "").strip()
    right = (right or "").strip()
    if not left or not right:
        return False
    if left == right:
        return True
    short, long = (left, right) if len(left) <= len(right) else (right, left)
    return len(short) > 160 and short[:160] == long[:160]


def normalize_trace(trace, question):
    """Build the readable event stream shown in the evaluation-input pane."""
    messages = (trace or {}).get("messages") or []

    final_answer = ""
    for message in messages:
        if message.get("type") == "final_answer":
            final_answer = block_text(message.get("content"))
            break
    if not final_answer:
        for message in reversed(messages):
            if message.get("type") == "llm_turn":
                final_answer = block_text(message.get("output"))
                if final_answer:
                    break

    systems = []
    seen_systems = set()
    for message in messages:
        if not isinstance(message, dict) or message.get("type") != "llm_turn":
            continue
        for item in message.get("input_messages") or []:
            if not isinstance(item, dict) or item.get("role") != "system":
                continue
            content = block_text(item.get("content"))
            if not content or content in seen_systems:
                continue
            seen_systems.add(content)
            systems.append({
                "name": message.get("name") or "system",
                "chars": len(content),
                "text": clip(content, SYSTEM_CHARS),
            })
            if len(systems) >= 6:
                break

    events = []
    if systems:
        total = sum(item["chars"] for item in systems)
        events.append({
            "kind": "system",
            "name": "系统提示",
            "summary": f"{len(systems)} 段 · 共 {total:,} 字",
            "items": systems,
        })

    for message in messages:
        if not isinstance(message, dict):
            continue
        kind = message.get("type")
        if kind == "user_question":
            raw = block_text(message.get("content"))
            clean = question_text(question) or raw
            events.append({
                "kind": "user",
                "name": "用户输入",
                "text": clean,
                "raw": clip(raw, 1600) if raw and raw.strip() != clean.strip() else "",
                "chars": len(raw),
            })
        elif kind == "llm_turn":
            text = block_text(message.get("output"))
            if not text or same_answer(text, final_answer):
                continue
            queries = parse_plan(text)
            if queries:
                events.append({
                    "kind": "reason",
                    "name": message.get("name") or "规划",
                    "summary": f"规划 {len(queries)} 条查询",
                    "text": clip("\n".join(f"· {item}" for item in queries), REASON_CHARS),
                    "chars": len(text),
                    "parsed": True,
                })
            else:
                events.append({
                    "kind": "reason",
                    "name": message.get("name") or "思考",
                    "summary": "模型输出",
                    "text": clip(text, REASON_CHARS),
                    "chars": len(text),
                })
        elif kind == "tool_call":
            name = message.get("name") or "tool"
            events.append({
                "kind": "tool",
                "name": name,
                "summary": tool_call_view(message.get("input")),
                "text": clip(json_text(message.get("input")), TOOL_CHARS),
                "chars": len(json_text(message.get("input"))),
                "latency": message.get("latency"),
            })
        elif kind == "tool_result":
            name = message.get("name") or "tool"
            summary, preview, detail = tool_result_view(name, message.get("output"))
            events.append({
                "kind": "return",
                "name": name,
                "summary": summary,
                "text": preview,
                "detail": detail,
                "chars": len(preview),
                "latency": message.get("latency"),
            })
        elif kind == "final_answer":
            events.append({
                "kind": "answer",
                "name": "最终回答",
                "text": clip(final_answer, ANSWER_CHARS),
                "chars": len(final_answer),
            })

    if final_answer and not any(event["kind"] == "answer" for event in events):
        events.append({
            "kind": "answer",
            "name": "最终回答",
            "text": clip(final_answer, ANSWER_CHARS),
            "chars": len(final_answer),
        })

    meta = (trace or {}).get("meta") or {}
    usage = usage_of(meta)
    return {
        "events": events,
        "stats": {
            "n_messages": meta.get("n_messages"),
            "tool_count": meta.get("tool_count"),
            "input_tokens": usage["input_tokens"],
            "output_tokens": usage["output_tokens"],
            "total_tokens": usage["total_tokens"],
            "duration_ms": duration_ms(meta),
            "answer_len": len(final_answer) if final_answer else meta.get("answer_len"),
        },
    }


# ---------------------------------------------------------------- build sample

def build_sample(product, model, date, attribution, compact):
    session_meta = attribution.get("session_meta") or {}
    session_id = record_key(attribution)
    session_question = question_text(
        session_meta.get("question") or session_meta.get("question_zh")
    )
    compact_turns = (compact or {}).get("turns") or []
    compact_trace_ids = [
        (item.get("trace_id") or "")
        for item in ((compact or {}).get("trace_meta") or [])
    ]
    compact_by_trace = {}
    for position, turn in enumerate(compact_turns):
        index = turn.get("turn_idx")
        if index is None:
            index = position
        trace_id = compact_trace_ids[index] if 0 <= index < len(compact_trace_ids) else ""
        if trace_id:
            compact_by_trace[trace_id] = turn

    turns = []
    for position, turn in enumerate(attribution.get("turns") or []):
        turn_meta = turn.get("meta") or {}
        trace_id = turn_meta.get("trace_id") or (
            session_meta.get("trace_id") if len(attribution.get("turns") or []) == 1 else ""
        )
        compact_turn = compact_by_trace.get(trace_id)
        if compact_turn is None and position < len(compact_turns):
            compact_turn = compact_turns[position]
        problems = [trim_problem(item) for item in (turn.get("problem") or [])[:MAX_PROBLEMS]]
        usage = usage_of(turn_meta)
        turns.append({
            "index": position,
            "trace_id": trace_id or "",
            "question": question_text(turn_meta.get("question")) or session_question,
            "question_zh": question_text(turn_meta.get("question_zh")),
            "task": turn_meta.get("task") or "",
            "subtask": turn_meta.get("subtask") or "",
            "difficulty": turn_meta.get("difficulty") or "",
            "summary": clip(turn.get("summary"), TURN_SUMMARY_CHARS),
            "is_correct": turn.get("is_correct"),
            "correct_reason": clip(turn.get("correct_reason"), 420),
            "problems": problems,
            "problem_count": len(problems),
            "tokens": usage["total_tokens"],
            "duration_ms": duration_ms(turn_meta),
            "answer_len": turn_meta.get("answer_len"),
            "n_messages": turn_meta.get("n_messages"),
            "tool_count": turn_meta.get("tool_count"),
            "compact": trim_compact_turn(compact_turn),
            "input": None,
        })

    session_problems = [
        trim_problem(item) for item in (attribution.get("session_problem") or [])[:MAX_PROBLEMS]
    ]
    all_problems = [problem for turn in turns for problem in turn["problems"]] + session_problems
    severities = dedupe(problem["severity"] for problem in all_problems)
    components = dedupe(problem["component"] for problem in all_problems)
    labels = dedupe(problem["label"] for problem in all_problems)
    usage = usage_of(session_meta)
    total_tokens = session_meta.get("total_tokens_sum") or usage["total_tokens"]
    if not total_tokens:
        total_tokens = sum(turn["tokens"] or 0 for turn in turns) or None

    slug = hashlib.sha1(
        f"{product}:{model}:{date}:{session_id}".encode("utf-8")
    ).hexdigest()[:12]
    sample = {
        "id": slug,
        "product": product,
        "model": model,
        "date": date,
        "session_id": session_id,
        "trace_id": turns[0]["trace_id"] if turns else (session_meta.get("trace_id") or session_id),
        "user_id": session_meta.get("user_id") or "",
        "question": session_question,
        "question_zh": (
            (turns[0]["question_zh"] if turns else "")
            or question_text(session_meta.get("question_zh"))
        ),
        "task": turns[0]["task"] if turns else "",
        "subtask": turns[0]["subtask"] if turns else "",
        "difficulty": turns[0]["difficulty"] if turns else "",
        "source": session_meta.get("source") or "",
        "agent_mode": session_meta.get("agent_mode") or "",
        "outcome": session_meta.get("outcome") or "",
        "date_time": session_meta.get("request_time") or "",
        "answer_len": session_meta.get("answer_len"),
        "n_messages": session_meta.get("n_messages"),
        "tool_count": session_meta.get("tool_count"),
        "tokens": total_tokens,
        "duration_ms": session_meta.get("total_duration_ms"),
        "turn_count": len(turns),
        "problem_count": len(all_problems),
        "severities": severities,
        "components": components,
        "labels": labels,
        "session_summary": clip(attribution.get("session_summary"), SESSION_SUMMARY_CHARS),
        "session_problems": session_problems,
        "trace_ids": dedupe(
            [session_meta.get("trace_id")] + [turn["trace_id"] for turn in turns]
        )[:8],
        "questions": dedupe(
            [session_question]
            + [turn["question"] for turn in turns]
            + [turn["question_zh"] for turn in turns]
        )[:8],
        "overview": [
            clip(item, 320)
            for item in ((compact or {}).get("session_overview") or [])[:6]
        ],
        "turns": turns,
        "quality": {
            "input_missing": True,
            "input_missing_reason": None,
            "compact_missing": compact is None,
        },
    }
    return sample


# --------------------------------------------------------------- input join

def input_paths(datasets, product, model, date):
    base = os.path.join(datasets, PRODUCTS[product]["inputs"])
    patterns = [
        os.path.join(base, "*", model, f"{date}.jsonl"),
        os.path.join(base, "*", model, f"{model}-{date}_input.jsonl"),
        os.path.join(base, "*", model, f"*-{date}_input.jsonl"),
        os.path.join(base, model, f"{date}.jsonl"),
    ]
    paths = []
    for pattern in patterns:
        paths.extend(glob.glob(pattern))
    return dedupe(paths)


def trace_ids_of(record):
    ids = set()
    for key in ("trace_id", "case_id", "session_id"):
        if record.get(key):
            ids.add(str(record[key]))
    meta = record.get("meta") or {}
    for key in ("trace_id", "session_id", "case_id"):
        if meta.get(key):
            ids.add(str(meta[key]))
    for trace in record.get("traces") or []:
        meta = trace.get("meta") or {}
        for key in ("trace_id", "session_id", "case_id"):
            if meta.get(key):
                ids.add(str(meta[key]))
    return ids


def resolve_inputs(samples, datasets, max_input_mb):
    # path -> key -> [(sample, turn index, key_is_trace_id)]
    wanted = collections.defaultdict(dict)
    for sample in samples:
        paths = input_paths(datasets, sample["product"], sample["model"], sample["date"])
        if not paths:
            sample["quality"]["input_missing_reason"] = "input_file_missing"
            continue
        for path in paths:
            try:
                if max_input_mb and os.path.getsize(path) / (1024 * 1024) > max_input_mb:
                    sample["quality"]["input_missing_reason"] = "input_file_too_large"
                    continue
            except OSError:
                continue
            if sample["session_id"]:
                wanted[path].setdefault(str(sample["session_id"]), []).append(
                    (sample, -1, False)
                )
            for position, turn in enumerate(sample["turns"]):
                key = turn["trace_id"] or sample["trace_id"]
                if key:
                    wanted[path].setdefault(str(key), []).append((sample, position, True))

    for path, keymap in wanted.items():
        remaining = {
            (sample["id"], position)
            for entries in keymap.values()
            for sample, position, _ in entries
            if position >= 0 and sample["turns"][position]["input"] is None
        }
        if not remaining:
            continue
        keys = [key.encode("utf-8") for key in keymap]
        pattern = re.compile(b"|".join(re.escape(key) for key in keys)) if keys else None
        try:
            fh = open(path, "rb")
        except OSError:
            continue
        with fh:
            for raw in fh:
                if pattern is not None and not pattern.search(raw):
                    continue
                try:
                    record = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                hits = trace_ids_of(record) & keymap.keys()
                if not hits:
                    continue
                for key in hits:
                    for sample, position, _ in keymap.get(key, []):
                        # A session-key hit is only safe for a single-turn
                        # sample; multi-turn records attach through their
                        # per-turn trace ids below.
                        if position < 0:
                            if len(sample["turns"]) != 1:
                                continue
                            position = 0
                        if (sample["id"], position) not in remaining:
                            continue
                        turn = sample["turns"][position]
                        traces = record.get("traces") or []
                        trace = None
                        for item in traces:
                            meta = item.get("meta") or {}
                            if meta.get("trace_id") in (key, turn["trace_id"]):
                                trace = item
                                break
                        if trace is None and len(traces) == 1:
                            trace = traces[0]
                        if trace is None and record.get("messages"):
                            trace = record
                        if trace is None:
                            continue
                        turn["input"] = normalize_trace(trace, turn["question"])
                        remaining.discard((sample["id"], position))
                if not remaining:
                    break

    for sample in samples:
        turns = sample["turns"]
        missing = not turns or any(turn["input"] is None for turn in turns)
        sample["quality"]["input_missing"] = missing
        if missing and not sample["quality"]["input_missing_reason"]:
            sample["quality"]["input_missing_reason"] = "input_id_not_found"


# ------------------------------------------------------------------- assembly

def severity_counts(samples):
    counter = collections.Counter()
    for sample in samples:
        for problem in sample["session_problems"]:
            counter[problem["severity"]] += 1
        for turn in sample["turns"]:
            for problem in turn["problems"]:
                counter[problem["severity"]] += 1
    return {key: counter.get(key, 0) for key in SEVERITY_ORDER if counter.get(key)}


def sorted_counts(counter):
    return dict(sorted(counter.items(), key=lambda item: (-item[1], item[0])))


def build_product(product, samples, attr_files, comp_files):
    models = collections.Counter(sample["model"] for sample in samples)
    dates = collections.Counter(sample["date"] for sample in samples)
    components = collections.Counter()
    tasks = collections.Counter()
    labels = collections.Counter()
    for sample in samples:
        for component in sample["components"]:
            components[component] += 1
        if sample["task"]:
            tasks[sample["task"]] += 1
        for label in sample["labels"]:
            labels[label] += 1
    return {
        "label": PRODUCTS[product]["label"],
        "total": len(samples),
        "models": sorted(models),
        "dates": sorted(dates, reverse=True),
        "facets": {
            "models": sorted_counts(models),
            "dates": {key: dates[key] for key in sorted(dates, reverse=True)},
            "severities": severity_counts(samples),
            "components": sorted_counts(components),
            "tasks": sorted_counts(tasks),
            "labels": [{"name": name, "value": count} for name, count in labels.most_common(30)],
        },
        "sources": {
            "attribution_files": len(attr_files),
            "compact_files": len(comp_files),
        },
        "samples": samples,
    }


def write_payload(payload, out_path):
    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    text = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    text = text.replace("<", "\\u003c").replace(">", "\\u003e").replace("&", "\\u0026")
    data = text.encode("utf-8")
    tmp = out_path + ".tmp"
    with open(tmp, "wb") as out:
        out.write(data)
    os.replace(tmp, out_path)
    gz_tmp = out_path + ".gz.tmp"
    with open(gz_tmp, "wb") as raw:
        with gzip.GzipFile(fileobj=raw, mode="wb", compresslevel=6) as gz:
            gz.write(data)
    os.replace(gz_tmp, out_path + ".gz")
    return len(data), os.path.getsize(out_path + ".gz")


def index_sample(sample):
    """Keep only what the recall list and search need; details load on demand."""
    return {key: value for key, value in sample.items() if key not in DETAIL_FIELDS}


def detail_dir(out_path):
    return os.path.join(os.path.dirname(os.path.abspath(out_path)), "samples")


def write_detail_files(samples, out_path):
    folder = detail_dir(out_path)
    os.makedirs(folder, exist_ok=True)
    keep = set()
    for sample in samples:
        detail = {key: sample[key] for key in DETAIL_FIELDS if key in sample}
        detail["id"] = sample["id"]
        write_payload(detail, os.path.join(folder, f"{sample['id']}.json"))
        keep.add(f"{sample['id']}.json")
        keep.add(f"{sample['id']}.json.gz")
    return keep


def prune_detail_files(out_path, keep):
    folder = detail_dir(out_path)
    if not os.path.isdir(folder):
        return
    for name in os.listdir(folder):
        if not name.endswith((".json", ".json.gz")) or name in keep:
            continue
        try:
            os.remove(os.path.join(folder, name))
        except OSError:
            pass


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    parser = argparse.ArgumentParser(description="Build samples.json from compact + attribution demo records")
    parser.add_argument("--datasets", default=DATASETS, help="datasets root (default: server data root)")
    parser.add_argument("--out", default=os.path.join(here, "static", "samples.json"))
    parser.add_argument("--product", choices=["all", "wencai", "aime"], default="all")
    parser.add_argument("--limit", type=int, default=0, help="max samples per product (0 = all)")
    parser.add_argument("--max-input-mb", type=int, default=3000, help="skip input files larger than this")
    args = parser.parse_args()

    products = ["aime", "wencai"] if args.product == "all" else [args.product]
    payload = {
        "generated_at": now_iso(),
        "schema_version": 2,
        "source": "demo_data",
        "products": {},
    }
    summary = {}
    detail_samples = []

    for product in products:
        attr_files, comp_files = demo_files(args.datasets, product)
        compact_index = {}
        for model, date, path in comp_files:
            for record in read_jsonl(path):
                key = record_key(record)
                if key:
                    compact_index[(model, key)] = record

        samples = []
        seen = set()
        for model, date, path in attr_files:
            for record in read_jsonl(path):
                key = record_key(record)
                if not key:
                    continue
                identity = (model, key)
                if identity in seen:
                    continue
                seen.add(identity)
                compact = compact_index.get(identity)
                samples.append(build_sample(product, model, date, record, compact))

        samples.sort(key=lambda sample: (sample["date"], sample["model"], sample["id"]), reverse=True)
        if args.limit:
            samples = samples[: args.limit]
        resolve_inputs(samples, args.datasets, args.max_input_mb)

        for sample in samples:
            sample.pop("_input_wanted", None)
            for turn in sample["turns"]:
                turn.pop("_wanted", None)

        product_payload = build_product(
            product, samples, attr_files, comp_files,
        )
        product_payload["samples"] = [index_sample(sample) for sample in samples]
        payload["products"][product] = product_payload
        detail_samples.extend(samples)
        summary[product] = {
            "samples": len(samples),
            "attribution_files": len(attr_files),
            "compact_files": len(comp_files),
            "input_missing": sum(1 for sample in samples if sample["quality"]["input_missing"]),
            "compact_missing": sum(1 for sample in samples if sample["quality"]["compact_missing"]),
            "problems": sum(sample["problem_count"] for sample in samples),
        }

    payload["totals"] = {
        "samples": sum(item["samples"] for item in summary.values()),
        **{product: item["samples"] for product, item in summary.items()},
    }
    keep = write_detail_files(detail_samples, args.out)
    size, gz_size = write_payload(payload, args.out)
    prune_detail_files(args.out, keep)
    print(json.dumps({
        "generated_at": payload["generated_at"],
        "bytes": size,
        "gzip_bytes": gz_size,
        "details": len(detail_samples),
        "products": summary,
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
