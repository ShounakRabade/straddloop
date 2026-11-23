/* Straddloop compute layer: turns the engines' raw output into one small, serialisable shape
   shared by the lab worker (browser) and scripts/precompute.mjs (node). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory;
  else root.makeStraddloopCompute = factory;
})(typeof self !== 'undefined' ? self : this, function (E, F, L, G) {
  const cache = new Map();
  function memo(key, make) {
    if (!cache.has(key)) { if (cache.size > 6) cache.delete(cache.keys().next().value); cache.set(key, make()); }
    return cache.get(key);
  }
  // min / max by loop. Math.min(...xs) passes every element as a call argument and overflows the call stack
  // ("Maximum call stack size exceeded") once xs grows past roughly 100k items (a long range, many trades, many
  // configurations). Same results as Math.min / Math.max, including NaN, empty input and signed zero.
  function maxOf(a) { let m = -Infinity; for (let i = 0; i < a.length; i++) { const x = +a[i]; if (x !== x) return NaN; if (x > m || (x === 0 && m === 0 && 1 / x > 0)) m = x; } return m; }
  function minOf(a) { let m = Infinity; for (let i = 0; i < a.length; i++) { const x = +a[i]; if (x !== x) return NaN; if (x < m || (x === 0 && m === 0 && 1 / x < 0)) m = x; } return m; }
  const num = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d);

  function calendar(p) {
    const days = num(p.days, 120), seed = num(p.seed, 1), iv = num(p.iv, 13);
    return memo(`cal:${days}:${seed}:${iv}`, () => E.syntheticCalendar(days, { iv }, seed));
  }

  // Settings shared by both intraday strategies: lots, strike offset and fill slippage.
  // The Lab's strike_offset counts strikes OUT of the money (+) or IN the money (-) for every leg.
  // The straddle engine already reads it that way; the ORB engine counts +N as in the money, so it is flipped.
  function common(p, flip) {
    const off = Math.round(num(p.strike_offset, 0));
    return { lots: Math.max(1, Math.round(num(p.lots, 1))), strike_offset: flip ? -off : off, slip_pct: num(p.slip_pct, 0.5),
      rates_for: L.ratesHook, brokerage_per_order: num(p.brokerage_per_order, L.ACCOUNT_DEFAULTS.brokerage_per_order) };
  }

  /** Account settings from the Lab's parameters. Unset values fall back to the ledger defaults. */
  function accountOf(p) {
    const a = {};
    const map = { capital: 'initial_capital', margin_policy: 'margin_policy', margin_span_pct: 'margin_span_pct', margin_exposure_pct: 'margin_exposure_pct',
      brokerage_per_order: 'brokerage_per_order', risk_free_pct: 'risk_free_pct', margin_model: 'margin_model' };
    for (const k of Object.keys(map)) if (p[k] !== undefined && p[k] !== '') a[map[k]] = p[k];
    return a;
  }

  /** A cheap content fingerprint of the sessions a run used, so a result names the exact data behind it. */
  function fingerprint(sessions) {
    let s = '';
    for (const x of sessions) {
      let acc = 0;
      for (const ex of x.expiries) for (const k of Object.keys(ex.contracts)) { const c = ex.contracts[k].c; for (let i = 0; i < c.length; i++) if (c[i] != null) acc += c[i] * ((i % 7) + 1); }
      let u = 0; for (const v of x.und.c) if (v != null) u += v;
      s += `${x.date}|${x.times.length}|${x.expiries.map(e => e.expiry + ':' + e.lot_size + ':' + Object.keys(e.contracts).length).join(',')}|${u.toFixed(2)}|${acc.toFixed(2)};`;
    }
    return L.hashStr(s) + ':' + sessions.length;
  }

  const sumN = xs => xs.reduce((a, b) => a + b, 0);
  function sdOf(xs) { const n = xs.length; if (n < 2) return 0; const m = sumN(xs) / n; return Math.sqrt(sumN(xs.map(x => (x - m) ** 2)) / (n - 1)); }
  // Two-sided 95% Student t multiplier: at 3 traded days it is 4.30, not 1.96. One day has no interval (null).
  const T95 = [0, 12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.160, 2.145, 2.131, 2.120, 2.110, 2.101, 2.093, 2.086, 2.080, 2.074, 2.069, 2.064, 2.060, 2.056, 2.052, 2.048, 2.045, 2.042];
  const t95 = df => (df <= 30 ? T95[df] : df <= 60 ? 2.042 - 0.042 * (df - 30) / 30 : df <= 120 ? 2.0 - 0.02 * (df - 60) / 60 : 1.96);

  /** Runs the ledger over a run's results and rewrites the headline figures from it, so the page, the report
   *  and the CSVs all come from one source. Returns the extra fields for the result. */
  function withLedger(strategy, results, engineCfgHash, p, sessions, base, acctOver) {
    const info = { symbol: sessions && sessions[0] ? sessions[0].symbol : 'NIFTY', engine_cfg_hash: engineCfgHash, data_fingerprint: sessions ? fingerprint(sessions) : 'synthetic:' + L.hashStr(JSON.stringify([p.days, p.seed, p.iv])) };
    if (hooks && hooks.phase) hooks.phase('ledger');
    const led = L.runLedger(results, acctOver || accountOf(p), info);
    const rep = led.report;
    rep.generated.run_hash = L.hashStr([engineCfgHash, rep.generated.account_hash, info.data_fingerprint, L.COST_TABLE_VERSION].join('|'));
    last.ledger = led;
    const cap = led.acct.initial_capital;
    const dayNets = led.daily.filter(d => d.trades > 0).map(d => d.net_realised);
    const wins = dayNets.filter(x => x > 0), loss = dayNets.filter(x => x <= 0);
    const perf = rep.performance;
    const head = Object.assign({}, base, {
      net: rep.pnl.net_profit, gross: rep.pnl.net_realised_gross, costs: rep.pnl.total_charges, maxDD: -rep.risk.max_drawdown,
      curve: led.daily.map(d => ({ d: d.date, v: d.closing_balance - cap, p: d.net_realised })),
    });
    if (base.unit === 'day') {
      const n = dayNets.length, mean = n ? sumN(dayNets) / n : 0, sd = sdOf(dayNets);
      Object.assign(head, { traded: n, avg: mean, ci: n > 1 ? [mean - t95(n - 1) * sd / Math.sqrt(n), mean + t95(n - 1) * sd / Math.sqrt(n)] : null, t: n > 1 && sd > 0 ? mean / (sd / Math.sqrt(n)) : null,
        winRate: n ? 100 * wins.length / n : 0, profitFactor: loss.length && sumN(loss) < 0 ? sumN(wins) / -sumN(loss) : null,
        worst: n ? minOf(dayNets) : 0, best: n ? maxOf(dayNets) : 0 });
    } else {
      Object.assign(head, { traded: perf.closed_positions, avg: perf.expectancy || 0, ci: perf.ci95_trade || null, t: perf.t_stat_trade,
        winRate: perf.win_rate_pct || 0, profitFactor: perf.profit_factor, worst: perf.largest_loss || 0, best: perf.largest_win || 0 });
    }
    head.account = { config: led.acct, report: rep, daily: led.daily, rejections: led.rejections, liquidations: led.liquidations, counts: { trades: led.tradebook.length, fills: led.fills.length } };
    head.days = dayOutcomes(results, led, sessions, last && last.cfg);
    return head;
  }

  let last = null;  // the latest run's per-day results, for the day replay

  const hmS = m => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
  /** Index minutes with no bar between `from` (inclusive) and `to` (exclusive), as HH:MM. */
  function missingIndexBars(s, from, to) {
    const out = [];
    for (let t = from; t < to; t++) { const i = s.times.indexOf(t); if (i < 0 || s.und.o[i] == null) out.push(hmS(t)); }
    return out;
  }
  /** Words for why a day did not trade, with the data detail the engine reason leaves out. */
  function explain(r, s, cfg) {
    const why = r.reason || '';
    if (s && cfg && /incomplete opening range|entry candle missing|no execution bar/.test(why)) {
      const open = 555, end = open + (cfg.or_minutes || 30) + (cfg.candle_minutes || 5) + 1;
      const miss = missingIndexBars(s, open, end);
      if (miss.length) return `${why}: index bar${miss.length > 1 ? 's' : ''} ${miss.slice(0, 4).join(', ')}${miss.length > 4 ? ` and ${miss.length - 4} more` : ''} missing`;
    }
    return why || null;
  }
  /**
   * One outcome per session handed to the engine (docs/ENGINE_INTERFACES.md §2): traded / no_entry / filtered /
   * excluded / rejected, with the reason and that day's ledger net. Its length is the run's day count, so the
   * page can never say "3 days ran" and show 1 without saying what happened to the other 2.
   */
  function dayOutcomes(results, led, sessions, cfg) {
    const daily = new Map(led.daily.map(d => [d.date, d]));
    const byDate = new Map((sessions || []).map(s => [s.date, s]));
    return results.slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)).map(r => {
      const d = daily.get(r.date);
      let status = r.status, reason = r.status === 'traded' ? null : explain(r, byDate.get(r.date), cfg);
      if (status === 'traded' && d && d.fills === 0 && d.rejected > 0) { status = 'rejected'; reason = `every order was refused for margin (${d.rejected})`; }
      const fl = r.status === 'traded' || r.status === 'holding' ? (r.fills || []) : [];
      const opened = fl.filter(f => f.reason === 'entry' || f.reason === 're-entry').length;
      return { date: r.date, status, reason, opened, closed: fl.length - opened, net: d ? d.net_realised : 0 };
    });
  }

  // Engine settings the research lab may search that have no Lab field of their own. Only these keys pass
  // through, and only when present in the parameters, so ordinary Lab runs are unchanged.
  const ENGINE_EXTRAS = {
    straddle: ['entry_time', 'exit_time', 'reentry_cutoff', 'max_loss_per_lot', 'skip_expiry_day', 'max_or_width_pct', 'min_or_width_pct', 'or_minutes', 'min_iv_proxy', 'min_vix', 'max_vix'],
    orb: ['latest_entry', 'exit_time', 'max_hold_minutes', 'confirm_window', 'breakout_buffer', 'min_vix', 'max_vix'],
    ema_pullback: ['entry_time', 'exit_time', 'stop_points', 'stop_kind', 'max_structural_stop', 'exit_method', 'confirmation', 'max_hold_minutes', 'max_trades', 'strike_offset', 'min_vix', 'max_vix', 'liquidity_sweep', 'golden_enabled', 'silver_enabled'],
  };
  function extras(strategy, p) {
    const o = {};
    for (const k of ENGINE_EXTRAS[strategy]) if (p[k] !== undefined && p[k] !== '') o[k] = p[k];
    return o;
  }
  /** Statutory-cost stress: scale every dated statutory rate (not brokerage, not the GST rate itself). */
  function scaledRates(mult) {
    if (!(mult > 0) || mult === 1) return L.ratesHook;
    return date => { const r = L.ratesHook(date); return Object.assign({}, r, { stt_sell_pct: r.stt_sell_pct * mult, exch_pct: r.exch_pct * mult, sebi_pct: r.sebi_pct * mult, stamp_buy_pct: r.stamp_buy_pct * mult }); };
  }
  function straddleCfg(p) {
    return E.makeConfig(Object.assign({
      sl_pct: num(p.sl_pct, 36), target_per_lot: num(p.target_per_lot, 1000),
      reentry_enabled: p.reentry_enabled !== false, entry_condition: p.entry_condition || 'full',
    }, common(p), extras('straddle', p), p.cost_mult ? { rates_for: scaledRates(Number(p.cost_mult)) } : {}));
  }
  function orbCfg(p) {
    return E.ORB.makeConfig(Object.assign({
      target_points: num(p.target_points, 30), stop_buffer: num(p.stop_buffer, 0),
      breakout_def: p.breakout_def || 'wick', target_basis: p.target_basis || 'premium',
    }, common(p, true), extras('orb', p), p.cost_mult ? { rates_for: scaledRates(Number(p.cost_mult)) } : {}));
  }

  function straddle(p, sessions) {
    const cfg = straddleCfg(p);
    const sess = sessions || calendar(p);
    const bt = E.runBacktest(sess, cfg), m = bt.metrics;
    last = { strategy: 'straddle', results: bt.results, cfg, sessions: sess, params: p };
    const exits = {};
    bt.results.forEach(r => { if (r.status === 'traded') exits[r.exit_reason] = (exits[r.exit_reason] || 0) + 1; });
    return withLedger('straddle', bt.results, bt.config_hash, p, sessions, {
      strategy: 'straddle', unit: 'day', sessions: m.sessions_total, traded: m.sessions_traded,
      net: m.net_pnl || 0, gross: m.gross_pnl || 0, costs: m.costs || 0, avg: m.avg_daily_pnl || 0,
      ci: m.ci95_mean || [m.avg_daily_pnl || 0, m.avg_daily_pnl || 0], t: m.t_stat_mean,
      winRate: m.win_rate, maxDD: m.max_drawdown, worst: m.largest_loss, best: m.largest_win,
      profitFactor: m.profit_factor, exits,
      curve: (m.equity_curve || []).map(e => ({ d: e.date, v: e.cum, p: e.pnl })),
      extra: [
        ['Days with no entry', `${m.sessions_total - m.sessions_traded} of ${m.sessions_total}`],
        ['Average winning day', m.avg_win], ['Average losing day', m.avg_loss],
        ['Costs per traded day', m.sessions_traded ? m.costs / m.sessions_traded : 0],
        ...vixSummary(sess),
      ],
    });
  }

  function orb(p, sessions) {
    const cfg = orbCfg(p);
    const sess = sessions || calendar(p);
    const run = E.ORB.run(sess, cfg), m = run.metrics;
    last = { strategy: 'orb', results: run.results, cfg, sessions: sess, params: p };
    const lo = m.expectancy - 1.96 * (m.trade_t_stat ? Math.abs(m.expectancy / m.trade_t_stat) : 0);
    const hi = m.expectancy + 1.96 * (m.trade_t_stat ? Math.abs(m.expectancy / m.trade_t_stat) : 0);
    return withLedger('orb', run.results, run.config_hash, p, sessions, {
      strategy: 'orb', unit: 'trade', sessions: m.sessions_total, traded: m.trades,
      net: m.net_pnl || 0, gross: m.gross_pnl || 0, costs: m.costs || 0, avg: m.expectancy || 0,
      ci: [lo || 0, hi || 0], t: m.trade_t_stat,
      winRate: m.trade_win_rate, maxDD: m.max_drawdown, worst: m.largest_loss, best: m.largest_win,
      profitFactor: m.trade_profit_factor, exits: m.trade_exit_reasons || {},
      curve: (m.equity_curve || []).map(e => ({ d: e.date, v: e.cum, p: e.pnl })),
      extra: [
        ['Average hold', `${Math.round(m.avg_hold_min || 0)} min`],
        ['Best open gain, average', m.avg_mfe], ['Worst open loss, average', m.avg_mae],
        ['Breakout candles seen', `${m.breakouts}`],
        ...vixSummary(sess),
      ],
    });
  }

  function vixSummary(sess) {
    const rows = (sess || []).map(s => s.vix && s.vix.c ? s.vix.c.filter(Number.isFinite) : []).filter(a => a.length);
    const n = rows.reduce((v, a) => v + a.length, 0);
    if (!n) return [['India VIX data', 'Unavailable for this date range. Load day files again after fetching India VIX 1-minute history.']];
    let vmin = Infinity, vmax = -Infinity; // a loop over every bar: a long range has ~100k bars (see maxOf)
    for (const a of rows) for (const x of a) { if (x < vmin) vmin = x; if (x > vmax) vmax = x; }
    const first = rows.reduce((v, a) => v + a[0], 0) / rows.length;
    const last = rows.reduce((v, a) => v + a[a.length - 1], 0) / rows.length;
    return [['India VIX coverage', `${rows.length} of ${sess.length} sessions · ${n.toLocaleString()} one-minute bars`],
      ['India VIX open → close (session average)', `${first.toFixed(2)} → ${last.toFixed(2)} (${(last - first >= 0 ? '+' : '')}${(last - first).toFixed(2)})`],
      ['India VIX observed range', `${vmin.toFixed(2)}–${vmax.toFixed(2)}`]];
  }

  function emaPullback(p, sessions) {
    const cfg = E.EMA.makeConfig(Object.assign({}, common(p), extras('ema_pullback', p)));
    const sess = sessions || calendar(p), run = E.EMA.run(sess, cfg);
    last = { strategy: 'ema_pullback', results: run.results, cfg, sessions: sess, params: p };
    const m = run.metrics;
    return withLedger('ema_pullback', run.results, run.config_hash, p, sess, {
      strategy: 'ema_pullback', unit: 'trade', sessions: m.sessions_total, traded: m.trades,
      net: m.net_pnl || 0, gross: m.gross_pnl || 0, costs: m.costs || 0, avg: m.expectancy || 0,
      ci: null, t: m.trade_t_stat, winRate: m.trade_win_rate, maxDD: m.max_drawdown,
      worst: m.largest_loss, best: m.largest_win, profitFactor: m.trade_profit_factor,
      exits: m.trade_exit_reasons || {}, curve: (m.equity_curve || []).map(e => ({ d: e.date, v: e.cum, p: e.pnl })),
      extra: [['Average hold', `${Math.round(m.avg_hold_min || 0)} min`], ['Setups rejected / filtered', run.results.reduce((n, r) => n + (r.setups || []).filter(x => x.status === 'rejected' || x.status === 'filtered').length, 0)], ...vixSummary(sess)],
    });
  }

  function fourleg(p) {
    const months = num(p.months, 24), longLots = num(p.long_lots, 5), dist = num(p.short_pct, 5);
    const data = memo(`uni:${months}`, () => F.syntheticUniverse(null, months));
    const cfg = F.makeConfig({
      long_call_lots: longLots, long_put_lots: longLots, short_call_pct: dist, short_put_pct: dist,
      target_pct_margin: num(p.target_pct_margin, 10),
    });
    last = null;
    const run = F.run(data, cfg), pol = p.policy === 'B' ? 'B' : 'A', m = run.metrics[pol], o = run.metrics[pol === 'A' ? 'B' : 'A'];
    return {
      strategy: 'fourleg', unit: 'month', policy: pol, sessions: m.cycles, traded: m.traded,
      net: m.net_pnl, gross: m.gross_pnl, costs: m.costs, avg: m.avg_net, ci: m.ci95, t: m.t_stat,
      winRate: m.win_rate, maxDD: m.max_drawdown, worst: m.largest_loss, best: m.largest_win,
      profitFactor: m.profit_factor, exits: m.exit_reasons || {},
      curve: m.equity_curve.map((e, i, a) => ({ d: e.date, v: e.equity, p: e.equity - (i ? a[i - 1].equity : 0) })),
      extra: [
        ['Months that reached the target', `${(m.pct_target || 0).toFixed(1)}%`],
        ['Return on initial margin', `${(m.total_roim_pct || 0).toFixed(1)}%`],
        ['Average initial margin', m.avg_margin0],
        [`Policy ${pol === 'A' ? 'B' : 'A'} net, same entries`, o.net_pnl],
      ],
    };
  }

  /** The spec and account a leg-engine run uses. The account owns brokerage, so the engine's cost lines use the same
   *  figure and the two reconcile; the leg engine's margin defaults to the hedged estimate. */
  function legsSetup(p) {
    if (!G) throw new Error('The leg engine is not loaded.');
    const raw = typeof p.spec === 'string' ? JSON.parse(p.spec) : p.spec;
    if (!raw) throw new Error('No strategy spec was given.');
    const spec = G.normalize(raw);
    if (p.brokerage_per_order !== undefined && p.brokerage_per_order !== '') spec.execution.brokerage_per_order = Number(p.brokerage_per_order);
    const acct = Object.assign({ margin_model: 'hedged' }, accountOf(p), { brokerage_per_order: spec.execution.brokerage_per_order, exercise_stt_pct: spec.execution.exercise_stt_pct });
    return { spec, acct };
  }

  /**
   * The leg engine (docs/ENGINE_INTERFACES.md): any strategy as a StrategySpec in p.spec. Headline figures are per
   * POSITION (the legs opened together), taken from the ledger's tradebook grouped by position.
   */
  function legsStrategy(p, sessions) {
    const { spec, acct } = legsSetup(p);
    const sess = sessions || calendar(p);
    const run = G.run(sess, spec, { L, caps: G.capsOf(sess), tick: hooks && hooks.tick });
    last = { strategy: 'legs', results: run.results, cfg: { or_minutes: 30, candle_minutes: 5 }, positions: run.positions, sessions: sess, params: p };
    const exits = {};
    run.positions.forEach(x => { exits[x.exit_reason] = (exits[x.exit_reason] || 0) + 1; });
    const head = withLedger('legs', run.results, run.config_hash, p, sessions, {
      strategy: 'legs', unit: 'position', sessions: run.results.length, traded: 0, net: 0, gross: 0, costs: 0, avg: 0, ci: [0, 0], t: null,
      winRate: 0, maxDD: 0, worst: 0, best: 0, profitFactor: null, exits, curve: [], extra: [],
    }, acct);
    // per-position figures from the ledger (what was actually booked, after any margin rejection)
    const tb = last.ledger.tradebook, byPos = new Map();
    for (const t of tb) { const k = t.position_id || '?'; const o = byPos.get(k) || { net: 0, gross: 0, charges: 0, legs: 0 }; o.net += t.net_pnl; o.gross += t.gross_pnl; o.charges += t.charges; o.legs++; byPos.set(k, o); }
    const nets = run.positions.filter(x => byPos.has(x.id)).map(x => byPos.get(x.id).net);
    const n = nets.length, mean = n ? sumN(nets) / n : 0, sd = sdOf(nets);
    const wins = nets.filter(x => x > 0), loss = nets.filter(x => x <= 0);
    Object.assign(head, {
      traded: n, avg: mean, ci: n > 1 ? [mean - 1.96 * sd / Math.sqrt(n), mean + 1.96 * sd / Math.sqrt(n)] : [mean, mean], t: n > 1 && sd > 0 ? mean / (sd / Math.sqrt(n)) : null,
      winRate: n ? 100 * wins.length / n : 0, profitFactor: loss.length && sumN(loss) < 0 ? sumN(wins) / -sumN(loss) : null,
      worst: n ? minOf(nets) : 0, best: n ? maxOf(nets) : 0,
      extra: [
        ['Days with no entry', `${run.results.filter(r => ['no_entry', 'filtered', 'excluded'].includes(r.status)).length} of ${run.results.length}`],
        ['Average winning position', wins.length ? sumN(wins) / wins.length : 0], ['Average losing position', loss.length ? sumN(loss) / loss.length : 0],
        ['Costs per position', n ? head.costs / n : 0],
      ],
    });
    // engine and ledger must agree on every position when the ledger executed every order as sent
    const rep = head.account.report, acc = head.account;
    if (!acc.rejections.length && !acc.liquidations.length && !last.ledger.fills.some(f => f.status === 'partial')) {
      for (const x of run.positions) {
        const b = byPos.get(x.id);
        rep.reconciliation.checks.push({ name: `position ${x.id}: engine net = ledger net`, a: Math.round(x.net * 1e4) / 1e4, b: b ? Math.round(b.net * 1e4) / 1e4 : 0, ok: !!b && Math.abs(x.net - b.net) <= 0.01 });
      }
      rep.reconciliation.ok = rep.reconciliation.checks.every(c => c.ok);
    }
    for (const g of run.gates) if (!rep.warnings.includes(g.message)) rep.warnings.unshift(g.message);
    return Object.assign(head, { positions: run.positions, gates: run.gates, spec: run.spec, spec_hash: run.config_hash });
  }

  function scenarios() {
    const cfg = E.makeConfig({}), ocfg = E.ORB.makeConfig({});
    return Object.keys(E.SCENARIOS).map(k => {
      const sc = E.SCENARIOS[k], params = Object.assign({}, sc); delete params.label;
      const s = E.generate(Object.assign({}, E.SYN_BASE, params), '2099-03-02');
      const r = E.simulate(s, cfg), o = E.ORB.run([s], ocfg).results[0];
      const und = s.und.c, step = Math.max(1, Math.floor(und.length / 60)), path = [];
      for (let i = 0; i < und.length; i += step) path.push(und[i]);
      return { key: k, label: sc.label, path,
        straddle: r.status === 'traded' ? { net: r.net, exit: r.exit_reason, stops: r.stops, reentries: r.reentries } : null,
        orb: o.status === 'traded' ? { net: o.net, exit: o.exit_reason } : null };
    });
  }

  /** Everything needed to replay one day of the latest straddle or ORB run, kept small for postMessage. */
  function replay(date) {
    if (!last) return null;
    const r = last.results.find(x => x.date === date);
    if (!r) return null;
    const legs = (r.legs || r.trades || []).map(l => ({
      side: l.side || l.cp, strike: l.strike, kind: l.kind || (l.dir === 1 ? 'long call' : 'long put'),
      entry_t: l.entry_t, entry_px: l.entry_px, exit_t: l.exit_t, exit_px: l.exit_px, exit_reason: l.exit_reason,
      stop: l.stop != null ? l.stop : null, net: l.net }));
    return {
      strategy: last.strategy, date: r.date, status: r.status, reason: r.reason, net: r.net, gross: r.gross, costs: r.costs,
      exit_reason: r.exit_reason, expiry: r.expiry, lot_size: r.lot_size, qty: r.qty, flags: r.flags || [],
      or_high: r.or_high, or_low: r.or_low, decision_t: r.decision_t, candles: (r.candles || []).map(c => ({ t: c.t, o: c.o, h: c.h, l: c.l, c: c.c })),
      mtm: (r.mtm || []).map(x => ({ t: x.t, v: x.net })), legs,
      events: (r.events || []).map(e => ({ t: e.t, kind: e.kind, text: e.text })),
    };
  }

  /** CSV text for the latest run: tradebook, ledger (every fill), daily, performance. */
  function exportCsv(kind) {
    if (!last || !last.ledger) return null;
    const led = last.ledger;
    if (kind === 'tradebook') return L.toCsv(led.tradebook, L.TRADEBOOK_COLS);
    if (kind === 'ledger') return L.toCsv(led.fills, L.FILL_COLS);
    if (kind === 'daily') return L.toCsv(led.daily, L.DAILY_COLS);
    if (kind === 'performance') return L.performanceCsv(led.report);
    throw new Error('unknown export: ' + kind);
  }
  /** A page of rows of the latest run for the in-page inspector. */
  function inspect(kind, offset, limit) {
    if (!last || !last.ledger) return null;
    const led = last.ledger, rows = kind === 'ledger' ? led.fills : kind === 'daily' ? led.daily : led.tradebook;
    return { kind, total: rows.length, offset, rows: rows.slice(offset, offset + limit) };
  }

  /**
   * Research evaluation: the same engine configuration and the same ledger as a Lab run, without touching
   * the latest run (replay and exports keep pointing at what the page shows). Returns the ledger's daily
   * rows, the engine's day results reduced to what analytics reads, and the per-fill charge components.
   * p.cost_mult (stress tests) scales statutory rates in the engine and the same components of the ledger's
   * charges after booking; margin decisions are not re-simulated for that difference.
   */
  function evaluate(p, sessions) {
    const sess = sessions || calendar(p);
    let results, acct = accountOf(p);
    if (p.strategy === 'straddle') results = E.runBacktest(sess, straddleCfg(p)).results;
    else if (p.strategy === 'orb') results = E.ORB.run(sess, orbCfg(p)).results;
    else if (p.strategy === 'ema_pullback') results = E.EMA.run(sess, E.EMA.makeConfig(Object.assign({}, common(p), extras('ema_pullback', p)))).results;
    else if (p.strategy === 'legs') {
      // lean: the same fills and ledger as a Lab run, without the replay text (tests/legs.test.mts checks they agree).
      // cost_mult is applied after booking (stressDaily below); the engine's own net-basis exits are not re-decided.
      const su = legsSetup(p);
      acct = su.acct;
      results = G.run(sess, su.spec, { L, caps: G.capsOf(sess), lean: true }).results;
    }
    else throw new Error('Research tools cover the intraday NIFTY strategies and the strategy builder only.');
    const led = L.runLedger(results, acct, { symbol: sess[0] ? sess[0].symbol : 'NIFTY' });
    const mult = Number(p.cost_mult) || 1;
    const daily = mult !== 1 ? stressDaily(led, mult) : led.daily;
    return { account: { daily, config: led.acct }, results: results.map(slimResult) };
  }
  function stressDaily(led, mult) {
    const extra = {};
    for (const f of led.fills) {
      if (!f.charges) continue;
      const base = (f.brokerage || 0) + (f.exchange || 0) + (f.sebi || 0);
      const gstStat = base > 0 ? (f.gst || 0) * ((f.exchange || 0) + (f.sebi || 0)) / base : 0;
      const stat = (f.stt || 0) + (f.exchange || 0) + (f.sebi || 0) + (f.stamp || 0) + gstStat;
      extra[f.date] = (extra[f.date] || 0) + (mult - 1) * stat;
    }
    let shift = 0;
    return led.daily.map(d => {
      const x = extra[d.date] || 0; shift += x;
      return Object.assign({}, d, { charges: d.charges + x, net_realised: d.net_realised - x, closing_balance: d.closing_balance - shift,
        closing_equity: (d.closing_equity != null ? d.closing_equity : d.closing_balance) - shift });
    });
  }
  const slimResult = r => ({ date: r.date, status: r.status, reason: r.reason || null, exit_reason: r.exit_reason || null,
    is_expiry_day: r.is_expiry_day != null ? r.is_expiry_day : null, dte: r.dte != null ? r.dte : null, flags: r.flags || [] });
  /** The latest run, for the research panel: ledger daily rows, slim day results and the sessions it used. */
  function lastRun() {
    if (!last || !last.ledger) return null;
    return { strategy: last.strategy, params: last.params, sessions: last.sessions,
      account: { daily: last.ledger.daily, config: last.ledger.acct }, results: last.results.map(slimResult) };
  }

  /** One Lab run. hooks (optional, the Lab worker's progress): { tick(index, count) before each session is simulated,
   *  phase('ledger') when the engine has finished and the account is being booked }. */
  let hooks = null;
  function run(p, sessions, h) {
    const fn = ({ straddle, orb, fourleg, ema_pullback: emaPullback, legs: legsStrategy })[p.strategy];
    if (!fn) throw new Error(`unknown strategy ${p.strategy}`);
    hooks = h || null;
    if (E.setTick) E.setTick(hooks && hooks.tick);
    try { return fn(p, sessions); }
    finally { hooks = null; if (E.setTick) E.setTick(null); }
  }

  return { run, scenarios, replay, exportCsv, inspect, dayOutcomes, evaluate, lastRun, ENGINE_EXTRAS };
});
