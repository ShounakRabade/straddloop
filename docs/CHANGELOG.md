# Changelog

## 0.1.0 (22 Oct 2026)

* Phase 1 foundation: package layout, settings from `.env`, IST logging with secret masking, canonical
  data schemas, provider and strategy interfaces, dated NSE cost schedules with verification flags,
  web app shell with ten sections (unbuilt ones labelled with their phase).
* Phase 2 tooling: Dhan intraday and rolling-option connector with chunking, rate limiting, retries and
  raw-response archiving; NSE UDiFF bhavcopy parser for the contract master; candle validation;
  Parquet store with dataset hashes; coverage report (JSON and Markdown).
* 22 automated tests, all passing on hand-made fixtures. Not yet run against real Dhan data.
* Strategy 1 specification v1.0.0 written.
