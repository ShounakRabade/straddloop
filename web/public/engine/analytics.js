/* Straddloop analytics: market regimes, the optimisation lab, robustness, diagnostics, chronological
 * model checks and a research assistant that only repeats numbers it computed.
 *
 * Pure calculations: no DOM, no network, no language model. Runs in the Lab worker and in Node (tests).
 * Methods, thresholds, limits and per-feature status: docs/ANALYTICS.md.
 *
 * The unit of analysis is the trading SESSION. Everything here reads "day records":
 *   { date, status, traded, net, gross, costs, util_pct, peak_margin, rejected, exit_reason, is_expiry_day, dte, flags }
 * status is the engine's: traded | no_entry | filtered | excluded. `traded` means at least one position was
 * opened that day. Excluded days (a data problem) never count in any statistic; idle days count as 0 where a
 * statistic is per session (Sharpe, drawdown) and are left out where it is per traded day (win rate).
 *
 * Sessions (for regime features) are the engines' shape: { date, source, times, und: { o, h, l, c }, meta }.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.StraddloopAnalytics = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  // min / max by loop. Math.min(...xs) passes every element as a call argument and overflows the call stack
  // ("Maximum call stack size exceeded") once xs grows past roughly 100k items (a long range, many trades, many
  // configurations). Same results as Math.min / Math.max, including NaN, empty input and signed zero.
  function maxOf(a) { let m = -Infinity; for (let i = 0; i < a.length; i++) { const x = +a[i]; if (x !== x) return NaN; if (x > m || (x === 0 && m === 0 && 1 / x > 0)) m = x; } return m; }
  function minOf(a) { let m = Infinity; for (let i = 0; i < a.length; i++) { const x = +a[i]; if (x !== x) return NaN; if (x < m || (x === 0 && m === 0 && 1 / x < 0)) m = x; } return m; }

  const VERSION = 'analytics-2026-11-19';

  // ================================================================== numbers
  const sum = (a) => { let s = 0; for (const x of a) s += x; return s; };
  const mean = (a) => (a.length ? sum(a) / a.length : null);
  function sdev(a) {
    const n = a.length; if (n < 2) return null;
    const m = sum(a) / n; let s = 0; for (const x of a) s += (x - m) * (x - m);
    return Math.sqrt(s / (n - 1));
  }
  function quantile(sorted, q) {
    if (!sorted.length) return null;
    if (sorted.length === 1) return sorted[0];
    const pos = (sorted.length - 1) * q, lo = Math.floor(pos), hi = Math.min(lo + 1, sorted.length - 1);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
  }
  const sortNum = (a) => a.slice().sort((x, y) => x - y);
  const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
  const byDate = (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0);

  /** Seeded uniform [0,1): mulberry32, the same generator the engines use. */
  function rng(seed) {
    let a = (seed >>> 0) || 1;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Two-sided 95% Student t critical values. At n = 3 the honest multiplier is 4.30, not 1.96.
  const T95 = [NaN, 12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.160, 2.145, 2.131,
    2.120, 2.110, 2.101, 2.093, 2.086, 2.080, 2.074, 2.069, 2.064, 2.060, 2.056, 2.052, 2.048, 2.045, 2.042];
  function t95(df) {
    if (!(df >= 1)) return null;
    if (df <= 30) return T95[Math.floor(df)];
    if (df <= 40) return 2.042 + (2.021 - 2.042) * (df - 30) / 10;
    if (df <= 60) return 2.021 + (2.000 - 2.021) * (df - 40) / 20;
    if (df <= 120) return 2.000 + (1.980 - 2.000) * (df - 60) / 60;
    return 1.96;
  }
  /** Mean with a 95% t interval. n < 2 gives no interval (null), never a zero-width one. */
  function ciMean(xs) {
    const n = xs.length, m = mean(xs), s = sdev(xs);
    if (n < 2 || s == null) return { n, mean: m, sd: s, lo: null, hi: null, t: null };
    const se = s / Math.sqrt(n), k = t95(n - 1);
    return { n, mean: m, sd: s, lo: m - k * se, hi: m + k * se, t: se > 0 ? m / se : null };
  }
  // Standard normal CDF (Abramowitz & Stegun 7.1.26 via erf, |error| < 1.5e-7) and its inverse (Acklam).
  function normCdf(x) {
    const z = Math.abs(x) / Math.SQRT2, t = 1 / (1 + 0.3275911 * z);
    const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
    return x >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
  }
  function normInv(p) {
    if (p <= 0) return -Infinity; if (p >= 1) return Infinity;
    const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
    const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
    const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
    const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
    const pl = 0.02425;
    if (p < pl) { const q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
    if (p > 1 - pl) { const q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
    const q = p - 0.5, r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  function moments(xs) {
    const n = xs.length; if (n < 3) return { skew: 0, kurt: 3 };
    const m = mean(xs); let m2 = 0, m3 = 0, m4 = 0;
    for (const x of xs) { const d = x - m; m2 += d * d; m3 += d * d * d; m4 += d * d * d * d; }
    m2 /= n; m3 /= n; m4 /= n;
    if (m2 <= 0) return { skew: 0, kurt: 3 };
    return { skew: m3 / Math.pow(m2, 1.5), kurt: m4 / (m2 * m2) };
  }
  function spearman(a, b) {
    const n = a.length; if (n < 3) return null;
    const rank = (v) => { const idx = v.map((x, i) => [x, i]).sort((p, q) => p[0] - q[0]); const r = new Array(n); let i = 0;
      while (i < n) { let j = i; while (j + 1 < n && idx[j + 1][0] === idx[i][0]) j++; for (let k = i; k <= j; k++) r[idx[k][1]] = (i + j) / 2 + 1; i = j + 1; } return r; };
    const ra = rank(a), rb = rank(b), ma = mean(ra), mb = mean(rb);
    let num = 0, da = 0, db = 0;
    for (let i = 0; i < n; i++) { num += (ra[i] - ma) * (rb[i] - mb); da += (ra[i] - ma) ** 2; db += (rb[i] - mb) ** 2; }
    return da > 0 && db > 0 ? num / Math.sqrt(da * db) : null;
  }

  /** How much a sample of n independent observations can carry. Used everywhere a verdict is printed. */
  function sampleClass(n) {
    if (n < 10) return { key: 'none', label: 'Too few to judge', min_next: 10 };
    if (n < 30) return { key: 'thin', label: 'Thin', min_next: 30 };
    if (n < 100) return { key: 'moderate', label: 'Moderate', min_next: 100 };
    if (n < 250) return { key: 'good', label: 'Good', min_next: 250 };
    return { key: 'large', label: 'Large', min_next: null };
  }

  // ================================================================== adapter: run result -> day records
  /**
   * Day records from a finished run. The ledger is the only source of money figures (docs/ENGINE_INTERFACES.md):
   *  - per-session P&L = change in the ledger's closing equity (closing balance when no position is carried),
   *    so multi-day positions are marked daily and intraday results equal net realised P&L;
   *  - status and reason come from RunResult.days when the engine provides them, else from the engine's day
   *    results; days the ledger never saw (excluded for data) are kept with status 'excluded';
   *  - expiry flags come from the engine's day results when they carry them.
   * run = { days?: DayOutcome[], account: { daily, config: { initial_capital } }, results?: engine day results }
   */
  function fromRun(run) {
    const daily = (run.account && run.account.daily) || [];
    const cap = (run.account && run.account.config && run.account.config.initial_capital) || 500000;
    const byLedger = {}; for (const d of daily) byLedger[d.date] = d;
    const byRes = {}; for (const r of run.results || []) byRes[r.date] = r;
    const outcomes = run.days && run.days.length ? run.days.slice()
      : (run.results || []).map((r) => ({ date: r.date, status: r.status, reason: r.reason || null }));
    const dates = outcomes.length ? outcomes : daily.map((d) => ({ date: d.date, status: d.status, reason: d.reason || null }));
    const out = [];
    let prevEq = cap;
    for (const o of dates.slice().sort(byDate)) {
      const L = byLedger[o.date], r = byRes[o.date] || {};
      if (!L) { out.push({ date: o.date, status: 'excluded', reason: o.reason || 'not in the ledger', traded: false, net: 0, gross: 0, costs: 0, util_pct: null, peak_margin: 0, rejected: 0, exit_reason: null, is_expiry_day: r.is_expiry_day != null ? r.is_expiry_day : null, dte: r.dte != null ? r.dte : null, flags: r.flags || [] }); continue; }
      const eq = L.closing_equity != null ? L.closing_equity : L.closing_balance;
      const status = o.status === 'excluded' ? 'excluded' : (L.trades > 0 || o.status === 'traded' || o.status === 'holding') ? (o.status === 'holding' ? 'holding' : 'traded') : (o.status || L.status);
      out.push({ date: o.date, status, reason: o.reason || L.reason || null,
        traded: L.trades > 0 || o.status === 'holding',
        net: eq - prevEq, gross: L.gross_realised, costs: L.charges, util_pct: L.peak_util_pct === Infinity ? null : L.peak_util_pct, peak_margin: L.peak_margin,
        rejected: L.rejected || 0, exit_reason: L.exit_reason || r.exit_reason || null,
        is_expiry_day: r.is_expiry_day != null ? r.is_expiry_day : null, dte: r.dte != null ? r.dte : null, flags: r.flags || [] });
      prevEq = eq;
    }
    return { days: out, capital: cap };
  }

  // ================================================================== performance of a set of sessions
  const ELIGIBLE = (d) => d.status !== 'excluded';
  function maxDrawdown(vals) {
    let cum = 0, peak = 0, dd = 0, peakAt = -1, from = -1, to = -1, curPeakAt = -1;
    for (let i = 0; i < vals.length; i++) {
      cum += vals[i];
      if (cum > peak) { peak = cum; curPeakAt = i; }
      if (cum - peak < dd) { dd = cum - peak; from = curPeakAt; to = i; peakAt = curPeakAt; }
    }
    return { dd, from, to, peakAt };
  }

  /**
   * Every statistic the lab quotes for a set of day records.
   * opts.capital: account size used for Sharpe/Sortino (returns = P&L / capital), drawdown %, CAGR.
   */
  function perf(days, opts) {
    opts = opts || {};
    const cap = opts.capital || 500000;
    const el = days.filter(ELIGIBLE).slice().sort(byDate);
    const tr = el.filter((d) => d.traded);
    const nets = tr.map((d) => d.net), perSession = el.map((d) => (d.traded ? d.net : 0));
    const wins = nets.filter((x) => x > 0), losses = nets.filter((x) => x <= 0);
    const gw = sum(wins), gl = -sum(losses);
    const ci = ciMean(nets);
    const dd = maxDrawdown(perSession);
    const ms = mean(perSession), ss = sdev(perSession);
    const down = perSession.length ? Math.sqrt(sum(perSession.map((x) => Math.min(0, x) ** 2)) / perSession.length) : null;
    const utils = tr.map((d) => d.util_pct).filter((x) => typeof x === 'number' && isFinite(x));
    const peakMargin = Math.max(0, maxOf(el.map((d) => d.peak_margin || 0)));
    const net = sum(nets);
    const span = el.length ? (Date.parse(el[el.length - 1].date) - Date.parse(el[0].date)) / 86400000 + 1 : 0;
    const exits = {};
    for (const d of tr) { const k = d.exit_reason || 'unknown'; const e = exits[k] || (exits[k] = { n: 0, net: 0 }); e.n++; e.net += d.net; }
    const grossProfit = sum(tr.filter((d) => d.gross > 0).map((d) => d.gross));
    const costs = sum(tr.map((d) => d.costs || 0));
    return {
      sessions: el.length, traded: tr.length, excluded: days.length - el.length,
      from: el.length ? el[0].date : null, to: el.length ? el[el.length - 1].date : null,
      net, gross: sum(tr.map((d) => d.gross || 0)), costs,
      mean: ci.mean, sd: ci.sd, ci: ci.lo == null ? null : [ci.lo, ci.hi], t: ci.t,
      per_session: ms, win_rate: tr.length ? 100 * wins.length / tr.length : null,
      pf: gl > 0 ? gw / gl : (gw > 0 ? null : null), pf_note: gl > 0 ? null : (gw > 0 ? 'no losing day' : 'no winning day'),
      avg_win: wins.length ? gw / wins.length : null, avg_loss: losses.length ? -gl / losses.length : null,
      payoff: wins.length && losses.length && gl > 0 ? (gw / wins.length) / (gl / losses.length) : null,
      best: nets.length ? maxOf(nets) : null, worst: nets.length ? minOf(nets) : null,
      max_dd: dd.dd, max_dd_pct: 100 * dd.dd / cap,
      dd_from: dd.from >= 0 ? el[dd.from].date : (dd.to >= 0 ? el[0].date : null), dd_to: dd.to >= 0 ? el[dd.to].date : null,
      sharpe: ss && ss > 0 ? (ms / ss) * Math.sqrt(252) : null,
      sortino: down && down > 0 ? (ms / down) * Math.sqrt(252) : null,
      sr_period: ss && ss > 0 ? ms / ss : null,
      calmar: dd.dd < 0 ? net / -dd.dd : null,
      util_avg: utils.length ? mean(utils) : null, util_peak: utils.length ? maxOf(utils) : null,
      peak_margin: peakMargin || null, rom: peakMargin > 0 ? 100 * net / peakMargin : null,
      ret_pct: 100 * net / cap,
      cagr: span >= 365 ? 100 * (Math.pow(Math.max(1e-9, 1 + net / cap), 365 / span) - 1) : null,
      span_days: span,
      idle_pct: el.length ? 100 * (el.length - tr.length) / el.length : null,
      costs_pct_gross_profit: grossProfit > 0 ? 100 * costs / grossProfit : null,
      exits,
      sample: sampleClass(tr.length),
    };
  }

  // ================================================================== regime features (from index candles only)
  const UNAVAILABLE_INPUTS = [
    { key: 'india_vix', label: 'India VIX', why: 'Not ingested. No VIX table or file exists in the data store.' },
    { key: 'implied_vol', label: 'Historical implied volatility', why: 'Not ingested. Option candles exist, but no IV series is stored; the lab does not back IV out of candle prices for regime labels.' },
    { key: 'events', label: 'Event calendar (RBI, budget, results, elections)', why: 'Not ingested, so no session is labelled event-driven.' },
    { key: 'breadth', label: 'Market breadth', why: 'Not ingested (needs constituent data).' },
  ];

  function weekdaysBetween(a, b) { // weekdays strictly between two ISO dates
    let n = 0;
    for (let t = Date.parse(a + 'T00:00:00Z') + 86400000; t < Date.parse(b + 'T00:00:00Z'); t += 86400000) { const w = new Date(t).getUTCDay(); if (w !== 0 && w !== 6) n++; }
    return n;
  }

  /**
   * Per-session features from the index candles. Everything that uses another session looks only BACKWARD.
   * Cross-session features (gap, ATR, close-to-close vol) are null on synthetic data: synthetic sessions are
   * generated independently and all open at the same price, so there is no overnight move to measure.
   */
  function sessionFeatures(sessions, opts) {
    opts = Object.assign({ orMinutes: 30, atrN: 14, ccN: 10 }, opts || {});
    const ss = sessions.slice().sort(byDate), out = [];
    for (let i = 0; i < ss.length; i++) {
      const s = ss[i], u = s.und, n = s.times.length;
      let o = null, h = -Infinity, l = Infinity, c = null, bars = 0, rss = 0, last = null, orH = -Infinity, orL = Infinity;
      const orEnd = s.times[0] + opts.orMinutes;
      for (let k = 0; k < n; k++) {
        const ck = u.c[k]; if (ck == null) continue;
        bars++;
        if (o == null) o = u.o[k] != null ? u.o[k] : ck;
        const hk = u.h[k] != null ? u.h[k] : ck, lk = u.l[k] != null ? u.l[k] : ck;
        if (hk > h) h = hk; if (lk < l) l = lk;
        if (s.times[k] < orEnd) { if (hk > orH) orH = hk; if (lk < orL) orL = lk; }
        if (last != null && last > 0 && ck > 0) { const r = Math.log(ck / last); rss += r * r; }
        last = ck; c = ck;
      }
      const flags = [];
      const synthetic = s.source === 'synthetic';
      const metaFlags = (s.meta && s.meta.flags) || [];
      if (metaFlags.includes('index_from_spot')) flags.push('range_from_closes');
      if (bars < n) flags.push(`missing_index_bars:${n - bars}`);
      const f = { date: s.date, source: s.source || 'unknown', bars, expected_bars: n, flags,
        open: o, high: bars ? h : null, low: bars ? l : null, close: c,
        ret_pct: o && c ? 100 * (c / o - 1) : null,
        range_pct: o && bars ? 100 * (h - l) / o : null,
        rv_pct: bars > 30 ? Math.sqrt(rss * 252) * 100 : null,   // intraday realised vol, annualised; excludes the overnight move
        efficiency: bars && h > l ? Math.abs(c - o) / (h - l) : null,
        or_range_pct: o && orH > -Infinity ? 100 * (orH - orL) / o : null,
        gap_pct: null, gap_note: null, tr_pct: null, atr_prior_pct: null, cc_vol_prior_pct: null, rv_prev_pct: null };
      const prev = i > 0 ? out[i - 1] : null;
      if (prev) f.rv_prev_pct = prev.rv_pct;
      if (synthetic) f.gap_note = 'synthetic sessions are independent; no overnight move';
      else if (prev && prev.close && o) {
        const skipped = weekdaysBetween(prev.date, s.date);
        if (skipped <= 1) {
          f.gap_pct = 100 * (o / prev.close - 1);
          if (skipped === 1) f.gap_note = 'one weekday not stored before this session (holiday or missing); gap measured from the last stored close';
          f.tr_pct = 100 * (Math.max(h, prev.close) - Math.min(l, prev.close)) / prev.close;
        } else f.gap_note = `${skipped} weekdays not stored before this session; no gap measured`;
      } else if (!prev) f.gap_note = 'first session in the range; no previous close';
      out.push(f);
    }
    // trailing (strictly earlier sessions) ATR and close-to-close volatility: real data only, need a full window
    for (let i = 0; i < out.length; i++) {
      if (out[i].source === 'synthetic') continue;
      const past = out.slice(Math.max(0, i - opts.atrN), i).map((x) => x.tr_pct).filter((x) => x != null);
      if (past.length >= opts.atrN) out[i].atr_prior_pct = mean(past);
      const closes = out.slice(Math.max(0, i - opts.ccN - 1), i).map((x) => x.close);
      if (closes.length === opts.ccN + 1 && closes.every((x) => x)) {
        const rets = []; for (let k = 1; k < closes.length; k++) rets.push(Math.log(closes[k] / closes[k - 1]));
        out[i].cc_vol_prior_pct = sdev(rets) * Math.sqrt(252) * 100;
      }
    }
    return out;
  }

  // ================================================================== regime classification
  // Fixed thresholds are the default: they use no other session, so there is nothing to leak.
  // Percentile mode uses only EARLIER sessions (expanding window) and leaves the first `minHistory` as warm-up.
  const DEFAULT_THRESHOLDS = {
    vol_bands: [10, 15, 22],            // intraday realised vol, annualised %: low < 10 ≤ normal < 15 ≤ elevated < 22 ≤ extreme
    trend_weak: 0.25, trend_strong: 0.75, // |open-to-close| % of the index
    gap: 0.3,                            // |gap| % for gap-up / gap-down
    range_bands: [0.6, 1.2],             // high-low % of open: low < 0.6 ≤ normal < 1.2 ≤ high
    eff_trend: 0.5, eff_revert: 0.25,    // |close-open| / (high-low)
    atr_expand: 1.25, atr_contract: 0.75,
    minHistory: 20,
  };
  const VOL_LABELS = ['Low', 'Normal', 'Elevated', 'Extreme'];
  const bandOf = (x, bands) => { let k = 0; while (k < bands.length && x >= bands[k]) k++; return k; };

  /** Expanding-window percentile thresholds: for session i, quantiles of the feature over sessions < i. */
  function expandingBands(values, i, qs, minHistory) {
    const past = values.slice(0, i).filter((x) => x != null);
    if (past.length < minHistory) return null;
    const s = sortNum(past);
    return qs.map((q) => quantile(s, q));
  }

  /**
   * Labels every session on several dimensions. Each dimension says whether it is known before the entry
   * (ex-ante: usable as a filter) or only after the close (ex-post: describes what the day turned into).
   * dayInfo: optional { [date]: { is_expiry_day, dte } } from the engine results.
   */
  function classify(features, opts) {
    opts = opts || {};
    const th = Object.assign({}, DEFAULT_THRESHOLDS, opts.thresholds || {});
    const mode = opts.mode === 'percentile' ? 'percentile' : 'fixed';
    const dayInfo = opts.dayInfo || {};
    const F = features.slice().sort(byDate);
    const rv = F.map((f) => f.rv_pct), rvPrev = F.map((f) => f.rv_prev_pct), rng_ = F.map((f) => f.range_pct);
    const dims = [];
    const dim = (key, label, timing, basis, order, labelOf) => {
      const labels = {};
      F.forEach((f, i) => { labels[f.date] = labelOf(f, i); });
      dims.push({ key, label, timing, basis, order, labels });
    };
    const volLabel = (vals) => (f, i) => {
      const x = vals[i];
      if (x == null) return 'Unknown';
      if (mode === 'fixed') return VOL_LABELS[bandOf(x, th.vol_bands)];
      const b = expandingBands(vals, i, [0.25, 0.75, 0.95], th.minHistory);
      return b ? VOL_LABELS[bandOf(x, b)] : 'Warm-up';
    };
    const volBasis = mode === 'fixed' ? `intraday realised vol, annualised: < ${th.vol_bands[0]}% low, < ${th.vol_bands[1]}% normal, < ${th.vol_bands[2]}% elevated, above that extreme`
      : `percentile of all EARLIER sessions: < 25th low, < 75th normal, < 95th elevated, above extreme; first ${th.minHistory} sessions are warm-up`;
    dim('vol', 'Volatility (the session itself)', 'ex-post', volBasis, VOL_LABELS.concat(['Warm-up', 'Unknown']), volLabel(rv));
    dim('vol_prev', 'Volatility coming in (previous session)', 'ex-ante', volBasis.replace('intraday realised vol', "the previous session's intraday realised vol"),
      VOL_LABELS.concat(['Warm-up', 'Unknown']), volLabel(rvPrev));
    const TREND = ['Strong bullish', 'Weak bullish', 'Sideways', 'Weak bearish', 'Strong bearish'];
    dim('trend', 'Trend (open to close)', 'ex-post', `index open-to-close move: ±${th.trend_weak}% weak, ±${th.trend_strong}% strong`, TREND.concat(['Unknown']), (f) => {
      const r = f.ret_pct; if (r == null) return 'Unknown';
      if (r >= th.trend_strong) return TREND[0]; if (r >= th.trend_weak) return TREND[1];
      if (r <= -th.trend_strong) return TREND[4]; if (r <= -th.trend_weak) return TREND[3];
      return TREND[2];
    });
    dim('shape', 'Session type', 'ex-post', `efficiency = |close − open| / (high − low): ≥ ${th.eff_trend} trending, ≤ ${th.eff_revert} mean-reverting`,
      ['Trending', 'Mixed', 'Mean-reverting', 'Unknown'], (f) => (f.efficiency == null ? 'Unknown' : f.efficiency >= th.eff_trend ? 'Trending' : f.efficiency <= th.eff_revert ? 'Mean-reverting' : 'Mixed'));
    const RANGE = ['Low range', 'Normal range', 'High range'];
    dim('range', 'Intraday range', 'ex-post', mode === 'fixed' ? `high − low as % of open: < ${th.range_bands[0]}% low, ≥ ${th.range_bands[1]}% high`
      : `percentile of earlier sessions: < 25th low, ≥ 75th high; first ${th.minHistory} warm-up`, RANGE.concat(['Warm-up', 'Unknown']), (f, i) => {
      const x = rng_[i]; if (x == null) return 'Unknown';
      if (mode === 'fixed') return RANGE[bandOf(x, th.range_bands)];
      const b = expandingBands(rng_, i, [0.25, 0.75], th.minHistory);
      return b ? RANGE[bandOf(x, b)] : 'Warm-up';
    });
    const anyReal = F.some((f) => f.source !== 'synthetic');
    if (anyReal) {
      dim('gap', 'Opening gap', 'ex-ante', `open vs previous stored close: ≥ +${th.gap}% gap-up, ≤ −${th.gap}% gap-down`, ['Gap-up', 'Flat open', 'Gap-down', 'Unknown'], (f) =>
        (f.gap_pct == null ? 'Unknown' : f.gap_pct >= th.gap ? 'Gap-up' : f.gap_pct <= -th.gap ? 'Gap-down' : 'Flat open'));
      dim('atr', 'Range vs recent ATR', 'ex-post', `true range vs the mean true range of the previous sessions (simple ATR, needs a full window): ≥ ${th.atr_expand}× expansion, ≤ ${th.atr_contract}× contraction`,
        ['Expansion', 'Normal', 'Contraction', 'Warm-up'], (f) => {
          if (f.atr_prior_pct == null || f.tr_pct == null) return 'Warm-up';
          const x = f.tr_pct / f.atr_prior_pct;
          return x >= th.atr_expand ? 'Expansion' : x <= th.atr_contract ? 'Contraction' : 'Normal';
        });
    }
    const anyExpiry = Object.keys(dayInfo).some((d) => dayInfo[d] && dayInfo[d].is_expiry_day != null);
    if (anyExpiry) {
      dim('expiry', 'Expiry cycle (assumed expiry dates)', 'ex-ante', 'from the engine: the traded series expires today, tomorrow, or later. Expiry dates are ASSUMED until checked against the bhavcopy',
        ['Expiry day', 'Day before expiry', 'Other days', 'Unknown'], (f) => {
          const x = dayInfo[f.date];
          if (!x || x.is_expiry_day == null) return 'Unknown';
          return x.is_expiry_day ? 'Expiry day' : x.dte === 1 ? 'Day before expiry' : 'Other days';
        });
    }
    const notes = [];
    if (!anyReal) notes.push('Synthetic sessions: gap, ATR and multi-day measures are not computed, because synthetic days are generated independently and all open at the same price.');
    return { mode, thresholds: th, dims, unavailable: UNAVAILABLE_INPUTS, notes };
  }

  /** Performance of the strategy inside each regime label, plus how consistent it is across labels. */
  function regimeBreakdown(days, classification, opts) {
    opts = Object.assign({ minTraded: 5 }, opts || {});
    const total = perf(days, opts);
    const out = [];
    for (const d of classification.dims) {
      const groups = {};
      for (const day of days) {
        if (!ELIGIBLE(day)) continue;
        const lab = d.labels[day.date] || 'Unknown';
        (groups[lab] || (groups[lab] = [])).push(day);
      }
      const rows = d.order.filter((lab) => groups[lab]).concat(Object.keys(groups).filter((k) => !d.order.includes(k)))
        .map((lab) => { const p = perf(groups[lab], opts); return { label: lab, p, share_net: total.net !== 0 ? 100 * p.net / Math.abs(total.net) : null, enough: p.traded >= opts.minTraded }; });
      const judged = rows.filter((r) => r.enough && !['Unknown', 'Warm-up'].includes(r.label));
      const pos = judged.filter((r) => r.p.mean > 0);
      const best = judged.slice().sort((a, b) => b.p.mean - a.p.mean)[0] || null;
      const worst = judged.slice().sort((a, b) => a.p.mean - b.p.mean)[0] || null;
      const overlap = best && worst && best !== worst && best.p.ci && worst.p.ci ? best.p.ci[0] <= worst.p.ci[1] : null;
      out.push({ key: d.key, label: d.label, timing: d.timing, basis: d.basis, rows,
        consistency: judged.length >= 2 ? { judged: judged.length, positive: pos.length, share: pos.length / judged.length, best: best.label, worst: worst.label, cis_overlap: overlap } : null });
    }
    return { total, dims: out, min_traded: opts.minTraded };
  }

  // ================================================================== chronological models (gated by sample size)
  /** k-means on standardised session features, fitted on the first 60% of sessions only. */
  function kmeansRegimes(features, opts) {
    opts = Object.assign({ k: 3, minSessions: 60, trainFrac: 0.6, seed: 11, iters: 50 }, opts || {});
    const keys = ['rv_pct', 'range_pct', 'abs_ret', 'efficiency'];
    const F = features.slice().sort(byDate).map((f) => ({ date: f.date, x: [f.rv_pct, f.range_pct, f.ret_pct == null ? null : Math.abs(f.ret_pct), f.efficiency] }))
      .filter((r) => r.x.every((v) => v != null));
    if (F.length < opts.minSessions) return { status: 'not_run', reason: `needs at least ${opts.minSessions} sessions with complete index candles; this range has ${F.length}` };
    const nTrain = Math.floor(F.length * opts.trainFrac), train = F.slice(0, nTrain);
    const mu = keys.map((_, j) => mean(train.map((r) => r.x[j]))), sg = keys.map((_, j) => sdev(train.map((r) => r.x[j])) || 1);
    const z = (x) => x.map((v, j) => (v - mu[j]) / sg[j]);
    const Z = F.map((r) => z(r.x)), Ztr = Z.slice(0, nTrain);
    const R = rng(opts.seed);
    let cent = [Ztr[Math.floor(R() * Ztr.length)]];
    while (cent.length < opts.k) { // k-means++ seeding, deterministic
      const d2 = Ztr.map((p) => Math.min(...cent.map((c) => c.reduce((a, v, j) => a + (v - p[j]) ** 2, 0))));
      let u = R() * sum(d2), idx = 0; while (idx < d2.length - 1 && u > d2[idx]) { u -= d2[idx]; idx++; }
      cent.push(Ztr[idx]);
    }
    const nearest = (p) => { let b = 0, bd = Infinity; cent.forEach((c, i) => { const d = c.reduce((a, v, j) => a + (v - p[j]) ** 2, 0); if (d < bd) { bd = d; b = i; } }); return b; };
    for (let it = 0; it < opts.iters; it++) {
      const asg = Ztr.map(nearest);
      const next = cent.map((c, i) => { const m = Ztr.filter((_, q) => asg[q] === i); return m.length ? c.map((_, j) => mean(m.map((p) => p[j]))) : c; });
      const moved = next.some((c, i) => c.some((v, j) => Math.abs(v - cent[i][j]) > 1e-9));
      cent = next; if (!moved) break;
    }
    // order clusters by centroid realised vol so labels are stable: calmest first
    const order = cent.map((c, i) => [c[0], i]).sort((a, b) => a[0] - b[0]).map((p) => p[1]);
    const name = (i) => `Cluster ${order.indexOf(i) + 1}`;
    const labels = {}; F.forEach((r, i) => { labels[r.date] = name(nearest(Z[i])); });
    const centroids = order.map((i) => ({ label: name(i), rv_pct: cent[i][0] * sg[0] + mu[0], range_pct: cent[i][1] * sg[1] + mu[1], abs_ret_pct: cent[i][2] * sg[2] + mu[2], efficiency: cent[i][3] * sg[3] + mu[3] }));
    return { status: 'ok', method: 'k-means (k-means++ seed, fixed), features standardised on the training sessions only', train_to: F[nTrain - 1].date, test_from: F[nTrain] ? F[nTrain].date : null,
      labels, centroids, k: opts.k, sessions: F.length };
  }

  /** Two-state Gaussian HMM on log realised vol. Fitted (Baum-Welch) on the training sessions; test sessions
   *  get FILTERED probabilities (forward pass only), so no label ever uses a later session. */
  function hmmVol(features, opts) {
    opts = Object.assign({ minSessions: 120, trainFrac: 0.6, iters: 60 }, opts || {});
    const F = features.slice().sort(byDate).filter((f) => f.rv_pct != null && f.rv_pct > 0);
    if (F.length < opts.minSessions) return { status: 'not_run', reason: `needs at least ${opts.minSessions} sessions to estimate how regimes persist; this range has ${F.length}` };
    const x = F.map((f) => Math.log(f.rv_pct)), nTr = Math.floor(F.length * opts.trainFrac), xt = x.slice(0, nTr);
    const s = sortNum(xt);
    let mu = [quantile(s, 0.25), quantile(s, 0.75)], va = [sdev(xt) ** 2, sdev(xt) ** 2], A = [[0.9, 0.1], [0.1, 0.9]], pi = [0.5, 0.5];
    const pdf = (v, k) => Math.exp(-((v - mu[k]) ** 2) / (2 * va[k])) / Math.sqrt(2 * Math.PI * va[k]);
    function forward(xs) {
      const al = [], cs = [];
      for (let t = 0; t < xs.length; t++) {
        const a = [0, 1].map((k) => (t === 0 ? pi[k] : al[t - 1][0] * A[0][k] + al[t - 1][1] * A[1][k]) * pdf(xs[t], k));
        const c = a[0] + a[1] || 1e-300; al.push([a[0] / c, a[1] / c]); cs.push(c);
      }
      return { al, cs };
    }
    let ll = -Infinity;
    for (let it = 0; it < opts.iters; it++) {
      const { al, cs } = forward(xt), T = xt.length, be = new Array(T);
      be[T - 1] = [1, 1];
      for (let t = T - 2; t >= 0; t--) { const b = [0, 1].map((i) => A[i][0] * pdf(xt[t + 1], 0) * be[t + 1][0] + A[i][1] * pdf(xt[t + 1], 1) * be[t + 1][1]); be[t] = [b[0] / cs[t + 1], b[1] / cs[t + 1]]; }
      const g = al.map((a, t) => { const v = [a[0] * be[t][0], a[1] * be[t][1]]; const z = v[0] + v[1] || 1e-300; return [v[0] / z, v[1] / z]; });
      const xi = [[0, 0], [0, 0]];
      for (let t = 0; t < T - 1; t++) {
        let z = 0; const m = [[0, 0], [0, 0]];
        for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) { m[i][j] = al[t][i] * A[i][j] * pdf(xt[t + 1], j) * be[t + 1][j]; z += m[i][j]; }
        for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) xi[i][j] += m[i][j] / (z || 1e-300);
      }
      pi = g[0].slice();
      A = [0, 1].map((i) => { const r = xi[i][0] + xi[i][1] || 1; return [xi[i][0] / r, xi[i][1] / r]; });
      mu = [0, 1].map((k) => sum(g.map((gg, t) => gg[k] * xt[t])) / (sum(g.map((gg) => gg[k])) || 1));
      va = [0, 1].map((k) => Math.max(1e-4, sum(g.map((gg, t) => gg[k] * (xt[t] - mu[k]) ** 2)) / (sum(g.map((gg) => gg[k])) || 1)));
      const nll = sum(cs.map(Math.log));
      if (Math.abs(nll - ll) < 1e-8) { ll = nll; break; }
      ll = nll;
    }
    const calm = mu[0] <= mu[1] ? 0 : 1, hot = 1 - calm;
    const { al } = forward(x);   // filtering over ALL sessions with train-fitted parameters: only past and present data per step
    const labels = {}, prob = {};
    F.forEach((f, t) => { prob[f.date] = al[t][hot]; labels[f.date] = al[t][hot] >= 0.5 ? 'High-vol state' : 'Calm state'; });
    return { status: 'ok', method: '2-state Gaussian HMM on log intraday realised vol; Baum-Welch on training sessions, forward filtering only',
      train_to: F[nTr - 1].date, states: [{ label: 'Calm state', rv_pct: Math.exp(mu[calm]), stay_prob: A[calm][calm] }, { label: 'High-vol state', rv_pct: Math.exp(mu[hot]), stay_prob: A[hot][hot] }],
      labels, prob_high: prob, loglik_train: ll, sessions: F.length };
  }

  /** Does yesterday's realised vol forecast today's better than "same as yesterday"? AR(1) on log RV,
   *  fitted on the training sessions, scored on later sessions only. */
  function volForecast(features, opts) {
    opts = Object.assign({ minSessions: 60, trainFrac: 0.6 }, opts || {});
    const F = features.slice().sort(byDate).filter((f) => f.rv_pct > 0 && f.rv_prev_pct > 0);
    if (F.length < opts.minSessions) return { status: 'not_run', reason: `needs at least ${opts.minSessions} consecutive sessions; this range has ${F.length}` };
    const nTr = Math.floor(F.length * opts.trainFrac);
    const X = F.map((f) => Math.log(f.rv_prev_pct)), Y = F.map((f) => Math.log(f.rv_pct));
    const xt = X.slice(0, nTr), yt = Y.slice(0, nTr), mx = mean(xt), my = mean(yt);
    let sxy = 0, sxx = 0; for (let i = 0; i < nTr; i++) { sxy += (xt[i] - mx) * (yt[i] - my); sxx += (xt[i] - mx) ** 2; }
    const b = sxx > 0 ? sxy / sxx : 0, a = my - b * mx;
    let seM = 0, seN = 0, seC = 0; const nTe = F.length - nTr;
    for (let i = nTr; i < F.length; i++) { seM += (Y[i] - (a + b * X[i])) ** 2; seN += (Y[i] - X[i]) ** 2; seC += (Y[i] - my) ** 2; }
    const rm = Math.sqrt(seM / nTe), rn = Math.sqrt(seN / nTe), rc = Math.sqrt(seC / nTe);
    return { status: 'ok', method: 'AR(1) on log realised vol, least squares on the training sessions', train_to: F[nTr - 1].date, test_sessions: nTe,
      coef: { a, b }, rmse_model: rm, rmse_naive: rn, rmse_mean: rc, beats_naive: rm < rn, beats_mean: rm < rc };
  }

  /** Can facts known before entry (gap, previous session's vol, opening-range width, expiry) tell a winning
   *  day from a losing one? Logistic regression, trained on early traded days, scored on later ones. */
  function entryFilterModel(days, features, dayInfo, opts) {
    opts = Object.assign({ minTraded: 80, trainFrac: 0.6, l2: 0.1, iters: 400, lr: 0.1 }, opts || {});
    const fx = {}; for (const f of features) fx[f.date] = f;
    const rows = days.filter((d) => d.traded && fx[d.date]).sort(byDate).map((d) => {
      const f = fx[d.date], info = (dayInfo || {})[d.date] || {};
      return { date: d.date, y: d.net > 0 ? 1 : 0, x: [f.gap_pct, f.rv_prev_pct, f.or_range_pct, info.is_expiry_day == null ? null : (info.is_expiry_day ? 1 : 0)] };
    });
    const cols = [0, 1, 2, 3].filter((j) => rows.length && rows.every((r) => r.x[j] != null));
    const names = ['opening gap %', "previous session's realised vol", 'opening-range width %', 'expiry day'];
    if (rows.length < opts.minTraded) return { status: 'not_run', reason: `needs at least ${opts.minTraded} traded days; this range has ${rows.length}` };
    if (!cols.length) return { status: 'not_run', reason: 'no ex-ante feature is available on every traded day' };
    const nTr = Math.floor(rows.length * opts.trainFrac), tr = rows.slice(0, nTr), te = rows.slice(nTr);
    const mu = cols.map((j) => mean(tr.map((r) => r.x[j]))), sg = cols.map((j) => sdev(tr.map((r) => r.x[j])) || 1);
    const z = (r) => cols.map((j, q) => (r.x[j] - mu[q]) / sg[q]);
    let w = new Array(cols.length).fill(0), b0 = 0;
    const sig = (v) => 1 / (1 + Math.exp(-v));
    for (let it = 0; it < opts.iters; it++) {
      const gw = new Array(cols.length).fill(0); let gb = 0;
      for (const r of tr) { const xz = z(r), p = sig(b0 + xz.reduce((a, v, q) => a + v * w[q], 0)), e = p - r.y; gb += e; xz.forEach((v, q) => { gw[q] += e * v; }); }
      b0 -= opts.lr * gb / tr.length; w = w.map((v, q) => v - opts.lr * (gw[q] / tr.length + opts.l2 * v));
    }
    const ps = te.map((r) => sig(b0 + z(r).reduce((a, v, q) => a + v * w[q], 0)));
    const base = mean(tr.map((r) => r.y));
    const acc = mean(te.map((r, i) => ((ps[i] >= 0.5 ? 1 : 0) === r.y ? 1 : 0)));
    const accBase = mean(te.map((r) => ((base >= 0.5 ? 1 : 0) === r.y ? 1 : 0)));
    const brier = mean(te.map((r, i) => (ps[i] - r.y) ** 2)), brierBase = mean(te.map((r) => (base - r.y) ** 2));
    // AUC by ranks
    const pos = te.map((r, i) => [ps[i], r.y]);
    const nP = pos.filter((p) => p[1] === 1).length, nN = pos.length - nP;
    let auc = null;
    if (nP && nN) { let s = 0; for (const a of pos) if (a[1] === 1) for (const c of pos) if (c[1] === 0) s += a[0] > c[0] ? 1 : a[0] === c[0] ? 0.5 : 0; auc = s / (nP * nN); }
    return { status: 'ok', method: 'L2 logistic regression on ex-ante features, standardised on the training days only', features: cols.map((j) => names[j]),
      coef: cols.map((j, q) => ({ feature: names[j], weight: w[q] })), train_to: tr[tr.length - 1].date, test_days: te.length,
      accuracy: acc, accuracy_base: accBase, brier, brier_base: brierBase, auc, beats_base: brier < brierBase };
  }

  // ================================================================== optimisation lab
  /** What can be searched, per strategy. Keys are Lab parameters or engine configuration keys. */
  const PARAM_SPACE = {
    straddle: [
      { key: 'sl_pct', label: 'Stop per leg', unit: '%', kind: 'range', min: 20, max: 75, step: 1, sweep: [25, 30, 36, 45, 55] },
      { key: 'target_per_lot', label: 'Profit target per lot', unit: '₹', kind: 'range', min: 500, max: 3000, step: 100, sweep: [600, 1000, 1500, 2000] },
      { key: 'reentry_enabled', label: 'Re-entry after a stop', kind: 'choice', options: [true, false] },
      { key: 'entry_condition', label: 'Entry candle must', kind: 'choice', options: ['full', 'body', 'close', 'overlap'] },
      { key: 'strike_offset', label: 'Strike (from ATM)', kind: 'range', min: -3, max: 5, step: 1, sweep: [0, 1, 2] },
      { key: 'exit_time', label: 'Exit time', kind: 'choice', options: ['14:30', '14:45', '15:00', '15:15'], engine: true },
      { key: 'reentry_cutoff', label: 'No new positions after', kind: 'choice', options: ['12:00', '13:00', '14:00', '14:30'], engine: true },
      { key: 'max_loss_per_lot', label: 'Daily loss cap per lot (0 = off)', unit: '₹', kind: 'range', min: 0, max: 5000, step: 500, sweep: [0, 1500, 3000], engine: true },
      { key: 'skip_expiry_day', label: 'Skip expiry day', kind: 'choice', options: [false, true], engine: true },
      { key: 'max_or_width_pct', label: 'Max opening-range width (vol filter)', unit: '%', kind: 'range', min: 0.3, max: 2, step: 0.1, sweep: [0.5, 0.8, 100], engine: true },
    ],
    orb: [
      { key: 'target_points', label: 'Target (premium points)', kind: 'range', min: 10, max: 80, step: 5, sweep: [20, 30, 45, 60] },
      { key: 'stop_buffer', label: 'Structural stop buffer', kind: 'range', min: 0, max: 30, step: 5, sweep: [0, 10, 20] },
      { key: 'breakout_def', label: 'Breakout means', kind: 'choice', options: ['wick', 'close', 'body'] },
      { key: 'strike_offset', label: 'Strike (from ATM)', kind: 'range', min: -3, max: 3, step: 1, sweep: [0, 1] },
      { key: 'latest_entry', label: 'Latest entry', kind: 'choice', options: ['12:00', '13:00', '14:30'], engine: true },
      { key: 'exit_time', label: 'Exit time', kind: 'choice', options: ['14:30', '15:00', '15:15'], engine: true },
      { key: 'max_hold_minutes', label: 'Max hold (minutes, 0 = off)', kind: 'range', min: 0, max: 240, step: 30, sweep: [0, 60, 120], engine: true },
    ],
  };

  function axisValues(ax) {
    if (Array.isArray(ax.values) && ax.values.length) return ax.values.slice();
    if (ax.kind === 'choice') return ax.options.slice();
    const out = [], step = ax.step || 1;
    for (let v = ax.min; v <= ax.max + 1e-9; v += step) out.push(Math.round(v / step) * step === v ? v : Number(v.toFixed(6)));
    return out;
  }
  const keyOf = (p, keys) => JSON.stringify(keys.map((k) => p[k]));

  /** Candidates to evaluate. The user's own settings are always candidate 0. */
  function planCandidates(base, axes, opts) {
    opts = Object.assign({ method: 'auto', budget: 200, seed: 1 }, opts || {});
    const vals = axes.map(axisValues), keys = axes.map((a) => a.key);
    const size = vals.reduce((a, v) => a * v.length, 1);
    const method = opts.method === 'auto' ? (size <= opts.budget ? 'grid' : 'random') : opts.method;
    const seen = new Set(), out = [];
    const push = (p) => { const k = keyOf(p, keys); if (seen.has(k)) return; seen.add(k); out.push(p); };
    push(Object.assign({}, base));
    if (method === 'grid') {
      if (size > opts.budget) throw new Error(`The grid has ${size} combinations, more than the budget of ${opts.budget}. Narrow the ranges, raise the budget, or use random search.`);
      const idx = new Array(axes.length).fill(0);
      for (let c = 0; c < size; c++) {
        const p = Object.assign({}, base); keys.forEach((k, i) => { p[k] = vals[i][idx[i]]; }); push(p);
        for (let i = axes.length - 1; i >= 0; i--) { idx[i]++; if (idx[i] < vals[i].length) break; idx[i] = 0; }
      }
    } else {
      const R = rng(opts.seed);
      let tries = 0;
      while (out.length < Math.min(opts.budget + 1, size + 1) && tries < opts.budget * 20) {
        tries++;
        const p = Object.assign({}, base); keys.forEach((k, i) => { p[k] = vals[i][Math.floor(R() * vals[i].length)]; }); push(p);
      }
    }
    return { method, space_size: size, candidates: out, keys };
  }

  const OBJECTIVES = {
    net: { label: 'Net profit', get: (p) => p.net },
    cagr: { label: 'CAGR', get: (p) => p.cagr, needs: 'a window of at least one year' },
    sharpe: { label: 'Sharpe ratio (daily, annualised)', get: (p) => p.sharpe },
    sortino: { label: 'Sortino ratio', get: (p) => p.sortino },
    pf: { label: 'Profit factor', get: (p) => p.pf },
    win_rate: { label: 'Win rate', get: (p) => p.win_rate },
    min_dd: { label: 'Smallest maximum drawdown', get: (p) => p.max_dd },
    rom: { label: 'Return on peak margin (est.)', get: (p) => p.rom },
    calmar: { label: 'Risk-adjusted: net / max drawdown', get: (p) => p.calmar },
    custom: { label: 'Custom weighted (rank-based)' },
  };
  const CUSTOM_KEYS = ['net', 'sharpe', 'sortino', 'pf', 'win_rate', 'min_dd', 'rom', 'calmar'];

  /** Scores for a set of candidates' performance in one window. Ineligible (too few trades, or the metric
   *  cannot be computed) scores -Infinity. Custom = weighted mean of percentile ranks among eligible ones. */
  function scoreAll(perfs, objective, minTrades, weights) {
    const ok = perfs.map((p) => p.traded >= minTrades);
    if (objective !== 'custom') {
      const g = OBJECTIVES[objective].get;
      return perfs.map((p, i) => { const v = g(p); return ok[i] && v != null && isFinite(v) ? v : -Infinity; });
    }
    const w = weights || { sharpe: 1, net: 1, min_dd: 1 };
    const ks = CUSTOM_KEYS.filter((k) => w[k] > 0), wsum = sum(ks.map((k) => w[k])) || 1;
    const idx = perfs.map((_, i) => i).filter((i) => ok[i]);
    const ranks = {};
    for (const k of ks) {
      const g = OBJECTIVES[k].get, v = idx.map((i) => [g(perfs[i]), i]).filter((x) => x[0] != null && isFinite(x[0])).sort((a, b) => a[0] - b[0]);
      ranks[k] = {}; v.forEach((x, r) => { ranks[k][x[1]] = v.length > 1 ? r / (v.length - 1) : 1; });
    }
    return perfs.map((_, i) => (ok[i] ? sum(ks.map((k) => w[k] * (ranks[k][i] != null ? ranks[k][i] : 0))) / wsum : -Infinity));
  }

  /** Chronological split by session index. No session appears in two windows. */
  function splitChrono(n, fr) {
    fr = Object.assign({ train: 0.6, validation: 0.2, test: 0.2 }, fr || {});
    const tot = fr.train + fr.validation + fr.test;
    const a = Math.round(n * fr.train / tot), b = Math.round(n * (fr.train + fr.validation) / tot);
    return { train: [0, a], validation: [a, b], test: [b, n] };
  }

  /**
   * Walk-forward: choose the best candidate on each training window using only that window, then record what
   * it did on the next, unseen test window. anchored = training starts at session 0; rolling = fixed length.
   */
  function walkForward(evals, dates, o) {
    o = Object.assign({ mode: 'rolling', train: null, test: null, objective: 'sharpe', minTrades: 3, capital: 500000 }, o || {});
    const n = dates.length;
    const train = o.train || Math.max(5, Math.round(n * 0.5)), test = o.test || Math.max(2, Math.round(n * 0.125)), step = o.step || test;
    const folds = [];
    for (let s = train; s < n; s += step) {
      const tr = [o.mode === 'anchored' ? 0 : s - train, s], te = [s, Math.min(n, s + test)];
      const isPerf = evals.map((e) => perf(e.days.slice(tr[0], tr[1]), o));
      const sc = scoreAll(isPerf, o.objective, o.minTrades, o.weights);
      let best = -1; sc.forEach((v, i) => { if (v > -Infinity && (best < 0 || v > sc[best])) best = i; });
      if (best < 0) { folds.push({ train: [dates[tr[0]], dates[tr[1] - 1]], test: [dates[te[0]], dates[te[1] - 1]], chosen: null, reason: 'no candidate met the minimum trade count in this training window' }); continue; }
      folds.push({ train: [dates[tr[0]], dates[tr[1] - 1]], test: [dates[te[0]], dates[te[1] - 1]], train_idx: tr, test_idx: te, chosen: best,
        is: isPerf[best], oos: perf(evals[best].days.slice(te[0], te[1]), o), orig_oos: perf(evals[0].days.slice(te[0], te[1]), o) });
    }
    const used = folds.filter((f) => f.chosen != null);
    const oosDays = used.map((f) => evals[f.chosen].days.slice(f.test_idx[0], f.test_idx[1])).flat();
    const origDays = used.map((f) => evals[0].days.slice(f.test_idx[0], f.test_idx[1])).flat();
    const oos = perf(oosDays, o), orig = perf(origDays, o);
    const isMean = used.length ? mean(used.map((f) => f.is.per_session || 0)) : null;
    const chosenSet = new Set(used.map((f) => f.chosen));
    return { mode: o.mode, train_sessions: train, test_sessions: test, step, folds, oos, original_oos: orig,
      wfe: isMean && isMean > 0 && oos.per_session != null ? oos.per_session / isMean : null,
      distinct_choices: chosenSet.size, churn: used.length ? chosenSet.size / used.length : null,
      status: used.length >= 2 ? 'ok' : used.length === 1 ? 'thin' : 'not_run',
      reason: used.length ? null : `needs more than ${train} sessions to form one training window and a test window; this range has ${n}` };
  }

  /** Probability of backtest overfitting by combinatorially symmetric cross-validation (Bailey et al. 2015). */
  function pbo(evals, o) {
    o = Object.assign({ blocks: 8, minBlock: 5, objective: 'per_session' }, o || {});
    const N = evals.length, T = evals.length ? evals[0].days.length : 0;
    let S = o.blocks; while (S > 2 && T / S < o.minBlock) S -= 2;
    if (N < 4) return { status: 'not_run', reason: `needs at least 4 configurations; tested ${N}` };
    if (S < 4) return { status: 'not_run', reason: `needs at least ${4 * o.minBlock} sessions to cut into 4+ blocks of ${o.minBlock}; this range has ${T}` };
    const bounds = []; for (let b = 0; b < S; b++) bounds.push([Math.floor(b * T / S), Math.floor((b + 1) * T / S)]);
    // per candidate per block: sum and count of per-session P&L (excluded days skipped)
    const stats = evals.map((e) => bounds.map(([a, b]) => { let s = 0, s2 = 0, c = 0; for (let i = a; i < b; i++) { const d = e.days[i]; if (!ELIGIBLE(d)) continue; const v = d.traded ? d.net : 0; s += v; s2 += v * v; c++; } return { s, s2, c }; }));
    const val = (st, set) => { let s = 0, s2 = 0, c = 0; for (const b of set) { s += st[b].s; s2 += st[b].s2; c += st[b].c; } if (!c) return -Infinity;
      const m = s / c; if (o.objective === 'per_session') return m; const v = c > 1 ? (s2 - c * m * m) / (c - 1) : 0; return v > 0 ? m / Math.sqrt(v) : (m > 0 ? 1e9 : m < 0 ? -1e9 : 0); };
    const combos = []; (function rec(start, cur) { if (cur.length === S / 2) { combos.push(cur.slice()); return; } for (let b = start; b < S; b++) { cur.push(b); rec(b + 1, cur); cur.pop(); } })(0, []);
    const logits = [];
    for (const is of combos) {
      const oos = []; for (let b = 0; b < S; b++) if (!is.includes(b)) oos.push(b);
      const isv = stats.map((st) => val(st, is)), oosv = stats.map((st) => val(st, oos));
      let best = 0; isv.forEach((v, i) => { if (v > isv[best]) best = i; });
      const below = oosv.filter((v) => v < oosv[best]).length, ties = oosv.filter((v) => v === oosv[best]).length - 1;
      const w = (below + 0.5 * ties + 1) / (N + 1);
      logits.push(Math.log(w / (1 - w)));
    }
    return { status: 'ok', blocks: S, combinations: combos.length, configs: N, pbo: logits.filter((l) => l <= 0).length / logits.length,
      median_logit: quantile(sortNum(logits), 0.5) };
  }

  /** Probabilistic and deflated Sharpe ratio (Bailey & López de Prado 2012, 2014). sr is per period (not annualised). */
  function deflatedSharpe(sr, T, sk, ku, trials, srVar) {
    if (sr == null || T < 3) return null;
    const den = Math.sqrt(Math.max(1e-12, 1 - sk * sr + (ku - 1) / 4 * sr * sr));
    const psr = (ref) => normCdf((sr - ref) * Math.sqrt(T - 1) / den);
    const g = 0.5772156649;
    const sr0 = trials > 1 && srVar > 0 ? Math.sqrt(srVar) * ((1 - g) * normInv(1 - 1 / trials) + g * normInv(1 - 1 / (trials * Math.E))) : 0;
    return { sr, T, skew: sk, kurt: ku, trials, sr0, psr: psr(0), dsr: psr(sr0) };
  }

  /**
   * Monte Carlo on the sequence of traded-day P&L.
   *  - bootstrap: draw days with replacement (iid, or circular blocks of length L to keep streaks together)
   *  - shuffle:   same days, random order: total is fixed, the drawdown is not
   */
  function monteCarlo(nets, o) {
    o = Object.assign({ paths: 2000, seed: 7, method: 'block', block: null, capital: 500000, ddLevels: [5, 10, 20] }, o || {});
    const n = nets.length;
    if (n < 2) return { status: 'not_run', reason: `needs at least 2 traded days; this sample has ${n}` };
    const R = rng(o.seed), L = o.method === 'block' ? (o.block || Math.max(2, Math.round(Math.cbrt(n)))) : 1;
    const totals = new Float64Array(o.paths), dds = new Float64Array(o.paths), sdd = new Float64Array(o.paths);
    const path = new Float64Array(n);
    for (let p = 0; p < o.paths; p++) {
      let k = 0;
      while (k < n) { const s = Math.floor(R() * n); for (let j = 0; j < L && k < n; j++) path[k++] = nets[(s + j) % n]; }
      let cum = 0, peak = 0, dd = 0; for (let i = 0; i < n; i++) { cum += path[i]; if (cum > peak) peak = cum; if (cum - peak < dd) dd = cum - peak; }
      totals[p] = cum; dds[p] = dd;
      const sh = nets.slice(); for (let i = n - 1; i > 0; i--) { const j = Math.floor(R() * (i + 1)); const t = sh[i]; sh[i] = sh[j]; sh[j] = t; }
      cum = 0; peak = 0; dd = 0; for (let i = 0; i < n; i++) { cum += sh[i]; if (cum > peak) peak = cum; if (cum - peak < dd) dd = cum - peak; }
      sdd[p] = dd;
    }
    const T = sortNum(Array.from(totals)), D = sortNum(Array.from(dds)), SD = sortNum(Array.from(sdd));
    const q = (a, x) => quantile(a, x);
    const lo = T[0], hi = T[T.length - 1], bins = 24, hist = new Array(bins).fill(0);
    for (const v of T) hist[Math.min(bins - 1, Math.floor(hi > lo ? (v - lo) / (hi - lo) * bins : 0))]++;
    return { status: 'ok', n, paths: o.paths, method: o.method, block: L, seed: o.seed, actual_total: sum(nets), actual_dd: maxDrawdown(nets).dd,
      total: { p5: q(T, 0.05), p25: q(T, 0.25), p50: q(T, 0.5), p75: q(T, 0.75), p95: q(T, 0.95) },
      p_loss: T.filter((v) => v < 0).length / T.length,
      dd: { p50: q(D, 0.5), p95: q(D, 0.05), p99: q(D, 0.01) },
      shuffle_dd: { p50: q(SD, 0.5), p95: q(SD, 0.05) },
      dd_exceed: o.ddLevels.map((x) => ({ pct: x, prob: D.filter((v) => -v > x / 100 * o.capital).length / D.length })),
      hist: { lo, hi, counts: hist },
      sample: sampleClass(n) };
  }

  /** Transaction-cost stress scenarios. Each returns parameter overrides; cost_mult scales statutory charges. */
  function costScenarios(p) {
    const slip = Number(p.slip_pct != null ? p.slip_pct : 0.5), brk = Number(p.brokerage_per_order != null ? p.brokerage_per_order : 20);
    return [
      { key: 'base', label: 'As run', over: {} },
      { key: 'slip_plus', label: `Slippage +0.5 pt (${slip}% → ${+(slip + 0.5).toFixed(2)}%)`, over: { slip_pct: slip + 0.5 } },
      { key: 'slip_x2', label: `Slippage doubled (${+(slip * 2).toFixed(2)}%)`, over: { slip_pct: slip * 2 } },
      { key: 'brk_x2', label: `Brokerage doubled (₹${brk * 2} per order)`, over: { brokerage_per_order: brk * 2 } },
      { key: 'stat_125', label: 'Statutory charges +25%', over: { cost_mult: 1.25 } },
      { key: 'all', label: 'All of the above together', over: { slip_pct: Math.max(slip + 0.5, slip * 2), brokerage_per_order: brk * 2, cost_mult: 1.25 } },
    ];
  }

  const INERT_SLIP = 'not measurable: the slippage setting changed nothing, because fills use the bid/ask quoted in the data (the synthetic model quotes one; stored real candles do not)';
  /**
   * Break-even slippage by bisection on slip_pct between the setting and +5 points. When the slippage rows
   * equal the as-run row to the rupee, the engine is filling at quoted bid/ask and ignores slip_pct: say so
   * rather than report a break-even (or "still profitable") that was never tested.
   */
  async function breakEvenSlip(p0, rowsS, evalOne, o, tick) {
    const s0 = Number(p0.slip_pct != null ? p0.slip_pct : 0.5), base = rowsS[0].p;
    const slipRows = rowsS.filter((r) => r.key === 'slip_plus' || r.key === 'slip_x2');
    const inert = base.traded > 0 && slipRows.length > 0 && slipRows.every((r) => r.p.net === base.net && r.p.traded === base.traded);
    if (inert) { slipRows.forEach((r) => { r.inert = true; }); return { break_even_slip: null, break_even_note: INERT_SLIP, base_slip: s0, slip_inert: true }; }
    if (base.net <= 0) return { break_even_slip: null, break_even_note: base.traded > 0 ? 'already loses at the slippage it was run with' : 'no trades to test', base_slip: s0, slip_inert: false };
    const netAt = async (x) => { const v = perf(await evalOne(Object.assign({}, p0, { slip_pct: +x.toFixed(3) })), o).net; tick(); return v; };
    let lo = s0, hi = s0 + 5;
    if ((await netAt(hi)) > 0) return { break_even_slip: null, break_even_note: `still profitable at ${+(s0 + 5).toFixed(2)}% slippage`, base_slip: s0, slip_inert: false };
    for (let it = 0; it < 6; it++) { const mid = (lo + hi) / 2; if ((await netAt(mid)) > 0) lo = mid; else hi = mid; }
    return { break_even_slip: (lo + hi) / 2, break_even_note: null, base_slip: s0, slip_inert: false };
  }

  // ================================================================== studies (orchestration with an injected runner)
  /**
   * runner(params) -> { days: dayRecords[] } for ALL sessions of the run, in date order, synchronously.
   * The study only slices those records by date, so every window sees exactly the same simulation.
   * yieldFn() lets the caller breathe between runs (the worker posts progress and handles cancel there).
   */
  async function runOptimisation(spec, runner, hooks) {
    hooks = Object.assign({ progress: () => {}, cancelled: () => false, yieldFn: () => Promise.resolve(), now: () => Date.now() }, hooks || {});
    const t0 = hooks.now();
    const o = Object.assign({ objective: 'sharpe', minTrades: null, method: 'auto', budget: 200, seed: 1, split: { train: 0.6, validation: 0.2, test: 0.2 },
      wf: { mode: 'rolling' }, capital: 500000, mcPaths: 2000, topK: 10 }, spec.options || {});
    const base = spec.base, axes = spec.axes || [];
    if (!axes.length) throw new Error('Choose at least one parameter to search.');
    if (o.objective === 'custom' && !o.weights) o.weights = { sharpe: 1, net: 1, min_dd: 1 };
    const plan = planCandidates(base, axes, { method: o.method, budget: o.budget, seed: o.seed });
    const cache = new Map(), allKeys = Object.keys(base).concat(axes.map((a) => a.key));
    const evalOne = async (p) => {
      const k = keyOf(p, allKeys);
      if (!cache.has(k)) { if (hooks.cancelled()) throw new Error('cancelled'); cache.set(k, runner(p).days); await hooks.yieldFn(); }
      return cache.get(k);
    };
    const totalRuns = plan.candidates.length + axes.length * 4 + 12 * 2;
    let done = 0; const tick = (stage) => hooks.progress({ done: ++done, total: totalRuns, stage });
    const evals = [];
    for (const p of plan.candidates) { evals.push({ params: p, days: await evalOne(p) }); tick('search'); }
    const dates = evals[0].days.map((d) => d.date);
    const n = dates.length;
    const sp = splitChrono(n, o.split);
    const win = (e, w) => e.days.slice(w[0], w[1]);
    const minTrades = o.minTrades != null ? o.minTrades : Math.max(3, Math.round(0.1 * (sp.train[1] - sp.train[0])));
    const pTrain = evals.map((e) => perf(win(e, sp.train), o)), pVal = evals.map((e) => perf(win(e, sp.validation), o));
    const sTrain = scoreAll(pTrain, o.objective, minTrades, o.weights), sVal = scoreAll(pVal, o.objective, Math.max(1, Math.round(minTrades * (sp.validation[1] - sp.validation[0]) / Math.max(1, sp.train[1] - sp.train[0]))), o.weights);
    const order = evals.map((_, i) => i).sort((a, b) => sTrain[b] - sTrain[a]);
    const top = order.slice(0, o.topK);
    // selection: best VALIDATION score among the top-K by training score. The test window decides nothing.
    let sel = top.filter((i) => sTrain[i] > -Infinity).sort((a, b) => sVal[b] - sVal[a])[0];
    if (sel == null) sel = 0;
    const testOf = (i) => perf(win(evals[i], sp.test), o);
    const fullOf = (i) => perf(evals[i].days, o);
    const changed = (p) => axes.map((a) => a.key).filter((k) => p[k] !== base[k]).map((k) => ({ key: k, from: base[k], to: p[k] }));
    const row = (i, rank) => ({ idx: i, rank, params: evals[i].params, changed: changed(evals[i].params), score_train: sTrain[i], score_val: sVal[i],
      train: pTrain[i], validation: pVal[i], eligible: sTrain[i] > -Infinity });
    const origRank = order.indexOf(0) + 1;
    // walk-forward and overfitting diagnostics on the same evaluations
    const wf = walkForward(evals, dates, Object.assign({ objective: o.objective, minTrades: Math.max(2, Math.round(minTrades / 2)), capital: o.capital, weights: o.weights }, o.wf));
    const pb = pbo(evals, {});
    const srs = pTrain.map((p) => p.sr_period).filter((x) => x != null && isFinite(x));
    const selIS = perf(evals[sel].days.slice(0, sp.validation[1]), o);
    const isNets = evals[sel].days.slice(0, sp.validation[1]).filter(ELIGIBLE).map((d) => (d.traded ? d.net : 0));
    const mo = moments(isNets);
    const dsr = deflatedSharpe(selIS.sr_period, isNets.length, mo.skew, mo.kurt, evals.length, srs.length > 1 ? sdev(srs) ** 2 : 0);
    const rho = spearman(order.filter((i) => sTrain[i] > -Infinity && sVal[i] > -Infinity).map((i) => sTrain[i]), order.filter((i) => sTrain[i] > -Infinity && sVal[i] > -Infinity).map((i) => sVal[i]));
    // sensitivity: one axis at a time, one and two steps either side of the selected value, on train+validation
    const sens = [];
    const isWin = [0, sp.validation[1]];
    const selScoreIS = scoreAll([perf(win(evals[sel], isWin), o)], o.objective === 'custom' ? 'sharpe' : o.objective, 1)[0];
    for (const ax of axes) {
      const vals = axisValues(ax), at = vals.findIndex((v) => v === evals[sel].params[ax.key]);
      const rows = [];
      for (let d = -2; d <= 2; d++) {
        const j = at + d; if (at < 0 || j < 0 || j >= vals.length) continue;
        const p = Object.assign({}, evals[sel].params, { [ax.key]: vals[j] });
        const days = await evalOne(p); tick('sensitivity');
        const pp = perf(days.slice(isWin[0], isWin[1]), o);
        rows.push({ value: vals[j], step: d, p: pp, score: scoreAll([pp], o.objective === 'custom' ? 'sharpe' : o.objective, 1)[0] });
      }
      const nb = rows.filter((r) => r.step !== 0);
      const retain = selScoreIS > 0 && isFinite(selScoreIS) && nb.length ? mean(nb.map((r) => clamp((isFinite(r.score) ? r.score : 0) / selScoreIS, 0, 1))) : null;
      sens.push({ key: ax.key, label: ax.label, rows, retention: retain, positive_neighbours: nb.filter((r) => r.p.net > 0).length, neighbours: nb.length,
        cliff: nb.length ? minOf(nb.map((r) => r.p.net)) : null });
    }
    // cost stress on the user's settings and the selected settings
    const stress = {};
    for (const [name, i] of [['original', 0], ['selected', sel]]) {
      const p0 = evals[i].params, rowsS = [];
      for (const sc of costScenarios(p0)) { const days = await evalOne(Object.assign({}, p0, sc.over)); tick('cost stress'); rowsS.push({ key: sc.key, label: sc.label, p: perf(days, o) }); }
      stress[name] = Object.assign({ rows: rowsS }, await breakEvenSlip(p0, rowsS, evalOne, o, () => tick('cost stress')));
    }
    const mcSel = monteCarlo(evals[sel].days.filter((d) => d.traded).map((d) => d.net), { paths: o.mcPaths, capital: o.capital, seed: 7 });
    const mcOrig = monteCarlo(evals[0].days.filter((d) => d.traded).map((d) => d.net), { paths: o.mcPaths, capital: o.capital, seed: 7 });
    const dist = evals.map((e, i) => ({ net: fullOf(i).net, dd: fullOf(i).max_dd, train: pTrain[i].net }));
    return {
      version: VERSION, objective: o.objective, objective_label: OBJECTIVES[o.objective].label, weights: o.objective === 'custom' ? o.weights : null,
      method: plan.method, space_size: plan.space_size, configs_tested: evals.length, runs_total: cache.size, budget: o.budget, min_trades: minTrades,
      sessions: n, split: { train: [dates[sp.train[0]], dates[sp.train[1] - 1], sp.train[1] - sp.train[0]], validation: [dates[sp.validation[0]], dates[sp.validation[1] - 1], sp.validation[1] - sp.validation[0]],
        test: sp.test[1] > sp.test[0] ? [dates[sp.test[0]], dates[sp.test[1] - 1], sp.test[1] - sp.test[0]] : [null, null, 0] },
      selection_rule: `rank on the training window, then take the best validation score among the top ${o.topK}; the held-out test window is shown only for the selected and the original settings`,
      top: top.map((i, r) => row(i, r + 1)), selected: Object.assign(row(sel, order.indexOf(sel) + 1), { test: testOf(sel), full: fullOf(sel) }),
      original: Object.assign(row(0, origRank), { test: testOf(0), full: fullOf(0) }),
      distribution: dist, walk_forward: wf, pbo: pb, dsr, rank_corr_train_val: rho, sensitivity: sens, stress, monte_carlo: { selected: mcSel, original: mcOrig },
      selected_days: evals[sel].days, original_days: evals[0].days,
      ms: hooks.now() - t0,
    };
  }

  // ================================================================== rolling windows
  /**
   * The same rules over successive windows of history (the Lab's rolling-window mode). spec: { params, windows:
   * [{ from, to }], options: { capital } }. runner(params, from, to) returns a run in fromRun's shape for the stored
   * sessions in [from, to], or null when there are none. Every window is its own backtest: it starts flat, with the
   * full capital, so windows can be compared with each other but not added up.
   */
  async function runRolling(spec, runner, hooks) {
    hooks = Object.assign({ progress: () => {}, cancelled: () => false, yieldFn: () => Promise.resolve() }, hooks || {});
    const o = Object.assign({ capital: 500000 }, spec.options || {});
    const ws = spec.windows || [], rows = [];
    for (let i = 0; i < ws.length; i++) {
      if (hooks.cancelled()) throw new Error('cancelled');
      const w = ws[i];
      hooks.progress({ done: i, total: ws.length, stage: 'rolling', label: `${w.from} to ${w.to}` });
      const run = runner(spec.params, w.from, w.to);
      if (!run) { rows.push({ from: w.from, to: w.to, sessions: 0, traded: 0, net: null, win_rate: null, pf: null, max_dd: null, sharpe: null, best: null, worst: null }); continue; }
      const p = perf(run.days, o);
      // sessions = every stored day the window handed to the engine (as the Lab counts them), excluded ones included
      rows.push({ from: w.from, to: w.to, sessions: p.sessions + p.excluded, traded: p.traded, net: p.net, win_rate: p.win_rate, pf: p.pf, max_dd: p.max_dd, sharpe: p.sharpe, best: p.best, worst: p.worst });
      await hooks.yieldFn();
    }
    hooks.progress({ done: ws.length, total: ws.length, stage: 'rolling' });
    const nets = rows.filter((r) => r.net != null && r.traded > 0).map((r) => r.net);
    const sorted = nets.slice().sort((a, b) => a - b);
    const summary = {
      windows: rows.length, with_trades: nets.length, positive: nets.filter((x) => x > 0).length,
      median: sorted.length ? quantile(sorted, 0.5) : null, mean: nets.length ? mean(nets) : null, sd: nets.length > 1 ? sdev(nets) : null,
      best: nets.length ? maxOf(nets) : null, worst: nets.length ? minOf(nets) : null,
    };
    return { rows, summary };
  }

  /** Robustness check of ONE configuration (no search): consistency across chronological thirds,
   *  one-step sensitivity on the given axes, cost stress and Monte Carlo. */
  async function runCheck(spec, runner, hooks) {
    hooks = Object.assign({ progress: () => {}, cancelled: () => false, yieldFn: () => Promise.resolve(), now: () => Date.now() }, hooks || {});
    const t0 = hooks.now();
    const o = Object.assign({ capital: 500000, mcPaths: 2000, objective: 'sharpe' }, spec.options || {});
    const base = spec.base, axes = spec.axes || [];
    const allKeys = Object.keys(base).concat(axes.map((a) => a.key));
    const cache = new Map();
    let done = 0; const total = 1 + axes.length * 2 + 8;
    const evalOne = async (p) => { const k = keyOf(p, allKeys); if (!cache.has(k)) { if (hooks.cancelled()) throw new Error('cancelled'); cache.set(k, runner(p).days); await hooks.yieldFn(); hooks.progress({ done: ++done, total, stage: 'check' }); } return cache.get(k); };
    const days = spec.days || await evalOne(base);
    const n = days.length;
    const thirds = [0, 1, 2].map((k) => { const a = Math.floor(k * n / 3), b = Math.floor((k + 1) * n / 3); return perf(days.slice(a, b), o); });
    const whole = perf(days, o);
    const sens = [];
    for (const ax of axes) {
      const vals = axisValues(ax), at = vals.findIndex((v) => v === base[ax.key]);
      const rows = [];
      for (const d of [-1, 1]) {
        const j = at + d; if (at < 0 || j < 0 || j >= vals.length) continue;
        const pp = perf(await evalOne(Object.assign({}, base, { [ax.key]: vals[j] })), o);
        rows.push({ value: vals[j], step: d, p: pp });
      }
      const s0 = whole.sharpe;
      const retain = s0 != null && s0 > 0 && rows.length ? mean(rows.map((r) => clamp((r.p.sharpe || 0) / s0, 0, 1))) : null;
      sens.push({ key: ax.key, label: ax.label, base_value: base[ax.key], rows, retention: retain, positive_neighbours: rows.filter((r) => r.p.net > 0).length, neighbours: rows.length });
    }
    const rowsS = [];
    for (const sc of costScenarios(base)) rowsS.push({ key: sc.key, label: sc.label, p: perf(sc.key === 'base' ? days : await evalOne(Object.assign({}, base, sc.over)), o) });
    const stressOut = Object.assign({ rows: rowsS }, await breakEvenSlip(base, rowsS, evalOne, o, () => {}));
    const mc = monteCarlo(days.filter((d) => d.traded).map((d) => d.net), { paths: o.mcPaths, capital: o.capital });
    return { version: VERSION, whole, thirds, sensitivity: sens, stress: stressOut, monte_carlo: mc, runs: cache.size, ms: hooks.now() - t0 };
  }

  // ================================================================== diagnostics
  function diagnostics(days, ctx) {
    ctx = ctx || {};
    const p = perf(days, ctx);
    const tr = days.filter((d) => ELIGIBLE(d) && d.traded).sort((a, b) => b.net - a.net);
    const out = { overfitting: [], concentration: [], fragility: [] };
    const add = (group, id, label, value, status, text) => out[group].push({ id, label, value, status, text });
    // ---- concentration
    if (p.traded >= 2 && p.net > 0) {
      const top1 = tr[0].net, top3 = sum(tr.slice(0, 3).map((d) => d.net));
      add('concentration', 'best_day_share', 'Share of net profit from the best day', 100 * top1 / p.net, top1 / p.net > 0.5 ? 'warn' : top1 / p.net > 0.25 ? 'watch' : 'ok',
        `Without its best day the run would have made ${fmtInr(p.net - top1, true)}.`);
      add('concentration', 'top3_share', 'Share of net profit from the best 3 days', 100 * top3 / p.net, top3 / p.net > 1 ? 'warn' : top3 / p.net > 0.6 ? 'watch' : 'ok',
        `Without its best 3 days the run would have made ${fmtInr(p.net - top3, true)}.`);
    } else if (p.traded >= 2) add('concentration', 'best_day_share', 'Share of net profit from the best day', null, 'n/a', 'Not meaningful: the run did not make money overall.');
    const months = {}; for (const d of tr) months[d.date.slice(0, 7)] = (months[d.date.slice(0, 7)] || 0) + d.net;
    const mk = Object.keys(months);
    if (mk.length >= 3 && p.net > 0) {
      const bestM = mk.sort((a, b) => months[b] - months[a])[0];
      add('concentration', 'best_month_share', 'Share of net profit from the best month', 100 * months[bestM] / p.net, months[bestM] / p.net > 0.6 ? 'warn' : months[bestM] / p.net > 0.35 ? 'watch' : 'ok', `${bestM} contributed ${fmtInr(months[bestM], true)}.`);
    } else add('concentration', 'best_month_share', 'Share of net profit from the best month', null, 'n/a',
      mk.length < 3 ? `Needs at least 3 months with trades; this run has ${mk.length}.` : 'Not meaningful: the run did not make money overall.');
    const ex = Object.entries(p.exits).sort((a, b) => b[1].net - a[1].net);
    if (ex.length && p.net > 0 && ex[0][1].net > 0) add('concentration', 'exit_dependency', `Share of net profit from "${ex[0][0]}" exits`, 100 * ex[0][1].net / p.net, ex[0][1].net / p.net > 1.5 ? 'watch' : 'ok',
      `The other exit types net ${fmtInr(p.net - ex[0][1].net, true)} together.`);
    if (ctx.regimes) {
      const vol = ctx.regimes.dims.find((d) => d.key === 'vol');
      if (vol && p.net > 0) {
        const r = vol.rows.filter((x) => x.p.net > 0).sort((a, b) => b.p.net - a.p.net)[0];
        if (r) add('concentration', 'regime_dependency', `Share of net profit from ${r.label.toLowerCase()}-volatility sessions`, 100 * r.p.net / p.net, r.p.net / p.net > 1.2 ? 'warn' : r.p.net / p.net > 0.8 ? 'watch' : 'ok',
          `${r.p.traded} traded day${r.p.traded === 1 ? '' : 's'} in that regime made ${fmtInr(r.p.net, true)}; the rest made ${fmtInr(p.net - r.p.net, true)}.`);
      }
    }
    // ---- fragility
    if (p.costs_pct_gross_profit != null) add('fragility', 'costs_share', 'Charges as a share of gross profit', p.costs_pct_gross_profit, p.costs_pct_gross_profit > 50 ? 'warn' : p.costs_pct_gross_profit > 25 ? 'watch' : 'ok',
      `Charges totalled ${fmtInr(p.costs)} against gross winning days.`);
    if (p.payoff != null && p.win_rate != null) {
      const need = 100 / (1 + p.payoff);
      add('fragility', 'payoff', 'Average win ÷ average loss', p.payoff, p.win_rate < need + 5 ? 'warn' : p.payoff < 0.5 ? 'watch' : 'ok',
        `At this payoff a win rate above ${need.toFixed(1)}% breaks even; the run won ${p.win_rate.toFixed(1)}%.`);
    }
    if (p.worst != null && p.mean != null && p.avg_win) add('fragility', 'tail', 'Worst day ÷ average winning day', Math.abs(p.worst) / p.avg_win, Math.abs(p.worst) / p.avg_win > 6 ? 'warn' : Math.abs(p.worst) / p.avg_win > 3 ? 'watch' : 'ok',
      `The worst day lost ${fmtInr(Math.abs(p.worst))}; it takes ${(Math.abs(p.worst) / p.avg_win).toFixed(1)} average winning days to earn that back.`);
    const ck = ctx.check || ctx.study;
    const stress = ctx.check ? ctx.check.stress : ctx.study ? ctx.study.stress.selected : null;
    if (stress) {
      if (stress.break_even_slip != null) add('fragility', 'break_even_slip', 'Slippage at which the run stops making money', stress.break_even_slip, stress.break_even_slip - stress.base_slip < 0.5 ? 'warn' : stress.break_even_slip - stress.base_slip < 1 ? 'watch' : 'ok',
        `Run at ${stress.base_slip}% per fill; at about ${stress.break_even_slip.toFixed(2)}% it breaks even.`);
      else add('fragility', 'break_even_slip', 'Slippage at which the run stops making money', null, stress.slip_inert ? 'n/a' : stress.break_even_note && stress.break_even_note.startsWith('already') ? 'warn' : 'ok', stress.break_even_note || '');
    }
    const sens = ctx.check ? ctx.check.sensitivity : ctx.study ? ctx.study.sensitivity : null;
    if (sens && sens.length) {
      const judged = sens.filter((s) => s.retention != null);
      if (judged.length) {
        const worst = judged.slice().sort((a, b) => a.retention - b.retention)[0];
        add('fragility', 'unstable_param', `Most sensitive setting: ${worst.label}`, 100 * worst.retention, worst.retention < 0.4 ? 'warn' : worst.retention < 0.7 ? 'watch' : 'ok',
          `One step either side keeps ${(100 * worst.retention).toFixed(0)}% of the risk-adjusted score; ${worst.positive_neighbours} of ${worst.neighbours} neighbouring settings still made money.`);
      }
    }
    // ---- overfitting (needs an optimisation study)
    const st = ctx.study;
    if (st) {
      add('overfitting', 'configs', 'Configurations tried', st.configs_tested, st.configs_tested > 100 && st.sessions < 250 ? 'watch' : 'ok', `${st.configs_tested} configurations on ${st.sessions} sessions. Each extra configuration raises the best in-sample result by luck alone.`);
      const tr_ = st.selected.train, te = st.selected.test;
      if (te && te.traded >= 1 && tr_.per_session != null) add('overfitting', 'is_oos', 'Held-out test vs training, per session', te.per_session, te.per_session < 0 && tr_.per_session > 0 ? 'warn' : te.per_session < 0.5 * tr_.per_session ? 'watch' : 'ok',
        `${fmtInr(tr_.per_session, true)} per session in training, ${fmtInr(te.per_session, true)} in the held-out test (${te.sessions} sessions).`);
      if (st.walk_forward.wfe != null) add('overfitting', 'wfe', 'Walk-forward efficiency', st.walk_forward.wfe, st.walk_forward.wfe < 0.3 ? 'warn' : st.walk_forward.wfe < 0.6 ? 'watch' : 'ok',
        'Out-of-sample profit per session as a share of in-sample profit per session, across the walk-forward folds.');
      if (st.pbo.status === 'ok') add('overfitting', 'pbo', 'Probability of backtest overfitting', 100 * st.pbo.pbo, st.pbo.pbo > 0.5 ? 'warn' : st.pbo.pbo > 0.25 ? 'watch' : 'ok',
        `In ${st.pbo.combinations} splits of the sessions, the best in-sample configuration landed in the bottom half out of sample ${(100 * st.pbo.pbo).toFixed(0)}% of the time.`);
      else add('overfitting', 'pbo', 'Probability of backtest overfitting', null, 'n/a', st.pbo.reason);
      if (st.dsr) add('overfitting', 'dsr', 'Deflated Sharpe ratio', 100 * st.dsr.dsr, st.dsr.dsr < 0.5 ? 'warn' : st.dsr.dsr < 0.9 ? 'watch' : 'ok',
        `Probability that the selected Sharpe ratio beats what the best of ${st.configs_tested} random configurations would show by luck.`);
      if (st.rank_corr_train_val != null) add('overfitting', 'rank_corr', 'Training vs validation rank agreement', st.rank_corr_train_val, st.rank_corr_train_val < 0 ? 'warn' : st.rank_corr_train_val < 0.3 ? 'watch' : 'ok',
        'Spearman correlation of configuration scores between the training and validation windows. Near zero means the ranking is mostly noise.');
    } else add('overfitting', 'study', 'Overfitting checks', null, 'n/a', 'Run the optimisation lab to measure overfitting: it needs several configurations evaluated on separate windows.');
    return out;
  }

  // ================================================================== robustness score
  const WEIGHTS = { oos: 2, trades: 1.5, pf: 1, drawdown: 1, stability: 1.5, regimes: 1, monte_carlo: 1, costs: 1.5, data: 1, uncertainty: 1.5 };

  /**
   * A transparent score: ten components, each 0-100 with the formula printed next to it, combined by the
   * weights above over the components that could be computed. Separately graded: statistical confidence,
   * backtest robustness, data quality and model uncertainty. Small samples are capped and labelled.
   */
  function robustness(input) {
    const p = input.perf, c = [];
    const comp = (key, label, group, score, value, formula, note) => c.push({ key, label, group, weight: WEIGHTS[key], score: score == null ? null : clamp(Math.round(score), 0, 100), value, formula, note: note || null });
    const n = p.traded;
    const st = input.study, ck = input.check;
    // 1 out-of-sample
    if (st && st.walk_forward.status !== 'not_run' && st.walk_forward.oos.traded >= 2) {
      const o = st.walk_forward.oos, t = o.t;
      comp('oos', 'Out-of-sample result (walk-forward)', 'robustness', t == null ? (o.net > 0 ? 50 : 0) : 100 * normCdf(t), o.net, '100 × Φ(t) of the stitched out-of-sample traded days', `${o.traded} out-of-sample traded days`);
    } else if (ck && ck.thirds.every((x) => x.traded >= 2)) {
      const pos = ck.thirds.filter((x) => x.net > 0).length;
      comp('oos', 'Consistency across periods (thirds)', 'robustness', 100 * pos / 3, pos, 'share of the three chronological thirds that made money', 'not a true out-of-sample test: the settings may have been tuned on these same days');
    } else comp('oos', 'Out-of-sample result', 'robustness', null, null, 'needs a walk-forward study or at least 2 trades in each third', 'not computable');
    // 2 trade count
    comp('trades', 'Number of traded days', 'statistical', n > 0 ? 100 * Math.log(n) / Math.log(250) : 0, n, '100 × ln(n) / ln(250), so 250 independent days score 100', p.sample.label);
    // 3 profit factor
    comp('pf', 'Profit factor', 'robustness', p.pf == null ? (p.pf_note === 'no losing day' ? (n >= 10 ? 100 : null) : 0) : 100 * clamp((p.pf - 1) / 0.8, 0, 1), p.pf, '0 at 1.0 or below, 100 at 1.8 or above', p.pf_note);
    // 4 drawdown
    comp('drawdown', 'Maximum drawdown', 'robustness', 100 * clamp(1 - (Math.abs(p.max_dd_pct) - 5) / 25, 0, 1), p.max_dd_pct, '100 at ≤ 5% of capital, 0 at ≥ 30%');
    // 5 parameter stability
    const sens = st ? st.sensitivity : ck ? ck.sensitivity : null;
    const ret = sens ? sens.filter((s) => s.retention != null).map((s) => s.retention) : [];
    comp('stability', 'Parameter stability', 'robustness', ret.length ? 100 * mean(ret) : null, ret.length ? mean(ret) : null, 'mean share of the risk-adjusted score kept one step either side of each setting',
      ret.length ? null : sens ? 'the settings did not make money, so there is nothing to keep' : 'run a robustness check or the optimisation lab');
    // 6 regime consistency
    const rg = input.regimes ? input.regimes.dims.filter((d) => ['vol', 'trend'].includes(d.key) && d.consistency) : [];
    comp('regimes', 'Regime consistency', 'robustness', rg.length ? 100 * mean(rg.map((d) => d.consistency.share)) : null, rg.length ? mean(rg.map((d) => d.consistency.share)) : null,
      `share of volatility and trend regimes with ≥ ${input.regimes ? input.regimes.min_traded : 5} traded days whose average day was positive`, rg.length ? null : 'fewer than two regimes have enough traded days');
    // 7 Monte Carlo
    const mc = st ? st.monte_carlo.selected : ck ? ck.monte_carlo : input.mc;
    comp('monte_carlo', 'Monte Carlo: chance of a loss', 'robustness', mc && mc.status === 'ok' ? 100 * (1 - mc.p_loss) : null, mc && mc.status === 'ok' ? mc.p_loss : null, '100 × (1 − share of resampled paths ending below zero)', mc && mc.status !== 'ok' ? mc.reason : null);
    // 8 cost sensitivity
    const stress = st ? st.stress.selected : ck ? ck.stress : null;
    let cs = null, cv = null, cn = null;
    if (stress) {
      if (stress.break_even_slip != null) { cv = stress.break_even_slip - stress.base_slip; cs = 100 * clamp(cv / 1.5, 0, 1); }
      else if (stress.slip_inert) cn = 'not measurable on this data: fills use quoted bid/ask, so slippage has no effect';
      else if (stress.break_even_note && stress.break_even_note.startsWith('still')) { cs = 100; cn = stress.break_even_note; }
      else { cs = 0; cn = stress.break_even_note; }
    } else cn = 'run a robustness check or the optimisation lab';
    comp('costs', 'Room for worse fills', 'robustness', cs, cv, '100 when it survives 1.5 extra points of slippage per fill, 0 when it already loses', cn);
    // 9 data completeness
    const dq = input.data || {};
    const totalDays = (dq.sessions || p.sessions) + (dq.excluded || p.excluded || 0);
    let dscore = totalDays ? 100 * (dq.sessions || p.sessions) / totalDays : null;
    const dnotes = [];
    if (dq.partial) { dscore -= 50 * dq.partial / Math.max(1, totalDays); dnotes.push(`${dq.partial} partial day${dq.partial === 1 ? '' : 's'}`); }
    if (dq.synthetic) { dscore = Math.min(dscore, 40); dnotes.push('synthetic model, not market data'); }
    if (dq.assumed_lot) { dscore -= 5; dnotes.push('lot size assumed'); }
    if (dq.assumed_expiry) { dscore -= 5; dnotes.push('expiry dates assumed'); }
    comp('data', 'Data completeness', 'data', dscore, totalDays ? (dq.sessions || p.sessions) / totalDays : null, 'share of requested sessions usable, minus penalties for partial days and assumed lot sizes/expiries; synthetic data is capped at 40', dnotes.join(', ') || null);
    // 10 statistical uncertainty
    comp('uncertainty', 'Statistical uncertainty of the average day', 'statistical', p.t == null ? (n >= 2 ? 0 : null) : 100 * clamp(p.t / 3, 0, 1), p.t, '100 × t / 3, where t = mean ÷ standard error of traded-day P&L; t ≤ 0 scores 0',
      p.ci ? `95% interval ${fmtInr(p.ci[0], true)} to ${fmtInr(p.ci[1], true)}` : 'one traded day has no interval');
    // combine
    const have = c.filter((x) => x.score != null);
    const wHave = sum(have.map((x) => x.weight)), wAll = sum(c.map((x) => x.weight));
    const raw = wHave ? sum(have.map((x) => x.score * x.weight)) / wHave : null;
    const coverage = wHave / wAll;
    const cap = n < 30 ? 30 : n < 100 ? 70 : 100;
    const score = raw == null ? null : Math.min(raw, cap);
    let verdict;
    if (n < 30 || coverage < 0.6) verdict = { key: 'inconclusive', label: 'Inconclusive', why: n < 30 ? `${n} traded day${n === 1 ? '' : 's'} is too few for any robustness claim (needs at least 30, and ideally 250+).` : 'Too few components could be computed. Run a robustness check or the optimisation lab.' };
    else if (score >= 70) verdict = { key: 'robust', label: 'Holds up', why: 'Most components are strong and the sample is large enough to read.' };
    else if (score >= 50) verdict = { key: 'mixed', label: 'Mixed', why: 'Some components are weak. Read them before trusting the headline.' };
    else verdict = { key: 'fragile', label: 'Fragile', why: 'Several components are weak.' };
    // separate assessments
    const statistical = (() => {
      const t = p.t, cls = p.sample;
      if (n < 10) return { grade: 'Inconclusive', why: `${n} traded day${n === 1 ? '' : 's'}: no interval or test means anything yet.` };
      if (t == null) return { grade: 'Inconclusive', why: 'No variation in daily results.' };
      const dsr = st && st.dsr ? st.dsr.dsr : null;
      if (p.ci && p.ci[0] > 0 && (dsr == null || dsr > 0.9) && n >= 30) return { grade: 'Strong', why: `The 95% interval of the average day is above zero (t = ${fmtT(t)}, ${cls.label.toLowerCase()} sample)${dsr != null ? ` and survives the deflation for ${st.configs_tested} configurations` : ''}.` };
      if (p.ci && p.ci[1] < 0) return { grade: 'Strong (negative)', why: `The 95% interval is below zero (t = ${fmtT(t)}): the loss is unlikely to be bad luck.` };
      if (t > 1) return { grade: 'Weak', why: `t = ${fmtT(t)}: positive, but the interval still includes zero.` };
      return { grade: 'None', why: `t = ${fmtT(t)}: the average day cannot be told apart from zero.` };
    })();
    const robustGroup = c.filter((x) => x.group === 'robustness' && x.score != null);
    const robustAvg = robustGroup.length ? sum(robustGroup.map((x) => x.score * x.weight)) / sum(robustGroup.map((x) => x.weight)) : null;
    const backtest = { grade: robustAvg == null ? 'Not measured' : n < 30 ? 'Inconclusive' : robustAvg >= 70 ? 'Holds up' : robustAvg >= 50 ? 'Mixed' : 'Fragile', score: robustAvg == null ? null : Math.round(robustAvg),
      why: robustAvg == null ? 'Run a robustness check or the optimisation lab.' : `${robustGroup.length} robustness components measured.` };
    const dataQ = { grade: dq.synthetic ? 'Synthetic' : dscore >= 95 ? 'Complete' : dscore >= 80 ? 'Mostly complete' : 'Gaps', score: dscore == null ? null : Math.round(clamp(dscore, 0, 100)), why: dnotes.join('; ') || 'All requested sessions were usable.' };
    const model = { grade: dq.synthetic ? 'High' : 'Medium', items: (dq.synthetic ? ['Synthetic price model: says how the rule reacts, nothing about NIFTY.'] : []).concat([
      'Fills come from 1-minute candles plus a slippage setting; there is no bid/ask history, so real fills would likely be worse.',
      'Margin is estimated by a percentage model, not historical SPAN or broker data.',
      'Statutory rates before Oct 2024 are recalled, not verified.',
    ]).concat(dq.assumed_expiry ? ['Expiry dates are assumed by weekday rule until checked against the bhavcopy.'] : []) };
    return { version: VERSION, components: c, weights: WEIGHTS, raw: raw == null ? null : Math.round(raw), cap, score: score == null ? null : Math.round(score), coverage, verdict,
      formula: `score = Σ(weight × component) ÷ Σ(weight) over the ${have.length} of ${c.length} components that could be computed; capped at ${cap} because the run has ${n} traded day${n === 1 ? '' : 's'} (caps: 30 below 30 days, 70 below 100).`,
      statistical, backtest, data_quality: dataQ, model_uncertainty: model };
  }

  // ================================================================== research assistant (template-driven, grounded)
  const INR = typeof Intl !== 'undefined' ? new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }) : null;
  function fmtInr(x, sign) {
    if (x == null || !isFinite(x)) return '—';
    const s = INR ? INR.format(Math.round(Math.abs(x))) : String(Math.round(Math.abs(x)));
    return (x < 0 ? '−' : sign && x > 0 ? '+' : '') + '₹' + s;
  }
  function fmtT(t) { return t == null || !isFinite(t) ? '—' : `${t < 0 ? '−' : ''}${Math.abs(t).toFixed(2)}`; }
  /** "low sessions", but "other days" rather than "other days sessions". */
  function sessionsOf(label) { const l = String(label).toLowerCase(); return /days$/.test(l) ? l : `${l} sessions`; }
  const fmtPct = (x, d) => (x == null || !isFinite(x) ? '—' : `${x < 0 ? '−' : ''}${Math.abs(x).toFixed(d == null ? 1 : d)}%`);
  const EXIT_WORDS = { target: 'the profit target', eod: 'the end-of-day exit', time_exit: 'the end-of-day exit', structural: 'the reversal level', scheduled: 'a scheduled exit',
    max_loss: 'the loss cap', stop: 'stops', loss_limit: 'the loss limit', expiry: 'expiry', unknown: 'an unrecorded reason' };
  const exitWords = (k) => EXIT_WORDS[k] || String(k).replace(/_/g, ' ');
  const fmtNum = (x, d) => (x == null || !isFinite(x) ? '—' : x.toFixed(d == null ? 2 : d));
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

  /**
   * Builds the written reading of a run from computed facts only. Every number in the text is a fact
   * (id, label, display text) that the page lists under "Sources", and every sentence names its facts.
   * Nothing is generated by a language model; the cost is zero and the output is deterministic.
   */
  function explain(b) {
    const facts = new Map(), sections = [];
    const F = (id, label, value, text) => { facts.set(id, { id, label, value, text }); return text; };
    const S = (title) => { const s = { title, sentences: [] }; sections.push(s); return s; };
    const say = (s, text, refs) => s.sentences.push({ text, refs });
    const p = b.perf, unit = 'traded day';
    const meta = b.meta || {};

    const s0 = S('How the strategy works');
    if (meta.oneLine) say(s0, meta.oneLine, []);
    if (meta.changed && meta.changed.length) say(s0, `This run changed ${plural(meta.changed.length, 'setting')} from the defaults: ${meta.changed.join('; ')}.`, []);

    const s1 = S('What happened');
    const range = `${p.from} to ${p.to}`;
    say(s1, `From ${F('from', 'First session', p.from, p.from)} to ${F('to', 'Last session', p.to, p.to)} the strategy traded on ${F('traded', 'Traded days', p.traded, String(p.traded))} of ${F('sessions', 'Sessions', p.sessions, String(p.sessions))} sessions and finished at ${F('net', 'Net P&L after charges', p.net, fmtInr(p.net, true))} after charges.`, ['from', 'to', 'traded', 'sessions', 'net']);
    if (p.traded) {
      say(s1, `It won on ${F('win_rate', 'Win rate', p.win_rate, fmtPct(p.win_rate))} of traded days; the average ${unit} was ${F('mean', 'Average traded day', p.mean, fmtInr(p.mean, true))}.`, ['win_rate', 'mean']);
      if (p.ci) say(s1, `The 95% interval for the average ${unit} runs from ${F('ci_lo', 'Average day, 95% low', p.ci[0], fmtInr(p.ci[0], true))} to ${F('ci_hi', 'Average day, 95% high', p.ci[1], fmtInr(p.ci[1], true))}${p.ci[0] <= 0 && p.ci[1] >= 0 ? ', which includes zero: this sample cannot tell profit from luck' : p.ci[0] > 0 ? ', entirely above zero' : ', entirely below zero'}.`, ['ci_lo', 'ci_hi']);
      else say(s1, 'With one traded day there is no interval at all.', ['traded']);
    }

    const s2 = S('What worked');
    const s3 = S('What hurt');
    const exits = Object.entries(p.exits || {}).sort((a, b2) => b2[1].net - a[1].net);
    if (exits.length) {
      const [k, e] = exits[0];
      if (e.net > 0) say(s2, `Days that ended at ${exitWords(k)} made ${F('exit_best_net', `Net of days ending at ${exitWords(k)}`, e.net, fmtInr(e.net, true))} across ${F('exit_best_n', `Days ending at ${exitWords(k)}`, e.n, String(e.n))} day${e.n === 1 ? '' : 's'}.`, ['exit_best_net', 'exit_best_n']);
      const [k2, e2] = exits[exits.length - 1];
      if (e2.net < 0) say(s3, `Days that ended at ${exitWords(k2)} lost ${F('exit_worst_net', `Loss on days ending at ${exitWords(k2)}`, -e2.net, fmtInr(-e2.net))} across ${F('exit_worst_n', `Days ending at ${exitWords(k2)}`, e2.n, String(e2.n))} day${e2.n === 1 ? '' : 's'}.`, ['exit_worst_net', 'exit_worst_n']);
    }
    if (b.regimes) {
      const anyPost = b.regimes.dims.some((d) => ['vol', 'trend'].includes(d.key));
      if (anyPost) say(s2, 'Regime readings below marked "as it turned out" describe the whole session after the fact; they are not known when the trade is opened.', []);
      for (const key of ['vol', 'trend', 'gap', 'expiry']) {
        const d = b.regimes.dims.find((x) => x.key === key); if (!d) continue;
        const rows = d.rows.filter((r) => r.p.traded > 0 && !['Unknown', 'Warm-up'].includes(r.label));
        if (!rows.length) continue;
        const best = rows.slice().sort((a, c) => c.p.mean - a.p.mean)[0], worst = rows.slice().sort((a, c) => a.p.mean - c.p.mean)[0];
        const thin = (r) => (r.p.traded < b.regimes.min_traded ? ` (only ${F(`rg_${key}_${r.label}_n`, `${d.label}: ${r.label} traded days`, r.p.traded, String(r.p.traded))} traded day${r.p.traded === 1 ? '' : 's'}, too few to rely on)` : ` (${F(`rg_${key}_${r.label}_n`, `${d.label}: ${r.label} traded days`, r.p.traded, String(r.p.traded))} traded days)`);
        if (best.p.mean > 0) say(s2, `${d.label}${d.timing === 'ex-post' ? ', as it turned out' : ', known at entry'}: ${sessionsOf(best.label)} averaged ${F(`rg_${key}_${best.label}_mean`, `${d.label}: ${best.label} average day`, best.p.mean, fmtInr(best.p.mean, true))}${thin(best)}.`,
          [`rg_${key}_${best.label}_mean`, `rg_${key}_${best.label}_n`]);
        if (worst !== best && worst.p.mean < 0) say(s3, `${d.label}${d.timing === 'ex-post' ? ', as it turned out' : ', known at entry'}: ${sessionsOf(worst.label)} averaged ${F(`rg_${key}_${worst.label}_mean`, `${d.label}: ${worst.label} average day`, worst.p.mean, fmtInr(worst.p.mean, true))}${thin(worst)}.`,
          [`rg_${key}_${worst.label}_mean`, `rg_${key}_${worst.label}_n`]);
      }
    }
    if (p.traded) {
      if (p.worst < 0) say(s3, `The worst single day lost ${F('worst', 'Worst traded day, loss', -p.worst, fmtInr(-p.worst))}.`, ['worst']);
      if (p.max_dd < 0) say(s3, `The deepest drawdown was ${F('max_dd', 'Maximum drawdown', p.max_dd, fmtInr(p.max_dd, true))} (${F('max_dd_pct', 'Maximum drawdown, % of capital', p.max_dd_pct, fmtPct(Math.abs(p.max_dd_pct), 2))} of capital), from ${F('dd_from', 'Drawdown started', p.dd_from, p.dd_from)} to ${F('dd_to', 'Drawdown low', p.dd_to, p.dd_to)}.`, ['max_dd', 'max_dd_pct', 'dd_from', 'dd_to']);
      say(s3, `Charges came to ${F('costs', 'Charges', p.costs, fmtInr(p.costs))}${p.costs_pct_gross_profit != null ? `, ${F('costs_share', 'Charges as % of gross profit', p.costs_pct_gross_profit, fmtPct(p.costs_pct_gross_profit))} of gross profit` : ''}.`, ['costs'].concat(p.costs_pct_gross_profit != null ? ['costs_share'] : []));
    }
    if (!s2.sentences.length) say(s2, 'Nothing in this run made money in a way the numbers can isolate.', []);

    const s4 = S('How capital was used');
    if (p.peak_margin) {
      say(s4, `Estimated margin peaked at ${F('peak_margin', 'Peak margin (est.)', p.peak_margin, fmtInr(p.peak_margin))}; the net return on that peak was ${F('rom', 'Return on peak margin (est.)', p.rom, fmtPct(p.rom, 2))}.`, ['peak_margin', 'rom']);
      if (p.util_avg != null) say(s4, `On traded days the account used ${F('util_avg', 'Average peak utilisation on traded days', p.util_avg, fmtPct(p.util_avg))} of its capital at the busiest moment on average, and ${F('util_peak', 'Highest utilisation', p.util_peak, fmtPct(p.util_peak))} at most.`, ['util_avg', 'util_peak']);
    }
    if (p.idle_pct != null) say(s4, `Capital sat idle on ${F('idle_pct', 'Sessions without a trade', p.idle_pct, fmtPct(p.idle_pct))} of sessions.`, ['idle_pct']);

    const s5 = S('How reliable is it');
    say(s5, `Sample: ${F('sample', 'Sample size class', p.sample.label, p.sample.label.toLowerCase())} (${F('traded', 'Traded days', p.traded, String(p.traded))} traded days).${p.sample.min_next ? ` Readings start to mean something at ${p.sample.min_next}.` : ''}`, ['sample', 'traded']);
    if (b.robust) {
      const r = b.robust;
      say(s5, `Robustness: ${F('verdict', 'Robustness verdict', r.verdict.label, r.verdict.label.toLowerCase())}${r.score != null ? `, score ${F('score', 'Robustness score', r.score, String(r.score))} of 100` : ''}. ${r.verdict.why}`, ['verdict'].concat(r.score != null ? ['score'] : []));
      say(s5, `Statistical confidence: ${F('stat_grade', 'Statistical confidence', r.statistical.grade, r.statistical.grade.toLowerCase())}. ${r.statistical.why}`, ['stat_grade']);
      say(s5, `Data: ${F('data_grade', 'Data quality', r.data_quality.grade, r.data_quality.grade.toLowerCase())}. Model uncertainty: ${F('model_grade', 'Model uncertainty', r.model_uncertainty.grade, r.model_uncertainty.grade.toLowerCase())}.`, ['data_grade', 'model_grade']);
    }
    if (b.data && b.data.note) say(s5, b.data.note, []);

    const st = b.study;
    if (st) {
      const s6 = S('What the optimisation means');
      say(s6, `${F('configs', 'Configurations tested', st.configs_tested, String(st.configs_tested))} configurations were tested by ${st.method} search on ${F('opt_sessions', 'Sessions in the study', st.sessions, String(st.sessions))} sessions, ranked by ${st.objective_label}.`, ['configs', 'opt_sessions']);
      const sel = st.selected, org = st.original;
      say(s6, `The selected settings made ${F('sel_val', 'Selected: validation net', sel.validation.net, fmtInr(sel.validation.net, true))} in validation and ${F('sel_test', 'Selected: held-out test net', sel.test.net, fmtInr(sel.test.net, true))} in the held-out test; your settings made ${F('org_test', 'Original: held-out test net', org.test.net, fmtInr(org.test.net, true))} in the same test window.`, ['sel_val', 'sel_test', 'org_test']);
      if (st.walk_forward.status !== 'not_run') say(s6, `Walk-forward, re-choosing settings on each training window: ${F('wf_oos', 'Walk-forward out-of-sample net', st.walk_forward.oos.net, fmtInr(st.walk_forward.oos.net, true))} out of sample, against ${F('wf_orig', 'Original settings on the same days', st.walk_forward.original_oos.net, fmtInr(st.walk_forward.original_oos.net, true))} for your settings on the same days.`, ['wf_oos', 'wf_orig']);
      else say(s6, `Walk-forward could not run: ${st.walk_forward.reason}.`, []);
      if (st.pbo.status === 'ok') say(s6, `Probability of backtest overfitting: ${F('pbo', 'PBO', st.pbo.pbo, fmtPct(100 * st.pbo.pbo, 0))}. Above 50% means the in-sample winner usually does worse than the median configuration on unseen data.`, ['pbo']);
      say(s6, 'Nothing has been applied to your settings. Load the selected configuration only if you accept these numbers.', []);
    }

    const s7 = S('What to test next');
    const next = [];
    if (p.traded < 30) next.push([`Extend the date range: ${F('traded', 'Traded days', p.traded, String(p.traded))} traded days is too few for any conclusion.`, ['traded']]);
    if (b.regimes) {
      const ex = b.regimes.dims.find((d) => d.key === 'expiry');
      const e = ex && ex.rows.find((r) => r.label === 'Expiry day');
      if (e && e.p.traded >= 3 && e.p.mean < 0) next.push([`Test "Skip expiry day": expiry days averaged ${F('rg_expiry_mean', 'Expiry days: average', e.p.mean, fmtInr(e.p.mean, true))}.`, ['rg_expiry_mean']]);
      const vp = b.regimes.dims.find((d) => d.key === 'vol_prev');
      const hot = vp && vp.rows.filter((r) => ['Elevated', 'Extreme'].includes(r.label) && r.p.traded >= 3 && r.p.mean < 0)[0];
      if (hot) next.push([`Test a volatility filter: sessions after ${/^[aeiou]/i.test(hot.label) ? 'an' : 'a'} ${hot.label.toLowerCase()}-volatility day averaged ${F('rg_vp_mean', 'After high-vol days: average', hot.p.mean, fmtInr(hot.p.mean, true))}, and that is known before entry.`, ['rg_vp_mean']]);
    }
    if (p.costs_pct_gross_profit != null && p.costs_pct_gross_profit > 25) next.push([`Cut the number of fills: charges take ${F('costs_share', 'Charges as % of gross profit', p.costs_pct_gross_profit, fmtPct(p.costs_pct_gross_profit))} of gross profit.`, ['costs_share']]);
    const stress = st ? st.stress.selected : b.check ? b.check.stress : null;
    if (stress && stress.break_even_slip != null && stress.break_even_slip - stress.base_slip < 1) next.push([`Re-run at ${F('be_slip', 'Break-even slippage', stress.break_even_slip, fmtPct(stress.break_even_slip, 2))} slippage per fill: that is where the profit disappears.`, ['be_slip']]);
    if (!b.check && !st) next.push(['Run the robustness check to measure parameter stability and cost sensitivity for these exact settings.', []]);
    if (!st && p.traded >= 30) next.push(['Run the optimisation lab with walk-forward validation before changing any setting.', []]);
    if (!next.length) next.push(['Test a different period of comparable length to see whether the result repeats.', []]);
    next.forEach(([t, r]) => say(s7, t, r));

    return { version: VERSION, engine: 'templates', model: null, cost_inr: 0, sections: sections.filter((s) => s.sentences.length), facts: Array.from(facts.values()) };
  }

  // ================================================================== one call for the page
  /** Everything the research panel shows for a finished run. */
  function analyseRun(view, extra) {
    extra = extra || {};
    const opts = { capital: view.capital };
    const features = view.sessions ? sessionFeatures(view.sessions) : [];
    const dayInfo = {}; for (const d of view.days) dayInfo[d.date] = { is_expiry_day: d.is_expiry_day, dte: d.dte };
    const cls = features.length ? classify(features, { mode: extra.regimeMode, thresholds: extra.thresholds, dayInfo }) : null;
    const regimes = cls ? Object.assign(regimeBreakdown(view.days, cls, opts), { mode: cls.mode, unavailable: cls.unavailable, notes: cls.notes, thresholds: cls.thresholds }) : null;
    const p = perf(view.days, opts);
    const mc = monteCarlo(view.days.filter((d) => d.traded).map((d) => d.net), { capital: view.capital, paths: extra.mcPaths || 2000 });
    const models = {
      kmeans: kmeansRegimes(features), hmm: hmmVol(features), vol_forecast: volForecast(features), entry_filter: entryFilterModel(view.days, features, dayInfo),
      trees: { status: 'not_run', reason: 'Random forest and gradient boosting are not evaluated: with fewer than about 1,000 independent sessions they mostly memorise noise, and the logistic baseline must beat chance first.' },
    };
    const clusterRegimes = models.kmeans.status === 'ok' ? regimeBreakdown(view.days, { dims: [{ key: 'kmeans', label: 'k-means cluster', timing: 'ex-post', basis: models.kmeans.method, order: models.kmeans.centroids.map((c) => c.label), labels: models.kmeans.labels }] }, opts).dims[0] : null;
    const hmmRegimes = models.hmm.status === 'ok' ? regimeBreakdown(view.days, { dims: [{ key: 'hmm', label: 'HMM volatility state (filtered)', timing: 'ex-post', basis: models.hmm.method, order: ['Calm state', 'High-vol state'], labels: models.hmm.labels }] }, opts).dims[0] : null;
    const data = Object.assign({ sessions: p.sessions, excluded: p.excluded }, view.data || {});
    const robust = robustness({ perf: p, regimes, study: extra.study, check: extra.check, mc, data });
    const diag = diagnostics(view.days, Object.assign({ regimes, study: extra.study, check: extra.check }, opts));
    const text = explain({ perf: p, regimes, robust, study: extra.study, check: extra.check, meta: view.meta, data });
    return { version: VERSION, strategy: view.strategy, source: view.source, perf: p, features, regimes, models, cluster_regimes: clusterRegimes, hmm_regimes: hmmRegimes,
      monte_carlo: mc, robustness: robust, diagnostics: diag, assistant: text };
  }

  return { VERSION, rng, mean, sdev, quantile, t95, ciMean, normCdf, normInv, moments, spearman, sampleClass, maxDrawdown, fromRun, perf,
    UNAVAILABLE_INPUTS, sessionFeatures, DEFAULT_THRESHOLDS, classify, regimeBreakdown, kmeansRegimes, hmmVol, volForecast, entryFilterModel,
    PARAM_SPACE, axisValues, planCandidates, OBJECTIVES, scoreAll, splitChrono, walkForward, pbo, deflatedSharpe, monteCarlo, costScenarios,
    runOptimisation, runCheck, runRolling, diagnostics, WEIGHTS, robustness, explain, analyseRun, fmtInr };
});
