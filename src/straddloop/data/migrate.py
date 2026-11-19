"""Adopt data pulled before the ledger existed.

Older pulls left a JSON marker per day under <store>/_progress/dhan_options/ and Parquet files. For each
marker with no ledger row, the day is re-judged *from the stored Parquet rows* (not trusted from the
marker), so a day only becomes `validated` if the stored data actually passes today's checks. Index
candles already in the store are adopted the same way. Idempotent; never touches the data files.
"""

from __future__ import annotations

import json
import logging
from collections import Counter
from datetime import date, datetime, time
from pathlib import Path

from straddloop.data import store
from straddloop.data.availability import index_key, option_key
from straddloop.data.ledger import Ledger
from straddloop.data.pull import INDEX_MIN_SHARE, judge_day
from straddloop.timeutil import IST, MINUTES_PER_SESSION

log = logging.getLogger("straddloop")


def adopt_legacy(store_dir: Path, ledger: Ledger) -> int:
    base = store_dir / "_progress" / "dhan_options"
    if not base.is_dir():
        return 0
    adopted = 0
    idx_done: set[tuple[str, date]] = set()
    for mdir in sorted(p for p in base.iterdir() if p.is_dir()):
        # directory name: NIFTY_WEEK1_1m
        try:
            und, series, ivl = mdir.name.split("_")
            flag, code = series.rstrip("0123456789"), int(series[len(series.rstrip("0123456789")):])
            interval = int(ivl.rstrip("m"))
        except ValueError:
            continue
        key = option_key(und, flag, code, interval)
        for mf in sorted(mdir.glob("*.json")):
            try:
                marker = json.loads(mf.read_text(encoding="utf-8"))
                day = date.fromisoformat(marker["day"])
            except (ValueError, KeyError, json.JSONDecodeError):
                continue
            if ledger.get_day("option_candles", key, day):
                continue
            window = int(marker.get("window", 0))
            if (und, day) not in idx_done and not ledger.get_day("underlying_candles", index_key(und, interval), day):
                idx_done.add((und, day))
                _adopt_index(store_dir, ledger, und, interval, day)
            irow = ledger.get_day("underlying_candles", index_key(und, interval), day)
            counts = _stored_series(store_dir, und, flag, code, interval, day)
            verdict = judge_day(irow["status"] if irow else None, irow["rows"] if irow else 0, counts, window)
            ledger.set_day("option_candles", key, day, verdict.status, rows=sum(counts.values()), window=window,
                           source="dhan",
                           detail={"reasons": verdict.reasons, "confirmed": verdict.confirmed,
                                   "note": "adopted from a pre-ledger marker; re-judged from stored rows"})
            adopted += 1
    if adopted:
        log.info("Adopted %d pre-ledger day(s) into the ledger", adopted)
    return adopted


def _day_bounds(day: date):
    return datetime.combine(day, time(0), IST), datetime.combine(day, time(23, 59, 59), IST)


def _stored_series(store_dir, und, flag, code, interval, day) -> dict[tuple[str, str], int]:
    lo, hi = _day_bounds(day)
    t = store.query(store_dir, "option_candles",
                    "underlying=? AND expiry_flag=? AND expiry_code=? AND interval_min=? AND ts>=? AND ts<=?",
                    [und, flag, code, interval, lo, hi])
    if t is None:
        return {}
    c: Counter = Counter(zip(t["option_type"].to_pylist(), t["moneyness"].to_pylist(), strict=True))
    return dict(c)


def _adopt_index(store_dir, ledger, und, interval, day) -> None:
    lo, hi = _day_bounds(day)
    t = store.query(store_dir, "underlying_candles", "underlying=? AND interval_min=? AND ts>=? AND ts<=?",
                    [und, interval, lo, hi])
    n = t.num_rows if t is not None else 0
    if n == 0:
        return  # unknown: leave the index day missing rather than guess a holiday
    full = n >= INDEX_MIN_SHARE * (MINUTES_PER_SESSION // interval)
    ledger.set_day("underlying_candles", index_key(und, interval), day, "validated" if full else "partial",
                   rows=n, source="dhan", detail={"reasons": [] if full else [f"{n} bars"],
                                                  "note": "adopted from stored rows"})


__all__ = ["adopt_legacy"]
