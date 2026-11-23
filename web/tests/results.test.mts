// The Legs tab's figures (lib/legPerformance.ts): leg groups add up to the ledger, positions add up to the engine, and
// the payoff curve is the engine's own payoff at expiry.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { freshCompute } from './helpers/golden.mts';
import { legGroups, payoffCurve, positionSummary } from '../lib/legPerformance.ts';
import { specFromTemplate } from '../lib/legs/templates.ts';
const require = createRequire(import.meta.url);
const E = require('../public/engine/engine.js');
const G = require('../public/engine/legs.js');

const near = (a: number, b: number, eps = 0.01) => assert.ok(Math.abs(a - b) <= eps, `${a} vs ${b}`);
function run(p: Record<string, unknown>, days = 60, seed = 3) {
  const c = freshCompute(), sessions = E.syntheticCalendar(days, { iv: 15 }, seed);
  const r = c.run(p, sessions);
  return { r, rows: c.inspect('tradebook', 0, 1e6).rows };
}

test('published rules: legs grouped by side, with re-entries apart; the groups add up to the ledger', () => {
  const { r, rows } = run({ strategy: 'straddle', sl_pct: 25 });
  const g = legGroups(rows, r);
  assert.deepEqual(g.map((x) => x.label).sort(), [...new Set(g.map((x) => x.label))].sort(), 'one row per kind of leg');
  assert.ok(g.some((x) => x.label === 'Sell CE') && g.some((x) => x.label === 'Sell PE'));
  assert.equal(g.reduce((s, x) => s + x.legs, 0), rows.length);
  near(g.reduce((s, x) => s + x.net, 0), rows.reduce((s: number, t: any) => s + t.net_pnl, 0));
  near(g.reduce((s, x) => s + x.charges, 0), rows.reduce((s: number, t: any) => s + t.charges, 0));
  for (const x of g) {
    assert.equal(x.exits.reduce((s, e) => s + e.n, 0), x.legs, `${x.label}: every leg has one closing reason`);
    assert.ok(x.stops <= x.legs && x.wins <= x.legs);
    near(x.avg!, x.net / x.legs);
  }
  if (g.some((x) => /re-entry/.test(x.label))) assert.ok(g.filter((x) => /re-entry/.test(x.label)).every((x) => x.reentries === x.legs));
});

test('leg engine: one row per leg of the structure, in the order the spec lists them, with how each strike is chosen', () => {
  const spec = specFromTemplate('iron_condor');
  const { r, rows } = run({ strategy: 'legs', spec });
  const g = legGroups(rows, r);
  assert.deepEqual(g.map((x) => x.key), r.spec!.legs.map((l: any) => l.id));
  assert.deepEqual(g.map((x) => x.label), r.spec!.legs.map((l: any) => `${l.id} · ${l.action === 'SELL' ? 'Sell' : 'Buy'} ${l.right}`));
  assert.ok(g.every((x) => /OTM|ATM|ITM/.test(x.detail ?? '')), g.map((x) => x.detail).join(','));
  near(g.reduce((s, x) => s + x.net, 0), r.account!.report.pnl.net_profit as number);
  // positions: wins and losses cover them all, and their nets add up
  const ps = positionSummary(r.positions!);
  assert.equal(ps.n, r.positions!.length); assert.equal(ps.wins + ps.losses, ps.n);
  assert.equal(ps.byExit.reduce((s, e) => s + e.n, 0), ps.n);
  near(ps.byExit.reduce((s, e) => s + e.net, 0), r.positions!.reduce((s, p) => s + p.net, 0));
  near(ps.expectancy! * ps.n, r.positions!.reduce((s, p) => s + p.net, 0));
  assert.equal(ps.intraday + ps.carried, ps.n);
});

test('payoff at expiry: the curve is the engine payoff; its extremes and breakevens match the engine’s own figures', () => {
  const { r } = run({ strategy: 'legs', spec: specFromTemplate('iron_condor') }, 20, 5);
  const p = r.positions!.find((x) => x.payoff)!;
  const c = payoffCurve(p, G.payoffAt)!;
  assert.ok(c);
  assert.equal(c.spot, p.spot, 'the index at entry is drawn');
  const legs = p.legs.filter((l) => l.kind === 'initial').map((l) => ({ action: l.action, right: l.right, strike: l.strike, qty: l.qty, entry_px: l.entry_px }));
  for (const k of c.strikes) near(c.pts.find((q) => q.x === k)!.v, G.payoffAt(legs, k), 1e-9);
  // an iron condor is bounded both ways: the curve reaches the engine's max profit and max loss inside the drawn range
  near(Math.max(...c.pts.map((q) => q.v)), p.payoff!.max_profit!);
  near(Math.min(...c.pts.map((q) => q.v)), p.payoff!.max_loss!);
  for (const b of c.breakevens) near(G.payoffAt(legs, b), 0, 1);
  assert.ok(c.pts.every((q, i) => i === 0 || q.x > c.pts[i - 1].x), 'index levels in order');
  // legs of two expiries have no single expiry to draw
  const two = { ...p, legs: p.legs.map((l, i) => (i === 0 ? { ...l, expiry: '2099-12-31' } : l)) };
  assert.equal(payoffCurve(two, G.payoffAt), null);
});
