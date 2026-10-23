# S1 Intraday short straddle with call re-entry: specification v1.0.0 (baseline)

Status: baseline as approved on 22 Oct 2026. Defaults marked **[default]** are proposals awaiting
confirmation; items marked **[open]** need a decision. Changing any of them creates a new version.

## Rules in plain English

1. Each index (NIFTY 50, BANK NIFTY, SENSEX) runs independently and is reported separately.
2. Build six 5-minute candles from 09:15 to 09:45. Opening-range high = highest high, low = lowest low.
3. Entry condition (baseline, as approved): the 09:40-09:45 candle's high and low are both inside that
   range. **Note: this is always true, because that candle is one of the six.** The baseline therefore
   trades every day with a complete opening range. Two variants are kept separately:
   `or_filter = first_five` (09:40 candle inside the range of the first five) and
   `or_filter = next_candle` (09:45-09:50 candle inside all six; entry 09:50). **[open]**
4. Entry: sell one ATM call and one ATM put at the open of the first 1-minute bar at or after 09:45:00
   (the moment the 09:40 candle has closed). **[default]**
5. ATM: listed strike nearest the index's last completed 1-minute close; ties to the lower strike. **[default]**
6. Expiry: nearest weekly for NIFTY and SENSEX, nearest monthly for BANK NIFTY; expiry-day sessions
   reported separately. **[open]**
7. Stops: each leg independently at 1.36 x its entry fill, rounded up to the tick. Triggered when a
   1-minute high reaches the stop; filled at the higher of the stop and that minute's open, plus
   slippage. **[default]**
8. Both legs' stops inside one minute: both filled at their conservative prices, flagged, no re-entry
   from that minute. **[default]**
9. Re-entry (call stop only): at the call stop, read the put's last 1-minute close P. Sell, at the next
   minute's open, the same-expiry call nearest to ATM whose last close is <= P. It replaces the stopped
   call and has its own 36% stop. At most one re-entry a day. No eligible call: no re-entry, flagged.
   A put stop triggers no re-entry in the baseline. **[open]**
10. Target: when net P&L (all legs, after costs, marked at 1-minute closes) reaches ₹1,000 x lots,
    close everything at the next minute's open. **[default]**
11. End of day: close everything at 15:15. **[default]**
12. Size: 1 lot; lot size from the contract master on that date. Margin checked against ₹5,00,000.

## Data required

Index 1-minute candles; 1-minute candles for ATM+-10 calls and puts of the traded expiry; expiry
dates and lot sizes from the exchange bhavcopy; dated cost schedule.

## Outputs per trade

Entry time, contract, strike, expiry, premium, quantity, stop events, re-entry events, realised and
unrealised P&L, maximum adverse and favourable excursion, costs, net P&L, exit reason, and every
ambiguity flag raised.
