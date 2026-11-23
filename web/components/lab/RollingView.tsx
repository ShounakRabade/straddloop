'use client';
/**
 * Rolling-window results: the same rules over successive windows of the selected period. Each window is its own
 * backtest started flat with the full capital, so windows are compared, never added up. The figures come from
 * analytics.runRolling in the worker; nothing here is estimated.
 */
import { inr, shortDate, tone } from '@/lib/format';
import type { RollingResult, RollingRow } from '@/lib/types';
import { BarPlot } from './Plot';

export type RollingState =
  | { status: 'off' }
  | { status: 'empty'; why: string }
  | { status: 'waiting' }
  | { status: 'running'; done: number; total: number; label?: string }
  | { status: 'done'; result: RollingResult; stale: boolean; w: number; s: number }
  | { status: 'error'; error: string };

const money = (v: number | null) => (v == null ? '—' : inr(v, { sign: true }));
const num2 = (v: number | null) => (v == null ? '—' : v.toFixed(2));
const pct1 = (v: number | null) => (v == null ? '—' : `${v.toFixed(1)}%`);

function csvOf(rows: RollingRow[]): string {
  const head = ['window', 'from', 'to', 'sessions', 'traded_days', 'net', 'win_rate_pct', 'max_drawdown', 'sharpe', 'profit_factor', 'best_day', 'worst_day'];
  const cell = (v: unknown) => (v == null ? '' : String(v));
  return [head.join(','), ...rows.map((r, i) => [i + 1, r.from, r.to, r.sessions, r.traded, r.net, r.win_rate, r.max_dd, r.sharpe, r.pf, r.best, r.worst].map(cell).join(','))].join('\n');
}

export function RollingView({ state, onCancel, onRetry, onOpen, stamp }: {
  state: RollingState; onCancel: () => void; onRetry: () => void; onOpen: (w: { from: string; to: string }) => void; stamp: string;
}) {
  if (state.status === 'off') return null;
  if (state.status === 'empty') return <div className="plot-empty">{state.why}</div>;
  if (state.status === 'waiting') return <div className="plot-empty">Rolling windows run once the backtest of the whole period has finished.</div>;
  if (state.status === 'error') return <div className="plot-empty"><span className="sec-err">Rolling windows stopped: {state.error}.</span> <button type="button" className="qlink" onClick={onRetry}>Run the windows again</button></div>;
  if (state.status === 'running') {
    return (
      <div className="blk" aria-live="polite">
        <div className="blk-h"><h2>Rolling windows</h2><button type="button" className="qbtn" onClick={onCancel}>Cancel</button></div>
        <p className="sec-note">Window {Math.min(state.done + 1, state.total)} of {state.total}{state.label ? ` · ${state.label.split(' to ').map(shortDate).join(' – ')}` : ''}</p>
        <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={state.total} aria-valuenow={state.done}><i style={{ width: `${(100 * state.done) / Math.max(1, state.total)}%` }} /></div>
      </div>
    );
  }
  const { result, stale, w, s } = state, sm = result.summary, rows = result.rows;
  const download = () => {
    const url = URL.createObjectURL(new Blob([csvOf(rows)], { type: 'text/csv' }));
    const a = document.createElement('a'); a.href = url; a.download = `rolling-${w}d-every-${s}d-${stamp}.csv`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <div className="blk">
      <div className="blk-h">
        <h2>Rolling windows · {w} days, every {s} days</h2>
        <button type="button" className="qbtn" onClick={download}>Export CSV</button>
      </div>
      {stale && <div className="stale" role="status"><span>These windows are from earlier settings. Run again to update them.</span></div>}
      <p className="chart-cap">Each window is its own backtest, started flat with the full capital: compare the windows with each other; do not add them up. A rule that only works in one stretch of history shows here as a few large windows and many small or negative ones.</p>
      <div className="figs">
        <div className="m"><span className="lbl">Windows</span><span className="m-v">{sm.windows}</span><span className="m-s">{sm.with_trades} with trades</span></div>
        <div className="m"><span className="lbl">Positive</span><span className="m-v">{sm.with_trades ? `${sm.positive} of ${sm.with_trades}` : '—'}</span><span className="m-s">{sm.with_trades ? `${Math.round((100 * sm.positive) / sm.with_trades)}% of windows with trades` : 'no window traded'}</span></div>
        <div className="m"><span className="lbl">Median window</span><span className={`m-v ${tone(sm.median ?? 0)}`}>{money(sm.median)}</span><span className="m-s">half the windows did better</span></div>
        <div className="m"><span className="lbl">Best / worst</span><span className="m-v">{money(sm.best)}</span><span className="m-s">worst {money(sm.worst)}</span></div>
        <div className="m"><span className="lbl">Spread</span><span className="m-v">{sm.sd != null ? inr(sm.sd) : '—'}</span><span className="m-s">standard deviation of window nets</span></div>
      </div>
      <BarPlot bars={rows.map((r) => ({ k: r.from, v: r.net ?? 0 }))} fmt={(v) => inr(v, { sign: true })} keyFmt={(k) => shortDate(k)} label="Net P&L of each window, by its first day." />
      <div className="tscroll">
        <table className="tbl">
          <thead><tr><th>#</th><th>Window</th><th className="r">Sessions</th><th className="r">Traded</th><th className="r">Net</th><th className="r">Win rate</th><th className="r">Max DD</th><th className="r">Sharpe</th><th className="r">PF</th><th aria-label="Open" /></tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.from}>
                <td>{i + 1}</td><td>{shortDate(r.from)} – {shortDate(r.to)}</td><td className="r">{r.sessions}</td><td className="r">{r.traded}</td>
                <td className={`r ${tone(r.net ?? 0)}`}>{money(r.net)}</td><td className="r">{pct1(r.win_rate)}</td><td className="r">{r.max_dd != null ? money(r.max_dd) : '—'}</td>
                <td className="r">{num2(r.sharpe)}</td><td className="r">{num2(r.pf)}</td>
                <td><button type="button" className="qlink" onClick={() => onOpen({ from: r.from, to: r.to })}>Open</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
