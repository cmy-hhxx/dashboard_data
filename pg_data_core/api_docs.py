"""Self-contained route metadata and embedded documentation for `/api/v1/data-core/*`.

Single source of truth powering:
- `GET /api/v1/data-core` & `GET /api/v1/data-core/docs` (JSON or `?format=markdown`)
- `GET /api/v1/data-core/docs/<slug>` & `GET /api/v1/data-core/docs?path=<tail>`
- Actionable 404 / 405 / 422 `hint` generation in `http_api.py`
"""

from __future__ import annotations

import difflib
import json
from typing import Any

PREFIX = "/api/v1/data-core"

STATE_MACHINE = (
    "pending -> claimed (active lease: claimed_by IS NOT NULL) -> evaluated | skipped | failed; "
    "retrying = claimed with claimed_by IS NULL & lease_expires_at >= now(); "
    "requeue resets eval_inputs to pending while keeping eval_outputs(is_latest=TRUE) untouched; "
    "delete sets is_deleted=TRUE + deleted_at and emits changes(op='delete')."
)

AUTH_SUMMARY: dict[str, Any] = {
    "headers": [
        "Authorization: Bearer <token>",
        "X-Api-Token: <token>",
        "X-API-Key: <token>",
    ],
    "localhost_bypass": "127.0.0.1 / ::1 allowed when DATA_CORE_ALLOW_LOCALHOST=true",
    "public_endpoints": ["GET /", "GET /docs", "GET /docs/<slug>", "GET /health", "GET /healthz"],
}

API_ENDPOINTS: tuple[dict[str, Any], ...] = (
    {
        "slug": "docs",
        "group": "meta",
        "method": "GET",
        "path": "/docs",
        "aliases": ["/", "/docs/<slug>"],
        "auth": False,
        "summary": "查看全部接口简洁文档（默认 JSON，传 ?format=markdown 返回 Markdown，或 /docs/<slug> / ?path=... 查单接口）",
        "params": {
            "format": "json (default) | markdown | md",
            "path": "可选，按路径过滤单个接口（如 /inputs/requeue）",
        },
        "example": "GET /api/v1/data-core/docs?format=markdown",
        "returns": "service, prefix, auth, state_machine, endpoints[]",
    },
    {
        "slug": "health",
        "group": "meta",
        "method": "GET",
        "path": "/health",
        "aliases": ["/healthz"],
        "auth": False,
        "summary": "健康检查与 PG 实时表行数、db_epoch、最新变更位点",
        "params": {},
        "example": "GET /api/v1/data-core/health",
        "returns": "ok, db_epoch, data_root, pg, counts",
    },
    {
        "slug": "monitor-summary",
        "group": "meta",
        "method": "GET",
        "path": "/monitor/summary",
        "auth": True,
        "summary": "实时扫描基表返回评测总量、6 桶队列状态（pending/claimed/retrying/evaluated/failed/skipped）、人话与聚类进度",
        "params": {"models": "可选，逗号分隔模型名（如 aime_expert,aime_fast）"},
        "example": "GET /api/v1/data-core/monitor/summary?models=aime_fast,aime_expert",
        "returns": "generated_at, db_epoch, totals, queue, models[], lost_user, cluster",
    },
    {
        "slug": "detail",
        "group": "read",
        "method": "GET",
        "path": "/detail/<input_id>",
        "auth": True,
        "summary": "按 input_id 走 Zstd pread 拼接原始 input + 最新 attribution + compact（可选人话译文叠加）",
        "params": {
            "input_id": "路径参数，正整数 (required)",
            "text_mode": "raw (default) | human",
        },
        "example": "GET /api/v1/data-core/detail/101?text_mode=human",
        "returns": "input_id, output_id, model, trace_id, biz_day, text_mode, input, attribution, compact",
    },
    {
        "slug": "inputs-ingest",
        "group": "inputs",
        "method": "POST",
        "path": "/inputs",
        "auth": True,
        "summary": "Step 1 Blob-First 写入原始评测输入并按 (product, model, trace_id) 幂等去重",
        "params": {
            "model": "模型名，如 aime_expert / aime_fast (required)",
            "records": "原始记录数组（与 record 二选一）",
            "record": "单条原始记录对象（与 records 二选一）",
            "source": "来源标记，默认 prelaunch",
            "fallback_day": "可选 YYYY-MM-DD，记录缺时间时兜底",
        },
        "example": {"model": "aime_fast", "records": [{"trace_id": "t_001", "meta": {"trace_id": "t_001"}}]},
        "returns": "count, items[{input_id, deduplicated}]",
    },
    {
        "slug": "inputs-claim",
        "group": "inputs",
        "method": "POST",
        "path": "/inputs/claim",
        "auth": True,
        "summary": "Step 2 原子领题（FOR UPDATE SKIP LOCKED），返回租约信息及可选原始 payload",
        "params": {
            "model / models": "至少传其一（单模型或模型列表） (required)",
            "worker_id": "worker 标识，默认 worker",
            "limit": "领题条数 1..200，默认 10",
            "lease_seconds": "租约秒数 30..86400，默认 600",
            "strategy": "newest_first (default) | date_even",
            "priority_days": "date_even 优先最近天数 1..60，默认 7",
            "biz_day": "可选 YYYY-MM-DD，仅领指定业务日",
            "include_payload": "bool，默认 false；true 时内联 Zstd 解压后的 input",
        },
        "example": {"models": ["aime_fast", "aime_expert"], "worker_id": "va-0", "limit": 10, "strategy": "date_even"},
        "returns": "claimed[{input_id, model, trace_id, biz_day, rel_path, input_offset, input_len, eval_attempts, lease_expires_at}]",
    },
    {
        "slug": "inputs-heartbeat",
        "group": "inputs",
        "method": "POST",
        "path": "/inputs/heartbeat",
        "auth": True,
        "summary": "续期指定 worker 当前持有的在飞租约",
        "params": {
            "worker_id": "持有租约的 worker 标识 (required)",
            "input_ids": "input_id 数组，上限 500 (required)",
            "lease_seconds": "续期秒数 30..86400，默认 900",
        },
        "example": {"worker_id": "va-0", "input_ids": [101, 102], "lease_seconds": 900},
        "returns": "requested, renewed, renewed_ids, lease_expires_at",
    },
    {
        "slug": "inputs-release",
        "group": "inputs",
        "method": "POST",
        "path": "/inputs/release",
        "auth": True,
        "summary": "主动释放指定 worker 持有的租约立即回到 pending",
        "params": {
            "worker_id": "持有租约的 worker 标识 (required)",
            "input_ids": "input_id 数组，上限 500 (required)",
            "decrement_attempts": "bool，默认 true（释放时回退 1 次尝试计数）",
        },
        "example": {"worker_id": "va-0", "input_ids": [101], "decrement_attempts": True},
        "returns": "requested, released, released_ids",
    },
    {
        "slug": "inputs-fail",
        "group": "inputs",
        "method": "POST",
        "path": "/inputs/fail",
        "auth": True,
        "summary": "上报不可评（skipped）或失败（自动按 max_attempts 转 retrying 退避或终态 failed）",
        "params": {
            "worker_id": "持有租约的 worker 标识 (required)",
            "items": "数组[{input_id, status: 'skipped'|'failed', error?, retry_after_seconds?, max_attempts?}]，上限 200 (required)",
            "max_attempts": "默认最大重试次数，默认 3",
        },
        "example": {"worker_id": "va-0", "items": [{"input_id": 101, "status": "skipped", "error": "message_too_large"}]},
        "returns": "results[{input_id, applied, eval_status, eval_attempts, next_retry_at?}]",
    },
    {
        "slug": "inputs-requeue",
        "group": "inputs",
        "method": "POST",
        "path": "/inputs/requeue",
        "auth": True,
        "summary": "批量重评入队：将 eval_inputs 置回 pending，严禁修改/删除旧 eval_outputs(is_latest=TRUE)",
        "params": {
            "items / input_ids": "二选一，上限 5000；items=[{model, trace_id}] 或 input_ids=[int] (required)",
            "only_statuses": "允许入队的状态白名单，默认 ['evaluated','failed','skipped']；支持 'retrying'，禁止 'claimed'",
            "require_blob": "bool，默认 true（跳过 has_input_blob=FALSE 的合成行）",
            "reset_attempts": "bool，默认 true（重置 eval_attempts=0）",
            "reason": "溯源原因，写入 extra.requeue_reason / extra.requeued_at",
            "dry_run": "bool，默认 false；true 时仅统计命中/跳过分布，不落库",
        },
        "example": {
            "items": [{"model": "aime_expert", "trace_id": "t_001"}],
            "only_statuses": ["evaluated", "failed", "skipped"],
            "reason": "reeval_r533",
            "dry_run": False,
        },
        "returns": "requested, requeued, requeued_ids, skipped_missing, skipped_deleted, skipped_no_blob, skipped_status, dry_run",
    },
    {
        "slug": "inputs-delete",
        "group": "inputs",
        "method": "POST",
        "path": "/inputs/delete",
        "auth": True,
        "summary": "批量软删不可评/毒丸样本（is_deleted=TRUE + deleted_at + 写 changes delete + 可选刷物化视图）",
        "params": {
            "status / input_ids / items": "三选一：status 仅允许 'skipped'|'failed'；input_ids/items 上限 5000 (required)",
            "models": "可选模型列表，仅配合 status 过滤",
            "error_prefix": "可选 eval_error 精确前缀（starts_with），仅配合 status 过滤",
            "allow_with_outputs": "bool，默认 false（安全护栏：跳过已有 eval_outputs(is_latest=TRUE) 的行）",
            "reason": "溯源原因，写入 extra.delete_reason / extra.deleted_at",
            "refresh_views": "bool，默认 true（deleted>0 时用 admin 角色并发刷新 3 张物化视图）",
            "dry_run": "bool，默认 false；建议全量按 status 清理前先 dry_run=true 核对",
        },
        "example": {
            "status": "skipped",
            "models": ["aime_fast", "aime_expert"],
            "error_prefix": "message_too_large",
            "allow_with_outputs": False,
            "reason": "drop_oversized_skipped",
            "refresh_views": True,
        },
        "returns": "deleted, deleted_ids, skipped_with_outputs, skipped_missing, skipped_deleted, views_refreshed, dry_run",
    },
    {
        "slug": "outputs-commit",
        "group": "outputs",
        "method": "POST",
        "path": "/outputs",
        "auth": True,
        "summary": "Step 2 Blob-First 提交归因结果（+可选 compact），单事务原子切换 is_latest 并写 eval_problems/changes",
        "params": {
            "model": "模型名 (required)",
            "attribution": "归因 JSON 对象 (required)",
            "compact": "可选 compact JSON 对象",
            "evaluator_version": "评测器版本，默认 v1",
            "judge_model": "可选裁判模型名",
            "input_id": "可选，直连对应 eval_inputs 主键",
            "eval_duration_ms / eval_cost_usd": "可选耗时与成本",
            "fallback_day": "可选 YYYY-MM-DD",
        },
        "example": {"model": "aime_fast", "attribution": {"turns": []}, "evaluator_version": "r533", "input_id": 101},
        "returns": "output_ids[]",
    },
    {
        "slug": "human-read-pending",
        "group": "human_read",
        "method": "GET",
        "path": "/human-read/pending",
        "auth": True,
        "summary": "拉取待人话翻译的最新输出列表（返回 Zstd 分包路径与字节偏移）",
        "params": {
            "models": "可选，逗号分隔模型",
            "dates": "可选，逗号分隔 YYYY-MM-DD",
            "kinds": "可选，attribution,compact（默认两者）",
            "prompt_version": "可选，按目标 prompt 版本判定待翻",
            "include_failed": "bool，默认 false",
            "limit": "1..500，默认 100",
        },
        "example": "GET /api/v1/data-core/human-read/pending?models=aime_expert&kinds=attribution&limit=50",
        "returns": "items[{output_id, input_id, model, trace_id, biz_day, target_kind, target_rel_path, target_offset, target_len}]",
    },
    {
        "slug": "human-read-commit",
        "group": "human_read",
        "method": "POST",
        "path": "/human-read",
        "auth": True,
        "summary": "Step 2.5 Blob-First 提交人话增量译文（仅落盘 delta 字段，不镜像整行）",
        "params": {
            "record": "含译文字段与 _human_read 元数据的对象 (required)",
            "output_id / (model, trace_id)": "定位目标最新 output 二选一 (required)",
            "target_kind": "attribution (default) | compact",
        },
        "example": {"output_id": 99, "target_kind": "attribution", "record": {"_human_read": {"prompt_version": "v1.3"}}},
        "returns": "overlay_id, hr_hash",
    },
    {
        "slug": "human-read-fail",
        "group": "human_read",
        "method": "POST",
        "path": "/human-read/fail",
        "auth": True,
        "summary": "记录人话翻译失败状态（不会覆盖同版本已成功的 done 译文）",
        "params": {
            "output_id": "目标 output_id (required)",
            "target_kind": "attribution | compact (required)",
            "prompt_version / translator_model / source_hash / error": "可选失败上下文",
        },
        "example": {"output_id": 99, "target_kind": "attribution", "prompt_version": "v1.3", "error": "schema_mismatch"},
        "returns": "output_id, target_kind, status",
    },
    {
        "slug": "categories",
        "group": "enrichment",
        "method": "POST",
        "path": "/categories",
        "auth": True,
        "summary": "Step 4 批量回填意图分类（task_category / subtask_category，默认仅填空白）",
        "params": {
            "items": "数组[{model, trace_id, task_category?, subtask_category?}] (required)",
            "overwrite": "bool，默认 false",
        },
        "example": {"items": [{"model": "aime_fast", "trace_id": "t_001", "task_category": "个股分析"}], "overwrite": False},
        "returns": "requested, updated",
    },
    {
        "slug": "clusters-bind",
        "group": "enrichment",
        "method": "POST",
        "path": "/clusters/bind",
        "auth": True,
        "summary": "Step 3 增量绑定 eval_problems 四层聚类编码，自动触发 changes 并推进 data_cutoff",
        "params": {
            "bindings": "数组[{problem_id, cluster_code, is_edge?, tags?}] (required)",
            "tree_id / cluster_version / data_cutoff": "可选聚类树版本与水位推进信息",
        },
        "example": {"tree_id": 5, "cluster_version": "2.0", "bindings": [{"problem_id": 10, "cluster_code": "S1.M1.1"}]},
        "returns": "updated, changes_emitted",
    },
    {
        "slug": "reconcile",
        "group": "ops",
        "method": "POST",
        "path": "/reconcile",
        "auth": True,
        "summary": "尾部自愈：回放 Zstd 未提交尾帧并回收过期 Step 2 租约",
        "params": {"lookback_minutes": "回溯分钟数 1..10080，默认 60"},
        "example": {"lookback_minutes": 60},
        "returns": "files_scanned, files_healed, records_recovered, bytes_recovered, leases_reclaimed, details[]",
    },
    {
        "slug": "views-refresh",
        "group": "ops",
        "method": "POST",
        "path": "/views/refresh",
        "auth": True,
        "summary": "刷新 3 张统计物化视图（stats_daily_overview / intent / cluster）",
        "params": {"concurrently": "bool，默认 true"},
        "example": {"concurrently": True},
        "returns": "timings{stats_daily_overview, stats_daily_intent, stats_daily_cluster}",
    },
)


def _norm_path(raw: str) -> str:
    p = (raw or "").strip()
    if p.startswith(PREFIX):
        p = p[len(PREFIX) :]
    p = "/" + p.strip("/") if p.strip("/") else "/"
    return p


def _match_route_pattern(tail: str, pattern: str) -> bool:
    if pattern == tail:
        return True
    if pattern.endswith("/<input_id>") and tail.startswith("/detail/"):
        return True
    if pattern.endswith("/<slug>") and tail.startswith("/docs/"):
        return True
    return False


def allowed_methods_for_path(tail: str) -> list[str]:
    """Return sorted HTTP methods supported by `tail` (empty list if path is unknown)."""
    methods: set[str] = set()
    for ep in API_ENDPOINTS:
        candidates = [ep["path"], *ep.get("aliases", ())]
        if any(_match_route_pattern(tail, c) for c in candidates):
            methods.add(ep["method"])
    return sorted(methods)


def find_endpoint_doc(selector: str) -> dict[str, Any] | None:
    """Lookup one endpoint doc by `slug` (e.g. `inputs-requeue`) or path (`/inputs/requeue`)."""
    raw = (selector or "").strip()
    if not raw:
        return None
    low = raw.lower().strip("/")
    norm_p = _norm_path(raw)
    for ep in API_ENDPOINTS:
        if ep["slug"].lower() == low:
            return ep
        candidates = [ep["path"], *ep.get("aliases", ())]
        if any(_match_route_pattern(norm_p, c) for c in candidates):
            return ep
    return None


def suggest_route_hint(tail: str) -> str:
    """Produce a helpful hint with closest matching routes for 404 errors."""
    known_paths = [ep["path"] for ep in API_ENDPOINTS]
    matches = difflib.get_close_matches(tail, known_paths, n=2, cutoff=0.45)
    if matches:
        labeled = []
        for m in matches:
            ep = find_endpoint_doc(m)
            labeled.append(f"{ep['method']} {PREFIX}{m}" if ep else f"{PREFIX}{m}")
        return f"Did you mean {' or '.join(labeled)}? Full docs: GET {PREFIX}/docs"
    return f"See GET {PREFIX}/docs (or ?format=markdown) for all supported endpoints."


def build_docs_index() -> dict[str, Any]:
    """Return structured JSON documentation for the entire Data Core HTTP gateway."""
    return {
        "service": "pg_data_core",
        "prefix": PREFIX,
        "auth": AUTH_SUMMARY,
        "state_machine": STATE_MACHINE,
        "conventions": {
            "success": '{"request_id":"dc_...","data":{...}}',
            "error": '{"request_id":"dc_...","error":{"code":"...","message":"...","hint":"..."}}',
            "markdown_view": f"GET {PREFIX}/docs?format=markdown",
            "single_endpoint": f"GET {PREFIX}/docs/<slug> or GET {PREFIX}/docs?path=/inputs/requeue",
        },
        "endpoints": [
            {
                "slug": ep["slug"],
                "group": ep["group"],
                "method": ep["method"],
                "path": f"{PREFIX}{ep['path']}",
                "auth": ep["auth"],
                "summary": ep["summary"],
                "params": ep["params"],
                "example": ep["example"],
                "returns": ep["returns"],
                "doc_url": f"{PREFIX}/docs/{ep['slug']}",
            }
            for ep in API_ENDPOINTS
        ],
    }


def render_endpoint_markdown(ep: dict[str, Any]) -> str:
    lines = [
        f"# `{ep['method']} {PREFIX}{ep['path']}` (`{ep['slug']}`)",
        "",
        f"{ep['summary']}",
        "",
        f"- **鉴权**：{'需要 Token（本机默认豁免）' if ep['auth'] else '免鉴权'}",
        f"- **返回字段**：`{ep['returns']}`",
    ]
    if ep.get("aliases"):
        aliases = ", ".join(f"`{PREFIX}{a}`" for a in ep["aliases"])
        lines.append(f"- **别名**：{aliases}")
    if ep["params"]:
        lines.extend(["", "## 参数", "", "| 参数 | 说明 |", "|---|---|"])
        for k, v in ep["params"].items():
            lines.append(f"| `{k}` | {v} |")
    lines.extend(["", "## 示例", ""])
    ex = ep["example"]
    if isinstance(ex, str):
        lines.extend(["```http", ex, "```"])
    else:
        lines.extend(["```json", json.dumps(ex, ensure_ascii=False, indent=2), "```"])
    return "\n".join(lines) + "\n"


def render_docs_markdown() -> str:
    """Render a concise single-page Markdown quick-reference for `/api/v1/data-core/*`."""
    lines = [
        f"# `pg_data_core` HTTP 接口速查（`{PREFIX}/*`）",
        "",
        f"- **鉴权**：{' / '.join(f'`{h}`' for h in AUTH_SUMMARY['headers'])}（本机 `127.0.0.1` 默认免鉴权；`/docs` 与 `/health` 公开可读）",
        f"- **状态机**：{STATE_MACHINE}",
        f"- **单接口详情**：`GET {PREFIX}/docs/<slug>` 或 `GET {PREFIX}/docs?path=/inputs/requeue`（加 `?format=markdown` 看 Markdown）",
        "",
        "## 端点总览",
        "",
        "| Method | Path | Slug | 鉴权 | 说明 |",
        "|---|---|---|---|---|",
    ]
    for ep in API_ENDPOINTS:
        auth_txt = "Token" if ep["auth"] else "Public"
        lines.append(f"| `{ep['method']}` | `{ep['path']}` | `{ep['slug']}` | {auth_txt} | {ep['summary']} |")

    lines.extend(["", "## 常用写操作示例", ""])
    for slug in ("inputs-requeue", "inputs-delete", "inputs-claim", "outputs-commit"):
        ep = find_endpoint_doc(slug)
        if not ep:
            continue
        lines.append(f"### `{ep['method']} {PREFIX}{ep['path']}`")
        lines.append("")
        lines.append("```json")
        lines.append(json.dumps(ep["example"], ensure_ascii=False, indent=2))
        lines.append("```")
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"
