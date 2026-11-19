'use client';
/** Searchable, filterable tradebook. Every row is one closed leg from the ledger; expanding it shows that leg's fills in order. */
import { Fragment, useMemo, useState } from 'react';
import { exitLabel, inr2 } from '@/lib/format';
import { EMPTY_FILTER, activeCount, distinct, filterTrades, holdMinutes, type TradeFilter } from '@/lib/tradeFilter';
import type { LedgerRow } from '@/lib/types';
import { Icon } from './kit';

const PAGE = 50;
const money = (v: unknown, sign = false) => inr2(typeof v === 'number' ? v : null, { sign });
const tone = (v: unknown) => (typeof v === 'number' ? (v > 0 ? 'gain' : v < 0 ? 'loss' : '') : '');

export function Tradebook({ trades, fills, onReplay }: { trades: LedgerRow[]; fills: LedgerRow[]; onReplay?: (date: string) => void }) {
  const [f, setF] = useState<TradeFilter>(EMPTY_FILTER);
  const [page, setPage] = useState(0);
  const [open, setOpen] = useState<number | null>(null);
  const [more, setMore] = useState(false);
  const set = (k: keyof TradeFilter, v: string) => { setF((x) => ({ ...x, [k]: v })); setPage(0); setOpen(null); };
  const rows = useMemo(() => filterTrades(trades, f), [trades, f]);
  const fillsBy = useMemo(() => {
    const m = new Map<string, LedgerRow[]>();
    for (const x of fills) { const k = String(x.seq); m.set(k, [x]); }
    return m;
  }, [fills]);
  const opts = useMemo(() => ({ symbol: distinct(trades, 'symbol'), expiry: distinct(trades, 'expiry'), leg: [...new Set(trades.map((t) => String(t.kind || t.leg)))].sort(), exit: distinct(trades, 'exit_reason') }), [trades]);
  const net = rows.reduce((a, r) => a + (typeof r.net_pnl === 'number' ? r.net_pnl : 0), 0);
  const pages = Math.max(1, Math.ceil(rows.length / PAGE));
  const shown = rows.slice(page * PAGE, page * PAGE + PAGE);
  const dates = distinct(trades, 'date');

  if (!trades.length) return <div className="plot-empty">No closed positions in this run, so the tradebook is empty.</div>;

  const sel = (k: keyof TradeFilter, label: string, values: string[], fmt: (s: string) => string = (s) => s) => (
    <label className="f"><span className="f-label">{label}</span>
      <select className="in" value={f[k]} onChange={(e) => set(k, e.target.value)}>
        <option value="">All</option>
        {values.map((v) => <option key={v} value={v}>{fmt(v)}</option>)}
      </select>
    </label>
  );

  return (
    <div className="blk">
      <div className="tb-filters" role="search" aria-label="Filter trades">
        <label className="f"><span className="f-label">Search</span><input className="in" type="search" placeholder="Strike, date, exit…" value={f.q} onChange={(e) => set('q', e.target.value)} /></label>
        {sel('outcome', 'Result', ['win', 'loss'], (s) => (s === 'win' ? 'Winning' : 'Losing'))}
        {sel('exit', 'Exit reason', opts.exit, exitLabel)}
        {sel('direction', 'Buy / sell', ['LONG', 'SHORT'], (s) => (s === 'LONG' ? 'Bought (long)' : 'Sold (short)'))}
        {more && <>
          {sel('side', 'Call / put', ['CE', 'PE'])}
          {sel('leg', 'Strategy leg', opts.leg)}
          {sel('symbol', 'Instrument', opts.symbol)}
          {sel('expiry', 'Expiry', opts.expiry)}
          {sel('from', 'From date', dates)}
          {sel('to', 'To date', dates)}
          <div className="f"><span className="f-label">Net P&amp;L, ₹</span>
            <div className="pl">
              <input className="in" inputMode="numeric" aria-label="Minimum net P&L" placeholder="min" value={f.min} onChange={(e) => set('min', e.target.value)} />
              <input className="in" inputMode="numeric" aria-label="Maximum net P&L" placeholder="max" value={f.max} onChange={(e) => set('max', e.target.value)} />
            </div>
          </div>
        </>}
      </div>
      <div className="tb-sum">
        <span>
          Showing <b className="num">{rows.length}</b> of <span className="num">{trades.length}</span> closed legs · net of these <b className={`num ${tone(net)}`}>{money(net, true)}</b>
        </span>
        <span className="run-actions">
          <button type="button" className="qlink" onClick={() => setMore((m) => !m)} aria-expanded={more}>{more ? 'Fewer filters' : 'More filters'}</button>
          {activeCount(f) > 0 && <button type="button" className="qlink" onClick={() => { setF(EMPTY_FILTER); setPage(0); }}>Clear {activeCount(f)} filter{activeCount(f) === 1 ? '' : 's'}</button>}
        </span>
      </div>
      <div className="tscroll" tabIndex={0} aria-label="Tradebook table, scrolls sideways">
        <table className="tbl">
          <thead><tr>
            <th className="x" aria-label="Expand" /><th>#</th><th>Date</th><th>Leg</th><th className="r opt">Qty</th><th className="opt">In</th><th className="opt">Out</th><th className="r opt">Hold</th><th>Exit</th><th className="r">Net</th><th className="r opt">Gross</th><th className="r opt">Charges</th>
          </tr></thead>
          <tbody>
            {shown.map((r) => {
              const n = Number(r.trade_no), isOpen = open === n, hold = holdMinutes(r);
              const seqs = String(r.fills ?? '').split(/\s+/).filter(Boolean);
              const life = seqs.flatMap((s) => fillsBy.get(s) ?? []);
              return (
                <Fragment key={n}>
                  <tr className="click" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : n)}>
                    <td className="x"><button type="button" className="rowbtn" aria-label={`${isOpen ? 'Hide' : 'Show'} the execution record of trade ${n}`} aria-expanded={isOpen} onClick={(e) => { e.stopPropagation(); setOpen(isOpen ? null : n); }}><Icon.right /></button></td>
                    <td>{n}</td><td>{String(r.date)}</td>
                    <td>{r.direction === 'SHORT' ? 'Sell' : 'Buy'} {String(r.side)} {String(r.strike)}{r.kind ? <span className="m-s"> · {String(r.kind)}</span> : null}</td>
                    <td className="r opt">{String(r.qty)}</td>
                    <td className="opt">{String(r.entry_time)} @ {Number(r.entry_px).toFixed(2)}</td>
                    <td className="opt">{r.exit_time ? `${r.exit_time} @ ${Number(r.exit_px).toFixed(2)}` : 'open'}</td>
                    <td className="r opt">{hold == null ? '—' : `${hold}m`}</td>
                    <td>{exitLabel(String(r.exit_reason || ''))}</td>
                    <td className={`r ${tone(r.net_pnl)}`}><b>{money(r.net_pnl, true)}</b></td>
                    <td className={`r opt ${tone(r.gross_pnl)}`}>{money(r.gross_pnl, true)}</td>
                    <td className="r opt">{money(r.charges)}</td>
                  </tr>
                  {isOpen && (
                    <tr><td colSpan={12} className="life">
                      <div className="life-grid">
                        <div className="blk" style={{ gap: 8 }}>
                          <span className="lbl">Execution lifecycle</span>
                          <p className="m-s">{r.direction === 'SHORT' ? 'Sold' : 'Bought'} {String(r.qty)} × {String(r.side)} {String(r.strike)}, expiry {String(r.expiry)}{r.entry_reason ? `, ${String(r.entry_reason)}` : ''}. Balance before {money(r.balance_before)}; available margin before {money(r.available_margin_before)}.</p>
                          <ol>
                            
                            {life.map((x) => (
                              <li key={String(x.seq)} data-k={x.event === 'OPEN' ? 'fill' : 'exit'}>
                                <span className="mono">{String(x.time)}</span> Fill #{String(x.seq)} · {String(x.event).toLowerCase()} {String(x.action).toLowerCase()} {String(x.qty)} at {Number(x.px).toFixed(2)} · charges {money(x.charges)}
                                {typeof x.margin_released === 'number' && x.margin_released > 0 ? ` · margin released ${money(x.margin_released)}` : ''}
                                {typeof x.margin_blocked === 'number' && x.margin_blocked > 0 ? ` · margin blocked ${money(x.margin_blocked)}` : ''}
                                {' '}· balance after {money(x.balance_after)}, available {money(x.available_margin_after)}{x.intrabar ? ' · intrabar' : ''}{x.status && x.status !== 'executed' ? ` · ${String(x.status)}` : ''}
                              </li>
                            ))}
                            <li data-k="exit"><span className="mono">{String(r.exit_time ?? '—')}</span> Why it closed: {exitLabel(String(r.exit_reason || ''))} at {r.exit_px != null ? Number(r.exit_px).toFixed(2) : '—'}{r.intrabar_exit ? '; exit decided inside a candle (order of events within a minute is unknown)' : ''}. Net {money(r.net_pnl, true)}.</li>
                          </ol>
                          {onReplay && <button type="button" className="qlink" style={{ justifySelf: 'start' }} onClick={() => onReplay(String(r.date))}>Replay {String(r.date)} minute by minute</button>}
                        </div>
                        <dl>
                          <dt>Gross</dt><dd>{money(r.gross_pnl, true)}</dd>
                          <dt>Brokerage</dt><dd>{money(r.brokerage)}</dd><dt>STT</dt><dd>{money(r.stt)}</dd><dt>Exchange</dt><dd>{money(r.exchange)}</dd>
                          <dt>GST</dt><dd>{money(r.gst)}</dd><dt>SEBI</dt><dd>{money(r.sebi)}</dd><dt>Stamp</dt><dd>{money(r.stamp)}</dd>
                          <dt><b>Charges</b></dt><dd><b>{money(r.charges)}</b></dd><dt><b>Net</b></dt><dd className={tone(r.net_pnl)}><b>{money(r.net_pnl, true)}</b></dd>
                          <dt>Premium</dt><dd>{money(r.premium)}</dd><dt>Notional</dt><dd>{money(r.notional)}</dd>
                          <dt>Cost schedule</dt><dd>{String(r.cost_schedule)}{r.cost_rates_verified ? '' : ' (unverified)'}</dd>
                          {r.flags ? <><dt>Data flags</dt><dd>{String(r.flags)}</dd></> : null}
                          {r.audit ? <p className="audit">{String(r.audit)}</p> : null}
                        </dl>
                      </div>
                    </td></tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      {pages > 1 && (
        <div className="pager">
          <button type="button" className="qbtn" disabled={page === 0} onClick={() => { setPage(page - 1); setOpen(null); }}>Previous</button>
          <span className="num">{page * PAGE + 1}–{Math.min(rows.length, page * PAGE + PAGE)} of {rows.length}</span>
          <button type="button" className="qbtn" disabled={page >= pages - 1} onClick={() => { setPage(page + 1); setOpen(null); }}>Next</button>
        </div>
      )}
    </div>
  );
}
