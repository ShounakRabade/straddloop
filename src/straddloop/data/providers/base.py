"""Provider interface. Research code depends on this, never on a concrete provider."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from typing import Protocol

from straddloop.data.schema import OptionCandle, UnderlyingCandle


class ProviderError(RuntimeError):
    """A provider call failed or returned something we cannot interpret. Never swallowed silently."""


@dataclass(frozen=True)
class ExpiredOptionRequest:
    underlying: str
    option_type: str  # CE or PE
    moneyness: str  # "ATM", "ATM+1" ... provider-relative strike label
    expiry_flag: str  # WEEK or MONTH
    expiry_code: int  # 1 = nearest, per provider definition
    start: date
    end: date  # exclusive
    interval_min: int = 1


@dataclass(frozen=True)
class ProviderCapabilities:
    name: str
    expired_options: bool
    fixed_contract_history: bool  # False for moneyness-relative sources
    bid_ask_history: bool
    max_moneyness_offset: int | None
    intervals_min: tuple[int, ...]
    history_years: int | None
    notes: str


class MarketDataProvider(Protocol):
    capabilities: ProviderCapabilities

    def underlying_candles(
        self, underlying: str, start: date, end: date, interval_min: int = 1
    ) -> list[UnderlyingCandle]: ...

    def expired_option_candles(self, request: ExpiredOptionRequest) -> list[OptionCandle]: ...
