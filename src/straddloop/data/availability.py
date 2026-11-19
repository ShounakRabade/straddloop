"""Per-day availability of a dataset range: the states the UI shows.

    validated    stored and passed validation
    partial      stored, with a stated problem (see `reason`); usable only if the caller accepts it
    failed       the last attempt failed; reason says why
    downloading  an attempt is in flight (or died: `recover_interrupted` clears those)
    holiday      no session that day (confirmed by both feeds, unless `confirmed` is false)
    missing      expected trading day with no ledger row: nothing local

"Local" = validated + partial. A backtest asks `usable_days`; it never receives a missing day filled in.
The calendar is evidence-based: weekdays are expected unless recorded as a holiday; a weekend counts as a
session only when an exchange file or stored data proves it (special Saturday sessions exist).
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import date, timedelta

from straddloop.data.ledger import Ledger

LOCAL = ("validated", "partial")


@dataclass(frozen=True)
class DayState:
    day: date
    state: str
    reason: str = ""
    rows: int = 0
    confirmed: bool = True


def option_key(underlying: str, flag: str, code: int, interval: int) -> str:
    return f"{underlying}_{flag}{code}_{interval}m"


def index_key(underlying: str, interval: int) -> str:
    return f"{underlying}_{interval}m"


def expected_days(ledger: Ledger, start: date, end: date, *, key_dataset: str | None = None,
                  key: str | None = None) -> list[date]:
    """Dates in [start, end) where a session is expected (weekdays, plus proven weekend sessions)."""
    proven = ledger.bhav_days("FO", "ok")
    if key_dataset and key:
        proven |= {d for d, r in ledger.days(key_dataset, key, start, end).items()
                   if r["status"] in LOCAL}
    out, d = [], start
    while d < end:
        if d.weekday() < 5 or d in proven:
            out.append(d)
        d += timedelta(days=1)
    return out


def availability(ledger: Ledger, dataset: str, key: str, start: date, end: date,
                 window: int | None = None) -> list[DayState]:
    rows = ledger.days(dataset, key, start, end)
    out = []
    for d in expected_days(ledger, start, end, key_dataset=dataset, key=key):
        r = rows.get(d)
        if r is None:
            out.append(DayState(d, "missing"))
            continue
        detail = _detail(r)
        state, reason = r["status"], "; ".join(detail.get("reasons", [])) or detail.get("note", "")
        if window is not None and state in LOCAL and (r["window"] or 0) < window:
            state, reason = "missing", f"stored with window {r['window']}, {window} requested"
        out.append(DayState(d, state, reason, r["rows"], detail.get("confirmed", True)))
    return out


def _detail(row: dict) -> dict:
    try:
        v = json.loads(row["detail"] or "{}")
        return v if isinstance(v, dict) else {"note": str(v)}
    except json.JSONDecodeError:
        return {"note": row["detail"] or ""}


def needs_fetch(states: list[DayState], *, retry_partial: bool = False, refetch: bool = False) -> list[date]:
    """Days worth asking the provider for. Holidays and finished days are left alone."""
    wanted = {"missing", "failed", "downloading"} | ({"partial"} if retry_partial else set())
    if refetch:
        wanted |= {"validated", "partial", "holiday"}
    return [s.day for s in states if s.state in wanted]


def usable_days(states: list[DayState], *, allow_partial: bool = False) -> list[date]:
    ok = {"validated"} | ({"partial"} if allow_partial else set())
    return [s.day for s in states if s.state in ok]


def summarize(states: list[DayState]) -> dict[str, int]:
    out = {k: 0 for k in ("validated", "partial", "failed", "downloading", "holiday", "missing")}
    for s in states:
        out[s.state] += 1
    out["local"] = out["validated"] + out["partial"]
    out["expected_sessions"] = len(states) - out["holiday"]
    return out


def runs(days: list[date]) -> list[tuple[date, date]]:
    """Group sorted dates into (first, last) runs of consecutive calendar days (<= 3-day gaps for weekends)."""
    out: list[list[date]] = []
    for d in sorted(days):
        if out and (d - out[-1][1]).days <= 3:
            out[-1][1] = d
        else:
            out.append([d, d])
    return [(a, b) for a, b in out]
