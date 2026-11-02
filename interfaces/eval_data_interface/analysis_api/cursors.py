"""无状态签名 cursor：绑定筛选条件、页大小与签发时间，服务端不存任何状态。"""

import base64
import hashlib
import hmac
import json
import os
import time
from pathlib import Path

from . import config


def _secret():
    path: Path = config.secret_path()
    if path.exists():
        return path.read_bytes()
    path.parent.mkdir(parents=True, exist_ok=True)
    secret = os.urandom(32)
    path.write_bytes(secret)
    try:
        path.chmod(0o600)
    except OSError:
        pass
    return secret


def filter_hash(payload) -> str:
    text = json.dumps(payload, ensure_ascii=False, sort_keys=True, default=str)
    return hashlib.sha1(text.encode("utf-8")).hexdigest()[:16]


def encode(kind: str, filter_key: str, page_size: int, last_key) -> str:
    body = {
        "k": kind,
        "f": filter_key,
        "p": page_size,
        "t": int(time.time()),
        "c": last_key,
    }
    raw = json.dumps(body, ensure_ascii=False, separators=(",", ":"), default=str).encode("utf-8")
    signature = hmac.new(_secret(), raw, hashlib.sha256).digest()[:16]
    return base64.urlsafe_b64encode(signature + raw).decode("ascii").rstrip("=")


class CursorError(ValueError):
    def __init__(self, message, expired=False):
        super().__init__(message)
        self.expired = expired


def decode(token: str, kind: str, filter_key: str):
    if not token:
        raise CursorError("cursor 为空")
    try:
        padded = token + "=" * (-len(token) % 4)
        blob = base64.urlsafe_b64decode(padded.encode("ascii"))
    except Exception as exc:  # noqa: BLE001
        raise CursorError("cursor 不是合法的 base64") from exc
    if len(blob) < 17:
        raise CursorError("cursor 长度不足")
    signature, raw = blob[:16], blob[16:]
    expected = hmac.new(_secret(), raw, hashlib.sha256).digest()[:16]
    if not hmac.compare_digest(signature, expected):
        raise CursorError("cursor 签名不匹配")
    try:
        body = json.loads(raw)
    except ValueError as exc:
        raise CursorError("cursor 内容损坏") from exc
    if body.get("k") != kind:
        raise CursorError("cursor 与接口不匹配")
    if body.get("f") != filter_key:
        raise CursorError("cursor 与当前筛选条件不匹配")
    age = time.time() - float(body.get("t") or 0)
    if age > config.CURSOR_TTL:
        raise CursorError("cursor 已过期", expired=True)
    return body
