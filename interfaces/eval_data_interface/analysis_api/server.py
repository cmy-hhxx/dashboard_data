"""HTTP 层：路由、参数归一、响应封装、后台重建。"""

import gzip
import json
import secrets
import threading
import time
import traceback
from collections import OrderedDict
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, quote, unquote, urlparse

from . import config, cursors, errors, snapshot, store, timeutil
from .taxonomy import load_cluster, load_intent, severity_tree

MULTI_PARAMS = {"source", "intent", "problem", "severity", "app_version", "user_ids", "group_by", "trace_ids"}
KNOWN_PARAMS = {
    "dataset",
    "source",
    "start_day",
    "end_day",
    "intent",
    "problem",
    "severity",
    "app_version",
    "user_ids",
    "taxonomy_version",
    "q",
    "group_by",
    "level",
    "sort",
    "limit",
    "cursor",
    "page_size",
    "ids_only",
    "trace_ids",
    "day",
    "kind",
    "version",
    "since",
}


def _split_multi(value):
    if isinstance(value, (list, tuple)):
        items = []
        for item in value:
            items.extend(_split_multi(item))
        return items
    if value is None:
        return []
    text = str(value).strip()
    if not text:
        return []
    return [part.strip() for part in text.split(",") if part.strip()]


def normalize(params):
    """GET 查询串 / POST JSON 都归一成「多值参数是 list，其余是标量」。"""
    out = {}
    for key, value in params.items():
        if key not in KNOWN_PARAMS:
            continue
        if key in MULTI_PARAMS:
            out[key] = _split_multi(value)
        elif isinstance(value, (list, tuple)):
            out[key] = str(value[-1]).strip() if value else ""
        elif value is None:
            out[key] = ""
        else:
            out[key] = str(value).strip()
    return out


class App:
    def __init__(self):
        self.lock = threading.Lock()
        # 同一时刻只跑一轮重建：两轮并发写同一个 SQLite 会撞 database is locked
        self.build_lock = threading.Lock()
        self.snapshot = None
        self.last_build = {}
        self.building = False
        self.started_at = timeutil.utc_rfc3339(datetime.now(timezone.utc))
        self.db_path = config.db_path()
        # /summary、/severity、/taxonomy 是对内存快照的纯计算（单次 0.2–0.5 s），
        # 结果按快照缓存：快照一换整体失效，单条最多存活 RESULT_CACHE_TTL 秒（cursor 里带签发时间）。
        self.results = OrderedDict()
        self.results_snap = None
        self.results_lock = threading.Lock()
        self.inflight = threading.BoundedSemaphore(config.MAX_INFLIGHT)

    def memo(self, snap, key, compute):
        now = time.time()
        with self.results_lock:
            if self.results_snap is not snap:
                self.results.clear()
                self.results_snap = snap
            hit = self.results.get(key)
            if hit and now - hit[0] < config.RESULT_CACHE_TTL:
                self.results.move_to_end(key)
                return hit[1]
        value = compute()
        with self.results_lock:
            if self.results_snap is snap:
                self.results[key] = (now, value)
                while len(self.results) > config.RESULT_CACHE_SIZE:
                    self.results.popitem(last=False)
        return value

    def warm(self, snap, log=print):
        """新快照上线后先算一遍最常用的聚合，别让第一个调用方等。"""
        started = time.time()
        for path, params in WARM_QUERIES:
            try:
                COMPUTE[path](snap, normalize(params))
            except Exception as exc:  # noqa: BLE001 - 预热失败不影响服务
                log(f"[warm] {path} {params} 失败：{exc}")
        log(f"[warm] {len(WARM_QUERIES)} 个常用聚合 {round(time.time() - started, 1)}s")

    # -- 构建 ---------------------------------------------------------
    @staticmethod
    def _trees(log):
        intent_tree = load_intent(config.INTENT_TAXONOMY_FILE)
        problem_trees = {}
        for model_dir, (tree_path, _) in store.cluster_files(config.datasets_root() / config.AIME_DIR).items():
            suffix = config.MODEL_SUFFIX.get(model_dir, model_dir)
            try:
                problem_trees[f"__{suffix}"] = load_cluster(tree_path, model_dir)
            except Exception as exc:  # noqa: BLE001
                log(f"[warn] 问题树 {tree_path} 加载失败：{exc}")
        return intent_tree, problem_trees

    def load_existing(self, log=print):
        """重启时先用磁盘上的索引对外服务；增量重建在后台跑完后再替换快照。"""
        if not self.db_path.exists():
            return
        try:
            intent_tree, problem_trees = self._trees(log)
            conn = store.connect(self.db_path)
            try:
                if store.schema_version(conn) != store.SCHEMA_VERSION:
                    raise RuntimeError("索引结构版本不一致，等待首轮重建")
                snap = snapshot.load(conn, intent_tree, problem_trees)
            finally:
                conn.close()
            self._fix_app_versions(snap)
            with self.lock:
                if self.snapshot is None:
                    self.snapshot = snap
            log(f"[serve] 先用已有索引：traces={len(snap.traces)}")
            self.warm(snap, log)
        except Exception as exc:  # noqa: BLE001 - 读不了就等首轮重建
            log(f"[serve] 已有索引不可用：{exc}")

    def rebuild(self, log=print):
        if not self.build_lock.acquire(blocking=False):
            log("[build] 上一轮还在进行，跳过")
            return
        self.building = True
        started = time.time()
        try:
            intent_tree, problem_trees = self._trees(log)
            summary = store.build(log=log)
            conn = store.connect(self.db_path)
            try:
                snap = snapshot.load(conn, intent_tree, problem_trees, summary)
            finally:
                conn.close()
            self._fix_app_versions(snap)
            with self.lock:
                self.snapshot = snap
                self.last_build = {
                    "ok": True,
                    "started_at": timeutil.utc_rfc3339(datetime.fromtimestamp(started, timezone.utc)),
                    "finished_at": timeutil.utc_rfc3339(datetime.now(timezone.utc)),
                    "seconds": round(time.time() - started, 1),
                    **summary,
                }
            log(
                f"[build] ok traces={summary['traces']} history={summary['history']} "
                f"input={summary['input_traces']} seconds={round(time.time() - started, 1)}"
            )
            self.warm(snap, log)
        except Exception as exc:  # noqa: BLE001
            log(f"[build] 失败：{exc}")
            log(traceback.format_exc())
            with self.lock:
                self.last_build = {
                    "ok": False,
                    "error": str(exc),
                    "finished_at": timeutil.utc_rfc3339(datetime.now(timezone.utc)),
                }
        finally:
            self.building = False
            self.build_lock.release()

    def _fix_app_versions(self, snap):
        """把问题树按 trace 的 app_version 对齐。"""
        by_suffix = dict(snap.problem_trees)
        resolved = {}
        for trace in snap.traces:
            suffix = trace.app_version.rsplit("_", 1)[-1]
            tree = by_suffix.get(f"__{suffix}") or by_suffix.get(suffix)
            if tree is not None:
                resolved[trace.app_version] = tree
        for app_version, tree in by_suffix.items():
            if app_version.startswith("__"):
                continue
            resolved.setdefault(app_version, tree)
        snap.problem_trees = resolved

    def refresh_loop(self, log=print):
        while True:
            time.sleep(config.REFRESH_SECONDS)
            try:
                self.rebuild(log)
            except Exception as exc:  # noqa: BLE001
                log(f"[refresh] 失败：{exc}")

    def current(self):
        with self.lock:
            return self.snapshot


APP = App()


def _json_response(handler, status, payload, headers=None):
    # 原始输入里偶有落单的代理字符（emoji 被截断），ensure_ascii=False 后直接 encode 会 503，
    # 只用 utf-8 的 replace 兜住坏字节，正常内容不受影响。
    body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8", "replace")
    accepts = handler.headers.get("Accept-Encoding", "") if handler.headers else ""
    compressed = len(body) >= config.GZIP_MIN_BYTES and "gzip" in accepts.lower()
    if compressed:
        body = gzip.compress(body, compresslevel=5, mtime=0)
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    handler.send_header("Cache-Control", "no-store")
    handler.send_header("Vary", "Accept-Encoding")
    if compressed:
        handler.send_header("Content-Encoding", "gzip")
    for name, value in (headers or {}).items():
        handler.send_header(name, value)
    handler.end_headers()
    try:
        handler.wfile.write(body)
    except (BrokenPipeError, ConnectionResetError):
        pass


def _request_id():
    return "req_" + secrets.token_hex(6).upper()


class Handler(BaseHTTPRequestHandler):
    server_version = "eval-data-analysis/2.0"
    protocol_version = "HTTP/1.1"

    # -- 基础设施 -----------------------------------------------------
    def log_message(self, fmt, *args):  # noqa: A003
        print(f"[http] {self.address_string()} {fmt % args}", flush=True)

    def _envelope(self, data, filters=None, snapshot_obj=None, extra_meta=None):
        snap = snapshot_obj or APP.current()
        cluster_updated_at = None
        if snap and snap.problem_trees:
            cluster_updated_at = max(
                (tree.released_at for tree in snap.problem_trees.values() if tree.released_at),
                default=None,
            )
        meta = {
            "taxonomy_version": snap.taxonomy_version() if snap else None,
            "taxonomy_versions": snap.taxonomy_versions() if snap else None,
            "data_updated_at": snap.data_updated_at if snap else None,
            "built_at": snap.built_at if snap else None,
            # 聚类产物的生成时间与批次覆盖上限：最新一天通常还没被聚类覆盖。
            "cluster_updated_at": cluster_updated_at,
            "cluster_through": (snap.build_summary or {}).get("cluster_through") if snap else None,
            # 增量同步的最新位点：客户端可与自己保存的 since 对比判断是否落后
            "latest_seq": snap.latest_seq if snap else None,
            "filters": filters or {},
        }
        if extra_meta:
            meta.update(extra_meta)
        return {
            "request_id": _request_id(),
            "schema_version": config.SCHEMA_VERSION,
            "data": data,
            "meta": meta,
        }

    def _snapshot(self):
        snap = APP.current()
        if snap is None:
            raise errors.unavailable("服务正在构建索引，请稍后重试", building=APP.building)
        return snap

    def _read_body(self):
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError as exc:
            raise errors.invalid("Content-Length 不合法") from exc
        if length <= 0:
            return {}
        raw = self.rfile.read(length)
        if self.headers.get("Content-Type", "").startswith("application/x-www-form-urlencoded"):
            return {k: v for k, v in parse_qs(raw.decode("utf-8", "replace")).items()}
        try:
            payload = json.loads(raw)
        except ValueError as exc:
            raise errors.invalid("请求体不是合法 JSON") from exc
        if not isinstance(payload, dict):
            raise errors.invalid("请求体必须是 JSON 对象")
        return payload

    def _params(self):
        parsed = urlparse(self.path)
        params = {k: v for k, v in parse_qs(parsed.query, keep_blank_values=False).items()}
        if self.command == "POST" and parsed.path.rstrip("/") != config.API_PREFIX + "/traces/batch":
            body = self._read_body()
            for key, value in body.items():
                params[key] = value
        return parsed.path, normalize(params)

    def _route(self):
        request_id = _request_id()
        # 超过并发上限直接 429：排队只会把线程和内存堆满，调用方按 Retry-After 退避即可。
        if not APP.inflight.acquire(blocking=False):
            exc = errors.rate_limited()
            _json_response(
                self,
                exc.status,
                {"request_id": request_id, "error": {"code": exc.code, "message": exc.message, "details": exc.details}},
                headers={"Retry-After": str(exc.details["retry_after"])},
            )
            return
        try:
            path, params = self._params()
            self._dispatch(path.rstrip("/"), params)
        except errors.ApiError as exc:
            _json_response(
                self,
                exc.status,
                {
                    "request_id": request_id,
                    "error": {"code": exc.code, "message": exc.message, "details": exc.details},
                },
            )
        except Exception as exc:  # noqa: BLE001
            print(f"[error] {exc}\n{traceback.format_exc()}", flush=True)
            _json_response(
                self,
                503,
                {
                    "request_id": request_id,
                    "error": {"code": "UNAVAILABLE", "message": "服务内部错误", "details": {"error": str(exc)}},
                },
            )
        finally:
            APP.inflight.release()

    # -- 方法 ---------------------------------------------------------
    def do_GET(self):  # noqa: N802
        self._route()

    def do_POST(self):  # noqa: N802
        self._route()

    # -- 路由 ---------------------------------------------------------
    def _dispatch(self, path, params):
        if path in ("/healthz", config.API_PREFIX + "/healthz"):
            self._health()
            return
        if not path.startswith(config.API_PREFIX):
            raise errors.not_found("未知路径", path=path)
        tail = path[len(config.API_PREFIX):] or "/"
        if tail == "/taxonomy":
            self._taxonomy(params)
        elif tail == "/summary":
            self._summary(params)
        elif tail == "/severity":
            self._severity(params)
        elif tail == "/traces":
            self._traces(params)
        elif tail == "/users":
            self._users(params)
        elif tail == "/traces/batch":
            self._batch(params)
        elif tail == "/changes":
            self._changes(params)
        elif tail == "/docs" or tail.startswith("/docs/"):
            self._docs(unquote(tail[len("/docs"):]).strip("/") or None)
        elif tail.startswith("/traces/"):
            self._detail(unquote(tail[len("/traces/"):]), params)
        else:
            raise errors.not_found("未知路径", path=path)

    def _health(self):
        snap = APP.current()
        with APP.lock:
            build = dict(APP.last_build)
        _json_response(
            self,
            200,
            {
                "ok": snap is not None,
                "started_at": APP.started_at,
                "built_at": snap.built_at if snap else None,
                "data_updated_at": snap.data_updated_at if snap else None,
                "traces": len(snap.traces) if snap else 0,
                "problems": sum(t.problem_count for t in snap.traces) if snap else 0,
                "latest_seq": snap.latest_seq if snap else 0,
                "building": APP.building,
                "build": build,
                "state_dir": str(config.STATE_DIR),
            },
        )

    def _taxonomy(self, params):
        snap = self._snapshot()
        kind = params.get("kind") or ""
        if kind not in ("intent", "problem", "severity"):
            raise errors.unknown_value("kind", kind, ["intent", "problem", "severity"])
        version = params.get("version") or params.get("taxonomy_version") or ""
        app_version = params.get("app_version") or ""
        if isinstance(app_version, list):
            app_version = app_version[0] if app_version else ""

        if kind == "severity":
            tree = severity_tree()
        elif kind == "intent":
            if snap.intent is None:
                raise errors.unavailable("意图分类树尚未加载")
            tree = snap.intent
        else:
            if not snap.problem_trees:
                raise errors.unavailable("问题分类树尚未加载")
            if app_version:
                tree = snap.problem_trees.get(app_version)
                if tree is None:
                    raise errors.unknown_value("app_version", app_version, sorted(snap.problem_trees))
            else:
                tree = snap.problem_trees[sorted(snap.problem_trees)[0]]
        if version and version != tree.version:
            raise errors.not_found(f"分类版本 {version} 不存在", taxonomy_version=version)

        data = APP.memo(snap, ("/taxonomy", id(tree)), tree.as_payload)
        _json_response(
            self,
            200,
            self._envelope(
                data,
                filters={"kind": kind, "version": tree.version, "app_version": app_version or None},
                snapshot_obj=snap,
            ),
        )

    def _summary(self, params):
        snap = self._snapshot()
        data, echo = APP.memo(snap, _cache_key("/summary", params), lambda: _compute_summary(snap, params))
        _json_response(self, 200, self._envelope(data, echo, snap))

    def _severity(self, params):
        snap = self._snapshot()
        data, echo = APP.memo(snap, _cache_key("/severity", params), lambda: _compute_severity(snap, params))
        _json_response(self, 200, self._envelope(data, echo, snap))

    def _traces(self, params):
        snap = self._snapshot()
        filters = snapshot.parse_filters(params, snap)
        page_size = _int_param(params, "page_size", 20)
        ids_only = params.get("ids_only")
        ids_only = str(ids_only).lower() in ("true", "1") if ids_only else False
        data = snapshot.traces(
            snap,
            filters,
            page_size=page_size,
            cursor=(params.get("cursor") or None),
            ids_only=ids_only,
        )
        _json_response(self, 200, self._envelope(data, filters.echo, snap))

    def _users(self, params):
        snap = self._snapshot()
        filters = snapshot.parse_filters(params, snap)
        data = snapshot.user_summary(
            snap,
            filters,
            sort=(params.get("sort") or "").strip() or None,
            limit=_int_param(params, "limit", 100),
            cursor=(params.get("cursor") or None),
        )
        _json_response(self, 200, self._envelope(data, filters.echo, snap))

    def _batch(self, params):
        snap = self._snapshot()
        body = self._read_body() if self.command == "POST" else params
        dataset = str(body.get("dataset") or "").strip()
        if dataset not in config.DATASET_ALIASES:
            raise errors.unknown_value("dataset", dataset, sorted(config.DATASET_ALIASES))
        trace_ids = body.get("trace_ids")
        if isinstance(trace_ids, str):
            trace_ids = [trace_ids]
        trace_ids = [str(tid) for tid in (trace_ids or [])]
        if not trace_ids:
            raise errors.invalid("trace_ids 不能为空", "trace_ids")
        data = snapshot.batch(snap, trace_ids, None)
        _json_response(self, 200, self._envelope(data, {"dataset": dataset}, snap))

    def _changes(self, params):
        snap = self._snapshot()
        dataset = params.get("dataset") or ""
        if not dataset:
            raise errors.invalid("缺少必填参数 dataset", "dataset")
        page_size = _int_param(params, "page_size", 100)
        since = params.get("since") or None
        data = snapshot.changes(
            snap,
            APP.db_path,
            dataset,
            since,
            page_size=page_size,
            cursor=(params.get("cursor") or None),
        )
        _json_response(
            self,
            200,
            self._envelope(
                data,
                {"dataset": dataset, "since_seq": data["since_seq"], "head_seq": data["head_seq"]},
                snap,
            ),
        )

    def _docs(self, name):
        if name:
            slug = name
            path = (config.DOCS_DIR / f"{slug}.md").resolve()
            if path.parent != config.DOCS_DIR.resolve() or not path.is_file():
                raise errors.not_found("文档不存在", name=slug)
            content = path.read_text(encoding="utf-8", errors="replace")
            data = {
                "name": slug,
                "title": _doc_title(content, slug),
                "format": "markdown",
                "content": content,
                "updated_at": timeutil.utc_rfc3339(
                    datetime.fromtimestamp(path.stat().st_mtime, timezone.utc)
                ),
            }
        else:
            docs = []
            for path in sorted(config.DOCS_DIR.glob("*.md")):
                slug = path.stem
                content = path.read_text(encoding="utf-8", errors="replace")
                docs.append(
                    {
                        "name": slug,
                        "title": _doc_title(content, slug),
                        "url": f"{config.API_PREFIX}/docs/{quote(slug)}",
                        "updated_at": timeutil.utc_rfc3339(
                            datetime.fromtimestamp(path.stat().st_mtime, timezone.utc)
                        ),
                    }
                )
            data = {"docs": docs}
        _json_response(self, 200, self._envelope(data, {"name": name}))

    def _detail(self, trace_id, params):
        snap = self._snapshot()
        dataset = params.get("dataset") or ""
        if not dataset:
            raise errors.invalid("缺少必填参数 dataset", "dataset")
        data = snapshot.detail(
            snap,
            APP.db_path,
            dataset,
            trace_id,
            params.get("day") or None,
            params.get("taxonomy_version") or None,
        )
        _json_response(
            self,
            200,
            self._envelope(
                data,
                {"dataset": params.get("dataset"), "day": params.get("day"), "trace_id": trace_id},
                snap,
            ),
        )


def _doc_title(content, fallback):
    for line in content.splitlines():
        if line.startswith("# "):
            return line[2:].strip()
    return fallback


def _int_param(params, name, default):
    raw = params.get(name)
    if raw is None or raw == "":
        return default
    try:
        return int(raw)
    except (TypeError, ValueError) as exc:
        raise errors.invalid(f"{name} 必须是整数", name) from exc


def _cache_key(path, params):
    return (path, json.dumps(params, ensure_ascii=False, sort_keys=True, default=str))


def _compute_summary(snap, params):
    filters = snapshot.parse_filters(params, snap)
    data = snapshot.summary(
        snap,
        filters,
        params.get("group_by") or [],
        level=params.get("level") or "top",
        sort=params.get("sort") or None,
        limit=_int_param(params, "limit", 100),
        cursor=(params.get("cursor") or None),
    )
    return data, filters.echo


def _compute_severity(snap, params):
    filters = snapshot.parse_filters(params, snap)
    data = snapshot.severity(
        snap,
        filters,
        group_by=params.get("group_by") or [],
        level=params.get("level") or "top",
        sort=params.get("sort") or None,
        limit=_int_param(params, "limit", 100),
        cursor=(params.get("cursor") or None),
    )
    return data, filters.echo


def _warm_compute(path, fn):
    def run(snap, params):
        APP.memo(snap, _cache_key(path, params), lambda: fn(snap, params))
    return run


COMPUTE = {
    "/summary": _warm_compute("/summary", _compute_summary),
    "/severity": _warm_compute("/severity", _compute_severity),
}
# 最常用的几组聚合（接入说明里的示例调用）；新快照上线即预算。
WARM_QUERIES = [
    ("/severity", {"dataset": "aime_eval"}),
    ("/summary", {"dataset": "aime_eval", "group_by": "intent"}),
    ("/summary", {"dataset": "aime_eval", "group_by": "problem"}),
]


class Server(ThreadingHTTPServer):
    daemon_threads = True
    # 批量拉数时并发连接多，默认 backlog 5 会直接拒绝后来的连接（listen 时生效，必须是类属性）。
    request_queue_size = 128


def serve(host=None, port=None, log=print):
    host = host or config.HOST
    port = port or config.PORT
    server = Server((host, port), Handler)
    thread = threading.Thread(target=APP.refresh_loop, args=(log,), daemon=True)
    thread.start()
    log(f"[serve] listening on http://{host}:{port}{config.API_PREFIX}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log("[serve] 退出")
    finally:
        server.server_close()
