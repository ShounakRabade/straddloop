/**
 * Stops and targets in the Lab: the unit each one is measured in, sensible bounds for each kind of level, how values
 * are shown, and the slider scale. The engines read the values; these bounds only keep the controls sensible:
 *  - a short leg can lose many times its premium, so its stop goes far above 100%; a long leg can lose at most its
 *    premium, so its stop stays below 100% (the leg engine refuses 100% or more), and the mirror for targets;
 *  - rupee levels span a few hundred rupees to lakhs, so the slider is logarithmic there and the number box is exact.
 */

export type LevelUnit = 'pct' | 'points' | 'rupees' | 'rupees_per_lot' | 'pct_premium' | 'index_points';
export type LevelRole = 'short_stop' | 'long_stop' | 'short_target' | 'long_target' | 'position_stop' | 'position_target';
export interface Bounds { min: number; max: number; step: number }

/** How each unit reads: the chip on the control and the words for the tooltip. */
export const UNIT: Record<LevelUnit, { chip: string; words: string }> = {
  pct: { chip: '%', words: '% of the leg’s entry price' },
  points: { chip: 'pts', words: 'premium points' },
  rupees: { chip: '₹', words: 'rupees in total' },
  rupees_per_lot: { chip: '₹/lot', words: 'rupees per lot' },
  pct_premium: { chip: '% prem', words: '% of the net premium at entry' },
  index_points: { chip: 'idx pts', words: 'NIFTY index points' },
};

const rupeeLeg = { rupees: { min: 50, max: 200000, step: 50 }, rupees_per_lot: { min: 50, max: 100000, step: 50 }, points: { min: 0.5, max: 1000, step: 0.5 } };
const position = { rupees_per_lot: { min: 100, max: 100000, step: 50 }, rupees: { min: 100, max: 1000000, step: 100 }, pct_premium: { min: 5, max: 1000, step: 5 } };

export const LEVEL_BOUNDS: Record<LevelRole, Partial<Record<LevelUnit, Bounds>>> = {
  short_stop: { pct: { min: 5, max: 500, step: 1 }, ...rupeeLeg },
  long_stop: { pct: { min: 5, max: 95, step: 1 }, ...rupeeLeg },
  short_target: { pct: { min: 5, max: 95, step: 1 }, ...rupeeLeg },
  long_target: { pct: { min: 5, max: 1000, step: 5 }, ...rupeeLeg },
  position_stop: position,
  position_target: position,
};

/** The value a level takes when it is switched on, per unit (a starting point, not a recommendation). */
export const ON_VALUE: Record<LevelRole, Partial<Record<LevelUnit, number>>> = {
  short_stop: { pct: 50, points: 30, rupees: 2000, rupees_per_lot: 2000 },
  long_stop: { pct: 50, points: 30, rupees: 2000, rupees_per_lot: 2000 },
  short_target: { pct: 50, points: 30, rupees: 2000, rupees_per_lot: 2000 },
  long_target: { pct: 100, points: 50, rupees: 3000, rupees_per_lot: 3000 },
  position_stop: { rupees_per_lot: 2000, rupees: 5000, pct_premium: 50 },
  position_target: { rupees_per_lot: 1000, rupees: 3000, pct_premium: 50 },
};

export const LEG_UNITS: LevelUnit[] = ['pct', 'points', 'rupees', 'rupees_per_lot'];
export const POSITION_UNITS: LevelUnit[] = ['rupees_per_lot', 'rupees', 'pct_premium'];

const inr = (v: number) => v.toLocaleString('en-IN', { maximumFractionDigits: 2 });
/** '36%', '20 pts', '₹1,500', '₹1,500/lot', '40% of premium', '15 index pts'. */
export function fmtLevel(unit: LevelUnit, v: number): string {
  switch (unit) {
    case 'pct': return `${inr(v)}%`;
    case 'points': return `${inr(v)} pts`;
    case 'rupees': return `₹${inr(v)}`;
    case 'rupees_per_lot': return `₹${inr(v)}/lot`;
    case 'pct_premium': return `${inr(v)}% of premium`;
    case 'index_points': return `${inr(v)} index pts`;
  }
}

/** A value on the step grid, inside the bounds. */
export function clampLevel(v: number, b: Bounds): number {
  if (!Number.isFinite(v)) return b.min;
  const s = Math.round(v / b.step) * b.step;
  return Math.min(b.max, Math.max(b.min, +s.toFixed(6)));
}

export const SLIDER_MAX = 1000;
/** Wide ranges (max ≥ 20 × min) use a logarithmic slider, so ₹100 and ₹1,00,000 are both reachable by hand. */
export const isLog = (b: Bounds) => b.min > 0 && b.max / b.min >= 20;

export function toSlider(v: number, b: Bounds): number {
  const x = Math.min(b.max, Math.max(b.min, v));
  const f = isLog(b) ? Math.log(x / b.min) / Math.log(b.max / b.min) : (x - b.min) / (b.max - b.min);
  return Math.round(f * SLIDER_MAX);
}

/** Slider position to a value: on a log scale, rounded to two significant figures (₹37,350 becomes ₹37,000), then to
 *  the step; on a linear scale, to the step. The number box next to it takes any value on the step. */
export function fromSlider(pos: number, b: Bounds): number {
  const f = Math.min(1, Math.max(0, pos / SLIDER_MAX));
  if (!isLog(b)) return clampLevel(b.min + f * (b.max - b.min), b);
  const raw = b.min * Math.pow(b.max / b.min, f);
  const g = Math.max(b.step, Math.pow(10, Math.floor(Math.log10(raw)) - 1));
  return clampLevel(Math.round(raw / g) * g, b);
}
