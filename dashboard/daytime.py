"""Dashboard 的统一时间口径。

AIME 是美东（America/New_York）；问财是国内业务，按 Asia/Shanghai 划日。
`local_day` / `local_day_minute` 都接受 product，未给或未知时沿用美东。
"""
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


def _zone(name):
    """容器可能缺 tzdata（例如没有 Asia/Shanghai）；中国无夏令时，固定 +08:00 等价。"""
    try:
        return ZoneInfo(name)
    except ZoneInfoNotFoundError:
        if name == "Asia/Shanghai":
            return timezone(timedelta(hours=8), name)
        raise


TZ = _zone("America/New_York")  # 默认：AIME
TZ_BY_PRODUCT = {"wencai": _zone("Asia/Shanghai")}


def tz_of(product=None):
    return TZ_BY_PRODUCT.get(product, TZ)


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


def local_day(value, product=None):
    """UTC ISO → 产品时区的 YYYY-MM-DD，失败返回 None。"""
    stamp = parse_utc(value)
    return stamp.astimezone(tz_of(product)).date().isoformat() if stamp else None


def local_day_minute(value, product=None):
    """UTC ISO → (产品时区日期, 当日分钟数)，失败返回 (None, None)。"""
    stamp = parse_utc(value)
    if stamp is None:
        return None, None
    local = stamp.astimezone(tz_of(product))
    return local.date().isoformat(), local.hour * 60 + local.minute


def iso_now() -> str:
    return datetime.now(TZ).isoformat(timespec="seconds")
