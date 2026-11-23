// The strategy registry (lib/strategyRegistry.ts): one shape for the published rule sets and the builder's
// structures. The parameters the Lab holds must turn into exactly the spec the leg engine runs, every structure must
// run and reconcile, and the published strategies must reach their engines unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { CORE_BUILDER, GROUPS, REGISTRY, builderSpec, inGroup, labStrategy, legDrafts, slugOfResult, templateDrafts } from '../lib/strategyRegistry.ts';
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
    const withUnits = s.fields.flatMap((f) => (f.kind === 'level' && f.unitKey ? [f.key, f.unitKey] : [f.key]));
    assert.deepEqual(Object.keys(s.defaults).filter((k) => k !== 'strategy').sort(), [...withUnits].sort(), s.slug);
    assert.equal(s.defaults.strategy, s.slug);
  }
  const keys = (slug: string) => labStrategy(slug)!.fields.map((f) => f.key);
  // a straddle has no strike offset or width; a strangle has an offset but no width; a condor has both
  assert.ok(!keys('short_straddle').includes('offset') && !keys('short_straddle').includes('width'));
  assert.ok(keys('short_strangle').includes('offset') && !keys('short_strangle').includes('width'));
  assert.ok(keys('iron_condor').includes('offset') && keys('iron_condor').includes('width'));
  // stops are offered for the legs a structure has
  assert.ok(keys('long_call').includes('long_sl') && !keys('long_call').includes('short_sl'));
  assert.ok(keys('short_put').includes('short_sl') && keys('short_put').includes('short_tp') && !keys('short_put').includes('long_sl'));
  // single legs and debit spreads default at the money; strangles and condors two strikes out
  assert.equal(labStrategy('long_call')!.defaults.offset, 0);
  assert.equal(labStrategy('iron_condor')!.defaults.offset, 2);
  // 0 reads "off"
  const ic = labStrategy('iron_condor')!;
  assert.deepEqual(describeParams(ic, { ...ic.defaults, short_sl: 40, pos_tp: 0 }), ['Stop, each short leg: 40%']);
  // a unit change counts once the level is on, and reads in that unit
  assert.deepEqual(describeParams(ic, { ...ic.defaults, pos_tp: 2500, pos_tp_unit: 'rupees' }), ['Position target: ₹2,500']);
  assert.deepEqual(describeParams(ic, { ...ic.defaults, pos_tp_unit: 'rupees' }), []);
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
  const p = { ...s.defaults, offset: 3, width: 1, lots: 2, short_sl: 50, pos_tp: 1500, pos_sl: 3000, max_entries: 3, cooldown_min: 10,
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
  const lc = builderSpec('bull_call_spread', { ...labStrategy('bull_call_spread')!.defaults, long_sl: 40, short_sl: 80 });
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
  assert.match(s.exitText(p), /a stop on 2 of 4 legs, position target ₹1,500\/lot, position stop ₹3,000\/lot, cash settlement at expiry/i);
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

test('stops and targets: units reach the spec; a leg can follow its side, set its own, or have none', () => {
  const s = labStrategy('short_strangle')!;
  // the side defaults in ₹ per lot and points
  const a = builderSpec('short_strangle', { ...s.defaults, short_sl: 1500, short_sl_unit: 'rupees_per_lot', short_tp: 20, short_tp_unit: 'points', pos_sl: 5000, pos_sl_unit: 'rupees', pos_tp: 40, pos_tp_unit: 'pct_premium' });
  assert.ok(G.validate(a).ok, JSON.stringify(G.validate(a).errors));
  assert.deepEqual(a.legs.map((l) => [l.stop, l.target]), [[{ kind: 'rupees_per_lot', value: 1500 }, { kind: 'points', value: 20 }], [{ kind: 'rupees_per_lot', value: 1500 }, { kind: 'points', value: 20 }]]);
  assert.deepEqual([a.exit.stop, a.exit.target], [{ kind: 'rupees', value: 5000 }, { kind: 'pct_premium', value: 40 }]);
  // edited legs: L1 sets its own stop, L2 has none; targets still follow the side default
  const drafts = templateDrafts('short_strangle', s.defaults);
  assert.deepEqual(drafts.map((d) => [d.id, d.action, d.right, d.strike]), [['L1', 'SELL', 'CE', { by: 'atm', steps: 2 }], ['L2', 'SELL', 'PE', { by: 'atm', steps: 2 }]]);
  const legs = JSON.stringify([{ ...drafts[0], stop: { kind: 'pct', value: 80 } }, { ...drafts[1], stop: null }]);
  const b = builderSpec('short_strangle', { ...s.defaults, legs, short_sl: 40, short_tp: 30 });
  assert.deepEqual(b.legs.map((l) => [l.stop ?? null, l.target ?? null]), [[{ kind: 'pct', value: 80 }, { kind: 'pct', value: 30 }], [null, { kind: 'pct', value: 30 }]]);
  assert.equal(b.name, 'Short strangle (legs edited)');
  assert.equal(b.template, 'short_strangle');
  // edited legs ignore the offset; unreadable JSON falls back to the structure's legs
  assert.deepEqual(builderSpec('short_strangle', { ...s.defaults, legs, offset: 5 }).legs.map((l) => l.strike), [{ by: 'atm', steps: 2 }, { by: 'atm', steps: 2 }]);
  assert.deepEqual(legDrafts('short_strangle', { ...s.defaults, legs: '{not json' }), drafts);
  // a hand-made structure: a call spread with a premium-picked short leg and a 2x long wing, on the monthly series
  const custom = JSON.stringify([
    { id: 'L1', action: 'SELL', right: 'CE', ratio: 1, strike: { by: 'premium', price: 60, side: 'at_most' } },
    { id: 'L2', action: 'BUY', right: 'CE', ratio: 2, strike: { by: 'leg', leg: 'L1', steps: 3 } },
  ]);
  const c = builderSpec('short_call', { ...labStrategy('short_call')!.defaults, legs: custom }, 'MONTH');
  assert.ok(G.validate(c).ok, JSON.stringify(G.validate(c).errors));
  assert.deepEqual(c.legs.map((l) => [l.action, l.ratio, l.expiry.series, l.strike.by]), [['SELL', 1, 'MONTH', 'premium'], ['BUY', 2, 'MONTH', 'leg']]);
  // the engine still refuses what the data cannot support: 4 + 7 strikes is outside the stored ATM ± 10
  const wide = JSON.stringify([{ id: 'L1', action: 'BUY', right: 'CE', ratio: 1, strike: { by: 'atm', steps: 4 } }, { id: 'L2', action: 'SELL', right: 'CE', ratio: 1, strike: { by: 'leg', leg: 'L1', steps: 7 } }]);
  const caps = { source: 'dhan', underlying: 'NIFTY', series: ['WEEK'], nth: [1], strike_window: 10, greeks: false, bid_ask: false, continuous: true, expiry_assumed: false };
  assert.deepEqual(G.validate(builderSpec('long_call', { ...labStrategy('long_call')!.defaults, legs: wide }), caps).errors.map((g: any) => [g.code, g.leg]), [['STRIKE_OUTSIDE_WINDOW', 'L2']]);
});

test('published strategies: wider stops and targets, times on the session line, same engine defaults', () => {
  const s1 = labStrategy('straddle')!;
  const f = (k: string) => s1.fields.find((x) => x.key === k)!;
  assert.equal(f('entry_time').kind, 'time');
  assert.deepEqual([f('entry_time'), f('reentry_cutoff'), f('exit_time')].map((x: any) => [x.role, x.grain]), [['entry', 5], ['last_entry', 1], ['exit', 1]]);
  assert.equal(f('sl_pct').kind, 'level');
  // the defaults the engine already uses, so a default run is unchanged
  assert.deepEqual([s1.defaults.reentry_cutoff, s1.defaults.max_loss_per_lot, s1.defaults.sl_pct, s1.defaults.target_per_lot], ['14:30', 0, 36, 1000]);
  const E2 = require('../public/engine/engine.js');
  const cfg = E2.makeConfig({});
  assert.deepEqual([cfg.reentry_cutoff, cfg.max_loss_per_lot ?? 0], ['14:30', 0]);
  assert.equal((labStrategy('ema_pullback')!.fields.find((x) => x.key === 'stop_points') as any).kind, 'level');
  assert.deepEqual(labStrategy('ema_pullback')!.fixedTimes.map((t) => [t.role, t.at]), [['last_entry', '14:00']]);
});
