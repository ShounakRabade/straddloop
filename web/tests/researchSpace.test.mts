import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { PARAM_SPACE, ENGINE_DEFAULTS, ENGINE_ONLY_KEYS, parseValues } from '../lib/researchSpace.ts';

const require = createRequire(import.meta.url);
const A = require('../public/engine/analytics.js');

test('the optimisation lab form searches exactly what the engine searches', () => {
  assert.deepEqual(PARAM_SPACE, A.PARAM_SPACE);
});

test('every engine-only setting has a default, and the default is inside its range or options', () => {
  for (const p of [...PARAM_SPACE.straddle, ...PARAM_SPACE.orb].filter((x) => x.engine)) {
    assert.ok(p.key in ENGINE_DEFAULTS, p.key);
    const d = ENGINE_DEFAULTS[p.key];
    if (p.kind === 'choice') assert.ok(p.options!.includes(d), `${p.key} default ${d} not an option`);
    else if (p.key !== 'max_or_width_pct') assert.ok((d as number) >= p.min! && (d as number) <= p.max!, `${p.key} default ${d}`);
  }
  assert.ok(ENGINE_ONLY_KEYS.includes('exit_time') && !ENGINE_ONLY_KEYS.includes('sl_pct'));
});

test('typed values are parsed, sorted and range-checked, and bad entries are reported', () => {
  const sl = PARAM_SPACE.straddle.find((p) => p.key === 'sl_pct')!;
  assert.deepEqual(parseValues(sl, '40, 25,30, 25'), { values: [25, 30, 40], errors: [] });
  const bad = parseValues(sl, '10, x, 30, 90');
  assert.deepEqual(bad.values, [30]);
  assert.equal(bad.errors.length, 3);
  const re = PARAM_SPACE.straddle.find((p) => p.key === 'reentry_enabled')!;
  assert.deepEqual(parseValues(re, 'on, Off').values, [true, false]);
  const w = PARAM_SPACE.straddle.find((p) => p.key === 'max_or_width_pct')!;
  assert.deepEqual(parseValues(w, '0.5, 100').values, [0.5, 100]); // 100 = filter off
});
