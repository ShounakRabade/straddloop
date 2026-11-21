import type { StrategySlug } from './types';

export type SectionId = 'strategy' | 'data' | 'period' | 'risk' | 'execution' | 'advanced';

export const SECTIONS: { id: SectionId; title: string; letter: string }[] = [
  { id: 'strategy', title: 'Strategy', letter: 'A' },
  { id: 'data', title: 'Market data', letter: 'B' },
  { id: 'period', title: 'Backtest period', letter: 'C' },
  { id: 'risk', title: 'Capital & risk', letter: 'D' },
  { id: 'execution', title: 'Execution', letter: 'E' },
  { id: 'advanced', title: 'Advanced', letter: 'F' },
];

/** Where each strategy parameter lives in the configuration rail. Anything unlisted goes to Advanced. */
const BY_KEY: Record<string, SectionId> = {
  sl_pct: 'strategy', target_per_lot: 'strategy', reentry_enabled: 'strategy',
  entry_time: 'strategy', latest_entry: 'strategy', exit_time: 'strategy',
  target_points: 'strategy', target_basis: 'strategy',
  policy: 'strategy', target_pct_margin: 'strategy', long_lots: 'strategy', short_pct: 'strategy',
  stop_points: 'strategy', stop_kind: 'strategy', max_structural_stop: 'strategy', exit_method: 'strategy', max_hold_minutes: 'strategy', max_trades: 'strategy',
  min_vix: 'strategy', max_vix: 'strategy', golden_enabled: 'strategy', silver_enabled: 'strategy', liquidity_sweep: 'strategy',
  seed: 'data', iv: 'data',
  days: 'period', months: 'period',
  capital: 'risk', lots: 'risk', margin_policy: 'risk', margin_span_pct: 'risk', margin_exposure_pct: 'risk',
  slip_pct: 'execution', brokerage_per_order: 'execution',
  entry_condition: 'advanced', strike_offset: 'advanced', breakout_def: 'advanced', stop_buffer: 'advanced',
};
export const sectionOf = (key: string): SectionId => BY_KEY[key] ?? 'advanced';

/** Sub-headings inside the Strategy section, so entry, exit and structure read as rules. */
export const STRATEGY_GROUP: Record<string, 'Exit' | 'Adjustment' | 'Structure'> = {
  entry_time: 'Structure', latest_entry: 'Structure', exit_time: 'Exit',
  sl_pct: 'Exit', target_per_lot: 'Exit', target_points: 'Exit', target_basis: 'Exit', target_pct_margin: 'Exit', policy: 'Exit',
  reentry_enabled: 'Adjustment', long_lots: 'Structure', short_pct: 'Structure',
  stop_points: 'Exit', stop_kind: 'Exit', max_structural_stop: 'Exit', exit_method: 'Exit', max_hold_minutes: 'Exit', max_trades: 'Structure',
  min_vix: 'Adjustment', max_vix: 'Adjustment', golden_enabled: 'Structure', silver_enabled: 'Structure', liquidity_sweep: 'Adjustment',
};

/** Fields a run can do without (an empty value means "use the data's own"). */
export const OPTIONAL = new Set(['lot_size']);

/** Read-only legs of each named strategy, until the leg builder (strategy engine) replaces them. */
export const LEGS: Record<StrategySlug, { action: 'Sell' | 'Buy'; right: string; strike: string; qty: string; expiry: string }[]> = {
  straddle: [
    { action: 'Sell', right: 'CE', strike: 'ATM + offset', qty: '1 × lots', expiry: 'Nearest' },
    { action: 'Sell', right: 'PE', strike: 'ATM − offset', qty: '1 × lots', expiry: 'Nearest' },
  ],
  orb: [
    { action: 'Buy', right: 'CE or PE', strike: 'ATM (by breakout side)', qty: '1 × lots', expiry: 'Nearest' },
  ],
  ema_pullback: [
    { action: 'Buy', right: 'CE or PE', strike: 'ATM / configured offset', qty: '1 × lots', expiry: 'Nearest available' },
  ],
  fourleg: [
    { action: 'Sell', right: 'CE', strike: 'Spot + distance', qty: '3', expiry: 'Next month' },
    { action: 'Buy', right: 'CE', strike: 'Short + ₹50', qty: 'Protective', expiry: 'Next month' },
    { action: 'Sell', right: 'PE', strike: 'Spot − distance', qty: '3', expiry: 'Next month' },
    { action: 'Buy', right: 'PE', strike: 'Short − ₹50', qty: 'Protective', expiry: 'Next month' },
  ],
};

export const ENTRY: Record<StrategySlug, string> = {
  straddle: '09:50, if the 09:45 candle sits inside the 09:15–09:45 range. No new legs after 14:30.',
  orb: 'Next bar after a breakout of the 09:15–09:45 range is confirmed by the following candle. One trade a day, none after 14:30.',
  ema_pullback: 'Next 1-minute option open after a completed 5-minute EMA trend pullback confirmation. No new entries after 14:00.',
  fourleg: 'First trading day after the previous monthly expiry, if at least 15 days remain.',
};
export const EXIT_TEXT: Record<StrategySlug, string> = {
  straddle: 'Per-leg stop, the per-lot net target, or 15:15.',
  orb: 'Premium target, the reversal-candle level, or 15:15.',
  ema_pullback: 'Underlying stop, selected target / trailing rule, time limit, or configured force exit.',
  fourleg: 'Target share of margin, 25% loss cap, or the policy’s exit day.',
};
