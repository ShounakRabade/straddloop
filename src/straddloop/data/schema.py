"""Canonical, provider-neutral record types.

Connectors convert whatever a provider returns into these records. Everything downstream (validation,
storage, strategies) only ever sees these shapes, so a provider can be replaced without touching
research code.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, fields
from datetime import date, datetime

import pyarrow as pa


@dataclass(frozen=True)
class UnderlyingCandle:
    ts: datetime  # candle start, IST
    underlying: str  # NIFTY, BANKNIFTY, SENSEX, or a stock symbol
    interval_min: int
    open: float
    high: float
    low: float
    close: float
    volume: float | None
    source: str


@dataclass(frozen=True)
class OptionCandle:
    """One option candle as delivered by a provider.

    `strike` is the actual strike the provider reports for this candle. For moneyness-relative
    providers (Dhan rolling options) the same `moneyness` label maps to different strikes as the
    index moves, so research code must always key on `strike`, never on `moneyness`.
    `expiry` is None when the provider gives only a relative expiry code; it is filled in later from
    the exchange contract master, never guessed.
    """

    ts: datetime
    underlying: str
    interval_min: int
    option_type: str  # CE or PE
    strike: float | None
    moneyness: str | None  # e.g. "ATM+2" for moneyness-relative providers
    expiry_flag: str | None  # WEEK or MONTH
    expiry_code: int | None  # provider's relative expiry index
    expiry: date | None
    open: float
    high: float
    low: float
    close: float
    volume: float | None
    oi: float | None
    iv: float | None
    spot: float | None
    source: str


@dataclass(frozen=True)
class ContractRow:
    """One contract on one trading day, from an exchange bhavcopy (the contract master's source)."""

    trade_date: date
    exchange: str  # NSE or BSE
    symbol: str
    instrument: str  # exchange instrument code as published (e.g. IDO, STO)
    expiry: date
    strike: float
    option_type: str
    open: float | None
    high: float | None
    low: float | None
    close: float | None
    settle: float | None
    underlying_price: float | None
    oi: float | None
    volume: float | None
    lot_size: int | None
    source: str


def _arrow_type(py_type: str) -> pa.DataType:
    base = py_type.replace(" | None", "").strip()
    return {
        "datetime": pa.timestamp("s", tz="Asia/Kolkata"),
        "date": pa.date32(),
        "str": pa.string(),
        "int": pa.int64(),
        "float": pa.float64(),
    }[base]


def arrow_schema(record_type: type) -> pa.Schema:
    return pa.schema([pa.field(f.name, _arrow_type(str(f.type))) for f in fields(record_type)])


def to_table(records: list, record_type: type) -> pa.Table:
    schema = arrow_schema(record_type)
    rows = [asdict(r) for r in records]
    return pa.Table.from_pylist(rows, schema=schema)
