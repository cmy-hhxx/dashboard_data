"""TaskManager inference API client and judge-to-eval_harness trace converter.

Integrates with the external TaskManager service (`http://<host>:8888/api/v1/task`):
  - `POST /testsets` + `POST /testsets/{id}/append` (chunked <= 100 cases/call)
  - `GET /tasks/{template_id}` (optional template pipeline copy)
  - `POST /tasks` -> `POST /tasks/{id}/start` (with `X-User-Id` auth header)
  - `GET /tasks/{id}` & `GET /tasks/{id}/items` (progress & per-step readiness)
  - `GET /tasks/{id}/judge/{key}/download` (streaming / paginated judge pull,
    transparently handling both gzipped and plain UTF-8 JSONL responses)
  - `POST /tasks/{id}/retry-recall`, `POST /tasks/{id}/fill_missing`,
    `POST /tasks/{id}/reset_failed`, `POST /tasks/{id}/generate_judge`,
    `POST /tasks/{id}/cancel`
"""

from __future__ import annotations

import gzip
import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from typing import Any

from .engines import extract_case_key
from .timeutil import utc_rfc3339

STEP_OVERRIDE_FIELDS = (
    "fetcher",
    "is_pre",
    "is_deep",
    "mode",
    "runtime",
    "user_id",
    "schedule_user_id",
    "agent_id",
    "history",
    "event_name",
    "ab_test_content",
    "litefuse_recall",
    "lumi_profile_id",
)

PIPELINE_OVERRIDE_FIELDS = (
    "is_cn",
    "is_deep",
    "run_source",
    "raw_dir",
    "with_pic",
    "add_history",
    "parallel",
)

_RECALL_ERROR_HINTS = (
    "not_ready",
    "no_node",
    "network_error",
    "recall",
    "日志回溯",
    "日志未就绪",
)

_SAFE_KEY_RE = re.compile(r"[^0-9A-Za-z._-]+")
_SIMPLE_DT_RE = re.compile(r"^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}(?:\.\d+)?)$")


class TaskManagerError(RuntimeError):
    """Structured error raised when a TaskManager HTTP call fails."""

    def __init__(
        self,
        message: str,
        *,
        http_status: int | None = None,
        error_code: str | None = None,
        endpoint: str = "",
        detail: Any = None,
    ):
        super().__init__(message)
        self.http_status = http_status
        self.error_code = error_code
        self.endpoint = endpoint
        self.detail = detail


def normalize_task_manager_base_url(raw: str) -> str:
    url = (raw or "").strip().rstrip("/")
    if not url:
        return ""
    if not url.endswith("/api/v1/task"):
        if url.endswith("/api/v1"):
            url = url + "/task"
        elif "/api/v1/task" not in url:
            url = url + "/api/v1/task"
    return url.rstrip("/")


def _sanitize_step_key(raw: str, fallback: str) -> str:
    cleaned = _SAFE_KEY_RE.sub("-", (raw or "").strip()).strip("-")
    return cleaned[:64] if cleaned else fallback


_DATE_TIME_PLACEHOLDER_RE = re.compile(r"\{DATE_TIME\}", re.IGNORECASE)


def format_abtest_task_name(now: datetime | None = None, *, template_task_name: str = "") -> str:
    """Render TaskManager task name in UTC+8 from template `{DATE_TIME}` or default `AIME_RSI_ABTEST_{YYYYMMDD-HHMMSS}`."""
    tz_cn = timezone(timedelta(hours=8))
    dt = (now or datetime.now(tz_cn)).astimezone(tz_cn)
    stamp = dt.strftime("%Y%m%d-%H%M%S")
    tpl = (template_task_name or "").strip()
    if tpl and _DATE_TIME_PLACEHOLDER_RE.search(tpl):
        # Legacy template `AIME_RSI_ABTEST_{DATE_TIME}_test` strips trailing `_test`
        if re.search(r"\{DATE_TIME\}_test$", tpl, re.IGNORECASE):
            tpl = re.sub(r"_test$", "", tpl, flags=re.IGNORECASE)
        return _DATE_TIME_PLACEHOLDER_RE.sub(stamp, tpl)
    return f"AIME_RSI_ABTEST_{stamp}"


def _normalize_timestamp_to_rfc3339(
    timestamp_ms: Any = None,
    request_time_str: Any = None,
) -> str:
    """Convert TaskManager epoch ms (`timestamp_time`) or string (`request_time`) to RFC3339 UTC."""
    if isinstance(timestamp_ms, (int, float)) and not isinstance(timestamp_ms, bool) and timestamp_ms > 0:
        sec = float(timestamp_ms) / 1000.0 if float(timestamp_ms) > 1e11 else float(timestamp_ms)
        try:
            return utc_rfc3339(datetime.fromtimestamp(sec, tz=timezone.utc))
        except (OverflowError, OSError, ValueError):
            pass

    if isinstance(request_time_str, str):
        text = request_time_str.strip()
        if text:
            m = _SIMPLE_DT_RE.match(text)
            if m:
                return f"{m.group(1)}T{m.group(2)}Z"
            if "T" in text:
                return text
    return utc_rfc3339()


def _truncate_utf8(text: str, max_bytes: int) -> str:
    encoded = text.encode("utf-8", errors="replace")
    if len(encoded) <= max_bytes:
        return text
    suffix = "\n...[truncated]"
    keep = max(0, max_bytes - len(suffix.encode("utf-8")))
    return encoded[:keep].decode("utf-8", errors="ignore") + suffix


def _normalize_tool_input(raw_input: Any) -> tuple[Any, str]:
    """Return `(parsed_input, canonical_arguments_json)` so eval_harness links tool_call to llm_turn."""
    if raw_input is None:
        return {}, "{}"
    if isinstance(raw_input, (dict, list)):
        return raw_input, json.dumps(raw_input, ensure_ascii=False, separators=(",", ":"))
    if isinstance(raw_input, str):
        text = raw_input.strip()
        if text:
            try:
                parsed = json.loads(text)
                if isinstance(parsed, (dict, list)):
                    return parsed, json.dumps(parsed, ensure_ascii=False, separators=(",", ":"))
            except ValueError:
                pass
        wrapped = {"raw": raw_input}
        return wrapped, json.dumps(wrapped, ensure_ascii=False, separators=(",", ":"))
    wrapped = {"value": raw_input}
    return wrapped, json.dumps(wrapped, ensure_ascii=False, separators=(",", ":"))


def _normalize_tool_output(raw_output: Any, *, max_bytes: int = 1_500_000) -> Any:
    if raw_output is None:
        return ""
    if isinstance(raw_output, str):
        return _truncate_utf8(raw_output, max_bytes)
    serialized = json.dumps(raw_output, ensure_ascii=False, separators=(",", ":"))
    if len(serialized.encode("utf-8", errors="replace")) <= max_bytes:
        return raw_output
    return _truncate_utf8(serialized, max_bytes)


def _extract_context_messages(context: Any) -> list[dict[str, Any]]:
    """Normalize optional TaskManager multi-turn `context` field into role/content messages."""
    if not isinstance(context, list) or not context:
        return []
    out: list[dict[str, Any]] = []
    for entry in context:
        if not isinstance(entry, dict):
            continue
        role = str(entry.get("role") or "").strip().lower()
        if role in ("user", "assistant", "system", "developer"):
            content = entry.get("content")
            if content is not None and (not isinstance(content, str) or content.strip()):
                out.append({"role": role, "content": content})
            continue
        # Alternate turn pair format: {"query": "...", "answer": "..."}
        q = entry.get("query") or entry.get("question") or entry.get("user")
        a = entry.get("answer") or entry.get("response") or entry.get("assistant")
        if isinstance(q, str) and q.strip():
            out.append({"role": "user", "content": q.strip()})
        if isinstance(a, str) and a.strip():
            out.append({"role": "assistant", "content": a.strip()})
    return out


def _looks_like_recall_error(error_text: str) -> bool:
    low = (error_text or "").lower()
    return any(hint in low for hint in _RECALL_ERROR_HINTS)


def judge_record_to_eval_trace(
    judge_record: dict[str, Any],
    *,
    run_id: str,
    side: str,
    version: str,
    agent_label: str,
    step_key: str,
    task_id: str,
    fallback_case_key: str | None = None,
    fallback_question: str = "",
    session_info: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Convert a TaskManager judge JSONL record into an `eval_harness` Adapter `b` trace.

    Adapter `b` message types:
      - `user_question`
      - `llm_turn` (with chained `input_messages` & `output` including `tool_calls`)
      - `tool_call` (with matching `call_id` & `parent_span`)
      - `tool_result` (with matching `call_id` & `name`)
      - `final_answer`
    """
    tm_meta = judge_record.get("meta") if isinstance(judge_record.get("meta"), dict) else {}
    s_info = session_info if isinstance(session_info, dict) else {}

    case_key = extract_case_key(judge_record) or fallback_case_key
    tm_case_id = str(judge_record.get("case_id") or "").strip()
    canonical_case_id = f"{run_id}_{side}_{case_key}" if case_key else (tm_case_id or f"{run_id}_{side}_unknown")

    trace_id = str(
        judge_record.get("trace_id")
        or tm_meta.get("trace_id")
        or s_info.get("trace_id")
        or canonical_case_id
    ).strip()
    session_id = str(
        tm_meta.get("session_id")
        or s_info.get("session_id")
        or judge_record.get("session_id")
        or f"sess_{canonical_case_id}"
    ).strip()
    request_time = _normalize_timestamp_to_rfc3339(
        timestamp_ms=tm_meta.get("timestamp_time") or s_info.get("ts"),
        request_time_str=tm_meta.get("request_time") or s_info.get("request_time"),
    )

    # Extract user question from `input`
    inp = judge_record.get("input")
    question_text = ""
    if isinstance(inp, dict):
        question_text = str(inp.get("text") or inp.get("query") or "").strip()
    elif isinstance(inp, str):
        question_text = inp.strip()
    if not question_text:
        question_text = str(fallback_question or "").strip()

    # Extract final answer (`text_answer`, `visual_answer`, `raw_answer`)
    text_answer = str(judge_record.get("text_answer") or "").strip()
    visual_answer = str(judge_record.get("visual_answer") or "").strip()
    raw_answer = str(judge_record.get("raw_answer") or "").strip()
    if text_answer and visual_answer and visual_answer not in text_answer:
        final_answer = f"{text_answer}\n\n{visual_answer}"
    else:
        final_answer = text_answer or visual_answer or raw_answer

    messages: list[dict[str, Any]] = [
        {"role": "user", "type": "user_question", "content": question_text},
    ]

    # Maintain a compact running prompt context so eval_harness `qa()` chains llm_turns
    prompt_msgs: list[dict[str, Any]] = _extract_context_messages(judge_record.get("context"))
    prompt_msgs.append({"role": "user", "content": question_text})

    def _bounded_prompt_snapshot(msgs: list[dict[str, Any]], max_total_bytes: int = 350_000) -> list[dict[str, Any]]:
        snapshot = list(msgs)
        while len(snapshot) > 2:
            raw = json.dumps(snapshot, ensure_ascii=False, separators=(",", ":")).encode("utf-8", errors="replace")
            if len(raw) <= max_total_bytes:
                break
            # Drop oldest middle tool/assistant message while keeping initial user query & recent chain
            snapshot.pop(1)
        return snapshot

    chain = judge_record.get("chain") if isinstance(judge_record.get("chain"), list) else []
    top_tools = judge_record.get("tools") if isinstance(judge_record.get("tools"), list) else []
    if not chain and top_tools:
        chain = [{"plan": "", "tools": top_tools}]

    llm_call_idx = 0
    for step_idx, step in enumerate(chain):
        if not isinstance(step, dict):
            continue
        plan = str(step.get("plan") or "")
        tools = step.get("tools") if isinstance(step.get("tools"), list) else []
        parent_span = f"chain-step-{step_idx}"

        assistant_tool_calls: list[dict[str, Any]] = []
        tool_events: list[tuple[str, str, Any, Any]] = []

        for tool_idx, tool in enumerate(tools):
            if not isinstance(tool, dict):
                continue
            call_id = f"call_{step_idx}_{tool_idx}"
            tool_name = str(tool.get("name") or "unknown_tool").strip() or "unknown_tool"
            parsed_in, args_json = _normalize_tool_input(tool.get("input"))
            norm_out = _normalize_tool_output(tool.get("output"))
            assistant_tool_calls.append(
                {
                    "id": call_id,
                    "type": "function",
                    "function": {"name": tool_name, "arguments": args_json},
                }
            )
            tool_events.append((call_id, tool_name, parsed_in, norm_out))

        if not plan.strip() and not assistant_tool_calls:
            continue

        assistant_msg: dict[str, Any] = {"role": "assistant", "content": plan}
        if assistant_tool_calls:
            assistant_msg["tool_calls"] = assistant_tool_calls

        messages.append(
            {
                "type": "llm_turn",
                "name": f"llm-call-{llm_call_idx}",
                "parent_span": parent_span,
                "input_messages": {"messages": _bounded_prompt_snapshot(prompt_msgs)},
                "output": [assistant_msg],
            }
        )
        llm_call_idx += 1
        prompt_msgs.append(assistant_msg)

        for call_id, tool_name, parsed_in, norm_out in tool_events:
            messages.append(
                {
                    "type": "tool_call",
                    "call_id": call_id,
                    "parent_span": parent_span,
                    "name": tool_name,
                    "input": parsed_in,
                }
            )
            messages.append(
                {
                    "type": "tool_result",
                    "call_id": call_id,
                    "name": tool_name,
                    "output": norm_out,
                }
            )
            compact_tool_text = (
                norm_out
                if isinstance(norm_out, str)
                else json.dumps(norm_out, ensure_ascii=False, separators=(",", ":"))
            )
            prompt_msgs.append(
                {
                    "role": "tool",
                    "tool_call_id": call_id,
                    "name": tool_name,
                    "content": _truncate_utf8(compact_tool_text, 4000),
                }
            )

    if final_answer:
        messages.append(
            {
                "type": "llm_turn",
                "name": f"llm-call-{llm_call_idx}",
                "parent_span": "final-answer-turn",
                "input_messages": {"messages": _bounded_prompt_snapshot(prompt_msgs)},
                "output": [{"role": "assistant", "content": final_answer}],
            }
        )

    messages.append({"role": "assistant", "type": "final_answer", "content": final_answer})

    meta_out: dict[str, Any] = {
        "trace_id": trace_id,
        "session_id": session_id,
        "case_id": canonical_case_id,
        "case_key": case_key,
        "request_time": request_time,
        "question": question_text,
        "question_text": question_text,
        "agent_name": agent_label,
        "source": "task_manager",
        "task_manager_task_id": task_id,
        "task_manager_step_key": step_key,
        "task_manager_case_id": tm_case_id,
    }
    for num_key in (
        "first_token_time_cost",
        "first_answer_time_cost",
        "finish_answer_time_cost",
        "input_tokens",
        "output_tokens",
        "cached_read_tokens",
    ):
        val = tm_meta.get(num_key)
        if isinstance(val, (int, float)) and not isinstance(val, bool):
            meta_out[num_key] = val
    if tm_meta.get("citations"):
        meta_out["citations"] = tm_meta["citations"]
    if judge_record.get("multimodal"):
        meta_out["multimodal"] = judge_record["multimodal"]

    return {
        "case_key": case_key,
        "case_id": canonical_case_id,
        "trace_id": trace_id,
        "session_id": session_id,
        "batch_id": version,
        "version": agent_label,
        "request_time": request_time,
        "meta": meta_out,
        "messages": messages,
    }


def build_testset_cases(
    run_id: str,
    dispatch_rows: list[dict[str, Any]],
    *,
    max_history_turns: int = 0,
) -> list[dict[str, Any]]:
    """Build TaskManager `POST /testsets` cases from internal-eval dispatch rows."""
    cases: list[dict[str, Any]] = []
    for row in dispatch_rows:
        case_key = str(row["case_key"])
        question = str(row.get("question") or "").strip()
        input_list: list[dict[str, Any]] = []

        if max_history_turns > 0 and row.get("turn") == "multi":
            prior_queries: list[str] = []
            for hmsg in row.get("history_messages") or []:
                if not isinstance(hmsg, dict) or hmsg.get("role") != "user":
                    continue
                content = hmsg.get("content")
                if not isinstance(content, str):
                    continue
                q_clean = content.strip()
                if not q_clean or q_clean == question:
                    continue
                if prior_queries and prior_queries[-1] == q_clean:
                    continue
                prior_queries.append(q_clean)
            for pq in prior_queries[-max_history_turns:]:
                input_list.append({"query": pq})

        input_list.append({"query": question})
        cases.append(
            {
                "case_id": f"{run_id}_{case_key}",
                "input_list": input_list,
                "case_key": case_key,
                "eq_index": int(row.get("eq_index") or 0),
                "source_trace_id": str(row.get("source_trace_id") or ""),
                "source_session_id": str(row.get("source_session_id") or ""),
                "turn": str(row.get("turn") or "single"),
                "run_id": run_id,
            }
        )
    return cases


class TaskManagerClient:
    """Thin stdlib HTTP client for TaskManager (`/api/v1/task`)."""

    def __init__(
        self,
        base_url: str,
        *,
        user_id: str = "",
        timeout_sec: float = 30.0,
        download_timeout_sec: float = 120.0,
        max_retries: int = 3,
    ):
        self.base_url = normalize_task_manager_base_url(base_url)
        if not self.base_url:
            raise ValueError("TaskManager base_url 不能为空")
        self.user_id = (user_id or "").strip()
        self.timeout_sec = timeout_sec
        self.download_timeout_sec = download_timeout_sec
        self.max_retries = max(1, max_retries)

    def _headers(self, *, json_body: bool = False, auth: bool = False) -> dict[str, str]:
        hdrs: dict[str, str] = {"Accept": "application/json"}
        if json_body:
            hdrs["Content-Type"] = "application/json"
        if (auth or self.user_id) and self.user_id:
            hdrs["X-User-Id"] = self.user_id
        return hdrs

    def _request_json(
        self,
        method: str,
        path: str,
        *,
        body: dict[str, Any] | None = None,
        auth: bool = False,
        timeout_sec: float | None = None,
    ) -> dict[str, Any]:
        url = f"{self.base_url}{path}"
        raw_body = json.dumps(body, ensure_ascii=False).encode("utf-8") if body is not None else None
        headers = self._headers(json_body=body is not None, auth=auth)
        timeout = timeout_sec or self.timeout_sec

        last_exc: Exception | None = None
        for attempt in range(self.max_retries):
            req = urllib.request.Request(url, data=raw_body, headers=headers, method=method)
            try:
                with urllib.request.urlopen(req, timeout=timeout) as resp:
                    payload = json.loads(resp.read().decode("utf-8", "replace") or "{}")
                if isinstance(payload, dict) and payload.get("status_code", 0) != 0:
                    raise TaskManagerError(
                        f"TaskManager {method} {path} 业务错误: {payload.get('status_msg') or payload.get('error_code')}",
                        http_status=200,
                        error_code=str(payload.get("error_code") or "TASK_MANAGER_ERROR"),
                        endpoint=path,
                        detail=payload,
                    )
                data = payload.get("data") if isinstance(payload, dict) else payload
                return data if isinstance(data, dict) else {"value": data}
            except urllib.error.HTTPError as exc:
                err_text = ""
                err_obj: dict[str, Any] = {}
                try:
                    err_text = exc.read().decode("utf-8", "replace")
                    parsed = json.loads(err_text)
                    if isinstance(parsed, dict):
                        err_obj = parsed
                except Exception:
                    pass
                finally:
                    exc.close()
                # Retry only on 5xx / 429
                if exc.code in (429, 500, 502, 503, 504) and attempt + 1 < self.max_retries:
                    time.sleep(min(1.5 * (2**attempt), 6.0))
                    last_exc = exc
                    continue
                err_code = str(err_obj.get("error_code") or f"HTTP_{exc.code}")
                msg = str(err_obj.get("status_msg") or err_obj.get("detail") or err_text[:300] or exc.reason)
                raise TaskManagerError(
                    f"TaskManager {method} {path} 失败 (HTTP {exc.code}, {err_code}): {msg}",
                    http_status=exc.code,
                    error_code=err_code,
                    endpoint=path,
                    detail=err_obj or err_text[:500],
                ) from exc
            except (urllib.error.URLError, TimeoutError, OSError, ValueError) as exc:
                last_exc = exc
                if attempt + 1 < self.max_retries:
                    time.sleep(min(1.5 * (2**attempt), 6.0))
                    continue
                raise TaskManagerError(
                    f"TaskManager {method} {path} 网络或解析异常: {exc}",
                    error_code="NETWORK_ERROR",
                    endpoint=path,
                ) from exc

        raise TaskManagerError(f"TaskManager {method} {path} 失败: {last_exc}", endpoint=path)

    # ---- Testset APIs ------------------------------------------------------

    def create_testset(self, name: str, cases: list[dict[str, Any]], *, description: str = "") -> dict[str, Any]:
        return self._request_json(
            "POST",
            "/testsets",
            body={"name": name, "description": description, "cases": cases},
        )

    def append_testset(self, testset_id: str, cases: list[dict[str, Any]]) -> dict[str, Any]:
        return self._request_json(
            "POST",
            f"/testsets/{urllib.parse.quote(testset_id)}/append",
            body={"cases": cases},
        )

    def create_testset_chunked(
        self,
        name: str,
        cases: list[dict[str, Any]],
        *,
        description: str = "",
        batch_size: int = 100,
    ) -> dict[str, Any]:
        if not cases:
            raise ValueError("create_testset_chunked 需要至少 1 条 case")
        chunk = max(1, min(int(batch_size), 100))
        first = self.create_testset(name, cases[:chunk], description=description)
        testset_id = str(first.get("testset_id") or "").strip()
        if not testset_id:
            raise TaskManagerError(f"创建数据集未返回 testset_id: {first}", endpoint="/testsets")
        for idx in range(chunk, len(cases), chunk):
            self.append_testset(testset_id, cases[idx : idx + chunk])
        return {"testset_id": testset_id, "total_count": len(cases)}

    # ---- Task Control APIs -------------------------------------------------

    def get_task(self, task_id: str) -> dict[str, Any]:
        return self._request_json("GET", f"/tasks/{urllib.parse.quote(task_id)}")

    def create_task(
        self,
        *,
        task_name: str,
        testset_selections: list[dict[str, Any]],
        pipeline: dict[str, Any],
        concurrency_limit: int = 10,
        description: str = "",
        concurrency_schedule: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        body: dict[str, Any] = {
            "task_name": task_name,
            "description": description,
            "testset_selections": testset_selections,
            "concurrency_limit": max(1, int(concurrency_limit)),
            "pipeline": pipeline,
        }
        if concurrency_schedule:
            body["concurrency_schedule"] = concurrency_schedule
        return self._request_json("POST", "/tasks", body=body)

    def start_task(self, task_id: str) -> dict[str, Any]:
        return self._request_json("POST", f"/tasks/{urllib.parse.quote(task_id)}/start", auth=True)

    def pause_task(self, task_id: str) -> dict[str, Any]:
        return self._request_json("POST", f"/tasks/{urllib.parse.quote(task_id)}/pause", auth=True)

    def cancel_task(self, task_id: str) -> dict[str, Any]:
        return self._request_json("POST", f"/tasks/{urllib.parse.quote(task_id)}/cancel", auth=True)

    def fill_missing(self, task_id: str) -> dict[str, Any]:
        return self._request_json("POST", f"/tasks/{urllib.parse.quote(task_id)}/fill_missing", auth=True)

    def reset_failed(self, task_id: str) -> dict[str, Any]:
        return self._request_json("POST", f"/tasks/{urllib.parse.quote(task_id)}/reset_failed", auth=True)

    def retry_recall(self, task_id: str, *, max_wait_sec: int = 60) -> dict[str, Any]:
        qs = urllib.parse.urlencode({"max_wait_sec": max(1, int(max_wait_sec))})
        return self._request_json(
            "POST",
            f"/tasks/{urllib.parse.quote(task_id)}/retry-recall?{qs}",
            timeout_sec=max(self.timeout_sec, float(max_wait_sec) + 30.0),
        )

    def generate_judge(self, task_id: str) -> dict[str, Any]:
        return self._request_json(
            "POST",
            f"/tasks/{urllib.parse.quote(task_id)}/generate_judge",
            timeout_sec=self.download_timeout_sec,
        )

    # ---- Items & Judge Download APIs ---------------------------------------

    def list_items(
        self,
        task_id: str,
        *,
        status: str | None = None,
        page: int = 1,
        size: int = 200,
    ) -> dict[str, Any]:
        params: dict[str, Any] = {"page": max(1, int(page)), "size": max(1, min(int(size), 200))}
        if status:
            params["status"] = status
        qs = urllib.parse.urlencode(params)
        return self._request_json("GET", f"/tasks/{urllib.parse.quote(task_id)}/items?{qs}")

    def iter_all_items(
        self,
        task_id: str,
        *,
        status: str | None = None,
        page_size: int = 200,
    ) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        page = 1
        size = max(1, min(int(page_size), 200))
        while True:
            data = self.list_items(task_id, status=status, page=page, size=size)
            items = data.get("items") if isinstance(data.get("items"), list) else []
            out.extend(it for it in items if isinstance(it, dict))
            total = int(data.get("total") or len(out))
            if not items or len(out) >= total or len(items) < size:
                break
            page += 1
        return out

    def download_judge(
        self,
        task_id: str,
        step_key: str,
        *,
        page: int = 1,
        size: int = 200,
        query: str | None = None,
        testset_id: str | None = None,
    ) -> tuple[list[dict[str, Any]], int]:
        """Download judge JSONL records for `step_key`. Returns `(records, x_total_count)`.

        Transparently handles both gzipped streams (e.g. `page=0` with `Content-Encoding: gzip`)
        and plain UTF-8 JSONL responses (e.g. paginated `page>=1`).
        """
        params: dict[str, Any] = {"page": max(0, int(page))}
        if page >= 1:
            params["size"] = max(1, min(int(size), 1000))
        if query:
            params["query"] = query
        if testset_id:
            params["testset_id"] = testset_id
        path = (
            f"/tasks/{urllib.parse.quote(task_id)}"
            f"/judge/{urllib.parse.quote(step_key, safe='')}/download"
            f"?{urllib.parse.urlencode(params)}"
        )
        url = f"{self.base_url}{path}"
        headers = self._headers(json_body=False, auth=False)

        last_exc: Exception | None = None
        for attempt in range(self.max_retries):
            req = urllib.request.Request(url, headers=headers, method="GET")
            try:
                with urllib.request.urlopen(req, timeout=self.download_timeout_sec) as resp:
                    x_total_raw = resp.headers.get("X-Total-Count") or resp.headers.get("x-total-count")
                    raw = resp.read()
                if not raw:
                    return [], int(x_total_raw) if x_total_raw and x_total_raw.isdigit() else 0
                if raw[:2] == b"\x1f\x8b":
                    text = gzip.decompress(raw).decode("utf-8", "replace")
                else:
                    text = raw.decode("utf-8", "replace")
                records: list[dict[str, Any]] = []
                for line in text.splitlines():
                    s = line.strip()
                    if not s:
                        continue
                    try:
                        obj = json.loads(s)
                    except ValueError:
                        continue
                    if isinstance(obj, dict):
                        records.append(obj)
                total = int(x_total_raw) if x_total_raw and x_total_raw.isdigit() else len(records)
                return records, total
            except urllib.error.HTTPError as exc:
                body = ""
                try:
                    body = exc.read().decode("utf-8", "replace")[:300]
                finally:
                    exc.close()
                if exc.code in (429, 500, 502, 503, 504) and attempt + 1 < self.max_retries:
                    time.sleep(min(1.5 * (2**attempt), 6.0))
                    last_exc = exc
                    continue
                raise TaskManagerError(
                    f"拉取 judge 明细失败 (HTTP {exc.code}): {body or exc.reason}",
                    http_status=exc.code,
                    endpoint=path,
                ) from exc
            except (urllib.error.URLError, TimeoutError, OSError, gzip.BadGzipFile) as exc:
                last_exc = exc
                if attempt + 1 < self.max_retries:
                    time.sleep(min(1.5 * (2**attempt), 6.0))
                    continue
                raise TaskManagerError(f"拉取 judge 明细网络异常: {exc}", endpoint=path) from exc

        raise TaskManagerError(f"拉取 judge 明细失败: {last_exc}", endpoint=path)

    def iter_all_judge_records(
        self,
        task_id: str,
        step_key: str,
        *,
        page_size: int = 200,
        testset_id: str | None = None,
    ) -> list[dict[str, Any]]:
        size = max(1, min(int(page_size), 1000))
        first_batch, total = self.download_judge(task_id, step_key, page=1, size=size, testset_id=testset_id)
        records = list(first_batch)
        if total <= len(records) or not first_batch:
            return records
        total_pages = (total + size - 1) // size
        for p in range(2, total_pages + 1):
            batch, _ = self.download_judge(task_id, step_key, page=p, size=size, testset_id=testset_id)
            if not batch:
                break
            records.extend(batch)
        return records


def build_task_spec_from_template(
    *,
    run: dict[str, Any],
    sides: list[str],
    client: TaskManagerClient,
    default_template_task_id: str = "",
) -> tuple[dict[str, Any], dict[str, str], dict[str, Any]]:
    """Build TaskManager `pipeline`, `{side: step_key}`, and inherited task-level defaults.

    Copies `pipeline`, positional `steps[idx]`, `concurrency_limit`, and `concurrency_schedule`
    from `template_task_id` (default `2740e85cb7b34909`), preserving template step keys
    unless explicitly overridden per side.
    """
    tm_meta = run.get("meta", {}).get("task_manager") if isinstance(run.get("meta"), dict) else {}
    if not isinstance(tm_meta, dict):
        tm_meta = {}

    run_template_id = str(tm_meta.get("template_task_id") or default_template_task_id or "").strip()
    template_doc_cache: dict[str, dict[str, Any]] = {}

    def _fetch_template_doc(tid: str) -> dict[str, Any]:
        if not tid:
            return {}
        if tid not in template_doc_cache:
            task_doc = client.get_task(tid)
            template_doc_cache[tid] = dict(task_doc) if isinstance(task_doc, dict) else {}
        return template_doc_cache[tid]

    def _fetch_template_pipeline(tid: str) -> dict[str, Any]:
        doc = _fetch_template_doc(tid)
        pipe = doc.get("pipeline")
        return dict(pipe) if isinstance(pipe, dict) else {}

    is_fast = "fast" in str(run.get("model") or "").lower()
    base_pipeline: dict[str, Any] = {
        "is_cn": False,
        "is_deep": False,
        "run_source": "",
        "raw_dir": "",
        "with_pic": False,
        "add_history": False,
        "parallel": len(sides) > 1,
        "steps": [],
    }
    template_defaults: dict[str, Any] = {}
    if run_template_id:
        tpl_doc = _fetch_template_doc(run_template_id)
        tpl_pipe = _fetch_template_pipeline(run_template_id)
        for field in PIPELINE_OVERRIDE_FIELDS:
            if field in tpl_pipe:
                base_pipeline[field] = tpl_pipe[field]
        tpl_cl = tpl_doc.get("concurrency_limit")
        if isinstance(tpl_cl, int) and not isinstance(tpl_cl, bool) and tpl_cl > 0:
            template_defaults["concurrency_limit"] = tpl_cl
        tpl_cs = tpl_doc.get("concurrency_schedule")
        if isinstance(tpl_cs, dict) and tpl_cs:
            template_defaults["concurrency_schedule"] = dict(tpl_cs)
        tpl_name = str(tpl_doc.get("task_name") or "").strip()
        if tpl_name:
            template_defaults["template_task_name"] = tpl_name

    pipe_overrides = tm_meta.get("pipeline") if isinstance(tm_meta.get("pipeline"), dict) else {}
    for field in PIPELINE_OVERRIDE_FIELDS:
        if field in pipe_overrides:
            base_pipeline[field] = pipe_overrides[field]

    used_keys: set[str] = set()
    side_to_step_key: dict[str, str] = {}
    steps: list[dict[str, Any]] = []

    for idx_side, side in enumerate(sides):
        agent_cfg = run["before_agent"] if side == "before" else run["after_agent"]
        agent_label = run["before_agent_label"] if side == "before" else run["after_agent_label"]
        agent_dict = agent_cfg if isinstance(agent_cfg, dict) else {}
        nested_step = agent_dict.get("step") if isinstance(agent_dict.get("step"), dict) else {}
        if not nested_step and isinstance(agent_dict.get("task_manager_step"), dict):
            nested_step = agent_dict["task_manager_step"]

        step_template_id = str(
            agent_dict.get("template_task_id")
            or nested_step.get("template_task_id")
            or run_template_id
            or ""
        ).strip()
        step_template_key = str(
            agent_dict.get("template_step_key")
            or nested_step.get("template_step_key")
            or ""
        ).strip()

        step: dict[str, Any] = {
            "key": "",
            "fetcher": "new",
            "is_pre": False,
            "is_deep": not is_fast,
            "mode": "fast" if is_fast else "expert",
            "runtime": None,
            "user_id": "",
            "schedule_user_id": "",
            "history": False,
            "agent_id": None,
            "event_name": None,
            "ab_test_content": None,
        }

        tpl_step_key = ""
        if step_template_id:
            tpl_pipe = _fetch_template_pipeline(step_template_id)
            tpl_steps = tpl_pipe.get("steps") if isinstance(tpl_pipe.get("steps"), list) else []
            chosen_tpl_step: dict[str, Any] | None = None
            if step_template_key:
                for ts in tpl_steps:
                    if isinstance(ts, dict) and str(ts.get("key") or "") == step_template_key:
                        chosen_tpl_step = ts
                        break
            if chosen_tpl_step is None and idx_side < len(tpl_steps) and isinstance(tpl_steps[idx_side], dict):
                chosen_tpl_step = tpl_steps[idx_side]
            if chosen_tpl_step is None and tpl_steps and isinstance(tpl_steps[0], dict):
                chosen_tpl_step = tpl_steps[0]
            if chosen_tpl_step:
                step.update(dict(chosen_tpl_step))
                tpl_step_key = str(chosen_tpl_step.get("key") or "").strip()

        # Apply explicit overrides (nested `step` first, then top-level `agent_dict`)
        for src in (nested_step, agent_dict):
            for field in STEP_OVERRIDE_FIELDS:
                if field in src:
                    step[field] = src[field]

        explicit_key = str(
            agent_dict.get("step_key")
            or nested_step.get("key")
            or agent_dict.get("key")
            or ""
        ).strip()
        raw_key = explicit_key or tpl_step_key or f"{side}-{agent_label}"
        candidate_key = _sanitize_step_key(raw_key, f"{side}-step")
        if candidate_key in used_keys:
            candidate_key = _sanitize_step_key(f"{side}-{candidate_key}", f"{side}-step")
        idx = 2
        final_key = candidate_key
        while final_key in used_keys:
            final_key = f"{candidate_key}-{idx}"
            idx += 1
        used_keys.add(final_key)
        step["key"] = final_key

        steps.append(step)
        side_to_step_key[side] = final_key

    base_pipeline["steps"] = steps
    if len(steps) > 1 and "parallel" not in pipe_overrides:
        base_pipeline["parallel"] = True
    return base_pipeline, side_to_step_key, template_defaults


def build_pipeline_and_step_map(
    *,
    run: dict[str, Any],
    sides: list[str],
    client: TaskManagerClient,
    default_template_task_id: str = "",
) -> tuple[dict[str, Any], dict[str, str]]:
    """Backward-compatible wrapper returning `(pipeline, {side: step_key})`."""
    pipeline, side_to_step_key, _ = build_task_spec_from_template(
        run=run,
        sides=sides,
        client=client,
        default_template_task_id=default_template_task_id,
    )
    return pipeline, side_to_step_key
