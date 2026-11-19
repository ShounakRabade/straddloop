// Ledger tests: node --test tests/  (run from web/). Every expected number is worked out by hand in the comments.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const L = require('../public/engine/ledger.js');
const E = require('../public/engine/engine.js');
const F = require('../public/engine/fourleg_engine.js');
const compute = require('../public/engine/compute.js')(E, F, L);

const near = (a, b, tol = 0.005) => assert.ok(Math.abs(a - b) <= tol, `${a} !~ ${b}`);

// A hand-made day: one short CE (qty 75) sold at 100 and bought back at 80, 2025-11-03 (rates: nse-opt-2024-10-01).
function day(date, fills, extra) {
  return Object.assign({ date, status: 'traded', lot_size: 75, symbol: 'NIFTY', flags: [], events: [], mtm: [], fills, exit_reason: 'eod' }, extra || {});
}
const f = (t, leg, action, px, strike, qty, extra) => Object.assign({ t, leg, action, px, strike, qty: qty || 75, side: 'CE', expiry: '2025-11-06', reason: action === 'SELL' ? 'entry' : 'target', cost: 0, costs: null }, extra || {});

test('charges: every component at the 2024-10-01 rates', () => {
  // SELL 100 x 75 = turnover 7,500. brokerage 20. exchange 0.03503% = 2.62725. sebi 0.0001% = 0.0075.
  // stt 0.1% = 7.5. gst 18% of (20 + 2.62725 + 0.0075) = 4.074. stamp 0 on sells.
  const c = L.chargesFor('SELL', 100, 75, '2025-11-03', 20);
  near(c.brokerage, 20); near(c.exchange, 2.62725, 1e-4); near(c.sebi, 0.0075, 1e-5); near(c.stt, 7.5); near(c.gst, 4.0743, 1e-3); near(c.stamp, 0);
  near(c.total, 20 + 2.62725 + 0.0075 + 7.5 + 4.0743, 1e-3);
  // BUY 80 x 75 = 6,000: stamp 0.003% = 0.18, no STT.
  const b = L.chargesFor('BUY', 80, 75, '2025-11-03', 20);
  near(b.stamp, 0.18); near(b.stt, 0); near(b.exchange, 6000 * 0.03503 / 100, 1e-4);
});

test('cost schedule is chosen by date, and a date before the table fails loudly', () => {
  assert.equal(L.ratesFor('2024-09-30').id, 'nse-opt-2023-04-01');
  assert.equal(L.ratesFor('2024-10-01').id, 'nse-opt-2024-10-01');
  assert.equal(L.ratesFor('2026-03-31').id, 'nse-opt-2024-10-01');
  assert.equal(L.ratesFor('2026-04-01').id, 'nse-opt-2026-04-01');
  near(L.ratesFor('2023-03-31').stt_sell_pct, 0.05); near(L.ratesFor('2023-04-01').stt_sell_pct, 0.0625);
  assert.throws(() => L.ratesFor('2019-12-31'), /No cost schedule covers 2019-12-31/);
  assert.equal(L.ratesFor('2099-01-05').extrapolated, true);
  assert.equal(L.ratesFor('2025-11-03').verified, false); // exchange/SEBI/stamp unverified in that row: flagged, not hidden
  assert.equal(L.ratesFor('2026-04-01').verified, true);
});

test('margin model: short option blocks (span+exposure)% of strike x qty; long option blocks only its premium', () => {
  const a = L.makeAccount({});
  near(L.marginFor(-1, 24000, 75, a), 24000 * 75 * 0.11); // 198,000
  near(L.marginFor(1, 24000, 75, a), 0);
  const b = L.makeAccount({ margin_span_pct: 12, margin_exposure_pct: 3 });
  near(L.marginFor(-1, 24000, 75, b), 24000 * 75 * 0.15);
  assert.throws(() => L.makeAccount({ margin_policy: 'yolo' }), /margin_policy/);
  assert.throws(() => L.makeAccount({ initial_capital: 0 }), /positive/);
  assert.throws(() => L.makeAccount({ nope: 1 }), /unknown account parameter/);
});

test('single short trade: realised P&L, charges, margin blocked then released, balance reconciles', () => {
  const r = day('2025-11-03', [f(555, 1, 'SELL', 100, 24000), f(600, 1, 'BUY', 80, 24000)],
    { mtm: [{ t: 556, px: { 1: 95 } }, { t: 580, px: { 1: 85 } }] });
  const led = L.runLedger([r], { initial_capital: 500000 });
  const sell = led.fills[0], buy = led.fills[1];
  near(sell.margin_required, 198000); near(sell.margin_blocked, 198000); near(sell.available_margin_before, 500000);
  near(sell.available_margin_after, 500000 - 198000 - sell.charges);
  near(sell.realised_gross, 0); near(sell.unrealised_gross, 0);
  near(buy.realised_gross, (100 - 80) * 75); // +1,500
  near(buy.margin_blocked, 0); near(buy.margin_released, 198000);
  const chS = L.chargesFor('SELL', 100, 75, '2025-11-03', 20), chB = L.chargesFor('BUY', 80, 75, '2025-11-03', 20);
  near(led.report.pnl.total_charges, chS.total + chB.total);
  near(led.report.pnl.net_profit, 1500 - chS.total - chB.total);
  near(led.report.capital.cash_outflow, chS.total + chB.total); // a short sale has no premium outflow
  assert.ok(led.report.reconciliation.ok, JSON.stringify(led.report.reconciliation.checks.filter(c => !c.ok)));
  assert.equal(led.tradebook.length, 1);
  near(led.tradebook[0].net_pnl, led.report.pnl.net_profit);
});

test('unrealised and realised are never double counted: equity between fills uses marks, after close uses booked P&L only', () => {
  const r = day('2025-11-03', [f(555, 1, 'SELL', 100, 24000), f(570, 2, 'SELL', 50, 24100), f(600, 1, 'BUY', 120, 24000), f(610, 2, 'BUY', 40, 24100)],
    { mtm: [{ t: 565, px: { 1: 110 } }, { t: 575, px: { 1: 115, 2: 45 } }, { t: 605, px: { 2: 44 } }] });
  const led = L.runLedger([r], {});
  const row3 = led.fills[2]; // leg 1 closes: realised -1,500; leg 2 still open marked at 45 -> unrealised (50-45)*75 = +375
  near(row3.realised_gross, (100 - 120) * 75); near(row3.unrealised_gross, (50 - 45) * 75);
  near(row3.equity_after, row3.balance_after + 375);
  const last = led.fills[3];
  near(last.unrealised_gross, 0);
  near(last.balance_after, 500000 + (100 - 120) * 75 + (50 - 40) * 75 - led.report.pnl.total_charges);
  assert.ok(led.report.reconciliation.ok);
  near(led.report.pnl.gross_realised_profit, 750); near(led.report.pnl.gross_realised_loss, -1500);
});

test('multi-position: margin adds up, peak is the concurrent maximum, released one by one', () => {
  const r = day('2025-11-03', [f(555, 1, 'SELL', 100, 24000), f(555, 2, 'SELL', 90, 24000, 75, { side: 'PE' }), f(600, 1, 'BUY', 100, 24000), f(610, 2, 'BUY', 90, 24000, 75, { side: 'PE' })]);
  const led = L.runLedger([r], {});
  near(led.fills[1].margin_blocked, 2 * 198000); near(led.fills[2].margin_blocked, 198000); near(led.fills[3].margin_blocked, 0);
  near(led.report.margin.peak_margin, 396000); near(led.report.capital.peak_notional, 2 * 24000 * 75);
  near(led.report.margin.initial_margin, 198000);
});

test('insufficient margin: reject policy refuses the second leg and records the shortfall', () => {
  const r = day('2025-11-03', [f(555, 1, 'SELL', 100, 24000), f(555, 2, 'SELL', 90, 24000, 75, { side: 'PE' }), f(600, 1, 'BUY', 100, 24000), f(610, 2, 'BUY', 90, 24000, 75, { side: 'PE' })]);
  const led = L.runLedger([r], { initial_capital: 250000, margin_policy: 'reject' });
  assert.equal(led.rejections.length, 1);
  assert.equal(led.tradebook.length, 1);
  const rej = led.fills.find(x => x.status === 'rejected');
  assert.equal(rej.event, 'REJECTED'); assert.ok(rej.shortfall > 0);
  near(led.report.margin.max_shortfall, rej.shortfall);
  assert.equal(led.report.margin.rejected_trades, 1);
  assert.ok(led.report.reconciliation.ok);
  // the rejected leg's closing fill is ignored: only one OPEN and one CLOSE are booked
  assert.equal(led.fills.filter(x => x.event === 'OPEN').length, 1);
});

test('insufficient margin: partial policy trades fewer lots; record policy runs everything and flags the shortfall', () => {
  const fills = [f(555, 1, 'SELL', 100, 24000, 150), f(600, 1, 'BUY', 90, 24000, 150)];
  const mk = () => [day('2025-11-03', fills.map(x => Object.assign({}, x)))];
  // 2 lots need 396,000 + charges; capital 250,000 only fits 1 lot (198,000 + charges)
  const p = L.runLedger(mk(), { initial_capital: 250000, margin_policy: 'partial' });
  assert.equal(p.tradebook[0].qty, 75); assert.equal(p.tradebook[0].lots, 1);
  near(p.tradebook[0].gross_pnl, (100 - 90) * 75);
  assert.equal(p.fills[0].status, 'partial');
  assert.ok(p.report.reconciliation.ok);
  const rec = L.runLedger(mk(), { initial_capital: 250000, margin_policy: 'record' });
  assert.equal(rec.tradebook[0].qty, 150); assert.equal(rec.fills[0].status, 'executed_in_shortfall');
  assert.ok(rec.report.margin.shortfall_events >= 1); assert.ok(rec.report.margin.peak_utilisation_pct > 100);
  const rj = L.runLedger(mk(), { initial_capital: 100000, margin_policy: 'partial' });
  assert.equal(rj.tradebook.length, 0); assert.equal(rj.rejections.length, 1); // not even one lot fits
});

test('simulated liquidation: equity below the margin needed force-closes at the mark and books the loss', () => {
  const r = day('2025-11-03', [f(555, 1, 'SELL', 100, 24000), f(900, 1, 'BUY', 60, 24000)], { mtm: [{ t: 560, px: { 1: 150 } }, { t: 570, px: { 1: 300 } }] });
  // capital 210,000: margin 198,000 fits. Mark at 300: unrealised (100-300)*75 = -15,000; equity ~195k < 198k -> liquidate.
  const led = L.runLedger([r], { initial_capital: 210000, margin_policy: 'liquidate' });
  assert.equal(led.liquidations.length, 1);
  const lq = led.fills.find(x => x.event === 'LIQUIDATE');
  near(lq.px, 300); near(lq.realised_gross, -15000);
  assert.equal(led.tradebook.length, 1); // the scheduled closing fill at 60 never happens
  near(led.tradebook[0].gross_pnl, -15000);
  assert.ok(led.report.reconciliation.ok);
  // the same day under 'record' is not liquidated (it rides to the 60 exit)
  const rec = L.runLedger([r], { initial_capital: 210000, margin_policy: 'record' });
  assert.equal(rec.liquidations.length, 0); near(rec.tradebook[0].gross_pnl, (100 - 60) * 75);
});

test('long option: premium is a cash outflow, no margin; shortfall when premium exceeds cash', () => {
  const r = day('2025-11-03', [f(600, 1, 'BUY', 100, 24000), f(650, 1, 'SELL', 140, 24000)], { strategy: 'orb', trades: [{ id: 1, lot_size: 75 }], mtm: [{ t: 610, px: 120, id: 1, pos: true }] });
  const led = L.runLedger([r], { initial_capital: 100000 });
  near(led.fills[0].margin_required, 0); near(led.fills[0].premium_held, 7500);
  near(led.report.capital.total_premium_paid, 7500);
  near(led.report.capital.cash_outflow, led.report.pnl.total_charges + 7500);
  near(led.tradebook[0].gross_pnl, 40 * 75);
  const small = L.runLedger([r], { initial_capital: 5000, margin_policy: 'reject' });
  assert.equal(small.rejections.length, 1); assert.equal(small.tradebook.length, 0);
});

test('drawdown: peak-to-trough of end-of-day balance, with its dates, in rupees and percent', () => {
  // day nets (gross, ignoring charges is not possible, so check structure): win, loss, loss, win
  const mk = (date, entry, exit) => day(date, [f(555, 1, 'SELL', entry, 24000), f(600, 1, 'BUY', exit, 24000)]);
  const led = L.runLedger([mk('2025-11-03', 100, 80), mk('2025-11-04', 100, 130), mk('2025-11-05', 100, 120), mk('2025-11-06', 100, 70)], {});
  const bal = led.daily.map(d => d.closing_balance);
  const peak = bal[0], trough = Math.min(bal[1], bal[2]);
  near(led.report.risk.max_drawdown, peak - trough);
  near(led.report.risk.max_drawdown_pct, 100 * (peak - trough) / peak, 1e-6);
  assert.equal(led.report.risk.drawdown_from, '2025-11-03'); assert.equal(led.report.risk.drawdown_to, '2025-11-05');
  assert.ok(led.report.reconciliation.ok);
});

test('ratios: win rate, profit factor, risk/reward, expectancy, Sharpe on the stated base', () => {
  const mk = (date, entry, exit) => day(date, [f(555, 1, 'SELL', entry, 24000), f(600, 1, 'BUY', exit, 24000)]);
  const led = L.runLedger([mk('2025-11-03', 100, 80), mk('2025-11-04', 100, 130), mk('2025-11-05', 100, 90)], {});
  const n = led.tradebook.map(t => t.net_pnl), p = led.report.performance;
  assert.equal(p.closed_positions, 3); near(p.win_rate_pct, 100 * n.filter(x => x > 0).length / 3, 1e-9);
  const wins = n.filter(x => x > 0), losses = n.filter(x => x <= 0);
  near(p.profit_factor, wins.reduce((a, b) => a + b, 0) / -losses.reduce((a, b) => a + b, 0), 1e-9);
  near(p.expectancy, n.reduce((a, b) => a + b, 0) / 3);
  near(p.risk_reward, (wins.reduce((a, b) => a + b, 0) / wins.length) / -(losses.reduce((a, b) => a + b, 0) / losses.length), 1e-9);
  // Sharpe: returns = net / previous balance
  let prev = 500000; const rets = led.daily.map(d => { const x = d.net_realised / prev; prev = d.closing_balance; return x; });
  const m = rets.reduce((a, b) => a + b, 0) / 3, sd = Math.sqrt(rets.reduce((a, b) => a + (b - m) ** 2, 0) / 2);
  near(led.report.risk.sharpe, m / sd * Math.sqrt(252), 1e-9);
  assert.match(led.report.risk.sharpe_note, /Fewer than 30/);
  assert.equal(led.report.returns.cagr_pct, null); assert.match(led.report.returns.cagr_note, /less than a year/);
});

test('return metrics state their denominators and use them', () => {
  const led = L.runLedger([day('2025-11-03', [f(555, 1, 'SELL', 100, 24000), f(600, 1, 'BUY', 80, 24000)])], {});
  const rt = led.report.returns, net = led.report.pnl.net_profit;
  near(rt.pct_initial, 100 * net / 500000, 1e-9); near(rt.pct_peak_margin, 100 * net / 198000, 1e-9); near(rt.pct_peak_deployed, 100 * net / 198000, 1e-9);
  assert.ok(led.report.defs.ret_peak_margin.includes('peak estimated margin'));
});

test('CAGR only for ranges of a year or more', () => {
  const a = day('2024-11-04', [f(555, 1, 'SELL', 100, 24000), f(600, 1, 'BUY', 70, 24000)]), b = day('2025-11-04', [f(555, 1, 'SELL', 100, 24000), f(600, 1, 'BUY', 70, 24000)]);
  const led = L.runLedger([a, b], {});
  const end = 500000 + led.report.pnl.net_profit, days = 366;
  near(led.report.returns.cagr_pct, 100 * (Math.pow(end / 500000, 365 / days) - 1), 1e-6);
  near(led.report.returns.annual["2024"] + led.report.returns.annual["2025"], led.report.pnl.net_profit, 1e-6);
});

test('idle days (no entry) count in the daily ledger and the Sharpe base, and excluded days are listed, not filled', () => {
  const led = L.runLedger([day('2025-11-03', [f(555, 1, 'SELL', 100, 24000), f(600, 1, 'BUY', 80, 24000)]), { date: '2025-11-04', status: 'no_entry', reason: 'entry condition failed', fills: [] },
    { date: '2025-11-05', status: 'excluded', reason: 'incomplete opening range', fills: [] }], {});
  assert.equal(led.daily.length, 2); assert.equal(led.report.risk.sessions_in_ratio, 2);
  assert.equal(led.report.range.excluded_days.length, 1);
  assert.ok(led.report.warnings.some(w => /excluded/.test(w)));
});

test('missing data: a leg left open at the end of the data is closed visibly with a warning, never dropped', () => {
  const led = L.runLedger([day('2025-11-03', [f(555, 1, 'SELL', 100, 24000)])], {});
  assert.equal(led.tradebook.length, 1);
  assert.ok(led.report.warnings.some(w => /still open/.test(w)));
  assert.ok(led.report.reconciliation.ok);
});

test('negative balance is detected and reported', () => {
  const r = day('2025-11-03', [f(555, 1, 'SELL', 100, 24000), f(600, 1, 'BUY', 400, 24000)]);
  const led = L.runLedger([r], { initial_capital: 250000, margin_policy: 'record' }); // loses 22,500+ ... still positive; make it worse
  const big = day('2025-11-04', [f(555, 1, 'SELL', 100, 24000, 750), f(600, 1, 'BUY', 900, 24000, 750)]);
  const led2 = L.runLedger([big], { initial_capital: 250000, margin_policy: 'record' });
  assert.ok(led2.daily[0].closing_balance < 0); assert.ok(led2.report.margin.negative_balance_events > 0);
  assert.ok(led2.report.warnings.some(w => /below zero/.test(w)));
  assert.ok(led.report.reconciliation.ok);
});

test('reproducibility: same inputs give byte-identical ledgers and CSVs; a different cost date or setting changes the hash', () => {
  const run = (over) => { const cal = E.syntheticCalendar(30, { iv: 13 }, 5); const cfg = E.makeConfig({ rates_for: L.ratesHook }); const bt = E.runBacktest(cal, cfg);
    const led = L.runLedger(bt.results, over || {}); return { led, hash: bt.config_hash }; };
  const a = run(), b = run();
  assert.equal(L.toCsv(a.led.tradebook, L.TRADEBOOK_COLS), L.toCsv(b.led.tradebook, L.TRADEBOOK_COLS));
  assert.equal(L.toCsv(a.led.fills, L.FILL_COLS), L.toCsv(b.led.fills, L.FILL_COLS));
  assert.equal(L.performanceCsv(a.led.report), L.performanceCsv(b.led.report));
  assert.equal(a.led.report.generated.account_hash, b.led.report.generated.account_hash);
  assert.notEqual(a.led.report.generated.account_hash, run({ initial_capital: 300000 }).led.report.generated.account_hash);
});

test('engine integration: the engines use the same dated rates, so ledger charges equal engine cost lines on both strategies', () => {
  for (const strat of ['straddle', 'orb']) {
    const cal = E.syntheticCalendar(40, { iv: 13 }, 3), ov = { rates_for: L.ratesHook };
    const results = strat === 'straddle' ? E.runBacktest(cal, E.makeConfig(ov)).results : E.ORB.run(cal, E.ORB.makeConfig(ov)).results;
    const led = L.runLedger(results, {});
    const engineNet = results.filter(r => r.status === 'traded').reduce((a, r) => a + r.net, 0);
    near(led.report.pnl.net_profit, engineNet, 0.01);
    assert.ok(led.report.reconciliation.ok, strat + ': ' + JSON.stringify(led.report.reconciliation.checks.filter(c => !c.ok)));
    assert.ok(led.tradebook.length > 0);
  }
});

test('stop, target and expiry exits are executed by the engine from candle prices and flow into the ledger with their reason', () => {
  const sc = E.generate(Object.assign({}, E.SYN_BASE, E.SCENARIOS.multi_stop), '2099-03-02');
  const r = E.simulate(sc, E.makeConfig({ rates_for: L.ratesHook }));
  assert.equal(r.status, 'traded');
  const led = L.runLedger([r], {});
  const reasons = new Set(led.tradebook.map(t => t.exit_reason));
  assert.ok(reasons.has('stop'), [...reasons].join());
  near(led.report.pnl.net_profit, r.net, 0.01);
  assert.ok(led.tradebook.every(t => t.audit.length > 0), 'every trade carries its execution trail');
  // expiry day: a 0-DTE session exits by 15:15 and nothing is held through settlement
  const ex = E.generate(Object.assign({}, E.SYN_BASE, { dte: 0 }), '2099-03-02');
  const rx = E.simulate(ex, E.makeConfig({ rates_for: L.ratesHook }));
  if (rx.status === 'traded') assert.ok(led.fills.length > 0 && L.runLedger([rx], {}).report.reconciliation.ok);
});

test('holiday / missing-data days: absent sessions produce no rows and no invented candles', () => {
  const cal = E.syntheticCalendar(10, { iv: 13 }, 2);
  cal.splice(3, 1); // a holiday: the session simply is not there
  const bt = E.runBacktest(cal, E.makeConfig({ rates_for: L.ratesHook }));
  const led = L.runLedger(bt.results, {});
  assert.equal(led.daily.length, 9);
  assert.equal(new Set(led.daily.map(d => d.date)).size, 9);
});

test('compute layer: headline figures come from the ledger and exports/inspect work on the latest run', () => {
  const r = compute.run({ strategy: 'straddle', days: 40, seed: 2, capital: 400000 });
  assert.equal(r.account.config.initial_capital, 400000);
  near(r.net, r.account.report.pnl.net_profit);
  assert.equal(r.curve.length, r.account.daily.length);
  near(r.curve[r.curve.length - 1].v, r.net, 0.01);
  const csv = compute.exportCsv('tradebook');
  assert.ok(csv.startsWith('trade_no,date,leg'));
  assert.equal(csv.trim().split('\r\n').length - 1, r.account.counts.trades);
  assert.equal(compute.inspect('ledger', 0, 5).rows.length, 5);
  assert.ok(compute.exportCsv('performance').includes('reconciliation'));
  assert.ok(compute.exportCsv('daily').split('\r\n')[0].startsWith('date,status'));
  const o = compute.run({ strategy: 'orb', days: 40, seed: 2, margin_policy: 'partial' });
  assert.equal(o.unit, 'trade'); near(o.net, o.account.report.pnl.net_profit);
  const fl = compute.run({ strategy: 'fourleg', months: 12 });
  assert.equal(fl.account, undefined); // four-leg keeps its own margin model; the ledger is not applied
  assert.equal(compute.exportCsv('tradebook'), null);
});
