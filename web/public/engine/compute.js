/* Straddloop compute layer: turns the engines' raw output into one small, serialisable shape
   shared by the lab worker (browser) and scripts/precompute.mjs (node). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory;
  else root.makeStraddloopCompute = factory;
})(typeof self !== 'undefined' ? self : this, function (E, F) {
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

  function straddle(p) {
    const cfg = E.makeConfig({
      sl_pct: num(p.sl_pct, 36), target_per_lot: num(p.target_per_lot, 1000),
      reentry_enabled: p.reentry_enabled !== false, entry_condition: p.entry_condition || 'full',
    });
    const bt = E.runBacktest(calendar(p), cfg), m = bt.metrics;
    const exits = {};
    bt.results.forEach(r => { if (r.status === 'traded') exits[r.exit_reason] = (exits[r.exit_reason] || 0) + 1; });
    return {
      strategy: 'straddle', unit: 'day', sessions: m.sessions_total, traded: m.sessions_traded,
      net: m.net_pnl, gross: m.gross_pnl, costs: m.costs, avg: m.avg_daily_pnl, ci: m.ci95_mean, t: m.t_stat_mean,
      winRate: m.win_rate, maxDD: m.max_drawdown, worst: m.largest_loss, best: m.largest_win,
      profitFactor: m.profit_factor, exits,
      curve: m.equity_curve.map(e => ({ d: e.date, v: e.cum, p: e.pnl })),
      extra: [
        ['Days with no entry', `${m.sessions_total - m.sessions_traded} of ${m.sessions_total}`],
        ['Average winning day', m.avg_win], ['Average losing day', m.avg_loss],
        ['Costs per traded day', m.sessions_traded ? m.costs / m.sessions_traded : 0],
      ],
    };
  }

  function orb(p) {
    const basis = p.target_basis || 'premium';
    const cfg = E.ORB.makeConfig({
      target_points: num(p.target_points, 30), stop_buffer: num(p.stop_buffer, 0),
      breakout_def: p.breakout_def || 'wick', target_basis: basis,
    });
    const run = E.ORB.run(calendar(p), cfg), m = run.metrics;
    const lo = m.expectancy - 1.96 * (m.trade_t_stat ? Math.abs(m.expectancy / m.trade_t_stat) : 0);
    const hi = m.expectancy + 1.96 * (m.trade_t_stat ? Math.abs(m.expectancy / m.trade_t_stat) : 0);
    return {
      strategy: 'orb', unit: 'trade', sessions: m.sessions_total, traded: m.trades,
      net: m.net_pnl, gross: m.gross_pnl, costs: m.costs, avg: m.expectancy, ci: [lo, hi], t: m.trade_t_stat,
      winRate: m.trade_win_rate, maxDD: m.max_drawdown, worst: m.largest_loss, best: m.largest_win,
      profitFactor: m.trade_profit_factor, exits: m.trade_exit_reasons || {},
      curve: m.equity_curve.map(e => ({ d: e.date, v: e.cum, p: e.pnl })),
      extra: [
        ['Average hold', `${Math.round(m.avg_hold_min || 0)} min`],
        ['Best open gain, average', m.avg_mfe], ['Worst open loss, average', m.avg_mae],
        ['Breakout candles seen', `${m.breakouts}`],
      ],
    };
  }

  function fourleg(p) {
    const months = num(p.months, 24), longLots = num(p.long_lots, 5), dist = num(p.short_pct, 5);
    const data = memo(`uni:${months}`, () => F.syntheticUniverse(null, months));
    const cfg = F.makeConfig({
      long_call_lots: longLots, long_put_lots: longLots, short_call_pct: dist, short_put_pct: dist,
      target_pct_margin: num(p.target_pct_margin, 10),
    });
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

  return { run: p => ({ straddle, orb, fourleg })[p.strategy](p), scenarios };
});
