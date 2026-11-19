"""Resumable Dhan pull: one trading day at a time, every series for that day written together.

Dhan's rolling-options endpoint accepts one day per call, so a pull is (days x strikes x CE/PE) calls.
Each finished day leaves a small JSON marker under <store>/_progress/. A re-run skips days whose
marker covers the requested strike window, so a pull can be stopped (Ctrl+C) and restarted at any
point: the day in progress is simply fetched again. Weekdays that return no data at all (exchange
holidays) are marked too and are not asked for again unless `refetch` is set.
"""

from __future__ import annotations

import json
import logging
from collections import Counter
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from pathlib import Path

from straddloop.data import store
from straddloop.data.providers.base import ExpiredOptionRequest
from straddloop.data.providers.dhan import DhanProvider, moneyness_labels
from straddloop.data.schema import OptionCandle, UnderlyingCandle
from straddloop.data.validate import validate_candles
from straddloop.timeutil import IST

log = logging.getLogger("straddloop")


@dataclass
class PullSummary:
    days_fetched: list[date] = field(default_factory=list)
    days_skipped: list[date] = field(default_factory=list)
    holidays: list[date] = field(default_factory=list)
    option_rows: int = 0
    dropped: Counter = field(default_factory=Counter)


def weekdays(start: date, end: date) -> list[date]:
    out, d = [], start
    while d < end:
        if d.weekday() < 5:
            out.append(d)
        d += timedelta(days=1)
    return out


def marker_path(store_dir: Path, underlying: str, expiry_flag: str, expiry_code: int, interval: int, day: date) -> Path:
    return (
        store_dir / "_progress" / "dhan_options" / f"{underlying}_{expiry_flag}{expiry_code}_{interval}m"
        / f"{day.isoformat()}.json"
    )


def read_marker(path: Path) -> dict | None:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return None


def pull_underlying(provider: DhanProvider, store_dir: Path, underlying: str, start: date, end: date, interval: int):
    res = validate_candles(provider.underlying_candles(underlying, start, end, interval))
    store.write_records(store_dir, "underlying_candles", res.kept, UnderlyingCandle)
    log.info("%s index: kept %d rows over %d sessions, dropped %s", underlying, len(res.kept), len(res.sessions),
             dict(res.dropped))
    return res


def pull_options(
    provider: DhanProvider,
    store_dir: Path,
    underlying: str,
    start: date,
    end: date,
    window: int,
    expiry_flag: str,
    expiry_code: int,
    interval: int,
    refetch: bool = False,
) -> PullSummary:
    summary = PullSummary()
    labels = moneyness_labels(window)
    days = weekdays(start, end)
    for n, day in enumerate(days, 1):
        mpath = marker_path(store_dir, underlying, expiry_flag, expiry_code, interval, day)
        marker = read_marker(mpath)
        if marker and not refetch and marker.get("window", -1) >= window:
            (summary.holidays if marker.get("holiday") else summary.days_skipped).append(day)
            continue
        candles: list[OptionCandle] = []
        empty_series = []
        for option_type in ("CE", "PE"):
            for label in labels:
                req = ExpiredOptionRequest(underlying, option_type, label, expiry_flag, expiry_code,
                                           day, day + timedelta(days=1), interval)
                got = provider.expired_option_candles(req)
                if not got:
                    empty_series.append(f"{option_type} {label}")
                candles.extend(got)
        res = validate_candles(candles)
        holiday = not res.kept
        if not holiday:
            store.write_records(store_dir, "option_candles", res.kept, OptionCandle)
        summary.option_rows += len(res.kept)
        summary.dropped.update(res.dropped)
        (summary.holidays if holiday else summary.days_fetched).append(day)
        mpath.parent.mkdir(parents=True, exist_ok=True)
        mpath.write_text(json.dumps({
            "day": day.isoformat(),
            "window": window,
            "holiday": holiday,
            "rows": len(res.kept),
            "dropped": dict(res.dropped),
            "empty_series": empty_series,
            "fetched_at": datetime.now(IST).isoformat(timespec="seconds"),
        }), encoding="utf-8")
        log.info("[%d/%d] %s: %s", n, len(days), day,
                 "no data (holiday?)" if holiday else f"{len(res.kept)} rows, {len(empty_series)} empty series")
    return summary
