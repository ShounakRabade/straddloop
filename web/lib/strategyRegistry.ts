/**
 * Every strategy the Lab can run, behind one shape. Two families share it:
 *  - published rule sets (01–04): fixed engines with their own documented rules (lib/strategies.ts);
 *  - the strategy builder: named structures from the leg engine's templates (lib/legs/templates.ts), configured with
 *    flat Lab parameters that `builderSpec` turns into a StrategySpec (docs/ENGINE_INTERFACES.md §1).
 * The Lab, the notebook and ?s= links only ever hold flat parameters keyed by a slug; the spec is built from them
 * when a run is sent. Adding a structure means adding a template; adding an engine means registering it here.
 */
import { ACCOUNT_DEFAULTS, STRATEGIES, type Field, type Strategy } from './strategies.ts';
import { ENTRY, EXIT_TEXT, LEGS } from './labSections.ts';
import { TEMPLATES, specFromTemplate, type TemplateInfo } from './legs/templates.ts';
import type { LegSpec, Series, StrategySpec, TemplateId } from './legs/types';
import type { LabSlug, Params } from './types';

export type { LabSlug };
export type Family = 'engine' | 'builder';
export type LabGroup = 'published' | 'directional' | 'volatility' | 'multileg' | 'more';
export type Engine = 'straddle' | 'orb' | 'ema_pullback' | 'fourleg' | 'legs';

export const GROUPS: { id: LabGroup; title: string }[] = [
  { id: 'published', title: 'Published rule sets' },
  { id: 'directional', title: 'Directional' },
  { id: 'volatility', title: 'Volatility' },
  { id: 'multileg', title: 'Multi-leg' },
  { id: 'more', title: 'More structures' },
];

/** One row of the legs table shown in the Lab. */
export interface LegRow { action: string; right: string; strike: string; qty: string; expiry: string; stop?: string }

export interface LabStrategy {
  slug: LabSlug;
  family: Family;
  group: LabGroup;
  /** What compute.run dispatches on (params.strategy of the run request). */
  engine: Engine;
  template?: TemplateId;
  number: string;
  name: string;
  short: string;
  oneLine: string;
  stance: string;
  defaults: Params;
  fields: Field[];
  realOk: boolean;
  syntheticOk: boolean;
  /** Why it cannot run on the stored data at all (null = it can). */
  blocked: string | null;
  /** Whether the optimiser may search it, and why not. */
  optimise: { ok: true } | { ok: false; why: string };
  /** The page with the full rule text (published rule sets only). */
  rulesHref: string | null;
  legs: (p: Params) => LegRow[];
  entryText: (p: Params) => string;
  exitText: (p: Params) => string;
  /** The parameters a run request carries. Builder strategies gain `strategy: 'legs'` and the spec (JSON). */
  toRunParams: (p: Params, ctx: { series: Series }) => Params;
}

// ------------------------------------------------------------------ published rule sets

const FOURLEG_NO_OPTIMISE = 'The four-leg strategy runs on a synthetic stock model with its own margin and no account ledger. '
  + 'Searching its settings would fit that model, not tell you anything about real stock options.';

function engineEntry(s: Strategy): LabStrategy {
  return {
    slug: s.slug, family: 'engine', group: 'published', engine: s.slug, number: s.number, name: s.name, short: s.short, oneLine: s.oneLine, stance: s.stance,
    defaults: s.defaults, fields: s.fields, realOk: s.slug !== 'fourleg', syntheticOk: s.slug !== 'ema_pullback', blocked: null,
    optimise: s.slug === 'fourleg' ? { ok: false, why: FOURLEG_NO_OPTIMISE } : { ok: true },
    rulesHref: `/strategies/${s.slug}`,
    legs: () => LEGS[s.slug], entryText: () => ENTRY[s.slug], exitText: () => EXIT_TEXT[s.slug],
    toRunParams: (p) => p,
  };
}

// ------------------------------------------------------------------ the strategy builder

const GROUP_OF: Partial<Record<TemplateId, LabGroup>> = {
  long_call: 'directional', long_put: 'directional', short_call: 'directional', short_put: 'directional',
  bull_call_spread: 'directional', bear_put_spread: 'directional', bull_put_spread: 'directional', bear_call_spread: 'directional',
  long_straddle: 'volatility', short_straddle: 'volatility', long_strangle: 'volatility', short_strangle: 'volatility',
  iron_condor: 'multileg', iron_butterfly: 'multileg', call_ratio_spread: 'multileg', put_ratio_spread: 'multileg',
};
/** Templates whose default strikes are at the money; the rest default two strikes out of the money. */
const ATM_TEMPLATES = new Set<TemplateId>(['long_call', 'long_put', 'short_call', 'short_put', 'bull_call_spread', 'bear_put_spread', 'bull_put_spread', 'bear_call_spread', 'calendar_call', 'calendar_put']);
const NEXT_EXPIRY = 'Needs the expiry after the nearest one. Only the nearest expiry of each series is stored, so this structure cannot run on the stored data.';

const at = (...xs: string[]) => xs.map((value) => ({ value, label: value }));

/** Which template parameters change the legs (found by building them, so it can never drift from the template). */
function usesOf(t: TemplateInfo) {
  const base = { lots: 1, width: 2, offset: 2, series: 'WEEK' as Series };
  const same = (a: object, b: object) => JSON.stringify(t.legs({ ...base, ...a })) === JSON.stringify(t.legs({ ...base, ...b }));
  const legs = t.legs(base);
  return { offset: !same({ offset: 0 }, { offset: 3 }), width: !same({ width: 1 }, { width: 3 }), short: legs.some((l) => l.action === 'SELL'), long: legs.some((l) => l.action === 'BUY') };
}

const num = (p: Params, k: string, d: number) => (typeof p[k] === 'number' && Number.isFinite(p[k] as number) ? (p[k] as number) : d);
const str = (p: Params, k: string, d: string) => (typeof p[k] === 'string' && p[k] ? (p[k] as string) : d);

/** The StrategySpec a builder strategy runs, from its flat Lab parameters. Zero means "off" for stops and targets. */
export function builderSpec(id: TemplateId, p: Params, series: Series = 'WEEK'): StrategySpec {
  const maxEntries = Math.round(num(p, 'max_entries', 1)), cooldown = Math.round(num(p, 'cooldown_min', 0));
  const target = num(p, 'target_per_lot', 0), stop = num(p, 'stop_per_lot', 0);
  const onStop = (['keep_others', 'close_all', 'reenter'] as const).find((x) => x === p.on_leg_stop) ?? 'keep_others';
  const spec = specFromTemplate(id, { lots: Math.round(num(p, 'lots', 1)), width: Math.round(num(p, 'width', 2)), offset: Math.round(num(p, 'offset', ATM_TEMPLATES.has(id) ? 0 : 2)), series }, {
    entry: { time: str(p, 'entry_time', '09:20'), weekdays: [0, 1, 2, 3, 4], conditions: [], ...(maxEntries > 1 ? { max_entries: maxEntries } : {}), ...(cooldown > 0 ? { cooldown_min: cooldown } : {}) },
    exit: { hold: p.hold === 'expiry' ? 'expiry' : 'intraday', time: str(p, 'exit_time', '15:15'), settle_at_expiry: true, basis: 'net',
      ...(target > 0 ? { target: { kind: 'rupees_per_lot', value: target } } : {}), ...(stop > 0 ? { stop: { kind: 'rupees_per_lot', value: stop } } : {}) },
    adjust: { on_leg_stop: onStop, max_reentries: onStop === 'reenter' ? Math.round(num(p, 'max_reentries', 1)) : 0, cutoff: str(p, 'cutoff', '14:30') },
    execution: { slip_pct: num(p, 'slip_pct', 0.5), slip_ticks: 1, stop_slip_mult: 2, stop_fill: 'gap_aware', brokerage_per_order: num(p, 'brokerage_per_order', 20), exercise_stt_pct: 0.125 },
  });
  const shortSl = num(p, 'short_sl_pct', 0), longSl = num(p, 'long_sl_pct', 0);
  spec.legs = spec.legs.map((l) => {
    const v = l.action === 'SELL' ? shortSl : longSl;
    return v > 0 ? { ...l, stop: { kind: 'pct', value: v } } : l;
  });
  return spec;
}

function strikeText(l: LegSpec): string {
  const s = l.strike;
  if (s.by === 'atm') return s.steps === 0 ? 'ATM' : s.steps > 0 ? `${s.steps} OTM` : `${-s.steps} ITM`;
  if (s.by === 'leg') return s.steps === 0 ? `same as ${s.leg}` : `${s.leg} ${s.steps > 0 ? '+' : '−'} ${Math.abs(s.steps)}`;
  if (s.by === 'pct') return `${s.pct}% from spot`;
  if (s.by === 'premium') return `premium ≈ ${s.price}`;
  return `delta ${s.delta}`;
}
const levelText = (v: { kind: string; value: number } | undefined) => (!v ? '—' : v.kind === 'pct' ? `${v.value}%` : v.kind === 'points' ? `${v.value} pts` : v.kind === 'rupees' ? `₹${v.value.toLocaleString('en-IN')}` : `₹${v.value.toLocaleString('en-IN')}/lot`);

function builderEntry(t: TemplateInfo, i: number): LabStrategy {
  const uses = usesOf(t);
  const blocked = t.needs === 'next expiry' ? NEXT_EXPIRY : null;
  const offsetDefault = ATM_TEMPLATES.has(t.id) ? 0 : 2;
  const fields: Field[] = [
    { key: 'entry_time', label: 'Entry time', help: 'The order is decided on the bars that closed before this minute and fills at its open.', kind: 'choice', options: at('09:16', '09:20', '09:30', '09:45', '10:00', '10:30', '11:00', '12:00', '13:00', '14:00') },
    { key: 'exit_time', label: 'Exit time', help: 'Everything still open is closed at this minute (intraday), or on the exit day.', kind: 'choice', options: at('13:00', '14:00', '14:30', '15:00', '15:10', '15:15', '15:20', '15:25') },
    ...(uses.offset ? [{ key: 'offset', label: 'Strike', help: 'Strikes out of the money (+) or in the money (−) for the first legs; spreads build their other legs from it. Only ATM ± 10 strikes are stored.', kind: 'range' as const, min: -3, max: 8, step: 1, unit: ' from ATM' }] : []),
    ...(uses.width ? [{ key: 'width', label: 'Width', help: 'Strikes between the legs of a spread, or from the body to each wing. Offset plus width must stay within the stored ATM ± 10.', kind: 'range' as const, min: 1, max: 8, step: 1, unit: ' strikes' }] : []),
    { key: 'hold', label: 'Hold', help: 'Intraday closes at the exit time. To expiry carries the position and cash-settles it at intrinsic value (real data only).', kind: 'choice', options: [{ value: 'intraday', label: 'Intraday' }, { value: 'expiry', label: 'To expiry' }] },
    ...(uses.short ? [{ key: 'short_sl_pct', label: 'Stop on each short leg', help: 'Buy a short leg back when its premium rises this far above the sell price. 0 = no stop.', kind: 'range' as const, min: 0, max: 300, step: 5, unit: '%', zeroOff: true }] : []),
    ...(uses.long ? [{ key: 'long_sl_pct', label: 'Stop on each long leg', help: 'Sell a long leg when its premium falls this far below the buy price. 0 = no stop.', kind: 'range' as const, min: 0, max: 95, step: 5, unit: '%', zeroOff: true }] : []),
    { key: 'target_per_lot', label: 'Position target per lot', help: 'Net of charges paid and the estimated charges to close. Everything closes at the next bar when reached. 0 = no target.', kind: 'range', min: 0, max: 10000, step: 250, prefix: '₹', zeroOff: true },
    { key: 'stop_per_lot', label: 'Position stop per lot', help: 'Net loss per lot that closes everything at the next bar. 0 = no position stop.', kind: 'range', min: 0, max: 20000, step: 250, prefix: '₹', zeroOff: true },
    { key: 'on_leg_stop', label: 'When a leg is stopped', help: 'Keep the other legs, close them all, or open the stopped leg again (its strike is picked again).', kind: 'choice', options: [{ value: 'keep_others', label: 'Keep the others' }, { value: 'close_all', label: 'Close all' }, { value: 'reenter', label: 'Re-enter it' }] },
    { key: 'max_reentries', label: 'Re-entries per leg', help: 'Used when a stopped leg is re-entered.', kind: 'range', min: 1, max: 5, step: 1 },
    { key: 'max_entries', label: 'Trades per session', help: 'One position at a time. After one closes, the next opens on the first bar where the entry rules pass, before the last-entry time.', kind: 'range', min: 1, max: 10, step: 1 },
    { key: 'cooldown_min', label: 'Wait after a trade', help: 'Minutes after a position closes before the next may open.', kind: 'range', min: 0, max: 120, step: 5, unit: ' min' },
    { key: 'cutoff', label: 'Last new entry', help: 'No new position or re-entry opens at or after this time.', kind: 'choice', options: at('10:00', '11:00', '12:00', '13:00', '14:00', '14:30', '15:00') },
    { key: 'lots', label: 'Lots', help: 'Base lots. Each leg trades lots × its ratio × the lot size.', kind: 'range', min: 1, max: 20, step: 1 },
    { key: 'slip_pct', label: 'Slippage per fill', help: 'Taken off every sell and added to every buy, on top of the candle price. Stops pay double. Real data has no bid/ask, so keep this above zero.', kind: 'range', min: 0, max: 3, step: 0.25, unit: '%' },
    ...STRATEGIES[0].fields.filter((f) => ['capital', 'margin_policy', 'margin_span_pct', 'margin_exposure_pct', 'brokerage_per_order', 'days', 'seed', 'iv'].includes(f.key)),
  ];
  const defaults: Params = {
    strategy: t.id, days: 120, seed: 1, iv: 13, entry_time: '09:20', exit_time: '15:15', hold: 'intraday', short_sl_pct: 0, long_sl_pct: 0, target_per_lot: 0, stop_per_lot: 0,
    on_leg_stop: 'keep_others', max_reentries: 1, max_entries: 1, cooldown_min: 0, cutoff: '14:30', lots: 1, slip_pct: 0.5, ...ACCOUNT_DEFAULTS,
    ...(uses.offset ? { offset: offsetDefault } : {}), ...(uses.width ? { width: 2 } : {}),
  };
  for (const k of Object.keys(defaults)) if (k !== 'strategy' && !fields.some((f) => f.key === k)) delete defaults[k];
  const spec = (p: Params, series: Series = 'WEEK') => builderSpec(t.id, p, series);
  return {
    slug: t.id, family: 'builder', group: GROUP_OF[t.id] ?? 'more', engine: 'legs', template: t.id, number: `B${String(i + 1).padStart(2, '0')}`,
    name: t.name, short: t.name, oneLine: t.summary, stance: `${t.outlook}, ${t.risk} risk`,
    defaults, fields, realOk: true, syntheticOk: true, blocked, optimise: blocked ? { ok: false, why: blocked } : { ok: true }, rulesHref: null,
    legs: (p) => spec(p).legs.map((l) => ({ action: l.action === 'BUY' ? 'Buy' : 'Sell', right: l.right, strike: strikeText(l), qty: `${l.ratio} × lots`,
        expiry: l.expiry.nth === 2 ? 'Next' : 'Nearest', stop: levelText(l.stop) })),
    entryText: (p) => {
      const s = spec(p), me = s.entry.max_entries ?? 1, cd = s.entry.cooldown_min ?? 0;
      return `${s.entry.time} on every weekday, all legs at the same bar or none.` + (me > 1 ? ` Up to ${me} positions a session, one at a time: the next opens on the first bar after the previous closes${cd ? ` plus ${cd} min` : ''}, none from ${s.adjust.cutoff}.` : '');
    },
    exitText: (p) => {
      const s = spec(p), parts: string[] = [];
      const sl = s.legs.find((l) => l.action === 'SELL' && l.stop), ll = s.legs.find((l) => l.action === 'BUY' && l.stop);
      if (sl) parts.push(`short-leg stop ${levelText(sl.stop)}`);
      if (ll) parts.push(`long-leg stop ${levelText(ll.stop)}`);
      if (s.exit.target) parts.push(`position target ${levelText(s.exit.target)}`);
      if (s.exit.stop) parts.push(`position stop ${levelText(s.exit.stop)}`);
      parts.push(s.exit.hold === 'expiry' ? `cash settlement at expiry (other legs at ${s.exit.time} on expiry day)` : s.exit.time);
      return `${parts.join(', ')}.`.replace(/^./, (c) => c.toUpperCase());
    },
    toRunParams: (p, ctx) => ({ ...p, strategy: 'legs', template: t.id, spec: JSON.stringify(spec(p, ctx.series)) }),
  };
}

const ENGINE_ENTRIES = STRATEGIES.map(engineEntry);
const ORDER: LabGroup[] = ['directional', 'volatility', 'multileg', 'more'];
const BUILDER_ENTRIES = ORDER.flatMap((g) => TEMPLATES.filter((t) => (GROUP_OF[t.id] ?? 'more') === g)).map(builderEntry);

export const REGISTRY: LabStrategy[] = [...ENGINE_ENTRIES, ...BUILDER_ENTRIES];

export const labStrategy = (slug: string): LabStrategy | undefined => REGISTRY.find((s) => s.slug === slug);
export const inGroup = (g: LabGroup) => REGISTRY.filter((s) => s.group === g);
/** The 16 structures the builder offers first (directional, volatility, multi-leg). */
export const CORE_BUILDER = BUILDER_ENTRIES.filter((s) => s.group !== 'more');

/** The registry entry a run result belongs to (a leg-engine result carries its template). */
export const slugOfResult = (r: { strategy: string; spec?: { template?: string } }): string => (r.strategy === 'legs' ? r.spec?.template ?? 'custom' : r.strategy);

