// The optimiser: the parameter space (lib/optimiser/space.ts) and the study runner (lib/optimiser/controller.ts), run
// with an in-process pool of the real engines.
import test from 'node:test';
import assert from 'node:assert/strict';
import { axesFor, estimate, indexOf, paramsFor, plannedIndices, positionsAt, rangeValues, refusal, spaceOf, valuesAt, HARD_CAP } from '../lib/optimiser/space.ts';
import { configParams, runStudy, stressSlip } from '../lib/optimiser/controller.ts';
import { memoryStore, type StudyConfig } from '../lib/optimiser/store.ts';
import { csvOf, filterRows, rowsOf, sortRows } from '../lib/optimiser/rows.ts';
import { labStrategy } from '../lib/strategyRegistry.ts';
import { freshCompute, loadDayFiles, REAL_RANGE } from './helpers/golden.mts';
import { localPool } from './helpers/localPool.mts';

test('the space: every grid point once, in order; a seeded sample is distinct, sorted and repeatable; the cap holds', () => {
  const sp = spaceOf([{ key: 'a', values: [1, 2, 3] }, { key: 'b', values: ['x', 'y'] }, { key: 'c', values: [true, false] }]);
  assert.equal(sp.size, 12);
  const all = Array.from({ length: 12 }, (_, i) => valuesAt(sp, i).join('|'));
  assert.equal(new Set(all).size, 12);
  assert.deepEqual(valuesAt(sp, 0), [1, 'x', true]); assert.deepEqual(valuesAt(sp, 1), [1, 'x', false]); assert.deepEqual(valuesAt(sp, 11), [3, 'y', false]);
  for (let i = 0; i < 12; i++) assert.equal(indexOf(sp, positionsAt(sp, i)), i);
  assert.deepEqual(plannedIndices(sp, { method: 'auto', max: 100, seed: 1 }), { method: 'grid', indices: all.map((_, i) => i), capped: false });
  const big = spaceOf(Array.from({ length: 6 }, (_, k) => ({ key: `k${k}`, values: [0, 1, 2, 3, 4] }))); // 15,625
  const r = plannedIndices(big, { method: 'auto', max: 500, seed: 3 });
  assert.equal(r.method, 'random'); assert.equal(r.capped, true); assert.equal(r.indices.length, 500);
  assert.equal(new Set(r.indices).size, 500);
  assert.deepEqual(r.indices, r.indices.slice().sort((a, b) => a - b));
  assert.deepEqual(plannedIndices(big, { method: 'random', max: 500, seed: 3 }).indices, r.indices);
  assert.notDeepEqual(plannedIndices(big, { method: 'random', max: 500, seed: 4 }).indices, r.indices);
  assert.throws(() => plannedIndices(big, { method: 'grid', max: 500, seed: 1 }), /more than the limit of 500/);
  assert.equal(plannedIndices(big, { method: 'auto', max: 1e9, seed: 1 }).indices.length, Math.min(big.size, HARD_CAP));
});

test('axes come from the strategy: times on their grain, units kept, call and put offsets for builder legs', () => {
  const s1 = labStrategy('straddle')!;
  const e = axesFor(s1, s1.defaults).find((a) => a.key === 'entry_time')!;
  assert.deepEqual(e.bounds, { min: 590, max: 900, grain: 5 });
  assert.match(rangeValues(e, 590, 640, 7).error!, /5-minute grid/);
  assert.deepEqual(rangeValues(e, 590, 640, 25).values, ['09:50', '10:15', '10:40']);
  const sl = axesFor(s1, s1.defaults).find((a) => a.key === 'sl_pct')!;
  assert.match(rangeValues(sl, 1, 50, 5).error!, /Between 5 and 500/);
  assert.match(rangeValues(sl, 10, 5000, 1).error!, /Between/);
  assert.match(rangeValues(sl, 5, 500, 0.5).error!, /at most 500 per setting/);
  const ss = labStrategy('short_strangle')!;
  const keys = axesFor(ss, ss.defaults).map((a) => a.key);
  assert.ok(['call_offset', 'put_offset', 'short_sl', 'pos_tp', 'entry_time', 'exit_time'].every((k) => keys.includes(k)), keys.join(','));
  assert.ok(!keys.includes('long_sl'), 'a strangle has no long legs');
  // the unit of a level axis is the one set in the Lab
  assert.match(axesFor(ss, { ...ss.defaults, short_sl_unit: 'rupees_per_lot' }).find((a) => a.key === 'short_sl')!.label, /₹\/lot/);
  // call and put move separately; on a condor each side keeps its wing width
  const sp = spaceOf([{ key: 'call_offset', values: [3] }, { key: 'put_offset', values: [1] }]);
  const legs = (slug: string) => JSON.parse(String(paramsFor(labStrategy(slug)!, labStrategy(slug)!.defaults, sp, valuesAt(sp, 0)).legs)).map((d: any) => `${d.action} ${d.right} ${d.strike.steps}`);
  assert.deepEqual(legs('short_strangle'), ['SELL CE 3', 'SELL PE 1']);
  assert.deepEqual(legs('iron_condor'), ['BUY PE 3', 'SELL PE 1', 'SELL CE 3', 'BUY CE 5']);
});

test('refused before running: times out of order or bounds, and legs the stored strikes cannot hold', () => {
  const ss = labStrategy('short_strangle')!;
  const ctx = { real: true, series: 'WEEK' as const };
  assert.equal(refusal(ss, ss.defaults, ctx), null);
  assert.match(refusal(ss, { ...ss.defaults, entry_time: '15:00', exit_time: '14:30' }, ctx)!, /before the square-off/);
  assert.match(refusal(ss, { ...ss.defaults, entry_time: '09:00' }, ctx)!, /Entry: Between 09:16/);
  const ic = labStrategy('iron_condor')!;
  const sp = spaceOf([{ key: 'call_offset', values: [9] }]);
  assert.match(refusal(ic, paramsFor(ic, ic.defaults, sp, valuesAt(sp, 0)), ctx)!, /11 strikes from ATM; only ATM ± 10/);
  // the estimate counts them, by reason, before anything runs
  const defs = axesFor(ss, ss.defaults);
  const est = estimate(ss, ss.defaults, defs, [{ key: 'entry_time', values: ['09:20', '15:00'] }, { key: 'exit_time', values: ['14:30', '15:15'] }], { method: 'auto', max: 100, seed: 1, topK: 5, ...ctx });
  assert.deepEqual([est.size, est.planned, est.valid, est.exact], [4, 5, 4, true]); // 15:00 → 14:30 is the one refused
  assert.equal(est.refused[0].n, 1); assert.match(est.refused[0].reason, /before the square-off/);
  assert.equal(est.extra, 4 * (2 * 2 + 1)); // 4 finalists at most, two ordered settings: 4 neighbours + 1 stressed run each
  assert.equal(stressSlip(0.5), 1); assert.equal(stressSlip(0), 0.5); assert.equal(stressSlip(2), 4);
});

const cfgFor = (slug: string, picks: StudyConfig['picks'], over: Partial<StudyConfig> = {}): StudyConfig => ({
  slug, name: 'test', base: labStrategy(slug)!.defaults, picks, objective: 'sharpe', weights: null, minTrades: null, topK: 4,
  split: { train: 0.6, validation: 0.2, test: 0.2 }, folds: 3, wfMode: 'rolling', method: 'auto', max: 2000, seed: 1, workers: 1,
  real: false, series: 'WEEK', data: { source: 'synthetic', label: 'synthetic', from: null, to: null, sessions: 60, key: 'syn', synthetic: { days: 60, seed: 1, iv: 13 }, lotSize: 0 }, capital: 500000, ...over,
});
const synInit = (cfg: StudyConfig, days = 60) => async () => ({ days: null, synthetic: { days, seed: 1, iv: 13 }, lotSize: 0, plan: { split: cfg.split, folds: cfg.folds, wfMode: cfg.wfMode }, capital: cfg.capital });
const strip = (r: any) => JSON.parse(JSON.stringify(r, (k, v) => (['id', 'created', 'updated', 'ms', 'study'].includes(k) ? undefined : v)));

test('a study runs end to end: three answers, robustness of the finalists, and the same answers every time', async () => {
  const cfg = cfgFor('straddle', [{ key: 'sl_pct', values: [25, 40, 60] }, { key: 'target_per_lot', values: [500, 1000, 2000] }]);
  const run = async () => runStudy(cfg, { pool: localPool(), store: memoryStore(), init: synInit(cfg), onProgress: () => {}, signal: { cancelled: false } });
  const a = await run();
  assert.equal(a.study.status, 'done');
  assert.equal(a.study.counts.planned, 10); // your settings + 9 grid points
  const r = a.study.result!;
  assert.ok(r.leader != null && r.best_oos != null && r.robust != null);
  assert.ok(r.finalists.length <= 4 && r.finalists.some((f: any) => f.idx === r.robust));
  assert.ok(r.finalists.every((f: any) => f.robust.components.slippage != null), 'every finalist was re-run at doubled slippage');
  assert.ok(r.finalists.filter((f: any) => f.idx > 0).every((f: any) => f.neighbours.planned >= 2));
  assert.ok([...a.cands.values()].some((c) => c.kind === 'stress'));
  assert.equal(r.cand_order.length, 10);
  assert.match(r.selection_rule, /held-out test window chose nothing/);
  // the same study twice: identical answers, ranking, checks and stored measurements
  const b = await run();
  assert.deepEqual(strip(b.study.result), strip(r));
  assert.deepEqual(strip([...b.cands.values()].sort((x, y) => (x.key < y.key ? -1 : 1))), strip([...a.cands.values()].sort((x, y) => (x.key < y.key ? -1 : 1))));
});

test('cancel stops within one batch and keeps what was measured; resume finishes with the same answers', async () => {
  const cfg = cfgFor('straddle', [{ key: 'sl_pct', values: [25, 40, 60] }, { key: 'target_per_lot', values: [500, 1000, 2000] }]);
  const store = memoryStore(), signal = { cancelled: false };
  const pool = localPool(null, (n) => { if (n === 3 && !signal.cancelled) { signal.cancelled = true; pool.cancel(); } });
  const stages: string[] = [];
  const first = await runStudy(cfg, { pool, store, init: synInit(cfg), onProgress: (p) => stages.push(p.stage), signal, batch: 3, id: 'st-test' });
  assert.equal(first.study.status, 'cancelled');
  assert.ok(first.study.counts.evaluated >= 3 && first.study.counts.evaluated <= 3 + 3, `measured ${first.study.counts.evaluated}`);
  assert.equal(stages.at(-1), 'cancelled');
  const saved = await store.loadStudy('st-test');
  assert.equal(saved!.study.status, 'cancelled');
  assert.equal(saved!.cands.length, first.study.counts.evaluated);
  // resume: only what is missing runs, and the answers equal an uninterrupted study
  const pool2 = localPool();
  const resumed = await runStudy(cfg, { pool: pool2, store, init: synInit(cfg), onProgress: () => {}, signal: { cancelled: false } }, saved!);
  assert.equal(resumed.study.status, 'done');
  const searchRuns = 10 - saved!.cands.length;
  assert.ok(pool2.evaluated >= searchRuns && pool2.evaluated < 10 + 40, `resumed ran ${pool2.evaluated}`);
  const whole = await runStudy(cfg, { pool: localPool(), store: memoryStore(), init: synInit(cfg), onProgress: () => {}, signal: { cancelled: false } });
  assert.deepEqual(strip(resumed.study.result), strip(whole.study.result));
  // a study cannot resume on different data
  await assert.rejects(runStudy(cfg, { pool: localPool(), store, init: synInit(cfg, 40), onProgress: () => {}, signal: { cancelled: false } }, (await store.loadStudy('st-test'))!), /was run on 60 sessions and the data now has 40/);
});

test('refused configurations are recorded, never run; the four-leg model is refused outright', async () => {
  const cfg = cfgFor('short_strangle', [{ key: 'entry_time', values: ['09:20', '15:00'] }, { key: 'exit_time', values: ['14:30', '15:15'] }]);
  const out = await runStudy(cfg, { pool: localPool(), store: memoryStore(), init: synInit(cfg), onProgress: () => {}, signal: { cancelled: false } });
  assert.equal(out.study.counts.refused >= 1, true);
  const refused = [...out.cands.values()].filter((c) => c.refused);
  assert.ok(refused.every((c) => !c.summary) && refused.some((c) => /before the square-off/.test(c.refused!)));
  await assert.rejects(runStudy(cfgFor('fourleg', []), { pool: localPool(), store: memoryStore(), init: synInit(cfg), onProgress: () => {}, signal: { cancelled: false } }), /synthetic stock model/);
});

const dir = process.env.DAYFILES;
test('real data: a short-strangle study on 1 Apr–30 Jul 2026; an answer loaded into a backtest gives the figure the study measured', { skip: !dir && 'set DAYFILES to a folder of day files' }, async () => {
  const sessions = loadDayFiles(dir!, REAL_RANGE);
  const picks = [
    { key: 'entry_time', values: ['09:20', '09:50'] }, { key: 'exit_time', values: ['15:00', '15:15'] },
    { key: 'call_offset', values: [1, 2] }, { key: 'put_offset', values: [1, 2] }, { key: 'short_sl', values: [0, 50] }, { key: 'pos_tp', values: [0, 1500] },
  ];
  const cfg = cfgFor('short_strangle', picks, { real: true, objective: 'calmar', topK: 5, data: { source: 'local', label: 'real', from: REAL_RANGE.from, to: REAL_RANGE.to, sessions: sessions.length, key: 'k', lotSize: 0 } });
  const t0 = performance.now();
  const out = await runStudy(cfg, { pool: localPool(sessions), store: memoryStore(), init: async () => ({ days: null, synthetic: null, lotSize: 0, plan: { split: cfg.split, folds: cfg.folds, wfMode: cfg.wfMode }, capital: 500000 }), onProgress: () => {}, signal: { cancelled: false } });
  assert.equal(out.study.status, 'done');
  assert.equal(out.study.counts.planned, 65);
  const r = out.study.result!;
  for (const which of ['leader', 'best_oos', 'robust'] as const) {
    const id = r[which];
    assert.ok(id != null, which);
    const backtest = freshCompute().run(labStrategy('short_strangle')!.toRunParams(configParams(cfg, id), { series: 'WEEK' }), sessions);
    const measured = out.cands.get(`g${id}`)!.summary!.full;
    assert.ok(Math.abs(backtest.net - measured.net) < 0.01, `${which} (#${id}): backtest ${backtest.net} vs study ${measured.net}`);
  }
  assert.equal(out.study.counts.evaluated, 65);
  console.log(`  real study: 65 configurations + ${out.study.counts.extra} robustness runs in ${Math.round(performance.now() - t0)} ms; leader #${r.leader}, best out-of-sample #${r.best_oos}, most robust #${r.robust}`);
});

test('the table and its CSV hold training, validation and in-sample figures only; rank 1 is the leader', async () => {
  const cfg = cfgFor('straddle', [{ key: 'sl_pct', values: [25, 40, 60] }, { key: 'reentry_enabled', values: [true, false] }]);
  const out = await runStudy(cfg, { pool: localPool(), store: memoryStore(), init: synInit(cfg), onProgress: () => {}, signal: { cancelled: false } });
  const { rows, refused, failed } = rowsOf(out.study, [...out.cands.values()]);
  assert.equal(rows.length, 7); assert.deepEqual([refused, failed], [[], 0]);
  const r = out.study.result!;
  assert.equal(rows.find((x) => x.rank === 1)!.id, r.leader);
  assert.ok(rows.find((x) => x.id === r.leader)!.answers.includes('leader'));
  assert.ok(rows.every((x) => !('test' in x.w) && !('full' in x.w)));
  const csv = csvOf(out.study, sortRows(rows, 'rank', 'is'));
  const head = csv.split('\n')[0].split(',');
  assert.ok(!head.some((h) => /test|full/.test(h)), head.join(','));
  assert.equal(head.slice(0, 4).join(','), 'rank_by_training,config,sl_pct,reentry_enabled');
  assert.equal(csv.split('\n').length, 8);
  assert.match(csv, /your settings,36,On/);
  // sorting: by net, larger first, ties and missing values in a fixed order
  const byNet = sortRows(rows, 'net', 'validation');
  for (let i = 1; i < byNet.length; i++) assert.ok(byNet[i - 1].w.validation.net >= byNet[i].w.validation.net);
  assert.deepEqual(sortRows(rows, 'net', 'validation', true).map((x) => x.id), byNet.slice().reverse().map((x) => x.id).sort((a, b) => {
    const d = rows.find((x) => x.id === a)!.w.validation.net - rows.find((x) => x.id === b)!.w.validation.net; return d || a - b; }));
  assert.equal(filterRows(rows, { minTraded: 0, positiveValidation: true, answersOnly: false }, 'is').every((x) => x.w.validation.net > 0), true);
});
