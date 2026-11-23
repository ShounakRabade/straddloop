/**
 * The plain-English reading of a run. Every figure in it is a figure the engine or the ledger produced (or a
 * ratio of two figures shown elsewhere on the page); nothing is estimated here, and no market conditions are
 * inferred: regime analysis is not in the Lab yet, so the text says so instead of guessing.
 */
import { exitLabel, inr, shortDate } from './format.ts';
import type { LedgerRow, RunResult } from './types';

export interface NarrativeBlock { id: 'happened' | 'worked' | 'hurt' | 'capital' | 'reliable' | 'next'; title: string; lines: string[] }

const p1 = (v: number | null | undefined) => (v == null || !isFinite(v) ? null : `${v.toFixed(1)}%`);
const unitOf = (r: RunResult, n: number) => (r.unit === 'day' ? (n === 1 ? 'traded day' : 'traded days') : r.unit === 'trade' ? (n === 1 ? 'trade' : 'trades')
  : r.unit === 'position' ? (n === 1 ? 'position' : 'positions') : n === 1 ? 'month' : 'months');

/** Net P&L and count of closed positions by exit reason, from the tradebook (or the engine's exit counts). */
export function byExit(trades: LedgerRow[] | null): { reason: string; n: number; net: number }[] {
  if (!trades) return [];
  const m = new Map<string, { n: number; net: number }>();
  for (const t of trades) {
    const k = String(t.exit_reason || 'unknown'), v = m.get(k) ?? { n: 0, net: 0 };
    v.n++; v.net += typeof t.net_pnl === 'number' ? t.net_pnl : 0; m.set(k, v);
  }
  return [...m.entries()].map(([reason, v]) => ({ reason, ...v })).sort((a, b) => b.net - a.net);
}

export function narrate(r: RunResult, ctx: { trades?: LedgerRow[] | null; slipPct?: number; real: boolean }): NarrativeBlock[] {
  const rep = r.account?.report;
  const out: NarrativeBlock[] = [];
  const period = rep?.range.from && rep.range.to ? `${shortDate(rep.range.from)} to ${shortDate(rep.range.to)}` : r.data ? `${shortDate(r.data.from)} to ${shortDate(r.data.to)}` : null;
  const sessionsWord = r.unit === 'month' ? 'stock-months' : 'sessions';
  const sample = ctx.real ? 'real NIFTY data' : 'the synthetic model';

  // What happened?
  const happened: string[] = [];
  const sign = r.net > 0 ? 'a profit' : r.net < 0 ? 'a loss' : 'no change';
  happened.push(`On ${sample}${period ? `, ${period}` : ''}, the rules ran over ${r.sessions} ${sessionsWord}, ${r.unit === 'position' ? 'opened' : 'traded on'} ${r.traded} ${unitOf(r, r.traded)} and ended with ${sign} of ${inr(Math.abs(r.net))} after ${inr(r.costs)} of charges.`);
  if (rep && rep.returns.pct_initial != null) happened.push(`That is ${rep.returns.pct_initial >= 0 ? '+' : '−'}${Math.abs(rep.returns.pct_initial).toFixed(2)}% of the ${inr(Number(rep.capital.initial_capital))} starting capital.`);
  if (!r.traded) happened.push('The entry rule never passed, so there is nothing to analyse. Loosen the entry condition or lengthen the period.');
  out.push({ id: 'happened', title: 'What happened?', lines: happened });
  if (!r.traded) return out;

  const groups = byExit(ctx.trades ?? null);
  // What worked?
  const worked: string[] = [];
  const good = groups.filter((g) => g.net > 0);
  for (const g of good.slice(0, 2)) worked.push(`Positions closed by ${exitLabel(g.reason).toLowerCase()} made ${inr(g.net, { sign: true })} across ${g.n}.`);
  if (r.best > 0) worked.push(`The best single ${r.unit} made ${inr(r.best, { sign: true })}.`);
  if (r.winRate > 0) worked.push(`${r.winRate.toFixed(1)}% of ${unitOf(r, r.traded)} were profitable after costs.`);
  if (!worked.length) worked.push('Nothing made money in aggregate: no exit type and no single ' + r.unit + ' finished positive.');
  worked.push('Which market conditions helped is not measured yet: regime analysis is not in the Lab, so this summary does not guess.');
  out.push({ id: 'worked', title: 'What worked?', lines: worked });

  // What hurt?
  const hurt: string[] = [];
  const bad = groups.filter((g) => g.net < 0).reverse();
  for (const g of bad.slice(0, 2)) hurt.push(`Positions closed by ${exitLabel(g.reason).toLowerCase()} lost ${inr(Math.abs(g.net))} across ${g.n}.`);
  if (r.gross > 0 && r.costs > 0) hurt.push(`Charges of ${inr(r.costs)} took ${((100 * r.costs) / r.gross).toFixed(0)}% of the ${inr(r.gross)} gross profit.`);
  else if (r.costs > 0) hurt.push(`Charges of ${inr(r.costs)} came on top of a gross result of ${inr(r.gross, { sign: true })}.`);
  if (ctx.slipPct != null) hurt.push(`Slippage of ${ctx.slipPct}% per fill (double on stops) is already inside every fill price; it is not broken out as a separate rupee figure.`);
  if (r.worst < 0) hurt.push(`The worst single ${r.unit} lost ${inr(Math.abs(r.worst))}.`);
  if (rep && Number(rep.risk.max_drawdown) > 0) {
    const from = rep.risk.drawdown_from, to = rep.risk.drawdown_to;
    hurt.push(`The deepest drawdown was ${inr(Number(rep.risk.max_drawdown))}${p1(Number(rep.risk.max_drawdown_pct)) ? ` (${p1(Number(rep.risk.max_drawdown_pct))} of the peak balance)` : ''}${from && to ? `, from ${shortDate(String(from))} to ${shortDate(String(to))}` : ''}.`);
  } else if (!rep && r.maxDD < 0) hurt.push(`The deepest drawdown was ${inr(Math.abs(r.maxDD))}.`);
  if (rep && Number(rep.margin.rejected_trades) > 0) hurt.push(`${rep.margin.rejected_trades} order${Number(rep.margin.rejected_trades) === 1 ? ' was' : 's were'} rejected for margin (${rep.margin.policy_text}).`);
  if (!hurt.length) hurt.push('No losing exit type and no drawdown in this run.');
  out.push({ id: 'hurt', title: 'What hurt performance?', lines: hurt });

  // Capital
  const cap: string[] = [];
  if (rep) {
    const c = rep.capital, m = rep.margin;
    if (rep.returns.pct_peak_margin != null) cap.push(`Return on peak margin was ${rep.returns.pct_peak_margin.toFixed(2)}% (margin is estimated by the model in Capital & risk).`);
    if (m.peak_margin != null) cap.push(`At most ${inr(Number(m.peak_margin))} of margin was blocked at once${c.capital_utilisation_peak_pct != null ? `; peak utilisation was ${Number(c.capital_utilisation_peak_pct).toFixed(1)}% of capital` : ''}.`);
    if (c.capital_utilisation_avg_pct != null) {
      const avg = Number(c.capital_utilisation_avg_pct);
      cap.push(`On sessions with a position, ${avg.toFixed(1)}% of capital was in use on average, so about ${(100 - avg).toFixed(1)}% sat idle.`);
    }
    if (c.total_premium_paid != null && Number(c.total_premium_paid) > 0) cap.push(`${inr(Number(c.total_premium_paid))} was paid in premium for long options over the run.`);
  } else cap.push('This strategy runs on its own synthetic margin model, without the account ledger, so capital use is not broken down.');
  out.push({ id: 'capital', title: 'How efficiently was capital used?', lines: cap });

  // Reliability
  const rel: string[] = [];
  const [lo, hi] = r.ci ?? [r.avg, r.avg];
  if (r.traded < 2 || !r.ci) rel.push(`One ${r.unit} is not evidence: there is no spread to measure.`);
  else if (lo > 0 || hi < 0) rel.push(`The 95% range for the average ${r.unit} is ${inr(lo, { sign: true })} to ${inr(hi, { sign: true })}; it does not include zero${r.traded < 30 ? `, but ${r.traded} ${unitOf(r, r.traded)} is a small sample` : ''}.`);
  else rel.push(`The 95% range for the average ${r.unit} is ${inr(lo, { sign: true })} to ${inr(hi, { sign: true })}. It includes zero, so this sample cannot tell the rule from luck.`);
  if (r.traded < 30) rel.push(`Fewer than 30 ${unitOf(r, 2)}: treat every ratio here, Sharpe included, as unreliable.`);
  if (rep && rep.range.excluded_days.length) rel.push(`${rep.range.excluded_days.length} session${rep.range.excluded_days.length === 1 ? ' was' : 's were'} excluded for data problems.`);
  if (ctx.real) rel.push('Fills come from 1-minute candles with no bid/ask, so real trading would likely do worse.');
  else rel.push('These are synthetic sessions: they show how the rule reacts to a setting, not how it did in a real market.');
  rel.push('No out-of-sample or walk-forward test has been run on this configuration.');
  out.push({ id: 'reliable', title: 'How reliable is the result?', lines: rel });

  // Next
  const next: string[] = [];
  if (r.traded < 30) next.push(ctx.real ? 'Load and run a longer period: at least 30 traded days before reading the ratios.' : 'Raise the number of sessions and try two or three other market seeds.');
  if (lo <= 0 && hi >= 0 && r.traded >= 2) next.push('Run the same rules on a different period: a range that includes zero can flip sign.');
  const stops = groups.find((g) => /stop/i.test(g.reason));
  if (stops && stops.net < 0) next.push('Sweep the stop distance and look for a plateau of similar results, not a single best value.');
  if (r.gross > 0 && r.costs / r.gross > 0.3) next.push('Charges take a large share of gross profit: test fewer re-entries, or a wider target.');
  next.push('Re-run at 1% and 2% slippage: if the result dies at 1%, the rule is not tradeable.');
  out.push({ id: 'next', title: 'What to investigate next', lines: next.slice(0, 4) });
  return out;
}
