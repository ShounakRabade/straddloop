import test from 'node:test';
import assert from 'node:assert/strict';
import { checkRange, dayState } from '../lib/range.ts';

const days = [['2025-10-06', 'complete'], ['2025-10-07', 'complete'], ['2025-10-08', 'gaps:12'], ['2025-10-09', 'empty'], ['2025-10-10', 'complete'], ['2025-10-14', 'complete']]
  .map(([trade_date, quality]) => ({ trade_date, quality }));

test('valid range: counts stored, validated, gaps, failed, and lists missing weekdays', () => {
  const r = checkRange('2025-10-06', '2025-10-14', days, '2026-01-01');
  assert.deepEqual(r.errors, []);
  assert.equal(r.counts.weekdays, 7); // 6,7,8,9,10,13,14
  assert.equal(r.counts.stored, 6); assert.deepEqual(r.notStored, ['2025-10-13']);
  assert.equal(r.counts.validated, 4); assert.equal(r.counts.gaps, 1); assert.equal(r.counts.failed, 1);
  assert.ok(r.notes.some((n) => /no stored data/.test(n)));
});
test('weekends are not counted as missing', () => {
  const r = checkRange('2025-10-10', '2025-10-14', days, '2026-01-01');
  assert.equal(r.counts.weekdays, 3); assert.deepEqual(r.notStored, ['2025-10-13']);
});
test('rejects empty, reversed, malformed, impossible and future dates with a plain message', () => {
  assert.match(checkRange('', '2025-10-14', days).errors[0], /both a start date/);
  assert.match(checkRange('2025-10-14', '2025-10-06', days).errors[0], /after the end date/);
  assert.match(checkRange('2025-13-01', '2025-10-06', days).errors[0], /not a valid date/);
  assert.match(checkRange('2025-02-30', '2025-03-06', days).errors[0], /not a valid date/);
  assert.match(checkRange('2027-01-01', '2027-02-01', days, '2026-11-19').errors[0], /future/);
  assert.match(checkRange('2018-01-01', '2025-10-06', days, '2026-11-19').errors[0], /longer than six years/);
});
test('a range with no stored day is an error that says what to do; an end date past today is cut back', () => {
  assert.match(checkRange('2024-01-01', '2024-01-10', days, '2026-11-19').errors[0], /None of these dates are stored/);
  const r = checkRange('2025-10-06', '2099-01-01', days, '2025-10-14');
  assert.ok(r.notes.some((n) => /cut back to today/.test(n)));
});
test('outside-of-store parts are measured', () => {
  const r = checkRange('2025-10-01', '2025-10-20', days, '2026-01-01');
  assert.equal(r.outside.before, 3); // 1,2,3 Oct weekdays before the first stored day (Oct 6)? 1,2,3
  assert.ok(r.outside.after >= 4);
});
test('day states', () => { assert.equal(dayState('complete'), 'validated'); assert.equal(dayState('gaps:3'), 'gaps'); assert.equal(dayState('empty'), 'failed'); });
