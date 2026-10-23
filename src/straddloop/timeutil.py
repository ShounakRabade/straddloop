"""Time conventions.

All market timestamps are stored as timezone-aware Asia/Kolkata datetimes. A candle is labelled by
its START time: the 09:15 one-minute candle covers 09:15:00-09:15:59 and is only known at 09:16:00.
"""

from __future__ import annotations

from datetime import UTC, date, datetime, time, timedelta, timezone

IST = timezone(timedelta(hours=5, minutes=30), name="IST")

SESSION_OPEN = time(9, 15)
SESSION_CLOSE = time(15, 30)
MINUTES_PER_SESSION = 375  # 09:15 to 15:29 inclusive, one-minute candles


def epoch_to_ist(seconds: float) -> datetime:
    return datetime.fromtimestamp(seconds, tz=UTC).astimezone(IST)


def ist(d: date, t: time) -> datetime:
    return datetime.combine(d, t, tzinfo=IST)


def date_windows(start: date, end: date, max_days: int) -> list[tuple[date, date]]:
    """Split [start, end) into consecutive windows of at most `max_days` days."""
    if end <= start:
        return []
    windows, cursor = [], start
    while cursor < end:
        stop = min(cursor + timedelta(days=max_days), end)
        windows.append((cursor, stop))
        cursor = stop
    return windows
