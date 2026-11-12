"""Dashboard 的统一时间口径：所有展示/分组日期按美东时间（America/New_York）。"""

from datetime import datetime, timezone
from zoneinfo import ZoneInfo

TZ = ZoneInfo("America/New_York")  # 自动处理 EST/EDT


def parse_utc(value):
    """Parse an ISO8601 value as UTC; naive strings are UTC (data convention)."""
    text = str(value or "").strip()
    if not text:
        return None
    try:
        stamp = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    if stamp.tzinfo is None:
        stamp = stamp.replace(tzinfo=timezone.utc)
    return stamp


def local_day(value):
    """UTC ISO → America/New_York 的 YYYY-MM-DD，失败返回 None。"""
    stamp = parse_utc(value)
    return stamp.astimezone(TZ).date().isoformat() if stamp else None


def local_day_minute(value):
    """UTC ISO → (America/New_York 日期, 当日分钟数)，失败返回 (None, None)。"""
    stamp = parse_utc(value)
    if stamp is None:
        return None, None
    local = stamp.astimezone(TZ)
    return local.date().isoformat(), local.hour * 60 + local.minute


def iso_now() -> str:
    return datetime.now(TZ).isoformat(timespec="seconds")
