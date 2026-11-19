// Leg engine tests. Every expected figure is worked out by hand in the comments, from hand-made sessions
// (tests/helpers/session.mjs), the fill rules in public/engine/legs.js and the 1 Oct 2024 charge rates
// (written out again, independently, in helpers/session.mjs `charges`).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { session, ladder, hm, charges } from './helpers/session.mjs';
import { TEMPLATES, specFromTemplate, straddle01Spec } from '../lib/legs/templates.ts';
const require = createRequire(import.meta.url);
const L = require('../public/engine/ledger.js');
const E = require('../public/engine/engine.js');
const F = require('../public/engine/fourleg_engine.js');
const G = require('../public/engine/legs.js');
const compute = require('../public/engine/compute.js')(E, F, L, G);

const D1 = '2025-11-03', D2 = '2025-11-04'; // a Monday, and the Tuesday weekly expiry after it
const NOSLIP = { slip_pct: 0, slip_ticks: 0, stop_slip_mult: 2, stop_fill: 'gap_aware', brokerage_per_order: 20, exercise_stt_pct: 0.125 };
const SLIP = { ...NOSLIP, slip_pct: 0.5, slip_ticks: 1 };
// A flat chain around 25,000: intrinsic + time value (100 at the money, 20 less per 100 points away, at least 5).
const flat = (r: string, k: number) => (r === 'CE' ? Math.max(0, 25000 - k) : Math.max(0, k - 25000)) + Math.max(5, 100 - Math.abs(k - 25000) / 5);
const step = (before: any, after: any, at = '12:00') => (t: number) => (t < hm(at) ? before : after);
const near = (a: number, b: number, tol = 0.005) => assert.ok(Math.abs(a - b) <= tol, `${a} !~ ${b}`);
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const atm = (steps = 0) => ({ by: 'atm', steps });
const leg = (id: string, action: string, right: string, strike: any, extra: any = {}) => ({ id, action, right, strike, ...extra });
const spec = (legs: any[], over: any = {}) => ({ v: 1, underlying: 'NIFTY', lots: 1, legs, entry: { time: '09:20' }, exit: { hold: 'intraday', time: '15:15' }, execution: NOSLIP, ...over });
const day = (date: string, over: any = {}, index: any = 25000, expiry = D2, source = 'dhan') => session(date, index, [{ expiry, contracts: ladder(flat, over) }], source);
const runLegs = (sessions: any[], sp: any) => G.run(sessions, sp, { L });
const lab = (sessions: any[], sp: any, acct: any = {}) => compute.run({ strategy: 'legs', spec: sp, ...acct }, sessions);
const fillsOf = (r: any) => r.fills.map((f: any) => [f.t, f.action, f.side, f.strike, f.qty, f.px, f.reason]);

/** Every figure the Lab shows for a run must come out of the ledger and add up. */
function reconciles(r: any, n: number) {
  const rep = r.account.report;
  assert.ok(rep.reconciliation.ok, JSON.stringify(rep.reconciliation.checks.filter((c: any) => !c.ok)));
  const tb = compute.inspect('tradebook', 0, 1e6).rows;
  near(r.net, sum(tb.map((t: any) => t.net_pnl)), 0.01);
  near(r.gross, sum(tb.map((t: any) => t.gross_pnl)), 0.01);
  near(r.costs, sum(tb.map((t: any) => t.charges)), 0.01);
  near(r.net, sum(r.days.map((d: any) => d.net)), 0.01);
  near(r.net, r.account.daily.at(-1).closing_balance - r.account.config.initial_capital, 0.01);
  if (r.curve.length) near(r.curve.at(-1).v, r.net, 0.01);
  assert.equal(r.days.length, n);
  assert.equal(r.sessions, n);
  assert.equal(r.traded, new Set(tb.map((t: any) => t.position_id)).size);
}

// ------------------------------------------------------------------ single legs

test('long call: buys at the open after the decision bar, sells at the exit-time open; P&L by hand', () => {
  const s = [day(D1, { 'CE:25000': step(100, 150) })];
  const sp = spec([leg('L1', 'BUY', 'CE', atm(0))]);
  const run = runLegs(s, sp);
  assert.equal(run.results[0].status, 'traded');
  assert.deepEqual(fillsOf(run.results[0]), [[hm('09:20'), 'BUY', 'CE', 25000, 75, 100, 'entry'], [hm('15:15'), 'SELL', 'CE', 25000, 75, 150, 'time']]);
  const p = run.positions[0];
  // gross (150 - 100) x 75 = 3,750. BUY 7,500 turnover: 20 + 2.62725 exch + 0.0075 SEBI + 0.225 stamp + 4.074255 GST = 26.934005.
  // SELL 11,250 turnover: 20 + 3.940875 + 0.01125 + 11.25 STT + 4.3113825 GST = 39.5135075.
  near(p.gross, 3750, 1e-9);
  near(charges('BUY', 100, 75), 26.934005, 1e-9); near(charges('SELL', 150, 75), 39.5135075, 1e-9);
  near(p.charges, 26.934005 + 39.5135075, 1e-6);
  near(p.net, 3750 - 26.934005 - 39.5135075, 1e-6);
  assert.equal(p.exit_reason, 'time');
  // payoff at expiry: loss capped at the premium 100 x 75; breakeven 25,000 + 100; gain unbounded
  assert.deepEqual(p.payoff, { max_profit: null, max_loss: -7500, breakevens: [25100] });
  const r = lab(s, sp);
  assert.equal(r.unit, 'position');
  near(r.net, p.net, 0.01);
  assert.deepEqual(r.days.map((d: any) => [d.status, d.opened, d.closed]), [['traded', 1, 1]]);
  reconciles(r, 1);
});

test('long put: slippage 0.5% + 1 tick against you, then 5% + 2 ticks (high slippage)', () => {
  const s = [day(D1, { 'PE:25000': step(80, 60) })];
  const base = spec([leg('L1', 'BUY', 'PE', atm(0))]);
  const a = runLegs(s, { ...base, execution: SLIP });
  // buy 80 x 1.005 + 0.05 = 80.45 (on the tick); sell 60 x 0.995 - 0.05 = 59.65
  assert.deepEqual(a.results[0].fills.map((f: any) => f.px), [80.45, 59.65]);
  near(a.positions[0].gross, -1560, 1e-6); // (59.65 - 80.45) x 75
  near(a.positions[0].net, -1560 - charges('BUY', 80.45, 75) - charges('SELL', 59.65, 75), 1e-6);
  const pay = a.positions[0].payoff;
  near(pay.max_loss, -80.45 * 75, 1e-6);          // the premium
  near(pay.max_profit, (25000 - 80.45) * 75, 1e-6); // index to zero
  assert.deepEqual(pay.breakevens, [24919.55]);
  const b = runLegs(s, { ...base, execution: { ...NOSLIP, slip_pct: 5, slip_ticks: 2 } });
  // buy 80 x 1.05 + 0.10 = 84.10; sell 60 x 0.95 - 0.10 = 56.90; gross (56.9 - 84.1) x 75 = -2,040
  assert.deepEqual(b.results[0].fills.map((f: any) => f.px), [84.1, 56.9]);
  near(b.positions[0].gross, -2040, 1e-6);
  assert.ok(b.positions[0].net < a.positions[0].net);
  // a sell can never fill below one tick, however large the slippage
  const c = runLegs([day(D1, { 'CE:25500': 0.1 })], spec([leg('L1', 'SELL', 'CE', atm(10))], { execution: { ...NOSLIP, slip_ticks: 4 } }));
  assert.equal(c.results[0].fills[0].px, 0.05);
});

// ------------------------------------------------------------------ multi-leg structures

test('short straddle: both legs sold at the open, bought back at exit; payoff and both margin models by hand', () => {
  const s = [day(D1, { 'CE:25000': step(100, 70), 'PE:25000': step(100, 90) })];
  const sp = specFromTemplate('short_straddle', {}, { execution: NOSLIP } as any);
  const run = runLegs(s, sp);
  assert.deepEqual(fillsOf(run.results[0]), [
    [hm('09:20'), 'SELL', 'CE', 25000, 75, 100, 'entry'], [hm('09:20'), 'SELL', 'PE', 25000, 75, 100, 'entry'],
    [hm('15:15'), 'BUY', 'CE', 25000, 75, 70, 'time'], [hm('15:15'), 'BUY', 'PE', 25000, 75, 90, 'time']]);
  const p = run.positions[0];
  near(p.gross, 30 * 75 + 10 * 75, 1e-9); // 3,000
  near(p.net, 3000 - 2 * charges('SELL', 100, 75) - charges('BUY', 70, 75) - charges('BUY', 90, 75), 1e-6);
  assert.equal(p.entry_premium, 200);
  // credit 200 x 75 = 15,000 at 25,000; unbounded loss; breakevens 25,000 -/+ 200
  assert.deepEqual(p.payoff, { max_profit: 15000, max_loss: null, breakevens: [24800, 25200] });
  // margin (ESTIMATED). per leg: 11% x 25,000 x 75 = 206,250 each = 412,500.
  // hedged: worst intrinsic loss over a ±9% move = 2,250 x 75 = 168,750, plus 2% exposure on 25,000 x 150 = 75,000.
  const perLeg = lab(s, sp, { margin_model: 'per_leg' }), hedged = lab(s, sp);
  near(perLeg.account.daily[0].peak_margin, 412500, 0.01);
  near(hedged.account.daily[0].peak_margin, 243750, 0.01);
  near(perLeg.net, p.net, 0.01); near(hedged.net, p.net, 0.01);
  reconciles(hedged, 1);
});

test('bull call spread: hedge bought first and sold last; payoff, net debit and hedged margin', () => {
  const s = [day(D1, { 'CE:25000': step(100, 140), 'CE:25100': step(50, 70) })];
  const sp = specFromTemplate('bull_call_spread', {}, { execution: NOSLIP } as any); // ATM call, sell 2 strikes higher
  const run = runLegs(s, sp);
  assert.deepEqual(fillsOf(run.results[0]), [
    [hm('09:20'), 'BUY', 'CE', 25000, 75, 100, 'entry'], [hm('09:20'), 'SELL', 'CE', 25100, 75, 50, 'entry'],
    [hm('15:15'), 'BUY', 'CE', 25100, 75, 70, 'time'], [hm('15:15'), 'SELL', 'CE', 25000, 75, 140, 'time']]);
  const p = run.positions[0];
  near(p.gross, 40 * 75 - 20 * 75, 1e-9); // 1,500
  assert.equal(p.entry_premium, -50); // a 50-point debit
  // width 100 - debit 50 = 50 x 75 = 3,750 either way; breakeven 25,000 + 50
  assert.deepEqual(p.payoff, { max_profit: 3750, max_loss: -3750, breakevens: [25050] });
  // hedged margin: the long call covers the short at every level, so only exposure: 2% x 25,000 x 75 = 37,500
  const r = lab(s, sp);
  near(r.account.daily[0].peak_margin, 37500, 0.01);
  reconciles(r, 1);
});

test('call ratio spread 1x2: the short leg trades twice the quantity; unbounded loss above', () => {
  const s = [day(D1, { 'CE:25000': 100, 'CE:25100': 55 })];
  const run = runLegs(s, specFromTemplate('call_ratio_spread', {}, { execution: NOSLIP } as any));
  const f = run.results[0].fills;
  assert.deepEqual(f.slice(0, 2).map((x: any) => [x.action, x.strike, x.qty, x.px]), [['BUY', 25000, 75, 100], ['SELL', 25100, 150, 55]]);
  const p = run.positions[0];
  assert.equal(p.entry_premium, 10); // -100 + 2 x 55
  // below 25,000 the 10-point credit is kept (750); at 25,100: 100 x 75 + 55 x 150 = 15,750 - 7,500 = 8,250;
  // above, slope -75 per point: breakeven 25,100 + 8,250 / 75 = 25,210
  assert.deepEqual(p.payoff, { max_profit: 8250, max_loss: null, breakevens: [25210] });
  near(p.gross, 0, 1e-9); // flat prices
  reconciles(lab(s, specFromTemplate('call_ratio_spread', {}, { execution: NOSLIP } as any)), 1);
});

test('iron condor held to expiry: carried overnight, settled at intrinsic, hedged margin and equity by hand', () => {
  // condor: buy PE 24,800, sell PE 24,900, sell CE 25,100, buy CE 25,200 (offset 2, width 2 strikes of 50)
  const d1 = day(D1, { 'PE:24800': 20, 'PE:24900': 40, 'CE:25100': step(40, 60), 'CE:25200': 20 });
  const d2 = day(D2, {}, step(25000, 25150, '15:00')); // expiry day; the last index bar closes at 25,150
  const sp = specFromTemplate('iron_condor', {}, { exit: { hold: 'expiry' }, execution: NOSLIP } as any);
  const run = runLegs([d1, d2], sp);
  const [r1, r2] = run.results;
  assert.equal(r1.status, 'traded');
  assert.deepEqual(fillsOf(r1), [
    [hm('09:20'), 'BUY', 'PE', 24800, 75, 20, 'entry'], [hm('09:20'), 'BUY', 'CE', 25200, 75, 20, 'entry'],
    [hm('09:20'), 'SELL', 'PE', 24900, 75, 40, 'entry'], [hm('09:20'), 'SELL', 'CE', 25100, 75, 40, 'entry']]);
  assert.equal(r1.carry.length, 4);
  // day 2: no time exit (every leg expires today); settled at 15:30 against 25,150: only CE 25,100 is in the money (50).
  // Settlement is simultaneous; shorts are booked first so the margin never sees the wings go before the body.
  assert.deepEqual(r2.fills.map((f: any) => [f.t, f.action, f.strike, f.px, f.reason, f.settlement, f.cost]), [
    [930, 'BUY', 24900, 0, 'expiry', true, 0], [930, 'BUY', 25100, 50, 'expiry', true, 0],
    [930, 'SELL', 24800, 0, 'expiry', true, 0], [930, 'SELL', 25200, 0, 'expiry', true, 0]]);
  assert.equal(r2.fills[1].settle_spot, 25150);
  const p = run.positions[0];
  // gross: -20x75 + 40x75 - (50-40)x75 - 20x75 = -1,500 + 3,000 - 750 - 1,500 = -750; settlement has no charges here
  near(p.gross, -750, 1e-9);
  const entryCh = 2 * charges('BUY', 20, 75) + 2 * charges('SELL', 40, 75);
  near(p.net, -750 - entryCh, 1e-6);
  assert.equal(p.exit_reason, 'expiry');
  // credit 40 x 75 = 3,000; worst (100 - 40) x 75 = 4,500; breakevens 24,900 - 40 and 25,100 + 40
  assert.deepEqual(p.payoff, { max_profit: 3000, max_loss: -4500, breakevens: [24860, 25140] });

  const r = lab([d1, d2], sp);
  const [a, b] = r.account.daily;
  // hedged margin: worst loss beyond either wing = 100 x 75 = 7,500, plus 2% x 25,000 x 150 short qty = 75,000
  near(a.peak_margin, 82500, 0.01); near(b.peak_margin, 82500, 0.01);
  // day 1 ends with 4 legs open; CE 25,100 marked at 60: unrealised (40 - 60) x 75 = -1,500
  assert.equal(a.open_legs, 4);
  near(a.unrealised_end, -1500, 1e-6);
  near(a.closing_balance, 500000 - entryCh, 1e-6);
  near(a.closing_equity, 500000 - entryCh - 1500, 1e-6);
  near(b.unrealised_start, -1500, 1e-6);
  near(b.net_realised, -750, 1e-6);
  assert.equal(b.open_legs, 0);
  assert.deepEqual(r.days.map((d: any) => [d.status, d.opened, d.closed]), [['traded', 4, 0], ['traded', 0, 4]]);
  assert.ok(r.account.report.warnings.some((w: string) => /cash-settled at expiry/.test(w)));
  assert.ok(r.account.report.warnings.some((w: string) => /hedged estimate/.test(w)));
  reconciles(r, 2);
});

test('expiry settlement: STT 0.125% of intrinsic on a long ITM option only; nothing on shorts or OTM', () => {
  const sp = spec([leg('L1', 'BUY', 'CE', atm(0)), leg('L2', 'SELL', 'CE', { by: 'leg', leg: 'L1', steps: 2 }), leg('L3', 'BUY', 'PE', atm(2))], { exit: { hold: 'expiry', time: '15:15' } });
  const d1 = day(D1, { 'CE:25000': 100, 'CE:25100': 50, 'PE:24900': 40 });
  const d2 = day(D2, {}, step(25000, 25200, '15:00'));
  const run = runLegs([d1, d2], sp);
  // settled against 25,200: CE 25,100 (short) at 100, CE 25,000 (long) at 200 with STT 18.75, PE 24,900 (long) at 0
  assert.deepEqual(run.results[1].fills.map((f: any) => [f.action, f.strike, f.px, f.cost]), [
    ['BUY', 25100, 100, 0], ['SELL', 25000, 200, 200 * 75 * 0.125 / 100], ['SELL', 24900, 0, 0]]);
  const p = run.positions[0];
  near(p.gross, (200 - 100) * 75 - (100 - 50) * 75 - 40 * 75, 1e-9); // 7,500 - 3,750 - 3,000 = 750
  near(p.net, 750 - charges('BUY', 100, 75) - charges('BUY', 40, 75) - charges('SELL', 50, 75) - 18.75, 1e-6);
  const r = lab([d1, d2], sp);
  const tb = compute.inspect('tradebook', 0, 100).rows;
  near(tb.find((t: any) => t.strike === 25000).stt, 18.75, 1e-9); // no STT on the buy, 18.75 on settlement
  near(r.net, p.net, 0.01);
  reconciles(r, 2);
  // the last index bar missing: settle on the close of the bar before, and say so
  const d2b = day(D2, {}, (t: number) => (t === 929 ? null : t < hm('15:00') ? 25000 : 25200));
  const run2 = runLegs([d1, d2b], sp);
  assert.ok(run2.results[1].flags.includes('settled_on_earlier_bar'));
  assert.equal(run2.results[1].fills[1].px, 200);
});

test('multi-day hold: a session with no orders is "holding"; a weekday with no data is a DATA_GAP warning', () => {
  const X = '2025-11-11';
  const s = [day(D1, { 'CE:25000': 100 }, 25000, X), day(D2, { 'CE:25000': 110 }, 25000, X), day('2025-11-06', { 'CE:25000': 120 }, 25000, X)];
  const sp = spec([leg('L1', 'BUY', 'CE', atm(0))], { exit: { hold: 'sessions', sessions: 2, time: '15:15' } });
  const run = runLegs(s, sp);
  assert.deepEqual(run.results.map((r: any) => r.status), ['traded', 'holding', 'traded']);
  assert.equal(run.results[1].reason, 'position carried; no order today');
  assert.deepEqual(fillsOf(run.results[2]), [[hm('15:15'), 'SELL', 'CE', 25000, 75, 120, 'time']]);
  assert.ok(run.results[2].flags.includes('carried_over_missing_days'));
  assert.ok(run.gates.some((g: any) => g.code === 'DATA_GAP' && /held across 1 weekday/.test(g.message)));
  near(run.positions[0].gross, 20 * 75, 1e-9);
  const r = lab(s, sp);
  const dl = r.account.daily;
  assert.deepEqual(dl.map((d: any) => d.open_legs), [1, 1, 0]);
  assert.deepEqual(dl.map((d: any) => d.unrealised_end), [0, 750, 0]); // (110 - 100) x 75 on day 2
  assert.deepEqual(r.days.map((d: any) => d.status), ['traded', 'holding', 'traded']);
  reconciles(r, 3);
});

test('a carried leg with no prices the next day is closed at its last seen price and flagged, never invented', () => {
  const d2 = day(D2, {}, 25000, '2025-11-11');
  delete d2.expiries[0].contracts['CE:25000'];
  const s = [day(D1, { 'CE:25000': step(100, 110) }, 25000, '2025-11-11'), d2];
  const run = runLegs(s, spec([leg('L1', 'BUY', 'CE', atm(0))], { exit: { hold: 'sessions', sessions: 1, time: '15:15' } }));
  assert.deepEqual(fillsOf(run.results[1]), [[555, 'SELL', 'CE', 25000, 75, 110, 'data_gap']]);
  assert.ok(run.results[1].flags.includes('closed_at_stale_price'));
  assert.ok(run.gates.some((g: any) => g.code === 'DATA_GAP' && /last seen price 110\.00/.test(g.message)));
});

// ------------------------------------------------------------------ missing data on the day

test('missing data: the decision bar, an entry price, a strike outside the window, an exit with no later price', () => {
  const sp = spec([leg('L1', 'BUY', 'CE', atm(0))]);
  const noBar = runLegs([day(D1, {}, (t: number) => (t === hm('09:19') ? null : 25000))], sp).results[0];
  assert.deepEqual([noBar.status, noBar.reason], ['excluded', 'no index bar at 09:19 to decide on']);
  const noPx = runLegs([day(D1, { 'CE:25000': (t: number) => (t === hm('09:20') ? null : 100) })], sp).results[0];
  assert.deepEqual([noPx.status, noPx.reason], ['excluded', 'no price at 09:20 for CE 25000']);
  // 5% above 25,000 = 26,250, beyond the stored 24,500-25,500: warned before the run, excluded on the day
  const far = spec([leg('L1', 'BUY', 'CE', { by: 'pct', pct: 5 })]);
  const fr = runLegs([day(D1)], far);
  assert.deepEqual([fr.results[0].status, fr.results[0].reason], ['excluded', 'leg L1 strike CE 26250 is outside the stored strike window']);
  assert.ok(fr.gates.some((g: any) => g.code === 'STRIKE_OUTSIDE_WINDOW'));
  // CE 25,000 stops printing at 15:00: the 15:15 exit falls back to the last close (130) and says so
  const end = runLegs([day(D1, { 'CE:25000': (t: number) => (t >= hm('15:00') ? null : t < hm('12:00') ? 100 : 130) })], sp).results[0];
  assert.deepEqual(fillsOf(end)[1], [hm('15:00'), 'SELL', 'CE', 25000, 75, 130, 'data_end']);
  assert.ok(end.flags.includes('exit_at_last_close'));
  // through the Lab path, every session still gets exactly one outcome with its reason
  const r = lab([day(D1, {}, (t: number) => (t === hm('09:19') ? null : 25000)), day(D2)], sp);
  assert.deepEqual(r.days.map((d: any) => [d.status, d.reason]), [['excluded', 'no index bar at 09:19 to decide on'], ['traded', null]]);
  assert.equal(r.account.report.range.excluded_days.length, 1);
});

test('entry filters: weekday, days to expiry, gap, move since open, opening-range width (no look-ahead)', () => {
  const one = (over: any) => spec([leg('L1', 'BUY', 'CE', atm(0))], over);
  const st = (r: any) => [r.status, r.reason];
  assert.deepEqual(st(runLegs([day(D1)], one({ entry: { time: '09:20', weekdays: [1] } })).results[0]), ['filtered', 'weekday filter']); // D1 is a Monday
  assert.deepEqual(st(runLegs([day(D1)], one({ entry: { time: '09:20', dte: { min: 2 } } })).results[0]), ['filtered', 'days to expiry 1 outside the filter']);
  // gap: previous session closes 25,000, today opens 25,300 = +1.20%
  const gap = runLegs([day('2025-10-31', {}, 25000, D2), day(D1, {}, 25300)], one({ entry: { time: '09:20', conditions: [{ kind: 'gap_pct', max: 1 }] } })).results;
  assert.deepEqual(st(gap[0]), ['filtered', 'gap filter needs the previous session, which is not in the range']);
  assert.deepEqual(st(gap[1]), ['filtered', 'gap 1.20% outside the filter']);
  // move: opens 25,000, 25,200 by 09:19 = +0.80%
  const mv = runLegs([day(D1, {}, (t: number) => (t < hm('09:17') ? 25000 : 25200))], one({ entry: { time: '09:20', conditions: [{ kind: 'move_pct', max: 0.5 }] } }));
  assert.deepEqual(st(mv.results[0]), ['filtered', 'move since open 0.80% outside the filter']);
  // opening-range width: 09:20 bar spans 24,900-25,100 = 200 / 25,000 = 0.80%; needs the entry after the range closes
  const wide = (t: number) => (t === hm('09:20') ? { o: 25000, h: 25100, l: 24900, c: 25000 } : 25000);
  const w = runLegs([day(D1, {}, wide)], one({ entry: { time: '09:45', conditions: [{ kind: 'or_width_pct', max: 0.5 }] } }));
  assert.deepEqual(st(w.results[0]), ['filtered', 'opening-range width 0.80% outside the filter']);
  assert.ok(runLegs([day(D1, {}, wide)], one({ entry: { time: '09:45', conditions: [{ kind: 'or_width_pct', max: 1 }] } })).results[0].status === 'traded');
  assert.deepEqual(G.validate(one({ entry: { time: '09:30', conditions: [{ kind: 'or_width_pct', max: 1 }] } })).errors.map((g: any) => g.message), ['The opening-range width needs the entry at or after 09:45.']);
});

// ------------------------------------------------------------------ stops, targets, adjustments

test('leg stops: trigger on the bar high, gap-aware fill, stop beats target, and the three adjustments', () => {
  const spike = (bar: any) => (t: number) => (t === hm('11:00') ? bar : t < hm('11:00') ? 100 : 128);
  const strad = (on: string, extra: any = {}) => specFromTemplate('short_straddle', {}, { adjust: { on_leg_stop: on, max_reentries: 1, cutoff: '14:30' }, execution: NOSLIP, ...extra } as any);
  const withStops = (sp: any, stop: any, target?: any) => ({ ...sp, legs: sp.legs.map((l: any) => ({ ...l, stop, ...(target ? { target } : {}) })) });
  const s = [day(D1, { 'CE:25000': spike({ o: 125, h: 135, l: 120, c: 128 }) })];
  // keep the others: CE sold at 100, stop 130 touched at 11:00 (high 135, open 125) -> filled at 130; PE held to 15:15
  const keep = runLegs(s, withStops(strad('keep_others'), { kind: 'pct', value: 30 }));
  assert.deepEqual(fillsOf(keep.results[0]).slice(2), [[hm('11:00'), 'BUY', 'CE', 25000, 75, 130, 'leg_stop'], [hm('15:15'), 'BUY', 'PE', 25000, 75, 100, 'time']]);
  near(keep.positions[0].gross, -30 * 75, 1e-9);
  // the bar opens above the stop: filled at the open, 140, flagged
  const gap = runLegs([day(D1, { 'CE:25000': spike({ o: 140, h: 145, l: 138, c: 142 }) })], withStops(strad('keep_others'), { kind: 'pct', value: 30 }));
  assert.equal(gap.results[0].fills[2].px, 140);
  assert.ok(gap.results[0].flags.includes('stop_gap'));
  // close all: the PE goes at the next bar's open
  const all = runLegs(s, withStops(strad('close_all'), { kind: 'pct', value: 30 }));
  assert.deepEqual(fillsOf(all.results[0]).slice(3), [[hm('11:01'), 'BUY', 'PE', 25000, 75, 100, 'leg_stop']]);
  assert.equal(all.positions[0].exit_reason, 'leg_stop');
  // re-enter once: ATM re-picked on the 11:00 close (index 25,000), sold at the 11:01 open (128), new stop 166.40
  const re = runLegs(s, withStops(strad('reenter'), { kind: 'pct', value: 30 }));
  const rf = re.results[0].fills;
  assert.deepEqual([rf[3].t, rf[3].action, rf[3].strike, rf[3].px, rf[3].reason, rf[3].leg, rf[3].stop], [hm('11:01'), 'SELL', 25000, 128, 're-entry', 'P1.L1.r1', 166.4]);
  assert.equal(re.positions[0].legs.length, 3);
  // with slippage: sold at 99.45, stop roundUp(99.45 x 1.3) = 129.30; fill 129.30 x (1 + 2 x 0.5%) + 2 ticks = 130.70
  const sl = runLegs(s, withStops(strad('keep_others', { execution: SLIP }), { kind: 'pct', value: 30 }));
  assert.deepEqual(sl.results[0].fills.slice(0, 3).map((f: any) => f.px), [99.45, 99.45, 130.7]);
  // stop and target inside the same bar: the stop wins
  const both = runLegs([day(D1, { 'CE:25000': spike({ o: 100, h: 135, l: 45, c: 100 }) })], withStops(strad('keep_others'), { kind: 'pct', value: 30 }, { kind: 'pct', value: 50 }));
  assert.equal(both.results[0].fills[2].reason, 'leg_stop');
  assert.ok(both.results[0].flags.includes('stop_and_target_same_bar'));
  // a long leg's target is a resting limit: a bar that opens at 140 and trades 160 fills at the target, 150
  const lt = runLegs([day(D1, { 'CE:25000': spike({ o: 140, h: 160, l: 139, c: 150 }) })], spec([leg('L1', 'BUY', 'CE', atm(0), { target: { kind: 'pct', value: 50 } })]));
  assert.deepEqual(fillsOf(lt.results[0])[1], [hm('11:00'), 'SELL', 'CE', 25000, 75, 150, 'leg_target']);
});

test('position target and stop (net of charges) are checked at the close and filled at the next open', () => {
  const sp = (exit: any) => specFromTemplate('short_straddle', {}, { exit: { hold: 'intraday', time: '15:15', basis: 'net', ...exit }, execution: NOSLIP } as any);
  // both legs fall to 90 at 10:00: gross 1,500; net of entry and estimated exit charges ~1,378 >= 1,000
  const t = runLegs([day(D1, { 'CE:25000': step(100, 90, '10:00'), 'PE:25000': step(100, 90, '10:00') })], sp({ target: { kind: 'rupees_per_lot', value: 1000 } }));
  assert.deepEqual(fillsOf(t.results[0]).slice(2), [[hm('10:01'), 'BUY', 'CE', 25000, 75, 90, 'target'], [hm('10:01'), 'BUY', 'PE', 25000, 75, 90, 'target']]);
  assert.equal(t.positions[0].exit_reason, 'target');
  const est = 1500 - 2 * charges('SELL', 100, 75) - 2 * charges('BUY', 90, 75);
  assert.ok(est >= 1000 && est < 1400, String(est));
  // both rise to 105: gross -750, net ~ -873 <= -500
  const st = runLegs([day(D1, { 'CE:25000': step(100, 105, '10:00'), 'PE:25000': step(100, 105, '10:00') })], sp({ stop: { kind: 'rupees_per_lot', value: 500 } }));
  assert.equal(st.results[0].fills[2].t, hm('10:01'));
  assert.equal(st.positions[0].exit_reason, 'stop');
  // a net target of 2,000 is never reached: held to the exit time
  const no = runLegs([day(D1, { 'CE:25000': step(100, 90, '10:00'), 'PE:25000': step(100, 90, '10:00') })], sp({ target: { kind: 'rupees_per_lot', value: 2000 } }));
  assert.equal(no.positions[0].exit_reason, 'time');
});

// ------------------------------------------------------------------ strike rules

test('premium-based strikes use the close of the bar before entry; the fill is the entry-bar open', () => {
  const over = { 'CE:25050': 90, 'CE:25100': 80, 'CE:25150': 70, 'CE:25200': step(62, 40, '09:20'), 'CE:25250': 55, 'CE:25300': 30, 'CE:25350': 20, 'CE:25400': 10, 'CE:25450': 8, 'CE:25500': 5 };
  const pick = (side: string) => runLegs([day(D1, over)], spec([leg('L1', 'BUY', 'CE', { by: 'premium', price: 60, side })])).results[0].fills[0];
  assert.deepEqual([pick('nearest').strike, pick('nearest').px], [25200, 40]); // 62 at 09:19 is nearest to 60
  assert.equal(pick('at_most').strike, 25250); // 55
  assert.equal(pick('at_least').strike, 25200); // 62
  // % from ATM: 0.5% above 25,000 = 25,125, exactly 2.5 strikes: a tie goes away from ATM (at least the distance asked),
  // for puts too (24,875 -> 24,850). 1% above = 25,250 and 0.4% below = 24,900 land on strikes exactly.
  const pctK = (right: string, pct: number) => runLegs([day(D1)], spec([leg('L1', 'BUY', right, { by: 'pct', pct })])).results[0].fills[0].strike;
  assert.deepEqual([pctK('CE', 0.5), pctK('PE', 0.5), pctK('CE', 1), pctK('PE', 0.4)], [25150, 24850, 25250, 24900]);
  // ATM ties go to the lower strike: index 25,025 sits between 25,000 and 25,050
  assert.equal(runLegs([day(D1, {}, 25025)], spec([leg('L1', 'BUY', 'CE', atm(0))])).results[0].fills[0].strike, 25000);
});

test('delta strikes: allowed only where Greeks are reliable; picks the strike whose delta is nearest', () => {
  // Black-Scholes prices at 15% vol for 1 day + 370/375 of a session to expiry, as the engine measures time at 09:19
  const T = (1 + (930 - 560) / 375) / 365, vol = 0.15;
  const px = (r: string, k: number) => Math.max(0.05, G.bsPrice(r, 25000, k, T, vol));
  const syn = session(D1, 25000, [{ expiry: D2, contracts: ladder(px) }], 'synthetic');
  // the test's own delta: a central difference of price in the index level, at the known vol
  const fd = (k: number) => (G.bsPrice('CE', 25001, k, T, vol) - G.bsPrice('CE', 24999, k, T, vol)) / 2;
  let best = 0, bd = Infinity;
  for (let k = 24500; k <= 25500; k += 50) { const d = Math.abs(fd(k) - 0.25); if (d < bd) { bd = d; best = k; } }
  const sp = spec([leg('L1', 'BUY', 'CE', { by: 'delta', delta: 0.25 })]);
  assert.equal(runLegs([syn], sp).results[0].fills[0].strike, best);
  assert.ok(best > 25000 && best < 25300, String(best));
  // the same rule on real (Dhan) data is refused before anything runs
  assert.throws(() => runLegs([day(D1)], sp), (e: any) => e.gates.some((g: any) => g.code === 'DELTA_NO_GREEKS'));
});

// ------------------------------------------------------------------ gates

test('gates: unsupported combinations are refused with a reason instead of being faked', () => {
  const caps = G.capsOf([day(D1)]);
  assert.deepEqual(caps, { source: 'dhan', underlying: 'NIFTY', series: ['WEEK'], nth: [1], strike_window: 10, greeks: false, bid_ask: false, continuous: true, expiry_assumed: false });
  const codes = (sp: any, c = caps) => G.validate(sp, c).errors.map((g: any) => g.code);
  const one = spec([leg('L1', 'BUY', 'CE', atm(0))]);
  assert.deepEqual(codes({ ...one, underlying: 'BANKNIFTY' }), ['UNDERLYING_NOT_STORED']);
  assert.deepEqual(codes(spec([leg('L1', 'BUY', 'CE', atm(0), { expiry: { series: 'MONTH', nth: 1 } })])), ['SERIES_NOT_STORED']);
  assert.deepEqual(codes(specFromTemplate('calendar_call')), ['NEXT_EXPIRY_NOT_STORED']);
  assert.deepEqual(codes(spec([leg('L1', 'BUY', 'CE', atm(12))])), ['STRIKE_OUTSIDE_WINDOW']);
  assert.deepEqual(codes(spec([leg('L1', 'BUY', 'CE', atm(4)), leg('L2', 'SELL', 'CE', { by: 'leg', leg: 'L1', steps: 7 })])), ['STRIKE_OUTSIDE_WINDOW']); // 4 + 7 = 11
  const syn = G.capsOf(E.syntheticCalendar(2, { iv: 13 }, 1));
  assert.deepEqual(codes({ ...one, exit: { hold: 'sessions', sessions: 1, time: '15:15' } }, syn), ['HOLD_NEEDS_CONTINUOUS']);
  assert.deepEqual(codes(one), []);
  const w = G.validate(one, caps).warnings.map((g: any) => g.code);
  assert.ok(w.includes('NO_BID_ASK'));
  assert.ok(G.validate({ ...one, exit: { hold: 'expiry', time: '15:15' } }, { ...caps, expiry_assumed: true }).warnings.some((g: any) => g.code === 'EXPIRY_ASSUMED'));
  // structure
  const bad = (sp: any) => G.validate(sp).errors.map((g: any) => g.message);
  assert.deepEqual(bad(spec([])), ['Add at least one leg.']);
  assert.ok(bad({ ...one, lots: 0 })[0].startsWith('Lots must be'));
  assert.ok(bad(spec([leg('L1', 'BUY', 'CE', { by: 'leg', leg: 'L2', steps: 1 }), leg('L2', 'BUY', 'CE', atm(0))]))[0].includes('earlier leg'));
  assert.ok(bad({ ...one, entry: { time: '09:20', conditions: [{ kind: 'or_inside', or_minutes: 30, candle_minutes: 5 }] } })[0].includes('09:50'));
  // the Lab path throws with the gates attached, so the page can list them
  assert.throws(() => lab([day(D1)], specFromTemplate('calendar_put')), (e: any) => Array.isArray(e.gates) && e.gates[0].code === 'NEXT_EXPIRY_NOT_STORED');
});

test('templates: all 25 are valid specs; on nearest-expiry data only calendars and diagonals are gated', () => {
  assert.equal(TEMPLATES.length, 25);
  const caps = G.capsOf([day(D1)]);
  const gated: string[] = [];
  for (const t of TEMPLATES) {
    const sp = specFromTemplate(t.id);
    assert.ok(G.validate(sp).ok, `${t.id}: ${JSON.stringify(G.validate(sp).errors)}`);
    if (!G.validate(sp, caps).ok) gated.push(t.id);
    assert.equal(t.needs === 'next expiry', gated.includes(t.id), t.id);
  }
  assert.deepEqual(gated, ['calendar_call', 'calendar_put', 'diagonal_call', 'diagonal_put']);
});

test('every runnable template on 20 synthetic days: each session one outcome, engine = ledger for every position', () => {
  const sessions = E.syntheticCalendar(20, { iv: 13 }, 3);
  for (const t of TEMPLATES.filter((x) => x.needs === 'nearest expiry')) {
    const r = compute.run({ strategy: 'legs', spec: specFromTemplate(t.id), capital: 2000000 }, sessions);
    assert.equal(r.account.rejections.length, 0, t.id);
    const checks = r.account.report.reconciliation.checks;
    assert.ok(checks.some((c: any) => /^position P1: engine net = ledger net$/.test(c.name)), t.id);
    reconciles(r, 20);
    assert.ok(r.positions.length > 0, t.id);
    // the position count shown equals positions closed in the tradebook; every leg of a structure is in it
    const legsPer = specFromTemplate(t.id).legs.length;
    assert.equal(compute.inspect('tradebook', 0, 1e6).total, r.positions.length * legsPer, t.id);
  }
});

// ------------------------------------------------------------------ margin

test('margin: per-leg rejects a naked short the account cannot carry; the hedged estimate lets a spread through', () => {
  const s = [day(D1, { 'CE:25000': 100, 'CE:25100': 50 })];
  // naked short call, per leg: 11% x 25,000 x 75 = 206,250 (+ charges) > 100,000 -> refused, the day says why
  const naked = lab(s, specFromTemplate('short_call', {}, { execution: NOSLIP } as any), { capital: 100000, margin_model: 'per_leg' });
  assert.equal(naked.account.rejections.length, 1);
  near(naked.account.rejections[0].required, 206250 + charges('SELL', 100, 75), 1e-6);
  near(naked.account.rejections[0].available, 100000, 1e-9);
  assert.deepEqual([naked.days[0].status, naked.net, naked.traded], ['rejected', 0, 0]);
  const spread = specFromTemplate('bull_call_spread', {}, { execution: NOSLIP } as any);
  // per leg, the short CE 25,100 needs 11% x 25,100 x 75 = 207,075: refused, leaving the long call alone
  const pl = lab(s, spread, { capital: 100000, margin_model: 'per_leg' });
  assert.equal(pl.account.rejections.length, 1);
  assert.equal(pl.account.rejections[0].strike, 25100);
  // hedged: the long call covers it; only 2% exposure, 37,500, is blocked, and both legs trade
  const hd = lab(s, spread, { capital: 100000 });
  assert.equal(hd.account.rejections.length, 0);
  near(hd.account.daily[0].peak_margin, 37500, 0.01);
  reconciles(hd, 1);
  // the hedged figures directly: naked = per leg; strangle and put spread by hand
  const A = L.makeAccount({ margin_model: 'hedged' });
  const l = (dir: number, side: string, strike: number) => ({ dir, side, strike, qty: 75, spot: 25000, margin: 0 });
  near(L.hedgedMargin([l(-1, 'CE', 25000)], A), L.marginFor(-1, 25000, 75, A), 1e-6); // 206,250
  near(L.hedgedMargin([l(-1, 'CE', 25200), l(-1, 'PE', 24800)], A), 2050 * 75 + 0.02 * 25000 * 150, 1e-6); // 228,750
  near(L.hedgedMargin([l(-1, 'PE', 25000), l(1, 'PE', 24900)], A), 100 * 75 + 0.02 * 25000 * 75, 1e-6); // 45,000
  assert.equal(L.hedgedMargin([l(1, 'CE', 25000), l(1, 'PE', 25000)], A), 0);
});

// ------------------------------------------------------------------ against the existing engine

test('Strategy 01 as a leg spec agrees with the straddle engine fill for fill (re-entry off), on two synthetic calendars', () => {
  for (const [days, iv, seed] of [[120, 13, 1], [60, 18, 7]]) {
    const sessions = E.syntheticCalendar(days, { iv }, seed);
    const bt = E.runBacktest(sessions, E.makeConfig({ reentry_enabled: false, rates_for: L.ratesHook, sl_pct: 36, target_per_lot: 1000 }));
    const run = G.run(sessions, straddle01Spec(), { L });
    let traded = 0;
    for (let i = 0; i < sessions.length; i++) {
      const a = bt.results[i], b = run.results[i];
      assert.equal(b.status, a.status, `${a.date}: ${a.reason} / ${b.reason}`);
      if (a.status !== 'traded') continue;
      traded++;
      const p = run.positions.find((x: any) => x.opened.date === a.date);
      near(p.net, a.net, 1e-6);
      assert.deepEqual(b.fills.map((f: any) => [f.t, f.action, f.side, f.strike, f.px]), a.fills.map((f: any) => [f.t, f.action, f.side, f.strike, f.px]));
    }
    assert.ok(traded > days / 3, `only ${traded} traded days`);
  }
});
