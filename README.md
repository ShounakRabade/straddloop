# Straddloop

A personal research platform for testing Indian options strategies on real historical data, after
costs, with every trade auditable. It is for research and, later, paper trading. Live order placement
does not exist in this codebase and will only be added after the Phase 12 review and your explicit
approval.

## Status (v0.1.0, 22 Oct 2026)

| Area | State |
| --- | --- |
| Phase 1 foundation: package, settings, logging, dated cost schedules, provider interface, strategy interface, web app shell | Built, tested |
| Phase 2 data proof: Dhan connector, NSE bhavcopy contract-master import, validation, coverage report | Built and tested on hand-made fixtures; **not yet run against Dhan** (needs your token) |
| Phase 3 onward: engine, strategies, charts | Not started |

No market data ships with the repository, and no result anywhere in it comes from real data yet.

## Setup

```bash
python -m venv .venv && source .venv/bin/activate     # Windows: .venv\Scripts\activate
pip install -e ".[dev]"
cp .env.example .env                                   # then fill in DHAN_CLIENT_ID and DHAN_ACCESS_TOKEN
python -m pytest -q                                    # 22 tests
straddloop status                                      # shows whether credentials are set (never their values)
straddloop serve                                       # http://127.0.0.1:8600
```

## Phase 2: pull the data sample

```bash
straddloop dhan-check-ids                              # confirm NIFTY/BANKNIFTY/SENSEX security ids
straddloop dhan-sample --underlying NIFTY --start 2026-09-01 --end 2026-10-01
# downloaded NSE UDiFF F&O bhavcopy zips for the same dates:
straddloop import-bhavcopy path/to/BhavCopy_NSE_FO_*.zip
straddloop coverage                                    # rebuilds the report from what is stored
```

Raw API responses are archived under `data/raw/dhan/` next to the request that produced them.
Validated candles go to `data/store/` as Parquet. Reports go to `data/reports/`.

## Layout

| Path | Purpose |
| --- | --- |
| `src/straddloop/data/providers/` | Provider interface and the Dhan connector (no other module talks to Dhan) |
| `src/straddloop/data/` | Canonical schemas, validation, Parquet store, coverage report |
| `src/straddloop/reference/` | Contract master (bhavcopy import), dated cost schedules |
| `src/straddloop/strategies/` | Common strategy interface (engine arrives in Phase 3) |
| `src/straddloop/app/` | FastAPI web app |
| `docs/` | Data-source register, assumptions, limitations, strategy specs, changelog |

## Rules this codebase follows

* Strategies never see a provider; research code reads only the validated store.
* Missing prices are flagged, never filled with estimates.
* Costs come from dated schedules; an exchange or period without a schedule stops the run.
* Secrets live only in `.env` (ignored by Git) and are never logged or displayed.
