"""内存快照、筛选与查询语义（/summary、/severity、/traces、/traces/batch、/traces/{id}）。"""

import json
import sqlite3
import threading
from collections import OrderedDict
from dataclasses import dataclass, field
from datetime import datetime, timezone

from . import config, cursors, errors, timeutil
from .taxonomy import Tree

GROUP_DIMS = ("intent", "problem", "day", "user", "app_version", "source")
LEVELS = ("top", "leaf", "children")
SORTS = ("traces", "users", "rate")


@dataclass(slots=True)
class Trace:
    trace_id: str
    day: str
    app_version: str
    asked_at: str | None
    source: str
    user_id: str | None
    question: str | None
    session_id: str | None
    intent_code: str | None
    task: str | None
    subtask: str | None
    problem_codes: tuple
    problem_count: int
    problems: tuple
    severity: dict
    is_correct: bool | None
    analysis_id: str
    analyzed_at: str | None
    file: str
    line: int
    offset: int


def _trace_order(trace):
    return (trace.asked_at or "", trace.trace_id)


class Snapshot:
    def __init__(self, traces, intent_tree, problem_trees, data_updated_at, build_summary=None):
        self.traces: list[Trace] = traces
        self.intent: Tree | None = intent_tree
        self.problem_trees: dict[str, Tree] = problem_trees
        self.data_updated_at = data_updated_at
        self.build_summary = build_summary or {}
        self.built_at = timeutil.utc_rfc3339(datetime.now(timezone.utc))
        # /traces 的固定顺序 (asked_at DESC, trace_id DESC)，排一次，筛选后保持
        traces.sort(key=_trace_order, reverse=True)
        self.by_id: dict[str, list[Trace]] = {}
        for trace in traces:
            self.by_id.setdefault(trace.trace_id, []).append(trace)

    # -- 版本 ---------------------------------------------------------
    def taxonomy_version(self) -> str:
        versions = {tree.version for tree in self.problem_trees.values()}
        if len(versions) == 1:
            return versions.pop()
        return "unknown"

    def taxonomy_versions(self) -> dict:
        return {
            "intent": self.intent.version if self.intent else None,
            "problem": {app: tree.version for app, tree in self.problem_trees.items()},
            "severity": config.SEVERITY_VERSION,
        }

    def tree_for(self, trace) -> Tree | None:
        return self.problem_trees.get(trace.app_version)


def _json_value(raw, fallback):
    try:
        return json.loads(raw) if raw else fallback
    except ValueError:
        return fallback


def load(conn, intent_tree, problem_trees, build_summary=None) -> Snapshot:
    rows = conn.execute(
        "SELECT trace_id, day, app_version, asked_at, source, user_id, question, session_id, intent_code, "
        "task, subtask, problem_codes, problem_count, problems, severity, is_correct, "
        "analysis_id, analyzed_at, file, line, offset FROM traces"
    ).fetchall()
    traces = []
    for row in rows:
        traces.append(
            Trace(
                trace_id=row[0],
                day=row[1],
                app_version=row[2],
                asked_at=row[3],
                source=row[4],
                user_id=row[5],
                question=row[6],
                session_id=row[7],
                intent_code=row[8],
                task=row[9],
                subtask=row[10],
                problem_codes=tuple(_json_value(row[11], [])),
                problem_count=row[12] or 0,
                problems=tuple(_json_value(row[13], [])),
                severity=dict(_json_value(row[14], {})),
                is_correct=None if row[15] is None else bool(row[15]),
                analysis_id=row[16],
                analyzed_at=row[17],
                file=row[18],
                line=row[19],
                offset=row[20] or 0,
            )
        )
    newest = max((t.analyzed_at for t in traces if t.analyzed_at), default=None)
    return Snapshot(traces, intent_tree, problem_trees, newest, build_summary)


# --------------------------------------------------------------------------- 筛选

@dataclass
class Filters:
    dataset: str
    source: tuple = ()
    start_day: str | None = None
    end_day: str | None = None
    intent: tuple = ()
    problem: tuple = ()
    severity: tuple = ()
    app_version: tuple = ()
    user_ids: frozenset | None = None
    taxonomy_version: str | None = None
    q: str | None = None
    echo: dict = field(default_factory=dict)

    def cache_key(self) -> str:
        payload = {
            "dataset": self.dataset,
            "source": list(self.source),
            "start_day": self.start_day,
            "end_day": self.end_day,
            "intent": list(self.intent),
            "problem": list(self.problem),
            "severity": list(self.severity),
            "app_version": list(self.app_version),
            "user_ids": sorted(self.user_ids) if self.user_ids else None,
            "taxonomy_version": self.taxonomy_version,
            "q": self.q,
        }
        return cursors.filter_hash(payload)


def parse_filters(params: dict, snap: Snapshot) -> Filters:
    dataset = (params.get("dataset") or "").strip()
    if not dataset:
        raise errors.invalid("缺少必填参数 dataset", "dataset")
    if dataset not in config.DATASET_ALIASES:
        raise errors.unknown_value("dataset", dataset, sorted(config.DATASET_ALIASES))

    sources = tuple(params.get("source") or ())
    allowed_sources = set(config.SOURCE_TO_SPLIT)
    for value in sources:
        if value not in allowed_sources:
            raise errors.unknown_value("source", value, sorted(allowed_sources))

    start_day = (params.get("start_day") or "").strip() or None
    end_day = (params.get("end_day") or "").strip() or None
    for name, value in (("start_day", start_day), ("end_day", end_day)):
        if value is not None:
            try:
                datetime.strptime(value, "%Y-%m-%d")
            except ValueError as exc:
                raise errors.invalid(f"{name} 必须是 YYYY-MM-DD", name) from exc
    if start_day and end_day and start_day > end_day:
        raise errors.invalid("start_day 不能晚于 end_day", "start_day")

    intent_codes = tuple(params.get("intent") or ())
    if intent_codes:
        if snap.intent is None:
            raise errors.unknown_codes("intent", intent_codes)
        unknown = [code for code in intent_codes if code not in snap.intent]
        if unknown:
            raise errors.unknown_codes("intent", unknown, snap.intent.version)

    problem_codes = tuple(params.get("problem") or ())
    if problem_codes:
        known = set()
        for tree in snap.problem_trees.values():
            known.update(tree.nodes)
        unknown = [code for code in problem_codes if code not in known]
        if unknown:
            raise errors.unknown_codes("problem", unknown, snap.taxonomy_version())

    severities = tuple(params.get("severity") or ())
    for value in severities:
        if value not in config.SEVERITIES:
            raise errors.unknown_value("severity", value, list(config.SEVERITIES))

    app_versions = tuple(params.get("app_version") or ())
    known_versions = set(snap.problem_trees)
    for value in app_versions:
        if value not in known_versions:
            raise errors.unknown_value("app_version", value, sorted(known_versions))

    user_ids = params.get("user_ids")
    user_set = frozenset(user_ids) if user_ids else None
    if user_set is not None and len(user_set) > config.MAX_USER_IDS:
        raise errors.too_many_ids("user_ids", config.MAX_USER_IDS, len(user_set))

    taxonomy_version = (params.get("taxonomy_version") or "").strip() or None
    if taxonomy_version:
        known = {snap.intent.version} if snap.intent else set()
        known.update({tree.version for tree in snap.problem_trees.values()})
        if taxonomy_version not in known:
            raise errors.not_found(f"分类版本 {taxonomy_version} 不存在", taxonomy_version=taxonomy_version)

    q = params.get("q")
    if q is not None:
        q = str(q)
        if len(q) > config.MAX_Q_CHARS:
            raise errors.invalid(f"q 最多 {config.MAX_Q_CHARS} 个字符", "q")
        q = q.strip() or None

    echo = {"dataset": dataset}
    if sources:
        echo["source"] = list(sources)
    if start_day:
        echo["start_day"] = start_day
    if end_day:
        echo["end_day"] = end_day
    if intent_codes:
        echo["intent"] = list(intent_codes)
    if problem_codes:
        echo["problem"] = list(problem_codes)
    if severities:
        echo["severity"] = list(severities)
    if app_versions:
        echo["app_version"] = list(app_versions)
    if user_set is not None:
        echo["user_ids"] = {"count": len(user_set), "sample": sorted(user_set)[:5]}
    if taxonomy_version:
        echo["taxonomy_version"] = taxonomy_version
    if q:
        echo["q"] = q

    return Filters(
        dataset=dataset,
        source=sources,
        start_day=start_day,
        end_day=end_day,
        intent=intent_codes,
        problem=problem_codes,
        severity=severities,
        app_version=app_versions,
        user_ids=user_set,
        taxonomy_version=taxonomy_version,
        q=q,
        echo=echo,
    )


# --------------------------------------------------------------------------- 匹配

class Matcher:
    """把筛选条件编译成可复用的集合，避免每条 trace 重复展开分类树。"""

    def __init__(self, snap: Snapshot, filters: Filters):
        self.filters = filters
        self.intent_codes = None
        if filters.intent:
            expanded = set()
            for code in filters.intent:
                expanded |= snap.intent.descendants(code)
            self.intent_codes = expanded

        self.problem_codes: dict[str, set] | None = None
        if filters.problem:
            per_version: dict[str, set] = {}
            for code in filters.problem:
                for app_version, tree in snap.problem_trees.items():
                    if code in tree:
                        per_version.setdefault(app_version, set()).update(tree.descendants(code))
            self.problem_codes = per_version
        self.severities = set(filters.severity) if filters.severity else None

        self.app_versions = set(filters.app_version) if filters.app_version else None
        self.sources = set(filters.source) if filters.source else None
        self.user_ids = filters.user_ids
        self.q = filters.q.lower() if filters.q else None

    def match(self, trace: Trace, with_problem: bool = True) -> bool:
        f = self.filters
        if f.start_day and (trace.day or "") < f.start_day:
            return False
        if f.end_day and (trace.day or "") > f.end_day:
            return False
        if self.sources and trace.source not in self.sources:
            return False
        if self.app_versions and trace.app_version not in self.app_versions:
            return False
        if self.user_ids is not None and trace.user_id not in self.user_ids:
            return False
        if self.intent_codes is not None:
            if trace.intent_code is None or trace.intent_code not in self.intent_codes:
                return False
        if self.q and self.q not in (trace.question or "").lower():
            return False
        if not with_problem:
            return True
        if self.severities is not None and not any(trace.severity.get(level) for level in self.severities):
            return False
        if self.problem_codes is not None:
            allowed = self.problem_codes.get(trace.app_version)
            if not allowed or not any(code in allowed for code in trace.problem_codes):
                return False
        return True


# --------------------------------------------------------------------------- 分组

def _sort_token(value):
    return "\x00" if value is None else str(value)


def _problem_group_value(snap: Snapshot, trace: Trace, problem, level, filters):
    """问题条目在 problem 维度上的分组值：top 归到环节、children 归到筛选值的下一层、leaf 用原编码。"""
    code = problem.get("code")
    tree = snap.tree_for(trace)
    if not code or tree is None:
        return None
    if level == "top":
        return tree.l1(code)
    if level == "children":
        return tree.child_below(filters.problem[0], code)
    return code


def _group_keys(snap: Snapshot, trace: Trace, dims, level, filters: Filters, with_problem=True):
    """返回该 trace 在给定维度上的 (分组键组合, 该组合对应的问题条目)。

    ``problem`` 维度按问题条目分组：同一条 trace 的不同条目会进不同组，
    没有问题的 trace 不进入任何 problem 分组。没有 problem 维度时条目为 None。
    """
    per_dim = []
    for dim in dims:
        if dim == "problem" and not with_problem:
            continue
        if dim == "problem":
            mapping: dict = {}
            for problem in trace.problems:
                value = _problem_group_value(snap, trace, problem, level, filters)
                mapping.setdefault(value, []).append(problem)
            per_dim.append((dim, list(mapping), mapping))
            continue
        if dim == "intent":
            code = trace.intent_code
            if code is None:
                values = [None]
            elif level == "top":
                values = [snap.intent.l1(code) if snap.intent else code]
            elif level == "children":
                values = [snap.intent.child_below(filters.intent[0], code) if snap.intent else None]
            else:
                values = [code]
        elif dim == "day":
            values = [trace.day]
        elif dim == "user":
            values = [trace.user_id or None]
        elif dim == "app_version":
            values = [trace.app_version]
        elif dim == "source":
            values = [trace.source]
        else:
            values = [None]
        per_dim.append((dim, values, None))

    combos = [((), None)]
    for dim, values, mapping in per_dim:
        expanded = []
        for combo, entries in combos:
            for value in values:
                expanded.append((combo + ((dim, value),), mapping[value] if mapping is not None else entries))
        combos = expanded
    return combos


def _validate_group(group_by, level, filters, allow_empty=False):
    if not group_by:
        if allow_empty:
            return
        raise errors.invalid("group_by 不能为空", "group_by")
    if len(group_by) > 2:
        raise errors.invalid("group_by 最多两个维度", "group_by")
    for dim in group_by:
        if dim not in GROUP_DIMS:
            raise errors.unknown_value("group_by", dim, list(GROUP_DIMS))
    if len(set(group_by)) != len(group_by):
        raise errors.invalid("group_by 不允许重复维度", "group_by")
    if level not in LEVELS:
        raise errors.unknown_value("level", level, list(LEVELS))
    if level == "children":
        for dim in group_by:
            if dim not in ("intent", "problem"):
                raise errors.invalid("level=children 只作用于 intent / problem 维度", "level")
            values = filters.intent if dim == "intent" else filters.problem
            if len(values) != 1:
                raise errors.invalid(
                    f"level=children 要求 {dim} 恰好筛一个编码", "level", dimension=dim
                )


def _group_row(keys, count, users, problem_traces, problems, analyzed):
    return {
        "keys": dict(keys),
        "analyzed": analyzed,
        "traces": count,
        "users": users,
        "problem_traces": problem_traces,
        "problems": problems,
    }


def _rate(row):
    if not row["analyzed"]:
        return None
    return row["traces"] / row["analyzed"]


def _sort_key_factory(group_by, sort):
    def sort_key(row):
        key_token = "|".join(f"{dim}={_sort_token(row['keys'].get(dim))}" for dim in group_by)
        if "day" in group_by:
            day = row["keys"].get("day")
            return (0 if day is None else 1, _sort_token(day), -row["traces"], key_token)
        if sort == "users":
            primary = -row["users"]
        elif sort == "problems":
            primary = -row["problems"]
        elif sort == "rate":
            rate = _rate(row)
            primary = -(rate if rate is not None else -1.0)
        else:
            primary = -row["traces"]
        return (primary, -row["traces"], key_token)

    return sort_key


def _page_rows(rows, group_by, level, sort, limit, cursor, kind, filter_key):
    sort_key = _sort_key_factory(group_by, sort)
    rows.sort(key=sort_key)
    if cursor:
        try:
            body = cursors.decode(cursor, kind, filter_key)
        except cursors.CursorError as exc:
            raise errors.cursor_expired(str(exc)) if exc.expired else errors.invalid(str(exc), "cursor")
        last = tuple(body.get("c") or ())
        rows = [row for row in rows if tuple(sort_key(row)) > last]
    page = rows[:limit]
    has_more = len(rows) > len(page)
    next_cursor = None
    if has_more and page:
        next_cursor = cursors.encode(kind, filter_key, limit, list(sort_key(page[-1])))
    return page, next_cursor, has_more


# --------------------------------------------------------------------------- /summary

def summary(snap: Snapshot, filters: Filters, group_by, level="top", sort=None, limit=100, cursor=None):
    _validate_group(group_by, level, filters)
    if limit < 1 or limit > 1000:
        raise errors.invalid("limit 必须在 1..1000 之间", "limit")
    if sort is None:
        sort = "day" if "day" in group_by else "traces"
    elif sort not in SORTS:
        raise errors.unknown_value("sort", sort, list(SORTS))

    matcher = Matcher(snap, filters)
    base = [t for t in snap.traces if matcher.match(t, with_problem=False)]
    selected = [t for t in base if matcher.match(t, with_problem=True)]

    total = {
        "analyzed": len(base),
        "traces": len(selected),
        "users": len({t.user_id for t in selected if t.user_id}),
        "problem_traces": sum(1 for t in selected if t.problem_count),
        "problems": sum(t.problem_count for t in selected),
    }

    stats: dict[tuple, dict] = {}
    for trace in selected:
        for combo, entries in _group_keys(snap, trace, group_by, level, filters, with_problem=True):
            bucket = stats.setdefault(combo, {"count": 0, "users": set(), "problem_traces": 0, "problems": 0})
            bucket["count"] += 1
            if trace.user_id:
                bucket["users"].add(trace.user_id)
            if entries is None:
                bucket["problems"] += trace.problem_count
                if trace.problem_count:
                    bucket["problem_traces"] += 1
            else:
                bucket["problems"] += len(entries)
                if entries:
                    bucket["problem_traces"] += 1

    # 分母：去掉 problem / severity 筛选后，其余筛选与分组键（不含 problem 维度）不变
    analyzed_map: dict[tuple, int] = {}
    for trace in base:
        for combo, _entries in _group_keys(snap, trace, group_by, level, filters, with_problem=False):
            analyzed_map[combo] = analyzed_map.get(combo, 0) + 1

    rows = []
    for combo, bucket in stats.items():
        analyzed_key = tuple(pair for pair in combo if pair[0] != "problem")
        analyzed = analyzed_map.get(analyzed_key, 0)
        rows.append(
            _group_row(
                combo,
                bucket["count"],
                len(bucket["users"]),
                bucket["problem_traces"],
                bucket["problems"],
                analyzed,
            )
        )

    filter_key = filters.cache_key() + "|" + ",".join(group_by) + "|" + level + "|" + sort
    page, next_cursor, has_more = _page_rows(
        rows, group_by, level, sort, limit, cursor, "summary", filter_key
    )
    return {
        "total": total,
        "groups": page,
        "next_cursor": next_cursor,
        "has_more": has_more,
    }


# --------------------------------------------------------------------------- /severity

def _severity_counts(entries_per_trace):
    """按问题条目统计 P0–P4：条目数，以及至少含一条该等级的 trace 数。"""
    problems = {level: 0 for level in config.SEVERITIES}
    traces_by_level = {level: 0 for level in config.SEVERITIES}
    unlabeled = 0
    for entries in entries_per_trace:
        levels_in_trace = set()
        for problem in entries:
            level = problem.get("severity")
            if level in problems:
                problems[level] += 1
                levels_in_trace.add(level)
            else:
                unlabeled += 1
        for level in levels_in_trace:
            traces_by_level[level] += 1
    return {
        "severity": {
            level: {"problems": problems[level], "traces": traces_by_level[level]}
            for level in config.SEVERITIES
        },
        "unlabeled": unlabeled,
    }


def severity(snap: Snapshot, filters: Filters, group_by=(), level="top", sort=None, limit=100, cursor=None):
    _validate_group(list(group_by), level, filters, allow_empty=True)
    if limit < 1 or limit > 1000:
        raise errors.invalid("limit 必须在 1..1000 之间", "limit")
    severity_sorts = ("traces", "problems", "rate")
    if sort is None:
        sort = "day" if "day" in group_by else "traces"
    elif sort not in severity_sorts:
        raise errors.unknown_value("sort", sort, list(severity_sorts))

    matcher = Matcher(snap, filters)
    base = [t for t in snap.traces if matcher.match(t, with_problem=False)]
    selected = [t for t in base if matcher.match(t, with_problem=True)]

    total = {
        "analyzed": len(base),
        "traces": len(selected),
        "problems": sum(t.problem_count for t in selected),
        **_severity_counts(t.problems for t in selected),
    }
    if not group_by:
        return {"total": total, "groups": [], "next_cursor": None, "has_more": False}

    stats: dict[tuple, list] = {}
    for trace in selected:
        for combo, entries in _group_keys(snap, trace, group_by, level, filters, with_problem=True):
            stats.setdefault(combo, []).append(trace.problems if entries is None else entries)

    analyzed_map: dict[tuple, int] = {}
    for trace in base:
        for combo, _entries in _group_keys(snap, trace, group_by, level, filters, with_problem=False):
            analyzed_map[combo] = analyzed_map.get(combo, 0) + 1

    rows = []
    for combo, entries_per_trace in stats.items():
        analyzed_key = tuple(pair for pair in combo if pair[0] != "problem")
        rows.append(
            {
                "keys": dict(combo),
                "analyzed": analyzed_map.get(analyzed_key, 0),
                "traces": len(entries_per_trace),
                "problems": sum(len(entries) for entries in entries_per_trace),
                **_severity_counts(entries_per_trace),
            }
        )

    filter_key = filters.cache_key() + "|" + ",".join(group_by) + "|" + level + "|" + sort
    page, next_cursor, has_more = _page_rows(
        rows, group_by, level, sort, limit, cursor, "severity", filter_key
    )
    return {
        "total": total,
        "groups": page,
        "next_cursor": next_cursor,
        "has_more": has_more,
    }


# --------------------------------------------------------------------------- /traces

def _item(trace: Trace):
    preview = trace.question or ""
    if len(preview) > config.QUERY_PREVIEW_CHARS:
        preview = preview[: config.QUERY_PREVIEW_CHARS]
    return {
        "trace_id": trace.trace_id,
        "day": trace.day,
        "asked_at": trace.asked_at,
        "source": trace.source,
        "user_id": trace.user_id,
        "session_id": trace.session_id,
        "app_version": trace.app_version,
        "query_preview": preview,
        "intent_code": trace.intent_code,
        "is_correct": trace.is_correct,
        "problem_count": trace.problem_count,
        "problem_codes": list(trace.problem_codes),
        "problems": list(trace.problems),
        "analysis_id": trace.analysis_id,
        "analyzed_at": trace.analyzed_at,
    }


def traces(snap: Snapshot, filters: Filters, page_size=20, cursor=None, ids_only=False):
    matcher = Matcher(snap, filters)
    # snap.traces 已按 (asked_at, trace_id) 倒序
    selected = [t for t in snap.traces if matcher.match(t, with_problem=True)]
    total = len(selected)

    upper = 5000 if ids_only else 100
    if page_size < 1 or page_size > upper:
        raise errors.invalid(f"page_size 必须在 1..{upper} 之间", "page_size")

    filter_key = filters.cache_key()
    if cursor:
        try:
            body = cursors.decode(cursor, "traces", filter_key)
        except cursors.CursorError as exc:
            raise errors.cursor_expired(str(exc)) if exc.expired else errors.invalid(str(exc), "cursor")
        last = tuple(body.get("c") or ("", ""))
        selected = [t for t in selected if (t.asked_at or "", t.trace_id) < last]

    page = selected[:page_size]
    has_more = len(selected) > len(page)
    next_cursor = None
    if has_more and page:
        tail = page[-1]
        next_cursor = cursors.encode("traces", filter_key, page_size, [tail.asked_at or "", tail.trace_id])

    items = [t.trace_id for t in page] if ids_only else [_item(t) for t in page]
    return {
        "items": items,
        "total": total,
        "page_size": page_size,
        "next_cursor": next_cursor,
        "has_more": has_more,
    }


# --------------------------------------------------------------------------- /traces/batch

def batch(snap: Snapshot, trace_ids, filters: Filters):
    if len(trace_ids) > config.MAX_TRACE_IDS:
        raise errors.too_many_ids("trace_ids", config.MAX_TRACE_IDS, len(trace_ids))
    items = []
    for trace_id in trace_ids:
        candidates = snap.by_id.get(trace_id)
        if not candidates:
            items.append(
                {
                    "trace_id": trace_id,
                    "status": "not_analyzed",
                    "day": None,
                    "asked_at": None,
                    "source": None,
                    "user_id": None,
                    "session_id": None,
                    "app_version": None,
                    "query_preview": None,
                    "intent_code": None,
                    "is_correct": None,
                    "problem_count": 0,
                    "problem_codes": [],
                    "problems": [],
                    "analysis_id": None,
                    "analyzed_at": None,
                }
            )
            continue
        trace = max(candidates, key=lambda t: (t.analyzed_at or "", t.day))
        item = _item(trace)
        item["status"] = "analyzed"
        items.append(item)
    return {"items": items}


# --------------------------------------------------------------------------- /traces/{id}

_LINE_CACHE: "OrderedDict[tuple, dict]" = OrderedDict()
_LINE_CACHE_MAX = 32
# ThreadingHTTPServer 的请求线程共用这份 LRU
_LINE_LOCK = threading.Lock()


def _read_offset_line(path: str, offset: int):
    """按偏移读一行 JSON；详情默认按行读，重复访问命中 LRU。"""
    key = (path, offset)
    with _LINE_LOCK:
        cached = _LINE_CACHE.get(key)
        if cached is not None:
            _LINE_CACHE.move_to_end(key)
            return cached
    try:
        with open(path, "rb") as handle:
            handle.seek(offset)
            raw = handle.readline()
    except OSError:
        return None
    try:
        parsed = json.loads(raw)
    except ValueError:
        return None
    with _LINE_LOCK:
        _LINE_CACHE[key] = parsed
        while len(_LINE_CACHE) > _LINE_CACHE_MAX:
            _LINE_CACHE.popitem(last=False)
    return parsed


def _pick_turn(record, trace_id):
    for turn in record.get("turns") or []:
        meta = turn.get("meta") or {}
        if meta.get("trace_id") == trace_id:
            return turn
    return None


def detail(snap: Snapshot, db_path, dataset: str, trace_id: str, day: str | None, taxonomy_version=None):
    if dataset not in config.DATASET_ALIASES:
        raise errors.unknown_value("dataset", dataset, sorted(config.DATASET_ALIASES))
    if not day:
        raise errors.invalid("day 必填：trace_id 只在单日内唯一", "day")
    try:
        datetime.strptime(day, "%Y-%m-%d")
    except ValueError as exc:
        raise errors.invalid("day 必须是 YYYY-MM-DD", "day") from exc

    candidates = [t for t in snap.by_id.get(trace_id, []) if t.day == day]
    if not candidates:
        raise errors.not_found("trace 不存在或未分析", trace_id=trace_id, day=day)
    trace = max(candidates, key=lambda t: (t.analyzed_at or "", t.line))

    attribution = _read_offset_line(trace.file, trace.offset)
    turn = _pick_turn(attribution, trace_id) if attribution else None

    # 编码、原始输入位置、历史版本：一个只读连接查完
    codes, input_ref, history = {}, None, []
    try:
        conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    except sqlite3.Error:
        conn = None
    if conn is not None:
        try:
            codes = _problem_codes(conn, trace_id, day, trace.app_version)
            input_ref = _input_ref(conn, trace_id, day)
            history = _history(conn, trace_id, day, trace.app_version)
        except sqlite3.Error:
            pass
        finally:
            conn.close()

    problems = []
    if turn:
        for idx, problem in enumerate(turn.get("problem") or []):
            problems.append(_problem_payload(problem, codes.get(("turn", idx)), session_level=False))
        for idx, problem in enumerate((attribution or {}).get("session_problem") or []):
            problems.append(_problem_payload(problem, codes.get(("session", idx)), session_level=True))
    else:
        problems = [
            {"code": code, "label": code, "severity": None, "evidence": [], "session_level": False}
            for code in trace.problem_codes
        ]

    input_row = _read_offset_line(*input_ref) if input_ref else None

    return {
        "trace_id": trace.trace_id,
        "day": trace.day,
        "asked_at": trace.asked_at,
        "source": trace.source,
        "user_id": trace.user_id,
        "session_id": trace.session_id,
        "app_version": trace.app_version,
        "intent_code": trace.intent_code,
        "is_correct": trace.is_correct,
        "problem_count": trace.problem_count,
        "problem_codes": list(trace.problem_codes),
        "problems": list(trace.problems),
        "analysis_id": trace.analysis_id,
        "analyzed_at": trace.analyzed_at,
        "taxonomy_version": snap.taxonomy_version(),
        "session": input_row,
        "trace": _find_trace_object(input_row, trace_id) if input_row else None,
        "analysis": {
            "intent": {"task": trace.task, "subtask": trace.subtask, "code": trace.intent_code},
            "summary": (turn or {}).get("summary"),
            "is_correct": trace.is_correct,
            "problems": problems,
            "history": history,
        },
    }


def _problem_codes(conn, trace_id, day, app_version):
    rows = conn.execute(
        "SELECT scope, idx, code FROM problem_codes WHERE trace_id = ? AND day = ? AND app_version = ?",
        (trace_id, day, app_version),
    ).fetchall()
    return {(scope, idx): code for scope, idx, code in rows}


def _problem_payload(problem, code, session_level=False):
    label = problem.get("label")
    return {
        "code": code,
        "label": label,
        "severity": problem.get("severity"),
        "definition": problem.get("definition"),
        "phenomena": problem.get("problem_phenomena"),
        "reason": problem.get("reason"),
        "component": problem.get("component_family") or problem.get("component"),
        "evidence": problem.get("evidence") or [],
        "session_level": session_level,
    }


def _find_trace_object(record, trace_id):
    for item in record.get("traces") or []:
        if (item.get("meta") or {}).get("trace_id") == trace_id:
            return item
    return None


def _input_ref(conn, trace_id, day):
    row = conn.execute(
        "SELECT path, offset FROM input_index WHERE trace_id = ? AND day = ?", (trace_id, day)
    ).fetchone()
    if not row:
        row = conn.execute(
            "SELECT path, offset FROM input_index WHERE trace_id = ? LIMIT 1", (trace_id,)
        ).fetchone()
    return tuple(row) if row else None


def _history(conn, trace_id, day, app_version):
    rows = conn.execute(
        "SELECT analysis_id, analyzed_at, intent_code, problem_codes, file, line FROM history "
        "WHERE trace_id = ? AND day = ? AND app_version = ? ORDER BY analyzed_at DESC, line DESC",
        (trace_id, day, app_version),
    ).fetchall()
    out = []
    for analysis_id, analyzed_at, intent_code, codes, file, line in rows:
        try:
            parsed = json.loads(codes or "[]")
        except ValueError:
            parsed = []
        out.append(
            {
                "analysis_id": analysis_id,
                "analyzed_at": analyzed_at,
                "intent_code": intent_code,
                "problem_codes": parsed,
                "file": file.rsplit("/", 1)[-1],
                "line": line,
            }
        )
    return out
