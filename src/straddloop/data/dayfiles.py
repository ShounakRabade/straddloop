"""Day files: one compact, gzip-compressed JSON document per trading day per expiry series.

This is the format the website reads (from the private Supabase Storage bucket `market-data`, or
from files on this computer). It is built from the validated local Parquet store, so the store stays
the single source of truth and a day file can always be rebuilt from it.

Format version 1 (all arrays have 375 slots, one per minute from 09:15 IST; null = no bar):

    {
      "v": 1, "underlying": "NIFTY", "expiry_flag": "WEEK", "date": "2025-10-06",
      "expiry": "2025-10-07", "expiry_source": "assumed: ...", "lot_size": 75, "lot_source": "assumed: ...",
      "t0": 555, "n": 375, "px_scale": 100,
      "index": {"o": [...], "h": [...], "l": [...], "c": [...]} | null,
      "spot": [...],
      "series": [{"cp": "CE", "off": -10, "k": [...], "o": [...], "h": [...], "l": [...], "c": [...],
                  "v": [...], "oi": [...], "iv": [...]}, ...]
    }

Prices are integers in 1/100 rupee (px_scale). `o`, `k`, `v`, `oi`, `iv`, `spot` and index `o` are
delta-coded against the previous non-null value in the same array; `h` is stored as h-o, `l` as o-l
and `c` as c-o for the same bar. `iv` is IV x 100. The decoder lives in web/lib/dayfile.ts.

Expiry dates and lot sizes are ASSUMPTIONS until the bhavcopy step confirms them: Dhan returns only
a relative expiry code. Every file says so in `expiry_source` and `lot_source`.
"""

from __future__ import annotations

import gzip
import hashlib
import json
import re
from collections import defaultdict
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from pathlib import Path

import pyarrow.parquet as pq

from straddloop.timeutil import IST

FORMAT_VERSION = 1
T0 = 9 * 60 + 15
N = 375
PX = 100

_DATE_IN_PATH = re.compile(r"date=(\d{4}-\d{2}-\d{2})")
_MONEYNESS = re.compile(r"^ATM([+-]\d+)?$")

# NSE moved NIFTY weekly and monthly expiries from Thursday to Tuesday from 1 Sep 2025.
TUESDAY_FROM = date(2025, 9, 1)

# Best-effort lot sizes (by expiry date). UNVERIFIED: the bhavcopy step replaces these.
LOT_SIZES = {
    "NIFTY": [(date(2019, 1, 1), 75), (date(2021, 7, 29), 50), (date(2024, 4, 26), 25),
              (date(2024, 12, 26), 75), (date(2026, 1, 1), 65)],
    "BANKNIFTY": [(date(2019, 1, 1), 20), (date(2020, 5, 1), 25), (date(2023, 7, 1), 15),
                  (date(2024, 12, 24), 30), (date(2025, 6, 26), 35), (date(2026, 1, 1), 30)],
    "SENSEX": [(date(2023, 5, 1), 10), (date(2024, 12, 24), 20)],
}


def _expiry_weekday(d: date) -> int:
    return 1 if d >= TUESDAY_FROM else 3  # Tuesday / Thursday


def assumed_expiry(trade_date: date, expiry_flag: str) -> date:
    """Nearest weekly or monthly expiry on or after `trade_date`, ignoring holiday shifts."""
    if expiry_flag == "WEEK":
        d = trade_date
        while d.weekday() != _expiry_weekday(d):
            d += timedelta(days=1)
        return d
    y, m = trade_date.year, trade_date.month
    for _ in range(2):
        nxt = date(y + (m == 12), m % 12 + 1, 1)
        last = nxt - timedelta(days=1)
        while last.weekday() != _expiry_weekday(last):
            last -= timedelta(days=1)
        if last >= trade_date:
            return last
        y, m = nxt.year, nxt.month
    raise AssertionError("unreachable")


def assumed_lot_size(underlying: str, expiry: date) -> int | None:
    lot = None
    for start, size in LOT_SIZES.get(underlying, []):
        if expiry >= start:
            lot = size
    return lot


def _offset(label: str | None) -> int | None:
    m = _MONEYNESS.match((label or "").strip().upper())
    if not m:
        return None
    return int(m.group(1) or 0)


def _minute(ts) -> int | None:
    if not isinstance(ts, datetime):
        return None
    t = ts.astimezone(IST)
    i = t.hour * 60 + t.minute - T0
    return i if 0 <= i < N else None


def _int(x, scale: float = 1.0) -> int | None:
    if x is None:
        return None
    try:
        f = float(x)
    except (TypeError, ValueError):
        return None
    if f != f:  # NaN
        return None
    return int(round(f * scale))


def delta(values: list[int | None]) -> list[int | None]:
    out, prev = [], 0
    for v in values:
        if v is None:
            out.append(None)
        else:
            out.append(v - prev)
            prev = v
    return out


def undelta(values: list[int | None]) -> list[int | None]:
    out, prev = [], 0
    for v in values:
        if v is None:
            out.append(None)
        else:
            prev += v
            out.append(prev)
    return out


def _rel(a: list[int | None], base: list[int | None], sign: int) -> list[int | None]:
    return [None if x is None or b is None else sign * (x - b) for x, b in zip(a, base, strict=True)]


# ------------------------------------------------------------------ reading the local store

def _files_by_date(root: Path) -> dict[date, list[Path]]:
    out: dict[date, list[Path]] = defaultdict(list)
    for p in sorted(root.glob("**/*.parquet")):
        m = _DATE_IN_PATH.search(p.as_posix())
        if m:
            out[date.fromisoformat(m.group(1))].append(p)
        else:
            out[date.min].append(p)  # unpartitioned file: read it for every day
    return out


class StoreReader:
    """Reads option and index candles for one day from the Parquet store, whatever its partitioning."""

    def __init__(self, store_dir: Path):
        self.store_dir = store_dir
        self.opt_files = _files_by_date(store_dir / "option_candles")
        self.und_files = _files_by_date(store_dir / "underlying_candles")

    def option_dates(self) -> list[date]:
        return sorted(d for d in self.opt_files if d != date.min)

    @staticmethod
    def _rows(files: list[Path], day: date, **eq) -> list[dict]:
        rows = []
        for p in files:
            for r in pq.read_table(p).to_pylist():
                ts = r.get("ts")
                if not isinstance(ts, datetime) or ts.astimezone(IST).date() != day:
                    continue
                if all(r.get(k) == v for k, v in eq.items()):
                    rows.append(r)
        return rows

    def options(self, day: date, underlying: str, expiry_flag: str) -> list[dict]:
        files = self.opt_files.get(day, []) + self.opt_files.get(date.min, [])
        return self._rows(files, day, underlying=underlying, expiry_flag=expiry_flag)

    def index(self, day: date, underlying: str) -> list[dict]:
        files = self.und_files.get(day, []) + self.und_files.get(date.min, [])
        return [r for r in self._rows(files, day, underlying=underlying) if (r.get("interval_min") or 1) == 1]


# ------------------------------------------------------------------ building a day file

@dataclass
class DayFile:
    underlying: str
    expiry_flag: str
    trade_date: date
    doc: dict
    blob: bytes
    sha256: str
    series: int
    option_bars: int
    index_bars: int
    missing_bars: int

    @property
    def path(self) -> str:
        return f"{self.underlying}/{self.expiry_flag}/{self.trade_date.isoformat()}.json.gz"

    @property
    def quality(self) -> str:
        if self.series == 0:
            return "empty"
        return "complete" if self.missing_bars == 0 else f"gaps:{self.missing_bars}"

    def row(self) -> dict:
        d = self.doc
        return {
            "underlying": self.underlying, "expiry_flag": self.expiry_flag,
            "trade_date": self.trade_date.isoformat(), "path": self.path, "format_version": FORMAT_VERSION,
            "series": self.series, "option_bars": self.option_bars, "index_bars": self.index_bars,
            "expiry": d["expiry"], "expiry_source": d["expiry_source"], "lot_size": d["lot_size"],
            "lot_source": d["lot_source"], "quality": self.quality, "sha256": self.sha256, "bytes": len(self.blob),
        }


def build_day(underlying: str, expiry_flag: str, day: date, option_rows: list[dict],
              index_rows: list[dict]) -> DayFile | None:
    series: dict[tuple[str, int], dict[str, list]] = {}
    spot: list[int | None] = [None] * N
    option_bars = 0
    for r in option_rows:
        off, i = _offset(r.get("moneyness")), _minute(r.get("ts"))
        cp = (r.get("option_type") or "").upper()
        if off is None or i is None or cp not in ("CE", "PE"):
            continue
        key = (cp, off)
        s = series.get(key)
        if s is None:
            s = series[key] = {f: [None] * N for f in ("k", "o", "h", "l", "c", "v", "oi", "iv")}
        if s["o"][i] is None:
            option_bars += 1
        s["k"][i] = _int(r.get("strike"))
        for f in ("open", "high", "low", "close"):
            s[f[0]][i] = _int(r.get(f), PX)
        s["v"][i] = _int(r.get("volume"))
        s["oi"][i] = _int(r.get("oi"))
        s["iv"][i] = _int(r.get("iv"), 100)
        if spot[i] is None:
            spot[i] = _int(r.get("spot"), PX)
    if not series:
        return None

    idx = None
    index_bars = 0
    if index_rows:
        idx = {f: [None] * N for f in "ohlc"}
        for r in index_rows:
            i = _minute(r.get("ts"))
            if i is None:
                continue
            for f in ("open", "high", "low", "close"):
                idx[f[0]][i] = _int(r.get(f), PX)
        index_bars = sum(v is not None for v in idx["o"])
        idx = {"o": delta(idx["o"]), "h": _rel(idx["h"], idx["o"], 1), "l": _rel(idx["o"], idx["l"], 1),
               "c": _rel(idx["c"], idx["o"], 1)}

    expiry = assumed_expiry(day, expiry_flag)
    lot = assumed_lot_size(underlying, expiry)
    out_series = []
    missing = 0
    for (cp, off) in sorted(series, key=lambda k: (k[0], k[1])):
        s = series[(cp, off)]
        missing += sum(v is None for v in s["o"])
        out_series.append({
            "cp": cp, "off": off, "k": delta(s["k"]), "o": delta(s["o"]),
            "h": _rel(s["h"], s["o"], 1), "l": _rel(s["o"], s["l"], 1), "c": _rel(s["c"], s["o"], 1),
            "v": delta(s["v"]), "oi": delta(s["oi"]), "iv": delta(s["iv"]),
        })
    doc = {
        "v": FORMAT_VERSION, "underlying": underlying, "expiry_flag": expiry_flag, "date": day.isoformat(),
        "expiry": expiry.isoformat(),
        "expiry_source": "assumed: nearest " + ("weekly" if expiry_flag == "WEEK" else "monthly")
        + " expiry weekday (Thu before 1 Sep 2025, Tue after), holidays not applied; bhavcopy not yet checked",
        "lot_size": lot, "lot_source": "assumed: best-effort table, unverified",
        "t0": T0, "n": N, "px_scale": PX, "source": "dhan rolling options, 1-minute candles (no bid/ask)",
        "index": idx, "spot": delta(spot), "series": out_series,
    }
    raw = json.dumps(doc, separators=(",", ":")).encode()
    blob = gzip.compress(raw, compresslevel=9, mtime=0)
    return DayFile(underlying, expiry_flag, day, doc, blob, hashlib.sha256(raw).hexdigest(), len(out_series),
                   option_bars, index_bars, missing)


def decode(doc: dict) -> dict:
    """Inverse of the encoding above (used by tests and as the reference for the TypeScript decoder)."""
    def ohlc(b: dict) -> dict:
        o = undelta(b["o"])
        return {"o": o, "h": [None if x is None or y is None else x + y for x, y in zip(o, b["h"], strict=True)],
                "l": [None if x is None or y is None else x - y for x, y in zip(o, b["l"], strict=True)],
                "c": [None if x is None or y is None else x + y for x, y in zip(o, b["c"], strict=True)]}
    out = {"index": ohlc(doc["index"]) if doc["index"] else None, "spot": undelta(doc["spot"]), "series": []}
    for s in doc["series"]:
        d = ohlc(s)
        d.update(cp=s["cp"], off=s["off"], k=undelta(s["k"]), v=undelta(s["v"]), oi=undelta(s["oi"]),
                 iv=undelta(s["iv"]))
        out["series"].append(d)
    return out
