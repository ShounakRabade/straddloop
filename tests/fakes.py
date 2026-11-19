"""Fake Dhan transport for pipeline tests. Payloads are hand-written fixtures, not market data."""

from __future__ import annotations

import json
from datetime import date, datetime, timedelta

import httpx

from straddloop.data.providers.dhan import DhanProvider
from straddloop.timeutil import IST


def epoch(day: date, minute: int = 0) -> int:
    return int(datetime.combine(day, datetime.min.time().replace(hour=9, minute=15), IST).timestamp()) + 60 * minute


class FakeDhan:
    """Serves index and option candles. Knobs: `holidays`, `bars` (per series), `fail_days` (HTTP 500 forever),
    `options_empty_days` (index present, options empty), `auth_fail_after` (calls before a 401)."""

    def __init__(self, holidays=(), bars=375, fail_days=(), options_empty_days=(), auth_fail_after=None,
                 index_bars=375):
        self.holidays, self.bars, self.fail_days = set(holidays), bars, set(fail_days)
        self.options_empty_days, self.auth_fail_after, self.index_bars = set(options_empty_days), auth_fail_after, index_bars
        self.calls: list[tuple[str, dict]] = []

    def handler(self, request: httpx.Request) -> httpx.Response:
        if self.auth_fail_after is not None and len(self.calls) >= self.auth_fail_after:
            return httpx.Response(401, json={"errorCode": "DH-901", "errorMessage": "token expired"})
        body = json.loads(request.content)
        path = request.url.path
        self.calls.append((path, body))
        if path.endswith("/charts/intraday"):
            a = date.fromisoformat(body["fromDate"][:10])
            b = date.fromisoformat(body["toDate"][:10])
            stamps, d = [], a
            while d < b:
                if d.weekday() < 5 and d not in self.holidays:
                    stamps += [epoch(d, i) for i in range(self.index_bars)]
                d += timedelta(days=1)
            n = len(stamps)
            return httpx.Response(200, json={"open": [100.0] * n, "high": [101.0] * n, "low": [99.0] * n,
                                             "close": [100.5] * n, "volume": [0] * n, "timestamp": stamps})
        day = date.fromisoformat(body["fromDate"])
        if day in self.fail_days:
            return httpx.Response(500, json={"errorCode": "DH-908"})
        if day in self.holidays or day in self.options_empty_days or day.weekday() >= 5:
            return httpx.Response(200, json={"data": {"ce": {}, "pe": None}})
        label = body["strike"]
        off = 0 if label == "ATM" else int(label[3:])
        n = self.bars
        block = {"timestamp": [epoch(day, i) for i in range(n)], "open": [10.0] * n, "high": [11.0] * n,
                 "low": [9.0] * n, "close": [10.5] * n, "volume": [1] * n, "oi": [100] * n, "iv": [12.0] * n,
                 "strike": [25000.0 + 50 * off] * n, "spot": [25001.0] * n}
        side = "ce" if body["drvOptionType"] == "CALL" else "pe"
        return httpx.Response(200, json={"data": {side: block, ("pe" if side == "ce" else "ce"): None}})

    def provider(self, tmp_path, **kw) -> DhanProvider:
        http = httpx.Client(base_url="https://api.dhan.co/v2", transport=httpx.MockTransport(self.handler))
        return DhanProvider("C", "T", tmp_path / "raw", requests_per_second=0, http=http, sleep=lambda s: None, **kw)
