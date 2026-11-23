// Golden results: every engine, on fixed inputs, must produce exactly what it produced before a refactor
// (tests/golden.json, recorded by scripts/golden.mts). A change that is MEANT to move results re-records the
// file in the same commit and says why. The real-data check runs when DAYFILES points at the day files the
// golden was recorded on (`straddloop export-days --expiry WEEK --start 2026-04-01 --end 2026-07-30`).
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fingerprints, realFingerprints } from './helpers/golden.mts';

const read = (name: string) => JSON.parse(readFileSync(new URL(name, import.meta.url), 'utf8'));

test('every engine reproduces its golden results on the synthetic model (Strategy 01, ORB, EMA, four-leg, all templates)', () => {
  const want = read('./golden.json'), got = fingerprints();
  assert.deepEqual(Object.keys(got).sort(), Object.keys(want).sort());
  for (const k of Object.keys(want)) assert.deepEqual(got[k], want[k], k);
});

test('real day files reproduce their golden results', { skip: !process.env.DAYFILES || !existsSync(new URL('./golden.real.json', import.meta.url)) ? 'set DAYFILES to run' : false }, () => {
  const want = read('./golden.real.json'), got = realFingerprints(process.env.DAYFILES!);
  assert.equal(got.sessions, want.sessions, 'DAYFILES holds a different set of days than the golden was recorded on');
  for (const k of Object.keys(want)) assert.deepEqual(got[k], want[k], k);
});
