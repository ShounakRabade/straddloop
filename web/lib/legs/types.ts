/** Types for the leg engine (public/engine/legs.js). The contract is docs/ENGINE_INTERFACES.md; keep the two in step. */

export type Right = 'CE' | 'PE';
export type Action = 'BUY' | 'SELL';
export type Series = 'WEEK' | 'MONTH';

export type TemplateId =
  | 'long_call' | 'long_put' | 'short_call' | 'short_put'
  | 'bull_call_spread' | 'bear_put_spread' | 'bull_put_spread' | 'bear_call_spread'
  | 'long_straddle' | 'short_straddle' | 'long_strangle' | 'short_strangle'
  | 'iron_condor' | 'iron_butterfly' | 'long_call_butterfly' | 'long_put_butterfly' | 'broken_wing_butterfly'
  | 'call_ratio_spread' | 'put_ratio_spread' | 'call_backspread' | 'put_backspread'
  | 'calendar_call' | 'calendar_put' | 'diagonal_call' | 'diagonal_put';

export type StrikeRule =
  | { by: 'atm'; steps: number }
  | { by: 'pct'; pct: number }
  | { by: 'premium'; price: number; side?: 'nearest' | 'at_most' | 'at_least' }
  | { by: 'delta'; delta: number }
  | { by: 'leg'; leg: string; steps: number };

/** A per-leg stop or target: % of the leg's entry price, premium points, ₹ on the leg's whole quantity, or ₹ per lot
 *  of the leg. ₹ levels are converted to premium points at entry (₹ ÷ quantity, or ₹ per lot ÷ lot size). */
export interface LegLevel { kind: 'pct' | 'points' | 'rupees' | 'rupees_per_lot'; value: number }
/** A position stop or target on mark-to-market P&L: ₹ per base lot, % of the net entry premium, or ₹ in total. */
export interface MoneyLevel { kind: 'rupees_per_lot' | 'pct_premium' | 'rupees'; value: number }

export interface LegSpec {
  id: string;
  action: Action;
  right: Right;
  ratio: number;
  expiry: { series: Series; nth: 1 | 2 };
  strike: StrikeRule;
  stop?: LegLevel;
  target?: LegLevel;
}

export type Condition =
  | { kind: 'or_inside'; or_minutes?: number; candle_minutes?: number; mode?: 'full' | 'body' | 'close' | 'overlap' }
  | { kind: 'or_width_pct'; or_minutes?: number; candle_minutes?: number; min?: number; max?: number }
  | { kind: 'gap_pct'; min?: number; max?: number }
  | { kind: 'move_pct'; min?: number; max?: number }
  | { kind: 'net_premium'; min?: number; max?: number };

export interface EntryRule {
  time: string; weekdays: number[]; dte?: { min?: number; max?: number }; conditions: Condition[];
  /** Positions that may open in one session, one at a time (default 1). After one closes, the next opens on the
   *  first bar at or after its close + 1 minute + cooldown_min where every rule passes, before adjust.cutoff. */
  max_entries?: number;
  /** Minutes to wait after a position closes before the next may open (default 0). */
  cooldown_min?: number;
}
export interface ExitRule {
  hold: 'intraday' | 'sessions' | 'expiry';
  sessions?: number;
  time: string;
  settle_at_expiry: boolean;
  stop?: MoneyLevel;
  target?: MoneyLevel;
  basis: 'net' | 'gross';
}
export interface AdjustRule { on_leg_stop: 'keep_others' | 'close_all' | 'reenter'; max_reentries: number; cutoff: string }
export interface ExecutionSpec { slip_pct: number; slip_ticks: number; stop_slip_mult: number; stop_fill: 'gap_aware' | 'trigger'; brokerage_per_order: number; exercise_stt_pct: number }

export interface StrategySpec {
  v: 1;
  name: string;
  template: TemplateId | 'custom';
  underlying: 'NIFTY';
  lots: number;
  legs: LegSpec[];
  entry: EntryRule;
  exit: ExitRule;
  adjust: AdjustRule;
  execution: ExecutionSpec;
}

export type GateCode = 'UNDERLYING_NOT_STORED' | 'SERIES_NOT_STORED' | 'NEXT_EXPIRY_NOT_STORED' | 'DELTA_NO_GREEKS' | 'STRIKE_OUTSIDE_WINDOW'
  | 'HOLD_NEEDS_CONTINUOUS' | 'MIXED_EXPIRY_SETTLEMENT' | 'NO_BID_ASK' | 'EXPIRY_ASSUMED' | 'DATA_GAP' | 'INVALID_SPEC';
export interface Gate { code: GateCode; message: string; leg?: string }

export interface DatasetCaps {
  source: 'dhan' | 'synthetic';
  underlying: string;
  series: Series[];
  nth: number[];
  strike_window: number;
  greeks: boolean;
  bid_ask: boolean;
  continuous: boolean;
  expiry_assumed: boolean;
}

export interface PositionLeg {
  id: string; leg: string; kind: 'initial' | 'reentry'; action: Action; right: Right; strike: number; expiry: string; qty: number;
  entry_date: string; entry_t: number; entry_px: number; exit_date: string | null; exit_t: number | null; exit_px: number | null; exit_reason: string | null;
  gross: number; charges: number; net: number;
}
export interface PositionRecord {
  id: string;
  opened: { date: string; t: number };
  closed: { date: string; t: number } | null;
  legs: PositionLeg[];
  entry_premium: number;
  exit_reason: string;
  gross: number; charges: number; net: number;
  payoff: { max_profit: number | null; max_loss: number | null; breakevens: number[] } | null;
  flags: string[];
}
