"""Candle validation and data-quality measurement.

Validation never repairs prices. It drops rows that are structurally impossible (and counts them),
and measures everything else (gaps, stale bars, strike drift) so the coverage report can say how much
of the data a backtest can actually rely on.
"""

from __future__ import annotations

from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import date, datetime

from straddloop.data.schema import OptionCandle, UnderlyingCandle
from straddloop.timeutil import MINUTES_PER_SESSION, SESSION_CLOSE, SESSION_OPEN


@dataclass
class ValidationResult:
    kept: list
    dropped: Counter = field(default_factory=Counter)
    label_convention: str = "unknown"  # "start" if the first bar of a session is 09:15
    sessions: dict[date, int] = field(default_factory=dict)  # bars kept per session

    def missing_pct(self, interval_min: int = 1) -> float:
        if not self.sessions:
            return 100.0
        expected = (MINUTES_PER_SESSION // interval_min) * len(self.sessions)
        return round(100.0 * (1 - sum(self.sessions.values()) / expected), 3)


def _ohlc_ok(c) -> bool:
    return (
        min(c.open, c.high, c.low, c.close) >= 0
        and c.high >= max(c.open, c.close, c.low)
        and c.low <= min(c.open, c.close, c.high)
    )


def validate_candles(candles: list[UnderlyingCandle] | list[OptionCandle]) -> ValidationResult:
    """Drop impossible rows; measure session coverage. Works for underlying and option candles."""
    result = ValidationResult(kept=[])
    seen: set = set()
    first_bar: dict[date, datetime] = {}
    for c in sorted(candles, key=lambda c: c.ts):
        key = (c.ts, getattr(c, "option_type", None), getattr(c, "moneyness", None))
        t = c.ts.time()
        if key in seen:
            result.dropped["duplicate"] += 1
            continue
        if t < SESSION_OPEN or t >= SESSION_CLOSE:
            result.dropped["outside_session"] += 1
            continue
        if ((t.hour * 60 + t.minute) - (SESSION_OPEN.hour * 60 + SESSION_OPEN.minute)) % c.interval_min:
            result.dropped["off_grid"] += 1
            continue
        if not _ohlc_ok(c):
            result.dropped["bad_ohlc"] += 1
            continue
        seen.add(key)
        result.kept.append(c)
        d = c.ts.date()
        first_bar.setdefault(d, c.ts)
    counts: dict[date, int] = defaultdict(int)
    for c in result.kept:
        counts[c.ts.date()] += 1
    result.sessions = dict(counts)
    if first_bar:
        starts = Counter(ts.time() for ts in first_bar.values())
        common = starts.most_common(1)[0][0]
        result.label_convention = "start" if common == SESSION_OPEN else f"first bar at {common}"
    return result


@dataclass
class OptionSeriesQuality:
    """Quality measures for one moneyness-relative option series (e.g. NIFTY CE ATM+2)."""

    bars: int
    zero_volume_bars: int
    stale_bars: int  # zero volume and close unchanged from the previous bar
    strike_changes: int  # how often the strike behind the label changed within a session
    missing_iv: int
    missing_oi: int


def option_series_quality(candles: list[OptionCandle]) -> OptionSeriesQuality:
    zero = stale = changes = miss_iv = miss_oi = 0
    prev: OptionCandle | None = None
    for c in sorted(candles, key=lambda c: c.ts):
        if not c.volume:
            zero += 1
            if prev is not None and prev.ts.date() == c.ts.date() and prev.close == c.close:
                stale += 1
        if prev is not None and prev.ts.date() == c.ts.date() and prev.strike != c.strike:
            changes += 1
        miss_iv += c.iv is None
        miss_oi += c.oi is None
        prev = c
    return OptionSeriesQuality(len(candles), zero, stale, changes, miss_iv, miss_oi)


def fixed_contract_coverage(candles: list[OptionCandle]) -> dict[tuple[date, float, str], int]:
    """Rebuild fixed contracts from moneyness-relative series: bars available per (day, strike, type).

    A short straddle needs its two strikes for the whole session. If the index moves far enough, a
    strike leaves the provider's ATM window and its bars stop: those minutes show up here as a
    count below 375.
    """
    seen: dict[tuple[date, float, str], set] = defaultdict(set)
    for c in candles:
        if c.strike is not None:
            seen[(c.ts.date(), c.strike, c.option_type)].add(c.ts)
    return {k: len(v) for k, v in seen.items()}
