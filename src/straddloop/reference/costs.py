"""Dated transaction-cost schedules for option trades.

A backtest of 2023 must use 2023 rates. Each schedule has an effective-from date and records, per
rate, whether it was verified against a cited source. A backtest result stores the schedule ids it
used, so a later correction to a rate is visible as a different result, not a silent change.

BSE (SENSEX) exchange charges are deliberately absent: they have not been verified yet, so a SENSEX
cost calculation raises instead of borrowing NSE's numbers.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date


class CostScheduleMissing(LookupError):
    pass


@dataclass(frozen=True)
class Rate:
    value: float
    verified: bool
    source: str


@dataclass(frozen=True)
class CostSchedule:
    id: str
    exchange: str
    effective_from: date
    stt_sell_premium: Rate  # fraction of sell-side premium
    exchange_txn: Rate  # fraction of premium turnover, both sides
    sebi_per_crore: Rate  # rupees per crore of turnover
    stamp_buy: Rate  # fraction of buy-side premium
    gst: Rate  # on brokerage + exchange + SEBI charges


ZERODHA_CHARGES = "https://zerodha.com/charges (checked 2026-10-22)"
ICICI_STT_2026 = (
    "https://www.icicidirect.com/ilearn/futures-and-options/articles/"
    "stt-changes-in-budget-2026-what-f-o-traders-should-know"
)
UNVERIFIED = "not yet verified against an official source"

NSE_SCHEDULES: list[CostSchedule] = [
    CostSchedule(
        id="nse-2024-10-01",
        exchange="NSE",
        effective_from=date(2024, 10, 1),
        stt_sell_premium=Rate(0.0010, True, ICICI_STT_2026 + " (old rate)"),
        exchange_txn=Rate(0.0003503, False, UNVERIFIED),
        sebi_per_crore=Rate(10.0, False, UNVERIFIED),
        stamp_buy=Rate(0.00003, False, UNVERIFIED),
        gst=Rate(0.18, True, ZERODHA_CHARGES),
    ),
    CostSchedule(
        id="nse-2026-04-01",
        exchange="NSE",
        effective_from=date(2026, 4, 1),
        stt_sell_premium=Rate(0.0015, True, ICICI_STT_2026),
        # 0.03553% is the rate published today; the date it took effect is not yet confirmed.
        exchange_txn=Rate(0.0003553, True, ZERODHA_CHARGES + "; effective date unconfirmed"),
        sebi_per_crore=Rate(10.0, True, ZERODHA_CHARGES),
        stamp_buy=Rate(0.00003, True, ZERODHA_CHARGES),
        gst=Rate(0.18, True, ZERODHA_CHARGES),
    ),
]
# Rates before 1 Oct 2024 differ (lower STT, a different exchange charge) and are not entered yet;
# a trade before that date raises CostScheduleMissing until they are.

SCHEDULES = {"NSE": NSE_SCHEDULES, "BSE": []}


def schedule_for(exchange: str, on: date) -> CostSchedule:
    candidates = [s for s in SCHEDULES.get(exchange, []) if s.effective_from <= on]
    if not candidates:
        raise CostScheduleMissing(f"No verified {exchange} cost schedule covers {on}")
    return max(candidates, key=lambda s: s.effective_from)


@dataclass(frozen=True)
class Fill:
    trade_date: date
    exchange: str
    side: str  # BUY or SELL
    price: float  # per unit premium
    quantity: int  # units (lots x lot size)


@dataclass(frozen=True)
class CostBreakdown:
    brokerage: float
    stt: float
    exchange_txn: float
    sebi: float
    stamp: float
    gst: float
    schedule_ids: tuple[str, ...]
    all_rates_verified: bool

    @property
    def total(self) -> float:
        return round(self.brokerage + self.stt + self.exchange_txn + self.sebi + self.stamp + self.gst, 2)


def costs_for(fills: list[Fill], brokerage_per_order: float = 20.0) -> CostBreakdown:
    """Charges for a list of option fills, one order per fill, each at its date's schedule."""
    brokerage = stt = txn = sebi = stamp = gst = 0.0
    ids, verified = [], True
    for f in fills:
        s = schedule_for(f.exchange, f.trade_date)
        ids.append(s.id)
        verified &= all(r.verified for r in (s.stt_sell_premium, s.exchange_txn, s.sebi_per_crore,
                                             s.stamp_buy, s.gst))
        turnover = f.price * f.quantity
        b = brokerage_per_order
        t = turnover * s.exchange_txn.value
        se = turnover * s.sebi_per_crore.value / 1e7
        brokerage += b
        txn += t
        sebi += se
        if f.side == "SELL":
            stt += turnover * s.stt_sell_premium.value
        else:
            stamp += turnover * s.stamp_buy.value
        gst += (b + t + se) * s.gst.value
    return CostBreakdown(
        brokerage=round(brokerage, 2),
        stt=round(stt, 2),
        exchange_txn=round(txn, 2),
        sebi=round(sebi, 2),
        stamp=round(stamp, 2),
        gst=round(gst, 2),
        schedule_ids=tuple(sorted(set(ids))),
        all_rates_verified=verified,
    )
