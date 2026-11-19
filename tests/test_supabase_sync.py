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
