/**
 * Leg-by-leg and position-by-position figures for the Legs tab, from what the run produced: the ledger's tradebook
 * (every booked leg, after its own charges) and, for the leg engine, the positions it opened. Nothing is estimated;
 * the payoff curve is the structure's value at expiry from its entry prices (before charges).
 */
import { exitLabel } from './format.ts';
import { strikeText } from './strategyRegistry.ts';
import type { LedgerRow, RunResult } from './types';
import type { PositionRecord } from './legs/types';

export interface LegGroup {
  key: string;
  /** what the leg is: "L2 · Sell CE" (leg engine) or "Sell PE · re-entry" (published rules) */
  label: string;
  /** how its strike is chosen (leg engine), or null */
  detail: string | null;
  legs: number; reentries: number; wins: number;
  net: number; gross: number; charges: number;
  avg: number | null; best: number | null; worst: number | null;
  stops: number; targets: number;
  exits: { reason: string; label: string; n: number }[];
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0);
export const isStop = (reason: string) => /stop|^sl$|max_loss|loss_limit/.test(reason);
export const isTarget = (reason: string) => /target/.test(reason);

/** Booked legs grouped by what they are. Leg engine: by the spec's leg (L1, L2, …), re-entries included and counted.
 *  Published rules: by side and direction, with re-entries apart (they are decided differently). Order: as the spec
 *  lists its legs, otherwise by first appearance. */
export function legGroups(rows: LedgerRow[], r: Pick<RunResult, 'strategy' | 'spec'>): LegGroup[] {
  const legsEngine = r.strategy === 'legs';
  const specLegs = legsEngine && r.spec ? r.spec.legs : [];
  const out = new Map<string, LegGroup & { reasons: Map<string, number> }>();
  for (const t of rows) {
    const id = String(t.leg ?? '');
    const reentry = /re-?entry/.test(String(t.kind ?? '')) || /\.r\d+$/.test(id);
    let key: string, label: string, detail: string | null = null;
    if (legsEngine) {
      key = id.split('.')[1] ?? id;
      const s = specLegs.find((l) => l.id === key);
      label = `${key} · ${s ? `${s.action === 'SELL' ? 'Sell' : 'Buy'} ${s.right}${s.ratio > 1 ? ` ×${s.ratio}` : ''}` : `${t.direction === 'SHORT' ? 'Sell' : 'Buy'} ${t.side}`}`;
      detail = s ? `${strikeText(s.strike)}${s.expiry.nth === 2 ? ', next expiry' : ''}` : null;
    } else {
      const act = t.direction === 'SHORT' ? 'Sell' : 'Buy';
      key = `${act}|${t.side}|${reentry ? 'r' : 'i'}`;
      label = `${act} ${t.side}${reentry ? ' · re-entry' : ''}`;
    }
    let g = out.get(key);
    if (!g) {
      g = { key, label, detail, legs: 0, reentries: 0, wins: 0, net: 0, gross: 0, charges: 0, avg: null, best: null, worst: null, stops: 0, targets: 0, exits: [], reasons: new Map() };
      out.set(key, g);
    }
    const net = num(t.net_pnl), reason = String(t.exit_reason ?? '');
    g.legs++; if (reentry) g.reentries++;
    if (net > 0) g.wins++;
    g.net += net; g.gross += num(t.gross_pnl); g.charges += num(t.charges);
    g.best = g.best == null ? net : Math.max(g.best, net);
    g.worst = g.worst == null ? net : Math.min(g.worst, net);
    if (isStop(reason)) g.stops++;
    if (isTarget(reason)) g.targets++;
    g.reasons.set(reason, (g.reasons.get(reason) ?? 0) + 1);
  }
  const order = (k: string) => { const i = specLegs.findIndex((l) => l.id === k); return i < 0 ? Infinity : i; };
  return [...out.values()]
    .sort((a, b) => order(a.key) - order(b.key))
    .map(({ reasons, ...g }) => ({ ...g, avg: g.legs ? g.net / g.legs : null,
      exits: [...reasons.entries()].sort((a, b) => b[1] - a[1]).map(([reason, n]) => ({ reason, label: reason ? exitLabel(reason) : 'not recorded', n })) }));
}

export interface PositionSummary {
  n: number; wins: number; losses: number;
  avgWin: number | null; avgLoss: number | null; best: number | null; worst: number | null;
  /** average net per position */
  expectancy: number | null;
  /** average win ÷ average loss (size), null without both */
  payoffRatio: number | null;
  intraday: number; carried: number;
  byExit: { reason: string; label: string; n: number; net: number; avg: number }[];
}
/** Positions of the leg engine: how they won and lost, and why they closed. */
export function positionSummary(ps: PositionRecord[]): PositionSummary {
  const nets = ps.map((p) => p.net);
  const w = nets.filter((x) => x > 0), l = nets.filter((x) => x <= 0);
  const sum = (a: number[]) => a.reduce((s, x) => s + x, 0);
  const avgWin = w.length ? sum(w) / w.length : null, avgLoss = l.length ? sum(l) / l.length : null;
  const by = new Map<string, { n: number; net: number }>();
  for (const p of ps) { const k = p.exit_reason || 'open'; const o = by.get(k) ?? { n: 0, net: 0 }; o.n++; o.net += p.net; by.set(k, o); }
  let best: number | null = null, worst: number | null = null;
  for (const x of nets) { best = best == null || x > best ? x : best; worst = worst == null || x < worst ? x : worst; }
  return {
    n: ps.length, wins: w.length, losses: l.length, avgWin, avgLoss, best, worst,
    expectancy: ps.length ? sum(nets) / ps.length : null,
    payoffRatio: avgWin != null && avgLoss != null && avgLoss < 0 ? avgWin / -avgLoss : null,
    intraday: ps.filter((p) => p.closed && p.closed.date === p.opened.date).length,
    carried: ps.filter((p) => !p.closed || p.closed.date !== p.opened.date).length,
    byExit: [...by.entries()].sort((a, b) => b[1].n - a[1].n).map(([reason, o]) => ({ reason, label: exitLabel(reason), n: o.n, net: o.net, avg: o.net / o.n })),
  };
}

type PayoffLeg = { action: 'BUY' | 'SELL'; right: 'CE' | 'PE'; strike: number; qty: number; entry_px: number };
export interface PayoffCurve {
  pts: { x: number; v: number }[];
  strikes: number[]; breakevens: number[];
  max_profit: number | null; max_loss: number | null;
  spot: number | null;
}
/**
 * A position's value at expiry across index levels, from its initial legs' entry prices (before charges), with its
 * strikes, breakevens and the spot at entry. null when its legs expire on different days (calendars, diagonals):
 * then there is no single expiry to draw.
 */
export function payoffCurve(p: PositionRecord & { spot?: number | null }, payoffAt: (legs: PayoffLeg[], S: number) => number, steps = 160): PayoffCurve | null {
  const legs = p.legs.filter((l) => l.kind === 'initial');
  if (!legs.length || new Set(legs.map((l) => l.expiry)).size > 1 || !p.payoff) return null;
  const pl: PayoffLeg[] = legs.map((l) => ({ action: l.action, right: l.right, strike: l.strike, qty: l.qty, entry_px: l.entry_px }));
  const strikes = [...new Set(pl.map((l) => l.strike))].sort((a, b) => a - b);
  const spot = typeof p.spot === 'number' && Number.isFinite(p.spot) ? p.spot : null;
  const lo0 = Math.min(strikes[0], spot ?? strikes[0]), hi0 = Math.max(strikes[strikes.length - 1], spot ?? strikes[0]);
  const pad = Math.max((hi0 - lo0) * 0.6, hi0 * 0.025);
  const lo = Math.floor(lo0 - pad), hi = Math.ceil(hi0 + pad);
  const xs = new Set<number>(strikes.concat(p.payoff.breakevens.filter((b) => b >= lo && b <= hi)));
  for (let i = 0; i <= steps; i++) xs.add(Math.round((lo + ((hi - lo) * i) / steps) * 100) / 100);
  const pts = [...xs].sort((a, b) => a - b).map((x) => ({ x, v: payoffAt(pl, x) }));
  return { pts, strikes, breakevens: p.payoff.breakevens, max_profit: p.payoff.max_profit, max_loss: p.payoff.max_loss, spot };
}
