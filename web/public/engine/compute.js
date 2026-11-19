/* Straddloop compute layer: turns the engines' raw output into one small, serialisable shape
   shared by the lab worker (browser) and scripts/precompute.mjs (node). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory;
  else root.makeStraddloopCompute = factory;
})(typeof self !== 'undefined' ? self : this, function (E, F, L) {
  const cache = new Map();
  function memo(key, make) {
    if (!cache.has(key)) { if (cache.size > 6) cache.delete(cache.keys().next().value); cache.set(key, make()); }
    return cache.get(key);
  }
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
      brokerage_per_order: 'brokerage_per_order', risk_free_pct: 'risk_free_pct' };
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

  /** Runs the ledger over a run's results and rewrites the headline figures from it, so the page, the report
   *  and the CSVs all come from one source. Returns the extra fields for the result. */
  function withLedger(strategy, results, engineCfgHash, p, sessions, base) {
    const info = { symbol: sessions && sessions[0] ? sessions[0].symbol : 'NIFTY', engine_cfg_hash: engineCfgHash, data_fingerprint: sessions ? fingerprint(sessions) : 'synthetic:' + L.hashStr(JSON.stringify([p.days, p.seed, p.iv])) };
    const led = L.runLedger(results, accountOf(p), info);
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
      Object.assign(head, { traded: n, avg: mean, ci: n > 1 ? [mean - 1.96 * sd / Math.sqrt(n), mean + 1.96 * sd / Math.sqrt(n)] : [mean, mean], t: n > 1 && sd > 0 ? mean / (sd / Math.sqrt(n)) : null,
        winRate: n ? 100 * wins.length / n : 0, profitFactor: loss.length && sumN(loss) < 0 ? sumN(wins) / -sumN(loss) : null,
        worst: n ? Math.min(...dayNets) : 0, best: n ? Math.max(...dayNets) : 0 });
    } else {
      Object.assign(head, { traded: perf.closed_positions, avg: perf.expectancy || 0, ci: perf.ci95_trade || [perf.expectancy || 0, perf.expectancy || 0], t: perf.t_stat_trade,
        winRate: perf.win_rate_pct || 0, profitFactor: perf.profit_factor, worst: perf.largest_loss || 0, best: perf.largest_win || 0 });
    }
    head.account = { config: led.acct, report: rep, daily: led.daily, rejections: led.rejections, liquidations: led.liquidations, counts: { trades: led.tradebook.length, fills: led.fills.length } };
    return head;
  }

  let last = null;  // the latest run's per-day results, for the day replay

  function straddle(p, sessions) {
    const cfg = E.makeConfig(Object.assign({
      sl_pct: num(p.sl_pct, 36), target_per_lot: num(p.target_per_lot, 1000),
      reentry_enabled: p.reentry_enabled !== false, entry_condition: p.entry_condition || 'full',
    }, common(p)));
    const sess = sessions || calendar(p);
    const bt = E.runBacktest(sess, cfg), m = bt.metrics;
    last = { strategy: 'straddle', results: bt.results, cfg };
    const exits = {};
    bt.results.forEach(r => { if (r.status === 'traded') exits[r.exit_reason] = (exits[r.exit_reason] || 0) + 1; });
    return withLedger('straddle', bt.results, bt.config_hash, p, sessions, {
      strategy: 'straddle', unit: 'day', sessions: m.sessions_total, traded: m.sessions_traded,
      net: m.net_pnl || 0, gross: m.gross_pnl || 0, costs: m.costs || 0, avg: m.avg_daily_pnl || 0,
      ci: m.ci95_mean || [m.avg_daily_pnl || 0, m.avg_daily_pnl || 0], t: m.t_stat_mean,
      winRate: m.win_rate, maxDD: m.max_drawdown, worst: m.largest_loss, best: m.largest_win,
      profitFactor: m.profit_factor, exits,
      curve: m.equity_curve.map(e => ({ d: e.date, v: e.cum, p: e.pnl })),
      extra: [
        ['Days with no entry', `${m.sessions_total - m.sessions_traded} of ${m.sessions_total}`],
        ['Average winning day', m.avg_win], ['Average losing day', m.avg_loss],
        ['Costs per traded day', m.sessions_traded ? m.costs / m.sessions_traded : 0],
      ],
    });
  }

  function orb(p, sessions) {
    const basis = p.target_basis || 'premium';
    const cfg = E.ORB.makeConfig(Object.assign({
      target_points: num(p.target_points, 30), stop_buffer: num(p.stop_buffer, 0),
      breakout_def: p.breakout_def || 'wick', target_basis: basis,
    }, common(p, true)));
    const run = E.ORB.run(sessions || calendar(p), cfg), m = run.metrics;
    last = { strategy: 'orb', results: run.results, cfg };
    const lo = m.expectancy - 1.96 * (m.trade_t_stat ? Math.abs(m.expectancy / m.trade_t_stat) : 0);
    const hi = m.expectancy + 1.96 * (m.trade_t_stat ? Math.abs(m.expectancy / m.trade_t_stat) : 0);
    return withLedger('orb', run.results, run.config_hash, p, sessions, {
      strategy: 'orb', unit: 'trade', sessions: m.sessions_total, traded: m.trades,
      net: m.net_pnl || 0, gross: m.gross_pnl || 0, costs: m.costs || 0, avg: m.expectancy || 0,
      ci: [lo || 0, hi || 0], t: m.trade_t_stat,
      winRate: m.trade_win_rate, maxDD: m.max_drawdown, worst: m.largest_loss, best: m.largest_win,
      profitFactor: m.trade_profit_factor, exits: m.trade_exit_reasons || {},
      curve: m.equity_curve.map(e => ({ d: e.date, v: e.cum, p: e.pnl })),
      extra: [
        ['Average hold', `${Math.round(m.avg_hold_min || 0)} min`],
        ['Best open gain, average', m.avg_mfe], ['Worst open loss, average', m.avg_mae],
        ['Breakout candles seen', `${m.breakouts}`],
      ],
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

  return { run: (p, sessions) => ({ straddle, orb, fourleg })[p.strategy](p, sessions), scenarios, replay, exportCsv, inspect };
});
