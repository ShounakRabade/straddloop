'use client';
/**
 * The results workspace: executive header, then one panel at a time (overview, capital, charts, trades,
 * sessions, replay, diagnostics, ledger). Every figure is read from the run result, its ledger report or the
 * ledger rows the worker returns; nothing here estimates or smooths a number.
 */
import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react';
import { exitLabel, inr, inr2, num2, pct2, shortDate } from '@/lib/format';
import { GLOSSARY } from '@/lib/glossary';
import { narrate, byExit } from '@/lib/narrative';
import { outcomeLabel, outcomesOf } from '@/lib/outcomes';
import { rollingSharpe, rollingVol } from '@/lib/rolling';
import { holdMinutes } from '@/lib/tradeFilter';
import type { DateRange } from '@/lib/dateRange';
import type { ExportKind, LedgerRow, Report, RunResult } from '@/lib/types';
import type { Page } from '@/lib/useLab';
import { Capital as CapitalTable, CostTable, LedgerTab, Performance, Risk, Summary, Warnings, downloadText } from '@/components/Report';
import { ReplayPanel } from '@/components/Replay';
import { BarPlot, Histogram, LinePlot, compactInr } from './Plot';
import { Tradebook } from './Tradebook';
import { Tip } from './kit';

export type LabApi = {
  exportCsv: (k: ExportKind) => Promise<string | null>;
  inspect: (k: 'tradebook' | 'ledger' | 'daily', offset: number, limit: number) => Promise<Page | null>;
  replay: (date: string) => Promise<import('@/lib/types').Replay | null>;
};
export type Baseline = { label: string; dataKey: string; strategy: string; m: Record<string, number | null> };
export type TabId = 'overview' | 'capital' | 'charts' | 'trades' | 'sessions' | 'replay' | 'research' | 'diagnostics' | 'ledger';

const tone = (v: number | null | undefined) => (v == null ? '' : v > 0 ? 'gain' : v < 0 ? 'loss' : '');
const n = (v: unknown) => (typeof v === 'number' && isFinite(v) ? v : null);
const signedPct = (v: number | null, d = 2) => (v == null ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(d)}%`);
const NA = <span className="na">—</span>;

/** Headline numbers used by the executive header and by baseline comparison. */
export function headline(r: RunResult): Record<string, number | null> {
  const rep = r.account?.report;
  return {
    net: r.net, pct_initial: rep ? n(rep.returns.pct_initial) : null, cagr: rep ? n(rep.returns.cagr_pct) : null,
    trades: rep ? n(rep.performance.closed_positions) : r.traded, win_rate: rep ? n(rep.performance.win_rate_pct) : r.winRate,
    pf: rep ? n(rep.performance.profit_factor) : r.profitFactor, max_dd: rep ? n(rep.risk.max_drawdown) : Math.abs(r.maxDD),
    sharpe: rep ? n(rep.risk.sharpe) : null, sortino: rep ? n(rep.risk.sortino) : null, rpm: rep ? n(rep.returns.pct_peak_margin) : null,
  };
}

function Metric({ k, label, tip, def, value, sub, cls = '', lead = false, delta, est, extra }: {
  k: string; label: string; tip: string; def?: string | null; value: ReactNode; sub?: ReactNode; cls?: string; lead?: boolean; delta?: string | null; est?: boolean; extra?: ReactNode;
}) {
  return (
    <div className={`m ${lead ? 'm--lead' : ''}`} data-k={k}>
      <div className="m-top"><span className="lbl">{label}</span>{est && <span className="est2">est.</span>}<Tip label={label} text={tip} def={def} /></div>
      <div className={`m-v ${cls}`}>{value}</div>
      {sub && <div className="m-s">{sub}</div>}
      {delta && <div className="m-d">{delta}</div>}
      {extra}
    </div>
  );
}

/** A small, non-interactive trace of the cumulative net P&L under the headline figure. The Charts tab has the readable one. */
function Spark({ r }: { r: RunResult }) {
  const pts = r.curve.map((p) => p.v);
  if (pts.length < 2) return null;
  const all = [0, ...pts], lo = Math.min(...all), hi = Math.max(...all), span = hi - lo || 1;
  const W = 240, H = 44, x = (i: number) => (i / (pts.length - 1)) * W, y = (v: number) => H - 2 - ((v - lo) / span) * (H - 4);
  return (
    <svg className="spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
      <line x1="0" x2={W} y1={y(0)} y2={y(0)} className="spark-zero" />
      <polyline points={pts.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')} className={r.net >= 0 ? 'spark-g' : 'spark-l'} />
    </svg>
  );
}

function deltaOf(k: string, cur: number | null, base: Baseline | null, fmt: (v: number) => string): string | null {
  if (!base) return null;
  const b = base.m[k];
  if (cur == null || b == null) return `${base.label}: —`;
  const d = cur - b;
  return `${base.label}: ${fmt(b)} (${d === 0 ? 'same' : `${d > 0 ? '+' : '−'}${fmt(Math.abs(d)).replace(/^[+−]/, '')}`})`;
}

export function Exec({ r, busy, baseline }: { r: RunResult; busy: boolean; baseline: Baseline | null }) {
  const rep = r.account?.report, h = headline(r);
  const money = (v: number) => inr(v, { sign: true });
  if (!rep) {
    const ok = r.traded >= 2;
    return (
      <div className="exec" data-busy={busy} aria-label="Headline results">
        <Metric k="net" lead label="Net P&L" tip={GLOSSARY.net} value={inr(r.net, { sign: true })} cls={tone(r.net)} sub={<>Gross {inr(r.gross, { sign: true })} · charges {inr(r.costs)}</>} delta={deltaOf('net', r.net, baseline, money)} />
        <Metric k="avg" label={`Average ${r.unit}`} tip={GLOSSARY.ci} value={inr(r.avg, { sign: true })} cls={tone(r.avg)} sub={ok && r.ci ? <>95% range {inr(r.ci[0], { sign: true })} to {inr(r.ci[1], { sign: true })}</> : 'Range needs 2+ traded periods'} />
        <Metric k="trades" label="Months traded" tip={GLOSSARY.trades} value={<>{r.traded}</>} sub={`of ${r.sessions} stock-months`} />
        <Metric k="win_rate" label="Win rate" tip={GLOSSARY.win_rate} value={pct2(r.winRate, 1)} sub="of traded months" delta={deltaOf('win_rate', r.winRate, baseline, (v) => `${v.toFixed(1)}%`)} />
        <Metric k="pf" label="Profit factor" tip={GLOSSARY.profit_factor} value={r.profitFactor == null ? NA : num2(r.profitFactor)} />
        <Metric k="max_dd" label="Max drawdown" tip={GLOSSARY.max_dd} value={h.max_dd ? `−${inr(h.max_dd).replace('−', '')}` : '₹0'} cls={h.max_dd ? 'loss' : ''} />
        <Metric k="costs" label="Charges" tip={GLOSSARY.charges} value={inr(r.costs)} sub="already inside net" />
      </div>
    );
  }
  const pf = rep.performance, rk = rep.risk, rt = rep.returns, c = rep.capital;
  const dd = n(rk.max_drawdown) ?? 0;
  return (
    <div className="exec" data-busy={busy} aria-label="Headline results">
      <Metric k="net" lead label="Net P&L" tip={GLOSSARY.net} def={rep.defs.net_profit} value={inr(r.net, { sign: true })} cls={tone(r.net)}
        delta={deltaOf('net', r.net, baseline, money)}
        extra={<>
          <Spark r={r} />
          <dl className="lead-dl">
            <dt>Gross P&amp;L</dt><dd className={tone(r.gross)}>{inr(r.gross, { sign: true })}</dd>
            <dt>Charges</dt><dd>−{inr(r.costs).replace('−', '')}</dd>
            <dt>Starting capital</dt><dd>{inr(Number(c.initial_capital))}</dd>
            <dt>Ending balance</dt><dd>{inr(Number(rep.pnl.ending_balance))}</dd>
          </dl>
        </>} />
      <Metric k="pct_initial" label="Net return" tip={GLOSSARY.net_return} def={rep.defs.ret_initial} value={signedPct(h.pct_initial)} cls={tone(h.pct_initial)}
        sub={`of ${inr(Number(c.initial_capital))} capital`} delta={deltaOf('pct_initial', h.pct_initial, baseline, (v) => signedPct(v))} />
      <Metric k="cagr" label="CAGR" tip={GLOSSARY.cagr} def={rep.defs.cagr} value={h.cagr == null ? NA : signedPct(h.cagr)} cls={tone(h.cagr)} sub={h.cagr == null ? (rt.cagr_note ?? 'not shown') : 'annualised'} />
      <Metric k="trades" label="Trades" tip={GLOSSARY.trades} value={h.trades ?? NA}
        sub={r.unit === 'day' ? `${r.traded} traded day${r.traded === 1 ? '' : 's'} of ${r.sessions}` : `in ${r.sessions} sessions`} delta={deltaOf('trades', h.trades, baseline, (v) => String(v))} />
      <Metric k="win_rate" label="Win rate" tip={GLOSSARY.win_rate} def={rep.defs.win_rate} value={h.win_rate == null ? NA : pct2(h.win_rate, 1)}
        sub={`${pf.wins} of ${pf.closed_positions} legs${r.unit === 'day' && r.traded ? ` · ${r.winRate.toFixed(0)}% of days` : ''}`} delta={deltaOf('win_rate', h.win_rate, baseline, (v) => `${v.toFixed(1)}%`)} />
      <Metric k="pf" label="Profit factor" tip={GLOSSARY.profit_factor} def={rep.defs.profit_factor} value={h.pf == null ? NA : num2(h.pf)}
        sub={h.pf == null ? (Number(pf.losses) === 0 ? 'no losing legs' : 'not defined') : 'winners ÷ losers'} delta={deltaOf('pf', h.pf, baseline, (v) => v.toFixed(2))} />
      <Metric k="max_dd" label="Max drawdown" tip={GLOSSARY.max_dd} def={rep.defs.max_dd} value={dd > 0 ? `−${inr(dd)}` : '₹0'} cls={dd > 0 ? 'loss' : ''}
        sub={dd > 0 ? `${pct2(n(rk.max_drawdown_pct))} of peak balance` : 'never below a previous peak'} delta={deltaOf('max_dd', h.max_dd, baseline, (v) => inr(v))} />
      <Metric k="sharpe" label="Sharpe" tip={GLOSSARY.sharpe} def={rep.defs.sharpe} value={h.sharpe == null ? NA : num2(h.sharpe)} sub={rk.sharpe_note ? String(rk.sharpe_note) : `${rk.sessions_in_ratio} daily returns`} delta={deltaOf('sharpe', h.sharpe, baseline, (v) => v.toFixed(2))} />
      <Metric k="sortino" label="Sortino" tip={GLOSSARY.sortino} def={rep.defs.sortino} value={h.sortino == null ? NA : num2(h.sortino)} sub={h.sortino == null ? 'no losing days to measure' : 'downside only'} delta={deltaOf('sortino', h.sortino, baseline, (v) => v.toFixed(2))} />
      <Metric k="rpm" est label="Return on peak margin" tip={GLOSSARY.ret_peak_margin} def={rep.defs.ret_peak_margin} value={signedPct(h.rpm)} cls={tone(h.rpm)}
        sub={`peak margin ${inr(Number(rep.margin.peak_margin ?? 0))}`} delta={deltaOf('rpm', h.rpm, baseline, (v) => signedPct(v))} />
    </div>
  );
}

/** One plain sentence for the top of the overview. */
export function verdictLine(r: RunResult, real: boolean): string {
  const sample = real ? 'these real NIFTY days' : 'this synthetic sample';
  if (!r.traded) return 'No trades were taken with these settings.';
  if (r.traded < 2 || !r.ci) return `One traded ${r.unit} is not evidence either way.`;
  const [lo, hi] = r.ci;
  if (lo > 0) return `Positive on ${sample}, and the 95% range stays above zero.`;
  if (hi < 0) return `A reliable loss on ${sample}: the whole 95% range is below zero.`;
  return 'This run cannot tell profit from luck: the 95% range includes zero.';
}

function Overview({ r, trades, real, slip, go }: { r: RunResult; trades: LedgerRow[] | null; real: boolean; slip: number | undefined; go: (t: TabId) => void }) {
  const blocks = useMemo(() => narrate(r, { trades, slipPct: slip, real }), [r, trades, slip, real]);
  const exits = useMemo(() => (trades ? byExit(trades) : Object.entries(r.exits).map(([reason, k]) => ({ reason, n: k, net: NaN }))), [trades, r.exits]);
  const total = exits.reduce((a, e) => a + e.n, 0) || 1;
  const ok = r.traded >= 2;
  return (
    <div className="ov panel" role="tabpanel" id="panel-overview" aria-labelledby="tab-overview">
      <div className="blk">
        <p className="verdict2"><span className="mark">{verdictLine(r, real)}</span></p>
        <div className="story">
          {blocks.map((b) => (
            <section key={b.id} data-id={b.id}>
              <h3>{b.title}</h3>
              <ul>{b.lines.map((l) => <li key={l}>{l}</li>)}</ul>
            </section>
          ))}
        </div>
        <p className="sec-note">Generated from this run’s ledger and report only. <button type="button" className="qlink" onClick={() => go('ledger')}>Check every figure in the ledger</button></p>
      </div>
      <div className="blk">
        <div className="blk-h"><h3>Cumulative net P&amp;L</h3><button type="button" className="qlink" onClick={() => go('charts')}>All charts</button></div>
        <LinePlot points={r.curve.map((p) => ({ d: p.d, v: p.v }))} fmt={(v) => inr(v, { sign: true })} height={210} label={`Cumulative net profit and loss over ${r.curve.length} points, ending at ${inr(r.net, { sign: true })}.`} />
        <div className="blk-h" style={{ marginTop: 12 }}><h3>How positions closed</h3><span className="lbl">{trades ? 'count · net' : 'count'}</span></div>
        {exits.length ? (
          <div className="xbars">
            {exits.map((e) => (
              <div className="xbar" key={e.reason}>
                <span>{exitLabel(e.reason)}</span>
                <span className="tr" aria-hidden="true"><i style={{ width: `${(100 * e.n) / total}%` }} /></span>
                <span className="num">{e.n}{isFinite(e.net) ? <> · <span className={tone(e.net)}>{inr(e.net, { sign: true })}</span></> : null}</span>
              </div>
            ))}
          </div>
        ) : <p className="sec-note">No closed positions.</p>}
        <dl className="cov" style={{ marginTop: 12 }}>
          <dt>Average {r.unit === 'day' ? 'traded day' : r.unit}</dt><dd className={tone(r.avg)}>{r.traded ? inr(r.avg, { sign: true }) : '—'}</dd>
          <dt>95% range of the average <Tip label="95% range" text={GLOSSARY.ci} /></dt><dd>{ok && r.ci ? `${inr(r.ci[0], { sign: true })} to ${inr(r.ci[1], { sign: true })}` : `needs 2+ traded ${r.unit}s`}</dd>
          {r.traded > 0 && (r.worst < 0
            ? <><dt>Worst / best {r.unit}</dt><dd><span className="loss">{inr(r.worst, { sign: true })}</span> / <span className={tone(r.best)}>{inr(r.best, { sign: true })}</span></dd></>
            : <><dt>Every traded {r.unit} gained; smallest / largest</dt><dd><span className={tone(r.worst)}>{inr(r.worst, { sign: true })}</span> / <span className={tone(r.best)}>{inr(r.best, { sign: true })}</span></dd></>)}
          {r.extra.map(([k, v]) => <Fragment key={k}><dt>{k}</dt><dd>{typeof v === 'number' ? inr(v, { sign: v < 0 }) : v}</dd></Fragment>)}
        </dl>
      </div>
    </div>
  );
}

function CapitalPanel({ r }: { r: RunResult }) {
  const rep = r.account?.report;
  if (!rep) return <div className="plot-empty panel" role="tabpanel" id="panel-capital">The four-leg strategy runs on its own synthetic margin model without the account ledger, so there is no capital and margin breakdown.</div>;
  const c = rep.capital, m = rep.margin, d = rep.defs;
  const mod = m.model as { span_pct: number; exposure_pct: number; base: string; long_options: string };
  const daily = r.account!.daily;
  const cell = (k: string, label: string, tip: string, value: ReactNode, sub?: ReactNode, est?: boolean, cls = '') => <Metric k={k} label={label} tip={tip} value={value} sub={sub} est={est} cls={cls} />;
  return (
    <div className="panel" role="tabpanel" id="panel-capital" aria-labelledby="tab-capital">
      <div className="blk">
        <div className="blk-h"><h2>Capital</h2></div>
        <div className="figs">
          {cell('ic', 'Initial capital', GLOSSARY.capital, inr(Number(c.initial_capital)))}
          {cell('inv', 'Invested (long premium)', GLOSSARY.invested, inr(Number(c.total_premium_paid ?? 0)), d.total_premium_paid)}
          {cell('dep', 'Capital deployed, peak', GLOSSARY.deployed, inr(Number(c.peak_deployed ?? 0)), `average ${inr(Number(c.avg_deployed ?? 0))}`, true)}
          {cell('util', 'Utilisation, peak', GLOSSARY.utilisation, pct2(n(c.capital_utilisation_peak_pct), 1), `average ${pct2(n(c.capital_utilisation_avg_pct), 1)}`, true)}
          {cell('end', 'Ending balance', GLOSSARY.net, inr(Number(rep.pnl.ending_balance)), 'nothing is open at the end')}
          {cell('turn', 'Turnover', 'Total value of every executed order (premium × quantity).', inr(Number(c.total_trade_value ?? 0)))}
        </div>
      </div>
      <div className="blk">
        <div className="blk-h"><h2>Margin <span className="est2">estimated</span></h2></div>
        <p className="chart-cap">Short options: {mod.span_pct}% + {mod.exposure_pct}% of {mod.base}; long options: {mod.long_options}. The same model applies to every date; it is not the exchange’s or a broker’s historical margin.</p>
        <div className="figs">
          {cell('pm', 'Peak margin', GLOSSARY.peak_margin, inr(Number(m.peak_margin ?? 0)), undefined, true)}
          {cell('am', 'Average margin', GLOSSARY.avg_margin, inr(Number(m.avg_margin ?? 0)), undefined, true)}
          {cell('min', 'Lowest available', GLOSSARY.min_available, m.min_available_margin == null ? NA : inr(Number(m.min_available_margin)), undefined, true)}
          {cell('mu', 'Max utilisation', GLOSSARY.utilisation, pct2(n(m.peak_utilisation_pct), 1), undefined, true)}
          {cell('sf', 'Margin shortfalls', GLOSSARY.shortfall, String(m.shortfall_events), Number(m.shortfall_events) ? `largest ${inr(Number(m.max_shortfall ?? 0))}` : 'none')}
          {cell('rj', 'Rejected trades', GLOSSARY.rejected, String(m.rejected_trades), String(m.policy_text))}
          {cell('liq', 'Forced liquidations', GLOSSARY.margin_policy, String(m.forced_liquidations))}
          {cell('neg', 'Negative balance events', GLOSSARY.negative_balance, String(m.negative_balance_events), undefined, false, Number(m.negative_balance_events) ? 'loss' : '')}
        </div>
      </div>
      <div className="blk">
        <div className="blk-h"><h2>Utilisation by session</h2><span className="lbl">peak % of balance in use</span></div>
        <LinePlot points={daily.map((x) => ({ d: x.date, v: isFinite(x.peak_util_pct) ? x.peak_util_pct : null }))} area="neutral" zero fmt={(v) => `${v.toFixed(1)}%`} axisFmt={(v) => `${v.toFixed(0)}%`} height={220} label="Peak capital utilisation per session, in percent." />
      </div>
    </div>
  );
}

type ChartId = 'pnl' | 'equity' | 'dd' | 'daily' | 'monthly' | 'dist' | 'dur' | 'rsharpe' | 'rvol' | 'util';
const CHARTS: { id: ChartId; label: string; hint: string; ledger?: boolean; trades?: boolean }[] = [
  { id: 'pnl', label: 'Cumulative P&L', hint: 'net, after charges' },
  { id: 'equity', label: 'Equity', hint: 'balance + intraday low', ledger: true },
  { id: 'dd', label: 'Drawdown', hint: 'below the last peak', ledger: true },
  { id: 'daily', label: 'Daily P&L', hint: 'per session' },
  { id: 'monthly', label: 'Monthly returns', hint: 'net realised', ledger: true },
  { id: 'dist', label: 'P&L distribution', hint: 'per leg or per day' },
  { id: 'dur', label: 'Trade duration', hint: 'minutes held', trades: true },
  { id: 'rsharpe', label: 'Rolling Sharpe', hint: 'trailing window', ledger: true },
  { id: 'rvol', label: 'Rolling volatility', hint: 'annualised', ledger: true },
  { id: 'util', label: 'Capital utilisation', hint: 'peak per session', ledger: true },
];

function ChartsPanel({ r, trades }: { r: RunResult; trades: LedgerRow[] | null }) {
  const [id, setId] = useState<ChartId>('pnl');
  const [win, setWin] = useState(20);
  const [per, setPer] = useState<'leg' | 'day'>('leg');
  const acct = r.account, daily = acct?.daily ?? [];
  const cfg = acct ? { initial_capital: acct.config.initial_capital, risk_free_pct: (acct.config as { risk_free_pct?: number }).risk_free_pct, periods_per_year: (acct.config as { periods_per_year?: number }).periods_per_year } : null;
  const money = (v: number) => inr(v, { sign: true });
  const avail = (c: (typeof CHARTS)[number]) => (c.ledger && !acct ? 'Needs the account ledger (not available for the four-leg model).' : c.trades && !trades?.length ? 'Needs a tradebook with closed positions.' : null);
  const cur = CHARTS.find((c) => c.id === id)!;
  let body: ReactNode = null, cap = '';
  const why = avail(cur);
  if (why) body = <div className="plot-empty">{why}</div>;
  else if (id === 'pnl') { cap = 'Ending balance minus starting capital after each session, from the ledger.'; body = <LinePlot points={r.curve.map((p) => ({ d: p.d, v: p.v }))} fmt={money} label="Cumulative net P&L by session." />; }
  else if (id === 'equity') {
    cap = 'Closing balance (solid) and the lowest intraday equity of each session (dashed): balance plus open positions marked at candle closes.';
    body = <LinePlot points={daily.map((d) => ({ d: d.date, v: d.closing_balance }))} second={daily.map((d) => ({ d: d.date, v: d.intraday_low_equity }))} secondLabel="intraday low" area="none" zero={false} fmt={(v) => inr(v)} label="Closing balance and intraday low equity by session." />;
  } else if (id === 'dd') { cap = 'How far the closing balance sits below its previous peak, each session.'; body = <LinePlot points={daily.map((d) => ({ d: d.date, v: -d.drawdown }))} fmt={(v) => (v === 0 ? '₹0' : inr(v))} label="Drawdown by session." />; }
  else if (id === 'daily') {
    const bars = acct ? daily.map((d) => ({ k: d.date, v: d.net_realised })) : r.curve.map((p) => ({ k: p.d, v: p.p }));
    cap = acct ? 'Net realised P&L of each session after charges. Sessions without a trade are zero.' : 'Net P&L of each period.';
    body = <BarPlot bars={bars} fmt={money} keyFmt={shortDate} label="Net P&L by session." />;
  } else if (id === 'monthly') {
    const m = Object.entries(acct!.report.returns.monthly);
    cap = 'Net realised P&L by calendar month, from the report.';
    body = <BarPlot bars={m.map(([k, v]) => ({ k, v }))} fmt={money} keyFmt={(k) => { const [y, mo] = k.split('-'); return `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(mo) - 1] ?? mo} ${y.slice(2)}`; }} label="Net P&L by month." />;
  } else if (id === 'dist') {
    const vals = per === 'leg' && trades?.length ? trades.map((t) => Number(t.net_pnl)).filter(isFinite) : (acct ? daily.filter((d) => d.trades > 0).map((d) => d.net_realised) : r.curve.filter((p) => p.p !== 0).map((p) => p.p));
    cap = per === 'leg' ? 'Net P&L of every closed leg, after its own charges.' : 'Net P&L of every session with a trade.';
    body = <><div className="chart-pick" role="group" aria-label="Distribution of"><button type="button" className="qbtn" aria-pressed={per === 'leg'} disabled={!trades?.length} onClick={() => setPer('leg')}>Per leg</button><button type="button" className="qbtn" aria-pressed={per === 'day'} onClick={() => setPer('day')}>Per traded {r.unit === 'month' ? 'month' : 'day'}</button></div>
      <Histogram values={vals} fmt={compactInr} unit={per === 'leg' ? 'legs' : 'periods'} label="Distribution of net P&L." /></>;
  } else if (id === 'dur') {
    const mins = (trades ?? []).map(holdMinutes).filter((v): v is number => v != null);
    cap = 'Minutes from entry fill to exit fill for each closed leg (from the tradebook times).';
    body = <Histogram values={mins} fmt={(v) => `${Math.round(v)}m`} unit="legs" signed={false} label="Distribution of minutes held." />;
  } else if (id === 'rsharpe' || id === 'rvol') {
    const pts = id === 'rsharpe' ? rollingSharpe(daily, cfg!, win) : rollingVol(daily, cfg!, win);
    cap = `${id === 'rsharpe' ? GLOSSARY.rolling_sharpe : GLOSSARY.rolling_vol} Window: ${win} sessions.`;
    const enough = daily.length >= win;
    body = <><div className="chart-pick" role="group" aria-label="Window">{[20, 60, 120].map((w) => <button key={w} type="button" className="qbtn" aria-pressed={win === w} onClick={() => setWin(w)}>{w} sessions</button>)}</div>
      {enough ? <LinePlot points={pts} area="none" fmt={(v) => (id === 'rsharpe' ? v.toFixed(2) : `${v.toFixed(1)}%`)} axisFmt={(v) => (id === 'rsharpe' ? v.toFixed(1) : `${v.toFixed(0)}%`)} label={`${cur.label} over a ${win}-session window.`} />
        : <div className="plot-empty">This run has {daily.length} session{daily.length === 1 ? '' : 's'}; a {win}-session window needs at least {win}. Pick a longer period or a shorter window.</div>}</>;
  } else if (id === 'util') { cap = GLOSSARY.utilisation; body = <LinePlot points={daily.map((d) => ({ d: d.date, v: isFinite(d.peak_util_pct) ? d.peak_util_pct : null }))} area="neutral" fmt={(v) => `${v.toFixed(1)}%`} axisFmt={(v) => `${v.toFixed(0)}%`} label="Peak capital utilisation per session." />; }
  return (
    <div className="charts panel" role="tabpanel" id="panel-charts" aria-labelledby="tab-charts">
      <div className="chart-menu" role="group" aria-label="Chart">
        {CHARTS.map((c) => <button key={c.id} type="button" aria-pressed={id === c.id} onClick={() => setId(c.id)} title={avail(c) ?? undefined} style={avail(c) ? { opacity: 0.5 } : undefined}>{c.label}<small>{c.hint}</small></button>)}
      </div>
      <div className="blk">
        <div className="blk-h"><h2>{cur.label}</h2></div>
        {body}
        {cap && <p className="chart-cap">{cap}</p>}
      </div>
    </div>
  );
}

function SessionsPanel({ r, range, onReplay }: { r: RunResult; range: DateRange | null; onReplay: (d: string) => void }) {
  const [show, setShow] = useState<'all' | 'traded' | 'other'>('all');
  const out = outcomesOf(r);
  const data = new Map(range?.days.map((d) => [d.date, d]) ?? []);
  const counts = out.reduce<Record<string, number>>((a, d) => { a[d.status] = (a[d.status] ?? 0) + 1; return a; }, {});
  const rows = out.filter((d) => show === 'all' || (show === 'traded' ? d.status === 'traded' : d.status !== 'traded'));
  if (!out.length) return <div className="plot-empty panel" role="tabpanel" id="panel-sessions">This strategy does not report per-session outcomes.</div>;
  return (
    <div className="panel blk" role="tabpanel" id="panel-sessions" aria-labelledby="tab-sessions">
      <div className="tb-sum">
        <span><b className="num">{out.length}</b> session{out.length === 1 ? '' : 's'} ran{range ? <> of <b className="num">{range.counts.runnable}</b> available in the selected period</> : null}: {Object.entries(counts).map(([k, v]) => `${v} ${outcomeLabel(k).toLowerCase()}`).join(', ')}.</span>
        <span className="chart-pick" role="group" aria-label="Show">
          {(['all', 'traded', 'other'] as const).map((s) => <button key={s} type="button" className="qbtn" aria-pressed={show === s} onClick={() => setShow(s)}>{s === 'all' ? 'All' : s === 'traded' ? 'Traded' : 'Not traded'}</button>)}
        </span>
      </div>
      {range && out.length !== range.counts.runnable && <p className="sec-err">The run covered {out.length} sessions but the selected period has {range.counts.runnable} available. Settings changed since this run; run again.</p>}
      <div className="tscroll" tabIndex={0} aria-label="Sessions table, scrolls sideways">
        <table className="tbl">
          <thead><tr><th>Date</th>{range && <th>Data</th>}<th>Outcome</th><th>Why</th><th className="r">Legs</th><th className="r">Net</th><th aria-label="Replay" /></tr></thead>
          <tbody>
            {rows.map((d) => {
              const e = data.get(d.date);
              return (
                <tr key={d.date} data-bad={d.status === 'rejected' ? '1' : undefined}>
                  <td>{d.date}</td>
                  {range && <td>{e ? (e.state === 'validated' ? 'complete' : e.state) : '—'}{e?.state === 'partial' && e.reason ? <span className="m-s"> · {e.reason}</span> : null}</td>}
                  <td>{outcomeLabel(d.status)}</td>
                  <td className="t">{d.reason ?? ''}</td>
                  <td className="r">{d.opened}</td>
                  <td className={`r ${tone(d.net)}`}>{d.status === 'traded' || d.net ? inr2(d.net, { sign: true }) : '—'}</td>
                  <td>{d.status === 'traded' && <button type="button" className="qlink" onClick={() => onReplay(d.date)}>Replay</button>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function DiagnosticsPanel({ r, range, real, go }: { r: RunResult; range: DateRange | null; real: boolean; go: (t: TabId) => void }) {
  const rep = r.account?.report;
  const checks: { l: 'ok' | 'warn' | 'info'; t: string }[] = [];
  if (real && r.data) {
    checks.push({ l: 'info', t: `Source: Dhan 1-minute NIFTY option and index candles, ${shortDate(r.data.from)} to ${shortDate(r.data.to)} (${r.data.days} sessions).` });
    if (range) {
      const same = r.data.range_key && r.data.range_key === range.key;
      checks.push(same ? { l: 'ok', t: `The run used exactly the ${range.counts.runnable} sessions the date range lists (range key ${range.key}).` }
        : { l: 'warn', t: 'The date range has changed since this run, so these results describe a different set of days. Run again.' });
      if (range.counts.partial) checks.push({ l: 'warn', t: `${range.counts.partial} partial session${range.counts.partial === 1 ? '' : 's'} ran with missing bars; gaps stay gaps.` });
      if (range.counts.missing) checks.push({ l: 'warn', t: `${range.counts.missing} weekday${range.counts.missing === 1 ? ' is' : 's are'} not stored and did not run.` });
    }
    checks.push({ l: 'warn', t: `Lot size ${r.data.lot_sizes.join('/')}: ${r.data.lot_source}.` });
    checks.push({ l: 'warn', t: `Expiry dates: ${r.data.expiry_source}.` });
    checks.push({ l: 'warn', t: 'No bid/ask history: fills are candle prices plus slippage, so they are optimistic.' });
    if (r.data.flags.includes('index_from_spot')) checks.push({ l: 'warn', t: 'Some days have no index candles; their opening range uses Dhan’s spot (close only).' });
  } else checks.push({ l: 'info', t: 'Synthetic model, dates in 2099. These figures show how the rule reacts to a setting; they are not evidence about a real market.' });
  if (rep) {
    if (rep.range.excluded_days.length) checks.push({ l: 'warn', t: `${rep.range.excluded_days.length} session${rep.range.excluded_days.length === 1 ? ' was' : 's were'} excluded for data problems: ${rep.range.excluded_days.slice(0, 3).map((d) => `${d.date} (${d.reason})`).join('; ')}${rep.range.excluded_days.length > 3 ? '…' : ''}` });
    for (const w of rep.warnings) checks.push({ l: 'warn', t: w });
    if (!rep.cost_rates.some((c) => !Object.values(c.verified).every(Boolean))) checks.push({ l: 'ok', t: 'Every statutory rate used is marked verified.' });
    checks.push(rep.reconciliation.ok ? { l: 'ok', t: `All ${rep.reconciliation.checks.length} reconciliation identities hold: balance, tradebook, ledger and daily totals agree.` } : { l: 'warn', t: 'Reconciliation FAILED: do not rely on these figures. See the Ledger tab.' });
  }
  if (r.traded < 30 && !rep) checks.push({ l: 'warn', t: `${r.traded} traded ${r.unit === 'day' ? 'days' : r.unit + 's'}: too few for stable ratios.` });
  const slots: [string, string, string][] = [
    ['Regime analysis', 'With this run', 'Results split by volatility and trend regime, with win rate, P&L and drawdown per regime.'],
    ['Robustness score', 'With this run', 'A transparent score from its parts: sample size, out-of-sample result, stability, costs and data quality.'],
    ['Monte Carlo', 'With this run', 'Reshuffled trade sequences: the spread of drawdowns and outcomes the same trades could produce.'],
    ['Parameter sensitivity', 'On request', 'The robustness check reruns the settings one step either side of each value: plateaus versus single peaks.'],
    ['Optimisation comparison', 'On request', 'The best tested configuration against the one shown here. It is never applied unless you press Load.'],
    ['Out-of-sample results', 'On request', 'Train, validate and test periods, and walk-forward windows, from an optimisation study.'],
  ];
  return (
    <div className="panel" role="tabpanel" id="panel-diagnostics" aria-labelledby="tab-diagnostics">
      <div className="blk">
        <div className="blk-h"><h2>Data quality and run checks</h2></div>
        <ul className="dq">{checks.map((c) => <li key={c.t} data-l={c.l}>{c.t}</li>)}</ul>
      </div>
      <div className="blk">
        <div className="blk-h"><h2>Strategy diagnostics</h2><button type="button" className="qbtn" onClick={() => go('research')}>Open Research</button></div>
        <p className="chart-cap">Computed in the Research tab from this run’s ledger, for the straddle and the opening range breakout. “On request” items run only when you press the button there, and none of them changes your settings.</p>
        <div className="slots">{slots.map(([h, st, p]) => <div className="slot" key={h}><span className="state">{st}</span><h3>{h}</h3><p>{p}</p></div>)}</div>
      </div>
    </div>
  );
}

function LedgerPanel({ r, lab, stamp }: { r: RunResult; lab: LabApi; stamp: string }) {
  const [err, setErr] = useState<string | null>(null);
  const [part, setPart] = useState<'summary' | 'capital' | 'performance' | 'risk'>('summary');
  const rep = r.account?.report as Report | undefined;
  if (!rep) return <div className="plot-empty panel" role="tabpanel" id="panel-ledger">The ledger, account report and CSV exports cover the two intraday NIFTY strategies. The four-leg model keeps its own synthetic accounting.</div>;
  const rev = `${rep.generated.run_hash}`;
  const exp = async (kind: ExportKind, file: string) => {
    setErr(null);
    const csv = await lab.exportCsv(kind);
    if (csv == null) { setErr('Nothing to export for this run.'); return; }
    downloadText(file, csv);
  };
  return (
    <div className="panel" role="tabpanel" id="panel-ledger" aria-labelledby="tab-ledger">
      <div className="blk">
        <div className="blk-h"><h2>Export</h2><span className="lbl">CSV, from the same ledger as this page</span></div>
        <div className="run-actions">
          <button type="button" className="qbtn" onClick={() => exp('tradebook', `tradebook-${stamp}.csv`)}>Tradebook</button>
          <button type="button" className="qbtn" onClick={() => exp('ledger', `ledger-${stamp}.csv`)}>Ledger (every fill)</button>
          <button type="button" className="qbtn" onClick={() => exp('daily', `daily-ledger-${stamp}.csv`)}>Daily ledger</button>
          <button type="button" className="qbtn" onClick={() => exp('performance', `performance-${stamp}.csv`)}>Performance report</button>
          {err && <span className="sec-err" role="alert">{err}</span>}
        </div>
      </div>
      <div className="blk">
        <div className="blk-h"><h2>Account report</h2>
          <span className="chart-pick" role="group" aria-label="Report section">
            {(['summary', 'capital', 'performance', 'risk'] as const).map((k) => <button key={k} type="button" className="qbtn" aria-pressed={part === k} onClick={() => setPart(k)}>{k[0].toUpperCase() + k.slice(1)}</button>)}
          </span>
        </div>
        <Warnings rep={rep} />
        {part === 'summary' && <Summary rep={rep} />}
        {part === 'capital' && <CapitalTable rep={rep} />}
        {part === 'performance' && <Performance rep={rep} />}
        {part === 'risk' && <Risk rep={rep} />}
      </div>
      <div className="blk">
        <div className="blk-h"><h2>Ledger</h2></div>
        <LedgerTab rep={rep} lab={lab} rev={rev} />
      </div>
      <div className="blk" hidden><CostTable rep={rep} /></div>
    </div>
  );
}

const TABS: { id: TabId; label: string }[] = [
  { id: 'overview', label: 'Overview' }, { id: 'capital', label: 'Capital & margin' }, { id: 'charts', label: 'Charts' }, { id: 'trades', label: 'Trades' },
  { id: 'sessions', label: 'Sessions' }, { id: 'replay', label: 'Replay' }, { id: 'research', label: 'Research' }, { id: 'diagnostics', label: 'Diagnostics' }, { id: 'ledger', label: 'Ledger & export' },
];

export function ResultTabs({ r, lab, range, real, slip, tab, setTab, research }: {
  r: RunResult; lab: LabApi; range: DateRange | null; real: boolean; slip: number | undefined; tab: TabId; setTab: (t: TabId) => void;
  /** The research panel. It mounts the first time its tab opens and then stays mounted, so a running study survives a tab change. */
  research?: React.ReactNode;
}) {
  const [researchSeen, setResearchSeen] = useState(false);
  useEffect(() => { if (tab === 'research') setResearchSeen(true); }, [tab]);
  const rev = r.account ? `${r.account.report.generated.run_hash}` : `${r.strategy}-${r.net}-${r.curve.length}`;
  const [trades, setTrades] = useState<LedgerRow[] | null>(null);
  const [fills, setFills] = useState<LedgerRow[]>([]);
  const [replayDate, setReplayDate] = useState<string | undefined>(undefined);
  const { inspect } = lab;
  useEffect(() => {
    let live = true;
    setTrades(null); setFills([]);
    if (!r.account) return;
    inspect('tradebook', 0, 1e6).then((p) => live && setTrades(p?.rows ?? []));
    inspect('ledger', 0, 1e7).then((p) => live && setFills(p?.rows ?? []));
    return () => { live = false; };
  }, [rev, inspect, r.account]);
  const replayable = r.strategy !== 'fourleg' && r.curve.length > 0;
  const tabs = TABS.filter((t) => (t.id !== 'replay' || replayable) && (t.id !== 'research' || !!research));
  if (!tabs.some((t) => t.id === tab)) tab = 'overview';
  const counts: Partial<Record<TabId, number>> = { trades: trades?.length, sessions: r.days?.length };
  const m = r.account?.report.margin;
  const alarms = m ? [
    Number(m.rejected_trades) ? `${m.rejected_trades} trade${Number(m.rejected_trades) === 1 ? ' was' : 's were'} rejected for insufficient margin and ${Number(m.rejected_trades) === 1 ? 'is' : 'are'} not in the P&L.` : null,
    Number(m.forced_liquidations) ? `${m.forced_liquidations} position${Number(m.forced_liquidations) === 1 ? ' was' : 's were'} force-closed for margin at an approximate price.` : null,
    Number(m.negative_balance_events) ? `The balance went below zero ${m.negative_balance_events} time${Number(m.negative_balance_events) === 1 ? '' : 's'}.` : null,
    r.account && !r.account.report.reconciliation.ok ? 'Reconciliation failed: do not rely on these figures.' : null,
  ].filter((x): x is string => !!x) : [];
  const go = (t: TabId) => setTab(t);
  const replay = (d: string) => { setReplayDate(d); setTab('replay'); };
  const stamp = r.account ? `${r.strategy}-${r.account.report.range.from ?? 'x'}_${r.account.report.range.to ?? 'x'}-${(r.account.report.generated.run_hash ?? '').slice(0, 6)}` : r.strategy;
  const onKey = (e: React.KeyboardEvent) => {
    const i = tabs.findIndex((t) => t.id === tab);
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length].id;
      setTab(next); requestAnimationFrame(() => document.getElementById(`tab-${next}`)?.focus());
    }
  };
  return (
    <>
      {alarms.length > 0 && (
        <div className="stale" role="alert" data-kind="alarm">
          <span>{alarms.join(' ')}</span>
          <button type="button" className="qlink" onClick={() => setTab('capital')}>See capital &amp; margin</button>
        </div>
      )}
      <div className="tabs2" role="tablist" aria-label="Result views" onKeyDown={onKey}>
        {tabs.map((t) => (
          <button key={t.id} id={`tab-${t.id}`} type="button" role="tab" aria-selected={tab === t.id} aria-controls={`panel-${t.id}`} tabIndex={tab === t.id ? 0 : -1} onClick={() => setTab(t.id)}>
            {t.label}{counts[t.id] != null && <span className="cnt">{counts[t.id]}</span>}
          </button>
        ))}
      </div>
      {tab === 'overview' && <Overview r={r} trades={trades} real={real} slip={slip} go={go} />}
      {tab === 'capital' && <CapitalPanel r={r} />}
      {tab === 'charts' && <ChartsPanel r={r} trades={trades} />}
      {tab === 'trades' && (
        <div className="panel" role="tabpanel" id="panel-trades" aria-labelledby="tab-trades">
          {!r.account ? <div className="plot-empty">The four-leg model has no per-leg tradebook in the Lab.</div>
            : trades == null ? <div className="skel" aria-label="Loading trades"><i /><i /><i /></div>
              : <Tradebook trades={trades} fills={fills} onReplay={replayable ? replay : undefined} />}
        </div>
      )}
      {tab === 'sessions' && <SessionsPanel r={r} range={real ? range : null} onReplay={replay} />}
      {tab === 'replay' && replayable && (
        <div className="panel" role="tabpanel" id="panel-replay" aria-labelledby="tab-replay">
          <ReplayPanel key={`${rev}-${replayDate ?? ''}`} r={r} load={lab.replay} initialDate={replayDate} bare />
        </div>
      )}
      {research != null && (researchSeen || tab === 'research') && (
        <div className="panel" role="tabpanel" id="panel-research" aria-labelledby="tab-research" hidden={tab !== 'research'}>{research}</div>
      )}
      {tab === 'diagnostics' && <DiagnosticsPanel r={r} range={range} real={real} go={go} />}
      {tab === 'ledger' && <LedgerPanel r={r} lab={lab} stamp={stamp} />}
    </>
  );
}
