import type { SpaceParam } from './research';

/**
 * What the optimisation lab can search, per strategy. Keep in step with PARAM_SPACE in
 * public/engine/analytics.js (tests/analytics.test.mjs compares the two). `engine: true` marks engine
 * settings with no field in the settings panel; when one is loaded into the Lab it is listed there.
 */
export const PARAM_SPACE: Record<'straddle' | 'orb', SpaceParam[]> = {
  straddle: [
    { key: 'sl_pct', label: 'Stop per leg', unit: '%', kind: 'range', min: 20, max: 75, step: 1, sweep: [25, 30, 36, 45, 55] },
    { key: 'target_per_lot', label: 'Profit target per lot', unit: '₹', kind: 'range', min: 500, max: 3000, step: 100, sweep: [600, 1000, 1500, 2000] },
    { key: 'reentry_enabled', label: 'Re-entry after a stop', kind: 'choice', options: [true, false] },
    { key: 'entry_condition', label: 'Entry candle must', kind: 'choice', options: ['full', 'body', 'close', 'overlap'] },
    { key: 'strike_offset', label: 'Strike (from ATM)', kind: 'range', min: -3, max: 5, step: 1, sweep: [0, 1, 2] },
    { key: 'exit_time', label: 'Exit time', kind: 'choice', options: ['14:30', '14:45', '15:00', '15:15'], engine: true },
    { key: 'reentry_cutoff', label: 'No new positions after', kind: 'choice', options: ['12:00', '13:00', '14:00', '14:30'], engine: true },
    { key: 'max_loss_per_lot', label: 'Daily loss cap per lot (0 = off)', unit: '₹', kind: 'range', min: 0, max: 5000, step: 500, sweep: [0, 1500, 3000], engine: true },
    { key: 'skip_expiry_day', label: 'Skip expiry day', kind: 'choice', options: [false, true], engine: true },
    { key: 'max_or_width_pct', label: 'Max opening-range width (vol filter)', unit: '%', kind: 'range', min: 0.3, max: 2, step: 0.1, sweep: [0.5, 0.8, 100], engine: true },
  ],
  orb: [
    { key: 'target_points', label: 'Target (premium points)', kind: 'range', min: 10, max: 80, step: 5, sweep: [20, 30, 45, 60] },
    { key: 'stop_buffer', label: 'Structural stop buffer', kind: 'range', min: 0, max: 30, step: 5, sweep: [0, 10, 20] },
    { key: 'breakout_def', label: 'Breakout means', kind: 'choice', options: ['wick', 'close', 'body'] },
    { key: 'strike_offset', label: 'Strike (from ATM)', kind: 'range', min: -3, max: 3, step: 1, sweep: [0, 1] },
    { key: 'latest_entry', label: 'Latest entry', kind: 'choice', options: ['12:00', '13:00', '14:30'], engine: true },
    { key: 'exit_time', label: 'Exit time', kind: 'choice', options: ['14:30', '15:00', '15:15'], engine: true },
    { key: 'max_hold_minutes', label: 'Max hold (minutes, 0 = off)', kind: 'range', min: 0, max: 240, step: 30, sweep: [0, 60, 120], engine: true },
  ],
};

/** Engine defaults for the engine-only settings, so the lab can include "what you run today" in a sweep. */
export const ENGINE_DEFAULTS: Record<string, string | number | boolean> = {
  exit_time: '15:15', reentry_cutoff: '14:30', max_loss_per_lot: 0, skip_expiry_day: false, max_or_width_pct: 100, latest_entry: '14:30', max_hold_minutes: 0,
};

/** Keys that have no field in the settings panel. */
export const ENGINE_ONLY_KEYS = Array.from(new Set([...PARAM_SPACE.straddle, ...PARAM_SPACE.orb].filter((p) => p.engine).map((p) => p.key)));

export const OBJECTIVES: [string, string][] = [
  ['sharpe', 'Sharpe ratio'], ['sortino', 'Sortino ratio'], ['net', 'Net profit'], ['cagr', 'CAGR (1 year or more)'], ['pf', 'Profit factor'],
  ['win_rate', 'Win rate'], ['min_dd', 'Smallest drawdown'], ['rom', 'Return on peak margin (est.)'], ['calmar', 'Net ÷ max drawdown'], ['custom', 'Custom weighted'],
];
export const CUSTOM_KEYS: [string, string][] = [['net', 'Net'], ['sharpe', 'Sharpe'], ['sortino', 'Sortino'], ['pf', 'Profit factor'], ['win_rate', 'Win rate'], ['min_dd', 'Small drawdown'], ['rom', 'Return on margin'], ['calmar', 'Net ÷ drawdown']];

export const choiceLabel = (v: unknown) => (v === true ? 'On' : v === false ? 'Off' : String(v));

/** Parse a comma list typed by the user into values of the parameter's kind. Invalid entries are reported, not dropped silently. */
export function parseValues(p: SpaceParam, text: string): { values: (string | number | boolean)[]; errors: string[] } {
  const parts = text.split(',').map((s) => s.trim()).filter(Boolean);
  const errors: string[] = [], values: (string | number | boolean)[] = [];
  for (const s of parts) {
    if (p.kind === 'choice') {
      const o = (p.options ?? []).find((x) => choiceLabel(x).toLowerCase() === s.toLowerCase() || String(x) === s);
      if (o === undefined) errors.push(`“${s}” is not an option`); else values.push(o);
      continue;
    }
    const v = Number(s);
    if (!isFinite(v)) { errors.push(`“${s}” is not a number`); continue; }
    if (p.min != null && v < p.min && !(p.key === 'max_or_width_pct' && v === 100)) { errors.push(`${v} is below ${p.min}`); continue; }
    if (p.max != null && v > p.max && !(p.key === 'max_or_width_pct' && v === 100)) { errors.push(`${v} is above ${p.max}`); continue; }
    values.push(v);
  }
  const uniq = Array.from(new Set(values));
  if (p.kind === 'range') (uniq as number[]).sort((a, b) => a - b);
  return { values: uniq, errors };
}
