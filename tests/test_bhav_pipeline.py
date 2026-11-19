"""Bhavcopy: both layouts, validation, schema change, download edge cases, manual import, dedupe, resume.
Files are hand-written fixtures, not NSE data."""

import io
import zipfile
from datetime import date

import httpx
import pytest

from straddloop.data import store
from straddloop.data.ledger import Ledger
from straddloop.reference.bhav_pipeline import (
    NseBlocked,
    NseClient,
    candidate_urls,
    download_range,
    import_files,
)
from straddloop.reference.bhavcopy import BhavcopyFormatError, parse_bhavcopy
from straddloop.reference.contract_master import ContractMaster

UD_HEAD = ("TradDt,BizDt,Sgmt,Src,FinInstrmTp,FinInstrmId,ISIN,TckrSymb,SctySrs,XpryDt,FininstrmActlXpryDt,"
           "StrkPric,OptnTp,FinInstrmNm,OpnPric,HghPric,LwPric,ClsPric,LastPric,PrvsClsgPric,UndrlygPric,"
           "SttlmPric,OpnIntrst,ChngInOpnIntrst,TtlTradgVol,TtlTrfVal,TtlNbOfTxsExctd,SsnId,NewBrdLotQty,Rmks")
LG_HEAD = "INSTRUMENT,SYMBOL,EXPIRY_DT,STRIKE_PR,OPTION_TYP,OPEN,HIGH,LOW,CLOSE,SETTLE_PR,CONTRACTS,VAL_INLAKH,OPEN_INT,CHG_IN_OI,TIMESTAMP,"


def ud_row(day="2025-10-06", sym="NIFTY", exp="2025-10-07", k=25000, cp="CE", o=10, h=12, lo=9, c=11, oi=500,
           chg=-20, vol=7500, lot=75, tp="IDO"):
    return (f"{day},{day},FO,NSE,{tp},1,,{sym},,{exp},{exp},{k},{cp},X,{o},{h},{lo},{c},{c},9,25010,{c},{oi},{chg},"
            f"{vol},1,5,F1,{lot},")


def lg_row(day="06-OCT-2024", sym="NIFTY", exp="10-OCT-2024", k=25000, cp="CE", o=10, h=12, lo=9, c=11, oi=500, chg=5):
    return f"OPTIDX,{sym},{exp},{k},{cp},{o},{h},{lo},{c},{c},100,50,{oi},{chg},{day},"


def zipped(name, text):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr(name, text)
    return buf.getvalue()


def ud_text(*rows):
    return "\n".join([UD_HEAD, *rows]) + "\n"


# ---------------------------------------------------------------- parsing

def test_udiff_captures_every_required_derivative_field(tmp_path):
    f = tmp_path / "b.csv"
    f.write_text(ud_text(ud_row(), ud_row(tp="IDF", cp="", k="")))  # future row ignored
    r = parse_bhavcopy(f)
    assert r.fmt == "udiff" and len(r.rows) == 1 and r.trade_date == date(2025, 10, 6)
    x = r.rows[0]
    assert (x.symbol, x.expiry, x.strike, x.option_type) == ("NIFTY", date(2025, 10, 7), 25000.0, "CE")
    assert (x.open, x.high, x.low, x.close, x.settle) == (10, 12, 9, 11, 11)
    assert (x.volume, x.oi, x.oi_change, x.lot_size) == (7500, 500, -20, 75)


def test_legacy_layout_is_detected_by_header_not_date(tmp_path):
    f = tmp_path / "fo06OCT2024bhav.csv"
    f.write_text("\n".join([LG_HEAD, lg_row(), "FUTIDX,NIFTY,31-OCT-2024,0,XX,1,1,1,1,1,1,1,1,1,06-OCT-2024,"]))
    r = parse_bhavcopy(f)
    assert r.fmt == "legacy" and len(r.rows) == 1
    x = r.rows[0]
    assert x.trade_date == date(2024, 10, 6) and x.expiry == date(2024, 10, 10) and x.lot_size is None
    assert (x.oi, x.oi_change, x.volume) == (500, 5, 100)


def test_zip_and_csv_give_the_same_rows(tmp_path):
    (tmp_path / "a.csv").write_text(ud_text(ud_row()))
    (tmp_path / "a.zip").write_bytes(zipped("a.csv", ud_text(ud_row())))
    assert parse_bhavcopy(tmp_path / "a.csv").rows == parse_bhavcopy(tmp_path / "a.zip").rows


def test_bad_rows_are_dropped_and_counted_not_repaired(tmp_path):
    f = tmp_path / "b.csv"
    f.write_text(ud_text(
        ud_row(k=25000), ud_row(k=25000),                      # duplicate of the first
        ud_row(k=25050, h=5, lo=9),                            # high below low
        ud_row(k=25100, c=-1),                                 # negative price
        ud_row(k=25150, exp="2025-10-01"),                     # expired before the trade date
        ud_row(k=25200, oi=-5),                                # negative OI
        ud_row(k="x"),                                         # unparseable
        ud_row(k=25250, c=20, h=12),                           # close outside the day's range
        ud_row(k=25300)))
    r = parse_bhavcopy(f)
    assert [x.strike for x in r.rows] == [25000.0, 25300.0]
    assert dict(r.dropped) == {"duplicate_in_file": 1, "high_below_low": 1, "negative_price": 1,
                               "expired_before_trade_date": 1, "negative_quantity": 1, "unparseable_row": 1,
                               "close_outside_range": 1}


def test_changed_schema_is_rejected_naming_the_columns(tmp_path):
    f = tmp_path / "new.csv"
    f.write_text("TradDt,Symbol,Expiry,Strike\n2025-10-06,NIFTY,2025-10-07,25000\n")
    with pytest.raises(BhavcopyFormatError, match="Columns found"):
        parse_bhavcopy(f)


def test_truncated_zip_and_mixed_dates_are_rejected(tmp_path):
    z = zipped("a.csv", ud_text(ud_row()))
    (tmp_path / "t.zip").write_bytes(z[: len(z) // 2])
    with pytest.raises(BhavcopyFormatError, match="valid zip|corrupt"):
        parse_bhavcopy(tmp_path / "t.zip")
    (tmp_path / "m.csv").write_text(ud_text(ud_row(), ud_row(day="2025-10-07")))
    with pytest.raises(BhavcopyFormatError, match="several trade dates"):
        parse_bhavcopy(tmp_path / "m.csv")


# ---------------------------------------------------------------- download

def _client(handler, sleeps=None):
    return NseClient(httpx.Client(transport=httpx.MockTransport(handler)), sleep=(sleeps if sleeps is not None else []).append,
                     min_gap=0, max_attempts=3)


def _paths(tmp_path):
    return tmp_path / "store", tmp_path / "raw"


def test_candidate_urls_by_era():
    assert "BhavCopy_NSE_FO_0_0_0_20250106_F_0000" in candidate_urls(date(2025, 1, 6))[0]
    assert "fo06JAN2023bhav" in candidate_urls(date(2023, 1, 6))[0]


def test_download_stores_raw_and_processed_separately_and_resumes(tmp_path):
    store_dir, raw_dir = _paths(tmp_path)
    hits = []

    def handler(req):
        hits.append(str(req.url))
        if "20251006" in str(req.url):
            return httpx.Response(200, content=zipped("x.csv", ud_text(ud_row())))
        return httpx.Response(404)

    s = download_range(date(2025, 10, 6), date(2025, 10, 8), store_dir, raw_dir, symbols={"NIFTY"},
                       client=_client(handler))
    assert s.ok == [date(2025, 10, 6)] and s.unavailable == [date(2025, 10, 7), date(2025, 10, 8)]
    assert list((raw_dir / "nse" / "fo" / "2025").glob("*.zip"))                  # raw kept
    assert store.query(store_dir, "contracts").num_rows == 1                       # processed elsewhere
    assert not list((raw_dir / "nse" / "fo").glob(".incoming/*"))
    hits.clear()
    s = download_range(date(2025, 10, 6), date(2025, 10, 8), store_dir, raw_dir, symbols={"NIFTY"},
                       client=_client(handler))
    assert date(2025, 10, 6) in s.skipped and not any("20251006" in h for h in hits)  # ok day not refetched
    ledger = Ledger(store_dir)
    assert ledger.get_bhav(date(2025, 10, 6))["status"] == "ok" and ledger.get_bhav(date(2025, 10, 7))["status"] == "unavailable"
    ledger.close()


def test_falls_back_to_the_other_layout_url(tmp_path):
    store_dir, raw_dir = _paths(tmp_path)

    def handler(req):
        u = str(req.url)
        if "fo10OCT2024bhav" in u and "nsearchives" not in u:  # only the second legacy host has it
            return httpx.Response(200, content=zipped("fo.csv", "\n".join([LG_HEAD, lg_row(day="10-OCT-2024")])))
        return httpx.Response(404)

    s = download_range(date(2024, 10, 10), date(2024, 10, 10), store_dir, raw_dir, symbols=None, client=_client(handler))
    assert s.ok == [date(2024, 10, 10)]


def test_nse_blocking_stops_the_run_and_points_to_manual_import(tmp_path):
    store_dir, raw_dir = _paths(tmp_path)
    with pytest.raises(NseBlocked, match="bhav-import"):
        download_range(date(2025, 10, 6), date(2025, 10, 7), store_dir, raw_dir, symbols=None,
                       client=_client(lambda r: httpx.Response(403)))
    with pytest.raises(NseBlocked):
        download_range(date(2025, 10, 6), date(2025, 10, 7), store_dir, raw_dir, symbols=None,
                       client=_client(lambda r: httpx.Response(200, content=b"<html>Access Denied")))


def test_incomplete_download_is_retried_then_recorded_failed_with_nothing_processed(tmp_path):
    store_dir, raw_dir = _paths(tmp_path)
    good = zipped("x.csv", ud_text(ud_row()))
    calls = []

    def handler(req):
        calls.append(1)
        if len(calls) == 1:  # truncated body: declared length differs from what arrived
            return httpx.Response(200, content=good[:50], headers={"content-length": str(len(good))})
        return httpx.Response(200, content=good)

    # httpx recomputes content-length for mock content, so simulate truncation via a corrupt zip instead
    s = download_range(date(2025, 10, 6), date(2025, 10, 6), store_dir, raw_dir, symbols=None,
                       client=_client(lambda r: httpx.Response(200, content=good[:50])))
    assert s.failed == [date(2025, 10, 6)] and store.query(store_dir, "contracts") is None
    ledger = Ledger(store_dir)
    assert ledger.get_bhav(date(2025, 10, 6))["status"] == "failed"
    ledger.close()
    s = download_range(date(2025, 10, 6), date(2025, 10, 6), store_dir, raw_dir, symbols=None,
                       client=_client(lambda r: httpx.Response(200, content=good)))
    assert s.ok == [date(2025, 10, 6)]  # a failed date is retried automatically


def test_server_errors_back_off_then_record_failure(tmp_path):
    store_dir, raw_dir = _paths(tmp_path)
    sleeps = []
    s = download_range(date(2025, 10, 6), date(2025, 10, 6), store_dir, raw_dir, symbols=None,
                       client=_client(lambda r: httpx.Response(503), sleeps))
    assert s.failed == [date(2025, 10, 6)] and len(sleeps) == 3


def test_weekends_are_skipped(tmp_path):
    store_dir, raw_dir = _paths(tmp_path)
    hits = []
    download_range(date(2025, 10, 4), date(2025, 10, 5), store_dir, raw_dir, symbols=None,
                   client=_client(lambda r: hits.append(1) or httpx.Response(404)))
    assert hits == []


# ---------------------------------------------------------------- manual import, dedupe, master

def test_manual_import_takes_date_from_contents_and_is_idempotent(tmp_path):
    store_dir, raw_dir = _paths(tmp_path)
    f = tmp_path / "whatever_name.csv"
    f.write_text(ud_text(ud_row(), ud_row(k=25050)))
    for _ in range(2):
        s = import_files([f], store_dir, raw_dir, {"NIFTY"})
        assert s.ok == [date(2025, 10, 6)] and s.rows == 2
    assert store.query(store_dir, "contracts").num_rows == 2  # re-import replaces, never doubles
    assert store.duplicate_keys(store_dir, "contracts")[0] == 0
    ledger = Ledger(store_dir)
    row = ledger.get_bhav(date(2025, 10, 6))
    assert row["origin"] == "manual" and row["fmt"] == "udiff" and row["sha256"] and row["rows"] == 2
    ledger.close()


def test_same_day_in_both_layouts_does_not_duplicate(tmp_path):
    store_dir, raw_dir = _paths(tmp_path)
    a, b = tmp_path / "a.csv", tmp_path / "b.csv"
    a.write_text(ud_text(ud_row(day="2024-10-04", exp="2024-10-10")))
    b.write_text("\n".join([LG_HEAD, lg_row(day="04-OCT-2024")]))
    import_files([a], store_dir, raw_dir, None)
    import_files([b], store_dir, raw_dir, None)
    assert store.duplicate_keys(store_dir, "contracts")[0] == 0


def test_bad_manual_file_is_logged_and_does_not_stop_the_good_one(tmp_path):
    store_dir, raw_dir = _paths(tmp_path)
    bad, good = tmp_path / "bad.csv", tmp_path / "good.csv"
    bad.write_text("a,b\n1,2\n")
    good.write_text(ud_text(ud_row()))
    s = import_files([bad, good], store_dir, raw_dir, None)
    assert len(s.failed) == 1 and s.ok == [date(2025, 10, 6)]
    ledger = Ledger(store_dir)
    assert any(r["status"] == "failed" and r["dataset"] == "bhavcopy" for r in ledger.log_rows())
    ledger.close()


def test_contract_master_resolves_real_expiries_and_lots(tmp_path):
    store_dir, raw_dir = _paths(tmp_path)
    f = tmp_path / "b.csv"
    # weekly 07 Oct (Tue), weekly 14 Oct, monthly 28 Oct and 25 Nov; lot size changes with the expiry listed
    f.write_text(ud_text(ud_row(exp="2025-10-07", lot=75), ud_row(exp="2025-10-14", lot=75),
                         ud_row(exp="2025-10-28", lot=75), ud_row(exp="2025-11-25", lot=75),
                         ud_row(exp="2025-11-25", cp="PE", lot=75)))
    import_files([f], store_dir, raw_dir, None)
    m = ContractMaster(store_dir)
    d = date(2025, 10, 6)
    assert m.resolve_expiry("NIFTY", d, "WEEK", 1) == date(2025, 10, 7)
    assert m.resolve_expiry("NIFTY", d, "WEEK", 2) == date(2025, 10, 14)
    assert m.resolve_expiry("NIFTY", d, "MONTH", 1) == date(2025, 10, 28)
    assert m.resolve_expiry("NIFTY", d, "MONTH", 2) == date(2025, 11, 25)
    assert m.lot_size("NIFTY", d, date(2025, 10, 7)) == 75
    assert m.resolve_expiry("NIFTY", date(2025, 10, 8), "WEEK", 1) is None  # no bhavcopy that day: not guessed
    assert m.resolve_expiry("BANKNIFTY", d, "WEEK", 1) is None
