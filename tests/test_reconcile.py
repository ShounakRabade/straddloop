"""Reconciliation of Dhan candles against the bhavcopy, and day files picking up real expiry/lot."""

import gzip
import json
from datetime import date

from straddloop.data.dayfiles import StoreReader, build_day
from straddloop.data.pull import ensure_range
from straddloop.data.reconcile import reconcile_day
from straddloop.reference.bhav_pipeline import import_files
from straddloop.reference.contract_master import ContractMaster
from tests.fakes import FakeDhan
from tests.test_bhav_pipeline import ud_row, ud_text

DAY = date(2025, 10, 6)


def _setup(tmp_path, **bhav):
    store_dir = tmp_path / "store"
    ensure_range(FakeDhan().provider(tmp_path), store_dir, "NIFTY", DAY, DAY, window=1)
    rows = []
    for k in (24950, 25000, 25050):
        for cp in ("CE", "PE"):
            rows.append(ud_row(k=k, cp=cp, **{"o": 10, "h": 11, "lo": 9, "c": 10.5, "oi": 100, "vol": 375, **bhav}))
    f = tmp_path / "b.csv"
    f.write_text(ud_text(*rows))
    import_files([f], store_dir, tmp_path / "raw", None)
    return store_dir


def test_matching_sources_pass(tmp_path):
    r = reconcile_day(_setup(tmp_path), "NIFTY", DAY)
    assert r.status == "PASS" and r.expiry == date(2025, 10, 7) and r.contracts_compared == 6
    assert r.checks["high_checked"] == 6 and r.checks["oi_mismatch"] == 0 and r.volume_ratio_median == 1.0


def test_dhan_high_above_the_exchange_high_fails(tmp_path):
    r = reconcile_day(_setup(tmp_path, h=10, o=9.9, c=9.8), "NIFTY", DAY)  # Dhan saw 11, exchange high was 10
    assert r.status == "WARN" and r.mismatches[0]["check"] == "high"


def test_oi_disagreement_is_listed_but_does_not_change_the_outcome(tmp_path):
    r = reconcile_day(_setup(tmp_path, oi=150), "NIFTY", DAY)
    assert r.status == "PASS" and {m["check"] for m in r.mismatches} == {"oi"}

def test_a_small_price_difference_within_five_percent_passes(tmp_path):
    r = reconcile_day(_setup(tmp_path, h=10.6), "NIFTY", DAY)  # 0.4 apart on a 10.6 high: inside 5%
    assert r.status == "PASS" and not r.mismatches


def test_strikes_dhan_has_but_nse_lacks_are_counted_not_ignored(tmp_path):
    store_dir = tmp_path / "store"
    ensure_range(FakeDhan().provider(tmp_path), store_dir, "NIFTY", DAY, DAY, window=1)
    f = tmp_path / "b.csv"
    f.write_text(ud_text(ud_row(k=25000, cp="CE", o=10, h=11, lo=9, c=10.5, oi=100)))
    import_files([f], store_dir, tmp_path / "raw", None)
    r = reconcile_day(store_dir, "NIFTY", DAY)
    assert r.contracts_compared == 1 and r.dhan_only == 5 and r.status == "WARN"


def test_no_bhavcopy_is_not_a_pass(tmp_path):
    store_dir = tmp_path / "store"
    ensure_range(FakeDhan().provider(tmp_path), store_dir, "NIFTY", DAY, DAY, window=1)
    r = reconcile_day(store_dir, "NIFTY", DAY)
    assert r.status == "NO_REFERENCE" and "bhavcopy" in r.note


def test_wrong_expiry_is_caught(tmp_path):
    store_dir = tmp_path / "store"
    ensure_range(FakeDhan().provider(tmp_path), store_dir, "NIFTY", DAY, DAY, window=1)
    f = tmp_path / "b.csv"  # exchange lists strikes only for a different expiry than the one resolved
    f.write_text(ud_text(ud_row(k=26000, exp="2025-10-07"), ud_row(k=25000, exp="2025-10-14")))
    import_files([f], store_dir, tmp_path / "raw", None)
    r = reconcile_day(store_dir, "NIFTY", DAY)
    assert r.status == "FAIL" and "wrong expiry" in r.note


def test_day_file_uses_bhavcopy_expiry_and_lot_when_available(tmp_path):
    store_dir = _setup(tmp_path, lot=65)
    reader = StoreReader(store_dir)
    args = ("NIFTY", "WEEK", DAY, reader.options(DAY, "NIFTY", "WEEK"), reader.index(DAY, "NIFTY"))
    doc = json.loads(gzip.decompress(build_day(*args, master=ContractMaster(store_dir)).blob))
    assert doc["expiry"] == "2025-10-07" and doc["lot_size"] == 65
    assert doc["expiry_source"].startswith("nse_bhavcopy") and doc["lot_source"].startswith("nse_bhavcopy")
    plain = json.loads(gzip.decompress(build_day(*args).blob))
    assert plain["lot_size"] == 75 and plain["lot_source"].startswith("assumed")  # without bhavcopy: labelled
