"""HTTP Gateway for the Unified 5003 Data Core (`/api/v1/data-core/*`).

Mounted cleanly inside 5003 (`analysis_api/server.py`) alongside `/api/v1/analysis/*`
and `/api/v1/internal-eval/*`. Provides a single-writer HTTP endpoint so all
evaluation pipelines (Step 1..4, external human_read, cluster, future clients)
write exclusively through one serialized CephFS pack writer + PG 16 transaction.
"""

from __future__ import annotations

import json
import os
import secrets
import traceback
from datetime import date, datetime
from typing import Any
from urllib.parse import parse_qs, urlparse

from .config import load_config
from .core import DataCore
from .reconcile import reconcile_tails

PREFIX = "/api/v1/data-core"


def _json_default(obj: Any) -> str:
    if isinstance(obj, (datetime, date)):
        return obj.isoformat()
    return str(obj)


def _parse_csv(raw: str | None) -> list[str]:
    if not raw:
        return []
    return list(dict.fromkeys(p.strip() for p in str(raw).split(",") if p.strip()))


def _parse_bool(val: Any, default: bool = False) -> bool:
    if val is None:
        return default
    if isinstance(val, bool):
        return val
    return str(val).strip().lower() in ("1", "true", "yes")


def _parse_int(val: Any, default: int, *, lo: int | None = None, hi: int | None = None, name: str = "param") -> int:
    if val is None or val == "":
        n = default
    elif isinstance(val, bool):
        raise ValueError(f"{name} must be an integer")
    else:
        try:
            n = int(val)
        except (TypeError, ValueError) as exc:
            raise ValueError(f"{name} must be an integer") from exc
    if lo is not None:
        n = max(lo, n)
    if hi is not None:
        n = min(hi, n)
    return n


def _parse_tokens(raw: str) -> set[str]:
    out: set[str] = set()
    for part in (raw or "").split(","):
        p = part.strip()
        if not p:
            continue
        if ":" in p:
            _, tok = p.split(":", 1)
            tok = tok.strip()
            if tok:
                out.add(tok)
        else:
            out.add(p)
    return out


class DataCoreHTTPApp:
    """Thread-safe HTTP adapter around `DataCore` for 5003 mounting."""

    def __init__(self, *, data_root: str | None = None, log=print):
        self.log = log
        self.cfg = load_config(role="rw", data_root=data_root)
        self.admin_cfg = load_config(role="admin", data_root=data_root)
        self.dc = DataCore(self.cfg, min_pool=2, max_pool=16)
        raw_toks = os.environ.get("DATA_CORE_API_TOKENS") or os.environ.get("INTERNAL_EVAL_API_TOKENS") or ""
        self.tokens = _parse_tokens(raw_toks)
        self.allow_localhost = os.environ.get("DATA_CORE_ALLOW_LOCALHOST", "true").lower() in ("1", "true", "yes")
        self.log(
            f"[data-core] mounted {PREFIX} -> PG {self.cfg.pg_host}:{self.cfg.pg_port}/{self.cfg.pg_database} "
            f"(data_root={self.cfg.data_root})"
        )

    def can_handle(self, path: str) -> bool:
        return path == PREFIX or path.startswith(PREFIX + "/")

    def _authorized(self, handler) -> bool:
        if not self.tokens:
            return True
        if self.allow_localhost:
            client_ip = (handler.client_address[0] if handler.client_address else "") or ""
            if client_ip in ("127.0.0.1", "::1"):
                return True
        auth = (handler.headers.get("Authorization") or "").strip()
        if auth.lower().startswith("bearer "):
            tok = auth[7:].strip()
            return any(secrets.compare_digest(tok, valid) for valid in self.tokens)
        x_tok = (handler.headers.get("X-Api-Token") or "").strip()
        if x_tok:
            return any(secrets.compare_digest(x_tok, valid) for valid in self.tokens)
        return False

    @staticmethod
    def _send_json(handler, status: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":"), default=_json_default).encode("utf-8", "replace")
        handler.send_response(status)
        handler.send_header("Content-Type", "application/json; charset=utf-8")
        handler.send_header("Content-Length", str(len(body)))
        handler.send_header("Cache-Control", "no-store")
        handler.end_headers()
        try:
            handler.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    @staticmethod
    def _read_json(handler) -> dict[str, Any]:
        length = int(handler.headers.get("Content-Length") or 0)
        if length <= 0:
            return {}
        raw = handler.rfile.read(length)
        data = json.loads(raw.decode("utf-8"))
        if not isinstance(data, dict):
            raise ValueError("JSON body must be an object")
        return data

    def handle_http(self, handler) -> None:
        req_id = "dc_" + secrets.token_hex(6)
        parsed = urlparse(handler.path)
        tail = parsed.path[len(PREFIX) :].rstrip("/") or "/"
        query = {k: v[-1] for k, v in parse_qs(parsed.query).items() if v}

        try:
            # Health endpoint is always readable
            if handler.command == "GET" and tail in ("/health", "/healthz"):
                with self.dc.db.connection() as conn:
                    counts = conn.execute(
                        """
                        SELECT
                            (SELECT COUNT(*) FROM public.pack_files) AS pack_files,
                            (SELECT COUNT(*) FROM public.eval_inputs WHERE NOT is_deleted) AS eval_inputs,
                            (SELECT COUNT(*) FROM public.eval_outputs WHERE is_latest) AS eval_outputs,
                            (SELECT COUNT(*) FROM public.eval_problems) AS eval_problems,
                            (SELECT COUNT(*) FROM public.human_read_overlays WHERE status = 'done') AS human_read_overlays,
                            (SELECT COALESCE(MAX(seq), 0) FROM public.changes) AS latest_seq
                        """
                    ).fetchone()
                self._send_json(
                    handler,
                    200,
                    {
                        "request_id": req_id,
                        "ok": True,
                        "db_epoch": self.dc.db_epoch,
                        "data_root": str(self.cfg.data_root),
                        "pg": f"{self.cfg.pg_host}:{self.cfg.pg_port}/{self.cfg.pg_database}",
                        "counts": dict(counts),
                    },
                )
                return

            if not self._authorized(handler):
                self._send_json(handler, 401, {"request_id": req_id, "error": {"code": "UNAUTHORIZED", "message": "missing or invalid token"}})
                return

            if handler.command == "GET" and tail.startswith("/detail/"):
                iid = int(tail[len("/detail/") :])
                text_mode = query.get("text_mode", "raw")
                detail = self.dc.read_daily_detail(iid, text_mode=text_mode)
                self._send_json(handler, 200, {"request_id": req_id, "data": detail})
                return

            if handler.command == "GET" and tail == "/human-read/pending":
                items = self.dc.list_pending_human_read(
                    models=_parse_csv(query.get("models")) or None,
                    dates=_parse_csv(query.get("dates")) or None,
                    kinds=_parse_csv(query.get("kinds")) or None,
                    prompt_version=query.get("prompt_version") or "",
                    include_failed=_parse_bool(query.get("include_failed"), False),
                    limit=_parse_int(query.get("limit"), 100, lo=1, hi=500, name="limit"),
                )
                self._send_json(handler, 200, {"request_id": req_id, "data": {"items": items}})
                return

            if handler.command == "GET" and tail == "/monitor/summary":
                summary = self.dc.get_monitor_summary(models=_parse_csv(query.get("models")) or None)
                self._send_json(handler, 200, {"request_id": req_id, "data": summary})
                return

            if handler.command != "POST":
                self._send_json(handler, 405, {"request_id": req_id, "error": {"code": "METHOD_NOT_ALLOWED", "message": handler.command}})
                return

            body = self._read_json(handler)

            if tail == "/inputs":
                model = str(body.get("model") or "").strip()
                if not model:
                    raise ValueError("model is required")
                source = str(body.get("source") or "prelaunch")
                records = body.get("records") if isinstance(body.get("records"), list) else [body["record"]]
                results = []
                for rec in records:
                    r = self.dc.ingest_daily_input(rec, model, source=source, fallback_day=body.get("fallback_day"))
                    results.append({"input_id": r["input_id"], "deduplicated": r["deduplicated"]})
                self._send_json(handler, 200, {"request_id": req_id, "data": {"count": len(results), "items": results}})
                return

            if tail == "/inputs/claim":
                claimed = self.dc.claim_pending_inputs(
                    model=body.get("model"),
                    models=body.get("models"),
                    worker_id=str(body.get("worker_id") or "worker"),
                    limit=_parse_int(body.get("limit"), 10, lo=1, hi=200, name="limit"),
                    lease_seconds=_parse_int(body.get("lease_seconds"), 600, lo=30, hi=86400, name="lease_seconds"),
                    strategy=str(body.get("strategy") or "newest_first"),
                    priority_days=_parse_int(body.get("priority_days"), 7, lo=1, hi=60, name="priority_days"),
                    biz_day=body.get("biz_day"),
                    include_payload=_parse_bool(body.get("include_payload"), False),
                )
                self._send_json(handler, 200, {"request_id": req_id, "data": {"claimed": claimed}})
                return

            if tail == "/inputs/heartbeat":
                res = self.dc.heartbeat_inputs(
                    worker_id=str(body.get("worker_id") or ""),
                    input_ids=body.get("input_ids"),
                    lease_seconds=_parse_int(body.get("lease_seconds"), 900, lo=30, hi=86400, name="lease_seconds"),
                )
                self._send_json(handler, 200, {"request_id": req_id, "data": res})
                return

            if tail == "/inputs/release":
                res = self.dc.release_inputs(
                    worker_id=str(body.get("worker_id") or ""),
                    input_ids=body.get("input_ids"),
                    decrement_attempts=_parse_bool(body.get("decrement_attempts"), True),
                )
                self._send_json(handler, 200, {"request_id": req_id, "data": res})
                return

            if tail == "/inputs/fail":
                results = self.dc.fail_inputs(
                    worker_id=str(body.get("worker_id") or ""),
                    items=body.get("items"),
                    max_attempts=_parse_int(body.get("max_attempts"), 3, lo=1, name="max_attempts"),
                )
                self._send_json(handler, 200, {"request_id": req_id, "data": {"results": results}})
                return

            if tail == "/outputs":
                model = str(body.get("model") or "").strip()
                if not model or "attribution" not in body:
                    raise ValueError("model and attribution are required")
                oids = self.dc.commit_daily_output(
                    body["attribution"],
                    model,
                    compact_record=body.get("compact"),
                    evaluator_version=str(body.get("evaluator_version") or "v1"),
                    judge_model=body.get("judge_model"),
                    eval_duration_ms=body.get("eval_duration_ms"),
                    eval_cost_usd=body.get("eval_cost_usd"),
                    input_id=body.get("input_id"),
                    fallback_day=body.get("fallback_day"),
                )
                self._send_json(handler, 200, {"request_id": req_id, "data": {"output_ids": oids}})
                return

            if tail == "/human-read":
                target_kind = str(body.get("target_kind") or "attribution")
                hr_record = body.get("record")
                if not isinstance(hr_record, dict):
                    raise ValueError("record object is required")
                oid = body.get("output_id")
                if oid is None:
                    model = str(body.get("model") or "").strip()
                    trace_id = str(body.get("trace_id") or "").strip()
                    if not model or not trace_id:
                        raise ValueError("output_id or (model, trace_id) is required")
                    with self.dc.db.connection() as conn:
                        row = conn.execute(
                            "SELECT output_id FROM public.eval_outputs WHERE model=%s AND trace_id=%s AND is_latest=TRUE",
                            (model, trace_id),
                        ).fetchone()
                    if not row:
                        raise KeyError(f"latest output not found for ({model}, {trace_id})")
                    oid = int(row["output_id"])
                res = self.dc.commit_human_read_overlay(output_id=int(oid), hr_record=hr_record, target_kind=target_kind)
                self._send_json(handler, 200, {"request_id": req_id, "data": res})
                return

            if tail == "/human-read/fail":
                res = self.dc.fail_human_read_overlay(
                    output_id=body.get("output_id"),
                    target_kind=str(body.get("target_kind") or "").strip(),
                    prompt_version=body.get("prompt_version"),
                    translator_model=body.get("translator_model"),
                    source_hash=body.get("source_hash"),
                    error=str(body.get("error") or ""),
                )
                self._send_json(handler, 200, {"request_id": req_id, "data": res})
                return

            if tail == "/categories":
                items = body.get("items") or []
                overwrite = bool(body.get("overwrite", False))
                updated = 0
                for it in items:
                    ok = self.dc.update_category(
                        model=str(it["model"]),
                        trace_id=str(it["trace_id"]),
                        task_category=it.get("task_category"),
                        subtask_category=it.get("subtask_category"),
                        overwrite=overwrite,
                    )
                    if ok:
                        updated += 1
                self._send_json(handler, 200, {"request_id": req_id, "data": {"requested": len(items), "updated": updated}})
                return

            if tail == "/clusters/bind":
                bindings = body.get("bindings") or []
                stats = self.dc.bind_problem_clusters(
                    bindings,
                    tree_id=body.get("tree_id"),
                    cluster_version=body.get("cluster_version"),
                    data_cutoff=body.get("data_cutoff"),
                    return_stats=True,
                )
                self._send_json(handler, 200, {"request_id": req_id, "data": stats})
                return

            if tail == "/reconcile":
                lookback = int(body.get("lookback_minutes") or 60)
                rep = reconcile_tails(self.dc, lookback_minutes=lookback)
                self._send_json(handler, 200, {"request_id": req_id, "data": rep})
                return

            if tail == "/views/refresh":
                with DataCore(self.admin_cfg, min_pool=1, max_pool=2) as adc:
                    timings = adc.refresh_stats_views(concurrently=bool(body.get("concurrently", True)))
                self._send_json(handler, 200, {"request_id": req_id, "data": {"timings": timings}})
                return

            self._send_json(handler, 404, {"request_id": req_id, "error": {"code": "NOT_FOUND", "message": tail}})
        except KeyError as exc:
            self._send_json(handler, 404, {"request_id": req_id, "error": {"code": "NOT_FOUND", "message": str(exc)}})
        except ValueError as exc:
            self._send_json(handler, 422, {"request_id": req_id, "error": {"code": "INVALID_PARAM", "message": str(exc)}})
        except Exception as exc:  # noqa: BLE001
            self.log(f"[data-core] error {tail}: {exc}\n{traceback.format_exc()}")
            self._send_json(handler, 500, {"request_id": req_id, "error": {"code": "INTERNAL_ERROR", "message": str(exc)}})


def build_data_core_http_app(*, data_root: str | None = None, log=print) -> DataCoreHTTPApp:
    return DataCoreHTTPApp(data_root=data_root, log=log)
