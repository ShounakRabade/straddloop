# Engine interfaces (v1)

The contract between the research engine and everything built on it (Lab UI, analytics, reports).
Status: **v1, 24 Nov 2026**, matches the code on `fix/run-reliability` (v1 gained optional fields only; older specs run unchanged). Fields marked *(planned)* are agreed but
not in code yet; everything else is what the code produces. Change this file in the same PR as any change to a
shape.

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
  | { by: 'pct'; pct: number }               // + = % of spot out of the money, − = in; nearest listed strike,
                                             //   an exact half-step goes away from ATM (at least the distance asked)
  | { by: 'premium'; price: number; side: 'nearest' | 'at_most' | 'at_least' }
                                             //   by the CLOSE of the bar before entry (what is known at the decision);
                                             //   the order then fills at the entry bar's open, which can differ
  | { by: 'delta'; delta: number }           // |delta| in (0, 1); only where the dataset has reliable Greeks.
                                             //   Black-Scholes (r = 0) on the IV implied by that same close (mid when
                                             //   quotes exist); time = calendar days to expiry + the rest of the session
  | { by: 'leg'; leg: string; steps: number }; // relative to another leg's chosen strike, + = higher strike

// Per-leg level: 'pct' of the leg's entry price, 'points' of premium, 'rupees' on the leg's whole quantity, or
// 'rupees_per_lot' of the leg. Rupee levels become premium points at entry: rupees ÷ qty, rupees_per_lot ÷ lot size.
// Short leg: stop when premium rises to entry × (1 + pct) (or entry + points), target when it falls the same way.
// Long leg: the mirror image. Levels above the entry round up to the tick, levels below round down (never below 0).
interface LegLevel { kind: 'pct' | 'points' | 'rupees' | 'rupees_per_lot'; value: number }
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
  max_entries?: number;                      // positions per session, 1–20 (default 1, left out when 1)
  cooldown_min?: number;                     // minutes after a close before the next may open, 0–300 (default 0)
}
// One position at a time: while a position is open (including one carried overnight) no new entry is made.
// The first entry of a session is one decision at `time`. With max_entries > 1, after a position closes at
// minute c, the next is decided on the first bar T ≥ c + 1 + cooldown_min (on the or_inside candle grid when the
// spec has that condition) where every entry rule passes, with T before adjust.cutoff and, intraday, before
// exit.time. Strikes are picked again at T. A position carried in from an earlier session does not count
// towards the session's max_entries.

type Condition =
  | { kind: 'or_inside'; or_minutes: number; candle_minutes: number; mode: 'full' | 'body' | 'close' | 'overlap' }
      // the last completed candle before entry must sit inside the opening range (the straddle's filter)
  | { kind: 'or_width_pct'; min?: number; max?: number; or_minutes?: number }   // opening-range width as % of spot;
      // refused unless the entry is at or after the end of the range (no look-ahead)
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
interface MoneyLevel { kind: 'rupees_per_lot' | 'pct_premium' | 'rupees'; value: number }
// rupees_per_lot is per base lot (× spec.lots); rupees is the whole position, whatever the lots;
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

`StraddloopLegs.validate(spec, caps): { ok: boolean; errors: Gate[]; warnings: Gate[]; spec }` (caps from
`StraddloopLegs.capsOf(sessions)`). An error blocks the run with
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
  expiry_assumed: boolean;                   // a day file's expiry came from the weekday rule, not the exchange
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
| `EXPIRY_ASSUMED` | warning | a multi-day hold on day files whose expiry date is assumed (weekday rule, holidays not applied) |
| `DATA_GAP` | warning (run time) | a held position crossed weekdays with no stored data, or a carried leg had no prices and was closed at its last seen price (never settled or invented) |
| `INVALID_SPEC` | error / warning | structural problems (no legs, bad ratio, unknown leg reference, bad time, trades per session or cooldown out of range); warnings for rules that can never fire (an adjustment with no stop, more trades per session than the cutoff leaves time for) |

`legs.run` throws an `Error` whose `gates` lists the errors and warnings when any error applies; the worker
passes them on as `{ id, ok: false, error, gates }`, so the page can list every reason at once.

### Running a spec

`StraddloopLegs.run(sessions, spec, { L, caps?, lean? })`. `L` is the ledger module (dated charges). `lean: true`
(optimisation studies, `compute.evaluate`) leaves out the event text and the per-leg display rows, and the
per-bar marks carry prices only; fills, positions and everything the ledger reads are identical to a full run
(`tests/legs.test.mts` checks it). The engine never modifies a session: lookups that depend only on a session
(minute → bar, strikes listed at each bar, a leg's expiry, the opening range, the dataset caps) are cached
beside it in WeakMaps, so a study that reruns the same sessions pays for them once.

### Lab strategies (`web/lib/strategyRegistry.ts`)

The Lab, the notebook and `?s=` links hold flat parameters keyed by a slug. The registry gives every strategy one
shape: the published rule sets (01–04, their own engines) and the strategy builder's structures (the templates
above). A builder structure's parameters become a spec in `builderSpec`; the run request then carries
`strategy: 'legs'`, `template` and `spec` (JSON). The parameters:

* legs: `legs` (a JSON list of `LegDraft`, or `''` for the structure's own legs built from `offset` and `width`);
  each draft has `id`, `action`, `right`, `ratio`, `strike` (a StrikeRule), optional `nth`, and optional `stop` /
  `target`: absent = the default for its side, `null` = none on that leg, or its own `LegLevel`;
* side defaults: `short_sl`, `short_tp`, `long_sl`, `long_tp`, each with `<key>_unit` (`pct`, `points`, `rupees`,
  `rupees_per_lot`); position levels `pos_sl`, `pos_tp` with `<key>_unit` (`rupees_per_lot`, `rupees`,
  `pct_premium`). Zero turns a level off;
* times and repeats: `entry_time`, `cutoff` (last new entry), `exit_time` (square-off), `hold`, `max_entries`,
  `cooldown_min`, `on_leg_stop`, `max_reentries`; sizing and costs: `lots`, `slip_pct`, account settings.

The expiry series of every leg follows the data series chosen in the Lab. The page runs `legs.validate` on the
spec it is about to send, against `labCaps(real, series)` (`web/lib/legs/caps.ts`), so a refusal is shown while
editing; the run checks again against the loaded sessions' caps. Templates that need the next expiry are listed but
blocked with the reason; the four-leg model is the one strategy the optimiser refuses.

---

## 2. Run request and run result

The worker message keeps its existing shape. The leg engine is `params.strategy = 'legs'` with the spec in
`params.spec` (JSON) and account settings in the same keys as today (`capital`, `margin_policy`, …).

```ts
// main thread -> worker
{ id, params: { strategy: 'legs', spec: StrategySpec, ...AccountParams }, days?: DayRef[] }
type DayRef = { path: string; buf?: ArrayBuffer; sha256?: string | null }   // buf only for days the worker does not hold
// worker -> main thread
{ id, progress: { phase: 'decode' | 'simulate'; done: number; total: number } | { phase: 'ledger' } }
{ id, ok: true, result: RunResult, ms, evicted: string[] }                   // evicted: `${path}|${lot}` no longer held
{ id, ok: false, error, gates: Gate[] | null, code: 'MISSING' | 'CHECKSUM' | null, paths: string[] | null }
```

**Days the worker holds.** A day file is unpacked, checked against `sha256` (the inventory's hash of the JSON
before gzip; `dayfile.unpack`) and decoded once per lot size; the decoded session is kept, the file is not. After a
run, sessions beyond 600 are dropped least-recently-used first (never those of the run just made) and listed in
`evicted`, so the page sends them again when needed (`useLab.holds`). A day the worker does not hold and was not
sent fails the run with `MISSING`; a file that does not match its hash fails it with `CHECKSUM` and the file's path,
before anything is simulated. A request whose params name real dates (`data_from`, `range_key`) but carries no days
is refused: the synthetic model never stands in for missing data.

**Progress and cancel.** `compute.run(params, sessions, { tick(i, n), phase('ledger') })`: every engine calls `tick`
before each session (`engine.setTick` for the published engines, `opts.tick` for `legs.run`); the worker posts it at
most every 80 ms. The engines are synchronous, so a run is cancelled by ending the worker (`useLab.cancel`): the page
starts a new one, sends every day again on the next run (from the browser's day-file cache, `lib/dayCache.ts`, keyed
by path and sha256), and marks a result still on screen as `detached` (its replay and exports need a re-run).

**Decoded sessions in memory.** A minute with no price is an empty array slot (it reads as `undefined`), never a stored
`null`, so arrays of prices stay unboxed doubles: 0.65 MB a real session instead of 1.59 MB. Engines test prices with
`== null`, which covers both. `mergeSessions` never changes its inputs (the worker reuses them).

**Checks that stop a run** (`internal: …`, never a quiet figure): the leg engine's `checkFills` (the legs of a
position fill at its bar; each leg fills once to open with its own action and once to close with the opposite; a leg
keeps side, strike and expiry while held, across sessions too); the ledger refuses a second opening fill for an open
leg and a fill after a leg closed (unless the ledger itself closed it, by liquidation or at the end of data); the
worker requires one day outcome per session that ran.

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
  opened: number; closed: number;            // legs opened / closed that day (fills; an intraday straddle = 2 / 2)
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
  legs: { id: string; leg: string; kind: 'initial' | 'reentry'; action: Action; right: Right; strike: number;
          expiry: string; qty: number; entry_date: string; entry_t: number; entry_px: number;
          exit_date: string | null; exit_t: number | null; exit_px: number | null; exit_reason: string | null;
          gross: number; charges: number; net: number }[];   // leg ids are 'P1.L1', a re-entry 'P1.L1.r1'
  entry_premium: number;                     // net points per position (credit +, debit −), ratio-weighted
  exit_reason: string;                       // 'target' | 'stop' | 'leg_stop' | 'time' | 'expiry' | 'range_end' | …
  gross: number; charges: number; net: number;
  payoff: { max_profit: number | null; max_loss: number | null; breakevens: number[] } | null;
                                             // at expiry, initial legs, single-expiry positions only (null = mixed
                                             // expiry); max_profit / max_loss null = unbounded
  flags: string[];
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
  reason: string;                            // 'entry' | 're-entry' | 'leg_stop' | 'leg_target' | 'stop' | 'target' |
                                             // 'time' | 'expiry_day_exit' | 'range_end' | 'data_end' | 'data_gap' |
                                             // 'expired_unobserved' | 'expiry' (settlement)
  intrabar: boolean; kind?: string;
  settlement?: boolean;                      // NEW: cash settlement at intrinsic value; charged by settlement rules
  costs: Charges | null;                     // the engine's own cost line; reconciled against the ledger's
}
```

Ledger outputs (unchanged names; new fields marked): `fills` (one row per fill, `FILL_COLS`), `tradebook`
(one row per closed leg, `TRADEBOOK_COLS`, + `position_id`, `exit_date` NEW), `daily` (one row per session,
`DAILY_COLS`, + `open_legs`, `unrealised_end`, `closing_equity` NEW; `unrealised_start` on the row object),
`rejections`, `liquidations`, `report`.

Accounting rules (`docs/ACCOUNTING.md` is the full text): balance = capital + cumulative net realised;
equity = balance + unrealised at candle-close marks; available = balance − margin blocked − long premium
held; a leg's P&L moves from unrealised to realised exactly once. NEW for multi-day positions: a carried
leg stays open across days with its margin blocked; the day's `closing_equity` includes its unrealised
P&L; drawdown, Sharpe and Sortino use closing equity (identical to closing balance for intraday
strategies, so existing results do not change). The engine closes every position by the end of the
range, so the report never ends with an open position.

Settlement fills: price = intrinsic value against the index close of the last stored bar of expiry day
(an earlier bar if that one is missing, flagged `settled_on_earlier_bar`); no brokerage or exchange charge;
STT `exercise_stt_pct` on intrinsic × qty for a long ITM leg; OTM legs settle at 0 with no charge. These
rates are UNVERIFIED and flagged on the report. Settlement is simultaneous; shorts are booked first so the
margin never sees a hedge removed before the leg it covers (the same order as every exit).

Margin (`account.margin_model`, NEW): `per_leg` (today's model: (SPAN-like % + exposure %) × strike × qty
per short leg, no offsets) or `hedged` (the worst loss at intrinsic value of all open legs over index
levels within ± `margin_span_pct` % of the entry spot, plus `margin_exposure_pct` % × that spot × short qty,
capped at the `per_leg` figure; long premium is held as cash, not margin; legs of different expiries are
valued on the same level, an approximation). Both are ESTIMATED, not SPAN. The Lab's leg engine defaults
to `hedged`; the straddle and ORB keep `per_leg`, so their results do not change.

Reconciliation identities in `report.reconciliation` must all pass for any figure to be shown as final:
balance = capital + Σ tradebook net = capital + Σ daily net = capital + Σ per-fill (realised − charges);
charge components add up; every opening fill is closed; ledger charges = engine cost lines; NEW: unrealised
at the end = 0; closing equity of the last day = ending balance; and, for the leg engine when the ledger
executed every order as sent (no rejection, partial or liquidation), each position's engine net = its
ledger net (one check per position).

---

## 4. Trade lifecycle

```
spec ──validate──▶ gated? ─yes─▶ run refused, Gate.message shown
   │no
day ─▶ conditions/filters ─fail─▶ DayOutcome no_entry / filtered / excluded
   │pass
strikes selected (StrikeRule) ─missing strike or entry price─▶ excluded (no partial entry: all legs or none)
   │
orders at next bar open ─ledger─▶ rejected (margin) | partial | executed
   │
OPEN: marked at every bar close; per-leg stop/target; position stop/target; adjustments
   │
CLOSED by one of: leg_stop, leg_target, stop, target, time, expiry_day_exit, expiry (settled), range_end,
                  data_end (no further price that day), data_gap / expired_unobserved (a carried leg with no
                  prices: closed at its last seen price, flagged), forced liquidation (ledger)
```

One position = the legs opened together at one entry; each leg is one tradebook row with `position_id`.
A re-entered leg joins the same position.

---

## 5. Date range (one object for calendar, queries, run, progress, charts, report)

```ts
interface DateRange {
  request: { from: string; to: string };     // what the user picked, inclusive
  dataset: { source: 'dhan' | 'synthetic' | 'local'; underlying: string; series: Series; interval: '1m' };
  bounds: { floor: string; earliest: string | null; latest_validated: string | null; latest_any: string | null }; // floor = the earliest stored day
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
from the database for the chosen underlying and series, and so does the start: history begins on the series'
earliest stored day (`FLOOR` 2023-01-01 is only a fallback when nothing is stored). A request that falls
entirely before it says so ("Stored history starts on …"); one entirely after the last stored day says that.
`loadCommand` asks for the dates as requested, older ones included, but not before `LOAD_FLOOR` (2020-07-01,
where the dated charge table starts). Presets end on `latest_any` (the last day a run can use).
`last_7/30/60/90` count stored usable days backwards; `6m/1y/2y/3y` start the day after the same calendar
date N months earlier, clamped to `earliest`; `max` = `earliest` → `latest_any`.

`buildDateRange(request, inventory, statuses, opts)` options: `source` ('dhan' | 'local': local files are
`partial`, quality unchecked), `underlying`, `series`, `floor` (default: the earliest stored day), `today`
(default today in IST). The NSE holiday list (`NSE_HOLIDAYS_UNVERIFIED`, 2023–2025, recalled, not verified) is built in and
only labels weekdays that have no file.

### Moving through history (Lab range bar, rolling windows)

Windows are calendar days, both ends included, on UTC dates, so month lengths and leap days are exact:

```ts
windowLength({ from, to }): number            // 1 Apr–30 Jul 2026 = 121
nextWindow(r, len?) / prevWindow(r, len?)     // the adjacent window, `len` days (default r's own length):
                                              //   1 Apr–30 Jul 2026 → 31 Jul–28 Nov 2026; before it 1 Dec 2025–31 Mar 2026
shiftRange(r, n, len?)                        // moved n days (the +30 / +60 / +90 buttons)
fitWindow(target, bounds): { range | null; cut: start | end | both | null; kept; asked; outside: before | after | null }
                                              // cut to the stored history, never moved; null when none of it is stored
lastN(n, sessions | days, inventory)      // the last N stored sessions or calendar days, ending on latest_any
rollingWindows(span, W, S): { windows; leftover; capped }   // whole W-day windows every S days; at most MAX_WINDOWS (400)
```

The range bar keeps the length that was asked for: a window cut at the end of the data does not make the next
move shorter. Rolling windows run in the worker (`{ id, rolling: { params, days, windows } }`, progress and cancel
as for research) through `analytics.runRolling`: each window is its own backtest through `compute.evaluate`,
started flat with the full capital, so the latest run, its replay and its exports are untouched; rows carry
sessions (all handed to the engine), traded days, net, win rate, max drawdown, Sharpe, profit factor, best and
worst day.

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
| Multi-day holds and expiry settlement | real data yes (contracts continue across stored days); synthetic no. Expiry dates in today's day files are assumed (weekday rule): a holiday-shifted expiry (for example around Diwali) would be settled on the wrong day until bhavcopy expiries are imported, so such runs carry `EXPIRY_ASSUMED` |

## 8. Optimisation studies (`public/engine/study.js`, `web/lib/optimiser/`)

A study measures many configurations of one Lab strategy on one set of sessions and chooses from the in-sample
part alone. The Research tab's `analytics.runOptimisation` (section-by-section analysis of the latest run) is
unchanged; studies are the Lab's **Optimise** view.

```
sessions  [0 ........................ isEnd) [isEnd ...... n)
           training [0, a)  validation [a, isEnd)   held-out test
```

**Windows** (`study.studyPlan(dates, { split, folds, wfMode, blocks })`, fixed before any configuration runs):
`split` by `analytics.splitChrono`; walk-forward folds inside `[0, isEnd)` (the first half trains, the rest is
cut into `folds` test blocks; rolling = the same training length, anchored = from session 0); PBO blocks (an even
number, 4–8) and thirds of `[0, isEnd)`. `volRegimes(sessions, isEnd)` labels each session low / mid / high by its
index range, cut at the in-sample terciles.

**Measuring** (`summarise(days, plan, regimes, { capital })`): one configuration's day records
(`analytics.fromRun(compute.evaluate(params, sessions)).days`) become `perf` figures for the full period,
training, validation, in-sample, held-out test, each fold's training and test window, the thirds and the regimes,
plus per-block sums (s, s², count) for PBO and walk-forward pooling, and longest win / loss runs. The day records
are not kept.

**Choosing** (`selectStudy(cands, plan, { objective, weights, minTrades, topK })`), never reading `test`:

| Answer | Rule |
| --- | --- |
| In-sample leader | best training score (not evidence) |
| Best out-of-sample | best validation score among the top K by training |
| Most robust | `mostRobust` over the top K by in-sample score, scored by `robustScore` |

Ties go to the lower configuration number, so the same measurements in any order give the same answers. Also
returned: `walk_forward` (re-selection per fold, out-of-sample pooled exactly from the block sums, efficiency,
distinct choices), `pbo` (combinatorially symmetric cross-validation on the blocks, combinations built without
recursion), `dsr` (deflated Sharpe of the leader and the best out-of-sample), `rank_corr_train_val`,
`min_trades`, `selection_rule`. `robustScore(summary, neighbours, stressed)` is the plain mean of the shares that
could be measured: walk-forward test blocks, thirds and regimes that made money, validation made money,
neighbours (one step either side on each ordered setting) that made money in-sample, and in-sample net kept at
doubled slippage.

**Space** (`lib/optimiser/space.ts`): `axesFor(strategy, params)` lists searchable settings with bounds and grain;
`rangeValues` turns from / to / step into values; `valuesAt` / `indexOf` / `positionsAt` enumerate the grid by index
(mixed radix); `plannedIndices` is the whole grid or a seeded sample (`HARD_CAP` 20,000); `paramsFor` writes a
configuration into Lab parameters (builder call / put offsets move every ATM-placed leg of that side);
`refusal` applies the time bounds and order and `legs.validate` with the data's caps; `estimate` counts all of it
before anything runs. Configuration 0 is the Lab's own settings; configuration n is grid point n − 1.

**Running** (`lib/optimiser/controller.ts` `runStudy(cfg, { pool, store, init, onProgress, signal })`): refusals are
recorded, the rest are measured in batches on the pool, each batch written to the store; then the answers, then the
finalists' neighbours and doubled-slippage runs (`stressSlip(s) = max(2s, s + 0.5)`), then the robust answer.
A cancel stops before the next configuration; a resumed study measures only what is missing and must see the same
number of sessions. The pool is `WorkerPool` (browser, `public/engine/optimise_worker.js`) or any object with the
same `init / evaluate / detail / cancel` (Node tests use an in-process pool).

Optimiser worker messages: `{ id, init: { days | synthetic, lotSize, plan, capital, reuse? } } → { plan, n }`;
`{ id, evaluate: [{ idx, params }] } → { id, item }` per configuration, then `{ id, ok, done }`;
`{ id, detail: { params } } → { days: [{ date, net, traded, status }] }`; `{ cancel: true }`.

**Store** (`lib/optimiser/store.ts`): IndexedDB `straddloop-optimiser`, stores `studies` (by id) and `cands` (by
[study, key]; key `g<n>` a configuration, `s<n>` the same at doubled slippage). Studies stay in the browser.

**Table and CSV** (`lib/optimiser/rows.ts`): training, validation and in-sample figures only; the held-out test and
the full period (which contains it) are left out.
