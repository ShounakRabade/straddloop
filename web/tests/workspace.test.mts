// Pure parts of the Lab workspace: rolling risk series, tradebook filters and the plain-English summary.
// Each is checked against the engine's own output, so the charts and the summary cannot drift from the report.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dailyReturns, dailySdPct, rollingSharpe, rollingVol, sharpeOf } from '../lib/rolling.ts';
import { EMPTY_FILTER, activeCount, distinct, filterTrades, holdMinutes } from '../lib/tradeFilter.ts';
import { byExit, narrate } from '../lib/narrative.ts';
const require = createRequire(import.meta.url);
const L = require('../public/engine/ledger.js');
const E = require('../public/engine/engine.js');
const F = require('../public/engine/fourleg_engine.js');
const compute = require('../public/engine/compute.js')(E, F, L);

const STRADDLE = { strategy: 'straddle', days: 120, seed: 1, iv: 13, sl_pct: 36, target_per_lot: 1000, reentry_enabled: true, entry_condition: 'full', lots: 1, strike_offset: 0, slip_pct: 0.5,
  capital: 500000, margin_policy: 'reject', margin_span_pct: 9, margin_exposure_pct: 2, brokerage_per_order: 20 };
const run = (p: Record<string, unknown>) => compute.run(p, undefined);
const close = (a: number | null, b: number | null, msg: string) => {
  assert.ok(a != null && b != null, `${msg}: both defined (${a}, ${b})`);
  assert.ok(Math.abs((a as number) - (b as number)) < 1e-9 * Math.max(1, Math.abs(b as number)), `${msg}: ${a} vs ${b}`);
};

for (const [name, p] of [['straddle', STRADDLE], ['orb', { ...STRADDLE, strategy: 'orb', target_points: 30, stop_buffer: 0, breakout_def: 'wick', target_basis: 'premium' }], ['straddle seed 7', { ...STRADDLE, seed: 7, sl_pct: 25 }]] as const) {
  test(`rolling series over the whole run equal the ledger report (${name})`, () => {
    const r = run(p);
    const acct = r.account.config, daily = r.account.daily, risk = r.account.report.risk;
    const rets = dailyReturns(daily, acct);
    assert.equal(rets.length, risk.sessions_in_ratio);
    close(sharpeOf(rets, acct), risk.sharpe, 'Sharpe');
    close(dailySdPct(rets, acct), risk.daily_return_sd_pct, 'daily sd %');
    const full = rollingSharpe(daily, acct, daily.length);
    assert.equal(full.length, daily.length);
    assert.ok(full.slice(0, -1).every((x) => x.v === null), 'no value before the first full window');
    close(full[full.length - 1].v, risk.sharpe, 'full-window rolling Sharpe');
    const vol = rollingVol(daily, acct, daily.length);
    close(vol[vol.length - 1].v, risk.daily_return_sd_pct * Math.sqrt(acct.periods_per_year), 'full-window annualised vol');
    const w20 = rollingSharpe(daily, acct, 20);
    assert.equal(w20.filter((x) => x.v !== null || x.d < daily[19].date).length, daily.length);
    assert.ok(w20.slice(19).every((x) => x.v === null || Number.isFinite(x.v)));
  });
}

test('rolling windows longer than the run give no values instead of inventing them', () => {
  const r = run({ ...STRADDLE, days: 60 });
  const pts = rollingSharpe(r.account.daily, r.account.config, 120);
  assert.ok(pts.every((x) => x.v === null));
});

test('tradebook filters select exactly the rows they say, and the shown net is their sum', () => {
  const r = run(STRADDLE);
  const rows = compute.inspect('tradebook', 0, 1e6).rows as Record<string, unknown>[];
  assert.equal(rows.length, r.account.report.performance.closed_positions);
  assert.deepEqual(filterTrades(rows as never, EMPTY_FILTER), rows);
  const wins = filterTrades(rows as never, { ...EMPTY_FILTER, outcome: 'win' }), losses = filterTrades(rows as never, { ...EMPTY_FILTER, outcome: 'loss' });
  assert.equal(wins.length + losses.length, rows.length);
  assert.equal(wins.length, r.account.report.performance.wins);
  assert.ok(wins.every((t) => Number(t.net_pnl) > 0));
  const net = (xs: Record<string, unknown>[]) => xs.reduce((a, t) => a + Number(t.net_pnl), 0);
  close(net(wins) + net(losses), net(rows), 'wins + losses = all');
  for (const reason of distinct(rows as never, 'exit_reason')) assert.ok(filterTrades(rows as never, { ...EMPTY_FILTER, exit: reason }).every((t) => t.exit_reason === reason));
  const ce = filterTrades(rows as never, { ...EMPTY_FILTER, side: 'CE' }), pe = filterTrades(rows as never, { ...EMPTY_FILTER, side: 'PE' });
  assert.equal(ce.length + pe.length, rows.length);
  const d0 = String(rows[0].date), dN = String(rows[rows.length - 1].date);
  assert.equal(filterTrades(rows as never, { ...EMPTY_FILTER, from: d0, to: dN }).length, rows.length);
  assert.ok(filterTrades(rows as never, { ...EMPTY_FILTER, min: '0' }).every((t) => Number(t.net_pnl) >= 0));
  assert.ok(filterTrades(rows as never, { ...EMPTY_FILTER, max: 'abc' }).length === rows.length, 'a bad bound is ignored, not treated as zero');
  assert.equal(filterTrades(rows as never, { ...EMPTY_FILTER, q: String(rows[0].strike) }).some((t) => t.trade_no === rows[0].trade_no), true);
  assert.equal(activeCount({ ...EMPTY_FILTER, side: 'CE', q: 'x' }), 2);
});

test('hold minutes come from the tradebook times and refuse nonsense', () => {
  assert.equal(holdMinutes({ entry_time: '09:50', exit_time: '15:15' }), 325);
  assert.equal(holdMinutes({ entry_time: '09:50', exit_time: null }), null);
  assert.equal(holdMinutes({ entry_time: '14:00', exit_time: '10:00' }), null);
});

test('the plain-English summary uses only engine figures: net, charges and exit groups match the run', () => {
  const r = run(STRADDLE);
  const rows = compute.inspect('tradebook', 0, 1e6).rows;
  const blocks = narrate(r, { trades: rows, slipPct: 0.5, real: false });
  assert.deepEqual(blocks.map((b) => b.id), ['happened', 'worked', 'hurt', 'capital', 'reliable', 'next']);
  const text = blocks.flatMap((b) => b.lines).join('\n');
  assert.ok(!/NaN|undefined|Infinity|null/.test(text), text);
  const groups = byExit(rows);
  close(groups.reduce((a, g) => a + g.net, 0), r.account.report.pnl.net_profit as number, 'exit groups sum to net');
  assert.equal(groups.reduce((a, g) => a + g.n, 0), rows.length);
  assert.ok(text.includes('synthetic model'));
  assert.match(text, /No out-of-sample or walk-forward test has been run/);
});

test('a run that never trades says so and stops, instead of describing nothing', () => {
  const r = run({ ...STRADDLE, entry_condition: 'full', days: 60, sl_pct: 36 });
  const zero = { ...r, traded: 0 };
  const blocks = narrate(zero as never, { trades: [], real: false });
  assert.equal(blocks.length, 1);
  assert.match(blocks[0].lines.join(' '), /never passed/);
});
