# Research lab audit (engine, data path, accounting)

Date: 19–20 Nov 2026. Scope: the Lab's data path (Supabase `market_days` + private `market-data` bucket →
browser worker), the three existing engines (`engine.js` straddle, its ORB module, `fourleg_engine.js`), the
ledger (`ledger.js`), and how results reach the page. UI design is audited separately by the UI thread.
Accounting conventions and their earlier audit are in `docs/ACCOUNTING.md`; shapes are in
`docs/ENGINE_INTERFACES.md`.

Each finding says what was checked, what is wrong, and where it stands. "Fixed" means fixed in code with a
test; "open" means not fixed, with the reason.

## Findings, most serious first

| # | Finding | Evidence | Status |
| --- | --- | --- | --- |
| 1 | **The Lab counted days four different ways.** For Real NIFTY 6–8 Oct 2025 the range box said "3 trading days will run", the result said "1 traded day", "100% won of 1 traded day" and "3 real days". The range box counted weekdays with a file (3), the worker counted sessions loaded (3), the engine headline counted days with fills (1) and the ledger report counted decided sessions (2, excluded days left out). Nothing on the page said what happened to the other two days. | Reproduced in `web/tests/outcomes.test.mjs` with hand-made day files: one day excluded for a missing index minute in the opening range, one with the entry condition failing, one traded. | **Fixed (data side, PR #7 merged):** one `DateRange` object drives the calendar, the file list, the run and the report (`web/lib/dateRange.ts`); every run returns `days[]`, one outcome per session with its reason, and the worker refuses a result whose outcome count differs from the sessions loaded. The page still has to show `days[]` (UI thread). |
| 2 | **A run with no traded day crashed** the straddle and ORB summaries (`m.equity_curve` undefined). | Test in `outcomes.test.mjs`. | Fixed (PR #7). |
| 3 | **Data quality hid missing index minutes.** `market_days.quality = 'gaps:N'` counts missing option bars only. 6 Oct 2025 has 374 of 375 index bars, which reads as "complete", yet one missing minute inside 09:15–09:50 excludes the straddle for the whole day. The exact minute could not be confirmed from here (the day files are private). | `index_bars` column vs `quality`. | Fixed in the range: a day with fewer than 375 index bars is `partial` with the count, and the engine's exclusion reason now names the missing minute. |
| 4 | **`market_day_status` does not exist in production.** The schema file defines it, but the table is absent, so per-day reasons (holiday, fetch failed, validated) cannot be stored; the range falls back to file quality and an unverified holiday list. | `statuses()` returns `[]`; `information_schema` shows no table. | Open: creating it is a production schema change and needs the owner's go-ahead (data thread). |
| 5 | **Expiry dates are assumed** (weekday rule), never the exchange's. A holiday-shifted weekly expiry would be wrong. Diwali 2025 (21 Oct) is a likely case; the stored 6–17 Oct sample is not affected, but any longer range will be. | `meta.expiry_source = 'assumed…'` in day files. | Open (data thread: import bhavcopy expiries). Intraday strategies are unaffected; the leg engine warns `EXPIRY_ASSUMED` on any multi-day hold. |
| 6 | **Margin ignored hedges.** Every short leg was charged on its own, so spreads, condors and straddles were over-charged and could be rejected for margin they would not need. | `ledger.js` `marginFor`. | Fixed for the leg engine: `margin_model: 'hedged'` (hand-checked in `legs.test.mts`). The straddle and ORB keep `per_leg` so their published results do not move. Both are ESTIMATED, not SPAN. |
| 7 | **Real fills are optimistic by construction.** Dhan candles have no bid/ask; fills are candle open ± slippage. The synthetic model fills at its own bid/ask, so synthetic and real results are not like for like. | Fill code in all engines. | Labelled, not fixable without quote history: `NO_BID_ASK` on every real run; slippage is a setting and the high-slippage case is tested. |
| 8 | **Cost rows before 1 Oct 2024 are recalled, not verified**, and the Python and JS cost tables are separate copies. | `COST_TABLE` `verified: false`; `src/straddloop/reference/costs.py`. | Open: flagged on every report that uses them; needs checking against NSE/SEBI circulars and one shared source. |
| 9 | **"Today" was UTC.** Between 00:00 and 05:30 IST the latest selectable date was a day behind. | `new Date().toISOString()`. | Fixed: `todayIST()` in `dateRange.ts`. |
| 10 | **Small-sample figures read as final.** With one traded day the page showed a 95% interval, worst day and win rate as if they meant something. | Screenshot. | Partly: the ledger report warns below 30 sessions and the interval collapses to the mean when n = 1. The page should grey these out (UI thread). |
| 11 | **Long ranges will be slow in the browser.** Every day file is downloaded and decoded inside the browser worker; a multi-year range means hundreds of files with no progress messages. | `worker.js`. | Open: progress messages are specified (`ENGINE_INTERFACES.md` §2, planned); caching or server-side runs are a later decision. |
| 12 | **Only one underlying, one expiry, a narrow window.** Stored: NIFTY weekly, nearest expiry, ATM ± 10 strikes, 6–17 Oct 2025 (10 sessions). | `market_days`. | Not a defect; the leg engine refuses what this cannot support (calendars, diagonals, delta on real data, far strikes, other underlyings) with a message instead of faking it. |
| 13 | **The four-leg stock model has no ledger** (no capital, margin or rejection accounting). | `compute.js` `fourleg`. | Open: synthetic only; listed as not implemented in `ACCOUNTING.md`. |
| 14 | **No CI and no lint in `web/`.** Tests and the type check run only by hand. | No `.github/workflows`; no lint script. | Open: recommend a workflow running `npm test`, `npm run typecheck` and the `precompute` byte check. |
| 15 | Security: row-level security on market data is in place (readers only); Supabase's leaked-password protection is off. | Supabase advisors. | Open (owner's setting). |

No look-ahead was found in the existing engines: every engine decides on completed bars and fills at the next
bar's open, and stops can trigger in the entry bar (conservative). Testing the new leg engine found one: an
opening-range width filter with an entry before the range closed would have read bars after the decision.
The spec is now refused in that case (`legs.test.mts`, entry filters). The straddle's results are reproducible: `npm run precompute`
regenerates `lib/precomputed.json` byte for byte after every change in this work.

## Leg engine: feature status

| Feature | Status |
| --- | --- |
| One spec for every structure: 1–6 legs, BUY/SELL, CE/PE, ratios | implemented-and-tested |
| 25 templates (singles, verticals, straddles, strangles, condor, iron fly, butterflies incl. broken-wing, ratios, backspreads, calendars, diagonals) | implemented-and-tested (all produce valid specs; 21 run on synthetic data and reconcile; calendars/diagonals gated) |
| Strike by ATM offset, % from ATM, premium, another leg | implemented-and-tested |
| Strike by delta | implemented-and-tested on the synthetic model only; refused on real data (no reliable Greeks) |
| Entry time, weekdays, DTE, opening-range filter, OR width, gap, move, net premium | implemented-and-tested (net premium filter implemented-not-verified) |
| Per-leg stop and target (gap-aware stops, stop beats target, resting-limit targets) | implemented-and-tested |
| Position target / stop (net of charges, at close, filled next open) | implemented-and-tested |
| Adjustments: keep others, close all, re-enter (re-selects the strike) | implemented-and-tested |
| Intraday, N-session and hold-to-expiry exits; cash settlement | implemented-and-tested |
| Same fills as the existing straddle engine for Strategy 01 (re-entry off) | implemented-and-tested on 180 synthetic days |
| Data gates with messages (underlying, series, next expiry, delta, strike window, continuity, bid/ask, assumed expiry, data gaps) | implemented-and-tested |
| Ledger: carry, closing equity, settlement charges, hedged margin, per-position reconciliation | implemented-and-tested |
| Payoff at expiry (max profit / loss, breakevens) | implemented-and-tested for single-expiry positions; none for mixed expiries |
| Lab page for building specs and showing positions | not implemented here (UI thread); the worker accepts `strategy: 'legs'` |
| More than one position at a time, scaling in, rolling to the next expiry | not implemented |
| Re-entry after a position target or stop (only after a leg stop) | not implemented |
| Worker progress messages | not implemented (specified) |
| Calendars and diagonals on real data | not possible until next-expiry data is pulled |
