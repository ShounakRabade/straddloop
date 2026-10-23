"""Dhan connector tests. Payloads here are hand-written test fixtures shaped like Dhan's documented
response, not market data."""

from datetime import date

import httpx
import pytest

from straddloop.data.providers.base import ExpiredOptionRequest, ProviderError
from straddloop.data.providers.dhan import (
    DhanProvider,
    check_moneyness,
    moneyness_labels,
    parse_rolling_option,
)
from straddloop.timeutil import date_windows

# 1756698300 = 2025-09-01 03:45 UTC = 09:15 IST (the documented example timestamp)
T0 = 1756698300


def _request(**kw):
    base = dict(underlying="NIFTY", option_type="CE", moneyness="ATM+2", expiry_flag="WEEK",
                expiry_code=1, start=date(2025, 9, 1), end=date(2025, 9, 2))
    base.update(kw)
    return ExpiredOptionRequest(**base)


def test_parse_rolling_option_keeps_actual_strike_and_converts_to_ist():
    payload = {"data": {"ce": {
        "timestamp": [T0, T0 + 60], "open": [10.0, 11.0], "high": [12.0, 11.5], "low": [9.5, 10.5],
        "close": [11.0, 11.0], "volume": [100, 0], "oi": [5, 5], "iv": [14.2, 14.1],
        "strike": [24700, 24750], "spot": [24610.0, 24660.0]}, "pe": None}}
    rows = parse_rolling_option(payload, _request())
    assert [r.ts.strftime("%H:%M") for r in rows] == ["09:15", "09:16"]
    assert [r.strike for r in rows] == [24700.0, 24750.0]  # strike behind ATM+2 moved
    assert rows[0].expiry is None  # never guessed; joined later from the contract master
    assert rows[1].volume == 0.0


def test_parse_rejects_mismatched_arrays():
    payload = {"data": {"ce": {"timestamp": [T0, T0 + 60], "open": [1.0], "high": [1.0, 1.0],
                               "low": [1.0, 1.0], "close": [1.0, 1.0]}}}
    with pytest.raises(ProviderError):
        parse_rolling_option(payload, _request())


def test_moneyness_window_limits():
    assert check_moneyness("ATM-10", near_expiry_index=True) == -10
    with pytest.raises(ProviderError):
        check_moneyness("ATM+4", near_expiry_index=False)
    assert moneyness_labels(1) == ["ATM-1", "ATM", "ATM+1"]


def test_date_windows_respect_limits():
    w = date_windows(date(2025, 1, 1), date(2025, 3, 1), 30)
    assert w[0] == (date(2025, 1, 1), date(2025, 1, 31))
    assert w[-1][1] == date(2025, 3, 1)
    assert all((b - a).days <= 30 for a, b in w)


def test_requests_are_chunked_archived_and_secret_free(tmp_path):
    bodies = []

    def handler(request: httpx.Request):
        bodies.append(request)
        return httpx.Response(200, json={"data": {"ce": {"timestamp": [], "open": []}, "pe": None}})

    http = httpx.Client(base_url="https://api.dhan.co/v2", transport=httpx.MockTransport(handler))
    p = DhanProvider("CLIENT", "SECRET-TOKEN-123", tmp_path, requests_per_second=0, http=http)
    p.expired_option_candles(_request(start=date(2025, 1, 1), end=date(2025, 3, 1)))
    assert len(bodies) == 2  # 59 days -> two 30-day windows
    assert bodies[0].headers["access-token"] == "SECRET-TOKEN-123"
    archived = list((tmp_path / "dhan").glob("**/*.json"))
    assert len(archived) == 2
    assert all("SECRET-TOKEN-123" not in a.read_text() for a in archived)


def test_missing_token_is_an_error(tmp_path):
    with pytest.raises(ProviderError):
        DhanProvider("CLIENT", "", tmp_path)
