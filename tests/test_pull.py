"""Resumable pull tests. Payloads are hand-written fixtures shaped like Dhan's response, not market data."""

import json
from datetime import date, datetime

import httpx

from straddloop.data import store
from straddloop.data.providers.dhan import DhanProvider
from straddloop.data.pull import marker_path, pull_options
from straddloop.timeutil import IST

HOLIDAY = date(2025, 10, 2)


def _handler(calls):
    def handler(request: httpx.Request):
        body = json.loads(request.content)
        calls.append(body)
        day = date.fromisoformat(body["fromDate"])
        assert body["fromDate"] == body["toDate"]
        if day == HOLIDAY:
            return httpx.Response(200, json={"data": {"ce": {}, "pe": None}})
        label = body["strike"]
        off = 0 if label == "ATM" else int(label[3:])
        t0 = int(datetime.combine(day, datetime.min.time().replace(hour=9, minute=15), IST).timestamp())
        n = 3
        block = {"timestamp": [t0 + 60 * i for i in range(n)], "open": [10.0] * n, "high": [11.0] * n,
                 "low": [9.0] * n, "close": [10.5] * n, "volume": [1] * n, "oi": [1] * n, "iv": [12.0] * n,
                 "strike": [25000.0 + 50 * off] * n, "spot": [25001.0] * n}
        side = "ce" if body["drvOptionType"] == "CALL" else "pe"
        return httpx.Response(200, json={"data": {side: block, "ce" if side == "pe" else "pe": None}})
    return handler


def test_every_series_of_a_day_survives_and_reruns_resume(tmp_path):
    calls: list = []
    http = httpx.Client(base_url="https://api.dhan.co/v2", transport=httpx.MockTransport(_handler(calls)))
    p = DhanProvider("C", "T", tmp_path / "raw", requests_per_second=0, http=http)
    s = pull_options(p, tmp_path / "store", "NIFTY", date(2025, 10, 1), date(2025, 10, 4), 1, "WEEK", 1, 1)
    assert len(calls) == 3 * 6  # 3 weekdays x (ATM-1, ATM, ATM+1) x CE/PE
    assert s.days_fetched == [date(2025, 10, 1), date(2025, 10, 3)] and s.holidays == [HOLIDAY]

    t = store.query(tmp_path / "store", "option_candles")
    series = {(r["ts"].date(), r["option_type"], r["moneyness"]) for r in t.to_pylist()}
    assert len(series) == 2 * 6  # nothing overwritten by the next series written for the same day

    calls.clear()
    s = pull_options(p, tmp_path / "store", "NIFTY", date(2025, 10, 1), date(2025, 10, 4), 1, "WEEK", 1, 1)
    assert calls == [] and len(s.days_skipped) == 2 and s.holidays == [HOLIDAY]

    # A wider window than the one a day was pulled with fetches that day again.
    s = pull_options(p, tmp_path / "store", "NIFTY", date(2025, 10, 1), date(2025, 10, 2), 2, "WEEK", 1, 1)
    assert len(calls) == 10 and s.days_fetched == [date(2025, 10, 1)]
    marker = marker_path(tmp_path / "store", "NIFTY", "WEEK", 1, 1, date(2025, 10, 1))
    assert json.loads(marker.read_text())["window"] == 2


def test_weekly_and_monthly_pulls_do_not_overwrite_each_other(tmp_path):
    calls: list = []
    http = httpx.Client(base_url="https://api.dhan.co/v2", transport=httpx.MockTransport(_handler(calls)))
    p = DhanProvider("C", "T", tmp_path / "raw", requests_per_second=0, http=http)
    for flag in ("WEEK", "MONTH"):
        pull_options(p, tmp_path / "store", "NIFTY", date(2025, 10, 1), date(2025, 10, 2), 0, flag, 1, 1)
    t = store.query(tmp_path / "store", "option_candles")
    assert set(t["expiry_flag"].to_pylist()) == {"WEEK", "MONTH"}
