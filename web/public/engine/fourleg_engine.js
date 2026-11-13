/* Strategy 3 engine: monthly four-leg stock-options structure with ₹50 protective wings.
 * Browser + Node port of straddle_lab/fourleg.py and fourleg_data.py. Pure calculations, no DOM.
 * Shares Black-Scholes, the RNG, the cost schedule and the CSV tokenizer with engine.js (StraddleEngine).
 * Rules: docs/FOURLEG_RULES.md. Parity with Python: tools/parity_check.py.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./engine.js'));
  else root.FourLegEngine = factory(root.StraddleEngine);
})(typeof self !== 'undefined' ? self : this, function (SE) {
  'use strict';
  const { bs, mulberry32, fillCost, parseCSV } = SE;

  // ------------------------------------------------------------------ helpers
  const r2dp = x => Math.round(x * 100 + (x >= 0 ? 1e-9 : -1e-9)) / 100;
  const roundDown = (px, tick) => r2dp(Math.floor(px / tick + 1e-9) * tick);
  const roundUp = (px, tick) => r2dp(Math.ceil(px / tick - 1e-9) * tick);
  const r05 = x => Math.floor(x * 20 + 0.5) / 20;
  const r2 = x => Math.floor(x * 100 + 0.5) / 100;
  const kstr = k => String(+k);
  const ckey = (cp, k) => cp + ':' + kstr(k);
  const dnum = s => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / 86400000;
  const daysBetween = (a, b) => Math.round(dnum(b) - dnum(a));
  const iso = n => new Date(n * 86400000).toISOString().slice(0, 10);
  const wday = s => (new Date(dnum(s) * 86400000).getUTCDay() + 6) % 7;   // 0 = Monday
  const FIELDS = ['o', 'h', 'l', 'c', 's', 'bid', 'ask', 'vol', 'oi'];
  const nulls = n => new Array(n).fill(null);
  const clone = x => JSON.parse(JSON.stringify(x));
  const EPS = 1e-9;
  function pct(xs, q) {
    if (!xs.length) return null;
    if (xs.length === 1) return xs[0];
    const pos = (xs.length - 1) * q / 100, lo = Math.floor(pos), hi = Math.min(lo + 1, xs.length - 1);
    return xs[lo] + (xs[hi] - xs[lo]) * (pos - lo);
  }
  function counter(arr) { const o = {}; for (const x of arr) o[x] = (o[x] || 0) + 1; return o; }

  // ------------------------------------------------------------------ config
  const DEFAULTS = {
    symbols: ['RELIANCE', 'HDFCBANK', 'ICICIBANK', 'SBIN'],
    entry_rule: 'after_expiry', entry_delay: 0, entry_dte: 30, min_dte: 15,
    short_call_pct: 5.0, short_put_pct: 5.0, strike_round: 'nearest',
    wing_width: 50.0, missing_wing: 'skip', wing_authorized: [],
    short_call_lots: 3, long_call_lots: 5, short_put_lots: 3, long_put_lots: 5,
    target_pct_margin: 10.0, target_exec: 'same_close',
    a_exit_dte: 7, a_max_loss_pct: 25.0,
    b_exit_dte: 1, b_max_loss_pct: 25.0, b_mode: 'exit_before',
    margin_mode: 'model', fixed_margin: {}, scan_pct: 10.0, vol_scan_pct: 25.0, exposure_pct: 3.5,
    delivery_margin: true, delivery_margin_sched: [10.0, 25.0, 45.0, 70.0], iv_fallback: 30.0,
    capital_buffer_pct: 25.0, capital_cost_pct: 7.0,
    min_volume: 1, min_oi: 0, max_spread_pct: 100.0, price_field: 'close',
    use_quotes: true, slip_pct: 1.5, slip_ticks: 1, tick: 0.05,
    brokerage_per_order: 20.0, stt_sell_pct: 0.1, exch_pct: 0.03503, sebi_pct: 0.0001, stamp_buy_pct: 0.003, gst_pct: 18.0,
    delivery_stt_pct: 0.1, delivery_other_pct: 0.05, delivery_slip_pct: 0.25, funding_rate_pct: 9.0, funding_days: 2,
  };
  const ENUMS = {
    entry_rule: ['after_expiry', 'dte'], strike_round: ['nearest', 'outward', 'inward'], missing_wing: ['skip', 'nearest'],
    target_exec: ['same_close', 'next_close'], b_mode: ['exit_before', 'physical'], margin_mode: ['model', 'fixed', 'csv'],
    price_field: ['close', 'settle'],
  };
  const LEGS = [['SC', 'CE', -1, 'short_call_lots'], ['LC', 'CE', 1, 'long_call_lots'], ['SP', 'PE', -1, 'short_put_lots'], ['LP', 'PE', 1, 'long_put_lots']];
  const RATIOS = [1.0, 1.25, 1.5, 1.75, 2.0];

  function makeConfig(overrides) {
    const cfg = clone(DEFAULTS);
    for (const k of Object.keys(overrides || {})) {
      if (!(k in DEFAULTS)) throw new Error('unknown four-leg parameter: ' + k);
      cfg[k] = clone(overrides[k]);
    }
    for (const k of Object.keys(ENUMS)) if (!ENUMS[k].includes(cfg[k])) throw new Error(k + '=' + cfg[k] + ' invalid');
    for (const k of ['short_call_lots', 'long_call_lots', 'short_put_lots', 'long_put_lots'])
      if (!Number.isInteger(+cfg[k]) || cfg[k] < 1) throw new Error(k + ' must be a whole number of lots >= 1');
    if (!(cfg.wing_width > 0 && cfg.short_call_pct > 0 && cfg.short_put_pct > 0)) throw new Error('wing_width and short strike distances must be positive');
    if (cfg.a_exit_dte < 1) throw new Error('a_exit_dte must be >= 1 (Policy A exits before expiry)');
    if (cfg.b_mode === 'exit_before' && cfg.b_exit_dte < 1) throw new Error('b_exit_dte must be >= 1 unless b_mode is physical');
    if (cfg.min_dte <= cfg.a_exit_dte || (cfg.b_mode === 'exit_before' && cfg.min_dte <= cfg.b_exit_dte)) throw new Error('min_dte must exceed the scheduled exit days of both policies');
    if (cfg.target_pct_margin < 0) throw new Error('target_pct_margin must be >= 0');
    return cfg;
  }
  const ratioLots = (s, r) => Math.max(1, Math.floor(s * r + 0.5));

  // ------------------------------------------------------------------ synthetic data (ILLUSTRATIVE)
  const SYMBOLS = {
    RELIANCE: { spot: 1400.0, strike_step: 10.0, lot_size: 500, rv: 22.0, iv: 24.0, seed: 11 },
    HDFCBANK: { spot: 950.0, strike_step: 5.0, lot_size: 550, rv: 18.0, iv: 20.0, seed: 12 },
    ICICIBANK: { spot: 1400.0, strike_step: 10.0, lot_size: 700, rv: 21.0, iv: 23.0, seed: 13 },
    SBIN: { spot: 800.0, strike_step: 5.0, lot_size: 750, rv: 25.0, iv: 27.0, seed: 14 },
  };
  const SYN_BASE = {
    symbol: 'STOCK', spot: 1000.0, strike_step: 10.0, lot_size: 500,
    rv: 22.0, iv: 24.0, iv_revert: 0.1, iv_vol: 0.8, rv_regime: 0.08,
    skew: 0.4, smile: 2.0, drift_pct: 0.0,
    jump_every: 63, jump_sd: 4.0, earn_iv_pts: 4.0,
    spread_pct: 2.0, far_spread_mult: 8.0, vol_base: 2000.0,
    strike_band_pct: 20.0, strike_missing_prob: 0.0,
    n_months: 24, start: '2099-01-01', expiry_weekday: 1, seed: 7, events: [],
  };
  const range = (a, b) => { const o = []; for (let i = a; i < b; i++) o.push(i); return o; };
  const SCENARIOS = {
    quiet_decay: { label: 'Quiet month, premiums decay', rv: 12.0, iv: 26.0, jump_every: 0, seed: 5 },
    drift_up: { label: 'Steady rally through the short call', rv: 16.0, jump_every: 0, seed: 5, events: range(2, 14).map(d => ({ day: d, ret_pct: 1.1, iv_pts: 0.0 })) },
    gap_down: { label: 'Gap down beyond the long put', rv: 18.0, jump_every: 0, seed: 5, events: [{ day: 6, ret_pct: -13.0, iv_pts: 12.0 }] },
    vol_spike: { label: 'Implied vol jumps, price flat', rv: 14.0, jump_every: 0, seed: 5, events: [{ day: 4, ret_pct: 0.0, iv_pts: 14.0 }] },
    pin_short: { label: 'Drifts to the short call into expiry', rv: 10.0, jump_every: 0, seed: 5, events: range(1, 19).map(d => ({ day: d, ret_pct: 0.32, iv_pts: 0.0 })) },
    sparse_strikes: { label: '₹50 wing not listed (₹20 strike step)', rv: 15.0, jump_every: 0, strike_step: 20.0, spot: 1430.0, seed: 5 },
  };

  function monthlyExpiries(start, n, weekday) {
    let y = +start.slice(0, 4), m = +start.slice(5, 7);
    const out = [];
    for (let k = 0; k < n; k++) {
      const ny = m === 12 ? y + 1 : y, nm = m === 12 ? 1 : m + 1;
      let last = Date.UTC(ny, nm - 1, 1) / 86400000 - 1;
      while (wday(iso(last)) !== weekday) last -= 1;
      out.push(iso(last));
      y = ny; m = nm;
    }
    return out;
  }

  function generate(params) {
    const p = Object.assign({}, SYN_BASE, params || {});
    const rnd = mulberry32(p.seed | 0);
    const gauss = () => { const u1 = Math.max(rnd(), 1e-12), u2 = rnd(); return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2); };
    const expiries = monthlyExpiries(p.start, (p.n_months | 0) + 1, p.expiry_weekday | 0);
    const dates = [];
    for (let d = dnum(p.start), end = dnum(expiries[expiries.length - 1]); d <= end; d++) if (wday(iso(d)) < 5) dates.push(iso(d));
    const n = dates.length;
    const firstAfter = dates.findIndex(x => x > expiries[0]);
    const ev = new Map();
    for (const e of p.events) ev.set(firstAfter + (e.day | 0), e);
    const und = { o: [], h: [], l: [], c: [] }, atm = [];
    let S = p.spot, v = 0, iv = p.iv;
    const je = p.jump_every | 0;
    for (let t = 0; t < n; t++) {
      const z = gauss(), zv = gauss(), ziv = gauss();
      const uo = rnd() * 0.6;
      const hz = Math.abs(gauss()), lz = Math.abs(gauss());
      v = 0.95 * v + p.rv_regime * zv;
      const rv = p.rv / 100 * Math.exp(v);
      iv += p.iv_revert * (p.iv + (rv * 100 - p.rv) - iv) + p.iv_vol * ziv;
      let jump = 0;
      if (je > 0 && t % je === Math.floor(je / 2)) jump = p.jump_sd / 100 * gauss();
      const e = ev.get(t);
      if (e) { jump += Math.log(1 + e.ret_pct / 100); iv += e.iv_pts; }
      iv = Math.max(5.0, iv);
      let bump = 0;
      if (je > 0) { const toNext = ((Math.floor(je / 2) - t % je) % je + je) % je; if (toNext > 0 && toNext <= 5) bump = p.earn_iv_pts; }
      atm.push(iv + bump);
      const dr = (p.drift_pct / 100 - 0.5 * rv * rv) / 252;
      const r = dr + rv / Math.sqrt(252) * z;
      const o = S * Math.exp(r * uo + jump), c = S * Math.exp(r + jump);
      const h = Math.max(o, c) * Math.exp(hz * rv / Math.sqrt(252) * 0.5);
      const lo = Math.min(o, c) * Math.exp(-lz * rv / Math.sqrt(252) * 0.5);
      und.o.push(r2(o)); und.h.push(r2(h)); und.l.push(r2(lo)); und.c.push(r2(c));
      S = c;
    }
    const step = p.strike_step, band = p.strike_band_pct / 100, chains = {};
    expiries.forEach((ex, kEx) => {
      const startI = kEx < 2 ? 0 : dates.findIndex(x => x > expiries[kEx - 2]);
      let stopI = 0;
      dates.forEach((x, i) => { if (x <= ex) stopI = i; });
      const lot = nulls(n), strikes = [], skip = new Set(), con = {};
      for (let t = startI; t <= stopI; t++) {
        lot[t] = p.lot_size | 0;
        const s = und.c[t];
        const loK = Math.floor(s * (1 - band) / step) * step, hiK = Math.ceil(s * (1 + band) / step) * step;
        for (let k = loK; k <= hiK + 1e-9; k += step) {
          const kk = Math.round(k * 1e6) / 1e6;
          if (!strikes.includes(kk) && !skip.has(kk)) {
            if (p.strike_missing_prob > 0 && rnd() < p.strike_missing_prob) skip.add(kk);
            else { strikes.push(kk); for (const cp of ['CE', 'PE']) { const x = {}; for (const f of FIELDS) x[f] = nulls(n); con[ckey(cp, kk)] = x; } }
          }
        }
        strikes.sort((a, b) => a - b);
        const tau = daysBetween(dates[t], ex) / 365;
        const so = und.o[t], sh = und.h[t], sl = und.l[t];
        for (const cp of ['CE', 'PE']) for (const kk of strikes) {
          const m = Math.log(kk / s);
          const vol = Math.max(3.0, atm[t] - p.skew * m * 100 + p.smile * m * m * 100) / 100;
          const cc = bs(cp, s, kk, tau, vol), oo = bs(cp, so, kk, tau, vol);
          const hh = bs(cp, cp === 'CE' ? sh : sl, kk, tau, vol), ll = bs(cp, cp === 'CE' ? sl : sh, kk, tau, vol);
          const x = con[ckey(cp, kk)];
          const c5 = Math.max(0.05, r05(cc)), o5 = Math.max(0.05, r05(oo));
          x.c[t] = c5; x.o[t] = o5; x.h[t] = Math.max(c5, o5, r05(hh)); x.l[t] = Math.max(0.05, Math.min(c5, o5, r05(ll))); x.s[t] = c5;
          const half = Math.max(0.05, cc * p.spread_pct / 200 * (1 + p.far_spread_mult * Math.abs(m)));
          const bid = Math.max(0.05, r05(cc - half));
          x.bid[t] = bid; x.ask[t] = Math.max(r2(bid + 0.05), r05(cc + half));
          x.vol[t] = Math.floor(p.vol_base * Math.exp(-Math.abs(m) * 12) * (0.2 + 1.6 * rnd()));
          x.oi[t] = Math.floor(p.vol_base * 4 * Math.exp(-Math.abs(m) * 8));
        }
      }
      chains[ex] = { lot, strikes: { CE: strikes.slice(), PE: strikes.slice() }, con };
    });
    return { symbol: p.symbol, source: 'synthetic', label: p.label || '', dates, und, expiries, chains, margin: null, params: p };
  }
  function syntheticUniverse(symbols, nMonths, overrides) {
    return (symbols || Object.keys(SYMBOLS)).map(sym => generate(Object.assign({}, SYMBOLS[sym] || {}, { symbol: sym, n_months: nMonths || 24 }, overrides || {})));
  }
  function scenarioDataset(name, symbol) {
    symbol = symbol || 'RELIANCE';
    return generate(Object.assign({}, SYMBOLS[symbol] || {}, { symbol, n_months: 1 }, SCENARIOS[name]));
  }

  // ------------------------------------------------------------------ prices and fills
  const legPrice = (con, i, cfg) => (con == null ? null : (cfg.price_field === 'settle' ? con.s[i] : con.c[i]));
  function quotes(con, i, cfg) {
    if (!cfg.use_quotes) return null;
    const b = con.bid[i], a = con.ask[i];
    return b != null && a != null ? [b, a] : null;
  }
  function sellPx(con, i, cfg) {
    const p = legPrice(con, i, cfg);
    if (p == null) return null;
    const q = quotes(con, i, cfg);
    const px = q ? q[0] : p * (1 - cfg.slip_pct / 100) - cfg.slip_ticks * cfg.tick;
    return Math.max(cfg.tick, roundDown(px, cfg.tick));
  }
  function buyPx(con, i, cfg) {
    const p = legPrice(con, i, cfg);
    if (p == null) return null;
    const q = quotes(con, i, cfg);
    const px = q ? q[1] : p * (1 + cfg.slip_pct / 100) + cfg.slip_ticks * cfg.tick;
    return roundUp(px, cfg.tick);
  }
  function impliedVol(cp, s, k, t, price) {
    const intrinsic = cp === 'CE' ? Math.max(0, s - k) : Math.max(0, k - s);
    if (t <= 0 || price == null || price <= intrinsic + 1e-9) return null;
    let lo = 0.005, hi = 5.0;
    if (bs(cp, s, k, t, hi) < price) return null;
    for (let n = 0; n < 60; n++) { const mid = (lo + hi) / 2; if (bs(cp, s, k, t, mid) > price) hi = mid; else lo = mid; }
    return (lo + hi) / 2;
  }

  // ------------------------------------------------------------------ calendar
  function cycles(ds, cfg) {
    const dates = ds.dates, out = [];
    ds.expiries.forEach((ex, k) => {
      const prev = k > 0 ? ds.expiries[k - 1] : null;
      const win = [];
      dates.forEach((d, i) => { if ((prev == null || d > prev) && d <= ex) win.push(i); });
      if (!win.length) return;
      const cyc = { symbol: ds.symbol, expiry: ex, entry_i: null, reason: null };
      if (cfg.entry_rule === 'after_expiry') {
        if (prev == null) cyc.reason = 'no_prior_expiry_in_data';
        else if (cfg.entry_delay >= win.length) cyc.reason = 'entry_day_not_in_data';
        else cyc.entry_i = win[cfg.entry_delay | 0];
      } else {
        const cand = win.filter(i => daysBetween(dates[i], ex) <= cfg.entry_dte);
        if (!cand.length) cyc.reason = 'entry_day_not_in_data';
        else if (prev == null && cand[0] === win[0] && daysBetween(dates[win[0]], ex) < cfg.entry_dte) cyc.reason = 'cycle_starts_before_data';
        else cyc.entry_i = cand[0];
      }
      if (cyc.entry_i != null && daysBetween(dates[cyc.entry_i], ex) < cfg.min_dte) { cyc.reason = 'entry_too_close_to_expiry'; cyc.entry_i = null; }
      out.push(cyc);
    });
    return out;
  }

  // ------------------------------------------------------------------ strike selection
  const listed = (ch, cp, i, cfg) => ch.strikes[cp].filter(k => legPrice(ch.con[ckey(cp, k)], i, cfg) != null);
  const outward = (cp, a, b) => (cp === 'CE' ? a > b : a < b);
  function pickShort(strikes, theo, cp, spot, rule) {
    let best = null;
    if (rule === 'outward') {
      const c = strikes.filter(k => (cp === 'CE' ? k >= theo - EPS : k <= theo + EPS));
      best = c.length ? (cp === 'CE' ? Math.min(...c) : Math.max(...c)) : null;
    } else if (rule === 'inward') {
      const c = strikes.filter(k => (cp === 'CE' ? spot < k && k <= theo + EPS : theo - EPS <= k && k < spot));
      best = c.length ? (cp === 'CE' ? Math.max(...c) : Math.min(...c)) : null;
    } else {
      let bd = null;
      for (const k of strikes) {
        const d = Math.abs(k - theo);
        if (best == null || d < bd - EPS || (Math.abs(d - bd) <= EPS && outward(cp, k, best))) { best = k; bd = d; }
      }
    }
    if (best == null || (cp === 'CE' && best <= spot) || (cp === 'PE' && best >= spot)) return null;
    return best;
  }
  function pickWing(strikes, shortK, cp, width, authorized) {
    const want = cp === 'CE' ? shortK + width : shortK - width;
    for (const k of strikes) if (Math.abs(k - want) < 1e-6) return { strike: k, want, note: 'exact', nearest: k };
    let near = null, nd = null;
    for (const k of strikes.filter(k => outward(cp, k, shortK))) {
      const d = Math.abs(k - want);
      if (near == null || d < nd - EPS || (Math.abs(d - nd) <= EPS && outward(cp, k, near))) { near = k; nd = d; }
    }
    return { strike: authorized && near != null ? near : null, want, note: authorized && near != null ? 'authorized_nearest' : 'unavailable', nearest: near };
  }
  const monthKey = (ds, ex) => ds.symbol + ':' + ex.slice(0, 7);

  function buildEntry(ds, cyc, cfg) {
    const ent = { symbol: ds.symbol, expiry: cyc.expiry, cycle: cyc.expiry.slice(0, 7), status: 'skipped', reason: cyc.reason, flags: [] };
    if (cyc.entry_i == null) return ent;
    const i = cyc.entry_i, ex = cyc.expiry, ch = ds.chains[ex], spot = ds.und.c[i];
    Object.assign(ent, { entry_i: i, entry_date: ds.dates[i], dte_entry: daysBetween(ds.dates[i], ex), entry_spot: spot });
    if (spot == null) { ent.reason = 'no_underlying_price'; return ent; }
    if (!ch || ch.lot[i] == null) { ent.reason = 'expiry_not_listed'; return ent; }
    const lot = ch.lot[i];
    ent.lot_size = lot;
    const theo = { SC: spot * (1 + cfg.short_call_pct / 100), SP: spot * (1 - cfg.short_put_pct / 100) };
    const strikes = { CE: listed(ch, 'CE', i, cfg), PE: listed(ch, 'PE', i, cfg) };
    const sc = pickShort(strikes.CE, theo.SC, 'CE', spot, cfg.strike_round);
    const sp = pickShort(strikes.PE, theo.SP, 'PE', spot, cfg.strike_round);
    ent.theo = theo;
    if (sc == null || sp == null) { ent.reason = 'no_otm_short_strike'; ent.detail = { SC: sc, SP: sp }; return ent; }
    const auth = cfg.missing_wing === 'nearest' || cfg.wing_authorized.includes(monthKey(ds, ex));
    const wc = pickWing(strikes.CE, sc, 'CE', cfg.wing_width, auth), wp = pickWing(strikes.PE, sp, 'PE', cfg.wing_width, auth);
    ent.wings = { LC: wc, LP: wp };
    if (wc.strike == null || wp.strike == null) { ent.reason = 'wing_unavailable'; ent.month_key = monthKey(ds, ex); return ent; }
    const chosen = { SC: sc, LC: wc.strike, SP: sp, LP: wp.strike };
    const theoK = { SC: theo.SC, LC: wc.want, SP: theo.SP, LP: wp.want };
    const legs = LEGS.map(([id, cp, side, lk]) => {
      const k = chosen[id];
      return { id, cp, side, lots: cfg[lk] | 0, qty: (cfg[lk] | 0) * lot, theo: theoK[id], strike: k, key: ckey(cp, k),
        wing_dist: side > 0 ? Math.abs(k - (cp === 'CE' ? sc : sp)) : null, note: side > 0 ? (id === 'LC' ? wc : wp).note : 'short' };
    });
    ent.legs = legs;
    for (const lg of legs) {
      const con = ch.con[lg.key], v = con.vol[i], oi = con.oi[i], q = quotes(con, i, cfg);
      if (cfg.min_volume > 0 && v != null && v < cfg.min_volume) { ent.reason = 'illiquid'; ent.detail = { leg: lg.id, volume: v }; return ent; }
      if (cfg.min_oi > 0 && oi != null && oi < cfg.min_oi) { ent.reason = 'illiquid'; ent.detail = { leg: lg.id, oi }; return ent; }
      if (q && cfg.max_spread_pct < 100) {
        const mid = (q[0] + q[1]) / 2;
        if (mid > 0 && 100 * (q[1] - q[0]) / mid > cfg.max_spread_pct) { ent.reason = 'illiquid'; ent.detail = { leg: lg.id, spread_pct: 100 * (q[1] - q[0]) / mid }; return ent; }
      }
      if (cfg.min_volume > 0 && v == null && !ent.flags.includes('no_volume_data')) ent.flags.push('no_volume_data');
      if (v != null && v === 0 && !ent.flags.includes('stale_entry_price')) ent.flags.push('stale_entry_price');
    }
    let cash = 0, costs = 0;
    for (const lg of legs) {
      const con = ch.con[lg.key];
      let px, c;
      if (lg.side < 0) { px = sellPx(con, i, cfg); cash += px * lg.qty; c = fillCost('SELL', px, lg.qty, cfg).total; }
      else { px = buyPx(con, i, cfg); cash -= px * lg.qty; c = fillCost('BUY', px, lg.qty, cfg).total; }
      lg.entry_px = px; lg.entry_cost = c; costs += c;
    }
    ent.entry_cash = cash; ent.entry_costs = costs;
    const m = marginAt(ds, ch, legs, i, ex, cfg, ds.dates[i]);
    if (m == null || !(m.total > 0)) { ent.reason = cfg.margin_mode === 'fixed' ? 'no_margin_input' : 'no_margin_data'; return ent; }
    ent.margin0 = m.total; ent.margin_detail = m;
    legs.forEach((lg, n) => { lg.entry_iv = m.ivs ? m.ivs[n] : null; });
    ent.target = cfg.target_pct_margin / 100 * m.total;
    ent.allocated = m.total * (1 + cfg.capital_buffer_pct / 100) + Math.max(0, costs - cash);
    ent.status = 'ready'; ent.reason = null;
    return ent;
  }

  // ------------------------------------------------------------------ margin
  const SCAN = [[0, 1], [0, -1], [1 / 3, 1], [1 / 3, -1], [-1 / 3, 1], [-1 / 3, -1], [2 / 3, 1], [2 / 3, -1],
    [-2 / 3, 1], [-2 / 3, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
  function tradingDaysLeft(ds, j, ex) { let n = 0; for (let k = j + 1; k < ds.dates.length; k++) if (ds.dates[k] <= ex) n++; return n; }
  function netItmShares(legs, s) {
    let n = 0;
    for (const lg of legs) {
      const itm = lg.cp === 'CE' ? s > lg.strike : s < lg.strike;
      if (itm) { const buy = (lg.cp === 'CE') === (lg.side > 0); n += buy ? lg.qty : -lg.qty; }
    }
    return n;
  }
  function modelMargin(legs, s, t, ivs, cfg) {
    const value = (sx, vm) => { let v = 0; legs.forEach((lg, n) => { v += lg.side * lg.qty * bs(lg.cp, sx, lg.strike, t, ivs[n] * vm); }); return v; };
    const base = value(s, 1.0);
    let worst = 0;
    for (const [frac, vd] of SCAN) worst = Math.max(worst, base - value(s * (1 + frac * cfg.scan_pct / 100), 1 + vd * cfg.vol_scan_pct / 100));
    for (const frac of [2.0, -2.0]) worst = Math.max(worst, 0.35 * (base - value(s * (1 + frac * cfg.scan_pct / 100), 1.0)));
    let shortQty = 0;
    for (const lg of legs) if (lg.side < 0) shortQty += lg.qty;
    return [worst, cfg.exposure_pct / 100 * s * shortQty];
  }
  function marginAt(ds, ch, legs, j, ex, cfg, d) {
    if (cfg.margin_mode === 'fixed') { const v = (cfg.fixed_margin || {})[ds.symbol]; return v ? { total: +v, mode: 'fixed' } : null; }
    if (cfg.margin_mode === 'csv') { const v = (ds.margin || {})[d]; return v ? { total: +v, mode: 'csv' } : null; }
    const s = ds.und.c[j], t = daysBetween(d, ex) / 365;
    let ivs = legs.map(lg => impliedVol(lg.cp, s, lg.strike, t, legPrice(ch.con[lg.key], j, cfg)));
    const have = ivs.filter(v => v != null);
    let fb;
    if (have.length) { let sum = 0; for (const v of have) sum += v; fb = sum / have.length; } else fb = cfg.iv_fallback / 100;
    ivs = ivs.map(v => (v != null ? v : fb));
    const [scan, exposure] = modelMargin(legs, s, t, ivs, cfg);
    let delivery = 0;
    const left = tradingDaysLeft(ds, j, ex), sched = cfg.delivery_margin_sched;
    if (cfg.delivery_margin && left <= sched.length) {
      const p = left >= 1 ? sched[sched.length - left] : sched[sched.length - 1];
      delivery = p / 100 * (cfg.scan_pct + cfg.exposure_pct) / 100 * Math.abs(netItmShares(legs, s)) * s;
    }
    return { total: scan + exposure + delivery, scan, exposure, delivery, ivs, mode: 'model' };
  }

  // ------------------------------------------------------------------ simulation
  function mark(ch, legs, j, cfg) {
    let cash = 0, cost = 0, mid = 0;
    for (const lg of legs) {
      const con = ch.con[lg.key], p = legPrice(con, j, cfg);
      if (p == null) return null;
      if (lg.side < 0) { const px = buyPx(con, j, cfg); cash -= px * lg.qty; cost += fillCost('BUY', px, lg.qty, cfg).total; mid -= p * lg.qty; }
      else { const px = sellPx(con, j, cfg); cash += px * lg.qty; cost += fillCost('SELL', px, lg.qty, cfg).total; mid += p * lg.qty; }
    }
    return [cash, cost, mid];
  }
  function settle(ds, legs, x, cfg, res) {
    const s = ds.und.c[x];
    let cash = 0, grossDeliv = 0, n = 0;
    for (const lg of legs) {
      const itm = lg.cp === 'CE' ? s > lg.strike : s < lg.strike;
      lg.exit_px = lg.cp === 'CE' ? Math.max(0, s - lg.strike) : Math.max(0, lg.strike - s);
      if (!itm) continue;
      const buy = (lg.cp === 'CE') === (lg.side > 0), sh = buy ? lg.qty : -lg.qty;
      n += sh; cash -= sh * lg.strike; grossDeliv += Math.abs(sh) * lg.strike;
    }
    const rate = (cfg.delivery_stt_pct + cfg.delivery_other_pct) / 100;
    let charges = grossDeliv * rate;
    const nxt = x + 1 < ds.dates.length && ds.und.o[x + 1] != null ? x + 1 : null;
    let liqCash = 0, liqPx = 0;
    if (n !== 0) {
      const o = nxt != null ? ds.und.o[nxt] : s;
      if (nxt == null) res.flags.push('no_next_day_price');
      liqPx = n > 0 ? o * (1 - cfg.delivery_slip_pct / 100) : o * (1 + cfg.delivery_slip_pct / 100);
      liqCash = n * liqPx;
      charges += Math.abs(n) * liqPx * rate;
      if (n < 0) res.flags.push('short_delivery_risk');
    }
    const funding = cfg.funding_rate_pct / 100 * Math.max(0, -cash) * cfg.funding_days / 365;
    res.settlement = { price: s, net_shares: n, gross_delivery_value: grossDeliv, settle_cash: cash, liquidation_px: liqPx, liquidation_cash: liqCash,
      delivery_charges: charges, funding, liquidation_date: nxt != null ? ds.dates[nxt] : ds.dates[x] };
    res.exit_cash = cash + liqCash;
    res.exit_costs = charges + funding;
  }

  function simulateCycle(ds, ent, cfg, policy) {
    const res = {};
    for (const k of Object.keys(ent)) if (k !== 'legs' && k !== 'flags' && k !== '_mc') res[k] = ent[k];
    res.policy = policy;
    res.flags = ent.flags.slice();
    if (ent.status !== 'ready') return res;
    const legs = ent.legs.map(lg => Object.assign({}, lg));
    res.legs = legs;
    const ch = ds.chains[ent.expiry], dates = ds.dates, ex = ent.expiry, i = ent.entry_i;
    const physical = policy === 'B' && cfg.b_mode === 'physical';
    const exitDte = policy === 'A' ? cfg.a_exit_dte : cfg.b_exit_dte;
    const maxLoss = policy === 'A' ? cfg.a_max_loss_pct : cfg.b_max_loss_pct;
    let last = 0;
    dates.forEach((d, j) => { if (d <= ex) last = j; });
    let sched = null;
    if (!physical) {
      const c = [];
      for (let j = i + 1; j <= last; j++) if (daysBetween(dates[j], ex) >= exitDte) c.push(j);
      sched = c.length ? c[c.length - 1] : Math.min(i + 1, last);
    }
    const m0 = ent.margin0, target = ent.target, path = [];
    let mPrev = m0;
    const first = mark(ch, legs, i, cfg);
    path.push({ date: dates[i], dte: ent.dte_entry, spot: ent.entry_spot, net: ent.entry_cash + first[0] - ent.entry_costs - first[1],
      mid: ent.entry_cash + first[2] - ent.entry_costs, margin: m0 });
    let exitJ = null, reason = null, pendingTarget = false;
    if (!ent._mc) Object.defineProperty(ent, '_mc', { value: new Map(), enumerable: false, writable: true });
    for (let j = i + 1; j <= last; j++) {
      const mk = ds.und.c[j] != null ? mark(ch, legs, j, cfg) : null;
      const d = dates[j];
      if (mk == null) {
        path.push({ date: d, dte: daysBetween(d, ex), spot: ds.und.c[j], net: null, mid: null, margin: null });
        if (!res.flags.includes('missing_price')) res.flags.push('missing_price');
        if (sched != null && j >= sched && !res.flags.includes('exit_postponed')) res.flags.push('exit_postponed');
        continue;
      }
      const net = ent.entry_cash + mk[0] - ent.entry_costs - mk[1];
      if (!ent._mc.has(j)) ent._mc.set(j, marginAt(ds, ch, legs, j, ex, cfg, d));
      const mg = ent._mc.get(j);
      const mNow = mg ? mg.total : mPrev;
      mPrev = mNow;
      path.push({ date: d, dte: daysBetween(d, ex), spot: ds.und.c[j], net, mid: ent.entry_cash + mk[2] - ent.entry_costs, margin: mNow });
      if (pendingTarget) { exitJ = j; reason = 'target'; break; }
      if (target > 0 && net >= target - EPS) {
        if (cfg.target_exec === 'same_close' || j === last) {
          exitJ = j; reason = 'target';
          if (cfg.target_exec === 'next_close') res.flags.push('target_next_close_unavailable');
          break;
        }
        pendingTarget = true;
        continue;
      }
      if (maxLoss > 0 && net <= -maxLoss / 100 * m0 + EPS) { exitJ = j; reason = 'max_loss'; break; }
      if (sched != null && j >= sched) { exitJ = j; reason = 'scheduled'; break; }
      if (physical && d === ex) break;
    }
    if (exitJ != null) {
      const mk = mark(ch, legs, exitJ, cfg);
      for (const lg of legs) { const con = ch.con[lg.key]; lg.exit_px = lg.side < 0 ? buyPx(con, exitJ, cfg) : sellPx(con, exitJ, cfg); }
      res.exit_cash = mk[0]; res.exit_costs = mk[1];
      res.exit_i = exitJ; res.exit_date = dates[exitJ]; res.exit_reason = reason;
    } else if (dates[last] === ex && ds.und.c[last] != null) {
      settle(ds, legs, last, cfg, res);
      res.exit_i = last; res.exit_date = ex; res.exit_reason = 'expiry_settlement';
      if (!physical) res.flags.push('forced_expiry_settlement');
    } else {
      res.status = 'excluded'; res.reason = 'data_ends_before_exit'; res.path = path;
      return res;
    }
    res.status = 'traded';
    res.path = path;
    res.gross = ent.entry_cash + res.exit_cash;
    res.costs = ent.entry_costs + res.exit_costs;
    res.net = res.gross - res.costs;
    res.days_held = daysBetween(ent.entry_date, res.exit_date);
    res.tdays_held = res.exit_i - i;
    res.days_to_target = res.exit_reason === 'target' ? res.days_held : null;
    const nets = path.filter(p => p.net != null).map(p => p.net);
    res.mae = Math.min(0, Math.min(...nets));
    res.mfe = Math.max(0, Math.max(...nets));
    const ms = path.filter(p => p.margin != null).map(p => p.margin);
    res.margin_max = Math.max(...ms);
    res.margin_change_pct = 100 * (res.margin_max / m0 - 1);
    res.roim = 100 * res.net / m0;
    res.roac = 100 * res.net / ent.allocated;
    const se = ds.und.c[res.exit_i], nSh = netItmShares(legs, se);
    res.phys = { itm_legs: legs.filter(lg => (lg.cp === 'CE' ? se > lg.strike : se < lg.strike)).length, net_shares: nSh, notional: Math.abs(nSh) * se, spot: se };
    return res;
  }

  function run(datasets, cfg) {
    const A = [], B = [];
    for (const ds of datasets) {
      if (!cfg.symbols.includes(ds.symbol)) continue;
      for (const cyc of cycles(ds, cfg)) {
        const ent = buildEntry(ds, cyc, cfg);
        A.push(simulateCycle(ds, ent, cfg, 'A'));
        B.push(simulateCycle(ds, ent, cfg, 'B'));
      }
    }
    return { config: cfg, A, B, metrics: { A: metrics(A), B: metrics(B) }, comparison: compare(A, B, cfg) };
  }

  // ------------------------------------------------------------------ payoff
  function payoff(legs, entryCash, costs, spots) {
    return spots.map(s => {
      let v = entryCash - costs;
      for (const lg of legs) v += lg.side * lg.qty * (lg.cp === 'CE' ? Math.max(0, s - lg.strike) : Math.max(0, lg.strike - s));
      return v;
    });
  }
  function payoffMtm(legs, entryCash, costs, spots, t, ivs) {
    return spots.map(s => { let v = entryCash - costs; legs.forEach((lg, n) => { v += lg.side * lg.qty * bs(lg.cp, s, lg.strike, t, ivs[n]); }); return v; });
  }
  function breakevens(legs, entryCash, costs) {
    const ks = [...new Set(legs.map(lg => lg.strike))].sort((a, b) => a - b);
    const pts = [ks[0] * 0.5, ...ks, ks[ks.length - 1] * 1.5];
    const vals = payoff(legs, entryCash, costs, pts), out = [];
    for (let n = 0; n + 1 < pts.length; n++) {
      const a = pts[n], b = pts[n + 1], va = vals[n], vb = vals[n + 1];
      if (va === 0) out.push(a);
      else if (va * vb < 0) out.push(a + (b - a) * va / (va - vb));
    }
    return out;
  }
  function structureSummary(legs, entryCash, costs) {
    const ks = [...new Set(legs.map(lg => lg.strike))].sort((a, b) => a - b);
    const vals = payoff(legs, entryCash, costs, ks), at = {};
    ks.forEach((k, n) => { at[k] = vals[n]; });
    let up = 0, dn = 0;
    for (const lg of legs) { if (lg.cp === 'CE') up += lg.side * lg.qty; else dn += lg.side * lg.qty; }
    return { at_strikes: at, max_loss_at_strikes: Math.min(...vals), upside_slope: up, downside_slope: dn, breakevens: breakevens(legs, entryCash, costs) };
  }

  // ------------------------------------------------------------------ metrics
  function equity(traded) {
    const ds = new Set();
    for (const r of traded) { for (const p of r.path) ds.add(p.date); ds.add(r.exit_date); }
    const dates = [...ds].sort();
    const series = traded.map(r => { const mp = new Map(); for (const p of r.path) if (p.net != null) mp.set(p.date, p.net); return [r.entry_date, r.exit_date, mp, r.net]; });
    const last = series.map(() => 0), curve = [];
    let peak = 0, dd = 0;
    for (const d of dates) {
      let tot = 0;
      series.forEach(([a, b, mp, fin], n) => {
        const v = d < a ? 0 : d >= b ? fin : (mp.has(d) ? mp.get(d) : last[n]);
        last[n] = v; tot += v;
      });
      peak = Math.max(peak, tot); dd = Math.min(dd, tot - peak);
      curve.push({ date: d, equity: tot, dd: tot - peak });
    }
    return [curve, dd];
  }
  const sum = xs => { let s = 0; for (const x of xs) s += x; return s; };

  function metrics(results) {
    const traded = results.filter(r => r.status === 'traded');
    const m = { cycles: results.length, traded: traded.length,
      skipped: counter(results.filter(r => r.status === 'skipped').map(r => r.reason)),
      excluded: counter(results.filter(r => r.status === 'excluded').map(r => r.reason)) };
    if (!traded.length) { m.warning = 'no traded months'; return m; }
    const n = traded.length, nets = traded.map(r => r.net), mean = sum(nets) / n;
    let ss = 0; for (const x of nets) ss += (x - mean) ** 2;
    const sd = n > 1 ? Math.sqrt(ss / (n - 1)) : 0;
    const wins = nets.filter(x => x > 0), losses = nets.filter(x => x <= 0);
    const hits = traded.filter(r => r.exit_reason === 'target');
    const grossProfit = sum(traded.filter(r => r.gross > 0).map(r => r.gross));
    const costs = sum(traded.map(r => r.costs));
    Object.assign(m, {
      net_pnl: sum(nets), gross_pnl: sum(traded.map(r => r.gross)), costs,
      avg_net: mean, median_net: pct(nets.slice().sort((a, b) => a - b), 50), sd_net: sd,
      t_stat: sd > 0 ? mean / (sd / Math.sqrt(n)) : null,
      ci95: n > 1 ? [mean - 1.96 * sd / Math.sqrt(n), mean + 1.96 * sd / Math.sqrt(n)] : null,
      win_rate: 100 * wins.length / n,
      profit_factor: losses.length && sum(losses) < 0 ? sum(wins) / -sum(losses) : null,
      largest_win: Math.max(...nets), largest_loss: Math.min(...nets),
      pct_target: 100 * hits.length / n,
      avg_days_to_target: hits.length ? sum(hits.map(r => r.days_to_target)) / hits.length : null,
      avg_days_held: sum(traded.map(r => r.days_held)) / n,
      avg_roim_pct: sum(traded.map(r => r.roim)) / n,
      total_roim_pct: 100 * sum(nets) / sum(traded.map(r => r.margin0)),
      avg_roac_pct: sum(traded.map(r => r.roac)) / n,
      total_roac_pct: 100 * sum(nets) / sum(traded.map(r => r.allocated)),
      avg_margin0: sum(traded.map(r => r.margin0)) / n,
      max_adverse_mtm: Math.min(...traded.map(r => r.mae)),
      avg_adverse_mtm: sum(traded.map(r => r.mae)) / n,
      avg_margin_change_pct: sum(traded.map(r => r.margin_change_pct)) / n,
      max_margin_change_pct: Math.max(...traded.map(r => r.margin_change_pct)),
      costs_pct_of_gross_profit: grossProfit > 0 ? 100 * costs / grossProfit : null,
      exit_reasons: counter(traded.map(r => r.exit_reason)),
      pct_itm_at_exit: 100 * traded.filter(r => r.phys.itm_legs > 0).length / n,
      max_deliverable_notional: Math.max(...traded.map(r => r.phys.notional)),
      settled_physically: traded.filter(r => r.exit_reason === 'expiry_settlement').length,
      short_delivery_months: traded.filter(r => r.flags.includes('short_delivery_risk')).length,
      flags: counter(traded.flatMap(r => r.flags)),
    });
    const [curve, dd] = equity(traded);
    m.max_drawdown = dd; m.equity_curve = curve;
    const monthly = {};
    for (const r of traded.slice().sort((a, b) => (a.cycle < b.cycle ? -1 : a.cycle > b.cycle ? 1 : 0))) monthly[r.cycle] = (monthly[r.cycle] || 0) + r.net;
    const mk = Object.keys(monthly).sort(), mv = mk.map(k => monthly[k]);
    m.monthly = monthly; m.months = mv.length;
    m.avg_month_net = sum(mv) / mv.length;
    m.pct_positive_months = 100 * mv.filter(x => x > 0).length / mv.length;
    if (mv.length > 1) {
      const mm = m.avg_month_net;
      let s2 = 0; for (const x of mv) s2 += (x - mm) ** 2;
      const msd = Math.sqrt(s2 / (mv.length - 1));
      m.month_t_stat = msd > 0 ? mm / (msd / Math.sqrt(mv.length)) : null;
    } else m.month_t_stat = null;
    const by = {};
    for (const r of traded) {
      const b = by[r.symbol] || (by[r.symbol] = { traded: 0, net: 0, hits: 0, margin: 0, worst: 0 });
      b.traded += 1; b.net += r.net; b.hits += r.exit_reason === 'target' ? 1 : 0; b.margin += r.margin0; b.worst = Math.min(b.worst, r.net);
    }
    for (const b of Object.values(by)) { b.pct_target = 100 * b.hits / b.traded; b.roim_pct = 100 * b.net / b.margin; }
    m.by_symbol = by;
    m.tail_note = n >= 60 ? 'adequate' : `only ${n} traded months; averages and tails are indicative`;
    return m;
  }

  function compare(A, B, cfg) {
    const pairs = [];
    A.forEach((a, k) => { const b = B[k]; if (a.status === 'traded' && b.status === 'traded') pairs.push([a, b]); });
    const out = { pairs: pairs.length };
    if (!pairs.length) return out;
    const inc = pairs.map(([a, b]) => b.net - a.net), n = inc.length, mean = sum(inc) / n;
    let ss = 0; for (const x of inc) ss += (x - mean) ** 2;
    const sd = n > 1 ? Math.sqrt(ss / (n - 1)) : 0;
    Object.assign(out, { incremental_total: sum(inc), incremental_mean: mean,
      incremental_ci95: n > 1 ? [mean - 1.96 * sd / Math.sqrt(n), mean + 1.96 * sd / Math.sqrt(n)] : null,
      pct_b_better: 100 * inc.filter(x => x > 0).length / n });
    const held = pairs.filter(([a]) => a.exit_reason === 'scheduled');
    out.held_beyond_schedule = held.length;
    if (held.length) {
      const rows = held.map(([a, b]) => {
        const extra = daysBetween(a.exit_date, b.exit_date);
        const after = b.path.filter(p => p.date > a.exit_date && p.net != null).map(p => p.net);
        const cap = a.allocated * cfg.capital_cost_pct / 100 * Math.max(0, extra) / 365;
        return { symbol: a.symbol, cycle: a.cycle, a_net: a.net, b_net: b.net, incremental: b.net - a.net, extra_days: extra, capital_cost: cap,
          b_reason: b.exit_reason, worst_after: after.length ? Math.min(...after) : null,
          extra_margin_pct: 100 * (Math.max(...b.path.filter(p => p.margin != null).map(p => p.margin)) / a.margin0 - 1) };
      });
      const hi = rows.map(r => r.incremental), capSum = sum(rows.map(r => r.capital_cost));
      const wa = rows.filter(r => r.worst_after != null).map(r => r.worst_after);
      Object.assign(out, {
        held_incremental_mean: sum(hi) / hi.length, held_incremental_median: pct(hi.slice().sort((a, b) => a - b), 50),
        held_pct_helped: 100 * hi.filter(x => x > 0).length / hi.length, held_worst: Math.min(...hi), held_best: Math.max(...hi),
        held_extra_days_avg: sum(rows.map(r => r.extra_days)) / rows.length, held_capital_cost: capSum,
        held_incremental_after_capital: sum(hi) - capSum,
        held_worst_mtm_after_a_exit: wa.length ? Math.min(...wa) : null, held_rows: rows,
      });
    }
    return out;
  }

  function splitMetrics(results, frac) {
    frac = frac == null ? 0.6 : frac;
    const traded = results.filter(r => r.status === 'traded').sort((a, b) => (a.entry_date < b.entry_date ? -1 : a.entry_date > b.entry_date ? 1 : 0));
    if (traded.length < 4) return null;
    const dates = [...new Set(traded.map(r => r.entry_date))].sort();
    const cut = dates[Math.min(dates.length - 1, Math.floor(dates.length * frac))];
    return { split_date: cut, early: metrics(traded.filter(r => r.entry_date < cut)), late: metrics(traded.filter(r => r.entry_date >= cut)) };
  }

  // ------------------------------------------------------------------ experiments
  const SWEEPS = {
    ratio: ['Long-to-short ratio (4 short lots per side)', RATIOS.map(r => ({ short_call_lots: 4, short_put_lots: 4, long_call_lots: ratioLots(4, r), long_put_lots: ratioLots(4, r) })).concat([{}])],
    short_pct: ['Short strike distance %', [3.0, 4.0, 5.0, 6.0, 7.0, 8.0].map(v => ({ short_call_pct: v, short_put_pct: v }))],
    target: ['Target % of initial margin', [0.0, 5.0, 10.0, 15.0, 20.0].map(v => ({ target_pct_margin: v }))],
    a_exit: ['Policy A exit, days before expiry', [3, 5, 7, 10, 14].map(v => ({ a_exit_dte: v }))],
    slippage: ['Slippage % of price (quotes off)', [0.5, 1.0, 1.5, 2.0, 3.0, 5.0].map(v => ({ use_quotes: false, slip_pct: v }))],
    wing: ['Wing width ₹ (the spec fixes ₹50; for context only)', [20.0, 50.0, 100.0].map(v => ({ wing_width: v }))],
  };
  const SWEEP_KEYS = ['traded', 'net_pnl', 'avg_net', 'pct_target', 'total_roim_pct', 'max_drawdown', 'max_adverse_mtm', 'win_rate'];
  function sweepLabel(name, ov) {
    if (!Object.keys(ov).length) return 'Baseline 3 short / 5 long (1.67×)';
    if (name === 'ratio') return `${ov.short_call_lots} short / ${ov.long_call_lots} long (${(ov.long_call_lots / ov.short_call_lots).toFixed(2)}×)`;
    return Object.entries(ov).map(([k, v]) => `${k}=${v}`).join(', ');
  }
  function sweep(datasets, name, baseOverrides) {
    const [title, variants] = SWEEPS[name];
    const rows = variants.map(ov => {
      const out = run(datasets, makeConfig(Object.assign({}, baseOverrides || {}, ov)));
      const row = { overrides: ov, label: sweepLabel(name, ov) };
      for (const pol of ['A', 'B']) { row[pol] = {}; for (const k of SWEEP_KEYS) row[pol][k] = out.metrics[pol][k] == null ? null : out.metrics[pol][k]; }
      return row;
    });
    return { name, title, rows, configs_tested: variants.length };
  }

  // ------------------------------------------------------------------ CSV import (browser)
  const ALIASES = {
    traddt: 'date', tckrsymb: 'symbol', xprydt: 'expiry', strkpric: 'strike', optntp: 'option_type', opnpric: 'open', hghpric: 'high',
    lwpric: 'low', clspric: 'close', sttlmpric: 'settle', opnintrst: 'oi', ttltradgvol: 'volume', newbrdlotqty: 'lot_size',
    undrlygpric: 'underlying', fininstrmtp: 'instrument', timestamp: 'date', expiry_dt: 'expiry', strike_pr: 'strike', option_typ: 'option_type',
    settle_pr: 'settle', open_int: 'oi', contracts: 'volume', trade_date: 'date', lot: 'lot_size', lotsize: 'lot_size', type: 'option_type', settle_price: 'settle',
  };
  const MON = { JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06', JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12' };
  function pDate(s) {
    s = (s || '').trim();
    let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (m) return s;
    m = s.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
    if (m && MON[m[2].toUpperCase()]) return `${m[3]}-${MON[m[2].toUpperCase()]}-${m[1].padStart(2, '0')}`;
    return null;
  }
  function normRows(text) {
    const { header, rows } = parseCSV(text);
    const map = {};
    header.forEach(h => { const a = ALIASES[h]; map[h] = a && !header.includes(a) ? a : h; });
    return { cols: header.map(h => map[h]), rows: rows.map(r => { const o = {}; for (const h of header) o[map[h]] = r[h]; return o; }) };
  }
  const num = s => { if (s == null || String(s).trim() === '') return null; const v = Number(s); return isFinite(v) ? v : null; };

  function loadCSV(optionsText, underlyingText, marginText, symbol) {
    const rep = { errors: [], warnings: [], symbols: {} };
    const O = normRows(optionsText);
    if (!O.cols.includes('symbol') && !symbol) rep.errors.push('options: no symbol column; choose a symbol');
    const need = ['date', 'expiry', 'strike', 'option_type', 'close', 'lot_size'].filter(c => !O.cols.includes(c));
    if (need.length) rep.errors.push('options: missing columns ' + need.join(', '));
    if (rep.errors.length) return { datasets: [], report: rep };
    let notOpt = 0, bad = 0, incons = 0, late = 0, dup = 0, crossed = 0;
    const seen = new Set(), rows = [];
    for (const r of O.rows) {
      if ('instrument' in r && !['OPTSTK', 'STO'].includes(String(r.instrument).trim().toUpperCase())) { notOpt++; continue; }
      const sym = String(r.symbol != null ? r.symbol : symbol).trim().toUpperCase();
      const d = pDate(r.date), ex = pDate(r.expiry), k = num(r.strike), lot = num(r.lot_size), c = num(r.close);
      let cp = String(r.option_type || '').trim().toUpperCase();
      cp = { CALL: 'CE', PUT: 'PE', C: 'CE', P: 'PE' }[cp] || cp;
      if (!d || !ex || k == null || !['CE', 'PE'].includes(cp) || lot == null || lot <= 0 || c == null || c <= 0) { bad++; continue; }
      const o = num(r.open) != null ? num(r.open) : c, h = num(r.high) != null ? num(r.high) : c, l = num(r.low) != null ? num(r.low) : c;
      if (h < Math.max(o, c) || l > Math.min(o, c) || l <= 0) { incons++; continue; }
      if (d > ex) { late++; continue; }
      const key = [d, sym, ex, k, cp].join('|');
      if (seen.has(key)) { dup++; continue; }
      seen.add(key);
      let bid = num(r.bid), ask = num(r.ask);
      if (bid != null && ask != null && bid > ask) { crossed++; bid = ask = null; }
      rows.push({ d, sym, ex, k, cp, o, h, l, c, lot, s: num(r.settle), bid, ask, vol: num(r.volume), oi: num(r.oi), und: num(r.underlying) });
    }
    if (notOpt) rep.warnings.push(`${notOpt} rows that are not stock options (instrument column) dropped`);
    if (bad) rep.warnings.push(`${bad} option rows with bad date/expiry/strike/type/lot/close dropped`);
    if (incons) rep.warnings.push(`${incons} option rows with inconsistent OHLC dropped`);
    if (late) rep.warnings.push(`${late} option rows dated after their expiry dropped`);
    if (dup) rep.warnings.push(`${dup} duplicate option rows dropped (first kept)`);
    if (crossed) rep.warnings.push(`${crossed} crossed quotes (bid > ask) blanked`);
    rep.option_rows_read = O.rows.length; rep.option_rows_kept = rows.length;
    // underlying
    const und = new Map();   // sym -> Map(date -> {o,h,l,c})
    if (underlyingText) {
      const U = normRows(underlyingText);
      const syms = [...new Set(rows.map(r => r.sym))];
      if (!U.cols.includes('symbol') && syms.length !== 1) { rep.errors.push('underlying: no symbol column but the options file has several symbols'); return { datasets: [], report: rep }; }
      if (!U.cols.includes('date') || !U.cols.includes('close')) { rep.errors.push('underlying: needs date and close columns'); return { datasets: [], report: rep }; }
      let ub = 0, ud = 0;
      for (const r of U.rows) {
        const sym = String(r.symbol != null ? r.symbol : syms[0]).trim().toUpperCase(), d = pDate(r.date), c = num(r.close);
        if (!d || c == null || c <= 0) { ub++; continue; }
        if (!und.has(sym)) und.set(sym, new Map());
        if (und.get(sym).has(d)) { ud++; continue; }
        und.get(sym).set(d, { o: num(r.open) != null ? num(r.open) : c, h: num(r.high) != null ? num(r.high) : c, l: num(r.low) != null ? num(r.low) : c, c });
      }
      if (ub) rep.warnings.push(`underlying: ${ub} rows with bad date/close dropped`);
      if (ud) rep.warnings.push(`underlying: ${ud} duplicate rows dropped`);
    } else if (O.cols.includes('underlying')) {
      for (const r of rows) if (r.und != null) {
        if (!und.has(r.sym)) und.set(r.sym, new Map());
        if (!und.get(r.sym).has(r.d)) und.get(r.sym).set(r.d, { o: r.und, h: r.und, l: r.und, c: r.und });
      }
      rep.warnings.push("underlying taken from the options file's underlying column (close only)");
    } else { rep.errors.push('no underlying prices: give an underlying CSV or an `underlying` column in the options file'); return { datasets: [], report: rep }; }
    const marg = {};
    if (marginText) {
      const M = normRows(marginText);
      if (!['date', 'symbol', 'margin'].every(c => M.cols.includes(c))) { rep.errors.push('margin CSV needs date, symbol, margin columns'); return { datasets: [], report: rep }; }
      let mb = 0;
      for (const r of M.rows) {
        const d = pDate(r.date), v = num(r.margin), sym = String(r.symbol || '').trim().toUpperCase();
        if (!d || v == null || v <= 0) { mb++; continue; }
        (marg[sym] || (marg[sym] = {}))[d] = v;
      }
      if (mb) rep.warnings.push(`margin: ${mb} rows with bad date/margin dropped`);
    }
    const datasets = [];
    for (const sym of [...und.keys()].sort()) {
      const rs = rows.filter(r => r.sym === sym);
      if (!rs.length) { rep.warnings.push(`${sym}: underlying rows but no option rows; skipped`); continue; }
      const um = und.get(sym), dates = [...um.keys()].sort(), pos = new Map(dates.map((d, i) => [d, i])), n = dates.length;
      const U = { o: dates.map(d => um.get(d).o), h: dates.map(d => um.get(d).h), l: dates.map(d => um.get(d).l), c: dates.map(d => um.get(d).c) };
      const chains = {}, lotCount = {};
      let orphan = 0;
      const hasQ = rs.some(r => r.bid != null), hasV = O.cols.includes('volume');
      const dateHasOpt = new Set();
      for (const r of rs) {
        const i = pos.get(r.d);
        if (i == null) { orphan++; continue; }
        dateHasOpt.add(r.d);
        const ch = chains[r.ex] || (chains[r.ex] = { lot: nulls(n), strikes: { CE: [], PE: [] }, con: {} });
        const lk = r.ex + '|' + i;
        (lotCount[lk] || (lotCount[lk] = {}))[r.lot] = ((lotCount[lk] || {})[r.lot] || 0) + 1;
        const key = ckey(r.cp, r.k);
        let x = ch.con[key];
        if (!x) { x = ch.con[key] = {}; for (const f of FIELDS) x[f] = nulls(n); ch.strikes[r.cp].push(r.k); }
        x.o[i] = r.o; x.h[i] = r.h; x.l[i] = r.l; x.c[i] = r.c; x.s[i] = r.s;
        if (r.bid != null && r.ask != null) { x.bid[i] = r.bid; x.ask[i] = r.ask; }
        x.vol[i] = r.vol; x.oi[i] = r.oi;
      }
      if (orphan) rep.warnings.push(`${sym}: ${orphan} option rows on dates without an underlying price dropped`);
      const lotNotes = [];
      for (const [lk, cnt] of Object.entries(lotCount)) {
        const [ex, i] = lk.split('|'), vals = Object.keys(cnt).map(Number);
        if (vals.length > 1) rep.warnings.push(`${sym} ${dates[+i]} expiry ${ex}: several lot sizes ${vals.join(', ')}; using the most common`);
        chains[ex].lot[+i] = vals.sort((a, b) => cnt[b] - cnt[a] || a - b)[0];
      }
      for (const [ex, ch] of Object.entries(chains)) {
        ch.strikes.CE.sort((a, b) => a - b); ch.strikes.PE.sort((a, b) => a - b);
        const ls = [...new Set(ch.lot.filter(x => x != null))].sort((a, b) => a - b);
        if (ls.length > 1) lotNotes.push(`expiry ${ex}: lot size changed ${ls.join(' → ')} (corporate action?)`);
      }
      const exps = Object.keys(chains).sort();
      rep.symbols[sym] = { dates: n, first: dates[0], last: dates[n - 1], expiries: exps.length,
        contracts: sum(Object.values(chains).map(c => Object.keys(c.con).length)),
        lot_sizes: [...new Set(Object.values(chains).flatMap(c => c.lot.filter(x => x != null)))].sort((a, b) => a - b),
        lot_notes: lotNotes, dates_without_options: dates.filter(d => !dateHasOpt.has(d)).length,
        margin_rows: Object.keys(marg[sym] || {}).length, has_quotes: hasQ, has_volume: hasV };
      datasets.push({ symbol: sym, source: 'csv', label: '', dates, und: U, expiries: exps, chains, margin: marginText ? (marg[sym] || {}) : null });
    }
    rep.n_symbols = datasets.length;
    return { datasets, report: rep };
  }
  function toCSV(datasets) {
    const u = ['date,symbol,open,high,low,close'], o = ['date,symbol,expiry,strike,option_type,open,high,low,close,settle,lot_size,bid,ask,volume,oi'];
    const f = v => (v == null ? '' : v);
    for (const ds of datasets) {
      ds.dates.forEach((d, i) => { if (ds.und.c[i] != null) u.push([d, ds.symbol, ds.und.o[i], ds.und.h[i], ds.und.l[i], ds.und.c[i]].join(',')); });
      for (const ex of ds.expiries) {
        const ch = ds.chains[ex];
        for (const [key, x] of Object.entries(ch.con)) {
          const [cp, k] = key.split(':');
          ds.dates.forEach((d, i) => { if (x.c[i] != null) o.push([d, ds.symbol, ex, k, cp, x.o[i], x.h[i], x.l[i], x.c[i], f(x.s[i]), ch.lot[i], f(x.bid[i]), f(x.ask[i]), f(x.vol[i]), f(x.oi[i])].join(',')); });
        }
      }
    }
    return { underlying: u.join('\n') + '\n', options: o.join('\n') + '\n' };
  }

  return { DEFAULTS, ENUMS, LEGS, RATIOS, makeConfig, ratioLots, SYMBOLS, SYN_BASE, SCENARIOS, generate, syntheticUniverse, scenarioDataset,
    monthlyExpiries, cycles, buildEntry, simulateCycle, run, marginAt, modelMargin, impliedVol, netItmShares, payoff, payoffMtm, breakevens,
    structureSummary, metrics, compare, splitMetrics, SWEEPS, sweep, sweepLabel, loadCSV, toCSV, daysBetween, ckey, kstr, sellPx, buyPx, legPrice };
});
