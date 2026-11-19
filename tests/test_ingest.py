"""Ingestion ledger, availability states, validation-before-insert, resume and failure recovery."""

from datetime import date

import pytest

from straddloop.data import store
from straddloop.data.availability import availability, index_key, needs_fetch, option_key, summarize, usable_days
from straddloop.data.ledger import Ledger
from straddloop.data.providers.base import AuthError
from straddloop.data.pull import RunAborted, ensure_range, judge_day, pull_options
from tests.fakes import FakeDhan

MON, TUE, WED, THU, FRI = (date(2025, 10, d) for d in (6, 7, 8, 9, 10))
KEY = option_key("NIFTY", "WEEK", 1, 1)


def _fill(tmp_path, fake, start=MON, end=FRI, **kw):
    return ensure_range(fake.provider(tmp_path), tmp_path / "store", "NIFTY", start, end, window=1, **kw)


def _states(tmp_path, start=MON, end=date(2025, 10, 11), window=1):
    ledger = Ledger(tmp_path / "store")
    try:
        return availability(ledger, "option_candles", KEY, start, end, window)
    finally:
        ledger.close()


def test_a_complete_day_is_validated_and_written_once(tmp_path):
    fake = FakeDhan()
    s = _fill(tmp_path, fake, MON, MON)
    assert s.days_fetched == [MON] and not s.days_partial
    st = _states(tmp_path)[0]
    assert (st.day, st.state, st.rows) == (MON, "validated", 6 * 375)
    n_calls = len(fake.calls)
    s = _fill(tmp_path, fake, MON, MON)  # second run: nothing to fetch, nothing called
    assert len(fake.calls) == n_calls and s.days_skipped == [MON]


def test_only_missing_days_are_fetched_incrementally(tmp_path):
    fake = FakeDhan()
    _fill(tmp_path, fake, MON, TUE)
    fake.calls.clear()
    _fill(tmp_path, fake, MON, THU)
    opt_days = {b["fromDate"] for p, b in fake.calls if "rollingoption" in p}
    assert opt_days == {"2025-10-08", "2025-10-09"}  # Mon/Tue not asked for again


def test_missing_candles_make_a_day_partial_never_filled(tmp_path):
    fake = FakeDhan(bars=200)  # a session cut short: 200 of 375 bars on every series
    _fill(tmp_path, fake, MON, MON)
    st = _states(tmp_path)[0]
    assert st.state == "partial" and "ATM CE has 200 of 375" in st.reason
    t = store.query(tmp_path / "store", "option_candles")
    assert t.num_rows == 6 * 200  # exactly what the API gave, no invented bars
    assert usable_days(_states(tmp_path)) == [] and usable_days(_states(tmp_path), allow_partial=True) == [MON]


def test_holiday_needs_both_feeds_empty(tmp_path):
    fake = FakeDhan(holidays=[WED])
    _fill(tmp_path, fake, TUE, THU)
    by = {s.day: s for s in _states(tmp_path, TUE, FRI)}
    assert by[WED].state == "holiday" and by[WED].confirmed
    # index shows a session but options come back empty: that is a failure, never a holiday
    fake2 = FakeDhan(options_empty_days=[FRI])
    _fill(tmp_path, fake2, FRI, FRI)
    st = {s.day: s for s in _states(tmp_path, FRI, date(2025, 10, 11))}[FRI]
    assert st.state == "failed" and "index shows a session" in st.reason


def test_weekend_is_not_expected_unless_proven(tmp_path):
    fake = FakeDhan()
    _fill(tmp_path, fake, FRI, FRI)
    states = _states(tmp_path, FRI, date(2025, 10, 14))
    assert [s.day for s in states] == [FRI, date(2025, 10, 13)]  # Sat/Sun are not "missing"


def test_judge_day_unit():
    full = {("CE", "ATM"): 375, ("PE", "ATM"): 375}
    assert judge_day("validated", 375, full, 0).status == "validated"
    assert judge_day(None, 0, full, 0).status == "partial"  # index never fetched is stated, not hidden
    assert judge_day("validated", 375, {}, 1).status == "failed"
    assert judge_day("holiday", 0, {}, 1).status == "holiday"
    assert not judge_day(None, 0, {}, 1).confirmed


def test_failed_day_is_recorded_and_retried_next_run(tmp_path):
    fake = FakeDhan(fail_days=[TUE])
    s = _fill(tmp_path, fake, MON, WED)
    assert s.days_failed == [TUE] and MON in s.days_fetched and WED in s.days_fetched
    st = {x.day: x for x in _states(tmp_path)}
    assert st[TUE].state == "failed" and "gave up" in st[TUE].reason
    assert needs_fetch(list(st.values())) == [TUE, THU, FRI]  # failed + never attempted, not the good days
    fake.fail_days.clear()
    fake.calls.clear()
    _fill(tmp_path, fake, MON, WED)
    assert {b["fromDate"] for p, b in fake.calls if "rollingoption" in p} == {"2025-10-07"}
    assert {x.day: x.state for x in _states(tmp_path)}[TUE] == "validated"


def test_three_failures_in_a_row_stop_the_run(tmp_path):
    fake = FakeDhan(fail_days=[MON, TUE, WED])
    with pytest.raises(RunAborted):
        _fill(tmp_path, fake, MON, FRI)
    assert {s.day: s.state for s in _states(tmp_path)}[THU] == "missing"  # not reached


def test_auth_error_stops_cleanly_and_the_run_resumes(tmp_path):
    fake = FakeDhan(auth_fail_after=1 + 6 + 1 + 3)  # index call, Mon's 6 calls, then token "expires" on Tue
    with pytest.raises(AuthError, match="access token"):
        _fill(tmp_path, fake, MON, WED)
    by = {s.day: s.state for s in _states(tmp_path, MON, THU)}
    assert by[MON] == "validated" and by[TUE] == "missing" and by[WED] == "missing"  # nothing marked failed
    assert Ledger(tmp_path / "store").con.execute("SELECT count(*) FROM day_status WHERE status='downloading'"
                                                  ).fetchone()[0] == 0
    fake.auth_fail_after = None  # token renewed
    _fill(tmp_path, fake, MON, WED)
    assert {s.day: s.state for s in _states(tmp_path, MON, THU)} == {MON: "validated", TUE: "validated",
                                                                      WED: "validated"}


def test_crash_mid_day_leaves_the_day_missing_and_no_partial_file(tmp_path):
    fake = FakeDhan()
    boom = {"n": 0}
    real = fake.handler

    def crashing(request):
        boom["n"] += 1
        if boom["n"] == 1 + 4:  # index call, then die in the middle of Monday's option calls
            raise KeyboardInterrupt
        return real(request)

    fake.handler = crashing
    with pytest.raises(KeyboardInterrupt):
        _fill(tmp_path, fake, MON, MON)
    assert store.query(tmp_path / "store", "option_candles") is None  # nothing written
    assert [s.state for s in _states(tmp_path, MON, TUE)] == ["downloading"]  # ledger says in-flight
    fake.handler = real
    _fill(tmp_path, fake, MON, MON)  # next run resets the stale row and fetches the whole day again
    assert [s.state for s in _states(tmp_path, MON, TUE)] == ["validated"]


def test_rewriting_a_day_never_duplicates_records(tmp_path):
    fake = FakeDhan()
    _fill(tmp_path, fake, MON, MON)
    _fill(tmp_path, fake, MON, MON, refetch=True)
    n, _ = store.duplicate_keys(tmp_path / "store", "option_candles")
    assert n == 0 and store.query(tmp_path / "store", "option_candles").num_rows == 6 * 375


def test_store_check_finds_a_day_written_under_two_layouts(tmp_path):
    fake = FakeDhan()
    _fill(tmp_path, fake, MON, MON)
    src = next((tmp_path / "store" / "option_candles").glob("**/part.parquet"))
    twin = src.parents[3] / "source=other" / "underlying=NIFTY" / src.parents[1].name / src.parents[0].name
    twin.mkdir(parents=True)
    (twin / "part.parquet").write_bytes(src.read_bytes())
    n, ex = store.duplicate_keys(tmp_path / "store", "option_candles")
    assert n == 6 * 375 and ex


def test_a_torn_write_cannot_replace_the_good_file(tmp_path, monkeypatch):
    fake = FakeDhan()
    _fill(tmp_path, fake, MON, MON)
    path = next((tmp_path / "store" / "option_candles").glob("**/part.parquet"))
    before = path.read_bytes()

    def torn(table, p):
        open(p, "wb").write(b"PAR1-torn")
        raise OSError("disk full")

    monkeypatch.setattr(store.pq, "write_table", torn)
    with pytest.raises(OSError):
        _fill(tmp_path, fake, MON, MON, refetch=True)
    assert path.read_bytes() == before and not list(path.parent.glob("*.tmp"))


def test_a_wider_window_is_fetched_again_but_narrower_is_not(tmp_path):
    fake = FakeDhan()
    ensure_range(fake.provider(tmp_path), tmp_path / "store", "NIFTY", MON, MON, window=1)
    assert _states(tmp_path, window=2)[0].state == "missing"
    assert _states(tmp_path, window=0)[0].state == "validated"


def test_legacy_markers_are_adopted_and_rejudged_from_stored_rows(tmp_path):
    fake = FakeDhan()
    p = fake.provider(tmp_path)
    pull_options(p, tmp_path / "store", "NIFTY", MON, TUE, 1, "WEEK", 1, 1)
    (tmp_path / "store" / "ledger.sqlite").unlink()
    for ext in ("-wal", "-shm"):
        (tmp_path / "store" / f"ledger.sqlite{ext}").unlink(missing_ok=True)
    from straddloop.data.migrate import adopt_legacy

    ledger = Ledger(tmp_path / "store")
    assert adopt_legacy(tmp_path / "store", ledger) == 1
    row = ledger.get_day("option_candles", KEY, MON)
    assert row["status"] == "partial" and "index" in row["detail"]  # no index in this store: stated, not assumed
    assert summarize(availability(ledger, "option_candles", KEY, MON, TUE, 1))["partial"] == 1
    assert ledger.get_day("underlying_candles", index_key("NIFTY", 1), MON) is None
    ledger.close()


def test_ingest_log_records_every_outcome_with_source(tmp_path):
    fake = FakeDhan(fail_days=[TUE])
    _fill(tmp_path, fake, MON, TUE)
    ledger = Ledger(tmp_path / "store")
    rows = ledger.log_rows()
    ledger.close()
    assert {(r["status"], r["source"]) for r in rows if r["dataset"] == "option_candles"} == {
        ("validated", "dhan"), ("failed", "dhan")}
    assert all(r["schema_version"] == 1 for r in rows)
