"""时间处理：输入是数据里各种 ISO8601 变体，输出统一为 UTC RFC3339；day 按 Asia/Shanghai。"""

from datetime import datetime, timedelta, timezone

CN = timezone(timedelta(hours=8))  # 中国无夏令时，固定 +08:00
UTC = timezone.utc


def parse_iso(value):
    """解析数据里的时间串，失败返回 None。

    支持的形态：``2026-10-23T05:59:22.770Z``、``2026-10-23T05:59:22Z``、
    ``2026-10-23 05:59:22``、``2026-10-23T05:59:22+08:00``。
    """
    if not value or not isinstance(value, str):
        return None
    text = value.strip()
    if not text:
        return None
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed


def utc_rfc3339(dt):
    if dt is None:
        return None
    return dt.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def cn_day(dt):
    """UTC 时间 → Asia/Shanghai 的 YYYY-MM-DD。"""
    if dt is None:
        return None
    return dt.astimezone(CN).strftime("%Y-%m-%d")


def day_of(value):
    return cn_day(parse_iso(value))


def seconds_ago(iso_value, now=None):
    dt = parse_iso(iso_value)
    if dt is None:
        return None
    now = now or datetime.now(UTC)
    return (now - dt).total_seconds()
