"""时间处理：输入是数据里各种 ISO8601 变体，输出统一为 UTC RFC3339；day 按产品时区（AIME 美东、问财北京）。"""

from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

EASTERN = ZoneInfo("America/New_York")  # 美东，自动处理 EST/EDT
UTC = timezone.utc
_ZONES = {"America/New_York": EASTERN}


def zone(name: str | None):
    if not name:
        return EASTERN
    try:
        return _ZONES[name]
    except KeyError:
        pass
    try:
        _ZONES[name] = ZoneInfo(name)
    except ZoneInfoNotFoundError:
        if name != "Asia/Shanghai":
            raise
        # 容器可能缺 tzdata；中国无夏令时，固定 +08:00 与 Asia/Shanghai 等价。
        _ZONES[name] = timezone(timedelta(hours=8), name)
    return _ZONES[name]


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


def local_day(dt, tz: str | None = None):
    """UTC 时间 → 指定时区的 YYYY-MM-DD（默认美东，含夏令时）。"""
    if dt is None:
        return None
    return dt.astimezone(zone(tz)).strftime("%Y-%m-%d")
