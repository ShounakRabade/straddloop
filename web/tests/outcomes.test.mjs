// Reproduces the Lab report from 19 Nov 2026 (Real NIFTY, 6-8 Oct 2025): the range said "3 trading days will run",
// the result said "1 traded day" and nothing on the page said what happened to the other two. Every session the
// engine receives must now come back with exactly one outcome and a reason.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dayDoc, hm } from './helpers/dayfile.mjs';
const require = createRequire(import.meta.url);
const L = require('../public/engine/ledger.js');
const E = require('../public/engine/engine.js');
const F = require('../public/engine/fourleg_engine.js');
const D = require('../public/engine/dayfile.js');
const compute = require('../public/engine/compute.js')(E, F, L);

// Index flat at 25,000; opening range 09:15-09:45 spans 24,990-25,010 (09:20 bar), options flat at 100.
function day(date, { missing = [], breakout = false, expiry = date <= '2025-10-07' ? '2025-10-07' : '2025-10-14' } = {}) {
  const index = (t) => {
    if (missing.includes(t)) return null;
    if (t === hm('09:20')) return { o: 25000, h: 25010, l: 24990, c: 25000 };
    if (breakout && t === hm('09:47')) return { o: 25000, h: 25030, l: 25000, c: 25020 }; // pokes above the OR high
    return 25000;
  };
  const opt = () => 100;
  const series = [];
  for (const off of [-1, 0, 1]) for (const cp of ['CE', 'PE']) series.push({ cp, off, strike: 25000 + 50 * off, px: opt });
  return D.toSession(dayDoc({ date, expiry, index: (() => { const b = { o: [], h: [], l: [], c: [] }; for (let t = 555; t < 930; t++) { const v = index(t); const x = v == null ? { o: null, h: null, l: null, c: null } : typeof v === 'number' ? { o: v, h: v, l: v, c: v } : v; b.o.push(x.o); b.h.push(x.h); b.l.push(x.l); b.c.push(x.c); } return b; })(), series }), {});
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
