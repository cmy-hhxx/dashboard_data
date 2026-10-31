#!/usr/bin/env python3
"""Build static/samples.json for the 具体样本 browser from real eval records.

Selection is driven by the real cluster_tree.json files (leaf exemplars), so
every sample is recallable from its attribution component / severity / label
and from its cluster path / leaf id.  For each selected problem the referenced
output JSONL line is resolved (src_line + json_path, verified by label) and the
matching input record is joined by trace_id (fallback case_id / session_id).
Nothing is synthesised: missing input is emitted as input=null with a quality
flag.

Output is a trimmed, gzip-compressed JSON payload (< ~1.5 MB for 60 samples).
"""
import argparse
import collections
import gzip
import json
import os
import re
import sys
from datetime import datetime, timedelta, timezone

DATASETS = "/mnt/fin_bench/code_and_clean_data/datasets"
TZ = timezone(timedelta(hours=8), "CST")

WENCAI_MODELS = ["a_fast", "a_expert", "b_fast", "b_expert"]
AIME_MODEL = "aime_fast"
SEVERITY_ORDER = ["P0", "P1", "P2", "P3"]

# Payload budgets (characters) -------------------------------------------------
SYSTEM_CHARS = 1200
TOOL_CHARS = 1200
MESSAGE_CHARS = 6000
REASONING_CHARS = 600
EVIDENCE_CHARS = 400
INPUT_BUDGET = 11000


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


def file_date(path):
    match = re.search(r"(\d{4}-\d{2}-\d{2})", os.path.basename(path or ""))
    return match.group(1) if match else None


def parse_json_path(path):
    match = re.match(r"turns\[(\d+)\]\.problem\[(\d+)\]", path or "")
    if not match:
        return 0, 0
    return int(match.group(1)), int(match.group(2))


def same_label(left, right):
    return (left or "").strip() == (right or "").strip()


# --------------------------------------------------------------- cluster input

def cluster_specs(datasets):
    wc_out = f"{datasets}/0_wencai/eval_output/0_daily_eval_output"
    wc_in = f"{datasets}/0_wencai/eval_input/0_daily_eval_input"
    ai_out = f"{datasets}/1_aime/eval_output"
    ai_in = f"{datasets}/1_aime/eval_input"
    specs = []
    for model in WENCAI_MODELS:
        specs.append({
            "product": "wencai",
            "model": model,
            "split": "daily",
            "tree": f"{wc_out}/{model}/cluster/cluster_tree.json",
            "outdir": f"{wc_out}/{model}",
            "indir": f"{wc_in}/{model}",
            "output_split": "0_daily_eval_output",
        })
    specs.append({
        "product": "aime",
        "model": AIME_MODEL,
        "split": "lost",
        "tree": f"{ai_out}/1_lost_user_eval_output/{AIME_MODEL}/cluster/cluster_tree.json",
        "outdir": f"{ai_out}/1_lost_user_eval_output/{AIME_MODEL}",
        "indir": f"{ai_in}/1_lost_user_input/{AIME_MODEL}",
        "output_split": "1_lost_user_eval_output",
    })
    specs.append({
        "product": "aime",
        "model": AIME_MODEL,
        "split": "daily",
        "tree": f"{ai_out}/0_daily_eval_output/{AIME_MODEL}/cluster/cluster_tree.json",
        "outdir": f"{ai_out}/0_daily_eval_output/{AIME_MODEL}",
        "indir": f"{ai_in}/0_daily_eval_input/{AIME_MODEL}",
        "output_split": "0_daily_eval_output",
    })
    return specs


def walk_leaves(node, names, ids):
    """Yield (leaf, path names, path ids) without the synthetic root node."""
    if (node.get("level") or 0) == 0:
        child_names, child_ids = names, ids
    else:
        child_names = names + [node.get("name") or "未命名"]
        child_ids = ids + [node.get("id") or ""]
    children = node.get("children") or []
    if not children and (node.get("samples") is not None or (node.get("level") or 0) >= 3):
        yield node, child_names, child_ids
    for child in children:
        yield from walk_leaves(child, child_names, child_ids)


def leaf_payload(leaf, names, ids):
    return {
        "id": leaf.get("id") or "",
        "name": leaf.get("name") or "未命名",
        "path": names,
        "ids": ids,
        "level": leaf.get("level") or 3,
        "items": leaf.get("count") or 0,
        "sessions": leaf.get("sessions") or 0,
        "tags": leaf.get("tags") or [],
    }


def collect_candidates(specs):
    candidates = []
    sources = []
    for spec in specs:
        if not os.path.exists(spec["tree"]):
            sources.append({
                "model": spec["model"], "split": spec["split"], "available": False,
            })
            continue
        with open(spec["tree"]) as fh:
            raw = json.load(fh)
        meta = raw.get("meta") or {}
        sources.append({
            "model": spec["model"],
            "split": spec["split"],
            "available": True,
            "generated_at": meta.get("generated_at"),
            "pipeline_version": meta.get("pipeline_version"),
            "total_sessions": meta.get("total_sessions"),
            "total_items": meta.get("total_items"),
        })
        for leaf, names, ids in walk_leaves(raw.get("tree") or {}, [], []):
            payload = leaf_payload(leaf, names, ids)
            for sample in leaf.get("samples") or []:
                turn_index, problem_index = parse_json_path(sample.get("json_path"))
                turn_index = sample.get("turn_index", turn_index)
                problem_index = sample.get("problem_index", problem_index)
                case_id = sample.get("case_id") or sample.get("trace_id")
                if not case_id:
                    continue
                src_date = file_date(sample.get("src_file"))
                candidates.append({
                    "product": spec["product"],
                    "model": spec["model"],
                    "split": spec["split"],
                    "spec": spec,
                    "leaf": payload,
                    "date": src_date or sample.get("date"),
                    "session_date": sample.get("date"),
                    "case_id": case_id,
                    "session_id": sample.get("session_id"),
                    "trace_id": sample.get("trace_id") or case_id,
                    "src_file": sample.get("src_file") or "",
                    "src_line": sample.get("src_line"),
                    "json_path": sample.get("json_path") or "",
                    "turn_index": turn_index,
                    "problem_index": problem_index,
                    "attribution_component": sample.get("component") or "未标注",
                    "attribution_label": sample.get("label") or "",
                    "definition": sample.get("definition") or "",
                    "severity": None,
                    "component": sample.get("component") or "未标注",
                    "_record": None,
                    "_problem": None,
                    "_turn": None,
                    "_pi": None,
                })
    return candidates, sources


# ------------------------------------------------------------- output records

def fetch_records(path, wanted):
    """Parse only the wanted 1-based line numbers of one JSONL file."""
    wanted = {int(n) for n in wanted if n}
    if not wanted or not os.path.exists(path):
        return {}
    last = max(wanted)
    out = {}
    with open(path, encoding="utf-8", errors="replace") as fh:
        for line_no, line in enumerate(fh, 1):
            if line_no in wanted:
                try:
                    out[line_no] = json.loads(line)
                except json.JSONDecodeError:
                    out[line_no] = None
            if line_no >= last:
                break
    return out


def locate_problem(record, candidate):
    """Return (turn index, problem index, problem) verified by label."""
    turns = record.get("turns") or []
    turn_index = candidate["turn_index"]
    if 0 <= turn_index < len(turns):
        problems = turns[turn_index].get("problem") or []
        problem_index = candidate["problem_index"]
        if 0 <= problem_index < len(problems):
            problem = problems[problem_index]
            if same_label(problem.get("label"), candidate["attribution_label"]):
                return turn_index, problem_index, problem
    # Rare stale src_line: fall back to the label (still a real record).
    for ti, turn in enumerate(turns):
        for pi, problem in enumerate(turn.get("problem") or []):
            if same_label(problem.get("label"), candidate["attribution_label"]):
                return ti, pi, problem
    return None


def hydrate(candidates, product):
    """Resolve output records + the selected problem for candidates."""
    by_file = collections.defaultdict(set)
    for candidate in candidates:
        path = os.path.join(candidate["spec"]["outdir"], os.path.basename(candidate["src_file"]))
        candidate["_path"] = path
        if candidate["src_line"]:
            by_file[path].add(candidate["src_line"])
    cache = {}
    for path, lines in by_file.items():
        for line_no, record in fetch_records(path, lines).items():
            cache[(path, line_no)] = record
    kept = []
    for candidate in candidates:
        record = cache.get((candidate.get("_path"), candidate["src_line"]))
        if record is None:
            continue
        located = locate_problem(record, candidate)
        if located is None:
            continue
        turn_index, problem_index, problem = located
        candidate["_record"] = record
        candidate["_turn"] = turn_index
        candidate["_pi"] = problem_index
        candidate["_problem"] = problem
        candidate["component"] = problem.get("component") or candidate["attribution_component"]
        if product == "aime" and problem.get("severity"):
            candidate["severity"] = problem["severity"]
        kept.append(candidate)
    return kept


# ------------------------------------------------------------------- selection

def selection_key(candidate, model_order):
    model = candidate["model"]
    rank = model_order.index(model) if model in model_order else len(model_order)
    return (
        rank,
        -candidate["leaf"]["items"],
        candidate["date"] or "",
        candidate["case_id"],
        candidate["_pi"] if candidate["_pi"] is not None else 0,
    )


def pick(candidates, target, model_order, severity_aware=False):
    """Greedy, deterministic coverage: severity -> component -> leaf -> fill."""
    selected = []
    used_cases = set()
    used_leaves = set()

    def take(candidate):
        if candidate["case_id"] in used_cases:
            return False
        selected.append(candidate)
        used_cases.add(candidate["case_id"])
        used_leaves.add((candidate["model"], candidate["leaf"]["id"]))
        return True

    ordered = sorted(candidates, key=lambda c: selection_key(c, model_order))

    if severity_aware:
        buckets = {sev: [c for c in ordered if c.get("severity") == sev] for sev in ("P0", "P3", "P1", "P2")}
        quotas = {"P0": 3, "P3": 2, "P1": 2, "P2": 2}
        for sev, quota in quotas.items():
            picked = 0
            for candidate in buckets[sev]:
                if picked >= quota or len(selected) >= target:
                    break
                if candidate["case_id"] not in used_cases:
                    take(candidate)
                    picked += 1

    component_counts = collections.Counter(candidate["component"] for candidate in ordered)
    for component, _ in component_counts.most_common(6):
        if len(selected) >= target:
            break
        if any(candidate["component"] == component for candidate in selected):
            continue
        for candidate in ordered:
            if candidate["component"] == component and candidate["case_id"] not in used_cases:
                take(candidate)
                break
        if len(selected) >= target:
            break

    leaf_queues = collections.OrderedDict()
    for model in model_order:
        groups = collections.OrderedDict()
        for candidate in ordered:
            if candidate["model"] == model:
                groups.setdefault(candidate["leaf"]["id"], []).append(candidate)
        if groups:
            leaf_queues[model] = list(groups.items())

    index = {model: 0 for model in leaf_queues}
    while len(selected) < target:
        progressed = False
        for model, queue in leaf_queues.items():
            while index[model] < len(queue):
                leaf_id, pool = queue[index[model]]
                index[model] += 1
                if (model, leaf_id) in used_leaves:
                    continue
                for candidate in pool:
                    if candidate["case_id"] not in used_cases:
                        take(candidate)
                        progressed = True
                        break
                break
            if len(selected) >= target:
                break
        if not progressed:
            break

    while len(selected) < target:
        progressed = False
        for model, queue in leaf_queues.items():
            for leaf_id, pool in queue:
                for candidate in pool:
                    if candidate["case_id"] not in used_cases:
                        take(candidate)
                        progressed = True
                        break
                if progressed:
                    break
            if len(selected) >= target or progressed:
                break
        if not progressed:
            break

    return selected


def select_samples(product, candidates, limit):
    if product == "wencai":
        return pick(candidates, limit, WENCAI_MODELS)

    lost = [c for c in candidates if c["split"] == "lost"]
    daily = [c for c in candidates if c["split"] == "daily"]
    if lost and daily and limit > 1:
        lost_target = min(len(lost), max(1, round(limit * 0.65)))
        daily_target = max(1, limit - lost_target)
        return (
            pick(lost, lost_target, [AIME_MODEL], severity_aware=True)
            + pick(daily, daily_target, [AIME_MODEL])
        )
    pool = lost or daily
    return pick(pool, limit, [AIME_MODEL], severity_aware=bool(lost))


# ------------------------------------------------------------------- trimming

def trim_problem(problem, turn_index, problem_index, selected):
    raw_evidence = [item for item in (problem.get("evidence") or []) if isinstance(item, dict)]
    evidence = []
    for item in raw_evidence[: 5 if selected else 1]:
        quote = item.get("quote") or ""
        evidence.append({
            "position": clip(item.get("position"), 300),
            "component": clip(item.get("component"), 120),
            "quote": clip(quote, EVIDENCE_CHARS),
            "reason": clip(item.get("reason"), 300),
            "quote_truncated": len(quote) > EVIDENCE_CHARS,
        })
    return {
        "problem_id": problem.get("problem_id") or "",
        "turn_index": turn_index,
        "problem_index": problem_index,
        "component": problem.get("component") or "未标注",
        "label": problem.get("label") or "",
        "definition": clip(problem.get("definition"), 300 if selected else 200),
        "problem_phenomena": clip(problem.get("problem_phenomena"), 500 if selected else 300),
        "reason": clip(problem.get("reason"), 500 if selected else 300),
        "severity": problem.get("severity"),
        "severity_reason": clip(problem.get("severity_reason"), 300 if selected else 200),
        "selected": selected,
        "evidence_count": len(raw_evidence),
        "evidence": evidence,
    }


def usage_of(meta):
    meta = meta or {}
    usage = meta.get("usage") or {}
    input_tokens = usage.get("input_tokens")
    if input_tokens is None:
        input_tokens = meta.get("input_tokens")
    output_tokens = usage.get("output_tokens")
    if output_tokens is None:
        output_tokens = meta.get("output_tokens")
    total = usage.get("total_tokens")
    if total is None:
        total = meta.get("total_tokens")
    if total is None and (input_tokens is not None or output_tokens is not None):
        total = (input_tokens or 0) + (output_tokens or 0)
    return {
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "total_tokens": total,
    }


def latency_ms(meta):
    meta = meta or {}
    for key in ("finish_answer_time_cost", "total_duration_ms"):
        if meta.get(key):
            return meta[key]
    if meta.get("latency"):
        return meta["latency"] * 1000
    return None


META_KEYS = [
    "trace_id", "session_id", "case_id", "thread_id", "question", "question_zh",
    "timestamp", "request_time", "source", "agent_mode", "mode", "model",
    "skill_name", "language", "n_messages", "tool_count", "answer_len", "ok",
    "status_code", "task", "subtask", "difficulty", "turn_index", "outcome",
    "rued", "comefrom", "input_type",
]


def trim_meta(meta):
    meta = meta or {}
    out = {}
    for key in META_KEYS:
        value = meta.get(key)
        if value is None or value == "":
            continue
        out[key] = clip(value, 600) if isinstance(value, str) else value
    return out


def trim_tools(meta):
    tools = (meta or {}).get("tools") or []
    out = []
    for item in tools[:20]:
        if not isinstance(item, dict):
            continue
        out.append({
            "name": item.get("name") or "",
            "type": item.get("type") or "",
            "description": clip(item.get("description"), 180),
        })
    if not out:
        names = (meta or {}).get("tool_names_text") or ""
        for name in str(names).split(",")[:20]:
            name = name.strip()
            if name:
                out.append({"name": name})
    return out


def fit_budget(messages, budget):
    fields = []
    total = 0
    for message in messages:
        for key in ("text", "output", "arguments", "summary"):
            value = message.get(key)
            if isinstance(value, str):
                total += len(value.encode("utf-8"))
                fields.append((message, key))
    truncated = False
    while total > budget and fields:
        fields.sort(key=lambda item: len(item[0][item[1]].encode("utf-8")), reverse=True)
        message, key = fields[0]
        current = message[key]
        if len(current) <= 200:
            break
        replacement = current[: max(160, len(current) // 2)] + "…"
        total -= len(current.encode("utf-8")) - len(replacement.encode("utf-8"))
        message[key] = replacement
        message["truncated"] = True
        truncated = True
    return truncated


# --------------------------------------------------------------- input join

def normalize_wencai_input(record, wanted_id):
    meta = record.get("meta") or {}
    session = record.get("session_meta") or meta
    messages = []

    def push(item):
        if not messages or messages[-1] != item:
            messages.append(item)

    for message in record.get("messages") or []:
        kind = message.get("type")
        if kind == "reasoning":
            push({"type": "reasoning", "summary": clip(block_text(message.get("summary")), REASONING_CHARS)})
        elif kind == "function_call":
            push({
                "type": "function_call",
                "name": message.get("name") or "",
                "arguments": clip(json_text(message.get("arguments")), 2000),
                "call_id": message.get("call_id"),
            })
        elif kind == "function_call_output":
            push({
                "type": "function_call_output",
                "output": clip(block_text(message.get("output")), TOOL_CHARS),
                "call_id": message.get("call_id"),
            })
        elif kind == "message" or message.get("content") is not None:
            role = message.get("role") or "assistant"
            limit = SYSTEM_CHARS if role == "system" else MESSAGE_CHARS
            push({"role": role, "type": "text", "text": clip(block_text(message.get("content")), limit)})
        else:
            text = block_text(message.get("text") or message.get("output"))
            if text:
                push({"role": message.get("role") or "assistant", "type": "text", "text": clip(text, TOOL_CHARS)})
    truncated = fit_budget(messages, INPUT_BUDGET)
    usage = usage_of(session)
    stats = {
        "n_messages": session.get("n_messages") or len(messages),
        "n_messages_captured": len(messages),
        "tool_count": session.get("tool_count"),
        "input_tokens": usage["input_tokens"],
        "output_tokens": usage["output_tokens"],
        "total_tokens": usage["total_tokens"],
    }
    return {
        "trace_id": record.get("trace_id") or meta.get("trace_id") or wanted_id,
        "case_id": record.get("case_id"),
        "session_id": session.get("session_id"),
        "meta": trim_meta(meta),
        "tools": trim_tools(meta),
        "messages": messages,
        "stats": stats,
        "truncated": truncated,
    }


def normalize_aime_input(record, trace):
    session_meta = record.get("meta") or {}
    trace_meta = (trace or {}).get("meta") or {}
    messages = []

    def push(item):
        if not messages or messages[-1] != item:
            messages.append(item)

    for message in (trace or {}).get("messages") or []:
        kind = message.get("type")
        if kind == "user_question":
            push({"role": "user", "type": "text", "text": clip(block_text(message.get("content")), MESSAGE_CHARS)})
        elif kind == "final_answer":
            push({"role": "assistant", "type": "text", "text": clip(block_text(message.get("content")), MESSAGE_CHARS)})
        elif kind == "llm_turn":
            text = block_text(message.get("output"))
            if text:
                push({"role": "assistant", "type": "text", "text": clip(text, MESSAGE_CHARS), "model": message.get("model")})
        elif kind == "tool_call":
            push({
                "type": "function_call",
                "name": message.get("name") or "",
                "arguments": clip(json_text(message.get("input")), 2000),
            })
        elif kind == "tool_result":
            push({
                "type": "function_call_output",
                "name": message.get("name") or "",
                "output": clip(block_text(message.get("output")), TOOL_CHARS),
            })
        elif "reason" in (kind or ""):
            push({"type": "reasoning", "summary": clip(block_text(message.get("content") or message.get("output")), REASONING_CHARS)})
        else:
            text = block_text(message.get("content") or message.get("output") or message.get("text"))
            if text:
                push({"type": "text", "text": clip(text, TOOL_CHARS)})
    truncated = fit_budget(messages, INPUT_BUDGET)
    usage = usage_of(trace_meta)
    if not usage["total_tokens"]:
        usage = usage_of(session_meta)
    stats = {
        "n_messages": trace_meta.get("n_messages") or len(messages),
        "n_messages_captured": len(messages),
        "tool_count": trace_meta.get("tool_count"),
        "input_tokens": usage["input_tokens"],
        "output_tokens": usage["output_tokens"],
        "total_tokens": usage["total_tokens"],
    }
    meta = dict(session_meta)
    meta.update({k: v for k, v in trace_meta.items() if v is not None})
    return {
        "trace_id": trace_meta.get("trace_id"),
        "case_id": record.get("case_id"),
        "session_id": session_meta.get("session_id") or trace_meta.get("session_id"),
        "meta": trim_meta(meta),
        "tools": trim_tools(trace_meta),
        "messages": messages,
        "stats": stats,
        "truncated": truncated,
    }


def record_ids(product, record):
    ids = set()
    for key in ("trace_id", "case_id"):
        if record.get(key):
            ids.add(str(record[key]))
    meta = record.get("meta") or record.get("session_meta") or {}
    for key in ("trace_id", "session_id", "case_id"):
        if meta.get(key):
            ids.add(str(meta[key]))
    if product == "aime":
        for trace in record.get("traces") or []:
            tid = (trace.get("meta") or {}).get("trace_id")
            if tid:
                ids.add(str(tid))
    return ids


def resolve_inputs(samples, datasets, max_input_mb):
    """Stream candidate input files once and attach the matching record."""
    pending = collections.defaultdict(dict)  # path -> id -> sample
    for sample in samples:
        spec = sample["_cand"]["spec"]
        date = sample["_cand"]["date"]
        if not date:
            sample["quality"]["input_missing"] = True
            sample["quality"]["input_missing_reason"] = "date_unknown"
            continue
        path = f"{spec['indir']}/{spec['model']}-{date}_input.jsonl"
        if not os.path.exists(path):
            sample["quality"]["input_missing"] = True
            sample["quality"]["input_missing_reason"] = "input_file_missing"
            continue
        size_mb = os.path.getsize(path) / (1024 * 1024)
        if size_mb > max_input_mb:
            sample["quality"]["input_missing"] = True
            sample["quality"]["input_missing_reason"] = f"input_file_too_large:{size_mb:.0f}MB"
            continue
        for value in (sample["trace_id"], sample["case_id"], sample["session_id"]):
            if value:
                pending[path][str(value)] = sample

    for path, idmap in pending.items():
        remaining = {key.encode("utf-8"): sample for key, sample in idmap.items()}
        product = next(iter(idmap.values()))["product"]
        try:
            fh = open(path, "rb")
        except OSError:
            for sample in {id(sample): sample for sample in idmap.values()}.values():
                sample["quality"]["input_missing"] = True
                sample["quality"]["input_missing_reason"] = "input_open_failed"
            continue
        with fh:
            for raw in fh:
                if not any(key in raw for key in remaining):
                    continue
                try:
                    record = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                hits = record_ids(product, record) & {key.decode("utf-8") for key in remaining}
                if not hits:
                    continue
                matched_samples = {id(idmap[key]): idmap[key] for key in hits if key in idmap}
                for sample in matched_samples.values():
                    if product == "wencai":
                        normalized = normalize_wencai_input(record, sample["trace_id"])
                    else:
                        target_trace = None
                        for trace in record.get("traces") or []:
                            if (trace.get("meta") or {}).get("trace_id") in hits:
                                target_trace = trace
                                break
                        if target_trace is None and (record.get("traces") or []):
                            target_trace = record["traces"][0]
                        normalized = normalize_aime_input(record, target_trace)
                    sample["input"] = normalized
                    if not sample["output"]["metrics"].get("answer_len"):
                        for message in reversed(normalized.get("messages") or []):
                            if message.get("role") == "assistant" and message.get("text"):
                                sample["output"]["metrics"]["answer_len"] = len(message["text"])
                                break
                    sample["quality"]["input_missing"] = False
                    for key, owner in list(remaining.items()):
                        if owner is sample:
                            del remaining[key]
                if not remaining:
                    break
        for sample in {id(sample): sample for sample in remaining.values()}.values():
            sample["quality"]["input_missing_reason"] = "input_id_not_found"
    return samples


# --------------------------------------------------------------- sample build

def ordered_unique(values):
    seen = set()
    out = []
    for value in values:
        if value and value not in seen:
            seen.add(value)
            out.append(value)
    return out


def build_sample(candidate):
    record = candidate["_record"]
    turns = record.get("turns") or []
    turn_index = candidate["_turn"]
    selected_turn = turns[turn_index] if 0 <= turn_index < len(turns) else {}
    selected_turn_meta = selected_turn.get("meta") or {}

    problems = []
    flat = 0
    selected_flat = None
    for ti, turn in enumerate(turns):
        for pi, problem in enumerate(turn.get("problem") or []):
            is_selected = ti == turn_index and pi == candidate["_pi"]
            problems.append(trim_problem(problem, ti, pi, is_selected))
            if is_selected:
                selected_flat = flat
            flat += 1
    if selected_flat is None:
        selected_flat = candidate["_pi"] or 0

    components = ordered_unique(problem.get("component") for problem in problems)
    severities = [s for s in SEVERITY_ORDER if any(p.get("severity") == s for p in problems)]

    session_meta = record.get("session_meta") or {}
    question = (
        session_meta.get("question")
        or selected_turn_meta.get("question_zh")
        or selected_turn_meta.get("question")
        or (candidate.get("input") or {}).get("meta", {}).get("question")
        or ""
    )
    usage = usage_of(selected_turn_meta)
    if not usage["total_tokens"]:
        usage = usage_of(session_meta)
    duration = latency_ms(selected_turn_meta)
    if duration is None:
        duration = latency_ms(session_meta)
    latency_s = round(duration / 1000.0, 1) if duration else 0

    output = {
        "summary": clip(selected_turn.get("summary"), 600),
        "session_summary": clip(record.get("session_summary"), 1000),
        "is_correct": selected_turn.get("is_correct"),
        "correct_reason": clip(selected_turn.get("correct_reason"), 400),
        "problems": problems,
        "turns": [
            {
                "index": ti,
                "summary": clip(turn.get("summary"), 240),
                "is_correct": turn.get("is_correct"),
                "correct_reason": clip(turn.get("correct_reason"), 300),
                "n_problems": len(turn.get("problem") or []),
            }
            for ti, turn in enumerate(turns)
        ],
        "metrics": {
            "tokens": usage["total_tokens"],
            "p50": latency_s,
            "answer_len": selected_turn_meta.get("answer_len") or session_meta.get("answer_len"),
            "duration_ms": round(duration) if duration else None,
        },
    }

    leaf = candidate["leaf"]
    sample = {
        "id": ":".join([
            candidate["product"], candidate["model"], candidate["split"],
            candidate["date"] or "?", candidate["case_id"], f"p{selected_flat}",
        ]),
        "product": candidate["product"],
        "case_id": candidate["case_id"],
        "session_id": session_meta.get("session_id") or selected_turn_meta.get("session_id") or candidate["session_id"],
        "trace_id": selected_turn_meta.get("trace_id") or session_meta.get("trace_id") or candidate["trace_id"],
        "date": candidate["date"],
        "session_date": candidate.get("session_date"),
        "model": candidate["model"],
        "model_id": candidate["model"],
        "split": candidate["split"],
        "question": clip(question, 1000),
        "cluster": {
            "id": leaf["id"],
            "name": leaf["name"],
            "path": leaf["path"],
            "ids": leaf["ids"],
            "level": leaf["level"],
            "items": leaf["items"],
            "sessions": leaf["sessions"],
            "tags": leaf["tags"],
        },
        "components": components,
        "severities": severities,
        "labels": ordered_unique(problem.get("label") for problem in problems),
        "problem_count": len(problems),
        "summary": clip(record.get("session_summary"), 240),
        "is_correct": selected_turn.get("is_correct"),
        "input": None,
        "output": output,
        "quality": {
            "input_missing": True,
            "input_missing_reason": None,
            "cluster_missing": False,
            "selected_problem_index": selected_flat,
            "selected_turn_index": turn_index,
            "severity_missing": not bool(severities),
        },
        "_cand": candidate,
    }
    return sample


def build_product(product, samples, label, sources, candidates):
    components = collections.Counter()
    severities = collections.Counter()
    clusters = collections.Counter()
    models = collections.Counter()
    dates = collections.Counter()
    labels = collections.Counter()
    cluster_map = {}
    for sample in samples:
        for component in sample["components"]:
            components[component] += 1
        for severity in sample["severities"]:
            severities[severity] += 1
        models[sample["model"]] += 1
        dates[sample["date"] or "未知"] += 1
        if sample["cluster"]:
            clusters[sample["cluster"]["id"]] += 1
            entry = cluster_map.setdefault(sample["cluster"]["id"], {
                "name": sample["cluster"]["name"],
                "path": sample["cluster"]["path"],
                "ids": sample["cluster"]["ids"],
                "items": 0,
                "samples": 0,
            })
            entry["items"] += sample["cluster"]["items"]
            entry["samples"] += 1
        for problem in sample["output"]["problems"]:
            if problem.get("label"):
                labels[problem["label"]] += 1

    def sorted_counts(counter):
        return dict(sorted(counter.items(), key=lambda kv: (-kv[1], kv[0])))

    product_sources = [s for s in sources if s.get("available")]
    generated = [s.get("generated_at") for s in product_sources if s.get("generated_at")]
    versions = sorted({s.get("pipeline_version") for s in product_sources if s.get("pipeline_version")})
    return {
        "label": label,
        "total": len(samples),
        "models": sorted(models),
        "severity_available": bool(severities),
        "clusters": cluster_map,
        "cluster_meta": {
            "generated_at": max(generated) if generated else None,
            "pipeline_version": versions[0] if len(versions) == 1 else (versions or None),
            "sources": product_sources,
        },
        "facets": {
            "components": sorted_counts(components),
            "severities": {s: severities.get(s, 0) for s in SEVERITY_ORDER if severities.get(s)},
            "clusters": sorted_counts(clusters),
            "models": sorted_counts(models),
            "dates": sorted_counts(dates),
            "labels": [{"name": name, "value": n} for name, n in labels.most_common(30)],
        },
        "selection": {
            "candidates": len(candidates),
            "candidate_cases": len({c["case_id"] for c in candidates}),
            "selected": len(samples),
        },
        "samples": samples,
    }


# --------------------------------------------------------------------- writing

def write_payload(payload, out_path):
    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    text = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    # Keep the payload inert if it is ever embedded in HTML.
    text = text.replace("<", "\\u003c").replace(">", "\\u003e").replace("&", "\\u0026")
    data = text.encode("utf-8")
    tmp = out_path + ".tmp"
    with open(tmp, "wb") as fh:
        fh.write(data)
    os.replace(tmp, out_path)
    gz_tmp = out_path + ".gz.tmp"
    with gzip.open(gz_tmp, "wb", compresslevel=6) as fh:
        fh.write(data)
    os.replace(gz_tmp, out_path + ".gz")
    return len(data), os.path.getsize(out_path + ".gz")


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    parser = argparse.ArgumentParser(description="Build samples.json from cluster trees + eval records")
    parser.add_argument("--datasets", default=DATASETS, help="datasets root (default: server data root)")
    parser.add_argument("--out", default=os.path.join(here, "static", "samples.json"))
    parser.add_argument("--limit", type=int, default=24, help="max samples per product")
    parser.add_argument("--product", choices=["all", "wencai", "aime"], default="all")
    parser.add_argument("--max-input-mb", type=int, default=700, help="skip input files larger than this")
    args = parser.parse_args()

    products = ["wencai", "aime"] if args.product == "all" else [args.product]
    specs = cluster_specs(args.datasets)
    all_candidates = {}
    sources_by_product = collections.defaultdict(list)
    for product in products:
        candidates, sources = collect_candidates([s for s in specs if s["product"] == product])
        all_candidates[product] = candidates
        sources_by_product[product].extend(sources)

    payload = {
        "generated_at": now_iso(),
        "is_demo": False,
        "schema_version": 1,
        "products": {},
    }
    summary = {}
    for product in products:
        candidates = all_candidates[product]
        hydrated = hydrate(candidates, product)
        selected = select_samples(product, hydrated, args.limit)
        samples = [build_sample(candidate) for candidate in selected]
        resolve_inputs(samples, args.datasets, args.max_input_mb)
        for sample in samples:
            sample.pop("_cand", None)
        by = collections.Counter(s["split"] for s in samples)
        payload["products"][product] = build_product(
            product, samples, "问财" if product == "wencai" else "AIME",
            sources_by_product[product], candidates,
        )
        summary[product] = {
            "candidates": len(candidates),
            "hydrated": len(hydrated),
            "samples": len(samples),
            "split": dict(by),
            "input_missing": sum(1 for s in samples if s["quality"]["input_missing"]),
            "components": len(payload["products"][product]["facets"]["components"]),
            "severities": payload["products"][product]["facets"]["severities"],
            "clusters": len(payload["products"][product]["facets"]["clusters"]),
        }

    total = sum(len(p["samples"]) for p in payload["products"].values())
    payload["totals"] = {"samples": total, **{k: v["samples"] for k, v in summary.items()}}

    all_dates = sorted({
        sample["date"]
        for product in payload["products"].values()
        for sample in product["samples"]
        if sample.get("date")
    })
    latest = all_dates[-1] if all_dates else None
    expected = (datetime.now(TZ) - timedelta(days=1)).date().isoformat()
    cluster_generated = sorted({
        product["cluster_meta"]["generated_at"]
        for product in payload["products"].values()
        if product["cluster_meta"].get("generated_at")
    })
    versions = sorted({
        str(product["cluster_meta"].get("pipeline_version"))
        for product in payload["products"].values()
        if product["cluster_meta"].get("pipeline_version")
    })
    payload["freshness"] = {
        "as_of": payload["generated_at"],
        "expected_date": expected,
        "latest_sample_date": latest,
        "stale": bool(latest and latest < expected),
        "reason": (
            f"样本覆盖至 {latest}，预期日更批次 {expected} 缺失"
            if latest and latest < expected else ""
        ),
        "cluster_generated_at": cluster_generated[-1] if cluster_generated else None,
        "cluster_pipeline_version": versions[0] if len(versions) == 1 else (versions or None),
        "date_coverage": {
            product: sorted({s["date"] for s in data["samples"] if s.get("date")})
            for product, data in payload["products"].items()
        },
        "note": "样本来自现有归因/聚类快照；缺失的输入/聚类不补造，逐条记录在 quality 字段。",
    }

    size, gz_size = write_payload(payload, args.out)
    print(json.dumps({
        "out": args.out,
        "bytes": size,
        "gzip_bytes": gz_size,
        "total_samples": total,
        "products": summary,
    }, ensure_ascii=False))
    if size > 3 * 1024 * 1024:
        print(f"WARNING: samples.json is {size / 1048576:.2f} MB (> 3 MB target)", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
