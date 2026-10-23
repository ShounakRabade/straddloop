# Assumptions and known limitations

## Assumptions (each is a setting, and each result records which value it used)

| Id | Assumption | Why | Effect if wrong |
| --- | --- | --- | --- |
| A1 | Candles are labelled by start time, IST | Dhan's documented example timestamp is 09:15 IST | Every decision shifts by one bar; the coverage report checks the label on real data |
| A2 | Dhan's ATM+-10 window applies to expiry code 1 of index options | "Near expiry" in Dhan's docs | Requests for wider windows fail loudly, not silently |
| A3 | Brokerage ₹20 per executed order | Flat-fee brokers on the shortlist | Scales costs linearly; configurable |
| A4 | NSE cost schedule from 1 Apr 2026: STT 0.15% of sell premium, exchange 0.03553%, SEBI ₹10/crore, stamp 0.003% on buys, GST 18% | Verified on 22 Oct 2026 | The date the 0.03553% exchange charge started is not yet confirmed |
| A5 | NSE cost schedule 1 Oct 2024 to 31 Mar 2026: STT 0.10%; other rates as in the code | STT verified; exchange, SEBI and stamp not yet verified | Flagged `all_rates_verified = False` on every affected result |

## Known limitations

| Id | Limitation | Consequence |
| --- | --- | --- |
| L1 | No historical bid/ask from any source | Spreads are modelled; real fills could be worse |
| L2 | 1-minute OHLC cannot show the order of events inside a minute | Stop-versus-target and two-stops-in-one-minute cases are resolved conservatively and flagged |
| L3 | Dhan returns option candles relative to ATM, not by fixed contract | A strike that drifts beyond the window loses its prices; the coverage report measures how often |
| L4 | Dhan gives no expiry date or lot size | Joined from the exchange bhavcopy; a candle that cannot be joined is excluded from backtests |
| L5 | No verified BSE cost schedule | SENSEX backtests stop with an error until rates are verified |
| L6 | No cost schedule before 1 Oct 2024 | Backtests before that date stop with an error until rates are entered |
| L7 | Market-data hosts are blocked from the cloud build environment | All real pulls run on your computer |
