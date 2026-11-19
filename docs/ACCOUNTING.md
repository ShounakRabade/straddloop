# Backtest accounting, audit and status

Code: `web/public/engine/ledger.js` (pure, runs in the Lab worker and in Node). Tests: `cd web && npm test`; browser journey: `web/tests/e2e/journey.cjs`.

## 1. Audit of the existing engines (what was right, what was wrong)

| Area | Finding | Status |
| --- | --- | --- |
| Entry price | Decision uses only completed candles; the order fills at the open of the next candle plus slippage. No look-ahead found. | Correct |
| Stop fills | Leg stop triggers on bar high; fill is gap-aware (`max(stop, open)`) plus double slippage. A stop can trigger in the entry candle (conservative). Order of events inside one minute is unknown and flagged `intrabar`. | Correct, limitation stays (L2) |
| Target / exit | Target is checked at candle close and filled at the next open; forced exit at 15:15. | Correct |
| Costs | **Wrong.** Flat default rates (STT 0.10%, exchange 0.03503%) were applied to every date, whatever the year. Real-data runs from 2025-26 used the wrong STT, and the Python schedule (which has dates) was not used by the Lab. | **Fixed**: engines take dated rates from the table in `ledger.js` through `cfg.rates_for`; ledger recomputes every fill and reconciles to the engine cost lines |
| Cost table coverage | The Python schedule stopped at 2024-10-01 and raised before it. | Table now starts 2020-07-01; rows before 2024-10-01 are **recalled, not verified** and flagged on every report. Before 2020-07-01 the run stops with an error |
| Headline figures | Page figures came from engine day sums; nothing tracked capital, margin or rejected trades. | **Fixed**: headline now comes from the ledger |
| Lot size | One lot size per day file, "assumed"; a user override applied to every day in a multi-year range. | Not fixed. The report lists every lot size used and warns when it changes inside the range. Needs the data thread's bhavcopy-verified lot sizes |
| Expiry | Assumed (weekday rule), not bhavcopy-verified. | Not fixed (data thread). Straddle and ORB close everything by 15:15. The leg engine can hold to expiry and settle; those runs carry an `EXPIRY_ASSUMED` warning until expiries come from the bhavcopy |
| Overnight positions | Straddle and ORB are intraday. The leg engine can carry positions across sessions (real data only). The four-leg stock model holds for weeks but is synthetic only. | Leg engine: carried legs stay open in the ledger with their margin and unrealised P&L (section 6). Four-leg is not covered by the ledger |
| Survivorship | Index options only; none found. Dhan's ATM±10 window means a strike that drifts out loses its prices (L3). | Known limitation |
| Day files with gaps | Engine excludes a day it cannot trade on complete data. | Listed in the report as excluded; never filled |

## 2. Conventions (so every figure reconciles)

* **Balance** = starting capital + cumulative **net** realised P&L (gross realised − all charges). Charges are debited at each fill. Premium received on a short sale is *not* spendable cash.
* **Equity** = balance + unrealised P&L of open legs, marked at the candle-close price of each leg. A leg's P&L moves from unrealised to realised exactly once, at its closing fill. Realised and unrealised are never added twice.
* **Available margin** = balance − margin blocked − long premium held.
* **Investment** = premium paid on long options. **Notional exposure** = strike × quantity. **Margin blocked** = estimated margin on short options. **Cash outflow** = long premium paid + all charges (margin is blocked, not spent).
* Capital deployed = margin blocked + long premium held. Average = mean over days with a trade of that day's peak.
* Every return metric has its denominator printed next to it in the report (`defs`) and in the performance CSV.
* **Closing equity** = closing balance + unrealised P&L of legs carried to the next session (equal to the closing balance for intraday strategies).
* Sharpe / Sortino: daily return = (day net realised + change in unrealised) / previous closing equity, every session counts (idle days are 0), sqrt(252), risk-free configurable (default 0). For intraday strategies this is exactly day net P&L / previous closing balance, so existing results are unchanged. Drawdown is on closing equity. CAGR only for ranges of at least one year.
* Margin policies when a new position needs more than is free: `reject`, `partial` (fewer whole lots), `liquidate` (run it; force-close all open legs at their latest candle-close mark when equity < margin blocked), `record` (run it, only record the shortfall).

## 3. Margin (ESTIMATED, never actual)

Exact historical SPAN + exposure per day is not available to this project. Two ESTIMATED models, chosen by `margin_model`.

**`per_leg`** (default for the straddle and ORB, unchanged): short option margin = (SPAN-like % + exposure %) × strike × quantity (defaults 9% + 2%); long options need only their premium. It ignores the SPAN offset between a short call and put (so straddles are over-stated), uses strike as a proxy for underlying notional, and applies the **same** percentages to every historical date. Today's margin rules are not used retroactively; the percentages are inputs you can change, labelled "est." everywhere. A broker margin CSV by date would replace this; not built.

**`hedged`** (default for the leg engine): the worst loss, at intrinsic value, of all open legs together over index levels within ± SPAN-like % (9%) of the index at entry, plus exposure % (2%) × that index level × total short quantity, never more than the `per_leg` figure. A spread or condor is charged for its defined risk (a 100-point NIFTY spread: 100 × 75 + 2% × 25,000 × 75 = 45,000), a naked short is charged the same as `per_leg`, and a short straddle less than two naked legs (243,750 instead of 412,500 at 25,000). Long premium is held as cash, not margin. Legs of different expiries are valued at intrinsic on the same level (an approximation that ignores the far leg's time value). Entry orders send hedges first and exits close shorts first, so the margin never sees a naked short that is meant to be covered. It is not SPAN: no volatility scan, no calendar-spread charge, no premium credit.

## 4. Statutory rates (option premium turnover; NSE)

See `COST_TABLE` in `ledger.js`; the report prints the rows used. Verified rows (2024-10-01 STT; 2026-04-01 all rates) are carried from `src/straddloop/reference/costs.py`. Everything earlier (STT 0.05% to 2023-03, 0.0625% to 2024-09; exchange 0.053%) is from memory, flagged `verified: false`, and shows as a warning on any run that uses it. The exchange-rate effective dates, SEBI ₹10/crore history and anything before 2020-07-01 need checking against NSE/SEBI circulars. The Python `costs.py` and the JS table are separate copies; keep them in step.

## 5. Multi-day positions and expiry settlement (leg engine)

* A leg the engine carries to the next session is listed in that day's `carry`; the ledger keeps it open with its margin and last mark. The daily row shows `open_legs`, `unrealised_end` and `closing_equity`; the next day starts from the same unrealised figure. A day with a carried position and no order is `holding`.
* Cash settlement at expiry: price = intrinsic value against the index close of the last stored bar of expiry day. Charges: no brokerage, exchange, SEBI, stamp or GST; STT `exercise_stt_pct` (default 0.125%, UNVERIFIED) on intrinsic value × quantity of a long in-the-money option only. Shorts and out-of-the-money options settle with no charge. Every report that settles a position says so.
* A carried leg with no prices on the next stored day is closed at its last seen price (`data_gap`, or `expired_unobserved` if its expiry passed on a day with no data) and flagged; it is never settled or priced from a model. Weekdays with no stored data inside a hold are a `DATA_GAP` warning (stops on those days were not seen).
* Reconciliation adds: unrealised at the end = 0, closing equity of the last day = ending balance, and for the leg engine (when every order executed as sent) each position's engine net = its ledger net.

## 6. Feature status

| Feature | Status |
| --- | --- |
| Dated statutory costs in engines + ledger | implemented-and-tested (unit + engine reconciliation); rates before 2024-10 unverified |
| Per-fill ledger (balance, margin blocked/released, exposure, realised/unrealised, charges) | implemented-and-tested |
| Margin model, shortfall, reject / partial / record policies | implemented-and-tested |
| Simulated liquidation | partial: closes at the latest candle-close mark for the whole day-position; no intrabar path |
| Report (summary, capital & margin, performance, trades, risk, ledger) with denominators | implemented-and-tested (browser journey) |
| CSV: tradebook, ledger, daily ledger, performance | implemented-and-tested |
| Execution record per trade (inputs, costs, schedule, margin, event trail) | implemented-and-tested |
| Date-range validation and availability counts (stored / validated / gaps / failed / not stored) | implemented-and-tested; uses today's `market_days.quality`. "Downloading" shows only browser file download. No per-day ingestion status or Dhan fetch state exists yet: waits for the data thread |
| Reproducibility (run hash over settings + data fingerprint + cost table) | implemented-and-tested for identical results; hash is a fingerprint, not a signed snapshot id |
| Interrupted runs | partial: a newer run supersedes an older one, bad data/dates give an error, no state is corrupted; no resumable/cancellable long runs |
| Four-leg stock strategy ledger | not implemented (own margin model, synthetic only) |
| Overnight carry (leg engine): open legs, margin, unrealised, closing equity across sessions | implemented-and-tested (hand-computed condor and multi-session tests) |
| Expiry cash settlement at intrinsic, STT on long ITM | implemented-and-tested; the STT rate and zero brokerage are UNVERIFIED assumptions |
| Hedged margin estimate | implemented-and-tested (hand-computed straddle, strangle, spreads, condor); ESTIMATED, not SPAN |
| Broker-actual historical margin | not implemented |
| Lint | not configured in `web/`; `ruff` passes on the Python side |
