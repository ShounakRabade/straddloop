/* Straddloop ledger: the financial accounting layer that sits on top of the strategy engines.
 *
 * The engines decide WHAT trades happen (entries, stops, targets, exits) and at which candle price.
 * This module answers the money questions about those fills, one fill at a time and in order:
 * what it cost (dated statutory rates), how much margin it needed, whether the account could afford
 * it, what was realised, what was still open, and what the account was worth afterwards.
 *
 * Pure calculations, no DOM. Rules and every definition: docs/ACCOUNTING.md.
 *
 * Accounting conventions (fixed, so every number reconciles):
 *  - balance   = initial capital + cumulative NET realised P&L (gross realised minus all charges).
 *                Charges are debited the moment a fill happens. Premium RECEIVED on a short sale is NOT
 *                treated as spendable cash (conservative: brokers net it against the position).
 *  - equity    = balance + unrealised P&L (gross, marked at candle close) of positions still open.
 *  - A long option's premium is cash that leaves the account while the position is open (it is blocked).
 *  - A short option blocks margin. Margin is ESTIMATED by a configurable model (see MARGIN), never actual.
 *  - available = balance - margin blocked - long premium held.
 *  - realised and unrealised are disjoint by construction: a leg's P&L moves from unrealised to realised
 *    exactly once, when its closing fill is booked, and equity counts it exactly once.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.StraddloopLedger = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  // min / max by loop. Math.min(...xs) passes every element as a call argument and overflows the call stack
  // ("Maximum call stack size exceeded") once xs grows past roughly 100k items (a long range, many trades, many
  // configurations). Same results as Math.min / Math.max, including NaN, empty input and signed zero.
  function maxOf(a) { let m = -Infinity; for (let i = 0; i < a.length; i++) { const x = +a[i]; if (x !== x) return NaN; if (x > m || (x === 0 && m === 0 && 1 / x > 0)) m = x; } return m; }
  function minOf(a) { let m = Infinity; for (let i = 0; i < a.length; i++) { const x = +a[i]; if (x !== x) return NaN; if (x < m || (x === 0 && m === 0 && 1 / x < 0)) m = x; } return m; }

  // ------------------------------------------------------------------ dated statutory cost table
  // Rates are percentages of premium turnover unless stated. `verified` says whether the rate was
  // checked against a cited source; anything false is shown on the report and never hidden.
  const SRC_REPO = 'carried over from the repository cost schedule (src/straddloop/reference/costs.py), checked there on 2026-10-22';
  const SRC_NONE = 'recalled from memory of NSE/SEBI/Finance Act notices; NOT verified against an official source';
  const COST_TABLE = [
    { id: 'nse-opt-2020-07-01', effective_from: '2020-07-01',
      stt_sell_pct: 0.05, exch_pct: 0.053, sebi_pct: 0.0001, stamp_buy_pct: 0.003, gst_pct: 18,
      verified: { stt_sell_pct: false, exch_pct: false, sebi_pct: false, stamp_buy_pct: false, gst_pct: true },
      source: `Stamp duty 0.003% on buys is uniform from 1 Jul 2020. Other rates: ${SRC_NONE}.` },
    { id: 'nse-opt-2023-04-01', effective_from: '2023-04-01',
      stt_sell_pct: 0.0625, exch_pct: 0.053, sebi_pct: 0.0001, stamp_buy_pct: 0.003, gst_pct: 18,
      verified: { stt_sell_pct: false, exch_pct: false, sebi_pct: false, stamp_buy_pct: false, gst_pct: true },
      source: `Option STT raised to 0.0625% by the Finance Act 2023. ${SRC_NONE}.` },
    { id: 'nse-opt-2024-10-01', effective_from: '2024-10-01',
      stt_sell_pct: 0.1, exch_pct: 0.03503, sebi_pct: 0.0001, stamp_buy_pct: 0.003, gst_pct: 18,
      verified: { stt_sell_pct: true, exch_pct: false, sebi_pct: false, stamp_buy_pct: false, gst_pct: true },
      source: `Option STT 0.10% of sell premium from 1 Oct 2024 (${SRC_REPO}); exchange, SEBI and stamp rates unverified there.` },
    { id: 'nse-opt-2026-04-01', effective_from: '2026-04-01',
      stt_sell_pct: 0.15, exch_pct: 0.03553, sebi_pct: 0.0001, stamp_buy_pct: 0.003, gst_pct: 18,
      verified: { stt_sell_pct: true, exch_pct: true, sebi_pct: true, stamp_buy_pct: true, gst_pct: true },
      source: `STT 0.15%, exchange 0.03553%, SEBI ₹10/crore, stamp 0.003%, GST 18% (${SRC_REPO}). The date the 0.03553% exchange rate took effect is unconfirmed.` },
  ];
  const COST_TABLE_VERSION = 'ledger-costs-2026-11-19';
  const SYNTHETIC_FROM = '2090-01-01'; // synthetic sessions are dated 2099; they use the newest schedule

  function rateRow(date) {
    let row = null;
    for (const r of COST_TABLE) if (r.effective_from <= date) row = r;
    if (!row) throw new Error(`No cost schedule covers ${date}: the earliest entered is ${COST_TABLE[0].effective_from}. Pick a later start date, or add the missing rates to the table in ledger.js.`);
    return row;
  }
  function ratesFor(date) {
    const r = rateRow(date);
    return { id: r.id, stt_sell_pct: r.stt_sell_pct, exch_pct: r.exch_pct, sebi_pct: r.sebi_pct, stamp_buy_pct: r.stamp_buy_pct, gst_pct: r.gst_pct,
      verified: Object.values(r.verified).every(Boolean), extrapolated: date >= SYNTHETIC_FROM, source: r.source };
  }
  /** Hook for the engines' cfg.rates_for: just the rate fields. */
  function ratesHook(date) {
    const r = ratesFor(date);
    return { stt_sell_pct: r.stt_sell_pct, exch_pct: r.exch_pct, sebi_pct: r.sebi_pct, stamp_buy_pct: r.stamp_buy_pct, gst_pct: r.gst_pct };
  }

  /** Statutory charges for one fill. Same formula as the engines' fillCost, with dated rates. */
  function chargesFor(action, px, qty, date, brokeragePerOrder) {
    const r = ratesFor(date), turnover = px * qty;
    const brokerage = brokeragePerOrder;
    const exchange = turnover * r.exch_pct / 100;
    const sebi = turnover * r.sebi_pct / 100;
    const stt = action === 'SELL' ? turnover * r.stt_sell_pct / 100 : 0;
    const stamp = action === 'BUY' ? turnover * r.stamp_buy_pct / 100 : 0;
    const gst = (brokerage + exchange + sebi) * r.gst_pct / 100;
    return { brokerage, stt, exchange, gst, sebi, stamp, total: brokerage + stt + exchange + gst + sebi + stamp, schedule: r.id, verified: r.verified };
  }

  /**
   * Charges on cash settlement at expiry (no trade happens): STT at `exercisePct` % of intrinsic value x qty on a
   * LONG option that expires in the money; nothing on a short or on an option that expires worthless. No brokerage,
   * exchange, SEBI, stamp or GST. UNVERIFIED: the default 0.125% and the zero brokerage are assumptions, flagged
   * on every report that uses them.
   */
  function settlementCharges(dir, intrinsicPx, qty, exercisePct) {
    const stt = dir > 0 && intrinsicPx > 0 ? intrinsicPx * qty * exercisePct / 100 : 0;
    return { brokerage: 0, stt, exchange: 0, gst: 0, sebi: 0, stamp: 0, total: stt, schedule: SETTLEMENT_SCHEDULE, verified: false };
  }
  const SETTLEMENT_SCHEDULE = 'expiry-settlement';

  // ------------------------------------------------------------------ account configuration
  const POLICIES = ['reject', 'partial', 'liquidate', 'record'];
  const MARGIN_MODELS = ['per_leg', 'hedged'];
  const POLICY_TEXT = {
    reject: 'Reject the trade when margin is short',
    partial: 'Trade fewer lots when margin is short (reject if not even one lot fits)',
    liquidate: 'Run the trade; force-close open positions when equity falls below the margin they need',
    record: 'Run every trade and only record the shortfall (no limit; for comparison)',
  };
  const ACCOUNT_DEFAULTS = {
    initial_capital: 500000,
    margin_policy: 'reject',
    // ESTIMATED margin model. See MARGIN in docs/ACCOUNTING.md. Not SPAN output.
    margin_span_pct: 9.0,       // % of underlying notional (proxy: strike x qty) for a short option
    margin_exposure_pct: 2.0,   // exposure margin (ELM) % of the same notional
    long_option_margin: false,  // long options need only the premium paid (cash), no margin
    liquidation_threshold_pct: 100, // force-close when equity < this % of margin blocked
    liquidation_penalty_pct: 0.0,  // extra slippage on forced exits, % of premium turnover
    brokerage_per_order: 20,
    margin_model: 'per_leg',    // 'per_leg': every short leg on its own; 'hedged': worst loss over a ±SPAN-like move, per portfolio
    exercise_stt_pct: 0.125,    // STT on intrinsic value of a long ITM option settled at expiry. UNVERIFIED
    risk_free_pct: 0,           // annual, for Sharpe/Sortino
    periods_per_year: 252,
  };
  function makeAccount(over) {
    const a = Object.assign({}, ACCOUNT_DEFAULTS);
    for (const k of Object.keys(over || {})) {
      if (!(k in ACCOUNT_DEFAULTS)) throw new Error('unknown account parameter: ' + k);
      if (over[k] !== undefined && over[k] !== null && over[k] !== '') a[k] = over[k];
    }
    if (!POLICIES.includes(a.margin_policy)) throw new Error(`margin_policy must be one of ${POLICIES.join(', ')}`);
    if (!MARGIN_MODELS.includes(a.margin_model)) throw new Error(`margin_model must be one of ${MARGIN_MODELS.join(', ')}`);
    for (const k of ['initial_capital', 'margin_span_pct', 'margin_exposure_pct', 'liquidation_threshold_pct', 'liquidation_penalty_pct', 'brokerage_per_order', 'risk_free_pct', 'periods_per_year', 'exercise_stt_pct']) {
      a[k] = Number(a[k]);
      if (!isFinite(a[k]) || a[k] < 0) throw new Error(`${k} must be a number of at least 0`);
    }
    if (!(a.initial_capital > 0)) throw new Error('initial_capital must be positive');
    return a;
  }

  /** Estimated initial margin for one position. Short option: (span% + exposure%) of strike x qty. */
  function marginFor(dir, strike, qty, acct) {
    if (dir > 0) return acct.long_option_margin ? strike * qty * (acct.margin_span_pct + acct.margin_exposure_pct) / 100 : 0;
    return strike * qty * (acct.margin_span_pct + acct.margin_exposure_pct) / 100;
  }

  const intrinsicOf = (side, S, K) => (side === 'CE' ? Math.max(0, S - K) : Math.max(0, K - S));
  /**
   * ESTIMATED margin for a set of open legs under the 'hedged' model: the worst loss, at intrinsic value, over index
   * levels within ±SPAN-like % of the reference level (the index at entry when the engine gives it, else the mean
   * strike), plus exposure % of the short notional at that level; never more than the per-leg figure. Long premium is
   * held as cash, not margin. Legs of different expiries are valued at intrinsic on the same level (an approximation).
   */
  function hedgedMargin(ls, acct) {
    const shorts = ls.filter(l => l.dir < 0);
    if (!shorts.length) return 0;
    let naive = 0;
    for (const l of shorts) naive += marginFor(-1, l.strike, l.qty, acct);
    const refs = ls.map(l => l.spot).filter(x => typeof x === 'number' && x > 0);
    const ref = refs.length ? refs.reduce((a, b) => a + b, 0) / refs.length : ls.reduce((a, l) => a + l.strike, 0) / ls.length;
    const scan = acct.margin_span_pct / 100, lo = ref * (1 - scan), hi = ref * (1 + scan);
    const pts = [ref];
    for (let k = 0; k <= 40; k++) pts.push(lo + (hi - lo) * k / 40);
    for (const l of ls) if (l.strike > lo && l.strike < hi) pts.push(l.strike);
    let worst = 0;
    for (const S of pts) {
      let loss = 0;
      for (const l of ls) loss -= l.dir * intrinsicOf(l.side, S, l.strike) * l.qty;
      if (loss > worst) worst = loss;
    }
    let shortQty = 0;
    for (const l of shorts) shortQty += l.qty;
    return Math.min(naive, worst + acct.margin_exposure_pct / 100 * ref * shortQty);
  }
  /** Margin blocked by a set of open legs under the account's model. per_leg = the sum of each leg's own margin. */
  function portfolioMargin(ls, acct) {
    if (acct.margin_model === 'hedged') return hedgedMargin(ls, acct);
    let m = 0;
    for (const l of ls) m += l.margin;
    return m;
  }

  // ------------------------------------------------------------------ helpers
  const sum = xs => xs.reduce((a, b) => a + b, 0);
  const R = (x, d) => { const f = Math.pow(10, d == null ? 2 : d); return Math.round((x + (x >= 0 ? 1e-9 : -1e-9)) * f) / f; };
  const hmStr = m => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(Math.round(m % 60)).padStart(2, '0');
  const nz = v => (typeof v === 'number' && isFinite(v) ? v : null);
  function hashStr(s) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return h.toString(16).padStart(8, '0');
  }
  const EMPTY_CH = { brokerage: 0, stt: 0, exchange: 0, gst: 0, sebi: 0, stamp: 0, total: 0 };
  function addCh(a, b) { const o = {}; for (const k of Object.keys(EMPTY_CH)) o[k] = (a[k] || 0) + (b[k] || 0); return o; }

  /** Open leg direction from the action that opens it: SELL opens a short (-1), BUY a long (+1). */
  const dirOf = action => (action === 'SELL' ? -1 : 1);

  /** Per-day marks, normalised to [{t, px: {legId: last price}}]: the candle-close price of every open leg. */
  function marksOf(res) {
    const m = res.mtm || [];
    if (res.strategy === 'orb' || (res.trades && !res.legs)) return m.filter(x => x.id != null && x.px != null).map(x => ({ t: x.t, px: { [x.id]: x.px } }));
    return m.filter(x => x.px).map(x => ({ t: x.t, px: x.px }));
  }
  const lotOf = res => res.lot_size || (res.trades && res.trades[0] && res.trades[0].lot_size) || null;

  // ------------------------------------------------------------------ the simulation
  /**
   * Replays every day's fills in time order against the account.
   * @param results  engine day results (status 'traded' carries fills; other statuses are idle sessions)
   * @param acctOver account overrides (see ACCOUNT_DEFAULTS)
   * @param info     { symbol, data_fingerprint, engine_cfg_hash }
   */
  function runLedger(results, acctOver, info) {
    info = info || {};
    const acct = makeAccount(acctOver);
    const byDate = {};
    for (const r of results) byDate[r.date] = r;
    const days = results.filter(r => ['traded', 'no_entry', 'filtered', 'holding'].includes(r.status)).slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    const excludedDays = results.filter(r => r.status === 'excluded').map(r => ({ date: r.date, reason: r.reason }));

    const S = { balance: acct.initial_capital, cumGross: 0, cumCharges: 0, cumNet: 0, seq: 0, tradeSeq: 0, orders: 0, engineCostDiff: 0,
      peakMargin: 0, peakDeployed: 0, peakExposure: 0, maxShortfall: 0, shortfalls: 0, peakUtil: 0, firstMargin: null, minAvailable: Infinity,
      negBalanceEvents: 0, over100Events: 0, marginSum: 0, marginDays: 0, deployedSum: 0, deployedDays: 0, maxDDIntra: 0, maxDDIntraPct: 0,
      totalPremiumPaid: 0, totalPremiumReceived: 0, totalTurnover: 0, cashOut: 0 };
    let peakIntraEq = acct.initial_capital;
    const fills = [], trades = [], daily = [], rejections = [], liquidations = [], warnings = [], schedules = new Map(), lotSizes = new Set();
    // Legs the engine carries to the next session (multi-day positions) stay open across days with their margin.
    let carried = new Map(), carriedSkipped = new Set();
    const unrealisedOf = ls => { let u = 0; for (const l of ls) if (l.open) u += l.dir < 0 ? (l.entry_px - l.last_px) * l.qty : (l.last_px - l.entry_px) * l.qty; return u; };

    for (const res of days) {
      const lot = lotOf(res);
      if (lot) lotSizes.add(lot);
      const dayOpen = S.balance;
      const legs = carried, skipped = carriedSkipped;
      carried = new Map(); carriedSkipped = new Set();
      const uOpen = unrealisedOf(legs.values());
      const d = { date: res.date, status: res.status, opening_balance: dayOpen, trades: 0, rejected: 0, fills: 0, gross_realised: 0, charges: 0, net_realised: 0, closing_balance: dayOpen,
        peak_margin: 0, peak_deployed: 0, peak_exposure: 0, min_available: null, peak_util_pct: 0, intraday_low_equity: dayOpen + uOpen, intraday_peak_unrealised: 0, closing_equity: dayOpen + uOpen,
        drawdown: 0, drawdown_pct: 0, lot_size: lot, exit_reason: res.exit_reason || '', reason: res.reason || '', flags: (res.flags || []).join(' '),
        open_legs: 0, unrealised_start: uOpen, unrealised_end: 0 };
      const hadCarry = legs.size > 0;
      let dayMargin = 0, dayHeld = 0;
      const open = () => [...legs.values()].filter(l => l.open);
      const blocked = () => { let m = 0, h = 0, e = 0, u = 0; const ol = open(); for (const l of ol) { m += l.margin; h += l.held; e += l.notional; u += l.dir < 0 ? (l.entry_px - l.last_px) * l.qty : (l.last_px - l.entry_px) * l.qty; } if (acct.margin_model === 'hedged') m = hedgedMargin(ol, acct); return { m, h, e, u }; };
      /** Extra margin a new leg needs on top of what the open legs already block (per_leg: its own margin). */
      const marginInc = (dir, strike, qty, side, spot) => {
        if (acct.margin_model !== 'hedged') return marginFor(dir, strike, qty, acct);
        const ol = open();
        return Math.max(0, hedgedMargin(ol.concat([{ dir, strike, qty, side, spot, margin: 0 }]), acct) - hedgedMargin(ol, acct));
      };
      const touch = (b) => {
        d.peak_margin = Math.max(d.peak_margin, b.m); d.peak_deployed = Math.max(d.peak_deployed, b.m + b.h); d.peak_exposure = Math.max(d.peak_exposure, b.e);
        S.peakMargin = Math.max(S.peakMargin, b.m); S.peakDeployed = Math.max(S.peakDeployed, b.m + b.h); S.peakExposure = Math.max(S.peakExposure, b.e);
        const avail = S.balance - b.m - b.h;
        d.min_available = d.min_available == null ? avail : Math.min(d.min_available, avail);
        S.minAvailable = Math.min(S.minAvailable, avail);
        const used = b.m + b.h, util = S.balance > 0 ? 100 * used / S.balance : (used > 0 ? Infinity : 0);
        if (util > d.peak_util_pct) d.peak_util_pct = util;
        if (util > 100) S.over100Events++;
        if (S.balance < 0) S.negBalanceEvents++;
        dayMargin = Math.max(dayMargin, b.m); dayHeld = Math.max(dayHeld, b.h);
      };

      /** Books one executed fill; returns { row, leg }. */
      const book = (f, qty, px, opt) => {
        opt = opt || {};
        const settling = !!f.settlement && legs.has(f.legId);
        const ch = settling ? settlementCharges(legs.get(f.legId).dir, px, qty, acct.exercise_stt_pct) : chargesFor(f.action, px, qty, res.date, acct.brokerage_per_order);
        if (opt.penalty) { ch.total += opt.penalty; ch.exchange += opt.penalty; }
        schedules.set(ch.schedule, ch.verified);
        if (f.costs && f.costs.total != null && !opt.forced && qty === f.qty0 && px === f.px) S.engineCostDiff += Math.abs(f.costs.total - ch.total);
        const turnover = px * qty, balBefore = S.balance, b0 = blocked(), availBefore = balBefore - b0.m - b0.h;
        let leg = legs.get(f.legId), opening = !leg, realised = 0, marginReq = 0;
        if (opening) {
          const dir = dirOf(f.action);
          marginReq = marginInc(dir, f.strike, qty, f.side, f.spot);
          leg = { id: f.legId, dir, strike: f.strike, side: f.side, expiry: f.expiry, qty, entry_px: px, entry_t: f.t, entry_ch: ch, margin: acct.margin_model === 'hedged' ? 0 : marginReq, held: dir > 0 ? turnover : 0,
            notional: f.strike * qty, open: true, date: res.date, entry_reason: f.reason, kind: f.kind, rowIdx: fills.length, seqs: [], rows: [], intrabar_in: !!f.intrabar, last_px: px,
            balance_before: balBefore, avail_before: availBefore, margin_req: marginReq, spot: f.spot, position: f.position || '' };
          legs.set(f.legId, leg);
          if (dir > 0) S.totalPremiumPaid += turnover; else S.totalPremiumReceived += turnover;
          if (S.firstMargin == null && marginReq > 0) S.firstMargin = marginReq;
        } else {
          leg.exit_t = f.t; leg.exit_date = res.date; leg.exit_px = px; leg.exit_reason = f.reason; leg.exit_ch = ch; leg.intrabar_out = !!f.intrabar; leg.open = false; leg.last_px = px;
          realised = leg.dir < 0 ? (leg.entry_px - px) * qty : (px - leg.entry_px) * qty;
          leg.gross = realised;
        }
        let released = opening ? 0 : leg.margin;
        if (!opening) { leg.margin = 0; leg.held = 0; }
        if (!opening && acct.margin_model === 'hedged') released = Math.max(0, b0.m - blocked().m);
        S.balance += realised - ch.total;
        S.cumGross += realised; S.cumCharges += ch.total; S.cumNet += realised - ch.total;
        d.gross_realised += realised; d.charges += ch.total;
        S.totalTurnover += turnover; S.orders++;
        S.cashOut += ch.total + (opening && leg.dir > 0 ? turnover : 0); // cash that really leaves: long premium + charges
        const b1 = blocked();
        touch(b1);
        const row = { seq: ++S.seq, date: res.date, time: hmStr(f.t), t: f.t, leg: f.legId, trade_no: null, event: opening ? 'OPEN' : (opt.forced ? 'LIQUIDATE' : 'CLOSE'),
          status: opt.forced ? 'forced' : (opt.partial ? 'partial' : 'executed'), action: f.action, side: f.side, strike: f.strike, expiry: f.expiry, qty, lots: lot ? qty / lot : null,
          px, turnover, notional: f.strike * qty, reason: f.reason, opening_balance: balBefore, available_margin_before: availBefore, margin_required: marginReq, margin_blocked: b1.m,
          margin_released: released, premium_held: b1.h, position_value: b1.e, realised_gross: realised, unrealised_gross: b1.u,
          brokerage: ch.brokerage, stt: ch.stt, exchange: ch.exchange, gst: ch.gst, sebi: ch.sebi, stamp: ch.stamp, charges: ch.total,
          available_margin_after: S.balance - b1.m - b1.h, balance_after: S.balance, equity_after: S.balance + b1.u, cum_realised_gross: S.cumGross, cum_charges: S.cumCharges,
          cum_net_realised: S.cumNet, exposure_after: b1.e, utilisation_pct: S.balance > 0 ? 100 * (b1.m + b1.h) / S.balance : null, shortfall: null, cost_schedule: ch.schedule, intrabar: !!f.intrabar };
        fills.push(row); leg.seqs.push(row.seq); leg.rows.push(row); d.fills++;
        return { row, leg };
      };
      const finish = (leg) => {
        leg.charges = leg.entry_ch.total + leg.exit_ch.total; leg.net = leg.gross - leg.charges;
        leg.trade_no = ++S.tradeSeq;
        for (const r of leg.rows) r.trade_no = leg.trade_no; // direct references: fills.find here made every run O(fills²)
        trades.push(leg); d.trades++;
      };

      const onFill = (f) => {
        if (skipped.has(f.legId)) return;
        const ex = legs.get(f.legId);
        if (ex) { if (ex.open) finish(book(Object.assign({}, f, { qty0: f.qty }), ex.qty, f.px).leg); return; }
        const dir = dirOf(f.action), b = blocked(), avail = S.balance - b.m - b.h;
        const needFor = q => marginInc(dir, f.strike, q, f.side, f.spot) + (dir > 0 ? f.px * q : 0) + chargesFor(f.action, f.px, q, res.date, acct.brokerage_per_order).total;
        let qty = f.qty, need = needFor(qty), status = 'ok', shortfall = 0;
        if (need > avail + 1e-9) {
          shortfall = need - avail; S.shortfalls++; S.maxShortfall = Math.max(S.maxShortfall, shortfall);
          const pol = acct.margin_policy;
          if (pol === 'partial' && lot) {
            let k = Math.floor(f.qty / lot) - 1;
            while (k >= 1 && needFor(k * lot) > avail + 1e-9) k--;
            if (k >= 1) { qty = k * lot; status = 'partial'; } else status = 'rejected';
          } else if (pol === 'reject' || (pol === 'liquidate' && avail <= 0)) status = 'rejected';
        }
        if (status === 'rejected') {
          skipped.add(f.legId); d.rejected++;
          fills.push({ seq: ++S.seq, date: res.date, time: hmStr(f.t), t: f.t, leg: f.legId, trade_no: null, event: 'REJECTED', status: 'rejected', action: f.action, side: f.side, strike: f.strike, expiry: f.expiry,
            qty: f.qty, lots: lot ? f.qty / lot : null, px: f.px, turnover: f.px * f.qty, notional: f.strike * f.qty, reason: 'insufficient margin', opening_balance: S.balance, available_margin_before: avail,
            margin_required: need, margin_blocked: b.m, margin_released: 0, premium_held: b.h, position_value: b.e, realised_gross: 0, unrealised_gross: b.u, brokerage: 0, stt: 0, exchange: 0, gst: 0, sebi: 0, stamp: 0,
            charges: 0, available_margin_after: avail, balance_after: S.balance, equity_after: S.balance + b.u, cum_realised_gross: S.cumGross, cum_charges: S.cumCharges, cum_net_realised: S.cumNet,
            exposure_after: b.e, utilisation_pct: S.balance > 0 ? 100 * (b.m + b.h) / S.balance : null, shortfall, cost_schedule: '', intrabar: false });
          rejections.push({ date: res.date, time: hmStr(f.t), leg: f.legId, side: f.side, strike: f.strike, required: need, available: avail, shortfall, policy: acct.margin_policy });
          touch(b);
          return;
        }
        const { row } = book(Object.assign({}, f, { qty0: f.qty }), qty, f.px, { partial: status === 'partial' });
        if (shortfall > 0) { row.shortfall = shortfall; if (status === 'ok') row.status = 'executed_in_shortfall'; }
      };

      let liquidated = false;
      const liquidate = (t) => {
        for (const lg of open()) {
          const px = lg.dir < 0 ? lg.last_px * (1 + acct.liquidation_penalty_pct / 100) : lg.last_px * (1 - acct.liquidation_penalty_pct / 100);
          const b = blocked();
          liquidations.push({ date: res.date, time: hmStr(t), leg: lg.id, side: lg.side, strike: lg.strike, mark_px: lg.last_px, equity_before: S.balance + b.u, margin_blocked: b.m });
          finish(book({ t, legId: lg.id, action: lg.dir < 0 ? 'BUY' : 'SELL', strike: lg.strike, side: lg.side, expiry: lg.expiry, qty: lg.qty, px, reason: 'forced liquidation', costs: null }, lg.qty, px, { forced: true }).leg);
        }
        liquidated = true;
      };

      const rf = res.status === 'traded' ? (res.fills || []) : [];
      const events = rf.map((f, i) => ({ k: 1, t: f.t, i, f })).concat(marksOf(res).map((m, i) => ({ k: 0, t: m.t, i, m }))).sort((a, b) => a.t - b.t || a.k - b.k || a.i - b.i);
      for (const ev of events) {
        if (ev.k === 1) { onFill(Object.assign({}, ev.f, { legId: ev.f.leg != null ? ev.f.leg : ev.f.trade })); continue; }
        for (const lg of open()) if (ev.m.px[lg.id] != null) lg.last_px = ev.m.px[lg.id];
        const b = blocked();
        if (b.m + b.h <= 0 && !open().length) continue;
        const eq = S.balance + b.u;
        d.intraday_low_equity = Math.min(d.intraday_low_equity, eq);
        d.intraday_peak_unrealised = Math.max(d.intraday_peak_unrealised, b.u);
        peakIntraEq = Math.max(peakIntraEq, eq);
        if (peakIntraEq - eq > S.maxDDIntra) { S.maxDDIntra = peakIntraEq - eq; S.maxDDIntraPct = 100 * (peakIntraEq - eq) / peakIntraEq; }
        touch(b);
        if (acct.margin_policy === 'liquidate' && !liquidated && b.m > 0 && eq < b.m * acct.liquidation_threshold_pct / 100) liquidate(ev.t);
        else if (acct.margin_policy === 'liquidate' && liquidated && eq < b.m * acct.liquidation_threshold_pct / 100) liquidate(ev.t);
      }
      const carry = new Set((res.carry || []).map(String));
      for (const id of carry) if (skipped.has(id) || skipped.has(Number(id))) carriedSkipped.add(skipped.has(id) ? id : Number(id));
      for (const lg of open()) if (carry.has(String(lg.id))) carried.set(lg.id, lg);
      for (const lg of open().filter(l => !carry.has(String(l.id)))) { // data ended with a position open: never drop it silently
        warnings.push(`${res.date}: leg ${lg.id} was still open at the end of the session; closed at its last price with charges. Check the data.`);
        finish(book({ t: lg.entry_t, legId: lg.id, action: lg.dir < 0 ? 'BUY' : 'SELL', strike: lg.strike, side: lg.side, expiry: lg.expiry, qty: lg.qty, px: lg.last_px, reason: 'open at end of data' }, lg.qty, lg.last_px, { forced: true }).leg);
      }
      d.net_realised = d.gross_realised - d.charges;
      d.open_legs = carried.size; d.unrealised_end = unrealisedOf(carried.values());
      d.closing_balance = S.balance; d.closing_equity = S.balance + d.unrealised_end;
      if (d.min_available == null) d.min_available = dayOpen;
      if (d.trades > 0 || d.rejected > 0 || d.fills > 0 || hadCarry) { S.marginSum += dayMargin; S.marginDays++; S.deployedSum += dayMargin + dayHeld; S.deployedDays++; }
      S.peakUtil = Math.max(S.peakUtil, d.peak_util_pct === Infinity ? 1e9 : d.peak_util_pct);
      daily.push(d);
    }
    let pk = acct.initial_capital;
    for (const d of daily) { pk = Math.max(pk, d.closing_equity); d.drawdown = pk - d.closing_equity; d.drawdown_pct = 100 * d.drawdown / pk; }

    const tradebook = trades.map((lg, n) => {
      const res = byDate[lg.date] || {};
      const evs = (res.events || []).filter(e => e.leg === lg.id || e.trade === lg.id).map(e => `${hmStr(e.t)} ${e.text}`);
      const lt = lotOf(res);
      return { trade_no: n + 1, date: lg.date, exit_date: lg.exit_date || lg.date, position_id: lg.position || '', leg: lg.id, kind: lg.kind || '', symbol: info.symbol || res.symbol || '', side: lg.side, strike: lg.strike, expiry: lg.expiry, direction: lg.dir < 0 ? 'SHORT' : 'LONG',
        qty: lg.qty, lots: lt ? lg.qty / lt : null, lot_size: lt, entry_time: hmStr(lg.entry_t), entry_px: lg.entry_px, exit_time: hmStr(lg.exit_t), exit_px: lg.exit_px, exit_reason: lg.exit_reason,
        premium: lg.entry_px * lg.qty, notional: lg.notional, margin_blocked: lg.margin_req, gross_pnl: lg.gross,
        brokerage: lg.entry_ch.brokerage + lg.exit_ch.brokerage, stt: lg.entry_ch.stt + lg.exit_ch.stt, exchange: lg.entry_ch.exchange + lg.exit_ch.exchange, gst: lg.entry_ch.gst + lg.exit_ch.gst,
        sebi: lg.entry_ch.sebi + lg.exit_ch.sebi, stamp: lg.entry_ch.stamp + lg.exit_ch.stamp, charges: lg.charges, net_pnl: lg.net, cost_schedule: lg.entry_ch.schedule, cost_rates_verified: lg.entry_ch.verified,
        intrabar_entry: lg.intrabar_in, intrabar_exit: !!lg.intrabar_out, entry_reason: lg.entry_reason, balance_before: lg.balance_before, available_margin_before: lg.avail_before,
        fills: lg.seqs.join(' '), flags: (res.flags || []).join(' '), audit: evs.join(' | ') };
    });
    S.lotSizes = [...lotSizes];
    S.balanceEnd = S.balance;
    const report = buildReport({ acct, daily, tradebook, fills, rejections, liquidations, warnings, excludedDays, schedules, info, stats: S });
    return { acct, fills, tradebook, daily, rejections, liquidations, report };
  }

  // ------------------------------------------------------------------ the report
  // Two-sided 95% Student t multiplier (z = 1.96 understates the interval badly below ~30 observations).
  const T95 = [0, 12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.160, 2.145, 2.131, 2.120, 2.110, 2.101, 2.093, 2.086, 2.080, 2.074, 2.069, 2.064, 2.060, 2.056, 2.052, 2.048, 2.045, 2.042];
  const t95 = df => (df <= 30 ? T95[df] : df <= 60 ? 2.042 - 0.042 * (df - 30) / 30 : df <= 120 ? 2.0 - 0.02 * (df - 60) / 60 : 1.96);
  function stdev(xs) { const n = xs.length; if (n < 2) return 0; const m = sum(xs) / n; return Math.sqrt(sum(xs.map(x => (x - m) ** 2)) / (n - 1)); }
  function dayDiff(a, b) { return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000); }

  /** Every metric carries its formula and denominator in `defs`, so the report can print them. */
  function buildReport(c) {
    const { acct, daily, tradebook, rejections, liquidations, stats } = c;
    const cap = acct.initial_capital, end = stats.balanceEnd;
    const grossProfit = sum(tradebook.filter(t => t.gross_pnl > 0).map(t => t.gross_pnl));
    const grossLoss = sum(tradebook.filter(t => t.gross_pnl < 0).map(t => t.gross_pnl));
    const winsN = tradebook.filter(t => t.net_pnl > 0), lossN = tradebook.filter(t => t.net_pnl <= 0);
    const nT = tradebook.length;
    const netProfitSum = sum(winsN.map(t => t.net_pnl)), netLossSum = sum(lossN.map(t => t.net_pnl));
    const charges = { brokerage: 0, stt: 0, exchange: 0, gst: 0, sebi: 0, stamp: 0, total: 0 };
    for (const f of c.fills) if (f.status !== 'rejected') for (const k of Object.keys(charges)) charges[k] += k === 'total' ? f.charges : f[k];
    const netAbs = end - cap;
    // daily series over every session in range (idle days are 0): the base for Sharpe, Sortino, drawdown
    // daily return on equity: (net realised + change in unrealised) / previous closing equity. For intraday strategies
    // the unrealised terms are 0 and this is exactly net realised / previous closing balance.
    let prevBal = cap;
    const rets = daily.map(d => { const r = prevBal > 0 ? (d.net_realised + (d.unrealised_end - d.unrealised_start)) / prevBal : 0; prevBal = d.closing_equity; return r; });
    const rfD = acct.risk_free_pct / 100 / acct.periods_per_year;
    const ex = rets.map(r => r - rfD);
    const sd = stdev(ex), downside = Math.sqrt(sum(ex.map(x => Math.min(0, x) ** 2)) / (ex.length || 1));
    const sharpe = ex.length >= 2 && sd > 0 ? (sum(ex) / ex.length) / sd * Math.sqrt(acct.periods_per_year) : null;
    const sortino = ex.length >= 2 && downside > 0 ? (sum(ex) / ex.length) / downside * Math.sqrt(acct.periods_per_year) : null;
    let peak = cap, maxDD = 0, maxDDPct = 0, ddFrom = null, ddTo = null, peakDate = null;
    for (const d of daily) {
      if (d.closing_equity > peak) { peak = d.closing_equity; peakDate = d.date; }
      const dd = peak - d.closing_equity;
      if (dd > maxDD) { maxDD = dd; maxDDPct = 100 * dd / peak; ddFrom = peakDate; ddTo = d.date; }
    }
    const first = daily.length ? daily[0].date : null, last = daily.length ? daily[daily.length - 1].date : null;
    const spanDays = first && last ? dayDiff(first, last) + 1 : 0;
    let cagr = null, cagrWhy = null;
    if (spanDays < 365) cagrWhy = `Not shown: the range is ${spanDays} calendar days; annualising less than a year of results is misleading.`;
    else if (end <= 0) cagrWhy = 'Not shown: ending balance is not positive.';
    else cagr = 100 * (Math.pow(end / cap, 365 / spanDays) - 1);
    const monthly = {}, annual = {};
    for (const d of daily) { monthly[d.date.slice(0, 7)] = (monthly[d.date.slice(0, 7)] || 0) + d.net_realised; annual[d.date.slice(0, 4)] = (annual[d.date.slice(0, 4)] || 0) + d.net_realised; }
    const tradedDays = daily.filter(d => d.trades > 0);
    const avgDeployed = stats.deployedDays ? stats.deployedSum / stats.deployedDays : 0;
    const avgMargin = stats.marginDays ? stats.marginSum / stats.marginDays : 0;
    const dayNets = tradedDays.map(d => d.net_realised);
    const dMean = dayNets.length ? sum(dayNets) / dayNets.length : 0, dSd = stdev(dayNets);
    const tNet = tradebook.map(t => t.net_pnl);
    const tMean = nT ? sum(tNet) / nT : 0, tSd = stdev(tNet);
    const pct = (x, d) => (d > 0 ? 100 * x / d : null);

    const warnings = c.warnings.slice();
    const unverified = [...c.schedules.entries()].filter(([, v]) => !v).map(([k]) => k);
    if (unverified.length) warnings.push(`Cost rates not verified against an official source for: ${unverified.join(', ')}. See the rate table.`);
    if (stats.lotSizes.length > 1) warnings.push(`Lot size changed within the range (${stats.lotSizes.join(', ')}). Each day uses the size stored in its day file; check these against NSE circulars.`);
    warnings.push('Margin is ESTIMATED from a configurable percentage model. It is not SPAN output and not the broker’s actual historical margin.');
    if (c.schedules.has(SETTLEMENT_SCHEDULE)) warnings.push(`Positions were cash-settled at expiry at intrinsic value against the index close of the last stored bar. Settlement charges are an assumption: STT ${acct.exercise_stt_pct}% of intrinsic value on long in-the-money options, no brokerage or other charges (UNVERIFIED).`);
    if (acct.margin_model === 'hedged') warnings.push(`Margin model: hedged estimate (worst loss over a ±${acct.margin_span_pct}% index move at intrinsic value, plus ${acct.margin_exposure_pct}% exposure on short notional, capped at the per-leg figure). Not SPAN.`);
    if (stats.engineCostDiff > 0.05 * Math.max(1, stats.orders)) warnings.push(`Ledger charges differ from the engine's own cost lines by ₹${R(stats.engineCostDiff)} in total.`);
    if (stats.negBalanceEvents) warnings.push(`The balance went below zero (${stats.negBalanceEvents} event(s)).`);
    if (liquidations.length) warnings.push(`${liquidations.length} position(s) were force-closed at an approximate price (aggregate mark apportioned equally per unit).`);
    if (rejections.length) warnings.push(`${rejections.length} trade(s) rejected for insufficient margin; they are not in the P&L.`);
    if (c.excludedDays.length) warnings.push(`${c.excludedDays.length} day(s) excluded by the engine because the data was incomplete (listed in the daily ledger as absent, never filled in).`);
    if (daily.length < 30) warnings.push(`Only ${daily.length} sessions: Sharpe, Sortino and the percentages below are indicative at best.`);

    const defs = {
      initial_capital: 'Account capital before the first trade (setting).',
      total_premium_paid: 'Sum of premium (price x quantity) paid on long openings. This is the "investment" in bought options.',
      total_premium_received: 'Sum of premium received on short openings. Not spendable cash in this ledger.',
      total_trade_value: 'Sum of price x quantity over every executed fill, both sides (turnover).',
      peak_notional: 'Largest sum of strike x quantity across positions open at once.',
      peak_margin: 'Largest ESTIMATED margin blocked at once.',
      peak_deployed: 'Largest (margin blocked + long premium held) at once.',
      avg_deployed: 'Average, over days with a trade, of that day’s peak (margin blocked + long premium held).',
      avg_margin: 'Average, over days with a trade, of that day’s peak margin blocked.',
      cash_outflow: 'Cash that actually left the account: long premium paid + all charges. Margin blocked is not an outflow.',
      capital_utilisation_peak: 'peak deployed / initial capital.',
      capital_utilisation_avg: 'average deployed / initial capital.',
      margin_utilisation_peak: 'max over fills of (margin blocked + long premium held) / account balance at that moment.',
      ret_initial: 'net profit / initial capital.',
      ret_peak_deployed: 'net profit / peak deployed.',
      ret_avg_deployed: 'net profit / average deployed.',
      ret_peak_margin: 'net profit / peak estimated margin blocked.',
      cagr: 'ending balance / initial capital, compounded over calendar days / 365; only when the range is at least one year.',
      win_rate: 'closed positions with net P&L > 0 / all closed positions (net of the position’s own charges).',
      profit_factor: 'sum of net P&L of winning positions / absolute sum of net P&L of losing positions.',
      risk_reward: 'average net winning position / absolute average net losing position.',
      expectancy: 'mean net P&L per closed position.',
      max_dd: 'largest peak-to-trough fall of the end-of-day account balance; % is of the peak balance.',
      max_dd_intraday: 'largest fall of intraday equity (balance + unrealised at candle closes) from the running intraday peak.',
      sharpe: `mean(daily return - risk-free per day) / stdev x sqrt(${acct.periods_per_year}); daily return = day’s net P&L / previous closing balance; every session counts, idle days are 0; risk-free ${acct.risk_free_pct}%/yr.`,
      sortino: 'mean excess daily return / downside deviation (root mean square of negative excess returns, over all sessions) x sqrt(periods per year).',
    };

    return {
      generated: { cost_table_version: COST_TABLE_VERSION, engine_config_hash: c.info.engine_cfg_hash || null, data_fingerprint: c.info.data_fingerprint || null,
        account_hash: hashStr(JSON.stringify(acct)), run_hash: null },
      account: acct, defs, warnings: warnings.filter(Boolean),
      range: { from: first, to: last, sessions: daily.length, traded_days: tradedDays.length, excluded_days: c.excludedDays },
      cost_rates: [...c.schedules.keys()].filter(id => id !== SETTLEMENT_SCHEDULE).map(id => { const r = COST_TABLE.find(x => x.id === id); return { id, effective_from: r.effective_from, stt_sell_pct: r.stt_sell_pct, exch_pct: r.exch_pct, sebi_pct: r.sebi_pct, stamp_buy_pct: r.stamp_buy_pct, gst_pct: r.gst_pct, verified: r.verified, source: r.source }; }),
      capital: {
        initial_capital: cap, total_premium_paid: stats.totalPremiumPaid, total_premium_received: stats.totalPremiumReceived, total_trade_value: stats.totalTurnover,
        peak_notional: stats.peakExposure, peak_margin: stats.peakMargin, peak_deployed: stats.peakDeployed, avg_deployed: avgDeployed, cash_outflow: stats.cashOut,
        capital_utilisation_peak_pct: pct(stats.peakDeployed, cap), capital_utilisation_avg_pct: pct(avgDeployed, cap), remaining_capital: end,
      },
      margin: {
        initial_margin: stats.firstMargin, peak_margin: stats.peakMargin, avg_margin: avgMargin, min_available_margin: stats.minAvailable,
        peak_utilisation_pct: stats.peakUtil >= 1e9 ? null : stats.peakUtil, shortfall_events: stats.shortfalls, max_shortfall: stats.maxShortfall,
        policy: acct.margin_policy, policy_text: POLICY_TEXT[acct.margin_policy], rejected_trades: rejections.length, forced_liquidations: liquidations.length,
        negative_balance_events: stats.negBalanceEvents, over_100_pct_events: stats.over100Events,
        model: { kind: 'ESTIMATED', model: acct.margin_model, span_pct: acct.margin_span_pct, exposure_pct: acct.margin_exposure_pct,
          base: acct.margin_model === 'hedged' ? 'worst loss at intrinsic over ±span% of the index level at entry, plus exposure % of short notional; capped at per-leg' : 'strike x quantity (proxy for underlying notional)',
          long_options: acct.long_option_margin ? 'margin applied' : 'premium only' },
      },
      pnl: {
        gross_realised_profit: grossProfit, gross_realised_loss: grossLoss, net_realised_gross: grossProfit + grossLoss, unrealised_at_end: daily.length ? daily[daily.length - 1].unrealised_end : 0,
        charges, total_charges: charges.total, net_profit: end - cap, ending_balance: end,
        peak_intraday_unrealised: Math.max(0, ...daily.map(d => d.intraday_peak_unrealised)), trough_intraday_equity: Math.min(cap, ...daily.map(d => d.intraday_low_equity)),
      },
      returns: {
        absolute: netAbs, pct_initial: pct(netAbs, cap), pct_peak_deployed: pct(netAbs, stats.peakDeployed), pct_avg_deployed: pct(netAbs, avgDeployed), pct_peak_margin: pct(netAbs, stats.peakMargin),
        cagr_pct: cagr, cagr_note: cagrWhy, monthly, annual,
      },
      performance: {
        closed_positions: nT, wins: winsN.length, losses: lossN.length, win_rate_pct: nT ? 100 * winsN.length / nT : null, loss_rate_pct: nT ? 100 * lossN.length / nT : null,
        avg_win: winsN.length ? netProfitSum / winsN.length : null, avg_loss: lossN.length ? netLossSum / lossN.length : null,
        profit_factor: netLossSum < 0 ? netProfitSum / -netLossSum : null,
        risk_reward: winsN.length && lossN.length && netLossSum < 0 ? (netProfitSum / winsN.length) / -(netLossSum / lossN.length) : null,
        expectancy: nT ? tMean : null, largest_win: nT ? maxOf(tNet) : null, largest_loss: nT ? minOf(tNet) : null,
        mean_per_traded_day: tradedDays.length ? dMean : null, sd_per_traded_day: tradedDays.length > 1 ? dSd : null,
        ci95_traded_day: tradedDays.length > 1 ? [dMean - t95(tradedDays.length - 1) * dSd / Math.sqrt(tradedDays.length), dMean + t95(tradedDays.length - 1) * dSd / Math.sqrt(tradedDays.length)] : null,
        t_stat_traded_day: tradedDays.length > 1 && dSd > 0 ? dMean / (dSd / Math.sqrt(tradedDays.length)) : null,
        ci95_trade: nT > 1 ? [tMean - t95(nT - 1) * tSd / Math.sqrt(nT), tMean + t95(nT - 1) * tSd / Math.sqrt(nT)] : null,
        t_stat_trade: nT > 1 && tSd > 0 ? tMean / (tSd / Math.sqrt(nT)) : null,
        winning_days: tradedDays.filter(d => d.net_realised > 0).length, losing_days: tradedDays.filter(d => d.net_realised <= 0).length,
        best_day: tradedDays.length ? maxOf(dayNets) : null, worst_day: tradedDays.length ? minOf(dayNets) : null,
      },
      risk: {
        max_drawdown: maxDD, max_drawdown_pct: maxDDPct, drawdown_from: ddFrom, drawdown_to: ddTo, max_drawdown_intraday: stats.maxDDIntra, max_drawdown_intraday_pct: stats.maxDDIntraPct,
        sharpe, sortino, sessions_in_ratio: daily.length, daily_return_sd_pct: 100 * sd,
        sharpe_note: daily.length < 30 ? 'Fewer than 30 sessions: not a reliable estimate.' : null,
        worst_day: tradedDays.length ? minOf(dayNets) : null, var5_day: tradedDays.length >= 20 ? percentile(dayNets, 5) : null,
      },
      reconciliation: reconcile(c, end),
    };
  }

  function percentile(xs, q) { const s = xs.slice().sort((a, b) => a - b); const k = (s.length - 1) * q / 100, f = Math.floor(k), cc = Math.ceil(k); return s[f] + (s[cc] - s[f]) * (k - f); }

  /** Identities that must hold; each is returned with both sides so a failure shows exactly where it is. */
  function reconcile(c, end) {
    const { acct, tradebook, fills, daily, stats } = c;
    const exec = fills.filter(f => f.status !== 'rejected');
    const checks = [];
    const add = (name, a, b, tol) => checks.push({ name, a: R(a, 4), b: R(b, 4), ok: Math.abs(a - b) <= (tol == null ? 0.01 : tol) });
    add('balance = initial capital + sum of tradebook net P&L', end, acct.initial_capital + sum(tradebook.map(t => t.net_pnl)));
    add('balance = initial capital + sum of daily net realised', end, acct.initial_capital + sum(daily.map(d => d.net_realised)));
    add('balance = initial capital + sum of per-fill (realised - charges)', end, acct.initial_capital + sum(exec.map(f => f.realised_gross - f.charges)));
    add('tradebook gross = ledger cumulative realised gross', sum(tradebook.map(t => t.gross_pnl)), stats.cumGross);
    add('tradebook charges = ledger cumulative charges', sum(tradebook.map(t => t.charges)), stats.cumCharges);
    add('charge components add to the total', sum(exec.map(f => f.brokerage + f.stt + f.exchange + f.gst + f.sebi + f.stamp)), sum(exec.map(f => f.charges)), 0.01 + 0.001 * exec.length);
    add('every fill is closed: no position left open at the end', exec.filter(f => f.event === 'OPEN').length, exec.filter(f => f.event === 'CLOSE' || f.event === 'LIQUIDATE').length, 0);
    add('ledger charges = engine cost lines (same dated rates)', stats.engineCostDiff, 0, 0.05 + 0.01 * stats.orders);
    const lastDay = daily.length ? daily[daily.length - 1] : null;
    add('unrealised P&L at the end = 0 (nothing left open, nothing double counted)', lastDay ? lastDay.unrealised_end : 0, 0, 0.005);
    add('closing equity of the last day = ending balance', lastDay ? lastDay.closing_equity : end, end);
    return { ok: checks.every(x => x.ok), checks };
  }

  // ------------------------------------------------------------------ CSV
  function csvCell(v) {
    if (v == null) return '';
    if (typeof v === 'number') return isFinite(v) ? String(R(v, 4)) : '';
    const s = String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function toCsv(rows, cols) {
    cols = cols || (rows.length ? Object.keys(rows[0]) : []);
    return [cols.join(',')].concat(rows.map(r => cols.map(k => csvCell(r[k])).join(','))).join('\r\n') + '\r\n';
  }
  const TRADEBOOK_COLS = ['trade_no', 'date', 'leg', 'kind', 'symbol', 'side', 'strike', 'expiry', 'direction', 'qty', 'lots', 'lot_size', 'entry_time', 'entry_px', 'exit_time', 'exit_px', 'exit_reason',
    'premium', 'notional', 'margin_blocked', 'gross_pnl', 'brokerage', 'stt', 'exchange', 'gst', 'sebi', 'stamp', 'charges', 'net_pnl', 'cost_schedule', 'cost_rates_verified', 'intrabar_entry', 'intrabar_exit',
    'entry_reason', 'balance_before', 'available_margin_before', 'fills', 'flags', 'audit', 'position_id', 'exit_date'];
  const FILL_COLS = ['seq', 'date', 'time', 'leg', 'trade_no', 'event', 'status', 'action', 'side', 'strike', 'expiry', 'qty', 'lots', 'px', 'turnover', 'notional', 'reason', 'opening_balance', 'available_margin_before',
    'margin_required', 'margin_blocked', 'margin_released', 'premium_held', 'position_value', 'realised_gross', 'unrealised_gross', 'brokerage', 'stt', 'exchange', 'gst', 'sebi', 'stamp', 'charges',
    'available_margin_after', 'balance_after', 'equity_after', 'cum_realised_gross', 'cum_charges', 'cum_net_realised', 'exposure_after', 'utilisation_pct', 'shortfall', 'cost_schedule', 'intrabar'];
  const DAILY_COLS = ['date', 'status', 'opening_balance', 'trades', 'rejected', 'fills', 'gross_realised', 'charges', 'net_realised', 'closing_balance', 'peak_margin', 'peak_deployed', 'peak_exposure', 'min_available',
    'peak_util_pct', 'intraday_low_equity', 'intraday_peak_unrealised', 'drawdown', 'drawdown_pct', 'lot_size', 'exit_reason', 'reason', 'flags', 'open_legs', 'unrealised_end', 'closing_equity'];

  function performanceCsv(rep) {
    const rows = [['section', 'metric', 'value', 'denominator_or_definition']];
    const put = (sec, k, v, def) => rows.push([sec, k, v, def || '']);
    const d = rep.defs;
    for (const [k, v] of Object.entries(rep.capital)) put('capital', k, v, d[k] || d[k.replace(/_pct$/, '')] || '');
    for (const [k, v] of Object.entries(rep.margin)) if (typeof v !== 'object') put('margin', k, v, k === 'peak_utilisation_pct' ? d.margin_utilisation_peak : 'ESTIMATED');
    for (const [k, v] of Object.entries(rep.pnl)) if (typeof v !== 'object') put('pnl', k, v, '');
    for (const [k, v] of Object.entries(rep.pnl.charges)) put('charges', k, v, '');
    for (const [k, v] of Object.entries(rep.returns)) if (typeof v !== 'object' && v != null) put('returns', k, v, d[k.replace('pct_', 'ret_').replace('_pct', '')] || d[k] || '');
    for (const [k, v] of Object.entries(rep.returns.monthly)) put('monthly_pnl', k, v, 'sum of daily net realised in the month');
    for (const [k, v] of Object.entries(rep.returns.annual)) put('annual_pnl', k, v, 'sum of daily net realised in the year');
    for (const [k, v] of Object.entries(rep.performance)) if (typeof v !== 'object' && v != null) put('performance', k, v, d[k] || '');
    for (const [k, v] of Object.entries(rep.risk)) if (typeof v !== 'object' && v != null) put('risk', k, v, d[k] || '');
    rep.reconciliation.checks.forEach(ch => put('reconciliation', ch.name, ch.ok ? 'OK' : 'FAIL', `${ch.a} vs ${ch.b}`));
    for (const w of rep.warnings) put('warning', '', w, '');
    put('run', 'cost_table_version', rep.generated.cost_table_version, '');
    put('run', 'run_hash', rep.generated.run_hash, 'hash of engine config + account config + data fingerprint + cost table version');
    return rows.map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
  }

  return { COST_TABLE, COST_TABLE_VERSION, ACCOUNT_DEFAULTS, POLICIES, POLICY_TEXT, MARGIN_MODELS, makeAccount, ratesFor, ratesHook, chargesFor, settlementCharges, marginFor, hedgedMargin, runLedger, toCsv, performanceCsv,
    TRADEBOOK_COLS, FILL_COLS, DAILY_COLS, hashStr };
});
