// Analytics tests: node --test tests/  (run from web/). Expected values are worked out by hand in the comments,
// or are properties that must hold whatever the data (no look-ahead, determinism, small samples read as inconclusive).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const A = require('../public/engine/analytics.js');
const L = require('../public/engine/ledger.js');
const E = require('../public/engine/engine.js');
const F = require('../public/engine/fourleg_engine.js');
const compute = require('../public/engine/compute.js')(E, F, L);

const near = (a, b, tol = 1e-6) => assert.ok(Math.abs(a - b) <= tol, `${a} !~ ${b}`);
const day = (date, net, extra) => Object.assign({ date, status: 'traded', traded: true, net, gross: net + 20, costs: 20, util_pct: 50, peak_margin: 200000, exit_reason: net > 0 ? 'target' : 'eod' }, extra || {});
const idle = (date) => ({ date, status: 'no_entry', traded: false, net: 0, gross: 0, costs: 0, util_pct: 0, peak_margin: 0, exit_reason: null });
const dates = (n, start = '2025-01-06') => { const out = []; let t = Date.parse(start + 'T00:00:00Z'); while (out.length < n) { const d = new Date(t); if (d.getUTCDay() % 6) out.push(d.toISOString().slice(0, 10)); t += 86400000; } return out; };

// ------------------------------------------------------------------ statistics
test('t intervals: n = 3 uses 4.303, one observation has no interval', () => {
  near(A.t95(2), 4.303); near(A.t95(30), 2.042); near(A.t95(1000), 1.96);
  // [1,2,3]: mean 2, sd 1, se 1/sqrt(3) = 0.57735; half-width 4.303 x 0.57735 = 2.4843
  const c = A.ciMean([1, 2, 3]);
  near(c.mean, 2); near(c.sd, 1); near(c.lo, 2 - 2.4843, 1e-4); near(c.hi, 2 + 2.4843, 1e-4); near(c.t, 2 / 0.57735, 1e-4);
  const one = A.ciMean([5]);
  assert.equal(one.lo, null); assert.equal(one.hi, null);
});

test('normal CDF and inverse, Spearman', () => {
  near(A.normCdf(1.96), 0.975, 1e-4); near(A.normCdf(0), 0.5, 1e-7); near(A.normCdf(-1), 0.158655, 1e-5);
  near(A.normInv(0.975), 1.959964, 1e-5); near(A.normInv(0.5), 0, 1e-9);
  near(A.spearman([1, 2, 3, 4], [10, 20, 30, 40]), 1); near(A.spearman([1, 2, 3, 4], [4, 3, 2, 1]), -1);
});

test('maximum drawdown: path 100, -50, -70, 30, 200 peaks at 100 and bottoms at -20', () => {
  const d = A.maxDrawdown([100, -50, -70, 30, 200]);
  near(d.dd, -120); assert.equal(d.from, 0); assert.equal(d.to, 2);
});

test('perf: traded-day and per-session statistics; excluded days never count', () => {
  const ds = dates(5);
  const days = [day(ds[0], 100), day(ds[1], -50), idle(ds[2]), Object.assign(day(ds[3], 999), { status: 'excluded', traded: false }), day(ds[4], 200)];
  const p = A.perf(days, { capital: 100000 });
  assert.equal(p.sessions, 4); assert.equal(p.traded, 3); assert.equal(p.excluded, 1);
  near(p.net, 250); near(p.win_rate, 200 / 3); near(p.pf, 300 / 50); near(p.payoff, 150 / 50);
  near(p.per_session, 250 / 4); near(p.max_dd, -50); near(p.max_dd_pct, -0.05); near(p.idle_pct, 25);
  near(p.costs, 60); near(p.costs_pct_gross_profit, 100 * 60 / (120 + 220)); // gross: 120, -30, 220
  assert.equal(p.sample.key, 'none');
  assert.equal(p.cagr, null); // under a year: no CAGR
});

// ------------------------------------------------------------------ adapter
test('fromRun: per-session P&L is the change in ledger equity; days the ledger never saw stay excluded', () => {
  const daily = [
    { date: '2025-10-06', status: 'traded', trades: 2, gross_realised: 500, charges: 50, net_realised: 450, closing_balance: 100450, peak_util_pct: 40, peak_margin: 40000, rejected: 0, exit_reason: 'target', reason: '' },
    { date: '2025-10-08', status: 'no_entry', trades: 0, gross_realised: 0, charges: 0, net_realised: 0, closing_balance: 100450, peak_util_pct: 0, peak_margin: 0, rejected: 0, exit_reason: '', reason: 'filter' },
  ];
  const results = [{ date: '2025-10-06', status: 'traded', is_expiry_day: false, dte: 3 }, { date: '2025-10-07', status: 'excluded', reason: 'gaps' }, { date: '2025-10-08', status: 'no_entry', is_expiry_day: false, dte: 1 }];
  const { days, capital } = A.fromRun({ account: { daily, config: { initial_capital: 100000 } }, results });
  assert.equal(capital, 100000); assert.equal(days.length, 3);
  near(days[0].net, 450); assert.equal(days[0].traded, true); assert.equal(days[0].dte, 3);
  assert.equal(days[1].status, 'excluded'); assert.equal(days[1].reason, 'gaps');
  near(days[2].net, 0); assert.equal(days[2].traded, false);
});

// ------------------------------------------------------------------ regime features
function session(date, closes, source = 'dhan', t0 = 555) {
  return { date, source, times: closes.map((_, i) => t0 + i), und: { o: closes.slice(), h: closes.slice(), l: closes.slice(), c: closes.slice() }, meta: { flags: [] } };
}
const geo = (start, step, n) => Array.from({ length: n }, (_, k) => start * Math.exp(k * step));

test('session features: realised vol, range, trend and efficiency from known candles', () => {
  // 61 one-minute closes rising by exactly 0.1% (log) per bar: sum of squared returns = 60 x 1e-6.
  // RV = sqrt(60e-6 x 252) = 12.296% annualised; open 100, close 100e^0.06: +6.18%; range = the whole move, efficiency 1.
  const [f] = A.sessionFeatures([session('2025-10-06', geo(100, 0.001, 61))]);
  near(f.rv_pct, Math.sqrt(60e-6 * 252) * 100, 1e-9);
  near(f.ret_pct, 100 * (Math.exp(0.06) - 1), 1e-9); near(f.range_pct, 100 * (Math.exp(0.06) - 1), 1e-9); near(f.efficiency, 1);
  // opening range = first 30 bars
  near(f.or_range_pct, 100 * (Math.exp(0.029) - 1), 1e-9);
  assert.equal(f.gap_pct, null); assert.match(f.gap_note, /first session/);
});

test('gaps look only at the previous stored session, and stop when more than one weekday is missing', () => {
  const s = [session('2025-10-06', geo(100, 0, 40)), session('2025-10-08', geo(101, 0, 40)), session('2025-10-13', geo(99, 0, 40))];
  const f = A.sessionFeatures(s);
  near(f[1].gap_pct, 1); assert.match(f[1].gap_note, /one weekday not stored/);   // Tue 7th missing: measured, with a note
  assert.equal(f[2].gap_pct, null); assert.match(f[2].gap_note, /2 weekdays not stored/);         // Thu 9th and Fri 10th missing: no gap
});

test('synthetic sessions get no cross-session features', () => {
  const f = A.sessionFeatures([session('2099-01-05', geo(24000, 0.0005, 40), 'synthetic'), session('2099-01-06', geo(24000, -0.0005, 40), 'synthetic')]);
  assert.equal(f[1].gap_pct, null); assert.match(f[1].gap_note, /synthetic/);
  assert.ok(f[1].rv_prev_pct > 0); // previous-session volatility is still a fact about an earlier session
});

test('ATR uses only earlier sessions and needs a full window', () => {
  const ds = dates(4, '2025-10-06');
  const s = ds.map((d, i) => session(d, [100 + i, 102 + i, 101 + i].concat(new Array(30).fill(101 + i))));
  const f = A.sessionFeatures(s, { atrN: 2 });
  assert.equal(f[0].atr_prior_pct, null); assert.equal(f[1].atr_prior_pct, null); assert.equal(f[2].atr_prior_pct, null); // session 0 has no true range
  near(f[3].atr_prior_pct, (f[1].tr_pct + f[2].tr_pct) / 2);
});

test('no look-ahead: features and percentile labels of a day do not change when later days are added', () => {
  const R = A.rng(3), ds = dates(60, '2025-01-06');
  const s = ds.map((d) => session(d, geo(100 + 5 * R(), (R() - 0.5) * 0.002, 120)));
  const full = A.sessionFeatures(s, { atrN: 5, ccN: 5 }), prefix = A.sessionFeatures(s.slice(0, 35), { atrN: 5, ccN: 5 });
  prefix.forEach((f, i) => assert.deepEqual(f, full[i]));
  const lf = A.classify(full, { mode: 'percentile', thresholds: { minHistory: 10 } }), lp = A.classify(prefix, { mode: 'percentile', thresholds: { minHistory: 10 } });
  for (const d of lp.dims) for (const date of Object.keys(d.labels)) assert.equal(d.labels[date], lf.dims.find((x) => x.key === d.key).labels[date], `${d.key} ${date}`);
  assert.equal(lf.dims[0].labels[ds[5]], 'Warm-up');
});

test('fixed thresholds: 12.3% realised vol is Normal; +6.2% is Strong bullish; efficiency 1 is Trending', () => {
  const f = A.sessionFeatures([session('2025-10-06', geo(100, 0.001, 61))]);
  const c = A.classify(f);
  const lab = (k) => c.dims.find((d) => d.key === k).labels['2025-10-06'];
  assert.equal(lab('vol'), 'Normal'); assert.equal(lab('trend'), 'Strong bullish'); assert.equal(lab('shape'), 'Trending'); assert.equal(lab('range'), 'High range');
  assert.equal(lab('vol_prev'), 'Unknown');
  assert.ok(c.unavailable.some((u) => u.key === 'india_vix')); // VIX is reported as missing, never made up
});

test('regime breakdown: per-label totals add up to the whole run and consistency counts positive regimes', () => {
  const ds = dates(12);
  const days = ds.map((d, i) => day(d, i < 6 ? 100 : -40));
  const cls = { dims: [{ key: 'vol', label: 'Vol', timing: 'ex-post', basis: '', order: ['Low', 'High'], labels: Object.fromEntries(ds.map((d, i) => [d, i < 6 ? 'Low' : 'High'])) }] };
  const r = A.regimeBreakdown(days, cls, { capital: 100000 });
  const rows = r.dims[0].rows;
  near(rows[0].p.net + rows[1].p.net, r.total.net); near(rows[0].p.net, 600); near(rows[1].p.net, -240);
  assert.equal(r.dims[0].consistency.positive, 1); assert.equal(r.dims[0].consistency.judged, 2);
  assert.equal(r.dims[0].consistency.best, 'Low'); assert.equal(r.dims[0].consistency.worst, 'High');
});

// ------------------------------------------------------------------ optimisation building blocks
test('candidates: grid is the full product with your settings first; random is seeded and unique; grid over budget fails loudly', () => {
  const base = { a: 1, b: 'x', other: 7 };
  const g = A.planCandidates(base, [{ key: 'a', values: [1, 2] }, { key: 'b', values: ['x', 'y'] }], { method: 'grid' });
  assert.equal(g.candidates.length, 4); assert.deepEqual(g.candidates[0], base); assert.ok(g.candidates.every((c) => c.other === 7));
  const r1 = A.planCandidates(base, [{ key: 'a', min: 1, max: 50, step: 1, kind: 'range' }], { method: 'random', budget: 10, seed: 5 });
  const r2 = A.planCandidates(base, [{ key: 'a', min: 1, max: 50, step: 1, kind: 'range' }], { method: 'random', budget: 10, seed: 5 });
  assert.deepEqual(r1.candidates, r2.candidates); assert.equal(new Set(r1.candidates.map((c) => c.a)).size, r1.candidates.length);
  assert.throws(() => A.planCandidates(base, [{ key: 'a', values: Array.from({ length: 30 }, (_, i) => i) }, { key: 'b', values: Array.from({ length: 30 }, (_, i) => i) }], { method: 'grid', budget: 100 }), /900 combinations/);
  assert.equal(A.planCandidates(base, [{ key: 'a', values: Array.from({ length: 30 }, (_, i) => i) }, { key: 'b', values: Array.from({ length: 30 }, (_, i) => i) }], { budget: 100 }).method, 'random');
});

test('chronological split and walk-forward windows never overlap, and choices use only the training window', () => {
  assert.deepEqual(A.splitChrono(10), { train: [0, 6], validation: [6, 8], test: [8, 10] });
  const ds = dates(40);
  // candidate 0 (your settings): flat +5. Candidate 1: great in every TRAINING window position (first 20), bad later.
  // Candidate 2: bad early, great late. Walk-forward with train 20 / test 5 must pick 1 on the first fold.
  const mk = (fn) => ({ params: {}, days: ds.map((d, i) => day(d, fn(i))) });
  const evals = [mk(() => 5), mk((i) => (i < 20 ? 50 : -50)), mk((i) => (i < 20 ? -50 : 50))];
  const wf = A.walkForward(evals, ds, { mode: 'rolling', train: 20, test: 5, objective: 'net', minTrades: 1 });
  assert.equal(wf.folds[0].chosen, 1);
  for (const f of wf.folds) { assert.ok(f.train[1] < f.test[0]); assert.equal(f.train_idx[1], f.test_idx[0]); }
  // Leakage check: rewriting the TEST windows of every candidate cannot change any choice.
  const evals2 = evals.map((e) => ({ params: {}, days: e.days.map((d, i) => (i >= 20 ? Object.assign({}, d, { net: 1000 * Math.random() - 500 }) : d)) }));
  const wf2 = A.walkForward(evals2, ds, { mode: 'rolling', train: 20, test: 5, objective: 'net', minTrades: 1 });
  assert.equal(wf2.folds[0].chosen, wf.folds[0].chosen);
  const an = A.walkForward(evals, ds, { mode: 'anchored', train: 20, test: 5, objective: 'net', minTrades: 1 });
  assert.ok(an.folds.every((f) => f.train_idx[0] === 0));
});

test('PBO: one configuration best everywhere gives 0; each one lucky in a single block gives 1', () => {
  const ds = dates(40);
  const mk = (fn) => ({ params: {}, days: ds.map((d, i) => day(d, fn(i))) });
  const clean = [mk(() => 10), mk(() => 5), mk(() => 1), mk(() => -3)];
  assert.equal(A.pbo(clean, { blocks: 8, minBlock: 5 }).pbo, 0);
  // 8 blocks of 5 sessions; candidate k earns +100 only in block k and -1 elsewhere. The in-sample winner's good
  // block is never in its own out-of-sample half, while four other candidates' good blocks are: always below median.
  const lucky = Array.from({ length: 8 }, (_, k) => mk((i) => (Math.floor(i / 5) === k ? 100 : -1)));
  const p = A.pbo(lucky, { blocks: 8, minBlock: 5 });
  assert.equal(p.combinations, 70); assert.equal(p.pbo, 1);
  assert.equal(A.pbo(clean.slice(0, 3)).status, 'not_run');
});

test('deflated Sharpe: PSR by hand; more trials lower it', () => {
  // SR 0.1 per period, T = 101, normal returns: z = 0.1 x 10 / sqrt(1 + 0.5 x 0.01) = 0.99751, PSR = 0.8407
  const one = A.deflatedSharpe(0.1, 101, 0, 3, 1, 0);
  near(one.psr, A.normCdf(1 / Math.sqrt(1.005)), 1e-9); near(one.psr, 0.8407, 1e-3); near(one.dsr, one.psr);
  const many = A.deflatedSharpe(0.1, 101, 0, 3, 100, 0.01);
  assert.ok(many.sr0 > 0 && many.dsr < one.psr);
});

test('Monte Carlo: deterministic with a seed; a constant series has no spread; all losses lose every path', () => {
  const a = A.monteCarlo([10, -5, 20, -15, 30, 5], { paths: 500, seed: 9 }), b = A.monteCarlo([10, -5, 20, -15, 30, 5], { paths: 500, seed: 9 });
  assert.deepEqual(a, b);
  const c = A.monteCarlo([10, 10, 10, 10], { paths: 200 });
  near(c.total.p5, 40); near(c.total.p95, 40); near(c.p_loss, 0); near(c.dd.p95, 0);
  near(A.monteCarlo([-1, -2, -3], { paths: 100 }).p_loss, 1);
  assert.equal(A.monteCarlo([5]).status, 'not_run');
});

// ------------------------------------------------------------------ studies with a known runner
// Fake market: 60 sessions. Parameter x in 1..9. Training+validation (first 48 sessions) favour x = 5 smoothly;
// the held-out test (last 12) secretly favours x = 9. Slippage costs 40 per traded day per point.
function fakeRunner(p) {
  const ds = dates(60);
  return { days: ds.map((d, i) => {
    const x = p.x, slip = p.slip_pct;
    const edge = i < 48 ? 60 - 10 * Math.abs(x - 5) : (x === 9 ? 200 : -20);
    const noise = ((i * 7919) % 13) - 6;
    return day(d, edge + noise - 40 * slip);
  }) };
}

test('optimisation: selection never looks at the test window, your settings are untouched, top 10 is ranked', async () => {
  const base = { x: 2, slip_pct: 0.5, brokerage_per_order: 20 };
  const frozen = JSON.stringify(base);
  const st = await A.runOptimisation({ base, axes: [{ key: 'x', label: 'x', kind: 'range', min: 1, max: 9, step: 1 }], options: { objective: 'net', mcPaths: 200, split: { train: 0.6, validation: 0.2, test: 0.2 } } }, fakeRunner);
  assert.equal(JSON.stringify(base), frozen);
  assert.equal(st.configs_tested, 9); assert.equal(st.method, 'grid');
  assert.equal(st.selected.params.x, 5); // x = 9 wins only in the held-out test, so it must not be chosen
  assert.equal(st.original.params.x, 2); assert.ok(st.top.length <= 10);
  for (let i = 1; i < st.top.length; i++) assert.ok(st.top[i - 1].score_train >= st.top[i].score_train);
  assert.deepEqual(st.split.train.slice(2), [36]); assert.equal(st.split.test[2], 12);
  // break-even slippage: training-window edge at x = 5 is +60 a day; the whole window's net crosses zero where
  // 48 x 60 + 12 x (-20) + noise = 60 x 40 x s  ->  s ≈ 1.1. Bisection on [0.5, 5.5] is within 5/2^6 of it.
  const be = st.stress.selected.break_even_slip;
  const netAt = (s) => fakeRunner({ x: 5, slip_pct: s }).days.reduce((a, d) => a + d.net, 0);
  assert.ok(netAt(be - 0.08) > 0 && netAt(be + 0.08) < 0, `break-even ${be}`);
  // sensitivity around x = 5 on train+validation: neighbours keep part of the score
  const sx = st.sensitivity[0];
  assert.ok(sx.rows.some((r) => r.value === 4) && sx.rows.some((r) => r.value === 6)); assert.ok(sx.retention > 0 && sx.retention < 1);
});

test('robustness: 3 traded days reads Inconclusive and is capped; a long clean sample is not capped', async () => {
  const ds = dates(3);
  const small = A.robustness({ perf: A.perf(ds.map((d) => day(d, 500)), { capital: 500000 }), data: { sessions: 3 } });
  assert.equal(small.verdict.key, 'inconclusive'); assert.ok(small.score <= 30); assert.equal(small.statistical.grade, 'Inconclusive');
  // 300 sessions with a steady edge. Without the extra checks too few components exist, so it still reads inconclusive.
  const big = dates(300), R = A.rng(4), noise = big.map(() => 400 * (R() - 0.4));
  const runner = (p) => ({ days: big.map((d, i) => day(d, 300 + noise[i] - 40 * (p.slip_pct - 0.5) - 5 * Math.abs(p.x - 3))) });
  const base = { x: 3, slip_pct: 0.5, brokerage_per_order: 20 };
  const p = A.perf(runner(base).days, { capital: 500000 });
  const bare = A.robustness({ perf: p, data: { sessions: 300 } });
  assert.equal(bare.verdict.key, 'inconclusive'); assert.match(bare.verdict.why, /Too few components/);
  const check = await A.runCheck({ base, axes: [{ key: 'x', values: [1, 2, 3, 4, 5] }], options: { mcPaths: 300 } }, runner);
  const r = A.robustness({ perf: p, check, data: { sessions: 300 } });
  assert.equal(r.cap, 100); assert.notEqual(r.verdict.key, 'inconclusive');
  assert.equal(r.components.length, 10);
  assert.ok(r.components.every((c) => c.formula && c.weight > 0));
  assert.match(r.statistical.grade, /Strong/);
  assert.ok(r.coverage >= 0.6);
  // the same edge on 20 days is capped and inconclusive whatever its components say
  const short = A.robustness({ perf: A.perf(runner(base).days.slice(0, 20), { capital: 500000 }), check, data: { sessions: 20 } });
  assert.equal(short.verdict.key, 'inconclusive'); assert.ok(short.score <= 30);
});

test('assistant: every number it writes comes from a fact it lists, or from a computed result it was given', () => {
  const run = compute.run({ strategy: 'straddle', days: 60, seed: 2, iv: 13 });
  const lr = compute.lastRun();
  const view = Object.assign(A.fromRun(lr), { strategy: 'straddle', source: 'synthetic', sessions: lr.sessions, data: { synthetic: true }, meta: { oneLine: 'Sell the ATM straddle.' } });
  const out = A.analyseRun(view);
  near(out.perf.net, run.net, 1e-6); // the analysis reads the same ledger the page shows
  const norm = (s) => s.replace(/[₹,+−\-%]/g, '');
  const pool = [JSON.stringify(out.robustness), 'Sell the ATM straddle.', '95 50 30 250 100'].join(' ');
  for (const sec of out.assistant.sections) for (const s of sec.sentences) {
    const facts = s.refs.map((id) => out.assistant.facts.find((f) => f.id === id));
    assert.ok(facts.every(Boolean), `unknown fact in: ${s.text}`);
    for (const tok of s.text.match(/[\d][\d,]*(\.\d+)?/g) || []) {
      const t = norm(tok);
      assert.ok(facts.some((f) => norm(f.text).includes(t)) || norm(pool).includes(t), `"${tok}" in "${s.text}" has no source`);
    }
  }
  assert.equal(out.assistant.cost_inr, 0); assert.equal(out.assistant.model, null);
});

// ------------------------------------------------------------------ chronological models
test('models are gated by sample size and say why', () => {
  const f = A.sessionFeatures(dates(10).map((d) => session(d, geo(100, 0.0005, 60))));
  for (const m of [A.kmeansRegimes(f), A.hmmVol(f), A.volForecast(f)]) { assert.equal(m.status, 'not_run'); assert.match(m.reason, /this range has (9|10)$/); }
});

test('HMM recovers two volatility states from a known switching series, using only filtered probabilities', () => {
  const R = A.rng(21), ds = dates(200);
  const truth = ds.map((_, i) => (Math.floor(i / 25) % 2 === 0 ? 8 : 20));
  const feats = ds.map((d, i) => ({ date: d, rv_pct: truth[i] * Math.exp(0.1 * (R() - 0.5)), rv_prev_pct: null }));
  const h = A.hmmVol(feats);
  assert.equal(h.status, 'ok');
  near(h.states[0].rv_pct, 8, 1); near(h.states[1].rv_pct, 20, 2.5);
  const hits = ds.filter((d, i) => (h.labels[d] === 'High-vol state') === (truth[i] === 20)).length;
  assert.ok(hits / ds.length > 0.9, `accuracy ${hits / ds.length}`);
});

test('volatility forecast: a persistent series is forecast better than its mean, scored only on later sessions', () => {
  const R = A.rng(8), ds = dates(150);
  let x = Math.log(12); const rv = [];
  for (let i = 0; i < ds.length; i++) { x = Math.log(12) + 0.85 * (x - Math.log(12)) + 0.15 * (R() - 0.5) * 2; rv.push(Math.exp(x)); }
  const feats = ds.map((d, i) => ({ date: d, rv_pct: rv[i], rv_prev_pct: i ? rv[i - 1] : null }));
  const v = A.volForecast(feats);
  assert.equal(v.status, 'ok'); assert.ok(v.coef.b > 0.6 && v.coef.b < 1.05, `b ${v.coef.b}`); assert.ok(v.beats_mean);
  assert.equal(v.test_sessions, feats.filter((f) => f.rv_prev_pct).length - Math.floor(feats.filter((f) => f.rv_prev_pct).length * 0.6));
});

// ------------------------------------------------------------------ end to end on the real engines
test('end to end: optimise the straddle on synthetic sessions with the real engine and ledger', async () => {
  const base = { strategy: 'straddle', days: 60, seed: 1, iv: 13, sl_pct: 36, target_per_lot: 1000, reentry_enabled: true, entry_condition: 'full', lots: 1, strike_offset: 0, slip_pct: 0.5, capital: 500000, margin_policy: 'reject', margin_span_pct: 9, margin_exposure_pct: 2, brokerage_per_order: 20 };
  const runner = (p) => A.fromRun(compute.evaluate(p));
  const st = await A.runOptimisation({ base, axes: [{ key: 'sl_pct', values: [30, 36, 45] }, { key: 'reentry_enabled', values: [true, false] }], options: { objective: 'sharpe', mcPaths: 200 } }, runner);
  assert.equal(st.configs_tested, 6); assert.equal(st.original.params.sl_pct, 36);
  // the original's full-window net equals a normal Lab run with the same settings
  near(st.original.full.net, compute.run(base).net, 1e-6);
  const all = A.analyseRun(Object.assign(runner(base), { strategy: 'straddle', source: 'synthetic', sessions: compute.lastRun().sessions, data: { synthetic: true } }), { study: st });
  assert.ok(all.diagnostics.overfitting.length >= 3);
  assert.equal(all.regimes.dims.some((d) => d.key === 'gap'), false); // synthetic: no gap dimension
});
