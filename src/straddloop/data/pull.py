"""Resumable, ledger-backed Dhan pull: one trading day at a time, every series for a day written together.

How a day moves through the system (see data/ledger.py for the states):

  1. the planner (availability.py) lists days with no usable local data: missing, failed, interrupted;
  2. a day is fetched in full (index candles, then every option series), held in memory;
  3. it is judged (`judge_day`): validated / partial / failed / holiday, with reasons. Nothing is repaired;
  4. only a day with real rows is written, to a temp file renamed into place, and only then does the
     ledger row change. A crash at any point leaves the day missing, never half-written;
  5. an authentication error stops the whole run at once (no day is marked failed for it); other API errors
     mark that day failed, and three failed days in a row stop the run.

A weekday with no data is recorded as a holiday only when the index feed and the option feed agree it is
empty. If the index shows a session but options are empty, the day is `failed`, not a holiday.
`pull_options` and `pull_underlying` keep their old signatures; `ensure_range` is the one-call entry point.
"""

from __future__ import annotations

import json
import logging
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from pathlib import Path

from straddloop.data import store
from straddloop.data.availability import (
    availability,
    index_key,
    needs_fetch,
    option_key,
    runs,
)
from straddloop.data.ledger import Ledger
from straddloop.data.providers.base import AuthError, ExpiredOptionRequest, ProviderError
from straddloop.data.providers.dhan import DhanProvider, moneyness_labels
from straddloop.data.schema import OptionCandle, UnderlyingCandle
from straddloop.data.validate import validate_candles
from straddloop.timeutil import IST, MINUTES_PER_SESSION

log = logging.getLogger("straddloop")

SOURCE = "dhan"
INDEX_MIN_SHARE = 0.99    # index bars needed for a "complete" session
ATM_MIN_SHARE = 0.95      # bars needed on each ATM series
MAX_CONSECUTIVE_FAILURES = 3


class RunAborted(RuntimeError):
    """Too many consecutive failures; the run stopped itself. Stored data and ledger are intact."""


@dataclass
class PullSummary:
    days_fetched: list[date] = field(default_factory=list)
    days_skipped: list[date] = field(default_factory=list)
    holidays: list[date] = field(default_factory=list)
    days_partial: list[date] = field(default_factory=list)
    days_failed: list[date] = field(default_factory=list)
    option_rows: int = 0
    dropped: Counter = field(default_factory=Counter)


def weekdays(start: date, end: date) -> list[date]:
    out, d = [], start
    while d < end:
        if d.weekday() < 5:
            out.append(d)
        d += timedelta(days=1)
    return out


# ---- legacy markers (kept so older stores and quality.py keep working) -----------------------------

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


# ---- judging a fetched day ------------------------------------------------------------------------

@dataclass
class Verdict:
    status: str
    reasons: list[str]
    confirmed: bool = True


def judge_day(index_status: str | None, index_bars: int, series_bars: dict[tuple[str, str], int],
              window: int) -> Verdict:
    """Classify one day from counts only. `index_status` is the ledger state of the index for that day
    (None = index not fetched)."""
    if not series_bars:
        if index_status == "holiday":
            return Verdict("holiday", ["index and options both empty"])
        if index_status in ("validated", "partial"):
            return Verdict("failed", [f"options empty but the index shows a session ({index_bars} bars)"])
        return Verdict("holiday", ["options empty; index feed not consulted"], confirmed=False)
    reasons = []
    expected = 2 * (2 * window + 1)
    if len(series_bars) < expected:
        reasons.append(f"{expected - len(series_bars)} of {expected} option series empty")
    for cp in ("CE", "PE"):
        n = series_bars.get((cp, "ATM"), 0)
        if n < ATM_MIN_SHARE * MINUTES_PER_SESSION:
            reasons.append(f"ATM {cp} has {n} of {MINUTES_PER_SESSION} bars")
    if index_status is None:
        reasons.append("index candles not fetched for this day")
    elif index_bars < INDEX_MIN_SHARE * MINUTES_PER_SESSION:
        reasons.append(f"index has {index_bars} of {MINUTES_PER_SESSION} bars")
    return Verdict("partial" if reasons else "validated", reasons)


# ---- index ----------------------------------------------------------------------------------------

def pull_underlying(provider: DhanProvider, store_dir: Path, underlying: str, start: date, end: date,
                    interval: int, ledger: Ledger | None = None, refetch: bool = False,
                    retry_partial: bool = False):
    """Fetch index candles for the days in [start, end) that are not already usable. Returns the validation
    result of what was fetched (None if nothing needed fetching)."""
    own = ledger is None
    ledger = ledger or Ledger(store_dir)
    try:
        key = index_key(underlying, interval)
        states = availability(ledger, "underlying_candles", key, start, end)
        todo = needs_fetch(states, retry_partial=retry_partial, refetch=refetch)
        if not todo:
            return None
        merged = None
        for lo, hi in runs(todo):
            # The intraday endpoint takes up to 90 days per call: date_windows (inside) splits long runs.
            res = validate_candles(provider.underlying_candles(underlying, lo, hi + timedelta(days=1), interval))
            by_day: dict[date, list] = defaultdict(list)
            for c in res.kept:
                by_day[c.ts.date()].append(c)
            want = set(todo)
            for d in sorted(x for x in want if lo <= x <= hi):
                rows = by_day.get(d, [])
                if not rows:
                    ledger.set_day("underlying_candles", key, d, "holiday", source=SOURCE,
                                   detail={"reasons": ["no index candles"]})
                    continue
                store.write_records(store_dir, "underlying_candles", rows, UnderlyingCandle)
                full = len(rows) >= INDEX_MIN_SHARE * (MINUTES_PER_SESSION // interval)
                ledger.set_day("underlying_candles", key, d, "validated" if full else "partial", rows=len(rows),
                               source=SOURCE, dropped=dict(res.dropped), rows_in=len(rows),
                               detail={"reasons": [] if full else [f"{len(rows)} bars"]})
            merged = res
        log.info("%s index: ledger updated for %d day(s)", underlying, len(todo))
        return merged
    finally:
        if own:
            ledger.close()


# ---- options --------------------------------------------------------------------------------------

def _fetch_day(provider: DhanProvider, underlying: str, day: date, labels: list[str], expiry_flag: str,
               expiry_code: int, interval: int) -> list[OptionCandle]:
    candles: list[OptionCandle] = []
    for option_type in ("CE", "PE"):
        for label in labels:
            req = ExpiredOptionRequest(underlying, option_type, label, expiry_flag, expiry_code,
                                       day, day + timedelta(days=1), interval)
            candles.extend(provider.expired_option_candles(req))
    return candles


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
    ledger: Ledger | None = None,
    retry_partial: bool = False,
) -> PullSummary:
    own = ledger is None
    ledger = ledger or Ledger(store_dir)
    summary = PullSummary()
    labels = moneyness_labels(window)
    key = option_key(underlying, expiry_flag, expiry_code, interval)
    ikey = index_key(underlying, interval)
    try:
        ledger.recover_interrupted()
        states = availability(ledger, "option_candles", key, start, end, window)
        todo = set(needs_fetch(states, retry_partial=retry_partial, refetch=refetch))
        failures = 0
        for n, st in enumerate(states, 1):
            day = st.day
            if day not in todo:
                (summary.holidays if st.state == "holiday" else summary.days_skipped).append(day)
                continue
            ledger.set_day("option_candles", key, day, "downloading", source=SOURCE, window=window, log=False)
            try:
                candles = _fetch_day(provider, underlying, day, labels, expiry_flag, expiry_code, interval)
            except AuthError:
                ledger.con.execute("DELETE FROM day_status WHERE dataset='option_candles' AND key=? AND "
                                   "trade_date=? AND status='downloading'", (key, day.isoformat()))
                ledger.con.commit()
                raise
            except ProviderError as exc:
                failures += 1
                ledger.set_day("option_candles", key, day, "failed", source=SOURCE, window=window,
                               detail={"reasons": [str(exc)[:300]]})
                summary.days_failed.append(day)
                log.error("%s: failed: %s", day, exc)
                if failures >= MAX_CONSECUTIVE_FAILURES:
                    raise RunAborted(f"{failures} days failed in a row (last: {exc}); stopping. "
                                     "Nothing stored was changed; fix the cause and re-run.") from exc
                continue
            failures = 0
            res = validate_candles(candles)
            series_bars: Counter = Counter((c.option_type, c.moneyness) for c in res.kept)
            irow = ledger.get_day("underlying_candles", ikey, day)
            verdict = judge_day(irow["status"] if irow else None, irow["rows"] if irow else 0,
                                dict(series_bars), window)
            if res.kept and verdict.status in ("validated", "partial"):
                store.write_records(store_dir, "option_candles", res.kept, OptionCandle)  # atomic per file
            ledger.set_day("option_candles", key, day, verdict.status, rows=len(res.kept), window=window,
                           source=SOURCE, dropped=dict(res.dropped), rows_in=len(candles),
                           detail={"reasons": verdict.reasons, "confirmed": verdict.confirmed,
                                   "series": len(series_bars)})
            summary.option_rows += len(res.kept)
            summary.dropped.update(res.dropped)
            {"holiday": summary.holidays, "failed": summary.days_failed, "partial": summary.days_partial,
             "validated": summary.days_fetched}[verdict.status].append(day)
            if verdict.status == "partial":
                summary.days_fetched.append(day)
            _write_legacy_marker(store_dir, underlying, expiry_flag, expiry_code, interval, day, window, verdict,
                                 len(res.kept), res.dropped, series_bars, labels)
            log.info("[%d/%d] %s: %s %s", n, len(states), day, verdict.status,
                     f"({'; '.join(verdict.reasons)})" if verdict.reasons else f"{len(res.kept)} rows")
    finally:
        if own:
            ledger.close()
    return summary


def _write_legacy_marker(store_dir, underlying, flag, code, interval, day, window, verdict, rows, dropped,
                         series_bars, labels) -> None:
    if verdict.status == "failed":
        return
    path = marker_path(store_dir, underlying, flag, code, interval, day)
    path.parent.mkdir(parents=True, exist_ok=True)
    empty = [f"{cp} {lb}" for cp in ("CE", "PE") for lb in labels if (cp, lb) not in series_bars]
    path.write_text(json.dumps({
        "day": day.isoformat(), "window": window, "holiday": verdict.status == "holiday", "rows": rows,
        "dropped": dict(dropped), "empty_series": empty,
        "fetched_at": datetime.now(IST).isoformat(timespec="seconds"),
    }), encoding="utf-8")


def ensure_range(provider: DhanProvider, store_dir: Path, underlying: str, start: date, end_inclusive: date,
                 window: int = 10, expiry_flag: str = "WEEK", expiry_code: int = 1, interval: int = 1,
                 refetch: bool = False, retry_partial: bool = False) -> PullSummary:
    """Make sure [start, end_inclusive] is in the store, fetching only what is missing. Index first (one cheap
    call per run of days), then options for the days that need them."""
    end = end_inclusive + timedelta(days=1)
    ledger = Ledger(store_dir)
    try:
        from straddloop.data.migrate import adopt_legacy  # local import: migrate imports this module

        adopt_legacy(store_dir, ledger)
        pull_underlying(provider, store_dir, underlying, start, end, interval, ledger, refetch, retry_partial)
        return pull_options(provider, store_dir, underlying, start, end, window, expiry_flag, expiry_code,
                            interval, refetch, ledger, retry_partial)
    finally:
        ledger.close()
