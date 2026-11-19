// DateRange (docs/ENGINE_INTERFACES.md §5): one object for calendar, run, progress and report.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDateRange, presetRange, boundsOf, loadCommand, todayIST, weekdayOf, type InventoryDay } from '../lib/dateRange.ts';

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
  assert.deepEqual(boundsOf(prod), { floor: '2023-01-01', earliest: '2025-10-06', latest_validated: '2025-10-17', latest_any: '2025-10-17' });
  const r = buildDateRange({ from: '2025-10-13', to: '2026-01-31' }, prod, [], { today });
  assert.deepEqual(r.effective, { from: '2025-10-13', to: '2025-10-17' });
  assert.ok(r.messages.some((m) => /latest stored day is 2025-10-17/.test(m.text)));
  assert.equal(r.counts.runnable, 5);
  assert.equal(loadCommand(r), 'straddloop load --expiry WEEK --start 2025-10-13 --end 2026-01-31');
});

test('the floor is 1 Jan 2023: earlier starts are moved, weekdays before the first stored day are missing, weekends never are', () => {
  const r = buildDateRange({ from: '2022-06-01', to: '2025-10-10' }, prod, [], { today });
  assert.equal(r.effective!.from, '2023-01-01');
  assert.equal(r.counts.runnable, 5);
  assert.equal(r.days.find((d) => d.date === '2023-01-07')!.state, 'weekend');
  assert.equal(r.days.find((d) => d.date === '2024-06-03')!.state, 'missing');
  assert.equal(r.counts.weekend + r.counts.weekdays, r.counts.calendar);
  assert.ok(loadCommand(r)!.includes('--start 2023-01-01'));
});

test('holidays: pipeline status wins; the unverified NSE list labels only weekdays without a file; a stored file is never a holiday', () => {
  const inv = prod.concat([{ trade_date: '2025-10-21', path: 'NIFTY/WEEK/2025-10-21.json.gz', quality: 'complete', index_bars: 375, expiry: '2025-10-21', lot_size: 75 }]);
  const r = buildDateRange({ from: '2025-10-01', to: '2025-10-22' }, inv, [{ trade_date: '2025-10-03', status: 'holiday', reason: 'both feeds empty' }], { today });
  const at = (d: string) => r.days.find((x) => x.date === d)!;
  assert.equal(at('2025-10-02').state, 'holiday'); assert.equal(at('2025-10-02').holiday!.source, 'nse_list_unverified');
  assert.equal(at('2025-10-03').state, 'holiday'); assert.equal(at('2025-10-03').holiday!.source, 'pipeline');
  assert.equal(at('2025-10-21').state, 'validated'); // on the list, but a file exists: the file wins
  assert.equal(at('2025-10-01').state, 'missing');
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
  assert.match(e('2024-01-01', '2024-01-10'), /None of these dates have a stored day file/);
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
