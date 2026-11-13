import type { Params, StrategySlug } from './types';

export type Field =
  | { key: string; label: string; help: string; kind: 'range'; min: number; max: number; step: number; unit?: string; prefix?: string }
  | { key: string; label: string; help: string; kind: 'choice'; options: { value: string | number | boolean; label: string }[] };

export interface Strategy {
  slug: StrategySlug;
  number: string;
  name: string;
  short: string;
  oneLine: string;
  market: string;
  cadence: string;
  stance: string;
  payoff: 'short-straddle' | 'long-option' | 'ratio';
  steps: { title: string; body: string; points?: string[] }[];
  params: [string, string][];
  weaknesses: { title: string; body: string }[];
  synthetic: string;
  experiments: string[];
  defaults: Params;
  fields: Field[];
}

const sample: Field[] = [
  { key: 'days', label: 'Sessions', help: 'How many synthetic trading days to run.', kind: 'choice',
    options: [{ value: 60, label: '60' }, { value: 120, label: '120' }, { value: 240, label: '240' }] },
  { key: 'seed', label: 'Market seed', help: 'A different seed is a different imaginary market. If the result flips with the seed, it was luck.', kind: 'range', min: 1, max: 20, step: 1 },
  { key: 'iv', label: 'Model implied vol', help: 'Realised vol in the model is 12%. Above that, option sellers are overpaid; below, underpaid.', kind: 'range', min: 9, max: 22, step: 1, unit: '%' },
];

export const STRATEGIES: Strategy[] = [
  {
    slug: 'straddle',
    number: '01',
    name: 'Intraday ATM short straddle',
    short: 'Short straddle',
    oneLine: 'Sell the at-the-money call and put at 09:50 if the first half hour was quiet. Stop each leg at 36%.',
    market: 'NIFTY · BANK NIFTY',
    cadence: 'Intraday, 5-minute candles',
    stance: 'Short premium',
    payoff: 'short-straddle',
    steps: [
      { title: 'Mark the opening range', body: 'Take the 5-minute candles from 09:15 to 09:45. The opening-range high is the highest high of the index; the low is the lowest low.' },
      { title: 'Check the entry candle', body: 'Look at the 09:45–09:50 candle once it has closed.', points: ['Enter only if it stays inside the range: high ≤ OR high and low ≥ OR low.', 'Otherwise there is no trade today.'] },
      { title: 'Sell the straddle at 09:50', body: 'Sell one ATM call and one ATM put (the strike nearest spot) on the nearest expiry, one lot each.' },
      { title: 'Set a stop on each leg', body: 'Stop = sell price × 1.36, separately for the call and the put.' },
      { title: 'Re-enter once if a leg is stopped', body: 'If the call is stopped while the put is open, sell a new call whose premium is at or below the put’s current premium. Mirror for puts. The new leg gets its own 36% stop.', points: ['At most one re-entry per side.', 'No new positions after 14:30.'] },
      { title: 'Exit', body: 'Close everything when total net P&L after costs reaches ₹1,000 per lot. Otherwise close everything at 15:15.' },
    ],
    params: [
      ['Opening range', '30 min, 5-min candles'], ['Entry condition', 'Full candle inside range'], ['Strike / expiry', 'ATM, nearest expiry'],
      ['Stop per leg', '36% above entry'], ['Re-entries per side', '1'], ['Re-entry cutoff', '14:30'],
      ['Profit target', '₹1,000 per lot, net'], ['Daily loss limit', 'Off'], ['Exit time', '15:15'],
    ],
    weaknesses: [
      { title: 'The payoff is lopsided', body: 'A ₹1,000 target caps the good days. The loss side is bounded only by how well the stops fill.' },
      { title: 'A 36% stop is a trigger, not a limit', body: 'Gaps, a premium dislocation or missing bars fill beyond it. The gap-aware fill model shows this directly.' },
      { title: 'Re-entry adds exposure after the market disagreed', body: 'The replacement leg is sold in the direction of the move, so a continuation or a reversal can stop it too.' },
      { title: 'Win rate flatters it', body: 'Many small target hits and an occasional multi-stop day is the expected shape. Read expectancy and drawdown first.' },
      { title: 'The filter selects quiet first hours, not quiet days', body: 'An inside 09:45 candle says nothing about an afternoon trend or a volatility event.' },
      { title: 'Costs are a quarter of the target', body: 'At default rates a day costs roughly ₹110–240 per lot across four to six fills, before slippage.' },
    ],
    synthetic: 'On 120 synthetic sessions it traded 63 days, won 71% of them and still lost ₹32,791 after costs: the average losing day was about four times the average winner. Re-entry legs lost money at every implied-vol level tested.',
    experiments: ['Original rules on 2+ years of real data, with costs for the period', 'Re-entry on against re-entry off', 'Stop sweep from 20% to 75%: look for a plateau, not a peak', 'Target against no target, plus a daily loss cap', 'Slippage from 0 to 2%: if the result dies at 1%, it is not tradeable'],
    defaults: { strategy: 'straddle', days: 120, seed: 1, iv: 13, sl_pct: 36, target_per_lot: 1000, reentry_enabled: true, entry_condition: 'full' },
    fields: [
      { key: 'sl_pct', label: 'Stop per leg', help: 'How far above its sell price a leg may rise before it is bought back.', kind: 'range', min: 20, max: 75, step: 1, unit: '%' },
      { key: 'target_per_lot', label: 'Profit target per lot', help: 'Net of costs. Everything closes when this is reached.', kind: 'range', min: 500, max: 3000, step: 100, prefix: '₹' },
      { key: 'reentry_enabled', label: 'Re-entry after a stop', help: 'Sell a replacement leg when one side is stopped.', kind: 'choice', options: [{ value: true, label: 'On' }, { value: false, label: 'Off' }] },
      { key: 'entry_condition', label: 'Entry candle must', help: 'How strictly the 09:45 candle has to sit inside the opening range.', kind: 'choice',
        options: [{ value: 'full', label: 'Stay fully inside' }, { value: 'body', label: 'Body inside' }, { value: 'close', label: 'Close inside' }, { value: 'overlap', label: 'Touch the range' }] },
      ...sample,
    ],
  },
  {
    slug: 'orb',
    number: '02',
    name: 'Opening range breakout with long options',
    short: 'Opening range breakout',
    oneLine: 'Buy the ATM call or put when the index breaks the first half hour’s range and the next candle confirms.',
    market: 'NIFTY · BANK NIFTY',
    cadence: 'Intraday, 5-minute candles',
    stance: 'Long premium',
    payoff: 'long-option',
    steps: [
      { title: 'Mark the opening range', body: 'Take the 5-minute candles from 09:15 to 09:45. Call the high ORH and the low ORL.' },
      { title: 'Wait for a breakout candle', body: 'A candle that breaks both sides is ignored.', points: ['Bullish: a candle’s high goes above ORH.', 'Bearish: a candle’s low goes below ORL.'] },
      { title: 'Confirm on the next candle', body: 'If the next candle does not confirm, the breakout has failed. Wait for a new one.', points: ['Bullish: it must trade above the breakout candle’s high.', 'Bearish: it must trade below the breakout candle’s low.'] },
      { title: 'Buy the option', body: 'When the confirming candle closes, buy at the next bar’s open: the ATM call if bullish, the ATM put if bearish. Nearest expiry, one lot, no new entry after 14:30.' },
      { title: 'Take profit', body: 'Sell when the premium reaches entry + 30 points.' },
      { title: 'Structural exit', body: 'After entry, each opposite-colour candle sets an exit level: a red candle’s low for a call, a green candle’s high for a put. The level moves to each newer reversal candle. When the index trades through it, sell at the next bar’s open.' },
      { title: 'Exit at day end', body: 'Sell anything still open at 15:15. One trade per day, no automatic reversal.' },
    ],
    params: [
      ['Opening range', '30 min, 5-min candles'], ['Breakout', 'Wick beyond ORH / ORL'], ['Confirmation window', 'Next 1 candle'],
      ['Strike', 'ATM (or ±N strikes, or by delta)'], ['Target', '+30 premium points'], ['Reversal candle', 'Opposite colour'],
      ['Stop buffer', '0 index points'], ['Max trades per day', '1'], ['Latest entry / exit', '14:30 / 15:15'],
    ],
    weaknesses: [
      { title: 'Index points are not premium points', body: 'A 30-point index move lifts an ATM option about 15 points. The default target needs roughly a 60-point move.' },
      { title: 'The exit is far tighter than the target', body: 'An opposite-colour candle is very common on 5-minute bars. Most trades end on noise long before the target.' },
      { title: 'The structural exit is not a loss limit', body: 'Until the first reversal candle closes there is no exit at all, and a jump fills at the next open wherever that is.' },
      { title: 'Confirmation enters late', body: 'By the time the confirming candle has closed, the entry is one or two candles past the breakout, at a worse premium.' },
      { title: 'Long options pay for time', body: 'Theta and falling implied vol after the open work against every trade.' },
      { title: 'Breakouts are frequent', body: 'About two breakout candles a day on the synthetic calendar, so “no breakout” days are rare without a filter.' },
    ],
    synthetic: 'On 120 synthetic sessions it traded every day, won 35% of trades and lost ₹14,372. 86% of trades left on the reversal level after about 14 minutes. Of 29 variants tried, none was distinguishable from zero except taking a second trade, which was reliably worse.',
    experiments: ['Wick breakout against close and strong-body breakouts', 'Reversal definition and buffer of 0, 5 and 10 points', 'Premium target against index target against no target', 'ATM against one strike in the money', 'Regimes by gap and opening-range width, then walk-forward'],
    defaults: { strategy: 'orb', days: 120, seed: 1, iv: 13, target_points: 30, stop_buffer: 0, breakout_def: 'wick', target_basis: 'premium' },
    fields: [
      { key: 'target_points', label: 'Target', help: 'Premium points above the entry price.', kind: 'range', min: 10, max: 80, step: 5, unit: ' pts' },
      { key: 'stop_buffer', label: 'Stop buffer', help: 'Index points of room beyond the reversal candle before exiting.', kind: 'range', min: 0, max: 30, step: 1, unit: ' pts' },
      { key: 'breakout_def', label: 'A breakout is', help: 'What the breakout candle has to do to count.', kind: 'choice',
        options: [{ value: 'wick', label: 'A wick beyond the range' }, { value: 'close', label: 'A close beyond the range' }, { value: 'body_strength', label: 'A strong-body close' }] },
      { key: 'target_basis', label: 'Profit target', help: 'Turn the target off to exit only on the reversal level or at day end.', kind: 'choice',
        options: [{ value: 'premium', label: 'On' }, { value: 'none', label: 'Off' }] },
      ...sample,
    ],
  },
  {
    slug: 'fourleg',
    number: '03',
    name: 'Monthly four-leg stock-options structure',
    short: 'Four-leg ratio',
    oneLine: 'Sell a call and a put 5% out, buy more lots ₹50 beyond each. Target 10% of margin.',
    market: 'RELIANCE · HDFCBANK · ICICIBANK · SBIN',
    cadence: 'Monthly, daily closes',
    stance: 'Ratio: 3 short, 5 long',
    payoff: 'ratio',
    steps: [
      { title: 'Pick the entry day', body: 'The first trading day after the previous monthly expiry. Trade the next monthly contract. Skip the month if fewer than 15 days are left to expiry.' },
      { title: 'Find the short strikes', body: 'Entry price is the stock’s close on the entry day. Round each to the nearest listed strike.', points: ['Short call: entry × 1.05.', 'Short put: entry × 0.95.'] },
      { title: 'Find the protective strikes', body: 'Exactly ₹50 of strike beyond each actual short strike. If that strike is not listed, skip the stock for the month.', points: ['Long call = short call + ₹50.', 'Long put = short put − ₹50.'] },
      { title: 'Check liquidity', body: 'Every leg must have traded on the entry day.' },
      { title: 'Place the four legs', body: 'Sell 3 lots of the call and 3 of the put. Buy 5 lots of each protective option. At ₹1,000: sell 1,050 CE, buy 1,100 CE, sell 950 PE, buy 900 PE.' },
      { title: 'Record the margin and fix the target', body: 'Target net P&L = 10% of the initial margin for the full position. Fix it at entry. Net counts brokerage, taxes and slippage.' },
      { title: 'Check daily at the close', body: 'If net P&L at executable prices has reached the target, close all four legs.' },
      { title: 'Otherwise, exit by policy', body: 'Both policies cap the loss at 25% of initial margin.', points: ['Policy A: exit on the last trading day with at least 7 days to expiry.', 'Policy B: hold until the day before expiry.'] },
    ],
    params: [
      ['Entry day', '1st trading day after expiry'], ['Minimum days to expiry', '15'], ['Short call / put', '+5% / −5% of entry'],
      ['Wing distance', '₹50 strike to strike'], ['Missing wing', 'Skip the month'], ['Lots (SC / LC / SP / LP)', '3 / 5 / 3 / 5'],
      ['Target', '10% of initial margin, net'], ['Policy A exit', '≥ 7 days before expiry'], ['Policy B exit', '1 day before expiry'], ['Max loss', '25% of initial margin'],
    ],
    weaknesses: [
      { title: 'It is not an iron condor', body: 'With 5 long lots against 3 short, the worst expiry outcome is at the long strikes. Beyond them the extra two lots gain, so big moves help and moderate moves hurt most.' },
      { title: 'The opening cash flow depends on skew', body: 'Three short premiums against five wing premiums. With flat skew it can open as a debit, and then time works against the position.' },
      { title: 'The 10% target is large for the structure', body: 'Margin is dominated by exposure on the short notional, so the target can exceed the whole opening credit. Then only a big move reaches it.' },
      { title: 'Holding longer has a price', body: 'Policy B earns the remaining decay only if the stock stays between the short strikes, and it carries rising delivery margin in expiry week.' },
    ],
    synthetic: 'Across 96 synthetic stock-months, Policy A reached the target in 13.5% of months and lost ₹2,42,953. Policy B reached it in 33.3% and lost ₹1,14,550. The difference between them, ₹1,338 a month, has a 95% interval of −₹1,695 to +₹4,370: not distinguishable from zero.',
    experiments: ['3+ years of daily bhavcopy for the four stocks, checking lot sizes and corporate actions', 'Broker margin figures in place of the model margin', 'Ratio, target, distance and slippage sweeps on the first 60% of months only', 'A against B on identical entries: read the interval, not the mean', 'How many months are skipped for an unlisted ₹50 wing'],
    defaults: { strategy: 'fourleg', months: 24, policy: 'A', long_lots: 5, short_pct: 5, target_pct_margin: 10 },
    fields: [
      { key: 'policy', label: 'Exit policy', help: 'A leaves a week before expiry. B holds to the day before.', kind: 'choice', options: [{ value: 'A', label: 'A: exit a week early' }, { value: 'B', label: 'B: hold to the last day' }] },
      { key: 'long_lots', label: 'Protective lots per side', help: 'Against 3 short lots. 3 makes it an iron condor; 5 is the baseline ratio.', kind: 'range', min: 3, max: 6, step: 1 },
      { key: 'short_pct', label: 'Short strike distance', help: 'How far out of the money the short call and put are sold.', kind: 'range', min: 3, max: 8, step: 0.5, unit: '%' },
      { key: 'target_pct_margin', label: 'Target, share of margin', help: 'Net profit, as a share of initial margin, that closes the position.', kind: 'range', min: 2, max: 15, step: 1, unit: '%' },
      { key: 'months', label: 'History', help: 'Months of synthetic daily data for the four stocks.', kind: 'choice', options: [{ value: 12, label: '12 months' }, { value: 24, label: '24 months' }, { value: 36, label: '36 months' }] },
    ],
  },
];

export const bySlug = (slug: string) => STRATEGIES.find((s) => s.slug === slug);

export function describeParams(s: Strategy, params: Params): string[] {
  return s.fields
    .filter((f) => params[f.key] !== undefined && params[f.key] !== s.defaults[f.key])
    .map((f) => {
      const v = params[f.key];
      if (f.kind === 'choice') return `${f.label}: ${f.options.find((o) => o.value === v)?.label ?? v}`;
      return `${f.label}: ${f.prefix ?? ''}${v}${f.unit ?? ''}`;
    });
}
