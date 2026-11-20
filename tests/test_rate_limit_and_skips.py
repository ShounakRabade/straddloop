"""Rate limits wait in minutes (no pause between normal requests), and a failed day is listed and skipped
rather than stopping the run."""

from datetime import date

import httpx
import pytest

from straddloop.data.providers.base import ProviderError
from straddloop.data.providers.dhan import DhanProvider
from straddloop.data.pull import ensure_range, failed_days_report
from tests.fakes import FakeDhan

MON, TUE, WED, THU, FRI = (date(2025, 10, d) for d in (6, 7, 8, 9, 10))
BODY = {"fromDate": "2025-10-06", "toDate": "2025-10-06", "strike": "ATM"}
EMPTY_OK = {"data": {"ce": None, "pe": None}}


def _rate_limited(**headers):
    return httpx.Response(429, headers=headers, json={"errorCode": "DH-904", "errorMessage": "Too many requests"})


def _dhan(tmp_path, responses):
    """A provider whose transport serves `responses` in order (the last one repeats). Waits are recorded,
    not slept."""
    sleeps, calls, queue = [], [], list(responses)

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return queue.pop(0) if len(queue) > 1 else queue[0]

    http = httpx.Client(base_url="https://api.dhan.co/v2", transport=httpx.MockTransport(handler))
    provider = DhanProvider("C", "T", tmp_path / "raw", requests_per_second=0, http=http, sleep=sleeps.append)
    return provider, sleeps, calls


def test_a_rate_limit_waits_minutes_then_succeeds(tmp_path):
    provider, sleeps, calls = _dhan(tmp_path, [_rate_limited(), _rate_limited(), _rate_limited(),
                                               httpx.Response(200, json=EMPTY_OK)])
    assert provider._request("POST", "/charts/rollingoption", BODY) == EMPTY_OK
    assert len(calls) == 4
    assert sleeps == [60.0, 120.0, 240.0]  # minutes, not seconds


def test_a_longer_retry_after_from_the_server_is_honoured(tmp_path):
    provider, sleeps, _ = _dhan(tmp_path, [_rate_limited(**{"retry-after": "300"}),
                                           httpx.Response(200, json=EMPTY_OK)])
    provider._request("POST", "/charts/rollingoption", BODY)
    assert sleeps == [300.0]


def test_a_rate_limit_that_never_clears_gives_up_without_a_final_wait(tmp_path):
    provider, sleeps, calls = _dhan(tmp_path, [_rate_limited()])
    with pytest.raises(ProviderError, match="gave up after 6 attempts"):
        provider._request("POST", "/charts/rollingoption", BODY)
    assert len(calls) == 6
    assert sleeps == [60.0, 120.0, 240.0, 480.0, 600.0]  # five waits for six tries; none after the last


def test_a_server_error_keeps_the_short_backoff(tmp_path):
    provider, sleeps, _ = _dhan(tmp_path, [httpx.Response(500, json={"errorCode": "DH-908"}),
                                           httpx.Response(200, json=EMPTY_OK)])
    provider._request("POST", "/charts/rollingoption", BODY)
    assert len(sleeps) == 1 and 1.0 <= sleeps[0] <= 2.0


def test_failed_days_are_skipped_listed_and_retried_by_the_next_run(tmp_path):
    fake = FakeDhan(fail_days=[MON, TUE, WED])
    store = tmp_path / "store"
    s = ensure_range(fake.provider(tmp_path), store, "NIFTY", MON, FRI, window=1)
    assert s.days_failed == [MON, TUE, WED]
    assert s.days_fetched == [THU, FRI]  # the run went on past the failures
    report = failed_days_report(s)
    assert "3 day(s) failed" in report
    for d in ("2025-10-06", "2025-10-07", "2025-10-08"):
        assert f"{d}: " in report
    assert "same command" in report

    fake.fail_days.clear()
    fake.calls.clear()
    s2 = ensure_range(fake.provider(tmp_path), store, "NIFTY", MON, FRI, window=1)
    assert s2.days_fetched == [MON, TUE, WED]  # only the failed days are fetched again
    assert s2.days_skipped == [THU, FRI]
    assert failed_days_report(s2) == ""


def test_no_failures_means_no_report(tmp_path):
    s = ensure_range(FakeDhan().provider(tmp_path), tmp_path / "store", "NIFTY", MON, MON, window=1)
    assert failed_days_report(s) == ""
