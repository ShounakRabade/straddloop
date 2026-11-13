/* Straddle Lab engine: browser + Node port of the Python package straddle_lab/.
 * Pure calculations only, with no DOM access. Rules: docs/RULES.md. Parity with Python: tools/parity_check.py.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.StraddleEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ------------------------------------------------------------------ config
  const DEFAULTS = {
    symbol: 'NIFTY', session_open: '09:15', exit_time: '15:15', lots: 1, tick: 0.05, expiry_choice: 'nearest',
    or_minutes: 30, candle_minutes: 5, entry_mode: 'confirm', entry_condition: 'full',
    sl_pct: 36.0, stop_type: 'leg', stop_fill: 'gap_aware',
    target_mode: 'strategy', target_basis: 'absolute', target_per_lot: 1000.0, target_pct: 30.0, max_loss_per_lot: 0.0,
    reentry_enabled: true, max_reentries_per_side: 1, reentry_trigger: 'on_stop', opposite_decay_pct: 66.0,
    reentry_mult: 1.0, reentry_tol_pct: 0.0, reentry_strike: 'nearest', reentry_require_opposite_open: true,
    reentry_after_second_stop: false, reentry_eval: 'every_bar', reentry_cutoff: '14:30', min_reentry_premium: 0.0,
    use_quotes: true, slip_pct: 0.5, slip_ticks: 1, stop_slip_mult: 2.0,
    brokerage_per_order: 20.0, stt_sell_pct: 0.1, exch_pct: 0.03503, sebi_pct: 0.0001, stamp_buy_pct: 0.003, gst_pct: 18.0,
    skip_expiry_day: false, min_or_width_pct: 0.0, max_or_width_pct: 100.0, max_entry_spread_pct: 100.0,
    min_iv_proxy: 0.0, max_iv_proxy: 1000.0, weekdays: [0, 1, 2, 3, 4],
  };
  const ENUMS = {
    expiry_choice: ['nearest', 'next'], entry_mode: ['confirm', 'at_or_end'],
    entry_condition: ['full', 'body', 'close', 'overlap'], stop_type: ['leg', 'combined'],
    stop_fill: ['gap_aware', 'trigger', 'bar_high'], target_mode: ['strategy', 'initial', 'none'],
    target_basis: ['absolute', 'pct_premium'], reentry_trigger: ['on_stop', 'opposite_decay'],
    reentry_strike: ['nearest', 'nearest_otm', 'atm_only', 'closest_premium'], reentry_eval: ['every_bar', 'candle_close'],
  };

  function makeConfig(overrides) {
    const cfg = JSON.parse(JSON.stringify(DEFAULTS));
    for (const k of Object.keys(overrides || {})) {
      if (!(k in DEFAULTS)) throw new Error('unknown parameter: ' + k);
      cfg[k] = overrides[k];
    }
    for (const k of Object.keys(ENUMS)) if (!ENUMS[k].includes(cfg[k])) throw new Error(k + '=' + cfg[k] + ' invalid');
    if (cfg.or_minutes % cfg.candle_minutes) throw new Error('or_minutes must be a multiple of candle_minutes');
    if (!(cfg.sl_pct > 0)) throw new Error('sl_pct must be positive');
    if (!(cfg.lots >= 1)) throw new Error('lots must be >= 1');
    return cfg;
  }

  function hm(s) { const [h, m] = s.split(':'); return (+h) * 60 + (+m); }
  function fmtHM(m) { m = Math.round(m); return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'); }
  function r2dp(x) { return Math.round(x * 100 + (x >= 0 ? 1e-9 : -1e-9)) / 100; }

  function hashConfig(cfg) {
    const keys = Object.keys(cfg).sort();
    const s = JSON.stringify(keys.map(k => [k, cfg[k]]));
    let h = 2166136261 >>> 0;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return h.toString(16).padStart(8, '0');
  }

  // ------------------------------------------------------------------ costs and fills
  function roundDown(px, tick) { return r2dp(Math.floor(px / tick + 1e-9) * tick); }
  function roundUp(px, tick) { return r2dp(Math.ceil(px / tick - 1e-9) * tick); }

  function fillCost(action, px, qty, cfg) {
    const turnover = px * qty;
    const brokerage = cfg.brokerage_per_order;
    const exchange = turnover * cfg.exch_pct / 100;
    const sebi = turnover * cfg.sebi_pct / 100;
    const stt = action === 'SELL' ? turnover * cfg.stt_sell_pct / 100 : 0;
    const stamp = action === 'BUY' ? turnover * cfg.stamp_buy_pct / 100 : 0;
    const gst = (brokerage + exchange + sebi) * cfg.gst_pct / 100;
    return { brokerage, exchange, sebi, stt, stamp, gst, total: brokerage + exchange + sebi + stt + stamp + gst };
  }
  function barVal(arr, i) { return arr ? arr[i] : null; }
  function sellPrice(con, i, cfg) {
    const o = con.o[i];
    if (o == null) return null;
    const bid = barVal(con.bid, i);
    const px = (cfg.use_quotes && bid != null) ? bid : o * (1 - cfg.slip_pct / 100) - cfg.slip_ticks * cfg.tick;
    return Math.max(cfg.tick, roundDown(px, cfg.tick));
  }
  function buyPrice(con, i, cfg, stopBase) {
    const o = con.o[i];
    if (o == null) return null;
    const bid = barVal(con.bid, i), ask = barVal(con.ask, i);
    const quotes = cfg.use_quotes && bid != null && ask != null;
    let px;
    if (stopBase == null) px = quotes ? ask : o * (1 + cfg.slip_pct / 100) + cfg.slip_ticks * cfg.tick;
    else {
      const m = cfg.stop_slip_mult;
      px = quotes ? stopBase + (ask - bid) / 2 * m : stopBase * (1 + cfg.slip_pct / 100 * m) + cfg.slip_ticks * cfg.tick * m;
    }
    return roundUp(px, cfg.tick);
  }

  // ------------------------------------------------------------------ simulator
  const SIDES = ['CE', 'PE'];

  function resample(session, minutes, openM) {
    const und = session.und, times = session.times, per = minutes / session.bar_minutes;
    const buckets = new Map();
    for (let i = 0; i < times.length; i++) {
      const t = times[i];
      if (t < openM || und.o[i] == null) continue;
      const start = openM + Math.floor((t - openM) / minutes) * minutes;
      if (!buckets.has(start)) buckets.set(start, []);
      buckets.get(start).push(i);
    }
    return [...buckets.keys()].sort((a, b) => a - b).map(start => {
      const idx = buckets.get(start);
      return {
        t: start, o: und.o[idx[0]], h: Math.max(...idx.map(j => und.h[j])), l: Math.min(...idx.map(j => und.l[j])),
        c: und.c[idx[idx.length - 1]], complete: idx.length === per,
      };
    });
  }

  function entryCheck(c, hi, lo, mode) {
    if (mode === 'full') return c.h <= hi && c.l >= lo;
    if (mode === 'body') return Math.max(c.o, c.c) <= hi && Math.min(c.o, c.c) >= lo;
    if (mode === 'close') return lo <= c.c && c.c <= hi;
    if (mode === 'overlap') return c.h >= lo && c.l <= hi;
    throw new Error(mode);
  }

  function ivProxy(straddle, spot, dte, minutesLeft) {
    const t = (dte + minutesLeft / 375) / 365;
    if (t <= 0 || spot <= 0) return NaN;
    return 100 * straddle / (0.8 * spot * Math.sqrt(t));
  }

  function dayDiff(a, b) { return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000); }
  function weekday(d) { return (new Date(d + 'T00:00:00Z').getUTCDay() + 6) % 7; } // Monday = 0

  function strikesWithData(ex, i) {
    const ks = [...new Set(Object.keys(ex.contracts).map(k => +k.split(':')[1]))].sort((a, b) => a - b);
    return ks.filter(k => SIDES.every(sd => { const c = ex.contracts[sd + ':' + k]; return c && c.o[i] != null; }));
  }

  function simulate(s, cfg) {
    const bm = s.bar_minutes, cm = cfg.candle_minutes, orm = cfg.or_minutes;
    const openM = hm(cfg.session_open), exitM = hm(cfg.exit_time), cutoffM = hm(cfg.reentry_cutoff), tick = cfg.tick;
    const res = { date: s.date, symbol: s.symbol, source: s.source || '?', status: 'excluded', reason: null, flags: [],
      events: [], fills: [], legs: [], mtm: [], or_high: null, or_low: null, check_candle: null, decision_t: null };
    if (cm % bm) { res.reason = `candle_minutes ${cm} not a multiple of data interval ${bm}`; return res; }
    if (s.date && !cfg.weekdays.includes(weekday(s.date))) { res.status = 'filtered'; res.reason = 'weekday filter'; return res; }

    const candles = resample(s, cm, openM);
    res.candles = candles;
    const cmap = new Map(candles.map(c => [c.t, c]));
    const nOr = orm / cm;
    const orC = [];
    for (let k = 0; k < nOr; k++) orC.push(cmap.get(openM + k * cm));
    if (orC.some(c => !c || !c.complete)) { res.reason = 'incomplete opening range'; return res; }
    let check, rng, T;
    if (cfg.entry_mode === 'confirm') { check = cmap.get(openM + orm); rng = orC; T = openM + orm + cm; }
    else {
      check = orC[orC.length - 1]; rng = orC.slice(0, -1); T = openM + orm;
      if (!rng.length) { res.reason = 'at_or_end needs at least two opening-range candles'; return res; }
    }
    if (!check || !check.complete) { res.reason = 'entry candle missing'; return res; }
    const hi = Math.max(...rng.map(c => c.h)), lo = Math.min(...rng.map(c => c.l));
    Object.assign(res, { or_high: hi, or_low: lo, check_candle: check, decision_t: T,
      or_full_high: Math.max(...orC.map(c => c.h)), or_full_low: Math.min(...orC.map(c => c.l)) });

    const ei = s.times.indexOf(T);
    if (ei <= 0 || s.times[ei - 1] !== T - bm || s.und.c[ei - 1] == null) { res.reason = 'no execution bar at decision time'; return res; }
    const spot = s.und.c[ei - 1];
    res.spot_at_entry = spot;
    if (!entryCheck(check, hi, lo, cfg.entry_condition)) {
      res.status = 'no_entry'; res.reason = `entry condition '${cfg.entry_condition}' failed`; return res;
    }

    const choices = [];
    for (const ex of [...s.expiries].sort((a, b) => (a.expiry < b.expiry ? -1 : a.expiry > b.expiry ? 1 : 0))) {
      if (ex.expiry < s.date) continue;
      const ks = strikesWithData(ex, ei);
      if (ks.length) choices.push([ex, ks]);
    }
    const pick = cfg.expiry_choice === 'nearest' ? 0 : 1;
    if (choices.length <= pick) { res.reason = 'missing option data at entry'; return res; }
    const [ex, strikes] = choices[pick];
    let atm = strikes[0];
    for (const k of strikes) if (Math.abs(k - spot) < Math.abs(atm - spot)) atm = k;
    const ce = ex.contracts['CE:' + atm], pe = ex.contracts['PE:' + atm];
    const isExpiryDay = ex.expiry === s.date;
    const dte = dayDiff(s.date, ex.expiry);
    Object.assign(res, { expiry: ex.expiry, lot_size: ex.lot_size, atm, is_expiry_day: isExpiryDay, dte });

    const orWidthPct = 100 * (res.or_full_high - res.or_full_low) / spot;
    const straddleRef = ce.o[ei] + pe.o[ei];
    const ivp = ivProxy(straddleRef, spot, dte, Math.max(0, hm('15:30') - T));
    let spread = null;
    if (cfg.use_quotes && ce.bid && ce.bid[ei] != null && pe.bid && pe.bid[ei] != null)
      spread = 100 * ((ce.ask[ei] - ce.bid[ei]) + (pe.ask[ei] - pe.bid[ei])) / straddleRef;
    Object.assign(res, { or_width_pct: orWidthPct, iv_proxy: ivp, entry_spread_pct: spread });
    let why = null;
    if (cfg.skip_expiry_day && isExpiryDay) why = 'expiry-day filter';
    else if (!(cfg.min_or_width_pct <= orWidthPct && orWidthPct <= cfg.max_or_width_pct)) why = 'opening-range width filter';
    else if (!(cfg.min_iv_proxy <= ivp && ivp <= cfg.max_iv_proxy)) why = 'IV proxy filter';
    else if (spread != null && spread > cfg.max_entry_spread_pct) why = 'bid/ask spread filter';
    if (why) { res.status = 'filtered'; res.reason = why; return res; }

    const qty = cfg.lots * ex.lot_size;
    const ctx = { s, cfg, ex, qty, legs: [], fills: [], events: [], flags: new Set(), pending: [],
      stops: { CE: 0, PE: 0 }, reentries: { CE: 0, PE: 0 }, ended: false, endReason: null };
    ctx.event = (t, kind, text, extra) => ctx.events.push(Object.assign({ t, kind, text }, extra || {}));
    ctx.fill = (leg, t, action, px, reason, intrabar) => {
      const c = fillCost(action, px, leg.qty, cfg);
      ctx.fills.push({ t, leg: leg.id, side: leg.side, strike: leg.strike, expiry: leg.expiry, action, px, qty: leg.qty,
        reason, intrabar: !!intrabar, cost: c.total, costs: c, kind: leg.kind, stop: leg.stop });
      return c.total;
    };
    for (const side of SIDES) ctx.pending.push({ type: 'sell', side, strike: atm, kind: 'initial' });
    ctx.event(T, 'entry_check', `${cfg.entry_condition} condition passed; ATM ${atm} at spot ${spot.toFixed(2)}`);

    res.status = 'traded';
    let initialPremium = null, combStop = null;
    const times = s.times, n = times.length;
    let lastI = ei;
    for (let i = ei; i < n; i++) {
      const t = times[i];
      lastI = i;
      if (t >= exitM) { exitAll(ctx, i, 'eod', true); break; }
      for (const p of ctx.pending) {
        if (p.type === 'exit_all') exitAll(ctx, i, p.reason, true);
        else if (p.type === 'sell') {
          const con = ex.contracts[p.side + ':' + p.strike];
          const px = con ? sellPrice(con, i, cfg) : null;
          if (px == null) {
            ctx.event(t, 'cancel', `${p.side} ${p.strike} sell cancelled: no price`);
            ctx.flags.add('order_cancelled_missing_data');
            continue;
          }
          const leg = { id: ctx.legs.length + 1, side: p.side, strike: p.strike, expiry: ex.expiry, key: p.side + ':' + p.strike,
            kind: p.kind, n: p.kind === 'reentry' ? ctx.reentries[p.side] : 0, qty, entry_t: t, entry_px: px,
            stop: roundUp(px * (1 + cfg.sl_pct / 100), tick), open: true, last_px: px, exit_t: null, exit_px: null,
            exit_reason: null, cost: 0, threshold: p.threshold == null ? null : p.threshold };
          leg.cost += ctx.fill(leg, t, 'SELL', px, p.kind === 'initial' ? 'entry' : 're-entry');
          ctx.legs.push(leg);
          ctx.event(t, 'sell', `SELL ${p.side} ${p.strike} @ ${px.toFixed(2)}, stop ${leg.stop.toFixed(2)}`, { leg: leg.id });
        }
      }
      ctx.pending = [];
      if (initialPremium == null) {
        const init = ctx.legs.filter(l => l.kind === 'initial');
        if (init.length < 2) {
          ctx.flags.add('initial_leg_unfilled');
          exitAll(ctx, i + 1 < n ? i + 1 : i, 'unwind', true);
          break;
        }
        initialPremium = init.reduce((a, l) => a + l.entry_px, 0);
        combStop = initialPremium * (1 + cfg.sl_pct / 100);
      }

      if (cfg.stop_type === 'leg') {
        const stopped = [];
        for (const lg of ctx.legs.filter(x => x.open)) {
          const con = ex.contracts[lg.key];
          if (con.h[i] == null) { ctx.flags.add('stop_unmonitored'); continue; }
          if (con.h[i] >= lg.stop) {
            const base = cfg.stop_fill === 'trigger' ? lg.stop : cfg.stop_fill === 'bar_high' ? con.h[i] : Math.max(lg.stop, con.o[i]);
            const gap = con.o[i] > lg.stop;
            const px = buyPrice(con, i, cfg, base);
            closeLeg(ctx, lg, t, px, 'stop', true);
            if (gap) ctx.flags.add('stop_gap');
            ctx.stops[lg.side] += 1;
            stopped.push(lg);
            ctx.event(t, 'stop', `STOP ${lg.side} ${lg.strike}: high ${con.h[i].toFixed(2)} ≥ ${lg.stop.toFixed(2)}; bought @ ${px.toFixed(2)}` +
              (gap ? ' (gapped through stop)' : ''), { leg: lg.id });
          }
        }
        if (stopped.length === 2) ctx.flags.add('same_bar_double_stop');
      }

      for (const lg of ctx.legs) if (lg.open) { const c = ex.contracts[lg.key].c[i]; if (c != null) lg.last_px = c; }
      const m = mtm(ctx, i);
      const closeT = t + bm;
      res.mtm.push(Object.assign({ t: closeT }, m));
      if (ctx.legs.some(l => l.open) && !ctx.ended && closeT < exitM) {
        if (cfg.target_mode !== 'none') {
          const tgt = cfg.target_basis === 'absolute' ? cfg.target_per_lot * cfg.lots : cfg.target_pct / 100 * initialPremium * qty;
          const val = cfg.target_mode === 'strategy' ? m.net : m.initial_net;
          if (val >= tgt) scheduleExit(ctx, closeT, 'target', `target ₹${fmtInt(tgt)} reached (${fmtInt(val)})`);
        }
        if (!ctx.ended && cfg.max_loss_per_lot > 0 && m.net <= -cfg.max_loss_per_lot * cfg.lots)
          scheduleExit(ctx, closeT, 'max_loss', `daily loss limit hit (${fmtInt(m.net)})`);
        if (!ctx.ended && cfg.stop_type === 'combined') {
          const comb = ctx.legs.filter(l => l.open && l.kind === 'initial').reduce((a, l) => a + l.last_px, 0);
          if (comb >= combStop) scheduleExit(ctx, closeT, 'combined_stop', `combined premium ${comb.toFixed(2)} ≥ ${combStop.toFixed(2)}`);
        }
        if (!ctx.ended && cfg.stop_type === 'leg') reentry(ctx, i, closeT, cutoffM, openM, s.und.c[i]);
      }
      if (ctx.ended && !ctx.pending.length && !ctx.legs.some(l => l.open)) break;
      if (!ctx.legs.some(l => l.open) && !ctx.pending.length && !reentryPossible(ctx, closeT, cutoffM)) {
        ctx.ended = true;
        ctx.endReason = ctx.endReason || 'all legs stopped';
        break;
      }
    }
    if (ctx.legs.some(l => l.open)) { ctx.flags.add('session_data_ended'); exitAll(ctx, lastI, 'data_end', false, true); }
    summarise(res, ctx, initialPremium, qty);
    return res;
  }

  function fmtInt(x) { return Math.round(x).toLocaleString('en-IN'); }

  function closeLeg(ctx, lg, t, px, reason, intrabar) {
    lg.cost += ctx.fill(lg, t, 'BUY', px, reason, intrabar);
    Object.assign(lg, { open: false, exit_t: t, exit_px: px, exit_reason: reason, last_px: px });
  }

  function exitAll(ctx, i, reason, searchForward, useClose) {
    const s = ctx.s, cfg = ctx.cfg, ex = ctx.ex;
    const slipUp = x => roundUp(x * (1 + cfg.slip_pct / 100) + cfg.slip_ticks * cfg.tick, cfg.tick);
    for (const lg of ctx.legs.filter(x => x.open)) {
      const con = ex.contracts[lg.key];
      let j = i, px, t;
      if (useClose) {
        px = con.c[j];
        while (px == null && j > 0) { j--; px = con.c[j]; }
        px = slipUp(px); t = s.times[j] + s.bar_minutes;
      } else {
        while (j < s.times.length && con.o[j] == null && searchForward) j++;
        if (j >= s.times.length || con.o[j] == null) {
          ctx.flags.add('exit_price_missing');
          j = i;
          while (j > 0 && con.c[j] == null) j--;
          px = slipUp(con.c[j]); t = s.times[j] + s.bar_minutes;
        } else {
          if (j !== i) ctx.flags.add('exit_delayed_missing_data');
          px = buyPrice(con, j, cfg); t = s.times[j];
        }
      }
      closeLeg(ctx, lg, t, px, reason);
      ctx.event(t, 'exit', `BUY ${lg.side} ${lg.strike} @ ${px.toFixed(2)} (${reason})`, { leg: lg.id });
    }
    ctx.ended = true;
    ctx.endReason = ctx.endReason || reason;
  }

  function scheduleExit(ctx, t, reason, text) {
    ctx.pending = [{ type: 'exit_all', reason }];
    ctx.ended = true;
    ctx.endReason = reason;
    ctx.event(t, reason, text);
  }

  function mtm(ctx, i) {
    const cfg = ctx.cfg, ex = ctx.ex;
    const out = { net: 0, gross: 0, initial_net: 0, realized: 0, unrealized: 0, worst: 0, best: 0 };
    for (const lg of ctx.legs) {
      let g, net, worst, best, exitC = 0;
      if (lg.open) {
        const con = ex.contracts[lg.key];
        g = (lg.entry_px - lg.last_px) * lg.qty;
        exitC = fillCost('BUY', lg.last_px, lg.qty, cfg).total;
        const hi = con.h[i] != null ? con.h[i] : lg.last_px;
        const lo = con.l[i] != null ? con.l[i] : lg.last_px;
        worst = (lg.entry_px - hi) * lg.qty;
        best = (lg.entry_px - lo) * lg.qty;
        out.unrealized += g;
        net = g - lg.cost - exitC;
      } else {
        g = (lg.entry_px - lg.exit_px) * lg.qty;
        out.realized += g;
        net = g - lg.cost;
        worst = best = g;
      }
      out.gross += g; out.net += net;
      out.worst += worst - lg.cost - exitC;
      out.best += best - lg.cost - exitC;
      if (lg.kind === 'initial') out.initial_net += net;
    }
    return out;
  }

  function reentryPossible(ctx, closeT, cutoffM) {
    const cfg = ctx.cfg;
    if (!cfg.reentry_enabled || cfg.stop_type !== 'leg' || closeT >= cutoffM) return false;
    if (cfg.reentry_require_opposite_open) return false;
    return SIDES.some(sd => ctx.stops[sd] > 0 && ctx.reentries[sd] < cfg.max_reentries_per_side);
  }

  function reentry(ctx, i, closeT, cutoffM, openM, spotNow) {
    const cfg = ctx.cfg, ex = ctx.ex;
    if (!cfg.reentry_enabled || closeT >= cutoffM) return;
    if (cfg.reentry_eval === 'candle_close' && (closeT - openM) % cfg.candle_minutes) return;
    for (const side of SIDES) {
      if (ctx.legs.some(l => l.open && l.side === side)) continue;
      if (ctx.pending.some(p => p.type === 'sell' && p.side === side)) continue;
      if (ctx.stops[side] === 0 || ctx.reentries[side] >= cfg.max_reentries_per_side) continue;
      if (ctx.stops[side] >= 2 && !cfg.reentry_after_second_stop) continue;
      const oppSide = side === 'CE' ? 'PE' : 'CE';
      const oppOpen = ctx.legs.filter(l => l.open && l.side === oppSide);
      let opp;
      if (oppOpen.length) opp = oppOpen[oppOpen.length - 1];
      else {
        if (cfg.reentry_require_opposite_open) continue;
        const prev = ctx.legs.filter(l => l.side === oppSide);
        if (!prev.length) continue;
        opp = prev[prev.length - 1];
      }
      const x = ex.contracts[opp.key].c[i];
      if (x == null) continue;
      if (cfg.reentry_trigger === 'opposite_decay' && x > opp.entry_px * cfg.opposite_decay_pct / 100) continue;
      const threshold = x * cfg.reentry_mult * (1 + cfg.reentry_tol_pct / 100);
      let cands = [];
      for (const key of Object.keys(ex.contracts)) {
        const [sd, k] = key.split(':');
        if (sd !== side) continue;
        const c = ex.contracts[key].c[i];
        if (c == null || c > threshold || c < cfg.min_reentry_premium) continue;
        cands.push([+k, c]);
      }
      if (!cands.length) continue;
      if (cfg.reentry_strike === 'atm_only') {
        const allK = [...new Set(Object.keys(ex.contracts).filter(k => k.startsWith(side)).map(k => +k.split(':')[1]))].sort((a, b) => a - b);
        let atm = allK[0];
        for (const k of allK) if (Math.abs(k - spotNow) < Math.abs(atm - spotNow)) atm = k;
        cands = cands.filter(c => c[0] === atm);
      } else if (cfg.reentry_strike === 'nearest_otm') {
        cands = cands.filter(c => (side === 'CE' ? c[0] >= spotNow : c[0] <= spotNow));
      }
      if (!cands.length) continue;
      const keyFn = cfg.reentry_strike === 'closest_premium'
        ? c => [threshold - c[1], Math.abs(c[0] - spotNow)]
        : c => [Math.abs(c[0] - spotNow), -c[1]];
      let best = cands[0];
      for (const c of cands) {
        const a = keyFn(c), b = keyFn(best);
        if (a[0] < b[0] || (a[0] === b[0] && a[1] < b[1])) best = c;
      }
      ctx.reentries[side] += 1;
      ctx.pending.push({ type: 'sell', side, strike: best[0], kind: 'reentry', threshold });
      ctx.event(closeT, 'reentry_signal', `${oppSide} ${opp.strike} at ${x.toFixed(2)} → threshold ${threshold.toFixed(2)}; selected ${side} ${best[0]} (close ${best[1].toFixed(2)})`);
    }
  }

  function summarise(res, ctx, initialPremium, qty) {
    const legs = ctx.legs, fills = ctx.fills;
    for (const lg of legs) { lg.gross = (lg.entry_px - lg.exit_px) * lg.qty; lg.net = lg.gross - lg.cost; }
    const gross = legs.reduce((a, l) => a + l.gross, 0);
    const costs = fills.reduce((a, f) => a + f.cost, 0);
    const byKind = {};
    for (const kind of ['initial', 'reentry']) {
      const ls = legs.filter(l => l.kind === kind);
      const g = ls.reduce((a, l) => a + l.gross, 0), c = ls.reduce((a, l) => a + l.cost, 0);
      byKind[kind] = { gross: g, costs: c, net: g - c, legs: ls.length };
    }
    const hold = legs.filter(l => l.exit_t != null).map(l => l.exit_t - l.entry_t);
    Object.assign(res, {
      legs, fills, events: ctx.events.slice().sort((a, b) => a.t - b.t), flags: [...ctx.flags].sort(), qty,
      initial_premium: initialPremium, premium_collected: legs.reduce((a, l) => a + l.entry_px * l.qty, 0),
      gross, costs, net: gross - costs, by_kind: byKind, stops: ctx.stops.CE + ctx.stops.PE,
      stops_by_side: Object.assign({}, ctx.stops), reentries: legs.filter(l => l.kind === 'reentry').length,
      exit_reason: ctx.endReason || 'eod', target_hit: ctx.endReason === 'target',
      mae: Math.min(0, ...res.mtm.map(m => m.worst)), mfe: Math.max(0, ...res.mtm.map(m => m.best)),
      n_trades: fills.length, avg_hold_min: hold.length ? hold.reduce((a, b) => a + b, 0) / hold.length : 0,
    });
  }

  // ------------------------------------------------------------------ synthetic (ILLUSTRATIVE ONLY)
  const SUB = 4, OPEN = 555, CLOSE = 930;
  const SYN_BASE = {
    symbol: 'NIFTY', spot: 24000.0, strike_step: 50, n_strikes: 15, lot_size: 75, dte: 2, rv: 12.0, iv: 13.0,
    iv_drift: -1.0, smile: 0.6, trend_pct: 0.0, trend_start: '09:50', trend_end: '15:30', mean_revert: 0.0,
    trend2_pct: 0.0, trend2_start: null, trend2_end: null,
    jump_time: null, jump_pct: 0.0, shock_time: null, shock_rv_mult: 1.0, shock_iv_pts: 0.0,
    opt_gap_time: null, opt_gap_pct: 0.0, spread_pct: 0.4, missing_prob: 0.0, seed: 7,
  };
  const SCENARIOS = {
    range_decay: { label: 'Range-bound, premiums decay', rv: 7.0, iv: 13.0, iv_drift: -1.5, mean_revert: 0.02, seed: 2 },
    strong_trend: { label: 'Strong directional trend', rv: 11.0, trend_pct: 1.6, seed: 2 },
    vol_expansion: { label: 'Sudden volatility expansion', rv: 9.0, shock_time: '11:30', shock_rv_mult: 3.0, shock_iv_pts: 6.0, seed: 2 },
    breakout_up: { label: 'Breakout above OR high', rv: 10.0, trend_pct: 0.9, trend_start: '10:00', trend_end: '12:00', seed: 2 },
    breakdown: { label: 'Breakdown below OR low', rv: 10.0, trend_pct: -0.9, trend_start: '10:00', trend_end: '12:00', seed: 3 },
    one_leg_stop: { label: 'One leg stops, other decays', rv: 8.0, trend_pct: 0.55, trend_start: '10:15', trend_end: '11:15', mean_revert: 0.0, iv_drift: -2.0, seed: 4 },
    both_adverse: { label: 'Both legs adverse (whipsaw + IV up)', rv: 16.0, iv_drift: 3.0, trend_pct: 0.7, trend_start: '10:00', trend_end: '11:30', jump_time: '13:00', jump_pct: -1.1, seed: 4 },
    multi_stop: { label: 'Multiple stop-outs and re-entries', rv: 14.0, trend_pct: 0.8, trend_start: '10:00', trend_end: '11:00', jump_time: '12:30', jump_pct: -1.2, seed: 7 },
    premium_gap: { label: 'Premium gaps through stop', rv: 9.0, jump_time: '11:00', jump_pct: 0.8, opt_gap_time: '11:00', opt_gap_pct: 15.0, seed: 2 },
    illiquid: { label: 'Low liquidity, wide bid/ask', rv: 10.0, spread_pct: 4.0, missing_prob: 0.08, seed: 2 },
  };

  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a) >>> 0;
      t = (((t + (Math.imul(t ^ (t >>> 7), 61 | t) >>> 0)) >>> 0) ^ t) >>> 0;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function ncdf(x) {
    const s = x >= 0 ? 1 : -1, z = Math.abs(x) / Math.SQRT2, t = 1 / (1 + 0.3275911 * z);
    const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
    return 0.5 * (1 + s * y);
  }
  function bs(cp, S, K, t, vol) {
    if (t <= 1e-9 || vol <= 0) return cp === 'CE' ? Math.max(0, S - K) : Math.max(0, K - S);
    const sd = vol * Math.sqrt(t), d1 = (Math.log(S / K) + 0.5 * sd * sd) / sd, d2 = d1 - sd;
    return cp === 'CE' ? S * ncdf(d1) - K * ncdf(d2) : K * ncdf(-d2) - S * ncdf(-d1);
  }
  function pyRound(x) { // round-half-even, as Python's round()
    const f = Math.floor(x), d = x - f;
    if (d > 0.5) return f + 1;
    if (d < 0.5) return f;
    return f % 2 === 0 ? f : f + 1;
  }
  function r20(x) { return pyRound(x * 20) / 20; }
  function hmOrNull(s) { return s == null ? null : hm(s); }

  function generate(params, dateStr) {
    const p = Object.assign({}, SYN_BASE, params || {});
    dateStr = dateStr || '2099-01-05';
    const rnd = mulberry32(p.seed | 0);
    const gauss = () => { const u1 = Math.max(rnd(), 1e-12), u2 = rnd(); return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2); };
    const n = CLOSE - OPEN;
    const times = Array.from({ length: n }, (_, i) => OPEN + i);
    const dtSub = 1 / (252 * 375 * SUB);
    const t0 = hm(p.trend_start), t1 = hm(p.trend_end);
    const trendPerMin = Math.log(1 + p.trend_pct / 100) / Math.max(1, t1 - t0);
    const t2a = hmOrNull(p.trend2_start), t2b = hmOrNull(p.trend2_end);
    const trend2PerMin = t2a != null ? Math.log(1 + p.trend2_pct / 100) / Math.max(1, t2b - t2a) : 0;
    const jumpT = hmOrNull(p.jump_time), shockT = hmOrNull(p.shock_time), gapT = hmOrNull(p.opt_gap_time);
    let x = Math.log(p.spot);
    const x0 = x, S = [];
    for (const t of times) {
      if (jumpT != null && t === jumpT) x += Math.log(1 + p.jump_pct / 100);
      const rv = p.rv / 100 * (shockT != null && t >= shockT ? p.shock_rv_mult : 1.0);
      const path = [];
      for (let k = 0; k < SUB; k++) {
        let drift = (t0 <= t && t < t1) ? trendPerMin / SUB : 0;
        if (t2a != null && t2a <= t && t < t2b) drift += trend2PerMin / SUB;
        x += drift - p.mean_revert * (x - x0) / SUB + rv * Math.sqrt(dtSub) * gauss();
        path.push(Math.exp(x));
      }
      S.push(path);
    }
    const und = { o: [], h: [], l: [], c: [] };
    let prevC = p.spot;
    S.forEach((path, i) => {
      const o = (jumpT != null && times[i] === jumpT) ? path[0] : prevC;
      const seg = [o].concat(path);
      und.o.push(r2dp(o)); und.h.push(r2dp(Math.max(...seg))); und.l.push(r2dp(Math.min(...seg))); und.c.push(r2dp(path[SUB - 1]));
      prevC = path[SUB - 1];
    });
    const step = p.strike_step, atm0 = pyRound(p.spot / step) * step;
    const strikes = [];
    for (let j = -p.n_strikes; j <= p.n_strikes; j++) strikes.push(atm0 + j * step);
    const ivAt = (t, s, k) => {
      let iv = p.iv + p.iv_drift * (t - OPEN) / n;
      if (shockT != null && t >= shockT) iv += p.shock_iv_pts * Math.min(1, (t - shockT + 1) / 10);
      iv += p.smile * Math.abs(Math.log(k / s)) * 100;
      return Math.max(1, iv) / 100;
    };
    const tau = tm => (p.dte + Math.max(0, CLOSE - tm) / 375) / 365;
    const contracts = {};
    for (const cp of SIDES) for (const k of strikes) {
      const con = { o: [], h: [], l: [], c: [], bid: [], ask: [] };
      let prev = null, gapMult = 1;
      times.forEach((t, i) => {
        if (gapT != null && t === gapT) gapMult = 1 + p.opt_gap_pct / 100;
        else if (gapT != null && t > gapT) gapMult = 1 + (gapMult - 1) * 0.8;
        const seg = S[i].map((s, j) => bs(cp, s, k, tau(t + (j + 1) / SUB), ivAt(t, s, k)) * gapMult);
        let o = (prev != null && !(jumpT != null && t === jumpT)) ? prev : seg[0];
        if (gapT != null && t === gapT) o = seg[0];
        const h = Math.max(o, ...seg), l = Math.min(o, ...seg), c = seg[SUB - 1];
        prev = c;
        if (p.missing_prob > 0 && rnd() < p.missing_prob) { for (const a of Object.values(con)) a.push(null); return; }
        const half = Math.max(0.05, o * p.spread_pct / 200);
        con.o.push(Math.max(0.05, r20(o))); con.h.push(Math.max(0.05, r20(h)));
        con.l.push(Math.max(0.05, r20(l))); con.c.push(Math.max(0.05, r20(c)));
        const bid = Math.max(0.05, r20(o - half));
        con.bid.push(bid); con.ask.push(Math.max(r2dp(bid + 0.05), r20(o + half)));
      });
      contracts[cp + ':' + k] = con;
    }
    const d = new Date(dateStr + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + p.dte);
    return { date: dateStr, symbol: p.symbol, source: 'synthetic', label: p.label || '', bar_minutes: 1, times, und,
      expiries: [{ expiry: d.toISOString().slice(0, 10), lot_size: p.lot_size, contracts }], params: p };
  }

  function syntheticCalendar(nDays, base, seed, start) {
    const rnd = mulberry32(seed == null ? 1 : seed);
    const d = new Date((start || '2099-01-05') + 'T00:00:00Z');
    const out = [];
    base = base || {};
    while (out.length < nDays) {
      const wd = (d.getUTCDay() + 6) % 7;
      if (wd < 5) {
        const u = rnd();
        let regime;
        if (u < 0.45) regime = { mean_revert: 0.01 + 0.02 * rnd() };
        else if (u < 0.75) regime = { trend_pct: (rnd() - 0.5) * 2.4, trend_start: '10:00', trend_end: '14:00' };
        else if (u < 0.9) regime = { shock_time: '11:30', shock_rv_mult: 2 + 2 * rnd(), shock_iv_pts: 3 + 5 * rnd() };
        else regime = { jump_time: '12:00', jump_pct: (rnd() - 0.5) * 3 };
        const dte = Math.floor(rnd() * 5);
        const p = Object.assign({}, base, regime, { dte, seed: Math.floor(rnd() * 2147483648),
          rv: (base.rv != null ? base.rv : SYN_BASE.rv) * (0.6 + 0.8 * rnd()) });
        out.push(generate(p, d.toISOString().slice(0, 10)));
      }
      d.setUTCDate(d.getUTCDate() + 1);
    }
    return out;
  }

  // ------------------------------------------------------------------ metrics
  function pctile(xs, q) {
    if (!xs.length) return null;
    if (xs.length === 1) return xs[0];
    const pos = (xs.length - 1) * q / 100, lo = Math.floor(pos), hi = Math.min(lo + 1, xs.length - 1);
    return xs[lo] + (xs[hi] - xs[lo]) * (pos - lo);
  }
  function count(arr) { const m = {}; for (const a of arr) m[a] = (m[a] || 0) + 1; return m; }
  const sum = a => a.reduce((x, y) => x + y, 0);

  // session-level metrics shared by every strategy
  function dailyCore(results, lots, marginPerLot) {
    lots = lots || 1;
    const eligible = results.filter(r => ['traded', 'no_entry', 'filtered'].includes(r.status));
    const traded = results.filter(r => r.status === 'traded');
    const excluded = count(results.filter(r => r.status === 'excluded').map(r => r.reason));
    const m = {
      sessions_total: results.length, sessions_excluded: sum(Object.values(excluded)), exclusion_reasons: excluded,
      sessions_eligible: eligible.length, sessions_traded: traded.length,
      no_entry_reasons: count(results.filter(r => r.status === 'no_entry' || r.status === 'filtered').map(r => r.reason)),
      pct_no_entry: eligible.length ? 100 * (eligible.length - traded.length) / eligible.length : null,
    };
    if (!traded.length) { m.warning = 'no traded sessions'; return m; }
    const pnl = traded.map(r => r.net), n = pnl.length;
    const wins = pnl.filter(x => x > 0), losses = pnl.filter(x => x <= 0);
    const s = pnl.slice().sort((a, b) => a - b);
    const mean = sum(pnl) / n;
    const sd = n > 1 ? Math.sqrt(sum(pnl.map(x => (x - mean) ** 2)) / (n - 1)) : 0;
    const costs = sum(traded.map(r => r.costs));
    Object.assign(m, {
      net_pnl: sum(pnl), gross_pnl: sum(traded.map(r => r.gross)), costs,
      avg_daily_pnl: mean, median_daily_pnl: pctile(s, 50), sd_daily_pnl: sd, return_per_lot: sum(pnl) / lots,
      t_stat_mean: sd > 0 ? mean / (sd / Math.sqrt(n)) : null,
      ci95_mean: n > 1 ? [mean - 1.96 * sd / Math.sqrt(n), mean + 1.96 * sd / Math.sqrt(n)] : null,
      profit_factor: losses.length && sum(losses) < 0 ? sum(wins) / -sum(losses) : null,
      win_rate: 100 * wins.length / n, avg_win: wins.length ? sum(wins) / wins.length : null,
      avg_loss: losses.length ? sum(losses) / losses.length : null,
      largest_win: Math.max(...pnl), largest_loss: Math.min(...pnl),
    });
    if (marginPerLot) m.return_on_margin_pct = 100 * sum(pnl) / (marginPerLot * lots);
    let cum = 0, peak = 0, dd = 0, streak = 0, maxStreak = 0;
    const curve = [];
    for (const r of eligible.slice().sort((a, b) => (a.date < b.date ? -1 : 1))) {
      const x = r.status === 'traded' ? r.net : 0;
      cum += x; peak = Math.max(peak, cum); dd = Math.min(dd, cum - peak);
      curve.push({ date: r.date, pnl: x, cum, dd: cum - peak });
      if (r.status === 'traded') { streak = x <= 0 ? streak + 1 : 0; maxStreak = Math.max(maxStreak, streak); }
    }
    m.max_drawdown = dd; m.max_consecutive_losing_days = maxStreak; m.equity_curve = curve;
    const monthly = {};
    for (const r of traded.slice().sort((a, b) => (a.date < b.date ? -1 : 1))) monthly[r.date.slice(0, 7)] = (monthly[r.date.slice(0, 7)] || 0) + r.net;
    m.monthly = monthly;
    const k = Math.max(1, Math.ceil(0.05 * n));
    m.var5 = pctile(s, 5);
    m.es5 = sum(s.slice(0, k)) / k;
    m.tail_sample_note = n >= 100 ? 'adequate' : `only ${n} traded sessions; 5% tail rests on ${k} observation(s), treat as indicative`;
    m.worst_5pct_days = traded.slice().sort((a, b) => a.net - b.net).slice(0, k).map(r => ({ date: r.date, net: r.net }));
    m.max_intraday_adverse = Math.min(...traded.map(r => r.mae));
    m.max_intraday_favourable = Math.max(...traded.map(r => r.mfe));
    m.pct_loss_sessions = 100 * losses.length / n;
    const grossProfit = sum(traded.filter(r => r.gross > 0).map(r => r.gross));
    m.costs_pct_of_gross_profit = grossProfit > 0 ? 100 * costs / grossProfit : null;
    m.data_flags = count(traded.flatMap(r => r.flags));
    return m;
  }

  // straddle metrics: shared core + stop / re-entry statistics
  function computeMetrics(results, lots, marginPerLot) {
    const m = dailyCore(results, lots, marginPerLot);
    const traded = results.filter(r => r.status === 'traded');
    if (!traded.length) return m;
    const n = traded.length;
    m.stop_freq_pct = 100 * traded.filter(r => r.stops > 0).length / n;
    m.reentry_freq_pct = 100 * traded.filter(r => r.reentries > 0).length / n;
    m.multi_stop_freq_pct = 100 * traded.filter(r => r.stops >= 2).length / n;
    m.avg_trades_per_session = sum(traded.map(r => r.n_trades)) / n;
    m.pct_target_hit = 100 * traded.filter(r => r.target_hit).length / n;
    const holds = traded.flatMap(r => r.legs.map(l => l.exit_t - l.entry_t));
    m.avg_holding_min = holds.length ? sum(holds) / holds.length : null;
    m.initial_net = sum(traded.map(r => r.by_kind.initial.net));
    m.reentry_net = sum(traded.map(r => r.by_kind.reentry.net));
    m.exit_reasons = count(traded.map(r => r.exit_reason));
    return m;
  }

  function regimeTags(session) {
    const u = session.und;
    const o = u.o.find(x => x != null), c = [...u.c].reverse().find(x => x != null);
    if (o == null || c == null) return {};
    const ret = 100 * (c / o - 1);
    const closes = u.c.filter(x => x != null);
    let ss = 0;
    for (let i = 1; i < closes.length; i++) ss += Math.log(closes[i] / closes[i - 1]) ** 2;
    return { day_return_pct: ret, realised_vol_pct: Math.sqrt(ss * 252) * 100,
      direction: ret > 0.5 ? 'bullish' : ret < -0.5 ? 'bearish' : 'range-bound' };
  }

  // ------------------------------------------------------------------ experiments
  const VARIANTS = [
    ['—', 'Original rules', {}],
    ['A', 'Close inside range', { entry_condition: 'close' }],
    ['A', 'Body inside range', { entry_condition: 'body' }],
    ['A', 'Overlap (no real filter)', { entry_condition: 'overlap' }],
    ['A', 'Entry at 09:45 (at_or_end)', { entry_mode: 'at_or_end' }],
    ['A', '15-min opening range', { or_minutes: 15 }],
    ['A', '60-min opening range', { or_minutes: 60 }],
    ['A', 'OR width ≤ 0.6% filter', { max_or_width_pct: 0.6 }],
    ['B', 'Stop 20% per leg', { sl_pct: 20.0 }],
    ['B', 'Stop 50% per leg', { sl_pct: 50.0 }],
    ['B', 'Stop 75% per leg', { sl_pct: 75.0 }],
    ['B', 'Combined-premium stop 36%', { stop_type: 'combined' }],
    ['B', 'Time exit 13:30', { exit_time: '13:30' }],
    ['B', '36% stop + ₹2,000 daily loss cap', { max_loss_per_lot: 2000.0 }],
    ['C', 'No re-entry', { reentry_enabled: false }],
    ['C', 'Up to 3 re-entries per side', { max_reentries_per_side: 3, reentry_after_second_stop: true }],
    ['C', 'Re-entry only after opposite decays to 66%', { reentry_trigger: 'opposite_decay' }],
    ['C', 'Re-entry on 5-min closes only', { reentry_eval: 'candle_close' }],
    ['D', 'Target ₹500', { target_per_lot: 500.0 }],
    ['D', 'Target ₹2,500', { target_per_lot: 2500.0 }],
    ['D', 'Target 30% of premium', { target_basis: 'pct_premium', target_pct: 30.0 }],
    ['D', 'No target (EOD exit only)', { target_mode: 'none' }],
    ['D', 'Initial-position target', { target_mode: 'initial' }],
    ['D', 'Target ₹1,000 + ₹1,500 loss cap', { max_loss_per_lot: 1500.0 }],
    ['E', 'Skip expiry day', { skip_expiry_day: true }],
    ['E', 'IV proxy ≥ 12%', { min_iv_proxy: 12.0 }],
    ['E', 'Entry spread ≤ 2%', { max_entry_spread_pct: 2.0 }],
    ['F', 'No new positions after 12:00', { reentry_cutoff: '12:00' }],
    ['F', 'Exit 14:45', { exit_time: '14:45' }],
  ];

  function runBacktest(sessions, cfg, marginPerLot) {
    const results = sessions.map(s => simulate(s, cfg));
    return { config: cfg, config_hash: hashConfig(cfg), results, metrics: computeMetrics(results, cfg.lots, marginPerLot) };
  }

  function sensitivity(sessions, param, values, base, strat) {
    const S = STRATEGIES[strat || 'straddle'];
    const rows = values.map(v => {
      const m = S.run(sessions, S.make(Object.assign({}, base || {}, { [param]: v }))).metrics;
      return { value: v, net_pnl: m.net_pnl, avg_daily_pnl: m.avg_daily_pnl, max_drawdown: m.max_drawdown, stop_freq_pct: m.stop_freq_pct, es5: m.es5,
        trades: m.trades, expectancy: m.expectancy, win_rate: m.trade_win_rate != null ? m.trade_win_rate : m.win_rate };
    });
    const nets = rows.map(r => r.net_pnl || 0);
    let best = 0;
    nets.forEach((x, i) => { if (x > nets[best]) best = i; });
    let run = 0;
    for (let j = best; j >= 0 && nets[j] > 0; j--) run++;
    for (let j = best + 1; j < nets.length && nets[j] > 0; j++) run++;
    const fragile = nets[best] > 0 && run < 3;
    return { param, rows, best_value: values[best], positive_neighbourhood: run, fragile,
      note: fragile ? 'FRAGILE: profitable only in a narrow band' : nets[best] <= 0 ? 'no profitable setting' : 'profitable across ≥3 adjacent settings' };
  }

  function walkForward(sessions, grid, nFolds, score, base, strat) {
    const S = STRATEGIES[strat || 'straddle'];
    score = score || 'avg_daily_pnl';
    const ss = sessions.slice().sort((a, b) => (a.date < b.date ? -1 : 1));
    const size = Math.ceil(ss.length / (nFolds || 4));
    const folds = [];
    for (let i = 0; i < ss.length; i += size) folds.push(ss.slice(i, i + size));
    const out = [];
    let oos = [];
    for (let j = 1; j < folds.length; j++) {
      const train = [].concat(...folds.slice(0, j));
      let best = null, bestScore = -Infinity;
      for (const g of grid) {
        const sc = S.run(train, S.make(Object.assign({}, base || {}, g))).metrics[score];
        if (sc != null && sc > bestScore) { best = g; bestScore = sc; }
      }
      if (!best) continue;
      const test = S.run(folds[j], S.make(Object.assign({}, base || {}, best)));
      oos = oos.concat(test.results);
      out.push({ fold: j, train: [train[0].date, train[train.length - 1].date], test: [folds[j][0].date, folds[j][folds[j].length - 1].date],
        chosen: best, in_sample_score: bestScore, oos_score: test.metrics[score] });
    }
    return { folds: out, configs_tested_per_fold: grid.length, oos_metrics: strat === 'orb' ? orbMetrics(oos) : computeMetrics(oos) };
  }

  // ================================================================== STRATEGY 2: opening range breakout, long options
  // Mirror of straddle_lab/orb.py (rules: docs/ORB_RULES.md). Shares resample, fills rounding, costs, synthetic, dailyCore.
  const ORB_DEFAULTS = {
    symbol: 'NIFTY', session_open: '09:15', exit_time: '15:15', lots: 1, tick: 0.05, expiry_choice: 'nearest',
    or_minutes: 30, candle_minutes: 5,
    breakout_def: 'wick', breakout_buffer: 5.0, min_body_ratio: 0.5, both_sides_rule: 'ignore_candle',
    confirm_window: 1, confirm_buffer: 0.0, setup_refresh: 'rolling', cancel_inside_range: false,
    cancel_on_opposite: false, min_break_dist: 0.0, max_chase: 0.0, latest_entry: '14:30', entry_exec: 'candle_close',
    strike_mode: 'offset', strike_offset: 0, target_delta: 0.5,
    target_basis: 'premium', target_points: 30.0, target_exec: 'limit',
    reversal_def: 'opposite_color', rev_min_body_ratio: 0.5, stop_buffer: 0.0, rev_update: 'latest',
    stop_trigger: 'wick', emergency_stop_pct: 0.0, max_hold_minutes: 0, same_bar_rule: 'stop_first',
    max_trades: 1, allow_same_dir: false, allow_opposite_dir: false, max_consecutive_losses: 0, max_loss_per_lot: 0.0,
    use_quotes: true, slip_pct: 0.5, slip_ticks: 1, stop_slip_mult: 2.0,
    brokerage_per_order: 20.0, stt_sell_pct: 0.1, exch_pct: 0.03503, sebi_pct: 0.0001, stamp_buy_pct: 0.003, gst_pct: 18.0,
    skip_expiry_day: false, min_or_width_pct: 0.0, max_or_width_pct: 100.0, min_gap_pct: -100.0, max_gap_pct: 100.0,
    max_or_width_rel: 0.0, or_avg_lookback: 10, weekdays: [0, 1, 2, 3, 4],
  };
  const ORB_ENUMS = {
    expiry_choice: ['nearest', 'next'], breakout_def: ['wick', 'close', 'close_buffer', 'body_strength'],
    both_sides_rule: ['ignore_candle', 'skip_day', 'close_direction'], setup_refresh: ['rolling', 'first_only'],
    entry_exec: ['candle_close', 'fine_break'], strike_mode: ['offset', 'delta'], target_basis: ['premium', 'index', 'none'],
    target_exec: ['limit', 'trigger_next_open', 'close_next_open'],
    reversal_def: ['opposite_color', 'close_below_prev', 'close_inside_range', 'body_threshold'],
    rev_update: ['latest', 'first'], stop_trigger: ['wick', 'close'], same_bar_rule: ['stop_first', 'target_first'],
  };
  function orbMakeConfig(overrides) {
    const cfg = JSON.parse(JSON.stringify(ORB_DEFAULTS));
    for (const k of Object.keys(overrides || {})) {
      if (!(k in ORB_DEFAULTS)) throw new Error('unknown ORB parameter: ' + k);
      cfg[k] = overrides[k];
    }
    for (const k of Object.keys(ORB_ENUMS)) if (!ORB_ENUMS[k].includes(cfg[k])) throw new Error(k + '=' + cfg[k] + ' invalid');
    if (cfg.or_minutes % cfg.candle_minutes) throw new Error('or_minutes must be a multiple of candle_minutes');
    if (cfg.confirm_window < 1 || cfg.max_trades < 1 || cfg.lots < 1) throw new Error('confirm_window, max_trades and lots must be >= 1');
    return cfg;
  }

  function impliedVol(cp, price, s, k, t) {
    const intrinsic = cp === 'CE' ? Math.max(0, s - k) : Math.max(0, k - s);
    if (t <= 0 || price <= intrinsic + 1e-9) return NaN;
    let lo = 0.005, hi = 3.0;
    for (let n = 0; n < 60; n++) { const mid = (lo + hi) / 2; if (bs(cp, s, k, t, mid) > price) hi = mid; else lo = mid; }
    return (lo + hi) / 2;
  }
  function bsDelta(cp, s, k, t, vol) {
    if (!(vol > 0) || t <= 0) return NaN;
    const sd = vol * Math.sqrt(t), d1 = (Math.log(s / k) + 0.5 * sd * sd) / sd;
    return cp === 'CE' ? ncdf(d1) : ncdf(d1) - 1;
  }
  function breakoutDir(c, orh, orl, cfg) {
    if (c.h > orh && c.l < orl) {
      if (cfg.both_sides_rule === 'close_direction') return c.c > c.o ? 1 : c.c < c.o ? -1 : 0;
      return 2;
    }
    const d = cfg.breakout_def, rng = c.h - c.l, body = Math.abs(c.c - c.o);
    if (d === 'wick') return c.h > orh ? 1 : c.l < orl ? -1 : 0;
    if (d === 'close') return c.c > orh ? 1 : c.c < orl ? -1 : 0;
    if (d === 'close_buffer') { const b = cfg.breakout_buffer; return c.c > orh + b ? 1 : c.c < orl - b ? -1 : 0; }
    const strong = rng > 0 && body / rng >= cfg.min_body_ratio;
    if (strong && c.c > orh && c.c > c.o) return 1;
    if (strong && c.c < orl && c.c < c.o) return -1;
    return 0;
  }
  function isReversal(c, prev, d, orh, orl, cfg) {
    const rd = cfg.reversal_def;
    if (rd === 'opposite_color') return d === 1 ? c.c < c.o : c.c > c.o;
    if (rd === 'close_below_prev') { if (!prev) return false; return d === 1 ? c.c < prev.l : c.c > prev.h; }
    if (rd === 'close_inside_range') return d === 1 ? c.c < orh : c.c > orl;
    const rng = c.h - c.l, strong = rng > 0 && Math.abs(c.c - c.o) / rng >= cfg.rev_min_body_ratio;
    return strong && (d === 1 ? c.c < c.o : c.c > c.o);
  }
  function orbSellPx(con, i, cfg, mult) {
    mult = mult == null ? 1 : mult;
    const o = con.o[i];
    if (o == null) return null;
    const bid = barVal(con.bid, i), ask = barVal(con.ask, i);
    let px;
    if (cfg.use_quotes && bid != null && ask != null) px = mult !== 1 ? o - (ask - bid) / 2 * mult : bid;
    else px = o * (1 - cfg.slip_pct / 100 * mult) - cfg.slip_ticks * cfg.tick * mult;
    return Math.max(cfg.tick, roundDown(px, cfg.tick));
  }
  function orbBuyPx(con, i, cfg) {
    const o = con.o[i];
    if (o == null) return null;
    const ask = barVal(con.ask, i), bid = barVal(con.bid, i);
    const px = (cfg.use_quotes && ask != null && bid != null) ? ask : o * (1 + cfg.slip_pct / 100) + cfg.slip_ticks * cfg.tick;
    return roundUp(px, cfg.tick);
  }
  function orbStopSell(con, i, cfg, base) {
    const bid = barVal(con.bid, i), ask = barVal(con.ask, i), m = cfg.stop_slip_mult;
    const px = (cfg.use_quotes && bid != null && ask != null) ? base - (ask - bid) / 2 * m : base * (1 - cfg.slip_pct / 100 * m) - cfg.slip_ticks * cfg.tick * m;
    return Math.max(cfg.tick, roundDown(px, cfg.tick));
  }
  const ckey = (cp, k) => cp + ':' + k;

  function orbSimulate(s, cfg, ctx) {
    ctx = ctx || {};
    const bm = s.bar_minutes, cm = cfg.candle_minutes, orm = cfg.or_minutes;
    const openM = hm(cfg.session_open), exitM = hm(cfg.exit_time), lastEntry = hm(cfg.latest_entry), tick = cfg.tick;
    const res = { date: s.date, symbol: s.symbol, source: s.source || '?', strategy: 'orb', status: 'excluded', reason: null,
      flags: [], events: [], fills: [], trades: [], mtm: [], setups: [], reversals: [], or_high: null, or_low: null };
    if (cm % bm) { res.reason = `candle_minutes ${cm} not a multiple of data interval ${bm}`; return res; }
    if (!cfg.weekdays.includes(weekday(s.date))) { res.status = 'filtered'; res.reason = 'weekday filter'; return res; }
    const candles = resample(s, cm, openM);
    res.candles = candles;
    const cmap = new Map(candles.map(c => [c.t, c]));
    const orC = [];
    for (let k = 0; k < orm / cm; k++) orC.push(cmap.get(openM + k * cm));
    if (orC.some(c => !c || !c.complete)) { res.reason = 'incomplete opening range'; return res; }
    const orh = Math.max(...orC.map(c => c.h)), orl = Math.min(...orC.map(c => c.l)), orEnd = openM + orm;
    const firstOpen = s.und.o.find(x => x != null);
    Object.assign(res, { or_high: orh, or_low: orl, or_mid: (orh + orl) / 2, or_width: orh - orl, or_end: orEnd });
    const spot0 = orC[orC.length - 1].c;
    const orWidthPct = 100 * (orh - orl) / spot0;
    const gapPct = ctx.prev_close && firstOpen != null ? 100 * (firstOpen / ctx.prev_close - 1) : null;
    const exps = s.expiries.map(e => e.expiry).filter(e => e >= s.date).sort();
    const isExpiryDay = exps.length > 0 && exps[0] === s.date;
    Object.assign(res, { or_width_pct: orWidthPct, gap_pct: gapPct, is_expiry_day: isExpiryDay });
    let why = null;
    if (cfg.skip_expiry_day && isExpiryDay) why = 'expiry-day filter';
    else if (!(cfg.min_or_width_pct <= orWidthPct && orWidthPct <= cfg.max_or_width_pct)) why = 'opening-range width filter';
    else if (gapPct != null && !(cfg.min_gap_pct <= gapPct && gapPct <= cfg.max_gap_pct)) why = 'gap filter';
    else if (cfg.max_or_width_rel > 0 && ctx.avg_or_width && (orh - orl) / ctx.avg_or_width > cfg.max_or_width_rel) why = 'opening-range width vs recent sessions filter';
    if (why) { res.status = 'filtered'; res.reason = why; return res; }

    const times = s.times, und = s.und, n = times.length;
    const flags = new Set(), events = [], fills = [], trades = [], setups = [], reversals = [], mtm = [];
    const st = { setup: null, pos: null, pending: null, done: false, doneReason: null, dirsDone: new Set(), lastExitT: -1, consec: 0, lastDir: null };
    let realizedNet = 0;
    const ev = (t, kind, text, extra) => events.push(Object.assign({ t, kind, text }, extra || {}));
    const r2 = x => x.toFixed(2);

    const chooseContract = (i, d) => {
      const spot = und.c[i - 1], cp = d === 1 ? 'CE' : 'PE';
      const choices = [];
      for (const ex of [...s.expiries].sort((a, b) => (a.expiry < b.expiry ? -1 : a.expiry > b.expiry ? 1 : 0))) {
        if (ex.expiry < s.date) continue;
        const ks = [...new Set(Object.keys(ex.contracts).filter(k => k.startsWith(cp) && ex.contracts[k].o[i] != null).map(k => +k.split(':')[1]))].sort((a, b) => a - b);
        if (ks.length) choices.push([ex, ks]);
      }
      const pick = cfg.expiry_choice === 'nearest' ? 0 : 1;
      if (choices.length <= pick) return null;
      const [ex, ks] = choices[pick];
      let k;
      if (cfg.strike_mode === 'offset') {
        let ai = 0;
        for (let j = 1; j < ks.length; j++) if (Math.abs(ks[j] - spot) < Math.abs(ks[ai] - spot)) ai = j;
        const j = cp === 'CE' ? ai - cfg.strike_offset : ai + cfg.strike_offset;
        if (j < 0 || j >= ks.length) return null;
        k = ks[j];
      } else {
        const dte = dayDiff(s.date, ex.expiry), tau = (dte + Math.max(0, 930 - times[i]) / 375) / 365;
        let best = null, bd = null;
        for (const kk of ks) {
          const px = ex.contracts[ckey(cp, kk)].o[i];
          const dl = Math.abs(bsDelta(cp, spot, kk, tau, impliedVol(cp, px, spot, kk, tau)));
          if (dl === dl && (bd == null || Math.abs(dl - cfg.target_delta) < bd - 1e-12)) { best = kk; bd = Math.abs(dl - cfg.target_delta); }
        }
        if (best == null) return null;
        k = best;
      }
      return [ex, cp, k, spot];
    };

    const closePos = (t, px, reason, intrabar) => {
      const p = st.pos, c = fillCost('SELL', px, p.qty, cfg);
      fills.push({ t, trade: p.id, side: p.cp, strike: p.strike, expiry: p.expiry, action: 'SELL', px, qty: p.qty, reason, intrabar: !!intrabar, cost: c.total, costs: c });
      Object.assign(p, { exit_t: t, exit_px: px, exit_reason: reason, cost: p.cost + c.total });
      p.gross = (px - p.entry_px) * p.qty; p.net = p.gross - p.cost; p.hold_min = t - p.entry_t;
      trades.push(p);
      realizedNet += p.net;
      ev(t, 'exit', `SELL ${p.cp} ${p.strike} @ ${r2(px)} (${reason}); trade net ₹${fmtInt(p.net)}`, { trade: p.id });
      st.pos = null; st.lastExitT = t; st.lastDir = p.dir;
      st.consec = p.net <= 0 ? st.consec + 1 : 0;
      if (trades.length >= cfg.max_trades) { st.done = true; st.doneReason = st.doneReason || 'max trades reached'; }
      if (cfg.max_consecutive_losses && st.consec >= cfg.max_consecutive_losses) { st.done = true; st.doneReason = 'max consecutive losses'; }
    };
    const exitMarket = (i, reason, mult) => {
      const p = st.pos;
      let j = i;
      while (j < n && p.con.o[j] == null) j++;
      if (j < n) { if (j !== i) flags.add('exit_delayed_missing_data'); closePos(times[j], orbSellPx(p.con, j, cfg, mult), reason); }
      else {
        flags.add('exit_price_missing');
        j = i;
        while (j > 0 && p.con.c[j] == null) j--;
        closePos(times[j] + bm, Math.max(tick, roundDown(p.con.c[j] * (1 - cfg.slip_pct / 100) - cfg.slip_ticks * tick, tick)), reason);
      }
    };
    const dirAllowed = d => {
      if (st.dirsDone.has(d)) return false;
      if (trades.length) {
        if (d === st.lastDir && !cfg.allow_same_dir) return false;
        if (d !== st.lastDir && !cfg.allow_opposite_dir) return false;
      }
      return true;
    };
    const newSetup = (c, d, tEnd) => {
      const kind = (d === 1 && c.c > orh) || (d === -1 && c.c < orl) ? 'closed outside' : 'wick only';
      const su = { t: c.t, dir: d, h: c.h, l: c.l, age: 0, kind, status: 'pending' };
      setups.push(su); st.setup = su;
      ev(tEnd, 'breakout', `${d === 1 ? 'Bullish' : 'Bearish'} breakout candle ${fmtHM(c.t)} (${kind}): H ${r2(c.h)} L ${r2(c.l)} vs OR ${r2(orl)}–${r2(orh)}`);
    };
    const endSetup = (status, tEnd, text) => {
      const su = st.setup;
      su.status = status;
      if (status === 'failed' && cfg.setup_refresh === 'first_only') st.dirsDone.add(su.dir);
      ev(tEnd, 'setup_' + status, text);
      st.setup = null;
    };
    const tryConfirm = (closePx, tSig, src) => {
      const su = st.setup, d = su.dir;
      const dist = d === 1 ? closePx - orh : orl - closePx, chase = d === 1 ? closePx - su.h : su.l - closePx;
      if (cfg.min_break_dist > 0 && dist < cfg.min_break_dist) { endSetup('rejected', tSig, `confirmation ${src} but close is only ${r2(dist)} pts beyond the range (< ${cfg.min_break_dist})`); return false; }
      if (cfg.max_chase > 0 && chase > cfg.max_chase) { endSetup('rejected', tSig, `confirmation ${src} but close is ${r2(chase)} pts past the breakout extreme (> ${cfg.max_chase})`); return false; }
      su.status = 'confirmed'; su.confirm_t = tSig;
      ev(tSig, 'confirm', `Confirmed ${src}: ${d === 1 ? 'high' : 'low'} beyond breakout ${d === 1 ? 'high' : 'low'} ${r2(d === 1 ? su.h : su.l)}; buy ${d === 1 ? 'call' : 'put'} at next open`);
      st.pending = { type: 'buy', dir: d, setup: su };
      st.setup = null;
      return true;
    };

    let startI = times.findIndex(t => t >= orEnd);
    if (startI < 0) startI = n;
    let lastI = startI;
    const candIdx = new Map(candles.map((c, j) => [c.t, j]));
    for (let i = startI; i < n; i++) {
      const t = times[i];
      lastI = i;
      if (t >= exitM) { if (st.pos) exitMarket(i, 'eod', 1); st.pending = null; break; }
      const pend = st.pending;
      st.pending = null;
      if (pend && pend.type === 'buy') {
        const pick = i > 0 && und.c[i - 1] != null ? chooseContract(i, pend.dir) : null;
        if (!pick) { flags.add('entry_contract_unavailable'); ev(t, 'cancel', 'entry cancelled: no option price for the selected strike'); }
        else {
          const [ex, cp, k, spot] = pick;
          const con = ex.contracts[ckey(cp, k)];
          const px = orbBuyPx(con, i, cfg), qty = cfg.lots * ex.lot_size, c = fillCost('BUY', px, qty, cfg);
          const p = { id: trades.length + 1, dir: pend.dir, cp, strike: k, expiry: ex.expiry, con, qty, lot_size: ex.lot_size, entry_t: t, entry_px: px,
            spot_ref: spot, cost: c.total, level: null, level_from: null, setup_t: pend.setup.t, mae: 0, mfe: 0, target: null, index_target: null, estop: null, last_px: px };
          if (cfg.target_basis === 'premium') p.target = roundUp(px + cfg.target_points, tick);
          else if (cfg.target_basis === 'index') p.index_target = spot + pend.dir * cfg.target_points;
          if (cfg.emergency_stop_pct > 0) p.estop = roundDown(px * (1 - cfg.emergency_stop_pct / 100), tick);
          st.pos = p;
          fills.push({ t, trade: p.id, side: cp, strike: k, expiry: ex.expiry, action: 'BUY', px, qty, reason: 'entry', intrabar: false, cost: c.total, costs: c });
          const tgtTxt = p.target != null ? `target premium ${r2(p.target)} (+${cfg.target_points} premium pts)`
            : p.index_target != null ? `target index ${r2(p.index_target)} (${pend.dir === 1 ? '+' : '−'}${cfg.target_points} index pts)` : 'no target';
          ev(t, 'entry', `BUY ${cp} ${k} (${ex.expiry}) @ ${r2(px)}, qty ${qty}, spot ${r2(spot)}; ${tgtTxt}`, { trade: p.id });
        }
      } else if (pend && pend.type === 'sell' && st.pos) {
        exitMarket(i, pend.reason, ['structural', 'max_loss', 'time'].includes(pend.reason) ? cfg.stop_slip_mult : 1);
      }

      let p = st.pos;
      if (p && p.entry_t <= t) {
        const con = p.con, ob = con.o[i] != null;
        if (!ob) flags.add('option_bar_missing');
        let limitFill = null, estopFill = null, trig = null;
        if (ob) {
          if (p.estop != null && con.l[i] <= p.estop) estopFill = orbStopSell(con, i, cfg, Math.min(p.estop, con.o[i]));
          if (p.target != null) {
            if (cfg.target_exec === 'limit' && con.h[i] >= p.target + tick) limitFill = Math.max(p.target, con.o[i]);
            else if (cfg.target_exec === 'trigger_next_open' && con.h[i] >= p.target) trig = 'target';
            else if (cfg.target_exec === 'close_next_open' && con.c[i] >= p.target) trig = 'target';
          }
        }
        if (p.index_target != null && und.h[i] != null) {
          const lvl = p.index_target;
          const hit = cfg.target_exec === 'close_next_open' ? (p.dir === 1 ? und.c[i] >= lvl : und.c[i] <= lvl) : (p.dir === 1 ? und.h[i] >= lvl : und.l[i] <= lvl);
          if (hit) trig = 'target';
        }
        let struct = false;
        if (p.level != null && t >= p.level_from && und.l[i] != null) {
          if (cfg.stop_trigger === 'wick') struct = p.dir === 1 ? und.l[i] < p.level : und.h[i] > p.level;
          else struct = p.dir === 1 ? und.c[i] < p.level : und.c[i] > p.level;
        }
        if (cfg.max_hold_minutes && t + bm - p.entry_t >= cfg.max_hold_minutes && !trig && !struct) trig = 'time';
        const stopLike = estopFill != null || struct, targetLike = limitFill != null || trig === 'target';
        if (stopLike && targetLike) flags.add('same_bar_target_stop');
        if (estopFill != null && (limitFill == null || cfg.same_bar_rule === 'stop_first')) {
          ev(t, 'emergency_stop', `option low ${r2(con.l[i])} ≤ emergency stop ${r2(p.estop)}`);
          closePos(t, estopFill, 'emergency_stop', true);
        } else if (limitFill != null && (!struct || cfg.same_bar_rule === 'target_first')) {
          ev(t, 'target', `option high ${r2(con.h[i])} traded through target ${r2(p.target)}`);
          closePos(t, limitFill, 'target', true);
        } else if (struct) {
          const reason = trig === 'target' && cfg.same_bar_rule === 'target_first' ? 'target' : 'structural';
          ev(t, reason === 'structural' ? 'structural' : 'target', reason === 'structural'
            ? `index ${p.dir === 1 ? 'low' : 'high'} ${r2(p.dir === 1 ? und.l[i] : und.h[i])} broke structural level ${r2(p.level)}; sell at next open`
            : 'target and structural level in the same bar; target_first assumed');
          st.pending = { type: 'sell', reason };
        } else if (trig) {
          ev(t, trig, (trig === 'target' ? 'target reached' : `max holding ${cfg.max_hold_minutes} min`) + '; sell at next open');
          st.pending = { type: 'sell', reason: trig };
        }
      }

      p = st.pos;
      let unreal = 0;
      if (p) {
        const con = p.con;
        if (con.c[i] != null) {
          p.last_px = con.c[i];
          p.mae = Math.min(p.mae, (con.l[i] - p.entry_px) * p.qty);
          p.mfe = Math.max(p.mfe, (con.h[i] - p.entry_px) * p.qty);
        }
        unreal = (p.last_px - p.entry_px) * p.qty - p.cost - fillCost('SELL', p.last_px, p.qty, cfg).total;
      }
      const netNow = realizedNet + unreal;
      mtm.push({ t: t + bm, net: netNow, pos: !!p, px: p ? p.last_px : null });
      if (p && cfg.max_loss_per_lot > 0 && netNow <= -cfg.max_loss_per_lot * cfg.lots && !st.pending) {
        st.pending = { type: 'sell', reason: 'max_loss' }; st.done = true; st.doneReason = 'daily loss limit';
        ev(t + bm, 'max_loss', `daily loss limit hit (₹${fmtInt(netNow)}); sell at next open`);
      }
      if (!p && !st.pending && cfg.max_loss_per_lot > 0 && realizedNet <= -cfg.max_loss_per_lot * cfg.lots) { st.done = true; st.doneReason = 'daily loss limit'; }

      const tEnd = t + bm;
      let su = st.setup;
      if (cfg.entry_exec === 'fine_break' && su && !st.pos && !st.pending && !st.done && t >= su.t + cm && tEnd <= lastEntry && und.h[i] != null) {
        const cidx = Math.floor((t - openM) / cm) * cm + openM;
        if (Math.floor((cidx - su.t) / cm) <= cfg.confirm_window) {
          const hit = su.dir === 1 ? und.h[i] > su.h + cfg.confirm_buffer : und.l[i] < su.l - cfg.confirm_buffer;
          if (hit) tryConfirm(und.c[i], tEnd, `by ${bm}-min bar ${fmtHM(t)}`);
        }
      }

      if ((tEnd - openM) % cm !== 0) continue;
      const cst = tEnd - cm, c = cmap.get(cst);
      if (!c || !c.complete) continue;
      p = st.pos;
      if (p && cst >= p.entry_t) {
        const ci = candIdx.get(cst), prev = ci > 0 ? candles[ci - 1] : null;
        if (isReversal(c, prev, p.dir, orh, orl, cfg)) {
          const lvl = p.dir === 1 ? c.l - cfg.stop_buffer : c.h + cfg.stop_buffer;
          if (p.level == null || cfg.rev_update === 'latest') {
            p.level = lvl; p.level_from = tEnd;
            reversals.push({ t: cst, level: lvl, trade: p.id });
            ev(tEnd, 'reversal', `Reversal candle ${fmtHM(cst)} (${cfg.reversal_def.replace(/_/g, ' ')}); structural exit level ${r2(lvl)} (= ${p.dir === 1 ? 'low' : 'high'} ${r2(p.dir === 1 ? c.l : c.h)} ${p.dir === 1 ? '−' : '+'} ${cfg.stop_buffer} buffer)`);
          }
        }
      }
      if (st.pos || st.pending || st.done || cst < orEnd) continue;
      if (cst < st.lastExitT) continue;
      if (tEnd > lastEntry) { if (st.setup) endSetup('expired', tEnd, 'latest entry time passed before confirmation'); continue; }
      let d = breakoutDir(c, orh, orl, cfg), outside = false;
      if (d === 2) {
        if (cfg.both_sides_rule === 'skip_day') {
          if (st.setup) endSetup('cancelled', tEnd, 'outside candle');
          st.done = true; st.doneReason = 'candle broke both sides of the range';
          ev(tEnd, 'outside', `Candle ${fmtHM(cst)} broke both ORH and ORL: no trade today (skip_day)`);
          continue;
        }
        ev(tEnd, 'outside', `Candle ${fmtHM(cst)} broke both ORH and ORL: ignored (ignore_candle)`);
        d = 0; outside = true;
      }
      su = st.setup;
      if (su) {
        su.age += 1;
        if (cfg.entry_exec === 'candle_close' && !outside) {
          const hit = su.dir === 1 ? c.h > su.h + cfg.confirm_buffer : c.l < su.l - cfg.confirm_buffer;
          if (hit) { tryConfirm(c.c, tEnd, `by candle ${fmtHM(cst)}`); continue; }
        }
        if (cfg.cancel_inside_range && ((su.dir === 1 && c.c <= orh) || (su.dir === -1 && c.c >= orl))) { endSetup('cancelled', tEnd, `candle ${fmtHM(cst)} closed back inside the range`); continue; }
        else if (d === -su.dir && cfg.cancel_on_opposite) {
          endSetup('cancelled', tEnd, `opposite side broke at ${fmtHM(cst)} before confirmation`);
          st.done = true; st.doneReason = 'opposite side broke before confirmation';
          continue;
        } else if (d !== 0 && cfg.setup_refresh === 'rolling') { endSetup('replaced', tEnd, `candle ${fmtHM(cst)} is a new breakout candle`); }
        else if (su.age >= cfg.confirm_window) { endSetup('failed', tEnd, `not confirmed within ${cfg.confirm_window} candle(s): failed breakout`); }
        else continue;
      }
      if (st.setup == null && d !== 0 && dirAllowed(d) && !st.done) newSetup(c, d, tEnd);
    }
    if (st.pos) {
      flags.add('session_data_ended');
      const p = st.pos;
      let j = lastI;
      while (j > 0 && p.con.c[j] == null) j--;
      closePos(times[j] + bm, Math.max(tick, roundDown(p.con.c[j] * (1 - cfg.slip_pct / 100) - cfg.slip_ticks * tick, tick)), 'data_end');
    }
    if (st.setup) st.setup.status = 'expired';
    for (const tr of trades) delete tr.con;
    const gross = trades.reduce((a, x) => a + x.gross, 0), costs = fills.reduce((a, f) => a + f.cost, 0);
    Object.assign(res, { events: events.slice().sort((a, b) => a.t - b.t), fills, trades, setups, reversals, mtm, flags: [...flags].sort() });
    if (trades.length) {
      Object.assign(res, { status: 'traded', gross, costs, net: gross - costs, n_trades: trades.length,
        mae: Math.min(0, ...mtm.map(m => m.net)), mfe: Math.max(0, ...mtm.map(m => m.net)), exit_reason: trades[trades.length - 1].exit_reason });
    } else {
      res.status = 'no_entry';
      res.reason = st.doneReason ? st.doneReason : !setups.length ? 'no breakout before latest entry'
        : setups.some(x => x.status === 'confirmed') ? 'entry cancelled (no option price)' : 'breakout not confirmed';
    }
    return res;
  }

  function orbContexts(sessions, lookback, orMinutes, candleMinutes) {
    const out = {}, widths = [];
    let prevClose = null;
    for (const s of sessions.slice().sort((a, b) => (a.date < b.date ? -1 : 1))) {
      const w = widths.slice(-lookback);
      out[s.date] = { prev_close: prevClose, avg_or_width: w.length ? w.reduce((a, b) => a + b, 0) / w.length : null };
      const orc = resample(s, candleMinutes, 555).filter(c => c.t < 555 + orMinutes);
      if (orc.length) widths.push(Math.max(...orc.map(c => c.h)) - Math.min(...orc.map(c => c.l)));
      const closes = s.und.c.filter(x => x != null);
      if (closes.length) prevClose = closes[closes.length - 1];
    }
    return out;
  }

  function orbMetrics(results, lots, marginPerLot) {
    const m = dailyCore(results, lots, marginPerLot);
    const trades = results.filter(r => r.status === 'traded').flatMap(r => r.trades);
    m.trades = trades.length;
    if (!trades.length) return m;
    const pn = trades.map(t => t.net), n = pn.length, wins = pn.filter(x => x > 0), losses = pn.filter(x => x <= 0);
    const mean = sum(pn) / n, sd = n > 1 ? Math.sqrt(sum(pn.map(x => (x - mean) ** 2)) / (n - 1)) : 0;
    const reasons = count(trades.map(t => t.exit_reason)), rc = k => reasons[k] || 0;
    Object.assign(m, {
      trade_win_rate: 100 * wins.length / n, trade_avg_win: wins.length ? sum(wins) / wins.length : null,
      trade_avg_loss: losses.length ? sum(losses) / losses.length : null, expectancy: mean,
      trade_t_stat: sd > 0 ? mean / (sd / Math.sqrt(n)) : null,
      trade_profit_factor: losses.length && sum(losses) < 0 ? sum(wins) / -sum(losses) : null,
      avg_hold_min: sum(trades.map(t => t.hold_min)) / n,
      target_rate: 100 * rc('target') / n, structural_rate: 100 * rc('structural') / n, eod_rate: 100 * rc('eod') / n,
      other_exit_rate: 100 * (n - rc('target') - rc('structural') - rc('eod')) / n,
      avg_mae: sum(trades.map(t => t.mae)) / n, avg_mfe: sum(trades.map(t => t.mfe)) / n,
      avg_premium_paid: sum(trades.map(t => t.entry_px)) / n,
      long_call_trades: trades.filter(t => t.dir === 1).length, long_put_trades: trades.filter(t => t.dir === -1).length,
      trade_exit_reasons: reasons,
    });
    const sts = results.flatMap(r => r.setups || []);
    m.breakouts = sts.length;
    m.breakout_outcomes = count(sts.map(x => x.status));
    return m;
  }

  function orbRun(sessions, cfg, marginPerLot) {
    const ctxs = orbContexts(sessions, cfg.or_avg_lookback, cfg.or_minutes, cfg.candle_minutes);
    const results = sessions.map(s => orbSimulate(s, cfg, ctxs[s.date]));
    return { config: cfg, config_hash: hashConfig(cfg), results, metrics: orbMetrics(results, cfg.lots, marginPerLot) };
  }

  const ORB_VARIANTS = [
    ['—', 'Baseline rules', {}],
    ['A', 'Close breakout', { breakout_def: 'close' }],
    ['A', 'Close + 5 pt buffer', { breakout_def: 'close_buffer', breakout_buffer: 5 }],
    ['A', 'Strong-body breakout (≥50%)', { breakout_def: 'body_strength' }],
    ['A', 'OR width ≤ 0.6% of spot', { max_or_width_pct: 0.6 }],
    ['A', 'OR width ≤ 1.2× recent average', { max_or_width_rel: 1.2 }],
    ['A', 'Cancel if back inside range', { cancel_inside_range: true, confirm_window: 3 }],
    ['B', 'Confirm within 2 candles', { confirm_window: 2 }],
    ['B', 'Confirm within 3 candles', { confirm_window: 3 }],
    ['B', 'Confirm with 5 pt buffer', { confirm_buffer: 5 }],
    ['B', 'Cancel if opposite side breaks', { cancel_on_opposite: true, confirm_window: 3 }],
    ['B', 'Confirm on 1-min bars (fine_break)', { entry_exec: 'fine_break' }],
    ['C', 'One strike ITM', { strike_offset: 1 }],
    ['C', 'One strike OTM', { strike_offset: -1 }],
    ['C', 'Delta 0.40 (computed)', { strike_mode: 'delta', target_delta: 0.4 }],
    ['D', 'Target 20 premium pts', { target_points: 20 }],
    ['D', 'Target 40 premium pts', { target_points: 40 }],
    ['D', 'Target 30 index pts', { target_basis: 'index' }],
    ['D', 'No target (structural / EOD only)', { target_basis: 'none' }],
    ['E', 'Reversal = close below previous low', { reversal_def: 'close_below_prev' }],
    ['E', 'Reversal = close back inside range', { reversal_def: 'close_inside_range' }],
    ['E', 'Reversal + 5 pt buffer', { stop_buffer: 5 }],
    ['E', 'Stop on candle close only', { stop_trigger: 'close' }],
    ['E', 'Emergency stop 30% of premium', { emergency_stop_pct: 30 }],
    ['E', 'Max holding 60 min', { max_hold_minutes: 60 }],
    ['F', 'Skip expiry day', { skip_expiry_day: true }],
    ['F', 'Latest entry 12:00', { latest_entry: '12:00' }],
    ['F', 'Second trade, opposite direction allowed', { max_trades: 2, allow_opposite_dir: true }],
    ['F', 'Daily loss limit ₹2,000', { max_loss_per_lot: 2000 }],
  ];

  const ORB_SCENARIOS = {
    clean_bull: { label: 'Clean bullish breakout, target hit', rv: 9.0, trend_pct: 0.9, trend_start: '09:50', trend_end: '12:30', seed: 4 },
    clean_bear: { label: 'Clean bearish breakdown, target hit', rv: 9.0, trend_pct: -0.9, trend_start: '09:50', trend_end: '12:30', seed: 7 },
    fakeout: { label: 'Breakout reverses after entry', rv: 8.0, trend_pct: 0.4, trend_start: '09:45', trend_end: '10:15', trend2_pct: -0.8, trend2_start: '10:15', trend2_end: '11:30', seed: 2 },
    choppy: { label: 'Choppy range, structural loss', rv: 6.0, mean_revert: 0.03, seed: 5 },
    not_confirmed: { label: 'Breakout not confirmed (no trade)', rv: 3.0, mean_revert: 0.2, jump_time: '09:25', jump_pct: 0.4, seed: 3 },
    no_breakout: { label: 'Wide opening range, no breakout', rv: 3.0, mean_revert: 0.2, jump_time: '09:25', jump_pct: 0.4, seed: 2 },
    iv_crush: { label: 'Index edges up, premium falls (IV)', rv: 7.0, iv: 18.0, iv_drift: -8.0, trend_pct: 0.35, trend_start: '09:50', trend_end: '14:00', seed: 6 },
    gap_through: { label: 'Index jumps through the structural level', rv: 6.0, trend_pct: 0.6, trend_start: '09:50', trend_end: '11:00', jump_time: '10:25', jump_pct: -0.8, seed: 5 },
    slow_grind: { label: 'Slow grind, reversal candle exits early', rv: 5.0, trend_pct: 0.5, trend_start: '09:50', trend_end: '15:30', seed: 11 },
    expiry_day: { label: 'Expiry day (0 DTE premium)', rv: 10.0, dte: 0, trend_pct: 0.7, trend_start: '09:50', trend_end: '12:00', seed: 4 },
    illiquid: { label: 'Illiquid option, wide spread, gaps', rv: 9.0, trend_pct: 0.8, trend_start: '09:50', trend_end: '12:00', spread_pct: 5.0, missing_prob: 0.1, seed: 1 },
  };

  function orbCommentary(r, cfg) {
    const rs = x => (x < 0 ? '−₹' : '₹') + Math.round(Math.abs(x)).toLocaleString('en-IN');
    const src = r.source === 'synthetic' ? 'Illustrative synthetic session (model-generated, not market data). ' : r.source === 'csv' ? 'User-supplied data. ' : '';
    const out = [];
    const sts = r.setups || [];
    const conf = sts.filter(x => x.status === 'confirmed');
    out.push(['Breakout signal', src + (r.or_high == null ? `Session ${r.status}: ${r.reason}.` : !sts.length
      ? `No candle broke the ${r2s(r.or_low)}–${r2s(r.or_high)} range under the '${cfg.breakout_def}' definition before ${cfg.latest_entry}.`
      : sts.map(x => `${fmtHM(x.t)} ${x.dir === 1 ? 'bullish' : 'bearish'} (${x.kind}) → ${x.status}`).join('; ') + '.')]);
    out.push(['Confirmation', conf.length ? `Confirmed ${conf.length} time(s); the strict rule needs the next candle to break the breakout candle's ${conf[0].dir === 1 ? 'high' : 'low'}.`
      : sts.length ? `No breakout was confirmed within ${cfg.confirm_window} candle(s). Failed breakouts: ${sts.filter(x => x.status === 'failed').length}.` : 'Nothing to confirm.']);
    if (r.status !== 'traded') {
      out.push(['Outcome', `No trade: ${r.reason}.`]);
      out.push(['Next experiment', 'Compare wick vs close breakouts and a 2–3 candle confirmation window across many sessions to see whether skipped days were better or worse than traded days.']);
      return out;
    }
    const tr = r.trades;
    out.push(['Why a call or put', tr.map(t => `${t.dir === 1 ? 'Bullish → bought call' : 'Bearish → bought put'} ${t.strike} at ${r2s(t.entry_px)} (spot ${r2s(t.spot_ref)})`).join('; ') + '.']);
    out.push(['Premium vs index', tr.map(t => `held ${t.hold_min} min: premium ${r2s(t.entry_px)} → ${r2s(t.exit_px)} (${t.exit_px - t.entry_px >= 0 ? '+' : ''}${r2s(t.exit_px - t.entry_px)} premium pts)`).join('; ') +
      '. Index points and premium points differ by the option\'s delta, plus IV and time-decay effects.']);
    out.push(['What closed the trade', tr.map(t => `${t.exit_reason.replace('_', ' ')} at ${fmtHM(t.exit_t)}`).join('; ') + '.']);
    out.push(['Costs and slippage', `Charges ${rs(r.costs)} on gross ${rs(r.gross)} → net ${rs(r.net)}. Fills ${cfg.use_quotes ? 'at bid/ask where present, else ' : ''}${cfg.slip_pct}% + ${cfg.slip_ticks} tick; structural exits ×${cfg.stop_slip_mult}.`]);
    const worst = Math.min(...tr.map(t => t.mae));
    out.push(['Adverse movement allowed', `Worst open loss inside a trade ${rs(worst)}. ${(r.reversals || []).length ? '' : 'No reversal candle formed, so no structural level existed for part of the trade. '}The structural exit is not a loss limit; the most a long option can lose is its premium plus costs.`]);
    out.push(['Flags', r.flags.length ? r.flags.join(', ') : 'none']);
    out.push(['Next experiment', tr.some(t => t.exit_reason === 'structural' && t.net < 0) ? 'Test the reversal definition and a 5-point buffer: opposite-colour candles are common, so the default may exit on noise.'
      : 'Compare premium-point and index-point targets; they are not equivalent.']);
    return out;
  }
  function r2s(x) { return x == null || !isFinite(x) ? '—' : x.toFixed(2); }

  const STRATEGIES = {
    straddle: { make: makeConfig, run: runBacktest, defaults: DEFAULTS },
    orb: { make: orbMakeConfig, run: orbRun, defaults: ORB_DEFAULTS },
  };
  const ORB = { DEFAULTS: ORB_DEFAULTS, ENUMS: ORB_ENUMS, makeConfig: orbMakeConfig, simulate: orbSimulate, contexts: orbContexts,
    metrics: orbMetrics, run: orbRun, VARIANTS: ORB_VARIANTS, SCENARIOS: ORB_SCENARIOS, commentary: orbCommentary, impliedVol, bsDelta };

  // ------------------------------------------------------------------ CSV import (same rules as straddle_lab/data.py)
  function parseCSV(text) {
    const rows = [];
    let row = [], f = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (q) {
        if (ch === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; }
        else f += ch;
      } else if (ch === '"') q = true;
      else if (ch === ',') { row.push(f); f = ''; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text[i + 1] === '\n') i++;
        row.push(f); f = '';
        if (row.length > 1 || row[0] !== '') rows.push(row);
        row = [];
      } else f += ch;
    }
    if (f !== '' || row.length) { row.push(f); rows.push(row); }
    if (!rows.length) return { header: [], rows: [] };
    const header = rows[0].map(h => h.trim().toLowerCase());
    return { header, rows: rows.slice(1).map(r => Object.fromEntries(header.map((h, i) => [h, (r[i] || '').trim()]))) };
  }

  // -> {date:'YYYY-MM-DD', m: minutes} in IST, or null
  function parseTs(s) {
    s = (s || '').trim();
    let mt = s.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/);
    if (!mt) return null;
    let date = mt[1], h = +mt[2], mi = +mt[3];
    if (mt[5]) {
      let off = 0;
      if (mt[5] !== 'Z') { const sign = mt[5][0] === '-' ? -1 : 1; const d = mt[5].slice(1).replace(':', ''); off = sign * (+d.slice(0, 2) * 60 + +d.slice(2)); }
      const utc = Date.parse(date + 'T00:00:00Z') + (h * 60 + mi - off) * 60000;
      const ist = new Date(utc + 330 * 60000);
      date = ist.toISOString().slice(0, 10); h = ist.getUTCHours(); mi = ist.getUTCMinutes();
    }
    return { date, m: h * 60 + mi };
  }

  function loadCSV(underText, optText, symbol) {
    const rep = { errors: [], warnings: [], days: {} };
    const U = parseCSV(underText), O = parseCSV(optText);
    const need = [['underlying', U, ['timestamp', 'open', 'high', 'low', 'close']],
      ['options', O, ['timestamp', 'expiry', 'strike', 'option_type', 'open', 'high', 'low', 'close', 'lot_size']]];
    for (const [name, d, cols] of need) {
      const miss = cols.filter(c => !d.header.includes(c));
      if (miss.length) rep.errors.push(`${name}: missing columns [${miss.join(', ')}]`);
    }
    if (rep.errors.length) return { sessions: [], report: rep };
    const num = v => (v === '' || v == null ? NaN : +v);
    const okOHLC = r => [r.o, r.h, r.l, r.c].every(x => isFinite(x) && x > 0) && r.h >= Math.max(r.o, r.c) && r.l <= Math.min(r.o, r.c);
    let badTs = 0, badOhlcU = 0, badOhlcO = 0, badType = 0, badMeta = 0, crossed = 0, outU = 0, outO = 0, dupU = 0, dupO = 0, afterExp = 0;
    const und = [];
    const seenU = new Set();
    for (const r of U.rows) {
      const ts = parseTs(r.timestamp);
      if (!ts) { badTs++; continue; }
      const x = { date: ts.date, m: ts.m, o: num(r.open), h: num(r.high), l: num(r.low), c: num(r.close) };
      if (!okOHLC(x)) { badOhlcU++; continue; }
      const key = x.date + ' ' + x.m;
      if (seenU.has(key)) { dupU++; continue; }
      seenU.add(key);
      if (x.m < 555 || x.m >= 930) { outU++; continue; }
      und.push(x);
    }
    const opts = [];
    const seenO = new Set();
    const hasQ = O.header.includes('bid') && O.header.includes('ask');
    for (const r of O.rows) {
      const ts = parseTs(r.timestamp);
      if (!ts) { badTs++; continue; }
      let cp = (r.option_type || '').toUpperCase();
      cp = { CALL: 'CE', PUT: 'PE', C: 'CE', P: 'PE' }[cp] || cp;
      if (cp !== 'CE' && cp !== 'PE') { badType++; continue; }
      const strike = num(r.strike), lot = num(r.lot_size);
      const expM = (r.expiry || '').match(/^(\d{4}-\d{2}-\d{2})/);
      if (!isFinite(strike) || !isFinite(lot) || lot <= 0 || !expM) { badMeta++; continue; }
      const x = { date: ts.date, m: ts.m, expiry: expM[1], strike, cp, lot, o: num(r.open), h: num(r.high), l: num(r.low), c: num(r.close),
        bid: hasQ ? num(r.bid) : NaN, ask: hasQ ? num(r.ask) : NaN };
      if (!okOHLC(x)) { badOhlcO++; continue; }
      if (isFinite(x.bid) && isFinite(x.ask) && x.bid > x.ask) { crossed++; x.bid = NaN; x.ask = NaN; }
      const key = [x.date, x.m, x.expiry, x.strike, x.cp].join('|');
      if (seenO.has(key)) { dupO++; continue; }
      seenO.add(key);
      if (x.m < 555 || x.m >= 930) { outO++; continue; }
      if (x.expiry < x.date) { afterExp++; continue; }
      opts.push(x);
    }
    if (badTs) rep.warnings.push(`${badTs} rows with unparseable timestamps dropped`);
    if (badType) rep.warnings.push(`${badType} option rows with unknown option_type dropped`);
    if (badMeta) rep.warnings.push(`${badMeta} option rows with bad strike/lot_size/expiry dropped`);
    if (badOhlcU || badOhlcO) rep.warnings.push(`rows with inconsistent/non-positive OHLC dropped: underlying ${badOhlcU}, options ${badOhlcO}`);
    if (crossed) rep.warnings.push(`${crossed} crossed quotes (bid > ask) blanked`);
    if (dupU || dupO) rep.warnings.push(`duplicates dropped: underlying ${dupU}, options ${dupO}`);
    if (outU || outO) rep.warnings.push(`rows outside 09:15–15:30 dropped: underlying ${outU}, options ${outO}`);
    if (afterExp) rep.warnings.push(`${afterExp} option rows quoted after their expiry dropped`);

    const byDate = new Map();
    for (const x of und) { if (!byDate.has(x.date)) byDate.set(x.date, []); byDate.get(x.date).push(x); }
    const diffs = {};
    for (const arr of byDate.values()) {
      arr.sort((a, b) => a.m - b.m);
      for (let i = 1; i < arr.length; i++) { const d = arr[i].m - arr[i - 1].m; diffs[d] = (diffs[d] || 0) + 1; }
    }
    const dk = Object.keys(diffs);
    if (!dk.length) { rep.errors.push('cannot infer bar interval (need ≥2 underlying bars per day)'); return { sessions: [], report: rep }; }
    const bar = +dk.sort((a, b) => diffs[b] - diffs[a] || a - b)[0];
    rep.bar_minutes = bar;
    const grid = [];
    for (let t = 555; t < 930; t += bar) grid.push(t);
    const pos = new Map(grid.map((t, i) => [t, i]));
    let offGrid = 0;
    const optByDate = new Map();
    for (const x of opts) { if (!optByDate.has(x.date)) optByDate.set(x.date, []); optByDate.get(x.date).push(x); }
    const sessions = [];
    for (const date of [...byDate.keys()].sort()) {
      const blank = () => grid.map(() => null);
      const u = { o: blank(), h: blank(), l: blank(), c: blank() };
      for (const x of byDate.get(date)) {
        const i = pos.get(x.m);
        if (i == null) { offGrid++; continue; }
        u.o[i] = x.o; u.h[i] = x.h; u.l[i] = x.l; u.c[i] = x.c;
      }
      const day = { underlying_bars: byDate.get(date).length, expected_bars: grid.length, missing_underlying_bars: u.o.filter(v => v == null).length };
      const exMap = new Map();
      for (const x of optByDate.get(date) || []) {
        if (!exMap.has(x.expiry)) exMap.set(x.expiry, { lots: {}, contracts: {} });
        const e = exMap.get(x.expiry);
        e.lots[x.lot] = (e.lots[x.lot] || 0) + 1;
        const key = x.cp + ':' + x.strike;
        if (!e.contracts[key]) e.contracts[key] = hasQ ? { o: blank(), h: blank(), l: blank(), c: blank(), bid: blank(), ask: blank() } : { o: blank(), h: blank(), l: blank(), c: blank() };
        const con = e.contracts[key], i = pos.get(x.m);
        if (i == null) continue;
        con.o[i] = x.o; con.h[i] = x.h; con.l[i] = x.l; con.c[i] = x.c;
        if (hasQ && isFinite(x.bid) && isFinite(x.ask)) { con.bid[i] = x.bid; con.ask[i] = x.ask; }
      }
      const expiries = [];
      for (const [expiry, e] of [...exMap.entries()].sort()) {
        const lots = Object.keys(e.lots);
        if (lots.length > 1) rep.warnings.push(`${date} expiry ${expiry}: multiple lot sizes ${lots.join('/')}; using the most common`);
        const lot = +lots.sort((a, b) => e.lots[b] - e.lots[a])[0];
        expiries.push({ expiry, lot_size: lot, contracts: e.contracts });
      }
      if (!expiries.length) day.note = 'no option data';
      day.expiries = expiries.length;
      day.contracts = expiries.reduce((a, e) => a + Object.keys(e.contracts).length, 0);
      rep.days[date] = day;
      sessions.push({ date, symbol: symbol || 'NIFTY', source: 'csv', bar_minutes: bar, times: grid, und: u, expiries });
    }
    if (offGrid) rep.warnings.push(`${offGrid} underlying bars not aligned to a ${bar}-minute grid from 09:15 (ignored)`);
    rep.n_sessions = sessions.length;
    return { sessions, report: rep };
  }

  // ------------------------------------------------------------------ research commentary (one session)
  function commentary(r, cfg) {
    const rs = x => (x < 0 ? '−₹' : '₹') + Math.round(Math.abs(x)).toLocaleString('en-IN');
    const out = [];
    const src = r.source === 'synthetic' ? 'Illustrative synthetic session (model-generated, not market data). ' : r.source === 'csv' ? 'User-supplied data. ' : '';
    if (r.status !== 'traded') {
      out.push(['What happened', src + (r.status === 'no_entry'
        ? `No trade. The ${fmtHM(r.check_candle.t)}–${fmtHM(r.check_candle.t + cfg.candle_minutes)} candle (H ${r.check_candle.h.toFixed(2)}, L ${r.check_candle.l.toFixed(2)}, C ${r.check_candle.c.toFixed(2)}) failed the '${cfg.entry_condition}' test against the range ${r.or_low.toFixed(2)}–${r.or_high.toFixed(2)}.`
        : `Session ${r.status}: ${r.reason}.`)]);
      out.push(['Next experiment', 'Compare entry conditions (full / body / close / overlap) on a multi-session dataset to see whether the days skipped by this filter were better or worse than the days traded.']);
      return out;
    }
    const legs = r.legs, init = r.by_kind.initial, re = r.by_kind.reentry;
    const stops = r.fills.filter(f => f.reason === 'stop');
    out.push(['What happened', src + `Entered at ${fmtHM(r.decision_t)}: sold the ${r.atm} straddle (expiry ${r.expiry}, qty ${r.qty}) for ${r.initial_premium.toFixed(2)} points combined. Day ended by ${r.exit_reason.replace('_', ' ')} with net ${rs(r.net)} (gross ${rs(r.gross)}, costs ${rs(r.costs)}).`]);
    out.push(['Why it entered', `The ${fmtHM(r.check_candle.t)} candle satisfied '${cfg.entry_condition}' inside ${r.or_low.toFixed(2)}–${r.or_high.toFixed(2)} (OR width ${r.or_width_pct.toFixed(2)}% of spot).`]);
    out.push(['Which legs made or lost money', legs.map(l => `${l.kind === 'initial' ? 'Initial' : 'Re-entry'} ${l.side} ${l.strike}: sold ${l.entry_px.toFixed(2)}, bought ${l.exit_px.toFixed(2)} (${l.exit_reason}) → ${rs(l.net)} net`).join('; ') + '.']);
    out.push(['Stops and re-entries', stops.length
      ? stops.map(f => `${f.side} ${f.strike} stopped at ${fmtHM(f.t)} for ${f.px.toFixed(2)} vs stop ${f.stop.toFixed(2)}` + (f.px > f.stop + 0.051 ? ` (${(f.px - f.stop).toFixed(2)} worse than the trigger, from gap or slippage)` : '')).join('; ') +
        (r.reentries ? `. ${r.reentries} replacement leg(s) sold under the '${cfg.reentry_trigger}' rule.` : '. No re-entry was taken.')
      : 'No stop was triggered.']);
    out.push(['Initial straddle vs replacements', `Initial legs ${rs(init.net)}; replacement legs ${rs(re.net)}` + (re.legs ? (re.net < 0 ? ' (re-entry added to the loss).' : ' (re-entry recovered part of the outcome).') : '.')]);
    out.push(['Costs and slippage', `Charges ${rs(r.costs)} across ${r.n_trades} fills = ${r.gross > 0 ? (100 * r.costs / r.gross).toFixed(0) + '% of gross profit' : 'on top of a gross loss'}. Fill slippage is already inside gross (model: ${cfg.use_quotes ? 'bid/ask where present, else ' : ''}${cfg.slip_pct}% + ${cfg.slip_ticks} tick; stop slippage ×${cfg.stop_slip_mult}).`]);
    const worst = r.mae;
    out.push(['Largest source of risk', `Worst intrabar mark-to-market ${rs(worst)} vs a ₹${cfg.target_per_lot} target. ` +
      (r.flags.includes('stop_gap') ? 'A premium gapped through its stop, so the realised loss exceeded the 36% design loss. ' : '') +
      (r.flags.includes('same_bar_double_stop') ? 'Both legs stopped inside one bar, so the event order is unknown and was resolved conservatively. ' : '') +
      'The short call has no upper bound on loss.']);
    const assum = [];
    if (r.flags.length) assum.push('data flags: ' + r.flags.join(', '));
    assum.push(`stop fill model '${cfg.stop_fill}'`, `target checked on ${r.mtm.length ? 'bar closes' : '-'} only`);
    out.push(['Assumptions that mattered', assum.join('; ') + '.']);
    out.push(['Next experiment', r.reentries && re.net < 0 ? 'Re-run with re-entry disabled and with the opposite-decay trigger to check whether replacements systematically add loss.'
      : stops.length ? 'Sweep the stop percentage (20–75%) across many sessions: a wider stop cuts stop frequency but enlarges each loss.'
        : 'Test whether the profit target adds value versus a plain end-of-day exit across many sessions.']);
    return out;
  }

  return { DEFAULTS, ENUMS, makeConfig, hashConfig, hm, fmtHM, fillCost, simulate, resample, entryCheck,
    SCENARIOS, SYN_BASE, generate, syntheticCalendar, mulberry32, bs, computeMetrics, regimeTags, VARIANTS,
    runBacktest, sensitivity, walkForward, parseCSV, loadCSV, commentary, dailyCore, ORB, STRATEGIES };
});
