import type { StrategySlug } from './types';

export type SectionId = 'strategy' | 'timing' | 'risk' | 'data' | 'capital' | 'advanced';

export const SECTIONS: { id: SectionId; title: string; letter: string }[] = [
  { id: 'strategy', title: 'Strategy & legs', letter: 'A' },
  { id: 'timing', title: 'Entry & exit', letter: 'B' },
  { id: 'risk', title: 'Risk rules', letter: 'C' },
  { id: 'data', title: 'Data & period', letter: 'D' },
  { id: 'capital', title: 'Capital & execution', letter: 'E' },
  { id: 'advanced', title: 'Advanced', letter: 'F' },
];

/** Where each strategy parameter lives in the configuration rail. Anything unlisted goes to Advanced. */
const BY_KEY: Record<string, SectionId> = {
  // A: what is traded
  legs: 'strategy', offset: 'strategy', width: 'strategy', lots: 'strategy', strike_offset: 'strategy', long_lots: 'strategy', short_pct: 'strategy',
  // B: when it enters and leaves
  entry_time: 'timing', latest_entry: 'timing', reentry_cutoff: 'timing', cutoff: 'timing', exit_time: 'timing', hold: 'timing',
  max_entries: 'timing', cooldown_min: 'timing', reentry_enabled: 'timing', max_trades: 'timing', confirmation: 'timing',
  min_vix: 'timing', max_vix: 'timing', golden_enabled: 'timing', silver_enabled: 'timing', liquidity_sweep: 'timing',
  // C: stops, targets and what happens after a stop
  sl_pct: 'risk', target_per_lot: 'risk', max_loss_per_lot: 'risk', target_points: 'risk', target_basis: 'risk',
  stop_points: 'risk', stop_kind: 'risk', max_structural_stop: 'risk', exit_method: 'risk', max_hold_minutes: 'risk',
  short_sl: 'risk', short_tp: 'risk', long_sl: 'risk', long_tp: 'risk', pos_sl: 'risk', pos_tp: 'risk', on_leg_stop: 'risk', max_reentries: 'risk',
  policy: 'risk', target_pct_margin: 'risk',
  // D: the synthetic model's settings (real data is chosen on the calendar)
  days: 'data', seed: 'data', iv: 'data', months: 'data',
  // E: the account
  capital: 'capital', margin_policy: 'capital', margin_span_pct: 'capital', margin_exposure_pct: 'capital', slip_pct: 'capital', brokerage_per_order: 'capital',
  // F: the published rules' finer points
  entry_condition: 'advanced', breakout_def: 'advanced', stop_buffer: 'advanced',
};
export const sectionOf = (key: string): SectionId => BY_KEY[key] ?? 'advanced';

/** Sub-headings inside a section, in the order they appear; a key without one sits at the top of its section. */
export const SUBGROUP: Record<string, string> = {
  hold: 'Holding', max_entries: 'Repeat trades', cooldown_min: 'Repeat trades', reentry_enabled: 'Repeat trades', max_trades: 'Repeat trades',
  confirmation: 'Entry filters', min_vix: 'Entry filters', max_vix: 'Entry filters', golden_enabled: 'Entry filters', silver_enabled: 'Entry filters', liquidity_sweep: 'Entry filters',
  sl_pct: 'Each leg', short_sl: 'Each leg', short_tp: 'Each leg', long_sl: 'Each leg', long_tp: 'Each leg',
  target_per_lot: 'Whole position', max_loss_per_lot: 'Whole position', pos_sl: 'Whole position', pos_tp: 'Whole position',
  target_points: 'Exits', target_basis: 'Exits', stop_points: 'Exits', stop_kind: 'Exits', max_structural_stop: 'Exits', exit_method: 'Exits', max_hold_minutes: 'Exits',
  policy: 'Exits', target_pct_margin: 'Exits',
  on_leg_stop: 'When a leg is stopped', max_reentries: 'When a leg is stopped',
  margin_policy: 'Margin (estimated)', margin_span_pct: 'Margin (estimated)', margin_exposure_pct: 'Margin (estimated)',
  slip_pct: 'Costs and fills', brokerage_per_order: 'Costs and fills',
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
