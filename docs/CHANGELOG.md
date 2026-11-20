# Changelog

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
