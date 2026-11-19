/**
 * Named strategies as leg templates (docs/ENGINE_INTERFACES.md §1, Templates). A template only fills in a
 * StrategySpec; the engine never knows which template made a spec. Strike conventions:
 *   { by: 'atm', steps: n }        n strikes OUT of the money for that leg's right (negative = in the money)
 *   { by: 'leg', leg, steps: n }   n strikes ABOVE another leg's strike (negative = below)
 */
import type { Action, LegSpec, Right, Series, StrategySpec, TemplateId } from './types';

export interface TemplateParams {
  /** Base lots; a leg's quantity is lots × its ratio × the lot size. */
  lots?: number;
  /** Strikes between the legs of a spread, or from the body to a wing. */
  width?: number;
  /** Strikes out of the money for the short (or long) legs of strangles, condors and credit spreads. */
  offset?: number;
  /** Expiry cycle for the near legs. */
  series?: Series;
}

export interface TemplateInfo {
  id: TemplateId;
  name: string;
  outlook: 'bullish' | 'bearish' | 'neutral' | 'volatile' | 'directional volatile';
  /** 'defined' = the worst loss at expiry is bounded by the structure itself. */
  risk: 'defined' | 'undefined';
  /** Data the template needs beyond the nearest expiry. */
  needs: 'nearest expiry' | 'next expiry';
  summary: string;
  legs: (p: Required<TemplateParams>) => LegSpec[];
}

const leg = (id: string, action: Action, right: Right, strike: LegSpec['strike'], ratio = 1, series: Series = 'WEEK', nth: 1 | 2 = 1): LegSpec =>
  ({ id, action, right, ratio, expiry: { series, nth }, strike });
const atm = (steps = 0) => ({ by: 'atm' as const, steps });
const rel = (to: string, steps: number) => ({ by: 'leg' as const, leg: to, steps });

export const TEMPLATES: TemplateInfo[] = [
  { id: 'long_call', name: 'Long call', outlook: 'bullish', risk: 'defined', needs: 'nearest expiry', summary: 'Buy one call. Loss is the premium paid; gain grows as the index rises.',
    legs: (p) => [leg('L1', 'BUY', 'CE', atm(p.offset), 1, p.series)] },
  { id: 'long_put', name: 'Long put', outlook: 'bearish', risk: 'defined', needs: 'nearest expiry', summary: 'Buy one put. Loss is the premium paid; gain grows as the index falls.',
    legs: (p) => [leg('L1', 'BUY', 'PE', atm(p.offset), 1, p.series)] },
  { id: 'short_call', name: 'Short call', outlook: 'bearish', risk: 'undefined', needs: 'nearest expiry', summary: 'Sell one call. Keeps the premium if the index stays below the strike; loss is unbounded above.',
    legs: (p) => [leg('L1', 'SELL', 'CE', atm(p.offset), 1, p.series)] },
  { id: 'short_put', name: 'Short put', outlook: 'bullish', risk: 'undefined', needs: 'nearest expiry', summary: 'Sell one put. Keeps the premium if the index stays above the strike; loss grows as it falls.',
    legs: (p) => [leg('L1', 'SELL', 'PE', atm(p.offset), 1, p.series)] },
  { id: 'bull_call_spread', name: 'Bull call spread', outlook: 'bullish', risk: 'defined', needs: 'nearest expiry', summary: 'Buy a call, sell a higher call. A cheaper long call with capped gain.',
    legs: (p) => [leg('L1', 'BUY', 'CE', atm(p.offset), 1, p.series), leg('L2', 'SELL', 'CE', rel('L1', p.width), 1, p.series)] },
  { id: 'bear_put_spread', name: 'Bear put spread', outlook: 'bearish', risk: 'defined', needs: 'nearest expiry', summary: 'Buy a put, sell a lower put. A cheaper long put with capped gain.',
    legs: (p) => [leg('L1', 'BUY', 'PE', atm(p.offset), 1, p.series), leg('L2', 'SELL', 'PE', rel('L1', -p.width), 1, p.series)] },
  { id: 'bull_put_spread', name: 'Bull put spread (credit)', outlook: 'bullish', risk: 'defined', needs: 'nearest expiry', summary: 'Sell a put, buy a lower put as protection. Collects a credit; loss capped at width minus credit.',
    legs: (p) => [leg('L1', 'SELL', 'PE', atm(p.offset), 1, p.series), leg('L2', 'BUY', 'PE', rel('L1', -p.width), 1, p.series)] },
  { id: 'bear_call_spread', name: 'Bear call spread (credit)', outlook: 'bearish', risk: 'defined', needs: 'nearest expiry', summary: 'Sell a call, buy a higher call as protection. Collects a credit; loss capped at width minus credit.',
    legs: (p) => [leg('L1', 'SELL', 'CE', atm(p.offset), 1, p.series), leg('L2', 'BUY', 'CE', rel('L1', p.width), 1, p.series)] },
  { id: 'long_straddle', name: 'Long straddle', outlook: 'volatile', risk: 'defined', needs: 'nearest expiry', summary: 'Buy the ATM call and put. Needs a move larger than the premium paid, in either direction.',
    legs: (p) => [leg('L1', 'BUY', 'CE', atm(0), 1, p.series), leg('L2', 'BUY', 'PE', atm(0), 1, p.series)] },
  { id: 'short_straddle', name: 'Short straddle', outlook: 'neutral', risk: 'undefined', needs: 'nearest expiry', summary: 'Sell the ATM call and put. Earns the premium if the index stays near the strike; loss is unbounded.',
    legs: (p) => [leg('L1', 'SELL', 'CE', atm(0), 1, p.series), leg('L2', 'SELL', 'PE', atm(0), 1, p.series)] },
  { id: 'long_strangle', name: 'Long strangle', outlook: 'volatile', risk: 'defined', needs: 'nearest expiry', summary: 'Buy an OTM call and an OTM put. Cheaper than a straddle; needs a bigger move.',
    legs: (p) => [leg('L1', 'BUY', 'CE', atm(p.offset), 1, p.series), leg('L2', 'BUY', 'PE', atm(p.offset), 1, p.series)] },
  { id: 'short_strangle', name: 'Short strangle', outlook: 'neutral', risk: 'undefined', needs: 'nearest expiry', summary: 'Sell an OTM call and an OTM put. Wider break-evens than a straddle; loss is unbounded.',
    legs: (p) => [leg('L1', 'SELL', 'CE', atm(p.offset), 1, p.series), leg('L2', 'SELL', 'PE', atm(p.offset), 1, p.series)] },
  { id: 'iron_condor', name: 'Iron condor', outlook: 'neutral', risk: 'defined', needs: 'nearest expiry', summary: 'A short strangle with a bought wing on each side. Loss capped at the wider wing minus the credit.',
    legs: (p) => [leg('L1', 'BUY', 'PE', atm(p.offset + p.width), 1, p.series), leg('L2', 'SELL', 'PE', atm(p.offset), 1, p.series),
      leg('L3', 'SELL', 'CE', atm(p.offset), 1, p.series), leg('L4', 'BUY', 'CE', atm(p.offset + p.width), 1, p.series)] },
  { id: 'iron_butterfly', name: 'Iron butterfly', outlook: 'neutral', risk: 'defined', needs: 'nearest expiry', summary: 'A short straddle with a bought wing on each side.',
    legs: (p) => [leg('L1', 'SELL', 'CE', atm(0), 1, p.series), leg('L2', 'SELL', 'PE', atm(0), 1, p.series),
      leg('L3', 'BUY', 'CE', rel('L1', p.width), 1, p.series), leg('L4', 'BUY', 'PE', rel('L2', -p.width), 1, p.series)] },
  { id: 'long_call_butterfly', name: 'Long call butterfly', outlook: 'neutral', risk: 'defined', needs: 'nearest expiry', summary: 'Buy a lower call, sell two ATM calls, buy a higher call. Pays most if the index ends at the middle strike.',
    legs: (p) => [leg('L1', 'SELL', 'CE', atm(0), 2, p.series), leg('L2', 'BUY', 'CE', rel('L1', -p.width), 1, p.series), leg('L3', 'BUY', 'CE', rel('L1', p.width), 1, p.series)] },
  { id: 'long_put_butterfly', name: 'Long put butterfly', outlook: 'neutral', risk: 'defined', needs: 'nearest expiry', summary: 'Buy a higher put, sell two ATM puts, buy a lower put.',
    legs: (p) => [leg('L1', 'SELL', 'PE', atm(0), 2, p.series), leg('L2', 'BUY', 'PE', rel('L1', p.width), 1, p.series), leg('L3', 'BUY', 'PE', rel('L1', -p.width), 1, p.series)] },
  { id: 'broken_wing_butterfly', name: 'Broken-wing call butterfly', outlook: 'neutral', risk: 'defined', needs: 'nearest expiry', summary: 'A call butterfly whose upper wing is twice as far: little or no risk below, more above.',
    legs: (p) => [leg('L1', 'SELL', 'CE', atm(0), 2, p.series), leg('L2', 'BUY', 'CE', rel('L1', -p.width), 1, p.series), leg('L3', 'BUY', 'CE', rel('L1', 2 * p.width), 1, p.series)] },
  { id: 'call_ratio_spread', name: 'Call ratio spread (1×2)', outlook: 'neutral', risk: 'undefined', needs: 'nearest expiry', summary: 'Buy one call, sell two higher calls. Profits in a modest rise; loss is unbounded in a big rally.',
    legs: (p) => [leg('L1', 'BUY', 'CE', atm(0), 1, p.series), leg('L2', 'SELL', 'CE', rel('L1', p.width), 2, p.series)] },
  { id: 'put_ratio_spread', name: 'Put ratio spread (1×2)', outlook: 'neutral', risk: 'undefined', needs: 'nearest expiry', summary: 'Buy one put, sell two lower puts. Profits in a modest fall; loss grows in a crash.',
    legs: (p) => [leg('L1', 'BUY', 'PE', atm(0), 1, p.series), leg('L2', 'SELL', 'PE', rel('L1', -p.width), 2, p.series)] },
  { id: 'call_backspread', name: 'Call backspread (1×2)', outlook: 'directional volatile', risk: 'defined', needs: 'nearest expiry', summary: 'Sell one call, buy two higher calls. Pays in a strong rally; worst loss near the upper strike.',
    legs: (p) => [leg('L1', 'SELL', 'CE', atm(0), 1, p.series), leg('L2', 'BUY', 'CE', rel('L1', p.width), 2, p.series)] },
  { id: 'put_backspread', name: 'Put backspread (1×2)', outlook: 'directional volatile', risk: 'defined', needs: 'nearest expiry', summary: 'Sell one put, buy two lower puts. Pays in a sharp fall; worst loss near the lower strike.',
    legs: (p) => [leg('L1', 'SELL', 'PE', atm(0), 1, p.series), leg('L2', 'BUY', 'PE', rel('L1', -p.width), 2, p.series)] },
  { id: 'calendar_call', name: 'Call calendar', outlook: 'neutral', risk: 'defined', needs: 'next expiry', summary: 'Sell the near-expiry call, buy the same strike in the next expiry. Needs next-expiry data.',
    legs: (p) => [leg('L1', 'SELL', 'CE', atm(p.offset), 1, p.series, 1), leg('L2', 'BUY', 'CE', rel('L1', 0), 1, p.series, 2)] },
  { id: 'calendar_put', name: 'Put calendar', outlook: 'neutral', risk: 'defined', needs: 'next expiry', summary: 'Sell the near-expiry put, buy the same strike in the next expiry. Needs next-expiry data.',
    legs: (p) => [leg('L1', 'SELL', 'PE', atm(p.offset), 1, p.series, 1), leg('L2', 'BUY', 'PE', rel('L1', 0), 1, p.series, 2)] },
  { id: 'diagonal_call', name: 'Call diagonal', outlook: 'bullish', risk: 'defined', needs: 'next expiry', summary: 'Buy a next-expiry call, sell a higher near-expiry call. Needs next-expiry data.',
    legs: (p) => [leg('L1', 'BUY', 'CE', atm(0), 1, p.series, 2), leg('L2', 'SELL', 'CE', rel('L1', p.width), 1, p.series, 1)] },
  { id: 'diagonal_put', name: 'Put diagonal', outlook: 'bearish', risk: 'defined', needs: 'next expiry', summary: 'Buy a next-expiry put, sell a lower near-expiry put. Needs next-expiry data.',
    legs: (p) => [leg('L1', 'BUY', 'PE', atm(0), 1, p.series, 2), leg('L2', 'SELL', 'PE', rel('L1', -p.width), 1, p.series, 1)] },
];

export const TEMPLATE_DEFAULTS: Required<TemplateParams> = { lots: 1, width: 2, offset: 2, series: 'WEEK' };

/** Single-leg and straddle templates default to ATM (offset 0); strangles, condors and credit spreads default OTM. */
const ATM_DEFAULT = new Set<TemplateId>(['long_call', 'long_put', 'short_call', 'short_put', 'bull_call_spread', 'bear_put_spread', 'bull_put_spread', 'bear_call_spread', 'calendar_call', 'calendar_put']);

export function templateById(id: TemplateId): TemplateInfo {
  const t = TEMPLATES.find((x) => x.id === id);
  if (!t) throw new Error(`Unknown template ${id}`);
  return t;
}

/** A complete, runnable spec: intraday, entry 09:20, exit 15:15, no stops, net basis. Override any part afterwards. */
export function specFromTemplate(id: TemplateId, params: TemplateParams = {}, over: Partial<StrategySpec> = {}): StrategySpec {
  const t = templateById(id);
  const p: Required<TemplateParams> = { ...TEMPLATE_DEFAULTS, offset: ATM_DEFAULT.has(id) ? 0 : TEMPLATE_DEFAULTS.offset, ...params };
  const spec: StrategySpec = {
    v: 1, name: t.name, template: id, underlying: 'NIFTY', lots: p.lots, legs: t.legs(p),
    entry: { time: '09:20', weekdays: [0, 1, 2, 3, 4], conditions: [] },
    exit: { hold: 'intraday', time: '15:15', settle_at_expiry: true, basis: 'net' },
    adjust: { on_leg_stop: 'keep_others', max_reentries: 0, cutoff: '14:30' },
    execution: { slip_pct: 0.5, slip_ticks: 1, stop_slip_mult: 2, stop_fill: 'gap_aware', brokerage_per_order: 20, exercise_stt_pct: 0.125 },
  };
  return { ...spec, ...over, legs: over.legs ?? spec.legs, entry: { ...spec.entry, ...(over.entry ?? {}) }, exit: { ...spec.exit, ...(over.exit ?? {}) },
    adjust: { ...spec.adjust, ...(over.adjust ?? {}) }, execution: { ...spec.execution, ...(over.execution ?? {}) } };
}

/**
 * Strategy 01's rules (docs/strategies/S1_short_straddle.md) without its re-entry, as a leg spec: opening range
 * 09:15–09:45 on 5-minute candles, entry at 09:50 if the 09:45 candle stays fully inside, 36% stop per leg,
 * ₹1,000 per lot net target, exit 15:15. The engine tests check it against the straddle engine fill for fill.
 */
export function straddle01Spec(opts: { sl_pct?: number; target_per_lot?: number; lots?: number; slip_pct?: number } = {}): StrategySpec {
  const sl = opts.sl_pct ?? 36;
  const s = specFromTemplate('short_straddle', { lots: opts.lots ?? 1 }, {
    entry: { time: '09:50', weekdays: [0, 1, 2, 3, 4], conditions: [{ kind: 'or_inside', or_minutes: 30, candle_minutes: 5, mode: 'full' }] },
    exit: { hold: 'intraday', time: '15:15', settle_at_expiry: true, basis: 'net', target: { kind: 'rupees_per_lot', value: opts.target_per_lot ?? 1000 } },
    execution: { slip_pct: opts.slip_pct ?? 0.5, slip_ticks: 1, stop_slip_mult: 2, stop_fill: 'gap_aware', brokerage_per_order: 20, exercise_stt_pct: 0.125 },
  });
  s.name = 'Strategy 01 without re-entry';
  s.legs = s.legs.map((l) => ({ ...l, stop: { kind: 'pct', value: sl } }));
  return s;
}
