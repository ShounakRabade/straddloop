# Straddloop web

The Straddloop website: three customized option trading strategies written as rules, a browser lab
that reruns them on a labelled synthetic model, a four-step onboarding flow and a notebook of saved runs.

**Every figure is synthetic (dates in 2099). Nothing here is investment advice, and the site places no orders.**

| Route | What it is |
|---|---|
| `/` | Landing page |
| `/strategies/[straddle\|orb\|fourleg]` | Rules, weaknesses, default synthetic result |
| `/start` | Onboarding: four steps to a first backtest, no account needed |
| `/lab` | Change a setting, the engine reruns in a web worker. Data: synthetic model, or real NIFTY day files (see below) |
| `/notebook` | Saved runs (Supabase when signed in, this browser otherwise) |
| `/login` | Email + password or a sign-in link (Supabase Auth) |

## Run locally

```bash
cd web
npm install
cp .env.example .env.local   # optional: without keys, runs are saved in the browser
npm run dev                  # http://localhost:3000
```

## Supabase (database and auth)

1. Create a project at supabase.com.
2. SQL editor: paste `supabase/schema.sql` and run it. It creates `profiles` and `runs` with
   row-level security so each user reads and writes only their own rows.
3. Authentication > URL configuration: set the Site URL to your Vercel URL and add
   `https://YOUR-SITE/**` to the redirect URLs.
4. Project settings > API: copy the project URL and the anon (publishable) key.

## Real NIFTY data (Supabase)

Real Dhan candles are stored as one gzip JSON **day file** per trading day per expiry series in the
private Storage bucket `market-data` (`NIFTY/WEEK/2025-10-06.json.gz`, about 100 KB), with one row
per file in `market_days`. Only accounts in `data_readers` can read either. Row-per-bar would be
about 100 million rows for five years, far beyond the free plan's 500 MB.

1. Run `supabase/market_data.sql` once in the SQL editor (put your sign-in email on the last line).
2. On your computer, in the repository root, add `SUPABASE_URL` and `SUPABASE_SECRET_KEY` to `.env`
   (secret key: Project settings > API keys; it never goes in Vercel or Git).
3. `straddloop supabase-upload --underlying NIFTY --expiry WEEK --start 2025-10-06 --end 2025-10-17`.
   Re-running skips days that are already up to date.
4. Sign in on the site, open the Lab and pick **Real NIFTY (Dhan)**.

Offline: `straddloop export-days ...` writes the same files under `data/dayfiles/`; the Lab's
"Load day files from this computer" runs on them with no Supabase at all.

The format is documented in `src/straddloop/data/dayfiles.py`; the browser decoder is
`public/engine/dayfile.js`. Fills come from 1-minute candles plus the slippage setting (no bid/ask),
and expiry dates and lot sizes are assumed until the bhavcopy step confirms them. The Lab says so.

## Vercel (deployment)

1. vercel.com > Add New > Project > import `ShounakRabade/straddloop`.
2. Set **Root Directory** to `web`. Framework preset: Next.js.
3. Add environment variables `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY`.
4. Deploy. Every push to `main` redeploys.

## Engines

`public/engine/engine.js` and `fourleg_engine.js` are the browser ports of the Python engines,
copied unchanged from the strategy lab (kept identical to Python by its parity checks).
`public/engine/compute.js` reduces their output to one small shape; `worker.js` runs it off the
main thread. `npm run precompute` rebuilds `lib/precomputed.json`, the default runs shown on the
static pages.

## Design

`PRODUCT.md` (who it is for, voice, truths that are never softened) and `DESIGN.md` (colour, type,
space, motion, components) are the source of truth. The hard offset shadow is deliberate and every
element that carries it has `data-impeccable-ignore="hard-offset-shadow"`.
