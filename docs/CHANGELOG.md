# Changelog

## Unreleased: Lab configuration controls and layout

* **Times.** Entry, last new entry and square-off are picked with a time field instead of long lists: type
  `930` or `9:30`, step with the arrows, or open a grid of times at 1, 5, 15 or 30 minutes that filters as you
  type. Each time keeps to its engine's grain and bounds (Strategy 01 enters on 5-minute candles from 09:50) and
  says so when a typed value is moved. The three roles have their own marks on a 09:15–15:30 line; times out of
  order block Run with the reason. Strategy 01's re-entry cutoff (14:30) is now a field, and EMA pullback's fixed
  14:00 last entry is shown.
* **Stops and targets.** A typed value beside its unit, a slider (logarithmic over wide ranges) and, where it is
  optional, an On/Off switch. Strategy 01's stop goes to 500% (was 75%) and its target from ₹100 to ₹50,000 a lot
  (was ₹500–3,000); its daily loss cap per lot is now a field (off by default, as in the published rules). ORB's
  target goes to 500 points; EMA pullback's stop is any value from 3 to 150 index points. Builder strategies set a
  stop and a target for short legs and for long legs in %, premium points, ₹ or ₹ per lot, and a position stop and
  target in ₹ per lot, ₹ in total or % of the net premium.
* **Builder legs.** A legs table with an editor per leg: side, type, strike (from ATM, from another leg, by
  premium, % from spot; by delta on the synthetic model only), size, expiry, and the leg's own stop and target
  or none. Legs can be added (up to six) and reset. The engine's own checks run in the page as you edit, so a
  leg outside the stored strikes is refused with the reason before anything runs.
* **Data status.** The tall REAL DATA banner is one line (source, series, dates, the optimistic-fills caveat)
  with the assumptions behind every figure opening below it.
* **Rail.** Sections are now A Strategy & legs, B Entry & exit, C Risk rules, D Data & period, E Capital &
  execution, F Advanced. A field shows its default only once changed, and long option lists are dropdowns. With
  every section open the rail is about 45% shorter (2,700–3,350px, was 4,600–6,200px). No sideways scroll or
  clipped rail content at 1280, 1366, 1440, 1536 or 1920px (checked by the e2e test).
* Fixed: after typing an out-of-range stop, clicking the next control could miss, because leaving the box
  removed its note and moved the layout under the pointer.
* Tests: `tests/controls.test.mts` (time parsing, grain, order rules, level bounds and the slider scale), more
  registry tests (units, per-leg overrides, edited legs), and new browser steps in `tests/e2e/lab-ui.cjs`, which
  can now run on `playwright-core` with an installed browser (`PW_CHANNEL=msedge`).

## Unreleased: strategy builder in the Lab

* The Lab's strategy list has a **Strategy builder** beside the four published rule sets: 16 structures (long and
  short calls and puts, the four vertical spreads, long and short straddles and strangles, iron condor, iron
  butterfly, call and put ratio spreads) plus butterflies and backspreads. Each runs on the leg engine with strike
  offset, width, lots, entry and exit time, intraday or to-expiry hold, stops on short and long legs, a ₹ per lot
  position target and stop, what to do when a leg is stopped, trades per session, a wait between trades and the
  last new entry. Calendars and diagonals are listed but blocked: they need the next expiry, which is not stored.
  `?s=iron_condor` links and the notebook open them like any other strategy.
* One registry (`web/lib/strategyRegistry.ts`) describes every Lab strategy; `builderSpec` turns the Lab's settings
  into the StrategySpec that runs. Strategy 01 and the other published rule sets are unchanged.
* Leg engine: stops and targets in ₹ on the leg or ₹ per lot; position levels in ₹ for the whole position; more
  than one position a session (`entry.max_entries`, `entry.cooldown_min`), one at a time, decided again on the next
  eligible bar; a lean mode for optimisation. All optional: existing specs normalise, hash and run as before.
* Speed, same results: per-session lookups are cached, the per-bar exit-charge estimate reuses the day's rates
  (`L.chargeTotal`), and the ledger computes the hedged margin once per change of open legs instead of at every
  mark. Over a year of real sessions (244), end to end: iron condor 548 → 138 ms, short strangle 392 → 118 ms,
  bull put spread 360 → 97 ms, with identical nets. Measure with `DAYFILES=… node --experimental-strip-types
  scripts/bench.mts`.
* `compute.evaluate` (research tools) accepts builder strategies.
* Fixed: a run at default settings of Strategy 01 or 03 counted its exit-time field as "1 changed" and never became
  the default-rules baseline. A leg-engine headline now counts positions, not legs, and its summary says so.
* Saved runs: `web/supabase/schema.sql` widens the `runs.strategy` check so any Lab strategy can be saved to the
  account (it allowed only the first three, which already refused EMA pullback runs). Re-run it in the SQL editor.
* Tests: hand-worked iron butterfly, ₹ levels, trades per session, lean = full, and `tests/registry.test.mts`
  (the 16 structures on real day files when `DAYFILES` is set). Golden fingerprints unchanged.

## Unreleased: long ranges no longer overflow the stack

* Root cause of "Maximum call stack size exceeded": `Math.min(...xs)` / `Math.max(...xs)` pass every element as a call
  argument, and V8 throws once an array passes roughly 100k items. The India VIX summary hit it first (one value per
  1-minute bar, about 92k a year). Every such call over data that grows with the range, the trade count or the number
  of configurations now uses a loop (`maxOf` / `minOf` in each engine file, `web/lib/stats.ts` in the UI) in the
  engines, the ledger report, the analytics and the charts. Calls over one session's bars, one structure's legs or
  strikes are bounded and unchanged.
* Ledger: tagging a closed leg's fills with its trade number searched every fill of the run, making a run O(fills²).
  It now keeps direct references; 20k trades book in about 0.26 s instead of 1.8 s.
* Results are unchanged: `tests/golden.json` fingerprints every engine (Strategy 01 and variants, ORB, EMA pullback,
  the four-leg model and every runnable leg template) and `tests/golden.real.json` six of them on real day files;
  both were recorded before the change and still match.
* New tests: `tests/longrange.test.mjs` (VIX over 150k bars, 250k-session metrics, a 130k-trade ledger; each fails
  with the old code), `tests/golden.test.mts`, and `npm run test:long` (1,500 synthetic sessions through every engine
  and a small study). `npm test` now passes `--experimental-strip-types`, so the `.mts` tests run on Node 22.

## Unreleased: Dhan rate limits and failed days

* A rate limit (HTTP 429 or DH-904) now waits in minutes: 1, 2, 4, 8, then 10 minutes between the six tries
  (a longer `Retry-After` from Dhan is honoured, up to 15 minutes). Server errors keep the short backoff.
* A day that fails is skipped and recorded with its reason; the run no longer stops after three failures in a row.
* At the end of `load` and `dhan-sample`, the days that failed are listed. Run the same command again to fetch
  them; days already stored are skipped. `load` exits non-zero while any day is still failed.

## Unreleased: historical data pipeline

* Ingestion ledger (SQLite beside the Parquet store): per-day state, append-only ingest log, bhavcopy file log.
* `load` / `ensure_range` fill only missing days; holidays need both feeds empty; partial and failed days are
  recorded with reasons; atomic file writes; resume after crash or expired token; legacy markers adopted.
* Dhan client: `AuthError`, jittered exponential backoff, `Retry-After`, network-error retries, payload checks, `dhan-preflight`.
* NSE bhavcopy: UDiFF and legacy layouts, downloader, manual import, validation, contract master, reconciliation.
* Day files use bhavcopy expiry and lot size when stored. Lab shows per-range data states.
* New commands: `availability`, `bhav-download`, `reconcile`, `store-check`, `ingest-log`, `dhan-preflight`.
* `market_day_status` table in `web/supabase/market_data.sql` (re-run it in the SQL editor).

## Unreleased: Dhan pull fixes (19 Nov 2026)

* First run against real Dhan data. Rolling-option calls now fetch one day each: Dhan refuses any
  longer range (DH-905), contrary to its docs.
* Fixed: every option series written for a day replaced the previous one, so only the last series
  (PE ATM+n) survived. A day's series are now written together, and option partitions carry the expiry
  series so weekly and monthly pulls cannot overwrite each other.
* `dhan-sample` is resumable (a marker per finished day; holidays are remembered), and the new
  `dhan-quality` command writes a PASS/WARN/FAIL quality report: coverage, missing bars, bad prices,
  strike grid and reconstruction, spot vs index, ATM put-call parity, entry strike staying in the
  window, and a daily ATM straddle table for spotting expiry rolls.
* `tzdata` added on Windows (pyarrow needs it for IST timestamps).
* Sample NIFTY WEEK code 1, ATM+-10, 6-17 Oct 2025: 157,499 option bars, overall PASS.

## Unreleased: real NIFTY data on the website

* `straddloop load --start … --end …`: pull from Dhan (resumable) and upload in one command, dates typed once
  (inclusive). The Lab shows this command pre-filled when the picked dates are not stored yet.

* Day files: `straddloop supabase-upload` turns the local Parquet store into one gzip JSON file per
  trading day per expiry series (about 100 KB) in the private Supabase bucket `market-data`, plus a
  `market_days` row each. Resumable by checksum. `straddloop export-days` writes the same files locally.
* `web/supabase/market_data.sql`: `market_days`, `data_readers` and read-only policies (readers only).
* Website Lab: Synthetic or Real NIFTY (Dhan) data, date range, weekly or monthly series, lots, strike
  offset, slippage, lot-size override, and a minute-by-minute day replay. Falls back to day files on
  this computer. The page states that fills are candle-based and optimistic.
* Engine: `strike_offset` for the straddle (default 0 keeps the original rules).
* Expiry dates and lot sizes in day files are ASSUMED until the bhavcopy step confirms them.

## 0.1.0 (22 Oct 2026)

* Phase 1 foundation: package layout, settings from `.env`, IST logging with secret masking, canonical
  data schemas, provider and strategy interfaces, dated NSE cost schedules with verification flags,
  web app shell with ten sections (unbuilt ones labelled with their phase).
* Phase 2 tooling: Dhan intraday and rolling-option connector with chunking, rate limiting, retries and
  raw-response archiving; NSE UDiFF bhavcopy parser for the contract master; candle validation;
  Parquet store with dataset hashes; coverage report (JSON and Markdown).
* 22 automated tests, all passing on hand-made fixtures. Not yet run against real Dhan data.
* Strategy 1 specification v1.0.0 written.
