"""Dhan transport: auth handling, retry with backoff, response validation. Fixtures only, no live calls."""

import httpx
import pytest

from straddloop.data.providers.base import AuthError, ProviderError
from straddloop.data.providers.dhan import DhanProvider

BODY = {"x": 1}


def _provider(tmp_path, responses, sleeps):
    it = iter(responses)

    def handler(request):
        r = next(it)
        if isinstance(r, Exception):
            raise r
        return r

    http = httpx.Client(base_url="https://api.dhan.co/v2", transport=httpx.MockTransport(handler))
    return DhanProvider("C", "SECRET-TOKEN", tmp_path, requests_per_second=0, http=http, sleep=sleeps.append,
                        max_attempts=4)


def test_retries_rate_limit_with_growing_backoff_then_succeeds(tmp_path):
    sleeps = []
    p = _provider(tmp_path, [httpx.Response(429, json={"errorCode": "DH-904"})] * 2 + [httpx.Response(200, json={"a": 1})],
                  sleeps)
    assert p._post("/charts/intraday", BODY) == {"a": 1}
    assert len(sleeps) == 2 and sleeps[1] > sleeps[0] * 0.9 and 1 <= sleeps[0] <= 2 and 2 <= sleeps[1] <= 4


def test_retry_after_header_is_honoured(tmp_path):
    sleeps = []
    p = _provider(tmp_path, [httpx.Response(429, headers={"retry-after": "7"}), httpx.Response(200, json={})], sleeps)
    p._post("/x", BODY)
    assert sleeps == [7.0]


def test_network_errors_are_retried_and_nothing_is_archived_until_success(tmp_path):
    sleeps = []
    p = _provider(tmp_path, [httpx.ConnectError("down"), httpx.ReadTimeout("slow"), httpx.Response(200, json={"ok": 1})],
                  sleeps)
    assert p._post("/charts/intraday", BODY) == {"ok": 1}
    assert len(sleeps) == 2 and len(list((tmp_path / "dhan").glob("**/*.json"))) == 1
    assert not list((tmp_path / "dhan").glob("**/*.tmp"))


def test_gives_up_after_max_attempts_with_a_clear_error(tmp_path):
    p = _provider(tmp_path, [httpx.Response(500)] * 4, [])
    with pytest.raises(ProviderError, match="gave up after 4 attempts"):
        p._post("/x", BODY)
    assert not (tmp_path / "dhan").exists() or not list((tmp_path / "dhan").glob("**/*.json"))


@pytest.mark.parametrize("status,code", [(401, "DH-901"), (403, "DH-902"), (200, "DH-901")])
def test_auth_failures_stop_immediately_and_never_leak_the_token(tmp_path, status, code):
    sleeps = []
    p = _provider(tmp_path, [httpx.Response(status, json={"errorCode": code})], sleeps)
    with pytest.raises(AuthError) as exc:
        p._post("/x", BODY)
    assert sleeps == [] and "SECRET-TOKEN" not in str(exc.value) and "DHAN_ACCESS_TOKEN" in str(exc.value)


def test_bad_input_is_not_retried(tmp_path):
    sleeps = []
    p = _provider(tmp_path, [httpx.Response(400, json={"errorCode": "DH-905"})], sleeps)
    with pytest.raises(ProviderError, match="400"):
        p._post("/x", BODY)
    assert sleeps == []


@pytest.mark.parametrize("payload", [[1, 2], {"errorCode": "DH-907"}, {"status": "failure"}])
def test_unexpected_200_bodies_are_rejected(tmp_path, payload):
    p = _provider(tmp_path, [httpx.Response(200, json=payload)], [])
    with pytest.raises(ProviderError):
        p._post("/x", BODY)


def test_not_json_is_rejected(tmp_path):
    p = _provider(tmp_path, [httpx.Response(200, text="<html>")], [])
    with pytest.raises(ProviderError, match="not JSON"):
        p._post("/x", BODY)


def test_payload_validation_rejects_bad_series(tmp_path):
    from straddloop.data.providers.dhan import parse_intraday

    base = {"open": [1, 1], "high": [1, 1], "low": [1, 1], "close": [1, 1], "volume": [0, 0]}
    with pytest.raises(ProviderError, match="ascending"):
        parse_intraday({**base, "timestamp": [100, 100]}, "NIFTY", 1)
    with pytest.raises(ProviderError, match="non-numeric"):
        parse_intraday({**base, "timestamp": [100, "x"]}, "NIFTY", 1)
    with pytest.raises(ProviderError, match="null"):
        parse_intraday({**base, "open": [1, None], "timestamp": [100, 160]}, "NIFTY", 1)
    with pytest.raises(ProviderError):
        parse_intraday({"data": [1]}, "NIFTY", 1)


def test_profile_returns_expiry_fields_but_not_the_token(tmp_path):
    p = _provider(tmp_path, [httpx.Response(200, json={"dhanClientId": "1", "tokenValidity": "20/11/2026 10:00",
                                                       "dataPlan": "Active", "extra": "SECRET-TOKEN"})], [])
    info = p.profile()
    assert info["tokenValidity"] == "20/11/2026 10:00" and "SECRET-TOKEN" not in str(info)
