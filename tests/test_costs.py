from datetime import date

import pytest

from straddloop.reference.costs import CostScheduleMissing, Fill, costs_for, schedule_for


def test_worked_example_from_feasibility_report():
    # One NIFTY straddle lot of 65: both legs sold at 100, bought back at an average of 90.
    d = date(2026, 10, 20)
    fills = [
        Fill(d, "NSE", "SELL", 100.0, 65),
        Fill(d, "NSE", "SELL", 100.0, 65),
        Fill(d, "NSE", "BUY", 90.0, 65),
        Fill(d, "NSE", "BUY", 90.0, 65),
    ]
    c = costs_for(fills)
    assert c.brokerage == 80.00
    assert c.stt == 19.50  # 0.15% of 13,000
    assert c.exchange_txn == 8.78  # 0.03553% of 24,700
    assert c.stamp == 0.35  # 0.003% of 11,700
    assert c.gst == 15.98
    assert c.total == pytest.approx(124.63, abs=0.01)
    assert c.schedule_ids == ("nse-2026-04-01",)
    assert c.all_rates_verified


def test_schedule_switches_on_effective_date():
    assert schedule_for("NSE", date(2026, 3, 31)).id == "nse-2024-10-01"
    assert schedule_for("NSE", date(2026, 4, 1)).id == "nse-2026-04-01"


def test_older_schedule_is_flagged_unverified():
    c = costs_for([Fill(date(2025, 1, 2), "NSE", "SELL", 100.0, 75)])
    assert c.stt == 7.50  # 0.10% before April 2026
    assert not c.all_rates_verified


def test_missing_schedules_raise_instead_of_guessing():
    with pytest.raises(CostScheduleMissing):
        schedule_for("BSE", date(2026, 10, 1))  # SENSEX rates not verified yet
    with pytest.raises(CostScheduleMissing):
        schedule_for("NSE", date(2024, 9, 30))  # pre-October-2024 rates not entered
