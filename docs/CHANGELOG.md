# Changelog

## Unreleased: real NIFTY data on the website

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
