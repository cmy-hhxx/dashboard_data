#!/usr/bin/env python3
"""Derive the after-retest scope for an ab_test round from the retest artifacts.

The retest runner re-pushes each fixed-set question and writes the new trace, the
attribution and the cluster tree.  It does not carry the fixed set's ``eq_index``, so the
scope's contract files (``coverage_after_release_retest.csv``, the attribution ``_eq_``
suffix, the slice's target ``trace_id``) have to be derived here.

Mapping rule (deterministic, append-stable):

* a retest trace's question is the first ``role=user`` message of its first ``llm_turn``
  in the published input (``99_provenance/retest_input/*.slim.jsonl`` or
  ``03_after_release_retest/inputs/*.jsonl``);
* questions are canonicalised (str as-is, list/dict as sorted JSON, python-repr parsed) so
  structured questions match even when one side stores them as text;
* target rows with the same canonical question are ordered by ``eq``, retest traces by
  ``(request_time, trace_id)``; the i-th trace maps to the i-th row.  Extras (retries beyond
  the number of target rows with that question) stay unpaired.

When a question appears in several target rows the choice of row is ambiguous: the question
is identical, only the baseline trace differs.  The pairing is therefore order-based, not
identity-based; see ``ambiguous_groups`` in the printed report.

Outputs (all rewritten atomically, safe to re-run as the retest appends rows):

* ``00_manifest/coverage_after_release_retest.csv``
* ``03_after_release_retest/attribution/<model>/<batch>/<model>_attribution-mapped.jsonl``
  (raw attribution rows with ``_eq_%05d`` appended to ``session_meta.case_id``)
* ``03_after_release_retest/cluster_tree/<model>/item_index.slice.jsonl`` (``trace_id`` is
  the target trace, ``retest_trace_id`` keeps the retest trace)
* the ``2_after_retest`` block of ``00_manifest/scope_summary.json``

Usage::

    python3 scripts/ab_after_coverage.py --round /path/to/<n>_version<v>_test
    python3 scripts/ab_after_coverage.py --round ... --dry-run
"""
from __future__ import annotations

import argparse
import ast
import csv
import io
import json
import os
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

SCOPE_AFTER = "03_after_release_retest"
INPUT_DIRS = ("99_provenance/retest_input", f"{SCOPE_AFTER}/inputs")
COVERAGE_NAME = "coverage_after_release_retest.csv"
MAPPED_SUFFIX = "_attribution-mapped.jsonl"
STAMP_RE = re.compile(r"^\[\d{4}-\d{2}-\d{2}[^\]]*\]\s*")
STATE_MAPPED = "已重测_有归因"
STATE_MISSING = "未重测_批次无该题"


def canonical_question(value):
    """Stable text for a question, whichever type the source used.

    Target rows store a string or a list of prompt blocks; the retest input stores the
    rendered text, sometimes as a python ``repr`` of the same list.  Both end up as the
    same sorted-JSON string.
    """
    if value is None:
        return ""
    if isinstance(value, (list, dict)):
        return json.dumps(value, ensure_ascii=False, sort_keys=True)
    if not isinstance(value, str):
        return str(value).strip()
    text = value.strip()
    if not text:
        return ""
    if text[:1] in "[{":
        parsed = None
        try:
            parsed = json.loads(text)
        except ValueError:
            try:
                parsed = ast.literal_eval(text)
            except (ValueError, SyntaxError):
                parsed = None
        if isinstance(parsed, (list, dict)):
            return json.dumps(parsed, ensure_ascii=False, sort_keys=True)
        if isinstance(parsed, str):
            return parsed.strip()
    return text


def _inner_messages(message):
    """``input_messages`` is a dict (tools+messages) in the published rows, a list in some."""
    inner = message.get("input_messages")
    if isinstance(inner, dict):
        return inner.get("messages") or []
    if isinstance(inner, list):
        return inner
    return []


def input_question(line):
    """First user message of the trace's first ``llm_turn`` in a slim input row."""
    traces = line.get("traces") or []
    for trace in traces:
        for message in trace.get("messages") or []:
            if message.get("type") != "llm_turn":
                continue
            for item in _inner_messages(message):
                if isinstance(item, dict) and item.get("role") == "user":
                    return canonical_question(STAMP_RE.sub("", str(item.get("content") or ""), count=1))
    for trace in traces:
        for message in trace.get("messages") or []:
            if not isinstance(message, dict):
                continue
            if message.get("type") == "user_question" or message.get("role") == "user":
                return canonical_question(STAMP_RE.sub("", str(message.get("content") or ""), count=1))
    return ""


def read_jsonl(path: Path):
    with open(path, encoding="utf-8") as fh:
        for raw in fh:
            raw = raw.strip()
            if not raw:
                continue
            try:
                yield json.loads(raw)
            except ValueError:
                continue


def write_atomic(path: Path, text: str):
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)


def attribution_rows(round_dir: Path):
    """Raw attribution rows, ignoring files this script writes."""
    base = round_dir / SCOPE_AFTER / "attribution"
    rows = []
    if not base.is_dir():
        return rows
    for path in sorted(p for p in base.rglob("*.jsonl") if p.is_file()):
        if path.name.endswith(MAPPED_SUFFIX):
            continue
        for row in read_jsonl(path):
            if isinstance(row, dict):
                rows.append(row)
    return rows


def trace_question_map(round_dir: Path, extra: Path | None = None):
    """retest trace -> canonical question, from the slim inputs and an optional extract."""
    questions = {}
    for rel in INPUT_DIRS:
        base = round_dir / rel
        if not base.is_dir():
            continue
        for path in sorted(p for p in base.rglob("*.jsonl") if p.is_file()):
            for row in read_jsonl(path):
                meta = row.get("meta") or {}
                trace = str(meta.get("trace_id") or "")
                if trace and trace not in questions:
                    questions[trace] = input_question(row)
    if extra and extra.is_file():
        for row in read_jsonl(extra):
            trace = str(row.get("trace_id") or "")
            if trace and trace not in questions:
                questions[trace] = canonical_question(row.get("q"))
    return questions


def cluster_index(round_dir: Path, model: str):
    """Raw items plus retest trace -> (sorted unique paths, labels, item count)."""
    path = round_dir / SCOPE_AFTER / "cluster_tree" / model / "item_index.jsonl"
    items = list(read_jsonl(path)) if path.is_file() else []
    grouped = defaultdict(list)
    for item in items:
        trace = str(item.get("trace_id") or "")
        leaf = item.get("path")
        if trace and leaf:
            grouped[trace].append((leaf, str(item.get("label") or "")))
    summary = {}
    for trace, rows in grouped.items():
        labels = {}
        for leaf, label in rows:
            if leaf not in labels or (not labels[leaf] and label):
                labels[leaf] = label
        ordered = sorted(labels)
        summary[trace] = (ordered, [labels[leaf] for leaf in ordered], len(rows))
    return summary, items


def problem_count(row):
    total = 0
    for turn in row.get("turns") or []:
        total += len(turn.get("problem") or [])
    return total


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--round", required=True, type=Path, help="ab_test round directory")
    parser.add_argument("--model", default="aime_expert")
    parser.add_argument("--extra-questions", type=Path,
                        help="trace_id/question extract for inputs not copied yet")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)
    round_dir = args.round.resolve()

    targets = list(read_jsonl(round_dir / "01_targets" / "questions.jsonl"))
    if not targets:
        print(f"no targets under {round_dir}", file=sys.stderr)
        return 2
    target_q = [canonical_question(row.get("question")) for row in targets]

    # An identical question is one item: keep only its newest target row.  Comparing two
    # copies of the same question would only compare different baseline traces.
    retained = {}
    for eq, question in enumerate(target_q, 1):
        stamp = str(targets[eq - 1].get("question_time") or "")
        key = (stamp, eq)
        if question not in retained or key > retained[question][0]:
            retained[question] = (key, eq)
    eqs_by_question = {question: eq for question, (_key, eq) in retained.items()}
    dropped_targets = len(targets) - len(eqs_by_question)

    questions = trace_question_map(round_dir, args.extra_questions)
    attribution = attribution_rows(round_dir)
    attr_by_trace = {}
    for row in attribution:
        trace = str((row.get("session_meta") or {}).get("trace_id") or "")
        if trace:
            attr_by_trace[trace] = row

    # Retries of the same question collapse to the newest retest trace.
    latest_trace = {}
    for trace, question in questions.items():
        if trace not in attr_by_trace or question not in eqs_by_question:
            continue
        meta = attr_by_trace[trace].get("session_meta") or {}
        key = (str(meta.get("request_time") or ""), trace)
        if question not in latest_trace or key > latest_trace[question][0]:
            latest_trace[question] = (key, trace)

    eq_to_trace = {eqs_by_question[question]: trace
                   for question, (_key, trace) in latest_trace.items()}
    dropped_traces = len(questions) - 0  # informational; real duplicates counted below
    seen_per_question = Counter(q for q in questions.values())
    dropped_traces = sum(1 for t, q in questions.items()
                         if t in attr_by_trace and q in eqs_by_question
                         and latest_trace.get(q, ("", ""))[1] != t)

    path_summary, items = cluster_index(round_dir, args.model)
    mapped_traces = {trace: eq for eq, trace in eq_to_trace.items()}

    coverage_rows = []
    states = Counter()
    keep_eqs = set(eqs_by_question.values())
    for eq, target in enumerate(targets, 1):
        if eq not in keep_eqs:
            continue
        trace = eq_to_trace.get(eq)
        if trace is None:
            state = STATE_MISSING
            rows = []
        else:
            state = STATE_MAPPED
            rows = path_summary.get(trace)
        states[state] += 1
        if rows:
            leaves, labels, n_items = rows
            cls_n_items = n_items
            cls_paths = ";".join(leaves)
            cls_labels = ";".join(label for label in labels if label)
        else:
            cls_n_items = 0
            cls_paths = ""
            cls_labels = ""
        coverage_rows.append({
            "trace_id": str(target.get("trace_id") or ""),
            "eq_index": eq,
            "retest_state": state,
            "n_problem": problem_count(attr_by_trace[trace]) if trace else 0,
            "retest_session_id": trace or "",
            "cls_n_items": cls_n_items,
            "cls_paths": cls_paths,
            "cls_labels": cls_labels,
        })

    # ---- derived attribution: append the eq to the case id -------------------------------
    mapped_lines = []
    batch_dirs = set()
    for eq in sorted(eq_to_trace):
        trace = eq_to_trace[eq]
        row = json.loads(json.dumps(attr_by_trace[trace], ensure_ascii=False))
        meta = row.setdefault("session_meta", {})
        base_case = str(meta.get("case_id") or trace)
        if not re.search(r"_eq_\d+$", base_case):
            meta["case_id"] = f"{base_case}_eq_{eq:05d}"
        mapped_lines.append(json.dumps(row, ensure_ascii=False) + "\n")

    # ---- slice: target trace_id + retest_trace_id ---------------------------------------
    slice_lines = []
    for item in items:
        item = dict(item)
        retest = str(item.get("trace_id") or "")
        eq = mapped_traces.get(retest)
        if eq is not None:
            item["retest_trace_id"] = retest
            item["trace_id"] = str(targets[eq - 1].get("trace_id") or retest)
        else:
            item["retest_trace_id"] = retest
        slice_lines.append(json.dumps(item, ensure_ascii=False) + "\n")

    # ---- scope summary ------------------------------------------------------------------
    scope_path = round_dir / "00_manifest" / "scope_summary.json"
    summary = {}
    if scope_path.is_file():
        try:
            summary = json.loads(scope_path.read_text(encoding="utf-8"))
        except ValueError:
            summary = {}
    scope = (summary.get("scopes") or {}).get("2_after_retest") or {}
    with_problem = sum(1 for row in coverage_rows
                       if row["retest_state"] == STATE_MAPPED and row["n_problem"])
    without_problem = sum(1 for row in coverage_rows
                          if row["retest_state"] == STATE_MAPPED and not row["n_problem"])
    scope.update({
        "unique_questions": len(eqs_by_question),
        "retest_records": len(attribution),
        "expected_traces": len(targets),
        "published_attribution_records": len(attribution),
        "tree_dir": f"{SCOPE_AFTER}/cluster_tree",
        "coverage_file": COVERAGE_NAME,
        "landing": sum(1 for row in coverage_rows if row["retest_state"] == STATE_MAPPED),
        "evaluated_without_problem": without_problem,
        "coverage": {
            "有落点": with_problem,
            "无落点_判无问题": without_problem,
            "未评测": len(targets) - with_problem - without_problem,
        },
    })
    summary.setdefault("scopes", {})["2_after_retest"] = scope

    # ---- write ---------------------------------------------------------------------------
    coverage_path = round_dir / "00_manifest" / COVERAGE_NAME
    header = ["trace_id", "eq_index", "retest_state", "n_problem", "retest_session_id",
              "cls_n_items", "cls_paths", "cls_labels"]
    sink = io.StringIO()
    writer = csv.DictWriter(sink, fieldnames=header, lineterminator="\n")
    writer.writeheader()
    writer.writerows(coverage_rows)
    coverage_text = sink.getvalue()

    attr_dir = round_dir / SCOPE_AFTER / "attribution" / args.model
    batch_dir = None
    base = round_dir / SCOPE_AFTER / "attribution"
    if base.is_dir():
        for candidate in sorted(p for p in base.rglob("*.jsonl")
                                if p.is_file() and not p.name.endswith(MAPPED_SUFFIX)):
            batch_dir = candidate.parent
            break
    if batch_dir is None:
        batch_dir = attr_dir / "retest"
    mapped_path = batch_dir / (args.model + MAPPED_SUFFIX)
    slice_path = round_dir / SCOPE_AFTER / "cluster_tree" / args.model / "item_index.slice.jsonl"

    report = {
        "targets": len(targets),
        "unique_questions": len(eqs_by_question),
        "dropped_duplicate_targets": dropped_targets,
        "inputs": len(questions),
        "attribution": len(attribution),
        "mapped": len(eq_to_trace),
        "dropped_retry_traces": dropped_traces,
        "states": dict(states),
    }
    print(json.dumps(report, ensure_ascii=False))
    if args.dry_run:
        return 0

    write_atomic(coverage_path, coverage_text)
    mapped_path.parent.mkdir(parents=True, exist_ok=True)
    write_atomic(mapped_path, "".join(mapped_lines))
    slice_path.parent.mkdir(parents=True, exist_ok=True)
    write_atomic(slice_path, "".join(slice_lines))
    write_atomic(scope_path, json.dumps(summary, ensure_ascii=False, indent=1) + "\n")
    print(f"wrote {coverage_path}")
    print(f"wrote {mapped_path} ({len(mapped_lines)} rows)")
    print(f"wrote {slice_path} ({len(slice_lines)} rows)")
    print(f"wrote {scope_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
