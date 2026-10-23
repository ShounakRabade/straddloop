"""Validation, storage and coverage tests on hand-made candles (test fixtures, not market data)."""

from datetime import date, datetime, timedelta

from straddloop.data import store
from straddloop.data.coverage import build_report, to_markdown
from straddloop.data.schema import OptionCandle, UnderlyingCandle
from straddloop.data.validate import fixed_contract_coverage, option_series_quality, validate_candles
from straddloop.timeutil import IST

D = date(2025, 9, 1)


def _u(minute, o=100.0, h=101.0, low=99.0, c=100.5):
    ts = datetime(D.year, D.month, D.day, 9, 15, tzinfo=IST) + timedelta(minutes=minute)
    return UnderlyingCandle(ts, "NIFTY", 1, o, h, low, c, None, "test")


def _o(minute, strike, close=10.0, volume=10.0):
    ts = datetime(D.year, D.month, D.day, 9, 15, tzinfo=IST) + timedelta(minutes=minute)
    return OptionCandle(ts, "NIFTY", 1, "CE", strike, "ATM", "WEEK", 1, None,
                        close, close, close, close, volume, 1.0, None, 100.0, "test")


def test_validation_drops_impossible_rows_and_measures_gaps():
    candles = [_u(m) for m in range(375)]
    candles.append(_u(5))  # duplicate
    candles.append(_u(10, h=90.0))  # high below open: impossible (also a duplicate timestamp)
    candles.append(_u(-1))  # 09:14, before the session
    del candles[100:110]  # ten missing minutes
    v = validate_candles(candles)
    assert v.dropped["duplicate"] == 2
    assert v.dropped["outside_session"] == 1
    assert v.sessions[D] == 365
    assert v.missing_pct() == round(100 * 10 / 375, 3)
    assert v.label_convention == "start"


def test_bad_ohlc_dropped():
    v = validate_candles([_u(0, h=90.0)])
    assert v.dropped["bad_ohlc"] == 1


def test_strike_drift_and_fixed_contract_coverage():
    candles = [_o(m, 24700.0) for m in range(200)] + [_o(m, 24750.0) for m in range(200, 375)]
    q = option_series_quality(candles)
    assert q.strike_changes == 1
    cov = fixed_contract_coverage(candles)
    assert cov[(D, 24700.0, "CE")] == 200  # this contract left the ATM label mid-session


def test_stale_bars_counted():
    candles = [_o(0, 24700.0, 10.0, 5.0), _o(1, 24700.0, 10.0, 0.0), _o(2, 24700.0, 10.0, 0.0)]
    assert option_series_quality(candles).stale_bars == 2


def test_store_round_trip_and_stable_hash(tmp_path):
    rows = [_u(m) for m in range(5)]
    store.write_records(tmp_path, "underlying_candles", rows, UnderlyingCandle)
    h1 = store.dataset_hash(tmp_path, "underlying_candles")
    store.write_records(tmp_path, "underlying_candles", rows, UnderlyingCandle)  # idempotent rewrite
    assert store.dataset_hash(tmp_path, "underlying_candles") == h1
    table = store.query(tmp_path, "underlying_candles")
    assert table.num_rows == 5


def test_empty_store_report_claims_nothing(tmp_path):
    report = build_report(tmp_path)
    assert report["underlying"] == {} and report["options"] == {}
    assert "store is empty" in to_markdown(report)


def test_report_flags_unresolved_expiries(tmp_path):
    store.write_records(tmp_path, "option_candles", [_o(m, 24700.0) for m in range(375)], OptionCandle)
    report = build_report(tmp_path)
    series = report["options"]["NIFTY WEEK code 1"]
    assert series["fixed_contracts_full_session_pct"] == 100.0
    assert series["expiry_dates_resolved"] is False
    assert any("relative expiry code" in x for x in report["known_limitations"])
