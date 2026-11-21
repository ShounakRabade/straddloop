import gzip
import json
from datetime import date, datetime, timedelta

from straddloop.data import store
from straddloop.data.dayfiles import StoreReader, assumed_expiry, assumed_lot_size, build_day, decode
from straddloop.data.schema import OptionCandle, UnderlyingCandle
from straddloop.timeutil import IST


def _write_store(root, day):
    t0 = datetime(day.year, day.month, day.day, 9, 15, tzinfo=IST)
    und, opts, vix = [], [], []
    for i in range(375):
        px = 25000 + i * 0.25
        if i != 7:  # one missing index bar
            ts = t0 + timedelta(minutes=i)
            und.append(UnderlyingCandle(ts, "NIFTY", 1, px, px + 3.1, px - 2.05, px + 0.5, None, "dhan"))
            vix.append(UnderlyingCandle(ts, "INDIA_VIX", 1, 15 + i / 100, 15.2 + i / 100,
                                        14.9 + i / 100, 15.1 + i / 100, None, "dhan"))
        for cp in ("CE", "PE"):
            for off in (-1, 0, 1):
                if cp == "PE" and off == 1 and i == 100:
                    continue  # one missing option bar
                k = 25000 + off * 50 + (50 if i > 200 else 0)
                o = 100.05 + off * 10 + i * 0.05
                for flag in ("WEEK", "MONTH"):
                    opts.append(OptionCandle(t0 + timedelta(minutes=i), "NIFTY", 1, cp, float(k),
                                             f"ATM{off:+d}" if off else "ATM", flag, 1, None, o, o + 1.5, o - 0.95,
                                             o + 0.3, 1234.0 + i, 5e6 + i, 12.34, px + 0.5, "dhan"))
    store.write_records(root, "underlying_candles", und, UnderlyingCandle)
    store.write_records(root, "underlying_candles", vix, UnderlyingCandle)
    store.write_records(root, "option_candles", opts, OptionCandle)


def test_day_file_round_trip(tmp_path):
    day = date(2025, 10, 6)
    _write_store(tmp_path, day)
    reader = StoreReader(tmp_path)
    assert reader.option_dates() == [day]
    df = build_day("NIFTY", "WEEK", day, reader.options(day, "NIFTY", "WEEK"), reader.index(day, "NIFTY"),
                   vix_rows=reader.index(day, "INDIA_VIX"))
    assert df.series == 6 and df.index_bars == 374 and df.missing_bars == 1 and df.quality == "gaps:1"
    assert df.path == "NIFTY/WEEK/2025-10-06.json.gz"
    doc = json.loads(gzip.decompress(df.blob))
    assert doc["expiry"] == "2025-10-07" and doc["lot_size"] == 75 and doc["expiry_source"].startswith("assumed")
    dec = decode(doc)
    ce0 = next(s for s in dec["series"] if s["cp"] == "CE" and s["off"] == 0)
    assert ce0["o"][10] == round((100.05 + 0.5) * 100) and ce0["h"][10] == ce0["o"][10] + 150
    assert ce0["l"][10] == ce0["o"][10] - 95 and ce0["c"][10] == ce0["o"][10] + 30
    assert ce0["k"][0] == 25000 and ce0["k"][300] == 25050 and ce0["iv"][5] == 1234
    pe1 = next(s for s in dec["series"] if s["cp"] == "PE" and s["off"] == 1)
    assert pe1["o"][100] is None and pe1["o"][101] is not None
    assert dec["index"]["o"][7] is None and dec["index"]["h"][8] == round((25002 + 3.1) * 100)
    assert dec["vix"]["o"][0] == 1500 and dec["vix"]["c"][0] == 1510
    # deterministic: same input, same bytes
    again = build_day("NIFTY", "WEEK", day, reader.options(day, "NIFTY", "WEEK"), reader.index(day, "NIFTY"),
                      vix_rows=reader.index(day, "INDIA_VIX"))
    assert again.blob == df.blob and again.sha256 == df.sha256


def test_assumed_expiries_and_lots():
    assert assumed_expiry(date(2025, 10, 8), "WEEK") == date(2025, 10, 14)  # Tuesday era
    assert assumed_expiry(date(2025, 8, 4), "WEEK") == date(2025, 8, 7)  # Thursday era
    assert assumed_expiry(date(2025, 10, 6), "MONTH") == date(2025, 10, 28)
    assert assumed_expiry(date(2025, 10, 29), "MONTH") == date(2025, 11, 25)
    assert assumed_lot_size("NIFTY", date(2025, 10, 7)) == 75
    assert assumed_lot_size("NIFTY", date(2026, 2, 3)) == 65
