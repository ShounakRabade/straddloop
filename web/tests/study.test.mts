// Optimisation studies (public/engine/study.js): the windows, the measurements, and how the answers are chosen.
// The rule these tests hold: only the in-sample windows choose; the held-out test changes nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { freshCompute } from './helpers/golden.mts';
const require = createRequire(import.meta.url);
const A = require('../public/engine/analytics.js');
const S = require('../public/engine/study.js');
const E = require('../public/engine/engine.js');

const isoDay = (i: number) => new Date(Date.UTC(2025, 0, 1) + i * 86400000).toISOString().slice(0, 10);
const clone = (x: any) => JSON.parse(JSON.stringify(x));

test('the windows: chronological, disjoint, and every walk-forward fold trains before it tests, inside the in-sample part', () => {
  const dates = Array.from({ length: 100 }, (_, i) => isoDay(i));
  for (const wfMode of ['rolling', 'anchored']) {
    const p = S.studyPlan(dates, { folds: 4, wfMode });
    assert.deepEqual([p.split.train, p.split.validation, p.split.test], [[0, 60], [60, 80], [80, 100]]);
    assert.equal(p.isEnd, 80);
    assert.equal(p.folds.length, 4);
    let prevEnd = null;
    for (const f of p.folds) {
      assert.ok(f.train[1] <= f.test[0], `train ${f.train} ends before test ${f.test}`);
      assert.ok(f.test[1] <= p.isEnd && f.train[0] >= 0);
      if (prevEnd != null) assert.equal(f.test[0], prevEnd); // consecutive, no gaps, no overlap
      prevEnd = f.test[1];
      if (wfMode === 'anchored') assert.equal(f.train[0], 0);
      else assert.equal(f.train[1] - f.train[0], 40);
    }
    assert.equal(prevEnd, 80);
    assert.ok(p.blocks.every(([a, b]: number[]) => a >= 0 && b <= 80) && p.blocks.length >= 4);
    assert.deepEqual(p.thirds, [[0, 26], [26, 53], [53, 80]]);
  }
  // too short for walk-forward: said, not faked
  assert.match(S.studyPlan(dates.slice(0, 8)).wfReason, /needs at least 10 in-sample sessions/);
});

test('a configuration is measured exactly as perf measures each window; its day records are not kept', () => {
  const sessions = E.syntheticCalendar(60, { iv: 13 }, 2);
  const days = A.fromRun(freshCompute().evaluate({ strategy: 'straddle' }, sessions)).days;
  const plan = S.studyPlan(sessions.map((s: any) => s.date), { folds: 3 });
  const regimes = S.volRegimes(sessions, plan.isEnd);
  const sm = S.summarise(days, plan, regimes, { capital: 500000 });
  const perfOf = (w: number[]) => A.perf(days.slice(w[0], w[1]), { capital: 500000 });
  for (const [name, w] of [['train', plan.split.train], ['validation', plan.split.validation], ['test', plan.split.test], ['is', [0, plan.isEnd]], ['full', [0, plan.n]]] as const) {
    const p = perfOf(w as number[]);
    for (const k of ['net', 'traded', 'sharpe', 'pf', 'win_rate', 'max_dd', 'sessions', 'ret_pct']) assert.equal(sm[name][k], p[k], `${name}.${k}`);
  }
  plan.folds.forEach((f: any, k: number) => { assert.equal(sm.folds[k].train.net, perfOf(f.train).net); assert.equal(sm.folds[k].test.net, perfOf(f.test).net); });
  // per-block sums match a plain loop
  const [a, b] = plan.blocks[1];
  const vals = days.slice(a, b).filter((d: any) => d.status !== 'excluded').map((d: any) => (d.traded ? d.net : 0));
  assert.equal(sm.blocks[1].s, vals.reduce((x: number, y: number) => x + y, 0));
  assert.equal(sm.blocks[1].c, vals.length);
  // streaks: the longest runs of winning and losing traded days in the window
  const tr = days.slice(0, plan.isEnd).filter((d: any) => d.status !== 'excluded' && d.traded);
  let w = 0, l = 0, bw = 0, bl = 0;
  for (const d of tr) { if (d.net > 0) { w++; l = 0; bw = Math.max(bw, w); } else { l++; w = 0; bl = Math.max(bl, l); } }
  assert.deepEqual([sm.is.streak_win, sm.is.streak_loss], [bw, bl]);
  assert.ok(!('days' in sm));
  assert.throws(() => S.summarise(days.slice(1), plan, regimes), /returned 59 sessions; the study has 60/);
});

/** A small set of measured configurations to choose from (synthetic straddle, varied stop and target). */
function measured() {
  const sessions = E.syntheticCalendar(80, { iv: 14 }, 5);
  const plan = S.studyPlan(sessions.map((s: any) => s.date), { folds: 3 });
  const regimes = S.volRegimes(sessions, plan.isEnd);
  const compute = freshCompute();
  const cands: any[] = [];
  let idx = 0;
  for (const sl_pct of [20, 36, 60]) for (const target_per_lot of [500, 1000, 2000]) for (const reentry_enabled of [true, false]) {
    const days = A.fromRun(compute.evaluate({ strategy: 'straddle', sl_pct, target_per_lot, reentry_enabled }, sessions)).days;
    cands.push({ idx: idx++, summary: S.summarise(days, plan, regimes, { capital: 500000 }) });
  }
  return { plan, cands };
}

test('the held-out test chooses nothing: scrambling every test result changes no answer, rank or check', () => {
  const { plan, cands } = measured();
  const o = { objective: 'sharpe', topK: 5 };
  const a = S.selectStudy(cands, plan, o);
  const scrambled = cands.map((c: any, i: number) => { const x = clone(c); x.summary.test = clone(cands[(i * 7 + 3) % cands.length].summary.test); x.summary.test.net = (i % 2 ? 1 : -1) * 1e9; x.summary.test.sharpe = i * 100; return x; });
  assert.deepEqual(S.selectStudy(scrambled, plan, o), a);
  // a configuration that is the worst in-sample but wins the test window by a mile is never chosen
  const worst = cands[a.ranking[a.ranking.length - 1]];
  const sneaky = clone(worst); sneaky.idx = 999; sneaky.summary.test.net = 1e12; sneaky.summary.test.sharpe = 1e6; sneaky.summary.full.net = 1e12;
  const b = S.selectStudy([...cands, sneaky], plan, o);
  assert.notEqual(b.leader, 999); assert.notEqual(b.best_oos, 999); assert.ok(!b.finalists.includes(999));
  for (const objective of ['net', 'sharpe', 'pf', 'min_dd', 'calmar', 'win_rate']) {
    const r = S.selectStudy(cands, plan, { objective, topK: 5 });
    assert.deepEqual(S.selectStudy(scrambled, plan, { objective, topK: 5 }), r, objective);
  }
});

test('answers are reproducible: the same measurements in any order give the same ranking and answers', () => {
  const { plan, cands } = measured();
  const o = { objective: 'calmar', topK: 6 };
  const a = S.selectStudy(cands, plan, o);
  const shuffled = cands.slice().reverse();
  const b = S.selectStudy(shuffled, plan, o);
  for (const k of ['ranking', 'leader', 'best_oos', 'finalists', 'pbo', 'walk_forward', 'rank_corr_train_val']) assert.deepEqual(b[k], a[k], k);
  // the leader really is the best on training; best out-of-sample is the best validation among the top 6 by training
  const tr = (i: number) => A.scoreAll([cands.find((c: any) => c.idx === i).summary.train], 'calmar', a.min_trades.train)[0];
  assert.ok(cands.every((c: any) => tr(c.idx) <= tr(a.leader)));
  const top = a.ranking.slice(0, 6);
  assert.ok(top.includes(a.best_oos));
  const va = (i: number) => A.scoreAll([cands.find((c: any) => c.idx === i).summary.validation], 'calmar', a.min_trades.validation)[0];
  assert.ok(top.every((i: number) => va(i) <= va(a.best_oos)));
  // walk-forward picks each fold's configuration on that fold's training window only
  a.walk_forward.folds.filter((f: any) => f.chosen != null).forEach((f: any, k: number) => {
    const sc = (i: number) => A.scoreAll([cands.find((c: any) => c.idx === i).summary.folds[k].train], 'calmar', Math.max(2, Math.round(a.min_trades.train / 2)))[0];
    assert.ok(cands.every((c: any) => sc(c.idx) <= sc(f.chosen)), `fold ${k}`);
  });
});

test('PBO from the per-block sums equals the existing implementation on the same blocks', () => {
  const sessions = E.syntheticCalendar(50, { iv: 13 }, 3);
  const plan = S.studyPlan(sessions.map((s: any) => s.date), {}); // in-sample = 40 sessions, 8 blocks of 5
  assert.equal(plan.isEnd, 40); assert.equal(plan.blocks.length, 8);
  const compute = freshCompute();
  const cands: any[] = [], evals: any[] = [];
  [25, 36, 50, 70, 90].forEach((sl_pct, idx) => {
    const days = A.fromRun(compute.evaluate({ strategy: 'straddle', sl_pct }, sessions)).days;
    cands.push({ idx, summary: S.summarise(days, plan, null) });
    evals.push({ days: days.slice(0, 40) });
  });
  const ours = S.pboFromBlocks(cands, 'per_session'), theirs = A.pbo(evals, { blocks: 8, minBlock: 5 });
  assert.equal(ours.pbo, theirs.pbo); assert.equal(ours.combinations, theirs.combinations); // C(8,4) = 70
  assert.equal(ours.combinations, 70);
  assert.match(S.pboFromBlocks(cands.slice(0, 3), 'per_session').reason, /at least 4 configurations/);
});

test('robustness: each component is a share that can be checked by hand; the score is their plain mean', () => {
  const w = (net: number, traded = 3) => ({ net, traded });
  const sm: any = {
    folds: [{ test: w(10) }, { test: w(-5) }, { test: w(0, 0) }, { test: w(7) }], // 2 of 3 with trades made money
    thirds: [w(5), w(5), w(-1)], regimes: { low: w(3), mid: w(-2), high: w(0, 0) }, validation: w(4), is: w(100),
  };
  const r = S.robustScore(sm, [{ is: w(50) }, { is: w(-10) }, { is: w(30) }, { is: w(5) }], { is: w(40) });
  assert.deepEqual(r.components, { folds: 2 / 3, thirds: 2 / 3, regimes: 1 / 2, validation: 1, neighbours: 3 / 4, slippage: 0.4 });
  assert.ok(Math.abs(r.score - (2 / 3 + 2 / 3 + 1 / 2 + 1 + 3 / 4 + 0.4) / 6) < 1e-12);
  // what could not be measured is left out, not counted as zero
  const r2 = S.robustScore({ ...sm, folds: [] }, null, null);
  assert.equal(r2.components.folds, null); assert.equal(r2.measured, 3); // thirds, regimes, validation
  // a stressed run that loses scores 0 on slippage; the most robust is the highest score, then in-sample score, then index
  assert.equal(S.robustScore(sm, null, { is: w(-1) }).components.slippage, 0);
  const pick = S.mostRobust([{ idx: 3, is_score: 1, robust: { score: 0.5 } }, { idx: 1, is_score: 2, robust: { score: 0.5 } }, { idx: 2, is_score: 2, robust: { score: 0.5 } }, { idx: 0, is_score: 9, robust: { score: null } }]);
  assert.equal(pick.idx, 1);
});
