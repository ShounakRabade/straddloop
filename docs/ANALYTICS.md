# Research analytics: regimes, optimisation, robustness, diagnostics, assistant

Code: `web/public/engine/analytics.js` (pure JS; runs in the Lab worker and in Node). Hooks it needs from the
run: `compute.evaluate()` and `compute.lastRun()` in `web/public/engine/compute.js`. Tests:
`web/tests/analytics.test.mjs` (`cd web && npm test`).

Nothing here calls a network service or a language model. Running costs: ₹0.

## 0. What the data can support today

Supabase holds **10 NIFTY weekly sessions, 6 to 17 Oct 2025** (checked against `market_days` on 19 Nov 2026).
That is far too few for optimisation or regime claims. The code is built for years of data and says so
in every output instead of hiding it:

* every statistic carries its sample size and a sample class (`too few to judge` < 10 traded days, `thin`
  < 30, `moderate` < 100, `good` < 250, `large`);
* the robustness score is **capped at 30 below 30 traded days and at 70 below 100**, and the verdict is
  `Inconclusive` below 30 traded days whatever the components say;
* models that need history (k-means, HMM, volatility forecast, entry-filter model) do not run below their
  minimum and print the reason with the actual count;
* regime rows with fewer than 5 traded days are marked "too few to rely on".

On 10 sessions the optimisation lab runs (so the method can be inspected) but its train / validation /
test windows are 6 / 2 / 2 sessions and PBO cannot run. Read it as a demonstration of the procedure.

## 1. Inputs and the run-result adapter

The ledger is the only source of money figures (see `docs/ENGINE_INTERFACES.md`). `fromRun(run)` turns a
finished run into one **day record** per session:

| Field | Source |
| --- | --- |
| `net` | change in the ledger's closing equity (equals net realised P&L for intraday strategies; marks carried positions daily) |
| `gross`, `costs`, `util_pct`, `peak_margin`, `rejected`, `exit_reason` | ledger daily row |
| `status`, `reason` | `RunResult.days` when present, else the engine's day results; sessions the ledger never saw are `excluded` |
| `is_expiry_day`, `dte` | engine day results (expiry dates are **assumed** until the bhavcopy confirms them) |

Statistics per traded day (win rate, average, profit factor, payoff) use traded days only. Statistics per
session (Sharpe, Sortino, drawdown, per-session average) count idle days as 0. Excluded days never count.

Research runs call `compute.evaluate(params, sessions)`: the same engine configuration and the same ledger
as a Lab run, but without replacing the run the page shows (replay and exports stay on it).
`tests/analytics.test.mjs` checks that the original configuration's net in a study equals a normal Lab run.

## 2. Regimes (Part 6)

Features come only from the stored **index 1-minute candles**:

| Feature | Definition | Look-back |
| --- | --- | --- |
| Realised vol | √(Σ 1-minute log returns² × 252), annualised %; excludes the overnight move | the session |
| Range | (high − low) / open | the session |
| Trend | close / open − 1 | the session |
| Efficiency | \|close − open\| / (high − low) | the session |
| Opening-range width | high − low of the first 30 minutes / open | first 30 minutes |
| Previous session's vol | realised vol of the previous stored session | earlier session |
| Gap | open / previous stored close − 1; only if at most one weekday is missing in between | earlier session |
| True range, ATR | true range vs previous close; ATR = simple mean of the previous 14 true ranges, null until 14 exist | earlier sessions |

Synthetic sessions are generated independently and all open at the same price, so gap, ATR and
multi-day measures are **not computed** on synthetic data, and the regime panel says so.

Dimensions, each labelled with **when it is known**:

| Dimension | Known | Labels (default thresholds) |
| --- | --- | --- |
| Volatility (the session) | after the close | Low < 10% ≤ Normal < 15% ≤ Elevated < 22% ≤ Extreme |
| Volatility coming in | before entry | same bands on the previous session's vol |
| Trend | after the close | Strong bullish ≥ +0.75%, Weak bullish ≥ +0.25%, Sideways, Weak bearish, Strong bearish |
| Session type | after the close | Trending (efficiency ≥ 0.5), Mixed, Mean-reverting (≤ 0.25) |
| Intraday range | after the close | Low < 0.6% ≤ Normal < 1.2% ≤ High |
| Opening gap (real data) | before entry | Gap-up ≥ +0.3%, Flat, Gap-down ≤ −0.3% |
| Range vs ATR (real data) | after the close | Expansion ≥ 1.25× ATR, Contraction ≤ 0.75×, Warm-up |
| Expiry cycle | before entry | Expiry day, Day before expiry, Other (assumed expiry dates) |

"After the close" labels describe what the day turned into: they explain results, they cannot be used as
filters. "Before entry" labels can.

Thresholds are fixed by default, so no session's label depends on any other session. **Percentile mode**
uses only earlier sessions (expanding window: 25th / 75th / 95th percentiles for volatility) and labels the
first 20 sessions `Warm-up`. The test "no look-ahead" checks that adding later sessions never changes an
earlier session's features or labels.

Per regime the lab reports sessions, traded days, net, average traded day with its 95% t-interval, win
rate, profit factor, maximum drawdown inside that regime's sessions, average and peak utilisation (from the
ledger), share of total P&L, and regime consistency (share of regimes with ≥ 5 traded days whose average day
was positive, and whether the best and worst regimes' intervals overlap).

**Not available, and never fabricated:** India VIX, historical implied volatility, event calendar, market
breadth. None is ingested; the panel lists them with the reason. No session is labelled event-driven.

### Chronological models (Part 8 C/D)

| Model | What it answers | Minimum | Leakage control |
| --- | --- | --- | --- |
| k-means (k = 3) on standardised vol, range, \|trend\|, efficiency | a data-driven regime split | 60 sessions | standardisation and centroids fitted on the first 60% only |
| 2-state Gaussian HMM on log realised vol | calm vs high-vol state and how long states persist | 120 sessions | Baum-Welch on the first 60%; every session labelled by **forward filtering** (no smoothing, so no later session is used) |
| AR(1) on log realised vol | does yesterday's vol forecast today's better than "same as yesterday" or the mean? | 60 sessions | fitted on the first 60%, scored only on later sessions |
| L2 logistic regression on ex-ante features (gap, previous vol, opening-range width, expiry) | can facts known before entry tell winning days from losing ones? | 80 traded days | trained on the first 60% of traded days; accuracy, Brier score and AUC on later days vs the base rate |
| Random forest, gradient boosting | not evaluated | — | with fewer than ~1,000 independent sessions they mostly memorise noise; the logistic baseline has to beat chance first |

No model output is used to claim a profit. A model that does not beat its baseline says so.

## 3. Optimisation lab (Part 7)

**Search space.** `PARAM_SPACE` lists what can be searched per strategy: Lab settings (stop, target,
re-entry, entry filter, strike) and engine settings without a Lab field (exit time, re-entry cutoff, daily
loss cap, skip expiry day, opening-range width filter; for the ORB: latest entry, exit time, max hold).
The user picks values or a min/max/step per parameter. Slippage, brokerage and capital are assumptions,
not parameters, and are never searched.

**Search.** Grid when the product fits the budget (default 200 runs), otherwise seeded random sampling of
the same grid. Bayesian optimisation is **not used**: one run costs milliseconds to a second, the spaces
are a few hundred points, and an adaptive search on a small sample concentrates evaluations where noise
looks best, which raises overfitting. Your own settings are always candidate 0.

**Objectives.** Net profit, CAGR (windows ≥ 1 year only), Sharpe (per session, idle days 0, √252), Sortino,
profit factor, win rate, smallest maximum drawdown, return on peak estimated margin, net ÷ maximum
drawdown, or a custom weighted objective: the weighted mean of each configuration's percentile rank on the
chosen metrics (scale-free). A configuration with fewer than the minimum trades in a window (default 10%
of the training sessions, at least 3) is not eligible in that window.

**Windows.** Sessions are split chronologically, default 60 / 20 / 20, into training, validation and a
held-out test. Configurations are ranked on training; the **selected** configuration is the best
validation score among the top 10 by training. The test window decides nothing: it is reported only for
the selected configuration and for yours. Every session is simulated once over the whole range and
sliced by date, so every window sees exactly the same simulation. Trades are intraday, so no embargo
between windows is needed; multi-day strategies will need one (planned with the leg engine).

**Walk-forward.** Rolling (fixed training length) or anchored (training from the first session). Each fold
chooses the best configuration on its training window only and records what it did on the next test
window; the stitched out-of-sample days are compared with your settings on the same days. Reported:
fold-by-fold choices, out-of-sample net and statistics, walk-forward efficiency (out-of-sample ÷ in-sample
P&L per session) and how often the choice changed. The test "walk-forward windows never overlap" rewrites
every test window and checks that no choice changes.

**Sensitivity.** One parameter at a time, one and two steps either side of the selected value, on
training + validation. Retention = mean share of the score kept by the neighbours (0 to 1). A cliff is the
worst neighbour's net.

**Cost stress.** Slippage +0.5 point, slippage doubled, brokerage doubled, statutory charges +25%, and all
together, for your settings and the selected ones. Break-even slippage: bisection between the run's
slippage and +5 points (6 steps, ±0.08 point). The statutory scenario scales the dated rates in the engine
and the same components of the ledger's per-fill charges after booking; margin decisions are not
re-simulated for that small difference.

**Monte Carlo.** On the traded-day P&L sequence, 2,000 paths, seeded: circular block bootstrap (block ≈ n^⅓)
for the distribution of total P&L, probability of a loss and drawdown percentiles; random reordering of
the same days for drawdown risk with the total fixed; probability that drawdown exceeds 5 / 10 / 20% of
capital. Below 10 traded days the result is labelled "too few to judge".

**Overfitting diagnostics.** Probability of backtest overfitting by combinatorially symmetric
cross-validation (Bailey, Borwein, López de Prado and Zhu, 2015; needs ≥ 4 configurations and ≥ 20
sessions); deflated Sharpe ratio for the selected configuration given the number of configurations tried
and the variance of their Sharpe ratios (Bailey and López de Prado, 2014); Spearman rank agreement of the
configurations between training and validation; training vs held-out test per session.

**Never applied automatically.** The study returns numbers. Loading the selected configuration into the
Lab is a separate, explicit action; saving it is the notebook's normal save.

## 4. Robustness score (Part 8 E)

Ten components, each 0–100 with its formula shown on the page, combined as Σ(weight × score) ÷ Σ(weight)
over the components that could be computed:

| Component | Weight | Score |
| --- | --- | --- |
| Out-of-sample result | 2 | 100 × Φ(t) of the stitched walk-forward days; without a study, share of the three chronological thirds that made money (labelled "not a true out-of-sample test") |
| Number of traded days | 1.5 | 100 × ln(n) / ln(250) |
| Profit factor | 1 | 0 at ≤ 1.0, 100 at ≥ 1.8 |
| Maximum drawdown | 1 | 100 at ≤ 5% of capital, 0 at ≥ 30% |
| Parameter stability | 1.5 | 100 × mean retention of the neighbours |
| Regime consistency | 1 | share of volatility and trend regimes (≥ 5 traded days) with a positive average day |
| Monte Carlo | 1 | 100 × (1 − probability of a loss) |
| Room for worse fills | 1.5 | 100 × (break-even slippage − run slippage) / 1.5 points |
| Data completeness | 1 | share of sessions usable, minus partial days and assumed lot sizes / expiries; synthetic capped at 40 |
| Statistical uncertainty | 1.5 | 100 × t / 3 of the average traded day |

Caps: 30 below 30 traded days, 70 below 100. Verdict: `Inconclusive` below 30 traded days or when under 60%
of the weight could be computed; otherwise `Holds up` ≥ 70, `Mixed` ≥ 50, `Fragile` below. Reported
separately, never blended into one number: **statistical confidence** (t, interval, deflated Sharpe),
**backtest robustness** (the robustness-group components), **data quality**, and **model uncertainty**
(synthetic model, candle fills without bid/ask, estimated margin, unverified pre-Oct-2024 rates, assumed expiries).

## 5. Diagnostics (Part 8 B)

Each diagnostic has a value, a status (ok / watch / warn / n/a) and a sentence.

* Concentration: share of net profit from the best day, the best 3 days, the best month; dependence on one
  exit type; dependence on one volatility regime.
* Fragility: charges as a share of gross profit; payoff ratio against the win rate it needs; worst day ÷
  average winning day; break-even slippage; the most sensitive parameter.
* Overfitting (after a study): configurations tried vs sessions; held-out test vs training; walk-forward
  efficiency; PBO; deflated Sharpe; training/validation rank agreement.

## 6. Research assistant (Part 8 A)

Template-driven, deterministic, no language model, cost ₹0. Sections: how the strategy works, what
happened, what worked, what hurt, how capital was used, how reliable it is, what the optimisation means,
what to test next. Every number in the text is a **fact** (id, label, value, display text) listed under
the text with its source, and every sentence names the facts it uses. The test "assistant" extracts every
number from every sentence and fails if one is not in a referenced fact or a computed result passed in.

An LLM was considered and not used: the explanations needed here are a fixed set of readings of computed
numbers, templates do that exactly and for free, and a model would add a way to state numbers that were
never computed.

## 7. Audit findings in this area

| Finding | Severity | Status |
| --- | --- | --- |
| The headline 95% range used z = 1.96 at every sample size; at 3 traded days the right multiplier is 4.30, so the range was less than half as wide as it should be | High (overstated certainty) | Fixed in `compute.js` and `ledger.js` (Student t) |
| With one traded day the Lab showed "95% range +₹1,873 to +₹1,873", a zero-width interval that reads as certainty | High | Fixed: no interval below two observations; the KPI says "One observation has no range" |
| `engine.js` `sensitivity()` and `walkForward()` exist but nothing calls them; its walk-forward chooses on folds of equal size with no validation window | Low (unused) | Left unchanged (the file mirrors the Python engine); the lab uses `analytics.js` |
| `engine.js` `regimeTags()` uses one day's return only (±0.5%) | Low (unused) | Superseded by `classify()` |
| No VIX, IV, event or breadth data anywhere in the store | Data gap | Reported on every regime panel; nothing fabricated |

## 8. Feature status

| Feature | Status |
| --- | --- |
| Session features, regime dimensions, fixed and expanding-percentile thresholds | implemented-and-tested |
| Per-regime P&L, win rate, drawdown, profit factor, trades, utilisation, consistency | implemented-and-tested |
| India VIX / IV / events / breadth regimes | not available (data not ingested) |
| k-means, 2-state HMM, AR(1) vol forecast, logistic entry filter, with gates | implemented-and-tested (HMM recovery, AR fit, gates); cannot run on today's 10 sessions |
| Random forest / gradient boosting | not evaluated (reason above) |
| Grid and random search, objectives incl. custom weighted, minimum-trade eligibility | implemented-and-tested |
| Train / validation / held-out test, selection rule | implemented-and-tested (selection ignores the test window) |
| Walk-forward rolling and anchored | implemented-and-tested (no-leakage test) |
| Sensitivity, cost stress, break-even slippage, Monte Carlo | implemented-and-tested |
| PBO, deflated Sharpe, rank agreement | implemented-and-tested (known cases) |
| Robustness score with caps and the four separate assessments | implemented-and-tested |
| Diagnostics | implemented; covered by the end-to-end test |
| Research assistant | implemented-and-tested (grounding test) |
| Bayesian optimisation | not implemented (reason above) |
| Four-leg stock model | not covered: synthetic monthly model with no index candles or ledger |
| Leg engine (`strategy: 'legs'`) | planned: `fromRun` already reads `RunResult.days` and closing equity; `evaluate` needs the leg engine's cfg builder when it lands |
