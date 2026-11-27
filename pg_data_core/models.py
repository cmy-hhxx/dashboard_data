"""Domain parsing, normalization, user rules, intent mapping, and human_read delta codec.

Kept strictly aligned with live 5001 (`dashboard/build.py`, `user_rules.py`,
`human_read_overlay.py`) and live 5003 (`analysis_api/store.py`, `taxonomy.py`)
so PG views and Data Core reads achieve 100% parity with zero metric drift.
"""

from __future__ import annotations

import hashlib
import json
import re
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import unquote
from zoneinfo import ZoneInfo

NY_TZ = ZoneInfo("America/New_York")
NUMERIC_RE = re.compile(r"^\d+$")
SPACES_RE = re.compile(r"[\s\u3000]+")
PUNCT_RE = re.compile(r"[，。！？；：、·…—\-－（）()\[\]【】《》\"'“”‘’,.!?;:]+")
SEVERITY_ORDER = ("P0", "P1", "P2", "P3", "P4")
SEVERITY_RANK = {"P0": 0, "P1": 1, "P2": 2, "P3": 3, "P4": 4, "GOLD": 5}
MODEL_SUFFIX = {"aime_expert": "expert", "aime_fast": "fast"}

ATTR_PROBLEM_HR_FIELDS = ("label", "problem_phenomena", "reason", "severity_reason")
COMPACT_HR_SPECS = (
    ("plans", "content"),
    ("reasoning_chain", "content"),
    ("execution_chain", "content"),
    ("reflections", "reflection_content"),
    ("tool_errors", "tool_error_content"),
    ("artifacts", "artifacts_content"),
    ("components", "components_content"),
)


def to_text(value: Any) -> str | None:
    if value is None or isinstance(value, str):
        return value
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return str(value)
    if isinstance(value, list):
        parts = []
        for item in value:
            if isinstance(item, dict) and ("header" in item or "selected" in item):
                picked = item.get("selected")
                picked_str = "、".join(map(str, picked)) if isinstance(picked, list) else (to_text(picked) or "")
                parts.append(f"{item.get('header') or ''}：{picked_str}".strip("："))
            else:
                parts.append(to_text(item) or "")
        return "；".join(p for p in parts if p) or None
    return json.dumps(value, ensure_ascii=False)


def clean_str(value: Any) -> str | None:
    s = to_text(value)
    return (s or "").strip() or None


def decode_question(value: Any) -> str | None:
    s = to_text(value)
    if s and "%" in s:
        try:
            return unquote(s)
        except Exception:
            return s
    return s


def normalize_question(question: str | None) -> str:
    if not question:
        return ""
    text = SPACES_RE.sub("", str(question).lower())
    return PUNCT_RE.sub("", text)[:300]


def question_hash(question: str | None) -> str | None:
    norm = normalize_question(question)
    if not norm:
        return None
    return hashlib.sha1(norm.encode("utf-8")).hexdigest()[:16]


def parse_timestamp(value: Any) -> datetime | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        ts = float(value)
        if ts > 1e12:
            ts /= 1000.0
        try:
            return datetime.fromtimestamp(ts, tz=timezone.utc)
        except (OverflowError, OSError, ValueError):
            return None
    s = str(value).strip()
    if not s:
        return None
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(s)
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    except ValueError:
        for fmt in ("%Y-%m-%d %H:%M:%S.%f", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d"):
            try:
                return datetime.strptime(s[:26], fmt).replace(tzinfo=timezone.utc)
            except ValueError:
                continue
        return None


def ny_biz_day(dt: datetime | None, fallback_day: str | None = None) -> date:
    if dt is not None:
        return dt.astimezone(NY_TZ).date()
    if fallback_day:
        try:
            return date.fromisoformat(fallback_day[:10])
        except ValueError:
            pass
    return date(1970, 1, 1)


def parse_severity(value: Any) -> str | None:
    s = (value or "").strip().upper() if isinstance(value, str) else ""
    return s if s in SEVERITY_ORDER else None


def parse_tri_bool(value: Any) -> bool | None:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        t = value.strip().lower()
        if t in ("true", "1", "yes"):
            return True
        if t in ("false", "0", "no"):
            return False
    return None


def compute_severity_summary(problems: list[dict[str, Any]]) -> tuple[str, bool, int, int, int, int, int]:
    counts = {"P0": 0, "P1": 0, "P2": 0, "P3": 0, "P4": 0}
    best_rank = SEVERITY_RANK["GOLD"]
    best = "GOLD"
    for p in problems:
        sev = parse_severity(p.get("severity"))
        if sev:
            counts[sev] += 1
            if SEVERITY_RANK[sev] < best_rank:
                best_rank = SEVERITY_RANK[sev]
                best = sev
    is_gold = len(problems) == 0
    if not is_gold and best == "GOLD":
        best = "P4"
    return best, is_gold, counts["P0"], counts["P1"], counts["P2"], counts["P3"], counts["P4"]


def split_cluster_code(code: str | None) -> tuple[str | None, str | None, str | None, str | None]:
    """Split `S9.M5.1.3` -> `('S9', 'S9.M5', 'S9.M5.1', 'S9.M5.1.3')`."""
    if not code:
        return None, None, None, None
    parts = [p for p in str(code).strip().split(".") if p]
    l1 = parts[0] if len(parts) >= 1 else None
    l2 = ".".join(parts[:2]) if len(parts) >= 2 else None
    l3 = ".".join(parts[:3]) if len(parts) >= 3 else None
    l4 = ".".join(parts[:4]) if len(parts) >= 4 else None
    return l1, l2, l3, l4


def compute_app_version(model_dir: str, meta: dict[str, Any]) -> str:
    suffix = MODEL_SUFFIX.get(model_dir, model_dir)
    raw_model = clean_str(meta.get("model")) or model_dir
    if raw_model.endswith(f"_{suffix}"):
        return raw_model
    return f"{raw_model}_{suffix}"


def to_int_or_none(value: Any) -> int | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        try:
            return int(float(value))
        except (TypeError, ValueError):
            return None


def to_float_or_none(value: Any) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        v = float(value)
        return v if v == v else None  # guard NaN
    except (TypeError, ValueError):
        return None


class UserRules:
    """Exact mirror of `dashboard/user_rules.py` classification logic."""

    def __init__(self, data: dict[str, Any] | None = None):
        data = data if isinstance(data, dict) else {}
        self.internal_ids, self.internal_patterns = self._section(data, "internal")
        self.test_ids, self.test_patterns = self._section(data, "test")
        self.real_ids, self.real_patterns = self._section(data, "real")
        self.lost_ids, self.lost_patterns = self._section(data, "lost")
        heur = data.get("heuristics") if isinstance(data.get("heuristics"), dict) else {}
        if "real_user_id_max_digits" in heur:
            self.max_digits = int(heur["real_user_id_max_digits"])
        elif "numeric_test_min_digits" in heur:
            self.max_digits = int(heur["numeric_test_min_digits"]) - 1
        else:
            self.max_digits = 10

    @staticmethod
    def _section(data: dict[str, Any], name: str) -> tuple[set[str], list[re.Pattern[str]]]:
        sec = data.get(name) if isinstance(data.get(name), dict) else {}
        ids = {str(x).strip() for x in (sec.get("ids") or []) if x not in (None, "")}
        pats = []
        for pat in sec.get("patterns") or []:
            try:
                pats.append(re.compile(str(pat)))
            except re.error:
                continue
        return ids, pats

    @staticmethod
    def _hit(ids: set[str], pats: list[re.Pattern[str]], uid: str) -> bool:
        return uid in ids or any(p.search(uid) for p in pats)

    def is_lost(self, uid: Any) -> bool:
        if uid in (None, ""):
            return False
        return self._hit(self.lost_ids, self.lost_patterns, str(uid).strip())

    def classify(self, uid: Any) -> tuple[str, bool, bool]:
        """Return `(user_type, is_real, is_lost)`."""
        if uid in (None, ""):
            return "unknown", False, False
        s = str(uid).strip()
        if not s:
            return "unknown", False, False
        lost = self.is_lost(s)
        if self._hit(self.test_ids, self.test_patterns, s):
            return "test", False, lost
        if self._hit(self.internal_ids, self.internal_patterns, s):
            return "internal", False, lost
        if self._hit(self.real_ids, self.real_patterns, s):
            return "real", True, lost
        if NUMERIC_RE.match(s) and len(s) <= self.max_digits:
            return "real", True, lost
        return "test", False, lost

    def signature(self) -> str:
        canonical = {
            "internal": sorted(self.internal_ids),
            "internal_patterns": [p.pattern for p in self.internal_patterns],
            "test": sorted(self.test_ids),
            "test_patterns": [p.pattern for p in self.test_patterns],
            "lost": sorted(self.lost_ids),
            "lost_patterns": [p.pattern for p in self.lost_patterns],
            "real": sorted(self.real_ids),
            "real_patterns": [p.pattern for p in self.real_patterns],
            "heuristics": {"real_user_id_max_digits": self.max_digits},
        }
        raw = json.dumps(canonical, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:16]

    @classmethod
    def from_file(cls, path: Path) -> "UserRules":
        if not path.is_file():
            return cls({})
        try:
            return cls(json.loads(path.read_text(encoding="utf-8")))
        except (OSError, ValueError):
            return cls({})


class IntentTaxonomy:
    """Financial intent taxonomy v1.9 resolver (matches 5003 `store._resolve_intent`)."""

    def __init__(self, doc: dict[str, Any]):
        self.version = str(doc.get("version") or "2026-11")
        self.nodes: dict[str, dict[str, Any]] = {n["code"]: n for n in doc.get("nodes") or []}
        self.by_pair: dict[tuple[str, str], str] = {}
        self.by_label: dict[tuple[int, str], str] = {}
        for node in self.nodes.values():
            lvl = int(node.get("level", 1))
            lbl = str(node.get("label") or "")
            code = str(node["code"])
            self.by_label.setdefault((lvl, lbl), code)
            parent = node.get("parent_code")
            if lvl == 2 and parent and parent in self.nodes:
                plbl = str(self.nodes[parent].get("label") or "")
                self.by_pair.setdefault((plbl, lbl), code)

    @classmethod
    def from_file(cls, path: Path) -> "IntentTaxonomy":
        return cls(json.loads(path.read_text(encoding="utf-8")))

    def resolve(self, raw_task: str | None, raw_subtask: str | None) -> tuple[str | None, str | None, str | None, str | None]:
        """Return `(intent_code, canonical_task, canonical_subtask, taxonomy_version)`."""
        t = clean_str(raw_task)
        st = clean_str(raw_subtask)
        if not t and not st:
            return None, None, None, None
        code = self.by_pair.get((t, st)) if (t and st) else None
        if code is None and st:
            code = self.by_label.get((2, st))
        if code is None and t:
            code = self.by_label.get((1, t))
        if code is None:
            # Old taxonomy label (e.g. Sept v1) — keep raw task/subtask with taxonomy_version='v1'
            return None, t, st, "v1"
        node = self.nodes[code]
        if int(node.get("level", 1)) == 2 and node.get("parent_code") in self.nodes:
            parent_lbl = self.nodes[node["parent_code"]]["label"]
            return code, parent_lbl, node["label"], "v1.9"
        return code, node["label"], None, "v1.9"


def extract_human_read_delta(
    hr_record: dict[str, Any],
    target_kind: str,
    *,
    trace_id: str,
    model: str,
    biz_day: str,
) -> tuple[dict[str, Any], list[str] | None, str]:
    """Extract ONLY translated delta fields from a human_read record (never mirrors full raw line).

    Returns `(delta_payload, hr_labels, hr_hash)`.
    """
    hr_meta = hr_record.get("_human_read") if isinstance(hr_record.get("_human_read"), dict) else {}
    if target_kind == "attribution":
        turns_delta = []
        hr_labels: list[str] = []
        for idx, t in enumerate(hr_record.get("turns") or []):
            if not isinstance(t, dict):
                continue
            probs_delta = []
            for p in t.get("problem") or []:
                if not isinstance(p, dict):
                    continue
                pd = {f: p.get(f) for f in ATTR_PROBLEM_HR_FIELDS if p.get(f) is not None}
                probs_delta.append(pd)
                hr_labels.append(str(p.get("label") or ""))
            turns_delta.append(
                {
                    "turn_index": idx,
                    "summary": t.get("summary"),
                    "problem": probs_delta,
                }
            )
        sp_delta = []
        for p in hr_record.get("session_problem") or []:
            if not isinstance(p, dict):
                continue
            pd = {f: p.get(f) for f in ATTR_PROBLEM_HR_FIELDS if p.get(f) is not None}
            sp_delta.append(pd)
            hr_labels.append(str(p.get("label") or ""))
        delta = {
            "target_kind": "attribution",
            "model": model,
            "biz_day": biz_day,
            "trace_id": trace_id,
            "_human_read": hr_meta,
            "session_summary": hr_record.get("session_summary"),
            "turns": turns_delta,
            "session_problem": sp_delta,
        }
        raw_fp = json.dumps(
            {
                "session_summary": delta["session_summary"],
                "turns": turns_delta,
                "session_problem": sp_delta,
            },
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
        hr_hash = hashlib.sha256(raw_fp).hexdigest()[:16]
        return delta, hr_labels, hr_hash

    # compact delta
    turns_delta = []
    for idx, t in enumerate(hr_record.get("turns") or []):
        if not isinstance(t, dict):
            continue
        td: dict[str, Any] = {"turn_index": idx}
        for list_key, text_key in COMPACT_HR_SPECS:
            items = t.get(list_key)
            if isinstance(items, list) and items:
                td[list_key] = [
                    it.get(text_key) if isinstance(it, dict) else None
                    for it in items
                ]
        turns_delta.append(td)
    delta = {
        "target_kind": "compact",
        "model": model,
        "biz_day": biz_day,
        "trace_id": trace_id,
        "_human_read": hr_meta,
        "turns": turns_delta,
    }
    raw_fp = json.dumps(turns_delta, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    hr_hash = hashlib.sha256(raw_fp).hexdigest()[:16]
    return delta, None, hr_hash


def apply_human_read_delta(raw_record: dict[str, Any], delta: dict[str, Any], target_kind: str) -> dict[str, Any]:
    """Overlay delta-only translated fields back onto a raw attribution or compact record."""
    out = json.loads(json.dumps(raw_record, ensure_ascii=False))
    out["_human_read"] = delta.get("_human_read") or {}
    if target_kind == "attribution":
        if delta.get("session_summary") is not None:
            out["session_summary"] = delta["session_summary"]
        raw_turns = out.get("turns") or []
        for td in delta.get("turns") or []:
            tidx = int(td.get("turn_index", 0))
            if tidx >= len(raw_turns) or not isinstance(raw_turns[tidx], dict):
                continue
            rt = raw_turns[tidx]
            if td.get("summary") is not None:
                rt["summary"] = td["summary"]
            rprobs = rt.get("problem") or []
            for pidx, pd in enumerate(td.get("problem") or []):
                if pidx < len(rprobs) and isinstance(rprobs[pidx], dict) and isinstance(pd, dict):
                    for f in ATTR_PROBLEM_HR_FIELDS:
                        if pd.get(f) is not None:
                            rprobs[pidx][f] = pd[f]
        rsprobs = out.get("session_problem") or []
        for pidx, pd in enumerate(delta.get("session_problem") or []):
            if pidx < len(rsprobs) and isinstance(rsprobs[pidx], dict) and isinstance(pd, dict):
                for f in ATTR_PROBLEM_HR_FIELDS:
                    if pd.get(f) is not None:
                        rsprobs[pidx][f] = pd[f]
        return out

    # compact overlay
    raw_turns = out.get("turns") or []
    for td in delta.get("turns") or []:
        tidx = int(td.get("turn_index", 0))
        if tidx >= len(raw_turns) or not isinstance(raw_turns[tidx], dict):
            continue
        rt = raw_turns[tidx]
        for list_key, text_key in COMPACT_HR_SPECS:
            texts = td.get(list_key)
            ritems = rt.get(list_key)
            if isinstance(texts, list) and isinstance(ritems, list):
                for idx, txt in enumerate(texts):
                    if idx < len(ritems) and isinstance(ritems[idx], dict) and txt is not None:
                        ritems[idx][text_key] = txt
    return out


def extract_input_fields(
    record: dict[str, Any],
    model: str,
    *,
    fallback_day: str | None = None,
    intent_tax: IntentTaxonomy | None = None,
    source: str = "prelaunch",
) -> dict[str, Any]:
    """Parse a raw daily `eval_input` JSONL record into canonical `eval_inputs` fields."""
    meta = record.get("meta") if isinstance(record.get("meta"), dict) else {}
    traces = record.get("traces") if isinstance(record.get("traces"), list) else []
    t0 = traces[0] if traces and isinstance(traces[0], dict) else {}
    t0_meta = t0.get("meta") if isinstance(t0.get("meta"), dict) else {}

    trace_id = (
        clean_str(record.get("trace_id"))
        or clean_str(meta.get("trace_id"))
        or clean_str(t0_meta.get("trace_id"))
        or clean_str(t0.get("trace_id"))
        or clean_str(meta.get("lf_trace_id"))
        or ""
    )
    session_id = clean_str(meta.get("session_id")) or clean_str(t0_meta.get("session_id")) or ""
    user_id = clean_str(meta.get("user_id")) or clean_str(t0_meta.get("user_id")) or ""
    req_dt = (
        parse_timestamp(t0_meta.get("timestamp"))
        or parse_timestamp(record.get("request_time"))
        or parse_timestamp(meta.get("request_time"))
        or parse_timestamp(meta.get("lf_start_time"))
    )
    biz_day = ny_biz_day(req_dt, fallback_day or clean_str(meta.get("trace_date")))

    q_text = decode_question(
        meta.get("question_text")
        or meta.get("question")
        or t0_meta.get("question_text")
        or t0_meta.get("question")
    )
    q_norm = normalize_question(q_text)
    q_hash = question_hash(q_text)

    # Messages, tools, tokens, latency
    n_messages = to_int_or_none(meta.get("n_messages")) or to_int_or_none(t0_meta.get("n_messages"))
    if n_messages is None:
        msgs = t0.get("messages")
        n_messages = len(msgs) if isinstance(msgs, list) else 0
    n_obs = to_int_or_none(meta.get("n_obs")) or to_int_or_none(t0_meta.get("n_observations")) or 0

    in_tok = to_int_or_none(meta.get("input_tokens")) or to_int_or_none(t0_meta.get("input_tokens"))
    out_tok = to_int_or_none(meta.get("output_tokens")) or to_int_or_none(t0_meta.get("output_tokens"))
    tot_tok = to_int_or_none(meta.get("total_tokens")) or to_int_or_none(t0_meta.get("total_tokens"))
    cache_tok = to_int_or_none(meta.get("cache_read_tokens")) or to_int_or_none(t0_meta.get("cache_read_tokens"))
    if tot_tok is None and (in_tok is not None or out_tok is not None):
        tot_tok = (in_tok or 0) + (out_tok or 0)

    tool_count = to_int_or_none(meta.get("tool_count"))
    if tool_count is None:
        tool_count = to_int_or_none(t0_meta.get("tool_count"))
    if tool_count is None:
        # Count tool calls from messages if present
        tc = 0
        for m in (t0.get("messages") or []) if isinstance(t0.get("messages"), list) else []:
            if isinstance(m, dict):
                tcalls = m.get("tool_calls")
                if isinstance(tcalls, list):
                    tc += len(tcalls)
                elif m.get("role") == "tool":
                    pass
        tool_count = tc

    latency_ms = to_float_or_none(meta.get("latency_ms"))
    if latency_ms is None:
        lat_sec = to_float_or_none(meta.get("latency")) or to_float_or_none(t0_meta.get("latency"))
        if lat_sec is not None:
            latency_ms = lat_sec * 1000.0 if lat_sec < 10000.0 else lat_sec
        else:
            st = parse_timestamp(meta.get("lf_start_time"))
            et = parse_timestamp(meta.get("lf_end_time"))
            if st and et and et >= st:
                latency_ms = (et - st).total_seconds() * 1000.0

    turn_index = to_int_or_none(meta.get("turn_index")) or to_int_or_none(t0_meta.get("turn_index")) or 0
    session_round = to_int_or_none(meta.get("session_round")) or max(1, turn_index + 1)
    is_multi_turn = session_round > 1 or turn_index > 0 or len(traces) > 1

    raw_task = clean_str(meta.get("task_category") or meta.get("task") or t0_meta.get("task_category"))
    raw_sub = clean_str(meta.get("subtask_category") or meta.get("subtask") or t0_meta.get("subtask_category"))
    if intent_tax is not None:
        intent_code, task_cat, sub_cat, tax_ver = intent_tax.resolve(raw_task, raw_sub)
    else:
        intent_code, task_cat, sub_cat, tax_ver = None, raw_task, raw_sub, clean_str(meta.get("taxonomy_version"))

    # Preserve explicit taxonomy_version from meta if resolution marked v1
    explicit_tv = clean_str(meta.get("taxonomy_version"))
    if explicit_tv and not tax_ver:
        tax_ver = explicit_tv

    cat_status = "done" if (task_cat or sub_cat) else "pending"
    app_version = compute_app_version(model, t0_meta if t0_meta.get("model") else meta)

    return {
        "product": "aime",
        "model": model,
        "trace_id": trace_id,
        "session_id": session_id,
        "user_id": user_id,
        "source": source,
        "app_version": app_version,
        "runtime_mode": clean_str(meta.get("runtime_mode") or t0_meta.get("runtime_mode")),
        "agent_id": clean_str(meta.get("agent_id") or t0_meta.get("agent_id")),
        "batch_id": clean_str(record.get("batch_id") or meta.get("batch_id")),
        "case_id": clean_str(record.get("case_id") or meta.get("case_id")),
        "request_time": req_dt,
        "biz_day": biz_day,
        "turn_index": turn_index,
        "session_round": session_round,
        "is_multi_turn": is_multi_turn,
        "question_text": q_text,
        "question_norm": q_norm,
        "question_hash": q_hash,
        "n_messages": n_messages or 0,
        "n_observations": n_obs or 0,
        "total_tokens": tot_tok,
        "input_tokens": in_tok,
        "output_tokens": out_tok,
        "cache_read_tokens": cache_tok,
        "tool_count": tool_count or 0,
        "latency_ms": latency_ms,
        "answer_len": to_int_or_none(meta.get("answer_len")),
        "has_visual": bool(meta.get("has_visual")),
        "visual_count": to_int_or_none(meta.get("visual_count")) or 0,
        "task_category": task_cat,
        "subtask_category": sub_cat,
        "intent_code": intent_code,
        "taxonomy_version": tax_ver,
        "category_status": cat_status,
    }


def extract_attribution_fields(
    record: dict[str, Any],
    model: str,
    *,
    fallback_day: str | None = None,
    intent_tax: IntentTaxonomy | None = None,
) -> list[dict[str, Any]]:
    """Parse one attribution JSONL record into per-trace output + problem rows.

    Matches `analysis_api/store.py`: cross-turn `session_problem` attaches to
    the last turn with `scope='session'`.
    """
    smeta = record.get("session_meta") if isinstance(record.get("session_meta"), dict) else {}
    turns = record.get("turns") if isinstance(record.get("turns"), list) else []
    session_problems = record.get("session_problem") if isinstance(record.get("session_problem"), list) else []
    sess_id = clean_str(smeta.get("session_id") or smeta.get("thread_id")) or ""
    question = decode_question(smeta.get("question") or smeta.get("question_text"))
    results: list[dict[str, Any]] = []

    for turn_index, turn in enumerate(turns):
        if not isinstance(turn, dict):
            continue
        meta = turn.get("meta") if isinstance(turn.get("meta"), dict) else {}
        trace_id = clean_str(meta.get("trace_id") or smeta.get("trace_id") or record.get("trace_id"))
        if not trace_id:
            continue
        t_sess_id = sess_id or clean_str(meta.get("session_id")) or ""
        t_user_id = clean_str(meta.get("user_id") or smeta.get("user_id")) or ""
        req_dt = parse_timestamp(meta.get("timestamp")) or parse_timestamp(smeta.get("request_time"))
        eval_dt = parse_timestamp(meta.get("evaluated_at"))
        biz_day = ny_biz_day(req_dt, fallback_day)
        app_version = compute_app_version(model, meta if meta.get("model") else smeta)

        raw_task = clean_str(
            meta.get("task") or meta.get("task_category") or smeta.get("task") or smeta.get("task_category")
        )
        raw_sub = clean_str(
            meta.get("subtask") or meta.get("subtask_category") or smeta.get("subtask") or smeta.get("subtask_category")
        )
        if intent_tax is not None:
            intent_code, task_cat, sub_cat, tax_ver = intent_tax.resolve(raw_task, raw_sub)
        else:
            intent_code, task_cat, sub_cat, tax_ver = None, raw_task, raw_sub, None

        t_probs = [p for p in (turn.get("problem") or []) if isinstance(p, dict)]
        s_probs = [p for p in session_problems if isinstance(p, dict)] if (turn_index == len(turns) - 1) else []

        problem_rows: list[dict[str, Any]] = []
        all_probs: list[dict[str, Any]] = []
        for idx, prob in enumerate(t_probs):
            all_probs.append(prob)
            ev = prob.get("evidence")
            ev_list = ev if isinstance(ev, list) else []
            located = sum(1 for e in ev_list if isinstance(e, dict) and (e.get("evidence_id") is not None or e.get("message_index") is not None))
            problem_rows.append(
                {
                    "scope": "turn",
                    "turn_index": turn_index,
                    "problem_index": idx,
                    "severity": parse_severity(prob.get("severity")),
                    "component": clean_str(prob.get("component")),
                    "component_family": clean_str(prob.get("component_family") or prob.get("component")),
                    "component_role": clean_str(prob.get("component_role")),
                    "label": clean_str(prob.get("label")),
                    "evidence_count": len(ev_list),
                    "located_count": located,
                }
            )
        for idx, prob in enumerate(s_probs):
            all_probs.append(prob)
            ev = prob.get("evidence")
            ev_list = ev if isinstance(ev, list) else []
            located = sum(1 for e in ev_list if isinstance(e, dict) and (e.get("evidence_id") is not None or e.get("message_index") is not None))
            problem_rows.append(
                {
                    "scope": "session",
                    "turn_index": turn_index,
                    "problem_index": idx,
                    "severity": parse_severity(prob.get("severity")),
                    "component": clean_str(prob.get("component")),
                    "component_family": clean_str(prob.get("component_family") or prob.get("component")),
                    "component_role": clean_str(prob.get("component_role")),
                    "label": clean_str(prob.get("label")),
                    "evidence_count": len(ev_list),
                    "located_count": located,
                }
            )

        max_sev, is_gold, p0, p1, p2, p3, p4 = compute_severity_summary(all_probs)
        results.append(
            {
                "trace_id": trace_id,
                "session_id": t_sess_id,
                "user_id": t_user_id,
                "app_version": app_version,
                "request_time": req_dt,
                "biz_day": biz_day,
                "question_text": question,
                "evaluated_at": eval_dt,
                "evaluator_version": clean_str(smeta.get("evaluator_version") or meta.get("evaluator_version")) or "legacy",
                "judge_model": clean_str(meta.get("judge_model") or smeta.get("judge_model")),
                "max_severity": max_sev,
                "is_gold": is_gold,
                "p0_cnt": p0,
                "p1_cnt": p1,
                "p2_cnt": p2,
                "p3_cnt": p3,
                "p4_cnt": p4,
                "problem_count": len(problem_rows),
                "is_correct": parse_tri_bool(turn.get("is_correct")),
                "summary": clean_str(turn.get("summary")),
                "session_summary": clean_str(record.get("session_summary")),
                "n_messages": to_int_or_none(meta.get("n_messages")) or to_int_or_none(smeta.get("n_messages")) or 0,
                "task_category": task_cat,
                "subtask_category": sub_cat,
                "intent_code": intent_code,
                "taxonomy_version": tax_ver,
                "problems": problem_rows,
            }
        )
    return results
