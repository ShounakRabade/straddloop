"""Dhan (DhanHQ v2) market-data connector.

Endpoints used (checked against https://dhanhq.co/docs/v2/ on 22 Oct 2026):

* POST /v2/charts/intraday      underlying candles; 1/5/15/25/60 min; last 5 years; <= 90 days a call
* POST /v2/charts/rollingoption expired options relative to ATM; 1/5/15/25/60 min; last 5 years;
                                <= 30 days a call; toDate exclusive; ATM+-10 for near-expiry index
                                options, ATM+-3 otherwise; returns open/high/low/close/volume/oi/iv/
                                strike/spot arrays with epoch timestamps

What this source cannot give, and the connector therefore never fills in: bid/ask history, the
actual expiry date (only a relative expiry code), lot size, and prices for a fixed strike once it
leaves the ATM window. Expiry and lot size come from the exchange contract master instead.

Every raw response is archived next to its request body so any stored candle can be traced back to
the exact API answer it came from.
"""

from __future__ import annotations

import hashlib
import json
import logging
import math
import os
import random
import time as _time
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

import httpx

from straddloop.data.providers.base import (
    AuthError,
    ExpiredOptionRequest,
    ProviderCapabilities,
    ProviderError,
)
from straddloop.data.schema import OptionCandle, UnderlyingCandle
from straddloop.timeutil import date_windows, epoch_to_ist

log = logging.getLogger(__name__)

BASE_URL = "https://api.dhan.co/v2"
SOURCE = "dhan"


@dataclass(frozen=True)
class DhanUnderlying:
    security_id: str
    index_segment: str  # segment for the index candles
    fno_segment: str  # segment for its options
    option_instrument: str
    default_expiry_flag: str  # series Strategy 1 trades by default (BANKNIFTY has monthly only)


# Security ids are Dhan's quick-reference values (NIFTY 13, BANKNIFTY 25, SENSEX 51 on IDX_I).
# They must be confirmed against Dhan's scrip master (api-scrip-master.csv) before a bulk pull;
# `straddloop dhan-check-ids` does that.
UNDERLYINGS: dict[str, DhanUnderlying] = {
    "NIFTY": DhanUnderlying("13", "IDX_I", "NSE_FNO", "OPTIDX", "WEEK"),
    "BANKNIFTY": DhanUnderlying("25", "IDX_I", "NSE_FNO", "OPTIDX", "MONTH"),
    "SENSEX": DhanUnderlying("51", "IDX_I", "BSE_FNO", "OPTIDX", "WEEK"),
}

CAPABILITIES = ProviderCapabilities(
    name=SOURCE,
    expired_options=True,
    fixed_contract_history=False,
    bid_ask_history=False,
    max_moneyness_offset=10,
    intervals_min=(1, 5, 15, 25, 60),
    history_years=5,
    notes="Strikes relative to ATM; actual strike returned per candle. No bid/ask, no expiry date, "
    "no lot size.",
)

OPTION_FIELDS = ["open", "high", "low", "close", "volume", "oi", "iv", "strike", "spot"]


class _RateLimiter:
    def __init__(self, per_second: float):
        self.min_gap = 1.0 / per_second if per_second > 0 else 0.0
        self._last = 0.0

    def wait(self) -> None:
        gap = _time.monotonic() - self._last
        if gap < self.min_gap:
            _time.sleep(self.min_gap - gap)
        self._last = _time.monotonic()


class DhanProvider:
    capabilities = CAPABILITIES

    def __init__(
        self,
        client_id: str,
        access_token: str,
        raw_dir: Path,
        requests_per_second: float = 4.0,
        http: httpx.Client | None = None,
        max_attempts: int = 6,
        sleep=_time.sleep,
    ):
        self.max_attempts = max_attempts
        self._sleep = sleep
        if not access_token:
            raise ProviderError("Dhan access token is missing; set DHAN_ACCESS_TOKEN in .env")
        self._headers = {
            "Accept": "application/json",
            "Content-Type": "application/json",
            "access-token": access_token,
        }
        if client_id:
            self._headers["client-id"] = client_id
        self._http = http or httpx.Client(base_url=BASE_URL, timeout=30.0)
        self._limiter = _RateLimiter(requests_per_second)
        self._raw_dir = raw_dir / SOURCE

    # ---- transport -------------------------------------------------------------------------
    # Error codes below are from Dhan's published annexure (https://dhanhq.co/docs/v2/annexure/) as recalled
    # when this was written; not re-verified live from the build environment (api.dhan.co was unreachable).
    #   DH-901 invalid/expired token (HTTP 401)       -> AuthError, stop
    #   DH-902 no API access / no Data API plan       -> AuthError, stop
    #   DH-903 account rule violation                 -> AuthError, stop
    #   DH-904 rate limit (HTTP 429)                  -> retry with backoff
    #   DH-905 bad input                              -> ProviderError, no retry
    #   DH-908/909 server / network error (5xx)       -> retry with backoff

    AUTH_CODES = {"DH-901", "DH-902", "DH-903"}
    RETRY_CODES = {"DH-904", "DH-908", "DH-909"}

    def _backoff(self, attempt: int, retry_after: str | None = None) -> float:
        if retry_after and retry_after.replace(".", "", 1).isdigit():
            return min(120.0, float(retry_after))
        return min(60.0, 2.0 ** (attempt + 1)) * (0.5 + random.random() / 2)  # jitter: 50-100% of the step

    def _request(self, method: str, endpoint: str, body: dict | None = None) -> dict:
        last = "no attempt made"
        for attempt in range(self.max_attempts):
            self._limiter.wait()
            try:
                resp = self._http.request(method, endpoint, json=body, headers=self._headers)
            except httpx.TransportError as exc:  # timeouts, resets, DNS: nothing was received, nothing stored
                last = f"network error {type(exc).__name__}"
                delay = self._backoff(attempt)
                log.warning("Dhan %s: %s; retry %d/%d in %.1fs", endpoint, last, attempt + 1, self.max_attempts, delay)
                self._sleep(delay)
                continue
            code = _error_code(resp)
            if resp.status_code == 401 or code in self.AUTH_CODES or resp.status_code == 403:
                raise AuthError(
                    f"Dhan rejected the credentials on {endpoint} (HTTP {resp.status_code}, {code or 'no code'}). "
                    "The access token has probably expired or the Data API plan is inactive: generate a new "
                    "token at web.dhan.co, put it in .env as DHAN_ACCESS_TOKEN, and re-run. Nothing stored was "
                    "changed; the run resumes where it stopped.")
            if resp.status_code == 429 or resp.status_code >= 500 or code in self.RETRY_CODES:
                last = f"HTTP {resp.status_code} {code or ''}".strip()
                delay = self._backoff(attempt, resp.headers.get("retry-after"))
                log.warning("Dhan %s: %s; retry %d/%d in %.1fs", endpoint, last, attempt + 1, self.max_attempts, delay)
                self._sleep(delay)
                continue
            if resp.status_code != 200:
                raise ProviderError(f"Dhan {endpoint} returned {resp.status_code}: {resp.text[:300]}")
            try:
                payload = resp.json()
            except ValueError as exc:
                raise ProviderError(f"Dhan {endpoint}: response is not JSON") from exc
            if not isinstance(payload, dict):
                raise ProviderError(f"Dhan {endpoint}: unexpected response shape {type(payload).__name__}")
            if payload.get("errorCode") or str(payload.get("status", "")).lower() == "failure":
                raise ProviderError(f"Dhan {endpoint}: error in a 200 response: {str(payload)[:300]}")
            if body is not None:
                self._archive(endpoint, body, payload)
            return payload
        raise ProviderError(f"Dhan {endpoint}: gave up after {self.max_attempts} attempts ({last})")

    def _post(self, endpoint: str, body: dict) -> dict:
        return self._request("POST", endpoint, body)

    def profile(self) -> dict:
        """Token check: GET /profile. Returns token expiry and plan fields only (never the token)."""
        data = self._request("GET", "/profile")
        return {k: data.get(k) for k in ("dhanClientId", "tokenValidity", "activeSegment", "dataPlan", "dataValidity")}

    def _archive(self, endpoint: str, body: dict, payload: dict) -> Path:
        key = hashlib.sha256(json.dumps([endpoint, body], sort_keys=True).encode()).hexdigest()[:16]
        path = self._raw_dir / endpoint.strip("/").replace("/", "_") / f"{key}.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        record = {
            "endpoint": endpoint,
            "request": body,
            "fetched_at": datetime.now(UTC).isoformat(),
            "response": payload,
        }
        tmp = path.with_suffix(f".{os.getpid()}.tmp")
        try:
            tmp.write_text(json.dumps(record), encoding="utf-8")
            os.replace(tmp, path)
        finally:
            tmp.unlink(missing_ok=True)
        return path

    # ---- underlying candles ----------------------------------------------------------------

    def underlying_candles(
        self, underlying: str, start: date, end: date, interval_min: int = 1
    ) -> list[UnderlyingCandle]:
        spec = _spec(underlying)
        out: list[UnderlyingCandle] = []
        for w_start, w_end in date_windows(start, end, 90):
            body = {
                "securityId": spec.security_id,
                "exchangeSegment": spec.index_segment,
                "instrument": "INDEX",
                "interval": str(interval_min),
                "oi": False,
                "fromDate": f"{w_start.isoformat()} 09:15:00",
                "toDate": f"{w_end.isoformat()} 09:15:00",
            }
            out.extend(parse_intraday(self._post("/charts/intraday", body), underlying, interval_min))
        return out

    # ---- expired options -------------------------------------------------------------------

    def expired_option_candles(self, request: ExpiredOptionRequest) -> list[OptionCandle]:
        spec = _spec(request.underlying)
        # Dhan documents ATM+-10 for "near expiry" index options; we read that as expiry code 1 (the
        # nearest expiry of the requested series). The Phase 2 sample checks this reading.
        near = spec.option_instrument == "OPTIDX" and request.expiry_code == 1
        check_moneyness(request.moneyness, near_expiry_index=near)
        out: list[OptionCandle] = []
        for day in _weekdays(request.start, request.end):
            body = {
                "exchangeSegment": spec.fno_segment,
                "interval": str(request.interval_min),
                "securityId": spec.security_id,
                "instrument": spec.option_instrument,
                "expiryFlag": request.expiry_flag,
                "expiryCode": request.expiry_code,
                "strike": request.moneyness,
                "drvOptionType": "CALL" if request.option_type == "CE" else "PUT",
                "requiredData": OPTION_FIELDS,
                # Verified live 19 Nov 2026: fromDate == toDate returns exactly that day; any span over
                # one day is refused with DH-905, despite the docs' "30 days" and "toDate exclusive".
                "fromDate": day.isoformat(),
                "toDate": day.isoformat(),
            }
            payload = self._post("/charts/rollingoption", body)
            out.extend(parse_rolling_option(payload, request))
        return out


def _weekdays(start: date, end: date) -> list[date]:
    """Each Monday-Friday in [start, end) (end exclusive, like every other date range here)."""
    out, d = [], start
    while d < end:
        if d.weekday() < 5:
            out.append(d)
        d += timedelta(days=1)
    return out


def _spec(underlying: str) -> DhanUnderlying:
    try:
        return UNDERLYINGS[underlying]
    except KeyError as exc:
        raise ProviderError(f"No Dhan mapping for {underlying!r}; known: {sorted(UNDERLYINGS)}") from exc


def check_moneyness(label: str, near_expiry_index: bool) -> int:
    """Validate an 'ATM', 'ATM+3', 'ATM-10' label and return its offset."""
    if label == "ATM":
        return 0
    if not label.startswith("ATM") or label[3] not in "+-":
        raise ProviderError(f"Bad moneyness label {label!r}")
    offset = int(label[3:])
    limit = 10 if near_expiry_index else 3
    if abs(offset) > limit:
        raise ProviderError(f"{label} is outside Dhan's documented window of ATM+-{limit} for this series")
    return offset


def moneyness_labels(max_offset: int) -> list[str]:
    return [f"ATM{o:+d}" if o else "ATM" for o in range(-max_offset, max_offset + 1)]


def _error_code(resp: httpx.Response) -> str | None:
    try:
        body = resp.json()
    except ValueError:
        return None
    return body.get("errorCode") if isinstance(body, dict) else None


def _check_stamps(stamps: list) -> None:
    """Timestamps must be finite numbers in strictly ascending order (no duplicates, no reordering)."""
    prev = None
    for t in stamps:
        if not isinstance(t, (int, float)) or isinstance(t, bool) or not math.isfinite(t):
            raise ProviderError(f"Dhan response has a non-numeric timestamp {t!r}")
        if prev is not None and t <= prev:
            raise ProviderError("Dhan response timestamps are not strictly ascending")
        prev = t


def _arrays(block: dict, keys: list[str]) -> dict[str, list]:
    _check_stamps(block.get("timestamp") or [])
    n = len(block.get("timestamp") or [])
    out = {}
    for key in keys:
        values = block.get(key)
        if values is None or len(values) == 0:
            out[key] = [None] * n
        elif len(values) != n:
            raise ProviderError(f"Dhan response field {key!r} has {len(values)} values for {n} timestamps")
        else:
            if key in ("open", "high", "low", "close") and any(v is None for v in values):
                raise ProviderError(f"Dhan response has null values in {key!r}")
            out[key] = values
    return out


def parse_intraday(payload: dict, underlying: str, interval_min: int) -> list[UnderlyingCandle]:
    block = payload.get("data", payload)
    if not isinstance(block, dict):
        raise ProviderError("Dhan intraday response has no data object")
    stamps = block.get("timestamp") or []
    cols = _arrays(block, ["open", "high", "low", "close", "volume"])
    return [
        UnderlyingCandle(
            ts=epoch_to_ist(stamps[i]),
            underlying=underlying,
            interval_min=interval_min,
            open=float(cols["open"][i]),
            high=float(cols["high"][i]),
            low=float(cols["low"][i]),
            close=float(cols["close"][i]),
            volume=_num(cols["volume"][i]),
            source=SOURCE,
        )
        for i in range(len(stamps))
    ]


def parse_rolling_option(payload: dict, request: ExpiredOptionRequest) -> list[OptionCandle]:
    data = payload.get("data") or {}
    if not isinstance(data, dict):
        raise ProviderError("Dhan rolling-option response has no data object")
    block = data.get("ce" if request.option_type == "CE" else "pe")
    if not block:
        return []
    stamps = block.get("timestamp") or []
    cols = _arrays(block, OPTION_FIELDS)
    return [
        OptionCandle(
            ts=epoch_to_ist(stamps[i]),
            underlying=request.underlying,
            interval_min=request.interval_min,
            option_type=request.option_type,
            strike=_num(cols["strike"][i]),
            moneyness=request.moneyness,
            expiry_flag=request.expiry_flag,
            expiry_code=request.expiry_code,
            expiry=None,
            open=float(cols["open"][i]),
            high=float(cols["high"][i]),
            low=float(cols["low"][i]),
            close=float(cols["close"][i]),
            volume=_num(cols["volume"][i]),
            oi=_num(cols["oi"][i]),
            iv=_num(cols["iv"][i]),
            spot=_num(cols["spot"][i]),
            source=SOURCE,
        )
        for i in range(len(stamps))
    ]


def _num(value) -> float | None:
    return None if value is None else float(value)
