# NSE bhavcopy pipeline

Purpose: an **independent, official daily source** that (1) says which contracts and expiries really existed
on each day, with board lot sizes, (2) lets Dhan's candles be checked where the two overlap. It is daily data
only. It has no intraday candles and is kept in its own dataset (`contracts`), never mixed with candles.

## Sources (official NSE F&O reports)

| Layout | Used for | Location (as published; **not fetched from the build environment, unverified**) |
| --- | --- | --- |
| UDiFF "Common Bhavcopy Final" | trade dates from 8 Jul 2024 | `https://nsearchives.nseindia.com/content/fo/BhavCopy_NSE_FO_0_0_0_YYYYMMDD_F_0000.csv.zip` |
| Legacy `fo<DD><MON><YYYY>bhav.csv.zip` | before 8 Jul 2024 | `…/content/historical/DERIVATIVES/<YYYY>/<MON>/fo<DD><MON><YYYY>bhav.csv.zip` on `nsearchives.nseindia.com`, then `archives.nseindia.com` |

The layout is detected from the header, so renamed files still parse; an unknown header is rejected with the
column list (never guessed). Captured per option contract: underlying, expiry, strike, CE/PE, open, high, low,
close, settlement price, volume, open interest, change in OI, underlying price and lot size (UDiFF only; the
legacy layout has neither of the last two).

Volume units differ: UDiFF publishes quantity, legacy publishes contracts (lots). They are stored as
published. Reconciliation reports the Dhan/NSE volume ratio rather than asserting a unit.

## Storage

* Raw: `data/raw/nse/fo/<YYYY>/<file>` exactly as received. Never edited.
* Processed: `data/store/contracts/…` Parquet, one partition per (symbol, day), replaced on re-import.
* Log: `data/store/ledger.sqlite` table `bhav_files` (date, layout, status, sha256, bytes, rows, origin
  `nse` or `manual`, detail) and the shared `ingest_log`.
* States: `ok`; `unavailable` (404 on every URL: holiday, not yet published, or no longer hosted; retried
  after 7 days or with `--refetch`); `failed` (download or parse error; retried next run).

Validation before insert: option type CE/PE, strike > 0, expiry ≥ trade date, no negative prices or
quantities, high ≥ low, close inside the day's range, duplicates within a file, a file holding several trade
dates, truncated or corrupt zip, a file whose date differs from the one requested. Bad rows are dropped and
counted in the ledger; good rows still load.

## Commands

```bash
straddloop bhav-download --start 2025-01-01 --end 2025-10-31      # resumable; symbols default NIFTY,BANKNIFTY,FINNIFTY,MIDCPNIFTY
straddloop import-bhavcopy ~/Downloads/bhav/                       # manual path: files or a folder
straddloop reconcile --start 2025-10-06 --end 2025-10-17          # Dhan vs bhavcopy, per day
straddloop ingest-log                                              # what was ingested, with status
```

## If NSE blocks the script

NSE sometimes refuses scripted downloads (HTTP 401/403, or an HTML "Access Denied" page). The run then stops
with a message and exit code 2; nothing is recorded as failed for the blocked dates. What you do by hand:

1. Open <https://www.nseindia.com/all-reports-derivatives> in a browser.
2. For each trading day you need, download **"F&O – UDiFF Common Bhavcopy Final (zip)"**. For dates before
   8 Jul 2024 use the older **"F&O – Bhavcopy (csv)"** from the historical reports page
   (<https://www.nseindia.com/report-detail/fo_eq_security>). Put the zips in one folder; do not unzip.
3. Run `straddloop import-bhavcopy <folder>`. The trade date is read from each file's contents.

Five years is about 1,250 files. If NSE's date picker only offers a limited span, download in chunks.

## What the bhavcopy is used for

* **Expiry dates and lot sizes.** `ContractMaster` resolves "WEEK code 1" to the nearest listed expiry on or
  after the trade date, from that day's own file (holiday shifts and the Thursday→Tuesday change come from
  what NSE listed, not a rule). Day files use it automatically and label the source `nse_bhavcopy`; without a
  bhavcopy they stay labelled `assumed`.
* **Reconciliation** (`straddloop reconcile`): Dhan's highest high must not exceed NSE's high and the lowest
  low must not undercut NSE's low; open (for full-session contracts) and end-of-day OI must agree; strikes
  Dhan has but NSE lacks are counted; no bhavcopy gives `NO_REFERENCE`, which is **not** a pass. A wrong
  expiry shows up as a FAIL.

Assumption to check on the first real day: expiry code 1 on an expiry day means that day's own contract.
