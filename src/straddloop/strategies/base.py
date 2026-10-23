"""The common strategy interface (Phase 1: contract only; the engine that drives it is Phase 3).

A strategy declares what it needs and reacts to completed bars. It never fetches data, prices its
own fills or computes its own costs: the shared engine does those, identically for every strategy.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any


@dataclass(frozen=True)
class DataRequirement:
    underlying_interval_min: int
    option_interval_min: int | None
    option_window: int | None  # strikes either side of ATM the strategy may touch
    needs_bid_ask: bool = False
    notes: str = ""


@dataclass(frozen=True)
class StrategySpec:
    """Identity and parameters. A changed parameter set is a new version, never an overwrite."""

    strategy_id: str
    version: str
    title: str
    rules_plain_english: str
    parameters: dict[str, Any] = field(default_factory=dict)
    baseline: bool = True


class Strategy(ABC):
    spec: StrategySpec

    @abstractmethod
    def data_requirement(self) -> DataRequirement: ...

    @abstractmethod
    def on_session_start(self, ctx) -> None: ...

    @abstractmethod
    def on_bar(self, ctx) -> None:
        """Called once per completed execution bar with only data known at that moment."""

    @abstractmethod
    def on_session_end(self, ctx) -> None: ...
