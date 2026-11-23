// The strategy registry (lib/strategyRegistry.ts): one shape for the published rule sets and the builder's
// structures. The parameters the Lab holds must turn into exactly the spec the leg engine runs, every structure must
// run and reconcile, and the published strategies must reach their engines unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { CORE_BUILDER, GROUPS, REGISTRY, builderSpec, inGroup, labStrategy, slugOfResult } from '../lib/strategyRegistry.ts';
import { STRATEGIES, describeParams } from '../lib/strategies.ts';
import { TEMPLATES } from '../lib/legs/templates.ts';
import { freshCompute, loadDayFiles, REAL_RANGE } from './helpers/golden.mts';
const require = createRequire(import.meta.url);
const G = require('../public/engine/legs.js');
const E = require('../public/engine/engine.js');

const REQUESTED = {
  directional: ['Long call', 'Long put', 'Short call', 'Short put', 'Bull call spread', 'Bear put spread', 'Bull put spread (credit)', 'Bear call spread (credit)'],
  volatility: ['Long straddle', 'Short straddle', 'Long strangle', 'Short strangle'],
  multileg: ['Iron condor', 'Iron butterfly', 'Call ratio spread (1×2)', 'Put ratio spread (1×2)'],
};

test('the registry: four published rule sets, then the 16 requested structures in their groups, then the rest', () => {
  assert.deepEqual(inGroup('published').map((s) => s.slug), STRATEGIES.map((s) => s.slug));
  for (const [g, names] of Object.entries(REQUESTED)) assert.deepEqual(inGroup(g as any).map((s) => s.name), names, g);
  assert.equal(CORE_BUILDER.length, 16);
  assert.equal(REGISTRY.length, STRATEGIES.length + TEMPLATES.length);
  assert.equal(new Set(REGISTRY.map((s) => s.slug)).size, REGISTRY.length);
  assert.deepEqual(GROUPS.map((g) => g.id), ['published', 'directional', 'volatility', 'multileg', 'more']);
  // only the structures that need the next expiry are blocked, with the reason
  assert.deepEqual(REGISTRY.filter((s) => s.blocked).map((s) => s.slug), ['calendar_call', 'calendar_put', 'diagonal_call', 'diagonal_put']);
  // the four-leg model is the one strategy the optimiser refuses, and it says why
  assert.deepEqual(REGISTRY.filter((s) => !s.optimise.ok && !s.blocked).map((s) => s.slug), ['fourleg']);
  const why = labStrategy('fourleg')!.optimise;
  assert.ok(!why.ok && /synthetic stock model/.test(why.why));
});

test('published strategies reach their engines unchanged (Strategy 01 keeps its own rules)', () => {
  for (const s of STRATEGIES) {
    const e = labStrategy(s.slug)!;
    assert.equal(e.family, 'engine');
    assert.equal(e.engine, s.slug);
    assert.deepEqual(e.toRunParams(s.defaults, { series: 'WEEK' }), s.defaults);
    assert.deepEqual(e.defaults, s.defaults);
    assert.equal(e.rulesHref, `/strategies/${s.slug}`);
  }
  assert.equal(labStrategy('ema_pullback')!.syntheticOk, false);
  assert.equal(labStrategy('fourleg')!.realOk, false);
});

test('builder defaults: every field has a default and every default a field; unused template settings are hidden', () => {
  for (const s of REGISTRY.filter((x) => x.family === 'builder')) {
    const keys = s.fields.map((f) => f.key);
    assert.equal(new Set(keys).size, keys.length, s.slug);
    assert.deepEqual(Object.keys(s.defaults).filter((k) => k !== 'strategy').sort(), [...keys].sort(), s.slug);
    assert.equal(s.defaults.strategy, s.slug);
  }
  const keys = (slug: string) => labStrategy(slug)!.fields.map((f) => f.key);
  // a straddle has no strike offset or width; a strangle has an offset but no width; a condor has both
  assert.ok(!keys('short_straddle').includes('offset') && !keys('short_straddle').includes('width'));
  assert.ok(keys('short_strangle').includes('offset') && !keys('short_strangle').includes('width'));
  assert.ok(keys('iron_condor').includes('offset') && keys('iron_condor').includes('width'));
  // stops are offered for the legs a structure has
  assert.ok(keys('long_call').includes('long_sl_pct') && !keys('long_call').includes('short_sl_pct'));
  assert.ok(keys('short_put').includes('short_sl_pct') && !keys('short_put').includes('long_sl_pct'));
  // single legs and debit spreads default at the money; strangles and condors two strikes out
  assert.equal(labStrategy('long_call')!.defaults.offset, 0);
  assert.equal(labStrategy('iron_condor')!.defaults.offset, 2);
  // 0 reads "off"
  assert.deepEqual(describeParams(labStrategy('iron_condor')!, { ...labStrategy('iron_condor')!.defaults, short_sl_pct: 40, target_per_lot: 0 }), ['Stop on each short leg: 40%']);
});

test('builder parameters become exactly the spec the leg engine runs', () => {
  const s = labStrategy('iron_condor')!;
  const base = builderSpec('iron_condor', s.defaults);
  assert.ok(G.validate(base).ok);
  // defaults: intraday 09:20-15:15, no stops or targets, one entry a session (left out of the spec), slippage 0.5%
  assert.deepEqual([base.entry.time, base.exit.time, base.exit.hold, base.exit.target, base.exit.stop, base.entry.max_entries, base.execution.slip_pct],
    ['09:20', '15:15', 'intraday', undefined, undefined, undefined, 0.5]);
  assert.ok(base.legs.every((l) => !l.stop));
  assert.deepEqual(base.legs.map((l) => [l.action, l.right, l.strike]), [
    ['BUY', 'PE', { by: 'atm', steps: 4 }], ['SELL', 'PE', { by: 'atm', steps: 2 }], ['SELL', 'CE', { by: 'atm', steps: 2 }], ['BUY', 'CE', { by: 'atm', steps: 4 }]]);
  const p = { ...s.defaults, offset: 3, width: 1, lots: 2, short_sl_pct: 50, target_per_lot: 1500, stop_per_lot: 3000, max_entries: 3, cooldown_min: 10,
    cutoff: '13:00', on_leg_stop: 'reenter', max_reentries: 2, entry_time: '09:30', exit_time: '15:00', hold: 'expiry', slip_pct: 1 };
  const sp = builderSpec('iron_condor', p, 'MONTH');
  assert.ok(G.validate(sp).ok, JSON.stringify(G.validate(sp).errors));
  assert.equal(sp.lots, 2);
  assert.deepEqual(sp.legs.map((l) => [l.action, l.strike, l.stop ?? null, l.expiry.series]), [
    ['BUY', { by: 'atm', steps: 4 }, null, 'MONTH'], ['SELL', { by: 'atm', steps: 3 }, { kind: 'pct', value: 50 }, 'MONTH'],
    ['SELL', { by: 'atm', steps: 3 }, { kind: 'pct', value: 50 }, 'MONTH'], ['BUY', { by: 'atm', steps: 4 }, null, 'MONTH']]);
  assert.deepEqual(sp.exit, { hold: 'expiry', time: '15:00', settle_at_expiry: true, basis: 'net', target: { kind: 'rupees_per_lot', value: 1500 }, stop: { kind: 'rupees_per_lot', value: 3000 } });
  assert.deepEqual([sp.entry.time, sp.entry.max_entries, sp.entry.cooldown_min], ['09:30', 3, 10]);
  assert.deepEqual(sp.adjust, { on_leg_stop: 'reenter', max_reentries: 2, cutoff: '13:00' });
  assert.equal(sp.execution.slip_pct, 1);
  // long legs get the long-leg stop
  const lc = builderSpec('bull_call_spread', { ...labStrategy('bull_call_spread')!.defaults, long_sl_pct: 40, short_sl_pct: 80 });
  assert.deepEqual(lc.legs.map((l) => [l.action, l.stop?.value ?? null]), [['BUY', 40], ['SELL', 80]]);
  // the run request carries the spec as JSON, under the leg engine, and keeps the account settings
  const rp = s.toRunParams(p, { series: 'WEEK' });
  assert.equal(rp.strategy, 'legs');
  assert.equal(rp.template, 'iron_condor');
  assert.equal(rp.capital, s.defaults.capital);
  assert.deepEqual(JSON.parse(String(rp.spec)), builderSpec('iron_condor', p, 'WEEK'));
  // the Lab's leg table and rule text read from the same spec
  assert.deepEqual(s.legs(p).map((l) => [l.action, l.right, l.strike, l.stop]), [['Buy', 'PE', '4 OTM', '—'], ['Sell', 'PE', '3 OTM', '50%'], ['Sell', 'CE', '3 OTM', '50%'], ['Buy', 'CE', '4 OTM', '—']]);
  assert.match(s.entryText(p), /Up to 3 positions a session/);
  assert.match(s.exitText(p), /short-leg stop 50%, position target ₹1,500\/lot, position stop ₹3,000\/lot, cash settlement at expiry/i);
});

test('every runnable structure runs from its Lab defaults on synthetic data and reconciles', () => {
  const sessions = E.syntheticCalendar(20, { iv: 13 }, 3);
  const compute = freshCompute();
  for (const s of REGISTRY.filter((x) => x.family === 'builder' && !x.blocked)) {
    const r = compute.run({ ...s.toRunParams(s.defaults, { series: 'WEEK' }), capital: 2000000 }, sessions);
    assert.equal(slugOfResult(r), s.slug);
    assert.equal(r.days.length, 20, s.slug);
    assert.ok(r.account.report.reconciliation.ok, s.slug);
    assert.ok(r.positions.length > 0, s.slug);
  }
});

const dir = process.env.DAYFILES;
test('the 16 requested structures run on real NIFTY day files and reconcile', { skip: !dir && 'set DAYFILES to a folder of day files (see tests/golden.test.mts)' }, () => {
  const sessions = loadDayFiles(dir!, REAL_RANGE);
  const compute = freshCompute();
  for (const s of CORE_BUILDER) {
    const r = compute.run(s.toRunParams(s.defaults, { series: 'WEEK' }), sessions);
    assert.equal(r.days.length, sessions.length, s.slug);
    assert.ok(r.account.report.reconciliation.ok, `${s.slug}: ${JSON.stringify(r.account.report.reconciliation.checks.filter((c: any) => !c.ok).slice(0, 3))}`);
    assert.ok(r.traded > 0, s.slug);
  }
});
