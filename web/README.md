# Straddloop web

The Straddloop website: three customized option trading strategies written as rules, a browser lab
that reruns them on a labelled synthetic model, a four-step onboarding flow and a notebook of saved runs.

**Every figure is synthetic (dates in 2099). Nothing here is investment advice, and the site places no orders.**

| Route | What it is |
|---|---|
| `/` | Landing page |
| `/strategies/[straddle\|orb\|fourleg]` | Rules, weaknesses, default synthetic result |
| `/start` | Onboarding: four steps to a first backtest, no account needed |
| `/lab` | Change a setting, the engine reruns in a web worker |
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
