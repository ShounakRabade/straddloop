/* Straddloop leg engine: every options strategy as a list of legs sharing one execution and accounting path.
 *
 * Contract: docs/ENGINE_INTERFACES.md (StrategySpec, DatasetCaps, Gate, DayResult, PositionRecord).
 * Pure calculations, no DOM. Runs in the Lab worker (importScripts) and in Node (require).
 *
 * Fill model (identical to the straddle engine, so the two agree fill for fill on the same rules):
 *  - decisions use completed bars only; an order fills at the open of the next bar;
 *  - without quotes: sell = open x (1 - slip%) - ticks, buy = open x (1 + slip%) + ticks, rounded to the tick
 *    against you; with bid/ask (synthetic model only): sell at bid, buy at ask;
 *  - a short leg's stop triggers on the bar high, a long leg's on the bar low, including the entry bar, and fills
 *    gap-aware (worse of stop and open) with stop_slip_mult x slippage; stop beats target in the same bar;
 *  - position targets and stops are checked at bar close and filled at the next bar's open;
 *  - expiry settlement is cash at intrinsic value against the index close of the last bar of expiry day.
 * Charges come from the ledger's dated tables (L.chargesFor / L.settlementCharges), so the engine's cost lines and
 * the ledger reconcile exactly.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.StraddloopLegs = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const OPEN = 555, CLOSE = 930, TICK = 0.05;
  const RIGHTS = ['CE', 'PE'], ACTIONS = ['BUY', 'SELL'], SERIES = ['WEEK', 'MONTH'];
  const STRIKE_BY = ['atm', 'pct', 'premium', 'delta', 'leg'];
  const HOLDS = ['intraday', 'sessions', 'expiry'];
  const ON_STOP = ['keep_others', 'close_all', 'reenter'];
  const CONDITIONS = ['or_inside', 'or_width_pct', 'gap_pct', 'move_pct', 'net_premium'];

  const EXECUTION_DEFAULTS = { slip_pct: 0.5, slip_ticks: 1, stop_slip_mult: 2, stop_fill: 'gap_aware', brokerage_per_order: 20, exercise_stt_pct: 0.125 };

  // ------------------------------------------------------------------ small helpers
  const hm = s => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(s)); return m ? (+m[1]) * 60 + (+m[2]) : NaN; };
  const fmt = m => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(Math.round(m % 60)).padStart(2, '0');
  const r2 = x => Math.round(x * 100 + (x >= 0 ? 1e-9 : -1e-9)) / 100;
  const roundDown = (px, tick) => r2(Math.floor(px / tick + 1e-9) * tick);
  const roundUp = (px, tick) => r2(Math.ceil(px / tick - 1e-9) * tick);
  const dayDiff = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
  const weekday = d => (new Date(d + 'T00:00:00Z').getUTCDay() + 6) % 7;
  const intrinsic = (right, S, K) => (right === 'CE' ? Math.max(0, S - K) : Math.max(0, K - S));
  const dirOf = action => (action === 'BUY' ? 1 : -1);
  function hashStr(s) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return h.toString(16).padStart(8, '0');
  }
  function stable(v) {
    if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
    if (v && typeof v === 'object') return '{' + Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
    return JSON.stringify(v);
  }

  // Black-Scholes (r = 0), used only for delta on datasets with reliable Greeks (the synthetic model).
  function ncdf(x) {
    const s = x >= 0 ? 1 : -1, z = Math.abs(x) / Math.SQRT2, t = 1 / (1 + 0.3275911 * z);
    const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
    return 0.5 * (1 + s * y);
  }
  function bsPrice(right, S, K, t, vol) {
    if (t <= 1e-9 || vol <= 0) return intrinsic(right, S, K);
    const sd = vol * Math.sqrt(t), d1 = (Math.log(S / K) + 0.5 * sd * sd) / sd, d2 = d1 - sd;
    return right === 'CE' ? S * ncdf(d1) - K * ncdf(d2) : K * ncdf(-d2) - S * ncdf(-d1);
  }
  function impliedVol(right, price, S, K, t) {
    if (!(price > intrinsic(right, S, K)) || t <= 0) return null;
    let lo = 0.001, hi = 5;
    for (let k = 0; k < 80; k++) { const mid = (lo + hi) / 2; if (bsPrice(right, S, K, t, mid) > price) hi = mid; else lo = mid; }
    return (lo + hi) / 2;
  }
  function bsDelta(right, S, K, t, vol) {
    if (t <= 1e-9 || vol <= 0) return right === 'CE' ? (S > K ? 1 : 0) : (S < K ? -1 : 0);
    const d1 = (Math.log(S / K) + 0.5 * vol * vol * t) / (vol * Math.sqrt(t));
    return right === 'CE' ? ncdf(d1) : ncdf(d1) - 1;
  }

  // ------------------------------------------------------------------ spec normalisation and gating
  function normalize(spec0) {
    const spec = JSON.parse(JSON.stringify(spec0 || {}));
    spec.v = spec.v || 1;
    spec.underlying = spec.underlying || 'NIFTY';
    spec.lots = spec.lots == null ? 1 : spec.lots;
    spec.legs = Array.isArray(spec.legs) ? spec.legs : [];
    spec.legs.forEach((l, i) => { l.id = l.id || 'L' + (i + 1); l.ratio = l.ratio == null ? 1 : l.ratio; l.expiry = Object.assign({ series: 'WEEK', nth: 1 }, l.expiry || {}); });
    spec.entry = Object.assign({ time: '09:20', weekdays: [0, 1, 2, 3, 4], conditions: [] }, spec.entry || {});
    spec.exit = Object.assign({ hold: 'intraday', time: '15:15', settle_at_expiry: true, basis: 'net' }, spec.exit || {});
    spec.adjust = Object.assign({ on_leg_stop: 'keep_others', max_reentries: 0, cutoff: '14:30' }, spec.adjust || {});
    spec.execution = Object.assign({}, EXECUTION_DEFAULTS, spec.execution || {});
    return spec;
  }

  const gate = (code, message, leg) => (leg ? { code, message, leg } : { code, message });

  /** Structural checks and data-capability gates (docs/ENGINE_INTERFACES.md §1, Gating). */
  function validate(spec0, caps) {
    const spec = normalize(spec0), errors = [], warnings = [];
    const bad = m => errors.push(gate('INVALID_SPEC', m));
    if (spec.v !== 1) bad('Unsupported spec version ' + spec.v + '.');
    if (!spec.legs.length) bad('Add at least one leg.');
    if (spec.legs.length > 6) bad('At most six legs.');
    if (!(Number.isInteger(spec.lots) && spec.lots >= 1 && spec.lots <= 100)) bad('Lots must be a whole number from 1 to 100.');
    const ids = new Set();
    spec.legs.forEach((l, i) => {
      const at = `Leg ${l.id}`;
      if (ids.has(l.id)) bad(`${at}: the id is used twice.`);
      ids.add(l.id);
      if (!ACTIONS.includes(l.action)) bad(`${at}: action must be BUY or SELL.`);
      if (!RIGHTS.includes(l.right)) bad(`${at}: right must be CE or PE.`);
      if (!(Number.isInteger(l.ratio) && l.ratio >= 1 && l.ratio <= 10)) bad(`${at}: ratio must be a whole number from 1 to 10.`);
      if (!SERIES.includes(l.expiry.series) || ![1, 2].includes(l.expiry.nth)) bad(`${at}: expiry must be WEEK or MONTH, nearest (1) or next (2).`);
      const s = l.strike || {};
      if (!STRIKE_BY.includes(s.by)) bad(`${at}: strike rule must be one of ${STRIKE_BY.join(', ')}.`);
      else if (s.by === 'atm' && !Number.isInteger(s.steps)) bad(`${at}: ATM offset must be a whole number of strikes.`);
      else if (s.by === 'pct' && !(isFinite(s.pct) && Math.abs(s.pct) <= 20)) bad(`${at}: % from ATM must be between -20 and 20.`);
      else if (s.by === 'premium' && !(s.price > 0 && ['nearest', 'at_most', 'at_least'].includes(s.side || 'nearest'))) bad(`${at}: premium target must be a positive price.`);
      else if (s.by === 'delta' && !(s.delta > 0 && s.delta < 1)) bad(`${at}: delta must be between 0 and 1 (absolute).`);
      else if (s.by === 'leg') {
        const j = spec.legs.findIndex(x => x.id === s.leg);
        if (j < 0 || j >= i) bad(`${at}: a leg-relative strike must refer to an earlier leg.`);
        if (!Number.isInteger(s.steps)) bad(`${at}: the strike offset from leg ${s.leg} must be a whole number of strikes.`);
      }
      for (const k of ['stop', 'target']) if (l[k] && !(['pct', 'points'].includes(l[k].kind) && l[k].value > 0)) bad(`${at}: ${k} must be a positive % or points.`);
      if (l.stop && l.stop.kind === 'pct' && l.action === 'BUY' && l.stop.value >= 100) bad(`${at}: a long leg's stop must be below 100% of its premium.`);
      if (l.target && l.target.kind === 'pct' && l.action === 'SELL' && l.target.value >= 100) bad(`${at}: a short leg's target must be below 100% of its premium.`);
    });
    const et = hm(spec.entry.time), xt = hm(spec.exit.time), cut = hm(spec.adjust.cutoff);
    if (!(et >= OPEN + 1 && et <= CLOSE - 2)) bad('Entry time must be between 09:16 and 15:28.');
    if (!(xt > OPEN && xt <= CLOSE - 1)) bad('Exit time must be between 09:16 and 15:29.');
    if (spec.exit.hold === 'intraday' && !(xt > et)) bad('For an intraday hold the exit time must be after the entry time.');
    if (!isFinite(cut)) bad('Cutoff must be a time (HH:MM).');
    if (!Array.isArray(spec.entry.weekdays) || !spec.entry.weekdays.length || spec.entry.weekdays.some(d => ![0, 1, 2, 3, 4].includes(d))) bad('Pick at least one weekday (Monday to Friday).');
    if (spec.entry.dte && ((spec.entry.dte.min != null && spec.entry.dte.min < 0) || (spec.entry.dte.max != null && spec.entry.dte.min != null && spec.entry.dte.max < spec.entry.dte.min))) bad('Days-to-expiry filter: min must be ≥ 0 and ≤ max.');
    for (const c of spec.entry.conditions || []) {
      if (!CONDITIONS.includes(c.kind)) { bad(`Unknown entry condition ${c.kind}.`); continue; }
      if (c.kind === 'or_inside') {
        const orm = c.or_minutes || 30, cm = c.candle_minutes || 5;
        if (orm % cm || orm <= 0 || cm <= 0) bad('Opening range minutes must be a multiple of the candle minutes.');
        else if (et - cm < OPEN + orm) bad(`The opening-range check needs the entry at or after ${fmt(OPEN + orm + cm)}.`);
        if (c.mode && !['full', 'body', 'close', 'overlap'].includes(c.mode)) bad('Opening-range mode must be full, body, close or overlap.');
      } else if (c.kind === 'or_width_pct') {
        // the whole opening range must have closed before the decision bar, or the filter would read the future
        const orm = c.or_minutes || 30, cm = c.candle_minutes || 5;
        if (orm % cm || orm <= 0 || cm <= 0) bad('Opening range minutes must be a multiple of the candle minutes.');
        else if (et < OPEN + orm) bad(`The opening-range width needs the entry at or after ${fmt(OPEN + orm)}.`);
      }
    }
    if (!HOLDS.includes(spec.exit.hold)) bad('Hold must be intraday, sessions or expiry.');
    if (spec.exit.hold === 'sessions' && !(Number.isInteger(spec.exit.sessions) && spec.exit.sessions >= 1)) bad('Hold for at least one session.');
    if (!['net', 'gross'].includes(spec.exit.basis)) bad('Exit basis must be net or gross.');
    for (const k of ['stop', 'target']) {
      const v = spec.exit[k];
      if (v && !(['rupees_per_lot', 'pct_premium'].includes(v.kind) && v.value > 0)) bad(`Position ${k} must be a positive ₹ per lot or % of premium.`);
    }
    if (!ON_STOP.includes(spec.adjust.on_leg_stop)) bad('On a leg stop: keep the others, close all, or re-enter.');
    if (spec.adjust.on_leg_stop === 'reenter' && !(Number.isInteger(spec.adjust.max_reentries) && spec.adjust.max_reentries >= 1 && spec.adjust.max_reentries <= 5)) bad('Re-entries must be 1 to 5.');
    if (spec.adjust.on_leg_stop !== 'keep_others' && !spec.legs.some(l => l.stop)) warnings.push(gate('INVALID_SPEC', 'An adjustment on leg stop is set but no leg has a stop; it will never fire.'));
    const ex = spec.execution;
    for (const k of ['slip_pct', 'slip_ticks', 'stop_slip_mult', 'brokerage_per_order', 'exercise_stt_pct']) if (!(isFinite(ex[k]) && ex[k] >= 0)) bad(`Execution: ${k} must be a number ≥ 0.`);
    if (!['gap_aware', 'trigger'].includes(ex.stop_fill)) bad('Stop fill must be gap_aware or trigger.');

    if (caps) {
      if (caps.underlying && spec.underlying !== caps.underlying) errors.push(gate('UNDERLYING_NOT_STORED', `${spec.underlying} has no stored data; only ${caps.underlying} does.`));
      for (const l of spec.legs) {
        if (caps.series && !caps.series.includes(l.expiry.series)) errors.push(gate('SERIES_NOT_STORED', `Leg ${l.id} needs ${l.expiry.series === 'WEEK' ? 'weekly' : 'monthly'} expiry data, and none is loaded for these dates.`, l.id));
        if (caps.nth && !caps.nth.includes(l.expiry.nth)) errors.push(gate('NEXT_EXPIRY_NOT_STORED', `Leg ${l.id} needs the expiry after the nearest one. Only the nearest expiry is stored, so calendars and diagonals cannot run on this data.`, l.id));
        const s = l.strike || {};
        if (s.by === 'delta' && !caps.greeks) errors.push(gate('DELTA_NO_GREEKS', `Leg ${l.id} picks its strike by delta, but this data has no reliable Greeks (Dhan candles carry an IV field that has not been validated). Use an ATM offset, % from ATM or premium instead.`, l.id));
        const w = caps.strike_window;
        if (w != null) {
          const off = effectiveOffset(spec, l);
          if (off != null && Math.abs(off) > w) errors.push(gate('STRIKE_OUTSIDE_WINDOW', `Leg ${l.id} is ${Math.abs(off)} strikes from ATM; only ATM ± ${w} is stored.`, l.id));
          else if (off == null && s.by !== 'delta') warnings.push(gate('STRIKE_OUTSIDE_WINDOW', `Leg ${l.id} can land outside the stored ATM ± ${w} strikes; days where it does are skipped and listed.`, l.id));
        }
      }
      if (spec.exit.hold !== 'intraday' && caps.continuous === false) errors.push(gate('HOLD_NEEDS_CONTINUOUS', 'The synthetic model makes each day independently, so a position cannot be carried overnight. Use an intraday hold, or real data.'));
      if (caps.bid_ask === false) warnings.push(gate('NO_BID_ASK', 'No bid/ask history: fills are candle prices plus slippage, so results are optimistic.'));
      if (spec.exit.hold !== 'intraday' && caps.expiry_assumed) warnings.push(gate('EXPIRY_ASSUMED', 'Expiry dates in the stored data are assumed (weekday rule, holidays not applied) until the NSE bhavcopy is imported; holding to expiry depends on them.'));
    }
    const expiries = new Set(spec.legs.map(l => l.expiry.series + l.expiry.nth));
    if (expiries.size > 1 && spec.exit.hold === 'expiry' && spec.exit.settle_at_expiry) warnings.push(gate('MIXED_EXPIRY_SETTLEMENT', 'Legs have different expiries: the nearest settles at expiry and the others are sold at the exit time that day.'));
    return { ok: errors.length === 0, errors, warnings, spec };
  }

  /** Strikes from ATM a leg will be at, when that is known before seeing data (ATM offsets and chains of them). */
  function effectiveOffset(spec, leg, depth) {
    depth = depth || 0;
    const s = leg.strike || {};
    if (s.by === 'atm') return leg.right === 'CE' ? s.steps : -s.steps; // in strike steps above ATM
    if (s.by === 'leg' && depth < 6) {
      const base = spec.legs.find(x => x.id === s.leg);
      const b = base ? effectiveOffset(spec, base, depth + 1) : null;
      return b == null ? null : b + s.steps;
    }
    return null;
  }

  /** What a set of sessions can support (DatasetCaps). */
  function capsOf(sessions) {
    const real = sessions.some(s => s.source && s.source !== 'synthetic');
    const series = new Set(), nth = new Set([1]);
    let window = 0, assumed = false;
    for (const s of sessions) {
      for (const ex of s.expiries) {
        series.add(ex.series || 'WEEK');
        const ks = [...new Set(Object.keys(ex.contracts).map(k => +k.split(':')[1]))].sort((a, b) => a - b);
        if (ks.length > 1) window = Math.max(window, Math.floor((ks.length - 1) / 2));
      }
      const byS = {};
      for (const ex of s.expiries) { const k = ex.series || 'WEEK'; byS[k] = (byS[k] || 0) + 1; }
      if (Object.values(byS).some(n => n > 1)) nth.add(2);
      if (s.meta && /^assumed/.test(s.meta.expiry_source || '')) assumed = true;
    }
    const sym = sessions[0] ? sessions[0].symbol : 'NIFTY';
    return { source: real ? 'dhan' : 'synthetic', underlying: sym, series: [...series].sort(), nth: [...nth].sort(), strike_window: real ? Math.min(window, 10) : window,
      greeks: !real, bid_ask: sessions.some(s => s.expiries.some(ex => Object.values(ex.contracts).some(c => c.bid && c.bid.some(v => v != null)))),
      continuous: real, expiry_assumed: assumed };
  }

  // ------------------------------------------------------------------ prices
  function sellPx(con, i, ex) {
    const o = con.o[i];
    if (o == null) return null;
    const bid = con.bid ? con.bid[i] : null;
    const px = bid != null ? bid : o * (1 - ex.slip_pct / 100) - ex.slip_ticks * TICK;
    return Math.max(TICK, roundDown(px, TICK));
  }
  function buyPx(con, i, ex) {
    const o = con.o[i];
    if (o == null) return null;
    const ask = con.ask ? con.ask[i] : null, bid = con.bid ? con.bid[i] : null;
    const px = ask != null && bid != null ? ask : o * (1 + ex.slip_pct / 100) + ex.slip_ticks * TICK;
    return roundUp(px, TICK);
  }
  /** Fill for a stop: base is the worse of stop and open (gap-aware) or the stop itself (trigger). */
  function stopPx(con, i, ex, base, dir) {
    const m = ex.stop_slip_mult, bid = con.bid ? con.bid[i] : null, ask = con.ask ? con.ask[i] : null, quotes = bid != null && ask != null;
    if (dir < 0) { // short leg: buy back
      const px = quotes ? base + (ask - bid) / 2 * m : base * (1 + ex.slip_pct / 100 * m) + ex.slip_ticks * TICK * m;
      return roundUp(px, TICK);
    }
    const px = quotes ? base - (ask - bid) / 2 * m : base * (1 - ex.slip_pct / 100 * m) - ex.slip_ticks * TICK * m;
    return Math.max(TICK, roundDown(px, TICK));
  }

  // ------------------------------------------------------------------ payoff at expiry
  /** legs: [{ action, right, strike, qty, entry_px }]. Rupee P&L at expiry for index level S. */
  function payoffAt(legs, S) {
    let v = 0;
    for (const l of legs) v += dirOf(l.action) * (intrinsic(l.right, S, l.strike) - l.entry_px) * l.qty;
    return v;
  }
  /** Max profit, max loss (null = unbounded) and breakevens of a single-expiry position at expiry. */
  function payoff(legs) {
    if (!legs.length) return null;
    const ks = [...new Set(legs.map(l => l.strike))].sort((a, b) => a - b);
    const pts = [0].concat(ks);
    const vals = pts.map(S => payoffAt(legs, S));
    // slope beyond the highest strike: calls only
    let slopeUp = 0;
    for (const l of legs) if (l.right === 'CE') slopeUp += dirOf(l.action) * l.qty;
    const hi = ks[ks.length - 1];
    const maxV = Math.max(...vals), minV = Math.min(...vals);
    const max_profit = slopeUp > 0 ? null : maxV, max_loss = slopeUp < 0 ? null : minV;
    const breakevens = [];
    for (let j = 0; j + 1 < pts.length; j++) {
      const a = vals[j], b = vals[j + 1];
      if (a === 0 && (j === 0 || vals[j - 1] !== 0)) { if (pts[j] > 0) breakevens.push(pts[j]); }
      else if ((a < 0 && b > 0) || (a > 0 && b < 0)) breakevens.push(r2(pts[j] + (pts[j + 1] - pts[j]) * (-a) / (b - a)));
    }
    const last = vals[vals.length - 1];
    if (last === 0 && vals.length > 1 && vals[vals.length - 2] !== 0) breakevens.push(hi);
    if (slopeUp !== 0 && ((last < 0 && slopeUp > 0) || (last > 0 && slopeUp < 0))) breakevens.push(r2(hi - last / slopeUp));
    return { max_profit, max_loss, breakevens: [...new Set(breakevens)].sort((a, b) => a - b) };
  }

  // ------------------------------------------------------------------ strike selection
  function expiryFor(s, leg) {
    const list = s.expiries.filter(e => (e.series || 'WEEK') === leg.expiry.series && e.expiry >= s.date)
      .sort((a, b) => (a.expiry < b.expiry ? -1 : a.expiry > b.expiry ? 1 : 0));
    return list[leg.expiry.nth - 1] || null;
  }
  function gridOf(ex, i) {
    return [...new Set(Object.keys(ex.contracts).filter(k => ex.contracts[k].c[i] != null).map(k => +k.split(':')[1]))].sort((a, b) => a - b);
  }
  function stepOf(ks) {
    let st = Infinity;
    for (let j = 1; j < ks.length; j++) st = Math.min(st, ks[j] - ks[j - 1]);
    return st;
  }
  /** Nearest listed strike to spot (ties: the lower strike), the strike step, and the grid, at bar i (a completed bar). */
  function atmOf(ex, i, spot) {
    const ks = gridOf(ex, i);
    if (!ks.length) return null;
    let atm = ks[0];
    for (const k of ks) if (Math.abs(k - spot) < Math.abs(atm - spot)) atm = k;
    return { atm, step: stepOf(ks), ks };
  }
  /** Picks every leg's strike at decision bar i (closes of bar i are known). Returns { legs } or { why }.
   *  `known` gives strikes of legs not being selected now (a re-entry relative to a leg that is still open). */
  function selectStrikes(spec, s, i, spot, known) {
    const out = {};
    for (const leg of spec.legs) {
      const ex = expiryFor(s, leg);
      if (!ex) return { why: `no ${leg.expiry.series === 'WEEK' ? 'weekly' : 'monthly'} expiry${leg.expiry.nth === 2 ? ' after the nearest' : ''} in the data for leg ${leg.id}` };
      const g = atmOf(ex, i, spot);
      if (!g || !isFinite(g.step)) return { why: `no option prices at ${fmt(s.times[i])} for leg ${leg.id}` };
      const r = leg.strike;
      let K = null;
      if (r.by === 'atm') K = leg.right === 'CE' ? g.atm + r.steps * g.step : g.atm - r.steps * g.step;
      else if (r.by === 'pct') {
        // nearest listed strike to the target level; an exact half-step goes away from ATM (at least the distance asked)
        const target = leg.right === 'CE' ? spot * (1 + r.pct / 100) : spot * (1 - r.pct / 100), x = (target - g.atm) / g.step;
        K = g.atm + Math.sign(x) * Math.floor(Math.abs(x) + 0.5 + 1e-9) * g.step;
      }
      else if (r.by === 'leg') { const base = out[r.leg] || (known && known[r.leg]); if (!base) return { why: `leg ${leg.id} refers to leg ${r.leg}, which is not open` }; K = base.strike + r.steps * g.step; }
      else if (r.by === 'premium' || r.by === 'delta') {
        const cands = [];
        for (const k of g.ks) {
          const con = ex.contracts[leg.right + ':' + k];
          if (!con || con.c[i] == null) continue;
          let score;
          if (r.by === 'premium') score = con.c[i];
          else {
            const t = (dayDiff(s.date, ex.expiry) + Math.max(0, CLOSE - (s.times[i] + 1)) / 375) / 365;
            const mid = con.bid && con.ask && con.bid[i] != null && con.ask[i] != null ? (con.bid[i] + con.ask[i]) / 2 : con.c[i];
            const vol = impliedVol(leg.right, mid, spot, k, t);
            if (vol == null) continue;
            score = Math.abs(bsDelta(leg.right, spot, k, t, vol));
          }
          cands.push([k, score]);
        }
        const target = r.by === 'premium' ? r.price : r.delta, side = r.side || 'nearest';
        let pool = cands;
        if (r.by === 'premium' && side === 'at_most') pool = cands.filter(c => c[1] <= target + 1e-9);
        if (r.by === 'premium' && side === 'at_least') pool = cands.filter(c => c[1] >= target - 1e-9);
        if (!pool.length) return { why: `no ${leg.right} strike for leg ${leg.id} with ${r.by === 'premium' ? `premium ${side.replace('_', ' ')} ${target}` : `delta near ${target}`} in the stored window` };
        let best = pool[0];
        for (const c of pool) {
          const d = Math.abs(c[1] - target), bd = Math.abs(best[1] - target);
          if (d < bd - 1e-12 || (Math.abs(d - bd) <= 1e-12 && Math.abs(c[0] - g.atm) < Math.abs(best[0] - g.atm))) best = c;
        }
        K = best[0];
      }
      const key = leg.right + ':' + K, con = ex.contracts[key];
      if (!con) return { why: `leg ${leg.id} strike ${leg.right} ${K} is outside the stored strike window`, excluded: true };
      out[leg.id] = { leg, ex, strike: K, key, con, atm: g.atm, step: g.step };
    }
    return { legs: out };
  }

  // ------------------------------------------------------------------ entry conditions
  /** Candle over [from, from + minutes): null when any index minute is missing (listed in `missing`). */
  function candle(s, from, minutes) {
    const idx = [], missing = [];
    for (let t = from; t < from + minutes; t++) {
      const i = s.times.indexOf(t);
      if (i < 0 || s.und.o[i] == null) missing.push(fmt(t)); else idx.push(i);
    }
    if (missing.length) return { missing };
    return { o: s.und.o[idx[0]], h: Math.max(...idx.map(j => s.und.h[j])), l: Math.min(...idx.map(j => s.und.l[j])), c: s.und.c[idx[idx.length - 1]] };
  }
  function openingRange(s, orm, cm) {
    const cs = [];
    for (let t = OPEN; t < OPEN + orm; t += cm) { const c = candle(s, t, cm); if (c.missing) return { missing: c.missing }; cs.push(c); }
    return { h: Math.max(...cs.map(c => c.h)), l: Math.min(...cs.map(c => c.l)) };
  }
  const inside = (c, hi, lo, mode) => (mode === 'full' ? c.h <= hi && c.l >= lo : mode === 'body' ? Math.max(c.o, c.c) <= hi && Math.min(c.o, c.c) >= lo
    : mode === 'close' ? lo <= c.c && c.c <= hi : c.h >= lo && c.l <= hi);

  /** Checks the conditions that need only the index. Returns null (pass) or { status, reason }. */
  function checkIndexConditions(spec, s, prev, T, spot) {
    const firstOpen = s.und.o.find(x => x != null);
    for (const c of spec.entry.conditions || []) {
      if (c.kind === 'or_inside' || c.kind === 'or_width_pct') {
        const orm = c.or_minutes || 30, cm = c.candle_minutes || 5;
        const or = openingRange(s, orm, cm);
        if (or.missing) return { status: 'excluded', reason: `incomplete opening range: index bar${or.missing.length > 1 ? 's' : ''} ${or.missing.slice(0, 4).join(', ')} missing` };
        if (c.kind === 'or_inside') {
          const chk = candle(s, T - cm, cm);
          if (chk.missing) return { status: 'excluded', reason: `entry candle incomplete: index bar ${chk.missing[0]} missing` };
          const mode = c.mode || 'full';
          if (!inside(chk, or.h, or.l, mode)) return { status: 'no_entry', reason: `entry condition '${mode}' failed` };
        } else {
          const w = 100 * (or.h - or.l) / spot;
          if ((c.min != null && w < c.min) || (c.max != null && w > c.max)) return { status: 'filtered', reason: `opening-range width ${w.toFixed(2)}% outside the filter` };
        }
      } else if (c.kind === 'gap_pct') {
        const pc = prev ? [...prev.und.c].reverse().find(x => x != null) : null;
        if (pc == null || firstOpen == null) return { status: 'filtered', reason: 'gap filter needs the previous session, which is not in the range' };
        const g = 100 * (firstOpen / pc - 1);
        if ((c.min != null && g < c.min) || (c.max != null && g > c.max)) return { status: 'filtered', reason: `gap ${g.toFixed(2)}% outside the filter` };
      } else if (c.kind === 'move_pct') {
        const mv = 100 * (spot / firstOpen - 1);
        if ((c.min != null && mv < c.min) || (c.max != null && mv > c.max)) return { status: 'filtered', reason: `move since open ${mv.toFixed(2)}% outside the filter` };
      }
    }
    return null;
  }

  // ------------------------------------------------------------------ the run
  /**
   * Runs a spec over sessions (sorted by date). opts: { L: ledger module (charges), account: { exercise_stt_pct?, brokerage_per_order? } }.
   * Returns { results: DayResult[], positions: PositionRecord[], gates, config_hash, spec }.
   */
  function run(sessions0, spec0, opts) {
    opts = opts || {};
    const L = opts.L;
    if (!L || !L.chargesFor) throw new Error('legs.run needs the ledger module (opts.L) for dated charges');
    const sessions = sessions0.slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    const caps = opts.caps || capsOf(sessions);
    const v = validate(spec0, caps);
    if (!v.ok) { const e = new Error(v.errors.map(g => g.message).join(' ')); e.gates = v.errors.concat(v.warnings); throw e; }
    const spec = v.spec, ex = spec.execution;
    const config_hash = hashStr(stable(spec));
    const entryT = hm(spec.entry.time), exitT = hm(spec.exit.time), cutT = hm(spec.adjust.cutoff);
    const results = [], positions = [];
    let pos = null, posSeq = 0;
    const warnings = v.warnings.slice();

    const charges = (action, px, qty, date, settle, dir) => (settle ? L.settlementCharges(dir, px, qty, ex.exercise_stt_pct) : L.chargesFor(action, px, qty, date, ex.brokerage_per_order));

    for (let si = 0; si < sessions.length; si++) {
      const s = sessions[si], prev = si > 0 ? sessions[si - 1] : null, lastSession = si === sessions.length - 1;
      const res = { date: s.date, symbol: s.symbol, source: s.source || '?', strategy: 'legs', status: 'no_entry', reason: null, flags: [], fills: [], mtm: [], events: [], legs: [],
        carry: [], lot_size: s.expiries[0] ? s.expiries[0].lot_size : null, exit_reason: '' };
      const flags = new Set();
      const ev = (t, kind, text, extra) => res.events.push(Object.assign({ t, kind, text }, extra || {}));
      const times = s.times, n = times.length;
      const fill = (lg, t, action, px, reason, extra) => {
        const settle = !!(extra && extra.settlement);
        const c = charges(action, px, lg.qty, s.date, settle, lg.dir);
        const f = Object.assign({ t, leg: lg.id, position: lg.position, action, side: lg.right, strike: lg.strike, expiry: lg.expiry, qty: lg.qty, px, reason, intrabar: false,
          cost: c.total, costs: c, kind: lg.kind, spot: lg.spot, stop: lg.stop }, extra || {});
        res.fills.push(f);
        lg.cost += c.total;
        return f;
      };
      const closeLeg = (lg, t, px, reason, extra) => {
        fill(lg, t, lg.dir < 0 ? 'BUY' : 'SELL', px, reason, extra);
        Object.assign(lg, { open: false, exit_t: t, exit_date: s.date, exit_px: px, exit_reason: reason, last_px: px });
        ev(t, extra && extra.settlement ? 'settle' : 'exit', `${lg.dir < 0 ? 'BUY' : 'SELL'} ${lg.right} ${lg.strike} @ ${px.toFixed(2)} (${reason})`, { leg: lg.id });
      };

      // ---- a position carried from an earlier session: refresh contracts, check its data
      if (pos) {
        const gapDays = prev ? countWeekdaysBetween(prev.date, s.date) : 0;
        if (gapDays > 0) { flags.add('carried_over_missing_days'); pos.flags.add('carried_over_missing_days'); warnings.push(gate('DATA_GAP', `${pos.id} was held across ${gapDays} weekday(s) before ${s.date} with no stored data (a holiday, or not loaded); any stop on those days was not seen.`)); }
        for (const lg of pos.legs.filter(l => l.open)) {
          const e = s.expiries.find(x => x.expiry === lg.expiry);
          lg.con = e ? e.contracts[lg.right + ':' + lg.strike] || null : null;
        }
      }

      // ---- the entry decision
      let decided = null; // { status, reason } when no entry today
      let entryI = -1;
      if (!pos) {
        if (!spec.entry.weekdays.includes(weekday(s.date))) decided = { status: 'filtered', reason: 'weekday filter' };
        else {
          const ei = times.indexOf(entryT);
          if (ei <= 0 || times[ei - 1] !== entryT - 1 || s.und.c[ei - 1] == null) decided = { status: 'excluded', reason: `no index bar at ${fmt(entryT - 1)} to decide on` };
          else {
            const spot = s.und.c[ei - 1];
            decided = checkIndexConditions(spec, s, prev, entryT, spot);
            if (!decided) {
              const sel = selectStrikes(spec, s, ei - 1, spot);
              if (sel.why) decided = { status: sel.excluded ? 'excluded' : 'no_entry', reason: sel.why };
              else {
                const near = Object.values(sel.legs).map(x => x.ex.expiry).sort()[0];
                const dte = dayDiff(s.date, near);
                if (spec.entry.dte && ((spec.entry.dte.min != null && dte < spec.entry.dte.min) || (spec.entry.dte.max != null && dte > spec.entry.dte.max))) decided = { status: 'filtered', reason: `days to expiry ${dte} outside the filter` };
                else {
                  let netPts = 0;
                  for (const x of Object.values(sel.legs)) netPts += (x.leg.action === 'SELL' ? 1 : -1) * x.leg.ratio * x.con.c[ei - 1];
                  const np = (spec.entry.conditions || []).find(c => c.kind === 'net_premium');
                  if (np && ((np.min != null && netPts < np.min) || (np.max != null && netPts > np.max))) decided = { status: 'filtered', reason: `net premium ${netPts.toFixed(2)} outside the filter` };
                  else {
                    const missing = Object.values(sel.legs).filter(x => x.con.o[ei] == null);
                    if (missing.length) decided = { status: 'excluded', reason: `no price at ${fmt(entryT)} for ${missing.map(x => `${x.leg.right} ${x.strike}`).join(', ')}` };
                    else {
                      entryI = ei;
                      pos = openPosition(++posSeq, sel.legs, s, ei, spot, spec);
                    }
                  }
                }
              }
            }
          }
        }
      }

      function openPosition(seq, chosen, s, ei, spot, spec) {
        const p = { id: 'P' + seq, opened: { date: s.date, t: s.times[ei] }, closed: null, legs: [], flags: new Set(), reentries: {}, entry_session: si, spot,
          exit_reason: null, nearest: null };
        // hedges first: buys fill before sells at the same bar, so margin never sees a naked short that is meant to be covered
        const order = Object.values(chosen).sort((a, b) => (a.leg.action === b.leg.action ? 0 : a.leg.action === 'BUY' ? -1 : 1));
        for (const x of order) addLeg(p, x, s, ei, 'initial', spot);
        p.nearest = p.legs.map(l => l.expiry).sort()[0];
        p.entry_premium = p.legs.reduce((a, l) => a + (l.dir < 0 ? 1 : -1) * l.entry_px * l.ratio, 0);
        p.premium_rupees = p.legs.reduce((a, l) => a + (l.dir < 0 ? 1 : -1) * l.entry_px * l.qty, 0);
        positions.push(p);
        ev(s.times[ei], 'entry', `${p.id} opened: ${p.legs.map(l => `${l.action} ${l.ratio > 1 ? l.ratio + '× ' : ''}${l.right} ${l.strike} ${l.expiry} @ ${l.entry_px.toFixed(2)}`).join(', ')}`);
        return p;
      }
      function addLeg(p, x, s, i, kind, spot) {
        const leg = x.leg, dir = dirOf(leg.action), qty = spec.lots * leg.ratio * x.ex.lot_size;
        const px = dir < 0 ? sellPx(x.con, i, ex) : buyPx(x.con, i, ex);
        const n = p.legs.filter(l => l.spec_id === leg.id).length;
        const lg = { id: `${p.id}.${leg.id}${n ? '.r' + n : ''}`, position: p.id, spec_id: leg.id, kind, action: leg.action, dir, right: leg.right, strike: x.strike, expiry: x.ex.expiry,
          ratio: leg.ratio, qty, lot_size: x.ex.lot_size, entry_date: s.date, entry_t: s.times[i], entry_px: px, open: true, last_px: px, cost: 0, con: x.con, spot,
          exit_t: null, exit_date: null, exit_px: null, exit_reason: null, stop: null, target: null };
        if (leg.stop) lg.stop = dir < 0 ? roundUp(leg.stop.kind === 'pct' ? px * (1 + leg.stop.value / 100) : px + leg.stop.value, TICK)
          : Math.max(0, roundDown(leg.stop.kind === 'pct' ? px * (1 - leg.stop.value / 100) : px - leg.stop.value, TICK));
        if (leg.target) lg.target = dir < 0 ? Math.max(0, roundDown(leg.target.kind === 'pct' ? px * (1 - leg.target.value / 100) : px - leg.target.value, TICK))
          : roundUp(leg.target.kind === 'pct' ? px * (1 + leg.target.value / 100) : px + leg.target.value, TICK);
        p.legs.push(lg);
        fill(lg, s.times[i], leg.action, px, kind === 'initial' ? 'entry' : 're-entry');
        ev(s.times[i], kind === 'initial' ? 'sell' : 'reentry', `${leg.action} ${leg.right} ${x.strike} @ ${px.toFixed(2)}${lg.stop != null ? `, stop ${lg.stop.toFixed(2)}` : ''}${lg.target != null ? `, target ${lg.target.toFixed(2)}` : ''}`, { leg: lg.id });
        return lg;
      }

      // ---- manage the position through the session
      if (pos) {
        const p = pos;
        const start = entryI >= 0 ? entryI : 0;
        const sessionsHeld = si - p.entry_session;
        const expiringToday = p.legs.some(l => l.open && l.expiry === s.date);
        const isExitSession = spec.exit.hold === 'intraday' || (spec.exit.hold === 'sessions' && sessionsHeld >= spec.exit.sessions)
          || (spec.exit.hold === 'expiry' && s.date >= p.nearest) || expiringToday || lastSession;
        const settleToday = spec.exit.hold === 'expiry' && spec.exit.settle_at_expiry && expiringToday && !(lastSession && s.date < p.nearest);
        const timeReason = lastSession && !(spec.exit.hold === 'intraday' || (spec.exit.hold === 'sessions' && sessionsHeld >= spec.exit.sessions) || s.date >= p.nearest) ? 'range_end'
          : spec.exit.hold === 'intraday' ? 'time' : expiringToday || s.date >= p.nearest ? 'expiry_day_exit' : 'time';
        let pending = [];  // orders to fill at the next bar's open
        let lastI = start, done = false;
        // A carried leg with no prices at all today cannot be marked or closed at market.
        const blind = p.legs.filter(l => l.open && (!l.con || l.con.o.every(v => v == null)));
        if (blind.length && entryI < 0) {
          for (const lg of blind) {
            if (lg.expiry < s.date) { closeLeg(lg, times[0], lg.last_px, 'expired_unobserved'); flags.add('expired_unobserved'); warnings.push(gate('DATA_GAP', `${lg.id} expired on ${lg.expiry}, a day with no stored data; it was closed at its last seen price ${lg.last_px.toFixed(2)}, not settled.`)); }
            else { closeLeg(lg, times[0], lg.last_px, 'data_gap'); flags.add('closed_at_stale_price'); warnings.push(gate('DATA_GAP', `${lg.id} (${lg.right} ${lg.strike}) has no prices on ${s.date} (outside the stored window); closed at its last seen price ${lg.last_px.toFixed(2)}.`)); }
          }
          if (!p.legs.some(l => l.open)) { p.exit_reason = p.exit_reason || 'data_gap'; done = true; }
        }
        const exitAllAt = (i, reason, legs) => {
          // shorts are bought back before longs are sold, so the hedge is never removed first
          for (const lg of (legs || p.legs).filter(l => l.open).sort((a, b) => a.dir - b.dir)) {
            let j = i;
            while (j < n && (!lg.con || lg.con.o[j] == null)) j++;
            if (j >= n) { // no further open price today: last close, as the straddle engine does
              let k = Math.min(i, n - 1);
              while (k > 0 && (!lg.con || lg.con.c[k] == null)) k--;
              const c = lg.con && lg.con.c[k] != null ? lg.con.c[k] : lg.last_px;
              const px = lg.dir < 0 ? roundUp(c * (1 + ex.slip_pct / 100) + ex.slip_ticks * TICK, TICK) : Math.max(TICK, roundDown(c * (1 - ex.slip_pct / 100) - ex.slip_ticks * TICK, TICK));
              closeLeg(lg, times[k] + 1, px, reason === 'time' ? 'data_end' : reason); flags.add('exit_at_last_close');
              continue;
            }
            if (j !== i) flags.add('exit_delayed_missing_data');
            closeLeg(lg, times[j], lg.dir < 0 ? buyPx(lg.con, j, ex) : sellPx(lg.con, j, ex), reason);
          }
          p.exit_reason = p.exit_reason || reason;
        };
        const mtmNow = (i) => {
          let gross = 0, costs = 0, estExit = 0;
          const px = {};
          for (const lg of p.legs) {
            costs += lg.cost;
            if (lg.open) {
              gross += lg.dir * (lg.last_px - lg.entry_px) * lg.qty;
              if (spec.exit.basis === 'net') estExit += L.chargesFor(lg.dir < 0 ? 'BUY' : 'SELL', lg.last_px, lg.qty, s.date, ex.brokerage_per_order).total;
              px[lg.id] = lg.last_px;
            } else gross += lg.dir * (lg.exit_px - lg.entry_px) * lg.qty;
          }
          const net = spec.exit.basis === 'net' ? gross - costs - estExit : gross;
          return { gross, net, px };
        };
        const posTarget = spec.exit.target ? (spec.exit.target.kind === 'rupees_per_lot' ? spec.exit.target.value * spec.lots : spec.exit.target.value / 100 * Math.abs(p.premium_rupees)) : null;
        const posStop = spec.exit.stop ? (spec.exit.stop.kind === 'rupees_per_lot' ? spec.exit.stop.value * spec.lots : spec.exit.stop.value / 100 * Math.abs(p.premium_rupees)) : null;

        for (let i = start; i < n && !done; i++) {
          const t = times[i];
          lastI = i;
          if (isExitSession && t >= exitT && (!settleToday || p.legs.some(l => l.open && l.expiry !== s.date))) {
            // time exit: everything (or, when settling today, only the legs that do not expire today)
            const legs = settleToday ? p.legs.filter(l => l.open && l.expiry !== s.date) : null;
            exitAllAt(i, timeReason, legs);
            if (!p.legs.some(l => l.open)) { done = true; break; }
          }
          // orders scheduled at the previous bar's close
          for (const o of pending) {
            if (o.type === 'exit_all') exitAllAt(i, o.reason);
            else if (o.type === 'reenter') {
              const x = o.choice;
              if (x.con.o[i] == null) { ev(t, 'cancel', `re-entry ${x.leg.right} ${x.strike} cancelled: no price`); flags.add('order_cancelled_missing_data'); continue; }
              addLeg(p, x, s, i, 'reentry', o.spot);
            }
          }
          pending = [];
          if (!p.legs.some(l => l.open)) { done = true; break; }
          // leg stops and targets, on this bar's range (stop first)
          const stopped = [];
          for (const lg of p.legs.filter(l => l.open)) {
            const c = lg.con;
            if (!c || c.h[i] == null) { if (lg.stop != null || lg.target != null) flags.add('stop_unmonitored'); continue; }
            const o = c.o[i];
            if (lg.stop != null && (lg.dir < 0 ? c.h[i] >= lg.stop : c.l[i] <= lg.stop)) {
              const base = ex.stop_fill === 'trigger' ? lg.stop : lg.dir < 0 ? Math.max(lg.stop, o) : Math.min(lg.stop, o);
              const gap = lg.dir < 0 ? o > lg.stop : o < lg.stop;
              closeLeg(lg, t, stopPx(c, i, ex, base, lg.dir), 'leg_stop', { intrabar: true });
              if (gap) flags.add('stop_gap');
              if (lg.target != null && (lg.dir < 0 ? c.l[i] <= lg.target : c.h[i] >= lg.target)) flags.add('stop_and_target_same_bar');
              stopped.push(lg);
              continue;
            }
            if (lg.target != null && (lg.dir < 0 ? c.l[i] <= lg.target : c.h[i] >= lg.target)) {
              const px = lg.dir < 0 ? Math.min(lg.target, o) : Math.max(lg.target, o); // a resting limit: the open if it gapped through
              closeLeg(lg, t, px, 'leg_target', { intrabar: true });
            }
          }
          for (const lg of p.legs) if (lg.open && lg.con && lg.con.c[i] != null) lg.last_px = lg.con.c[i];
          const m = mtmNow(i);
          const closeT = t + 1;
          res.mtm.push({ t: closeT, net: m.net, gross: m.gross, px: m.px });
          const anyOpen = p.legs.some(l => l.open);
          if (anyOpen && !(isExitSession && closeT >= exitT)) {
            if (posTarget != null && m.net >= posTarget) { pending.push({ type: 'exit_all', reason: 'target' }); ev(closeT, 'target', `${p.id} target reached (${Math.round(m.net)} ≥ ${Math.round(posTarget)})`); }
            else if (posStop != null && m.net <= -posStop) { pending.push({ type: 'exit_all', reason: 'stop' }); ev(closeT, 'stop', `${p.id} stop hit (${Math.round(m.net)} ≤ -${Math.round(posStop)})`); }
            else if (stopped.length && spec.adjust.on_leg_stop === 'close_all') { pending.push({ type: 'exit_all', reason: 'leg_stop' }); }
            else if (stopped.length && spec.adjust.on_leg_stop === 'reenter' && closeT < cutT) {
              for (const lg of stopped) {
                const done_ = p.reentries[lg.spec_id] || 0;
                if (done_ >= spec.adjust.max_reentries) continue;
                const sp = s.und.c[i];
                if (sp == null) continue;
                const one = Object.assign({}, spec, { legs: spec.legs.filter(x => x.id === lg.spec_id) });
                const known = {};
                for (const o of p.legs) known[o.spec_id] = { strike: o.strike }; // latest leg of each spec id
                const sel = selectStrikes(one, s, i, sp, known);
                if (sel.why) { ev(closeT, 'reentry_skipped', `re-entry for ${lg.spec_id} skipped: ${sel.why}`); continue; }
                p.reentries[lg.spec_id] = done_ + 1;
                pending.push({ type: 'reenter', choice: sel.legs[lg.spec_id], spot: sp });
                ev(closeT, 'reentry_signal', `re-enter ${lg.spec_id}: ${lg.right} ${sel.legs[lg.spec_id].strike}`);
              }
            }
          }
          if (!anyOpen && !pending.length) {
            p.exit_reason = p.exit_reason || (stopped.length ? 'leg_stop' : p.legs.some(l => l.exit_reason === 'leg_target') ? 'leg_target' : 'closed');
            done = true;
          }
        }
        // settlement of legs expiring today, against the index close of the last bar
        if (!done && settleToday) {
          let k = n - 1;
          while (k > 0 && s.und.c[k] == null) k--;
          const S = s.und.c[k];
          if (k !== n - 1) flags.add('settled_on_earlier_bar');
          // settlement is simultaneous; shorts are booked first so the ledger never sees a hedge removed before what it covers
          for (const lg of p.legs.filter(l => l.open && l.expiry === s.date).sort((a, b) => a.dir - b.dir)) closeLeg(lg, CLOSE, r2(intrinsic(lg.right, S, lg.strike)), 'expiry', { settlement: true, settle_spot: S });
          if (!p.legs.some(l => l.open)) { p.exit_reason = p.exit_reason || 'expiry'; done = true; }
        }
        if (!done && p.legs.some(l => l.open) && isExitSession) {
          flags.add('session_data_ended');
          exitAllAt(lastI + 1, 'data_end');
          done = true;
        }
        const openNow = p.legs.filter(l => l.open);
        if (openNow.length) { res.carry = openNow.map(l => l.id); flags.add('carried'); }
        else {
          p.closed = { date: s.date, t: Math.max(...p.legs.map(l => l.exit_t)) };
          finishPosition(p);
          pos = null;
        }
        res.legs = p.legs.map(l => ({ id: l.id, side: l.right, strike: l.strike, kind: l.kind, entry_t: l.entry_date === s.date ? l.entry_t : null, entry_px: l.entry_px,
          exit_t: l.exit_date === s.date ? l.exit_t : null, exit_px: l.exit_px, exit_reason: l.exit_reason, stop: l.stop, net: null }));
        res.exit_reason = p.exit_reason || '';
      }

      if (res.fills.length) { res.status = 'traded'; res.reason = null; }
      else if (res.carry.length || (decided == null && entryI < 0)) { res.status = 'holding'; res.reason = 'position carried; no order today'; }
      else if (decided) { res.status = decided.status; res.reason = decided.reason; }
      res.flags = [...flags].sort();
      res.fills.sort((a, b) => a.t - b.t);
      res.events.sort((a, b) => a.t - b.t);
      res.costs = res.fills.reduce((a, f) => a + f.cost, 0);
      results.push(res);
    }

    function finishPosition(p) {
      let gross = 0, charges = 0;
      for (const lg of p.legs) { lg.gross = lg.dir * (lg.exit_px - lg.entry_px) * lg.qty; lg.net = lg.gross - lg.cost; gross += lg.gross; charges += lg.cost; }
      Object.assign(p, { gross, charges, net: gross - charges });
      const exps = new Set(p.legs.map(l => l.expiry));
      const init = p.legs.filter(l => l.kind === 'initial');
      p.payoff = exps.size === 1 ? payoff(init.map(l => ({ action: l.action, right: l.right, strike: l.strike, qty: l.qty, entry_px: l.entry_px }))) : null;
    }

    const records = positions.map(p => ({
      id: p.id, opened: p.opened, closed: p.closed, entry_premium: p.entry_premium, exit_reason: p.exit_reason || 'open', gross: p.gross, charges: p.charges, net: p.net, payoff: p.payoff,
      flags: [...p.flags],
      legs: p.legs.map(l => ({ id: l.id, leg: l.spec_id, kind: l.kind, action: l.action, right: l.right, strike: l.strike, expiry: l.expiry, qty: l.qty, entry_date: l.entry_date, entry_t: l.entry_t,
        entry_px: l.entry_px, exit_date: l.exit_date, exit_t: l.exit_t, exit_px: l.exit_px, exit_reason: l.exit_reason, gross: l.gross, charges: l.cost, net: l.net })),
    }));
    for (const lg of positions.flatMap(p => p.legs)) delete lg.con;
    const seen = new Set();
    const gates = warnings.filter(g => { const k = g.code + g.message; if (seen.has(k)) return false; seen.add(k); return true; });
    return { results, positions: records, gates, config_hash, spec, caps };
  }

  function countWeekdaysBetween(a, b) {
    let n = 0;
    for (let t = Date.parse(a + 'T00:00:00Z') + 86400000; t < Date.parse(b + 'T00:00:00Z'); t += 86400000) { const d = new Date(t).getUTCDay(); if (d !== 0 && d !== 6) n++; }
    return n;
  }

  return { EXECUTION_DEFAULTS, normalize, validate, capsOf, run, payoff, payoffAt, intrinsic, bsPrice, bsDelta, impliedVol, effectiveOffset, hashStr };
});
