// DateRange (docs/ENGINE_INTERFACES.md §5): one object for calendar, run, progress and report.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDateRange, presetRange, boundsOf, loadCommand, todayIST, weekdayOf, windowLength, shiftRange, nextWindow, prevWindow, fitWindow, lastN, rollingWindows, MAX_WINDOWS, type InventoryDay } from '../lib/dateRange.ts';

// Production inventory on 19 Nov 2026 (public.market_days, NIFTY WEEK), as read from Supabase.
const prod: InventoryDay[] = [
  ['2025-10-06', 'gaps:1', 374, '2025-10-07'], ['2025-10-07', 'complete', 375, '2025-10-07'], ['2025-10-08', 'complete', 375, '2025-10-14'],
  ['2025-10-09', 'complete', 375, '2025-10-14'], ['2025-10-10', 'complete', 375, '2025-10-14'], ['2025-10-13', 'complete', 375, '2025-10-14'],
  ['2025-10-14', 'complete', 375, '2025-10-14'], ['2025-10-15', 'complete', 375, '2025-10-21'], ['2025-10-16', 'complete', 375, '2025-10-21'],
  ['2025-10-17', 'complete', 375, '2025-10-21'],
].map(([d, q, ib, ex]) => ({ trade_date: d as string, path: `NIFTY/WEEK/${d}.json.gz`, quality: q as string, index_bars: ib as number, expiry: ex as string, lot_size: 75, sha256: `h${d}` }));
const today = '2026-11-19';

test('the screenshot range: 6-8 Oct 2025 is 3 runnable days, and 6 Oct is partial with both gaps named', () => {
  const r = buildDateRange({ from: '2025-10-06', to: '2025-10-08' }, prod, [], { today });
  assert.deepEqual(r.messages.filter((m) => m.level === 'error'), []);
  assert.equal(r.counts.runnable, 3);
  assert.deepEqual(r.runnable, ['2025-10-06', '2025-10-07', '2025-10-08']);
  assert.deepEqual(r.files.map((f) => f.path), r.runnable.map((d) => `NIFTY/WEEK/${d}.json.gz`));
  assert.equal(r.days[0].state, 'partial');
  assert.equal(r.days[0].reason, 'option series missing 1 bar; index has 374 of 375 bars');
  assert.equal(r.counts.validated, 2); assert.equal(r.counts.partial, 1);
  assert.equal(r.days[1].is_expiry, true); // 7 Oct is the stored weekly expiry
  assert.equal(r.days[2].is_expiry, false);
});

test('bounds come from the data, never hardcoded; the end is clamped to the latest stored day and says so', () => {
  assert.deepEqual(boundsOf(prod), { floor: '2025-10-06', earliest: '2025-10-06', latest_validated: '2025-10-17', latest_any: '2025-10-17' });
  const r = buildDateRange({ from: '2025-10-13', to: '2026-01-31' }, prod, [], { today });
  assert.deepEqual(r.effective, { from: '2025-10-13', to: '2025-10-17' });
  assert.ok(r.messages.some((m) => /latest stored day is 2025-10-17/.test(m.text)));
  assert.equal(r.counts.runnable, 5);
  assert.equal(loadCommand(r), 'straddloop load --expiry WEEK --start 2025-10-13 --end 2026-01-31');
});

test('history starts on the first stored day: earlier starts move there and say so; the load command still reaches back', () => {
  const r = buildDateRange({ from: '2022-06-01', to: '2025-10-10' }, prod, [], { today });
  assert.equal(r.effective!.from, '2025-10-06');
  assert.ok(r.messages.some((m) => /History starts on 2025-10-06; the start was moved there/.test(m.text)));
  assert.equal(r.counts.runnable, 5);
  assert.equal(r.counts.weekend + r.counts.weekdays, r.counts.calendar);
  // the days before the stored history are what may need loading, so the command asks for them (not before 1 Jul 2020)
  assert.ok(loadCommand(r)!.includes('--start 2022-06-01'));
  assert.ok(loadCommand(buildDateRange({ from: '2019-01-01', to: '2025-10-10' }, prod, [], { today }))!.includes('--start 2020-07-01'));
  // inside the stored history a weekday with no file is missing; a weekend never is
  const g = buildDateRange({ from: '2025-10-06', to: '2025-10-12' }, prod.filter((d) => d.trade_date !== '2025-10-09'), [], { today });
  assert.equal(g.days.find((d) => d.date === '2025-10-09')!.state, 'missing');
  assert.equal(g.days.find((d) => d.date === '2025-10-11')!.state, 'weekend');
});

test('holidays: pipeline status wins; the unverified NSE list labels only weekdays without a file; a stored file is never a holiday', () => {
  const day = (d: string) => ({ trade_date: d, path: `NIFTY/WEEK/${d}.json.gz`, quality: 'complete', index_bars: 375, expiry: '2025-10-07', lot_size: 75 });
  const inv = [day('2025-10-01'), ...prod, { ...day('2025-10-21'), expiry: '2025-10-21' }];
  const r = buildDateRange({ from: '2025-10-01', to: '2025-10-22' }, inv, [{ trade_date: '2025-10-03', status: 'holiday', reason: 'both feeds empty' }], { today });
  const at = (d: string) => r.days.find((x) => x.date === d)!;
  assert.equal(at('2025-10-02').state, 'holiday'); assert.equal(at('2025-10-02').holiday!.source, 'nse_list_unverified');
  assert.equal(at('2025-10-03').state, 'holiday'); assert.equal(at('2025-10-03').holiday!.source, 'pipeline');
  assert.equal(at('2025-10-21').state, 'validated'); // on the list, but a file exists: the file wins
  assert.equal(at('2025-10-20').state, 'missing');   // a weekday inside the history, not on the list, no file
  assert.equal(r.effective!.to, '2025-10-21'); // latest stored day
});

test('statuses from the ingestion ledger: failed and downloading never run; a validated status without a file is missing', () => {
  const st = [{ trade_date: '2025-10-08', status: 'failed' as const, reason: 'options empty' }, { trade_date: '2025-10-20', status: 'validated' as const, reason: null },
    { trade_date: '2025-10-09', status: 'downloading' as const, reason: null }];
  const r = buildDateRange({ from: '2025-10-06', to: '2025-10-17' }, prod, st, { today });
  assert.equal(r.days.find((d) => d.date === '2025-10-08')!.state, 'failed');
  assert.equal(r.days.find((d) => d.date === '2025-10-09')!.state, 'downloading');
  assert.ok(!r.runnable.includes('2025-10-08') && !r.runnable.includes('2025-10-09'));
  assert.equal(r.counts.runnable, 8);
});

test('errors: empty, malformed, impossible, reversed, nothing stored', () => {
  const e = (from: string, to: string, inv = prod) => buildDateRange({ from, to }, inv, [], { today }).messages.filter((m) => m.level === 'error').map((m) => m.text)[0];
  assert.match(e('', '2025-10-10'), /both a start date/);
  assert.match(e('2025-13-01', '2025-10-10'), /not a valid date/);
  assert.match(e('2025-02-30', '2025-03-06'), /not a valid date/);
  assert.match(e('2025-10-10', '2025-10-06'), /after the end date/);
  assert.match(e('2024-01-01', '2024-01-10'), /Stored history starts on 2025-10-06; nothing is stored before it/);
  assert.match(e('2025-10-11', '2025-10-12'), /None of these dates have a stored day file/);
  assert.match(e('2025-10-06', '2025-10-10', []), /No days are stored/);
  assert.match(e('2026-01-01', '2026-02-01'), /Nothing is stored after 2025-10-17/);
});

test('the key changes when the data behind the range changes, not otherwise', () => {
  const a = buildDateRange({ from: '2025-10-06', to: '2025-10-10' }, prod, [], { today });
  const b = buildDateRange({ from: '2025-10-04', to: '2025-10-10' }, prod, [], { today }); // adds only a weekend
  const changed = prod.map((d) => (d.trade_date === '2025-10-07' ? { ...d, sha256: 'other' } : d));
  const c = buildDateRange({ from: '2025-10-06', to: '2025-10-10' }, changed, [], { today });
  assert.equal(a.key, b.key); assert.notEqual(a.key, c.key);
});

test('presets count stored days backwards from the latest stored day', () => {
  assert.deepEqual(presetRange('last_7', prod), { from: '2025-10-09', to: '2025-10-17' });
  assert.deepEqual(presetRange('last_30', prod), { from: '2025-10-06', to: '2025-10-17' });
  assert.deepEqual(presetRange('max', prod), { from: '2025-10-06', to: '2025-10-17' });
  assert.deepEqual(presetRange('6m', prod), { from: '2025-10-06', to: '2025-10-17' }); // clamped to the earliest stored day
  const long = Array.from({ length: 800 }, (_, i) => new Date(Date.UTC(2023, 0, 2) + i * 86400000).toISOString().slice(0, 10))
    .filter((d) => weekdayOf(d) < 5).map((d) => ({ trade_date: d, path: d, quality: 'complete' }));
  const last = long[long.length - 1].trade_date;
  assert.equal(presetRange('1y', long)!.to, last);
  assert.equal(presetRange('1y', long)!.from, '2024-03-12'); // last = 2025-03-11, so the day after 2024-03-11
  assert.equal(presetRange('last_90', long)!.from, long[long.length - 90].trade_date);
  assert.equal(presetRange('max', []), null);
});

test('local files are runnable but never called validated; today is the IST date', () => {
  const r = buildDateRange({ from: '2025-10-06', to: '2025-10-07' }, [{ trade_date: '2025-10-06', path: 'local/a', quality: 'local' }, { trade_date: '2025-10-07', path: 'local/b', quality: 'local' }], [], { source: 'local', today });
  assert.equal(r.counts.runnable, 2); assert.equal(r.counts.validated, 0); assert.equal(r.counts.partial, 2);
  assert.equal(loadCommand(r), null);
  assert.equal(todayIST(Date.parse('2026-11-19T19:00:00Z')), '2026-11-20'); // 00:30 IST next day
});

// ------------------------------------------------------------------ moving through history

const APR_JUL = { from: '2026-04-01', to: '2026-07-30' };

test('windows keep their length: 1 Apr–30 Jul 2026 is 121 days; next is 31 Jul–28 Nov 2026, previous 1 Dec 2025–31 Mar 2026', () => {
  assert.equal(windowLength(APR_JUL), 121);
  assert.deepEqual(nextWindow(APR_JUL), { from: '2026-07-31', to: '2026-11-28' });
  assert.deepEqual(prevWindow(APR_JUL), { from: '2025-12-01', to: '2026-03-31' });
  assert.equal(windowLength(prevWindow(APR_JUL)), 121);
  assert.deepEqual(prevWindow(nextWindow(APR_JUL)), APR_JUL);
  assert.deepEqual(nextWindow(prevWindow(APR_JUL)), APR_JUL);
  // +30 / +60 / +90 days, same length
  assert.deepEqual(shiftRange(APR_JUL, 30), { from: '2026-05-01', to: '2026-08-29' });
  assert.deepEqual(shiftRange(APR_JUL, 60), { from: '2026-05-31', to: '2026-09-28' });
  assert.deepEqual(shiftRange(APR_JUL, 90), { from: '2026-06-30', to: '2026-10-28' });
  assert.deepEqual(shiftRange(APR_JUL, -30), { from: '2026-03-02', to: '2026-06-30' });
  // an explicit length: after a window was cut short, moving back restores the length that was asked for
  assert.deepEqual(prevWindow({ from: '2026-07-31', to: '2026-10-30' }, 121), APR_JUL);
});

test('leap years, month ends and year ends: the arithmetic is on calendar days', () => {
  assert.equal(windowLength({ from: '2024-02-01', to: '2024-02-29' }), 29);
  assert.deepEqual(nextWindow({ from: '2024-02-01', to: '2024-02-29' }), { from: '2024-03-01', to: '2024-03-29' });
  assert.equal(windowLength({ from: '2025-02-01', to: '2025-02-28' }), 28);
  assert.deepEqual(nextWindow({ from: '2025-02-01', to: '2025-02-28' }), { from: '2025-03-01', to: '2025-03-28' });
  assert.equal(windowLength({ from: '2023-03-01', to: '2024-02-29' }), 366);
  assert.deepEqual(shiftRange({ from: '2024-02-29', to: '2024-02-29' }, 365), { from: '2025-02-28', to: '2025-02-28' });
  assert.deepEqual(shiftRange({ from: '2024-02-29', to: '2024-02-29' }, 366), { from: '2025-03-01', to: '2025-03-01' });
  assert.deepEqual(nextWindow({ from: '2025-12-01', to: '2025-12-31' }), { from: '2026-01-01', to: '2026-01-31' });
  assert.deepEqual(prevWindow({ from: '2024-03-01', to: '2024-03-31' }), { from: '2024-01-30', to: '2024-02-29' });
  // a window that starts on a weekend is a calendar window: the sessions inside it come from the data
  const sat = buildDateRange({ from: '2025-10-11', to: '2025-10-17' }, prod, [], { today });
  assert.deepEqual(sat.runnable, ['2025-10-13', '2025-10-14', '2025-10-15', '2025-10-16', '2025-10-17']);
});

test('fitting to the stored history: a window is cut at an end and says how much; nothing is left when it is all outside', () => {
  const b = { earliest: '2021-12-01', latest_any: '2026-10-30' };
  assert.deepEqual(fitWindow(APR_JUL, b), { range: APR_JUL, cut: null, kept: 121, asked: 121, outside: null });
  // the user's next window runs past the last stored day (30 Oct 2026): 92 of its 121 days are stored
  assert.deepEqual(fitWindow(nextWindow(APR_JUL), b), { range: { from: '2026-07-31', to: '2026-10-30' }, cut: 'end', kept: 92, asked: 121, outside: null });
  assert.deepEqual(fitWindow({ from: '2021-10-01', to: '2021-12-10' }, b), { range: { from: '2021-12-01', to: '2021-12-10' }, cut: 'start', kept: 10, asked: 71, outside: null });
  assert.equal(fitWindow({ from: '2021-01-01', to: '2026-12-31' }, b).cut, 'both');
  assert.deepEqual(fitWindow({ from: '2026-11-01', to: '2026-12-01' }, b).outside, 'after');
  assert.deepEqual(fitWindow({ from: '2021-01-01', to: '2021-06-01' }, b).outside, 'before');
  assert.equal(fitWindow(APR_JUL, { earliest: null, latest_any: null }).range, null);
});

test('last N sessions or last N calendar days, ending on the latest stored day; the 60-session preset', () => {
  assert.deepEqual(lastN(7, 'sessions', prod), { from: '2025-10-09', to: '2025-10-17' });
  assert.deepEqual(lastN(7, 'days', prod), { from: '2025-10-11', to: '2025-10-17' });
  assert.deepEqual(lastN(100, 'days', prod), { from: '2025-10-06', to: '2025-10-17' }); // cut to the first stored day
  assert.deepEqual(lastN(100, 'sessions', prod), { from: '2025-10-06', to: '2025-10-17' });
  assert.equal(lastN(0, 'days', prod), null);
  assert.equal(lastN(5, 'days', []), null);
  const long = Array.from({ length: 800 }, (_, i) => new Date(Date.UTC(2023, 0, 2) + i * 86400000).toISOString().slice(0, 10))
    .filter((d) => weekdayOf(d) < 5).map((d) => ({ trade_date: d, path: d, quality: 'complete' }));
  assert.equal(presetRange('last_60', long)!.from, long[long.length - 60].trade_date);
  assert.deepEqual(presetRange('last_60', prod), { from: '2025-10-06', to: '2025-10-17' });
});

test('rolling windows: whole windows of W days every S days; what is left over and the cap are reported', () => {
  const year = { from: '2025-01-01', to: '2025-12-31' };
  const r = rollingWindows(year, 120, 30);
  assert.equal(r.windows.length, 9);
  assert.deepEqual(r.windows[0], { from: '2025-01-01', to: '2025-04-30' });
  assert.deepEqual(r.windows[1], { from: '2025-01-31', to: '2025-05-30' });
  assert.deepEqual(r.windows[8], { from: '2025-08-29', to: '2025-12-26' });
  assert.ok(r.windows.every((w) => windowLength(w) === 120));
  assert.equal(r.leftover, 5); // 27–31 Dec: no window reaches them
  assert.equal(r.capped, false);
  // non-overlapping when the step equals the window
  const q = rollingWindows(year, 91, 91);
  assert.deepEqual(q.windows.map((w) => w.from), ['2025-01-01', '2025-04-02', '2025-07-02', '2025-10-01']);
  // a window longer than the span: none, and all of it is left over
  assert.deepEqual(rollingWindows({ from: '2025-01-01', to: '2025-03-31' }, 120, 30), { windows: [], leftover: 90, capped: false });
  // more than the cap: stopped there and said so
  const many = rollingWindows({ from: '2020-01-01', to: '2025-12-31' }, 1, 1);
  assert.equal(many.windows.length, MAX_WINDOWS); assert.equal(many.capped, true);
  for (const bad of [[0, 30], [120, 0], [Number.NaN, 30]]) assert.deepEqual(rollingWindows(year, bad[0], bad[1]).windows, []);
  assert.deepEqual(rollingWindows({ from: '2025-12-31', to: '2025-01-01' }, 30, 30).windows, []);
});
