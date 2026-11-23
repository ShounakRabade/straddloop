// Rolling windows (analytics.runRolling, the worker's rolling request): each window must be exactly the backtest
// the Lab would run on those dates alone.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { rollingWindows } from '../lib/dateRange.ts';
import { labStrategy } from '../lib/strategyRegistry.ts';
import { freshCompute, loadDayFiles, REAL_RANGE } from './helpers/golden.mts';
const require = createRequire(import.meta.url);
const A = require('../public/engine/analytics.js');
const E = require('../public/engine/engine.js');

/** What the worker does: the sessions of one window, through compute.evaluate (the latest run is left alone). */
const runnerFor = (compute: ReturnType<typeof freshCompute>, sessions: any[]) => (p: any, from: string, to: string) => {
  const sub = sessions.filter((s) => s.date >= from && s.date <= to);
  return sub.length ? A.fromRun(compute.evaluate(p, sub)) : null;
};

test('every window equals a backtest of those dates alone; the latest run is left alone', async () => {
  const sessions = E.syntheticCalendar(60, { iv: 13 }, 4);
  const span = { from: sessions[0].date, to: sessions[sessions.length - 1].date };
  const { windows } = rollingWindows(span, 28, 14);
  assert.ok(windows.length >= 4, String(windows.length));
  const compute = freshCompute();
  for (const p of [{ strategy: 'straddle' }, labStrategy('iron_condor')!.toRunParams(labStrategy('iron_condor')!.defaults, { series: 'WEEK' })]) {
    const whole = compute.run(p as any, sessions); // the run on screen
    const out = await A.runRolling({ params: p, windows, options: { capital: 500000 } }, runnerFor(compute, sessions));
    assert.equal(out.rows.length, windows.length);
    for (const [i, w] of windows.entries()) {
      const direct = freshCompute().run(p as any, sessions.filter((s: any) => s.date >= w.from && s.date <= w.to));
      assert.ok(Math.abs(out.rows[i].net - direct.net) < 0.01, `${(p as any).strategy} window ${i}: ${out.rows[i].net} vs ${direct.net}`);
      assert.equal(out.rows[i].sessions, direct.days.length);
    }
    // the windows did not replace the latest run (replay and exports read it)
    assert.equal(compute.lastRun().sessions.length, sessions.length);
    assert.equal(whole.days.length, sessions.length);
    const nets = out.rows.filter((r: any) => r.traded > 0).map((r: any) => r.net);
    assert.equal(out.summary.windows, windows.length);
    assert.equal(out.summary.positive, nets.filter((x: number) => x > 0).length);
    assert.equal(out.summary.best, Math.max(...nets));
  }
});

test('a window with no stored sessions is reported as empty; cancel stops before the next window', async () => {
  const sessions = E.syntheticCalendar(20, { iv: 13 }, 1);
  const compute = freshCompute();
  const windows = [{ from: '2000-01-01', to: '2000-01-31' }, { from: sessions[0].date, to: sessions[9].date }];
  const out = await A.runRolling({ params: { strategy: 'straddle' }, windows }, runnerFor(compute, sessions));
  assert.deepEqual([out.rows[0].sessions, out.rows[0].net], [0, null]);
  assert.ok(out.rows[1].sessions > 0);
  let seen = 0;
  const progress: number[] = [];
  await assert.rejects(A.runRolling({ params: { strategy: 'straddle' }, windows: [windows[1], windows[1], windows[1]] }, runnerFor(compute, sessions),
    { cancelled: () => seen >= 1, progress: (p: any) => { progress.push(p.done); if (p.done >= 1) seen = 1; } }), /cancelled/);
  assert.deepEqual(progress, [0, 1]);
});

const dir = process.env.DAYFILES;
test('real data, 1 Apr–30 Jul 2026 in 30-day windows: four windows, each its own backtest', { skip: !dir && 'set DAYFILES to a folder of day files' }, async () => {
  const sessions = loadDayFiles(dir!, REAL_RANGE);
  const plan = rollingWindows({ from: '2026-04-01', to: '2026-07-30' }, 30, 30);
  assert.deepEqual(plan.windows, [{ from: '2026-04-01', to: '2026-04-30' }, { from: '2026-05-01', to: '2026-05-30' }, { from: '2026-05-31', to: '2026-06-29' }, { from: '2026-06-30', to: '2026-07-29' }]);
  assert.equal(plan.leftover, 1);
  const compute = freshCompute();
  const out = await A.runRolling({ params: { strategy: 'straddle' }, windows: plan.windows }, runnerFor(compute, sessions));
  for (const [i, w] of plan.windows.entries()) {
    const direct = freshCompute().run({ strategy: 'straddle' }, sessions.filter((s: any) => s.date >= w.from && s.date <= w.to));
    assert.ok(Math.abs(out.rows[i].net - direct.net) < 0.01, `window ${i}`);
  }
  assert.equal(out.rows.reduce((a: number, r: any) => a + r.sessions, 0), sessions.filter((s: any) => s.date <= '2026-07-29').length);
});
