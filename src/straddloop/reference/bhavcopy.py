"""Exchange bhavcopy import: the source of the historical contract master.

The NSE F&O "UDiFF Common Bhavcopy Final" (published since 8 July 2024) lists every contract traded
on a day with its expiry, strike, settlement price, open interest and board lot size (NewBrdLotQty).
That makes it the authority for which contracts existed and their lot sizes on each date. Dhan's
intraday candles carry neither, so they are joined to this master.

Only the UDiFF layout is mapped here. Older NSE layouts and the BSE bhavcopy need their own mapping
once a real file is available to check headers against; until then they are rejected, not guessed.
"""

from __future__ import annotations

import csv
import io
import zipfile
from datetime import date, datetime
from pathlib import Path

from straddloop.data.schema import ContractRow

UDIFF_REQUIRED = {"TradDt", "TckrSymb", "XpryDt", "StrkPric", "OptnTp", "ClsPric", "NewBrdLotQty"}
OPTION_INSTRUMENTS = {"IDO", "STO"}  # index options, stock options (UDiFF FinInstrmTp codes)


class BhavcopyFormatError(ValueError):
    pass


def _f(value: str) -> float | None:
    value = (value or "").strip()
    return float(value) if value not in ("", "-") else None


def _d(value: str) -> date:
    value = value.strip()
    for fmt in ("%Y-%m-%d", "%d-%b-%Y", "%d-%m-%Y"):
        try:
            return datetime.strptime(value, fmt).date()
        except ValueError:
            continue
    raise BhavcopyFormatError(f"unrecognised date {value!r}")


def _read_text(path: Path) -> str:
    if path.suffix.lower() == ".zip":
        with zipfile.ZipFile(path) as zf:
            names = [n for n in zf.namelist() if n.lower().endswith(".csv")]
            if len(names) != 1:
                raise BhavcopyFormatError(f"{path.name}: expected one CSV inside, found {names}")
            return zf.read(names[0]).decode("utf-8-sig")
    return path.read_text(encoding="utf-8-sig")


def parse_nse_udiff(path: Path, symbols: set[str] | None = None) -> list[ContractRow]:
    reader = csv.DictReader(io.StringIO(_read_text(path)))
    header = {h.strip() for h in reader.fieldnames or []}
    missing = UDIFF_REQUIRED - header
    if missing:
        raise BhavcopyFormatError(f"{path.name}: not a UDiFF F&O bhavcopy; missing columns {sorted(missing)}")
    rows = []
    for raw in reader:
        r = {k.strip(): (v or "").strip() for k, v in raw.items() if k}
        if r.get("FinInstrmTp") not in OPTION_INSTRUMENTS:
            continue
        if symbols and r["TckrSymb"] not in symbols:
            continue
        lot = _f(r["NewBrdLotQty"])
        rows.append(
            ContractRow(
                trade_date=_d(r["TradDt"]),
                exchange="NSE",
                symbol=r["TckrSymb"],
                instrument=r["FinInstrmTp"],
                expiry=_d(r["XpryDt"]),
                strike=float(r["StrkPric"]),
                option_type=r["OptnTp"],
                open=_f(r.get("OpnPric", "")),
                high=_f(r.get("HghPric", "")),
                low=_f(r.get("LwPric", "")),
                close=_f(r["ClsPric"]),
                settle=_f(r.get("SttlmPric", "")),
                underlying_price=_f(r.get("UndrlygPric", "")),
                oi=_f(r.get("OpnIntrst", "")),
                volume=_f(r.get("TtlTradgVol", "")),
                lot_size=int(lot) if lot else None,
                source="nse_bhavcopy_udiff",
            )
        )
    return rows
