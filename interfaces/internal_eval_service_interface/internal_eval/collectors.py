"""Pluggable TraceCollectorAdapter implementations for the upstream data-fetch stage.

Supports four modes seamlessly:
  1. `file_drop`:
     Writes dispatch JSONL files (`before_questions.jsonl`, `after_questions.jsonl`)
     and `DISPATCH_MANIFEST.json`, then monitors `98_service/raw_traces/{before,after}/`
     for dropped `.jsonl` files (plus optional `_DONE` sentinel) AND accepts HTTP `/ingest`.
  2. `http`:
     POSTs the dispatch job (with paths to the two JSONL files + callback URLs) to a
     custom HTTP endpoint (`{collector_base_url}/submit`), while still monitoring
     `raw_traces/` and accepting HTTP `/ingest` & `/collector-events`.
  3. `task_manager`:
     Integrates directly with the TaskManager inference API (`/api/v1/task`):
       POST /testsets (+ /append) -> POST /tasks -> POST /tasks/{id}/start
       -> poll progress & stream newly completed judge records into `/ingest`
       -> auto-recover via retry-recall / fill_missing / reset_failed
       -> cancel propagation & breakpoint resume across service restarts.
  4. `mock`:
     Streams synthetic valid traces gradually for local/CI demos and end-to-end tests.
"""

from __future__ import annotations

import json
import os
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Callable

from .config import ServiceConfig
from .engines import extract_case_key
from .task_manager import (
    TaskManagerClient,
    TaskManagerError,
    _looks_like_recall_error,
    build_pipeline_and_step_map,
    build_testset_cases,
    judge_record_to_eval_trace,
    normalize_task_manager_base_url,
)
from .timeutil import utc_rfc3339

LogEventFn = Callable[[str, str, str, str, dict[str, Any] | None], None]


class TraceCollectorAdapter:
    mode: str = "base"

    def dispatch(
        self,
        *,
        run: dict[str, Any],
        dispatch_files: dict[str, str],
        raw_dirs: dict[str, Path],
        ingest_callback: Callable[[str, list[dict[str, Any]]], dict[str, Any]],
        event_callback: Callable[[str, str, dict[str, Any]], None],
        cancel_check: Callable[[], bool] | None = None,
        log_event: LogEventFn | None = None,
    ) -> dict[str, str]:
        """Dispatch the prepared question JSONLs to the upstream trace collector.
        Returns `{side: upstream_job_id}`.
        """
        raise NotImplementedError

    def resume(
        self,
        *,
        run: dict[str, Any],
        dispatch_files: dict[str, str],
        raw_dirs: dict[str, Path],
        ingest_callback: Callable[[str, list[dict[str, Any]]], dict[str, Any]],
        event_callback: Callable[[str, str, dict[str, Any]], None],
        cancel_check: Callable[[], bool] | None = None,
        log_event: LogEventFn | None = None,
    ) -> None:
        """Optional hook called when a run resumes after service restart with active sides."""
        return

    def cancel(self, run: dict[str, Any]) -> None:
        """Optional hook called when a run is cancelled to abort upstream inference."""
        return


def _write_dispatch_manifest(
    *,
    run: dict[str, Any],
    dispatch_files: dict[str, str],
    raw_dirs: dict[str, Path],
    api_prefix: str,
) -> Path:
    round_dir = Path(run["round_dir_path"])
    manifest_path = round_dir / "98_service" / "dispatch" / "DISPATCH_MANIFEST.json"
    payload = {
        "run_id": run["run_id"],
        "version": run["version"],
        "model": run["model"],
        "tier": run["tier"],
        "actual_count": run["actual_count"],
        "sides": run["sides"],
        "before_agent": run["before_agent"],
        "after_agent": run["after_agent"],
        "dispatch_files": dispatch_files,
        "raw_trace_drop_dirs": {side: str(path) for side, path in raw_dirs.items()},
        "done_sentinel_filename": "_DONE",
        "http_callbacks": {
            "ingest": f"{api_prefix}/runs/{run['run_id']}/ingest",
            "collector_events": f"{api_prefix}/runs/{run['run_id']}/collector-events",
        },
        "created_at": utc_rfc3339(),
    }
    tmp = manifest_path.parent / f".{manifest_path.name}.tmp"
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(tmp, manifest_path)
    return manifest_path


class FileDropCollectorAdapter(TraceCollectorAdapter):
    """Writes dispatch JSONLs & manifest, waits for file drops or HTTP pushes."""

    mode = "file_drop"

    def __init__(self, cfg: ServiceConfig):
        self.cfg = cfg

    def dispatch(
        self,
        *,
        run: dict[str, Any],
        dispatch_files: dict[str, str],
        raw_dirs: dict[str, Path],
        ingest_callback: Callable[[str, list[dict[str, Any]]], dict[str, Any]],
        event_callback: Callable[[str, str, dict[str, Any]], None],
        cancel_check: Callable[[], bool] | None = None,
        log_event: LogEventFn | None = None,
    ) -> dict[str, str]:
        _write_dispatch_manifest(
            run=run,
            dispatch_files=dispatch_files,
            raw_dirs=raw_dirs,
            api_prefix=self.cfg.api_prefix,
        )
        return {side: f"filedrop_{run['run_id']}_{side}" for side in run["sides"]}


class HttpCollectorAdapter(TraceCollectorAdapter):
    """Calls colleague's async HTTP submit endpoint with the two JSONL paths and callback URLs."""

    mode = "http"

    def __init__(self, cfg: ServiceConfig):
        self.cfg = cfg

    def dispatch(
        self,
        *,
        run: dict[str, Any],
        dispatch_files: dict[str, str],
        raw_dirs: dict[str, Path],
        ingest_callback: Callable[[str, list[dict[str, Any]]], dict[str, Any]],
        event_callback: Callable[[str, str, dict[str, Any]], None],
        cancel_check: Callable[[], bool] | None = None,
        log_event: LogEventFn | None = None,
    ) -> dict[str, str]:
        manifest_path = _write_dispatch_manifest(
            run=run,
            dispatch_files=dispatch_files,
            raw_dirs=raw_dirs,
            api_prefix=self.cfg.api_prefix,
        )
        if not self.cfg.collector_base_url:
            raise RuntimeError("COLLECTOR_MODE=http 但未配置 INTERNAL_EVAL_COLLECTOR_BASE_URL")

        submit_url = f"{self.cfg.collector_base_url}/submit"
        body = {
            "run_id": run["run_id"],
            "version": run["version"],
            "model": run["model"],
            "tier": run["tier"],
            "sides": run["sides"],
            "before_agent": run["before_agent"],
            "after_agent": run["after_agent"],
            "dispatch_files": dispatch_files,
            "dispatch_manifest": str(manifest_path),
            "raw_trace_drop_dirs": {side: str(path) for side, path in raw_dirs.items()},
            "ingest_path": f"{self.cfg.api_prefix}/runs/{run['run_id']}/ingest",
            "events_path": f"{self.cfg.api_prefix}/runs/{run['run_id']}/collector-events",
        }
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        headers = {"Content-Type": "application/json"}
        if self.cfg.collector_token:
            headers["Authorization"] = f"Bearer {self.cfg.collector_token}"

        req = urllib.request.Request(submit_url, data=data, headers=headers, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                resp_data = json.loads(resp.read().decode("utf-8", "replace") or "{}")
        except (urllib.error.URLError, TimeoutError, ValueError) as exc:
            raise RuntimeError(f"派单给数据拉取接口失败 ({submit_url}): {exc}") from exc

        jobs: dict[str, str] = {}
        resp_jobs = resp_data.get("jobs") if isinstance(resp_data, dict) else None
        for side in run["sides"]:
            if isinstance(resp_jobs, dict) and resp_jobs.get(side):
                jobs[side] = str(resp_jobs[side])
            elif isinstance(resp_data, dict) and resp_data.get("job_id"):
                jobs[side] = f"{resp_data['job_id']}:{side}"
            else:
                jobs[side] = f"http_{run['run_id']}_{side}"
        return jobs


class TaskManagerCollectorAdapter(TraceCollectorAdapter):
    """End-to-end streaming adapter for TaskManager (`/api/v1/task`).

    Lifecycle:
      1. `dispatch`: creates chunked testset, builds multi-step pipeline (one step per
         live side), creates & starts TaskManager task, persists `TASK_MANAGER_STATE.json`,
         and spawns a background streaming poller thread.
      2. Streaming poller: periodically checks TaskManager task/items, pulls newly
         completed judge records (targeted query for small batches, paginated bulk for
         large batches), converts them into `eval_harness` Adapter `b` traces, and pushes
         immediately into `ingest_callback` so evaluation & clustering run in parallel
         with ongoing inference.
      3. Auto-recovery: if TaskManager finishes with `partial_count > 0` or `failed_count > 0`,
         automatically runs `retry-recall` (when log recall errors appear), `fill_missing`,
         and `reset_failed` + `start` up to `task_manager_max_recovery_rounds`.
      4. `resume` & `cancel`: re-attaches poller across service restarts and forwards
         cancellation to `POST /tasks/{task_id}/cancel`.
    """

    mode = "task_manager"

    def __init__(self, cfg: ServiceConfig):
        self.cfg = cfg
        self._lock = threading.Lock()
        self._pollers: dict[str, threading.Thread] = {}

    @staticmethod
    def _state_path(run: dict[str, Any]) -> Path:
        return Path(run["round_dir_path"]) / "98_service" / "dispatch" / "TASK_MANAGER_STATE.json"

    @classmethod
    def _save_state(cls, run: dict[str, Any], state: dict[str, Any]) -> Path:
        path = cls._state_path(run)
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.parent / f".{path.name}.tmp"
        tmp.write_text(json.dumps(state, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        os.replace(tmp, path)
        return path

    @classmethod
    def _load_state(cls, run: dict[str, Any]) -> dict[str, Any] | None:
        path = cls._state_path(run)
        if not path.is_file():
            return None
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            return data if isinstance(data, dict) else None
        except ValueError:
            return None

    def _resolve_tm_meta(self, run: dict[str, Any]) -> dict[str, Any]:
        meta = run.get("meta") if isinstance(run.get("meta"), dict) else {}
        tm = meta.get("task_manager") if isinstance(meta.get("task_manager"), dict) else {}
        return tm

    def _make_client(self, run: dict[str, Any], state: dict[str, Any] | None = None) -> TaskManagerClient:
        tm_meta = self._resolve_tm_meta(run)
        raw_base = (
            (state or {}).get("base_url")
            or tm_meta.get("base_url")
            or self.cfg.task_manager_base_url
            or self.cfg.collector_base_url
            or ""
        )
        base_url = normalize_task_manager_base_url(str(raw_base))
        if not base_url:
            raise RuntimeError(
                "COLLECTOR_MODE=task_manager 但未配置 INTERNAL_EVAL_TASK_MANAGER_BASE_URL"
            )
        user_id = str(tm_meta.get("user_id") or self.cfg.task_manager_user_id or "").strip()
        return TaskManagerClient(base_url, user_id=user_id)

    @staticmethod
    def _load_dispatch_rows(dispatch_files: dict[str, str], sides: list[str]) -> list[dict[str, Any]]:
        src_path: Path | None = None
        for key in (*sides, "targets"):
            cand = dispatch_files.get(key)
            if cand and Path(cand).is_file():
                src_path = Path(cand)
                break
        if not src_path:
            raise FileNotFoundError(f"未找到下发问句文件：{dispatch_files}")
        rows: list[dict[str, Any]] = []
        for line in src_path.read_text(encoding="utf-8", errors="replace").splitlines():
            line = line.strip()
            if not line:
                continue
            obj = json.loads(line)
            if isinstance(obj, dict):
                rows.append(obj)
        return rows

    @staticmethod
    def _load_already_ingested_keys(raw_dirs: dict[str, Path], sides: list[str]) -> dict[str, set[str]]:
        ingested: dict[str, set[str]] = {s: set() for s in sides}
        for side in sides:
            raw_dir = raw_dirs.get(side)
            if not raw_dir:
                continue
            sink = raw_dir / f"_accepted_{side}.jsonl"
            if not sink.is_file():
                continue
            for line in sink.read_text(encoding="utf-8", errors="replace").splitlines():
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except ValueError:
                    continue
                if isinstance(obj, dict):
                    ck = extract_case_key(obj)
                    if ck:
                        ingested[side].add(ck)
        return ingested

    def _emit_log(
        self,
        log_event: LogEventFn | None,
        stage: str,
        event_type: str,
        message: str,
        *,
        level: str = "info",
        details: dict[str, Any] | None = None,
    ) -> None:
        if log_event is not None:
            try:
                log_event(stage, event_type, message, level, details)
            except Exception:
                pass

    def _trigger_task_recovery(
        self,
        client: TaskManagerClient,
        task_id: str,
        *,
        retry_recall_wait_sec: int,
        log_event: LogEventFn | None = None,
    ) -> dict[str, Any]:
        """Try `retry-recall` -> `fill_missing` / `reset_failed` -> `start` on an existing task."""
        actions: list[str] = []
        info = client.get_task(task_id)
        partial_cnt = int(info.get("partial_count") or 0)
        failed_cnt = int(info.get("failed_count") or 0)
        status = str(info.get("status") or "").lower()

        if partial_cnt > 0 or failed_cnt > 0:
            # 1) Inspect errors to see if log recall recovery applies
            problem_items: list[dict[str, Any]] = []
            if partial_cnt > 0:
                problem_items.extend(client.iter_all_items(task_id, status="partial"))
            if failed_cnt > 0:
                problem_items.extend(client.iter_all_items(task_id, status="failed"))
            if any(_looks_like_recall_error(str(it.get("error") or "")) for it in problem_items):
                try:
                    recall_res = client.retry_recall(task_id, max_wait_sec=retry_recall_wait_sec)
                    actions.append(f"retry-recall(fixed={recall_res.get('items_fixed', 0)})")
                    self._emit_log(
                        log_event,
                        "fetch",
                        "task_manager_retry_recall",
                        f"TaskManager 任务 {task_id} 执行日志补抓：修复 {recall_res.get('items_fixed', 0)} 条",
                        details=recall_res,
                    )
                    info = client.get_task(task_id)
                    partial_cnt = int(info.get("partial_count") or 0)
                    failed_cnt = int(info.get("failed_count") or 0)
                    status = str(info.get("status") or "").lower()
                except TaskManagerError as exc:
                    self._emit_log(
                        log_event,
                        "fetch",
                        "task_manager_retry_recall_warn",
                        f"TaskManager 日志补抓异常（继续尝试补缺/重跑）：{exc}",
                        level="warn",
                    )

            # 2) Prefer `fill_missing` for partial items, `reset_failed` for all-failed items
            need_start = False
            if partial_cnt > 0:
                fm_res = client.fill_missing(task_id)
                actions.append(f"fill_missing(count={fm_res.get('fill_count', 0)})")
                if int(fm_res.get("fill_count") or 0) > 0:
                    need_start = True
            if failed_cnt > 0:
                rf_res = client.reset_failed(task_id)
                actions.append(f"reset_failed(count={rf_res.get('reset_count', 0)})")
                if int(rf_res.get("reset_count") or 0) > 0:
                    need_start = True

            if need_start:
                client.start_task(task_id)
                actions.append("start")
        elif status in ("created", "paused"):
            client.start_task(task_id)
            actions.append("start")

        return {"task_id": task_id, "actions": actions}

    def dispatch(
        self,
        *,
        run: dict[str, Any],
        dispatch_files: dict[str, str],
        raw_dirs: dict[str, Path],
        ingest_callback: Callable[[str, list[dict[str, Any]]], dict[str, Any]],
        event_callback: Callable[[str, str, dict[str, Any]], None],
        cancel_check: Callable[[], bool] | None = None,
        log_event: LogEventFn | None = None,
    ) -> dict[str, str]:
        _write_dispatch_manifest(
            run=run,
            dispatch_files=dispatch_files,
            raw_dirs=raw_dirs,
            api_prefix=self.cfg.api_prefix,
        )
        sides = list(run["sides"])
        tm_meta = self._resolve_tm_meta(run)
        dispatch_rows = self._load_dispatch_rows(dispatch_files, sides)

        # Case 1: Retry-failed re-dispatch on an existing TaskManager task for this run
        existing_state = self._load_state(run)
        if (
            existing_state
            and existing_state.get("task_id")
            and all(s in (existing_state.get("side_to_step_key") or {}) for s in sides)
        ):
            client = self._make_client(run, existing_state)
            task_id = str(existing_state["task_id"])
            side_to_step_key = {s: str(existing_state["side_to_step_key"][s]) for s in sides}
            rec = self._trigger_task_recovery(
                client,
                task_id,
                retry_recall_wait_sec=self.cfg.task_manager_retry_recall_wait_sec,
                log_event=log_event,
            )
            self._emit_log(
                log_event,
                "dispatching",
                "task_manager_retry_dispatched",
                f"复用已有 TaskManager 任务 {task_id} 执行补跑：{rec['actions']}",
                details=rec,
            )
            self._start_poller(
                run=run,
                client=client,
                task_id=task_id,
                side_to_step_key=side_to_step_key,
                dispatch_rows=dispatch_rows,
                raw_dirs=raw_dirs,
                ingest_callback=ingest_callback,
                event_callback=event_callback,
                cancel_check=cancel_check,
                log_event=log_event,
            )
            return {side: f"tm:{task_id}:{step_key}" for side, step_key in side_to_step_key.items()}

        client = self._make_client(run)

        # Case 2: Caller explicitly attached an existing TaskManager task_id
        attach_task_id = str(tm_meta.get("existing_task_id") or "").strip()
        if attach_task_id:
            task_doc = client.get_task(attach_task_id)
            pipe_steps = (task_doc.get("pipeline") or {}).get("steps") or []
            available_keys = [str(st.get("key") or "") for st in pipe_steps if isinstance(st, dict) and st.get("key")]
            if not available_keys:
                raise RuntimeError(f"附着的 TaskManager 任务 {attach_task_id} 不包含有效 pipeline.steps")
            side_to_step_key: dict[str, str] = {}
            for idx, side in enumerate(sides):
                agent_cfg = run["before_agent"] if side == "before" else run["after_agent"]
                explicit_key = (
                    str(agent_cfg.get("step_key") or agent_cfg.get("key") or "").strip()
                    if isinstance(agent_cfg, dict)
                    else ""
                )
                if explicit_key:
                    if explicit_key not in available_keys:
                        raise RuntimeError(
                            f"side={side} 指定的 step_key={explicit_key!r} 不在任务 {attach_task_id} 的 steps={available_keys} 中"
                        )
                    side_to_step_key[side] = explicit_key
                else:
                    side_to_step_key[side] = available_keys[min(idx, len(available_keys) - 1)]

            if str(task_doc.get("status") or "").lower() in ("created", "paused") and tm_meta.get("auto_start", True):
                client.start_task(attach_task_id)

            state = {
                "base_url": client.base_url,
                "testset_id": (task_doc.get("testset_ids") or [task_doc.get("testset_id")])[0],
                "task_id": attach_task_id,
                "side_to_step_key": side_to_step_key,
                "pipeline": task_doc.get("pipeline") or {},
                "attached": True,
                "created_at": utc_rfc3339(),
            }
            self._save_state(run, state)
            self._start_poller(
                run=run,
                client=client,
                task_id=attach_task_id,
                side_to_step_key=side_to_step_key,
                dispatch_rows=dispatch_rows,
                raw_dirs=raw_dirs,
                ingest_callback=ingest_callback,
                event_callback=event_callback,
                cancel_check=cancel_check,
                log_event=log_event,
            )
            return {side: f"tm:{attach_task_id}:{step_key}" for side, step_key in side_to_step_key.items()}

        # Case 3: Standard automated flow: create testset -> create task -> start -> poll & stream
        max_hist = int(tm_meta.get("max_history_turns", self.cfg.task_manager_max_history_turns) or 0)
        cases = build_testset_cases(run["run_id"], dispatch_rows, max_history_turns=max(0, max_hist))
        ts_name = f"{run['round_dir_name']}_{run['run_id'][-6:]}"
        ts_desc = (
            f"internal_eval run={run['run_id']} version={run['version']} "
            f"model={run['model']} count={len(cases)} sides={','.join(sides)}"
        )
        ts_res = client.create_testset_chunked(
            name=ts_name,
            cases=cases,
            description=ts_desc,
            batch_size=self.cfg.task_manager_batch_size,
        )
        testset_id = ts_res["testset_id"]

        pipeline, side_to_step_key = build_pipeline_and_step_map(
            run=run,
            sides=sides,
            client=client,
            default_template_task_id=self.cfg.task_manager_template_task_id,
        )
        concurrency = int(tm_meta.get("concurrency_limit") or self.cfg.task_manager_concurrency)
        concurrency_schedule = (
            tm_meta.get("concurrency_schedule")
            if isinstance(tm_meta.get("concurrency_schedule"), dict)
            else None
        )
        task_name = str(
            tm_meta.get("task_name")
            or f"internal-eval-{run['version']}-{run['model']}-{run['run_id'][-6:]}"
        )
        task_res = client.create_task(
            task_name=task_name,
            testset_selections=[{"testset_id": testset_id}],
            pipeline=pipeline,
            concurrency_limit=concurrency,
            description=ts_desc,
            concurrency_schedule=concurrency_schedule,
        )
        task_id = str(task_res.get("task_id") or "").strip()
        if not task_id:
            raise RuntimeError(f"TaskManager 创建任务未返回 task_id: {task_res}")

        client.start_task(task_id)

        state = {
            "base_url": client.base_url,
            "testset_id": testset_id,
            "task_id": task_id,
            "task_name": task_name,
            "side_to_step_key": side_to_step_key,
            "pipeline": pipeline,
            "concurrency_limit": concurrency,
            "created_at": utc_rfc3339(),
        }
        self._save_state(run, state)
        self._emit_log(
            log_event,
            "dispatching",
            "task_manager_started",
            f"已创建并启动 TaskManager 任务 {task_id}（testset={testset_id}, count={len(cases)}, steps={side_to_step_key}）",
            details={
                "task_id": task_id,
                "testset_id": testset_id,
                "side_to_step_key": side_to_step_key,
                "concurrency_limit": concurrency,
            },
        )

        self._start_poller(
            run=run,
            client=client,
            task_id=task_id,
            side_to_step_key=side_to_step_key,
            dispatch_rows=dispatch_rows,
            raw_dirs=raw_dirs,
            ingest_callback=ingest_callback,
            event_callback=event_callback,
            cancel_check=cancel_check,
            log_event=log_event,
        )
        return {side: f"tm:{task_id}:{step_key}" for side, step_key in side_to_step_key.items()}

    def resume(
        self,
        *,
        run: dict[str, Any],
        dispatch_files: dict[str, str],
        raw_dirs: dict[str, Path],
        ingest_callback: Callable[[str, list[dict[str, Any]]], dict[str, Any]],
        event_callback: Callable[[str, str, dict[str, Any]], None],
        cancel_check: Callable[[], bool] | None = None,
        log_event: LogEventFn | None = None,
    ) -> None:
        state = self._load_state(run)
        if not state or not state.get("task_id"):
            return
        sides = list(run["sides"])
        mapping = state.get("side_to_step_key") or {}
        side_to_step_key = {s: str(mapping[s]) for s in sides if s in mapping}
        if not side_to_step_key:
            return
        client = self._make_client(run, state)
        dispatch_rows = self._load_dispatch_rows(dispatch_files, sides)
        self._emit_log(
            log_event,
            "recovery",
            "task_manager_resumed",
            f"已重新挂载 TaskManager 轮询：task_id={state['task_id']}, sides={list(side_to_step_key)}",
            details={"task_id": state["task_id"], "side_to_step_key": side_to_step_key},
        )
        self._start_poller(
            run=run,
            client=client,
            task_id=str(state["task_id"]),
            side_to_step_key=side_to_step_key,
            dispatch_rows=dispatch_rows,
            raw_dirs=raw_dirs,
            ingest_callback=ingest_callback,
            event_callback=event_callback,
            cancel_check=cancel_check,
            log_event=log_event,
        )

    def cancel(self, run: dict[str, Any]) -> None:
        state = self._load_state(run)
        if not state or not state.get("task_id"):
            return
        try:
            client = self._make_client(run, state)
            client.cancel_task(str(state["task_id"]))
        except Exception:
            pass

    def _start_poller(
        self,
        *,
        run: dict[str, Any],
        client: TaskManagerClient,
        task_id: str,
        side_to_step_key: dict[str, str],
        dispatch_rows: list[dict[str, Any]],
        raw_dirs: dict[str, Path],
        ingest_callback: Callable[[str, list[dict[str, Any]]], dict[str, Any]],
        event_callback: Callable[[str, str, dict[str, Any]], None],
        cancel_check: Callable[[], bool] | None,
        log_event: LogEventFn | None,
    ) -> None:
        run_id = run["run_id"]
        with self._lock:
            existing = self._pollers.get(run_id)
            if existing and existing.is_alive():
                return
            t = threading.Thread(
                target=self._poll_task_loop,
                kwargs={
                    "run": dict(run),
                    "client": client,
                    "task_id": task_id,
                    "side_to_step_key": dict(side_to_step_key),
                    "dispatch_rows": dispatch_rows,
                    "raw_dirs": dict(raw_dirs),
                    "ingest_callback": ingest_callback,
                    "event_callback": event_callback,
                    "cancel_check": cancel_check or (lambda: False),
                    "log_event": log_event,
                },
                daemon=True,
                name=f"tm-poller-{run_id}",
            )
            self._pollers[run_id] = t
            t.start()

    def _poll_task_loop(
        self,
        *,
        run: dict[str, Any],
        client: TaskManagerClient,
        task_id: str,
        side_to_step_key: dict[str, str],
        dispatch_rows: list[dict[str, Any]],
        raw_dirs: dict[str, Path],
        ingest_callback: Callable[[str, list[dict[str, Any]]], dict[str, Any]],
        event_callback: Callable[[str, str, dict[str, Any]], None],
        cancel_check: Callable[[], bool],
        log_event: LogEventFn | None,
    ) -> None:
        run_id = run["run_id"]
        version = run["version"]
        sides = list(side_to_step_key.keys())
        tm_meta = self._resolve_tm_meta(run)
        poll_interval = float(tm_meta.get("poll_interval_sec") or self.cfg.task_manager_poll_interval_sec)
        max_recovery = int(tm_meta.get("max_recovery_rounds", self.cfg.task_manager_max_recovery_rounds))
        recall_wait = int(tm_meta.get("retry_recall_wait_sec") or self.cfg.task_manager_retry_recall_wait_sec)

        question_by_ck = {str(r["case_key"]): str(r.get("question") or "") for r in dispatch_rows}
        source_tid_to_ck = {
            str(r["source_trace_id"]): str(r["case_key"])
            for r in dispatch_rows
            if r.get("source_trace_id")
        }
        expected_total = len(question_by_ck)
        ingested_keys = self._load_already_ingested_keys(raw_dirs, sides)

        def _resolve_case_key(record_or_item: dict[str, Any]) -> str | None:
            ck = extract_case_key(record_or_item)
            if ck and ck in question_by_ck:
                return ck
            cid = str(record_or_item.get("case_id") or "").strip()
            if cid:
                for stid, mapped_ck in source_tid_to_ck.items():
                    if cid == stid or cid.endswith("_" + stid):
                        return mapped_ck
            extra = record_or_item.get("extra") if isinstance(record_or_item.get("extra"), dict) else {}
            if extra.get("case_key") in question_by_ck:
                return str(extra["case_key"])
            return None

        def _pull_ready_judges(*, final_sweep: bool = False) -> int:
            total_newly_ingested = 0
            completed_items = client.iter_all_items(task_id, status="completed")
            partial_items = client.iter_all_items(task_id, status="partial")
            usable_items = completed_items + partial_items

            # Build session_index lookup `(step_key, case_key) -> session_entry`
            session_map: dict[tuple[str, str], dict[str, Any]] = {}
            ready_by_side: dict[str, list[tuple[str, str]]] = {s: [] for s in sides}
            for item in usable_items:
                ck = _resolve_case_key(item)
                if not ck:
                    continue
                tm_cid = str(item.get("case_id") or "")
                skeys = set(item.get("success_keys") or [])
                for s_entry in item.get("session_index") or []:
                    if isinstance(s_entry, dict) and s_entry.get("step"):
                        session_map[(str(s_entry["step"]), ck)] = s_entry
                for side, step_key in side_to_step_key.items():
                    if ck in ingested_keys[side]:
                        continue
                    if step_key in skeys or (item.get("status") == "completed" and not skeys):
                        ready_by_side[side].append((ck, tm_cid))

            def _ingest_judge_records(side: str, step_key: str, records: list[dict[str, Any]]) -> int:
                agent_label = run["before_agent_label"] if side == "before" else run["after_agent_label"]
                batch: list[dict[str, Any]] = []
                batch_cks: list[str] = []
                for rec in records:
                    ck = _resolve_case_key(rec)
                    if not ck or ck in ingested_keys[side]:
                        continue
                    converted = judge_record_to_eval_trace(
                        rec,
                        run_id=run_id,
                        side=side,
                        version=version,
                        agent_label=agent_label,
                        step_key=step_key,
                        task_id=task_id,
                        fallback_case_key=ck,
                        fallback_question=question_by_ck.get(ck, ""),
                        session_info=session_map.get((step_key, ck)),
                    )
                    batch.append(converted)
                    batch_cks.append(ck)
                if not batch:
                    return 0
                ingest_callback(side, batch)
                for ck in batch_cks:
                    ingested_keys[side].add(ck)
                return len(batch)

            gen_judge_triggered = False
            for side, step_key in side_to_step_key.items():
                newly_ready = ready_by_side[side]
                if not newly_ready and not final_sweep:
                    continue

                records: list[dict[str, Any]] = []
                if not final_sweep and 1 <= len(newly_ready) <= 15:
                    # Low-latency targeted pull while task is streaming
                    for ck, tm_cid in newly_ready:
                        q_term = tm_cid or f"{run_id}_{ck}"
                        recs, _ = client.download_judge(task_id, step_key, page=1, size=5, query=q_term)
                        records.extend(recs)
                else:
                    records = client.iter_all_judge_records(task_id, step_key, page_size=200)

                added = _ingest_judge_records(side, step_key, records)
                total_newly_ingested += added

                # On final sweep, if items succeeded on TaskManager but judge_data was missing, regenerate once
                if final_sweep and not gen_judge_triggered:
                    still_missing = [ck for ck, _ in newly_ready if ck not in ingested_keys[side]]
                    if still_missing:
                        gen_judge_triggered = True
                        try:
                            gen_res = client.generate_judge(task_id)
                            self._emit_log(
                                log_event,
                                "fetch",
                                "task_manager_generate_judge",
                                f"检测到 {len(still_missing)} 条已完成 item 缺 judge_data，已触发重造 judge",
                                level="warn",
                                details=gen_res,
                            )
                            records2 = client.iter_all_judge_records(task_id, step_key, page_size=200)
                            total_newly_ingested += _ingest_judge_records(side, step_key, records2)
                        except TaskManagerError as exc:
                            self._emit_log(
                                log_event,
                                "fetch",
                                "task_manager_generate_judge_warn",
                                f"重造 judge 失败：{exc}",
                                level="warn",
                            )
            return total_newly_ingested

        recovery_round = 0
        consecutive_errors = 0
        try:
            while True:
                if cancel_check():
                    try:
                        client.cancel_task(task_id)
                    except Exception:
                        pass
                    self._emit_log(
                        log_event,
                        "cancel",
                        "task_manager_cancelled",
                        f"已向 TaskManager 任务 {task_id} 发送取消指令",
                        level="warn",
                    )
                    return

                try:
                    task_info = client.get_task(task_id)
                    consecutive_errors = 0
                except Exception as exc:  # noqa: BLE001
                    consecutive_errors += 1
                    self._emit_log(
                        log_event,
                        "fetch",
                        "task_manager_poll_error",
                        f"轮询 TaskManager ({task_id}) 失败 ({consecutive_errors}/15)：{exc}",
                        level="warn",
                    )
                    if consecutive_errors >= 15:
                        for side in sides:
                            event_callback(
                                side,
                                "failed",
                                {"task_id": task_id, "error": f"连续轮询失败：{exc}"},
                            )
                        return
                    self._sleep_interruptible(min(poll_interval, 5.0), cancel_check)
                    continue

                try:
                    _pull_ready_judges(final_sweep=False)
                except Exception as exc:  # noqa: BLE001
                    self._emit_log(
                        log_event,
                        "fetch",
                        "task_manager_stream_pull_warn",
                        f"流式拉取 judge 暂时异常（下轮重试）：{exc}",
                        level="warn",
                    )

                tm_status = str(task_info.get("status") or "").lower()
                partial_cnt = int(task_info.get("partial_count") or 0)
                failed_cnt = int(task_info.get("failed_count") or 0)

                if tm_status in ("completed", "failed"):
                    if (partial_cnt > 0 or failed_cnt > 0) and recovery_round < max_recovery and not cancel_check():
                        recovery_round += 1
                        try:
                            rec = self._trigger_task_recovery(
                                client,
                                task_id,
                                retry_recall_wait_sec=recall_wait,
                                log_event=log_event,
                            )
                            self._emit_log(
                                log_event,
                                "fetch",
                                "task_manager_auto_recovery",
                                f"TaskManager 任务 {task_id} 第 {recovery_round}/{max_recovery} 轮自动恢复：{rec['actions']}",
                                level="warn",
                                details=rec,
                            )
                            if "start" in rec["actions"]:
                                self._sleep_interruptible(min(poll_interval, 3.0), cancel_check)
                                continue
                            # retry-recall fixed everything without needing re-start; re-check status
                            task_info = client.get_task(task_id)
                            partial_cnt = int(task_info.get("partial_count") or 0)
                            failed_cnt = int(task_info.get("failed_count") or 0)
                        except Exception as exc:  # noqa: BLE001
                            self._emit_log(
                                log_event,
                                "fetch",
                                "task_manager_auto_recovery_failed",
                                f"TaskManager 自动恢复失败（将进入收敛）：{exc}",
                                level="warn",
                            )

                    # Final sweep for all sides
                    try:
                        _pull_ready_judges(final_sweep=True)
                    except Exception as exc:  # noqa: BLE001
                        self._emit_log(
                            log_event,
                            "fetch",
                            "task_manager_final_pull_error",
                            f"最终拉取 judge 失败：{exc}",
                            level="error",
                        )

                    # Record explicit per-case fetch failures for remaining missing/failed items
                    try:
                        bad_items = client.iter_all_items(task_id, status="failed") + client.iter_all_items(
                            task_id, status="partial"
                        )
                    except Exception:
                        bad_items = []
                    reported_failed: dict[str, set[str]] = {s: set() for s in sides}
                    for item in bad_items:
                        ck = _resolve_case_key(item)
                        if not ck:
                            continue
                        err_msg = str(item.get("error") or f"TaskManager item status={item.get('status')}")
                        mkeys = set(item.get("missing_keys") or [])
                        skeys = set(item.get("success_keys") or [])
                        for side, step_key in side_to_step_key.items():
                            if ck in ingested_keys[side] or ck in reported_failed[side]:
                                continue
                            if step_key in mkeys or (step_key not in skeys and item.get("status") == "failed"):
                                reported_failed[side].add(ck)
                                event_callback(
                                    side,
                                    "case_failed",
                                    {
                                        "case_key": ck,
                                        "error_code": "TASK_MANAGER_STEP_FAILED",
                                        "error_message": err_msg,
                                        "item_id": item.get("item_id"),
                                        "step_key": step_key,
                                        "task_id": task_id,
                                    },
                                )

                    for side, step_key in side_to_step_key.items():
                        got = len(ingested_keys[side])
                        ev_type = "completed" if got >= expected_total else ("partial" if got > 0 else "failed")
                        event_callback(
                            side,
                            ev_type,
                            {
                                "task_id": task_id,
                                "step_key": step_key,
                                "ingested": got,
                                "expected": expected_total,
                                "tm_status": tm_status,
                                "recovery_rounds_used": recovery_round,
                            },
                        )
                    return

                if tm_status == "cancelled":
                    try:
                        _pull_ready_judges(final_sweep=True)
                    except Exception:
                        pass
                    for side, step_key in side_to_step_key.items():
                        got = len(ingested_keys[side])
                        event_callback(
                            side,
                            "partial" if got > 0 else "failed",
                            {
                                "task_id": task_id,
                                "step_key": step_key,
                                "ingested": got,
                                "tm_status": "cancelled",
                            },
                        )
                    return

                self._sleep_interruptible(poll_interval, cancel_check)
        except Exception as exc:  # noqa: BLE001
            self._emit_log(
                log_event,
                "fetch",
                "task_manager_poller_crashed",
                f"TaskManager 轮询线程异常退出：{exc}",
                level="error",
            )
            for side in sides:
                try:
                    event_callback(side, "failed", {"task_id": task_id, "error": str(exc)})
                except Exception:
                    pass
        finally:
            with self._lock:
                self._pollers.pop(run_id, None)

    @staticmethod
    def _sleep_interruptible(seconds: float, cancel_check: Callable[[], bool]) -> None:
        deadline = time.monotonic() + max(0.05, seconds)
        while time.monotonic() < deadline:
            if cancel_check():
                return
            time.sleep(min(0.5, max(0.02, deadline - time.monotonic())))


class MockCollectorAdapter(TraceCollectorAdapter):
    """Streaming mock collector for local testing & end-to-end verification."""

    mode = "mock"

    def __init__(self, cfg: ServiceConfig, *, delay_per_trace_sec: float = 0.02, fail_every: int = 0):
        self.cfg = cfg
        self.delay_per_trace_sec = delay_per_trace_sec
        self.fail_every = fail_every

    def dispatch(
        self,
        *,
        run: dict[str, Any],
        dispatch_files: dict[str, str],
        raw_dirs: dict[str, Path],
        ingest_callback: Callable[[str, list[dict[str, Any]]], dict[str, Any]],
        event_callback: Callable[[str, str, dict[str, Any]], None],
        cancel_check: Callable[[], bool] | None = None,
        log_event: LogEventFn | None = None,
    ) -> dict[str, str]:
        _write_dispatch_manifest(
            run=run,
            dispatch_files=dispatch_files,
            raw_dirs=raw_dirs,
            api_prefix=self.cfg.api_prefix,
        )
        jobs = {side: f"mock_{run['run_id']}_{side}" for side in run["sides"]}

        def _stream_worker() -> None:
            for side in run["sides"]:
                q_path = Path(dispatch_files.get(side) or dispatch_files["targets"])
                rows = [
                    json.loads(line)
                    for line in q_path.read_text(encoding="utf-8").splitlines()
                    if line.strip()
                ]
                for idx, item in enumerate(rows, 1):
                    if cancel_check and cancel_check():
                        return
                    if self.delay_per_trace_sec > 0:
                        time.sleep(self.delay_per_trace_sec)
                    case_key = item["case_key"]
                    if self.fail_every > 0 and idx % self.fail_every == 0:
                        event_callback(
                            side,
                            "case_failed",
                            {
                                "case_key": case_key,
                                "error_code": "MOCK_FETCH_TIMEOUT",
                                "error_message": "模拟拉取超时",
                            },
                        )
                        continue
                    trace_id = f"mock_{run['run_id']}_{side}_{case_key}"
                    session_id = f"sess_{run['run_id']}_{side}_{case_key}"
                    agent_name = run["before_agent_label"] if side == "before" else run["after_agent_label"]
                    history = list(item.get("history_messages") or [])
                    messages = [
                        *history,
                        {"role": "user", "type": "user_question", "content": item["question"]},
                        {
                            "role": "assistant",
                            "type": "final_answer",
                            "content": f"[{agent_name}] Response for {case_key}: {item['question'][:80]}",
                        },
                    ]
                    trace_record = {
                        "case_key": case_key,
                        "case_id": f"{run['run_id']}_{side}_{case_key}",
                        "trace_id": trace_id,
                        "session_id": session_id,
                        "batch_id": run["version"],
                        "version": agent_name,
                        "request_time": utc_rfc3339(),
                        "meta": {
                            "trace_id": trace_id,
                            "session_id": session_id,
                            "case_id": f"{run['run_id']}_{side}_{case_key}",
                            "question": item["question"],
                            "question_text": item["question"],
                            "request_time": utc_rfc3339(),
                            "agent_name": agent_name,
                        },
                        "messages": messages,
                    }
                    ingest_callback(side, [trace_record])
                event_callback(side, "completed", {"total_sent": len(rows)})

        t = threading.Thread(target=_stream_worker, daemon=True, name=f"mock-collector-{run['run_id']}")
        t.start()
        return jobs


def create_collector_adapter(cfg: ServiceConfig) -> TraceCollectorAdapter:
    mode = (cfg.collector_mode or "file_drop").strip().lower()
    if mode in ("task_manager", "taskmanager"):
        return TaskManagerCollectorAdapter(cfg)
    if mode == "http":
        return HttpCollectorAdapter(cfg)
    if mode == "mock":
        return MockCollectorAdapter(cfg)
    return FileDropCollectorAdapter(cfg)


class RawDirTailer:
    """Incrementally tails `.jsonl` files dropped into `98_service/raw_traces/<side>/`."""

    def __init__(self, raw_dir: Path):
        self.raw_dir = raw_dir
        self._offsets: dict[str, int] = {}

    def poll_new_records(self) -> tuple[list[tuple[str, dict[str, Any]]], bool]:
        """Return `(records_with_filename, done_sentinel_present)`."""
        self.raw_dir.mkdir(parents=True, exist_ok=True)
        out: list[tuple[str, dict[str, Any]]] = []
        done = (self.raw_dir / "_DONE").exists() or (self.raw_dir / "DONE").exists()

        for path in sorted(self.raw_dir.glob("*.jsonl")):
            if path.name.startswith("."):
                continue
            key = str(path)
            offset = self._offsets.get(key, 0)
            try:
                size = path.stat().st_size
            except OSError:
                continue
            if size < offset:
                offset = 0
            if size == offset:
                continue
            with path.open("rb") as fh:
                fh.seek(offset)
                chunk = fh.read()
            last_nl = chunk.rfind(b"\n")
            if last_nl < 0:
                # Wait until line is complete
                continue
            complete = chunk[: last_nl + 1]
            self._offsets[key] = offset + len(complete)
            for raw_line in complete.splitlines():
                text = raw_line.decode("utf-8", "replace").strip()
                if not text:
                    continue
                try:
                    obj = json.loads(text)
                except ValueError:
                    out.append((path.name, {"_invalid_json": text}))
                    continue
                if isinstance(obj, dict):
                    out.append((path.name, obj))
        return out, done
