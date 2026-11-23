'use client';
/**
 * The Compare tab: up to four pinned runs beside the one on screen, on the same data only (the same sessions, so
 * their curves share dates and their figures are comparable). Each figure is the run's own headline figure.
 */
import { inr, shortDate, tone } from '@/lib/format';
import type { LabSlug, Params } from '@/lib/types';
import { LinePlot } from './Plot';

export const MAX_PINS = 4;
/** A run kept for comparison: what it was, the data it ran on, and its headline figures and curve. */
export interface Pin {
  key: string; slug: LabSlug; label: string; detail: string;
  dataKey: string; dataLabel: string;
  m: Record<string, number | null>;
  curve: { d: string; v: number }[];
  params: Params; hash: string | null;
}

const signed = (v: number | null, d = 2) => (v == null ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(d)}%`);
const ROWS: { k: string; label: string; fmt: (v: number | null) => string; tone?: boolean }[] = [
  { k: 'net', label: 'Net P&L', fmt: (v) => (v == null ? '—' : inr(v, { sign: true })), tone: true },
  { k: 'pct_initial', label: 'Net return', fmt: (v) => signed(v), tone: true },
  { k: 'cagr', label: 'CAGR', fmt: (v) => signed(v), tone: true },
  { k: 'trades', label: 'Trades or positions', fmt: (v) => (v == null ? '—' : String(v)) },
  { k: 'win_rate', label: 'Win rate', fmt: (v) => (v == null ? '—' : `${v.toFixed(1)}%`) },
  { k: 'pf', label: 'Profit factor', fmt: (v) => (v == null ? '—' : v.toFixed(2)) },
  { k: 'max_dd', label: 'Max drawdown', fmt: (v) => (v == null ? '—' : v > 0 ? `−${inr(v)}` : '₹0') },
  { k: 'sharpe', label: 'Sharpe', fmt: (v) => (v == null ? '—' : v.toFixed(2)) },
  { k: 'sortino', label: 'Sortino', fmt: (v) => (v == null ? '—' : v.toFixed(2)) },
  { k: 'rpm', label: 'Return on peak margin (est.)', fmt: (v) => signed(v), tone: true },
];

export function ComparePanel({ current, pins, onRemove, onLoad }: {
  current: Pin | null; pins: Pin[]; onRemove: (key: string) => void; onLoad: (p: Pin) => void;
}) {
  const same = current ? pins.filter((p) => p.dataKey === current.dataKey) : pins;
  const other = current ? pins.filter((p) => p.dataKey !== current.dataKey) : [];
  const runs = current ? [current, ...same.filter((p) => p.key !== current.key)] : same;
  const pinned = (k: string) => pins.some((p) => p.key === k);
  // same data, so the same sessions: the curves share their dates
  const lines = runs.slice(0, MAX_PINS + 1);
  return (
    <div className="panel" role="tabpanel" id="panel-compare" aria-labelledby="tab-compare">
      <section className="blk" aria-labelledby="cmp-h">
        <div className="blk-h"><h2 id="cmp-h">Compare {runs.length} run{runs.length === 1 ? '' : 's'}</h2><span className="sec-note">{current?.dataLabel}</span></div>
        <p className="chart-cap">Runs on the same data, side by side: the one on screen first, then the pinned ones. Each column is that run’s own result; nothing is re-run. Pin up to {MAX_PINS} runs with “Pin to compare” above the results.</p>
        {runs.length < 2 ? <div className="plot-empty">Pin this run, change a setting, run again and pin that too: the runs appear here side by side.</div> : (
          <>
            <LinePlot points={lines[0].curve} firstLabel={lines[0].label} extra={lines.slice(1).map((p) => ({ points: p.curve, label: p.label }))} area="none"
              fmt={(v) => inr(v, { sign: true })} label={`Cumulative net P&L of ${lines.map((p) => p.label).join(', ')}.`} />
            <ul className="legend-row" aria-label="Lines">
              {lines.map((p, i) => <li key={p.key}><span className="pl-k" data-k={i} /> {p.label}</li>)}
            </ul>
          </>
        )}
        {runs.length > 0 && (
          <div className="tscroll">
            <table className="tbl cmp-tbl">
              <thead>
                <tr><th />{runs.map((p, i) => (
                  <th key={p.key} className="r">
                    <span className="cmp-name"><span className="pl-k" data-k={i} />{p.label}</span>
                    <span className="cmp-sub">{i === 0 && current ? 'on screen' : 'pinned'}{p.hash ? ` · run ${p.hash.slice(0, 8)}` : ''}</span>
                  </th>
                ))}</tr>
              </thead>
              <tbody>
                <tr><td className="t">Settings</td>{runs.map((p) => <td key={p.key} className="t cmp-detail">{p.detail}</td>)}</tr>
                {ROWS.map((row) => (
                  <tr key={row.k}><td className="t">{row.label}</td>{runs.map((p) => { const v = p.m[row.k] ?? null; return <td key={p.key} className={`r ${row.tone && v != null ? tone(v) : ''}`}>{row.fmt(v)}</td>; })}</tr>
                ))}
                <tr><td />{runs.map((p, i) => (
                  <td key={p.key} className="r">
                    <div className="run-actions cmp-acts">
                      {!(i === 0 && current) && <button type="button" className="qlink" onClick={() => onLoad(p)}>Load settings</button>}
                      {pinned(p.key) && <button type="button" className="qlink" onClick={() => onRemove(p.key)}>Unpin</button>}
                    </div>
                  </td>
                ))}</tr>
              </tbody>
            </table>
          </div>
        )}
        {other.length > 0 && (
          <div className="stale" role="status">
            <span>{other.length} pinned run{other.length === 1 ? '' : 's'} used other data and {other.length === 1 ? 'is' : 'are'} not compared here: {other.map((p) => `${p.label} (${p.dataLabel})`).join('; ')}.</span>
            {other.map((p) => <button key={p.key} type="button" className="qlink" onClick={() => onRemove(p.key)}>Unpin {p.label}</button>)}
          </div>
        )}
      </section>
    </div>
  );
}

/** "1 Apr 2026 – 30 Jul 2026 · 82 sessions" or "Synthetic · 120 sessions · seed 1" */
export function dataLabelOf(r: { data?: { from: string; to: string; days: number } | null; sessions: number }, seed?: unknown): string {
  return r.data ? `Real NIFTY · ${shortDate(r.data.from)} – ${shortDate(r.data.to)} · ${r.data.days} sessions` : `Synthetic · ${r.sessions} sessions${seed != null ? ` · seed ${seed}` : ''}`;
}
