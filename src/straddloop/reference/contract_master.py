"""Contract master built from the stored bhavcopy: real expiry dates and lot sizes per trading day.

Dhan's rolling-option candles say only "expiry code 1 of the WEEK series". This resolves that to a date:
the n-th listed expiry on or after the trade date, taken from that day's own bhavcopy (so holiday-shifted
expiries and the Thursday-to-Tuesday switch are handled by what NSE actually listed, not by a rule).
MONTH series use only the last listed expiry of each calendar month.

Assumption, stated because it is not proven from Dhan's documentation: code 1 on an expiry day means
that day's own expiring contract. `data/reconcile.py` tests the resolved expiry against the bhavcopy
prices; a wrong reading shows up as mismatches there.

If the date has no bhavcopy, nothing is returned. Callers must label the fallback as assumed.
"""

from __future__ import annotations

from datetime import date, datetime, time
from pathlib import Path

from straddloop.data import store
from straddloop.timeutil import IST


class ContractMaster:
    def __init__(self, store_dir: Path):
        self.store_dir = store_dir
        self._cache: dict[tuple[str, date], list[tuple[date, int | None]]] = {}

    def _day(self, symbol: str, day: date) -> list[tuple[date, int | None]]:
        """(expiry, lot_size) for each expiry listed in that day's bhavcopy, sorted by expiry."""
        k = (symbol, day)
        if k not in self._cache:
            t = store.query(self.store_dir, "contracts", "symbol = ? AND trade_date = ?", [symbol, day])
            seen: dict[date, int | None] = {}
            if t is not None:
                for e, lot in zip(t["expiry"].to_pylist(), t["lot_size"].to_pylist(), strict=True):
                    if seen.get(e) is None:
                        seen[e] = lot
            self._cache[k] = sorted(seen.items())
        return self._cache[k]

    def has_day(self, symbol: str, day: date) -> bool:
        return bool(self._day(symbol, day))

    def expiries(self, symbol: str, day: date) -> list[date]:
        return [e for e, _ in self._day(symbol, day) if e >= day]

    def resolve_expiry(self, symbol: str, day: date, expiry_flag: str, expiry_code: int = 1) -> date | None:
        exps = self.expiries(symbol, day)
        if expiry_flag == "MONTH":
            last: dict[tuple[int, int], date] = {}
            for e in exps:
                last[(e.year, e.month)] = max(e, last.get((e.year, e.month), e))
            exps = sorted(last.values())
        return exps[expiry_code - 1] if 0 < expiry_code <= len(exps) else None

    def lot_size(self, symbol: str, day: date, expiry: date) -> int | None:
        for e, lot in self._day(symbol, day):
            if e == expiry:
                return lot
        return None


def day_bounds(day: date):
    return datetime.combine(day, time(0), IST), datetime.combine(day, time(23, 59, 59), IST)
