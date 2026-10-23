# Data-source and licensing register

Checked 22 Oct 2026. "Confirmed" means read on the provider's own documentation page.

| Source | Role | Confirmed | Unverified | Cost | Licence note |
| --- | --- | --- | --- | --- | --- |
| Dhan `/v2/charts/rollingoption` | Expired index and stock option candles | NSE and BSE index and stock options; last 5 years; 1/5/15/25/60 min; <= 30 days a call; toDate exclusive; ATM+-10 near-expiry index options, ATM+-3 otherwise; OHLC, volume, OI, IV, strike, spot ([docs](https://dhanhq.co/docs/v2/expired-options-data/)) | Meaning of "near expiry" for monthly series; missing-row rate; timestamp label convention | ₹499/month + tax ([source](https://dhan.co/support/platforms/dhanhq-api/how-does-the-dhanhq-data-api-subscription-work/)) | For the account holder's own use; do not redistribute (terms to be read in full) |
| Dhan `/v2/charts/intraday` | Index candles | 1/5/15/25/60 min; last 5 years; <= 90 days a call ([docs](https://dhanhq.co/docs/v2/historical-data/)) | Index security ids 13/25/51 on IDX_I (secondary source; confirm with `dhan-check-ids`) | Same plan | Same |
| Dhan rate limits | | Data APIs 5 requests/second ([FAQ](https://dhan.co/support/platforms/dhanhq-api/what-are-the-api-rate-limits-for-dhan/)) | Daily caps | | |
| NSE F&O UDiFF bhavcopy | Contract master: expiries, strikes, lot sizes, settlement prices | Published daily; CSV layout discontinued 8 Jul 2024 in favour of UDiFF ([NSE](https://www.nseindia.com/all-reports-derivatives)) | Exact UDiFF headers on a real file (parser built from known header names) | Free | Exchange terms of use |
| BSE bhavcopy | Contract master for SENSEX | | Layout, lot size column | Free | |
| Upstox expired candles | Cross-check by exact contract | 1-30 min and day, OHLC, volume, OI; Upstox Plus required ([docs](https://upstox.com/developer/api-documentation/get-expired-historical-candle-data/)) | History depth | Plus free to activate initially | |
| ICICI Breeze | Free cross-check | Free; 1-second to daily; history not corporate-action adjusted | Expired-contract coverage | Free | |
| Opstra | Manual research only | No documented API | Everything else | PRO tier price unconfirmed | |
