"""HTTP REST API router and standalone server for internal_eval_service_interface.

Matches the 5003 response envelope (`{request_id, schema_version, data, meta}`)
and error format (`{request_id, error: {code, message, details}}`), and can be
either mounted onto `eval_data_interface` on port 5003 or served standalone.
"""

from __future__ import annotations

import gzip
import json
import secrets
import threading
import traceback
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, quote, unquote, urlparse

from . import errors
from .compare import build_compare_payload
from .config import ALLOWED_SIDES, ServiceConfig, load_config
from .pipeline import PipelineManager
from .state_store import StateStore
from .timeutil import utc_rfc3339


def _request_id() -> str:
    return "req_" + secrets.token_hex(6).upper()


def _doc_title(content: str, fallback: str) -> str:
    for line in content.splitlines():
        if line.startswith("# "):
            return line[2:].strip()
    return fallback


def _int_param(query: dict[str, list[str]], name: str, default: int, *, minimum: int = 0, maximum: int = 10000) -> int:
    vals = query.get(name)
    if not vals or not vals[-1].strip():
        return default
    try:
        parsed = int(vals[-1].strip())
    except ValueError as exc:
        raise errors.invalid(f"{name} 必须是整数", name) from exc
    if parsed < minimum or parsed > maximum:
        raise errors.invalid(f"{name} 必须在 {minimum}..{maximum} 之间", name)
    return parsed


def _bool_param(query: dict[str, list[str]], name: str, default: bool) -> bool:
    vals = query.get(name)
    if not vals or not vals[-1].strip():
        return default
    return vals[-1].strip().lower() in ("1", "true", "yes", "on")


def _str_param(query: dict[str, list[str]], name: str) -> str | None:
    vals = query.get(name)
    if not vals:
        return None
    val = vals[-1].strip()
    return val or None


def _send_json(handler: BaseHTTPRequestHandler, status: int, payload: Any, *, gzip_min_bytes: int = 1024, headers: dict[str, str] | None = None) -> None:
    body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8", "replace")
    accepts = handler.headers.get("Accept-Encoding", "") if handler.headers else ""
    compressed = len(body) >= gzip_min_bytes and "gzip" in accepts.lower()
    if compressed:
        body = gzip.compress(body, compresslevel=5, mtime=0)
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    handler.send_header("Cache-Control", "no-store")
    handler.send_header("Vary", "Accept-Encoding")
    if compressed:
        handler.send_header("Content-Encoding", "gzip")
    for k, v in (headers or {}).items():
        handler.send_header(k, v)
    handler.end_headers()
    try:
        handler.wfile.write(body)
    except (BrokenPipeError, ConnectionResetError):
        pass


class InternalEvalApp:
    """Self-contained HTTP application for `/api/v1/internal-eval/*`."""

    def __init__(
        self,
        cfg: ServiceConfig,
        store: StateStore,
        pipeline: PipelineManager,
    ):
        self.cfg = cfg
        self.store = store
        self.pipeline = pipeline
        self.started_at = utc_rfc3339()
        self.inflight = threading.BoundedSemaphore(cfg.max_inflight)

    def can_handle(self, path: str) -> bool:
        clean = path.rstrip("/")
        prefix = self.cfg.api_prefix.rstrip("/")
        return clean == prefix or clean.startswith(prefix + "/")

    def handle_http(self, handler: BaseHTTPRequestHandler) -> None:
        request_id = _request_id()
        if not self.inflight.acquire(blocking=False):
            exc = errors.rate_limited()
            _send_json(
                handler,
                exc.status,
                {"request_id": request_id, "error": {"code": exc.code, "message": exc.message, "details": exc.details}},
                gzip_min_bytes=self.cfg.gzip_min_bytes,
                headers={"Retry-After": str(exc.details["retry_after"])},
            )
            return

        try:
            parsed = urlparse(handler.path)
            raw_path = parsed.path.rstrip("/")
            query = parse_qs(parsed.query, keep_blank_values=False)
            method = handler.command.upper()

            if method == "POST":
                self._check_write_auth(handler)

            status, data, extra_meta = self._dispatch(method, raw_path, query, handler)
            envelope = {
                "request_id": request_id,
                "schema_version": self.cfg.schema_version,
                "data": data,
                "meta": {
                    "service": "internal_eval_service",
                    "api_prefix": self.cfg.api_prefix,
                    "timestamp": utc_rfc3339(),
                    **(extra_meta or {}),
                },
            }
            _send_json(handler, status, envelope, gzip_min_bytes=self.cfg.gzip_min_bytes)
        except errors.ApiError as exc:
            _send_json(
                handler,
                exc.status,
                {
                    "request_id": request_id,
                    "error": {"code": exc.code, "message": exc.message, "details": exc.details},
                },
                gzip_min_bytes=self.cfg.gzip_min_bytes,
            )
        except Exception as exc:  # noqa: BLE001
            print(f"[internal-eval][error] {exc}\n{traceback.format_exc()}", flush=True)
            _send_json(
                handler,
                503,
                {
                    "request_id": request_id,
                    "error": {"code": "UNAVAILABLE", "message": "服务内部错误", "details": {"error": str(exc)}},
                },
                gzip_min_bytes=self.cfg.gzip_min_bytes,
            )
        finally:
            self.inflight.release()

    def _check_write_auth(self, handler: BaseHTTPRequestHandler) -> None:
        expected = self.cfg.api_write_token
        if not expected:
            return
        auth = (handler.headers.get("Authorization") or "").strip()
        api_key = (handler.headers.get("X-API-Key") or "").strip()
        token = ""
        if auth.lower().startswith("bearer "):
            token = auth[7:].strip()
        elif api_key:
            token = api_key
        if not token or not secrets.compare_digest(token, expected):
            raise errors.unauthorized("写操作需要有效的 Bearer Token 或 X-API-Key")

    @staticmethod
    def _read_json_body(handler: BaseHTTPRequestHandler) -> dict[str, Any]:
        try:
            length = int(handler.headers.get("Content-Length") or 0)
        except ValueError as exc:
            raise errors.invalid("Content-Length 不合法") from exc
        if length <= 0:
            return {}
        raw = handler.rfile.read(length)
        try:
            payload = json.loads(raw.decode("utf-8", "replace"))
        except ValueError as exc:
            raise errors.invalid("请求体不是合法 JSON") from exc
        if not isinstance(payload, dict):
            raise errors.invalid("请求体必须是 JSON 对象")
        return payload

    def _dispatch(
        self,
        method: str,
        raw_path: str,
        query: dict[str, list[str]],
        handler: BaseHTTPRequestHandler,
    ) -> tuple[int, dict[str, Any], dict[str, Any]]:
        prefix = self.cfg.api_prefix.rstrip("/")
        if raw_path == "/healthz" or raw_path == prefix + "/healthz":
            if method != "GET":
                raise errors.invalid("healthz 仅支持 GET")
            return 200, self._health(), {}

        if not raw_path.startswith(prefix):
            raise errors.not_found("未知路径", path=raw_path)

        tail = raw_path[len(prefix) :] or "/"
        parts = [unquote(seg) for seg in tail.strip("/").split("/") if seg]

        # GET /docs or GET /docs/{name}
        if parts and parts[0] == "docs":
            if method != "GET":
                raise errors.invalid("文档接口仅支持 GET")
            name = "/".join(parts[1:]) if len(parts) > 1 else None
            return 200, self._docs(name), {"doc": name}

        # GET /versions or GET /versions/{version}
        if parts and parts[0] == "versions":
            if method != "GET":
                raise errors.invalid("版本查询接口仅支持 GET")
            if len(parts) == 1:
                return 200, self._list_versions(), {}
            if len(parts) == 2:
                return 200, self._get_version(parts[1], query), {"version": parts[1]}
            raise errors.not_found("未知版本路径", path=raw_path)

        # /runs ...
        if parts and parts[0] == "runs":
            if len(parts) == 1:
                if method == "POST":
                    body = self._read_json_body(handler)
                    return self._create_run(body)
                if method == "GET":
                    return 200, self._list_runs(query), {}
                raise errors.invalid("不支持的 HTTP 方法")

            run_id = parts[1]
            if len(parts) == 2:
                if method == "GET":
                    return 200, self._get_run(run_id), {"run_id": run_id}
                raise errors.invalid("不支持的 HTTP 方法")

            sub = parts[2]
            if len(parts) == 3:
                if sub == "cancel" and method == "POST":
                    return 200, self._cancel_run(run_id), {"run_id": run_id}
                if sub == "retry-failed" and method == "POST":
                    body = self._read_json_body(handler)
                    return 200, self._retry_failed(run_id, body), {"run_id": run_id}
                if sub == "ingest" and method == "POST":
                    body = self._read_json_body(handler)
                    return 200, self._ingest(run_id, body), {"run_id": run_id}
                if sub == "collector-events" and method == "POST":
                    body = self._read_json_body(handler)
                    return 200, self._collector_event(run_id, body), {"run_id": run_id}
                if sub == "failures" and method == "GET":
                    return 200, self._failures(run_id, query), {"run_id": run_id}
                if sub == "events" and method == "GET":
                    return 200, self._events(run_id, query), {"run_id": run_id}
                if sub == "results" and method == "GET":
                    return 200, self._results(run_id, query), {"run_id": run_id}
                if sub == "compare" and method == "GET":
                    return 200, self._compare(run_id, query), {"run_id": run_id}

            if len(parts) == 4 and sub == "results" and parts[3] == "changes" and method == "GET":
                return 200, self._result_changes(run_id, query), {"run_id": run_id}

        raise errors.not_found("未知路径或不支持的方法", path=raw_path, method=method)

    # ---- Endpoint Handlers -------------------------------------------------

    def _health(self) -> dict[str, Any]:
        active = self.store.list_runs_by_statuses(("preparing_questions", "dispatching", "running", "finalizing"))
        queued = self.store.list_runs_by_statuses(("queued",))
        all_runs, total_runs = self.store.list_runs(limit=1, offset=0)
        return {
            "ok": True,
            "started_at": self.started_at,
            "active_runs": len(active),
            "queued_runs": len(queued),
            "total_runs": total_runs,
            "latest_run_id": all_runs[0]["run_id"] if all_runs else None,
            "config": self.cfg.public_summary(),
        }

    def _create_run(self, body: dict[str, Any]) -> tuple[int, dict[str, Any], dict[str, Any]]:
        try:
            run, created = self.pipeline.submit_run(body)
        except FileExistsError as exc:
            raise errors.conflict(str(exc)) from exc
        except ValueError as exc:
            raise errors.invalid(str(exc)) from exc
        enriched = self._decorate_run(self.store.get_run_progress(run["run_id"]) or run)
        return (201 if created else 200), enriched, {"created": created, "run_id": run["run_id"]}

    def _list_runs(self, query: dict[str, list[str]]) -> dict[str, Any]:
        limit = _int_param(query, "limit", 50, minimum=1, maximum=200)
        offset = _int_param(query, "offset", 0, minimum=0, maximum=100000)
        runs, total = self.store.list_runs(
            version=_str_param(query, "version"),
            model=_str_param(query, "model"),
            status=_str_param(query, "status"),
            agent=_str_param(query, "agent"),
            limit=limit,
            offset=offset,
        )
        items = [self._decorate_run(self.store.get_run_progress(r["run_id"]) or r) for r in runs]
        return {
            "total": total,
            "limit": limit,
            "offset": offset,
            "has_more": offset + len(items) < total,
            "items": items,
        }

    def _get_run(self, run_id: str) -> dict[str, Any]:
        prog = self.store.get_run_progress(run_id)
        if not prog:
            raise errors.not_found(f"任务不存在：{run_id}", run_id=run_id)
        return self._decorate_run(prog)

    def _cancel_run(self, run_id: str) -> dict[str, Any]:
        run = self.pipeline.cancel_run(run_id)
        if not run:
            raise errors.not_found(f"任务不存在：{run_id}", run_id=run_id)
        return self._decorate_run(self.store.get_run_progress(run_id) or run)

    def _retry_failed(self, run_id: str, body: dict[str, Any]) -> dict[str, Any]:
        stages = body.get("stages")
        sides = body.get("sides")
        if stages is not None and not isinstance(stages, list):
            raise errors.invalid("stages 必须是字符串列表", "stages")
        if sides is not None and not isinstance(sides, list):
            raise errors.invalid("sides 必须是字符串列表", "sides")
        try:
            res = self.pipeline.retry_failed(run_id, stages=stages, sides=sides)
        except KeyError as exc:
            raise errors.not_found(f"任务不存在：{run_id}", run_id=run_id) from exc
        except RuntimeError as exc:
            raise errors.conflict(str(exc), run_id=run_id) from exc
        return {
            "run_id": run_id,
            **res,
            "run": self._decorate_run(self.store.get_run_progress(run_id) or {}),
        }

    def _ingest(self, run_id: str, body: dict[str, Any]) -> dict[str, Any]:
        side = str(body.get("side") or "").strip().lower()
        if side not in ALLOWED_SIDES:
            raise errors.unknown_value("side", side, ALLOWED_SIDES)
        traces = body.get("traces")
        if traces is None and isinstance(body.get("trace"), dict):
            traces = [body["trace"]]
        if not isinstance(traces, list) or not traces:
            raise errors.invalid("traces 必须是非空数组（或传单个 trace 对象）", "traces")
        try:
            return self.pipeline.ingest_traces(run_id, side, traces)
        except KeyError as exc:
            raise errors.not_found(str(exc), run_id=run_id) from exc
        except ValueError as exc:
            raise errors.invalid(str(exc)) from exc

    def _collector_event(self, run_id: str, body: dict[str, Any]) -> dict[str, Any]:
        side = str(body.get("side") or "").strip().lower()
        if side not in ALLOWED_SIDES:
            raise errors.unknown_value("side", side, ALLOWED_SIDES)
        event_type = str(body.get("event_type") or body.get("status") or "").strip()
        if not event_type:
            raise errors.invalid("缺少必填参数 event_type", "event_type")
        try:
            return self.pipeline.handle_collector_event(run_id, side, event_type, body)
        except KeyError as exc:
            raise errors.not_found(str(exc), run_id=run_id) from exc
        except ValueError as exc:
            raise errors.invalid(str(exc)) from exc

    def _failures(self, run_id: str, query: dict[str, list[str]]) -> dict[str, Any]:
        if not self.store.get_run(run_id):
            raise errors.not_found(f"任务不存在：{run_id}", run_id=run_id)
        limit = _int_param(query, "limit", 100, minimum=1, maximum=1000)
        offset = _int_param(query, "offset", 0, minimum=0, maximum=100000)
        return self.store.list_failures(
            run_id,
            stage=_str_param(query, "stage"),
            side=_str_param(query, "side"),
            unresolved_only=_bool_param(query, "unresolved_only", True),
            limit=limit,
            offset=offset,
        )

    def _events(self, run_id: str, query: dict[str, list[str]]) -> dict[str, Any]:
        if not self.store.get_run(run_id):
            raise errors.not_found(f"任务不存在：{run_id}", run_id=run_id)
        limit = _int_param(query, "limit", 100, minimum=1, maximum=500)
        offset = _int_param(query, "offset", 0, minimum=0, maximum=100000)
        items, total = self.store.list_events(run_id, limit=limit, offset=offset)
        return {
            "total": total,
            "limit": limit,
            "offset": offset,
            "has_more": offset + len(items) < total,
            "items": items,
        }

    def _results(self, run_id: str, query: dict[str, list[str]]) -> dict[str, Any]:
        run = self.store.get_run(run_id)
        if not run:
            raise errors.not_found(f"任务不存在：{run_id}", run_id=run_id)
        limit = _int_param(query, "limit", 50, minimum=1, maximum=500)
        offset = _int_param(query, "offset", 0, minimum=0, maximum=100000)
        side = _str_param(query, "side")
        if side and side not in ALLOWED_SIDES:
            raise errors.unknown_value("side", side, ALLOWED_SIDES)
        data = self.store.query_results(
            run_id,
            side=side,
            severity=_str_param(query, "severity"),
            problem_code=_str_param(query, "problem_code"),
            case_key=_str_param(query, "case_key"),
            only_ready=_bool_param(query, "only_ready", True),
            paired_only=_bool_param(query, "paired_only", False),
            limit=limit,
            offset=offset,
        )
        data["latest_seq"] = self.store.get_latest_seq(run_id)
        data["run_status"] = run["status"]
        return data

    def _result_changes(self, run_id: str, query: dict[str, list[str]]) -> dict[str, Any]:
        run = self.store.get_run(run_id)
        if not run:
            raise errors.not_found(f"任务不存在：{run_id}", run_id=run_id)
        since_seq = _int_param(query, "since", 0, minimum=0, maximum=10**9)
        limit = _int_param(query, "limit", 200, minimum=1, maximum=1000)
        data = self.store.query_result_changes(run_id, since_seq=since_seq, limit=limit)
        data["run_status"] = run["status"]
        return data

    def _compare(self, run_id: str, query: dict[str, list[str]]) -> dict[str, Any]:
        run = self.store.get_run(run_id)
        if not run:
            raise errors.not_found(f"任务不存在：{run_id}", run_id=run_id)
        targets = self.store.get_targets(run_id)
        before_cases = {c["case_key"]: c for c in self.store.get_side_cases(run_id, side="before")}
        after_cases = {c["case_key"]: c for c in self.store.get_side_cases(run_id, side="after")}
        paired_only = _bool_param(query, "paired_only", False)
        top_leaves = _int_param(query, "top_leaves", 30, minimum=1, maximum=500)
        payload = build_compare_payload(
            run=run,
            targets=targets,
            before_cases=before_cases,
            after_cases=after_cases,
            paired_only_for_distribution=paired_only,
            top_leaves=top_leaves,
        )
        payload["latest_seq"] = self.store.get_latest_seq(run_id)
        return payload

    def _list_versions(self) -> dict[str, Any]:
        runs, _ = self.store.list_runs(limit=500, offset=0)
        grouped: dict[str, list[dict[str, Any]]] = {}
        for r in runs:
            grouped.setdefault(r["version"], []).append(r)
        items = []
        for ver, vruns in grouped.items():
            latest = self.store.get_run_progress(vruns[0]["run_id"]) or vruns[0]
            items.append(
                {
                    "version": ver,
                    "run_count": len(vruns),
                    "latest_run_id": latest["run_id"],
                    "latest_status": latest["status"],
                    "latest_round_dir": latest["round_dir_name"],
                    "latest_created_at": latest["created_at"],
                    "latest_progress": latest.get("progress", {}),
                    "run_ids": [r["run_id"] for r in vruns],
                }
            )
        return {"total": len(items), "versions": items}

    def _get_version(self, version: str, query: dict[str, list[str]]) -> dict[str, Any]:
        runs, total = self.store.list_runs(version=version, limit=100, offset=0)
        if not runs:
            raise errors.not_found(f"未找到版本号 {version!r} 的内部评测记录", version=version)
        selected_run_id = _str_param(query, "run_id") or runs[0]["run_id"]
        if not any(r["run_id"] == selected_run_id for r in runs):
            raise errors.not_found(f"版本 {version!r} 下不存在任务 {selected_run_id}", version=version, run_id=selected_run_id)

        selected = self._get_run(selected_run_id)
        compare_data = self._compare(selected_run_id, query)
        return {
            "version": version,
            "total_runs": total,
            "selected_run_id": selected_run_id,
            "selected_run": selected,
            "compare": compare_data,
            "runs": [
                {
                    "run_id": r["run_id"],
                    "round_dir_name": r["round_dir_name"],
                    "model": r["model"],
                    "tier": r["tier"],
                    "status": r["status"],
                    "before_agent": r["before_agent_label"],
                    "after_agent": r["after_agent_label"],
                    "created_at": r["created_at"],
                    "finished_at": r["finished_at"],
                }
                for r in runs
            ],
        }

    def _docs(self, name: str | None) -> dict[str, Any]:
        docs_dir = self.cfg.docs_dir.resolve()
        if name:
            path = (docs_dir / f"{name}.md").resolve()
            if path.parent != docs_dir or not path.is_file():
                raise errors.not_found("文档不存在", name=name)
            content = path.read_text(encoding="utf-8", errors="replace")
            return {
                "name": name,
                "title": _doc_title(content, name),
                "format": "markdown",
                "content": content,
                "updated_at": utc_rfc3339(datetime.fromtimestamp(path.stat().st_mtime, timezone.utc)),
            }

        docs = []
        if docs_dir.is_dir():
            for path in sorted(docs_dir.glob("*.md")):
                slug = path.stem
                content = path.read_text(encoding="utf-8", errors="replace")
                docs.append(
                    {
                        "name": slug,
                        "title": _doc_title(content, slug),
                        "url": f"{self.cfg.api_prefix}/docs/{quote(slug)}",
                        "updated_at": utc_rfc3339(datetime.fromtimestamp(path.stat().st_mtime, timezone.utc)),
                    }
                )
        return {"docs": docs}

    def _decorate_run(self, run: dict[str, Any]) -> dict[str, Any]:
        if not run:
            return run
        out = dict(run)
        if self.cfg.page_base_url and out.get("round_dir_name"):
            out["compare_page_url"] = f"{self.cfg.page_base_url}/compare/?product=aime&round={quote(out['round_dir_name'])}"
        else:
            out["compare_page_url"] = None
        return out


class _StandaloneServer(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 128


def create_app(
    cfg: ServiceConfig | None = None,
    *,
    engine=None,
    collector=None,
    start_worker: bool = True,
) -> InternalEvalApp:
    resolved_cfg = cfg or load_config()
    store = StateStore(resolved_cfg.state_db_path)
    pipeline = PipelineManager(
        resolved_cfg,
        store,
        engine=engine,
        collector=collector,
        start_worker=start_worker,
    )
    return InternalEvalApp(resolved_cfg, store, pipeline)


def serve_standalone(app: InternalEvalApp, *, host: str | None = None, port: int | None = None, log=print) -> None:
    bind_host = host or app.cfg.host
    bind_port = port or app.cfg.port

    class StandaloneHandler(BaseHTTPRequestHandler):
        server_version = "internal-eval-service/1.0"
        protocol_version = "HTTP/1.1"

        def log_message(self, fmt: str, *args: Any) -> None:  # noqa: A003
            log(f"[internal-eval][http] {self.address_string()} {fmt % args}")

        def do_GET(self) -> None:  # noqa: N802
            app.handle_http(self)

        def do_POST(self) -> None:  # noqa: N802
            app.handle_http(self)

    srv = _StandaloneServer((bind_host, bind_port), StandaloneHandler)
    log(f"[internal-eval] listening on http://{bind_host}:{bind_port}{app.cfg.api_prefix}")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        log("[internal-eval] 退出")
    finally:
        app.pipeline.stop()
        srv.server_close()
