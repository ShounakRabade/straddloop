import json
from datetime import date

import httpx
import pytest

from straddloop.data.dayfiles import DayFile
from straddloop.data.supabase_sync import SupabaseError, SupabaseSync

KEY = "sb_secret_TESTKEY123"


def _day():
    doc = {"expiry": "2025-10-07", "expiry_source": "assumed", "lot_size": 75, "lot_source": "assumed"}
    return DayFile("NIFTY", "WEEK", date(2025, 10, 6), doc, b"\x1f\x8b...", "abc", 42, 15750, 375, 0)


def test_upload_sends_file_and_row_without_bearer_for_new_keys():
    seen = []

    def handler(req: httpx.Request):
        seen.append(req)
        if req.method == "GET":
            return httpx.Response(200, json=[{"trade_date": "2025-10-06", "sha256": "abc"}])
        return httpx.Response(201, json={})

    sync = SupabaseSync("abcd.supabase.co/", KEY, httpx.Client(transport=httpx.MockTransport(handler)))
    assert sync.existing("NIFTY", "WEEK", date(2025, 10, 1), date(2025, 10, 31)) == {"2025-10-06": "abc"}
    sync.upload(_day())
    put, row = seen[1], seen[2]
    assert str(put.url) == "https://abcd.supabase.co/storage/v1/object/market-data/NIFTY/WEEK/2025-10-06.json.gz"
    assert put.headers["apikey"] == KEY and "authorization" not in put.headers and put.headers["x-upsert"] == "true"
    body = json.loads(row.content)[0]
    assert body["path"] == "NIFTY/WEEK/2025-10-06.json.gz" and body["quality"] == "complete" and body["series"] == 42
    assert "merge-duplicates" in row.headers["prefer"]


def test_errors_never_contain_the_key():
    def handler(req):
        return httpx.Response(401, text=f"bad key {KEY}")

    sync = SupabaseSync("https://abcd.supabase.co", KEY, httpx.Client(transport=httpx.MockTransport(handler)))
    with pytest.raises(SupabaseError) as exc:
        sync.upload(_day())
    assert KEY not in str(exc.value) and "***" in str(exc.value)


def test_missing_settings_are_explained():
    with pytest.raises(SupabaseError, match="SUPABASE_URL"):
        SupabaseSync("", "")


def test_load_pulls_then_uploads_with_an_inclusive_end(monkeypatch, tmp_path):
    import argparse
    from types import SimpleNamespace

    from straddloop.data import pull, upload_cli

    order = []
    monkeypatch.setattr(pull, "ensure_range", lambda *a, **k: (order.append(("fill", a[3], a[4], a[6]))
                        or SimpleNamespace(days_fetched=[1], days_skipped=[], holidays=[], days_partial=[],
                                           days_failed=[])))
    monkeypatch.setattr(upload_cli, "cmd_supabase_upload", lambda args, settings: order.append("upload") or 0)
    settings = SimpleNamespace(has_dhan_credentials=True, dhan_client_id="1", dhan_access_token="t",
                               raw_dir=tmp_path, store_dir=tmp_path, dhan_requests_per_second=0)
    args = argparse.Namespace(underlying="NIFTY", expiry="WEEK", start="2025-10-06", end="2025-10-17", window=10)
    assert upload_cli.cmd_load(args, settings) == 0
    assert order == [("fill", date(2025, 10, 6), date(2025, 10, 17), "WEEK"), "upload"]  # end stays inclusive
    settings.has_dhan_credentials = False
    assert upload_cli.cmd_load(args, settings) == 1


def test_ledger_statuses_become_publishable_rows(tmp_path):
    from types import SimpleNamespace

    from straddloop.data.availability import option_key
    from straddloop.data.ledger import Ledger
    from straddloop.data.upload_cli import ledger_status_rows

    ledger = Ledger(tmp_path)
    key = option_key("NIFTY", "WEEK", 1, 1)
    ledger.set_day("option_candles", key, date(2025, 10, 6), "partial", rows=10, source="dhan",
                   detail={"reasons": ["ATM CE has 200 of 375 bars"]})
    ledger.set_day("option_candles", key, date(2025, 10, 7), "failed", source="dhan", detail={"reasons": ["boom"]})
    ledger.close()
    rows = ledger_status_rows(SimpleNamespace(store_dir=tmp_path), "NIFTY", "WEEK", date(2025, 10, 1), date(2025, 10, 31))
    assert [(r["trade_date"], r["status"], r["reason"]) for r in rows] == [
        ("2025-10-06", "partial", "ATM CE has 200 of 375 bars"), ("2025-10-07", "failed", "boom")]
