"""统一的错误类型：status + code + message + details，对应协议第 10 节。"""


class ApiError(Exception):
    def __init__(self, status, code, message, details=None):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.details = details or {}


def invalid(message, param=None, **details):
    payload = dict(details)
    if param:
        payload["param"] = param
    return ApiError(400, "INVALID_ARGUMENT", message, payload)


def unknown_codes(param, values, version=None):
    return ApiError(
        422,
        "UNKNOWN_CODE",
        f"{param} 含有不在分类体系中的编码",
        {"param": param, "unknown": list(values), "taxonomy_version": version},
    )


def unknown_value(param, value, allowed):
    return ApiError(
        422,
        "UNKNOWN_CODE",
        f"{param} 的取值 {value!r} 不在允许范围内",
        {"param": param, "value": value, "allowed": list(allowed)},
    )


def not_found(message, **details):
    return ApiError(404, "NOT_FOUND", message, details)


def too_many_ids(param, limit, count):
    return ApiError(413, "TOO_MANY_IDS", f"{param} 超过单次上限 {limit}", {"param": param, "limit": limit, "count": count})


def cursor_expired(message="cursor 已过期，请从第一页重新开始"):
    return ApiError(410, "CURSOR_EXPIRED", message, {})


def unavailable(message, **details):
    return ApiError(503, "UNAVAILABLE", message, details)
