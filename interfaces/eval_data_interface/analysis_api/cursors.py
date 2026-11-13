"""无状态签名 cursor：绑定筛选条件、页大小与签发时间，服务端不存任何状态。"""

import base64
import hashlib
import hmac
import json
import os
import time
from pathlib import Path

from . import config


_SECRETS = {}


def _secret():
    """Signing key, read once per state dir.

    ``ANALYSIS_CURSOR_KEY`` wins: every host behind one entry point must share it, or a
    cursor issued by one host fails on the next.  Without it each host keeps its own
    random key in ``<state>/cursor.key`` (fine for a single host).
    """
    shared = os.environ.get("ANALYSIS_CURSOR_KEY", "").strip()
    if shared:
        return shared.encode("utf-8")
    path: Path = config.secret_path()
    cached = _SECRETS.get(path)
    if cached is not None:
        return cached
    if path.exists():
        secret = path.read_bytes()
    else:
        path.parent.mkdir(parents=True, exist_ok=True)
        secret = os.urandom(32)
        path.write_bytes(secret)
        try:
            path.chmod(0o600)
        except OSError:
            pass
    _SECRETS[path] = secret
    return secret


def filter_hash(payload) -> str:
    text = json.dumps(payload, ensure_ascii=False, sort_keys=True, default=str)
    return hashlib.sha1(text.encode("utf-8")).hexdigest()[:16]


def _pack(body) -> str:
    raw = json.dumps(body, ensure_ascii=False, separators=(",", ":"), default=str).encode("utf-8")
    signature = hmac.new(_secret(), raw, hashlib.sha256).digest()[:16]
    return base64.urlsafe_b64encode(signature + raw).decode("ascii").rstrip("=")


def _unpack(token: str) -> dict:
    if not token:
        raise CursorError("token 为空")
    try:
        padded = token + "=" * (-len(token) % 4)
        blob = base64.urlsafe_b64decode(padded.encode("ascii"))
    except Exception as exc:  # noqa: BLE001
        raise CursorError("token 不是合法的 base64") from exc
    if len(blob) < 17:
        raise CursorError("token 长度不足")
    signature, raw = blob[:16], blob[16:]
    expected = hmac.new(_secret(), raw, hashlib.sha256).digest()[:16]
    if not hmac.compare_digest(signature, expected):
        raise CursorError("token 签名不匹配")
    try:
        body = json.loads(raw)
    except ValueError as exc:
        raise CursorError("token 内容损坏") from exc
    if not isinstance(body, dict):
        raise CursorError("token 内容损坏")
    return body


def encode(kind: str, filter_key: str, page_size: int, last_key) -> str:
    return _pack(
        {
            "k": kind,
            "f": filter_key,
            "p": page_size,
            "t": int(time.time()),
            "c": last_key,
        }
    )


def encode_since(dataset: str, seq: int) -> str:
    """同步位点：只绑定 dataset 与 seq，不设有效期（客户端要长期保存）。"""
    return _pack({"k": "since", "f": dataset, "s": int(seq)})


def decode_since(token: str, dataset: str) -> int:
    """解析同步位点；也接受纯数字 seq，方便手工排查。"""
    text = str(token).strip()
    if text.isdigit():
        return int(text)
    body = _unpack(text)
    if body.get("k") != "since":
        raise CursorError("token 不是同步位点")
    if body.get("f") != dataset:
        raise CursorError("同步位点与 dataset 不匹配")
    try:
        return int(body.get("s"))
    except (TypeError, ValueError) as exc:
        raise CursorError("同步位点内容损坏") from exc


class CursorError(ValueError):
    def __init__(self, message, expired=False):
        super().__init__(message)
        self.expired = expired


def decode(token: str, kind: str, filter_key: str):
    body = _unpack(token)
    if body.get("k") != kind:
        raise CursorError("cursor 与接口不匹配")
    if body.get("f") != filter_key:
        raise CursorError("cursor 与当前筛选条件不匹配")
    age = time.time() - float(body.get("t") or 0)
    if age > config.CURSOR_TTL:
        raise CursorError("cursor 已过期", expired=True)
    return body
