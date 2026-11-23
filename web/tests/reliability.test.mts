// Reliability: the decoder's memory form and checksum, engines that never change the sessions they read (the Lab
// worker reuses decoded sessions across runs), same inputs giving the same result, run progress, and the checks that
// stop a run on an engine fault instead of booking it quietly.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { createRequire } from 'node:module';
import { freshCompute, loadDayFiles, REAL_RANGE } from './helpers/golden.mts';
import { TEMPLATES, specFromTemplate } from '../lib/legs/templates.ts';
const require = createRequire(import.meta.url);
const D = require('../public/engine/dayfile.js');
const E = require('../public/engine/engine.js');
const L = require('../public/engine/ledger.js');

const dir = process.env.DAYFILES;
const STRATEGIES: [string, Record<string, unknown>][] = [
  ['straddle', { strategy: 'straddle' }], ['orb', { strategy: 'orb' }], ['ema_pullback', { strategy: 'ema_pullback' }],
  ...TEMPLATES.filter((t) => !/calendar|diagonal/.test(t.id)).map((t) => [`legs.${t.id}`, { strategy: 'legs', spec: specFromTemplate(t.id as never) }] as [string, Record<string, unknown>]),
];

/** A small day file in the stored format (two option series, one with gaps), and its sha256 as the inventory lists it. */
function dayFile() {
  const n = 6, gap = null;
  const doc = {
    v: 1, underlying: 'NIFTY', expiry_flag: 'WEEK', date: '2026-01-05', expiry: '2026-01-06', expiry_source: 'test', lot_size: 65, lot_source: 'test',
    t0: 555, n, px_scale: 100, source: 'test',
    index: { o: [2600000, 100, -50, 25, 0, 10], h: [500, 400, 300, 200, 100, 50], l: [300, 200, 100, 50, 25, 10], c: [100, -50, 25, 0, 10, 5] },
    vix: null, spot: [2600000, 100, -50, 25, 0, 10],
    series: [
      { cp: 'CE', k: [26000, 0, 0, gap, 0, 0], o: [10000, 50, -20, gap, 30, 10], h: [200, 100, 100, gap, 100, 50], l: [100, 50, 50, gap, 50, 20], c: [50, 20, 10, gap, 20, 5], v: [1, 1, 1, gap, 1, 1], oi: [1, 0, 0, gap, 0, 0], iv: [1, 0, 0, gap, 0, 0] },
      { cp: 'PE', k: [26000, 0, 0, 0, 0, 0], o: [9000, -40, 10, 10, 10, 10], h: [100, 100, 100, 100, 100, 100], l: [50, 50, 50, 50, 50, 50], c: [20, 20, 20, 20, 20, 20], v: [1, 1, 1, 1, 1, 1], oi: [1, 0, 0, 0, 0, 0], iv: [1, 0, 0, 0, 0, 0] },
    ],
  };
  const raw = Buffer.from(JSON.stringify(doc));
  const gz = gzipSync(raw);
  return { doc, buf: gz.buffer.slice(gz.byteOffset, gz.byteOffset + gz.byteLength), sha256: createHash('sha256').update(raw).digest('hex') };
}

test('decoded prices: a missing minute is an empty slot, never a stored null (numbers stay unboxed)', () => {
  const { doc } = dayFile();
  const s = D.toSession(doc, {});
  const ce = s.expiries[0].contracts['CE:26000'];
  assert.equal(ce.o.length, 6);
  assert.ok(!(3 in ce.o), 'the gap at minute 3 is an empty slot');
  assert.equal(ce.o[3], undefined); assert.ok(ce.o[3] == null, 'engines test == null, which is true for an empty slot');
  assert.deepEqual([ce.o[0], ce.o[1], ce.o[4]], [100, 100.5, 100.6]);
  for (const arr of [ce.o, ce.h, ce.l, ce.c, s.und.o, s.und.c]) assert.ok(!arr.includes(null), 'no stored null');
  // the index from spot (old files) follows the same rule
  const noIndex = D.toSession({ ...doc, index: null, spot: [2600000, null, 10, 0, 0, 0] }, {});
  assert.ok(!(1 in noIndex.und.o) && noIndex.und.c[2] === 26000.1 && noIndex.meta.flags.includes('index_from_spot'));
});

test('a day file is checked against its sha256 before it is decoded; a damaged one is refused', async () => {
  const { buf, sha256, doc } = dayFile();
  const ok = await D.unpack(buf, sha256);
  assert.equal(ok.checked, true); assert.deepEqual(ok.doc, doc);
  assert.equal((await D.unpack(buf, null)).checked, false, 'no hash known: decoded, marked unchecked');
  await assert.rejects(D.unpack(buf, 'a'.repeat(64)), (e: Error & { code?: string }) => e.code === 'CHECKSUM' && /does not match its checksum/.test(e.message));
});

test('merging two expiry series of one date makes a new session; the inputs (kept by the worker) are unchanged', () => {
  const { doc } = dayFile();
  const week = D.toSession(doc, {}), month = D.toSession({ ...doc, expiry_flag: 'MONTH', expiry: '2026-01-27' }, {});
  const [m] = D.mergeSessions([week, month]);
  assert.notEqual(m, week);
  assert.equal(m.expiries.length, 2);
  assert.equal(week.expiries.length, 1, 'the weekly session a worker keeps is not changed');
  assert.equal(D.mergeSessions([week])[0], week, 'a date with one file is the session itself');
});

/** A cheap fingerprint of every number in the sessions, to see that nothing changed them. */
function digest(sessions: any[]): string {
  const h = createHash('sha256');
  const arr = (a: any[]) => { for (let i = 0; i < a.length; i++) h.update(a[i] == null ? '_' : String(a[i])); h.update('|'); };
  for (const s of sessions) {
    h.update(s.date); for (const k of ['o', 'h', 'l', 'c']) arr(s.und[k]);
    for (const ex of s.expiries) for (const key of Object.keys(ex.contracts).sort()) { h.update(key); for (const k of Object.keys(ex.contracts[key]).sort()) arr(ex.contracts[key][k]); }
    h.update(JSON.stringify(s.meta ?? null));
  }
  return h.digest('hex');
}
function reuseCheck(sessions: any[]) {
  const before = digest(sessions);
  const first = new Map<string, string>();
  for (const [name, p] of STRATEGIES) first.set(name, JSON.stringify(freshCompute().run(p, sessions)));
  assert.equal(digest(sessions), before, 'no run changed the sessions it read');
  // the same sessions again, in another order, through one compute: every result is what it was the first time
  const c = freshCompute();
  for (const [name, p] of [...STRATEGIES].reverse()) assert.equal(JSON.stringify(c.run(p, sessions)), first.get(name), `${name} on reused sessions`);
}
test('synthetic: engines never change the sessions they read, and reused sessions give the same results', () => {
  reuseCheck(E.syntheticCalendar(40, { iv: 14 }, 4));
});
test('real data: engines never change the sessions they read, and reused sessions give the same results', { skip: !dir && 'set DAYFILES to a folder of day files' }, () => {
  reuseCheck(loadDayFiles(dir!, REAL_RANGE));
});

test('progress hooks: one tick per session in order, the ledger phase once; with or without them the result is the same', () => {
  const sessions = E.syntheticCalendar(25, { iv: 13 }, 2);
  for (const p of [{ strategy: 'straddle' }, { strategy: 'orb' }, { strategy: 'ema_pullback' }, { strategy: 'legs', spec: specFromTemplate('iron_condor') }]) {
    const ticks: number[] = [], phases: string[] = [];
    const withHooks = freshCompute().run(p, sessions, { tick: (i: number, n: number) => { assert.equal(n, 25); ticks.push(i); }, phase: (x: string) => phases.push(x) });
    assert.deepEqual(ticks, Array.from({ length: 25 }, (_, i) => i), `${p.strategy} ticks`);
    assert.deepEqual(phases, ['ledger']);
    assert.equal(JSON.stringify(withHooks), JSON.stringify(freshCompute().run(p, sessions)));
  }
  // a hook never outlives its run
  const c = freshCompute(), seen: number[] = [];
  c.run({ strategy: 'straddle' }, sessions, { tick: (i: number) => seen.push(i) });
  c.run({ strategy: 'straddle' }, sessions);
  assert.equal(seen.length, 25);
});

const day = (date: string, fills: any[]) => ({ date, status: 'traded', lot_size: 75, symbol: 'NIFTY', flags: [], events: [], mtm: [], fills, exit_reason: 'eod' });
const fill = (t: number, leg: string, action: string, px: number) => ({ t, leg, action, px, strike: 24000, qty: 75, side: 'CE', expiry: '2025-11-06', reason: action === 'SELL' ? 'entry' : 'exit', cost: 0, costs: null });
test('the ledger refuses a leg sent twice instead of booking it quietly', () => {
  assert.throws(() => L.runLedger([day('2025-11-03', [fill(555, 'A', 'SELL', 100), fill(560, 'A', 'SELL', 101), fill(600, 'A', 'BUY', 80)])], {}), /second SELL for an open short leg/);
  assert.throws(() => L.runLedger([day('2025-11-03', [fill(555, 'A', 'SELL', 100), fill(600, 'A', 'BUY', 80), fill(610, 'A', 'BUY', 79)])], {}), /arrived after the leg was closed/);
  // a normal round trip, and a leg closed by liquidation whose own close comes later, are booked as before
  assert.equal(L.runLedger([day('2025-11-03', [fill(555, 'A', 'SELL', 100), fill(600, 'A', 'BUY', 80)])], {}).tradebook.length, 1);
});

function fillChecks(sessions: any[], holds: readonly ('intraday' | 'expiry')[]) {
  for (const t of TEMPLATES.filter((x) => !/calendar|diagonal/.test(x.id))) {
    for (const hold of holds) {
      const spec = specFromTemplate(t.id as never, {}, { exit: { hold, time: '15:15', settle_at_expiry: true, basis: 'net' } as never });
      const r = freshCompute().run({ strategy: 'legs', spec }, sessions);
      const legs = r.positions.flatMap((p: any) => p.legs);
      assert.ok(legs.length > 0 && legs.every((l: any) => l.exit_px != null), `${t.id} ${hold}: every leg closed`);
    }
  }
}
test('every leg-engine run passes its fill checks (one fill in, one out, same contract, legs together): synthetic, intraday', () => {
  fillChecks(E.syntheticCalendar(30, { iv: 15 }, 6), ['intraday']);
});
test('every leg-engine run passes its fill checks on real data, held to expiry across sessions', { skip: !dir && 'set DAYFILES to a folder of day files' }, () => {
  fillChecks(loadDayFiles(dir!, REAL_RANGE), ['intraday', 'expiry']);
});
