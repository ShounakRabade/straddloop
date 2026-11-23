// The rules behind the Lab's time picker (lib/sessionTime.ts) and stop/target controls (lib/levels.ts).
import test from 'node:test';
import assert from 'node:assert/strict';
import { digitPrefix, intervalsFor, parseTyped, sequenceProblems, snapTo, stepTime, timeList, timeProblem, toHM, toMin } from '../lib/sessionTime.ts';
import { LEVEL_BOUNDS, clampLevel, fmtLevel, fromSlider, isLog, toSlider } from '../lib/levels.ts';

const S1_ENTRY = { min: toMin('09:50')!, max: toMin('15:00')!, grain: 5 };
const ANY = { min: toMin('09:16')!, max: toMin('15:29')!, grain: 1 };

test('typed times are read generously, and only real times are accepted', () => {
  for (const [s, want] of [['9:30', '09:30'], ['09.30', '09:30'], ['930', '09:30'], ['0930', '09:30'], ['1530', '15:30'], ['15 05', '15:05'], ['9', '09:00']] as const) assert.equal(toHM(parseTyped(s)!), want, s);
  for (const s of ['', 'ten', '25:00', '9:75', '12345']) assert.equal(parseTyped(s), null, s);
  assert.equal(toMin('9:30'), null); // the stored form is strict HH:MM
  assert.deepEqual(['9', '1', '93', '093', '103', '930', '10:3', '1530'].map(digitPrefix), ['09', '1', '093', '093', '103', '0930', '103', '1530']);
});

test('bounds and grain: Strategy 01 enters on the 5-minute candle grid from 09:50; the builder any minute', () => {
  assert.equal(timeProblem(toMin('09:50'), S1_ENTRY), null);
  assert.match(timeProblem(toMin('09:52'), S1_ENTRY)!, /5-minute candle grid/);
  assert.match(timeProblem(toMin('09:45'), S1_ENTRY)!, /Between 09:50 and 15:00/);
  assert.match(timeProblem(null, S1_ENTRY)!, /Not a time/);
  assert.equal(timeProblem(toMin('09:52'), ANY), null);
  // snapping: nearest allowed minute, ties later, inside the bounds
  assert.deepEqual(['09:52', '09:53', '09:40', '15:20'].map((s) => toHM(snapTo(toMin(s)!, S1_ENTRY))), ['09:50', '09:55', '09:50', '15:00']);
  // a 5-minute field offers 5, 15 and 30-minute steps, never 1
  assert.deepEqual(intervalsFor(5), [5, 15, 30]);
  assert.deepEqual(intervalsFor(1), [1, 5, 15, 30]);
});

test('the list and the steppers move on the clock grid and keep the current value visible', () => {
  const l15 = timeList(S1_ENTRY, 15).map(toHM);
  assert.deepEqual(l15.slice(0, 4), ['10:00', '10:15', '10:30', '10:45']);
  assert.equal(l15.at(-1), '15:00');
  assert.ok(timeList(S1_ENTRY, 15, toMin('09:50')).map(toHM).includes('09:50'), 'the current 09:50 is listed even off the 15-minute grid');
  assert.equal(timeList(ANY, 1).length, 15 * 60 + 29 - (9 * 60 + 16) + 1);
  assert.equal(timeList(ANY, 30).map(toHM)[0], '09:30');
  // steppers: to the next grid point of the interval, never past the bounds
  assert.equal(toHM(stepTime(toMin('09:50')!, 1, S1_ENTRY, 15)), '10:00');
  assert.equal(toHM(stepTime(toMin('10:00')!, -1, S1_ENTRY, 15)), '09:50');
  assert.equal(toHM(stepTime(toMin('09:20')!, 1, ANY, 1)), '09:21');
  assert.equal(toHM(stepTime(toMin('15:29')!, 1, ANY, 5)), '15:29');
});

test('order: entry before square-off; last new entry not after it; a last entry before the entry is only a note', () => {
  const f = (entry: string | null, last: string | null, exit: string | null) => [
    ...(entry ? [{ key: 'e', role: 'entry' as const, value: toMin(entry) }] : []),
    ...(last ? [{ key: 'l', role: 'last_entry' as const, value: toMin(last) }] : []),
    ...(exit ? [{ key: 'x', role: 'exit' as const, value: toMin(exit) }] : []),
  ];
  assert.deepEqual(sequenceProblems(f('09:50', '14:30', '15:15')), []);
  assert.deepEqual(sequenceProblems(f('15:20', '14:30', '15:15')).map((p) => [p.key, p.level]), [['e', 'error'], ['l', 'note']]);
  assert.deepEqual(sequenceProblems(f('09:50', '15:20', '15:15')).map((p) => [p.key, p.level]), [['l', 'error']]);
  assert.match(sequenceProblems(f('09:50', '15:20', '15:15'))[0].text, /after the square-off at 15:15/);
  // held overnight, the square-off is on a later day: entry after it is fine
  assert.deepEqual(sequenceProblems(f('15:20', null, '15:15'), false), []);
  // ORB has no entry time: only last entry vs square-off
  assert.deepEqual(sequenceProblems(f(null, '15:20', '15:15')).map((p) => p.key), ['l']);
});

test('levels: bounds follow what a leg can lose; values snap to the step and stay inside', () => {
  // a short leg's stop can be far above 100%; a long leg's stays below it (the engine refuses 100% or more)
  assert.equal(LEVEL_BOUNDS.short_stop.pct!.max, 500);
  assert.ok(LEVEL_BOUNDS.long_stop.pct!.max < 100 && LEVEL_BOUNDS.short_target.pct!.max < 100);
  assert.equal(clampLevel(37.4, LEVEL_BOUNDS.short_stop.pct!), 37);
  assert.equal(clampLevel(9999, LEVEL_BOUNDS.short_stop.pct!), 500);
  assert.equal(clampLevel(1234, LEVEL_BOUNDS.position_target.rupees_per_lot!), 1250);
  assert.equal(clampLevel(NaN, LEVEL_BOUNDS.short_stop.pct!), 5);
  assert.deepEqual([fmtLevel('pct', 36), fmtLevel('rupees', 150000), fmtLevel('rupees_per_lot', 1500), fmtLevel('points', 12.5), fmtLevel('pct_premium', 40)],
    ['36%', '₹1,50,000', '₹1,500/lot', '12.5 pts', '40% of premium']);
});

test('the slider is logarithmic over wide ranges, reaches both ends, and round-trips', () => {
  const r = LEVEL_BOUNDS.position_target.rupees!; // ₹100 to ₹10,00,000
  assert.ok(isLog(r));
  assert.equal(fromSlider(0, r), 100);
  assert.equal(fromSlider(1000, r), 1000000);
  // the middle of the slider is the geometric middle (₹10,000), not ₹5,00,000
  assert.equal(fromSlider(500, r), 10000);
  // slider values are two significant figures: ₹37,350 is not a slider stop, ₹37,000 is
  for (const v of [100, 1500, 37000, 250000]) assert.equal(fromSlider(toSlider(v, r), r), v, String(v));
  const pct = LEVEL_BOUNDS.long_stop.pct!; // 5–95%: not wide enough to need a log scale
  assert.ok(!isLog(pct));
  assert.equal(fromSlider(500, pct), 50);
});
