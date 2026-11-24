"""Pluggable TraceCollectorAdapter implementations for the colleague data-fetch stage.

Supports three modes seamlessly:
  1. `file_drop` (default until colleague HTTP API is live):
     Writes the two dispatch JSONL files (`before_questions.jsonl`, `after_questions.jsonl`)
     and a `DISPATCH_MANIFEST.json`, then monitors `98_service/raw_traces/{before,after}/`
     for dropped `.jsonl` files (plus optional `_DONE` sentinel) AND accepts HTTP `/ingest`.
  2. `http`:
     POSTs the dispatch job (with paths to the two JSONL files + callback URLs) to the
     colleague's HTTP endpoint (`{collector_base_url}/submit`), while still monitoring
     `raw_traces/` and accepting HTTP `/ingest` & `/collector-events`.
  3. `mock`:
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
from .timeutil import utc_rfc3339


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
    ) -> dict[str, str]:
        """Dispatch the prepared question JSONLs to the upstream trace collector.
        Returns `{side: upstream_job_id}`.
        """
        raise NotImplementedError


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
    """Default adapter: writes dispatch JSONLs & manifest, waits for file drops or HTTP pushes."""

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
