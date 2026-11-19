# Straddloop: product context

## What it is
Straddloop is a research site for three custom option-trading strategies on Indian markets (NSE).
Each strategy is written down as formal rules, simulated fill by fill, charged every cost, and then
measured. The site explains the rules, lets a visitor rerun the simulation in the browser, and keeps
their runs in a notebook.

## Name
**Straddloop**, not "COTS". Reasons: it is already the name of the repository and Python package;
it is distinctive and searchable; it says what the product does (a straddle, tested in a loop).
"COTS" already means "commercial off-the-shelf" to anyone in software, which is close to the
opposite of "customized". The descriptor "customized option trading strategies" is kept as the
tagline, not the name.

## Who it is for
1. **The owner** (a retail options trader in India who writes their own rules) and people they
   share a strategy with.
2. **Curious traders** who have heard a rule ("sell the 9:50 straddle with a 36% stop") and want to
   see what it does after costs before risking money.

They know options vocabulary (ATM, lots, premium, expiry). They do not necessarily know statistics;
confidence intervals and walk-forward need one plain sentence each.

## The three strategies
| Slug | Name | Market | Shape |
|---|---|---|---|
| `straddle` | Intraday ATM short straddle | NIFTY / BANK NIFTY, 5-min | Short premium, 36% leg stops, one re-entry |
| `orb` | Opening range breakout, long options | NIFTY / BANK NIFTY, 5-min | Long call or put on a confirmed breakout |
| `fourleg` | Monthly four-leg ratio structure | RELIANCE, HDFCBANK, ICICIBANK, SBIN, daily | 3 short / 5 long, ₹50 wings |

## Non-negotiable truths (never soften, never hide)
* Every number on the site comes from a **labelled synthetic model**. No real NSE data. Dates are in 2099.
* On that model the default rules **lose money** in all three strategies. The site says so plainly.
  The value is the method, not a promise.
* **Not investment advice.** No live order placement exists.
* Costs (brokerage, STT, exchange, SEBI, stamp, GST, slippage) are always included.

## Voice
Plain, exact, a little dry. A trader's notebook, not a brokerage ad. Say what a number means and
what it cannot mean. No hype words (unlock, supercharge, alpha, edge guaranteed). Rupee amounts use
Indian grouping (₹2,42,953). Times are IST.

## Surfaces and modes
| Route | Mode | Success |
|---|---|---|
| `/` | Persuade | Visitor starts onboarding or opens a strategy |
| `/strategies/[slug]` | Read | Visitor can restate the rule and its main weakness |
| `/start` | Operate (first run) | Visitor sees their first backtest in under a minute, before any sign-up |
| `/lab` | Operate | Visitor changes one parameter and reads the consequence |
| `/notebook` | Operate | Visitor finds a saved run again |
| `/login` | Operate | Sign in or create an account without leaving context |

## Platform
Web, responsive from 360px. Next.js on Vercel, Supabase for auth and saved runs. Works without
Supabase keys (runs saved in the browser) so the site never looks broken.
