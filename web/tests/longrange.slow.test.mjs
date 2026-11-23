// A long synthetic range through every engine, the leg engine and a small optimisation study, in one process.
// Slow (the synthetic calendar takes ~30 s to generate for 1,500 sessions), so it is not part of npm test. Run it with:
//   npm run test:long
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const L = require('../public/engine/ledger.js');
const E = require('../public/engine/engine.js');
const F = require('../public/engine/fourleg_engine.js');
const G = require('../public/engine/legs.js');
const A = require('../public/engine/analytics.js');
const makeCompute = require('../public/engine/compute.js');

test('1,500 synthetic sessions through every engine, the leg engine and a small optimisation study', async () => {
  const p = { days: 1500, seed: 3 };
  const compute = makeCompute(E, F, L, G); // one instance, so the calendar is generated once
  for (const strategy of ['straddle', 'orb', 'ema_pullback']) {
    const r = compute.run({ strategy, ...p });
    assert.equal(r.days.length, 1500, strategy);
    assert.ok(Number.isFinite(r.net), strategy);
  }
  const spec = { v: 1, name: 'short strangle', template: 'short_strangle', underlying: 'NIFTY', lots: 1,
    legs: [{ id: 'L1', action: 'SELL', right: 'CE', ratio: 1, expiry: { series: 'WEEK', nth: 1 }, strike: { by: 'atm', steps: 2 }, stop: { kind: 'pct', value: 40 } },
      { id: 'L2', action: 'SELL', right: 'PE', ratio: 1, expiry: { series: 'WEEK', nth: 1 }, strike: { by: 'atm', steps: 2 }, stop: { kind: 'pct', value: 40 } }],
    entry: { time: '09:20', weekdays: [0, 1, 2, 3, 4], conditions: [] }, exit: { hold: 'intraday', time: '15:15', settle_at_expiry: true, basis: 'net' },
    adjust: { on_leg_stop: 'keep_others', max_reentries: 0, cutoff: '14:30' } };
  const legs = compute.run({ strategy: 'legs', spec, ...p });
  assert.equal(legs.days.length, 1500);
  assert.ok(legs.account.report.reconciliation.ok);
  const fl = compute.run({ strategy: 'fourleg', months: 36 });
  assert.ok(Number.isFinite(fl.net));

  compute.run({ strategy: 'straddle', ...p });
  const snap = compute.lastRun();
  const study = await A.runOptimisation({ base: snap.params, axes: [{ key: 'sl_pct', values: [30, 36, 45] }], options: { budget: 10, mcPaths: 200 } },
    (q) => A.fromRun(compute.evaluate(q, snap.sessions)));
  assert.equal(study.sessions, 1500);
  assert.ok(study.configs_tested >= 3);
});
