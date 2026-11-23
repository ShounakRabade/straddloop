/* Straddloop optimisation studies: how a configuration is measured, and how the answers are chosen.
 *
 * A study measures every configuration on windows fixed before any configuration runs (studyPlan), keeps only those
 * measurements (summarise; never the day records), and chooses from the in-sample part alone:
 *
 *   sessions  [0 ........................ isEnd) [isEnd ...... n)
 *              training [0, a)  validation [a, isEnd)   held-out test
 *
 * Walk-forward folds, PBO blocks, the thirds and the volatility regimes all lie inside [0, isEnd). The held-out test is
 * measured for every configuration (so it costs no extra run) but nothing here reads it to rank, filter or choose: it
 * is reported for the three answers only. Pure calculations, no DOM, no recursion; runs in the optimiser worker, on
 * the page and in Node.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./analytics.js'));
  else root.StraddloopStudy = factory(root.StraddloopAnalytics);
})(typeof self !== 'undefined' ? self : this, function (A) {
  'use strict';

  const VERSION = 'study-1';
  const ELIGIBLE = (d) => d.status !== 'excluded';
  const sum = (a) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]; return s; };
  const clamp01 = (x) => Math.max(0, Math.min(1, x));

  // ------------------------------------------------------------------ the windows
  /**
   * Windows every configuration is measured on, from the session dates alone. o: { split: { train, validation, test }
   * (fractions), folds (walk-forward test blocks inside the in-sample part, default 4), wfMode 'rolling' | 'anchored',
   * blocks (PBO, default 8) }.
   */
  function studyPlan(dates, o) {
    o = Object.assign({ split: { train: 0.6, validation: 0.2, test: 0.2 }, folds: 4, wfMode: 'rolling', blocks: 8, minBlock: 4 }, o || {});
    const n = dates.length, sp = A.splitChrono(n, o.split), isEnd = sp.validation[1];
    // walk-forward inside [0, isEnd): the first half trains, the rest is cut into `folds` test blocks; each fold trains
    // on the sessions just before its block (rolling, same length) or on everything before it (anchored)
    const folds = [];
    let wfReason = null;
    const trainLen = Math.round(isEnd / 2), k = Math.max(1, Math.round(o.folds));
    const testLen = Math.floor((isEnd - trainLen) / k);
    if (isEnd < 10 || testLen < 1) wfReason = `walk-forward needs at least 10 in-sample sessions and ${k} test blocks; this study has ${isEnd} in-sample sessions`;
    else for (let i = 0; i < k; i++) {
      const s = trainLen + i * testLen, e = i === k - 1 ? isEnd : s + testLen;
      folds.push({ train: [o.wfMode === 'anchored' ? 0 : s - trainLen, s], test: [s, e] });
    }
    // PBO blocks: an even number (4–8) of equal blocks of the in-sample part, each at least minBlock sessions
    let S = Math.max(4, Math.round(o.blocks / 2) * 2);
    while (S > 4 && isEnd / S < o.minBlock) S -= 2;
    const blocks = isEnd / S >= o.minBlock ? Array.from({ length: S }, (_, b) => [Math.floor(b * isEnd / S), Math.floor((b + 1) * isEnd / S)]) : [];
    const thirds = [0, 1, 2].map((t) => [Math.floor(t * isEnd / 3), Math.floor((t + 1) * isEnd / 3)]);
    const d = (i) => (i >= 0 && i < n ? dates[i] : null);
    return {
      version: VERSION, n, isEnd, wfMode: o.wfMode, wfReason,
      split: { train: sp.train, validation: sp.validation, test: sp.test },
      dates: { first: d(0), last: d(n - 1), train: [d(sp.train[0]), d(sp.train[1] - 1)], validation: [d(sp.validation[0]), d(sp.validation[1] - 1)], test: [d(sp.test[0]), d(sp.test[1] - 1)] },
      folds, blocks, thirds,
    };
  }

  /**
   * Volatility regime of each session, from the index alone: the session's high–low range as % of its first open, cut
   * at the terciles of the in-sample sessions (so the test part sets nothing). 'low' | 'mid' | 'high' | null.
   */
  function volRegimes(sessions, isEnd) {
    const rng = sessions.map((s) => {
      const u = s.und; let hi = -Infinity, lo = Infinity, open = null;
      for (let i = 0; i < u.o.length; i++) { if (u.o[i] != null && open == null) open = u.o[i]; if (u.h[i] != null && u.h[i] > hi) hi = u.h[i]; if (u.l[i] != null && u.l[i] < lo) lo = u.l[i]; }
      return open && isFinite(hi) && isFinite(lo) ? 100 * (hi - lo) / open : null;
    });
    const ins = rng.slice(0, isEnd).filter((x) => x != null).sort((a, b) => a - b);
    if (ins.length < 6) return rng.map(() => null);
    const q1 = A.quantile(ins, 1 / 3), q2 = A.quantile(ins, 2 / 3);
    return rng.map((x) => (x == null ? null : x <= q1 ? 'low' : x <= q2 ? 'mid' : 'high'));
  }

  // ------------------------------------------------------------------ measuring one configuration
  /** The figures a window keeps (enough to rank on any objective and to show the table). */
  function slim(p, days) {
    let sw = 0, sl = 0, w = 0, l = 0; // longest runs of winning / losing traded days
    for (const d of days) { if (!ELIGIBLE(d) || !d.traded) continue; if (d.net > 0) { w++; l = 0; if (w > sw) sw = w; } else { l++; w = 0; if (l > sl) sl = l; } }
    // per-session P&L sums (traded net, untraded 0) so windows can be pooled exactly (walk-forward)
    let s = 0, s2 = 0, c = 0, wins = 0, gw = 0, gl = 0;
    for (const d of days) { if (!ELIGIBLE(d)) continue; const v = d.traded ? d.net : 0; s += v; s2 += v * v; c++; if (d.traded) { if (d.net > 0) { wins++; gw += d.net; } else gl -= d.net; } }
    return {
      sessions: p.sessions, traded: p.traded, net: p.net, gross: p.gross, costs: p.costs, win_rate: p.win_rate, pf: p.pf, max_dd: p.max_dd,
      sharpe: p.sharpe, sortino: p.sortino, sr_period: p.sr_period, per_session: p.per_session, best: p.best, worst: p.worst, calmar: p.calmar,
      cagr: p.cagr, rom: p.rom, ret_pct: p.ret_pct, streak_win: sw, streak_loss: sl, s, s2, c, wins, gw, gl,
    };
  }
  const windowOf = (days, w) => days.slice(w[0], w[1]);

  /**
   * One configuration, measured on every window of the plan: the full period, training, validation, in-sample,
   * held-out test, each walk-forward fold (its training and test window), the thirds and volatility regimes of the
   * in-sample part, and the per-block sums PBO needs. `days` are its day records (analytics.fromRun) for all n
   * sessions; `regimes` from volRegimes. The day records themselves are not kept.
   */
  function summarise(days, plan, regimes, o) {
    o = Object.assign({ capital: 500000 }, o || {});
    if (days.length !== plan.n) throw new Error(`a configuration returned ${days.length} sessions; the study has ${plan.n}`);
    const m = (w) => { const ds = windowOf(days, w); return slim(A.perf(ds, o), ds); };
    const is = [0, plan.isEnd];
    const isDays = windowOf(days, is), isNets = isDays.filter(ELIGIBLE).map((d) => (d.traded ? d.net : 0));
    const mo = A.moments(isNets);
    const reg = {};
    for (const key of ['low', 'mid', 'high']) {
      let net = 0, traded = 0;
      for (let i = 0; i < plan.isEnd; i++) if (regimes && regimes[i] === key && ELIGIBLE(days[i]) && days[i].traded) { net += days[i].net; traded++; }
      reg[key] = { net, traded };
    }
    return {
      full: m([0, plan.n]), train: m(plan.split.train), validation: m(plan.split.validation), is: m(is), test: m(plan.split.test),
      folds: plan.folds.map((f) => ({ train: m(f.train), test: m(f.test) })),
      thirds: plan.thirds.map(m),
      regimes: reg,
      blocks: plan.blocks.map(([a, b]) => { let s = 0, s2 = 0, c = 0; for (let i = a; i < b; i++) { const d = days[i]; if (!ELIGIBLE(d)) continue; const v = d.traded ? d.net : 0; s += v; s2 += v * v; c++; } return { s, s2, c }; }),
      is_moments: { skew: mo.skew, kurt: mo.kurt, T: isNets.length },
    };
  }

  // ------------------------------------------------------------------ choosing
  const OBJECTIVES = A.OBJECTIVES;
  /** Scores of many summaries on one window (-Infinity = not eligible: too few traded days or no value). */
  function scores(cands, pick, objective, minTrades, weights) { return A.scoreAll(cands.map(pick), objective, minTrades, weights); }
  /** Indices ordered best first by score, ties by the lower candidate index: the same study always ranks the same. */
  function orderBy(cands, sc) { return cands.map((_, i) => i).sort((a, b) => (sc[b] - sc[a]) || (cands[a].idx - cands[b].idx)); }

  /** PBO by combinatorially symmetric cross-validation on per-block sums (Bailey et al. 2015); combinations built
   *  without recursion. */
  function pboFromBlocks(cands, objective) {
    const N = cands.length, S = cands.length ? cands[0].summary.blocks.length : 0;
    if (N < 4) return { status: 'not_run', reason: `needs at least 4 configurations; this study has ${N}` };
    if (S < 4) return { status: 'not_run', reason: 'too few in-sample sessions to cut into 4 or more blocks' };
    const val = (st, set) => { let s = 0, s2 = 0, c = 0; for (const b of set) { s += st[b].s; s2 += st[b].s2; c += st[b].c; } if (!c) return -Infinity;
      const mm = s / c; if (objective === 'per_session') return mm; const v = c > 1 ? (s2 - c * mm * mm) / (c - 1) : 0; return v > 0 ? mm / Math.sqrt(v) : (mm > 0 ? 1e9 : mm < 0 ? -1e9 : 0); };
    const half = S / 2, combos = [], idx = Array.from({ length: half }, (_, i) => i);
    for (;;) {
      combos.push(idx.slice());
      let i = half - 1; while (i >= 0 && idx[i] === S - half + i) i--;
      if (i < 0) break;
      idx[i]++; for (let j = i + 1; j < half; j++) idx[j] = idx[j - 1] + 1;
    }
    const stats = cands.map((c) => c.summary.blocks);
    const logits = [];
    for (const isSet of combos) {
      const oos = []; for (let b = 0; b < S; b++) if (!isSet.includes(b)) oos.push(b);
      const isv = stats.map((st) => val(st, isSet)), oosv = stats.map((st) => val(st, oos));
      let best = 0; isv.forEach((v, i) => { if (v > isv[best]) best = i; });
      const below = oosv.filter((v) => v < oosv[best]).length, ties = oosv.filter((v) => v === oosv[best]).length - 1;
      const w = (below + 0.5 * ties + 1) / (N + 1);
      logits.push(Math.log(w / (1 - w)));
    }
    return { status: 'ok', blocks: S, combinations: combos.length, configs: N, pbo: logits.filter((l) => l <= 0).length / logits.length };
  }

  /** Walk-forward with re-selection: in each fold, the best configuration on that fold's training window, and what it
   *  then did on the fold's test window (both inside the in-sample part). Pooled exactly from per-session sums. */
  function walkForward(cands, plan, o) {
    if (!plan.folds.length) return { status: 'not_run', reason: plan.wfReason || 'no folds', folds: [] };
    const folds = plan.folds.map((f, k) => {
      const sc = scores(cands, (c) => c.summary.folds[k].train, o.objective, o.foldMinTrades, o.weights);
      const ord = orderBy(cands, sc), best = ord[0];
      if (best == null || sc[best] === -Infinity) return { train: f.train, test: f.test, chosen: null, reason: 'no configuration met the minimum trades in this training window' };
      return { train: f.train, test: f.test, chosen: cands[best].idx, is: cands[best].summary.folds[k].train, oos: cands[best].summary.folds[k].test };
    });
    const used = folds.filter((f) => f.chosen != null);
    const S = sum(used.map((f) => f.oos.s)), S2 = sum(used.map((f) => f.oos.s2)), C = sum(used.map((f) => f.oos.c));
    const mean = C ? S / C : null, sd = C > 1 ? Math.sqrt(Math.max(0, (S2 - C * mean * mean) / (C - 1))) : null;
    const isMean = used.length ? sum(used.map((f) => f.is.per_session || 0)) / used.length : null;
    return {
      status: used.length >= 2 ? 'ok' : used.length ? 'thin' : 'not_run', reason: used.length ? null : 'no fold had an eligible configuration',
      mode: plan.wfMode, folds,
      oos: { net: sum(used.map((f) => f.oos.net)), traded: sum(used.map((f) => f.oos.traded)), sessions: C, per_session: mean, sharpe: mean != null && sd > 0 ? mean / sd * Math.sqrt(252) : null,
        positive_folds: used.filter((f) => f.oos.net > 0).length, folds: used.length },
      wfe: isMean && isMean > 0 && mean != null ? mean / isMean : null,
      distinct_choices: new Set(used.map((f) => f.chosen)).size,
    };
  }

  /**
   * The three answers and the study's checks, from the summaries. o: { objective, weights, minTrades, topK }.
   *  - in-sample leader: best on the training window. Not evidence.
   *  - best out-of-sample: best on the validation window among the top-K by training score.
   *  - finalists for "most robust": the top-K by in-sample score (training + validation) that meet the minimum trades;
   *    their robustness needs extra runs (neighbours, doubled slippage), scored by robustScore.
   * Nothing here reads the held-out test.
   */
  function selectStudy(cands, plan, o) {
    o = Object.assign({ objective: 'sharpe', minTrades: null, topK: 10 }, o || {});
    if (!cands.length) throw new Error('No configuration was evaluated.');
    const trainN = plan.split.train[1] - plan.split.train[0], valN = plan.split.validation[1] - plan.split.validation[0];
    const minTrades = o.minTrades != null ? o.minTrades : Math.max(3, Math.round(0.1 * trainN));
    const valMin = Math.max(1, Math.round(minTrades * valN / Math.max(1, trainN)));
    const isMin = minTrades + valMin;
    const sTrain = scores(cands, (c) => c.summary.train, o.objective, minTrades, o.weights);
    const sVal = scores(cands, (c) => c.summary.validation, o.objective, valMin, o.weights);
    const sIS = scores(cands, (c) => c.summary.is, o.objective, isMin, o.weights);
    const ordTrain = orderBy(cands, sTrain);
    const leader = ordTrain[0] != null && sTrain[ordTrain[0]] > -Infinity ? ordTrain[0] : null;
    const top = ordTrain.filter((i) => sTrain[i] > -Infinity).slice(0, o.topK);
    const ordTopVal = top.slice().sort((a, b) => (sVal[b] - sVal[a]) || (cands[a].idx - cands[b].idx));
    const bestOOS = ordTopVal[0] != null && sVal[ordTopVal[0]] > -Infinity ? ordTopVal[0] : null;
    const finalists = orderBy(cands, sIS).filter((i) => sIS[i] > -Infinity).slice(0, o.topK);
    const both = cands.map((_, i) => i).filter((i) => sTrain[i] > -Infinity && sVal[i] > -Infinity);
    const wf = walkForward(cands, plan, { objective: o.objective, weights: o.weights, foldMinTrades: Math.max(2, Math.round(minTrades / 2)) });
    const srs = cands.map((c) => c.summary.train.sr_period).filter((x) => x != null && isFinite(x));
    const srVar = srs.length > 1 ? A.sdev(srs) ** 2 : 0;
    const dsrOf = (i) => { if (i == null) return null; const s = cands[i].summary; return A.deflatedSharpe(s.is.sr_period, s.is_moments.T, s.is_moments.skew, s.is_moments.kurt, cands.length, srVar); };
    return {
      objective: o.objective, objective_label: OBJECTIVES[o.objective].label, min_trades: { train: minTrades, validation: valMin, in_sample: isMin },
      scores: { train: sTrain, validation: sVal, in_sample: sIS },
      ranking: ordTrain.map((i) => cands[i].idx),
      leader: leader == null ? null : cands[leader].idx, best_oos: bestOOS == null ? null : cands[bestOOS].idx,
      finalists: finalists.map((i) => cands[i].idx),
      rank_corr_train_val: both.length >= 3 ? A.spearman(both.map((i) => sTrain[i]), both.map((i) => sVal[i])) : null,
      walk_forward: wf, pbo: pboFromBlocks(cands, 'per_session'),
      dsr: { leader: dsrOf(leader), best_oos: dsrOf(bestOOS) },
      selection_rule: `In-sample leader: best ${OBJECTIVES[o.objective].label.toLowerCase()} on the training window. Best out-of-sample: best on the validation window among the top ${o.topK} by training. Most robust: highest robustness score among the top ${o.topK} by in-sample score. The held-out test window chose nothing.`,
    };
  }

  /**
   * Robustness of one finalist, from in-sample information only. Each component is a share in [0, 1]; the score is
   * their plain mean over those that could be measured, so it can be read and checked by hand.
   *  folds     share of walk-forward test blocks (in-sample) where this configuration made money
   *  thirds    share of the in-sample thirds that made money
   *  regimes   share of low / mid / high volatility sessions (in-sample) that made money
   *  validation 1 when the validation window made money
   *  neighbours share of the one-step neighbours (each ordered setting, one step either side) that made money in-sample
   *  slippage  in-sample net at double slippage as a share of the net as run (0 when it loses)
   */
  function robustScore(summary, neighbours, stressed) {
    const share = (xs) => (xs.length ? xs.filter(Boolean).length / xs.length : null);
    const c = {
      folds: share(summary.folds.filter((f) => f.test.traded > 0).map((f) => f.test.net > 0)),
      thirds: share(summary.thirds.filter((t) => t.traded > 0).map((t) => t.net > 0)),
      regimes: share(Object.values(summary.regimes).filter((r) => r.traded > 0).map((r) => r.net > 0)),
      validation: summary.validation.traded > 0 ? (summary.validation.net > 0 ? 1 : 0) : null,
      neighbours: neighbours && neighbours.length ? share(neighbours.map((n) => n.is.net > 0)) : null,
      slippage: stressed ? (summary.is.net > 0 ? clamp01(stressed.is.net / summary.is.net) : 0) : null,
    };
    const vals = Object.values(c).filter((v) => v != null);
    return { components: c, score: vals.length ? sum(vals) / vals.length : null, measured: vals.length };
  }

  /** The most robust finalist: highest score, then the better in-sample score, then the lower index. */
  function mostRobust(rows) {
    const ok = rows.filter((r) => r.robust.score != null);
    ok.sort((a, b) => (b.robust.score - a.robust.score) || (b.is_score - a.is_score) || (a.idx - b.idx));
    return ok[0] || null;
  }

  return { VERSION, studyPlan, volRegimes, summarise, selectStudy, walkForward, pboFromBlocks, robustScore, mostRobust, orderBy };
});
