# Straddloop

A personal research platform for testing Indian options strategies on real historical data, after
costs, with every trade auditable. It is for research and, later, paper trading. Live order placement
does not exist in this codebase and will only be added after the Phase 12 review and your explicit
approval.

## Status (v0.1.0, 22 Oct 2026)

| Area | State |
| --- | --- |
| Phase 1 foundation: package, settings, logging, dated cost schedules, provider interface, strategy interface, web app shell | Built, tested |
| Phase 2 data proof: Dhan connector, NSE bhavcopy contract-master import, validation, coverage and quality reports | Dhan sample (NIFTY weekly, ATM±10, 6-17 Oct 2025) pulled and **passes** the quality report; bhavcopy import not yet run on real files |
| Phase 3 onward: engine, strategies, charts | Not started |

No market data ships with the repository, and no result anywhere in it comes from real data yet.

## Setup

```bash
python -m venv .venv && source .venv/bin/activate     # Windows: .venv\Scripts\activate
pip install -e ".[dev]"
cp .env.example .env                                   # then fill in DHAN_CLIENT_ID and DHAN_ACCESS_TOKEN
python -m pytest -q                                    # 24 tests
straddloop status                                      # shows whether credentials are set (never their values)
straddloop serve                                       # http://127.0.0.1:8600
```

## Phase 2: pull the data sample

```bash
straddloop dhan-check-ids                              # confirm NIFTY/BANKNIFTY/SENSEX security ids
straddloop dhan-sample --underlying NIFTY --start 2025-10-06 --end 2025-10-18   # end exclusive
straddloop dhan-quality --underlying NIFTY --start 2025-10-06 --end 2025-10-18  # rebuild the report only
# downloaded NSE UDiFF F&O bhavcopy zips for the same dates:
straddloop import-bhavcopy path/to/BhavCopy_NSE_FO_*.zip
straddloop coverage                                    # rebuilds the report from what is stored
```

Dhan's expired-options endpoint takes one day per call, so a pull costs 2 x (2 x window + 1) calls per
trading day (42 at ATM±10): about 10 seconds a day, about 3.5 hours for five years. The pull is
resumable: stop it at any time and run the same command again; finished days and holidays are skipped
(`--refetch` asks again). Read `data/reports/quality_*.md` before trusting a pull.

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

## Website

`web/` holds the Straddloop website (Next.js, Supabase, Vercel): the three strategy rule sets, a
browser lab on synthetic data, onboarding and a notebook of saved runs. See `web/README.md` for
local setup, the Supabase schema and Vercel deployment. Every figure on the site is synthetic and
nothing on it is investment advice.

## Backtest accounting

The Lab runs every straddle and ORB backtest through a fill-by-fill ledger (capital, estimated margin, dated statutory charges, realised/unrealised P&L) and produces a reconciled report with CSV exports. Rules, audit findings and per-feature status: `docs/ACCOUNTING.md`. Tests: `cd web && npm test`; browser journey: `web/tests/e2e/journey.cjs`.
