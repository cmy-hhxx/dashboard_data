"""Structured API error types aligned with the 5003 protocol."""

from __future__ import annotations

from typing import Any


class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str, details: dict[str, Any] | None = None):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.details = details or {}


def invalid(message: str, param: str | None = None, **details: Any) -> ApiError:
    payload = dict(details)
    if param:
        payload["param"] = param
    return ApiError(400, "INVALID_ARGUMENT", message, payload)


def unauthorized(message: str = "缺少或无效的访问令牌", **details: Any) -> ApiError:
    return ApiError(401, "UNAUTHORIZED", message, details)


def not_found(message: str, **details: Any) -> ApiError:
    return ApiError(404, "NOT_FOUND", message, details)


def conflict(message: str, **details: Any) -> ApiError:
    return ApiError(409, "CONFLICT", message, details)


def unknown_value(param: str, value: Any, allowed: list[Any] | tuple[Any, ...]) -> ApiError:
    return ApiError(
        422,
        "UNKNOWN_VALUE",
        f"{param} 的取值 {value!r} 不在允许范围内",
        {"param": param, "value": value, "allowed": list(allowed)},
    )


def cursor_expired(message: str = "cursor 已过期或无效，请从第一页重新开始") -> ApiError:
    return ApiError(410, "CURSOR_EXPIRED", message, {})


def rate_limited(message: str = "请求过多，请稍后重试", retry_after: int = 1) -> ApiError:
    return ApiError(429, "RATE_LIMITED", message, {"retry_after": retry_after})


def unavailable(message: str, **details: Any) -> ApiError:
    return ApiError(503, "UNAVAILABLE", message, details)
