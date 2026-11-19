"""Bhavcopy pipeline: download -> raw file -> parse and validate -> processed Parquet, with an ingestion log.

Raw files and processed data are kept apart:
  <home>/raw/nse/fo/<YYYY>/<original file name>      exactly the bytes NSE served (or you imported)
  <home>/store/contracts/...                          parsed, validated, de-duplicated contract rows
  <home>/store/ledger.sqlite  (bhav_files, ingest_log) one row per date: ok / unavailable / failed, with
                                                       checksum, layout, row count and origin (nse|manual)

States per date: `ok` (parsed and stored), `unavailable` (every candidate URL answered 404: an exchange
holiday, a day not yet published, or a file NSE no longer hosts; not distinguishable from here), `failed`
(download or parse failed: reason logged; nothing processed is written for that date).

NSE may refuse scripted downloads (HTTP 403/401, or an HTML page instead of a zip). That stops the run
with `NseBlocked`; the manual path (`straddloop bhav-import <files>`) takes files you downloaded in a
browser and runs them through the same parse, validation and ledger steps.

URL patterns below are NSE's published archive locations as known when this was written; they were NOT
fetched from the build environment (NSE was unreachable), so treat them as unverified until the first
real run. If NSE changes a path, a date shows `unavailable`, not wrong data.
"""

from __future__ import annotations

import hashlib
import logging
import os
import random
import shutil
import time as _time
from dataclasses import dataclass, field
from datetime import date, timedelta
from pathlib import Path

import httpx

from straddloop.data import store
from straddloop.data.ledger import Ledger
from straddloop.data.schema import ContractRow
from straddloop.reference.bhavcopy import BhavcopyFormatError, ParseResult, parse_bhavcopy

log = logging.getLogger("straddloop")

UDIFF_FROM = date(2024, 7, 8)
UDIFF_URL = "https://nsearchives.nseindia.com/content/fo/BhavCopy_NSE_FO_0_0_0_{ymd}_F_0000.csv.zip"
LEGACY_URLS = (
    "https://nsearchives.nseindia.com/content/historical/DERIVATIVES/{yyyy}/{mon}/fo{dd}{mon}{yyyy}bhav.csv.zip",
    "https://archives.nseindia.com/content/historical/DERIVATIVES/{yyyy}/{mon}/fo{dd}{mon}{yyyy}bhav.csv.zip",
)
HEADERS = {
    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
    "Accept": "*/*", "Accept-Language": "en-US,en;q=0.9", "Referer": "https://www.nseindia.com/",
}
DEFAULT_SYMBOLS = "NIFTY,BANKNIFTY,FINNIFTY,MIDCPNIFTY"


class NseBlocked(RuntimeError):
    """NSE refused the request. Retrying will not help; use `straddloop bhav-import` with browser downloads."""


def candidate_urls(day: date) -> list[str]:
    ymd = day.strftime("%Y%m%d")
    udiff = UDIFF_URL.format(ymd=ymd)
    legacy = [u.format(yyyy=day.year, mon=day.strftime("%b").upper(), dd=f"{day.day:02d}") for u in LEGACY_URLS]
    return [udiff] + legacy if day >= UDIFF_FROM else legacy + [udiff]


@dataclass
class BhavSummary:
    ok: list[date] = field(default_factory=list)
    skipped: list[date] = field(default_factory=list)
    unavailable: list[date] = field(default_factory=list)
    failed: list[date] = field(default_factory=list)
    rows: int = 0


def raw_path_for(raw_dir: Path, day: date, filename: str) -> Path:
    return raw_dir / "nse" / "fo" / f"{day.year}" / filename


def _sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def ingest_file(path: Path, store_dir: Path, raw_dir: Path, ledger: Ledger, *, origin: str,
                symbols: set[str] | None = None, expect_day: date | None = None) -> ParseResult:
    """Parse + validate one bhavcopy file, keep the raw bytes, write processed rows, log the outcome.
    Raises BhavcopyFormatError (after logging a `failed` row when the date is known) on an unusable file."""
    try:
        res = parse_bhavcopy(path, symbols)
    except BhavcopyFormatError as exc:
        if expect_day:
            ledger.set_bhav(expect_day, "FO", "failed", detail=str(exc)[:500], origin=origin)
        raise
    day = res.trade_date
    if day is None:
        msg = f"{path.name}: no option rows for the selected symbols"
        if expect_day:
            ledger.set_bhav(expect_day, "FO", "failed", fmt=res.fmt, detail=msg, origin=origin)
        raise BhavcopyFormatError(msg)
    if expect_day and day != expect_day:
        ledger.set_bhav(expect_day, "FO", "failed", fmt=res.fmt, origin=origin,
                        detail=f"file holds trade date {day}, expected {expect_day}")
        raise BhavcopyFormatError(f"{path.name}: holds {day}, expected {expect_day}")
    dest = raw_path_for(raw_dir, day, path.name)
    dest.parent.mkdir(parents=True, exist_ok=True)
    if path.resolve() != dest.resolve():
        tmp = dest.with_name(f".{dest.name}.{os.getpid()}.tmp")
        try:
            shutil.copyfile(path, tmp)
            os.replace(tmp, dest)
        finally:
            tmp.unlink(missing_ok=True)
    # Processed rows: one partition per (symbol, day), replaced whole, so re-ingesting never duplicates.
    store.write_records(store_dir, "contracts", res.rows, ContractRow)
    ledger.set_bhav(day, "FO", "ok", fmt=res.fmt, raw_path=str(dest), sha256=_sha(dest), bytes=dest.stat().st_size,
                    rows=len(res.rows), origin=origin,
                    detail=(f"dropped {dict(res.dropped)}" if res.dropped else None))
    return res


class NseClient:
    def __init__(self, http: httpx.Client | None = None, sleep=_time.sleep, max_attempts: int = 4,
                 min_gap: float = 1.0):
        self.http = http or httpx.Client(headers=HEADERS, timeout=60, follow_redirects=True)
        self.sleep, self.max_attempts, self.min_gap = sleep, max_attempts, min_gap
        self._last = 0.0

    def get(self, url: str) -> bytes | None:
        """Bytes of the file, or None on 404. Raises NseBlocked on 401/403 or an HTML body, RuntimeError
        after repeated network or server errors."""
        last = ""
        for attempt in range(self.max_attempts):
            gap = _time.monotonic() - self._last
            if gap < self.min_gap:
                self.sleep(self.min_gap - gap)
            self._last = _time.monotonic()
            try:
                resp = self.http.get(url, headers=HEADERS)
            except httpx.TransportError as exc:
                last = type(exc).__name__
            else:
                if resp.status_code == 404:
                    return None
                if resp.status_code in (401, 403):
                    raise NseBlocked(f"NSE answered {resp.status_code} for {url}")
                if resp.status_code == 200:
                    body = resp.content
                    declared = resp.headers.get("content-length")
                    if declared and declared.isdigit() and int(declared) != len(body):
                        last = f"incomplete download ({len(body)} of {declared} bytes)"
                    elif body[:1] == b"<":
                        raise NseBlocked(f"NSE returned an HTML page instead of a file for {url}")
                    elif not body:
                        last = "empty body"
                    else:
                        return body
                else:
                    last = f"HTTP {resp.status_code}"
            delay = min(60.0, 2.0 ** (attempt + 1)) * (0.5 + random.random() / 2)
            log.warning("NSE %s: %s; retry %d/%d in %.1fs", url, last, attempt + 1, self.max_attempts, delay)
            self.sleep(delay)
        raise RuntimeError(f"gave up on {url} after {self.max_attempts} attempts ({last})")


def download_range(start: date, end_inclusive: date, store_dir: Path, raw_dir: Path, *, symbols: set[str] | None,
                   client: NseClient | None = None, refetch: bool = False,
                   include_weekends: bool = False) -> BhavSummary:
    """Download every date in the range not already stored. Resumable: `ok` dates are skipped, a date that
    failed is retried, and `unavailable` dates are retried only with `refetch` (or after 7 days, in case
    NSE had not published yet)."""
    client = client or NseClient()
    ledger = Ledger(store_dir)
    out = BhavSummary()
    try:
        d = start
        while d <= end_inclusive:
            if d.weekday() >= 5 and not include_weekends:
                d += timedelta(days=1)
                continue
            row = ledger.get_bhav(d)
            if row and not refetch and (row["status"] == "ok" or (
                    row["status"] == "unavailable" and (date.today() - d) > timedelta(days=7))):
                out.skipped.append(d)
                d += timedelta(days=1)
                continue
            _one_day(d, client, store_dir, raw_dir, ledger, symbols, out)
            d += timedelta(days=1)
    finally:
        ledger.close()
    return out


def _one_day(day: date, client: NseClient, store_dir: Path, raw_dir: Path, ledger: Ledger,
             symbols: set[str] | None, out: BhavSummary) -> None:
    for url in candidate_urls(day):
        try:
            body = client.get(url)
        except NseBlocked as exc:
            ledger.log_event("bhavcopy", "FO", day, "blocked", "nse", str(exc))
            raise NseBlocked(f"{exc}. NSE is refusing scripted downloads from this machine. Download the files "
                             "in a browser and run `straddloop bhav-import <files>` (see docs/BHAVCOPY.md).") from exc
        except RuntimeError as exc:
            ledger.set_bhav(day, "FO", "failed", detail=str(exc)[:500], origin="nse")
            out.failed.append(day)
            return
        if body is None:
            continue
        tmp = raw_dir / "nse" / "fo" / ".incoming" / url.rsplit("/", 1)[-1]
        tmp.parent.mkdir(parents=True, exist_ok=True)
        tmp.write_bytes(body)
        try:
            res = ingest_file(tmp, store_dir, raw_dir, ledger, origin="nse", symbols=symbols, expect_day=day)
        except BhavcopyFormatError as exc:
            log.error("%s: %s", day, exc)
            out.failed.append(day)
            return
        finally:
            tmp.unlink(missing_ok=True)
        out.ok.append(day)
        out.rows += len(res.rows)
        log.info("%s: %d option rows (%s layout)", day, len(res.rows), res.fmt)
        return
    ledger.set_bhav(day, "FO", "unavailable", origin="nse",
                    detail="404 on every candidate URL: exchange holiday, not yet published, or no longer hosted")
    out.unavailable.append(day)
    log.info("%s: no file published (holiday or unavailable)", day)


def import_files(paths: list[Path], store_dir: Path, raw_dir: Path, symbols: set[str] | None) -> BhavSummary:
    """Manual path: files downloaded in a browser. The trade date comes from the file's contents."""
    ledger = Ledger(store_dir)
    out = BhavSummary()
    try:
        for p in paths:
            try:
                res = ingest_file(p, store_dir, raw_dir, ledger, origin="manual", symbols=symbols)
            except BhavcopyFormatError as exc:
                log.error("%s: %s", p, exc)
                ledger.log_event("bhavcopy", "FO", None, "failed", "manual", f"{p.name}: {exc}"[:500])
                out.failed.append(date.min)
                continue
            out.ok.append(res.trade_date)
            out.rows += len(res.rows)
            log.info("%s: %s, %d option rows (%s layout)", p.name, res.trade_date, len(res.rows), res.fmt)
    finally:
        ledger.close()
    return out
