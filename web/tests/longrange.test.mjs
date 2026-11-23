// Long ranges and large inputs must never hit "Maximum call stack size exceeded". The crash came from
// Math.min(...xs) / Math.max(...xs) over arrays that grow with the data: every element becomes a call argument,
// and V8 throws a RangeError somewhere past ~100k of them. Each test below pushes one of those paths well past
// that size through the public functions, and checks the figure against a plain loop.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { session, ladder } from './helpers/session.mjs';
const require = createRequire(import.meta.url);
const L = require('../public/engine/ledger.js');
const E = require('../public/engine/engine.js');
const F = require('../public/engine/fourleg_engine.js');
const G = require('../public/engine/legs.js');
const A = require('../public/engine/analytics.js');
const makeCompute = require('../public/engine/compute.js');

const BIG = 250000; // comfortably past the spread-argument limit
const loopMin = (xs) => xs.reduce((m, x) => (x < m ? x : m), Infinity);
const loopMax = (xs) => xs.reduce((m, x) => (x > m ? x : m), -Infinity);
const isoDay = (i) => new Date(Date.UTC(2021, 0, 4) + i * 86400000).toISOString().slice(0, 10);

test('the spread limit is real on this runtime (otherwise these tests would prove nothing)', () => {
  const xs = Array.from({ length: 2_000_000 }, (_, i) => i);
  assert.throws(() => Math.max(...xs), RangeError);
});

test('India VIX summary over 400 sessions of 1-minute bars (150k values) runs for all three VIX-aware engines', () => {
  // flat index and chain; VIX drifts so its min and max are known
  const sessions = [];
  for (let d = 0; d < 400; d++) {
    const s = session(isoDay(d * 1.4 | 0), 25000, [{ expiry: isoDay((d * 1.4 | 0) + 2), contracts: ladder((r, k) => Math.max(5, 100 - Math.abs(k - 25000) / 5)) }]);
    s.vix = { o: [], h: [], l: [], c: [] };
    for (let i = 0; i < s.times.length; i++) { const v = 12 + (d * 375 + i) / 150000; s.vix.o.push(v); s.vix.h.push(v); s.vix.l.push(v); s.vix.c.push(v); }
    sessions.push(s);
  }
  const dates = new Set(sessions.map((s) => s.date));
  assert.equal(dates.size, sessions.length);
  for (const strategy of ['straddle', 'orb', 'ema_pullback']) {
    const r = makeCompute(E, F, L, G).run({ strategy }, sessions);
    const row = r.extra.find(([k]) => k === 'India VIX observed range');
    assert.ok(row, `${strategy}: VIX range row present`);
    assert.equal(row[1], `${(12).toFixed(2)}–${(12 + (399 * 375 + 374) / 150000).toFixed(2)}`);
  }
});

test('analytics.perf over 250k sessions: best, worst and peak margin match a plain loop', () => {
  const days = Array.from({ length: BIG }, (_, i) => ({ date: isoDay(i), status: 'traded', traded: true, net: Math.sin(i) * 1000, gross: Math.sin(i) * 1000 + 50, costs: 50,
    util_pct: (i % 97) + 0.5, peak_margin: 1000 + (i % 1013), exit_reason: 'time', rejected: 0 }));
  const p = A.perf(days, { capital: 500000 });
  const nets = days.map((d) => d.net);
  assert.equal(p.best, loopMax(nets));
  assert.equal(p.worst, loopMin(nets));
  assert.equal(p.util_peak, loopMax(days.map((d) => d.util_pct)));
  assert.equal(p.peak_margin, loopMax(days.map((d) => d.peak_margin)));
});

test('engine daily metrics over 250k traded sessions: largest win and loss match a plain loop', () => {
  const results = Array.from({ length: BIG }, (_, i) => ({ date: isoDay(i), status: 'traded', net: Math.cos(i) * 700, gross: Math.cos(i) * 700, costs: 0, mae: -Math.abs(Math.sin(i)) * 900, mfe: Math.abs(Math.cos(i)) * 800 }));
  const m = E.dailyCore(results, 1);
  const nets = results.map((r) => r.net);
  assert.equal(m.largest_win, loopMax(nets));
  assert.equal(m.largest_loss, loopMin(nets));
});

test('ledger report over 130k closed trades: largest win and loss match a plain loop', () => {
  // 260 days x 500 round trips, one short CE each, alternating winners and losers
  const results = [];
  for (let d = 0; d < 260; d++) {
    const fills = [];
    for (let j = 0; j < 500; j++) {
      const t = 556 + (j % 360), sell = 100 + (j % 7), buy = sell + ((j + d) % 2 ? -3 : 4) - (j % 5) * 0.05;
      fills.push({ t, leg: `${d}.${j}`, action: 'SELL', px: sell, strike: 25000, qty: 75, side: 'CE', expiry: '2026-12-31', reason: 'entry', cost: 0, costs: null });
      fills.push({ t, leg: `${d}.${j}`, action: 'BUY', px: buy, strike: 25000, qty: 75, side: 'CE', expiry: '2026-12-31', reason: 'time', cost: 0, costs: null });
    }
    results.push({ date: isoDay(2000 + d * 1.4 | 0), status: 'traded', lot_size: 75, symbol: 'NIFTY', flags: [], events: [], mtm: [], fills, exit_reason: 'time' });
  }
  const led = L.runLedger(results, { initial_capital: 1e12, margin_policy: 'record' });
  assert.equal(led.tradebook.length, 130000);
  const nets = led.tradebook.map((t) => t.net_pnl);
  assert.equal(led.report.performance.largest_win, loopMax(nets));
  assert.equal(led.report.performance.largest_loss, loopMin(nets));
});
