# Engine interfaces (v1)

The contract between the research engine and everything built on it (Lab UI, analytics, reports).
Status: **draft, 19 Nov 2026**. Fields marked *(planned)* are agreed but not in code yet; everything
else is the shape the code will produce. Change this file in the same PR as any change to a shape.

Conventions used everywhere:

* Dates are `YYYY-MM-DD` in IST. Times inside a session are **minutes since midnight IST** (`555` = 09:15,
  `929` = 15:29, the last 1-minute bar). A bar is labelled by its start minute.
* Money is rupees, unrounded in data, rounded only for display. Option prices are premium points.
* `qty` is units (lots × lot size). `lots` is always derived as `qty / lot_size`.
* Every estimate is labelled at its source: margin is `ESTIMATED`, lot size and expiry carry a `*_source`,
  cost rows carry `verified` flags. The UI must show these labels, not drop them.

Files: engine `web/public/engine/legs.js` (pure JS, runs in the Lab worker and in Node), ledger
`web/public/engine/ledger.js`, date range `web/lib/dateRange.ts`, types `web/lib/legs/types.ts`,
templates `web/lib/legs/templates.ts`.

---

## 1. Strategy spec (leg-based)

Every strategy is a list of legs plus entry, exit and adjustment rules. Named strategies (long call,
iron condor, …) are templates that fill in a spec; the engine only ever sees a spec.

```ts
type Right = 'CE' | 'PE';
type Action = 'BUY' | 'SELL';
type Series = 'WEEK' | 'MONTH';              // which listed expiry cycle

interface StrategySpec {
  v: 1;
  name: string;
  template: TemplateId | 'custom';
  underlying: 'NIFTY';                       // the only stored underlying today
  lots: number;                              // base lots; leg qty = lots × leg.ratio × lot_size
  legs: LegSpec[];                           // 1–6 legs
  entry: EntryRule;
  exit: ExitRule;
  adjust: AdjustRule;
  execution: ExecutionSpec;
}

interface LegSpec {
  id: string;                                // 'L1', 'L2', … unique within the spec
  action: Action;
  right: Right;
  ratio: number;                             // integer ≥ 1 (ratio spreads, backspreads)
  expiry: { series: Series; nth: 1 | 2 };    // nth 1 = nearest listed expiry of that cycle, 2 = the one after
  strike: StrikeRule;
  stop?: LegLevel;                           // optional per-leg stop on the leg's own premium
  target?: LegLevel;                         // optional per-leg target on the leg's own premium
}

type StrikeRule =
  | { by: 'atm'; steps: number }             // + = steps out of the money for this leg's right, − = in the money
  | { by: 'pct'; pct: number }               // + = % of spot out of the money, − = in; nearest listed strike
  | { by: 'premium'; price: number; side: 'nearest' | 'at_most' | 'at_least' } // by entry-bar open price
  | { by: 'delta'; delta: number }           // |delta| in (0, 1); only where the dataset has reliable Greeks
  | { by: 'leg'; leg: string; steps: number }; // relative to another leg's chosen strike, + = higher strike

// Per-leg level: 'pct' of the leg's entry price, or 'points' of premium.
// Short leg: stop when premium rises to entry × (1 + pct), target when it falls to entry × (1 − pct).
// Long leg: the mirror image.
interface LegLevel { kind: 'pct' | 'points'; value: number }
```

ATM is the listed strike nearest the index close of the bar before the entry bar (ties go to the lower
strike). The strike step is read from the data (50 for NIFTY), never assumed.

```ts
interface EntryRule {
  time: string;                              // 'HH:MM'. Decision uses bars that closed before it;
                                             // the order fills at the open of the bar starting at this minute.
  weekdays: number[];                        // 0 = Monday … 4 = Friday
  dte?: { min?: number; max?: number };      // calendar days from trade date to the nearest leg's expiry
  conditions: Condition[];                   // all must pass
  frequency: 'daily' | 'when_flat';          // 'when_flat': no new position while one is held (multi-day holds)
}

type Condition =
  | { kind: 'or_inside'; or_minutes: number; candle_minutes: number; mode: 'full' | 'body' | 'close' | 'overlap' }
      // the last completed candle before entry must sit inside the opening range (the straddle's filter)
  | { kind: 'or_width_pct'; min?: number; max?: number }   // opening-range width as % of spot
  | { kind: 'gap_pct'; min?: number; max?: number }        // today's first bar open vs previous session close
  | { kind: 'move_pct'; min?: number; max?: number }       // spot at decision vs today's open
  | { kind: 'net_premium'; min?: number; max?: number };   // entry credit (+) / debit (−) in points per unit ratio

interface ExitRule {
  hold: 'intraday' | 'sessions' | 'expiry';
  sessions?: number;                         // 'sessions': exit on the Nth session after entry (1 = next)
  time: string;                              // 'HH:MM' exit time on the exit session (default 15:15)
  settle_at_expiry: boolean;                 // 'expiry': true = hold through the close and cash-settle at intrinsic
                                             // value against the index close; false = close at `time` on expiry day
  stop?: MoneyLevel;                         // position level, on mark-to-market P&L
  target?: MoneyLevel;
  basis: 'net' | 'gross';                    // net = after charges paid and the estimated charges to close
}
interface MoneyLevel { kind: 'rupees_per_lot' | 'pct_premium'; value: number }
// pct_premium is a % of |net entry premium × qty| (credit for short structures, debit for long ones).

interface AdjustRule {
  on_leg_stop: 'keep_others' | 'close_all' | 'reenter';
  max_reentries: number;                     // per leg id, for 'reenter' (the strike is selected again)
  cutoff: string;                            // 'HH:MM': no entries or re-entries at or after it
}

interface ExecutionSpec {
  slip_pct: number;                          // % of the candle price, against you on every fill
  slip_ticks: number;                        // plus this many ticks (0.05)
  stop_slip_mult: number;                    // stops pay this multiple of slippage
  stop_fill: 'gap_aware' | 'trigger';        // gap_aware = max(stop, bar open) for a short leg's stop
  brokerage_per_order: number;
  exercise_stt_pct: number;                  // STT on intrinsic value of a long ITM option at expiry (UNVERIFIED default 0.125)
}
```

Fill model (same as the existing engines): decisions use completed bars only; an order fills at the
next bar's open ± slippage; stops are checked against the bar high (short) or low (long) and fill
gap-aware with `stop_slip_mult` × slippage; when a stop and a target touch in the same bar the stop
wins and the fill is flagged `intrabar`. On synthetic data with bid/ask, fills use the quotes. Real data
has no bid/ask, so every real result says its fills are optimistic.

### Templates

`TemplateId` = `long_call`, `long_put`, `short_call`, `short_put`, `bull_call_spread`, `bear_put_spread`,
`bull_put_spread`, `bear_call_spread`, `long_straddle`, `short_straddle`, `long_strangle`, `short_strangle`,
`iron_condor`, `iron_butterfly`, `long_call_butterfly`, `long_put_butterfly`, `broken_wing_butterfly`,
`call_ratio_spread`, `put_ratio_spread`, `call_backspread`, `put_backspread`, `calendar_call`,
`calendar_put`, `diagonal_call`, `diagonal_put`. Each is `(params) => LegSpec[]` with documented
defaults (`web/lib/legs/templates.ts`). A template never adds behaviour the spec cannot express.

### Gating (what the data can and cannot support)

`validateSpec(spec, caps): { ok: boolean; errors: Gate[]; warnings: Gate[] }`. An error blocks the run with
its message; a warning runs and is printed on the report. Nothing is faked to get around a gate.

```ts
interface DatasetCaps {
  source: 'dhan' | 'synthetic';
  underlying: string;
  series: Series[];                          // expiry cycles with stored day files for the chosen dates
  nth: number[];                             // [1] today: only the nearest expiry of each cycle is stored
  strike_window: number;                     // ATM ± N strikes stored per bar (Dhan rolling: 10 near expiry)
  greeks: boolean;                           // false for Dhan candles (an IV field exists but is unvalidated)
  bid_ask: boolean;                          // false for Dhan; true for the synthetic model
  continuous: boolean;                       // consecutive sessions share contracts (true for real data;
                                             // false for the per-day synthetic model)
}
interface Gate { code: GateCode; message: string; leg?: string }
```

| Code | Severity | When |
| --- | --- | --- |
| `UNDERLYING_NOT_STORED` | error | spec.underlying is not in the dataset |
| `SERIES_NOT_STORED` | error | a leg needs a cycle (`WEEK`/`MONTH`) with no stored day files |
| `NEXT_EXPIRY_NOT_STORED` | error | a leg needs `nth: 2` (calendars, diagonals); only the nearest expiry is stored |
| `DELTA_NO_GREEKS` | error | `by: 'delta'` on a dataset without reliable Greeks |
| `STRIKE_OUTSIDE_WINDOW` | error / warning | a fixed offset beyond the stored window is an error; a rule that *can* land outside it (pct, premium, leg-relative) is a warning, and days where it does are skipped with that reason |
| `HOLD_NEEDS_CONTINUOUS` | error | `hold` ≠ intraday on a dataset whose sessions are independent (synthetic) |
| `MIXED_EXPIRY_SETTLEMENT` | warning | legs with different expiries and `settle_at_expiry`: the near leg settles, the far leg is sold at its last bar |
| `NO_BID_ASK` | warning | always on real data: fills are candle price ± slippage |
| `INVALID_SPEC` | error | structural problems (no legs, bad ratio, unknown leg reference, bad time) |

---

## 2. Run request and run result

The worker message keeps its existing shape. The leg engine is `params.strategy = 'legs'` with the spec in
`params.spec` (JSON) and account settings in the same keys as today (`capital`, `margin_policy`, …).

```ts
// main thread -> worker
{ id, params: { strategy: 'legs', spec: StrategySpec, ...AccountParams }, days?: DayRef[], range?: DateRange }
// worker -> main thread
{ id, progress: { phase: 'decode' | 'simulate' | 'ledger'; done: number; total: number } }   // (planned)
{ id, ok: true, result: RunResult, ms } | { id, ok: false, error }
```

`RunResult` (in `web/lib/types.ts`) gains, for every strategy:

```ts
interface RunResult {
  // ...existing fields (net, gross, costs, curve, account, data, …)
  days: DayOutcome[];                        // one row per session handed to the engine, in date order
  gates?: Gate[];                            // leg engine: warnings that applied to this run
  positions?: PositionRecord[];              // leg engine: one per opened position
  spec?: StrategySpec; spec_hash?: string;   // leg engine
}

interface DayOutcome {
  date: string;
  status: 'traded' | 'holding' | 'no_entry' | 'filtered' | 'excluded' | 'rejected';
  reason: string | null;                     // why it did not trade, in words ('entry condition full failed', 'opening range incomplete: index bar 09:31 missing')
  opened: number; closed: number;            // positions opened / closed that day
  net: number;                               // that day's net realised P&L from the ledger
}
```

Status meanings: `traded` = at least one fill; `holding` = a carried position, no fill; `no_entry` = the
entry rule was checked and failed; `filtered` = a weekday/DTE/filter rule skipped the day; `excluded` =
the data could not support a decision (gap in the opening range, strike not in the stored window);
`rejected` = the ledger refused every order for margin. **Invariant:** `days.length` equals the number of
runnable days in the `DateRange`, and every runnable day has exactly one outcome.

```ts
interface PositionRecord {
  id: string;                                // 'P1', 'P2', …
  opened: { date: string; t: number }; closed: { date: string; t: number } | null;
  legs: { id: string; leg: string; action: Action; right: Right; strike: number; expiry: string; qty: number;
          entry_px: number; exit_px: number | null; exit_reason: string | null }[];
  entry_premium: number;                     // net points per position (credit +, debit −), ratio-weighted
  exit_reason: string;                       // 'target' | 'stop' | 'leg_stop' | 'time' | 'expiry' | 'range_end' | …
  gross: number; charges: number; net: number;
  payoff: { max_profit: number | null; max_loss: number | null; breakevens: number[] } | null;
                                             // at expiry, single-expiry positions only; null = unbounded or mixed expiry
}
```

---

## 3. Ledger (engine → accounting)

The ledger books what the engine decided. It never decides trades and never re-prices them, except the
forced liquidation and end-of-data closes it reports separately.

Engine day result (input):

```ts
interface DayResult {
  date: string; status: DayOutcome['status']; reason: string | null;
  lot_size: number; flags: string[]; exit_reason?: string;
  fills: EngineFill[];                       // in time order
  mtm: { t: number; px: Record<string, number> }[];  // candle-close mark of every open leg, by leg id
  carry?: string[];                          // leg ids still open at day end that continue next session (NEW)
  events: { t: number; kind: string; text: string; leg?: string }[];
}
interface EngineFill {
  t: number; leg: string | number;           // leg ids must be unique across the run when carried
  action: Action; side: Right; strike: number; expiry: string; qty: number; px: number;
  reason: string;                            // 'entry' | 're-entry' | 'stop' | 'target' | 'time' | 'expiry_settlement' | …
  intrabar: boolean; kind?: string;
  settlement?: boolean;                      // NEW: cash settlement at intrinsic value; charged by settlement rules
  costs: Charges | null;                     // the engine's own cost line; reconciled against the ledger's
}
```

Ledger outputs (unchanged names; new fields marked): `fills` (one row per fill, `FILL_COLS`), `tradebook`
(one row per closed leg, `TRADEBOOK_COLS`, + `position_id` NEW), `daily` (one row per session, `DAILY_COLS`,
+ `open_legs`, `unrealised_end`, `closing_equity` NEW), `rejections`, `liquidations`, `report`.

Accounting rules (`docs/ACCOUNTING.md` is the full text): balance = capital + cumulative net realised;
equity = balance + unrealised at candle-close marks; available = balance − margin blocked − long premium
held; a leg's P&L moves from unrealised to realised exactly once. NEW for multi-day positions: a carried
leg stays open across days with its margin blocked; the day's `closing_equity` includes its unrealised
P&L; drawdown, Sharpe and Sortino use closing equity (identical to closing balance for intraday
strategies, so existing results do not change). The engine closes every position by the end of the
range, so the report never ends with an open position.

Settlement fills: price = intrinsic value against the index close on expiry day; no brokerage or
exchange charge; STT `exercise_stt_pct` on intrinsic × qty for a long ITM leg; OTM legs settle at 0 with no
charge. These rates are UNVERIFIED and flagged on the report.

Margin (`account.margin_model`, NEW): `per_leg` (today's model: (SPAN-like % + exposure %) × strike × qty
per short leg, no offsets) or `hedged` (per expiry group: the worst loss at expiry over a grid of index
levels, capped at the `per_leg` figure; long premium is held as cash, not margin). Both are ESTIMATED.

Reconciliation identities in `report.reconciliation` must all pass for any figure to be shown as final:
balance = capital + Σ tradebook net = capital + Σ daily net = capital + Σ per-fill (realised − charges);
charge components add up; every opening fill is closed; ledger charges = engine cost lines; NEW: Σ position
net = Σ tradebook net; closing equity of the last day = ending balance.

---

## 4. Trade lifecycle

```
spec ──validate──▶ gated? ─yes─▶ run refused, Gate.message shown
   │no
day ─▶ conditions/filters ─fail─▶ DayOutcome no_entry / filtered / excluded
   │pass
strikes selected (StrikeRule) ─missing price─▶ excluded ('strike not in stored window')
   │
orders at next bar open ─ledger─▶ rejected (margin) | partial | executed
   │
OPEN: marked at every bar close; per-leg stop/target; position stop/target; adjustments
   │
CLOSED by one of: leg_stop, leg_target, stop, target, time, expiry (settled), range_end,
                  data_end (no further price), forced_liquidation (ledger), unwind (an entry leg failed to fill)
```

One position = the legs opened together at one entry; each leg is one tradebook row with `position_id`.
A re-entered leg joins the same position.

---

## 5. Date range (one object for calendar, queries, run, progress, charts, report)

```ts
interface DateRange {
  request: { from: string; to: string };     // what the user picked, inclusive
  dataset: { source: 'dhan' | 'synthetic' | 'local'; underlying: string; series: Series; interval: '1m' };
  bounds: { floor: '2023-01-01'; earliest: string | null; latest_validated: string | null; latest_any: string | null };
  effective: { from: string; to: string } | null; // request clamped to [floor, min(latest_any, today IST)]; null if nothing left
  files: { date: string; path: string }[];   // the day files the run downloads (one per runnable date)
  days: DayEntry[];                          // every calendar day in `effective`, weekends included
  counts: Record<DayState, number> & { calendar: number; weekdays: number; runnable: number };
  runnable: string[];                        // the dates that will be handed to the engine
  messages: { level: 'error' | 'note'; text: string }[];
  key: string;                               // stable hash of dataset + runnable dates + file checksums
}
type DayState = 'validated' | 'partial' | 'failed' | 'downloading' | 'missing' | 'holiday' | 'weekend';
interface DayEntry {
  date: string; weekday: number;             // 0 = Monday
  state: DayState; reason: string | null;
  holiday: { name: string; source: 'pipeline' | 'nse_list_unverified' } | null;
  file: { path: string; quality: string; index_bars: number; expiry: string | null; lot_size: number | null } | null;
  is_expiry: boolean;                        // the stored file's expiry equals this date
}
```

Rules: `runnable` = validated + partial days that have a file (partial days run; their gaps stay gaps).
A weekday with no file is `holiday` when the pipeline recorded one or the (unverified) NSE list names it,
otherwise `missing`. Weekends are never "missing". The end date is never hardcoded: `bounds.latest_*` come
from the database for the chosen underlying and series. Presets end on `latest_any` (the last day a run can
use). `last_7/30/90` count stored usable days backwards; `6m/1y/2y/3y` start the day after the same calendar
date N months earlier, clamped to `earliest`; `max` = `earliest` → `latest_any`.

`buildDateRange(request, inventory, statuses, opts)` options: `source` ('dhan' | 'local': local files are
`partial`, quality unchecked), `underlying`, `series`, `floor` (default 2023-01-01), `today` (default today in
IST). The NSE holiday list (`NSE_HOLIDAYS_UNVERIFIED`, 2023–2025, recalled, not verified) is built in and
only labels weekdays that have no file.

Every surface reads this one object: the calendar shades `days`, the run downloads `runnable`, progress
counts `runnable.length`, the result carries `range.key`, and the report prints `counts`. The run result's
`days` (section 2) is joined to `range.days` by date, so "N days will run" and "N days ran" are the same N,
and each non-trading day shows its reason.

## 6. Data availability API (`web/lib/marketData.ts`)

```ts
inventory(underlying, series): Promise<Availability>          // existing: every market_days row (RLS: readers only)
statuses(underlying, series): Promise<StatusRow[]>            // existing: market_day_status rows, [] if the table is absent
datasetBounds(underlying, series): Promise<{ earliest; latest_validated; latest_any; days }>   // NEW
buildDateRange(request, inventory, statuses, opts): DateRange // NEW, pure (lib/dateRange.ts)
presetRange(preset, inventory, statuses): { from; to } | null   // NEW, pure
loadCommand(range): string | null                             // NEW: `straddloop load …` for what is missing
```

`latest_validated` = the latest `trade_date` whose status is `validated` (or, without a status row, whose
file quality is `complete`). No new database objects are needed; `market_day_status` (already in
`web/supabase/market_data.sql`) adds per-day reasons when it exists.

## 7. What the data supports today

| Need | Supported? |
| --- | --- |
| NIFTY weekly, nearest expiry, ATM ± 10 strikes, 1-minute candles | yes, 6–17 Oct 2025 stored (10 sessions) |
| NIFTY monthly series | only if MONTH day files are uploaded (none are today) |
| Next expiry (`nth: 2`), so calendars and diagonals | no: not pulled (Dhan code 2 is ATM ± 3) |
| Strikes beyond ATM ± 10 | no |
| Bid/ask | no: fills are candle ± slippage, flagged optimistic |
| Greeks / delta strikes | no on real data; yes on the synthetic model (its vol is known) |
| Other underlyings | no stored data |
| Multi-day holds and expiry settlement | real data yes (contracts continue across stored days); synthetic no |
