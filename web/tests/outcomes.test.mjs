// Reproduces the Lab report from 19 Nov 2026 (Real NIFTY, 6-8 Oct 2025): the range said "3 trading days will run",
// the result said "1 traded day" and nothing on the page said what happened to the other two. Every session the
// engine receives must now come back with exactly one outcome and a reason.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { bars, dayDoc, hm } from './helpers/dayfile.mjs';
const require = createRequire(import.meta.url);
const L = require('../public/engine/ledger.js');
const E = require('../public/engine/engine.js');
const F = require('../public/engine/fourleg_engine.js');
const D = require('../public/engine/dayfile.js');
const compute = require('../public/engine/compute.js')(E, F, L);

test('day-file decoder carries optional 1-minute India VIX OHLC into real sessions', () => {
  const session = D.toSession(dayDoc({ date: '2025-10-06', expiry: '2025-10-07', series: [],
    vix: bars(() => ({ o: 15.2, h: 15.4, l: 15.1, c: 15.3 })) }), {});
  assert.equal(session.vix.o[0], 15.2);
  assert.equal(session.vix.h[0], 15.4);
  assert.equal(session.vix.l[0], 15.1);
  assert.equal(session.vix.c[0], 15.3);
});

// Index flat at 25,000; opening range 09:15-09:45 spans 24,990-25,010 (09:20 bar), options flat at 100.
function day(date, { missing = [], breakout = false, vix = false, expiry = date <= '2025-10-07' ? '2025-10-07' : '2025-10-14' } = {}) {
  const index = (t) => {
    if (missing.includes(t)) return null;
    if (t === hm('09:20')) return { o: 25000, h: 25010, l: 24990, c: 25000 };
    if (breakout && t === hm('09:47')) return { o: 25000, h: 25030, l: 25000, c: 25020 }; // pokes above the OR high
    return 25000;
  };
  const opt = () => 100;
  const series = [];
  for (const off of [-1, 0, 1]) for (const cp of ['CE', 'PE']) series.push({ cp, off, strike: 25000 + 50 * off, px: opt });
  return D.toSession(dayDoc({ date, expiry, index: (() => { const b = { o: [], h: [], l: [], c: [] }; for (let t = 555; t < 930; t++) { const v = index(t); const x = v == null ? { o: null, h: null, l: null, c: null } : typeof v === 'number' ? { o: v, h: v, l: v, c: v } : v; b.o.push(x.o); b.h.push(x.h); b.l.push(x.l); b.c.push(x.c); } return b; })(),
    vix: vix ? bars(() => ({ o: 15, h: 15.2, l: 14.9, c: 15.1 })) : null, series }), {});
}

test('every session gets one outcome with its reason; counts reconcile with the ledger', () => {
  const sessions = [day('2025-10-06', { missing: [hm('09:31')] }), day('2025-10-07', { breakout: true }), day('2025-10-08')];
  const r = compute.run({ strategy: 'straddle', sl_pct: 36, target_per_lot: 1000, lots: 1, slip_pct: 0.5 }, sessions);
  assert.equal(r.days.length, 3);
  assert.deepEqual(r.days.map((d) => d.status), ['excluded', 'no_entry', 'traded']);
  assert.equal(r.days[0].reason, 'incomplete opening range: index bar 09:31 missing');
  assert.equal(r.days[1].reason, "entry condition 'full' failed");
  assert.equal(r.days[2].reason, null);
  assert.equal(r.traded, 1);
  assert.equal(r.days.filter((d) => d.status === 'traded').length, r.traded);
  // the report says the same thing in its own words: 2 decided sessions + 1 excluded for data = 3 days run
  const rep = r.account.report;
  assert.equal(rep.range.sessions + rep.range.excluded_days.length, r.days.length);
  assert.equal(rep.range.traded_days, 1);
  // per-day net adds up to the headline net, which comes from the ledger
  const sum = r.days.reduce((a, d) => a + d.net, 0);
  assert.ok(Math.abs(sum - r.net) < 1e-6, `${sum} vs ${r.net}`);
});

test('ORB runs report one outcome per session too', () => {
  const sessions = [day('2025-10-06', { missing: [hm('09:31')] }), day('2025-10-08')];
  const r = compute.run({ strategy: 'orb', target_points: 30, lots: 1, slip_pct: 0.5 }, sessions);
  assert.equal(r.days.length, 2);
  assert.equal(r.days[0].status, 'excluded');
  assert.match(r.days[0].reason, /09:31 missing/);
  assert.equal(r.days[1].status, 'no_entry'); // flat index: no breakout
});

test('a range where no day trades returns a result instead of crashing (it threw on m.equity_curve before)', () => {
  const sessions = [day('2025-10-07', { breakout: true }), day('2025-10-06', { missing: [hm('09:40')] })];
  const r = compute.run({ strategy: 'straddle', lots: 1, slip_pct: 0.5 }, sessions);
  assert.equal(r.traded, 0); assert.equal(r.net, 0); assert.deepEqual(r.curve.map((c) => c.v), [0]);
  assert.deepEqual(r.days.map((d) => d.status), ['excluded', 'no_entry']); // sorted by date
  assert.match(r.days[0].reason, /09:40 missing/);
});

test('VIX threshold filters a straddle using actual entry-minute VIX and reports historical coverage', () => {
  const missing = compute.run({ strategy: 'straddle', min_vix: 16, lots: 1, slip_pct: 0.5 }, [day('2025-10-08')]);
  assert.equal(missing.days[0].status, 'filtered');
  assert.match(missing.days[0].reason, /India VIX bar missing/);
  const observed = compute.run({ strategy: 'straddle', min_vix: 14, lots: 1, slip_pct: 0.5 }, [day('2025-10-08', { vix: true })]);
  assert.equal(observed.days[0].status, 'traded');
  assert.match(String(observed.extra.find(([k]) => k === 'India VIX coverage')?.[1]), /1 of 1 sessions/);
});

test('EMA pullback runs on real session bars and does not invent a setup in a flat market', () => {
  const r = compute.run({ strategy: 'ema_pullback', lots: 1, slip_pct: 0.5 }, [day('2025-10-08')]);
  assert.equal(r.strategy, 'ema_pullback');
  assert.equal(r.days.length, 1);
  assert.equal(r.traded, 0);
  assert.match(String(r.extra.find(([k]) => k === 'India VIX data')?.[1]), /Unavailable/);
  assert.equal(E.EMA.emaValues(Array.from({ length: 20 }, (_, i) => ({ c: 100 + i })), 10).filter(Number.isFinite).length, 11);
});

test('EMA confirmation enters an available historical option and closes intraday through the ledger', () => {
  const times = Array.from({ length: 375 }, (_, i) => 555 + i), und = { o: [], h: [], l: [], c: [] };
  const fives = [];
  let prev = 25000;
  for (let k = 0; k < 75; k++) {
    let o = prev, c = k <= 29 ? 25000 + k * 10 : prev + 5, h = Math.max(o, c) + 3, l = Math.min(o, c) - 3;
    if (k === 30) { o = prev; c = prev - 20; h = o + 2; l = 25230; }
    if (k === 31) { o = 25260; c = 25310; h = 25315; l = 25255; }
    if (k > 31) { o = prev; c = prev + 2; h = c + 2; l = o - 2; }
    fives.push({ o, h, l, c }); prev = c;
  }
  for (let i = 0; i < fives.length; i++) {
    const b = fives[i];
    for (let j = 0; j < 5; j++) {
      const x = i * 5 + j;
      und.o[x] = j === 0 ? b.o : b.c; und.c[x] = j === 4 ? b.c : b.o;
      und.h[x] = j === 2 ? b.h : Math.max(und.o[x], und.c[x]); und.l[x] = j === 3 ? b.l : Math.min(und.o[x], und.c[x]);
    }
  }
  const blank = () => Array(375).fill(100), contracts = {};
  for (const cp of ['CE', 'PE']) for (const strike of [25000, 25250, 25500]) contracts[`${cp}:${strike}`] = { o: blank(), h: blank(), l: blank(), c: blank() };
  const session = { date: '2025-10-08', symbol: 'NIFTY', bar_minutes: 1, times, und, vix: null,
    expiries: [{ expiry: '2025-10-14', lot_size: 75, contracts }] };
  const r = compute.run({ strategy: 'ema_pullback', lots: 1, slip_pct: 0 }, [session]);
  assert.equal(r.traded, 1);
  assert.equal(r.days[0].status, 'traded');
  assert.ok(r.account.report.reconciliation.ok);
  assert.ok(r.days[0].closed >= 1);
});
