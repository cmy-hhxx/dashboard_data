"""时间处理：输入是数据里各种 ISO8601 变体，输出统一为 UTC RFC3339；day 按美东时间。"""

from datetime import datetime, timezone
from zoneinfo import ZoneInfo

EASTERN = ZoneInfo("America/New_York")  # 美东，自动处理 EST/EDT
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


def local_day(dt):
    """UTC 时间 → America/New_York 的 YYYY-MM-DD（含夏令时）。"""
    if dt is None:
        return None
    return dt.astimezone(EASTERN).strftime("%Y-%m-%d")
