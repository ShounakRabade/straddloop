/**
 * What an optimisation study can search, per Lab strategy, and the configurations it tries.
 *
 * Axes come from the strategy's own fields (lib/strategyRegistry.ts): times keep the field's grain and bounds, stops and
 * targets keep their unit, and builder structures get call-side and put-side strike offsets. Configurations are
 * enumerated by index (mixed radix, no recursion): a full grid when it fits the cap, otherwise a seeded random sample
 * of grid points. Your current settings are always configuration 0, so the study ranks them too. Every configuration
 * is checked before it runs (times in order and inside their bounds; for builder structures the engine's own spec
 * checks against what the data holds); refused ones are counted with the reason and never run.
 */
import { labStrategy, legDrafts, builderSpec, type LabStrategy, type LegDraft } from '../strategyRegistry.ts';
import { sequenceProblems, timeProblem, toHM, toMin } from '../sessionTime.ts';
import { labCaps } from '../legs/caps.ts';
import type { Series, TemplateId } from '../legs/types';
import type { Params } from '../types';
import Legs from '../../public/engine/legs.js';

export type Value = string | number | boolean;
export interface AxisDef {
  key: string;
  label: string;
  /** a short heading for table columns (the label when absent) */
  short?: string;
  kind: 'number' | 'time' | 'choice';
  unit?: string;
  /** number and time axes (time in minutes since midnight): the values allowed and the field's grain */
  bounds?: { min: number; max: number; grain: number };
  options?: { value: Value; label: string }[];
  /** a sensible first range, so a default study stays small */
  suggest: { min: number; max: number; step: number } | { values: Value[] };
  /** neighbours (one step either side) mean something: numbers and times, not unordered choices */
  ordered: boolean;
  /** ticked when the panel opens */
  on: boolean;
  note?: string;
}
/** The user's choice for one axis: the explicit list of values to try, in order. */
export interface AxisPick { key: string; values: Value[] }

const LOTS_NOTE = 'Lots scale profit and loss almost in proportion: searching them mostly picks the largest. Margin and charges are the only limits.';
const OFF_NOTE = '0 turns it off.';

type Seed = { key: string; label?: string; unit?: string; suggest: AxisDef['suggest']; bounds?: { min: number; max: number }; note?: string; on?: boolean };
const ENGINE_AXES: Record<string, Seed[]> = {
  straddle: [
    { key: 'sl_pct', unit: '%', suggest: { min: 20, max: 80, step: 10 }, bounds: { min: 5, max: 500 }, on: true },
    { key: 'target_per_lot', unit: '₹/lot', suggest: { min: 500, max: 2500, step: 500 }, bounds: { min: 100, max: 50000 }, on: true },
    { key: 'entry_time', suggest: { min: 590, max: 650, step: 15 } },
    { key: 'reentry_cutoff', suggest: { min: 780, max: 870, step: 30 } },
    { key: 'exit_time', suggest: { min: 840, max: 915, step: 15 } },
    { key: 'max_loss_per_lot', unit: '₹/lot', suggest: { min: 0, max: 4000, step: 1000 }, bounds: { min: 0, max: 100000 }, note: OFF_NOTE },
    { key: 'reentry_enabled', suggest: { values: [true, false] } },
    { key: 'entry_condition', suggest: { values: ['full', 'body', 'close', 'overlap'] } },
    { key: 'strike_offset', unit: 'strikes', suggest: { min: 0, max: 2, step: 1 }, bounds: { min: -3, max: 5 } },
    { key: 'lots', unit: 'lots', suggest: { min: 1, max: 2, step: 1 }, bounds: { min: 1, max: 20 }, note: LOTS_NOTE },
  ],
  orb: [
    { key: 'target_points', unit: 'pts', suggest: { min: 20, max: 60, step: 10 }, bounds: { min: 1, max: 500 }, on: true },
    { key: 'stop_buffer', unit: 'index pts', suggest: { min: 0, max: 20, step: 5 }, bounds: { min: 0, max: 100 }, on: true },
    { key: 'latest_entry', suggest: { min: 720, max: 870, step: 30 } },
    { key: 'exit_time', suggest: { min: 840, max: 915, step: 15 } },
    { key: 'breakout_def', suggest: { values: ['wick', 'close', 'body_strength'] } },
    { key: 'target_basis', suggest: { values: ['premium', 'none'] } },
    { key: 'strike_offset', unit: 'strikes', suggest: { min: -1, max: 1, step: 1 }, bounds: { min: -5, max: 5 } },
    { key: 'lots', unit: 'lots', suggest: { min: 1, max: 2, step: 1 }, bounds: { min: 1, max: 20 }, note: LOTS_NOTE },
  ],
  ema_pullback: [
    { key: 'stop_points', unit: 'index pts', suggest: { min: 10, max: 25, step: 5 }, bounds: { min: 3, max: 150 }, on: true },
    { key: 'exit_method', suggest: { values: ['rr1', 'partial_2r', 'trailing_ema'] }, on: true },
    { key: 'entry_time', suggest: { min: 585, max: 645, step: 30 } },
    { key: 'exit_time', suggest: { min: 840, max: 915, step: 15 } },
    { key: 'stop_kind', suggest: { values: ['fixed', 'structural'] } },
    { key: 'max_structural_stop', unit: 'index pts', suggest: { min: 20, max: 40, step: 10 }, bounds: { min: 5, max: 300 } },
    { key: 'confirmation', suggest: { values: ['engulf_or_rejection', 'engulfing', 'rejection'] } },
    { key: 'max_trades', unit: 'trades', suggest: { min: 1, max: 3, step: 1 }, bounds: { min: 1, max: 10 } },
    { key: 'liquidity_sweep', suggest: { values: [false, true] } },
    { key: 'strike_offset', unit: 'strikes', suggest: { min: -1, max: 1, step: 1 }, bounds: { min: -5, max: 5 } },
    { key: 'lots', unit: 'lots', suggest: { min: 1, max: 2, step: 1 }, bounds: { min: 1, max: 20 }, note: LOTS_NOTE },
  ],
};

const UNIT_WORD: Record<string, string> = { pct: '%', points: 'pts', rupees: '₹', rupees_per_lot: '₹/lot', pct_premium: '% prem' };

/** The innermost strike (steps from ATM) of a side's ATM-placed legs, or null when the side has none. */
function sideSteps(drafts: LegDraft[], right: 'CE' | 'PE'): number | null {
  const s = drafts.filter((d) => d.right === right && d.strike.by === 'atm').map((d) => (d.strike as { steps: number }).steps);
  return s.length ? Math.min(...s) : null;
}

/** The axes a strategy offers, with its current settings as the starting point. */
export function axesFor(s: LabStrategy, base: Params): AxisDef[] {
  const field = (k: string) => s.fields.find((f) => f.key === k);
  const fromSeed = (seed: Seed): AxisDef | null => {
    const f = field(seed.key);
    const label = seed.label ?? f?.label ?? seed.key;
    if (f?.kind === 'time') {
      const min = toMin(f.min)!, max = toMin(f.max)!;
      const sg = seed.suggest as { min: number; max: number; step: number };
      return { key: seed.key, label, kind: 'time', bounds: { min, max, grain: f.grain }, ordered: true, on: !!seed.on, note: seed.note,
        suggest: { min: Math.max(min, sg.min), max: Math.min(max, sg.max), step: Math.max(f.grain, sg.step - (sg.step % f.grain)) } };
    }
    if (f?.kind === 'choice' || 'values' in seed.suggest) {
      const options = f?.kind === 'choice' ? f.options : (seed.suggest as { values: Value[] }).values.map((v) => ({ value: v, label: String(v) }));
      return { key: seed.key, label, kind: 'choice', options, ordered: false, on: !!seed.on, note: seed.note,
        suggest: { values: 'values' in seed.suggest ? seed.suggest.values : options.map((o) => o.value) } };
    }
    const b = seed.bounds ?? (f?.kind === 'range' ? { min: f.min, max: f.max } : { min: 0, max: 1e6 });
    return { key: seed.key, label, kind: 'number', unit: seed.unit, bounds: { ...b, grain: 0 }, ordered: true, on: !!seed.on, note: seed.note, suggest: seed.suggest };
  };
  if (s.family === 'engine') return (ENGINE_AXES[s.slug] ?? []).map(fromSeed).filter((a): a is AxisDef => !!a && (!!field(a.key) || a.key === 'max_hold_minutes'));
  // the strategy builder
  const out: AxisDef[] = [];
  const time = (key: string, sg: { min: number; max: number; step: number }, on = false) => { const a = fromSeed({ key, suggest: sg, on }); if (a) out.push(a); };
  time('entry_time', { min: 560, max: 620, step: 30 }, true);
  time('exit_time', { min: 870, max: 915, step: 15 }, true);
  time('cutoff', { min: 780, max: 870, step: 30 });
  const drafts = legDrafts(s.template as TemplateId, base);
  for (const [right, word] of [['CE', 'Call'], ['PE', 'Put']] as const) {
    const at = sideSteps(drafts, right);
    if (at == null) continue;
    out.push({ key: right === 'CE' ? 'call_offset' : 'put_offset', label: `${word} strike, strikes out of the money`, short: `${word} OTM`, kind: 'number', unit: 'strikes', ordered: true, on: true,
      bounds: { min: -5, max: 10, grain: 0 }, suggest: { min: Math.max(-5, at - 1), max: Math.min(10, at + 1), step: 1 },
      note: `Moves every ${word.toLowerCase()} leg placed from ATM together, so a wing keeps its width. Only ATM ± 10 strikes are stored.` });
  }
  if (field('width') && !base.legs) out.push({ key: 'width', label: 'Width (strikes)', kind: 'number', unit: 'strikes', ordered: true, on: false, bounds: { min: 1, max: 8, grain: 0 }, suggest: { min: 1, max: 3, step: 1 } });
  const SHORT: Record<string, string> = { short_sl: 'Short stop', short_tp: 'Short target', long_sl: 'Long stop', long_tp: 'Long target', pos_sl: 'Pos. stop', pos_tp: 'Pos. target' };
  for (const [key, on] of [['short_sl', true], ['short_tp', false], ['long_sl', false], ['long_tp', false], ['pos_sl', false], ['pos_tp', false]] as const) {
    const f = field(key);
    if (!f || f.kind !== 'level') continue;
    const unit = String(base[`${key}_unit`] ?? f.units[0]);
    const sg = unit === 'pct' ? { min: 0, max: 100, step: 25 } : unit === 'points' ? { min: 0, max: 60, step: 20 } : unit === 'pct_premium' ? { min: 0, max: 75, step: 25 } : { min: 0, max: 3000, step: 1000 };
    out.push({ key, label: `${f.label} (${UNIT_WORD[unit] ?? unit})`, short: `${SHORT[key]} ${UNIT_WORD[unit] ?? unit}`, kind: 'number', unit: UNIT_WORD[unit] ?? unit, ordered: true, on, bounds: { min: 0, max: unit === 'pct' || unit === 'pct_premium' ? 1000 : 1000000, grain: 0 },
      suggest: sg, note: `${OFF_NOTE} The unit is the one set in the Lab (${UNIT_WORD[unit] ?? unit}); change it there to search in another.` });
  }
  if (field('max_entries')) out.push({ key: 'max_entries', label: 'Trades per session', short: 'Trades/session', kind: 'number', unit: 'trades', ordered: true, on: false, bounds: { min: 1, max: 10, grain: 0 }, suggest: { min: 1, max: 3, step: 1 } });
  if (field('lots')) out.push({ key: 'lots', label: 'Lots', kind: 'number', unit: 'lots', ordered: true, on: false, bounds: { min: 1, max: 20, grain: 0 }, suggest: { min: 1, max: 2, step: 1 }, note: LOTS_NOTE });
  return out;
}

const round6 = (x: number) => Math.round(x * 1e6) / 1e6;
/** The values of a number or time axis from min to max by step, inside its bounds and on its grain. Errors in words. */
export function rangeValues(a: AxisDef, min: number, max: number, step: number): { values: Value[]; error: string | null } {
  if (a.kind === 'choice') return { values: [], error: 'not a range' };
  if (![min, max, step].every(Number.isFinite)) return { values: [], error: 'Enter numbers for from, to and step.' };
  if (!(step > 0)) return { values: [], error: 'The step must be more than 0.' };
  if (max < min) return { values: [], error: '“To” is below “from”.' };
  const b = a.bounds!;
  if (min < b.min || max > b.max) return { values: [], error: a.kind === 'time' ? `Between ${toHM(b.min)} and ${toHM(b.max)}.` : `Between ${b.min} and ${b.max}.` };
  if (a.kind === 'time' && b.grain > 1 && (step % b.grain || (min - 555) % b.grain)) return { values: [], error: `On the ${b.grain}-minute grid: from and step must be multiples of ${b.grain} minutes.` };
  const n = Math.floor((max - min) / step + 1e-9) + 1;
  if (n > 500) return { values: [], error: `That is ${n} values; at most 500 per setting.` };
  const values: Value[] = [];
  for (let i = 0; i < n; i++) { const v = round6(min + i * step); values.push(a.kind === 'time' ? toHM(v) : v); }
  return { values, error: null };
}

// ------------------------------------------------------------------ configurations
export interface Space { picks: AxisPick[]; size: number }
export const spaceOf = (picks: AxisPick[]): Space => ({ picks, size: picks.reduce((n, p) => n * p.values.length, 1) });

/** The values of grid point `index` (mixed radix, the last setting changing fastest). */
export function valuesAt(sp: Space, index: number): Value[] {
  const out = new Array<Value>(sp.picks.length);
  let r = index;
  for (let i = sp.picks.length - 1; i >= 0; i--) { const n = sp.picks[i].values.length; out[i] = sp.picks[i].values[r % n]; r = Math.floor(r / n); }
  return out;
}
/** The grid index of a set of value positions (inverse of valuesAt on positions). */
export function indexOf(sp: Space, pos: number[]): number {
  let idx = 0;
  for (let i = 0; i < sp.picks.length; i++) idx = idx * sp.picks[i].values.length + pos[i];
  return idx;
}
export function positionsAt(sp: Space, index: number): number[] {
  const out = new Array<number>(sp.picks.length);
  let r = index;
  for (let i = sp.picks.length - 1; i >= 0; i--) { const n = sp.picks[i].values.length; out[i] = r % n; r = Math.floor(r / n); }
  return out;
}

/** Seeded generator (mulberry32), the same sequence everywhere. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export const HARD_CAP = 20000;
/**
 * Which grid points a study runs: all of them when the grid fits `max`; otherwise (method 'random', or 'auto') a seeded
 * sample of `max` distinct points. 'grid' with too many points is refused rather than cut. Sorted, so a study always
 * runs them in the same order. Candidate ids are grid index + 1 (0 is your current settings).
 */
export function plannedIndices(sp: Space, o: { method: 'auto' | 'grid' | 'random'; max: number; seed: number }): { method: 'grid' | 'random'; indices: number[]; capped: boolean } {
  const max = Math.max(1, Math.min(HARD_CAP, Math.round(o.max)));
  if (sp.size <= max) return { method: 'grid', indices: Array.from({ length: sp.size }, (_, i) => i), capped: false };
  if (o.method === 'grid') throw new Error(`The grid has ${sp.size.toLocaleString('en-IN')} configurations, more than the limit of ${max.toLocaleString('en-IN')}. Narrow the ranges, raise the limit, or use random search.`);
  const R = rng(o.seed), picked = new Set<number>();
  if (sp.size <= 4 * max) {
    // a partial Fisher–Yates over the whole index range: exactly `max` distinct points
    const all = Array.from({ length: sp.size }, (_, i) => i);
    for (let i = 0; i < max; i++) { const j = i + Math.floor(R() * (sp.size - i)); [all[i], all[j]] = [all[j], all[i]]; picked.add(all[i]); }
  } else {
    while (picked.size < max) picked.add(Math.floor(R() * sp.size));
  }
  return { method: 'random', indices: [...picked].sort((a, b) => a - b), capped: true };
}

/** The Lab parameters of a configuration: the current settings with the searched values put in. */
export function paramsFor(s: LabStrategy, base: Params, sp: Space, values: Value[]): Params {
  const p: Params = { ...base };
  const offsets: Partial<Record<'CE' | 'PE', number>> = {};
  sp.picks.forEach((pick, i) => {
    if (pick.key === 'call_offset') offsets.CE = Number(values[i]);
    else if (pick.key === 'put_offset') offsets.PE = Number(values[i]);
    else p[pick.key] = values[i];
  });
  if (s.family === 'builder' && (offsets.CE != null || offsets.PE != null)) {
    const drafts = legDrafts(s.template as TemplateId, p).map((d) => ({ ...d, strike: { ...d.strike } }));
    for (const right of ['CE', 'PE'] as const) {
      const want = offsets[right];
      const at = sideSteps(drafts, right);
      if (want == null || at == null) continue;
      for (const d of drafts) if (d.right === right && d.strike.by === 'atm') (d.strike as { steps: number }).steps += want - at;
    }
    p.legs = JSON.stringify(drafts);
  }
  return p;
}

/** Why a configuration cannot run (null = it can): a time out of bounds or order, or the engine's own spec checks. */
export function refusal(s: LabStrategy, p: Params, ctx: { real: boolean; series: Series }): string | null {
  const times = s.fields.filter((f): f is Extract<typeof f, { kind: 'time' }> => f.kind === 'time');
  for (const f of times) { const t = timeProblem(toMin(p[f.key]), { min: toMin(f.min)!, max: toMin(f.max)!, grain: f.grain }); if (t) return `${f.label}: ${t}`; }
  const seq = sequenceProblems(times.map((f) => ({ key: f.key, role: f.role, value: toMin(p[f.key]) })), p.hold !== 'expiry').find((x) => x.level === 'error');
  if (seq) return seq.text;
  if (s.family === 'builder') {
    const v = Legs.validate(builderSpec(s.template as TemplateId, p, ctx.series), labCaps(ctx.real, ctx.series));
    if (!v.ok) return v.errors[0].message;
  }
  return null;
}

/** The run request of a configuration (what the optimiser worker evaluates). */
export const runParamsFor = (s: LabStrategy, p: Params, series: Series): Params => s.toRunParams(p, { series });

export interface Estimate {
  size: number; planned: number; method: 'grid' | 'random'; capped: boolean;
  valid: number; exact: boolean; refused: { reason: string; n: number }[];
  extra: number; runs: number;
}
/**
 * Before anything runs: the grid size, how many configurations the study will try (with your current settings), how
 * many of those can run (exact up to 3,000, otherwise estimated from a seeded sample of 1,000) and the refusals by
 * reason, and the extra robustness runs (finalists × (two neighbours per ordered setting + doubled slippage)).
 */
export function estimate(s: LabStrategy, base: Params, defs: AxisDef[], picks: AxisPick[], o: { method: 'auto' | 'grid' | 'random'; max: number; seed: number; topK: number; real: boolean; series: Series }): Estimate {
  const sp = spaceOf(picks);
  const plan = plannedIndices(sp, o);
  const reasons = new Map<string, number>();
  const check = (p: Params) => { const r = refusal(s, p, o); if (r) reasons.set(r, (reasons.get(r) ?? 0) + 1); return !r; };
  const all = plan.indices;
  const exact = all.length <= 3000;
  const sample = exact ? all : (() => { const R = rng(o.seed + 7); const out: number[] = []; for (let i = 0; i < 1000; i++) out.push(all[Math.floor(R() * all.length)]); return out; })();
  let ok = 0;
  for (const i of sample) if (check(paramsFor(s, base, sp, valuesAt(sp, i)))) ok++;
  const baseOk = !refusal(s, base, o);
  const valid = (exact ? ok : Math.round((ok / sample.length) * all.length)) + (baseOk ? 1 : 0);
  const orderedAxes = picks.filter((p) => defs.find((d) => d.key === p.key)?.ordered && p.values.length > 1).length;
  const extra = Math.min(o.topK, valid) * (2 * orderedAxes + 1);
  const scale = exact ? 1 : all.length / sample.length;
  return { size: sp.size, planned: all.length + 1, method: plan.method, capped: plan.capped, valid, exact,
    refused: [...reasons.entries()].map(([reason, n]) => ({ reason, n: Math.round(n * scale) })).sort((a, b) => b.n - a.n).slice(0, 4),
    extra, runs: valid + extra };
}

export { labStrategy };
