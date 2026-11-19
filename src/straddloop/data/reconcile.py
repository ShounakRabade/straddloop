"""Reconcile Dhan option candles against the exchange bhavcopy for the same day.

The two sources are independent, so where they overlap they must agree. For each fixed contract
(strike, CE/PE) that Dhan reported on a day, built from its 1-minute bars, this checks against the
bhavcopy row of the resolved expiry:

  high / low   Dhan's highest high must not exceed the exchange's high (and lowest low must not undercut
               the exchange's low) by more than `price_tol`. Strict in one direction only: Dhan may cover
               only part of the session (the strike left the ATM window), so it can be inside the range.
  open         compared only for contracts with bars from 09:15 on (full-session): first-bar open vs the
               exchange's open.
  open interest  last bar's OI vs the exchange's end-of-day OI, relative tolerance `oi_tol`.
  volume       NOT asserted. Dhan's unit (contracts or quantity) is unverified and strikes may be partial;
               the ratio dhan/exchange is reported so the unit can be read off a real day.

Outcome per day: PASS, WARN or FAIL, or NO_REFERENCE when there is no bhavcopy (not a pass: nothing was
checked). A day is never reconciled against a guessed expiry; if the bhavcopy lists none, the result is
NO_REFERENCE with the reason.
"""

from __future__ import annotations

import statistics
from dataclasses import dataclass, field
from datetime import date, time
from pathlib import Path

from straddloop.data import store
from straddloop.reference.contract_master import ContractMaster, day_bounds

FAIL_SHARE = 0.02  # more than 2% of checked contracts disagreeing on high/low/OI is a FAIL


@dataclass
class Reconciliation:
    day: date
    status: str
    expiry: date | None = None
    contracts_compared: int = 0
    dhan_only: int = 0  # Dhan contracts the bhavcopy has no row for
    mismatches: list[dict] = field(default_factory=list)
    checks: dict[str, int] = field(default_factory=dict)
    volume_ratio_median: float | None = None
    note: str = ""


def reconcile_day(store_dir: Path, underlying: str, day: date, expiry_flag: str = "WEEK", expiry_code: int = 1,
                  interval: int = 1, price_tol: float = 0.1, oi_tol: float = 0.01,
                  master: ContractMaster | None = None) -> Reconciliation:
    master = master or ContractMaster(store_dir)
    exp = master.resolve_expiry(underlying, day, expiry_flag, expiry_code)
    if exp is None:
        return Reconciliation(day, "NO_REFERENCE", note="no bhavcopy for this date (import or download it)")
    lo, hi = day_bounds(day)
    dh = store.query(store_dir, "option_candles",
                     "underlying=? AND expiry_flag=? AND expiry_code=? AND interval_min=? AND ts>=? AND ts<=?",
                     [underlying, expiry_flag, expiry_code, interval, lo, hi])
    if dh is None or dh.num_rows == 0:
        return Reconciliation(day, "NO_REFERENCE", exp, note="no Dhan option candles stored for this date")
    bh = store.query(store_dir, "contracts", "symbol=? AND trade_date=? AND expiry=?", [underlying, day, exp])
    ref = {(r["strike"], r["option_type"]): r for r in bh.to_pylist()} if bh is not None else {}

    per: dict[tuple[float, str], list[dict]] = {}
    for r in sorted(dh.to_pylist(), key=lambda r: r["ts"]):
        if r["strike"] is None:
            continue
        per.setdefault((r["strike"], r["option_type"]), []).append(r)

    out = Reconciliation(day, "PASS", exp)
    checks = {"high": 0, "low": 0, "open": 0, "oi": 0}
    bad = {"high": 0, "low": 0, "open": 0, "oi": 0}
    ratios = []
    for (strike, cp), bars in sorted(per.items()):
        b = ref.get((strike, cp))
        if b is None:
            out.dhan_only += 1
            continue
        out.contracts_compared += 1
        d_hi, d_lo = max(x["high"] for x in bars), min(x["low"] for x in bars)
        if b["high"] is not None:
            checks["high"] += 1
            if d_hi > b["high"] + price_tol:
                bad["high"] += 1
                out.mismatches.append({"strike": strike, "type": cp, "check": "high", "dhan": d_hi, "nse": b["high"]})
        if b["low"] is not None and b["low"] > 0:
            checks["low"] += 1
            if d_lo < b["low"] - price_tol:
                bad["low"] += 1
                out.mismatches.append({"strike": strike, "type": cp, "check": "low", "dhan": d_lo, "nse": b["low"]})
        if bars[0]["ts"].timetz().replace(tzinfo=None) == time(9, 15) and b["open"]:
            checks["open"] += 1
            if abs(bars[0]["open"] - b["open"]) > price_tol:
                bad["open"] += 1
                out.mismatches.append({"strike": strike, "type": cp, "check": "open", "dhan": bars[0]["open"],
                                       "nse": b["open"]})
        oi = next((x["oi"] for x in reversed(bars) if x["oi"] is not None), None)
        if oi is not None and b["oi"]:
            checks["oi"] += 1
            if abs(oi - b["oi"]) > oi_tol * b["oi"]:
                bad["oi"] += 1
                out.mismatches.append({"strike": strike, "type": cp, "check": "oi", "dhan": oi, "nse": b["oi"]})
        vol = sum(x["volume"] or 0 for x in bars)
        if b["volume"]:
            ratios.append(vol / b["volume"])
    out.checks = {f"{k}_checked": v for k, v in checks.items()} | {f"{k}_mismatch": v for k, v in bad.items()}
    out.volume_ratio_median = round(statistics.median(ratios), 4) if ratios else None
    if out.contracts_compared == 0:
        out.status, out.note = "FAIL", f"no Dhan contract matched a bhavcopy row for expiry {exp}: wrong expiry?"
        return out
    worst = max((bad[k] / checks[k] for k in checks if checks[k]), default=0.0)
    out.status = "FAIL" if worst > FAIL_SHARE else ("WARN" if any(bad.values()) or out.dhan_only else "PASS")
    return out
