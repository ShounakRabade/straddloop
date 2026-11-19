"""NSE F&O bhavcopy parsing: the source of the historical contract master and an independent daily check.

Two published layouts are understood; the layout is detected from the header, never from the file name
or date, so a file renamed or re-published under a new name still parses:

  udiff   "UDiFF Common Bhavcopy Final" (published from 8 Jul 2024). One row per contract with
          TradDt, TckrSymb, FinInstrmTp (IDO/STO = index/stock options), XpryDt, StrkPric, OptnTp,
          OpnPric/HghPric/LwPric/ClsPric, SttlmPric, UndrlygPric, OpnIntrst, ChngInOpnIntrst,
          TtlTradgVol, NewBrdLotQty.
  legacy  the pre-UDiFF "fo<DD><MON><YYYY>bhav.csv": INSTRUMENT (OPTIDX/OPTSTK), SYMBOL, EXPIRY_DT,
          STRIKE_PR, OPTION_TYP, OPEN/HIGH/LOW/CLOSE, SETTLE_PR, CONTRACTS, OPEN_INT, CHG_IN_OI, TIMESTAMP.
          No lot size and no underlying price.

Anything else (a changed header, an unknown layout) raises BhavcopyFormatError naming the columns found:
it is never guessed. Rows are validated; bad rows are dropped and counted by reason, never repaired.
The layouts above were written from NSE's published column names; they have been exercised on
hand-written fixtures only, not on real NSE files (NSE was unreachable from the build environment).
"""

from __future__ import annotations

import csv
import io
import zipfile
from collections import Counter
from dataclasses import dataclass, field
from datetime import date, datetime
from pathlib import Path

from straddloop.data.schema import ContractRow

SOURCE = "nse_fo_bhavcopy"

UDIFF_REQUIRED = {"TradDt", "TckrSymb", "XpryDt", "StrkPric", "OptnTp", "ClsPric", "NewBrdLotQty"}
LEGACY_REQUIRED = {"INSTRUMENT", "SYMBOL", "EXPIRY_DT", "STRIKE_PR", "OPTION_TYP", "CLOSE", "OPEN_INT", "TIMESTAMP"}
OPTION_INSTRUMENTS = {"IDO", "STO"}  # UDiFF FinInstrmTp codes
LEGACY_OPTION_INSTRUMENTS = {"OPTIDX", "OPTSTK"}


class BhavcopyFormatError(ValueError):
    pass


@dataclass
class ParseResult:
    fmt: str
    rows: list[ContractRow]
    trade_date: date | None
    dropped: Counter = field(default_factory=Counter)
    rows_seen: int = 0


def _f(value: str) -> float | None:
    value = (value or "").strip()
    return float(value) if value not in ("", "-") else None


def _d(value: str) -> date:
    value = value.strip()
    for fmt in ("%Y-%m-%d", "%d-%b-%Y", "%d-%m-%Y", "%d-%B-%Y"):
        try:
            return datetime.strptime(value.title() if "-" in value and value[:2].isdigit() else value, fmt).date()
        except ValueError:
            continue
    raise BhavcopyFormatError(f"unrecognised date {value!r}")


def read_csv_text(path: Path) -> str:
    """CSV text of a bhavcopy file. A zip must be intact and hold exactly one CSV (a truncated download
    fails here, not later)."""
    if path.suffix.lower() == ".zip" or zipfile.is_zipfile(path):
        try:
            with zipfile.ZipFile(path) as zf:
                bad = zf.testzip()
                if bad:
                    raise BhavcopyFormatError(f"{path.name}: corrupt member {bad} (incomplete download?)")
                names = [n for n in zf.namelist() if n.lower().endswith(".csv")]
                if len(names) != 1:
                    raise BhavcopyFormatError(f"{path.name}: expected one CSV inside, found {names}")
                return zf.read(names[0]).decode("utf-8-sig")
        except zipfile.BadZipFile as exc:
            raise BhavcopyFormatError(f"{path.name}: not a valid zip (incomplete download?)") from exc
    return path.read_text(encoding="utf-8-sig")


def detect_format(header: set[str]) -> str:
    if UDIFF_REQUIRED <= header:
        return "udiff"
    if LEGACY_REQUIRED <= header:
        return "legacy"
    raise BhavcopyFormatError(
        "not a recognised NSE F&O bhavcopy layout. UDiFF needs "
        f"{sorted(UDIFF_REQUIRED - header)} more; legacy needs {sorted(LEGACY_REQUIRED - header)} more. "
        f"Columns found: {sorted(header)}")


def _valid(row: ContractRow) -> str | None:
    """Reason a row is unusable, or None."""
    if row.option_type not in ("CE", "PE"):
        return "bad_option_type"
    if row.strike is None or row.strike <= 0:
        return "bad_strike"
    if row.expiry < row.trade_date:
        return "expired_before_trade_date"
    prices = [p for p in (row.open, row.high, row.low, row.close) if p is not None]
    if any(p < 0 for p in prices) or (row.settle is not None and row.settle < 0):
        return "negative_price"
    if row.high is not None and row.low is not None and row.high < row.low:
        return "high_below_low"
    if row.close is not None and row.high is not None and row.low is not None and not (
            row.low - 1e-9 <= row.close <= row.high + 1e-9):
        # a close outside the day's range is possible only for no-trade rows (all zero): flag the rest
        if any(p for p in (row.high, row.low)):
            return "close_outside_range"
    for v in (row.oi, row.volume):
        if v is not None and v < 0:
            return "negative_quantity"
    return None


def parse_bhavcopy(path: Path, symbols: set[str] | None = None) -> ParseResult:
    reader = csv.DictReader(io.StringIO(read_csv_text(path)))
    header = {h.strip() for h in reader.fieldnames or [] if h}
    fmt = detect_format(header)
    res = ParseResult(fmt=fmt, rows=[], trade_date=None)
    seen: set[tuple] = set()
    days: set[date] = set()
    for raw in reader:
        r = {k.strip(): (v or "").strip() for k, v in raw.items() if k}
        res.rows_seen += 1
        try:
            row = _udiff_row(r) if fmt == "udiff" else _legacy_row(r)
        except (ValueError, KeyError):
            res.dropped["unparseable_row"] += 1
            continue
        if row is None:
            continue  # futures and other non-option rows: not data errors
        if symbols and row.symbol not in symbols:
            continue
        reason = _valid(row)
        if reason:
            res.dropped[reason] += 1
            continue
        key = (row.trade_date, row.symbol, row.instrument, row.expiry, row.strike, row.option_type)
        if key in seen:
            res.dropped["duplicate_in_file"] += 1
            continue
        seen.add(key)
        days.add(row.trade_date)
        res.rows.append(row)
    if len(days) > 1:
        raise BhavcopyFormatError(f"{path.name}: rows for several trade dates {sorted(days)}; expected one")
    res.trade_date = next(iter(days), None)
    return res


def _udiff_row(r: dict) -> ContractRow | None:
    if r.get("FinInstrmTp") not in OPTION_INSTRUMENTS:
        return None
    lot = _f(r["NewBrdLotQty"])
    return ContractRow(
        trade_date=_d(r["TradDt"]), exchange="NSE", symbol=r["TckrSymb"], instrument=r["FinInstrmTp"],
        expiry=_d(r["XpryDt"]), strike=float(r["StrkPric"]), option_type=r["OptnTp"],
        open=_f(r.get("OpnPric", "")), high=_f(r.get("HghPric", "")), low=_f(r.get("LwPric", "")),
        close=_f(r["ClsPric"]), settle=_f(r.get("SttlmPric", "")), underlying_price=_f(r.get("UndrlygPric", "")),
        oi=_f(r.get("OpnIntrst", "")), oi_change=_f(r.get("ChngInOpnIntrst", "")),
        volume=_f(r.get("TtlTradgVol", "")), lot_size=int(lot) if lot else None, source=SOURCE)


def _legacy_row(r: dict) -> ContractRow | None:
    if r.get("INSTRUMENT") not in LEGACY_OPTION_INSTRUMENTS:
        return None
    return ContractRow(
        trade_date=_d(r["TIMESTAMP"]), exchange="NSE", symbol=r["SYMBOL"], instrument=r["INSTRUMENT"],
        expiry=_d(r["EXPIRY_DT"]), strike=float(r["STRIKE_PR"]), option_type=r["OPTION_TYP"],
        open=_f(r.get("OPEN", "")), high=_f(r.get("HIGH", "")), low=_f(r.get("LOW", "")),
        close=_f(r["CLOSE"]), settle=_f(r.get("SETTLE_PR", "")), underlying_price=None,
        oi=_f(r.get("OPEN_INT", "")), oi_change=_f(r.get("CHG_IN_OI", "")), volume=_f(r.get("CONTRACTS", "")),
        lot_size=None, source=SOURCE)


def parse_nse_udiff(path: Path, symbols: set[str] | None = None) -> list[ContractRow]:
    """Kept for callers that only want UDiFF rows; raises on any other layout."""
    res = parse_bhavcopy(path, symbols)
    if res.fmt != "udiff":
        raise BhavcopyFormatError(f"{path.name}: expected UDiFF, found {res.fmt}")
    return res.rows
