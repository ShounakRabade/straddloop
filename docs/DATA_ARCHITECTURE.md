# Historical data architecture

## The decision

Backtests never call Dhan. Dhan is only used to **fill the local store**, once per missing day.

| Option | Verdict |
| --- | --- |
| Call Dhan on every backtest | Rejected. One day of ATM±10 options is 42 calls (about 10 s); a one-year run would be about 40 minutes and a 5-year run about 3.5 hours, every time. It would also fail whenever the token has expired or Dhan is down, and results could change between runs. |
| Local store only, filled by hand | Works but gives no answer to "what is missing, and is what I have any good?" |
| **Hybrid (chosen)**: persistent local store + ledger, fill only missing days, backtests read the store | Fetch cost is paid once per day. A run is reproducible: the store's hash identifies the data. Missing days are visible, never filled. |

Three layers, each with one job:

1. **Store** (`data/store/*.parquet`, partitioned by source, underlying, series, date). The data. One file per
   (symbol, series, day), replaced whole, written to a temp file and renamed, so a day is never half-written
   and re-writing it can never duplicate rows.
2. **Ledger** (`data/store/ledger.sqlite`). The state of the data: per day `validated`, `partial`, `failed`,
   `downloading`, `holiday` (no row = missing), plus an append-only `ingest_log` with source, row counts,
   dropped-row counts and schema version, and a `bhav_files` table for exchange files.
3. **Day files** (Supabase Storage, private bucket; `market_days` and `market_day_status` index tables). A
   read-optimised copy of the store for the website. Built from the store; only validated and partial days
   are published. Stays inside the free plan (see `web/supabase/market_data.sql`). No second database.

## How a day gets in

`straddloop load` (or `ensure_range` in code):

1. Ask the ledger which days in the range are not usable: missing, failed, interrupted, or stored with a
   narrower strike window than requested. Everything else is skipped without an API call.
2. Fetch index candles for the missing runs (one call per ≤90 days), then each missing day's option series.
3. Judge the day from counts alone (`judge_day`), without changing any price:
   * `validated`: index ≥99% of 375 bars, both ATM series ≥95%, every series present;
   * `partial`: fetched, with the reasons stated (series empty, ATM short of bars, index short);
   * `failed`: options empty while the index shows a session, or an API error;
   * `holiday`: index feed **and** option feed both empty. If the index was not consulted the holiday is
     recorded as *unconfirmed*; it is never silently trusted.
4. Rows that are impossible (bad OHLC, duplicate, outside session, off-grid) are dropped and counted before
   anything is written. Missing candles stay missing: nothing is filled with zeros or copies.
5. Write the file (atomic rename), then the ledger row. A crash between the two leaves a stale
   `downloading` row, which the next run clears; the day is simply fetched again.
6. An expired token (`AuthError`) stops the run at once and marks nothing failed; three failed days in a row
   stop the run too. Everything finished before is kept; re-running resumes.

Days stored before the ledger existed are adopted on first use: each is re-judged from the stored rows, not
trusted from the old marker.

## What the user sees

`straddloop availability --start … --end …` and, on the website, a line under the Lab's date boxes:
validated, partial, failed, downloading, not stored, holidays, with the recorded reason for each problem day.
Weekends are not "missing". A weekend session (the exchange occasionally holds one) is expected only when a
bhavcopy proves it.

## Dhan: what was checked

Verified live earlier by the project owner (19 Nov 2026): rollingoption takes only a one-day window
(`fromDate == toDate`), 375 one-minute bars a day, expiry codes 1 and 2 work and 0 is refused, ATM±10 works and
ATM+11 is empty, weekends return empty 200s. **Not** verified from the build environment (api.dhan.co was
blocked): the error-code table, the `/profile` endpoint, the real five-year depth per interval and instrument.
Run the commands at the end of the PR to measure them. Do not assume five years until the first coverage
report says so.

| Item | State |
| --- | --- |
| Token handling | 401, DH-901/902/903 raise `AuthError` with fix instructions, no retry, nothing marked failed. The token is never in an error message, log or ledger. `straddloop dhan-preflight` shows token expiry and data plan (endpoint not verified live). |
| Rate limit | Client-side limiter (default 4/s against Dhan's documented 5/s for data APIs). |
| Retry | 429, 5xx, DH-904/908/909 and network errors retry with exponential backoff and jitter (honours `Retry-After`), then fail the day. 400/DH-905 are not retried. |
| Response validation | Non-JSON, non-object, error bodies inside a 200, null OHLC, non-ascending or non-numeric timestamps, mismatched array lengths are rejected before parsing. |
| Network failure vs the store | Raw archive and parquet writes are atomic; ledger rows change only after the data file is in place. |
| Batching | The index endpoint takes ≤90 days per call (used). The options endpoint is one day, one strike, one side per call: it cannot be batched. |
| Security ids / segments | NIFTY 13, BANKNIFTY 25, SENSEX 51 (IDX_I; NSE_FNO / BSE_FNO) unchanged; confirm with `dhan-check-ids`. |

## Status of each requirement

See the table in the pull request description; `tests/` holds the evidence for every "tested" label.
