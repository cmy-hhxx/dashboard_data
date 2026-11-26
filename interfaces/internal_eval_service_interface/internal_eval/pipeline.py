"""Background streaming pipeline orchestrator for internal evaluation runs.

Lifecycle per run:
    queued -> preparing_questions -> dispatching -> running -> finalizing
           -> succeeded | completed_with_errors | failed | cancelled

Streaming guarantee:
  - As soon as traces arrive (HTTP `/ingest` or `raw_traces/` file drop), they
    are cleaned via `eval_harness_pkg` and streamed through `evaluate_streaming`.
  - 0-problem (`GOLD`) traces become `ready` immediately (incrementing `change_seq`).
  - Problem traces trigger `cluster_pkg` immediately on the first evaluated trace
    and thereafter in adaptive micro-batches (count or time threshold), becoming
    `ready` as soon as each micro-batch completes.
"""

from __future__ import annotations

import json
import os
import secrets
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

from .ab_layout import (
    INPUT_FILENAME,
    SIDE_DIR,
    allocate_round_dir,
    init_round_layout,
    sync_round_manifests,
)
from .bench_sampler import sample_bench_targets, write_targets_and_dispatch_files
from .collectors import RawDirTailer, TraceCollectorAdapter, create_collector_adapter
from .compare import build_compare_payload
from .config import ALLOWED_MODELS, ALLOWED_SIDES, ServiceConfig
from .engines import (
    EngineBackend,
    VendoredEngineBackend,
    extract_attribution_result,
    extract_case_key,
    extract_trace_identity,
)
from .state_store import ACTIVE_RUN_STATUSES, TERMINAL_RUN_STATUSES, StateStore
from .timeutil import today_mmdd, utc_rfc3339


def _normalize_agent_spec(raw: Any, fallback_name: str) -> tuple[dict[str, Any], str]:
    if isinstance(raw, str):
        label = raw.strip() or fallback_name
        return {"name": label}, label
    if isinstance(raw, dict):
        obj = dict(raw)
        label = str(obj.get("name") or obj.get("version") or obj.get("id") or fallback_name).strip()
        obj.setdefault("name", label)
        return obj, label
    return {"name": fallback_name}, fallback_name


def _generate_run_id() -> str:
    stamp = time.strftime("%Y%m%d_%H%M%S", time.gmtime())
    return f"run_{stamp}_{secrets.token_hex(3)}"


class PipelineManager:
    """Manages queued/active runs, trace ingestion, streaming eval/cluster, and recovery."""

    def __init__(
        self,
        cfg: ServiceConfig,
        store: StateStore,
        *,
        engine: EngineBackend | None = None,
        collector: TraceCollectorAdapter | None = None,
        start_worker: bool = True,
    ):
        self.cfg = cfg
        self.store = store
        self.engine = engine or VendoredEngineBackend(cfg)
        self.collector = collector or create_collector_adapter(cfg)

        self._stop = threading.Event()
        self._wake = threading.Event()
        self._active_lock = threading.Lock()
        self._active_runs: dict[str, threading.Thread] = {}
        self._ingest_locks: dict[str, threading.Lock] = {}
        self._taxonomy_locks: dict[str, threading.Lock] = {}
        self._run_wakes: dict[str, threading.Event] = {}
        self._first_ready_sent: set[str] = set()
        self._worker_thread: threading.Thread | None = None

        if start_worker:
            self.start()

    def start(self) -> None:
        if self._worker_thread and self._worker_thread.is_alive():
            return
        self._stop.clear()
        if self.cfg.auto_resume_on_startup:
            self._recover_interrupted_runs()
        self._worker_thread = threading.Thread(
            target=self._scheduler_loop,
            daemon=True,
            name="internal-eval-scheduler",
        )
        self._worker_thread.start()
        self._wake.set()

    def stop(self, timeout: float = 5.0) -> None:
        self._stop.set()
        self._wake.set()
        for ev in list(self._run_wakes.values()):
            ev.set()
        if self._worker_thread and self._worker_thread.is_alive():
            self._worker_thread.join(timeout=timeout)
        with self._active_lock:
            threads = list(self._active_runs.values())
        for t in threads:
            if t.is_alive():
                t.join(timeout=timeout)

    def _recover_interrupted_runs(self) -> None:
        interrupted = self.store.list_runs_by_statuses(
            ("preparing_questions", "dispatching", "running", "finalizing", "cancelling")
        )
        for run in interrupted:
            run_id = run["run_id"]
            if run["cancel_requested"] or run["status"] == "cancelling":
                self.store.update_run(
                    run_id,
                    status="cancelled",
                    stage="cancelled",
                    finished_at=utc_rfc3339(),
                )
                self.store.add_event(
                    run_id, "recovery", "recovered_cancelled", "服务重启后已将取消中的任务置为 cancelled", level="warn"
                )
            else:
                self.store.update_run(run_id, status="queued", stage="resume_queued")
                self.store.add_event(
                    run_id, "recovery", "resume_queued", "检测到上次服务中断，任务已自动重新入队断点续跑", level="warn"
                )

    def _get_ingest_lock(self, run_id: str) -> threading.Lock:
        with self._active_lock:
            return self._ingest_locks.setdefault(run_id, threading.Lock())

    def _get_taxonomy_lock(self, run_id: str) -> threading.Lock:
        with self._active_lock:
            return self._taxonomy_locks.setdefault(run_id, threading.Lock())

    def _get_run_wake(self, run_id: str) -> threading.Event:
        with self._active_lock:
            return self._run_wakes.setdefault(run_id, threading.Event())

    # ---- Public API Actions ------------------------------------------------

    def submit_run(self, payload: dict[str, Any]) -> tuple[dict[str, Any], bool]:
        """Validate request and enqueue a new internal eval run.
        Returns `(run_dict, created_bool)` (created=False on idempotency replay).
        """
        idem_key = str(payload.get("idempotency_key") or "").strip()
        if idem_key:
            existing = self.store.get_run_by_idempotency_key(idem_key)
            if existing:
                return existing, False

        # Validate tier
        raw_tier = payload.get("tier", payload.get("count", payload.get("question_count")))
        if raw_tier is None or isinstance(raw_tier, bool):
            raise ValueError("缺少必填参数 tier（允许值：500、1000、5000、10000）")
        try:
            tier = int(raw_tier)
        except (TypeError, ValueError) as exc:
            raise ValueError(f"tier 必须是整数，收到：{raw_tier!r}") from exc
        if tier not in self.cfg.allowed_tiers:
            if not (self.cfg.allow_custom_tier and tier >= 1):
                raise ValueError(f"tier={tier} 不在允许范围 {list(self.cfg.allowed_tiers)} 内")

        # Validate model
        model = str(payload.get("model") or "aime_expert").strip()
        if model not in ALLOWED_MODELS:
            raise ValueError(f"model={model!r} 不在允许范围 {list(ALLOWED_MODELS)} 内")

        # Validate sides
        raw_sides = payload.get("sides")
        if raw_sides is None:
            sides = ["before", "after"]
        elif isinstance(raw_sides, str):
            sides = [s.strip() for s in raw_sides.split(",") if s.strip()]
        elif isinstance(raw_sides, list):
            sides = [str(s).strip() for s in raw_sides if str(s).strip()]
        else:
            raise ValueError("sides 必须是字符串列表（例如 [\"before\", \"after\"]）")
        if not sides or any(s not in ALLOWED_SIDES for s in sides):
            raise ValueError(f"sides 只能包含 {list(ALLOWED_SIDES)}，收到：{sides!r}")
        # Deduplicate preserving order
        sides = list(dict.fromkeys(sides))

        before_mode = str(payload.get("before_mode") or "live").strip().lower()
        if before_mode not in ("live", "historical"):
            raise ValueError("before_mode 只能是 'live' 或 'historical'")

        if "before" in sides and payload.get("before_agent") is None and before_mode == "live":
            raise ValueError("缺少必填参数 before_agent（发版前 agent 标识）")
        if "after" in sides and payload.get("after_agent") is None:
            raise ValueError("缺少必填参数 after_agent（改版后 agent 标识）")

        before_agent, before_label = _normalize_agent_spec(
            payload.get("before_agent"), "before_release_agent"
        )
        after_agent, after_label = _normalize_agent_spec(
            payload.get("after_agent"), "after_release_agent"
        )

        version = str(payload.get("version") or today_mmdd()).strip()
        callback_url = str(payload.get("callback_url") or "").strip() or None
        if callback_url and not (callback_url.startswith("http://") or callback_url.startswith("https://")):
            raise ValueError("callback_url 必须是有效的 http(s) URL")

        run_id = _generate_run_id()
        round_order, round_dir_name, round_dir = allocate_round_dir(self.cfg.ab_test_root, version, model)

        meta_payload = dict(payload["meta"]) if isinstance(payload.get("meta"), dict) else {}
        if isinstance(payload.get("task_manager"), dict):
            existing_tm = dict(meta_payload["task_manager"]) if isinstance(meta_payload.get("task_manager"), dict) else {}
            merged_tm = {**payload["task_manager"], **existing_tm}
            meta_payload["task_manager"] = merged_tm

        run = self.store.create_run(
            {
                "run_id": run_id,
                "idempotency_key": idem_key or None,
                "version": version,
                "round_order": round_order,
                "round_dir_name": round_dir_name,
                "round_dir_path": str(round_dir),
                "model": model,
                "tier": tier,
                "requested_count": tier,
                "sides": sides,
                "before_mode": before_mode,
                "before_agent": before_agent,
                "after_agent": after_agent,
                "before_agent_label": before_label,
                "after_agent_label": after_label,
                "callback_url": callback_url,
                "meta": meta_payload,
            }
        )
        self._wake.set()
        return run, True

    def cancel_run(self, run_id: str) -> dict[str, Any] | None:
        run = self.store.request_cancel(run_id)
        if run:
            try:
                self.collector.cancel(run)
            except Exception:
                pass
            self._get_run_wake(run_id).set()
        return run

    def retry_failed(
        self,
        run_id: str,
        *,
        stages: list[str] | None = None,
        sides: list[str] | None = None,
    ) -> dict[str, Any]:
        run = self.store.get_run(run_id)
        if not run:
            raise KeyError(run_id)
        if run["status"] in ACTIVE_RUN_STATUSES:
            raise RuntimeError(f"任务当前处于 {run['status']} 状态，请等待结束或先取消后再补跑")
        result = self.store.reset_failed_cases_for_retry(run_id, stages=stages, sides=sides)
        if result["reset_total"] > 0:
            self._wake.set()
        return result

    def ingest_traces(
        self,
        run_id: str,
        side: str,
        traces: list[dict[str, Any]],
        *,
        source_filename: str = "ingested.jsonl",
    ) -> dict[str, Any]:
        """Accept one or more raw traces from colleague push API or file drop."""
        run = self.store.get_run(run_id)
        if not run:
            raise KeyError(f"run_id 不存在：{run_id}")
        if side not in run["sides"]:
            raise ValueError(f"side={side!r} 不在本次任务 sides={run['sides']} 中")

        round_dir = Path(run["round_dir_path"])
        raw_dir = round_dir / ".work" / "raw_traces" / side
        raw_dir.mkdir(parents=True, exist_ok=True)
        store_file = raw_dir / f"_accepted_{side}.jsonl"
        target_map = self.store.get_target_map(run_id)

        accepted = 0
        duplicates = 0
        invalid_records: list[dict[str, Any]] = []

        lock = self._get_ingest_lock(run_id)
        with lock:
            with store_file.open("a", encoding="utf-8") as sink:
                for idx, raw in enumerate(traces):
                    if not isinstance(raw, dict) or "_invalid_json" in raw:
                        msg = "原始 trace 不是合法 JSON 对象"
                        self.store.mark_case_failed(
                            run_id,
                            side,
                            None,
                            stage="fetch",
                            error_code="INVALID_TRACE_JSON",
                            error_message=msg,
                            details={"index": idx, "source": source_filename},
                        )
                        invalid_records.append({"index": idx, "error": msg})
                        continue

                    case_key = extract_case_key(raw)
                    if not case_key and raw.get("eq_index") is not None:
                        try:
                            case_key = f"eq_{int(raw['eq_index']):05d}"
                        except (TypeError, ValueError):
                            case_key = None

                    if not case_key or case_key not in target_map:
                        msg = f"无法匹配本轮目标题 case_key={case_key!r}"
                        self.store.mark_case_failed(
                            run_id,
                            side,
                            None,
                            stage="fetch",
                            error_code="UNKNOWN_CASE_KEY",
                            error_message=msg,
                            details={"index": idx, "case_key": case_key},
                        )
                        invalid_records.append({"index": idx, "case_key": case_key, "error": msg})
                        continue

                    target = target_map[case_key]
                    trace_id, session_id, req_time = extract_trace_identity(raw)
                    if not trace_id:
                        trace_id = f"{run_id}_{side}_{case_key}"
                    if not session_id:
                        session_id = f"sess_{run_id}_{side}_{case_key}"
                    if not req_time:
                        req_time = utc_rfc3339()

                    # Normalize record so eval_harness_pkg & dashboard/ab_detail preserve `_eq_NNNNN`
                    normalized = dict(raw)
                    canonical_case_id = f"{run_id}_{side}_{case_key}"
                    normalized["case_id"] = canonical_case_id
                    normalized["case_key"] = case_key
                    normalized.setdefault("trace_id", trace_id)
                    normalized.setdefault("session_id", session_id)
                    normalized.setdefault("batch_id", run["version"])
                    agent_label = run["before_agent_label"] if side == "before" else run["after_agent_label"]
                    normalized.setdefault("version", agent_label)
                    normalized.setdefault("request_time", req_time)
                    meta = dict(normalized.get("meta")) if isinstance(normalized.get("meta"), dict) else {}
                    meta["case_id"] = canonical_case_id
                    meta["case_key"] = case_key
                    meta.setdefault("trace_id", trace_id)
                    meta.setdefault("session_id", session_id)
                    meta.setdefault("request_time", req_time)
                    meta.setdefault("question", target["question"])
                    meta.setdefault("question_text", target["question"])
                    meta.setdefault("agent_name", agent_label)
                    normalized["meta"] = meta
                    if isinstance(normalized.get("traces"), list) and normalized["traces"]:
                        new_traces: list[Any] = []
                        for tr in normalized["traces"]:
                            if isinstance(tr, dict):
                                tr_copy = dict(tr)
                                tr_meta = dict(tr_copy.get("meta")) if isinstance(tr_copy.get("meta"), dict) else {}
                                tr_meta["case_id"] = canonical_case_id
                                tr_meta["case_key"] = case_key
                                tr_meta.setdefault("trace_id", trace_id)
                                tr_meta.setdefault("session_id", session_id)
                                tr_meta.setdefault("request_time", req_time)
                                tr_meta.setdefault("question", target["question"])
                                tr_meta.setdefault("question_text", target["question"])
                                tr_copy["meta"] = tr_meta
                                new_traces.append(tr_copy)
                            else:
                                new_traces.append(tr)
                        normalized["traces"] = new_traces

                    is_new = self.store.mark_fetched(
                        run_id,
                        side,
                        case_key,
                        trace_id=trace_id,
                        session_id=session_id,
                        request_time=req_time,
                        raw_file=str(store_file),
                    )
                    if is_new:
                        sink.write(json.dumps(normalized, ensure_ascii=False, separators=(",", ":")) + "\n")
                        accepted += 1
                    else:
                        duplicates += 1
                sink.flush()

        if accepted > 0:
            cur_cs = run["side_collector_status"].get(side, "pending")
            if cur_cs in ("pending", "dispatched"):
                self.store.set_side_collector_status(run_id, side, "streaming")
            self._get_run_wake(run_id).set()

        return {
            "run_id": run_id,
            "side": side,
            "received": len(traces),
            "accepted": accepted,
            "duplicates": duplicates,
            "invalid": len(invalid_records),
            "invalid_details": invalid_records[:20],
        }

    def handle_collector_event(
        self,
        run_id: str,
        side: str,
        event_type: str,
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        """Handle upstream collector notifications: `case_failed`, `completed`, `partial`, `failed`."""
        run = self.store.get_run(run_id)
        if not run:
            raise KeyError(f"run_id 不存在：{run_id}")
        if side not in run["sides"]:
            raise ValueError(f"side={side!r} 不在本次任务 sides={run['sides']} 中")

        ev = (event_type or "").strip().lower()
        if ev == "case_failed":
            failed_items = payload.get("items")
            if not isinstance(failed_items, list):
                failed_items = [payload]
            recorded = 0
            for item in failed_items:
                if not isinstance(item, dict):
                    continue
                ck = str(item.get("case_key") or "").strip() or None
                self.store.mark_case_failed(
                    run_id,
                    side,
                    ck,
                    stage="fetch",
                    error_code=str(item.get("error_code") or "COLLECTOR_CASE_FAILED"),
                    error_message=str(item.get("error_message") or "上游拉取该题失败"),
                    trace_id=str(item.get("trace_id") or "") or None,
                    details=item,
                )
                recorded += 1
            self._get_run_wake(run_id).set()
            return {"run_id": run_id, "side": side, "event_type": ev, "recorded_failures": recorded}

        if ev in ("completed", "partial", "failed"):
            # Optional list of failed case_keys delivered alongside completion
            for item in payload.get("failed_cases") or []:
                if isinstance(item, dict):
                    ck = str(item.get("case_key") or "").strip() or None
                    self.store.mark_case_failed(
                        run_id,
                        side,
                        ck,
                        stage="fetch",
                        error_code=str(item.get("error_code") or "COLLECTOR_CASE_FAILED"),
                        error_message=str(item.get("error_message") or "上游上报拉取失败"),
                        details=item,
                    )
            self.store.set_side_collector_status(run_id, side, ev)
            self.store.add_event(
                run_id,
                "fetch",
                f"collector_{ev}",
                f"上游拉数 {side} 上报状态：{ev}",
                level="warn" if ev != "completed" else "info",
                side=side,
                details=payload,
            )
            self._get_run_wake(run_id).set()
            return {"run_id": run_id, "side": side, "event_type": ev, "collector_status": ev}

        raise ValueError(f"未知 collector event_type={event_type!r}（允许：case_failed、completed、partial、failed）")

    # ---- Scheduler & Worker Loop -------------------------------------------

    def _scheduler_loop(self) -> None:
        while not self._stop.is_set():
            self._wake.wait(timeout=1.0)
            self._wake.clear()
            if self._stop.is_set():
                break

            with self._active_lock:
                # Reap finished worker threads
                for rid, thread in list(self._active_runs.items()):
                    if not thread.is_alive():
                        self._active_runs.pop(rid, None)
                capacity = self.cfg.max_concurrent_runs - len(self._active_runs)

            while capacity > 0 and not self._stop.is_set():
                nxt = self.store.next_queued_run()
                if not nxt:
                    break
                run_id = nxt["run_id"]
                with self._active_lock:
                    if run_id in self._active_runs:
                        break
                    self.store.update_run(
                        run_id,
                        status="preparing_questions",
                        stage="preparing_questions",
                        started_at=nxt["started_at"] or utc_rfc3339(),
                    )
                    t = threading.Thread(
                        target=self._run_worker_safe,
                        args=(run_id,),
                        daemon=True,
                        name=f"internal-eval-run-{run_id}",
                    )
                    self._active_runs[run_id] = t
                    t.start()
                    capacity -= 1

    def _run_worker_safe(self, run_id: str) -> None:
        try:
            self._execute_run(run_id)
        except Exception as exc:  # noqa: BLE001
            self.store.mark_case_failed(
                run_id,
                "system",
                None,
                stage="system",
                error_code="PIPELINE_EXCEPTION",
                error_message=str(exc),
            )
            self.store.update_run(
                run_id,
                status="failed",
                stage="failed",
                error_code="PIPELINE_EXCEPTION",
                error_message=str(exc),
                finished_at=utc_rfc3339(),
            )
            self.store.add_event(
                run_id, "system", "pipeline_failed", f"流水线异常终止：{exc}", level="error"
            )
            self._notify_webhook(run_id, "failed")
        finally:
            self._wake.set()

    def _execute_run(self, run_id: str) -> None:
        run = self.store.get_run(run_id)
        if not run:
            return
        round_dir = Path(run["round_dir_path"])
        model = run["model"]
        sides = list(run["sides"])
        wake = self._get_run_wake(run_id)

        # ---- Stage 1: Prepare questions & ab_test layout --------------------
        layout = init_round_layout(
            round_dir=round_dir,
            version=run["version"],
            model=model,
            tier=run["tier"],
            before_agent_label=run["before_agent_label"],
            after_agent_label=run["after_agent_label"],
            run_id=run_id,
            base_taxonomy_dir=self.cfg.base_taxonomy_dir,
        )

        existing_targets = self.store.get_targets(run_id)
        if not existing_targets:
            targets, bench_meta = sample_bench_targets(
                self.cfg.bench_root,
                model,
                run["tier"],
                limit_override=run["requested_count"],
            )
            dispatch_files = write_targets_and_dispatch_files(
                run_id=run_id,
                version=run["version"],
                model=model,
                tier=run["tier"],
                sides=sides,
                before_agent=run["before_agent"],
                after_agent=run["after_agent"],
                targets=targets,
                targets_jsonl_path=layout["bench"] / "bench.jsonl",
                dispatch_dir=layout["dispatch"],
                split_mode=self.cfg.collector_dispatch_split,
            )
            self.store.save_targets(run_id, targets, sides)
            merged_meta = dict(run["meta"])
            merged_meta["bench_sampling"] = bench_meta
            self.store.update_run(
                run_id,
                dispatch_files=dispatch_files,
                meta=merged_meta,
            )
            self.store.add_event(
                run_id,
                "prepare_questions",
                "targets_ready",
                f"已从 bench 采样 {len(targets)} 题（单轮 {bench_meta['single_turn']} / 多轮 {bench_meta['multi_turn']}），生成下发文件 {list(dispatch_files.keys())}",
                details={"bench_sampling": bench_meta, "dispatch_files": dispatch_files},
            )
            self._refresh_manifests(run_id)
            run = self.store.get_run(run_id)  # type: ignore[assignment]
        else:
            dispatch_files = run["dispatch_files"]

        if self.store.is_cancel_requested(run_id) or self._stop.is_set():
            self._finish_cancelled(run_id)
            return

        # ---- Optional Historical Baseline for `before` ----------------------
        live_sides = list(sides)
        if "before" in live_sides and run["before_mode"] == "historical":
            self._populate_historical_before(run_id)
            live_sides.remove("before")

        # ---- Stage 2: Dispatch to TraceCollectorAdapter ---------------------
        self.store.update_run(run_id, status="dispatching", stage="dispatching")
        raw_dirs = {
            side: (layout["raw_before"] if side == "before" else layout["raw_after"])
            for side in live_sides
        }
        cancel_fn = lambda: self.store.is_cancel_requested(run_id) or self._stop.is_set()
        log_event_fn = lambda stage, ev_type, msg, level="info", details=None: self.store.add_event(
            run_id, stage, ev_type, msg, level=level, details=details
        )
        need_dispatch_sides = [
            s for s in live_sides if run["side_collector_status"].get(s, "pending") == "pending"
        ]
        resume_sides = [
            s for s in live_sides if run["side_collector_status"].get(s, "pending") in ("dispatched", "streaming")
        ]
        if need_dispatch_sides:
            dispatch_run_view = dict(run)
            dispatch_run_view["sides"] = need_dispatch_sides
            upstream_jobs = self.collector.dispatch(
                run=dispatch_run_view,
                dispatch_files=dispatch_files,
                raw_dirs={s: raw_dirs[s] for s in need_dispatch_sides},
                ingest_callback=lambda s, batch: self.ingest_traces(run_id, s, batch),
                event_callback=lambda s, ev, data: self.handle_collector_event(run_id, s, ev, data),
                cancel_check=cancel_fn,
                log_event=log_event_fn,
            )
            for s in need_dispatch_sides:
                self.store.set_side_collector_status(
                    run_id, s, "dispatched", upstream_job_id=upstream_jobs.get(s)
                )
            self.store.add_event(
                run_id,
                "dispatching",
                "collector_dispatched",
                f"已通过 {self.collector.mode} 适配器派单：{need_dispatch_sides}",
                details={"collector_mode": self.collector.mode, "upstream_jobs": upstream_jobs},
            )
        elif resume_sides:
            resume_run_view = dict(run)
            resume_run_view["sides"] = resume_sides
            self.collector.resume(
                run=resume_run_view,
                dispatch_files=dispatch_files,
                raw_dirs={s: raw_dirs[s] for s in resume_sides},
                ingest_callback=lambda s, batch: self.ingest_traces(run_id, s, batch),
                event_callback=lambda s, ev, data: self.handle_collector_event(run_id, s, ev, data),
                cancel_check=cancel_fn,
                log_event=log_event_fn,
            )

        # ---- Stage 3-5: Streaming Ingest -> Prepare -> Eval -> Cluster ------
        self.store.update_run(run_id, status="running", stage="streaming")
        tailers = {side: RawDirTailer(raw_dirs[side]) for side in live_sides}
        side_batch_seq = {side: 0 for side in live_sides}
        side_first_cluster_done = {side: False for side in live_sides}
        side_last_cluster_ts = {side: 0.0 for side in live_sides}
        last_activity_ts = time.monotonic()

        while not self._stop.is_set():
            if self.store.is_cancel_requested(run_id):
                self._finish_cancelled(run_id)
                return

            did_work = False

            for side in live_sides:
                # 1) Poll dropped files in raw_traces/<side>/
                dropped, done_sentinel = tailers[side].poll_new_records()
                if dropped:
                    # Ignore our own _accepted_<side>.jsonl sink file
                    external_records = [rec for fname, rec in dropped if not fname.startswith("_accepted_")]
                    if external_records:
                        self.ingest_traces(run_id, side, external_records, source_filename="file_drop")
                        did_work = True
                        last_activity_ts = time.monotonic()
                if done_sentinel:
                    cur_run = self.store.get_run(run_id)
                    if cur_run and cur_run["side_collector_status"].get(side) not in ("completed", "partial", "failed", "timeout"):
                        self.handle_collector_event(run_id, side, "completed", {"via": "done_sentinel"})
                        did_work = True

                # 2) Clean newly fetched traces via eval_harness_pkg.prepare_eval
                fetched_cases = self.store.get_side_cases(run_id, side=side, statuses=("fetched",))
                if fetched_cases:
                    did_work = True
                    last_activity_ts = time.monotonic()
                    side_batch_seq[side] += 1
                    self._prepare_side_batch(
                        run_id=run_id,
                        side=side,
                        batch_no=side_batch_seq[side],
                        cases=fetched_cases,
                        round_dir=round_dir,
                        model=model,
                    )

                # 3) Evaluate prepared traces via streaming eval_harness_pkg
                prepared_cases = self.store.get_side_cases(run_id, side=side, statuses=("prepared",))
                if prepared_cases:
                    did_work = True
                    last_activity_ts = time.monotonic()
                    self._evaluate_side_batch_streaming(
                        run_id=run_id,
                        side=side,
                        cases=prepared_cases,
                        round_dir=round_dir,
                        model=model,
                        first_cluster_done=side_first_cluster_done,
                        last_cluster_ts=side_last_cluster_ts,
                    )

                # 4) Flush any evaluated problem traces that meet micro-batch criteria
                flushed = self._maybe_cluster_side(
                    run_id=run_id,
                    side=side,
                    round_dir=round_dir,
                    model=model,
                    first_cluster_done=side_first_cluster_done,
                    last_cluster_ts=side_last_cluster_ts,
                    force=False,
                    allow_auto_leaf=False,
                )
                if flushed:
                    did_work = True
                    last_activity_ts = time.monotonic()

            # Check if all live sides are done collecting & processing
            cur_run = self.store.get_run(run_id)
            if not cur_run:
                return
            all_sides_done = True
            any_pending_fetch = False
            for side in live_sides:
                pending_fetch = len(self.store.get_side_cases(run_id, side=side, statuses=("pending_fetch",)))
                in_flight = len(
                    self.store.get_side_cases(
                        run_id,
                        side=side,
                        statuses=("fetched", "preparing", "prepared", "evaluating", "evaluated", "clustering"),
                    )
                )
                cs = cur_run["side_collector_status"].get(side, "pending")
                if pending_fetch == 0 and cs not in ("completed", "partial", "failed", "timeout"):
                    self.store.set_side_collector_status(run_id, side, "completed")
                    cs = "completed"
                if pending_fetch > 0:
                    any_pending_fetch = True
                if in_flight > 0 or (pending_fetch > 0 and cs not in ("completed", "partial", "failed", "timeout")):
                    all_sides_done = False

            if all_sides_done:
                # Mark any remaining pending_fetch (when collector signaled completed/partial/failed early)
                for side in live_sides:
                    leftovers = self.store.get_side_cases(run_id, side=side, statuses=("pending_fetch",))
                    for item in leftovers:
                        self.store.mark_case_failed(
                            run_id,
                            side,
                            item["case_key"],
                            stage="fetch",
                            error_code="COLLECTOR_MISSING_TRACE",
                            error_message="上游拉数已结束但未返回该题 trace",
                        )
                break

            # Upstream silence timeout check (suppressed while collector like TaskManager is actively polling)
            collector_active = bool(self.collector.is_active(run_id))
            if collector_active:
                last_activity_ts = time.monotonic()
            elif any_pending_fetch and (time.monotonic() - last_activity_ts) >= self.cfg.collector_silence_timeout_sec:
                for side in live_sides:
                    leftovers = self.store.get_side_cases(run_id, side=side, statuses=("pending_fetch",))
                    if leftovers:
                        for item in leftovers:
                            self.store.mark_case_failed(
                                run_id,
                                side,
                                item["case_key"],
                                stage="fetch",
                                error_code="FETCH_TIMEOUT",
                                error_message=f"超过 {int(self.cfg.collector_silence_timeout_sec)}s 未收到新 trace，自动超时收敛",
                            )
                        self.store.set_side_collector_status(run_id, side, "timeout")
                        self.store.add_event(
                            run_id,
                            "fetch",
                            "collector_timeout",
                            f"{side} 拉数静音超时，已将剩余 {len(leftovers)} 题记为 FETCH_TIMEOUT 并进入收尾",
                            level="warn",
                            side=side,
                        )
                continue

            if not did_work:
                wake.wait(timeout=self.cfg.collector_poll_interval_sec)
                wake.clear()

        if self.store.is_cancel_requested(run_id):
            self._finish_cancelled(run_id)
            return

        # ---- Stage 6: Finalize (final auto_leaf cluster + human_read + manifest sync) ----
        self.store.update_run(run_id, status="finalizing", stage="finalizing")
        for side in live_sides:
            self._maybe_cluster_side(
                run_id=run_id,
                side=side,
                round_dir=round_dir,
                model=model,
                first_cluster_done=side_first_cluster_done,
                last_cluster_ts=side_last_cluster_ts,
                force=True,
                allow_auto_leaf=self.cfg.cluster_final_auto_leaf,
            )
            self._run_human_read_side(run_id=run_id, side=side, round_dir=round_dir)

        self._refresh_manifests(run_id)
        prog = self.store.get_run_progress(run_id)
        assert prog is not None
        p = prog["progress"]
        if p["failed_units"] == 0 and p["rejected_units"] == 0:
            final_status = "succeeded"
        elif p["ready_units"] > 0:
            final_status = "completed_with_errors"
        else:
            final_status = "failed"

        self.store.update_run(
            run_id,
            status=final_status,
            stage=final_status,
            finished_at=utc_rfc3339(),
        )
        self.store.add_event(
            run_id,
            "finalizing",
            f"run_{final_status}",
            f"评测任务完成：{final_status}（ready={p['ready_units']}/{p['total_units']}, failed={p['failed_units']}, rejected={p['rejected_units']}）",
            level="info" if final_status == "succeeded" else "warn",
            details=p,
        )
        self._notify_webhook(run_id, final_status)

    # ---- Stage Helpers -----------------------------------------------------

    def _populate_historical_before(self, run_id: str) -> None:
        """Optional `before_mode=historical` support: reuse frozen bench severity/primary as before baseline."""
        run = self.store.get_run(run_id)
        if not run:
            return
        targets = self.store.get_targets(run_id)
        for t in targets:
            sev = t.get("bench_severity") or "GOLD"
            primary = t.get("bench_primary") or {}
            ck = t["case_key"]
            self.store.mark_fetched(
                run_id,
                "before",
                ck,
                trace_id=t["source_trace_id"] or f"hist_{ck}",
                session_id=t.get("source_session_id") or "",
                raw_file="historical_bench",
            )
            self.store.mark_prepared(run_id, "before", ck, prepared_file="historical_bench")
            if sev == "GOLD" or not primary.get("l3"):
                self.store.mark_evaluated(
                    run_id,
                    "before",
                    ck,
                    trace_id=t["source_trace_id"] or f"hist_{ck}",
                    session_id=t.get("source_session_id") or "",
                    attribution_file="historical_bench",
                    problems=[],
                )
            else:
                path = str(primary.get("l3") or primary.get("l2") or primary.get("l1") or "")
                self.store.mark_evaluated(
                    run_id,
                    "before",
                    ck,
                    trace_id=t["source_trace_id"] or f"hist_{ck}",
                    session_id=t.get("source_session_id") or "",
                    attribution_file="historical_bench",
                    problems=[{"severity": sev, "label": path, "component": "historical"}],
                )
                self.store.mark_clustered_ready(
                    run_id,
                    "before",
                    ck,
                    {0: {"path": path, "name": path, "edge": False}},
                    {path: path},
                )
        self.store.set_side_collector_status(run_id, "before", "completed")
        self.store.add_event(
            run_id,
            "before_historical",
            "historical_loaded",
            f"已复用 bench 历史基线作为 before 口径（共 {len(targets)} 题）",
            side="before",
        )
        self._refresh_manifests(run_id)

    def _prepare_side_batch(
        self,
        *,
        run_id: str,
        side: str,
        batch_no: int,
        cases: list[dict[str, Any]],
        round_dir: Path,
        model: str,
    ) -> None:
        run = self.store.get_run(run_id)
        assert run is not None
        want_keys = {c["case_key"] for c in cases}
        raw_sink = round_dir / ".work" / "raw_traces" / side / f"_accepted_{side}.jsonl"
        batch_raw = round_dir / ".work" / "raw_traces" / side / f"prepare_batch_{batch_no:04d}.jsonl"
        side_dir = round_dir / SIDE_DIR[side]
        prepared_out = round_dir / ".work" / "prepared" / side / f"prepared_{batch_no:04d}.jsonl"
        canonical_input = side_dir / INPUT_FILENAME[side]
        audit_out = round_dir / ".work" / "audit" / side / f"prepare_audit_{batch_no:04d}.jsonl"

        # Extract the exact subset of raw lines for this batch
        matched_records: dict[str, dict[str, Any]] = {}
        if raw_sink.is_file():
            with raw_sink.open("r", encoding="utf-8", errors="replace") as fh:
                for line in fh:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        obj = json.loads(line)
                    except ValueError:
                        continue
                    ck = extract_case_key(obj)
                    if ck in want_keys:
                        matched_records[ck] = obj

        for missing_ck in sorted(want_keys - set(matched_records)):
            self.store.mark_case_failed(
                run_id,
                side,
                missing_ck,
                stage="prepare",
                error_code="RAW_TRACE_MISSING",
                error_message="原始 trace 落盘记录缺失，无法进入清洗",
            )
        if not matched_records:
            return

        with batch_raw.open("w", encoding="utf-8") as fh:
            for ck in sorted(matched_records):
                fh.write(json.dumps(matched_records[ck], ensure_ascii=False, separators=(",", ":")) + "\n")

        agent_label = run["before_agent_label"] if side == "before" else run["after_agent_label"]
        try:
            report = self.engine.prepare(
                raw_input_path=batch_raw,
                output_path=prepared_out,
                audit_path=audit_out,
                batch_id=run["version"],
                version=agent_label,
            )
        except Exception as exc:  # noqa: BLE001
            for ck in matched_records:
                self.store.mark_case_failed(
                    run_id,
                    side,
                    ck,
                    stage="prepare",
                    error_code="PREPARE_ENGINE_ERROR",
                    error_message=str(exc),
                )
            self.store.add_event(
                run_id, "prepare", "prepare_failed", f"{side} 清洗批次 #{batch_no} 异常：{exc}", level="error", side=side
            )
            return

        # Identify which case_keys made it into prepared_out and append to canonical res_{before,after}_opt.jsonl
        accepted_keys: set[str] = set()
        if prepared_out.is_file():
            accepted_lines: list[str] = []
            with prepared_out.open("r", encoding="utf-8", errors="replace") as fh:
                for line in fh:
                    stripped = line.strip()
                    if not stripped:
                        continue
                    try:
                        obj = json.loads(stripped)
                    except ValueError:
                        continue
                    ck = extract_case_key(obj)
                    if ck in matched_records:
                        accepted_keys.add(ck)
                        accepted_lines.append(stripped)
            if accepted_lines:
                canonical_input.parent.mkdir(parents=True, exist_ok=True)
                with self._get_ingest_lock(run_id):
                    with canonical_input.open("a", encoding="utf-8") as cfh:
                        cfh.write("\n".join(accepted_lines) + "\n")

        for ck in accepted_keys:
            self.store.mark_prepared(run_id, side, ck, prepared_file=str(prepared_out))

        # Map audit rejection reasons back to rejected keys
        audit_by_ck: dict[str, dict[str, Any]] = {}
        for issue in report.get("audit_issues") or []:
            if not isinstance(issue, dict):
                continue
            if issue.get("severity") != "reject":
                continue
            ck = extract_case_key(issue)
            if not ck and issue.get("line"):
                # Map line number (1-indexed) to sorted matched_records key
                sorted_keys = sorted(matched_records)
                try:
                    lidx = int(issue["line"]) - 1
                    if 0 <= lidx < len(sorted_keys):
                        ck = sorted_keys[lidx]
                except (TypeError, ValueError):
                    pass
            if ck:
                audit_by_ck[ck] = issue

        rejected_keys = set(matched_records) - accepted_keys
        for ck in sorted(rejected_keys):
            issue = audit_by_ck.get(ck) or {}
            self.store.mark_case_failed(
                run_id,
                side,
                ck,
                stage="prepare",
                error_code=str(issue.get("reason") or "PREPARE_REJECTED"),
                error_message=str(issue.get("detail") or issue.get("message") or "未通过 eval_harness 数据准入校验"),
                rejected=True,
                details=issue,
            )

        self.store.add_event(
            run_id,
            "prepare",
            "prepare_batch_done",
            f"{side} 清洗完成：通过 {len(accepted_keys)} 条，拒绝 {len(rejected_keys)} 条",
            level="warn" if rejected_keys else "info",
            side=side,
            details={"accepted": len(accepted_keys), "rejected": len(rejected_keys)},
        )

    def _evaluate_side_batch_streaming(
        self,
        *,
        run_id: str,
        side: str,
        cases: list[dict[str, Any]],
        round_dir: Path,
        model: str,
        first_cluster_done: dict[str, bool],
        last_cluster_ts: dict[str, float],
    ) -> None:
        run = self.store.get_run(run_id)
        assert run is not None
        side_dir = round_dir / SIDE_DIR[side]
        attr_path = side_dir / "eval_output" / "attribution.jsonl"
        compact_path = side_dir / "eval_output" / "compact.jsonl"
        eval_audit = round_dir / ".work" / "audit" / side / "eval_audit.jsonl"

        # Group by prepared_file (usually 1 file per batch)
        by_file: dict[str, list[dict[str, Any]]] = {}
        for c in cases:
            pf = c.get("prepared_file") or ""
            if pf and Path(pf).is_file():
                by_file.setdefault(pf, []).append(c)
            else:
                self.store.mark_case_failed(
                    run_id,
                    side,
                    c["case_key"],
                    stage="eval",
                    error_code="PREPARED_FILE_MISSING",
                    error_message="清洗后的输入文件不存在，无法评测",
                )

        agent_label = run["before_agent_label"] if side == "before" else run["after_agent_label"]

        for prepared_file, batch_cases in by_file.items():
            if self.store.is_cancel_requested(run_id) or self._stop.is_set():
                return

            case_keys = [c["case_key"] for c in batch_cases]
            trace_to_ck = {c["trace_id"]: c["case_key"] for c in batch_cases if c.get("trace_id")}
            resolved_keys: set[str] = set()
            self.store.mark_evaluating(run_id, side, case_keys)

            def _on_row(row: dict[str, Any]) -> None:
                parsed = extract_attribution_result(row)
                ck = parsed["case_key"] or trace_to_ck.get(parsed["trace_id"])
                if not ck:
                    return
                resolved_keys.add(ck)
                became_ready_immediately = self.store.mark_evaluated(
                    run_id,
                    side,
                    ck,
                    trace_id=parsed["trace_id"],
                    session_id=parsed["session_id"],
                    attribution_file=str(attr_path),
                    problems=parsed["problems"],
                    attribution_summary=parsed["summary"],
                    is_correct=parsed["is_correct"],
                )
                if became_ready_immediately:
                    self._on_new_ready_trace(run_id)
                else:
                    # Trigger immediate clustering on first problem trace or micro-batch threshold!
                    self._maybe_cluster_side(
                        run_id=run_id,
                        side=side,
                        round_dir=round_dir,
                        model=model,
                        first_cluster_done=first_cluster_done,
                        last_cluster_ts=last_cluster_ts,
                        force=False,
                        allow_auto_leaf=False,
                    )

            def _on_case_error(case_id: str, err_msg: str) -> None:
                ck = extract_case_key({"case_id": case_id}) or trace_to_ck.get(case_id)
                if ck:
                    resolved_keys.add(ck)
                self.store.mark_case_failed(
                    run_id,
                    side,
                    ck,
                    stage="eval",
                    error_code="EVAL_CASE_FAILED",
                    error_message=err_msg,
                    details={"case_id": case_id},
                )

            try:
                self.engine.evaluate_streaming(
                    input_path=Path(prepared_file),
                    output_path=attr_path,
                    compact_output=compact_path,
                    audit_path=eval_audit,
                    batch_id=run["version"],
                    version=agent_label,
                    on_row=_on_row,
                    on_case_error=_on_case_error,
                    cancel_check=lambda: self.store.is_cancel_requested(run_id) or self._stop.is_set(),
                )
            except Exception as exc:  # noqa: BLE001
                for ck in case_keys:
                    if ck not in resolved_keys:
                        self.store.mark_case_failed(
                            run_id,
                            side,
                            ck,
                            stage="eval",
                            error_code="EVAL_ENGINE_ERROR",
                            error_message=str(exc),
                        )
                self.store.add_event(
                    run_id, "eval", "eval_error", f"{side} 评测引擎异常：{exc}", level="error", side=side
                )
                return

            # Any case neither succeeded nor explicitly failed after non-cancelled exit -> mark failed
            if not self.store.is_cancel_requested(run_id):
                for ck in case_keys:
                    if ck not in resolved_keys:
                        # Double check DB in case resumed/already written
                        sc = self.store.get_side_case(run_id, side, ck)
                        if sc and sc["status"] == "evaluating":
                            self.store.mark_case_failed(
                                run_id,
                                side,
                                ck,
                                stage="eval",
                                error_code="EVAL_NO_OUTPUT",
                                error_message="评测进程结束但未产出该样本归因结果",
                            )

            # Flush any newly evaluated problem traces right after batch finishes
            self._maybe_cluster_side(
                run_id=run_id,
                side=side,
                round_dir=round_dir,
                model=model,
                first_cluster_done=first_cluster_done,
                last_cluster_ts=last_cluster_ts,
                force=True,
                allow_auto_leaf=False,
            )

    def _maybe_cluster_side(
        self,
        *,
        run_id: str,
        side: str,
        round_dir: Path,
        model: str,
        first_cluster_done: dict[str, bool],
        last_cluster_ts: dict[str, float],
        force: bool,
        allow_auto_leaf: bool,
    ) -> bool:
        """Run incremental micro-batch clustering if threshold reached or forced."""
        pending = self.store.get_side_cases(run_id, side=side, statuses=("evaluated",))
        problem_pending = [c for c in pending if not c["is_gold"] and c["problem_count"] > 0]
        if not problem_pending:
            return False

        now_mono = time.monotonic()
        should_flush = (
            force
            or (not first_cluster_done.get(side, False))
            or len(problem_pending) >= self.cfg.cluster_microbatch_size
            or (now_mono - last_cluster_ts.get(side, 0.0)) >= self.cfg.cluster_microbatch_interval_sec
        )
        if not should_flush:
            return False

        side_dir = round_dir / SIDE_DIR[side]
        attr_file = side_dir / "eval_output" / "attribution.jsonl"
        tree_dir = side_dir / "cluster"
        shared_tax_dir = round_dir / ".work" / "taxonomy"

        if not attr_file.is_file() or attr_file.stat().st_size == 0:
            return False

        tax_lock = self._get_taxonomy_lock(run_id)
        with tax_lock:
            try:
                res = self.engine.cluster_incremental(
                    attribution_input=attr_file,
                    tree_dir=tree_dir,
                    shared_taxonomy_dir=shared_tax_dir,
                    allow_auto_leaf=allow_auto_leaf,
                )
            except Exception as exc:  # noqa: BLE001
                for c in problem_pending:
                    self.store.mark_case_failed(
                        run_id,
                        side,
                        c["case_key"],
                        stage="cluster",
                        error_code="CLUSTER_ENGINE_ERROR",
                        error_message=str(exc),
                        trace_id=c.get("trace_id"),
                    )
                self.store.add_event(
                    run_id, "cluster", "cluster_error", f"{side} 增量聚类失败：{exc}", level="error", side=side
                )
                return False

        assignments: dict[str, dict[int, dict[str, Any]]] = res.get("assignments") or {}
        leaf_names: dict[str, str] = res.get("leaf_names") or {}

        newly_ready = 0
        # Update all evaluated (and ready with pending_leaf) cases whose trace_id appears in assignments
        candidates = self.store.get_side_cases(run_id, side=side, statuses=("evaluated", "ready"))
        for c in candidates:
            if c["is_gold"] or c["problem_count"] <= 0:
                continue
            tid = c.get("trace_id") or ""
            hit = assignments.get(tid)
            if hit:
                if self.store.mark_clustered_ready(run_id, side, c["case_key"], hit, leaf_names):
                    newly_ready += 1
            elif c["status"] == "evaluated" and force:
                # Evaluated problem trace wasn't present in cluster item_index even after forced cluster
                self.store.mark_case_failed(
                    run_id,
                    side,
                    c["case_key"],
                    stage="cluster",
                    error_code="CLUSTER_ITEM_MISSING",
                    error_message="聚类完成但 item_index 中未找到该 trace 落点",
                    trace_id=tid or None,
                )

        first_cluster_done[side] = True
        last_cluster_ts[side] = time.monotonic()

        created_comps = len(res.get("created_components") or [])
        created_leaves = len(res.get("created_leaves") or [])
        self.store.increment_run_cluster_stats(
            run_id,
            batches=1,
            created_components=created_comps,
            created_leaves=created_leaves,
        )
        self.store.add_event(
            run_id,
            "cluster",
            "cluster_batch_done",
            f"{side} 增量聚类完成：本批新就绪 {newly_ready} 条（auto_leaf={allow_auto_leaf}, 新建组件={created_comps}, 新建叶子={created_leaves}）",
            side=side,
            details={
                "newly_ready": newly_ready,
                "new_items": res.get("new_items", 0),
                "total_items": res.get("total_items", 0),
                "created_components": created_comps,
                "created_leaves": created_leaves,
            },
        )
        if newly_ready > 0:
            self._on_new_ready_trace(run_id)
        return True

    def _run_human_read_side(self, *, run_id: str, side: str, round_dir: Path) -> None:
        side_dir = round_dir / SIDE_DIR[side]
        input_path = side_dir / INPUT_FILENAME[side]
        eval_dir = side_dir / "eval_output"
        attr_file = eval_dir / "attribution.jsonl"
        hr_output = eval_dir / "attribution_human_read.jsonl"
        compact_file = eval_dir / "compact.jsonl"
        work_dir = round_dir / ".work" / "human_read" / side

        if not attr_file.is_file() or attr_file.stat().st_size == 0:
            return
        try:
            summary = self.engine.human_read(
                input_path=input_path,
                attribution_path=attr_file,
                output_path=hr_output,
                work_dir=work_dir,
                compact_path=compact_file if compact_file.is_file() else None,
            )
            if not summary.get("skipped"):
                self.store.add_event(
                    run_id,
                    "human_read",
                    "human_read_done",
                    f"{side} 人话归因翻译完成（copied={bool(summary.get('copied'))}）",
                    side=side,
                    details=summary,
                )
        except Exception as exc:  # noqa: BLE001
            self.store.add_event(
                run_id,
                "human_read",
                "human_read_warn",
                f"{side} 人话归因翻译失败（不影响主评测收敛）：{exc}",
                level="warn",
                side=side,
            )

    def _on_new_ready_trace(self, run_id: str) -> None:
        self._refresh_manifests(run_id)
        if run_id not in self._first_ready_sent:
            self._first_ready_sent.add(run_id)
            self.store.add_event(
                run_id,
                "streaming",
                "first_ready",
                "首条评测并聚类完成的结果已对外可查",
            )
            self._notify_webhook(run_id, "first_ready")

    def _refresh_manifests(self, run_id: str) -> None:
        run = self.store.get_run(run_id)
        if not run:
            return
        targets = self.store.get_targets(run_id)
        if not targets:
            return
        before_cases = {c["case_key"]: c for c in self.store.get_side_cases(run_id, side="before")}
        after_cases = {c["case_key"]: c for c in self.store.get_side_cases(run_id, side="after")}
        cmp_payload = build_compare_payload(
            run=run,
            targets=targets,
            before_cases=before_cases,
            after_cases=after_cases,
        )
        try:
            sync_round_manifests(
                round_dir=Path(run["round_dir_path"]),
                run=run,
                targets=targets,
                before_cases=before_cases,
                after_cases=after_cases,
                compare_payload=cmp_payload,
            )
        except Exception as exc:  # noqa: BLE001
            self.store.add_event(
                run_id, "manifest", "manifest_sync_warn", f"刷新 ab_test 清单告警：{exc}", level="warn"
            )

    def _finish_cancelled(self, run_id: str) -> None:
        self._refresh_manifests(run_id)
        self.store.update_run(
            run_id,
            status="cancelled",
            stage="cancelled",
            finished_at=utc_rfc3339(),
        )
        self.store.add_event(
            run_id, "cancel", "run_cancelled", "任务已安全取消，已评测并聚类的数据保留可查", level="warn"
        )
        self._notify_webhook(run_id, "cancelled")

    def _notify_webhook(self, run_id: str, milestone: str) -> None:
        run = self.store.get_run(run_id)
        if not run or not run.get("callback_url"):
            return
        url = run["callback_url"]
        prog = self.store.get_run_progress(run_id)
        body = json.dumps(
            {
                "event": milestone,
                "run_id": run_id,
                "version": run["version"],
                "status": run["status"],
                "progress": prog["progress"] if prog else {},
                "timestamp": utc_rfc3339(),
            },
            ensure_ascii=False,
        ).encode("utf-8")

        def _send() -> None:
            for attempt in range(max(1, self.cfg.webhook_retries)):
                try:
                    req = urllib.request.Request(
                        url,
                        data=body,
                        headers={"Content-Type": "application/json"},
                        method="POST",
                    )
                    with urllib.request.urlopen(req, timeout=self.cfg.webhook_timeout_sec):
                        return
                except (urllib.error.URLError, TimeoutError, OSError) as exc:
                    if attempt + 1 >= max(1, self.cfg.webhook_retries):
                        self.store.add_event(
                            run_id,
                            "webhook",
                            "webhook_failed",
                            f"Webhook 通知 {milestone} 失败（已忽略，不影响主任务）：{exc}",
                            level="warn",
                        )
                    else:
                        time.sleep(min(2.0 ** attempt, 5.0))

        threading.Thread(target=_send, daemon=True, name=f"webhook-{run_id}-{milestone}").start()
