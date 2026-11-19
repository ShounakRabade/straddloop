'use client';
import { Fragment, useCallback, useEffect, useState } from 'react';
import { hard } from '@/components/ui';
import { inr2, num2, pct2 } from '@/lib/format';
import type { ExportKind, LedgerRow, Report } from '@/lib/types';
import type { Page } from '@/lib/useLab';
import type { RunResult } from '@/lib/types';

type Lab = {
  exportCsv: (k: ExportKind) => Promise<string | null>;
  inspect: (k: 'tradebook' | 'ledger' | 'daily', offset: number, limit: number) => Promise<Page | null>;
};
type Tab = 'summary' | 'capital' | 'performance' | 'trades' | 'risk' | 'ledger';
const TABS: [Tab, string][] = [['summary', 'Summary'], ['capital', 'Capital & margin'], ['performance', 'Performance'], ['trades', 'Trades'], ['risk', 'Risk'], ['ledger', 'Ledger']];
const PAGE = 25;

type Row = [label: string, value: string, note?: string, est?: boolean];
function Rows({ rows }: { rows: Row[] }) {
  return (
    <table className="ptable rep">
      <tbody>
        {rows.map(([k, v, note, est]) => (
          <tr key={k}>
            <th scope="row">{k}{est && <span className="est" title="Estimated by a model, not an actual historical figure"> est.</span>}</th>
            <td className="num">{v}</td>
            <td className="rep-note">{note ?? ''}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
const n = (v: unknown) => (typeof v === 'number' ? v : null);
const money = (v: unknown, sign = false) => inr2(n(v), { sign });

function downloadText(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function Warnings({ rep }: { rep: Report }) {
  return (
    <ul className="rep-warn" aria-label="Limits of this run">
      {rep.warnings.map((w) => <li key={w}>{w}</li>)}
    </ul>
  );
}

function Summary({ rep }: { rep: Report }) {
  const c = rep.capital, p = rep.pnl, rt = rep.returns, pf = rep.performance, rk = rep.risk;
  const ch = p.charges as Record<string, number>;
  return (
    <div className="stack" style={{ ['--gap' as string]: '14px' }}>
      <Rows rows={[
        ['Period', `${rep.range.from ?? '—'} to ${rep.range.to ?? '—'}`, `${rep.range.sessions} sessions, ${rep.range.traded_days} with a trade${rep.range.excluded_days.length ? `, ${rep.range.excluded_days.length} excluded (data)` : ''}`],
        ['Starting capital', money(c.initial_capital)],
        ['Ending balance', money(p.ending_balance), 'starting capital + net realised P&L; nothing is open at the end'],
        ['Net profit after all charges', money(p.net_profit, true), `${pct2(rt.pct_initial)} of starting capital`],
        ['Gross realised P&L', money(p.net_realised_gross, true), `${money(p.gross_realised_profit)} profit, ${money(p.gross_realised_loss)} loss`],
        ['Total charges', money(p.total_charges), `brokerage ${money(ch.brokerage)} · STT ${money(ch.stt)} · exchange ${money(ch.exchange)} · GST ${money(ch.gst)} · SEBI ${money(ch.sebi)} · stamp ${money(ch.stamp)}`],
        ['Closed positions', String(pf.closed_positions), `win rate ${pct2(n(pf.win_rate_pct), 1)} · profit factor ${num2(n(pf.profit_factor))}`],
        ['Peak margin blocked', money(c.peak_margin), `${pct2(c.capital_utilisation_peak_pct, 1)} of capital deployed at the peak`, true],
        ['Maximum drawdown', money(rk.max_drawdown), `${pct2(n(rk.max_drawdown_pct))} of the peak balance`],
        ['Trades rejected for margin', String(rep.margin.rejected_trades), `policy: ${rep.margin.policy_text}`],
      ]} />
      <p className="small muted">Reconciliation: {rep.reconciliation.ok ? 'all ' + rep.reconciliation.checks.length + ' identities hold (balance, tradebook, ledger and daily totals agree).' : 'FAILED, see the Ledger tab. Do not rely on these figures.'}</p>
    </div>
  );
}

function Capital({ rep }: { rep: Report }) {
  const c = rep.capital, m = rep.margin, d = rep.defs;
  const mod = m.model as { span_pct: number; exposure_pct: number; base: string; long_options: string };
  return (
    <div className="stack" style={{ ['--gap' as string]: '14px' }}>
      <h3 className="rep-h">Capital</h3>
      <Rows rows={[
        ['Initial capital', money(c.initial_capital), d.initial_capital],
        ['Investment: premium paid on long options', money(c.total_premium_paid), d.total_premium_paid],
        ['Premium received on short options', money(c.total_premium_received), d.total_premium_received],
        ['Notional exposure, peak', money(c.peak_notional), d.peak_notional],
        ['Cash outflow', money(c.cash_outflow), d.cash_outflow],
        ['Total trade value (turnover)', money(c.total_trade_value), d.total_trade_value],
        ['Capital deployed, peak', money(c.peak_deployed), d.peak_deployed, true],
        ['Capital deployed, average', money(c.avg_deployed), d.avg_deployed, true],
        ['Capital utilisation, peak', pct2(n(c.capital_utilisation_peak_pct), 1), d.capital_utilisation_peak, true],
        ['Capital utilisation, average', pct2(n(c.capital_utilisation_avg_pct), 1), d.capital_utilisation_avg, true],
        ['Remaining available capital', money(c.remaining_capital), 'ending balance; nothing is blocked at the end'],
      ]} />
      <h3 className="rep-h">Margin <span className="est">ESTIMATED</span></h3>
      <p className="small muted">Model: short option margin = {mod.span_pct}% + {mod.exposure_pct}% of {mod.base}; long options: {mod.long_options}. Today’s margin rules are not applied to past dates; this model is the same for every date and is not the actual margin of that day.</p>
      <Rows rows={[
        ['Initial margin (first position)', money(m.initial_margin), '', true],
        ['Peak total margin blocked', money(m.peak_margin), d.peak_margin, true],
        ['Average margin blocked', money(m.avg_margin), d.avg_margin, true],
        ['Lowest available margin', money(m.min_available_margin), 'balance − margin blocked − long premium held, lowest point', true],
        ['Peak margin utilisation', pct2(n(m.peak_utilisation_pct), 1), d.margin_utilisation_peak, true],
        ['Shortfall events', String(m.shortfall_events), `largest shortfall ${money(m.max_shortfall)}`],
        ['Rejected trades', String(m.rejected_trades), `policy: ${m.policy_text}`],
        ['Forced liquidations', String(m.forced_liquidations)],
        ['Utilisation over 100% (fills)', String(m.over_100_pct_events)],
        ['Negative balance events', String(m.negative_balance_events)],
      ]} />
      <p className="small muted">Margin blocked and released for every position is in the Ledger tab (columns margin_required, margin_blocked, margin_released).</p>
    </div>
  );
}

function Performance({ rep }: { rep: Report }) {
  const rt = rep.returns, pf = rep.performance, d = rep.defs;
  const months = Object.entries(rt.monthly), years = Object.entries(rt.annual);
  return (
    <div className="stack" style={{ ['--gap' as string]: '14px' }}>
      <h3 className="rep-h">Returns</h3>
      <Rows rows={[
        ['Absolute return', money(rt.absolute, true), 'ending balance − starting capital'],
        ['Return on initial capital', pct2(rt.pct_initial), d.ret_initial],
        ['Return on peak capital deployed', pct2(rt.pct_peak_deployed), d.ret_peak_deployed, true],
        ['Return on average capital deployed', pct2(rt.pct_avg_deployed), d.ret_avg_deployed, true],
        ['Return on peak margin', pct2(rt.pct_peak_margin), d.ret_peak_margin, true],
        ['CAGR', rt.cagr_pct == null ? 'not shown' : pct2(rt.cagr_pct), rt.cagr_pct == null ? rt.cagr_note ?? '' : d.cagr],
      ]} />
      <h3 className="rep-h">Trade statistics</h3>
      <Rows rows={[
        ['Win rate', pct2(n(pf.win_rate_pct), 1), `${pf.wins} of ${pf.closed_positions}. ${d.win_rate}`],
        ['Loss rate', pct2(n(pf.loss_rate_pct), 1), `${pf.losses} of ${pf.closed_positions}`],
        ['Average winning position', money(pf.avg_win), 'net of its own charges'],
        ['Average losing position', money(pf.avg_loss), 'net of its own charges'],
        ['Profit factor', num2(n(pf.profit_factor)), d.profit_factor],
        ['Risk / reward', num2(n(pf.risk_reward)), d.risk_reward],
        ['Expectancy per position', money(pf.expectancy, true), d.expectancy],
        ['Largest win / loss', `${money(pf.largest_win)} / ${money(pf.largest_loss)}`],
        ['Mean per traded day', money(pf.mean_per_traded_day, true), Array.isArray(pf.ci95_traded_day) ? `95% range ${money(pf.ci95_traded_day[0], true)} to ${money(pf.ci95_traded_day[1], true)}` : ''],
      ]} />
      <h3 className="rep-h">P&amp;L by period (net realised, after charges)</h3>
      <div className="two">
        <Rows rows={years.map(([k, v]) => [k, money(v, true)] as Row)} />
        <div className="rep-scroll" tabIndex={0} aria-label="Monthly P&L"><Rows rows={months.map(([k, v]) => [k, money(v, true)] as Row)} /></div>
      </div>
      <p className="small muted">Daily P&amp;L: Ledger tab (daily view) and the daily CSV.</p>
    </div>
  );
}

function Risk({ rep }: { rep: Report }) {
  const rk = rep.risk, d = rep.defs, p = rep.pnl;
  return (
    <div className="stack" style={{ ['--gap' as string]: '14px' }}>
      <Rows rows={[
        ['Maximum drawdown', money(rk.max_drawdown), `${d.max_dd} ${rk.drawdown_from ? `Peak ${rk.drawdown_from}, trough ${rk.drawdown_to}.` : ''}`],
        ['Maximum drawdown, percent', pct2(n(rk.max_drawdown_pct)), 'of the peak end-of-day balance'],
        ['Maximum drawdown, intraday', money(rk.max_drawdown_intraday), d.max_dd_intraday],
        ['Sharpe ratio', num2(n(rk.sharpe)), `${d.sharpe}${rk.sharpe_note ? ' ' + rk.sharpe_note : ''}`],
        ['Sortino ratio', num2(n(rk.sortino)), d.sortino],
        ['Daily return, standard deviation', pct2(n(rk.daily_return_sd_pct), 3), `over ${rk.sessions_in_ratio} sessions`],
        ['Worst traded day', money(rk.worst_day, true)],
        ['Lowest intraday equity', money(p.trough_intraday_equity), 'balance + unrealised at candle closes'],
        ['Peak intraday unrealised gain', money(p.peak_intraday_unrealised, true)],
      ]} />
    </div>
  );
}

function CostTable({ rep }: { rep: Report }) {
  return (
    <div className="stack" style={{ ['--gap' as string]: '8px' }}>
      <h3 className="rep-h">Statutory rates used (by trade date)</h3>
      <div className="rep-scroll" tabIndex={0} aria-label="Cost rate table">
        <table className="ptable legs">
          <thead><tr><th>Schedule</th><th>From</th><th>STT sell</th><th>Exchange</th><th>SEBI</th><th>Stamp buy</th><th>GST</th><th>Verified</th></tr></thead>
          <tbody>
            {rep.cost_rates.map((r) => (
              <tr key={r.id}>
                <td>{r.id}</td><td>{r.effective_from}</td><td>{r.stt_sell_pct}%</td><td>{r.exch_pct}%</td><td>₹{(r.sebi_pct * 1e5).toFixed(0)}/cr</td><td>{r.stamp_buy_pct}%</td><td>{r.gst_pct}%</td>
                <td>{Object.values(r.verified).every(Boolean) ? 'yes' : `no: ${Object.entries(r.verified).filter(([, v]) => !v).map(([k]) => k.replace(/_pct$/, '')).join(', ')}`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rep.cost_rates.map((r) => <p key={r.id} className="small muted">{r.id}: {r.source}</p>)}
    </div>
  );
}

const TRADE_COLS: [string, string][] = [['trade_no', '#'], ['date', 'Date'], ['side', ''], ['strike', 'Strike'], ['direction', 'Dir'], ['qty', 'Qty'], ['entry_time', 'In'], ['entry_px', 'In px'], ['exit_time', 'Out'], ['exit_px', 'Out px'], ['exit_reason', 'Exit'], ['gross_pnl', 'Gross'], ['charges', 'Charges'], ['net_pnl', 'Net']];
const FILL_COLS: [string, string][] = [['seq', '#'], ['date', 'Date'], ['time', 'Time'], ['event', 'Event'], ['action', ''], ['side', ''], ['strike', 'Strike'], ['qty', 'Qty'], ['px', 'Px'], ['margin_blocked', 'Margin blocked'], ['realised_gross', 'Realised'], ['unrealised_gross', 'Unrealised'], ['charges', 'Charges'], ['balance_after', 'Balance'], ['available_margin_after', 'Available']];
const DAILY_COLS: [string, string][] = [['date', 'Date'], ['status', 'Status'], ['trades', 'Trades'], ['rejected', 'Rej.'], ['gross_realised', 'Gross'], ['charges', 'Charges'], ['net_realised', 'Net'], ['closing_balance', 'Balance'], ['peak_margin', 'Peak margin'], ['peak_util_pct', 'Util %'], ['drawdown', 'Drawdown']];
const MONEY_KEYS = new Set(['gross_pnl', 'charges', 'net_pnl', 'margin_blocked', 'realised_gross', 'unrealised_gross', 'balance_after', 'available_margin_after', 'gross_realised', 'net_realised', 'closing_balance', 'peak_margin', 'drawdown']);
const cell = (k: string, v: unknown) => (typeof v === 'number' ? (MONEY_KEYS.has(k) ? inr2(v) : k === 'peak_util_pct' ? v.toFixed(1) : Number.isInteger(v) ? String(v) : v.toFixed(2)) : v == null ? '' : String(v));

function Rowsets({ lab, kind, rev }: { lab: Lab; kind: 'tradebook' | 'ledger' | 'daily'; rev: string }) {
  const [page, setPage] = useState<Page | null>(null);
  const [offset, setOffset] = useState(0);
  const [open, setOpen] = useState<number | null>(null);
  useEffect(() => { setOffset(0); setOpen(null); }, [kind, rev]);
  const inspect = lab.inspect;  // stable between renders; `lab` itself is a new object every render
  useEffect(() => { let live = true; inspect(kind, offset, PAGE).then((p) => live && setPage(p)); return () => { live = false; }; }, [inspect, kind, offset, rev]);
  const cols = kind === 'tradebook' ? TRADE_COLS : kind === 'ledger' ? FILL_COLS : DAILY_COLS;
  if (!page) return <p className="small muted">Loading rows.</p>;
  if (!page.total) return <p className="small muted">No rows.</p>;
  const last = Math.min(page.total, offset + PAGE);
  return (
    <div className="stack" style={{ ['--gap' as string]: '8px' }}>
      <div className="rep-scroll" tabIndex={0} aria-label={`${kind} rows`}>
        <table className="ptable legs">
          <thead><tr>{cols.map(([k, h]) => <th key={k}>{h || k}</th>)}</tr></thead>
          <tbody>
            {page.rows.map((r: LedgerRow, i) => (
              <Fragment key={`${offset + i}`}>
                <tr className={kind === 'tradebook' ? 'rep-click' : ''} onClick={kind === 'tradebook' ? () => setOpen(open === offset + i ? null : offset + i) : undefined}
                  data-bad={r.status === 'rejected' || r.status === 'forced' ? '1' : undefined}>
                  {cols.map(([k]) => <td key={k} className={typeof r[k] === 'number' ? 'r' : ''}>{cell(k, r[k])}</td>)}
                </tr>
                {kind === 'tradebook' && open === offset + i && (
                  <tr><td colSpan={cols.length} className="rep-audit">
                    <strong>Execution record.</strong> Fills {String(r.fills)} · cost schedule {String(r.cost_schedule)} ({r.cost_rates_verified ? 'rates verified' : 'rates NOT verified'}) · balance before {inr2(r.balance_before as number)} · available margin before {inr2(r.available_margin_before as number)} ·
                    margin blocked {inr2(r.margin_blocked as number)} (est.) · charges: brokerage {inr2(r.brokerage as number)}, STT {inr2(r.stt as number)}, exchange {inr2(r.exchange as number)}, GST {inr2(r.gst as number)}, SEBI {inr2(r.sebi as number)}, stamp {inr2(r.stamp as number)}
                    {r.intrabar_exit ? ' · exit decided inside a candle (order of events within a minute is unknown)' : ''}{r.flags ? ` · data flags: ${r.flags}` : ''}
                    <br />{String(r.audit || '')}
                  </td></tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
      <div className="rep-pager small">
        <button type="button" className="link" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>Previous</button>
        <span className="muted">{offset + 1}–{last} of {page.total}{kind === 'tradebook' ? ' · click a row for its execution record' : ''}</span>
        <button type="button" className="link" disabled={last >= page.total} onClick={() => setOffset(offset + PAGE)}>Next</button>
      </div>
    </div>
  );
}

function LedgerTab({ rep, lab, rev }: { rep: Report; lab: Lab; rev: string }) {
  const [view, setView] = useState<'ledger' | 'daily'>('ledger');
  return (
    <div className="stack" style={{ ['--gap' as string]: '14px' }}>
      <div className="seg" role="radiogroup" aria-label="Ledger view">
        <label><input type="radio" name="lview" checked={view === 'ledger'} onChange={() => setView('ledger')} /><span>Every fill</span></label>
        <label><input type="radio" name="lview" checked={view === 'daily'} onChange={() => setView('daily')} /><span>Daily</span></label>
      </div>
      <Rowsets lab={lab} kind={view} rev={rev} />
      <h3 className="rep-h">Reconciliation</h3>
      <table className="ptable rep"><tbody>
        {rep.reconciliation.checks.map((c) => <tr key={c.name}><th scope="row">{c.name}</th><td className="num">{c.ok ? 'OK' : 'FAIL'}</td><td className="rep-note">{c.a} vs {c.b}</td></tr>)}
      </tbody></table>
      <CostTable rep={rep} />
      <h3 className="rep-h">Reproducibility</h3>
      <Rows rows={[
        ['Run hash', rep.generated.run_hash ?? '—', 'same strategy settings + account settings + data + cost table → same hash and identical results'],
        ['Data fingerprint', rep.generated.data_fingerprint ?? '—'], ['Strategy settings hash', rep.generated.engine_config_hash ?? '—'], ['Account settings hash', rep.generated.account_hash], ['Cost table version', rep.generated.cost_table_version],
      ]} />
    </div>
  );
}

export function ReportPanel({ r, lab }: { r: RunResult; lab: Lab }) {
  const [tab, setTab] = useState<Tab>('summary');
  const [err, setErr] = useState<string | null>(null);
  const acc = r.account;
  const rev = acc ? `${acc.report.generated.run_hash}` : '';
  const exportCsv = lab.exportCsv;
  const exp = useCallback(async (kind: ExportKind, file: string) => {
    setErr(null);
    const csv = await exportCsv(kind);
    if (csv == null) { setErr('Nothing to export for this run.'); return; }
    downloadText(file, csv);
  }, [exportCsv]);
  if (!acc) {
    return (
      <div className="sheet sheet-pad stack" {...hard}>
        <h2 className="h3">Account report</h2>
        <p className="muted small">The four-leg stock strategy keeps its own margin model on synthetic daily data. The ledger, margin accounting and CSV exports cover the two intraday NIFTY strategies only.</p>
      </div>
    );
  }
  const rep = acc.report;
  const stamp = `${r.strategy}-${rep.range.from ?? 'x'}_${rep.range.to ?? 'x'}-${(rep.generated.run_hash ?? '').slice(0, 6)}`;
  return (
    <div className="sheet rep-sheet" {...hard}>
      <div className="chart-sheet-head">
        <span className="label">Account report · every figure reconciles to the tradebook and ledger</span>
        <span className="status" data-state={rep.reconciliation.ok ? 'done' : 'error'}><i />{rep.reconciliation.ok ? 'Reconciled' : 'Does not reconcile'}</span>
      </div>
      <div className="rep-body stack" style={{ ['--gap' as string]: '14px' }}>
        <Warnings rep={rep} />
        <div className="tabs" role="tablist" aria-label="Report sections">
          {TABS.map(([k, label]) => <button key={k} type="button" role="tab" aria-selected={tab === k} className="tab tab--sm" onClick={() => setTab(k)}>{label}</button>)}
        </div>
        <div role="tabpanel">
          {tab === 'summary' && <Summary rep={rep} />}
          {tab === 'capital' && <Capital rep={rep} />}
          {tab === 'performance' && <Performance rep={rep} />}
          {tab === 'risk' && <Risk rep={rep} />}
          {tab === 'trades' && <Rowsets lab={lab} kind="tradebook" rev={rev} />}
          {tab === 'ledger' && <LedgerTab rep={rep} lab={lab} rev={rev} />}
        </div>
        <div className="rep-export">
          <span className="label">Export CSV</span>
          <button type="button" className="link" onClick={() => exp('tradebook', `tradebook-${stamp}.csv`)}>Tradebook</button>
          <button type="button" className="link" onClick={() => exp('ledger', `ledger-${stamp}.csv`)}>Ledger (every fill)</button>
          <button type="button" className="link" onClick={() => exp('daily', `daily-ledger-${stamp}.csv`)}>Daily ledger</button>
          <button type="button" className="link" onClick={() => exp('performance', `performance-${stamp}.csv`)}>Performance report</button>
          {err && <span className="error small" role="alert">{err}</span>}
        </div>
      </div>
    </div>
  );
}
